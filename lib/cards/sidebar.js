/**
 * Sidebar module: group the left sidebar's projects and colour-tag them, as
 * display state this plugin owns. Nothing here renames, moves, archives or
 * otherwise writes a real workspace or session: the grouping lives in
 * `<DSH_HOME>/storages/dsh-homepage/sidebar-layout.json`.
 *
 * This file is the manager card and the document's shared React store. The
 * sidebar list itself — the project rows, their group sections and the
 * per-project menu that files a project into a group — is
 * `lib/cards/sidebar-list.js`, which takes the `sidebar.workspaces` slot over
 * whenever the document's mode is `'grouped'`. Nothing is injected into a
 * Session row: a shipped row keeps exactly the options it shipped with.
 *
 * Spliced into the client factory by scripts/build-client.mjs, inside
 * `(function (kit) { ... })(Kit)`, so this file may assume `kit` is in scope.
 *
 * @module dsh-homepage/cards/sidebar
 */

    var h = kit.h
    var React = kit.React

    /** @returns the shared sidebar document store. */
    function useSidebar() { return kit.useSidebarLayout() }
    /** @param key - dictionary key. @param params - interpolation values. @returns the text. */
    function t(key, params) { return kit.runtime.t(key, params) }

    /**
     * One colour dot.
     * @param color - `#rrggbb`, or null for the neutral "no tag" dot.
     * @param title - tooltip text, or null.
     * @returns the element.
     */
    function dot(color, title) {
      return h('span', {
        className: 'ph-group-dot',
        title: title || undefined,
        style: color ? { background: color } : undefined,
      })
    }

    // ------------------------------------------------------- the manager card
    //
    // The card is the second way into the same document: the sidebar's "…" menu
    // is for "put this project here", and this is where the groups themselves are
    // created, renamed, coloured, ordered and emptied out. It reads one thing the
    // slot entries do not need — which projects actually exist, and what they are
    // called. A card has no slot props, so that list is whatever the sidebar last
    // handed the panel icon (kit.reportWorkspaces); a project the document still
    // mentions but the sidebar no longer lists is drawn from its id alone and
    // marked, because a stale assignment must stay removable.

    /**
     * The projects the sidebar reported.
     * @param store - the sidebar store.
     * @returns `{ id, title, path, sessions, reported }` per project.
     */
    function reportedProjects(store) {
      var list = store && Array.isArray(store.workspaces) ? store.workspaces : []
      return list.map(function (project) {
        return {
          id: String(project.id),
          title: project.title ? String(project.title) : basenameOf(project),
          path: String(project.path || ''),
          sessions: Number(project.sessions) || 0,
          reported: true,
        }
      })
    }

    /**
     * @param project - a reported project.
     * @returns the last segment of its path, or its id.
     */
    function basenameOf(project) {
      var parts = String((project && project.path) || '').split(/[\\/]/)
      var last = ''
      parts.forEach(function (part) { if (part !== '') last = part })
      return last || String((project && project.id) || '')
    }

    /**
     * Every project the card draws: the sidebar's list, then whatever else the
     * document still names.
     * @param store - the sidebar store.
     * @param layout - the document.
     * @returns the project list.
     */
    function knownProjects(store, layout) {
      var list = reportedProjects(store)
      var seen = {}
      list.forEach(function (project) { seen[project.id] = true })
      var members = kit.sidebarMembers(layout)
      Object.keys(members).forEach(function (id) {
        if (seen[id]) return
        seen[id] = true
        list.push({ id: id, title: id, path: '', sessions: 0, reported: false })
      })
      return list
    }

    /** Order groups the way the document does. */
    function byGroupOrder(left, right) {
      return (Number(left && left.order) || 0) - (Number(right && right.order) || 0)
    }

    /**
     * The projects in one group.
     * @param layout - the document.
     * @param store - the sidebar store.
     * @param groupId - the group id, or null for the ungrouped bucket.
     * @returns `{ id, title, reported }` per project, by name.
     */
    function groupMembers(layout, store, groupId) {
      var groups = {}
      kit.sidebarGroups(layout).forEach(function (group) { if (group) groups[group.id] = true })
      var members = kit.sidebarMembers(layout)
      return knownProjects(store, layout).filter(function (project) {
        var member = members[project.id]
        var group = member && member.group ? member.group : null
        if (groupId === null) return group === null || !groups[group]
        return group === groupId
      }).map(function (project) {
        var member = members[project.id]
        var alias = member && member.alias ? String(member.alias) : ''
        return { id: project.id, title: alias !== '' ? alias : project.title, reported: project.reported }
      }).sort(function (left, right) {
        return left.title < right.title ? -1 : (left.title > right.title ? 1 : 0)
      })
    }

    /** @param count - how many projects. @returns the count text. */
    function countText(count) { return t('sidebar.group.count', { count: count }) }

    /** The wall face: the groups with their sizes, and what is still loose. */
    function GroupsCard() {
      var store = useSidebar()
      var layout = store.layout
      var groups = kit.sidebarGroups(layout).slice().sort(byGroupOrder)
      var loose = groupMembers(layout, store, null)
      var waiting = store.phase === 'loading' && !layout
      return h('div', { className: 'ph-groups-card' },
        groups.length > 0
          ? h('div', { className: 'ph-groups-list' }, groups.map(function (group) {
            return h('div', { className: 'ph-group-line', key: group.id },
              dot(group.color || null, null),
              h('span', { className: 'ph-group-name' }, group.title),
              h('span', { className: 'ph-group-count' }, countText(groupMembers(layout, store, group.id).length)),
            )
          }))
          : h('p', { className: 'ph-note' }, waiting ? t('sidebar.manager.pending') : t('sidebar.groups.empty')),
        loose.length > 0
          ? h('div', { className: 'ph-group-line ph-group-line--loose', key: 'loose' },
            dot(null, null),
            h('span', { className: 'ph-group-name' }, t('sidebar.manager.loose')),
            h('span', { className: 'ph-group-count' }, countText(loose.length)),
          )
          : null,
        store.error ? h('p', { className: 'ph-note ph-groups-error' }, store.error) : null,
      )
    }

    /**
     * The colour swatches of one group, "no colour" included.
     * @param props - `{ value, onPick }`.
     * @returns the element.
     */
    function ColorSwatches(props) {
      return h('div', { className: 'ph-swatches' },
        kit.SIDEBAR_COLORS.map(function (color) {
          return h('button', {
            key: color,
            type: 'button',
            className: 'ph-swatch' + (props.value === color ? ' is-on' : ''),
            style: { background: color },
            title: color,
            'aria-label': color,
            onClick: function () { props.onPick(color) },
          })
        }),
        h('button', {
          key: 'none',
          type: 'button',
          className: 'ph-swatch ph-swatch--none' + (props.value ? '' : ' is-on'),
          title: t('sidebar.group.none'),
          'aria-label': t('sidebar.group.none'),
          onClick: function () { props.onPick(null) },
        }, kit.ICONS.close(10)),
      )
    }

    /**
     * One project inside a group, with the way out of it.
     * @param props - `{ member, onRemove }`.
     * @returns the element.
     */
    function MemberChip(props) {
      return h('span', {
        className: 'ph-member' + (props.member.reported ? '' : ' is-orphan'),
        title: props.member.reported ? null : t('sidebar.member.orphan'),
      },
      h('span', { className: 'ph-member-name' }, props.member.title),
      h('button', {
        type: 'button',
        className: 'ph-member-x',
        title: t('sidebar.group.removeHint'),
        'aria-label': t('sidebar.group.removeHint'),
        onClick: props.onRemove,
      }, kit.ICONS.close(9)),
      )
    }

    /**
     * One group: its name, its colour, its place in the order, its projects and
     * the way to delete it.
     * @param props - `{ group, layout, store, first, last, onMove, onDelete, onUnassign }`.
     * @returns the element.
     */
    function GroupEditor(props) {
      var group = props.group
      var members = groupMembers(props.layout, props.store, group.id)
      /** Write one field through the shared store, saving on the usual debounce. */
      function patch(fields) {
        void kit.mutateSidebarLayout(function (live) {
          return kit.withGroupPatch(live, group.id, fields)
        }).catch(function () {})
      }
      return h('div', { className: 'ph-group-editor', key: group.id },
        h('div', { className: 'ph-group-editor-head' },
          dot(group.color || null, null),
          h('div', { className: 'ph-group-editor-title' }, h(kit.UI.Text, {
            value: group.title,
            label: t('sidebar.group.rename'),
            onChange: function (next) {
              var title = String(next === null || next === undefined ? '' : next).trim()
              if (title !== '') patch({ title: title })
            },
          })),
          h('span', { className: 'ph-group-count' }, countText(members.length)),
          h('span', { className: 'ph-group-tools' },
            h(kit.UI.Button, { title: t('sidebar.group.moveUp'), disabled: props.first, onClick: function () { props.onMove(-1) } }, h('span', { style: { display: 'inline-flex', transform: 'rotate(180deg)' } }, kit.ICONS.chevron(11))),
            h(kit.UI.Button, { title: t('sidebar.group.moveDown'), disabled: props.last, onClick: function () { props.onMove(1) } }, kit.ICONS.chevron(11)),
            h(kit.UI.Button, { title: t('sidebar.group.deleteHint'), onClick: props.onDelete }, t('sidebar.group.delete')),
          ),
        ),
        h('div', { className: 'ph-group-editor-body' },
          h(ColorSwatches, { value: group.color || null, onPick: function (color) { patch({ color: color }) } }),
          members.length > 0
            ? h('div', { className: 'ph-members' }, members.map(function (member) {
              return h(MemberChip, {
                key: member.id,
                member: member,
                onRemove: function () { props.onUnassign(member.id) },
              })
            }))
            : h('p', { className: 'ph-note' }, t('sidebar.group.noMembers')),
        ),
      )
    }

    /**
     * The ungrouped bucket: every project with no live group, and how to place it.
     * @param props - `{ layout, store }`.
     * @returns the element.
     */
    function LooseList(props) {
      var groups = kit.sidebarGroups(props.layout).slice().sort(byGroupOrder)
      var loose = groupMembers(props.layout, props.store, null)
      if (loose.length === 0) return h('p', { className: 'ph-note' }, t('sidebar.manager.empty'))
      return h('div', { className: 'ph-loose' }, loose.map(function (project) {
        return h('div', { className: 'ph-loose-row', key: project.id },
          h('span', {
            className: 'ph-loose-name' + (project.reported ? '' : ' is-orphan'),
            title: project.reported ? null : t('sidebar.member.orphan'),
          }, project.title),
          groups.length > 0 ? h('select', {
            className: 'ph-select',
            value: '',
            'aria-label': t('sidebar.group.assign'),
            onChange: function (event) {
              var chosen = event.target.value
              if (chosen === '') return
              void kit.mutateSidebarLayout(function (live) {
                return kit.withWorkspace(live, project.id, { group: chosen })
              }).catch(function () {})
            },
          },
          h('option', { value: '' }, t('sidebar.group.assign')),
          groups.map(function (group) { return h('option', { key: group.id, value: group.id }, group.title) }),
          ) : null,
        )
      }))
    }

    /** The expanded face: create, rename, colour, reorder, delete, assign. */
    function GroupsDetail() {
      var store = useSidebar()
      var layout = store.layout
      var nameState = React.useState('')
      var name = nameState[0]
      var setName = nameState[1]
      var groups = kit.sidebarGroups(layout).slice().sort(byGroupOrder)

      /** Create a group from the typed name. */
      function create() {
        var title = String(name || '').trim()
        if (title === '') return
        void kit.mutateSidebarLayout(function (live) {
          return kit.withNewGroup(live, title, null).layout
        }).catch(function () {})
        setName('')
      }
      /** Swap a group with its neighbour and renumber the whole order. */
      function move(group, delta) {
        void kit.mutateSidebarLayout(function (live) {
          var list = kit.sidebarGroups(live).slice().sort(byGroupOrder)
          var index = -1
          for (var i = 0; i < list.length; i += 1) { if (list[i] && list[i].id === group.id) index = i }
          var target = index + delta
          if (index < 0 || target < 0 || target >= list.length) return live
          var moved = list.slice()
          var held = moved[index]
          moved[index] = moved[target]
          moved[target] = held
          return Object.assign({}, live, {
            groups: moved.map(function (entry, position) { return Object.assign({}, entry, { order: position }) }),
          })
        }).catch(function () {})
      }
      /** Drop a group; its projects fall back to ungrouped. */
      function remove(group) {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !window.confirm(t('sidebar.group.deleteAsk', { title: group.title }))) return
        void kit.mutateSidebarLayout(function (live) {
          return kit.withoutGroup(live, group.id)
        }).catch(function () {})
      }
      /** Take one project out of its group. */
      function unassign(workspaceId) {
        void kit.mutateSidebarLayout(function (live) {
          return kit.withWorkspace(live, workspaceId, { group: null })
        }).catch(function () {})
      }
      /**
       * Choose which list owns the sidebar region. It sits on the card as well
       * as in the region, because the region is exactly what a failure in the
       * region takes away — from here the shipped list is always one click off.
       * @param mode - `'native'` or `'grouped'`.
       */
      function setMode(mode) {
        void kit.mutateSidebarLayout(function (live) { return kit.withMode(live, mode) }).catch(function () {})
      }

      return h('div', { className: 'ph-groups-detail' },
        h('div', { className: 'ph-groups-bar' },
          h(kit.UI.Segmented, {
            label: t('sidebar.manager.mode'),
            options: [
              { value: 'grouped', label: t('sidebar.list.useGrouped') },
              { value: 'native', label: t('sidebar.list.useNative') },
            ],
            value: kit.sidebarMode(layout),
            onChange: setMode,
          }),
          h('span', { className: 'ph-head-spacer' }),
          h(kit.UI.Button, {
            icon: kit.ICONS.refresh(12),
            title: t('common.refresh'),
            onClick: function () { kit.loadSidebarLayout(true).catch(function () {}) },
          }),
        ),
        h('div', { className: 'ph-groups-new' },
          h('input', {
            className: 'ph-input',
            value: name,
            placeholder: t('sidebar.group.name'),
            'aria-label': t('sidebar.manager.create'),
            onChange: function (event) { setName(event.target.value) },
            onKeyDown: function (event) { if (event.key === 'Enter') { event.preventDefault(); create() } },
          }),
          h(kit.UI.Button, { onClick: create, disabled: String(name || '').trim() === '' }, t('sidebar.group.create')),
        ),
        groups.length > 0
          ? h('div', { className: 'ph-group-editors' }, groups.map(function (group, index) {
            return h(GroupEditor, {
              key: group.id,
              group: group,
              layout: layout,
              store: store,
              first: index === 0,
              last: index === groups.length - 1,
              onMove: function (delta) { move(group, delta) },
              onDelete: function () { remove(group) },
              onUnassign: unassign,
            })
          }))
          : h('p', { className: 'ph-note' }, t('sidebar.groups.empty')),
        h('div', { className: 'ph-groups-bar' },
          h('span', { className: 'ph-section-title' }, t('sidebar.manager.loose')),
        ),
        h(LooseList, { layout: layout, store: store }),
        store.error ? h('p', { className: 'ph-note ph-groups-error' }, store.error) : null,
      )
    }

    defineCard({
      id: 'sidebar-groups',
      shipped: true,
      order: 70,
      title: function () { return t('sidebar.card.title') },
      icon: 'grid',
      size: { w: 1, h: 1 },
      minSize: { w: 1, h: 1 },
      maxSize: { w: 2, h: 3 },
      accent: '#12a594',
      texture: true,
      content: function () { return h(GroupsCard, null) },
      detail: function () { return h(GroupsDetail, null) },
    })
