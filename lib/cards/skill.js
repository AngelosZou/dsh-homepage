/**
 * Card module: Skills — how many are installed locally, and the place to
 * browse, search, switch and discover them.
 *
 * Two panes behind one navigation bar, because they answer two different
 * questions with two different weights:
 *
 *  - **本地 / Installed** — the Skills this machine already has. It reads like a
 *    settings list: dense rows, one line of truth each, and the switch that
 *    matters on the right. What is on is quiet; what is off is greyed out.
 *  - **发现 / Discover** — external, community, general-Skill-format sources
 *    (ClawHub first). It reads like a storefront: one big search field, source
 *    chips, and cards with room to breathe. Nothing here is installed until the
 *    user says so.
 *
 * The visual language is the card's own (`.ph-sk-` prefixed, injected through
 * `runtime.insertCss`), so the wall's existing material is untouched: hierarchy
 * comes from one accent, one type scale and a lot of space, not from more
 * content per square centimetre.
 *
 * Spliced into the client factory by scripts/build-client.mjs, inside
 * `(function (kit) { ... })(Kit)`, so this file may assume `kit` is in scope.
 * It defines and registers itself — adding a card is adding this file.
 *
 * @module dsh-homepage/cards/skill
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
    var remoteCall = kit.remoteCall
    var publishReloader = kit.publishReloader
    var pushToast = kit.pushToast

    var LIST = 'homepage/skillList'
    var SET_ENABLED = 'homepage/skillSetEnabled'
    var CONTENT = 'homepage/skillContent'
    var SOURCES = 'homepage/skillSources'
    var SEARCH = 'homepage/skillSearch'
    var INSTALL = 'homepage/skillInstall'

    // One control value every acting surface writes and every reading surface
    // watches. Flipping a switch in the expanded page has to reach the wall's
    // preview, and the wall's preview is a different component instance with its
    // own `useRemote` — a value on the card's control record is the one piece of
    // state both of them can see.
    var SIGNAL = 'skillSignal'

    // Turning a skill off is a frontmatter edit on the local file, so the two
    // failure modes worth naming are "this file is not ours to edit" and "the
    // write did not land". Everything else is the host's own sentence.
    var SOURCE_KEYS = {
      'project-dsh': 'skill.source.projectDsh',
      'project-agents': 'skill.source.projectAgents',
      custom: 'skill.source.custom',
      'user-dsh': 'skill.source.userDsh',
      'user-agents': 'skill.source.userAgents',
      bundled: 'skill.source.bundled',
    }

    // The three shapes a skill can be in, worst-to-best is not the order: the
    // order is how many eyes see it, so the meter reads as a scale.
    var STATES = [
      { id: 'enabled', tone: 'ok', label: 'skill.state.enabled' },
      { id: 'userOnly', tone: 'warn', label: 'skill.state.userOnly' },
      { id: 'disabled', tone: null, label: 'skill.state.disabled' },
    ]

    // ------------------------------------------------------------- glyphs
    //
    // `kit.ICONS` has no magnifier-with-a-tray or an external-link mark, and a
    // card's glyphs belong to the card. Same 24 grid, same 1.8 stroke, same
    // `currentColor` as the framework's own set, so they read as one family.

    /** @returns one stroke-only svg on the framework's 24 grid. */
    function glyph(size, children) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size || 16,
        height: size || 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, children)
    }

    var GLYPH = {
      search: function (size) { return glyph(size, [h('circle', { key: 'c', cx: 11, cy: 11, r: 6.8 }), h('path', { key: 'p', d: 'M16.1 16.1 20.8 20.8' })]) },
      close: function (size) { return glyph(size, h('path', { d: 'M6.6 6.6l10.8 10.8M17.4 6.6 6.6 17.4' })) },
      download: function (size) { return glyph(size, [h('path', { key: 'a', d: 'M12 4.2v10.4' }), h('path', { key: 'b', d: 'M7.8 10.4 12 14.6l4.2-4.2' }), h('path', { key: 'c', d: 'M4.8 19.4h14.4' })]) },
      external: function (size) { return glyph(size, [h('path', { key: 'a', d: 'M14.4 4.6h5v5' }), h('path', { key: 'b', d: 'M19.4 4.6 11 13' }), h('path', { key: 'c', d: 'M18.6 14.2v4.4a1 1 0 0 1-1 1H5.6a1 1 0 0 1-1-1V6.6a1 1 0 0 1 1-1h4.4' })]) },
      check: function (size) { return glyph(size, h('path', { d: 'M5 12.6 9.6 17 19 6.8' })) },
      dot: function (size) { return glyph(size, h('circle', { cx: 12, cy: 12, r: 4.2 })) },
      eye: function (size) { return glyph(size, [h('path', { key: 'a', d: 'M2.8 12S6.4 5.8 12 5.8 21.2 12 21.2 12 17.6 18.2 12 18.2 2.8 12 2.8 12Z' }), h('circle', { key: 'b', cx: 12, cy: 12, r: 2.8 })]) },
      slash: function (size) { return glyph(size, [h('circle', { key: 'a', cx: 12, cy: 12, r: 8.2, opacity: 0.45 }), h('path', { key: 'b', d: 'M6.6 17.4 17.4 6.6' })]) },
      spark: function (size) { return glyph(size, h('path', { d: 'M12 3.6l1.9 5.3 5.3 1.9-5.3 1.9-1.9 5.3-1.9-5.3L4.8 10.8l5.3-1.9L12 3.6Z' })) },
      globe: function (size) { return glyph(size, [h('circle', { key: 'a', cx: 12, cy: 12, r: 8.2 }), h('path', { key: 'b', d: 'M3.9 12h16.2' }), h('path', { key: 'c', d: 'M12 3.8c2.4 2.5 2.4 13.9 0 16.4-2.4-2.5-2.4-13.9 0-16.4Z' })]) },
      folder: function (size) { return glyph(size, h('path', { d: 'M3.8 7.4a2 2 0 0 1 2-2h3.4l1.9 2.5h7.1a2 2 0 0 1 2 2v8.4a2 2 0 0 1-2 2H5.8a2 2 0 0 1-2-2V7.4Z' })) },
      back: function (size) { return glyph(size, [h('path', { key: 'a', d: 'M19.4 12H5.2' }), h('path', { key: 'b', d: 'M11 5.8 4.8 12l6.2 6.2' })]) },
      doc: function (size) { return glyph(size, [h('path', { key: 'a', d: 'M6.2 3.8h7.6l4 4v12.4H6.2z' }), h('path', { key: 'b', d: 'M13.4 3.8v4.2h4.2' }), h('path', { key: 'c', d: 'M9 12h6M9 15.2h6' })]) },
    }

    ICONS.skill = function (size) {
      return glyph(size, [
        h('path', { key: 'a', d: 'M4 5.6h6.4v12.8H4z' }),
        h('path', { key: 'b', d: 'M13.6 5.6H20v12.8h-6.4z' }),
        h('path', { key: 'c', d: 'M6.6 9.2h1.2M6.6 12h1.2M16.2 9.2h1.2M16.2 12h1.2' }),
      ])
    }

    // -------------------------------------------------------------- helpers

    /** @returns a possibly-thunk value as text, or ''. */
    function textOf(value) {
      var text = kit.textOf(value)
      return text === undefined || text === null ? '' : String(text)
    }

    /** @returns the locale text for a dictionary key. */
    function t(key, params) { return runtime.t(key, params) }

    /** @returns a Skill's state id: `enabled` | `userOnly` | `disabled`. */
    function stateOf(skill) {
      if (skill && skill.modelInvocable === true) return 'enabled'
      if (skill && skill.userInvocable === true) return 'userOnly'
      return 'disabled'
    }

    /** @returns the chip tone for a state, or null for the neutral one. */
    function stateTone(state) {
      for (var index = 0; index < STATES.length; index++) {
        if (STATES[index].id === state) return STATES[index].tone
      }
      return null
    }

    /** @returns the source label for one skill or root. */
    function sourceText(source) {
      return SOURCE_KEYS[source] ? t(SOURCE_KEYS[source]) : (source ? String(source) : '')
    }

    /** @returns `counts` with every field present, whatever the host sent. */
    function countsOf(data) {
      var counts = (data && data.counts) || {}
      return {
        total: Number(counts.total) || 0,
        enabled: Number(counts.enabled) || 0,
        userOnly: Number(counts.userOnly) || 0,
        disabled: Number(counts.disabled) || 0,
        writable: Number(counts.writable) || 0,
        invalid: Number(counts.invalid) || 0,
      }
    }

    /** @returns a byte count as a short human string. */
    function bytesText(value) {
      var units = ['B', 'KB', 'MB']
      var count = Number(value) || 0
      var index = 0
      while (count >= 1024 && index < units.length - 1) { count = count / 1024; index += 1 }
      return (index === 0 ? String(Math.round(count)) : count.toFixed(1)) + ' ' + units[index]
    }

    /** @returns the wall-clock text for a millisecond stamp, or null. */
    function dateText(value) {
      var at = Number(value)
      if (!Number.isFinite(at) || at <= 0) return null
      try { return new Date(at).toLocaleDateString() } catch (error) { return null }
    }

    /** @returns whether a search hit is already installed under that name. */
    function installedName(names, result) {
      var wanted = String((result && result.name) || '').toLowerCase()
      if (wanted === '') return false
      for (var index = 0; index < names.length; index++) {
        if (String(names[index]).toLowerCase() === wanted) return true
      }
      return false
    }

    /** @returns a matched range in `haystack`, or null — case-insensitive substring. */
    function matches(haystack, needle) {
      if (needle === '') return true
      return String(haystack || '').toLowerCase().indexOf(needle.toLowerCase()) >= 0
    }

    /** @returns the visible list for a query and a state filter. */
    function filterSkills(skills, query, filter) {
      var needle = String(query || '').trim()
      var out = []
      for (var index = 0; index < skills.length; index++) {
        var skill = skills[index]
        if (filter && filter !== 'all' && stateOf(skill) !== filter) continue
        if (needle !== '' && !matches(skill.name, needle)
          && !matches(skill.description, needle)
          && !matches(skill.whenToUse, needle)) continue
        out.push(skill)
      }
      return out
    }

    // --------------------------------------------------------------- styles
    //
    // Everything the expanded page needs beyond the wall's own material. It is
    // registered once, under the card's own prefix, and the page's rules are
    // scoped to `.ph-sk` so nothing here can reach a neighbour card.
    //
    // The palette is the host's: every colour resolves through a `--dsw-alias-*`
    // token with a light-mode literal as the fallback, which is what keeps the
    // page legible in a theme this card has never seen. The card's own identity
    // is one accent (`--ph-sk-accent`), used for the title mark, the selected
    // tab, the "on" switch and the installed count — never for large fills.

    var STYLE = [
      '.ph-sk{--ph-sk-accent:var(--dsw-alias-brand-primary,#4f6ef7);',
      '--ph-sk-ink:var(--dsw-alias-label-primary,#1f2328);',
      '--ph-sk-ink2:var(--dsw-alias-label-secondary,#6b7280);',
      '--ph-sk-ink3:var(--dsw-alias-label-tertiary,#8b93a1);',
      '--ph-sk-line:var(--dsw-alias-border-l2,#e5e7eb);',
      '--ph-sk-line-soft:var(--dsw-alias-border-l1,#eef0f3);',
      '--ph-sk-surface:var(--dsw-alias-bg-layer-1,#fff);',
      '--ph-sk-sunken:var(--dsw-alias-bg-layer-2,#f6f7f9);',
      '--ph-sk-hover:var(--dsw-alias-interactive-bg-hover,rgba(31,35,40,.04));',
      '--ph-sk-radius:12px;display:flex;flex-direction:column;gap:16px;min-width:0;color:var(--ph-sk-ink)}',

      // ---- navigation bar: the page's first element, because the expanded
      // pane header already names the card

      '.ph-sk-nav{display:flex;align-items:flex-end;gap:2px;border-bottom:1px solid var(--ph-sk-line)}',
      '.ph-sk-tab{display:inline-flex;align-items:center;gap:7px;border:0;background:none;font:inherit;font-size:13.5px;line-height:20px;color:var(--ph-sk-ink2);padding:9px 14px 10px;margin-bottom:-1px;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;transition:color 140ms ease,border-color 140ms ease}',
      '.ph-sk-tab:hover{color:var(--ph-sk-ink)}',
      '.ph-sk-tab.is-on{color:var(--ph-sk-accent);border-bottom-color:var(--ph-sk-accent);font-weight:600}',
      '.ph-sk-tab svg{opacity:.9}',
      '.ph-sk-tab-count{font-size:11px;line-height:16px;padding:0 6px;border-radius:99px;background:var(--ph-sk-sunken);color:var(--ph-sk-ink2);font-variant-numeric:tabular-nums}',
      '.ph-sk-tab.is-on .ph-sk-tab-count{background:color-mix(in srgb,var(--ph-sk-accent) 14%,transparent);color:var(--ph-sk-accent)}',
      '.ph-sk-nav-spacer{flex:1 1 auto;min-width:8px}',

      // ---- controls
      '.ph-sk-field{display:flex;align-items:center;gap:8px;padding:0 12px;height:38px;border:1px solid var(--ph-sk-line);border-radius:10px;background:var(--ph-sk-surface);transition:border-color 140ms ease,box-shadow 140ms ease}',
      '.ph-sk-field:focus-within{border-color:var(--ph-sk-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--ph-sk-accent) 16%,transparent)}',
      '.ph-sk-field svg{flex:none;color:var(--ph-sk-ink3)}',
      '.ph-sk-input{flex:1 1 auto;min-width:0;border:0;background:none;font:inherit;font-size:13.5px;line-height:20px;color:var(--ph-sk-ink);outline:none}',
      '.ph-sk-input::placeholder{color:var(--ph-sk-ink3)}',
      '.ph-sk-clear{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:50%;background:none;color:var(--ph-sk-ink3);cursor:pointer}',
      '.ph-sk-clear:hover{background:var(--ph-sk-hover);color:var(--ph-sk-ink)}',
      '.ph-sk-btn{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 12px;border:1px solid var(--ph-sk-line);border-radius:9px;background:var(--ph-sk-surface);font:inherit;font-size:12.5px;line-height:18px;color:var(--ph-sk-ink2);cursor:pointer;white-space:nowrap;transition:border-color 140ms ease,color 140ms ease,background 140ms ease}',
      '.ph-sk-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,#d9dde3);color:var(--ph-sk-ink)}',
      '.ph-sk-btn:disabled{opacity:.5;cursor:default}',
      '.ph-sk-btn.is-solid{border-color:transparent;background:var(--ph-sk-accent);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:600}',
      '.ph-sk-btn.is-solid:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--ph-sk-accent));color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.ph-sk-btn.is-quiet{border-color:transparent;background:none}',
      '.ph-sk-pills{display:flex;flex-wrap:wrap;gap:6px}',
      '.ph-sk-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border:1px solid var(--ph-sk-line);border-radius:99px;background:var(--ph-sk-surface);font-size:11.5px;line-height:16px;color:var(--ph-sk-ink2);cursor:pointer;transition:border-color 140ms ease,background 140ms ease,color 140ms ease}',
      '.ph-sk-pill:hover{border-color:var(--dsw-alias-border-l3,#d9dde3);color:var(--ph-sk-ink)}',
      '.ph-sk-pill.is-on{border-color:color-mix(in srgb,var(--ph-sk-accent) 42%,transparent);background:color-mix(in srgb,var(--ph-sk-accent) 10%,transparent);color:var(--ph-sk-accent);font-weight:600}',
      '.ph-sk-pill b{font-weight:600;font-variant-numeric:tabular-nums;opacity:.8}',

      // ---- tool row under the tabs
      '.ph-sk-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.ph-sk-tools .ph-sk-field{flex:1 1 220px;min-width:180px}',
      '.ph-sk-count{font-size:11.5px;line-height:18px;color:var(--ph-sk-ink3);font-variant-numeric:tabular-nums;white-space:nowrap}',

      // ---- the installed list
      '.ph-sk-list{display:flex;flex-direction:column;border:1px solid var(--ph-sk-line);border-radius:var(--ph-sk-radius);background:var(--ph-sk-surface);overflow:hidden}',
      '.ph-sk-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:13px 16px;border-top:1px solid var(--ph-sk-line-soft)}',
      '.ph-sk-row:first-child{border-top:0}',
      '.ph-sk-row:hover{background:var(--ph-sk-hover)}',
      '.ph-sk-row.is-off .ph-sk-name{color:var(--ph-sk-ink2)}',
      '.ph-sk-row.is-off .ph-sk-desc{opacity:.72}',
      '.ph-sk-row.is-busy{opacity:.62}',
      '.ph-sk-main{min-width:0;display:flex;flex-direction:column;gap:3px}',
      '.ph-sk-name-row{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}',
      // The name is a button, so it has to lose every default a button brings
      // and gain the affordance back on hover — it is the way into the content.
      '.ph-sk-name{padding:0;border:0;background:none;font-family:inherit;font-size:13.5px;line-height:20px;font-weight:600;color:inherit;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.ph-sk-name:hover{color:var(--ph-sk-accent);text-decoration:underline;text-underline-offset:3px}',
      '.ph-sk-name:focus-visible{outline:2px solid var(--ph-sk-accent);outline-offset:2px;border-radius:4px}',
      '.ph-sk-src{font-size:10.5px;line-height:15px;padding:1px 6px;border-radius:5px;background:var(--ph-sk-sunken);color:var(--ph-sk-ink3);white-space:nowrap}',
      '.ph-sk-desc{margin:0;font-size:12px;line-height:18px;color:var(--ph-sk-ink3);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.ph-sk-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--ph-sk-ink3);min-width:0}',
      '.ph-sk-meta code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:42ch}',
      '.ph-sk-flag{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-state-warn-primary,#b45309);font-weight:600}',
      '.ph-sk-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}',
      // The mode switcher is the framework's `ComboButton`: a labelled pill whose
      // menu opens in the panel's fixed popover layer, so it can never be clipped
      // by the expanding body's own scroller.
      '.ph-sk-mode{display:inline-flex;align-items:center}',
      '.ph-sk-mode .ph-combo-main,.ph-sk-mode .ph-combo-caret{height:26px;background:var(--ph-sk-surface);color:var(--ph-sk-ink)}',
      '.ph-sk-mode .ph-combo-main{padding:0 4px 0 10px;font:inherit;font-size:12px;line-height:24px}',
      '.ph-sk-mode .ph-combo-caret{width:24px}',
      '.ph-sk-mode .ph-combo-main:disabled,.ph-sk-mode .ph-combo-caret:disabled{opacity:.45;cursor:not-allowed}',

      // ---- one skill's content

      '.ph-sk-doc{display:flex;flex-direction:column;gap:12px;flex:1;min-height:0}',
      '.ph-sk-doc-bar{display:flex;align-items:center;gap:8px}',
      '.ph-sk-doc-body{display:flex;flex-direction:column;gap:12px;flex:1;min-height:0;overflow:auto;padding-right:2px}',
      '.ph-sk-doc-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ph-sk-doc-name{margin:0;font-size:15px;line-height:22px;font-weight:650;color:var(--ph-sk-ink)}',
      '.ph-sk-doc-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--ph-sk-ink3)}',
      '.ph-sk-doc-meta code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;overflow-wrap:anywhere}',
      '.ph-sk-doc-facts{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--ph-sk-line);border-radius:10px;background:var(--ph-sk-sunken)}',
      '.ph-sk-doc-fact{display:grid;grid-template-columns:minmax(88px,120px) 1fr;gap:10px;font-size:11.5px;line-height:17px}',
      '.ph-sk-doc-key{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--ph-sk-ink3);overflow-wrap:anywhere}',
      '.ph-sk-doc-value{color:var(--ph-sk-ink2);overflow-wrap:anywhere}',
      '.ph-sk-doc-files{display:flex;flex-direction:column;gap:6px}',
      '.ph-sk-doc-facts-title{font-size:11px;line-height:16px;font-weight:600;letter-spacing:.02em;color:var(--ph-sk-ink3)}',
      '.ph-sk-doc-filelist{display:flex;flex-wrap:wrap;gap:6px}',
      '.ph-sk-doc-file{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border:1px solid var(--ph-sk-line);border-radius:7px;background:var(--ph-sk-surface);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;line-height:16px;color:var(--ph-sk-ink2)}',
      // The body is shown exactly as written: a Skill is instructions for a
      // model, and re-typesetting it would show the reader something the model
      // never sees. `pre-wrap` keeps the source's own line breaks and indentation.
      '.ph-sk-doc-text{margin:0;padding:12px 14px;border:1px solid var(--ph-sk-line);border-radius:10px;background:var(--ph-sk-sunken);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:18px;color:var(--ph-sk-ink2);white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}',
      '.ph-sk-note{margin:0;font-size:11px;line-height:16px;color:var(--ph-sk-ink3)}',

      // ---- switches and status marks
      '.ph-sk-switch{position:relative;flex:none;width:42px;height:24px;padding:0;border:1px solid var(--ph-sk-line);border-radius:99px;background:var(--ph-sk-sunken);cursor:pointer;transition:background 160ms ease,border-color 160ms ease}',
      '.ph-sk-switch:disabled{opacity:.45;cursor:not-allowed}',
      '.ph-sk-switch.is-on{background:var(--ph-sk-accent);border-color:transparent}',
      '.ph-sk-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);box-shadow:0 1px 2px rgba(15,20,30,.22);transition:transform 160ms cubic-bezier(.16,1,.3,1)}',
      '.ph-sk-switch.is-on .ph-sk-knob{transform:translateX(18px)}',
      '.ph-sk-chip{display:inline-flex;align-items:center;gap:5px;height:21px;padding:0 8px;border-radius:99px;font-size:10.5px;line-height:15px;font-weight:600;white-space:nowrap;background:var(--ph-sk-sunken);color:var(--ph-sk-ink2)}',
      '.ph-sk-chip.is-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 13%,transparent);color:var(--dsw-alias-state-success-primary,#15803d)}',
      '.ph-sk-chip.is-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 14%,transparent);color:var(--dsw-alias-state-warn-primary,#b45309)}',
      '.ph-sk-chip.is-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 13%,transparent);color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.ph-sk-chip.is-quiet{background:var(--ph-sk-sunken);color:var(--ph-sk-ink3);font-weight:500}',

      // ---- empty / loading / error states
      '.ph-sk-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:34px 16px;border:1px dashed var(--ph-sk-line);border-radius:var(--ph-sk-radius);color:var(--ph-sk-ink3);text-align:center}',
      '.ph-sk-empty svg{color:var(--ph-sk-ink3);opacity:.75}',
      '.ph-sk-empty b{font-size:13.5px;line-height:20px;font-weight:600;color:var(--ph-sk-ink2)}',
      '.ph-sk-empty span{font-size:12px;line-height:18px;max-width:46ch}',
      '.ph-sk-error{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 10%,transparent);color:var(--dsw-alias-state-error-primary,#dc2626);font-size:12px;line-height:18px}',
      '.ph-sk-note{margin:0;font-size:11.5px;line-height:18px;color:var(--ph-sk-ink3)}',
      '.ph-sk-warn{display:flex;align-items:center;gap:6px;margin:0;font-size:11.5px;line-height:18px;color:var(--dsw-alias-state-warn-primary,#b45309)}',

      // ---- the discover pane: fewer things, more room
      '.ph-sk-hero{display:flex;flex-direction:column;gap:10px;padding:18px 18px 16px;border:1px solid var(--ph-sk-line);border-radius:16px;background:var(--ph-sk-surface)}',
      '.ph-sk-hero-title{margin:0;font-size:15px;line-height:22px;font-weight:600}',
      '.ph-sk-hero-sub{margin:0;font-size:12px;line-height:18px;color:var(--ph-sk-ink3)}',
      '.ph-sk-hero .ph-sk-field{height:44px;border-radius:12px}',
      '.ph-sk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(248px,1fr));gap:12px;align-items:start}',
      '.ph-sk-hit{display:flex;flex-direction:column;gap:9px;padding:14px;border:1px solid var(--ph-sk-line);border-radius:var(--ph-sk-radius);background:var(--ph-sk-surface);transition:border-color 160ms ease,box-shadow 160ms ease,transform 160ms cubic-bezier(.16,1,.3,1)}',
      '@media (hover:hover) and (pointer:fine){.ph-sk-hit:hover{border-color:var(--dsw-alias-border-l3,#d9dde3);box-shadow:var(--dsw-alias-shadow-lv1,0 6px 18px rgba(15,20,30,.08));transform:translateY(-1px)}}',
      '.ph-sk-hit.is-installed{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 34%,transparent)}',
      '.ph-sk-hit-head{display:flex;align-items:flex-start;gap:9px;min-width:0}',
      '.ph-sk-hit-title{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:1px}',
      '.ph-sk-hit-name{margin:0;font-size:13.5px;line-height:20px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ph-sk-hit-owner{font-size:11px;line-height:16px;color:var(--ph-sk-ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ph-sk-hit-desc{margin:0;font-size:12px;line-height:18px;color:var(--ph-sk-ink3);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
      '.ph-sk-hit-foot{display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:2px}',
      '.ph-sk-hit-stats{font-size:11px;line-height:16px;color:var(--ph-sk-ink3);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.ph-sk-link{display:inline-flex;align-items:center;gap:4px;border:0;background:none;padding:0;font:inherit;font-size:11.5px;line-height:18px;color:var(--ph-sk-ink3);cursor:pointer;text-decoration:none}',
      '.ph-sk-link:hover{color:var(--ph-sk-accent)}',
      '.ph-sk-detail{margin-top:4px;padding-top:10px;border-top:1px solid var(--ph-sk-line-soft);font-size:11.5px;line-height:18px;color:var(--ph-sk-ink2);max-height:168px;overflow:auto;overscroll-behavior:contain}',
      '.ph-sk-detail pre{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:17px;white-space:pre-wrap;word-break:break-word;color:var(--ph-sk-ink2)}',
      '.ph-sk-source-note{display:flex;align-items:center;gap:6px;font-size:11.5px;line-height:18px;color:var(--ph-sk-ink3)}',
      '.ph-sk-source-note.is-bad{color:var(--dsw-alias-state-warn-primary,#b45309)}',

      // ---- the wall preview: one reading, then the scale under it
      '.ph-sk-preview{display:flex;flex-direction:column;gap:11px;min-width:0}',
      '.ph-sk-hero-row{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}',
      '.ph-sk-big{font-size:34px;line-height:36px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}',
      '.ph-sk-big-unit{font-size:13px;line-height:20px;color:var(--ph-sk-ink3);padding-bottom:3px}',
      '.ph-sk-scale{display:flex;height:8px;border-radius:99px;overflow:hidden;background:var(--ph-sk-sunken);gap:2px}',
      '.ph-sk-scale i{display:block;height:100%}',
      '.ph-sk-scale .is-on{background:var(--ph-sk-accent)}',
      '.ph-sk-scale .is-user{background:var(--dsw-alias-state-warn-primary,#e3a008)}',
      '.ph-sk-scale .is-off{background:var(--dsw-alias-border-l3,#d9dde3)}',
      '.ph-sk-legend{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--ph-sk-ink3)}',
      '.ph-sk-legend span{display:inline-flex;align-items:center;gap:5px}',
      '.ph-sk-legend b{font-weight:600;color:var(--ph-sk-ink2);font-variant-numeric:tabular-nums}',
      '.ph-sk-swatch{width:7px;height:7px;border-radius:2px;display:inline-block}',
      '.ph-sk-swatch.is-on{background:var(--ph-sk-accent)}',
      '.ph-sk-swatch.is-user{background:var(--dsw-alias-state-warn-primary,#e3a008)}',
      '.ph-sk-swatch.is-off{background:var(--dsw-alias-border-l3,#d9dde3)}',

      // A touch screen has no hover, and the two things that use it above are
      // already inside the guard; nothing else here animates on hover.
      '@media (prefers-reduced-motion:reduce){.ph-sk *{transition:none!important;animation:none!important}}',
    ].join('')

    var styleSeat = { done: false }

    /** Register the page's stylesheet once for the lifetime of the panel. */
    function ensureStyles() {
      if (styleSeat.done) return
      styleSeat.done = true
      try { runtime.insertCss(STYLE) } catch (error) { void error }
    }

    // ----------------------------------------------------------------- data

    /**
     * The local Skill catalog, shared by the preview and the installed pane.
     * @param api - card api.
     * @param enabled - false parks the read (a pane that is not on screen).
     * @returns the `useRemote` view.
     */
    function useSkills(api, enabled) {
      var signal = api.control(SIGNAL)
      var remote = useRemote(LIST, { options: {} }, { refreshMs: 0, enabled: enabled !== false })
      React.useEffect(function () {
        return publishReloader('skill', function () { void remote.reload(false) })
      }, [remote.reload])
      // A switch flipped anywhere on this card republishes the catalog, so the
      // reading on the wall and the list in the page never disagree.
      React.useEffect(function () {
        if (signal === null || signal === undefined || signal === '') return
        void remote.reload(true)
      }, [signal])
      return remote
    }

    /** @returns the skill list out of a host answer, always an array. */
    function skillsOf(data) {
      return data && Array.isArray(data.skills) ? data.skills : []
    }

    // -------------------------------------------------------------- notices

    /**
     * What the wall's notice bubble should say, or null. Unreachable is not
     * news — the card simply has nothing to show; a host that answered with an
     * error twice is.
     */
    function skillNotice(view) {
      if (view.error && view.failures > 1) return { level: 'error', text: t('skill.notice.failed', { reason: view.error }) }
      var data = view.data
      if (!data) return null
      if (countsOf(data).total === 0) return { level: 'info', text: t('skill.notice.empty') }
      var warnings = Array.isArray(data.warnings) ? data.warnings : []
      if (warnings.length > 0) return { level: 'warn', text: t('skill.notice.warned', { count: warnings.length }) }
      return null
    }

    // ======================================================== wall preview

    /** One legend entry of the preview scale. */
    function Legend(props) {
      return h('span', null,
        h('i', { className: 'ph-sk-swatch is-' + props.kind }),
        t(props.label), ' ', h('b', null, String(props.count)))
    }

    /**
     * The reading: how many Skills this machine has, and how they divide. A
     * count alone says nothing — "6 installed, 4 in use" is the fact that
     * changes, so the number and the scale are one sentence, not a dashboard.
     */
    function SkillCard(props) {
      var api = props.api
      var view = useSkills(api)
      var data = view.data
      var counts = countsOf(data)
      useAnnounce(api, 'skill', skillNotice(view))
      if (view.error && !data) {
        return h('div', { className: 'ph-sk-preview' },
          h(UI.Chip, { tone: 'error' }, t('common.error')),
          h('p', { className: 'ph-sk-note' }, view.error))
      }
      if (!data) return h('div', { className: 'ph-sk-preview' }, h('span', { className: 'ph-sk-big ph-sk-big-unit' }, '—'))
      if (counts.total === 0) {
        return h('div', { className: 'ph-sk-preview' },
          h('span', { className: 'ph-sk-big ph-sk-big-unit' }, t('skill.preview.none')),
          h('p', { className: 'ph-sk-note' }, t('skill.preview.noneHint')))
      }
      // The thumbnail is a reading, not a file browser: the root path belongs
      // to the expanded page, where the user asked to see where skills live.
      return h('div', { className: 'ph-sk-preview' },
        h('div', { className: 'ph-sk-hero-row' },
          h('span', { className: 'ph-sk-big' }, String(counts.total)),
          h('span', { className: 'ph-sk-big-unit' }, t('skill.preview.unit')),
          h('span', { className: 'ph-head-spacer' }),
          h(UI.Chip, { tone: counts.invalid > 0 ? 'warn' : 'ok' },
            t('skill.preview.inUse', { count: counts.enabled }))),
        h('div', { className: 'ph-sk-scale', role: 'img', 'aria-label': t('skill.preview.scale') },
          counts.enabled > 0 ? h('i', { className: 'is-on', style: { flex: String(counts.enabled) } }) : null,
          counts.userOnly > 0 ? h('i', { className: 'is-user', style: { flex: String(counts.userOnly) } }) : null,
          counts.disabled > 0 ? h('i', { className: 'is-off', style: { flex: String(counts.disabled) } }) : null),
        h('div', { className: 'ph-sk-legend' },
          counts.enabled > 0 ? h(Legend, { kind: 'on', label: 'skill.state.enabled', count: counts.enabled }) : null,
          counts.userOnly > 0 ? h(Legend, { kind: 'user', label: 'skill.state.userOnly', count: counts.userOnly }) : null,
          counts.disabled > 0 ? h(Legend, { kind: 'off', label: 'skill.state.disabled', count: counts.disabled }) : null,
          counts.invalid > 0 ? h('span', { className: 'ph-sk-flag' }, ICONS.warn(12), t('skill.preview.invalid', { count: counts.invalid })) : null))
    }

    // ====================================================== installed pane

    /**
     * The invocation mode a skill is in, as one of the three menu values.
     * @param skill - a catalog entry.
     * @returns `'on'` | `'model-off'` | `'off'`.
     */
    function modeOf(skill) {
      var state = stateOf(skill)
      if (state === 'enabled') return 'on'
      if (state === 'userOnly') return 'model-off'
      return 'off'
    }

    /**
     * The label of a mode, for the switcher's own face.
     * @param mode - `'on'` | `'model-off'` | `'off'`.
     * @returns the locale text.
     */
    function modeLabel(mode) {
      if (mode === 'on') return t('skill.mode.on')
      if (mode === 'model-off') return t('skill.mode.modelOff')
      return t('skill.mode.off')
    }

    /**
     * One row of the installed list: what it is, where it came from, and the two
     * controls that matter. The switch is the fast path (`on` ⇄ `off`); the
     * switcher beside it is the precise one and it names the state it is in, so
     * "keep manual use" is visible without opening anything.
     *
     * The switcher is the framework's `ComboButton` rather than a hand-rolled
     * menu on purpose: its menu renders into the panel's own popover layer,
     * which is `position:fixed`. A menu positioned inside the row lives inside
     * `.ph-focus-body`, whose `overflow:auto` clips anything that reaches past
     * the scroller — the last row's menu was cut off exactly that way.
     *
     * The whole left half is also the way IN: the name is a real button, so a
     * Skill can be opened with the keyboard and not only with a pointer.
     */
    function SkillRow(props) {
      var skill = props.skill
      var state = stateOf(skill)
      var mode = modeOf(skill)
      var busy = props.busy === skill.name
      var readOnly = skill.writable === false
      var disabled = readOnly || busy
      var hint = readOnly
        ? (skill.source === 'bundled' ? t('skill.row.readonlyBundled') : t('skill.row.readonly'))
        : null
      // Only the facts a reader cannot get from the control row: where a same-
      // named copy won, and why a row refuses to switch. The file path lives in
      // the skill's own page; the state lives in the switch and the mode label.
      var flags = []
      if (skill.shadowedBy) flags.push(h('span', { key: 'shadowed', className: 'ph-sk-flag' }, t('skill.row.shadowed', { other: String(skill.shadowedBy) })))
      if (hint) flags.push(h('span', { key: 'hint', className: 'ph-sk-flag' }, hint))
      return h('div', {
        className: 'ph-sk-row' + (state === 'enabled' ? '' : ' is-off') + (busy ? ' is-busy' : ''),
      },
        h('div', { className: 'ph-sk-main' },
          h('div', { className: 'ph-sk-name-row' },
            h('button', {
              type: 'button',
              className: 'ph-sk-name',
              title: t('skill.row.open', { name: String(skill.name) }),
              onClick: function () { props.onOpen(skill.name) },
            }, String(skill.name)),
            skill.source ? h('span', { className: 'ph-sk-src' }, sourceText(skill.source)) : null,
            skill.note ? h('span', { className: 'ph-sk-flag' }, ICONS.warn(11), t('skill.row.invalid')) : null),
          skill.description ? h('p', { className: 'ph-sk-desc', title: skill.description }, String(skill.description)) : null,
          flags.length > 0 ? h('div', { className: 'ph-sk-meta' }, flags) : null),
        h('div', { className: 'ph-sk-actions' },
          h('button', {
            type: 'button',
            className: 'ph-sk-switch' + (state === 'enabled' ? ' is-on' : ''),
            role: 'switch',
            'aria-checked': state === 'enabled',
            'aria-label': t('skill.row.toggle', { name: String(skill.name) }),
            title: hint || t(state === 'enabled' ? 'skill.row.turnOff' : 'skill.row.turnOn'),
            disabled: disabled,
            onClick: function () { props.onSet(skill.name, state === 'enabled' ? 'off' : 'on') },
          }, h('span', { className: 'ph-sk-knob' })),
          h('div', { className: 'ph-sk-mode' },
            h(UI.ComboButton, {
              label: modeLabel(mode),
              value: mode,
              title: hint || t('skill.row.more'),
              options: [
                { value: 'on', label: t('skill.mode.on'), title: t('skill.mode.onHint') },
                { value: 'model-off', label: t('skill.mode.modelOff'), title: t('skill.mode.modelOffHint') },
                { value: 'off', label: t('skill.mode.off'), title: t('skill.mode.offHint') },
              ],
              disabled: disabled,
              onChange: function (next) { props.onSet(skill.name, next) },
            }))))
    }

    /** The empty answer for a filtered or genuinely empty library. */
    function LibraryEmpty(props) {
      var searching = String(props.query || '').trim() !== '' || (props.filter && props.filter !== 'all')
      return h('div', { className: 'ph-sk-empty' },
        GLYPH.search(22),
        h('b', null, t(searching ? 'skill.library.noMatch' : 'skill.library.empty')),
        h('span', null, t(searching ? 'skill.library.noMatchHint' : 'skill.library.emptyHint')))
    }

    /**
     * The installed pane: search, filter, and the list. Rows are only drawn for
     * what passed the filter, and the header line always says how many of how
     * many — a filter that hides everything is otherwise indistinguishable from
     * an empty machine.
     */
    function LibraryPane(props) {
      var api = props.api
      var t = props.t
      var view = props.view
      var queryState = React.useState('')
      var query = queryState[0]
      var setQuery = queryState[1]
      var filterState = React.useState('all')
      var filter = filterState[0]
      var setFilter = filterState[1]
      var pending = props.pending
      var data = view.data
      var skills = skillsOf(data)
      var counts = countsOf(data)
      var visible = filterSkills(skills, query, filter)
      var chips = [{ id: 'all', label: t('skill.filter.all'), count: counts.total }]
      for (var index = 0; index < STATES.length; index++) {
        chips.push({ id: STATES[index].id, label: t(STATES[index].label), count: counts[STATES[index].id] })
      }
      if (view.error && !data) {
        return h('div', { className: 'ph-sk' },
          h('div', { className: 'ph-sk-error' }, ICONS.warn(14), h('span', null, view.error)),
          h(SearchRow, {
            t: t, query: query, onQuery: setQuery, busy: view.busy,
            onRefresh: function () { void view.reload(false) }, clearable: false,
          }))
      }
      return h('div', { className: 'ph-sk' },
        h(SearchRow, {
          t: t, query: query, onQuery: setQuery, busy: view.busy,
          onRefresh: function () { void view.reload(false) }, clearable: true,
          filter: filter, onFilter: setFilter, chips: chips,
        }),
        skills.length === 0
          ? h(LibraryEmpty, { query: query, filter: filter })
          : visible.length === 0
            ? h(LibraryEmpty, { query: query, filter: filter })
            : h('div', { className: 'ph-sk-list' }, visible.map(function (skill) {
                return h(SkillRow, {
                  key: skill.name,
                  skill: skill,
                  busy: pending,
                  onSet: props.onSet,
                  onOpen: props.onOpen,
                })
              })),
        props.rowError ? h('div', { className: 'ph-sk-error' }, ICONS.warn(14), h('span', null, props.rowError)) : null,
        Array.isArray(data && data.warnings) && data.warnings.length > 0
          ? h('div', { className: 'ph-sk-warn' }, ICONS.warn(13), h('span', null, data.warnings.join(' · ')))
          : null)
    }

    /** The search field, its filter pills and the refresh button. */
    function SearchRow(props) {
      var t = props.t
      // A fragment, not a `.ph-sk` box: the caller already lives inside the
      // scope element, and nesting a second one would apply the page's column
      // gap twice.
      return h(React.Fragment, null,
        h('div', { className: 'ph-sk-tools' },
          h('label', { className: 'ph-sk-field' },
            GLYPH.search(15),
            h('input', {
              className: 'ph-sk-input',
              type: 'search',
              value: props.query,
              placeholder: t('skill.search.placeholder'),
              'aria-label': t('skill.search.placeholder'),
              onChange: function (event) { props.onQuery(String(event.target.value)) },
            }),
            props.query !== '' ? h('button', {
              type: 'button', className: 'ph-sk-clear', title: t('skill.search.clear'),
              onClick: function () { props.onQuery('') },
            }, GLYPH.close(13)) : null),
          h('button', {
            type: 'button',
            className: 'ph-sk-btn',
            disabled: props.busy === true,
            title: t('common.refresh'),
            onClick: props.onRefresh,
          }, ICONS.refresh(14), t('common.refresh'))),
        props.chips
          ? h('div', { className: 'ph-sk-pills' }, props.chips.map(function (chip) {
              var on = (props.filter || 'all') === chip.id
              return h('button', {
                key: chip.id,
                type: 'button',
                className: 'ph-sk-pill' + (on ? ' is-on' : ''),
                'aria-pressed': on,
                onClick: function () { props.onFilter(chip.id) },
              }, t(chip.label), h('b', null, String(chip.count)))
            }))
          : null)
    }

    // ===================================================== one skill's content

    /**
     * What one local Skill actually says.
     *
     * The body is rendered verbatim in a pre, not through a markdown renderer: a
     * Skill's text is instructions for a model, and re-typesetting it would show
     * the reader something the model never sees. The frontmatter is the
     * exception — it IS metadata, so it becomes labelled rows, which is also the
     * only place the two invocation switches are readable exactly as written.
     *
     * @param props - `{ t, name, onBack, onSet, pending }`.
     * @returns the element.
     */
    function SkillContent(props) {
      var t = props.t
      var state = React.useState({ busy: true, data: null, error: null })
      var view = state[0]
      var setView = state[1]
      React.useEffect(function () {
        var alive = true
        setView({ busy: true, data: null, error: null })
        remoteCall(CONTENT, { options: { name: props.name } })
          .then(function (answer) {
            if (!alive) return
            setView({ busy: false, data: answer || {}, error: null })
          })
          .catch(function (reason) {
            if (!alive) return
            setView({ busy: false, data: null, error: String((reason && reason.message) || reason) })
          })
        return function () { alive = false }
      }, [props.name])

      var data = view.data
      var canSwitch = data ? data.writable === true : false
      var mode = data ? modeOf(data) : 'off'
      return h('div', { className: 'ph-sk-doc' },
        h('div', { className: 'ph-sk-doc-bar' },
          h('button', {
            type: 'button',
            className: 'ph-sk-btn',
            title: t('skill.doc.back'),
            onClick: props.onBack,
          }, GLYPH.back(14), t('skill.doc.back')),
          h('span', { className: 'ph-sk-nav-spacer' }),
          canSwitch
            ? h(UI.ComboButton, {
                label: modeLabel(mode),
                value: mode,
                options: [
                  { value: 'on', label: t('skill.mode.on'), title: t('skill.mode.onHint') },
                  { value: 'model-off', label: t('skill.mode.modelOff'), title: t('skill.mode.modelOffHint') },
                  { value: 'off', label: t('skill.mode.off'), title: t('skill.mode.offHint') },
                ],
                disabled: props.pending === props.name,
                onChange: function (next) { props.onSet(props.name, next) },
              })
            : null),
        view.busy ? h('div', { className: 'ph-sk-empty' }, GLYPH.search(22), h('b', null, t('skill.doc.loading')), h('span', null, String(props.name))) : null,
        view.error ? h('div', { className: 'ph-sk-error' }, ICONS.warn(14), h('span', null, view.error)) : null,
        data
          ? h('div', { className: 'ph-sk-doc-body' },
              h('div', { className: 'ph-sk-doc-head' },
                h('h4', { className: 'ph-sk-doc-name' }, String(data.name)),
                h('span', { className: 'ph-sk-chip is-' + (stateTone(mode === 'on' ? 'enabled' : mode === 'model-off' ? 'userOnly' : 'disabled') || 'quiet') },
                  modeLabel(mode)),
                data.source ? h('span', { className: 'ph-sk-src' }, sourceText(data.source)) : null,
                data.note ? h('span', { className: 'ph-sk-flag' }, ICONS.warn(11), t('skill.row.invalid')) : null),
              data.reason ? h('div', { className: 'ph-sk-error' }, ICONS.warn(14), h('span', null, t('skill.doc.unreadable', { reason: String(data.reason) }))) : null,
              h('div', { className: 'ph-sk-doc-meta' },
                h('code', { title: String(data.path || '') }, String(data.path || '')),
                h('span', { className: 'ph-sk-count' }, t('skill.doc.size', { size: bytesText(data.bytes) }))),
              data.frontmatter && data.frontmatter.length > 0
                ? h('div', { className: 'ph-sk-doc-facts' }, data.frontmatter.map(function (row) {
                    return h('div', { className: 'ph-sk-doc-fact', key: row.key },
                      h('span', { className: 'ph-sk-doc-key' }, String(row.key)),
                      h('span', { className: 'ph-sk-doc-value' }, String(row.value)))
                  }))
                : null,
              data.files && data.files.length > 0
                ? h('div', { className: 'ph-sk-doc-files' },
                    h('span', { className: 'ph-sk-doc-facts-title' }, t('skill.doc.files', { count: data.files.length })),
                    h('div', { className: 'ph-sk-doc-filelist' }, data.files.map(function (file) {
                      return h('span', { className: 'ph-sk-doc-file', key: file.path },
                        ICONS.folder(11), String(file.path) + (file.kind === 'dir' ? '/' : ''))
                    })))
                : null,
              h('div', { className: 'ph-sk-doc-facts-title' }, t('skill.doc.instructions')),
              h('pre', { className: 'ph-sk-doc-text' }, String(data.body || '')),
              data.truncated ? h('p', { className: 'ph-sk-note' }, t('skill.doc.truncated')) : null)
          : null)
    }

    // ======================================================== discover pane

    /**
     * One search field, the sources as chips, and the hits. The pane's job is
     * to be searched in, so the field is the biggest thing on it and the hits
     * carry one sentence each — a storefront, not a table.
     */
    function DiscoverPane(props) {
      var api = props.api
      var t = props.t
      var queryState = React.useState('')
      var query = queryState[0]
      var setQuery = queryState[1]
      var sourceState = React.useState('all')
      var source = sourceState[0]
      var setSource = sourceState[1]
      var searchState = React.useState({ busy: false, results: [], failures: [], error: null, query: '', truncated: false })
      var search = searchState[0]
      var setSearch = searchState[1]
      var installState = React.useState('')
      var installing = installState[0]
      var setInstalling = installState[1]
      var failState = React.useState('')
      var installError = failState[0]
      var setInstallError = failState[1]
      var sources = props.sources
      var installedNames = props.installedNames || []
      var ticket = React.useRef(0)

      var run = React.useCallback(function (text, picked) {
        var wanted = String(text || '').trim()
        if (wanted === '') {
          setSearch({ busy: false, results: [], failures: [], error: null, query: '', truncated: false })
          return
        }
        var mine = ++ticket.current
        setSearch(function (current) {
          return Object.assign({}, current, { busy: true, error: null, query: wanted })
        })
        remoteCall(SEARCH, { options: { query: wanted, source: picked } })
          .then(function (answer) {
            if (mine !== ticket.current) return
            setSearch({
              busy: false,
              results: Array.isArray(answer && answer.results) ? answer.results : [],
              failures: Array.isArray(answer && answer.failures) ? answer.failures : [],
              error: null,
              query: wanted,
              truncated: Boolean(answer && answer.truncated),
            })
          })
          .catch(function (reason) {
            if (mine !== ticket.current) return
            setSearch({
              busy: false, results: [], failures: [],
              error: String((reason && reason.message) || reason), query: wanted, truncated: false,
            })
          })
      }, [])

      // The install is deliberately synchronous from the user's point of view:
      // the host downloads and validates before it answers, so one click is one
      // install and the answer is the skill that landed.
      function install(result) {
        if (installing !== '') return
        setInstallError('')
        setInstalling(result.id)
        remoteCall(INSTALL, { options: { id: result.id, source: result.source, ref: result.install && result.install.ref, destination: 'user-dsh' } })
          .then(function (answer) {
            setInstalling('')
            var name = String((answer && answer.name) || result.name)
            pushToast(t('skill.install.done', { name: name }))
            props.onInstalled(name)
          })
          .catch(function (reason) {
            setInstalling('')
            setInstallError(String((reason && reason.message) || reason))
          })
      }

      var sourceList = Array.isArray(sources) ? sources : []
      return h('div', { className: 'ph-sk' },
        h('div', { className: 'ph-sk-hero' },
          h('h3', { className: 'ph-sk-hero-title' }, t('skill.discover.title')),
          h('p', { className: 'ph-sk-hero-sub' }, t('skill.discover.sub')),
          h('div', { className: 'ph-sk-tools' },
            h('label', { className: 'ph-sk-field' },
              GLYPH.search(16),
              h('input', {
                className: 'ph-sk-input',
                type: 'search',
                value: query,
                placeholder: t('skill.discover.placeholder'),
                'aria-label': t('skill.discover.placeholder'),
                onChange: function (event) { setQuery(String(event.target.value)) },
                onKeyDown: function (event) {
                  if (event.key === 'Enter') run(query, source)
                },
              }),
              query !== '' ? h('button', {
                type: 'button', className: 'ph-sk-clear', title: t('skill.search.clear'),
                onClick: function () { setQuery(''); run('', source) },
              }, GLYPH.close(13)) : null),
            h('button', {
              type: 'button',
              className: 'ph-sk-btn is-solid',
              disabled: search.busy || query.trim() === '',
              onClick: function () { run(query, source) },
            }, GLYPH.search(14), t('skill.discover.go'))),
          h('div', { className: 'ph-sk-pills' },
            h('button', {
              type: 'button',
              className: 'ph-sk-pill' + (source === 'all' ? ' is-on' : ''),
              onClick: function () { setSource('all'); if (query.trim() !== '') run(query, 'all') },
            }, t('skill.discover.all')),
            sourceList.map(function (entry) {
              return h('button', {
                key: entry.id,
                type: 'button',
                className: 'ph-sk-pill' + (source === entry.id ? ' is-on' : ''),
                title: entry.reachable === false ? (entry.note || t('skill.discover.unreachable')) : (entry.home || entry.id),
                onClick: function () {
                  setSource(entry.id)
                  if (query.trim() !== '') run(query, entry.id)
                },
              }, entry.reachable === false ? GLYPH.slash(12) : GLYPH.globe(12), String(entry.label || entry.id))
            })),
          sourceList.length > 0
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, sourceList.map(function (entry) {
                return h('p', {
                  key: 'note-' + entry.id,
                  className: 'ph-sk-source-note' + (entry.reachable === false ? ' is-bad' : ''),
                }, entry.reachable === false
                  ? t('skill.discover.sourceDown', { label: String(entry.label || entry.id), reason: String(entry.note || t('skill.discover.unreachable')) })
                  : t('skill.discover.sourceHome', { label: String(entry.label || entry.id), home: String(entry.home || '') }))
              }))
            : null),

        installError ? h('div', { className: 'ph-sk-error' }, ICONS.warn(14), h('span', null, installError)) : null,
        search.error ? h('div', { className: 'ph-sk-error' }, ICONS.warn(14), h('span', null, search.error)) : null,

        search.busy ? h('div', { className: 'ph-sk-empty' }, GLYPH.spark(22), h('b', null, t('skill.discover.searching')), h('span', null, search.query)) : null,
        !search.busy && search.query === '' ? h('div', { className: 'ph-sk-empty' },
          GLYPH.search(22), h('b', null, t('skill.discover.idle')),
          h('span', null, t('skill.discover.idleHint'))) : null,
        !search.busy && search.query !== '' && search.results.length === 0 && !search.error
          ? h('div', { className: 'ph-sk-empty' }, GLYPH.search(22),
              h('b', null, t('skill.discover.noMatch')), h('span', null, search.query))
          : null,
        search.results.length > 0
          ? h('div', { className: 'ph-sk-grid' }, search.results.map(function (result) {
              return h(HitCard, {
                key: result.id,
                result: result,
                t: t,
                installed: installedName(installedNames, result),
                busy: installing === result.id,
                anyBusy: installing !== '',
                onInstall: install,
              })
            }))
          : null,
        search.truncated ? h('p', { className: 'ph-sk-note' }, t('skill.discover.truncated')) : null,
        search.failures.length > 0
          ? h('div', { className: 'ph-sk-warn' }, ICONS.warn(13), h('span', null, search.failures.map(function (failure) {
              return String(failure.source) + ': ' + String(failure.message)
            }).join(' · ')))
          : null)
    }

    /** One external hit: what it is, who made it, and the one action. */
    function HitCard(props) {
      var t = props.t
      var result = props.result || {}
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var detailState = React.useState(null)
      var detail = detailState[0]
      var setDetail = detailState[1]
      var stats = []
      if (result.version) stats.push(String(result.version))
      if (result.downloads !== null && result.downloads !== undefined) stats.push(t('skill.hit.downloads', { count: result.downloads }))
      if (result.stars !== null && result.stars !== undefined && result.stars > 0) stats.push(t('skill.hit.stars', { count: result.stars }))
      var when = dateText(result.updatedAt)
      if (when) stats.push(when)
      function openDoc() {
        var next = !open
        setOpen(next)
        if (!next || detail !== null) return
        // The body is an enrichment: a source that cannot supply one answers
        // with an empty detail, never with an error the user has to read.
        remoteCall('homepage/skillDetail', { options: { id: result.id, source: result.source } })
          .then(function (answer) { setDetail(answer || {}) })
          .catch(function () { setDetail({}) })
      }
      return h('div', { className: 'ph-sk-hit' + (props.installed ? ' is-installed' : '') },
        h('div', { className: 'ph-sk-hit-head' },
          h('span', { className: 'ph-sk-chip is-quiet' }, String(result.source || '')),
          h('div', { className: 'ph-sk-hit-title' },
            h('h4', { className: 'ph-sk-hit-name', title: String(result.displayName || result.name || '') },
              String(result.displayName || result.name || '')),
            result.owner ? h('span', { className: 'ph-sk-hit-owner' }, String(result.owner)) : null)),
        result.summary ? h('p', { className: 'ph-sk-hit-desc', title: String(result.summary) }, String(result.summary)) : null,
        stats.length > 0 ? h('div', { className: 'ph-sk-hit-stats' }, stats.join(' · ')) : null,
        open
          ? h('div', { className: 'ph-sk-detail' },
              detail === null
                ? h('p', { className: 'ph-sk-note' }, t('skill.hit.loading'))
                : h('div', null,
                    detail.files && detail.files.length > 0
                      ? h('p', { className: 'ph-sk-note' }, t('skill.hit.files', { count: detail.files.length, names: detail.files.slice(0, 6).join(', ') }))
                      : null,
                    detail.readme
                      ? h('pre', null, String(detail.readme).slice(0, 2400))
                      : h('p', { className: 'ph-sk-note' }, t('skill.hit.noReadme'))))
          : null,
        h('div', { className: 'ph-sk-hit-foot' },
          props.installed
            ? h('span', { className: 'ph-sk-chip is-ok' }, GLYPH.check(11), t('skill.hit.installed'))
            : h('button', {
                type: 'button',
                className: 'ph-sk-btn is-solid',
                disabled: props.anyBusy,
                onClick: function () { props.onInstall(result) },
              }, GLYPH.download(14), props.busy ? t('skill.install.busy') : t('skill.install.action')),
          h('span', { className: 'ph-head-spacer' }),
          h('button', { type: 'button', className: 'ph-sk-link', onClick: openDoc },
            t(open ? 'skill.hit.collapse' : 'skill.hit.expand')),
          result.url ? h('a', {
            className: 'ph-sk-link',
            href: String(result.url),
            target: '_blank',
            rel: 'noreferrer noopener',
            title: String(result.url),
          }, GLYPH.external(12)) : null))
    }

    // ========================================================= expanded page

    /**
     * The expanded page: one header, one navigation bar, two panes. The pane is
     * kept in component state and the search text lives with its pane, so
     * switching back and forth does not throw away either.
     */
    function SkillDetail(props) {
      var api = props.api
      var t = props.t
      ensureStyles()
      var paneState = React.useState('library')
      var pane = paneState[0]
      var setPane = paneState[1]
      // Which skill's content is on show, if any — the name, not the entry,
      // because the content page re-reads the file and the catalog can move
      // under it (a switch flip, an install).
      var openState = React.useState('')
      var open = openState[0]
      var setOpen = openState[1]
      var pendingState = React.useState('')
      var pending = pendingState[0]
      var setPending = pendingState[1]
      var rowErrorState = React.useState('')
      var rowError = rowErrorState[0]
      var setRowError = rowErrorState[1]
      var view = useSkills(api, true)
      var data = view.data
      var skills = skillsOf(data)
      var counts = countsOf(data)
      var names = skills.map(function (skill) { return skill.name })
      var sources = useRemote(SOURCES, { options: {} }, { refreshMs: 0, enabled: pane === 'discover' })

      /** Flip one skill and republish the catalog to every surface. */
      function setEnabled(name, mode) {
        if (pending !== '') return
        setRowError('')
        setPending(name)
        remoteCall(SET_ENABLED, { options: { name: name, mode: mode } })
          .then(function () {
            setPending('')
            api.setControl(SIGNAL, name + '@' + mode + '@' + Date.now())
            pushToast(t('skill.toggle.done', { name: name, mode: t(mode === 'off' ? 'skill.mode.off' : mode === 'model-off' ? 'skill.mode.modelOff' : 'skill.mode.on') }))
          })
          .catch(function (reason) {
            setPending('')
            setRowError(String((reason && reason.message) || reason))
          })
      }

      /** Re-read both surfaces after an install brought a new skill in. */
      function installed() {
        api.setControl(SIGNAL, 'install@' + Date.now())
        void view.reload(true)
      }

      var sourceList = (sources.data && Array.isArray(sources.data.sources)) ? sources.data.sources : []
      // One level of navigation, not two: the content page replaces the pane
      // rather than stacking inside it, so the card never becomes a modal over
      // its own modal. There is no page title above this: the expanded pane
      // header already names the card and the tab bar is the page structure.
      return h('div', { className: 'ph-sk' },
        open !== ''
          ? h(SkillContent, {
              t: t, name: open, pending: pending, onSet: setEnabled,
              onBack: function () { setOpen('') },
            })
          : h(React.Fragment, null,
              h('div', { className: 'ph-sk-nav', role: 'tablist' },
                h('button', {
                  type: 'button', role: 'tab', 'aria-selected': pane === 'library',
                  className: 'ph-sk-tab' + (pane === 'library' ? ' is-on' : ''),
                  onClick: function () { setPane('library') },
                }, GLYPH.folder(14), t('skill.tab.library'), h('span', { className: 'ph-sk-tab-count' }, String(counts.total))),
                h('button', {
                  type: 'button', role: 'tab', 'aria-selected': pane === 'discover',
                  className: 'ph-sk-tab' + (pane === 'discover' ? ' is-on' : ''),
                  onClick: function () { setPane('discover') },
                }, GLYPH.globe(14), t('skill.tab.discover')),
                h('span', { className: 'ph-sk-nav-spacer' })),
              pane === 'discover'
                ? h(DiscoverPane, {
                    api: api, t: t, sources: sourceList,
                    installedNames: names, onInstalled: installed,
                  })
                : h(LibraryPane, {
                    api: api, t: t, view: view, pending: pending, rowError: rowError,
                    onSet: setEnabled, onOpen: setOpen,
                  })))
    }

    // ---------------------------------------------------------- registration

    defineCard({
      id: 'skill',
      title: function () { return t('card.skill.title') },
      icon: function (size) { return ICONS.skill(size) },
      accent: '#5b6cff',
      // The last tile on the wall: the reading is about the skills that decide
      // every other card's vocabulary, so it sits after the machine facts.
      order: 80,
      texture: { icon: 'skill', opacity: 5, size: 118, bleed: '-16%' },
      size: { w: 2, h: 2 },
      minSize: { w: 2, h: 2 },
      maxSize: { w: 4, h: 3 },
      hover: { grow: 1.03, hint: true },
      tags: ['skill', 'agent', 'market'],
      shipped: true,
      content: function (api) { return h(SkillCard, { api: api, t: runtime.t }) },
      detail: function (api) { return h(SkillDetail, { api: api, t: runtime.t }) },
      // The changed-catalog signal (see SIGNAL) is a control rather than
      // component state: the wall's preview and the expanded page are separate
      // instances, and a control is the one value the framework shares between
      // them. It sits in `detailActions`, not `actions`, because a non-empty
      // `actions` list makes the wall render a settings bar beside the card and
      // the preview must not carry one.
      //
      // Declaring it is what makes it work at all: `cardApi.control()` only
      // answers for an action the card registered, so an undeclared id reads
      // null and `setControl` is a silent no-op.
      actions: [],
      detailActions: [
        { id: SIGNAL, type: 'text', hidden: true, value: '', placeholder: '' },
      ],
      dict: {
        zh: {
          'card.skill.title': '技能',

          'skill.preview.unit': '个本地技能',
          'skill.preview.inUse': '{count} 个在用',
          'skill.preview.invalid': '{count} 个无法解析',
          'skill.preview.none': '还没有本地技能',
          'skill.preview.noneHint': '展开后可在「发现」里从社区源安装',
          'skill.preview.scale': '技能启用状态分布',

          'skill.state.enabled': '已启用',
          'skill.state.userOnly': '仅手动',
          'skill.state.disabled': '已停用',

          'skill.source.projectDsh': '项目 .dsh',
          'skill.source.projectAgents': '项目 .agents',
          'skill.source.custom': '自定义目录',
          'skill.source.userDsh': '用户 .dsh',
          'skill.source.userAgents': '用户 .agents',
          'skill.source.bundled': '内置',

          'skill.tab.library': '本地',
          'skill.tab.discover': '发现',

          'skill.search.placeholder': '搜索技能名称或说明',
          'skill.search.clear': '清空搜索',
          'skill.filter.all': '全部',
          'skill.library.empty': '还没有本地技能',
          'skill.library.emptyHint': '把技能目录放进 ~/.dsh/skills 或 ~/.agents/skills，或到「发现」里安装一个。',
          'skill.library.noMatch': '没有匹配的技能',
          'skill.library.noMatchHint': '换个关键词，或把筛选切回「全部」。',

          'skill.row.toggle': '启用或停用 {name}',
          'skill.row.turnOn': '启用',
          'skill.row.turnOff': '停用',
          'skill.row.open': '查看 {name} 的内容',
          'skill.row.more': '启用方式',
          'skill.row.readonly': '这个技能不在可写目录里，无法在这里切换',
          'skill.row.readonlyBundled': '内置技能，无法在这里切换',
          'skill.row.shadowed': '被更高优先级的同名技能（{other}）遮蔽',
          'skill.row.invalid': '前置信息不完整，未生效',

          'skill.doc.back': '返回列表',
          'skill.doc.loading': '正在读取技能内容',
          'skill.doc.instructions': '技能正文（模型看到的就是这段文字）',
          'skill.doc.files': '附带 {count} 个文件',
          'skill.doc.size': '{size}',
          'skill.doc.unreadable': '读不到这个文件：{reason}',
          'skill.doc.truncated': '文件过大，这里只显示前一部分。',

          'skill.mode.on': '启用',
          'skill.mode.onHint': '进入模型技能目录，模型可以自行调用',
          'skill.mode.modelOff': '保留手动调用',
          'skill.mode.off': '停用',
          'skill.mode.modelOffHint': '模型看不到，但仍可用 /技能名 手动调用',
          'skill.mode.offHint': '模型与你都无法调用',

          'skill.toggle.done': '「{name}」已切换为{mode}',

          'skill.discover.title': '发现技能',
          'skill.discover.sub': '从社区技能源查找通用格式（SKILL.md）的技能，安装到用户技能目录。',
          'skill.discover.placeholder': '搜索技能，例如 pdf、code review、excel',
          'skill.discover.go': '搜索',
          'skill.discover.all': '全部来源',
          'skill.discover.idle': '输入关键词开始查找',
          'skill.discover.idleHint': '数据来自 ClawHub 等社区技能源，安装前不会改动本机任何文件。',
          'skill.discover.searching': '正在查找',
          'skill.discover.noMatch': '没有找到匹配的技能',
          'skill.discover.truncated': '结果过多，只显示了前一批；把关键词写得更具体可以看得更准。',
          'skill.discover.unreachable': '无法连接',
          'skill.discover.sourceDown': '{label} 当前不可用：{reason}',
          'skill.discover.sourceHome': '{label} · {home}',

          'skill.hit.downloads': '{count} 次安装',
          'skill.hit.stars': '{count} 星',
          'skill.hit.expand': '查看内容',
          'skill.hit.collapse': '收起',
          'skill.hit.loading': '正在读取技能内容…',
          'skill.hit.noReadme': '来源没有提供可预览的正文，安装后即可阅读 SKILL.md。',
          'skill.hit.files': '包含 {count} 个文件：{names}',
          'skill.hit.installed': '已安装',

          'skill.install.action': '安装',
          'skill.install.busy': '安装中…',
          'skill.install.done': '「{name}」已安装到用户技能目录',

          'skill.notice.failed': '读不到本地技能：{reason}',
          'skill.notice.empty': '这台机器还没有本地技能。',
          'skill.notice.warned': '{count} 个技能目录读取失败，展开可以看到原因。',
        },
        en: {
          'card.skill.title': 'Skills',

          'skill.preview.unit': 'local skills',
          'skill.preview.inUse': '{count} in use',
          'skill.preview.invalid': '{count} unreadable',
          'skill.preview.none': 'No local skills yet',
          'skill.preview.noneHint': 'Open the card and install one from Discover',
          'skill.preview.scale': 'How the installed skills divide',

          'skill.state.enabled': 'Enabled',
          'skill.state.userOnly': 'Manual only',
          'skill.state.disabled': 'Off',

          'skill.source.projectDsh': 'project .dsh',
          'skill.source.projectAgents': 'project .agents',
          'skill.source.custom': 'custom dir',
          'skill.source.userDsh': 'user .dsh',
          'skill.source.userAgents': 'user .agents',
          'skill.source.bundled': 'bundled',

          'skill.tab.library': 'Installed',
          'skill.tab.discover': 'Discover',

          'skill.search.placeholder': 'Search a skill by name or description',
          'skill.search.clear': 'Clear the search',
          'skill.filter.all': 'All',
          'skill.library.empty': 'No local skills yet',
          'skill.library.emptyHint': 'Drop a skill directory into ~/.dsh/skills or ~/.agents/skills, or install one from Discover.',
          'skill.library.noMatch': 'Nothing matches',
          'skill.library.noMatchHint': 'Try another word, or switch the filter back to All.',

          'skill.row.toggle': 'Enable or disable {name}',
          'skill.row.turnOn': 'Enable',
          'skill.row.turnOff': 'Disable',
          'skill.row.open': 'Read what {name} says',
          'skill.row.more': 'How it is enabled',
          'skill.row.readonly': 'This skill is not in a writable root, so it cannot be switched here',
          'skill.row.readonlyBundled': 'Bundled skill — it cannot be switched here',
          'skill.row.shadowed': 'Shadowed by a higher-priority skill of the same name ({other})',
          'skill.row.invalid': 'Frontmatter is incomplete; it is not in effect',

          'skill.doc.back': 'Back to the list',
          'skill.doc.loading': 'Reading the skill',
          'skill.doc.instructions': 'The skill text (this is exactly what the model is handed)',
          'skill.doc.files': 'Ships {count} files',
          'skill.doc.size': '{size}',
          'skill.doc.unreadable': 'This file could not be read: {reason}',
          'skill.doc.truncated': 'The file is large; only the beginning is shown here.',

          'skill.mode.on': 'Enabled',
          'skill.mode.onHint': 'Listed in the model skill catalog; the model may load it on its own',
          'skill.mode.modelOff': 'Keep manual use',
          'skill.mode.off': 'Off',
          'skill.mode.modelOffHint': 'Hidden from the model, still loadable with /name',
          'skill.mode.offHint': 'Neither the model nor /name can load it',

          'skill.toggle.done': '“{name}” is now {mode}',

          'skill.discover.title': 'Discover skills',
          'skill.discover.sub': 'Search community skill sources for general-format (SKILL.md) skills and install one into the user skill root.',
          'skill.discover.placeholder': 'Search skills — pdf, code review, excel …',
          'skill.discover.go': 'Search',
          'skill.discover.all': 'All sources',
          'skill.discover.idle': 'Type a word to start looking',
          'skill.discover.idleHint': 'Results come from community sources such as ClawHub. Nothing on this machine changes until you install.',
          'skill.discover.searching': 'Searching',
          'skill.discover.noMatch': 'No matching skill',
          'skill.discover.truncated': 'There is more than one batch of results; a more specific word narrows it down.',
          'skill.discover.unreachable': 'unreachable',
          'skill.discover.sourceDown': '{label} is unreachable right now: {reason}',
          'skill.discover.sourceHome': '{label} · {home}',

          'skill.hit.downloads': '{count} installs',
          'skill.hit.stars': '{count} stars',
          'skill.hit.expand': 'View contents',
          'skill.hit.collapse': 'Hide contents',
          'skill.hit.loading': 'Reading the skill …',
          'skill.hit.noReadme': 'This source has no preview; the SKILL.md is readable once installed.',
          'skill.hit.files': '{count} files: {names}',
          'skill.hit.installed': 'Installed',

          'skill.install.action': 'Install',
          'skill.install.busy': 'Installing …',
          'skill.install.done': '“{name}” was installed into the user skill root',

          'skill.notice.failed': 'Cannot read the local skills: {reason}',
          'skill.notice.empty': 'This machine has no local skills yet.',
          'skill.notice.warned': '{count} skill roots could not be read; open the card for the reason.',
        },
      },
    })
