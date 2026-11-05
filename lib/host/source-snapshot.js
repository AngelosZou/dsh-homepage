/**
 * The audit source snapshot.
 *
 * An audit reads code that may be malicious, so the model never gets a shell,
 * a network tool or a generic file reader. Instead the host fetches one artifact
 * from a small allowlist of hosting/registry endpoints, verifies what it can,
 * and stores the bytes in a content-addressed snapshot:
 *
 *   <dir>/manifest.json   one record per entry (path, size, sha256, kind, flags)
 *   <dir>/blobs/<sha256>  file contents, named by their digest, never by the
 *                         path the archive supplied
 *
 * The path from an archive is only a string key. It is never joined to a
 * filesystem path, so a `../`, an absolute path, a symlink or a Windows device
 * name cannot escape the snapshot or overwrite anything. Links are recorded as
 * metadata and never followed.
 *
 * The model-facing tools in `source-tools.js` read this object and nothing else.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, readlink, rename, rm, lstat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { readTar } from './tar.js'

/** Fixed caps for one snapshot. They bound memory, CPU and what the model can read. */
export const SNAPSHOT_LIMITS = Object.freeze({
  downloadBytes: 32 * 1024 * 1024,
  uncompressedBytes: 64 * 1024 * 1024,
  fileBytes: 1024 * 1024,
  totalFileBytes: 64 * 1024 * 1024,
  entries: 20000,
  files: 10000,
  pathLength: 512,
  anomalies: 200,
  readBytes: 64 * 1024,
  readLines: 2000,
  listEntries: 2000,
  grepFiles: 5000,
  grepMatches: 200,
  grepNeedle: 200,
  grepBytes: 16 * 1024 * 1024,
  redirects: 4,
  requestTimeoutMs: 60000,
})

/** Registry origins the audit is allowed to ask for package bytes. */
const NPM_REGISTRY_HOSTS = new Set([
  'registry.npmjs.org',
  'mirrors.cloud.tencent.com',
  'registry.npmmirror.com',
  'cdn.npmmirror.com',
])

/** GitHub's archive endpoint and the object host it redirects to. */
const GITHUB_TARBALL_HOSTS = new Set(['codeload.github.com', 'objects.githubusercontent.com'])

/** Anomalies that mean the model did not see the whole artifact. */
const INCOMPLETE_CODES = new Set([
  'unsafe-path', 'duplicate-path', 'oversized-file', 'symlink', 'hardlink',
  'special-file', 'device', 'fifo', 'other', 'unreadable-directory', 'depth-exceeded', 'snapshot-truncated',
])

/** @returns true when the snapshot cannot be considered complete. */
function isIncomplete(truncated, anomalies, files) {
  if (truncated) return true
  if (files.some((entry) => entry.kind === 'file' && entry.skipped)) return true
  return anomalies.some((entry) => INCOMPLETE_CODES.has(entry.code))
}

/** @returns the sha256 digest of one buffer, as lowercase hex. */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** @returns the raw path for a local spec, or null when `spec` is not local. */
function localPathOf(spec) {
  const text = String(spec || '').trim()
  if (text === '') return null
  if (text.startsWith('file://')) {
    try { return fileURLToPath(text) } catch { return null }
  }
  if (text.startsWith('file:')) return text.slice('file:'.length)
  if (text.startsWith('link:')) return text.slice('link:'.length)
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('/') || text.startsWith('./') || text.startsWith('../')) {
    return text
  }
  return null
}

/** Control and bidi characters that can spoof one line of tool output. */
const DISPLAY_CONTROLS = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u
const DISPLAY_CONTROLS_GLOBAL = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu

/** Write one content-addressed blob, refusing a pre-existing file with other bytes. */
async function storeBlob(blobsDir, sha, data) {
  const blob = join(blobsDir, sha)
  try {
    await writeFile(blob, data, { mode: 0o400, flag: 'wx' })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const info = await lstat(blob)
    if (!info.isFile() || info.size !== data.length) throw new Error('源码快照的 blob 与摘要不一致，拒绝继续')
    const existing = await readFile(blob)
    if (!existing.equals(data)) throw new Error('源码快照的 blob 与摘要不一致，拒绝继续')
  }
}

/** @returns untrusted text made safe for one line of tool output. */
function printable(value, max = 300) {
  return String(value).replace(DISPLAY_CONTROLS_GLOBAL, ' ').slice(0, max)
}

/** @returns a safe archive-relative POSIX path. */
function safePath(raw) {
  if (typeof raw !== 'string' || raw === '') throw new Error('empty path')
  if (raw.includes('\0')) throw new Error('NUL in path')
  if (raw.includes('\\')) throw new Error('backslash in path')
  let path = raw.replace(/^\.\/+/u, '').replace(/\/+$/u, '')
  if (path === '' || path === '.') throw new Error('empty path')
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path)) throw new Error('absolute path')
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new Error('path traversal')
  if (path.length > SNAPSHOT_LIMITS.pathLength) throw new Error('path too long')
  if (DISPLAY_CONTROLS.test(path)) throw new Error('control character in path')
  return path
}

/** @returns true when the bytes do not look like UTF-8 text. */
function looksBinary(data) {
  if (data.length === 0) return false
  if (data.includes(0)) return true
  const sample = data.subarray(0, 8192)
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample)
    return false
  } catch {
    return true
  }
}

/** @returns the SRI/shasum verdict: true, false, or null when none was declared. */
function verifyIntegrity(buffer, integrity, shasum) {
  if (typeof integrity === 'string' && integrity.trim() !== '') {
    for (const token of integrity.trim().split(/\s+/u)) {
      const dash = token.indexOf('-')
      if (dash <= 0) continue
      const algorithm = token.slice(0, dash)
      const expected = token.slice(dash + 1)
      try {
        const actual = createHash(algorithm).update(buffer).digest('base64')
        if (actual === expected) return true
      } catch {
        /* an algorithm this runtime does not have cannot verify the artifact */
      }
    }
    return false
  }
  if (typeof shasum === 'string' && shasum.trim() !== '') {
    return createHash('sha1').update(buffer).digest('hex') === shasum.trim()
  }
  return null
}

/** @returns the codeload URL for one GitHub repository and ref. */
export function githubTarballUrl(full, ref) {
  const parts = String(full || '').split('/')
  if (parts.length !== 2 || parts.some((part) => part === '' || part === '.' || part === '..')
    || !/^[A-Za-z0-9_.-]+$/u.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/u.test(parts[1])) {
    throw new Error('GitHub 仓库名不合法')
  }
  const wanted = String(ref || 'HEAD')
  if (wanted.includes('..') || !/^[A-Za-z0-9._/-]+$/u.test(wanted)) throw new Error('GitHub ref 不合法')
  const encoded = wanted.split('/').map((part) => encodeURIComponent(part)).join('/')
  return 'https://codeload.github.com/' + full + '/tar.gz/' + encoded
}

/**
 * Ask GitHub's read-only API for the commit a ref points at. The codeload
 * archive names its top-level directory after the ref it was asked for, so a
 * `HEAD` archive says `repo-HEAD`; resolving the ref here is what lets the
 * install spec pin the exact commit. An unavailable API (rate limit, offline)
 * is not fatal: the snapshot still exists, and an install re-fetches to verify.
 *
 * @param full - `owner/repo`.
 * @param ref - branch, tag, `HEAD`, or a 40-hex commit.
 * @param options - `{ fetchJson, signal }`.
 * @returns the 40-hex commit, or null when it could not be resolved.
 */
async function resolveGithubCommit(full, ref, options = {}) {
  const wanted = String(ref || 'HEAD')
  if (/^[0-9a-f]{40}$/iu.test(wanted)) return wanted.toLowerCase()
  if (typeof options.fetchJson !== 'function') return null
  const parts = String(full || '').split('/')
  if (parts.length !== 2 || parts.some((part) => part === '' || part === '.' || part === '..')
    || !/^[A-Za-z0-9_.-]+$/u.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/u.test(parts[1])) return null
  try {
    const timeout = AbortSignal.timeout(SNAPSHOT_LIMITS.requestTimeoutMs)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    const answer = await options.fetchJson(
      'https://api.github.com/repos/' + full + '/commits/' + encodeURIComponent(wanted),
      {
        signal,
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-homepage-audit' },
      },
    )
    const sha = answer && typeof answer.sha === 'string' ? answer.sha : ''
    return /^[0-9a-f]{40}$/iu.test(sha) ? sha.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Download one URL with a byte cap, a timeout and a fixed host allowlist.
 * Redirects are followed only while every hop stays on the allowlist.
 * @param url - the HTTPS URL.
 * @param options - `{ signal, maxBytes, allowedHosts }`.
 * @returns the response bytes.
 */
export async function fetchBytes(url, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : SNAPSHOT_LIMITS.downloadBytes
  const allowed = options.allowedHosts instanceof Set ? options.allowedHosts : new Set()
  const timeout = AbortSignal.timeout(SNAPSHOT_LIMITS.requestTimeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let current = new URL(String(url))
  for (let hop = 0; hop <= SNAPSHOT_LIMITS.redirects; hop += 1) {
    if (current.protocol !== 'https:') throw new Error('源码地址必须是 HTTPS')
    if (current.port !== '' && current.port !== '443') throw new Error('源码地址不能使用非标准端口')
    if (current.username !== '' || current.password !== '') throw new Error('源码地址不能携带凭据')
    if (!allowed.has(current.hostname)) throw new Error('源码地址不在允许的平台: ' + current.hostname)
    const response = await fetch(current, {
      redirect: 'manual',
      signal,
      headers: { accept: 'application/octet-stream' },
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('源码地址返回了没有目标的跳转')
      current = new URL(location, current)
      continue
    }
    if (!response.ok) throw new Error('下载源码失败：HTTP ' + response.status)
    const length = Number(response.headers.get('content-length') || 0)
    if (Number.isFinite(length) && length > maxBytes) throw new Error('源码包超过大小上限')
    const chunks = []
    let total = 0
    if (response.body) {
      for await (const chunk of response.body) {
        total += chunk.length
        if (total > maxBytes) throw new Error('源码包超过大小上限')
        chunks.push(Buffer.from(chunk))
      }
    }
    return Buffer.concat(chunks)
  }
  throw new Error('源码地址跳转次数过多')
}

/** @returns a deterministic digest of a local source tree, never following links. */
async function digestLocalTree(root, limits) {
  const rows = []
  let fileCount = 0
  let byteCount = 0
  async function walk(current, relative, depth) {
    if (depth > 32) return
    let entries
    try { entries = await readdir(current, { withFileTypes: true }) } catch { return }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const child = join(current, entry.name)
      const key = relative === '' ? entry.name : relative + '/' + entry.name
      let info
      try { info = await lstat(child) } catch { continue }
      if (info.isSymbolicLink() || info.nlink > 1) continue
      if (info.isDirectory()) { await walk(child, key, depth + 1); continue }
      if (!info.isFile()) continue
      if (fileCount >= limits.files || byteCount + info.size > limits.totalFileBytes) continue
      fileCount += 1
      byteCount += info.size
      if (info.size > limits.fileBytes) {
        rows.push(key + '\0size:' + info.size)
        continue
      }
      const data = await readFile(child)
      rows.push(key + '\0' + sha256(data))
    }
  }
  await walk(root, '', 0)
  return sha256(Buffer.from(rows.sort().join('\n'), 'utf8'))
}

/**
 * Read a local directory or local tarball into the same manifest shape as a
 * remote snapshot. Symlinks are recorded, never followed; the walk skips `.git`
 * and `node_modules`.
 * @param target - the resolved target.
 * @param options - `{ dir, limits }`.
 * @returns a snapshot object.
 */
async function prepareLocalSource(target, options) {
  const raw = localPathOf(target.input) || localPathOf(target.spec)
  if (raw === null) throw new Error('不是可读取的本机源码路径')
  const root = resolve(raw)
  let rootStat
  try { rootStat = await lstat(root) } catch { throw new Error('本机源码路径不存在：' + root) }
  if (rootStat.isSymbolicLink()) throw new Error('本机源码路径不能是符号链接')
  if (!rootStat.isDirectory()) throw new Error('本机源码路径必须是目录（或使用 npm/GitHub 目标）')
  const snapshotRelative = relative(root, resolve(options.dir))
  const sourceRelative = relative(resolve(options.dir), root)
  if (snapshotRelative === '' || (!snapshotRelative.startsWith('..') && !isAbsolute(snapshotRelative))
    || sourceRelative === '' || (!sourceRelative.startsWith('..') && !isAbsolute(sourceRelative))) {
    throw new Error('源码快照目录不能位于被审核的本机源码目录内，也不能是它的父目录')
  }

  const dir = options.dir
  const limits = options.limits
  const blobsDir = join(dir, 'blobs')
  await rm(dir, { recursive: true, force: true })
  await mkdir(blobsDir, { recursive: true, mode: 0o700 })
  const files = []
  const byPath = new Map()
  const anomalies = []
  let fileCount = 0
  let byteCount = 0
  let truncated = false

  const anomaly = (code, path, detail) => {
    if (anomalies.length < limits.anomalies) {
      anomalies.push({
        code: printable(code, 40),
        path: printable(path, 300),
        ...(detail === undefined ? {} : { detail: printable(detail, 300) }),
      })
    }
  }

  /** Walk one directory, never following a link. */
  async function walk(current, relative, depth = 0) {
    if (depth > 32) {
      anomaly('depth-exceeded', relative || '.')
      return
    }
    let entries
    try { entries = await readdir(current, { withFileTypes: true }) } catch (error) {
      anomaly('unreadable-directory', relative || '.', error.message)
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const child = join(current, entry.name)
      const key = relative === '' ? entry.name : relative + '/' + entry.name
      let info
      try { info = await lstat(child) } catch { continue }
      if (info.isSymbolicLink()) {
        let link = ''
        try { link = await readlink(child) } catch { /* the link target is informational */ }
        anomaly('symlink', key, link)
        try {
          const record = { path: safePath(key), kind: 'symlink', size: 0, link: printable(link), binary: false, skipped: false }
          files.push(record)
          byPath.set(record.path, record)
        } catch (error) {
          anomaly('unsafe-path', key, error.message)
        }
        continue
      }
      if (info.isDirectory()) {
        try {
          const record = { path: safePath(key), kind: 'dir', size: 0, binary: false, skipped: false }
          files.push(record)
          byPath.set(record.path, record)
        } catch (error) {
          anomaly('unsafe-path', key, error.message)
        }
        await walk(child, key, depth + 1)
        continue
      }
      if (!info.isFile()) {
        anomaly('special-file', key)
        continue
      }
      if (info.nlink > 1) {
        anomaly('hardlink', key)
        continue
      }
      if (byteCount + info.size > limits.totalFileBytes || fileCount >= limits.files) {
        truncated = true
        anomaly('snapshot-truncated', key, '文件数或总字节超过上限')
        continue
      }
      fileCount += 1
      byteCount += info.size
      let record
      try {
        record = { path: safePath(key), kind: 'file', size: info.size, binary: false, skipped: false }
      } catch (error) {
        anomaly('unsafe-path', key, error.message)
        continue
      }
      if (info.size > limits.fileBytes) {
        record.skipped = true
        anomaly('oversized-file', key, String(info.size))
        files.push(record)
        byPath.set(record.path, record)
        continue
      }
      const data = await readFile(child)
      record.binary = looksBinary(data)
      record.sha256 = sha256(data)
      await storeBlob(blobsDir, record.sha256, data)
      files.push(record)
      byPath.set(record.path, record)
    }
  }

  await walk(root, '')
  truncated = isIncomplete(truncated, anomalies, files)
  const tree = files.filter((entry) => entry.kind === 'file')
    .map((entry) => entry.path + '\0' + (entry.sha256 || 'size:' + entry.size))
    .sort().join('\n')
  const artifactSha256 = sha256(Buffer.from(tree, 'utf8'))
  const source = {
    kind: 'local',
    label: target.name || root,
    ref: null,
    requestedRef: null,
    commit: null,
    installSpec: target.spec,
    pinned: false,
    url: root,
    artifactSha256,
    artifactBytes: byteCount,
    fileCount,
    binaryFiles: files.filter((entry) => entry.kind === 'file' && entry.binary).length,
    byteCount,
    truncated,
    anomalies,
  }
  await writeManifest(dir, source, files)
  return createSnapshot({
    dir,
    source,
    files,
    byPath,
    verify: async () => {
      const again = await digestLocalTree(root, limits)
      return again === artifactSha256
        ? { ok: true, local: true }
        : { ok: false, reason: '本机源码在审核后发生了变化' }
    },
  })
}

/** Write the manifest atomically. */
async function writeManifest(dir, source, files) {
  const body = JSON.stringify({ version: 1, source, files })
  const temporary = join(dir, 'manifest.json.tmp')
  await writeFile(temporary, body, { mode: 0o600, flag: 'wx' })
  await rename(temporary, join(dir, 'manifest.json'))
}

/** Strip one archive wrapper directory only when it matches the expected prefix. */
function stripTopLevel(entries, prefix) {
  if (entries.length === 0 || typeof prefix !== 'string' || prefix === '') {
    return { entries, topLevel: null }
  }
  const first = entries[0].path.split('/')[0]
  if (first === undefined || !first.startsWith(prefix)) return { entries, topLevel: null }
  const all = entries.every((entry) => entry.path === first || entry.path.startsWith(first + '/'))
  const hasNested = entries.some((entry) => entry.path.startsWith(first + '/'))
  if (!all || !hasNested) return { entries, topLevel: null }
  return {
    entries: entries.map((entry) => {
      if (entry.path === first) return { ...entry, path: '' }
      return { ...entry, path: entry.path.slice(first.length + 1) }
    }).filter((entry) => entry.path !== ''),
    topLevel: first,
  }
}

/** @returns the commit SHA encoded in a codeload top-level directory, or null. */
function commitFromTopLevel(topLevel) {
  const match = /(?:^|[-_])([0-9a-f]{40})$/u.exec(String(topLevel || ''))
  return match ? match[1] : null
}

/**
 * Turn one downloaded artifact into a snapshot.
 * @param target - the resolved target.
 * @param options - `{ dir, fetchBytes, limits }`.
 * @returns a snapshot object.
 */
export async function prepareSource(target, options = {}) {
  const dir = options.dir
  if (typeof dir !== 'string' || dir === '') throw new Error('源码快照缺少目录')
  const limits = { ...SNAPSHOT_LIMITS, ...(options.limits || {}) }
  /** Remove a half-built snapshot so a failure leaves no readable evidence behind. */
  const cleanup = async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}) }
  if (target.kind === 'spec' || target.kind === 'vcs') {
    const local = localPathOf(target.input) || localPathOf(target.spec)
    if (local !== null) {
      // `prepareLocalSource` validates before it touches `dir`; do not delete a
      // directory here on a validation failure — a caller could have named an
      // ancestor of the audited source.
      return prepareLocalSource(target, { dir, limits })
    }
  }
  if (target.kind === 'npm' && !target.full) {
    if (typeof target.tarball !== 'string' || target.tarball === '') {
      throw new Error('npm 元数据没有给出包文件地址，无法准备源码快照')
    }
    const parsed = new URL(target.tarball)
    if (parsed.protocol !== 'https:' || !NPM_REGISTRY_HOSTS.has(parsed.hostname)) {
      throw new Error('npm 包文件地址不在允许的登记表镜像: ' + parsed.hostname)
    }
    const fetchImpl = options.fetchBytes || fetchBytes
    const artifact = await fetchImpl(target.tarball, {
      signal: options.signal,
      maxBytes: limits.downloadBytes,
      allowedHosts: NPM_REGISTRY_HOSTS,
    })
    const integrity = verifyIntegrity(artifact, target.integrity, target.shasum)
    if (integrity === false) throw new Error('npm 包文件完整性校验失败')
    const anomalies = []
    if (integrity === null) anomalies.push({ code: 'no-integrity', detail: '登记表没有给出可校验的摘要' })
    try {
      return await buildSnapshot({
        target, dir, limits, artifact,
        kind: 'npm',
        label: target.name + (target.version ? '@' + target.version : ''),
        ref: target.version || null,
        url: target.tarball,
        anomalies,
        strip: 'package',
        pinnedByDigest: integrity === true,
        verify: async () => {
          const again = await (options.fetchBytes || fetchBytes)(target.tarball, {
            signal: options.signal, maxBytes: limits.downloadBytes, allowedHosts: NPM_REGISTRY_HOSTS,
          })
          const ok = sha256(again) === sha256(artifact)
          return ok ? { ok: true } : { ok: false, reason: '登记表上的源码与审核时不一致' }
        },
      })
    } catch (error) {
      await cleanup()
      throw error
    }
  }
  if (target.full && (target.kind === 'github' || /^https:\/\/github\.com\//u.test(String(target.repo || '')))) {
    const requestedRef = target.ref || 'HEAD'
    const resolved = await resolveGithubCommit(target.full, requestedRef, options)
    const fetchRef = resolved || requestedRef
    const url = githubTarballUrl(target.full, fetchRef)
    const fetchImpl = options.fetchBytes || fetchBytes
    const artifact = await fetchImpl(url, {
      signal: options.signal,
      maxBytes: limits.downloadBytes,
      allowedHosts: GITHUB_TARBALL_HOSTS,
    })
    try {
      return await buildSnapshot({
        target, dir, limits, artifact,
        kind: 'github',
        label: target.full + '@' + fetchRef,
        ref: fetchRef,
        requestedRef,
        url,
        anomalies: [],
        strip: null,
        topLevelPrefix: target.full.split('/')[1] + '-',
        verify: async () => {
          const again = await (options.fetchBytes || fetchBytes)(url, {
            signal: options.signal, maxBytes: limits.downloadBytes, allowedHosts: GITHUB_TARBALL_HOSTS,
          })
          const ok = sha256(again) === sha256(artifact)
          return ok ? { ok: true } : { ok: false, reason: 'GitHub 上的源码在审核后发生了变化' }
        },
      })
    } catch (error) {
      await cleanup()
      throw error
    }
  }
  throw new Error('这个来源不在审核白名单内（目前支持 npm 包、GitHub 仓库和本机目录）')
}

/** Build the snapshot from one downloaded artifact. */
async function buildSnapshot(input) {
  const { target, dir, limits, artifact } = input
  const artifactSha256 = sha256(artifact)
  const anomalies = input.anomalies.slice()
  const anomaly = (code, path, detail) => {
    if (anomalies.length < limits.anomalies) {
      anomalies.push({
        code: printable(code, 40),
        path: printable(path, 300),
        ...(detail === undefined ? {} : { detail: printable(detail, 300) }),
      })
    }
  }
  if (artifact[0] === 0x1f && artifact[1] === 0x8b) {
    try {
      input.archive = gunzipSync(artifact, { maxOutputLength: limits.uncompressedBytes })
    } catch (error) {
      throw new Error('源码包解压失败或超过解压上限：' + error.message)
    }
  } else {
    input.archive = artifact
  }
  const parsed = readTar(input.archive, {
    maxEntries: limits.entries,
    maxFileBytes: limits.fileBytes,
    maxTotalFileBytes: limits.totalFileBytes,
  })
  const blobsDir = join(dir, 'blobs')
  await rm(dir, { recursive: true, force: true })
  await mkdir(blobsDir, { recursive: true, mode: 0o700 })

  const normalized = []
  for (const entry of parsed.entries) {
    if (entry.kind === 'other' || entry.kind === 'device' || entry.kind === 'fifo') {
      anomaly(entry.kind, entry.path)
      continue
    }
    if (entry.kind === 'symlink' || entry.kind === 'hardlink') {
      anomaly(entry.kind, entry.path, entry.linkname)
    }
    try {
      const path = safePath(entry.path)
      normalized.push({ ...entry, path })
    } catch (error) {
      anomaly('unsafe-path', entry.path, error.message)
    }
  }

  let entries = normalized
  let topLevel = null
  if (input.strip === 'package') {
    const prefixed = entries.every((entry) => entry.path === 'package' || entry.path.startsWith('package/'))
    if (prefixed) {
      entries = entries.filter((entry) => entry.path !== 'package').map((entry) => ({ ...entry, path: entry.path.slice('package/'.length) }))
    } else {
      anomaly('unexpected-package-layout')
    }
  } else if (input.topLevelPrefix) {
    const stripped = stripTopLevel(entries, input.topLevelPrefix)
    entries = stripped.entries
    topLevel = stripped.topLevel
  }
  const topCommit = input.kind === 'github' ? commitFromTopLevel(topLevel) : null
  const inputCommit = input.kind === 'github' && /^[0-9a-f]{40}$/iu.test(String(input.ref || ''))
    ? String(input.ref).toLowerCase()
    : null
  const commit = topCommit || inputCommit
  const installSpec = input.kind === 'npm' && typeof target.tarball === 'string' && target.tarball !== ''
    // Install the exact tarball the audit read, not just the name@version: a
    // mirror or a registry swap must not change what the installer fetches.
    ? target.tarball
    : input.kind === 'github' && commit !== null && target.full
      // Install the archive we audited, not a git checkout: a checkout also
      // honors `.gitattributes export-ignore` differently from the archive, so
      // those two artifacts can contain different files.
      ? 'https://github.com/' + target.full + '/archive/' + commit + '.tar.gz'
      : target.spec
  const pinned = input.kind === 'npm'
    ? input.pinnedByDigest === true
    : (input.kind === 'github' && commit !== null)

  const files = []
  const byPath = new Map()
  let fileCount = 0
  let byteCount = 0
  let truncated = parsed.truncated
  for (const entry of entries) {
    if (entry.path === '') continue
    if (byPath.has(entry.path)) {
      anomaly('duplicate-path', entry.path)
      continue
    }
    if (entry.kind === 'dir') {
      const record = { path: entry.path, kind: 'dir', size: 0, binary: false, skipped: false }
      files.push(record)
      byPath.set(entry.path, { ...record, data: null })
      continue
    }
    if (entry.kind !== 'file') {
      const record = {
        path: entry.path,
        kind: entry.kind,
        size: entry.size,
        link: printable(entry.linkname),
        binary: false,
        skipped: true,
      }
      files.push(record)
      byPath.set(entry.path, { ...record, data: null })
      continue
    }
    if (fileCount >= limits.files || byteCount + entry.size > limits.totalFileBytes) {
      truncated = true
      anomaly('snapshot-truncated', entry.path, '文件数或总字节超过上限')
      continue
    }
    fileCount += 1
    byteCount += entry.size
    const record = { path: entry.path, kind: 'file', size: entry.size, binary: false, skipped: false }
    if (entry.skipped || entry.data === null) {
      record.skipped = true
      anomaly('oversized-file', entry.path, String(entry.size))
      files.push(record)
      byPath.set(entry.path, { ...record, data: null })
      continue
    }
    const data = entry.data
    record.binary = looksBinary(data)
    record.sha256 = sha256(data)
    await storeBlob(blobsDir, record.sha256, data)
    files.push(record)
    byPath.set(entry.path, record)
  }

  const incomplete = isIncomplete(truncated, anomalies, files)
  const source = {
    kind: input.kind,
    label: input.label,
    ref: commit !== null ? commit : input.ref,
    requestedRef: input.requestedRef || input.ref,
    commit,
    installSpec,
    pinned,
    url: input.url,
    artifactSha256,
    artifactBytes: artifact.length,
    fileCount,
    binaryFiles: files.filter((entry) => entry.kind === 'file' && entry.binary).length,
    byteCount,
    truncated: incomplete,
    anomalies,
  }
  await writeManifest(dir, source, files)
  return createSnapshot({ dir, source, files, byPath, verify: input.verify })
}

/** Build the methods the source tools use. */
function createSnapshot(input) {
  const { dir, source, files, byPath } = input
  const sorted = files.slice().sort((left, right) => left.path.localeCompare(right.path))

  /** @returns the blob bytes for one manifest file entry. */
  async function blobOf(entry) {
    if (entry.kind !== 'file') throw new Error('不是文件：' + entry.path)
    if (entry.skipped || entry.sha256 === undefined) throw new Error('这个文件没有存入快照（太大或被截断）：' + entry.path)
    const data = entry.data !== undefined && entry.data !== null ? entry.data : await readFile(join(dir, 'blobs', entry.sha256))
    if (sha256(data) !== entry.sha256) throw new Error('源码快照的 blob 与摘要不一致：' + entry.path)
    return data
  }

  return {
    source,
    manifest: { version: 1, source, files: sorted },

    /** @returns a bounded listing, optionally under one path prefix. */
    list(prefix = '', options = {}) {
      const limit = Math.min(Number.isFinite(options.limit) && options.limit > 0 ? options.limit : SNAPSHOT_LIMITS.listEntries, SNAPSHOT_LIMITS.listEntries)
      let wanted = String(prefix || '').replace(/^\.\/+/u, '').replace(/\/+$/u, '')
      if (wanted === '.') wanted = ''
      const matches = wanted === ''
        ? sorted
        : sorted.filter((entry) => entry.path === wanted || entry.path.startsWith(wanted + '/'))
      return {
        source,
        total: matches.length,
        truncated: matches.length > limit,
        entries: matches.slice(0, limit).map((entry) => ({
          path: entry.path,
          kind: entry.kind,
          size: entry.size,
          binary: entry.binary === true,
          skipped: entry.skipped === true,
          ...(entry.link === undefined ? {} : { link: entry.link }),
        })),
      }
    },

    /**
     * Read one text file with 1-based line numbers.
     * @returns `{ path, totalLines, startLine, endLine, text, truncated }`.
     */
    async read(path, options = {}) {
      const entry = byPath.get(String(path || ''))
      if (!entry) throw new Error('快照中没有这个路径：' + String(path || ''))
      if (entry.kind !== 'file') throw new Error('不是文件：' + entry.path)
      if (entry.skipped) throw new Error('这个文件没有存入快照（太大或被截断）：' + entry.path)
      if (entry.binary) return { path: entry.path, binary: true, size: entry.size, sha256: entry.sha256, totalLines: 0, startLine: 0, endLine: 0, text: '' }
      const data = await blobOf(entry)
      const text = data.toString('utf8')
      const lines = text.split('\n')
      const totalLines = lines.length
      const startLine = Math.max(1, Math.min(Number.isFinite(options.offset) ? Math.floor(options.offset) : 1, Math.max(1, totalLines)))
      const requested = Number.isFinite(options.limit) ? Math.floor(options.limit) : SNAPSHOT_LIMITS.readLines
      const limit = Math.max(1, Math.min(requested, SNAPSHOT_LIMITS.readLines))
      const selected = []
      let bytes = 0
      let endLine = startLine - 1
      for (let index = startLine - 1; index < lines.length && selected.length < limit; index += 1) {
        const line = lines[index]
        if (bytes + line.length + 1 > SNAPSHOT_LIMITS.readBytes && selected.length > 0) break
        selected.push(String(index + 1).padStart(6, ' ') + '  ' + line)
        bytes += line.length + 1
        endLine = index + 1
      }
      return {
        path: entry.path,
        totalLines,
        startLine,
        endLine,
        text: selected.join('\n'),
        truncated: endLine < totalLines,
      }
    },

    /** @returns literal substring matches in text files, capped. */
    async grep(needle, options = {}) {
      const raw = String(needle || '')
      if (raw === '') throw new Error('grep 需要一个非空字符串')
      if (raw.length > SNAPSHOT_LIMITS.grepNeedle) throw new Error('grep 字符串太长')
      const caseSensitive = options.caseSensitive === true
      const wanted = caseSensitive ? raw : raw.toLowerCase()
      const maxResults = Math.min(
        Number.isFinite(options.maxResults) && options.maxResults > 0 ? Math.floor(options.maxResults) : SNAPSHOT_LIMITS.grepMatches,
        SNAPSHOT_LIMITS.grepMatches,
      )
      const prefix = String(options.prefix || '').replace(/^\.\/+/u, '').replace(/\/+$/u, '')
      const matches = []
      let filesScanned = 0
      let bytesScanned = 0
      let truncated = false
      for (const entry of sorted) {
        if (entry.kind !== 'file' || entry.binary || entry.skipped) continue
        if (prefix !== '' && entry.path !== prefix && !entry.path.startsWith(prefix + '/')) continue
        if (bytesScanned + entry.size > SNAPSHOT_LIMITS.grepBytes) { truncated = true; break }
        filesScanned += 1
        if (filesScanned > SNAPSHOT_LIMITS.grepFiles) { truncated = true; break }
        const data = await blobOf(entry)
        bytesScanned += data.length
        const lines = data.toString('utf8').split('\n')
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]
          const haystack = caseSensitive ? line : line.toLowerCase()
          if (!haystack.includes(wanted)) continue
          matches.push({ path: entry.path, line: index + 1, text: line.slice(0, 500) })
          if (matches.length >= maxResults) { truncated = true; break }
        }
        if (matches.length >= maxResults) break
      }
      return { matches, filesScanned, truncated }
    },

    /** Re-fetch the artifact and compare it with the audited bytes. */
    async verify() {
      if (typeof input.verify !== 'function') return { ok: true, skipped: true }
      return input.verify()
    },

    /** Remove the snapshot directory. */
    async dispose() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}
