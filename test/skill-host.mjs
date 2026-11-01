/**
 * test/skill-host.mjs — acceptance test for `lib/host/skills.js`.
 *
 * `lib/host/skills.js` is a mirror of the REAL DSH skill provider, and a mirror
 * is only worth anything if it is proved against the same cases. This suite
 * pins the four things the card cannot get wrong:
 *
 *  - DISCOVERY. The root table, its ranks and its win rule (lowest rank wins,
 *    ties break by root order) match `skill-filesystem`; a project root is found
 *    by walking up to `.git`; directory bundles, flat `<name>.md` files, the
 *    skipped `.system` directory and a broken symlink are all handled;
 *  - THE CATALOG. A skill with missing, malformed or legacy frontmatter is still
 *    LISTED, with the right `note`, and is never writable; an unreadable file,
 *    a missing user root and an unlistable root produce warnings instead of
 *    exceptions; the counts add up;
 *  - THE WRITE. All three modes rewrite exactly the frontmatter keys they own.
 *    Every other byte survives — line endings, key order, comments, body — and a
 *    key that has to be added lands at the END of the block;
 *  - THE REFUSALS. An unknown name, a bundled (read-only) root, a name that
 *    disagrees with the file it sits in, a file with no frontmatter and an
 *    unreadable file each refuse with a user-facing reason, and a refusal never
 *    touches the file.
 *
 * Most cases run over an in-memory filesystem, so a broken symlink and a denied
 * directory can be staged deterministically; the byte-preservation cases run
 * against a real throwaway directory, because "no other byte changed" is only
 * proved by reading the file back. Nothing here touches the network, and every
 * temp directory it creates is removed again.
 *
 * Run: node test/skill-host.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  BUNDLED_SKILL_RANK,
  CUSTOM_RANK,
  LEGACY_INVOCATION_KEYS,
  PROJECT_AGENTS_RANK,
  PROJECT_DSH_RANK,
  USER_AGENTS_RANK,
  USER_DSH_RANK,
  compareCodePoints,
  countSkills,
  createSkillStore,
  isSkillName,
  parseBooleanScalar,
  parseFrontmatter,
  parseInvocation,
  parseScalar,
  parseSkill,
  rewriteFrontmatter,
} from '../lib/host/skills.js'

/** Every named check this run has completed. */
let checks = 0

/**
 * Assert one named property and count it, so the closing line reports how much
 * was actually proved.
 *
 * @param condition - the property that must hold.
 * @param message - what it proves, in one line.
 */
function ok(condition, message) {
  assert.ok(condition, message)
  checks += 1
}

/**
 * Assert that two values are deeply equal and count it.
 *
 * @param actual - the value produced.
 * @param expected - the value required.
 * @param message - what it proves.
 */
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message)
  checks += 1
}

/**
 * Run `fn` and return the user-facing Error it threw, or fail.
 *
 * @param fn - the async function expected to refuse.
 * @param message - what the refusal proves.
 * @returns the thrown error.
 */
async function refuse(fn, message) {
  let thrown = null
  try {
    await fn()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown !== null, `${message}: expected a refusal, none was thrown`)
  assert.ok(thrown instanceof Error, `${message}: the refusal must be an Error`)
  assert.ok(typeof thrown.message === 'string' && thrown.message.length > 0, `${message}: the refusal needs a message`)
  checks += 1
  return thrown
}

// -------------------------------------------------------------- fixture text

/**
 * A minimal, valid flat skill.
 *
 * @param name - the skill name.
 * @param description - its description.
 * @returns the file text.
 */
function skillMd(name, description = `About ${name}.`) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
}

/**
 * A real tree under the system temp directory, so a `setEnabled()` round-trip
 * can be checked byte for byte by reading the file back.
 *
 * @returns `{ root, roots, cleanup }`.
 */
async function realFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-host-'))
  const roots = {
    dshHome: join(root, 'dshhome'),
    agentsHome: join(root, 'agents'),
    project: join(root, 'proj'),
    sub: join(root, 'proj', 'src', 'deep'),
    bundled: join(root, 'bundled'),
  }
  await mkdir(roots.dshHome, { recursive: true })
  await mkdir(roots.agentsHome, { recursive: true })
  await mkdir(roots.sub, { recursive: true })
  await mkdir(join(roots.project, '.git'), { recursive: true })
  await mkdir(roots.bundled, { recursive: true })
  return {
    root,
    roots,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

// ------------------------------------------------------------------ exports

{
  const module = await import('../lib/host/skills.js')
  for (const [name, kind] of Object.entries({
    createSkillStore: 'function',
    countSkills: 'function',
    compareCodePoints: 'function',
    isSkillName: 'function',
    parseSkill: 'function',
    parseFrontmatter: 'function',
    parseInvocation: 'function',
    parseBooleanScalar: 'function',
    parseScalar: 'function',
    rewriteFrontmatter: 'function',
  })) {
    ok(typeof module[name] === kind, `export ${name} must be a ${kind}`)
  }
  eq(
    [PROJECT_DSH_RANK, PROJECT_AGENTS_RANK, CUSTOM_RANK, USER_DSH_RANK, USER_AGENTS_RANK, BUNDLED_SKILL_RANK],
    [100, 200, 300, 400, 500, 600],
    "the ranks are the provider's own",
  )
  eq(LEGACY_INVOCATION_KEYS.modelInvocable, 'disable-model-invocation', 'legacy modelInvocable maps to the canonical key')
  eq(LEGACY_INVOCATION_KEYS.userInvocable, 'user-invocable', 'legacy userInvocable maps to the canonical key')
  ok(isSkillName('writing-guard'), 'kebab-case names are valid')
  ok(!isSkillName('Writing_Guard'), 'an underscore name is invalid')
  ok(!isSkillName('-lead'), 'a leading dash is invalid')
  ok(!isSkillName(''), 'an empty name is invalid')
  ok(
    compareCodePoints('a', 'b') === -1 && compareCodePoints('b', 'a') === 1 && compareCodePoints('a', 'a') === 0,
    'compareCodePoints is a total order',
  )
  console.log('  exports: the factory, the pure helpers and the provider ranks')
}

// -------------------------------------------------- options and the root table

{
  assert.throws(() => createSkillStore({}), /dshHome/, 'a missing dshHome must throw')
  checks += 1
  const store = createSkillStore({ dshHome: 'C:\\Users\\x\\.dsh', homedir: () => 'C:\\Users\\x' })
  const roots = store.roots()
  eq(roots.map((root) => root.id), ['user-dsh', 'user-agents'], 'without a cwd there are only the user roots')
  eq(roots.map((root) => root.rank), [USER_DSH_RANK, USER_AGENTS_RANK], 'the user roots keep their ranks')
  ok(roots.every((root) => root.writable), 'both user roots are writable')
  const withCwd = createSkillStore({ dshHome: '/home/x/.dsh', projectCwd: '/home/x/p' }).roots()
  eq(withCwd.map((root) => root.source), ['project-dsh', 'project-agents', 'user-dsh', 'user-agents'],
    'a cwd adds the two project roots ahead of the user roots')
  const withCustom = createSkillStore({
    dshHome: '/home/x/.dsh',
    customDirs: ['/opt/skills', ''],
    bundledDir: '/opt/bundled',
  }).roots()
  eq(withCustom.map((root) => root.source), ['custom', 'user-dsh', 'user-agents', 'bundled'],
    'a custom root is inserted between the project roots and the user roots')
  eq(withCustom.find((root) => root.source === 'bundled').writable, false, 'the bundled root is read-only')
  console.log('  createSkillStore: options are validated and the root table is rank-ordered')
}

// -------------------------------------------------------- in-memory filesystem

/** The path used for the shared agents root in every fake fixture. */
const AGENTS = 'A:/agents'
/** The path used for the DSH home in every fake fixture. */
const DSH = 'A:/.dsh'
/** The path used for the read-only bundled root in every fake fixture. */
const BUNDLED = 'A:/bundled'
/** A scratch directory on the fake `A:` drive, for extra roots. */
const MEM = 'A:/mem'

/**
 * An in-memory stand-in for the injectable fs, mirroring `memFs()` in
 * `sidebar-host.mjs`: directories and files keyed the way the module addresses
 * them, so discovery can be run over a tree that could never exist on a real
 * disk (a broken symlink, a denied directory).
 *
 * Keys are normalised through `resolve()`, so a fixture may build a path with
 * `join()` while the module builds the same one with `dirname()`, and the two
 * still meet — which matters on Windows, where `resolve` also rewrites `/` to
 * `\`. A symlink is declared with `addLink()`, because a real platform follows
 * the link inside `stat` and a Map cannot.
 *
 * @returns the fake filesystem plus its staging helpers.
 */
function memFs() {
  const dirs = new Map()
  const files = new Map()
  const statFailures = new Map()
  const dirFailures = new Map()
  const links = new Map()
  const calls = []

  /**
   * Turn a seeded entry into the `{ name, type }` shape `readdir` reports.
   *
   * @param entry - a name, or an entry record.
   * @returns the normalised entry.
   */
  const toEntry = (entry) => (typeof entry === 'string' ? { name: entry, type: 'other' } : entry)

  /**
   * Turn a seeded entry into the shape a real `readdir(…, {withFileTypes:true})`
   * reports: a `Dirent`, which answers `isDirectory()`/`isFile()` about lstat.
   *
   * The declared `type` is kept alongside, because the module reads either
   * signal, and the methods are answered from the staged tree the way a real
   * platform answers them from the inode.
   *
   * @param entry - a name, or an entry record.
   * @param parent - the directory the entry lives in.
   * @returns the normalised entry.
   */
  const toDirent = (entry, parent) => {
    const base = toEntry(entry)
    const full = resolve(join(parent, base.name))
    return {
      name: base.name,
      type: base.type,
      isDirectory: () => dirs.has(full),
      isFile: () => files.has(full),
    }
  }

  /**
   * Follow a declared link through any path segment, so reading
   * `<root>/link/SKILL.md` reaches whatever `link` points at — which is what a
   * real platform does inside `open`.
   *
   * @param path - an already resolved absolute path.
   * @returns the path to read from.
   */
  const follow = (path) => {
    for (const [link, target] of links) {
      if (path === link) return target
      if (path.startsWith(`${link}\\`) || path.startsWith(`${link}/`)) {
        return join(target, path.slice(link.length + 1))
      }
    }
    return path
  }

  return {
    calls,
    /**
     * Register a directory (or replace the entry list of an existing one).
     *
     * @param path - the directory.
     * @param entries - the entries, defaulting to an empty directory.
     */
    addDir(path, entries) {
      dirs.set(resolve(path), entries === undefined ? [] : entries)
    },
    /**
     * Seed one file.
     *
     * @param path - the file.
     * @param text - its content.
     */
    addFile(path, text) {
      files.set(resolve(path), text)
    },
    /**
     * Delete one file, standing in for a file that vanished behind the scan.
     *
     * @param path - the file.
     */
    removeFile(path) {
      files.delete(resolve(path))
    },
    /**
     * Teach the fake filesystem what one symlink points at.
     *
     * @param path - the link entry's path.
     * @param target - where it points.
     */
    addLink(path, target) {
      links.set(resolve(path), resolve(target))
    },
    /**
     * Read the entry list of one registered directory.
     *
     * @param path - the directory.
     * @returns the entries.
     */
    entries(path) {
      return dirs.get(resolve(path))
    },
    /**
     * Make the next `stat` of one path fail.
     *
     * @param path - the path to break.
     * @param code - the error code to report.
     */
    failStat(path, code) {
      statFailures.set(resolve(path), code)
    },
    /**
     * Make `readdir` of one directory fail.
     *
     * @param path - the directory to break.
     * @param code - the error code to report.
     */
    failDir(path, code) {
      dirFailures.set(resolve(path), code)
    },
    /**
     * List one directory, if it exists.
     *
     * @param path - the directory.
     * @returns the entries, sorted the way the real fs returns them.
     */
    async readdir(path) {
      const key = resolve(path)
      calls.push(['readdir', key])
      if (dirFailures.has(key)) throw coded(dirFailures.get(key), `readdir ${key}`)
      if (!dirs.has(key)) throw coded('ENOENT', `readdir ${key}`)
      return dirs.get(key).slice()
        .map((entry) => toDirent(entry, key))
        .sort((left, right) => compareCodePoints(left.name, right.name))
    },
    /**
     * Stat one path: a directory, a plain file, or ENOENT.
     *
     * @param path - the path, possibly a declared symlink.
     * @returns a minimal Stats stand-in.
     */
    async stat(path) {
      const requested = resolve(path)
      const key = links.get(requested) ?? requested
      calls.push(['stat', requested])
      if (statFailures.has(requested)) throw coded(statFailures.get(requested), `stat ${requested}`)
      if (dirs.has(key)) return { isDirectory: () => true, isFile: () => false, size: 0 }
      if (files.has(key)) {
        return {
          isDirectory: () => false,
          isFile: () => true,
          size: Buffer.byteLength(String(files.get(key)), 'utf8'),
        }
      }
      throw coded('ENOENT', `stat ${requested}`)
    },
    /**
     * Read one file as utf8, following a declared link in any path segment.
     *
     * @param path - the file.
     * @returns the text.
     */
    async readFile(path) {
      const requested = resolve(path)
      const key = follow(requested)
      calls.push(['readFile', requested])
      if (!files.has(key)) throw coded('ENOENT', `readFile ${requested}`)
      return files.get(key)
    },
    /**
     * Write one file.
     *
     * @param path - the file.
     * @param text - the content.
     */
    async writeFile(path, text) {
      const key = resolve(path)
      calls.push(['writeFile', key])
      files.set(key, text)
    },
    /**
     * Rename one file over another.
     *
     * @param from - the temporary file.
     * @param to - the target.
     */
    async rename(from, to) {
      const source = resolve(from)
      const target = resolve(to)
      calls.push(['rename', source, target])
      if (!files.has(source)) throw coded('ENOENT', `rename ${source}`)
      files.set(target, files.get(source))
      files.delete(source)
    },
    /**
     * Resolve a real path; the fake filesystem has no links to follow.
     *
     * @param path - the path.
     * @returns the same path.
     */
    async realpath(path) {
      return path
    },
    /**
     * Create a directory (a no-op beyond recording the call).
     *
     * @param path - the directory.
     */
    async mkdir(path) {
      calls.push(['mkdir', resolve(path)])
    },
    /** @param path - the file. @returns whether it exists. */
    has(path) {
      return files.has(resolve(path))
    },
    /** @param path - the file. @returns its text. */
    text(path) {
      return files.get(resolve(path))
    },
  }
}

/**
 * An Error carrying a POSIX-style code, which is how the module classifies a
 * failure.
 *
 * @param code - the code, e.g. `ENOENT` or `EPERM`.
 * @param message - a human-readable message.
 * @returns the error.
 */
function coded(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

/**
 * Build a store over a fake filesystem.
 *
 * `extra` is spread LAST, so an `extra` key overrides any default and a caller
 * can supply just one of them (`{ projectCwd }`, `{ customDirs }`). A caller
 * that also wants different filesystem functions — to make one read fail — puts
 * them in `extra.overrides`, which is the only nested key this helper reads.
 *
 * @param fs - the fake filesystem.
 * @param extra - store options, plus an optional `overrides` bag.
 * @returns the store.
 */
function storeOn(fs, extra = {}) {
  const { overrides = {}, ...rest } = extra
  return createSkillStore({
    dshHome: DSH,
    agentsHome: AGENTS,
    bundledDir: BUNDLED,
    homedir: () => 'A:/home',
    projectCwd: null,
    readFile: fs.readFile,
    readdir: fs.readdir,
    stat: fs.stat,
    realpath: fs.realpath,
    writeFile: fs.writeFile,
    rename: fs.rename,
    mkdir: fs.mkdir,
    ...rest,
    ...overrides,
  })
}

/**
 * A fake filesystem holding one root's worth of skills.
 *
 * @param dir - the skill root.
 * @param entries - `{ name: text }` for a flat file, or `{ name: { file: text } }` for a bundle.
 * @returns the seeded fake.
 */
function rootWith(dir, entries) {
  const fs = memFs()
  const listing = []
  fs.addDir(dir, listing)
  for (const [name, value] of Object.entries(entries)) {
    if (typeof value === 'string') {
      fs.addFile(join(dir, name), value)
      listing.push({ name, type: 'file' })
      continue
    }
    const inner = []
    fs.addDir(join(dir, name), inner)
    listing.push({ name, type: 'directory' })
    for (const [file, text] of Object.entries(value)) {
      fs.addFile(join(dir, name, file), text)
      inner.push({ name: file, type: 'file' })
    }
  }
  return fs
}

// ------------------------------------------- ranking, shadowing, project root

{
  const fs = memFs()
  const cwd = 'A:/proj/src/deep'
  fs.addDir(cwd)
  fs.addDir('A:/proj/src')
  fs.addDir('A:/proj')
  fs.addDir('A:/proj/.git')
  fs.addDir(join('A:/proj', '.dsh', 'skills'))
  fs.addDir(join('A:/proj', '.agents', 'skills'))
  fs.addDir(join(DSH, 'skills'))
  fs.addDir(join(AGENTS, 'skills'))
  fs.addDir(BUNDLED)
  fs.addFile(join('A:/proj', '.git', 'HEAD'), 'ref: refs/heads/main\n')
  fs.addFile(join('A:/proj', '.dsh', 'skills', 'dupe.md'), skillMd('dupe', 'from the project'))
  fs.entries(join('A:/proj', '.dsh', 'skills')).push({ name: 'dupe.md', type: 'file' })
  fs.addFile(join('A:/proj', '.agents', 'skills', 'dupe.md'), skillMd('dupe', 'from the project agents root'))
  fs.entries(join('A:/proj', '.agents', 'skills')).push({ name: 'dupe.md', type: 'file' })
  fs.addFile(join(DSH, 'skills', 'dupe.md'), skillMd('dupe', 'from the user root'))
  fs.entries(join(DSH, 'skills')).push({ name: 'dupe.md', type: 'file' })
  fs.addFile(join(DSH, 'skills', 'user-only.md'), skillMd('user-only'))
  fs.entries(join(DSH, 'skills')).push({ name: 'user-only.md', type: 'file' })
  fs.addFile(join(AGENTS, 'skills', 'agents-only.md'), skillMd('agents-only'))
  fs.entries(join(AGENTS, 'skills')).push({ name: 'agents-only.md', type: 'file' })
  fs.addFile(join(BUNDLED, 'shipped.md'), skillMd('shipped'))
  fs.entries(BUNDLED).push({ name: 'shipped.md', type: 'file' })

  const store = storeOn(fs, { projectCwd: 'A:/proj/src' })
  const doc = await store.list({ cwd })

  eq(doc.roots.map((root) => root.source),
    ['project-dsh', 'project-agents', 'user-dsh', 'user-agents', 'bundled'],
    'the roots come back in rank order, with the project root found through .git')
  eq(doc.roots.map((root) => root.rank), [100, 200, 400, 500, 600], 'every root carries its provider rank')
  ok(doc.projectRoot === resolve('A:/proj'),
    `the project root is the nearest ancestor holding .git, not the cwd (got ${doc.projectRoot})`)
  ok(doc.roots.every((root) => root.exists), 'every seeded root reports that it exists')
  ok(doc.roots.find((root) => root.source === 'bundled').writable === false, 'the bundled root is read-only')

  eq(doc.skills.map((skill) => skill.name), ['agents-only', 'dupe', 'shipped', 'user-only'],
    'the catalog is one entry per name, sorted by name')
  const dupe = doc.skills.find((skill) => skill.name === 'dupe')
  eq(dupe.source, 'project-dsh', 'the lowest-ranked copy of a duplicate wins')
  eq(dupe.provider, 'filesystem', 'a local file is served by the filesystem provider')
  eq(dupe.description, 'from the project', 'the winning copy supplies the description')
  eq(dupe.kind, 'flat', 'a bare <name>.md is a flat skill')
  eq(dupe.dir, join('A:/proj', '.dsh', 'skills'), 'a flat skill resolves resources against its root')
  ok(dupe.writable, 'a project copy is writable')
  eq(doc.duplicates, [
    { name: 'dupe', winner: 'project-dsh', losers: ['project-agents', 'user-dsh'] },
  ], 'every losing copy of a duplicate name is listed')
  eq(doc.roots.map((root) => root.count), [1, 1, 2, 1, 1], 'each root reports how many entries it contributed')
  ok(doc.warnings.length === 0, `a healthy scan has no warnings (got ${JSON.stringify(doc.warnings)})`)
  eq(doc.skills.find((skill) => skill.name === 'shipped').writable, false, 'a bundled skill is never writable')

  // A custom root is its own source, and its rank (300) beats the user root, so
  // its copy of a name wins — from rank alone, not from scan order.
  const customFs = rootWith(join(MEM, 'custom'), { 'shared.md': skillMd('shared', 'from custom') })
  customFs.addDir(join(DSH, 'skills'))
  customFs.addFile(join(DSH, 'skills', 'shared.md'), skillMd('shared', 'from the user root'))
  customFs.entries(join(DSH, 'skills')).push({ name: 'shared.md', type: 'file' })
  const customDoc = await storeOn(customFs, { customDirs: [join(MEM, 'custom')] }).list({ cwd: null })
  eq(customDoc.roots.map((root) => root.source), ['custom', 'user-dsh', 'user-agents', 'bundled'],
    'a custom root is scanned between the project roots and the user roots')
  eq(customDoc.skills.map((skill) => [skill.name, skill.source]), [['shared', 'custom']],
    'a custom root outranks the user roots, and the loser is only in duplicates')
  eq(customDoc.duplicates, [{ name: 'shared', winner: 'custom', losers: ['user-dsh'] }],
    'the duplicate list names the custom root as the winner')
  console.log('  list: ranks, duplicate shadowing and the project root found through .git')
}

// -------------------------------------------------- bundle, flat and .system

{
  const fs = rootWith(join(DSH, 'skills'), {
    'bundle-skill': { 'SKILL.md': skillMd('bundle-skill'), 'notes.md': 'resource\n' },
    'flat-skill.md': skillMd('flat-skill'),
    'readme.txt': 'not a skill\n',
    '.system': { 'SKILL.md': skillMd('system-skill') },
    'no-manifest': { 'notes.md': 'no SKILL.md here\n' },
  })
  const doc = await storeOn(fs).list()

  eq(doc.skills.map((skill) => skill.name), ['bundle-skill', 'flat-skill'], 'a bundle and a flat file are both found')
  const bundle = doc.skills.find((skill) => skill.name === 'bundle-skill')
  eq(bundle.kind, 'bundle', 'a directory with SKILL.md is a bundle')
  ok(bundle.path === join(DSH, 'skills', 'bundle-skill', 'SKILL.md'), 'a bundle is read from its SKILL.md')
  eq(bundle.dir, join(DSH, 'skills', 'bundle-skill'), 'a bundle resolves resources against its own directory')
  eq(doc.skills.find((skill) => skill.name === 'flat-skill').kind, 'flat', 'a bare <name>.md is flat')
  ok(!doc.skills.some((skill) => skill.name === 'system-skill'), '.system under the user root is skipped')
  ok(!doc.skills.some((skill) => skill.name === 'readme.txt'), 'a non-.md file in the root is not a skill')
  ok(!doc.skills.some((skill) => skill.name === 'no-manifest'), 'a bundle without SKILL.md is not a skill')
  eq(doc.roots.find((root) => root.source === 'user-dsh').count, 2, '.system is not counted either')
  console.log('  discovery: directory bundles, flat files, .system and unusable entries')
}

// ------------------------------------------------------------ broken symlinks

{
  const linkTarget = 'A:/targets/linked'
  const fs = rootWith(join(DSH, 'skills'), { good: { 'SKILL.md': skillMd('good') } })
  fs.entries(join(DSH, 'skills')).push({ name: 'broken.md', type: 'symlink' })
  fs.entries(join(DSH, 'skills')).push({ name: 'linked', type: 'symlink' })
  fs.entries(join(DSH, 'skills')).push({ name: 'denied.md', type: 'symlink' })
  fs.addDir(linkTarget)
  fs.addFile(join(linkTarget, 'SKILL.md'), skillMd('linked'))
  fs.entries(linkTarget).push({ name: 'SKILL.md', type: 'file' })
  const link = join(DSH, 'skills', 'linked')
  fs.addLink(link, linkTarget)
  // At this point only `broken.md` is broken: it has no declared target.
  fs.failStat(join(DSH, 'skills', 'broken.md'), 'ENOENT')
  const store = storeOn(fs)
  const doc = await store.list()

  eq(doc.skills.map((skill) => skill.name), ['good', 'linked'], 'a symlinked bundle is followed, a broken one is skipped')
  eq(doc.skills.find((skill) => skill.name === 'linked').kind, 'bundle', 'the followed link is a bundle')
  // `denied.md` has no target either, so it is skipped in the same way for the
  // same reason; the code it reports is what changes below.
  eq(doc.warnings.slice().sort(), [
    `${join(DSH, 'skills', 'broken.md')}: ENOENT`,
    `${join(DSH, 'skills', 'denied.md')}: ENOENT`,
  ], 'each dangling link leaves exactly one warning line')

  fs.failStat(join(DSH, 'skills', 'denied.md'), 'EPERM')
  const withDenied = await store.list()
  ok(withDenied.warnings.some((line) => line.endsWith('EPERM')), 'a link the platform refuses warns with its code')
  eq(withDenied.skills.map((skill) => skill.name), ['good', 'linked'], 'a stat failure never removes a healthy skill')
  console.log('  discovery: a broken symlink warns and is skipped, never fatal')
}

// ------------------------------------------------------- bad roots and no root

{
  const fs = rootWith(join(DSH, 'skills'), { 'only.md': skillMd('only') })
  // The user-agents root exists as a directory but the platform refuses to list
  // it, which is the case that has to degrade to a warning.
  fs.addDir(join(AGENTS, 'skills'))
  fs.failDir(join(AGENTS, 'skills'), 'EPERM')
  const doc = await storeOn(fs).list()

  eq(doc.skills.map((skill) => skill.name), ['only'], 'an unlistable root does not stop the scan')
  eq(doc.warnings, [`${join(AGENTS, 'skills')}: EPERM`], 'an unlistable root contributes one warning line')
  eq(doc.roots.map((root) => [root.source, root.exists]),
    [['user-dsh', true], ['user-agents', true], ['bundled', false]],
    'an unlistable root still reports that it exists')

  const bareDoc = await storeOn(memFs()).list()
  eq(bareDoc.skills, [], 'a missing ~/.dsh/skills is an empty catalog, not an error')
  eq(bareDoc.warnings, [], 'a root that simply does not exist needs no warning')
  eq(bareDoc.roots.map((root) => root.exists), [false, false, false], 'every absent root reports exists: false')
  eq(bareDoc.counts, { total: 0, enabled: 0, userOnly: 0, disabled: 0, writable: 0, invalid: 0 }, 'the empty catalog counts zero')

  const noProject = storeOn(rootWith(join(DSH, 'skills'), { 'lone.md': skillMd('lone') }), { projectCwd: null })
  const noProjectDoc = await noProject.list({ cwd: null })
  eq(noProjectDoc.roots.map((root) => root.source), ['user-dsh', 'user-agents', 'bundled'],
    'without a project root the project roots are absent')
  eq(noProjectDoc.skills.map((skill) => skill.name), ['lone'], 'a skill is still found without a project root')
  eq(noProjectDoc.projectRoot, null, 'a session with no cwd reports no project root')
  console.log('  list: a missing user root, a missing project root and an unlistable root all survive')
}

// ---------------------------------------------------------------- frontmatter

{
  const fs = rootWith(join(DSH, 'skills'), {
    'no-frontmatter.md': '# just a body\n',
    'bad-name.md': '---\nname: Bad_Name\ndescription: nope\n---\nbody\n',
    'no-name.md': '---\ndescription: has no name\n---\nbody\n',
    'no-description.md': '---\nname: no-description\n---\nbody\n',
    'legacy-model.md': '---\nname: legacy-model\ndescription: d\nmodelInvocable: false\n---\nbody\n',
    'legacy-user.md': '---\nname: legacy-user\ndescription: d\nuserInvocable: false\n---\nbody\n',
    'legacy-disable.md': '---\nname: legacy-disable\ndescription: d\ndisableModelInvocation: true\n---\nbody\n',
    'bad-bool.md': '---\nname: bad-bool\ndescription: d\ndisable-model-invocation: maybe\n---\nbody\n',
    'nested-only.md': '---\nmetadata:\n  name: nested-only\n  description: only nested\n---\nbody\n',
    'valid.md': '---\nname: valid\ndescription: d\nwhenToUse: whenever\n---\nbody\n',
  })
  const doc = await storeOn(fs).list()
  const byName = new Map(doc.skills.map((skill) => [skill.name, skill]))

  eq(byName.get('no-frontmatter').note, 'no-frontmatter', 'a file with no --- block is no-frontmatter')
  eq(byName.get('Bad_Name').note, 'frontmatter-invalid', 'a non-kebab-case name is frontmatter-invalid')
  eq(byName.get('no-name').note, 'frontmatter-invalid', 'a missing name is frontmatter-invalid')
  eq(byName.get('no-description').note, 'frontmatter-invalid', 'a missing description is frontmatter-invalid')
  eq(byName.get('legacy-model').note, 'frontmatter-invalid', 'a legacy modelInvocable key is rejected')
  eq(byName.get('legacy-user').note, 'frontmatter-invalid', 'a legacy userInvocable key is rejected')
  eq(byName.get('legacy-disable').note, 'frontmatter-invalid', 'a legacy disableModelInvocation key is rejected')
  eq(byName.get('bad-bool').note, 'frontmatter-invalid', 'a non-boolean switch value is frontmatter-invalid')
  eq(byName.get('nested-only').note, 'frontmatter-invalid', 'only the top level of the frontmatter is read')
  ok(byName.get('no-frontmatter').name === 'no-frontmatter', 'a nameless skill still shows the name it is filed under')
  eq(byName.get('valid').note, null, 'a valid skill carries no note')
  eq(byName.get('valid').whenToUse, 'whenever', 'whenToUse is carried through')
  ok(doc.skills.filter((skill) => skill.note !== null).every((skill) => skill.writable === false),
    'an unusable skill is never writable')
  ok(byName.get('valid').writable, 'a valid skill is writable')
  eq(byName.get('legacy-model').modelInvocable, false, 'a legacy-key skill is not invocable either')
  console.log('  frontmatter: every unusable shape is listed with its note and is not writable')
}

// --------------------------------------------- switches, quoting and comments

{
  // One row per case: the mode, the file's frontmatter, the exact frontmatter the
  // rewrite must produce, and the policy that result reads back as.
  const cases = [
    ['on', '---\nname: s\ndescription: d\n---\n',
      '---\nname: s\ndescription: d\n---\n', [true, true]],
    ['model-off', '---\nname: s\ndescription: d\ndisable-model-invocation: true\n---\n',
      '---\nname: s\ndescription: d\ndisable-model-invocation: true\n---\n', [false, true]],
    ['off', '---\nname: s\ndescription: d\ndisable-model-invocation: yes\nuser-invocable: on\n---\n',
      '---\nname: s\ndescription: d\ndisable-model-invocation: true\nuser-invocable: false\n---\n', [false, false]],
    ['off', '---\nname: s\ndescription: d\ndisable-model-invocation: 0 # not disabled\n---\n',
      '---\nname: s\ndescription: d\ndisable-model-invocation: true\nuser-invocable: false\n---\n', [false, false]],
    ['on', '---\nname: s\ndescription: d\ndisable-model-invocation: 1\nuser-invocable: true\n---\n',
      '---\nname: s\ndescription: d\n---\n', [true, true]],
    ['model-off', '---\nname: s\ndescription: d\nuser-invocable: false\n---\n',
      '---\nname: s\ndescription: d\ndisable-model-invocation: true\n---\n', [false, true]],
  ]
  cases.forEach(([mode, text, expectedText, expected], index) => {
    const rewritten = rewriteFrontmatter(text, mode)
    eq(rewritten.text, expectedText, `mode ${mode} on case ${index} writes exactly the contract's keys`)
    const policy = parseInvocation(parseFrontmatter(rewritten.text).data)
    eq([policy.modelInvocable, policy.userInvocable], expected, `mode ${mode} on case ${index} reads back as the contract's policy`)
  })

  eq(parseScalar("'off'"), 'off', 'a single-quoted scalar is unquoted')
  eq(parseScalar('"yes"'), 'yes', 'a double-quoted scalar is unquoted')
  eq(parseScalar('true # a trailing comment'), 'true', 'an unquoted trailing comment is stripped')
  eq(parseScalar("'true # not a comment' # a comment"), 'true # not a comment', 'a # inside quotes is not a comment')
  eq(parseScalar('false   '), 'false', 'a bare scalar is trimmed')
  eq(parseScalar('# only a comment'), undefined, 'a comment-only value is not a value')
  eq(parseScalar('~'), null, 'a bare ~ is null')
  eq(parseBooleanScalar('YES', 'user-invocable'), true, 'yes is true, case-insensitively')
  eq(parseBooleanScalar('0', 'user-invocable'), false, '0 is false')
  assert.throws(() => parseBooleanScalar('maybe', 'user-invocable'), TypeError, 'a non-boolean switch value throws')
  checks += 1
  assert.throws(() => parseBooleanScalar(null, 'user-invocable'), /must be a boolean/, 'null is not a boolean')
  checks += 1
  console.log('  frontmatter: quoting, trailing comments and the boolean vocabulary')
}

// ----------------------------------------------------------------- parseSkill

{
  const skill = parseSkill('---\nname: fine\ndescription: d\ndisable-model-invocation: true\n---\n')
  eq([skill.modelInvocable, skill.userInvocable], [false, true], 'disable-model-invocation disables only the model')
  const userOff = parseSkill('---\nname: fine\ndescription: d\nuser-invocable: false\n---\n')
  eq([userOff.modelInvocable, userOff.userInvocable], [true, false], 'user-invocable: false hides only the gesture')
  eq(parseSkill('---\nname: fine\ndescription: "   "\n---\n').note, 'frontmatter-invalid',
    'a whitespace-only description is not a description')
  const crlf = parseSkill('---\r\nname: fine\r\ndescription: d\r\n---\r\nbody\r\n')
  eq([crlf.name, crlf.note], ['fine', null], 'CRLF frontmatter parses the same way')
  eq(parseFrontmatter('no frontmatter at all\n'), null, 'a file that does not start with --- has no frontmatter')
  eq(parseFrontmatter('---\nname: unterminated\n'), null, 'an unterminated block has no frontmatter')
  eq(rewriteFrontmatter('no frontmatter at all\n', 'off'), null, 'there is nothing to rewrite without a block')
  console.log('  parseSkill: a valid skill, the two switches, and the no-block cases')
}

// -------------------------------------------------------------------- counts

{
  const fs = rootWith(join(DSH, 'skills'), {
    'enabled-a.md': skillMd('enabled-a'),
    'enabled-b.md': skillMd('enabled-b'),
    'user-only.md': '---\nname: user-only\ndescription: d\ndisable-model-invocation: true\n---\nbody\n',
    'disabled.md': '---\nname: disabled\ndescription: d\ndisable-model-invocation: true\nuser-invocable: false\n---\nbody\n',
    'broken.md': '---\nname: Bad Name\ndescription: d\n---\nbody\n',
    'legacy.md': '---\nname: legacy\ndescription: d\nmodelInvocable: true\n---\nbody\n',
    'gone.md': skillMd('gone'),
  })
  fs.removeFile(join(DSH, 'skills', 'gone.md'))
  const doc = await storeOn(fs).list()
  eq(doc.counts, { total: 7, enabled: 2, userOnly: 1, disabled: 4, writable: 4, invalid: 3 },
    'counts split the catalog into enabled, user-only, disabled and invalid')
  eq(countSkills(doc.skills).total, doc.skills.length, 'countSkills agrees with the catalog it summarised')
  eq(countSkills([]), { total: 0, enabled: 0, userOnly: 0, disabled: 0, writable: 0, invalid: 0 }, 'countSkills on an empty list')
  eq(countSkills(null).total, 0, 'countSkills tolerates a non-array')
  const gone = doc.skills.find((skill) => skill.name === 'gone')
  eq(gone.note, 'unreadable', 'a flat file that disappeared between readdir and read is unreadable')
  eq(gone.description, '', 'an unreadable skill has no description')
  eq(gone.writable, false, 'an unreadable skill is not writable')
  console.log('  counts: enabled / userOnly / disabled / invalid arithmetic')
}

// --------------------------------------------------- setEnabled on a real disk

{
  const fixture = await realFixture()
  const { roots } = fixture
  try {
    const skillsRoot = join(roots.dshHome, 'skills')
    await mkdir(skillsRoot, { recursive: true })
    await writeFile(join(roots.bundled, 'shipped.md'), skillMd('shipped'), 'utf8')
    const store = createSkillStore({
      dshHome: roots.dshHome,
      agentsHome: roots.agentsHome,
      bundledDir: roots.bundled,
      projectCwd: roots.sub,
    })

    // ---- a hand-written file with CRLF, a nested mapping and comments
    const handled = [
      '---',
      'name: handled',
      'description: line one',
      '# a whole-line comment that must survive',
      'metadata:',
      '  owner: someone',
      'user-invocable: false # a trailing comment',
      '---',
      '',
      '# Body',
      '',
      'Two blank lines above, and a `#` in the body that is not a comment.',
      '',
    ].join('\r\n')
    const handledPath = join(skillsRoot, 'handled.md')
    await writeFile(handledPath, handled, 'utf8')

    const off = await store.setEnabled({ name: 'handled', mode: 'off' })
    eq(off.before, { modelInvocable: true, userInvocable: false }, 'before reports the policy the file had')
    eq(off.after, { modelInvocable: false, userInvocable: false }, 'off turns both switches off')
    eq(off.mode, 'off', 'the answer echoes the mode')
    eq(off.path, handledPath, 'the answer names the file that was edited')
    eq(await readFile(handledPath, 'utf8'), [
      '---',
      'name: handled',
      'description: line one',
      '# a whole-line comment that must survive',
      'metadata:',
      '  owner: someone',
      'user-invocable: false',
      'disable-model-invocation: true',
      '---',
      '',
      '# Body',
      '',
      'Two blank lines above, and a `#` in the body that is not a comment.',
      '',
    ].join('\r\n'), 'off takes the value out of a key, appends the missing one at the END, and changes nothing else')

    // ---- turning it on again removes the key it added. `user-invocable: false`
    // is NOT a remainder of that key: the contract keeps it, because 'on' only
    // clears the model switch and the true-only user switch.
    const on = await store.setEnabled({ name: 'handled', mode: 'on' })
    eq(on.after, { modelInvocable: true, userInvocable: false }, 'on clears the model switch and keeps the user switch')
    eq(await readFile(handledPath, 'utf8'), [
      '---',
      'name: handled',
      'description: line one',
      '# a whole-line comment that must survive',
      'metadata:',
      '  owner: someone',
      'user-invocable: false',
      '---',
      '',
      '# Body',
      '',
      'Two blank lines above, and a `#` in the body that is not a comment.',
      '',
    ].join('\r\n'), 'on removes the key it added, keeping the CRLF line endings and the comment')

    // ---- a mode the file already satisfies must not touch it at all
    const settled = await readFile(handledPath, 'utf8')
    await store.setEnabled({ name: 'handled', mode: 'on' })
    eq(await readFile(handledPath, 'utf8'), settled, 'a mode the file already satisfies leaves it byte-identical')

    // ---- model-off removes ONLY a `user-invocable: false` line
    const modelOff = await store.setEnabled({ name: 'handled', mode: 'model-off' })
    eq(modelOff.after, { modelInvocable: false, userInvocable: true }, 'model-off hides the skill from the model only')
    const modelOffText = await readFile(handledPath, 'utf8')
    ok(!modelOffText.includes('user-invocable'), 'model-off strips the false user-invocable line')
    eq(modelOffText, [
      '---',
      'name: handled',
      'description: line one',
      '# a whole-line comment that must survive',
      'metadata:',
      '  owner: someone',
      'disable-model-invocation: true',
      '---',
      '',
      '# Body',
      '',
      'Two blank lines above, and a `#` in the body that is not a comment.',
      '',
    ].join('\r\n'), 'model-off removes one line, appends one key, and preserves every other byte')

    // ---- a fresh file gets its keys appended in the contract's order
    await writeFile(join(skillsRoot, 'appended.md'), skillMd('appended'), 'utf8')
    await store.setEnabled({ name: 'appended', mode: 'off' })
    eq(await readFile(join(skillsRoot, 'appended.md'), 'utf8'),
      '---\nname: appended\ndescription: About appended.\ndisable-model-invocation: true\nuser-invocable: false\n---\n\n# appended\n',
      'a key that has to be added is appended at the end of the block')

    // ---- a quoted boolean is replaced in place, keeping the line's position
    await writeFile(join(skillsRoot, 'quoted.md'),
      "---\nname: quoted\ndescription: d\ndisable-model-invocation: 'no' # keep me\n---\nbody\n", 'utf8')
    await store.setEnabled({ name: 'quoted', mode: 'model-off' })
    eq(await readFile(join(skillsRoot, 'quoted.md'), 'utf8'),
      '---\nname: quoted\ndescription: d\ndisable-model-invocation: true\n---\nbody\n',
      'a quoted false value is replaced in place, key order kept')

    // ---- a bundle is edited through its SKILL.md
    await mkdir(join(skillsRoot, 'bundle-skill'), { recursive: true })
    await writeFile(join(skillsRoot, 'bundle-skill', 'SKILL.md'), skillMd('bundle-skill'), 'utf8')
    const bundled = await store.setEnabled({ name: 'bundle-skill', mode: 'off' })
    eq(bundled.path, join(skillsRoot, 'bundle-skill', 'SKILL.md'), 'a bundle is edited through its SKILL.md')
    console.log('  setEnabled (real dir): every mode preserves the rest of the file byte for byte')
  } finally {
    await fixture.cleanup()
  }
}

// -------------------------------------------------------- setEnabled refusals

{
  const fixture = await realFixture()
  const { roots } = fixture
  try {
    const skillsRoot = join(roots.dshHome, 'skills')
    await mkdir(join(roots.agentsHome, 'skills'), { recursive: true })
    await mkdir(join(skillsRoot, 'stale'), { recursive: true })
    await writeFile(join(skillsRoot, 'plain.md'), skillMd('plain'), 'utf8')
    await writeFile(join(skillsRoot, 'nofront.md'), '# no frontmatter here\n', 'utf8')
    await writeFile(join(skillsRoot, 'mismatch.md'), skillMd('declared-elsewhere'), 'utf8')
    await writeFile(join(skillsRoot, 'stale', 'SKILL.md'), skillMd('something-else'), 'utf8')
    await writeFile(join(roots.bundled, 'shipped.md'), skillMd('shipped'), 'utf8')
    const store = createSkillStore({
      dshHome: roots.dshHome,
      agentsHome: roots.agentsHome,
      bundledDir: roots.bundled,
      projectCwd: null,
    })

    const unknown = await refuse(() => store.setEnabled({ name: 'nope', mode: 'off' }), 'an unknown name')
    ok(unknown.message.includes('nope'), 'the refusal names the skill')
    const badMode = await refuse(() => store.setEnabled({ name: 'plain', mode: 'maybe' }), 'an unknown mode')
    ok(badMode.message.includes('maybe'), 'the mode refusal names the mode')
    const bundled = await refuse(() => store.setEnabled({ name: 'shipped', mode: 'off' }), 'a bundled skill')
    ok(bundled.message.includes('只读'), 'the bundled refusal says the source is read-only')
    // The catalog files `stale/SKILL.md` under its DECLARED name, so this lookup
    // finds it and the refusal comes from the name/location disagreement, not
    // from the skill being unknown. That is exactly the check that protects the
    // rewrite from binding to a name the entry does not carry.
    const stale = await refuse(() => store.setEnabled({ name: 'something-else', mode: 'off' }), 'a stale directory name')
    ok(stale.message.includes('不一致'), `the stale refusal says the name and the location disagree: ${stale.message}`)
    ok(stale.message.includes('something-else'), 'the stale refusal names the declared name')
    const mismatch = await refuse(() => store.setEnabled({ name: 'declared-elsewhere', mode: 'off' }),
      'a stale flat-file name')
    ok(mismatch.message.includes('mismatch'), `the flat mismatch refusal names the file it sits in: ${mismatch.message}`)
    const noFront = await refuse(() => store.setEnabled({ name: 'nofront', mode: 'off' }), 'a file with no frontmatter')
    ok(noFront.message.includes('no-frontmatter'), `the no-frontmatter refusal carries its reason: ${noFront.message}`)

    // Every refusal above must have left the disk exactly as it was.
    eq(await readFile(join(roots.bundled, 'shipped.md'), 'utf8'), skillMd('shipped'), 'a refused write leaves the file alone')
    eq(await readFile(join(skillsRoot, 'plain.md'), 'utf8'), skillMd('plain'), 'a refused mode leaves the file alone')
    eq(await readFile(join(skillsRoot, 'mismatch.md'), 'utf8'), skillMd('declared-elsewhere'), 'a stale name leaves the file alone')
    console.log('  setEnabled: unknown name, bundled root, stale name and no frontmatter all refuse')
  } finally {
    await fixture.cleanup()
  }
}

// ----------------------------- setEnabled: unreadable file and the atomic write

{
  // A flat file that cannot be read at all: the card lists it as unreadable, and
  // the write half refuses before touching anything.
  const unreadableFs = rootWith(join(DSH, 'skills'), { 'locked.md': skillMd('locked') })
  const unreadable = storeOn(unreadableFs, {
    overrides: {
      readFile: async (path) => {
        if (String(path).endsWith('locked.md')) throw coded('EACCES', `readFile ${path}`)
        return unreadableFs.readFile(path)
      },
    },
  })
  const unreadableDoc = await unreadable.list()
  eq(unreadableDoc.skills.map((skill) => [skill.name, skill.note, skill.writable]),
    [['locked', 'unreadable', false]], 'a flat file that cannot be read is listed as unreadable and is not writable')
  const refused = await refuse(() => unreadable.setEnabled({ name: 'locked', mode: 'off' }),
    'a skill whose file cannot be read')
  ok(refused.message.includes('无法读取'), 'the unreadable refusal says the file could not be read')

  // A writable flat file: the edit goes through a sibling .tmp file and a rename,
  // so no reader ever sees half a SKILL.md.
  const fs = rootWith(join(DSH, 'skills'), { 'edit-me.md': skillMd('edit-me') })
  const target = join(DSH, 'skills', 'edit-me.md')
  await storeOn(fs).setEnabled({ name: 'edit-me', mode: 'off' })
  eq(fs.calls.filter((call) => call[0] === 'writeFile' || call[0] === 'rename'),
    [['writeFile', `${target}.tmp`], ['rename', `${target}.tmp`, target]],
    'the write is a temporary sibling followed by a rename')
  ok(!fs.has(`${target}.tmp`), 'the temporary sibling does not survive the write')
  eq(fs.text(target),
    '---\nname: edit-me\ndescription: About edit-me.\ndisable-model-invocation: true\nuser-invocable: false\n---\n\n# edit-me\n',
    'the renamed file carries the edited frontmatter')
  console.log('  setEnabled: an unreadable file refuses, a writable one is written atomically')
}

// ------------------------------------------------ read: one Skill's own content

{
  // The read the content pane is built on. It resolves the name through `list()`
  // first, so it can only ever open the copy the catalog already shows as the
  // winner — a second discovery path that could open something the library does
  // not list would show the user a file the panel denies exists.
  const skillsRoot = join(DSH, 'skills')
  const fs = rootWith(skillsRoot, {
    'flat.md': '---\nname: flat\ndescription: A flat one.\nversion: 2.1.0\n---\n\nFirst line.\nSecond line.\n',
    'bare.md': 'No frontmatter at all.\nJust a body.\n',
    'switches.md': '---\nname: switches\ndescription: Both switches off.\ndisable-model-invocation: true\nuser-invocable: false\n---\n\nBody.\n',
    'nonsense.md': '---\nname: nonsense\ndescription: A bad switch.\ndisable-model-invocation: maybe\n---\n\nBody.\n',
    'legacy.md': '---\nname: legacy\ndescription: The old spelling.\ndisableModelInvocation: true\n---\n\nBody.\n',
    'nodesc.md': '---\nname: nodesc\n---\n\nBody.\n',
  })
  // A bundle needs its own listing registered at each level, because a seeded
  // file is not automatically visible to a directory read.
  const bundleListing = []
  const scriptListing = []
  fs.addDir(join(skillsRoot, 'bundle'), bundleListing)
  fs.entries(skillsRoot).push({ name: 'bundle', type: 'directory' })
  fs.addFile(join(skillsRoot, 'bundle', 'SKILL.md'), skillMd('bundle', 'A bundle.'))
  bundleListing.push({ name: 'SKILL.md', type: 'file' })
  fs.addFile(join(skillsRoot, 'bundle', 'notes.txt'), 'notes')
  bundleListing.push({ name: 'notes.txt', type: 'file' })
  fs.addDir(join(skillsRoot, 'bundle', 'scripts'), scriptListing)
  bundleListing.push({ name: 'scripts', type: 'directory' })
  fs.addFile(join(skillsRoot, 'bundle', 'scripts', 'run.sh'), '#!/bin/sh\n')
  scriptListing.push({ name: 'run.sh', type: 'file' })
  fs.addFile(join(skillsRoot, 'bundle', '.hidden'), 'secret')
  bundleListing.push({ name: '.hidden', type: 'file' })
  const store = storeOn(fs)

  // --- a flat skill with frontmatter ----------------------------------------
  const flat = await store.read({ name: 'flat' })
  eq(flat.name, 'flat', 'the read answers with the name it was asked for')
  eq(flat.path, join(skillsRoot, 'flat.md'), 'and with the exact file it read')
  eq(flat.dir, skillsRoot, 'a flat skill resolves its resources against its root')
  eq(flat.source, 'user-dsh', 'the read reports the root the copy came from')
  eq(flat.kind, 'flat', 'and the shape it has on disk')
  eq(flat.writable, true, 'a user-root skill is writable')
  eq(flat.note, null, 'a well-formed skill carries no note')
  eq(flat.reason, null, 'a file that read fine carries no reason')
  eq(flat.truncated, false, 'a small file is not truncated')
  eq(flat.bytes, Buffer.byteLength(fs.text(join(skillsRoot, 'flat.md')), 'utf8'),
    'the byte count is the size of the whole file, not of the body')
  eq(flat.frontmatter, [
    { key: 'name', value: 'flat' },
    { key: 'description', value: 'A flat one.' },
    { key: 'version', value: '2.1.0' },
  ], 'the frontmatter comes back as ordered, labelled rows for the pane to render')
  eq(flat.body, 'First line.\nSecond line.\n',
    'and the body is the text BELOW the frontmatter, with the block separator dropped')
  eq(flat.files, [], 'a flat skill has no resource files to list')

  // --- a skill with no frontmatter block -------------------------------------
  // A real shape (a flat `<name>.md` with no metadata is still listed), and
  // pretending otherwise would show an empty pane for a perfectly readable file.
  const bare = await store.read({ name: 'bare' })
  eq(bare.body, 'No frontmatter at all.\nJust a body.\n', 'with no frontmatter block the whole file IS the body')
  eq(bare.frontmatter, [], 'and there are no facts to label')
  eq(bare.note, 'no-frontmatter', 'the pane is told why it has no metadata, so it can say so')
  eq(bare.reason, null, 'a file with no frontmatter is still a file that read successfully')

  // --- the two invocation switches, exactly as written -----------------------
  const switches = await store.read({ name: 'switches' })
  eq([switches.modelInvocable, switches.userInvocable], [false, false],
    'the read reports both switches so the pane shows the mode as written, not a guess')
  eq(switches.note, null, 'a skill that is switched off is not a broken skill')
  eq(switches.writable, true, 'and it stays writable, so the pane can still offer to turn it back on')

  // --- a skill the store cannot use is read anyway ---------------------------
  // The pane must be able to explain WHY a skill is not usable, which means
  // `read()` has to open exactly the files `list()` calls invalid.
  const nonsense = await store.read({ name: 'nonsense' })
  eq(nonsense.note, 'frontmatter-invalid', 'a nonsense boolean is reported as invalid frontmatter')
  eq(nonsense.writable, false, 'and an invalid skill is not offered as editable')
  eq(nonsense.frontmatter, [
    { key: 'name', value: 'nonsense' },
    { key: 'description', value: 'A bad switch.' },
    { key: 'disable-model-invocation', value: 'maybe' },
  ], 'the pane is still handed the offending line, so it can point at it')
  eq(nonsense.modelInvocable, false, 'and nothing about it is claimed to be invocable')
  eq((await store.read({ name: 'legacy' })).note, 'frontmatter-invalid',
    'the legacy camelCase spelling is rejected, not honoured')
  const nodesc = await store.read({ name: 'nodesc' })
  eq(nodesc.note, 'frontmatter-invalid', 'a missing description is a broken skill, not a usable one')
  eq(nodesc.body, 'Body.\n', 'but its body is still readable')

  // --- a bundle lists the resources that travel with it ----------------------
  const bundle = await store.read({ name: 'bundle' })
  eq(bundle.kind, 'bundle', 'a directory is a bundle')
  eq(bundle.body, '# bundle\n', 'and its SKILL.md is still parsed the same way')
  eq(bundle.files, [
    { path: 'notes.txt', kind: 'file', bytes: 5 },
    { path: 'scripts', kind: 'dir', bytes: 0 },
    { path: 'scripts/run.sh', kind: 'file', bytes: 10 },
  ], 'a bundle lists its resources in path order, directories before their own contents, SKILL.md itself excluded')
  ok(!bundle.files.some((file) => file.path === 'SKILL.md'), 'the file being read is not listed as its own resource')
  ok(!bundle.files.some((file) => file.path.startsWith('.')),
    'a hidden file is not a resource a Skill hands to a model')

  // --- an unknown name is refused, not answered emptily ----------------------
  const unknown = await refuse(() => store.read({ name: 'not-installed' }), 'a name no root lists')
  ok(unknown.message.includes('not-installed'), `the refusal names the skill asked for: ${unknown.message}`)
  const nameless = await refuse(() => store.read({}), 'no name at all')
  ok(nameless.message.length > 0, 'a read with no name is refused rather than answering an arbitrary file')

  // --- a file that cannot be read answers with a reason ----------------------
  // The pane has to be able to say "I could not read it", so this must not throw:
  // a thrown read would render as a pane that never finishes loading.
  const lockedFs = rootWith(skillsRoot, { 'locked.md': skillMd('locked'), 'fine.md': skillMd('fine') })
  const locked = storeOn(lockedFs, {
    overrides: {
      readFile: async (path) => {
        if (String(path).endsWith('locked.md')) throw coded('EACCES', `readFile ${path}`)
        return lockedFs.readFile(path)
      },
    },
  })
  const lockedDoc = await locked.read({ name: 'locked' })
  ok(lockedDoc.reason !== null && lockedDoc.reason.startsWith('unreadable: '),
    `an unreadable file answers with a reason instead of throwing (got ${JSON.stringify(lockedDoc.reason)})`)
  ok(lockedDoc.reason.includes('EACCES'), 'the reason carries the underlying cause, not a generic sentence')
  eq(lockedDoc.body, '', 'and no body is invented for it')
  eq(lockedDoc.frontmatter, [], 'nor any metadata')
  eq(lockedDoc.name, 'locked', 'the pane is still told which skill it could not read')

  // --- the winner is the copy that is read -----------------------------------
  // Two roots list the name; only the catalog's winner may be opened.
  const shadowFs = rootWith(skillsRoot, { 'dupe.md': skillMd('dupe', 'from the user root') })
  shadowFs.addDir(BUNDLED, [])
  shadowFs.addFile(join(BUNDLED, 'dupe.md'), skillMd('dupe', 'from the bundled root'))
  shadowFs.entries(BUNDLED).push({ name: 'dupe.md', type: 'file' })
  const shadowed = await storeOn(shadowFs)
  const shadowCatalog = await shadowed.list({ cwd: null })
  eq(shadowCatalog.duplicates, [{ name: 'dupe', winner: 'user-dsh', losers: ['bundled'] }],
    'the fixture really does shadow the name, otherwise the read below proves nothing')
  const winner = await shadowed.read({ name: 'dupe' })
  eq(winner.path, join(skillsRoot, 'dupe.md'), 'the read opens the winner\'s file, not the loser\'s')
  eq(winner.source, 'user-dsh', 'and reports the winner\'s source, so the two surfaces can never disagree')
  eq(winner.frontmatter.find((row) => row.key === 'description'),
    { key: 'description', value: 'from the user root' },
    'the bytes handed back are the winner\'s, which is the whole point of resolving through the catalog')

  // --- truncation is reported, never silent ---------------------------------
  // A Skill can be large, and the pane must be able to say "there is more" rather
  // than presenting a cut file as the whole thing. The cut is a fixed cap, so two
  // files of different over-cap sizes must come back the same length — that is
  // the property, asserted without pinning the literal in a second place.
  const bigFs = rootWith(skillsRoot, {
    'huge-a.md': 'x'.repeat(500000),
    'huge-b.md': 'y'.repeat(600000),
    'small.md': 'z'.repeat(100),
  })
  const bigStore = storeOn(bigFs)
  const hugeA = await bigStore.read({ name: 'huge-a' })
  const hugeB = await bigStore.read({ name: 'huge-b' })
  const small = await bigStore.read({ name: 'small' })
  eq(hugeA.truncated, true, 'a file past the read cap must say it was cut')
  eq(hugeB.truncated, true, 'and so must a larger one')
  eq(small.truncated, false, 'while a file under the cap is reported whole')
  eq(hugeA.bytes, 500000, 'the byte count still reports the real size of the file')
  eq(hugeB.bytes, 600000, 'even when far more was read than handed back')
  eq(hugeA.body.length, hugeB.body.length,
    'the cut is a fixed cap, not a proportion of the file')
  ok(hugeA.body.length < 500000, 'and the body handed back is shorter than the file it came from')

  console.log('  read: frontmatter rows, a bare body, the switches, bundle files, refusal, reason and the winner')
}

console.log(`skill-host: ${checks} checks passed`)

