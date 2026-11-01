/**
 * dsh-homepage — DSH release sampler unit checks.
 *
 * Plain `node:assert/strict`, no framework, mirroring `toolchain-sampler.mjs`.
 * Every HTTP request, proxy request, subprocess and clock is injected, so the
 * whole suite passes on a machine with no network at all and nothing is ever
 * really fetched or spawned.
 *
 * Run with `node test/dsh-sampler.mjs`; the last line is the sentinel the
 * smoke script greps for.
 */
import assert from 'node:assert/strict'
import {
  commitFromEntry,
  decodeEntities,
  gitHeadSha,
  parseAtomEntries,
  releaseFromEntry,
  resetDshCache,
  sampleDshRelease,
  stripTags,
} from '../lib/host/dsh.js'

/** The exact key set of the returned document. */
const DOC_KEYS = [
  'at', 'branch', 'cached', 'commits', 'error', 'head', 'reason', 'release',
  'releases', 'repo', 'routes', 'sampleSeconds',
]

/** The exact key set of the routes record. */
const ROUTE_KEYS = ['commits', 'head', 'releases']

/** The exact key set of one parsed feed entry. */
const ENTRY_KEYS = ['author', 'content', 'id', 'link', 'title', 'updated']

/** The exact key set of one commit record. */
const COMMIT_KEYS = ['author', 'date', 'message', 'sha', 'short', 'url']

/** The exact key set of one release record. */
const RELEASE_KEYS = ['name', 'publishedAt', 'tag', 'url']

/** The HEAD sha measured on this repository, 2026-10-15. */
const SHA = '86a402200d95fecef4529d969836f1fe13c6cb0d'

/** The commit title as the feed delivers it, already collapsed. */
const COMMIT_MESSAGE = 'Merge pull request #6301 from deepseek-harness/worktree/release-dsh-0…'

/** The commit link as the feed delivers it. */
const COMMIT_URL = 'https://github.com/deepseek-ai/deepseek-harness/commit/' + SHA

/** The release tag: what `git clone --branch` needs. */
const RELEASE_TAG = 'dsh-v0.2.1-alpha.4'

/** The release name: what the card shows. */
const RELEASE_NAME = 'v0.2.1-alpha.4'

/** The release link as the feed delivers it. */
const RELEASE_URL = 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/' + RELEASE_TAG

/** One real commit entry, verbatim shape, title wrapped in newlines. */
const COMMIT_ENTRY = [
  '<entry>',
  '  <id>tag:github.com,2008:Grit::Commit/' + SHA + '</id>',
  '  <link type="text/html" rel="alternate" href="' + COMMIT_URL + '"/>',
  '  <title>',
  '        ' + COMMIT_MESSAGE,
  '      </title>',
  '  <updated>2026-10-15T12:22:44Z</updated>',
  '  <author><name>LegGasai</name><uri>https://github.com/LegGasai</uri></author>',
  '  <content type="html">&lt;pre style=&quot;white-space:pre-wrap&quot;&gt;Merge pull request #6301&lt;/pre&gt;</content>',
  '</entry>',
].join('\n')

/** One real release entry, verbatim shape, escaped-HTML notes. */
const RELEASE_ENTRY = [
  '<entry>',
  '  <id>tag:github.com,2008:Repository/1333065091/' + RELEASE_TAG + '</id>',
  '  <title>' + RELEASE_NAME + '</title>',
  '  <link type="text/html" rel="alternate" href="' + RELEASE_URL + '"/>',
  '  <updated>2026-10-15T13:40:02Z</updated>',
  '  <content type="html">&lt;h2&gt;Highlights&lt;/h2&gt;&lt;ul&gt;&lt;li&gt;Faster&lt;/li&gt;&lt;/ul&gt;</content>',
  '</entry>',
].join('\n')

/** A whole commits feed carrying the one real entry. */
const COMMITS_FEED = feedOf([COMMIT_ENTRY])

/** A whole releases feed carrying the one real entry. */
const RELEASES_FEED = feedOf([RELEASE_ENTRY])

// ------------------------------------------------------------------- surface

{
  assert.equal(typeof sampleDshRelease, 'function', 'sampleDshRelease is exported')
  assert.equal(typeof parseAtomEntries, 'function', 'parseAtomEntries is exported')
  assert.equal(typeof commitFromEntry, 'function', 'commitFromEntry is exported')
  assert.equal(typeof releaseFromEntry, 'function', 'releaseFromEntry is exported')
  assert.equal(typeof decodeEntities, 'function', 'decodeEntities is exported')
  assert.equal(typeof stripTags, 'function', 'stripTags is exported')
  assert.equal(typeof gitHeadSha, 'function', 'gitHeadSha is exported')
  assert.equal(typeof resetDshCache, 'function', 'resetDshCache is exported')
  console.log('  exports: the eight contract functions are exported')
}

// ------------------------------------------------------------ decodeEntities

{
  assert.equal(decodeEntities('a &amp; b'), 'a & b', 'the ampersand entity decodes')
  assert.equal(decodeEntities('&lt;pre&gt;'), '<pre>', 'the angle entities decode')
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB', 'decimal and hexadecimal references both decode')
  assert.equal(decodeEntities('&amp;lt;'), '&lt;', 'decoding is a single pass, so a double escape survives as one')
  assert.equal(decodeEntities('&quot;q&quot; &apos;a&apos;'), '"q" \'a\'', 'quote entities decode')
  assert.equal(decodeEntities('&nbsp;x'), '\u00a0x', 'a named non-ASCII entity decodes')
  assert.equal(decodeEntities('&#x1F600;'), String.fromCodePoint(0x1f600), 'an astral reference decodes')
  assert.equal(decodeEntities('&nope; &'), '&nope; &', 'an unknown entity and a bare ampersand are left alone')
  assert.equal(decodeEntities('&#0;'), '&#0;', 'a zero code point is not a character')
  assert.equal(decodeEntities('&#xD800;'), '&#xD800;', 'a surrogate code point is not a character')
  assert.equal(decodeEntities('&#x110000;'), '&#x110000;', 'an out-of-range code point is not a character')
  assert.equal(decodeEntities(null), '', 'null decodes to the empty string')
  assert.equal(decodeEntities(42), '', 'a number decodes to the empty string')
  console.log('  decodeEntities: named, decimal and hex references decode once, and nothing else moves')
}

// ----------------------------------------------------------- parseAtomEntries

{
  const entries = parseAtomEntries(feedOf([COMMIT_ENTRY, RELEASE_ENTRY]))
  assert.equal(entries.length, 2, 'both entries are parsed, in feed order')
  assert.deepEqual(Object.keys(entries[0]).sort(), ENTRY_KEYS, 'an entry has exactly the contract keys')

  const commit = entries[0]
  assert.equal(commit.id, 'tag:github.com,2008:Grit::Commit/' + SHA, 'the id is kept verbatim')
  assert.equal(commit.title, COMMIT_MESSAGE, 'the multi-line title collapses to one line')
  assert.equal(commit.link, COMMIT_URL, 'the alternate link is chosen')
  assert.equal(commit.updated, '2026-10-15T12:22:44Z', 'the timestamp is kept')
  assert.equal(commit.author, 'LegGasai', 'the author name is read out of <author>')
  assert.ok(commit.content.indexOf('<pre') >= 0, 'the escaped content is decoded back into HTML')
  assert.equal(commit.content.indexOf('&lt;'), -1, 'no entity is left in the content')

  const release = entries[1]
  assert.equal(release.title, RELEASE_NAME, 'the release title is the version name')
  assert.equal(release.link, RELEASE_URL, 'the release link is kept')
  assert.equal(release.author, '', 'a release entry has no author, and reads as blank')

  assert.deepEqual(parseAtomEntries(''), [], 'an empty body has no entries')
  assert.deepEqual(parseAtomEntries(null), [], 'a non-string body has no entries')
  assert.deepEqual(parseAtomEntries('<feed><entry>truncated'), [], 'an unterminated entry is not an entry')
  console.log('  parseAtomEntries: id, collapsed title, alternate link, author and decoded content')
}

// ------------------------------------------------------------------ stripTags

{
  assert.equal(stripTags('&lt;pre style=&quot;x&quot;&gt;Merge&lt;/pre&gt;'), 'Merge',
    'escaped HTML is decoded, then its tags are removed')
  assert.equal(stripTags('<b>a</b> &amp; b'), 'a & b', 'inline tags become spaces and entities decode')
  assert.equal(stripTags('one\n\n   two\tthree'), 'one two three', 'whitespace collapses and the ends trim')
  assert.equal(stripTags('<ul><li>one</li><li>two</li></ul>'), 'one two', 'a list reads as words')
  assert.equal(stripTags('<!-- hidden -->kept'), 'kept', 'a comment leaves nothing behind')
  assert.equal(stripTags('<script>bad()</script>kept'), 'kept', 'a script body is dropped, not printed')
  assert.equal(stripTags(''), '', 'an empty body stays empty')
  assert.equal(stripTags(null), '', 'a non-string body stays empty')
  console.log('  stripTags: escaped notes become plain single-line text')
}

// ------------------------------------------------------------ commitFromEntry

{
  const commit = commitFromEntry(parseAtomEntries(COMMITS_FEED)[0])
  assert.deepEqual(Object.keys(commit).sort(), COMMIT_KEYS, 'a commit has exactly the contract keys')
  assert.equal(commit.sha, SHA, 'the sha comes from the Grit::Commit id')
  assert.equal(commit.short, SHA.slice(0, 7), 'short is the first seven characters')
  assert.equal(commit.message, COMMIT_MESSAGE, 'the message is the collapsed title')
  assert.equal(commit.author, 'LegGasai', 'the author is carried through')
  assert.equal(commit.date, '2026-10-15T12:22:44Z', 'the date is the updated timestamp')
  assert.equal(commit.url, COMMIT_URL, 'the url is the entry link')

  const viaLink = commitFromEntry({ id: 'tag:github.com,2008:Repository/1/whatever', link: 'https://github.com/o/r/commit/abcdef1234567890', title: 't' })
  assert.equal(viaLink.sha, 'abcdef1234567890', 'the sha falls back to the commit link')
  assert.equal(viaLink.short, 'abcdef1', 'short follows the fallback sha')

  assert.equal(commitFromEntry({ id: 'tag:github.com,2008:Repository/1/v1', link: RELEASE_URL, title: 'v1' }), null,
    'a release entry is not a commit')
  assert.equal(commitFromEntry(null), null, 'null is not a commit')
  assert.equal(commitFromEntry('a string'), null, 'a string is not a commit')
  assert.equal(commitFromEntry({}), null, 'an empty entry is not a commit')
  console.log('  commitFromEntry: sha from the id, from the link, and null when there is neither')
}

// ----------------------------------------------------------- releaseFromEntry

{
  const release = releaseFromEntry(parseAtomEntries(RELEASES_FEED)[0])
  assert.deepEqual(Object.keys(release).sort(), RELEASE_KEYS, 'a release has exactly the contract keys')
  assert.equal(release.tag, RELEASE_TAG, 'the tag is the last segment of the link, prefix and all')
  assert.equal(release.name, RELEASE_NAME, 'the name is the title, without the tag prefix')
  assert.equal(release.url, RELEASE_URL, 'the url is the entry link')
  assert.equal(release.publishedAt, '2026-10-15T13:40:02Z', 'publishedAt is the updated timestamp')

  assert.equal(releaseFromEntry({ link: '', title: 'v1' }), null, 'no link means no tag')
  assert.equal(releaseFromEntry({ id: 'tag:github.com,2008:Repository/1/v1', title: 'v1' }), null,
    'the id alone is not a tag source')
  assert.equal(releaseFromEntry({ link: 'https://github.com/o/r/releases', title: 'v1' }), null,
    'a releases page is not a tag')
  assert.equal(releaseFromEntry({ link: 'https://github.com/o/r/releases/tag/', title: 'v1' }), null,
    'a trailing slash leaves no tag')
  assert.equal(releaseFromEntry(null), null, 'null is not a release')
  assert.equal(releaseFromEntry('a string'), null, 'a string is not a release')

  const encoded = releaseFromEntry({ link: 'https://github.com/o/r/releases/tag/v1.0.0%2Bbuild', title: 'v1.0.0+build' })
  assert.equal(encoded.tag, 'v1.0.0+build', 'a percent-encoded tag is decoded')
  console.log('  releaseFromEntry: tag vs name, and null for a link that is not a tag page')
}

// --------------------------------------------------------- a healthy document

{
  resetDshCache()
  const clock = fakeClock(1_700_000_000_000)
  const fetchImpl = fakeFetch(replyByFeed({ commits: feedReply(COMMITS_FEED, 'E1'), releases: feedReply(RELEASES_FEED, 'E2') }))
  const proxyGet = fakeProxy(() => new Error('the proxy must not be needed'))
  const doc = await sampleDshRelease({
    env: {},
    now: clock,
    fetchImpl: fetchImpl,
    proxyGet: proxyGet,
    proxy: 'http://127.0.0.1:7890',
  })

  assert.deepEqual(Object.keys(doc).sort(), DOC_KEYS, 'the document has exactly the contract keys')
  assert.deepEqual(Object.keys(doc.routes).sort(), ROUTE_KEYS, 'routes has exactly the contract keys')
  assert.equal(doc.at, clock(), 'at is the injected clock reading')
  assert.equal(doc.sampleSeconds, 0, 'sampleSeconds is rounded from the injected clock')
  assert.equal(doc.repo, 'deepseek-ai/deepseek-harness', 'the default repository is reported')
  assert.equal(doc.branch, 'master', 'the default branch is reported')
  assert.equal(doc.reason, null, 'a healthy sample has no reason code')
  assert.equal(doc.error, null, 'a healthy sample has no error')
  assert.equal(doc.cached, false, 'a fresh sample is not cached')

  assert.deepEqual(Object.keys(doc.head).sort(), COMMIT_KEYS, 'the head is a commit record')
  assert.equal(doc.head.sha, SHA, 'the head is the newest commit')
  assert.equal(doc.head.short, SHA.slice(0, 7), 'the head exposes the short sha')
  assert.equal(doc.head.message, COMMIT_MESSAGE, 'the head carries the commit message')
  assert.equal(doc.head.author, 'LegGasai', 'the head carries the author')
  assert.equal(doc.head.date, '2026-10-15T12:22:44Z', 'the head carries the date')
  assert.equal(doc.commits.length, 1, 'the commit list carries the entry')
  assert.deepEqual(doc.routes, { commits: 'direct', releases: 'direct', head: 'direct' },
    'both feeds answered directly and the head came from the feed')

  assert.deepEqual(Object.keys(doc.release).sort(), RELEASE_KEYS, 'the release is a release record')
  assert.equal(doc.release.tag, RELEASE_TAG, 'the release tag is the clone-able ref')
  assert.equal(doc.release.name, RELEASE_NAME, 'the release name is what the card shows')
  assert.equal(doc.release.publishedAt, '2026-10-15T13:40:02Z', 'the release timestamp is carried')
  assert.equal(doc.releases.length, 1, 'the release list carries the entry')
  assert.equal(doc.releases[0], doc.release, 'release is the newest entry of releases')

  assert.equal(fetchImpl.calls.length, 2, 'one request per feed')
  assert.equal(fetchImpl.calls[0].url, 'https://github.com/deepseek-ai/deepseek-harness/commits.atom',
    'the commit feed is GitHub atom, not the API')
  assert.equal(fetchImpl.calls[1].url, 'https://github.com/deepseek-ai/deepseek-harness/releases.atom',
    'the release feed is GitHub atom, not the API')
  assert.equal(fetchImpl.calls.some((call) => call.url.indexOf('api.github.com') >= 0), false,
    'no api.github.com request is ever made')
  assert.equal(fetchImpl.calls[0].headers['if-none-match'], undefined, 'a first poll sends no ETag')
  assert.equal(fetchImpl.calls[0].headers['user-agent'], 'dsh-homepage', 'the caller identifies itself')
  assert.ok(fetchImpl.calls[0].signal, 'the direct request carries an abort signal')
  assert.equal(proxyGet.calls.length, 0, 'a direct answer never touches the proxy')
  console.log('  document: a healthy sample reports the head, the commits, the release and the routes')
}

// ------------------------------------------------------- ordering and capping

{
  resetDshCache()
  const commits = []
  for (let index = 0; index < 25; index += 1) commits.push(commitEntry(shaOf(index), 'commit ' + index))
  const releases = []
  for (let index = 0; index < 8; index += 1) releases.push(releaseEntry('dsh-v0.' + index + '.0', 'v0.' + index + '.0'))

  const fetchImpl = fakeFetch(replyByFeed({
    commits: feedReply(feedOf(commits), 'E1'),
    releases: feedReply(feedOf(releases), 'E2'),
  }))
  const doc = await sampleDshRelease({ env: {}, now: fakeClock(1_700_000_000_000), fetchImpl: fetchImpl })

  assert.equal(doc.commits.length, 20, 'at most twenty commits are kept')
  assert.equal(doc.commits[0].message, 'commit 0', 'the newest commit stays first')
  assert.equal(doc.commits[19].message, 'commit 19', 'the list is truncated from the oldest end')
  assert.equal(doc.head.message, 'commit 0', 'the head is the newest commit')
  assert.equal(doc.releases.length, 5, 'at most five releases are kept')
  assert.equal(doc.releases[0].tag, 'dsh-v0.0.0', 'the newest release stays first')
  assert.equal(doc.releases[4].tag, 'dsh-v0.4.0', 'the release list is truncated too')
  assert.equal(doc.release.tag, 'dsh-v0.0.0', 'release is the newest of the kept releases')
  console.log('  ordering: feed order is preserved and the lists are capped at 20 commits and 5 releases')
}

// -------------------------------------------------------------- 304 reuse

{
  resetDshCache()
  const clock = fakeClock(1_700_000_000_000)
  const feeds = {
    commits: feedReply(COMMITS_FEED, 'E1'),
    releases: feedReply(RELEASES_FEED, 'E2'),
  }
  let served = 0
  const fetchImpl = fakeFetch((url) => {
    const kind = kindOf(url)
    served += 1
    return served <= 2 ? feeds[kind] : notModifiedReply(feeds[kind].headers.etag)
  })

  const first = await sampleDshRelease({ env: {}, now: clock, fetchImpl: fetchImpl })
  assert.equal(first.cached, false, 'the first sample is fresh')

  clock.advance(1000)
  const second = await sampleDshRelease({ env: {}, now: clock, fetchImpl: fetchImpl, force: true })
  assert.equal(fetchImpl.calls.length, 4, 'force re-requests both feeds')
  assert.equal(fetchImpl.calls[2].headers['if-none-match'], 'E1', 'the commit feed is polled conditionally')
  assert.equal(fetchImpl.calls[3].headers['if-none-match'], 'E2', 'the release feed is polled conditionally')
  assert.equal(second.routes.commits, 'not-modified', 'a 304 on the commit feed is reported')
  assert.equal(second.routes.releases, 'not-modified', 'a 304 on the release feed is reported')
  assert.equal(second.cached, true, 'reused feed data is cached data')
  assert.equal(second.commits.length, 1, 'the remembered commit body is reused, not an empty 304 body')
  assert.equal(second.head.sha, SHA, 'the head survives a 304')
  assert.equal(second.release.tag, RELEASE_TAG, 'the release survives a 304')
  assert.equal(second.reason, null, 'a 304 is not a failure')
  assert.equal(second.error, null, 'a 304 is not an error')
  console.log('  not-modified: a 304 reuses the remembered body instead of parsing an empty one')
}

// ------------------------------------------------------------ cache clearing

{
  resetDshCache()
  const clock = fakeClock(1_700_000_000_000)
  const fetchImpl = fakeFetch(replyByFeed({ commits: feedReply(COMMITS_FEED, 'E1'), releases: feedReply(RELEASES_FEED, 'E2') }))
  const base = { env: {}, now: clock, fetchImpl: fetchImpl, ttlMs: 5000 }

  await sampleDshRelease(base)
  resetDshCache()
  await sampleDshRelease(base)

  assert.equal(fetchImpl.calls.length, 4, 'the reset memo forces a second sample')
  assert.equal(fetchImpl.calls[2].headers['if-none-match'], undefined, 'the reset also forgets the commit ETag')
  assert.equal(fetchImpl.calls[3].headers['if-none-match'], undefined, 'and the release ETag')
  console.log('  resetDshCache: the memo, the remembered bodies and the ETags are all dropped')
}

// ------------------------------------------------------------ TTL memo

{
  resetDshCache()
  const clock = fakeClock(2_000_000_000_000)
  const fetchImpl = fakeFetch(replyByFeed({ commits: feedReply(COMMITS_FEED, 'E1'), releases: feedReply(RELEASES_FEED, 'E2') }))
  const base = { env: {}, now: clock, fetchImpl: fetchImpl, ttlMs: 5000 }

  const first = await sampleDshRelease(base)
  assert.equal(fetchImpl.calls.length, 2, 'the first sample requests both feeds')

  const second = await sampleDshRelease(base)
  assert.equal(fetchImpl.calls.length, 2, 'a call inside the TTL fetches nothing at all')
  assert.equal(second.cached, true, 'a memo hit is reported as cached')
  assert.equal(second.at, clock(), 'the memo hit is stamped with the injected clock')
  assert.equal(second.sampleSeconds, 0, 'a memo hit spends no time sampling')
  assert.equal(second.head.sha, SHA, 'the memo hit still carries the head')
  assert.notEqual(second, first, 'the memo hit is a copy, so cached does not leak into the memo')

  clock.advance(4000)
  await sampleDshRelease(base)
  assert.equal(fetchImpl.calls.length, 2, 'the memo still holds one second before the TTL')

  clock.advance(1001)
  const expired = await sampleDshRelease(base)
  assert.equal(fetchImpl.calls.length, 4, 'the memo expires at the TTL')
  assert.equal(expired.cached, false, 'the expired sample is fetched again')
  assert.equal(expired.at, clock(), 'the new sample is stamped with the new clock reading')

  const forced = await sampleDshRelease({ ...base, force: true })
  assert.equal(fetchImpl.calls.length, 6, 'force bypasses the memo')
  assert.equal(forced.cached, false, 'a forced sample is fresh')
  console.log('  memoization: the TTL is driven by the injected clock, and force ignores it')
}

// --------------------------------------------------------------- sample clock

{
  resetDshCache()
  const clock = tickingClock(1_000_000, 1090)
  const fetchImpl = fakeFetch(replyByFeed({ commits: feedReply(COMMITS_FEED, 'E1'), releases: feedReply(RELEASES_FEED, 'E2') }))
  const doc = await sampleDshRelease({ env: {}, now: clock, fetchImpl: fetchImpl })

  assert.equal(doc.at, 1_000_000 + 1090, 'at is the clock reading the sample started on')
  assert.equal(doc.sampleSeconds, 1.09, 'sampleSeconds is the elapsed time, rounded to hundredths')
  console.log('  sampleSeconds: the elapsed sampling time is rounded to two decimals')
}

// ------------------------------------------------------- direct then proxy

{
  resetDshCache()
  const fetchImpl = fakeFetch(() => new Error('offline'))
  const proxyGet = fakeProxy(replyByFeed({
    commits: feedReply(COMMITS_FEED, 'P1'),
    releases: feedReply(RELEASES_FEED, 'P2'),
  }))
  const doc = await sampleDshRelease({
    env: {},
    now: fakeClock(1_700_000_000_000),
    fetchImpl: fetchImpl,
    proxyGet: proxyGet,
    proxy: 'http://127.0.0.1:7890',
  })

  assert.equal(fetchImpl.calls.length, 2, 'the direct route is tried first, for both feeds')
  assert.equal(proxyGet.calls.length, 2, 'a failed direct route falls back to the proxy')
  assert.equal(doc.routes.commits, 'proxy', 'the commit feed is reported as proxied')
  assert.equal(doc.routes.releases, 'proxy', 'the release feed is reported as proxied')
  assert.equal(doc.routes.head, 'direct', 'the head still came from the commit feed')
  assert.equal(doc.head.sha, SHA, 'the proxied commit feed carries the head')
  assert.equal(doc.cached, false, 'a proxied answer is a fresh answer')
  assert.equal(proxyGet.calls[0].url, 'https://github.com/deepseek-ai/deepseek-harness/commits.atom',
    'the proxy is asked for the same atom URL')
  assert.equal(proxyGet.calls[0].proxy, 'http://127.0.0.1:7890', 'the configured proxy is handed over')
  assert.equal(proxyGet.calls[0].opts.timeoutMs, 8000, 'the proxy gets the default budget')
  assert.equal(proxyGet.calls[0].opts.headers['user-agent'], 'dsh-homepage', 'the proxy gets the same headers')
  console.log('  routes: a direct failure falls back to the proxy and is reported as proxied')
}

// ------------------------------------------------------- remembered body last

{
  resetDshCache()
  const clock = fakeClock(1_700_000_000_000)
  let online = true
  const fetchImpl = fakeFetch((url) => {
    if (!online) throw new Error('offline')
    return replyByFeed({ commits: feedReply(COMMITS_FEED, 'E1'), releases: feedReply(RELEASES_FEED, 'E2') })(url)
  })
  const proxyGet = fakeProxy(() => new Error('proxy offline'))
  const base = {
    env: {},
    now: clock,
    fetchImpl: fetchImpl,
    proxyGet: proxyGet,
    proxy: 'http://127.0.0.1:7890',
    ttlMs: 5000,
  }

  const first = await sampleDshRelease(base)
  assert.equal(first.cached, false, 'the first sample is fresh')

  online = false
  clock.advance(10_000)
  const second = await sampleDshRelease(base)
  assert.equal(proxyGet.calls.length, 2, 'the proxy is tried before giving up')
  assert.deepEqual(second.routes, { commits: 'error', releases: 'error', head: 'direct' },
    'both feeds are reported as failed routes')
  assert.equal(second.commits.length, 1, 'the body remembered from last time is reused')
  assert.equal(second.head.sha, SHA, 'the remembered head is reused')
  assert.equal(second.release.tag, RELEASE_TAG, 'the remembered release is reused')
  assert.equal(second.cached, true, 'data from memory is cached data')
  assert.equal(second.reason, null, 'the remembered feeds are still a valid answer')
  assert.equal(second.error, null, 'a recovered route is not an error')
  console.log('  routes: when both live routes fail, the remembered body answers instead of an empty feed')
}

// ------------------------------------------------------------- git fallback

{
  resetDshCache()
  const run = fakeRun(okRemote(SHA + '\tHEAD\n'))
  const fetchImpl = fakeFetch(() => new Error('offline'))
  const doc = await sampleDshRelease({
    env: {},
    now: fakeClock(1_700_000_000_000),
    fetchImpl: fetchImpl,
    proxyGet: fakeProxy(() => new Error('proxy offline')),
    runCommand: run,
    proxy: 'http://127.0.0.1:7890',
  })

  assert.equal(doc.routes.commits, 'error', 'the commit feed route still reports its own failure')
  assert.equal(doc.routes.head, 'git', 'the head is reported as coming from git')
  assert.equal(doc.head.sha, SHA, 'git supplies the sha')
  assert.equal(doc.head.short, SHA.slice(0, 7), 'git supplies the short sha')
  assert.equal(doc.head.message, '', 'git knows nothing about the message')
  assert.equal(doc.head.author, '', 'git knows nothing about the author')
  assert.equal(doc.head.date, '', 'git knows nothing about the date')
  assert.deepEqual(doc.commits, [], 'the commit list stays empty on the git route')
  assert.equal(doc.reason, null, 'a git answer is an answer, not a failure')
  assert.equal(run.calls.length, 1, 'git is asked exactly once')
  assert.equal(run.calls[0].command, 'git', 'the fallback runs git')
  assert.deepEqual(run.calls[0].args,
    ['ls-remote', 'https://github.com/deepseek-ai/deepseek-harness.git', 'HEAD'],
    'the fallback runs ls-remote against the repo, for HEAD only')
  assert.equal(run.calls[0].opts.env.HTTPS_PROXY, 'http://127.0.0.1:7890', 'the proxy is exported to git')
  assert.equal(run.calls[0].opts.env.HTTP_PROXY, 'http://127.0.0.1:7890', 'the lower- and upper-case proxy vars are both set')
  assert.equal(run.calls[0].opts.env.GIT_TERMINAL_PROMPT, '0', 'git can never sit waiting for credentials')
  assert.equal(run.calls[0].opts.timeoutMs, 8000, 'git gets the default budget')
  console.log('  git: when the commit feed is silent, ls-remote supplies the sha and only the sha')
}

{
  resetDshCache()
  const run = fakeRun({ ok: false, stdout: '', stderr: 'fatal: unable to access', code: 128 })
  const doc = await sampleDshRelease({
    env: {},
    now: fakeClock(1_700_000_000_000),
    fetchImpl: fakeFetch(() => new Error('offline')),
    runCommand: run,
  })

  assert.equal(doc.head, null, 'a failing git leaves no head')
  assert.equal(doc.routes.head, null, 'the head route reports nothing')
  assert.equal(doc.reason, 'network', 'no head at all is a network reason')
  assert.equal(doc.commits.length, 0, 'and no commits')
  console.log('  git: a failing ls-remote degrades to head null and reason network')
}

{
  const ok = fakeRun(okRemote(SHA + '\tHEAD\n'))
  assert.equal(await gitHeadSha({ env: {}, runCommand: ok }), SHA, 'gitHeadSha parses the HEAD line')
  assert.deepEqual(ok.calls[0].env, undefined, 'gitHeadSha passes its options, not a bare env, to the runner')

  const branch = fakeRun(okRemote('abcdef1234567890abcdef1234567890abcdef12\trefs/heads/other\n'))
  assert.equal(await gitHeadSha({ env: {}, runCommand: branch }), 'abcdef1234567890abcdef1234567890abcdef12',
    'a non-HEAD line is still a sha')

  assert.equal(await gitHeadSha({ env: {}, runCommand: fakeRun(okRemote('not a sha at all\n')) }), null,
    'output without a sha is null')
  assert.equal(await gitHeadSha({ env: {}, runCommand: fakeRun({ ok: false, stdout: SHA + '\tHEAD\n', stderr: '', code: 1 }) }), null,
    'a non-zero exit is null even when a sha was printed')
  assert.equal(await gitHeadSha({ env: {}, runCommand: fakeRun(null) }), null, 'a malformed result is null')
  assert.equal(await gitHeadSha({ env: {}, runCommand: async () => { throw new Error('boom') } }), null,
    'a throwing runner is null')
  assert.equal(await gitHeadSha({ env: {}, runCommand: () => new Promise(() => {}), timeoutMs: 20 }), null,
    'a hung git is abandoned at its budget')
  console.log('  gitHeadSha: the sha is parsed defensively and every failure is a null')
}

// --------------------------------------------------------- partial failure

{
  resetDshCache()
  const fetchImpl = fakeFetch((url) => {
    if (kindOf(url) === 'releases') throw new Error('offline')
    return feedReply(COMMITS_FEED, 'E1')
  })
  const doc = await sampleDshRelease({
    env: {},
    now: fakeClock(1_700_000_000_000),
    fetchImpl: fetchImpl,
    proxyGet: fakeProxy(() => new Error('proxy offline')),
    proxy: 'http://127.0.0.1:7890',
  })

  assert.equal(doc.routes.commits, 'direct', 'the commit feed answered')
  assert.equal(doc.routes.releases, 'error', 'the release feed failed')
  assert.equal(doc.head.sha, SHA, 'the head is unaffected by the other feed')
  assert.equal(doc.commits.length, 1, 'the commits are unaffected')
  assert.equal(doc.release, null, 'the failed feed supplies no release')
  assert.deepEqual(doc.releases, [], 'the failed feed supplies no releases')
  assert.equal(doc.reason, null, 'one failed feed is not a document-wide reason while the head is known')
  console.log('  partial: a failing release feed never empties the commit feed')
}

// ------------------------------------------------------------- parse failure

{
  resetDshCache()
  const run = fakeRun({ ok: false, stdout: '', stderr: 'fatal', code: 128 })
  const fetchImpl = fakeFetch(replyByFeed({
    commits: feedReply('<html><body>Not Found</body></html>', 'E1'),
    releases: feedReply(RELEASES_FEED, 'E2'),
  }))
  const doc = await sampleDshRelease({
    env: {},
    now: fakeClock(1_700_000_000_000),
    fetchImpl: fetchImpl,
    runCommand: run,
  })

  assert.equal(doc.reason, 'parse', 'a body with no entry is a parse failure')
  assert.deepEqual(doc.commits, [], 'a body that is not a feed yields no commits')
  assert.equal(doc.head, null, 'and no head from the feed')
  assert.equal(doc.routes.commits, 'direct', 'the route that delivered the bad body is still reported')
  assert.equal(doc.releases.length, 1, 'the other feed is parsed normally')
  assert.equal(run.calls.length, 1, 'the git fallback is tried when the commit feed yields nothing')
  assert.equal(doc.error, null, 'a parse failure is a reason, not an error')
  console.log('  parse: a non-feed body is a reason code, never a throw')
}

// ------------------------------------------------------ total network failure

{
  resetDshCache()
  const doc = await sampleDshRelease({
    env: {},
    now: fakeClock(1_700_000_000_000),
    fetchImpl: fakeFetch(() => new Error('offline')),
    proxyGet: fakeProxy(() => new Error('proxy offline')),
    proxy: 'http://127.0.0.1:7890',
    runCommand: () => { throw new Error('no git here') },
  })

  assert.deepEqual(Object.keys(doc).sort(), DOC_KEYS, 'the degraded document still has every contract key')
  assert.equal(doc.head, null, 'no head can be had')
  assert.deepEqual(doc.commits, [], 'no commits can be had')
  assert.equal(doc.release, null, 'no release can be had')
  assert.deepEqual(doc.releases, [], 'no releases can be had')
  assert.deepEqual(doc.routes, { commits: 'error', releases: 'error', head: null }, 'every route reports its failure')
  assert.equal(doc.cached, false, 'nothing was cached to reuse')
  assert.equal(doc.reason, 'network', 'a document with no head is a network reason')
  assert.equal(doc.error, null, 'the route failures are reported by the routes, not as an error')
  assert.equal(doc.repo, 'deepseek-ai/deepseek-harness', 'the repository is still named')
  assert.equal(doc.branch, 'master', 'the branch is still named')
  assert.equal(typeof doc.reason, 'string', 'reason is a string when it is set')
  console.log('  offline: with no route at all the document is complete, empty and marked network')
}

{
  resetDshCache()
  const doc = await sampleDshRelease({
    env: {},
    now: fakeClock(1_700_000_000_000),
    fetchImpl: fakeFetch(() => new Error('offline')),
    runCommand: fakeRun({ ok: false, stdout: '', stderr: '', code: 1 }),
  })
  assert.equal(doc.routes.releases, 'error', 'with no proxy configured the feeds simply fail')
  assert.equal(doc.reason, 'network', 'and the reason is still network')
  assert.equal(doc.error, null, 'no unexpected failure is invented')
  console.log('  offline: without a proxy the sampler degrades the same way instead of hanging')
}

// -------------------------------------------------------------- never rejects

{
  resetDshCache()
  const hostile = {}
  Object.defineProperty(hostile, 'now', {
    enumerable: true,
    get() { throw new Error('hostile now') },
  })
  const doc = await sampleDshRelease(hostile)

  assert.deepEqual(Object.keys(doc).sort(), DOC_KEYS, 'a hostile option bag still yields every contract key')
  assert.equal(doc.reason, 'network', 'and a reason code')
  assert.equal(typeof doc.error, 'string', 'and the failure is explained')
  assert.equal(doc.head, null, 'with no head')
  assert.equal(doc.repo, 'deepseek-ai/deepseek-harness', 'the repository falls back to the default')
  assert.equal(typeof doc.at, 'number', 'and the document is still stamped')
  console.log('  never-rejects: an option bag that throws on read is absorbed')
}

{
  const malformed = [null, undefined, 'string', 42, {}, { status: 'nope' }, { status: 200 }]
  for (const value of malformed) {
    resetDshCache()
    const doc = await sampleDshRelease({
      env: {},
      now: fakeClock(1_700_000_000_000),
      fetchImpl: fakeFetch(() => value),
      runCommand: fakeRun({ ok: false, stdout: '', stderr: '', code: 1 }),
    })
    assert.equal(doc.commits.length, 0, 'a malformed reply (index ' + String(malformed.indexOf(value)) + ') is not data')
    assert.equal(doc.head, null, 'a malformed reply has no head')
    assert.deepEqual(Object.keys(doc).sort(), DOC_KEYS, 'a malformed reply keeps the document complete')
  }
  console.log('  never-rejects: malformed and partial fetch replies all degrade safely')
}

{
  resetDshCache()
  const started = Date.now()
  const doc = await sampleDshRelease({
    env: {},
    now: fakeClock(1_700_000_000_000),
    fetchImpl: () => new Promise(() => {}),
    proxyGet: fakeProxy(() => new Error('proxy offline')),
    proxy: 'http://127.0.0.1:7890',
    runCommand: () => new Promise(() => {}),
    timeoutMs: 20,
  })
  const elapsed = Date.now() - started

  assert.ok(elapsed < 2000, 'the sampler returned promptly instead of waiting for hung I/O (' + elapsed + 'ms)')
  assert.equal(doc.reason, 'network', 'hung I/O ends as a network reason')
  assert.deepEqual(doc.routes, { commits: 'error', releases: 'error', head: null }, 'and every route is failed')
  console.log('  never-rejects: a fetch, proxy and git that never settle are abandoned at their budget (' + elapsed + 'ms)')
}

// ------------------------------------------------------------------- helpers

/**
 * Wrap entries in an Atom feed envelope.
 * @param entries - the raw `<entry>` strings.
 * @returns the feed XML.
 */
function feedOf(entries) {
  return '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<feed xmlns="http://www.w3.org/2005/Atom">\n'
    + entries.join('\n')
    + '\n</feed>'
}

/**
 * One synthetic commit entry with a given sha.
 * @param sha - the 40-character sha.
 * @param title - the commit title.
 * @returns the `<entry>` XML.
 */
function commitEntry(sha, title) {
  return '<entry><id>tag:github.com,2008:Grit::Commit/' + sha + '</id>'
    + '<link type="text/html" rel="alternate" href="https://github.com/o/r/commit/' + sha + '"/>'
    + '<title>' + title + '</title>'
    + '<updated>2026-10-15T00:00:00Z</updated>'
    + '<author><name>author</name></author>'
    + '<content type="html">body</content></entry>'
}

/**
 * One synthetic release entry with a given tag.
 * @param tag - the release tag.
 * @param name - the release name.
 * @returns the `<entry>` XML.
 */
function releaseEntry(tag, name) {
  return '<entry><id>tag:github.com,2008:Repository/1/' + tag + '</id>'
    + '<title>' + name + '</title>'
    + '<link type="text/html" rel="alternate" href="https://github.com/o/r/releases/tag/' + tag + '"/>'
    + '<updated>2026-10-15T00:00:00Z</updated>'
    + '<content type="html">notes</content></entry>'
}

/**
 * A deterministic 40-character sha-shaped string for an index.
 * @param index - the entry index.
 * @returns the sha.
 */
function shaOf(index) {
  return (index + 1).toString(16).padStart(40, '0')
}

/**
 * Which feed a URL points at.
 * @param url - the requested URL.
 * @returns 'commits' or 'releases'.
 */
function kindOf(url) {
  return String(url).indexOf('releases.atom') >= 0 ? 'releases' : 'commits'
}

/**
 * Build a deterministic clock whose `advance` moves it forward.
 * @param start - the initial epoch ms.
 * @returns a callable clock with `advance(ms)` and `set(ms)`.
 */
function fakeClock(start) {
  let current = start
  const clock = () => current
  clock.advance = (ms) => {
    current += ms
    return current
  }
  clock.set = (ms) => {
    current = ms
    return current
  }
  return clock
}

/**
 * Build a clock that steps forward on every read, to exercise elapsed time.
 * @param start - the initial epoch ms.
 * @param step - the milliseconds added by every read.
 * @returns a callable clock.
 */
function tickingClock(start, step) {
  let current = start
  return () => {
    current += step
    return current
  }
}

/**
 * One successful feed reply.
 * @param text - the body.
 * @param etag - the ETag the server sends, when it sends one.
 * @returns the reply.
 */
function feedReply(text, etag) {
  return { status: 200, headers: etag === undefined ? {} : { etag: etag }, text: text }
}

/**
 * One `304 Not Modified` reply.
 * @param etag - the ETag the server repeats.
 * @returns the reply.
 */
function notModifiedReply(etag) {
  return { status: 304, headers: etag === undefined ? {} : { etag: etag }, text: '' }
}

/**
 * A reply generator keyed by feed, so one fake can serve both feeds.
 *
 * A missing entry throws, which is what a machine with no network looks like.
 * @param replies - `{ commits, releases }` replies.
 * @returns a `(url) => reply` function.
 */
function replyByFeed(replies) {
  return (url) => {
    const reply = replies[kindOf(url)]
    if (reply === undefined || reply === null) throw new Error('offline: ' + url)
    return reply
  }
}

/**
 * Build a `fetch` stub, recording every request.
 * @param replyFor - a canned reply, an Error to throw, or `(url, init) => reply`.
 * @returns an async `fetchImpl` carrying its `calls` array.
 */
function fakeFetch(replyFor) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({
      url: url,
      headers: Object.assign({}, init && init.headers),
      signal: init ? init.signal : undefined,
    })
    const reply = typeof replyFor === 'function' ? replyFor(url, init) : replyFor
    if (reply instanceof Error) throw reply
    if (reply === null || reply === undefined) throw new Error('offline: ' + url)
    return {
      status: reply.status,
      headers: { get: (name) => headerValue(reply.headers, name) },
      text: async () => (typeof reply.text === 'string' ? reply.text : ''),
    }
  }
  fetchImpl.calls = calls
  return fetchImpl
}

/**
 * Build a `proxyGet` stub, recording every request.
 *
 * Like the contract's own proxy shape, the body is handed back as a string on
 * `text` rather than as a `text()` method.
 * @param replyFor - a canned reply, an Error to throw, or `(url, proxy, opts) => reply`.
 * @returns an async `proxyGet` carrying its `calls` array.
 */
function fakeProxy(replyFor) {
  const calls = []
  const proxyGet = async (url, proxyUrl, opts) => {
    calls.push({ url: url, proxy: proxyUrl, opts: opts })
    const reply = typeof replyFor === 'function' ? replyFor(url, proxyUrl, opts) : replyFor
    if (reply instanceof Error) throw reply
    if (reply === null || reply === undefined) throw new Error('proxy offline: ' + url)
    return { status: reply.status, headers: Object.assign({}, reply.headers), text: reply.text }
  }
  proxyGet.calls = calls
  return proxyGet
}

/**
 * Build a `runCommand` stub, recording every call.
 * @param resultFor - a canned result, an Error to throw, or `(command, args, opts) => result`.
 * @returns an async `runCommand` carrying its `calls` array.
 */
function fakeRun(resultFor) {
  const calls = []
  const runner = async (command, args, opts) => {
    calls.push({ command: command, args: args, opts: opts })
    const result = typeof resultFor === 'function' ? resultFor(command, args, opts) : resultFor
    if (result instanceof Error) throw result
    return result
  }
  runner.calls = calls
  return runner
}

/**
 * One successful `git ls-remote` result.
 * @param stdout - what git printed.
 * @returns the command result.
 */
function okRemote(stdout) {
  return { ok: true, stdout: stdout, stderr: '', code: 0 }
}

/**
 * Read one header off a plain header object.
 * @param headers - the header object.
 * @param name - the header name.
 * @returns the value, or null.
 */
function headerValue(headers, name) {
  if (headers === null || typeof headers !== 'object') return null
  const key = String(name).toLowerCase()
  for (const candidate of Object.keys(headers)) {
    if (candidate.toLowerCase() === key) return headers[candidate]
  }
  return null
}

console.log('dsh-sampler: all assertions passed')
