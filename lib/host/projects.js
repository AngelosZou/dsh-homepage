/**
 * dsh-homepage — Host half, project reader.
 *
 * Answers the one question the Projects card asks: which repositories does this
 * person have, and what state is each in? The workspace registry owns the list,
 * the live-agent map owns "is anyone working here", and git is asked three
 * short questions per repository — status, last commit, worktrees.
 *
 * Read-only by construction: every git invocation is a query, nothing is
 * written, and the only paths visited are the ones the registry already holds.
 * A failure is data (`git: null` for "not a repository", `{ repo: false, error }`
 * for a real git failure) rather than an exception, because the caller is a card
 * rendering inside someone else's window.
 *
 * The collector owns caching; this module samples on every call and remembers
 * nothing between calls.
 *
 * @module dsh-homepage/host/projects
 */

import { spawn } from 'node:child_process'

/** One git query may not hold the card hostage. */
const GIT_TIMEOUT_MS = 4000

/** At most this many repositories are inspected at once. */
const GIT_CONCURRENCY = 4

/**
 * Coerce a registry value to text without turning null into "null".
 * @param {unknown} value - whatever the registry held.
 * @returns {string} the text form, or '' for null/undefined.
 */
function textOf(value) {
  if (value === undefined || value === null) return ''
  return String(value)
}

/**
 * Describe one thrown value, never with an empty string.
 * @param {unknown} error - whatever was thrown.
 * @returns {string} a message good enough to show in an error chip.
 */
function messageOf(error) {
  if (error === undefined || error === null) return 'unknown failure'
  const text = error instanceof Error ? error.message : textOf(error)
  const trimmed = text.trim()
  return trimmed === '' ? 'unknown failure' : trimmed
}

/**
 * Convert a registry timestamp to the sortable epoch the card expects. The
 * registry uses epoch milliseconds, but an ISO string costs nothing to accept.
 * @param {unknown} value - the recorded `updatedAt`.
 * @returns {number} epoch milliseconds, or 0 when absent/unreadable.
 */
function stampOf(value) {
  const number = Number(value)
  if (Number.isFinite(number)) return number > 0 ? number : 0
  const parsed = Date.parse(textOf(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * The last component of a project directory. Both separators are handled
 * because the registry may hold a Windows path while the panel runs anywhere.
 * @param {unknown} value - a filesystem path.
 * @returns {string} the last component, or '' for an empty path.
 */
function baseName(value) {
  const text = textOf(value).trim()
  if (text === '') return ''
  const parts = text.split(/[\\/]+/)
  let last = ''
  for (const part of parts) if (part !== '') last = part
  return last === '' ? text : last
}

/** @returns {object} a zeroed summary; a fresh object every call. */
function emptySummary() {
  return { total: 0, dirty: 0, live: 0, running: 0, worktrees: 0, missing: 0 }
}

/**
 * Parse `git status --porcelain=v1 --branch`.
 *
 * The first `##` line carries the branch and the ahead/behind note; every other
 * non-empty line is one changed path (untracked `??` included). The branch name
 * falls back through the two wordings git actually emits for a repository with
 * no commit yet and for a detached HEAD.
 *
 * @param {string} output - the command's stdout.
 * @returns {{ branch: string, dirty: number, ahead: number, behind: number }} the reading.
 */
function parseStatus(output) {
  let branch = ''
  let ahead = 0
  let behind = 0
  let dirty = 0
  let header = false
  for (const line of textOf(output).split(/\r?\n/)) {
    if (line === '') continue
    if (!header && line.startsWith('##')) {
      header = true
      const parsed = parseStatusHeader(line)
      branch = parsed.branch
      ahead = parsed.ahead
      behind = parsed.behind
      continue
    }
    dirty += 1
  }
  return { branch, dirty, ahead, behind }
}

/**
 * Read the one branch line of the porcelain status.
 * @param {string} line - a line starting with `##`.
 * @returns {{ branch: string, ahead: number, behind: number }} the branch reading.
 */
function parseStatusHeader(line) {
  let text = line.slice(2).trim()
  if (text === '') return { branch: '', ahead: 0, behind: 0 }

  let ahead = 0
  let behind = 0
  const note = text.match(/\[([^\]]*)\]/)
  if (note) {
    const aheadMatch = note[1].match(/ahead\s+(\d+)/)
    const behindMatch = note[1].match(/behind\s+(\d+)/)
    if (aheadMatch) ahead = Number(aheadMatch[1])
    if (behindMatch) behind = Number(behindMatch[1])
    text = text.slice(0, note.index).trim()
  }

  const dots = text.indexOf('...')
  if (dots >= 0) text = text.slice(0, dots).trim()

  const noCommits = 'No commits yet on '
  if (text.startsWith(noCommits)) text = text.slice(noCommits.length).trim()
  // A detached HEAD has no branch name; "HEAD" is the honest short answer.
  if (text.startsWith('HEAD (no branch)')) text = 'HEAD'
  return { branch: text, ahead, behind }
}

/**
 * Parse `git log -1 --format=%h%x00%cI%x00%s`.
 * @param {string} output - the command's stdout.
 * @returns {{ hash: string, at: number, subject: string } | null} the commit, or null.
 */
function parseLastCommit(output) {
  const text = textOf(output).replace(/\r?\n$/, '')
  if (text.trim() === '') return null
  const parts = text.split('\x00')
  if (parts.length < 3) return null
  const hash = parts[0].trim()
  if (hash === '') return null
  const parsed = Date.parse(parts[1].trim())
  return {
    hash,
    at: Number.isFinite(parsed) ? parsed : 0,
    subject: parts.slice(2).join('\x00').trim(),
  }
}

/**
 * Count `git worktree list --porcelain` entries beyond the repository's own
 * checkout. Porcelain separates worktrees with blank lines and marks a bare
 * main worktree with a `bare` line in its own block, so a block counts only
 * when it names a worktree and is not bare. The main checkout is not an extra,
 * so a repository with no linked worktrees answers zero.
 * @param {string} output - the command's stdout.
 * @returns {number} how many extra worktrees the repository has.
 */
function countWorktrees(output) {
  let count = 0
  for (const block of textOf(output).split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    if (!lines.some((line) => line.startsWith('worktree '))) continue
    if (lines.some((line) => line === 'bare')) continue
    count += 1
  }
  return count > 0 ? count - 1 : 0
}

/**
 * A small sequential pool: take up to `limit` items at a time, preserving the
 * input order in the result. The functions handed in never throw.
 * @param {unknown[]} items - work items.
 * @param {number} limit - maximum in-flight count.
 * @param {(item: unknown, index: number) => Promise<unknown>} fn - the work.
 * @returns {Promise<unknown[]>} one result per item, in input order.
 */
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const size = Math.min(Math.max(1, limit), items.length)
  const workers = []
  for (let index = 0; index < size; index += 1) {
    workers.push((async () => {
      for (;;) {
        const current = next
        next += 1
        if (current >= items.length) return
        results[current] = await fn(items[current], current)
      }
    })())
  }
  await Promise.all(workers)
  return results
}

/**
 * The default git runner: one child process per query, no shell, bounded wait.
 * It never rejects — a spawn failure, a non-zero exit and a timeout all come
 * back as the same structured result.
 * @param {string[]} args - git arguments, without the executable.
 * @param {string} cwd - the repository directory.
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code: number|null }>} the result.
 */
function runGitProcess(args, cwd) {
  return new Promise((resolve) => {
    let child = null
    let settled = false
    let stdout = ''
    let stderr = ''
    let timer = null

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(result)
    }

    try {
      child = spawn('git', Array.isArray(args) ? args : [], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ ok: false, stdout: '', stderr: messageOf(error), code: null })
      return
    }

    timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch (error) {
        void error
      }
      finish({
        ok: false,
        stdout,
        stderr: stderr.trim() === '' ? 'git timed out after ' + GIT_TIMEOUT_MS + ' ms' : stderr,
        code: null,
      })
    }, GIT_TIMEOUT_MS)

    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => { stderr += chunk })
    }
    child.on('error', (error) => {
      finish({ ok: false, stdout, stderr: stderr.trim() === '' ? messageOf(error) : stderr, code: null })
    })
    child.on('close', (code) => {
      finish({ ok: code === 0, stdout, stderr, code: typeof code === 'number' ? code : null })
    })
  })
}

/**
 * Create the project reader the collector calls.
 *
 * Every injected option is optional so the host can wire what it has and the
 * tests can wire fakes: a missing registry makes the reading unavailable, a
 * missing agent map makes every live count zero, and a missing git runner falls
 * back to spawning git.
 *
 * @param {object} [options] - injectable environment.
 * @param {{ list: () => object[] }} [options.registry] - the DSH workspace registry.
 * @param {{ list: () => object[] }} [options.agents] - the live agent registry.
 * @param {(args: string[], cwd: string) => Promise<object>} [options.runGit] - git transport.
 * @param {() => number} [options.now] - clock, in epoch milliseconds.
 * @returns {{ sample: () => Promise<object> }} the reader; `sample()` never rejects.
 */
export function createProjectsReader(options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const registry = settings.registry || null
  const agents = settings.agents || null
  const runGit = typeof settings.runGit === 'function' ? settings.runGit : runGitProcess
  const now = typeof settings.now === 'function' ? settings.now : Date.now

  /** @returns {number} the sample instant, even when the clock misbehaves. */
  function instant() {
    try {
      const value = Number(now())
      return Number.isFinite(value) ? value : Date.now()
    } catch (error) {
      void error
      return Date.now()
    }
  }

  /**
   * Map agent id to its one status. A workspace session is "live" when it
   * appears here at all; only `running` advances the running count.
   * @returns {Map<string, string>} the status map; empty when agents are absent.
   */
  function liveAgents() {
    const map = new Map()
    try {
      if (!agents || typeof agents.list !== 'function') return map
      const listed = agents.list()
      if (!Array.isArray(listed)) return map
      for (const agent of listed) {
        if (agent === null || typeof agent !== 'object') continue
        const id = textOf(agent.id).trim()
        if (id === '') continue
        map.set(id, agent.status === 'running' ? 'running' : 'idle')
      }
    } catch (error) {
      void error
    }
    return map
  }

  /**
   * Count this workspace's sessions that the live map knows about.
   * @param {object} workspace - one registry record.
   * @param {Map<string, string>} live - the agent status map.
   * @returns {{ sessions: number, live: number, running: number }} the counts.
   */
  function countSessions(workspace, live) {
    const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
    const seen = new Set()
    let liveCount = 0
    let running = 0
    for (const value of ids) {
      const id = textOf(value).trim()
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      const status = live.get(id)
      if (status === undefined) continue
      liveCount += 1
      if (status === 'running') running += 1
    }
    return { sessions: ids.length, live: liveCount, running }
  }

  /**
   * Ask one workspace whether its directory is still there.
   * @param {object} workspace - one registry record.
   * @returns {Promise<'ok'|'missing-dir'|'unknown'>} the status.
   */
  async function readStatus(workspace) {
    if (!workspace || typeof workspace.status !== 'function') return 'unknown'
    try {
      const value = await workspace.status()
      return value === 'ok' || value === 'missing-dir' ? value : 'unknown'
    } catch (error) {
      void error
      return 'unknown'
    }
  }

  /**
   * Run one git query through the injected transport, normalizing every answer
   * (including a rejection) into the same structured result.
   * @param {string[]} args - git arguments.
   * @param {string} cwd - the repository directory.
   * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code: number|null }>} the result.
   */
  async function callGit(args, cwd) {
    try {
      const result = await runGit(args, cwd)
      if (result === null || typeof result !== 'object') {
        return { ok: false, stdout: '', stderr: 'git returned no result', code: null }
      }
      return {
        ok: result.ok === true,
        stdout: textOf(result.stdout),
        stderr: textOf(result.stderr),
        code: typeof result.code === 'number' ? result.code : null,
      }
    } catch (error) {
      return { ok: false, stdout: '', stderr: messageOf(error), code: null }
    }
  }

  /**
   * Git's "this directory is not a repository" refusal.
   * @param {{ stdout: string, stderr: string }} result - a failed status call.
   * @returns {boolean} true when the failure means "not a repository".
   */
  function isNotRepository(result) {
    const text = (result.stderr + '\n' + result.stdout).toLowerCase()
    return text.includes('not a git repository') || text.includes('not a git repo')
  }

  /**
   * The shortest honest reason for a failed git call.
   * @param {{ stdout: string, stderr: string }} result - a failed call.
   * @returns {string} the first non-empty output line.
   */
  function failureOf(result) {
    const text = result.stderr.trim() !== '' ? result.stderr : result.stdout
    const first = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '')
    return first || 'git failed'
  }

  /**
   * Read one repository. `null` means "not a git repository"; a structured
   * failure means git itself could not answer. The log and worktree queries are
   * optional: a repository without history or with an unreadable worktree list
   * is still a repository.
   * @param {string} projectPath - the directory to inspect.
   * @returns {Promise<object|null>} the git reading, `{ repo: false, error }`, or null.
   */
  async function readGit(projectPath) {
    if (projectPath === '') return null
    const status = await callGit(['status', '--porcelain=v1', '--branch'], projectPath)
    if (!status.ok) {
      return isNotRepository(status) ? null : { repo: false, error: failureOf(status) }
    }
    const parsed = parseStatus(status.stdout)

    let lastCommit = null
    const log = await callGit(['log', '-1', '--format=%h%x00%cI%x00%s'], projectPath)
    if (log.ok) lastCommit = parseLastCommit(log.stdout)

    let worktrees = 0
    const listed = await callGit(['worktree', 'list', '--porcelain'], projectPath)
    if (listed.ok) worktrees = countWorktrees(listed.stdout)

    return {
      repo: true,
      branch: parsed.branch,
      dirty: parsed.dirty,
      ahead: parsed.ahead,
      behind: parsed.behind,
      lastCommit,
      worktrees,
    }
  }

  /**
   * Newest first, then path, then id: the two fallbacks keep the order stable
   * when the registry leaves timestamps equal or absent.
   * @param {object} left - one row.
   * @param {object} right - another row.
   * @returns {number} the sort delta.
   */
  function compareRows(left, right) {
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
    if (left.path !== right.path) return left.path < right.path ? -1 : 1
    if (left.id === right.id) return 0
    return left.id < right.id ? -1 : 1
  }

  /**
   * Derive the wall's one-line summary from the projects it is about to send.
   * `worktrees` is a total across repositories (a repository with no extra
   * checkout still counts its main worktree).
   * @param {object[]} projects - the sampled projects.
   * @returns {object} the summary.
   */
  function summarize(projects) {
    const summary = emptySummary()
    for (const project of projects) {
      summary.total += 1
      summary.live += project.live
      summary.running += project.running
      if (project.status === 'missing-dir') summary.missing += 1
      const git = project.git
      if (git && git.repo === true) {
        if (git.dirty > 0) summary.dirty += 1
        summary.worktrees += git.worktrees
      }
    }
    return summary
  }

  /**
   * Read the current project wall. Never throws: a missing registry, a broken
   * status probe, a rejected git transport and a broken clock all degrade to
   * the documented shapes.
   * @returns {Promise<object>} the host document.
   */
  async function sample() {
    const at = instant()
    try {
      if (!registry || typeof registry.list !== 'function') {
        return { available: false, reason: 'the workspace registry is unavailable', at, summary: emptySummary(), projects: [] }
      }
      const listed = registry.list()
      if (!Array.isArray(listed)) {
        return { available: false, reason: 'the workspace registry returned no list', at, summary: emptySummary(), projects: [] }
      }

      const live = liveAgents()
      const rows = []
      for (const workspace of listed) {
        if (workspace === null || typeof workspace !== 'object') continue
        const path = textOf(workspace.path).trim()
        const id = textOf(workspace.id).trim()
        if (id === '' && path === '') continue
        const counts = countSessions(workspace, live)
        rows.push({
          id,
          path,
          title: textOf(workspace.title).trim() || baseName(path) || id,
          updatedAt: stampOf(workspace.updatedAt),
          sessions: counts.sessions,
          live: counts.live,
          running: counts.running,
          workspace,
        })
      }

      // Directory liveness first: one cheap probe per workspace, all in flight,
      // so the bounded git pool below only ever holds repositories it can read.
      await Promise.all(rows.map(async (row) => {
        row.status = await readStatus(row.workspace)
      }))
      rows.sort(compareRows)

      const projects = await mapLimited(rows, GIT_CONCURRENCY, async (row) => ({
        id: row.id,
        title: row.title,
        path: row.path,
        status: row.status,
        sessions: row.sessions,
        live: row.live,
        running: row.running,
        git: await readGit(row.path),
      }))

      return { available: true, at, summary: summarize(projects), projects }
    } catch (error) {
      return { available: false, reason: messageOf(error), at, summary: emptySummary(), projects: [] }
    }
  }

  return { sample }
}
