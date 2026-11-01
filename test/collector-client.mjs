/**
 * collector-client: the client half of the collector and action layers.
 *
 * Proves the three things a card cannot prove for itself:
 *  - the session bridge copies the host's snapshots onto `runtime`, and
 *    `cardApi` exposes them as `api.sessionStatus` / `api.sessionList`;
 *  - `api.openSession` goes through the workspace service and answers false
 *    instead of throwing when there is no service to go through;
 *  - `api.collect` / `api.act` reach `homepage/collect` and
 *    `homepage/act` inside the one `{ options }` envelope the gateway
 *    matches on, and turn a failed call into data, never into a rejection.
 *
 * No React tree is rendered here: the bridges are called as the plain functions
 * they are, which is what the panel does with them. The panel's own render path
 * (bridge ordering, tree shape) stays covered by test/smoke-client.mjs.
 *
 * Run: node test/collector-client.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createUiPrimitives } from './ui-primitives-stub.mjs'

// ------------------------------------------------------------ React stand-in
//
// Only the surface the bundle touches while being *evaluated*: createElement is
// called by card modules at definition time, everything else is here so a
// component that is defined but never rendered cannot fail on a missing field.

const Fragment = Symbol('Fragment')

function createElement(type, props) {
  const children = Array.prototype.slice.call(arguments, 2)
  const merged = Object.assign({}, props || {})
  if (children.length === 1) merged.children = children[0]
  else if (children.length > 1) merged.children = children
  return { tag: type, props: merged, key: merged.key === undefined ? null : merged.key }
}

const React = {
  createElement,
  Fragment,
  memo: (component) => component,
  forwardRef: (render) => render,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial }),
  useCallback: (callback) => callback,
  createContext: (value) => ({ Provider: null, Consumer: null, value }),
  useContext: (context) => (context ? context.value : undefined),
}

// ---------------------------------------------------------- environment shims

function memoryStorage() {
  const table = new Map()
  return {
    getItem: (key) => (table.has(String(key)) ? table.get(String(key)) : null),
    setItem: (key, value) => { table.set(String(key), String(value)) },
    removeItem: (key) => { table.delete(String(key)) },
    clear: () => table.clear(),
    key: (index) => Array.from(table.keys())[index] || null,
    get length() { return table.size },
  }
}

const appendedStyles = []

let bundleSpec = null
globalThis.window = {
  __ModuleLoader__: { load(spec) { bundleSpec = spec } },
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: memoryStorage(),
}
globalThis.localStorage = globalThis.window.localStorage
globalThis.document = {
  querySelectorAll: () => [],
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
  documentElement: { style: {}, setAttribute() {}, classList: { add() {}, remove() {} } },
}
if (!globalThis.navigator) globalThis.navigator = { clipboard: null }

const PLATFORM = new Map([
  ['react', () => React],
  ['react-dom/client', () => ({
    createRoot() { throw new Error('collector-client: there is no DOM root in this harness') },
    hydrateRoot() { throw new Error('collector-client: there is no DOM root in this harness') },
  })],
  ['@deepseek-ai/dsh-client-ui-primitives', () => createUiPrimitives(React)],
])

/** @returns the stand-in for one module of DSH's platform table. */
function platformModule(id) {
  if (!PLATFORM.has(id)) {
    assert.fail('the client half required a module this harness has no stand-in for: ' + String(id))
  }
  return PLATFORM.get(id)()
}

// The browser fetches the bundle text and evaluates it as a classic script, so
// that is exactly how it is loaded here.
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.notEqual(source.charCodeAt(0), 0xfeff, 'the bundle must not start with a UTF-8 BOM')
new Function(source)()
assert.ok(bundleSpec && typeof bundleSpec.factory === 'function', 'the bundle must register a factory')

const module_ = bundleSpec.factory(platformModule)
const internal = module_._internal
const runtime = internal.runtime

console.log('collector-client: exercising the session bridge, the action and collector entries')

// ------------------------------------------------------------------ mock ctx

const rpcCalls = []
const opened = []
const registrations = []
let rpcAnswer = () => ({ ok: true, value: null })

function mockCtx(settings) {
  const options = settings || {}
  return {
    logger: { info() {}, warn() {}, error() {} },
    get(key) {
      if (key === 'uiWorkspace') return options.uiWorkspace
      return undefined
    },
    slots: {
      inject(name, callback) {
        callback()
        return () => {}
      },
      register(spec, render) {
        registrations.push({ spec, render })
        return () => {}
      },
    },
    connection: {
      rpc: {
        async call(channel, endpoint, payload) {
          rpcCalls.push({ channel, endpoint, payload })
          return rpcAnswer(endpoint, payload)
        },
      },
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    effect(fn) {
      const cleanup = fn()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
  }
}

module_.apply(mockCtx({ uiWorkspace: { openSession: (id) => opened.push(id) } }))
const surface = globalThis.__DSH_HOMEPAGE__
assert.ok(surface, 'apply must publish the extension surface')
assert.ok(internal && internal.SessionStatusBridge, 'the bridge must be reachable through _internal')
assert.equal(runtime.sessionStatus, null, 'no snapshot is bridged before the panel mounts')
assert.equal(runtime.sessionList, null, 'no session list is bridged before the panel mounts')

const card = { id: 'probe', actions: [], detailActions: [], size: { w: 1, h: 1 } }
const api = module_.cardApi(card)
assert.equal(api.sessionStatus, null, 'a card reads null while the host provides no session store')
assert.equal(api.sessionList, null, 'a card reads null for the list too')

// ------------------------------------------------------------ session bridge

{
  const status = new Map([['s-1', { running: true, pendingInteraction: undefined, completionUnread: false }]])
  const list = { byId: { 's-1': { title: 'one', updatedAt: 1700000000000 } } }

  let selector = null
  const rendered = internal.SessionStatusBridge({
    useSessionStatus(select) {
      selector = select
      return status
    },
  })
  assert.equal(rendered, null, 'the status bridge draws nothing of its own')
  assert.equal(typeof selector, 'function', 'the hook is called with a selector, which the store requires')
  assert.equal(selector(status), status, 'the selector asks for the whole snapshot, unchanged')
  assert.equal(runtime.sessionStatus, status, 'the status snapshot lands on runtime')
  assert.equal(api.sessionStatus, status, 'the card reads the snapshot through cardApi')

  internal.SessionListBridge({ useSessions: (select) => select(list) })
  assert.equal(runtime.sessionList, list, 'the session list lands on runtime')
  assert.equal(api.sessionList, list, 'the card reads the list through cardApi')

  // A store that has not produced a value yet, and one that answers undefined,
  // both have to read as null rather than as a half-built snapshot.
  internal.SessionStatusBridge({ useSessionStatus: (select) => select(undefined) })
  assert.equal(runtime.sessionStatus, null, 'an undefined snapshot reads as null')
  internal.SessionStatusBridge({ useSessionStatus: (select) => select(status) })
  assert.equal(runtime.sessionStatus, status, 'a later snapshot replaces it')
  console.log('  bridge: hooks are called with a selector and the snapshots reach cardApi')
}

// --------------------------------------------------------------- openSession

{
  opened.length = 0
  assert.equal(api.openSession('s-1'), true, 'a live workspace service opens the session')
  assert.deepEqual(opened, ['s-1'], 'the service receives the id as a string')
  assert.equal(api.openSession('  '), false, 'a blank id is refused before the service is touched')
  assert.deepEqual(opened, ['s-1'], 'the refused call reached nothing')
  console.log('  openSession: true through the workspace service, false for a blank id')
}

// ---------------------------------------------------------- collect and act

{
  rpcCalls.length = 0
  const snapshot = { at: 1700000000000, entries: { runtime: { name: 'runtime', value: { agents: { total: 2 } }, stale: false } } }
  rpcAnswer = () => ({ ok: true, value: snapshot })

  const collected = await api.collect(['runtime'], { force: true })
  assert.deepEqual(collected, snapshot, 'the host snapshot is handed back unchanged')
  const call = rpcCalls[rpcCalls.length - 1]
  assert.equal(call.channel, '/api', 'collect rides the shared /api channel')
  assert.equal(call.endpoint, 'homepage/collect', 'collect reaches the registered endpoint')
  assert.deepEqual(call.payload, { args: { options: { names: ['runtime'], force: true } } },
    'collect sends one options object, which is the shape the gateway matches on')

  rpcAnswer = () => ({ ok: true, value: { ok: true, action: 'session.stop', value: { stopped: true } } })
  const acted = await api.act('session.stop', { sessionId: 's-1' })
  assert.deepEqual(acted, { ok: true, action: 'session.stop', value: { stopped: true } },
    'the action result is handed back unchanged')
  const actionCall = rpcCalls[rpcCalls.length - 1]
  assert.equal(actionCall.endpoint, 'homepage/act', 'act reaches the registered endpoint')
  assert.deepEqual(actionCall.payload, { args: { options: { action: 'session.stop', payload: { sessionId: 's-1' } } } },
    'act sends one options object carrying the id and the payload')

  // A dead channel must be data for the card, not an unhandled rejection.
  rpcAnswer = () => ({ ok: false, error: { message: 'homepage: gateway down' } })
  const failedCollect = await api.collect()
  assert.equal(failedCollect.entries && Object.keys(failedCollect.entries).length, 0, 'a failed collect answers an empty snapshot')
  assert.ok(String(failedCollect.error).includes('gateway down'), 'a failed collect reports why')
  const failedAct = await api.act('session.stop', { sessionId: 's-1' })
  assert.equal(failedAct.ok, false, 'a failed action answers ok: false')
  assert.equal(failedAct.action, 'session.stop', 'the refusal names the action')
  assert.ok(String(failedAct.error).includes('gateway down'), 'a failed action reports why')

  // No channel at all (the bundle applied before the connection exists).
  const bare = module_._internal.runtime
  const savedCollect = bare.collect
  const savedAct = bare.act
  bare.collect = function () { return Promise.resolve({ at: Date.now(), entries: {}, error: 'the collector is unavailable' }) }
  bare.act = function (action) { return Promise.resolve({ ok: false, action: String(action), error: 'the action layer is unavailable' }) }
  const unavailableCollect = await api.collect()
  assert.ok(unavailableCollect.error, 'an absent collector answers an error instead of rejecting')
  const unavailableAct = await api.act('session.stop')
  assert.equal(unavailableAct.ok, false, 'an absent action layer answers a refusal')
  bare.collect = savedCollect
  bare.act = savedAct
  console.log('  collect/act: one options envelope, structural results, no rejection')
}

// ------------------------------------------------------------- degradation

{
  module_.apply(mockCtx({ uiWorkspace: { openSession() { throw new Error('no route') } } }))
  assert.equal(api.openSession('s-2'), false, 'a throwing navigation answers false')

  module_.apply(mockCtx({}))
  assert.equal(api.openSession('s-3'), false, 'a host without the workspace service answers false')
  console.log('  degradation: a missing or throwing workspace service never throws at the card')
}

console.log('collector-client: all sections passed')
