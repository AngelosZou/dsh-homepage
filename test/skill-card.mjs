/**
 * skill-card: the Skills card's OWN behavioural coverage.
 *
 * `test/smoke-client.mjs` proves the framework contract around the card — that
 * it registers, that the endpoint fixtures exist, that the wall draws its
 * preview. This file is the card's own test: it renders the card's two entry
 * points (the compact preview and the expanded page) through the same mini-React
 * shim the house harness uses, drives every control a user can touch, and
 * asserts what the host was sent and what came back on screen.
 *
 * Nothing here reaches a real host, a real file or the network. The card is a
 * pure function of the documents the fake transport answers with, which is what
 * makes the reading, the filtering, the two panes and the error paths testable
 * without a browser.
 *
 * The bundle is loaded the way the browser loads it — `lib/client.js` is read as
 * TEXT and evaluated with `new Function(source)()` — because it legitimately
 * names `module`/`exports` and Node's module-format detection would mangle it.
 * The React object is the harness's own shim; the UI primitives come from
 * test/ui-primitives-stub.mjs, so there is no installed 'react' to import.
 *
 * Run: node test/skill-card.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createUiPrimitives } from './ui-primitives-stub.mjs'

// ---------------------------------------------------------------- counting
//
// Every check goes through one of these so the run can report how much of the
// card it actually exercised, and so a failure still comes from node:assert.

let checks = 0
const ok = (value, message) => { checks += 1; assert.ok(value, message) }
const is = (actual, expected, message) => { checks += 1; assert.equal(actual, expected, message) }
const same = (actual, expected, message) => { checks += 1; assert.deepEqual(actual, expected, message) }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------------------ React shim
//
// Same shape as test/smoke-client.mjs: function components run eagerly, hooks
// live in per-path slots, and `settle` renders until no state update is pending.
// The one addition is that a render root is passed in, so the preview and the
// expanded page can be mounted side by side without sharing hook slots.

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
    createRoot() { throw new Error('test/skill-card.mjs has no DOM root: the bundle is evaluated, not mounted') },
    hydrateRoot() { throw new Error('test/skill-card.mjs has no DOM root: the bundle is evaluated, not mounted') },
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

/**
 * Mount one card entry point on its own render root, so two mounts never share
 * hook slots (the shim keys instances by their path inside the root).
 * @param component - the card's `content` or `detail` function.
 * @returns `{ render(props) }` — render settles the tree and returns it.
 */
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

/**
 * The row's invocation-mode switcher — the framework's `ComboButton`, whose menu
 * renders into the panel's fixed popover layer instead of inside the row. That
 * separation is the fix for the clipped menu: a menu positioned inside the row
 * lived inside the expanding body's `overflow:auto` scroller and was cut off.
 *
 * The menu is drawn by the framework's own `PopoverLayer`, which these tests do
 * not mount, so the menu is asserted through the `options` the switcher is given
 * (value, label, hint) and the write is driven through `onChange` — the same
 * function a real click on a menu item calls.
 */
const comboOf = (tree) => byClass(tree, 'ph-combo')[0]

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
// The argument shape every endpoint demands, taken from the Host half's real
// Typert descriptors. This is the contract the live gateway enforces
// (packages/api/gateway/src/index.ts `assertExactArguments`): a client that
// sends a field the descriptor does not declare gets
//   "args fields do not match the descriptor: unexpected ..."
// and the card renders an error instead of data. Local fixtures ignore the
// arguments, so without this check a card that sends the wrong field names
// passes here and fails only in the browser.

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

const SKILL_ENDPOINTS = [
  'homepage/skillList', 'homepage/skillSetEnabled', 'homepage/skillSources',
  'homepage/skillSearch', 'homepage/skillDetail', 'homepage/skillInstall',
  'homepage/skillContent',
]
for (const id of SKILL_ENDPOINTS) {
  ok(Object.prototype.hasOwnProperty.call(DESCRIPTOR_PARAMS, id),
    'the host descriptors must declare ' + id + ', otherwise the argument guard below is vacuous')
}
// The frozen contract (搂3) says every skill endpoint takes exactly the one
// `options` object, and the card sends nothing else. Asserted up front, because a
// descriptor that disagrees makes the live gateway answer
// "args fields do not match the descriptor" and the card renders an error
// instead of data — a failure that belongs to the endpoint, not to a pane.
for (const id of SKILL_ENDPOINTS) {
  same((DESCRIPTOR_PARAMS[id] || []).slice().sort(), ['options'],
    id + ' must declare the one options object the card sends')
}
const GUARD_PARAMS = DESCRIPTOR_PARAMS

// ------------------------------------------------------------------- fixtures

const TRANSPORT_FAILURE = Symbol('a failed transport')
const DEFERRED = Symbol('a call that has not answered yet')

const USER_ROOT = 'C:\\Users\\me\\.dsh\\skills'
const AGENTS_ROOT = 'C:\\Users\\me\\.agents\\skills'
const BUNDLED_ROOT = 'D:\\tools\\DSH\\app\\skills'

/** @returns one `skillList` entry with the fields the pane reads. */
function listSkill(overrides) {
  return Object.assign({
    description: '',
    whenToUse: null,
    source: 'user-dsh',
    provider: 'filesystem',
    path: null,
    dir: null,
    kind: 'bundle',
    modelInvocable: true,
    userInvocable: true,
    writable: true,
    shadowedBy: null,
    note: null,
  }, overrides || {})
}

const USER_DHS_ROOT = { id: 'user-dsh', path: USER_ROOT, source: 'user-dsh', rank: 400, label: null, writable: true, exists: true, count: 0 }
const USER_AGENTS_ROOT = { id: 'user-agents', path: AGENTS_ROOT, source: 'user-agents', rank: 500, label: null, writable: true, exists: true, count: 0 }
const BUNDLED_ROOT_ENTRY = { id: 'bundled', path: BUNDLED_ROOT, source: 'bundled', rank: 600, label: null, writable: false, exists: true, count: 0 }

// The wall reading: six skills, four of them in the model catalog, one kept for
// manual use only, one switched off — the split the preview has to read out.
const PREVIEW_SKILLS = [
  listSkill({ name: 'pdf-tools', description: 'Extract text and tables from PDF files.', path: USER_ROOT + '\\pdf-tools\\SKILL.md' }),
  listSkill({ name: 'writing-guard', description: 'Polish punctuation and tone in drafts.', source: 'user-agents', path: AGENTS_ROOT + '\\writing-guard\\SKILL.md' }),
  listSkill({ name: 'code-review', description: 'Review a diff before it lands.', path: USER_ROOT + '\\code-review\\SKILL.md' }),
  listSkill({ name: 'xlsx', description: 'Work with spreadsheets.', source: 'user-agents', path: AGENTS_ROOT + '\\xlsx\\SKILL.md' }),
  listSkill({ name: 'old-notes', modelInvocable: false, userInvocable: true, description: 'Kept for the occasional manual run.' }),
  listSkill({ name: 'comfyui', modelInvocable: false, userInvocable: false, description: 'Switched off entirely.' }),
]

const PREVIEW_DOC = {
  generatedAt: 1792000000000,
  dshHome: 'C:\\Users\\me\\.dsh',
  agentsHome: 'C:\\Users\\me\\.agents',
  bundledDir: BUNDLED_ROOT,
  roots: [
    Object.assign({}, USER_DHS_ROOT, { count: 5 }),
    Object.assign({}, BUNDLED_ROOT_ENTRY, { count: 1 }),
  ],
  skills: PREVIEW_SKILLS,
  duplicates: [{ name: 'writing-guard', winner: 'user-agents', losers: ['bundled'] }],
  counts: { total: 6, enabled: 4, userOnly: 1, disabled: 1, writable: 5, invalid: 0 },
  warnings: [],
}

// The same document with one state at zero: a state nobody is in earns neither a
// scale segment nor a legend entry.
const SPARSE_DOC = {
  generatedAt: 1792000000000,
  dshHome: 'C:\\Users\\me\\.dsh',
  agentsHome: 'C:\\Users\\me\\.agents',
  bundledDir: null,
  roots: [Object.assign({}, USER_DHS_ROOT, { count: 2 })],
  skills: [
    listSkill({ name: 'pdf-tools', description: 'Extract text from PDF files.' }),
    listSkill({ name: 'xlsx', description: 'Work with spreadsheets.' }),
  ],
  duplicates: [],
  counts: { total: 2, enabled: 2, userOnly: 0, disabled: 0, writable: 2, invalid: 0 },
  warnings: [],
}

const EMPTY_DOC = {
  generatedAt: 1792000000000,
  dshHome: 'C:\\Users\\me\\.dsh',
  agentsHome: 'C:\\Users\\me\\.agents',
  bundledDir: null,
  roots: [],
  skills: [],
  duplicates: [],
  counts: { total: 0, enabled: 0, userOnly: 0, disabled: 0, writable: 0, invalid: 0 },
  warnings: [],
}

const WARN_DOC = Object.assign({}, PREVIEW_DOC, {
  warnings: [AGENTS_ROOT + ': EPERM: operation not permitted'],
})

// The expanded page's catalog: every state, every flag, and one skill that is
// not this plugin's to write.
const LIST_DOC = {
  generatedAt: 1792000000000,
  dshHome: 'C:\\Users\\me\\.dsh',
  agentsHome: 'C:\\Users\\me\\.agents',
  bundledDir: BUNDLED_ROOT,
  roots: [
    Object.assign({}, USER_DHS_ROOT, { count: 2 }),
    Object.assign({}, USER_AGENTS_ROOT, { count: 2 }),
    Object.assign({}, BUNDLED_ROOT_ENTRY, { count: 1 }),
  ],
  skills: [
    listSkill({
      name: 'pdf-tools',
      description: 'Extract text and tables from PDF files.',
      whenToUse: 'when the user attaches a scanned document',
      path: USER_ROOT + '\\pdf-tools\\SKILL.md',
      dir: USER_ROOT + '\\pdf-tools',
    }),
    listSkill({
      name: 'writing-guard',
      description: 'Polish punctuation and tone in drafts.',
      source: 'user-agents',
      modelInvocable: false,
      userInvocable: true,
      path: AGENTS_ROOT + '\\writing-guard\\SKILL.md',
    }),
    listSkill({
      name: 'comfyui',
      description: 'Drive an image generation server.',
      whenToUse: 'when a workflow must be rendered',
      modelInvocable: false,
      userInvocable: false,
      path: USER_ROOT + '\\comfyui\\SKILL.md',
    }),
    listSkill({
      name: 'bundled-helper',
      description: 'A read-only bundled skill.',
      source: 'bundled',
      path: BUNDLED_ROOT + '\\bundled-helper\\SKILL.md',
      writable: false,
    }),
    listSkill({
      name: 'broken-skill',
      description: 'A skill whose frontmatter is incomplete.',
      source: 'user-agents',
      modelInvocable: false,
      userInvocable: false,
      path: AGENTS_ROOT + '\\broken-skill\\SKILL.md',
      note: 'frontmatter-invalid',
    }),
  ],
  duplicates: [{ name: 'writing-guard', winner: 'user-agents', losers: ['bundled'] }],
  counts: { total: 5, enabled: 2, userOnly: 1, disabled: 2, writable: 4, invalid: 1 },
  warnings: [],
}

const SOURCES_DOC = {
  generatedAt: 1792000000000,
  sources: [
    {
      id: 'clawhub', label: 'ClawHub', kind: 'registry',
      home: 'https://clawhub.ai', docs: 'https://docs.openclaw.ai/clawhub/api',
      reachable: true, note: null, count: null,
    },
    {
      id: 'github', label: 'GitHub', kind: 'git',
      home: 'https://github.com/anthropics/skills', docs: null,
      reachable: false, note: 'HTTP 403', count: null,
    },
  ],
}

const SEARCH_RESULTS = [
  {
    id: 'clawhub:awspace/pdf', source: 'clawhub', name: 'pdf', displayName: 'Pdf',
    summary: 'Read and fill PDF forms.', owner: 'awspace', version: '1.0.0',
    updatedAt: null, downloads: 50605, stars: 66,
    url: 'https://clawhub.ai/awspace/skills/pdf', skillUrl: null,
    install: { kind: 'clawhub', ref: 'awspace/pdf', url: null },
  },
  {
    id: 'clawhub:local/pdf-tools', source: 'clawhub', name: 'pdf-tools', displayName: 'Pdf Tools',
    summary: 'Extract text and tables.', owner: 'local', version: '2.0.0',
    updatedAt: null, downloads: 12, stars: 0,
    url: 'https://clawhub.ai/local/skills/pdf-tools', skillUrl: null,
    install: { kind: 'clawhub', ref: 'local/pdf-tools', url: null },
  },
  {
    id: 'github:anthropics/skills/xlsx', source: 'github', name: 'xlsx', displayName: 'Xlsx',
    summary: 'Spreadsheet work.', owner: 'anthropics', version: null,
    updatedAt: null, downloads: null, stars: null,
    url: 'https://github.com/anthropics/skills/tree/main/xlsx', skillUrl: null,
    install: { kind: 'github', ref: 'anthropics/skills/xlsx', url: null },
  },
]

const SEARCH_DOC = {
  query: 'pdf',
  searchedAt: 1792000000000,
  source: 'clawhub',
  results: SEARCH_RESULTS,
  failures: [],
  truncated: false,
}

// The edge the pane has to be honest about: one source of several did not
// answer, and there is more than one batch of hits.
const SEARCH_EDGE_DOC = {
  query: 'xlsx',
  searchedAt: 1792000000000,
  source: 'all',
  results: [SEARCH_RESULTS[2]],
  failures: [{ source: 'skillhub', message: 'HTTP 502' }],
  truncated: true,
}

const INSTALL_DOC = {
  ok: true,
  name: 'pdf',
  source: 'clawhub',
  ref: 'awspace/pdf',
  root: USER_ROOT,
  dir: USER_ROOT + '\\pdf',
  files: 3,
  bytes: 18422,
  skill: listSkill({ name: 'pdf', description: 'Read and fill PDF forms.' }),
  counts: { total: 6, enabled: 3, userOnly: 1, disabled: 2, writable: 5, invalid: 1 },
}

const FIXTURES = {
  'homepage/skillList': PREVIEW_DOC,
  'homepage/skillSetEnabled': { ok: true, name: 'pdf-tools', mode: 'on', counts: LIST_DOC.counts, skills: LIST_DOC.skills },
  'homepage/skillSources': SOURCES_DOC,
  'homepage/skillSearch': SEARCH_DOC,
  'homepage/skillDetail': { id: 'clawhub:awspace/pdf', source: 'clawhub', name: 'pdf', version: '1.0.0', summary: 'Read and fill PDF forms.', readme: null, files: ['SKILL.md'], skillMd: null, install: { kind: 'clawhub', ref: 'awspace/pdf', url: null } },
  'homepage/skillInstall': INSTALL_DOC,
}

// ------------------------------------------------------------------- mock ctx

const calls = []
const deferred = []
let dictionaries = null
let injectKey = null

/** @returns the answer the live gateway would give for a mismatched args shape. */
function signatureError(endpoint, got) {
  return {
    ok: false,
    error: { message: 'typert gateway: ' + endpoint + ': args fields do not match the descriptor: unexpected "' + got + '"' },
  }
}

function fakeCall(channel, endpoint, payload) {
  calls.push({ channel, endpoint, payload })
  const declared = GUARD_PARAMS[endpoint]
  if (declared) {
    const args = (payload && payload.args) || {}
    const got = Object.keys(args).sort().join(',')
    const want = declared.slice().sort().join(',')
    if (got !== want) return Promise.resolve(signatureError(endpoint, got))
  }
  const value = FIXTURES[endpoint]
  if (value === TRANSPORT_FAILURE) {
    return Promise.resolve({ ok: false, error: { message: 'transport failure for /api/' + endpoint + ': HTTP 404' } })
  }
  if (value === DEFERRED) return new Promise((resolve) => { deferred.push({ endpoint, payload, resolve }) })
  if (value === undefined) return Promise.resolve({ ok: false, error: { message: 'no fixture for ' + endpoint } })
  return Promise.resolve({ ok: true, value })
}

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
  connection: { rpc: { call: fakeCall } },
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

// The card module captures `kit.runtime` as an object, so replacing one property
// on the module's own runtime object is enough to see the sheet it registers,
// and to prove it registers it once for the lifetime of the panel. The spy is
// installed AFTER apply, because apply is what wires the runtime's own
// `insertCss` onto that object.
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
const api = surface.cardApi('skill')
const card = surface.get('skill')
ok(card, 'the shipped registry must hold the skill card')
ok(api, 'the card must expose its api')
is(card.id, 'skill', 'the card id must be the one the contract names')
is(card.shipped, true, 'the skill card ships with the plugin')
is(card.subtitle, null,
  'the card registers no subtitle: the wall tile and the expanded pane header already name it')

// --- the copy pass removed the keys it stopped rendering ---------------------
//
// A stale key is invisible in the UI but keeps a dead string alive in both
// dictionaries; the copy pass is only done when the keys went with the markup.

same(Object.keys(card.dict.zh).sort(), Object.keys(card.dict.en).sort(),
  'zh and en dictionaries must have identical key sets')
for (const key of [
  'card.skill.subtitle',
  'skill.page.title',
  'skill.page.sub',
  'skill.library.showing',
  'skill.library.footnote',
]) {
  is(card.dict.zh[key], undefined, 'the zh dictionary drops the retired key ' + key)
  is(card.dict.en[key], undefined, 'the en dictionary drops the retired key ' + key)
}

const t = (key, params) => mockCtx.locale.bind('homepage')(key, params)

// The one control the two surfaces share. The wall's preview and the expanded
// page are separate instances, and `skillSignal` is how a flip or a landed
// install reaches the preview — so the control has to be DECLARED: the
// framework's `cardApi.control()` only answers for an action the card
// registered, and an undeclared id reads null while `setControl` is a silent
// no-op. (It is also the only second read the preview ever makes, which is what
// makes the two-failure error notice reachable at all.)
const SIGNAL = 'skillSignal'
const cardControls = card.detailActions
ok(Array.isArray(cardControls), 'the card record must carry its declared detail controls')
ok(cardControls.some((action) => action.id === SIGNAL),
  'the card must declare the shared signal control it reads and writes')

const listCalls = () => calls.filter((call) => call.endpoint === 'homepage/skillList').length
const callsTo = (endpoint) => calls.filter((call) => call.endpoint === endpoint)
const lastCall = (endpoint) => callsTo(endpoint)[callsTo(endpoint).length - 1]
const notifications = () => surface.snapshot().notifications.skill || []
const rowNamed = (tree, name) => byClass(tree, 'ph-sk-row')
  .find((row) => textOf(byClass(row, 'ph-sk-name')[0]) === name)
const pillFor = (tree, label) => byClass(tree, 'ph-sk-pill')
  .find((pill) => textOf(pill).startsWith(label))
const buttonWith = (tree, label) => buttonLikes(tree)
  .find((node) => textOf(node).includes(label))
const hitNamed = (tree, name) => byClass(tree, 'ph-sk-hit')
  .find((hit) => textOf(byClass(hit, 'ph-sk-hit-name')[0]) === name)

/** Answer the oldest pending call to one endpoint. */
function release(endpoint, value) {
  const at = deferred.findIndex((entry) => entry.endpoint === endpoint)
  assert.ok(at >= 0, 'no pending call for ' + endpoint)
  const [entry] = deferred.splice(at, 1)
  entry.resolve({ ok: true, value })
}

// ============================================================ the wall reading

// --- the split reading: 6 installed, 4 in the catalog, 1 manual, 1 off --------

FIXTURES['homepage/skillList'] = PREVIEW_DOC
const preview = stage(card.content)
let previewTree = await preview.render(api)

ok(byClass(previewTree, 'ph-sk-preview').length >= 1, 'the preview must render its own body')
const bigRead = byClass(previewTree, 'ph-sk-big')
is(bigRead.length, 1, 'the preview leads with one number')
is(textOf(bigRead[0]), '6', 'the number is every local skill the host counted')
ok(textOf(byClass(previewTree, 'ph-sk-preview')[0]).includes(t('skill.preview.unit')),
  'the number must be named a local-skill count, not left bare')

const scale = byClass(previewTree, 'ph-sk-scale')
is(scale.length, 1, 'the reading carries one scale')
same(scale[0].props.children.map((segment) => segment.props.className), ['is-on', 'is-user', 'is-off'],
  'one segment per non-zero state, in the order the scale reads')
same(scale[0].props.children.map((segment) => segment.props.style.flex), ['4', '1', '1'],
  'each segment must be proportional to the state it stands for, not equal')
is(scale[0].props['aria-label'], t('skill.preview.scale'),
  'a scale drawn as bars must still say what it measures')

const legendEntries = byClass(previewTree, 'ph-sk-legend')[0].props.children
is(legendEntries.length, 3, 'every non-zero state earns a legend entry')
same(legendEntries.map((entry) => textOf(entry)),
  [t('skill.state.enabled') + ' 4', t('skill.state.userOnly') + ' 1', t('skill.state.disabled') + ' 1'],
  'the legend must carry the label and the count of each state')
same(byClass(previewTree, 'ph-sk-swatch').map((swatch) => swatch.props.className),
  ['ph-sk-swatch is-on', 'ph-sk-swatch is-user', 'ph-sk-swatch is-off'],
  'each legend entry gets the swatch of its own state')

const inUseChip = byClass(previewTree, 'ph-chip')
is(inUseChip.length, 1, 'the reading carries one chip')
ok(hasClass(inUseChip[0], 'ph-chip--ok'), 'a readable library is not a warning')
is(textOf(inUseChip[0]), t('skill.preview.inUse', { count: 4 }), 'the chip says how many reach the model')

is(byClass(previewTree, 'ph-sk-flag').length, 0, 'nothing invalid in this document')
is(byClass(previewTree, 'ph-sk-roots').length, 0,
  'the thumbnail must not print a user path')
ok(!textOf(previewTree).includes(USER_ROOT),
  'no user root reaches the thumbnail at all')
ok(!notifications().length, 'a readable library is not news and must raise no bubble')

// --- a state nobody is in earns no segment and no legend entry ---------------

FIXTURES['homepage/skillList'] = SPARSE_DOC
const sparse = stage(card.content)
const sparseTree = await sparse.render(api)
is(byClass(sparseTree, 'ph-sk-scale')[0].props.children.length, 1,
  'only the states with a count may draw a segment')
same(byClass(sparseTree, 'ph-sk-scale')[0].props.children.map((segment) => segment.props.style.flex), ['2'],
  'the lone segment carries the whole bar')
is(byClass(sparseTree, 'ph-sk-legend')[0].props.children.length, 1,
  'only the states with a count may draw a legend entry')
is(textOf(byClass(sparseTree, 'ph-sk-legend')[0].props.children[0]),
  t('skill.state.enabled') + ' 2', 'the one live state is named with its count')
ok(!text(byClass(sparseTree, 'ph-sk-legend')[0]).includes(t('skill.state.userOnly')),
  'a state at zero must not get a legend entry of its own')
ok(!text(byClass(sparseTree, 'ph-sk-legend')[0]).includes(t('skill.state.disabled')),
  'and neither must the other one')

// --- an empty machine reads as empty, and says so once -----------------------

FIXTURES['homepage/skillList'] = EMPTY_DOC
const empty = stage(card.content)
const emptyTree = await empty.render(api)
ok(!byClass(emptyTree, 'ph-sk-scale').length, 'an empty library has nothing to divide')
ok(text(emptyTree).includes(t('skill.preview.none')), 'an empty machine must say it is empty')
ok(text(emptyTree).includes(t('skill.preview.noneHint')), 'and say where a skill comes from')
ok(byClass(emptyTree, 'ph-sk-big')[0].props.className.includes('ph-sk-big-unit'),
  'the empty wording takes the hero slot rather than a number')
is(byClass(emptyTree, 'ph-sk-hero-row').length, 0, 'and there is no reading to divide')
const emptyNotices = notifications()
is(emptyNotices.length, 1, 'an empty library is announced exactly once')
is(emptyNotices[0].level, 'info', 'an empty library is information, not a warning')
is(emptyNotices[0].text, t('skill.notice.empty'), 'the notice reads as the dictionary wrote it')
surface.clearNotifications('skill')

// --- one unreadable root is a warning, raised once --------------------------

FIXTURES['homepage/skillList'] = WARN_DOC
const warned = stage(card.content)
let warnTree = await warned.render(api)
let warnNotices = notifications()
is(warnNotices.length, 1, 'a root that could not be read is worth one bubble')
is(warnNotices[0].level, 'warn', 'a partial read is a warning')
is(warnNotices[0].text, t('skill.notice.warned', { count: 1 }), 'the notice counts the roots that failed')
const warnNoticeId = warnNotices[0].id

warnTree = await warned.render(api)
warnNotices = notifications()
is(warnNotices.length, 1, 'a repeated reading must not stack a second bubble')
is(warnNotices[0].id, warnNoticeId, 'an unchanged condition must not be re-raised')
surface.clearNotifications('skill')

// --- one failed read is a hiccup; the failure that survives is an error ------

FIXTURES['homepage/skillList'] = TRANSPORT_FAILURE
const failed = stage(card.content)
let failedTree = await failed.render(api)
ok(!notifications().length, 'one failed read is a hiccup, not a notice')
ok(text(failedTree).includes('HTTP 404'), 'the card itself still reports the failure it saw')

// The second read is the retry: the card republishes its catalog through the
// one control both surfaces watch, and that is what a second failure arrives on.
api.setControl(SIGNAL, 'probe@1')
failedTree = await failed.render(api)
const failedNotices = notifications()
is(failedNotices.length, 1, 'a failure that survives the retry is worth a bubble')
is(failedNotices[0].level, 'error', 'a library nobody can read is an error')
is(failedNotices[0].text, t('skill.notice.failed', { reason: 'transport failure for /api/homepage/skillList: HTTP 404' }),
  'the notice carries the host\'s own reason')
ok(hasClass(byClass(failedTree, 'ph-chip')[0], 'ph-chip--error'),
  'and the reading itself is marked as the failure it is')
api.setControl(SIGNAL, '')
surface.clearNotifications('skill')

// ============================================================ the installed pane

FIXTURES['homepage/skillList'] = LIST_DOC
const detail = stage(card.detail)
let pane = await detail.render(api)

// --- the navigation bar ------------------------------------------------------

is(byClass(pane, 'ph-sk-nav').length, 1, 'the expanded page carries one navigation bar')
is(byClass(pane, 'ph-sk-nav')[0].props.role, 'tablist', 'the navigation bar is a tab list')
const tabs = byClass(pane, 'ph-sk-tab')
is(tabs.length, 2, 'two panes, two tabs')
ok(textOf(tabs[0]).startsWith(t('skill.tab.library')), 'the first tab is the installed library')
is(textOf(tabs[1]), t('skill.tab.discover'), 'the second tab is discovery')
is(tabs[0].props['aria-selected'], true, 'the installed pane is the default')
is(tabs[1].props['aria-selected'], false, 'discovery is not selected yet')
is(textOf(byClass(tabs[0], 'ph-sk-tab-count')[0]), '5', 'the installed tab carries the total count')
is(byClass(tabs[1], 'ph-sk-tab-count').length, 0, 'discovery has no local count to carry')
is(byClass(pane, 'ph-sk-page').length, 0,
  'the expanded page must not draw a second title block over the pane header')
is(byClass(pane, 'ph-sk-page-title').length, 0, 'and never repeats the card name')
is(byClass(pane, 'ph-sk-page-sub').length, 0, 'nor summarises the catalog in a sentence')
const pageShell = Array.isArray(pane.props.children) ? pane.props.children[0] : pane.props.children
ok(hasClass(pageShell.props.children[0], 'ph-sk-nav'),
  'the navigation bar is the page\'s first element instead of a title')

// --- the rows ----------------------------------------------------------------

is(byClass(pane, 'ph-sk-row').length, 5, 'every skill in the catalog gets a row')
ok(rowNamed(pane, 'pdf-tools'), 'the catalog is listed by name')
ok(text(rowNamed(pane, 'pdf-tools')).includes(t('skill.source.userDsh')),
  'a row names the root its skill came from')
ok(text(rowNamed(pane, 'comfyui')).includes(t('skill.source.userDsh')), 'the source label follows the skill')
ok(!text(rowNamed(pane, 'comfyui')).includes(t('skill.state.disabled')),
  'an off row does not repeat its state as a chip: the switch and mode label already say it')
is(byClass(rowNamed(pane, 'comfyui'), 'ph-sk-chip').length, 0,
  'the off row carries no state chip at all')
is(textOf(byClass(rowNamed(pane, 'comfyui'), 'ph-combo-main')[0]), t('skill.mode.off'),
  'the off state is read from the mode label, which is also the control')
ok(hasClass(rowNamed(pane, 'comfyui'), 'is-off'), 'an off row still reads as off at a glance')
is(byClass(rowNamed(pane, 'pdf-tools'), 'ph-sk-chip').length, 0,
  'an enabled row needs no chip: being on is the quiet default')
ok(text(rowNamed(pane, 'pdf-tools')).includes('Extract text and tables from PDF files.'),
  'the one-line description stays: it is how the row identifies the skill')
ok(!text(rowNamed(pane, 'pdf-tools')).includes('SKILL.md'),
  'the full filesystem path is not repeated in the row body; the opened page carries it')

// --- search: by name, by description, by whenToUse --------------------------

const setQuery = async (value) => {
  byClass(pane, 'ph-sk-input')[0].props.onChange({ target: { value: value } })
  pane = await detail.render(api)
}

await setQuery('writing')
is(byClass(pane, 'ph-sk-row').length, 1, 'a query matches the skill name')
ok(rowNamed(pane, 'writing-guard'), 'the named skill stays')
await setQuery('punctuation')
is(byClass(pane, 'ph-sk-row').length, 1, 'a query matches the description too')
ok(rowNamed(pane, 'writing-guard'), 'the described skill stays')
await setQuery('scanned document')
is(byClass(pane, 'ph-sk-row').length, 1, 'a query matches whenToUse too')
ok(rowNamed(pane, 'pdf-tools'), 'the skill whose whenToUse matched stays')
await setQuery('zzzzz')
is(byClass(pane, 'ph-sk-row').length, 0, 'a query nothing matches hides every row')
is(byClass(pane, 'ph-sk-empty').length, 1, 'and leaves an explanation instead of a blank')
ok(text(pane).includes(t('skill.library.noMatch')), 'the empty answer names the filter, not the machine')
is(byClass(pane, 'ph-sk-input')[0].props.value, 'zzzzz', 'the field keeps what was typed')
await setQuery('')
is(byClass(pane, 'ph-sk-row').length, 5, 'clearing the query brings every row back')
is(byClass(pane, 'ph-sk-empty').length, 0, 'and takes the empty answer away')
is(byClass(pane, 'ph-sk-count').length, 0,
  'the pane carries no "showing x of y" footer: the list and the tab count explain the scale')

// --- the state pills ---------------------------------------------------------

const pills = byClass(pane, 'ph-sk-pill')
is(pills.length, 4, 'one pill per filter, plus All')
same(byClass(pane, 'ph-sk-pill').map((pill) => textOf(elements(pill).filter((node) => node.tag === 'b')[0])),
  ['5', '2', '1', '2'],
  'each pill carries the count of the state it filters to')
is(textOf(pillFor(pane, t('skill.filter.all'))), t('skill.filter.all') + '5',
  'the All pill counts the whole catalog')
is(textOf(pillFor(pane, t('skill.state.enabled'))), t('skill.state.enabled') + '2',
  'the enabled pill counts what the model can see')
is(textOf(pillFor(pane, t('skill.state.userOnly'))), t('skill.state.userOnly') + '1',
  'the manual-only pill counts what /name can still load')
is(textOf(pillFor(pane, t('skill.state.disabled'))), t('skill.state.disabled') + '2',
  'the off pill counts what nothing can load')

pillFor(pane, t('skill.state.enabled')).props.onClick()
pane = await detail.render(api)
is(byClass(pane, 'ph-sk-row').length, 2, 'filtering to a state draws only that state')
ok(rowNamed(pane, 'pdf-tools') && rowNamed(pane, 'bundled-helper'), 'the two enabled skills are the two that stay')
is(pillFor(pane, t('skill.state.enabled')).props['aria-pressed'], true, 'the active pill says it is active')

pillFor(pane, t('skill.state.userOnly')).props.onClick()
pane = await detail.render(api)
is(byClass(pane, 'ph-sk-row').length, 1, 'the manual-only filter draws its own state alone')
ok(rowNamed(pane, 'writing-guard'), 'and it is the skill kept for manual use')

pillFor(pane, t('skill.state.disabled')).props.onClick()
pane = await detail.render(api)
is(byClass(pane, 'ph-sk-row').length, 2, 'the off filter draws every skill that is off')
ok(rowNamed(pane, 'comfyui') && rowNamed(pane, 'broken-skill'), 'in both spellings of off')

pillFor(pane, t('skill.filter.all')).props.onClick()
pane = await detail.render(api)
is(byClass(pane, 'ph-sk-row').length, 5, 'All brings the whole catalog back')

// --- a skill this plugin cannot write ---------------------------------------

const bundledRow = rowNamed(pane, 'bundled-helper')
const bundledSwitch = byClass(bundledRow, 'ph-sk-switch')[0]
is(bundledSwitch.props.disabled, true, 'a read-only skill must not offer a switch that would fail')
is(bundledSwitch.props.title, t('skill.row.readonlyBundled'), 'the switch explains why it is disabled')
ok(text(bundledRow).includes(t('skill.row.readonlyBundled')), 'and the row says it too')
is(byClass(bundledRow, 'ph-combo-caret')[0].props.disabled, true,
  'the mode switcher is the same write, so it is disabled too')
const writableSwitch = byClass(rowNamed(pane, 'pdf-tools'), 'ph-sk-switch')[0]
is(writableSwitch.props.disabled, false, 'a skill in a writable root keeps its switch')
is(writableSwitch.props.title, t('skill.row.turnOff'), 'an enabled switch offers to turn the skill off')
is(byClass(rowNamed(pane, 'comfyui'), 'ph-sk-switch')[0].props.title, t('skill.row.turnOn'),
  'an off switch offers to turn the skill on')
is(writableSwitch.props['aria-checked'], true, 'an on switch is checked')

// --- the invalid flag --------------------------------------------------------

const brokenRow = rowNamed(pane, 'broken-skill')
ok(text(brokenRow).includes(t('skill.row.invalid')), 'a skill with a note must be flagged as not in effect')
is(byClass(brokenRow, 'ph-sk-flag').length, 1, 'the flag is one element')
is(byClass(rowNamed(pane, 'pdf-tools'), 'ph-sk-flag').length, 0, 'a healthy skill is not flagged')
ok(text(rowNamed(pane, 'broken-skill')).includes(t('skill.source.userAgents')),
  'a flagged row still names where it came from')

// --- the switch writes the frontmatter through the host ----------------------

const togglesBefore = callsTo('homepage/skillSetEnabled').length
FIXTURES['homepage/skillSetEnabled'] = DEFERRED
byClass(rowNamed(pane, 'comfyui'), 'ph-sk-switch')[0].props.onClick()
pane = await detail.render(api)
const onCalls = callsTo('homepage/skillSetEnabled')
is(onCalls.length, togglesBefore + 1, 'flipping a switch reaches the host exactly once')
same(lastCall('homepage/skillSetEnabled').payload.args, { options: { name: 'comfyui', mode: 'on' } },
  'a skill that was off is turned on by name and mode, wrapped in the declared options object')
const busyRow = rowNamed(pane, 'comfyui')
ok(hasClass(busyRow, 'is-busy'), 'a row with a write in flight says so')
is(byClass(busyRow, 'ph-sk-switch')[0].props.disabled, true, 'and cannot be flipped twice')
ok(hasClass(rowNamed(pane, 'pdf-tools'), 'is-busy') === false, 'the other rows are not held up')
release('homepage/skillSetEnabled', { ok: true, name: 'comfyui', mode: 'on' })
pane = await detail.render(api)
is(byClass(rowNamed(pane, 'comfyui'), 'ph-sk-switch')[0].props.disabled, false,
  'the switch comes back once the host has answered')

const offBefore = callsTo('homepage/skillSetEnabled').length
FIXTURES['homepage/skillSetEnabled'] = { ok: true, name: 'pdf-tools', mode: 'off' }
byClass(rowNamed(pane, 'pdf-tools'), 'ph-sk-switch')[0].props.onClick()
pane = await detail.render(api)
is(callsTo('homepage/skillSetEnabled').length, offBefore + 1, 'the other direction is one call too')
same(lastCall('homepage/skillSetEnabled').payload.args, { options: { name: 'pdf-tools', mode: 'off' } },
  'a skill that was on is turned off, not on')

// --- a failed write is shown, and the row can be tried again -----------------

FIXTURES['homepage/skillSetEnabled'] = TRANSPORT_FAILURE
byClass(rowNamed(pane, 'comfyui'), 'ph-sk-switch')[0].props.onClick()
pane = await detail.render(api)
const writeErrors = byClass(pane, 'ph-sk-error')
ok(writeErrors.length >= 1, 'a write that failed must be reported on the page')
ok(text(writeErrors[0]).includes('HTTP 404'), 'the error is the host\'s own sentence')
is(byClass(rowNamed(pane, 'comfyui'), 'ph-sk-switch')[0].props.disabled, false,
  'a failed write releases the row so the user can try again')
const retryBefore = callsTo('homepage/skillSetEnabled').length
FIXTURES['homepage/skillSetEnabled'] = { ok: true, name: 'comfyui', mode: 'on' }
byClass(rowNamed(pane, 'comfyui'), 'ph-sk-switch')[0].props.onClick()
pane = await detail.render(api)
is(callsTo('homepage/skillSetEnabled').length, retryBefore + 1, 'trying again is another write')
is(byClass(pane, 'ph-sk-error').length, 0, 'and the error goes away when the write lands')

// --- the row menu names the three states precisely ---------------------------

const menuModes = [
  { label: 'skill.mode.on', mode: 'on' },
  { label: 'skill.mode.modelOff', mode: 'model-off' },
  { label: 'skill.mode.off', mode: 'off' },
]
// --- the row's mode switcher names the three states precisely ----------------
// The switcher must say which mode the skill is in WITHOUT being opened: that
// was the defect — the state only existed inside a menu that was clipped, so a
// row could read as "on" while the menu said something else.

is(byClass(rowNamed(pane, 'pdf-tools'), 'ph-combo').length, 1, 'a writable row carries exactly one mode switcher')
is(text(byClass(rowNamed(pane, 'pdf-tools'), 'ph-combo-main')[0]), t('skill.mode.on'),
  'the switcher shows the mode the skill is in, without opening it')
is(text(byClass(rowNamed(pane, 'comfyui'), 'ph-combo-main')[0]), t('skill.mode.off'),
  'an off skill says so on the switcher itself, not only in a menu')
is(text(byClass(bundledRow, 'ph-combo-main')[0]), t('skill.mode.on'),
  'a read-only row still names its mode')

// The three states the switcher stands for each read as their own sentence: a
// mode that shares a label with another is indistinguishable on the collapsed
// control, which is the defect this control exists to remove.
for (const entry of menuModes) {
  ok(String(t(entry.label)).length > 0, 'the mode ' + entry.mode + ' has a visible label')
  ok(String(t(entry.label + 'Hint')).length > 0, 'the mode ' + entry.mode + ' explains itself on hover')
}
is(new Set(menuModes.map((entry) => t(entry.label))).size, menuModes.length,
  'no two modes read the same on the switcher')

// The switcher's own contract, on the rendered card. The menu it opens is drawn
// by the panel's popover layer from the shared popover store, so it is not part
// of the card's tree and its items cannot be read from here. What is readable is
// everything the COLLAPSED switcher must say on its own — which is precisely the
// defect: the state used to live only inside a menu that was clipped.
const liveCaret = byClass(rowNamed(pane, 'pdf-tools'), 'ph-combo-caret')[0]
is(liveCaret.props['aria-haspopup'], 'menu', 'the caret announces that it opens a menu')
is(liveCaret.props['aria-expanded'], false, 'and reports the menu as closed while it is')
is(liveCaret.props['aria-label'], t('skill.mode.on'),
  'the caret announces the mode the skill is in, so the state survives a menu that cannot be read')
is(liveCaret.props.disabled, false, 'a writable skill gets a live switcher')
is(byClass(rowNamed(pane, 'pdf-tools'), 'ph-combo-main')[0].props.title, t('skill.row.more'),
  'the writable switcher explains itself on hover')

// A read-only row still has to look switchable-but-refused rather than silently
// live: the menu is disabled, and the label says why rather than leaving the user
// to click a control whose every item the host would reject.
is(byClass(bundledRow, 'ph-combo-main')[0].props.title, t('skill.row.readonlyBundled'),
  'the read-only switcher gives the reason on hover, not just a dead control')

// The other half of the write path: the switch in the same row is the fast
// convention of the same three-state control, and it is reachable from the
// rendered tree, so it is what proves the card's own write actually goes out.
// (The switcher and the switch share one `onSet`, so one is enough to pin the
// payload; the switch's two directions are covered above.)
for (const choice of [{ mode: 'on', flipFrom: 'off' }, { mode: 'off', flipFrom: 'on' }]) {
  const row = rowNamed(pane, choice.flipFrom === 'off' ? 'comfyui' : 'pdf-tools')
  is(comboOf(row).props['data-popover-anchor'].startsWith('combo-'), true,
    'the switcher is anchored to the framework popover layer, not to the row')
  is(byClass(row, 'ph-combo-caret')[0].props['aria-expanded'], false, 'the switcher menu starts closed')
  const before = callsTo('homepage/skillSetEnabled').length
  byClass(row, 'ph-sk-switch')[0].props.onClick()
  pane = await detail.render(api)
  is(callsTo('homepage/skillSetEnabled').length, before + 1, 'flipping the switch is one write')
  same(lastCall('homepage/skillSetEnabled').payload.args,
    { options: { name: choice.flipFrom === 'off' ? 'comfyui' : 'pdf-tools', mode: choice.mode } },
    'the row sends the mode it flipped to (' + choice.mode + ')')
}

// ======================================================== one skill's content

// The defect this covers: a local skill's name was a dead label. The card could
// switch a skill on and off but could never show what it actually says, so the
// only way to read one was to leave the panel and open the file.
const CONTENT_DOC = {
  name: 'pdf-tools',
  path: USER_ROOT + '\\pdf-tools\\SKILL.md',
  dir: USER_ROOT + '\\pdf-tools',
  source: 'user',
  kind: 'flat',
  writable: true,
  modelInvocable: true,
  userInvocable: true,
  note: null,
  bytes: 412,
  truncated: false,
  frontmatter: [
    { key: 'name', value: 'pdf-tools' },
    { key: 'description', value: 'Read and fill PDF forms.' },
  ],
  body: 'Read a PDF, fill its form fields, and save it back.\n\nThen verify the page count.',
  files: [],
  reason: null,
}
const reader = stage(card.detail)
FIXTURES['homepage/skillList'] = LIST_DOC
FIXTURES['homepage/skillContent'] = CONTENT_DOC
let doc = await reader.render(api)
const readsBefore = callsTo('homepage/skillContent').length
is(readsBefore, 0, 'a skill\'s text is not read until the skill is opened')
is(byClass(doc, 'ph-sk-doc').length, 0, 'and no content page is on show until then')

// The name is a control, not a label — that is what makes a local skill openable.
const nameButton = byClass(rowNamed(doc, 'pdf-tools'), 'ph-sk-name')[0]
is(nameButton.tag, 'button', 'a local skill\'s name is a button, so it can be opened')
is(nameButton.props.title, t('skill.row.open', { name: 'pdf-tools' }),
  'the name button says what opening it does')

nameButton.props.onClick()
doc = await reader.render(api)
is(callsTo('homepage/skillContent').length, readsBefore + 1, 'opening a skill reads exactly that one skill')
same(lastCall('homepage/skillContent').payload.args, { options: { name: 'pdf-tools' } },
  'and asks the host for it by name, so the catalog decides which copy that is')

// The content page REPLACES the pane rather than stacking over it: one level of
// navigation, so the card never becomes a modal over its own modal.
is(byClass(doc, 'ph-sk-row').length, 0, 'the content page replaces the library rather than covering it')
is(byClass(doc, 'ph-sk-tab').length, 0, 'and the tabs go with it, so the user is not left in two places at once')
is(byClass(doc, 'ph-sk-doc').length, 1, 'the content page is what is on show')

const headline = byClass(doc, 'ph-sk-doc-name')[0]
is(text(headline), 'pdf-tools', 'the page names the skill it is showing')
ok(text(byClass(doc, 'ph-sk-doc-meta')[0]).includes('pdf-tools\\SKILL.md'),
  'the page shows the exact file it read, so the path is never a mystery')
ok(text(byClass(doc, 'ph-sk-count')[0]).includes('412'), 'and how much of it there is')

// The body is rendered VERBATIM. A Skill\'s text is instructions for a model, so
// re-typesetting it would show the reader something the model never sees.
const bodyText = text(byClass(doc, 'ph-sk-doc-text')[0])
ok(bodyText.includes('Read a PDF, fill its form fields, and save it back.'),
  'the body is shown as written')
ok(bodyText.includes('Then verify the page count.'), 'all of it, not just the first line')
is(byClass(doc, 'ph-sk-doc-text')[0].tag, 'pre',
  'and in a pre, so its own indentation survives')

// The frontmatter is the exception: it IS metadata, so it becomes labelled rows,
// which is also the only place the two invocation switches are readable as written.
const keys = byClass(doc, 'ph-sk-doc-key').map((node) => text(node))
const values = byClass(doc, 'ph-sk-doc-value').map((node) => text(node))
same(keys, ['name', 'description'], 'every frontmatter key the host sent gets a labelled row')
is(values[1], 'Read and fill PDF forms.', 'with the value beside it, not folded into the body')
is(byClass(doc, 'ph-sk-doc-facts').length, 1, 'the facts are their own block')

// A writable skill can be switched from the content page, so reading a Skill and
// changing it are not two different places.
const barOf = (node, cls) => byClass(byClass(node, 'ph-sk-doc-bar')[0], cls)
const backOf = (node) => barOf(node, 'ph-sk-btn')[0]
is(barOf(doc, 'ph-combo').length, 1,
  'a writable skill can be switched without leaving its content page')

// Back returns to the library, and re-reading is not the price of it.
backOf(doc).props.onClick()
doc = await reader.render(api)
is(callsTo('homepage/skillContent').length, readsBefore + 1,
  'going back must not re-read the skill it is leaving')
is(byClass(doc, 'ph-sk-row').length > 0, true, 'and the library is back')
is(byClass(doc, 'ph-sk-doc').length, 0, 'with no content page left behind')

// A bundle Skill brings resources with it, and the page has to say what they are:
// a bundle's `files` is the one part of it that is not written in SKILL.md, so a
// pane that showed only the body would be hiding the skill's actual payload.
FIXTURES['homepage/skillContent'] = {
  ...CONTENT_DOC,
  name: 'writing-guard',
  path: AGENTS_ROOT + '\\writing-guard\\SKILL.md',
  dir: AGENTS_ROOT + '\\writing-guard',
  kind: 'bundle',
  files: [
    { path: 'notes.txt', kind: 'file', bytes: 5 },
    { path: 'scripts', kind: 'dir', bytes: 0 },
    { path: 'scripts/run.sh', kind: 'file', bytes: 10 },
  ],
}
byClass(rowNamed(doc, 'writing-guard'), 'ph-sk-name')[0].props.onClick()
doc = await reader.render(api)
same(byClass(doc, 'ph-sk-doc-file').map((node) => text(node)),
  ['notes.txt', 'scripts/', 'scripts/run.sh'],
  'every resource the host listed gets a chip, and a directory is marked as one')
is(byClass(doc, 'ph-sk-doc-filelist').length, 1, 'the resources are one list, not three blocks')
ok(text(byClass(doc, 'ph-sk-doc-files')[0]).includes('3'),
  'the heading counts exactly the chips under it, so the two can never disagree')
backOf(doc).props.onClick()
doc = await reader.render(api)
is(byClass(doc, 'ph-sk-doc-file').length, 0, 'and leaving the bundle takes its resource list with it')

// A flat Skill has no resources at all, and an empty list must not leave a
// heading behind claiming there are some.
FIXTURES['homepage/skillContent'] = CONTENT_DOC
FIXTURES['homepage/skillContent'].files = []
byClass(rowNamed(doc, 'pdf-tools'), 'ph-sk-name')[0].props.onClick()
doc = await reader.render(api)
is(byClass(doc, 'ph-sk-doc-files').length, 0, 'a skill with no resources shows no resource heading')
backOf(doc).props.onClick()
doc = await reader.render(api)

// A second skill reads that one: the page follows the name, it does not cache.
FIXTURES['homepage/skillContent'] = { ...CONTENT_DOC, name: 'comfyui', body: 'Driving ComfyUI.', writable: false }
byClass(rowNamed(doc, 'comfyui'), 'ph-sk-name')[0].props.onClick()
doc = await reader.render(api)
same(lastCall('homepage/skillContent').payload.args, { options: { name: 'comfyui' } },
  'opening a different skill reads that different skill')
is(text(byClass(doc, 'ph-sk-doc-name')[0]), 'comfyui', 'and the page shows it')
ok(text(byClass(doc, 'ph-sk-doc-text')[0]).includes('Driving ComfyUI.'), 'with its own body')

// A read-only skill must not offer a switch it cannot honour.
is(barOf(doc, 'ph-combo').length, 0,
  'a read-only skill gets no switcher on its content page')

// A file that cannot be read says so on the page rather than throwing: "I could
// not read it" is something the pane has to be able to say.
FIXTURES['homepage/skillContent'] = Object.assign({}, CONTENT_DOC, {
  reason: 'unreadable: EACCES', body: '', frontmatter: [],
})
backOf(doc).props.onClick()
doc = await reader.render(api)
byClass(rowNamed(doc, 'pdf-tools'), 'ph-sk-name')[0].props.onClick()
doc = await reader.render(api)
ok(text(byClass(doc, 'ph-sk-error')[0]).includes('EACCES'),
  'a skill whose file cannot be read says so, with the reason the host gave')
ok(text(byClass(doc, 'ph-sk-doc')[0]).includes('pdf-tools'),
  'and still identifies which skill it could not read')

// A transport failure is not the same as an unreadable file, and both are shown.
FIXTURES['homepage/skillContent'] = TRANSPORT_FAILURE
backOf(doc).props.onClick()
doc = await reader.render(api)
byClass(rowNamed(doc, 'pdf-tools'), 'ph-sk-name')[0].props.onClick()
doc = await reader.render(api)
ok(text(byClass(doc, 'ph-sk-error')[0]).includes('HTTP 404'),
  'a content read that failed at the transport is reported with the host\'s own words')

// ============================================================ the discover pane

// A fresh page, so the sources call can only come from opening the tab.
FIXTURES['homepage/skillList'] = LIST_DOC
FIXTURES['homepage/skillSources'] = SOURCES_DOC
FIXTURES['homepage/skillSearch'] = SEARCH_DOC
FIXTURES['homepage/skillInstall'] = INSTALL_DOC
const discover = stage(card.detail)
let paneX = await discover.render(api)
const sourcesBefore = callsTo('homepage/skillSources').length
is(byClass(paneX, 'ph-sk-row').length, 5, 'discovery starts on the installed pane')

byClass(paneX, 'ph-sk-tab')[1].props.onClick()
paneX = await discover.render(api)
is(callsTo('homepage/skillSources').length, sourcesBefore + 1, 'opening discovery asks which sources exist')
is(byClass(paneX, 'ph-sk-row').length, 0, 'the installed list is not drawn behind the storefront')
ok(byClass(paneX, 'ph-sk-hero').length >= 1, 'discovery leads with its own head')

// --- the source chips --------------------------------------------------------

const sourceChips = byClass(paneX, 'ph-sk-pill')
is(sourceChips.length, 3, 'one chip per source, plus All')
const allChip = pillFor(paneX, t('skill.discover.all'))
is(textOf(allChip), t('skill.discover.all'), 'All is the default source')
ok(hasClass(allChip, 'is-on'), 'the default source reads as selected')
const clawhubChip = pillFor(paneX, 'ClawHub')
ok(clawhubChip, 'every reachable source gets its own chip')
is(clawhubChip.props.title, SOURCES_DOC.sources[0].home, 'a reachable chip points at its home')
const githubChip = pillFor(paneX, 'GitHub')
ok(githubChip, 'an unreachable source still gets a chip: it exists, it is just down')
is(githubChip.props.title, 'HTTP 403', 'the unreachable chip carries the reason')
is(byClass(githubChip, 'ph-sk-pill').length, 1, 'the chip is one element')
const sourceNotes = byClass(paneX, 'ph-sk-source-note')
is(sourceNotes.length, 2, 'every source states its home, or why it is down')
ok(hasClass(sourceNotes[1], 'is-bad'), 'the unreachable source is marked as the bad one')
ok(text(sourceNotes[1]).includes(t('skill.discover.sourceDown', { label: 'GitHub', reason: 'HTTP 403' })),
  'and says what happened to it')
ok(text(sourceNotes[0]).includes(t('skill.discover.sourceHome', { label: 'ClawHub', home: 'https://clawhub.ai' })),
  'a reachable source says where it lives')

// --- searching the chosen source --------------------------------------------

byClass(paneX, 'ph-sk-pill').filter((chip) => textOf(chip) === 'ClawHub')[0].props.onClick()
paneX = await discover.render(api)
ok(hasClass(pillFor(paneX, 'ClawHub'), 'is-on'), 'the chosen source becomes the selected one')
is(callsTo('homepage/skillSearch').length, 0, 'choosing a source does not search on its own')

byClass(paneX, 'ph-sk-input')[0].props.onChange({ target: { value: 'pdf' } })
paneX = await discover.render(api)
const goButton = buttonWith(paneX, t('skill.discover.go'))
ok(goButton, 'discovery offers a way to run the search')
goButton.props.onClick()
paneX = await discover.render(api)
same(lastCall('homepage/skillSearch').payload.args, { options: { query: 'pdf', source: 'clawhub' } },
  'the search sends the query and the source the user chose')

const hits = byClass(paneX, 'ph-sk-hit')
is(hits.length, 3, 'every hit earns a card')
ok(byClass(paneX, 'ph-sk-grid').length === 1, 'the hits are laid out as a grid')
ok(textOf(byClass(hits[0], 'ph-sk-hit-name')[0]) === 'Pdf', 'a hit leads with its display name')
ok(textOf(byClass(hits[0], 'ph-sk-hit-owner')[0]) === 'awspace', 'and names its owner')
ok(text(hits[0]).includes(t('skill.hit.downloads', { count: 50605 })), 'and its install count')
ok(text(hits[0]).includes(t('skill.hit.stars', { count: 66 })), 'and its stars')

// --- a hit that is already installed offers no install -----------------------

const installedHit = hitNamed(paneX, 'Pdf Tools')
ok(installedHit, 'the already-installed hit is on screen')
ok(text(installedHit).includes(t('skill.hit.installed')), 'it says it is installed')
is(byClass(installedHit, 'ph-sk-btn').length, 0, 'and offers no install button')
ok(hasClass(installedHit, 'is-installed'), 'the card is marked as installed')
ok(byClass(installedHit, 'ph-sk-chip').length >= 1, 'the installed mark is a chip')
const installableHit = hitNamed(paneX, 'Pdf')
ok(installableHit, 'a hit that is not installed is on screen')
is(byClass(installableHit, 'ph-sk-btn').length, 1, 'and offers exactly one action')
ok(text(byClass(installableHit, 'ph-sk-btn')[0]).includes(t('skill.install.action')),
  'the action is an install')

// --- a hit's body is an enrichment, not a gate -------------------------------

is(callsTo('homepage/skillDetail').length, 0, 'a hit does not read its body until it is asked to')
buttonWith(installableHit, t('skill.hit.expand')).props.onClick()
paneX = await discover.render(api)
same(lastCall('homepage/skillDetail').payload.args,
  { options: { id: 'clawhub:awspace/pdf', source: 'clawhub' } },
  'opening a hit reads that hit from the source that offered it')
const openedHit = hitNamed(paneX, 'Pdf')
is(byClass(openedHit, 'ph-sk-detail').length, 1, 'the opened hit draws its body')
ok(text(openedHit).includes(t('skill.hit.files', { count: 1, names: 'SKILL.md' })),
  'the body lists what the package would install')
// The toggle is the first of the hit's two links (the other is the source URL).
byClass(openedHit, 'ph-sk-link')[0].props.onClick()
paneX = await discover.render(api)
is(byClass(hitNamed(paneX, 'Pdf'), 'ph-sk-detail').length, 0, 'and a second click folds it away again')

// --- installing: the call, the pending state, the reload ---------------------

const listCallsBefore = listCalls()
const toastsBefore = surface.snapshot().toasts.length
FIXTURES['homepage/skillInstall'] = DEFERRED
byClass(hitNamed(paneX, 'Pdf'), 'ph-sk-btn')[0].props.onClick()
paneX = await discover.render(api)
same(lastCall('homepage/skillInstall').payload.args,
  { options: { id: 'clawhub:awspace/pdf', source: 'clawhub', ref: 'awspace/pdf', destination: 'user-dsh' } },
  'the install names the hit, the source, the ref and the one destination the card writes to')
const installingButton = byClass(hitNamed(paneX, 'Pdf'), 'ph-sk-btn')[0]
is(installingButton.props.disabled, true, 'the install button is disabled while the host is working')
ok(text(installingButton).includes(t('skill.install.busy')), 'and says that it is working')
is(byClass(hitNamed(paneX, 'Xlsx'), 'ph-sk-btn')[0].props.disabled, true,
  'one install at a time: the other hit cannot start a second')
release('homepage/skillInstall', INSTALL_DOC)
paneX = await discover.render(api)
ok(listCalls() > listCallsBefore, 'a landed install re-reads the local catalog')
is(byClass(hitNamed(paneX, 'Pdf'), 'ph-sk-btn')[0].props.disabled, false, 'and the button is usable again')
const toast = surface.snapshot().toasts[surface.snapshot().toasts.length - 1]
is(surface.snapshot().toasts.length, toastsBefore + 1, 'a landed install is announced')
is(toast.text, t('skill.install.done', { name: 'pdf' }), 'the toast names the skill that landed')

// --- a failed install is reported, not thrown -------------------------------

const installListBefore = listCalls()
FIXTURES['homepage/skillInstall'] = TRANSPORT_FAILURE
byClass(hitNamed(paneX, 'Xlsx'), 'ph-sk-btn')[0].props.onClick()
paneX = await discover.render(api)
const installErrors = byClass(paneX, 'ph-sk-error')
ok(installErrors.length >= 1, 'a failed install is drawn where the user is looking')
ok(text(installErrors[0]).includes('HTTP 404'), 'with the host\'s own reason')
is(byClass(hitNamed(paneX, 'Xlsx'), 'ph-sk-btn')[0].props.disabled, false,
  'and the button comes back so the user can try again')
is(listCalls(), installListBefore, 'a failed install does not pretend the catalog changed')

// --- a failed search is reported, not thrown --------------------------------

FIXTURES['homepage/skillSearch'] = TRANSPORT_FAILURE
byClass(paneX, 'ph-sk-input')[0].props.onChange({ target: { value: 'pdf' } })
paneX = await discover.render(api)
buttonWith(paneX, t('skill.discover.go')).props.onClick()
paneX = await discover.render(api)
const searchErrors = byClass(paneX, 'ph-sk-error')
ok(searchErrors.length >= 1, 'a search that could not run is reported')
ok(text(searchErrors[0]).includes('HTTP 404'), 'with the host\'s own reason')
is(byClass(paneX, 'ph-sk-hit').length, 0, 'and draws no hits it does not have')

// --- truncated results and a source that failed -----------------------------

FIXTURES['homepage/skillSearch'] = SEARCH_EDGE_DOC
buttonWith(paneX, t('skill.discover.go')).props.onClick()
paneX = await discover.render(api)
ok(text(paneX).includes(t('skill.discover.truncated')), 'a truncated answer must say there is more')
const failureLine = byClass(paneX, 'ph-sk-warn')[0]
ok(failureLine, 'a source that failed is still on screen')
ok(text(failureLine).includes('skillhub: HTTP 502'), 'and it names the source and the reason')
is(byClass(paneX, 'ph-sk-hit').length, 1, 'the hits that did arrive are still drawn')

// ============================================================ styles and hygiene

// --- one stylesheet, registered once ----------------------------------------

is(registeredCss.length, 1, 'the card must register its stylesheet exactly once for the panel\'s lifetime')
ok(registeredCss[0].startsWith('.ph-sk{'), 'the sheet opens with the card\'s own root class')
ok(registeredCss[0].includes('.ph-sk-nav{'), 'the sheet carries the page\'s own rules')

const secondDetail = stage(card.detail)
FIXTURES['homepage/skillList'] = LIST_DOC
await secondDetail.render(api)
await secondDetail.render(api)
is(registeredCss.length, 1, 'rendering the expanded page twice must not stack a second copy of the sheet')

const CARD_CSS = registeredCss[0]

// --- every class the card adds is its own -----------------------------------

const frameworkClasses = new Set(
  [...String(module_.STYLES).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1]),
)
const sheetClasses = new Set([...CARD_CSS.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1]))
same([...sheetClasses].filter((name) => (
  !name.startsWith('ph-sk')
  && !name.startsWith('is-')
  && !frameworkClasses.has(name)
)), [], 'every class the card styles must be its own or the framework\'s, never a new foreign name')

// A card may adjust a framework control to fit its own row — the mode switcher is
// the framework's `ComboButton`, and its height and padding have to match the
// row — but it may only do that INSIDE its own subtree. Styling a framework class
// from the top level would reach every other card that uses the same control, so
// each selector that names a framework class must also name one of the card's own.
const foreignSelectors = []
for (const rule of String(CARD_CSS).split('}')) {
  const brace = rule.indexOf('{')
  if (brace === -1) continue
  const head = rule.slice(0, brace)
  if (head.trim().startsWith('@')) continue
  for (const selector of head.split(',')) {
    const classes = [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1])
    const foreign = classes.filter((name) => frameworkClasses.has(name) && !name.startsWith('ph-sk'))
    if (foreign.length > 0 && !classes.some((name) => name.startsWith('ph-sk'))) {
      foreignSelectors.push({ selector: selector.trim(), foreign })
    }
  }
}
same(foreignSelectors, [],
  'the card may only adjust a framework class inside one of its own ph-sk- scopes')

const cardSource = await readFile(new URL('../lib/cards/skill.js', import.meta.url), 'utf8')
const literalClasses = new Set()
for (const match of cardSource.matchAll(/className:\s*'([^']*)'/g)) {
  for (const token of match[1].split(/\s+/)) if (token !== '') literalClasses.add(token)
}
ok(literalClasses.size > 40, 'the card\'s class vocabulary must have been found, got ' + literalClasses.size)
same([...literalClasses].filter((name) => (
  !name.startsWith('ph-sk')
  && !name.startsWith('is-')
  && !frameworkClasses.has(name)
)), [], 'a class the card renders without styling it must be the framework\'s own, not a new foreign name')

// --- no bare colour for text or background ----------------------------------
//
// The plugin's hard rule: a card's own sheet may not name a bare colour for text
// or a fill. Every such declaration resolves through a `--dsw-alias-*` token,
// directly or through the card's own `--ph-sk-*` layer (which is itself defined
// as a token with a light-mode literal only as the fallback).

const cardVars = new Map()
for (const match of CARD_CSS.matchAll(/(--ph-sk-[a-z0-9-]+)\s*:\s*([^;}]+)/g)) cardVars.set(match[1], match[2])

function resolvesToToken(value, depth) {
  const at = depth || 0
  if (at > 6) return false
  const body = String(value)
  if (/--dsw-alias-[a-z0-9-]+/.test(body)) return true
  for (const match of body.matchAll(/var\(\s*(--ph-sk-[a-z0-9-]+)/g)) {
    const next = cardVars.get(match[1])
    if (next !== undefined && resolvesToToken(next, at + 1)) return true
  }
  return false
}

const colourViolations = []
let colourDeclarations = 0
for (const rule of CARD_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = rule[1].trim()
  for (const declaration of rule[2].split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const property = declaration.slice(0, colon).trim().toLowerCase()
    if (property !== 'color' && property !== 'background') continue
    colourDeclarations += 1
    const value = declaration.slice(colon + 1).trim()
    if (/^(none|transparent|inherit|unset|initial|currentcolor)$/i.test(value)) continue
    if (!resolvesToToken(value, 0)) colourViolations.push(selector + ' { ' + property + ':' + value + ' }')
  }
}
ok(colourDeclarations > 20, 'the colour scan must find the text and fill declarations, got ' + colourDeclarations)
same(colourViolations, [], 'every colour the card writes for text or a fill must resolve through a --dsw-alias-* token')

// ------------------------------------------------------------------- report

console.log('skill-card: all assertions passed')
console.log('  checks    : ' + checks)
console.log('  endpoints : ' + [...new Set(calls.map((call) => call.endpoint))].join(', '))
console.log('  styles    : ' + registeredCss.length + ' registration, ' + CARD_CSS.length + ' bytes, '
  + colourDeclarations + ' text/fill declarations checked')
console.log('  classes   : ' + sheetClasses.size + ' in the sheet, ' + literalClasses.size + ' rendered')

// The shim never unmounts, so anything the card armed (a toast timer, a poll)
// would keep the loop alive. React would clear it through the effect cleanup;
// here the run is over, so exit explicitly.
process.exit(0)
