/**
 * projects-card: the Projects card's OWN behavioural coverage.
 *
 * `test/smoke-client.mjs` proves the framework contract around a card. This file
 * proves the card itself: the pure normalizer, the wall reading, the expanded
 * list, the "open" button (including the api fallback), refresh and every
 * degradation state. The host document is a fixture handed back by a stubbed
 * `runtime.call`, so no real git and no real workspace registry are involved.
 *
 * The bundle is loaded the way the browser loads it — `lib/client.js` is read as
 * TEXT and evaluated with `new Function(source)()` — because it legitimately
 * names `module`/`exports`. The React object is the harness's own shim; the UI
 * primitives come from test/ui-primitives-stub.mjs.
 *
 * `useRemote` starts an interval, so `setInterval` is stubbed to a no-op for the
 * whole render session: the card must not leave a timer behind in a test.
 *
 * Run: node test/projects-card.mjs
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
    createRoot() { throw new Error('test/projects-card.mjs has no DOM root: the bundle is evaluated, not mounted') },
    hydrateRoot() { throw new Error('test/projects-card.mjs has no DOM root: the bundle is evaluated, not mounted') },
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

// The card polls; a test must never leave a live interval behind.
const realSetInterval = globalThis.setInterval
globalThis.setInterval = () => 0

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.notEqual(source.charCodeAt(0), 0xfeff, 'the bundle must not start with a UTF-8 BOM')
new Function(source)()

ok(bundleSpec, 'client bundle must call window.__ModuleLoader__.load')
const module_ = bundleSpec.factory(platformModule)

// ------------------------------------------------------------------- mock ctx

let dictionaries = null
let injectKey = null

const fallbackOpened = []
const uiWorkspace = {
  openWorkspace(id) {
    fallbackOpened.push(id)
    return true
  },
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
  get(name) {
    return name === 'uiWorkspace' ? uiWorkspace : null
  },
}

// ---------------------------------------------------------------------- apply

const runtime = module_._internal.runtime

module_.apply(mockCtx)
// `apply` installs the real stylesheet sink; wrap it afterwards so the card's
// one sheet can be inspected without losing the framework's own path.
const registeredCss = []
const realInsertCss = runtime.insertCss
runtime.insertCss = (css) => {
  registeredCss.push(css)
  return realInsertCss(css)
}
ok(dictionaries, 'apply must register the dictionaries')
is(dictionaries.namespace, 'homepage', 'the dictionaries live in the card plugin namespace')

// The host answer the card polls for. `remoteMode` lets one scenario hold the
// call open so the loading rendering can be inspected.
let remoteValue = null
let remoteMode = 'ok'
const calls = []
runtime.call = async (channel, endpoint, payload) => {
  calls.push({ channel, endpoint, payload })
  if (remoteMode === 'pending') return new Promise(() => {})
  return { ok: true, value: remoteValue }
}

const surface = globalThis.__DSH_HOMEPAGE__
const card = surface.get('projects')
ok(card, 'the shipped registry must hold the projects card')

const t = (key, params) => mockCtx.locale.bind('homepage')(key, params)

// ---------------------------------------------------------- registration contract

is(card.id, 'projects', 'the card id must be the one the contract names')
is(card.shipped, true, 'the projects card ships with the plugin')
same(card.size, { w: 2, h: 1 }, 'the wall span is the agreed 2x1')
same(card.minSize, { w: 1, h: 1 }, 'a one-column wall still carries the reading')
same(card.maxSize, { w: 4, h: 3 }, 'the expanded page may grow but its list stays a column')
is(card.order, 17, 'the card sits between sessions and the calendar')
is(card.accent, '#3e7c66', 'the accent is the card\'s own deep teal')
same(card.tags, ['project', 'git', 'workspace'], 'the card is discoverable by its tags')
same(card.texture, { icon: 'projects', opacity: 5, size: 118, bleed: '-16%' },
  'the watermark is the card\'s own mark, painted at the house five percent')

is(card.title(), '项目', 'the zh title resolves through the dictionary')
is(card.subtitle, null, 'the card carries no subtitle: the head reads as a title only')

const dictZh = card.dict && card.dict.zh ? card.dict.zh : {}
const dictEn = card.dict && card.dict.en ? card.dict.en : {}
const zhKeys = Object.keys(dictZh).sort()
const enKeys = Object.keys(dictEn).sort()
same(zhKeys, enKeys, 'zh and en must carry identical key sets')
ok(zhKeys.length >= 34, 'the dictionary must cover the whole card, got ' + zhKeys.length + ' keys')
ok(zhKeys.every((key) => key.indexOf('project.') === 0), 'every key must be namespaced project.*')
ok(zhKeys.every((key) => String(dictZh[key]).trim() !== ''), 'no zh literal may be left empty')
ok(enKeys.every((key) => String(dictEn[key]).trim() !== ''), 'no en literal may be left empty')
same(zhKeys.filter((key) => key === 'project.subtitle'
  || key === 'project.page.sub'
  || key === 'project.page.subNone'
  || key === 'project.page.loading'
  || key === 'project.page.title'
  || key === 'project.page.readOnly'), [],
  'the removed subtitle, page title, summary and read-only keys are gone from both dictionaries')

const wallOrder = module_._internal.orderedCards().map((entry) => entry.id)
is(wallOrder[0], 'token', 'the balance still leads the wall')
is(wallOrder[1], 'sessions', 'the sessions card follows it')
is(wallOrder.indexOf('projects'), 2, 'the projects card follows the sessions reading')
ok(wallOrder.indexOf('projects') < wallOrder.indexOf('network'), 'the network card still comes after it')

const icon = card.icon(24)
is(icon.tag, 'svg', 'the card draws its own icon')
is(icon.props.viewBox, '0 0 24 24', 'the icon lives on the 24 grid every other card uses')
is(icon.props.stroke, 'currentColor', 'the icon takes the surrounding ink')

// ------------------------------------------------------- the pure normalizer

const summarize = card.raw && card.raw.summarize
const parseProject = card.raw && card.raw.parseProject
ok(typeof summarize === 'function', 'the card must expose its pure summarize()')
ok(typeof parseProject === 'function', 'the card must expose its pure parseProject()')

const NOW = Date.now()
const MINUTE = 60000
const HOUR = 3600000

const PROJECTS = [
  {
    id: 'ws-atlas',
    title: 'Atlas',
    path: 'D:\\Projects\\atlas',
    status: 'ok',
    sessions: 3,
    live: 2,
    running: 1,
    git: {
      repo: true,
      branch: 'main',
      dirty: 2,
      ahead: 1,
      behind: 3,
      lastCommit: { hash: 'abc1234', at: NOW - 2 * HOUR, subject: 'Rewrite the wall' },
      worktrees: 2,
    },
  },
  {
    id: 'ws-notes',
    title: 'notes',
    path: '/home/me/notes',
    status: 'ok',
    sessions: 0,
    live: 0,
    running: 0,
    git: null,
  },
  {
    id: 'ws-old',
    title: 'old',
    path: '/home/me/old',
    status: 'missing-dir',
    sessions: 1,
    live: 0,
    running: 0,
    git: {
      repo: true,
      branch: 'trunk',
      dirty: 0,
      ahead: 0,
      behind: 0,
      lastCommit: null,
      worktrees: 0,
    },
  },
]

const DOC = {
  available: true,
  at: NOW,
  summary: { total: 3, dirty: 1, live: 2, running: 1, worktrees: 2, missing: 1 },
  projects: PROJECTS,
}
const EMPTY_DOC = { available: true, at: NOW, summary: { total: 0, dirty: 0, live: 0, running: 0, worktrees: 0, missing: 0 }, projects: [] }
const UNAVAILABLE_DOC = { available: false, reason: 'no workspace registry', at: NOW, summary: { total: 0, dirty: 0, live: 0, running: 0, worktrees: 0, missing: 0 }, projects: [] }

const parsed = summarize(DOC)
is(parsed.available, true, 'a document marked available is available')
is(parsed.total, 3, 'the total is the number of projects')
is(parsed.dirty, 1, 'one repository has uncommitted work')
is(parsed.live, 2, 'live sessions are summed across projects')
is(parsed.running, 1, 'running sessions are summed across projects')
is(parsed.worktrees, 2, 'extra worktrees are summed across repositories')
is(parsed.missing, 1, 'a missing directory is counted')
same(parsed.projects.map((project) => project.id), ['ws-atlas', 'ws-notes', 'ws-old'],
  'the host order is preserved, never re-sorted')

is(summarize(null).available, false, 'null while loading is unavailable, not a crash')
is(summarize(null).total, 0, 'an absent document is an empty reading')
is(summarize(undefined).total, 0, 'an undefined document is an empty reading')
is(summarize({ available: false, projects: PROJECTS }).total, 0,
  'an unavailable document does not count projects it may hold')
is(summarize({ available: true, projects: 'nope' }).total, 0,
  'a non-array project list is an empty reading')

const malformed = summarize({
  available: true,
  projects: [
    null,
    'not a project',
    42,
    {},
    { id: '', path: '' },
    { id: 'no-title', path: 'C:\\Projects\\alpha', sessions: '4', live: '2', status: 'garbage', git: { repo: 'yes' } },
  ],
})
is(malformed.total, 1, 'malformed project entries are ignored')
is(malformed.projects[0].id, 'no-title', 'the one valid entry survives')
is(malformed.projects[0].title, 'alpha', 'a missing title falls back to the directory name')
is(malformed.projects[0].status, 'unknown', 'an unknown directory status is unknown')
is(malformed.projects[0].sessions, 4, 'numeric strings are accepted as counts')
is(malformed.projects[0].live, 2, 'live counts are normalized')
is(malformed.projects[0].git, null, 'a git block without repo:true is not a reading')

is(parseProject(null), null, 'a null project is not a project')
is(parseProject(''), null, 'a string is not a project')
is(parseProject({ id: '', path: '' }), null, 'a project needs an id or a path')
const normalized = parseProject({
  id: ' p1 ',
  path: 'C:\\Projects\\beta',
  status: 'missing-dir',
  sessions: '2',
  live: '1',
  running: null,
  git: {
    repo: true,
    branch: ' dev ',
    dirty: 3,
    ahead: 0,
    behind: 2,
    worktrees: 2,
    lastCommit: { hash: 'h', at: 'not a date', subject: ' s ' },
  },
})
is(normalized.id, 'p1', 'ids are trimmed')
is(normalized.title, 'beta', 'a Windows path yields its last component')
is(normalized.status, 'missing-dir', 'the missing directory status survives')
is(normalized.sessions, 2, 'the session count is normalized')
is(normalized.running, 0, 'a null running count is zero')
is(normalized.git.branch, 'dev', 'the branch is trimmed')
is(normalized.git.dirty, 3, 'the dirty count survives')
is(normalized.git.lastCommit.at, 0, 'an unreadable commit date is zero, not NaN')
is(normalized.git.lastCommit.subject, 's', 'the subject is trimmed')
const failedGit = parseProject({ id: 'p2', git: { repo: false, error: ' boom ' } })
same(failedGit.git, { repo: false, error: 'boom' }, 'a git failure keeps its reason')

// ============================================================ the wall reading

function apiWith(extra) {
  return Object.assign(Object.create(surface.cardApi('projects')), extra || {})
}

function readingValues(tree) {
  return byClass(tree, 'ph-pj-read-value').map(textOf)
}

const preview = stage(card.content)
remoteValue = DOC
let tree = await preview.render(apiWith())

is(byClass(tree, 'ph-pj-preview').length, 1, 'the preview renders its own body')
is(textOf(byClass(tree, 'ph-pj-hero-value')[0]), '3', 'the hero is the project total')
is(textOf(byClass(tree, 'ph-pj-hero-label')[0]), t('project.preview.total'), 'the hero is named in words')
same(readingValues(tree), ['1', '2'], 'the two readings are dirty repositories and live sessions')
same(byClass(tree, 'ph-pj-read-label').map(textOf),
  [t('project.preview.dirty'), t('project.preview.live')], 'each reading carries its own label')
ok(hasClass(byClass(tree, 'ph-pj-read')[0], 'is-hot'), 'a non-zero dirty reading is marked')
ok(hasClass(byClass(tree, 'ph-pj-read')[1], 'is-hot'), 'a non-zero live reading is marked')
ok(text(tree).includes(t('project.preview.worktrees', { count: 2 })), 'the foot states the extra worktree count')
ok(text(tree).includes(t('project.preview.missing', { count: 1 })), 'the foot states the missing folders')

is(buttonLikes(tree).length, 0, 'the preview offers no button at all')
is(byClass(tree, 'ph-pj-iconbtn').length, 0, 'the refresh belongs to the expanded page')
is(byClass(tree, 'ph-actions').length, 0, 'a preview carries no settings controls')

// An available service with nothing to show reads three zeroes and one line.
remoteValue = EMPTY_DOC
const emptyPreview = stage(card.content)
tree = await emptyPreview.render(apiWith())
is(textOf(byClass(tree, 'ph-pj-hero-value')[0]), '0', 'an empty wall reads a zero total')
same(readingValues(tree), ['0', '0'], 'an empty wall reads zero dirty and zero live')
ok(text(tree).includes(t('project.preview.none')), 'the empty wall says there are no projects')

// A service that is not connected is a dash, not a lie about zero.
remoteValue = UNAVAILABLE_DOC
const unavailablePreview = stage(card.content)
tree = await unavailablePreview.render(apiWith())
is(textOf(byClass(tree, 'ph-pj-hero-value')[0]), '—', 'an unavailable service reads a dash')
same(readingValues(tree), ['—', '—'], 'unavailable readings are dashes, not zeroes')
is(byClass(tree, 'ph-pj-flag').length, 1, 'an unavailable reading raises the flag')
ok(text(tree).includes(t('project.unavailable.title')), 'the flag names the unavailable service')

// While the first call is in flight nothing has arrived yet; the card still draws.
remoteMode = 'pending'
const loadingPreview = stage(card.content)
tree = await loadingPreview.render(apiWith())
is(textOf(byClass(tree, 'ph-pj-hero-value')[0]), '—', 'a loading preview reads a dash')
same(readingValues(tree), ['—', '—'], 'a loading preview does not invent zeroes')
remoteMode = 'ok'

// The stylesheet is installed once for the lifetime of the panel.
is(registeredCss.length, 1, 'one stylesheet per card, not one per mount')
ok(registeredCss[0].includes('.ph-pj'), 'the stylesheet is the card\'s own')
ok(registeredCss[0].includes('--dsw-alias-label-primary'), 'the card paints with the theme tokens')
ok(registeredCss[0].includes('prefers-reduced-motion'), 'the card honours reduced motion')
ok(registeredCss[0].includes('max-width:760px'), 'the page collapses to one column')
ok(registeredCss[0].includes('(hover:hover) and (pointer:fine)'), 'hover rules only on a real pointer')
ok(registeredCss[0].indexOf('@keyframes') < 0, 'the card introduces no animation of its own')

// =========================================================== the expanded page

function rowOf(tree, id) {
  return byClass(tree, 'ph-pj-row').find((row) => row.props['data-project-id'] === id)
}

// The first call of this stage is the initial load; refresh adds exactly one.
const opened = []
const detail = stage(card.detail)
remoteValue = DOC
const openApi = apiWith({
  openWorkspace(id) {
    opened.push(id)
    return true
  },
})
tree = await detail.render(openApi)

is(byClass(tree, 'ph-pj-page').length, 1, 'the expanded page renders its own body')
is(byClass(tree, 'ph-pj-title').length, 0, 'the expanded pane header already names the card, so the body draws no title')
is(byClass(tree, 'ph-pj-sub').length, 0, 'the page carries no summary sentence under the title')
is(byClass(tree, 'ph-pj-note').length, 0, 'the page carries no read-only footnote')
is(byClass(tree, 'ph-pj-row').length, 3, 'the page lists every project')
same(byClass(tree, 'ph-pj-row').map((row) => row.props['data-project-id']),
  ['ws-atlas', 'ws-notes', 'ws-old'], 'the page keeps the host order')
is(byClass(tree, 'ph-pj-row').filter((row) => row.tag === 'button').length, 0,
  'a row that contains a button is not itself a button')

const atlas = rowOf(tree, 'ws-atlas')
ok(text(atlas).includes('Atlas'), 'the row shows the project title')
is(byClass(atlas, 'ph-pj-row-meta').length, 1, 'the row keeps one secondary meta line')
ok(text(byClass(atlas, 'ph-pj-row-meta')[0]).includes('atlas'),
  'the path basename lives on that one meta line')
ok(text(atlas).includes('main'), 'the row shows the branch')
ok(text(atlas).includes(t('project.git.dirty', { count: 2 })), 'the row shows the dirty count')
ok(text(atlas).includes(t('project.git.ahead', { count: 1 })), 'the row shows the ahead count')
ok(text(atlas).includes(t('project.git.behind', { count: 3 })), 'the row shows the behind count')
ok(text(atlas).includes(t('project.git.worktrees', { count: 2 })), 'the row shows an extra worktree')
ok(text(atlas).includes('Rewrite the wall'), 'the row shows the last commit subject')
ok(text(atlas).includes(t('project.time.hours', { count: 2 })), 'the row shows the commit age')
ok(text(atlas).includes(t('project.badge.running', { count: 1 })), 'the row shows the running session badge')

const notes = rowOf(tree, 'ws-notes')
is(byClass(notes, 'ph-pj-chip').filter((chip) => hasClass(chip, 'is-plain')).length, 1,
  'a non-repository carries a plain hint chip')
ok(text(notes).includes(t('project.git.none')), 'a non-repository says it is not one')

const old = rowOf(tree, 'ws-old')
ok(hasClass(old, 'is-missing'), 'a missing directory marks its row')
ok(text(old).includes(t('project.status.missing')), 'a missing directory warns in words')
ok(text(old).includes(t('project.git.noCommit')), 'a repository without commits says so')
ok(text(old).includes('trunk'), 'a repository without commits still names its branch')

const openButtons = byClass(tree, 'ph-pj-open')
is(openButtons.length, 3, 'every project row offers one open action')
ok(openButtons.every((button) => button.props.type === 'button'), 'the open action is a real button')
is(buttonLikes(atlas).length, 1, 'the row itself contains only the one button')
openButtons[0].props.onClick()
same(opened, ['ws-atlas'], 'the open button calls api.openWorkspace with the project id')

// Refresh is a real re-read: one more call to the same endpoint with the same args.
const beforeRefresh = calls.length
byClass(tree, 'ph-pj-iconbtn')[0].props.onClick()
await sleep(20)
tree = await detail.render(openApi)
is(calls.length, beforeRefresh + 1, 'refresh makes exactly one host call')
same(calls[calls.length - 1], {
  channel: '/api',
  endpoint: 'homepage/projects',
  payload: { args: { options: {} } },
}, 'the call carries the one options object every homepage endpoint takes')
ok(byClass(tree, 'ph-pj-iconbtn')[0].props.title, 'the refresh control has a title')
is(byClass(tree, 'ph-pj-iconbtn')[0].props['aria-label'], t('project.page.refresh'),
  'the refresh control is named for assistive technology')

// A failing open says so; the card never unwinds a click handler.
const failStage = stage(card.detail)
remoteValue = DOC
const failingApi = apiWith({ openWorkspace() { return false } })
let failTree = await failStage.render(failingApi)
const toastsBefore = surface.snapshot().toasts.length
byClass(failTree, 'ph-pj-open')[0].props.onClick()
await sleep(10)
let toasts = surface.snapshot().toasts
is(toasts.length, toastsBefore + 1, 'a refused open raises one toast')
is(toasts[toasts.length - 1].text, t('project.open.failed'), 'a refused open is named')
is(toasts[toasts.length - 1].level, 'error', 'a refused open is an error')

const throwStage = stage(card.detail)
remoteValue = DOC
const throwingApi = apiWith({ openWorkspace() { throw new Error('no service') } })
let throwTree = await throwStage.render(throwingApi)
const throwToastsBefore = surface.snapshot().toasts.length
byClass(throwTree, 'ph-pj-open')[0].props.onClick()
await sleep(10)
toasts = surface.snapshot().toasts
is(toasts.length, throwToastsBefore + 1, 'a throwing open raises one toast instead of escaping')
is(toasts[toasts.length - 1].text, t('project.open.failed'), 'a throwing open reports the same failure')

// Without api.openWorkspace the sidebar workspace service is the fallback.
const fallbackStage = stage(card.detail)
remoteValue = DOC
let fallbackTree = await fallbackStage.render(apiWith())
const fallbackToastsBefore = surface.snapshot().toasts.length
byClass(fallbackTree, 'ph-pj-open')[1].props.onClick()
same(fallbackOpened, ['ws-notes'], 'the fallback opens through sidebarServices.uiWorkspace')
is(surface.snapshot().toasts.length, fallbackToastsBefore, 'a successful fallback is silent')

// Neither route available: the toast is the honest last resort.
uiWorkspace.openWorkspace = null
const neitherStage = stage(card.detail)
remoteValue = DOC
let neitherTree = await neitherStage.render(apiWith())
const neitherToastsBefore = surface.snapshot().toasts.length
byClass(neitherTree, 'ph-pj-open')[0].props.onClick()
await sleep(10)
toasts = surface.snapshot().toasts
is(toasts.length, neitherToastsBefore + 1, 'no open route raises a toast')
is(toasts[toasts.length - 1].text, t('project.open.failed'), 'no open route reports the failure')
uiWorkspace.openWorkspace = function (id) {
  fallbackOpened.push(id)
  return true
}

// A git failure is a named chip with the host's reason attached.
remoteValue = {
  available: true,
  at: NOW,
  summary: { total: 1, dirty: 0, live: 0, running: 0, worktrees: 0, missing: 0 },
  projects: [{
    id: 'ws-locked', title: 'locked', path: '/home/me/locked', status: 'ok',
    sessions: 0, live: 0, running: 0,
    git: { repo: false, error: 'fatal: dubious ownership' },
  }],
}
const errorStage = stage(card.detail)
let errorTree = await errorStage.render(apiWith())
const errorChip = byClass(errorTree, 'ph-pj-chip').find((chip) => hasClass(chip, 'is-error'))
ok(errorChip, 'a git failure renders the error chip')
is(textOf(errorChip), t('project.git.error'), 'the error chip is named in words')
is(errorChip.props.title, 'fatal: dubious ownership', 'the host reason is attached as a tooltip')

// Empty and unavailable both have their own page, and they are not the same page.
remoteValue = EMPTY_DOC
const emptyDetail = stage(card.detail)
let emptyTree = await emptyDetail.render(apiWith())
is(byClass(emptyTree, 'ph-pj-empty').length, 1, 'an empty service renders the empty state')
ok(text(emptyTree).includes(t('project.empty.title')), 'the empty state says there are no projects')
is(byClass(emptyTree, 'ph-pj-row').length, 0, 'an empty service lists nothing')

remoteValue = UNAVAILABLE_DOC
const unavailableDetail = stage(card.detail)
let unavailableTree = await unavailableDetail.render(apiWith())
is(byClass(unavailableTree, 'ph-pj-empty').length, 1, 'an unavailable service renders the empty state')
ok(text(unavailableTree).includes(t('project.unavailable.title')), 'the unavailable state names the service')
is(byClass(unavailableTree, 'ph-pj-note').length, 0, 'even an unavailable page carries no read-only footnote')
is(byClass(unavailableTree, 'ph-pj-sub').length, 0, 'even an unavailable page carries no summary sentence')
is(byClass(unavailableTree, 'ph-pj-row').length, 0, 'an unavailable service lists nothing')

globalThis.setInterval = realSetInterval

console.log('projects-card: ' + checks + ' checks passed')
