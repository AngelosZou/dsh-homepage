/**
 * tool-usage-card: the Tool usage card's own behavioural coverage.
 *
 * `test/smoke-client.mjs` proves the framework contract around a card — that it
 * registers, that its preview draws on the wall, that its dictionary is
 * balanced. This file is the Tool usage card's own test: the pure formatters,
 * both entry points, the project switcher, and the failure paths that must
 * leave the page usable.
 *
 * The host is stubbed at the transport (`runtime.call`), which is where the
 * card actually talks, so no filesystem is needed here. The host module itself
 * is covered by its own test.
 *
 * The bundle is loaded the way the browser loads it — `lib/client.js` is read as
 * TEXT and evaluated with `new Function(source)()` — because it legitimately
 * names `module`/`exports` and Node's module-format detection would mangle it.
 * The React object is the harness's own shim; the UI primitives come from
 * test/ui-primitives-stub.mjs, so there is no installed 'react' to import.
 *
 * `useRemote` arms a 60s interval on mount, so `setInterval` is stubbed for the
 * duration of the render phase and restored at the end (the process must exit
 * without a live timer).
 *
 * Run: node test/tool-usage-card.mjs
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
    createRoot() { throw new Error('test/tool-usage-card.mjs has no DOM root: the bundle is evaluated, not mounted') },
    hydrateRoot() { throw new Error('test/tool-usage-card.mjs has no DOM root: the bundle is evaluated, not mounted') },
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
const card = surface.get('tool-usage')
ok(card, 'the shipped registry must hold the tool-usage card')
is(card.id, 'tool-usage', 'the card id must be the one the contract names')
is(card.shipped, true, 'the tool-usage card ships with the plugin')
same(card.size, { w: 2, h: 1 }, 'the wall span is the agreed 2x1')
same(card.minSize, { w: 1, h: 1 }, 'a narrow cell still fits the three readings')
same(card.maxSize, { w: 4, h: 3 }, 'the expanded page may grow but stays one column')
is(card.order, 55, 'the card sits after the device card and before the DSH card')
is(card.accent, '#b03a68', 'the accent is the card own rose, distinct from the neighbours')
same(card.tags, ['tools', 'tokens', 'usage'], 'the card is discoverable by its tags')
same(card.texture, { icon: 'grid', opacity: 5, size: 118, bleed: '-16%' },
  'the watermark is the grid mark, painted at the house five percent')
is(card.refreshMs, 60000, 'the wall polls this card once a minute')

const t = (key, params) => mockCtx.locale.bind('homepage')(key, params)

is(card.title(), '工具用量', 'the zh title resolves through the dictionary')
is(card.subtitle, null, 'the card carries no subtitle')
is(t('toolUsage.preview.calls'), '累计调用', 'the preview names the call total')
is(t('toolUsage.stat.args'), '输入令牌', 'the stats name the argument tokens')

// The dictionary is the card's whole visible vocabulary: zh and en must name
// exactly the same keys, and every key belongs to this card's namespace.
const dictZh = card.dict && card.dict.zh ? card.dict.zh : {}
const dictEn = card.dict && card.dict.en ? card.dict.en : {}
const zhKeys = Object.keys(dictZh).sort()
const enKeys = Object.keys(dictEn).sort()
same(zhKeys, enKeys, 'zh and en must carry identical key sets')
ok(zhKeys.length >= 33, 'the dictionary must cover the whole card, got ' + zhKeys.length + ' keys')
ok(zhKeys.every((key) => key.indexOf('toolUsage.') === 0), 'every key must be namespaced toolUsage.*')
ok(zhKeys.every((key) => String(dictZh[key]).trim() !== ''), 'no zh literal may be left empty')
ok(enKeys.every((key) => String(dictEn[key]).trim() !== ''), 'no en literal may be left empty')
ok(zhKeys.includes('toolUsage.preview.partial'), 'the partial marker is part of the dictionary')
ok(zhKeys.includes('toolUsage.window.cumulative'), 'the cumulative note is part of the dictionary')
same(zhKeys.filter((key) => key === 'toolUsage.subtitle' || key === 'toolUsage.stat.errorsHint'), [],
  'the subtitle and the stat hint are gone from both dictionaries')

// The wall order is the card's own registration, not this test's guess.
const wallOrder = module_._internal.orderedCards().map((entry) => entry.id)
ok(wallOrder.includes('tool-usage'), 'the tool-usage card is on the wall')

// The icon is drawn by the card, not imported: one 24-grid stroke mark.
const iconProbe = stage(function IconProbe() {
  return React.createElement('div', null, card.icon(24))
})
const iconTree = await iconProbe.render({})
const icon = elements(iconTree).find((node) => node.tag === 'svg')
ok(icon, 'the card draws its own icon')
is(icon.props.viewBox, '0 0 24 24', 'the icon lives on the 24 grid every other card uses')
is(icon.props.stroke, 'currentColor', 'the icon takes the surrounding ink')

// ------------------------------------------------------- the pure formatters

const formatCompact = card.raw && card.raw.formatCompact
const formatInt = card.raw && card.raw.formatInt
const formatTokens = card.raw && card.raw.formatTokens
const formatPercent = card.raw && card.raw.formatPercent
const formatMs = card.raw && card.raw.formatMs
const summarize = card.raw && card.raw.summarize

is(typeof formatCompact, 'function', 'the card must expose its pure formatCompact()')
is(typeof formatInt, 'function', 'the card must expose its pure formatInt()')
is(typeof formatTokens, 'function', 'the card must expose its pure formatTokens()')
is(typeof formatPercent, 'function', 'the card must expose its pure formatPercent()')
is(typeof formatMs, 'function', 'the card must expose its pure formatMs()')
is(typeof summarize, 'function', 'the card must expose its pure summarize()')

is(formatCompact(0), '0', 'nothing reads as zero')
is(formatCompact(999), '999', 'the last count below a thousand stays exact')
is(formatCompact(1000), '1k', 'a thousand is the first step')
is(formatCompact(1234), '1.2k', 'a fraction of a step keeps one decimal')
is(formatCompact(12345), '12k', 'a two-digit step drops the decimal')
is(formatCompact(1200000), '1.2M', 'an exact megabyte of calls is clean')
is(formatCompact(-5), '0', 'a negative count is clamped')
is(formatCompact(null), '0', 'a missing count is zero')
is(formatCompact(NaN), '0', 'a non-number is zero')
is(formatCompact('nope'), '0', 'a malformed string is zero')

is(formatInt(0), '0', 'zero is not grouped')
is(formatInt(1234), '1,234', 'thousands are grouped')
is(formatInt(1234567), '1,234,567', 'millions are grouped too')
is(formatInt('800'), '800', 'a numeric string is accepted')
is(formatInt(-5), '0', 'a negative total is clamped')

is(formatTokens(0), '≈0', 'an empty estimate still carries the mark')
is(formatTokens(482000), '≈482k', 'an estimate is compact and marked')
is(formatTokens(1200000), '≈1.2M', 'a large estimate keeps the mark')

is(formatPercent(0), '0%', 'no errors reads as zero percent')
is(formatPercent(0.02), '2%', 'a whole share loses the trailing decimal')
is(formatPercent(0.032), '3.2%', 'a share under ten percent keeps one decimal')
is(formatPercent(0.125), '13%', 'a share over ten percent is rounded')
is(formatPercent(0.0042), '0.42%', 'a rare error keeps two decimals')
is(formatPercent(100), '100%', 'a declared percentage is read as a rate')
is(formatPercent(3.2), '3.2%', 'a declared rate above one is read as a percentage')

is(formatMs(0), '0 ms', 'no duration reads as zero')
is(formatMs(420), '420 ms', 'a short average stays in milliseconds')
is(formatMs(1200), '1.2 s', 'an average over a second switches unit')
is(formatMs(15000), '15 s', 'a two-digit second average drops the decimal')
is(formatMs(120000), '2 min', 'a long average switches to minutes')

// ------------------------------------------------------------------- fixtures

const NOW = Date.now()

const BASH = { name: 'Bash', calls: 1200, errors: 24, errorRate: 0.02, argChars: 180000, outChars: 640000, argTokens: 45000, outTokens: 160000, ms: 2400000 }
const READ = { name: 'Read', calls: 800, errors: 0, errorRate: 0, argChars: 40000, outChars: 960000, argTokens: 10000, outTokens: 240000, ms: 400000 }
const EDIT = { name: 'Edit', calls: 300, errors: 3, errorRate: 0.01, argChars: 60000, outChars: 9000, argTokens: 15000, outTokens: 2250, ms: 180000 }
const GREP = { name: 'Grep', calls: 120, errors: 0, errorRate: 0, argChars: 9000, outChars: 30000, argTokens: 2250, outTokens: 7500, ms: 60000 }

const TOOLS = [BASH, READ, EDIT, GREP]

const P1 = {
  key: 'demo-app',
  label: 'demo-app',
  path: 'D:\\Projects\\demo-app',
  sessions: 12,
  calls: 1500,
  errors: 20,
  errorRate: 20 / 1500,
  argChars: 240000,
  outChars: 500000,
  argTokens: 60000,
  outTokens: 125000,
  ms: 1900000,
  toolCount: 4,
  top: [{ name: 'Bash', calls: 900 }, { name: 'Read', calls: 400 }, { name: 'Edit', calls: 150 }],
  tools: [
    { name: 'Bash', calls: 900, errors: 20, argTokens: 34000, outTokens: 120000, ms: 1500000 },
    { name: 'Read', calls: 400, errors: 0, argTokens: 5000, outTokens: 120000, ms: 200000 },
    { name: 'Edit', calls: 150, errors: 0, argTokens: 7500, outTokens: 1125, ms: 90000 },
    { name: 'Grep', calls: 50, errors: 0, argTokens: 940, outTokens: 3125, ms: 30000 },
  ],
}

const P2 = {
  key: 'notes',
  label: 'notes',
  path: 'D:\\notes',
  sessions: 4,
  calls: 920,
  errors: 7,
  argTokens: 12250,
  outTokens: 284750,
  ms: 1140000,
  toolCount: 4,
  top: [{ name: 'Read', calls: 400 }, { name: 'Bash', calls: 300 }, { name: 'Edit', calls: 150 }],
  tools: [
    { name: 'Bash', calls: 300, errors: 7, argTokens: 11000, outTokens: 40000, ms: 900000 },
    { name: 'Read', calls: 400, errors: 0, argTokens: 5000, outTokens: 120000, ms: 200000 },
    { name: 'Edit', calls: 150, errors: 0, argTokens: 7500, outTokens: 1125, ms: 90000 },
    { name: 'Grep', calls: 70, errors: 0, argTokens: 1310, outTokens: 4375, ms: 40000 },
  ],
}

const DOC = {
  available: true,
  reason: '',
  at: NOW,
  partial: false,
  window: { sessions: 16, projects: 2, scannedSessions: 18, firstAt: NOW - 86400000 * 9, lastAt: NOW - 3600000 },
  totals: { calls: 2420, errors: 27, errorRate: 27 / 2420, argChars: 289000, outChars: 1639000, argTokens: 72250, outTokens: 409750, ms: 3040000 },
  tools: TOOLS,
  projects: [P1, P2],
}

const EMPTY_DOC = {
  available: true,
  at: NOW,
  partial: false,
  window: { sessions: 0, projects: 0, scannedSessions: 0, firstAt: 0, lastAt: 0 },
  totals: { calls: 0, errors: 0, errorRate: 0, argChars: 0, outChars: 0, argTokens: 0, outTokens: 0, ms: 0 },
  tools: [],
  projects: [],
}

// ------------------------------------------------------ summarize (pure) cases

const reading = summarize(DOC)
is(reading.available, true, 'a live host document is available')
is(reading.loading, false, 'an answered document is not loading')
is(reading.partial, false, 'a complete scan is not partial')
is(reading.totals.calls, 2420, 'the host total is the headline count')
is(reading.totals.tokens, 482000, 'both estimates are added for the preview')
is(reading.totals.avgMs, 3040000 / 2420, 'the average is derived from the host milliseconds')
is(reading.toolCount, 4, 'every usable tool becomes a row')
is(reading.projectCount, 2, 'every usable project becomes a chip')
is(reading.topTool.name, 'Bash', 'the top tool is the most-called one')
is(reading.topTool.calls, 1200, 'the top tool keeps its count')
same(reading.tools.map((row) => row.name), ['Bash', 'Read', 'Edit', 'Grep'], 'the rows are sorted by calls')
same(reading.projects.map((row) => row.key), ['demo-app', 'notes'], 'the projects are sorted by calls')
is(reading.projects[1].label, 'notes', 'a project keeps its label')
is(reading.projects[0].tools[0].name, 'Bash', 'a project carries its own tool rows')
is(reading.projects[0].top.length, 3, 'a project carries its declared top tools')
is(reading.window.sessions, 16, 'the window session count is kept')

const noTotals = summarize({ available: true, tools: TOOLS, projects: [P1] })
is(noTotals.totals.calls, 2420, 'without host totals the tool rows are summed for calls')
is(noTotals.totals.errors, 27, 'without host totals the tool rows are summed for errors')
is(noTotals.totals.tokens, 482000, 'without host totals the tool rows are summed for tokens')
is(noTotals.projectCount, 1, 'a projects list still counts without totals')

const declaredWins = summarize({
  available: true,
  totals: { calls: 5, errors: 1, argTokens: 7, outTokens: 3, errorRate: 0.2 },
  tools: TOOLS,
})
is(declaredWins.totals.calls, 5, 'when present the host total wins over the row sum')
is(declaredWins.totals.tokens, 10, 'the declared estimates are added')
is(declaredWins.totals.errorRate, 0.2, 'a declared rate wins over errors / calls')
is(declaredWins.totals.errors, 1, 'the declared error count is kept')

const percentRate = summarize({ available: true, tools: [{ name: 'A', calls: 100, errors: 5, errorRate: 3.2 }] })
is(percentRate.tools[0].errorRate, 0.032, 'a provided rate above one is normalized as a percentage')
is(percentRate.totals.errorRate, 0.05, 'the total rate is still errors over calls, not a sum of rates')

const partial = summarize({ available: true, partial: true, tools: TOOLS })
is(partial.partial, true, 'a partial scan is marked')
is(partial.available, true, 'a partial scan is still available')

const empty = summarize(EMPTY_DOC)
is(empty.available, true, 'an empty host is still an available host')
is(empty.totals.calls, 0, 'an empty host reads zero calls')
is(empty.topTool, null, 'an empty host has no top tool')
is(empty.toolCount, 0, 'an empty host has no tool rows')

const loading = summarize(null, null)
is(loading.available, false, 'no document yet is unavailable')
is(loading.loading, true, 'no document and no failure means loading')
is(loading.totals.calls, 0, 'nothing has been counted yet')
is(loading.topTool, null, 'nothing has a top tool yet')

const failed = summarize(null, 'offline')
is(failed.loading, false, 'a transport failure stops the loading state')
is(failed.error, 'offline', 'the transport reason is kept')
is(failed.available, false, 'a transport failure is unavailable')

const missing = summarize({
  available: false,
  reason: 'no stored sessions were found',
  at: NOW,
  totals: { calls: 0, errors: 0, argTokens: 0, outTokens: 0, ms: 0 },
  tools: [],
  projects: [],
})
is(missing.available, false, 'an unavailable host is not available')
is(missing.reason, 'no stored sessions were found', 'the host reason survives for the page')
is(missing.loading, false, 'an answered but unavailable host is not loading')

const malformed = summarize({
  available: true,
  tools: [
    null,
    7,
    'x',
    { name: '' },
    { name: 'Weird', calls: '10', errors: -2, argTokens: null, errorRate: 25 },
  ],
})
is(malformed.toolCount, 1, 'only an object with a non-empty name becomes a row')
is(malformed.tools[0].calls, 10, 'a numeric string is accepted as a call count')
is(malformed.tools[0].errors, 0, 'a negative error count is clamped')
is(malformed.tools[0].errorRate, 0.25, 'a bare number rate is read as a percentage')
is(malformed.tools[0].tokens, 0, 'a missing estimate reads zero')
is(malformed.tools[0].avgMs, 0, 'a row without calls has no average')

const malformedProjects = summarize({
  available: true,
  projects: [
    null,
    3,
    { label: 'no key' },
    { key: 'k', label: '', path: 'D:\\k', calls: '12', sessions: 2, tools: 'nope', top: [{ name: '' }, { name: 'Bash', calls: '4' }] },
    { path: 'D:\\only-path', calls: 3, tools: [] },
  ],
})
is(malformedProjects.projectCount, 2, 'a project needs a key or a path')
is(malformedProjects.projects[0].key, 'k', 'the key is kept')
is(malformedProjects.projects[0].label, 'k', 'a missing label falls back to the key')
is(malformedProjects.projects[0].calls, 12, 'a numeric string call count is accepted')
is(malformedProjects.projects[0].toolCount, 0, 'a malformed tools list is not a crash')
is(malformedProjects.projects[0].top.length, 1, 'a top entry without a name is dropped')
is(malformedProjects.projects[1].key, 'D:\\only-path', 'a project with only a path uses it as the key')

const noThrow = summarize('not a document')
is(noThrow.available, false, 'a malformed document is unavailable, not a crash')
is(noThrow.toolCount, 0, 'a malformed document has no rows')
const arrayDoc = summarize([1, 2, 3])
is(arrayDoc.available, false, 'an array is not a host document')
const badFields = summarize({ available: 'yes', tools: 'nope', totals: 'nope' })
is(badFields.available, false, 'a truthy non-boolean available is not available')
is(badFields.totals.calls, 0, 'a malformed totals object is zero')

// ------------------------------------------------------------------- the wall

// The card's transport is the shared RPC channel; stub it at the same seam the
// real bridge uses, so the shape the card sends is what the test asserts.
let hostDoc = DOC
let hostEnvelope = null
let hostPending = false
const remoteCalls = []
const stubbedCall = async (channel, endpoint, payload) => {
  remoteCalls.push({ channel, endpoint, payload })
  if (hostPending) return new Promise(() => {})
  if (hostEnvelope) return hostEnvelope
  return { ok: true, value: hostDoc }
}
runtime.call = stubbedCall

const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

function makeApi(extra) {
  return Object.assign(Object.create(surface.cardApi('tool-usage')), extra || {})
}

const previewApi = makeApi()
const preview = stage(card.content)
let tree = await preview.render(previewApi)

is(byClass(tree, 'ph-tu-preview').length, 1, 'the preview renders its own body')
same(byClass(tree, 'ph-tu-hero-num').map(textOf), ['2.4k'], 'the hero is the cumulative call count')
ok(text(tree).includes(t('toolUsage.preview.calls')), 'the hero names the call total')
same(byClass(tree, 'ph-tu-side-num').map(textOf), ['≈482k'], 'the side is the estimated token total')
ok(text(tree).includes(t('toolUsage.preview.tokens')), 'the side names the estimate')
ok(text(byClass(tree, 'ph-tu-lead')[0]).includes('Bash'), 'the lead names the most-used tool')
ok(text(byClass(tree, 'ph-tu-lead')[0]).includes(t('toolUsage.preview.topCalls', { count: '1,200' })),
  'the lead states how often the top tool ran')
ok(text(tree).includes(t('toolUsage.preview.tools', { count: '4' })), 'the foot states the tool count')
ok(text(tree).includes(t('toolUsage.preview.projects', { count: '2' })), 'the foot states the project count')
is(byClass(tree, 'ph-tu-flag').length, 0, 'a complete scan raises no flag')
is(buttonLikes(tree).length, 0, 'the preview offers no button at all')
is(byClass(tree, 'ph-tu-page').length, 0, 'the expanded page is not drawn in the preview')

// A partial scan says so, without turning the reading into a failure.
hostDoc = Object.assign({}, DOC, { partial: true })
const partialPreview = stage(card.content)
tree = await partialPreview.render(previewApi)
is(byClass(tree, 'ph-tu-flag').length, 1, 'a partial scan raises the partial marker')
ok(text(tree).includes(t('toolUsage.preview.partial')), 'the marker says the scan is partial')
is(buttonLikes(tree).length, 0, 'a partial preview still offers no control')

// A missing host: zeros and a flag, never a throw.
hostDoc = {
  available: false,
  reason: 'no stored sessions were found',
  at: NOW,
  totals: { calls: 0, errors: 0, argTokens: 0, outTokens: 0, ms: 0 },
  tools: [],
  projects: [],
}
const missingPreview = stage(card.content)
tree = await missingPreview.render(previewApi)
same(byClass(tree, 'ph-tu-hero-num').map(textOf), ['0'], 'an unavailable host reads zero calls')
is(byClass(tree, 'ph-tu-flag').length, 1, 'an unavailable host raises the flag')
ok(text(tree).includes(t('toolUsage.preview.unavailable')), 'the flag names the unavailable state')
is(buttonLikes(tree).length, 0, 'an unavailable preview still offers no control')

// No answer yet: the loading line, not a fake zero reading.
hostDoc = DOC
hostPending = true
const loadingPreview = stage(card.content)
tree = await loadingPreview.render(previewApi)
ok(text(tree).includes(t('toolUsage.loading')), 'a pending host reads as loading')
is(byClass(tree, 'ph-tu-flag').length, 0, 'loading is not an unavailable state')
hostPending = false

// An empty but available host: the lead says there is nothing yet.
hostDoc = EMPTY_DOC
const emptyPreview = stage(card.content)
tree = await emptyPreview.render(previewApi)
ok(text(tree).includes(t('toolUsage.preview.none')), 'an empty host explains that nothing was called yet')
same(byClass(tree, 'ph-tu-hero-num').map(textOf), ['0'], 'an empty host reads zero calls')

// The card registers its stylesheet once for the lifetime of the panel.
is(registeredCss.length, 1, 'one stylesheet per card, not one per mount')
ok(registeredCss[0].includes('.ph-tu'), 'the stylesheet belongs to the card')
ok(registeredCss[0].includes('--ph-tu-accent:#b03a68'), 'the card keeps its accent in a local token')
ok(registeredCss[0].includes('--dsw-alias-label-primary'), 'the card paints with the theme tokens')
ok(registeredCss[0].includes('prefers-reduced-motion'), 'the card honours reduced motion')
ok(registeredCss[0].includes('max-width:760px'), 'the page collapses to one column')
ok(registeredCss[0].includes('@media (hover:hover) and (pointer:fine)'), 'hover only where a pointer is fine')
ok(registeredCss[0].includes('overflow-y:auto'), 'the detail lists scroll inside the card')
ok(registeredCss[0].indexOf('@keyframes') < 0, 'the card introduces no animation of its own')

// ----------------------------------------------------------- the expanded page

hostDoc = DOC
const detailApi = makeApi()

const detail = stage(card.detail)
tree = await detail.render(detailApi)

is(byClass(tree, 'ph-tu-page').length, 1, 'the expanded page renders its own body')
is(byClass(tree, 'ph-tu-title').length, 0, 'the expanded pane header already names the card, so the body draws no title')
is(byClass(tree, 'ph-tu-sub').length, 0, 'the page carries no summary sentence under the title')
same(byClass(tree, 'ph-stat-value').map(textOf), ['2,420', '1.1%', '≈72k', '≈410k'],
  'the stats are calls, error rate and the two estimates')
same(byClass(tree, 'ph-stat-label').map(textOf),
  [t('toolUsage.stat.calls'), t('toolUsage.stat.errors'), t('toolUsage.stat.args'), t('toolUsage.stat.out')],
  'each stat is labelled in the page language')
is(byClass(tree, 'ph-stat-hint').length, 0, 'the error tile states no second-line hint')
ok(!text(tree).includes(t('toolUsage.stat.errorsHint', { count: '27' })),
  'the removed raw error count is not left on the page')

same(byClass(tree, 'ph-tu-chip').map(textOf), ['全部2,420', 'demo-app1,500', 'notes920'],
  'the switcher offers All and every project, ordered by calls')
is(byClass(tree, 'ph-tu-chip')[0].props['aria-pressed'], true, 'All is selected on first paint')
is(byClass(tree, 'ph-tu-proj').length, 0, 'no project block is drawn while All is selected')

is(byClass(tree, 'ph-tu-row').length, 4, 'the page draws one row per tool')
same(byClass(tree, 'ph-tu-row-name').map(textOf), ['Bash', 'Read', 'Edit', 'Grep'],
  'the rows are ordered by calls')
same(byClass(tree, 'ph-tu-row-calls').map(textOf), ['1,200', '800', '300', '120'],
  'every row carries its own call count')
is(byClass(tree, 'ph-tu-row-err').length, 2, 'only tools with errors carry an error chip')
same(byClass(tree, 'ph-tu-row-err').map(textOf), ['2%', '1%'], 'the chip is the error rate')
is(byClass(tree, 'ph-tu-row')[1].props.title, 'Read', 'the row keeps the full name as a tooltip')
is(byClass(tree, 'ph-tu-row-name')[0].props.title, 'Bash', 'the name keeps the full name as a tooltip')
is(byClass(byClass(tree, 'ph-tu-row')[0], 'ph-tu-bar')[0].props.children.props.style.width, '100%',
  'the call bar is relative to the largest row')
is(byClass(byClass(tree, 'ph-tu-row')[3], 'ph-tu-bar')[0].props.children.props.style.width, '10%',
  'a small tool keeps a visible share of the bar')
ok(text(byClass(tree, 'ph-tu-row')[0]).includes(t('toolUsage.row.in', { value: '≈45k' })),
  'a row states the estimated argument tokens')
ok(text(byClass(tree, 'ph-tu-row')[0]).includes(t('toolUsage.row.out', { value: '≈160k' })),
  'a row states the estimated output tokens')
ok(text(byClass(tree, 'ph-tu-row')[0]).includes(t('toolUsage.row.avg', { value: '2 s' })),
  'a row hints at the average duration')

// Switching to a project filters the table and shows that project's readings.
byClass(tree, 'ph-tu-chip')[2].props.onClick()
tree = await detail.render(detailApi)
is(byClass(tree, 'ph-tu-chip')[2].props['aria-pressed'], true, 'the chosen project is active')
is(byClass(tree, 'ph-tu-chip')[0].props['aria-pressed'], false, 'All is no longer active')
is(byClass(tree, 'ph-tu-proj').length, 1, 'a chosen project shows its own block')
ok(text(byClass(tree, 'ph-tu-proj')[0]).includes('notes'), 'the block names the project')
same(byClass(byClass(tree, 'ph-tu-proj')[0], 'ph-tu-proj-reading').map(textOf),
  [
    '4' + t('toolUsage.stat.sessions'),
    '920' + t('toolUsage.stat.calls'),
    '4' + t('toolUsage.stat.tools'),
  ], 'the block states the project readings')
is(byClass(tree, 'ph-tu-proj-tool').length, 3, 'the block lists the top three tools')
same(byClass(tree, 'ph-tu-row-name').map(textOf), ['Read', 'Bash', 'Edit', 'Grep'],
  'the table is filtered and re-sorted to the project')
is(byClass(tree, 'ph-tu-row-err').length, 1, 'the project rows keep their own error chips')

byClass(tree, 'ph-tu-chip')[0].props.onClick()
tree = await detail.render(detailApi)
same(byClass(tree, 'ph-tu-row-name').map(textOf), ['Bash', 'Read', 'Edit', 'Grep'],
  'returning to All restores the cumulative rows')
is(byClass(tree, 'ph-tu-proj').length, 0, 'returning to All removes the project block')

// Refresh asks the host again; it owns no timer of its own beyond useRemote.
const refreshPage = stage(card.detail)
let refreshTree = await refreshPage.render(detailApi)
const refreshButton = byClass(refreshTree, 'ph-tu-iconbtn')[0]
ok(refreshButton, 'the page offers a refresh button')
is(refreshButton.props.disabled, false, 'refresh is available once the reading settled')
const fetchesBeforeRefresh = remoteCalls.length
refreshButton.props.onClick()
await sleep(25)
refreshTree = await refreshPage.render(detailApi)
ok(remoteCalls.length > fetchesBeforeRefresh, 'refresh re-reads the host')
is(byClass(refreshTree, 'ph-tu-row').length, 4, 'the refreshed page redraws every tool')

// An empty but available host draws the empty row state, not a blank table.
hostDoc = EMPTY_DOC
const emptyPage = stage(card.detail)
tree = await emptyPage.render(detailApi)
is(byClass(tree, 'ph-tu-rows-empty').length, 1, 'an empty host draws the empty row state')
ok(text(tree).includes(t('toolUsage.page.empty')), 'the empty state explains there is nothing yet')
is(byClass(tree, 'ph-tu-row').length, 0, 'an empty host draws no rows')

// An unavailable host renders the empty state and a usable refresh control.
hostDoc = DOC
hostEnvelope = { ok: false, error: { message: 'offline' } }
const downPage = stage(card.detail)
const downTree = await downPage.render(detailApi)
is(byClass(downTree, 'ph-tu-empty').length, 1, 'an unavailable host renders the empty state')
ok(text(downTree).includes(t('toolUsage.unavailable.title')), 'the empty state names the unavailable reading')
ok(text(downTree).includes(t('toolUsage.load.failed', { reason: 'offline' })), 'the empty state carries the transport reason')
is(byClass(downTree, 'ph-tu-iconbtn')[0].props.disabled, false, 'an unavailable host can still be retried')
hostEnvelope = null

// A host that answered with available:false shows its own reason instead.
hostDoc = {
  available: false,
  reason: 'no stored sessions were found',
  totals: { calls: 0, errors: 0, argTokens: 0, outTokens: 0, ms: 0 },
  tools: [],
  projects: [],
}
const reasonPage = stage(card.detail)
const reasonTree = await reasonPage.render(detailApi)
ok(text(reasonTree).includes('no stored sessions were found'), 'the host reason is shown to the reader')
is(byClass(reasonTree, 'ph-tu-empty').length, 1, 'an unavailable answer renders the empty state')

// ---------------------------------------------------------------- housekeeping

globalThis.setInterval = realSetInterval
globalThis.clearInterval = realClearInterval
runtime.call = stubbedCall

console.log('tool-usage-card: ' + checks + ' checks passed')
