/**
 * Unit test for the host-side collector (`lib/host/collector.js`).
 *
 * Plain script, no framework: `node test/collector.mjs`. The clock is a fixture
 * driven by hand and every loader is a counter, so TTL boundaries, single-flight
 * sharing and the failure paths are asserted without waiting on real time.
 *
 * Run: node test/collector.mjs
 */
import assert from 'node:assert/strict'
import { createCollector } from '../lib/host/collector.js'

console.log('collector: driving the cache with a hand-held clock')

/**
 * Build a collector around a mutable clock.
 * @param {number} [startAt] - first epoch millisecond.
 * @returns {{ collector: object, advance: (ms: number) => void, at: () => number }}
 *   the collector and the clock controls.
 */
function fixture(startAt = 1_000_000) {
  let clock = startAt
  const noisy = { warn() {} }
  const collector = createCollector({ now: () => clock, logger: noisy })
  return {
    collector,
    advance(ms) { clock += ms },
    at() { return clock },
  }
}

/**
 * Build a loader that counts its calls and answers a scripted sequence.
 * @param {Array<unknown>} [values] - one answer per call; a function answer is
 *   invoked with the call number.
 * @returns {{ load: Function, calls: () => number }} the loader and its counter.
 */
function counterLoader(values = []) {
  const calls = []
  return {
    calls: () => calls.length,
    load: async (info) => {
      const index = calls.length
      calls.push(info)
      const answer = values[index % Math.max(values.length, 1)]
      if (typeof answer === 'function') return answer(index)
      return answer === undefined ? 'value-' + index : answer
    },
  }
}

// ------------------------------------------------------- ttl hit and expiry

{
  const { collector, advance, at } = fixture()
  const loader = counterLoader(['first', 'second'])
  collector.define('plain', { load: loader.load })

  const first = await collector.read('plain')
  assert.equal(first.name, 'plain', 'the result carries the item name')
  assert.equal(first.value, 'first', 'the first read loads the value')
  assert.equal(first.at, at(), 'at is the clock reading of the successful load')
  assert.equal(first.stale, false, 'a just-loaded value is fresh')
  assert.equal(first.error, null, 'a successful load reports no error')
  assert.equal(loader.calls(), 1, 'the loader ran once')

  advance(29_999)
  const cached = await collector.read('plain')
  assert.equal(cached.value, 'first', 'a read inside the TTL answers from the cache')
  assert.equal(cached.stale, false, 'a value inside its TTL is not stale')
  assert.equal(loader.calls(), 1, 'the loader did not run again inside the TTL')
  assert.equal(cached.at, first.at, 'the cache timestamp is unchanged')

  advance(1)
  const expired = await collector.read('plain')
  assert.equal(expired.value, 'second', 'a read at the TTL boundary reloads')
  assert.equal(expired.stale, false, 'the refreshed value is fresh again')
  assert.equal(loader.calls(), 2, 'the loader ran once per expiry')
  console.log('  ttl: cache inside the window, reload exactly at the boundary')
}

// --------------------------------------------------------------- force read

{
  const { collector } = fixture()
  const loader = counterLoader(['a', 'b', 'c'])
  collector.define('forced', { load: loader.load })

  await collector.read('forced')
  const forced = await collector.read('forced', { force: true })
  assert.equal(forced.value, 'b', 'force loads even though the cache is fresh')
  assert.equal(loader.calls(), 2, 'force reached the loader')
  const again = await collector.read('forced')
  assert.equal(again.value, 'b', 'the forced value is cached for later reads')
  assert.equal(loader.calls(), 2, 'a plain read after force does not reload')
  console.log('  force: bypasses the freshness window, then caches the result')
}

// ---------------------------------------------------------- single flight

{
  const { collector } = fixture()
  const gate = { release: null, promise: null }
  gate.promise = new Promise((resolve) => { gate.release = resolve })
  let calls = 0
  collector.define('slow', {
    load: async () => {
      calls += 1
      await gate.promise
      return 'shared'
    },
  })

  const reads = Promise.all([collector.read('slow'), collector.read('slow'), collector.read('slow')])
  assert.equal(calls, 1, 'the loader started once for three concurrent reads')
  gate.release()
  const results = await reads
  assert.equal(calls, 1, 'concurrent reads shared one load')
  for (const result of results) {
    assert.equal(result.value, 'shared', 'every concurrent reader saw the loaded value')
    assert.equal(result.stale, false, 'every concurrent reader saw a fresh value')
  }
  console.log('  single flight: three concurrent reads loaded once and shared the value')
}

// ------------------------------------------------- failure keeps last value

{
  const { collector, advance } = fixture()
  let calls = 0
  collector.define('flaky', {
    ttlMs: 10,
    load: async () => {
      calls += 1
      if (calls === 1) return 'good'
      throw new Error('probe offline')
    },
  })

  const good = await collector.read('flaky')
  assert.equal(good.value, 'good', 'the first load succeeds')
  advance(10)
  const failed = await collector.read('flaky')
  assert.equal(failed.value, 'good', 'a failing reload keeps the last good value')
  assert.equal(failed.error, 'probe offline', 'the failure is reported in error')
  assert.equal(failed.stale, true, 'a value whose reload failed is stale')
  assert.equal(failed.at, good.at, 'the timestamp still describes the last success')

  advance(10)
  const retried = await collector.read('flaky')
  assert.equal(calls, 3, 'the next read retries after a failed load')
  assert.equal(retried.value, 'good', 'the good value survives another failure')
  console.log('  failure: the last good value is kept, error is surfaced, reads retry')
}

// ------------------------------------------------------- failure before load

{
  const { collector, advance } = fixture()
  collector.define('broken', {
    ttlMs: 5,
    load: async () => { throw new Error('never ready') },
  })

  const first = await collector.read('broken')
  assert.equal(first.value, null, 'a never-loaded item reads as null, not undefined')
  assert.equal(first.at, null, 'a never-loaded item has no timestamp')
  assert.equal(first.error, 'never ready', 'the first failure is reported')
  assert.equal(first.stale, true, 'a never-loaded item is stale')

  advance(5)
  const second = await collector.read('broken')
  assert.equal(second.value, null, 'a repeated failure still reads as null')
  assert.equal(second.error, 'never ready', 'the repeated failure is reported')
  console.log('  first failure: value null, at null, error set, reads keep retrying')
}

// ------------------------------------------------------------- invalidate

{
  const { collector } = fixture()
  const loader = counterLoader(['one', 'two', 'three'])
  collector.define('a', { load: loader.load })
  collector.define('b', { load: counterLoader(['bee']).load })
  const seen = []
  collector.subscribe((result) => seen.push(result.name + ':' + result.stale))

  await collector.read('a')
  assert.equal(loader.calls(), 1, 'a loaded once')
  const marked = collector.invalidate('a')
  assert.equal(marked, 1, 'invalidate reports how many items it marked')
  assert.ok(seen.includes('a:true'), 'invalidation notifies subscribers')
  const reloaded = await collector.read('a')
  assert.equal(reloaded.value, 'two', 'an invalidated item reloads on the next read')
  assert.equal(loader.calls(), 2, 'invalidate itself did not load; the read did')

  const all = collector.invalidate('*')
  assert.equal(all, 2, '* marks every defined item')
  assert.equal(loader.calls(), 2, 'marking every item still loads nothing')
  await collector.read('a')
  await collector.read('b')
  assert.equal(loader.calls(), 3, 'each invalidated item loads on its next read')
  assert.equal(collector.invalidate('missing'), 0, 'an unknown name marks nothing')
  console.log('  invalidate: marks stale without loading, notifies, one or every item')
}

// ---------------------------------------------------------------- snapshot

{
  const { collector } = fixture()
  collector.define('ok', { load: async () => ({ ready: true }) })
  collector.define('bad', { load: async () => { throw new Error('nope') } })

  const batch = await collector.snapshot(['ok', 'bad'])
  assert.equal(typeof batch.at, 'number', 'the batch carries its own timestamp')
  assert.deepEqual(Object.keys(batch.entries).sort(), ['bad', 'ok'], 'every asked item is present')
  assert.deepEqual(batch.entries.ok.value, { ready: true }, 'the healthy item answered')
  assert.equal(batch.entries.ok.error, null, 'the healthy item has no error')
  assert.equal(batch.entries.bad.value, null, 'the failing item reads as null')
  assert.equal(batch.entries.bad.error, 'nope', 'the failing item carries its error')
  assert.equal(batch.entries.bad.stale, true, 'the failing item is stale')
  assert.equal((await collector.snapshot(['nope'])).entries.nope.stale, true, 'an unknown name is stale')

  const everything = await collector.snapshot()
  assert.deepEqual(Object.keys(everything.entries).sort(), ['bad', 'ok'], 'no names means every item')

  const loader = counterLoader(['fresh'])
  collector.define('forced-batch', { load: loader.load })
  await collector.read('forced-batch')
  assert.equal(loader.calls(), 1, 'the batch item loaded once')
  await collector.snapshot(['forced-batch'], { force: true })
  assert.equal(loader.calls(), 2, 'snapshot forwards force to every read')
  console.log('  snapshot: partial failure is contained, unknown names answer structurally')
}

// --------------------------------------------------------------- subscribe

{
  const { collector, advance } = fixture()
  collector.define('watched', { ttlMs: 10, load: async () => 'tick' })
  const seen = []
  const off = collector.subscribe((result) => seen.push(result))
  await collector.read('watched')
  assert.equal(seen.length, 1, 'a load notifies once')
  assert.equal(seen[0].name, 'watched', 'the payload carries the item name')
  advance(10)
  await collector.read('watched')
  assert.equal(seen.length, 2, 'a reload notifies again')
  off()
  advance(10)
  await collector.read('watched')
  assert.equal(seen.length, 2, 'unsubscribed listeners hear nothing')

  const second = collector.subscribe(() => { throw new Error('handler bug') })
  assert.doesNotThrow(() => collector.invalidate('watched'), 'a throwing subscriber is contained')
  second()
  assert.throws(() => collector.subscribe('not a function'), TypeError, 'subscribe validates its argument')
  console.log('  subscribe: load and invalidation notify, unsubscribe stops, throws are contained')
}

// ------------------------------------------------------------- definitions

{
  const { collector } = fixture()
  collector.define('named', { load: async () => 1 })
  assert.throws(() => collector.define('named', { load: async () => 2 }), /already defined/, 'a duplicate definition throws')
  assert.throws(() => collector.define('', { load: async () => 1 }), TypeError, 'an empty name throws')
  assert.throws(() => collector.define('no-load', {}), TypeError, 'a definition without load throws')
  assert.throws(() => collector.define('bad-ttl', { load: async () => 1, ttlMs: -1 }), TypeError, 'a negative ttl throws')
  assert.equal(collector.has('named'), true, 'has answers for a defined item')
  assert.equal(collector.has('other'), false, 'has is false for an unknown item')
  assert.deepEqual(collector.names(), ['named'], 'names lists the definitions in order')
  const unknown = await collector.read('other')
  assert.equal(unknown.error, 'unknown collector item: other', 'an unknown read names the item')
  assert.equal(unknown.value, null, 'an unknown read has no value')
  console.log('  definitions: duplicates and bad specs throw, unknown reads answer structurally')
}

// -------------------------------------------------------------------- bind

{
  const { collector } = fixture()
  const handlers = new Map()
  const fakeCtx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
  }
  const loader = counterLoader(['v1', 'v2'])
  collector.define('runtime', { load: loader.load, events: ['agent/status'] })
  await collector.read('runtime')

  const unbind = collector.bind(fakeCtx)
  assert.equal(typeof handlers.get('agent/status'), 'function', 'declared events are bound')
  handlers.get('agent/status')()
  const afterEvent = await collector.read('runtime')
  assert.equal(afterEvent.value, 'v2', 'a host event invalidates the item')
  assert.equal(loader.calls(), 2, 'the read after the event reloaded')

  unbind()
  assert.equal(handlers.size, 0, 'unbind releases every listener')

  const mapped = createCollector({ now: () => 0, logger: { warn() {} } })
  mapped.define('one', { load: async () => 1 })
  const explicit = new Map()
  const off = mapped.bind({ on(event, handler) { explicit.set(event, handler); return () => explicit.delete(event) } },
    { 'custom/event': ['one'] })
  assert.equal(typeof explicit.get('custom/event'), 'function', 'an explicit mapping is bound')
  off()
  assert.equal(explicit.size, 0, 'an explicit mapping can be released')

  assert.equal(typeof createCollector().bind({}, {}), 'function', 'a context without on degrades to a no-op')
  assert.equal(typeof createCollector().bind(null, null), 'function', 'a missing context degrades to a no-op')
  console.log('  bind: declared events and explicit mappings invalidate, missing on degrades silently')
}

// ----------------------------------------------------------------- dispose

{
  const { collector } = fixture()
  collector.define('gone', { load: async () => 1 })
  let heard = 0
  collector.subscribe(() => { heard += 1 })
  await collector.read('gone')
  assert.equal(heard, 1, 'the subscriber heard the load')
  collector.dispose()
  const after = await collector.read('gone')
  assert.equal(after.error, 'unknown collector item: gone', 'a disposed collector forgot its items')
  assert.equal(heard, 1, 'disposal silences subscribers')
  console.log('  dispose: subscribers are cleared and items are forgotten without a throw')
}

console.log('collector: all sections passed')
