/**
 * hygiene-card: the Hygiene card's own behavioural coverage.
 *
 * `test/smoke-client.mjs` proves the framework contract around a card — that it
 * registers, that its preview draws on the wall, that its dictionary is
 * balanced. This file is the Hygiene card's own test: the pure formatters, both
 * entry points, the confirm that guards the one delete action, and the failure
 * paths that must leave the page usable.
 *
 * The host is stubbed at the transport (`runtime.call`) and at the action layer
 * (`api.act`), which is where the card actually talks, so no temp directory is
 * needed here — `test/hygiene-host.mjs` owns the filesystem behaviour.
 *
 * The bundle is loaded the way the browser loads it — `lib/client.js` is read as
 * TEXT and evaluated with `new Function(source)()` — because it legitimately
 * names `module`/`exports` and Node's module-format detection would mangle it.
 * The React object is the harness's own shim; the UI primitives come from
 * test/ui-primitives-stub.mjs, so there is no installed 'react' to import.
 *
 * `useRemote` arms a 120s interval on mount, so `setInterval` is stubbed for the
 * duration of the render phase and restored at the end (the process must exit
 * without a live timer).
 *
 * Run: node test/hygiene-card.mjs
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
    createRoot() { throw new Error('test/hygiene-card.mjs has no DOM root: the bundle is evaluated, not mounted') },
    hydrateRoot() { throw new Error('test/hygiene-card.mjs has no DOM root: the bundle is evaluated, not mounted') },
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
const card = surface.get('hygiene')
ok(card, 'the shipped registry must hold the hygiene card')
is(card.id, 'hygiene', 'the card id must be the one the contract names')
is(card.shipped, true, 'the hygiene card ships with the plugin')
same(card.size, { w: 2, h: 1 }, 'the wall span is the agreed 2x1')
same(card.minSize, { w: 1, h: 1 }, 'a narrow cell still fits the two readings')
same(card.maxSize, { w: 4, h: 3 }, 'the expanded page may grow but stays one column')
is(card.order, 45, 'the card sits after the session card on the wall')
is(card.accent, '#a06a1f', 'the accent is the card\'s own amber, distinct from the neighbours')
same(card.tags, ['storage', 'logs', 'cleanup'], 'the card is discoverable by its tags')
same(card.texture, { icon: 'layers', opacity: 5, size: 118, bleed: '-16%' },
  'the watermark is the layers mark, painted at the house five percent')

const t = (key, params) => mockCtx.locale.bind('homepage')(key, params)

is(card.title(), 'DSH 存储', 'the zh title resolves through the dictionary')
is(card.subtitle, null, 'the card carries no subtitle')
is(t('hygiene.title'), 'DSH 存储', 'the title key is in the card dictionary')
is(t('hygiene.preview.data'), 'DSH 数据', 'the preview names the home it measures')

// The dictionary is the card's whole visible vocabulary: zh and en must name
// exactly the same keys, and every key belongs to this card's namespace.
const dictZh = card.dict && card.dict.zh ? card.dict.zh : {}
const dictEn = card.dict && card.dict.en ? card.dict.en : {}
const zhKeys = Object.keys(dictZh).sort()
const enKeys = Object.keys(dictEn).sort()
same(zhKeys, enKeys, 'zh and en must carry identical key sets')
ok(zhKeys.length >= 33, 'the dictionary must cover the whole card, got ' + zhKeys.length + ' keys')
ok(zhKeys.every((key) => key.indexOf('hygiene.') === 0), 'every key must be namespaced hygiene.*')
ok(zhKeys.every((key) => String(dictZh[key]).trim() !== ''), 'no zh literal may be left empty')
ok(enKeys.every((key) => String(dictEn[key]).trim() !== ''), 'no en literal may be left empty')
ok(zhKeys.includes('hygiene.clean.note'), 'the cleanup explanation is part of the dictionary')
ok(zhKeys.includes('hygiene.clean.confirm'), 'the confirm sentence is part of the dictionary')
same(zhKeys.filter((key) => key === 'hygiene.subtitle' || key === 'hygiene.clean.readonly'), [],
  'the subtitle and the read-only note are gone from both dictionaries')

// The wall order is the card's own registration, not this test's guess.
const wallOrder = module_._internal.orderedCards().map((entry) => entry.id)
ok(wallOrder.includes('hygiene'), 'the hygiene card is on the wall')

// The icon is drawn by the card, not imported: one 24-grid stroke mark. The
// framework calls it from inside a render, and the shim only allows function
// components inside one, so the probe renders it rather than calling it bare.
const iconProbe = stage(function IconProbe() {
  return React.createElement('div', null, card.icon(24))
})
const iconTree = await iconProbe.render({})
const icon = elements(iconTree).find((node) => node.tag === 'svg')
ok(icon, 'the card draws its own icon')
is(icon.props.viewBox, '0 0 24 24', 'the icon lives on the 24 grid every other card uses')
is(icon.props.stroke, 'currentColor', 'the icon takes the surrounding ink')

// ------------------------------------------------------- the pure formatters

const formatBytes = card.raw && card.raw.formatBytes
const summarize = card.raw && card.raw.summarize
ok(typeof formatBytes === 'function', 'the card must expose its pure formatBytes()')
ok(typeof summarize === 'function', 'the card must expose its pure summarize()')

is(formatBytes(0), '0 B', 'nothing reads as zero bytes')
is(formatBytes(512), '512 B', 'a small file stays in bytes')
is(formatBytes(1023), '1023 B', 'the last byte below a kilobyte stays in bytes')
is(formatBytes(1024), '1 KB', 'a kilobyte is the first step')
is(formatBytes(1536), '1.5 KB', 'a fraction of a step keeps one decimal')
is(formatBytes(1048576), '1 MB', 'an exact megabyte drops the trailing zero')
is(formatBytes(1048576 * 2), '2 MB', 'a whole number of megabytes is not padded')
is(formatBytes(4194304), '4 MB', 'the reclaimable fixture formats exactly')
is(formatBytes(100663296), '96 MB', 'a large sum rounds to whole megabytes')
is(formatBytes(1536 * 1024 * 1024), '1.5 GB', 'gigabytes keep one decimal under a hundred')
is(formatBytes(1024 * 1024 * 1024), '1 GB', 'an exact gigabyte is clean')
is(formatBytes(1024 * 1024 * 1024 * 1024), '1 TB', 'terabytes are the last unit')
is(formatBytes(-5), '0 B', 'a negative count is clamped')
is(formatBytes(null), '0 B', 'a missing count is zero')
is(formatBytes(NaN), '0 B', 'a non-number is zero')
is(formatBytes('nope'), '0 B', 'a malformed string is zero')
is(formatBytes('1536'), '1.5 KB', 'a numeric string is accepted')

// ------------------------------------------------------------------- fixtures

const NOW = Date.now()

const CATEGORIES = [
  {
    id: 'sessions',
    path: 'C:\\Users\\me\\.dsh\\sessions',
    exists: true,
    bytes: 52428800,
    files: 640,
    truncated: false,
    reclaimableBytes: 0,
    reclaimableFiles: 0,
  },
  {
    id: 'storages',
    path: 'C:\\Users\\me\\.dsh\\storages',
    exists: true,
    bytes: 31457280,
    files: 180,
    truncated: false,
    reclaimableBytes: 0,
    reclaimableFiles: 0,
  },
  {
    id: 'logs',
    path: 'C:\\Users\\me\\.dsh\\logs',
    exists: true,
    bytes: 6291456,
    files: 64,
    truncated: true,
    reclaimableBytes: 4194304,
    reclaimableFiles: 6,
  },
  {
    id: 'cache',
    path: 'C:\\Users\\me\\.dsh\\cache',
    exists: true,
    bytes: 8388608,
    files: 220,
    truncated: false,
    reclaimableBytes: 0,
    reclaimableFiles: 0,
  },
  {
    id: 'attachments',
    path: 'C:\\Users\\me\\.dsh\\attachments',
    exists: true,
    bytes: 2097152,
    files: 30,
    truncated: false,
    reclaimableBytes: 0,
    reclaimableFiles: 0,
  },
  {
    id: 'profiles',
    path: 'C:\\Users\\me\\.dsh\\profiles',
    exists: false,
    bytes: 0,
    files: 0,
    truncated: false,
    reclaimableBytes: 0,
    reclaimableFiles: 0,
  },
]

const TOTAL_BYTES = 100663296
const TOTAL_FILES = 1134

const DOC = {
  available: true,
  root: 'C:\\Users\\me\\.dsh',
  at: NOW,
  totalBytes: TOTAL_BYTES,
  totalFiles: TOTAL_FILES,
  reclaimableBytes: 4194304,
  reclaimableFiles: 6,
  categories: CATEGORIES,
}

const ZERO_DOC = {
  available: true,
  root: 'C:\\Users\\me\\.dsh',
  at: NOW,
  totalBytes: 31457280,
  totalFiles: 180,
  reclaimableBytes: 0,
  reclaimableFiles: 0,
  categories: [
    { id: 'storages', path: 'x', exists: true, bytes: 31457280, files: 180, truncated: false, reclaimableBytes: 0, reclaimableFiles: 0 },
    { id: 'logs', path: 'x', exists: true, bytes: 4096, files: 2, truncated: false, reclaimableBytes: 0, reclaimableFiles: 0 },
  ],
}

// ------------------------------------------------------ summarize (pure) cases

const reading = summarize(DOC)
is(reading.available, true, 'a live host document is available')
is(reading.totalBytes, TOTAL_BYTES, 'the host total is the hero reading')
is(reading.totalFiles, TOTAL_FILES, 'the host file count is kept')
is(reading.reclaimableBytes, 4194304, 'the reclaimable bytes are kept')
is(reading.reclaimableFiles, 6, 'the reclaimable file count is kept')
is(reading.categoryCount, 6, 'the category count is the row count')
is(reading.largestBytes, 52428800, 'the largest category drives the size bars')
is(reading.categories[5].exists, false, 'a missing category keeps its exists flag')
same(reading.categories.map((row) => row.id),
  ['sessions', 'storages', 'logs', 'cache', 'attachments', 'profiles'],
  'the rows keep the host order')

const noTotals = summarize({ available: true, categories: CATEGORIES })
is(noTotals.totalBytes, TOTAL_BYTES, 'without host totals the rows are summed for bytes')
is(noTotals.totalFiles, TOTAL_FILES, 'without host totals the rows are summed for files')
is(noTotals.reclaimableBytes, 4194304, 'without host totals the rows are summed for reclaimable bytes')
is(noTotals.reclaimableFiles, 6, 'without host totals the rows are summed for reclaimable files')

const declaredWins = summarize({ available: true, totalBytes: 5, totalFiles: 2, reclaimableBytes: 3, reclaimableFiles: 1, categories: CATEGORIES })
is(declaredWins.totalBytes, 5, 'when present the host total wins over the row sum')
is(declaredWins.totalFiles, 2, 'the host file total wins too')
is(declaredWins.reclaimableFiles, 1, 'the host reclaimable count wins too')

const zero = summarize(ZERO_DOC)
is(zero.available, true, 'an empty log bucket is still an available home')
is(zero.reclaimableBytes, 0, 'a clean log bucket has nothing reclaimable')
is(zero.reclaimableFiles, 0, 'a clean log bucket has no files to remove')

const missingRoot = summarize({
  available: false,
  reason: 'the DSH home was not found: C:\\nowhere',
  root: 'C:\\nowhere',
  at: NOW,
  totalBytes: 0,
  totalFiles: 0,
  reclaimableBytes: 0,
  reclaimableFiles: 0,
  categories: [],
})
is(missingRoot.available, false, 'a missing root is unavailable')
is(missingRoot.reason, 'the DSH home was not found: C:\\nowhere', 'the reason survives for the page')
is(missingRoot.loading, false, 'an answered but unavailable host is not loading')
is(missingRoot.totalBytes, 0, 'an unavailable home reads zero bytes')

const loading = summarize(null, null)
is(loading.available, false, 'no document yet is unavailable')
is(loading.loading, true, 'no document and no failure means loading')
is(loading.categoryCount, 0, 'nothing has been counted yet')
is(loading.totalBytes, 0, 'nothing has been measured yet')

const failed = summarize(null, 'offline')
is(failed.loading, false, 'a transport failure stops the loading state')
is(failed.error, 'offline', 'the transport reason is kept')
is(failed.available, false, 'a transport failure is unavailable')

const malformed = summarize({
  available: true,
  categories: [
    null,
    7,
    'x',
    { id: '' },
    { id: 'logs', path: 12, bytes: '64', files: -2, exists: 'yes', truncated: 1, reclaimableBytes: null },
  ],
})
is(malformed.categoryCount, 1, 'only an object with a non-empty id becomes a row')
is(malformed.categories[0].bytes, 64, 'a numeric string is accepted as bytes')
is(malformed.categories[0].files, 0, 'a negative file count is clamped')
is(malformed.categories[0].exists, false, 'a non-boolean exists is not true')
is(malformed.categories[0].truncated, false, 'a non-boolean truncated is not true')
is(malformed.categories[0].path, '12', 'a non-string path is rendered as text')
is(malformed.totalBytes, 64, 'malformed rows still sum cleanly')

const noThrow = summarize('not a document')
is(noThrow.available, false, 'a malformed document is unavailable, not a crash')
is(noThrow.categoryCount, 0, 'a malformed document has no rows')
const arrayDoc = summarize([1, 2, 3])
is(arrayDoc.available, false, 'an array is not a host document')
const badFields = summarize({ available: 'yes', totalBytes: 'many', totalFiles: null, categories: 'nope' })
is(badFields.available, false, 'a truthy non-boolean available is not available')
is(badFields.totalBytes, 0, 'a non-numeric total is zero')
is(badFields.totalFiles, 0, 'a null file total is zero')

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
  return Object.assign(Object.create(surface.cardApi('hygiene')), extra || {})
}

const previewApi = makeApi()
const preview = stage(card.content)
let tree = await preview.render(previewApi)

is(byClass(tree, 'ph-hy-preview').length, 1, 'the preview renders its own body')
same(byClass(tree, 'ph-hy-hero-num').map(textOf), ['96 MB'], 'the hero is the whole DSH home')
ok(text(tree).includes(t('hygiene.preview.data')), 'the hero names what it measures')
same(byClass(tree, 'ph-hy-side-num').map(textOf), ['4 MB'], 'the side is the reclaimable slice')
ok(text(tree).includes(t('hygiene.preview.reclaim')), 'the side names the reclaimable slice')
ok(text(tree).includes(t('hygiene.preview.categories', { count: 6 })), 'the foot states the category count')
ok(text(tree).includes(t('hygiene.files', { count: TOTAL_FILES })), 'the foot states the file count')
is(byClass(tree, 'ph-hy-warn').length, 1, 'a non-empty log bucket raises the warning chip')
ok(text(byClass(tree, 'ph-hy-warn')[0]).includes(t('hygiene.preview.reclaimFiles', { count: 6 })),
  'the chip states how many old logs wait')
is(buttonLikes(tree).length, 0, 'the preview offers no button at all')
is(byClass(tree, 'ph-hy-clean').length, 0, 'the cleanup block belongs to the expanded page')

// A clean log bucket: zero reclaimable, and no warning chip. Each scenario
// mounts a fresh preview because useRemote only re-reads on mount.
hostDoc = ZERO_DOC
const cleanPreview = stage(card.content)
tree = await cleanPreview.render(previewApi)
same(byClass(tree, 'ph-hy-side-num').map(textOf), ['0 B'], 'nothing reclaimable reads as 0 B')
is(byClass(tree, 'ph-hy-warn').length, 0, 'a clean log bucket raises no warning')

// A missing root: zeros and a flag, never a throw.
hostDoc = {
  available: false,
  reason: 'the DSH home was not found: C:\\nowhere',
  root: 'C:\\nowhere',
  at: NOW,
  totalBytes: 0,
  totalFiles: 0,
  reclaimableBytes: 0,
  reclaimableFiles: 0,
  categories: [],
}
const missingPreview = stage(card.content)
tree = await missingPreview.render(previewApi)
same(byClass(tree, 'ph-hy-hero-num').map(textOf), ['0 B'], 'a missing root reads zero bytes')
is(byClass(tree, 'ph-hy-flag').length, 1, 'a missing root raises the flag')
ok(text(tree).includes(t('hygiene.unavailable.title')), 'the flag names the unavailable state')
is(buttonLikes(tree).length, 0, 'an unavailable preview still offers no control')

// No answer yet: the loading line, not a fake zero reading of the home.
hostDoc = DOC
hostPending = true
const loadingPreview = stage(card.content)
tree = await loadingPreview.render(previewApi)
ok(text(tree).includes(t('hygiene.loading')), 'a pending host reads as loading')
is(byClass(tree, 'ph-hy-flag').length, 0, 'loading is not an unavailable state')
hostPending = false

// The card registers its stylesheet once for the lifetime of the panel.
is(registeredCss.length, 1, 'one stylesheet per card, not one per mount')
ok(registeredCss[0].includes('.ph-hy'), 'the stylesheet is the card\'s own')
ok(registeredCss[0].includes('--ph-hy-accent:#a06a1f'), 'the card keeps its accent in a local token')
ok(registeredCss[0].includes('--dsw-alias-label-primary'), 'the card paints with the theme tokens')
ok(registeredCss[0].includes('prefers-reduced-motion'), 'the card honours reduced motion')
ok(registeredCss[0].includes('max-width:760px'), 'the page collapses to one column')
ok(registeredCss[0].includes('@media (hover:hover) and (pointer:fine)'), 'hover only where a pointer is fine')
ok(registeredCss[0].indexOf('@keyframes') < 0, 'the card introduces no animation of its own')

// ----------------------------------------------------------- the expanded page

hostDoc = DOC
const acts = []
let actResult = { ok: true, value: { removed: 6, bytes: 4194304, failed: [] } }
const detailApi = makeApi({
  act(action, payload) {
    acts.push({ action, payload })
    return Promise.resolve(actResult)
  },
})

const detail = stage(card.detail)
tree = await detail.render(detailApi)

is(byClass(tree, 'ph-hy-page').length, 1, 'the expanded page renders its own body')
is(byClass(tree, 'ph-hy-title').length, 0, 'the expanded pane header already names the card, so the body draws no title')
is(byClass(tree, 'ph-hy-sub').length, 0, 'the page carries no summary sentence under the title')
is(byClass(tree, 'ph-hy-row').length, 6, 'the page breaks the home into its six categories')
same(byClass(tree, 'ph-hy-row-name').map(textOf), ['会话', '存储', '日志', '缓存', '附件', '档案'],
  'every row is named in the page language')
same(byClass(tree, 'ph-hy-row-size').map(textOf), ['50 MB', '30 MB', '6 MB', '8 MB', '2 MB', '0 B'],
  'every row carries its own size')
same(byClass(tree, 'ph-stat-value').map(textOf), ['96 MB', '1134', '6', '4 MB'],
  'the stats repeat the four readings the page owns')
same(byClass(tree, 'ph-stat-label').map(textOf), ['总占用', '文件数', '分类', '可清理'],
  'each stat is labelled in the page language')

const logsRow = byClass(tree, 'ph-hy-row').find((row) => String(row.props.title || '').endsWith('logs'))
ok(logsRow, 'the logs row carries its path as a tooltip')
is(byClass(logsRow, 'ph-hy-chip').length, 1, 'the truncated category carries its chip')
is(textOf(byClass(logsRow, 'ph-hy-chip')[0]), t('hygiene.truncated'), 'the chip says the scan was capped')
is(byClass(tree, 'ph-hy-chip').length, 1, 'only the truncated category carries a chip')
is(byClass(logsRow, 'ph-hy-bar')[0].props.children.props.style.width, '12%',
  'the size bar is relative to the largest category')
ok(hasClass(byClass(tree, 'ph-hy-row')[5], 'is-absent'), 'a missing category is drawn, dimmed, with zeros')

// The cleanup block explains exactly what it does before it does anything.
ok(text(tree).includes(t('hygiene.clean.note')), 'the block states the exact delete rule')
ok(text(tree).includes(t('hygiene.clean.counts', { count: 6, size: '4 MB' })), 'the block states what is reclaimable')
is(byClass(tree, 'ph-hy-clean-readonly').length, 0,
  'the block carries no second read-only note under the delete rule')

const cleanButton = byClass(tree, 'ph-hy-btn')[0]
ok(cleanButton, 'the page offers the one cleanup control')
is(textOf(cleanButton), t('hygiene.clean.action'), 'the control is named')
is(cleanButton.props.disabled, false, 'a non-empty log bucket can be cleaned')
is(acts.length, 0, 'drawing the page calls nothing')

// One click asks; it never deletes. The confirm names the exact count and size.
cleanButton.props.onClick()
tree = await detail.render(detailApi)
is(byClass(tree, 'ph-hy-confirm-q').length, 1, 'the first click only enters the confirm')
is(textOf(byClass(tree, 'ph-hy-confirm-q')[0]), t('hygiene.clean.confirm', { count: 6, size: '4 MB' }),
  'the confirm states the count and the size')
is(acts.length, 0, 'entering the confirm deletes nothing')

const confirmButtons = byClass(tree, 'ph-hy-btn')
is(confirmButtons.length, 2, 'the confirm offers exactly two choices')
same(confirmButtons.map(textOf), [t('hygiene.clean.confirmGo'), t('hygiene.clean.cancel')],
  'the confirm offers the action and the way out')
ok(hasClass(confirmButtons[0], 'is-danger'), 'the confirm action is marked as the destructive one')

// Cancelling returns to the single control and calls nothing.
confirmButtons[1].props.onClick()
tree = await detail.render(detailApi)
is(byClass(tree, 'ph-hy-confirm-q').length, 0, 'cancel leaves the confirm')
is(textOf(byClass(tree, 'ph-hy-btn')[0]), t('hygiene.clean.action'), 'cancel restores the one control')
is(acts.length, 0, 'cancel deletes nothing')

// Confirming sends the one payload the action layer accepts, then reloads.
const fetchesBeforeClean = remoteCalls.length
byClass(tree, 'ph-hy-btn')[0].props.onClick()
tree = await detail.render(detailApi)
byClass(tree, 'ph-hy-btn')[0].props.onClick()
await sleep(25)
tree = await detail.render(detailApi)
same(acts, [{ action: 'hygiene.logs.prune', payload: { olderThanDays: 7 } }],
  'the confirm sends the exact action and payload')
ok(remoteCalls.length > fetchesBeforeClean, 'a landed cleanup re-reads the host')
let toast = surface.snapshot().toasts[surface.snapshot().toasts.length - 1]
is(toast.text, t('hygiene.clean.done', { count: 6, size: '4 MB' }), 'a landed cleanup is announced')
is(byClass(tree, 'ph-hy-confirm-q').length, 0, 'a landed cleanup leaves the confirm')
is(textOf(byClass(tree, 'ph-hy-btn')[0]), t('hygiene.clean.action'), 'the single control is back after a cleanup')

// A refused cleanup keeps the page usable: the confirm stays, cancel works,
// and a second attempt can be made without a reload or a stuck spinner.
actResult = { ok: false, error: { message: 'boom' } }
const failedActs = []
const failedApi = makeApi({
  act(action, payload) {
    failedActs.push({ action, payload })
    return Promise.resolve(actResult)
  },
})
const failedPage = stage(card.detail)
let failedTree = await failedPage.render(failedApi)
byClass(failedTree, 'ph-hy-btn')[0].props.onClick()
failedTree = await failedPage.render(failedApi)
byClass(failedTree, 'ph-hy-btn')[0].props.onClick()
await sleep(25)
failedTree = await failedPage.render(failedApi)
toast = surface.snapshot().toasts[surface.snapshot().toasts.length - 1]
is(toast.text, t('hygiene.clean.failed', { reason: 'boom' }), 'a refused cleanup shows the host reason')
is(toast.level, 'error', 'a refused cleanup is an error toast')
is(byClass(failedTree, 'ph-hy-confirm-q').length, 1, 'a refused cleanup keeps the confirm usable')
is(byClass(failedTree, 'ph-hy-btn')[0].props.disabled, false, 'a refused cleanup does not leave the button stuck')
byClass(failedTree, 'ph-hy-btn')[1].props.onClick()
failedTree = await failedPage.render(failedApi)
is(textOf(byClass(failedTree, 'ph-hy-btn')[0]), t('hygiene.clean.action'),
  'the page can leave a failed confirm')
is(failedActs.length, 1, 'one attempt made exactly one call')

// A rejected transport surfaces the same way as a structured failure.
const rejectPage = stage(card.detail)
const rejectApi = makeApi({
  act() {
    return Promise.reject(new Error('offline'))
  },
})
let rejectTree = await rejectPage.render(rejectApi)
byClass(rejectTree, 'ph-hy-btn')[0].props.onClick()
rejectTree = await rejectPage.render(rejectApi)
byClass(rejectTree, 'ph-hy-btn')[0].props.onClick()
await sleep(25)
rejectTree = await rejectPage.render(rejectApi)
toast = surface.snapshot().toasts[surface.snapshot().toasts.length - 1]
is(toast.text, t('hygiene.clean.failed', { reason: 'offline' }), 'a rejected transport shows its message')
is(toast.level, 'error', 'a rejected transport is an error toast')
is(byClass(rejectTree, 'ph-hy-confirm-q').length, 1, 'a rejected transport keeps the confirm usable')

// Nothing reclaimable: the control is present but disabled, and clicking it
// cannot open the confirm or reach the action layer.
hostDoc = ZERO_DOC
const quietPage = stage(card.detail)
let quietTree = await quietPage.render(detailApi)
const quietButton = byClass(quietTree, 'ph-hy-btn')[0]
is(textOf(quietButton), t('hygiene.clean.action'), 'the control still exists with nothing to clean')
is(quietButton.props.disabled, true, 'the control is disabled when nothing is reclaimable')
ok(text(quietTree).includes(t('hygiene.clean.none')), 'the block says there is nothing older than seven days')
quietButton.props.onClick()
quietTree = await quietPage.render(detailApi)
is(byClass(quietTree, 'ph-hy-confirm-q').length, 0, 'a disabled control cannot enter the confirm')
is(acts.length, 1, 'a disabled control never reaches the action layer')

// Refresh asks the host again; it owns no timer of its own beyond useRemote.
hostDoc = DOC
const refreshPage = stage(card.detail)
let refreshTree = await refreshPage.render(detailApi)
const refreshButton = byClass(refreshTree, 'ph-hy-iconbtn')[0]
ok(refreshButton, 'the page offers a refresh button')
is(refreshButton.props.disabled, false, 'refresh is available once the reading settled')
const fetchesBeforeRefresh = remoteCalls.length
refreshButton.props.onClick()
await sleep(25)
refreshTree = await refreshPage.render(detailApi)
ok(remoteCalls.length > fetchesBeforeRefresh, 'refresh re-reads the host')
is(byClass(refreshTree, 'ph-hy-row').length, 6, 'the refreshed page redraws every category')

// An unavailable host renders the empty state and a disabled control.
hostEnvelope = { ok: false, error: { message: 'offline' } }
const downPage = stage(card.detail)
const downTree = await downPage.render(detailApi)
is(byClass(downTree, 'ph-hy-empty').length, 1, 'an unavailable host renders the empty state')
ok(text(downTree).includes(t('hygiene.unavailable.title')), 'the empty state names the unavailable home')
ok(text(downTree).includes(t('hygiene.load.failed', { reason: 'offline' })), 'the empty state carries the transport reason')
is(byClass(downTree, 'ph-hy-btn')[0].props.disabled, true, 'an unavailable host cannot be cleaned')
hostEnvelope = null

// ---------------------------------------------------------------- housekeeping

globalThis.setInterval = realSetInterval
globalThis.clearInterval = realClearInterval
runtime.call = stubbedCall

console.log('hygiene-card: ' + checks + ' checks passed')
