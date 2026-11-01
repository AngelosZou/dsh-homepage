/**
 * dsh-homepage — Host half, tool usage folded out of session logs.
 *
 * Nothing in the harness core keeps a per-tool counter, so this module reads the
 * session event logs themselves and folds `tool/call` / `tool/result` pairs into
 * a small aggregate: how often each tool was called, how large the arguments the
 * model produced were, how large the model-facing output was, how many calls
 * failed and how long they took. The same numbers are re-projected per project
 * (a project is a session's working directory) at read time, never baked into
 * the store.
 *
 * The aggregate is incremental and file-backed:
 *
 *  - one JSON document, `<root>/tool-usage.json`, written atomically (temp file
 *    then rename, with a direct write as the fallback);
 *  - every session carries `cursor`, the next event `seq` to read, plus the
 *    calls still waiting for a result (`pending`, keyed by `callId`). A paired
 *    result is folded even when it arrives in a later pass, because pairing is
 *    by id and the pending record survives the pass that recorded the call;
 *  - a pass reads only events with `seq >= cursor`: live sessions through
 *    `snapshotEvents()` sliced from the cursor, stored sessions through
 *    `open(id, 'read')` → `read(cursor, batch)` → `close()` in `try/finally`;
 *  - caps bound one pass (sessions, events per session, pending calls). Hitting
 *    one stops the pass at a clean event boundary, advances the cursor only over
 *    the consumed prefix, sets `partial: true`, and leaves the rest for the
 *    next sample, so a pass is never counted twice;
 *  - reads never throw: a missing/corrupt index starts empty, a missing
 *    persistence service is a documented fact, and an unreadable session is
 *    counted and skipped.
 *
 * Fold rules (deliberately literal, because the card labels the result):
 *
 *  - `calls` +1 per `tool/call`; `errors` +1 when the matching `tool/result` has
 *    `message.isError === true` or carries `data.error`;
 *  - `argChars` is exactly `String(arguments).length` of the raw JSON string the
 *    model produced — no reformatting, spaces as-is;
 *  - `outChars` is the model-facing text: the `content` text blocks joined with
 *    a newline (a bare string block, or `{ type: 'text', text }`) when at least
 *    one text block exists, otherwise `JSON.stringify(message).length`;
 *  - `ms` is `result.time - call.time`, clamped to 0 for a negative or missing
 *    delta;
 *  - `argTokens` / `outTokens` are accumulated per folded string with
 *    {@link estimateTokens}, because the estimate is not linear in characters
 *    (CJK text costs more per character than ASCII). The rollup therefore sums
 *    per-call estimates rather than re-estimating a character total.
 *
 * {@link estimateTokens} is an approximation (CJK code points / 1.5, everything
 * else / 4, rounded up); the card must render it with "≈". Tools are identified
 * by the event's `name`; project keys are normalized working directories.
 *
 * @module dsh-homepage/host/tool-usage
 */

import fs from 'node:fs/promises'
import nodePath from 'node:path'

/** Version of the on-disk aggregate; a foreign version is read defensively. */
const INDEX_VERSION = 1

/** Caps for identifiers read from the session log. */
const ID_MAX = 200
const CWD_MAX = 1000
const TOOL_NAME_MAX = 200
const CALL_ID_MAX = 200

/** A hostile index cannot make one session hold unbounded tool names. */
const MAX_TOOL_NAMES_PER_SESSION = 2000

/** Keys that must never be written as ordinary properties. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Default pass bounds; `limits` overrides any of them. */
const DEFAULT_LIMITS = {
  maxSessionsPerPass: 80,
  maxEventsPerSession: 20000,
  maxPending: 2000,
  readBatch: 500,
  maxTools: 40,
  maxProjectTools: 12,
  maxProjectTop: 3,
  memoMs: 0,
}

/**
 * Describe one thrown value for a structured reason field.
 * @param {unknown} error - whatever was thrown.
 * @returns {string} a message that is never empty.
 */
function messageOf(error) {
  if (error instanceof Error && error.message !== '') return error.message
  const text = String(error === undefined ? '' : error)
  return text === '' ? 'unknown failure' : text
}

/**
 * Coerce a value into a plain record.
 * @param {unknown} value - anything.
 * @returns {object} the record, or an empty one.
 */
function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/**
 * Read one field from an untrusted object. Unsafe keys are refused, and a
 * throwing getter cannot escape.
 * @param {unknown} source - the untrusted record.
 * @param {string} key - the field name.
 * @returns {unknown} the field, or undefined.
 */
function safeGet(source, key) {
  if (source === null || typeof source !== 'object' || UNSAFE_KEYS.has(key)) return undefined
  try {
    return source[key]
  } catch (error) {
    return undefined
  }
}

/**
 * Own-property check that is safe for hostile keys.
 * @param {object} target - the record.
 * @param {string} key - the property name.
 * @returns {boolean} true when the property is an own property.
 */
function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key)
}

/**
 * Define an own data property, including the keys a plain assignment would
 * route through a setter (`__proto__`). Enumerable, so JSON keeps the entry.
 * @param {object} target - the record.
 * @param {string} key - the property name.
 * @param {unknown} value - the value.
 * @returns {void}
 */
function putOwn(target, key, value) {
  if (UNSAFE_KEYS.has(key)) {
    Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
    return
  }
  target[key] = value
}

/**
 * Coerce a value to text with a hard length cap. Null becomes '' rather than
 * the string "null".
 * @param {unknown} value - any stored value.
 * @param {number} max - maximum characters; Infinity leaves it alone.
 * @returns {string} the bounded text.
 */
function textOf(value, max) {
  if (value === undefined || value === null) return ''
  let text
  try {
    text = String(value)
  } catch (error) {
    return ''
  }
  return text.slice(0, max)
}

/**
 * Convert a stored value to a non-negative integer.
 * @param {unknown} value - the stored value.
 * @returns {number} a finite, non-negative integer (0 when unusable).
 */
function intOf(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.trunc(number)
}

/**
 * Convert a stored timestamp to epoch milliseconds.
 * @param {unknown} value - the stored stamp.
 * @returns {number} a finite, non-negative integer (0 when unusable).
 */
function stampOf(value) {
  return intOf(value)
}

/**
 * Round an error rate for a stable JSON document.
 * @param {number} errors - failed calls.
 * @param {number} calls - all calls.
 * @returns {number} the rate in [0, 1], to four decimals.
 */
function rateOf(errors, calls) {
  if (calls <= 0) return 0
  return Math.round((errors / calls) * 10000) / 10000
}

/**
 * Is one Unicode code point CJK-family text? CJK code points count against the
 * 1.5 characters-per-token estimate; everything else (ASCII, Latin, emoji,
 * punctuation outside the CJK blocks) counts against 4.
 * @param {number} code - a Unicode code point.
 * @returns {boolean} true for CJK ideographs, kana, Hangul and CJK punctuation.
 */
function isCjk(code) {
  return (code >= 0x1100 && code <= 0x11ff)
    || (code >= 0x2e80 && code <= 0x2eff)
    || (code >= 0x3000 && code <= 0x303f)
    || (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0x3100 && code <= 0x312f)
    || (code >= 0x31a0 && code <= 0x31ef)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xac00 && code <= 0xd7af)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xff00 && code <= 0xffef)
    || (code >= 0x20000 && code <= 0x3ffff)
}

/**
 * Estimate the number of model tokens a string costs.
 *
 * This is an approximation, not a tokenizer: CJK code points (ideographs, kana,
 * Hangul, CJK/full-width punctuation) are counted at 1.5 characters per token,
 * every other code point at 4, and the result is rounded up. The card renders
 * the number as "≈" because it is an estimate.
 *
 * @param {unknown} text - the text to measure.
 * @returns {number} the estimated token count; 0 for empty text.
 */
export function estimateTokens(text) {
  const value = text === undefined || text === null ? '' : String(text)
  if (value === '') return 0
  let cjk = 0
  let other = 0
  for (const character of value) {
    const code = character.codePointAt(0)
    if (Number.isFinite(code) && isCjk(code)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk / 1.5 + other / 4)
}

/**
 * Normalize a working directory into a project key and display label.
 *
 * The key uses forward slashes, a lower-case drive letter and no trailing slash
 * (`D:\work\app` → `D:/work/app`). A missing/empty cwd maps to the
 * unknown bucket `{ key: '', label: 'unknown' }`. The label is the last path
 * segment; the function is pure and never throws.
 *
 * @param {unknown} cwd - the session's working directory.
 * @returns {{ key: string, label: string }} the project identity.
 */
export function projectKeyOf(cwd) {
  if (typeof cwd !== 'string') return { key: '', label: 'unknown' }
  let text = cwd.trim().replace(/\\/g, '/')
  if (text === '') return { key: '', label: 'unknown' }
  if (/^[A-Za-z]:/.test(text)) text = text.charAt(0).toLowerCase() + text.slice(1)
  // Strip trailing slashes, but keep a root of just "/" meaningful.
  while (text.length > 1 && text.endsWith('/')) text = text.slice(0, -1)
  const parts = text.split('/')
  let label = ''
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index] !== '') {
      label = parts[index]
      break
    }
  }
  if (label === '') label = text !== '' ? text : 'unknown'
  return { key: text, label }
}

/**
 * Resolve an injected service: a factory is called (the profile may not have
 * the service mounted yet), a live object is used as-is.
 * @param {unknown} value - the injected service or factory.
 * @returns {object|null} the service, or null when there is none.
 */
function serviceOf(value) {
  if (typeof value === 'function') {
    try {
      const found = value()
      return found !== undefined && found !== null ? found : null
    } catch (error) {
      return null
    }
  }
  return value !== null && typeof value === 'object' ? value : null
}

/**
 * Read the pass limits, clamping every override to something usable.
 * @param {unknown} value - the caller's `limits`.
 * @returns {object} the resolved limits; a fresh object.
 */
function limitsOf(value) {
  const input = asObject(value)
  const pick = (key, fallback, minimum) => {
    const raw = Number(input[key])
    if (!Number.isFinite(raw) || raw < minimum) return fallback
    return Math.trunc(raw)
  }
  return {
    maxSessionsPerPass: pick('maxSessionsPerPass', DEFAULT_LIMITS.maxSessionsPerPass, 1),
    maxEventsPerSession: pick('maxEventsPerSession', DEFAULT_LIMITS.maxEventsPerSession, 1),
    maxPending: pick('maxPending', DEFAULT_LIMITS.maxPending, 1),
    readBatch: pick('readBatch', DEFAULT_LIMITS.readBatch, 1),
    maxTools: pick('maxTools', DEFAULT_LIMITS.maxTools, 1),
    maxProjectTools: pick('maxProjectTools', DEFAULT_LIMITS.maxProjectTools, 1),
    maxProjectTop: pick('maxProjectTop', DEFAULT_LIMITS.maxProjectTop, 1),
    memoMs: pick('memoMs', DEFAULT_LIMITS.memoMs, 0),
  }
}

/** @returns {object} an empty aggregate document; a fresh object every call. */
function emptyIndex() {
  return { version: INDEX_VERSION, at: 0, sessions: {} }
}

/** @returns {object} a zero tool aggregate; a fresh object every call. */
function zeroAggregate() {
  return { calls: 0, errors: 0, argChars: 0, outChars: 0, argTokens: 0, outTokens: 0, ms: 0 }
}

/** @returns {object} zero totals in the document's field order. */
function zeroTotals() {
  return {
    calls: 0,
    errors: 0,
    errorRate: 0,
    argChars: 0,
    outChars: 0,
    argTokens: 0,
    outTokens: 0,
    ms: 0,
  }
}

/**
 * Normalize one stored tool aggregate, field by field.
 * @param {unknown} value - the stored aggregate.
 * @returns {object} the aggregate.
 */
function readAggregate(value) {
  const source = asObject(value)
  return {
    calls: intOf(safeGet(source, 'calls')),
    errors: intOf(safeGet(source, 'errors')),
    argChars: intOf(safeGet(source, 'argChars')),
    outChars: intOf(safeGet(source, 'outChars')),
    argTokens: intOf(safeGet(source, 'argTokens')),
    outTokens: intOf(safeGet(source, 'outTokens')),
    ms: intOf(safeGet(source, 'ms')),
  }
}

/**
 * Normalize one stored session record, field by field. Unknown fields are never
 * copied, so a hostile index cannot smuggle anything into the fold.
 * @param {unknown} value - the stored session record.
 * @param {object} limits - the resolved pass limits.
 * @returns {object} the session record.
 */
function readSession(value, limits) {
  const source = asObject(value)

  const tools = {}
  const storedTools = safeGet(source, 'tools')
  if (storedTools !== null && typeof storedTools === 'object' && !Array.isArray(storedTools)) {
    let count = 0
    for (const name of Object.keys(storedTools)) {
      if (count >= MAX_TOOL_NAMES_PER_SESSION) break
      if (name === '' || UNSAFE_KEYS.has(name)) continue
      putOwn(tools, textOf(name, TOOL_NAME_MAX), readAggregate(safeGet(storedTools, name)))
      count += 1
    }
  }

  const pending = {}
  const storedPending = safeGet(source, 'pending')
  if (storedPending !== null && typeof storedPending === 'object' && !Array.isArray(storedPending)) {
    let count = 0
    for (const callId of Object.keys(storedPending)) {
      if (count >= limits.maxPending) break
      if (callId === '' || UNSAFE_KEYS.has(callId)) continue
      const record = asObject(safeGet(storedPending, callId))
      putOwn(pending, textOf(callId, CALL_ID_MAX), {
        name: textOf(safeGet(record, 'name'), TOOL_NAME_MAX) || 'unknown',
        argChars: intOf(safeGet(record, 'argChars')),
        time: stampOf(safeGet(record, 'time')),
      })
      count += 1
    }
  }

  return {
    cursor: intOf(safeGet(source, 'cursor')),
    cwd: textOf(safeGet(source, 'cwd'), CWD_MAX),
    tools,
    pending,
    firstAt: stampOf(safeGet(source, 'firstAt')),
    lastAt: stampOf(safeGet(source, 'lastAt')),
    seenAt: stampOf(safeGet(source, 'seenAt')),
  }
}

/**
 * Normalize a whole parsed index. Session ids are the object keys; unsafe keys
 * are dropped rather than trusted.
 * @param {unknown} value - the parsed JSON.
 * @param {object} limits - the resolved pass limits.
 * @returns {object} the normalized index.
 */
function readIndexValue(value, limits) {
  const parsed = asObject(value)
  const sessions = {}
  const stored = safeGet(parsed, 'sessions')
  if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const id of Object.keys(stored)) {
      if (id === '' || UNSAFE_KEYS.has(id)) continue
      putOwn(sessions, id, readSession(safeGet(stored, id), limits))
    }
  }
  return { version: INDEX_VERSION, at: stampOf(safeGet(parsed, 'at')), sessions }
}

/**
 * Get (or create) the aggregate record of one tool name.
 * @param {object} tools - the session's tool aggregates.
 * @param {string} name - the tool name.
 * @returns {object} the aggregate.
 */
function ensureTool(tools, name) {
  if (hasOwn(tools, name)) return tools[name]
  const aggregate = zeroAggregate()
  putOwn(tools, name, aggregate)
  return aggregate
}

/**
 * Count the own keys of a record.
 * @param {object} record - the record.
 * @returns {number} the key count.
 */
function countOf(record) {
  return Object.keys(record).length
}

/**
 * Advance the cursor over one consumed event.
 * @param {number} cursor - the current next-seq marker.
 * @param {number} seq - the event's seq, or NaN when unusable.
 * @returns {number} the next cursor.
 */
function advanceCursor(cursor, seq) {
  if (Number.isFinite(seq) && seq >= 0) return Math.max(cursor, Math.trunc(seq) + 1)
  return cursor + 1
}

/**
 * The model-facing text of one tool result message.
 *
 * When `content` is a string it is the text. When it is an array, every string
 * block and every `{ type: 'text', text }` block is kept and joined with a
 * newline. Otherwise — no content, or only non-text blocks — the whole message
 * is stringified, which is the documented fallback.
 *
 * @param {unknown} message - the tool result message.
 * @returns {string} the model-facing text ('' when it cannot be rendered).
 */
function outputTextOf(message) {
  if (message === undefined || message === null) return ''
  if (typeof message !== 'object') return textOf(message, Infinity)
  const content = safeGet(message, 'content')
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block)
        continue
      }
      const record = asObject(block)
      const text = safeGet(record, 'text')
      if (typeof text === 'string') parts.push(text)
    }
    if (parts.length > 0) return parts.join('\n')
  }
  try {
    const json = JSON.stringify(message)
    return typeof json === 'string' ? json : ''
  } catch (error) {
    return ''
  }
}

/**
 * The elapsed wall time of one paired call.
 * @param {unknown} resultTime - the result event's timestamp.
 * @param {number} callTime - the call's timestamp.
 * @returns {number} the non-negative delta in milliseconds.
 */
function elapsedOf(resultTime, callTime) {
  const to = Number(resultTime)
  const from = Number(callTime)
  if (!Number.isFinite(to) || !Number.isFinite(from)) return 0
  const delta = to - from
  return delta > 0 ? Math.trunc(delta) : 0
}

/**
 * Extend a session's observed tool-call time window.
 * @param {object} entry - the session record.
 * @param {unknown} time - the event timestamp.
 * @returns {void}
 */
function touchRange(entry, time) {
  const stamp = stampOf(time)
  if (stamp <= 0) return
  if (entry.firstAt === 0 || stamp < entry.firstAt) entry.firstAt = stamp
  if (stamp > entry.lastAt) entry.lastAt = stamp
}

/**
 * Return the events whose seq is at or past the cursor. The fast path assumes
 * the usual contiguous log (array index equals seq); the scan is the fallback.
 * @param {unknown} events - the session's events.
 * @param {number} cursor - the next seq to read.
 * @returns {Array<object>} the slice from the cursor.
 */
function sliceFromCursor(events, cursor) {
  const list = Array.isArray(events) ? events : []
  if (list.length === 0) return []
  if (cursor <= 0) return list
  if (cursor >= list.length) return []
  const atCursor = asObject(list[cursor])
  if (Number(asObject(atCursor).seq) === cursor) return list.slice(cursor)
  let start = 0
  while (start < list.length) {
    const seq = Number(asObject(list[start]).seq)
    if (Number.isFinite(seq) && seq >= cursor) break
    start += 1
  }
  return list.slice(start)
}

/**
 * Fold a bounded event slice into one session record. The cursor advances only
 * over events actually consumed; when a cap stops the pass, the unconsumed tail
 * is left for the next sample.
 *
 * The pending cap is the one place where stopping *before* an event is wrong: a
 * call whose result sits behind it would never become consumable, so the pass
 * could stall forever. Instead the overflowing call is counted (so the call
 * total stays correct), its pairing slot is not recorded (so its later result
 * cannot be attributed and is ignored), and the pass stops right after it. That
 * loses the output of at most one call per pass at the cap; `partial: true`
 * reports that the fold is incomplete.
 *
 * @param {object} entry - the session record; mutated.
 * @param {Array<object>} events - events at or past the cursor, in log order.
 * @param {object} limits - the resolved pass limits.
 * @returns {{ consumed: number, stopped: boolean }} how much was consumed and
 *   whether a cap stopped the pass before the end of the slice.
 */
function applyEvents(entry, events, limits) {
  let consumed = 0
  let stopped = false
  let cursor = entry.cursor
  let pendingCount = countOf(entry.pending)

  for (let position = 0; position < events.length; position += 1) {
    if (consumed >= limits.maxEventsPerSession) {
      stopped = true
      break
    }
    const event = asObject(events[position])
    const type = typeof safeGet(event, 'type') === 'string' ? safeGet(event, 'type') : ''
    const seq = Number(safeGet(event, 'seq'))
    if (Number.isFinite(seq) && seq < cursor) continue

    if (type === 'tool/call') {
      const data = asObject(safeGet(event, 'data'))
      const callId = textOf(safeGet(data, 'callId'), CALL_ID_MAX).trim()
      const alreadyPending = callId !== '' && hasOwn(entry.pending, callId)
      // `paired` is false only when the call overflows the pending cap; the call
      // is still counted, it just cannot receive a result.
      const paired = callId === '' || alreadyPending || pendingCount < limits.maxPending
      const name = textOf(safeGet(data, 'name'), TOOL_NAME_MAX).trim() || 'unknown'
      const rawArguments = safeGet(data, 'arguments')
      const argumentText = typeof rawArguments === 'string'
        ? rawArguments
        : rawArguments === undefined || rawArguments === null ? '' : textOf(rawArguments, Infinity)
      const aggregate = ensureTool(entry.tools, name)
      aggregate.calls += 1
      aggregate.argChars += argumentText.length
      aggregate.argTokens += estimateTokens(argumentText)
      if (callId !== '' && paired && !alreadyPending) {
        putOwn(entry.pending, callId, {
          name,
          argChars: argumentText.length,
          time: stampOf(safeGet(event, 'time')),
        })
        pendingCount += 1
      }
      touchRange(entry, safeGet(event, 'time'))
      consumed += 1
      cursor = advanceCursor(cursor, seq)
      if (!paired) {
        stopped = true
        break
      }
      continue
    }

    if (type === 'tool/result') {
      const data = asObject(safeGet(event, 'data'))
      const message = safeGet(data, 'message')
      const messageRecord = asObject(message)
      const callId = textOf(safeGet(messageRecord, 'toolCallId'), CALL_ID_MAX).trim()
      if (callId !== '' && hasOwn(entry.pending, callId)) {
        const pending = entry.pending[callId]
        delete entry.pending[callId]
        pendingCount = Math.max(0, pendingCount - 1)
        const aggregate = ensureTool(entry.tools, pending.name)
        const output = outputTextOf(message)
        aggregate.outChars += output.length
        aggregate.outTokens += estimateTokens(output)
        const isError = safeGet(messageRecord, 'isError') === true
        const hasError = hasOwn(data, 'error') && safeGet(data, 'error') !== undefined && safeGet(data, 'error') !== null
        if (isError || hasError) aggregate.errors += 1
        aggregate.ms += elapsedOf(safeGet(event, 'time'), pending.time)
      }
      // A result with no pending call cannot be attributed to a tool (its name
      // and argument size are unknown), so only the cursor moves past it.
      consumed += 1
      cursor = advanceCursor(cursor, seq)
      continue
    }

    consumed += 1
    cursor = advanceCursor(cursor, seq)
  }

  entry.cursor = cursor
  return { consumed, stopped }
}

/**
 * Read a bounded slice of one stored session through a read handle.
 * @param {object} persistence - the `sessionPersistence` service.
 * @param {string} sessionId - the stored session id.
 * @param {object} snapshot - the `list()` snapshot (may omit `eventCount`).
 * @param {number} cursor - the next seq to read.
 * @param {object} limits - the resolved pass limits.
 * @returns {Promise<{ events: Array<object>, more: boolean }>} the events and
 *   whether the per-pass cap left more of the log unread.
 */
async function readStored(persistence, sessionId, snapshot, cursor, limits) {
  const events = []
  let more = false
  const rawCount = Number(asObject(snapshot).eventCount)
  const knownCount = Number.isFinite(rawCount) ? Math.max(0, Math.trunc(rawCount)) : null
  // A caught-up session is not opened at all: the snapshot already proves there
  // is nothing past the cursor.
  if (knownCount !== null && cursor >= knownCount) return { events, more }
  const handle = await persistence.open(sessionId, 'read')
  try {
    let offset = Math.max(0, cursor)
    let remaining = limits.maxEventsPerSession
    while (remaining > 0) {
      let want = Math.min(limits.readBatch, remaining)
      if (knownCount !== null) {
        const left = knownCount - offset
        if (left <= 0) break
        want = Math.min(want, left)
      }
      const result = await handle.read(offset, want)
      const slice = Array.isArray(asObject(result).events) ? asObject(result).events : []
      if (slice.length === 0) break
      for (const event of slice) {
        if (events.length >= limits.maxEventsPerSession) break
        events.push(event)
      }
      const last = asObject(events[events.length - 1])
      const lastSeq = Number(last.seq)
      offset = Number.isFinite(lastSeq) && lastSeq >= 0 ? lastSeq + 1 : offset + slice.length
      remaining = limits.maxEventsPerSession - events.length
      if (slice.length < want) break
      if (events.length >= limits.maxEventsPerSession) {
        // Without a stored event count, a full cap is a "maybe more" answer:
        // the next pass reads again and finds an empty slice if it was the end.
        more = knownCount === null ? true : offset < knownCount
        break
      }
    }
  } finally {
    try {
      await handle.close()
    } catch (error) {
      /* a close failure only leaks one read handle; the fold is still valid */
    }
  }
  return { events, more }
}

/**
 * The working directory of a session record (live session or stored snapshot).
 * @param {object} record - the session or snapshot.
 * @returns {string} the trimmed cwd, or ''.
 */
function cwdOf(record) {
  const header = asObject(safeGet(record, 'header'))
  const fromHeader = safeGet(header, 'cwd')
  if (typeof fromHeader === 'string' && fromHeader.trim() !== '') return fromHeader.trim()
  const direct = safeGet(record, 'cwd')
  return typeof direct === 'string' ? direct.trim() : ''
}

/**
 * Get (or create) the stored record of one session id.
 * @param {object} index - the aggregate document; mutated.
 * @param {string} sessionId - the session id.
 * @returns {object} the session record.
 */
function ensureSession(index, sessionId) {
  if (hasOwn(index.sessions, sessionId)) return index.sessions[sessionId]
  const entry = {
    cursor: 0,
    cwd: '',
    tools: {},
    pending: {},
    firstAt: 0,
    lastAt: 0,
    seenAt: 0,
  }
  putOwn(index.sessions, sessionId, entry)
  return entry
}

/**
 * The last-seen instant of a session, used to rotate passes over a long list.
 * @param {object} index - the aggregate document.
 * @param {string} sessionId - the session id.
 * @returns {number} epoch milliseconds, or 0 when never scanned.
 */
function seenAtOf(index, sessionId) {
  return hasOwn(index.sessions, sessionId) ? index.sessions[sessionId].seenAt : 0
}

/**
 * One fold pass: enumerate the live and stored sessions, read the newest events
 * of up to `maxSessionsPerPass` of them, and fold them into the index.
 * @param {object} index - the aggregate document; mutated.
 * @param {{ sessions: object|null, persistence: object|null }} services - the resolved services.
 * @param {number} at - the pass instant.
 * @param {object} limits - the resolved pass limits.
 * @returns {Promise<{ partial: boolean, scanned: number, skipped: number, dirty: boolean }>} the pass report.
 */
async function foldPass(index, services, at, limits) {
  const report = { partial: false, scanned: 0, skipped: 0, dirty: false }
  /** @type {Map<string, object>} */
  const candidates = new Map()

  const sessions = services.sessions
  if (sessions !== null && typeof sessions.list === 'function') {
    let list = []
    try {
      list = await sessions.list()
    } catch (error) {
      report.partial = true
    }
    for (const session of Array.isArray(list) ? list : []) {
      const record = asObject(session)
      const header = asObject(safeGet(record, 'header'))
      const id = textOf(safeGet(record, 'id'), ID_MAX).trim()
        || textOf(safeGet(header, 'id'), ID_MAX).trim()
      if (id === '' || candidates.has(id)) continue
      candidates.set(id, { id, kind: 'live', live: record, cwd: cwdOf(record) })
    }
  }

  const persistence = services.persistence
  if (persistence !== null && typeof persistence.list === 'function') {
    let list = []
    try {
      list = await persistence.list()
    } catch (error) {
      report.partial = true
    }
    for (const snapshot of Array.isArray(list) ? list : []) {
      const record = asObject(snapshot)
      const header = asObject(safeGet(record, 'header'))
      const id = textOf(safeGet(header, 'id'), ID_MAX).trim()
        || textOf(safeGet(record, 'id'), ID_MAX).trim()
      // A live session is read from its live snapshot: it is fresher and the
      // stored list may still lag behind it.
      if (id === '' || candidates.has(id)) continue
      candidates.set(id, { id, kind: 'stored', snapshot: record, cwd: cwdOf(record) })
    }
  }

  const ordered = [...candidates.values()].sort((left, right) => {
    const leftSeen = seenAtOf(index, left.id)
    const rightSeen = seenAtOf(index, right.id)
    if (leftSeen !== rightSeen) return leftSeen - rightSeen
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  const selected = ordered.slice(0, limits.maxSessionsPerPass)
  if (ordered.length > selected.length) report.partial = true

  for (const candidate of selected) {
    const entry = ensureSession(index, candidate.id)
    if (candidate.cwd !== '' && candidate.cwd !== entry.cwd) {
      entry.cwd = candidate.cwd
      report.dirty = true
    }

    let events = null
    let more = false
    try {
      if (candidate.kind === 'live') {
        if (typeof candidate.live.snapshotEvents !== 'function') {
          throw new Error('the live session has no snapshotEvents()')
        }
        events = sliceFromCursor(candidate.live.snapshotEvents(), entry.cursor)
      } else {
        if (persistence === null || typeof persistence.open !== 'function') {
          throw new Error('the persistence service cannot open a read handle')
        }
        const read = await readStored(persistence, candidate.id, candidate.snapshot, entry.cursor, limits)
        events = read.events
        more = read.more
      }
    } catch (error) {
      // A vanished or unreadable session is a fact, not a failure of the sample:
      // count it, advance its rotation slot and move on. It is reported through
      // `skipped` rather than `partial`, because it would otherwise pin the
      // document to "incomplete" for as long as the session stays unreadable.
      report.skipped += 1
      entry.seenAt = at
      report.dirty = true
      continue
    }

    const applied = applyEvents(entry, Array.isArray(events) ? events : [], limits)
    entry.seenAt = at
    report.dirty = true
    report.scanned += 1
    if (applied.stopped || more) report.partial = true
  }

  return report
}

/**
 * Turn all session aggregates into one tool row.
 * @param {string} name - the tool name.
 * @param {object} aggregate - the tool aggregate.
 * @returns {object} the card-facing row.
 */
function toolRowOf(name, aggregate) {
  const calls = intOf(aggregate.calls)
  const errors = Math.min(intOf(aggregate.errors), calls)
  return {
    name,
    calls,
    errors,
    errorRate: rateOf(errors, calls),
    argChars: intOf(aggregate.argChars),
    outChars: intOf(aggregate.outChars),
    argTokens: intOf(aggregate.argTokens),
    outTokens: intOf(aggregate.outTokens),
    ms: intOf(aggregate.ms),
  }
}

/**
 * Sum a tool aggregate map into document totals.
 * @param {Map<string, object>} map - tool name to aggregate.
 * @returns {object} the totals row.
 */
function totalsOf(map) {
  const totals = zeroAggregate()
  for (const aggregate of map.values()) {
    const calls = intOf(aggregate.calls)
    totals.calls += calls
    totals.errors += Math.min(intOf(aggregate.errors), calls)
    totals.argChars += intOf(aggregate.argChars)
    totals.outChars += intOf(aggregate.outChars)
    totals.argTokens += intOf(aggregate.argTokens)
    totals.outTokens += intOf(aggregate.outTokens)
    totals.ms += intOf(aggregate.ms)
  }
  return {
    calls: totals.calls,
    errors: totals.errors,
    errorRate: rateOf(totals.errors, totals.calls),
    argChars: totals.argChars,
    outChars: totals.outChars,
    argTokens: totals.argTokens,
    outTokens: totals.outTokens,
    ms: totals.ms,
  }
}

/**
 * Tool rows, sorted by calls descending and name ascending.
 * @param {Map<string, object>} map - tool name to aggregate.
 * @param {number} [limit] - keep at most this many rows.
 * @returns {object[]} the rows.
 */
function toolRowsOf(map, limit) {
  const rows = []
  for (const [name, aggregate] of map) rows.push(toolRowOf(name, aggregate))
  rows.sort((left, right) => {
    if (left.calls !== right.calls) return right.calls - left.calls
    if (left.name === right.name) return 0
    return left.name < right.name ? -1 : 1
  })
  return limit === undefined ? rows : rows.slice(0, limit)
}

/**
 * Add one aggregate into a tool map.
 * @param {Map<string, object>} map - the destination.
 * @param {string} name - the tool name.
 * @param {object} aggregate - the source aggregate.
 * @returns {void}
 */
function addAggregate(map, name, aggregate) {
  let target = map.get(name)
  if (target === undefined) {
    target = zeroAggregate()
    map.set(name, target)
  }
  target.calls += intOf(aggregate.calls)
  target.errors += intOf(aggregate.errors)
  target.argChars += intOf(aggregate.argChars)
  target.outChars += intOf(aggregate.outChars)
  target.argTokens += intOf(aggregate.argTokens)
  target.outTokens += intOf(aggregate.outTokens)
  target.ms += intOf(aggregate.ms)
}

/**
 * Project the stored index into the frozen card document. Grouping is derived
 * here, on every read, so the store never bakes a project in.
 * @param {object} index - the aggregate document.
 * @param {number} at - the sample instant.
 * @param {boolean} partial - whether the pass hit a bound.
 * @param {number} scanned - sessions read this pass.
 * @param {number} skipped - sessions that could not be read this pass.
 * @param {object} limits - the resolved pass limits.
 * @returns {object} the card document.
 */
function buildDocument(index, at, partial, scanned, skipped, limits) {
  /** @type {Map<string, object>} */
  const byName = new Map()
  /** @type {Map<string, object>} */
  const byProject = new Map()
  let sessionCount = 0
  let firstAt = 0
  let lastAt = 0

  for (const sessionId of Object.keys(index.sessions)) {
    const entry = index.sessions[sessionId]
    const identity = projectKeyOf(entry.cwd)
    let project = byProject.get(identity.key)
    if (project === undefined) {
      project = { key: identity.key, label: identity.label, sessions: 0, tools: new Map() }
      byProject.set(identity.key, project)
    }
    project.sessions += 1
    sessionCount += 1
    if (entry.firstAt > 0 && (firstAt === 0 || entry.firstAt < firstAt)) firstAt = entry.firstAt
    if (entry.lastAt > lastAt) lastAt = entry.lastAt
    for (const name of Object.keys(entry.tools)) {
      const aggregate = entry.tools[name]
      addAggregate(byName, name, aggregate)
      addAggregate(project.tools, name, aggregate)
    }
  }

  const projects = []
  for (const project of byProject.values()) {
    const rows = toolRowsOf(project.tools)
    const totals = totalsOf(project.tools)
    projects.push({
      key: project.key,
      label: project.label,
      path: project.key,
      sessions: project.sessions,
      calls: totals.calls,
      errors: totals.errors,
      errorRate: totals.errorRate,
      argChars: totals.argChars,
      outChars: totals.outChars,
      argTokens: totals.argTokens,
      outTokens: totals.outTokens,
      ms: totals.ms,
      toolCount: rows.length,
      top: rows.slice(0, limits.maxProjectTop).map((row) => ({ name: row.name, calls: row.calls })),
      tools: rows.slice(0, limits.maxProjectTools),
    })
  }
  projects.sort((left, right) => {
    if (left.calls !== right.calls) return right.calls - left.calls
    if (left.sessions !== right.sessions) return right.sessions - left.sessions
    if (left.key === right.key) return 0
    return left.key < right.key ? -1 : 1
  })

  return {
    available: true,
    reason: '',
    at,
    partial: partial === true,
    window: {
      sessions: sessionCount,
      projects: projects.length,
      scannedSessions: scanned,
      firstAt,
      lastAt,
    },
    totals: totalsOf(byName),
    tools: toolRowsOf(byName, limits.maxTools),
    projects,
    skipped,
  }
}

/**
 * The zeroed document returned when the sample cannot read anything. It keeps
 * the frozen shape so the card never has to branch on missing fields.
 * @param {string} reason - what made the sample unavailable.
 * @param {number} at - the sample instant.
 * @returns {object} the document.
 */
function unavailableDocument(reason, at) {
  return {
    available: false,
    reason,
    at,
    partial: false,
    window: { sessions: 0, projects: 0, scannedSessions: 0, firstAt: 0, lastAt: 0 },
    totals: zeroTotals(),
    tools: [],
    projects: [],
    skipped: 0,
  }
}

/**
 * Create the tool-usage folder for one storage root.
 *
 * `sessions` and `sessionPersistence` may be services or factory functions; the
 * module resolves them per call, so a profile that mounts the persistence
 * service later starts working without recreating the module. A missing service
 * is a documented state, never a throw.
 *
 * The returned `sample()` never rejects. It returns the frozen document shape:
 * `{ available, reason, at, partial, window, totals, tools, projects, skipped }`
 * with per-tool rows sorted by calls descending (capped at 40) and per-project
 * rows sorted by calls descending, each carrying its top-3 tools and at most 12
 * tool rows. `sample({ force: true })` ignores the configured in-flight/short
 * memo (`limits.memoMs`, 0 by default).
 *
 * @param {object} [options] - injectable environment.
 * @param {string} [options.root] - storage root holding `tool-usage.json`;
 *   `process.cwd()` by default.
 * @param {object|Function} [options.sessions] - the `sessions` service or a factory.
 * @param {object|Function} [options.sessionPersistence] - the `sessionPersistence`
 *   service or a factory.
 * @param {Function} [options.now] - clock in epoch milliseconds; `Date.now` by default.
 * @param {object} [options.limits] - `maxSessionsPerPass` (80),
 *   `maxEventsPerSession` (20000), `maxPending` (2000), `readBatch` (500),
 *   `maxTools` (40), `maxProjectTools` (12), `maxProjectTop` (3), `memoMs` (0).
 * @returns {{ sample: Function, read: Function, reset: Function }} the module API.
 */
export function createToolUsage(options = {}) {
  const settings = asObject(options)

  const configuredRoot = typeof settings.root === 'string' ? settings.root.trim() : ''
  let root = process.cwd()
  if (configuredRoot !== '') {
    try {
      root = nodePath.resolve(configuredRoot)
    } catch (error) {
      root = process.cwd()
    }
  }
  const file = nodePath.join(root, 'tool-usage.json')

  const clock = typeof settings.now === 'function' ? settings.now : Date.now
  const limits = limitsOf(settings.limits)
  const readFile = fs.readFile
  const writeFile = fs.writeFile
  const rename = fs.rename
  const mkdir = fs.mkdir

  /** Passes and resets run on one chain so two folds cannot race the index. */
  let tail = Promise.resolve()

  /** Last completed document, for the optional short memo. */
  let memo = null
  let memoAt = 0

  /**
   * Current wall clock, falling back to the real clock if an injected one
   * misbehaves.
   * @returns {number} milliseconds since the epoch.
   */
  function instant() {
    try {
      const value = Number(clock())
      return Number.isFinite(value) ? Math.trunc(value) : Date.now()
    } catch (error) {
      return Date.now()
    }
  }

  /**
   * Run one pass or reset after every earlier one has settled. The tail never
   * rejects, so one failed pass cannot poison the queue.
   * @param {() => Promise<unknown>} work - the operation.
   * @returns {Promise<unknown>} the operation's own outcome.
   */
  function serialize(work) {
    const attempt = tail.then(work)
    tail = attempt.then(() => undefined, () => undefined)
    return attempt
  }

  /**
   * Resolve both services now (a factory may return a different object per call).
   * @returns {{ sessions: object|null, persistence: object|null }} the services.
   */
  function resolveServices() {
    return {
      sessions: serviceOf(settings.sessions),
      persistence: serviceOf(settings.sessionPersistence),
    }
  }

  /**
   * Read the stored aggregate. Never throws: a missing or corrupt file is empty.
   * @returns {Promise<object>} the normalized index.
   */
  async function readStoredIndex() {
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      return emptyIndex()
    }
    let parsed
    try {
      parsed = JSON.parse(String(raw))
    } catch (error) {
      return emptyIndex()
    }
    return readIndexValue(parsed, limits)
  }

  /**
   * Replace `tool-usage.json` atomically. A failed rename falls back to a direct
   * write, which still leaves a usable file even if it is not crash-atomic.
   * @param {object} index - the aggregate document.
   * @returns {Promise<void>} resolves once the file holds the document.
   */
  async function persistIndex(index) {
    const body = JSON.stringify(index) + '\n'
    await mkdir(root, { recursive: true })
    const temporary = file + '.tmp'
    try {
      await writeFile(temporary, body, 'utf8')
      await rename(temporary, file)
    } catch (error) {
      await writeFile(file, body, 'utf8')
    }
  }

  /**
   * Read the persisted aggregate (for diagnostics and tests). Never throws.
   * @returns {Promise<object>} `{ version, at, sessions }`.
   */
  async function read() {
    try {
      return await readStoredIndex()
    } catch (error) {
      return emptyIndex()
    }
  }

  /**
   * The card document. Never rejects: missing services lose only availability,
   * and any unexpected failure becomes a zeroed, full-shape document.
   * @param {object} [sampleOptions] - `{ force }`; force ignores the short memo
   *   and folds a fresh pass over the logs.
   * @returns {Promise<object>} the tool-usage document.
   */
  async function sample(sampleOptions = {}) {
    const input = asObject(sampleOptions)
    const force = input.force === true
    if (!force && limits.memoMs > 0 && memo !== null && instant() - memoAt < limits.memoMs) {
      return memo
    }
    return serialize(async () => {
      const at = instant()
      if (!force && limits.memoMs > 0 && memo !== null && at - memoAt < limits.memoMs) {
        return memo
      }
      try {
        const services = resolveServices()
        const sessionsUsable = services.sessions !== null && typeof services.sessions.list === 'function'
        const persistenceUsable = services.persistence !== null
          && typeof services.persistence.list === 'function'
          && typeof services.persistence.open === 'function'
        if (!sessionsUsable && !persistenceUsable) {
          const document = unavailableDocument(
            'no session log is readable: the sessions and sessionPersistence services are unavailable',
            at,
          )
          memo = document
          memoAt = instant()
          return document
        }

        const index = await readStoredIndex()
        const report = await foldPass(index, services, at, limits)
        let partial = report.partial
        if (report.dirty) {
          index.at = at
          try {
            await persistIndex(index)
          } catch (error) {
            // The counts in this document are still true for this pass, but the
            // cursor did not reach disk: the next pass may re-read it.
            partial = true
          }
        }
        const document = buildDocument(index, at, partial, report.scanned, report.skipped, limits)
        memo = document
        memoAt = instant()
        return document
      } catch (error) {
        const document = unavailableDocument(messageOf(error), at)
        memo = document
        memoAt = instant()
        return document
      }
    })
  }

  /**
   * Forget every stored aggregate and every memoized document, then start over
   * from an empty index. The next sample recounts the logs from seq 0.
   * @returns {Promise<void>} resolves once the store is empty.
   */
  async function reset() {
    memo = null
    memoAt = 0
    return serialize(async () => {
      try {
        await persistIndex(emptyIndex())
      } catch (error) {
        /* an unwritable root is already reported by the next sample */
      }
    })
  }

  return { sample, read, reset }
}
