/**
 * Card module: DSH — is there a new commit or a new release in the upstream
 * harness repository, and can this machine lay that version down beside the one
 * it is running right now?
 *
 * Spliced into the client factory by scripts/build-client.mjs, inside
 * `(function (kit) { ... })(Kit)`, so this file may assume `kit` is in scope.
 * It defines and registers itself — adding a card is adding this file.
 *
 * Two halves answer it. The host half (`lib/host/dsh.js`) reads the repository
 * feeds — a browser cannot, and the anonymous GitHub API quota is already
 * spent, so it uses the atom feeds with an `If-None-Match` on every poll. The
 * installer half (`lib/host/dsh-install.js`) turns "get me that version" into a
 * detached terminal window, because building a DSH core takes minutes and doing
 * that inside the process that is serving this page would stall the page.
 *
 * What counts as news is decided here, not upstream: the card remembers the
 * commit and the release it has already shown (in its own persisted controls)
 * and reports a difference from *that*. The first read of a fresh install is
 * the baseline, so a new card does not open shouting about a year of history.
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
    /**
     * The install root is not a constant. An empty control means "the directory
     * the running core was unpacked into", which the Host resolves from
     * `DSH_INSTALL_ROOT` or the core's own launch path; the card shows that
     * resolved path as the field's placeholder and never guesses one itself.
     */

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
     * What the card has to say. "Up to date" has to mean *this machine already
     * has the upstream commit*, not "this card has looked before": a timestamp
     * the card remembered says nothing about what is unpacked on disk, and it
     * reads as a lie the moment the card is mounted on a box that is behind.
     * The comparison is the core's own git state — its commit sha, and the
     * committer date that catches a shallow clone whose tags were never fetched.
     * @param data - the upstream document.
     * @param root - the install root the user configured.
     * @param local - the `dshLocal` remote (null while it has not answered).
     * @returns `{ level, text, local }` — level drives the tone.
     */
    function verdictOf(t, data, root, local) {
      var head = data && data.head
      var release = data && data.release
      if (!head && !release) return { level: 'unknown', text: t('dsh.state.unknown'), local: null }
      if (!root) return { level: 'unknown', text: t('dsh.state.needRoot'), local: null }
      if (local && local.error) return { level: 'unknown', text: t('dsh.state.unknown'), local: null }
      if (!local || !local.data) return { level: 'unknown', text: t('dsh.state.scanning'), local: null }
      var newest = localCores(local)[0] || null
      if (!newest) return { level: 'warn', text: t('dsh.state.none'), local: null }
      var newestAt = Date.parse(String(newest.commitDate || ''))
      var headAt = Date.parse(String((head && head.date) || ''))
      if (head && newest.sha && newest.sha === head.sha) {
        return { level: 'current', text: t('dsh.state.current'), local: newest }
      }
      if (release && newest.tag && newest.tag === release.tag) {
        return { level: 'current', text: t('dsh.state.current'), local: newest }
      }
      if (isFinite(newestAt) && isFinite(headAt) && newestAt >= headAt) {
        return { level: 'current', text: t('dsh.state.current'), local: newest }
      }
      var releaseAt = Date.parse(String((release && release.publishedAt) || ''))
      if (release && isFinite(releaseAt) && (!isFinite(newestAt) || releaseAt > newestAt)) {
        return { level: 'new', text: t('dsh.state.release', { name: release.name }), local: newest }
      }
      return { level: 'new', text: t('dsh.state.commit'), local: newest }
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
      var bits = []
      if (entry.sha) bits.push(shortSha(entry.sha))
      else if (entry.short) bits.push(shortSha(entry.short))
      if (entry.tag) bits.push(entry.tag)
      if (entry.branch) bits.push(entry.branch)
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

    // =============================================================== 6. dsh

    /**
     * The compact card: what upstream is at, and whether that is different from
     * what this card last showed. Two readings and one verdict — a version
     * number is the thing a user came for, and "the same as yesterday" is worth
     * exactly one word.
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
      // An upstream that reads fine is not news; only a failed read is. The
      // host half mounts lazily, so the first poll after a page load can lose
      // the race and answer 404 while every later poll is fine.
      useAnnounce(api, 'dsh',
        error && remote.failures > 1
          ? { level: 'error', text: t('dsh.notice.unavailable', { reason: error }) }
          : null)
      if (error) return h('div', null, h(UI.Chip, { tone: 'error' }, t('common.error')), h('p', { className: 'ph-inline-empty' }, error))
      if (!data) return h('div', { className: 'ph-hero ph-hero--wait' }, h('span', { className: 'ph-hero-value' }, '—'))
      var head = data.head
      var release = data.release
      var state = verdictOf(t, data, root, local)
      var newest = state.local
      return h('div', { className: 'ph-specs' },
        h('div', { className: 'ph-spec-list' },
          h('div', { className: 'ph-spec' },
            h('span', { className: 'ph-spec-name' }, t('dsh.row.head')),
            h('span', { className: 'ph-spec-value ph-mono' }, head ? shortSha(head.sha) : t('dsh.unknown')),
          ),
          h('div', { className: 'ph-spec' },
            h('span', { className: 'ph-spec-name' }, t('dsh.row.release')),
            h('span', { className: 'ph-spec-value' }, release ? release.name : t('dsh.unknown')),
          ),
          h('div', { className: 'ph-spec' },
            h('span', { className: 'ph-spec-name' }, t('dsh.row.local')),
            h('span', {
              className: 'ph-spec-value' + (newest ? ' ph-mono' : ''),
              title: newest ? String(newest.name || '') : undefined,
            }, newest ? coreLabel(newest) : t('dsh.local.none')),
          ),
        ),
        h('div', { className: 'ph-spec-foot' },
          h('button', {
            type: 'button',
            className: 'ph-link ph-dsh-state' + (state.level === 'new' ? ' is-new' : ''),
            title: t('dsh.expandHint'),
            onClick: function () { api.expand() },
          }, state.text),
          h('span', null, data.at ? t('dsh.checked', { when: whenText(t, new Date(data.at).toISOString()) }) : ''),
        ),
      )
    }

    /** The expanded page: the upstream reading, the install root, the local cores. */
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
      var state = verdictOf(t, data, root, local)
      var versions = localCores(local)
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
      return h('div', null,
        h('div', { className: 'ph-section-head' },
          h('h4', null, t('dsh.section.upstream')),
          h('span', { className: 'ph-head-spacer' }),
          h(UI.Chip, { tone: state.level === 'new' ? 'warn' : 'ok' }, state.text),
        ),
        h('div', { className: 'ph-kv' },
          h('div', { className: 'ph-kv-row' },
            h('span', { className: 'ph-kv-key' }, t('dsh.branch')),
            h('span', { className: 'ph-kv-value' }, data.branch || 'master'),
          ),
          h('div', { className: 'ph-kv-row' },
            h('span', { className: 'ph-kv-key' }, t('dsh.head')),
            h('span', { className: 'ph-kv-value ph-mono ph-break' }, head ? head.sha : t('dsh.unknown')),
          ),
          head ? h('div', { className: 'ph-kv-row' },
            h('span', { className: 'ph-kv-key' }, t('dsh.message')),
            h('span', { className: 'ph-kv-value ph-break' }, head.message || '—'),
          ) : null,
          head ? h('div', { className: 'ph-kv-row' },
            h('span', { className: 'ph-kv-key' }, t('dsh.committed')),
            h('span', { className: 'ph-kv-value' }, (whenText(t, head.date) || head.date || '') +
              (head.author ? ' · ' + head.author : '')),
          ) : null,
          h('div', { className: 'ph-kv-row' },
            h('span', { className: 'ph-kv-key' }, t('dsh.release')),
            h('span', { className: 'ph-kv-value' }, release ? release.name : t('dsh.unknown')),
          ),
          release ? h('div', { className: 'ph-kv-row' },
            h('span', { className: 'ph-kv-key' }, t('dsh.tag')),
            h('span', { className: 'ph-kv-value ph-mono' }, release.tag),
          ) : null,
          release ? h('div', { className: 'ph-kv-row' },
            h('span', { className: 'ph-kv-key' }, t('dsh.published')),
            h('span', { className: 'ph-kv-value' }, whenText(t, release.publishedAt) || release.publishedAt || ''),
          ) : null,
        ),

        h(UI.Divider, null),
        h('h4', { className: 'ph-section-title' }, t('dsh.section.local')),
        h(UI.Field, { label: t('dsh.root') },
          h(UI.Text, {
            value: storedRoot,
            placeholder: root !== '' ? root : t('dsh.rootHint'),
            mono: true,
            onChange: function (next) { api.setControl('root', next) },
          }),
        ),
        versions.length > 0
          ? h('div', { className: 'ph-tools' }, versions.map(function (entry) {
            var sync = syncState(t, entry, head, release)
            return h('div', { key: entry.dir || entry.name, className: 'ph-tool' },
              h('span', { className: 'ph-tool-name ph-mono' }, entry.name),
              h('span', { className: 'ph-tool-facts' }, coreFacts(t, entry)),
              h('span', { className: 'ph-tool-tags' },
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
              : (release ? t('dsh.install', { version: release.name }) : t('dsh.noRelease'))),
          ),
        ),
        job.done ? h('p', { className: 'ph-note ph-dsh-ok' },
          t('dsh.started', { version: job.done.version || (release ? release.name : '') })) : null,
        job.failed ? h('p', { className: 'ph-note ph-dsh-fail' }, reasonText(t, job.failed)) : null,
      )
    }

      defineCard({
        id: 'dsh',
        shipped: true,
        order: 60,
        title: function () { return runtime.t('card.dsh.title') },
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
        'dsh.row.head': '最新提交',
        'dsh.row.release': '最新版本',
        'dsh.row.local': '本机',
        'dsh.unknown': '读不到',
        'dsh.loading': '正在读取上游…',
        'dsh.state.current': '已是最新',
        'dsh.state.commit': '上游有新提交',
        'dsh.state.release': '有新版本 {name}',
        'dsh.state.none': '本机还没有核心',
        'dsh.state.needRoot': '未找到核心目录',
        'dsh.state.scanning': '正在检查本机…',
        'dsh.state.unknown': '读不到上游',
        'dsh.local.none': '无',
        'dsh.checked': '检查于 {when}',
        'dsh.expandHint': '展开查看与更新',
        'dsh.force': '强制检查',
        'dsh.section.upstream': '上游',
        'dsh.section.local': '本机版本',
        'dsh.branch': '分支',
        'dsh.head': 'HEAD',
        'dsh.message': '提交信息',
        'dsh.committed': '提交时间',
        'dsh.release': '发布',
        'dsh.tag': '标签',
        'dsh.published': '发布时间',
        'dsh.root': '本地目录',
        'dsh.rootHint': '留空则自动识别正在运行的核心目录',
        'dsh.needRoot': '没有找到核心目录，请手动填写一个本地目录',
        'dsh.noInstalled': '这个目录下没有找到 DSH 核心',
        'dsh.synced': '已同步',
        'dsh.behind': '落后',
        'dsh.noCommit': '无提交',
        'dsh.notBuilt': '未构建',
        'dsh.install': '更新到 {version}',
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
        'dsh.row.head': 'Latest commit',
        'dsh.row.release': 'Latest release',
        'dsh.row.local': 'Local',
        'dsh.unknown': 'unreadable',
        'dsh.loading': 'Reading the upstream…',
        'dsh.state.current': 'up to date',
        'dsh.state.commit': 'upstream moved',
        'dsh.state.release': 'new release {name}',
        'dsh.state.none': 'no local core yet',
        'dsh.state.needRoot': 'no core directory',
        'dsh.state.scanning': 'inspecting this machine…',
        'dsh.state.unknown': 'upstream unreadable',
        'dsh.local.none': 'none',
        'dsh.checked': 'checked {when}',
        'dsh.expandHint': 'expand to inspect and update',
        'dsh.force': 'Check now',
        'dsh.section.upstream': 'Upstream',
        'dsh.section.local': 'Local cores',
        'dsh.branch': 'Branch',
        'dsh.head': 'HEAD',
        'dsh.message': 'Message',
        'dsh.committed': 'Committed',
        'dsh.release': 'Release',
        'dsh.tag': 'Tag',
        'dsh.published': 'Published',
        'dsh.root': 'Local directory',
        'dsh.rootHint': 'auto-detected from the running core when empty',
        'dsh.needRoot': 'No core directory was found — set the directory that holds your DSH cores',
        'dsh.noInstalled': 'No DSH core was found in this directory',
        'dsh.synced': 'in sync',
        'dsh.behind': 'behind',
        'dsh.noCommit': 'no commit',
        'dsh.notBuilt': 'not built',
        'dsh.install': 'Update to {version}',
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
