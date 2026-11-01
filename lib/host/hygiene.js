/**
 * dsh-homepage — Host half, hygiene inventory.
 *
 * A read-only measurement of the DSH home plus exactly one write: deleting old
 * `.log` files under `<root>/logs`. The scanner only looks at six known
 * subdirectories, never follows a symlink, never reads a file's contents, and
 * never touches sessions, storages, cache, attachments, or profiles.
 *
 * `pruneLogs` decides on the same `lstat` information the scan used and checks
 * it again immediately before every unlink, so a directory that appears to be
 * logs cannot redirect a delete elsewhere. One failed file is reported and the
 * remaining candidates still run.
 *
 * @module dsh-homepage/host/hygiene
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Subdirectories of the DSH home the inventory reports, in display order. */
export const CATEGORY_IDS = ['sessions', 'storages', 'logs', 'cache', 'attachments', 'profiles']

const DAY_MS = 24 * 60 * 60 * 1000
const LOG_DAYS = 7
const MIN_DAYS = 1
const MAX_DAYS = 3650
/** Deepest directory level the scan descends into below one category. */
const MAX_DEPTH = 12
/** Most files the scan counts for one category before reporting truncation. */
const MAX_FILES = 50000

/**
 * Describe one thrown value for a structured error field.
 * @param {unknown} error - whatever the filesystem threw.
 * @returns {string} a message that is never empty.
 */
function messageOf(error) {
  if (error instanceof Error && error.message !== '') return error.message
  const text = String(error === undefined ? '' : error)
  return text === '' ? 'unknown failure' : text
}

/**
 * The default DSH home: `DSH_HOME`, else `~/.dsh`.
 * @returns {string} an absolute path.
 */
function defaultRoot() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (configured !== '') return path.resolve(configured)
  return path.join(os.homedir(), '.dsh')
}

/**
 * Whether a resolved path still lives at or below a resolved base directory.
 * Windows junctions are directories rather than symlinks to `lstat`, so the
 * resolved path is the only reliable way to keep the scan inside its tree.
 * @param {string} base - resolved absolute directory.
 * @param {string} target - resolved absolute path.
 * @returns {boolean} true when `target` is inside `base`.
 */
function within(base, target) {
  const relative = path.relative(base, target)
  if (relative === '') return true
  if (path.isAbsolute(relative)) return false
  return relative !== '..' && !relative.startsWith('..' + path.sep)
}

/**
 * One all-zero category row.
 * @param {string} root - absolute DSH home.
 * @param {string} id - category name.
 * @param {boolean} exists - whether a real directory was seen.
 * @returns {object} the row.
 */
function emptyCategory(root, id, exists) {
  return {
    id,
    path: path.join(root, id),
    exists,
    bytes: 0,
    files: 0,
    truncated: false,
    reclaimableBytes: 0,
    reclaimableFiles: 0,
  }
}

/**
 * Create the hygiene inventory and its one action.
 * @param {object} [options] - injectable environment.
 * @param {string} [options.root] - absolute DSH home; defaults to `DSH_HOME` or `~/.dsh`.
 * @param {() => number} [options.now] - clock, `Date.now` by default.
 * @param {object} [options.fs] - `node:fs/promises`-shaped adapter, the real module by default.
 * @returns {{ sample: () => Promise<object>, pruneLogs: (payload: object) => Promise<object> }}
 */
export function createHygiene(options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const io = settings.fs !== undefined && settings.fs !== null ? settings.fs : fs
  const clock = typeof settings.now === 'function' ? settings.now : Date.now

  /**
   * Current wall clock, falling back to the real clock if an injected one misbehaves.
   * @returns {number} milliseconds since the epoch.
   */
  function now() {
    try {
      const at = Number(clock())
      return Number.isFinite(at) ? at : Date.now()
    } catch (error) {
      return Date.now()
    }
  }

  /**
   * Resolve the configured root without ever throwing.
   * @returns {string} an absolute path, or '' when nothing usable was configured.
   */
  function rootPath() {
    const configured = settings.root === undefined || settings.root === null ? '' : String(settings.root).trim()
    if (configured === '') return defaultRoot()
    try {
      return path.resolve(configured)
    } catch (error) {
      return ''
    }
  }

  /**
   * Read metadata for one path, or null when it is absent or unreadable.
   * @param {string} target - absolute path.
   * @returns {Promise<object|null>} the `lstat` result.
   */
  async function statSafe(target) {
    try {
      return await io.lstat(target)
    } catch (error) {
      return null
    }
  }

  /**
   * Resolve a path through every link, or null when it cannot be resolved.
   * @param {string} target - absolute path.
   * @returns {Promise<string|null>} the canonical absolute path.
   */
  async function realPath(target) {
    if (typeof io.realpath !== 'function') return target
    try {
      return await io.realpath(target)
    } catch (error) {
      return null
    }
  }

  /**
   * Measure one category without following links.
   * @param {string} root - absolute DSH home.
   * @param {string} rootReal - resolved DSH home.
   * @param {string} id - category name.
   * @param {number} cutoff - mtime below which a `.log` file is reclaimable.
   * @returns {Promise<object>} the category row.
   */
  async function scanCategory(root, rootReal, id, cutoff) {
    const row = emptyCategory(root, id, false)
    const dir = path.join(root, id)
    // Follow the category directory itself so a junction is still reported as
    // present; the realpath check below keeps it from being measured.
    let head = null
    try {
      head = await io.stat(dir)
    } catch (error) {
      head = null
    }
    if (head === null || !head.isDirectory()) return row
    row.exists = true
    // A category directory that resolves outside the home (a junction, for
    // example) is reported but never measured.
    const dirReal = await realPath(dir)
    if (dirReal === null || !within(rootReal, dirReal)) return row

    /** @type {{ dir: string, depth: number }[]} */
    const queue = [{ dir, depth: 0 }]
    while (queue.length > 0) {
      if (row.files >= MAX_FILES) {
        row.truncated = true
        break
      }
      const current = queue.pop()
      let entries
      try {
        entries = await io.readdir(current.dir, { withFileTypes: true })
      } catch (error) {
        continue
      }
      // A stable order keeps two samples of the same tree comparable.
      entries.sort(function (left, right) {
        if (left.name < right.name) return -1
        if (left.name > right.name) return 1
        return 0
      })
      for (const entry of entries) {
        if (row.files >= MAX_FILES) {
          row.truncated = true
          break
        }
        if (entry.isSymbolicLink()) continue
        const target = path.join(current.dir, entry.name)
        if (entry.isDirectory()) {
          if (current.depth + 1 > MAX_DEPTH) {
            row.truncated = true
            continue
          }
          const childReal = await realPath(target)
          if (childReal === null || !within(dirReal, childReal)) continue
          queue.push({ dir: target, depth: current.depth + 1 })
          continue
        }
        if (!entry.isFile()) continue
        const info = await statSafe(target)
        if (info === null || !info.isFile()) continue
        row.files += 1
        row.bytes += info.size
        if (id === 'logs' && target.endsWith('.log') && info.mtimeMs < cutoff) {
          row.reclaimableFiles += 1
          row.reclaimableBytes += info.size
        }
      }
    }
    return row
  }

  /**
   * The full inventory document. Never rejects.
   * @returns {Promise<object>} the document the card renders.
   */
  async function readInventory() {
    const at = now()
    const root = rootPath()
    const cutoff = at - LOG_DAYS * DAY_MS
    const rows = CATEGORY_IDS.map(function (id) {
      return emptyCategory(root, id, false)
    })

    /**
     * Answer with an unavailable document, always carrying the full shape.
     * @param {string} reason - why the inventory cannot be trusted.
     * @returns {object} the document.
     */
    function unavailable(reason) {
      return {
        available: false,
        reason,
        root,
        at,
        totalBytes: 0,
        totalFiles: 0,
        reclaimableBytes: 0,
        reclaimableFiles: 0,
        categories: rows,
      }
    }

    // The root is followed on purpose: `~/.dsh` may itself be a link the user made.
    let head = null
    try {
      head = await io.stat(root)
    } catch (error) {
      head = null
    }
    if (head === null) return unavailable('the DSH home does not exist')
    if (!head.isDirectory()) return unavailable('the DSH home is not a directory')
    const rootReal = (await realPath(root)) || root

    try {
      for (let index = 0; index < CATEGORY_IDS.length; index += 1) {
        rows[index] = await scanCategory(root, rootReal, CATEGORY_IDS[index], cutoff)
      }
    } catch (error) {
      return unavailable(messageOf(error))
    }

    let totalBytes = 0
    let totalFiles = 0
    let reclaimableBytes = 0
    let reclaimableFiles = 0
    for (const row of rows) {
      totalBytes += row.bytes
      totalFiles += row.files
      reclaimableBytes += row.reclaimableBytes
      reclaimableFiles += row.reclaimableFiles
    }
    return {
      available: true,
      root,
      at,
      totalBytes,
      totalFiles,
      reclaimableBytes,
      reclaimableFiles,
      categories: rows,
    }
  }

  /**
   * Inventory the DSH home. Resolves to the full document even on failure.
   * @returns {Promise<object>} the document.
   */
  function sample() {
    return Promise.resolve()
      .then(readInventory)
      .catch(function (error) {
        return {
          available: false,
          reason: messageOf(error),
          root: rootPath(),
          at: now(),
          totalBytes: 0,
          totalFiles: 0,
          reclaimableBytes: 0,
          reclaimableFiles: 0,
          categories: CATEGORY_IDS.map(function (id) {
            return emptyCategory(rootPath(), id, false)
          }),
        }
      })
  }

  /**
   * Check the caller's window and answer it in days.
   * @param {object} payload - the action payload.
   * @returns {number} an integer between 1 and 3650.
   */
  function readDays(payload) {
    const body = payload !== null && typeof payload === 'object' ? payload : {}
    const value = body.olderThanDays
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new TypeError('olderThanDays must be an integer between 1 and 3650')
    }
    if (!Number.isInteger(value) || value < MIN_DAYS || value > MAX_DAYS) {
      throw new RangeError('olderThanDays must be an integer between 1 and 3650')
    }
    return value
  }

  /**
   * Collect regular `*.log` files below the logs directory, links excluded.
   * @param {string} dir - absolute directory to walk.
   * @param {string} baseReal - resolved `<root>/logs`.
   * @param {{ name: string, fullPath: string }[]} found - accumulator.
   * @param {number} depth - current level below `<root>/logs`.
   * @returns {Promise<void>} resolves after the subtree is listed.
   */
  async function collectLogs(dir, baseReal, found, depth) {
    if (found.length >= MAX_FILES) return
    let entries
    try {
      entries = await io.readdir(dir, { withFileTypes: true })
    } catch (error) {
      return
    }
    entries.sort(function (left, right) {
      if (left.name < right.name) return -1
      if (left.name > right.name) return 1
      return 0
    })
    for (const entry of entries) {
      if (found.length >= MAX_FILES) return
      if (entry.isSymbolicLink()) continue
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth + 1 > MAX_DEPTH) continue
        const childReal = await realPath(target)
        if (childReal === null || !within(baseReal, childReal)) continue
        await collectLogs(target, baseReal, found, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.log')) continue
      found.push({ name: entry.name, fullPath: target })
    }
  }

  /**
   * Delete `.log` files below `<root>/logs` that are older than the window.
   * @param {{ olderThanDays: number }} payload - the validated window.
   * @returns {Promise<{ removed: number, bytes: number, failed: { name: string, error: string }[] }>} the outcome.
   */
  async function pruneLogs(payload) {
    const days = readDays(payload)
    const cutoff = now() - days * DAY_MS
    const result = { removed: 0, bytes: 0, failed: [] }
    const root = rootPath()
    const dir = path.join(root, 'logs')
    const head = await statSafe(dir)
    if (head === null || !head.isDirectory()) return result
    // Never delete through a logs directory that resolves outside the home.
    const rootReal = (await realPath(root)) || root
    const dirReal = await realPath(dir)
    if (dirReal === null || !within(rootReal, dirReal)) return result

    const found = []
    await collectLogs(dir, dirReal, found, 0)
    for (const file of found) {
      // The tree can change between listing and deletion; trust only this check.
      const info = await statSafe(file.fullPath)
      if (info === null || !info.isFile() || info.isSymbolicLink()) continue
      if (info.mtimeMs >= cutoff) continue
      try {
        await io.unlink(file.fullPath)
        result.removed += 1
        result.bytes += info.size
      } catch (error) {
        result.failed.push({ name: file.name, error: messageOf(error) })
      }
    }
    return result
  }

  return { sample, pruneLogs }
}
