/**
 * dsh-homepage — skill source registry unit checks.
 *
 * Plain `node:assert/strict`, no framework, mirroring `dsh-sampler.mjs`.
 * Nothing here touches the network: `fetch` is a router keyed by URL, and the
 * clock is injected so a TTL and an ETag can be driven deterministically. The
 * only filesystem writes are inside one temp directory that is created at the
 * start and deleted at the end.
 *
 * Run with `node test/skill-sources.mjs`; the last line is the sentinel the
 * smoke script greps for.
 */
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import {
  DEFAULT_SOURCES,
  clawhubRowFromList,
  clawhubRowFromSearch,
  createSkillSources,
  githubRowFromEntry,
  githubSkillDirs,
  isKebabName,
  isSafeEntryPath,
  matchRank,
  normalizeSources,
  parseFrontmatter,
  rankResults,
  readZipEntries,
  safeEntryPath,
  splitOwnerRef,
  splitSourceId,
  stripArchiveRoot,
  validateSkillMd,
} from '../lib/host/skill-sources.js'

// ------------------------------------------------------------------ fixtures

/** The exact key set of a `search()` document (contract §3.4). */
const SEARCH_KEYS = ['failures', 'query', 'results', 'searchedAt', 'source', 'truncated']

/** The exact key set of one `search()` row (contract §3.4). */
const ROW_KEYS = [
  'displayName', 'downloads', 'id', 'install', 'name', 'owner', 'skillUrl',
  'source', 'stars', 'summary', 'updatedAt', 'url', 'version',
]

/** The exact key set of one `sources()` row (contract §3.3). */
const SOURCE_KEYS = ['count', 'docs', 'home', 'id', 'kind', 'label', 'note', 'reachable']

/** The exact key set of a `detail()` document (contract §3.5). */
const DETAIL_KEYS = ['files', 'id', 'install', 'name', 'readme', 'skillMd', 'source', 'summary', 'version']

/** The ClawHub search payload, trimmed to the fields the normaliser reads. */
const CLAWHUB_SEARCH = {
  results: [
    {
      canonicalUrl: '/awspace/skills/pdf',
      displayName: 'Pdf',
      downloads: 50605,
      id: 'clawhub:kd74n44stcpmhfvqe02yj7r6ms808nvm',
      install: { kind: 'clawhub', reference: 'awspace/pdf', sourceUrl: null },
      links: { canonical: '/awspace/skills/pdf', source: null },
      metrics: { bookmarks: 0, rolling60DayInstalls: 28, updatedAt: 1789594554485 },
      ownerHandle: 'awspace',
      slug: 'pdf',
      summary: 'Comprehensive PDF manipulation toolkit.',
      version: null,
      native: {
        ownerHandle: 'awspace',
        skill: {
          displayName: 'Pdf',
          slug: 'pdf',
          // A version id, not a semver: it must NOT become `version`.
          tags: { latest: 'k97cz981kj0veqx1m79dd5sy4n809j57' },
          stats: { comments: 1, downloads: 50605, installs: 1490, stars: 66, versions: 1 },
          summary: 'Comprehensive PDF manipulation toolkit.',
          updatedAt: 1789594554485,
        },
        version: null,
      },
    },
    {
      canonicalUrl: '/acme/skills/pdf-tools',
      displayName: 'pdf-tools',
      downloads: 999999,
      install: { kind: 'clawhub', reference: 'acme/pdf-tools' },
      ownerHandle: 'acme',
      slug: 'pdf-tools',
      summary: 'Extra PDF helpers.',
      native: { skill: { stats: { downloads: 999999, stars: 3 } } },
    },
    {
      canonicalUrl: '/acme/skills/notpdf',
      displayName: 'Not A Pdf Thing',
      downloads: 500000,
      install: { kind: 'clawhub', reference: 'acme/notpdf' },
      ownerHandle: 'acme',
      slug: 'notpdf',
      summary: 'Unrelated.',
      native: { skill: { stats: { downloads: 500000, stars: 1 } } },
    },
    {
      canonicalUrl: '/sdk-team/skills/alibabacloud-quickbi-smartq',
      displayName: 'alibabacloud-quickbi-smartq',
      downloads: 1141,
      install: { kind: 'clawhub', reference: 'sdk-team/alibabacloud-quickbi-smartq' },
      ownerHandle: 'sdk-team',
      slug: 'alibabacloud-quickbi-smartq',
      summary: 'Data analysis; parses PDF/Word/Excel.',
      native: { skill: { stats: { downloads: 1141, stars: 0 } } },
    },
  ],
}

/** The ClawHub browse payload, as `/api/v1/skills` really answers it. */
const CLAWHUB_LIST = {
  items: [
    {
      ownerHandle: 'hmahmadcs',
      slug: 'markdown-link-auditor',
      displayName: 'markdown-link-auditor',
      summary: 'Audit Markdown for link issues.',
      tags: { latest: '1.0.0' },
      stats: { comments: 0, downloads: 12, installs: 0, stars: 2, versions: 1 },
      createdAt: 1792167277847,
      updatedAt: 1792167364873,
      latestVersion: { version: '1.0.0', createdAt: 1792167277847, changelog: '', license: 'MIT-0' },
    },
  ],
  nextCursor: null,
}

/** The GitHub tree, deliberately small: four skills and some non-skill files. */
const GITHUB_TREE = {
  sha: 'deadbeef',
  truncated: false,
  tree: [
    { path: 'README.md', type: 'blob', size: 10 },
    { path: 'skills/pdf/SKILL.md', type: 'blob', size: 8035 },
    { path: 'skills/pdf/reference.md', type: 'blob', size: 100 },
    { path: 'skills/pdf/scripts/fill.py', type: 'blob', size: 20 },
    { path: 'skills/docx/SKILL.md', type: 'blob', size: 700 },
    { path: 'skills/docx/ooxml.md', type: 'blob', size: 30 },
    { path: 'skills/pptx/SKILL.md', type: 'blob', size: 500 },
    { path: 'template/SKILL.md', type: 'blob', size: 400 },
    { path: 'skills', type: 'tree', size: 0 },
  ],
}

/** One valid `SKILL.md`, shaped exactly like the real one. */
const PDF_SKILL_MD = [
  '---',
  'name: pdf',
  'description: Use this skill whenever the user wants to do anything with PDF files.',
  'license: Proprietary. LICENSE.txt has complete terms',
  '---',
  '',
  '# PDF Processing Guide',
  '',
  'Read reference.md and scripts/fill.py.',
  '',
].join('\n')

/** A second valid header, for the GitHub index. */
const DOCX_SKILL_MD = '---\nname: docx\ndescription: Create and edit Word documents.\n---\n\n# docx\n'
/** A third, to prove the index is not hard-coded to one skill. */
const PPTX_SKILL_MD = '---\nname: pptx\ndescription: Build slide decks.\n---\n\n# pptx\n'
/** The template skill, which is discovered but never matches a search. */
const TEMPLATE_SKILL_MD = '---\nname: template\ndescription: A skeleton for a new skill.\n---\n\n# template\n'

/** The ClawHub detail envelope for `awspace/pdf`. */
const CLAWHUB_DETAIL = {
  skill: { slug: 'pdf', displayName: 'Pdf', summary: 'Comprehensive PDF manipulation toolkit.', tags: { latest: '0.1.0' }, stats: { downloads: 50605, stars: 66 } },
  latestVersion: { version: '0.1.0', createdAt: 1769847855729, changelog: '- Initial release.', license: null },
  metadata: null,
  owner: { handle: 'awspace', displayName: 'awspace', image: null },
  moderation: null,
}

/** The ClawHub version envelope, whose `files` list drives §3.5's `files`. */
const CLAWHUB_VERSION = {
  skill: { slug: 'pdf', displayName: 'Pdf' },
  version: {
    version: '0.1.0',
    createdAt: 1769847855729,
    license: null,
    files: [
      { path: 'SKILL.md', size: 7068, sha256: 'a'.repeat(64), contentType: 'text/plain' },
      { path: 'skill-card.md', size: 2018, sha256: 'b'.repeat(64), contentType: 'text/markdown' },
    ],
  },
}

/** One archive that installs cleanly, with a nested sibling directory. */
const GOOD_PACKAGE = [
  { path: 'SKILL.md', data: PDF_SKILL_MD },
  { path: 'reference.md', data: '# reference\n' },
  { path: 'scripts/fill.py', data: 'print("fill")\n' },
]

/** A second package with the same `name`, to exercise `force`. */
const REPLACEMENT_PACKAGE = [
  { path: 'SKILL.md', data: '---\nname: pdf\ndescription: Replaced.\n---\n\n# replaced\n' },
]

// --------------------------------------------------------------- temp roots

/** One base directory for the whole suite, deleted on the last line. */
const BASE = await mkdtemp(join(tmpdir(), 'dsh-skill-sources-'))

/**
 * A fresh, empty root inside the suite's temp directory.
 * @param name - the sub-directory name.
 * @returns the absolute path.
 */
async function freshRoot(name) {
  const root = join(BASE, name)
  await mkdir(root, { recursive: true })
  return root
}

/** @returns the sorted entry names of a directory, or [] when it is missing. */
async function entriesOf(dir) {
  try {
    return (await readdir(dir)).sort()
  } catch (error) {
    return []
  }
}

/** @returns whether a path exists. */
async function exists(target) {
  try {
    await stat(target)
    return true
  } catch (error) {
    return false
  }
}

// ------------------------------------------------------------------ the seams

/**
 * A `fetch`-shaped stub that records every request.
 * @param handler - `(url, init) => { status, body, headers } | Error`.
 * @returns the stub, carrying its `calls` array.
 */
function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({
      url: String(url),
      headers: Object.assign({}, init && init.headers),
      signal: init ? init.signal : undefined,
      redirect: init ? init.redirect : undefined,
    })
    // `await` is what lets a handler return a promise that never settles, which
    // is how the "a hung request must be abandoned at its budget" checks work.
    const answer = await handler(String(url), init)
    if (answer instanceof Error) throw answer
    if (answer === null || answer === undefined) throw new Error('offline: ' + url)
    const body = answer.body === undefined ? '' : answer.body
    return {
      status: answer.status === undefined ? 200 : answer.status,
      ok: (answer.status === undefined ? 200 : answer.status) < 300,
      headers: { get: (name) => headerValue(answer.headers, name) },
      text: async () => (Buffer.isBuffer(body) ? body.toString('utf8') : String(body)),
      json: async () => JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body)),
      arrayBuffer: async () => {
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      },
    }
  }
  impl.calls = calls
  return impl
}

/**
 * Build one scenario: a fake fetch, an injectable clock and a registry.
 * @param handler - the URL router.
 * @param extra - extra `createSkillSources` options.
 * @returns `{ calls, clock, fetchImpl, api, reset }`.
 */
function harness(handler, extra = {}) {
  let current = 1_700_000_000_000
  const clock = () => current
  clock.advance = (ms) => {
    current += ms
    return current
  }
  const fetchImpl = fakeFetch(handler)
  const notes = []
  const api = createSkillSources(Object.assign({
    fetch: fetchImpl,
    now: clock,
    logger: (message) => notes.push(message),
  }, extra))
  return { calls: fetchImpl.calls, clock: clock, fetchImpl: fetchImpl, api: api, notes: notes, reset: () => api.reset() }
}

/** One JSON reply. */
function json(value, etag) {
  return { status: 200, body: JSON.stringify(value), headers: etag === undefined ? {} : { etag: etag } }
}

/** A `304 Not Modified` reply, which never carries a body. */
function notModified(etag) {
  return { status: 304, body: '', headers: etag === undefined ? {} : { etag: etag } }
}

/** A plain-text reply. */
function text(value, etag) {
  return { status: 200, body: value, headers: etag === undefined ? {} : { etag: etag } }
}

/** An error reply with a body, as ClawHub sends its refusals. */
function failure(status, body) {
  return { status: status, body: body === undefined ? '' : body, headers: {} }
}

/** Read one header off a plain header object. */
function headerValue(headers, name) {
  if (headers === null || typeof headers !== 'object') return null
  const key = String(name).toLowerCase()
  for (const candidate of Object.keys(headers)) {
    if (candidate.toLowerCase() === key) return headers[candidate]
  }
  return null
}

/**
 * The full router both live sources answer through: the ClawHub endpoints, the
 * GitHub API and `raw.githubusercontent.com`, all keyed by exact URL.
 * @param overrides - a `(url) => answer | undefined` consulted first.
 * @returns a `(url) => answer` function.
 */
function liveRouter(overrides) {
  return (url) => {
    if (typeof overrides === 'function') {
      const custom = overrides(url)
      if (custom !== undefined) return custom
    }
    if (url === 'https://clawhub.ai/api/v1/skills?limit=1&sort=recommended') return json(CLAWHUB_LIST, 'PROBE1')
    if (url === 'https://api.github.com/repos/anthropics/skills') return json({ full_name: 'anthropics/skills' }, 'PROBE2')
    if (url.startsWith('https://clawhub.ai/api/v1/search?')) return json(CLAWHUB_SEARCH, 'SEARCH1')
    if (url.startsWith('https://clawhub.ai/api/v1/skills?limit=')) return json(CLAWHUB_LIST, 'LIST1')
    if (url === 'https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1') return json(GITHUB_TREE, 'TREE1')
    if (url === 'https://api.github.com/repos/anthropics/skills/contents/skills') {
      return json([
        { name: 'pdf', path: 'skills/pdf', type: 'dir' },
        { name: 'docx', path: 'skills/docx', type: 'dir' },
        { name: 'pptx', path: 'skills/pptx', type: 'dir' },
      ], 'CONTENTS1')
    }
    if (url === 'https://api.github.com/repos/anthropics/skills/contents/skills/pdf') {
      return json([
        { name: 'SKILL.md', path: 'skills/pdf/SKILL.md', type: 'file', size: 8035 },
        { name: 'reference.md', path: 'skills/pdf/reference.md', type: 'file', size: 100 },
        { name: 'scripts', path: 'skills/pdf/scripts', type: 'dir', size: 0 },
      ], 'CONTENTSPDF1')
    }
    if (url === 'https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md') return text(PDF_SKILL_MD, 'RAWPDF1')
    if (url === 'https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/reference.md') return text('# reference\n')
    if (url === 'https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/scripts/fill.py') return text('print("fill")\n')
    if (url === 'https://raw.githubusercontent.com/anthropics/skills/main/skills/docx/SKILL.md') return text(DOCX_SKILL_MD)
    if (url === 'https://raw.githubusercontent.com/anthropics/skills/main/skills/pptx/SKILL.md') return text(PPTX_SKILL_MD)
    if (url === 'https://raw.githubusercontent.com/anthropics/skills/main/template/SKILL.md') return text(TEMPLATE_SKILL_MD)
    if (url.startsWith('https://raw.githubusercontent.com/')) return failure(404, '404: Not Found')
    if (url.startsWith('https://clawhub.ai/api/v1/skills/pdf/versions/0.1.0')) return json(CLAWHUB_VERSION)
    if (url.startsWith('https://clawhub.ai/api/v1/skills/pdf/versions')) return json({ items: [{ version: '0.1.0' }] })
    if (url.startsWith('https://clawhub.ai/api/v1/skills/pdf/file?')) return text(PDF_SKILL_MD)
    if (url.startsWith('https://clawhub.ai/api/v1/skills/pdf')) return json(CLAWHUB_DETAIL)
    return null
  }
}

// ------------------------------------------------------------------- surface

{
  assert.equal(typeof createSkillSources, 'function', 'createSkillSources is exported')
  assert.equal(typeof readZipEntries, 'function', 'readZipEntries is exported')
  assert.equal(typeof rankResults, 'function', 'rankResults is exported')
  assert.equal(typeof validateSkillMd, 'function', 'validateSkillMd is exported')
  assert.equal(typeof parseFrontmatter, 'function', 'parseFrontmatter is exported')
  assert.equal(typeof isSafeEntryPath, 'function', 'isSafeEntryPath is exported')
  assert.equal(typeof safeEntryPath, 'function', 'safeEntryPath is exported')
  assert.equal(typeof splitSourceId, 'function', 'splitSourceId is exported')
  assert.equal(typeof normalizeSources, 'function', 'normalizeSources is exported')

  assert.deepEqual(DEFAULT_SOURCES.map((source) => source.id), ['clawhub', 'github'],
    'the two sources are declared in contract order')
  assert.deepEqual(Object.keys(DEFAULT_SOURCES[0]).sort(), ['docs', 'home', 'id', 'kind', 'label'],
    'a source definition carries exactly the four contract fields')
  assert.deepEqual(DEFAULT_SOURCES[0], {
    id: 'clawhub', label: 'ClawHub', kind: 'registry',
    home: 'https://clawhub.ai', docs: 'https://docs.openclaw.ai/clawhub/api',
  }, 'ClawHub is declared exactly as contract §3.3 spells it')
  assert.deepEqual(DEFAULT_SOURCES[1], {
    id: 'github', label: 'GitHub', kind: 'git',
    home: 'https://github.com/anthropics/skills', docs: null,
  }, 'GitHub is declared exactly as contract §3.3 spells it')

  const api = createSkillSources()
  assert.deepEqual(Object.keys(api).sort(), ['detail', 'install', 'reset', 'search', 'sources'],
    'the registry exposes exactly the five contract members')

  assert.deepEqual(normalizeSources('nope').map((source) => source.id), ['clawhub', 'github'],
    'a non-array sources option falls back to the defaults')
  assert.deepEqual(normalizeSources(['clawhub']).map((source) => source.id), ['clawhub'],
    'a string shorthand selects a built-in source')
  assert.equal(normalizeSources(['clawhub'])[0].label, 'ClawHub', 'the shorthand keeps the built-in labels')
  assert.deepEqual(normalizeSources([]).map((source) => source.id), ['clawhub', 'github'],
    'an empty list falls back to the defaults rather than disabling everything')
  console.log('  surface: the five members, the two built-in sources and the source-list normalisation')
}

// -------------------------------------------------------------- pure helpers

{
  assert.deepEqual(splitSourceId('clawhub:awspace/pdf'), { source: 'clawhub', ref: 'awspace/pdf' },
    'a source-qualified id splits on the first colon')
  assert.deepEqual(splitSourceId('awspace/pdf'), { source: null, ref: 'awspace/pdf' },
    'a bare reference has no source')
  assert.deepEqual(splitSourceId(''), { source: null, ref: null }, 'an empty id has neither half')
  assert.deepEqual(splitSourceId(null), { source: null, ref: null }, 'a non-string id has neither half')
  assert.deepEqual(splitOwnerRef('awspace/pdf'), { owner: 'awspace', slug: 'pdf' }, 'owner/slug splits')
  assert.deepEqual(splitOwnerRef('@awspace/pdf'), { owner: 'awspace', slug: 'pdf' }, 'a leading at-sign is dropped')
  assert.deepEqual(splitOwnerRef('pdf'), { owner: null, slug: 'pdf' }, 'a bare slug has no owner')

  assert.equal(isKebabName('pdf'), true, 'a single word is a legal skill name')
  assert.equal(isKebabName('pdf-tools'), true, 'hyphenated words are legal')
  assert.equal(isKebabName('a1-b2'), true, 'digits are legal')
  assert.equal(isKebabName('Pdf'), false, 'an upper-case letter is not legal')
  assert.equal(isKebabName('pdf_tools'), false, 'an underscore is not legal')
  assert.equal(isKebabName('-pdf'), false, 'a leading hyphen is not legal')
  assert.equal(isKebabName('pdf-'), false, 'a trailing hyphen is not legal')
  assert.equal(isKebabName('a--b'), false, 'a doubled hyphen is not legal')
  assert.equal(isKebabName(''), false, 'an empty name is not legal')
  assert.equal(isKebabName(null), false, 'a non-string name is not legal')

  const front = parseFrontmatter(PDF_SKILL_MD)
  assert.equal(front.present, true, 'a header opens with ---')
  assert.equal(front.name, 'pdf', 'name is read out of the header')
  assert.equal(front.description, 'Use this skill whenever the user wants to do anything with PDF files.',
    'description is read out of the header')
  assert.equal(front.values.license, 'Proprietary. LICENSE.txt has complete terms', 'other keys are kept')
  assert.ok(front.body.startsWith('\n# PDF Processing Guide'), 'the body is everything after the header')
  assert.equal(parseFrontmatter('# no header\n').present, false, 'a file without a header has no frontmatter')
  assert.equal(parseFrontmatter('---\nname: pdf\ndescription: x\n').present, false,
    'an unterminated header is not a header')
  assert.equal(parseFrontmatter(null).present, false, 'a non-string is not a header')
  assert.equal(parseFrontmatter('---\nname: "quoted"\ndescription: \'single\'\n---\n').name, 'quoted',
    'a double-quoted value loses its quotes')
  assert.equal(parseFrontmatter('---\nname: "quoted"\ndescription: \'single\'\n---\n').description, 'single',
    'a single-quoted value loses its quotes')
  assert.equal(parseFrontmatter('---\nname: a\ndescription: >\n  one\n  two\n---\n').description, 'one two',
    'a folded block scalar joins its lines with spaces')
  assert.equal(parseFrontmatter('---\nname: a\ndescription: |\n  one\n  two\n---\n').description, 'one\ntwo',
    'a literal block scalar keeps its newlines')

  assert.deepEqual(validateSkillMd(PDF_SKILL_MD), {
    ok: true, name: 'pdf', description: 'Use this skill whenever the user wants to do anything with PDF files.', reason: null,
  }, 'a good SKILL.md validates')
  assert.match(validateSkillMd('# nothing\n').reason, /frontmatter/, 'a headerless SKILL.md is refused with a reason')
  assert.match(validateSkillMd('---\nname: Pdf\ndescription: x\n---\n').reason, /kebab-case/,
    'a non-kebab name is refused with a reason')
  assert.match(validateSkillMd('---\nname: pdf\ndescription: "  "\n---\n').reason, /description/,
    'a missing description is refused with a reason')

  assert.equal(matchRank({ name: 'pdf', displayName: 'Pdf' }, 'pdf'), 0, 'an exact name is rank 0')
  assert.equal(matchRank({ name: 'pdf-tools', displayName: 'pdf-tools' }, 'pdf'), 1, 'a name prefix is rank 1')
  assert.equal(matchRank({ name: 'notpdf', displayName: 'Not A Pdf Thing' }, 'pdf'), 2, 'anything else is rank 2')
  assert.equal(matchRank({ name: 'docx', displayName: 'docx' }, ''), 0, 'with no query every row is rank 0')
  console.log('  helpers: id splitting, kebab names, frontmatter, validation and match ranks')
}

// ----------------------------------------------------------------- path safety

{
  assert.equal(isSafeEntryPath('SKILL.md'), true, 'a plain file name is safe')
  assert.equal(isSafeEntryPath('scripts/fill.py'), true, 'a nested relative path is safe')
  assert.equal(isSafeEntryPath('../evil.md'), false, 'a parent traversal is not safe')
  assert.equal(isSafeEntryPath('a/../../b'), false, 'a traversal deeper in the path is not safe')
  assert.equal(isSafeEntryPath('/etc/passwd'), false, 'an absolute path is not safe')
  assert.equal(isSafeEntryPath('C:/Windows/x'), false, 'a drive letter is not safe')
  assert.equal(isSafeEntryPath('a\\b'), false, 'a backslash is not safe')
  assert.equal(isSafeEntryPath('a:b'), false, 'a colon is not safe (NTFS alternate data stream)')
  assert.equal(isSafeEntryPath('a//b'), false, 'a doubled slash is not safe')
  assert.equal(isSafeEntryPath('./a'), false, 'a leading dot segment is not safe')
  assert.equal(isSafeEntryPath('dir/'), false, 'a directory entry is not a file path')
  assert.equal(isSafeEntryPath(''), false, 'an empty name is not safe')
  assert.equal(isSafeEntryPath(null), false, 'a non-string name is not safe')

  const root = join(BASE, 'safety-root')
  assert.equal(safeEntryPath(root, 'a/b.txt'), resolve(root, 'a', 'b.txt'), 'a safe entry resolves under the root')
  assert.throws(() => safeEntryPath(root, '../x'), /不安全/, 'an unsafe entry throws')
  assert.throws(() => safeEntryPath(root, 'C:/x'), /不安全/, 'an absolute entry throws')
  console.log('  path safety: traversal, absolute and Windows-hostile entries are all refused')
}

// ----------------------------------------------------------- readZipEntries

{
  const zip = makeZip(GOOD_PACKAGE)
  const entries = readZipEntries(zip)
  assert.deepEqual(entries.map((entry) => entry.path), ['SKILL.md', 'reference.md', 'scripts/fill.py'],
    'every archive entry is read, in archive order')
  assert.equal(entries[0].data.toString('utf8'), PDF_SKILL_MD, 'a deflated entry inflates to its bytes')
  assert.equal(entries[0].size, Buffer.byteLength(PDF_SKILL_MD), 'the entry size is the inflated size')

  const stored = readZipEntries(makeZip([{ path: 'SKILL.md', data: PDF_SKILL_MD, method: 0 }]))
  assert.equal(stored[0].data.toString('utf8'), PDF_SKILL_MD, 'a stored (method 0) entry is read too')

  const wrapped = stripArchiveRoot(readZipEntries(makeZip([
    { path: 'package/SKILL.md', data: PDF_SKILL_MD },
    { path: 'package/a.md', data: 'a' },
  ])))
  assert.deepEqual(wrapped.map((entry) => entry.path), ['SKILL.md', 'a.md'],
    'a shared package/ root is stripped')
  const flat = stripArchiveRoot(readZipEntries(makeZip(GOOD_PACKAGE)))
  assert.deepEqual(flat.map((entry) => entry.path), ['SKILL.md', 'reference.md', 'scripts/fill.py'],
    'an archive with root-level files is left alone')

  assert.throws(() => readZipEntries(Buffer.from('not a zip at all, not even close')),
    /不是 ZIP|不完整/, 'a non-archive is refused')
  assert.throws(() => readZipEntries(Buffer.alloc(0)), /不完整/, 'an empty body is refused')

  const tree = githubSkillDirs(GITHUB_TREE.tree)
  assert.deepEqual(tree.map((skill) => skill.dir), ['skills/docx', 'skills/pdf', 'skills/pptx', 'template'],
    'the tree groups into skill directories, sorted')
  assert.deepEqual(tree[1].files.map((file) => file.path).sort(),
    ['skills/pdf/SKILL.md', 'skills/pdf/reference.md', 'skills/pdf/scripts/fill.py'],
    'a skill carries every sibling file under its directory')
  assert.deepEqual(githubSkillDirs(null), [], 'a non-tree yields no skills')
  console.log('  zip and tree: deflated and stored entries, root stripping, and directory grouping')
}

// ------------------------------------------------------------------ ranking

{
  const rows = [
    row('clawhub:acme/notpdf', 'clawhub', 'notpdf', 'Not A Pdf Thing', { downloads: 500000 }),
    row('clawhub:awspace/pdf', 'clawhub', 'pdf', 'Pdf', { downloads: 50605 }),
    row('clawhub:acme/pdf-tools', 'clawhub', 'pdf-tools', 'pdf-tools', { downloads: 999999 }),
    row('github:skills/pdf', 'github', 'pdf', 'pdf', { downloads: null }),
    row('clawhub:sdk-team/quickbi', 'clawhub', 'alibabacloud-quickbi-smartq', 'quickbi', { downloads: 1141 }),
  ]
  const ranked = rankResults(rows, 'pdf', ['clawhub', 'github'])
  assert.deepEqual(ranked.map((item) => item.id), [
    'clawhub:awspace/pdf',
    'github:skills/pdf',
    'clawhub:acme/pdf-tools',
    'clawhub:acme/notpdf',
    'clawhub:sdk-team/quickbi',
  ], 'an exact name beats a prefix, a prefix beats everything else, then downloads decide')

  const popular = rankResults([
    row('a:one', 'clawhub', 'one', 'one', { downloads: 10, stars: 0, updatedAt: 5 }),
    row('a:two', 'clawhub', 'two', 'two', { downloads: 20, stars: 0, updatedAt: 1 }),
  ], '')
  assert.deepEqual(popular.map((item) => item.id), ['a:two', 'a:one'], 'with no query, downloads decide')

  const starred = rankResults([
    row('a:one', 'clawhub', 'one', 'one', { downloads: 10, stars: 0, updatedAt: 9 }),
    row('a:two', 'clawhub', 'two', 'two', { downloads: 10, stars: 7, updatedAt: 1 }),
  ], '')
  assert.deepEqual(starred.map((item) => item.id), ['a:two', 'a:one'], 'equal downloads fall through to stars')

  const fresh = rankResults([
    row('a:one', 'clawhub', 'one', 'one', { downloads: 10, stars: 1, updatedAt: 9 }),
    row('a:two', 'clawhub', 'two', 'two', { downloads: 10, stars: 1, updatedAt: 99 }),
  ], '')
  assert.deepEqual(fresh.map((item) => item.id), ['a:two', 'a:one'], 'equal stars fall through to recency')

  const mixed = rankResults([
    row('github:x', 'github', 'x', 'x', { downloads: null }),
    row('clawhub:y', 'clawhub', 'y', 'y', { downloads: null }),
  ], '', ['github', 'clawhub'])
  assert.deepEqual(mixed.map((item) => item.id), ['github:x', 'clawhub:y'],
    'a total tie falls through to the declared source order')
  const reversed = rankResults([
    row('github:x', 'github', 'x', 'x', { downloads: null }),
    row('clawhub:y', 'clawhub', 'y', 'y', { downloads: null }),
  ], '', ['clawhub', 'github'])
  assert.deepEqual(reversed.map((item) => item.id), ['clawhub:y', 'github:x'],
    'the source order really is the declaring order, not the id order')
  assert.deepEqual(rankResults(null, 'x'), [], 'a non-array is not rankable')
  console.log('  ranking: exact name, prefix, downloads, stars, recency, source order')
}

// -------------------------------------------------- normalisation edge cases

{
  const searchRow = clawhubRowFromSearch({
    slug: 'gifgrep',
    ownerHandle: 'steipete',
    displayName: 'GifGrep',
    summary: 'Find gifs.',
    version: '1.2.3',
    updatedAt: 1730000000000,
    downloads: 5,
    install: { kind: 'clawhub', reference: 'steipete/gifgrep' },
    native: { skill: { stats: { stars: 9 } } },
  })
  assert.deepEqual(Object.keys(searchRow).sort(), ROW_KEYS, 'a normalised search row has the §3.4 keys')
  assert.equal(searchRow.version, '1.2.3', 'a semver version is reported')
  assert.equal(searchRow.stars, 9, 'stars are read from native.skill.stats')
  assert.equal(searchRow.id, 'clawhub:steipete/gifgrep', 'the id is source-qualified from the install reference')
  assert.equal(searchRow.url, 'https://clawhub.ai/steipete/skills/gifgrep',
    'a row with no canonical URL gets a constructed one')
  assert.equal(clawhubRowFromSearch({ slug: 'x' }), null, 'a row with no owner is not a ClawHub row')
  assert.equal(clawhubRowFromSearch(null), null, 'a null element is not a row')

  const listRow = clawhubRowFromList({
    ownerHandle: 'steipete', slug: 'gifgrep', displayName: 'GifGrep', summary: 'Find gifs.',
    tags: { latest: '1.2.3' }, stats: { downloads: 7, stars: 1 }, updatedAt: 1730000000000,
  })
  assert.deepEqual(Object.keys(listRow).sort(), ROW_KEYS, 'a normalised list row has the §3.4 keys')
  assert.equal(listRow.version, '1.2.3', 'tags.latest is a semver on the listing endpoint')
  assert.equal(listRow.downloads, 7, 'downloads come from stats')
  assert.equal(clawhubRowFromList({}), null, 'a row with no slug is not a ClawHub row')

  const gitRow = githubRowFromEntry({ dir: 'skills/weird_name', name: 'weird_name', description: 'x' })
  assert.equal(gitRow.name, 'weird_name', 'a directory name that is not a legal skill name is still shown')
  const named = githubRowFromEntry({ dir: 'skills/pdf', name: 'pdf', description: 'd' })
  assert.equal(named.id, 'github:skills/pdf', 'the id is the repository path')
  assert.equal(githubRowFromEntry({}).name, '', 'an empty entry normalises without throwing')
  console.log('  normalisation: the ClawHub search/list and GitHub rows, including their edge cases')
}

// ----------------------------------------------------------- sources() probe

{
  const world = harness(liveRouter())
  const doc = await world.api.sources()
  assert.deepEqual(Object.keys(doc).sort(), ['generatedAt', 'sources'], '§3.3 has exactly two keys')
  assert.equal(doc.generatedAt, world.clock(), 'generatedAt is the injected clock')
  assert.deepEqual(doc.sources.map((source) => source.id), ['clawhub', 'github'], 'both sources are listed')
  for (const source of doc.sources) {
    assert.deepEqual(Object.keys(source).sort(), SOURCE_KEYS, 'a §3.3 source row has exactly the contract keys')
    assert.equal(source.reachable, true, source.id + ' is reachable')
    assert.equal(source.note, null, source.id + ' has no note when it is reachable')
    assert.equal(source.count, null, source.id + ' reports no count')
  }
  assert.equal(world.calls.length, 2, 'each source is probed with exactly one request')
  assert.equal(world.calls[0].url, 'https://clawhub.ai/api/v1/skills?limit=1&sort=recommended',
    'the ClawHub probe is the cheapest listing it has')
  assert.equal(world.calls[1].url, 'https://api.github.com/repos/anthropics/skills',
    'the GitHub probe is the repository document')

  const again = await world.api.sources()
  assert.equal(world.calls.length, 2, 'a second sources() inside the TTL fetches nothing')
  assert.deepEqual(again.sources, doc.sources, 'the memoised probe is the same document')

  world.clock.advance(600_000)
  await world.api.sources({})
  assert.equal(world.calls.length, 4, 'the probe memo expires with the TTL')
  assert.equal(world.calls[2].headers['if-none-match'], 'PROBE1', 'the expired ClawHub probe is conditional')
  assert.equal(world.calls[3].headers['if-none-match'], 'PROBE2', 'the expired GitHub probe is conditional')

  const down = harness(liveRouter((url) => (
    url === 'https://api.github.com/repos/anthropics/skills' ? failure(500, 'Server Error') : undefined
  )))
  const degraded = await down.api.sources()
  assert.equal(degraded.sources[0].reachable, true, 'one source failing leaves the other reachable')
  assert.equal(degraded.sources[1].reachable, false, 'the failing source is marked unreachable')
  assert.equal(degraded.sources[1].note, 'HTTP 500', 'the note carries the reason')
  assert.ok(down.notes.some((line) => line.indexOf('github') >= 0), 'the logger is told about the degradation')
  console.log('  sources: one cheap cached probe per source, a reason when one of them is down')
}

// ------------------------------------------- ClawHub search: shape and rank

{
  const world = harness(liveRouter())
  const doc = await world.api.search({ query: 'pdf' })
  assert.deepEqual(Object.keys(doc).sort(), SEARCH_KEYS, '§3.4 has exactly the contract keys')
  assert.equal(doc.query, 'pdf', 'the query is echoed, trimmed')
  assert.equal(doc.source, 'all', 'no source argument means every source')
  assert.equal(doc.searchedAt, world.clock(), 'searchedAt is the injected clock')
  assert.deepEqual(doc.failures, [], 'a healthy search has no failures')
  assert.equal(doc.truncated, false, 'a short list is not truncated')

  for (const item of doc.results) {
    assert.deepEqual(Object.keys(item).sort(), ROW_KEYS, 'a §3.4 row has exactly the contract keys')
    assert.deepEqual(Object.keys(item.install).sort(), ['kind', 'ref', 'url'], 'install has exactly three keys')
  }

  const clawhub = doc.results.filter((item) => item.source === 'clawhub')
  const pdf = clawhub.find((item) => item.id === 'clawhub:awspace/pdf')
  assert.ok(pdf, 'the ClawHub search row is normalised')
  assert.equal(pdf.name, 'pdf', 'name is the slug')
  assert.equal(pdf.displayName, 'Pdf', 'displayName is carried over')
  assert.equal(pdf.summary, 'Comprehensive PDF manipulation toolkit.', 'summary is carried over')
  assert.equal(pdf.owner, 'awspace', 'owner comes from ownerHandle')
  assert.equal(pdf.downloads, 50605, 'downloads come from the top level')
  assert.equal(pdf.stars, 66, 'stars come from native.skill.stats')
  assert.equal(pdf.updatedAt, 1789594554485, 'updatedAt comes from metrics')
  assert.equal(pdf.version, null, 'an opaque version id is NOT reported as a version')
  assert.equal(pdf.url, 'https://clawhub.ai/awspace/skills/pdf', 'the canonical URL is absolute')
  assert.equal(pdf.skillUrl, 'https://clawhub.ai/api/v1/skills/pdf/file?path=SKILL.md&ownerHandle=awspace',
    'skillUrl points at the raw SKILL.md')
  assert.deepEqual(pdf.install, { kind: 'clawhub', ref: 'awspace/pdf', url: null },
    'install mirrors the platform reference')

  const github = doc.results.filter((item) => item.source === 'github')
  assert.deepEqual(github.map((item) => item.id), ['github:skills/pdf'],
    'GitHub search filters the index by name/description and lists one match')
  const git = github[0]
  assert.equal(git.name, 'pdf', 'the GitHub name comes from the frontmatter')
  assert.equal(git.displayName, 'pdf', 'the GitHub displayName is the name')
  assert.equal(git.summary, 'Use this skill whenever the user wants to do anything with PDF files.',
    'the GitHub summary is the frontmatter description')
  assert.equal(git.owner, 'anthropics', 'the GitHub owner is the repository owner')
  assert.equal(git.version, null, 'a GitHub skill has no version')
  assert.equal(git.updatedAt, null, 'a GitHub skill has no timestamp')
  assert.equal(git.downloads, null, 'a GitHub skill has no download count')
  assert.equal(git.stars, null, 'a GitHub skill has no star count')
  assert.equal(git.url, 'https://github.com/anthropics/skills/tree/main/skills/pdf', 'the url is the tree page')
  assert.equal(git.skillUrl, 'https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md',
    'skillUrl is the raw SKILL.md')
  assert.deepEqual(git.install, { kind: 'git', ref: 'skills/pdf', url: null }, 'the git install reference is the path')

  assert.deepEqual(doc.results.map((item) => item.id), [
    'clawhub:awspace/pdf',
    'github:skills/pdf',
    'clawhub:acme/pdf-tools',
    'clawhub:acme/notpdf',
    'clawhub:sdk-team/alibabacloud-quickbi-smartq',
  ], 'the merged list is ranked exactly as documented')

  const urls = world.calls.map((call) => call.url)
  assert.ok(urls.includes('https://clawhub.ai/api/v1/search?q=pdf&limit=24'), 'the ClawHub search URL is exact')
  assert.ok(urls.includes('https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1'),
    'GitHub discovery is the one-shot tree')
  assert.ok(urls.includes('https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md'),
    'GitHub enrichment reads the raw SKILL.md')
  assert.ok(urls.includes('https://raw.githubusercontent.com/anthropics/skills/main/template/SKILL.md'),
    'the index is enriched as a whole, so a later query needs no new reads')
  console.log('  search: both sources fan out, normalise into the §3.4 row and merge in the documented order')
}

// ------------------------------------------------- limit, capping, truncation

{
  const world = harness(liveRouter())
  const limited = await world.api.search({ query: 'pdf', limit: 2 })
  assert.equal(limited.results.length, 2, 'limit caps the merged list')
  assert.equal(limited.truncated, true, 'a capped list reports itself truncated')
  assert.deepEqual(limited.results.map((item) => item.id), ['clawhub:awspace/pdf', 'github:skills/pdf'],
    'the cap keeps the top of the ranking')
  assert.ok(world.calls.some((call) => call.url === 'https://clawhub.ai/api/v1/search?q=pdf&limit=2'),
    'the per-source request carries the same limit')

  const huge = harness(liveRouter())
  await huge.api.search({ query: 'pdf', limit: 5000 })
  assert.ok(huge.calls.some((call) => call.url === 'https://clawhub.ai/api/v1/search?q=pdf&limit=100'),
    'an absurd limit is clamped to 100')

  const oneSource = harness(liveRouter())
  const single = await oneSource.api.search({ query: 'pdf', source: 'clawhub' })
  assert.equal(single.source, 'clawhub', 'a single source is echoed')
  assert.ok(single.results.every((item) => item.source === 'clawhub'), 'a single source returns only its own rows')
  assert.equal(oneSource.calls.some((call) => call.url.indexOf('api.github.com') >= 0), false,
    'a single source never touches another source')

  const unknown = harness(liveRouter())
  const nothing = await unknown.api.search({ query: 'pdf', source: 'nope' })
  assert.deepEqual(nothing.results, [], 'an unknown source yields no rows')
  assert.deepEqual(nothing.failures, [{ source: 'nope', message: '未知来源' }], 'an unknown source is a failure')
  assert.equal(nothing.source, 'nope', 'the requested source is echoed even when unknown')
  console.log('  limit: the merged list is capped, truncated is set, and an unknown source is a failure')
}

// ------------------------------------------------------- one source failing

{
  const world = harness(liveRouter((url) => {
    if (url.indexOf('api.github.com') >= 0) return failure(500, 'Server Error')
    return undefined
  }))
  const doc = await world.api.search({ query: 'pdf' })
  assert.equal(doc.results.filter((item) => item.source === 'clawhub').length, 4,
    'the ClawHub rows still arrive when GitHub fails')
  assert.deepEqual(doc.results.filter((item) => item.source === 'github'), [],
    'the failing source contributes no rows')
  assert.deepEqual(doc.failures, [{ source: 'github', message: 'HTTP 500' }], 'the failure is reported');

  const thrown = harness(liveRouter((url) => {
    if (url.indexOf('api.github.com') >= 0) return new Error('ECONNRESET')
    return undefined
  }))
  const broken = await thrown.api.search({ query: 'pdf' })
  assert.equal(broken.results.length, 4, 'a throwing source never empties the other one')
  assert.deepEqual(broken.failures, [{ source: 'github', message: 'ECONNRESET' }],
    'a thrown failure is reported as a message')

  const started = Date.now()
  const hung = harness(liveRouter((url) => {
    if (url.indexOf('api.github.com') >= 0) return new Promise(() => {})
    return undefined
  }), { timeoutMs: 25 })
  const timedOut = await hung.api.search({ query: 'pdf' })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 3000, 'a hung source is abandoned at its budget (' + elapsed + 'ms)')
  assert.equal(timedOut.results.length, 4, 'the other source still answers')
  assert.deepEqual(timedOut.failures, [{ source: 'github', message: 'timeout' }],
    'a hung source is reported as a timeout')
  assert.ok(timedOut.results.every((item) => item.source === 'clawhub'), 'only the live source is present')
  console.log('  failures: a 500, a throw and a hang each land in failures[] without losing the other source')
}

// ------------------------------------------------------- ETag and 304 reuse

{
  const world = harness(liveRouter(), { sources: ['clawhub'], ttlMs: 1 })

  const first = await world.api.search({ query: 'pdf' })
  assert.equal(first.results.length, 4, 'the first search reads the whole payload')
  assert.equal(world.calls.length, 1, 'the first search makes exactly one request')
  assert.equal(world.calls[0].headers['if-none-match'], undefined, 'the first request sends no ETag')

  let served = 0
  const conditional = harness((url) => {
    served += 1
    if (served === 1) return json(CLAWHUB_SEARCH, 'SEARCH1')
    return notModified('SEARCH1')
  }, { sources: ['clawhub'], ttlMs: 1 })

  await conditional.api.search({ query: 'pdf' })
  conditional.clock.advance(10)
  const second = await conditional.api.search({ query: 'pdf' })
  assert.equal(conditional.calls.length, 2, 'the expired memo asks the source again')
  assert.equal(conditional.calls[1].headers['if-none-match'], 'SEARCH1', 'the second request is conditional')
  assert.equal(second.results.length, 4, 'a 304 reuses the remembered body instead of parsing an empty one')
  assert.deepEqual(second.failures, [], 'a 304 is not a failure')
  assert.equal(second.results[0].id, 'clawhub:awspace/pdf', 'the reused body parses to the same rows')

  let online = true
  const offline = harness((url) => {
    if (!online) throw new Error('offline')
    return url.startsWith('https://clawhub.ai/api/v1/search?') ? json(CLAWHUB_SEARCH, 'SEARCH1') : undefined
  }, { sources: ['clawhub'], ttlMs: 1 })
  await offline.api.search({ query: 'pdf' })
  online = false
  offline.clock.advance(10)
  const remembered = await offline.api.search({ query: 'pdf' })
  assert.equal(remembered.results.length, 4, 'when the network dies, the remembered body still answers')
  assert.deepEqual(remembered.failures, [], 'a remembered body is a success, not a failure')

  const afterReset = harness((url) => (
    url.startsWith('https://clawhub.ai/api/v1/search?') ? json(CLAWHUB_SEARCH, 'SEARCH1') : undefined
  ), { sources: ['clawhub'], ttlMs: 1 })
  await afterReset.api.search({ query: 'pdf' })
  afterReset.clock.advance(10)
  afterReset.api.reset()
  await afterReset.api.search({ query: 'pdf' })
  assert.equal(afterReset.calls.length, 2, 'reset() drops the search memo')
  assert.equal(afterReset.calls[1].headers['if-none-match'], undefined, 'reset() also drops the ETags')
  console.log('  etag: a conditional request, a reused 304 body and a remembered body when the network is gone')
}

// ------------------------------------------------- ClawHub browse and detail

{
  const world = harness(liveRouter(), { sources: ['clawhub'] })
  const browsed = await world.api.search({ query: '' })
  assert.equal(browsed.query, '', 'an empty query is echoed')
  assert.equal(browsed.results.length, 1, 'the browse lists the catalogue')
  assert.ok(world.calls.some((call) => call.url === 'https://clawhub.ai/api/v1/skills?limit=24&sort=recommended'),
    'an empty query lists instead of searching')
  assert.equal(browsed.results[0].id, 'clawhub:hmahmadcs/markdown-link-auditor', 'the list item is normalised')
  assert.equal(browsed.results[0].version, '1.0.0', 'tags.latest is a semver here and is reported')

  const detail = await world.api.detail({ id: 'clawhub:awspace/pdf' })
  assert.deepEqual(Object.keys(detail).sort(), DETAIL_KEYS, '§3.5 has exactly the contract keys')
  assert.equal(detail.id, 'clawhub:awspace/pdf', 'the id is echoed back')
  assert.equal(detail.source, 'clawhub', 'the source is reported')
  assert.equal(detail.name, 'pdf', 'the name is the slug')
  assert.equal(detail.version, '0.1.0', 'the version is the latest semver')
  assert.equal(detail.summary, 'Comprehensive PDF manipulation toolkit.', 'the summary is carried over')
  assert.equal(detail.readme, null, 'ClawHub has no README artifact, and null says so')
  assert.deepEqual(detail.files, ['SKILL.md', 'skill-card.md'], 'the version file list supplies files')
  assert.equal(detail.skillMd, PDF_SKILL_MD, 'skillMd is the raw SKILL.md')
  assert.deepEqual(detail.install, { kind: 'clawhub', ref: 'awspace/pdf', url: null }, 'install is the reference')

  const urls = world.calls.map((call) => call.url)
  assert.ok(urls.includes('https://clawhub.ai/api/v1/skills/pdf?ownerHandle=awspace'), 'detail reads the slug endpoint')
  assert.ok(urls.includes('https://clawhub.ai/api/v1/skills/pdf/versions/0.1.0?ownerHandle=awspace'),
    'detail reads the exact version for its file list')
  assert.ok(urls.includes('https://clawhub.ai/api/v1/skills/pdf/file?path=SKILL.md&ownerHandle=awspace'),
    'detail reads the raw SKILL.md')

  const partial = harness((url) => {
    if (url.startsWith('https://clawhub.ai/api/v1/skills/pdf/versions/')) return failure(500, 'boom')
    if (url.startsWith('https://clawhub.ai/api/v1/skills/pdf/file?')) return failure(404, 'Not found')
    return liveRouter()(url)
  }, { sources: ['clawhub'] })
  const bare = await partial.api.detail({ id: 'clawhub:awspace/pdf' })
  assert.deepEqual(bare.files, [], 'an unreadable version file list is an empty list, not a throw')
  assert.equal(bare.skillMd, null, 'an unreadable SKILL.md is null, not a throw')
  assert.equal(bare.name, 'pdf', 'the detail itself still arrives')

  // A bare slug is a legitimate detail lookup — ClawHub resolves it and the
  // payload supplies the owner — but it can never be an install, because the
  // download route refuses an ambiguous slug with `409`.
  const bySlug = harness(liveRouter(), { sources: ['clawhub'] })
  const resolved = await bySlug.api.detail({ id: 'clawhub:pdf' })
  assert.equal(resolved.id, 'clawhub:awspace/pdf', 'a bare slug resolves to the owner-qualified id')
  assert.equal(resolved.install.ref, 'awspace/pdf', 'and to an owner-qualified install reference')
  const slugRoot = await freshRoot('detail-slug')
  await assert.rejects(() => bySlug.api.install({ id: 'clawhub:pdf', root: slugRoot }), /<owner>\/<slug>/,
    'installing a bare ClawHub slug is refused with the shape it needs')
  assert.deepEqual(await entriesOf(slugRoot), [], 'and writes nothing')

  const listed = harness(liveRouter(), { sources: ['clawhub'] })
  const noVersion = await listed.api.detail({ id: 'clawhub:awspace/pdf', version: '9.9.9' })
  assert.equal(noVersion.version, '9.9.9', 'a version shaped like semver is asked for by version')

  await assert.rejects(() => listed.api.detail({}), /来源|引用/, 'a detail with nothing to look up is refused')
  console.log('  detail: ClawHub browse, the §3.5 shape, and best-effort enrichment that never throws')
}

// ------------------------------------------------------- GitHub detail route

{
  const world = harness(liveRouter(), { sources: ['github'] })
  const detail = await world.api.detail({ source: 'github', ref: 'pdf' })
  assert.deepEqual(Object.keys(detail).sort(), DETAIL_KEYS, 'a GitHub detail has the §3.5 keys')
  assert.equal(detail.id, 'github:skills/pdf', 'a bare name resolves against the index')
  assert.equal(detail.source, 'github', 'the source is reported')
  assert.equal(detail.name, 'pdf', 'the name is the frontmatter name')
  assert.equal(detail.version, null, 'a GitHub skill has no version')
  assert.equal(detail.skillMd, PDF_SKILL_MD, 'skillMd is the raw SKILL.md')
  assert.deepEqual(detail.files, ['skills/pdf/SKILL.md', 'skills/pdf/reference.md', 'skills/pdf/scripts/fill.py'],
    'the tree supplies the file list')
  assert.equal(detail.readme, null, 'a missing README.md is null, not a throw')
  assert.deepEqual(detail.install, { kind: 'git', ref: 'skills/pdf', url: null }, 'the install reference is the path')

  const withReadme = harness((url) => (
    url === 'https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/README.md'
      ? text('# PDF skill\n')
      : liveRouter()(url)
  ), { sources: ['github'] })
  const readme = await withReadme.api.detail({ id: 'github:skills/pdf' })
  assert.equal(readme.readme, '# PDF skill\n', 'the skill directory README.md is the readme when it exists')

  const viaContents = harness((url) => (
    url === 'https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1'
      ? failure(500, 'Server Error')
      : liveRouter()(url)
  ), { sources: ['github'] })
  const fallback = await viaContents.api.search({ query: 'pdf' })
  assert.deepEqual(fallback.results.map((item) => item.id), ['github:skills/pdf'],
    'a failing tree falls back to listing contents/skills')
  assert.deepEqual(fallback.failures, [], 'the fallback route is a success, not a failure')
  assert.ok(viaContents.calls.some((call) => call.url === 'https://api.github.com/repos/anthropics/skills/contents/skills'),
    'the contents route really was tried')
  console.log('  github: the index, the README, and the contents fallback when the tree route fails')
}

// ---------------------------------------------------- install: the happy path

{
  const root = await freshRoot('install-happy')
  const world = harness((url) => (
    url.startsWith('https://clawhub.ai/api/v1/download?')
      ? { status: 200, body: makeZip(GOOD_PACKAGE), headers: { 'content-type': 'application/zip' } }
      : undefined
  ), { sources: ['clawhub'] })

  const expectedBytes = GOOD_PACKAGE.reduce((total, entry) => total + Buffer.byteLength(entry.data), 0)
  const done = await world.api.install({ id: 'clawhub:awspace/pdf', root: root, destination: 'user-dsh' })

  assert.equal(done.ok, true, 'a good install reports ok')
  assert.equal(done.name, 'pdf', 'the name comes from the frontmatter, not the slug')
  assert.equal(done.source, 'clawhub', 'the source is reported')
  assert.equal(done.ref, 'awspace/pdf', 'the reference is reported')
  assert.equal(done.root, resolve(root), 'the resolved root is reported')
  assert.equal(done.dir, join(resolve(root), 'pdf'), 'the directory is the name under the root')
  assert.equal(done.files, 3, 'every package file is counted')
  assert.equal(done.bytes, expectedBytes, 'the byte count is the sum of the written files')
  assert.deepEqual(done.paths, ['SKILL.md', 'reference.md', 'scripts/fill.py'], 'the written paths are listed')
  assert.equal(done.skillMd, PDF_SKILL_MD, 'the raw SKILL.md comes back for the caller to build the skill entry')
  assert.deepEqual(done.install, { kind: 'clawhub', ref: 'awspace/pdf', url: null }, 'install carries the reference')

  assert.equal(await readFile(join(root, 'pdf', 'SKILL.md'), 'utf8'), PDF_SKILL_MD, 'SKILL.md is written verbatim')
  assert.equal(await readFile(join(root, 'pdf', 'reference.md'), 'utf8'), '# reference\n', 'a sibling is written')
  assert.equal(await readFile(join(root, 'pdf', 'scripts', 'fill.py'), 'utf8'), 'print("fill")\n',
    'a sibling directory is created')
  assert.deepEqual(await entriesOf(root), ['pdf'], 'the staging directory is gone and only the skill remains')
  assert.equal(world.calls[0].url,
    'https://clawhub.ai/api/v1/download?slug=pdf&ownerHandle=awspace',
    'the verified ClawHub download route is the one used')

  const wrappedRoot = await freshRoot('install-wrapped')
  const wrapped = harness((url) => (
    url.startsWith('https://clawhub.ai/api/v1/download?')
      ? { status: 200, body: makeZip([{ path: 'package/SKILL.md', data: PDF_SKILL_MD }, { path: 'package/a.md', data: 'a\n' }]) }
      : undefined
  ), { sources: ['clawhub'] })
  const reRooted = await wrapped.api.install({ id: 'clawhub:awspace/pdf', root: wrappedRoot })
  assert.deepEqual(reRooted.paths, ['SKILL.md', 'a.md'], 'a wrapped package/ root is stripped before writing')
  assert.equal(reRooted.dir, join(resolve(wrappedRoot), 'pdf'), 'the skill lands in its own named directory')

  const githubRoot = await freshRoot('install-github')
  const github = harness(liveRouter(), { sources: ['github'] })
  const fromGit = await github.api.install({ id: 'github:skills/pdf', root: githubRoot })
  assert.equal(fromGit.files, 3, 'a GitHub install writes SKILL.md and its siblings')
  assert.deepEqual(fromGit.paths, ['SKILL.md', 'reference.md', 'scripts/fill.py'], 'the paths are relative to the skill')
  assert.equal(await readFile(join(githubRoot, 'pdf', 'reference.md'), 'utf8'), '# reference\n', 'a sibling is written')
  assert.deepEqual(fromGit.install, { kind: 'git', ref: 'skills/pdf', url: null }, 'the git reference is carried')
  console.log('  install: a ClawHub zip and a GitHub directory both land under <root>/<name>')
}

// ------------------------------------------------- install: the SKILL.md gate

{
  const cases = [
    {
      label: 'no SKILL.md at all',
      package: [{ path: 'README.md', data: 'nothing here' }],
      reason: /没有 SKILL\.md/,
    },
    {
      label: 'a SKILL.md without frontmatter',
      package: [{ path: 'SKILL.md', data: '# just a body\n' }],
      reason: /不合格/,
    },
    {
      label: 'a non-kebab name',
      package: [{ path: 'SKILL.md', data: '---\nname: Pdf Tools\ndescription: x\n---\n' }],
      reason: /kebab-case/,
    },
    {
      label: 'a name with an underscore',
      package: [{ path: 'SKILL.md', data: '---\nname: pdf_tools\ndescription: x\n---\n' }],
      reason: /kebab-case/,
    },
    {
      label: 'no description',
      package: [{ path: 'SKILL.md', data: '---\nname: pdf\n---\n' }],
      reason: /description/,
    },
  ]
  for (const item of cases) {
    const root = await freshRoot('gate-' + cases.indexOf(item))
    const world = harness((url) => (
      url.startsWith('https://clawhub.ai/api/v1/download?')
        ? { status: 200, body: makeZip(item.package) }
        : undefined
    ), { sources: ['clawhub'] })
    await assert.rejects(() => world.api.install({ id: 'clawhub:awspace/pdf', root: root }), item.reason,
      item.label + ' is refused with a reason')
    assert.deepEqual(await entriesOf(root), [], item.label + ' leaves the root untouched')
  }
  console.log('  install gate: a missing, headerless, misnamed or unexplained SKILL.md is refused and writes nothing')
}

// ------------------------------------------------- install: collision + force

{
  const root = await freshRoot('install-collision')
  let bytes = makeZip(GOOD_PACKAGE)
  const world = harness((url) => (
    url.startsWith('https://clawhub.ai/api/v1/download?') ? { status: 200, body: bytes } : undefined
  ), { sources: ['clawhub'] })

  await world.api.install({ id: 'clawhub:awspace/pdf', root: root })
  assert.equal(await readFile(join(root, 'pdf', 'SKILL.md'), 'utf8'), PDF_SKILL_MD, 'the first install lands')

  bytes = makeZip(REPLACEMENT_PACKAGE)
  await assert.rejects(() => world.api.install({ id: 'clawhub:awspace/pdf', root: root }), /同名/,
    'a second install without force is refused')
  assert.equal(await readFile(join(root, 'pdf', 'SKILL.md'), 'utf8'), PDF_SKILL_MD,
    'the refused install left the original file alone')
  assert.equal(await exists(join(root, 'pdf', 'reference.md')), true, 'and left its siblings alone')
  assert.deepEqual(await entriesOf(root), ['pdf'], 'and left no staging directory behind')

  const forced = await world.api.install({ id: 'clawhub:awspace/pdf', root: root, force: true })
  assert.equal(forced.files, 1, 'a forced install writes the replacement')
  assert.equal(await readFile(join(root, 'pdf', 'SKILL.md'), 'utf8'), REPLACEMENT_PACKAGE[0].data,
    'the replacement really replaced the file')
  assert.deepEqual(await entriesOf(root), ['pdf'], 'the swap leaves no staging directory or backup behind')
  console.log('  install: a name collision is refused without force and swapped atomically with it')
}

// ------------------------------------------------------- install: path safety

{
  const hostile = [
    { path: 'SKILL.md', data: PDF_SKILL_MD },
    { path: '../escaped.md', data: 'pwned' },
  ]
  const absolute = [
    { path: 'SKILL.md', data: PDF_SKILL_MD },
    { path: '/etc/escaped.md', data: 'pwned' },
  ]
  const drive = [
    { path: 'SKILL.md', data: PDF_SKILL_MD },
    { path: 'C:/escaped.md', data: 'pwned' },
  ]
  const stream = [
    { path: 'SKILL.md', data: PDF_SKILL_MD },
    { path: 'a.txt:stream', data: 'pwned' },
  ]

  const cases = [
    { label: 'a ../ entry', package: hostile, reason: /不安全/ },
    { label: 'an absolute entry', package: absolute, reason: /不安全/ },
    { label: 'a drive-letter entry', package: drive, reason: /不安全/ },
    { label: 'an alternate-data-stream entry', package: stream, reason: /不安全/ },
  ]
  for (const item of cases) {
    const root = await freshRoot('safety-' + cases.indexOf(item))
    const world = harness((url) => (
      url.startsWith('https://clawhub.ai/api/v1/download?') ? { status: 200, body: makeZip(item.package) } : undefined
    ), { sources: ['clawhub'] })
    await assert.rejects(() => world.api.install({ id: 'clawhub:awspace/pdf', root: root }), item.reason,
      item.label + ' is refused')
    assert.deepEqual(await entriesOf(root), [], item.label + ' writes nothing into the root')
    assert.equal(await exists(join(root, 'escaped.md')), false,
      item.label + ' does not escape into the root through a parent traversal')
    assert.equal(await exists(join(BASE, 'escaped.md')), false,
      item.label + ' does not escape above the root either')
  }

  // A file where a directory is needed: the archive names `a` as a file and
  // `a/b.md` as a file inside it, which cannot both be true.
  const layered = await freshRoot('safety-layered')
  const layeredWorld = harness((url) => (
    url.startsWith('https://clawhub.ai/api/v1/download?')
      ? { status: 200, body: makeZip([{ path: 'SKILL.md', data: PDF_SKILL_MD }, { path: 'a', data: 'file' }, { path: 'a/b.md', data: 'nested' }]) }
      : undefined
  ), { sources: ['clawhub'] })
  await assert.rejects(() => layeredWorld.api.install({ id: 'clawhub:awspace/pdf', root: layered }), /目录/,
    'an entry that needs a file to be a directory is refused')
  assert.deepEqual(await entriesOf(layered), [], 'and the staging directory is cleaned up')

  // A file where the skill directory belongs, and — where the platform allows
  // one — a symlink. Writing through either would put the package somewhere the
  // caller never named, so neither may ever be overwritten, even with `force`.
  const occupied = await freshRoot('safety-occupied')
  await writeFile(join(occupied, 'pdf'), 'not a directory\n')
  const occupiedWorld = harness((url) => (
    url.startsWith('https://clawhub.ai/api/v1/download?') ? { status: 200, body: makeZip(GOOD_PACKAGE) } : undefined
  ), { sources: ['clawhub'] })
  await assert.rejects(() => occupiedWorld.api.install({ id: 'clawhub:awspace/pdf', root: occupied, force: true }),
    /不是一个目录/, 'a file where the skill directory belongs is refused even with force')
  assert.equal(await readFile(join(occupied, 'pdf'), 'utf8'), 'not a directory\n', 'and the file is left alone')
  assert.deepEqual(await entriesOf(occupied), ['pdf'], 'and no staging directory is left behind')

  const trapped = await freshRoot('safety-symlink')
  const outside = join(BASE, 'elsewhere')
  await mkdir(outside, { recursive: true })
  const link = join(trapped, 'pdf')
  try {
    await symlink(outside, link, 'junction')
  } catch (error) {
    // A platform that refuses the link entirely is the safe outcome already.
  }
  let linked = false
  try {
    linked = (await lstat(link)).isSymbolicLink()
  } catch (error) {
    linked = false
  }
  if (linked) {
    const trapWorld = harness((url) => (
      url.startsWith('https://clawhub.ai/api/v1/download?') ? { status: 200, body: makeZip(GOOD_PACKAGE) } : undefined
    ), { sources: ['clawhub'] })
    await assert.rejects(() => trapWorld.api.install({ id: 'clawhub:awspace/pdf', root: trapped, force: true }),
      /不是一个目录/, 'a symlinked skill directory is refused')
    assert.deepEqual(await entriesOf(outside), [], 'nothing is written through the symlink')
  } else {
    // Windows needs developer mode (or admin) for a real symlink, and libuv
    // silently degrades a junction request to a plain directory, so the trap
    // cannot be built here. The file case above covers the same refusal.
    assert.ok(true, 'this platform will not create a real symlink; the file case covers the refusal')
  }
  // A Windows junction can outlive a recursive delete of its parent, so it is
  // taken out here rather than left to break the suite's own cleanup.
  await rm(link, { recursive: true, force: true }).catch(() => {})
  console.log('  install safety: traversal, absolute, drive-letter, ADS and occupied targets are all refused')
}

// --------------------------------------------- install: a failed download

{
  const root = await freshRoot('install-failure')
  let bytes = makeZip(GOOD_PACKAGE)
  let fail = false
  const world = harness((url) => {
    if (!url.startsWith('https://clawhub.ai/api/v1/download?')) return undefined
    return fail ? failure(500, 'Server Error') : { status: 200, body: bytes }
  }, { sources: ['clawhub'] })

  await world.api.install({ id: 'clawhub:awspace/pdf', root: root })
  fail = true
  await assert.rejects(() => world.api.install({ id: 'clawhub:awspace/pdf', root: root, force: true }),
    /下载失败/, 'a failed download throws')
  assert.equal(await readFile(join(root, 'pdf', 'SKILL.md'), 'utf8'), PDF_SKILL_MD,
    'the failed install left the existing skill untouched')
  assert.deepEqual(await entriesOf(root), ['pdf'], 'and left no staging directory behind')

  const empty = await freshRoot('install-failure-fresh')
  const broken = harness((url) => (
    url.startsWith('https://clawhub.ai/api/v1/download?') ? failure(503, 'nope') : undefined
  ), { sources: ['clawhub'] })
  await assert.rejects(() => broken.api.install({ id: 'clawhub:awspace/pdf', root: empty }), /下载失败/,
    'a download that never answered throws')
  assert.deepEqual(await entriesOf(empty), [], 'a failed download leaves a fresh root empty')

  const garbage = await freshRoot('install-garbage')
  const notZip = harness((url) => (
    url.startsWith('https://clawhub.ai/api/v1/download?') ? { status: 200, body: 'this is not a zip' } : undefined
  ), { sources: ['clawhub'] })
  await assert.rejects(() => notZip.api.install({ id: 'clawhub:awspace/pdf', root: garbage }), /不是 ZIP/,
    'a body that is not an archive is refused')
  assert.deepEqual(await entriesOf(garbage), [], 'and writes nothing')

  const handoff = await freshRoot('install-handoff')
  const githubBacked = harness((url) => (
    url.startsWith('https://clawhub.ai/api/v1/download?')
      ? json({ sourceRef: 'public-github', repo: 'anthropics/skills', path: 'skills/pdf' })
      : undefined
  ), { sources: ['clawhub'] })
  await assert.rejects(() => githubBacked.api.install({ id: 'clawhub:awspace/pdf', root: handoff }), /GitHub/,
    'a GitHub-backed ClawHub skill says so instead of failing obscurely')
  assert.deepEqual(await entriesOf(handoff), [], 'and writes nothing')

  const noRoot = harness(liveRouter(), { sources: ['clawhub'] })
  await assert.rejects(() => noRoot.api.install({ id: 'clawhub:awspace/pdf' }), /root/, 'a missing root is refused')
  await assert.rejects(() => noRoot.api.install({ id: 'clawhub:awspace/pdf', root: 'relative/path' }), /绝对路径/,
    'a relative root is refused rather than resolved against the process cwd')
  await assert.rejects(() => noRoot.api.install({ root: join(BASE, 'nowhere') }), /来源|引用/,
    'an install with nothing to install is refused')
  await assert.rejects(() => noRoot.api.install({ id: 'nope:whatever', root: join(BASE, 'nowhere') }), /不支持的来源/,
    'an unknown source is refused')
  console.log('  install failure: every failed download leaves the root exactly as it was')
}

// -------------------------------------------------------------------- reset

{
  const world = harness(liveRouter())
  await world.api.sources()
  assert.equal(world.calls.length, 2, 'the first sources() probes both sources')
  await world.api.sources()
  assert.equal(world.calls.length, 2, 'the second is a memo hit')
  world.api.reset()
  await world.api.sources()
  assert.equal(world.calls.length, 4, 'reset() drops the probe memo')
  assert.equal(world.calls[2].headers['if-none-match'], undefined, 'reset() drops the ETags too')

  const search = harness(liveRouter())
  await search.api.search({ query: 'pdf' })
  const afterFirst = search.calls.length
  await search.api.search({ query: 'pdf' })
  assert.equal(search.calls.length, afterFirst, 'a repeated search is a memo hit')
  search.api.reset()
  await search.api.search({ query: 'pdf' })
  assert.ok(search.calls.length > afterFirst, 'reset() forces the search to ask again')
  console.log('  reset: the ETags, the remembered bodies and every built answer are dropped')
}

// ------------------------------------------------------- degraded, never throw

{
  const offline = harness(() => new Error('offline'))
  const doc = await offline.api.search({ query: 'pdf' })
  assert.deepEqual(Object.keys(doc).sort(), SEARCH_KEYS, 'an offline search still has every contract key')
  assert.deepEqual(doc.results, [], 'an offline search has no rows')
  assert.deepEqual(doc.failures, [
    { source: 'clawhub', message: 'offline' },
    { source: 'github', message: 'offline' },
  ], 'each failing source is named with the transport\'s own words')

  const probed = await offline.api.sources()
  assert.equal(probed.sources.length, 2, 'both sources are still listed')
  assert.ok(probed.sources.every((source) => source.reachable === false), 'both are unreachable')
  assert.ok(probed.sources.every((source) => source.note === 'offline'), 'and each says why')

  const detail = await offline.api.detail({ id: 'github:skills/pdf' })
  assert.deepEqual(Object.keys(detail).sort(), DETAIL_KEYS, 'an offline detail still has every contract key')
  assert.equal(detail.skillMd, null, 'an offline detail has no SKILL.md')
  assert.deepEqual(detail.files, [], 'an offline detail has no file list')

  const detachedApi = createSkillSources({ fetch: null })
  assert.deepEqual(Object.keys(detachedApi).sort(), ['detail', 'install', 'reset', 'search', 'sources'],
    'an explicit null fetch still builds a registry')
  const detachedDoc = await detachedApi.search({ query: 'pdf' })
  assert.deepEqual(detachedDoc.results, [], 'a registry with no fetch returns an empty list')
  assert.deepEqual(detachedDoc.failures, [
    { source: 'clawhub', message: 'no-fetch' },
    { source: 'github', message: 'no-fetch' },
  ], 'a registry with no fetch says so rather than reaching for the global one')
  assert.deepEqual((await detachedApi.sources()).sources.map((source) => source.note), ['no-fetch', 'no-fetch'],
    'the probe reports the same reason')

  const silly = createSkillSources({ fetch: 'nope', sources: 42, ttlMs: -1, timeoutMs: 'soon' })
  assert.deepEqual(Object.keys(silly).sort(), ['detail', 'install', 'reset', 'search', 'sources'],
    'a nonsense option bag still builds a registry')
  const fromNull = await silly.search(null)
  const fromUndefined = await silly.search(undefined)
  assert.deepEqual(fromNull.results, fromUndefined.results, 'a null and an undefined request behave the same')
  assert.deepEqual(fromNull.failures, fromUndefined.failures, 'and fail the same way')
  assert.deepEqual(fromNull.results, [], 'a nonsense option bag reaches no network at all')

  const started = Date.now()
  const hung = harness(() => new Promise(() => {}), { timeoutMs: 25 })
  const hungDoc = await hung.api.search({ query: 'pdf' })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 3000, 'a totally hung network returns promptly (' + elapsed + 'ms)')
  assert.deepEqual(hungDoc.results, [], 'and yields no rows')
  assert.deepEqual(hungDoc.failures, [
    { source: 'clawhub', message: 'timeout' },
    { source: 'github', message: 'timeout' },
  ], 'a request that never settles is reported as a timeout')

  const hostile = {}
  Object.defineProperty(hostile, 'query', { enumerable: true, get() { throw new Error('hostile query') } })
  const survived = await offline.api.search(hostile)
  assert.deepEqual(survived.results, [], 'a request bag whose getter throws still resolves')
  assert.equal(survived.query, '', 'and reads back as an empty query')
  console.log('  degraded: offline, fetch-less, nonsense, hung and hostile requests all resolve to a shape')
}

// ------------------------------------------------------------------ helpers

/**
 * Build a real ZIP archive, deflated (method 8) unless an entry says otherwise.
 * Only the fields `readZipEntries` reads are filled in; the CRC is left zero
 * because nothing in this module verifies it.
 * @param entries - `[{ path, data, method? }]`.
 * @returns the archive bytes.
 */
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const raw = Buffer.from(entry.data, 'utf8')
    const method = entry.method === 0 ? 0 : 8
    const payload = method === 0 ? raw : deflateRawSync(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + payload.length
  }
  const localPart = Buffer.concat(locals)
  const centralPart = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralPart.length, 12)
  eocd.writeUInt32LE(localPart.length, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([localPart, centralPart, eocd])
}

/**
 * One §3.4 row, for the ranking checks.
 * @param id - the row id.
 * @param source - the source id.
 * @param name - the canonical name.
 * @param displayName - the display name.
 * @param extra - `downloads`, `stars`, `updatedAt`.
 * @returns the row.
 */
function row(id, source, name, displayName, extra = {}) {
  return {
    id: id,
    source: source,
    name: name,
    displayName: displayName,
    summary: '',
    owner: '',
    version: null,
    updatedAt: extra.updatedAt === undefined ? null : extra.updatedAt,
    downloads: extra.downloads === undefined ? null : extra.downloads,
    stars: extra.stars === undefined ? null : extra.stars,
    url: '',
    skillUrl: null,
    install: { kind: 'clawhub', ref: name, url: null },
  }
}

await rm(BASE, { recursive: true, force: true })
console.log('skill-sources: all assertions passed')
