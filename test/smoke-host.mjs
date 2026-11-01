/**
 * Host-half smoke test: mounts `lib/index.js` on a mock Cordis context with a
 * fake account service and a throwaway DSH_HOME, then drives the ledger,
 * the environment read, the persisted state and the model-facing tool.
 *
 * Run: node test/smoke-host.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('../lib/index.js')

let failures = 0
function assert(condition, message) {
  if (condition) return
  failures += 1
  console.error('FAIL: ' + message)
}

function equal(actual, expected, message) {
  assert(actual === expected, message + ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')')
}

/** The throwaway home every storage assertion is measured against. */
const home = await mkdtemp(join(tmpdir(), 'dsh-home-'))
process.env.DSH_HOME = home
// The ambient shell may carry proxies of its own; the assertions below measure
// exactly the keys this test sets, so clear every spelling first.
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FTP_PROXY', 'SOCKS_PROXY',
  'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'NPM_CONFIG_NOPROXY',
  'GIT_PROXY_COMMAND', 'DOCKER_HTTP_PROXY']) {
  delete process.env[key]
  delete process.env[key.toLowerCase()]
}
process.env.HTTP_PROXY = 'http://user:pass@127.0.0.1:7890'
process.env.NO_PROXY = 'localhost,127.0.0.1'
process.env.NODE_EXTRA_CA_CERTS = 'C:\\certs\\corp.pem'

/** A mutable fake of the `deepseekAccount` service. */
const account = {
  balance: '47.93',
  status: 'ready',
  /** When set, overrides the wallet list verbatim (for Platform formatting cases). */
  wallets: null,
  async getState() { return { status: account.status, links: { platform: 'https://platform.deepseek.com' } } },
  async getBalance() {
    if (account.status !== 'ready') return null
    return {
      status: 'ready',
      value: account.wallets || [{ currency: 'CNY', balance: account.balance }],
      bonusWallets: [{ currency: 'CNY', balance: '1.00' }],
    }
  },
}

const tools = []
const provided = {}
const injections = []
const effects = []
/** A fake `timer` service that records what apply asked to run later. */
const timers = []
const timer = {
  timeout(callback, delay) {
    const entry = { kind: 'timeout', callback: callback, delay: delay, disposed: false }
    timers.push(entry)
    return () => { entry.disposed = true }
  },
  interval(callback, delay) {
    const entry = { kind: 'interval', callback: callback, delay: delay, disposed: false }
    timers.push(entry)
    return () => { entry.disposed = true }
  },
}
const ctx = {
  get(key) {
    if (key === 'tools') return { register: (tool) => { tools.push(tool) } }
    if (key === 'deepseekAccount') return account
    if (key === 'timer') return timer
    return undefined
  },
  provide(key, value) { provided[key] = value; return () => { delete provided[key] } },
  inject(deps, callback) {
    injections.push(deps)
    callback({ typert: { register: (contribution) => { provided.typertContribution = contribution; return () => {} } } })
    return () => {}
  },
  effect(callback, label) {
    effects.push({ label: label, cleanup: callback() })
    return () => {}
  },
}

// --------------------------------------------------------------- manifest

equal(mod.name, 'dsh-homepage', 'exported name')
assert(Array.isArray(mod.inject) && mod.inject.includes('tools'), 'inject declares tools')
equal(typeof mod.apply, 'function', 'apply is a function')
equal(typeof mod.default.apply, 'function', 'default export carries apply')

// The model-facing tool is opt-in. The schema ships in the package so the
// Plugins settings page can render the switch; its default must be OFF, or a
// fresh install would put a machine-reading tool in every model's context.
assert(mod.Config !== undefined && typeof mod.Config === 'function', 'the plugin exports a config schema')
const defaultConfig = mod.Config({})
equal(defaultConfig.exposeTool.get(), false, 'exposeTool defaults to off')
equal(defaultConfig.toolLanguage.get(), 'auto', 'toolLanguage defaults to auto')
equal(mod.default.Config, mod.Config, 'default export carries the same config schema')

// ------------------------------------------------------------------ mount

// The rest of this suite exercises the tool itself, so it mounts with the
// switch on and the language pinned to Chinese; the English path is asserted
// below by flipping the option between calls.
const config = { exposeTool: true, toolLanguage: 'zh' }

// A mount without config must register nothing: the opt-in switch is the whole
// point, and a tool registered by accident would sit in every model's context.
{
  const bareTools = []
  const bareCtx = {
    get(key) {
      if (key === 'tools') return { register: (tool) => { bareTools.push(tool); return () => {} } }
      if (key === 'timer') return { timeout: () => () => {}, interval: () => () => {} }
      return undefined
    },
    provide() { return () => {} },
    inject() { return () => {} },
    effect(callback) { callback(); return () => {} },
    on() {},
  }
  mod.apply(bareCtx)
  assert(!bareTools.some((entry) => entry.name === 'homepage'),
    'a default mount registers no model-facing homepage tool')
  equal(bareTools.length, 1, 'the audit verdict tool is still registered unconditionally')
}

mod.apply(ctx, config)

// The host half observes the balance shortly after start and then on a slow
// interval, so the ledger is populated — and a day nobody looks at still gets a
// curve — before any browser opens the panel. Both go through the timer service,
// so they are disposed with the plugin fiber. The device sampler keeps its own,
// cheaper interval warm for the same reason: the chart has a window of samples
// the moment somebody opens the card.
const boot = effects.find((entry) => entry.label === 'dsh-homepage: balance sampling')
assert(boot, 'apply schedules balance sampling')
assert(typeof boot.cleanup === 'function', 'balance sampling is disposable')
const deviceTick = effects.find((entry) => entry.label === 'dsh-homepage: device sampling')
assert(deviceTick, 'apply schedules device sampling')
assert(typeof deviceTick.cleanup === 'function', 'device sampling is disposable')
equal(timers.length, 3, 'both samplers use the timer service')
equal(timers[0].kind, 'timeout', 'the first observation is a one-shot')
equal(timers[0].delay, 4000, 'the start-up observation waits for the account service to mount')
equal(timers[1].kind, 'interval', 'later observations repeat')
equal(timers[1].delay, 1800000, 'the background cadence is thirty minutes')
equal(timers[2].kind, 'interval', 'the device sampler repeats')
equal(timers[2].delay, 15000, 'the device cadence is fifteen seconds')
timers[0].callback()
await new Promise((resolve) => setTimeout(resolve, 120))
assert(existsSync(join(home, 'storages', 'dsh-homepage', 'balance-ledger.json')),
  'the start-up observation performs a real read and writes the ledger')
boot.cleanup()
deviceTick.cleanup()
assert(timers[0].disposed && timers[1].disposed && timers[2].disposed,
  'both sampling timers are disposed with the plugin fiber')

const api = provided.homepage
assert(api && typeof api === 'object', 'the host provides the homepage service')
for (const method of ['overview', 'refresh', 'environment', 'state', 'saveState', 'device', 'projects', 'hygiene', 'toolUsage', 'dsh', 'dshCheck', 'dshLocal', 'dshInstall', 'sidebarLayout', 'saveSidebarLayout']) {
  equal(typeof api[method], 'function', 'homepage.' + method + ' exists')
}

// The sidebar layout is display state of its own: one document on its own file,
// written whole, and readable before anything was ever written.
const freshLayout = await api.sidebarLayout()
equal(freshLayout.layout.groups.length, 0, 'a fresh install starts with no groups')
equal(freshLayout.at, 0, 'a document that was never written reports no time')
const savedLayout = await api.saveSidebarLayout({
  groups: [{ id: 'g1', title: '插件', color: '#4f46e5', order: 0 }],
  members: { workspaceA: { group: 'g1' } },
})
equal(savedLayout.layout.groups.length, 1, 'the document that was written comes back')
equal(savedLayout.layout.groups[0].title, '插件', 'the group keeps its title')
equal(savedLayout.layout.members.workspaceA.group, 'g1', 'the assignment survives the round trip')
assert(savedLayout.at > 0, 'the store stamps the write')
const rereadLayout = await api.sidebarLayout()
equal(rereadLayout.layout.members.workspaceA.group, 'g1', 'the document is read back off its file')
assert(
  existsSync(join(home, 'storages', 'dsh-homepage', 'sidebar-layout.json')),
  'the layout is its own file, not a section of the home state',
)
assert(Object.isFrozen(api.typertRemote), 'typertRemote binding is frozen')
equal(api.typertRemote.namespace, 'homepage', 'typertRemote namespace')
assert(injections.some((deps) => deps.includes('typert')), 'the typert service is requested')

const contribution = provided.typertContribution
assert(contribution && Array.isArray(contribution.invocations), 'a typert contribution was registered')
equal(contribution.package, 'dsh-homepage', 'contribution package')
equal(contribution.face, 'host', 'contribution face')
equal(contribution.invocations.length, 28, 'twenty-eight remote invocations')
const methods = contribution.invocations.map((entry) => entry.method).sort().join(',')
equal(methods, 'act,collect,device,dsh,dshCheck,dshInstall,dshLocal,environment,hygiene,overview,pluginAuditDecide,pluginAuditList,pluginAuditStart,pluginAuditStatus,projects,refresh,saveSidebarLayout,saveState,sidebarLayout,skillContent,skillDetail,skillInstall,skillList,skillSearch,skillSetEnabled,skillSources,state,toolUsage', 'invocation methods')
for (const entry of contribution.invocations) {
  equal(typeof api[entry.method], 'function', 'the declared endpoint has a callable service method: ' + entry.method)
  equal(entry.namespace, 'homepage', 'invocation namespace for ' + entry.method)
  equal(entry.invocation.kind, 'direct', 'invocation kind for ' + entry.method)
  equal(entry.result.mode, 'src-json', 'invocation result codec for ' + entry.method)
  for (const parameter of entry.parameters) {
    equal(parameter.source, 'json', 'parameter source for ' + entry.method)
    equal(parameter.codec.mode, 'src-json', 'parameter codec for ' + entry.method)
  }
}
const overviewCall = contribution.invocations.find((entry) => entry.method === 'overview')
equal(overviewCall.id, 'dsh-homepage#homepage/overview', 'invocation id shape')
equal(overviewCall.parameters[0].name, 'options', 'overview takes options')

// ------------------------------------------------------------------- tool

equal(tools.length, 2, 'the plugin registers its two remaining core tools')
const tool = tools.find((entry) => entry.name === 'homepage') || {}
equal(tool.name, 'homepage', 'tool name')
assert(typeof tool.description === 'string' && tool.description.length > 40, 'tool has a description')
equal(tool.parameters.properties.section.enum.join(','), 'overview,environment,device,dsh,skills,projects,hygiene,runtime,all', 'tool section enum')
equal(tool.output.schema.required.join(','), 'text,spend,currency,proxyCount,device,dsh,skills,projects,hygiene,runtime', 'tool output schema required keys')
equal(typeof tool.output.render, 'function', 'tool output declares a renderer')

// The audit card's verdict channel: a second tool, because a review session
// reports what it found by calling a tool rather than by ending its turn with
// prose the host would have to read back.
const verdictTool = tools.find((entry) => entry.name === 'report_plugin_audit') || {}
equal(verdictTool.name, 'report_plugin_audit', 'the audit verdict tool is registered')
assert(typeof verdictTool.description === 'string' && verdictTool.description.length > 40, 'the verdict tool has a description')
equal(verdictTool.parameters.required.join(','), 'auditId,verdict,summary', 'the verdict needs an audit id, a verdict and a summary')
equal(verdictTool.parameters.properties.verdict.enum.join(','), 'safe,warn,unsafe', 'the verdict is one of three')
equal(verdictTool.parameters.properties.auditId.type, 'string', 'the audit id is a string')
equal(verdictTool.output.schema.required.join(','), 'text,verdict', 'the verdict tool answers with what it recorded')
assert(typeof verdictTool.execute === 'function', 'the verdict tool can be called')

// ------------------------------------------------------------ environment

const env = await api.environment()
equal(env.platform, process.platform, 'environment platform')
equal(env.dshHome, home, 'environment reports the configured DSH_HOME')
assert(env.storage.startsWith(home), 'environment storage lives under DSH_HOME')
assert(env.node.startsWith('v'), 'environment reports the node version')
const httpProxy = env.proxies.find((entry) => entry.name === 'HTTP_PROXY')
assert(httpProxy !== undefined, 'HTTP_PROXY is reported')
equal(httpProxy.masked, 'http://***@127.0.0.1:7890', 'proxy credentials are masked')
equal(httpProxy.raw, 'http://user:pass@127.0.0.1:7890', 'the raw proxy value is preserved')
equal(httpProxy.host, '127.0.0.1', 'proxy host is parsed')
equal(httpProxy.port, 7890, 'proxy port is parsed')
equal(httpProxy.protocol, 'http', 'proxy protocol is parsed')
equal(httpProxy.hasAuth, true, 'proxy auth is detected')
equal(httpProxy.kind, 'proxy', 'a proxy key is kind=proxy')
const noProxy = env.proxies.find((entry) => entry.name === 'NO_PROXY')
assert(noProxy !== undefined && noProxy.kind === 'bypass', 'NO_PROXY is reported as a bypass entry')
equal(env.proxyCount, 1, 'only HTTP_PROXY counts as a proxy')
equal(env.tls.length, 1, 'one TLS override is reported')
equal(env.tls[0].name, 'NODE_EXTRA_CA_CERTS', 'TLS override name')

// ------------------------------------------------------------------ device

// The sampler reads this machine for real, so the shape and the invariants are
// asserted here and the exact numbers are not.
const device = await api.device()
assert(device.at > 0, 'the device sample is stamped')
assert(device.cpu.usage >= 0 && device.cpu.usage <= 1, 'cpu usage is a ratio')
assert(device.cpu.cores.length >= 1, 'at least one core is reported')
assert(device.cpu.cores.every((value) => value >= 0 && value <= 1), 'every core is a ratio')
equal(device.cpu.count, device.cpu.cores.length, 'the core count matches the per-core readings')
assert(device.memory.total > 0, 'total memory is known')
assert(device.memory.used <= device.memory.total, 'used memory cannot exceed the total')
assert(device.memory.usage >= 0 && device.memory.usage <= 1, 'memory usage is a ratio')
equal(device.system.platform, process.platform, 'the sample reports this platform')
assert(device.system.hostname.length > 0, 'the sample names the machine')
assert(device.history.length >= 1, 'the ring buffer carries the sample it just took')
equal(device.history[device.history.length - 1].at, device.at, 'the newest history entry is this sample')
assert(device.cpu.loadavg === null || device.cpu.loadavg.length === 3,
  'load average is either absent or the three-load triple')
// A sensor can be missing and a volume can be unreadable: both degrade to a
// reason instead of a figure, and both must still leave a complete document.
if (device.temperature.celsius === null) {
  assert(typeof device.temperature.reason === 'string', 'a missing temperature explains itself')
} else {
  assert(device.temperature.celsius > -50 && device.temperature.celsius < 200, 'the temperature is plausible')
  assert(typeof device.temperature.source === 'string', 'a temperature names where it came from')
}
if (device.disk) {
  assert(device.disk.total >= 0, 'a volume reports its size or a reason')
}
// The GPU block is the reading a machine may genuinely not have, so its
// invariants are asserted and its figures are not: a box without a counter
// reports a reason, and one with a counter reports ratios like every other
// reading. Video memory is allowed to be unknown while the load still reads.
// An adapter that is named but publishes no counter — macOS, Intel — is an
// answer with a hole in it, not a missing source, so it may carry no reason.
assert(device.gpu && typeof device.gpu === 'object', 'the sample carries a GPU block')
if (device.gpu.usage === null) {
  assert(typeof device.gpu.reason === 'string' || device.gpu.name !== '',
    'a missing GPU reading explains itself or names the card it could not read')
} else {
  assert(device.gpu.usage >= 0 && device.gpu.usage <= 1, 'gpu usage is a ratio')
}
if (device.gpu.memory && device.gpu.memory.usage !== null) {
  assert(device.gpu.memory.usage >= 0 && device.gpu.memory.usage <= 1, 'video memory usage is a ratio')
  assert(device.gpu.memory.used <= device.gpu.memory.total, 'used video memory cannot exceed the total')
}

// --------------------------------------------------------------- tool usage

// This context mounts no session store, and that has to be a reading rather
// than a throw: the fold answers with a full-shape document and a reason the
// card can print, not an empty list that would read as "no calls, ever".
const toolUsage = await api.toolUsage()
assert(toolUsage !== null && typeof toolUsage === 'object', 'tool usage answers with a document')
equal(toolUsage.available, false, 'an unmounted session store is reported, not hidden')
assert(typeof toolUsage.reason === 'string' && toolUsage.reason !== '', 'the document explains why it has no numbers')
assert(Array.isArray(toolUsage.tools) && Array.isArray(toolUsage.projects), 'the document keeps its lists')
equal(toolUsage.totals.calls, 0, 'the totals start empty')
assert(toolUsage.window !== null && typeof toolUsage.window === 'object', 'the document carries its window')
// The card reads the same endpoint through the collector, so the two must be
// one item: a named collect has to reach it too.
const toolUsageCollected = await api.collect({ names: ['toolUsage'] })
assert(toolUsageCollected.entries.toolUsage !== undefined, 'the collector exposes the tool-usage item')
equal(toolUsageCollected.entries.toolUsage.value.available, false, 'the collector item carries the same document')

// The skill library is machine state a model has no other way to read: the
// session catalog lists what it may invoke, not what is installed, and says
// nothing about a skill that is switched off or unreadable. The section answers
// with a sentence even when the read fails — an empty string would read as "no
// skills installed", which is a different claim.
const skillsOnly = await tool.execute({ section: 'skills' })
assert(skillsOnly.skills.startsWith('技能库：'), 'the tool renders the skill section, got: ' + skillsOnly.skills)
assert(skillsOnly.skills.indexOf('undefined') < 0, 'the skill rendering must not leak undefined')
assert(skillsOnly.skills.indexOf('共 ') > 0, 'the skill rendering must carry the total')
equal(skillsOnly.device, '', 'a skill read must leave the other sections empty')
assert(skillsOnly.text.indexOf('技能库：') === 0, 'the joined text must lead with the section that was asked for')

// The same read in English: the option is consulted per call, so the Host has
// no locale of its own to get out of step with.
config.toolLanguage = 'en'
const skillsEnglish = await tool.execute({ section: 'skills' })
assert(skillsEnglish.skills.startsWith('Skills:'), 'the tool honours the configured language, got: ' + skillsEnglish.skills)
assert(skillsEnglish.skills.indexOf('undefined') < 0, 'the English rendering must not leak undefined')
config.toolLanguage = 'zh'

// ---------------------------------------------------------------- dsh
// The release checker has to answer even when it cannot reach GitHub: it never
// rejects and states its route, so these assertions hold offline as well as on.
const dsh = await api.dsh()
assert(dsh.at > 0, 'the release document is stamped')
equal(dsh.repo, 'deepseek-ai/deepseek-harness', 'the document names the repository')
equal(dsh.branch, 'master', 'the document names the default branch')
assert(Array.isArray(dsh.commits), 'the commit list is always an array')
assert(Array.isArray(dsh.releases), 'the release list is always an array')
assert(dsh.head === null || (typeof dsh.head.sha === 'string' && dsh.head.sha.length === 40),
  'a head is either absent or a full sha')
assert(dsh.release === null || typeof dsh.release.tag === 'string', 'a release carries its tag')
assert(dsh.routes && typeof dsh.routes === 'object', 'the document states which route answered')
assert(dsh.reason === null || typeof dsh.reason === 'string', 'a failure states a reason')
assert(dsh.commits.every((entry) => typeof entry.sha === 'string' && entry.sha.length === 40),
  'every commit carries a full sha')
const dshLocal = await api.dshLocal({ root: '.' })
assert(dshLocal && Array.isArray(dshLocal.versions), 'the local listing always answers with versions')
equal(typeof dshLocal.root, 'string', 'the local listing echoes the root it was asked about')

const dshOnly = await tool.execute({ section: 'dsh' })
assert(dshOnly.dsh.indexOf('DSH 核心：') === 0, 'the tool renders the dsh section, got: ' + dshOnly.dsh)
assert(dshOnly.dsh.indexOf('undefined') < 0, 'the rendering must not leak undefined')
equal(dshOnly.device, '', 'a section read must leave the other sections empty')
equal(dshOnly.spend, '0.00', 'a section read must not touch the ledger')

// ---------------------------------------------------------------- ledger

const first = await api.overview({ historyDays: 14 })
equal(first.wallets.length, 1, 'one wallet in the overview')
equal(first.wallets[0].balance, '47.93', 'wallet balance')
equal(first.wallets[0].currency, 'CNY', 'wallet currency')
equal(first.bonusWallets[0].balance, '1.00', 'the bonus wallet is reported separately')
equal(first.today.spend, '0.00', 'the first sample has no spend')
equal(first.today.open, '47.93', 'the first sample opens at the balance')
assert(first.storage.startsWith(home), 'overview reports the ledger path')
equal(first.error, null, 'a successful read reports no error')
assert(existsSync(join(home, 'storages', 'dsh-homepage', 'balance-ledger.json')), 'the ledger file was written')

// The Platform states balances as floats: an empty dollar wallet arrives as
// `0E-16` and a funded one carries full precision. Both must reach a card
// rounded, with the exact statement kept alongside for a detail view.
account.wallets = [
  { currency: 'USD', balance: '0E-16' },
  { currency: 'CNY', balance: '45.7165996400000000' },
]
const formatted = await api.refresh()
equal(formatted.wallets[0].balance, '0.00', 'a scientific-notation zero renders as 0.00')
equal(formatted.wallets[0].raw, '0E-16', 'the exact statement is kept beside the rounded value')
equal(formatted.wallets[1].balance, '45.72', 'a full-precision balance renders at two decimals')
equal(formatted.wallets[1].units, 45716600, 'the rounded value still carries micro-units')
const formattedText = (await tool.execute({ section: 'overview' })).text
assert(formattedText.includes('CNY 45.72'), 'the rendered tool text uses the rounded amount')
assert(!formattedText.includes('0E-16'), 'the rendered tool text never shows scientific notation')
account.wallets = null

account.balance = '40.00'
const second = await api.refresh()
equal(second.today.spend, '7.93', 'spend is the drop from the opening balance')
equal(second.today.open, '47.93', 'the opening balance is carried for the day')
equal(second.today.last, '40.00', 'the latest balance is recorded')
equal(second.today.currency, 'CNY', 'the primary currency is CNY')
assert(second.history.length >= 1, 'history carries at least today')
equal(second.history[0].day, second.today.day, 'history is newest first')

account.status = 'signed-out'
const signedOut = await api.refresh()
equal(signedOut.error.reason, 'signed-out', 'a signed-out account is reported as such')
equal(signedOut.wallets[0].balance, '40.00', 'the last known balance survives a failed read')
equal(signedOut.today.spend, '7.93', 'a failed read keeps the recorded spend')
account.status = 'ready'

const ledger = JSON.parse(await readFile(join(home, 'storages', 'dsh-homepage', 'balance-ledger.json'), 'utf8'))
equal(ledger.version, 1, 'ledger version')
assert(Object.keys(ledger.days).length >= 1, 'the ledger records days')

// ----------------------------------------------------------------- state

const empty = await api.state()
equal(Array.isArray(empty.order) && empty.order.length, 0, 'the initial state has no order')
// A fresh profile starts from the shipped scheme: the recorded spans and the
// per-card marks are the plugin's defaults, not an empty wall. The scheme ships
// no embedded artwork - the two former image defaults were removed so the
// package carries no third-party pictures.
equal(empty.layout.token.w, 1, 'a fresh profile starts from the recorded default span')
equal(empty.layout.sessions.h, 1, 'the recorded sessions span survives as the default')
equal(Object.keys(empty.appearance).length, 5, 'a fresh profile starts from the shipped appearance')
equal(empty.appearance['tool-usage'].opacity, 5, 'the recorded tool-usage mark keeps its opacity')
equal(empty.appearance.sessions.size, 233, 'the recorded sessions mark keeps its pixel size')
assert(!('dsh' in empty.appearance) && !('token' in empty.appearance),
  'the shipped scheme carries no embedded artwork')
const firstDefault = await api.state()
firstDefault.layout.token.w = 4
equal((await api.state()).layout.token.w, 1, 'the shipped scheme is cloned per read')
const saved = await api.saveState({ order: ['calendar', 'token'], layout: { token: { w: 2, h: 1 } }, settings: { density: 'compact' } })
equal(saved.order.join(','), 'calendar,token', 'saveState returns the merged order')
equal(saved.appearance.sessions.size, 233,
  'a save that does not replace appearance keeps the shipped appearance')
const reread = await api.state()
equal(reread.order.join(','), 'calendar,token', 'the order is persisted')
equal(reread.settings.density, 'compact', 'settings are persisted')
equal(reread.layout.token.w, 2, 'layout is persisted')
assert(reread.updatedAt > 0, 'the state carries an updatedAt stamp')
const cleared = await api.saveState({ order: [], settings: {} })
equal(cleared.order.length, 0, 'a section can be emptied')

// Appearance and visibility are optional v1 sections, replaced whole like layout.
equal(empty.hidden.length, 0, 'old profiles default to no hidden cards')
const image = 'data:image/svg+xml,%3Csvg%20xmlns="http://www.w3.org/2000/svg"/%3E'
const decorated = await api.saveState({
  appearance: {
    token: null,
    calendar: { icon: 'calendar', image, opacity: 5, size: '128%', anchor: 'left', bleed: '-16%', offset: [12, '-2rem'], rotate: '12deg', fit: 'cover', tint: 'red', fade: true, fadePosition: 70, blend: 'luminosity', unknown: true },
    device: 'cpu',
    invalid: false,
  },
  hidden: ['token', 'token', 'calendar', 3, '', '__proto__'],
})
equal(decorated.appearance.token, null, 'null explicitly disables a texture')
equal(decorated.appearance.calendar.image, image, 'SVG image data survives without corrupting quotes')
equal(decorated.appearance.calendar.rotate, 12, 'degree strings normalize to numeric rotation')
equal(decorated.appearance.calendar.offset.join(','), '12,-2rem', 'offset lengths survive')
equal(decorated.appearance.device.icon, 'cpu', 'icon shorthand normalizes to an object')
assert(!('invalid' in decorated.appearance), 'non-texture override is discarded')
equal(decorated.appearance.calendar.tint, 'red', 'registered texture tint survives an appearance edit')
equal(decorated.appearance.calendar.fade, true, 'the gradient fade toggle survives an appearance edit')
equal(decorated.appearance.calendar.fadePosition, 70, 'the fade position survives an appearance edit')
equal(decorated.appearance.calendar.blend, 'luminosity', 'the blend mode survives an appearance edit')
assert(!('unknown' in decorated.appearance.calendar), 'unknown texture fields are dropped')
equal(decorated.hidden.join(','), 'token,calendar', 'hidden ids are safe and unique')
equal(JSON.stringify((await api.state()).appearance), JSON.stringify(decorated.appearance), 'appearance is read back from disk')
const kept = await api.saveState({ controls: { test: true }, appearance: [], hidden: {} })
equal(JSON.stringify(kept.appearance), JSON.stringify(decorated.appearance), 'wrong section types and unrelated patches preserve appearance')
equal(kept.hidden.join(','), 'token,calendar', 'wrong hidden type preserves visibility')
const sanitized = await api.saveState({ appearance: JSON.parse('{"__proto__":{"icon":"cpu"},"constructor":null,"token":{"image":"javascript:alert(1)","icon":"<svg>","size":"calc(100% + 1px)","opacity":999,"rotate":-999,"bleed":9999,"offset":[0,"url(evil)"],"fade":"yes","fadePosition":999,"blend":"overlay"},"http":{"image":"http://localhost/image.png"},"https":{"image":"https://example.com/image.png"},"file":{"image":"file:///secret"},"html":{"image":"data:text/html,evil"},"credentials":{"image":"https://user:pass@example.com/a"},"newline":{"image":"https://example.com/a\\nb"}}') })
equal(sanitized.appearance.token.opacity, 100, 'opacity clamps to a safe bound')
equal(sanitized.appearance.token.rotate, -360, 'rotation clamps to a safe bound')
equal(sanitized.appearance.token.bleed, 2048, 'length clamps to a safe bound')
equal(sanitized.appearance.token.fadePosition, 100, 'fade position clamps to a safe bound')
assert(!('fade' in sanitized.appearance.token), 'a non-boolean fade toggle is dropped')
assert(!('blend' in sanitized.appearance.token), 'an unknown blend mode is dropped')
assert(!('size' in sanitized.appearance.token) && !('offset' in sanitized.appearance.token), 'CSS expressions and invalid offset pairs are dropped')
assert(!('icon' in sanitized.appearance.token) && !('image' in sanitized.appearance.token), 'markup icons and executable URLs are dropped')
assert(!Object.hasOwn(sanitized.appearance, '__proto__') && !Object.hasOwn(sanitized.appearance, 'constructor'), 'prototype keys are excluded')
assert(sanitized.appearance.http.image && sanitized.appearance.https.image, 'HTTP and HTTPS image URLs are supported')
for (const id of ['file', 'html', 'credentials', 'newline']) assert(!('image' in sanitized.appearance[id]), 'unsafe image rejected: ' + id)
assert(!Object.hasOwn(sanitized.appearance, 'calendar'), 'appearance replaces rather than deep-merges')
const compatibleIds = ['my card', '_custom', '中文卡片', '@plugin/card']
const compatible = await api.saveState({ appearance: Object.fromEntries(compatibleIds.map(id => [id, { tint: 'var(--card-color, #abcdef)' }])), hidden: compatibleIds })
equal(compatible.hidden.join(','), compatibleIds.join(','), 'registered Unicode and namespaced card ids retain visibility')
equal(Object.keys((await api.state()).appearance).join(','), compatibleIds.join(','), 'registered ids retain artwork after reload')
const tintRejected = await api.saveState({ appearance: { token: { tint: 'red;display:none' } } })
assert(!('tint' in tintRejected.appearance.token), 'CSS injection is rejected in tints')
const bounded = await api.saveState({
  appearance: Object.fromEntries(Array.from({ length: 140 }, (_, i) => ['card-' + i, i === 0 ? { size: Infinity, opacity: NaN, image: 'data:image/png,' + 'a'.repeat(2 * 1024 * 1024) } : {}])),
  hidden: Array.from({ length: 140 }, (_, i) => 'card-' + i),
})
equal(Object.keys(bounded.appearance).length, 128, 'appearance count is bounded')
equal(bounded.hidden.length, 128, 'hidden count is bounded')
equal(Object.keys(bounded.appearance['card-0']).length, 0, 'nonfinite numbers and oversized images are discarded')
const stateFile = join(home, 'storages', 'dsh-homepage', 'home-state.json')
await writeFile(stateFile, JSON.stringify({ ...bounded, appearance: { token: { image: 'file:///bad', size: '1px;display:none' } }, hidden: ['token', 'token', false] }))
const diskNormalized = await api.state()
equal(Object.keys(diskNormalized.appearance.token).length, 0, 'loaded files use the same appearance validation')
equal(diskNormalized.hidden.join(','), 'token', 'loaded files use the same hidden validation')
const resetAppearance = await api.saveState({ appearance: {}, hidden: [] })
equal(Object.keys(resetAppearance.appearance).length, 0, 'empty map restores all built-in textures')
equal(resetAppearance.hidden.length, 0, 'empty hidden list restores all cards')
equal(resetAppearance.layout.token.w, 2, 'legacy layout survives new section patches')
equal(resetAppearance.version, 1, 'new fields retain state version compatibility')

// ------------------------------------------------------------------ tool

const all = await tool.execute({ section: 'all' })
assert(all.text.includes('余额'), 'the tool renders the balance line')
assert(all.text.includes('今日消费'), 'the tool renders the spend line')
assert(all.text.includes('代理'), 'the tool renders the proxy section')
assert(all.text.includes('127.0.0.1'), 'the tool renders the proxy host')
equal(all.currency, 'CNY', 'the tool reports the currency')
equal(all.proxyCount, 1, 'the tool reports the proxy count')
assert(/^\d+\.\d\d$/.test(all.spend), 'the tool reports a decimal spend string')

const onlyEnv = await tool.execute({ section: 'environment' })
assert(!onlyEnv.text.includes('今日消费'), 'section=environment omits the spend block')
equal(onlyEnv.spend, '0.00', 'section=environment reports a neutral spend')
const onlyOverview = await tool.execute({ section: 'overview' })
assert(onlyOverview.text.includes('今日消费'), 'section=overview carries the spend block')
assert(!onlyOverview.text.includes('代理：'), 'section=overview omits the proxy block')
const onlyDevice = await tool.execute({ section: 'device' })
assert(onlyDevice.text.includes('处理器'), 'section=device renders the processor line')
assert(onlyDevice.text.includes('内存'), 'section=device renders the memory line')
assert(onlyDevice.device.includes('处理器'), 'the tool reports the device document as its own field')
// The adapter is a stable fact about the machine, so this holds even though the
// tool samples the device again for its own call.
if (device.gpu.name) assert(onlyDevice.text.includes('GPU：'), 'section=device renders the adapter line')
assert(!onlyDevice.text.includes('今日消费'), 'section=device omits the spend block')
assert(all.device.includes('采样'), 'section=all carries the device document')
assert(all.text.includes('项目：'), 'section=all carries the project wall')
assert(all.text.includes('存储：'), 'section=all carries the storage inventory')
const onlyProjects = await tool.execute({ section: 'projects' })
assert(onlyProjects.text.includes('项目：'), 'section=projects renders the project section')
assert(typeof onlyProjects.projects === 'string', 'the tool reports the project document as its own field')
assert(!onlyProjects.text.includes('今日消费'), 'section=projects omits the spend block')
const onlyHygiene = await tool.execute({ section: 'hygiene' })
assert(onlyHygiene.text.includes('存储：'), 'section=hygiene renders the storage section')
assert(typeof onlyHygiene.hygiene === 'string', 'the tool reports the hygiene document as its own field')
const rendered = tool.output.render({}, all)
equal(rendered[0].type, 'text', 'the renderer emits a text part')
equal(rendered[0].text, all.text, 'the renderer passes the text through')

// ---------------------------------------------------------------- cleanup

await rm(home, { recursive: true, force: true })

if (failures > 0) {
  console.error('smoke-host: ' + failures + ' assertion(s) failed')
  process.exit(1)
}
console.log('smoke-host: all assertions passed')
