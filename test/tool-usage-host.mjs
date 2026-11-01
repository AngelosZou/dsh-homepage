/**
 * Host-side checks for lib/host/tool-usage.js.
 *
 * Run with `node test/tool-usage-host.mjs`. No test framework and no fixtures on
 * disk: every scenario builds fake live sessions / fake stored session logs in a
 * temporary storage root, so the fold, the incremental cursor and the caps are
 * exercised end to end through the real module.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createToolUsage, estimateTokens, projectKeyOf } from '../lib/host/tool-usage.js'

/** Assertions executed; printed at the end. */
let checks = 0

/**
 * Assert a truthy value.
 * @param {unknown} value - the value.
 * @param {string} label - the assertion label.
 * @returns {void}
 */
function ok(value, label) {
  checks += 1
  assert.ok(value, label)
}

/**
 * Assert strict equality.
 * @param {unknown} actual - the observed value.
 * @param {unknown} expected - the expected value.
 * @param {string} label - the assertion label.
 * @returns {void}
 */
function is(actual, expected, label) {
  checks += 1
  assert.equal(actual, expected, label)
}

/**
 * Assert numeric closeness (for rounded rates).
 * @param {number} actual - the observed value.
 * @param {number} expected - the expected value.
 * @param {string} label - the assertion label.
 * @returns {void}
 */
function near(actual, expected, label) {
  checks += 1
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`)
}

/**
 * Assert deep equality.
 * @param {unknown} actual - the observed value.
 * @param {unknown} expected - the expected value.
 * @param {string} label - the assertion label.
 * @returns {void}
 */
function same(actual, expected, label) {
  checks += 1
  assert.deepEqual(actual, expected, label)
}

/**
 * Build one `tool/call` event.
 * @param {number} seq - the event sequence.
 * @param {number} time - epoch milliseconds.
 * @param {string} callId - the model's call id.
 * @param {string} name - the tool name.
 * @param {string} args - the raw JSON argument string.
 * @returns {object} the event.
 */
function callEvent(seq, time, callId, name, args) {
  return {
    seq,
    time,
    type: 'tool/call',
    data: { turn: 1, step: 1, callId, name, arguments: args },
  }
}

/**
 * Build one `tool/result` event; `message` adds to the role/toolCallId base.
 * @param {number} seq - the event sequence.
 * @param {number} time - epoch milliseconds.
 * @param {string} callId - the model's call id.
 * @param {object} [message] - extra message fields (content, isError, ...).
 * @param {object} [extra] - extra `data` fields (e.g. error).
 * @returns {object} the event.
 */
function resultEvent(seq, time, callId, message = {}, extra = {}) {
  return {
    seq,
    time,
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: callId, ...message },
      ...extra,
    },
  }
}

/**
 * Build one fake live session.
 * @param {string} id - the session id.
 * @param {string|undefined} cwd - the session's working directory.
 * @param {Array<object>} events - the live event log.
 * @returns {object} the session.
 */
function liveSession(id, cwd, events) {
  return {
    id,
    header: { id, version: 1, createdAt: 1, cwd },
    snapshotEvents: () => events,
  }
}

/**
 * Build a fake `sessionPersistence` over in-memory stored logs.
 *
 * `records[i].eventCount === false` omits `eventCount` from the snapshot, which
 * is the "unknown stored size" case the reader has to fall back on.
 * @param {Array<object>} records - `{ header, events, eventCount? }` records.
 * @returns {object} the fake service, with `state` for assertions.
 */
function fakePersistence(records) {
  const state = { records, reads: [], opens: 0, closes: 0, fail: null }
  return {
    state,
    list() {
      return state.records.map((record) => {
        const snapshot = { header: record.header, revision: record.events.length }
        if (record.eventCount !== false) snapshot.eventCount = record.events.length
        return snapshot
      })
    },
    async stat(id) {
      const record = state.records.find((candidate) => candidate.header.id === id)
      if (record === undefined) return undefined
      return { header: record.header, revision: record.events.length }
    },
    async open(id, mode) {
      is(mode, 'read', 'persistence is opened for reading')
      if (state.fail === id) throw new Error(`session ${id} vanished`)
      const record = state.records.find((candidate) => candidate.header.id === id)
      if (record === undefined) throw new Error(`unknown session ${id}`)
      state.opens += 1
      return {
        async read(offset, length) {
          state.reads.push({ id, offset, length })
          return { events: record.events.slice(offset, offset + length) }
        },
        async close() {
          state.closes += 1
        },
      }
    },
  }
}

/**
 * Index a document's tool rows by name.
 * @param {object} document - the sample document.
 * @returns {Map<string, object>} name to row.
 */
function toolMap(document) {
  return new Map(document.tools.map((row) => [row.name, row]))
}

const base = await mkdtemp(path.join(tmpdir(), 'tool-usage-host-'))

try {
  // ---------------------------------------------------------------------------
  // Scenario A: the full fold. Live + stored sessions, all fold rules, grouping.
  // ---------------------------------------------------------------------------
  {
    const root = path.join(base, 'a')
    const clock = 1_700_000_000_000
    const now = () => clock

    const argsA = '{"file":"a.txt"}'
    const argsB = '{"file":"b.txt"}'
    const argsG = '{"pattern":"中"}'
    const argsW = '{"path":"x","body":"' + 'y'.repeat(100) + '"}'
    const argsBash = '{}'
    const argsStored = '{"p":1}'
    const bashMessage = { role: 'tool', toolCallId: 'b1' }
    const bashOutput = JSON.stringify(bashMessage)

    const alphaEvents = [
      callEvent(0, 1000, 'c1', 'read', argsA),
      resultEvent(1, 1100, 'c1', { content: [{ type: 'text', text: 'hello' }] }),
      callEvent(2, 1200, 'c2', 'read', argsB),
      resultEvent(3, 1230, 'c2', { content: ['a', { type: 'text', text: 'b' }] }),
      callEvent(4, 1300, 'g1', 'grep', argsG),
      resultEvent(5, 1400, 'g1', {
        content: [{ type: 'text', text: 'error: 中文' }],
        isError: true,
      }),
      callEvent(6, 1500, 'w1', 'write', argsW),
      callEvent(7, 1600, 'b1', 'bash', argsBash),
      resultEvent(8, 1700, 'b1', {}),
      { seq: 9, time: 1800, type: 'user/message', data: { content: 'hi' } },
    ]
    const storedEvents = [
      callEvent(0, 1900, 's2c1', 'fs_read', argsStored),
      resultEvent(1, 1905, 's2c1', { content: [{ type: 'text', text: 'ok' }] }),
    ]
    const unknownEvents = [
      callEvent(0, 2000, 'u1', 'read', ''),
      resultEvent(1, 2000, 'u1', { content: [{ type: 'text', text: '' }] }),
    ]

    const live = {
      list: () => [
        liveSession('s1', 'D:\\Projects\\Alpha\\', alphaEvents),
        liveSession('s3', undefined, unknownEvents),
      ],
    }
    const persistence = fakePersistence([
      {
        header: { id: 's2', version: 1, createdAt: 1, cwd: 'D:\\Projects\\Beta' },
        events: storedEvents,
      },
    ])
    const usage = createToolUsage({
      root,
      sessions: () => live,
      sessionPersistence: () => persistence,
      now,
    })

    const document = await usage.sample()
    is(document.available, true, 'the document is available')
    is(document.reason, '', 'an available document carries no reason')
    is(document.at, clock, 'the document is stamped with the injected clock')
    is(document.partial, false, 'a complete pass is not partial')
    is(document.totals.calls, 7, 'seven calls across three sessions')
    is(document.totals.errors, 1, 'one failed call')
    near(document.totals.errorRate, 0.1429, 'error rate is rounded to 4 decimals')
    is(
      document.totals.argChars,
      argsA.length + argsB.length + argsG.length + argsW.length + argsBash.length + argsStored.length,
      'argument characters are the exact raw JSON lengths',
    )
    is(
      document.totals.outChars,
      'hello'.length + 'a\nb'.length + 'error: 中文'.length + bashOutput.length + 'ok'.length,
      'output characters use text blocks, the joined newline and the JSON fallback',
    )
    is(
      document.totals.argTokens,
      estimateTokens(argsA) + estimateTokens(argsB) + estimateTokens(argsG)
        + estimateTokens(argsW) + estimateTokens(argsBash) + estimateTokens(argsStored),
      'argument tokens are accumulated per call',
    )
    is(
      document.totals.outTokens,
      estimateTokens('hello') + estimateTokens('a\nb') + estimateTokens('error: 中文')
        + estimateTokens(bashOutput) + estimateTokens('ok'),
      'output tokens are accumulated per folded output',
    )
    is(document.totals.ms, 335, 'elapsed milliseconds sum the paired call deltas')

    const byName = toolMap(document)
    is(document.tools.length, 5, 'five distinct tools are reported')
    is(document.tools[0].name, 'read', 'tools are sorted by calls descending')
    const readRow = byName.get('read')
    is(readRow.calls, 3, 'read was called three times')
    is(readRow.errors, 0, 'read had no failures')
    is(readRow.errorRate, 0, 'a clean tool has a zero error rate')
    is(readRow.argChars, argsA.length + argsB.length, 'read argument characters')
    is(readRow.outChars, 'hello'.length + 'a\nb'.length, 'read output characters')
    is(readRow.argTokens, estimateTokens(argsA) + estimateTokens(argsB), 'read argument tokens')
    is(readRow.outTokens, estimateTokens('hello') + estimateTokens('a\nb'), 'read output tokens')
    is(readRow.ms, 130, 'read elapsed milliseconds')
    const grepRow = byName.get('grep')
    is(grepRow.errors, 1, 'a result with isError counts as an error')
    is(grepRow.errorRate, 1, 'a tool that only failed has a 1.0 rate')
    is(grepRow.ms, 100, 'failed calls still record elapsed time')
    const writeRow = byName.get('write')
    is(writeRow.calls, 1, 'a call without a result is still counted')
    is(writeRow.outChars, 0, 'a call without a result has no output')
    is(writeRow.ms, 0, 'a call without a result has no elapsed time')
    const bashRow = byName.get('bash')
    is(bashRow.outChars, bashOutput.length, 'a result without text blocks falls back to JSON')

    is(document.window.sessions, 3, 'three sessions are aggregated')
    is(document.window.projects, 3, 'three projects are derived')
    is(document.window.scannedSessions, 3, 'all three sessions were scanned')
    is(document.window.firstAt, 1000, 'the window starts at the first call')
    is(document.window.lastAt, 2000, 'the window ends at the last call')
    is(document.skipped, 0, 'nothing was skipped')

    is(document.projects.length, 3, 'three project rows')
    const alpha = document.projects[0]
    is(alpha.key, 'd:/Projects/Alpha', 'the project key normalizes slashes and the drive letter')
    is(alpha.label, 'Alpha', 'the project label is the last path segment')
    is(alpha.path, alpha.key, 'the project path is the key')
    is(alpha.sessions, 1, 'one session in Alpha')
    is(alpha.calls, 5, 'five calls in Alpha')
    is(alpha.errors, 1, 'one error in Alpha')
    is(alpha.toolCount, 4, 'four tools in Alpha')
    same(alpha.top, [
      { name: 'read', calls: 2 },
      { name: 'bash', calls: 1 },
      { name: 'grep', calls: 1 },
    ], 'the top three tools are the busiest, then name order')
    is(alpha.tools.length, 4, 'the project carries its tool rows')
    const unknown = document.projects[1]
    is(unknown.key, '', 'a session without a cwd lands in the unknown bucket')
    is(unknown.label, 'unknown', 'the unknown bucket is labeled')
    is(unknown.sessions, 1, 'one unknown session')
    is(unknown.calls, 1, 'one unknown call')
    const beta = document.projects[2]
    is(beta.key, 'd:/Projects/Beta', 'the stored session groups by its cwd')
    is(beta.top[0].name, 'fs_read', 'the stored session tool is reported')

    const storedIndex = await usage.read()
    is(storedIndex.version, 1, 'the store is versioned')
    is(storedIndex.at, clock, 'the store records its pass instant')
    is(storedIndex.sessions.s1.cursor, 10, 'the live cursor is the next seq after the log')
    is(storedIndex.sessions.s2.cursor, 2, 'the stored cursor is the next seq after the log')
    is(storedIndex.sessions.s1.tools.read.calls, 2, 'only Alpha read calls are stored on s1')
    is(storedIndex.sessions.s1.pending.w1.name, 'write', 'the unanswered call stays pending')
    is(storedIndex.sessions.s1.pending.w1.argChars, argsW.length, 'the pending record keeps arg size')
    is(storedIndex.sessions.s1.pending.w1.time, 1500, 'the pending record keeps the call time')
    is(persistence.state.opens, 1, 'the stored session was opened once')
    is(persistence.state.closes, 1, 'the stored session handle was closed')
    is(persistence.state.reads.length, 1, 'the stored session was read once')
    is(persistence.state.reads[0].offset, 0, 'the first stored read starts at seq 0')

    const second = await usage.sample()
    is(second.totals.calls, 7, 'a second pass does not double count')
    is(second.partial, false, 'a second pass is complete')
    is(persistence.state.reads.length, 1, 'a caught-up stored session is not re-read')

    // A fresh instance over the same root relies on the persisted cursor.
    const fresh = createToolUsage({
      root,
      sessions: () => live,
      sessionPersistence: () => persistence,
      now,
    })
    const refreshed = await fresh.sample({ force: true })
    is(refreshed.totals.calls, 7, 'a fresh instance resumes from the stored cursor')
    is(refreshed.totals.argChars, document.totals.argChars, 'resumed argument characters match')
    is(refreshed.window.sessions, 3, 'resumed session count matches')
    is(persistence.state.opens, 1, 'a fresh instance does not reopen a caught-up session')

    // A corrupt store must not throw and must recount from empty.
    await writeFile(path.join(root, 'tool-usage.json'), 'this is not json', 'utf8')
    const recovered = await createToolUsage({
      root,
      sessions: () => live,
      sessionPersistence: () => persistence,
      now,
    }).sample({ force: true })
    is(recovered.available, true, 'a corrupt store still yields a document')
    is(recovered.totals.calls, 7, 'a corrupt store recounts instead of doubling')

    // reset() drops the store; the next sample recounts from seq 0.
    const resetter = createToolUsage({
      root,
      sessions: () => live,
      sessionPersistence: () => persistence,
      now,
    })
    await resetter.reset()
    same((await resetter.read()).sessions, {}, 'reset empties the stored sessions')
    const afterReset = await resetter.sample({ force: true })
    is(afterReset.totals.calls, 7, 'a sample after reset recounts the whole log')
    is(afterReset.window.sessions, 3, 'a sample after reset sees all sessions again')
  }

  // ---------------------------------------------------------------------------
  // Scenario B: stored-only incremental reads, a late result pairing in pass 2,
  // and a snapshot that omits eventCount.
  // ---------------------------------------------------------------------------
  {
    const root = path.join(base, 'b')
    const now = () => 1_700_000_100_000
    const events = [
      callEvent(0, 100, 'k1', 'read', '{"a":1}'),
      callEvent(1, 200, 'k2', 'grep', '{"b":2}'),
    ]
    const persistence = fakePersistence([
      {
        header: { id: 'stored-1', version: 1, createdAt: 1, cwd: 'D:/B/project' },
        events,
        eventCount: false,
      },
    ])
    const usage = createToolUsage({
      root,
      sessions: null,
      sessionPersistence: persistence,
      now,
    })

    const first = await usage.sample()
    is(first.available, true, 'a persistence-only profile is available')
    is(first.totals.calls, 2, 'both unanswered calls are counted')
    is(first.totals.outChars, 0, 'unanswered calls have no output')
    is(first.partial, false, 'an unknown eventCount is not partial by itself')
    is(persistence.state.reads[0].offset, 0, 'the first stored read starts at seq 0')

    events.push(
      resultEvent(2, 250, 'k2', { content: [{ type: 'text', text: 'out2' }] }),
      resultEvent(3, 210, 'k1', { content: [{ type: 'text', text: 'out1' }] }),
    )

    const second = await usage.sample()
    is(persistence.state.reads.length, 2, 'the second pass reads the stored log again')
    is(persistence.state.reads[1].offset, 2, 'the second read resumes at the stored cursor')
    is(second.totals.calls, 2, 'a later pass does not recount the calls')
    is(second.totals.outChars, 'out1'.length + 'out2'.length, 'late results pair by callId')
    is(second.totals.ms, 160, 'late elapsed times pair by callId, not by order')
    const byName = toolMap(second)
    is(byName.get('read').ms, 110, 'the read result pairs with its own call')
    is(byName.get('grep').ms, 50, 'the grep result pairs with its own call')
    is(second.partial, false, 'the catch-up pass is complete')
    const storedIndex = await usage.read()
    is(storedIndex.sessions['stored-1'].cursor, 4, 'the cursor advances past the results')
    same(Object.keys(storedIndex.sessions['stored-1'].pending), [], 'no call is left pending')
    is(persistence.state.closes, 2, 'every read handle was closed')
  }

  // ---------------------------------------------------------------------------
  // Scenario C: each cap yields partial: true, then catches up without doubles.
  // ---------------------------------------------------------------------------
  {
    // C1: only one session per pass. With two sessions total, every pass hits
    // the cap (the rotation never covers both at once), so partial stays true.
    const root = path.join(base, 'c1')
    const now = () => 1_700_000_200_000
    const live = {
      list: () => [
        liveSession('ca', 'D:/C1/a', [callEvent(0, 10, 'a1', 'read', '{}')]),
        liveSession('cb', 'D:/C1/b', [callEvent(0, 20, 'b1', 'read', '{}')]),
      ],
    }
    const usage = createToolUsage({ root, sessions: live, now, limits: { maxSessionsPerPass: 1 } })
    const pass1 = await usage.sample()
    is(pass1.partial, true, 'the session cap marks the pass partial')
    is(pass1.window.sessions, 1, 'only the first session is in the document')
    is(pass1.totals.calls, 1, 'only the first session was folded')
    const pass2 = await usage.sample()
    is(pass2.partial, true, 'the rotations still hit the session cap')
    is(pass2.window.sessions, 2, 'the second session joins the document')
    is(pass2.totals.calls, 2, 'the catch-up pass adds exactly one call')
    const pass3 = await usage.sample({ force: true })
    is(pass3.totals.calls, 2, 'a further pass does not double count')
  }

  {
    // C2: only two events per session per pass.
    const root = path.join(base, 'c2')
    const now = () => 1_700_000_300_000
    const events = [
      callEvent(0, 10, 'e1', 'read', '{}'),
      resultEvent(1, 20, 'e1', { content: [{ type: 'text', text: 'one' }] }),
      callEvent(2, 30, 'e2', 'read', '{}'),
      resultEvent(3, 40, 'e2', { content: [{ type: 'text', text: 'two' }] }),
    ]
    const usage = createToolUsage({
      root,
      sessions: { list: () => [liveSession('ev', 'D:/C2', events)] },
      now,
      limits: { maxEventsPerSession: 2 },
    })
    const pass1 = await usage.sample()
    is(pass1.partial, true, 'the event cap marks the pass partial')
    is(pass1.totals.calls, 1, 'only the first event pair was folded')
    const pass2 = await usage.sample()
    is(pass2.partial, false, 'the event catch-up pass is complete')
    is(pass2.totals.calls, 2, 'the event catch-up pass adds exactly one call')
    is(pass2.totals.outChars, 'one'.length + 'two'.length, 'both outputs were folded')
    is((await usage.sample({ force: true })).totals.calls, 2, 'no event is double counted')
  }

  {
    // C3: pending cap with an interleaved call. Stopping before the second call
    // would deadlock the cursor behind it, so the call is counted unpaired and
    // the pass stops right after it.
    const root = path.join(base, 'c3')
    const now = () => 1_700_000_400_000
    const events = [
      callEvent(0, 10, 'p1', 'read', 'r'),
      callEvent(1, 20, 'p2', 'read', 'r2'),
      resultEvent(2, 30, 'p1', { content: [{ type: 'text', text: 'one' }] }),
      resultEvent(3, 40, 'p2', { content: [{ type: 'text', text: 'two' }] }),
    ]
    const usage = createToolUsage({
      root,
      sessions: { list: () => [liveSession('pending', 'D:/C3', events)] },
      now,
      limits: { maxPending: 1 },
    })
    const pass1 = await usage.sample()
    is(pass1.partial, true, 'the pending cap marks the pass partial')
    is(pass1.totals.calls, 2, 'an overflowing call is still counted')
    is(pass1.totals.outChars, 0, 'the pass stopped before any result')
    const pass2 = await usage.sample()
    is(pass2.partial, false, 'the pending catch-up pass is complete')
    is(pass2.totals.calls, 2, 'the pending catch-up pass does not recount calls')
    is(pass2.totals.outChars, 'one'.length, 'the paired pending result folds its output')
  }

  // ---------------------------------------------------------------------------
  // Scenario D: memo window, force bypass.
  // ---------------------------------------------------------------------------
  {
    const root = path.join(base, 'd')
    const now = () => 1_700_000_500_000
    const events = [callEvent(0, 10, 'm1', 'read', '{}')]
    const usage = createToolUsage({
      root,
      sessions: { list: () => [liveSession('memo', 'D:/Memo', events)] },
      now,
      limits: { memoMs: 60_000 },
    })
    const first = await usage.sample()
    is(first.totals.calls, 1, 'the memo scenario starts with one call')
    events.push(callEvent(1, 20, 'm2', 'grep', '{}'))
    const memoized = await usage.sample()
    is(memoized.totals.calls, 1, 'a memoized sample does not fold new events')
    const forced = await usage.sample({ force: true })
    is(forced.totals.calls, 2, 'force bypasses the memo and folds the new call')
  }

  // ---------------------------------------------------------------------------
  // Scenario E: missing services and no stored file. A full-shape, unavailable
  // document, never a rejection.
  // ---------------------------------------------------------------------------
  {
    const root = path.join(base, 'e')
    const usage = createToolUsage({ root, sessions: null, sessionPersistence: undefined, now: () => 5 })
    const document = await usage.sample()
    is(document.available, false, 'missing services yield an unavailable document')
    ok(document.reason.length > 0, 'the unavailable document explains why')
    is(document.at, 5, 'the unavailable document is still stamped')
    is(document.partial, false, 'the unavailable document is not partial')
    same(document.window, {
      sessions: 0,
      projects: 0,
      scannedSessions: 0,
      firstAt: 0,
      lastAt: 0,
    }, 'the unavailable document zeroes its window')
    same(document.totals, {
      calls: 0,
      errors: 0,
      errorRate: 0,
      argChars: 0,
      outChars: 0,
      argTokens: 0,
      outTokens: 0,
      ms: 0,
    }, 'the unavailable document zeroes its totals')
    same(document.tools, [], 'the unavailable document has no tools')
    same(document.projects, [], 'the unavailable document has no projects')
    is(document.skipped, 0, 'the unavailable document skipped nothing')

    const empty = await createToolUsage({ root: path.join(base, 'e-missing') }).read()
    same(empty, { version: 1, at: 0, sessions: {} }, 'a missing store reads as an empty index')
  }

  // ---------------------------------------------------------------------------
  // Scenario F: an unreadable session is skipped, not fatal.
  // ---------------------------------------------------------------------------
  {
    const root = path.join(base, 'f')
    const now = () => 1_700_000_600_000
    const bad = {
      id: 'bad',
      header: { id: 'bad', version: 1, createdAt: 1, cwd: 'D:/Bad' },
      snapshotEvents() {
        throw new Error('session is gone')
      },
    }
    const good = liveSession('good', 'D:/Good', [callEvent(0, 10, 'ok1', 'read', '{}')])
    const usage = createToolUsage({
      root,
      sessions: { list: () => [bad, good] },
      now,
    })
    const document = await usage.sample()
    is(document.available, true, 'a skipped session does not make the sample unavailable')
    is(document.totals.calls, 1, 'the readable session still folds')
    is(document.skipped, 1, 'the unreadable session is counted as skipped')
    is(document.partial, false, 'a skipped session does not pin partial')
    is(document.window.sessions, 2, 'the skipped session still counts as known')
    is(document.projects[0].key, 'd:/Good', 'the readable project sorts first')
  }

  // ---------------------------------------------------------------------------
  // Scenario G: pure helpers. Token estimate and project key normalization.
  // ---------------------------------------------------------------------------
  {
    is(estimateTokens(''), 0, 'empty text is zero tokens')
    is(estimateTokens('abc'), 1, 'three ASCII characters round up from 0.75')
    is(estimateTokens('a'.repeat(9)), 3, 'nine ASCII characters round up from 2.25')
    is(estimateTokens('中文'), 2, 'two CJK characters cost about 1.33 tokens')
    is(estimateTokens('中a'), 1, 'mixed CJK and ASCII round up from 0.92')
    is(estimateTokens('中文中文中文'), 4, 'six CJK characters cost four tokens')
    ok(estimateTokens('中文') > estimateTokens('aa'), 'CJK text costs more per character')
    is(estimateTokens(undefined), 0, 'undefined text is zero tokens')

    same(projectKeyOf('D:\\Projects\\node\\x\\'), {
      key: 'd:/Projects/node/x',
      label: 'x',
    }, 'backslashes, the drive case and the trailing slash are normalized')
    same(projectKeyOf('d:/a/b'), {
      key: 'd:/a/b',
      label: 'b',
    }, 'an already forward-slash path keeps its lower-case drive')
    same(projectKeyOf('/home/user/project'), {
      key: '/home/user/project',
      label: 'project',
    }, 'a POSIX path keeps its leading slash')
    same(projectKeyOf(''), { key: '', label: 'unknown' }, 'empty cwd is unknown')
    same(projectKeyOf(undefined), { key: '', label: 'unknown' }, 'missing cwd is unknown')
    same(projectKeyOf('relative/path/'), {
      key: 'relative/path',
      label: 'path',
    }, 'a relative path is normalized too')
  }
} finally {
  await rm(base, { recursive: true, force: true })
}

console.log(`tool-usage-host: ${checks} checks passed`)
