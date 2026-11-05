/**
 * source-snapshot + source-tools: the audit's only data plane.
 *
 * Builds real (small) tar archives, including hostile ones, and checks that the
 * snapshot never escapes its directory, never follows a link and never stores an
 * archive path as a filesystem path. Also exercises the three model-facing tools
 * over a prepared snapshot.
 *
 * Run: node test/source-snapshot.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, link, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { createAuditSourceTools } from '../lib/host/source-tools.js'
import { fetchBytes, githubTarballUrl, prepareSource } from '../lib/host/source-snapshot.js'

let failures = 0
function check(condition, message) {
  if (condition) return
  failures += 1
  console.error('FAIL: ' + message)
}
function equal(actual, expected, message) {
  check(actual === expected,
    message + ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')')
}
async function rejects(promise, pattern, message) {
  try {
    await promise
  } catch (error) {
    check(pattern.test(String(error && error.message ? error.message : error)), message + ' — got: ' + error.message)
    return
  }
  check(false, message + ' (did not reject)')
}

/** One ustar header. */
function header({ name, size = 0, type = '0', linkname = '', mode = 0o644, prefix = '' }) {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  block.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii')
  block.write('0000000\0', 108, 8, 'ascii')
  block.write('0000000\0', 116, 8, 'ascii')
  block.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
  block.write('00000000000\0', 136, 12, 'ascii')
  block.write(type, 156, 1, 'ascii')
  block.write(linkname, 157, 100, 'utf8')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  if (prefix !== '') block.write(prefix, 345, 155, 'utf8')
  block.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return block
}

/** Build one tar archive from simple entries. */
function makeTar(entries) {
  const blocks = []
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '', 'utf8')
    blocks.push(header({ ...entry, size: data.length }))
    if (data.length > 0) {
      blocks.push(data)
      const pad = (512 - (data.length % 512)) % 512
      if (pad > 0) blocks.push(Buffer.alloc(pad))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

/** A snapshot directory under the OS temp area. */
async function scratch() {
  return mkdtemp(join(tmpdir(), 'dsh-homepage-source-'))
}

/** A fake npm target whose artifact is `gzip`. */
function npmTarget(gzip, extra = {}) {
  return {
    kind: 'npm',
    name: 'dsh-note',
    version: '1.2.3',
    spec: 'dsh-note@1.2.3',
    tarball: 'https://registry.npmjs.org/dsh-note/-/dsh-note-1.2.3.tgz',
    integrity: 'sha512-' + createHash('sha512').update(gzip).digest('base64'),
    full: null,
    ref: null,
    ...extra,
  }
}

/** A fake GitHub target. */
function githubTarget(extra = {}) {
  return { kind: 'github', full: 'owner/repo', ref: 'HEAD', name: 'repo', version: null, ...extra }
}

const roots = []
async function prepare(target, gzip, options = {}) {
  const root = await scratch()
  roots.push(root)
  return prepareSource(target, {
    dir: join(root, 'source'),
    fetchBytes: async () => gzip,
    ...options,
  })
}

// ------------------------------------------------------------- ordinary archive

{
  const tar = makeTar([
    { name: 'package/', type: '5' },
    { name: 'package/package.json', data: '{"name":"dsh-note","version":"1.2.3"}\n' },
    { name: 'package/lib/index.js', data: 'import "node:fs"\nconsole.log("hi")\n' },
    { name: 'package/lib/sub/util.js', data: 'export const x = 1\n' },
  ])
  const gzip = gzipSync(tar)
  const target = npmTarget(gzip)
  const snapshot = await prepare(target, gzip)
  equal(snapshot.source.kind, 'npm', 'the source kind is npm')
  equal(snapshot.source.label, 'dsh-note@1.2.3', 'the label names version')
  equal(snapshot.source.pinned, true, 'an exact npm version is a pinned source')
  equal(snapshot.source.installSpec, target.tarball, 'the install spec is the audited tarball URL')
  equal(snapshot.source.truncated, false, 'a small archive is complete')
  equal(snapshot.source.fileCount, 3, 'only regular files count')
  const paths = snapshot.list('').entries.map((entry) => entry.path)
  check(paths.includes('package.json'), 'the package/ prefix is stripped')
  check(paths.includes('lib/index.js'), 'nested files keep their relative path')
  check(!paths.some((path) => path.startsWith('package/')), 'the prefix is not kept')
  const read = await snapshot.read('lib/index.js', { offset: 1, limit: 10 })
  equal(read.totalLines, 3, 'the file keeps its line count')
  check(read.text.startsWith('     1  import "node:fs"'), 'read returns numbered lines')
  const grep = await snapshot.grep('console', { caseSensitive: true })
  equal(grep.matches.length, 1, 'grep finds a literal match')
  equal(grep.matches[0].path, 'lib/index.js', 'the match names the file')
  equal(grep.matches[0].line, 2, 'the match names the line')
  const verified = await snapshot.verify()
  equal(verified.ok, true, 're-fetching the same bytes verifies')
  const index = snapshot.manifest.files.find((entry) => entry.path === 'lib/index.js')
  const blob = join(roots[roots.length - 1], 'source', 'blobs', index.sha256)
  await rm(blob)
  await writeFile(blob, 'tampered\n')
  await rejects(snapshot.read('lib/index.js'), /摘要不一致/, 'a tampered blob is refused at read time')
}

// ------------------------------------------------------ integrity and allowlists

{
  const tar = makeTar([{ name: 'package/a.txt', data: 'a' }])
  const gzip = gzipSync(tar)
  const badTarget = npmTarget(gzip, { integrity: 'sha512-' + Buffer.alloc(64).toString('base64') })
  await rejects(
    prepare(badTarget, gzip),
    /完整性校验失败/,
    'a bad SRI digest refuses the snapshot',
  )

  const evilHost = npmTarget(gzip, { tarball: 'https://evil.example/pkg.tgz' })
  await rejects(
    prepare(evilHost, gzip),
    /不在允许的登记表镜像/,
    'a tarball host outside the registry allowlist is refused',
  )

  const unsigned = npmTarget(gzip, { integrity: null, shasum: null })
  const unsignedSnapshot = await prepare(unsigned, gzip)
  equal(unsignedSnapshot.source.pinned, false, 'an npm artifact without a declared digest is not pinned')
  check(unsignedSnapshot.source.anomalies.some((entry) => entry.code === 'no-integrity'),
    'the missing digest is recorded')

  await rejects(
    Promise.resolve().then(() => githubTarballUrl('owner/repo', '../main')),
    /ref 不合法/,
    'a traversal-shaped GitHub ref is refused',
  )
  const allowed = new Set(['registry.npmjs.org'])
  await rejects(
    fetchBytes('https://registry.npmjs.org:8443/x.tgz', { maxBytes: 10, allowedHosts: allowed }),
    /非标准端口/,
    'a non-standard port is refused',
  )
  await rejects(
    fetchBytes('https://user:pass@registry.npmjs.org/x.tgz', { maxBytes: 10, allowedHosts: allowed }),
    /携带凭据/,
    'a URL carrying credentials is refused',
  )
  equal(
    githubTarballUrl('owner/repo', 'feature/branch'),
    'https://codeload.github.com/owner/repo/tar.gz/feature/branch',
    'a GitHub ref is encoded as path segments',
  )
}

// --------------------------------------------------------- hostile archive paths

{
  const tar = makeTar([
    { name: 'package/', type: '5' },
    { name: '../escape.txt', data: 'should not exist' },
    { name: '/etc/passwd', data: 'absolute' },
    { name: 'package/..\\win', data: 'backslash' },
    { name: 'package/bad\u001b[31m', data: 'control' },
    { name: 'package/ok.txt', data: 'fine\n' },
    { name: 'package/link', type: '2', linkname: '/etc/passwd' },
    { name: 'package/hard', type: '1', linkname: 'package/ok.txt' },
    { name: 'package/dupe', data: 'first' },
    { name: 'package/dupe', data: 'second' },
  ])
  const gzip = gzipSync(tar)
  const snapshot = await prepare(npmTarget(gzip), gzip)
  const paths = snapshot.list('').entries.map((entry) => entry.path)
  check(paths.includes('ok.txt'), 'a safe file is kept')
  check(!paths.includes('../escape.txt'), 'a traversal path is not in the manifest')
  check(!paths.includes('/etc/passwd'), 'an absolute path is not in the manifest')
  check(!paths.includes('..\\win'), 'a backslash path is not in the manifest')
  const codes = snapshot.source.anomalies.map((entry) => entry.code)
  check(codes.includes('unsafe-path'), 'unsafe paths are recorded as anomalies')
  check(codes.includes('symlink'), 'a symlink is recorded')
  check(codes.includes('hardlink'), 'a hardlink is recorded')
  check(codes.includes('duplicate-path'), 'a duplicate path is recorded')
  equal(snapshot.source.truncated, true, 'unsafe or skipped entries make the snapshot incomplete')
  check(!JSON.stringify(snapshot.source.anomalies).includes('\u001b'), 'control characters are stripped from anomaly text')
  const link = snapshot.list('').entries.find((entry) => entry.path === 'link')
  equal(link.kind, 'symlink', 'the link stays a link')
  equal(link.link, '/etc/passwd', 'the link target is shown, not followed')
  await rejects(snapshot.read('link'), /不是文件/, 'reading a link is refused')
  const dupe = snapshot.list('').entries.find((entry) => entry.path === 'dupe')
  equal(dupe.kind, 'file', 'the first duplicate is kept as a file')
  check(!(await readFile(join(roots[roots.length - 1], 'source', 'escape.txt'), 'utf8').catch(() => null)),
    'no archive path is materialized as a filesystem path')
}

// --------------------------------------------------------------- binary + limits

{
  const binary = Buffer.from([0, 1, 2, 3, 4, 5])
  const tar = makeTar([
    { name: 'package/bin.dat', data: binary },
    { name: 'package/big.txt', data: 'x'.repeat(40) },
    { name: 'package/plain.txt', data: 'hello\n' },
  ])
  const gzip = gzipSync(tar)
  const snapshot = await prepare(npmTarget(gzip), gzip, { limits: { fileBytes: 10 } })
  const bin = snapshot.list('').entries.find((entry) => entry.path === 'bin.dat')
  equal(bin.binary, true, 'a NUL byte marks a binary file')
  equal(snapshot.source.truncated, true, 'a skipped file makes the snapshot incomplete')
  const big = snapshot.list('').entries.find((entry) => entry.path === 'big.txt')
  equal(big.skipped, true, 'a file over the per-file cap is skipped')
  const read = await snapshot.read('bin.dat')
  equal(read.binary, true, 'reading a binary file returns metadata')
  const grep = await snapshot.grep('hello')
  equal(grep.matches.length, 1, 'grep still reads text files')
  equal(grep.matches[0].path, 'plain.txt', 'and skips binary/skipped files')
}

// -------------------------------------------------------------- GitHub layout

{
  const commit = 'a'.repeat(40)
  const tar = makeTar([
    { name: 'repo-' + commit + '/', type: '5' },
    { name: 'repo-' + commit + '/package.json', data: '{"name":"repo"}\n' },
    { name: 'repo-' + commit + '/src/index.js', data: 'export {}\n' },
  ])
  const gzip = gzipSync(tar)
  const snapshot = await prepare(githubTarget(), gzip)
  equal(snapshot.source.kind, 'github', 'GitHub source kind')
  equal(snapshot.source.ref, commit, 'the commit SHA is recovered from the codeload top-level directory')
  equal(snapshot.source.commit, commit, 'the commit is recorded')
  equal(snapshot.source.pinned, true, 'a commit-pinned GitHub source is pinned')
  equal(snapshot.source.installSpec, 'https://github.com/owner/repo/archive/' + commit + '.tar.gz',
    'the install spec is the audited archive, not a git checkout')
  const paths = snapshot.list('').entries.map((entry) => entry.path)
  check(paths.includes('package.json'), 'the common GitHub top-level directory is stripped')
  check(paths.includes('src/index.js'), 'nested GitHub files are kept')
  const changed = await prepareSource(githubTarget(), {
    dir: join(roots[roots.length - 1], 'changed'),
    fetchBytes: (() => {
      let first = true
      return async () => {
        if (first) { first = false; return gzip }
        return gzipSync(makeTar([{ name: 'repo-x/a.txt', data: 'different' }]))
      }
    })(),
  })
  equal((await changed.verify()).ok, false, 'a moved GitHub source fails verification')

  const unwrapped = gzipSync(makeTar([{ name: 'src/index.js', data: 'export {}\n' }]))
  const plain = await prepare(githubTarget(), unwrapped)
  check(plain.list('').entries.some((entry) => entry.path === 'src/index.js'),
    'a top-level directory that is not the codeload wrapper is kept')
}

{
  const commit = 'b'.repeat(40)
  const root = await scratch()
  roots.push(root)
  const gzip = gzipSync(makeTar([
    { name: 'repo-' + commit + '/', type: '5' },
    { name: 'repo-' + commit + '/package.json', data: '{"name":"repo"}\n' },
  ]))
  let apiUrl = ''
  let tarballUrl = ''
  const snapshot = await prepareSource(githubTarget({ ref: 'main' }), {
    dir: join(root, 'source'),
    fetchJson: async (url) => { apiUrl = url; return { sha: commit } },
    fetchBytes: async (url) => { tarballUrl = url; return gzip },
  })
  equal(apiUrl, 'https://api.github.com/repos/owner/repo/commits/main',
    'the host resolves a GitHub ref through the read-only API')
  check(tarballUrl.endsWith('/tar.gz/' + commit), 'the tarball is fetched at the resolved commit')
  equal(snapshot.source.commit, commit, 'the resolved commit is recorded')
  equal(snapshot.source.ref, commit, 'the snapshot ref is the immutable commit')
  equal(snapshot.source.requestedRef, 'main', 'the user ref is kept for provenance')
  equal(snapshot.source.pinned, true, 'a resolved GitHub ref is pinned')
  equal(snapshot.source.installSpec, 'https://github.com/owner/repo/archive/' + commit + '.tar.gz',
    'the install spec is the audited archive')
}

// -------------------------------------------------------------- local snapshot

{
  const root = await scratch()
  roots.push(root)
  const outside = await scratch()
  roots.push(outside)
  await writeFile(join(outside, 'secret.txt'), 'do not follow me\n')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'package.json'), '{"name":"local"}\n')
  await writeFile(join(root, 'src', 'index.js'), 'module.exports = 1\n')
  let linkMade = true
  try {
    await symlink(outside, join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    linkMade = false
  }
  const snapshotRoot = await scratch()
  roots.push(snapshotRoot)
  await rejects(
    prepareSource({ kind: 'spec', input: root, spec: root, name: 'local' }, { dir: join(root, 'inside') }),
    /快照目录/,
    'a snapshot directory inside the audited source is refused',
  )
  await rejects(
    prepareSource({ kind: 'spec', input: join(root, 'src'), spec: join(root, 'src'), name: 'local' }, { dir: root }),
    /快照目录/,
    'a snapshot directory that is an ancestor of the audited source is refused',
  )
  const snapshot = await prepareSource({ kind: 'spec', input: root, spec: root, name: 'local' }, { dir: join(snapshotRoot, 'snap') })
  equal(snapshot.source.kind, 'local', 'a local directory is a local snapshot')
  const entries = snapshot.list('').entries
  check(entries.some((entry) => entry.path === 'src/index.js'), 'local files are snapshotted')
  check(!entries.some((entry) => entry.path === 'outside/secret.txt'), 'a local link is not followed')
  if (linkMade) {
    const link = entries.find((entry) => entry.path === 'outside')
    equal(link.kind, 'symlink', 'a local link is recorded, not followed')
    await rejects(snapshot.read('outside'), /不是文件/, 'a local link cannot be read as a file')
  }
  const grep = await snapshot.grep('module.exports')
  equal(grep.matches.length, 1, 'local text is searchable')
  equal((await snapshot.verify()).ok, true, 'an unchanged local source verifies')
  await writeFile(join(root, 'src', 'index.js'), 'module.exports = 2\n')
  equal((await snapshot.verify()).ok, false, 'a changed local source fails verification')
}

{
  const root = await scratch()
  roots.push(root)
  await mkdir(join(root, 'real'), { recursive: true })
  await writeFile(join(root, 'real', 'a.txt'), 'inside\n')
  let rootLinkMade = true
  const linkRoot = join(root, 'linked-root')
  try { await symlink(join(root, 'real'), linkRoot, process.platform === 'win32' ? 'junction' : 'dir') } catch { rootLinkMade = false }
  if (rootLinkMade) {
    const snapshotRoot = await scratch()
    roots.push(snapshotRoot)
    await rejects(
      prepareSource({ kind: 'spec', input: linkRoot, spec: linkRoot, name: 'linked' }, { dir: join(snapshotRoot, 'snap-link') }),
      /符号链接/,
      'a local root that is a link is refused',
    )
  }

  const outside = await scratch()
  roots.push(outside)
  await writeFile(join(outside, 'secret.txt'), 'outside\n')
  let hardlinkMade = true
  try { await link(join(outside, 'secret.txt'), join(root, 'real', 'hard.txt')) } catch { hardlinkMade = false }
  const snapshotRoot = await scratch()
  roots.push(snapshotRoot)
  const local = await prepareSource({ kind: 'spec', input: join(root, 'real'), spec: join(root, 'real'), name: 'real' }, { dir: join(snapshotRoot, 'snap-hard') })
  if (hardlinkMade) {
    check(!local.list('').entries.some((entry) => entry.path === 'hard.txt'), 'a local hardlink is not snapshotted')
    check(local.source.anomalies.some((entry) => entry.code === 'hardlink'), 'the hardlink is recorded')
  }
  check(local.list('').entries.some((entry) => entry.path === 'a.txt'), 'ordinary local files are still read')
}

// ---------------------------------------------------------------- the three tools

{
  const tar = makeTar([
    { name: 'package/', type: '5' },
    { name: 'package/package.json', data: '{"name":"dsh-note"}\n' },
    { name: 'package/lib/a.js', data: 'const secret = "not-a-secret"\n' },
  ])
  const gzip = gzipSync(tar)
  const snapshot = await prepare(npmTarget(gzip), gzip)
  const tools = createAuditSourceTools(snapshot)
  equal(tools.map((tool) => tool.name).join(','), 'audit_source_list,audit_source_read,audit_source_grep',
    'the three source tools are exposed')
  const list = await tools[0].execute({})
  check(list.text.includes('package.json'), 'list names the files')
  check(list.text.includes('sha256:'), 'list carries the provenance digest')
  const read = await tools[1].execute({ path: 'lib/a.js', offset: 1, limit: 1 })
  check(read.text.includes('const secret'), 'read returns content')
  const grep = await tools[2].execute({ needle: 'secret' })
  check(grep.text.includes('lib/a.js:1:'), 'grep returns path:line')
  await rejects(tools[1].execute({ path: '../package.json' }), /没有这个路径/, 'the read tool cannot escape the manifest')
  await rejects(tools[2].execute({ needle: '' }), /非空字符串/, 'grep refuses an empty needle')
  const rendered = tools[0].output.render({}, list)
  equal(rendered[0].type, 'text', 'tool output renders as text')
}

for (const root of roots) await rm(root, { recursive: true, force: true })

if (failures > 0) {
  console.error('source-snapshot: ' + failures + ' assertion(s) failed')
  process.exit(1)
}
console.log('source-snapshot: all assertions passed')
