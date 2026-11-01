/**
 * Host-side checks for lib/host/hygiene.js.
 *
 * Run with `node test/hygiene-host.mjs`. The test builds a throwaway DSH home,
 * gives its log files known ages, and verifies both the read-only inventory and
 * the single delete action against the real filesystem.
 */

import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readdir, rm, rmdir, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createHygiene } from '../lib/host/hygiene.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()
const OLD = new Date(NOW - 10 * DAY)
const YOUNG = new Date(NOW - 1 * DAY)
const EDGE = new Date(NOW - 7 * DAY + 60 * 1000)

let checks = 0
function ok(value, label) {
  checks += 1
  assert.ok(value, label)
}
function is(actual, expected, label) {
  checks += 1
  assert.equal(actual, expected, label)
}
function same(actual, expected, label) {
  checks += 1
  assert.deepEqual(actual, expected, label)
}

/**
 * Write a file of the requested size.
 * @param {string} file - absolute path.
 * @param {number} size - byte count.
 * @returns {Promise<void>} resolves after the write.
 */
async function put(file, size) {
  await writeFile(file, Buffer.alloc(size, 0x2e))
}

/**
 * Give a file a known modification time.
 * @param {string} file - absolute path.
 * @param {Date} when - the timestamp.
 * @returns {Promise<void>} resolves after the touch.
 */
async function age(file, when) {
  await utimes(file, when, when)
}

/**
 * Category row by id.
 * @param {object} doc - the inventory document.
 * @param {string} id - category name.
 * @returns {object} the row.
 */
function row(doc, id) {
  const found = doc.categories.filter(function (item) {
    return item.id === id
  })
  return found.length === 1 ? found[0] : null
}

const base = await mkdtemp(path.join(tmpdir(), 'dsh-hygiene-'))
const root = path.join(base, 'home')
const outside = path.join(base, 'outside.log')
const outsideDir = path.join(base, 'outside-dir')
let linkName = ''
let escapeLink = ''

try {
  await mkdir(path.join(root, 'sessions', 'nested'), { recursive: true })
  await mkdir(path.join(root, 'storages'), { recursive: true })
  await mkdir(path.join(root, 'logs', 'nested'), { recursive: true })
  await mkdir(path.join(root, 'cache'), { recursive: true })
  await mkdir(path.join(root, 'attachments'), { recursive: true })
  // "profiles" is deliberately absent: the scanner must report it as missing.

  await put(path.join(root, 'sessions', 's1.jsonl'), 100)
  await put(path.join(root, 'sessions', 'nested', 's2.jsonl'), 50)
  await put(path.join(root, 'storages', 'blob.bin'), 300)
  await put(path.join(root, 'logs', 'a.log'), 10)
  await put(path.join(root, 'logs', 'b.log'), 20)
  await put(path.join(root, 'logs', 'keep.txt'), 30)
  await put(path.join(root, 'logs', 'nested', 'c.log'), 40)
  await put(path.join(root, 'logs', 'nested', 'd.log'), 50)
  await put(path.join(root, 'logs', 'edge.log'), 7)
  await put(path.join(root, 'cache', 'c.tmp'), 200)
  await put(path.join(root, 'attachments', 'att.png'), 150)
  await put(outside, 999)
  await mkdir(outsideDir)
  await put(path.join(outsideDir, 'trap.log'), 77)

  await age(path.join(root, 'logs', 'a.log'), OLD)
  await age(path.join(root, 'logs', 'keep.txt'), OLD)
  await age(path.join(root, 'logs', 'nested', 'c.log'), OLD)
  await age(path.join(root, 'logs', 'b.log'), YOUNG)
  await age(path.join(root, 'logs', 'nested', 'd.log'), YOUNG)
  await age(path.join(root, 'logs', 'edge.log'), EDGE)
  await age(path.join(outsideDir, 'trap.log'), OLD)

  try {
    await symlink(outside, path.join(root, 'logs', 'a-link.log'))
    linkName = 'a-link.log'
  } catch (error) {
    // Windows without developer mode refuses file symlinks; a junction needs no
    // privilege and exercises the same "never follow a link" rule for directories.
    try {
      await symlink(outsideDir, path.join(root, 'logs', 'dir-link.log'), 'junction')
      linkName = 'dir-link.log'
    } catch (nested) {
      linkName = ''
    }
  }

  const host = createHygiene({ root, now: () => NOW })
  const doc = await host.sample()

  is(doc.available, true, 'a real home is available')
  is(doc.root, path.resolve(root), 'the document echoes the absolute root')
  is(doc.at, NOW, 'the document uses the injected clock')
  is(doc.totalFiles, 11, 'every regular file below the six categories is counted')
  is(doc.totalBytes, 957, 'sizes are summed from lstat')
  is(doc.reclaimableFiles, 2, 'two old .log files are reclaimable')
  is(doc.reclaimableBytes, 50, 'their sizes are summed')
  is(doc.categories.length, 6, 'all six categories are reported')
  same(
    doc.categories.map(function (item) {
      return item.id
    }),
    ['sessions', 'storages', 'logs', 'cache', 'attachments', 'profiles'],
    'categories keep display order',
  )

  const sessions = row(doc, 'sessions')
  is(sessions.bytes, 150, 'sessions includes a nested file')
  is(sessions.files, 2, 'sessions file count')
  is(sessions.exists, true, 'sessions exists')
  is(sessions.path, path.join(root, 'sessions'), 'category path is absolute')
  is(sessions.reclaimableFiles, 0, 'only logs offers reclaimable files')

  const logs = row(doc, 'logs')
  is(logs.files, 6, 'logs counts every regular file, not only .log')
  is(logs.bytes, 157, 'logs sums every regular file')
  is(logs.reclaimableFiles, 2, 'only old .log files count as reclaimable')
  is(logs.reclaimableBytes, 50, 'reclaimable bytes exclude keep.txt and the 7-day edge')
  is(logs.truncated, false, 'a small tree is not truncated')
  if (linkName !== '') {
    is((await lstat(path.join(root, 'logs', linkName))).isFile(), false, 'the planted link stays a link')
  }

  const profiles = row(doc, 'profiles')
  same(
    { exists: profiles.exists, bytes: profiles.bytes, files: profiles.files },
    { exists: false, bytes: 0, files: 0 },
    'a missing category reports zeros',
  )

  const again = await host.sample()
  is(again.totalBytes, doc.totalBytes, 'repeated samples agree')

  // A tree that changed shape after the scan is re-checked before deletion.
  const removed = await host.pruneLogs({ olderThanDays: 7 })
  is(removed.removed, 2, 'prune removes exactly the old .log files')
  is(removed.bytes, 50, 'prune reports the freed bytes')
  is(removed.failed.length, 0, 'a clean prune reports no failures')

  await assert.rejects(stat(path.join(root, 'logs', 'a.log')), { code: 'ENOENT' }, 'old log deleted')
  await assert.rejects(stat(path.join(root, 'logs', 'nested', 'c.log')), { code: 'ENOENT' }, 'nested old log deleted')
  is((await stat(path.join(root, 'logs', 'b.log'))).size, 20, 'new log kept')
  is((await stat(path.join(root, 'logs', 'nested', 'd.log'))).size, 50, 'nested new log kept')
  is((await stat(path.join(root, 'logs', 'keep.txt'))).size, 30, 'non-.log kept')
  is((await stat(path.join(root, 'logs', 'edge.log'))).size, 7, 'a log younger than 7 days is kept')
  is((await stat(outside)).size, 999, 'a link target outside the home is untouched')
  is((await stat(path.join(outsideDir, 'trap.log'))).size, 77, 'a directory behind a link is never entered')
  if (linkName !== '') {
    is((await lstat(path.join(root, 'logs', linkName))).isFile(), false, 'the link itself remains')
  }
  is((await stat(path.join(root, 'sessions', 's1.jsonl'))).size, 100, 'sessions are untouched')
  is((await stat(path.join(root, 'storages', 'blob.bin'))).size, 300, 'storages are untouched')
  is((await stat(path.join(root, 'cache', 'c.tmp'))).size, 200, 'cache is untouched')
  is((await stat(path.join(root, 'attachments', 'att.png'))).size, 150, 'attachments are untouched')

  const twice = await host.pruneLogs({ olderThanDays: 7 })
  same({ removed: twice.removed, bytes: twice.bytes, failed: twice.failed.length }, { removed: 0, bytes: 0, failed: 0 }, 'prune is idempotent')

  const entries = await readdir(path.join(root, 'logs'))
  const expectedLeft = ['b.log', 'edge.log', 'keep.txt', 'nested']
  if (linkName !== '') expectedLeft.push(linkName)
  same(entries.sort(), expectedLeft.sort(), 'only the old .log files left the logs tree')

  for (const bad of [0, -1, 1.5, '7', null, 4000, 3651, undefined, Number.NaN]) {
    checks += 1
    await assert.rejects(
      host.pruneLogs({ olderThanDays: bad }),
      function (error) {
        return error instanceof TypeError || error instanceof RangeError
      },
      `olderThanDays=${String(bad)} is refused`,
    )
  }
  await assert.rejects(host.pruneLogs(), TypeError, 'a missing payload is refused')
  checks += 1

  const missing = createHygiene({ root: path.join(base, 'absent'), now: () => NOW })
  const absentDoc = await missing.sample()
  is(absentDoc.available, false, 'a missing root reports unavailable')
  is(typeof absentDoc.reason, 'string', 'the unavailable document explains itself')
  is(absentDoc.categories.length, 6, 'the unavailable document keeps the shape')
  is(absentDoc.totalBytes, 0, 'the unavailable document has zero bytes')
  ok(
    absentDoc.categories.every(function (item) {
      return item.exists === false && item.bytes === 0 && item.files === 0
    }),
    'every missing category is zeroed',
  )
  const absentPrune = await missing.pruneLogs({ olderThanDays: 7 })
  same(absentPrune, { removed: 0, bytes: 0, failed: [] }, 'prune on a missing root is a no-op')

  const fileRoot = path.join(base, 'home-file')
  await put(fileRoot, 3)
  const fileDoc = await createHygiene({ root: fileRoot, now: () => NOW }).sample()
  is(fileDoc.available, false, 'a non-directory root is unavailable')
  ok(fileDoc.reason.indexOf('not a directory') !== -1, 'the reason names the problem')

  if (linkName !== '') {
    // A logs directory that resolves outside the home must never be measured or
    // pruned through: that is the case a junction makes possible on Windows.
    const escapeHome = path.join(base, 'escape-home')
    await mkdir(path.join(escapeHome, 'sessions'), { recursive: true })
    await symlink(outsideDir, path.join(escapeHome, 'logs'), 'junction')
    escapeLink = path.join(escapeHome, 'logs')
    const escapeHost = createHygiene({ root: escapeHome, now: () => NOW })
    const escapeDoc = await escapeHost.sample()
    is(row(escapeDoc, 'logs').exists, true, 'an escaping logs directory reports existence')
    is(row(escapeDoc, 'logs').bytes, 0, 'an escaping logs directory is not measured')
    const escapePrune = await escapeHost.pruneLogs({ olderThanDays: 7 })
    same(escapePrune, { removed: 0, bytes: 0, failed: [] }, 'prune refuses a logs directory outside the home')
    is((await stat(path.join(outsideDir, 'trap.log'))).size, 77, 'targets behind the escaping link stay intact')
  }

  console.log(`hygiene-host: ${checks} checks passed`)
  if (linkName === '') console.log('hygiene-host: link check skipped (no link could be created here)')
} finally {
  const links = []
  if (linkName !== '') links.push(path.join(root, 'logs', linkName))
  if (escapeLink !== '') links.push(escapeLink)
  for (const link of links) {
    // A junction is a reparse point; remove the link itself, never its target.
    try {
      await rmdir(link)
    } catch (error) {
      await unlink(link).catch(function () {})
    }
  }
  await rm(base, { recursive: true, force: true })
}
