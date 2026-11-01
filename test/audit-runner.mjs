/**
 * audit-runner: the host half's chain, from a typed plugin name to an installed
 * plugin. The engine is injected, so this runs without an agent loop, a plugin
 * manager or the network.
 *
 * What it proves:
 *  1. `start()` resolves the target, opens a review session through `agents`
 *     (absolute cwd, no workspace, so the session lands in 未分组) and hands it a
 *     prompt that names both the audit id and where to read the source.
 *  2. The session's own events move the progress line, and another session's
 *     events do not.
 *  3. The verdict channel is bound to the audit's session: a report from another
 *     session is refused, and one audit cannot report twice.
 *  4. `safe` installs without asking, `warn` waits for the user, `unsafe` refuses
 *     to install, and a declined verdict is a record of its own.
 *  5. An install result is reported as what it is: restart-required is installed,
 *     a failed install keeps DSH's own reason, a cancelled install is declined.
 *  6. A review that ends without a verdict is failed, not silently running.
 *
 * Run: node test/audit-runner.mjs
 */
import { createAuditRunner, describeInstall } from '../lib/host/audit-runner.js'
import { AUDIT_TOOL_NAME } from '../lib/host/audit.js'

let failures = 0
function assert(condition, message) {
  if (condition) return
  failures += 1
  console.error('FAIL: ' + message)
}

function equal(actual, expected, message) {
  assert(actual === expected,
    message + ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')')
}

/** Let the fire-and-forget paths (install, idle watcher) settle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** What the fake npm registry answers, including the install script to flag. */
const PACKUMENT = {
  'dist-tags': { latest: '1.2.3' },
  versions: {
    '1.2.3': {
      name: 'dsh-note',
      version: '1.2.3',
      description: 'notes in the sidebar',
      repository: { type: 'git', url: 'git+https://github.com/example/dsh-note.git' },
      scripts: { postinstall: 'node scripts/setup.js' },
    },
  },
}

/** A package that declares a harness range this runtime is not in. */
const OLD_PACKUMENT = {
  'dist-tags': { latest: '0.9.0' },
  versions: {
    '0.9.0': {
      name: 'dsh-old',
      version: '0.9.0',
      description: 'written against an older harness',
      repository: { type: 'git', url: 'git+https://github.com/example/dsh-old.git' },
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' },
    },
  },
}

/**
 * One fake engine: an `agents` service that remembers what it was asked for,
 * records what the review session said, and can be told when the turn is over.
 * @param options - `{ runtimeVersion }`, the version the compatibility check sees.
 * @returns `{ state, runner }`.
 */
function makeEngine(options = {}) {
  const runtime = options.runtimeVersion === undefined ? '0.2.1-alpha.3' : options.runtimeVersion
  const state = { created: [], installs: [], requests: [], handlers: [], flushed: 0, installResult: null, disposed: 0 }
  let serial = 0
  const agents = {
    async create(options) {
      const events = []
      let idleResolve = null
      const idle = new Promise((resolve) => { idleResolve = resolve })
      const session = { id: options.sessionId, header: options.meta, snapshotEvents: () => events.slice() }
      const agent = {
        id: options.sessionId,
        session,
        followups: [],
        whenIdle: () => idle,
        async followup(message) { agent.followups.push(message) },
      }
      state.created.push({ options, agent, events, idle: () => idleResolve() })
      return { agent, dispose: async () => { state.disposed += 1 } }
    },
  }
  const runner = createAuditRunner({
    agents: () => agents,
    sessions: () => ({ flush: async () => { state.flushed += 1 } }),
    presets: () => null,
    // The profile's own model selection. Without one the review session cannot
    // render its persona, so the runner has to be given one to work with.
    defaultModel: () => (options.model === null ? null : {
      currentSelection: () => options.model || { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    }),
    permissions: () => (options.permissions === undefined ? null : options.permissions),
    // The audit history file, when the case supplies one: the runner loads it
    // before its first answer and writes every change back through it.
    store: options.store,
    turnStartTimeoutMs: options.turnStartTimeoutMs,
    title: () => null,
    on: (event, handler) => {
      state.handlers.push(handler)
      return () => { state.handlers = state.handlers.filter((entry) => entry !== handler) }
    },
    install: async (spec, options) => {
      state.installs.push({ spec, options })
      return state.installResult || { changed: true, application: 'applied' }
    },
    fetchJson: async (url) => {
      state.requests.push(url)
      if (url.indexOf('dsh-old') >= 0) return OLD_PACKUMENT
      if (url.indexOf('dsh-note') >= 0) return PACKUMENT
      throw new Error('HTTP 404 for ' + url)
    },
    cwd: async () => 'C:/audit-dir',
    runtimeVersion: async () => runtime,
    now: () => 1700000000000,
    makeId: () => 'audit-' + (serial += 1),
  })
  return { state, runner }
}

/** Tell every listener about an event the review session published. */
function publish(state, session, event) {
  for (const handler of state.handlers.slice()) handler(session, event)
}

// -------------------------------------------------- the review really starts

{
  const { state, runner } = makeEngine()
  const first = await runner.start({ target: 'dsh-note' })
  equal(first.state, 'running', 'an audit starts running')
  equal(first.plugin.name, 'dsh-note', 'the npm name comes off the resolved target')
  equal(first.plugin.version, '1.2.3', 'the latest version is resolved')
  assert(first.plugin.repo.indexOf('github.com/example/dsh-note') >= 0,
    'the repository is resolved, because that is where the review reads code')
  equal(first.plugin.spec, 'dsh-note@1.2.3', 'the spec is what the installer takes')
  assert(first.findings.some((finding) => finding.level === 'warn' && finding.detail.indexOf('postinstall') >= 0),
    'the manifest\'s own install script is carried into the audit as a warning')
  equal(state.requests.length, 1, 'one registry read answers the whole resolution')
  equal(state.created.length, 1, 'one review session is opened')
  equal(state.created[0].options.meta.cwd, 'C:/audit-dir', 'the session works in the audit directory')
  equal(state.created[0].options.meta.workspace, undefined, 'and joins no workspace')
  // The model selection is not decoration: the profile's persona renders
  // {{model}} out of `agent.options.model`, so a session created without one
  // cannot assemble its prompt and the whole turn fails on the first message.
  equal(state.created[0].options.agentOptions.provider, 'deepseek-official',
    'the review session is created on the profile\'s own provider')
  equal(state.created[0].options.agentOptions.model, 'deepseek-flash',
    'and on its own model, which is what {{model}} renders')
  equal(typeof state.created[0].options.setup, 'function', 'creation also installs the session\'s own selection')
  equal(String(first.session.id), String(state.created[0].agent.id), 'the record carries the session the card can open')
  const message = state.created[0].agent.followups[0]
  equal(message.role, 'user', 'the review session is driven by a user message')
  const text = message.content[0].text
  assert(text.indexOf(first.auditId) >= 0, 'the prompt names the audit id the verdict must carry')
  assert(text.indexOf(AUDIT_TOOL_NAME) >= 0, 'the prompt names the tool to report with')
  assert(text.indexOf('raw.githubusercontent.com') >= 0, 'the prompt says where the source can be read')

  // The session's own events are the progress line.
  const session = state.created[0].agent.session
  publish(state, session, { type: 'turn/start' })
  equal((await runner.status({ auditId: first.auditId })).stage, 'reading', 'a started turn shows in the record')
  publish(state, session, { type: 'tool/call', data: { name: 'web_fetch' } })
  equal((await runner.status({ auditId: first.auditId })).detail.indexOf('web_fetch') >= 0, true, 'the tool being called is named')
  publish(state, { id: 'someone-else' }, { type: 'turn/end' })
  equal((await runner.status({ auditId: first.auditId })).stage, 'tool', 'another session\'s events do not move this audit')

  // The verdict channel belongs to that session.
  let refused = ''
  try {
    await runner.report({ auditId: first.auditId, verdict: 'safe', summary: '看着没事。' }, { agent: { id: 'someone-else' } })
  } catch (error) { refused = error.message }
  assert(refused.indexOf('另一个会话') >= 0, 'a report from another session is refused')

  const safe = await runner.report({
    auditId: first.auditId,
    verdict: 'safe',
    summary: '读完了入口与依赖，没有发现可疑行为。',
    findings: [{ level: 'info', title: '入口只做 IPC 转发', ref: 'lib/index.js:12' }],
  }, { agent: { id: first.session.id } })
  equal(safe.verdict, 'safe', 'the tool answers with the verdict it recorded')
  await tick()
  await tick()
  equal(state.installs.length, 1, 'a safe verdict installs without asking')
  equal(state.installs[0].spec, 'dsh-note@1.2.3', 'the install uses the resolved spec')
  equal(state.installs[0].options.requestId, first.auditId, 'and carries the audit id as its request id')
  const installed = await runner.status({ auditId: first.auditId })
  equal(installed.state, 'installed', 'the record ends installed')
  equal(installed.installed, true, 'and says so in the field the card reads')
  equal(installed.verdict, 'safe', 'the verdict is kept')
  assert(installed.summary.indexOf('入口与依赖') >= 0, 'and so is the summary behind it')
  equal(installed.findings.length, 2, 'the evidence keeps both the manifest signal and what the review reported')
  assert(installed.findings.some((finding) => finding.ref === 'lib/index.js:12'), 'and the reported evidence is in it')

  let twice = ''
  try {
    await runner.report({ auditId: first.auditId, verdict: 'warn', summary: '再报一次。' }, { agent: { id: first.session.id } })
  } catch (error) { twice = error.message }
  assert(twice.length > 0, 'an audit reports once')

  let empty = ''
  try { await runner.start({ target: '   ' }) } catch (error) { empty = error.message }
  assert(empty.length > 0, 'an empty target is refused with a reason')
}

// --------------------------------------------- warn waits, unsafe refuses

{
  const { state, runner } = makeEngine()
  const warned = await runner.start({ target: 'dsh-note' })
  await runner.report({ auditId: warned.auditId, verdict: 'warn', summary: '装了 postinstall 脚本。' },
    { agent: { id: warned.session.id } })
  await tick()
  equal(state.installs.length, 0, 'a warn verdict does not install by itself')
  equal((await runner.status({ auditId: warned.auditId })).state, 'warn', 'the record waits at warn')
  const accepted = await runner.decide({ auditId: warned.auditId, decision: 'install' })
  equal(state.installs.length, 1, 'the user can accept the risk and install')
  equal(accepted.state, 'installed', 'and the record ends installed')

  const unsafe = await runner.start({ target: 'dsh-note' })
  await runner.report({ auditId: unsafe.auditId, verdict: 'unsafe', summary: '把 ~/.dsh 里的令牌发到一个陌生域名。' },
    { agent: { id: unsafe.session.id } })
  await tick()
  equal(state.installs.length, 1, 'an unsafe verdict does not install')
  let refused = ''
  try { await runner.decide({ auditId: unsafe.auditId, decision: 'install' }) } catch (error) { refused = error.message }
  assert(refused.indexOf('恶意') >= 0, 'installing it is refused with the reason')
  equal(state.installs.length, 1, 'and nothing was installed')
  equal((await runner.status({ auditId: unsafe.auditId })).state, 'unsafe', 'the record still says unsafe')
  const declined = await runner.decide({ auditId: unsafe.auditId, decision: 'decline' })
  equal(declined.state, 'declined', 'declining is recorded')
  let unknown = ''
  try { await runner.decide({ auditId: 'nope', decision: 'install' }) } catch (error) { unknown = error.message }
  assert(unknown.length > 0, 'deciding an audit that does not exist is an error, not a silent no-op')
}

// ------------------------------------------------- what an install answered

{
  equal(describeInstall({ application: 'restart-required' }).state, 'installed',
    'a restart-required install counts as installed')
  assert(describeInstall({ application: 'restart-required' }).detail.indexOf('重启') >= 0,
    'and says a restart is needed')
  assert(describeInstall({ application: 'applied', warnings: ['x'] }).detail.indexOf('警告') >= 0,
    'warnings the manager returned are not swallowed')
  const broken = describeInstall({
    application: 'failed',
    error: {
      code: 'incompatible-version',
      incompatible: [{ name: '@deepseek-ai/dsh-tools', runtimeVersion: '0.2.1-alpha.3' }],
    },
  })
  equal(broken.state, 'failed', 'a failed install is a failure')
  assert(broken.detail.indexOf('incompatible-version') >= 0, 'the failure names the code DSH gave')
  assert(broken.detail.indexOf('@deepseek-ai/dsh-tools') >= 0, 'and the peer that did not fit')
  equal(describeInstall({ application: 'cancelled' }).state, 'declined', 'a cancelled install is not an install')

  const { state, runner } = makeEngine()
  state.installResult = {
    application: 'failed',
    error: { code: 'incompatible-version', incompatible: [{ name: '@deepseek-ai/dsh-tools', runtimeVersion: '0.2.1-alpha.3' }] },
  }
  const audit = await runner.start({ target: 'dsh-note' })
  await runner.report({ auditId: audit.auditId, verdict: 'safe', summary: '没问题。' }, { agent: { id: audit.session.id } })
  await tick()
  await tick()
  const failed = await runner.status({ auditId: audit.auditId })
  equal(failed.state, 'failed', 'an install that fails leaves the audit failed')
  assert(failed.detail.indexOf('incompatible-version') >= 0, 'with the reason DSH gave')
  equal(failed.installed, false, 'and the card is not told it was installed')
}

// ------------------------------------------- a review that never reports

{
  const { state, runner } = makeEngine()
  const audit = await runner.start({ target: 'dsh-note' })
  const record = state.created[0]
  // The end of the review is the end of its *turn*: the runner waits for the turn
  // to start before it waits for the agent to go idle, so a session that never
  // answers is only failed after it has actually had its turn.
  publish(state, { id: audit.session.id }, { type: 'turn/start' })
  record.events.push({
    type: 'assistant/message',
    data: { content: [{ type: 'text', text: '我没能确定它做了什么。' }] },
  })
  record.idle()
  await tick()
  await tick()
  const ended = await runner.status({ auditId: audit.auditId })
  equal(ended.state, 'failed', 'a review that ends without a verdict fails')
  equal(ended.stage, 'no-verdict', 'and says which state it is in')
  assert(ended.detail.indexOf('我没能确定') >= 0, 'quoting the last thing the session said')
  equal(state.flushed, 1, 'the session log is flushed, so the stock sidebar can list it')
}

// ---------------------------------- a slow session is not a failed session
//
// `agent.whenIdle()` resolves at once when the agent has nothing in flight, and it
// used to be awaited before the prompt was delivered — so every review was declared
// "no verdict" the moment it started, and then flipped to its real verdict when the
// report arrived. What the runner waits for is the session's first turn.

{
  const { state, runner } = makeEngine({ turnStartTimeoutMs: 50 })
  const audit = await runner.start({ target: 'dsh-note' })
  await tick()
  await tick()
  equal((await runner.status({ auditId: audit.auditId })).state, 'running',
    'a session that has not started its turn yet is still running')
  const record = state.created[0]
  publish(state, { id: audit.session.id }, { type: 'turn/start' })
  record.idle()
  await tick()
  await tick()
  const ended = await runner.status({ auditId: audit.auditId })
  equal(ended.state, 'failed', 'and once that turn ends without a report, it is failed')
}

{
  const { runner } = makeEngine({ turnStartTimeoutMs: 5 })
  const audit = await runner.start({ target: 'dsh-note' })
  await new Promise((resolve) => setTimeout(resolve, 25))
  await tick()
  const ended = await runner.status({ auditId: audit.auditId })
  equal(ended.state, 'failed', 'a session that never starts a turn is given up on')
  assert(ended.detail.indexOf('report_plugin_audit') >= 0, 'with the reason: it never reported')
}

// ---------------------------------------------------------- the tool itself

{
  const { state, runner } = makeEngine()
  const tool = runner.tool()
  equal(tool.name, 'report_plugin_audit', 'the tool is the verdict channel')
  equal(tool.parameters.required.join(','), 'auditId,verdict,summary', 'it requires an id, a verdict and a summary')
  equal(tool.parameters.properties.verdict.enum.join(','), 'safe,warn,unsafe', 'the verdict is one of three')
  const audit = await runner.start({ target: 'dsh-note' })
  const answered = await tool.execute(
    { auditId: audit.auditId, verdict: 'warn', summary: '需要用户确认。' },
    { agent: { id: audit.session.id } },
  )
  equal(answered.verdict, 'warn', 'calling the tool records the verdict')
  equal((await runner.status({ auditId: audit.auditId })).state, 'warn', 'and the record shows it')
  const rendered = tool.output.render({}, answered)
  equal(rendered[0].type, 'text', 'the value the model sees is text')
  assert(rendered[0].text.length > 0, 'and it says something')
  equal((await runner.list()).audits.length, 1, 'list() answers with the audits this process ran')
  equal((await runner.list()).audits[0].auditId, audit.auditId, 'newest first')
  equal((await runner.status({})).auditId, audit.auditId, 'no id means the newest audit')
  equal(await runner.status({ auditId: 'nope' }), null, 'an unknown id answers null')
  equal(state.created.length, 1, 'and no second session was opened')
}

// ------------------------------------------------- version compatibility
//
// DSH refuses to install a package whose declared harness range does not contain
// the running version, so the audit answers that *before* a session is spent and
// before the user waits for an install that cannot work. It is the same check the
// market performs; here it is the card's own.

{
  const { state, runner } = makeEngine({ runtimeVersion: '0.2.1-alpha.3' })
  const audit = await runner.start({ target: 'dsh-old' })
  equal(audit.compatibility.compatible, false, 'a peer range this runtime is not in is reported as incompatible')
  equal(audit.compatibility.runtime, '0.2.1-alpha.3', 'and the version it was measured against travels with it')
  const versionFinding = audit.findings.find((entry) => entry.title === '版本不相容')
  assert(versionFinding && versionFinding.level === 'error', 'the verdict carries an error-level finding')
  assert(state.created[0].agent.followups[0].content[0].text.includes('本机 DSH 版本'),
    'the review session is told which runtime it is reviewing for')
  const tool = runner.tool()
  await tool.execute(
    { auditId: audit.auditId, verdict: 'warn', summary: '版本不相容，但代码本身看起来正常。' },
    { agent: { id: audit.session.id } },
  )
  let refused = ''
  try {
    await runner.decide({ auditId: audit.auditId, decision: 'install' })
  } catch (error) {
    refused = String(error.message || error)
  }
  assert(refused.includes('版本范围装不上本机'), 'installing an incompatible package is refused with a reason')
  equal(state.installs.length, 0, 'and nothing was handed to the installer')
  await runner.decide({ auditId: audit.auditId, decision: 'install', override: true })
  await tick()
  equal(state.installs.length, 1, 'an explicit override still installs, because the user may know better')
}

// An unknown runtime is not an incompatible one: the card says it could not tell.
{
  const { runner } = makeEngine({ runtimeVersion: '' })
  const audit = await runner.start({ target: 'dsh-old' })
  equal(audit.compatibility.compatible, null, 'without a runtime version the answer is "cannot tell"')
  equal(audit.findings.find((entry) => entry.title === '版本不相容'), undefined, 'and nothing is called incompatible')
}

// ------------------------------------------------------------------ sessions
//
// The failure the first live run hit: a review session created without a model
// selection cannot assemble the profile's persona (`{{model}}` has no value), so
// the whole turn dies on its first message. The runner therefore refuses to open
// a session it cannot run, and leaves no half-made session behind.

{
  const { state, runner } = makeEngine({ model: null })
  const audit = await runner.start({ target: 'dsh-note' })
  assert(audit.auditId.length > 0, 'the audit is still recorded when the session cannot be opened')
  equal(audit.state, 'failed', 'an audit whose session cannot start is marked failed')
  equal(audit.stage, 'session-failed', 'and the stage names the session rather than the review')
  assert(audit.detail.indexOf('默认模型') >= 0, 'the reason is the missing model selection: ' + audit.detail)
  equal(state.created.length, 0, 'no session is created without a model to run it on')
}

// The profile's own selection is carried onto the session's requests until it has
// a header of its own, so the reasoning effort it was created with is not lost.
{
  const { state, runner } = makeEngine()
  await runner.start({ target: 'dsh-note' })
  const hooks = []
  const agentCtx = { on: (event, handler) => { hooks.push({ event, handler }); return () => {} } }
  await state.created[0].options.setup(agentCtx)
  equal(hooks.length, 1, 'creation registers one request hook')
  equal(hooks[0].event, 'agent/request', 'on the request waterfall')
  const fresh = { session: { requestHeader: () => undefined } }
  const resolved = await hooks[0].handler({ agent: fresh }, async () => ({
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low',
  }))
  equal(resolved.reasoningEffort, 'high', 'the profile\'s reasoning effort is applied to the first request')
  const recorded = { session: { requestHeader: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) } }
  const kept = await hooks[0].handler({ agent: recorded }, async () => ({
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low',
  }))
  equal(kept.reasoningEffort, 'low', 'once the session has its own header the hook leaves it alone')
}

// --------------------------------------------------------- review only
//
// Review-then-install is the default, but a review on its own is worth having:
// the user can ask for several, keep them as records, and decide later. So a
// `safe` verdict only reaches the installer when the audit was asked to install.
{
  const { state, runner } = makeEngine()
  const audit = await runner.start({ target: 'dsh-note', mode: 'review' })
  equal(audit.mode, 'review', 'the mode an audit was started with travels with it')
  const tool = runner.tool()
  const reported = await tool.execute(
    { auditId: audit.auditId, verdict: 'safe', summary: '源码正常，没有发现问题。' },
    { agent: { id: audit.session.id } },
  )
  await tick()
  equal(state.installs.length, 0, 'a review-only audit clears without installing anything')
  assert(String(reported.text).indexOf('不会自动安装') >= 0, 'and the session is told nothing was installed')
  const installed = await runner.decide({ auditId: audit.auditId, decision: 'install' })
  await tick()
  equal(state.installs.length, 1, 'the record itself can still be installed afterwards')
  equal(installed.state, 'installed', 'and the record says so')
}

// A mode that is neither of the two is the default, never a third state.
{
  const { runner } = makeEngine()
  const audit = await runner.start({ target: 'dsh-note', mode: 'something-else' })
  equal(audit.mode, 'install', 'an unknown mode falls back to review-then-install')
}

// ------------------------------------------------- the history across runs
//
// The card has a history pane, so the records have to outlive the process that
// made them: the runner reads the file before its first answer and writes every
// change back through it.
{
  const saved = {
    audits: [{
      id: 'audit-from-last-time',
      state: 'warn',
      stage: 'verdict',
      detail: '',
      mode: 'install',
      target: { input: 'dsh-note', kind: 'npm', name: 'dsh-note', version: '1.2.3', spec: 'dsh-note@1.2.3', repo: 'acme/dsh-note' },
      findings: [{ level: 'warn', title: 'postinstall runs a shell script' }],
      verdict: 'warn',
      summary: '装了 postinstall 脚本。',
      startedAt: 1000,
      updatedAt: 2000,
    }],
  }
  const writes = []
  const { runner } = makeEngine({ store: { read: async () => saved.audits, write: async (records) => { writes.push(records) } } })
  const list = await runner.list()
  equal(list.audits.length, 1, 'a record left by the previous process is part of the history')
  equal(list.audits[0].auditId, 'audit-from-last-time', 'and keeps the id the card remembers')
  equal(list.audits[0].findings.length, 1, 'with the evidence it was decided on')
  const fresh = await runner.start({ target: 'dsh-note' })
  await tick()
  assert(writes.length >= 1, 'starting an audit writes the history back')
  const last = writes[writes.length - 1]
  equal(last.length, 2, 'the file holds the old record and the new one')
  equal(last[0].id, fresh.auditId, 'newest first, and the file keeps the registrys own field name')
}

// A history that cannot be read is an empty history, not a card that breaks.
{
  const { runner } = makeEngine({
    store: { read: async () => { throw new Error('no file yet') }, write: async () => {} },
  })
  const list = await runner.list()
  equal(list.audits.length, 0, 'an unreadable history answers with nothing')
}

if (failures > 0) {
  console.error('audit-runner: ' + failures + ' assertion(s) failed')
  process.exit(1)
}
console.log('audit-runner: all assertions passed')
