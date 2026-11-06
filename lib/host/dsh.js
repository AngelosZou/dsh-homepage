/**
 * dsh-homepage — host-side DSH release/commit sampler.
 *
 * Plain ESM, node builtins only, no dependencies. Answers "is there a new
 * commit or a new release in deepseek-ai/deepseek-harness?" from the Host
 * without an API token, because the anonymous api.github.com quota for a
 * shared or heavily used address is often already exhausted (`RATE_LIMITED`,
 * 0/60).
 *
 * Contract:
 * - The atom feeds are polled conditionally. Each feed is requested with the
 *    ETag remembered from last time; a 304 reuses the body from last time and
 *    marks that feed `not-modified`, so an empty 304 body is never parsed into
 *    an empty commit list.
 * - Per feed the routes are tried in order: a direct `fetch()` -> the same URL
 *    through the HTTP proxy (a hand-rolled CONNECT tunnel, because Node's
 *    `fetch` ignores HTTP_PROXY) -> the remembered body -> nothing. One feed
 *    failing never empties the other.
 * - `head` is the newest commit of the commit feed. When that feed yields no
 *    commit, `git ls-remote <repo>.git HEAD` is tried with the proxy in its
 *    environment, and only the sha is exposed. If that fails too, `head` is
 *    null and `reason` is `'network'`.
 * - A body that is not a feed (`<entry>` absent) leaves that feed empty and
 *    sets `reason: 'parse'`.
 * - When both live feeds fail and no body is remembered, the release is also
 *    read from the npm registry as a last resort: `registry.npmjs.org` first,
 *    then the mainland mirror `registry.npmmirror.com`. The route is published
 *    as `routes.releases: 'npm' | 'npmmirror'`, because a registry copy can lag
 *    behind the GitHub release; the card labels it instead of hiding it.
 * - The whole document is memoised for `ttlMs`; a document with no upstream
 *    data at all is memoised for `failureTtlMs` instead, so a transient failure
 *    cannot pin "unreadable" to the card for a full poll window. `force: true`
 *    bypasses the memo but still sends the remembered ETag, and
 *    `resetDshCache()` clears the ETags, the remembered bodies and the memo.
 * - `sampleDshRelease` never rejects: every field of the document is always
 *    present, and `reason` is always a string or null (never undefined).
 *
 * Every external effect is an option, so the unit suite is deterministic and
 * passes on a machine with no network at all: `fetchImpl`, `proxyGet`,
 * `runCommand`, `now`, `env` and the `timeoutMs`/`ttlMs`/`force`/`proxy`
 * knobs. Nothing is fetched, spawned or written at import time, and this
 * module never writes to disk.
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import tls from 'node:tls'
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib'

/** The repository this sampler watches. */
const DEFAULT_REPO = 'deepseek-ai/deepseek-harness'
/** The watched repository's default branch; reported for context only. */
const DEFAULT_BRANCH = 'master'
/** How long a single HTTP attempt may take. */
const DEFAULT_TIMEOUT_MS = 8000
/** How long a sampled document is served from memory. */
const DEFAULT_TTL_MS = 300000
/**
 * How long a document with no upstream reading at all is remembered. A failed
 * read is a fact about one moment, not a five-minute claim about the network.
 */
const DEFAULT_FAILURE_TTL_MS = 30000
/** The package whose published version is the npm fallback. */
const NPM_PACKAGE = '@deepseek-ai/dsh'
/** Registry base URLs, in preference order. */
const NPM_REGISTRIES = [
  { base: 'https://registry.npmjs.org', route: 'npm' },
  { base: 'https://registry.npmmirror.com', route: 'npmmirror' },
]
/** A registry is a fallback, not the primary read: do not spend a feed budget twice. */
const NPM_TIMEOUT_MS = 5000
/** How many newest commits the document carries. */
const MAX_COMMITS = 20
/** How many newest releases the document carries. */
const MAX_RELEASES = 5
/** What GitHub is told about the caller. */
const USER_AGENT = 'dsh-homepage'
/** Both feeds are Atom; the JSON API is never called. */
const FEED_ACCEPT = 'application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7'

/** The named entities an Atom feed realistically carries. */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  middot: '\u00b7',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  laquo: '\u00ab',
  raquo: '\u00bb',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  times: '\u00d7',
}

/** Last path segments that name a page rather than a tag. */
const NOT_A_TAG = new Set([
  'releases', 'tags', 'tag', 'commits', 'commit', 'branches', 'compare',
  'download', 'archive', 'releases.atom', 'commits.atom',
])

// ------------------------------------------------------------------ state

/** The memoised document, or null. */
let memo = null

/** The last body and ETag seen per feed, so the next poll can be conditional. */
const feedCache = {
  commits: { body: null, etag: null },
  releases: { body: null, etag: null },
}

// ------------------------------------------------------------- public API

/**
 * Drop every cached feed body, ETag and the memoised document.
 * @returns {void}
 */
export function resetDshCache() {
  memo = null
  feedCache.commits = { body: null, etag: null }
  feedCache.releases = { body: null, etag: null }
}

/**
 * Sample the repository's newest commit and its newest releases.
 *
 * Never rejects. An unexpected failure resolves to a complete document with
 * `reason: 'network'` and the failure text in `error`.
 * @param {object} [options] - the injectable seams: `repo`, `env`, `now`,
 *   `fetchImpl`, `proxyGet`, `runCommand`, `timeoutMs`, `ttlMs`, `force`,
 *   `proxy`.
 * @returns {Promise<object>} the DshDocument, with every field present.
 */
export async function sampleDshRelease(options = {}) {
  let deps = null
  let at = 0
  try {
    deps = resolveOptions(options)
    at = deps.now()
    if (!deps.force && memo !== null) {
      const age = at - memo.at
      const empty = memo.document.head === null && memo.document.release === null
      const budget = empty ? Math.min(deps.ttlMs, deps.failureTtlMs) : deps.ttlMs
      if (age < budget) {
        return Object.assign({}, memo.document, {
          at: at,
          sampleSeconds: secondsSince(at, deps.now()),
          cached: true,
        })
      }
    }
    const document = await gather(deps, at)
    memo = { at: at, document: document }
    return document
  } catch (error) {
    return degradedDocument(deps, at, error)
  }
}

/**
 * Parse an Atom feed into its entries, in feed order.
 *
 * Text is entity-decoded; titles have their whitespace collapsed to one line
 * (the commit titles arrive wrapped in newlines and indentation).
 * @param {string} xml - the raw feed body.
 * @returns {Array<object>} `[{ id, title, link, updated, author, content }]`.
 */
export function parseAtomEntries(xml) {
  if (typeof xml !== 'string' || xml === '') return []
  const entries = []
  const pattern = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi
  let match = pattern.exec(xml)
  while (match !== null) {
    const body = match[1]
    entries.push({
      id: textOf(body, 'id'),
      title: collapseWhitespace(decodeEntities(textOf(body, 'title'))),
      link: linkOf(body),
      updated: textOf(body, 'updated'),
      author: authorOf(body),
      content: decodeEntities(textOf(body, 'content')),
    })
    match = pattern.exec(xml)
  }
  return entries
}

/**
 * Turn one parsed feed entry into a commit record.
 *
 * The sha comes from the `Grit::Commit/<sha>` id, falling back to the
 * `…/commit/<sha>` link. An entry without a sha is not a commit.
 * @param {object} entry - one entry from `parseAtomEntries`.
 * @returns {null|object} `{ sha, short, message, author, date, url }`, or null.
 */
export function commitFromEntry(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const link = typeof entry.link === 'string' ? entry.link : ''
  const id = typeof entry.id === 'string' ? entry.id : ''
  const sha = shaFromId(id) || shaFromLink(link)
  if (sha === '') return null
  return {
    sha: sha,
    short: sha.slice(0, 7),
    message: collapseWhitespace(typeof entry.title === 'string' ? entry.title : ''),
    author: typeof entry.author === 'string' ? entry.author.trim() : '',
    date: typeof entry.updated === 'string' ? entry.updated.trim() : '',
    url: link,
  }
}

/**
 * Turn one parsed feed entry into a release record.
 *
 * The tag is the last path segment of the entry link (`…/releases/tag/<tag>`)
 * and the name is the entry title: for this repository the tag carries a
 * `dsh-` prefix the displayed version does not, and only the tag can be handed
 * to `git clone --branch`.
 * @param {object} entry - one entry from `parseAtomEntries`.
 * @returns {null|object} `{ tag, name, url, publishedAt }`, or null.
 */
export function releaseFromEntry(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const url = typeof entry.link === 'string' ? entry.link : ''
  const tag = tagFromLink(url)
  if (tag === '') return null
  return {
    tag: tag,
    name: collapseWhitespace(typeof entry.title === 'string' ? entry.title : ''),
    url: url,
    publishedAt: typeof entry.updated === 'string' ? entry.updated.trim() : '',
  }
}

/**
 * Decode the HTML entities an Atom feed carries, in a single pass.
 *
 * Single-pass matters: `&amp;lt;` decodes to `&lt;`, not to `<`. Unknown
 * entities and out-of-range numeric references are left exactly as they came.
 * @param {string} text - the raw text.
 * @returns {string} the decoded text; '' for a non-string.
 */
export function decodeEntities(text) {
  if (typeof text !== 'string') return ''
  if (text.indexOf('&') < 0) return text
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body.charAt(0) === '#') return decodeNumeric(body, whole)
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return typeof named === 'string' ? named : whole
  })
}

/**
 * Strip markup out of release notes, then collapse and trim the whitespace.
 *
 * The feed's `<content>` holds HTML escaped as text, so the entities are
 * decoded first and the tags they reveal are then removed.
 * @param {string} html - escaped or raw HTML.
 * @returns {string} the plain text; '' for a non-string.
 */
export function stripTags(html) {
  if (typeof html !== 'string' || html === '') return ''
  let text = decodeEntities(html)
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  text = text.replace(/<[^>]*>/g, ' ')
  return collapseWhitespace(text)
}

/**
 * Ask git for the remote HEAD sha.
 *
 * Runs `git ls-remote <repo>.git HEAD` through the injected `runCommand`, with
 * the proxy exported into the child's environment: a direct git fetch times out
 * on a proxied network while the proxied one answers in about a second.
 * @param {object} [options] - the same seams as `sampleDshRelease`.
 * @returns {Promise<null|string>} the 40-character sha, or null.
 */
export async function gitHeadSha(options = {}) {
  const deps = resolveOptions(options)
  const repoUrl = 'https://github.com/' + deps.repo + '.git'
  const args = ['ls-remote', repoUrl, 'HEAD']
  let pending = null
  try {
    pending = Promise.resolve(deps.runCommand('git', args, {
      timeoutMs: deps.timeoutMs,
      env: gitEnvironment(deps, proxyForUrl(deps, repoUrl)),
      windowsHide: true,
    }))
  } catch (error) {
    return null
  }
  const settled = await withinBudget(pending, deps.timeoutMs + 500)
  if (!settled.ok) return null
  const result = settled.value
  if (result === null || typeof result !== 'object' || result.ok !== true) return null
  return shaFromRemoteOutput(result.stdout)
}

// ------------------------------------------------------------- sampling

/**
 * Sample both feeds and assemble the document.
 * @param {object} deps - the resolved seams.
 * @param {number} at - this sample's start, from the injected clock.
 * @returns {Promise<object>} the DshDocument.
 */
async function gather(deps, at) {
  const outcomes = await Promise.all([safeFeed(deps, 'commits'), safeFeed(deps, 'releases')])
  const commits = collect('commits', outcomes[0].body).slice(0, MAX_COMMITS)
  const releases = collect('releases', outcomes[1].body).slice(0, MAX_RELEASES)
  let release = releases.length > 0 ? releases[0] : null
  let releaseRoute = outcomes[1].route
  // Only a failed release feed is replaced. An empty but valid feed is a fact
  // about the repository (it publishes no release), not a reason to ask npm.
  const releaseFailed = release === null
    && (outcomes[1].body === null || notAFeed(outcomes[1].body))
  // Start the registry fallback beside the git fallback: an offline read must
  // not pay for two sequential timeouts.
  const npmFallback = releaseFailed ? resolveNpmRelease(deps) : null
  const head = await resolveHead(deps, commits)
  if (npmFallback !== null) {
    const fallback = await npmFallback
    if (fallback !== null) {
      release = fallback.release
      releaseRoute = fallback.route
    }
  }
  const document = blankDocument(deps, at)
  document.head = head.value
  document.commits = commits
  document.release = release
  document.releases = releases
  document.routes = {
    commits: outcomes[0].route,
    releases: releaseRoute,
    head: head.route,
  }
  document.cached = outcomes[0].reused || outcomes[1].reused
  document.reason = reasonsFor(outcomes[0], outcomes[1], head.value)
  document.sampleSeconds = secondsSince(at, deps.now())
  return document
}

/**
 * Sample one feed, absorbing any failure so the other feed still answers.
 * @param {object} deps - the resolved seams.
 * @param {string} kind - 'commits' or 'releases'.
 * @returns {Promise<object>} `{ route, body, reused }`.
 */
async function safeFeed(deps, kind) {
  try {
    return await sampleFeed(deps, kind)
  } catch (error) {
    const remembered = feedCache[kind]
    return {
      route: 'error',
      body: remembered.body,
      reused: remembered.body !== null,
    }
  }
}

/**
 * Try one feed's routes in order and remember what came back.
 * @param {object} deps - the resolved seams.
 * @param {string} kind - 'commits' or 'releases'.
 * @returns {Promise<object>} `{ route, body, reused }`.
 */
async function sampleFeed(deps, kind) {
  const feed = feedCache[kind]
  const url = feedUrl(deps.repo, kind)
  const headers = feedHeaders(feed)

  const direct = await fetchDirect(deps, url, headers)
  if (direct !== null) return settleFeed(kind, 'direct', direct)

  const proxied = await fetchThroughProxy(deps, url, headers)
  if (proxied !== null) return settleFeed(kind, 'proxy', proxied)

  if (feed.body !== null) return { route: 'error', body: feed.body, reused: true }
  return { route: 'error', body: null, reused: false }
}

/**
 * Fold one successful request result into the feed memory.
 * @param {string} kind - 'commits' or 'releases'.
 * @param {string} route - the route that answered, for a fresh body.
 * @param {object} result - `{ status, body, etag }`.
 * @returns {object} `{ route, body, reused }`.
 */
function settleFeed(kind, route, result) {
  const feed = feedCache[kind]
  if (result.status === 304 && feed.body !== null) {
    if (result.etag !== null) feed.etag = result.etag
    return { route: 'not-modified', body: feed.body, reused: true }
  }
  feed.body = result.body
  feed.etag = result.etag
  return { route: route, body: result.body, reused: false }
}

/**
 * Take the head from the newest commit, or from git when the feed is silent.
 * @param {object} deps - the resolved seams.
 * @param {Array<object>} commits - the commits read from the feed.
 * @returns {Promise<object>} `{ value, route }`.
 */
async function resolveHead(deps, commits) {
  if (commits.length > 0) return { value: commits[0], route: 'direct' }
  const sha = await gitHeadSha(deps)
  if (sha === null) return { value: null, route: null }
  return { value: shaOnlyHead(sha), route: 'git' }
}

/**
 * Read the newest published version from an npm registry, as a last resort.
 *
 * This is a version fallback, not a second release feed: the registry record
 * carries the version and its publish time but not the commit, and a registry
 * copy can lag behind GitHub. The route name says which registry answered so
 * the card can label the value instead of presenting it as the same reading.
 * @param {object} deps - the resolved seams.
 * @returns {Promise<null|object>} `{ route, release }`, or null.
 */
async function resolveNpmRelease(deps) {
  if (typeof deps.fetchImpl !== 'function' && typeof deps.proxyGet !== 'function') return null
  // Both registries are asked at once, and the official one wins if both
  // answer. Sequential attempts would add two more timeouts to an offline read.
  const attempts = NPM_REGISTRIES.map((registry) => resolveNpmRegistry(deps, registry))
  const results = await Promise.all(attempts)
  for (const result of results) {
    if (result !== null) return result
  }
  return null
}

/**
 * Ask one npm registry for its `/latest` manifest.
 * @param {object} deps - the resolved seams.
 * @param {object} registry - `{ base, route }`.
 * @returns {Promise<null|object>} `{ route, release }`, or null.
 */
async function resolveNpmRegistry(deps, registry) {
  const url = registry.base + '/' + NPM_PACKAGE.replace('/', '%2F') + '/latest'
  const payload = await fetchJson(deps, url, Math.min(deps.timeoutMs, NPM_TIMEOUT_MS))
  return npmReleaseFrom(payload, registry.route)
}

/**
 * Turn an npm registry's `/latest` manifest into a release record.
 *
 * The package name and repository are both checked: the fallback may answer
 * through a mirror, and a mirror serving a different package under the same
 * name would otherwise become the version the card tells the user to install.
 * @param {*} payload - the manifest, or anything a bad route returned.
 * @param {string} route - `'npm'` or `'npmmirror'`.
 * @returns {null|object} `{ route, release }`, or null.
 */
function npmReleaseFrom(payload, route) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  if (payload.name !== NPM_PACKAGE) return null
  const version = typeof payload.version === 'string' ? payload.version.trim() : ''
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return null
  const repository = payload.repository && typeof payload.repository.url === 'string'
    ? payload.repository.url
    : ''
  if (!/deepseek-harness/i.test(repository)) return null
  const published = typeof payload.publish_time === 'string'
    ? payload.publish_time
    : (typeof payload._cnpmcore_publish_time === 'string' ? payload._cnpmcore_publish_time : '')
  return {
    route: route,
    release: {
      tag: 'dsh-v' + version,
      name: version.charAt(0) === 'v' ? version : 'v' + version,
      url: 'https://github.com/' + DEFAULT_REPO + '/releases/tag/dsh-v' + version,
      publishedAt: published,
    },
  }
}

/**
 * Read one feed's entries as commit or release records.
 * @param {string} kind - 'commits' or 'releases'.
 * @param {null|string} body - the feed body.
 * @returns {Array<object>} the records, malformed entries dropped.
 */
function collect(kind, body) {
  const items = []
  for (const entry of parseAtomEntries(body)) {
    const item = kind === 'commits' ? commitFromEntry(entry) : releaseFromEntry(entry)
    if (item !== null) items.push(item)
  }
  return items
}

/**
 * Decide the document's single `reason` code.
 * @param {object} commits - the commit feed outcome.
 * @param {object} releases - the release feed outcome.
 * @param {null|object} head - the head, if any.
 * @returns {null|string} null, 'parse' or 'network'.
 */
function reasonsFor(commits, releases, head) {
  if (notAFeed(commits.body) || notAFeed(releases.body)) return 'parse'
  if (head === null) return 'network'
  return null
}

/**
 * Whether a body arrived but is not a feed at all.
 * @param {null|string} body - the feed body.
 * @returns {boolean} true when the body carries no `<entry>`.
 */
function notAFeed(body) {
  return typeof body === 'string' && !/<entry\b/i.test(body)
}

/**
 * A head known only by sha, as the git route can report it.
 * @param {string} sha - the 40-character sha.
 * @returns {object} `{ sha, short, message, author, date, url }`.
 */
function shaOnlyHead(sha) {
  return { sha: sha, short: sha.slice(0, 7), message: '', author: '', date: '', url: '' }
}

// --------------------------------------------------------------- requests

/**
 * Build the request headers for one feed, conditional on what is remembered.
 * @param {object} feed - the feed's remembered `{ body, etag }`.
 * @returns {object} the headers.
 */
function feedHeaders(feed) {
  const headers = {
    'user-agent': USER_AGENT,
    accept: FEED_ACCEPT,
    'accept-encoding': 'identity',
  }
  if (feed.etag !== null && feed.body !== null) headers['if-none-match'] = feed.etag
  return headers
}

/**
 * Request one feed directly, with `fetch`.
 * @param {object} deps - the resolved seams.
 * @param {string} url - the feed URL.
 * @param {object} headers - the request headers.
 * @returns {Promise<null|object>} `{ status, body, etag }` or null when the
 *   route did not answer with something usable.
 */
async function fetchDirect(deps, url, headers) {
  if (typeof deps.fetchImpl !== 'function') return null
  const controller = makeAbortController()
  let started = null
  try {
    started = Promise.resolve(deps.fetchImpl(url, {
      headers: headers,
      signal: controller === null ? undefined : controller.signal,
    }))
  } catch (error) {
    return null
  }
  const settled = await withinBudget(started.then((response) => normalizeResponse(response)), deps.timeoutMs, () => {
    if (controller !== null) controller.abort()
  })
  if (!settled.ok) return null
  return settled.value
}

/**
 * Request one feed through the proxy seam.
 * @param {object} deps - the resolved seams.
 * @param {string} url - the feed URL.
 * @param {object} headers - the request headers.
 * @returns {Promise<null|object>} `{ status, body, etag }` or null.
 */
async function fetchThroughProxy(deps, url, headers) {
  const proxy = proxyForUrl(deps, url)
  if (proxy === null || typeof deps.proxyGet !== 'function') return null
  let started = null
  try {
    started = Promise.resolve(deps.proxyGet(url, proxy, {
      timeoutMs: deps.timeoutMs,
      headers: headers,
    }))
  } catch (error) {
    return null
  }
  const settled = await withinBudget(started.then((response) => normalizeResponse(response)), deps.timeoutMs)
  if (!settled.ok) return null
  return settled.value
}

/**
 * Normalize a fetch/proxy reply into `{ status, body, etag }`.
 *
 * The proxy seam may hand back its text as a string instead of a `text()`
 * method, so both shapes are accepted.
 * @param {object} response - the reply.
 * @returns {Promise<null|object>} the normalized reply, or null.
 */
async function normalizeResponse(response) {
  if (response === null || typeof response !== 'object') return null
  const status = Number(response.status)
  if (status === 304) return { status: 304, body: '', etag: headerOf(response.headers, 'etag') }
  if (!(status >= 200 && status < 300)) return null
  let text = null
  try {
    if (typeof response.text === 'function') text = await response.text()
    else if (typeof response.text === 'string') text = response.text
    else text = ''
  } catch (error) {
    return null
  }
  return {
    status: status,
    body: typeof text === 'string' ? text : String(text),
    etag: headerOf(response.headers, 'etag'),
  }
}

/**
 * Request one JSON document, directly first and then through the proxy tunnel.
 *
 * The npm fallback needs a parsed body, not a feed. A plain `fetch` already
 * follows the proxy policy DSH installs; the tunnel is the fallback for a host
 * whose Node fetch has no dispatcher, so the same two routes that serve a feed
 * also serve the registry.
 * @param {object} deps - the resolved seams.
 * @param {string} url - the JSON URL.
 * @returns {Promise<null|object>} the parsed body, or null.
 */
async function fetchJson(deps, url, timeoutMs) {
  const budget = toBudget(timeoutMs, deps.timeoutMs)
  const headers = {
    'user-agent': USER_AGENT,
    accept: 'application/json',
    'accept-encoding': 'identity',
  }
  if (typeof deps.fetchImpl === 'function') {
    const controller = makeAbortController()
    let started = null
    try {
      started = Promise.resolve(deps.fetchImpl(url, {
        headers: headers,
        signal: controller === null ? undefined : controller.signal,
      }))
    } catch (error) {
      started = null
    }
    if (started !== null) {
      const settled = await withinBudget(started.then((response) => normalizeJson(response)), budget, () => {
        if (controller !== null) controller.abort()
      })
      if (settled.ok && settled.value !== null) return settled.value
    }
  }
  // Same fallback chain as a feed: a host whose Node fetch has no harness
  // dispatcher still has the manual CONNECT tunnel to try.
  const proxy = proxyForUrl(deps, url)
  if (proxy === null || typeof deps.proxyGet !== 'function') return null
  let proxied = null
  try {
    proxied = Promise.resolve(deps.proxyGet(url, proxy, { timeoutMs: budget, headers: headers }))
  } catch (error) {
    return null
  }
  const settled = await withinBudget(proxied.then((response) => normalizeJson(response)), budget)
  return settled.ok ? settled.value : null
}

/**
 * Read a JSON reply, accepting the same string/text shapes as `normalizeResponse`.
 * @param {object} response - the reply.
 * @returns {Promise<null|object>} the parsed object, or null.
 */
async function normalizeJson(response) {
  if (response === null || typeof response !== 'object') return null
  const status = Number(response.status)
  if (!(status >= 200 && status < 300)) return null
  let text = null
  try {
    if (typeof response.text === 'function') text = await response.text()
    else if (typeof response.text === 'string') text = response.text
    else text = ''
  } catch (error) {
    return null
  }
  if (typeof text !== 'string' || text === '') return null
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch (error) {
    return null
  }
}

/**
 * Read one header off a `fetch` Headers object or a plain object.
 * @param {object} headers - `{ get(name) }` or a plain object.
 * @param {string} name - the header name, lower-case.
 * @returns {null|string} the trimmed value, or null.
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
 * The two feed URLs.
 * @param {string} repo - `owner/name`.
 * @param {string} kind - 'commits' or 'releases'.
 * @returns {string} the atom feed URL.
 */
function feedUrl(repo, kind) {
  return 'https://github.com/' + repo + '/' + (kind === 'releases' ? 'releases.atom' : 'commits.atom')
}

// ------------------------------------------------------------ proxy route

/**
 * Fetch one URL through an HTTP proxy with a hand-rolled CONNECT tunnel.
 *
 * Node's `fetch` ignores HTTP_PROXY, so the tunnel is built directly: CONNECT
 * to the proxy, wrap the socket in TLS, then speak HTTP/1.1 over it. Chunked
 * and gzip/deflate/br bodies are unwrapped so the caller always gets text.
 * @param {string} url - the absolute target URL.
 * @param {string} proxyUrl - the proxy, e.g. `http://127.0.0.1:7890`.
 * @param {object} [options] - `{ timeoutMs, headers }`.
 * @returns {Promise<object>} `{ status, headers, text }`.
 */
function defaultProxyGet(url, proxyUrl, options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  return new Promise((resolve, reject) => {
    let target = null
    let proxy = null
    try {
      target = new URL(url)
      proxy = new URL(proxyUrl)
    } catch (error) {
      reject(new Error('dsh: invalid url or proxy: ' + errorText(error)))
      return
    }
    const secure = target.protocol === 'https:'
    const targetPort = target.port !== '' ? target.port : (secure ? '443' : '80')
    const proxyPort = proxy.port !== '' ? Number(proxy.port) : (proxy.protocol === 'https:' ? 443 : 80)
    const timeoutMs = toBudget(settings.timeoutMs, DEFAULT_TIMEOUT_MS)
    const requestHeaders = mergeHeaders({}, settings.headers)
    requestHeaders.host = target.host
    requestHeaders['user-agent'] = requestHeaders['user-agent'] || USER_AGENT
    requestHeaders.accept = requestHeaders.accept || FEED_ACCEPT
    requestHeaders['accept-encoding'] = 'identity'
    requestHeaders.connection = 'close'
    const requestText = 'GET ' + target.pathname + target.search + ' HTTP/1.1\r\n'
      + headerLines(requestHeaders).join('\r\n') + '\r\n\r\n'

    let finished = false
    let timer = null
    let stream = null
    const finish = (settle, value) => {
      if (finished) return
      finished = true
      if (timer !== null) clearTimeout(timer)
      settle(value)
    }
    timer = setTimeout(() => {
      if (stream !== null) stream.destroy()
      finish(reject, new Error('dsh: proxy timeout after ' + timeoutMs + 'ms'))
    }, timeoutMs)

    const tunnel = http.request({
      host: proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: target.hostname + ':' + targetPort,
      headers: proxyHeaders(proxy, target.hostname + ':' + targetPort),
      timeout: timeoutMs,
    })
    tunnel.on('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        finish(reject, new Error('dsh: CONNECT ' + response.statusCode))
        return
      }
      const chunks = []
      const read = (source) => {
        source.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        source.on('end', () => {
          try {
            const parsed = parseHttpResponse(Buffer.concat(chunks))
            finish(resolve, { status: parsed.status, headers: parsed.headers, text: parsed.body.toString('utf8') })
          } catch (error) {
            finish(reject, error)
          }
        })
      }
      if (secure) {
        stream = tls.connect({ socket: socket, servername: target.hostname }, () => {
          stream.write(requestText)
        })
        stream.on('error', (error) => finish(reject, error))
        read(stream)
      } else {
        stream = socket
        stream.on('error', (error) => finish(reject, error))
        stream.write(requestText)
        read(stream)
      }
    })
    tunnel.on('timeout', () => {
      tunnel.destroy()
      finish(reject, new Error('dsh: CONNECT timeout'))
    })
    tunnel.on('error', (error) => finish(reject, error))
    tunnel.end()
  })
}

/**
 * Split a raw HTTP/1.1 reply into status, headers and an unwrapped body.
 * @param {Buffer} buffer - the whole reply.
 * @returns {object} `{ status, headers, body }`, headers lower-cased with a
 *   `get(name)` reader.
 */
function parseHttpResponse(buffer) {
  const split = buffer.indexOf('\r\n\r\n')
  if (split < 0) throw new Error('dsh: malformed HTTP reply (no header terminator)')
  const lines = buffer.slice(0, split).toString('latin1').split('\r\n')
  const statusMatch = /^HTTP\/\d\.\d\s+(\d{3})/.exec(lines[0] || '')
  const fields = {}
  for (let index = 1; index < lines.length; index += 1) {
    const colon = lines[index].indexOf(':')
    if (colon <= 0) continue
    const name = lines[index].slice(0, colon).trim().toLowerCase()
    const value = lines[index].slice(colon + 1).trim()
    if (name === '') continue
    fields[name] = Object.prototype.hasOwnProperty.call(fields, name) ? fields[name] + ', ' + value : value
  }
  let body = buffer.slice(split + 4)
  if (typeof fields['transfer-encoding'] === 'string' && fields['transfer-encoding'].toLowerCase().indexOf('chunked') >= 0) {
    body = dechunk(body)
  }
  const encoding = typeof fields['content-encoding'] === 'string' ? fields['content-encoding'].toLowerCase().trim() : ''
  if (encoding === 'gzip' || encoding === 'x-gzip') body = gunzipSync(body)
  else if (encoding === 'deflate') {
    try {
      body = inflateSync(body)
    } catch (error) {
      body = inflateRawSync(body)
    }
  } else if (encoding === 'br') body = brotliDecompressSync(body)

  const headers = {}
  for (const key of Object.keys(fields)) headers[key] = fields[key]
  headers.get = (name) => {
    const key = String(name).toLowerCase()
    return Object.prototype.hasOwnProperty.call(headers, key) ? headers[key] : null
  }
  return {
    status: statusMatch === null ? 0 : Number(statusMatch[1]),
    headers: headers,
    body: body,
  }
}

/**
 * Unwrap an HTTP chunked body.
 * @param {Buffer} buffer - the chunked body.
 * @returns {Buffer} the payload.
 */
function dechunk(buffer) {
  const parts = []
  let start = 0
  while (start < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', start)
    if (lineEnd < 0) break
    const size = parseInt(buffer.slice(start, lineEnd).toString('latin1').split(';')[0].trim(), 16)
    if (!Number.isFinite(size) || size <= 0) break
    const from = lineEnd + 2
    parts.push(buffer.slice(from, Math.min(from + size, buffer.length)))
    start = from + size + 2
  }
  return Buffer.concat(parts)
}

/**
 * Build the CONNECT headers, with proxy credentials when the URL carries them.
 * @param {URL} proxy - the parsed proxy URL.
 * @param {string} authority - `host:port` of the target.
 * @returns {object} the CONNECT headers.
 */
function proxyHeaders(proxy, authority) {
  const headers = { host: authority, 'proxy-connection': 'keep-alive' }
  if (proxy.username !== '') {
    const user = safeDecode(proxy.username)
    const pass = safeDecode(proxy.password)
    headers['proxy-authorization'] = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64')
  }
  return headers
}

/**
 * Keep only string header values and copy them onto a target object.
 * @param {object} target - the object written to.
 * @param {object} source - the candidate headers.
 * @returns {object} the target.
 */
function mergeHeaders(target, source) {
  if (source === null || typeof source !== 'object') return target
  for (const key of Object.keys(source)) {
    if (typeof source[key] === 'string' && source[key] !== '') target[key.toLowerCase()] = source[key]
  }
  return target
}

/**
 * Render headers as request lines, refusing to carry a CRLF in a value.
 * @param {object} headers - the headers.
 * @returns {Array<string>} `name: value` lines.
 */
function headerLines(headers) {
  const lines = []
  for (const key of Object.keys(headers)) {
    const name = key.replace(/[\r\n:]/g, '')
    if (name === '') continue
    lines.push(name + ': ' + String(headers[key]).replace(/[\r\n]+/g, ' '))
  }
  return lines
}

// ----------------------------------------------------------- git fallback

/**
 * The child environment for git: the injected env plus the proxy, so a direct
 * `ls-remote` that would hang is sent through the proxy instead.
 * @param {object} deps - the resolved seams.
 * @returns {object} the environment.
 */
function gitEnvironment(deps, proxy) {
  const environment = {}
  const source = deps.env !== null && typeof deps.env === 'object' ? deps.env : {}
  for (const key of Object.keys(source)) {
    if (typeof source[key] === 'string') environment[key] = source[key]
  }
  environment.GIT_TERMINAL_PROMPT = '0'
  // A target `NO_PROXY` bypasses is also bypassed by git: the two routes must
  // agree, or a direct git call would tunnel where the fetch route did not.
  if (proxy !== null && proxy !== undefined) {
    environment.HTTPS_PROXY = proxy
    environment.https_proxy = proxy
    environment.HTTP_PROXY = proxy
    environment.http_proxy = proxy
  }
  return environment
}

/**
 * The first sha in `git ls-remote` output, preferring the HEAD line.
 * @param {string} stdout - the command output.
 * @returns {null|string} the sha, or null.
 */
function shaFromRemoteOutput(stdout) {
  if (typeof stdout !== 'string') return null
  let first = null
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*([0-9a-fA-F]{40})\s+(\S+)\s*$/.exec(line)
    if (match === null) continue
    if (match[2] === 'HEAD') return match[1].toLowerCase()
    if (first === null) first = match[1].toLowerCase()
  }
  return first
}

/**
 * Spawn `command` through `node:child_process`, bounded by a timeout.
 * @param {string} command - the executable.
 * @param {Array<string>} args - its arguments.
 * @param {object} [options] - `{ env, timeoutMs }`.
 * @returns {Promise<object>} `{ ok, stdout, stderr, code }`.
 */
function defaultRunCommand(command, args, options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const timeoutMs = toBudget(settings.timeoutMs, DEFAULT_TIMEOUT_MS)
  return new Promise((resolve) => {
    let child = null
    try {
      child = spawn(command, Array.isArray(args) ? args : [], {
        env: settings.env === undefined ? process.env : settings.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: errorText(error), code: -1 })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch (error) {
        // the child is already gone
      }
      resolve({ ok: false, stdout: stdout, stderr: stderr, code: -1 })
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, stdout: stdout, stderr: errorText(error), code: -1 })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout: stdout, stderr: stderr, code: typeof code === 'number' ? code : -1 })
    })
  })
}

// -------------------------------------------------------------- scaffolding

/**
 * Resolve an options bag into the seams the sampler runs on.
 * @param {object} options - the caller's options.
 * @returns {object} the resolved seams.
 */
function resolveOptions(options) {
  const input = options !== null && typeof options === 'object' ? options : {}
  const env = input.env !== null && typeof input.env === 'object' ? input.env : process.env
  return {
    repo: nonEmptyString(input.repo) ? input.repo.trim() : DEFAULT_REPO,
    env: env,
    now: typeof input.now === 'function' ? input.now : Date.now,
    fetchImpl: typeof input.fetchImpl === 'function'
      ? input.fetchImpl
      : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null),
    proxyGet: typeof input.proxyGet === 'function' ? input.proxyGet : defaultProxyGet,
    runCommand: typeof input.runCommand === 'function' ? input.runCommand : defaultRunCommand,
    timeoutMs: toBudget(input.timeoutMs, DEFAULT_TIMEOUT_MS),
    ttlMs: toBudget(input.ttlMs, DEFAULT_TTL_MS),
    failureTtlMs: toBudget(input.failureTtlMs, DEFAULT_FAILURE_TTL_MS),
    force: input.force === true,
    // `proxy` is an explicit caller override (tests and embedders); the
    // environment is resolved per target scheme in `proxyForUrl`, because an
    // unusable HTTPS_PROXY must not silently borrow HTTP_PROXY for https.
    proxy: nonEmptyString(input.proxy) ? input.proxy.trim() : null,
    noProxy: noProxyFromEnvironment(env),
  }
}

/**
 * The proxy configured in an environment object.
 * @param {object} env - the environment.
 * @returns {null|string} the proxy URL, or null.
 */
function proxyFromEnvironmentFor(env, protocol) {
  if (env === null || typeof env !== 'object') return null
  // Scheme-specific first, then the shared fallback. A value this module cannot
  // use (SOCKS, malformed) is skipped exactly as the harness skips it; in
  // particular an unusable HTTPS_PROXY must not borrow HTTP_PROXY for https.
  const names = protocol === 'https:'
    ? ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']
    : ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
  for (const key of names) {
    let value = null
    try {
      value = env[key]
    } catch (error) {
      value = null
    }
    const usable = usableProxy(value)
    if (usable !== null) return usable
  }
  return null
}

/**
 * Keep only an HTTP(S) proxy URL. The harness refuses `socks5://` and keeps
 * that scheme direct; this module must not answer a route the harness would
 * not take, or `HTTPS_PROXY=socks5://…` would be tried as an HTTP tunnel.
 * @param {*} value - the environment value.
 * @returns {null|string} the trimmed URL, or null.
 */
function usableProxy(value) {
  if (!nonEmptyString(value)) return null
  const text = value.trim()
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? text : null
  } catch (error) {
    return null
  }
}

/**
 * The `NO_PROXY` list configured in an environment object.
 * @param {object} env - the environment.
 * @returns {string} the raw list, or ''.
 */
function noProxyFromEnvironment(env) {
  if (env === null || typeof env !== 'object') return ''
  for (const key of ['NO_PROXY', 'no_proxy']) {
    let value = null
    try {
      value = env[key]
    } catch (error) {
      value = null
    }
    if (nonEmptyString(value)) return value.trim()
  }
  return ''
}

/**
 * The proxy this module should use for one URL, or null for a direct request.
 *
 * Mirrors the harness rule the docs state: loopback is never proxied, `NO_PROXY`
 * entries match a host and its subdomains (optionally with a port), a leading
 * `.` or `*.` is accepted, `*` bypasses everything, and CIDR entries do not
 * apply. A proxy URL in the environment is still used when the target is not
 * bypassed.
 * @param {object} deps - the resolved seams.
 * @param {string} url - the absolute target URL.
 * @returns {null|string} the proxy URL, or null.
 */
function proxyForUrl(deps, url) {
  let target = null
  try {
    target = new URL(url)
  } catch (error) {
    return deps.proxy
  }
  if (isLoopbackHost(target.hostname)) return null
  if (noProxyMatches(deps.noProxy, target)) return null
  if (deps.proxy !== null && deps.proxy !== undefined) return deps.proxy
  return proxyFromEnvironmentFor(deps.env, target.protocol)
}

/**
 * Whether a `NO_PROXY` list bypasses one target.
 * @param {string} list - the raw `NO_PROXY` value.
 * @param {URL} target - the parsed target URL.
 * @returns {boolean} true when the target must go direct.
 */
function noProxyMatches(list, target) {
  if (typeof list !== 'string' || list.trim() === '') return false
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const port = target.port !== '' ? target.port : (target.protocol === 'https:' ? '443' : '80')
  for (const raw of list.split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    const parsed = splitNoProxyEntry(entry)
    if (parsed === null) continue
    const suffix = parsed.host
    const matchesHost = host === suffix || host.endsWith('.' + suffix)
    if (matchesHost && (parsed.port === null || parsed.port === port)) return true
  }
  return false
}

/**
 * Split one `NO_PROXY` entry into a host suffix and an optional port.
 * @param {string} entry - one trimmed lower-case entry.
 * @returns {null|object} `{ host, port }`, or null for a CIDR/blank entry.
 */
function splitNoProxyEntry(entry) {
  let value = entry
  if (value.startsWith('*.')) value = value.slice(2)
  else if (value.startsWith('.')) value = value.slice(1)
  if (value === '') return null
  if (value.includes('/')) return null
  let port = null
  // A trailing `:digits` is a port; an IPv6 literal without brackets is not
  // given that meaning because the host itself can contain colons.
  if (!value.startsWith('[') && /:\d+$/.test(value)) {
    const at = value.lastIndexOf(':')
    port = value.slice(at + 1)
    value = value.slice(0, at)
  }
  if (value === '') return null
  return { host: value.replace(/^\[|\]$/g, ''), port: port }
}

/**
 * Whether a host names this machine.
 * @param {string} host - the hostname.
 * @returns {boolean} true for loopback, `localhost` and the wildcard address.
 */
function isLoopbackHost(host) {
  const value = String(host || '').toLowerCase()
  return value === 'localhost' || value === '::1' || value === '0.0.0.0'
    || /^127\./.test(value)
}

/**
 * The document skeleton, with every contract field present.
 * @param {null|object} deps - the resolved seams, when they resolved.
 * @param {number} at - this sample's start.
 * @returns {object} the blank document.
 */
function blankDocument(deps, at) {
  return {
    at: Number.isFinite(at) && at > 0 ? at : Date.now(),
    sampleSeconds: 0,
    repo: deps !== null && nonEmptyString(deps.repo) ? deps.repo : DEFAULT_REPO,
    branch: DEFAULT_BRANCH,
    head: null,
    commits: [],
    release: null,
    releases: [],
    routes: { commits: null, releases: null, head: null },
    cached: false,
    reason: null,
    error: null,
  }
}

/**
 * The document returned when the sampling itself failed.
 * @param {null|object} deps - the resolved seams, when they resolved.
 * @param {number} at - this sample's start.
 * @param {Error} error - what went wrong.
 * @returns {object} a complete document explaining the failure.
 */
function degradedDocument(deps, at, error) {
  const document = blankDocument(deps, at)
  document.reason = 'network'
  document.error = errorText(error)
  try {
    document.sampleSeconds = secondsSince(at, deps === null ? at : deps.now())
  } catch (inner) {
    document.sampleSeconds = 0
  }
  return document
}

/**
 * Race a promise against a budget, never rejecting.
 * @param {Promise} promise - the work.
 * @param {number} ms - the budget.
 * @param {Function} [onTimeout] - called once when the budget runs out.
 * @returns {Promise<object>} `{ ok, value }` or `{ ok: false, timedOut }`.
 */
function withinBudget(promise, ms, onTimeout) {
  return new Promise((resolve) => {
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
      resolve({ ok: false, timedOut: true })
    }, ms)
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: true, value: value })
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, error: error })
      },
    )
  })
}

/**
 * An AbortController, or null where the runtime has none.
 * @returns {null|AbortController} the controller.
 */
function makeAbortController() {
  try {
    return new AbortController()
  } catch (error) {
    return null
  }
}

/**
 * The text between two tags, entity-decoded and trimmed.
 * @param {string} body - one entry's XML.
 * @param {string} tag - the tag name.
 * @returns {string} the text, or ''.
 */
function textOf(body, tag) {
  const match = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i').exec(body)
  return match === null ? '' : decodeEntities(match[1]).trim()
}

/**
 * The `href` of an entry's link, preferring `rel="alternate"`.
 * @param {string} body - one entry's XML.
 * @returns {string} the href, or ''.
 */
function linkOf(body) {
  const pattern = /<link\b[^>]*>/gi
  let fallback = ''
  let match = pattern.exec(body)
  while (match !== null) {
    const href = /href\s*=\s*"([^"]*)"/i.exec(match[0])
    if (href !== null) {
      const value = decodeEntities(href[1]).trim()
      if (value !== '') {
        if (/rel\s*=\s*"alternate"/i.test(match[0])) return value
        if (fallback === '') fallback = value
      }
    }
    match = pattern.exec(body)
  }
  return fallback
}

/**
 * The author name of one entry.
 * @param {string} body - one entry's XML.
 * @returns {string} the name, or ''.
 */
function authorOf(body) {
  const match = /<author\b[^>]*>([\s\S]*?)<\/author>/i.exec(body)
  return match === null ? '' : textOf(match[1], 'name')
}

/**
 * The sha carried in an entry id.
 * @param {string} id - the entry id.
 * @returns {string} the sha, or ''.
 */
function shaFromId(id) {
  const match = /Grit::Commit\/([0-9a-fA-F]{7,40})/.exec(id)
  return match === null ? '' : match[1].toLowerCase()
}

/**
 * The sha carried in a commit link.
 * @param {string} link - the entry link.
 * @returns {string} the sha, or ''.
 */
function shaFromLink(link) {
  const match = /\/commit\/([0-9a-fA-F]{7,40})(?:[?#]|$)/.exec(link)
  return match === null ? '' : match[1].toLowerCase()
}

/**
 * The tag carried in a release link's last path segment.
 * @param {string} url - the entry link.
 * @returns {string} the tag, or '' when the link is not a tag page.
 */
function tagFromLink(url) {
  if (url === '') return ''
  let path = url.split('#')[0].split('?')[0]
  try {
    path = new URL(url).pathname
  } catch (error) {
    // a relative link still has a usable path
  }
  const segments = path.split('/').filter((segment) => segment !== '')
  if (segments.length === 0) return ''
  const raw = segments[segments.length - 1]
  const tag = raw.indexOf('%') >= 0 ? safeDecode(raw) : raw
  if (tag === '' || NOT_A_TAG.has(tag.toLowerCase())) return ''
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(tag) ? tag : ''
}

/**
 * Decode one numeric character reference, or keep it verbatim.
 * @param {string} body - the reference without `&` and `;`.
 * @param {string} whole - the untouched reference.
 * @returns {string} the character, or the reference.
 */
function decodeNumeric(body, whole) {
  const hexadecimal = body.charAt(1) === 'x' || body.charAt(1) === 'X'
  const code = parseInt(hexadecimal ? body.slice(2) : body.slice(1), hexadecimal ? 16 : 10)
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
  if (code >= 0xd800 && code <= 0xdfff) return whole
  try {
    return String.fromCodePoint(code)
  } catch (error) {
    return whole
  }
}

/**
 * Collapse runs of whitespace and trim the ends.
 * @param {string} text - the text.
 * @returns {string} one clean line.
 */
function collapseWhitespace(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
}

/**
 * Round a duration to whole hundredths of a second.
 * @param {number} at - the start, in epoch ms.
 * @param {number} now - the end, in epoch ms.
 * @returns {number} the rounded seconds.
 */
function secondsSince(at, now) {
  const elapsed = Number.isFinite(now) && Number.isFinite(at) ? now - at : 0
  return Math.round(Math.max(0, elapsed) / 10) / 100
}

/**
 * Whether a value is a non-blank string.
 * @param {*} value - the candidate.
 * @returns {boolean} true when it is a non-blank string.
 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * A positive whole-millisecond budget, or the fallback.
 * @param {*} value - the candidate.
 * @param {number} fallback - the default budget.
 * @returns {number} the budget.
 */
function toBudget(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * `decodeURIComponent` that keeps the raw text when it cannot decode.
 * @param {string} text - the encoded text.
 * @returns {string} the decoded text.
 */
function safeDecode(text) {
  try {
    return decodeURIComponent(text)
  } catch (error) {
    return text
  }
}

/**
 * A failure as a message string.
 * @param {*} error - the failure.
 * @returns {string} its message.
 */
function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
