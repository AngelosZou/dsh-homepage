/**
 * dsh-homepage — Host half.
 *
 * Owns everything the browser half cannot reach:
 *
 *  - a local balance ledger under `<DSH_HOME>/storages/dsh-homepage/`,
 *    fed by sampling the DeepSeek account recharge wallets. Per-day spend is the
 *    drop between the day's carried-over opening balance and its latest sample,
 *    which is real money rather than an estimate derived from token counts;
 *  - the persisted UI state (card order, spans, effects, control values) so the
 *    wall survives a reload, another browser and a profile reset;
 *  - the process environment facts the network card shows, with proxy userinfo
 *    masked separately from the raw value;
 *  - a sessionless `homepage/*` Typert endpoint set for the browser half, and an
 *    opt-in `homepage` tool over the same data for the model (off until the
 *    user turns it on in the Plugins settings page).
 *
 * @module dsh-homepage
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_SCHEME } from './default-state.js'
import { createActions } from './host/actions.js'
import { versionFromEntry } from './host/audit.js'
import { createAuditRunner } from './host/audit-runner.js'
import { createCollector } from './host/collector.js'
import { sampleDevice } from './host/device.js'
import { sampleDshRelease } from './host/dsh.js'
import { defaultInstallRoot, defaultRunningCore, desktopCore, installKind, listInstalled, startInstall } from './host/dsh-install.js'
import { createHygiene } from './host/hygiene.js'
import { createSidebarStore } from './host/sidebar.js'
import { createSkillStore } from './host/skills.js'
import { prepareSource } from './host/source-snapshot.js'
import { createToolUsage } from './host/tool-usage.js'
import { createProjectsReader } from './host/projects.js'

/** Plugin row id. */
export const name = 'dsh-homepage'
/** The tool registry is the only hard dependency; the account service is optional. */
export const inject = ['tools']

/**
 * The configuration schema library. DSH provides it as a peer; a bare checkout
 * that has not installed anything simply loads without a config schema, and the
 * opt-in tool then stays off.
 */
const schema = await loadSchema()

/** @returns the schemastery module, or null when it cannot be resolved. */
async function loadSchema() {
  try {
    const loaded = await import('@deepseek-ai/schemastery')
    return loaded.default ?? loaded
  } catch (error) {
    void error
    return null
  }
}

/**
 * Plugin configuration.
 *
 * `exposeTool` is the opt-in switch for the model-facing `homepage` tool. It
 * ships OFF: an unexposed tool costs no context and grants no data access until
 * the user turns it on in the Plugins settings page, where both fields appear
 * because they are volatile. `toolLanguage` picks the language of the tool's
 * text; `auto` follows the saved UI locale and otherwise answers in English.
 */
export const Config = schema === null ? undefined : schema.object({
  exposeTool: schema.boolean()
    .default(false)
    .description('Expose the model-facing homepage tool. It reads this machine; keep it off unless a session needs it.')
    .volatile(),
  toolLanguage: schema.union([schema.const('auto'), schema.const('en'), schema.const('zh')])
    .default('auto')
    .description('Language of the tool text. auto follows the saved UI locale and otherwise answers in English.')
    .volatile(),
})

/**
 * Read one plugin-config field, unwrapping a volatile reference.
 * @param config - the parsed plugin config (volatile fields are references).
 * @param key - the field name.
 * @param fallback - the value when the field is absent.
 * @returns the current value.
 */
function configValue(config, key, fallback) {
  if (config === null || config === undefined) return fallback
  const field = config[key]
  if (field === null || field === undefined) return fallback
  const value = typeof field.get === 'function' ? field.get() : field
  return value === undefined ? fallback : value
}

/**
 * The language the tool answers in: the plugin option, or for `auto` the saved
 * `locale` preference. The Host has no locale service of its own — the UI
 * language is a browser preference projected through the settings document — so
 * an unset or unknown preference falls back to English, which is what DSH's own
 * tools ship.
 * @param ctx - plugin context.
 * @param config - the parsed plugin config.
 * @returns `'en'` or `'zh'`.
 */
function toolLanguage(ctx, config) {
  const chosen = configValue(config, 'toolLanguage', 'auto')
  if (chosen === 'en' || chosen === 'zh') return chosen
  try {
    const settings = service(ctx, 'settings')
    if (settings && typeof settings.describe === 'function') {
      const entries = settings.describe({ redactSecrets: true }) || []
      const locale = entries.find((entry) => entry && entry.ns === 'locale')
      const preference = locale && ((locale.user && locale.user.preference)
        || (locale.value && locale.value.preference))
      if (typeof preference === 'string' && preference.toLowerCase().startsWith('zh')) return 'zh'
    }
  } catch (error) {
    void error
  }
  return 'en'
}

const REMOTE_PREFIX = 'homepage'
const NAMESPACE = 'homepage'
const MICRO = 1000000
const DAY_KEEP = 180
const HISTORY_DAYS = 21
const MIN_SAMPLE_INTERVAL_MS = 15000

// --------------------------------------------------------------- storage

/** @returns the DSH home directory this process is configured with. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** @returns this plugin's own storage directory. */
function storageRoot() { return join(dshHome(), 'storages', 'dsh-homepage') }
/** @returns the balance ledger file path. */
function ledgerPath() { return join(storageRoot(), 'balance-ledger.json') }
/** @returns the persisted UI state file path. */
function statePath() { return join(storageRoot(), 'home-state.json') }

/**
 * The workspace-group layout the left sidebar renders from. It is display state
 * only: no workspace, session or project fact is written back to DSH. Built per
 * call so it follows `DSH_HOME` the way the ledger and the state file do — a
 * store captured at import time would freeze whatever the variable held then.
 *
 * @returns the store for this plugin's storage directory.
 */
function sidebarStore() { return createSidebarStore({ root: storageRoot() }) }

/**
 * The local Skill library. Built per call so it follows `DSH_HOME` and
 * `DSH_AGENTS_HOME` the way the ledger and the sidebar document do, and so a
 * request that names a project cwd scans that project's own roots instead of
 * whatever directory this process happens to have been started in.
 *
 * @param cwd - a session working directory, or null for the user roots alone.
 * @returns the skill store for this call.
 */
function skillStore(cwd) {
  return createSkillStore({
    dshHome: dshHome(),
    agentsHome: process.env.DSH_AGENTS_HOME,
    projectCwd: cwd === undefined || cwd === null || String(cwd).trim() === '' ? null : String(cwd),
  })
}

/**
 * The external Skill sources (ClawHub and friends). Imported lazily: a profile
 * whose installation predates this module still answers `skillList`, and the
 * Discover pane is the only surface that needs the network half at all.
 *
 * @returns the source adapter, or null when the module is unavailable.
 */
let skillSourceCache = null
async function skillSources() {
  if (skillSourceCache !== null) return skillSourceCache
  const module = await import('./host/skill-sources.js')
  skillSourceCache = module.createSkillSources({})
  return skillSourceCache
}

/** @returns `options.cwd` as a trimmed string, or null. */
function cwdOf(options) {
  const value = options && options.cwd
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Resolve the absolute directory one destination name means, so the client
 * never has to know a path. `user-dsh` is the root the harness itself scans for
 * a profile's own skills; `user-agents` is the shared `~/.agents/skills` root
 * that Claude Code and most community clients also read.
 *
 * @param destination - `'user-dsh'` (default) or `'user-agents'`.
 * @returns the absolute directory.
 */
function installRoot(destination) {
  if (destination === 'user-agents') {
    const configured = process.env.DSH_AGENTS_HOME
    const base = configured && configured.trim() !== '' ? configured : join(homedir(), '.agents')
    return join(base, 'skills')
  }
  return join(dshHome(), 'skills')
}

/**
 * Read one JSON document, tolerating a missing or damaged file.
 * @param path - file to read.
 * @param fallback - value returned when the file cannot be used.
 * @returns the parsed value or the fallback.
 */
async function readJson(path, fallback) {
  try {
    const text = await readFile(path, 'utf8')
    const value = JSON.parse(text)
    return value === null || typeof value !== 'object' ? fallback : value
  } catch { return fallback }
}

/**
 * Write one JSON document atomically enough for a local cache: a same-directory
 * temp file is renamed over the target, so a crash never leaves half a file.
 * @param path - destination file.
 * @param value - JSON-serializable value.
 * @returns nothing; a write failure propagates to the caller.
 */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const text = JSON.stringify(value)
  const temp = path + '.tmp'
  await writeFile(temp, text, 'utf8')
  try { await rename(temp, path) } catch { await writeFile(path, text, 'utf8') }
}

// ----------------------------------------------------------------- money

/**
 * Parse a decimal balance string into integer micro-units.
 * @param value - decimal string as the Platform reports it.
 * @returns integer micro-units, or null when the value is not a finite number.
 */
function toUnits(value) {
  const parsed = Number(String(value).trim())
  return Number.isFinite(parsed) ? Math.round(parsed * MICRO) : null
}

/**
 * Render integer micro-units as a fixed two-decimal string.
 * @param units - integer micro-units.
 * @returns decimal string.
 */
function fromUnits(units) { return (Number(units || 0) / MICRO).toFixed(2) }

/**
 * Render a Platform decimal as a plain two-decimal amount. The Platform states
 * balances as floats, so an empty dollar wallet arrives as `0E-16` and a real
 * one as `45.7165996400000000`; both need rounding before they reach a card.
 * A value Number() cannot read is passed through as stated rather than
 * disguised as zero.
 * @param value - decimal string as the Platform reports it.
 * @returns two-decimal display string, or the original text when unreadable.
 */
function formatAmount(value) {
  const text = String(value === undefined || value === null ? '' : value).trim()
  if (text === '') return '0.00'
  const units = toUnits(text)
  return units === null ? text : fromUnits(units)
}

/** @returns the local calendar day key for an instant. */
function dayKey(at) {
  const d = new Date(at)
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/** @returns the previous day key, used to carry an opening balance forward. */
function previousDayKey(day) {
  const parts = String(day).split('-').map(Number)
  const d = new Date(parts[0], parts[1] - 1, parts[2])
  d.setDate(d.getDate() - 1)
  return dayKey(d.getTime())
}

// ------------------------------------------------------------- ledger

/**
 * Fold one balance sample into the ledger, carrying the most recent known
 * balance forward as today's opening value so the first read of a day still
 * reports the spend that happened overnight.
 * @param ledger - ledger document, mutated in place.
 * @param wallets - recharge wallets as `{ currency, balance }`.
 * @param at - sample instant in milliseconds.
 * @returns the updated day record.
 */
function applySample(ledger, wallets, at) {
  const days = ledger.days && typeof ledger.days === 'object' ? ledger.days : (ledger.days = {})
  const day = dayKey(at)
  let record = days[day]
  if (!record) {
    const open = {}
    let carriedFrom = null
    let cursor = previousDayKey(day)
    for (let step = 0; step < DAY_KEEP; step++) {
      const previous = days[cursor]
      if (previous && previous.last && Object.keys(previous.last).length > 0) {
        for (const [currency, units] of Object.entries(previous.last)) open[currency] = units
        carriedFrom = cursor
        break
      }
      cursor = previousDayKey(cursor)
    }
    record = { day: day, firstAt: at, lastAt: at, open: open, last: {}, carriedFrom: carriedFrom, samples: 0 }
  }
  for (const wallet of wallets) {
    if (!wallet || wallet.currency === undefined) continue
    const units = toUnits(wallet.balance)
    if (units === null) continue
    if (record.open[wallet.currency] === undefined) record.open[wallet.currency] = units
    record.last[wallet.currency] = units
  }
  record.lastAt = at
  record.samples = Number(record.samples || 0) + 1
  days[day] = record
  const keys = Object.keys(days).sort()
  for (const stale of keys.slice(0, Math.max(0, keys.length - DAY_KEEP))) delete days[stale]
  ledger.days = days
  ledger.version = 1
  ledger.updatedAt = at
  return record
}

/** @returns the primary currency of a day record: CNY when present, else the first known. */
function primaryCurrency(record) {
  if (!record) return null
  const last = record.last || {}
  if (Object.prototype.hasOwnProperty.call(last, 'CNY')) return 'CNY'
  const keys = Object.keys(last)
  return keys.length > 0 ? keys[0] : null
}

/**
 * Read one day as spend and credit for its primary currency. Spend is the drop
 * from the opening balance; credit is a rise, which is a top-up rather than a
 * refund of spend, and is reported separately instead of hiding the drop.
 * @param record - one ledger day record.
 * @returns a serializable day summary.
 */
function summarizeDay(record) {
  const currency = primaryCurrency(record)
  if (currency === null) {
    return { day: record.day, currency: null, spend: '0.00', credit: '0.00', open: null, last: null,
      openAt: record.firstAt, lastAt: record.lastAt, carriedFrom: record.carriedFrom || null,
      samples: Number(record.samples || 0), partial: true }
  }
  const open = record.open[currency]
  const last = record.last[currency]
  const delta = (open === undefined ? last : open) - last
  const spendUnits = delta > 0 ? delta : 0
  const creditUnits = delta < 0 ? -delta : 0
  return {
    day: record.day,
    currency: currency,
    spend: fromUnits(spendUnits),
    spendUnits: spendUnits,
    credit: fromUnits(creditUnits),
    creditUnits: creditUnits,
    open: fromUnits(open === undefined ? last : open),
    last: fromUnits(last),
    openAt: record.firstAt,
    lastAt: record.lastAt,
    carriedFrom: record.carriedFrom || null,
    samples: Number(record.samples || 0),
    // A day observed only once (or only by the carried-forward value) covers an
    // unknown window, so the client can label it as a lower bound.
    partial: Number(record.samples || 0) <= 1 && record.carriedFrom === null,
  }
}

// -------------------------------------------------------- account reads

/**
 * Resolve a service from the plugin context without making it a hard dependency.
 * @param ctx - plugin context.
 * @param key - service key.
 * @returns the service instance, or undefined when it is not mounted.
 */
function service(ctx, key) {
  try {
    if (typeof ctx.get === 'function') {
      const found = ctx.get(key)
      if (found !== undefined && found !== null) return found
    }
  } catch { /* an unmounted service must not break the caller */ }
  return ctx[key]
}

/**
 * Where a review session works. It has to be an absolute directory that is not
 * one of the user's own workspaces: the stock sidebar files a session by its
 * `header.cwd`, so a review that borrowed a project's directory would turn up
 * inside that project instead of in 未分组.
 * @returns the absolute directory, created on demand by the caller.
 */
function auditWorkspaceDir() {
  return join(dshHome(), 'plugin-audit')
}

/**
 * Install one bundle through the plugin manager, which is the only install path
 * that keeps the profile's own bookkeeping (dependencies, bundle rows,
 * compatibility) in one place. A missing service is an error the card shows,
 * never a silent no-op.
 * @param ctx - plugin context.
 * @param spec - the package spec to install.
 * @param options - `{ requestId }`, forwarded when present.
 * @returns what the manager answered.
 */
async function installBundle(ctx, spec, options = {}) {
  const manager = service(ctx, 'pluginManager')
  if (!manager || typeof manager.installBundle !== 'function') {
    throw new Error('本机的 pluginManager 服务不可用，无法安装插件')
  }
  const wanted = { enabled: true }
  if (options && typeof options.requestId === 'string' && options.requestId !== '') {
    wanted.requestId = options.requestId
  }
  return manager.installBundle(spec, wanted)
}

/**
 * Which DSH is running. The harness's own entry script lives inside the checkout
 * that is executing, so walking up from `process.argv[1]` answers it without
 * importing anything — and the answer is what the compatibility check compares a
 * package's declared peer ranges against. Read once and remembered: the running
 * version cannot change under us.
 * @returns the version, or '' when this layout does not expose one.
 */
let runtimeVersionCache = null
async function runtimeVersion() {
  if (runtimeVersionCache !== null) return runtimeVersionCache
  let found = ''
  try {
    found = await versionFromEntry(process.argv[1], { readFile })
  } catch { /* an unreadable layout answers 'unknown', which the check reports */ }
  runtimeVersionCache = found
  return found
}

/**
 * The file the audit history lives in. The records belong to the host, not to the
 * card, so they outlive a page reload, a closed card and a restart — which is what
 * lets a user start several reviews, walk away, and decide about them later.
 * @returns the absolute path.
 */
function auditHistoryPath() {
  return join(storageRoot(), 'plugin-audit-history.json')
}

/** @returns the saved audits, or an empty list when there is nothing readable. */
async function readAuditHistory() {
  try {
    const raw = await readFile(auditHistoryPath(), 'utf8')
    const held = JSON.parse(raw)
    return Array.isArray(held && held.audits) ? held.audits : []
  } catch {
    return []
  }
}

/**
 * Save the audits, best effort: a history that cannot be written must not break
 * the review that produced it.
 * @param audits - the records, newest first.
 */
async function writeAuditHistory(audits) {
  try {
    await mkdir(storageRoot(), { recursive: true })
    await writeFile(auditHistoryPath(), JSON.stringify({ version: 1, audits }))
  } catch { /* the record stays in memory only */ }
}

/** @returns the client identity one account read carries. */
function clientMetadata() {
  let locale = 'zh-CN'
  try { locale = Intl.DateTimeFormat().resolvedOptions().locale || locale } catch { /* keep the default */ }
  return {
    version: 'dsh-homepage/0.1.0',
    locale: locale,
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

/**
 * Read the recharge wallets once.
 * @param ctx - plugin context.
 * @returns a discriminated read outcome; never throws.
 */
async function readBalance(ctx) {
  const account = service(ctx, 'deepseekAccount')
  if (!account || typeof account.getBalance !== 'function') {
    return { ok: false, reason: 'unavailable', message: 'deepseekAccount service is not mounted in this profile.' }
  }
  let view
  try { view = typeof account.getState === 'function' ? await account.getState() : undefined }
  catch (error) { return { ok: false, reason: 'state-failed', message: messageOf(error) } }
  const state = { status: view && view.status ? view.status : 'unknown', links: view && view.links ? view.links : null }
  if (view && view.status === 'signed-out') {
    return { ok: false, reason: 'signed-out', view: state, message: 'No DeepSeek account grant is stored.' }
  }
  let details
  try { details = await account.getBalance(clientMetadata()) }
  catch (error) { return { ok: false, reason: 'failed', view: state, message: messageOf(error) } }
  if (details === null) {
    return { ok: false, reason: 'no-grant', view: state, message: 'The account grant is absent or changed; sign in again.' }
  }
  if (details.status !== 'ready') {
    return { ok: false, reason: 'failed', view: state, message: 'Platform refused the balance query.' }
  }
  return { ok: true, view: state, wallets: details.value || [], bonusWallets: details.bonusWallets || [] }
}

/** @returns a stable message for a thrown value. */
function messageOf(error) {
  return String(error && error.message !== undefined ? error.message : error)
}

// ------------------------------------------------------------- overview

/** @returns the ledger document, or an empty one. */
async function loadLedger() {
  const value = await readJson(ledgerPath(), null)
  if (!value || typeof value !== 'object' || !value.days || typeof value.days !== 'object') {
    return { version: 1, updatedAt: 0, days: {}, lastAttemptAt: 0, lastOutcome: null }
  }
  value.version = 1
  if (typeof value.lastAttemptAt !== 'number') value.lastAttemptAt = 0
  return value
}

/**
 * The account read currently in flight, shared by every concurrent on-demand
 * overview. A page that is closed never reaches this module: the plugin arms no
 * background account timer, so an idle instance performs no Platform reads.
 */
let balanceReadPending = null

/**
 * Sample the account, fold the result into the ledger and persist it.
 * @param ctx - plugin context.
 * @param force - bypass the minimum interval between Platform reads.
 * @returns the read outcome, with the ledger attached.
 */
async function sample(ctx, force) {
  // Two card instances asking at the same moment (the wall preview and the
  // expanded page) share one read instead of spending two.
  if (!force && balanceReadPending !== null) return balanceReadPending
  const run = (async () => {
    const ledger = await loadLedger()
    const now = Date.now()
    if (!force && now - Number(ledger.lastAttemptAt || 0) < MIN_SAMPLE_INTERVAL_MS) {
      return { ledger: ledger, read: ledger.lastOutcome || null, sampled: false, at: Number(ledger.lastAttemptAt || 0) }
    }
    const read = await readBalance(ctx)
    ledger.lastAttemptAt = now
    ledger.lastOutcome = { ok: read.ok, reason: read.reason || null, message: read.message || null, view: read.view || null }
    if (read.ok) {
      applySample(ledger, read.wallets, now)
      ledger.wallet = read.wallets
      ledger.bonusWallets = read.bonusWallets
      ledger.walletAt = now
    }
    try { await writeJson(ledgerPath(), ledger) } catch { /* a failed cache write must not fail the read */ }
    return { ledger: ledger, read: read, sampled: true, at: now }
  })()
  if (force) return run
  balanceReadPending = run
  try {
    return await run
  } finally {
    if (balanceReadPending === run) balanceReadPending = null
  }
}

/**
 * Build the payload the token card renders.
 * @param ctx - plugin context.
 * @param options - `force` refreshes even inside the minimum interval.
 * @returns the overview document.
 */
async function overview(ctx, options) {
  const wanted = Number(options && options.historyDays) || HISTORY_DAYS
  const result = await sample(ctx, Boolean(options && options.force))
  const ledger = result.ledger
  const days = Object.keys(ledger.days || {}).sort().reverse()
  const history = days.slice(0, Math.max(1, Math.min(90, wanted))).map((day) => summarizeDay(ledger.days[day]))
  const today = summarizeDay(ledger.days[dayKey(Date.now())] || {
    day: dayKey(Date.now()), firstAt: result.at, lastAt: result.at, open: {}, last: {}, samples: 0,
  })
  const wallets = Array.isArray(ledger.wallet) ? ledger.wallet : []
  const currency = today.currency || primaryCurrency(ledger.days[dayKey(Date.now())] || {}) ||
    (wallets.length > 0 ? wallets[0].currency : null)
  return {
    generatedAt: Date.now(),
    sampledAt: result.at,
    sampledNow: result.sampled,
    currency: currency,
    wallets: wallets.map((wallet) => {
      const raw = String(wallet.balance)
      return { currency: wallet.currency, balance: formatAmount(raw), raw: raw, units: toUnits(raw) }
    }),
    bonusWallets: (Array.isArray(ledger.bonusWallets) ? ledger.bonusWallets : []).map((wallet) => {
      const raw = String(wallet.balance)
      return { currency: wallet.currency, balance: formatAmount(raw), raw: raw }
    }),
    today: today,
    history: history,
    account: (result.read && result.read.view) || (ledger.lastOutcome && ledger.lastOutcome.view) || { status: 'unknown', links: null },
    error: result.read && !result.read.ok
      ? { reason: result.read.reason || 'failed', message: result.read.message || 'Balance read failed.' }
      : null,
    storage: ledgerPath(),
  }
}

// ------------------------------------------------------------ environment

const PROXY_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'FTP_PROXY', 'SOCKS_PROXY', 'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'NPM_CONFIG_NOPROXY',
]

const TLS_KEYS = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']

/**
 * Strip `user:pass@` out of a proxy URL, keeping the shape readable.
 * @param value - raw environment value.
 * @returns the value with any userinfo replaced by `***`.
 */
function maskProxy(value) {
  return String(value).replace(/(\w+:\/\/)[^/@\s]*@/g, '$1***@')
}

/**
 * Describe one proxy URL without discarding what makes it usable.
 * @param value - raw environment value.
 * @returns parsed fields plus the masked and raw spellings.
 */
function describeProxy(value) {
  const raw = String(value)
  const masked = maskProxy(raw)
  let protocol = null
  let host = null
  let port = null
  let hasAuth = /\/\/[^/@\s]*@/.test(raw)
  if (raw === '' ) return { raw: raw, masked: masked, protocol: null, host: null, port: null, hasAuth: false, empty: true }
  try {
    const parsed = new URL(raw.includes('://') ? raw : 'http://' + raw)
    protocol = parsed.protocol.replace(':', '')
    host = parsed.hostname
    port = parsed.port === '' ? null : Number(parsed.port)
  } catch {
    const match = /^([\w+.-]+):\/\/(?:[^/@]*@)?([^:/?#]+)(?::(\d+))?/.exec(raw)
    if (match) {
      protocol = match[1]
      host = match[2]
      port = match[3] === undefined ? null : Number(match[3])
    }
  }
  return { raw: raw, masked: masked, protocol: protocol, host: host, port: port, hasAuth: hasAuth, empty: false }
}

/** @returns the environment document the network card renders. */
function environment() {
  const env = process.env || {}
  const proxies = []
  for (const canonical of PROXY_KEYS) {
    const spellings = [canonical, canonical.toLowerCase()]
    const present = spellings.filter((key) => env[key] !== undefined && String(env[key]).trim() !== '')
    if (present.length === 0) continue
    const primary = present.includes(canonical) ? canonical : present[0]
    const detail = describeProxy(env[primary])
    proxies.push(Object.assign({
      name: canonical,
      kind: canonical === 'NO_PROXY' || canonical.endsWith('NOPROXY') ? 'bypass' : 'proxy',
      spellings: present,
    }, detail))
  }
  const tls = TLS_KEYS
    .filter((key) => env[key] !== undefined && String(env[key]).trim() !== '')
    .map((key) => ({ name: key, value: String(env[key]) }))
  return {
    capturedAt: Date.now(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    pid: process.pid,
    cwd: process.cwd(),
    dshHome: dshHome(),
    storage: storageRoot(),
    proxyCount: proxies.filter((entry) => entry.kind === 'proxy').length,
    proxies: proxies,
    tls: tls,
    // Anything else that routes traffic through a middlebox, so a "direct"
    // verdict is not claimed while one of these is set.
    redirectors: ['GIT_PROXY_COMMAND', 'DOCKER_HTTP_PROXY'].filter((key) => env[key] !== undefined && String(env[key]).trim() !== '')
      .map((key) => ({ name: key, value: maskProxy(env[key]) })),
  }
}

// ---------------------------------------------------------------- state

/** @returns whether a new state section is a plain JSON map, not a list. */
function stateMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @returns a bounded card id; prototype-related keys are never map entries. */
function cardStateId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value)
}

/** @returns a finite, bounded number without coercing strings or booleans. */
function textureNumber(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : undefined
}

/** @returns a safe CSS length (numbers remain px), or undefined. */
function textureLength(value, min, max) {
  if (typeof value === 'number') return textureNumber(value, min, max)
  if (typeof value !== 'string' || value.length > 32) return undefined
  const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|%|em|rem|vh|vw)$/.exec(value.trim())
  if (!match) return undefined
  const number = Number(match[1])
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) + match[2] : undefined
}

/** @returns a browser image URL only; never fetches anything on the host. */
function textureImage(value) {
  if (typeof value !== 'string' || value.length > 2 * 1024 * 1024 || /[\u0000-\u001f\u007f]/.test(value)) return undefined
  const text = value.trim()
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|svg\+xml)(?:;[^,]*)?,/i.test(text)) return text
  if (text.length > 8192 || !/^https?:\/\//i.test(text)) return undefined
  try {
    const url = new URL(text)
    if (url.hostname && !url.username && !url.password) return text
  } catch { /* malformed URLs do not become CSS values */ }
  return undefined
}

/** Mix-blend modes a texture may use to settle into the card surface. */
const TEXTURE_BLENDS = ['normal', 'multiply', 'screen', 'luminosity', 'soft-light']

/** @returns an allowlisted texture override; missing properties use client defaults. */
function normalizeTexture(value) {
  if (typeof value === 'string') value = { icon: value }
  if (!stateMap(value)) return undefined
  const result = {}
  if (typeof value.icon === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value.icon)) result.icon = value.icon
  // Preserve registered tints when the studio copies a texture into an override.
  if (typeof value.tint === 'string' && value.tint.length <= 128
    && /^(?:#[a-fA-F0-9]{3,8}|[a-zA-Z]+|(?:rgb|rgba|hsl|hsla)\([0-9.,%+\-\s/]+\)|var\(--[a-zA-Z0-9_-]+(?:,\s*#[a-fA-F0-9]{3,8})?\))$/.test(value.tint)) result.tint = value.tint
  const image = textureImage(value.image)
  if (image !== undefined) result.image = image
  const opacity = textureNumber(value.opacity, 0, 100)
  if (opacity !== undefined) result.opacity = opacity
  if (typeof value.fade === 'boolean') result.fade = value.fade
  const fadePosition = textureNumber(value.fadePosition, 0, 100)
  if (fadePosition !== undefined) result.fadePosition = fadePosition
  if (TEXTURE_BLENDS.includes(value.blend)) result.blend = value.blend
  const size = textureLength(value.size, 0, 4096)
  if (size !== undefined) result.size = size
  const bleed = textureLength(value.bleed, -2048, 2048)
  if (bleed !== undefined) result.bleed = bleed
  if (['left', 'center', 'right'].includes(value.anchor)) result.anchor = value.anchor
  if (['contain', 'cover'].includes(value.fit)) result.fit = value.fit
  const angle = typeof value.rotate === 'string' && /^-?(?:\d+(?:\.\d+)?|\.\d+)deg$/.test(value.rotate.trim())
    ? Number(value.rotate.trim().slice(0, -3)) : value.rotate
  const rotate = textureNumber(angle, -360, 360)
  if (rotate !== undefined) result.rotate = rotate
  if (Array.isArray(value.offset) && value.offset.length === 2) {
    const offset = value.offset.map((part) => textureLength(part, -2048, 2048))
    if (offset.every((part) => part !== undefined)) result.offset = offset
  }
  return result
}

/** @returns at most 128 card overrides; null explicitly disables a texture. */
function normalizeAppearance(value) {
  const result = {}
  if (!stateMap(value)) return result
  for (const [id, texture] of Object.entries(value).filter(([id]) => cardStateId(id)).slice(0, 128)) {
    const normalized = texture === null ? null : normalizeTexture(texture)
    if (normalized !== undefined) result[id] = normalized
  }
  return result
}

/** @returns at most 128 distinct hidden card ids, retaining their order. */
function normalizeHidden(value) {
  return Array.isArray(value) ? [...new Set(value.filter(cardStateId))].slice(0, 128) : []
}

/** @returns one state record, with every persisted section normalised. */
function normalizeState(value) {
  return {
    version: 1,
    order: Array.isArray(value.order) ? value.order.filter((id) => typeof id === 'string') : [],
    layout: value.layout && typeof value.layout === 'object' ? value.layout : {},
    effects: value.effects && typeof value.effects === 'object' ? value.effects : {},
    controls: value.controls && typeof value.controls === 'object' ? value.controls : {},
    settings: value.settings && typeof value.settings === 'object' ? value.settings : {},
    appearance: normalizeAppearance(value.appearance),
    hidden: normalizeHidden(value.hidden),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
  }
}

/**
 * @returns the persisted UI state, or the shipped default scheme when this
 * profile has never written one. The scheme is cloned because the caller owns
 * the returned state and the module constant must stay pristine.
 */
async function loadState() {
  const value = await readJson(statePath(), null)
  if (!value || typeof value !== 'object') {
    return normalizeState(JSON.parse(JSON.stringify(DEFAULT_SCHEME)))
  }
  return normalizeState(value)
}

/**
 * Merge one state patch. Whole sections are replaced rather than deep-merged so
 * a removed card id cannot survive in the file forever.
 * @param patch - partial state; unknown sections are ignored.
 * @returns the persisted state.
 */
async function saveState(patch) {
  const current = await loadState()
  const next = Object.assign({}, current)
  if (patch && typeof patch === 'object') {
    for (const key of ['order', 'layout', 'effects', 'controls', 'settings']) {
      if (patch[key] !== undefined && patch[key] !== null && typeof patch[key] === 'object') next[key] = patch[key]
    }
    // Like the legacy sections, these replace the entire section. Wrong top-level
    // types (including null) are ignored; {} and [] explicitly reset overrides.
    if (stateMap(patch.appearance)) next.appearance = normalizeAppearance(patch.appearance)
    if (Array.isArray(patch.hidden)) next.hidden = normalizeHidden(patch.hidden)
  }
  next.version = 1
  next.updatedAt = Date.now()
  await writeJson(statePath(), next)
  return next
}

// ----------------------------------------------------------------- tool

const TOOL_DESCRIPTION =
  'Read the user\'s personal home page data: today\'s DeepSeek account spend and current balance, the ' +
  'per-day history the ledger recorded, the proxy settings in this process environment, the local ' +
  'agent Skills installed on this machine, the project wall (workspace registry plus each repository\'s ' +
  'git state), the DSH home storage inventory, and the live runtime summary. Use it when the user asks ' +
  'about spend, balance, remaining credit, which proxy the harness is using, which projects are dirty, ' +
  'how much disk the DSH home uses, or what is running.'

// ------------------------------------------------------- tool copy (i18n)

/**
 * Text the `homepage` tool returns to the model.
 *
 * The Host has no locale service — the UI language is a browser preference — so
 * the language is a plugin option. `auto` follows the saved `locale` entry
 * preference and otherwise answers in English, which is what DSH's own tools
 * ship; `en` and `zh` pin it.
 */
const TOOL_COPY = {
  en: {
    balance: 'Balance',
    bonus: 'Bonus balance',
    balanceUnavailable: 'Balance: unavailable ({reason})',
    today: 'Today: {spend} {currency} ({open} → {last}, {samples} samples{partial})',
    partial: ', partial window',
    history: 'Last {n} days: {series}',
    platform: 'Platform: {platform} {arch}, Node {node}',
    cwd: 'Working directory: {cwd}',
    noProxy: 'Proxy: not set (direct)',
    proxyHeader: 'Proxy:',
    credentials: '    (contains credentials, shown on demand in the UI)',
    bypass: 'Bypass {name} = {value}',
    cpu: 'CPU: {usage} ({count} cores, {model})',
    unknownModel: 'unknown model',
    memory: 'Memory: {used} / {total} ({usage})',
    gpu: 'GPU: {name}{usage}{vram}',
    gpuUsage: ' (usage {pct}{engine})',
    gpuEngine: ' · {engine}',
    notDetected: 'not detected',
    vram: ', VRAM {pair}',
    capacityUnknown: 'capacity unknown',
    temperature: 'Temperature: {value}',
    temperatureUnavailable: 'unavailable ({reason})',
    storage: 'Storage: {path}, {usage} used',
    sampled: 'Sampled: {when}',
    skills: 'Skills: {total} total (model-invocable {enabled}, manual only {userOnly}, off {disabled}{invalid})',
    invalidPart: ', {n} unparseable',
    scanned: 'Scanned: {list}',
    root: '{path} ({source}, {count})',
    noSkills: 'No Skills are installed yet.',
    skillEnabled: 'enabled',
    skillManual: 'manual only (/name)',
    skillOff: 'off',
    unparseable: 'unparseable: {note}',
    readOnly: 'read-only',
    readFailed: 'Read failed: {list}',
    dshCore: 'DSH core: {repo} (branch {branch})',
    latestCommit: 'Latest commit: {sha}  {message} ({author}, {date})',
    latestCommitUnreadable: 'Latest commit: unreadable',
    latestRelease: 'Latest release: {name} (tag {tag}, {publishedAt})',
    latestReleaseUnreadable: 'Latest release: unreadable',
    routes: 'Routes: commits {commits}, releases {releases}, HEAD {head}',
    cached: 'Cached: reused the previous result',
    status: 'Status: {reason}{error}',
    runtime: 'Runtime: {agents} agents (running {running}, idle {idle}, roots {roots}), {sessions} sessions',
    runtimeUnavailable: 'Runtime: unavailable ({reason})',
    projects: 'Projects: {total} (dirty {dirty}, live {live}, extra worktrees {worktrees})',
    projectsUnavailable: 'Projects: unavailable ({reason})',
    notGit: 'not a git repository',
    gitFailed: 'git read failed',
    projectRow: '- {title}: {state}',
    projectState: '{branch}, {dirty} changes{ahead}{behind}',
    ahead: ', ahead {n}',
    behind: ', behind {n}',
    moreProjects: '…{n} more projects',
    hygiene: 'Storage: {total}, {files} files, {reclaimable} reclaimable',
    hygieneUnavailable: 'Storage: unavailable ({reason})',
    hygieneRow: '- {id}: {bytes} ({files} files)',
  },
  zh: {
    balance: '余额',
    bonus: '赠送余额',
    balanceUnavailable: '余额：不可用（{reason}）',
    today: '今日消费：{spend} {currency}（{open} → {last}，{samples} 次采样{partial}）',
    partial: '，区间可能不完整',
    history: '近 {n} 天：{series}',
    platform: '平台：{platform} {arch}，Node {node}',
    cwd: '工作目录：{cwd}',
    noProxy: '代理：未设置（直连）',
    proxyHeader: '代理：',
    credentials: '    （含凭据，已在界面上按需显示）',
    bypass: '代理绕行 {name} = {value}',
    cpu: '处理器：{usage}（{count} 核，{model}）',
    unknownModel: '未知型号',
    memory: '内存：{used} / {total}（{usage}）',
    gpu: 'GPU：{name}{usage}{vram}',
    gpuUsage: '（占用 {pct}{engine}）',
    gpuEngine: ' · {engine}',
    notDetected: '未识别',
    vram: '，显存 {pair}',
    capacityUnknown: '容量未知',
    temperature: '温度：{value}',
    temperatureUnavailable: '不可用（{reason}）',
    storage: '存储：{path} 已用 {usage}',
    sampled: '采样：{when}',
    skills: '技能库：共 {total} 个（模型可调用 {enabled}，仅手动 {userOnly}，已停用 {disabled}{invalid}）',
    invalidPart: '，其中 {n} 个无法解析',
    scanned: '扫描目录：{list}',
    root: '{path}（{source}，{count} 个）',
    noSkills: '本地还没有技能。',
    skillEnabled: '启用',
    skillManual: '仅手动（/名字 可调用）',
    skillOff: '停用',
    unparseable: '无法解析：{note}',
    readOnly: '只读',
    readFailed: '读取失败：{list}',
    dshCore: 'DSH 核心：{repo}（分支 {branch}）',
    latestCommit: '最新提交：{sha}  {message}（{author}，{date}）',
    latestCommitUnreadable: '最新提交：读不到',
    latestRelease: '最新发布：{name}（标签 {tag}，{publishedAt}）',
    latestReleaseUnreadable: '最新发布：读不到',
    routes: '取数路由：提交 {commits}，发布 {releases}，HEAD {head}',
    cached: '缓存：本次复用上一次的结果',
    status: '状态：{reason}{error}',
    runtime: '运行时：{agents} 个 agent（运行中 {running}，空闲 {idle}，顶层 {roots}），{sessions} 个会话',
    runtimeUnavailable: '运行时：不可用（{reason}）',
    projects: '项目：{total} 个（有改动 {dirty}，活跃 {live}，额外工作树 {worktrees}）',
    projectsUnavailable: '项目：不可用（{reason}）',
    notGit: '不是 git 仓库',
    gitFailed: 'git 读取失败',
    projectRow: '- {title}：{state}',
    projectState: '{branch}，{dirty} 处改动{ahead}{behind}',
    ahead: '，领先 {n}',
    behind: '，落后 {n}',
    moreProjects: '…还有 {n} 个项目',
    hygiene: '存储：{total}，{files} 个文件，可清理 {reclaimable}',
    hygieneUnavailable: '存储：不可用（{reason}）',
    hygieneRow: '- {id}：{bytes}（{files} 个文件）',
  },
}

/** @returns the copy table for a language, falling back to English. */
function copyFor(language) {
  return TOOL_COPY[language] || TOOL_COPY.en
}

/** Fill `{name}` placeholders; an unknown key keeps its braces visible. */
function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (
    values !== undefined && values[key] !== undefined ? String(values[key]) : match
  ))
}

/** @returns a compact text rendering of an overview document. */
function renderOverview(value, c) {
  const lines = []
  const wallet = value.wallets && value.wallets.length > 0 ? value.wallets : []
  if (wallet.length > 0) {
    lines.push(c.balance + ': ' + wallet.map((entry) => entry.currency + ' ' + entry.balance).join(' / '))
    if (value.bonusWallets && value.bonusWallets.length > 0) {
      lines.push(c.bonus + ': ' + value.bonusWallets.map((entry) => entry.currency + ' ' + entry.balance).join(' / '))
    }
  } else {
    lines.push(fill(c.balanceUnavailable, {
      reason: value.error ? value.error.message : 'account grant missing',
    }))
  }
  const today = value.today || {}
  lines.push(fill(c.today, {
    spend: today.spend || '0.00',
    currency: today.currency || '',
    open: today.open || '-',
    last: today.last || '-',
    samples: today.samples || 0,
    partial: today.partial ? c.partial : '',
  }))
  if (Array.isArray(value.history) && value.history.length > 1) {
    lines.push(fill(c.history, {
      n: value.history.length,
      series: value.history.slice(0, 7).map((day) => day.day.slice(5) + '=' + day.spend).join('  '),
    }))
  }
  return lines.join('\n')
}

/** @returns a compact text rendering of an environment document. */
function renderEnvironment(value, c) {
  const lines = [
    fill(c.platform, { platform: value.platform, arch: value.arch, node: value.node }),
    fill(c.cwd, { cwd: value.cwd }),
  ]
  const proxies = (value.proxies || []).filter((entry) => entry.kind === 'proxy')
  if (proxies.length === 0) {
    lines.push(c.noProxy)
  } else {
    lines.push(c.proxyHeader)
    for (const entry of proxies) {
      lines.push('  ' + entry.name + ' = ' + entry.masked)
      if (entry.raw !== entry.masked) lines.push(c.credentials)
    }
  }
  for (const entry of (value.proxies || []).filter((item) => item.kind === 'bypass')) {
    lines.push(fill(c.bypass, { name: entry.name, value: entry.raw }))
  }
  for (const entry of value.tls || []) lines.push(entry.name + ' = ' + entry.value)
  return lines.join('\n')
}

/** @returns a byte count as a short human string, base 1024. */
function humanBytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let count = Number(value) || 0
  let index = 0
  while (count >= 1024 && index < units.length - 1) {
    count = count / 1024
    index += 1
  }
  return count.toFixed(index === 0 || count >= 100 ? 0 : 1) + ' ' + units[index]
}

/** @returns a compact text rendering of a device document. */
function renderDevice(value, c) {
  const cpu = value.cpu || {}
  const memory = value.memory || {}
  const temperature = value.temperature || {}
  const gpu = value.gpu || {}
  const video = gpu.memory || {}
  const usage = (ratio) => Math.round((Number(ratio) || 0) * 100) + '%'
  const pair = (used, total) => Number(total) > 0
    ? humanBytes(used) + ' / ' + humanBytes(total)
    : c.capacityUnknown
  const lines = [
    fill(c.cpu, {
      usage: usage(cpu.usage),
      count: cpu.count || 0,
      model: cpu.model || c.unknownModel,
    }),
    fill(c.memory, {
      used: humanBytes(memory.used),
      total: humanBytes(memory.total),
      usage: usage(memory.usage),
    }),
  ]
  if (gpu.name || gpu.reason) {
    lines.push(fill(c.gpu, {
      name: gpu.name || c.notDetected,
      usage: gpu.usage === null || gpu.usage === undefined
        ? ''
        : fill(c.gpuUsage, {
          pct: usage(gpu.usage),
          engine: gpu.engine ? fill(c.gpuEngine, { engine: gpu.engine }) : '',
        }),
      vram: Number(video.total) > 0 ? fill(c.vram, { pair: pair(video.used, video.total) }) : '',
    }))
  }
  lines.push(fill(c.temperature, {
    value: typeof temperature.celsius === 'number'
      ? temperature.celsius.toFixed(1) + ' °C'
      : fill(c.temperatureUnavailable, { reason: temperature.reason || 'unknown' }),
  }))
  if (value.disk) lines.push(fill(c.storage, { path: value.disk.path, usage: usage(value.disk.usage) }))
  lines.push(fill(c.sampled, { when: new Date(value.at).toLocaleString() }))
  return lines.join('\n')
}

/**
 * Render the local Skill catalog for the model: how the library divides, then
 * one line per skill with the state it is in and where it came from. The state
 * is the part that matters to a caller — a skill the model cannot invoke is
 * still worth knowing about, and saying so is cheaper than a failed load.
 * @param value - the `skillList` document.
 * @param c - the copy table.
 * @returns a compact text rendering.
 */
function renderSkills(value, c) {
  const counts = value.counts || {}
  const roots = Array.isArray(value.roots) ? value.roots : []
  const lines = [
    fill(c.skills, {
      total: counts.total || 0,
      enabled: counts.enabled || 0,
      userOnly: counts.userOnly || 0,
      disabled: counts.disabled || 0,
      invalid: counts.invalid ? fill(c.invalidPart, { n: counts.invalid }) : '',
    }),
  ]
  const scanned = roots.filter((root) => root.exists !== false)
  if (scanned.length > 0) {
    lines.push(fill(c.scanned, {
      list: scanned
        .map((root) => fill(c.root, { path: root.path, source: root.source, count: root.count }))
        .join('; '),
    }))
  }
  const skills = Array.isArray(value.skills) ? value.skills : []
  if (skills.length === 0) {
    lines.push(c.noSkills)
    return lines.join('\n')
  }
  for (const skill of skills) {
    const state = skill.modelInvocable
      ? c.skillEnabled
      : skill.userInvocable ? c.skillManual : c.skillOff
    const extra = []
    if (skill.source) extra.push(String(skill.source))
    if (skill.note) extra.push(fill(c.unparseable, { note: String(skill.note) }))
    if (skill.writable === false) extra.push(c.readOnly)
    lines.push('  ' + skill.name + ': ' + state + (extra.length > 0 ? ' (' + extra.join(', ') + ')' : '')
      + (skill.description ? ' — ' + String(skill.description).slice(0, 120) : ''))
  }
  const warnings = Array.isArray(value.warnings) ? value.warnings : []
  if (warnings.length > 0) lines.push(fill(c.readFailed, { list: warnings.join('; ') }))
  return lines.join('\n')
}

/** @returns a compact text rendering of a DSH release document. */
function renderDsh(value, c) {
  const head = value.head
  const release = value.release
  const routes = value.routes || {}
  const lines = [fill(c.dshCore, { repo: value.repo || '', branch: value.branch || 'master' })]
  lines.push(head
    ? fill(c.latestCommit, {
      sha: head.short, message: head.message, author: head.author, date: head.date,
    })
    : c.latestCommitUnreadable)
  lines.push(release
    ? fill(c.latestRelease, { name: release.name, tag: release.tag, publishedAt: release.publishedAt })
    : c.latestReleaseUnreadable)
  lines.push(fill(c.routes, {
    commits: routes.commits || '—',
    releases: routes.releases || '—',
    head: routes.head || '—',
  }))
  if (value.cached) lines.push(c.cached)
  if (value.reason) {
    lines.push(fill(c.status, {
      reason: value.reason,
      error: value.error ? ' (' + value.error + ')' : '',
    }))
  }
  return lines.join('\n')
}

// ----------------------------------------------------------------- apply

// ----------------------------------------------------- shared read layer

/** The agent shape a degraded runtime summary still returns. */
function emptyRuntimeAgents() {
  return { total: 0, running: 0, idle: 0, roots: 0 }
}

/**
 * Summarise the live agent registry and the session count for the collector's
 * `runtime` item. Every service is optional: a host without an agent registry
 * answers `{ available: false, reason }` with the empty shape in place, so a
 * card renders the same document whether or not the service is mounted.
 * @param ctx - plugin context.
 * @returns `{ available, agents: { total, running, idle, roots }, sessions: { total }, at }`
 *   or the unavailable shape carrying a `reason`.
 */
function runtimeSummary(ctx) {
  const at = Date.now()
  const registry = service(ctx, 'agents')
  if (!registry || typeof registry.list !== 'function') {
    return {
      available: false,
      reason: 'agent registry is not available',
      agents: emptyRuntimeAgents(),
      sessions: { total: 0 },
      at,
    }
  }
  try {
    const live = registry.list() || []
    let running = 0
    for (const agent of live) if (agent && agent.status === 'running') running += 1
    // Roots are the top-level agents. A registry without `roots()` treats every
    // live agent as a root instead of dropping the field, because a card that
    // renders the count should always get one.
    let roots = live.length
    if (typeof registry.roots === 'function') {
      try { roots = (registry.roots() || []).length } catch (error) { void error }
    }
    // The session registry is the host's session count; without it the live
    // agents are the only sessions this host knows about.
    let sessionTotal = live.length
    const sessions = service(ctx, 'sessions')
    if (sessions && typeof sessions.list === 'function') {
      try { sessionTotal = (sessions.list() || []).length } catch (error) { void error }
    }
    return {
      available: true,
      agents: { total: live.length, running, idle: live.length - running, roots },
      sessions: { total: sessionTotal },
      at,
    }
  } catch (error) {
    return {
      available: false,
      reason: 'agent registry read failed: ' + messageOf(error),
      agents: emptyRuntimeAgents(),
      sessions: { total: 0 },
      at,
    }
  }
}

/**
 * Render the live runtime summary for the model.
 * @param value - the collector's `runtime` document.
 * @param c - the copy table.
 * @returns a compact text rendering.
 */
function renderRuntime(value, c) {
  if (!value || value.available === false) {
    return fill(c.runtimeUnavailable, {
      reason: value && value.reason ? value.reason : 'unknown',
    })
  }
  const agents = value.agents || {}
  const sessions = value.sessions || {}
  return fill(c.runtime, {
    agents: agents.total || 0,
    running: agents.running || 0,
    idle: agents.idle || 0,
    roots: agents.roots || 0,
    sessions: sessions.total || 0,
  })
}

/**
 * Render the project wall for the model.
 * @param value - the collector's `projects` document.
 * @param c - the copy table.
 * @returns a compact text rendering.
 */
function renderProjects(value, c) {
  if (!value || value.available === false) {
    return fill(c.projectsUnavailable, {
      reason: value && value.reason ? value.reason : 'unknown',
    })
  }
  const summary = value.summary || {}
  const lines = [fill(c.projects, {
    total: summary.total || 0,
    dirty: summary.dirty || 0,
    live: summary.live || 0,
    worktrees: summary.worktrees || 0,
  })]
  for (const project of (value.projects || []).slice(0, 8)) {
    const git = project.git
    let state = c.notGit
    if (git && git.repo === false) state = c.gitFailed
    else if (git) {
      state = fill(c.projectState, {
        branch: git.branch,
        dirty: git.dirty || 0,
        ahead: git.ahead ? fill(c.ahead, { n: git.ahead }) : '',
        behind: git.behind ? fill(c.behind, { n: git.behind }) : '',
      })
    }
    lines.push(fill(c.projectRow, { title: project.title || project.id || project.path, state }))
  }
  if ((value.projects || []).length > 8) {
    lines.push(fill(c.moreProjects, { n: (value.projects || []).length - 8 }))
  }
  return lines.join('\n')
}

/**
 * Render the storage inventory for the model.
 * @param value - the collector's `hygiene` document.
 * @param c - the copy table.
 * @returns a compact text rendering.
 */
function renderHygiene(value, c) {
  if (!value || value.available === false) {
    return fill(c.hygieneUnavailable, {
      reason: value && value.reason ? value.reason : 'unknown',
    })
  }
  const lines = [fill(c.hygiene, {
    total: humanBytes(value.totalBytes || 0),
    files: value.totalFiles || 0,
    reclaimable: humanBytes(value.reclaimableBytes || 0),
  })]
  for (const row of (value.categories || []).slice(0, 6)) {
    lines.push(fill(c.hygieneRow, {
      id: row.id,
      bytes: humanBytes(row.bytes || 0),
      files: row.files || 0,
    }))
  }
  return lines.join('\n')
}

/**
 * Read the project wall from the services the host actually has.
 * @param ctx - plugin context.
 * @returns {Promise<object>} the projects document; never rejects.
 */
function readProjects(ctx) {
  const registry = service(ctx, 'workspaceRegistry')
  const agents = service(ctx, 'agents')
  return createProjectsReader({
    // A missing registry is passed as absent, not as an empty list: the card
    // renders "not wired" instead of claiming this person has zero projects.
    registry: registry && typeof registry.list === 'function'
      ? { list: () => registry.list() }
      : null,
    agents: agents && typeof agents.list === 'function'
      ? { list: () => agents.list() }
      : null,
  }).sample()
}

/**
 * Mount the host half: local stores, the `homepage/*` Remote endpoints and
 * the model-facing tool.
 * @param ctx - plugin context with the tool registry.
 * @returns nothing; every disposable is owned by the plugin fiber.
 */
export function apply(ctx, config) {
  // The audit runner owns one review at a time: the card starts it, the review
  // session reports its verdict through the `report_plugin_audit` tool, and the
  // runner installs the plugin when the verdict allows it. Every engine service
  // is resolved per call, so an absent one disables that step with a visible
  // reason instead of breaking the whole plugin.
  const audits = createAuditRunner({
    agents: () => service(ctx, 'agents'),
    sessions: () => service(ctx, 'sessions'),
    // The review session needs a model: the profile's persona renders {{model}}
    // from `agent.options.model`, so a session created without a selection cannot
    // assemble its prompt (that was the first live failure of this card).
    defaultModel: () => service(ctx, 'agentDefaultModel'),
    llm: () => service(ctx, 'llm'),
    permissions: () => service(ctx, 'permissionPresets'),
    title: () => service(ctx, 'sessionTitle'),
    on: (event, handler) => ctx.on(event, handler),
    // The review session only ever sees this frozen, allowlisted snapshot.
    prepareSource: (target, options) => prepareSource(target, options),
    install: (spec, options) => installBundle(ctx, spec, options),
    runtimeVersion: () => runtimeVersion(),
    // The review record is the host's: it is written here and read back before the
    // first answer, so the card's history survives a reload or a restart.
    store: {
      read: () => readAuditHistory(),
      write: (records) => writeAuditHistory(records),
    },
    cwd: async () => {
      const dir = auditWorkspaceDir()
      await mkdir(dir, { recursive: true, mode: 0o700 })
      return dir
    },
  })
  // Seed the guard with sessions restored from the audit history before the
  // sidebar can hand one of them to the user; a lazy load would leave a small
  // window where a restored audit session was not yet recognized.
  void audits.list().catch(() => {})
  // The shared read layer: one cache in front of the host reads a card asks for
  // repeatedly, so ten cards polling `runtime` cost one registry read per TTL
  // instead of ten. The loader resolves its services per call and degrades to a
  // structured document, never to a throw — a missing registry is a rendering
  // fact for the card, not a failure of the panel.
  const collector = createCollector({ logger: ctx.logger })
  // The home root is resolved per call inside the scanner, so this instance
  // follows `DSH_HOME` the way the rest of the plugin does.
  const hygiene = createHygiene()
  // Tool usage is folded out of the session event logs themselves: nothing in
  // the core keeps a per-tool counter, so this module owns an incremental index
  // beside the ledger and advances it one pass at a time.
  const toolUsage = createToolUsage({
    root: storageRoot(),
    sessions: () => service(ctx, 'sessions'),
    sessionPersistence: () => service(ctx, 'sessionPersistence'),
  })
  collector.define('runtime', {
    ttlMs: 5000,
    events: ['agent/created', 'agent/disposed', 'agent/status'],
    load: () => runtimeSummary(ctx),
  })
  // The project wall is three git queries per repository; a short TTL keeps the
  // card's 30-second poll from paying for them twice, while a refresh click
  // still lands on a fresh sample soon enough.
  collector.define('projects', {
    ttlMs: 15000,
    load: () => readProjects(ctx),
  })
  // The storage inventory is much more expensive and changes slowly. Its one
  // action invalidates the item so the post-cleanup reload measures the result.
  collector.define('hygiene', {
    ttlMs: 120000,
    load: () => hygiene.sample(),
  })
  // Folding a pass over the session logs is the heaviest read on the wall, and
  // the underlying counts move slowly: a minute of TTL costs the card nothing
  // and keeps a re-render from re-reading every stored session.
  collector.define('toolUsage', {
    ttlMs: 60000,
    load: () => toolUsage.sample(),
  })
  // Agent lifecycle events expire the runtime item early. A context without an
  // event bus (a test mount) binds nothing and the TTL still expires the cache,
  // so events are an optimisation and never a requirement.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => collector.bind(ctx), name + ': collector bindings')
  } else {
    collector.bind(ctx)
  }
  // The action layer: the write side a card reaches through `homepage/act`.
  // Every refusal is a structured result, so a card renders `{ ok: false }`
  // instead of unwinding through React.
  const actions = createActions({ logger: ctx.logger, context: ctx })
  actions.register('session.stop', {
    /**
     * Stop one live session on the user's behalf.
     * @param payload - `{ sessionId }`.
     * @param actionContext - the plugin context captured when the layer was created.
     * @returns `{ stopped: true }`, or `{ stopped: false, reason }` when there is
     *   no live handle to stop.
     */
    run(payload, actionContext) {
      const request = payload !== null && typeof payload === 'object' ? payload : {}
      const sessionId = request.sessionId === undefined || request.sessionId === null
        ? ''
        : String(request.sessionId).trim()
      if (sessionId === '') return { stopped: false, reason: 'no_session' }
      const registry = service(actionContext || ctx, 'agents')
      if (!registry || typeof registry.get !== 'function') {
        return { stopped: false, reason: 'agents_unavailable' }
      }
      const handle = registry.get(sessionId)
      if (!handle || typeof handle.cancel !== 'function') return { stopped: false, reason: 'not_live' }
      // The engine's own user-initiated stop keeps queued input: the sidebar's
      // Stop button calls `cancel({ kind: 'user' }, { keepInbox: true })`, and
      // this card must not discard a follow-up the person already sent.
      handle.cancel({ kind: 'user' }, { keepInbox: true })
      return { stopped: true }
    },
  })
  actions.register('hygiene.logs.prune', {
    /**
     * Delete old `.log` files below `<DSH_HOME>/logs` and expire the inventory.
     * @param payload - `{ olderThanDays }`; the scanner validates 1..3650.
     * @returns `{ removed, bytes, failed }`.
     */
    async run(payload) {
      try {
        const value = await hygiene.pruneLogs(payload)
        collector.invalidate('hygiene')
        return value
      } catch (error) {
        // A refused window changed nothing, but a partially failed delete may
        // have removed files; expire the reading either way.
        collector.invalidate('hygiene')
        throw error
      }
    },
  })
  const api = {
    /**
     * Read today's spend, the current balance and the recorded history.
     * @param options - `force` and `historyDays`.
     * @returns the overview document.
     */
    async overview(options) {
      try { return await overview(ctx, options || {}) }
      catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Re-read the balance immediately, bypassing the sampling interval.
     * @returns the overview document.
     */
    async refresh() {
      try { return await overview(ctx, { force: true }) }
      catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Read the proxy-related process environment.
     * @returns the environment document.
     */
    async environment() {
      try { return environment() }
      catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Read this machine's performance counters — processor, memory, storage,
     * temperature — plus the recent history the card charts.
     * @returns the device document.
     */
    async device() {
      try { return await sampleDevice() }
      catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Read the DSH release document: the newest commit on the default branch,
     * the newest published release, and which route answered.
     * @param options - `force` bypasses the sampling TTL.
     * @returns the release document.
     */
    async dsh() {
      try { return await sampleDshRelease({}) }
      catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Re-read the release document now, bypassing the sampling TTL.
     * @returns the release document.
     */
    async dshCheck() {
      try { return await sampleDshRelease({ force: true }) }
      catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Which DSH cores are already unpacked under a directory.
     *
     * An empty `root` means "the one this core was started from": the Host
     * resolves it from `DSH_INSTALL_ROOT` or the running core's own launch
     * path, and answers the resolved path so the card can show what it scanned.
     * Nothing is guessed when the running core does not sit in a core
     * directory - the answer stays `''` and the card asks the user.
     * @param options - `{ root }`.
     * @returns `{ root, running, versions, install }`.
     */
    async dshLocal(options) {
      try {
        const asked = options && typeof options.root === 'string' ? options.root.trim() : ''
        const root = asked !== '' ? asked : defaultInstallRoot()
        const scanned = root === '' ? [] : await listInstalled(root)
        // A packaged Desktop core does not sit under an install root and is not
        // a git checkout, so it is reported from the build version the launcher
        // passes to the Host. A local build has no such variable and is
        // unaffected; both can be listed together when a root is also set.
        const desktop = desktopCore()
        return {
          root: root,
          // The card uses this to mark which entry is the one actually running,
          // instead of calling the newest directory on disk "current".
          running: desktop === null ? defaultRunningCore() : '',
          versions: desktop === null ? scanned : [desktop].concat(scanned),
          // How this DSH was installed. The card cannot work it out from the
          // listing alone: a Desktop and a community wrapper both show no core
          // directory, and offering either of them a one-click upgrade from
          // GitHub is what turned a normal install into a red error state.
          install: { kind: installKind(), version: desktop === null ? null : desktop.version },
        }
      } catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Start installing one DSH core version into the configured directory, in
     * its own detached terminal window so this process is never blocked.
     * @param options - `{ root, version, ref }`.
     * @returns the launch result.
     */
    async dshInstall(options) {
      try {
        const input = { ...(options || {}) }
        if (typeof input.root !== 'string' || input.root.trim() === '') {
          input.root = defaultInstallRoot()
        }
        // The directory is typed by the user, so it may not exist yet — and the
        // generated script opens with `cd <root>`, which a missing directory
        // turns into an install that dies before the clone. Making it here is
        // what the card promises: new versions are cloned into this directory.
        if (typeof input.root === 'string' && input.root.trim() !== '') {
          await mkdir(input.root, { recursive: true })
        }
        return await startInstall(input)
      }
      catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Read the persisted UI state.
     * @returns the state document.
     */
    async state() {
      try { return await loadState() }
      catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Persist a UI state patch.
     * @param patch - partial state.
     * @returns the persisted state.
     */
    async saveState(patch) {
      try { return await saveState(patch) }
      catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Read the sidebar workspace-group layout.
     * @returns `{ layout, at }` — the normalised document plus its write time.
     */
    async sidebarLayout() {
      try { return await sidebarStore().read() }
      catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Persist a sidebar workspace-group layout. The browser half always sends the
     * whole document, so this is a replace-after-normalise rather than a deep
     * merge: a group the client deleted cannot survive in the file.
     * @param layout - the layout document.
     * @returns `{ layout, at }`.
     */
    async saveSidebarLayout(layout) {
      try { return await sidebarStore().write(layout) }
      catch (error) { throw new Error(remoteError(error)) }
    },
    /** @returns available audit models, reasoning efforts and the profile default selection. */
    async pluginAuditModels() {
      try { return await audits.models() }
      catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Open a security review of one plugin: resolve the target, create the
     * review session, hand it the prompt. The verdict arrives later, through the
     * `report_plugin_audit` tool, so the caller polls `pluginAuditStatus`.
     * @param options - `{ target, mode, prompt, selection }`; selection is `{ provider, model, reasoningEffort? }`.
     * @returns the audit in the endpoint shape.
     */
    async pluginAuditStart(options) {
      try { return await audits.start(options || {}) }
      catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Read one audit, or the newest one when no id is given.
     * @param options - `{ auditId }`.
     * @returns the audit in the endpoint shape, or null.
     */
    async pluginAuditStatus(options) {
      try { return await audits.status(options || {}) }
      catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Every audit this profile has run, newest first — including the ones a
     * previous process saved, which is what makes the card's history a record
     * rather than a view of the current run.
     * @returns `{ audits }`.
     */
    async pluginAuditList() {
      try { return await audits.list() }
      catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Answer a verdict: install it, or decline it. This is also how a
     * `review`-only audit is installed, once the user has read the verdict.
     * @param options - `{ auditId, decision, override }`.
     * @returns the audit in the endpoint shape.
     */
    async pluginAuditDecide(options) {
      try { return await audits.decide(options || {}) }
      catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Read the local Skill library: every scanned root, the effective catalog
     * (one winning entry per name), the duplicate list and the counts the
     * preview draws.
     * @param options - `{ cwd }`, a session working directory for project roots.
     * @returns the skill document.
     */
    async skillList(options) {
      try { return await skillStore(cwdOf(options)).list({}) }
      catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Flip one local Skill's invocation switches by editing its frontmatter —
     * the standard `disable-model-invocation` / `user-invocable` fields, so the
     * change is what every other client of this skill reads too.
     * @param options - `{ name, mode, cwd }`; mode is `off`, `model-off` or `on`.
     * @returns the `skillSetEnabled` document.
     */
    async skillSetEnabled(options) {
      try {
        const input = options || {}
        const cwd = cwdOf(input)
        return await skillStore(cwd).setEnabled({
          name: input.name,
          mode: input.mode,
          ...(cwd === null ? {} : { cwd: cwd }),
        })
      } catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Which external Skill sources this card can search, and whether each one
     * answers right now.
     * @returns the source document.
     */
    async skillSources() {
      try {
        const sources = await skillSources()
        return await sources.sources()
      } catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Read one local Skill's actual content: the body the model would be handed,
     * the frontmatter as labelled rows, and the resource files beside it.
     * @param options - `{ name, cwd? }`.
     * @returns the `skillContent` document.
     */
    async skillContent(options) {
      try {
        const input = options || {}
        const cwd = cwdOf(input)
        return await skillStore(cwd).read({
          name: input.name,
          ...(cwd === null ? {} : { cwd: cwd }),
        })
      } catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Search the external Skill sources.
     * @param options - `{ query, source, limit }`.
     * @returns the search document.
     */
    async skillSearch(options) {
      try {
        const input = options || {}
        const sources = await skillSources()
        return await sources.search({ query: input.query, source: input.source, limit: input.limit })
      } catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Read one external Skill's package listing and body.
     * @param options - `{ id, source, ref }`.
     * @returns the detail document.
     */
    async skillDetail(options) {
      try {
        const input = options || {}
        const sources = await skillSources()
        return await sources.detail({ id: input.id, source: input.source, ref: input.ref })
      } catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Install one external Skill into a local root. The destination is named,
     * not pathed: the host resolves which directory that is, so the browser can
     * never name a directory of its own.
     * @param options - `{ id, source, ref, destination, force }`.
     * @returns the install document.
     */
    async skillInstall(options) {
      try {
        const input = options || {}
        const sources = await skillSources()
        const destination = input.destination === 'user-agents' ? 'user-agents' : 'user-dsh'
        const result = await sources.install({
          id: input.id,
          source: input.source,
          ref: input.ref,
          destination: destination,
          root: installRoot(destination),
          force: input.force === true,
        })
        // The install lands a file; whether the harness can USE it is a separate
        // fact, and only a fresh catalog read answers it. So the endpoint finishes
        // by asking the local half what it now sees, and the card shows the skill
        // it actually got instead of the package it asked for.
        const store = skillStore(null)
        const catalog = await store.list({})
        return {
          ...result,
          skill: catalog.skills.find((skill) => skill.name === result.name) || null,
          counts: catalog.counts,
          warnings: catalog.warnings,
        }
      } catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Read the project wall: registry records plus each repository's git state.
     * @param options - `{ force }`; force re-runs the git probes.
     * @returns the projects document the card renders.
     */
    async projects(options) {
      const input = options !== null && typeof options === 'object' ? options : {}
      try {
        const entry = await collector.read('projects', input.force === true ? { force: true } : {})
        return entry.value
      } catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Read the DSH home inventory.
     * @param options - `{ force }`; force re-scans the tree.
     * @returns the hygiene document the card renders.
     */
    async hygiene(options) {
      const input = options !== null && typeof options === 'object' ? options : {}
      try {
        const entry = await collector.read('hygiene', input.force === true ? { force: true } : {})
        return entry.value
      } catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Read the accumulated tool usage: per-tool call counts, the size of the
     * arguments each tool was called with and of the output it returned, and
     * the same readings split by project (a session's working directory).
     * @param options - `{ force }`; force folds a fresh pass over the logs.
     * @returns the tool-usage document the card renders.
     */
    async toolUsage(options) {
      const input = options !== null && typeof options === 'object' ? options : {}
      try {
        const entry = await collector.read('toolUsage', input.force === true ? { force: true } : {})
        return entry.value
      } catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Read the shared collector — the read half of the collector layer.
     * @param options - `{ names, force }`; no names reads every item.
     * @returns `{ at, entries }`; one failing item never hides the others.
     */
    async collect(options) {
      const input = options !== null && typeof options === 'object' ? options : {}
      try {
        const names = Array.isArray(input.names)
          ? input.names
          : typeof input.names === 'string' ? [input.names] : undefined
        return await collector.snapshot(names, input.force ? { force: true } : {})
      } catch (error) { throw new Error(remoteError(error)) }
    },
    /**
     * Run one registered action — the write half of the action layer.
     * @param options - `{ action, payload }`.
     * @returns `{ ok: true, action, value }` or `{ ok: false, action, error }`;
     *   a missing action id is a refusal too, never a throw.
     */
    async act(options) {
      const input = options !== null && typeof options === 'object' ? options : {}
      try {
        const id = input.action === undefined || input.action === null ? '' : String(input.action).trim()
        if (id === '') return { ok: false, action: '', error: 'act: an action id is required' }
        return await actions.run(id, input.payload)
      } catch (error) { throw new Error(remoteError(error)) }
    },
  }
  Object.defineProperty(api, 'typertRemote', {
    value: Object.freeze({ service: api, serviceKey: NAMESPACE, namespace: NAMESPACE }),
  })

  const remoteParam = (parameter) => ({ name: parameter, wire: parameter, source: 'json', codec: { mode: 'src-json' } })
  const remoteInvocation = (method, parameters) => ({
    id: name + '#homepage/' + method,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method: method,
    invocation: { kind: 'direct' },
    parameters: parameters.map(remoteParam),
    result: { mode: 'src-json' },
  })
  const REMOTE_CONTRIBUTION = {
    package: name,
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      remoteInvocation('overview', ['options']),
      remoteInvocation('refresh', []),
      remoteInvocation('environment', []),
      remoteInvocation('device', []),
      remoteInvocation('dsh', []),
      remoteInvocation('dshCheck', []),
      remoteInvocation('dshLocal', ['options']),
      remoteInvocation('dshInstall', ['options']),
      remoteInvocation('state', []),
      remoteInvocation('saveState', ['patch']),
      remoteInvocation('sidebarLayout', []),
      remoteInvocation('saveSidebarLayout', ['layout']),
      remoteInvocation('pluginAuditStart', ['options']),
      remoteInvocation('pluginAuditModels', ['options']),
      remoteInvocation('pluginAuditStatus', ['options']),
      remoteInvocation('pluginAuditList', []),
      remoteInvocation('pluginAuditDecide', ['options']),
      remoteInvocation('skillList', ['options']),
      remoteInvocation('skillSetEnabled', ['options']),
      remoteInvocation('skillContent', ['options']),
      // `skillsSources` takes the same one options object as its five siblings,
      // even though it needs nothing from it: the gateway compares the argument
      // field names exactly, and the other sessionless endpoints here are all
      // called with the envelope the client already builds.
      remoteInvocation('skillSources', ['options']),
      remoteInvocation('skillSearch', ['options']),
      remoteInvocation('skillDetail', ['options']),
      remoteInvocation('skillInstall', ['options']),
      // The project and hygiene readers. Each takes the same one options object
      // as every other sessionless endpoint.
      remoteInvocation('projects', ['options']),
      remoteInvocation('hygiene', ['options']),
      // Tool usage is folded from the session logs into its own incremental
      // index; the card reads it through this one endpoint.
      remoteInvocation('toolUsage', ['options']),
      // The collector and action layers. Same single-options-object discipline
      // as the rest: the gateway compares argument field names exactly, and the
      // client passes `{ options }` for both.
      remoteInvocation('collect', ['options']),
      remoteInvocation('act', ['options']),
    ],
  }

  ctx.provide(NAMESPACE, api)
  ctx.inject(['typert'], (typert) => typert.typert.register(REMOTE_CONTRIBUTION))

  // Without the schema library there is no config form, so the opt-in switch
  // would be unreachable. Say so once instead of failing silently: the tool
  // simply stays off.
  if (schema === null && ctx.logger && typeof ctx.logger.warn === 'function') {
    ctx.logger.warn('dsh-homepage: @deepseek-ai/schemastery is unavailable, so the Plugins settings page cannot show the tool switch')
  }

  const tools = service(ctx, 'tools')
  if (tools && typeof tools.register === 'function') {
    // The model-facing tool is opt-in. An unregistered tool costs no context and
    // exposes no machine data; `exposeTool` flips it in place on a volatile
    // config edit, without remounting the plugin.
    const toolDefinition = () => ({
      name: 'homepage',
      description: TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          section: {
            type: 'string',
            enum: ['overview', 'environment', 'device', 'dsh', 'skills', 'projects', 'hygiene', 'runtime', 'all'],
            description: 'Which part of the personal home page to read. Defaults to all.',
          },
          refresh: {
            type: 'boolean',
            description: 'When true, re-read the account balance instead of using the sampled value.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            spend: { type: 'string' },
            currency: { type: 'string' },
            proxyCount: { type: 'integer' },
            device: { type: 'string' },
            dsh: { type: 'string' },
            skills: { type: 'string' },
            projects: { type: 'string' },
            hygiene: { type: 'string' },
            runtime: { type: 'string' },
          },
          required: ['text', 'spend', 'currency', 'proxyCount', 'device', 'dsh', 'skills', 'projects', 'hygiene', 'runtime'],
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        const input = args && typeof args === 'object' ? args : {}
        const section = typeof input.section === 'string' ? input.section : 'all'
        const copy = copyFor(toolLanguage(ctx, config))
        const wantOverview = section === 'overview' || section === 'all'
        const wantEnvironment = section === 'environment' || section === 'all'
        const wantDevice = section === 'device' || section === 'all'
        const wantDsh = section === 'dsh' || section === 'all'
        const wantSkills = section === 'skills' || section === 'all'
        const wantProjects = section === 'projects' || section === 'all'
        const wantHygiene = section === 'hygiene' || section === 'all'
        const wantRuntime = section === 'runtime' || section === 'all'
        const parts = []
        let spend = '0.00'
        let currency = ''
        let proxyCount = 0
        let device = ''
        let dsh = ''
        let skills = ''
        let projects = ''
        let hygiene = ''
        let runtime = ''
        if (wantOverview) {
          const value = await overview(ctx, { force: input.refresh === true })
          spend = (value.today && value.today.spend) || '0.00'
          currency = value.currency || ''
          parts.push(renderOverview(value, copy))
        }
        if (wantEnvironment) {
          const value = environment()
          proxyCount = value.proxyCount
          parts.push(renderEnvironment(value, copy))
        }
        if (wantDevice) {
          const value = await sampleDevice()
          device = renderDevice(value, copy)
          parts.push(device)
        }
        if (wantDsh) {
          const value = await sampleDshRelease()
          dsh = renderDsh(value, copy)
          parts.push(dsh)
        }
        if (wantSkills) {
          // A section read that cannot reach the library still answers with a
          // sentence: an empty string would read as "no skills installed",
          // which is a different claim from "the read failed".
          try {
            skills = renderSkills(await skillStore(null).list({}), copy)
          } catch (error) {
            skills = '技能库：读取失败（' + messageOf(error) + '）'
          }
          parts.push(skills)
        }
        if (wantProjects) {
          // The same collector item the card reads, so the tool and the card
          // cannot disagree about which project is dirty.
          const value = await collector.read('projects')
          projects = renderProjects(value.value, copy)
          parts.push(projects)
        }
        if (wantHygiene) {
          const value = await collector.read('hygiene')
          hygiene = renderHygiene(value.value, copy)
          parts.push(hygiene)
        }
        if (wantRuntime) {
          // The same item the collector card reads, so the tool and the card
          // cannot disagree about what the host is running.
          const value = await collector.read('runtime')
          runtime = renderRuntime(value.value, copy)
          parts.push(runtime)
        }
        return {
          text: parts.join('\n\n'),
          spend: spend,
          currency: currency,
          proxyCount: proxyCount,
          device: device,
          dsh: dsh,
          skills: skills,
          projects: projects,
          hygiene: hygiene,
          runtime: runtime,
        }
      },
    })

    let disposeTool = null
    const syncTool = () => {
      const wanted = configValue(config, 'exposeTool', false) === true
      if (wanted && disposeTool === null) {
        const dispose = tools.register(toolDefinition())
        // A registry that answers with a disposer is the contract; anything else
        // still leaves the tool registered rather than crashing the apply.
        disposeTool = typeof dispose === 'function' ? dispose : () => {}
      } else if (!wanted && disposeTool !== null) {
        disposeTool()
        disposeTool = null
      }
    }
    syncTool()
    if (typeof ctx.on === 'function') {
      ctx.on('loader/volatile-update', (paths) => {
        const touched = !Array.isArray(paths) || paths.some((path) => (
          Array.isArray(path) && (path[0] === 'exposeTool' || path[0] === 'toolLanguage')
        ))
        if (touched) syncTool()
      })
    }
    ctx.effect(() => () => {
      if (disposeTool !== null) { disposeTool(); disposeTool = null }
    })

    // The audit card's verdict channel: the review session calls this tool with
    // what it found, and the runner compares the calling agent's session with the
    // audit's, so one session cannot report another one's audit.
    tools.register(audits.tool())

    // The session's own source tools are scope-local; this guard is the execution
    // boundary for every other tool, including one another plugin registers after
    // the audit session was set up. It only answers for audit Agents.
    if (typeof tools.guard === 'function') {
      try {
        const disposeGuard = tools.guard(audits.guard)
        if (typeof disposeGuard === 'function') ctx.effect(() => () => disposeGuard())
      } catch (error) {
        if (ctx.logger && typeof ctx.logger.warn === 'function') {
          ctx.logger.warn('dsh-homepage: the audit tool guard could not be installed: ' + String(error && error.message ? error.message : error))
        }
      }
    }
  }

  // No background sampling lives past this point. The account ledger and the
  // device history are filled only by an on-demand read (an open card or the
  // model-facing tool), so an installed-but-unused plugin runs nothing: no
  // Platform requests, no subprocesses, no timers. Disabled cards never mount,
  // so they never call an endpoint either.
}

/** @returns one error carrying the plugin's own prefix, without doubling it. */
function remoteError(error) {
  return REMOTE_PREFIX + ': ' + messageOf(error).replace(new RegExp('^' + REMOTE_PREFIX + ':\\s*'), '')
}

export default { name, inject, apply, Config }
