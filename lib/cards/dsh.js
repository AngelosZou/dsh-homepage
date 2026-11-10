/**
 * Card module: DSH — is there a new commit or a new release in the upstream
 * harness repository, and can this machine lay that version down beside the one
 * it is running right now?
 *
 * Spliced into the client factory by scripts/build-client.mjs, inside
 * `(function (kit) { ... })(Kit)`, so this file may assume `kit` is in scope.
 * It defines and registers itself — adding a card is adding this file.
 *
 * The card is a tool for ONE kind of installation: a DSH that was built from a
 * source checkout. For that machine it compares the running build with the
 * upstream release and lays the new version down beside it. Every other
 * installation — the official desktop app, a community wrapper, a core
 * installed from npm — has no checkout to compare and no build to replace, and
 * the card says so in its first line instead of showing a red failure it
 * cannot fix. That is why the card asks the host how this DSH was installed
 * (`install.kind`) before it says anything about the upstream: on a machine the
 * card was never about, a GitHub it cannot reach is a footnote, not an error.
 *
 * Two halves answer the question. The host half (`lib/host/dsh.js`) reads the
 * repository feeds — a browser cannot, and the anonymous GitHub API quota is
 * already spent, so it uses the atom feeds with an `If-None-Match` on every
 * poll. The installer half (`lib/host/dsh-install.js`) turns "get me that
 * version" into a detached terminal window, because building a DSH core takes
 * minutes and doing that inside the process that is serving this page would
 * stall the page.
 *
 * What counts as news is decided here, not upstream: the comparison is between
 * the upstream commit and release and the commit this machine actually runs,
 * so "up to date" means the checkout on disk, not that the card has looked
 * before.
 *
 * @module dsh-homepage/cards/dsh
 */

   var h = kit.h
   var React = kit.React
   var UI = kit.UI
   var ICONS = kit.ICONS
   var runtime = kit.runtime
   var defineCard = kit.defineCard
   var dict = kit.dict
   var useRemote = kit.useRemote
   var useAnnounce = kit.useAnnounce
   var requestReload = kit.requestReload
   var publishReloader = kit.publishReloader
   var remoteCall = kit.remoteCall

   /**
    * How often the card re-reads upstream. The host memoises its document for
    * the same window and answers a conditional request with a 304, so a poll
    * that finds nothing new costs one header exchange.
    */
   var CHECK_REFRESH_MS = 300000

   // ---------------------------------------------------------- readings

   /** @returns the short form of a commit sha. */
   function shortSha(sha) {
     var text = String(sha || '')
     return text.length > 7 ? text.slice(0, 7) : text
   }

   /**
    * A timestamp as "how long ago", falling back to the date itself once it is
    * older than a fortnight — at that distance a day count stops meaning
    * anything and the user wants to see which month it was.
    * @param t - the translator.
    * @param value - an ISO timestamp.
    * @returns a short phrase, or an empty string.
    */
   function whenText(t, value) {
     var at = Date.parse(String(value || ''))
     if (!isFinite(at)) return ''
     var seconds = Math.max(0, (Date.now() - at) / 1000)
     if (seconds < 90) return t('dsh.when.now')
     var minutes = Math.round(seconds / 60)
     if (minutes < 60) return t('dsh.when.minutes', { count: minutes })
     var hours = Math.round(minutes / 60)
     if (hours < 36) return t('dsh.when.hours', { count: hours })
     var days = Math.round(hours / 24)
     if (days <= 14) return t('dsh.when.days', { count: days })
     return t('dsh.when.date', { date: String(value || '').slice(0, 10) })
   }

   /**
    * The local cores the host found, newest first. The host sorts them too,
    * but the verdict must not depend on that.
    * @param local - the `dshLocal` remote.
    * @returns an array of core entries.
    */
   function localCores(local) {
     var list = (local && local.data && Array.isArray(local.data.versions)) ? local.data.versions : []
     return list.slice().sort(function (a, b) {
       var at = Date.parse(String((a && a.commitDate) || ''))
       var bt = Date.parse(String((b && b.commitDate) || ''))
       if (isFinite(at) && isFinite(bt)) return bt - at
       if (isFinite(at)) return -1
       if (isFinite(bt)) return 1
       return String((a && a.name) || '').localeCompare(String((b && b.name) || ''))
     })
   }

   /**
    * The core that is running this page, not the newest one on disk. The Host
    * reports the directory it was started from (`running`); a packaged
    * Desktop reports its core as the `desktop` entry. A legacy Host/fixture
    * with no `running` field falls back to the newest entry, preserving the
    * old reading, and an explicit empty string means "no local build runs".
    * @param local - the `dshLocal` remote.
    * @returns a core entry, or null.
    */
   function runningCore(local) {
     if (!local || !local.data) return null
     var entries = localCores(local)
     var desktop = entries.filter(function (entry) { return entry && entry.kind === 'desktop' })[0] || null
     if (desktop) return desktop
     var running = local.data.running
     if (typeof running === 'string') {
       if (running === '') return null
       return entries.filter(function (entry) { return entry && entry.dir === running })[0] || null
     }
     return entries[0] || null
   }

   /** @returns whether two core entries describe the same installation. */
   function sameCore(a, b) {
     if (!a || !b) return false
     if (a.kind === 'desktop' || b.kind === 'desktop') return a.kind === b.kind
     if (a.dir && b.dir) return a.dir === b.dir
     return Boolean(a.name) && a.name === b.name
   }

   /**
    * One core's identity on a single line: its commit, the tag it is on if it
    * has one, the branch it came from and how old the commit is. The commit
    * comes first because it is always there, while a shallow clone has no tags
    * at all.
    * @param entry - a local core entry.
    * @returns a ` · `-joined phrase.
    */
   function coreFacts(t, entry) {
     if (!entry) return ''
     var bits = []
     if (entry.sha) bits.push(shortSha(entry.sha))
     else if (entry.short) bits.push(shortSha(entry.short))
     if (entry.tag) bits.push(entry.tag)
     if (entry.branch) bits.push(entry.branch)
     if (entry.kind === 'desktop') bits.push(t('dsh.local.desktop'))
     var when = whenText(t, entry.commitDate)
     if (when) bits.push(when)
     return bits.join(' · ')
   }

   /**
    * The local reading sits directly under the upstream one, so it is the
    * commit — the thing that decides whether the two are the same — and not the
    * version string, which is already on the row above. The directory that
    * commit came from is a hover away.
    * @returns the local core's short sha, or its version when it has no commit.
    */
   function coreLabel(entry) {
     if (!entry) return ''
     if (entry.sha || entry.short) return shortSha(entry.sha || entry.short)
     if (entry.kind === 'desktop' && entry.version) return 'v' + String(entry.version).replace(/^v/i, '')
     if (entry.tag || entry.version) return entry.tag || entry.version
     return ''
   }

   /**
    * One local core against the upstream: the question the card exists to
    * answer. The commit date is what decides when the tags cannot (a shallow
    * clone never fetched any tag).
    * @param entry - a local core entry.
    * @returns `{ tone, text }`.
    */
   function syncState(t, entry, head, release) {
     if (entry.sha && head && entry.sha === head.sha) return { tone: 'ok', text: t('dsh.synced') }
     if (entry.tag && release && entry.tag === release.tag) return { tone: 'ok', text: t('dsh.synced') }
     // A packaged Desktop has no commit to compare. Its version tag is the
     // identity, so a mismatch is "behind", not "no commit".
     if (entry.kind === 'desktop' && release) return { tone: 'warn', text: t('dsh.behind') }
     var at = Date.parse(String(entry.commitDate || ''))
     var upstreamAt = Date.parse(String((head && head.date) || ''))
     if (isFinite(at) && isFinite(upstreamAt) && at >= upstreamAt) return { tone: 'ok', text: t('dsh.synced') }
     if (entry.sha) return { tone: 'warn', text: t('dsh.behind') }
     return { tone: 'error', text: t('dsh.noCommit') }
   }

   /** @returns a refusal reason as a sentence. */
   function reasonText(t, reason) {
     var known = ['no-root', 'no-version', 'bad-root', 'exists', 'no-git', 'no-pnpm', 'busy']
     if (known.indexOf(String(reason)) >= 0) return t('dsh.reason.' + reason)
     return t('dsh.reason.generic', { reason: String(reason || '') })
   }

   /**
    * The upstream failure as a sentence. `reason` is the host's document-level
    * code; a field that failed while its sibling answered still needs a label,
    * so the route is consulted when the code is absent.
    * @param t - the translator.
    * @param reason - 'network', 'parse', or anything else.
    * @returns a user-facing phrase.
    */
   function upstreamReasonText(t, reason) {
     if (reason === 'parse') return t('dsh.reason.parse')
     return t('dsh.reason.network')
   }

   /**
    * Whether one upstream field was emptied by a failed read rather than by a
    * successful read that had nothing to report. The distinction is the whole
    * difference between "读不到" and "无发布".
    * @param data - the upstream document.
    * @param kind - 'head' or 'release'.
    * @returns false, or the failure phrase.
    */
   function fieldFailure(t, data, kind) {
     if (!data) return false
     var routes = data.routes || {}
     if (kind === 'head') {
       if (data.head) return false
       if (data.reason) return upstreamReasonText(t, data.reason)
       if (routes.commits === 'error') return upstreamReasonText(t, 'network')
       return false
     }
     if (data.release) return false
     if (routes.releases === 'error') return upstreamReasonText(t, 'network')
     if (data.reason === 'parse') return upstreamReasonText(t, 'parse')
     return false
   }

   // -------------------------------------------------------------- state

   /**
    * How this DSH was installed, as the host reports it: 'source' for a
    * checkout on disk, 'desktop' for the official app, 'package' for a core
    * that was installed rather than built, 'unknown' when the host cannot
    * tell. A host that does not report it yet is read the old way — a desktop
    * entry means the desktop app, a running directory means a checkout.
    * @param local - the `dshLocal` remote.
    * @returns one of the four kinds.
    */
   function installKind(local) {
     var install = local && local.data && local.data.install
     if (install && typeof install.kind === 'string' && install.kind !== '') return install.kind
     var entries = localCores(local)
     for (var index = 0; index < entries.length; index += 1) {
       if (entries[index] && entries[index].kind === 'desktop') return 'desktop'
     }
     if (local && local.data && typeof local.data.running === 'string' && local.data.running !== '') return 'source'
     return 'unknown'
   }

   /**
    * What the card has to say, and how loudly.
    *
    * "Up to date" has to mean *this machine already has the upstream commit*,
    * not "this card has looked before": a timestamp the card remembered says
    * nothing about what is unpacked on disk, and it reads as a lie the moment
    * the card is mounted on a box that is behind. The comparison is the core's
    * own git state — its commit sha, and the committer date that catches a
    * shallow clone whose tags were never fetched.
    *
    * A machine that is not a local source build gets its own answer first: the
    * card does not apply here, so there is nothing to compare and an
    * unreachable upstream is a footnote rather than a failure.
    * @param t - the translator.
    * @param data - the upstream document.
    * @param local - the `dshLocal` remote.
    * @param kind - how this DSH was installed.
    * @param root - the install root in use.
    * @returns `{ level, text, tone }` — level drives the tone.
    */
   function verdict(t, data, local, kind, root) {
     var head = data && data.head
     var release = data && data.release
     if (kind !== 'source') {
       return {
         level: kind === 'unknown' ? 'unknown' : 'packaged',
         text: t(kind === 'unknown' ? 'dsh.state.unknownInstall' : 'dsh.state.packaged'),
         tone: null,
       }
     }
     if (local && local.error) return { level: 'unknown', text: t('dsh.state.localError'), tone: 'warn' }
     if (!local || !local.data) return { level: 'scanning', text: t('dsh.state.scanning'), tone: null }
     // An upstream that cannot be read is the headline: nothing can be compared
     // until it can, whatever else the machine has to say.
     if (!head && !release) return { level: 'offline', text: t('dsh.state.offline'), tone: 'warn' }
     var entries = localCores(local)
     var running = runningCore(local)
     // An empty root is only a refusal when nothing described this machine.
     // A packaged Desktop reports its core from the build version without a
     // filesystem root, and that reading is just as local.
     if (!root && !running) return { level: 'unknown', text: t('dsh.state.needRoot'), tone: 'warn' }
     if (entries.length === 0) return { level: 'none', text: t('dsh.state.none'), tone: 'warn' }
     // Directories exist but none of them is the running core. Claiming
     // "up to date" from a directory this page is not running would be a lie.
     if (!running) return { level: 'unknown', text: t('dsh.state.runningUnknown'), tone: 'warn' }
     var newestAt = Date.parse(String(running.commitDate || ''))
     var headAt = Date.parse(String((head && head.date) || ''))
     if (head && running.sha && running.sha === head.sha) {
       return { level: 'current', text: t('dsh.state.current'), tone: 'ok' }
     }
     if (release && running.tag && running.tag === release.tag) {
       return { level: 'current', text: t('dsh.state.current'), tone: 'ok' }
     }
     if (isFinite(newestAt) && isFinite(headAt) && newestAt >= headAt) {
       return { level: 'current', text: t('dsh.state.current'), tone: 'ok' }
     }
     var releaseAt = Date.parse(String((release && release.publishedAt) || ''))
     if (release && isFinite(releaseAt) && (!isFinite(newestAt) || releaseAt > newestAt)) {
       return { level: 'new', text: t('dsh.state.release'), tone: 'warn' }
     }
     return { level: 'new', text: t('dsh.state.commit'), tone: 'warn' }
   }

   /**
    * The upstream as one value: the release the user reads, or the commit when
    * only that feed answered. A feed that could not be read is a fact about
    * the network, so it is worded as one and never as a failure of the card.
    * @param t - the translator.
    * @param data - the upstream document.
    * @returns `{ text, failed, title }`.
    */
   function upstreamReading(t, data) {
     var release = data && data.release
     if (release) return { text: release.name, failed: false, title: '' }
     var head = data && data.head
     if (head) return { text: shortSha(head.sha), failed: false, title: '' }
     return { text: t('dsh.row.unreadable'), failed: true, title: upstreamReasonText(t, data && data.reason) }
   }

   /**
    * This machine as one value: the commit of the build that runs, the version
    * of a packaged build, or a dash when the host cannot name it.
    * @param t - the translator.
    * @param local - the `dshLocal` remote.
    * @returns `{ text, title, mono, failed }`.
    */
   function localReading(t, local) {
     var running = runningCore(local)
     if (running) {
       // Only a commit is set in monospace: a packaged build has a version, and
       // a version in a code font reads like a hash it is not.
       return {
         text: coreLabel(running),
         title: String(running.name || ''),
         mono: Boolean(running.sha || running.short),
         failed: false,
       }
     }
     if (local && local.error) {
       return { text: t('dsh.row.localError'), title: String(local.error), mono: false, failed: true }
     }
     if (!local || !local.data) {
       return { text: t('dsh.row.scanning'), title: '', mono: false, failed: false }
     }
     var install = local.data.install || {}
     if (install.version) {
       return { text: 'v' + String(install.version).replace(/^v/i, ''), title: '', mono: false, failed: false }
     }
     return { text: t('dsh.row.unnamed'), title: '', mono: false, failed: false }
   }

   // =============================================================== 6. dsh

   /**
    * The compact card: what upstream is at, and whether that is different from
    * what this machine runs. Two readings and one verdict — a version number is
    * the thing a user came for, and the difference is worth one word.
    */
   function DshCard(props) {
     var t = props.t
     var api = props.api
     var remote = useRemote('homepage/dsh', {}, { refreshMs: CHECK_REFRESH_MS })
     var data = remote.data
     var error = remote.error
     var storedRoot = api.control('root') || ''
     // The verdict is a comparison against what is unpacked here, so the
     // preview needs the local scan as well: a card that only reads upstream
     // cannot tell "up to date" from "this box is a day behind". An empty
     // control still asks: the Host resolves the root from the running core.
     var local = useRemote('homepage/dshLocal', { options: { root: storedRoot } },
       { enabled: true, refreshMs: CHECK_REFRESH_MS })
     var root = storedRoot || (local && local.data && typeof local.data.root === 'string' ? local.data.root : '')
     React.useEffect(function () {
       // A plain refresh re-reads; the host memoises for five minutes, so it is
       // cheap by design. "Force" is the other half of the combo: it asks the
       // host to revalidate the feeds, then reloads with what came back.
       return publishReloader('dsh', function (force) {
         void remote.reload(false)
         void local.reload(false)
         if (force) void remoteCall('homepage/dshCheck', {}).then(function () { void remote.reload(true) }).catch(function () {})
       })
     }, [remote.reload, local.reload])
     var kind = installKind(local)
     var state = verdict(t, data, local, kind, root)
     // An upstream that reads fine is not news; a read that found nothing is.
     // The host never rejects, so `remote.error` cannot carry this: the
     // document's own reason is the only signal that the network failed. It
     // is worth a notice only where it costs the user something — on a machine
     // the card is about.
     useAnnounce(api, 'dsh', kind === 'source' && state.level === 'offline'
       ? { level: 'warn', text: t('dsh.notice.unavailable', { reason: upstreamReasonText(t, data && data.reason) }) }
       : null)
     if (error) return h('div', null, h(UI.Chip, { tone: 'error' }, t('common.error')), h('p', { className: 'ph-inline-empty' }, error))
     if (!data) return h('div', { className: 'ph-hero ph-hero--wait' }, h('span', { className: 'ph-hero-value' }, '—'))
     var upstream = upstreamReading(t, data)
     var here = localReading(t, local)
     var retry = function () {
       void remote.reload(false)
       void local.reload(false)
       void remoteCall('homepage/dshCheck', {}).then(function () { void remote.reload(true) }).catch(function () {})
     }
     return h('div', { className: 'ph-specs' },
       h('div', { className: 'ph-spec-list' },
         h('div', { className: 'ph-spec' },
           h('span', { className: 'ph-spec-name' }, t('dsh.row.upstream')),
           h('span', {
             className: 'ph-spec-value' + (upstream.failed ? ' ph-spec-value--muted' : ''),
             title: upstream.title || undefined,
           }, upstream.text),
         ),
         h('div', { className: 'ph-spec' },
           h('span', { className: 'ph-spec-name' }, t('dsh.row.local')),
           h('span', {
             className: 'ph-spec-value' + (here.mono ? ' ph-mono' : '') + (here.failed ? ' ph-spec-value--muted' : ''),
             title: here.title || undefined,
           }, here.text),
         ),
       ),
       h('div', { className: 'ph-spec-foot' },
         h(UI.Chip, { tone: state.tone }, state.text),
         state.level === 'offline'
           ? h('button', {
             type: 'button',
             className: 'ph-link',
             title: t('dsh.retryHint'),
             onClick: retry,
           }, t('dsh.retry'))
           : h('span', null, kind === 'source'
             ? (data.at ? t('dsh.checked', { when: whenText(t, new Date(data.at).toISOString()) }) : '')
             : t('dsh.scope.hint')),
       ),
     )
   }

   /**
    * The expanded page: what the card is for, what this machine is, and the
    * one action the card exists for.
    *
    * The purpose comes first and the details follow it, because the machine
    * this card is mounted on is often not the machine the card is about: a
    * packaged DSH has no build to update, and saying so up front is the whole
    * difference between a card that explains itself and one that looks broken.
    */
   function DshDetail(props) {
     var t = props.t
     var api = props.api
     var remote = useRemote('homepage/dsh', {}, { refreshMs: CHECK_REFRESH_MS })
     var data = remote.data
     var error = remote.error
     var storedRoot = api.control('root') || ''
     var local = useRemote('homepage/dshLocal', { options: { root: storedRoot } }, { enabled: true })
     var root = storedRoot || (local && local.data && typeof local.data.root === 'string' ? local.data.root : '')
     var launch = React.useState({ busy: false, done: null, failed: null })
     var job = launch[0]
     var setJob = launch[1]
     var fold = React.useState(true)
     var folded = fold[0]
     var setFolded = fold[1]
     React.useEffect(function () {
       // A plain refresh re-reads; the host memoises for five minutes, so it is
       // cheap by design. "Force" is the other half of the combo: it asks the
       // host to revalidate the feeds, then reloads with what came back.
       return publishReloader('dsh', function (force) {
         void remote.reload(false)
         void local.reload(false)
         if (force) void remoteCall('homepage/dshCheck', {}).then(function () { void remote.reload(true) }).catch(function () {})
       })
     }, [remote.reload, local.reload])
     if (error) return h('div', null, h('p', { className: 'ph-inline-empty' }, error))
     if (!data) return h('p', { className: 'ph-inline-empty' }, t('dsh.loading'))
     var head = data.head
     var release = data.release
     var kind = installKind(local)
     var state = verdict(t, data, local, kind, root)
     var versions = localCores(local)
     // The Desktop core is the running version, not a directory under the
     // local-build root: the list below is the builds a user can manage.
     var builds = versions.filter(function (entry) { return !entry || entry.kind !== 'desktop' })
     var running = runningCore(local)
     var upstream = upstreamReading(t, data)
     var here = localReading(t, local)
     var upstreamFailed = upstream.failed
     var upstreamFacts = coreFacts(t, running)
     var headFailure = fieldFailure(t, data, 'head')
     var releaseFailure = fieldFailure(t, data, 'release')
     var releaseRoute = data.routes && data.routes.releases
     var registrySource = releaseRoute === 'npm' || releaseRoute === 'npmmirror'
     var routesText = [data.routes && data.routes.commits, data.routes && data.routes.releases, data.routes && data.routes.head]
       .map(function (route) { return route || '—' })
       .join(' · ')
     var retry = function () {
       void remote.reload(false)
       void local.reload(false)
       void remoteCall('homepage/dshCheck', {}).then(function () { void remote.reload(true) }).catch(function () {})
     }
     var install = function () {
       if (!release || job.busy) return
       setJob({ busy: true, done: null, failed: null })
       api.remote('homepage/dshInstall', { options: { root: root, version: release.name, ref: release.tag } })
         .then(function (result) {
           if (result && result.started) {
             setJob({ busy: false, done: result, failed: null })
             api.announce('info', t('dsh.started', { version: release.name }))
           } else {
             var why = result && result.reason ? result.reason : 'unknown'
             setJob({ busy: false, done: null, failed: why })
             api.announce('warn', reasonText(t, why))
           }
           return null
         })
         .catch(function (failure) {
           var message = String(failure && failure.message ? failure.message : failure)
           setJob({ busy: false, done: null, failed: message })
           return null
         })
     }
     var packaged = kind !== 'source'
     return h('div', { className: 'ph-detail-block ph-dsh-detail' },
       h('section', { className: 'ph-dsh-launch' },
         h('div', { className: 'ph-dsh-launch-head' },
           h('div', { className: 'ph-dsh-launch-heading' },
             h('span', { className: 'ph-dsh-launch-icon', 'aria-hidden': true }, '⬡'),
             h('h3', { className: 'ph-dsh-launch-title' }, t('dsh.panel.title'))),
           h(UI.Chip, { tone: state.tone }, state.text)),
         h('p', { className: 'ph-dsh-purpose' }, t('dsh.purpose')),
         packaged
           ? h('p', { className: 'ph-dsh-scope' }, t(kind === 'unknown' ? 'dsh.scope.unknown' : 'dsh.scope.packaged', {
             version: here.text && here.text !== '—' ? here.text : '',
           }))
           : null,
         upstreamFailed
           ? h('p', { className: 'ph-dsh-reason' }, upstreamReasonText(t, data.reason))
           : null,
         h('div', { className: 'ph-dsh-readings' },
           h('div', { className: 'ph-dsh-reading' },
             h('span', { className: 'ph-dsh-reading-label' }, t('dsh.row.local')),
             h('span', { className: 'ph-dsh-reading-value ph-mono', title: here.title ? here.title + (upstreamFacts ? ' · ' + upstreamFacts : '') : upstreamFacts }, here.text)),
           h('div', { className: 'ph-dsh-reading' },
             h('span', { className: 'ph-dsh-reading-label' }, t('dsh.row.upstream')),
             h('span', {
               className: 'ph-dsh-reading-value' + (upstream.failed ? ' ph-spec-value--muted' : ''),
               title: upstream.title || undefined,
             }, upstream.text)),
         ),
       ),

       h('div', { className: 'ph-section-head' },
         h('h4', null, t('dsh.section.builds')),
         h('span', { className: 'ph-head-spacer' }),
         state.level === 'offline'
           ? h('button', { type: 'button', className: 'ph-link', title: t('dsh.retryHint'), onClick: retry }, t('dsh.retry'))
           : null,
       ),
       h(UI.Field, { label: t('dsh.root') },
         h(UI.Text, {
           value: storedRoot,
           // A packaged build has no directory to detect: the field is the only
           // way to tell the card where a local build should live.
           placeholder: root !== '' ? root : t(packaged ? 'dsh.rootHint.packaged' : 'dsh.rootHint'),
           mono: true,
           onChange: function (next) { api.setControl('root', next) },
         }),
       ),
       builds.length > 0
         ? h('div', { className: 'ph-tools' }, builds.map(function (entry) {
           var sync = syncState(t, entry, head, release)
           return h('div', { key: entry.dir || entry.name, className: 'ph-tool' },
             h('span', { className: 'ph-tool-name ph-mono' }, entry.name),
             h('span', { className: 'ph-tool-facts' }, coreFacts(t, entry)),
             h('span', { className: 'ph-tool-tags' },
               sameCore(entry, running) ? h(UI.Chip, { tone: 'ok' }, t('dsh.runningChip')) : null,
               h(UI.Chip, { tone: sync.tone }, sync.text),
               // `hasBuild` is the build record the DSH build itself writes
               // (and the installer's completion marker), not the marker alone:
               // a core cloned by hand is built too, and calling it unbuilt
               // would be the same kind of lie the verdict just stopped telling.
               entry.hasBuild === false ? h(UI.Chip, { tone: 'warn' }, t('dsh.notBuilt')) : null,
             ),
           )
         }))
         : h('p', { className: 'ph-inline-empty' }, root === '' ? t('dsh.needRoot') : t('dsh.noInstalled')),

       h('div', { className: 'ph-actions' },
         h('span', { className: 'ph-action' },
           h(UI.Button, {
             icon: ICONS.download(14),
             tone: state.level === 'new' ? 'primary' : undefined,
             disabled: job.busy || !release || root === '',
             onClick: install,
           }, job.busy
             ? t('dsh.installing')
             : (release
               ? t(packaged ? 'dsh.install.local' : 'dsh.install', { version: release.name })
               : t('dsh.noRelease'))),
         ),
       ),
       packaged ? h('p', { className: 'ph-note' }, t('dsh.note.local')) : null,
       job.done ? h('p', { className: 'ph-note ph-dsh-ok' },
         t('dsh.started', { version: job.done.version || (release ? release.name : '') })) : null,
       job.failed ? h('p', { className: 'ph-note ph-dsh-fail' }, reasonText(t, job.failed)) : null,

       h('button', {
         type: 'button',
         className: 'ph-dsh-more',
         'aria-expanded': folded ? 'false' : 'true',
         onClick: function () { setFolded(!folded) },
       }, h('span', { 'aria-hidden': true }, folded ? '▸' : '▾'), t(folded ? 'dsh.more.show' : 'dsh.more.hide')),
       h('div', { className: 'ph-dsh-reveal', hidden: folded },
         h('div', { className: 'ph-dsh-reveal-inner' },
           h('div', { className: 'ph-kv' },
             h('div', { className: 'ph-kv-row' },
               h('span', { className: 'ph-kv-key' }, t('dsh.branch')),
               h('span', { className: 'ph-kv-value' }, data.branch || 'master'),
             ),
             // A field that failed is not repeated on every row: the reason is
             // stated once, and the rows that could not be read are simply
             // absent.
             head ? h('div', { className: 'ph-kv-row' },
               h('span', { className: 'ph-kv-key' }, t('dsh.head')),
               h('span', { className: 'ph-kv-value ph-mono ph-break' }, head.sha),
             ) : null,
             head ? h('div', { className: 'ph-kv-row' },
               h('span', { className: 'ph-kv-key' }, t('dsh.message')),
               h('span', { className: 'ph-kv-value ph-break' }, head.message || '—'),
             ) : null,
             head ? h('div', { className: 'ph-kv-row' },
               h('span', { className: 'ph-kv-key' }, t('dsh.committed')),
               h('span', { className: 'ph-kv-value' }, (whenText(t, head.date) || head.date || '') +
                 (head.author ? ' · ' + head.author : '')),
             ) : null,
             release ? h('div', { className: 'ph-kv-row' },
               h('span', { className: 'ph-kv-key' }, t('dsh.release')),
               h('span', { className: 'ph-kv-value' }, release.name),
             ) : null,
             release ? h('div', { className: 'ph-kv-row' },
               h('span', { className: 'ph-kv-key' }, t('dsh.tag')),
               h('span', { className: 'ph-kv-value ph-mono' }, release.tag),
             ) : null,
             release ? h('div', { className: 'ph-kv-row' },
               h('span', { className: 'ph-kv-key' }, t('dsh.published')),
               h('span', { className: 'ph-kv-value' }, whenText(t, release.publishedAt) || release.publishedAt || ''),
             ) : null,
             registrySource ? h('div', { className: 'ph-kv-row' },
               h('span', { className: 'ph-kv-key' }, t('dsh.source.label')),
               h('span', { className: 'ph-kv-value' }, t(releaseRoute === 'npm' ? 'dsh.source.npm' : 'dsh.source.npmmirror')),
             ) : null,
             upstreamFailed ? h('div', { className: 'ph-kv-row' },
               h('span', { className: 'ph-kv-key' }, t('dsh.diag.reason')),
               h('span', { className: 'ph-kv-value' }, upstreamReasonText(t, data.reason)),
             ) : null,
             headFailure || releaseFailure ? h('div', { className: 'ph-kv-row' },
               h('span', { className: 'ph-kv-key' }, t('dsh.diag.routes')),
               h('span', { className: 'ph-kv-value ph-mono' }, routesText),
             ) : null,
           ),
         )),
     )
   }

   defineCard({
     id: 'dsh',
     shipped: true,
     order: 60,
     title: function () { return runtime.t('card.dsh.title') },
     subtitle: function () { return runtime.t('card.dsh.subtitle') },
     icon: 'cube',
     size: { w: 1, h: 1 },
     minSize: { w: 1, h: 1 },
     maxSize: { w: 4, h: 3 },
     accent: '#4f46e5',
     texture: true,
     effects: { outline: 'outline', sheen: false, ripple: false, float: false },
     content: function (api) { return h(DshCard, { api: api, t: runtime.t }) },
     detail: function (api) { return h(DshDetail, { api: api, t: runtime.t }) },
     detailActions: [
       {
         id: 'refresh', type: 'combo', label: function () { return runtime.t('common.refresh') }, value: 'now',
         options: [
           { value: 'now', label: function () { return runtime.t('common.refresh') } },
           { value: 'force', label: function () { return runtime.t('dsh.force') } },
         ],
         run: function (choice) { requestReload('dsh', choice === 'force') },
       },
       // A stored setting, not a toolbar control: the root is edited in the
       // expanded body next to the list it points at. It is registered here
       // because that is what makes it persisted per card. Empty means
       // "auto-detect from the running core", which is the shipped default.
       { id: 'root', type: 'text', hidden: true, value: '' },
     ],
   })

   dict({
     zh: {
       'card.dsh.title': 'DSH 核心',
       'card.dsh.subtitle': '本地构建更新',
       'dsh.panel.title': '本地构建一键更新',
       'dsh.purpose': '官方仓库发布新版本后，一键克隆到本地并完成构建安装。',
       'dsh.scope.hint': '此卡片用于本地构建',
       'dsh.scope.packaged': '本机运行的是打包版本 {version}，不是本地构建；升级请使用它自己的更新入口。',
       'dsh.scope.unknown': '没有识别到本地构建。若你用源码构建 DSH，请在下面填写它的目录。',
       'dsh.note.local': '这会在上面的目录里创建一个新的本地构建，不会替换正在运行的版本。',
       'dsh.row.upstream': '上游最新',
       'dsh.row.local': '本机版本',
       'dsh.row.unreadable': '读不到',
       'dsh.row.unnamed': '未识别',
       'dsh.row.scanning': '读取中…',
       'dsh.row.localError': '读不到本机',
       'dsh.reason.network': '本机网络无法访问 GitHub',
       'dsh.reason.parse': 'GitHub 返回异常内容',
       'dsh.retry': '重试',
       'dsh.retryHint': '重新检查上游',
       'dsh.source.label': '版本来源',
       'dsh.source.npm': 'npm 官方源（可能滞后于 GitHub）',
       'dsh.source.npmmirror': 'npm 镜像源（可能更滞后）',
       'dsh.diag.reason': '原因',
       'dsh.diag.routes': '取数路由',
       'dsh.local.desktop': '桌面版',
       'dsh.loading': '正在读取上游…',
       'dsh.state.current': '已是最新',
       'dsh.state.commit': '上游有新提交',
       'dsh.state.release': '有新版本',
       'dsh.state.offline': '读不到上游',
       'dsh.state.none': '没有本地构建',
       'dsh.state.needRoot': '未识别本地构建目录',
       'dsh.state.scanning': '正在检查本机…',
       'dsh.state.runningUnknown': '未识别运行版本',
       'dsh.state.localError': '读不到本机核心',
       'dsh.state.packaged': '非本地构建',
       'dsh.state.unknownInstall': '未识别到本地构建',
       'dsh.runningChip': '当前运行',
       'dsh.checked': '检查于 {when}',
       'dsh.force': '强制检查',
       'dsh.section.builds': '本地构建',
       'dsh.more.show': '查看上游详情',
       'dsh.more.hide': '收起上游详情',
       'dsh.branch': '分支',
       'dsh.head': 'HEAD',
       'dsh.message': '提交信息',
       'dsh.committed': '提交时间',
       'dsh.release': '发布',
       'dsh.tag': '标签',
       'dsh.published': '发布时间',
       'dsh.root': '本地目录',
       'dsh.rootHint': '留空则自动识别正在运行的本地构建目录',
       'dsh.rootHint.packaged': '填写一个存放本地构建的目录',
       'dsh.needRoot': '没有识别到本地构建目录，请填写一个目录',
       'dsh.noInstalled': '这个目录下没有找到 DSH 本地构建',
       'dsh.synced': '已同步',
       'dsh.behind': '落后',
       'dsh.noCommit': '无提交',
       'dsh.notBuilt': '未构建',
       'dsh.install': '克隆并构建 {version}',
       'dsh.install.local': '在本地目录构建 {version}',
       'dsh.installing': '正在启动…',
       'dsh.noRelease': '没有可安装的版本',
       'dsh.started': '已在独立终端窗口开始安装 {version}',
       'dsh.reason.no-root': '先设置一个本地目录',
       'dsh.reason.no-version': '没有可安装的版本',
       'dsh.reason.bad-root': '这个目录不可用（需要绝对路径）',
       'dsh.reason.exists': '该版本已经在这个目录下了',
       'dsh.reason.no-git': '找不到 git',
       'dsh.reason.no-pnpm': '找不到 pnpm 或 corepack',
       'dsh.reason.busy': '这个版本的安装已经在进行中',
       'dsh.reason.generic': '无法开始安装：{reason}',
       'dsh.notice.unavailable': '读不到 DSH 上游：{reason}',
       'dsh.when.now': '刚刚',
       'dsh.when.minutes': '{count} 分钟前',
       'dsh.when.hours': '{count} 小时前',
       'dsh.when.days': '{count} 天前',
       'dsh.when.date': '{date}',
     },
     en: {
       'card.dsh.title': 'DSH core',
       'card.dsh.subtitle': 'local build updates',
       'dsh.panel.title': 'One-click local build updates',
       'dsh.purpose': 'When the upstream publishes a new release, clone it locally and build it in one click.',
       'dsh.scope.hint': 'this card is for local builds',
       'dsh.scope.packaged': 'This machine runs a packaged build {version}, not a local build; update it through its own updater.',
       'dsh.scope.unknown': 'No local build was identified. If you run DSH from a source checkout, set its directory below.',
       'dsh.note.local': 'This creates a new local build in the directory above; it does not replace the running version.',
       'dsh.row.upstream': 'upstream',
       'dsh.row.local': 'this machine',
       'dsh.row.unreadable': 'unreadable',
       'dsh.row.unnamed': 'not identified',
       'dsh.row.scanning': 'reading…',
       'dsh.row.localError': 'local unreadable',
       'dsh.reason.network': 'this network cannot reach GitHub',
       'dsh.reason.parse': 'GitHub returned an unexpected response',
       'dsh.retry': 'Retry',
       'dsh.retryHint': 'check the upstream again',
       'dsh.source.label': 'Version source',
       'dsh.source.npm': 'npm registry (can lag behind GitHub)',
       'dsh.source.npmmirror': 'npm mirror (can lag further)',
       'dsh.diag.reason': 'Reason',
       'dsh.diag.routes': 'Routes',
       'dsh.local.desktop': 'desktop',
       'dsh.loading': 'Reading the upstream…',
       'dsh.state.current': 'up to date',
       'dsh.state.commit': 'upstream moved',
       'dsh.state.release': 'new release',
       'dsh.state.offline': 'upstream unreachable',
       'dsh.state.none': 'no local build',
       'dsh.state.needRoot': 'local build directory not identified',
       'dsh.state.scanning': 'inspecting this machine…',
       'dsh.state.runningUnknown': 'running version unknown',
       'dsh.state.localError': 'local cores unreadable',
       'dsh.state.packaged': 'not a local build',
       'dsh.state.unknownInstall': 'local build not identified',
       'dsh.runningChip': 'running',
       'dsh.checked': 'checked {when}',
       'dsh.force': 'Check now',
       'dsh.section.builds': 'Local builds',
       'dsh.more.show': 'Show upstream details',
       'dsh.more.hide': 'Hide upstream details',
       'dsh.branch': 'Branch',
       'dsh.head': 'HEAD',
       'dsh.message': 'Message',
       'dsh.committed': 'Committed',
       'dsh.release': 'Release',
       'dsh.tag': 'Tag',
       'dsh.published': 'Published',
       'dsh.root': 'Local directory',
       'dsh.rootHint': 'auto-detected from the running local build when empty',
       'dsh.rootHint.packaged': 'a directory to keep the local builds in',
       'dsh.needRoot': 'No local build directory was identified — set the directory that holds your DSH builds',
       'dsh.noInstalled': 'No DSH local build was found in this directory',
       'dsh.synced': 'in sync',
       'dsh.behind': 'behind',
       'dsh.noCommit': 'no commit',
       'dsh.notBuilt': 'not built',
       'dsh.install': 'Clone and build {version}',
       'dsh.install.local': 'Build {version} in the local directory',
       'dsh.installing': 'starting…',
       'dsh.noRelease': 'no release to install',
       'dsh.started': 'Installing {version} in its own terminal window',
       'dsh.reason.no-root': 'set a local directory first',
       'dsh.reason.no-version': 'no version to install',
       'dsh.reason.bad-root': 'that directory is unusable (it must be absolute)',
       'dsh.reason.exists': 'that version is already in this directory',
       'dsh.reason.no-git': 'git was not found',
       'dsh.reason.no-pnpm': 'neither pnpm nor corepack was found',
       'dsh.reason.busy': 'that version is already being installed',
       'dsh.reason.generic': 'cannot start the install: {reason}',
       'dsh.notice.unavailable': 'Cannot read the DSH upstream: {reason}',
       'dsh.when.now': 'just now',
       'dsh.when.minutes': '{count} min ago',
       'dsh.when.hours': '{count} h ago',
       'dsh.when.days': '{count} d ago',
       'dsh.when.date': '{date}',
     },
   })
