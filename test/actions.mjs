/**
 * Unit test for the host-side action layer (`lib/host/actions.js`) and for the
 * plugin's own `session.stop` registration in `lib/index.js`.
 *
 * Plain script, no framework: `node test/actions.mjs`. The agent registry is a
 * fake, so a stop is proved to reach `cancel({ kind: 'user' }, { keepInbox: true })`
 * without a live session and without touching a real agent.
 *
 * Run: node test/actions.mjs
 */
import assert from 'node:assert/strict'
import { createActions } from '../lib/host/actions.js'
import { apply } from '../lib/index.js'

console.log('actions: exercising the registry, the error shapes and the plugin wiring')

// --------------------------------------------------------- registration

{
  const actions = createActions()
  actions.register('ping', { run: async () => 'pong' })
  assert.equal(actions.has('ping'), true, 'has answers for a registered action')
  assert.equal(actions.has('nope'), false, 'has is false for an unknown action')
  assert.deepEqual(actions.list(), ['ping'], 'list carries the ids in order')
  assert.throws(() => actions.register('ping', { run: async () => 'again' }), /already registered/,
    'a duplicate id throws')
  assert.throws(() => actions.register('', { run: async () => 1 }), TypeError, 'an empty id throws')
  assert.throws(() => actions.register('no-run', {}), TypeError, 'a definition without run throws')
  assert.throws(() => actions.register('bad-validate', { run: async () => 1, validate: 'nope' }), TypeError,
    'a non-function validate throws')

  const off = actions.register('later', { run: async () => 'value' })
  assert.equal(actions.has('later'), true, 'the second registration landed')
  assert.equal(off(), true, 'unregister reports that it removed the registration')
  assert.equal(actions.has('later'), false, 'unregister removed the action')
  assert.equal(off(), false, 'a second unregister is a no-op')
  console.log('  registry: ids are unique, specs are validated, unregister is idempotent')
}

// ------------------------------------------------------------ run success

{
  const calls = []
  const actions = createActions({ context: { tag: 'ctx' } })
  actions.register('sync', { run: (payload, context) => ({ payload, context }) })
  actions.register('async', { run: async (payload) => ({ doubled: payload.value * 2 }) })

  const sync = await actions.run('sync', { a: 1 })
  assert.deepEqual(sync, { ok: true, action: 'sync', value: { payload: { a: 1 }, context: { tag: 'ctx' } } },
    'a synchronous run is wrapped in the success shape and sees the fixed context')
  const async = await actions.run('async', { value: 21 })
  assert.deepEqual(async, { ok: true, action: 'async', value: { doubled: 42 } },
    'an asynchronous run is awaited')
  console.log('  run: sync and async actions both answer { ok: true, action, value }')
}

// ---------------------------------------------------------- failure paths

{
  const warnings = []
  const actions = createActions({ logger: { warn: (line) => warnings.push(String(line)) } })
  const unknown = await actions.run('missing', {})
  assert.deepEqual(unknown, { ok: false, action: 'missing', error: 'unknown action: missing' },
    'an unknown action is a structured error, not a throw')

  let ran = 0
  actions.register('guarded', {
    validate: (payload) => {
      if (!payload || payload.ok !== true) throw new Error('bad arguments')
    },
    run: () => { ran += 1; return 'reached' },
  })
  const refused = await actions.run('guarded', { ok: false })
  assert.deepEqual(refused, { ok: false, action: 'guarded', error: 'bad arguments' },
    'a rejected argument check refuses the call')
  assert.equal(ran, 0, 'a refused call never runs the action')

  const allowed = await actions.run('guarded', { ok: true })
  assert.equal(allowed.ok, true, 'a passing argument check runs the action')
  assert.equal(ran, 1, 'the action ran exactly once')

  actions.register('rejects', { run: async () => { throw new Error('backend down') } })
  const rejected = await actions.run('rejects', {})
  assert.deepEqual(rejected, { ok: false, action: 'rejects', error: 'backend down' },
    'a rejecting action is a structured failure')

  actions.register('throws', { run: () => { throw new TypeError('bug') } })
  const thrown = await actions.run('throws', {})
  assert.deepEqual(thrown, { ok: false, action: 'throws', error: 'bug' },
    'a throwing action is a structured failure')

  actions.register('async-validate', {
    validate: async () => { throw new Error('not allowed yet') },
    run: async () => 'unreachable',
  })
  const asyncRefused = await actions.run('async-validate', {})
  assert.deepEqual(asyncRefused, { ok: false, action: 'async-validate', error: 'not allowed yet' },
    'an asynchronous argument check is awaited before refusing')
  assert.ok(warnings.some((line) => line.includes('"guarded"') && line.includes('bad arguments')),
    'a refused call is logged with the action id and the reason')
  assert.equal(warnings.some((line) => line.includes('"missing"')), false,
    'an unknown action is refused without a log line: it is not a failure of anything running')
  console.log('  failures: unknown id, refused arguments and throwing actions all answer { ok: false }')
}

// ------------------------------------------------------- plugin mount

/**
 * Mount the plugin on a mock context, the way `test/smoke-host.mjs` does.
 * @param {object} [options] - the services the mount should expose.
 * @param {object} [options.agents] - fake agent registry.
 * @param {object} [options.sessions] - fake session registry.
 * @returns {{ api: object, contribution: object, tools: object[] }} the mount.
 */
function mount(options = {}) {
  const provided = {}
  const tools = []
  const contribution = { value: null }
  const timer = { timeout: () => () => {}, interval: () => () => {} }
  const ctx = {
    logger: { warn() {}, error() {}, info() {}, debug() {} },
    get(key) {
      if (key === 'tools') return { register: (tool) => { tools.push(tool) } }
      if (key === 'timer') return timer
      if (key === 'agents') return options.agents
      if (key === 'sessions') return options.sessions
      return undefined
    },
    provide(key, value) {
      provided[key] = value
      return () => { delete provided[key] }
    },
    inject(deps, callback) {
      callback({ typert: { register: (value) => { contribution.value = value; return () => {} } } })
      return () => {}
    },
    effect(callback) {
      const cleanup = callback()
      return () => { if (typeof cleanup === 'function') cleanup() }
    },
  }
  apply(ctx)
  return { api: provided.homepage, contribution: contribution.value, tools }
}

/**
 * Fake live agent registry. Two agents are listed; only the ids in `live` can be
 * looked up, and every lookup that can be stopped records its cancel cause.
 * @param {string[]} [live] - ids with a live handle.
 * @returns {object} the fake registry, with `cancelled` and `listCalls`.
 */
function fakeAgents(live = []) {
  const registry = {
    cancelled: [],
    listCalls: 0,
    list() {
      registry.listCalls += 1
      return [{ id: 'a-1', status: 'running' }, { id: 'a-2', status: 'idle' }]
    },
    roots() { return [{ id: 'a-1', status: 'running' }] },
    get(id) {
      if (!live.includes(id)) return undefined
      return { id, cancel(cause, options) { registry.cancelled.push({ id, cause, options }) } }
    },
  }
  return registry
}

const agents = fakeAgents(['live-1'])
const sessions = { list: () => [{ id: 's-1' }, { id: 's-2' }, { id: 's-3' }] }
const mounted = mount({ agents, sessions })
const api = mounted.api

assert.equal(typeof api.collect, 'function', 'the host api exposes collect')
assert.equal(typeof api.act, 'function', 'the host api exposes act')

// Remote contract: each new endpoint takes exactly one `options` object, the
// same shape every existing invocation declares.
const invocations = mounted.contribution.invocations
for (const method of ['collect', 'act']) {
  const invocation = invocations.find((entry) => entry.method === method) || {}
  assert.equal(invocation.id, 'dsh-homepage#homepage/' + method, method + ' invocation id')
  assert.deepEqual(invocation.parameters.map((parameter) => parameter.name), ['options'],
    method + ' takes a single options object')
}
console.log('  wiring: collect and act are registered endpoints with the remote options shape')

// -------------------------------------------------------------- session.stop

{
  const stopped = await api.act({ action: 'session.stop', payload: { sessionId: 'live-1' } })
  assert.deepEqual(stopped, { ok: true, action: 'session.stop', value: { stopped: true } },
    'stopping a live session answers stopped')
  assert.equal(agents.cancelled.length, 1, 'the live handle was cancelled once')
  assert.deepEqual(agents.cancelled[0], { id: 'live-1', cause: { kind: 'user' }, options: { keepInbox: true } },
    'cancel matches the sidebar stop: user cause and keepInbox')

  const absent = await api.act({ action: 'session.stop', payload: { sessionId: 'gone' } })
  assert.deepEqual(absent, { ok: true, action: 'session.stop', value: { stopped: false, reason: 'not_live' } },
    'a session without a live handle is not_live, not a failure')
  assert.equal(agents.cancelled.length, 1, 'nothing was cancelled for a session that is not live')

  const missing = await api.act({ action: 'session.stop', payload: {} })
  assert.equal(missing.ok, true, 'a payload without an id is answered, not thrown')
  assert.equal(missing.value.stopped, false, 'a payload without an id stops nothing')
  assert.equal(typeof missing.value.reason, 'string', 'a payload without an id carries a reason')
  console.log('  session.stop: cancel({ kind: "user" }, { keepInbox: true }), not_live, and a missing id are all structured')
}

// ------------------------------------------------------------- act errors

{
  const unknown = await api.act({ action: 'no.such.action' })
  assert.deepEqual(unknown, { ok: false, action: 'no.such.action', error: 'unknown action: no.such.action' },
    'an unknown action is answered structurally')
  const nameless = await api.act({})
  assert.equal(nameless.ok, false, 'act without an action id is refused')
  assert.equal(typeof nameless.error, 'string', 'a refused act carries an error message')
  const bare = await api.act()
  assert.equal(bare.ok, false, 'act without options is refused, not thrown')
  console.log('  act: unknown actions and missing arguments are refusals with a message')
}

// -------------------------------------------------------------- collect

{
  const first = await api.collect({ names: ['runtime'] })
  assert.equal(typeof first.at, 'number', 'a collect batch carries its timestamp')
  const runtime = first.entries.runtime
  assert.equal(runtime.name, 'runtime', 'the runtime entry names itself')
  assert.equal(runtime.error, null, 'the runtime entry loaded without an error')
  assert.equal(runtime.stale, false, 'the runtime entry is fresh inside its TTL')
  assert.equal(runtime.value.available, true, 'the runtime entry reports the services as available')
  assert.deepEqual(runtime.value.agents, { total: 2, running: 1, idle: 1, roots: 1 },
    'the runtime summary counts agents by status and roots')
  assert.equal(runtime.value.sessions.total, 3, 'the runtime summary counts sessions')
  assert.equal(typeof runtime.value.at, 'number', 'the runtime value stamps its own read')

  const loaded = agents.listCalls
  const cached = await api.collect({ names: ['runtime'] })
  assert.equal(cached.entries.runtime.value.agents.total, 2, 'a second read answers from the cache')
  assert.equal(agents.listCalls, loaded, 'a second read inside the TTL does not reload')

  const forced = await api.collect({ names: ['runtime'], force: true })
  assert.equal(forced.entries.runtime.value.agents.total, 2, 'a forced read answers the same shape')
  assert.equal(agents.listCalls, loaded + 1, 'force reloads the runtime item')

  const unknown = await api.collect({ names: ['none'] })
  assert.equal(unknown.entries.none.error, 'unknown collector item: none',
    'an unknown name is a structured entry, not a throw')

  const everything = await api.collect({})
  assert.ok(Object.keys(everything.entries).includes('runtime'), 'collect without names reads every item')
  console.log('  collect: runtime summary, TTL cache, force reload and unknown names')
}

// ------------------------------------------------- service-less degradation

{
  const bare = mount({})
  const batch = await bare.api.collect({ names: ['runtime'] })
  const runtime = batch.entries.runtime
  assert.equal(runtime.value.available, false, 'without services the runtime item reports unavailable')
  assert.equal(typeof runtime.value.reason, 'string', 'the unavailable runtime item carries a reason')
  assert.deepEqual(runtime.value.agents, { total: 0, running: 0, idle: 0, roots: 0 },
    'without services the runtime item keeps an empty agent structure')
  assert.equal(runtime.value.sessions.total, 0, 'without services the session count stays zero')
  assert.equal(runtime.error, null, 'a degraded runtime read is not an error')

  const stopped = await bare.api.act({ action: 'session.stop', payload: { sessionId: 's-1' } })
  assert.equal(stopped.ok, true, 'a stop without an agent registry is answered, not thrown')
  assert.equal(stopped.value.stopped, false, 'a stop without an agent registry stops nothing')
  assert.equal(typeof stopped.value.reason, 'string', 'a stop without an agent registry says why')
  console.log('  degradation: no agents/sessions services still answers collect and act')
}

// ------------------------------------------------ a throwing registry

{
  const broken = mount({
    agents: {
      list() { throw new Error('registry exploded') },
      get() { throw new Error('registry exploded') },
    },
  })
  const batch = await broken.api.collect({ names: ['runtime'] })
  assert.equal(batch.entries.runtime.value.available, false, 'a throwing registry degrades the runtime item')
  assert.ok(batch.entries.runtime.value.reason.includes('registry exploded'),
    'the degradation names the underlying failure')
  const stopped = await broken.api.act({ action: 'session.stop', payload: { sessionId: 's-1' } })
  assert.equal(stopped.ok, false, 'a throwing registry turns a stop into a structured failure')
  assert.ok(stopped.error.includes('registry exploded'), 'the failure carries the registry message')
  console.log('  throwing registry: both endpoints stay structured')
}

console.log('actions: all sections passed')
