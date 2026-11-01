/**
 * Sessions — the wall's answer to "does anything need me right now?".
 *
 * Three readings, one per human-relevant state: a session that is running, a
 * session that is waiting for an approval/answer, and a session that finished
 * but has not been looked at since. The expanded page turns the same readings
 * into a short, ordered list: waiting first, then running, then unread. The
 * order is the point — a wall that shows equal-size numbers while a session is
 * blocked on the user is not doing its job.
 *
 * The data is the DSH ui-session status map, already computed by the host:
 * `api.sessionStatus` (a ReadonlyMap of { running, pendingInteraction,
 * completionUnread }) and `api.sessionList` (the ids to show plus the small
 * display record for each). The host owns the "focused means seen" rule, so the
 * card persists nothing and polls nothing: it reads the api getters on every
 * render and the framework re-renders when the host's store changes.
 *
 * Everything degrades: a host that has not mounted the session bridge answers
 * undefined for both getters, and the card shows the unavailable state with
 * zero counts instead of throwing.
 */

    var h = kit.h
    var React = kit.React
    var UI = kit.UI
    var ICONS = kit.ICONS
    var runtime = kit.runtime
    var defineCard = kit.defineCard
    var dict = kit.dict
    var pushToast = kit.pushToast

    // A green-teal, distinct from the knowledge card's orchid and the skills
    // card's indigo; the three cards sit next to each other on the wall.
    var ACCENT = '#0f9f8f'

    // One classification per session, most urgent first. `unread` is the
    // display name for "completed and not seen"; the eligibility flag itself is
    // `completionUnread` on the host record.
    var PRIORITY = { waiting: 0, running: 1, unread: 2 }

    // ---------------------------------------------------------------- drawing

    /**
     * One 24-grid stroke mark, the weight and joins shared by every glyph so a
     * row of them reads as one hand. `currentColor` is the only ink.
     */
    function glyph(children) {
      return function (size) {
        return h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': '1.8',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        }, children)
      }
    }

    var GLYPH = {
      // Two session lanes: one dot and one line inside each, which is legible
      // at 12px and still reads as "a list of conversations" at 24px.
      sessions: glyph([
        h('rect', { key: 'a', x: '3.5', y: '4', width: '17', height: '6.5', rx: '2' }),
        h('rect', { key: 'b', x: '3.5', y: '13.5', width: '17', height: '6.5', rx: '2' }),
        h('circle', { key: 'c', cx: '7.5', cy: '7.25', r: '.85', fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'd', cx: '7.5', cy: '16.75', r: '.85', fill: 'currentColor', stroke: 'none' }),
        h('path', { key: 'e', d: 'M14 7.25h3.5' }),
        h('path', { key: 'f', d: 'M14 16.75h3.5' }),
      ]),
      folder: glyph([
        h('path', { key: 'a', d: 'M3.5 7.5a2 2 0 0 1 2-2h4l1.8 2h7.2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' }),
      ]),
      stop: glyph([
        h('rect', { key: 'a', x: '7.5', y: '7.5', width: '9', height: '9', rx: '1.6', fill: 'currentColor', stroke: 'none' }),
      ]),
      refresh: glyph([
        h('path', { key: 'a', d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3' }),
        h('path', { key: 'b', d: 'M19.5 4.8v4h-4' }),
      ]),
      alert: glyph([
        h('path', { key: 'a', d: 'M12 4.2 21 20H3z' }),
        h('path', { key: 'b', d: 'M12 10v4.2' }),
        h('circle', { key: 'c', cx: '12', cy: '17.2', r: '.9', fill: 'currentColor', stroke: 'none' }),
      ]),
    }

    ICONS.sessions = GLYPH.sessions

    // ------------------------------------------------------------------ text

    function asText(value) {
      if (value === null || value === undefined) return ''
      return String(value)
    }

    /** A session id shown on its own has to stay short enough for one row. */
    function shortId(id) {
      var text = asText(id)
      return text.length > 8 ? text.slice(0, 8) : text
    }

    /**
     * The last path component of a project directory. Both separators are
     * handled because the host may be on Windows and the recorded cwd uses
     * backslashes even when the card is rendered on another platform.
     */
    function projectOf(cwd) {
      var text = asText(cwd).trim()
      if (text === '') return ''
      var parts = text.split(/[\\/]+/)
      var last = ''
      for (var index = 0; index < parts.length; index += 1) {
        if (parts[index] !== '') last = parts[index]
      }
      return last === '' ? text : last
    }

    /**
     * Classify one host record. A waiting session that is also running counts
     * as waiting only: one session belongs to one count, and the approval is
     * the thing a person can act on.
     */
    function stateOf(entry) {
      if (!entry || typeof entry !== 'object') return ''
      var pending = entry.pendingInteraction
      if (pending !== null && pending !== undefined && asText(pending).trim() !== '') return 'waiting'
      if (entry.running === true) return 'running'
      if (entry.completionUnread === true) return 'unread'
      return ''
    }

    // --------------------------------------------------------------- summary

    /** The host may answer a Map; a plain record is accepted for resilience. */
    function isStatusSource(value) {
      return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    }

    function entryOf(source, id) {
      if (!source) return undefined
      if (typeof source.get === 'function') return source.get(id)
      return source[id]
    }

    function idsOf(source) {
      if (!source) return []
      if (typeof source.keys === 'function') return Array.from(source.keys())
      return Object.keys(source)
    }

    function sessionListOf(list) {
      return list !== null && typeof list === 'object' ? list : null
    }

    /**
     * Turn the host's status map and session list into the one shape both the
     * preview and the expanded page read. Pure: no React, no api, no clock.
     *
     * Contract: every session is counted once, priority
     * waiting > running > unread. `origin === 'subagent'` and `blank === true`
     * sessions are not shown (and therefore not counted), and when the list
     * carries an `ids` array it is authoritative even when empty.
     *
     * @param statuses - a ReadonlyMap (or plain record) of session status.
     * @param list - `{ ids?, byId? }` from the host; null/undefined is allowed.
     * @returns `{ available, waiting, running, unread, total, projects, rows }`.
     */
    function summarize(statuses, list) {
      var source = isStatusSource(statuses) ? statuses : null
      var meta = sessionListOf(list)
      var byId = meta && meta.byId && typeof meta.byId === 'object' ? meta.byId : null
      var ids = null
      if (meta && Array.isArray(meta.ids)) ids = meta.ids.slice()
      else if (byId) ids = Object.keys(byId)
      else if (source) ids = idsOf(source)

      var rows = []
      var waiting = 0
      var running = 0
      var unread = 0

      if (source && ids) {
        var seen = {}
        for (var index = 0; index < ids.length; index += 1) {
          var id = ids[index]
          if (id === null || id === undefined) continue
          var key = asText(id)
          if (key === '' || seen[key] === true) continue
          seen[key] = true
          var entry = entryOf(source, id)
          var state = stateOf(entry)
          if (state === '') continue
          var info = byId && byId[key] && typeof byId[key] === 'object' ? byId[key] : null
          if (info && (info.origin === 'subagent' || info.blank === true)) continue
          var title = info ? (info.displayTitle || info.title) : ''
          var stamp = info ? Number(info.updatedAt) : 0
          rows.push({
            id: key,
            state: state,
            title: asText(title).trim() !== '' ? asText(title) : shortId(key),
            project: info ? projectOf(info.cwd) : '',
            cwd: info ? asText(info.cwd) : '',
            updatedAt: Number.isFinite(stamp) && stamp > 0 ? stamp : 0,
            running: entry.running === true,
          })
          if (state === 'waiting') waiting += 1
          else if (state === 'running') running += 1
          else unread += 1
        }
      }

      rows.sort(function (left, right) {
        if (PRIORITY[left.state] !== PRIORITY[right.state]) {
          return PRIORITY[left.state] - PRIORITY[right.state]
        }
        if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt
        if (left.id === right.id) return 0
        return left.id < right.id ? -1 : 1
      })

      var projects = {}
      for (var rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        if (rows[rowIndex].project !== '') projects[rows[rowIndex].project] = true
      }

      return {
        available: source !== null,
        waiting: waiting,
        running: running,
        unread: unread,
        total: rows.length,
        projects: Object.keys(projects).length,
        rows: rows,
      }
    }

    /** Relative age for a row; a missing stamp renders nothing at all. */
    function relativeText(stamp, now, t) {
      var at = Number(stamp)
      if (!Number.isFinite(at) || at <= 0) return ''
      var delta = now - at
      if (delta < 0) delta = 0
      if (delta < 60000) return t('session.time.now')
      if (delta < 3600000) return t('session.time.minutes', { count: Math.floor(delta / 60000) })
      if (delta < 86400000) return t('session.time.hours', { count: Math.floor(delta / 3600000) })
      return t('session.time.days', { count: Math.floor(delta / 86400000) })
    }

    /** The host's business-error text, as short as it can honestly be. */
    function failureReason(result) {
      if (!result || typeof result !== 'object') return ''
      var value = result.error !== undefined
        ? result.error
        : result.message !== undefined
          ? result.message
          : result.reason
      if (value && typeof value === 'object') {
        value = value.message !== undefined ? value.message : asText(value)
      }
      return value === null || value === undefined ? '' : asText(value).trim()
    }

    // ------------------------------------------------------------------ style
    //
    // The palette is the card's own `--ph-ss-*` layer, whose only literals are
    // the registered accent and the color-mix percentages. Hover rules live in
    // one pointer-capable media query and no keyframes are introduced: the
    // framework's ripple/spotlight remain the only animations on a card.

    var STYLE = [
      '.ph-ss{--ph-ss-accent:' + ACCENT + ';',
      '--ph-ss-ink:var(--dsw-alias-label-primary,#1f2328);',
      '--ph-ss-ink2:var(--dsw-alias-label-secondary,#6b7280);',
      '--ph-ss-ink3:var(--dsw-alias-label-tertiary,#8b93a1);',
      '--ph-ss-line:var(--dsw-alias-border-l2,#e5e7eb);',
      '--ph-ss-line-soft:var(--dsw-alias-border-l1,#eef0f3);',
      '--ph-ss-surface:var(--dsw-alias-bg-layer-1,#fff);',
      '--ph-ss-sunken:var(--dsw-alias-bg-layer-2,#f6f7f9);',
      '--ph-ss-hover:var(--dsw-alias-interactive-bg-hover,rgba(31,35,40,.04));',
      '--ph-ss-waiting:var(--dsw-alias-state-warn-primary,#b45309);',
      '--ph-ss-running:var(--dsw-alias-state-success-primary,#15803d);',
      '--ph-ss-unread:var(--dsw-alias-state-business-primary,#1d4ed8);',
      '--ph-ss-error:var(--dsw-alias-state-error-primary,#dc2626);',
      '--ph-ss-radius:14px;display:flex;flex-direction:column;gap:14px;min-width:0;color:var(--ph-ss-ink)}',

      // ---- wall preview: three readings, the share bar, one foot line
      '.ph-ss-preview{display:flex;flex-direction:column;gap:10px;min-width:0}',
      '.ph-ss-reads{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}',
      '.ph-ss-read{--ph-ss-tone:var(--ph-ss-ink3);display:flex;flex-direction:column;gap:2px;min-width:0;padding:9px 10px 10px;border:1px solid var(--ph-ss-line-soft);border-radius:12px;background:color-mix(in srgb,var(--ph-ss-sunken) 70%,transparent)}',
      '.ph-ss-read.is-running{--ph-ss-tone:var(--ph-ss-running)}',
      '.ph-ss-read.is-waiting{--ph-ss-tone:var(--ph-ss-waiting)}',
      '.ph-ss-read.is-unread{--ph-ss-tone:var(--ph-ss-unread)}',
      '.ph-ss-read.is-hot{background:color-mix(in srgb,var(--ph-ss-tone) 9%,transparent);border-color:color-mix(in srgb,var(--ph-ss-tone) 24%,transparent)}',
      '.ph-ss-read-top{display:flex;align-items:center;gap:6px;min-width:0;font-size:10.5px;line-height:14px;color:var(--ph-ss-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ph-ss-big{font-size:30px;line-height:32px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}',
      '.ph-ss-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--ph-ss-tone,var(--ph-ss-ink3));box-shadow:0 0 0 2px color-mix(in srgb,var(--ph-ss-tone,var(--ph-ss-ink3)) 18%,transparent)}',
      '.ph-ss-share{display:flex;height:6px;border-radius:999px;overflow:hidden;gap:2px;background:var(--ph-ss-sunken)}',
      '.ph-ss-share i{display:block;height:100%;border-radius:3px;background:var(--ph-ss-tone)}',
      '.ph-ss-share i.is-running{--ph-ss-tone:var(--ph-ss-running)}',
      '.ph-ss-share i.is-waiting{--ph-ss-tone:var(--ph-ss-waiting)}',
      '.ph-ss-share i.is-unread{--ph-ss-tone:var(--ph-ss-unread)}',
      '.ph-ss-share.is-empty{background:var(--ph-ss-sunken);opacity:.55}',
      '.ph-ss-foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--ph-ss-ink3);font-variant-numeric:tabular-nums}',
      '.ph-ss-sep{opacity:.55}',
      '.ph-ss-flag{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;height:24px;padding:0 10px;border-radius:999px;background:color-mix(in srgb,var(--ph-ss-waiting) 12%,transparent);color:var(--ph-ss-waiting);font-size:10.5px;line-height:15px;font-weight:600;white-space:nowrap}',
      '.ph-ss-flag svg{flex:none}',

      // ---- expanded page: head, readings, filter, list
      '.ph-ss-page{display:flex;flex-direction:column;gap:12px;min-width:0}',
      '.ph-ss-head{display:flex;align-items:center;justify-content:flex-end;gap:12px;padding:0 2px}',
      '.ph-ss-head-spacer{flex:1 1 auto;min-width:8px}',
      '.ph-ss-live{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:999px;background:color-mix(in srgb,var(--ph-ss-accent) 11%,transparent);color:var(--ph-ss-accent);font-size:10.5px;line-height:15px;font-weight:600;white-space:nowrap}',
      '.ph-ss-live .ph-ss-dot{width:6px;height:6px;--ph-ss-tone:var(--ph-ss-accent);box-shadow:none}',
      '.ph-ss-iconbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:1px solid var(--ph-ss-line);border-radius:10px;background:var(--ph-ss-surface);color:var(--ph-ss-ink2);cursor:pointer;transition:border-color 140ms ease,color 140ms ease,background 140ms ease}',
      '.ph-ss-iconbtn:disabled{opacity:.45;cursor:default}',

      '.ph-ss-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}',
      '.ph-ss-stat{--ph-ss-tone:var(--ph-ss-ink3);display:flex;flex-direction:column;gap:1px;min-width:0;padding:11px 13px 12px;border:1px solid var(--ph-ss-line-soft);border-radius:12px;background:color-mix(in srgb,var(--ph-ss-sunken) 55%,transparent)}',
      '.ph-ss-stat.is-waiting{--ph-ss-tone:var(--ph-ss-waiting)}',
      '.ph-ss-stat.is-running{--ph-ss-tone:var(--ph-ss-running)}',
      '.ph-ss-stat.is-unread{--ph-ss-tone:var(--ph-ss-unread)}',
      '.ph-ss-stat-top{display:flex;align-items:center;gap:6px;font-size:10.5px;line-height:15px;color:var(--ph-ss-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ph-ss-stat-num{font-size:26px;line-height:30px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}',

      '.ph-ss-filters{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.ph-ss .ph-segmented{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 60%,transparent);border-color:var(--ph-ss-line)}',
      '.ph-ss .ph-segment{font-size:11.5px;padding:4px 10px}',
      '.ph-ss .ph-segment.is-active{background:color-mix(in srgb,var(--ph-ss-accent) 12%,transparent);color:var(--ph-ss-accent)}',

      '.ph-ss-list{display:flex;flex-direction:column;gap:6px}',
      '.ph-ss-row{--ph-ss-tone:var(--ph-ss-ink3);display:flex;align-items:center;gap:10px;min-width:0;padding:9px 12px;border:1px solid var(--ph-ss-line-soft);border-radius:12px;background:var(--ph-ss-surface);cursor:pointer;transition:border-color 140ms ease,background 140ms ease}',
      '.ph-ss-row.is-waiting{--ph-ss-tone:var(--ph-ss-waiting)}',
      '.ph-ss-row.is-running{--ph-ss-tone:var(--ph-ss-running)}',
      '.ph-ss-row.is-unread{--ph-ss-tone:var(--ph-ss-unread)}',
      '.ph-ss-row-main{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-width:0}',
      '.ph-ss-row-title{font-size:13px;line-height:19px;font-weight:600;color:var(--ph-ss-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ph-ss-row-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;font-size:11px;line-height:15px;color:var(--ph-ss-ink3)}',
      '.ph-ss-project{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ph-ss-project svg{flex:none;color:var(--ph-ss-ink3)}',
      '.ph-ss-time{font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.ph-ss-tag{flex:none;display:inline-flex;align-items:center;height:21px;padding:0 8px;border-radius:999px;font-size:10.5px;line-height:15px;font-weight:600;white-space:nowrap;background:color-mix(in srgb,var(--ph-ss-tone) 12%,transparent);color:var(--ph-ss-tone)}',
      '.ph-ss-stop{flex:none;display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:1px solid color-mix(in srgb,var(--ph-ss-error) 28%,transparent);border-radius:9px;background:transparent;font:inherit;font-size:11.5px;line-height:16px;font-weight:600;color:var(--ph-ss-error);cursor:pointer;white-space:nowrap;transition:border-color 140ms ease,background 140ms ease,opacity 140ms ease}',
      '.ph-ss-stop:disabled{opacity:.5;cursor:default}',
      '.ph-ss-row:focus-visible,.ph-ss-stop:focus-visible,.ph-ss-iconbtn:focus-visible{outline:2px solid color-mix(in srgb,var(--ph-ss-accent) 55%,transparent);outline-offset:2px}',
      '.ph-ss-none{margin:0;padding:2px 4px;font-size:12px;line-height:18px;color:var(--ph-ss-ink3)}',

      // ---- empty / unavailable
      '.ph-ss-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:34px 18px;border:1px dashed var(--ph-ss-line);border-radius:14px;background:color-mix(in srgb,var(--ph-ss-sunken) 45%,transparent);text-align:center}',
      '.ph-ss-empty svg{color:var(--ph-ss-ink3);opacity:.7}',
      '.ph-ss-empty b{font-size:13px;line-height:20px;font-weight:600;color:var(--ph-ss-ink2)}',
      '.ph-ss-empty span{max-width:340px;font-size:11.5px;line-height:17px;color:var(--ph-ss-ink3)}',

      '@media (hover:hover) and (pointer:fine){',
      '.ph-ss-row:hover{border-color:var(--ph-ss-line);background:var(--ph-ss-hover)}',
      '.ph-ss-stop:hover:not(:disabled){background:color-mix(in srgb,var(--ph-ss-error) 8%,transparent);border-color:color-mix(in srgb,var(--ph-ss-error) 45%,transparent)}',
      '.ph-ss-iconbtn:hover:not(:disabled){border-color:var(--ph-ss-line);color:var(--ph-ss-ink);background:var(--ph-ss-hover)}',
      '}',

      '@media (max-width:760px){',
      '.ph-ss-stats{grid-template-columns:1fr}',
      '.ph-ss-reads{grid-template-columns:1fr}',
      '.ph-ss-row{flex-wrap:wrap}',
      '.ph-ss-row-main{flex-basis:100%;order:-1}',
      '.ph-ss-tag{margin-left:17px}',
      '}',

      '@media (prefers-reduced-motion:reduce){.ph-ss *{transition:none!important;animation:none!important}}',
    ].join('\n')

    var styleSeat = { done: false }

    function ensureStyles() {
      if (styleSeat.done) return
      styleSeat.done = true
      try {
        runtime.insertCss(STYLE)
      } catch (error) {
        void error
      }
    }

    // ============================================================ wall preview

    /**
     * The reading: three numbers a person can act on, their share bar, and one
     * foot line. No controls: a wall card that carries buttons makes the wall
     * look like a settings page, and everything the card can do lives in the
     * expanded page.
     */
    function SessionsCard(props) {
      ensureStyles()
      var api = props.api
      var t = props.t
      var summary = summarize(api && api.sessionStatus, api && api.sessionList)
      var reads = [
        { state: 'running', count: summary.running },
        { state: 'waiting', count: summary.waiting },
        { state: 'unread', count: summary.unread },
      ]
      var segments = reads.filter(function (read) { return read.count > 0 })
      return h('div', { className: 'ph-ss ph-ss-preview' },
        h('div', { className: 'ph-ss-reads', role: 'group', 'aria-label': t('session.preview.readings') },
          reads.map(function (read) {
            return h('div', {
              key: read.state,
              className: 'ph-ss-read is-' + read.state + (read.count > 0 ? ' is-hot' : ''),
              'data-state': read.state,
            },
              h('span', { className: 'ph-ss-read-top' },
                h('i', { className: 'ph-ss-dot' }),
                h('span', null, t('session.state.' + read.state))),
              h('span', { className: 'ph-ss-big' }, String(read.count)))
          })),
        !summary.available
          ? h('div', { className: 'ph-ss-flag' }, GLYPH.alert(12), t('session.unavailable.title'))
          : summary.total > 0
            ? h('div', { className: 'ph-ss-share', role: 'img', 'aria-label': t('session.preview.scale') },
              segments.map(function (read) {
                return h('i', {
                  key: read.state,
                  className: 'is-' + read.state,
                  style: { flex: String(read.count) },
                })
              }))
            : h('div', { className: 'ph-ss-share is-empty', 'aria-hidden': 'true' }),
        h('div', { className: 'ph-ss-foot' },
          !summary.available
            ? h('span', null, t('session.unavailable.hint'))
            : summary.total === 0
              ? h('span', null, t('session.preview.none'))
              : h(React.Fragment, null,
                h('span', null, t('session.preview.total', { count: summary.total })),
                summary.projects > 0 ? h('span', { className: 'ph-ss-sep' }, '·') : null,
                summary.projects > 0
                  ? h('span', null, t('session.preview.projects', { count: summary.projects }))
                  : null)))
    }

    // =========================================================== expanded page

    function emptyState(t, glyphNode, title, hint) {
      return h('div', { className: 'ph-ss-empty' },
        glyphNode,
        h('b', null, title),
        h('span', null, hint))
    }

    /**
     * One session. The whole row opens the session; the stop button is a real
     * nested button that swallows its own click so stopping never navigates.
     */
    function SessionRow(props) {
      var row = props.row
      var t = props.t
      var stopTitle = props.busy ? t('session.stop.running') : t('session.stop')
      return h('div', {
        className: 'ph-ss-row is-' + row.state,
        role: 'button',
        tabIndex: 0,
        'data-session-id': row.id,
        title: t('session.row.open', { title: row.title }),
        onClick: function () { props.onOpen(row.id) },
        onKeyDown: function (event) {
          if (!event) return
          if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
          if (typeof event.preventDefault === 'function') event.preventDefault()
          props.onOpen(row.id)
        },
      },
        h('i', { className: 'ph-ss-dot' }),
        h('div', { className: 'ph-ss-row-main' },
          h('span', { className: 'ph-ss-row-title' }, row.title),
          h('span', { className: 'ph-ss-row-meta' },
            row.project !== ''
              ? h('span', { className: 'ph-ss-project', title: row.cwd || row.project },
                GLYPH.folder(12), row.project)
              : null,
            row.updatedAt > 0
              ? h('span', { className: 'ph-ss-time' }, relativeText(row.updatedAt, props.now, t))
              : null)),
        h('span', { className: 'ph-ss-tag' }, t('session.state.' + row.state)),
        row.running
          ? h('button', {
            type: 'button',
            className: 'ph-ss-stop',
            disabled: props.busy || props.disabled,
            title: stopTitle,
            onClick: function (event) {
              if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
              props.onStop(row.id)
            },
          }, GLYPH.stop(11), stopTitle)
          : null)
    }

    /**
     * The expanded page: the same three readings, one filter, one list. The
     * stop call goes through the shared act endpoint; the list itself is the
     * host's, so a successful stop shows up as soon as the host repaints.
     */
    function SessionsDetail(props) {
      ensureStyles()
      var api = props.api
      var t = props.t
      var summary = summarize(api && api.sessionStatus, api && api.sessionList)
      var filterState = React.useState('all')
      var filter = filterState[0]
      var setFilter = filterState[1]
      var busyState = React.useState('')
      var busyId = busyState[0]
      var setBusyId = busyState[1]
      var now = Date.now()

      function open(id) {
        if (!api || typeof api.openSession !== 'function') {
          pushToast(t('session.open.failed'), 'error')
          return
        }
        var opened = false
        try {
          opened = api.openSession(id)
        } catch (error) {
          opened = false
        }
        if (opened === false) pushToast(t('session.open.failed'), 'error')
      }

      function stop(id) {
        if (busyId !== '') return
        if (!api || typeof api.remote !== 'function') {
          pushToast(t('session.stop.failed', { reason: t('session.stop.reason') }), 'error')
          return
        }
        setBusyId(id)
        Promise.resolve()
          .then(function () {
            return api.remote('homepage/act', {
              options: { action: 'session.stop', payload: { sessionId: id } },
            })
          })
          .then(function (result) {
            if (!result || result.ok !== true) {
              throw new Error(failureReason(result) || t('session.stop.reason'))
            }
            pushToast(t('session.stop.done'))
          })
          .catch(function (error) {
            pushToast(t('session.stop.failed', {
              reason: error && error.message ? error.message : t('session.stop.reason'),
            }), 'error')
          })
          .then(function () { setBusyId('') })
      }

      var stats = [
        { state: 'waiting', count: summary.waiting },
        { state: 'running', count: summary.running },
        { state: 'unread', count: summary.unread },
      ]
      var filterOptions = [
        { value: 'all', label: t('session.filter.all') },
        { value: 'waiting', label: t('session.filter.waiting') },
        { value: 'running', label: t('session.filter.running') },
        { value: 'unread', label: t('session.filter.unread') },
      ]
      var shown = filter === 'all'
        ? summary.rows
        : summary.rows.filter(function (row) { return row.state === filter })

      var body = null
      if (!summary.available) {
        body = emptyState(t, GLYPH.alert(22), t('session.unavailable.title'), t('session.unavailable.hint'))
      } else if (summary.total === 0) {
        body = emptyState(t, GLYPH.sessions(22), t('session.empty.title'), t('session.empty.hint'))
      } else if (shown.length === 0) {
        body = h('p', { className: 'ph-ss-none' }, t('session.empty.filtered'))
      } else {
        body = h('div', { className: 'ph-ss-list', role: 'list' },
          shown.map(function (row) {
            return h(SessionRow, {
              key: row.id,
              row: row,
              t: t,
              now: now,
              busy: busyId === row.id,
              disabled: busyId !== '',
              onOpen: open,
              onStop: stop,
            })
          }))
      }

      return h('div', { className: 'ph-ss ph-ss-page' },
        h('div', { className: 'ph-ss-head' },
          h('span', { className: 'ph-ss-head-spacer' }),
          summary.available
            ? h('span', { className: 'ph-ss-live' }, h('i', { className: 'ph-ss-dot' }), t('session.page.live'))
            : null,
          h('button', {
            type: 'button',
            className: 'ph-ss-iconbtn',
            title: t('session.page.refreshHint'),
            'aria-label': t('session.page.refresh'),
            onClick: function () {
              if (api && typeof api.repaint === 'function') api.repaint()
            },
          }, GLYPH.refresh(15))),
        h('div', { className: 'ph-ss-stats' },
          stats.map(function (stat) {
            return h('div', {
              key: stat.state,
              className: 'ph-ss-stat is-' + stat.state + (stat.count > 0 ? ' is-hot' : ''),
            },
              h('span', { className: 'ph-ss-stat-top' },
                h('i', { className: 'ph-ss-dot' }),
                h('span', null, t('session.state.' + stat.state))),
              h('span', { className: 'ph-ss-stat-num' }, String(stat.count)))
          })),
        h('div', { className: 'ph-ss-filters' },
          h(UI.Segmented, {
            label: t('session.page.filter'),
            value: filter,
            options: filterOptions,
            onChange: setFilter,
          })),
        body)
    }

    // ----------------------------------------------------------- registration

    defineCard({
      id: 'sessions',
      title: function () { return runtime.t('session.title') },
      icon: function (size) { return ICONS.sessions(size) },
      accent: ACCENT,
      // Front of the wall, right after the balance: this is the card a person
      // glances at before anything else. It still leaves the balance first,
      // because money is the one number that changes without a session.
      order: 15,
      texture: { icon: 'sessions', opacity: 5, size: 118, bleed: '-16%' },
      size: { w: 2, h: 2 },
      minSize: { w: 2, h: 2 },
      maxSize: { w: 4, h: 3 },
      hover: { grow: 1.03, hint: true },
      tags: ['session', 'runtime', 'attention'],
      shipped: true,
      content: function (api) { return h(SessionsCard, { api: api, t: runtime.t }) },
      detail: function (api) { return h(SessionsDetail, { api: api, t: runtime.t }) },
      // Exposed so the card's own test can drive the classifier without a
      // render, and so a future host path can reuse the one priority rule.
      summarize: summarize,
      stateOf: stateOf,
      dict: {
        zh: {
          'session.title': '会话状态',

          'session.state.waiting': '等待介入',
          'session.state.running': '运行中',
          'session.state.unread': '待查看',

          'session.preview.readings': '会话读数',
          'session.preview.scale': '状态占比',
          'session.preview.total': '共 {count} 个会话',
          'session.preview.projects': '{count} 个项目',
          'session.preview.none': '当前没有需要关注的会话',

          'session.page.live': '实时',
          'session.page.refresh': '刷新',
          'session.page.refreshHint': '重新读取当前读数',
          'session.page.filter': '筛选',

          'session.filter.all': '全部',
          'session.filter.waiting': '等待',
          'session.filter.running': '运行',
          'session.filter.unread': '待查看',

          'session.empty.title': '当前没有需要关注的会话',
          'session.empty.hint': '运行中、等待你处理或刚结束的会话会出现在这里',
          'session.empty.filtered': '该状态下没有会话',

          'session.unavailable.title': '会话状态暂不可用',
          'session.unavailable.hint': 'DSH 会话服务接入后会显示实时读数',

          'session.stop': '停止',
          'session.stop.running': '停止中',
          'session.stop.done': '已停止该会话',
          'session.stop.failed': '停止失败：{reason}',
          'session.stop.reason': '未知错误',
          'session.open.failed': '无法打开该会话',
          'session.row.open': '打开会话：{title}',

          'session.time.now': '刚刚',
          'session.time.minutes': '{count} 分钟前',
          'session.time.hours': '{count} 小时前',
          'session.time.days': '{count} 天前',
        },
        en: {
          'session.title': 'Sessions',

          'session.state.waiting': 'Waiting on you',
          'session.state.running': 'Running',
          'session.state.unread': 'Unread',

          'session.preview.readings': 'Session readings',
          'session.preview.scale': 'Share by state',
          'session.preview.total': '{count} sessions',
          'session.preview.projects': '{count} projects',
          'session.preview.none': 'Nothing needs attention',

          'session.page.live': 'Live',
          'session.page.refresh': 'Refresh',
          'session.page.refreshHint': 'Re-read the current readings',
          'session.page.filter': 'Filter',

          'session.filter.all': 'All',
          'session.filter.waiting': 'Waiting',
          'session.filter.running': 'Running',
          'session.filter.unread': 'Unread',

          'session.empty.title': 'Nothing needs attention',
          'session.empty.hint': 'Sessions that are running, waiting for you, or just finished appear here',
          'session.empty.filtered': 'No sessions in this state',

          'session.unavailable.title': 'Session status unavailable',
          'session.unavailable.hint': 'Live readings appear once the DSH session service is connected',

          'session.stop': 'Stop',
          'session.stop.running': 'Stopping',
          'session.stop.done': 'Session stopped',
          'session.stop.failed': 'Could not stop the session: {reason}',
          'session.stop.reason': 'unknown error',
          'session.open.failed': 'Could not open that session',
          'session.row.open': 'Open session: {title}',

          'session.time.now': 'just now',
          'session.time.minutes': '{count} min ago',
          'session.time.hours': '{count} h ago',
          'session.time.days': '{count} d ago',
        },
      },
    })
