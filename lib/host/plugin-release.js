/**
 * dsh-homepage — Host half, self release watcher.
 *
 * The home page header asks one question a day: has the npm copy of this plugin
 * moved past the one running here? The answer needs three reads, and none of
 * them belongs to the browser:
 *
 *  - the published version, from an npm registry (`/latest`) — npmjs.org first,
 *    then the mainland mirror, because a host that cannot reach one usually can
 *    reach the other and the two lag each other by minutes, not versions;
 *  - the published version's CHANGELOG section, from the repository (a tag, the
 *    default branch) or the npm file CDNs, whichever answers first; a package
 *    that predates the file simply has no notes, and that is reported, not
 *    invented;
 *  - whether this installation can be updated in place at all. The plugin may
 *    be a registry dependency, a `link:` to a development checkout, a Git pin or
 *    a copy the profile does not manage; only the first is replaceable through
 *    `pluginManager.updateBundle`, and the other three say why instead of
 *    offering a button that cannot work.
 *
 * Contract:
 *  - a successful check is written beside the ledger and reused for
 *    `ttlMs` (one day by default), so opening the panel repeatedly costs one
 *    HTTP exchange a day. `force: true` re-reads now;
 *  - a failed check is remembered in memory for `failureTtlMs` only, so a
 *    transient outage is not pinned to the header for 24 hours. When a previous
 *    successful check exists it is still served, marked with the failure, which
 *    is what lets the panel show "last known" instead of an empty box;
 *  - `read()` and `update()` never reject. Every outcome is a document, and the
 *    client renders it;
 *  - every external effect is injectable (`fetchImpl`, `now`, `readFile`,
 *    `writeFile`, `mkdir`, `pluginManager`, `manifest`, `changelogUrls`), so the
 *    unit suite is deterministic and runs without a network;
 *  - nothing is read, written or fetched at import time.
 *
 * @module dsh-homepage/host/plugin-release
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { compareVersions } from './audit.js'

/** How long one successful check is authoritative. */
export const RELEASE_TTL_MS = 24 * 60 * 60 * 1000
/** How long a failure is remembered before another attempt is allowed. */
export const RELEASE_FAILURE_TTL_MS = 10 * 60 * 1000
/** One HTTP attempt's budget. */
const REQUEST_TIMEOUT_MS = 6000
/** The file the check is remembered in, under the plugin's storage root. */
const STATE_FILE = 'plugin-release-check.json'
/** The package this watcher is about. */
const DEFAULT_NAME = 'dsh-homepage'
/** Registry bases, in the order they are asked. */
const DEFAULT_REGISTRIES = [
  { base: 'https://registry.npmjs.org', route: 'npm' },
  { base: 'https://registry.npmmirror.com', route: 'npmmirror' },
]
/** The package manifest the running version is read from. */
const MANIFEST_URL = new URL('../../package.json', import.meta.url)
/** What the registries and file CDNs are told about the caller. */
const USER_AGENT = 'dsh-homepage version-check'
/** A published version worth comparing. */
const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
/** How many changelog items one version keeps, so a runaway file cannot reach the panel. */
const MAX_NOTES = 40
/** Longest single changelog item. */
const MAX_NOTE_LENGTH = 400

/** Preserve whatever a dependency threw, as a non-empty message. */
function messageOf(error) {
  if (error instanceof Error && error.message !== '') return error.message
  const text = String(error === undefined ? '' : error)
  return text === '' ? 'unknown failure' : text
}

/** @returns `value` with a leading `v` removed, when it has a version shape. */
function normalizedVersion(value) {
  const text = typeof value === 'string' ? value.trim().replace(/^v/i, '') : ''
  return VERSION_SHAPE.test(text) ? text : ''
}

/** @returns the package version, or `0.0.0` when the manifest is unreadable. */
function versionOf(manifest) {
  return normalizedVersion(manifest && manifest.version) || '0.0.0'
}

/** @returns the package name, or the watcher's own default. */
function nameOf(manifest) {
  const name = manifest && typeof manifest.name === 'string' ? manifest.name.trim() : ''
  return name === '' ? DEFAULT_NAME : name
}

/**
 * The `owner/name` pair a manifest's repository points at.
 * Accepts `git+https://github.com/o/r.git`, `https://github.com/o/r` and the
 * `github:o/r` shorthand, and answers `''` for anything else.
 * @param manifest - the package manifest.
 * @returns `owner/name`, or `''`.
 */
function repoPathOf(manifest) {
  const declared = manifest && manifest.repository
  const url = typeof declared === 'string'
    ? declared
    : declared && typeof declared.url === 'string' ? declared.url : ''
  const shorthand = /^github:([^/]+\/[^/]+?)(?:\.git)?$/i.exec(url.trim())
  if (shorthand) return shorthand[1]
  const match = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?].*)?$/i.exec(url)
  return match ? match[1] + '/' + match[2] : ''
}

/** @returns an ISO publish time for one version, when the registry carries one. */
function publishTimeOf(payload, version) {
  const direct = payload && (payload._cnpmcore_publish_time || payload.publish_time)
  if (typeof direct === 'string' && direct !== '') return direct
  const times = payload && payload.time
  if (times && typeof times === 'object' && typeof times[version] === 'string') return times[version]
  return null
}

/**
 * Read one URL as text. One attempt, one deadline, no proxy guesswork: a plain
 * `fetch` already follows whatever dispatcher/fetch the host installs, and the
 * registry pair is the fallback for a host where one route is blocked.
 * @returns {Promise<string|null>} the body, or null.
 */
async function requestText(deps, url) {
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch
  if (typeof fetchImpl !== 'function') return null
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  let timer = null
  try {
    const started = Promise.resolve(fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: '*/*', 'accept-encoding': 'identity' },
      signal: controller === null ? undefined : controller.signal,
    }))
    const response = await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (controller !== null) controller.abort()
        reject(new Error('request timed out'))
      }, deps.timeoutMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
      started.then(resolve, reject)
    })
    if (!response || typeof response !== 'object') return null
    const status = Number(response.status)
    if (response.ok !== true && !(status >= 200 && status < 300)) return null
    const text = typeof response.text === 'function' ? await response.text() : response.text
    return typeof text === 'string' ? text : ''
  } catch (error) {
    void error
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** @returns one parsed JSON object, or null. */
async function requestJson(deps, url) {
  const text = await requestText(deps, url)
  if (typeof text !== 'string' || text === '') return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch (error) {
    void error
    return null
  }
}

/**
 * Ask the registries in order for the published version.
 * @returns {Promise<null|object>} `{ version, publishedAt, registry }`, or null.
 */
async function fetchLatest(deps, name) {
  const path = '/' + encodeURIComponent(name) + '/latest'
  for (const registry of deps.registries) {
    const base = String(registry.base || '').replace(/\/+$/, '')
    if (base === '') continue
    const payload = await requestJson(deps, base + path)
    if (payload === null) continue
    const version = normalizedVersion(payload.version)
    if (version === '') continue
    return {
      version,
      publishedAt: publishTimeOf(payload, version),
      registry: String(registry.route || 'npm'),
    }
  }
  return null
}

/**
 * Clean one changelog bullet for display: markdown links lose their target,
 * emphasis/code markers disappear, and whitespace collapses.
 * @param text - the raw bullet.
 * @returns a single line.
 */
function cleanNote(text) {
  return String(text)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NOTE_LENGTH)
}

/**
 * Pull one version's section out of a Markdown changelog.
 *
 * The file this repository writes opens each release with `## [x.y.z] — date`
 * and groups the entries under `### Added`, `### Changed` and `### Fixed`. The
 * parser accepts the brackets and date as optional so a hand-written `## 0.2.0`
 * still works, stops at the next `##` heading, and appends an indented
 * continuation line to the bullet it belongs to.
 *
 * @param markdown - the whole CHANGELOG.
 * @param version - the version whose section to read.
 * @returns {null|object} `{ version, date, groups: [{ title, items }] }`.
 */
export function parseChangelogSection(markdown, version) {
  const wanted = normalizedVersion(version)
  if (wanted === '' || typeof markdown !== 'string') return null
  const lines = markdown.split(/\r?\n/)
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const heading = new RegExp('^##\\s+\\[?v?' + escaped + '\\]?(?:\\s|—|-|$)')
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (heading.test(lines[index].trim())) { start = index; break }
  }
  if (start === -1) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) { end = index; break }
  }
  const dateMatch = /(\d{4}-\d{2}-\d{2})/.exec(lines[start])
  const groups = []
  let group = null
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]
    const subheading = /^###\s+(.+?)\s*$/.exec(line)
    if (subheading) {
      group = { title: cleanNote(subheading[1]), items: [] }
      groups.push(group)
      continue
    }
    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line)
    if (bullet) {
      if (group === null) {
        group = { title: '', items: [] }
        groups.push(group)
      }
      if (group.items.length < MAX_NOTES) group.items.push(cleanNote(bullet[1]))
      continue
    }
    // A wrapped bullet continues on an indented line. A blank line, a table or
    // a new heading ends it; only prose continuation is appended.
    if (group !== null && group.items.length > 0 && /^\s{2,}\S/.test(line)) {
      const at = group.items.length - 1
      group.items[at] = cleanNote(group.items[at] + ' ' + line.trim())
    }
  }
  const kept = groups.filter((entry) => entry.items.length > 0)
  if (kept.length === 0) return null
  return {
    version: wanted,
    date: dateMatch === null ? null : dateMatch[1],
    groups: kept,
  }
}

/**
 * Where one version's CHANGELOG can be read, in the order tried.
 * @param manifest - the package manifest.
 * @param version - the published version.
 * @returns a list of URLs.
 */
function defaultChangelogUrls(manifest, version) {
  const name = nameOf(manifest)
  const repo = repoPathOf(manifest)
  const tag = 'v' + version
  const urls = []
  if (repo !== '') {
    urls.push('https://raw.githubusercontent.com/' + repo + '/' + tag + '/CHANGELOG.md')
    urls.push('https://cdn.jsdelivr.net/gh/' + repo + '@' + tag + '/CHANGELOG.md')
  }
  urls.push('https://cdn.jsdelivr.net/npm/' + name + '@' + version + '/CHANGELOG.md')
  urls.push('https://unpkg.com/' + name + '@' + version + '/CHANGELOG.md')
  if (repo !== '') urls.push('https://raw.githubusercontent.com/' + repo + '/main/CHANGELOG.md')
  return urls
}

/**
 * Read the changelog section for one version from the first source that has it.
 * @returns {Promise<null|object>} `{ version, date, groups, source }`, or null.
 */
async function fetchChangelog(deps, manifest, version) {
  const build = typeof deps.changelogUrls === 'function'
    ? deps.changelogUrls
    : defaultChangelogUrls
  // The sources are mirrors of the same file, so they are asked together and
  // read in the declared order. Asking them in sequence would make a host with
  // one blocked route wait a full timeout per mirror before reaching the one
  // that answers; the check is daily, so the small burst is free.
  const urls = build(manifest, version)
  const bodies = await Promise.all(urls.map((url) => requestText(deps, url)))
  for (let index = 0; index < urls.length; index += 1) {
    const text = bodies[index]
    if (typeof text !== 'string' || text === '') continue
    const section = parseChangelogSection(text, version)
    if (section === null) continue
    return Object.assign({}, section, { source: urls[index] })
  }
  return null
}

/**
 * Whether this installation can be replaced through the plugin manager, and
 * which kind of installation it is.
 * @returns {Promise<object>} `{ kind, updatable, reason }`.
 */
async function readInstall(deps, name) {
  let manager = null
  try {
    manager = typeof deps.pluginManager === 'function' ? deps.pluginManager() : null
  } catch (error) {
    return { kind: 'unknown', updatable: false, reason: 'unavailable', message: messageOf(error) }
  }
  if (!manager || typeof manager.listBundles !== 'function') {
    return { kind: 'unknown', updatable: false, reason: 'unavailable' }
  }
  let bundles = null
  try {
    bundles = await manager.listBundles()
  } catch (error) {
    return { kind: 'unknown', updatable: false, reason: 'unreadable', message: messageOf(error) }
  }
  const bundle = Array.isArray(bundles)
    ? bundles.find((entry) => entry && entry.name === name)
    : null
  if (!bundle) return { kind: 'unknown', updatable: false, reason: 'not-installed' }
  if (bundle.update === 'registry') return { kind: 'registry', updatable: true, reason: null }
  if (bundle.update === 'git') return { kind: 'git', updatable: false, reason: 'git' }
  const source = typeof bundle.source === 'string' ? bundle.source : ''
  if (/^(link:|file:)/i.test(source)) return { kind: 'local', updatable: false, reason: 'local' }
  return { kind: 'unknown', updatable: false, reason: source === '' ? 'unknown' : 'source' }
}

/**
 * Read the package manifest once. A missing/unreadable manifest degrades to
 * `0.0.0` rather than breaking the whole panel.
 * @returns {Promise<object>} the manifest fields the watcher uses.
 */
async function defaultManifest() {
  try {
    const parsed = JSON.parse(await readFile(MANIFEST_URL, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    void error
    return {}
  }
}

/** @returns a fresh document with every field present. */
function emptyDocument(manifest, now, install) {
  const name = nameOf(manifest)
  const repo = repoPathOf(manifest)
  return {
    at: now,
    current: versionOf(manifest),
    latest: null,
    updateAvailable: false,
    ahead: false,
    checkedAt: null,
    fromCache: false,
    cacheAgeMs: null,
    registry: null,
    publishedAt: null,
    repo,
    repoUrl: repo === '' ? '' : 'https://github.com/' + repo,
    npmUrl: 'https://www.npmjs.com/package/' + name,
    changelog: null,
    changelogError: null,
    install: install || { kind: 'unknown', updatable: false, reason: 'unavailable' },
    error: null,
    errorCode: null,
  }
}

/** Remove the render-time fields before a document is written to disk. */
function persistedDocument(document) {
  const copy = Object.assign({}, document)
  delete copy.at
  delete copy.fromCache
  delete copy.cacheAgeMs
  delete copy.error
  delete copy.errorCode
  return copy
}

/**
 * Build the release watcher.
 * @param {object} options - `{ root, manifest, pluginManager, fetchImpl, now, ... }`.
 * @returns `{ read, update }`.
 */
export function createPluginRelease(options = {}) {
  const deps = {
    root: options.root || '',
    statePath: options.statePath || (options.root ? join(options.root, STATE_FILE) : ''),
    manifest: options.manifest || null,
    readManifest: options.readManifest || null,
    pluginManager: options.pluginManager || null,
    fetchImpl: options.fetchImpl || null,
    now: options.now || (() => Date.now()),
    readFile: options.readFile || readFile,
    writeFile: options.writeFile || writeFile,
    mkdir: options.mkdir || mkdir,
    registries: Array.isArray(options.registries) && options.registries.length > 0
      ? options.registries
      : DEFAULT_REGISTRIES,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS,
    ttlMs: Number.isFinite(options.ttlMs) ? options.ttlMs : RELEASE_TTL_MS,
    failureTtlMs: Number.isFinite(options.failureTtlMs) ? options.failureTtlMs : RELEASE_FAILURE_TTL_MS,
    changelogUrls: options.changelogUrls || null,
  }
  let manifestCache = null
  let memory = null

  /** @returns the package manifest, read once. */
  async function manifest() {
    if (manifestCache !== null) return manifestCache
    if (deps.manifest && typeof deps.manifest === 'object') {
      manifestCache = deps.manifest
      return manifestCache
    }
    if (typeof deps.readManifest === 'function') {
      try { manifestCache = await deps.readManifest() } catch (error) { void error; manifestCache = {} }
      if (!manifestCache || typeof manifestCache !== 'object') manifestCache = {}
      return manifestCache
    }
    manifestCache = await defaultManifest()
    return manifestCache
  }

  /** @returns the last successful check, or null. */
  async function readCached() {
    if (deps.statePath === '') return null
    try {
      const parsed = JSON.parse(await deps.readFile(deps.statePath, 'utf8'))
      if (!parsed || parsed.version !== 1 || typeof parsed.checkedAt !== 'number') return null
      if (!parsed.document || typeof parsed.document !== 'object') return null
      return { checkedAt: parsed.checkedAt, document: parsed.document }
    } catch (error) {
      void error
      return null
    }
  }

  /** Write one successful check, best effort: a read-only storage is not a failure. */
  async function saveCached(document) {
    if (deps.statePath === '') return
    try {
      await deps.mkdir(dirname(deps.statePath), { recursive: true, mode: 0o700 })
      await deps.writeFile(deps.statePath, JSON.stringify({
        version: 1,
        checkedAt: document.checkedAt,
        document: persistedDocument(document),
      }))
    } catch (error) {
      void error
    }
  }

  /**
   * Read the release state, from cache or from the registries.
   * @param {object} [input] - `{ force }`.
   * @returns {Promise<object>} the release document; never rejects.
   */
  async function read(input = {}) {
    const force = input !== null && typeof input === 'object' && input.force === true
    const now = deps.now()
    const man = await manifest()
    const current = versionOf(man)
    const cached = await readCached()
    const age = cached === null ? Infinity : now - cached.checkedAt
    const cacheUsable = !force && cached !== null
      && cached.document.current === current
      && age >= 0 && age < deps.ttlMs
    if (cacheUsable) {
      return Object.assign({}, cached.document, {
        at: now,
        fromCache: true,
        cacheAgeMs: age,
        error: null,
        errorCode: null,
      })
    }
    const memoryTtl = memory !== null && memory.document.error !== null
      ? deps.failureTtlMs
      : deps.ttlMs
    if (!force && memory !== null && memory.document.current === current && now - memory.at >= 0 && now - memory.at < memoryTtl) {
      return Object.assign({}, memory.document, { at: now, fromCache: true })
    }

    const name = nameOf(man)
    const install = await readInstall(deps, name)
    const base = emptyDocument(man, now, install)
    let latest = null
    try {
      latest = await fetchLatest(deps, name)
      if (latest === null) throw new Error('no registry answered for ' + name)
    } catch (error) {
      const message = messageOf(error)
      if (cached !== null && cached.document.current === current) {
        const fallback = Object.assign({}, cached.document, {
          at: now,
          fromCache: true,
          cacheAgeMs: age,
          install,
          error: message,
          errorCode: 'network',
        })
        memory = { at: now, document: fallback }
        return fallback
      }
      const failed = Object.assign({}, base, { error: message, errorCode: 'network' })
      memory = { at: now, document: failed }
      return failed
    }

    const updateAvailable = compareVersions(latest.version, current) > 0
    const ahead = compareVersions(current, latest.version) > 0
    const document = Object.assign({}, base, {
      latest: latest.version,
      updateAvailable,
      ahead,
      checkedAt: now,
      registry: latest.registry,
      publishedAt: latest.publishedAt,
    })
    if (updateAvailable) {
      const notes = await fetchChangelog(deps, man, latest.version)
      if (notes === null) {
        document.changelogError = 'unavailable'
      } else {
        document.changelog = notes
        if (document.publishedAt === null && typeof notes.date === 'string') document.publishedAt = notes.date
      }
    }
    await saveCached(document)
    memory = { at: now, document }
    return document
  }

  /**
   * Replace this installation with one published version.
   * @param {object} [input] - `{ version }`; absent, the newest published one.
   * @returns {Promise<object>} `{ ok, code, ... }`; never rejects.
   */
  async function update(input = {}) {
    const asked = input !== null && typeof input === 'object' ? normalizedVersion(input.version) : ''
    const man = await manifest()
    const current = versionOf(man)
    let target = asked
    if (target === '') {
      const state = await read({})
      target = normalizedVersion(state.latest)
    }
    if (target === '') {
      return { ok: false, code: 'no-version', error: 'no published version to install' }
    }
    if (compareVersions(target, current) <= 0) {
      return { ok: false, code: 'not-newer', error: target + ' is not newer than ' + current, from: current, to: target }
    }
    let manager = null
    try {
      manager = typeof deps.pluginManager === 'function' ? deps.pluginManager() : null
    } catch (error) {
      return { ok: false, code: 'unavailable', error: messageOf(error) }
    }
    if (!manager || typeof manager.updateBundle !== 'function') {
      return { ok: false, code: 'unavailable', error: 'pluginManager.updateBundle is unavailable' }
    }
    const install = await readInstall(deps, nameOf(man))
    if (!install.updatable) {
      return {
        ok: false,
        code: 'not-updatable',
        reason: install.reason,
        install,
        from: current,
        to: target,
        error: 'this installation cannot be replaced through the plugin manager',
      }
    }
    let result = null
    try {
      result = await manager.updateBundle(nameOf(man), target, {})
    } catch (error) {
      return { ok: false, code: 'failed', from: current, to: target, error: messageOf(error) }
    }
    if (!result || typeof result !== 'object') {
      return { ok: false, code: 'failed', from: current, to: target, error: 'the plugin manager answered nothing' }
    }
    const change = result.result && typeof result.result === 'object' ? result.result : {}
    const application = typeof change.application === 'string' ? change.application : 'failed'
    const applied = application === 'applied' || application === 'restart-required' || application === 'overridden'
    const failure = change.error && typeof change.error === 'object'
      ? (change.error.diagnostic || change.error.code || 'update failed')
      : (change.error || 'update failed')
    return {
      ok: applied,
      code: applied ? 'ok' : 'failed',
      from: typeof result.from === 'string' ? result.from : current,
      to: typeof result.to === 'string' ? result.to : target,
      step: typeof result.step === 'string' ? result.step : null,
      application,
      restartRequired: application === 'restart-required',
      error: applied ? null : String(failure),
      warnings: Array.isArray(change.warnings) ? change.warnings : [],
    }
  }

  return { read, update }
}
