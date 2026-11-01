/**
 * session-card: the Sessions card's OWN behavioural coverage.
 *
 * `test/smoke-client.mjs` proves the framework contract around a card — that it
 * registers, that its preview draws on the wall, that its dictionary is
 * balanced. This file is the Sessions card's own test. It renders both entry
 * points through the same mini-React shim the house harness uses, drives every
 * control a person can touch, and asserts what reached the host and what came
 * back on screen.
 *
 * Two things are deliberately NOT here:
 *
 *   - a real DSH session service. `api.sessionStatus` / `api.sessionList` are
 *     plain values the host hands the card on every render, so a fixture is a
 *     complete stand-in; and
 *   - any polling. The card never asks for a timer, so the test would have
 *     nothing to advance.
 *
 * The bundle is loaded the way the browser loads it — `lib/client.js` is read as
 * TEXT and evaluated with `new Function(source)()` — because it legitimately
 * names `module`/`exports` and Node's module-format detection would mangle it.
 * The React object is the harness's own shim; the UI primitives come from
 * test/ui-primitives-stub.mjs, so there is no installed 'react' to import.
 *
 * Run: node test/session-card.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createUiPrimitives } from './ui-primitives-stub.mjs'

// ---------------------------------------------------------------- counting

let checks = 0
const ok = (value, message) => { checks += 1; assert.ok(value, message) }
const is = (actual, expected, message) => { checks += 1; assert.equal(actual, expected, message) }
const same = (actual, expected, message) => { checks += 1; assert.deepEqual(actual, expected, message) }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------------------ React shim
//
// Function components run eagerly, hooks live in per-path slots, and `settle`
// renders until no state update is pending. A render root is passed in so the
// preview and the expanded page (and each scenario) mount independently.

const Fragment = Symbol('Fragment')
const instances = new Map()

let current = null
let queuedEffects = []
let rerenderRequested = false

function sameDeps(a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) if (!Object.is(a[index], b[index])) return false
  return true
}

function flatten(items, out) {
  for (const item of items) {
    if (Array.isArray(item)) flatten(item, out)
    else if (item !== null && item !== undefined && item !== false && item !== true) out.push(item)
  }
  return out
}

function slotOf() {
  const instance = current
  const index = instance.cursor
  instance.cursor += 1
  if (!instance.hooks[index]) instance.hooks[index] = { set: false, deps: undefined, value: undefined, cleanup: undefined }
  return instance.hooks[index]
}

function createElement(type, props) {
  const children = Array.prototype.slice.call(arguments, 2)
  const merged = Object.assign({}, props || {})
  if (children.length === 1) merged.children = children[0]
  else if (children.length > 1) merged.children = children

  if (typeof type === 'string') {
    if (Array.isArray(merged.children)) merged.children = flatten(merged.children, [])
    return { tag: type, props: merged }
  }
  if (type === Fragment) return { tag: 'fragment', props: merged }

  const parent = current
  parent.childCount += 1
  const path = parent.path + '/' + parent.childCount
  let instance = instances.get(path)
  if (!instance || instance.type !== type) {
    instance = { path, type, hooks: [], cursor: 0, childCount: 0 }
    instances.set(path, instance)
  }
  const previous = current
  current = instance
  instance.cursor = 0
  instance.childCount = 0
  try {
    return type(merged)
  } finally {
    current = previous
  }
}

const React = {
  createElement,
  Fragment,
  useState(initial) {
    const slot = slotOf()
    if (!slot.set) {
      slot.value = typeof initial === 'function' ? initial() : initial
      slot.set = true
    }
    const set = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (Object.is(value, slot.value)) return
      slot.value = value
      rerenderRequested = true
    }
    return [slot.value, set]
  },
  useRef(initial) {
    const slot = slotOf()
    if (!slot.set) {
      slot.value = { current: initial }
      slot.set = true
    }
    return slot.value
  },
  useEffect(fn, deps) {
    const slot = slotOf()
    if (slot.set && sameDeps(slot.deps, deps)) return
    slot.set = true
    slot.deps = deps
    queuedEffects.push({ slot, fn })
  },
  useCallback(fn, deps) {
    const slot = slotOf()
    if (!slot.set || !sameDeps(slot.deps, deps)) {
      slot.value = fn
      slot.deps = deps
      slot.set = true
    }
    return slot.value
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    const slot = slotOf()
    if (!slot.set) {
      slot.set = true
      queuedEffects.push({ slot, fn: () => subscribe(() => { rerenderRequested = true }) })
    }
    return getSnapshot()
  },
}

// ------------------------------------------------------- platform module shims

const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const UI_PRIMITIVES = createUiPrimitives(React)

const jsx = (type, props, key) => createElement(
  type,
  key === undefined ? props : Object.assign({}, props, { key }),
)

const PLATFORM_SHIMS = new Map([
  ['react', () => React],
  ['react/jsx-runtime', () => ({ Fragment, jsx, jsxs: jsx, jsxDEV: jsx })],
  ['react-dom', () => ({ createPortal: (children) => children, flushSync: (fn) => fn() })],
  ['react-dom/client', () => ({
    createRoot() { throw new Error('test/session-card.mjs has no DOM root: the bundle is evaluated, not mounted') },
    hydrateRoot() { throw new Error('test/session-card.mjs has no DOM root: the bundle is evaluated, not mounted') },
  })],
  ['@deepseek-ai/dsh-client-ui-primitives', () => UI_PRIMITIVES],
])

const platformCache = new Map()

function platformModule(id) {
  if (typeof id !== 'string' || !PLATFORM_MODULES.includes(id)) {
    assert.fail(
      'the client half may only require a module from the DSH platform table, but required '
      + JSON.stringify(id) + '; allowed: ' + PLATFORM_MODULES.join(', '),
    )
  }
  if (!PLATFORM_SHIMS.has(id)) {
    assert.fail('this harness has no stand-in for the DSH platform module ' + JSON.stringify(id) + ' yet')
  }
  if (!platformCache.has(id)) platformCache.set(id, PLATFORM_SHIMS.get(id)())
  return platformCache.get(id)
}

// ------------------------------------------------------------------ rendering

function renderOnce(renderer, props, root) {
  rerenderRequested = false
  current = root
  root.cursor = 0
  root.childCount = 0
  queuedEffects = []
  const tree = renderer(props)
  const draining = queuedEffects
  queuedEffects = []
  for (const entry of draining) {
    if (typeof entry.slot.cleanup === 'function') entry.slot.cleanup()
    const cleanup = entry.fn()
    entry.slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
  }
  return tree
}

/** Render until no state update is pending, then return the settled tree. */
async function settle(renderer, props, root) {
  let tree = renderOnce(renderer, props, root)
  for (let pass = 0; pass < 16; pass += 1) {
    await sleep(15)
    if (!rerenderRequested) break
    tree = renderOnce(renderer, props, root)
  }
  return tree
}

let stageSeq = 0
function stage(component) {
  stageSeq += 1
  const root = { path: 'mount-' + stageSeq, hooks: [], cursor: 0, childCount: 0 }
  return {
    root,
    async render(props) { return settle(component, props, root) },
  }
}

// ------------------------------------------------------------------ tree utils

function elements(tree) {
  const out = []
  const visit = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (typeof node === 'object' && typeof node.tag === 'string') {
      out.push(node)
      visit(node.props.children)
    }
  }
  visit(tree)
  return out
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && typeof node.tag === 'string') return textOf(node.props.children)
  if (typeof node === 'object') return ''
  return String(node)
}

function hasClass(node, name) {
  return String(node.props.className || '').split(/\s+/).includes(name)
}

const byClass = (tree, name) => elements(tree).filter((node) => hasClass(node, name))
const text = (tree) => textOf(tree)
const buttonLikes = (tree) => elements(tree).filter((node) => node.tag === 'button')

// ----------------------------------------------------------- environment shim

let bundleSpec = null
globalThis.window = {
  __ModuleLoader__: { load(spec) { bundleSpec = spec } },
  addEventListener() {},
  removeEventListener() {},
}
globalThis.document = {
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
  createElement: (tagName) => ({
    tagName: String(tagName).toUpperCase(),
    style: {},
    attributes: {},
    textContent: '',
    setAttribute(name, value) { this.attributes[name] = String(value) },
    select() {},
    appendChild() {},
    remove() {},
  }),
  head: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
  execCommand: () => true,
}
if (!globalThis.navigator) globalThis.navigator = { clipboard: null }

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.notEqual(source.charCodeAt(0), 0xfeff, 'the bundle must not start with a UTF-8 BOM')
new Function(source)()

ok(bundleSpec, 'client bundle must call window.__ModuleLoader__.load')
const module_ = bundleSpec.factory(platformModule)

// ------------------------------------------------------------ host descriptors
//
// Every `homepage/*` endpoint takes the one `options` argument; the live
// gateway refuses a call whose args names another field. The host half in this
// worktree may still be the pre-bridge one (the sessions card ships against the
// contract, not against the merged host), so the descriptor check is conditional
// and the call shape itself is asserted from the fake transport below.

const DESCRIPTOR_PARAMS = await (async () => {
  const host = await import('../lib/index.js')
  let contribution = null
  host.apply({
    get(name) {
      if (name === 'timer') return { timeout: () => () => {}, interval: () => () => {} }
      return undefined
    },
    provide() { return () => {} },
    effect() { return () => {} },
    inject(deps, callback) {
      callback({ typert: { register: (value) => { contribution = value; return () => {} } } })
      return () => {}
    },
  })
  const table = {}
  for (const invocation of (contribution && contribution.invocations) || []) {
    table[invocation.id.replace(host.name + '#homepage/', 'homepage/')] =
      invocation.parameters.map((parameter) => parameter.name)
  }
  return table
})()

const ACT_ENDPOINT = 'homepage/act'
if (DESCRIPTOR_PARAMS[ACT_ENDPOINT]) {
  same((DESCRIPTOR_PARAMS[ACT_ENDPOINT] || []).slice().sort(), ['options'],
    ACT_ENDPOINT + ' must declare the one options object the card sends')
} else {
  console.log('note: homepage/act is not in this worktree\'s host descriptors yet (the bridge lands separately)')
}

// ------------------------------------------------------------------- fixtures

// The card renders `updatedAt` against the real clock (it owns no clock of its
// own), so the fixtures are relative to now rather than pinned to a date.
const NOW = Date.now()
const MINUTE = 60000
const HOUR = 3600000

const STATUS = new Map([
  ['s-wait', { running: true, pendingInteraction: 'approval', completionUnread: false }],
  ['s-run-new', { running: true, completionUnread: false }],
  ['s-run-old', { running: true }],
  ['s-unread', { completionUnread: true }],
  ['s-idle', { running: false, completionUnread: false }],
  ['s-subagent', { running: true }],
  ['s-blank', { completionUnread: true }],
])

const LIST = {
  ids: ['s-wait', 's-run-new', 's-run-old', 's-unread', 's-idle', 's-subagent', 's-blank'],
  byId: {
    's-wait': { displayTitle: '审批：发布 v0.3', cwd: 'D:\\Projects\\demo-app', updatedAt: NOW - 5 * MINUTE },
    's-run-new': { displayTitle: '重构渲染管线', title: 'fallback title', cwd: '/home/me/atlas', updatedAt: NOW - 2 * MINUTE },
    's-run-old': { title: '整理测试夹具', cwd: 'D:/work/site/', updatedAt: NOW - 3 * HOUR },
    's-unread': { displayTitle: '修复登录超时', cwd: '/Users/me/alpha/', updatedAt: NOW - 26 * HOUR },
    's-idle': { displayTitle: '空闲会话', cwd: 'D:\\idle', updatedAt: NOW - 999 * HOUR },
    's-subagent': { displayTitle: '子代理', cwd: 'D:\\x', origin: 'subagent', updatedAt: NOW - 1000 },
    's-blank': { displayTitle: '空白会话', cwd: 'D:\\x', blank: true, updatedAt: NOW - 2000 },
  },
}

// ------------------------------------------------------------------- mock ctx

let dictionaries = null
let injectKey = null

const mockCtx = {
  slots: {
    inject(name, callback) {
      injectKey = name
      try {
        callback()
      } finally {
        injectKey = null
      }
      return () => {}
    },
    register(options) {
      void ((options && options.name) || injectKey)
      return () => {}
    },
  },
  connection: { rpc: { call: () => Promise.resolve({ ok: true, value: null }) } },
  locale: {
    register(namespace, dicts) {
      dictionaries = { namespace, dicts }
      return () => {}
    },
    bind() {
      return (key, params) => {
        const table = (dictionaries && dictionaries.dicts.zh) || {}
        const value = table[key]
        if (value === undefined) return key
        return String(value).replace(/\{(\w+)\}/g, (match, name) => (
          params && params[name] !== undefined ? String(params[name]) : match
        ))
      }
    },
  },
  effect(fn) {
    const cleanup = fn()
    return typeof cleanup === 'function' ? cleanup : () => {}
  },
  get() { return null },
}

// ---------------------------------------------------------------------- apply

const runtime = module_._internal.runtime
const registeredCss = []

module_.apply(mockCtx)
ok(dictionaries, 'apply must register the dictionaries')
is(dictionaries.namespace, 'homepage', 'the dictionaries live in the card plugin namespace')

const realInsertCss = runtime.insertCss
runtime.insertCss = (css) => {
  registeredCss.push(css)
  return realInsertCss(css)
}

const surface = globalThis.__DSH_HOMEPAGE__
const card = surface.get('sessions')
ok(card, 'the shipped registry must hold the sessions card')
is(card.id, 'sessions', 'the card id must be the one the contract names')
is(card.shipped, true, 'the sessions card ships with the plugin')
same(card.size, { w: 2, h: 2 }, 'the wall span is the agreed 2x2')
same(card.minSize, { w: 2, h: 2 }, 'two readings do not fit beside the third below 2x2')
same(card.maxSize, { w: 4, h: 3 }, 'the expanded page may grow but its list stays a column')
is(card.order, 15, 'the card sits at the front of the wall, right after the balance')
is(card.accent, '#0f9f8f', 'the accent is the card\'s own teal, distinct from knowledge/skill')
same(card.tags, ['session', 'runtime', 'attention'], 'the card is discoverable by its tags')
same(card.texture, { icon: 'sessions', opacity: 5, size: 118, bleed: '-16%' },
  'the watermark is the card\'s own mark, painted at the house five percent')

const t = (key, params) => mockCtx.locale.bind('homepage')(key, params)

is(card.title(), '会话状态', 'the zh title resolves through the dictionary')
is(card.subtitle, null, 'the card carries no subtitle: the head reads as a title only')
is(t('session.title'), '会话状态', 'the title key is in the card dictionary')
is(t('session.subtitle'), 'session.subtitle', 'the subtitle key is not in the card dictionary')

// The dictionary is the card's whole visible vocabulary: zh and en must name
// exactly the same keys, and every key belongs to this card's namespace.
const dictZh = card.dict && card.dict.zh ? card.dict.zh : {}
const dictEn = card.dict && card.dict.en ? card.dict.en : {}
const zhKeys = Object.keys(dictZh).sort()
const enKeys = Object.keys(dictEn).sort()
same(zhKeys, enKeys, 'zh and en must carry identical key sets')
ok(zhKeys.length >= 33, 'the dictionary must cover the whole card, got ' + zhKeys.length + ' keys')
ok(zhKeys.every((key) => key.indexOf('session.') === 0), 'every key must be namespaced session.*')
ok(zhKeys.every((key) => String(dictZh[key]).trim() !== ''), 'no zh literal may be left empty')
ok(enKeys.every((key) => String(dictEn[key]).trim() !== ''), 'no en literal may be left empty')
same(zhKeys.filter((key) => key === 'session.subtitle'
  || key === 'session.page.sub'
  || key === 'session.page.subNone'
  || key === 'session.page.showing'
  || key === 'session.page.title'
  || key.indexOf('session.hint.') === 0), [],
  'the removed subtitle, page title, summary, counter and hint keys are gone from both dictionaries')

// The wall order places the card second, between the balance and the calendar.
const wallOrder = module_._internal.orderedCards().map((entry) => entry.id)
is(wallOrder[0], 'token', 'the balance still leads the wall')
is(wallOrder[1], 'sessions', 'the sessions card follows it')

// The icon is drawn by the card, not imported: one 24-grid stroke mark.
const icon = card.icon(24)
is(icon.tag, 'svg', 'the card draws its own icon')
is(icon.props.viewBox, '0 0 24 24', 'the icon lives on the 24 grid every other card uses')
is(icon.props.stroke, 'currentColor', 'the icon takes the surrounding ink')

// ------------------------------------------------------- the pure classifier
//
// `summarize` is exported on the definition so the priority rule is testable
// without rendering, and reusable by any future host path.

const summarize = card.raw && card.raw.summarize
const stateOf = card.raw && card.raw.stateOf
ok(typeof summarize === 'function', 'the card must expose its pure summarize()')
ok(typeof stateOf === 'function', 'the card must expose its pure stateOf()')

same(stateOf({ running: true, pendingInteraction: 'approval' }), 'waiting',
  'an approval outranks the fact that the session is also running')
same(stateOf({ running: true }), 'running', 'a running session is running')
same(stateOf({ completionUnread: true }), 'unread', 'a finished unseen session is unread')
same(stateOf({ completionUnread: true, pendingInteraction: 'question' }), 'waiting',
  'a question is a waiting state even after the turn finished')
same(stateOf({ running: true, completionUnread: true }), 'running',
  'a running session is not also counted as unread')
same(stateOf({ running: false, completionUnread: false }), '', 'an idle session needs no attention')
same(stateOf(null), '', 'a missing record is not a state')

const base = summarize(STATUS, LIST)
is(base.available, true, 'a status map means the bridge is available')
is(base.waiting, 1, 'one session is waiting on the human')
is(base.running, 2, 'two sessions are running (the waiting one is not one of them)')
is(base.unread, 1, 'one finished session is unread (subagent and blank are excluded)')
is(base.total, 4, 'the four human-relevant sessions are the list')
is(base.projects, 4, 'four distinct project folders carry them')
same(base.rows.map((row) => row.id), ['s-wait', 's-run-new', 's-run-old', 's-unread'],
  'rows read waiting, then running, then unread; within a group newest first')
same(base.rows.map((row) => row.state), ['waiting', 'running', 'running', 'unread'],
  'each row carries its one state')
same(base.rows.map((row) => row.title), ['审批：发布 v0.3', '重构渲染管线', '整理测试夹具', '修复登录超时'],
  'displayTitle wins, then title, then a short id')
is(base.rows[0].project, 'demo-app', 'a Windows cwd yields its last component')
is(base.rows[1].project, 'atlas', 'a POSIX cwd yields its last component')
is(base.rows[2].project, 'site', 'a trailing separator does not become the project name')
is(base.rows[3].project, 'alpha', 'a POSIX cwd with a trailing slash yields its last component')
is(base.rows[0].running, true, 'a waiting row still knows the process is running, so stop stays possible')
is(base.rows[3].running, false, 'an unread row has no process to stop')

same(base.rows.map((row) => row.id).indexOf('s-subagent'), -1, 'subagent sessions are excluded')
same(base.rows.map((row) => row.id).indexOf('s-blank'), -1, 'blank sessions are excluded')
same(base.rows.map((row) => row.id).indexOf('s-idle'), -1, 'idle sessions are excluded')

// The list's `ids` array is authoritative — even when empty — because that is
// the host's answer to "which sessions may this card draw".
const narrowed = summarize(STATUS, { ids: ['s-run-new', 's-unread'], byId: LIST.byId })
is(narrowed.total, 2, 'ids filters the wall to the named sessions')
is(narrowed.waiting, 0, 'a filtered-out waiting session does not count')
is(narrowed.running, 1, 'the named running session still counts')
is(narrowed.unread, 1, 'the named unread session still counts')
is(summarize(STATUS, { ids: [], byId: LIST.byId }).total, 0,
  'an empty ids array is authoritative, not a fallback to every record')
is(summarize(STATUS, { ids: [], byId: LIST.byId }).available, true,
  'an empty list is still an available bridge')

// Without `ids`, the byId keys are the list.
const byKeys = summarize(STATUS, { byId: { 's-run-new': LIST.byId['s-run-new'], 's-unread': LIST.byId['s-unread'] } })
is(byKeys.total, 2, 'byId keys are the list when ids is absent')
is(byKeys.running, 1, 'the byId subset is classified normally')

// A session without a display record still gets a readable row.
const plain = summarize(new Map([['abcdefghijkl', { completionUnread: true }]]), { ids: ['abcdefghijkl'] })
is(plain.total, 1, 'a status with no metadata is still shown')
is(plain.rows[0].title, 'abcdefgh', 'a missing title falls back to a short id')
is(plain.rows[0].project, '', 'a missing cwd renders no project')
is(plain.rows[0].updatedAt, 0, 'a missing timestamp renders no age')

// Degenerate inputs must answer, not throw.
same(summarize(new Map(), { ids: [], byId: {} }),
  { available: true, waiting: 0, running: 0, unread: 0, total: 0, projects: 0, rows: [] },
  'an empty map is an available, empty card')
is(summarize(null, LIST).available, false, 'a null status source is unavailable')
is(summarize(undefined, undefined).total, 0, 'an absent bridge is an empty reading, not a crash')
is(summarize(null, LIST).waiting, 0, 'an unavailable bridge still answers with zero counts')
is(summarize({ 's-plain': { running: true } }, { ids: ['s-plain'] }).running, 1,
  'a plain record is accepted where the Map is expected')

// The preview and the page share this one rendering, mounted independently.
function apiWith(statuses, list, extra) {
  // The real cardApi exposes sessionStatus/sessionList as getter-only
  // properties, so this fixture shadows them on a child object instead of
  // assigning over the getters (which throws in strict mode).
  const api = Object.create(surface.cardApi('sessions'))
  Object.defineProperties(api, {
    sessionStatus: { value: statuses, enumerable: true, configurable: true, writable: true },
    sessionList: { value: list, enumerable: true, configurable: true, writable: true },
  })
  return Object.assign(api, extra || {})
}

// ============================================================ the wall reading

const preview = stage(card.content)
let tree = await preview.render(apiWith(STATUS, LIST))

is(byClass(tree, 'ph-ss-preview').length, 1, 'the preview renders its own body')
const reads = byClass(tree, 'ph-ss-read')
is(reads.length, 3, 'the preview is exactly three readings')
same(reads.map((read) => read.props['data-state']), ['running', 'waiting', 'unread'],
  'the readings read running, waiting, unread — the product wording')
same(reads.map((read) => textOf(byClass(read, 'ph-ss-big')[0])), ['2', '1', '1'],
  'each reading carries its own count')
same(reads.map((read) => textOf(byClass(read, 'ph-ss-read-top')[0])),
  [t('session.state.running'), t('session.state.waiting'), t('session.state.unread')],
  'each count is named by its state')
is(byClass(reads[1], 'ph-ss-dot').length, 1, 'each reading carries its status dot')
ok(hasClass(reads[1], 'is-hot'), 'a non-zero reading is marked as live')
ok(hasClass(reads[0], 'is-hot'), 'every non-zero reading is marked as live')

const share = byClass(tree, 'ph-ss-share')[0]
ok(share, 'the preview carries one share bar')
same(share.props.children.map((segment) => segment.props.style.flex), ['2', '1', '1'],
  'the share bar weights each non-zero state by its count')
ok(text(tree).includes(t('session.preview.total', { count: 4 })), 'the foot states the total')
ok(text(tree).includes(t('session.preview.projects', { count: 4 })), 'the foot states the project count')

// The preview is a reading, not a settings pane.
is(byClass(tree, 'ph-actions').length, 0, 'a preview carries no settings controls')
is(byClass(tree, 'ph-segmented').length, 0, 'the filter belongs to the expanded page')
is(buttonLikes(tree).length, 0, 'the preview offers no button at all')

// An available bridge with nothing to show says so without drawing a bar.
tree = await preview.render(apiWith(new Map(), { ids: [], byId: {} }))
same(byClass(tree, 'ph-ss-big').map(textOf), ['0', '0', '0'], 'an empty wall reads three zeroes')
is(byClass(tree, 'ph-ss-share').filter((node) => hasClass(node, 'is-empty')).length, 1,
  'an empty wall draws the empty share bar')
ok(text(tree).includes(t('session.preview.none')), 'the foot says nothing needs attention')

// No bridge at all: zeroes and a flag, never a throw.
tree = await preview.render(apiWith(null, null))
same(byClass(tree, 'ph-ss-big').map(textOf), ['0', '0', '0'], 'an unavailable bridge counts zeroes')
is(byClass(tree, 'ph-ss-flag').length, 1, 'an unavailable bridge raises the flag')
ok(text(tree).includes(t('session.unavailable.title')), 'the flag names the unavailable state')

// An api without the fields at all (an older host) degrades the same way.
tree = await preview.render({})
same(byClass(tree, 'ph-ss-big').map(textOf), ['0', '0', '0'], 'a missing api field reads zeroes')
ok(text(tree).includes(t('session.unavailable.title')), 'a missing api field raises the flag')

// The card registers its stylesheet once for the lifetime of the panel.
is(registeredCss.length, 1, 'one stylesheet per card, not one per mount')
ok(registeredCss[0].includes('.ph-ss'), 'the stylesheet is the card\'s own')
ok(registeredCss[0].includes('--dsw-alias-label-primary'), 'the card paints with the theme tokens')
ok(registeredCss[0].includes('prefers-reduced-motion'), 'the card honours reduced motion')
ok(registeredCss[0].includes('max-width:760px'), 'the page collapses to one column')
ok(registeredCss[0].indexOf('@keyframes') < 0, 'the card introduces no animation of its own')

// =========================================================== the expanded page

function rowOf(tree, id) {
  return byClass(tree, 'ph-ss-row').find((row) => row.props['data-session-id'] === id)
}

const opened = []
const stopped = []
let repaints = 0
const detailApi = apiWith(STATUS, LIST, {
  openSession(id) { opened.push(id); return true },
  remote(endpoint, args) {
    stopped.push({ endpoint, args })
    return Promise.resolve({ ok: true })
  },
  repaint() { repaints += 1 },
})

const detail = stage(card.detail)
tree = await detail.render(detailApi)

is(byClass(tree, 'ph-ss-page').length, 1, 'the expanded page renders its own body')
is(byClass(tree, 'ph-ss-title').length, 0, 'the expanded pane header already names the card, so the body draws no title')
is(byClass(tree, 'ph-ss-sub').length, 0, 'the page carries no summary sentence under the title')
is(byClass(tree, 'ph-ss-row').length, 4, 'the page lists only the sessions that need attention')
same(byClass(tree, 'ph-ss-row').map((row) => row.props['data-session-id']),
  ['s-wait', 's-run-new', 's-run-old', 's-unread'], 'the list keeps the priority order')
same(byClass(tree, 'ph-ss-stat-num').map(textOf), ['1', '2', '1'],
  'the page repeats the same three readings, waiting first')
is(byClass(tree, 'ph-ss-stat-hint').length, 0,
  'the stat tiles are not explained by a second line')
is(byClass(tree, 'ph-segmented').length, 1, 'the page carries the one filter')
is(byClass(tree, 'ph-segment').length, 4, 'the filter has the four states a person can choose')

// A row shows the title, the project, the state and the relative age.
const waitRow = rowOf(tree, 's-wait')
ok(text(waitRow).includes('审批：发布 v0.3'), 'the row shows the display title')
ok(text(waitRow).includes('demo-app'), 'the row shows the project basename')
ok(text(waitRow).includes(t('session.state.waiting')), 'the row states its state in words')
ok(text(waitRow).includes(t('session.time.minutes', { count: 5 })), 'the row shows a relative age')
ok(!text(waitRow).includes('D:\\Projects\\demo-app'), 'the row does not dump the full cwd')

// The stop control is offered exactly where a process can be stopped.
is(byClass(rowOf(tree, 's-run-new'), 'ph-ss-stop').length, 1, 'a running row offers stop')
is(byClass(rowOf(tree, 's-wait'), 'ph-ss-stop').length, 1,
  'a waiting row that is still running offers stop too')
is(byClass(rowOf(tree, 's-unread'), 'ph-ss-stop').length, 0, 'a finished row offers no stop')

// Clicking the row opens the session; the keyboard does the same.
rowOf(tree, 's-run-new').props.onClick()
same(opened.slice(-1), ['s-run-new'], 'a row click opens that session')
rowOf(tree, 's-unread').props.onKeyDown({ key: 'Enter', preventDefault() {} })
same(opened.slice(-1), ['s-unread'], 'Enter on a row opens that session')
rowOf(tree, 's-unread').props.onKeyDown({ key: 'x', preventDefault() {} })
is(opened.length, 2, 'an unrelated key does not open a row')

// A row that cannot be opened says so instead of failing silently.
const refusing = stage(card.detail)
const refusingApi = apiWith(STATUS, LIST, {
  openSession() { return false },
  remote() { return Promise.resolve({ ok: true }) },
})
let refusedTree = await refusing.render(refusingApi)
byClass(refusedTree, 'ph-ss-row')[0].props.onClick()
await sleep(10)
let toast = surface.snapshot().toasts[surface.snapshot().toasts.length - 1]
is(toast.text, t('session.open.failed'), 'a refused open raises an error toast')
is(toast.level, 'error', 'a refused open is an error, not information')

// --- filtering -------------------------------------------------------------
//
// The filter is local page state: no host call, no persisted control. Clicking
// the segment is the whole interaction.

const filterButton = (label) => byClass(tree, 'ph-segment')
  .find((button) => textOf(button) === label)
ok(filterButton(t('session.filter.waiting')), 'the waiting segment exists')
filterButton(t('session.filter.waiting')).props.onClick()
tree = await detail.render(detailApi)
is(byClass(tree, 'ph-ss-row').length, 1, 'the waiting filter keeps only the waiting row')
ok(rowOf(tree, 's-wait') !== undefined, 'the waiting row survives the filter')
is(byClass(tree, 'ph-ss-showing').length, 0,
  'the filtered page adds no showing counter beside the chips')
ok(!text(tree).includes(t('session.page.showing', { shown: 1, total: 4 })),
  'no removed showing sentence is left on the page')

// A state with no session renders the per-filter empty line, not the global
// empty state: the bridge is up and the list is not empty.
detailApi.sessionStatus = new Map([['s-wait', STATUS.get('s-wait')]])
filterButton(t('session.filter.unread')).props.onClick()
tree = await detail.render(detailApi)
is(byClass(tree, 'ph-ss-none').length, 1, 'an empty filter says so in place')
ok(text(tree).includes(t('session.empty.filtered')), 'the empty filter line is its own message')
is(byClass(tree, 'ph-ss-empty').length, 0, 'an empty filter is not the global empty state')
detailApi.sessionStatus = STATUS

// --- stopping a running session --------------------------------------------

const stopStage = stage(card.detail)
const stopApi = apiWith(STATUS, LIST, {
  openSession() { return true },
  remote(endpoint, args) {
    stopped.push({ endpoint, args })
    return Promise.resolve({ ok: true })
  },
})
let stopTree = await stopStage.render(stopApi)
const runRow = rowOf(stopTree, 's-run-new')
let propagated = false
byClass(runRow, 'ph-ss-stop')[0].props.onClick({ stopPropagation() { propagated = true } })
ok(propagated, 'the stop click must not bubble into the row and open the session')
await sleep(20)
same(stopped.length, 1, 'one stop click makes one call')
same(stopped[0], {
  endpoint: 'homepage/act',
  args: { options: { action: 'session.stop', payload: { sessionId: 's-run-new' } } },
}, 'the stop call carries the exact endpoint and the one options argument')
is(opened.length, 2, 'stopping must not also open the session')
toast = surface.snapshot().toasts[surface.snapshot().toasts.length - 1]
is(toast.text, t('session.stop.done'), 'a landed stop is announced')

// The button is disabled while the call is in flight, so a double click cannot
// fire two stops at one session.
let releaseStop = null
const busyStage = stage(card.detail)
const busyStopped = []
const busyApi = apiWith(STATUS, LIST, {
  openSession() { return true },
  remote(endpoint, args) {
    busyStopped.push({ endpoint, args })
    return new Promise((resolve) => { releaseStop = resolve })
  },
})
let busyTree = await busyStage.render(busyApi)
byClass(rowOf(busyTree, 's-run-old'), 'ph-ss-stop')[0].props.onClick({ stopPropagation() {} })
await sleep(10)
busyTree = await busyStage.render(busyApi)
const busyButton = byClass(rowOf(busyTree, 's-run-old'), 'ph-ss-stop')[0]
is(busyButton.props.disabled, true, 'a stop in flight disables its own button')
is(textOf(busyButton), t('session.stop.running'), 'the button says it is stopping')
busyButton.props.onClick({ stopPropagation() {} })
await sleep(10)
is(busyStopped.length, 1, 'a second click while in flight is ignored')
releaseStop({ ok: true })
await sleep(20)

// A business failure and a rejected transport both surface the reason.
const failStage = stage(card.detail)
const failApi = apiWith(STATUS, LIST, {
  openSession() { return true },
  remote() { return Promise.resolve({ ok: false, error: { message: 'boom' } }) },
})
let failTree = await failStage.render(failApi)
byClass(rowOf(failTree, 's-run-new'), 'ph-ss-stop')[0].props.onClick({ stopPropagation() {} })
await sleep(20)
toast = surface.snapshot().toasts[surface.snapshot().toasts.length - 1]
is(toast.text, t('session.stop.failed', { reason: 'boom' }), 'a refused stop shows the host reason')
is(toast.level, 'error', 'a refused stop is an error toast')

const rejectStage = stage(card.detail)
const rejectApi = apiWith(STATUS, LIST, {
  openSession() { return true },
  remote() { return Promise.reject(new Error('offline')) },
})
let rejectTree = await rejectStage.render(rejectApi)
byClass(rowOf(rejectTree, 's-run-old'), 'ph-ss-stop')[0].props.onClick({ stopPropagation() {} })
await sleep(20)
toast = surface.snapshot().toasts[surface.snapshot().toasts.length - 1]
is(toast.text, t('session.stop.failed', { reason: 'offline' }), 'a rejected transport shows its message')
is(toast.level, 'error', 'a rejected transport is an error toast')

// --- no bridge -------------------------------------------------------------

const noneStage = stage(card.detail)
let noneTree = await noneStage.render(apiWith(null, null))
is(byClass(noneTree, 'ph-ss-empty').length, 1, 'an unavailable bridge renders the empty state')
ok(text(noneTree).includes(t('session.unavailable.title')), 'the empty state names the unavailable bridge')
same(byClass(noneTree, 'ph-ss-stat-num').map(textOf), ['0', '0', '0'], 'the page still reads zeroes')
is(byClass(noneTree, 'ph-ss-row').length, 0, 'an unavailable bridge lists nothing')

// An available bridge with zero sessions gets the other empty state, and the
// difference is the point: "nothing to do" is not "the service is down".
const refreshApi = apiWith(new Map(), { ids: [], byId: {} }, {
  repaint() { repaints += 1 },
})
noneTree = await noneStage.render(refreshApi)
is(byClass(noneTree, 'ph-ss-empty').length, 1, 'an empty bridge renders the empty state')
ok(text(noneTree).includes(t('session.empty.title')), 'the empty state says nothing needs attention')
is(byClass(noneTree, 'ph-ss-live').length, 1, 'an available bridge shows the live tag')

// A refresh button merely re-renders; it never polls and it owns no timer.
const refreshButton = byClass(noneTree, 'ph-ss-iconbtn')[0]
ok(refreshButton, 'the page offers a refresh button')
refreshButton.props.onClick()
is(repaints, 1, 'refresh repaints the card instead of polling the host')

console.log('session-card: ' + checks + ' checks passed')
