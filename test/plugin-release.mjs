/**
 * Host-side checks for lib/host/plugin-release.js.
 *
 * Run with `node test/plugin-release.mjs`. The suite drives the watcher through
 * a fake registry, a fake repository and a fake plugin manager, so it proves
 * the daily cache, the registry fallback, the changelog parser and the four
 * update outcomes without touching the network or a real profile.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createPluginRelease, parseChangelogSection, RELEASE_TTL_MS, RELEASE_FAILURE_TTL_MS } from '../lib/host/plugin-release.js'

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

const MANIFEST = {
  name: 'dsh-homepage',
  version: '0.1.9',
  repository: { type: 'git', url: 'git+https://github.com/AngelosZou/dsh-homepage.git' },
  homepage: 'https://github.com/AngelosZou/dsh-homepage#readme',
}

const CHANGELOG = [
  '# Changelog',
  '',
  '## [0.2.0] — 2026-11-23',
  '',
  '### Added',
  '- The header checks npm once a day.',
  '- A [release panel](https://example.test) lists the versions.',
  '  It keeps the answer readable.',
  '',
  '### Fixed',
  '- A failed check keeps the last known answer.',
  '',
  '## [0.1.9] — 2026-11-19',
  '',
  '### Fixed',
  '- Workspace delete work as expected.',
  '',
].join('\n')

const base = await mkdtemp(path.join(tmpdir(), 'dsh-plugin-release-'))

/** @returns a fetch reply object shaped like the watcher reads it. */
function reply(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => body }
}

/** @returns a watcher over one throwaway storage directory. */
function watcher(name, options) {
  return createPluginRelease(Object.assign({
    root: path.join(base, name),
    manifest: MANIFEST,
    timeoutMs: 200,
    now: () => NOW,
  }, options || {}))
}

const NOW = 1795500000000
// One registry answer plus one changelog answer is the successful shape.
function registryFetch(latest, options = {}) {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    if (options.before) options.before(url)
    if (url.endsWith('/dsh-homepage/latest')) {
      if (options.failNpmFirst && url.includes('registry.npmjs.org')) throw new Error('npmjs is unreachable')
      const version = options.version === undefined ? latest : options.version
      if (version === undefined) return reply('', 404)
      return reply(JSON.stringify({
        name: 'dsh-homepage',
        version,
        _cnpmcore_publish_time: options.publishedAt || '2026-11-23T05:10:00.000Z',
      }))
    }
    if (url.includes('CHANGELOG.md')) {
      if (options.changelog === false) return reply('', 404)
      return reply(options.changelog || CHANGELOG)
    }
    return reply('', 404)
  }
  return { seen, fetchImpl }
}

try {
  // ------------------------------------------------------------ changelog parser
  {
    const section = parseChangelogSection(CHANGELOG, '0.2.0')
    ok(section, 'a released section is found')
    is(section.version, '0.2.0', 'the section carries its version')
    is(section.date, '2026-11-23', 'the heading date is kept')
    is(section.groups.length, 2, 'two groups are parsed')
    is(section.groups[0].title, 'Added', 'the first group keeps its heading')
    is(section.groups[0].items.length, 2, 'two bullets are in the first group')
    ok(section.groups[0].items[1].includes('release panel lists the versions'),
      'markdown links keep their text')
    ok(section.groups[0].items[1].includes('It keeps the answer readable'),
      'a wrapped bullet continues on the indented line')
    is(section.groups[1].items[0], 'A failed check keeps the last known answer.', 'the next group is separate')
    is(parseChangelogSection(CHANGELOG, '9.9.9'), null, 'an absent version has no section')
    is(parseChangelogSection('', '0.2.0'), null, 'an empty changelog has no section')
    const plain = parseChangelogSection('## 1.0.0\n\n- first\n- second\n', '1.0.0')
    is(plain.groups.length, 1, 'a bracketed heading is optional')
    is(plain.groups[0].title, '', 'a version without a group heading still parses')
  }

  // ---------------------------------------------------------- a newer release
  const registry = registryFetch('0.2.0')
  const bundles = [{ name: 'dsh-homepage', update: 'registry', source: 'dsh-homepage@^0.1.9' }]
  const updateCalls = []
  const manager = {
    listBundles: async () => bundles,
    updateBundle: async (name, version, options) => {
      updateCalls.push({ name, version, options })
      return {
        from: '0.1.9', to: version, step: 'install',
        result: { changed: true, application: 'applied', stage: 'install', target: name + '@' + version },
      }
    },
  }
  {
    const release = watcher('newer', {
      now: () => NOW,
      fetchImpl: registry.fetchImpl,
      pluginManager: () => manager,
    })
    const document = await release.read({})
    is(document.current, '0.1.9', 'the running version comes from the manifest')
    is(document.latest, '0.2.0', 'the published version comes from the registry')
    is(document.updateAvailable, true, 'a newer registry version is an update')
    is(document.ahead, false, 'the running version is not ahead')
    is(document.registry, 'npm', 'the first registry answered')
    is(document.install.kind, 'registry', 'a profile registry dependency is recognised')
    is(document.install.updatable, true, 'a registry dependency is updatable')
    is(document.error, null, 'a successful check has no error')
    is(document.changelog.version, '0.2.0', 'the new version carries its changelog')
    is(document.changelog.groups.length, 2, 'the changelog groups reach the document')
    ok(registry.seen.some((url) => url.includes('registry.npmjs.org')), 'npmjs is asked first')
    ok(registry.seen.some((url) => url.includes('raw.githubusercontent.com')), 'the repository changelog is asked')
    is(document.publishedAt, '2026-11-23T05:10:00.000Z', 'the publish time is reported')

    // The daily cache: a second read inside the window must not touch the network.
    const before = registry.seen.length
    const cached = await release.read({})
    is(cached.fromCache, true, 'a second read inside the day is cached')
    is(cached.updateAvailable, true, 'the cached answer keeps its verdict')
    is(registry.seen.length, before, 'the cached read makes no HTTP request')
    const stored = JSON.parse(await readFile(path.join(base, 'newer', 'plugin-release-check.json'), 'utf8'))
    is(stored.version, 1, 'the cached document is versioned')
    is(stored.document.latest, '0.2.0', 'the cached document keeps the reading')

    // Force bypasses the day window.
    await release.read({ force: true })
    ok(registry.seen.length > before, 'force re-reads the registry')

    // A clock that moved past the TTL re-checks by itself.
    const later = watcher('newer', {
      now: () => NOW + RELEASE_TTL_MS + 1000,
      fetchImpl: registry.fetchImpl,
      pluginManager: () => manager,
    })
    const afterDay = await later.read({})
    is(afterDay.fromCache, false, 'a day-old answer is re-checked')

    // ------------------------------------------------------------- the update
    updateCalls.length = 0
    const updated = await release.update({ version: '0.2.0' })
    is(updated.ok, true, 'an updatable install updates')
    is(updated.application, 'applied', 'the manager applied the update')
    is(updateCalls.length, 1, 'exactly one manager update runs')
    same(updateCalls[0], { name: 'dsh-homepage', version: '0.2.0', options: {} }, 'the manager is asked for the published version')
    const notNewer = await release.update({ version: '0.1.9' })
    is(notNewer.ok, false, 'a version that is not newer is refused')
    is(notNewer.code, 'not-newer', 'the refusal names the version order')
  }

  // ------------------------------------------------ fallback and failure paths
  {
    const fallback = registryFetch('0.2.0', { failNpmFirst: true, changelog: false })
    const release = watcher('fallback', {
      fetchImpl: fallback.fetchImpl,
      pluginManager: () => manager,
    })
    const document = await release.read({})
    is(document.registry, 'npmmirror', 'the mainland mirror answers when npmjs is unreachable')
    is(document.changelog, null, 'a missing changelog is reported as such')
    is(document.changelogError, 'unavailable', 'a missing changelog is reported as such')
    is(document.publishedAt, '2026-11-23T05:10:00.000Z', 'a mirror publish time still reaches the panel')
  }

  // A mirror failure on everything leaves an error, never a throw.
  {
    const release = watcher('offline', {
      fetchImpl: async () => { throw new Error('offline') },
      pluginManager: () => manager,
    })
    const failed = await release.read({})
    is(failed.latest, null, 'a total failure has no latest version')
    is(failed.errorCode, 'network', 'a total failure is a network error')
    is(failed.updateAvailable, false, 'a total failure does not claim an update')
    ok(failed.error.includes('no registry answered'), 'the failure names the unreadable source')
  }

  // A stale cached answer survives a later failure, marked as stale.
  {
    let online = true
    let fetched = 0
    const fetchImpl = async (url) => {
      fetched += 1
      if (!online) throw new Error('offline now')
      if (url.endsWith('/latest')) return reply(JSON.stringify({ version: '0.2.0' }))
      if (url.includes('CHANGELOG.md')) return reply(CHANGELOG)
      return reply('', 404)
    }
    const release = watcher('stale', { fetchImpl, pluginManager: () => manager })
    await release.read({})
    online = false
    let clock = NOW + RELEASE_TTL_MS + 1000
    const later = createPluginRelease({
      root: path.join(base, 'stale'),
      manifest: MANIFEST,
      timeoutMs: 200,
      now: () => clock,
      fetchImpl,
      pluginManager: () => manager,
    })
    const stale = await later.read({})
    is(stale.latest, '0.2.0', 'a stale success is still readable')
    is(stale.fromCache, true, 'the stale answer is marked cached')
    is(stale.errorCode, 'network', 'the stale answer reports the failed refresh')

    // A failed check is not retried on every open: the failure is remembered
    // in memory for the failure TTL, so the next open inside that window costs
    // nothing. Past the window the watcher tries again.
    const atFailure = fetched
    const again = await later.read({})
    is(again.errorCode, 'network', 'a remembered failure is returned without a new request')
    is(fetched, atFailure, 'the remembered failure makes no HTTP request')
    clock += RELEASE_FAILURE_TTL_MS + 1000
    await later.read({})
    ok(fetched > atFailure, 'the failure TTL expires into a new attempt')
  }

  // ------------------------------------------------------ installation kinds
  {
    const cases = [
      { bundles: [{ name: 'dsh-homepage', source: 'link:D:/Projects/dsh-homepage' }], kind: 'local', reason: 'local' },
      { bundles: [{ name: 'dsh-homepage', source: 'file:D:/Projects/dsh-homepage.tgz' }], kind: 'local', reason: 'local' },
      { bundles: [{ name: 'dsh-homepage', update: 'git', source: 'https://github.com/AngelosZou/dsh-homepage#abcdef' }], kind: 'git', reason: 'git' },
      { bundles: [{ name: 'dsh-homepage', source: 'https://example.test/x.tgz' }], kind: 'unknown', reason: 'source' },
      { bundles: [], kind: 'unknown', reason: 'not-installed' },
    ]
    for (const entry of cases) {
      const fetch = registryFetch('0.2.0')
      const release = watcher('kind-' + entry.kind + '-' + entry.reason, {
        fetchImpl: fetch.fetchImpl,
        pluginManager: () => ({
          listBundles: async () => entry.bundles,
          updateBundle: async () => { throw new Error('a non-registry install must not reach updateBundle') },
        }),
      })
      const document = await release.read({})
      is(document.install.kind, entry.kind, 'the install kind is ' + entry.kind)
      is(document.install.reason, entry.reason, 'the install reason is ' + entry.reason)
      is(document.install.updatable, false, 'only a registry dependency updates in place')
      const refused = await release.update({ version: '0.2.0' })
      is(refused.ok, false, 'a non-registry install refuses the update')
      is(refused.code, 'not-updatable', 'the refusal has a stable code')
    }
  }

  // ---------------------------------------------------------- update outcomes
  {
    const answered = (application, error) => ({
      from: '0.1.9', to: '0.2.0', step: 'install',
      result: {
        changed: application !== 'failed', application, stage: 'install', target: 'dsh-homepage@0.2.0',
        ...(error === undefined ? {} : { error }),
      },
    })
    const cases = [
      { result: answered('restart-required'), ok: true, restart: true },
      { result: answered('overridden'), ok: true, restart: false },
      { result: answered('failed', { code: 'operation-error', diagnostic: 'pnpm exploded' }), ok: false, error: 'pnpm exploded' },
    ]
    for (const entry of cases) {
      const release = watcher('outcome-' + entry.ok + '-' + entry.restart, {
        fetchImpl: registryFetch('0.2.0').fetchImpl,
        pluginManager: () => ({ listBundles: async () => bundles, updateBundle: async () => entry.result }),
      })
      const outcome = await release.update({ version: '0.2.0' })
      is(outcome.ok, entry.ok, 'the update outcome is ' + entry.ok)
      is(outcome.restartRequired, entry.ok && entry.restart === true, 'restart-required is reported')
      if (!entry.ok) is(outcome.error, entry.error, 'the manager diagnostic reaches the caller')
    }

    const noManager = watcher('no-manager', { fetchImpl: registryFetch('0.2.0').fetchImpl })
    const unavailable = await noManager.update({ version: '0.2.0' })
    is(unavailable.ok, false, 'an update without a manager is refused')
    is(unavailable.code, 'unavailable', 'the refusal names the missing manager')

    const throwing = watcher('throwing', {
      fetchImpl: registryFetch('0.2.0').fetchImpl,
      pluginManager: () => ({ listBundles: async () => bundles, updateBundle: async () => { throw new Error('manager died') } }),
    })
    const threw = await throwing.update({ version: '0.2.0' })
    is(threw.ok, false, 'a throwing manager is a refusal, not an exception')
    is(threw.error, 'manager died', 'the manager failure keeps its message')

    const notNew = watcher('not-new', {
      fetchImpl: registryFetch('0.1.9').fetchImpl,
      pluginManager: () => ({ listBundles: async () => bundles, updateBundle: async () => { throw new Error('must not run') } }),
    })
    const sameVersion = await notNew.read({})
    is(sameVersion.updateAvailable, false, 'the published version equal to the running one is not an update')
    is(sameVersion.changelog, null, 'an up-to-date check does not fetch a changelog')
    const noVersion = await notNew.update({})
    is(noVersion.ok, false, 'an update with no newer version is refused')
    is(noVersion.code, 'not-newer', 'the equal version is refused as not newer')
  }

  console.log('plugin-release: ' + checks + ' checks passed')
} finally {
  await rm(base, { recursive: true, force: true })
}
