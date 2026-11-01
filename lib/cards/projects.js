/**
 * Projects — the wall's answer to "which repositories do I have, what state is
 * each in, and where do I go next?".
 *
 * Read-only by design: the preview carries the three numbers a person can act on
 * (how many projects, how many have uncommitted work, how many have a live
 * session), and the expanded page lists every repository with its branch, its
 * dirty/ahead/behind reading, its last commit and one button that goes to the
 * workspace. Nothing here merges, deletes or writes.
 *
 * The host half (`lib/host/projects.js`) owns the git work; this half polls
 * `homepage/projects` every thirty seconds and renders whatever document it
 * gets. Null, a loading document and `available: false` all have a defined
 * shape, so an older host or a stopped service degrades to a reading of "—"
 * instead of taking the wall down.
 */

    var h = kit.h
    var React = kit.React
    var ICONS = kit.ICONS
    var runtime = kit.runtime
    var defineCard = kit.defineCard
    var dict = kit.dict
    var useRemote = kit.useRemote
    var pushToast = kit.pushToast
    var sidebarServices = kit.sidebarServices

    // A deep teal-green, distinct from the sessions card's brighter teal and the
    // knowledge card's orchid; it sits beside both on the wall.
    var ACCENT = '#3e7c66'

    // ---------------------------------------------------------------- drawing

    /** One 24-grid stroke mark, in the same hand as every other card's glyph. */
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
      // A folder with one commit line: the card is about checkouts, not files.
      projects: glyph([
        h('path', { key: 'a', d: 'M3.5 7.5a2 2 0 0 1 2-2h4l1.8 2h7.2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' }),
        h('path', { key: 'b', d: 'M8 12.5h8' }),
      ]),
      folder: glyph([
        h('path', { key: 'a', d: 'M3.5 7.5a2 2 0 0 1 2-2h4l1.8 2h7.2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' }),
      ]),
      branch: glyph([
        h('circle', { key: 'a', cx: '6', cy: '5.5', r: '2' }),
        h('circle', { key: 'b', cx: '6', cy: '18.5', r: '2' }),
        h('circle', { key: 'c', cx: '18', cy: '8', r: '2' }),
        h('path', { key: 'd', d: 'M6 7.5v9' }),
        h('path', { key: 'e', d: 'M18 10v1.5a4 4 0 0 1-4 4H6' }),
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

    ICONS.projects = GLYPH.projects

    // ------------------------------------------------------------------ text

    function asText(value) {
      if (value === null || value === undefined) return ''
      return String(value)
    }

    /** A count from the host: finite, non-negative, whole. */
    function countOf(value) {
      var number = Number(value)
      if (!Number.isFinite(number) || number <= 0) return 0
      return Math.floor(number)
    }

    /**
     * The last path component of a project directory. Both separators are
     * handled because the host may be on Windows while the panel renders
     * anywhere, and the recorded path uses backslashes there.
     */
    function lastSegment(value) {
      var text = asText(value).trim()
      if (text === '') return ''
      var parts = text.split(/[\\/]+/)
      var last = ''
      for (var index = 0; index < parts.length; index += 1) {
        if (parts[index] !== '') last = parts[index]
      }
      return last === '' ? text : last
    }

    /** A commit, or null when the host had no subject to show. */
    function parseCommit(value) {
      if (value === null || value === undefined || typeof value !== 'object') return null
      var at = Number(value.at)
      return {
        hash: asText(value.hash).trim(),
        at: Number.isFinite(at) && at > 0 ? at : 0,
        subject: asText(value.subject).trim(),
      }
    }

    /**
     * One git reading. `null` means "not a repository"; `{ repo: false }` means
     * git itself failed and the row can name the reason.
     */
    function parseGit(value) {
      if (value === null || value === undefined || typeof value !== 'object') return null
      if (value.repo === false) return { repo: false, error: asText(value.error).trim() }
      if (value.repo !== true) return null
      return {
        repo: true,
        branch: asText(value.branch).trim(),
        dirty: countOf(value.dirty),
        ahead: countOf(value.ahead),
        behind: countOf(value.behind),
        lastCommit: parseCommit(value.lastCommit),
        worktrees: countOf(value.worktrees),
      }
    }

    /**
     * Normalize one host project, or return null when it cannot be a project at
     * all. Pure: no React, no api, no clock.
     */
    function parseProject(value) {
      if (value === null || value === undefined || typeof value !== 'object') return null
      var id = asText(value.id).trim()
      var path = asText(value.path).trim()
      if (id === '' && path === '') return null
      var status = value.status === 'ok'
        ? 'ok'
        : value.status === 'missing-dir'
          ? 'missing-dir'
          : 'unknown'
      return {
        id: id,
        title: asText(value.title).trim() || lastSegment(path) || id,
        path: path,
        status: status,
        sessions: countOf(value.sessions),
        live: countOf(value.live),
        running: countOf(value.running),
        git: parseGit(value.git),
      }
    }

    /**
     * Turn the host document into the one shape both entry points read. The
     * order the host chose is preserved — newest project first is the host's
     * rule, not a rendering accident — and malformed rows are dropped rather
     * than rendered as blanks.
     *
     * @param data - the `homepage/projects` document, or null while loading.
     * @returns `{ available, total, dirty, live, running, worktrees, missing, projects }`.
     */
    function summarize(data) {
      var document = data !== null && typeof data === 'object' ? data : null
      var available = document !== null && document.available === true
      var projects = []
      if (available && Array.isArray(document.projects)) {
        for (var index = 0; index < document.projects.length; index += 1) {
          var project = parseProject(document.projects[index])
          if (project !== null) projects.push(project)
        }
      }

      var dirty = 0
      var live = 0
      var running = 0
      var worktrees = 0
      var missing = 0
      for (var projectIndex = 0; projectIndex < projects.length; projectIndex += 1) {
        var row = projects[projectIndex]
        live += row.live
        running += row.running
        if (row.status === 'missing-dir') missing += 1
        if (row.git !== null && row.git.repo === true) {
          if (row.git.dirty > 0) dirty += 1
          worktrees += row.git.worktrees
        }
      }

      return {
        available: available,
        total: projects.length,
        dirty: dirty,
        live: live,
        running: running,
        worktrees: worktrees,
        missing: missing,
        projects: projects,
      }
    }

    /** Relative age for a commit; a missing stamp renders nothing at all. */
    function relativeText(stamp, now, t) {
      var at = Number(stamp)
      if (!Number.isFinite(at) || at <= 0) return ''
      var delta = now - at
      if (delta < 0) delta = 0
      if (delta < 60000) return t('project.time.now')
      if (delta < 3600000) return t('project.time.minutes', { count: Math.floor(delta / 60000) })
      if (delta < 86400000) return t('project.time.hours', { count: Math.floor(delta / 3600000) })
      return t('project.time.days', { count: Math.floor(delta / 86400000) })
    }

    // ------------------------------------------------------------------ style
    //
    // The palette is the card's own `--ph-pj-*` layer, whose only literals are
    // the registered accent and the color-mix percentages. Hover rules live in
    // one pointer-capable media query and no keyframes are introduced.

    var STYLE = [
      '.ph-pj{--ph-pj-accent:' + ACCENT + ';',
      '--ph-pj-ink:var(--dsw-alias-label-primary,#1f2328);',
      '--ph-pj-ink2:var(--dsw-alias-label-secondary,#6b7280);',
      '--ph-pj-ink3:var(--dsw-alias-label-tertiary,#8b93a1);',
      '--ph-pj-line:var(--dsw-alias-border-l2,#e5e7eb);',
      '--ph-pj-line-soft:var(--dsw-alias-border-l1,#eef0f3);',
      '--ph-pj-surface:var(--dsw-alias-bg-layer-1,#fff);',
      '--ph-pj-sunken:var(--dsw-alias-bg-layer-2,#f6f7f9);',
      '--ph-pj-hover:var(--dsw-alias-interactive-bg-hover,rgba(31,35,40,.04));',
      '--ph-pj-dirty:var(--dsw-alias-state-warn-primary,#b45309);',
      '--ph-pj-live:var(--dsw-alias-state-success-primary,#15803d);',
      '--ph-pj-error:var(--dsw-alias-state-error-primary,#dc2626);',
      '--ph-pj-radius:14px;display:flex;flex-direction:column;gap:14px;min-width:0;color:var(--ph-pj-ink)}',

      // ---- wall preview: the total, two readings, one foot line
      '.ph-pj-preview{gap:10px}',
      '.ph-pj-top{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;min-width:0}',
      '.ph-pj-hero{display:flex;flex-direction:column;gap:0;flex:1 1 auto;min-width:76px}',
      '.ph-pj-hero-value{font-size:32px;line-height:34px;font-weight:600;letter-spacing:-.03em;font-variant-numeric:tabular-nums}',
      '.ph-pj-hero-label{font-size:11px;line-height:15px;color:var(--ph-pj-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ph-pj-reads{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;flex:0 1 auto;min-width:0}',
      '.ph-pj-read{--ph-pj-tone:var(--ph-pj-ink3);display:flex;flex-direction:column;gap:1px;min-width:0;padding:7px 9px 8px;border:1px solid var(--ph-pj-line-soft);border-radius:11px;background:color-mix(in srgb,var(--ph-pj-sunken) 70%,transparent)}',
      '.ph-pj-read.is-hot{--ph-pj-tone:var(--ph-pj-dirty);background:color-mix(in srgb,var(--ph-pj-tone) 9%,transparent);border-color:color-mix(in srgb,var(--ph-pj-tone) 24%,transparent)}',
      '.ph-pj-read-value{font-size:20px;line-height:23px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}',
      '.ph-pj-read-label{font-size:10px;line-height:14px;color:var(--ph-pj-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ph-pj-foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-height:16px;font-size:11px;line-height:16px;color:var(--ph-pj-ink3);font-variant-numeric:tabular-nums}',
      '.ph-pj-sep{opacity:.55}',
      '.ph-pj-flag{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;height:24px;padding:0 10px;border-radius:999px;background:color-mix(in srgb,var(--ph-pj-dirty) 12%,transparent);color:var(--ph-pj-dirty);font-size:10.5px;line-height:15px;font-weight:600;white-space:nowrap}',
      '.ph-pj-flag svg{flex:none}',

      // ---- expanded page: head, rows
      '.ph-pj-page{gap:12px}',
      '.ph-pj-head{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:0 2px}',
      '.ph-pj-head-spacer{flex:1 1 auto;min-width:8px}',
      '.ph-pj-iconbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:1px solid var(--ph-pj-line);border-radius:10px;background:var(--ph-pj-surface);color:var(--ph-pj-ink2);cursor:pointer;transition:border-color 140ms ease,color 140ms ease,background 140ms ease}',

      '.ph-pj-list{display:flex;flex-direction:column;gap:8px}',
      '.ph-pj-row{display:flex;align-items:center;gap:12px;min-width:0;padding:10px 12px;border:1px solid var(--ph-pj-line-soft);border-radius:12px;background:var(--ph-pj-surface)}',
      '.ph-pj-row.is-missing{border-color:color-mix(in srgb,var(--ph-pj-error) 26%,transparent);background:color-mix(in srgb,var(--ph-pj-error) 4%,transparent)}',
      '.ph-pj-row-main{display:flex;flex-direction:column;gap:3px;flex:1 1 auto;min-width:0}',
      '.ph-pj-row-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.ph-pj-row-title{min-width:0;font-size:13.5px;line-height:20px;font-weight:600;color:var(--ph-pj-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ph-pj-row-path{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:100%;font-size:11px;line-height:16px;color:var(--ph-pj-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ph-pj-row-path svg{flex:none}',
      '.ph-pj-row-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;font-size:11px;line-height:16px;color:var(--ph-pj-ink3)}',
      '.ph-pj-chip{display:inline-flex;align-items:center;gap:4px;height:21px;padding:0 8px;border-radius:999px;font-size:10.5px;line-height:15px;font-weight:600;white-space:nowrap;background:color-mix(in srgb,var(--ph-pj-ink3) 10%,transparent);color:var(--ph-pj-ink2)}',
      '.ph-pj-chip svg{flex:none}',
      '.ph-pj-chip.is-branch{background:color-mix(in srgb,var(--ph-pj-accent) 11%,transparent);color:var(--ph-pj-accent)}',
      '.ph-pj-chip.is-dirty{background:color-mix(in srgb,var(--ph-pj-dirty) 12%,transparent);color:var(--ph-pj-dirty)}',
      '.ph-pj-chip.is-ahead{background:color-mix(in srgb,var(--ph-pj-live) 12%,transparent);color:var(--ph-pj-live)}',
      '.ph-pj-chip.is-behind{background:color-mix(in srgb,var(--ph-pj-ink3) 14%,transparent);color:var(--ph-pj-ink2)}',
      '.ph-pj-chip.is-missing,.ph-pj-chip.is-error{background:color-mix(in srgb,var(--ph-pj-error) 12%,transparent);color:var(--ph-pj-error)}',
      '.ph-pj-commit{display:inline-flex;align-items:center;gap:7px;min-width:0;max-width:100%}',
      '.ph-pj-commit-subject{min-width:0;max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ph-pj-time{flex:none;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.ph-pj-badge{display:inline-flex;align-items:center;gap:5px;height:21px;padding:0 8px;border-radius:999px;font-size:10.5px;line-height:15px;font-weight:600;white-space:nowrap}',
      '.ph-pj-badge.is-running{background:color-mix(in srgb,var(--ph-pj-live) 12%,transparent);color:var(--ph-pj-live)}',
      '.ph-pj-badge.is-live{background:color-mix(in srgb,var(--ph-pj-accent) 11%,transparent);color:var(--ph-pj-accent)}',
      '.ph-pj-dot{width:6px;height:6px;border-radius:50%;flex:none;background:currentColor}',
      '.ph-pj-open{flex:none;display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 12px;border:1px solid var(--ph-pj-line);border-radius:9px;background:var(--ph-pj-surface);font:inherit;font-size:11.5px;line-height:16px;font-weight:600;color:var(--ph-pj-ink2);cursor:pointer;white-space:nowrap;transition:border-color 140ms ease,color 140ms ease,background 140ms ease}',
      '.ph-pj-row:focus-visible,.ph-pj-open:focus-visible,.ph-pj-iconbtn:focus-visible{outline:2px solid color-mix(in srgb,var(--ph-pj-accent) 55%,transparent);outline-offset:2px}',

      // ---- empty / unavailable / loading
      '.ph-pj-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:34px 18px;border:1px dashed var(--ph-pj-line);border-radius:14px;background:color-mix(in srgb,var(--ph-pj-sunken) 45%,transparent);text-align:center}',
      '.ph-pj-empty svg{color:var(--ph-pj-ink3);opacity:.7}',
      '.ph-pj-empty b{font-size:13px;line-height:20px;font-weight:600;color:var(--ph-pj-ink2)}',
      '.ph-pj-empty span{max-width:340px;font-size:11.5px;line-height:17px;color:var(--ph-pj-ink3)}',

      '@media (hover:hover) and (pointer:fine){',
      '.ph-pj-open:hover{border-color:var(--ph-pj-line);color:var(--ph-pj-ink);background:var(--ph-pj-hover)}',
      '.ph-pj-iconbtn:hover{border-color:var(--ph-pj-line);color:var(--ph-pj-ink);background:var(--ph-pj-hover)}',
      '}',

      '@media (max-width:760px){',
      '.ph-pj-reads{grid-template-columns:1fr}',
      '.ph-pj-row{flex-wrap:wrap}',
      '.ph-pj-row-main{flex-basis:100%}',
      '.ph-pj-open{width:100%}',
      '}',

      '@media (prefers-reduced-motion:reduce){.ph-pj *{transition:none!important;animation:none!important}}',
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

    function reading(label, value, hot) {
      return h('div', { className: 'ph-pj-read' + (hot ? ' is-hot' : '') },
        h('span', { className: 'ph-pj-read-value' }, value),
        h('span', { className: 'ph-pj-read-label' }, label))
    }

    /**
     * The reading: the project total, the two counts a person can act on, and
     * one foot line. No controls: everything the card can do lives in the
     * expanded page, because a wall full of buttons reads as a settings page.
     */
    function ProjectsCard(props) {
      ensureStyles()
      var t = props.t
      var remote = useRemote('homepage/projects', { options: {} }, { refreshMs: 30000 })
      var data = remote ? remote.data : null
      var summary = summarize(data)
      var loading = data === null || data === undefined
      var unknown = loading || !summary.available
      var value = unknown ? '—' : String(summary.total)

      var foot = null
      if (loading) {
        foot = null
      } else if (!summary.available) {
        foot = h('div', { className: 'ph-pj-flag' }, GLYPH.alert(12), h('span', null, t('project.unavailable.title')))
      } else if (summary.total === 0) {
        foot = h('div', { className: 'ph-pj-foot' }, h('span', null, t('project.preview.none')))
      } else {
        var parts = []
        if (summary.worktrees > 0) {
          parts.push(h('span', { key: 'worktrees' }, t('project.preview.worktrees', { count: summary.worktrees })))
        }
        if (summary.missing > 0) {
          if (parts.length > 0) parts.push(h('span', { key: 'sep', className: 'ph-pj-sep' }, '·'))
          parts.push(h('span', { key: 'missing' }, t('project.preview.missing', { count: summary.missing })))
        }
        foot = h('div', { className: 'ph-pj-foot' }, parts)
      }

      return h('div', { className: 'ph-pj ph-pj-preview' },
        h('div', { className: 'ph-pj-top' },
          h('div', { className: 'ph-pj-hero' },
            h('span', { className: 'ph-pj-hero-value' }, value),
            h('span', { className: 'ph-pj-hero-label' }, t('project.preview.total'))),
          h('div', { className: 'ph-pj-reads', role: 'group', 'aria-label': t('project.preview.readings') },
            reading(t('project.preview.dirty'), unknown ? '—' : String(summary.dirty),
              !unknown && summary.dirty > 0),
            reading(t('project.preview.live'), unknown ? '—' : String(summary.live),
              !unknown && summary.live > 0))),
        foot)
    }

    // =========================================================== expanded page

    function emptyState(glyphNode, title, hint) {
      return h('div', { className: 'ph-pj-empty' },
        glyphNode,
        h('b', null, title),
        h('span', null, hint))
    }

    /**
     * Go to one workspace. The api may or may not have grown `openWorkspace`
     * (the plugin wires it after the card ships), so the sidebar service is the
     * fallback and a toast is the last resort. Nothing here throws out of a
     * click handler.
     */
    function openProject(api, project, t) {
      var id = project && project.id !== undefined && project.id !== null ? String(project.id) : ''
      var fail = function () { pushToast(t('project.open.failed'), 'error') }
      if (id === '') {
        fail()
        return
      }
      try {
        if (api && typeof api.openWorkspace === 'function') {
          if (api.openWorkspace(id) === false) fail()
          return
        }
        var ui = sidebarServices && sidebarServices.uiWorkspace
        if (ui && typeof ui.openWorkspace === 'function') {
          var pending = ui.openWorkspace(id)
          if (pending === false) fail()
          else if (pending && typeof pending.catch === 'function') pending.catch(fail)
          return
        }
        fail()
      } catch (error) {
        fail()
      }
    }

    /** One project row. The row is not a button: only "open" is clickable. */
    function ProjectRow(props) {
      var project = props.project
      var t = props.t
      var git = project.git
      var repo = git !== null && git.repo === true
      var chips = []

      if (project.status === 'missing-dir') {
        chips.push(h('span', { key: 'missing', className: 'ph-pj-chip is-missing' },
          GLYPH.alert(11), t('project.status.missing')))
      } else if (project.status === 'unknown') {
        chips.push(h('span', { key: 'status', className: 'ph-pj-chip is-plain' }, t('project.status.unknown')))
      }

      if (git === null) {
        chips.push(h('span', { key: 'plain', className: 'ph-pj-chip is-plain' }, t('project.git.none')))
      } else if (!repo) {
        chips.push(h('span', { key: 'error', className: 'ph-pj-chip is-error', title: git.error }, t('project.git.error')))
      } else {
        if (git.branch !== '') {
          chips.push(h('span', { key: 'branch', className: 'ph-pj-chip is-branch' },
            GLYPH.branch(11), git.branch))
        }
        if (git.dirty > 0) {
          chips.push(h('span', { key: 'dirty', className: 'ph-pj-chip is-dirty' },
            t('project.git.dirty', { count: git.dirty })))
        }
        if (git.ahead > 0) {
          chips.push(h('span', { key: 'ahead', className: 'ph-pj-chip is-ahead' },
            t('project.git.ahead', { count: git.ahead })))
        }
        if (git.behind > 0) {
          chips.push(h('span', { key: 'behind', className: 'ph-pj-chip is-behind' },
            t('project.git.behind', { count: git.behind })))
        }
        if (git.worktrees > 1) {
          chips.push(h('span', { key: 'worktrees', className: 'ph-pj-chip is-plain' },
            t('project.git.worktrees', { count: git.worktrees })))
        }
      }

      var commit = null
      if (repo && git.lastCommit !== null) {
        commit = h('span', { className: 'ph-pj-commit', title: git.lastCommit.hash },
          h('span', { className: 'ph-pj-commit-subject' }, git.lastCommit.subject),
          git.lastCommit.at > 0
            ? h('span', { className: 'ph-pj-time' }, relativeText(git.lastCommit.at, props.now, t))
            : null)
      } else if (repo) {
        commit = h('span', { className: 'ph-pj-commit' },
          h('span', { className: 'ph-pj-commit-subject' }, t('project.git.noCommit')))
      }

      var badge = null
      if (project.running > 0) {
        badge = h('span', { className: 'ph-pj-badge is-running' },
          h('i', { className: 'ph-pj-dot' }), t('project.badge.running', { count: project.running }))
      } else if (project.live > 0) {
        badge = h('span', { className: 'ph-pj-badge is-live' },
          h('i', { className: 'ph-pj-dot' }), t('project.badge.live', { count: project.live }))
      }

      var openHint = t('project.open.hint', { title: project.title })
      // The folder name usually repeats the project title; print it only when it
      // says something the title does not. The full path stays on the row title.
      var pathLabel = lastSegment(project.path) || project.path || project.id
      return h('div', {
        className: 'ph-pj-row' + (project.status === 'missing-dir' ? ' is-missing' : ''),
        role: 'listitem',
        'data-project-id': project.id,
        title: project.path,
      },
        h('div', { className: 'ph-pj-row-main' },
          h('div', { className: 'ph-pj-row-top' },
            h('span', { className: 'ph-pj-row-title' }, project.title),
            badge),
          h('div', { className: 'ph-pj-row-meta' },
            pathLabel !== project.title ? h('span', { className: 'ph-pj-row-path' },
              GLYPH.folder(12),
              pathLabel) : null,
            chips,
            commit)),
        h('button', {
          type: 'button',
          className: 'ph-pj-open',
          title: openHint,
          'aria-label': openHint,
          onClick: function () { props.onOpen(project) },
        }, t('project.open')))
    }

    /**
     * The expanded page: the same readings and one row per project, with one
     * refresh button. The row order is the host's.
     */
    function ProjectsDetail(props) {
      ensureStyles()
      var api = props.api
      var t = props.t
      var remote = useRemote('homepage/projects', { options: {} }, { refreshMs: 30000 })
      var data = remote ? remote.data : null
      var summary = summarize(data)
      var loading = data === null || data === undefined
      var unavailable = !loading && !summary.available
      var now = Date.now()

      function refresh() {
        if (!remote || typeof remote.reload !== 'function') return
        try {
          var pending = remote.reload(true)
          if (pending && typeof pending.catch === 'function') pending.catch(function () { void 0 })
        } catch (error) {
          void error
        }
      }

      function open(project) {
        openProject(api, project, t)
      }

      var body = null
      if (loading) {
        body = emptyState(GLYPH.projects(22), t('project.loading.title'), t('project.loading.hint'))
      } else if (unavailable) {
        body = emptyState(GLYPH.alert(22), t('project.unavailable.title'), t('project.unavailable.hint'))
      } else if (summary.total === 0) {
        body = emptyState(GLYPH.projects(22), t('project.empty.title'), t('project.empty.hint'))
      } else {
        body = h('div', { className: 'ph-pj-list', role: 'list' },
          summary.projects.map(function (project) {
            return h(ProjectRow, {
              key: project.id !== '' ? project.id : project.path,
              project: project,
              t: t,
              now: now,
              onOpen: open,
            })
          }))
      }

      return h('div', { className: 'ph-pj ph-pj-page' },
        h('div', { className: 'ph-pj-head' },
          h('span', { className: 'ph-pj-head-spacer' }),
          h('button', {
            type: 'button',
            className: 'ph-pj-iconbtn',
            title: t('project.page.refreshHint'),
            'aria-label': t('project.page.refresh'),
            onClick: refresh,
          }, GLYPH.refresh(15))),
        body)
    }

    // ----------------------------------------------------------- registration

    defineCard({
      id: 'projects',
      title: function () { return runtime.t('project.title') },
      icon: function (size) { return ICONS.projects(size) },
      accent: ACCENT,
      // Between the sessions reading and the calendar: a project's state is the
      // context for the sessions that run against it.
      order: 17,
      texture: { icon: 'projects', opacity: 5, size: 118, bleed: '-16%' },
      size: { w: 2, h: 1 },
      minSize: { w: 1, h: 1 },
      maxSize: { w: 4, h: 3 },
      tags: ['project', 'git', 'workspace'],
      shipped: true,
      content: function (api) { return h(ProjectsCard, { api: api, t: runtime.t }) },
      detail: function (api) { return h(ProjectsDetail, { api: api, t: runtime.t }) },
      // Exposed so the card's own test can drive the normalizer without a
      // render, and so a future host path can reuse the one reading rule.
      summarize: summarize,
      parseProject: parseProject,
      dict: {
        zh: {
          'project.title': '项目',

          'project.preview.total': '项目',
          'project.preview.readings': '项目读数',
          'project.preview.dirty': '有改动',
          'project.preview.live': '活跃会话',
          'project.preview.none': '还没有项目',
          'project.preview.worktrees': '{count} 个额外工作树',
          'project.preview.missing': '{count} 个目录缺失',

          'project.unavailable.title': '项目服务未接入',
          'project.unavailable.hint': 'DSH 工作区接入后会显示仓库读数',

          'project.page.refresh': '刷新',
          'project.page.refreshHint': '重新读取项目状态',

          'project.empty.title': '还没有项目',
          'project.empty.hint': 'DSH 工作区注册表里的仓库会出现在这里',
          'project.loading.title': '正在读取项目…',
          'project.loading.hint': '正在向工作区注册表和 git 查询状态',

          'project.status.missing': '目录缺失',
          'project.status.unknown': '状态未知',

          'project.git.none': '非 git 仓库',
          'project.git.error': 'git 读取失败',
          'project.git.noCommit': '还没有提交',
          'project.git.dirty': '{count} 处改动',
          'project.git.ahead': '领先 {count}',
          'project.git.behind': '落后 {count}',
          'project.git.worktrees': '{count} 个额外工作树',

          'project.badge.running': '{count} 个会话运行中',
          'project.badge.live': '{count} 个活跃会话',

          'project.open': '打开',
          'project.open.hint': '打开工作区：{title}',
          'project.open.failed': '无法打开该工作区',

          'project.time.now': '刚刚',
          'project.time.minutes': '{count} 分钟前',
          'project.time.hours': '{count} 小时前',
          'project.time.days': '{count} 天前',
        },
        en: {
          'project.title': 'Projects',

          'project.preview.total': 'Projects',
          'project.preview.readings': 'Project readings',
          'project.preview.dirty': 'Dirty',
          'project.preview.live': 'Live sessions',
          'project.preview.none': 'No projects yet',
          'project.preview.worktrees': '{count} extra worktrees',
          'project.preview.missing': '{count} missing folders',

          'project.unavailable.title': 'Project service not connected',
          'project.unavailable.hint': 'Repository readings appear once DSH workspaces are connected',

          'project.page.refresh': 'Refresh',
          'project.page.refreshHint': 'Re-read the project status',

          'project.empty.title': 'No projects yet',
          'project.empty.hint': 'Repositories in the DSH workspace registry appear here',
          'project.loading.title': 'Reading projects…',
          'project.loading.hint': 'Asking the workspace registry and git for their state',

          'project.status.missing': 'Folder missing',
          'project.status.unknown': 'Status unknown',

          'project.git.none': 'Not a git repository',
          'project.git.error': 'Git read failed',
          'project.git.noCommit': 'No commits yet',
          'project.git.dirty': '{count} changed',
          'project.git.ahead': '{count} ahead',
          'project.git.behind': '{count} behind',
          'project.git.worktrees': '{count} extra worktrees',

          'project.badge.running': '{count} sessions running',
          'project.badge.live': '{count} live sessions',

          'project.open': 'Open',
          'project.open.hint': 'Open workspace: {title}',
          'project.open.failed': 'Could not open that workspace',

          'project.time.now': 'just now',
          'project.time.minutes': '{count} min ago',
          'project.time.hours': '{count} h ago',
          'project.time.days': '{count} d ago',
        },
      },
    })
