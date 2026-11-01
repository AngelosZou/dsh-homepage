/**
 * Sidebar list module: the grouped project list this plugin draws inside the
 * left sidebar, in place of the shipped workspace browser.
 *
 * It exists because of where the grouping controls were: the manager card was
 * the only place to edit groups, and the sidebar itself stayed flat. While the
 * document's `mode` is `'grouped'` (the default) this module registers
 * `sidebar.workspaces` at priority -1 and so shadows the shipped occupant
 * without patching a line of it — dropping the registration brings the shipped
 * list straight back, and `mode: 'native'` is one click away on this list
 * itself. Every row reads the document the card edits, so the two views cannot
 * disagree about where a project belongs.
 *
 * The list is drawn in the shell's own visual language: the metrics, colours
 * and states come from the shipped workspace browser (a 36px header, 34px
 * group headings, 32px project and session rows, the `--dsw-*` theme tokens),
 * and the controls are the shell's own `Menu`, `Modal`, `Input`, `InlineEditor`
 * and `Switch` from `@deepseek-ai/dsh-client-ui-primitives` — the module the
 * shipped browser itself draws with, so a menu, a dialog and a focus ring here
 * are the shell's, not a copy. The region's sheet keeps only what a control
 * needs to sit in this layout; when the host hands this bundle no UI kit, the
 * same rows fall back to the region's own inline field and popover rather than
 * losing their buttons.
 *
 * The occupant is a custom element rather than a React component, and that is
 * deliberate: a component registered from this plugin is rendered by the
 * shell's React but would carry hooks from *this* bundle — a second copy of
 * React in a second module scope — and crossing that line breaks every hook
 * inside it. A DOM element passes no foreign props at all, and this side can
 * mount into it because the loader gives this factory `require` (see
 * `window.__ModuleLoader__.load` at the top of `lib/framework.part.js`).
 *
 * Every control is wired to a client service — `uiWorkspace` opens, starts and
 * archives sessions, `sessions` renames and forks them, `workspaces` renames
 * and removes a project — and a control whose service the host does not
 * provide is either disabled or says so (`sidebar.list.readonly`) instead of
 * silently doing nothing.
 *
 * @module dsh-homepage/cards/sidebar-list
 */
    /** The tag the sidebar region mounts. */
    var SIDEBAR_TAG = 'homepage-sidebar'
    /** Below every shipped entry, so this one shadows while it is registered. */
    var SIDEBAR_OCCUPANT_PRIORITY = -1
    /** How long typing settles before a content search runs. */
    var SIDEBAR_SEARCH_DELAY = 180
    /**
     * The container width at which the header trades its bar for the rail. The
     * stylesheet decides this in a container query; this mirror exists because
     * only the shape the query keeps may mount the shell's `Menu`.
     */
    var SIDEBAR_RAIL_WIDTH = 120

    var sbReact = kit.React
    /** The defined custom element, or null before `sbDefineElement` runs. */
    var sbElement = null
    /** One React root per mounted region element. */
    var sbRoots = new Map()
    /** `react-dom/client`, or null when the shell does not hand it over. */
    var sbReactDom = (function () {
      try {
        var client = require('react-dom/client')
        return client && typeof client.createRoot === 'function' ? client : null
      } catch (error) {
        return null
      }
    })()
    /**
     * The shell's own UI kit, or null when this bundle was handed none. It is
     * the module the shipped workspace browser itself draws with, so a menu and
     * a dialog here are the shell's, not a copy — and `inline` mode requires it
     * by name, like `react-dom/client` above, because the loader resolves
     * platform modules and this bundle cannot fetch anything at runtime.
     */
    var sbKit = (function () {
      try {
        if (typeof require !== 'function') return null
        var ui = require('@deepseek-ai/dsh-client-ui-primitives')
        return ui && typeof ui === 'object' ? ui : null
      } catch (error) {
        return null
      }
    })()

    /**
     * @param key - dictionary key.
     * @param params - interpolation values.
     * @returns the text.
     */
    function sbT(key, params) { return kit.runtime.t(key, params) }

    /**
     * Choose which list owns the sidebar region. One document, one writer: the
     * framework debounces the save and the host normalises what comes back.
     * @param mode - `'native'` (the shipped list) or `'grouped'`.
     */
    function sbSetMode(mode) {
      void kit.mutateSidebarLayout(function (live) { return kit.withMode(live, mode) })
    }

    /** @param value - anything. @returns a string, never null/undefined. */
    function sbText(value) {
      if (value === null || value === undefined) return ''
      return String(value)
    }
    /** @param value - a path. @returns its last segment, both separators accepted. */
    function sbBase(value) {
      var path = sbText(value)
      if (path === '') return ''
      var cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
      return cut >= 0 ? path.slice(cut + 1) : path
    }
    /**
     * @param value - epoch milliseconds.
     * @returns a compact relative label, or '' when there is no timestamp.
     */
    function sbWhen(value) {
      var ms = Number(value)
      if (!ms || !isFinite(ms)) return ''
      var seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
      if (seconds < 90) return sbT('sidebar.when.now')
      var minutes = Math.round(seconds / 60)
      if (minutes < 60) return sbT('sidebar.when.minutes', { count: minutes })
      var hours = Math.round(minutes / 60)
      if (hours < 24) return sbT('sidebar.when.hours', { count: hours })
      return sbT('sidebar.when.days', { count: Math.round(hours / 24) })
    }
    /**
     * @param project - a projected project.
     * @returns the name to draw, falling back to the folder and then the id.
     */
    function sbProjectName(project) {
      var title = sbText(project && project.title).trim()
      if (title !== '') return title
      var base = sbBase(project && project.path)
      if (base !== '') return base
      return sbText(project && project.id)
    }
    /**
     * @param row - a projected session row.
     * @returns the label to draw.
     */
    function sbSessionName(row) {
      if (!row) return ''
      if (row.blank) return sbT('sidebar.session.new')
      var display = sbText(row.display).trim()
      if (display !== '') return display
      var title = sbText(row.title).trim()
      if (title !== '') return title
      return sbT('sidebar.session.untitled')
    }
    /** @param error - anything thrown. @returns a message for the region. */
    function sbReason(error) {
      if (!error) return 'unknown'
      return error && error.message ? String(error.message) : String(error)
    }
    /**
     * @param name - a key in `kit.sidebarServices`.
     * @returns the captured client service, or null when the host has none.
     */
    function sbService(name) {
      var services = kit.sidebarServices
      return services && services[name] ? services[name] : null
    }
    /**
     * @param name - a key in `kit.sidebarServices`.
     * @param method - the method the control needs.
     * @returns true when the host provides that exact call.
     */
    function sbHas(name, method) {
      var service = sbService(name)
      return !!(service && typeof service[method] === 'function')
    }
    /**
     * @param rows - projected session rows.
     * @param sessionId - a session id.
     * @returns true when that session is one of the rows.
     */
    function sbContains(rows, sessionId) {
      if (!sessionId) return false
      for (var i = 0; i < rows.length; i += 1) {
        if (sbText(rows[i] && rows[i].id) === sessionId) return true
      }
      return false
    }
    /** @returns true when the shell handed this bundle its UI kit. */
    function sbKitReady() { return !!(sbKit && typeof sbKit.Menu === 'function') }
    /**
     * @param name - an icon name in `kit.ICONS`.
     * @param size - the pixel box.
     * @returns the glyph, or null when the icon set has no such name. The
     * names stay internal, so a missing one costs a glyph and never a crash.
     */
    function sbGlyph(name, size) {
      var draw = kit.ICONS && kit.ICONS[name]
      if (typeof draw !== 'function') return null
      return draw(size || 16)
    }
    /**
     * A project's own recency: the newest session it shows. A project with no
     * sessions stays at zero on purpose — it has nothing to be recent about, and
     * borrowing its neighbours' time would make it outrank a project in use.
     *
     * A blank row is skipped: it is the draft the shell holds for a workspace
     * you focused, never sent, so it is not an event and cannot make a project
     * recent. All its `updatedAt` ever says is when the draft was made.
     * @param project - a projected project.
     * @returns the newest `updatedAt` below it, or 0.
     */
    function sbProjectAt(project) {
      var rows = Array.isArray(project && project.rows) ? project.rows : []
      var at = 0
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i] && rows[i].blank === true) continue
        var value = Number(rows[i] && rows[i].updatedAt) || 0
        if (value > at) at = value
      }
      return at
    }

    /**
     * Order one section's projects: the pinned ones first (in the order the
     * section was given), then the rest either in that same order or, when the
     * section asks for it, newest first.
     * @param section - a section with `items` and `sort`.
     * @param layout - the document, for each project's member record.
     * @returns nothing; the section's `items` are reordered in place.
     */
    function sbOrderSection(section, layout) {
      if (!section || !Array.isArray(section.items)) return
      var pinned = []
      var rest = []
      for (var i = 0; i < section.items.length; i += 1) {
        var project = section.items[i]
        var member = kit.sidebarMemberOf(layout, project && project.id)
        if (member && member.pinned === true) pinned.push(project)
        else rest.push(project)
      }
      if (section.sort === 'recent') {
        rest.sort(function (left, right) { return sbProjectAt(right) - sbProjectAt(left) })
      }
      section.items = pinned.concat(rest)
    }

    /**
     * The sections the list draws: every group in document order, then the
     * ungrouped bucket. Members are the projects the sidebar listed plus any
     * the document still names, so a stale assignment stays visible and
     * removable instead of silently disappearing.
     * @param layout - the document, or null.
     * @param items - the projected projects.
     * @returns the sections, each `{ key, title, color, items, collapsed, sort }`.
     */
    function sbSections(layout, items) {
      var projects = Array.isArray(items) ? items : []
      var groups = kit.sidebarGroups(layout).slice().sort(function (left, right) {
        var a = left && typeof left.order === 'number' ? left.order : 0
        var b = right && typeof right.order === 'number' ? right.order : 0
        return a - b
      })
      var sections = groups.map(function (group) {
        return {
          key: sbText(group && group.id),
          title: sbText(group && group.title),
          color: group && group.color ? String(group.color) : null,
          collapsed: !!(group && group.collapsed),
          sort: group && group.sort === 'recent' ? 'recent' : 'manual',
          items: [],
        }
      })
      var byId = {}
      for (var i = 0; i < sections.length; i += 1) byId[sections[i].key] = sections[i]
      var loose = { key: '', title: sbT('sidebar.group.ungrouped'), color: null, collapsed: false, sort: 'manual', items: [], loose: true }
      var known = {}
      for (var p = 0; p < projects.length; p += 1) {
        var project = projects[p]
        known[sbText(project && project.id)] = true
        var member = kit.sidebarMemberOf(layout, project && project.id)
        var section = member && member.group && byId[member.group] ? byId[member.group] : loose
        section.items.push(project)
      }
      var members = kit.sidebarMembers(layout)
      Object.keys(members).forEach(function (id) {
        if (known[id]) return
        var member = members[id]
        var section = member && member.group && byId[member.group] ? byId[member.group] : loose
        section.items.push({ id: id, title: '', path: '', sessions: 0, rows: [], orphan: true })
      })
      var out = sections.slice()
      if (loose.items.length > 0) out.push(loose)
      for (var s = 0; s < out.length; s += 1) sbOrderSection(out[s], layout)
      return out
    }
    /**
     * How many sessions one project stands for. A project the sidebar still
     * lists brings its rows; one it no longer lists (a stale assignment, drawn
     * from its id alone) falls back to the count the document recorded, and an
     * empty one is honestly zero.
     * @param project - a projected project.
     * @returns the number of sessions.
     */
    function sbSessionCount(project, current) {
      var rows = Array.isArray(project && project.rows) ? project.rows : []
      // Rows the sidebar reported: print what is actually listed underneath, so a
      // project whose sessions are all archived — or whose only row is a draft
      // held for another workspace — reads as empty instead of promising rows it
      // will not draw.
      if (rows.length > 0) return sbOrderRows(rows, current).length
      return Number(project && project.sessions) || 0
    }

    /**
     * Whether one project's sessions are drawn. The shipped sidebar leaves every
     * workspace closed until it is opened, and opens the one holding the current
     * Session by itself; a stored answer wins from the moment there is one, so a
     * row the user closed stays closed even while a session in it is current.
     * @param layout - the document, or null.
     * @param id - the project's workspace id.
     * @param holdsCurrent - whether the current Session lives in this project.
     * @returns whether the row is open.
     */
    function sbProjectOpen(layout, id, holdsCurrent) {
      return kit.sidebarExpandedOf(layout, id, holdsCurrent === true)
    }

    /**
     * A group's heading count is the sessions it holds, not the projects it
     * lists: the projects are drawn right underneath it, so the number worth
     * printing is the one the reader cannot see.
     * @param section - a group section.
     * @param current - the current session id, or ''.
     * @returns the number of sessions below it.
     */
    function sbSectionCount(section, current) {
      var items = Array.isArray(section && section.items) ? section.items : []
      return items.reduce(function (sum, project) { return sum + sbSessionCount(project, current) }, 0)
    }

    /**
     * Is one row drawn at all? Archived sessions drop out — the tree does not
     * list them, the shipped browser keeps them behind its own archive view — and
     * a blank row drops out unless it is the current Session: the shell's
     * provisional New Session belongs to the one workspace it was made in, and
     * focusing anywhere else takes it away again.
     * @param row - a projected session row.
     * @param current - the current session id, or ''.
     * @returns whether the row is drawn.
     */
    function sbRowVisible(row, current) {
      if (!row || row.archived === true) return false
      return row.blank !== true || (current !== '' && sbText(row.id) === current)
    }
    /**
     * A row's position class: 0 for the provisional New Session, 1 for pinned,
     * 2 for the rest. The shipped browser draws the blank row above the pinned
     * ones rather than among them — it is the row the user is about to type into,
     * so nothing outranks it, and it has no `updatedAt` worth sorting by.
     * @param row - a projected session row.
     * @returns the rank.
     */
    function sbRowRank(row) {
      if (row && row.blank === true) return 0
      return row && row.pinned === true ? 1 : 2
    }
    /**
     * Session rows in drawing order: the provisional row on top, then pinned,
     * then most recent — the order the shipped browser uses. Rows the list does
     * not draw are dropped here, so a count taken of the result is the count of
     * rows really underneath and a draft cannot pass as a sent session.
     * @param rows - the projected rows.
     * @param current - the current session id, or ''.
     * @returns a sorted copy of the drawn rows.
     */
    function sbOrderRows(rows, current) {
      var list = Array.isArray(rows) ? rows : []
      var listed = []
      for (var i = 0; i < list.length; i += 1) {
        if (sbRowVisible(list[i], current)) listed.push(list[i])
      }
      return listed.sort(function (left, right) {
        var p = sbRowRank(left)
        var q = sbRowRank(right)
        if (p !== q) return p - q
        return (Number(right && right.updatedAt) || 0) - (Number(left && left.updatedAt) || 0)
      })
    }

    // ------------------------------------------------------------- controls

    /**
     * One icon button: the shape every control in this region uses, from the
     * header to a row's hover cluster. It is a real `<button>`, so the host
     * keyboard and focus ring work without a handler of ours.
     * @param name - an icon in `kit.ICONS`.
     * @param title - the label and the tooltip.
     * @param onClick - the handler.
     * @param extra - `{ key, sb, open, disabled, size, className }`.
     * @returns the element.
     */
    function sbIconButton(name, title, onClick, extra) {
      var options = extra || {}
      var className = 'ph-sb-icon' + (options.className ? ' ' + options.className : '')
      return h('button', {
        key: options.key,
        className: className,
        type: 'button',
        title: title,
        'aria-label': title,
        'aria-expanded': options.open === undefined ? undefined : (options.open ? true : false),
        'data-sb': options.sb,
        disabled: options.disabled ? true : undefined,
        onClick: onClick,
      }, sbGlyph(name, options.size || 16))
    }

    /**
     * A colour swatch: the filled circle a menu item shows instead of a glyph.
     * The entries carry it as an element, so the same swatch draws in the
     * shell's menu and in the region's own popover.
     * @param color - a CSS colour.
     * @returns the element.
     */
    function sbSwatch(color) {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
        h('circle', { cx: 12, cy: 12, r: 8, fill: color }))
    }

    /**
     * @param entries - the region's menu model.
     * @returns the shell's `MenuItem` list, so the same description draws the
     * shell's menu and the region's own popover.
     */
    function sbMenuItems(entries) {
      var out = []
      for (var i = 0; i < entries.length; i += 1) {
        var entry = entries[i]
        if (entry.type === 'separator') {
          out.push({ type: 'separator', id: entry.id })
          continue
        }
        if (entry.type === 'label') {
          out.push({ type: 'label', id: entry.id, text: entry.label })
          continue
        }
        out.push({
          id: entry.id,
          label: entry.label,
          icon: typeof entry.icon === 'string' ? sbGlyph(entry.icon, 16) : (entry.icon || undefined),
          disabled: entry.disabled ? true : undefined,
          danger: entry.danger ? true : undefined,
          submenu: entry.submenu ? sbMenuItems(entry.submenu) : undefined,
        })
      }
      return out
    }

    /**
     * @param entries - the region's menu model.
     * @returns the flat list the region's own popover draws: a submenu becomes
     * a labelled block, which is what a popover without nesting can offer.
     */
    function sbPopoverRows(entries) {
      var out = []
      for (var i = 0; i < entries.length; i += 1) {
        var entry = entries[i]
        if (!entry.submenu) {
          out.push(entry)
          continue
        }
        out.push({ type: 'label', id: entry.id, label: entry.label })
        for (var j = 0; j < entry.submenu.length; j += 1) {
          if (entry.submenu[j].type === 'item') out.push(entry.submenu[j])
        }
      }
      return out
    }

    /**
     * A row's menu, drawn with the shell's own `Menu` when this bundle was
     * handed the UI kit: `anchor` is the trigger the menu renders in place, so
     * the row keeps the same single trigger either way.
     * @param key - React key.
     * @param open - whether this is the open menu.
     * @param anchor - the trigger element.
     * @param entries - the region's menu model.
     * @param onSelect - `(id) => void`.
     * @param onClose - callback.
     * @returns the element.
     */
    function sbMenu(key, open, anchor, entries, onSelect, onClose) {
      if (!sbKitReady()) return anchor
      return h(sbKit.Menu, {
        key: key,
        open: open === true,
        anchor: anchor,
        items: sbMenuItems(entries),
        onSelect: onSelect,
        onClose: onClose,
        align: 'end',
        portal: true,
      })
    }

    /**
     * The region's own popover, for the case where the host hands this bundle
     * no UI kit: the same entries, drawn by the region's own sheet.
     * @param entries - the region's menu model.
     * @param at - `{ x, y }` in client coordinates.
     * @param onSelect - `(id) => void`.
     * @returns the element.
     */
    function sbPopover(entries, at, onSelect) {
      var items = sbPopoverRows(entries)
      var rows = []
      for (var i = 0; i < items.length; i += 1) rows.push(sbPopoverEntry(items[i], onSelect, i))
      return h('div', { className: 'ph-sb-pop-layer', key: 'layer', 'data-sb': 'popLayer' },
        h('div', {
          className: 'ph-sb-pop',
          'data-sb': 'pop',
          style: { position: 'fixed', left: Math.max(8, Math.round((at && at.x) || 8)) + 'px', top: Math.round(((at && at.y) || 0) + 4) + 'px' },
        }, rows))
    }

    /**
     * One entry of the region's own popover.
     * @param entry - a menu entry.
     * @param onSelect - `(id) => void`.
     * @param index - its position, for the keys a separator and a label lack.
     * @returns the element.
     */
    function sbPopoverEntry(entry, onSelect, index) {
      if (entry.type === 'separator') return h('div', { className: 'ph-sb-pop-sep', key: entry.id || 'sep' + index })
      if (entry.type === 'label') return h('div', { className: 'ph-sb-pop-label', key: entry.id || 'label' + index }, entry.label)
      return h('button', {
        className: 'ph-sb-pop-item' + (entry.danger ? ' is-danger' : '') + (entry.current ? ' is-current' : ''),
        key: entry.id,
        type: 'button',
        'data-sb': 'menuItem',
        'data-id': entry.id,
        disabled: entry.disabled ? true : undefined,
        onClick: function () { onSelect(entry.id) },
      }, [
        entry.icon
          ? h('span', { className: 'ph-sb-slot', key: 'icon' },
            typeof entry.icon === 'string' ? sbGlyph(entry.icon, 16) : entry.icon)
          : null,
        h('span', { className: 'ph-sb-pop-text', key: 'text' }, entry.label),
      ])
    }

    /**
     * The control that edits one name. The shell's `InlineEditor` when it is
     * available — the same field the shipped browser renames with — and this
     * region's own field, with the region's own confirm buttons, when it is
     * not. Both are driven by the component's draft state, so Enter saves,
     * Escape cancels, and an empty name is never committed.
     * @param label - what is being renamed.
     * @param onSave - commit.
     * @param onCancel - abandon.
     * @param draft - the current text.
     * @param onChange - `(value) => void`.
     * @returns the element.
     */
    function sbEditor(label, draft, onChange, onSave, onCancel) {
      if (sbKitReady() && typeof sbKit.InlineEditor === 'function') {
        return h(sbKit.InlineEditor, {
          value: draft,
          label: label,
          onChange: onChange,
          onSave: onSave,
          onCancel: onCancel,
        })
      }
      return h('span', { className: 'ph-sb-title-editing' }, [
        h('input', {
          className: 'ph-sb-field',
          key: 'field',
          type: 'text',
          value: draft,
          'aria-label': label,
          autoFocus: true,
          onChange: function (event) { onChange(event && event.target ? sbText(event.target.value) : '') },
          onKeyDown: function (event) {
            if (!event || !event.key) return
            if (event.key === 'Enter') onSave()
            else if (event.key === 'Escape') onCancel()
          },
        }),
        h('button', {
          className: 'ph-sb-icon',
          key: 'save',
          type: 'button',
          title: sbT('sidebar.list.apply'),
          'aria-label': sbT('sidebar.list.apply'),
          'data-sb': 'editorSave',
          onClick: onSave,
        }, sbGlyph('check', 16)),
        h('button', {
          className: 'ph-sb-icon',
          key: 'cancel',
          type: 'button',
          title: sbT('sidebar.group.cancel'),
          'aria-label': sbT('sidebar.group.cancel'),
          'data-sb': 'editorCancel',
          onClick: onCancel,
        }, sbGlyph('close', 16)),
      ])
    }

    /**
     * The dialog that confirms a destructive change — the same `sbDialog` the
     * other dialogs go through, so it is themed and dismissible like them.
     * @param label - the dialog title, already interpolated.
     * @param onConfirm - the destructive action.
     * @param onCancel - abandon.
     * @returns the element.
     */
    function sbConfirm(label, onConfirm, onCancel) {
      return sbDialog(label, null, [
        sbButton(sbT('sidebar.group.cancel'), {
          key: 'cancel',
          sb: 'confirmCancel',
          variant: 'outline',
          onClick: onCancel,
        }),
        sbButton(sbT('sidebar.list.apply'), {
          key: 'ok',
          sb: 'confirmOk',
          variant: 'primary',
          className: 'ph-sb-danger',
          onClick: onConfirm,
        }),
      ], onCancel)
    }

    /**
     * One of the region's dialogs. The shell's `Modal` when the kit is there —
     * drawn with the shell's own surface and tokens, focus-trapped, and closed
     * by Escape, the close control or a mask click — and the region's own card
     * when it is not. The fallback is centred: a dialog pinned to a corner
     * landed in the page's top-left whichever control opened it, and the layer
     * under it used to keep the page from being clicked at all.
     * @param title - the dialog title.
     * @param body - the content.
     * @param footer - the action row, or null.
     * @param onCancel - close.
     * @returns the element.
     */
    function sbDialog(title, body, footer, onCancel) {
      if (sbKitReady() && typeof sbKit.Modal === 'function') {
        return h('div', { className: 'ph-sb-modal', key: 'layer' }, h(sbKit.Modal, {
          open: true,
          onClose: onCancel,
          title: title,
          closeLabel: sbT('sidebar.group.cancel'),
          footer: footer,
        }, body))
      }
      return h('div', {
        className: 'ph-sb-pop-layer ph-sb-pop-layer--center',
        key: 'layer',
        onMouseDown: function (event) {
          if (!event || event.target === event.currentTarget) onCancel()
        },
      }, h('div', { className: 'ph-sb-pop ph-sb-pop--dialog' }, [
        h('div', { className: 'ph-sb-dialog-title', key: 'title' }, title),
        h('div', { className: 'ph-sb-dialog-body', key: 'body' }, body),
        footer ? h('div', { className: 'ph-sb-form-actions', key: 'actions' }, footer) : null,
      ]))
    }

    /**
     * One dialog action. The shipped directory dialog draws its footer with the
     * kit's `Button` — outline for the secondary actions, primary for the
     * commit, the quiet variant for a toggle — so this region uses the same
     * atom instead of reusing a menu row, whose transparent background and
     * left-aligned text read as unstyled next to the shell's own dialogs.
     * @param label - the button text.
     * @param opts - `{ key, sb, variant, size, icon, title, pressed, disabled, onClick }`.
     * @returns the button.
     */
    function sbButton(label, opts) {
      var o = opts || {}
      var variant = o.variant || 'outline'
      var size = o.size || 'md'
      var pressed = o.pressed === undefined ? undefined : (o.pressed ? 'true' : 'false')
      if (sbKitReady() && typeof sbKit.Button === 'function') {
        var props = {
          key: o.key,
          variant: variant,
          size: size,
          className: o.className,
          'data-sb': o.sb,
          title: o.title,
          disabled: o.disabled ? true : undefined,
          'aria-pressed': pressed,
          onClick: o.onClick,
        }
        if (o.icon) props.icon = sbGlyph(o.icon, 14)
        return h(sbKit.Button, props, label)
      }
      return h('button', {
        className: 'ph-sb-btn ph-sb-btn--' + variant + (size === 'sm' ? ' ph-sb-btn--sm' : '') +
          (o.className ? ' ' + o.className : ''),
        key: o.key,
        type: 'button',
        'data-sb': o.sb,
        title: o.title,
        'aria-pressed': pressed,
        disabled: o.disabled ? true : undefined,
        onClick: o.onClick,
      }, [
        o.icon ? h('span', { className: 'ph-sb-btn-icon', key: 'icon' }, sbGlyph(o.icon, 14)) : null,
        h('span', { key: 'label' }, label),
      ])
    }

    /**
     * One text field for a dialog: the bordered control the shell draws inside
     * its own modals, not the borderless inline editor used to rename a row in
     * place. Enter commits and Escape closes, as in every shell dialog.
     * @param label - accessible name and placeholder.
     * @param value - the draft.
     * @param onChange - receives the edited text.
     * @param onSave - Enter.
     * @param onCancel - Escape.
     * @returns the field.
     */
    function sbField(label, value, onChange, onSave, onCancel) {
      return h('input', {
        className: 'ph-sb-field',
        type: 'text',
        value: value,
        'aria-label': label,
        placeholder: label,
        autoFocus: true,
        'data-sb': 'field',
        onChange: function (event) {
          onChange(event && event.target ? sbText(event.target.value) : '')
        },
        onKeyDown: function (event) {
          if (!event || !event.key) return
          if (event.key === 'Enter') onSave()
          else if (event.key === 'Escape') onCancel()
        },
      })
    }

    /**
     * The region's own directory browser. It is the answer for a Host that has
     * no native chooser — a browser connected to a non-loopback address, where
     * `uiWorkspace.pickDirectory` answers with a failure — and it repeats what
     * the shipped sidebar does in that mode: ask the Host to list one directory
     * level at a time (`uiWorkspace.listDirectory`), then register the folder
     * the reader settles on as a Workspace (`workspaces.create`). Nothing here
     * reads the disk itself; every listing and every created folder is the
     * Host's answer.
     * @param props - `{ onCancel, onPicked }`.
     * @returns the dialog.
     */
    function SidebarDirectoryDialog(props) {
      var onCancel = props && typeof props.onCancel === 'function' ? props.onCancel : function () {}
      var onPicked = props && typeof props.onPicked === 'function' ? props.onPicked : function () {}
      var pair = sbReact.useState({
        path: '',
        listing: null,
        phase: 'loading',
        error: '',
        busy: false,
        folder: '',
        minting: false,
        showHidden: false,
        pathDraft: null,
      })
      var state = pair[0]
      var setState = pair[1]
      var seq = sbReact.useRef(0)
      var alive = sbReact.useRef(true)

      /** @param next - the fields to change. */
      function patch(next) {
        setState(function (prev) {
          var merged = {}
          for (var key in prev) merged[key] = prev[key]
          for (var name in next) merged[name] = next[name]
          return merged
        })
      }
      /**
       * Read one level. An absent path is the Host's home, which is where the
       * shipped browser starts too. A failed read opens the path editor on the
       * path that failed, so a typo can be corrected where it was made instead
       * of ending the dialog.
       * @param path - the directory to list.
       */
      function browse(path) {
        var service = sbService('uiWorkspace')
        if (!service || typeof service.listDirectory !== 'function') {
          patch({ phase: 'error', error: sbT('sidebar.list.readonly') })
          return
        }
        var token = seq.current + 1
        seq.current = token
        var attempted = sbText(path)
        patch({ phase: 'loading', error: '', path: attempted })
        var outcome = null
        try {
          outcome = service.listDirectory(path)
        } catch (error) {
          if (!alive.current) return
          patch({
            phase: 'error',
            pathDraft: attempted,
            error: sbT('sidebar.list.dirFailed', { reason: sbReason(error) }),
          })
          return
        }
        if (!outcome || typeof outcome.then !== 'function') return
        outcome.then(function (listing) {
          if (!alive.current || seq.current !== token) return
          var view = listing && typeof listing === 'object' ? listing : {}
          patch({ phase: 'ready', listing: view, path: sbText(view.path), pathDraft: null, error: '' })
        }, function (error) {
          if (!alive.current || seq.current !== token) return
          patch({
            phase: 'error',
            pathDraft: attempted,
            error: sbT('sidebar.list.dirFailed', { reason: sbReason(error) }),
          })
        })
      }
      /** Read the path typed into the crumb bar. */
      function goPath() {
        var target = sbText(state.pathDraft).trim()
        if (target === '') return
        browse(target)
      }
      sbReact.useEffect(function () {
        alive.current = true
        browse()
        return function () {
          alive.current = false
          seq.current += 1
        }
      }, [])

      /** Register the folder on screen as a workspace. */
      function adopt() {
        var listing = state.listing
        var path = sbText(listing && listing.path)
        if (path === '') return
        var projects = sbService('workspaces')
        if (!projects || typeof projects.create !== 'function') {
          patch({ error: sbT('sidebar.list.readonly'), phase: 'error' })
          return
        }
        patch({ busy: true, error: '' })
        var outcome = null
        try {
          outcome = projects.create({ path: path })
        } catch (error) {
          patch({ busy: false, phase: 'error', error: sbT('sidebar.list.failed', { reason: sbReason(error) }) })
          return
        }
        if (!outcome || typeof outcome.then !== 'function') {
          onPicked()
          return
        }
        outcome.then(function () {
          if (alive.current) onPicked()
        }, function (error) {
          if (!alive.current) return
          patch({ busy: false, phase: 'error', error: sbT('sidebar.list.failed', { reason: sbReason(error) }) })
        })
      }
      /** Create the folder named in the field, then open it. */
      function mint() {
        var name = sbText(state.folder).trim()
        var listing = state.listing
        if (name === '' || !listing) return
        var service = sbService('uiWorkspace')
        if (!service || typeof service.createDirectory !== 'function') {
          patch({ error: sbT('sidebar.list.readonly'), phase: 'error' })
          return
        }
        var parent = sbText(listing.path)
        patch({ busy: true, error: '' })
        var outcome = null
        try {
          outcome = service.createDirectory(parent, name)
        } catch (error) {
          patch({ busy: false, phase: 'error', error: sbT('sidebar.list.failed', { reason: sbReason(error) }) })
          return
        }
        if (!outcome || typeof outcome.then !== 'function') return
        outcome.then(function (created) {
          if (!alive.current) return
          patch({ busy: false, folder: '', minting: false })
          browse(sbText(created) || parent)
        }, function (error) {
          if (!alive.current) return
          patch({ busy: false, phase: 'error', error: sbT('sidebar.list.failed', { reason: sbReason(error) }) })
        })
      }

      var listing = state.listing
      var crumbs = listing && Array.isArray(listing.crumbs) ? listing.crumbs : []
      var allEntries = listing && Array.isArray(listing.entries) ? listing.entries : []
      // Hidden folders are off by default, exactly like the shipped browser:
      // its footer carries the toggle that brings them back.
      var entries = state.showHidden === true
        ? allEntries
        : allEntries.filter(function (entry) { return !(entry && entry.hidden) })
      var hidden = entries.length === 0 && allEntries.length > 0
      var here = sbText(listing && listing.path) || state.path
      // The crumb bar doubles as the path editor: the shipped browser lets a
      // reader type an absolute path instead of walking to it, which is the
      // only way to reach a folder the trail cannot offer.
      var crumbTrail = crumbs.length > 0
        ? crumbs.map(function (crumb, index) {
          var path = sbText(crumb && crumb.path)
          var last = index === crumbs.length - 1
          // The shipped browser seats every crumb behind a chevron on the
          // same row, so the trail reads as one path rather than as a list
          // of unrelated words.
          return h('span', { className: 'ph-sb-dir-seat', key: 'crumb:' + (path || index) }, [
            index > 0
              ? h('span', { className: 'ph-sb-dir-chev', key: 'chev' }, sbGlyph('chevron', 12))
              : null,
            h('button', {
              className: 'ph-sb-dir-crumb' + (last ? ' is-current' : ''),
              key: 'label',
              type: 'button',
              title: path,
              'data-sb': 'dirCrumb',
              'data-path': path,
              onClick: function () { browse(path) },
            }, sbText(crumb && crumb.name) || path),
          ])
        })
        : h('span', { className: 'ph-sb-dir-crumb is-current', key: 'here' },
          here !== '' ? here : sbT('sidebar.list.dirHome'))
      var pathRow = state.pathDraft !== null
        ? h('div', { className: 'ph-sb-dir-path', key: 'path' }, [
          h('input', {
            className: 'ph-sb-field ph-sb-dir-path-field',
            key: 'field',
            type: 'text',
            value: state.pathDraft,
            autoFocus: true,
            spellcheck: false,
            'aria-label': sbT('sidebar.list.editPath'),
            placeholder: sbT('sidebar.list.editPath'),
            'data-sb': 'dirPath',
            onChange: function (event) {
              patch({ pathDraft: event && event.target ? sbText(event.target.value) : '' })
            },
            onKeyDown: function (event) {
              if (!event || !event.key) return
              if (event.key === 'Enter') {
                if (event.stopPropagation) event.stopPropagation()
                goPath()
              } else if (event.key === 'Escape') {
                // Escape drops the draft; it must not also close the dialog.
                if (event.stopPropagation) event.stopPropagation()
                patch({ pathDraft: null })
              }
            },
          }),
        ])
        : h('div', { className: 'ph-sb-dir-crumbs', key: 'crumbs' }, [
          crumbTrail,
          sbIconButton('edit', sbT('sidebar.list.editPath'), function () {
            patch({ pathDraft: here })
          }, { key: 'edit', sb: 'dirEditPath', size: 14, className: 'ph-sb-dir-edit' }),
        ])
      var body = h('div', { className: 'ph-sb-dir', key: 'dir' }, [
        pathRow,
        state.phase === 'loading'
          ? h('div', { className: 'ph-sb-dir-note', key: 'loading' }, sbT('sidebar.list.dirLoading'))
          : null,
        entries.length > 0
          ? h('div', { className: 'ph-sb-dir-list', key: 'list' }, entries.map(function (entry, index) {
            var path = sbText(entry && entry.path)
            return h('button', {
              className: 'ph-sb-dir-row' + (entry && entry.hidden ? ' is-hidden' : ''),
              key: 'entry:' + (path || index),
              type: 'button',
              'data-sb': 'dirRow',
              'data-path': path,
              onClick: function () { browse(path) },
            }, [
              h('span', { className: 'ph-sb-dir-icon', key: 'icon' }, sbGlyph('folder', 15)),
              h('span', { className: 'ph-sb-dir-name', key: 'name' }, sbText(entry && entry.name)),
            ])
          }))
          : state.phase === 'ready'
            ? h('div', { className: 'ph-sb-dir-note', key: 'empty' },
              sbT(hidden ? 'sidebar.list.dirHiddenOnly' : 'sidebar.list.dirEmpty'))
            : null,
        listing && listing.truncated
          ? h('div', { className: 'ph-sb-dir-note', key: 'truncated' }, sbT('sidebar.list.dirTruncated'))
          : null,
        state.minting
          ? h('div', { className: 'ph-sb-dir-newfold', key: 'mint' }, [
            h('input', {
              className: 'ph-sb-field',
              key: 'name',
              type: 'text',
              value: state.folder,
              'aria-label': sbT('sidebar.list.folderName'),
              placeholder: sbT('sidebar.list.folderName'),
              'data-sb': 'dirFolderName',
              onChange: function (event) {
                patch({ folder: event && event.target ? sbText(event.target.value) : '' })
              },
              onKeyDown: function (event) {
                if (!event || !event.key) return
                if (event.key === 'Enter') mint()
                else if (event.key === 'Escape') patch({ minting: false, folder: '' })
              },
            }),
            sbButton(sbT('sidebar.list.create'), {
              key: 'create',
              sb: 'dirMint',
              variant: 'primary',
              size: 'sm',
              disabled: state.busy,
              onClick: mint,
            }),
            sbButton(sbT('sidebar.group.cancel'), {
              key: 'cancel',
              sb: 'dirMintCancel',
              variant: 'ghost',
              size: 'sm',
              onClick: function () { patch({ minting: false, folder: '' }) },
            }),
          ])
          : null,
        state.error !== ''
          ? h('div', { className: 'ph-sb-form-error', key: 'error', 'data-sb': 'dirError' }, state.error)
          : null,
      ])
      var choose = sbText(listing && listing.path) !== ''
      // The same footer the shipped browser draws: the two actions that change
      // the folder on the left, the confirm/cancel pair on the right, and the
      // hidden-items toggle between them — its label never shifts, because the
      // pressed state is shown by a trailing check rather than by another word.
      var shown = state.showHidden === true
      var footer = [
        sbButton(sbT('sidebar.list.newFolder'), {
          key: 'mint',
          sb: 'dirNewFolder',
          variant: 'outline',
          icon: 'plus',
          disabled: state.busy || !listing,
          onClick: function () { patch({ minting: true }) },
        }),
        h('button', {
          className: 'ph-sb-dir-toggle' + (shown ? ' is-on' : ''),
          key: 'hidden',
          type: 'button',
          'data-sb': 'dirShowHidden',
          'aria-pressed': shown ? 'true' : 'false',
          onClick: function () { patch({ showHidden: !shown }) },
        }, [
          h('span', { key: 'label' }, sbT('sidebar.list.showHidden')),
          shown ? h('span', { className: 'ph-sb-dir-toggle-check', key: 'check' }, sbGlyph('check', 14)) : null,
        ]),
        h('span', { className: 'ph-sb-dir-gap', key: 'gap' }),
        sbButton(sbT('sidebar.group.cancel'), {
          key: 'cancel',
          sb: 'dirCancel',
          variant: 'outline',
          onClick: onCancel,
        }),
        sbButton(sbT('sidebar.list.chooseFolder'), {
          key: 'choose',
          sb: 'dirChoose',
          variant: 'primary',
          disabled: state.busy || !choose,
          onClick: adopt,
        }),
      ]
      return sbDialog(sbT('sidebar.list.newProject'), body, footer, onCancel)
    }

    // --------------------------------------------------------------- menus

    /**
     * The project menu: everything that changes one project, in one list.
     * @param layout - the document, for the project's current group.
     * @param project - the projected project.
     * @param sections - every section, for the "move to" submenu.
     * @returns the entries.
     */
    function sbProjectMenu(layout, project, sections) {
      var id = sbText(project && project.id)
      if (project && project.orphan) {
        return [{ type: 'item', id: 'forget', label: sbT('sidebar.project.delete'), icon: 'trash', danger: true }]
      }
      var member = kit.sidebarMemberOf(layout, id)
      var home = member && member.group ? sbText(member.group) : ''
      var marked = member && member.color ? String(member.color) : ''
      var moves = sections.map(function (section) {
        var key = sbText(section.key)
        return { type: 'item', id: 'move:' + key, label: section.title, icon: key === home ? 'check' : undefined, current: key === home }
      })
      // The colours are the document's own palette, so a marker set here is the
      // same value the manager card shows.
      var colors = kit.SIDEBAR_COLORS.map(function (hex) {
        return { type: 'item', id: 'color:' + hex, label: String(hex).toUpperCase(), icon: sbSwatch(hex), current: marked === String(hex) }
      })
      colors.push({
        type: 'item',
        id: 'color:',
        label: sbT('sidebar.group.none'),
        icon: marked === '' ? 'check' : undefined,
        current: marked === '',
      })
      return [
        { type: 'item', id: 'newSession', label: sbT('sidebar.list.newSession'), icon: 'chat' },
        { type: 'item', id: 'rename', label: sbT('sidebar.list.rename'), icon: 'edit' },
        { type: 'separator', id: 'sep1' },
        {
          type: 'item',
          id: 'pin',
          label: sbT(member && member.pinned === true ? 'sidebar.project.unpin' : 'sidebar.project.pin'),
          icon: 'pin',
        },
        { type: 'item', id: 'color', label: sbT('sidebar.group.color'), icon: 'layers', submenu: colors },
        { type: 'separator', id: 'sep2' },
        { type: 'item', id: 'move', label: sbT('sidebar.project.move'), icon: 'folderOpen', submenu: moves },
        { type: 'separator', id: 'sep3' },
        { type: 'item', id: 'remove', label: sbT('sidebar.project.delete'), icon: 'trash', danger: true },
      ]
    }

    /**
     * The session menu: the two edits the client services take on a session,
     * its id, and the archive toggle.
     * @param row - the projected session row.
     * @returns the entries.
     */
    function sbSessionMenu(row) {
      var archived = !!(row && row.archived)
      return [
        { type: 'item', id: 'rename', label: sbT('sidebar.list.rename'), icon: 'edit' },
        { type: 'item', id: 'fork', label: sbT('sidebar.session.fork'), icon: 'branch' },
        { type: 'separator', id: 'sep1' },
        { type: 'item', id: 'copyId', label: sbT('sidebar.session.copyId'), icon: 'copy' },
        { type: 'separator', id: 'sep2' },
        archived
          ? { type: 'item', id: 'unarchive', label: sbT('sidebar.list.unarchive'), icon: 'archive' }
          : { type: 'item', id: 'archive', label: sbT('sidebar.session.archive'), icon: 'archive' },
      ]
    }

    /**
     * The group menu. The ungrouped bucket has no record of its own, so it can
     * only start a project there; and its order is the shell's own listing, so
     * it has no sort of its own either.
     * @param section - a group section.
     * @returns the entries.
     */
    function sbGroupMenu(section) {
      var key = sbText(section && section.key)
      if (key === '') {
        return [{ type: 'item', id: 'newProject', label: sbT('sidebar.list.newProject'), icon: 'plus' }]
      }
      var recent = section && section.sort === 'recent'
      var marked = section && section.color ? String(section.color) : ''
      var colors = kit.SIDEBAR_COLORS.map(function (hex) {
        return { type: 'item', id: 'color:' + hex, label: String(hex).toUpperCase(), icon: sbSwatch(hex), current: marked === String(hex) }
      })
      colors.push({
        type: 'item',
        id: 'color:',
        label: sbT('sidebar.group.none'),
        icon: marked === '' ? 'check' : undefined,
        current: marked === '',
      })
      return [
        { type: 'item', id: 'newProject', label: sbT('sidebar.list.newProject'), icon: 'plus' },
        { type: 'item', id: 'rename', label: sbT('sidebar.list.rename'), icon: 'edit' },
        { type: 'separator', id: 'sep1' },
        { type: 'item', id: 'color', label: sbT('sidebar.group.color'), icon: 'layers', submenu: colors },
        {
          type: 'item',
          id: 'sort',
          label: sbT(recent ? 'sidebar.group.sortManual' : 'sidebar.group.sortRecent'),
          icon: recent ? 'check' : 'refresh',
        },
        { type: 'separator', id: 'sep2' },
        { type: 'item', id: 'delete', label: sbT('sidebar.group.delete'), icon: 'trash', danger: true },
      ]
    }

    /**
     * The header's add menu: the two things that put something new in the list.
     * @returns the entries.
     */
    function sbAddMenu() {
      return [
        { type: 'item', id: 'newProject', label: sbT('sidebar.list.addProject'), icon: 'folderOpen' },
        { type: 'item', id: 'newGroup', label: sbT('sidebar.list.newGroup'), icon: 'plus' },
      ]
    }

    // ------------------------------------------------------------- the list

    /**
     * The list. It has no `useWorkspaces` prop of its own — it is mounted by a
     * plain DOM element, not by a slot — so it reads the projection the
     * reporter publishes into the shared store, which carries the same facts.
     * @returns the element.
     */
    function SidebarProjects() {
      var store = kit.useSidebarLayout()
      var layout = store.layout || null
      var items = Array.isArray(store.workspaces) ? store.workspaces : []
      var sections = sbSections(layout, items)
      var current = sbText(store.current)
      var ready = sbKitReady()

      var searchPair = sbReact.useState(false)
      var searchOpen = searchPair[0]
      var setSearchOpen = searchPair[1]
      var queryPair = sbReact.useState('')
      var query = queryPair[0]
      var setQuery = queryPair[1]
      var resultPair = sbReact.useState(null)
      var results = resultPair[0]
      var setResults = resultPair[1]
      var pendingPair = sbReact.useState(false)
      var pending = pendingPair[0]
      var setPending = pendingPair[1]
      var menuPair = sbReact.useState(null)
      var menu = menuPair[0]
      var setMenu = menuPair[1]
      var editorPair = sbReact.useState(null)
      var editor = editorPair[0]
      var setEditor = editorPair[1]
      var draftPair = sbReact.useState('')
      var draft = draftPair[0]
      var setDraft = draftPair[1]
      var confirmPair = sbReact.useState(null)
      var confirming = confirmPair[0]
      var setConfirming = confirmPair[1]
      var errorPair = sbReact.useState('')
      var actionError = errorPair[0]
      var setActionError = errorPair[1]
      /**
       * The region's own directory browser, when it is up. The Host's native
       * chooser cannot exist for a browser connected to another address, so the
       * picker that is missing its Host half falls back to this dialog instead
       * of reporting that the control does nothing.
       */
      var pickingPair = sbReact.useState(false)
      var picking = pickingPair[0]
      var setPicking = pickingPair[1]

      /** The open search, so a new keystroke cancels the one before it. */
      var searchRef = sbReact.useRef({ cancel: null })
      /** Whether this region is still the mounted one. */
      var mountedRef = sbReact.useRef(true)

      sbReact.useEffect(function () {
        mountedRef.current = true
        return function () {
          mountedRef.current = false
          if (searchRef.current.cancel) searchRef.current.cancel()
        }
      }, [])

      /**
       * The header's narrow shape, as the stylesheet drew it. Both shapes are in
       * the tree and the container query hides one of them, so this is the only
       * way the region knows which of the two add triggers is the one on screen.
       */
      var narrowPair = sbReact.useState(false)
      var narrow = narrowPair[0]
      var setNarrow = narrowPair[1]
      /** The container the stylesheet queries, measured to mirror the query. */
      var bodyRef = sbReact.useRef(null)

      sbReact.useEffect(function () {
        var node = bodyRef.current
        var Observer = typeof window !== 'undefined' && typeof window.ResizeObserver === 'function'
          ? window.ResizeObserver
          : null
        if (!node || !Observer) return undefined
        /** Mirror the stylesheet's `@container ph-sidebar (max-width: 120px)`. */
        function measure() {
          setNarrow((Number(node.clientWidth) || 0) <= SIDEBAR_RAIL_WIDTH)
        }
        measure()
        var observer = new Observer(measure)
        observer.observe(node)
        return function () { observer.disconnect() }
      }, [])

      // A shape that changed puts the menu away: its anchor is about to leave
      // the screen, and a list measured from a hidden trigger lands in the
      // viewport corner instead of under the button.
      sbReact.useEffect(function () {
        setMenu(null)
      }, [narrow])

      // Escape closes a dialog. The shell's `Modal` answers its own Escape, so
      // this is the region's own card's way out; closing twice is the same as
      // closing once, and a dialog with no way out is the defect being fixed.
      sbReact.useEffect(function () {
        if (!editor && !picking && !confirming) return undefined
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        function onKey(event) {
          if (!event || event.key !== 'Escape') return
          setEditor(null)
          setPicking(false)
          setConfirming(null)
        }
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('keydown', onKey) }
      }, [editor, picking, confirming])

      // The shipped sidebar opens the Workspace that holds the current Session
      // by itself, and only that one — every other row stays as the user left it.
      // It writes the answer down as it goes, which is what keeps the row open
      // across a reload, and it writes it only when there is no answer yet: a
      // stored `false` means the user closed that row, so it is never reopened
      // behind their back.
      sbReact.useEffect(function () {
        if (current === '' || !layout) return
        var holder = null
        for (var i = 0; i < items.length; i += 1) {
          if (sbHoldsCurrent(items[i], current)) { holder = items[i]; break }
        }
        var id = sbText(holder && holder.id)
        if (id === '') return
        if (Object.prototype.hasOwnProperty.call(kit.sidebarExpanded(layout), id)) return
        kit.mutateSidebarLayout(function (live) { return kit.withWorkspaceExpanded(live, id, true) })
      }, [current, items, layout])

      /**
       * Run one action, reporting a failure instead of dropping it: a control
       * that quietly does nothing is the defect this module exists to fix.
       * @param op - the action.
       */
      function attempt(op) {
        var outcome = null
        try {
          outcome = op()
        } catch (error) {
          setActionError(sbT('sidebar.list.failed', { reason: sbReason(error) }))
          return
        }
        if (outcome && typeof outcome.then === 'function') {
          outcome.then(null, function (error) {
            if (!mountedRef.current) return
            setActionError(sbT('sidebar.list.failed', { reason: sbReason(error) }))
          })
        }
      }
      /**
       * Run an action and put the region back to rest: a menu, a field or a
       * dialog that stays open after the click looks like a dead control.
       * @param op - the action.
       */
      function act(op) {
        setActionError('')
        setMenu(null)
        setEditor(null)
        setConfirming(null)
        attempt(op)
      }
      /**
       * @param name - `kit.sidebarServices` key.
       * @param method - the method the control needs.
       * @returns the service, or null after reporting that the host has none.
       */
      function need(name, method) {
        var service = sbService(name)
        if (service && typeof service[method] === 'function') return service
        setActionError(sbT('sidebar.list.readonly'))
        return null
      }
      /** @param service - the picker service. @returns the path it resolved, or ''. */
      function pickedPath(picked) {
        if (!picked) return ''
        if (typeof picked === 'string') return picked
        return sbText(picked.path)
      }

      // ------------------------------------------------------------ actions

      /** @param project - the project whose workspace to open. */
      function openProject(project) {
        act(function () {
          var service = need('uiWorkspace', 'openWorkspace')
          if (!service) return null
          return service.openWorkspace(sbText(project && project.id))
        })
      }
      /** @param row - the session row to open. */
      function openSession(row) {
        act(function () {
          var service = need('uiWorkspace', 'openSession')
          if (!service) return null
          return service.openSession(sbText(row && row.id))
        })
      }
      /** @param project - the project to start a session in. */
      function newSession(project) {
        act(function () {
          var service = need('uiWorkspace', 'startSession')
          if (!service) return null
          return service.startSession(sbText(project && project.id))
        })
      }
      /**
       * Register a folder that is already known by its path.
       * @param path - an absolute directory.
       * @returns the created workspace, or null when the Host cannot make one.
       */
      function createWorkspace(path) {
        var projects = need('workspaces', 'create')
        if (!projects) return null
        return projects.create({ path: path })
      }
      /** @param picked - whatever the Host's picker resolved. */
      function adoptPicked(picked) {
        if (picked && typeof picked === 'object' && sbText(picked.id) !== '') return picked
        var path = pickedPath(picked)
        if (path === '') return null
        return createWorkspace(path)
      }
      /** Put the region's own directory browser up. */
      function openDirectoryPicker() {
        if (!mountedRef.current) return
        setActionError('')
        setMenu(null)
        setEditor(null)
        setConfirming(null)
        setPicking(true)
      }
      /**
       * Add a project. The Host's chooser is asked first: on a local connection
       * that is the native directory dialog, which is the best answer there is.
       * A Host with no native chooser — a browser connected to another address,
       * or a machine without a desktop dialog — refuses that call; the region
       * then opens its own browser (see `SidebarDirectoryDialog`), which lists
       * directories through the Host the way the shipped sidebar does, instead
       * of leaving the control dead.
       */
      function newProject() {
        act(function () {
          var service = need('uiWorkspace', 'pickDirectory')
          if (!service) return null
          var outcome = null
          try {
            outcome = service.pickDirectory()
          } catch (error) {
            openDirectoryPicker()
            return null
          }
          if (!outcome || typeof outcome.then !== 'function') return adoptPicked(outcome)
          return outcome.then(adoptPicked, function () {
            openDirectoryPicker()
            return null
          })
        })
      }
      /** @param row - the session to fork. */
      function forkSession(row) {
        act(function () {
          var service = need('sessions', 'fork')
          if (!service) return null
          return service.fork({ sessionId: sbText(row && row.id) })
        })
      }
      /** @param row - the session whose id to copy. */
      function copySessionId(row) {
        var id = sbText(row && row.id)
        act(function () {
          if (ready && typeof sbKit.writeClipboard === 'function') return sbKit.writeClipboard(id)
          if (typeof navigator !== 'undefined' && navigator.clipboard) return navigator.clipboard.writeText(id)
          setActionError(sbT('sidebar.list.failed', { reason: 'clipboard' }))
          return null
        })
      }
      /** @param row - the session to archive or bring back. */
      function toggleArchived(row) {
        var method = row && row.archived ? 'unarchiveSession' : 'archiveSession'
        act(function () {
          var service = need('uiWorkspace', method)
          if (!service) return null
          return service[method](sbText(row && row.id))
        })
      }
      /** @param project - the project to unregister. */
      function removeProject(project) {
        act(function () {
          var service = need('workspaces', 'delete')
          if (!service) return null
          return service.delete(sbText(project && project.id))
        })
      }
      /** @param id - a workspace the document still names but the sidebar dropped. */
      function forgetProject(id) {
        act(function () {
          return kit.mutateSidebarLayout(function (live) { return kit.withoutWorkspace(live, id) })
        })
      }
      /**
       * @param workspaceId - the project to move.
       * @param key - the group to move it into; '' is the ungrouped bucket.
       */
      function moveProject(workspaceId, key) {
        act(function () {
          return kit.mutateSidebarLayout(function (live) {
            return kit.withWorkspace(live, workspaceId, { group: key === '' ? null : key })
          })
        })
      }
      /**
       * Pin or unpin one project. Like the rest of the document's own options
       * this is our storage, not a client service, so it works even in a host
       * that offers no workspace service.
       * @param id - the project.
       * @param pinned - its new pin state.
       */
      function pinProject(id, pinned) {
        var key = sbText(id)
        if (key === '') return
        act(function () {
          return kit.mutateSidebarLayout(function (live) {
            return kit.withWorkspace(live, key, { pinned: pinned === true })
          })
        })
      }
      /**
       * Set or clear one project's colour marker. An empty colour clears it, so
       * the project falls back to its group's colour if it has one.
       * @param id - the project.
       * @param color - a CSS colour, or '' / null to clear.
       */
      function markProject(id, color) {
        var key = sbText(id)
        if (key === '') return
        act(function () {
          return kit.mutateSidebarLayout(function (live) {
            return kit.withWorkspace(live, key, { color: sbText(color) || null })
          })
        })
      }
      /**
       * How one group orders its projects.
       * @param section - the group.
       * @param sort - `'manual'` or `'recent'`.
       */
      function setSectionSort(section, sort) {
        var key = sbText(section && section.key)
        if (key === '') return
        act(function () {
          return kit.mutateSidebarLayout(function (live) {
            return kit.withGroupPatch(live, key, { sort: sort === 'recent' ? 'recent' : 'manual' })
          })
        })
      }
      /**
       * The marker one group draws before its title.
       * @param section - the group.
       * @param color - one of `SIDEBAR_COLORS`, or empty to clear it.
       */
      function markSection(section, color) {
        var key = sbText(section && section.key)
        if (key === '') return
        act(function () {
          return kit.mutateSidebarLayout(function (live) {
            return kit.withGroupPatch(live, key, { color: sbText(color) || null })
          })
        })
      }
      /** @param section - the group to remove (its projects go back to ungrouped). */
      function removeGroup(section) {
        act(function () {
          return kit.mutateSidebarLayout(function (live) { return kit.withoutGroup(live, sbText(section && section.key)) })
        })
      }
      /** @param section - the group to fold, remembered in the document. */
      function toggleSection(section) {
        var key = sbText(section && section.key)
        if (key === '') return
        var next = !(section && section.collapsed)
        setActionError('')
        setMenu(null)
        attempt(function () {
          return kit.mutateSidebarLayout(function (live) {
            return kit.withGroupPatch(live, key, { collapsed: next })
          })
        })
      }
      /**
       * Fold or unfold one project, remembered in the document so the sidebar
       * comes back the way it was left. Unlike a group, a project row is folded
       * by default: `view.expanded` keeps the rows the user has opened.
       * @param project - the project whose rows to fold.
       * @param open - whether the row is open right now; the click flips it.
       */
      function toggleProject(project, open) {
        var id = sbText(project && project.id)
        if (id === '') return
        var next = open !== true
        setActionError('')
        setMenu(null)
        attempt(function () {
          return kit.mutateSidebarLayout(function (live) {
            return kit.withWorkspaceExpanded(live, id, next)
          })
        })
      }
      /** @param mode - `'native'` or `'grouped'`. */
      function chooseMode(mode) {
        act(function () {
          return kit.mutateSidebarLayout(function (live) { return kit.withMode(live, mode) })
        })
      }
      /** Expand the sidebar out of its rail state. */
      function expandSidebar() {
        act(function () {
          var service = need('layout', 'toggleSidebar')
          if (!service) return null
          return service.toggleSidebar()
        })
      }
      /** Re-read the projection after a failure. */
      function retryProjection() {
        act(function () { return kit.loadSidebarLayout(true) })
      }

      // ------------------------------------------------------------ editing

      /**
       * @param kind - `'project'`, `'group'`, `'session'` or `'newGroup'`.
       * @param id - what is being edited.
       * @param value - the text to start from.
       */
      function openEditor(kind, id, value) {
        setActionError('')
        setMenu(null)
        setConfirming(null)
        setDraft(sbText(value))
        setEditor({ kind: kind, id: sbText(id) })
      }
      /** Abandon an edit. */
      function cancelEditor() { setEditor(null) }
      /**
       * Commit an edit. An empty name is not an edit, so the field stays open
       * rather than closing as if something had been saved.
       */
      function commitEditor() {
        if (!editor) return
        var name = sbText(draft).trim()
        if (name === '') return
        var kind = editor.kind
        var id = editor.id
        setEditor(null)
        if (kind === 'newGroup') {
          act(function () {
            return kit.mutateSidebarLayout(function (live) { return kit.withNewGroup(live, name, null).layout })
          })
          return
        }
        if (kind === 'group') {
          act(function () {
            return kit.mutateSidebarLayout(function (live) { return kit.withGroupPatch(live, id, { title: name }) })
          })
          return
        }
        if (kind === 'project') {
          act(function () {
            var service = need('workspaces', 'rename')
            if (!service) return null
            return service.rename(id, name)
          })
          return
        }
        act(function () {
          var service = need('sessions', 'using')
          if (!service) return null
          return service.using(id, { source: 'controllerOperation' }, function (session) {
            if (!session || typeof session.rename !== 'function') {
              setActionError(sbT('sidebar.list.readonly'))
              return null
            }
            return session.rename(name)
          })
        })
      }

      // ------------------------------------------------------------- search

      /** @param value - the new query; typing schedules the content search. */
      function typeQuery(value) {
        setQuery(value)
        var state = searchRef.current
        if (state.cancel) {
          state.cancel()
          state.cancel = null
        }
        var sessions = sbService('sessions')
        if (!value) {
          setResults(null)
          setPending(false)
          return
        }
        if (!sessions || typeof sessions.search !== 'function') return
        setPending(true)
        var live = true
        state.cancel = function () { live = false }
        setTimeout(function () {
          if (!live) return
          var outcome = sessions.search(value)
          if (!outcome || typeof outcome.then !== 'function') {
            setPending(false)
            return
          }
          outcome.then(function (found) {
            if (!live || !mountedRef.current) return
            setPending(false)
            setResults(Array.isArray(found) ? found : [])
          }, function (error) {
            if (!live || !mountedRef.current) return
            setPending(false)
            setActionError(sbT('sidebar.list.failed', { reason: sbReason(error) }))
          })
        }, SIDEBAR_SEARCH_DELAY)
      }

      // -------------------------------------------------------------- menus

      /**
       * Open (or close) one row's menu. The shell's `Menu` positions itself
       * from the anchor it renders, so coordinates are only read for the
       * region's own popover.
       * @param kind - what the menu belongs to.
       * @param id - that row's id.
       * @param event - the click, when there was one.
       */
      function toggleMenu(kind, id, event) {
        if (menu && menu.kind === kind && menu.id === id) {
          setMenu(null)
          return
        }
        var x = 8
        var y = 8
        if (!ready && event && event.currentTarget && typeof event.currentTarget.getBoundingClientRect === 'function') {
          var rect = event.currentTarget.getBoundingClientRect()
          x = rect.right
          y = rect.bottom
        }
        setMenu({ kind: kind, id: id, x: x, y: y })
      }
      /** Close whatever is open. */
      function closeMenu() { setMenu(null) }
      /** @returns true when this row's menu is the open one. */
      function menuOpen(kind, id) { return !!(menu && menu.kind === kind && menu.id === id) }

      // The region's own popover is dismissed by a click anywhere else or by
      // Escape. The shell's `Menu` brings its own dismissal, so this only runs
      // when the kit is absent.
      sbReact.useEffect(function () {
        if (ready || !menu) return undefined
        if (typeof document === 'undefined' || !document.addEventListener) return undefined
        /** A click outside the popover closes it; one inside must reach it. */
        function onDown(event) {
          var node = event && event.target
          if (node && typeof node.closest === 'function' && node.closest('[data-sb="pop"]')) return
          setMenu(null)
        }
        /** @param event - a key event. */
        function onKey(event) {
          if (event && event.key === 'Escape') setMenu(null)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return function () {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [ready, menu])

      /**
       * Ask before a destructive change. The menu is put away first: the shell's
       * `Menu` stays up until something closes it, and a menu left floating over
       * the dialog would be the one thing the click did not take care of.
       * @param kind - `'project'` or `'group'`.
       * @param id - the project or group id.
       * @param name - the name the dialog quotes.
       */
      function askDestructive(kind, id, name) {
        setMenu(null)
        setConfirming({ kind: kind, id: id, name: name })
      }

      /** @param choice - a project menu id. @param project - the project. */
      function runProjectChoice(choice, project) {
        var id = sbText(project && project.id)
        var member = kit.sidebarMemberOf(layout, id)
        if (choice === 'newSession') return newSession(project)
        if (choice === 'rename') return openEditor('project', id, sbProjectName(project))
        if (choice === 'pin') return pinProject(id, !(member && member.pinned === true))
        if (choice === 'color') return null
        if (choice === 'move') return null
        if (choice === 'remove') return askDestructive('project', id, sbProjectName(project))
        if (choice === 'forget') return forgetProject(id)
        if (choice.indexOf('color:') === 0) return markProject(id, choice.slice(6))
        if (choice.indexOf('move:') === 0) return moveProject(id, choice.slice(5))
        return null
      }
      /** @param choice - a session menu id. @param row - the session row. */
      function runSessionChoice(choice, row) {
        if (choice === 'rename') return openEditor('session', sbText(row && row.id), sbSessionName(row))
        if (choice === 'fork') return forkSession(row)
        if (choice === 'copyId') return copySessionId(row)
        if (choice === 'archive' || choice === 'unarchive') return toggleArchived(row)
        return null
      }
      /** @param choice - a group menu id. @param section - the group section. */
      function runGroupChoice(choice, section) {
        if (choice === 'newProject') return newProject()
        if (choice === 'rename') return openEditor('group', sbText(section && section.key), section && section.title)
        if (choice.indexOf('color:') === 0) return markSection(section, choice.slice(6))
        if (choice === 'sort') return setSectionSort(section, section && section.sort === 'recent' ? 'manual' : 'recent')
        if (choice === 'delete') return askDestructive('group', sbText(section && section.key), sbText(section && section.title))
        return null
      }
      /** @param choice - an add menu id. */
      function runAddChoice(choice) {
        if (choice === 'newProject') return newProject()
        if (choice === 'newGroup') return openEditor('newGroup', '', '')
        return null
      }
      /**
       * Hand one menu choice to the action that owns it. Which menu is open is
       * in the menu model, so a row that has since been renamed or regrouped
       * cannot send its choice to the wrong target.
       * @param target - the open menu.
       * @param choice - the chosen entry id.
       */
      function runMenuChoice(target, choice) {
        if (!target) return null
        if (target.kind === 'add') return runAddChoice(choice)
        if (target.kind === 'session') return runSessionChoice(choice, sbFindRow(items, target.id))
        if (target.kind === 'group') {
          for (var i = 0; i < sections.length; i += 1) {
            if (sbText(sections[i].key) === target.id) return runGroupChoice(choice, sections[i])
          }
          return runGroupChoice(choice, null)
        }
        return runProjectChoice(choice, sbFindProject(items, target.id) || { id: target.id, orphan: true, rows: [] })
      }
      /** Commit the dialog that is up. */
      function confirmChange() {
        var pendingChange = confirming
        setConfirming(null)
        if (!pendingChange) return
        if (pendingChange.kind === 'group') {
          removeGroup({ key: pendingChange.id })
          return
        }
        removeProject({ id: pendingChange.id })
      }

      // ------------------------------------------------------------ drawing

      /**
       * Whether this project is the one holding the current Session. It is read
       * off the rows the shell reported rather than the ones being drawn: a
       * session the user archived is still theirs, and the project that owns it
       * is still the project they are working in.
       * @param project - a projected project.
       * @param current - the current session id, or ''.
       * @returns whether the current Session lives here.
       */
      function sbHoldsCurrent(project, current) {
        return sbContains(Array.isArray(project && project.rows) ? project.rows : [], current)
      }

      /**
       * Session rows in drawing order. Archived sessions are left out entirely:
       * the shipped browser keeps them behind its own archive view, and inventing
       * an "archived (3)" line inside the tree is exactly the kind of extra box
       * the reader asked us to drop. Nothing is folded to a watermark either — a
       * long tree scrolls, and the project row's own caret is the only expansion
       * the shipped sidebar has.
       * @param project - the project whose rows to draw.
       * @returns the rows.
       */
      function projectRows(project) {
        var rows = sbOrderRows(project && project.rows, current)
        var children = []
        for (var i = 0; i < rows.length; i += 1) children.push(sessionRow(project, rows[i]))
        return children
      }

      /**
       * One session. The dot carries its state, the timestamp gives way to the
       * hover cluster, and a pinned session keeps the pin at rest — the resting
       * row is text, exactly as the shipped browser draws it.
       * @param project - the project it belongs to.
       * @param row - the projected session row.
       * @returns the element.
       */
      function sessionRow(project, row) {
        var id = sbText(row && row.id)
        var projectId = sbText(project && project.id)
        var open = menuOpen('session', id)
        var renaming = !!(editor && editor.kind === 'session' && editor.id === id)
        var classes = 'ph-sb-row ph-sb-session'
        if (id !== '' && id === current) classes += ' is-current'
        if (open) classes += ' is-open'
        var entries = sbSessionMenu(row)
        var anchor = sbIconButton('dots', sbT('sidebar.list.more'), function (event) {
          if (event && event.stopPropagation) event.stopPropagation()
          toggleMenu('session', id, event)
        }, { key: 'menu', sb: 'sessionMenu', open: open })
        var children = []
        children.push(h('span', { className: 'ph-sb-slot', key: 'slot' },
          h('span', { className: 'ph-sb-dot' + (row && row.running ? ' is-run' : ''), 'data-sb': 'state' })))
        if (renaming) {
          children.push(h('span', { className: 'ph-sb-title-editing', key: 'title' },
            sbEditor(sbT('sidebar.list.rename'), draft, setDraft, commitEditor, cancelEditor)))
        } else {
          children.push(h('span', { className: 'ph-sb-title', key: 'title' }, sbSessionName(row)))
        }
        if (row && row.pinned) children.push(h('span', { className: 'ph-sb-pin', key: 'pin' }, sbGlyph('pin', 14)))
        var when = row && !row.blank ? sbWhen(row.updatedAt) : ''
        if (when !== '') children.push(h('span', { className: 'ph-sb-meta', key: 'meta' }, when))
        if (!renaming) children.push(h('span', { className: 'ph-sb-actions', key: 'actions' },
          sbMenu('session:' + id, open, anchor, entries, function (choice) { runSessionChoice(choice, row) }, closeMenu)))
        return h('div', {
          className: classes,
          key: 'session:' + id,
          'data-sb': 'session',
          'data-id': id,
          'data-ws': projectId,
          role: 'treeitem',
          tabIndex: 0,
          title: sbSessionName(row),
          onClick: function () { if (!renaming) openSession(row) },
          onKeyDown: function (event) { if (event && event.key === 'Enter' && !renaming) openSession(row) },
        }, children)
      }

      /**
       * One project. The row opens the workspace, its caret folds the session
       * list, and the cluster on the right starts a session or opens the menu.
       * @param project - the projected project.
       * @returns the element.
       */
      function projectRow(project) {
        var id = sbText(project && project.id)
        var rows = sbOrderRows(project && project.rows, current)
        var closed = !sbProjectOpen(layout, id, sbHoldsCurrent(project, current))
        var open = menuOpen('project', id)
        var renaming = !!(editor && editor.kind === 'project' && editor.id === id)
        var member = kit.sidebarMemberOf(layout, id)
        var marked = member && member.color ? String(member.color) : ''
        var classes = 'ph-sb-row ph-sb-project'
        if (project && project.orphan) classes += ' is-orphan'
        if (open) classes += ' is-open'
        var entries = sbProjectMenu(layout, project, sections)
        var anchor = sbIconButton('dots', sbT('sidebar.list.more'), function (event) {
          if (event && event.stopPropagation) event.stopPropagation()
          toggleMenu('project', id, event)
        }, { key: 'menu', sb: 'projectMenu', open: open })
        var children = []
        // A project the sidebar listed no sessions under has nothing to unfold,
        // so it gets the folder alone: a caret there is a control that cannot
        // do anything, which reads as a broken row.
        var slot = []
        if (rows.length > 0) {
          slot.push(h('button', {
            className: 'ph-sb-chev' + (closed ? '' : ' is-open'),
            key: 'chev',
            type: 'button',
            title: sbT('sidebar.group.expand'),
            'aria-label': sbT('sidebar.group.expand'),
            'data-sb': 'projectToggle',
            'aria-expanded': closed ? false : true,
            onClick: function (event) {
              if (event && event.stopPropagation) event.stopPropagation()
              toggleProject(project, !closed)
            },
          }, sbGlyph('caret', 16)))
        }
        slot.push(h('span', {
          className: 'ph-sb-folder' + (sbContains(rows, current) ? ' is-active' : ''),
          key: 'folder',
          // The marker is the document's colour for this project; without one
          // the folder keeps the sheet's own tertiary tint.
          style: marked === '' ? undefined : { color: marked },
          title: sbText(project && project.path) || sbProjectName(project),
        }, sbGlyph('folder', 16)))
        children.push(h('span', { className: 'ph-sb-slot', key: 'slot' }, slot))
        if (renaming) {
          children.push(h('span', { className: 'ph-sb-title-editing', key: 'title' },
            sbEditor(sbT('sidebar.project.rename'), draft, setDraft, commitEditor, cancelEditor)))
        } else {
          children.push(h('span', {
            className: 'ph-sb-title',
            key: 'title',
            title: sbText(project && project.path) || sbProjectName(project),
          }, sbProjectName(project)))
        }
        if (member && member.pinned === true) {
          children.push(h('span', {
            className: 'ph-sb-pin',
            key: 'pin',
            title: sbT('sidebar.project.pin'),
            'aria-label': sbT('sidebar.project.pin'),
          }, sbGlyph('pin', 16)))
        }
        var count = sbSessionCount(project, current)
        if (count > 0) children.push(h('span', { className: 'ph-sb-meta', key: 'meta' }, sbT('sidebar.list.count', { count: count })))
        if (!renaming) {
          var actions = []
          // A stale assignment — a project the document names and the sidebar no
          // longer lists — has no workspace behind it to start a session in, so
          // the row keeps only the menu that clears the assignment.
          if (!project.orphan) {
            actions.push(sbIconButton('chat', sbT('sidebar.list.newSession'), function (event) {
              if (event && event.stopPropagation) event.stopPropagation()
              newSession(project)
            }, { key: 'new', sb: 'newSession', disabled: !sbHas('uiWorkspace', 'startSession') }))
          }
          actions.push(sbMenu('project:' + id, open, anchor, entries, function (choice) { runProjectChoice(choice, project) }, closeMenu))
          children.push(h('span', { className: 'ph-sb-actions', key: 'actions' }, actions))
        }
        return h('div', {
          className: classes,
          key: 'project:' + id,
          'data-sb': 'project',
          'data-ws': id,
          role: 'treeitem',
          tabIndex: 0,
          title: sbText(project && project.path) || sbProjectName(project),
          onClick: function () { if (!renaming) openProject(project) },
          onKeyDown: function (event) { if (event && event.key === 'Enter' && !renaming) openProject(project) },
        }, children)
      }

      /**
       * One group: its heading, and — unless the document folded it — the
       * projects inside it with their sessions.
       * @param section - a group section.
       * @returns the element.
       */
      function groupBlock(section) {
        var key = sbText(section && section.key)
        var open = menuOpen('group', key)
        var renaming = !!(editor && editor.kind === 'group' && editor.id === key)
        var entries = sbGroupMenu(section)
        var anchor = sbIconButton('dots', sbT('sidebar.list.more'), function (event) {
          if (event && event.stopPropagation) event.stopPropagation()
          toggleMenu('group', key, event)
        }, { key: 'menu', sb: 'groupMenu', open: open })
        var head = []
        if (key !== '') {
          head.push(h('button', {
            className: 'ph-sb-chev' + (section.collapsed ? '' : ' is-open'),
            key: 'chev',
            type: 'button',
            title: sbT('sidebar.group.expand'),
            'aria-label': sbT('sidebar.group.expand'),
            'data-sb': 'groupToggle',
            'aria-expanded': section.collapsed ? false : true,
            onClick: function (event) {
              if (event && event.stopPropagation) event.stopPropagation()
              toggleSection(section)
            },
          }, sbGlyph('caret', 16)))
        }
        // The group's own colour, drawn where the manager card draws it: a dot
        // in front of the name. The ungrouped bucket has no record to colour.
        if (key !== '' && section.color) {
          head.push(h('span', {
            className: 'ph-sb-mark',
            key: 'mark',
            style: { color: section.color },
            'aria-hidden': 'true',
          }))
        }
        if (renaming) {
          head.push(h('span', { className: 'ph-sb-title-editing', key: 'title' },
            sbEditor(sbT('sidebar.list.rename'), draft, setDraft, commitEditor, cancelEditor)))
        } else {
          head.push(h('span', { className: 'ph-sb-title', key: 'title' }, section.title))
        }
        head.push(h('span', { className: 'ph-sb-meta', key: 'meta' }, sbT('sidebar.list.count', { count: sbSectionCount(section, current) })))
        if (!renaming) {
          head.push(h('span', { className: 'ph-sb-actions', key: 'actions' }, [
            sbIconButton('plus', sbT('sidebar.list.newProject'), function (event) {
              if (event && event.stopPropagation) event.stopPropagation()
              newProject()
            }, { key: 'new', sb: 'newProject', disabled: !sbHas('uiWorkspace', 'pickDirectory') }),
            sbMenu('group:' + key, open, anchor, entries, function (choice) { runGroupChoice(choice, section) }, closeMenu),
          ]))
        }
        var body = []
        if (!section.collapsed) {
          for (var i = 0; i < section.items.length; i += 1) {
            var project = section.items[i]
            body.push(projectRow(project))
            if (sbProjectOpen(layout, sbText(project && project.id), sbHoldsCurrent(project, current))) {
              var rows = projectRows(project)
              for (var r = 0; r < rows.length; r += 1) body.push(rows[r])
            }
          }
        }
        return h('div', { className: 'ph-sb-group', key: 'group:' + key, 'data-sb': 'section', 'data-group': key }, [
          h('div', {
            className: 'ph-sb-row ph-sb-group-head' + (open ? ' is-open' : ''),
            key: 'head',
            'data-sb': 'group',
            role: 'treeitem',
            'aria-expanded': section.collapsed ? false : true,
            tabIndex: 0,
            onClick: function () { if (key !== '' && !renaming) toggleSection(section) },
            onKeyDown: function (event) { if (event && event.key === 'Enter' && key !== '' && !renaming) toggleSection(section) },
          }, head),
          section.collapsed ? null : h('div', { className: 'ph-sb-group-body', key: 'body' }, body),
        ])
      }

      /** @returns the search results, or the tree, depending on the field. */
      function body() {
        if (query !== '') {
          if (results === null) {
            return h('div', { className: 'ph-sb-empty', 'data-sb': 'searching' },
              sbHas('sessions', 'search') ? (pending ? sbT('sidebar.list.searching') : '') : sbT('sidebar.list.readonly'))
          }
          if (results.length === 0) {
            return h('div', { className: 'ph-sb-empty', 'data-sb': 'noMatch' }, sbT('sidebar.list.noMatch'))
          }
          return results.map(function (found, index) {
            var sessionId = sbText(found && found.sessionId)
            var home = sbSessionHome(items, sessionId)
            return h('button', {
              className: 'ph-sb-result',
              key: 'result:' + (sessionId || index),
              type: 'button',
              'data-sb': 'result',
              'data-id': sessionId,
              onClick: function () { openSession({ id: sessionId }) },
            }, [
              h('span', { className: 'ph-sb-result-head', key: 'head' },
                h('span', { className: 'ph-sb-result-title', key: 'title' }, home.title || sessionId)),
              h('span', { className: 'ph-sb-result-meta', key: 'meta' }, [
                home.project !== '' ? h('span', { className: 'ph-sb-result-ws', key: 'ws' }, home.project) : null,
                found && found.snippet ? h('span', { className: 'ph-sb-result-snippet', key: 'snippet' }, sbText(found.snippet)) : null,
              ]),
            ])
          })
        }
        if (items.length === 0) {
          if (store.phase === 'loading' || store.phase === 'idle') {
            return h('div', { className: 'ph-sb-empty', 'data-sb': 'pending' }, sbT('sidebar.manager.pending'))
          }
          return h('div', { className: 'ph-sb-empty', 'data-sb': 'empty' }, sbT('sidebar.list.empty'))
        }
        return sections.map(function (section) { return groupBlock(section) })
      }

      /**
       * The region's two shapes, and the list both of them share. The list is a
       * child of `.ph-sb-body` on purpose: the container query lives on that
       * element, and a rule inside it can only reach descendants — the narrow
       * shape is icons only, and a list left outside would be drawn squeezed
       * under the rail instead of being put away.
       * @param value - the query field's text.
       * @param list - the scroll area.
       * @returns the element.
       */
      function header(value, list) {
        var addOpen = menuOpen('add', '')
        /**
         * The add trigger in one shape. Only the shape on screen mounts the
         * shell's `Menu`: the hidden one measures as a zero rect, which puts its
         * list in the viewport's corner, and its own outside-pointer listener
         * closes the visible list on the pointerdown that starts a menu row's
         * click — so the row would never run.
         * @param mine - whether this is the shape the container query keeps.
         * @returns the trigger, with its menu when it is the one on screen.
         */
        function addTrigger(mine) {
          var open = addOpen && mine === true
          var button = sbIconButton('plus', sbT('sidebar.list.more'), function (event) {
            if (event && event.stopPropagation) event.stopPropagation()
            toggleMenu('add', '', event)
          }, { key: 'add', sb: 'add', open: open })
          return open ? sbMenu('add', true, button, sbAddMenu(), runAddChoice, closeMenu) : button
        }
        var wide = h('div', { className: 'ph-sb-wide', key: 'wide' }, [
          h('div', { className: 'ph-sb-bar', key: 'bar' }, [
            h('span', {
              className: 'ph-sb-bar-label' + (searchOpen ? ' is-hidden' : ''),
              key: 'label',
            }, sbT('sidebar.list.title')),
            h('div', { className: 'ph-sb-bar-search' + (searchOpen ? ' is-open' : ''), key: 'search' },
              h('div', { className: 'ph-sb-search' + (searchOpen ? ' is-open' : '') },
                [
                  h('button', {
                    className: 'ph-sb-sbtn',
                    key: 'sbtn',
                    type: 'button',
                    title: sbT('sidebar.list.search'),
                    'aria-label': sbT('sidebar.list.search'),
                    'data-sb': 'toggleSearch',
                    onClick: function () { setSearchOpen(!searchOpen) },
                  }, sbGlyph('search', 16)),
                  h('input', {
                    className: 'ph-sb-sinput',
                    key: 'sinput',
                    type: 'search',
                    value: value,
                    placeholder: sbT('sidebar.list.search'),
                    'aria-label': sbT('sidebar.list.search'),
                    'data-sb': 'searchInput',
                    onChange: function (event) { typeQuery(event && event.target ? sbText(event.target.value) : '') },
                  }),
                  value !== '' ? h('button', {
                    className: 'ph-sb-clear',
                    key: 'clear',
                    type: 'button',
                    title: sbT('sidebar.group.cancel'),
                    'aria-label': sbT('sidebar.group.cancel'),
                    'data-sb': 'clearSearch',
                    onClick: function () { typeQuery('') },
                  }, sbGlyph('close', 14)) : null,
                ])),
            h('div', { className: 'ph-sb-bar-actions' + (searchOpen ? ' is-hidden' : ''), key: 'actions' }, [
              sbIconButton('grid', sbT('sidebar.list.useNative'), function (event) {
                if (event && event.stopPropagation) event.stopPropagation()
                chooseMode('native')
              }, { key: 'mode', sb: 'mode' }),
              addTrigger(narrow !== true),
            ]),
          ]),
        ])
        var rail = h('div', { className: 'ph-sb-rail', key: 'rail' }, [
          sbIconButton('expand', sbT('sidebar.list.narrow'), function () { expandSidebar() }, { key: 'expand', sb: 'expand', disabled: !sbHas('layout', 'toggleSidebar') }),
          sbIconButton('grid', sbT('sidebar.list.useNative'), function () { chooseMode('native') }, { key: 'mode', sb: 'mode' }),
          addTrigger(narrow === true),
        ])
        return h('div', { className: 'ph-sb-body', key: 'body', ref: bodyRef }, [wide, rail, list])
      }

      /** @returns the line that reports a failure, or a crash hint. */
      function status() {
        if (actionError !== '') {
          return h('div', { className: 'ph-sb-error', key: 'status', 'data-sb': 'actionError' }, actionError)
        }
        if (store.error) {
          return h('div', { className: 'ph-sb-error', key: 'status', 'data-sb': 'storeError' }, [
            h('span', { key: 'text' }, sbT('sidebar.list.failed', { reason: sbText(store.error) })),
            h('button', {
              className: 'ph-sb-more',
              key: 'retry',
              type: 'button',
              'data-sb': 'retry',
              onClick: function () { retryProjection() },
            }, sbT('common.refresh')),
          ])
        }
        return null
      }

      var layer = null
      if (menu && !ready) layer = sbPopover(menuModelFor(menu, layout, sections, items), menu, function (choice) { runMenuChoice(menu, choice) })
      if (editor && editor.kind === 'newGroup') {
        layer = sbDialog(
          sbT('sidebar.list.newGroup'),
          h('div', { className: 'ph-sb-form', key: 'form' }, [
            sbField(sbT('sidebar.list.newGroup'), draft, setDraft, commitEditor, cancelEditor),
          ]),
          [
            sbButton(sbT('sidebar.group.cancel'), {
              key: 'cancel',
              sb: 'groupCancel',
              variant: 'outline',
              onClick: cancelEditor,
            }),
            sbButton(sbT('sidebar.list.create'), {
              key: 'apply',
              sb: 'groupApply',
              variant: 'primary',
              disabled: sbText(draft).trim() === '',
              onClick: commitEditor,
            }),
          ],
          cancelEditor,
        )
      }
      if (picking) {
        layer = h(SidebarDirectoryDialog, {
          key: 'picker',
          onCancel: function () { setPicking(false) },
          onPicked: function () { setPicking(false) },
        })
      }
      if (confirming) {
        var ask = confirming.kind === 'group'
          ? sbT('sidebar.group.deleteAsk', { title: confirming.name })
          : sbT('sidebar.project.deleteAsk', { title: confirming.name })
        layer = sbConfirm(ask, confirmChange, function () { setConfirming(null) })
      }
      var list = h('div', { className: 'ph-sb-scroll', key: 'scroll' }, [
        h('div', { className: 'ph-sb-list', key: 'list' }, body()),
        h('div', { className: 'ph-sb-fade', key: 'fade' }),
      ])
      return h('div', { className: 'ph-sb', 'data-sidebar-mode': 'grouped' }, [
        header(query, list),
        status(),
        layer,
      ])
    }

    /**
     * The workspace a session was found in, for a search hit: the row's own
     * title and the project that holds it, or nothing when the projection no
     * longer lists it (an archived session, or one deleted elsewhere).
     * @param items - the projected projects.
     * @param sessionId - the hit's session id.
     * @returns `{ title, project }`.
     */
    function sbSessionHome(items, sessionId) {
      var projects = Array.isArray(items) ? items : []
      for (var i = 0; i < projects.length; i += 1) {
        var rows = Array.isArray(projects[i] && projects[i].rows) ? projects[i].rows : []
        for (var r = 0; r < rows.length; r += 1) {
          if (sbText(rows[r] && rows[r].id) === sessionId) {
            return { title: sbSessionName(rows[r]), project: sbProjectName(projects[i]) }
          }
        }
      }
      return { title: '', project: '' }
    }

    /**
     * @param menu - the open menu.
     * @param layout - the document.
     * @param sections - every section.
     * @param items - the projected projects.
     * @returns the entries for that menu, for the region's own popover.
     */
    function menuModelFor(menu, layout, sections, items) {
      if (menu.kind === 'add') return sbAddMenu()
      if (menu.kind === 'group') {
        for (var i = 0; i < sections.length; i += 1) {
          if (sbText(sections[i].key) === menu.id) return sbGroupMenu(sections[i])
        }
        return sbGroupMenu(null)
      }
      if (menu.kind === 'session') {
        var row = sbFindRow(items, menu.id)
        return sbSessionMenu(row)
      }
      var project = sbFindProject(items, menu.id)
      return sbProjectMenu(layout, project || { id: menu.id, orphan: true }, sections)
    }

    /** @param items - the projected projects. @param id - a workspace id. */
    function sbFindProject(items, id) {
      var projects = Array.isArray(items) ? items : []
      for (var i = 0; i < projects.length; i += 1) {
        if (sbText(projects[i] && projects[i].id) === id) return projects[i]
      }
      return null
    }
    /** @param items - the projected projects. @param id - a session id. */
    function sbFindRow(items, id) {
      var projects = Array.isArray(items) ? items : []
      for (var i = 0; i < projects.length; i += 1) {
        var rows = Array.isArray(projects[i] && projects[i].rows) ? projects[i].rows : []
        for (var r = 0; r < rows.length; r += 1) {
          if (sbText(rows[r] && rows[r].id) === id) return rows[r]
        }
      }
      return null
    }

    // ---------------------------------------------------------- occupancy

    /** @returns the custom element constructor, defining it on first use. */
    function sbDefineElement() {
      if (sbElement) return sbElement
      if (typeof window === 'undefined') return null
      if (!window.customElements || typeof window.customElements.get !== 'function') return null
      if (typeof window.HTMLElement !== 'function') return null
      var existing = window.customElements.get(SIDEBAR_TAG)
      if (existing) { sbElement = existing; return existing }
      /** The occupant: a bare element with no props to interpret. */
      function HomepageSidebar() {
        return Reflect.construct(window.HTMLElement, [], HomepageSidebar)
      }
      HomepageSidebar.prototype = Object.create(window.HTMLElement.prototype)
      HomepageSidebar.prototype.constructor = HomepageSidebar
      HomepageSidebar.prototype.connectedCallback = function () { sbMountRegion(this) }
      HomepageSidebar.prototype.disconnectedCallback = function () { sbUnmountRegion(this) }
      window.customElements.define(SIDEBAR_TAG, HomepageSidebar)
      sbElement = HomepageSidebar
      return sbElement
    }
    /**
     * Mount the list inside the element. The element is outside the shell's
     * React tree, so it gets a root of its own — but the components inside it
     * are from this bundle, which is what keeps their hooks intact.
     * @param node - the element.
     */
    function sbMountRegion(node) {
      if (!node || !sbReactDom) return
      try {
        var root = sbRoots.get(node)
        if (!root) {
          root = sbReactDom.createRoot(node)
          sbRoots.set(node, root)
        }
        root.render(h(SidebarBoundary, null, h(SidebarProjects)))
      } catch (error) {
        console.error('homepage: the sidebar list failed to mount', error)
      }
    }
    /** @param node - the element. */
    function sbUnmountRegion(node) {
      var root = node ? sbRoots.get(node) : null
      if (!root) return
      sbRoots.delete(node)
      try { root.unmount() } catch (error) { /* the shell tore the tree down first */ }
    }
    /**
     * The region's error boundary. React only reports a render failure to a
     * class with `getDerivedStateFromError`, so the boundary is one — while the
     * test harness hands the framework a cut-down React with no classes, and
     * there it just passes its children through. It is a safety net: a failed
     * render must not leave the sidebar blank with no way back, and choosing the
     * shipped list disposes this registration so the shipped occupant returns.
     */
    var SidebarBoundary = (function () {
      var Base = sbReact && typeof sbReact.Component === 'function' ? sbReact.Component : null
      if (!Base) return function (props) { return props.children }
      /** @param props - React props. */
      function Boundary(props) {
        Base.call(this, props)
        this.state = { failed: false }
      }
      Boundary.prototype = Object.create(Base.prototype)
      Boundary.prototype.constructor = Boundary
      Boundary.getDerivedStateFromError = function () { return { failed: true } }
      Boundary.prototype.componentDidCatch = function (error) {
        console.error('homepage: the sidebar list threw', error)
      }
      Boundary.prototype.render = function () {
        if (!this.state.failed) return this.props.children
        return h('div', { className: 'ph-sb-empty ph-sb-crashed' }, [
          h('div', { key: 'text' }, sbT('sidebar.list.crashed')),
          h('button', {
            className: 'ph-sb-more',
            key: 'back',
            type: 'button',
            onClick: function () { sbSetMode('native') },
          }, sbT('sidebar.list.useNative')),
        ])
      }
      return Boundary
    })()
    /**
     * Give a registration back. The live slot API hands out a disposer; a
     * harness or a future API returning a handle instead must not be able to
     * break the subscriber that decides who owns the region.
     * @param handle - whatever the slot API returned for the registration.
     */
    function sbRelease(handle) {
      if (typeof handle === 'function') handle()
      else if (handle && typeof handle.dispose === 'function') handle.dispose()
    }

    /**
     * Put the region's stylesheet in the document. The panel renders its
     * stylesheets inside its own tree (`styleSheets()`), and the region is not
     * in that tree: on the views where the wall is closed — which is where the
     * sidebar mostly lives — the list would draw with no CSS at all, and that
     * is the "pile of boxes" the owner saw. The sheet is added once and marked,
     * so a hot reload does not stack copies; the panel's own copy stays
     * harmless, it is the same rules.
     */
    function sbEnsureStyles() {
      if (typeof document === 'undefined' || !document.head || typeof document.createElement !== 'function') return
      if (typeof document.querySelector === 'function' && document.querySelector('style[data-ph-sidebar]')) return
      var text = typeof kit.SIDEBAR_STYLES === 'string' ? kit.SIDEBAR_STYLES : ''
      if (text === '') return
      var style = document.createElement('style')
      style.setAttribute('data-ph-sidebar', '')
      style.textContent = text
      document.head.appendChild(style)
    }

    /**
     * Take over the sidebar region while the document asks for the grouped
     * list, and give it straight back when it does not: the registration is
     * simply disposed, so the shipped occupant returns to the front.
     *
     * The registration goes through `ctx.slots.inject`, the shape every shipped
     * call site uses: `inject` runs the callback under this plugin's own effect
     * and owns whatever it returns, which is what ties an occupant to the entry
     * that registered it.
     * @param ctx - the client plugin context.
     */
    function sbOccupy(ctx) {
      try {
        // Best effort: without a DOM the region still takes the slot, it simply
        // has nothing to draw into. Registering anyway keeps the decision in one
        // place, and it is what a test without a browser can observe.
        sbDefineElement()
        var dispose = null
        /** Follow the document's mode. */
        function sync() {
          var grouped = kit.sidebarMode() === 'grouped'
          if (grouped && !dispose) {
            sbEnsureStyles()
            var registration = null
            var controller = null
            /** @returns the registration disposer `inject` collects. */
            function take() {
              registration = ctx.slots.register({
                name: 'sidebar.workspaces',
                id: 'sidebar-projects',
                priority: SIDEBAR_OCCUPANT_PRIORITY,
              }, function () { return h(SIDEBAR_TAG) })
              return registration
            }
            controller = typeof ctx.slots.inject === 'function'
              ? ctx.slots.inject('sidebar.workspaces', take)
              : take()
            dispose = function () {
              if (registration) sbRelease(registration)
              sbRelease(controller)
            }
          } else if (!grouped && dispose) {
            var release = dispose
            dispose = null
            sbRelease(release)
          }
        }
        sync()
        var unsubscribe = kit.subscribeSidebar(sync)
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(function () { return function () { unsubscribe() } })
        }
      } catch (error) {
        // An occupant that cannot register must not take the rest of the card
        // wall down with it: the shipped browser simply stays in place.
        console.error('homepage: the sidebar region could not take the slot', error)
      }
    }

    kit.onApply(sbOccupy)
    // The smoke test renders the region directly; the sidebar itself gets it
    // through the element, where the root is created by `sbMountRegion`.
    kit.sidebarProjects = SidebarProjects
