/**
 * dsh-homepage — host-side Skill source registry.
 *
 * The Discover page of the skill card asks one question — "which external
 * Skills exist, and can I install this one?" — and this module is the only
 * thing that answers it. It owns two sources, normalises both into one row
 * shape, and installs a package into a writable local root.
 *
 * ## What was verified against the live APIs (2026-10-17)
 *
 * Every URL below was probed with plain `fetch` (Node 24; `HTTP_PROXY` is
 * honoured by Node's own fetch, so no undici and no hand-rolled tunnel is
 * needed). The exact probe evidence:
 *
 * ClawHub (`https://clawhub.ai`), all against `awspace/pdf`:
 *
 *  - `GET /api/v1/search?q=pdf` → `200` JSON `{ results: [...] }`; each result
 *    carries `slug`, `ownerHandle`, `displayName`, `summary`, `downloads`,
 *    `canonicalUrl`, `metrics.updatedAt`, `native.skill.stats.stars` and
 *    `install.reference`. VERIFIED.
 *  - `GET /api/v1/skills?limit=N&sort=recommended` → `200` JSON
 *    `{ items: [...], nextCursor }`; each item carries `ownerHandle`, `slug`,
 *    `displayName`, `summary`, `tags.latest` (a semver here), and
 *    `stats.{downloads,installs,stars,comments,versions}`. VERIFIED, and
 *    re-verified across `limit=1..24`: the page really does honour the limit.
 *    An early probe during a live index rollover answered `limit=2` with an
 *    EMPTY `items` and a `nextCursor`, so a short page is never read as
 *    end-of-catalogue — this module simply takes the page it asked for.
 *  - `GET /api/v1/skills/<owner>/<slug>` → **404** ("Not found"). The routes
 *    are slug-only with an `ownerHandle` query parameter. VERIFIED — as the
 *    contract warned.
 *  - `GET /api/v1/skills/pdf?ownerHandle=awspace` → `200`, `{ skill, owner,
 *    latestVersion, metadata, moderation }`; `skill.tags.latest` is the semver
 *    `"0.1.0"` here. VERIFIED.
 *  - `GET /api/v1/skills/pdf/versions?ownerHandle=awspace` → `200`
 *    `{ items: [{ version, createdAt, changelog, changelogSource }] }`. VERIFIED.
 *  - `GET /api/v1/skills/pdf/versions/0.1.0?ownerHandle=awspace` → `200`,
 *    `version.files = [{ path, size, sha256, contentType }]`. VERIFIED.
 *  - `GET /api/v1/skills/pdf/file?path=SKILL.md&ownerHandle=awspace` → `200`
 *    `text/plain`, the raw SKILL.md. VERIFIED.
 *  - `GET /api/v1/skills/pdf/versions`, `/download`, `/archive`, `/files`,
 *    `/versions/1.0.0/download` → all **404** "Not found". VERIFIED (dead ends).
 *  - **THE DOWNLOAD ROUTE**: `GET /api/v1/download?slug=<slug>&ownerHandle=<owner>`
 *    → `200` `application/zip`, `content-disposition: attachment;
 *    filename="pdf-0.1.0.zip"`, 3767 bytes. VERIFIED by unzipping it: three
 *    entries — `SKILL.md` (7068 bytes, method 8/deflate), `skill-card.md`
 *    (2018 bytes) and `_meta.json` (122 bytes). `version` and `tag` are
 *    optional and both work (`&version=0.1.0`, `&tag=latest` → the same zip).
 *    The legacy `owner=` spelling also answers, but `ownerHandle` is the one
 *    the server itself suggests, so that is what this module sends. A bare
 *    `?slug=pdf` is **409 Ambiguous skill slug** ("Retry with ownerHandle"),
 *    which is why an owner-qualified ref is mandatory here. VERIFIED, and
 *    documented at `https://docs.openclaw.ai/clawhub/http-api` under
 *    `GET /api/v1/download`.
 *
 * GitHub (`anthropics/skills`, branch `main`):
 *
 *  - `GET https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1`
 *    → `200`, 541 entries, `truncated: false`, 20 of them `…/SKILL.md`
 *    (`skills/<name>/SKILL.md` ×19 plus `template/SKILL.md`). Sends an ETag
 *    (`W/"daafd42a…"`). VERIFIED — this is the one-shot discovery route.
 *  - `GET https://api.github.com/repos/anthropics/skills/contents/skills`
 *    → `200`, 19 directory entries with an ETag. VERIFIED — the fallback.
 *  - `GET …/contents/skills/pdf` → the per-file listing
 *    (`LICENSE.txt`, `SKILL.md`, `forms.md`, `reference.md`, `scripts/`).
 *    VERIFIED — used when the tree route did not answer.
 *  - `GET https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md`
 *    → `200` `text/plain` with its own ETag. VERIFIED.
 *  - The anonymous api.github.com quota on this host is genuinely small and
 *    shared (11–16 remaining when probed, and `lib/host/dsh.js` documents it
 *    as exhausted elsewhere), so every GitHub request is conditional on a
 *    remembered ETag and both bodies and parsed values are memoised. A `304`
 *    does not consume the quota.
 *
 * ## Shape and rules
 *
 *  - `createSkillSources(options)` never throws for discovery: `sources()`,
 *    `search()` and `detail()` always resolve to the contract shape, with a
 *    per-source `failures[]` entry or a `null` enrichment instead of a throw.
 *    `install()` is the single deliberate exception: contract §3.6 says a
 *    refusal (bad SKILL.md, name collision, unsafe entry, failed download) is
 *    a thrown, user-facing error, so it throws.
 *  - Every request is bounded by `timeoutMs` and carries an AbortSignal, so a
 *    hung host cannot hang the card.
 *  - `fetch` is injectable (default: the global), `sources` is injectable
 *    (default: `DEFAULT_SOURCES`), and `reset()` drops every cache.
 *  - Installation is transactional: the whole package is fetched and validated
 *    in memory, written into a hidden temp directory inside the target root,
 *    and only then renamed into place. A failure at any point leaves the target
 *    directory exactly as it was.
 *  - Path safety is mandatory: no archive entry may be absolute, carry `..`, a
 *    drive letter, a backslash or a `:` (NTFS alternate data stream), and no
 *    parent below the root may be a symlink. Anything else is refused.
 *  - No network call, no filesystem write and no timer runs at import time.
 *
 * @module dsh-homepage/host/skill-sources
 */
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/** How long one HTTP attempt may take. */
const DEFAULT_TIMEOUT_MS = 8000
/** How long a built answer (search page, index, reachability) is served from memory. */
const DEFAULT_TTL_MS = 300000
/** Contract default for the merged result list. */
const DEFAULT_LIMIT = 24
/** Nothing ever asks a source for more than this. */
const MAX_LIMIT = 100
/** What GitHub is told about the caller; the API refuses a request without one. */
const USER_AGENT = 'dsh-homepage'
/** What the sources are asked for, per content type. */
const JSON_ACCEPT = 'application/json'
const GITHUB_ACCEPT = 'application/vnd.github+json'
const TEXT_ACCEPT = 'text/plain, text/markdown;q=0.9, */*;q=0.8'
const ZIP_ACCEPT = 'application/zip, application/octet-stream;q=0.9, */*;q=0.8'

/** ClawHub's own site, registry and documentation. */
const CLAWHUB_HOME = 'https://clawhub.ai'
const CLAWHUB_DOCS = 'https://docs.openclaw.ai/clawhub/api'
/** The GitHub repository this source reads, and every URL derived from it. */
const GITHUB_OWNER = 'anthropics'
const GITHUB_REPO = 'skills'
const GITHUB_BRANCH = 'main'
const GITHUB_HOME = 'https://github.com/anthropics/skills'
const GITHUB_API = 'https://api.github.com/repos/anthropics/skills'
const GITHUB_RAW = 'https://raw.githubusercontent.com/anthropics/skills/main'
/** The directory inside the repository that holds the skills. */
const GITHUB_SKILL_DIR = 'skills'

/**
 * A skill name, exactly as the filesystem provider spells it (§1): lower-case
 * alphanumerics in hyphen-separated groups, with no leading, trailing or double
 * hyphen. This is the rule the install refuses to violate.
 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** A version string worth showing; ClawHub mixes semver and opaque version ids. */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/** How many GitHub `SKILL.md` files are read to build the searchable index. */
const GITHUB_MAX_ENRICH = 60
/** How many of those reads are in flight at once. */
const GITHUB_CONCURRENCY = 6
/** An index wider than this is not a skill repository any more. */
const GITHUB_MAX_SKILLS = 400

/** Caps that stop one hostile archive from becoming a disk-filling install. */
const MAX_PACKAGE_FILES = 200
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_PACKAGE_BYTES = 24 * 1024 * 1024
/** A single descriptor longer than this is not a path. */
const MAX_ENTRY_PATH = 400
/** The one directory name a skill may never be called. */
const TEMP_DIR_PREFIX = '.dsh-skill-install-'

/**
 * The sources this module knows how to talk to, in the order the contract
 * declares them. `id` is what a result row, an `id` prefix and a `source`
 * argument all use.
 */
export const DEFAULT_SOURCES = Object.freeze([
  Object.freeze({
    id: 'clawhub',
    label: 'ClawHub',
    kind: 'registry',
    home: CLAWHUB_HOME,
    docs: CLAWHUB_DOCS,
  }),
  Object.freeze({
    id: 'github',
    label: 'GitHub',
    kind: 'git',
    home: GITHUB_HOME,
    docs: null,
  }),
])

/** Every source id with a working implementation. */
const IMPLEMENTED = new Set(['clawhub', 'github'])

// -------------------------------------------------------------- source list

/**
 * Reduce an injected source list into the four fields a source needs, dropping
 * anything unusable. Accepts `'clawhub'` as a shorthand for the built-in
 * definition, so a caller can narrow the list without restating it.
 * @param value - the `sources` option, or anything else.
 * @returns an array of `{ id, label, kind, home, docs }`.
 */
export function normalizeSources(value) {
  if (!Array.isArray(value)) return DEFAULT_SOURCES.slice()
  const list = []
  const seen = new Set()
  for (const entry of value) {
    const raw = typeof entry === 'string' ? { id: entry } : entry
    if (raw === null || typeof raw !== 'object') continue
    const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : ''
    if (id === '' || seen.has(id)) continue
    const builtin = DEFAULT_SOURCES.find((source) => source.id === id) || null
    seen.add(id)
    list.push({
      id,
      label: nonEmptyString(raw.label) ? raw.label.trim() : builtin !== null ? builtin.label : id,
      kind: nonEmptyString(raw.kind) ? raw.kind.trim() : builtin !== null ? builtin.kind : 'registry',
      home: nonEmptyString(raw.home) ? raw.home.trim().replace(/\/+$/, '') : builtin !== null ? builtin.home : '',
      docs: nonEmptyString(raw.docs) ? raw.docs.trim() : builtin !== null ? builtin.docs : null,
    })
  }
  return list.length > 0 ? list : DEFAULT_SOURCES.slice()
}

/**
 * Read a source-qualified id such as `clawhub:awspace/pdf`.
 *
 * The split happens on the FIRST colon, so a ref that itself carries a colon
 * (a URL) survives. A bare ref with no recognised prefix yields
 * `source: null`, which the caller resolves against the explicit `source`
 * argument.
 * @param value - the id.
 * @returns `{ source, ref }`, both possibly null.
 */
export function splitSourceId(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return { source: null, ref: null }
  const colon = text.indexOf(':')
  if (colon <= 0) return { source: null, ref: text }
  const source = text.slice(0, colon).trim().toLowerCase()
  if (!/^[a-z][a-z0-9-]*$/.test(source)) return { source: null, ref: text }
  const ref = text.slice(colon + 1).replace(/^\/+/, '').trim()
  return { source, ref: ref === '' ? null : ref }
}

/**
 * Split `owner/slug` into its two halves.
 * @param ref - the reference.
 * @returns `{ owner, slug }`; `owner` is null for a bare slug.
 */
export function splitOwnerRef(ref) {
  const text = typeof ref === 'string' ? ref.trim().replace(/^@/, '') : ''
  const slash = text.indexOf('/')
  if (slash <= 0) return { owner: null, slug: text }
  return { owner: text.slice(0, slash), slug: text.slice(slash + 1).replace(/^\/+|\/+$/g, '') }
}

/**
 * Whether a value is a legal skill name (§1: kebab-case).
 * @param value - the candidate.
 * @returns true when it matches `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`.
 */
export function isKebabName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 && SKILL_NAME_RE.test(value)
}

// ------------------------------------------------------------- frontmatter

/**
 * Read the YAML frontmatter of a `SKILL.md`.
 *
 * This is deliberately a small reader, not a YAML parser: it understands the
 * subset a skill header is written in — `key: value` at indentation zero,
 * single- or double-quoted values, and `|`/`>` block scalars — and it stops at
 * the closing `---`. A key that appears twice keeps its first value, which is
 * what a YAML reader with duplicate-key protection would refuse.
 *
 * @param text - the file contents.
 * @returns `{ present, values, name, description, body }`; `present` is false
 *   when the file does not open with a `---` line.
 */
export function parseFrontmatter(text) {
  const body = typeof text === 'string' ? text : ''
  const blank = { present: false, values: {}, name: '', description: '', body: body }
  if (body === '') return blank
  const source = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body
  const lines = source.split(/\r?\n/)
  if (lines.length < 2 || lines[0].trim() !== '---') return Object.assign({}, blank, { body: source })
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      end = index
      break
    }
  }
  if (end < 0) return Object.assign({}, blank, { body: source })
  const values = {}
  let index = 1
  while (index < end) {
    const match = /^([A-Za-z0-9_.-]+):(.*)$/.exec(lines[index])
    if (match === null) {
      index += 1
      continue
    }
    const key = match[1]
    const inline = match[2].trim()
    let value = unquote(inline)
    if (inline === '|' || inline === '>' || inline === '|-' || inline === '>-' || inline === '|+' || inline === '>+') {
      const collected = []
      index += 1
      while (index < end && /^\s+\S/.test(lines[index])) {
        collected.push(lines[index].trim())
        index += 1
      }
      value = collected.join(inline.charAt(0) === '|' ? '\n' : ' ')
    } else {
      index += 1
    }
    if (!Object.prototype.hasOwnProperty.call(values, key)) values[key] = value
  }
  return {
    present: true,
    values: values,
    name: typeof values.name === 'string' ? values.name : '',
    description: typeof values.description === 'string' ? values.description : '',
    body: lines.slice(end + 1).join('\n'),
  }
}

/**
 * Validate a `SKILL.md` the way an install requires it: kebab-case `name` and a
 * non-empty `description` (contract §1 and §3.6).
 * @param text - the file contents.
 * @returns `{ ok, name, description, reason }`; `reason` is null when ok.
 */
export function validateSkillMd(text) {
  const front = parseFrontmatter(text)
  if (!front.present) {
    return { ok: false, name: front.name, description: front.description, reason: 'SKILL.md 开头没有 frontmatter（必须以 --- 开头，并以 --- 结束）' }
  }
  if (!isKebabName(front.name)) {
    return {
      ok: false,
      name: front.name,
      description: front.description,
      reason: 'SKILL.md frontmatter 的 name 不是 kebab-case（只能是小写字母、数字和单个连字符）：' + JSON.stringify(front.name),
    }
  }
  const description = front.description.trim()
  if (description === '') {
    return { ok: false, name: front.name, description: '', reason: 'SKILL.md frontmatter 缺少 description' }
  }
  return { ok: true, name: front.name, description: description, reason: null }
}

// ------------------------------------------------------------- path safety

/**
 * Whether one archive entry name is a safe relative path.
 *
 * Everything Windows and POSIX can abuse is refused rather than escaped: an
 * absolute path, a drive letter, an NTFS alternate data stream (`:`), a
 * backslash (a separator in disguise on Windows), a NUL, an empty or
 * over-long name, and any `.` or `..` segment. A trailing slash marks a
 * directory entry, which this reader drops, so it is not safe here either.
 *
 * @param value - the entry name as the archive spells it.
 * @returns true when the name is a plain relative file path.
 */
export function isSafeEntryPath(value) {
  if (typeof value !== 'string') return false
  if (value === '' || value.length > MAX_ENTRY_PATH) return false
  if (value.indexOf('\0') >= 0) return false
  if (value.indexOf('\\') >= 0) return false
  if (value.indexOf(':') >= 0) return false
  if (value.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(value)) return false
  const parts = value.split('/')
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return false
    if (part.length > 120) return false
  }
  return true
}

/**
 * Resolve a safe entry name under a root, refusing anything that would land
 * outside it. The name must already have passed `isSafeEntryPath`; this is the
 * second, arithmetic half of the check, so a bug in the first cannot escape.
 * @param root - the absolute target root.
 * @param entry - the relative entry name.
 * @returns the absolute target path.
 * @throws when the entry is unsafe or resolves outside the root.
 */
export function safeEntryPath(root, entry) {
  if (!isSafeEntryPath(entry)) throw new Error('安装包里的路径不安全：' + JSON.stringify(String(entry)))
  const base = resolve(root)
  const target = resolve(base, entry.split('/').join(sep))
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error('安装包里的路径越出了目标目录：' + JSON.stringify(entry))
  }
  return target
}

// ----------------------------------------------------------------- ranking

/**
 * How well a row matches the query, as a group number. Lower ranks first:
 *
 *  0 — the query equals the row's `name` or `displayName` (case-insensitive);
 *  1 — the row's `name` or `displayName` starts with the query;
 *  2 — everything else, including rows a source matched semantically.
 *
 * With no query every row is group 0, so a browse is ordered purely by the
 * popularity and recency keys below.
 * @param row - a §3.4 result row.
 * @param needle - the query, already trimmed and lower-cased.
 * @returns 0, 1 or 2.
 */
export function matchRank(row, needle) {
  if (needle === '') return 0
  const name = typeof row.name === 'string' ? row.name.toLowerCase() : ''
  const display = typeof row.displayName === 'string' ? row.displayName.toLowerCase() : ''
  if (name === needle || display === needle) return 0
  if (name.startsWith(needle) || display.startsWith(needle)) return 1
  return 2
}

/**
 * Rank a merged result list.
 *
 * THE RULE (contract §3.4): an exact name match first, then a name prefix match,
 * then everything else; within a group by downloads (descending, a missing
 * count sorts last), then by stars (descending, a missing count sorts last),
 * then by `updatedAt` (descending, a missing date sorts last). Two rows that
 * still tie are ordered by the declared source order and finally by `id`, so
 * the output is deterministic and a test can assert it exactly.
 *
 * @param rows - the unranked §3.4 rows.
 * @param query - the search query.
 * @param order - the declared source ids, for the tie-break.
 * @returns a new, sorted array.
 */
export function rankResults(rows, query, order = []) {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  const sourceOrder = Array.isArray(order) ? order : []
  return (Array.isArray(rows) ? rows.slice() : [])
    .map((row, index) => ({ row: row, index: index, match: matchRank(row, needle) }))
    .sort((left, right) => {
      if (left.match !== right.match) return left.match - right.match
      const downloads = countOf(right.row.downloads) - countOf(left.row.downloads)
      if (downloads !== 0) return downloads
      const stars = countOf(right.row.stars) - countOf(left.row.stars)
      if (stars !== 0) return stars
      const fresh = stampOf(right.row.updatedAt) - stampOf(left.row.updatedAt)
      if (fresh !== 0) return fresh
      const leftSource = sourceOrder.indexOf(left.row.source)
      const rightSource = sourceOrder.indexOf(right.row.source)
      const bySource = (leftSource < 0 ? sourceOrder.length : leftSource) - (rightSource < 0 ? sourceOrder.length : rightSource)
      if (bySource !== 0) return bySource
      const byId = String(left.row.id).localeCompare(String(right.row.id))
      if (byId !== 0) return byId
      return left.index - right.index
    })
    .map((item) => item.row)
}

// -------------------------------------------------------- ClawHub mapping

/**
 * Normalise one `/api/v1/search` result into a §3.4 row.
 *
 * The search payload is deeply nested (`native.skill.stats.stars`,
 * `metrics.updatedAt`) and the top level repeats some of it, so every field is
 * read from the first place that actually carries it. `version` is only taken
 * from a string that looks like semver: ClawHub's `tags.latest` is a version on
 * some endpoints and an opaque version id on others, and showing an id as a
 * version would be a lie.
 *
 * @param entry - one `results[]` element.
 * @returns a §3.4 row, or null when the element has neither slug nor owner.
 */
export function clawhubRowFromSearch(entry) {
  const item = entry !== null && typeof entry === 'object' ? entry : {}
  const native = item.native !== null && typeof item.native === 'object' ? item.native : {}
  const skill = native.skill !== null && typeof native.skill === 'object' ? native.skill : {}
  const stats = skill.stats !== null && typeof skill.stats === 'object' ? skill.stats : {}
  const metrics = item.metrics !== null && typeof item.metrics === 'object' ? item.metrics : {}
  const install = item.install !== null && typeof item.install === 'object' ? item.install : {}
  const owner = firstString([item.ownerHandle, native.ownerHandle, item.owner && item.owner.handle, skill.ownerHandle])
  const slug = firstString([item.slug, skill.slug])
  if (owner === '' || slug === '') return null
  const reference = firstString([install.reference]) || owner + '/' + slug
  const version = firstSemver([item.version, native.version, skill.tags && skill.tags.latest])
  const canonical = firstString([item.canonicalUrl, item.links && item.links.canonical])
  return {
    id: 'clawhub:' + reference,
    source: 'clawhub',
    name: slug,
    displayName: firstString([item.displayName, skill.displayName]) || slug,
    summary: firstString([item.summary, skill.summary]),
    owner: owner,
    version: version,
    updatedAt: firstNumber([item.updatedAt, metrics.updatedAt, skill.updatedAt]),
    downloads: firstNumber([item.downloads, stats.downloads]),
    stars: firstNumber([stats.stars]),
    url: canonical.startsWith('/') ? CLAWHUB_HOME + canonical : canonical || CLAWHUB_HOME + '/' + owner + '/skills/' + slug,
    skillUrl: clawhubFileUrl(owner, slug, 'SKILL.md'),
    install: { kind: 'clawhub', ref: reference, url: null },
  }
}

/**
 * Normalise one `/api/v1/skills` (browse) item into a §3.4 row.
 * @param entry - one `items[]` element.
 * @returns a §3.4 row, or null when it has no slug.
 */
export function clawhubRowFromList(entry) {
  const item = entry !== null && typeof entry === 'object' ? entry : {}
  const stats = item.stats !== null && typeof item.stats === 'object' ? item.stats : {}
  const owner = firstString([item.ownerHandle])
  const slug = firstString([item.slug])
  if (slug === '') return null
  const reference = owner === '' ? slug : owner + '/' + slug
  return {
    id: 'clawhub:' + reference,
    source: 'clawhub',
    name: slug,
    displayName: firstString([item.displayName]) || slug,
    summary: firstString([item.summary, item.description]),
    owner: owner,
    version: firstSemver([item.tags && item.tags.latest, item.latestVersion && item.latestVersion.version]),
    updatedAt: firstNumber([item.updatedAt]),
    downloads: firstNumber([stats.downloads]),
    stars: firstNumber([stats.stars]),
    url: owner === '' ? CLAWHUB_HOME + '/skills/' + slug : CLAWHUB_HOME + '/' + owner + '/skills/' + slug,
    skillUrl: owner === '' ? null : clawhubFileUrl(owner, slug, 'SKILL.md'),
    install: { kind: 'clawhub', ref: reference, url: null },
  }
}

/** @returns the exact URL of one file inside a ClawHub skill version. */
function clawhubFileUrl(owner, slug, path) {
  if (owner === '' || slug === '') return null
  return CLAWHUB_HOME + '/api/v1/skills/' + encodeURIComponent(slug) + '/file?path=' + encodeURIComponent(path)
    + '&ownerHandle=' + encodeURIComponent(owner)
}

// --------------------------------------------------------- GitHub mapping

/**
 * Group a `git/trees/<branch>?recursive=1` payload into skill directories.
 *
 * A skill is a directory that holds a `SKILL.md`; everything else in the same
 * directory is one of its siblings and ships with it.
 * @param tree - the tree entries, or anything else.
 * @returns `[{ dir, name, files: [{ path, size }] }]`, sorted by directory.
 */
export function githubSkillDirs(tree) {
  const entries = (Array.isArray(tree) ? tree : []).filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string')
  const byDir = new Map()
  for (const entry of entries) {
    const path = entry.path.replace(/^\/+/, '')
    const parts = path.split('/')
    if (parts[parts.length - 1] !== 'SKILL.md') continue
    const dir = parts.slice(0, -1).join('/')
    if (dir === '') continue
    if (!byDir.has(dir)) byDir.set(dir, { dir: dir, name: parts[parts.length - 2], files: [] })
    byDir.get(dir).files.push({ path: path, size: firstNumber([entry.size]) })
    if (byDir.size > GITHUB_MAX_SKILLS) break
  }
  for (const entry of entries) {
    const path = entry.path.replace(/^\/+/, '')
    if (typeof entry.type === 'string' && entry.type !== 'blob') continue
    // A sibling is ANY file under the skill directory, including one nested
    // several levels down (`scripts/fill.py`), so the longest matching
    // directory wins rather than the file's immediate parent.
    let owner = null
    for (const skill of byDir.values()) {
      if (!path.startsWith(skill.dir + '/')) continue
      if (owner === null || skill.dir.length > owner.dir.length) owner = skill
    }
    if (owner === null) continue
    if (owner.files.some((file) => file.path === path)) continue
    owner.files.push({ path: path, size: firstNumber([entry.size]) })
  }
  return Array.from(byDir.values()).sort((left, right) => left.dir.localeCompare(right.dir))
}

/**
 * Normalise one discovered GitHub skill into a §3.4 row.
 *
 * GitHub carries no download or star count for an individual skill, so those
 * stay null; `version` is null because the repository has no release tag per
 * skill. `summary` is the frontmatter description when it could be read.
 * @param skill - `{ dir, name, description }` from the index.
 * @param owner - the repository owner.
 * @param repo - the repository name.
 * @param branch - the branch the raw URLs must name.
 * @returns a §3.4 row.
 */
export function githubRowFromEntry(skill, owner = GITHUB_OWNER, repo = GITHUB_REPO, branch = GITHUB_BRANCH) {
  const item = skill !== null && typeof skill === 'object' ? skill : {}
  const dir = typeof item.dir === 'string' ? item.dir : ''
  const fallback = dir.split('/').filter((part) => part !== '').pop() || dir
  const name = isKebabName(item.name) ? item.name : fallback
  return {
    id: 'github:' + dir,
    source: 'github',
    name: name,
    displayName: typeof item.displayName === 'string' && item.displayName !== '' ? item.displayName : name,
    summary: typeof item.description === 'string' ? item.description : '',
    owner: owner,
    version: null,
    updatedAt: null,
    downloads: null,
    stars: null,
    url: 'https://github.com/' + owner + '/' + repo + '/tree/' + branch + '/' + dir,
    skillUrl: 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/' + dir + '/SKILL.md',
    install: { kind: 'git', ref: dir, url: null },
  }
}

// ------------------------------------------------------------------- zip

/**
 * Read every file out of a ZIP archive, using nothing but `node:zlib`.
 *
 * The central directory is authoritative (a local header may be followed by a
 * data descriptor it does not describe), so sizes and offsets are read from
 * there and only the compressed bytes come from the local record. Method 0
 * (stored) and method 8 (deflate) are supported, which is everything ClawHub
 * emits; an encrypted entry, a ZIP64 archive and an unknown method are refused
 * with a readable reason rather than being half-read.
 *
 * @param buffer - the archive bytes.
 * @returns `[{ path, data, size }]`, directory entries dropped.
 * @throws when the archive is truncated, ZIP64, encrypted or absurdly large.
 */
export function readZipEntries(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (bytes.length < 22) throw new Error('下载到的压缩包不完整（只有 ' + bytes.length + ' 字节）')
  let eocd = -1
  const lowest = Math.max(0, bytes.length - 65557)
  for (let index = bytes.length - 22; index >= lowest; index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new Error('下载到的不是 ZIP 压缩包（找不到结尾记录）')
  if (eocd >= 20 && bytes.readUInt32LE(eocd - 20) === 0x07064b50) throw new Error('不支持 ZIP64 压缩包')
  const count = bytes.readUInt16LE(eocd + 10)
  const directorySize = bytes.readUInt32LE(eocd + 12)
  const directoryOffset = bytes.readUInt32LE(eocd + 16)
  if (count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) throw new Error('不支持 ZIP64 压缩包')
  if (directoryOffset + directorySize > bytes.length) throw new Error('压缩包的中央目录越出了文件末尾')

  const entries = []
  let offset = directoryOffset
  let total = 0
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length) throw new Error('压缩包的中央目录被截断')
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('压缩包的中央目录条目损坏')
    const flags = bytes.readUInt16LE(offset + 8)
    const method = bytes.readUInt16LE(offset + 10)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const rawSize = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const localOffset = bytes.readUInt32LE(offset + 42)
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength

    if ((flags & 0x1) !== 0) throw new Error('压缩包里的条目是加密的：' + JSON.stringify(name))
    if (name.endsWith('/')) continue
    if (method !== 0 && method !== 8) throw new Error('压缩用了不支持的方式（' + method + '）：' + JSON.stringify(name))
    if (rawSize > MAX_FILE_BYTES) throw new Error('压缩包里的文件太大：' + JSON.stringify(name))
    total += rawSize
    if (total > MAX_PACKAGE_BYTES) throw new Error('压缩包解压后太大（超过 ' + Math.round(MAX_PACKAGE_BYTES / 1048576) + 'MB）')
    if (entries.length >= MAX_PACKAGE_FILES) throw new Error('压缩包里的文件太多（超过 ' + MAX_PACKAGE_FILES + ' 个）')
    if (localOffset + 30 > bytes.length) throw new Error('压缩包的本地文件头越界：' + JSON.stringify(name))
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('压缩包的本地文件头损坏：' + JSON.stringify(name))
    const localNameLength = bytes.readUInt16LE(localOffset + 26)
    const localExtraLength = bytes.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const compressed = bytes.subarray(start, start + compressedSize)
    if (compressed.length !== compressedSize) throw new Error('压缩包里的文件数据被截断：' + JSON.stringify(name))
    const data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed)
    entries.push({ path: name, data: data, size: data.length })
  }
  if (entries.length === 0) throw new Error('压缩包里没有任何文件')
  return entries
}

/**
 * Drop one shared directory prefix from every entry, the way a `package/`
 * root is wrapped around an npm-style archive. Nothing is stripped unless
 * every entry really sits under that first segment.
 * @param entries - the entries.
 * @returns the entries, possibly re-rooted.
 */
export function stripArchiveRoot(entries) {
  const list = Array.isArray(entries) ? entries : []
  if (list.length === 0) return list
  const first = list[0].path.split('/')[0]
  if (first === '' || first.indexOf('.') === 0) return list
  const wrapped = list.every((entry) => entry.path.startsWith(first + '/'))
  if (!wrapped) return list
  return list.map((entry) => Object.assign({}, entry, { path: entry.path.slice(first.length + 1) }))
}

// ------------------------------------------------------------ the factory

/**
 * Build a skill-source registry.
 *
 * @param {object} [options] - the seams.
 * @param {Function} [options.fetch] - a `fetch`-shaped function; defaults to the
 *   global one, and when there is none every source degrades to unreachable.
 * @param {number} [options.timeoutMs] - the budget for one HTTP attempt.
 * @param {number} [options.ttlMs] - how long a built answer is reused.
 * @param {Array} [options.sources] - the source definitions, or the built-ins.
 * @param {Function} [options.logger] - `(message) => void`, for degradations.
 * @param {Function} [options.now] - the clock; injectable so a TTL is testable.
 * @returns `{ sources, search, detail, install, reset }`.
 */
export function createSkillSources(options = {}) {
  const input = options !== null && typeof options === 'object' ? options : {}
  const deps = {
    // An injected `fetch` that is not a function (`null`, a string) is an
    // explicit "this machine has no network" seam, not a request for the
    // global one; only an absent option falls back to `globalThis.fetch`.
    fetchImpl: typeof input.fetch === 'function'
      ? input.fetch
      : (input.fetch === undefined && typeof globalThis.fetch === 'function' ? globalThis.fetch : null),
    timeoutMs: toBudget(input.timeoutMs, DEFAULT_TIMEOUT_MS),
    ttlMs: toBudget(input.ttlMs, DEFAULT_TTL_MS),
    sources: normalizeSources(input.sources),
    logger: typeof input.logger === 'function' ? input.logger : () => {},
    now: typeof input.now === 'function' ? input.now : Date.now,
  }

  /** Bodies + ETags, keyed by URL, for conditional requests across calls. */
  const httpCache = new Map()
  /** Built answers, keyed by operation, for the TTL. */
  const memo = new Map()

  const order = deps.sources.map((source) => source.id)

  /** @returns a memoised value, or null when absent or expired. */
  function memoGet(key) {
    const entry = memo.get(key)
    if (entry === undefined) return null
    if (deps.now() - entry.at >= deps.ttlMs) {
      memo.delete(key)
      return null
    }
    return entry.value
  }

  /** Remember a value for the TTL. */
  function memoSet(key, value) {
    memo.set(key, { at: deps.now(), value: value })
    return value
  }

  /** Report a degradation once, without ever letting the logger break a caller. */
  function note(message) {
    try {
      deps.logger(message)
    } catch (error) {
      // a logger that throws is not a reason to fail a search
    }
  }

  // ------------------------------------------------------------- requests

  /**
   * One bounded fetch, normalized to `{ status, body, etag }` or, when the
   * route did not answer at all, `{ failed: true, reason }`.
   *
   * Follows `lib/host/dsh.js`: the promise is raced against the budget, the
   * AbortController is fired on expiry, and no failure ever escapes. The reason
   * keeps the transport's own words (`fetch failed`, `ECONNRESET`) so a failure
   * list says more than "network"; a timeout has no error to quote, so it is
   * reported as `timeout`.
   * @param url - the URL.
   * @param headers - the request headers.
   * @param asBytes - read the reply as a Buffer instead of text.
   * @returns the normalized reply.
   */
  async function request(url, headers, asBytes = false) {
    if (typeof deps.fetchImpl !== 'function') return { failed: true, reason: 'no-fetch' }
    const controller = makeAbortController()
    let started = null
    try {
      started = Promise.resolve(deps.fetchImpl(url, {
        headers: headers,
        redirect: 'follow',
        signal: controller === null ? undefined : controller.signal,
      }))
    } catch (error) {
      return { failed: true, reason: errorText(error) }
    }
    const settled = await withinBudget(started, deps.timeoutMs, () => {
      if (controller !== null) {
        try {
          controller.abort()
        } catch (error) {
          // an abort that throws is still an abort
        }
      }
    })
    if (!settled.ok) return { failed: true, reason: settled.timedOut ? 'timeout' : errorText(settled.error) }
    const reply = await readReply(settled.value, asBytes)
    return reply === null ? { failed: true, reason: 'network' } : reply
  }

  /**
   * Conditional GET with a remembered ETag and a remembered body.
   *
   * A `304` answers with the body from last time — an empty 304 body is never
   * parsed, which is the bug this cache exists to prevent. When the network is
   * gone entirely the remembered body still answers, marked `cached`.
   * @param url - the URL.
   * @param accept - the Accept header.
   * @param asBytes - read the reply as a Buffer.
   * @returns `{ ok, body, cached, reason, status }`.
   */
  async function getCached(url, accept, asBytes = false) {
    const remembered = httpCache.get(url) || null
    const headers = {
      accept: accept,
      'user-agent': USER_AGENT,
      'accept-encoding': 'identity',
    }
    if (remembered !== null && remembered.etag !== null && remembered.body !== null) {
      headers['if-none-match'] = remembered.etag
    }
    const reply = await request(url, headers, asBytes)
    if (reply.failed === true) {
      if (remembered !== null && remembered.body !== null) {
        return { ok: true, body: remembered.body, cached: true, reason: reply.reason, status: null }
      }
      return { ok: false, body: null, cached: false, reason: reply.reason, status: null }
    }
    if (reply.status === 304) {
      if (remembered !== null && remembered.body !== null) {
        if (reply.etag !== null) remembered.etag = reply.etag
        return { ok: true, body: remembered.body, cached: true, reason: 'not-modified', status: 304 }
      }
      return { ok: false, body: null, cached: false, reason: 'not-modified', status: 304 }
    }
    if (!(reply.status >= 200 && reply.status < 300)) {
      // An explicit 4xx/5xx is a real answer and is reported as one. Only a
      // transport failure (no answer at all) falls back to the remembered
      // body, so a server error can never be silently papered over with a
      // stale copy — which matters most for an install.
      return { ok: false, body: null, cached: false, reason: 'HTTP ' + reply.status, status: reply.status }
    }
    httpCache.set(url, { body: reply.body, etag: reply.etag, at: deps.now() })
    return { ok: true, body: reply.body, cached: false, reason: null, status: reply.status }
  }

  /**
   * A conditional GET parsed as JSON.
   * @param url - the URL.
   * @param accept - the Accept header.
   * @returns `{ ok, value, reason, status }`; `reason` is a readable line.
   */
  async function getJson(url, accept) {
    const reply = await getCached(url, accept, false)
    if (!reply.ok) return { ok: false, value: null, reason: reply.reason, status: reply.status }
    try {
      return { ok: true, value: JSON.parse(reply.body), reason: null, status: reply.status }
    } catch (error) {
      return { ok: false, value: null, reason: '不是合法的 JSON', status: reply.status }
    }
  }

  // ---------------------------------------------------------------- probe

  /**
   * How each source proves it is there, with the cheapest request it has.
   * A 200 or a 304 both mean reachable.
   */
  async function probe(source) {
    if (!IMPLEMENTED.has(source.id)) return { reachable: false, note: '不支持的来源' }
    if (source.id === 'clawhub') {
      const reply = await getJson(CLAWHUB_HOME + '/api/v1/skills?limit=1&sort=recommended', JSON_ACCEPT)
      return reply.ok ? { reachable: true, note: null } : { reachable: false, note: reply.reason }
    }
    const reply = await getJson(GITHUB_API, GITHUB_ACCEPT)
    return reply.ok ? { reachable: true, note: null } : { reachable: false, note: reply.reason }
  }

  // -------------------------------------------------------------- ClawHub

  /**
   * The ClawHub rows for one request.
   * @param query - the search text; empty means "browse the catalogue".
   * @param limit - how many rows to ask for.
   * @returns `{ rows, reason }`; `rows` is empty when the request failed.
   */
  async function clawhubSearch(query, limit) {
    const url = query === ''
      // Browse: one page of the recommended catalogue, which is what an empty
      // query means. `nextCursor` is deliberately not followed — the caller
      // asked for `limit` rows, not for the whole catalogue.
      ? CLAWHUB_HOME + '/api/v1/skills?limit=' + limit + '&sort=recommended'
      : CLAWHUB_HOME + '/api/v1/search?q=' + encodeURIComponent(query) + '&limit=' + limit
    const reply = await getJson(url, JSON_ACCEPT)
    if (!reply.ok) return { rows: [], reason: reply.reason }
    const payload = reply.value !== null && typeof reply.value === 'object' ? reply.value : {}
    const list = query === '' ? payload.items : payload.results
    const rows = []
    for (const entry of Array.isArray(list) ? list : []) {
      const row = query === '' ? clawhubRowFromList(entry) : clawhubRowFromSearch(entry)
      if (row !== null) rows.push(row)
    }
    return { rows: rows, reason: null }
  }

  /**
   * The ClawHub half of `detail`.
   * @param ref - `owner/slug`.
   * @param version - a version to read instead of the latest, or null.
   * @returns the §3.5 document, every enrichment best-effort.
   */
  async function clawhubDetail(ref, version) {
    const parts = splitOwnerRef(ref)
    const slug = parts.slug
    const owner = parts.owner
    if (slug === '') throw new Error('ClawHub 的技能引用不合法：' + JSON.stringify(String(ref)))
    const query = owner === null ? '' : '?ownerHandle=' + encodeURIComponent(owner)
    const base = CLAWHUB_HOME + '/api/v1/skills/' + encodeURIComponent(slug)

    const detail = await getJson(base + query, JSON_ACCEPT)
    const payload = detail.ok && detail.value !== null && typeof detail.value === 'object' ? detail.value : {}
    const skill = payload.skill !== null && typeof payload.skill === 'object' ? payload.skill : {}
    const resolvedOwner = firstString([payload.owner && payload.owner.handle, owner])
    const name = firstString([skill.slug, slug])
    // `skill.tags.latest` is a semver on some ClawHub endpoints and an opaque
    // version id on others, so only a semver-shaped value is ever shown.
    const resolvedVersion = firstSemver([version, skill.tags && skill.tags.latest, payload.latestVersion && payload.latestVersion.version])
    const reference = resolvedOwner === '' ? name : resolvedOwner + '/' + name

    let files = []
    let readme = null
    if (resolvedVersion !== null) {
      const versionReply = await getJson(
        base + '/versions/' + encodeURIComponent(resolvedVersion) + query,
        JSON_ACCEPT,
      )
      const versionPayload = versionReply.ok && versionReply.value !== null && typeof versionReply.value === 'object' ? versionReply.value : {}
      const versionInfo = versionPayload.version !== null && typeof versionPayload.version === 'object' ? versionPayload.version : {}
      files = pathList(versionInfo.files)
    }
    // ClawHub has no README artifact for a skill; the summary is all there is.

    let skillMd = null
    if (resolvedOwner !== '') {
      const file = await getCached(clawhubFileUrl(resolvedOwner, name, 'SKILL.md'), TEXT_ACCEPT, false)
      if (file.ok) skillMd = file.body
    }
    if (files.length === 0 && skillMd !== null) files = ['SKILL.md']

    return {
      id: 'clawhub:' + reference,
      source: 'clawhub',
      name: name,
      version: resolvedVersion,
      summary: firstString([skill.summary, skill.description]),
      readme: readme,
      files: files,
      skillMd: skillMd,
      install: { kind: 'clawhub', ref: reference, url: null },
    }
  }

  /**
   * Download and unpack one ClawHub skill version.
   * @param ref - `owner/slug`.
   * @param version - a version, or null for the latest.
   * @returns `[{ path, data, size }]`.
   * @throws when the download or the archive is unusable.
   */
  async function clawhubPackage(ref, version) {
    const parts = splitOwnerRef(ref)
    if (parts.owner === null || parts.slug === '') {
      throw new Error('ClawHub 的技能引用必须是 <owner>/<slug>：' + JSON.stringify(String(ref)))
    }
    let url = CLAWHUB_HOME + '/api/v1/download?slug=' + encodeURIComponent(parts.slug)
      + '&ownerHandle=' + encodeURIComponent(parts.owner)
    if (version !== null && version !== '') url += '&version=' + encodeURIComponent(version)
    const reply = await getCached(url, ZIP_ACCEPT, true)
    if (!reply.ok) throw new Error('下载失败（' + String(reply.reason) + '）：' + url)
    const bytes = Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body)
    if (bytes.length === 0) throw new Error('下载到的内容为空：' + url)
    if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return stripArchiveRoot(readZipEntries(bytes))
    // A GitHub-backed ClawHub skill hands off a JSON pointer instead of a zip.
    const text = bytes.toString('utf8').trim()
    if (text.startsWith('{')) {
      let pointer = null
      try {
        pointer = JSON.parse(text)
      } catch (error) {
        pointer = null
      }
      const source = pointer !== null && typeof pointer === 'object' ? firstString([pointer.sourceRef]) : ''
      if (source === 'public-github') {
        throw new Error('这个技能没有托管压缩包，它指向 GitHub（' + firstString([pointer.repo]) + ' ' + firstString([pointer.path]) + '），请改用 GitHub 来源安装。')
      }
    }
    throw new Error('下载到的不是 ZIP 压缩包：' + url)
  }

  // --------------------------------------------------------------- GitHub

  /**
   * The skill index of `anthropics/skills`, built once per TTL.
   *
   * The one-shot `git/trees/<branch>?recursive=1` route is preferred; when it
   * cannot answer, `contents/<dir>` is listed instead, which yields directory
   * names but no file lists (`partial: true`), so an install re-reads the
   * directory it needs.
   * @returns `{ skills, route, reason }`; `skills` is empty when both routes failed.
   */
  async function githubIndex() {
    const cached = memoGet('github:index')
    if (cached !== null) return cached
    const tree = await getJson(GITHUB_API + '/git/trees/' + GITHUB_BRANCH + '?recursive=1', GITHUB_ACCEPT)
    let skills = []
    let route = null
    let reason = null
    if (tree.ok && tree.value !== null && typeof tree.value === 'object' && Array.isArray(tree.value.tree)) {
      skills = githubSkillDirs(tree.value.tree).map((skill) => ({
        dir: skill.dir,
        name: skill.name,
        description: '',
        files: skill.files,
        partial: false,
      }))
      route = 'tree'
    } else {
      const listing = await getJson(GITHUB_API + '/contents/' + GITHUB_SKILL_DIR, GITHUB_ACCEPT)
      if (listing.ok && Array.isArray(listing.value)) {
        for (const entry of listing.value) {
          if (entry === null || typeof entry !== 'object' || entry.type !== 'dir' || typeof entry.name !== 'string') continue
          skills.push({
            dir: GITHUB_SKILL_DIR + '/' + entry.name,
            name: entry.name,
            description: '',
            files: [{ path: GITHUB_SKILL_DIR + '/' + entry.name + '/SKILL.md', size: null }],
            partial: true,
          })
        }
        route = 'contents'
      } else {
        reason = tree.reason || listing.reason || 'network'
      }
    }
    if (route !== null) await enrichGithubSkills(skills)
    return memoSet('github:index', { skills: skills, route: route, reason: reason })
  }

  /**
   * Read each skill's own `SKILL.md` to learn its canonical name and summary.
   *
   * This is best-effort by design: a skill whose header cannot be read is still
   * listed, under its directory name, with an empty summary.
   * @param skills - the index entries, filled in place.
   * @returns nothing.
   */
  async function enrichGithubSkills(skills) {
    const targets = skills.slice(0, GITHUB_MAX_ENRICH)
    for (let start = 0; start < targets.length; start += GITHUB_CONCURRENCY) {
      const batch = targets.slice(start, start + GITHUB_CONCURRENCY)
      await Promise.all(batch.map(async (skill) => {
        const url = GITHUB_RAW + '/' + skill.dir + '/SKILL.md'
        const reply = await getCached(url, TEXT_ACCEPT, false)
        if (!reply.ok) return
        const front = parseFrontmatter(reply.body)
        if (isKebabName(front.name)) skill.name = front.name
        if (front.present) skill.description = front.description.trim()
      }))
    }
  }

  /**
   * The file list of one skill directory, when the tree route did not supply it.
   * @param skill - the index entry.
   * @returns `[{ path, size }]`.
   */
  async function githubFiles(skill) {
    if (skill !== null && skill.partial !== true && Array.isArray(skill.files) && skill.files.length > 0) return skill.files
    const dir = skill !== null && typeof skill.dir === 'string' ? skill.dir : ''
    const listing = await getJson(GITHUB_API + '/contents/' + dir, GITHUB_ACCEPT)
    if (!listing.ok || !Array.isArray(listing.value)) return Array.isArray(skill && skill.files) ? skill.files : []
    const files = []
    for (const entry of listing.value) {
      if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') continue
      if (entry.type === 'dir') continue
      files.push({ path: entry.path, size: firstNumber([entry.size]) })
    }
    return files
  }

  /**
   * Find the index entry a ref names, so `pdf` and `skills/pdf` both work.
   * @param index - the built index.
   * @param ref - the reference.
   * @returns the entry, or null.
   */
  function githubSkillFor(index, ref) {
    const wanted = String(ref || '').replace(/^\/+|\/+$/g, '')
    if (wanted === '') return null
    const exact = index.skills.find((skill) => skill.dir === wanted) || null
    if (exact !== null) return exact
    return index.skills.find((skill) => skill.name === wanted || skill.dir.split('/').pop() === wanted) || null
  }

  /**
   * The GitHub half of `detail`.
   * @param ref - the skill directory, or its bare name.
   * @returns the §3.5 document, every enrichment best-effort.
   */
  async function githubDetail(ref) {
    const index = await githubIndex()
    const found = githubSkillFor(index, ref)
    const dir = found !== null ? found.dir : String(ref || '').replace(/^\/+|\/+$/g, '')
    if (dir === '') throw new Error('GitHub 的技能引用不能为空')
    // The file list is only known once the index answered; when it did not,
    // guessing a directory listing would be a claim this module cannot back.
    let files = found !== null ? pathList(await githubFiles(found)) : []
    const skillMdReply = await getCached(GITHUB_RAW + '/' + dir + '/SKILL.md', TEXT_ACCEPT, false)
    const skillMd = skillMdReply.ok ? skillMdReply.body : null
    if (files.length === 0 && skillMd !== null) files = [dir + '/SKILL.md']
    const readmeReply = await getCached(GITHUB_RAW + '/' + dir + '/README.md', TEXT_ACCEPT, false)
    const fallback = dir.split('/').pop() || dir
    const front = skillMd === null ? { name: '', description: '' } : parseFrontmatter(skillMd)
    const name = isKebabName(front.name) ? front.name : fallback
    return {
      id: 'github:' + dir,
      source: 'github',
      name: name,
      version: null,
      summary: typeof front.description === 'string' ? front.description.trim() : '',
      readme: readmeReply.ok ? readmeReply.body : null,
      files: files,
      skillMd: skillMd,
      install: { kind: 'git', ref: dir, url: null },
    }
  }

  /**
   * Fetch one GitHub skill directory: `SKILL.md` and every sibling file.
   * @param ref - the directory, or its bare name.
   * @returns `[{ path, data, size }]`, paths relative to the skill directory.
   * @throws when the directory, the listing or a file cannot be read.
   */
  async function githubPackage(ref) {
    const index = await githubIndex()
    const found = githubSkillFor(index, ref)
    const dir = found !== null ? found.dir : String(ref || '').replace(/^\/+|\/+$/g, '')
    if (dir === '') throw new Error('GitHub 的技能引用不能为空')
    const listing = await githubFiles(found !== null ? found : { dir: dir, partial: true, files: [] })
    const rel = []
    for (const file of listing) {
      const path = typeof file.path === 'string' ? file.path : ''
      if (path === '' || path === dir || !path.startsWith(dir + '/')) continue
      rel.push({ path: path.slice(dir.length + 1), size: file.size })
    }
    if (!rel.some((file) => file.path === 'SKILL.md')) rel.unshift({ path: 'SKILL.md', size: null })
    if (rel.length > MAX_PACKAGE_FILES) throw new Error('这个技能的文件太多（超过 ' + MAX_PACKAGE_FILES + ' 个）')
    const entries = []
    let total = 0
    for (const file of rel) {
      const reply = await getCached(GITHUB_RAW + '/' + dir + '/' + file.path, TEXT_ACCEPT, true)
      if (!reply.ok) {
        // A listed-but-unreadable sibling is skipped; a missing SKILL.md is not.
        if (file.path === 'SKILL.md') throw new Error('读不到 SKILL.md（' + String(reply.reason) + '）')
        continue
      }
      const data = Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body)
      total += data.length
      if (total > MAX_PACKAGE_BYTES) throw new Error('这个技能太大（超过 ' + Math.round(MAX_PACKAGE_BYTES / 1048576) + 'MB）')
      entries.push({ path: file.path, data: data, size: data.length })
    }
    if (entries.length === 0) throw new Error('这个技能目录里没有可下载的文件')
    return entries
  }

  // ------------------------------------------------------------- install

  /**
   * Fetch, validate and unpack a package into `root`.
   * @param source - the resolved source definition.
   * @param ref - the resolved reference.
   * @param root - the absolute target root directory.
   * @param force - replace an existing skill directory.
   * @returns `{ name, dir, files, bytes, paths, skillMd }`.
   * @throws a user-facing refusal for anything the contract lists.
   */
  async function unpack(source, ref, root, force) {
    const entries = source.id === 'github' ? await githubPackage(ref) : await clawhubPackage(ref, null)
    const skillEntry = entries.find((entry) => entry.path.replace(/^\.\//, '') === 'SKILL.md') || null
    if (skillEntry === null) throw new Error('这个安装包里没有 SKILL.md')
    const skillMd = Buffer.isBuffer(skillEntry.data) ? skillEntry.data.toString('utf8') : String(skillEntry.data)
    const verdict = validateSkillMd(skillMd)
    if (!verdict.ok) throw new Error('安装包里的 SKILL.md 不合格：' + verdict.reason)
    const name = verdict.name
    if (name === '') throw new Error('SKILL.md 没有可用的 name')
    for (const entry of entries) {
      if (!isSafeEntryPath(entry.path)) throw new Error('安装包里的路径不安全，已拒绝：' + JSON.stringify(entry.path))
    }

    const base = resolve(root)
    const target = safeEntryPath(base, name)
    let existing = null
    try {
      existing = await lstat(target)
    } catch (error) {
      existing = null
    }
    if (existing !== null && !existing.isDirectory()) {
      // A symlink (or a plain file) where the skill directory belongs is the
      // one case `force` may never overwrite: writing through it would put the
      // package outside the root the caller resolved.
      throw new Error('同名路径不是一个目录，拒绝覆盖：' + target)
    }
    if (existing !== null && force !== true) {
      throw new Error('已经存在同名技能：' + target + '（需要覆盖请传 force）')
    }

    await mkdir(base, { recursive: true })
    const staging = join(base, TEMP_DIR_PREFIX + randomBytes(6).toString('hex'))
    let written = 0
    let bytes = 0
    let backup = null
    const paths = []
    try {
      for (const entry of entries) {
        const destination = safeEntryPath(staging, entry.path)
        await assertRealParents(staging, entry.path)
        await mkdir(dirnameOf(destination), { recursive: true })
        await writeFile(destination, entry.data)
        written += 1
        bytes += entry.data.length
        paths.push(entry.path)
      }
      if (existing !== null) {
        // Swap rather than delete-then-write: the old copy survives until the
        // new one is in place, so a failure here can still be rolled back.
        backup = staging + '.old'
        await rename(target, backup)
        try {
          await rename(staging, target)
        } catch (error) {
          await rename(backup, target)
          throw error
        }
      } else {
        await rename(staging, target)
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
    // The swap has already happened; dropping the old copy can no longer turn a
    // successful install into a reported failure.
    if (backup !== null) await rm(backup, { recursive: true, force: true })
    paths.sort()
    return { name: name, dir: target, files: written, bytes: bytes, paths: paths, skillMd: skillMd }
  }

  // ---------------------------------------------------------------- public

  return {
    /**
     * The source list of contract §3.3, with `reachable` from a cheap cached probe.
     * @returns the §3.3 document; never throws.
     */
    async sources() {
      const cached = memoGet('sources')
      // A memo hit is handed back as a copy, so a caller that edits the document
      // it was given cannot corrupt what the next caller receives.
      if (cached !== null) return Object.assign({}, cached)
      const rows = []
      for (const source of deps.sources) {
        let reachable = false
        let reason = null
        try {
          const probed = await probe(source)
          reachable = probed.reachable
          reason = probed.note
        } catch (error) {
          reachable = false
          reason = errorText(error)
        }
        if (!reachable && reason === null) reason = 'network'
        if (!reachable) note('skill-sources: ' + source.id + ' 不可达（' + String(reason) + '）')
        rows.push({
          id: source.id,
          label: source.label,
          kind: source.kind,
          home: source.home,
          docs: source.docs,
          reachable: reachable,
          note: reachable ? null : reason,
          count: null,
        })
      }
      return memoSet('sources', { generatedAt: deps.now(), sources: rows })
    },

    /**
     * Search every requested source and rank the merged list (§3.4).
     *
     * Fan-out is per source and independent: one source failing lands in
     * `failures[]` and the others still answer. `limit` caps the MERGED list.
     * An empty query browses the source instead of searching it.
     *
     * @param {object} [request] - `{ query, source, limit }`.
     * @returns the §3.4 document; never throws.
     */
    async search(request = {}) {
      const input2 = readRequest(request)
      const query = typeof input2.query === 'string' ? input2.query.trim() : ''
      const limit = toPositiveInt(input2.limit, DEFAULT_LIMIT, MAX_LIMIT)
      const selected = typeof input2.source === 'string' && input2.source.trim() !== '' ? input2.source.trim().toLowerCase() : 'all'
      const wanted = selected === 'all' ? deps.sources : deps.sources.filter((source) => source.id === selected)
      const memoKey = 'search:' + selected + ':' + limit + ':' + query
      const cached = memoGet(memoKey)
      if (cached !== null) return Object.assign({}, cached)

      const rows = []
      const failures = []
      for (const source of wanted) {
        if (!IMPLEMENTED.has(source.id)) {
          failures.push({ source: source.id, message: '不支持的来源' })
          continue
        }
        try {
          const answer = source.id === 'github'
            ? await githubSearch(query, limit)
            : await clawhubSearch(query, limit)
          if (answer.reason !== null) {
            failures.push({ source: source.id, message: String(answer.reason) })
            note('skill-sources: ' + source.id + ' 搜索失败（' + String(answer.reason) + '）')
          }
          for (const row of answer.rows) rows.push(row)
        } catch (error) {
          failures.push({ source: source.id, message: errorText(error) })
          note('skill-sources: ' + source.id + ' 搜索异常（' + errorText(error) + '）')
        }
      }
      if (selected !== 'all' && wanted.length === 0) {
        failures.push({ source: selected, message: '未知来源' })
      }
      const ranked = rankResults(rows, query, order)
      const document = {
        query: query,
        searchedAt: deps.now(),
        source: selected,
        results: ranked.slice(0, limit),
        failures: failures,
        truncated: ranked.length > limit,
      }
      return memoSet(memoKey, document)
    },

    /**
     * The detail of one skill (§3.5).
     *
     * `readme`, `files` and `skillMd` are best-effort and come back `null` or
     * empty when the source cannot supply them; only an unparseable reference
     * throws, because that is a caller bug rather than a source limitation.
     *
     * @param {object} [request] - `{ id, source, ref }`.
     * @returns the §3.5 document.
     */
    async detail(request = {}) {
      const input2 = readRequest(request)
      const { source, ref } = resolveRef(input2, deps.sources)
      if (source === null) throw new Error('无法确定来源：请给出 id（例如 clawhub:owner/slug）或 source + ref')
      if (ref === null || ref === '') throw new Error('缺少技能引用（ref）')
      if (!IMPLEMENTED.has(source.id)) {
        return {
          id: source.id + ':' + ref,
          source: source.id,
          name: ref,
          version: null,
          summary: '',
          readme: null,
          files: [],
          skillMd: null,
          install: null,
        }
      }
      if (source.id === 'github') return await githubDetail(ref)
      return await clawhubDetail(ref, typeof input2.version === 'string' ? input2.version : null)
    },

    /**
     * Install one skill into a writable root (§3.6).
     *
     * The download is complete and valid before the target directory is touched,
     * the files are written into a hidden staging directory inside `root`, and
     * the staging directory is renamed into place, so a failure leaves nothing
     * behind. Refusals are thrown, as the contract requires.
     *
     * @param {object} [request] - `{ id, source, ref, destination, force, root }`.
     *   `root` is the ABSOLUTE target root the caller resolved (§1/§3.6);
     *   `destination` is informational only.
     * @returns `{ ok, name, source, ref, root, dir, files, bytes, paths, skillMd, install }`.
     */
    async install(request = {}) {
      const input2 = readRequest(request)
      const { source, ref } = resolveRef(input2, deps.sources)
      if (source === null) throw new Error('无法确定来源：请给出 id（例如 clawhub:owner/slug）或 source + ref')
      if (ref === null || ref === '') throw new Error('缺少技能引用（ref）')
      if (!IMPLEMENTED.has(source.id)) throw new Error('不支持的来源：' + source.id)
      const rawRoot = typeof input2.root === 'string' ? input2.root.trim() : ''
      if (rawRoot === '') throw new Error('没有给出安装根目录（root）')
      const root = resolve(rawRoot)
      if (!isAbsolutePath(rawRoot)) throw new Error('安装根目录必须是绝对路径：' + rawRoot)
      const force = input2.force === true

      const unpacked = await unpack(source, ref, root, force)
      return {
        ok: true,
        name: unpacked.name,
        source: source.id,
        ref: ref,
        root: root,
        dir: unpacked.dir,
        files: unpacked.files,
        bytes: unpacked.bytes,
        paths: unpacked.paths,
        skillMd: unpacked.skillMd,
        install: source.id === 'clawhub'
          ? { kind: 'clawhub', ref: ref, url: null }
          : { kind: 'git', ref: ref, url: null },
      }
    },

    /**
     * Drop every cache this instance holds: the ETags, the remembered bodies,
     * the built search pages and the GitHub index. For tests, and for a caller
     * that has just changed something on disk.
     * @returns nothing.
     */
    reset() {
      httpCache.clear()
      memo.clear()
    },
  }

  // ------------------------------------------------------- instance helpers

  /**
   * The GitHub rows for one request.
   * @param query - the search text; empty browses the whole index.
   * @param limit - how many rows to keep.
   * @returns `{ rows, reason }`.
   */
  async function githubSearch(query, limit) {
    const index = await githubIndex()
    if (index.route === null) return { rows: [], reason: index.reason || 'network' }
    const rows = []
    const needle = query.toLowerCase()
    for (const skill of index.skills) {
      if (needle !== '') {
        const haystack = (skill.name + ' ' + skill.description + ' ' + skill.dir).toLowerCase()
        if (haystack.indexOf(needle) < 0) continue
      }
      rows.push(githubRowFromEntry(skill, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH))
      if (rows.length >= limit) break
    }
    return { rows: rows, reason: null }
  }

  /**
   * Resolve `{ id, source, ref }` into a source definition and a reference.
   *
   * An `id` in `source:ref` form wins; a bare `id` is treated as a ref against
   * the explicit `source`, and when neither is given the ClawHub definition is
   * not assumed — the caller is told instead.
   * @param request - the caller's options.
   * @param sources - the resolved source definitions.
   * @returns `{ source, ref }`, `source` possibly null.
   */
  function resolveRef(request, sources) {
    const id = typeof request.id === 'string' ? request.id.trim() : ''
    const explicit = typeof request.source === 'string' ? request.source.trim().toLowerCase() : ''
    const refInput = typeof request.ref === 'string' ? request.ref.trim() : ''
    const split = splitSourceId(id)
    let sourceId = split.source
    let ref = split.ref
    if (sourceId === null && explicit !== '') sourceId = explicit
    if (ref === null) ref = refInput === '' ? null : refInput
    if (sourceId === null) return { source: null, ref: ref }
    const found = sources.find((entry) => entry.id === sourceId)
      || DEFAULT_SOURCES.find((entry) => entry.id === sourceId)
      // An id prefixed with an unknown source still names a source the caller
      // asked about, so it is reported back (as unsupported) rather than lost.
      || { id: sourceId, label: sourceId, kind: 'registry', home: '', docs: null }
    return { source: found, ref: ref }
  }

  /**
   * Refuse a symlinked parent below the staging root.
   *
   * `isSafeEntryPath` proves the NAME cannot escape; this proves the FILESYSTEM
   * cannot either. A directory that is a symlink (or a file where a directory
   * must be) would let a write land somewhere the caller never named.
   * @param root - the staging root.
   * @param entry - the relative entry name.
   * @returns nothing.
   * @throws when a parent component is a symlink or not a directory.
   */
  async function assertRealParents(root, entry) {
    const parts = String(entry).split('/')
    parts.pop()
    if (parts.length === 0) return
    let current = resolve(root)
    for (const part of parts) {
      current = join(current, part)
      let info = null
      try {
        info = await lstat(current)
      } catch (error) {
        info = null
      }
      if (info === null) return
      if (info.isSymbolicLink()) throw new Error('安装路径上有一层是符号链接，已拒绝：' + current)
      if (!info.isDirectory()) throw new Error('安装路径上有一层不是目录，已拒绝：' + current)
    }
  }
}

// ------------------------------------------------------------- scaffolding

/**
 * Read a caller's options bag without ever letting a hostile property break the
 * call: a getter that throws yields `undefined` instead of an exception, so
 * `search`, `detail` and `install` can read their inputs and still keep the
 * module's "never throws for discovery" promise.
 * @param value - whatever the caller passed.
 * @returns `{ query, source, limit, id, ref, version, root, force }`, each
 *   `undefined` when it could not be read.
 */
function readRequest(value) {
  const bag = value !== null && typeof value === 'object' ? value : {}
  const read = (key) => {
    try {
      return bag[key]
    } catch (error) {
      return undefined
    }
  }
  return {
    query: read('query'),
    source: read('source'),
    limit: read('limit'),
    id: read('id'),
    ref: read('ref'),
    version: read('version'),
    root: read('root'),
    force: read('force'),
  }
}

/** @returns the directory a file path lives in. */
function dirnameOf(target) {
  const index = Math.max(target.lastIndexOf(sep), target.lastIndexOf('/'))
  return index <= 0 ? target : target.slice(0, index)
}

/** @returns whether a raw path is absolute on this platform or on Windows. */
function isAbsolutePath(value) {
  const text = String(value || '')
  return text.startsWith('/') || text.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(text) || resolve(text) === text
}

/** @returns a `[{ path, size }]` list as a plain path list. */
function pathList(files) {
  const list = []
  for (const file of Array.isArray(files) ? files : []) {
    if (file === null || typeof file !== 'object') continue
    const path = typeof file.path === 'string' ? file.path : ''
    if (path !== '') list.push(path)
  }
  return list
}

/** @returns the first non-blank string of the candidates, or ''. */
function firstString(candidates) {
  for (const value of Array.isArray(candidates) ? candidates : []) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** @returns the first finite number of the candidates, or null. */
function firstNumber(candidates) {
  for (const value of Array.isArray(candidates) ? candidates : []) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  }
  return null
}

/** @returns the first candidate that is a semver string, or null. */
function firstSemver(candidates) {
  for (const value of Array.isArray(candidates) ? candidates : []) {
    if (typeof value === 'string' && SEMVER_RE.test(value.trim())) return value.trim()
  }
  return null
}

/**
 * Read a `fetch` reply once, as text or as bytes.
 *
 * The body is read through whichever method the reply actually has, because the
 * injectable seam in the unit suite is a plain object, not a real `Response`.
 * @param response - the reply.
 * @param asBytes - read a Buffer instead of a string.
 * @returns the normalized reply, or null when nothing readable came back.
 */
async function readReply(response, asBytes) {
  if (response === null || typeof response !== 'object') return null
  const status = Number(response.status)
  if (status === 304) return { status: 304, body: '', etag: headerOf(response.headers, 'etag') }
  if (!(status >= 200 && status < 300)) return { status: status, body: '', etag: headerOf(response.headers, 'etag') }
  let body = null
  try {
    if (asBytes) {
      if (typeof response.arrayBuffer === 'function') body = Buffer.from(await response.arrayBuffer())
      else if (typeof response.bytes === 'function') body = Buffer.from(await response.bytes())
      else if (typeof response.buffer === 'function') body = Buffer.from(await response.buffer())
      else if (typeof response.text === 'function') body = Buffer.from(await response.text(), 'utf8')
      else if (Buffer.isBuffer(response.body)) body = response.body
      else body = Buffer.alloc(0)
    } else if (typeof response.text === 'function') {
      body = await response.text()
    } else if (typeof response.text === 'string') {
      body = response.text
    } else if (Buffer.isBuffer(response.body)) {
      body = response.body.toString('utf8')
    } else {
      body = ''
    }
  } catch (error) {
    return null
  }
  return {
    status: status,
    body: asBytes ? Buffer.from(body) : (typeof body === 'string' ? body : String(body)),
    etag: headerOf(response.headers, 'etag'),
  }
}

/**
 * Read one header off a `fetch` Headers object or a plain object.
 * @param headers - `{ get(name) }` or a plain object.
 * @param name - the header name, lower-case.
 * @returns the trimmed value, or null.
 */
function headerOf(headers, name) {
  if (headers === null || headers === undefined) return null
  try {
    if (typeof headers.get === 'function') {
      const value = headers.get(name)
      return nonEmptyString(value) ? value.trim() : null
    }
  } catch (error) {
    return null
  }
  if (typeof headers === 'object') {
    const direct = headers[name]
    if (nonEmptyString(direct)) return direct.trim()
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name && nonEmptyString(headers[key])) return headers[key].trim()
    }
  }
  return null
}

/**
 * Race a promise against a budget, never rejecting.
 * @param promise - the work.
 * @param ms - the budget.
 * @param onTimeout - called once when the budget runs out.
 * @returns `{ ok, value }` or `{ ok: false, timedOut: true }`.
 */
function withinBudget(promise, ms, onTimeout) {
  return new Promise((resolvePromise) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      if (typeof onTimeout === 'function') {
        try {
          onTimeout()
        } catch (error) {
          // an abort that throws is still an abort
        }
      }
      resolvePromise({ ok: false, timedOut: true })
    }, ms)
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({ ok: true, value: value })
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({ ok: false, error: error })
      },
    )
  })
}

/** @returns an AbortController, or null where the runtime has none. */
function makeAbortController() {
  try {
    return new AbortController()
  } catch (error) {
    return null
  }
}

/** @returns the trimmed value when it is a quoted string, otherwise the value. */
function unquote(value) {
  const text = typeof value === 'string' ? value : ''
  if (text.length >= 2) {
    const first = text.charAt(0)
    const last = text.charAt(text.length - 1)
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1)
  }
  return text
}

/** @returns a count for ranking; a missing count sorts below zero. */
function countOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : -1
}

/** @returns a timestamp for ranking; a missing timestamp sorts below zero. */
function stampOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : -1
}

/** @returns whether a value is a non-blank string. */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * A positive whole integer, clamped.
 * @param value - the candidate.
 * @param fallback - the default.
 * @param max - the ceiling.
 * @returns the integer.
 */
function toPositiveInt(value, fallback, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(max, Math.floor(number))
}

/**
 * A positive whole-millisecond budget, or the fallback.
 * @param value - the candidate.
 * @param fallback - the default budget.
 * @returns the budget.
 */
function toBudget(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** @returns a failure as a message string. */
function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
