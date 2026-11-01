/**
 * projects-host: unit coverage for the read-only project reader.
 *
 * Plain script, no framework: `node test/projects-host.mjs`. The workspace
 * registry, the live-agent map and the git transport are all fakes, so the test
 * proves the parsing and the degradation rules without touching a real
 * repository or spawning a process.
 *
 * Run: node test/projects-host.mjs
 */
import assert from 'node:assert/strict'
import { createProjectsReader } from '../lib/host/projects.js'

let checks = 0
const ok = (value, message) => { checks += 1; assert.ok(value, message) }
const is = (actual, expected, message) => { checks += 1; assert.equal(actual, expected, message) }
const same = (actual, expected, message) => { checks += 1; assert.deepEqual(actual, expected, message) }

const NOW = 1700000000000
const ZERO = { total: 0, dirty: 0, live: 0, running: 0, worktrees: 0, missing: 0 }

/** One registry record with the defaults a real workspace has. */
function workspace(id, extra) {
  const base = {
    id,
    path: 'C:\\work\\' + id,
    title: id,
    createdAt: NOW - 1000,
    updatedAt: NOW,
    sessionIds: [],
    status: async () => 'ok',
  }
  return Object.assign(base, extra || {})
}

/**
 * A git transport keyed by the first argument. `replies` values are either a
 * result object or a function `(args, cwd) => result`.
 */
function makeGit(replies) {
  const calls = []
  async function runGit(args, cwd) {
    calls.push({ args: args.slice(), cwd })
    const reply = replies[args[0]]
    if (typeof reply === 'function') return reply(args, cwd)
    if (reply !== undefined) return reply
    return { ok: true, stdout: '', stderr: '', code: 0 }
  }
  return { runGit, calls }
}

/** A git transport whose reply depends on the project directory. */
function gitByCwd(table, fallback) {
  const calls = []
  async function runGit(args, cwd) {
    calls.push({ args: args.slice(), cwd })
    const entry = table[cwd]
    if (typeof entry === 'function') return entry(args, cwd)
    if (entry !== undefined) {
      const reply = entry[args[0]]
      if (typeof reply === 'function') return reply(args, cwd)
      if (reply !== undefined) return reply
    }
    return fallback || { ok: true, stdout: '', stderr: '', code: 0 }
  }
  return { runGit, calls }
}

const NOT_REPO = {
  ok: false,
  stdout: '',
  stderr: 'fatal: not a git repository (or any of the parent directories): .git',
  code: 128,
}

console.log('projects-host: registry, ordering, git parsing and every degradation path')

// ------------------------------------------------------- the registry contract

{
  const missing = await createProjectsReader({ now: () => NOW }).sample()
  is(missing.available, false, 'no registry means the reading is unavailable')
  is(missing.at, NOW, 'an unavailable reading still carries its instant')
  same(missing.projects, [], 'an unavailable reading lists no projects')
  same(missing.summary, ZERO, 'an unavailable reading carries a zeroed summary')
  ok(typeof missing.reason === 'string' && missing.reason !== '', 'an unavailable reading explains itself')

  const throwing = await createProjectsReader({
    registry: { list() { throw new Error('registry exploded') } },
    now: () => NOW,
  }).sample()
  is(throwing.available, false, 'a throwing registry is unavailable, not a rejection')
  ok(throwing.reason.includes('registry exploded'), 'a throwing registry keeps its message')

  const noList = await createProjectsReader({ registry: { list: () => null }, now: () => NOW }).sample()
  is(noList.available, false, 'a registry that answers no list is unavailable')

  const bare = await createProjectsReader({ registry: {}, now: () => NOW }).sample()
  is(bare.available, false, 'a registry without list() is unavailable')

  const empty = await createProjectsReader({
    registry: { list: () => [] },
    now: () => NOW,
  }).sample()
  is(empty.available, true, 'an empty registry is a valid, empty reading')
  same(empty.projects, [], 'an empty registry lists nothing')
  same(empty.summary, ZERO, 'an empty registry zeroes the summary')
  is(empty.reason, undefined, 'an available reading carries no reason')
  is(empty.at, NOW, 'the injected clock is the sample instant')
  console.log('  registry: absent, throwing and non-list answers degrade; empty is available')
}

// ------------------------------------------------------------------- ordering

{
  const git = makeGit({ status: NOT_REPO })
  const reader = createProjectsReader({
    registry: {
      list: () => [
        workspace('older-b', { path: 'C:\\work\\b', updatedAt: NOW - 1000 }),
        workspace('newest', { path: 'C:\\work\\a', updatedAt: NOW }),
        workspace('older-a', { path: 'C:\\work\\a', updatedAt: NOW - 1000 }),
      ],
    },
    runGit: git.runGit,
    now: () => NOW,
  })
  const doc = await reader.sample()
  same(doc.projects.map((project) => project.id), ['newest', 'older-a', 'older-b'],
    'newest updatedAt first, then path as the stable fallback')
  is(git.calls.length, 3, 'each project is inspected once')

  const unstamped = createProjectsReader({
    registry: {
      list: () => [
        workspace('z', { path: 'C:\\work\\z', updatedAt: undefined }),
        workspace('a', { path: 'C:\\work\\a', updatedAt: undefined }),
      ],
    },
    runGit: makeGit({ status: NOT_REPO }).runGit,
    now: () => NOW,
  })
  const sorted = await unstamped.sample()
  same(sorted.projects.map((project) => project.id), ['a', 'z'],
    'projects without timestamps fall back to path order')
  console.log('  ordering: newest first, path fallback, stable on duplicates')
}

// ----------------------------------------------------------- the git reading

{
  const calls = []
  const runGit = async (args, cwd) => {
    calls.push({ args: args.slice(), cwd })
    if (args[0] === 'status') {
      return {
        ok: true,
        stdout: '## main...origin/main [ahead 2, behind 1]\n M src/app.js\n?? notes.txt\n',
        stderr: '',
        code: 0,
      }
    }
    if (args[0] === 'log') {
      return { ok: true, stdout: 'abc1234\u00002026-10-18T08:00:00+08:00\u0000Fix the wall\n', stderr: '', code: 0 }
    }
    return {
      ok: true,
      stdout: 'worktree C:/work/atlas\nHEAD abc1234\nbranch refs/heads/main\n\n'
        + 'worktree C:/work/atlas-hotfix\nHEAD def5678\nbranch refs/heads/hotfix\n\n',
      stderr: '',
      code: 0,
    }
  }
  const reader = createProjectsReader({
    registry: {
      list: () => [workspace('atlas', { path: 'C:/work/atlas', sessionIds: ['s1', 's2', 's3'] })],
    },
    agents: {
      list: () => [
        { id: 's1', status: 'idle' },
        { id: 's2', status: 'running' },
        { id: 'elsewhere', status: 'running' },
      ],
    },
    runGit,
    now: () => NOW,
  })
  const doc = await reader.sample()
  same(doc.projects, [{
    id: 'atlas',
    title: 'atlas',
    path: 'C:/work/atlas',
    status: 'ok',
    sessions: 3,
    live: 2,
    running: 1,
    git: {
      repo: true,
      branch: 'main',
      dirty: 2,
      ahead: 2,
      behind: 1,
      lastCommit: {
        hash: 'abc1234',
        at: Date.parse('2026-10-18T08:00:00+08:00'),
        subject: 'Fix the wall',
      },
      worktrees: 1,
    },
  }], 'the full project record is the documented shape')
  same(doc.summary, { total: 1, dirty: 1, live: 2, running: 1, worktrees: 1, missing: 0 },
    'the summary counts dirty repositories, live sessions and extra worktrees')
  same(calls.map((call) => call.args), [
    ['status', '--porcelain=v1', '--branch'],
    ['log', '-1', '--format=%h%x00%cI%x00%s'],
    ['worktree', 'list', '--porcelain'],
  ], 'the three queries are the contract commands')
  ok(calls.every((call) => call.cwd === 'C:/work/atlas'), 'every query runs in the project directory')
  console.log('  git: branch, dirty, ahead/behind, commit and worktrees are parsed')
}

// ---------------------------------------------------------- branch fallbacks

{
  const cases = [
    ['## No commits yet on trunk\n', 'trunk', 'a repository with no commit names its unborn branch'],
    ['## HEAD (no branch)\n', 'HEAD', 'a detached HEAD falls back to HEAD'],
    ['## main...origin/main\n', 'main', 'a branch without a note has no ahead/behind'],
    ['## feature/wall...origin/feature/wall [behind 4]\n', 'feature/wall', 'a slash branch and a behind-only note parse'],
  ]
  for (const [stdout, branch, message] of cases) {
    const reader = createProjectsReader({
      registry: { list: () => [workspace('repo')] },
      runGit: makeGit({
        status: { ok: true, stdout, stderr: '', code: 0 },
        log: { ok: true, stdout: '', stderr: '', code: 0 },
        worktree: { ok: true, stdout: '', stderr: '', code: 0 },
      }).runGit,
      now: () => NOW,
    })
    const doc = await reader.sample()
    is(doc.projects[0].git.branch, branch, message)
  }
  const behind = createProjectsReader({
    registry: { list: () => [workspace('repo')] },
    runGit: makeGit({
      status: { ok: true, stdout: '## main...origin/main [behind 4]\n', stderr: '', code: 0 },
      log: { ok: true, stdout: '', stderr: '', code: 0 },
      worktree: { ok: true, stdout: '', stderr: '', code: 0 },
    }).runGit,
    now: () => NOW,
  })
  const behindDoc = await behind.sample()
  is(behindDoc.projects[0].git.behind, 4, 'a behind-only note still counts')
  is(behindDoc.projects[0].git.ahead, 0, 'a behind-only note has no ahead count')
  console.log('  branches: unborn, detached, bare and slash branches all answer')
}

// ------------------------------------------------- non-repositories and errors

{
  const notRepo = createProjectsReader({
    registry: { list: () => [workspace('plain', { path: 'C:\\work\\plain' })] },
    runGit: makeGit({ status: NOT_REPO }).runGit,
    now: () => NOW,
  })
  const doc = await notRepo.sample()
  is(doc.projects[0].git, null, 'a non-repository has no git reading')
  is(doc.projects.length, 1, 'a non-repository is still a project')
  same(doc.summary, { total: 1, dirty: 0, live: 0, running: 0, worktrees: 0, missing: 0 },
    'a non-repository contributes no git counts')

  // A directory git cannot read is a real failure, and the row may say why.
  const failedCalls = []
  const failedRunGit = async (args, cwd) => {
    failedCalls.push({ args: args.slice(), cwd })
    return {
      ok: false,
      stdout: '',
      stderr: 'fatal: detected dubious ownership in repository at \'C:/work/locked\'\n',
      code: 128,
    }
  }
  const broken = createProjectsReader({
    registry: { list: () => [workspace('locked', { path: 'C:/work/locked' })] },
    runGit: failedRunGit,
    now: () => NOW,
  })
  const brokenDoc = await broken.sample()
  same(brokenDoc.projects[0].git, {
    repo: false,
    error: 'fatal: detected dubious ownership in repository at \'C:/work/locked\'',
  }, 'a genuine git failure keeps its reason')
  is(brokenDoc.projects[0].status, 'ok', 'the workspace status is independent of git')
  is(failedCalls.length, 1, 'a failed status stops the other two queries')
  same(brokenDoc.summary, { total: 1, dirty: 0, live: 0, running: 0, worktrees: 0, missing: 0 },
    'a failed git read contributes no git counts')

  // A transport that rejects must not reject the sample.
  const rejected = createProjectsReader({
    registry: { list: () => [workspace('offline')] },
    runGit: async () => { throw new Error('spawn git ENOENT') },
    now: () => NOW,
  })
  const rejectedDoc = await rejected.sample()
  same(rejectedDoc.projects[0].git, { repo: false, error: 'spawn git ENOENT' },
    'a rejected transport becomes a structured error')

  const shapeless = createProjectsReader({
    registry: { list: () => [workspace('shapeless')] },
    runGit: async () => undefined,
    now: () => NOW,
  })
  const shapelessDoc = await shapeless.sample()
  same(shapelessDoc.projects[0].git, { repo: false, error: 'git returned no result' },
    'a transport that answers nothing is reported, not trusted')
  console.log('  git errors: non-repository, dubious ownership and a rejected transport are data')
}

// ------------------------------------------- optional queries and empty history

{
  const reader = createProjectsReader({
    registry: { list: () => [workspace('history')] },
    runGit: makeGit({
      status: { ok: true, stdout: '## main\n', stderr: '', code: 0 },
      log: { ok: true, stdout: '  \n', stderr: '', code: 0 },
      worktree: { ok: false, stdout: '', stderr: 'fatal: worktree list failed', code: 128 },
    }).runGit,
    now: () => NOW,
  })
  const doc = await reader.sample()
  is(doc.projects[0].git.repo, true, 'a repository survives an unreadable history')
  is(doc.projects[0].git.lastCommit, null, 'an empty log line means no commit to show')
  is(doc.projects[0].git.worktrees, 0, 'an unreadable worktree list is zero worktrees')
  is(doc.projects[0].git.dirty, 0, 'a clean status is zero dirty files')
  is(doc.projects[0].git.branch, 'main', 'the branch still parses')

  // Porcelain marks a bare main worktree with its own `bare` line: it is not a
  // checkout a person can open, so it must not inflate the count.
  const bare = createProjectsReader({
    registry: { list: () => [workspace('bare')] },
    runGit: makeGit({
      status: { ok: true, stdout: '## main\n', stderr: '', code: 0 },
      log: { ok: true, stdout: '', stderr: '', code: 0 },
      worktree: { ok: true, stdout: 'worktree C:/work/bare\nbare\n\n', stderr: '', code: 0 },
    }).runGit,
    now: () => NOW,
  })
  is((await bare.sample()).projects[0].git.worktrees, 0, 'a bare worktree is not counted')
  console.log('  optional queries: empty history, broken worktree list and bare repos answer')
}

// ------------------------------------------------------ workspace status + rows

{
  const reader = createProjectsReader({
    registry: {
      list: () => [
        workspace('missing', {
          path: 'C:\\work\\missing',
          sessionIds: ['live-a', 'live-a', 'live-b', 'gone'],
          status: async () => 'missing-dir',
        }),
        workspace('unknown', {
          path: 'C:\\work\\unknown',
          status: async () => { throw new Error('stat failed') },
        }),
        workspace('weird', {
          path: 'C:\\work\\weird',
          title: undefined,
          status: async () => 'something-else',
        }),
        null,
        'not a workspace',
        {},
      ],
    },
    agents: {
      list: () => [
        { id: 'live-a', status: 'idle' },
        { id: 'live-b', status: 'running' },
      ],
    },
    runGit: makeGit({ status: NOT_REPO }).runGit,
    now: () => NOW,
  })
  const doc = await reader.sample()
  same(doc.projects.map((project) => project.id), ['missing', 'unknown', 'weird'],
    'malformed registry entries are ignored, not rendered as blanks')
  same(doc.projects.map((project) => project.status), ['missing-dir', 'unknown', 'unknown'],
    'a throwing or unknown status stays unknown, and dir status survives')
  is(doc.projects[0].sessions, 4, 'sessions counts the recorded ids')
  is(doc.projects[0].live, 2, 'a duplicated session id counts once')
  is(doc.projects[0].running, 1, 'only the running agent advances the running count')
  is(doc.projects[2].title, 'weird', 'a missing title falls back to the directory name')
  is(doc.summary.missing, 1, 'missing directories are counted in the summary')
  is(doc.summary.live, 2, 'live sessions are summed across projects')

  // A broken agent registry means zero live readings, not a broken wall.
  const noAgents = createProjectsReader({
    registry: { list: () => [workspace('quiet', { sessionIds: ['a'] })] },
    agents: { list() { throw new Error('agents down') } },
    runGit: makeGit({ status: NOT_REPO }).runGit,
    now: () => NOW,
  })
  const quiet = await noAgents.sample()
  is(quiet.projects[0].live, 0, 'a throwing agent registry reads zero live sessions')
  is(quiet.projects[0].sessions, 1, 'the session count still comes from the workspace')

  // A workspace with no id is still a project; it is keyed by its path.
  const pathOnly = createProjectsReader({
    registry: { list: () => [{ path: 'C:\\Projects\\alpha', updatedAt: NOW }] },
    runGit: makeGit({ status: NOT_REPO }).runGit,
    now: () => NOW,
  })
  const pathDoc = await pathOnly.sample()
  is(pathDoc.projects[0].id, '', 'a missing id stays empty rather than invented')
  is(pathDoc.projects[0].title, 'alpha', 'a Windows path yields its last component as the title')
  console.log('  workspaces: status, duplicate sessions, malformed entries and path titles')
}

// -------------------------------------------------------- bounded concurrency

{
  let active = 0
  let maxActive = 0
  let seen = 0
  const slowGit = async () => {
    active += 1
    seen += 1
    if (active > maxActive) maxActive = active
    await new Promise((resolve) => setTimeout(resolve, 8))
    active -= 1
    return NOT_REPO
  }
  const projects = []
  for (let index = 0; index < 10; index += 1) {
    projects.push(workspace('p' + index, { path: 'C:/work/p' + index }))
  }
  const reader = createProjectsReader({
    registry: { list: () => projects },
    runGit: slowGit,
    now: () => NOW,
  })
  const doc = await reader.sample()
  is(doc.projects.length, 10, 'every project is inspected')
  is(seen, 10, 'ten projects make ten queries when each is not a repository')
  ok(maxActive <= 4, 'at most four projects are inspected at once, saw ' + maxActive)
  ok(maxActive >= 2, 'the pool actually runs in parallel, saw ' + maxActive)
  console.log('  concurrency: the pool caps at four and still overlaps work')
}

// ------------------------------------------------------------ never throwing

{
  const reader = createProjectsReader({
    registry: {
      list() {
        return [
          workspace('hostile', {
            sessionIds: ['a'],
            status: async () => { throw new Error('status exploded') },
          }),
        ]
      },
    },
    agents: { list: () => [null, 42, { id: 'a', status: 'running' }] },
    runGit: async () => { throw new TypeError('git exploded') },
    now: () => NOW,
  })
  checks += 1
  await assert.doesNotReject(() => reader.sample(), 'sample() must never reject')
  const doc = await reader.sample()
  is(doc.available, true, 'hostile inputs still produce an available reading')
  is(doc.projects[0].live, 1, 'malformed agent records do not hide a real one')
  is(doc.projects[0].git.repo, false, 'a throwing transport is a structured failure')

  const defaultClock = await createProjectsReader({
    registry: { list: () => [] },
  }).sample()
  ok(Number.isFinite(defaultClock.at) && defaultClock.at > 0, 'the default clock is a real instant')
  console.log('  resilience: sample never rejects, malformed records are skipped')
}

console.log('projects-host: ' + checks + ' checks passed')
