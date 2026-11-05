/**
 * Plugin audit — review what a plugin would do before it is installed.
 *
 * The host owns every step: `pluginAuditStart` resolves the target, freezes the
 * source into a read-only snapshot and opens a review session, that session
 * answers through its own audit tool. No verdict installs itself: the user
 * confirms from the record, because the reviewed code is untrusted. The card
 * starts the run, follows the host while it is still working, announces the
 * verdict exactly once, and asks for the answer a `warn` verdict needs. An
 * `unsafe` verdict has no install path here on purpose: the host refuses one
 * without an explicit override, and this card draws no button that would send it.
 *
 * @module dsh-homepage/cards/plugin-audit
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

var START = 'homepage/pluginAuditStart'
var STATUS = 'homepage/pluginAuditStatus'
var LIST = 'homepage/pluginAuditList'
var DECIDE = 'homepage/pluginAuditDecide'

// The card is its own thing: it reviews a plugin the user names. It reads no
// marketplace and offers no browsing, so there is nothing here that a plugin
// market has to be installed for — the host resolves a name or a repository on
// its own, and a review that cannot reach the source says so in its findings.

// A review reports through its own session, so the host learns the verdict the
// moment the session does; asking again is what turns that into card state. The
// timer dies the moment the audit reaches a state the host will not leave on its
// own — and it also gives up after a minute of a host that never moves, so one
// wedged install cannot keep asking forever.
var POLL_MS = 1500
var POLL_LIMIT = 40
var LIVE = { running: true, installing: true }

var STATE_KEYS = {
  running: 'pluginAudit.state.running',
  safe: 'pluginAudit.state.safe',
  warn: 'pluginAudit.state.warn',
  unsafe: 'pluginAudit.state.unsafe',
  failed: 'pluginAudit.state.failed',
  declined: 'pluginAudit.state.declined',
  installing: 'pluginAudit.state.installing',
  installed: 'pluginAudit.state.installed',
}

// A chip says where the audit stands, so only a state that is a verdict takes a
// colour. A run in progress and the two states the user decided are neutral: the
// news is in the sentences beside the chip, not in the pill.
var STATE_TONES = { safe: 'ok', installed: 'ok', warn: 'warn', unsafe: 'error', failed: 'error' }

var STAGE_KEYS = {
  reading: 'pluginAudit.stage.reading',
  tool: 'pluginAudit.stage.tool',
  writing: 'pluginAudit.stage.writing',
  installing: 'pluginAudit.stage.installing',
  install: 'pluginAudit.stage.installing',
  'no-verdict': 'pluginAudit.stage.noVerdict',
  'session-failed': 'pluginAudit.stage.sessionFailed',
  'install-failed': 'pluginAudit.stage.installFailed',
}

var LEVEL_KEYS = {
  info: 'pluginAudit.level.info',
  warn: 'pluginAudit.level.warn',
  error: 'pluginAudit.level.error',
}

var LEVEL_TONES = { warn: 'warn', error: 'error' }

// The findings read worst first: an `error` is the reason to stop, a `warn` is the
// thing to weigh, an `info` is context. Sorting is what makes the top of the list
// the part that decides — the host sends them in the order the session thought of
// them, which is not an order a reader can rely on.
var LEVEL_ORDER = { error: 0, warn: 1, info: 2 }

// What an `error`/`warn` finding could turn into. The host fixes the vocabulary;
// the label is the card's, because "supply-chain" is the host's word for it and
// "供应链攻击" is the reader's.
var SCENARIO_KEYS = {
  'supply-chain': 'pluginAudit.scenario.supplyChain',
  'privilege-escalation': 'pluginAudit.scenario.privilegeEscalation',
  'sandbox-escape': 'pluginAudit.scenario.sandboxEscape',
  'data-leak': 'pluginAudit.scenario.dataLeak',
  'unsafe-publish': 'pluginAudit.scenario.unsafePublish',
  other: 'pluginAudit.scenario.other',
}

// The one control every acting surface shares. The wall's preview and the expanded
// body each hold their own status read, and a verdict the user can act on (`warn`,
// `unsafe`) is exactly the state the poll timer stops on — so a decision made in
// one of them would leave the other drawing buttons for something already done.
// Every place that decides therefore writes the same control value, and the read
// that sees it change asks the host again.
var SIGNAL = 'auditSignal'

// `kit.ICONS` has no security mark, and a card's watermark is its own icon, so
// this card brings one: the same 24 grid, the same 1.8 stroke and `currentColor`
// as the framework's own set. Registering it here keeps the framework untouched
// and still gives the texture a real glyph instead of a stray letter.
ICONS.shield = function (size) {
  return h('svg', {
    viewBox: '0 0 24 24',
    width: size || 16,
    height: size || 16,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
  },
  h('path', { d: 'M12 3.2 18.8 6v5.6c0 4.2-2.8 7.4-6.8 8.7-4-1.3-6.8-4.5-6.8-8.7V6L12 3.2Z' }),
  h('path', { d: 'm9.1 12.1 2.1 2.1 4-4.4' }))
}

/**
 * @returns the label for an audit state. An unknown state is shown as the host
 * sent it rather than swallowed: a state this card does not know yet is still
 * more useful than an empty pill.
 */
function stateText(t, state) {
  if (STATE_KEYS[state]) return t(STATE_KEYS[state])
  return state ? String(state) : t('pluginAudit.state.none')
}

/** @returns the label for a finding level. */
function levelText(t, level) {
  return LEVEL_KEYS[level] ? t(LEVEL_KEYS[level]) : String(level || '')
}

/** @returns whatever the host said about the declared DSH version range, in one
 * cell. `compatible` is `true`, `false` or `null`, and the three read differently
 * on purpose: a host that could not read its own version must not look like a
 * pass, and an incompatible range has to say which range it was. */
function compatText(t, compatibility) {
  var info = compatibility && typeof compatibility === 'object' ? compatibility : null
  if (!info || info.compatible === null || info.compatible === undefined) return t('pluginAudit.compat.unknown')
  if (info.compatible === false) {
    return t('pluginAudit.compat.bad', {
      runtime: String(info.runtime || t('pluginAudit.value.none')),
      required: String(info.required || t('pluginAudit.value.none')),
    })
  }
  return t('pluginAudit.compat.ok', { runtime: String(info.runtime || t('pluginAudit.value.none')) })
}

/** @returns a compact provenance line for the immutable source snapshot. */
function sourceText(t, source) {
  if (!source || typeof source !== 'object') return t('pluginAudit.value.none')
  var sha = String(source.artifactSha256 || '').slice(0, 12)
  var parts = [String(source.kind || '')]
  if (source.ref) parts.push(String(source.ref))
  parts.push(String(source.fileCount || 0) + ' files')
  if (sha) parts.push('sha256 ' + sha)
  if (source.truncated) parts.push(t('pluginAudit.source.truncated'))
  if (source.pinned !== true) parts.push(t('pluginAudit.source.unpinned'))
  return parts.filter(Boolean).join(' · ')
}

/**
 * What the audit is doing right now. The stage is the running detail; once the
 * state is a decision, the state itself is the answer and a stale stage would
 * only be noise.
 */
function progressText(t, audit) {
  var stage = STAGE_KEYS[audit.stage] ? t(STAGE_KEYS[audit.stage]) : null
  if (audit.state === 'running' || audit.state === 'installing') return stage || stateText(t, audit.state)
  if (audit.state === 'failed' && stage) return stage
  return stateText(t, audit.state)
}

/** @returns what to call the plugin under review. */
function auditName(audit, t) {
  var plugin = (audit && audit.plugin) || {}
  return plugin.name || plugin.input || t('pluginAudit.unnamed')
}

/**
 * @returns where the repository link goes, or null when the host named no
 * repository. `owner/repo` is the documented shorthand, a full URL is used
 * as it came.
 */
function repoHref(audit) {
  var repo = audit && audit.plugin && audit.plugin.repo
  if (!repo) return null
  var value = String(repo)
  if (/^https?:\/\//.test(value)) return value
  return value.indexOf('/') > 0 ? 'https://github.com/' + value : null
}

/**
 * @returns the workspace service this profile offers, or null. The sidebar is
 * not guaranteed to exist in every client, so the button that opens a review
 * session asks for the service before it renders as clickable.
 */
function sessionService() {
  var services = kit.sidebarServices
  var ui = services && services.uiWorkspace
  return ui && typeof ui.openSession === 'function' ? ui : null
}

/**
 * The card's one line of news. A verdict is the reason the card exists, so it
 * announces once — `useAnnounce` fires on a changed level and text, not on every
 * poll — and takes the notice back whenever there is nothing to say.
 * @returns `{ level, text }`, or null.
 */
function auditNotice(audit, t) {
  if (!audit) return null
  var plugin = auditName(audit, t)
  switch (audit.state) {
    case 'warn':
      if (audit.source && audit.source.pinned !== true) {
        return { level: 'warn', text: t('pluginAudit.notice.unpinned', { plugin: plugin }) }
      }
      return { level: 'warn', text: t('pluginAudit.notice.warn', { plugin: plugin }) }
    case 'unsafe':
      return { level: 'error', text: t('pluginAudit.notice.unsafe', { plugin: plugin }) }
    case 'failed':
      return { level: 'error', text: audit.detail || t('pluginAudit.notice.failed', { plugin: plugin }) }
    case 'safe':
      if (audit.source && audit.source.pinned !== true) {
        return { level: 'info', text: t('pluginAudit.notice.unpinned', { plugin: plugin }) }
      }
      return { level: 'info', text: t('pluginAudit.notice.safe', { plugin: plugin }) }
    case 'installing':
      return { level: 'info', text: t('pluginAudit.notice.installing', { plugin: plugin }) }
    case 'installed':
      return { level: 'info', text: t('pluginAudit.notice.installed', { plugin: plugin }) }
    case 'declined':
      return { level: 'info', text: t('pluginAudit.notice.declined', { plugin: plugin }) }
    default:
      return null
  }
}

/**
 * The audit on show, and the one poll timer the card runs.
 *
 * An audit lives inside the host process, so the id the card remembers is only
 * trusted while the host still lists it: a list that no longer names it is what
 * retires it. An empty id asks the host for the newest audit, which is how a
 * reload re-attaches to a review that is still going. A list that failed to load
 * leaves the remembered id alone, because an endpoint that cannot answer yet
 * must not silently drop the user's choice.
 */
function useAudit(api) {
  var list = useRemote(LIST, {}, { refreshMs: 0 })
  var stored = String(api.control('auditId') || '')
  var audits = list.data && Array.isArray(list.data.audits) ? list.data.audits : null
  var id = stored
  if (audits && stored) {
    var known = audits.some(function (entry) { return entry && entry.auditId === stored })
    if (!known) id = ''
  }
  var status = useRemote(STATUS, { options: { auditId: id } }, { refreshMs: 0 })
  var audit = status.data || null
  var live = status.at > 0 && !!(audit && LIVE[audit.state])
  var reload = status.reload
  var reloadList = list.reload
  // A decision made anywhere in the card (here, in the expanded body, on a history
  // row) publishes the shared signal, and both reads answer it: see SIGNAL.
  var signal = String(api.control(SIGNAL) || '')
  var seen = React.useRef(signal)
  React.useEffect(function () {
    if (signal === '' || signal === seen.current) return
    seen.current = signal
    void reload(true)
    void reloadList(true)
  }, [signal, reload, reloadList])
  var stall = React.useState(false)
  var stalled = stall[0]
  var setStalled = stall[1]
  React.useEffect(function () {
    if (!live) {
      setStalled(false)
      return undefined
    }
    var ticks = 0
    var timer = setInterval(function () {
      ticks += 1
      if (ticks > POLL_LIMIT) {
        clearInterval(timer)
        setStalled(true)
        return
      }
      void reload(true)
    }, POLL_MS)
    return function () { clearInterval(timer) }
  }, [live, reload, setStalled])
  return {
    audits: audits,
    audit: audit,
    busy: Boolean(status.busy && status.at === 0),
    error: status.error,
    live: live,
    stalled: stalled,
    reload: reload,
    reloadList: reloadList,
  }
}

/**
 * Tell the card, in every place it is drawn, that an audit changed. Writing the
 * control bumps the framework's store, so both instances re-render, and each one's
 * `useAudit` asks the host again — which is how the wall stops offering to install
 * something the expanded body just installed. The value is a string because that is
 * what a control holds across a page reload; the id is only there to make the two
 * writes of the same id distinguishable.
 */
function signalDecision(api, id) {
  if (!api || typeof api.setControl !== 'function') return
  api.setControl(SIGNAL, String(id || '') + '@' + String(Date.now()))
}

/**
 * Starting a review. The host resolves the target and opens the session before
 * it answers, so the answer already carries the audit the card should follow;
 * the id is remembered in the card's own control and the status read is asked
 * again, which is what makes the preview and the expanded body agree on which
 * audit is on show.
 */
function useStarter(api, view) {
  var state = React.useState('')
  var busy = state[0]
  var setBusy = state[1]
  var fail = React.useState('')
  var error = fail[0]
  var setError = fail[1]
  function start(target) {
    if (busy) return
    var wanted = String(target || '').trim()
    if (!wanted) return
    setError('')
    setBusy('start')
    var options = { target: wanted }
    var prompt = String(api.control('auditPrompt') || '')
    if (prompt) options.prompt = prompt
    var model = String(api.control('auditModel') || '')
    if (model) {
      try {
        var pair = JSON.parse(model)
        options.selection = { provider: pair[0], model: pair[1] }
      } catch (reason) { setBusy(''); setError(String(reason)); return }
    }
    var effort = String(api.control('auditEffort') || '')
    if (effort) options.selection = Object.assign({}, options.selection || {}, { reasoningEffort: effort })
    api.remote(START, { options: options })
      .then(function (next) {
        setBusy('')
        if (next && next.auditId) api.setControl('auditId', String(next.auditId))
        // The new audit belongs in the history the moment it exists, not when the
        // user happens to open that pane — and the other instance has to hear that
        // a review started, too.
        signalDecision(api, next && next.auditId)
        view.reload(true)
        if (typeof view.reloadList === 'function') view.reloadList(true)
      })
      .catch(function (reason) {
        setBusy('')
        setError(String((reason && reason.message) || reason))
      })
  }
  return { busy: Boolean(busy), error: error, start: start }
}

/**
 * The one control the card draws itself: what to review, and the button that
 * starts the review. The framework's action bar only takes a static `disabled`,
 * so a button whose state follows what has been typed has to be drawn here. The
 * field is controlled by the body around it, so the wall's preview and the
 * expanded card share one draft.
 */
function TargetRow(props) {
  var t = props.t
  var busy = props.busy === true
  var onStart = props.onStart
  var draft = props.draft
  var setDraft = props.setDraft
  function submit() {
    var wanted = String(draft || '').trim()
    if (!wanted || busy) return
    onStart(wanted)
    setDraft('')
  }
  return h('div', { className: 'ph-loose' },
    h('div', { className: 'ph-loose-row' },
      h('input', {
        className: 'ph-input',
        type: 'text',
        value: draft,
        placeholder: t('pluginAudit.target.placeholder'),
        'aria-label': t('pluginAudit.target'),
        onChange: function (event) { setDraft(String((event.target && event.target.value) || '')) },
        onKeyDown: function (event) { if (event.key === 'Enter') submit() },
      }),
      h(UI.Button, {
        disabled: busy || String(draft || '').trim() === '',
        onClick: submit,
      }, t('pluginAudit.action.start'))))
}

/** A timestamp as the short local shape the history rows use. */
function timeText(value) {
  var at = Number(value) || 0
  if (at <= 0) return ''
  var date = new Date(at)
  function two(number) { return (number < 10 ? '0' : '') + number }
  return two(date.getMonth() + 1) + '-' + two(date.getDate()) + ' ' +
    two(date.getHours()) + ':' + two(date.getMinutes())
}

/**
 * Whether a record can still be installed from. The source must be pinned to an
 * immutable version (an exact npm version with a digest, or a GitHub commit):
 * otherwise the install would fetch code nobody reviewed. `warn` is the
 * confirmation the warning asked for, and a `safe` verdict is installed only
 * from this button as well. An `unsafe` verdict is never installable.
 */
function canInstall(audit) {
  if (!audit) return false
  if (!audit.source || audit.source.pinned !== true) return false
  if (audit.state === 'warn') return true
  return audit.state === 'safe'
}

/** Whether the record still offers a way to turn the install down. */
function canDecline(audit) {
  return !!audit && (audit.state === 'warn' || audit.state === 'unsafe')
}

/**
 * The buttons a verdict needs. `warn` is the verdict the card may install from
 * after asking; a `safe` verdict is installed only from this button as well. An
 * `unsafe` verdict keeps only the decline, which is the safe answer — never an
 * override.
 */
function VerdictActions(props) {
  var api = props.api
  var t = props.t
  var audit = props.audit
  var view = props.view
  var state = React.useState('')
  var pending = state[0]
  var setPending = state[1]
  var fail = React.useState('')
  var error = fail[0]
  var setError = fail[1]
  var install = canInstall(audit)
  var decline = canDecline(audit)
  if (!install && !decline) return null
  function decide(decision) {
    if (pending) return
    setError('')
    setPending(decision)
    api.remote(DECIDE, { options: { auditId: audit.auditId, decision: decision } })
      .then(function () {
        setPending('')
        signalDecision(api, audit.auditId)
        view.reload(true)
        if (typeof view.reloadList === 'function') view.reloadList(true)
      })
      .catch(function (reason) {
        setPending('')
        setError(String((reason && reason.message) || reason))
      })
  }
  var label = audit && audit.state === 'safe' ? 'pluginAudit.action.installNow' : 'pluginAudit.action.install'
  return h('div', { className: 'ph-loose' },
    h('div', { className: 'ph-loose-row' },
      install
        ? h(UI.Button, {
            tone: 'primary',
            disabled: Boolean(pending),
            onClick: function () { decide('install') },
          }, t(pending === 'install' ? 'pluginAudit.action.installing' : label))
        : null,
      decline
        ? h(UI.Button, {
            disabled: Boolean(pending),
            onClick: function () { decide('decline') },
          }, t(pending === 'decline' ? 'pluginAudit.action.declining' : 'pluginAudit.action.decline'))
        : null),
    pending ? h('span', { className: 'ph-note' }, t('pluginAudit.pending')) : null,
    error ? h('span', { className: 'ph-groups-error' }, error) : null)
}

/**
 * The way into the review session. The button is only clickable when the client
 * has the service and the audit names a session; when it does not, the row says
 * which of the two is missing instead of quietly doing nothing.
 */
function SessionRow(props) {
  var t = props.t
  var audit = props.audit
  var service = sessionService()
  var session = audit && audit.session
  var canOpen = Boolean(service && session && session.id)
  return h('div', { className: 'ph-loose' },
    h('div', { className: 'ph-loose-row' },
      h(UI.Button, {
        disabled: !canOpen,
        title: canOpen ? String(session.title || session.id) : null,
        onClick: function () { if (canOpen) service.openSession(String(session.id)) },
      }, t('pluginAudit.action.openSession'))),
    session && session.title
      ? h('span', { className: 'ph-loose-name', title: String(session.title) }, String(session.title))
      : null,
    canOpen
      ? null
      : h('span', { className: 'ph-note' }, t(service ? 'pluginAudit.session.none' : 'pluginAudit.session.unavailable')))
}

/** @returns the reader-facing label for the situation a finding belongs to. */
function scenarioText(t, value) {
  var key = SCENARIO_KEYS[String(value || '')]
  return key ? t(key) : ''
}

/** @returns the findings worst first, keeping the session's order within a level. */
function sortFindings(list) {
  return list.slice().sort(function (left, right) {
    var a = LEVEL_ORDER[(left && left.level) || 'info']
    var b = LEVEL_ORDER[(right && right.level) || 'info']
    return (a === undefined ? 3 : a) - (b === undefined ? 3 : b)
  })
}

/**
 * One finding, folded to a header the reader can open.
 *
 * An `error` and a `warn` open on their own — that is the part the decision hangs
 * on — while an `info` stays folded, so the context never pushes the warnings off
 * the card. The body is where the type gets larger and the colour stronger, and a
 * `warn` carries the four answers the user has to weigh: what the code does, why
 * the plugin has it, what it could cost, and which situation it belongs to.
 */
function FindingRow(props) {
  var t = props.t
  var finding = props.finding && typeof props.finding === 'object' ? props.finding : {}
  var level = LEVEL_KEYS[finding.level] ? String(finding.level) : 'info'
  var title = String(finding.title || '')
  var detail = String(finding.detail || '')
  var risk = finding.risk && typeof finding.risk === 'object' ? finding.risk : null
  var state = React.useState(level !== 'info')
  var open = state[0]
  var setOpen = state[1]
  var scenario = risk ? scenarioText(t, risk.scenario) : ''
  function line(key, value) {
    if (!value) return null
    return h('p', { className: 'ph-audit-risk-row' },
      h('span', { className: 'ph-audit-risk-key' }, t(key)),
      h('span', { className: 'ph-audit-risk-value' }, String(value)))
  }
  return h('div', { className: 'ph-audit-finding' },
    h('button', {
      type: 'button',
      className: 'ph-audit-finding-head',
      'aria-expanded': open ? 'true' : 'false',
      onClick: function () { setOpen(!open) },
    },
      h(UI.Chip, { tone: LEVEL_TONES[level] || null }, levelText(t, level)),
      h('span', { className: 'ph-audit-finding-title' }, title),
      scenario ? h('span', { className: 'ph-audit-finding-tag' }, scenario) : null,
      h('span', { className: 'ph-audit-finding-more' }, t(open ? 'pluginAudit.finding.collapse' : 'pluginAudit.finding.expand'))),
    h('div', { className: 'ph-audit-reveal', hidden: !open },
      h('div', { className: 'ph-audit-reveal-inner' },
        h('div', { className: 'ph-audit-finding-body' },
          detail ? h('p', { className: 'ph-audit-finding-detail' }, detail) : null,
          risk
            ? h('div', { className: 'ph-audit-risk' },
                line('pluginAudit.risk.role', risk.role),
                line('pluginAudit.risk.why', risk.why),
                line('pluginAudit.risk.impact', risk.impact),
                line('pluginAudit.risk.scenario', scenario))
            : (level === 'warn' ? h('p', { className: 'ph-audit-risk-missing' }, t('pluginAudit.risk.missing')) : null),
          finding.ref
            ? h('p', { className: 'ph-audit-finding-ref' }, t('pluginAudit.finding.ref', { ref: String(finding.ref) }))
            : null))))
}

/** The wall reading: where the review is, or an honest empty state. */
function AuditPreview(props) {
  var api = props.api
  var t = props.t
  var view = useAudit(api)
  useAnnounce(api, 'pluginAudit', auditNotice(view.audit, t))
  var starter = useStarter(api, view)
  var field = React.useState('')
  var audit = view.audit
  if (!audit) {
    return h('div', { className: 'ph-loose' },
      h('span', { className: view.error ? 'ph-groups-error' : 'ph-inline-empty' },
        view.error ? t('pluginAudit.error.status') : (view.busy ? t('pluginAudit.loading') : t('pluginAudit.idle'))),
      h(TargetRow, {
        t: t, busy: starter.busy, onStart: starter.start, draft: field[0], setDraft: field[1],
      }),
      starter.error ? h('span', { className: 'ph-groups-error' }, starter.error) : null)
  }
  var line = audit.detail || progressText(t, audit)
  return h('div', { className: 'ph-loose' },
    h('div', { className: 'ph-loose-row' },
      h(UI.Chip, { tone: STATE_TONES[audit.state] || null, title: audit.summary || null }, stateText(t, audit.state)),
      h('span', { className: 'ph-loose-name', title: auditName(audit, t) }, auditName(audit, t))),
    h('p', { className: 'ph-note', title: line }, line),
    view.stalled ? h('span', { className: 'ph-groups-error' }, t('pluginAudit.stalled')) : null,
    canInstall(audit) || canDecline(audit) ? h(VerdictActions, { api: api, t: t, audit: audit, view: view }) : null)
}

/**
 * Every review the host still holds, newest first. A row says what was reviewed and
 * how it ended, and a record that can still be acted on carries its own buttons —
 * so a batch of review-only audits is worked through here without opening each one.
 */
function HistoryList(props) {
  var t = props.t
  var audits = Array.isArray(props.audits) ? props.audits : []
  if (audits.length === 0) return h('p', { className: 'ph-note' }, t('pluginAudit.history.empty'))
  return h('div', { className: 'ph-loose' }, audits.map(function (audit) {
    var id = String((audit && audit.auditId) || '')
    var install = canInstall(audit)
    var decline = canDecline(audit)
    return h('div', { className: 'ph-loose', key: 'h-' + id },
      h('div', { className: 'ph-loose-row' },
        h(UI.Chip, { tone: STATE_TONES[audit.state] || null, title: audit.summary || null }, stateText(t, audit.state)),
        h('span', { className: 'ph-loose-name', title: auditName(audit, t) }, auditName(audit, t)),
        h('span', { className: 'ph-note' }, timeText(audit.updatedAt || audit.startedAt))),
      h('p', { className: 'ph-note', title: audit.summary || '' },
        audit.summary ? String(audit.summary) : progressText(t, audit)),
      h('div', { className: 'ph-loose-row' },
        h(UI.Button, {
          disabled: props.chosen === id,
          onClick: function () { props.onOpen(id) },
        }, t('pluginAudit.history.view')),
        install
          ? h(UI.Button, {
              tone: 'primary',
              disabled: Boolean(props.pending),
              onClick: function () { props.onDecide(id, 'install') },
            }, t('pluginAudit.action.installNow'))
          : null,
        decline
          ? h(UI.Button, {
              disabled: Boolean(props.pending),
              onClick: function () { props.onDecide(id, 'decline') },
            }, t('pluginAudit.action.decline'))
          : null))
  }))
}

/**
 * The expanded body: a navigation bar over two panes. The left pane starts a review
 * and shows the audit on show; the right one lists every review the host still holds,
 * including the ones from earlier runs of DSH. Opening a row brings it into the left
 * pane, and a record that can still act (a warning, or a clean review-only audit)
 * installs from its own row — which is how somebody asks for several reviews at once
 * and decides afterwards.
 */
var defaultInstructions = /* @audit-instructions */ ''

function AuditModelPicker(props) {
  var api = props.api
  var t = props.t
  var catalog = props.catalog
  var data = catalog.data || {}
  var models = Array.isArray(data.models) ? data.models : []
  var chosen = String(api.control('auditModel') || '')
  var effort = String(api.control('auditEffort') || '')
  var defaults = data.defaultSelection || {}
  var defaultKey = defaults.provider && defaults.model ? JSON.stringify([defaults.provider, defaults.model]) : ''
  var selected = models.filter(function (item) { return JSON.stringify([item.provider, item.model]) === (chosen || defaultKey) })[0]
  var efforts = selected && Array.isArray(selected.efforts) ? selected.efforts : []
  function catalogLabel(value, fallback) {
    if (typeof value === 'string') return value
    return value && typeof value === 'object' ? (value[t('pluginAudit.catalogLanguage')] || value.en || value.zh || fallback) : fallback
  }
  return h('div', { className: 'ph-audit-models' },
    h('label', { className: 'ph-audit-model-field' }, h('span', null, t('pluginAudit.model')),
      h('select', { className: 'ph-input ph-audit-model-select', value: chosen, disabled: props.busy || !models.length,
        onChange: function (event) { api.setControl('auditModel', event.target.value); api.setControl('auditEffort', '') },
      }, h('option', { value: '' }, t('pluginAudit.model.default')),
      chosen && !selected ? h('option', { value: chosen }, t('pluginAudit.model.unavailable')) : null,
      models.map(function (item) {
        var key = JSON.stringify([item.provider, item.model])
        return h('option', { key: key, value: key }, catalogLabel(item.name, item.model) + ' · ' + item.provider)
      }))),
    h('label', { className: 'ph-audit-model-field' }, h('span', null, t('pluginAudit.effort')),
      h('select', { className: 'ph-input ph-audit-effort-select', value: effort, disabled: props.busy || !efforts.length,
        onChange: function (event) {
          if (!chosen && event.target.value && defaultKey) api.setControl('auditModel', defaultKey)
          api.setControl('auditEffort', event.target.value)
        },
      }, h('option', { value: '' }, t(efforts.length ? 'pluginAudit.effort.default' : 'pluginAudit.effort.none')),
      efforts.map(function (item) { return h('option', { key: item.id, value: item.id }, catalogLabel(item.name, item.id)) }))),
    catalog.error ? h('span', { className: 'ph-groups-error' }, t('pluginAudit.model.error')) : null)
}

function PromptEditor(props) {
  var api = props.api
  var t = props.t
  var saved = String(api.control('auditPrompt') || '')
  var state = React.useState(saved || defaultInstructions)
  var draft = state[0]
  var setDraft = state[1]
  var dirty = draft !== (saved || defaultInstructions)
  var expanded = React.useState(false)
  var open = expanded[0]
  return h('section', { className: 'ph-audit-launch' },
    h('div', { className: 'ph-audit-launch-head' },
      h('div', { className: 'ph-audit-launch-heading' },
        h('span', { className: 'ph-audit-launch-icon', 'aria-hidden': true }, '↗'),
        h('div', null,
          h('h3', { className: 'ph-audit-launch-title' }, t('pluginAudit.section.target')))),
      h('button', {
        type: 'button', className: 'ph-audit-prompt-trigger', 'aria-expanded': open,
        title: t('pluginAudit.prompt.hint'), onClick: function () { expanded[1](!open) },
      }, h('span', { 'aria-hidden': true }, '✎'), t('pluginAudit.prompt.edit'),
        h('span', { className: 'ph-audit-prompt-badge' }, t(saved ? 'pluginAudit.prompt.custom' : 'pluginAudit.prompt.default')))),
    props.children,
    h(AuditModelPicker, { api: api, t: t, busy: props.busy, catalog: props.catalog }),
    h('div', { className: 'ph-audit-settings ph-audit-reveal', hidden: !open },
      h('div', { className: 'ph-audit-reveal-inner ph-loose' },
      h('div', { className: 'ph-audit-editor-head' },
        h('strong', null, t('pluginAudit.prompt.title')),
        h('span', { className: 'ph-note' }, String(draft.length) + ' / 20000')),
      h('p', { className: 'ph-note' }, t('pluginAudit.prompt.hint')),
      h('textarea', {
        className: 'ph-input ph-audit-prompt', value: draft, maxLength: 20000,
        'aria-label': t('pluginAudit.prompt.title'),
        onChange: function (event) { setDraft(event.target.value) },
      }),
      h('div', { className: 'ph-audit-editor-footer' },
        h('span', { className: 'ph-note', role: 'status' }, t(dirty ? 'pluginAudit.prompt.unsaved' : 'pluginAudit.prompt.ready')),
        h(UI.Button, { tone: 'primary', disabled: !dirty, onClick: function () {
          var value = draft.trim() ? draft : defaultInstructions
          api.setControl('auditPrompt', value === defaultInstructions ? '' : value)
          setDraft(value)
        } }, t('pluginAudit.prompt.save')),
        h(UI.Button, { disabled: !saved && draft === defaultInstructions, onClick: function () {
          api.setControl('auditPrompt', '')
          setDraft(defaultInstructions)
        } }, t('pluginAudit.prompt.reset'))))))
}

function AuditDetail(props) {
  var api = props.api
  var t = props.t
  var view = useAudit(api)
  useAnnounce(api, 'pluginAudit', auditNotice(view.audit, t))
  var starter = useStarter(api, view)
  // Keep the catalog above the tab panes: returning to Current must not
  // rediscover every provider or briefly disable the model selectors.
  var modelCatalog = useRemote('homepage/pluginAuditModels', { options: {} }, { refreshMs: 0 })
  var tab = React.useState('current')
  var pane = tab[0]
  var setPane = tab[1]
  var busy = React.useState('')
  var pendingRow = busy[0]
  var setPendingRow = busy[1]
  var fail = React.useState('')
  var rowError = fail[0]
  var setRowError = fail[1]
  var audit = view.audit
  var findings = audit && Array.isArray(audit.findings) ? audit.findings : []
  var href = repoHref(audit)
  var plugin = (audit && audit.plugin) || {}
  var field = React.useState('')
  var draft = field[0]
  var setDraft = field[1]
  // The list is a snapshot while the audit on show is the live one, so the row for it
  // is painted from the status read: the two panes must not disagree about one audit.
  var listed = Array.isArray(view.audits) ? view.audits : []
  var history = listed.map(function (entry) {
    return audit && entry && entry.auditId === audit.auditId ? audit : entry
  })
  function changePane(next) {
    if (next === pane) return
    // Update immediately; the pane's local CSS animation needs no page snapshot
    // or animation-frame handshake before React can commit the selected tab.
    setPane(next)
  }
  function openRecord(id) {
    api.setControl('auditId', id)
    changePane('current')
  }
  function decideFromRow(id, decision) {
    if (pendingRow) return
    setRowError('')
    setPendingRow(id + ':' + decision)
    api.remote(DECIDE, { options: { auditId: id, decision: decision } })
      .then(function () {
        setPendingRow('')
        signalDecision(api, id)
        view.reload(true)
        if (typeof view.reloadList === 'function') view.reloadList(true)
      })
      .catch(function (reason) {
        setPendingRow('')
        setRowError(String((reason && reason.message) || reason))
      })
  }
  return h('div', { className: 'ph-detail-block ph-audit-detail' },
    h(UI.Segmented, {
      options: [
        { value: 'current', label: t('pluginAudit.tab.current') },
        { value: 'history', label: t('pluginAudit.tab.history') },
      ],
      value: pane,
      onChange: function (next) {
        var wanted = next === 'history' ? 'history' : 'current'
        // Opening the history asks the host for it: the records are the host's, and
        // a review started while this card was closed has to be in the list.
        if (wanted === 'history' && typeof view.reloadList === 'function') view.reloadList(true)
        changePane(wanted)
      },
    }),
    pane === 'history'
      ? h('div', { className: 'ph-loose ph-audit-pane', key: 'history' },
          h('div', { className: 'ph-section-head' },
            h('h4', { className: 'ph-section-title' }, t('pluginAudit.section.history'))),
          h(HistoryList, {
            t: t,
            audits: history,
            chosen: audit ? String(audit.auditId || '') : '',
            pending: pendingRow,
            onOpen: openRecord,
            onDecide: decideFromRow,
          }),
          rowError ? h('span', { className: 'ph-groups-error' }, rowError) : null)
      : h('div', { className: 'ph-loose ph-audit-pane', key: 'current' },
          h(PromptEditor, { api: api, t: t, busy: starter.busy, catalog: modelCatalog },
            h(TargetRow, {
              t: t, busy: starter.busy, onStart: starter.start, draft: draft, setDraft: setDraft,
            })),
          starter.error ? h('span', { className: 'ph-groups-error' }, starter.error) : null,
          view.error ? h('span', { className: 'ph-groups-error' }, String(view.error)) : null,
          audit
            ? h('div', { className: 'ph-audit-result' },
                h('div', { className: 'ph-audit-result-head' },
                  h(UI.Chip, { tone: STATE_TONES[audit.state] || null }, stateText(t, audit.state)),
                  h('strong', { className: 'ph-audit-name' }, auditName(audit, t)),
                  plugin.version ? h('span', { className: 'ph-note' }, String(plugin.version)) : null),
                h('p', { className: 'ph-audit-summary' }, audit.summary || progressText(t, audit)),
                (canInstall(audit) || canDecline(audit)) ? h('div', { className: 'ph-audit-result-actions' },
                  h(VerdictActions, { api: api, t: t, audit: audit, view: view })) : null,
                h('details', { className: 'ph-audit-metadata' },
                  h('summary', null, t('pluginAudit.metadata')),
                  h('div', { className: 'ph-kv' },
                h('div', { className: 'ph-kv-row' },
                  h('span', { className: 'ph-kv-key' }, t('pluginAudit.kv.plugin')),
                  h('span', { className: 'ph-kv-value' }, auditName(audit, t))),
                h('div', { className: 'ph-kv-row' },
                  h('span', { className: 'ph-kv-key' }, t('pluginAudit.kv.version')),
                  h('span', { className: 'ph-kv-value' }, String(plugin.version || t('pluginAudit.value.none')))),
                h('div', { className: 'ph-kv-row' },
                  h('span', { className: 'ph-kv-key' }, t('pluginAudit.kv.compat')),
                  h('span', { className: 'ph-kv-value' }, compatText(t, audit.compatibility))),
                h('div', { className: 'ph-kv-row' },
                  h('span', { className: 'ph-kv-key' }, t('pluginAudit.kv.repo')),
                  h('span', { className: 'ph-kv-value' },
                    href
                      ? h('a', { className: 'ph-link', href: href, target: '_blank', rel: 'noreferrer' }, String(plugin.repo))
                      : String(plugin.repo || t('pluginAudit.value.none')))),
                h('div', { className: 'ph-kv-row' },
                  h('span', { className: 'ph-kv-key' }, t('pluginAudit.kv.source')),
                  h('span', { className: 'ph-kv-value' }, sourceText(t, audit.source))),
                h('div', { className: 'ph-kv-row' },
                  h('span', { className: 'ph-kv-key' }, t('pluginAudit.kv.state')),
                  h('span', { className: 'ph-kv-value' }, stateText(t, audit.state) + (audit.stage ? ' · ' + progressText(t, audit) : ''))),
                h('div', { className: 'ph-kv-row' },
                  h('span', { className: 'ph-kv-key' }, t('pluginAudit.kv.installed')),
                  h('span', { className: 'ph-kv-value' }, t(audit.installed ? 'pluginAudit.value.yes' : 'pluginAudit.value.no'))))))
            : h('p', { className: 'ph-note' }, view.error ? t('pluginAudit.error.status') : (view.busy ? t('pluginAudit.loading') : t('pluginAudit.idle'))),
          audit && audit.detail ? h('p', { className: 'ph-note' }, String(audit.detail)) : null,
          audit ? h('div', { className: 'ph-section-head' },
            h('h4', { className: 'ph-section-title' }, t('pluginAudit.section.findings')),
            h('span', { className: 'ph-note' }, String(findings.length))) : null,
          findings.length === 0
            ? (audit ? h('p', { className: 'ph-note' }, t('pluginAudit.findings.none')) : null)
            : h('div', { className: 'ph-audit-findings' }, sortFindings(findings).map(function (finding, index) {
                return h(FindingRow, { t: t, finding: finding, key: 'f' + index })
              })),
          audit ? h(SessionRow, { t: t, audit: audit }) : null))
}

defineCard({
  id: 'plugin-audit',
  shipped: true,
  order: 35,
  title: function () { return runtime.t('card.pluginAudit.title') },
  icon: 'shield',
  size: { w: 2, h: 2 },
  minSize: { w: 2, h: 1 },
  maxSize: { w: 4, h: 3 },
  accent: '#475569',
  texture: true,
  effects: { outline: 'outline', sheen: false, ripple: false, float: false },
  refreshMs: 0,
  content: function (api) { return h(AuditPreview, { api: api, t: runtime.t }) },
  detail: function (api) { return h(AuditDetail, { api: api, t: runtime.t }) },
  // The audit id is the one piece of state the preview and the expanded body
  // share, and the framework keeps per-card control values across both, so it
  // lives in a control that is never drawn. It sits in detailActions rather
  // than in actions because a non-empty `actions` list makes the wall render a
  // settings bar next to the card, and the preview must not carry one.
  actions: [],
  detailActions: [
    { id: 'auditId', type: 'text', hidden: true, value: '' },
    { id: 'auditPrompt', type: 'text', hidden: true, value: '' },
    { id: 'auditModel', type: 'text', hidden: true, value: '' },
    { id: 'auditEffort', type: 'text', hidden: true, value: '' },
    // The changed-audit signal (see SIGNAL): a control rather than component state
    // because the preview and the expanded body are separate instances that must
    // agree, and a control is the one value the framework shares between them.
    { id: 'auditSignal', type: 'text', hidden: true, value: '' },
  ],
})

dict({
  zh: {
    'card.pluginAudit.title': '插件审核',
    'pluginAudit.metadata': '插件详情',
    'pluginAudit.catalogLanguage': 'zh',
    'pluginAudit.model': '审核模型',
    'pluginAudit.model.default': '跟随全局默认模型',
    'pluginAudit.model.unavailable': '已选模型不可用，请重新选择',
    'pluginAudit.model.error': '模型列表读取失败，仍可使用全局默认模型',
    'pluginAudit.effort': '思考强度',
    'pluginAudit.effort.default': '模型默认',
    'pluginAudit.effort.none': '不支持或未提供思考强度',
    'pluginAudit.prompt.edit': '编辑提示词',
    'pluginAudit.prompt.title': '审核提示词',
    'pluginAudit.prompt.custom': '自定义',
    'pluginAudit.prompt.default': '默认',
    'pluginAudit.prompt.hint': '保存后用于后续审核。审核对象、结果回传格式与安全约束由系统自动附加。',
    'pluginAudit.prompt.save': '保存提示词',
    'pluginAudit.prompt.reset': '恢复默认',
    'pluginAudit.prompt.unsaved': '有未保存的修改',
    'pluginAudit.prompt.ready': '已保存 · 下次审核生效',

    'pluginAudit.state.none': '无审核',
    'pluginAudit.state.running': '审核中',
    'pluginAudit.state.safe': '安全',
    'pluginAudit.state.warn': '需确认',
    'pluginAudit.state.unsafe': '不安全',
    'pluginAudit.state.failed': '失败',
    'pluginAudit.state.declined': '已取消',
    'pluginAudit.state.installing': '安装中',
    'pluginAudit.state.installed': '已安装',

    'pluginAudit.stage.reading': '正在读取插件信息',
    'pluginAudit.stage.tool': '正在调用审核工具',
    'pluginAudit.stage.writing': '正在整理审核结论',
    'pluginAudit.stage.installing': '正在安装',
    'pluginAudit.stage.noVerdict': '审核会话没有给出结论',
    'pluginAudit.stage.sessionFailed': '审核会话启动失败',
    'pluginAudit.stage.installFailed': '安装失败',

    'pluginAudit.level.info': '提示',
    'pluginAudit.level.warn': '警告',
    'pluginAudit.level.error': '风险',

    'pluginAudit.notice.warn': '{plugin} 需要你确认后才能安装',
    'pluginAudit.notice.unsafe': '{plugin} 未通过安全审核，已阻止安装',
    'pluginAudit.notice.failed': '{plugin} 的审核没有完成',
    'pluginAudit.notice.safe': '{plugin} 审核通过，请在记录里确认安装',
    'pluginAudit.notice.unpinned': '{plugin} 审核完成，但源码没有固定到不可变版本，不能安装；请用精确版本或 commit 重新审核',
    'pluginAudit.notice.installing': '正在安装 {plugin}',
    'pluginAudit.notice.installed': '{plugin} 已安装完成',
    'pluginAudit.notice.declined': '已取消 {plugin} 的安装',

    'pluginAudit.loading': '正在读取审核状态…',
    'pluginAudit.idle': '还没有审核记录',
    'pluginAudit.error.status': '审核状态读取失败',
    'pluginAudit.stalled': '宿主长时间没有更新进度',
    'pluginAudit.unnamed': '未知插件',
    'pluginAudit.findings.none': '没有发现具体问题',
    'pluginAudit.finding.ref': '出处：{ref}',
    'pluginAudit.finding.expand': '展开',
    'pluginAudit.finding.collapse': '收起',
    'pluginAudit.risk.role': '作用',
    'pluginAudit.risk.why': '为什么',
    'pluginAudit.risk.impact': '可能风险',
    'pluginAudit.risk.scenario': '发生情境',
    'pluginAudit.risk.missing': '这次审核只给了结论，没有说明它可能在什么情境下出问题。',
    'pluginAudit.scenario.supplyChain': '供应链攻击',
    'pluginAudit.scenario.privilegeEscalation': 'Agent 越权',
    'pluginAudit.scenario.sandboxEscape': '沙箱逃逸',
    'pluginAudit.scenario.dataLeak': '数据泄露',
    'pluginAudit.scenario.unsafePublish': '不安全的网络发布',
    'pluginAudit.scenario.other': '其他情境',
    'pluginAudit.summary.none': '这次审核没有结论',

    'pluginAudit.target': '插件',
    'pluginAudit.target.placeholder': 'npm 包名或 owner/repo',
    'pluginAudit.action.start': '开始审核',
    'pluginAudit.action.installNow': '安装',
    'pluginAudit.action.install': '仍然安装',
    'pluginAudit.action.decline': '取消',
    'pluginAudit.action.installing': '安装中…',
    'pluginAudit.action.declining': '取消中…',
    'pluginAudit.pending': '宿主正在执行，可能需要几十秒',
    'pluginAudit.action.openSession': '打开审核会话',
    'pluginAudit.session.none': '审核会话还没有建立',
    'pluginAudit.session.unavailable': '当前界面没有会话服务，无法打开',

    'pluginAudit.section.target': '审核目标',
    'pluginAudit.section.verdict': '审核结论',
    'pluginAudit.section.findings': '审核发现',
    'pluginAudit.section.session': '审核会话',
    'pluginAudit.section.history': '审核记录',
    'pluginAudit.tab.current': '当前审核',
    'pluginAudit.tab.history': '审核记录',
    'pluginAudit.history.empty': '还没有审核记录',
    'pluginAudit.history.view': '加载条目',

    'pluginAudit.kv.plugin': '插件',
    'pluginAudit.kv.version': '版本',
    'pluginAudit.kv.compat': '版本相容',
    'pluginAudit.kv.repo': '仓库',
    'pluginAudit.kv.source': '源码快照',
    'pluginAudit.kv.state': '状态',
    'pluginAudit.kv.installed': '已安装',
    'pluginAudit.value.none': '—',
    'pluginAudit.value.yes': '是',
    'pluginAudit.value.no': '否',
    'pluginAudit.compat.ok': '本机 {runtime}，声明的范围相容',
    'pluginAudit.compat.bad': '本机 {runtime}，声明的范围 {required} 装不上',
    'pluginAudit.compat.unknown': '无法判断（没有读到本机 DSH 版本）',
    'pluginAudit.source.truncated': '已截断',
    'pluginAudit.source.unpinned': '未固定，不能安装',
  },
  en: {
    'card.pluginAudit.title': 'Plugin audit',
    'pluginAudit.metadata': 'Plugin details',
    'pluginAudit.catalogLanguage': 'en',
    'pluginAudit.model': 'Review model',
    'pluginAudit.model.default': 'Use global default model',
    'pluginAudit.model.unavailable': 'Selected model unavailable — choose again',
    'pluginAudit.model.error': 'Could not load models. The global default is still available.',
    'pluginAudit.effort': 'Reasoning effort',
    'pluginAudit.effort.default': 'Model default',
    'pluginAudit.effort.none': 'Reasoning effort unavailable',
    'pluginAudit.prompt.edit': 'Edit prompt',
    'pluginAudit.prompt.title': 'Review prompt',
    'pluginAudit.prompt.custom': 'Custom',
    'pluginAudit.prompt.default': 'Default',
    'pluginAudit.prompt.hint': 'Applies to future reviews once saved. The target, report format and safety constraints are appended automatically.',
    'pluginAudit.prompt.save': 'Save prompt',
    'pluginAudit.prompt.reset': 'Restore default',
    'pluginAudit.prompt.unsaved': 'Unsaved changes',
    'pluginAudit.prompt.ready': 'Saved · applies to the next review',

    'pluginAudit.state.none': 'No audit',
    'pluginAudit.state.running': 'Reviewing',
    'pluginAudit.state.safe': 'Safe',
    'pluginAudit.state.warn': 'Needs you',
    'pluginAudit.state.unsafe': 'Unsafe',
    'pluginAudit.state.failed': 'Failed',
    'pluginAudit.state.declined': 'Cancelled',
    'pluginAudit.state.installing': 'Installing',
    'pluginAudit.state.installed': 'Installed',

    'pluginAudit.stage.reading': 'Reading the plugin',
    'pluginAudit.stage.tool': 'Calling the review tools',
    'pluginAudit.stage.writing': 'Writing up the verdict',
    'pluginAudit.stage.installing': 'Installing',
    'pluginAudit.stage.noVerdict': 'The review session gave no verdict',
    'pluginAudit.stage.sessionFailed': 'The review session could not start',
    'pluginAudit.stage.installFailed': 'The install failed',

    'pluginAudit.level.info': 'Note',
    'pluginAudit.level.warn': 'Warning',
    'pluginAudit.level.error': 'Risk',

    'pluginAudit.notice.warn': '{plugin} needs your confirmation before it can be installed',
    'pluginAudit.notice.unsafe': '{plugin} failed the security review, so the install was blocked',
    'pluginAudit.notice.failed': 'The review of {plugin} did not finish',
    'pluginAudit.notice.safe': '{plugin} passed the review; confirm the install from this record',
    'pluginAudit.notice.unpinned': '{plugin} was reviewed, but its source is not pinned to an immutable version and cannot be installed; re-run with an exact version or commit',
    'pluginAudit.notice.installing': 'Installing {plugin}',
    'pluginAudit.notice.installed': '{plugin} is installed',
    'pluginAudit.notice.declined': 'Cancelled the install of {plugin}',

    'pluginAudit.loading': 'Reading the review…',
    'pluginAudit.idle': 'No review yet',
    'pluginAudit.error.status': 'The review status could not be read',
    'pluginAudit.stalled': 'The host has not reported progress for a while',
    'pluginAudit.unnamed': 'unknown plugin',
    'pluginAudit.findings.none': 'Nothing specific was found',
    'pluginAudit.finding.ref': 'Ref: {ref}',
    'pluginAudit.finding.expand': 'Expand',
    'pluginAudit.finding.collapse': 'Collapse',
    'pluginAudit.risk.role': 'What it does',
    'pluginAudit.risk.why': 'Why it is there',
    'pluginAudit.risk.impact': 'What it could cost',
    'pluginAudit.risk.scenario': 'When it happens',
    'pluginAudit.risk.missing': 'The review gave a verdict without saying what situation this could go wrong in.',
    'pluginAudit.scenario.supplyChain': 'Supply-chain attack',
    'pluginAudit.scenario.privilegeEscalation': 'Agent overreach',
    'pluginAudit.scenario.sandboxEscape': 'Sandbox escape',
    'pluginAudit.scenario.dataLeak': 'Data leak',
    'pluginAudit.scenario.unsafePublish': 'Unsafe publish',
    'pluginAudit.scenario.other': 'Another situation',
    'pluginAudit.summary.none': 'This review reached no verdict',

    'pluginAudit.target': 'Plugin',
    'pluginAudit.target.placeholder': 'npm package, or owner/repo',
    'pluginAudit.action.start': 'Start review',
    'pluginAudit.action.installNow': 'Install',
    'pluginAudit.action.install': 'Install anyway',
    'pluginAudit.action.decline': 'Cancel',
    'pluginAudit.action.installing': 'Installing…',
    'pluginAudit.action.declining': 'Cancelling…',
    'pluginAudit.pending': 'The host is working; this can take a while',
    'pluginAudit.action.openSession': 'Open the review session',
    'pluginAudit.session.none': 'The review session is not open yet',
    'pluginAudit.session.unavailable': 'This client has no session service to open it with',

    'pluginAudit.section.target': 'Target',
    'pluginAudit.section.verdict': 'Verdict',
    'pluginAudit.section.findings': 'Findings',
    'pluginAudit.section.session': 'Review session',
    'pluginAudit.section.history': 'Review history',
    'pluginAudit.tab.current': 'Current review',
    'pluginAudit.tab.history': 'Review history',
    'pluginAudit.history.empty': 'No reviews yet',
    'pluginAudit.history.view': 'Load entry',

    'pluginAudit.kv.plugin': 'Plugin',
    'pluginAudit.kv.version': 'Version',
    'pluginAudit.kv.compat': 'Version fit',
    'pluginAudit.kv.repo': 'Repository',
    'pluginAudit.kv.source': 'Source snapshot',
    'pluginAudit.kv.state': 'State',
    'pluginAudit.kv.installed': 'Installed',
    'pluginAudit.value.none': '—',
    'pluginAudit.value.yes': 'yes',
    'pluginAudit.value.no': 'no',
    'pluginAudit.compat.ok': 'runs {runtime}, the declared range fits',
    'pluginAudit.compat.bad': 'runs {runtime}, the declared range {required} does not fit',
    'pluginAudit.compat.unknown': 'cannot tell (no runtime version was read)',
    'pluginAudit.source.truncated': 'truncated',
    'pluginAudit.source.unpinned': 'unpinned, not installable',
  },
})
