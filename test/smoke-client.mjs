/**
 * smoke-client: load lib/client.js without a browser, drive it under a tiny
 * React shim, and assert the framework contract.
 *
 * This is deliberately not a DOM test. It checks the parts that can only be
 * got wrong in code: the module envelope, the dictionary balance, the two slot
 * registrations, card registration and override, notifications, effects,
 * controls, reorder, and the render tree shape of every shipped card. Visual
 * fidelity still needs the real page; this file proves the wiring.
 *
 * Run: node test/smoke-client.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cardFiles, compose, normalizeEol, readSources } from '../scripts/build-client.mjs'
import { createUiPrimitives } from './ui-primitives-stub.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------------------ React shim

const Fragment = Symbol('Fragment')
const instances = new Map()
const rootInstance = { path: 'root', hooks: [], cursor: 0, childCount: 0 }

let current = rootInstance
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

  // A function component runs eagerly. Its hook slot path is derived from the
  // call order inside its parent, which is what React does with order, too.
  // Hooks also reset when a different component type takes the same position,
  // exactly as React resets state for a different element type.
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
//
// A client bundle may require any module in DSH's platform module table. `react`
// and `react-dom/client` are the harness's own; the primitives package is the
// local stub in test/ui-primitives-stub.mjs. An id outside the table is a bundle
// bug and fails by name, and so does an id inside it that has no stand-in yet —
// handing the bundle `undefined` would only move the failure somewhere useless.

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
  // The real page already owns the React root, so these only have to keep a
  // portal renderable; there is no DOM here to mount one into.
  ['react-dom', () => ({ createPortal: (children) => children, flushSync: (fn) => fn() })],
  ['react-dom/client', () => ({
    createRoot() {
      throw new Error('test/smoke-client.mjs has no DOM root: the bundle is evaluated, not mounted as a page')
    },
    hydrateRoot() {
      throw new Error('test/smoke-client.mjs has no DOM root: the bundle is evaluated, not mounted as a page')
    },
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
    assert.fail(
      'this harness has no stand-in for the DSH platform module ' + JSON.stringify(id)
      + ' yet; add one in test/smoke-client.mjs (test/ui-primitives-stub.mjs shows the shape)',
    )
  }
  if (!platformCache.has(id)) platformCache.set(id, PLATFORM_SHIMS.get(id)())
  return platformCache.get(id)
}

function renderOnce(renderer, props) {
  current = rootInstance
  rootInstance.cursor = 0
  rootInstance.childCount = 0
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
async function settle(renderer, props) {
  let tree = renderOnce(renderer, props)
  for (let pass = 0; pass < 16; pass += 1) {
    await sleep(20)
    if (!rerenderRequested) break
    rerenderRequested = false
    tree = renderOnce(renderer, props)
  }
  return tree
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
const buttons = (tree, label) => elements(tree)
  .filter((node) => node.tag === 'button' && textOf(node).trim() === label)

/** Fire a pointer event the way the browser would. */
const pointer = (type, extra) => Object.assign({ pointerType: 'mouse', type, target: null }, extra || {})

// ---------------------------------------------------------- static preview dump
//
// The assertions above prove the tree is right; they cannot prove it LOOKS
// right. With PH_PREVIEW=<dir> the same settled trees are serialized to HTML
// next to the framework stylesheet, so the real browser can render exactly what
// the panel renders and a screenshot can be judged by eye. Off by default.

const PREVIEW_DIR = process.env.PH_PREVIEW || null

// A realistic session snapshot for the static preview only: the smoke harness
// otherwise has no ui-session service, so the Sessions card would render its
// unavailable state and the wall dump would not show what the card looks like
// in use. Off unless PH_PREVIEW is set.
const PREVIEW_SESSION_STATUS = new Map([
  ['preview-run-a', { running: true }],
  ['preview-wait', { running: true, pendingInteraction: { kind: 'approval' } }],
  ['preview-run-b', { running: true }],
  ['preview-done', { running: false, completionUnread: true }],
])
const PREVIEW_SESSION_LIST = {
  ids: ['preview-wait', 'preview-run-a', 'preview-run-b', 'preview-done'],
  byId: {
    'preview-wait': {
      title: '给会话卡补停止动作',
      cwd: 'D:\\Projects\\demo-app',
      updatedAt: Date.now() - 90_000,
      running: true,
    },
    'preview-run-a': {
      title: '重构知识库检索',
      cwd: 'D:\\Projects\\demo-app',
      updatedAt: Date.now() - 240_000,
      running: true,
    },
    'preview-run-b': {
      title: '搭建 Godot 场景',
      cwd: 'D:\\Projects\\scene-lab',
      updatedAt: Date.now() - 600_000,
      running: true,
    },
    'preview-done': {
      title: '整理 ComfyUI 工作流',
      cwd: 'D:\\Projects\\workflows',
      updatedAt: Date.now() - 3_600_000,
      running: false,
    },
  },
}

/** Props the slot would provide from the real ui-session root hooks. */
function previewSessionHooks() {
  if (!PREVIEW_DIR) return {}
  return {
    useSessionStatus: (select) => select(PREVIEW_SESSION_STATUS),
    useSessions: (select) => select(PREVIEW_SESSION_LIST),
  }
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Serialize a settled vnode tree to HTML, preserving style and aria props. */
function serialize(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(serialize).join('')
  if (typeof node !== 'object' || typeof node.tag !== 'string') return escapeHtml(node)
  const props = node.props || {}
  let attrs = ''
  for (const key of Object.keys(props)) {
    if (key === 'children' || key === 'style' || key === 'ref' || key === 'key') continue
    const value = props[key]
    if (value === null || value === undefined || value === false || typeof value === 'function') continue
    const name = key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key
    if (value === true) { attrs += ' ' + name; continue }
    attrs += ' ' + name + '="' + escapeHtml(value) + '"'
  }
  const style = props.style
  if (style && typeof style === 'object') {
    const declarations = []
    for (const key of Object.keys(style)) {
      const value = style[key]
      if (value === null || value === undefined || value === '') continue
      declarations.push((key.startsWith('--') ? key : key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())) + ':' + value)
    }
    if (declarations.length) attrs += ' style="' + escapeHtml(declarations.join(';')) + '"'
  }
  return '<' + node.tag + attrs + '>' + serialize(props.children) + '</' + node.tag + '>'
}

function dumpPreview(tree, name, options) {
  if (!PREVIEW_DIR) return
  const body = serialize(tree)
  const theme = process.env.PH_PREVIEW_THEME === 'dark' ? 'dark' : 'light'
  // A dump is one settled tree at one width. The sidebar's own two shapes are
  // chosen by a container query on its body, so the narrow shape (a rail) is a
  // different render of the same tree, not a different assertion. A bare region
  // has no width of its own, so without one it stretches to the whole page and
  // the reading it is supposed to prove is unreadable.
  const extra = (options && options.width
    ? '.pv-chrome{width:' + options.width + 'px!important}'
    : '') + (options && options.css ? options.css : '')
  // Software rendering (--disable-gpu) samples an empty backdrop, which turns
  // every frosted surface into a dark slab. Dropping the filter isolates that
  // artifact from a real contrast bug.
  const glass = process.env.PH_PREVIEW_NOGLASS
    ? '<style>.ph-glass{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}</style>'
    : ''
  const html = '<!doctype html><html lang="zh" data-theme="' + theme + '"><head><meta charset="utf-8">' +
    '<title>' + name + '</title>' +
    '<link rel="stylesheet" href="preview.css">' +
    '<style>' + module_.STYLES + '</style>' + glass +
    (extra ? '<style>' + extra + '</style>' : '') +
    '</head><body><div class="pv-page"><div class="pv-chrome"><div class="pv-host" id="host">' + body + '</div></div></div></body></html>'
  mkdirSync(PREVIEW_DIR, { recursive: true })
  // The page links preview.css next to itself, so the sheet has to travel with
  // the dump: without it every --dsw-* token falls back to the framework's dark
  // literal and the light render is meaningless.
  copyFileSync(new URL('./preview.css', import.meta.url), join(PREVIEW_DIR, 'preview.css'))
  writeFileSync(join(PREVIEW_DIR, name + (process.env.PH_PREVIEW_SUFFIX || '') + '.html'), html, 'utf8')
}

// ------------------------------------------------------------- environment shim

let bundleSpec = null
globalThis.window = {
  __ModuleLoader__: { load(spec) { bundleSpec = spec } },
  addEventListener() {},
  removeEventListener() {},
}
// `document.head` is real enough for the one thing the region does with it. The
// report renders its stylesheets inside its own tree, and the sidebar is drawn on
// views where that tree is never mounted, so the region appends its own sheet to
// the head itself. The sheet is marked, and this shim answers the same query the
// region guards on, so installing the region twice must not stack two copies.
const appendedStyles = []
globalThis.document = {
  querySelectorAll: () => [],
  // The expand animation measures its FLIP origin through this selector. The
  // default answers nothing, which is the documented "unmeasurable" path; the
  // expanding section installs rectangles for one assertion. The region's own
  // stylesheet is the one marked sheet this shim knows how to find.
  querySelector: (selector) => (selector === 'style[data-ph-sidebar]' ? appendedStyles[0] || null : null),
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
  head: { appendChild(child) { appendedStyles.push(child) } },
  body: { appendChild() {}, removeChild() {} },
  execCommand: () => true,
}
if (!globalThis.navigator) globalThis.navigator = { clipboard: null }

// The browser fetches the bundle text and evaluates it as a classic script, so
// that is exactly how it is loaded here — Node's own module-format detection
// would otherwise mangle a file that legitimately names `module` and `exports`.
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.notEqual(source.charCodeAt(0), 0xfeff, 'the bundle must not start with a UTF-8 BOM')
assert.ok(source.includes('__ModuleLoader__'), 'the bundle must register with the module loader')
new Function(source)()

assert.ok(bundleSpec, 'client bundle must call window.__ModuleLoader__.load')
assert.equal(bundleSpec.id, 'dsh-homepage', 'bundle id must equal the package name')
assert.equal(typeof bundleSpec.factory, 'function', 'bundle must expose a factory')

// ------------------------------------------------------ sources and freshness
//
// lib/client.js is generated: it is lib/framework.part.js with one module per
// card spliced in. Everything that inspects *text* runs over those sources, and
// the artifact is checked for being exactly what they produce — a hand edit to
// the generated file is a build error, not a change.

const CARD_FILES = cardFiles()
for (const id of ['token', 'network', 'plugin-audit', 'device', 'dsh', 'sidebar', 'sessions', 'projects', 'hygiene', 'skill', 'tool-usage']) {
  assert.ok(CARD_FILES.includes(id + '.js'), 'lib/cards/ must hold the ' + id + ' card module')
}
assert.ok(CARD_FILES.length >= 7, 'the card directory must hold the shipped cards')

const sources = new Map()
sources.set('lib/framework.part.js', await readFile(new URL('../lib/framework.part.js', import.meta.url), 'utf8'))
for (const name of CARD_FILES) {
  sources.set('lib/cards/' + name, await readFile(new URL('../lib/cards/' + name, import.meta.url), 'utf8'))
}

{
  // A generated artifact that drifted from its sources is worth reporting, but
  // it is not a portability defect and it must not fail this suite: git checks
  // the tree out with `eol=lf` while a worktree may hold CRLF, and a line-ending
  // difference says nothing about the code. `npm run check:build` is the command
  // that fails on a genuinely stale artifact.
  const rebuilt = compose(readSources())
  const onDisk = normalizeEol(source)
  const expected = normalizeEol(rebuilt)
  if (onDisk !== expected) {
    const a = onDisk.split('\n')
    const b = expected.split('\n')
    let line = 0
    while (line < Math.max(a.length, b.length) && a[line] === b[line]) line += 1
    console.warn(
      '  warning: lib/client.js does not match lib/framework.part.js + lib/cards/'
      + ' (first difference at line ' + (line + 1) + '; run `npm run build`)\n'
      + '    on disk: ' + String(a[line]).slice(0, 100) + '\n'
      + '    rebuilt: ' + String(b[line]).slice(0, 100),
    )
  } else {
    console.log('  client: lib/client.js matches its sources')
  }
}

// ------------------------------------------------------------------- fixtures

const STATE_FIXTURE = { version: 1, order: [], layout: {}, effects: {}, controls: {}, settings: {} }
const OVERVIEW_FIXTURE = {
  generatedAt: '2026-10-14T15:00:00.000Z',
  sampledAt: '2026-10-14T15:00:00.000Z',
  sampledNow: true,
  currency: 'CNY',
  // The Platform lists wallets in its own order and states them as floats, so a
  // zeroed USD wallet arrives first as `0E-16`. The card must lead with the
  // ledger's primary currency, not with whatever happens to be listed first.
  wallets: [
    { currency: 'USD', balance: '0.00', raw: '0E-16', units: 0 },
    { currency: 'CNY', balance: '3.50', raw: '3.5049999999999999', units: 3500000 },
  ],
  bonusWallets: [{ currency: 'CNY', balance: '2.00', units: 2000000 }],
  today: { day: '2026-10-14', currency: 'CNY', open: '4.73', last: '3.50', spend: '1.23', credit: '0.00', samples: 3, partial: false, carriedFrom: '2026-10-13' },
  history: [
    { day: '2026-10-13', currency: 'CNY', spend: '0.55', samples: 4 },
    { day: '2026-10-12', currency: 'CNY', spend: '2.10', samples: 6 },
    { day: '2026-10-11', currency: 'CNY', spend: '0.00', samples: 1 },
  ],
  // The live account view reports `credential-stored`, not `ready`.
  account: { status: 'credential-stored', links: { usageUrl: 'https://platform.example/usage', topUpUrl: 'https://platform.example/topup' } },
  error: null,
  storage: 'C:\\Users\\me\\.dsh\\storages\\dsh-homepage',
}
const ENVIRONMENT_FIXTURE = {
  capturedAt: '2026-10-14T15:00:00.000Z',
  platform: 'win32',
  arch: 'x64',
  node: 'v22.11.0',
  pid: 4321,
  cwd: 'D:\\Projects\\demo-app',
  dshHome: 'C:\\Users\\me\\.dsh',
  storage: 'C:\\Users\\me\\.dsh\\storages\\dsh-homepage',
  proxyCount: 2,
  proxies: [
    {
      name: 'HTTP_PROXY', kind: 'proxy', spellings: ['HTTP_PROXY', 'http_proxy'],
      raw: 'http://user:secret@127.0.0.1:7890', masked: 'http://***@127.0.0.1:7890',
      protocol: 'http', host: '127.0.0.1', port: 7890, hasAuth: true, empty: false,
    },
    {
      name: 'NO_PROXY', kind: 'bypass', spellings: ['NO_PROXY'],
      raw: 'localhost,127.0.0.1', masked: 'localhost,127.0.0.1',
      protocol: '', host: '', port: 0, hasAuth: false, empty: false,
    },
  ],
  tls: [{ name: 'NODE_EXTRA_CA_CERTS', value: 'C:\\certs\\ca.pem' }],
  redirectors: [],
}

const DEVICE_FIXTURE = {
  at: 1792000000000,
  sampleSeconds: 5.02,
  cpu: {
    usage: 0.23,
    cores: [0.41, 0.12, 0.08, 0.31, 0.19, 0.44, 0.07, 0.15],
    count: 8,
    model: 'AMD Ryzen 7 7840HS with Radeon 780M Graphics',
    speedMhz: 3793,
    loadavg: null,
  },
  memory: {
    total: 34359738368, free: 12884901888, used: 21474836480, usage: 0.625,
    swapTotal: 0, swapFree: 0, swapUsed: 0,
  },
  temperature: { celsius: 61.5, source: 'acpi', reason: null },
  // The GPU is the fourth ceiling: a discrete adapter at 7% load with most of
  // its video memory in use, so the preview has one calm row and one that is
  // under pressure without inventing a second machine.
  gpu: {
    name: 'NVIDIA GeForce RTX 5070',
    vendor: 'nvidia',
    usage: 0.07,
    engine: '3D',
    memory: { used: 10066329600, total: 12884901888, usage: 0.78125 },
    reason: null,
  },
  disk: { path: 'C:\\', total: 1000204886016, free: 402653184000, used: 597551702016, usage: 0.597 },
  system: {
    platform: 'win32', arch: 'x64', release: '10.0.26100', hostname: 'DESKTOP-DEV',
    uptime: 123456, node: 'v22.11.0', cpuModel: 'AMD Ryzen 7 7840HS with Radeon 780M Graphics', drive: 'C:',
  },
  // One sample without a temperature: the series has to skip it rather than
  // chart a zero, which is what a missing sensor reading would look like.
  history: [
    { at: 1791999975000, cpu: 0.18, memory: 0.61, temperature: 59.5 },
    { at: 1791999980000, cpu: 0.31, memory: 0.62, temperature: 60.5 },
    { at: 1791999985000, cpu: 0.12, memory: 0.62, temperature: null },
    { at: 1791999990000, cpu: 0.27, memory: 0.63, temperature: 61.0 },
    { at: 1791999995000, cpu: 0.19, memory: 0.62, temperature: 61.5 },
    { at: 1792000000000, cpu: 0.23, memory: 0.625, temperature: 61.5 },
  ],
}

// The toolchain document: a machine with node, npm, python and git but no pip,
// one extra tool absent, python resolved twice on PATH, and two environment
// roots set. pip is required, so its absence must reach the preview.
const TOOLCHAIN_FIXTURE = {
  at: 1792000000000,
  sampleSeconds: 1.4,
  platform: 'win32',
  ready: 4,
  total: 5,
  found: 4,
  pathEntries: 27,
  pathDuplicates: 1,
  tools: [
    { id: 'node', label: 'Node.js', required: true, found: true, version: 'v24.18.0', path: 'C:\\Program Files\\nodejs\\node.exe', matches: ['C:\\Program Files\\nodejs\\node.exe'], note: null },
    { id: 'npm', label: 'npm', required: true, found: true, version: '10.9.3', path: 'C:\\Program Files\\nodejs\\npm.cmd', matches: ['C:\\Program Files\\nodejs\\npm.cmd'], note: null },
    { id: 'python', label: 'Python', required: true, found: true, version: 'Python 3.12.4 (main, Oct 15 2026, 10:00:00) [MSC v.1944 64 bit (AMD64)]', path: 'C:\\Python312\\python.exe', matches: ['C:\\Python312\\python.exe', 'C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python311\\python.exe'], note: 'many' },
    { id: 'pip', label: 'pip', required: true, found: false, version: null, path: null, matches: [], note: null },
    { id: 'git', label: 'Git', required: true, found: true, version: 'git version 2.43.0.windows.1', path: 'C:\\Program Files\\Git\\cmd\\git.exe', matches: ['C:\\Program Files\\Git\\cmd\\git.exe'], note: null },
    { id: 'pnpm', label: 'pnpm', required: false, found: false, version: null, path: null, matches: [], note: null },
  ],
  env: [
    { key: 'NPM_CONFIG_PREFIX', value: 'C:\\Users\\me\\.npm-global', hint: 'node' },
    { key: 'JAVA_HOME', value: 'C:\\Program Files\\Java\\jdk-21', hint: 'java' },
  ],
  issues: ['missing:pip', 'path-duplicates'],
}

// What the sampler answers when the probe itself threw: every field present,
// no tools, and the failure named in `issues`.
const TOOLCHAIN_DEGRADED = {
  at: 1792000000000,
  sampleSeconds: 0,
  platform: 'win32',
  ready: 0,
  total: 5,
  found: 0,
  pathEntries: 0,
  pathDuplicates: 0,
  tools: [],
  env: [],
  issues: ['sample-error'],
  error: 'spawn EPERM',
}


// The release document for the DSH card. The tag and the name differ on purpose:
// that is how GitHub labels these releases, and it is why the installer needs
// one while the user reads the other.
const DSH_FIXTURE = {
  at: 1792000000000,
  sampleSeconds: 0.9,
  repo: 'deepseek-ai/deepseek-harness',
  branch: 'master',
  head: {
    sha: '86a402200d95fecef4529d969836f1fe13c6cb0d',
    short: '86a4022',
    message: 'Merge pull request #6301 from deepseek-harness/worktree/release-dsh-0',
    author: 'LegGasai',
    date: '2026-10-15T12:22:44Z',
    url: 'https://github.com/deepseek-ai/deepseek-harness/commit/86a402200d95fecef4529d969836f1fe13c6cb0d',
  },
  commits: [
    { sha: '86a402200d95fecef4529d969836f1fe13c6cb0d', short: '86a4022', message: 'Merge pull request #6301', author: 'LegGasai', date: '2026-10-15T12:22:44Z', url: 'https://github.com/deepseek-ai/deepseek-harness/commit/86a402200d95fecef4529d969836f1fe13c6cb0d' },
  ],
  releases: [
    { tag: 'dsh-v0.2.1-alpha.4', name: 'v0.2.1-alpha.4', url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.4', publishedAt: '2026-10-15T13:40:02Z' },
  ],
  release: {
    tag: 'dsh-v0.2.1-alpha.4',
    name: 'v0.2.1-alpha.4',
    url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.4',
    publishedAt: '2026-10-15T13:40:02Z',
  },
  routes: { commits: 'direct', releases: 'direct', head: null },
  cached: false,
  reason: null,
  error: null,
}

// What the root directory holds. The verdict is a comparison against the upstream
// head, so every entry carries the git facts the scan reads: one core is sitting
// exactly on the upstream commit, one is a day behind (and was never built), and
// one is not a DSH checkout at all.
const DSH_LOCAL_FIXTURE = {
  // How this DSH was installed. The card asks the host before it says anything
  // about the upstream: a checkout is the one installation it can update.
  install: { kind: 'source', version: null },
  running: 'D:\\tools\\DSH\\deepseekharness021a3',
  root: 'D:\\tools\\DSH',
  versions: [
    {
      version: 'v0.2.1-alpha.4', name: 'deepseekharness021a3', dir: 'D:\\tools\\DSH\\deepseekharness021a3',
      sha: '86a402200d95fecef4529d969836f1fe13c6cb0d', short: '86a4022',
      commitDate: '2026-10-15T12:22:44Z', branch: 'master', tag: null,
      remote: 'https://github.com/deepseek-ai/deepseek-harness.git', shallow: true, isCore: true,
      exists: true, hasSource: true, hasDeps: true, hasBuild: true, complete: true,
      updatedAt: '2026-10-15T13:52:00.000Z',
    },
    {
      version: 'v0.2.1-alpha.3', name: 'DeepSeekHarness-v0.2.1-alpha.3', dir: 'D:\\tools\\DSH\\DeepSeekHarness-v0.2.1-alpha.3',
      sha: '571902028a75c64c1d767f4ae5fd099485f0ddf0', short: '5719020',
      commitDate: '2026-10-14T13:15:15Z', branch: 'master', tag: 'dsh-v0.2.1-alpha.3',
      remote: 'https://github.com/deepseek-ai/deepseek-harness.git', shallow: true, isCore: true,
      exists: true, hasSource: true, hasDeps: true, hasBuild: false, complete: false,
      updatedAt: '2026-10-13T09:10:00.000Z',
    },
    {
      version: 'v0.2.0', name: 'deepseekharness020rc1', dir: 'D:\\tools\\DSH\\deepseekharness020rc1',
      sha: null, short: null, commitDate: null, branch: null, tag: null,
      remote: null, shallow: false, isCore: false,
      exists: true, hasSource: false, hasDeps: false, hasBuild: false, complete: false,
      updatedAt: null,
    },
  ],
}

// What the installer answers when it managed to open its own window.
const DSH_INSTALL_FIXTURE = {
  started: true,
  reason: null,
  dir: 'D:\\tools\\DSH\\DeepSeekHarness-v0.2.2-alpha.1',
  scriptPath: 'D:\\tools\\DSH\\install-v0.2.2-alpha.1.ps1',
  logPath: 'D:\\tools\\DSH\\install-v0.2.2-alpha.1.log',
  mode: 'window',
  command: 'wt.exe',
  args: ['powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', 'D:\\tools\\DSH\\install-v0.2.2-alpha.1.ps1'],
  pid: 4242,
}

// A fixture that answers the way the live gateway does when the host half has
// not mounted yet, so a card's first poll can be made to fail on purpose.
const TRANSPORT_FAILURE = Symbol('a failed transport')

// What the sidebar hands the panel icon: the projects a session row can belong
// to. The grouping UI is keyed by these ids, so this is the list every
// assignment is drawn from.
const WORKSPACE_SNAPSHOT = {
  items: [
    { workspaceId: 'w-lab', path: 'D:\\Lab\\demo', title: 'demo', sessionIds: ['s-1', 's-2', 's-5'], createdAt: 1, updatedAt: 3 },
    { workspaceId: 'w-work', path: 'D:\\Work\\app', title: 'app', sessionIds: ['s-3'], createdAt: 1, updatedAt: 2 },
    { workspaceId: 'w-notes', path: 'D:\\Notes', title: 'notes', sessionIds: ['s-4'], createdAt: 1, updatedAt: 1 },
  ],
  archivedSessionIds: [],
  pinnedSessionIds: [],
  state: 'idle',
  phase: 'ready',
  error: null,
}

// The session summaries the reporter hands the region alongside the projects:
// the same `useSessions` snapshot the sidebar icon gets, keyed by id. One row is
// running, one is the session the main view holds (that is what makes a row
// current), and one is blank — a session the shell started and nobody named.
const SESSION_BASE = Date.now()
const SESSION_LIST = {
  byId: {
    's-1': { title: '重构测试', running: true, updatedAt: SESSION_BASE - 60000, cwd: 'D:\\\\Lab\\\\demo' },
    's-2': { blank: true, retainedBy: { mainView: 1 }, updatedAt: SESSION_BASE - 120000 },
    's-5': { title: '会议记录', updatedAt: SESSION_BASE - 10800000, cwd: 'D:\\\\Lab\\\\demo' },
    's-3': { title: '发布检查', updatedAt: SESSION_BASE - 600000, cwd: 'D:\\\\Work\\\\app' },
    's-4': { title: '归档笔记', updatedAt: SESSION_BASE - 172800000, cwd: 'D:\\\\Notes' },
  },
}

// The shell's own keyboard registry, as the core publishes it: the three
// session commands a row menu prints keycaps for. The plugin binds no command
// of its own — the core owns those ids — so this catalog is the only place a
// hint or a key handler may take a binding from.
const SHORTCUT_CATALOG = [
  { id: 'session.rename', keys: ['Ctrl', '+', 'Alt', '+', 'G'], aria: 'Control+Alt+G', binding: { code: 'KeyG', modifiers: ['control', 'alt'] } },
  { id: 'session.fork', keys: ['Ctrl', '+', 'Shift', '+', 'F'], aria: 'Control+Shift+F', binding: { code: 'KeyF', modifiers: ['control', 'shift'] } },
  { id: 'session.archive', keys: ['Ctrl', '+', 'Alt', '+', 'A'], aria: 'Control+Alt+A', binding: { code: 'KeyA', modifiers: ['control', 'alt'] } },
]

// The grouping document, already written once: two groups, two projects in them,
// one project loose, and one assignment the sidebar no longer lists (its
// workspace is gone from the snapshot) — the stale entry has to stay visible and
// removable instead of silently disappearing.
const SIDEBAR_LAYOUT_FIXTURE = {
  layout: {
    version: 1,
    mode: 'grouped',
    groups: [
      { id: 'lab', title: '实验室', color: '#0090ff', icon: null, order: 0, collapsed: false },
      { id: 'work', title: 'Work', color: '#46a758', icon: null, order: 1, collapsed: false },
    ],
    members: {
      'w-lab': { group: 'lab', order: 0, color: null, hidden: false, alias: null },
      'w-work': { group: 'work', order: 0, color: null, hidden: false, alias: null },
      'w-gone': { group: 'lab', order: 1, color: null, hidden: false, alias: null },
    },
    view: { showEmpty: false, density: 'cozy', ungroupedTitle: '未分组' },
    updatedAt: 1760540000000,
  },
  at: 1760540000000,
}

// The skill card's own host documents. Six skills, exactly the shape the
// installed pane has to work with: four that reach the model, one the model
// cannot see but `/name` still loads, and one switched off — plus a read-only
// bundled skill and a duplicate, so the flags the pane explains are on screen.
const SKILL_LIST_FIXTURE = {
  generatedAt: 1792000000000,
  dshHome: 'C:\\Users\\me\\.dsh',
  agentsHome: 'C:\\Users\\me\\.agents',
  bundledDir: 'D:\\tools\\DSH\\app\\skills',
  projectRoot: null,
  roots: [
    { id: 'user-dsh', path: 'C:\\Users\\me\\.dsh\\skills', source: 'user-dsh', rank: 400, label: null, writable: true, exists: true, count: 3 },
    { id: 'user-agents', path: 'C:\\Users\\me\\.agents\\skills', source: 'user-agents', rank: 500, label: null, writable: true, exists: true, count: 2 },
    { id: 'bundled', path: 'D:\\tools\\DSH\\app\\skills', source: 'bundled', rank: 600, label: null, writable: false, exists: true, count: 1 },
  ],
  skills: [
    {
      name: 'anti-defensive-writing',
      description: 'Reduce defensive writing in drafts and revisions by removing unnecessary caveats and hedges.',
      whenToUse: null,
      source: 'user-dsh',
      provider: 'filesystem',
      path: 'C:\\Users\\me\\.dsh\\skills\\anti-defensive-writing\\SKILL.md',
      dir: 'C:\\Users\\me\\.dsh\\skills\\anti-defensive-writing',
      kind: 'bundle',
      modelInvocable: true,
      userInvocable: true,
      writable: true,
      shadowedBy: null,
      note: null,
    },
    {
      name: 'claude-paper-study',
      description: 'Use this skill when the user wants to read, study, analyze, or deeply understand a research paper (PDF).',
      whenToUse: null,
      source: 'user-agents',
      provider: 'filesystem',
      path: 'C:\\Users\\me\\.agents\\skills\\claude-paper-study\\SKILL.md',
      dir: 'C:\\Users\\me\\.agents\\skills\\claude-paper-study',
      kind: 'bundle',
      modelInvocable: true,
      userInvocable: true,
      writable: true,
      shadowedBy: null,
      note: null,
    },
    {
      name: 'graphlint',
      description: 'Load for codebase understanding, exploration, and modification — maps the real dependency graph.',
      whenToUse: null,
      source: 'user-agents',
      provider: 'filesystem',
      path: 'C:\\Users\\me\\.agents\\skills\\graphlint\\SKILL.md',
      dir: 'C:\\Users\\me\\.agents\\skills\\graphlint',
      kind: 'bundle',
      modelInvocable: true,
      userInvocable: true,
      writable: true,
      shadowedBy: null,
      note: null,
    },
    {
      name: 'comfyui',
      description: 'Drive ComfyUI through the dsh-comfyui tools: author or import a workflow, then run it.',
      whenToUse: null,
      source: 'user-dsh',
      provider: 'filesystem',
      path: 'C:\\Users\\me\\.dsh\\skills\\comfyui\\SKILL.md',
      dir: 'C:\\Users\\me\\.dsh\\skills\\comfyui',
      kind: 'bundle',
      modelInvocable: true,
      userInvocable: true,
      writable: true,
      shadowedBy: null,
      note: null,
    },
    {
      name: 'old-notes',
      description: 'A skill kept for the occasional manual run; the model no longer sees it.',
      whenToUse: 'Only when the user asks for the old note format.',
      source: 'user-dsh',
      provider: 'filesystem',
      path: 'C:\\Users\\me\\.dsh\\skills\\old-notes\\SKILL.md',
      dir: 'C:\\Users\\me\\.dsh\\skills\\old-notes',
      kind: 'bundle',
      modelInvocable: false,
      userInvocable: true,
      writable: true,
      shadowedBy: null,
      note: null,
    },
    {
      name: 'writing-guard',
      description: 'Scientific manuscript writing, polishing, auditing, and safe Word editing guard.',
      whenToUse: null,
      source: 'bundled',
      provider: 'filesystem',
      path: 'D:\\tools\\DSH\\app\\skills\\writing-guard\\SKILL.md',
      dir: 'D:\\tools\\DSH\\app\\skills\\writing-guard',
      kind: 'bundle',
      modelInvocable: false,
      userInvocable: false,
      writable: false,
      shadowedBy: null,
      note: null,
    },
  ],
  duplicates: [{ name: 'writing-guard', winner: 'bundled', losers: ['user-dsh'] }],
  counts: { total: 6, enabled: 4, userOnly: 1, disabled: 1, writable: 4, invalid: 0 },
  warnings: [],
}

const SKILL_SOURCES_FIXTURE = {
  generatedAt: 1792000000000,
  sources: [
    { id: 'clawhub', label: 'ClawHub', kind: 'registry', home: 'https://clawhub.ai', docs: 'https://docs.openclaw.ai/clawhub/api', reachable: true, note: null, count: null },
    { id: 'github', label: 'GitHub', kind: 'git', home: 'https://github.com/anthropics/skills', docs: null, reachable: true, note: null, count: null },
  ],
}

// Two hits and one failure: a source that is down must not empty the pane, and a
// hit whose name is already installed must not offer a second install.
const SKILL_SEARCH_FIXTURE = {
  query: 'pdf',
  searchedAt: 1792000000000,
  source: 'all',
  results: [
    {
      id: 'clawhub:awspace/pdf',
      source: 'clawhub',
      name: 'pdf',
      displayName: 'Pdf',
      summary: 'Comprehensive PDF manipulation toolkit for extracting text and tables, creating new PDFs, merging and splitting documents, and handling forms.',
      owner: 'awspace',
      version: '1.0.0',
      updatedAt: 1789594554485,
      downloads: 50605,
      stars: 66,
      url: 'https://clawhub.ai/awspace/skills/pdf',
      skillUrl: null,
      install: { kind: 'clawhub', ref: 'awspace/pdf', url: null },
    },
    {
      id: 'github:anthropics/skills/xlsx',
      source: 'github',
      name: 'xlsx',
      displayName: 'Spreadsheets',
      summary: 'Create and edit spreadsheet files, with formula recalculation and formatting.',
      owner: 'anthropics',
      version: null,
      updatedAt: null,
      downloads: null,
      stars: 41200,
      url: 'https://github.com/anthropics/skills/tree/main/xlsx',
      skillUrl: null,
      install: { kind: 'github', ref: 'anthropics/skills/xlsx', url: null },
    },
  ],
  failures: [{ source: 'skillhub', message: 'HTTP 502' }],
  truncated: false,
}

// The content page shows the exact document the Host hands back for one
// installed skill: its frontmatter, the body as plain text (never re-rendered as
// markdown — it is the text the model is handed), and every resource that sits
// beside SKILL.md. `writable` decides whether the page offers the mode control.
const SKILL_CONTENT_FIXTURE = {
  name: 'graphlint',
  path: 'C:\\Users\\me\\.agents\\skills\\graphlint\\SKILL.md',
  dir: 'C:\\Users\\me\\.agents\\skills\\graphlint',
  source: 'user-agents',
  kind: 'bundle',
  writable: true,
  modelInvocable: true,
  userInvocable: true,
  note: null,
  bytes: 1840,
  truncated: false,
  frontmatter: [
    { key: 'name', value: 'graphlint' },
    { key: 'description', value: 'Load for codebase understanding, exploration, and modification.' },
  ],
  body: '# Graphlint\n\nUse the dependency graph to separate live code from dead code.\n\n## Steps\n\n1. Build the index.\n2. Query the graph.\n',
  files: [
    { path: 'reference/queries.md', kind: 'file', bytes: 640 },
    { path: 'scripts', kind: 'dir', bytes: 0 },
    { path: 'scripts/index.sh', kind: 'file', bytes: 210 },
  ],
  reason: null,
}

// The knowledge card's host documents. Five sources over three collections, one
// Agent-written note, one PDF whose extraction failed: the preview draws the
// distribution, and the library pane has one row of every kind to show.
const KNOWLEDGE_NOW = 1792000000000
const KNOWLEDGE_COLLECTIONS = [
  { id: 'inbox', name: '未分类', color: null, system: true, count: 2 },
  { id: 'col_papers', name: '论文', color: '#7c5cff', system: false, count: 2 },
  { id: 'col_tutorials', name: '教程', color: '#2ea043', system: false, count: 2 },
]
const KNOWLEDGE_SOURCES = [
  {
    id: 'src_attention', title: 'Attention Is All You Need', kind: 'pdf', collectionId: 'col_papers',
    tags: ['transformer', 'attention'], origin: 'user', review: 'accepted', status: 'ready',
    originPath: 'D:\\docs\\attention.pdf', bytes: 2213442, chars: 48211, chunks: 54,
    headings: ['1 Introduction', '2 Background', '3 Model Architecture'],
    addedAt: KNOWLEDGE_NOW - 2 * 86400000, indexedAt: KNOWLEDGE_NOW - 2 * 86400000,
    note: null, vector: { status: 'off', model: '', at: null, note: null },
  },
  {
    id: 'src_rag', title: 'Agentic RAG：自适应检索实践', kind: 'md', collectionId: 'col_tutorials',
    tags: ['rag', 'agent'], origin: 'user', review: 'accepted', status: 'ready',
    originPath: 'D:\\notes\\agentic-rag.md', bytes: 28400, chars: 18400, chunks: 22,
    headings: ['检索策略', '多跳与改写', '评估'],
    addedAt: KNOWLEDGE_NOW - 4 * 86400000, indexedAt: KNOWLEDGE_NOW - 4 * 86400000,
    note: null, vector: { status: 'off', model: '', at: null, note: null },
  },
  {
    id: 'src_glass', title: '液态玻璃：材质与排版笔记', kind: 'md', collectionId: 'col_tutorials',
    tags: ['design', 'glass'], origin: 'user', review: 'accepted', status: 'ready',
    originPath: 'D:\\notes\\liquid-glass.md', bytes: 12100, chars: 9210, chunks: 12,
    headings: ['材质', '层级', '排版'],
    addedAt: KNOWLEDGE_NOW - 5 * 86400000, indexedAt: KNOWLEDGE_NOW - 5 * 86400000,
    note: null, vector: { status: 'off', model: '', at: null, note: null },
  },
  {
    id: 'src_note', title: '发布前的检查清单', kind: 'note', collectionId: 'inbox',
    tags: ['release'], origin: 'agent', review: 'pending', status: 'ready',
    originPath: null, bytes: 0, chars: 820, chunks: 3,
    headings: ['检查清单'],
    addedAt: KNOWLEDGE_NOW - 3600000, indexedAt: KNOWLEDGE_NOW - 3600000,
    note: null, vector: { status: 'off', model: '', at: null, note: null },
  },
  {
    id: 'src_scan', title: '扫描版 PDF（解析失败）', kind: 'pdf', collectionId: 'col_papers',
    tags: [], origin: 'user', review: 'accepted', status: 'failed',
    originPath: 'D:\\docs\\scan.pdf', bytes: 18400210, chars: 0, chunks: 0,
    headings: [], addedAt: KNOWLEDGE_NOW - 6 * 86400000, indexedAt: KNOWLEDGE_NOW - 6 * 86400000,
    note: 'pdftotext 没有抽出文本（可能是扫描件）', vector: { status: 'off', model: '', at: null, note: null },
  },
]
const KNOWLEDGE_OVERVIEW_FIXTURE = {
  generatedAt: KNOWLEDGE_NOW,
  storagePath: 'C:\\Users\\me\\.dsh\\storages\\dsh-homepage\\knowledge',
  stats: {
    sources: 5, chunks: 91, chars: 76641, collections: 3, wiki: 2,
    bytes: 22918152, agentSources: 1, failed: 1, pending: 1, drafts: 1,
  },
  channel: { lexical: 'on', vector: 'off', model: '', note: null },
  settings: {
    chunkChars: 900,
    embedding: { enabled: false, baseUrl: '', model: '', hasApiKey: false, timeoutMs: 20000 },
  },
  collections: KNOWLEDGE_COLLECTIONS,
  recent: KNOWLEDGE_SOURCES.slice(0, 5),
  health: { unindexed: 1, failed: 1, unsupported: 0, warnings: [] },
}
const KNOWLEDGE_SOURCES_FIXTURE = {
  total: 5, offset: 0, limit: 100, sources: KNOWLEDGE_SOURCES, collections: KNOWLEDGE_COLLECTIONS,
}
const KNOWLEDGE_SOURCE_FIXTURE = {
  source: KNOWLEDGE_SOURCES[0],
  collections: KNOWLEDGE_COLLECTIONS,
  chunkOutline: [
    { id: 'c1', seq: 0, page: 1, headingPath: ['1 Introduction'], chars: 842, preview: 'The dominant sequence transduction models are based on complex recurrent networks…' },
    { id: 'c2', seq: 1, page: 2, headingPath: ['2 Background'], chars: 918, preview: 'The goal of reducing sequential computation also forms the foundation…' },
    { id: 'c3', seq: 2, page: 3, headingPath: ['3 Model Architecture', '3.1 Encoder and Decoder Stacks'], chars: 1004, preview: 'The encoder is composed of a stack of N = 6 identical layers…' },
    { id: 'c4', seq: 3, page: 4, headingPath: ['3 Model Architecture', '3.2 Attention'], chars: 1120, preview: 'An attention function can be described as mapping a query and a set of key-value pairs…' },
  ],
}
const KNOWLEDGE_READ_FIXTURE = {
  id: 'src_attention', title: 'Attention Is All You Need', chunk: 'c4',
  from: 12840, to: 13960, total: 48211, truncated: true,
  text: 'An attention function can be described as mapping a query and a set of key-value pairs to an output, '
    + 'where the query, keys, values, and output are all vectors. The output is computed as a weighted sum '
    + 'of the values, where the weight assigned to each value is computed by a compatibility function of the '
    + 'query with the corresponding key.',
}
const KNOWLEDGE_SEARCH_FIXTURE = {
  query: '注意力 机制 为什么 有效', mode: 'auto', strategy: 'lexical-deep',
  channels: { lexical: { ok: true, ms: 3, hits: 12 }, vector: { state: 'off', model: '', ms: 0, note: null } },
  results: [
    {
      citation: 'K1', sourceId: 'src_attention', sourceTitle: 'Attention Is All You Need',
      collectionId: 'col_papers', kind: 'pdf', headingPath: ['3 Model Architecture', '3.2 Attention'],
      page: 4, text: 'An attention function can be described as mapping a query and a set of key-value pairs to an output…',
      terms: ['注意力', 'attention'], score: 18.42, relevance: 100, channels: ['lexical'], neighbor: false,
      review: 'accepted', draft: false,
    },
    {
      citation: 'K2', sourceId: 'src_rag', sourceTitle: 'Agentic RAG：自适应检索实践',
      collectionId: 'col_tutorials', kind: 'md', headingPath: ['检索策略'],
      page: null, text: '自适应检索先跑一遍词法检索，命中分数偏低时再改写查询、补充相邻片段。',
      terms: ['检索', '词法'], score: 12.7, relevance: 69, channels: ['lexical'], neighbor: true,
      review: 'accepted', draft: false,
    },
  ],
  total: 12, truncated: false, tookMs: 9, notes: [{ code: 'expanded-query', detail: 'added 3 terms' }],
}
const KNOWLEDGE_WIKI_FIXTURE = {
  pages: [
    {
      id: 'wiki_papers', title: '论文阅读地图', collectionId: 'col_papers', origin: 'compiled',
      generator: 'reading-map-v1', sourceIds: ['src_attention'], createdAt: KNOWLEDGE_NOW, updatedAt: KNOWLEDGE_NOW,
      chars: 4210,
      sections: [
        { heading: 'Attention Is All You Need', body: '一篇把序列建模从循环结构换成自注意力的论文。\n关键词：transformer、attention、encoder。' },
        { heading: '关键词', body: 'transformer · attention · encoder · decoder · self-attention' },
      ],
    },
  ],
}
const KNOWLEDGE_SETTINGS_FIXTURE = {
  settings: KNOWLEDGE_OVERVIEW_FIXTURE.settings,
  channel: KNOWLEDGE_OVERVIEW_FIXTURE.channel,
}
// The curation session the card can start from the draft banner. The default
// fixture is mid-run so the wall's expanded dump has a progress panel; a test
// can swap it for the done/failed shape.
const KNOWLEDGE_CURATION_FIXTURE = {
  curation: {
    id: 'cur_smoke', state: 'running', stage: 'reading',
    detail: '整理会话正在读草稿与来源…',
    draftIds: ['src_note'],
    session: { id: 'knowledge-curate-smoke', title: '知识整理：1 条草稿' },
    decisions: [], summary: null,
    startedAt: KNOWLEDGE_NOW, updatedAt: KNOWLEDGE_NOW,
  },
}

const PROJECTS_NOW = Date.parse('2026-10-18T08:00:00Z')
const PROJECTS_FIXTURE = {
  available: true,
  at: PROJECTS_NOW,
  summary: { total: 4, dirty: 2, live: 3, running: 2, worktrees: 1, missing: 1 },
  projects: [
    {
      id: 'ws-personal', title: 'dsh-homepage', path: 'D:\\Projects\\demo-app',
      status: 'ok', sessions: 3, live: 2, running: 1,
      git: { repo: true, branch: 'main', dirty: 2, ahead: 1, behind: 0, worktrees: 1,
        lastCommit: { hash: '3d6b8ac', at: PROJECTS_NOW - 3600000, subject: 'Add the projects card and its host reader' } },
    },
    {
      id: 'ws-scene', title: 'scene-lab', path: 'D:\\Projects\\scene-lab',
      status: 'ok', sessions: 2, live: 1, running: 1,
      git: { repo: true, branch: 'feature/terrain', dirty: 0, ahead: 0, behind: 3, worktrees: 0,
        lastCommit: { hash: '9f21c40', at: PROJECTS_NOW - 7200000, subject: 'Bake the terrain normals' } },
    },
    {
      id: 'ws-workflows', title: 'workflows', path: 'D:\\Projects\\workflows',
      status: 'ok', sessions: 1, live: 0, running: 0,
      git: { repo: true, branch: 'main', dirty: 5, ahead: 0, behind: 0, worktrees: 0,
        lastCommit: { hash: '61ab0d2', at: PROJECTS_NOW - 21600000, subject: 'Add the ComfyUI batch runner' } },
    },
    {
      id: 'ws-notes', title: 'notes', path: 'D:\\Projects\\notes',
      status: 'missing-dir', sessions: 0, live: 0, running: 0, git: null,
    },
  ],
}

const HYGIENE_FIXTURE = {
  available: true,
  root: 'C:\\Users\\me\\.dsh',
  at: PROJECTS_NOW,
  totalBytes: 1284000000,
  totalFiles: 8421,
  reclaimableBytes: 18000000,
  reclaimableFiles: 120,
  categories: [
    { id: 'sessions', path: 'C:\\Users\\me\\.dsh\\sessions', exists: true, bytes: 610000000, files: 2600, truncated: false, reclaimableBytes: 0, reclaimableFiles: 0 },
    { id: 'storages', path: 'C:\\Users\\me\\.dsh\\storages', exists: true, bytes: 512000000, files: 4100, truncated: false, reclaimableBytes: 0, reclaimableFiles: 0 },
    { id: 'logs', path: 'C:\\Users\\me\\.dsh\\logs', exists: true, bytes: 18000000, files: 120, truncated: false, reclaimableBytes: 18000000, reclaimableFiles: 120 },
    { id: 'cache', path: 'C:\\Users\\me\\.dsh\\cache', exists: true, bytes: 140000000, files: 800, truncated: true, reclaimableBytes: 0, reclaimableFiles: 0 },
    { id: 'attachments', path: 'C:\\Users\\me\\.dsh\\attachments', exists: true, bytes: 4000000, files: 30, truncated: false, reclaimableBytes: 0, reclaimableFiles: 0 },
    { id: 'profiles', path: 'C:\\Users\\me\\.dsh\\profiles', exists: true, bytes: 2000000, files: 40, truncated: false, reclaimableBytes: 0, reclaimableFiles: 0 },
  ],
}

const RUNS_FIXTURE = {
  available: true,
  at: PROJECTS_NOW,
  path: 'C:\\Users\\me\\.dsh\\storages\\dsh-homepage\\runs.json',
  summary: { total: 4, active: 3, running: 1, review: 1, blocked: 1, paused: 0, planning: 0, done: 1, failed: 0, archived: 0, tasksOpen: 4, mergeReady: 1 },
  runs: [
    {
      id: 'run-wire-runs', title: 'Wire the runs card into the host', status: 'running',
      projectId: 'ws-personal', projectName: 'dsh-homepage', projectPath: 'D:\\Projects\\demo-app',
      branch: 'runs-card', worktree: 'D:\\Projects\\demo-app\\.agents\\worktrees\\runs-card',
      baseCommit: 'cb81dc3', owner: 'lead', note: '',
      tasks: [
        { id: 't1', title: 'Ledger', status: 'done', owner: 'ledger-dev', createdAt: PROJECTS_NOW - 7200000, updatedAt: PROJECTS_NOW - 3600000 },
        { id: 't2', title: 'Card', status: 'running', owner: 'card-dev', createdAt: PROJECTS_NOW - 7200000, updatedAt: PROJECTS_NOW - 600000 },
        { id: 't3', title: 'Integrate', status: 'pending', owner: 'lead', createdAt: PROJECTS_NOW - 7200000, updatedAt: PROJECTS_NOW - 7200000 },
      ],
      tests: { status: 'pending', command: 'npm test', at: 0 },
      merge: { state: 'pending', commit: '' },
      createdAt: PROJECTS_NOW - 7200000, updatedAt: PROJECTS_NOW - 600000,
      progress: { done: 1, total: 3 },
      git: { branch: 'runs-card', dirty: 2, ahead: 0, behind: 0 },
      worktreeExists: true,
    },
    {
      id: 'run-hygiene', title: 'Hygiene log retention review', status: 'review',
      projectId: 'ws-personal', projectName: 'dsh-homepage', projectPath: 'D:\\Projects\\demo-app',
      branch: 'hygiene-card', worktree: '', baseCommit: 'cb81dc3', owner: 'hygiene-dev', note: '',
      tasks: [{ id: 't1', title: 'Scanner', status: 'done', owner: 'hygiene-dev', createdAt: PROJECTS_NOW - 86400000, updatedAt: PROJECTS_NOW - 43200000 }],
      tests: { status: 'pass', command: 'node test/hygiene-host.mjs', at: PROJECTS_NOW - 1800000 },
      merge: { state: 'ready', commit: '' },
      createdAt: PROJECTS_NOW - 86400000, updatedAt: PROJECTS_NOW - 1800000,
      progress: { done: 1, total: 1 },
      git: { branch: 'hygiene-card', dirty: 0, ahead: 1, behind: 0 },
      worktreeExists: true,
    },
    {
      id: 'run-godot', title: 'Bake the terrain normals', status: 'blocked',
      projectId: 'ws-scene', projectName: 'scene-lab', projectPath: 'D:\\Projects\\scene-lab',
      branch: 'feature/terrain', worktree: '', baseCommit: '9f21c40', owner: 'scene-dev', note: 'Waiting on a texture export',
      tasks: [{ id: 't1', title: 'Export normals', status: 'blocked', owner: 'scene-dev', createdAt: PROJECTS_NOW - 172800000, updatedAt: PROJECTS_NOW - 9000000 }],
      tests: { status: 'fail', command: 'godot --headless', at: PROJECTS_NOW - 9000000 },
      merge: { state: 'pending', commit: '' },
      createdAt: PROJECTS_NOW - 172800000, updatedAt: PROJECTS_NOW - 9000000,
      progress: { done: 0, total: 1 },
      git: null,
      worktreeExists: false,
    },
    {
      id: 'run-notes', title: 'Publish the reading notes', status: 'done',
      projectId: 'ws-notes', projectName: 'notes', projectPath: 'D:\\Projects\\notes',
      branch: 'main', worktree: '', baseCommit: '61ab0d2', owner: 'lead', note: '',
      tasks: [{ id: 't1', title: 'Write', status: 'done', owner: 'lead', createdAt: PROJECTS_NOW - 259200000, updatedAt: PROJECTS_NOW - 172800000 }],
      tests: { status: 'pass', command: 'npm test', at: PROJECTS_NOW - 172800000 },
      merge: { state: 'merged', commit: '61ab0d2' },
      createdAt: PROJECTS_NOW - 259200000, updatedAt: PROJECTS_NOW - 172800000,
      progress: { done: 1, total: 1 },
      git: { branch: 'main', dirty: 0, ahead: 0, behind: 0 },
      worktreeExists: true,
    },
  ],
}

const FIXTURES = {
  'homepage/state': STATE_FIXTURE,
  'homepage/saveState': { updatedAt: '2026-10-14T15:00:01.000Z' },
  'homepage/refresh': OVERVIEW_FIXTURE,
  'homepage/overview': OVERVIEW_FIXTURE,
  'homepage/environment': ENVIRONMENT_FIXTURE,
  'homepage/device': DEVICE_FIXTURE,
  'homepage/hygiene': HYGIENE_FIXTURE,
  'homepage/projects': PROJECTS_FIXTURE,
  'homepage/runs': RUNS_FIXTURE,
  'homepage/toolchain': TOOLCHAIN_FIXTURE,
  'homepage/dsh': DSH_FIXTURE,
  'homepage/dshLocal': DSH_LOCAL_FIXTURE,
  'homepage/dshInstall': DSH_INSTALL_FIXTURE,
  'homepage/sidebarLayout': SIDEBAR_LAYOUT_FIXTURE,
  'homepage/saveSidebarLayout': SIDEBAR_LAYOUT_FIXTURE,
  // The card re-attaches to an unfinished audit on every render, so the default
  // is the honest empty answer: no review has ever run. The plugin-audit section
  // below swaps these for the audit it is exercising.
  'homepage/pluginAuditList': { audits: [] },
  'homepage/pluginAuditStatus': null,
  'homepage/pluginAuditModels': {
    defaultSelection: { provider: 'test', model: 'reviewer' },
    models: [{ provider: 'test', model: 'reviewer', name: 'Reviewer', efforts: [{ id: 'high', name: 'High' }] }],
  },
  'homepage/skillList': SKILL_LIST_FIXTURE,
  'homepage/skillSetEnabled': { ok: true, name: 'old-notes', mode: 'on', counts: SKILL_LIST_FIXTURE.counts, skills: SKILL_LIST_FIXTURE.skills },
  'homepage/skillContent': SKILL_CONTENT_FIXTURE,
  'homepage/skillSources': SKILL_SOURCES_FIXTURE,
  'homepage/skillSearch': SKILL_SEARCH_FIXTURE,
  'homepage/skillDetail': { id: 'clawhub:awspace/pdf', source: 'clawhub', name: 'pdf', version: '1.0.0', summary: SKILL_SEARCH_FIXTURE.results[0].summary, readme: null, files: ['SKILL.md', 'references/forms.md'], skillMd: null, install: { kind: 'clawhub', ref: 'awspace/pdf', url: null } },
  'homepage/skillInstall': { ok: true, name: 'pdf', source: 'clawhub', ref: 'awspace/pdf', root: 'C:\\Users\\me\\.dsh\\skills', dir: 'C:\\Users\\me\\.dsh\\skills\\pdf', files: 2, bytes: 18422, skill: SKILL_LIST_FIXTURE.skills[0], counts: SKILL_LIST_FIXTURE.counts },
  // The knowledge card's own surface. Every fetch the card makes has an answer
  // here, so the wall preview and the expanded dumps draw a real library rather
  // than a column of transport errors.
  'homepage/knowledgeOverview': KNOWLEDGE_OVERVIEW_FIXTURE,
  'homepage/knowledgeSources': KNOWLEDGE_SOURCES_FIXTURE,
  'homepage/knowledgeSource': KNOWLEDGE_SOURCE_FIXTURE,
  'homepage/knowledgeRead': KNOWLEDGE_READ_FIXTURE,
  'homepage/knowledgeAdd': {
    added: [KNOWLEDGE_SOURCES[3]], duplicates: [], skipped: [], failed: [], collections: KNOWLEDGE_COLLECTIONS,
  },
  'homepage/knowledgeRemove': { ok: true, id: 'src_note', collections: KNOWLEDGE_COLLECTIONS },
  'homepage/knowledgeReindex': { ok: true, sources: KNOWLEDGE_SOURCES, failed: [] },
  'homepage/knowledgeSearch': KNOWLEDGE_SEARCH_FIXTURE,
  'homepage/knowledgeCollections': { collections: KNOWLEDGE_COLLECTIONS },
  'homepage/knowledgeSettings': KNOWLEDGE_SETTINGS_FIXTURE,
  'homepage/knowledgeWiki': KNOWLEDGE_WIKI_FIXTURE,
  'homepage/knowledgeReview': {
    source: { ...KNOWLEDGE_SOURCES[3], review: 'accepted', reviewedAt: KNOWLEDGE_NOW, reviewedBy: 'user' },
    collections: KNOWLEDGE_COLLECTIONS,
  },
  'homepage/knowledgeCurateStart': KNOWLEDGE_CURATION_FIXTURE,
  'homepage/knowledgeCurateStatus': KNOWLEDGE_CURATION_FIXTURE,
  'homepage/knowledgeCurateList': { curations: [KNOWLEDGE_CURATION_FIXTURE.curation] },
}

// The argument shape every endpoint demands, taken from the Host half's real
// Typert descriptors rather than retyped here. This is the contract the live
// gateway enforces: a client that sends `{ historyDays }` where the descriptor
// declares `{ options }` gets
//   "args fields do not match the descriptor: unexpected "historyDays""
// and the card renders an error instead of data.
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
const DESCRIPTOR_IDS = Object.keys(DESCRIPTOR_PARAMS).sort()
const SHIPPED_ENDPOINTS = [
  'homepage/device', 'homepage/dsh', 'homepage/dshCheck', 'homepage/dshInstall',
  'homepage/dshLocal', 'homepage/environment', 'homepage/hygiene', 'homepage/overview',
  'homepage/projects', 'homepage/refresh',
  'homepage/saveSidebarLayout', 'homepage/saveState', 'homepage/sidebarLayout',
  'homepage/state',
]
// The skill card's host surface. The descriptor guard below is what keeps the
// card's `{ options: … }` argument shape honest: the live gateway refuses any
// other spelling, so a card that sends a bare object passes local fixtures and
// fails in the browser.
const SKILL_ENDPOINTS = [
  'homepage/skillList', 'homepage/skillSetEnabled', 'homepage/skillSources',
  'homepage/skillSearch', 'homepage/skillDetail', 'homepage/skillInstall',
]
// The plugin-audit quartet is what the audit card is nothing without: the card
// is a client for these four, and the guard below is only worth anything while
// their declared argument names are the ones the card actually sends.
const AUDIT_ENDPOINTS = [
  'homepage/pluginAuditStart', 'homepage/pluginAuditStatus',
  'homepage/pluginAuditList', 'homepage/pluginAuditDecide',
]
for (const id of SHIPPED_ENDPOINTS.concat(AUDIT_ENDPOINTS).concat(SKILL_ENDPOINTS)) {
  assert.ok(DESCRIPTOR_IDS.includes(id), 'the host descriptors must declare ' + id + ', otherwise the argument guard below is vacuous')
}
assert.ok(DESCRIPTOR_IDS.every((id) => id.startsWith('homepage/')), 'every descriptor must live in the homepage namespace')
assert.deepEqual(
  DESCRIPTOR_PARAMS['homepage/pluginAuditStart'].slice().sort(),
  ['options'],
  'the audit start endpoint takes the one options object the card sends',
)
assert.deepEqual(DESCRIPTOR_PARAMS['homepage/pluginAuditList'], [], 'the audit list takes no arguments')
assert.deepEqual(
  DESCRIPTOR_PARAMS['homepage/pluginAuditStatus'].slice().sort(),
  ['options'],
  'the audit status endpoint takes the one options object the card polls with',
)
assert.deepEqual(
  DESCRIPTOR_PARAMS['homepage/pluginAuditDecide'].slice().sort(),
  ['options'],
  'the audit decision endpoint takes the one options object the card sends',
)

// ------------------------------------------------------------------- mock ctx

const calls = []
const registrations = []
const cleanupLabels = []
let dictionaries = null
let injectKey = null

const mockCtx = {
  slots: {
    inject(name, callback) {
      // The callback registers through `register` below (the live shape is
      // `inject(key, () => register(...))`), and the registry records that call.
      // Nothing is recorded here, or every entry would be counted twice.
      injectKey = name
      try {
        callback()
      } finally {
        injectKey = null
      }
      return () => {}
    },
    register(opts, render) {
      // The live registry returns the disposer for the registration; mirroring
      // that here is what lets a test see the sidebar region change hands.
      const entry = { slotName: (opts && opts.name) || injectKey, opts, render }
      registrations.push(entry)
      return () => {
        const at = registrations.indexOf(entry)
        if (at >= 0) registrations.splice(at, 1)
      }
    },
  },
  connection: {
    rpc: {
      async call(channel, endpoint, payload) {
        calls.push({ channel, endpoint, payload })
        const declared = DESCRIPTOR_PARAMS[endpoint]
        if (declared) {
          const args = (payload && payload.args) || {}
          const got = Object.keys(args).sort().join(',')
          const want = declared.slice().sort().join(',')
          if (got !== want) {
            // Exactly what the live Typert gateway answers. Local fixtures ignore
            // the arguments, so without this check a client that sends the wrong
            // field names still passes here and fails only in the browser.
            return {
              ok: false,
              error: { message: 'typert gateway: ' + endpoint + ': args fields do not match the descriptor: unexpected "' + got + '"' },
            }
          }
        }
        if (FIXTURES[endpoint] === TRANSPORT_FAILURE) {
          return { ok: false, error: { message: 'transport failure for /api/' + endpoint + ': HTTP 404' } }
        }
        const value = FIXTURES[endpoint]
        if (value === undefined) return { ok: false, error: { message: 'no fixture for ' + endpoint } }
        return { ok: true, value }
      },
    },
  },
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
  effect(fn, label) {
    const cleanup = fn()
    cleanupLabels.push(label)
    return typeof cleanup === 'function' ? cleanup : () => {}
  },
}

// --------------------------------------------- the shipped workspace services
//
// The region drives `sessions`, `workspaces` and `uiWorkspace` by name: it reads
// them off the context through `serviceOf` (framework.part.js:3964) rather than
// through slot props, so the harness has to hand them to the context and not to a
// render. Recording stand-ins prove the wiring instead of assuming it — which
// method, with which arguments, and, for a control that must ask first, that
// nothing reaches the host until the second click.
const SERVICE_CALLS = []
const SERVICE_FAILURES = []

/** Record one call to a shipped service. */
function recordService(service, method, args) {
  SERVICE_CALLS.push({ service, method, args })
}

/** @returns every recorded call to one method of one service. */
function serviceCallsTo(service, method) {
  return SERVICE_CALLS.filter((call) => call.service === service && call.method === method)
}

/** @returns the last recorded call to one method of one service, or undefined. */
function lastServiceCall(service, method) {
  const found = serviceCallsTo(service, method)
  return found[found.length - 1]
}

/** Arm the next call to one method to fail the way a dead host fails. */
function failNextAction(service, method) {
  SERVICE_FAILURES.push(service + '.' + method)
}

/**
 * A stand-in for one shipped service. Every method records its arguments and
 * answers with the outcome the test declared for it, so both the call and what
 * the region drew from the answer can be asserted.
 * @param service - the service name.
 * @param outcomes - `{ method: (...args) => answer }`.
 */
function stubService(service, outcomes) {
  const stub = {}
  for (const method of Object.keys(outcomes)) {
    stub[method] = function (...args) {
      const armed = SERVICE_FAILURES.indexOf(service + '.' + method)
      if (armed !== -1) {
        SERVICE_FAILURES.splice(armed, 1)
        throw new Error('boom from ' + service + '.' + method)
      }
      recordService(service, method, args)
      return Promise.resolve(outcomes[method](...args))
    }
  }
  return stub
}

// One real hit, so the result row has a session the projection can name. The
// second query matches a subagent Session on purpose: the host search returns
// it like any other hit, and the list has to drop it itself.
const SEARCH_HITS = {
  '发布': [{ sessionId: 's-3', snippet: '在 app 里聊发布检查的那一次' }],
  '子智能体': [{ sessionId: 'm-sub-member', snippet: '一个子智能体的日志' }],
}

const shippedServices = {
  workspaces: stubService('workspaces', {
    rename: () => null,
    delete: () => null,
    // The Host answers a registration with the workspace it made — the same
    // `WorkspaceView` the real service returns: an id, a title, the path, and
    // the instants the list orders by.
    create: (input) => ({
      workspaceId: 'w-fresh',
      path: input && input.path,
      title: 'Picked Folder',
      sessionIds: [],
      createdAt: new Date(SESSION_BASE).toISOString(),
      updatedAt: new Date(SESSION_BASE).toISOString(),
    }),
  }),
  sessions: stubService('sessions', {
    fork: () => null,
    search: (query) => SEARCH_HITS[query] || [],
    // The real `using` hands the callback a reference to the Session; the
    // rename lives on the session the reference binds, which is the call a
    // rename has to reach.
    using: (id, options, consumer) => {
      if (typeof consumer === 'function') {
        consumer({
          binding: {
            session: {
              rename: (title) => {
                recordService('sessions', 'rename', [id, title])
                return Promise.resolve({ ok: true })
              },
            },
          },
        })
      }
      return Promise.resolve({ ok: true })
    },
  }),
  uiWorkspace: stubService('uiWorkspace', {
    openWorkspace: () => null,
    openSession: () => null,
    startSession: () => null,
    pickDirectory: () => 'D:\\Picked\\fresh',
    archiveSession: () => null,
    unarchiveSession: () => null,
    pinSession: () => null,
    unpinSession: () => null,
  }),
  // The shell's shortcut registry: a row reads the effective binding for a
  // command out of its catalog rather than inventing one of its own.
  shortcuts: {
    catalog: { getSnapshot: () => SHORTCUT_CATALOG, subscribe: () => () => {} },
  },
  // The Session remote namespace, under the name the shell provides it as: the
  // one call a "show in folder" needs.
  'remote.session': stubService('remoteSession', {
    openWorkspacePath: () => ({ opened: true }),
  }),
  // The shell's own sidebar service. The region draws an icon-only shape while
  // the sidebar is narrow, so widening it is the one control that is not the
  // region's own business.
  layout: stubService('layout', {
    toggleSidebar: () => null,
  }),
}
// `ctx.get` is the lookup `serviceOf` prefers; the plain properties below it are
// the fallback, and returning them from a context that has neither is what the
// read-only path of the region is for.
mockCtx.get = (name) => shippedServices[name] || null

// --------------------------------------------------------------------- apply

// Every id the bundle requires is checked against the platform table above.
const module_ = bundleSpec.factory(platformModule)

assert.equal(module_.name, 'dsh-homepage')
assert.ok(Array.isArray(module_.inject), 'inject must be an array')
for (const service of ['slots', 'connection', 'locale']) {
  assert.ok(module_.inject.includes(service), 'inject must declare ' + service)
}
assert.equal(typeof module_.apply, 'function')

module_.apply(mockCtx)

// The registrations apply makes itself: the sidebar icon, the main panel, the
// occupant of the workspace region, and the Plugins-page settings card — the
// default document asks for the grouped list, so the region changes hands
// during apply. Nothing goes into a Session row: the shipped row keeps the
// options it shipped with.
assert.equal(registrations.length, 4, 'apply must register the icon, the panel, the region occupant and the settings card')
const sidebar = registrations.find((entry) => entry.slotName === 'sidebar.panellist')
const main = registrations.find((entry) => entry.slotName === 'main')
assert.ok(sidebar, 'a sidebar.panellist entry must be registered')
assert.ok(main, 'a main entry must be registered')
assert.equal(sidebar.opts.id, 'homepage')
assert.equal(main.opts.key, 'homepage')
assert.equal(main.opts.locale, 'homepage')
assert.equal(typeof sidebar.opts.label, 'function')
assert.deepEqual(
  registrations.map((entry) => entry.slotName).sort(),
  ['main', 'plugins.row.config', 'sidebar.panellist', 'sidebar.workspaces'],
  'the plugin registers only its own icon, its own card wall, the workspace region and its Plugins settings card',
)
// The Plugins page finds a row's configuration by `<package>#<row id>`; the
// registration key is what makes the switch reachable at all.
const settingsCard = registrations.find((entry) => entry.slotName === 'plugins.row.config')
assert.ok(settingsCard, 'the Plugins-page settings card must be registered')
assert.equal(settingsCard.opts.key, 'dsh-homepage#dsh-homepage', 'the settings card key is the row configuration key')
assert.equal(settingsCard.opts.locale, 'homepage', 'the settings card translates through the plugin namespace')

// The card must use DSH's own primitives — the same Switch and segmented control
// the Plugins page renders with — so it does not look like a foreign form.
const settingsHtml = serialize(settingsCard.render({
  view: 'page',
  form: {
    state: {
      status: 'ready', writable: true, revision: 3,
      value: { exposeTool: false, toolLanguage: 'auto' },
    },
    mutate: () => Promise.resolve(true),
  },
}))
assert(settingsHtml.includes('role="switch"'), 'the tool switch is the DSH switch (got: ' + settingsHtml.slice(0, 160) + ')')
assert(settingsHtml.includes('role="tablist"'), 'the language control is the DSH segmented control')
assert(settingsHtml.includes('data-value="auto"') && settingsHtml.includes('data-value="en"'), 'every language option renders')
const settingsSummary = serialize(settingsCard.render({
  view: 'summary',
  form: { state: { status: 'ready', writable: true, revision: 3, value: { exposeTool: false } } },
}))
assert(settingsSummary.length > 0, 'the row summary renders one line')
const occupant = registrations.find((entry) => entry.slotName === 'sidebar.workspaces')
assert.ok(occupant, 'the default document must hand the workspace region to the grouped list')
assert.equal(occupant.opts.id, 'sidebar-projects')
assert.equal(
  occupant.opts.priority,
  -1,
  'the shipped list registers at the default priority 0, so taking the slot over has to go below it',
)

// Dictionaries must be balanced so the locale service accepts them.
assert.ok(dictionaries, 'dictionaries must be registered')
assert.equal(dictionaries.namespace, 'homepage')
const zhKeys = Object.keys(dictionaries.dicts.zh).sort()
const enKeys = Object.keys(dictionaries.dicts.en).sort()
assert.deepEqual(zhKeys, enKeys, 'zh and en dictionaries must have identical key sets')
assert.ok(zhKeys.length > 60, 'dictionaries should cover the whole UI, got ' + zhKeys.length)

// Visible text has to go through the locale service. A Chinese literal left in
// the code would render the same in both languages and would ignore a locale
// switch, so a dictionary block is the only place CJK may appear: the ZH/EN
// literals in the framework, and the `dict({...})` call at the end of a card
// module. This runs over the sources rather than the built artifact — those are
// what an author edits, and the artifact was just proved to match them.
function cjkAllowed(name, text) {
  // Normalize line endings before the line-by-line scan: a Windows checkout
  // (core.autocrlf) leaves a CR before each LF, and `$` in the `//`-comment
  // strip below does not match before a CR, which would turn every Chinese
  // comment into a stray literal.
  const sourceLines = text.replace(/\r\n?/g, '\n').split('\n')
  const allowed = new Set()
  if (name === 'lib/framework.part.js') {
    for (const decl of ['var ZH = {', 'var EN = {']) {
      const start = sourceLines.findIndex((line) => line.includes(decl))
      assert.ok(start >= 0, 'the framework must declare ' + decl)
      const end = sourceLines.findIndex((line, index) => index > start && /^\s*\}\s*$/.test(line))
      assert.ok(end > start, decl + ' must be one literal block')
      for (let i = start; i <= end; i += 1) allowed.add(i)
    }
    return { sourceLines, allowed }
  }
  let depth = 0
  let start = -1
  sourceLines.forEach((line, index) => {
    if (depth === 0) {
      // A card's dictionary block has two spellings: the framework's own cards
      // close over `dict({...})` as the `defineCard` argument, and a card that
      // needs the block inside its own object literal writes `dict: { zh, en }`.
      // Both are dictionaries, so both may carry CJK literals.
      if (/^\s*dict\(\{\s*$/.test(line) || /^\s*dict:\s*\{\s*$/.test(line)) {
        depth = 1
        start = index
      }
      return
    }
    depth += (line.match(/\{/g) || []).length
    depth -= (line.match(/\}/g) || []).length
    if (depth <= 0) {
      depth = 0
      for (let i = start; i <= index; i += 1) allowed.add(i)
    }
  })
  return { sourceLines, allowed }
}
const strays = []
for (const [name, text] of sources) {
  const { sourceLines, allowed } = cjkAllowed(name, text)
  sourceLines.forEach((line, index) => {
    if (allowed.has(index)) return
    // A block comment is prose about the code, not text on screen. The rule is
    // about what a reader sees, so only live code counts as a stray literal.
    const trimmed = line.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    // Belt and braces: the split above already removed CR, but strip it again
    // so this guard stays correct if it is ever fed raw, unnormalized lines.
    const code = line.replace(/\r$/, '').replace(/\/\/.*$/, '')
    if (/[\u4e00-\u9fff]/.test(code)) strays.push(name + ':' + (index + 1) + ': ' + line.trim())
  })
}
assert.equal(strays.length, 0, 'CJK literals outside the dictionaries:\n    ' + strays.join('\n    '))

// The extension surface other plugins use.
const surface = globalThis.__DSH_HOMEPAGE__
assert.ok(surface, 'globalThis.__DSH_HOMEPAGE__ must exist after apply')
for (const name of ['define', 'remove', 'get', 'cardApi', 'list', 'ui', 'icons', 'effects', 'defineEffect', 'backgrounds', 'notify', 'clearNotifications', 'toast', 'open', 'close', 'reorder', 'subscribe', 'hooks', 'snapshot', 'state', 'load', 'sidebar', 'has', 'ownerOf', 'cardsOf', 'owners', 'manifest', 'subscribeRegistry', 'unregister', 'plugin']) {
  assert.ok(surface[name] !== undefined, 'the public surface must expose ' + name)
}
for (const name of ['useStore', 'useRemote', 'useClock', 'useNoticeOnce']) {
  assert.equal(typeof surface.hooks[name], 'function', 'the surface must expose the ' + name + ' hook')
}
assert.equal(module_.hooks, surface.hooks, 'the module export must expose the same hooks object')

// ------------------------------------------------- registration and identity
//
// A third-party plugin has to be able to register into the wall and to tell
// whose cards it is looking at, so the registry carries provenance and the
// scoped handle is the surface a visitor should use.

assert.equal(surface.version, 1, 'the interface version is the first one')
for (const name of ['h', 'React', 'UI', 'ICONS', 'runtime', 'dict', 'hooks', 'useRemote', 'remoteCall', 'publishReloader', 'requestReload', 'onApply']) {
  assert.ok(surface.sdk && surface.sdk[name] !== undefined, 'the card SDK must expose ' + name)
}
assert.equal(surface.ownerOf('token'), 'dsh-homepage', 'a shipped card is owned by this plugin')
assert.equal(surface.ownerOf('nope'), null, 'an unknown id has no owner')
assert.equal(surface.has('token'), true, 'has() must see a shipped card')
assert.equal(surface.has('nope'), false, 'has() must not invent a card')
assert.deepEqual(surface.owners(), ['dsh-homepage'], 'one plugin owns the shipped cards so far')
// Registration order follows the build's filename order; the order on the wall
// comes from each card's own `order`, which is the one that has to stay stable.
assert.deepEqual(
  surface.cardsOf('dsh-homepage').map((card) => card.id).sort(),
  ['device', 'dsh', 'hygiene', 'network', 'plugin-audit', 'projects', 'sessions', 'sidebar-groups', 'skill', 'token', 'tool-usage'],
  'the shipped cards are owned by this plugin',
)
assert.deepEqual(
  module_._internal.orderedCards().map((card) => card.id),
  ['token', 'sessions', 'projects', 'network', 'plugin-audit', 'device', 'hygiene', 'tool-usage', 'dsh', 'sidebar-groups', 'skill'],
  'the wall order must follow each card\'s own order',
)

const visitor = surface.plugin('other-plugin')
assert.equal(visitor.name, 'other-plugin', 'a handle carries the name it was opened with')
assert.throws(() => surface.plugin('  '), /needs a name/, 'a handle needs a name')
assert.throws(() => visitor.remove('token'), /belongs to/, 'a handle must not remove another plugin\'s card')
assert.equal(visitor.remove('never-registered'), false, 'removing an unknown id is a no-op, not a throw')

// A registered card carries its owner, and the manifest is the identification
// view: plain data, no render functions.
const changes = []
const stopWatching = surface.subscribeRegistry((event) => changes.push(event))
visitor.define({
  id: 'visitor-card',
  title: 'Visitor',
  size: { w: 2, h: 1 },
  accent: '#20c997',
  tags: ['demo'],
  version: '1.4.0',
  dict: { zh: { 'visitor.hello': '你好，访客' }, en: { 'visitor.hello': 'Hello, visitor' } },
  content: () => React.createElement('div', { className: 'visitor-body' }, 'VISITOR'),
})
assert.equal(surface.ownerOf('visitor-card'), 'other-plugin', 'the handle stamps its name on the card')
assert.deepEqual(surface.cardsOf('other-plugin').map((card) => card.id), ['visitor-card'])
assert.deepEqual(surface.owners(), ['dsh-homepage', 'other-plugin'], 'both owners are visible')
assert.equal(changes.length, 1, 'a registration must reach subscribers')
assert.deepEqual({ type: changes[0].type, id: changes[0].id, owner: changes[0].owner }, { type: 'define', id: 'visitor-card', owner: 'other-plugin' })

const visitorManifest = surface.manifest('visitor-card')
assert.equal(visitorManifest.owner, 'other-plugin', 'the manifest must name the owner')
assert.equal(visitorManifest.version, '1.4.0', 'the manifest must carry the registrant version')
assert.deepEqual(visitorManifest.size, { w: 2, h: 1 }, 'the manifest must carry the span')
assert.deepEqual(visitorManifest.tags, ['demo'], 'the manifest must carry tags')
assert.deepEqual(visitorManifest.controls, [], 'a card with no controls has an empty control list')
assert.equal(surface.manifest('nope'), null, 'an unknown id has no manifest')
assert.equal(surface.manifest().length, 12, 'the manifest covers the whole registry')
for (const entry of surface.manifest()) {
  for (const [key, value] of Object.entries(entry)) {
    assert.ok(typeof value !== 'function', 'a manifest entry must stay serializable, got ' + key + ' = ' + typeof value)
  }
}

// A card definition may bring its own strings, and they resolve for real.
const boundVisitor = mockCtx.locale.bind('homepage')
assert.equal(boundVisitor('visitor.hello'), '\u4f60\u597d\uff0c\u8bbf\u5ba2', 'a definition dict must reach the zh locale')
assert.equal(dictionaries.dicts.en['visitor.hello'], 'Hello, visitor', 'a definition dict must reach the en locale')

// The handle sees only its own cards, and unregistering takes them all away.
assert.deepEqual(visitor.list().map((card) => card.id), ['visitor-card'])
assert.deepEqual(visitor.manifest().map((card) => card.id), ['visitor-card'])
assert.equal(visitor.get('token').id, 'token', 'get() still resolves any card')
assert.deepEqual(visitor.unregister(), ['visitor-card'], 'unregister must report what it dropped')
assert.equal(surface.has('visitor-card'), false, 'the dropped card is gone')
assert.equal(changes.length, 2, 'the removal must reach subscribers')
assert.equal(changes[1].type, 'remove', 'the second change is a removal')
assert.deepEqual(surface.unregister('dsh-homepage'), [], 'shipped cards are not unregisterable')
assert.equal(surface.has('token'), true, 'shipped cards survive an unregister of their owner')
assert.throws(() => surface.subscribeRegistry('not a function'), /takes a function/, 'a subscriber must be a function')

// The shipped effect presets are user-visible text, so they must resolve at
// render time through the dictionary instead of freezing one language.
for (const effect of ['none', 'outline', 'glow', 'scan', 'float', 'spotlight']) {
  const preset = surface.effects[effect]
  assert.ok(preset, 'the shipped effect ' + effect + ' must exist')
  assert.equal(typeof preset.label, 'function', effect + ' must resolve its label when rendered')
  assert.equal(preset.label(), dictionaries.dicts.zh['fx.' + effect + '.label'], effect + ' must label itself from the dictionary')
}
assert.equal(surface.list().length, 11, 'the shipped cards must be registered')

const api = surface
const t = (key, params) => mockCtx.locale.bind('homepage')(key, params)

// The sidebar hands this plugin its project list through the one root-scoped
// slot entry it owns: the panel icon. Feeding it here is what the live client
// does on every render of that icon, and the store keeps the result, so every
// render below — the wall included — draws real project names instead of an
// empty grouping.
const feedReporter = (props) => settle(sidebar.render, Object.assign({ size: 18, active: true, useWorkspaces: (select) => select(WORKSPACE_SNAPSHOT) }, props))
await feedReporter()

// ------------------------------------------------------------- default render

let tree = await settle(main.render, Object.assign({ t }, previewSessionHooks()))

assert.ok(calls.some((call) => call.endpoint === 'homepage/state'), 'the panel must bootstrap from homepage/state')
assert.ok(calls.some((call) => call.endpoint === 'homepage/overview'), 'the token card must load the overview')
assert.ok(calls.some((call) => call.endpoint === 'homepage/environment'), 'the network card must load the environment')

assert.equal(byClass(tree, 'ph-panel').length, 1, 'the panel root must render')
assert.ok(hasClass(byClass(tree, 'ph-panel')[0], 'ph-density-standard'), 'standard density is the default')
assert.equal(byClass(tree, 'ph-cell').length, 11, 'every shipped card must render')
assert.deepEqual(
  byClass(tree, 'ph-cell').map((cell) => cell.props['data-card-cell']),
  ['token', 'sessions', 'projects', 'network', 'plugin-audit', 'device', 'hygiene', 'tool-usage', 'dsh', 'sidebar-groups', 'skill'],
  'cells must render in registry order',
)
assert.equal(byClass(tree, 'ph-toolbar').length, 1, 'the toolbar must render')

const tokens = byClass(tree, 'ph-hero')
// The token and network previews share the one-glance hero. The device card
// deliberately does not: its value is four meter rows, so it renders a column
// instead of one big reading.
assert.equal(tokens.length, 2, 'the numeric previews must render the shared hero reading')
assert.equal(byClass(tree, 'ph-specs').length, 2, 'the list-shaped previews render a column, not a hero')
const tokenText = text(byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'token'))
assert.ok(tokenText.includes('3.50'), 'the token card must show the balance, got: ' + tokenText)
assert.ok(tokenText.includes('¥3.50'), 'the token card must lead with the primary currency, got: ' + tokenText)
assert.ok(tokenText.indexOf('$0.00') < 0, 'a zeroed USD wallet must not become the headline, got: ' + tokenText)
assert.ok(tokenText.includes('1.23'), 'the token card must show today spend, got: ' + tokenText)
// The preview is deliberately thin: no settings, no history, no chips.
assert.equal(byClass(tree, 'ph-actions').length, 0, 'a preview must not carry settings controls')
assert.equal(byClass(tree, 'ph-segmented').length, 0, 'browsing has no redundant global density picker')
assert.equal(byClass(tree, 'ph-arrange-toggle').length, 1, 'arrangement has one explicit entry point')
assert.equal(byClass(tree, 'ph-open-card').length, 11, 'every expandable card has a keyboard-accessible detail control')

// --- the device card ------------------------------------------------------
// The readings are the host's own snapshot of the machine, so the card is a
// pure function of the document the test hands it.
const deviceCell = byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'device')
assert.ok(deviceCell, 'the device cell must render')
const devicePreview = text(deviceCell)
// The preview is four meter rows, in the order the readings have ceilings:
// processor, memory, GPU, video memory. The name, the percentage and the share
// are three separate cells so the percentage column lines up.
const meters = byClass(deviceCell, 'ph-meter')
assert.equal(meters.length, 4, 'the device preview is four meter rows, got: ' + meters.length)
assert.deepEqual(
  byClass(deviceCell, 'ph-meter-name').map((node) => text(node)),
  ['处理器', '内存', 'GPU', '显存'],
  'the rows are named in the order the readings are read')
assert.deepEqual(
  byClass(deviceCell, 'ph-meter-value').map((node) => text(node)),
  ['23%', '63%', '7%', '78%'],
  'each row carries its own share')
assert.deepEqual(
  byClass(deviceCell, 'ph-meter-fill').map((node) => node.props.style.width),
  ['23%', '62.5%', '7%', '78.125%'],
  'the bar is the share, not a category')
// A bar is a tint, so only the reading under pressure is allowed to leave the
// card's brand colour: the video memory is at 78% in the fixture and nothing
// else is.
assert.equal(meters[3].props['data-tone'], 'warn', 'a reading near its ceiling must be marked')
assert.equal(meters[0].props['data-tone'], undefined, 'a calm reading keeps the card colour')
assert.ok(devicePreview.includes('NVIDIA GeForce RTX 5070'), 'the preview must name the adapter it measured, got: ' + devicePreview)
assert.ok(devicePreview.includes('62 °C'), 'the device preview must show the temperature, got: ' + devicePreview)
// The absolute numbers have no room in a row, so they live on the row's title.
assert.ok(meters[0].props.title.includes('8 核'), 'the processor row must name the core count, got: ' + meters[0].props.title)
assert.ok(meters[1].props.title.includes('20 GB') && meters[1].props.title.includes('32 GB'),
  'the memory row must carry used over total, got: ' + meters[1].props.title)
assert.ok(meters[3].props.title.includes('9.4 GB') && meters[3].props.title.includes('12 GB'),
  'the video memory row must carry used over total, got: ' + meters[3].props.title)
assert.equal(byClass(deviceCell, 'ph-chip').length, 2, 'the device preview carries the temperature and the uptime')
assert.equal(byClass(deviceCell, 'ph-chip--ok').length, 1, '61.5 °C is a healthy reading and must not be flagged')
assert.ok(hasClass(byClass(deviceCell, 'ph-shell')[0], 'ph-fx-scan'), 'the device card asks for the scan effect')
assert.equal(byClass(deviceCell, 'ph-sheen').length, 0, 'no shipped card may carry the sheen sweep')
assert.ok(!api.snapshot().notifications.device, 'a machine that reads fine is not news and must not raise a bubble')

// The liquid-glass shell: every cell is a liquid bed + a frosted glass layer,
// and only a card that asked for the sheen gets one.
assert.equal(byClass(tree, 'ph-cell').length, 11, 'every shipped card')
assert.equal(byClass(tree, 'ph-bed').length, 11, 'each card must sit on its own liquid bed')
assert.equal(byClass(tree, 'ph-glass').length, 11, 'each card must carry the frosted glass layer')
// No shipped card asks for the sheen: it is a diagonal band of light, i.e. a
// gradient, and the art direction ruled gradients out. The effect still exists
// and is exercised by the custom card further down.
assert.equal(byClass(tree, 'ph-sheen').length, 0, 'no shipped card may render the sheen sweep')

// The DSH preview: what the upstream is at, what this machine runs, and the one
// verdict that compares the two. The card is a tool for local source builds, so
// the verdict is about the commit this box has unpacked — a card that only read
// the upstream could not tell "up to date" from "this box is a day behind".
const dshCell = byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'dsh')
assert.ok(dshCell, 'the dsh card must render')
const dshPreview = text(dshCell)
assert.ok(dshPreview.includes('86a4022'), 'the preview must name the commit, got: ' + dshPreview)
assert.ok(dshPreview.includes(DSH_FIXTURE.release.name), 'the preview must name the release, got: ' + dshPreview)
assert.equal(byClass(dshCell, 'ph-spec').length, 2, 'the dsh preview is two rows: the upstream release and this machine')
const dshLocalSpec = byClass(dshCell, 'ph-spec')
  .find((spec) => textOf(byClass(spec, 'ph-spec-name')[0]).trim() === t('dsh.row.local'))
assert.ok(dshLocalSpec, 'the preview must have a row for the core installed here')
assert.equal(textOf(byClass(dshLocalSpec, 'ph-spec-value')[0]).trim(), '86a4022',
  'the local row must name the commit this box is on')
assert.equal(byClass(dshLocalSpec, 'ph-spec-value')[0].props.title, 'deepseekharness021a3',
  'the local row must say which directory that commit came from')
const dshPreviewChip = byClass(dshCell, 'ph-chip')[0]
assert.ok(dshPreviewChip, 'the preview states its verdict in one chip')
assert.ok(hasClass(dshPreviewChip, 'ph-chip--ok'),
  'a core sitting on the upstream commit is not news, got: ' + textOf(dshPreviewChip))
assert.ok(text(dshCell).includes(t('dsh.state.current')), 'the newest local core is on the upstream commit, got: ' + dshPreview)


// The material and the sizing are both load-bearing and both easy to undo by
// accident, so they are pinned here rather than only drawn.
//   - the bed is ONE flat tint of the accent: a ramp accent -> white -> accent
//     is two colours fighting inside one card, which is what got rejected;
//   - the grain rides ON the glass: anything under `backdrop-filter` is blurred,
//     and a blurred noise tile averages back into the flat wash it broke up;
//   - the shell is in flow and the rows are `auto`: an absolutely positioned
//     shell contributes no height, so every card falls back to a fixed row and
//     a card holding one reading keeps the empty half of a taller neighbour.
const bedRule = /\.ph-bed\{([^}]*)\}/.exec(module_.STYLES)[1]
assert.ok(!/gradient\(/.test(bedRule), 'the bed must be a flat tint, not a gradient')
assert.ok(/color-mix\(/.test(bedRule), 'the bed must tint itself from the card accent')
assert.ok(/\.ph-bed::after\{/.test(module_.STYLES) === false, 'the grain must not sit under the backdrop filter')
assert.ok(
  /\.ph-glass::after\{[^}]*background-image:url\("data:image\/svg\+xml/.test(module_.STYLES),
  'the grain must ride on the glass layer',
)
assert.ok(/\.ph-shell\{position:relative/.test(module_.STYLES), 'the shell must be in flow so a card can size to content')
assert.ok(/grid-auto-rows:auto/.test(module_.STYLES), 'wall rows must be sized by content, not by a fixed row height')
// Dense flow is the difference between a filled wall and a staircase: a 2-wide
// card on a row's tail cell leaves one cell free, and sparse flow never comes
// back for it. Pin it, because dropping the keyword changes nothing else that a
// test would notice — it just quietly leaves the hole in place again.
assert.ok(
  /grid-auto-flow:row dense/.test(module_.STYLES),
  'the wall must backfill the cell a wide card leaves at the end of a row',
)

// A chip that paints its label in the state colour disappears when the card's
// own accent is that colour: the toolchain card's green bed made a fully green
// chip. The tint carries the state, the text is the app's ink, and the ring
// keeps the hue readable as a mark in both themes.
for (const tone of ['ok', 'warn', 'error']) {
  const chipRule = new RegExp('\\.ph-chip--' + tone + '\\{([^}]*)\\}').exec(module_.STYLES)[1]
  assert.ok(
    chipRule.includes('color:var(--dsw-alias-label-primary'),
    'the ' + tone + ' chip must write its text in the ink, not the state colour',
  )
  assert.ok(
    chipRule.includes('box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--dsw-alias-state-'),
    'the ' + tone + ' chip must keep its state as a ring',
  )
}

// A long detail view has to be reachable: the expanded body scrolls under a
// pinned title and toolbar. `overflow:hidden` clipped it against the panel.
const focusBody = /\.ph-focus-body\{([^}]*)\}/.exec(module_.STYLES)[1]
assert.ok(/overflow:(auto|scroll)/.test(focusBody), 'the expanded card body must scroll, not clip')
assert.ok(/min-height:0/.test(focusBody), 'a flex scroller needs min-height:0 or it never shrinks')
const heroRow = /\.ph-hero-row\{([^}]*)\}/.exec(module_.STYLES)[1]
assert.ok(/flex-wrap:wrap/.test(heroRow), 'the preview chips must wrap rather than run out of the card')

// The meter row is the device preview: name, share, bar. The bar has to be a
// fixed column or the four rows would not line up on the percentage, and the
// percentage has to be what pushes right — a bar sized by its own value would
// make every row a different shape.
const meterRule = /\.ph-meter\{([^}]*)\}/.exec(module_.STYLES)[1]
assert.ok(/display:flex/.test(meterRule), 'a meter row must lay out along one line')
const meterBar = /\.ph-meter-bar\{([^}]*)\}/.exec(module_.STYLES)[1]
assert.ok(/width:64px/.test(meterBar), 'the bar is a fixed column so every row aligns')
assert.ok(/overflow:hidden/.test(meterBar), 'the fill must be clipped to its track')
const meterValue = /\.ph-meter-value\{([^}]*)\}/.exec(module_.STYLES)[1]
assert.ok(/margin-left:auto/.test(meterValue), 'the percentage is what pushes the bar to the right edge')
assert.ok(/tabular-nums/.test(meterValue), 'the percentages must not jitter from row to row')
assert.ok(
  /\.ph-meter\[data-tone="warn"\] \.ph-meter-fill\{[^}]*state-warn-primary/.test(module_.STYLES),
  'a reading under pressure colours the bar, never the number',
)

// The two layers that emit light — the glass veil and the sheen band — must be
// literal white. `--dsw-alias-label-primary` is the TEXT colour: near-black in
// light mode, white in dark. Using it as a fill painted a dark wash over every
// card (#F4F7FF measured as #E9EBF3) and it is invisible in dark mode, so it
// survived a whole review round. State-layer hovers keep the label token on
// purpose — a darkening hover in light mode is the conventional treatment.
const glassRule = /\.ph-glass\{([^}]*)\}/.exec(module_.STYLES)[1]
assert.ok(/color-mix\(in srgb,#fff/.test(glassRule), 'the glass veil must be literal white')
assert.ok(!/label-primary/.test(glassRule), 'the glass veil must not be built from the text colour')
const sheenRule = /\.ph-sheen\{([^}]*)\}/.exec(module_.STYLES)[1]
assert.ok(!/label-primary/.test(sheenRule), 'the sheen is a band of light: it must not use the text colour')
assert.equal(
  /\.ph-focus-card\{[^}]*background:color-mix\(in srgb,var\(--dsw-alias-bg-layer-1/.test(module_.STYLES),
  true,
  'the expanded pane must take its fill from a surface token, not the text colour',
)

// A texture is a mark printed on the card's own surface: above the bed and the
// glass, below the type. Three properties of that are easy to lose in a rewrite —
// the layer must stay at z-index:1 (z-index:2 would put a 5% ghost over the
// readings), it must never take a pointer (an invisible full-card overlay that
// did would kill expansion wherever the mark happens to sit), and it must be
// sized from the card's height and kept square, because that is what lets one
// percentage crop a wide card and a narrow one differently.
const texRule = /\.ph-tex\{([^}]*)\}/.exec(module_.STYLES)[1]
assert.ok(/z-index:1/.test(texRule), 'a texture rides with the glass, below the type')
assert.ok(/pointer-events:none/.test(texRule), 'a texture must never take a pointer')
assert.ok(/opacity:var\(--ph-tex-opacity,.05\)/.test(texRule), 'the default mark is five percent')
const texMarkRule = /\.ph-tex-mark\{([^}]*)\}/.exec(module_.STYLES)[1]
assert.ok(/height:var\(--ph-tex-size/.test(texMarkRule), 'a mark is sized from the card, not in pixels')
assert.ok(/aspect-ratio:1/.test(texMarkRule), 'a mark stays square whatever the card size')
assert.ok(
  /\.ph-tex--right \.ph-tex-mark\{[^}]*margin-right:var\(--ph-tex-bleed/.test(module_.STYLES),
  'the default anchor bleeds the mark past the right edge, which is what crops it',
)
// The optional fade is a mask on the mark, and its direction follows the anchor:
// left-aligned artwork dissolves to the right, right-aligned artwork to the left.
assert.ok(
  /\.ph-tex--fade\.ph-tex--left \.ph-tex-mark\{[^}]*mask-image:linear-gradient\(to right,/.test(module_.STYLES),
  'left-aligned artwork must fade its right side',
)
assert.ok(
  /\.ph-tex--fade\.ph-tex--right \.ph-tex-mark\{[^}]*mask-image:linear-gradient\(to left,/.test(module_.STYLES),
  'right-aligned artwork must fade its left side',
)
assert.ok(
  /\.ph-tex--fade\.ph-tex--center \.ph-tex-mark\{[^}]*mask-image:linear-gradient\(to right,transparent 0%/.test(module_.STYLES),
  'centred artwork must dissolve from both sides',
)
// A blend mode has to blend against the card, not the page behind it — but
// isolation is scoped to cards that carry a blend so the glass of every other
// card keeps sampling the wall behind it.
assert.ok(
  /\.ph-shell:has\(>\.ph-tex--blend\),\.ph-focus-card:has\(>\.ph-tex--blend\)\{isolation:isolate\}/.test(module_.STYLES),
  'only a blended watermark must be isolated inside its card',
)
assert.ok(
  /\.ph-body\{([^}]*)\}/.exec(module_.STYLES)[1].includes('z-index:2'),
  'the readings must stay above the texture',
)

const networkText = text(byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'network'))
assert.ok(networkText.includes('127.0.0.1'), 'the network card must show the proxy host, got: ' + networkText)
assert.ok(!networkText.includes('secret'), 'the network card must not leak credentials by default')

// Cards keep their registered sizes.
const layoutOf = (id) => byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === id).props.style
assert.equal(layoutOf('token').gridColumn, 'span 2', 'the token card registers a 2-column default')
dumpPreview(tree, '01-wall')

// The Sessions card's expanded page, only in preview mode: the wall dump above
// already carries its three readings, but the list and the stop control need the
// pane open. Closing it restores the wall for the tests below.
if (PREVIEW_DIR) {
  api.open('sessions')
  const sessionsPane = await settle(main.render, Object.assign({ t }, previewSessionHooks()))
  dumpPreview(sessionsPane, '18-expanded-sessions')
  api.open('projects')
  const projectsPane = await settle(main.render, { t })
  dumpPreview(projectsPane, '19-expanded-projects')
  api.open('hygiene')
  const hygienePane = await settle(main.render, { t })
  dumpPreview(hygienePane, '20-expanded-hygiene')
  api.open('runs')
  const runsPane = await settle(main.render, { t })
  dumpPreview(runsPane, '21-expanded-runs')
  api.close()
  tree = await settle(main.render, Object.assign({ t }, previewSessionHooks()))
}

// ------------------------------------------------- sidebar workspace grouping
//
// Stage two: the document decides who owns the sidebar's workspace region. A
// document that asks for the grouped list takes the slot at a negative priority
// and draws the projects, their groups and their menus itself; a document that
// asks for the shipped list is simply not registered, and the shipped occupant
// returns. The manager card and the region edit the same document.
//
// The region is an ordinary component with no props — everything it reads is the
// document plus the projection the sidebar icon reports — so it is rendered here
// instead of being trusted to a browser. The UI kit is present (the stub), which
// is the path a real client takes: the region draws the shell's own Menu,
// InlineEditor and Modal.

// The host answers a save with the document it normalised and stored — the same
// one the page just sent. The static fixture would instead hand back the
// document the test started with, silently reverting every edit after the save
// debounce; echoing the live document is what the real host does, and it is what
// makes an edit observable after the round-trip.
FIXTURES['homepage/saveSidebarLayout'] = {
  get layout() { return globalThis.__DSH_HOMEPAGE__.sidebar.snapshot().layout },
  get at() { return globalThis.__DSH_HOMEPAGE__.sidebar.snapshot().at },
}

// The report's own defect: the panel renders its stylesheets inside its own
// tree, and the sidebar is drawn on views where that tree is never mounted, so
// the region appends its sheet to `document.head` itself. It must be exactly one
// copy — the sheet is marked, and taking the region over a second time must not
// stack another one.
assert.equal(appendedStyles.length, 1, 'taking the region appends its stylesheet to the document')
assert.equal(appendedStyles[0].tagName, 'STYLE', 'the appended sheet must be a <style> element')
assert.equal(appendedStyles[0].attributes['data-ph-sidebar'], '', 'the sheet must be marked so a hot reload does not stack copies')
assert.ok(
  String(appendedStyles[0].textContent).includes('.ph-sb'),
  'the appended sheet must carry the region\'s own rules, got ' + String(appendedStyles[0].textContent).length + ' chars',
)

// The icon is what publishes the projection the region reads; handing it the
// session list as well is what makes the rows below carry real names.
const reportedIcon = await feedReporter({
  useWorkspaces: (select) => select(WORKSPACE_SNAPSHOT),
  useSessions: (select) => select(SESSION_LIST),
})
assert.ok(elements(reportedIcon).length >= 1, 'the reporter must not change what the icon draws')
assert.equal(surface.sidebar.snapshot().workspaces.length, 3, 'the icon hands the sidebar project list to the store')
assert.ok(
  registrations.some((entry) => entry.slotName === 'sidebar.workspaces' && entry.opts.priority === -1),
  'a grouped document must own the workspace region',
)

const region = surface.sidebar.projects()
assert.equal(typeof region, 'function', 'the grouped region must be reachable for a render test')
let regionTree = await settle(region)
// The document exactly as the host answered it, before any test edits it. The
// preview at the end of this block puts it back, so what is rendered for the eye
// is the region at rest rather than the region after eleven edits.
const layoutAtRest = surface.sidebar.snapshot().layout

/** Every element of a tree carrying that `data-sb` hook. */
const sbNodes = (tree, sb) => elements(tree).filter((node) => node.props && node.props['data-sb'] === sb)
/** The session row drawn under one project. */
const sessionsUnder = (tree, workspaceId) => sbNodes(tree, 'session').filter((node) => node.props['data-ws'] === workspaceId)
/** One session row, by the id the projection reported. */
const sessionRowById = (tree, id) => sbNodes(tree, 'session').find((node) => node.props['data-id'] === id)
/** The project row a name is drawn in. */
const rowNamed = (tree, name) => sbNodes(tree, 'project').find((node) => text(node).includes(name))

const regionRoot = byClass(regionTree, 'ph-sb')[0]
assert.ok(regionRoot, 'the region must draw its own shell')
assert.equal(regionRoot.props['data-sidebar-mode'], 'grouped', 'the region reports the mode it drew')
assert.equal(byClass(regionTree, 'ph-sb-wide').length, 1, 'the header draws its wide shape')
assert.equal(byClass(regionTree, 'ph-sb-rail').length, 1, 'and its rail, which the container query chooses between')

const sections = sbNodes(regionTree, 'section')
assert.deepEqual(
  sections.map((node) => node.props['data-group']),
  ['lab', 'work', ''],
  'two groups in document order, then the bucket for what is left',
)
assert.equal(sbNodes(regionTree, 'group').length, 3, 'every section draws its heading row')
assert.equal(sbNodes(regionTree, 'groupToggle').length, 2, 'only a real group carries a fold control, not the ungrouped bucket')

const projectRows = sbNodes(regionTree, 'project')
assert.deepEqual(
  projectRows.map((node) => node.props['data-ws']),
  ['w-lab', 'w-gone', 'w-work', 'w-notes'],
  'the three reported projects plus the stale assignment the document still remembers',
)
assert.ok(projectRows.every((node) => node.props.role === 'treeitem'), 'a project row is a treeitem')
assert.deepEqual(
  projectRows.filter((node) => hasClass(node, 'is-orphan')).map((node) => node.props['data-ws']),
  ['w-gone'],
  'the project the sidebar no longer reports is marked and still removable',
)

// Only the project the focused Session lives in opens by itself. The shipped
// browser opens the group holding the current Session and remembers every other
// fold the reader chose; this list follows it, so the fixture — whose current
// Session is in 实验室 — draws that group's rows and nothing else.
const sessionRows = sbNodes(regionTree, 'session')
assert.equal(sessionRows.length, 3, 'only the project holding the current session opens by itself')
assert.deepEqual(
  sessionRows.map((node) => node.props['data-id']),
  ['s-2', 's-1', 's-5'],
  'the current session leads its project\'s rows, and the rest are newest first',
)
assert.deepEqual(
  sessionRows.filter((node) => hasClass(node, 'is-current')).map((node) => node.props['data-id']),
  ['s-2'],
  'the session the main view holds is the current row',
)
const sessionStates = sbNodes(regionTree, 'state')
assert.equal(sessionStates.length, 3, 'every drawn session row carries its state dot')
assert.ok(!hasClass(sessionStates[0], 'is-run'), 'the current session is a draft, so its dot is at rest')
assert.ok(hasClass(sessionStates[1], 'is-run'), 'a running session paints its dot')
assert.equal(sbNodes(regionTree, 'empty').length, 0, 'a loaded document is not the empty state')
assert.equal(sbNodes(regionTree, 'pending').length, 0, 'a ready projection is not pending')
assert.equal(sbNodes(regionTree, 'searching').length, 0, 'and nothing is searching')
assert.equal(sbNodes(regionTree, 'noMatch').length, 0, 'and no search has come back empty')

let regionText = text(regionTree)
assert.ok(regionText.includes('实验室') && regionText.includes('Work'), 'the headings name the groups')
assert.ok(regionText.includes('未分组'), 'the bucket for ungrouped projects keeps the document title')
assert.ok(
  regionText.includes('demo') && regionText.includes('app') && regionText.includes('notes'),
  'projects are drawn under the names the sidebar reported, got: ' + regionText,
)
assert.ok(
  regionText.includes('重构测试') && regionText.includes('会议记录'),
  'session rows are drawn under the names the sidebar reported, got: ' + regionText,
)
assert.ok(!regionText.includes('发布检查'), 'a project the reader has not opened draws no rows')
assert.ok(regionText.includes(t('sidebar.session.new')), 'a blank session is labelled as a new one')

// The heading counts sessions, not the projects drawn under it. The fixture
// makes the two readings differ on purpose: 实验室 holds two projects (one of
// them stale and empty) and three sessions, so a heading that read 2 would be
// counting the wrong thing.
const labHeading = sections[0]
assert.ok(
  text(labHeading).includes(t('sidebar.list.count', { count: 3 })),
  'a group heading counts the sessions below it, got: ' + text(labHeading),
)
assert.equal(
  sbNodes(labHeading, 'project').length,
  2,
  'the projects it lists are drawn under it, so that is one number it must not print',
)
assert.ok(text(sections[1]).includes(t('sidebar.list.count', { count: 1 })), 'the other group counts its own session')
assert.ok(text(sections[2]).includes(t('sidebar.list.count', { count: 1 })), 'the ungrouped bucket counts what is in it')

// Folding ONE project's sessions is the reader's choice about the list, and it
// is remembered the way the shipped browser remembers it: the fold is written
// into the document, saved, and read back, so the next load keeps it. The
// project holding the current Session is the one exception that starts open,
// and the caret reports both answers.
const demoRow = rowNamed(regionTree, 'demo')
assert.ok(demoRow, 'the sidebar lists the project under the name the sidebar reported')
assert.equal(
  sbNodes(demoRow, 'projectToggle')[0].props['aria-expanded'],
  true,
  'the caret of the project holding the current session reports it open',
)
assert.equal(
  surface.sidebar.expandedOf(surface.sidebar.snapshot().layout, 'w-lab'),
  true,
  'and opening it is written into the document, not kept in the region',
)
sbNodes(demoRow, 'projectToggle')[0].props.onClick({ stopPropagation() {} })
const foldedTree = await settle(region)
assert.equal(sessionsUnder(foldedTree, 'w-lab').length, 0, 'the caret folds that project\'s sessions')
assert.equal(sessionsUnder(foldedTree, 'w-work').length, 0, 'and only that project\'s')
assert.equal(
  surface.sidebar.expandedOf(surface.sidebar.snapshot().layout, 'w-lab'),
  false,
  'folding a project is written into the document',
)
assert.equal(
  Object.prototype.hasOwnProperty.call(surface.sidebar.expanded(surface.sidebar.snapshot().layout), 'w-work'),
  false,
  'and a project that was never opened keeps no stored answer',
)
assert.equal(
  sbNodes(rowNamed(foldedTree, 'demo'), 'projectToggle')[0].props['aria-expanded'],
  false,
  'the caret reports the fold it just made',
)
await sleep(520)
const projectFoldSaves = calls.filter((call) => call.endpoint === 'homepage/saveSidebarLayout')
assert.ok(projectFoldSaves.length > 0, 'a project fold must be persisted')
assert.equal(
  surface.sidebar.expandedOf(projectFoldSaves[projectFoldSaves.length - 1].payload.args.layout, 'w-lab'),
  false,
  'the saved document carries the fold',
)
sbNodes(rowNamed(foldedTree, 'demo'), 'projectToggle')[0].props.onClick({ stopPropagation() {} })
regionTree = await settle(region)
assert.equal(sessionsUnder(regionTree, 'w-lab').length, 3, 'and the same caret unfolds it again')

// A project the reader has opened draws its own rows, which is what makes the
// fold above local to one project rather than a property of the whole region.
sbNodes(rowNamed(regionTree, 'app'), 'projectToggle')[0].props.onClick({ stopPropagation() {} })
regionTree = await settle(region)
assert.equal(sessionsUnder(regionTree, 'w-work').length, 1, 'a project the reader opened draws its sessions')
assert.equal(sessionsUnder(regionTree, 'w-lab').length, 3, 'and the open project beside it is untouched')
await sleep(520)

// Folding a GROUP is the opposite: the fold is written into the document, saved,
// and read back — the host owns it so it survives a reload. The old assertion
// that folding never touched the document was the defect, not the contract.
sbNodes(sections[1], 'groupToggle')[0].props.onClick({ stopPropagation() {} })
const collapsedTree = await settle(region)
const foldedLayout = surface.sidebar.snapshot().layout
assert.equal(
  surface.sidebar.groups(foldedLayout).find((group) => group.id === 'work').collapsed,
  true,
  'folding a group is written into the document',
)
assert.equal(
  surface.sidebar.groups(foldedLayout).find((group) => group.id === 'lab').collapsed,
  false,
  'and the other group is left alone',
)
assert.equal(sbNodes(collapsedTree, 'section').length, 3, 'collapsing keeps every heading')
assert.equal(sessionsUnder(collapsedTree, 'w-work').length, 0, 'collapsing hides that group\'s rows')
assert.equal(sessionsUnder(collapsedTree, 'w-lab').length, 3, 'and only that group\'s')
assert.deepEqual(
  sbNodes(collapsedTree, 'project').map((node) => node.props['data-ws']),
  ['w-lab', 'w-gone', 'w-notes'],
  'the folded group draws no project rows and the others are unchanged',
)
await sleep(520)
const foldSaves = calls.filter((call) => call.endpoint === 'homepage/saveSidebarLayout')
assert.ok(foldSaves.length > 0, 'a group fold must be persisted')
const savedFold = foldSaves[foldSaves.length - 1].payload.args.layout
assert.equal(
  surface.sidebar.groups(savedFold).find((group) => group.id === 'work').collapsed,
  true,
  'the saved document carries the fold',
)
assert.equal(
  surface.sidebar.groups(surface.sidebar.snapshot().layout).find((group) => group.id === 'work').collapsed,
  true,
  'and the fold survives the save round-trip',
)
sbNodes(collapsedTree, 'groupToggle')[1].props.onClick({ stopPropagation() {} })
regionTree = await settle(region)
assert.equal(
  surface.sidebar.groups(surface.sidebar.snapshot().layout).find((group) => group.id === 'work').collapsed,
  false,
  'the same control unfolds it',
)
await sleep(520)

// The region ships its own sheet, and every class it draws has to exist in it:
// a class with no rule is an unstyled element, which is the "pile of boxes" the
// report was about. The narrow shape and the three indent levels are the parts
// of that sheet a DOM assertion cannot see.
const sbStyles = String(module_.STYLES)
for (const selector of [
  '.ph-sb{', '.ph-sb-body{', '.ph-sb-wide{', '.ph-sb-rail{', '.ph-sb-bar{', '.ph-sb-search{',
  '.ph-sb-sinput{', '.ph-sb-icon{', '.ph-sb-list{', '.ph-sb-scroll{', '.ph-sb-fade{',
  '.ph-sb-group{', '.ph-sb-group-body{', '.ph-sb-row{', '.ph-sb-group-head{', '.ph-sb-project{',
  '.ph-sb-session{', '.ph-sb-slot{', '.ph-sb-chev{', '.ph-sb-folder{', '.ph-sb-title{',
  '.ph-sb-meta{', '.ph-sb-actions{', '.ph-sb-dot{', '.ph-sb-pin{', '.ph-sb-more{',
  '.ph-sb-empty{', '.ph-sb-error{', '.ph-sb-crashed{', '.ph-sb-result{', '.ph-sb-pop{',
  '.ph-sb-pop-layer{', '.ph-sb-pop-item{', '.ph-sb-form{', '.ph-sb-modal{',
]) {
  assert.ok(sbStyles.includes(selector), 'the region stylesheet must style ' + selector)
}
assert.ok(
  /@container ph-sidebar \(max-width:120px\)\{\.ph-sb-wide\{display:none\}/.test(sbStyles),
  'the rail is the same tree at a narrow width, chosen by a container query',
)
assert.ok(
  /\.ph-sb-group-head\{--ph-sb-indent:0px/.test(sbStyles)
  && /\.ph-sb-project\{--ph-sb-indent:12px/.test(sbStyles)
  && /\.ph-sb-session\{--ph-sb-indent:24px/.test(sbStyles),
  'the three levels indent by the shipped custom property, one step each',
)
const drawnClasses = new Set()
for (const node of elements(regionTree)) {
  for (const name of String(node.props.className || '').split(/\s+/)) {
    if (/^ph-/.test(name)) drawnClasses.add(name)
  }
}
assert.deepEqual(
  [...drawnClasses].filter((name) => !sbStyles.includes('.' + name)),
  [],
  'every ph-* class the region draws must have a rule in its own sheet',
)

// The manager card and the region edit the same document, so the card is read
// here after every region assertion above: its counts are the document's.
tree = await settle(main.render, { t })
const groupsCell = byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'sidebar-groups')
assert.ok(groupsCell, 'the grouping card must be on the wall')
let groupsText = text(groupsCell)
assert.ok(groupsText.includes('实验室') && groupsText.includes('Work'), 'the card face must name every group')
assert.ok(groupsText.includes(t('sidebar.manager.loose')), 'the loose projects get their own line')
assert.equal(byClass(groupsCell, 'ph-group-line').length, 3, 'one line per group, plus the ungrouped bucket')
assert.equal(byClass(groupsCell, 'ph-group-dot').length, 3, 'each line carries its colour dot')
assert.ok(!groupsText.includes(t('sidebar.card.tip')), 'the card no longer explains what grouping changes')

api.open('sidebar-groups')
tree = await settle(main.render, { t })
const groupsPane = byClass(tree, 'ph-focus-card')[0]
assert.equal(groupsPane.props['data-card-focus'], 'sidebar-groups', 'the grouping card must expand')
assert.equal(byClass(groupsPane, 'ph-group-editor').length, 2, 'every group gets an editor')
assert.equal(byClass(groupsPane, 'ph-swatches').length, 2, 'every group gets its colour row')
assert.equal(
  byClass(groupsPane, 'ph-input').length,
  3,
  'the new-group field plus one title field per group, and nothing else is editable',
)
assert.equal(byClass(groupsPane, 'ph-loose-row').length, 1, 'the ungrouped project is listed on its own')

// The names come from the sidebar (demo/app/notes), and the stale assignment is
// drawn from its id alone — a document that names a project the sidebar no
// longer lists must not hide it, or the assignment could never be removed.
groupsText = text(groupsPane)
assert.ok(groupsText.includes('demo') && groupsText.includes('app'), 'a grouped project appears under its name')
assert.ok(groupsText.includes('notes'), 'an ungrouped project appears in the loose list')
assert.ok(groupsText.includes('w-gone'), 'a stale assignment is drawn from its id')
assert.equal(
  elements(groupsPane).filter((node) => hasClass(node, 'ph-member') && hasClass(node, 'is-orphan')).length,
  1,
  'the stale assignment is marked as such',
)

// An assignment happens in the region's own project menu, and the Session row
// gains nothing: the report was that a session had picked up a grouping entry it
// was never designed to carry.
assert.ok(
  registrations.every((entry) => !String(entry.slotName).startsWith('sidebar.session.')
    && entry.slotName !== 'sidebar.workspaces.session.menu.item'),
  'the plugin must not register anything into a Session row',
)

// ---------------------------------------------------- the region's own wiring
//
// Every control in the region drives a client service. The calls are recorded,
// so the wiring is asserted instead of assumed: an action that silently does
// nothing is the defect this module exists to fix.

/** Open a row's menu and return the settled tree. */
async function openRowMenu(row, hook) {
  sbNodes(row, hook)[0].props.onClick({ stopPropagation() {}, currentTarget: null })
  return settle(region)
}
/** @returns the item ids of the one open kit menu in a tree. */
const menuItemIds = (tree) => elements(tree)
  .filter((node) => node.props.role === 'menuitem' && node.props['data-id'])
  .map((node) => node.props['data-id'])

regionTree = await settle(region)
const projectMenuTree = await openRowMenu(rowNamed(regionTree, 'demo'), 'projectMenu')
const openMenus = byClass(projectMenuTree, 'ui-menu')
assert.equal(openMenus.length, 1, 'the project menu opens as the shell\'s own menu')
assert.deepEqual(
  menuItemIds(openMenus[0]),
  ['newSession', 'rename', 'pin', 'color', 'move', 'remove'],
  'the project menu offers the shipped actions, the two document options and the grouping entry, got: ' + menuItemIds(openMenus[0]).join(','),
)
assert.equal(byClass(openMenus[0], 'ui-submenu').length, 0, 'the grouping choices stay folded until the entry is taken')
assert.ok(text(openMenus[0]).includes(t('sidebar.project.move')), 'the grouping entry is named by the dictionary')
assert.ok(text(openMenus[0]).includes(t('sidebar.project.delete')), 'the menu offers the removal the shipped row offers')

elements(openMenus[0]).find((node) => node.props['data-id'] === 'move').props.onMouseEnter({ currentTarget: null })
const submenuTree = await settle(region)
const subMenu = byClass(submenuTree, 'ui-submenu')[0]
assert.ok(subMenu, 'the grouping entry opens a panel beside the menu')
assert.deepEqual(
  menuItemIds(subMenu),
  ['move:lab', 'move:work', 'move:'],
  'every group is listed, plus the bucket for what is left, got: ' + menuItemIds(subMenu).join(','),
)
elements(subMenu).find((node) => node.props['data-id'] === 'move:work').props.onClick({})
await settle(region)
await sleep(520)
assert.equal(surface.sidebar.groups(surface.sidebar.snapshot().layout).length, 2, 'picking a group must not mint another one')
assert.equal(
  surface.sidebar.members(surface.sidebar.snapshot().layout)['w-lab'].group,
  'work',
  'the assignment lands on the project the row named',
)
assert.ok(calls.some((call) => call.endpoint === 'homepage/saveSidebarLayout'), 'an assignment must be persisted')

// Renaming a project is the shipped service call, through the shell's own
// inline editor: choosing the entry opens a field in the row, and saving commits.
const renameMenu = await openRowMenu(rowNamed(await settle(region), 'demo'), 'projectMenu')
elements(renameMenu).find((node) => node.props.role === 'menuitem' && node.props['data-id'] === 'rename').props.onClick({})
const editorTree = await settle(region)
const renameField = elements(editorTree).find((node) => node.props['aria-label'] === t('sidebar.project.rename'))
assert.ok(renameField, 'choosing rename opens the shell\'s editor in the row')
renameField.props.onChange({ target: { value: 'demo-renamed' } })
const typedTree = await settle(region)
assert.equal(
  elements(typedTree).find((node) => node.props['aria-label'] === t('sidebar.project.rename')).props.value,
  'demo-renamed',
  'the field is the region\'s draft',
)
buttons(typedTree, 'Save')[0].props.onClick()
assert.deepEqual(lastServiceCall('workspaces', 'rename').args, ['w-lab', 'demo-renamed'], 'saving renames the project through the shipped service')

// Removing a project asks first: the dialog is the shell's own Modal, and only
// its confirm reaches the service.
const removeMenu = await openRowMenu(rowNamed(await settle(region), 'demo'), 'projectMenu')
elements(removeMenu).find((node) => node.props.role === 'menuitem' && node.props['data-id'] === 'remove').props.onClick({})
const asked = await settle(region)
const dialog = elements(asked).find((node) => node.props.role === 'dialog')
assert.ok(dialog, 'removing a project asks through the shell\'s dialog')
assert.ok(text(dialog).includes(t('sidebar.project.deleteAsk', { title: 'demo' })), 'the dialog names what it is about to remove')
assert.equal(serviceCallsTo('workspaces', 'delete').length, 0, 'merely opening the dialog must not remove anything')
sbNodes(asked, 'confirmOk')[0].props.onClick()
assert.deepEqual(lastServiceCall('workspaces', 'delete').args, ['w-lab'], 'confirming removes the project through the shipped service')

// A session row's menu is the shipped set, in the shipped order: pin, rename,
// fork, the id, the session's folder, and the archive toggle. The row is
// picked by id: the draft at the top of its project is a different row, and
// these are the calls that need a session that exists on the host.
const runningSession = sessionRowById(await settle(region), 's-1')
const sessionMenuTree = await openRowMenu(runningSession, 'sessionMenu')
const sessionMenu = byClass(sessionMenuTree, 'ui-menu')[0]
assert.deepEqual(
  menuItemIds(sessionMenu),
  ['pin', 'rename', 'fork', 'copyId', 'reveal', 'archive'],
  'the session menu is pin, rename, fork, copy id, reveal and archive, got: ' + menuItemIds(sessionMenu).join(','),
)

// The keycaps beside a command are the core's own binding, read out of the
// shortcut catalog, not one the region invented; a command the core does not
// bind prints none at all.
const menuRow = (tree, id) => elements(tree).find((node) => node.props['role'] === 'menuitem' && node.props['data-id'] === id)
assert.equal(menuRow(sessionMenu, 'rename').props['data-shortcut'], 'Ctrl + Alt + G', 'rename prints the core binding')
assert.equal(menuRow(sessionMenu, 'fork').props['data-shortcut'], 'Ctrl + Shift + F', 'fork prints the core binding')
assert.equal(menuRow(sessionMenu, 'archive').props['data-shortcut'], 'Ctrl + Alt + A', 'archive prints the core binding')
assert.equal(menuRow(sessionMenu, 'pin').props['data-shortcut'], undefined, 'pin is not a core command, so it claims no key')

// pin is the uiWorkspace call, named after the row's current state.
elements(sessionMenu).find((node) => node.props['data-id'] === 'pin').props.onClick({})
assert.deepEqual(lastServiceCall('uiWorkspace', 'pinSession').args, ['s-1'], 'pinning goes through uiWorkspace')

// fork carries the session id as an object, the shape the client service takes.
elements(sessionMenu).find((node) => node.props['data-id'] === 'fork').props.onClick({})
assert.deepEqual(lastServiceCall('sessions', 'fork').args, [{ sessionId: 's-1' }], 'fork passes the session id as `{ sessionId }`')

// copyId hands the id to the shell's clipboard.
UI_PRIMITIVES.writeClipboard.reset()
const copyMenuTree = await openRowMenu(sessionRowById(await settle(region), 's-1'), 'sessionMenu')
elements(byClass(copyMenuTree, 'ui-menu')[0]).find((node) => node.props['data-id'] === 'copyId').props.onClick({})
assert.equal(UI_PRIMITIVES.writeClipboard.calls, 1, 'copying a session id writes through the shell clipboard')
assert.equal(UI_PRIMITIVES.writeClipboard.last, 's-1', 'and it copies the row\'s own id')

// archive is the uiWorkspace call, named after the row's current state.
const archiveMenuTree = await openRowMenu(sessionRowById(await settle(region), 's-1'), 'sessionMenu')
elements(byClass(archiveMenuTree, 'ui-menu')[0]).find((node) => node.props['data-id'] === 'archive').props.onClick({})
assert.deepEqual(lastServiceCall('uiWorkspace', 'archiveSession').args, ['s-1'], 'archiving goes through uiWorkspace')

// reveal asks the host to open the session's own folder — the call the shipped
// menu makes for "show in folder", with the directory the projection carried.
const revealMenuTree = await openRowMenu(sessionRowById(await settle(region), 's-1'), 'sessionMenu')
elements(byClass(revealMenuTree, 'ui-menu')[0]).find((node) => node.props['data-id'] === 'reveal').props.onClick({})
assert.deepEqual(
  lastServiceCall('remoteSession', 'openWorkspacePath').args,
  [{ path: SESSION_LIST.byId['s-1'].cwd, action: 'reveal' }],
  'revealing hands the host the session folder and the reveal action',
)

// The row's hover cluster is the shipped row's: the menu trigger, then the
// archive button, then the pin button — the order the shipped sidebar draws
// them in, and reachable without opening the menu.
const hoverRow = sessionRowById(await settle(region), 's-1')
const hoverCluster = byClass(hoverRow, 'ph-sb-actions')[0]
assert.ok(hoverCluster, 'the session row draws its action cluster')
assert.deepEqual(
  elements(hoverCluster)
    .filter((node) => node.props['data-sb'] === 'sessionArchive' || node.props['data-sb'] === 'sessionPin')
    .map((node) => node.props['data-sb']),
  ['sessionArchive', 'sessionPin'],
  'the cluster is archive then pin',
)
assert.equal(sbNodes(hoverRow, 'sessionArchive')[0].props['aria-label'], t('sidebar.session.archive'), 'the archive button names what it does')
assert.equal(sbNodes(hoverRow, 'sessionPin')[0].props['aria-label'], t('sidebar.session.pin'), 'the pin button names what it does')
sbNodes(hoverRow, 'sessionPin')[0].props.onClick({ stopPropagation() {} })
assert.deepEqual(lastServiceCall('uiWorkspace', 'pinSession').args, ['s-1'], 'the hover pin button pins that row')
sbNodes(hoverRow, 'sessionArchive')[0].props.onClick({ stopPropagation() {} })
assert.deepEqual(lastServiceCall('uiWorkspace', 'archiveSession').args, ['s-1'], 'the hover archive button archives that row')

// A command the core binds to a key belongs to the row that holds the focus:
// the row claims the gesture (preventDefault is what tells the core's own
// global copy to stand down) and runs it against its own session.
const keyRow = sessionRowById(await settle(region), 's-1')
let prevented = 0
keyRow.props.onKeyDown({
  code: 'KeyA',
  key: 'a',
  ctrlKey: true,
  altKey: true,
  shiftKey: false,
  metaKey: false,
  preventDefault: () => { prevented += 1 },
})
assert.equal(prevented, 1, 'the archive gesture is claimed by the focused row')
assert.deepEqual(lastServiceCall('uiWorkspace', 'archiveSession').args, ['s-1'], 'and it archives the row that was focused')
// A gesture one modifier away is a different command and is left alone.
const otherRow = sessionRowById(await settle(region), 's-1')
otherRow.props.onKeyDown({ code: 'KeyA', key: 'a', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, preventDefault: () => { prevented += 1 } })
assert.equal(prevented, 1, 'an unbound gesture is not consumed')

// A new session in a project is the row's own button, not a menu entry.
sbNodes(rowNamed(await settle(region), 'demo'), 'newSession')[0].props.onClick({ stopPropagation() {} })
assert.deepEqual(lastServiceCall('uiWorkspace', 'startSession').args, ['w-lab'], 'the row button starts a session in that project')

// The rail's expand control asks the layout service to widen the sidebar. That
// service is installed into the region by name (`sidebarServices.layout`, filled
// from `ctx.get('layout')`), so the control is live and calls `toggleSidebar`.
assert.equal(
  Boolean(sbNodes(regionTree, 'expand')[0].props.disabled),
  false,
  'the narrow control is live: the region reaches the layout service by name',
)
sbNodes(regionTree, 'expand')[0].props.onClick({ stopPropagation() {} })
assert.deepEqual(lastServiceCall('layout', 'toggleSidebar').args, [], 'expanding goes through the layout service')

// The group menu: mint a project, rename the group, and delete it behind a
// dialog. Only a real group has the last two; the ungrouped bucket can only
// start a project.
const labSection = sbNodes(await settle(region), 'section')[0]
const groupMenuTree = await openRowMenu(labSection, 'groupMenu')
const groupMenu = byClass(groupMenuTree, 'ui-menu')[0]
assert.deepEqual(
  menuItemIds(groupMenu),
  ['newProject', 'rename', 'color', 'sort', 'delete'],
  'the group menu is a new project, a rename, a colour marker, the sort and a delete, got: ' + menuItemIds(groupMenu).join(','),
)
// The group's own marker: the same palette as a project's, written into the group
// record and drawn as the dot the head carries before its title.
elements(groupMenu).find((node) => node.props['data-id'] === 'color').props.onMouseEnter({ currentTarget: null })
const groupColourSub = byClass(await settle(region), 'ui-submenu')[0]
assert.ok(groupColourSub, 'a group carries a colour marker of its own')
const groupColourIds = menuItemIds(groupColourSub)
assert.equal(groupColourIds.length, 9, 'eight palette colours and the clear entry, got: ' + groupColourIds.join(','))
const groupColour = groupColourIds[0].slice('color:'.length)
elements(groupColourSub).find((node) => node.props['data-id'] === groupColourIds[0]).props.onClick({})
await settle(region)
await sleep(520)
assert.equal(
  surface.sidebar.groups(surface.sidebar.snapshot().layout)[0].color,
  groupColour,
  'taking a colour writes the group marker into the document',
)
assert.equal(
  byClass(sbNodes(await settle(region), 'section')[0], 'ph-sb-mark')[0].props.style.color,
  groupColour,
  'and the head is drawn with that colour',
)
const groupClearTree = await openRowMenu(sbNodes(await settle(region), 'section')[0], 'groupMenu')
elements(groupClearTree).find((node) => node.props['data-id'] === 'color').props.onMouseEnter({ currentTarget: null })
elements(byClass(await settle(region), 'ui-submenu')[0])
  .find((node) => node.props['data-id'] === 'color:').props.onClick({})
await settle(region)
await sleep(520)
assert.equal(
  surface.sidebar.groups(surface.sidebar.snapshot().layout)[0].color,
  null,
  'and the clear entry takes it off again',
)
const newProjectTree = await openRowMenu(sbNodes(await settle(region), 'section')[0], 'groupMenu')
elements(newProjectTree).find((node) => node.props['data-id'] === 'newProject').props.onClick({})
await settle(region)
assert.equal(serviceCallsTo('uiWorkspace', 'pickDirectory').length, 1, 'a new project asks the host to pick a folder')
assert.deepEqual(
  lastServiceCall('workspaces', 'create').args,
  [{ path: 'D:\\Picked\\fresh' }],
  'and the picked path becomes a workspace',
)

// A project added from a group's own control belongs to that group, and it
// arrives complete: making the workspace but leaving it in the ungrouped bucket
// — or in the list as a bare workspace id — is what "the new workspace never
// showed up under that category, under its own name" looked like from the
// reader's side.
await sleep(520)
const filedMember = surface.sidebar.members(surface.sidebar.snapshot().layout)['w-fresh']
assert.equal(filedMember && filedMember.group, 'lab', 'a project added from 实验室 is filed into 实验室')
const freshRow = sbNodes(sbNodes(await settle(region), 'section')[0], 'project')
  .find((node) => node.props['data-ws'] === 'w-fresh')
assert.ok(freshRow, 'and the new project is drawn under that heading')
assert.ok(text(freshRow).includes('Picked Folder'), 'under the name the Host gave it, got: ' + text(freshRow))
assert.ok(
  !text(freshRow).includes('w-fresh'),
  'never under the workspace id its own document record would fall back to',
)
assert.ok(!hasClass(freshRow, 'is-orphan'), 'and not marked as a stale assignment it is not')
const filedSaves = calls.filter((call) => call.endpoint === 'homepage/saveSidebarLayout')
assert.equal(
  surface.sidebar.members(filedSaves[filedSaves.length - 1].payload.args.layout)['w-fresh'].group,
  'lab',
  'the filing is persisted with the rest of the document',
)

// Recency counts the creation instant: a workspace with no Sessions is not an
// old project. It was just registered, so a section ordered by recency puts it
// first instead of at the bottom behind everything that ever ran.
surface.sidebar.mutate((live) => Object.assign({}, live, {
  groups: live.groups.map((group) => (group && group.id === 'lab'
    ? Object.assign({}, group, { sort: 'recent', collapsed: false })
    : group)),
}))
const recentOrder = sbNodes(sbNodes(await settle(region), 'section')[0], 'project')
  .map((node) => node.props['data-ws'])
assert.equal(
  recentOrder[0],
  'w-fresh',
  'the newest workspace leads a section ordered by recency, got: ' + recentOrder.join(','),
)

// …and it keeps that place once the Host's projection arrives, because the
// creation instant travels with the workspace itself rather than living in this
// region's memory.
const withFresh = Object.assign({}, WORKSPACE_SNAPSHOT, {
  items: WORKSPACE_SNAPSHOT.items.concat([{
    workspaceId: 'w-fresh',
    path: 'D:/Picked/fresh',
    title: 'Picked Folder',
    sessionIds: [],
    createdAt: SESSION_BASE,
    updatedAt: SESSION_BASE,
  }]),
})
await feedReporter({
  useWorkspaces: (select) => select(withFresh),
  useSessions: (select) => select(SESSION_LIST),
})
const projectedOrder = sbNodes(sbNodes(await settle(region), 'section')[0], 'project')
  .map((node) => node.props['data-ws'])
assert.equal(
  projectedOrder[0],
  'w-fresh',
  'the projection carries the creation instant too, got: ' + projectedOrder.join(','),
)

// Put the projection, the sort and the member record back: the blocks below
// read them as the fixture wrote them.
await feedReporter({
  useWorkspaces: (select) => select(WORKSPACE_SNAPSHOT),
  useSessions: (select) => select(SESSION_LIST),
})
surface.sidebar.mutate((live) => {
  const members = Object.assign({}, live.members)
  delete members['w-fresh']
  return Object.assign({}, live, {
    members,
    groups: live.groups.map((group) => (group && group.id === 'lab'
      ? Object.assign({}, group, { sort: 'manual' })
      : group)),
  })
})
await settle(region)

// A group the reader had folded is unfolded for its new project: a row added
// inside a folded group is a row nobody can see, which reads as nothing having
// happened at all.
surface.sidebar.mutate((live) => Object.assign({}, live, {
  groups: live.groups.map((group) => (group && group.id === 'lab'
    ? Object.assign({}, group, { collapsed: true })
    : group)),
}))
const foldedAddTree = await openRowMenu(sbNodes(await settle(region), 'section')[0], 'groupMenu')
elements(foldedAddTree).find((node) => node.props['data-id'] === 'newProject').props.onClick({})
await settle(region)
await sleep(520)
assert.equal(
  surface.sidebar.groups(surface.sidebar.snapshot().layout).find((group) => group.id === 'lab').collapsed,
  false,
  'the group unfolds so the project it just received is on screen',
)

const renameGroupTree = await openRowMenu(sbNodes(await settle(region), 'section')[0], 'groupMenu')
elements(byClass(renameGroupTree, 'ui-menu')[0]).find((node) => node.props['data-id'] === 'rename').props.onClick({})
const groupEditorTree = await settle(region)
const groupField = elements(groupEditorTree).find((node) => node.props['aria-label'] === t('sidebar.list.rename'))
groupField.props.onChange({ target: { value: 'Laboratory' } })
buttons(await settle(region), 'Save')[0].props.onClick()
assert.equal(
  surface.sidebar.groups(surface.sidebar.snapshot().layout)[0].title,
  'Laboratory',
  'renaming a group is written into the document',
)

const layoutBeforeGroupDelete = surface.sidebar.snapshot().layout
const deleteMenuTree = await openRowMenu(sbNodes(await settle(region), 'section')[0], 'groupMenu')
elements(byClass(deleteMenuTree, 'ui-menu')[0]).find((node) => node.props['data-id'] === 'delete').props.onClick({})
const deleteAskTree = await settle(region)
const deleteAsk = elements(deleteAskTree).find((node) => node.props.role === 'dialog')
assert.ok(deleteAsk, 'removing a group asks through the shell\'s dialog')
assert.ok(text(deleteAsk).includes(t('sidebar.group.deleteAsk', { title: 'Laboratory' })), 'the dialog names the group')
sbNodes(deleteAskTree, 'confirmCancel')[0].props.onClick()
assert.equal(
  surface.sidebar.groups(surface.sidebar.snapshot().layout).length,
  2,
  'cancelling the dialog keeps the group',
)
// Taking a confirm-requiring row puts the menu away before the dialog opens: the
// shell's Menu does not close itself on select (Menu.tsx:529-533), and a menu
// left floating over the dialog would be the one thing the click did not take
// care of. So the second attempt reopens the menu from the row.
assert.equal(
  byClass(await settle(region), 'ui-menu').length,
  0,
  'asking for confirmation puts the menu that asked away',
)
const reopenedMenu = await openRowMenu(sbNodes(await settle(region), 'section')[0], 'groupMenu')
elements(byClass(reopenedMenu, 'ui-menu')[0]).find((node) => node.props['data-id'] === 'delete').props.onClick({})
sbNodes(await settle(region), 'confirmOk')[0].props.onClick()
assert.equal(surface.sidebar.groups(surface.sidebar.snapshot().layout).length, 1, 'confirming drops the group from the document')
await sleep(520)
assert.ok(calls.some((call) => call.endpoint === 'homepage/saveSidebarLayout'), 'dropping a group is persisted')
// Put the fixture's document back: the rest of the block reads it as written.
surface.sidebar.mutate(() => layoutBeforeGroupDelete)
await settle(region)

// ------------------------------------------------- the region's own options
//
// Three options the document carries rather than a client service: a project's
// colour marker, a project's pin, and how a section orders its projects. All
// three are written through `mutateSidebarLayout`, so they are asserted on the
// document the store holds and on the tree the region draws from it.

/** The project row of one workspace. */
const projectByWs = (tree, ws) => sbNodes(tree, 'project').find((node) => node.props['data-ws'] === ws)
/** The section row of one group. */
const sectionByKey = (tree, key) => sbNodes(tree, 'section').find((node) => node.props['data-group'] === key)

// These cases start from the document the region was first handed, not from
// whatever the cases above left behind: a pin and a colour are read off the
// member record, so a regrouping made earlier would decide these orders instead
// of the option under test.
surface.sidebar.mutate(() => layoutAtRest)
const atRestOrder = sbNodes(await settle(region), 'project').map((node) => node.props['data-ws'])
assert.deepEqual(
  atRestOrder,
  ['w-lab', 'w-gone', 'w-work', 'w-notes'],
  'the options below start from the document as the region was first handed it, got: ' + atRestOrder.join(','),
)

// The height chain. The host mounts this region as a bare custom element inside
// its own column, so the element itself has to carry the flex/height, or nothing
// bounds the list: the region grows to its content and the list's own scroll
// never engages, which is the defect the reader reported as "the sidebar does
// not scroll".
const sheet = String(appendedStyles[0].textContent)
assert.ok(
  sheet.includes('homepage-sidebar{display:flex;flex-direction:column;flex:1 1 auto'),
  'the region styles the element it is mounted in, so the list has a bounded height',
)
assert.ok(
  sheet.includes('.ph-sb{flex:1 1 auto;display:flex;flex-direction:column'),
  'and the shell fills that height instead of growing to its content',
)
// Every box between the element and the scrolling list has to pass the height on;
// one link that sizes to its content stops the chain there and the list grows
// instead of scrolling. The measured render (preview/12-sidebar-scroll-check.png)
// is the same story from the browser's side: scrollHeight 426 vs clientHeight 180.
for (const link of [
  '.ph-sb-body{flex:1 1 auto;display:flex;flex-direction:column',
  '.ph-sb-scroll{position:relative;flex:1 1 auto;min-height:0',
  '.ph-sb-list{flex:1 1 auto;min-height:0;overflow-y:auto',
]) {
  assert.ok(sheet.includes(link), 'the height chain carries through: ' + link)
}
// A container query loses to any later rule of equal specificity, so the rail's
// hide for the list has to be restated after the base `.ph-sb-scroll` rule — up in
// the first @container block it was silently overridden and the squeezed tree kept
// drawing itself under the icon column.
const railHide = sheet.indexOf('@container ph-sidebar (max-width:120px){.ph-sb-scroll{display:none}}')
const scrollBase = sheet.indexOf('.ph-sb-scroll{position:relative')
assert.ok(
  railHide > scrollBase && scrollBase >= 0,
  'the rail hides the list after the rule that shows it, so the rail is icons only',
)

// A project the sidebar lists no sessions under has nothing to unfold, so it
// gets no fold control: a caret there is a button that cannot do anything, which
// is what "some projects cannot be expanded" looks like from the reader's side.
const staleRow = projectByWs(await settle(region), 'w-gone')
assert.equal(sbNodes(staleRow, 'projectToggle').length, 0, 'a project with no sessions carries no fold control')
assert.equal(sbNodes(projectByWs(await settle(region), 'w-lab'), 'projectToggle').length, 1, 'a project with sessions keeps it')

// The colour marker: the menu offers the document's own palette plus the way to
// take the marker off, and taking one writes the member record and tints the
// folder the project is drawn with.
const colourTree = await openRowMenu(projectByWs(await settle(region), 'w-lab'), 'projectMenu')
elements(colourTree).find((node) => node.props['data-id'] === 'color').props.onMouseEnter({ currentTarget: null })
const colourSub = byClass(await settle(region), 'ui-submenu')[0]
assert.ok(colourSub, 'the colour marker opens a panel beside the menu')
const colourIds = menuItemIds(colourSub)
assert.equal(colourIds.length, 9, 'eight palette colours and the clear entry, got: ' + colourIds.join(','))
assert.equal(colourIds[colourIds.length - 1], 'color:', 'the last entry clears the marker')
assert.ok(
  colourIds.slice(0, -1).every((id) => id.indexOf('color:#') === 0),
  'every other entry names a colour, got: ' + colourIds.join(','),
)
const chosenColor = colourIds[0].slice('color:'.length)
elements(colourSub).find((node) => node.props['data-id'] === colourIds[0]).props.onClick({})
await settle(region)
await sleep(520)
assert.equal(
  surface.sidebar.members(surface.sidebar.snapshot().layout)['w-lab'].color,
  chosenColor,
  'taking a colour writes the project\'s marker into the document',
)
assert.equal(
  byClass(projectByWs(await settle(region), 'w-lab'), 'ph-sb-folder')[0].props.style.color,
  chosenColor,
  'and the project is drawn with that colour',
)
const clearTree = await openRowMenu(projectByWs(await settle(region), 'w-lab'), 'projectMenu')
elements(clearTree).find((node) => node.props['data-id'] === 'color').props.onMouseEnter({ currentTarget: null })
const clearSub = byClass(await settle(region), 'ui-submenu')[0]
elements(clearSub).find((node) => node.props['data-id'] === 'color:').props.onClick({})
await settle(region)
await sleep(520)
assert.equal(
  surface.sidebar.members(surface.sidebar.snapshot().layout)['w-lab'].color,
  null,
  'the clear entry takes the marker off again',
)

// Pin: one entry that flips, written into the same member record, and a pinned
// project leads its own section. The section is first given a project it lists
// *second* — the fixture's own ungrouped project, assigned into the same group —
// because only then does the order the region draws prove the pin moved it.
surface.sidebar.mutate((live) => Object.assign({}, live, {
  members: Object.assign({}, live.members, {
    'w-notes': { group: 'lab', order: 9, color: null, hidden: false, alias: null, pinned: false },
  }),
}))
const listedBefore = sbNodes(await settle(region), 'project').map((node) => node.props['data-ws'])
assert.deepEqual(
  listedBefore,
  ['w-lab', 'w-notes', 'w-gone', 'w-work'],
  'the section lists its projects in the order the sidebar reported, got: ' + listedBefore.join(','),
)
const pinTree = await openRowMenu(projectByWs(await settle(region), 'w-notes'), 'projectMenu')
assert.ok(menuItemIds(pinTree).includes('pin'), 'the project menu offers a pin, got: ' + menuItemIds(pinTree).join(','))
elements(pinTree).find((node) => node.props['data-id'] === 'pin').props.onClick({})
await settle(region)
await sleep(520)
assert.equal(
  surface.sidebar.members(surface.sidebar.snapshot().layout)['w-notes'].pinned,
  true,
  'pinning writes the member record into the document',
)
assert.deepEqual(
  sbNodes(await settle(region), 'project').map((node) => node.props['data-ws']),
  ['w-notes', 'w-lab', 'w-gone', 'w-work'],
  'a pinned project leads its own section',
)
assert.equal(
  byClass(projectByWs(await settle(region), 'w-notes'), 'ph-sb-pin').length,
  1,
  'and is drawn with the pin the session rows use',
)
const unpinTree = await openRowMenu(projectByWs(await settle(region), 'w-notes'), 'projectMenu')
assert.ok(text(unpinTree).includes(t('sidebar.project.unpin')), 'the entry is named as the way back while pinned')
elements(unpinTree).find((node) => node.props['data-id'] === 'pin').props.onClick({})
await settle(region)
await sleep(520)
assert.equal(
  surface.sidebar.members(surface.sidebar.snapshot().layout)['w-notes'].pinned,
  false,
  'taking the same entry again unpins',
)
assert.deepEqual(
  sbNodes(await settle(region), 'project').map((node) => node.props['data-ws']),
  ['w-lab', 'w-notes', 'w-gone', 'w-work'],
  'and the section goes back to the order it was listed in',
)

// Sorting by modification time. The listing above is already newest first, so
// the reporter is asked for one where it is not — the oldest project first,
// inside the same group — because only then does the order the region draws
// prove which rule produced it. (`w-gone` stays as the section's stale
// assignment, so the shelf below it is the document's own record, not a project
// the sidebar still reports.)
const oldestFirst = Object.assign({}, WORKSPACE_SNAPSHOT, {
  items: [WORKSPACE_SNAPSHOT.items[2], WORKSPACE_SNAPSHOT.items[0], WORKSPACE_SNAPSHOT.items[1]],
})
await feedReporter({
  useWorkspaces: (select) => select(oldestFirst),
  useSessions: (select) => select(SESSION_LIST),
})
const listed = sbNodes(await settle(region), 'project').map((node) => node.props['data-ws'])
assert.deepEqual(
  listed,
  ['w-notes', 'w-lab', 'w-gone', 'w-work'],
  'with no sort the section keeps the order the sidebar listed, got: ' + listed.join(','),
)
const sortTree = await openRowMenu(sectionByKey(await settle(region), 'lab'), 'groupMenu')
assert.ok(text(sortTree).includes(t('sidebar.group.sortRecent')), 'the group menu offers sorting by modification time')
elements(byClass(sortTree, 'ui-menu')[0]).find((node) => node.props['data-id'] === 'sort').props.onClick({})
await settle(region)
await sleep(520)
assert.equal(
  surface.sidebar.groups(surface.sidebar.snapshot().layout).find((group) => group.id === 'lab').sort,
  'recent',
  'the section remembers the sort it was given',
)
const sorted = sbNodes(await settle(region), 'project').map((node) => node.props['data-ws'])
assert.deepEqual(
  sorted,
  ['w-lab', 'w-notes', 'w-gone', 'w-work'],
  'newest first inside the section, got: ' + sorted.join(','),
)
const unsortTree = await openRowMenu(sectionByKey(await settle(region), 'lab'), 'groupMenu')
assert.ok(text(unsortTree).includes(t('sidebar.group.sortManual')), 'and the entry names the other half of the sort')
elements(byClass(unsortTree, 'ui-menu')[0]).find((node) => node.props['data-id'] === 'sort').props.onClick({})
await settle(region)
await sleep(520)
assert.equal(
  surface.sidebar.groups(surface.sidebar.snapshot().layout).find((group) => group.id === 'lab').sort,
  'manual',
  'taking it again restores the listing order',
)
assert.deepEqual(
  sbNodes(await settle(region), 'project').map((node) => node.props['data-ws']),
  ['w-notes', 'w-lab', 'w-gone', 'w-work'],
  'and the listing order is back',
)
// Put the fixture back: the rest of the block reads the document and the
// projection as they were written.
surface.sidebar.mutate(() => layoutAtRest)
await feedReporter({
  useWorkspaces: (select) => select(WORKSPACE_SNAPSHOT),
  useSessions: (select) => select(SESSION_LIST),
})
regionTree = await settle(region)

// ------------------------------------------------------------- content search
//
// A query drives the client's own content search after a short settle, and the
// results replace the tree until the field is cleared.
const searchInput = sbNodes(regionTree, 'searchInput')[0]
sbNodes(regionTree, 'toggleSearch')[0].props.onClick({})
const openedSearch = await settle(region)
assert.ok(
  hasClass(byClass(openedSearch, 'ph-sb-search')[0], 'is-open'),
  'the header opens its search field',
)
assert.ok(
  hasClass(byClass(openedSearch, 'ph-sb-bar-search')[0], 'is-open'),
  'and widens the field the bar gives it',
)
assert.ok(
  hasClass(byClass(openedSearch, 'ph-sb-bar-label')[0], 'is-hidden'),
  'while the title gives up the room',
)
sbNodes(await settle(region), 'searchInput')[0].props.onChange({ target: { value: '发布' } })
const searchingTree = await settle(region)
assert.equal(sbNodes(searchingTree, 'searching').length, 1, 'a query that has not answered yet says so')
assert.equal(text(sbNodes(searchingTree, 'searching')[0]), t('sidebar.list.searching'), 'and names the state')
await sleep(260)
const resultsTree = await settle(region)
assert.deepEqual(lastServiceCall('sessions', 'search').args, ['发布'], 'the query reaches the session search service')
const resultRows = sbNodes(resultsTree, 'result')
assert.equal(resultRows.length, 1, 'the hit is drawn as a result row')
assert.equal(resultRows[0].props['data-id'], 's-3', 'the row carries the session the search found')
assert.ok(text(resultRows[0]).includes('发布检查'), 'the hit is titled by the session it names')
assert.ok(text(resultRows[0]).includes('app'), 'and names the project it lives in')
assert.ok(
  text(byClass(resultsTree, 'ph-sb-result-snippet')[0]).includes('发布'),
  'the row shows the snippet the search returned',
)
assert.equal(
  text(byClass(resultsTree, 'ph-sb-result-ws')[0]),
  'app',
  'the hit names the project it lives in',
)
resultRows[0].props.onClick()
assert.deepEqual(lastServiceCall('uiWorkspace', 'openSession').args, ['s-3'], 'clicking a hit opens that session')

sbNodes(resultsTree, 'searchInput')[0].props.onChange({ target: { value: 'none-matches' } })
await sleep(260)
const noMatchTree = await settle(region)
assert.equal(sbNodes(noMatchTree, 'noMatch').length, 1, 'a search with no hits says so')
assert.equal(sbNodes(noMatchTree, 'result').length, 0, 'and draws no row')
sbNodes(noMatchTree, 'clearSearch')[0].props.onClick({})
const clearedTree = await settle(region)
assert.equal(sbNodes(clearedTree, 'searching').length, 0, 'clearing the field leaves the tree')
assert.equal(sbNodes(clearedTree, 'section').length, 3, 'and the groups come back')
assert.notEqual(searchInput, sbNodes(clearedTree, 'searchInput')[0], 'the field is the tree\'s own, so this is the re-rendered one')

// ---------------------------------------------------------- archived sessions
//
// An archived session is not in the tree at all — no count row, no way in. The
// shipped browser keeps archived sessions behind its own archive view; inventing
// an "archived (1)" line (or a Show more row that reveals it) is the extra box
// the reader asked us to drop.
await feedReporter({
  useWorkspaces: (select) => select(Object.assign({}, WORKSPACE_SNAPSHOT, { archivedSessionIds: ['s-4'] })),
  useSessions: (select) => select(SESSION_LIST),
})
const archivedTree = await settle(region)
assert.equal(sessionsUnder(archivedTree, 'w-notes').length, 0, 'an archived session is not drawn')
assert.equal(sbNodes(archivedTree, 'toggleArchived').length, 0, 'nothing offers to reveal the archive')
const archivedProject = projectByWs(archivedTree, 'w-notes')
assert.ok(archivedProject, 'the project itself stays, it just has nothing to list')
assert.equal(sbNodes(archivedProject, 'overflow').length, 0, 'and it carries no Show more row for the archive')
assert.equal(sbNodes(archivedProject, 'projectToggle').length, 0, 'so it drops the caret with the sessions')
// Both of this round's changes in one picture: the project whose only session is
// archived lists nothing and carries no caret, and the group menu now carries the
// group's own colour marker.
dumpPreview(
  await openRowMenu(sbNodes(archivedTree, 'section')[0], 'groupMenu'),
  '12-sidebar-group-menu',
  { width: 260, css: '.pv-chrome{height:520px!important}' },
)
await feedReporter({
  useWorkspaces: (select) => select(WORKSPACE_SNAPSHOT),
  useSessions: (select) => select(SESSION_LIST),
})
regionTree = await settle(region)

// Who owns the region follows the document's mode: the shipped list drops the
// registration so the shipped occupant takes the region back, and the grouped
// list takes it over again. The mode is read as written — there is no earlier
// document version to migrate from.
surface.sidebar.mutate(() => layoutAtRest)
await settle(region)
surface.sidebar.mutate((live) => Object.assign({}, live, { mode: 'native' }))
assert.ok(
  !registrations.some((entry) => entry.slotName === 'sidebar.workspaces'),
  'the shipped list must get the region back',
)
surface.sidebar.mutate((live) => Object.assign({}, live, { mode: 'grouped' }))
assert.ok(
  registrations.some((entry) => entry.slotName === 'sidebar.workspaces'),
  'the grouped list must be able to take the region over again',
)
// A stored mode is the user's choice, whatever version wrote it.
surface.sidebar.mutate((live) => Object.assign({}, live, { version: 1, mode: 'native' }))
assert.ok(
  !registrations.some((entry) => entry.slotName === 'sidebar.workspaces'),
  'a stored native document keeps the shipped list',
)
surface.sidebar.mutate((live) => Object.assign({}, live, { version: 1, mode: 'grouped' }))
assert.ok(
  registrations.some((entry) => entry.slotName === 'sidebar.workspaces'),
  'a stored grouped document keeps the grouped list',
)
surface.sidebar.setMode('native')
assert.equal(surface.sidebar.mode(), 'native', 'the mode reads back as what this page asked for')
assert.ok(
  !registrations.some((entry) => entry.slotName === 'sidebar.workspaces'),
  'choosing the shipped list in this page hands the region back',
)
surface.sidebar.setMode('grouped')
assert.ok(
  registrations.some((entry) => entry.slotName === 'sidebar.workspaces'),
  'and choosing the grouped list takes the region over again',
)

// The header's own grid button is the same switch, driven from the region: the
// region reports the mode it drew and hands the slot back on the click.
regionTree = await settle(region)
sbNodes(regionTree, 'mode')[0].props.onClick({ stopPropagation() {} })
assert.equal(surface.sidebar.mode(), 'native', 'the header button asks for the shipped list')
assert.ok(
  !registrations.some((entry) => entry.slotName === 'sidebar.workspaces'),
  'and the region gives the slot back',
)
surface.sidebar.setMode('grouped')
await settle(region)
assert.ok(
  registrations.some((entry) => entry.slotName === 'sidebar.workspaces'),
  'choosing the grouped list takes it over again',
)
await settle(region)
// Taking the region over a second time must not stack a second stylesheet.
assert.equal(appendedStyles.length, 1, 'the region sheet is appended once, however often the region changes hands')

dumpPreview(await settle(main.render, { t }), '11-expanded-sidebar')

// The region was the whole point of the round, and until now nothing dumped it:
// the card's own preview shows the manager, not the list the user actually sees
// in the sidebar. Three widths, because the region draws one tree in two shapes,
// and one fold, because a collapsed heading is the shape that carries the count.
// The document is put back to the one the host answered first, so the render is
// the region at rest and not the region after this block's edits.
surface.sidebar.mutate(() => layoutAtRest)
await sleep(520)
let previewRegion = await settle(region)
// The search block above leaves the field open; the resting shape is what the
// user meets on a fresh sidebar, so put the field away before the dump.
if (hasClass(byClass(previewRegion, 'ph-sb-search')[0], 'is-open')) {
  sbNodes(previewRegion, 'toggleSearch')[0].props.onClick({})
  previewRegion = await settle(region)
}
dumpPreview(previewRegion, '12-sidebar-region', { width: 260 })
// The list scrolls inside the host rather than growing past it: this dump asks
// for a host shorter than the region's content, so the scrollbar in the picture
// is the region's own (and the rows below the fold are reachable, not clipped).
dumpPreview(previewRegion, '12-sidebar-scroll', { width: 260, css: '.pv-chrome{height:220px!important}' })
dumpPreview(previewRegion, '12-sidebar-rail', { width: 112 })
dumpPreview(previewRegion, '12-sidebar-region-rail', { width: 112 })
sbNodes(previewRegion, 'groupToggle')[0].props.onClick({ stopPropagation() {} })
dumpPreview(await settle(region), '12-sidebar-region-folded', { width: 260 })
sbNodes(await settle(region), 'groupToggle')[0].props.onClick({ stopPropagation() {} })
// The three options the document carries — a pinned project, a colour marker
// and a section ordered by modification time — drawn together: each one only
// shows in the tree, so the resting shape alone would not show them. The
// document goes back to rest for the menu dump below.
surface.sidebar.mutate((live) => Object.assign({}, live, {
  members: Object.assign({}, live.members, {
    'w-notes': { group: 'lab', order: 9, color: null, hidden: false, alias: null, pinned: true },
    'w-lab': { group: 'lab', order: 1, color: '#e5484d', hidden: false, alias: null, pinned: false },
  }),
  groups: surface.sidebar.groups(live).map((group) => (group.id === 'lab' ? Object.assign({}, group, { sort: 'recent' }) : group)),
}))
await sleep(520)
dumpPreview(await settle(region), '12-sidebar-options', { width: 260 })
surface.sidebar.mutate(() => layoutAtRest)
await sleep(520)
// The row menu is where the grouping entry lives, so the preview has to show it
// open with its own panel beside it — that interaction is the deliverable.
const menuDemo = rowNamed(await settle(region), 'demo')
const menuTreeOpen = await openRowMenu(menuDemo, 'projectMenu')
elements(menuTreeOpen).find((node) => node.props.role === 'menuitem' && node.props['data-id'] === 'move')
  .props.onMouseEnter({ currentTarget: null })
dumpPreview(await settle(region), '13-sidebar-menu', { width: 260, css: '.pv-chrome{height:340px!important}' })
api.close()

// -------------------------------------------------------------- error surfaces
//
// A control that quietly does nothing is the defect this region was rebuilt to
// fix, so a failing action reports itself in place instead of being swallowed.
failNextAction('uiWorkspace', 'openWorkspace')
sbNodes(await settle(region), 'project')[0].props.onClick({})
const failedTree = await settle(region)
assert.equal(sbNodes(failedTree, 'actionError').length, 1, 'a failing action reports itself')
assert.ok(
  text(sbNodes(failedTree, 'actionError')[0]).includes('boom from uiWorkspace.openWorkspace'),
  'and names the reason, got: ' + text(sbNodes(failedTree, 'actionError')[0]),
)
// A later action that works puts the region back to rest: a report that never
// clears is as bad as one that never appears.
sbNodes(failedTree, 'session').filter((node) => node.props['data-id'] === 's-1')[0].props.onClick({})
assert.equal(sbNodes(await settle(region), 'actionError').length, 0, 'the failure line clears when the next action succeeds')

// A projection that cannot be read is a different state: the failure line plus a
// retry that re-reads, not a blank region.
//
// The edits above save on a 400ms debounce, and a save that lands *after* a failed
// read clears the same `error` field the read wrote (framework.part.js:4217-4222
// patches `error: null` on a successful save), so the store is left quiet first.
await sleep(520)
FIXTURES['homepage/sidebarLayout'] = TRANSPORT_FAILURE
await surface.sidebar.load(true).catch(() => {})
const brokenTree = await settle(region)
assert.equal(sbNodes(brokenTree, 'storeError').length, 1, 'a projection that cannot be read says so')
assert.equal(sbNodes(brokenTree, 'retry').length, 1, 'and offers the retry')
const readsBeforeRetry = calls.filter((call) => call.endpoint === 'homepage/sidebarLayout').length
FIXTURES['homepage/sidebarLayout'] = SIDEBAR_LAYOUT_FIXTURE
sbNodes(brokenTree, 'retry')[0].props.onClick({})
await settle(region)
await sleep(60)
assert.equal(sbNodes(await settle(region), 'storeError').length, 0, 'the retry clears the failure line')
assert.ok(
  calls.filter((call) => call.endpoint === 'homepage/sidebarLayout').length > readsBeforeRetry,
  'because it re-reads the document',
)

// ------------------------------------------------------------- the add menu

/** The one open kit menu of the wide header. */
const wideMenuOf = (tree) => byClass(tree, 'ui-menu').find((node) => elements(byClass(tree, 'ph-sb-wide')[0]).includes(node))
const addTree = await openRowMenu(await settle(region), 'add')
const addMenu = byClass(byClass(addTree, 'ph-sb-wide')[0], 'ui-menu')[0]
assert.ok(addMenu, 'the header add menu opens in the wide shape')
assert.deepEqual(menuItemIds(addMenu), ['newProject', 'newGroup'], 'the add menu offers a project and a group')
// The narrow trigger is in the tree too, and a `Menu` there would be open as
// well: its anchor is display:none (so the list lands in the viewport corner)
// and its own outside-pointer listener closes the wide menu on the pointerdown
// that starts a row's click, which is what made every entry do nothing.
assert.equal(
  byClass(byClass(addTree, 'ph-sb-rail')[0], 'ui-menu').length,
  0,
  'only the trigger the container query keeps mounts the add menu',
)
assert.equal(byClass(addTree, 'ui-menu').length, 1, 'and exactly one menu is mounted')
elements(addMenu).find((node) => node.props['data-id'] === 'newGroup').props.onClick({})
const newGroupEditor = await settle(region)
const newGroupField = elements(newGroupEditor).find((node) => node.props['aria-label'] === t('sidebar.list.newGroup'))
assert.ok(newGroupField, 'minting a group opens the editor in the region\'s own layer')
// The editor used to be a viewport-wide overlay with a hard-coded 24/64 offset:
// it landed in the page's corner, painted over every click, and had no way out.
// With the kit present it is the shell's own dialog (themed, dismissible) with a
// bordered field and the shell's own footer buttons, not a menu row and not the
// borderless inline editor used for renaming a row in place.
assert.equal(byClass(newGroupEditor, 'ph-sb-modal').length, 1, 'the editor is the shell dialog')
assert.equal(byClass(newGroupEditor, 'ph-sb-pop-layer').length, 0, 'and no longer pins a full-page layer under it')
assert.equal(byClass(newGroupEditor, 'ph-sb-field').length, 1, 'the name is a dialog field, not an inline editor')
assert.equal(sbNodes(newGroupEditor, 'groupApply').length, 1, 'and the commit sits in the dialog footer')
newGroupField.props.onChange({ target: { value: 'Focused' } })
sbNodes(await settle(region), 'groupApply')[0].props.onClick({})
await settle(region)
await sleep(520)
assert.deepEqual(
  surface.sidebar.groups(surface.sidebar.snapshot().layout).map((group) => group.title),
  ['实验室', 'Work', 'Focused'],
  'the minted group is appended to the document',
)
assert.ok(calls.some((call) => call.endpoint === 'homepage/saveSidebarLayout'), 'and persisted')

// ------------------------------------- the folder chooser when the picker fails
//
// A page served from anything but loopback has no OS chooser: the Host mounts
// its browsing capability, `uiWorkspace.pickDirectory` refuses, and the add
// action used to die there. The region must fall back to the two Host calls the
// shipped sidebar uses in that mode — list one level, then create the workspace
// from the folder the reader settles on — instead of leaving the entry dead.
const regionDir = region
const dirArmedAt = SERVICE_FAILURES.length
SERVICE_FAILURES.push('uiWorkspace.pickDirectory')
const dirLevels = []
shippedServices.uiWorkspace.listDirectory = (path) => {
  dirLevels.push(path)
  return Promise.resolve(!path
    ? {
      path: '/home/me',
      home: '/home/me',
      crumbs: [{ name: 'Home', path: '/home/me' }],
      entries: [
        { name: 'projects', path: '/home/me/projects', hidden: false },
        { name: '.cache', path: '/home/me/.cache', hidden: true },
      ],
      truncated: false,
    }
    : {
      path,
      home: '/home/me',
      crumbs: [{ name: 'Home', path: '/home/me' }, { name: 'projects', path }],
      entries: [],
      truncated: false,
    })
}
shippedServices.uiWorkspace.createDirectory = () => Promise.resolve('/home/me/projects')
try {
  const dirAddTree = await openRowMenu(await settle(regionDir), 'add')
  const dirAddMenu = byClass(byClass(dirAddTree, 'ph-sb-wide')[0], 'ui-menu')[0]
  elements(dirAddMenu).find((node) => node.props['data-id'] === 'newProject').props.onClick({})
  let dirPanel = await settle(regionDir)
  await sleep(20)
  dirPanel = await settle(regionDir)
  assert.equal(SERVICE_FAILURES.length, dirArmedAt, 'the add action still asks the Host chooser first')
  assert.equal(byClass(dirPanel, 'ph-sb-dir').length, 1, "a Host with no native chooser gets the region's own browser")
  assert.deepEqual(dirLevels, [undefined], "which starts at the Host's home directory")
  const dirRows = sbNodes(dirPanel, 'dirRow')
  assert.equal(dirRows.length, 1, 'and lists the folders the Host returned')
  assert.equal(dirRows[0].props['data-path'], '/home/me/projects', 'by their absolute paths')
  // The shipped folder dialog folds dot-led folders behind a footer toggle, and
  // so does this one; the toggle marks itself pressed instead of renaming its
  // label, which is what keeps the footer on one line.
  assert.equal(sbNodes(dirPanel, 'dirShowHidden').length, 1, 'the footer carries the hidden-items toggle')
  assert.equal(sbNodes(dirPanel, 'dirShowHidden')[0].props['aria-pressed'], 'false', 'and starts folded')
  assert.equal(sbNodes(dirPanel, 'dirNewFolder').length, 1, 'with the new-folder action beside it')
  assert.equal(sbNodes(dirPanel, 'dirCancel').length, 1, 'and the cancel/choose pair at the end')
  assert.equal(sbNodes(dirPanel, 'dirChoose').length, 1, 'with the choose action as its own control')
  sbNodes(dirPanel, 'dirShowHidden')[0].props.onClick({})
  const dirShown = await settle(regionDir)
  assert.equal(sbNodes(dirShown, 'dirRow').length, 2, 'toggling it brings the hidden folder back')
  assert.equal(sbNodes(dirShown, 'dirShowHidden')[0].props['aria-pressed'], 'true', 'and marks itself pressed')
  dirRows[0].props.onClick({})
  await settle(regionDir)
  await sleep(20)
  const dirInside = await settle(regionDir)
  assert.deepEqual(dirLevels, [undefined, '/home/me/projects'], 'opening a row asks for that level')
  // A path can be typed instead of walked: the crumb row turns into a field,
  // Escape drops the draft without reading a level, and Enter reads the path.
  assert.equal(sbNodes(dirInside, 'dirEditPath').length, 1, 'the trail offers a path editor')
  sbNodes(dirInside, 'dirEditPath')[0].props.onClick({})
  const dirEditing = await settle(regionDir)
  const dirPathField = sbNodes(dirEditing, 'dirPath')[0]
  assert.ok(dirPathField, 'clicking it turns the trail into a path field')
  assert.equal(dirPathField.props.value, '/home/me/projects', 'seeded with the folder on screen')
  dirPathField.props.onChange({ target: { value: '/home/me/projects/deep' } })
  const dirDrafted = await settle(regionDir)
  sbNodes(dirDrafted, 'dirPath')[0].props.onKeyDown({ key: 'Escape', stopPropagation() {} })
  const dirDropped = await settle(regionDir)
  assert.equal(sbNodes(dirDropped, 'dirPath').length, 0, 'Escape drops the draft')
  assert.deepEqual(dirLevels, [undefined, '/home/me/projects'], 'and reads no level of its own')
  sbNodes(dirDropped, 'dirEditPath')[0].props.onClick({})
  const dirEditingAgain = await settle(regionDir)
  sbNodes(dirEditingAgain, 'dirPath')[0].props.onChange({ target: { value: '/home/me/projects/deep' } })
  const dirTyped = await settle(regionDir)
  // The dialog names the folder its confirm action will register, and while the
  // field is open that name is the draft. Without this line the only way to know
  // what the button does was to remember whether Enter had walked the list to the
  // typed path — which is exactly the "it created the default folder instead"
  // report this answers.
  const dirTargetLine = sbNodes(dirTyped, 'dirTarget')[0]
  assert.ok(dirTargetLine, 'the dialog says where the workspace will be created')
  assert.ok(
    text(dirTargetLine).includes('/home/me/projects/deep'),
    'and it names the folder in the field, got: ' + text(dirTargetLine),
  )
  // The dialog's height chain. A flex child that shrinks clips its text, which is
  // how the line the reader needs to read lost the lower half of its glyphs; the
  // folder list is the one child that gives way, so the text above it keeps its
  // height and the list scrolls instead.
  assert.ok(
    sbStyles.includes('.ph-sb-dir-list{display:flex;flex-direction:column;gap:1px;min-height:0;overflow:auto;flex:1 1 auto}'),
    'the folder list carries the shrink, not the lines above it',
  )
  assert.ok(
    sbStyles.includes('.ph-sb-dir-target{flex:none;overflow-wrap:anywhere;'),
    'and the target line keeps its own height and wraps the path it names',
  )
  sbNodes(dirTyped, 'dirPath')[0].props.onKeyDown({ key: 'Enter', stopPropagation() {} })
  await settle(regionDir)
  await sleep(20)
  const dirDeep = await settle(regionDir)
  assert.deepEqual(dirLevels, [undefined, '/home/me/projects', '/home/me/projects/deep'], 'Enter reads the typed path')
  sbNodes(dirDeep, 'dirChoose')[0].props.onClick({})
  await settle(regionDir)
  await sleep(20)
  const dirAfter = await settle(regionDir)
  assert.deepEqual(
    lastServiceCall('workspaces', 'create').args,
    [{ path: '/home/me/projects/deep' }],
    'and the chosen folder becomes a workspace through the shipped service',
  )
  assert.equal(byClass(dirAfter, 'ph-sb-dir').length, 0, 'the dialog closes once the workspace exists')

  // The same confirm with the field still open — no Enter, nothing walked: the
  // typed path is the target, resolved by the Host so the workspace stores its
  // canonical spelling. Typing a folder and clicking the confirm is one gesture;
  // it must not need a second one to be believed.
  SERVICE_FAILURES.push('uiWorkspace.pickDirectory')
  const noEnterAddTree = await openRowMenu(await settle(regionDir), 'add')
  elements(byClass(byClass(noEnterAddTree, 'ph-sb-wide')[0], 'ui-menu')[0])
    .find((node) => node.props['data-id'] === 'newProject').props.onClick({})
  let noEnterPanel = await settle(regionDir)
  await sleep(20)
  noEnterPanel = await settle(regionDir)
  assert.equal(byClass(noEnterPanel, 'ph-sb-dir').length, 1, 'the browser is up again for the second add')
  sbNodes(noEnterPanel, 'dirEditPath')[0].props.onClick({})
  const noEnterEditing = await settle(regionDir)
  sbNodes(noEnterEditing, 'dirPath')[0].props.onChange({ target: { value: '/home/me/projects/later' } })
  const noEnterTyped = await settle(regionDir)
  assert.ok(
    text(sbNodes(noEnterTyped, 'dirTarget')[0]).includes('/home/me/projects/later'),
    'the target line follows the draft as it is typed',
  )
  sbNodes(noEnterTyped, 'dirChoose')[0].props.onClick({})
  await settle(regionDir)
  await sleep(20)
  const noEnterAfter = await settle(regionDir)
  assert.deepEqual(
    lastServiceCall('workspaces', 'create').args,
    [{ path: '/home/me/projects/later' }],
    'the confirm registers the typed path without an Enter first',
  )
  assert.equal(byClass(noEnterAfter, 'ph-sb-dir').length, 0, 'and the dialog closes on the workspace it made')
} finally {
  SERVICE_FAILURES.splice(dirArmedAt)
  delete shippedServices.uiWorkspace.listDirectory
  delete shippedServices.uiWorkspace.createDirectory
}

// --------------------------------------------- the provisional session, and folds
//
// A blank row is the shell's provisional New Session: not a session that was ever
// sent, just the one the reader is about to type into. Where it may be drawn is
// the region's decision rather than the projection's, and it shows up in three
// different things — whether the row is drawn at all, what a project's count
// says, and which project leads a group ordered by recency. The blocks below take
// those one at a time, each with the projection and the document it needs; the
// two before them are about the fold the caret writes, which is the other half of
// "the document owns the list".

// The fold is the reader's answer about the list, so the document owns it: the
// caret writes it, the debounced save persists it, and a later read of the same
// document draws the row the same way. Held in the region's own state instead,
// everything would look identical until that re-read — so the re-read is what
// this block measures, and it measures it against a store that currently says the
// opposite, so the assertion cannot pass by accident.
const docBeforeBlankBlocks = surface.sidebar.snapshot().layout
let foldTree = await settle(region)
assert.equal(
  sessionsUnder(foldTree, 'w-work').length,
  0,
  'a project that does not hold the current session starts closed, which is the shell\'s default',
)
sbNodes(rowNamed(foldTree, 'app'), 'projectToggle')[0].props.onClick({ stopPropagation() {} })
foldTree = await settle(region)
assert.equal(sessionsUnder(foldTree, 'w-work').length, 1, 'its caret opens the project')
assert.equal(
  surface.sidebar.expandedOf(surface.sidebar.snapshot().layout, 'w-work'),
  true,
  'and opening it is written into the document rather than kept in the region',
)
await sleep(520)
const openFoldSaves = calls.filter((call) => call.endpoint === 'homepage/saveSidebarLayout')
assert.ok(openFoldSaves.length > 0, 'the opened row must be persisted')
const openDocument = openFoldSaves[openFoldSaves.length - 1].payload.args.layout
assert.equal(surface.sidebar.expandedOf(openDocument, 'w-work'), true, 'the saved document carries it')
// Fold the same row again, through the same write and the same debounce.
sbNodes(rowNamed(await settle(region), 'app'), 'projectToggle')[0].props.onClick({ stopPropagation() {} })
const refoldedTree = await settle(region)
assert.equal(sessionsUnder(refoldedTree, 'w-work').length, 0, 'the same caret folds the project again')
await sleep(520)
const refoldSaves = calls.filter((call) => call.endpoint === 'homepage/saveSidebarLayout')
const foldedDocument = refoldSaves[refoldSaves.length - 1].payload.args.layout
assert.equal(surface.sidebar.expandedOf(foldedDocument, 'w-work'), false, 'and the saved document carries the fold')
// Put the store back to open first, so the re-read below has to change the row:
// what comes back is the document that was saved, and only that.
surface.sidebar.mutate((live) => Object.assign({}, live, {
  view: Object.assign({}, live.view, {
    expanded: Object.assign({}, surface.sidebar.expanded(live), { 'w-work': true }),
  }),
}))
assert.equal(sessionsUnder(await settle(region), 'w-work').length, 1, 'the setup reopens the row in memory')
const foldReloadCalls = calls.length
FIXTURES['homepage/sidebarLayout'] = { layout: foldedDocument, at: Date.now() }
await surface.sidebar.load(true)
const foldReloaded = await settle(region)
assert.equal(
  sessionsUnder(foldReloaded, 'w-work').length,
  0,
  'the re-read document decides: the fold survived the reload',
)
assert.equal(
  sbNodes(rowNamed(foldReloaded, 'app'), 'projectToggle')[0].props['aria-expanded'],
  false,
  'and the caret reports the fold it read back',
)
await sleep(520)
assert.equal(
  calls.slice(foldReloadCalls)
    .filter((call) => call.endpoint === 'homepage/saveSidebarLayout')
    .filter((call) => surface.sidebar.expandedOf(call.payload.args.layout, 'w-work') === true).length,
  0,
  'nothing reopened the row after the read',
)

// The list opens the project holding the current Session by itself — but only
// while the document has no answer for that row. The moment the reader closes it,
// the stored `false` IS the answer, and the autofocus has to leave it alone: read
// as "no opinion yet", that stored false is overwritten with `true` and the row
// reopens behind the reader. The re-read below is the moment the autofocus gets
// its chance, so this is where hasOwnProperty semantics become visible.
assert.equal(
  sessionsUnder(await settle(region), 'w-lab').length,
  3,
  'the project holding the current session is open to begin with',
)
sbNodes(rowNamed(await settle(region), 'demo'), 'projectToggle')[0].props.onClick({ stopPropagation() {} })
const holderFoldedTree = await settle(region)
assert.equal(
  sessionsUnder(holderFoldedTree, 'w-lab').length,
  0,
  'the reader can fold even the project holding the current session',
)
assert.equal(
  surface.sidebar.expandedOf(surface.sidebar.snapshot().layout, 'w-lab'),
  false,
  'and the document stores that answer',
)
await sleep(520)
const holderSaves = calls.filter((call) => call.endpoint === 'homepage/saveSidebarLayout')
const holderDocument = holderSaves[holderSaves.length - 1].payload.args.layout
assert.equal(surface.sidebar.expandedOf(holderDocument, 'w-lab'), false, 'the saved document keeps the closed row closed')
// Open it in the store first, so only the stored false can keep it shut.
surface.sidebar.mutate((live) => Object.assign({}, live, {
  view: Object.assign({}, live.view, {
    expanded: Object.assign({}, surface.sidebar.expanded(live), { 'w-lab': true }),
  }),
}))
assert.equal(sessionsUnder(await settle(region), 'w-lab').length, 3, 'the setup opens it in memory first')
const holderReloadCalls = calls.length
FIXTURES['homepage/sidebarLayout'] = { layout: holderDocument, at: Date.now() }
await surface.sidebar.load(true)
const holderReloadedTree = await settle(region)
assert.equal(
  sessionsUnder(holderReloadedTree, 'w-lab').length,
  0,
  'the autofocus does not reopen the row the reader closed, even while a current session lives in it',
)
assert.equal(
  sbNodes(rowNamed(holderReloadedTree, 'demo'), 'projectToggle')[0].props['aria-expanded'],
  false,
  'the caret reports the reader\'s fold, not the session inside it',
)
assert.equal(
  Object.prototype.hasOwnProperty.call(surface.sidebar.expanded(surface.sidebar.snapshot().layout), 'w-lab'),
  true,
  'because the answer on the row is the stored false, not a missing entry',
)
assert.equal(
  surface.sidebar.expandedOf(surface.sidebar.snapshot().layout, 'w-lab'),
  false,
  'which still reads as closed',
)
await sleep(520)
assert.equal(
  calls.slice(holderReloadCalls)
    .filter((call) => call.endpoint === 'homepage/saveSidebarLayout')
    .filter((call) => surface.sidebar.expandedOf(call.payload.args.layout, 'w-lab') === true).length,
  0,
  'and nothing wrote the row back open behind the reader',
)

// A Draft belongs to the one workspace the shell made it for. Drawn in another
// one it would read as a session that workspace never held, and its `updatedAt` —
// the moment the Draft was made — would pass as activity there. The projection
// hands the region every workspace's rows, so this rule lives here.
const DRAFT_ELSEWHERE_AT = SESSION_BASE + 5000
const draftElsewhere = Object.assign({}, WORKSPACE_SNAPSHOT, {
  items: WORKSPACE_SNAPSHOT.items.map((item) => (item.workspaceId === 'w-work'
    ? Object.assign({}, item, { sessionIds: ['s-3', 's-draft'] })
    : item)),
})
const sessionsElsewhere = Object.assign({}, SESSION_LIST, {
  byId: Object.assign({}, SESSION_LIST.byId, {
    's-draft': { blank: true, updatedAt: DRAFT_ELSEWHERE_AT },
  }),
})
// Both projects open, so the tree itself answers what is drawn under each.
surface.sidebar.mutate((live) => Object.assign({}, live, {
  view: Object.assign({}, live.view, {
    expanded: Object.assign({}, surface.sidebar.expanded(live), { 'w-lab': true, 'w-work': true }),
  }),
}))
await feedReporter({
  useWorkspaces: (select) => select(draftElsewhere),
  useSessions: (select) => select(sessionsElsewhere),
})
const elsewhereTree = await settle(region)
assert.equal(
  sessionRowById(elsewhereTree, 's-draft'),
  undefined,
  'a blank row the main view does not hold is not drawn, whichever workspace reported it',
)
assert.deepEqual(
  sessionsUnder(elsewhereTree, 'w-work').map((node) => node.props['data-id']),
  ['s-3'],
  'and the project it was reported under draws only the session it really has',
)
assert.ok(sessionRowById(elsewhereTree, 's-2'), 'while the Draft the main view does hold is still drawn')
const elsewhereWork = projectByWs(elsewhereTree, 'w-work')
assert.equal(sbNodes(elsewhereWork, 'projectToggle').length, 1, 'the project still has a row to unfold, so it keeps its caret')
assert.ok(
  text(elsewhereWork).includes(t('sidebar.list.count', { count: 1 })),
  'a project counts the rows it draws, so the hidden Draft cannot pass as a second, got: ' + text(elsewhereWork),
)
// The heading sums its projects, so the hidden row must not reappear there either.
assert.ok(
  text(sectionByKey(elsewhereTree, 'work')).includes(t('sidebar.list.count', { count: 1 })),
  'and the group heading counts the same one',
)
assert.ok(
  !text(sectionByKey(elsewhereTree, 'work')).includes(t('sidebar.list.count', { count: 2 })),
  'which is one session, not two, got: ' + text(sectionByKey(elsewhereTree, 'work')),
)

// The current Draft is the row the reader is about to type into, so the shipped
// browser hoists it above the pinned rows instead of ranking it among them:
// nothing outranks the row work is starting in. The fixture pins a session in the
// same project on purpose, so a ranking that ignored the blank flag would put that
// pinned row first and the Draft nowhere near the top.
const pinnedSnapshot = Object.assign({}, WORKSPACE_SNAPSHOT, { pinnedSessionIds: ['s-5'] })
surface.sidebar.mutate((live) => Object.assign({}, live, {
  view: Object.assign({}, live.view, {
    expanded: Object.assign({}, surface.sidebar.expanded(live), { 'w-lab': true }),
  }),
}))
await feedReporter({
  useWorkspaces: (select) => select(pinnedSnapshot),
  useSessions: (select) => select(SESSION_LIST),
})
const pinnedTree = await settle(region)
const pinnedOrder = sessionsUnder(pinnedTree, 'w-lab').map((node) => node.props['data-id'])
assert.deepEqual(
  pinnedOrder,
  ['s-2', 's-5', 's-1'],
  'the current Draft leads its project, above the pinned row, got: ' + pinnedOrder.join(', '),
)
assert.equal(
  byClass(sessionRowById(pinnedTree, 's-5'), 'ph-sb-pin').length,
  1,
  'the pinned row is the one the setup pinned, so the order above is not an accident',
)
assert.equal(
  byClass(sessionRowById(pinnedTree, 's-2'), 'ph-sb-pin').length,
  0,
  'and the Draft is not pinned — it leads by being the row the reader holds',
)

// A group the document orders by recency ranks projects by their last SENT
// session. A Draft is not an event: it was never sent, so its `updatedAt` says
// only when it was made, and letting that count would put a project the reader
// merely opened above a project with real, older activity. The two timestamps
// below are built so the buggy reading and the shipped one give opposite orders.
const DRAFT_RECENT_AT = SESSION_BASE + 1000
const SENT_RECENT_AT = SESSION_BASE - 7200000
const recentSnapshot = Object.assign({}, WORKSPACE_SNAPSHOT, {
  items: WORKSPACE_SNAPSHOT.items.map((item) => {
    if (item.workspaceId === 'w-lab') return Object.assign({}, item, { sessionIds: ['s-2'] })
    if (item.workspaceId === 'w-notes') return Object.assign({}, item, { sessionIds: ['s-4'] })
    return item
  }),
})
const recentSessions = Object.assign({}, SESSION_LIST, {
  byId: Object.assign({}, SESSION_LIST.byId, {
    's-2': Object.assign({}, SESSION_LIST.byId['s-2'], { updatedAt: DRAFT_RECENT_AT }),
    's-4': Object.assign({}, SESSION_LIST.byId['s-4'], { updatedAt: SENT_RECENT_AT }),
  }),
})
// w-notes joins 实验室 for this block, and the document orders that group by
// recency — the same patch the rest of the file uses for a 'recent' group.
surface.sidebar.mutate((live) => Object.assign({}, live, {
  members: Object.assign({}, live.members, {
    'w-notes': { group: 'lab', order: 9, color: null, hidden: false, alias: null, pinned: false },
  }),
  groups: surface.sidebar.groups(live).map((group) => (group.id === 'lab' ? Object.assign({}, group, { sort: 'recent' }) : group)),
  view: Object.assign({}, live.view, {
    expanded: Object.assign({}, surface.sidebar.expanded(live), { 'w-lab': true, 'w-notes': true }),
  }),
}))
await feedReporter({
  useWorkspaces: (select) => select(recentSnapshot),
  useSessions: (select) => select(recentSessions),
})
const recentTree = await settle(region)
const labOrder = sbNodes(sectionByKey(recentTree, 'lab'), 'project').map((node) => node.props['data-ws'])
// w-gone is a member the fixture knows but the projection reports no sessions
// for, so it has no last-sent session at all and trails both real projects.
assert.deepEqual(
  labOrder,
  ['w-notes', 'w-lab', 'w-gone'],
  'a group ordered by recency ranks a project by its last sent session, so a Draft cannot make its project recent, got: ' + labOrder.join(', '),
)
assert.ok(
  DRAFT_RECENT_AT > SENT_RECENT_AT,
  'the guard: the Draft is the newer of the two rows, so counting it would put its project first',
)
assert.deepEqual(
  sessionsUnder(recentTree, 'w-lab').map((node) => node.props['data-id']),
  ['s-2'],
  'the Draft is the only row its project has',
)
assert.deepEqual(
  sessionsUnder(recentTree, 'w-notes').map((node) => node.props['data-id']),
  ['s-4'],
  'and the other project\'s only row is an older, sent session',
)

// ------------------------------------------------------------------ watermark
//
// The shipped browser never prints a whole Workspace: an open project draws
// five Sessions, Show more adds five, and a remainder of five or fewer is
// revealed in one click before the control turns into Collapse. A subagent and
// an Agent Teams member are never rows at all — they are children of the
// Session that started them — so the two can never fill this list. The
// three-row fixture above cannot reach either rule, hence the one below.

const MANY_SENT_IDS = Array.from({ length: 13 }, (_, index) => 'm-' + (index + 1))
const manySnapshot = {
  items: [{
    workspaceId: 'w-many',
    path: 'D:\\Many\\deep',
    title: 'deep',
    // One subagent is a registered member of the Workspace and one is only
    // reachable by the cwd fallback, so both projection paths are exercised.
    sessionIds: ['m-draft', ...MANY_SENT_IDS, 'm-sub-member'],
    createdAt: 1,
    updatedAt: 1,
  }],
  archivedSessionIds: [],
  pinnedSessionIds: [],
  state: 'idle',
  phase: 'ready',
  error: null,
}
const manySentRows = {}
for (const [index, id] of MANY_SENT_IDS.entries()) {
  manySentRows[id] = { title: 'deep ' + (index + 1), updatedAt: SESSION_BASE - index * 60000 }
}
const manySessions = {
  ids: ['m-draft', ...MANY_SENT_IDS, 'm-sub-member', 'm-sub-stray', 'm-stray'],
  byId: Object.assign({}, manySentRows, {
    // The Draft is the row the main view holds, so it is drawn — and, as in the
    // shipped list, it spends none of the five slots.
    'm-draft': { blank: true, retainedBy: { mainView: 1 }, updatedAt: SESSION_BASE + 5000 },
    'm-sub-member': { title: 'subagent member', origin: 'subagent', updatedAt: SESSION_BASE - 5400000 },
    'm-sub-stray': {
      title: 'subagent stray', origin: 'subagent', cwd: 'D:\\Many\\deep', updatedAt: SESSION_BASE - 5460000,
    },
    // An ordinary Session the registry has not assigned yet: the cwd fallback
    // must still file it under the Workspace, or a Session started a moment ago
    // would wait for the registry to catch up.
    'm-stray': { title: 'stray ordinary', cwd: 'D:\\Many\\deep', updatedAt: SESSION_BASE - 5520000 },
  }),
}
surface.sidebar.mutate((live) => Object.assign({}, live, {
  view: Object.assign({}, live.view, {
    expanded: Object.assign({}, surface.sidebar.expanded(live), { 'w-many': true }),
  }),
}))
await feedReporter({
  useWorkspaces: (select) => select(manySnapshot),
  useSessions: (select) => select(manySessions),
})
let manyTree = await settle(region)
const manyProject = surface.sidebar.snapshot().workspaces.find((project) => project.id === 'w-many')
assert.ok(manyProject, 'the fixture project must reach the projection')
assert.deepEqual(
  manyProject.rows.map((row) => row.id),
  ['m-draft', ...MANY_SENT_IDS, 'm-stray'],
  'the projection drops both subagent Sessions, keeps every ordinary one and files the cwd fallback under the Workspace',
)
assert.deepEqual(
  sessionsUnder(manyTree, 'w-many').map((node) => node.props['data-id']),
  ['m-draft', 'm-1', 'm-2', 'm-3', 'm-4', 'm-5'],
  'an open project prints five Sessions plus the Draft, in the shipped order',
)
assert.equal(sessionRowById(manyTree, 'm-sub-member'), undefined, 'a registered subagent is not a sidebar row')
assert.equal(sessionRowById(manyTree, 'm-sub-stray'), undefined, 'and neither is the one the cwd fallback found')
assert.equal(sbNodes(manyTree, 'session').length, 6, 'no other Session row sneaks into the list')
assert.ok(
  text(projectByWs(manyTree, 'w-many')).includes(t('sidebar.list.count', { count: 15 })),
  'the project still counts every row it holds, drawn or not, got: ' + text(projectByWs(manyTree, 'w-many')),
)
assert.equal(byClass(manyTree, 'ph-sb-overflow').length, 1, 'a project past five rows carries the shipped Show more control')
assert.equal(sbNodes(manyTree, 'overflow')[0].props['aria-expanded'], false, 'the control reports the folded remainder')
assert.ok(
  text(sbNodes(manyTree, 'overflow')[0]).includes(t('sidebar.list.expand', { count: 9 })),
  'it names the rows the watermark left out, got: ' + text(sbNodes(manyTree, 'overflow')[0]),
)

const pressOverflow = (tree) => sbNodes(tree, 'overflow')[0].props.onClick({ stopPropagation() {} })
pressOverflow(manyTree)
manyTree = await settle(region)
assert.equal(sessionsUnder(manyTree, 'w-many').length, 11, 'Show more adds five, not the whole tree')
assert.ok(
  text(sbNodes(manyTree, 'overflow')[0]).includes(t('sidebar.list.expand', { count: 4 })),
  'and the control recounts what is still hidden, got: ' + text(sbNodes(manyTree, 'overflow')[0]),
)
pressOverflow(manyTree)
manyTree = await settle(region)
assert.equal(sessionsUnder(manyTree, 'w-many').length, 15, 'a remainder of five or fewer is revealed in one click')
assert.ok(sessionRowById(manyTree, 'm-stray'), 'so the ordinary cwd-fallback row is drawn too')
assert.equal(sbNodes(manyTree, 'overflow')[0].props['aria-expanded'], true, 'the control reports the unfolded tree')
assert.ok(
  text(sbNodes(manyTree, 'overflow')[0]).includes(t('sidebar.list.collapse')),
  'and turns into Collapse, got: ' + text(sbNodes(manyTree, 'overflow')[0]),
)

// A group fold drops the watermarks of every project inside it, exactly as the
// shipped browser drops the watermarks inside the group it collapses.
surface.sidebar.mutate((live) => Object.assign({}, live, {
  members: Object.assign({}, live.members, {
    'w-many': { group: 'lab', order: 9, color: null, hidden: false, alias: null, pinned: false },
  }),
}))
manyTree = await settle(region)
sbNodes(sectionByKey(manyTree, 'lab'), 'groupToggle')[0].props.onClick({ stopPropagation() {} })
const foldedGroup = await settle(region)
assert.equal(sessionsUnder(foldedGroup, 'w-many').length, 0, 'folding the group hides its projects')
sbNodes(sectionByKey(foldedGroup, 'lab'), 'groupToggle')[0].props.onClick({ stopPropagation() {} })
manyTree = await settle(region)
assert.equal(sessionsUnder(manyTree, 'w-many').length, 6, 'unfolding the group starts its projects at five again')

// The watermark is region state, not a property of the document: folding the
// project forgets it too, so reopening cannot leave a project permanently
// expanded.
pressOverflow(manyTree)
manyTree = await settle(region)
pressOverflow(manyTree)
manyTree = await settle(region)
assert.equal(sessionsUnder(manyTree, 'w-many').length, 15, 'the two clicks reveal the whole project')
sbNodes(projectByWs(manyTree, 'w-many'), 'projectToggle')[0].props.onClick({ stopPropagation() {} })
let foldedMany = await settle(region)
assert.equal(sessionsUnder(foldedMany, 'w-many').length, 0, 'the caret still folds the project')
sbNodes(projectByWs(foldedMany, 'w-many'), 'projectToggle')[0].props.onClick({ stopPropagation() {} })
manyTree = await settle(region)
assert.equal(sessionsUnder(manyTree, 'w-many').length, 6, 'reopening starts at five again, not where Show more left it')
assert.ok(
  text(sbNodes(manyTree, 'overflow')[0]).includes(t('sidebar.list.expand', { count: 9 })),
  'and the control is back to the full remainder',
)

// Collapse reveals the other half of the contract: once everything is drawn the
// same control folds the project back to five.
pressOverflow(manyTree)
manyTree = await settle(region)
pressOverflow(manyTree)
manyTree = await settle(region)
assert.equal(sessionsUnder(manyTree, 'w-many').length, 15, 'the two clicks reveal the whole project')
pressOverflow(manyTree)
manyTree = await settle(region)
assert.equal(sessionsUnder(manyTree, 'w-many').length, 6, 'Collapse puts the project back to five')
assert.equal(sbNodes(manyTree, 'overflow')[0].props['aria-expanded'], false, 'and reports itself folded again')

// A row the reader must not lose raises the watermark on its own: a running
// Session past the fifth stay drawn, as it does in the shipped browser.
const runningRows = Object.assign({}, manySessions.byId, {
  'm-9': Object.assign({}, manySessions.byId['m-9'], { running: true }),
})
await feedReporter({
  useWorkspaces: (select) => select(manySnapshot),
  useSessions: (select) => select(Object.assign({}, manySessions, { byId: runningRows })),
})
manyTree = await settle(region)
assert.equal(
  sessionsUnder(manyTree, 'w-many').length,
  10,
  'a running row past five raises the watermark so it stays drawn',
)
assert.ok(sessionRowById(manyTree, 'm-9'), 'the ninth row is the running one, so the raise is not a coincidence')

// The other attention classes raise it too: an approval waiting for the
// reader, an unread completion, and a running child (whose own row is hidden,
// so the parent is the only place that activity could show).
const attentionRow = (patch) => new Map([
  ['m-9', Object.assign({ running: false, pendingInteraction: undefined, completionUnread: false }, patch)],
])
await feedReporter({
  useWorkspaces: (select) => select(manySnapshot),
  useSessions: (select) => select(manySessions),
  useSessionStatus: (select) => select(attentionRow({
    pendingInteraction: { key: 'ask', kind: 'approval', sessionId: 'm-9' },
  })),
})
manyTree = await settle(region)
assert.equal(sessionsUnder(manyTree, 'w-many').length, 10, 'a pending approval past five raises the watermark')
assert.ok(sessionRowById(manyTree, 'm-9'), 'the row waiting for the reader is drawn')

await feedReporter({
  useWorkspaces: (select) => select(manySnapshot),
  useSessions: (select) => select(manySessions),
  useSessionStatus: (select) => select(attentionRow({ completionUnread: true })),
})
manyTree = await settle(region)
assert.equal(sessionsUnder(manyTree, 'w-many').length, 10, 'an unread completion past five raises the watermark')
assert.ok(sessionRowById(manyTree, 'm-9'), 'and its row is drawn')

const childSessions = Object.assign({}, manySessions, {
  byId: Object.assign({}, manySessions.byId, {
    'm-child': { title: 'teammate', origin: 'subagent', running: true, updatedAt: SESSION_BASE },
  }),
  projectionsBySession: { 'm-9': { values: { subagentCatalog: [{ id: 'm-child', label: 'teammate' }] } } },
})
await feedReporter({
  useWorkspaces: (select) => select(manySnapshot),
  useSessions: (select) => select(childSessions),
})
manyTree = await settle(region)
assert.equal(sessionsUnder(manyTree, 'w-many').length, 10, 'a running child past five raises its parent into view')
assert.equal(sessionRowById(manyTree, 'm-child'), undefined, 'while the child itself is never a row')

// A baseline that already reaches the last row draws no control: there is
// nothing left to reveal, and pressing Collapse could not fold anything.
const nineSnapshot = Object.assign({}, manySnapshot, {
  items: [Object.assign({}, manySnapshot.items[0], {
    sessionIds: ['m-draft', ...MANY_SENT_IDS.slice(0, 9)],
  })],
})
await feedReporter({
  useWorkspaces: (select) => select(nineSnapshot),
  useSessions: (select) => select(Object.assign({}, manySessions, {
    // The ordinary cwd fallback would be a tenth row here; this case is about
    // the baseline itself, so the fixture leaves it out of the list.
    ids: ['m-draft', ...MANY_SENT_IDS.slice(0, 9)],
    byId: runningRows,
  })),
})
manyTree = await settle(region)
assert.equal(sessionsUnder(manyTree, 'w-many').length, 10, 'the raised baseline draws nine Sessions plus the Draft')
assert.equal(sbNodes(manyTree, 'overflow').length, 0, 'and no control, because the baseline already reaches the last row')

// The current Session is the other row that raises it: the reader's own row is
// never hidden behind Show more.
const currentRows = Object.assign({}, manySessions.byId, {
  'm-draft': { blank: true, updatedAt: SESSION_BASE + 5000 },
  'm-9': Object.assign({}, manySessions.byId['m-9'], { retainedBy: { mainView: 1 } }),
})
await feedReporter({
  useWorkspaces: (select) => select(manySnapshot),
  useSessions: (select) => select(Object.assign({}, manySessions, { byId: currentRows })),
})
manyTree = await settle(region)
assert.equal(
  sessionsUnder(manyTree, 'w-many').length,
  9,
  'the current Session is drawn even when it sits past the fifth',
)
assert.ok(sessionRowById(manyTree, 'm-9'), 'and it is the row the main view now holds')
assert.equal(sessionRowById(manyTree, 'm-draft'), undefined, 'while the Draft it left behind is not drawn at all')

// A content search reaches Sessions directly, not through the project rows, so
// the origin filter has to hold there too: the host returns the subagent hit,
// and the list drops it instead of drawing a row nobody opened.
sbNodes(manyTree, 'searchInput')[0].props.onChange({ target: { value: '子智能体' } })
await sleep(260)
manyTree = await settle(region)
assert.equal(sbNodes(manyTree, 'result').length, 0, 'a content hit on a subagent Session is not drawn')
assert.equal(sbNodes(manyTree, 'noMatch').length, 1, 'the filtered hit leaves the same empty state as no hit at all')
sbNodes(manyTree, 'clearSearch')[0].props.onClick({})
manyTree = await settle(region)
assert.equal(sbNodes(manyTree, 'result').length, 0, 'clearing the field takes the hit rows away')
assert.ok(sbNodes(manyTree, 'project').length > 0, 'and the grouped tree comes back')

// Leave the document and the projection the way this section found them: the
// blocks after it read both.
surface.sidebar.mutate(() => docBeforeBlankBlocks)
FIXTURES['homepage/sidebarLayout'] = SIDEBAR_LAYOUT_FIXTURE
await feedReporter({
  useWorkspaces: (select) => select(WORKSPACE_SNAPSHOT),
  useSessions: (select) => select(SESSION_LIST),
})
await settle(region)
await sleep(520)


// ------------------------------------------------------------------- texture

// The shipped wall is where the watermark contract is checked, because the
// harness overrides the token card later in this file and an override is a whole
// new definition: it carries no texture of its own.
const SHIPPED_IDS = ['token', 'sessions', 'projects', 'network', 'plugin-audit', 'device', 'hygiene', 'tool-usage', 'dsh', 'sidebar-groups', 'skill']
for (const id of SHIPPED_IDS) {
  const cell = byClass(tree, 'ph-cell').find((node) => node.props['data-card-cell'] === id)
  const layers = byClass(cell, 'ph-tex')
  assert.equal(layers.length, 1, `the ${id} card must print exactly one texture`)
  const layer = layers[0]
  assert.equal(layer.props['aria-hidden'], 'true', `the ${id} texture is decoration, not content`)
  assert.ok(hasClass(layer, 'ph-tex--right'), `the ${id} texture is anchored right by default`)
  assert.equal(layer.props.style['--ph-tex-opacity'], '0.05', `the ${id} texture is a five percent mark`)
  assert.ok(
    /^#[0-9a-f]{6}$/i.test(String(layer.props.style['--ph-tex-tint'])),
    `the ${id} texture takes the card accent as its tint`,
  )
  const marks = byClass(layer, 'ph-tex-mark')
  assert.equal(marks.length, 1, `the ${id} texture is one mark`)
  assert.ok(
    elements(marks[0]).some((node) => node.tag === 'svg'),
    `the ${id} watermark must be the card's own icon, not a stray glyph`,
  )
  const html = serialize(cell)
  assert.ok(
    html.indexOf('ph-glass') < html.indexOf('ph-tex '),
    `the ${id} texture must be painted after the glass, whose backdrop-filter would blur it`,
  )
  assert.ok(html.indexOf('ph-tex ') < html.indexOf('ph-head'), `the ${id} texture must stay under the type`)
}
assert.equal(byClass(tree, 'ph-cell').length, SHIPPED_IDS.length, 'the shipped wall is pristine here')

// Notifications are annunciators, not a log: a card raises one only while the
// user has a reason to act. The calendar has nothing to say, the token card's
// fixture balance sits below the threshold, so it warns.
const snapshot = api.snapshot()
assert.ok(!snapshot.notifications.calendar, 'the calendar must not announce a routine date')
assert.ok(Array.isArray(snapshot.notifications.token) && snapshot.notifications.token.length > 0, 'the token card must raise a notice')
assert.equal(snapshot.notifications.token.length, 1, 'a card announces one live notice, not a stream')
assert.ok(snapshot.notifications.token.some((entry) => entry.level === 'warn'), 'a balance below the low-balance threshold must warn')

const bubbles = byClass(tree, 'ph-bubble')
const notified = Object.keys(snapshot.notifications).filter((id) => snapshot.notifications[id].length > 0)
assert.equal(notified.join(','), 'token', 'only the card with something to say carries a bubble')
assert.equal(bubbles.length, notified.length, 'exactly one bubble per card that has a notice')
const bubbleLevels = bubbles.map((bubble) => (/ph-bubble--(\w+)/.exec(String(bubble.props.className)) || [])[1])
assert.ok(bubbleLevels.every((level) => ['info', 'warn', 'error'].includes(level)), 'a bubble must carry its level class, got: ' + bubbleLevels.join(','))
assert.ok(bubbleLevels.includes('warn'), 'the low balance must show as a warn bubble')
const bubbleColors = bubbles.map((bubble) => bubble.props.style['--ph-notice'])
assert.ok(bubbleColors.every((color) => typeof color === 'string' && color.length > 0), 'a bubble must colour itself by level')
assert.equal(new Set(bubbleColors).size, new Set(bubbleLevels).size, 'info, warn and error must use distinct colours')

// ---------------------------------------------------------------------- hover

const tokenShell = byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'token').props.children
assert.ok(tokenShell, 'a cell must contain its shell')
const shellNode = elements(tree).find((node) => hasClass(node, 'ph-shell') && node.props.onPointerEnter)
assert.ok(shellNode, 'the shell must carry the hover handler')

shellNode.props.onPointerEnter(pointer('pointerenter'))
tree = await settle(main.render, { t })
assert.equal(api.snapshot().hovered, 'token', 'a mouse hover must be recorded')
const hoveredCell = byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'token')
assert.ok(hasClass(hoveredCell, 'is-hovered'), 'the hovered cell must be marked')

const hoverShell = elements(hoveredCell).find((node) => hasClass(node, 'ph-shell'))
assert.ok(hoverShell.props.style.transform, 'a mouse hover must grow the card in place')
assert.equal(
  hoverShell.props.style.inset,
  undefined,
  'hover growth must not use inset: the shell is in flow, where inset moves a box instead of resizing it',
)
// The hover look is what the art review keeps landing on, so it gets its own
// frame: a hovered card must add a lift and (at most) a soft pointer pool, and
// must NOT acquire a sheen band — a band of light is a gradient.
assert.equal(byClass(hoveredCell, 'ph-sheen').length, 0, 'a hovered card must not acquire the sheen band')
dumpPreview(tree, '06-hover-token')

hoverShell.props.onPointerLeave(pointer('pointerleave'))
tree = await settle(main.render, { t })
assert.equal(api.snapshot().hovered, null, 'leaving must clear the hover')

// A touch pointer must not trigger hover growth.
shellNode.props.onPointerEnter(pointer('pointerenter', { pointerType: 'touch' }))
tree = await settle(main.render, { t })
assert.equal(api.snapshot().hovered, null, 'touch must not trigger the hover state')

// A spotlight card tracks the pointer by writing CSS variables on the element,
// never by re-rendering — and it measures the card once per hover.
const spotlightShell = byClass(tree, 'ph-fx-spotlight')[0]
assert.ok(spotlightShell, 'the token card declares the spotlight effect')
const written = {}
const fakeShell = {
  style: { setProperty: (name, value) => { written[name] = value } },
  getBoundingClientRect: () => ({ left: 100, top: 50 }),
  __phRect: null,
}
spotlightShell.props.onPointerEnter(Object.assign(pointer('pointerenter'), { currentTarget: fakeShell }))
assert.deepEqual(fakeShell.__phRect, { left: 100, top: 50 }, 'the spotlight must measure the card on enter')
spotlightShell.props.onPointerMove(Object.assign(pointer('pointermove'), { currentTarget: fakeShell, clientX: 140, clientY: 90 }))
assert.equal(written['--ph-mx'], '40px', 'the spotlight must track the pointer on the x axis')
assert.equal(written['--ph-my'], '40px', 'the spotlight must track the pointer on the y axis')
spotlightShell.props.onPointerLeave(Object.assign(pointer('pointerleave'), { currentTarget: fakeShell }))
assert.equal(fakeShell.__phRect, null, 'leaving must drop the cached measurement')

// ------------------------------------------------------------------- controls
// A shipped preview carries no controls, so the control contracts are exercised
// on the expanded card, which is where a card's settings live now.
api.open('token')
tree = await settle(main.render, { t })
let focusCard = byClass(tree, 'ph-focus-card')[0]
assert.ok(focusCard, 'opening a card must raise the focus pane')
assert.equal(byClass(focusCard, 'ph-focus-toolbar').length, 1, 'the expanded card must render its own toolbar')

const rangeButton = buttons(tree, '30')[0]
assert.ok(rangeButton, 'the expanded token card must render the 7/14/30 segmented control')
rangeButton.props.onClick()
tree = await settle(main.render, { t })
assert.equal(api.state().controls.token.days, 30, 'clicking a segment must store the control value')
assert.ok(calls.some((call) => call.endpoint === 'homepage/overview' && call.payload && call.payload.args && call.payload.args.options && call.payload.args.options.historyDays === 30), 'the overview must reload with the new range')

await sleep(420)
assert.ok(calls.some((call) => call.endpoint === 'homepage/saveState'), 'a control change must persist the state')

// Arrangement is a deliberate mode, not an unlabeled switch beside density.
assert.equal(focusCard.props.role, 'dialog')
assert.equal(focusCard.props['aria-modal'], true)
assert.equal(byClass(tree, 'ph-grid')[0].props.inert, '', 'the wall is inert behind detail')
assert.equal(byClass(focusCard, 'ph-focus-design').length, 1, 'appearance is tucked into a disclosure')
assert.equal(byClass(focusCard, 'ph-effect-pick').length, 0, 'detail actions are not mixed with design dropdowns')
api.close()
tree = await settle(main.render, { t })
const arrangeToggle = byClass(tree, 'ph-arrange-toggle')[0]
assert.equal(arrangeToggle.props['aria-pressed'], false)
arrangeToggle.props.onClick()
tree = await settle(main.render, { t })
assert.equal(api.state().settings.edit, true)
assert.equal(byClass(tree, 'ph-arrangement-bar').length, 1)
assert.equal(byClass(tree, 'ph-layout-controls').length, 11)
assert.equal(byClass(tree, 'ph-size-controls').length, 0, 'steppers no longer crowd card headers')
byClass(tree, 'ph-layout-design')[0].props.onClick()
tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-layout-inspector').length, 1)
assert.equal(byClass(tree, 'ph-motion-preset').length, Object.keys(api.effects).length)
const chooseMotion = name => byClass(tree, 'ph-motion-preset').find(node => node.props['data-effect'] === name)
chooseMotion('glow').props.onClick()
tree = await settle(main.render, { t })
assert.equal(api.state().effects.token.outline, 'glow')
byClass(tree, 'ph-motion-trigger')[0].props.children[1].props.onClick()
tree = await settle(main.render, { t })
assert.equal(api.state().effects.token.trigger, 'hover')
assert.ok(byClass(byClass(tree, 'ph-cell')[0], 'ph-motion-hover').length)
chooseMotion('none').props.onClick()
tree = await settle(main.render, { t })
assert.equal(api.state().effects.token.spotlight, false, 'none disables inherited spotlight')
assert.equal(api.state().effects.token.ripple, false, 'none disables inherited ripple')
const sizePreset = byClass(tree, 'ph-size-preset').find(node => String(node.props.title).endsWith('2 × 1'))
sizePreset.props.onClick()
tree = await settle(main.render, { t })
assert.equal(api.state().layout.token.w, 2)
assert.equal(api.state().layout.token.h, 1)
chooseMotion('outline').props.onClick()
tree = await settle(main.render, { t })
dumpPreview(tree, '20-arrange-design')
const orderBeforeNudge = byClass(tree, 'ph-cell').map(cell => cell.props['data-card-cell'])
byClass(byClass(tree, 'ph-cell')[0], 'ph-layout-nudge')[1].props.onClick()
tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-cell')[1].props['data-card-cell'], orderBeforeNudge[0], 'arrow moves a tile without dragging')
byClass(byClass(tree, 'ph-cell')[1], 'ph-layout-nudge')[0].props.onClick()
tree = await settle(main.render, { t })
// A canceled pointer drag restores order and releases every temporary listener.
const dragListeners = new Map()
const originalAddListener = window.addEventListener
const originalRemoveListener = window.removeEventListener
window.addEventListener = (type, handler) => dragListeners.set(type, handler)
window.removeEventListener = (type, handler) => { if (dragListeners.get(type) === handler) dragListeners.delete(type) }
document.body.classList = { add() {}, remove() {} }
const orderBeforeDrag = api.state().order.slice()
byClass(tree, 'ph-handle')[0].props.onPointerDown(pointer('pointerdown', { button: 0, pointerId: 1, clientX: 1, clientY: 1, currentTarget: {}, stopPropagation() {} }))
assert.ok(api.snapshot().drag, 'handle starts a reorder')
api.reorder('token', 'device')
assert.notDeepEqual(api.state().order, orderBeforeDrag)
dragListeners.get('keydown')({ key: 'Escape', preventDefault() {} })
assert.deepEqual(api.state().order, orderBeforeDrag, 'Escape rolls back the drag transaction')
assert.equal(api.snapshot().drag, null)
assert.equal(dragListeners.size, 0)
// The drag image follows the exact grab offset; move bursts share one frame.
const originalQueryAll = document.querySelectorAll
const originalRaf = window.requestAnimationFrame
const originalCancelRaf = window.cancelAnimationFrame
const frames = new Map()
let frameId = 0
window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId }
window.cancelAnimationFrame = id => frames.delete(id)
const flushFrame = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback()) }
const ghosts = []
const animations = []
const fakeCells = ['token', 'device'].map(id => ({
  style: {}, isConnected: true,
  getAttribute: () => id,
  getBoundingClientRect() { const left = api.state().order.indexOf(id) * 100; return { left, right: left + 90, top: 0, bottom: 90, width: 90, height: 90 } },
  closest: () => ({ appendChild(ghost) { ghosts.push(ghost) } }),
  cloneNode() { return { style: {}, attributes: {}, querySelectorAll: () => [], removeAttribute(name) { delete this.attributes[name] }, setAttribute(name, value) { this.attributes[name] = value }, remove() { this.removed = true } } },
  animate(keyframes, options) { const animation = { keyframes, options, cancel() { this.canceled = true } }; animations.push(animation); return animation },
}))
document.querySelectorAll = selector => selector === '[data-card-cell]' || selector === '.ph-cell' ? fakeCells : []
const startDrag = () => byClass(tree, 'ph-handle')[0].props.onPointerDown(pointer('pointerdown', { button: 0, pointerId: 1, clientX: 15, clientY: 12, currentTarget: {}, stopPropagation() {} }))
startDrag()
assert.equal(ghosts.length, 1, 'a DOM clone is lifted without rendering another card')
assert.equal(ghosts[0].attributes['aria-hidden'], 'true')
assert.equal(ghosts[0].attributes.inert, '')
dragListeners.get('pointermove')({ pointerId: 2, clientX: 500, clientY: 20 })
assert.equal(frames.size, 0, 'another touch cannot move this drag')
dragListeners.get('pointermove')({ pointerId: 1, clientX: 540, clientY: 20 })
dragListeners.get('pointermove')({ pointerId: 1, clientX: 550, clientY: 30 })
assert.equal(frames.size, 1, 'high-rate pointer events coalesce into one frame')
flushFrame()
assert.equal(ghosts[0].style.transform, 'translate3d(535px,18px,0)', 'the grabbed point stays under the pointer')
assert.notDeepEqual(api.state().order, orderBeforeDrag)
flushFrame()
assert.ok(animations.some(animation => animation.options.duration === 320), 'neighbours get a smooth FLIP reflow')
assert.equal(fakeCells[0].__phLayoutAnimation, null, 'the lifted source is not animated through the grid')
const orderAfterMove = api.state().order.slice()
dragListeners.get('pointermove')({ pointerId: 1, clientX: 550, clientY: 30 })
flushFrame()
assert.deepEqual(api.state().order, orderAfterMove, 'a stationary pointer does not oscillate between animated cards')
dragListeners.get('pointerup')({ pointerId: 2 })
assert.ok(api.snapshot().drag, 'an unrelated pointer cannot drop the card')
dragListeners.get('keydown')({ key: 'Escape', preventDefault() {} })
flushFrame()
assert.deepEqual(api.state().order, orderBeforeDrag)
assert.ok(ghosts[0].removed, 'cancellation removes the floating image')
assert.equal(api.state().settings.edit, true, 'canceling keeps arrangement mode active')
assert.equal(dragListeners.size, 0)
startDrag()
dragListeners.get('pointermove')({ pointerId: 1, clientX: 550, clientY: 30 })
dragListeners.get('pointerup')({ pointerId: 1, clientX: 550, clientY: 30 })
assert.equal(api.snapshot().drag, null)
assert.notDeepEqual(api.state().order, orderBeforeDrag, 'drop flushes the final pointer movement before saving')
assert.ok(ghosts[1].removed)
flushFrame()
assert.equal(dragListeners.size, 0)
api.snapshot().state.order = orderBeforeDrag
startDrag()
dragListeners.get('blur')({})
assert.equal(api.snapshot().drag, null, 'losing window focus cancels rather than stranding the drag')
flushFrame()
const scrollStage = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 100 }) }
byClass(tree, 'ph-handle')[0].props.onPointerDown(pointer('pointerdown', { button: 0, pointerId: 1, clientX: 15, clientY: 12, currentTarget: { closest: () => scrollStage }, stopPropagation() {} }))
dragListeners.get('pointermove')({ pointerId: 1, clientX: 550, clientY: 88 })
flushFrame()
assert.ok(scrollStage.scrollTop > 0, 'approaching the stage edge automatically scrolls')
dragListeners.get('pointercancel')({ pointerId: 1 })
const stoppedScroll = scrollStage.scrollTop
flushFrame()
assert.equal(scrollStage.scrollTop, stoppedScroll, 'cancel stops the auto-scroll frame loop')
assert.equal(dragListeners.size, 0)
// Real React hosts invert in the layout-effect phase, not one frame after paint.
React.useLayoutEffect = callback => callback()
api.reorder('token', 'device')
assert.equal(frames.size, 0, 'layout-effect hosts must not defer FLIP into a nested animation frame')
main.render({ t })
const interruptedAnimation = fakeCells[1].__phLayoutAnimation
assert.ok(interruptedAnimation)
api.reorder('token', 'device')
main.render({ t })
assert.ok(interruptedAnimation.canceled, 'a new reflow replaces the old animation instead of stacking transforms')
delete React.useLayoutEffect
api.snapshot().state.order = orderBeforeDrag
startDrag()
const landingGhost = ghosts.at(-1)
let landingAnimation
landingGhost.animate = () => (landingAnimation = {})
dragListeners.get('pointerup')({ pointerId: 1 })
assert.equal(fakeCells[0].style.visibility, 'hidden', 'the real tile stays hidden until the landing image arrives')
flushFrame()
assert.ok(landingAnimation)
landingAnimation.oncancel()
assert.equal(fakeCells[0].style.visibility, undefined, 'even interrupted landing restores the original visibility')
assert.ok(landingGhost.removed)
document.querySelectorAll = originalQueryAll
window.requestAnimationFrame = originalRaf
window.cancelAnimationFrame = originalCancelRaf
window.addEventListener = originalAddListener
window.removeEventListener = originalRemoveListener
delete document.body.classList
tree = await settle(main.render, { t })
byClass(tree, 'ph-arrange-toggle')[0].props.onClick()
tree = await settle(main.render, { t })
assert.equal(api.state().settings.edit, false)
assert.equal(byClass(tree, 'ph-layout-inspector').length, 0)
// Restore the registered effect defaults after exercising the design controls.
delete api.snapshot().state.effects.token
delete api.snapshot().state.layout.token
api.open('token')
tree = await settle(main.render, { t })

// A card-declared switch stores into that card's control section. The wall still
// renders the card's preview, so the control is looked up in the pane.
const paneNow = byClass(tree, 'ph-focus-card')[0]
const cardSwitch = elements(paneNow).find((node) => node.props && node.props.role === 'switch')
assert.ok(cardSwitch, 'the expanded token card must render a switch control')
assert.equal(cardSwitch.props['aria-checked'], false, 'the card switch starts off')
cardSwitch.props.onClick()
tree = await settle(main.render, { t })
assert.equal(api.state().controls.token.bonus, true, 'clicking the card switch must store true')

// A combo button: the caret opens the menu, the item runs the alternative.
const comboPane = byClass(tree, 'ph-focus-card')[0]
const caret = elements(comboPane).find((node) => hasClass(node, 'ph-combo-caret'))
assert.ok(caret, 'the token card must render a combo button')
caret.props.onClick()
tree = await settle(main.render, { t })
const forceItem = elements(tree).find((node) => hasClass(node, 'ph-combo-item') && textOf(node).trim() === t('common.force'))
assert.ok(forceItem, 'the combo menu must list its alternatives, got: ' + elements(tree).filter((node) => hasClass(node, 'ph-combo-item')).map((node) => textOf(node)).join('|'))
dumpPreview(tree, '03-combo-open')

// A recovered balance is not news: the warning is retracted rather than
// replaced by an "all good" entry.
OVERVIEW_FIXTURE.wallets[1].balance = '128.00'
OVERVIEW_FIXTURE.today.spend = '0.00'
forceItem.props.onClick()
tree = await settle(main.render, { t })
assert.equal(api.state().controls.token.refresh, 'force', 'choosing a combo item must store the selection')
const recovered = text(byClass(tree, 'ph-focus-card')[0])
assert.ok(recovered.includes('128.00'), 'a forced refresh must show the new balance, got: ' + recovered)
assert.ok(!api.snapshot().notifications.token, 'a recovered balance must retract the notice, not log a healthy one')
assert.equal(byClass(tree, 'ph-bubble').length, 0, 'the bubble must disappear once nothing needs the user')

// ------------------------------------------------------------------- density

assert.equal(buttons(tree, t('density.compact')).length, 0, 'density is removed from the main toolbar')
assert.ok(module_.STYLES.includes('.ph-density-compact') && module_.STYLES.includes('.ph-density-cozy'), 'old saved density remains supported')
assert.ok(module_.STYLES.includes('prefers-reduced-motion:reduce'), 'stronger motion still honors reduced motion')
assert.ok(module_.STYLES.includes('translate:0 -7px'), 'float animates the compositor, not layout margins')

// ------------------------------------------------------------------- expanding

api.open('token')
tree = await settle(main.render, { t })
const focus = byClass(tree, 'ph-focus-card')
assert.equal(focus.length, 1, 'the expanded card must become the focus pane')
assert.equal(byClass(tree, 'ph-focus-layer').length, 1, 'the pane must float in its own layer')
assert.equal(focus[0].props.style.width, '75%', 'the pane must take three quarters of the wall, not the whole page')
assert.equal(focus[0].props['data-card-focus'], 'token')
assert.equal(byClass(tree, 'ph-grid').length, 1, 'the wall must stay mounted behind the pane')
assert.equal(byClass(tree, 'ph-cell').length, 11, 'the wall must keep every card, the expanded one included')
assert.ok(hasClass(byClass(tree, 'ph-grid')[0], 'is-blurred'), 'the wall must go out of focus behind the pane')
assert.equal(byClass(tree, 'ph-cell--focus').length, 0, 'a card must never be lifted out of the grid any more')
assert.ok(byClass(tree, 'ph-detail-block').length >= 1, 'the expanded card must render its detail body')

api.close()
tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-focus-card').length, 0, 'closing must put the card back in the wall')
assert.equal(byClass(tree, 'ph-focus-layer').length, 0, 'closing must remove the pane layer')
assert.equal(byClass(tree, 'ph-grid').filter((g) => hasClass(g, 'is-blurred')).length, 0, 'closing must bring the wall back into focus')

// --- the expanded device card --------------------------------------------
// Every number below is the reading of the fixture, so this is also the test
// that the sampler's document and the card agree on units and rounding.
api.open('device')
tree = await settle(main.render, { t })
const devicePane = byClass(tree, 'ph-focus-card')[0]
assert.ok(devicePane, 'the device card must expand in place')
assert.equal(devicePane.props['data-card-focus'], 'device', 'the expanded pane must be the device card')
const deviceDetail = text(devicePane)
assert.equal(byClass(devicePane, 'ph-stat').length, 6, 'the detail leads with six readings, the GPU and its memory included')
assert.equal(byClass(devicePane, 'ph-bars').length, 3, 'the detail charts the processor, the memory and every core')
assert.equal(byClass(devicePane, 'ph-bar').length, 6 + 6 + 8, 'two six-sample series plus one bar per core')
assert.equal(byClass(devicePane, 'ph-axis').length, 1, 'the two time series share one time axis')
assert.equal(byClass(devicePane, 'ph-action').length, 4, 'the expanded device card must expose its four settings')
assert.equal(byClass(devicePane, 'ph-switch').length, 2, 'the unit and the per-core chart are switches')
assert.ok(deviceDetail.includes('AMD Ryzen 7 7840HS'), 'the detail must name the processor, got: ' + deviceDetail)
assert.ok(deviceDetail.includes('20 GB') && deviceDetail.includes('32 GB'), 'the detail must report used over total memory')
assert.ok(deviceDetail.includes('C:\\ · 60%'), 'the detail must report the volume and how full it is')
assert.ok(deviceDetail.includes('62 °C'), 'the detail must carry the temperature reading itself')
assert.ok(!deviceDetail.includes('来源：'), 'the detail must not explain which sensor the temperature came from')
assert.ok(deviceDetail.includes('NVIDIA GeForce RTX 5070'), 'the detail must name the adapter, got: ' + deviceDetail)
assert.ok(deviceDetail.includes('· 3D'), 'the GPU reading must name the engine it came from, got: ' + deviceDetail)
assert.ok(deviceDetail.includes('9.4 GB') && deviceDetail.includes('12 GB'), 'the detail must report the video memory')
assert.ok(deviceDetail.includes('DESKTOP-DEV'), 'the detail must name the machine')
assert.ok(deviceDetail.includes('5 秒'), 'the detail must show the configured sampling interval')
assert.ok(deviceDetail.includes('25s'), 'a window shorter than a minute must read in seconds, not 0m')
dumpPreview(tree, '07-expanded-device')

// --- the DSH card: what changed upstream, and where a core would land --------
// The card's whole point is the difference from what it last showed, so this
// block drives it through exactly that: expand (which adopts the baseline), let
// a newer release arrive, and require the card to call it news. The tag is what
// the installer clones; the name is what the user reads.
const DSH_NEWER = Object.assign({}, DSH_FIXTURE, {
  at: DSH_FIXTURE.at + 60000,
  head: Object.assign({}, DSH_FIXTURE.head, {
    sha: 'b7c1f0a9e2d34c5b6a708192a3b4c5d6e7f80912',
    short: 'b7c1f0a',
    message: 'Release dsh-v0.2.2-alpha.1',
    date: '2026-10-15T14:10:00Z',
  }),
  release: {
    tag: 'dsh-v0.2.2-alpha.1',
    name: 'v0.2.2-alpha.1',
    url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-alpha.1',
    publishedAt: '2026-10-15T14:12:00Z',
  },
})

api.open('dsh')
tree = await settle(main.render, { t })
const dshPane = byClass(tree, 'ph-focus-card')[0]
assert.equal(dshPane.props['data-card-focus'], 'dsh', 'the dsh card must expand')
let dshText = text(dshPane)
assert.ok(dshText.includes(t('dsh.state.current')), 'the newest core is on the upstream commit, got: ' + dshText)
// The card says what it is FOR before it says anything about the upstream: a
// machine that does not run a local build has to learn that from the card
// itself, not from a failure it cannot act on.
assert.ok(dshText.includes(t('dsh.purpose')), 'the expanded card must state its purpose, got: ' + dshText)
assert.equal(byClass(dshPane, 'ph-dsh-launch').length, 1, 'the purpose and the state share one panel')
assert.equal(byClass(dshPane, 'ph-dsh-reading').length, 2, 'the panel carries the two readings')
assert.ok(dshText.includes(DSH_FIXTURE.head.sha), 'the detail shows the full head sha')
assert.ok(dshText.includes(DSH_FIXTURE.head.message), 'the detail shows the commit message')
assert.ok(dshText.includes(DSH_FIXTURE.release.tag), 'the detail shows the tag the installer needs')
assert.ok(dshText.includes(DSH_FIXTURE.release.name), 'the detail shows the release name the user reads')
assert.ok(dshText.includes('master'), 'the detail names the branch')
assert.equal(byClass(dshPane, 'ph-tool').length, 3, 'every core under the root earns a row')
assert.equal(byClass(dshPane, 'ph-chip').length, 1 + 3 + 3, 'the verdict, a running marker, and a sync chip plus a build chip per local core')
assert.equal(byClass(dshPane, 'ph-input').length, 1, 'the install root is an editable field')
assert.ok(dshText.includes('5719020') && dshText.includes('dsh-v0.2.1-alpha.3'),
  'a core is identified by its commit and the tag it is on, got: ' + dshText)
assert.ok(dshText.includes(t('dsh.synced')), 'the core on the upstream commit must read as in sync')
assert.ok(dshText.includes(t('dsh.behind')), 'a core on an older commit must read as behind')
assert.ok(dshText.includes(t('dsh.noCommit')), 'a directory that is not a checkout must say so')
assert.ok(dshText.includes(t('dsh.notBuilt')), 'a checkout without its build must say so')
// The raw feed is a disclosure, not a wall of text: the panel leads, and the
// commit and release details follow only when they are asked for.
const dshReveal = byClass(dshPane, 'ph-dsh-reveal')[0]
assert.ok(dshReveal, 'the upstream details sit behind a disclosure')
assert.equal(dshReveal.props.hidden, true, 'the disclosure starts closed')
dumpPreview(tree, '09-expanded-dsh')
const dshMore = byClass(dshPane, 'ph-dsh-more')[0]
assert.ok(dshMore, 'the disclosure needs a control')
dshMore.props.onClick()
tree = await settle(main.render, { t })
assert.equal(byClass(byClass(tree, 'ph-focus-card')[0], 'ph-dsh-reveal')[0].props.hidden, false,
  'the disclosure opens on request')

FIXTURES['homepage/dsh'] = DSH_NEWER
FIXTURES['homepage/dshCheck'] = DSH_NEWER
const dshCaret = () => elements(byClass(tree, 'ph-focus-card')[0]).find((node) => hasClass(node, 'ph-combo-caret'))
const dshRefresh = () => elements(tree).find((node) => hasClass(node, 'ph-combo-item') && textOf(node).trim() === t('common.refresh'))
dshCaret().props.onClick()
tree = await settle(main.render, { t })
assert.ok(dshRefresh(), 'the dsh card must offer a manual refresh')
dshRefresh().props.onClick()
tree = await settle(main.render, { t })
const dshNewer = byClass(tree, 'ph-focus-card')[0]
assert.ok(text(dshNewer).includes(t('dsh.state.release')),
  'a release the card has not seen is the news it exists for, got: ' + text(dshNewer))
assert.ok(text(dshNewer).includes(DSH_NEWER.release.name),
  'the new release must be named where the user reads it, got: ' + text(dshNewer))
const dshWarnChips = byClass(dshNewer, 'ph-chip--warn').map((node) => textOf(node).trim())
assert.ok(dshWarnChips.some((text) => text.includes(t('dsh.state.release'))),
  'a new release must be flagged, not merely stated, got: ' + dshWarnChips.join(' | '))

// "Force" is not a second spelling of "refresh": the host memoises the document
// for five minutes, so the forced choice has to reach the revalidating endpoint.
const callsBeforeForce = calls.length
dshCaret().props.onClick()
tree = await settle(main.render, { t })
const dshForce = elements(tree).find((node) => hasClass(node, 'ph-combo-item') && textOf(node).trim() === t('dsh.force'))
assert.ok(dshForce, 'the refresh combo must offer a forced check, got: '
  + elements(tree).filter((node) => hasClass(node, 'ph-combo-item')).map((node) => textOf(node)).join(' | '))
dshForce.props.onClick()
tree = await settle(main.render, { t })
assert.ok(calls.slice(callsBeforeForce).some((entry) => entry.endpoint === 'homepage/dshCheck'),
  'the forced check must reach the endpoint that revalidates the feeds')

// The install clicks through to the host with the tag, not the name: a clone
// needs the tag after --branch, and a display name is not a ref.
const installButton = elements(dshNewer).find((node) => hasClass(node, 'ph-btn') && textOf(node).includes(DSH_NEWER.release.name))
assert.ok(installButton, 'a new release must offer its own update button, got: ' + text(dshNewer))
const callsBefore = calls.length
installButton.props.onClick()
tree = await settle(main.render, { t })
const installCall = calls.slice(callsBefore).find((entry) => entry.endpoint === 'homepage/dshInstall')
assert.ok(installCall, 'clicking update must reach the install endpoint')
assert.deepEqual(installCall.payload.args,
  { options: { root: 'D:\\tools\\DSH', version: 'v0.2.2-alpha.1', ref: 'dsh-v0.2.2-alpha.1' } },
  'the installer is handed the tag and the directory, and nothing else')
assert.ok(text(byClass(tree, 'ph-focus-card')[0]).includes(t('dsh.started', { version: DSH_NEWER.release.name })),
  'a started install must be reported, got: ' + text(byClass(tree, 'ph-focus-card')[0]))

// The install leaves a notice behind, and a later block counts bubbles, so it
// has to be cleared here rather than blamed on the device card.
api.clearNotifications('dsh')
FIXTURES['homepage/dsh'] = DSH_FIXTURE
FIXTURES['homepage/dshCheck'] = DSH_FIXTURE
tree = await settle(main.render, { t })

// --- the DSH card on a machine it was not written for ------------------------
// The reports that started this redesign came from users of the desktop app
// and of community wrappers: the card showed a red "cannot reach github" and
// no build to manage, and they read it as a broken plugin. On a packaged DSH
// there is nothing to update, so the card has to say so in its own voice —
// and must not dress that up as an error.
const DSH_PACKAGED_FIXTURE = {
  root: '',
  running: '',
  install: { kind: 'desktop', version: '0.2.1-alpha.4' },
  versions: [
    {
      version: '0.2.1-alpha.4', name: 'DeepSeek Harness (Desktop)', dir: null,
      sha: null, short: null, commitDate: null, branch: null, tag: 'dsh-v0.2.1-alpha.4',
      remote: null, shallow: false, isCore: true, exists: true, hasSource: false,
      hasDeps: false, hasBuild: true, complete: true, updatedAt: null, kind: 'desktop',
    },
  ],
}
FIXTURES['homepage/dshLocal'] = DSH_PACKAGED_FIXTURE
api.close()
api.open('dsh')
tree = await settle(main.render, { t })
// The fixture changed, and a card only re-reads when it is asked to: the
// refresh control fires every reloader the card published, the wall preview's
// included.
dshCaret().props.onClick()
tree = await settle(main.render, { t })
dshRefresh().props.onClick()
tree = await settle(main.render, { t })
// The wall is the surface a user meets first, and the one that was reported
// as broken: the compact reading of a machine the card is not about.
api.close()
tree = await settle(main.render, { t })
dumpPreview(tree, '01-wall-packaged')
const packagedCell = byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'dsh')
const packagedText = text(packagedCell)
const packagedChip = byClass(packagedCell, 'ph-chip')[0]
assert.ok(packagedChip, 'the preview still states one verdict')
assert.ok(!hasClass(packagedChip, 'ph-chip--error'), 'a packaged build is a state, not an error')
assert.ok(!hasClass(packagedChip, 'ph-chip--warn'), 'a packaged build is not a warning either')
assert.ok(packagedText.includes(t('dsh.state.packaged')), 'the preview must say the card does not apply here, got: ' + packagedText)
assert.ok(packagedText.includes(t('dsh.scope.hint')), 'the preview must say what the card is for, got: ' + packagedText)
assert.ok(!api.snapshot().notifications.dsh, 'a machine the card is not about raises no bubble')

api.open('dsh')
tree = await settle(main.render, { t })
const packagedPane = byClass(tree, 'ph-focus-card')[0]
const packagedDetail = text(packagedPane)
assert.ok(packagedDetail.includes(t('dsh.scope.packaged', { version: 'v0.2.1-alpha.4' })),
  'the expanded card must say this machine is not a local build, got: ' + packagedDetail)
assert.ok(packagedDetail.includes(t('dsh.purpose')), 'the expanded card must still state its purpose')
assert.ok(!packagedDetail.includes(t('dsh.state.current')), 'a packaged build must never claim to be up to date')
assert.equal(byClass(packagedPane, 'ph-tool').length, 0, 'a packaged build has no local build to manage')
// What the card does offer is labelled for what it is: a local build in a
// directory of the user's choosing, not an upgrade of the running app.
const packagedButton = elements(packagedPane).find((node) => hasClass(node, 'ph-btn') && textOf(node).includes(DSH_FIXTURE.release.name))
assert.ok(packagedButton, 'a packaged build can still be given a local build')
assert.notEqual(textOf(packagedButton), t('dsh.install', { version: DSH_FIXTURE.release.name }),
  'the action must not read as an upgrade of the running app, got: ' + textOf(packagedButton))
assert.ok(packagedDetail.includes(t('dsh.note.local')), 'the card must say the running version is left alone')
dumpPreview(tree, '09-expanded-dsh-packaged')

// A machine the host could not place at all gets its own sentence, and still
// no red: the card asks for a directory instead of claiming a fault.
FIXTURES['homepage/dshLocal'] = { root: '', running: '', install: { kind: 'unknown', version: null }, versions: [] }
dshCaret().props.onClick()
tree = await settle(main.render, { t })
dshRefresh().props.onClick()
tree = await settle(main.render, { t })
const unknownCell = byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'dsh')
const unknownText = text(unknownCell)
assert.ok(unknownText.includes(t('dsh.state.unknownInstall')), 'the card must say it found no local build, got: ' + unknownText)
assert.ok(!hasClass(byClass(unknownCell, 'ph-chip')[0], 'ph-chip--error'), 'an unidentified machine is not an error')
FIXTURES['homepage/dshLocal'] = DSH_LOCAL_FIXTURE
dshCaret().props.onClick()
tree = await settle(main.render, { t })
dshRefresh().props.onClick()
tree = await settle(main.render, { t })

// The next block drives the device card through the caret of whatever card is
// expanded, so the focus has to go back to the device before it runs.
api.open('device')
tree = await settle(main.render, { t })

// --- the skill card -------------------------------------------------------
// The wall reading is a count and a scale, not a list: how many skills this
// machine has, and how they divide between the ones the model can load, the
// ones only `/name` loads, and the ones switched off. The expanded page then
// carries the two panes behind its navigation bar.
api.close()
tree = await settle(main.render, { t })
const skillCell = byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'skill')
assert.ok(skillCell, 'the skill cell must render on the wall')
assert.ok(byClass(skillCell, 'ph-sk-big')[0], 'the preview leads with the count')
assert.equal(textOf(byClass(skillCell, 'ph-sk-big')[0]).trim(), '6', 'the preview must read out every local skill')
assert.equal(byClass(skillCell, 'ph-sk-scale')[0].props.children.length, 3,
  'a nonzero state earns a segment; all three are nonzero here')
assert.deepEqual(
  byClass(skillCell, 'ph-sk-scale')[0].props.children.map((segment) => segment.props.style.flex),
  ['4', '1', '1'],
  'each segment must be proportional to its state\'s count',
)
assert.equal(text(skillCell).indexOf('C:\\Users\\me\\.dsh\\skills'), -1,
  'the thumbnail must not print the user path; the expanded page carries it')
assert.ok(!api.snapshot().notifications.skill, 'a readable library is not news and must raise no bubble')

api.open('skill')
tree = await settle(main.render, { t })
const skillPane = byClass(tree, 'ph-focus-card')[0]
assert.ok(skillPane, 'the skill card must expand in place')
assert.equal(skillPane.props['data-card-focus'], 'skill', 'the expanded pane must be the skill card')
const skillTabs = byClass(skillPane, 'ph-sk-tab')
assert.equal(skillTabs.length, 2, 'the navigation bar carries two panes')
assert.ok(textOf(skillTabs[0]).startsWith(t('skill.tab.library')),
  'the first pane is the installed library, got: ' + textOf(skillTabs[0]))
assert.equal(textOf(skillTabs[1]).trim(), t('skill.tab.discover'),
  'the second pane is discovery')
assert.equal(textOf(byClass(skillTabs[0], 'ph-sk-tab-count')[0]).trim(), '6',
  'the library tab carries the installed count')
assert.equal(byClass(skillPane, 'ph-sk-row').length, 6, 'the installed pane lists every skill')
// A skill this plugin cannot write must still be listed, must not offer a
// switch that would only fail, and must say why on the control itself.
const readOnlyRow = byClass(skillPane, 'ph-sk-row').find((row) => text(row).includes('writing-guard'))
assert.ok(readOnlyRow, 'a read-only skill must still be listed')
assert.equal(byClass(readOnlyRow, 'ph-sk-switch')[0].props.disabled, true,
  'a skill this plugin cannot write must not offer a switch that would fail')
assert.ok(String(byClass(readOnlyRow, 'ph-sk-switch')[0].props.title).includes(t('skill.row.readonlyBundled')),
  'the disabled switch must say why, got: ' + byClass(readOnlyRow, 'ph-sk-switch')[0].props.title)
// The state a skill is in is named once, by the mode control beside the switch,
// and the row's own class carries it at a glance.
assert.ok(hasClass(readOnlyRow, 'is-off'), 'a disabled skill must read as disabled at a glance')
assert.ok(text(readOnlyRow).includes(t('skill.mode.off')), 'the mode control must name the state it is in')
dumpPreview(tree, '15-expanded-skill')

// The switch is the fast path: it writes the standard frontmatter field through
// the host and republishes the catalog to every surface.
const togglesBefore = calls.filter((call) => call.endpoint === 'homepage/skillSetEnabled').length
const toggleTarget = byClass(skillPane, 'ph-sk-row').find((row) => text(row).includes('old-notes'))
assert.ok(toggleTarget, 'the user-only skill must be listed')
byClass(toggleTarget, 'ph-sk-switch')[0].props.onClick()
tree = await settle(main.render, { t })
assert.equal(calls.filter((call) => call.endpoint === 'homepage/skillSetEnabled').length, togglesBefore + 1,
  'turning a skill on must reach the host exactly once')
const toggled = calls.filter((call) => call.endpoint === 'homepage/skillSetEnabled').pop()
assert.deepEqual(toggled.payload.args, { options: { name: 'old-notes', mode: 'on' } },
  'the toggle must send the skill name and the mode, wrapped in the options object the descriptor declares')
assert.ok(calls.some((call) => call.endpoint === 'homepage/skillList'),
  'the catalog must be re-read after a toggle')

// Discovery: the second pane is a search field over community sources.
const discoverTab = byClass(tree, 'ph-focus-card')[0]
byClass(discoverTab, 'ph-sk-tab')[1].props.onClick()
tree = await settle(main.render, { t })
assert.ok(calls.some((call) => call.endpoint === 'homepage/skillSources'),
  'opening discovery must ask the host which sources exist')
const discoverPane = byClass(tree, 'ph-focus-card')[0]
assert.equal(byClass(discoverPane, 'ph-sk-hit').length, 0, 'nothing is shown before a search')
const discoverField = elements(discoverPane).find((node) => node.props && node.props.className === 'ph-sk-input')
assert.ok(discoverField, 'discovery leads with a search field')
discoverField.props.onChange({ target: { value: 'pdf' } })
tree = await settle(main.render, { t })
const goButton = elements(byClass(tree, 'ph-focus-card')[0])
  .find((node) => hasClass(node, 'ph-sk-btn') && textOf(node).includes(t('skill.discover.go')))
assert.ok(goButton, 'discovery must offer a way to run the search')
goButton.props.onClick()
tree = await settle(main.render, { t })
const searchCall = calls.filter((call) => call.endpoint === 'homepage/skillSearch').pop()
assert.deepEqual(searchCall.payload.args, { options: { query: 'pdf', source: 'all' } },
  'the search must send the query and the chosen source')
const discoverResults = byClass(tree, 'ph-focus-card')[0]
assert.equal(byClass(discoverResults, 'ph-sk-hit').length, 2, 'every hit must earn a card')
// `pdf` is not installed in the fixture, so it offers an install; the pane also
// has to keep the source that failed visible instead of silently dropping it.
assert.ok(text(discoverResults).includes('awspace'), 'a hit must name its owner')
assert.ok(text(discoverResults).includes('502'), 'a source that failed must say so')
dumpPreview(tree, '16-skill-discover')

const skillInstallButton = elements(discoverResults)
  .find((node) => hasClass(node, 'ph-sk-btn') && textOf(node).includes(t('skill.install.action')))
assert.ok(skillInstallButton, 'an uninstalled hit must offer an install')
skillInstallButton.props.onClick()
tree = await settle(main.render, { t })
const skillInstallCall = calls.filter((call) => call.endpoint === 'homepage/skillInstall').pop()
assert.deepEqual(skillInstallCall.payload.args,
  { options: { id: 'clawhub:awspace/pdf', source: 'clawhub', ref: 'awspace/pdf', destination: 'user-dsh' } },
  'an install must name the skill and the root by name, never by path')

// A local skill is not a dead row: clicking its name opens what the skill
// actually says. Two skills with near-identical summaries are told apart by
// nothing else, so this is the surface that makes the library usable.
byClass(byClass(tree, 'ph-focus-card')[0], 'ph-sk-tab')[0].props.onClick()
tree = await settle(main.render, { t })
const libraryPane = byClass(tree, 'ph-focus-card')[0]
const contentRow = byClass(libraryPane, 'ph-sk-row').find((row) => text(row).includes('graphlint'))
assert.ok(contentRow, 'the skill to open must be listed in the library')
const contentName = byClass(contentRow, 'ph-sk-name')[0]
assert.equal(contentName.tag, 'button', 'the name must be a real control, not plain text in a row')
assert.ok(String(contentName.props.title).includes('graphlint'),
  'the control must say which skill it opens, got: ' + contentName.props.title)
contentName.props.onClick()
tree = await settle(main.render, { t })
const contentCall = calls.filter((call) => call.endpoint === 'homepage/skillContent').pop()
assert.deepEqual(contentCall.payload.args, { options: { name: 'graphlint' } },
  'opening a skill must ask the host for that skill, by name')
const docPane = byClass(tree, 'ph-focus-card')[0]
assert.equal(byClass(docPane, 'ph-sk-tab').length, 0,
  'the content page must replace the panes rather than stack a second surface on them')
assert.ok(byClass(docPane, 'ph-sk-doc')[0], 'the content page must render')
assert.ok(!text(docPane).includes(t('skill.doc.loading')), 'a settled read must not still read as loading')
assert.ok(!hasClass(docPane, 'ph-sk-error') && byClass(docPane, 'ph-sk-error').length === 0,
  'a readable skill must not render the error branch')
const docText = textOf(byClass(docPane, 'ph-sk-doc-text')[0])
assert.ok(docText.startsWith('# Graphlint'),
  'the body must be the skill\'s own text, unrendered, got: ' + JSON.stringify(docText.slice(0, 40)))
assert.equal(byClass(docPane, 'ph-sk-doc-fact').length, 2, 'every frontmatter field must be shown')
assert.equal(byClass(docPane, 'ph-sk-doc-file').length, 3, 'every resource beside SKILL.md must be listed')
assert.ok(byClass(docPane, 'ph-combo')[0], 'a writable skill must offer the mode control on the content page')
dumpPreview(tree, '17-skill-content')

// Reading a skill is not a trap: the back control returns to the panes, and it
// must not re-read the file it already has.
const readsBefore = calls.filter((call) => call.endpoint === 'homepage/skillContent').length
const backButton = elements(docPane)
  .find((node) => hasClass(node, 'ph-sk-btn') && String(node.props.title) === t('skill.doc.back'))
assert.ok(backButton, 'the content page must offer a way back to the list')
backButton.props.onClick()
tree = await settle(main.render, { t })
assert.equal(byClass(byClass(tree, 'ph-focus-card')[0], 'ph-sk-tab').length, 2,
  'going back must restore the two panes')
assert.equal(calls.filter((call) => call.endpoint === 'homepage/skillContent').length, readsBefore,
  'going back must not re-read a skill the card already has')

// Back to the library, and the device card takes the focus again for the block
// that follows, which drives whatever card happens to be expanded.
api.open('device')
tree = await settle(main.render, { t })

// --- a hiccup is not a notice --------------------------------------------
// The host half mounts lazily, so the first poll after a page load can lose
// that race and answer 404 while the very next one succeeds. That is not news
// to announce: only a failure that survives a retry is a condition.
const deviceFixture = FIXTURES['homepage/device']
const deviceCaret = () => elements(byClass(tree, 'ph-focus-card')[0]).find((node) => hasClass(node, 'ph-combo-caret'))
const deviceRefresh = () => elements(tree).find((node) => hasClass(node, 'ph-combo-item') && textOf(node).trim() === t('common.refresh'))
const refreshDevice = async () => {
  deviceCaret().props.onClick()
  tree = await settle(main.render, { t })
  assert.ok(deviceRefresh(), 'the device card must offer a manual refresh')
  deviceRefresh().props.onClick()
  tree = await settle(main.render, { t })
}
const deviceText = () => text(byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'device'))

FIXTURES['homepage/device'] = TRANSPORT_FAILURE
await refreshDevice()
assert.ok(deviceText().includes('HTTP 404'), 'the card itself still reports the failure, got: ' + deviceText())

await refreshDevice()
tree = await settle(main.render, { t })
assert.equal((api.snapshot().notifications.device || []).length, 1, 'a failure that survives a retry is worth a bubble')
assert.ok(api.snapshot().notifications.device[0].text.includes('404'), 'the notice names the failure')
const deviceCellNow = byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'device')
assert.equal(byClass(deviceCellNow, 'ph-bubble').length, 1, 'the device card shows its bubble')

FIXTURES['homepage/device'] = deviceFixture
await refreshDevice()
assert.ok(!api.snapshot().notifications.device, 'a recovered read retracts the bubble')
assert.equal(byClass(tree, 'ph-bubble').length, 0, 'nothing is left asking for the user')

api.open('token')
tree = await settle(main.render, { t })
assert.ok(byClass(tree, 'ph-detail-block').length >= 1, 'the token detail must render its blocks')
assert.ok(byClass(tree, 'ph-bars').length >= 1, 'the token detail must render the history chart')
assert.equal(byClass(byClass(tree, 'ph-focus-card')[0], 'ph-action').length, 3, 'the expanded token card must expose its three settings')
dumpPreview(tree, '04-expanded-token')
const tokenDetailText = text(tree)
assert.ok(tokenDetailText.includes('2026-10-13') || tokenDetailText.includes('10/13'), 'the token detail must list history days')
assert.ok(!tokenDetailText.includes('已授权'), 'a healthy account no longer spends a row on its own state')
assert.ok(tokenDetailText.indexOf('credential-stored') < 0, 'the platform vocabulary must not reach the UI, got: ' + tokenDetailText)
assert.ok(tokenDetailText.indexOf('3.5049999999999999') < 0, 'the exact platform float must not be shown inline, got: ' + tokenDetailText)
const rawTitled = elements(tree).filter((node) => node.props && node.props.title === '3.5049999999999999')
assert.equal(rawTitled.length, 1, 'the exact platform value must be reachable as a tooltip')
// Clicking the wall background — not a card — puts the card back down. A click
// on the wall has target === currentTarget; a click inside a card does not, and
// must be left alone.
const gridNode = byClass(tree, 'ph-grid')[0]
const inner = {}
gridNode.props.onClick({ target: {}, currentTarget: inner })
tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-focus-card').length, 1, 'a click inside a card must not collapse it')
gridNode.props.onClick({ target: inner, currentTarget: inner })
tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-focus-card').length, 0, 'a click on the wall background must collapse the focus card')

// The pane's own surroundings are the second way down.
api.open('token')
tree = await settle(main.render, { t })
const layer = byClass(tree, 'ph-focus-layer')[0]
const layerSelf = {}
layer.props.onClick({ target: inner, currentTarget: layerSelf })
tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-focus-card').length, 1, 'a click inside the pane must not collapse it')
layer.props.onClick({ target: layerSelf, currentTarget: layerSelf })
tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-focus-card').length, 0, 'a click on the space around the pane must collapse it')

// The pane flies out of the card that was clicked. The origin is measured once,
// from the source card's shell and the stage, and handed to the animation as
// CSS variables: the first frame then sits exactly on the source rectangle.
const shellRect = { left: 120, top: 300, width: 480, height: 200 }
const stageRect = { left: 100, top: 100, width: 1000, height: 700 }
document.querySelector = (selector) => {
  if (selector === '[data-card-cell="token"] .ph-shell') return { getBoundingClientRect: () => shellRect }
  if (selector === '.ph-stage') return { getBoundingClientRect: () => stageRect }
  return null
}
api.open('token')
tree = await settle(main.render, { t })
const grown = byClass(tree, 'ph-focus-card')[0].props.style
assert.equal(grown['--ph-fsx'], String(480 / 750), 'the first frame must be scaled from the source card to a 75% pane')
assert.equal(grown['--ph-fdx'], '-105px', 'the first frame must be translated onto the source card')
assert.equal(grown['--ph-fdy'], '-50px', 'the first frame must be translated onto the source card')
document.querySelector = () => null
api.close()
api.open('token')
tree = await settle(main.render, { t })
const unmeasured = byClass(tree, 'ph-focus-card')[0].props.style
assert.equal(unmeasured['--ph-fdx'], undefined, 'an unmeasurable source must fall back to a plain fade-in')
api.close()
tree = await settle(main.render, { t })

api.open('network')
tree = await settle(main.render, { t })
const networkDetail = text(tree)
assert.ok(byClass(tree, 'ph-kv').length >= 1, 'the network detail must render key/value rows')
assert.ok(networkDetail.includes('HTTP_PROXY'), 'the network detail must name the proxy variable')
assert.ok(networkDetail.includes('NODE_EXTRA_CA_CERTS'), 'the network detail must list TLS variables')
api.close()
tree = await settle(main.render, { t })

// --------------------------------------------------- third-party registration

api.define({
  id: 'custom',
  title: '自定义卡片',
  subtitle: '由另一个插件注册',
  size: { w: 3, h: 2 },
  accent: '#ff00aa',
  background: '#102030',
  hover: { grow: 1.05, hint: true },
  effects: { outline: 'pulse', sheen: true },
  content: () => React.createElement('div', { className: 'custom-body' }, 'CUSTOM-BODY'),
  detail: () => React.createElement('div', { className: 'custom-detail' }, 'CUSTOM-DETAIL'),
  actions: [{ id: 'mode', type: 'segmented', label: '模式', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }],
})

api.defineEffect('pulse', { label: '脉冲', description: '测试用动效', css: '.ph-fx-pulse{outline:1px solid #f0f}' })

tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-cell').length, 12, 'a registered card must appear')
const customCell = byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'custom')
assert.ok(customCell, 'the custom cell must exist')
assert.ok(text(customCell).includes('CUSTOM-BODY'), 'the custom content must render')
assert.equal(customCell.props.style.gridColumn, 'span 3', 'a registered default size must be honoured')
const customShell = elements(customCell).find((node) => hasClass(node, 'ph-shell'))
assert.ok(hasClass(customShell, 'ph-fx-pulse'), 'a registered effect must land on the shell')
assert.equal(customShell.props.style.background, '#102030', 'a custom background must be applied')
assert.equal(byClass(customCell, 'ph-sheen').length, 1, 'a card that asks for the sheen must get exactly one')

assert.ok(text(tree).includes('ph-fx-pulse'), 'a custom effect stylesheet must be injected')

// Overriding a shipped card needs the explicit flag.
assert.throws(() => api.define({ id: 'token', title: 'nope' }), /override/, 'redefining a shipped card must be refused')
api.define({
  id: 'token',
  override: true,
  title: '改写',
  size: { w: 1, h: 1 },
  content: () => React.createElement('div', null, 'OVERRIDDEN'),
})
tree = await settle(main.render, { t })
const overriddenCell = byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'token')
assert.ok(text(overriddenCell).includes('OVERRIDDEN'), 'an override must replace the shipped body')
assert.equal(overriddenCell.props.style.gridColumn, 'span 1', 'an override must replace the default size')

// A breaking renderer must not take the wall down. The count is compared
// against the count before the broken card was registered rather than against a
// literal: the shipped set is not this assertion's subject, and a literal here
// made adding a card look like a crash.
const cellsBeforeBroken = byClass(tree, 'ph-cell').length
api.define({
  id: 'broken',
  title: 'Broken',
  content: () => { throw new Error('renderer exploded') },
})
tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-cell').length, cellsBeforeBroken + 1, 'a throwing card must not remove its cell')
const brokenCell = byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'broken')
assert.ok(byClass(brokenCell, 'ph-card-error').length === 1, 'a throwing card must render an inline error')
assert.ok(text(brokenCell).includes('renderer exploded'), 'the error must carry the message')
const survivingIds = byClass(tree, 'ph-cell').map((cell) => cell.props['data-card-cell']).sort()
assert.deepEqual(survivingIds, ['broken', 'custom', 'device', 'dsh', 'hygiene', 'network', 'plugin-audit', 'projects', 'sessions', 'sidebar-groups', 'skill', 'token', 'tool-usage'],
  'the other cards must survive')

// Notifications raised programmatically land on the right card.
api.notify('custom', 'warn', '注意：这是警告')
api.notify('custom', 'error', '这是错误')
tree = await settle(main.render, { t })
const customNotices = api.snapshot().notifications.custom
assert.equal(customNotices.length, 2, 'both notices must be stored')
assert.equal(customNotices[1].level, 'error')
assert.equal(api.snapshot().notifications.custom[0].text, '注意：这是警告')

// One card, one bubble: a bubble is the card's live status, so it carries the
// most severe notice the card is holding rather than stacking both.
const notifiedCell = byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'custom')
const customBubbles = byClass(notifiedCell, 'ph-bubble')
assert.equal(customBubbles.length, 1, 'a card with two notices must still show one bubble')
assert.ok(String(customBubbles[0].props.className).includes('ph-bubble--error'), 'the bubble must carry the severest level, got: ' + customBubbles[0].props.className)
assert.equal(byClass(tree, 'ph-bubble').length, 1, 'only the card holding a notice shows a bubble')

if (PREVIEW_DIR) {
  byClass(tree, 'ph-bubble')[0].props.onClick()
  dumpPreview(await settle(main.render, { t }), '05-notice-panel')
  byClass(await settle(main.render, { t }), 'ph-bubble')[0].props.onClick()
  await settle(main.render, { t })
}

api.clearNotifications('custom')
tree = await settle(main.render, { t })
const remaining = api.snapshot().notifications.custom
assert.ok(!remaining || remaining.length === 0, 'notifications must be clearable')
const stillNotified = Object.keys(api.snapshot().notifications).filter((id) => api.snapshot().notifications[id].length > 0)
assert.equal(byClass(tree, 'ph-bubble').length, stillNotified.length, 'a cleared card must lose its bubble')

// Card-local api helpers.
const customCard = api.cardApi('custom')
assert.ok(customCard, 'the global surface must hand out a card api by id')
assert.equal(api.get('custom').title, '自定义卡片', 'get must return the registration')
customCard.setSize({ w: 2, h: 2 })
customCard.setControl('mode', 'b')
customCard.setBackground(api.backgrounds.mesh('#ff00aa', 0.3))
tree = await settle(main.render, { t })
assert.equal(api.state().layout.custom.w, 2, 'setSize must persist')
assert.equal(api.state().layout.custom.h, 2, 'setSize must persist both axes')
assert.equal(api.state().controls.custom.mode, 'b', 'setControl must persist')
assert.equal(api.state().layout.custom.background.type, 'mesh', 'setBackground must persist')
const meshCell = byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'custom')
assert.equal(byClass(meshCell, 'ph-bg-layer').length, 1, 'a mesh background must render its layer element')

// ------------------------------------------------------------------- reorder

const before = api.list().map((card) => card.id)
api.reorder('network', 'token')
tree = await settle(main.render, { t })
const after = byClass(tree, 'ph-cell').map((cell) => cell.props['data-card-cell'])
assert.notDeepEqual(after, before, 'reorder must change the rendered order')
assert.equal(after[0], 'network', 'reorder must move the dragged card to the target index')
assert.deepEqual(api.state().order.slice(0, 3), after.slice(0, 3), 'the new order must be persisted')

// ------------------------------------------------------------------- removal

api.remove('custom')
api.remove('broken')
tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-cell').length, 11, 'removed cards must disappear')
// The stored order deliberately keeps the id, so a card that is unregistered
// and registered again (a plugin reload) resumes its place and its layout. The
// reader drops ids that no longer resolve.
assert.notEqual(api.state().order.indexOf('custom'), -1, 'a removed card keeps its slot in the stored order')
api.define({ id: 'custom', title: '自定义卡片', render: function () { return null } })
tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-cell').length, 12, 'a re-registered card must come back')
assert.equal(api.state().layout.custom.w, 2, 'a re-registered card keeps its stored size')

// ------------------------------------------------------------------- texture
//
// The image texture and the knobs on it, checked here because a card has to
// declare them; the shipped wall's own watermarks are checked above. A number
// over 1 is a percentage (12 is twelve percent, not 1200%), a number is pixels
// for the size, a string is a CSS length used verbatim, and the offsets land as
// variables.

assert.equal(
  byClass(byClass(tree, 'ph-cell').find((node) => node.props['data-card-cell'] === 'custom'), 'ph-tex').length,
  0,
  'a card that asked for no texture must get none',
)

api.define({
  id: 'textured',
  title: '有纹理的卡片',
  texture: {
    // A real mark, not an empty SVG: this dump is the evidence that an image
    // texture crops the way an icon does, so it has to have something to crop.
    image: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<circle cx="50" cy="50" r="36" fill="none" stroke="black" stroke-width="7"/>' +
      '<path d="M18 82 L50 18 L82 82" fill="none" stroke="black" stroke-width="7"/></svg>',
    opacity: 12,
    size: 200,
    bleed: '-30%',
    anchor: 'left',
    offset: [4, -6],
    rotate: -8,
    fit: 'cover',
    fade: true,
    fadePosition: 70,
    blend: 'luminosity',
  },
  render: function () { return null },
})
tree = await settle(main.render, { t })
const texturedCell = byClass(tree, 'ph-cell').find((node) => node.props['data-card-cell'] === 'textured')
const texturedLayer = byClass(texturedCell, 'ph-tex')[0]
assert.ok(hasClass(texturedLayer, 'ph-tex--left'), 'anchor must be able to move the mark')
assert.equal(texturedLayer.props.style['--ph-tex-opacity'], '0.12', 'a percentage written as 12 is twelve percent')
assert.equal(texturedLayer.props.style['--ph-tex-size'], '200px', 'a number size is pixels')
assert.equal(texturedLayer.props.style['--ph-tex-bleed'], '-30%', 'a string length is used verbatim')
assert.equal(texturedLayer.props.style['--ph-tex-x'], '4px', 'offset[0] is the x nudge')
assert.equal(texturedLayer.props.style['--ph-tex-y'], '-6px', 'offset[1] is the y nudge')
assert.equal(texturedLayer.props.style['--ph-tex-rotate'], '-8deg', 'rotate is degrees')
assert.ok(hasClass(texturedLayer, 'ph-tex--fade'), 'a fade is opt-in through its own class')
assert.ok(hasClass(texturedLayer, 'ph-tex--blend'), 'a blend is opt-in through its own class')
assert.equal(texturedLayer.props.style['--ph-tex-fade'], '70%', 'fade position is the share of the far side that dissolves')
assert.equal(texturedLayer.props.style['--ph-tex-fade-half'], '35%', 'the centre anchor gets half the band')
assert.equal(texturedLayer.props.style.mixBlendMode, 'luminosity', 'a blend mode reaches the layer style')
const texturedMark = byClass(texturedLayer, 'ph-tex-mark')[0]
assert.ok(
  String(texturedMark.props.style.backgroundImage).indexOf('url("data:image/svg+xml') === 0,
  'an image texture becomes a background image, quotes escaped inside the url',
)
assert.equal(texturedMark.props.style.backgroundSize, 'cover', 'fit maps to background-size')
dumpPreview(tree, '07-texture-image')

// A crafted value must not be able to leave its own declaration: the quote is
// escaped, and the mark still writes exactly two style properties.
api.remove('textured')
api.define({
  id: 'hostile',
  title: '敌意纹理',
  texture: { image: 'x"); color: red; ("' },
  render: function () { return null },
})
tree = await settle(main.render, { t })
const hostileCell = byClass(tree, 'ph-cell').find((node) => node.props['data-card-cell'] === 'hostile')
const hostileMark = byClass(byClass(hostileCell, 'ph-tex')[0], 'ph-tex-mark')[0]
assert.deepEqual(
  Object.keys(hostileMark.props.style).sort(),
  ['backgroundImage', 'backgroundSize'],
  'a texture writes its two style properties and nothing else',
)
assert.ok(
  String(hostileMark.props.style.backgroundImage).indexOf('\\"') !== -1,
  'a quote inside the url must arrive escaped, never bare',
)
api.remove('hostile')
tree = await settle(main.render, { t })
// The count is compared with the wall as it stood before the hostile card: this
// file replaced the token card with its own override earlier on, and an override
// is a whole new definition — it prints no watermark, which is the
// registration's choice and not a rendering loss.
assert.equal(byClass(tree, 'ph-tex').length, 10, 'removing the test cards must leave the cards that declare a texture')

// --------------------------------------------------------------- plugin audit
//
// The audit card is a client for a host that resolves a target, opens a review
// session and follows it to a verdict. Nothing below reaches a real host: the
// fixtures answer the four endpoints, and what this section proves is the
// contract between them and the card — the target it sends, the states it
// follows, the verdict it announces once, the answers it refuses to draw, and
// the timer it stops.

const AUDIT_PLUGIN = {
  input: 'acme/evil-plugin',
  kind: 'github',
  name: 'evil-plugin',
  version: '1.2.3',
  repo: 'acme/evil-plugin',
  spec: 'github:acme/evil-plugin#v1.2.3',
  description: 'a plugin that installs itself from a shell script',
}
const AUDIT_SESSION = { id: 'audit-session-1', title: 'review: evil-plugin' }

/** @returns the host's full audit record, with the fields one case overrides. */
function auditFixture(state, extra) {
  return Object.assign({
    auditId: 'audit-1',
    state: state,
    stage: '',
    detail: '',
    verdict: null,
    summary: '',
    findings: [],
    plugin: AUDIT_PLUGIN,
    source: {
      kind: 'npm', label: 'acme/evil-plugin', ref: '1.2.3', pinned: true,
      installSpec: 'acme-evil-plugin@1.2.3', artifactSha256: 'a'.repeat(64),
      fileCount: 3, byteCount: 120, truncated: false, anomalies: [],
    },
    session: AUDIT_SESSION,
    installed: false,
    install: null,
    startedAt: 1,
    updatedAt: 2,
  }, extra || {})
}

const auditStatusCalls = () => calls.filter((entry) => entry.endpoint === 'homepage/pluginAuditStatus').length
const auditNoticeOf = () => api.snapshot().notifications['plugin-audit'] || []

/**
 * Start a review the way a user starts one: type a target, press the button,
 * and let the host answer. The card reads the host on every start, so this is
 * also how a later case moves it on to a different verdict — collapsing and
 * reopening the card is not a reload.
 * @returns the expanded body, settled on the host's answer.
 */
async function startAuditReview(target, audit) {
  FIXTURES['homepage/pluginAuditStart'] = audit
  FIXTURES['homepage/pluginAuditStatus'] = audit
  let pane = byClass(tree, 'ph-focus-card')[0]
  byClass(pane, 'ph-input')[0].props.onChange({ target: { value: target } })
  tree = await settle(main.render, { t })
  pane = byClass(tree, 'ph-focus-card')[0]
  const go = buttons(pane, t('pluginAudit.action.start'))[0]
  assert.ok(go && go.props.disabled === false, 'the review must be startable for ' + target)
  go.props.onClick()
  tree = await settle(main.render, { t })
  return byClass(tree, 'ph-focus-card')[0]
}

// The card stands on its own: it reads no marketplace and offers no browsing, so
// there is nothing to stub for one — a target is typed, and the host resolves it.

// The review has not been asked for anything yet, so the card says so and
// offers the one thing it can do: take a target.
api.open('plugin-audit')
tree = await settle(main.render, { t })
let auditPane = byClass(tree, 'ph-focus-card')[0]
assert.equal(auditPane.props['data-card-focus'], 'plugin-audit', 'the audit card must expand')
assert.ok(text(auditPane).includes(t('pluginAudit.idle')), 'an untouched card says it has no review, got: ' + text(auditPane))
assert.equal(buttons(auditPane, t('pluginAudit.action.start'))[0].props.disabled, true,
  'an empty target is not reviewable')

assert.equal(byClass(auditPane, 'ph-audit-launch').length, 1, 'the target has a dedicated launch panel')
assert.equal(byClass(auditPane, 'ph-audit-settings')[0].props.hidden, true, 'the editor starts collapsed')
const promptTrigger = byClass(auditPane, 'ph-audit-prompt-trigger')[0]
assert.equal(promptTrigger.props['aria-expanded'], false)
promptTrigger.props.onClick()
tree = await settle(main.render, { t })
auditPane = byClass(tree, 'ph-focus-card')[0]
assert.equal(byClass(auditPane, 'ph-audit-prompt-trigger')[0].props['aria-expanded'], true)
assert.equal(byClass(auditPane, 'ph-audit-settings')[0].props.hidden, false, 'the visible prompt action opens the editor')
const defaultPrompt = byClass(auditPane, 'ph-audit-prompt')[0].props.value
assert.ok(defaultPrompt.includes('safe'), 'the editor displays the actual default guidance')
byClass(auditPane, 'ph-audit-prompt')[0].props.onChange({ target: { value: '重点检查凭据外传' } })
tree = await settle(main.render, { t })
auditPane = byClass(tree, 'ph-focus-card')[0]
buttons(auditPane, t('pluginAudit.prompt.save'))[0].props.onClick()
tree = await settle(main.render, { t })
auditPane = byClass(tree, 'ph-focus-card')[0]
assert.equal(byClass(auditPane, 'ph-audit-prompt')[0].props.value, '重点检查凭据外传')
buttons(auditPane, t('pluginAudit.prompt.reset'))[0].props.onClick()
tree = await settle(main.render, { t })
auditPane = byClass(tree, 'ph-focus-card')[0]
assert.equal(byClass(auditPane, 'ph-audit-prompt')[0].props.value, defaultPrompt, 'reset restores the full default')

const auditTarget = byClass(auditPane, 'ph-input')[0]
assert.ok(auditTarget, 'the card must offer a field for the target')
auditTarget.props.onChange({ target: { value: '  acme/evil-plugin  ' } })
tree = await settle(main.render, { t })
auditPane = byClass(tree, 'ph-focus-card')[0]
assert.equal(buttons(auditPane, t('pluginAudit.action.start'))[0].props.disabled, false,
  'a typed target must enable the review')

FIXTURES['homepage/pluginAuditStart'] = auditFixture('running', { stage: 'reading' })
FIXTURES['homepage/pluginAuditStatus'] = auditFixture('running', { stage: 'reading' })
const auditCallsBefore = calls.length
buttons(auditPane, t('pluginAudit.action.start'))[0].props.onClick()
tree = await settle(main.render, { t })

const startCalls = calls.slice(auditCallsBefore).filter((entry) => entry.endpoint === 'homepage/pluginAuditStart')
assert.equal(startCalls.length, 1, 'starting a review is one call')
assert.deepEqual(startCalls[0].payload.args, { options: { target: 'acme/evil-plugin' } },
  'the host is handed the trimmed target and nothing else')

// A live review is followed on the card's own timer: the stage is the only
// progress a user can see, and the verdict arrives without anyone reloading.
auditPane = byClass(tree, 'ph-focus-card')[0]
assert.ok(text(auditPane).includes(t('pluginAudit.stage.reading')), 'a running review must say what it is doing, got: ' + text(auditPane))
assert.ok(text(auditPane).includes(AUDIT_PLUGIN.name), 'a running review names the plugin, got: ' + text(auditPane))
assert.equal(auditNoticeOf().length, 0, 'a review in progress is not news')
dumpPreview(tree, '14-audit-running')

const auditPolls = auditStatusCalls()
FIXTURES['homepage/pluginAuditStatus'] = auditFixture('warn', {
  verdict: 'warn',
  summary: 'Installs a shell script the package does not declare.',
  compatibility: { runtime: '0.2.1-alpha.3', required: '^0.1.0-rc.6', compatible: false, unknown: false, incompatible: true },
  findings: [
    { level: 'info', title: 'no network access at runtime', ref: 'index.js:1' },
    {
      level: 'warn',
      title: 'postinstall runs a shell script',
      detail: 'spawns sh install.sh',
      ref: 'scripts/install.js:12',
      risk: {
        role: 'runs a shell script while the package is installed',
        why: 'the package needs a helper on disk before it can start',
        impact: 'the script runs inside the profile before anyone reviewed it',
        scenario: 'supply-chain',
      },
    },
    { level: 'error', title: 'reads the ssh directory', detail: 'walks the home directory', ref: 'index.js:42' },
  ],
})
await sleep(1700)
tree = await settle(main.render, { t })
assert.ok(auditStatusCalls() > auditPolls, 'a live review must keep asking the host')

// warn is the one verdict that needs the user, and the announcement is the
// point of the card.
auditPane = byClass(tree, 'ph-focus-card')[0]
assert.ok(text(auditPane).includes(t('pluginAudit.state.warn')), 'a warn verdict must say so, got: ' + text(auditPane))
const auditNotices = auditNoticeOf()
assert.equal(auditNotices.length, 1, 'a verdict is announced once, not once per poll')
assert.equal(auditNotices[0].level, 'warn', 'a warn verdict is a warning, not a failure')
assert.ok(String(auditNotices[0].text).includes(AUDIT_PLUGIN.name), 'the notice names the plugin, got: ' + auditNotices[0].text)
assert.equal(buttons(auditPane, t('pluginAudit.action.install')).length, 1, 'a warn verdict must offer the install')
assert.equal(buttons(auditPane, t('pluginAudit.action.decline')).length, 1, 'a warn verdict must offer the way out')

// The findings are read worst first, whatever order the session thought of them in,
// and an error or a warn opens with the four answers the decision needs: what the
// code does, why it is there, what it could cost, and which situation it belongs
// to. An info stays folded so the context cannot push the warnings off the card.
const findingRows = byClass(auditPane, 'ph-audit-finding')
assert.equal(findingRows.length, 3, 'every finding is drawn, got ' + findingRows.length)
const findingTitles = byClass(auditPane, 'ph-audit-finding-title').map(function (node) { return text(node) })
assert.equal(findingTitles[0], 'reads the ssh directory', 'the error comes first')
assert.equal(findingTitles[1], 'postinstall runs a shell script', 'then the warn')
assert.equal(findingTitles[2], 'no network access at runtime', 'then the info')
assert.ok(text(findingRows[1]).includes(t('pluginAudit.risk.role')), 'a warn finding says what the code does')
assert.ok(text(findingRows[1]).includes(t('pluginAudit.risk.why')), 'and why the plugin has it')
assert.ok(text(findingRows[1]).includes(t('pluginAudit.risk.impact')), 'and what it could cost')
assert.ok(text(findingRows[1]).includes(t('pluginAudit.scenario.supplyChain')), 'and names the situation')
assert.equal(byClass(findingRows[2], 'ph-audit-reveal')[0].props.hidden, true, 'an info finding starts folded without unmounting its animated body')
byClass(findingRows[2], 'ph-audit-finding-head')[0].props.onClick()
tree = await settle(main.render, { t })
auditPane = byClass(tree, 'ph-focus-card')[0]
const reopened = byClass(auditPane, 'ph-audit-finding')[2]
assert.ok(text(reopened).includes('no network access at runtime'), 'clicking the head keeps the finding')
assert.equal(byClass(reopened, 'ph-audit-finding-body').length, 1, 'and unfolds it')
dumpPreview(tree, '14-audit-warn')

// The decision names the audit the user was shown, not whatever is newest.
FIXTURES['homepage/pluginAuditDecide'] = auditFixture('installed', { installed: true })
FIXTURES['homepage/pluginAuditStatus'] = auditFixture('installed', { installed: true })
const auditDecideBefore = calls.length
buttons(auditPane, t('pluginAudit.action.install'))[0].props.onClick()
tree = await settle(main.render, { t })
const decideCalls = calls.slice(auditDecideBefore).filter((entry) => entry.endpoint === 'homepage/pluginAuditDecide')
assert.equal(decideCalls.length, 1, 'confirming an install is one call')
assert.deepEqual(decideCalls[0].payload.args, { options: { auditId: 'audit-1', decision: 'install' } },
  'the decision names the audit the user was shown')

// The decision is published as the card's shared signal, and every instance of the
// card answers it: the wall's preview holds its own read of the same audit, and a
// state the user can act on is exactly the state the poll timer stops on — so
// without the signal the preview kept offering an install that had already run.
assert.ok(String(api.state().controls['plugin-audit'].auditSignal || '').startsWith('audit-1@'),
  'a decision publishes the signal, got: ' + String(api.state().controls['plugin-audit'].auditSignal))

// installed is terminal: the card stops asking the host, and says the result.
auditPane = byClass(tree, 'ph-focus-card')[0]
assert.ok(text(auditPane).includes(t('pluginAudit.state.installed')), 'a finished install must be shown, got: ' + text(auditPane))
assert.equal(buttons(auditPane, t('pluginAudit.action.install')).length, 0, 'an installed plugin is no longer offered for install')
assert.equal(buttons(tree, t('pluginAudit.action.install')).length, 0,
  'and no other instance keeps offering it: the preview reads the same audit')
assert.equal((auditNoticeOf()[0] || {}).level, 'info', 'a finished install is reported, not warned about')
const auditSettled = auditStatusCalls()
await sleep(1700)
assert.equal(auditStatusCalls(), auditSettled, 'a terminal audit must stop polling')

// An unsafe verdict has no install path: the host refuses one without an
// override, and the card draws no button that would send one.
const unsafeReview = auditFixture('unsafe', {
  verdict: 'unsafe',
  summary: 'Reads ~/.ssh and posts it to a host the package controls.',
  findings: [{ level: 'error', title: 'exfiltrates credentials', ref: 'index.js:42' }],
})
auditPane = await startAuditReview('acme/evil-plugin', unsafeReview)
assert.ok(text(auditPane).includes(t('pluginAudit.state.unsafe')), 'an unsafe verdict must say so, got: ' + text(auditPane))
const unsafeNotices = auditNoticeOf()
assert.equal(unsafeNotices.length, 1, 'an unsafe verdict replaces the warn notice rather than stacking')
assert.equal(unsafeNotices[0].level, 'error', 'an unsafe verdict is an error')
assert.equal(buttons(auditPane, t('pluginAudit.action.install')).length, 0, 'an unsafe plugin must never be offered for install')
assert.equal(buttons(auditPane, t('pluginAudit.action.decline')).length, 1, 'the safe answer stays available')

// The review lives in a session, and the way into it is the client's own
// session service — the card does not open a window of its own.
const openSession = buttons(auditPane, t('pluginAudit.action.openSession'))[0]
assert.ok(openSession, 'the expanded card must offer the review session')
assert.equal(openSession.props.disabled, false, 'the client has the service and the audit names a session')
openSession.props.onClick()
assert.deepEqual(lastServiceCall('uiWorkspace', 'openSession').args, ['audit-session-1'],
  'the button opens the session the host named')

// With no session to open, the same button explains itself instead of lying.
auditPane = await startAuditReview('acme/evil-plugin', auditFixture('unsafe', { verdict: 'unsafe', session: null }))
assert.equal(buttons(auditPane, t('pluginAudit.action.openSession'))[0].props.disabled, true,
  'a session that does not exist yet cannot be opened')
assert.ok(text(auditPane).includes(t('pluginAudit.session.none')), 'and the card says why, got: ' + text(auditPane))

// A failure is shown as the host wrote it: the failing step is the news, and
// nothing about it offers an install.
auditPane = await startAuditReview('acme/evil-plugin', auditFixture('failed', {
  stage: 'no-verdict',
  detail: 'The review session ended without a verdict.',
}))
assert.ok(text(auditPane).includes('The review session ended without a verdict.'),
  'a failure must be shown as the host wrote it, got: ' + text(auditPane))
assert.equal(buttons(auditPane, t('pluginAudit.action.install')).length, 0, 'a failed review installs nothing')
assert.equal((auditNoticeOf()[0] || {}).level, 'error', 'a failed review is an error')

// The version fit is part of the answer, not a detail of the install: DSH refuses
// a package whose declared range excludes the runtime, so the card says which
// range that was before the user waits for an install that cannot work.
auditPane = await startAuditReview('dsh-old@0.9.0', auditFixture('warn', {
  verdict: 'warn',
  plugin: { input: 'dsh-old@0.9.0', kind: 'npm', name: 'dsh-old', version: '0.9.0', repo: 'acme/dsh-old', spec: 'dsh-old@0.9.0' },
  compatibility: { runtime: '0.2.1-alpha.3', required: '^0.1.0-rc.6', compatible: false, unknown: false, incompatible: true },
}))
assert.ok(text(auditPane).includes(t('pluginAudit.compat.bad', { runtime: '0.2.1-alpha.3', required: '^0.1.0-rc.6' })),
  'an incompatible declared range must be stated, got: ' + text(auditPane))
auditPane = await startAuditReview('dsh-note', auditFixture('safe', {
  verdict: 'safe',
  plugin: { input: 'dsh-note', kind: 'npm', name: 'dsh-note', version: '1.2.3', repo: 'acme/dsh-note', spec: 'dsh-note@1.2.3' },
  compatibility: { runtime: '0.2.1-alpha.3', required: '^0.2.0', compatible: true, unknown: false, incompatible: false },
}))
assert.ok(text(auditPane).includes(t('pluginAudit.compat.ok', { runtime: '0.2.1-alpha.3' })),
  'a range that fits says so, got: ' + text(auditPane))
assert.equal(buttons(auditPane, t('pluginAudit.action.installNow')).length, 1,
  'a safe install-mode audit offers the install button instead of installing by itself')
auditPane = await startAuditReview('acme/mystery', auditFixture('warn', {
  verdict: 'warn',
  compatibility: null,
}))
assert.ok(text(auditPane).includes(t('pluginAudit.compat.unknown')),
  'an unreadable runtime version must not read as a pass, got: ' + text(auditPane))

// ------------------------------------------------------- one review path
//
// There is no mode picker any more: every audit is a read-only review, and the
// user decides about installing from the record. The only segmented control left
// is the current/history pane switch.
const segmentsOf = (pane) => byClass(pane, 'ph-segment')
const segmentNamed = (pane, label) => segmentsOf(pane).filter((node) => text(node) === label)[0]
assert.equal(segmentsOf(auditPane).length, 2,
  'the only segmented choice left is the current/history pane switch')
const cleanReview = auditFixture('safe', { verdict: 'safe', summary: 'Nothing was installed.' })
FIXTURES['homepage/pluginAuditStart'] = cleanReview
FIXTURES['homepage/pluginAuditStatus'] = cleanReview
const reviewStartsBefore = calls.filter((entry) => entry.endpoint === 'homepage/pluginAuditStart').length
assert.equal(byClass(auditPane, 'ph-audit-model-select')[0].props.disabled, false)
byClass(auditPane, 'ph-audit-effort-select')[0].props.onChange({ target: { value: 'high' } })
tree = await settle(main.render, { t })
auditPane = byClass(tree, 'ph-focus-card')[0]
assert.equal(byClass(auditPane, 'ph-audit-model-select')[0].props.value, JSON.stringify(['test', 'reviewer']))
byClass(auditPane, 'ph-input')[0].props.onChange({ target: { value: 'dsh-note' } })
tree = await settle(main.render, { t })
auditPane = byClass(tree, 'ph-focus-card')[0]
buttons(auditPane, t('pluginAudit.action.start'))[0].props.onClick()
tree = await settle(main.render, { t })
auditPane = byClass(tree, 'ph-focus-card')[0]
const reviewStarts = calls.filter((entry) => entry.endpoint === 'homepage/pluginAuditStart')
assert.equal(reviewStarts.length, reviewStartsBefore + 1, 'starting a second review is one more call')
assert.deepEqual(reviewStarts[reviewStarts.length - 1].payload.args, { options: { target: 'dsh-note', selection: { provider: 'test', model: 'reviewer', reasoningEffort: 'high' } } },
  'the host receives the review model and supported reasoning effort, with no mode field')
assert.ok(text(auditPane).includes(t('pluginAudit.state.safe')), 'the review reads as cleared')
assert.equal(buttons(auditPane, t('pluginAudit.action.installNow')).length, 1,
  'a cleared review can still be installed by hand — just never on its own')

// ------------------------------------------------------- the review history
//
// The navigation bar's right-hand pane is every review the host still holds: a row
// can be opened, installed or turned down where it lies, which is what lets a user
// queue several reviews and decide about them later.
FIXTURES['homepage/pluginAuditList'] = {
  audits: [
    auditFixture('warn', {
      auditId: 'audit-warn',
      verdict: 'warn',
      summary: 'Installs a shell script the package does not declare.',
      plugin: { input: 'dsh-note', kind: 'npm', name: 'dsh-note', version: '1.2.3', repo: 'acme/dsh-note', spec: 'dsh-note@1.2.3' },
    }),
    auditFixture('safe', { auditId: 'audit-review', verdict: 'safe', summary: 'Nothing was installed.' }),
    auditFixture('unsafe', { auditId: 'audit-old', verdict: 'unsafe', summary: 'Exfiltrates credentials.' }),
  ],
}
const catalogCallsBeforeTabs = calls.filter((entry) => entry.endpoint === 'homepage/pluginAuditModels').length
const savedViewTransition = globalThis.document.startViewTransition
let auditSnapshotCalls = 0
globalThis.document.startViewTransition = () => { auditSnapshotCalls += 1 }
const listBefore = calls.filter((entry) => entry.endpoint === 'homepage/pluginAuditList').length
segmentNamed(auditPane, t('pluginAudit.tab.history')).props.onClick()
tree = await settle(main.render, { t })
auditPane = byClass(tree, 'ph-focus-card')[0]
assert.equal(calls.filter((entry) => entry.endpoint === 'homepage/pluginAuditList').length, listBefore + 1,
  'opening the history asks the host for it')
assert.ok(!text(auditPane).includes('条记录'),
  'the list itself shows the records, so no counter repeats their number')
assert.equal(buttons(auditPane, t('pluginAudit.history.view')).length, 3, 'every record can be opened')
assert.equal(buttons(auditPane, t('pluginAudit.action.installNow')).length, 2,
  'a warning and a cleared review-only record offer an install; an unsafe one does not')
assert.equal(buttons(auditPane, t('pluginAudit.action.decline')).length, 2,
  'a warning and an unsafe record can be turned down')
dumpPreview(auditPane, '14-audit-history')
// Acting on a row: the second install button is the review-only record's, and the
// decision has to name it — not whatever happens to be newest.
FIXTURES['homepage/pluginAuditDecide'] = auditFixture('installed', { auditId: 'audit-review', installed: true })
const rowDecideBefore = calls.length
buttons(auditPane, t('pluginAudit.action.installNow'))[1].props.onClick()
tree = await settle(main.render, { t })
auditPane = byClass(tree, 'ph-focus-card')[0]
const rowDecide = calls.slice(rowDecideBefore).filter((entry) => entry.endpoint === 'homepage/pluginAuditDecide')
assert.equal(rowDecide.length, 1, 'installing from the history is one call')
assert.deepEqual(rowDecide[0].payload.args, { options: { auditId: 'audit-review', decision: 'install' } },
  'and it names the record the user acted on')
// Opening a row brings it into the left pane: the history is a way in, not a list
// that is read once and then only displayed.
FIXTURES['homepage/pluginAuditStatus'] = auditFixture('unsafe', {
  auditId: 'audit-old', verdict: 'unsafe', summary: 'Exfiltrates credentials.',
})
buttons(auditPane, t('pluginAudit.history.view'))[2].props.onClick()
tree = await settle(main.render, { t })
auditPane = byClass(tree, 'ph-focus-card')[0]
const openedCalls = calls.filter((entry) => entry.endpoint === 'homepage/pluginAuditStatus')
assert.deepEqual(openedCalls[openedCalls.length - 1].payload.args, { options: { auditId: 'audit-old' } },
  'opening a record reads that record')
assert.ok(text(auditPane).includes(t('pluginAudit.state.unsafe')), 'and the left pane shows it, got: ' + text(auditPane))
assert.equal(auditSnapshotCalls, 0, 'tab navigation must not wait for a full-page view-transition snapshot')
assert.equal(calls.filter((entry) => entry.endpoint === 'homepage/pluginAuditModels').length, catalogCallsBeforeTabs,
  'returning to Current reuses the loaded model catalog instead of rediscovering providers')
if (savedViewTransition === undefined) delete globalThis.document.startViewTransition
else globalThis.document.startViewTransition = savedViewTransition

// Leave the card as the rest of the file expects to find it: no notice, no
// review, and no review fixtures behind the endpoints.
api.clearNotifications('plugin-audit')
api.close()
tree = await settle(main.render, { t })
FIXTURES['homepage/pluginAuditStatus'] = null
FIXTURES['homepage/pluginAuditList'] = { audits: [] }
delete FIXTURES['homepage/pluginAuditStart']
delete FIXTURES['homepage/pluginAuditDecide']

// ------------------------------------------------------ customization studio
byClass(tree, 'ph-customize-trigger')[0].props.onClick()
tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-studio').length, 1, 'customization opens from the toolbar')
assert.equal(byClass(tree, 'ph-studio-card-row').length, api.list().length, 'library lists every registered card')
const studioCardCount = byClass(tree, 'ph-cell').length
const selectedRow = byClass(tree, 'ph-studio-card-row').find(row => hasClass(row, 'is-selected'))
const selectedTitle = text(byClass(selectedRow, 'ph-studio-card-select')[0])
byClass(selectedRow, 'ph-studio-visibility')[0].props.onClick()
tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-cell').length, studioCardCount - 1, 'hiding removes one tile')
assert.equal(api.state().hidden.length, 1, 'visibility persists')
const styledId = api.state().hidden[0]
const findPattern = name => byClass(tree, 'ph-studio-pattern').find(node => node.props.title === t('studio.pattern.' + name))
findPattern('orbit').props.onClick()
tree = await settle(main.render, { t })
assert.equal(api.state().appearance[styledId].icon, 'orbit', 'a hidden card can be styled')
const rangeInputs = () => elements(byClass(tree, 'ph-studio-placement')[0]).filter(node => node.tag === 'input' && node.props.type === 'range')
rangeInputs()[0].props.onChange({ target: { value: '160' } })
tree = await settle(main.render, { t })
rangeInputs()[1].props.onChange({ target: { value: '18' } })
tree = await settle(main.render, { t })
rangeInputs()[2].props.onChange({ target: { value: '-35' } })
tree = await settle(main.render, { t })
rangeInputs()[3].props.onChange({ target: { value: '24' } })
tree = await settle(main.render, { t })
rangeInputs()[4].props.onChange({ target: { value: '-16' } })
tree = await settle(main.render, { t })
byClass(tree, 'ph-studio-anchor')[1].props.onClick()
tree = await settle(main.render, { t })
assert.equal(api.state().appearance[styledId].size, '160%')
assert.equal(api.state().appearance[styledId].opacity, .18)
assert.equal(api.state().appearance[styledId].rotate, -35)
assert.deepEqual(api.state().appearance[styledId].offset, [24, -16])
assert.equal(api.state().appearance[styledId].anchor, 'center')
// The fade is opt-in: its position slider is inert until the switch is on.
assert.equal(rangeInputs()[5].props.disabled, true, 'fade position is disabled while the fade is off')
const fadeSwitch = byClass(byClass(tree, 'ph-studio-placement')[0], 'ph-switch')[0]
fadeSwitch.props.onClick()
tree = await settle(main.render, { t })
assert.equal(api.state().appearance[styledId].fade, true, 'the fade switch persists its state')
assert.equal(rangeInputs()[5].props.disabled, false, 'fade position becomes available with the fade')
rangeInputs()[5].props.onChange({ target: { value: '70' } })
tree = await settle(main.render, { t })
assert.equal(api.state().appearance[styledId].fadePosition, 70, 'fade position persists')
byClass(tree, 'ph-studio-blend-option').find(node => node.props.title === t('studio.blend.luminosity')).props.onClick()
tree = await settle(main.render, { t })
assert.equal(api.state().appearance[styledId].blend, 'luminosity', 'the blend mode persists')
await sleep(400)
const studioSave = calls.filter(call => call.endpoint === 'homepage/saveState').pop()
assert.equal(studioSave.payload.args.patch.appearance[styledId].icon, 'orbit', 'artwork travels through the save endpoint')
assert.equal(studioSave.payload.args.patch.appearance[styledId].fade, true, 'the fade travels through the save endpoint')
assert.equal(studioSave.payload.args.patch.appearance[styledId].fadePosition, 70, 'the fade position travels through the save endpoint')
assert.equal(studioSave.payload.args.patch.appearance[styledId].blend, 'luminosity', 'the blend mode travels through the save endpoint')
assert.deepEqual(studioSave.payload.args.patch.hidden, [styledId], 'visibility travels through the save endpoint')
const imageInput = elements(tree).find(node => node.tag === 'input' && node.props.type === 'file')
imageInput.props.onChange({ target: { files: [{ type: 'text/html', size: 10 }], value: 'bad.html' } })
tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-studio-error').length, 1, 'unsupported image files show an actionable error')
imageInput.props.onChange({ target: { files: [{ type: 'image/png', size: 513 * 1024 }], value: 'large.png' } })
tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-studio-error').length, 1, 'oversized images are rejected')
const PreviousFileReader = globalThis.FileReader
globalThis.FileReader = class { readAsDataURL() { this.result = 'data:image/png;base64,aGVsbG8='; this.onload() } }
elements(tree).find(node => node.tag === 'input' && node.props.type === 'file').props.onChange({ target: { files: [{ type: 'image/png', size: 10 }], value: 'valid.png' } })
tree = await settle(main.render, { t })
assert.equal(api.state().appearance[styledId].image, 'data:image/png;base64,aGVsbG8=', 'valid images become persistent artwork')
assert.equal(byClass(tree, 'ph-studio-error').length, 0, 'a valid import clears the error')
let pendingImageReader
globalThis.FileReader = class { readAsDataURL() { pendingImageReader = this } }
elements(tree).find(node => node.tag === 'input' && node.props.type === 'file').props.onChange({ target: { files: [{ type: 'image/png', size: 10 }], value: 'pending.png' } })
findPattern('waves').props.onClick()
tree = await settle(main.render, { t })
pendingImageReader.result = 'data:image/png;base64,bGF0ZQ=='
pendingImageReader.onload()
assert.equal(api.state().appearance[styledId].icon, 'waves', 'late image reads cannot overwrite newer artwork choices')
assert.equal(api.state().appearance[styledId].image, '', 'late image reads cannot reinstate a removed image')
if (PreviousFileReader === undefined) delete globalThis.FileReader
else globalThis.FileReader = PreviousFileReader
findPattern('orbit').props.onClick()
tree = await settle(main.render, { t })
dumpPreview(tree, '19-customization-studio')
byClass(tree, 'ph-studio-card-row').find(row => hasClass(row, 'is-selected')).props.children[1].props.onClick()
tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-cell').length, studioCardCount, 'add restores hidden card')
assert.equal(api.state().hidden.length, 0)
const restoredTile = byClass(tree, 'ph-cell').find(cell => cell.props['data-card-cell'] === styledId)
assert.ok(byClass(restoredTile, 'ph-tex--center').length, 'tile uses customized placement')
api.open(styledId)
tree = await settle(main.render, { t })
assert.ok(byClass(byClass(tree, 'ph-focus-card')[0], 'ph-tex--center').length, 'expanded card uses the same artwork')
assert.equal(byClass(tree, 'ph-studio').length, 0, 'expanding exits the scrolling studio and restores the full focus stage')
api.close()
tree = await settle(main.render, { t })
byClass(tree, 'ph-customize-trigger')[0].props.onClick()
tree = await settle(main.render, { t })
findPattern('none').props.onClick()
tree = await settle(main.render, { t })
assert.equal(api.state().appearance[styledId], null, 'none persists an explicit null')
assert.equal(byClass(byClass(tree, 'ph-studio-preview')[0], 'ph-tex').length, 0, 'none removes the artwork')
findPattern('default').props.onClick()
tree = await settle(main.render, { t })
assert.equal(Object.hasOwn(api.state().appearance, styledId), false, 'default removes the override')
const rowsBeforeHideAll = byClass(tree, 'ph-studio-card-row')
for (const row of rowsBeforeHideAll) byClass(row, 'ph-studio-visibility')[0].props.onClick()
tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-cell').length, 0)
assert.equal(byClass(tree, 'ph-hidden-empty').length, 1, 'all-hidden state provides a recovery action')
byClass(tree, 'ph-studio-text-button').find(node => text(node) === t('studio.showAll')).props.onClick()
tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-cell').length, studioCardCount)
byClass(tree, 'ph-studio-card-select').find(node => text(node) === t('project.title')).props.onClick()
tree = await settle(main.render, { t })
assert.equal(rangeInputs()[0].props.value, 118, 'registered pixel artwork keeps its displayed size')
assert.equal(rangeInputs()[0].props.max, 512, 'pixel-sized artwork uses a pixel range')
rangeInputs()[0].props.onChange({ target: { value: '140' } })
tree = await settle(main.render, { t })
assert.equal(api.state().appearance.projects.size, 140, 'adjusting pixel size does not reinterpret it as a percentage')
findPattern('default').props.onClick()
tree = await settle(main.render, { t })
byClass(tree, 'ph-studio-icon-button')[0].props.onClick()
tree = await settle(main.render, { t })
assert.equal(byClass(tree, 'ph-studio').length, 0, 'studio closes without changing the wall')
assert.ok(selectedTitle)

// --- the DSH card when the upstream cannot be read --------------------------
// "读不到" must not be the whole message: the card has to say that the network
// failed, and "无" must not be used for a root it never identified. This is the
// exact signature users reported, so it is pinned here rather than inferred.
const dshOriginal = FIXTURES['homepage/dsh']
const dshCheckOriginal = FIXTURES['homepage/dshCheck']
const dshLocalOriginal = FIXTURES['homepage/dshLocal']
const dshFailure = {
  at: DSH_FIXTURE.at,
  sampleSeconds: 1,
  repo: 'deepseek-ai/deepseek-harness',
  branch: 'master',
  head: null,
  commits: [],
  release: null,
  releases: [],
  routes: { commits: 'error', releases: 'error', head: null },
  cached: false,
  reason: 'network',
  error: null,
}
FIXTURES['homepage/dsh'] = dshFailure
FIXTURES['homepage/dshCheck'] = dshFailure
FIXTURES['homepage/dshLocal'] = { root: '', running: '', install: { kind: 'source', version: null }, versions: [] }
api.close()
tree = await settle(main.render, { t })
api.open('dsh')
tree = await settle(main.render, { t })
const dshFailurePane = byClass(tree, 'ph-focus-card')[0]
const dshFailureText = text(dshFailurePane)
assert.ok(dshFailureText.includes(t('dsh.reason.network')),
  'a failed upstream must name the network, not just say unreadable, got: ' + dshFailureText)
assert.ok(dshFailureText.includes(t('dsh.state.offline')),
  'the card must say the upstream is out of reach, got: ' + dshFailureText)
assert.ok(dshFailureText.includes(t('dsh.needRoot')),
  'an unidentified root must be explained in the detail, got: ' + dshFailureText)

// Refresh from the detail so both halves re-read the failure fixture, then
// close it: the compact preview is what a user sees on the wall.
const dshFailureCaret = elements(tree).find((node) => hasClass(node, 'ph-combo-caret'))
dshFailureCaret.props.onClick()
tree = await settle(main.render, { t })
const dshFailureRefresh = elements(tree).find((node) => hasClass(node, 'ph-combo-item') && textOf(node).trim() === t('common.refresh'))
dshFailureRefresh.props.onClick()
tree = await settle(main.render, { t })
api.close()
tree = await settle(main.render, { t })
const dshFailureCell = byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'dsh')
const dshFailurePreview = text(dshFailureCell)
// The preview is the surface that was reported as broken: a network that
// cannot reach GitHub is a state of the machine, so it is a muted reading and
// a chip — never a red row that looks like a fault in the plugin.
const dshFailureRow = byClass(dshFailureCell, 'ph-spec')
  .find((spec) => textOf(byClass(spec, 'ph-spec-name')[0]).trim() === t('dsh.row.upstream'))
assert.ok(dshFailureRow, 'the preview must still have an upstream row')
assert.equal(byClass(dshFailureRow, 'ph-spec-value')[0].props.title, t('dsh.reason.network'),
  'the preview must say why the upstream is unreadable')
assert.equal(byClass(dshFailureCell, 'ph-spec-value--error').length, 0,
  'a failed read is not painted as an error')
assert.ok(byClass(dshFailureCell, 'ph-spec-value--muted').length >= 1,
  'the unreadable reading is muted, not loud')
assert.ok(byClass(dshFailureCell, 'ph-chip--warn').some((node) => textOf(node).trim() === t('dsh.state.offline')),
  'the preview states the upstream is unreachable')
assert.ok(byClass(dshFailureCell, 'ph-link').some((node) => textOf(node).trim() === t('dsh.retry')),
  'the preview offers a retry instead of only a dead end')

FIXTURES['homepage/dsh'] = dshOriginal
FIXTURES['homepage/dshCheck'] = dshCheckOriginal
FIXTURES['homepage/dshLocal'] = dshLocalOriginal

// --- the local row is the RUNNING core, not the newest directory on disk ----
// The wall lists every build under the root. Calling the newest one "current"
// would be a lie while this page is served by an older checkout, so the Host
// says which directory it was started from and the card must follow it.
const dshRunningLocal = Object.assign({}, DSH_LOCAL_FIXTURE, {
  running: DSH_LOCAL_FIXTURE.versions[1].dir,
})
FIXTURES['homepage/dsh'] = DSH_FIXTURE
FIXTURES['homepage/dshCheck'] = DSH_FIXTURE
FIXTURES['homepage/dshLocal'] = dshRunningLocal
api.close()
tree = await settle(main.render, { t })
api.open('dsh')
tree = await settle(main.render, { t })
const runningCaret = elements(tree).find((node) => hasClass(node, 'ph-combo-caret'))
runningCaret.props.onClick()
tree = await settle(main.render, { t })
const runningRefresh = elements(tree).find((node) => hasClass(node, 'ph-combo-item') && textOf(node).trim() === t('common.refresh'))
runningRefresh.props.onClick()
tree = await settle(main.render, { t })
const runningPane = byClass(tree, 'ph-focus-card')[0]
assert.equal(
  byClass(runningPane, 'ph-chip').filter((node) => textOf(node).trim() === t('dsh.runningChip')).length,
  1,
  'the expanded list marks exactly the running core',
)
api.close()
tree = await settle(main.render, { t })
const runningCell = byClass(tree, 'ph-cell').find((cell) => cell.props['data-card-cell'] === 'dsh')
const runningSpec = byClass(runningCell, 'ph-spec')
  .find((spec) => textOf(byClass(spec, 'ph-spec-name')[0]).trim() === t('dsh.row.local'))
assert.equal(textOf(byClass(runningSpec, 'ph-spec-value')[0]).trim(), '5719020',
  'the local row names the running checkout, not the newest one on disk')

FIXTURES['homepage/dsh'] = dshOriginal
FIXTURES['homepage/dshCheck'] = dshCheckOriginal
FIXTURES['homepage/dshLocal'] = dshLocalOriginal

// --- a packaged Desktop is running, not a local build -----------------------
// The card must show the running Desktop version, say that this surface manages
// local builds, and state that installing here does NOT update the Desktop app.
const dshDesktopLocal = {
  root: '',
  running: '',
  versions: [{
    version: '0.2.1-alpha.4', name: 'DeepSeek Harness (Desktop)', kind: 'desktop',
    dir: null, sha: null, short: null, commitDate: null, branch: null,
    tag: 'dsh-v0.2.1-alpha.4', tags: [], remote: null, shallow: false,
    exists: true, hasSource: false, hasDeps: false, hasBuild: true, complete: true,
    updatedAt: null, isCore: true,
  }],
}
FIXTURES['homepage/dsh'] = DSH_FIXTURE
FIXTURES['homepage/dshCheck'] = DSH_FIXTURE
FIXTURES['homepage/dshLocal'] = dshDesktopLocal
api.close()
tree = await settle(main.render, { t })
api.open('dsh')
tree = await settle(main.render, { t })
const desktopCaret = elements(tree).find((node) => hasClass(node, 'ph-combo-caret'))
desktopCaret.props.onClick()
tree = await settle(main.render, { t })
const desktopRefresh = elements(tree).find((node) => hasClass(node, 'ph-combo-item') && textOf(node).trim() === t('common.refresh'))
desktopRefresh.props.onClick()
tree = await settle(main.render, { t })
const desktopPane = byClass(tree, 'ph-focus-card')[0]
const desktopText = text(desktopPane)
assert.ok(desktopText.includes('v0.2.1-alpha.4'),
  'the local section shows the running Desktop version, got: ' + desktopText)
assert.ok(desktopText.includes(t('dsh.scope.packaged', { version: 'v0.2.1-alpha.4' })),
  'a Desktop run must be told that the card does not apply to it, got: ' + desktopText)
assert.ok(desktopText.includes(t('dsh.note.local')),
  'a Desktop run must explain that installing creates a local build, got: ' + desktopText)
assert.equal(byClass(desktopPane, 'ph-tool').length, 0,
  'the Desktop core is not counted as a local build')
assert.ok(desktopText.includes(t('dsh.install.local', { version: DSH_FIXTURE.release.name })),
  'the install action says it creates a local build, got: ' + desktopText)
assert.ok(!desktopText.includes(t('dsh.state.current')),
  'a packaged build must never claim to be up to date')
api.close()
tree = await settle(main.render, { t })

FIXTURES['homepage/dsh'] = dshOriginal
FIXTURES['homepage/dshCheck'] = dshCheckOriginal
FIXTURES['homepage/dshLocal'] = dshLocalOriginal

// ------------------------------------------------------------- sidebar icon

const icon = settle(sidebar.render, { size: 18, active: true })
const iconTree = await icon
assert.ok(text(iconTree) !== undefined, 'the sidebar icon must render')
assert.ok(elements(iconTree).length >= 1, 'the sidebar icon must be a real element')

// --------------------------------------------------------------------- report

assert.ok(cleanupLabels.includes('dsh-homepage: dictionaries'), 'the dictionaries must be owned by ctx.effect')
assert.ok(calls.filter((call) => call.channel === '/api').length === calls.length, 'every call must go over /api')
assert.ok(calls.every((call) => call.endpoint.startsWith('homepage/')), 'every endpoint must live in the homepage namespace')

console.log('smoke-client: all assertions passed')
console.log('  registrations : ' + registrations.map((entry) => entry.slotName).join(', '))
console.log('  endpoints     : ' + [...new Set(calls.map((call) => call.endpoint))].join(', '))
console.log('  dictionary    : ' + zhKeys.length + ' keys (zh/en balanced)')
console.log('  styles        : ' + module_.STYLES.length + ' bytes of framework CSS')

// The shim never unmounts, so the intervals the cards arm (useClock, useRemote)
// keep the loop alive. React would clear them through the effect cleanup; here
// the run is over, so exit explicitly.
process.exit(0)
