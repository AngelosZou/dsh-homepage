/**
 * dsh-homepage — Host half, shared action layer.
 *
 * The write side of the collector contract. Cards and the homepage tool
 * ask the host to do one named thing — open, stop, run — and the action layer
 * owns the registry, the argument check, and the error shape. Every failure is
 * a structured result rather than an exception, because the caller is a card
 * in someone else's window: it renders `{ ok: false, error }` instead of
 * unwinding through React.
 *
 * Contract:
 *
 *  - `register(id, spec)` registers one action. A duplicate id throws, because
 *    a second definition silently shadowing the first would be a plugin bug and
 *    not a data problem;
 *  - `run(id, payload)` never throws. An unknown action, a rejected argument
 *    check, and a throwing `run` all come back as `{ ok: false, action, error }`;
 *  - a successful call answers `{ ok: true, action, value }`, where `value` is
 *    whatever `run` returned (a promise is awaited);
 *  - `validate(payload)` may be async; a rejection is reported exactly like a
 *    failure from `run`, so the card cannot tell (and cannot care) which one
 *    refused the call;
 *  - `run` receives `(payload, context)`; the context is fixed when the layer
 *    is created, so every action sees the same plugin services;
 *  - `has(id)` and `list()` answer what is registered without running anything.
 *
 * @module dsh-homepage/host/actions
 */

/**
 * Describe one thrown value for the structured error field.
 * @param {unknown} error - whatever the action threw.
 * @returns {string} a message that is never empty.
 */
function messageOf(error) {
  if (error instanceof Error && error.message !== '') return error.message
  const text = String(error === undefined ? '' : error)
  return text === '' ? 'unknown failure' : text
}

/**
 * Create one action layer.
 * @param {object} [options] - injectable environment.
 * @param {object} [options.logger] - receives `warn`/`error` lines; `console` by default.
 * @param {object} [options.context] - handed to every `run(payload, context)`.
 * @returns {object} the action layer API.
 */
export function createActions(options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const logger = settings.logger || console
  const context = settings.context === undefined ? null : settings.context

  /** @type {Map<string, { run: Function, validate: Function|null }>} */
  const registry = new Map()

  /**
   * Log one diagnostic line. Logging never breaks a call.
   * @param {string} text - the line.
   * @returns {void}
   */
  function warn(text) {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(text)
    } catch {
      /* a broken logger must not turn a refusal into an exception */
    }
  }

  /**
   * Register one action.
   * @param {string} id - the action id a caller asks for.
   * @param {object} spec - the definition.
   * @param {(payload: unknown, context: unknown) => Promise<unknown>|unknown} spec.run
   *   performs the action.
   * @param {(payload: unknown) => void|Promise<void>} [spec.validate] - argument
   *   check, run before `run`; a rejection refuses the call.
   * @returns {() => boolean} unregister: true when this registration was still
   *   the live one.
   */
  function register(id, spec) {
    const key = String(id === undefined || id === null ? '' : id).trim()
    if (key === '') throw new TypeError('actions: an action needs an id')
    if (registry.has(key)) throw new Error('actions: "' + key + '" is already registered')
    if (spec === null || typeof spec !== 'object') {
      throw new TypeError('actions: "' + key + '" needs a definition object')
    }
    if (typeof spec.run !== 'function') {
      throw new TypeError('actions: "' + key + '" needs a run function')
    }
    if (spec.validate !== undefined && typeof spec.validate !== 'function') {
      throw new TypeError('actions: "' + key + '" validate must be a function')
    }
    const registration = { run: spec.run, validate: spec.validate || null }
    registry.set(key, registration)
    return function unregister() {
      if (registry.get(key) !== registration) return false
      registry.delete(key)
      return true
    }
  }

  /**
   * Is this action registered?
   * @param {string} id - the action id.
   * @returns {boolean} true when it is.
   */
  function has(id) {
    return registry.has(String(id === undefined || id === null ? '' : id).trim())
  }

  /**
   * Every registered action id, in registration order.
   * @returns {string[]} the ids; a fresh array.
   */
  function list() {
    return [...registry.keys()]
  }

  /**
   * Run one action. Never rejects.
   * @param {string} id - the action id.
   * @param {unknown} [payload] - the arguments the caller passed.
   * @returns {Promise<{ ok: true, action: string, value: unknown }
   *   | { ok: false, action: string, error: string }>} the structured outcome.
   */
  async function run(id, payload) {
    const key = String(id === undefined || id === null ? '' : id).trim()
    const action = registry.get(key)
    if (!action) return { ok: false, action: key, error: 'unknown action: ' + key }
    try {
      if (action.validate !== null) await action.validate(payload)
      const value = await action.run(payload, context)
      return { ok: true, action: key, value }
    } catch (error) {
      const message = messageOf(error)
      warn('actions: "' + key + '" failed: ' + message)
      return { ok: false, action: key, error: message }
    }
  }

  return { register, has, list, run }
}
