/**
 * dsh-homepage — Host half, shared collector.
 *
 * One cache in front of every host-side read the plugin performs on demand. A
 * card asks for a named item; the collector answers from its cache and calls
 * that item's `load` only when the cached value is missing, expired, or was
 * invalidated. Concurrent reads of the same item share one load, so a panel
 * that mounts ten cards asks the host once.
 *
 * Contract:
 *
 *  - `define(name, spec)` registers one item. A name is defined once; defining
 *    it again throws, because a silent second definition would be a bug in the
 *    plugin rather than in the data;
 *  - `read(name)` never rejects. A loader that throws is reported in the
 *    returned `error` field and the last successful value stays in place;
 *  - `read` answers `{ name, value, at, stale, error }`. `at` is the epoch
 *    milliseconds of the last successful load (null before the first one) and
 *    `stale` is true when the value is past its TTL, was invalidated, or was
 *    never loaded;
 *  - an unknown name is answered with a structured error, not a throw;
 *  - `snapshot(names)` reads several items at once, and one failing item never
 *    hides the others;
 *  - `subscribe(fn)` reports every loaded value and every invalidation. A
 *    throwing subscriber is logged and otherwise ignored;
 *  - `bind(ctx, mapping)` maps host events to `invalidate`. Events are an
 *    optimisation, never a requirement: a context without `on` is accepted and
 *    the collector keeps working on TTL alone;
 *  - `now` and `logger` are injectable, which is what lets the unit test drive
 *    the clock by hand.
 *
 * @module dsh-homepage/host/collector
 */

/** Default freshness window of an item, in milliseconds. */
const DEFAULT_TTL_MS = 30000

/**
 * Describe one thrown value for the structured error fields.
 * @param {unknown} error - whatever the loader threw.
 * @returns {string} a message that is never empty.
 */
function messageOf(error) {
  if (error instanceof Error && error.message !== '') return error.message
  const text = String(error === undefined ? '' : error)
  return text === '' ? 'unknown failure' : text
}

/**
 * Create one collector.
 * @param {object} [options] - injectable environment.
 * @param {() => number} [options.now] - clock, in epoch milliseconds.
 * @param {object} [options.logger] - receives `warn` lines; `console` by default.
 * @returns {object} the collector API.
 */
export function createCollector(options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const now = typeof settings.now === 'function' ? settings.now : Date.now
  const logger = settings.logger || console

  /** @type {Map<string, object>} */
  const entries = new Map()
  /** @type {Set<Function>} */
  const listeners = new Set()
  let disposed = false

  /**
   * Log one diagnostic line. Logging never breaks a read.
   * @param {string} text - the line.
   * @returns {void}
   */
  function warn(text) {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(text)
    } catch {
      /* a broken logger must not turn a cache miss into a failure */
    }
  }

  /**
   * Is the cached value of one entry still inside its freshness window?
   * @param {object} entry - the registry entry.
   * @returns {boolean} true when a read may answer without loading.
   */
  function fresh(entry) {
    if (!entry.loaded || entry.dirty) return false
    return now() - entry.at < entry.ttlMs
  }

  /**
   * Shape one entry as the public read result.
   * @param {object} entry - the registry entry.
   * @returns {{ name: string, value: unknown, at: number|null, stale: boolean, error: string|null }}
   *   the read result.
   */
  function result(entry) {
    return {
      name: entry.name,
      value: entry.loaded ? entry.value : null,
      at: entry.loaded ? entry.at : null,
      stale: !fresh(entry),
      error: entry.error,
    }
  }

  /**
   * Deliver one result to every subscriber.
   * @param {string} name - the item that changed.
   * @param {object} entry - the registry entry.
   * @returns {void}
   */
  function notify(name, entry) {
    if (disposed || listeners.size === 0) return
    const payload = result(entry)
    for (const listener of [...listeners]) {
      try {
        listener(payload)
      } catch (error) {
        warn('collector: listener for "' + name + '" failed: ' + messageOf(error))
      }
    }
  }

  /**
   * Load one entry, sharing an in-flight load with every concurrent reader.
   * @param {object} entry - the registry entry.
   * @returns {Promise<object>} the read result after the attempt.
   */
  function ensureLoaded(entry) {
    if (entry.pending) return entry.pending
    const startedAt = now()
    const attempt = (async () => {
      try {
        const value = await entry.load({ name: entry.name, startedAt })
        entry.value = value
        entry.at = now()
        entry.loaded = true
        entry.dirty = false
        entry.error = null
      } catch (error) {
        entry.error = messageOf(error)
        warn('collector: "' + entry.name + '" failed to load: ' + entry.error)
      }
      return result(entry)
    })()
    // The promise is the lock: a second read during this load awaits it instead
    // of starting a second one. It is released in the settle handler below.
    entry.pending = attempt
    const settle = () => {
      if (entry.pending === attempt) entry.pending = null
      notify(entry.name, entry)
    }
    attempt.then(settle, settle)
    return attempt
  }

  /**
   * Register one collectable item.
   * @param {string} name - the item name a reader asks for.
   * @param {object} spec - the definition.
   * @param {number} [spec.ttlMs] - freshness window; 30000 ms by default.
   * @param {(info: { name: string, startedAt: number }) => Promise<unknown>} spec.load
   *   the loader, called at most once per in-flight read.
   * @param {string[]} [spec.events] - host events that invalidate this item,
   *   used by `bind` when no explicit mapping is given.
   * @returns {string} the registered name.
   */
  function define(name, spec) {
    const key = String(name === undefined || name === null ? '' : name).trim()
    if (key === '') throw new TypeError('collector: an item needs a name')
    if (entries.has(key)) throw new Error('collector: "' + key + '" is already defined')
    if (spec === null || typeof spec !== 'object') {
      throw new TypeError('collector: "' + key + '" needs a definition object')
    }
    if (typeof spec.load !== 'function') {
      throw new TypeError('collector: "' + key + '" needs a load function')
    }
    const ttlMs = spec.ttlMs === undefined ? DEFAULT_TTL_MS : Number(spec.ttlMs)
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new TypeError('collector: "' + key + '" needs a non-negative ttlMs')
    }
    const events = Array.isArray(spec.events) ? spec.events.map((event) => String(event)) : []
    entries.set(key, {
      name: key,
      ttlMs,
      load: spec.load,
      events,
      value: null,
      at: null,
      loaded: false,
      dirty: false,
      error: null,
      pending: null,
    })
    return key
  }

  /**
   * Read one item, loading it when the cached value is not fresh.
   * @param {string} name - the item name.
   * @param {object} [readOptions] - read options.
   * @param {boolean} [readOptions.force] - load even when the cache is fresh.
   * @returns {Promise<object>} the read result; never rejects.
   */
  async function read(name, readOptions = {}) {
    const key = String(name === undefined || name === null ? '' : name)
    const entry = entries.get(key)
    if (!entry) {
      return {
        name: key,
        value: null,
        at: null,
        stale: true,
        error: 'unknown collector item: ' + key,
      }
    }
    const force = Boolean(readOptions && readOptions.force)
    if (force || !fresh(entry)) await ensureLoaded(entry)
    return result(entry)
  }

  /**
   * Mark items as expired without loading them.
   * @param {string} name - one item name, or `'*'` for every item.
   * @returns {number} how many items were marked.
   */
  function invalidate(name) {
    const key = String(name === undefined || name === null ? '' : name)
    const targets = key === '*' ? [...entries.values()] : entries.has(key) ? [entries.get(key)] : []
    for (const entry of targets) {
      entry.dirty = true
      notify(entry.name, entry)
    }
    return targets.length
  }

  /**
   * Read several items; one failing item never hides the others.
   * @param {string[]} [names] - the items to read; every item when omitted.
   * @param {object} [snapshotOptions] - options forwarded to every `read`, so
   *   `{ force: true }` refreshes the whole batch.
   * @returns {Promise<{ at: number, entries: Record<string, object> }>} the batch.
   */
  async function snapshot(names, snapshotOptions = {}) {
    const list = Array.isArray(names) && names.length > 0
      ? names.map((name) => String(name))
      : [...entries.keys()]
    const results = await Promise.all(list.map((name) => read(name, snapshotOptions)))
    /** @type {Record<string, object>} */
    const byName = {}
    for (const item of results) byName[item.name] = item
    return { at: now(), entries: byName }
  }

  /**
   * Watch every change and invalidation.
   * @param {(result: object) => void} listener - receives one read result.
   * @returns {() => void} unsubscribe.
   */
  function subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('collector: subscribe needs a function')
    }
    listeners.add(listener)
    return function unsubscribe() {
      listeners.delete(listener)
    }
  }

  /**
   * Map host events onto `invalidate`.
   *
   * Without an explicit mapping the declared `events` of every item are used.
   * A target may be one item name, an array of them, or `'*'`. A context
   * without `on` (a test context, a transport without events) is accepted
   * silently: events are an optimisation, TTL still expires the cache.
   *
   * @param {object} ctx - the plugin context, or any object exposing `on`.
   * @param {Record<string, string|string[]>} [mapping] - event name to target.
   * @returns {() => void} unbind.
   */
  function bind(ctx, mapping) {
    const releases = []
    if (disposed || !ctx || typeof ctx.on !== 'function') {
      return function unbind() {}
    }
    /** @type {Map<string, Set<string>>} */
    const plan = new Map()
    const add = (event, target) => {
      const key = String(event)
      if (!plan.has(key)) plan.set(key, new Set())
      const targets = Array.isArray(target) ? target : [target]
      for (const one of targets) plan.get(key).add(String(one))
    }
    if (mapping !== null && typeof mapping === 'object') {
      for (const event of Object.keys(mapping)) add(event, mapping[event])
    } else {
      for (const entry of entries.values()) {
        for (const event of entry.events) add(event, entry.name)
      }
    }
    for (const [event, targets] of plan) {
      const handler = function onHostEvent() {
        for (const target of targets) invalidate(target)
      }
      try {
        const off = ctx.on(event, handler)
        if (typeof off === 'function') {
          releases.push(off)
        } else if (typeof ctx.off === 'function') {
          releases.push(function offByHand() {
            try {
              ctx.off(event, handler)
            } catch {
              /* the transport may already be gone */
            }
          })
        }
      } catch (error) {
        warn('collector: cannot listen for "' + event + '": ' + messageOf(error))
      }
    }
    return function unbind() {
      while (releases.length > 0) {
        const off = releases.pop()
        try {
          off()
        } catch (error) {
          warn('collector: unbind failed: ' + messageOf(error))
        }
      }
    }
  }

  /**
   * Is this item defined?
   * @param {string} name - the item name.
   * @returns {boolean} true when it is registered.
   */
  function has(name) {
    return entries.has(String(name === undefined || name === null ? '' : name))
  }

  /**
   * Every registered item name, in definition order.
   * @returns {string[]} the names; a fresh array.
   */
  function names() {
    return [...entries.keys()]
  }

  /**
   * Release every subscriber and forget every item.
   * @returns {void}
   */
  function dispose() {
    disposed = true
    listeners.clear()
    entries.clear()
  }

  return { define, read, invalidate, snapshot, subscribe, bind, has, names, dispose }
}
