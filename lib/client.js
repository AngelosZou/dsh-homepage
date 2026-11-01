/**
 * dsh-homepage — Client half. GENERATED FILE — do not edit.
 *
 * Built by scripts/build-client.mjs from lib/framework.part.js plus every
 * module in lib/cards/ (one file per card, spliced in filename order). Run
 * `npm run build` after changing either, and `npm test` before shipping: it
 * fails while this file is out of date.
 *
 * The card sources are the finished text of each module, so read those for
 * anything below the framework: lib/cards/device.js, lib/cards/dsh.js, lib/cards/hygiene.js, lib/cards/network.js, lib/cards/plugin-audit.js, lib/cards/projects.js, lib/cards/sessions.js, lib/cards/sidebar-list.js, lib/cards/sidebar.js, lib/cards/skill.js, lib/cards/token.js, lib/cards/tool-usage.js
 */
/**
 * dsh-homepage — Client half.
 *
 * Implements the personal home page: the card registry other plugins register
 * into, the auto-laid-out responsive wall, hover growth that does not reflow
 * neighbours, click-to-expand detail pages, drag reordering (mouse and touch),
 * per-card notification bubbles, custom backgrounds, animation effects and the
 * responsive controls a card registers.
 *
 * Everything here is plain JS in the loader's factory form: no JSX, no bundler,
 * `require('react')` for the runtime and `ctx.connection.rpc.call('/api', ...)`
 * for the sessionless `homepage/*` endpoints.
 *
 * @module dsh-homepage/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-homepage',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var NS = 'homepage'
    var PANEL_ID = 'homepage'
    var SIDEBAR_ORDER = 5
    var DETAIL_ORDER = 5
    /** The expanded card's width, as a fraction of the wall it floats over. */
    var FOCUS_WIDTH = 0.75

    // ------------------------------------------------------------ runtime

    /**
     * Wiring set by `apply`; kept here so components defined below can use it.
     *
     * The session fields are not set by `apply`: they are written during render
     * by the bridge components in front of the wall, so a card that reads
     * `api.sessionStatus` / `api.sessionList` sees the snapshot of the render it
     * is part of rather than the previous one.
     */
    var runtime = {
      call: null,
      locale: null,
      t: function (key) { return key },
      /** `ReadonlyMap<sessionId, SessionStatus>` of the current render, or null. */
      sessionStatus: null,
      /** `{ ids?, byId }` session list snapshot of the current render, or null. */
      sessionList: null,
      /** Replaced by `apply`; `false` until the workspace service is known. */
      openSession: function () { return false },
      /** `homepage/collect`, replaced by `apply` once the channel exists. */
      collect: function () {
        return Promise.resolve({ at: Date.now(), entries: {}, error: 'the collector is unavailable' })
      },
      /** `homepage/act`, replaced by `apply` once the channel exists. */
      act: function (action) {
        return Promise.resolve({
          ok: false,
          action: action === undefined || action === null ? '' : String(action),
          error: 'the action layer is unavailable',
        })
      },
    }

    /**
     * Call one sessionless `homepage/*` endpoint over the shared /api channel.
     * @param endpoint - `<namespace>/<method>`, e.g. `homepage/overview`.
     * @param args - positional argument map.
     * @returns a promise of the unwrapped value; business errors reject.
     */
    function remoteCall(endpoint, args) {
      if (typeof runtime.call !== 'function') {
        return Promise.reject(new Error('homepage: the shared RPC channel is unavailable'))
      }
      return runtime.call('/api', endpoint, { args: args || {} }).then(function (envelope) {
        if (!envelope || envelope.ok !== true) {
          var message = envelope && envelope.error !== undefined
            ? String(envelope.error.message !== undefined ? envelope.error.message : envelope.error)
            : 'remote call failed'
          throw new Error(String(message).replace(/^homepage:\s*/, ''))
        }
        return envelope.value
      })
    }

    /**
     * @param error - anything thrown or rejected with.
     * @returns the message to show, or to hand to a card.
     */
    function errorText(error) {
      if (error === undefined || error === null) return 'unknown error'
      if (typeof error === 'string') return error
      return String(error.message !== undefined ? error.message : error)
    }

    // --------------------------------------------------------------- store

    var EMPTY_STATE = { version: 1, order: [], layout: {}, effects: {}, controls: {}, settings: {}, appearance: {}, hidden: [] }

    /**
     * Normalise a wall-state document from any source: the Host, the browser
     * cache, or a patch. One shape everywhere, so the first paint and the
     * reconciled paint cannot disagree about a field.
     * @param value - a state document, or anything at all.
     * @returns the canonical document.
     */
    function stateDocumentOf(value) {
      var source = value && typeof value === 'object' ? value : {}
      return {
        version: 1,
        order: Array.isArray(source.order) ? source.order : [],
        layout: source.layout || {},
        effects: source.effects || {},
        controls: source.controls || {},
        settings: source.settings || {},
        appearance: source.appearance || {},
        hidden: Array.isArray(source.hidden) ? source.hidden : [],
      }
    }

    /**
     * The last wall state this browser painted. Reading it synchronously at
     * mount is what makes the panel open on the user's layout instead of on an
     * empty wall that is replaced a moment later.
     */
    var STATE_CACHE_KEY = 'dsh-homepage.wall-state.v1'

    /** @returns the cached document, or null when there is none readable. */
    function readStateCache() {
      try {
        if (typeof localStorage === 'undefined') return null
        var raw = localStorage.getItem(STATE_CACHE_KEY)
        if (!raw) return null
        var held = JSON.parse(raw)
        return held && typeof held === 'object' ? stateDocumentOf(held) : null
      } catch (error) { void error; return null }
    }

    /** @param state - the document to remember for the next page load. */
    function writeStateCache(state) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(STATE_CACHE_KEY, JSON.stringify(stateDocumentOf(state)))
      } catch (error) { void error }
    }

    var cachedState = readStateCache()

    var store = {
      version: 0,
      state: Object.assign({}, EMPTY_STATE),
      notifications: {},
      toasts: [],
      expanded: null,
      customizing: false,
      designing: null,
      arrangementMessage: '',
      focusFrom: null,
      hovered: null,
      drag: null,
      hostReady: false,
      hostError: null,
    }

    // The first paint uses what this browser painted last; bootstrap reconciles
    // it with the Host's copy as soon as that answers.
    if (cachedState) store.state = cachedState

    var subscribers = new Set()
    var notificationSeq = 0
    var toastSeq = 0

    /** @returns the current store version, the snapshot `useSyncExternalStore` reads. */
    function storeVersion() { return store.version }
    /** @param listener - called after every change. @returns an unsubscribe function. */
    function subscribeStore(listener) {
      subscribers.add(listener)
      return function () { subscribers.delete(listener) }
    }
    /** Bump the version and wake every subscriber. */
    function bump() {
      store.version += 1
      subscribers.forEach(function (listener) {
        try { listener() } catch (error) { console.error('homepage: store subscriber failed', error) }
      })
    }

    /** Replace the persisted UI state and notify. @param patch - partial state. */
    function patchState(patch) {
      store.state = Object.assign({}, store.state, patch)
      bump()
      scheduleSave()
    }

    /** Update one nested section of the persisted state. */
    function patchSection(section, id, value) {
      var current = store.state[section] && typeof store.state[section] === 'object' ? store.state[section] : {}
      var next = Object.assign({}, current)
      if (value === null || value === undefined) delete next[id]
      else next[id] = value
      patchState(defineKey(section, next))
    }

    /** @returns a one-key patch object. */
    function defineKey(key, value) {
      var patch = {}
      patch[key] = value
      return patch
    }

    var saveTimer = null
    /** Persist the whole UI state, coalesced so a drag does not write per frame. */
    function scheduleSave() {
      if (saveTimer !== null) clearTimeout(saveTimer)
      saveTimer = setTimeout(function () {
        saveTimer = null
        var snapshot = store.state
        // Remember it before the write: a refresh in the middle of a save still
        // paints the layout the user just arranged.
        writeStateCache(snapshot)
        remoteCall('homepage/saveState', { patch: snapshot }).then(function (persisted) {
          if (persisted && typeof persisted === 'object' && persisted.updatedAt) {
            store.state = Object.assign({}, store.state, { updatedAt: persisted.updatedAt })
          }
        }).catch(function (error) {
          store.hostError = String(error && error.message ? error.message : error)
          bump()
        })
      }, 350)
    }

    // ------------------------------------------------------------- notices

    var NOTICE_LEVELS = ['info', 'warn', 'error']
    var NOTICE_COLORS = {
      info: 'var(--dsw-alias-state-success-primary, #2ea043)',
      warn: 'var(--dsw-alias-state-warn-primary, #d29922)',
      error: 'var(--dsw-alias-state-error-primary, #e5484d)',
    }

    /**
     * Raise one notification on a card. Levels render as the green / yellow / red
     * bubble in the card's top-right corner.
     * @param cardId - owning card.
     * @param level - `info`, `warn` or `error`.
     * @param text - human-readable message.
     * @returns the notification id.
     */
    function notify(cardId, level, text) {
      var normalized = NOTICE_LEVELS.indexOf(level) >= 0 ? level : 'info'
      var list = store.notifications[cardId]
      if (!Array.isArray(list)) { list = []; store.notifications[cardId] = list }
      notificationSeq += 1
      var entry = { id: notificationSeq, level: normalized, text: String(text), at: Date.now() }
      list.push(entry)
      if (list.length > 24) list.splice(0, list.length - 24)
      bump()
      return entry.id
    }

    /** Remove every notification a card raised. @param cardId - owning card. */
    function clearNotifications(cardId) {
      if (store.notifications[cardId] === undefined) return
      delete store.notifications[cardId]
      bump()
    }

    /** Remove one notification. */
    function dismissNotification(cardId, id) {
      var list = store.notifications[cardId]
      if (!Array.isArray(list)) return
      store.notifications[cardId] = list.filter(function (entry) { return entry.id !== id })
      bump()
    }

    /**
     * Replace a card's notices with a single annunciator — the shape a card
     * wants when it is reporting *state* rather than recording events.
     * @param cardId - owning card.
     * @param level - `info`, `warn` or `error`.
     * @param text - human-readable message.
     * @returns the notification id.
     */
    function announce(cardId, level, text) {
      clearNotifications(cardId)
      return notify(cardId, level, text)
    }

    /** @returns the highest severity present, which is the bubble's colour. */
    function noticeTop(list) {
      if (!Array.isArray(list) || list.length === 0) return null
      var best = 'info'
      list.forEach(function (entry) {
        if (NOTICE_LEVELS.indexOf(entry.level) > NOTICE_LEVELS.indexOf(best)) best = entry.level
      })
      return { level: best, count: list.length, latest: list[list.length - 1] }
    }

    /** Raise a transient page-level toast. @param text - message. @param level - severity. */
    function pushToast(text, level) {
      toastSeq += 1
      var entry = { id: toastSeq, text: String(text), level: level || 'info', at: Date.now() }
      store.toasts = store.toasts.concat([entry])
      bump()
      setTimeout(function () {
        store.toasts = store.toasts.filter(function (item) { return item.id !== entry.id })
        bump()
      }, 3200)
      return entry.id
    }

    // ------------------------------------------------------------ popovers

    // A dropdown or a notice panel has to be drawn over the whole wall, not
    // inside the card that owns it: `.ph-shell` hides its overflow, and a
    // focused wall is a blurred stacking context. So an open popover leaves its
    // card's subtree — the panel renders it, placed from the anchor's measured
    // box — and it is torn down when its owner unmounts, which is what keeps a
    // menu from outliving the card that opened it.
    var popover = null
    var popoverListeners = new Set()
    var popoverSeq = 0

    function subscribePopover(listener) {
      popoverListeners.add(listener)
      return function () { popoverListeners.delete(listener) }
    }

    /** @returns the open popover spec, or null. */
    function popoverSnapshot() { return popover }

    function usePopover() {
      return React.useSyncExternalStore(subscribePopover, popoverSnapshot)
    }

    /** @returns a process-unique popover id. */
    function nextPopoverId(prefix) {
      popoverSeq += 1
      return prefix + '-' + popoverSeq
    }

    /**
     * Measure an anchor against the panel, because the popover layer is
     * absolute inside `.ph-panel` and a nested card is not.
     * @returns `{left, top, right, bottom, width, height, hostWidth, hostHeight}` in panel px, or null.
     */
    function anchorBox(element) {
      try {
        if (!element || typeof element.getBoundingClientRect !== 'function') return null
        var rect = element.getBoundingClientRect()
        var host = typeof document !== 'undefined' && document.querySelector ? document.querySelector('.ph-panel') : null
        var base = host && typeof host.getBoundingClientRect === 'function'
          ? host.getBoundingClientRect()
          : { left: 0, top: 0, width: 0, height: 0 }
        return {
          left: rect.left - base.left,
          top: rect.top - base.top,
          right: rect.right - base.left,
          bottom: rect.bottom - base.top,
          width: rect.width,
          height: rect.height,
          hostWidth: base.width,
          hostHeight: base.height,
        }
      } catch (error) {
        return null
      }
    }

    /** @returns the absolute-placement style for a popover anchored to `box`. */
    function popoverPlacement(box, options) {
      var spec = options || {}
      var style = { position: 'absolute' }
      if (!box) return style
      if (spec.minWidth) style.minWidth = spec.minWidth + 'px'
      if (spec.width === 'anchor') style.width = box.width + 'px'
      var width = spec.estimate || 180
      var room = box.hostWidth ? box.hostWidth - box.left : Infinity
      if (spec.align === 'end' || (spec.align !== 'start' && box.hostWidth && room < width + 12)) {
        style.right = Math.max(8, box.hostWidth - box.right) + 'px'
      } else {
        style.left = box.left + 'px'
      }
      if (spec.place === 'top') style.bottom = Math.max(8, box.hostHeight - box.top + 6) + 'px'
      else style.top = box.bottom + (spec.gap === undefined ? 6 : spec.gap) + 'px'
      return style
    }

    function openPopover(spec) {
      popover = spec
      popoverListeners.forEach(function (listener) { listener() })
    }

    /** Close the open popover — all of them, or only the one owned by `id`. */
    function closePopover(id) {
      if (!popover) return
      if (id !== undefined && id !== null && popover.id !== id) return
      popover = null
      popoverListeners.forEach(function (listener) { listener() })
    }

    function togglePopover(spec) {
      if (popover && popover.id === spec.id) { closePopover(); return }
      openPopover(spec)
    }

    /**
     * The one layer every popover renders into. It dismisses on an outside
     * press or Escape; Escape is consumed so closing a menu does not also
     * collapse the card behind it.
     */
    function PopoverLayer() {
      var spec = usePopover()
      var layer = React.useRef(null)
      React.useEffect(function () {
        if (!spec) return undefined
        var onDown = function (event) {
          var target = event ? event.target : null
          var node = layer.current
          if (node && typeof node.contains === 'function' && target && node.contains(target)) return
          if (target && typeof target.closest === 'function' && target.closest('[data-popover-anchor="' + spec.id + '"]')) return
          closePopover(spec.id)
        }
        var onKey = function (event) {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          closePopover(spec.id)
        }
        window.addEventListener('pointerdown', onDown, true)
        window.addEventListener('keydown', onKey, true)
        return function () {
          window.removeEventListener('pointerdown', onDown, true)
          window.removeEventListener('keydown', onKey, true)
        }
      }, [spec])
      if (!spec) return null
      return h('div', { className: 'ph-popover-layer', ref: layer }, spec.render())
    }

    // ------------------------------------------------------------ registry

    /** Registration order, preserved so an un-ordered card keeps its place. */
    var registry = []
    var registryById = {}
    /** Listeners woken after every registration change. @see subscribeRegistry */
    var registryListeners = []
    /**
     * Who a card belongs to when its definition does not say. Read lazily: the
     * plugin's own name is assigned further down the factory body, after this
     * point, and every card registers after that assignment has run.
     */
    function pluginName() { return name === undefined ? NS : name }

    var DEFAULT_SIZE = { w: 1, h: 1 }
    var DEFAULT_EFFECTS = { outline: 'none', ripple: false, float: false, sheen: false }

    /**
     * Normalize one card definition, filling every optional field so the renderer
     * never has to branch on a missing key.
     * @param definition - what the registrant passed.
     * @returns the stored card.
     */
    function normalizeCard(definition) {
      var size = definition.size && typeof definition.size === 'object' ? definition.size : {}
      var hover = definition.hover === true || definition.hover === undefined ? {} : (definition.hover || {})
      var effects = Object.assign({}, DEFAULT_EFFECTS, definition.effects || {})
      return {
        id: String(definition.id),
        title: definition.title === undefined ? String(definition.id) : definition.title,
        subtitle: definition.subtitle === undefined ? null : definition.subtitle,
        icon: definition.icon === undefined ? null : definition.icon,
        size: { w: clampSpan(size.w, DEFAULT_SIZE.w), h: clampSpan(size.h, DEFAULT_SIZE.h) },
        minSize: definition.minSize || { w: 1, h: 1 },
        maxSize: definition.maxSize || { w: 4, h: 4 },
        accent: definition.accent === undefined ? null : definition.accent,
        background: definition.background === undefined ? null : definition.background,
        texture: definition.texture === undefined ? null : definition.texture,
        content: typeof definition.content === 'function' ? definition.content : function () { return null },
        detail: typeof definition.detail === 'function' ? definition.detail : null,
        detailTitle: definition.detailTitle === undefined ? null : definition.detailTitle,
        hover: {
          grow: hover.grow === undefined ? 1.045 : hover.grow,
          content: typeof hover.content === 'function' ? hover.content : null,
          hint: false,
          disabled: hover.disabled === true,
        },
        actions: Array.isArray(definition.actions) ? definition.actions.slice() : [],
        detailActions: Array.isArray(definition.detailActions) ? definition.detailActions.slice() : [],
        effects: effects,
        refreshMs: Number(definition.refreshMs) > 0 ? Number(definition.refreshMs) : 0,
        expandable: definition.expandable !== false,
        draggable: definition.draggable !== false,
        resizable: definition.resizable !== false,
        onMount: typeof definition.onMount === 'function' ? definition.onMount : null,
        onExpand: typeof definition.onExpand === 'function' ? definition.onExpand : null,
        onCollapse: typeof definition.onCollapse === 'function' ? definition.onCollapse : null,
        tags: Array.isArray(definition.tags) ? definition.tags.slice() : [],
        order: Number.isFinite(Number(definition.order)) ? Number(definition.order) : 0,
        shipped: definition.shipped === true,
        owner: String(definition.owner === undefined ? pluginName() : definition.owner),
        version: definition.version === undefined ? null : String(definition.version),
        dict: definition.dict && typeof definition.dict === 'object' ? definition.dict : null,
        raw: definition,
      }
    }

    /** Clamp one grid span into the 1..4 range the layout supports. */
    function clampSpan(value, fallback) {
      var number = Number(value)
      if (!Number.isFinite(number)) return fallback
      return Math.max(1, Math.min(4, Math.round(number)))
    }

    /**
     * Register a card, or replace the card already registered under the same id.
     * This is the whole extension point: any plugin that can reach the client
     * bundle can call it, and a shipped card may be overridden in place when the
     * registrant opts in with `override: true`.
     *
     * Every card carries the `owner` that registered it (the plugin's own name
     * unless the definition says otherwise), which is what makes the registry
     * identifiable: {@link ownerOf}, {@link cardsOf}, {@link manifest} and
     * {@link pluginHandle} all read it. A definition may also carry `dict`
     * (`{ zh, en }`) to add its own strings.
     *
     * @param definition - card definition; `id` is required.
     * @returns the stored card.
     * @throws Error when the definition cannot be used, or when it would replace
     *   a card owned by another plugin without `override: true`.
     */
    function defineCard(definition) {
      if (!definition || typeof definition !== 'object') {
        throw new Error('homepage: a card definition must be an object')
      }
      var id = String(definition.id === undefined ? '' : definition.id).trim()
      if (id === '') throw new Error('homepage: card.id is required')
      var owner = definition.owner === undefined ? pluginName() : String(definition.owner)
      var next = normalizeCard(Object.assign({}, definition, { id: id, owner: owner }))
      var existing = registryById[id]
      if (existing) {
        if (existing.shipped && definition.override !== true) {
          throw new Error('homepage: card "' + id + '" is shipped; pass override: true to replace it')
        }
        if (existing.owner !== owner && existing.owner !== pluginName() && definition.override !== true) {
          throw new Error('homepage: card "' + id + '" belongs to "' + existing.owner
            + '"; pass override: true to replace it from "' + owner + '"')
        }
        registry[registry.indexOf(existing)] = next
        registryById[id] = next
      } else {
        registry.push(next)
        registryById[id] = next
      }
      if (definition.dict) {
        dict(definition.dict)
        refreshDictionaries()
      }
      bump()
      emitRegistry({
        type: existing ? 'replace' : 'define',
        id: id,
        owner: owner,
        card: next,
        previous: existing || null,
      })
      return next
    }

    /**
     * Drop a registered card.
     * @param id - card id.
     * @returns true when a card was removed.
     */
    function removeCard(id) {
      var card = registryById[id]
      if (!card) return false
      registry.splice(registry.indexOf(card), 1)
      delete registryById[id]
      delete store.notifications[id]
      if (store.expanded === id) store.expanded = null
      if (store.expanded === null) store.focusFrom = null
      bump()
      emitRegistry({ type: 'remove', id: id, owner: card.owner, card: card, previous: card })
      return true
    }

    // ------------------------------------------------- registration surface
    // What another plugin needs to identify the wall it is registering into: who
    // owns what, a serializable manifest for tooling, a change feed, and a
    // scoped handle so a plugin can only touch its own cards.

    /** @returns whether a card is registered under this id. */
    function has(id) { return Boolean(registryById[id]) }

    /** @returns the plugin that registered a card, or null. */
    function ownerOf(id) {
      var card = registryById[id]
      return card ? card.owner : null
    }

    /** @returns every card one plugin registered, in registration order. */
    function cardsOf(owner) {
      return registry.filter(function (card) { return card.owner === owner })
    }

    /** @returns every plugin name that currently owns a card. */
    function owners() {
      var seen = []
      registry.forEach(function (card) { if (seen.indexOf(card.owner) < 0) seen.push(card.owner) })
      return seen
    }

    /**
     * A serializable description of one card: what a registry browser or a
     * collision check needs, with the render functions left out.
     * @param card - a stored card.
     * @returns the descriptor.
     */
    function cardManifest(card) {
      var controls = card.actions.map(function (action) {
        return { id: action.id, scope: 'preview', type: action.type === undefined ? null : action.type }
      }).concat(card.detailActions.map(function (action) {
        return { id: action.id, scope: 'detail', type: action.type === undefined ? null : action.type }
      }))
      var effects = Object.keys(card.effects).filter(function (key) {
        var value = card.effects[key]
        return value !== false && value !== 'none' && value !== null && value !== undefined
      })
      return {
        id: card.id,
        owner: card.owner,
        version: card.version,
        shipped: card.shipped,
        title: typeof card.title === 'string' ? card.title : null,
        localizedTitle: typeof card.title === 'function',
        size: { w: card.size.w, h: card.size.h },
        minSize: { w: card.minSize.w, h: card.minSize.h },
        maxSize: { w: card.maxSize.w, h: card.maxSize.h },
        accent: card.accent,
        tags: card.tags.slice(),
        order: card.order,
        expandable: card.expandable,
        controls: controls,
        effects: effects,
      }
    }

    /**
     * @param id - optional card id.
     * @returns the manifest of one card, or of every card in registration order.
     */
    function manifest(id) {
      if (id !== undefined) {
        var card = registryById[id]
        return card ? cardManifest(card) : null
      }
      return registry.map(cardManifest)
    }

    /** @returns the listeners called after every registration change. */
    function emitRegistry(event) {
      registryListeners.slice().forEach(function (listener) {
        try { listener(event) } catch (error) { void error }
      })
    }

    /**
     * Watch the registry — how a plugin notices that a card it extends (or one
     * that collides with it) appeared.
     * @param listener - called with `{ type, id, owner, card, previous }`; `type`
     *   is `define`, `replace` or `remove`.
     * @returns an unsubscribe function.
     */
    function subscribeRegistry(listener) {
      if (typeof listener !== 'function') {
        throw new Error('homepage: subscribeRegistry takes a function')
      }
      registryListeners.push(listener)
      return function () {
        var index = registryListeners.indexOf(listener)
        if (index >= 0) registryListeners.splice(index, 1)
      }
    }

    /**
     * Drop the cards one plugin registered. Shipped cards are kept: only the
     * framework can take those away.
     * @param owner - the plugin name.
     * @returns the ids that were removed.
     */
    function unregisterOwner(owner) {
      var doomed = cardsOf(owner).filter(function (card) { return !card.shipped })
      return doomed.map(function (card) {
        removeCard(card.id)
        return card.id
      })
    }

    /**
     * A scoped handle, stamped with a plugin's name: the registration and
     * identification surface a third-party plugin should use, since it can only
     * see and touch its own cards.
     * @param ownerName - the plugin name.
     * @returns the handle.
     */
    function pluginHandle(ownerName) {
      var owner = String(ownerName === undefined ? '' : ownerName).trim()
      if (owner === '') throw new Error('homepage: a plugin handle needs a name')
      function assertOwned(id) {
        var card = registryById[id]
        if (!card) return false
        if (card.owner !== owner) {
          throw new Error('homepage: card "' + id + '" belongs to "' + card.owner + '", not "' + owner + '"')
        }
        return true
      }
      return {
        name: owner,
        define: function (definition) {
          return defineCard(Object.assign({}, definition, { owner: owner }))
        },
        remove: function (id) {
          assertOwned(id)
          return removeCard(id)
        },
        has: has,
        ownerOf: ownerOf,
        cardsOf: cardsOf,
        get: function (id) { return registryById[id] || null },
        list: function () { return cardsOf(owner) },
        manifest: function () { return cardsOf(owner).map(cardManifest) },
        defineEffect: function (effectName, spec) { return defineEffect(effectName, spec, owner) },
        unregister: function () { return unregisterOwner(owner) },
      }
    }

    /**
     * The render order: the order the user dragged into (`state.order`) wins,
     * then every card it does not mention by the `order` the registrant asked
     * for, then registration order as the tie-break. Ids in the state that no
     * longer exist are dropped.
     * @returns the ordered card list.
     */
    function orderedCards() {
      var seen = {}
      var out = []
      var order = Array.isArray(store.state.order) ? store.state.order : []
      order.forEach(function (id) {
        var card = registryById[id]
        if (card && !seen[id]) { seen[id] = true; out.push(card) }
      })
      registry
        .map(function (card, index) { return { card: card, index: index } })
        .sort(function (left, right) {
          if (left.card.order !== right.card.order) return left.card.order - right.card.order
          return left.index - right.index
        })
        .forEach(function (entry) {
          if (!seen[entry.card.id]) { seen[entry.card.id] = true; out.push(entry.card) }
        })
      return out
    }

    var layoutGeneration = 0
    var pendingLayoutTransition = null

    /** Animate from the current visual position, including interrupted reflows. */
    function layoutTransition() {
      if (typeof document === 'undefined' || typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function'
        || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return function () {}
      var generation = ++layoutGeneration
      var before = new Map()
      document.querySelectorAll('.ph-cell').forEach(function (node) { before.set(node.getAttribute('data-card-cell'), node.getBoundingClientRect()) })
      var apply = function () {
          if (generation !== layoutGeneration) return
          if (pendingLayoutTransition === apply) pendingLayoutTransition = null
          document.querySelectorAll('.ph-cell').forEach(function (node) {
            var first = before.get(node.getAttribute('data-card-cell'))
            if (!first || typeof node.animate !== 'function') return
            if (node.__phLayoutAnimation) node.__phLayoutAnimation.cancel()
            node.__phLayoutAnimation = null
            var last = node.getBoundingClientRect()
            var dx = first.left - last.left; var dy = first.top - last.top
            if (Math.abs(dx) + Math.abs(dy) < 1 || (store.drag && store.drag.id === node.getAttribute('data-card-cell'))) return
            var animation = node.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'translate(0,0)' }], { duration: 320, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' })
            node.__phLayoutAnimation = animation
            animation.onfinish = function () {
              if (node.__phLayoutAnimation === animation) { node.__phLayoutAnimation = null; animation.cancel() }
            }
          })
      }
      // Install before bump(): React's layout effect inverts the committed grid
      // before paint, even when the reorder itself originated in a rAF callback.
      pendingLayoutTransition = apply
      return function () {
        if (typeof React === 'undefined' || typeof React.useLayoutEffect !== 'function') window.requestAnimationFrame(apply)
      }
    }

    /** Move the dragged card into the slot of the card under the pointer. */
    function reorderCards(fromId, toId) {
      var ids = orderedCards().map(function (card) { return card.id })
      var from = ids.indexOf(fromId)
      var to = ids.indexOf(toId)
      if (from < 0 || to < 0 || from === to) return
      var animate = layoutTransition()
      ids.splice(to, 0, ids.splice(from, 1)[0])
      store.state = Object.assign({}, store.state, { order: ids })
      bump(); animate()
    }

    // ------------------------------------------------------------- effects

    /**
     * Named animation presets. A registrant can add its own with `defineEffect`,
     * and a card can pick one per card at runtime.
     */
    var EFFECTS = {
      none: {
        label: function () { return runtime.t('fx.none.label') },
        description: function () { return runtime.t('fx.none.description') },
      },
      outline: {
        label: function () { return runtime.t('fx.outline.label') },
        description: function () { return runtime.t('fx.outline.description') },
      },
      glow: {
        label: function () { return runtime.t('fx.glow.label') },
        description: function () { return runtime.t('fx.glow.description') },
      },
      scan: {
        label: function () { return runtime.t('fx.scan.label') },
        description: function () { return runtime.t('fx.scan.description') },
      },
      float: {
        label: function () { return runtime.t('fx.float.label') },
        description: function () { return runtime.t('fx.float.description') },
      },
      spotlight: {
        label: function () { return runtime.t('fx.spotlight.label') },
        description: function () { return runtime.t('fx.spotlight.description') },
      },
    }

    /**
     * Register an animation preset. The preset only supplies a CSS class name
     * from the injected stylesheet; a registrant that needs its own keyframes
     * passes a `css` string as well.
     * @param name - preset id.
     * @param spec - `{ label, description, className, css }`.
     * @param owner - the plugin that owns the preset; defaults to this one.
     * @returns nothing.
     */
    function defineEffect(name, spec, owner) {
      var key = String(name || '').trim()
      if (key === '') throw new Error('homepage: an effect needs a name')
      var provided = spec && typeof spec === 'object' ? spec : {}
      EFFECTS[key] = {
        label: provided.label === undefined ? key : provided.label,
        description: provided.description === undefined ? '' : provided.description,
        className: provided.className === undefined ? 'ph-fx-' + key : provided.className,
        css: typeof provided.css === 'string' ? provided.css : null,
        owner: String(owner === undefined ? pluginName() : owner),
      }
      if (typeof EFFECTS[key].css === 'string' && typeof runtime.insertCss === 'function') {
        runtime.insertCss(EFFECTS[key].css)
      }
    }

    /** @returns the effect presets that apply to one card, honouring its own defaults. */
    function cardEffectNames(card) {
      var source = cardEffectRecord(card)
      var names = []
      if (source && typeof source.outline === 'string' && source.outline !== 'none' && EFFECTS[source.outline]) {
        names.push(EFFECTS[source.outline].className || 'ph-fx-' + source.outline)
      }
      ;['ripple', 'float', 'sheen', 'spotlight'].forEach(function (flag) {
        if (source && source[flag]) names.push('ph-fx-' + flag)
      })
      if (source && source.trigger === 'hover') names.push('ph-motion-hover')
      return names
    }

    /** @returns whether a card's effect record turns the pointer spotlight on. */
    function hasSpotlight(record) {
      return Boolean(record && (record.spotlight || record.outline === 'spotlight'))
    }

    /** @returns the effect record in force for a card, stored value first. */
    function cardEffectRecord(card) {
      var stored = (store.state.effects || {})[card.id]
      return stored && typeof stored === 'object' ? Object.assign({}, card.effects, stored) : card.effects
    }

    // ----------------------------------------------------------- controls

    /** @returns the current value of one registered control. */
    function controlValue(card, action) {
      var perCard = (store.state.controls || {})[card.id]
      if (perCard && Object.prototype.hasOwnProperty.call(perCard, action.id)) return perCard[action.id]
      if (action.value !== undefined) return action.value
      if (Array.isArray(action.options) && action.options.length > 0) return action.options[0].value
      if (action.type === 'switch') return false
      return null
    }

    /** Store one control value and notify the card's `onChange`. */
    function setControlValue(card, action, value) {
      var current = (store.state.controls || {})[card.id]
      var next = Object.assign({}, current || {})
      next[action.id] = value
      patchSection('controls', card.id, next)
      if (typeof action.onChange === 'function') {
        try { action.onChange(value, cardApi(card)) }
        catch (error) { notify(card.id, 'error', String(error && error.message ? error.message : error)) }
      }
    }

    /**
     * The object handed to every card renderer: the registration-time effects a
     * card needs to drive its own notifications, controls, size and expansion.
     * @param card - stored card.
     * @returns the per-card API.
     */
    function cardApi(card) {
      return {
        id: card.id,
        def: card,
        get controls() {
          var out = {}
          card.actions.concat(card.detailActions).forEach(function (action) {
            out[action.id] = controlValue(card, action)
          })
          return out
        },
        control: function (actionId) {
          var action = findAction(card, actionId)
          return action ? controlValue(card, action) : null
        },
        setControl: function (actionId, value) {
          var action = findAction(card, actionId)
          if (action) setControlValue(card, action, value)
        },
        notify: function (level, text) { return notify(card.id, level, text) },
        clearNotifications: function () { clearNotifications(card.id) },
        /** Raise one notice, replacing whatever this card was announcing. */
        announce: function (level, text) { return announce(card.id, level, text) },
        /** Retract this card's notice entirely. */
        retract: function () { clearNotifications(card.id) },
        toast: pushToast,
        expand: function () { expandCard(card.id) },
        collapse: collapseCard,
        repaint: bump,
        setSize: function (size) {
          var animate = layoutTransition()
          var layout = Object.assign({}, (store.state.layout || {})[card.id] || {})
          if (size && size.w !== undefined) layout.w = clampSpan(size.w, card.size.w)
          if (size && size.h !== undefined) layout.h = clampSpan(size.h, card.size.h)
          patchSection('layout', card.id, layout)
          animate()
        },
        setEffect: function (name) {
          var record = Object.assign({}, cardEffectRecord(card), { outline: name })
          patchSection('effects', card.id, record)
        },
        setBackground: function (background) {
          patchSection('layout', card.id, Object.assign({}, (store.state.layout || {})[card.id] || {}, { background: background }))
        },
        format: formatNumber,
        remote: remoteCall,
        /**
         * The live session status snapshot (`ReadonlyMap<sessionId, SessionStatus>`),
         * or null when this host has no session store. Bridged from the main
         * slot's `useSessionStatus` prop during the same render.
         */
        get sessionStatus() { return runtime.sessionStatus },
        /** The session list snapshot (`{ ids?, byId }`), or null. Same bridge. */
        get sessionList() { return runtime.sessionList },
        /**
         * Bring a session into the main view.
         * @param sessionId - the session to open.
         * @returns whether the navigation was started; false when the workspace
         *   service is missing or refused the target.
         */
        openSession: function (sessionId) {
          return typeof runtime.openSession === 'function' ? runtime.openSession(sessionId) : false
        },
        /**
         * Open one registered workspace and start its session.
         * @param workspaceId - the workspace to open.
         * @returns whether the navigation was started; false when the workspace
         *   service is missing or refused the target.
         */
        openWorkspace: function (workspaceId) {
          return typeof runtime.openWorkspace === 'function' ? runtime.openWorkspace(workspaceId) : false
        },
        /**
         * Read the host collector over `homepage/collect`.
         * @param names - item names to read; omit for every item.
         * @param options - `{ force }`.
         * @returns `{ at, entries }`, plus `error` when the call itself failed.
         *   Never rejects.
         */
        collect: function (names, options) {
          return typeof runtime.collect === 'function'
            ? runtime.collect(names, options)
            : Promise.resolve({ at: Date.now(), entries: {} })
        },
        /**
         * Run one host action over `homepage/act`.
         * @param action - a registered action id, e.g. `session.stop`.
         * @param payload - the action's arguments.
         * @returns `{ ok, action, value }` or `{ ok: false, action, error }`.
         *   Never rejects.
         */
        act: function (action, payload) {
          return typeof runtime.act === 'function'
            ? runtime.act(action, payload)
            : Promise.resolve({
              ok: false,
              action: action === undefined || action === null ? '' : String(action),
              error: 'the action layer is unavailable',
            })
        },
        /**
         * Whether the pointer is resting on this card right now. A card that
         * wants its own hover treatment — instead of registering `hover.content`
         * — reads this, and every hover change re-renders it.
         */
        get hovered() { return store.hovered === card.id && !store.drag },
        /** Whether this card is the one currently being dragged. */
        get dragging() { return Boolean(store.drag && store.drag.id === card.id) },
        /** Whether this card owns the expanded page. */
        get expanded() { return store.expanded === card.id },
        /** The current wall density: `compact` | `standard` | `cozy`. */
        get density() { return (store.state.settings || {}).density || 'standard' },
        /** Whether the wall is in edit mode (handles and size controls showing). */
        get editing() { return Boolean((store.state.settings || {}).edit) },
      }
    }

    /** @returns the first action on a card with this id. */
    function findAction(card, actionId) {
      var all = card.actions.concat(card.detailActions)
      for (var index = 0; index < all.length; index++) {
        if (all[index].id === actionId) return all[index]
      }
      return null
    }

    // ------------------------------------------------------------- helpers

    /**
     * Resolve a value a registrant may hand over either as a plain value or as
     * a thunk. Titles, subtitles, labels and option captions all accept both,
     * because the framework cannot know whether the caller is locale-aware.
     * @param value - plain value or a zero-argument function.
     * @returns the resolved value.
     */
    function textOf(value) {
      if (typeof value !== 'function') return value
      try { return value() } catch (error) { return String(error && error.message ? error.message : error) }
    }

    /**
     * Stylesheet text registered at runtime, keyed by owner. The panel renders
     * one `<style>` element per entry, so a card can ship its own keyframes or
     * a custom effect without reaching for the document.
     */
    var customCss = {}
    var customCssSeq = 0

    /**
     * Register a stylesheet fragment for as long as the returned disposer is
     * not called. Two identical strings still occupy two keys: the caller owns
     * the lifetime, the framework does not deduplicate.
     * @param css - stylesheet text.
     * @returns a disposer that removes the fragment.
     */
    function insertCss(css) {
      if (typeof css !== 'string' || css.length === 0) return function () {}
      var key = 'ph-css-' + (++customCssSeq)
      customCss[key] = css
      bump()
      return function () {
        if (customCss[key] === undefined) return
        delete customCss[key]
        bump()
      }
    }

    /** @returns a finite number clamped into the grid span range. */
    function spanOf(value) {
      var number = Number(value)
      return Number.isFinite(number) ? Math.max(1, Math.min(4, Math.round(number))) : 1
    }

    /** @returns the effective `{ w, h }` span of a card. */
    function cardSpan(card) {
      var layout = (store.state.layout || {})[card.id] || {}
      return {
        w: spanOf(layout.w !== undefined ? layout.w : card.size.w),
        h: spanOf(layout.h !== undefined ? layout.h : card.size.h),
      }
    }

    /** @returns the per-card background declaration, or null. */
    function cardBackground(card) {
      var layout = (store.state.layout || {})[card.id] || {}
      return layout.background !== undefined ? layout.background : card.background
    }

    /** Format a decimal string for display, keeping at least two decimals. */
    function formatNumber(value, digits) {
      var number = Number(value)
      if (!Number.isFinite(number)) return String(value === undefined || value === null ? '-' : value)
      var places = typeof digits === 'number' ? digits : 2
      return number.toFixed(places)
    }

    /** @returns the currency symbol the UI shows. */
    function currencySymbol(currency) {
      return currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : ''
    }

    /**
     * Pick the wallet a card leads with. The Platform lists wallets in its own
     * order and a zeroed USD wallet often comes first, so prefer the ledger's
     * primary currency, then the first funded wallet, then the first one.
     * @returns the wallet to headline, or null when there are none.
     */
    function primaryWallet(data) {
      var list = (data && data.wallets) || []
      if (list.length === 0) return null
      var i
      for (i = 0; i < list.length; i += 1) if (list[i].currency === data.currency) return list[i]
      for (i = 0; i < list.length; i += 1) if (Number(list[i].balance) > 0) return list[i]
      return list[0]
    }

    /** @returns the first funded bonus wallet, or null when there is nothing to show. */
    function fundedBonus(data) {
      var list = (data && data.bonusWallets) || []
      for (var i = 0; i < list.length; i += 1) if (Number(list[i].balance) > 0) return list[i]
      return null
    }

    /** @returns an ISO-ish local day key, matching the host's ledger keys. */
    function dayKey(date) {
      var d = date || new Date()
      var pad = function (n) { return String(n).padStart(2, '0') }
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    }

    /** Expand or collapse one card's detail page. @param id - card id. */
    function expandCard(id) {
      var card = registryById[id]
      if (!card || !card.expandable) return
      // Where the card stood when it was clicked. The expanded card is an
      // overlay, so it can still fly out of the card that opened it: the
      // animation starts at the source rectangle and lands on the overlay's own
      // box. Measuring once here keeps the render path free of layout reads.
      store.focusFrom = store.customizing ? null : measureFocusOrigin(id)
      // Details need the full stage, not the studio's scrolled remainder.
      store.customizing = false
      store.expanded = id
      bump()
      if (card.onExpand) {
        try { card.onExpand(cardApi(card)) }
        catch (error) { notify(id, 'error', String(error && error.message ? error.message : error)) }
      }
    }

    /** Leave the detail page and return to the wall. */
    function collapseCard() {
      var id = store.expanded
      store.expanded = null
      store.focusFrom = null
      bump()
      var was = id ? registryById[id] : null
      if (was && was.onCollapse) {
        try { was.onCollapse(cardApi(was)) }
        catch (error) { console.error('homepage: onCollapse failed', error) }
      }
    }

    /**
     * The FLIP origin for the expand animation: the clicked card's shell
     * expressed against the expanded overlay, which is `FOCUS_WIDTH` of the
     * stage, centred. The overlay's own box is not measurable before it is
     * rendered, and it is not needed: the stage's box plus the known fraction
     * pin the target down well enough for the motion to read as one card
     * growing out of another.
     * @returns `{dx, dy, scale}` — px, px, unitless — or null when unmeasurable.
     */
    function measureFocusOrigin(id) {
      try {
        if (typeof document === 'undefined' || !document.querySelector) return null
        var shell = document.querySelector('[data-card-cell="' + id + '"] .ph-shell')
        var stage = document.querySelector('.ph-stage')
        if (!shell || !stage) return null
        if (typeof shell.getBoundingClientRect !== 'function' || typeof stage.getBoundingClientRect !== 'function') return null
        var source = shell.getBoundingClientRect()
        var box = stage.getBoundingClientRect()
        if (!source.width || !box.width || !box.height) return null
        var targetWidth = box.width * FOCUS_WIDTH
        var scale = source.width / targetWidth
        return {
          dx: source.left - (box.left + (box.width - targetWidth) / 2),
          dy: source.top + source.height / 2 - (box.top + box.height / 2),
          scale: Math.max(0.1, Math.min(1, scale)),
        }
      } catch (error) {
        return null
      }
    }

    /** @returns the topmost element carrying `data-card` under a point, or null. */
    function cardIdAtPoint(x, y) {
      var cells = document.querySelectorAll('[data-card-cell]')
      for (var index = 0; index < cells.length; index++) {
        var rect = cells[index].getBoundingClientRect()
        var offsetX = 0; var offsetY = 0
        // Hit-test layout slots, not the moving FLIP images: otherwise a card
        // crossing the stationary pointer can repeatedly reverse the reorder.
        if (cells[index].__phLayoutAnimation && window.DOMMatrixReadOnly && window.getComputedStyle) {
          var matrix = new window.DOMMatrixReadOnly(window.getComputedStyle(cells[index]).transform)
          offsetX = matrix.m41; offsetY = matrix.m42
        }
        if (x >= rect.left - offsetX && x <= rect.right - offsetX && y >= rect.top - offsetY && y <= rect.bottom - offsetY) {
          return cells[index].getAttribute('data-card-cell')
        }
      }
      return null
    }

    // ---------------------------------------------------------- data hooks

    /**
     * The hooks a card renderer may call, exposed as one object so a card
     * registered by another plugin reaches them the same way this bundle does.
     */
    var hooks = {}

    /**
     * Subscribe to a store change and hand back the live store.
     * @returns the store object.
     */
    function useStore() {
      React.useSyncExternalStore(subscribeStore, storeVersion)
      return store
    }

    /**
     * Load a Remote endpoint, optionally on a timer.
     * @param endpoint - `<namespace>/<method>`.
     * @param args - argument map.
     * @param options - `{ refreshMs, enabled }`.
     * @returns `{ data, error, busy, reload, at }`.
     */
    function useRemote(endpoint, args, options) {
      var settings = options || {}
      var ref = React.useRef({ data: null, error: null, busy: false, at: 0, failures: 0 })
      var ticket = React.useRef(0)
      var alive = React.useRef(true)
      var force = React.useState(0)
      var rerender = force[1]
      var argsKey = JSON.stringify(args || {})

      var load = React.useCallback(function (silent) {
        var current = ref.current
        ref.current = {
          data: current.data,
          error: silent ? current.error : null,
          busy: !silent,
          at: current.at,
          failures: current.failures,
        }
        rerender(function (n) { return n + 1 })
        var mine = ++ticket.current
        return remoteCall(endpoint, args || {}).then(function (value) {
          if (!alive.current || mine !== ticket.current) return null
          ref.current = { data: value, error: null, busy: false, at: Date.now(), failures: 0 }
          rerender(function (n) { return n + 1 })
          return value
        }).catch(function (error) {
          if (!alive.current || mine !== ticket.current) return null
          ref.current = {
            data: ref.current.data,
            error: String(error && error.message ? error.message : error),
            busy: false,
            at: Date.now(),
            failures: ref.current.failures + 1,
          }
          rerender(function (n) { return n + 1 })
          return null
        })
      }, [endpoint, argsKey])

      React.useEffect(function () {
        alive.current = true
        if (settings.enabled === false) return undefined
        void load(false)
        if (!settings.refreshMs) return function () { alive.current = false }
        var timer = setInterval(function () { void load(true) }, settings.refreshMs)
        return function () {
          alive.current = false
          clearInterval(timer)
        }
      }, [load, settings.refreshMs, settings.enabled])

      return {
        data: ref.current.data,
        error: ref.current.error,
        busy: ref.current.busy,
        at: ref.current.at,
        failures: ref.current.failures,
        reload: load,
      }
    }

    /**
     * Read the wall clock once per minute so time-driven cards stay current
     * without re-rendering the whole wall on every frame.
     * @returns the current instant.
     */
    function useClock(intervalMs) {
      var state = React.useState(function () { return new Date() })
      var now = state[0]
      var setNow = state[1]
      React.useEffect(function () {
        var timer = setInterval(function () { setNow(new Date()) }, intervalMs || 60000)
        return function () { clearInterval(timer) }
      }, [intervalMs])
      return now
    }

    /**
     * Raise a notification once per distinct key, so a polling card does not
     * stack the same message on every refresh.
     * @param api - card api.
     * @param key - identity of the message.
     * @param level - severity.
     * @param text - message.
     */
    function useNoticeOnce(api, key, level, text) {
      var last = React.useRef(null)
      React.useEffect(function () {
        if (key === null || key === undefined || key === '') return
        if (last.current === key) return
        last.current = key
        api.notify(level, text)
      }, [key, level, text])
    }

    /**
     * One live notice per card, driven by state instead of by events.
     *
     * The bubble belongs to the user, not to the log: a card raises a notice
     * while something is genuinely worth their attention and retracts it when
     * that stops being true. `notice` is `{level, text}` or null, and `key`
     * identifies the condition so an unchanged one does not re-raise.
     * @param api - card api.
     * @param key - identity of the condition.
     * @param notice - `{level, text}`, or null for "nothing to say".
     */
    function useAnnounce(api, key, notice) {
      var last = React.useRef(null)
      var level = notice ? notice.level : null
      var text = notice ? notice.text : null
      React.useEffect(function () {
        if (!notice) {
          if (last.current === null) return
          last.current = null
          api.retract()
          return
        }
        var id = key + '|' + level + '|' + text
        if (last.current === id) return
        last.current = id
        api.announce(level, text)
      }, [key, level, text])
    }

    hooks.useStore = useStore
    hooks.useRemote = useRemote
    hooks.useClock = useClock
    hooks.useNoticeOnce = useNoticeOnce
    hooks.useAnnounce = useAnnounce

    // ------------------------------------------------------------- icons

    var Svg = function (props) {
      return h('svg', {
        viewBox: '0 0 24 24', width: props.size || 16, height: props.size || 16,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        className: props.className || undefined,
        style: props.style || undefined,
      }, props.children)
    }

    var ICONS = {
      orbit: function (size) { return h(Svg, { size: size }, h('ellipse', { cx: 12, cy: 12, rx: 10, ry: 4.5, transform: 'rotate(-35 12 12)' }), h('ellipse', { cx: 12, cy: 12, rx: 10, ry: 4.5, transform: 'rotate(35 12 12)' }), h('circle', { cx: 12, cy: 12, r: 2 })) },
      bloom: function (size) { return h(Svg, { size: size }, [0, 60, 120].map(function (angle) { return h('ellipse', { key: angle, cx: 12, cy: 12, rx: 4, ry: 10, transform: 'rotate(' + angle + ' 12 12)' }) })) },
      waves: function (size) { return h(Svg, { size: size }, [5, 10, 15, 20].map(function (y) { return h('path', { key: y, d: 'M1 ' + y + ' Q6 ' + (y - 5) + ' 12 ' + y + ' T23 ' + y }) })) },
      home: function (size) { return h(Svg, { size: size }, h('path', { d: 'M3 10.5 12 3l9 7.5' }), h('path', { d: 'M5 9.5V21h14V9.5' }), h('path', { d: 'M10 21v-6h4v6' })) },
      grid: function (size) { return h(Svg, { size: size }, h('rect', { x: 3, y: 3, width: 7, height: 7, rx: 2 }), h('rect', { x: 14, y: 3, width: 7, height: 7, rx: 2 }), h('rect', { x: 3, y: 14, width: 7, height: 7, rx: 2 }), h('rect', { x: 14, y: 14, width: 7, height: 7, rx: 2 })) },
      token: function (size) { return h(Svg, { size: size }, h('circle', { cx: 12, cy: 12, r: 8.5 }), h('path', { d: 'M9 9.5h6M9 12h6M9 14.5h4' })) },
      calendar: function (size) { return h(Svg, { size: size }, h('rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2.5 }), h('path', { d: 'M3.5 10h17M8 3.5V6.5M16 3.5V6.5' })) },
      network: function (size) { return h(Svg, { size: size }, h('circle', { cx: 12, cy: 12, r: 8.5 }), h('path', { d: 'M3.5 12h17' }), h('path', { d: 'M12 3.5c2.5 2.6 2.5 14.4 0 17-2.5-2.6-2.5-14.4 0-17Z' })) },
      device: function (size) { return h(Svg, { size: size }, h('rect', { x: 7, y: 7, width: 10, height: 10, rx: 2 }), h('path', { d: 'M10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5' })) },
      terminal: function (size) { return h(Svg, { size: size }, h('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.5 }), h('path', { d: 'M7 10l3.2 2.2L7 14.4' }), h('path', { d: 'M12.6 14.6h4.4' })) },
      cube: function (size) { return h(Svg, { size: size }, h('path', { d: 'M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6L12 3.2Z' }), h('path', { d: 'M4 7.6 12 12l8-4.4' }), h('path', { d: 'M12 12v8.8' })) },
      download: function (size) { return h(Svg, { size: size }, h('path', { d: 'M12 4v11' }), h('path', { d: 'M7.5 10.5 12 15l4.5-4.5' }), h('path', { d: 'M4.5 19.5h15' })) },
      back: function (size) { return h(Svg, { size: size }, h('path', { d: 'M14.5 5.5 8 12l6.5 6.5' })) },
      refresh: function (size) { return h(Svg, { size: size }, h('path', { d: 'M20 12a8 8 0 1 1-2.6-5.9' }), h('path', { d: 'M20.5 4v4.5H16' })) },
      drag: function (size) { return h(Svg, { size: size }, h('circle', { cx: 9, cy: 6, r: 1.4, fill: 'currentColor', stroke: 'none' }), h('circle', { cx: 15, cy: 6, r: 1.4, fill: 'currentColor', stroke: 'none' }), h('circle', { cx: 9, cy: 12, r: 1.4, fill: 'currentColor', stroke: 'none' }), h('circle', { cx: 15, cy: 12, r: 1.4, fill: 'currentColor', stroke: 'none' }), h('circle', { cx: 9, cy: 18, r: 1.4, fill: 'currentColor', stroke: 'none' }), h('circle', { cx: 15, cy: 18, r: 1.4, fill: 'currentColor', stroke: 'none' })) },
      expand: function (size) { return h(Svg, { size: size }, h('path', { d: 'M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5' })) },
      chevron: function (size) { return h(Svg, { size: size }, h('path', { d: 'M5 8.5l7 7 7-7' })) },
      caret: function (size) { return h(Svg, { size: size }, h('path', { d: 'M9.2 5.4 16.4 12l-7.2 6.6V5.4Z', fill: 'currentColor', stroke: 'none' })) },
      // The two menu glyphs the shipped workspace row draws, so the menu this
      // plugin puts in its place reads as the same menu.
      edit: function (size) { return h(Svg, { size: size }, h('path', { d: 'M4.6 19.4h3.2L19.4 7.8a2 2 0 0 0-2.8-2.8L5 16.6l-.4 2.8Z' }), h('path', { d: 'M14.8 6.2 17.8 9.2' })) },
      trash: function (size) { return h(Svg, { size: size }, h('path', { d: 'M4.5 7h15' }), h('path', { d: 'M9.5 7V4.8h5V7' }), h('path', { d: 'M6.6 7l.9 12.4h9L17.4 7' }), h('path', { d: 'M10.2 10.6v5.6M13.8 10.6v5.6' })) },
      layers: function (size) { return h(Svg, { size: size }, h('path', { d: 'M12 3.8 20 8l-8 4.2L4 8l8-4.2Z' }), h('path', { d: 'M4 12.4l8 4.2 8-4.2' }), h('path', { d: 'M4 16.6l8 4.2 8-4.2' })) },
      check: function (size) { return h(Svg, { size: size }, h('path', { d: 'M4.5 12.5l5 5 10-11' })) },
      close: function (size) { return h(Svg, { size: size }, h('path', { d: 'M6 6l12 12M18 6 6 18' })) },
      copy: function (size) { return h(Svg, { size: size }, h('rect', { x: 9, y: 9, width: 11, height: 11, rx: 2.5 }), h('path', { d: 'M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5' })) },
      warn: function (size) { return h(Svg, { size: size }, h('path', { d: 'M12 4.5 2.5 20h19L12 4.5Z' }), h('path', { d: 'M12 10v4.5M12 17.5v.01' })) },
      info: function (size) { return h(Svg, { size: size }, h('circle', { cx: 12, cy: 12, r: 8.5 }), h('path', { d: 'M12 11v6M12 7.5v.01' })) },
      error: function (size) { return h(Svg, { size: size }, h('circle', { cx: 12, cy: 12, r: 8.5 }), h('path', { d: 'M9 9l6 6M15 9l-6 6' })) },
      setting: function (size) { return h(Svg, { size: size }, h('circle', { cx: 12, cy: 12, r: 3 }), h('path', { d: 'M12 3.5v2M12 18.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M3.5 12h2M18.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' })) },
      // The row and header glyphs the sidebar region draws: the shipped
      // browser's own folder, search, add, overflow, session and archive marks,
      // on the same 24 grid as the rest of this set.
      search: function (size) { return h(Svg, { size: size }, h('circle', { cx: 11, cy: 11, r: 6.6 }), h('path', { d: 'M15.9 15.9 20.6 20.6' })) },
      folder: function (size) { return h(Svg, { size: size }, h('path', { d: 'M3.6 7.4a2 2 0 0 1 2-2h3.5l2 2.6h7.3a2 2 0 0 1 2 2v8.6a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2V7.4Z' })) },
      folderOpen: function (size) { return h(Svg, { size: size }, h('path', { d: 'M3.6 7.4a2 2 0 0 1 2-2h3.5l2 2.6h5.6a2 2 0 0 1 2 2v1.4' }), h('path', { d: 'M3.6 11.4h17.2l-1.7 8.2H5.3l-1.7-8.2Z' })) },
      plus: function (size) { return h(Svg, { size: size }, h('path', { d: 'M12 5.2v13.6M5.2 12h13.6' })) },
      dots: function (size) { return h(Svg, { size: size }, h('circle', { cx: 5.6, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }), h('circle', { cx: 12, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }), h('circle', { cx: 18.4, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' })) },
      chat: function (size) { return h(Svg, { size: size }, h('path', { d: 'M4.2 6.4a2.2 2.2 0 0 1 2.2-2.2h11.2a2.2 2.2 0 0 1 2.2 2.2v8.2a2.2 2.2 0 0 1-2.2 2.2H9.4L5.4 20v-3.2H4.2V6.4Z' }), h('path', { d: 'M12 8.4v4.4M9.8 10.6h4.4' })) },
      pin: function (size) { return h(Svg, { size: size }, h('path', { d: 'M9.2 4.2h5.6' }), h('path', { d: 'M10.4 4.2v5.1L8.6 11.7v1.6h6.8v-1.6l-1.8-2.4V4.2' }), h('path', { d: 'M12 13.3v6.5' })) },
      archive: function (size) { return h(Svg, { size: size }, h('path', { d: 'M3.6 7.4h16.8v3.2H3.6z' }), h('path', { d: 'M5.2 10.6v8a1.6 1.6 0 0 0 1.6 1.6h10.4a1.6 1.6 0 0 0 1.6-1.6v-8' }), h('path', { d: 'M9.6 14.2h4.8' })) },
      branch: function (size) { return h(Svg, { size: size }, h('circle', { cx: 6.4, cy: 6, r: 2.2 }), h('circle', { cx: 6.4, cy: 18, r: 2.2 }), h('circle', { cx: 17.6, cy: 12, r: 2.2 }), h('path', { d: 'M6.4 8.2v7.6M8.6 6h4.4a2.4 2.4 0 0 1 2.4 2.4v1.4' })) },
    }

    // ------------------------------------------------------- custom background

    /** Background builders a registrant passes to `background`. */
    var bg = {
      /** Soft two-colour mesh behind a card. */
      mesh: function (color, strength) {
        return {
          type: 'mesh',
          color: color || '#2b5cff',
          strength: typeof strength === 'number' ? strength : 0.16,
        }
      },
      /** Linear gradient between two colours. */
      gradient: function (from, to, angle) {
        return { type: 'gradient', from: from, to: to, angle: typeof angle === 'number' ? angle : 135 }
      },
      /** Faint dotted grid. */
      grid: function (color, size) {
        return { type: 'grid', color: color || 'currentColor', size: size || 18 }
      },
      /** Custom CSS background value, used verbatim. */
      css: function (value) { return { type: 'css', value: value } },
    }

    /** @returns the inline style and layer element for one card background. */
    function backgroundProps(background) {
      if (!background) return { style: null, layer: null }
      if (typeof background === 'string') return { style: { background: background }, layer: null }
      if (background.type === 'css') return { style: { background: background.value }, layer: null }
      if (background.type === 'gradient') {
        return { style: { background: 'linear-gradient(' + background.angle + 'deg, ' + background.from + ', ' + background.to + ')' }, layer: null }
      }
      if (background.type === 'mesh') {
        return {
          style: null,
          layer: h('span', {
            className: 'ph-bg-layer',
            style: {
              background: 'radial-gradient(120% 90% at 12% 0%, ' + withAlpha(background.color, background.strength) + ' 0%, transparent 62%),' +
                'radial-gradient(90% 80% at 100% 100%, ' + withAlpha(background.color, background.strength * 0.7) + ' 0%, transparent 58%)',
            },
          }),
        }
      }
      if (background.type === 'grid') {
        return {
          style: null,
          layer: h('span', {
            className: 'ph-bg-layer',
            style: {
              backgroundImage: 'radial-gradient(' + background.color + ' 0.5px, transparent 0.5px)',
              backgroundSize: background.size + 'px ' + background.size + 'px',
              opacity: 0.12,
            },
          }),
        }
      }
      return { style: null, layer: null }
    }

    // ---------------------------------------------------------- card texture

    /** @returns a 0..1 opacity; 5 and 0.05 both mean five percent. */
    function textureOpacity(value) {
      var num = typeof value === 'number' ? value : parseFloat(value)
      if (!Number.isFinite(num)) return 0.05
      if (num > 1) num = num / 100
      return Math.min(1, Math.max(0, num))
    }

    /** @returns a CSS length from a number (px) or a length string, else the fallback. */
    function cssLength(value, fallback) {
      if (typeof value === 'number' && Number.isFinite(value)) return value + 'px'
      if (typeof value === 'string' && value.trim()) return value.trim()
      return fallback
    }

    /**
     * Mix-blend modes an artwork can use. `normal` is the default and is the
     * first entry on purpose: the index doubles as "not normal" in
     * `textureLayer`, where anything at index 0 is left off the style.
     */
    var TEXTURE_BLENDS = ['normal', 'multiply', 'screen', 'luminosity', 'soft-light']

    /** @returns a rotation in degrees, unit included, from a number or a "12deg" string. */
    function textureAngle(value) {
      if (typeof value === 'string' && value.trim()) {
        var trimmed = value.trim()
        return /deg$/.test(trimmed) ? trimmed : (parseFloat(trimmed) || 0) + 'deg'
      }
      var num = typeof value === 'number' ? value : parseFloat(value)
      return (Number.isFinite(num) ? num : 0) + 'deg'
    }

    /**
     * The texture layer: a mark a card prints on its own surface.
     *
     * Not a background. A background is the surface; this is an icon or an image
     * laid over that surface at 5% by default, large, anchored right and
     * deliberately running off the edge — so the card carries an identifying
     * *fragment* of the mark instead of a centred stamp. It lands at `z-index:1`
     * with the glass and the sheen: above the bed, below the type at `z-index:2`.
     *
     * Two properties are load-bearing and neither is obvious. It must be painted
     * *after* `.ph-glass`, because that layer's `backdrop-filter` blurs whatever
     * is painted below it — a mark underneath comes back as a smear, and a smear
     * is not an identifying fragment. And it must never take pointer events, or
     * the card stops expanding wherever the mark happens to be.
     *
     * @param texture - `true` for the card's own icon, an icon name, or
     *   `{ icon | image, opacity, size, anchor, bleed, offset, rotate, fit, tint,
     *   fade, fadePosition, blend }`.
     * @param card - the card, for the fallback icon and the accent tint.
     * @returns the layer element, or null when the card asked for no texture.
     */
    function cardTexture(card) {
      var appearance = store.state.appearance || {}
      return Object.prototype.hasOwnProperty.call(appearance, card.id) ? appearance[card.id] : card.texture
    }

    function cardVisible(card) { return (store.state.hidden || []).indexOf(card.id) < 0 }

    function setCardVisible(card, visible) {
      var hidden = (store.state.hidden || []).filter(function (id) { return id !== card.id })
      if (!visible) hidden.push(card.id)
      if (!visible && store.expanded === card.id) collapseCard()
      patchState({ hidden: hidden })
    }

    function textureLayer(texture, card) {
      if (!texture) return null
      var spec = texture === true ? {} : texture
      if (typeof spec === 'string') spec = { icon: spec }
      var image = typeof spec.image === 'string' ? spec.image.trim() : ''
      // The value is about to sit inside a CSS string, so a backslash and a quote
      // are escaped rather than dropped: an inline SVG data URI is full of quotes
      // and is the ordinary way to ship one. A raw newline cannot be escaped into
      // a CSS string at all, so a value carrying one is refused outright. Nothing
      // else can end the declaration from inside the quotes.
      if (/[\n\r]/.test(image)) image = ''
      else if (image) image = image.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      var mark = image
        ? h('span', {
          className: 'ph-tex-mark',
          style: {
            backgroundImage: 'url("' + image + '")',
            backgroundSize: spec.fit === 'cover' ? 'cover' : 'contain',
          },
        })
        : h('span', { className: 'ph-tex-mark' },
          typeof spec.icon === 'string' && ICONS[spec.icon] ? ICONS[spec.icon](24) : iconOf(card, 24))

      var style = {
        '--ph-tex-opacity': String(textureOpacity(spec.opacity)),
        '--ph-tex-size': cssLength(spec.size, '128%'),
        '--ph-tex-bleed': cssLength(spec.bleed, '-14%'),
        '--ph-tex-x': cssLength(spec.offset && spec.offset[0], '0px'),
        '--ph-tex-y': cssLength(spec.offset && spec.offset[1], '0px'),
        '--ph-tex-rotate': textureAngle(spec.rotate),
      }
      // A fade is optional and off unless the card says otherwise; the CSS mask
      // is what turns the two percentages into a gradient, so a texture that
      // never asked for one keeps exactly the styles it had before.
      // `fadePosition` is the share of the far side that dissolves: 0 leaves a
      // hard edge, 100 carries the fade across the whole mark, and the rest is
      // the CSS stop `100% - fadePosition`.
      var fade = spec.fade === true
      if (fade) {
        var fadePosition = Number.isFinite(spec.fadePosition) ? spec.fadePosition : 55
        fadePosition = Math.min(100, Math.max(0, fadePosition))
        style['--ph-tex-fade'] = fadePosition + '%'
        // The centre anchor fades toward both sides, so it needs the half band
        // rather than the whole one; resolving it here keeps the CSS a plain
        // stop list instead of a calc() with a nested var().
        style['--ph-tex-fade-half'] = fadePosition / 2 + '%'
      }
      var blend = TEXTURE_BLENDS.indexOf(spec.blend) > 0 ? spec.blend : ''
      if (blend) style.mixBlendMode = blend
      if (typeof spec.tint === 'string' && spec.tint) style['--ph-tex-tint'] = spec.tint
      else {
        // The card's own accent, so the watermark carries the card's colour and
        // not a generic grey. `textOf` because an accent may be a function.
        var accent = textOf(card.accent)
        if (accent) style['--ph-tex-tint'] = accent
      }
      var anchor = spec.anchor === 'left' || spec.anchor === 'center' ? spec.anchor : 'right'
      return h('span', {
        className: 'ph-tex ph-tex--' + anchor + (fade ? ' ph-tex--fade' : '') + (blend ? ' ph-tex--blend' : ''),
        'aria-hidden': 'true',
        style: style,
      }, mark)
    }

    /**
     * The default liquid bed: the colour pools the glass layer above refracts.
     *
     * Liquid glass only reads as glass when there is something behind it to
     * blur. A card that registered its own `background` brings its own bed, so
     * this one is only used when it did not. The card's `accent` (falling back
     * to the brand token) tints the pools, which is what makes each card's glass
     * a different colour instead of three identical grey panes.
     * @returns the bed element.
     */
    function liquidBed(card) {
      var accent = textOf(card.accent)
      return h('span', {
        className: 'ph-bg-layer ph-bed',
        style: accent ? { '--ph-bed': accent } : null,
      })
    }

    /** @returns a colour with an alpha channel, accepting hex or an rgb()/var() value. */
    function withAlpha(color, alpha) {
      var value = String(color || '').trim()
      var hex = /^#([0-9a-f]{6})$/i.exec(value)
      if (hex) {
        var int = parseInt(hex[1], 16)
        return 'rgba(' + ((int >> 16) & 255) + ',' + ((int >> 8) & 255) + ',' + (int & 255) + ',' + alpha + ')'
      }
      var shortHex = /^#([0-9a-f]{3})$/i.exec(value)
      if (shortHex) {
        var expanded = shortHex[1].split('').map(function (c) { return c + c }).join('')
        return withAlpha('#' + expanded, alpha)
      }
      return 'color-mix(in srgb, ' + value + ' ' + (alpha * 100) + '%, transparent)'
    }

    // ---------------------------------------------------------- UI controls

    /**
     * Reusable controls a card can drop into its own content. These are the
     * same components the registered `actions` render through, so a card that
     * builds its own layout still looks native.
     */
    var UI = {
      Chip: function (props) {
        return h('span', {
          className: 'ph-chip' + (props.tone ? ' ph-chip--' + props.tone : ''),
          title: textOf(props.title) || undefined,
        }, textOf(props.children))
      },
      /** Static label + value pair. */
      Stat: function (props) {
        return h('div', { className: 'ph-stat' },
          h('span', { className: 'ph-stat-label' }, textOf(props.label)),
          h('span', { className: 'ph-stat-value', style: props.style || null }, textOf(props.value)),
          props.hint ? h('span', { className: 'ph-stat-hint' }, textOf(props.hint)) : null,
        )
      },
      Button: function (props) {
        return h('button', {
          type: 'button',
          className: 'ph-btn' + (props.tone ? ' ph-btn--' + props.tone : ''),
          onClick: props.onClick,
          disabled: props.disabled === true,
          title: textOf(props.title) || undefined,
        }, props.icon ? h('span', { className: 'ph-btn-icon' }, props.icon) : null, textOf(props.children))
      },
      /** A row of mutually exclusive options. */
      Segmented: function (props) {
        var options = Array.isArray(props.options) ? props.options : []
        return h('div', { className: 'ph-segmented', role: 'radiogroup', 'aria-label': textOf(props.label) || '' },
          options.map(function (option) {
            var active = option.value === props.value
            return h('button', {
              key: String(option.value),
              type: 'button',
              role: 'radio',
              'aria-checked': active,
              className: 'ph-segment' + (active ? ' is-active' : ''),
              title: textOf(option.title) || undefined,
              onClick: function () { if (props.onChange) props.onChange(option.value) },
            }, textOf(option.label))
          }),
        )
      },
      /** A on/off switch. */
      Switch: function (props) {
        return h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': props.value === true,
          className: 'ph-switch' + (props.value === true ? ' is-on' : ''),
          onClick: function () { if (props.onChange) props.onChange(props.value !== true) },
          title: textOf(props.title) || undefined,
          disabled: props.disabled === true,
        }, h('span', { className: 'ph-switch-track' }, h('span', { className: 'ph-switch-knob' })), props.label ? h('span', { className: 'ph-switch-label' }, textOf(props.label)) : null)
      },
      /**
       * A primary action paired with a dropdown of alternatives: the left half
       * runs the current choice, the right half opens the menu.
       */
      ComboButton: function (props) {
        var idRef = React.useRef(null)
        if (!idRef.current) idRef.current = nextPopoverId('combo')
        var anchorRef = React.useRef(null)
        var spec = usePopover()
        var open = !!(spec && spec.id === idRef.current)
        var options = Array.isArray(props.options) ? props.options : []
        var current = null
        for (var index = 0; index < options.length; index++) {
          if (options[index].value === props.value) current = options[index]
        }
        if (!current && options.length > 0) current = options[0]
        var chosen = props.value === undefined ? (current ? current.value : null) : props.value
        // A menu must not outlive the card that opened it.
        React.useEffect(function () {
          var mine = idRef.current
          return function () { closePopover(mine) }
        }, [])
        var choose = function (value) {
          closePopover(idRef.current)
          if (props.onChange) props.onChange(value)
          if (props.onRun) props.onRun(value)
        }
        var toggle = function () {
          if (open) { closePopover(idRef.current); return }
          var box = anchorBox(anchorRef.current)
          togglePopover({
            id: idRef.current,
            render: function () {
              return h('div', {
                className: 'ph-combo-menu',
                role: 'menu',
                style: popoverPlacement(box, { align: 'end', minWidth: 148, estimate: 168 }),
              }, options.map(function (option) {
                return h('button', {
                  key: String(option.value),
                  type: 'button',
                  role: 'menuitemradio',
                  'aria-checked': option.value === chosen,
                  className: 'ph-combo-item' + (option.value === chosen ? ' is-active' : ''),
                  title: textOf(option.title) || undefined,
                  onClick: function () { choose(option.value) },
                }, textOf(option.label))
              }))
            },
          })
        }
        return h('div', {
          className: 'ph-combo' + (open ? ' is-open' : ''),
          ref: anchorRef,
          'data-popover-anchor': idRef.current,
        },
          h('button', {
            type: 'button',
            className: 'ph-combo-main',
            title: props.title || undefined,
            disabled: props.disabled === true,
            onClick: function () { if (props.onRun) props.onRun(chosen) },
          }, props.icon ? h('span', { className: 'ph-btn-icon' }, props.icon) : null, (props.prefix || '') + textOf(current ? current.label : props.label)),
          h('button', {
            type: 'button',
            className: 'ph-combo-caret',
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            'aria-label': textOf(props.label) || undefined,
            disabled: props.disabled === true,
            onClick: toggle,
          }, ICONS.chevron(11)),
        )
      },
      /** A +/- stepper for small integers. */
      Stepper: function (props) {
        var value = Number(props.value) || 0
        var min = props.min === undefined ? 0 : props.min
        var max = props.max === undefined ? 99 : props.max
        return h('div', { className: 'ph-stepper' },
          h('button', { type: 'button', className: 'ph-stepper-btn', disabled: value <= min, onClick: function () { if (props.onChange) props.onChange(Math.max(min, value - 1)) } }, '−'),
          h('span', { className: 'ph-stepper-value' }, props.format ? props.format(value) : value),
          h('button', { type: 'button', className: 'ph-stepper-btn', disabled: value >= max, onClick: function () { if (props.onChange) props.onChange(Math.min(max, value + 1)) } }, '+'),
        )
      },
      /**
       * A single-line text field.
       *
       * The draft lives in local state and only reaches the caller on Enter or
       * blur: a control value is persisted on the host, and a half-typed path
       * is not a setting yet. While the field holds focus the stored value is
       * ignored, so a round-trip that lands mid-edit cannot move the caret.
       */
      Text: function (props) {
        var ref = React.useRef({
          focused: false,
          draft: props.value === null || props.value === undefined ? '' : String(props.value),
        })
        var force = React.useState(0)
        var rerender = force[1]
        var state = ref.current
        var stored = props.value === null || props.value === undefined ? '' : String(props.value)
        if (!state.focused) state.draft = stored
        var repaint = function () { rerender(function (n) { return n + 1 }) }
        var commit = function () {
          state.focused = false
          if (state.draft !== stored && typeof props.onChange === 'function') props.onChange(state.draft)
          repaint()
        }
        return h('input', {
          type: 'text',
          className: 'ph-input' + (props.mono ? ' ph-mono' : ''),
          value: state.draft,
          placeholder: textOf(props.placeholder) || undefined,
          title: textOf(props.title) || undefined,
          spellCheck: false,
          autoComplete: 'off',
          disabled: props.disabled === true,
          'aria-label': textOf(props.label) || undefined,
          onFocus: function () { state.focused = true; repaint() },
          onChange: function (event) { state.draft = event.target.value; repaint() },
          onBlur: commit,
          onKeyDown: function (event) {
            if (event.key === 'Enter') commit()
            else if (event.key === 'Escape') { state.draft = stored; state.focused = false; repaint() }
          },
        })
      },
      /** A labelled field row, for cards that gather their own settings. */
      Field: function (props) {
        return h('label', { className: 'ph-field' },
          h('span', { className: 'ph-field-label' }, textOf(props.label)),
          h('span', { className: 'ph-field-body' }, props.children),
        )
      },
      /**
       * Vertical bars with a hover title, for short time series.
       * `props.max` pins the scale instead of normalising to the window, which
       * is what a reading with a natural ceiling (a percentage) needs.
       */
      Bars: function (props) {
        var values = Array.isArray(props.values) ? props.values : []
        var max = 0
        values.forEach(function (entry) { max = Math.max(max, Number(entry.value) || 0) })
        if (typeof props.max === 'number' && props.max > 0) max = props.max
        if (max <= 0) max = 1
        return h('div', { className: 'ph-bars', style: { height: (props.height || 84) + 'px' } },
          values.map(function (entry, index) {
            var ratio = (Number(entry.value) || 0) / max
            return h('div', {
              key: index,
              className: 'ph-bar' + (entry.highlight ? ' is-highlight' : ''),
              title: entry.title || '',
              style: { height: Math.max(2, Math.round(ratio * 100)) + '%' },
            }, h('span', { className: 'ph-bar-fill' }))
          }),
        )
      },
      Divider: function () { return h('div', { className: 'ph-divider' }) },
      Row: function (props) {
        return h('div', { className: 'ph-row' + (props.wrap ? ' is-wrap' : '') }, props.children)
      },
      Empty: function (props) {
        return h('div', { className: 'ph-inline-empty' }, textOf(props.children))
      },
    }

    // -------------------------------------------------- registered controls

    /** Render one registered `action` through the matching control. */
    /**
     * Render one registered action.
     *
     * Every row shows its label exactly once. Which half draws it depends on the
     * control: a switch and a segmented control carry a label next to the widget,
     * while a button or a combo *is* its caption. The wrapper used to draw a
     * label for every type as well, which printed switch labels twice.
     */
    function renderAction(card, action, options) {
      var settings = options || {}
      var value = controlValue(card, action)
      var onChange = function (next) { setControlValue(card, action, next) }
      var showLabel = settings.showLabel !== false
      var label = action.label === undefined ? null : textOf(action.label)
      var title = textOf(action.tooltip)
      var control
      if (action.type === 'switch') {
        control = h(UI.Switch, { value: value === true, onChange: onChange, label: showLabel ? label : null, title: title })
      } else if (action.type === 'segmented') {
        control = h(UI.Segmented, { options: action.options || [], value: value, onChange: onChange, label: label })
      } else if (action.type === 'combo') {
        control = h(UI.ComboButton, {
          options: action.options || [], value: value, icon: action.icon, prefix: options && options.prefix,
          title: title,
          onChange: onChange,
          onRun: action.run ? function (current) { action.run(current, cardApi(card)) } : null,
        })
      } else if (action.type === 'stepper') {
        control = h(UI.Stepper, { value: value, min: action.min, max: action.max, onChange: onChange, format: action.format })
      } else if (action.type === 'text') {
        control = h(UI.Text, {
          value: value,
          label: showLabel ? label : null,
          placeholder: action.placeholder,
          title: title,
          mono: action.mono === true,
          onChange: onChange,
        })
      } else {
        control = h(UI.Button, {
          icon: action.icon,
          tone: action.tone,
          title: title,
          disabled: action.disabled === true,
          onClick: function () {
            if (action.run) {
              try { action.run(cardApi(card)) }
              catch (error) { notify(card.id, 'error', String(error && error.message ? error.message : error)) }
            } else if (typeof action.onChange === 'function') action.onChange(true, cardApi(card))
          },
        }, action.text !== undefined ? textOf(action.text) : (label || action.id))
      }
      var wrapperLabel = (action.type === 'segmented' || action.type === 'text') && showLabel && label
        ? h('span', { className: 'ph-action-label' }, label)
        : null
      return h('span', { className: 'ph-action', key: action.id }, wrapperLabel, control)
    }

    /** Render every action a card registers, in order. */
    function renderActions(card, list, options) {
      if (!Array.isArray(list) || list.length === 0) return null
      return h('div', { className: 'ph-actions' }, list.map(function (action) {
        if (action.hidden === true) return null
        return renderAction(card, action, options)
      }))
    }

    // -------------------------------------------------------- card boundary

    /** Keeps one misbehaving card from taking the whole wall down. */
    var CardBoundary = (function () {
      if (!React.Component) return function (props) { return props.children }
      function Boundary(props) {
        React.Component.call(this, props)
        this.state = { error: null }
      }
      Boundary.prototype = Object.create(React.Component.prototype)
      Boundary.prototype.constructor = Boundary
      Boundary.getDerivedStateFromError = function (error) { return { error: error } }
      Boundary.prototype.componentDidCatch = function (error) {
        console.error('homepage: card "' + (this.props.cardId || '?') + '" failed to render', error)
      }
      Boundary.prototype.render = function () {
        if (this.state.error) {
          return h('div', { className: 'ph-card-error' },
            h('strong', null, runtime.t('card.renderFailed')),
            h('code', null, String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)),
          )
        }
        return this.props.children
      }
      return Boundary
    })()

    /** Call a card renderer, catching a synchronous failure in the factory itself. */
    function safeRender(card, renderer, api) {
      try { return renderer(api) }
      catch (error) {
        return h('div', { className: 'ph-card-error' },
          h('strong', null, runtime.t('card.contentFailed')),
          h('code', null, String(error && error.message ? error.message : error)),
        )
      }
    }

    // ------------------------------------------------------------- bubbles

    /** The notification bubble in a card's top-right corner. */
    /**
     * The notification bubble in a card's top-right corner.
     *
     * It is a small glass pill tinted by the highest level it holds — green,
     * yellow or red — that stays quiet until the card has something to say. The
     * level colour rides on `--ph-notice`, so one variable drives the dot, the
     * halo, the fill and the text.
     */
    /** The panel behind the bubble: the notices a card is currently raising. */
    function NoticeBubble(props) {
      var list = Array.isArray(props.list) ? props.list : []
      var idRef = React.useRef(null)
      if (!idRef.current) idRef.current = nextPopoverId('notice')
      var anchorRef = React.useRef(null)
      var spec = usePopover()
      var open = !!(spec && spec.id === idRef.current)
      React.useEffect(function () {
        var mine = idRef.current
        return function () { closePopover(mine) }
      }, [])
      var top = noticeTop(list)
      if (!top) return null
      // The bubble is an annunciator, not a log: a card keeps one live notice,
      // so this list is short by construction. Anything beyond a handful is
      // summarised rather than scrolled.
      var shown = list.slice(-4).reverse()
      var hidden = list.length - shown.length
      var cardId = props.cardId
      var toggle = function () {
        if (open) { closePopover(idRef.current); return }
        var box = anchorBox(anchorRef.current)
        togglePopover({
          id: idRef.current,
          render: function () {
            return h('div', {
              className: 'ph-notice-panel',
              role: 'dialog',
              'aria-label': runtime.t('notice.title'),
              style: popoverPlacement(box, { align: 'end', minWidth: 252, estimate: 268 }),
            },
              h('div', { className: 'ph-notice-head' },
                h('span', { className: 'ph-notice-title' }, runtime.t('notice.title')),
                h('button', {
                  type: 'button', className: 'ph-notice-clear',
                  onClick: function () { clearNotifications(cardId); closePopover(idRef.current) },
                }, runtime.t('notice.clearAll')),
              ),
              shown.map(function (entry) {
                return h('div', { key: entry.id, className: 'ph-notice-row' },
                  h('span', { className: 'ph-notice-mark', style: { '--ph-notice': NOTICE_COLORS[entry.level] } }),
                  h('span', { className: 'ph-notice-text' }, entry.text),
                  h('button', {
                    type: 'button', className: 'ph-notice-x', 'aria-label': runtime.t('notice.dismiss'),
                    onClick: function () { dismissNotification(cardId, entry.id) },
                  }, ICONS.close(11)),
                )
              }),
              hidden > 0 ? h('div', { className: 'ph-notice-more' }, runtime.t('notice.more', { count: hidden })) : null,
            )
          },
        })
      }
      return h('button', {
        type: 'button',
        ref: anchorRef,
        'data-popover-anchor': idRef.current,
        className: 'ph-bubble ph-bubble--' + top.level + (open ? ' is-open' : ''),
        style: { '--ph-notice': NOTICE_COLORS[top.level] },
        title: top.latest.text,
        'aria-label': top.latest.text,
        'aria-expanded': open,
        onClick: toggle,
      },
        h('span', { className: 'ph-bubble-dot' }),
        top.count > 1 ? h('span', { className: 'ph-bubble-count' }, String(top.count)) : null,
      )
    }

    // ------------------------------------------------------------- toolbar

    /** Browsing stays quiet; arrangement tools only appear in arrangement mode. */
    function Toolbar(props) {
      var settings = store.state.settings || {}
      var edit = Boolean(settings.edit)
      var cards = orderedCards().filter(cardVisible)
      return h('div', { className: 'ph-toolbar', inert: store.expanded ? '' : undefined },
        h('div', { className: 'ph-toolbar-title' },
          h('span', { className: 'ph-toolbar-icon' }, ICONS.grid(15)),
          h('span', null, props.t('panel.title')),
          h('span', { className: 'ph-count' }, String(cards.length)),
        ),
        h('div', { className: 'ph-toolbar-tools' },
          h('button', {
            type: 'button', className: 'ph-customize-trigger' + (store.customizing ? ' is-active' : ''),
            'aria-expanded': store.customizing, 'aria-controls': 'ph-customization',
            onClick: function () {
              store.customizing = !store.customizing
              store.designing = null
              if (settings.edit) patchState({ settings: Object.assign({}, settings, { edit: false }) })
              else bump()
            },
          }, ICONS.setting(15), props.t('studio.title')),
          h('button', {
            type: 'button', className: 'ph-arrange-toggle' + (edit ? ' is-active' : ''),
            'aria-pressed': edit, title: props.t('layout.hint'),
            onClick: function () {
              store.customizing = false; store.designing = null
              patchState({ settings: Object.assign({}, settings, { edit: !edit }) })
            },
          }, edit ? ICONS.check(15) : ICONS.layers(15), props.t(edit ? 'layout.done' : 'layout.arrange')),
        ),
      )
    }

    /** Move in semantic order, including when dense packing changes visual rows. */
    function nudgeCard(card, direction) {
      var cards = orderedCards().filter(cardVisible)
      var index = cards.indexOf(card)
      var target = cards[index + direction]
      if (!target) return
      reorderCards(card.id, target.id)
      store.arrangementMessage = runtime.t('layout.moved', { title: textOf(card.title), position: index + direction + 1 })
      bump(); scheduleSave()
    }

    /** Reset dimensions only: a saved background is not a size preference. */
    function resetCardSizes() {
      var layout = {}
      Object.keys(store.state.layout || {}).forEach(function (id) {
        var value = Object.assign({}, store.state.layout[id])
        delete value.w; delete value.h
        if (Object.keys(value).length) layout[id] = value
      })
      patchState({ layout: layout })
    }

    function ArrangementBar(props) {
      return h('div', { className: 'ph-arrangement-bar' },
        h('span', { className: 'ph-arrangement-mark' }, ICONS.drag(16)),
        h('div', null, h('strong', null, props.t('layout.arrange')), h('p', null, props.t('layout.hint'))),
        h('span', { className: 'ph-head-spacer' }),
        h('button', { type: 'button', className: 'ph-studio-text-button', onClick: resetCardSizes }, props.t('panel.autoSize')),
        h('span', { className: 'ph-sr-only', role: 'status', 'aria-live': 'polite' }, store.arrangementMessage))
    }

    /** Shared visual controls, rather than unrelated dropdowns inside each card. */
    function CardDesign(props) {
      var card = props.card
      var t = props.t
      var api = cardApi(card)
      var span = cardSpan(card)
      var record = cardEffectRecord(card)
      var presets = [{ w: 1, h: 1, label: 'tile' }, { w: 2, h: 1, label: 'wide' }, { w: 2, h: 2, label: 'feature' }, { w: 3, h: 2, label: 'panorama' }, { w: 4, h: 2, label: 'full' }]
      var sizes = presets.filter(function (size) { return size.w >= card.minSize.w && size.w <= card.maxSize.w && size.h >= card.minSize.h && size.h <= card.maxSize.h })
      var effect = record.outline || 'none'
      return h('div', { className: 'ph-card-design', style: { '--ph-bed': textOf(card.accent) || undefined } },
        card.resizable !== false ? h('section', { className: 'ph-design-section' },
          h('div', { className: 'ph-design-heading' }, h('strong', null, t('design.size')), h('span', null, span.w + ' × ' + span.h)),
          h('div', { className: 'ph-size-presets', role: 'group', 'aria-label': t('design.size') }, sizes.map(function (size) {
            var active = span.w === size.w && span.h === size.h
            return h('button', { type: 'button', key: size.label, className: 'ph-size-preset' + (active ? ' is-active' : ''),
              'aria-pressed': active, title: t('design.size.' + size.label) + ' · ' + size.w + ' × ' + size.h,
              onClick: function () { api.setSize(size) } },
              h('span', { className: 'ph-size-schematic', 'aria-hidden': 'true' }, h('i', { style: { width: (size.w * 9 + 5) + 'px', height: (size.h * 9 + 5) + 'px' } })),
              h('span', null, t('design.size.' + size.label)))
          })),
          h('div', { className: 'ph-design-custom-size' },
            h('label', null, t('design.width'), h('input', { type: 'number', min: card.minSize.w, max: card.maxSize.w, step: 1, value: span.w,
              onChange: function (event) { if (event.target.value !== '') api.setSize({ w: Number(event.target.value) }) } })),
            h('span', { 'aria-hidden': 'true' }, '×'),
            h('label', null, t('design.height'), h('input', { type: 'number', min: card.minSize.h, max: card.maxSize.h, step: 1, value: span.h,
              onChange: function (event) { if (event.target.value !== '') api.setSize({ h: Number(event.target.value) }) } })))) : null,
        h('section', { className: 'ph-design-section' },
          h('div', { className: 'ph-design-heading' }, h('strong', null, t('design.motion')), h('span', null, textOf(EFFECTS[effect] && EFFECTS[effect].label))),
          h('div', { className: 'ph-motion-presets', role: 'group', 'aria-label': t('design.motion') }, Object.keys(EFFECTS).map(function (name) {
            var preset = EFFECTS[name]
            return h('button', { type: 'button', key: name, className: 'ph-motion-preset' + (effect === name ? ' is-active' : ''),
              'aria-pressed': effect === name, title: textOf(preset.description), 'data-effect': name,
              onClick: function () { patchSection('effects', card.id, Object.assign({}, record, { outline: name, float: false, sheen: false, spotlight: false, ripple: name !== 'none' && Boolean(card.effects.ripple) })) } },
              h('span', { className: 'ph-motion-sample ' + (preset.className || 'ph-fx-' + name), 'aria-hidden': 'true' }, h('i')),
              h('span', null, textOf(preset.label)))
          })),
          h('p', { className: 'ph-design-description' }, textOf(EFFECTS[effect] && EFFECTS[effect].description)),
          effect !== 'none' && effect !== 'spotlight' ? h('div', { className: 'ph-motion-trigger', role: 'group', 'aria-label': t('design.trigger') },
            ['always', 'hover'].map(function (trigger) {
              var active = (record.trigger || 'always') === trigger
              return h('button', { type: 'button', key: trigger, className: active ? 'is-active' : '', 'aria-pressed': active,
                onClick: function () { patchSection('effects', card.id, Object.assign({}, record, { trigger: trigger })) } }, t('design.trigger.' + trigger))
            })) : null))
    }

    function LayoutInspector(props) {
      var card = registryById[store.designing]
      if (!card || !cardVisible(card)) return null
      return h('section', { className: 'ph-layout-inspector', 'aria-label': props.t('design.title') },
        h('div', { className: 'ph-inspector-head' }, iconOf(card, 16), h('strong', null, textOf(card.title)),
          h('span', { className: 'ph-head-spacer' }),
          h('button', { type: 'button', className: 'ph-studio-icon-button', 'aria-label': props.t('design.close'), onClick: function () { store.designing = null; bump() } }, ICONS.close(16))),
        h(CardDesign, { card: card, t: props.t }))
    }

    /** A non-modal design workbench: registered cards stay alive when hidden. */
    function CustomizationStudio(props) {
      var t = props.t
      var selection = React.useState(function () { return registry.length ? orderedCards()[0].id : '' })
      var card = registryById[selection[0]] || orderedCards()[0]
      var errorState = React.useState('')
      var uploadVersion = React.useRef(0)
      React.useEffect(function () { return function () { uploadVersion.current += 1 } }, [])
      if (!card) return null
      var texture = cardTexture(card)
      var spec = texture && typeof texture === 'object' ? texture : (typeof texture === 'string' ? { icon: texture } : {})
      function writeTexture(value) {
        uploadVersion.current += 1
        var next = Object.assign({}, store.state.appearance || {})
        if (value === undefined) delete next[card.id]
        else next[card.id] = value
        patchState({ appearance: next })
      }
      function update(patch) { writeTexture(Object.assign({}, spec, patch)) }
      function range(key, value, min, max, step, suffix, change, disabled) {
        return h('label', { className: 'ph-studio-range' + (disabled ? ' is-disabled' : ''), key: key },
          h('span', null, t('studio.' + key), h('output', null, String(value) + suffix)),
          h('input', { type: 'range', min: min, max: max, step: step, value: value, disabled: disabled === true,
            'aria-label': t('studio.' + key), onChange: function (event) { change(Number(event.target.value)) } }))
      }
      function importImage(event) {
        var file = event.target.files && event.target.files[0]
        if (!file) return
        if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 512 * 1024) {
          errorState[1](t('studio.imageError')); event.target.value = ''; return
        }
        var version = ++uploadVersion.current
        var reader = new FileReader()
        reader.onload = function () {
          if (version !== uploadVersion.current) return
          writeTexture(Object.assign({}, spec, { image: reader.result })); errorState[1]('')
        }
        reader.onerror = function () { if (version === uploadVersion.current) errorState[1](t('studio.imageError')) }
        reader.readAsDataURL(file)
        event.target.value = ''
      }
      // Registered cards may use a pixel-sized mark; do not relabel it as a
      // percentage or change its unit when the user adjusts another property.
      var sizeUnit = typeof spec.size === 'number' || /px$/.test(String(spec.size || '')) ? 'px' : '%'
      var visible = orderedCards().filter(cardVisible).length
      var options = ['default', 'none', 'orbit', 'bloom', 'waves', 'grid', 'cube', 'network', 'layers', 'branch']
      var chosen = !Object.prototype.hasOwnProperty.call(store.state.appearance || {}, card.id) ? 'default'
        : texture === null ? 'none' : spec.image ? 'image' : spec.icon || 'default'
      var fadeOn = spec.fade === true
      var fadePosition = Number.isFinite(spec.fadePosition) ? Math.min(100, Math.max(0, spec.fadePosition)) : 55
      var blend = TEXTURE_BLENDS.indexOf(spec.blend) >= 0 ? spec.blend : 'normal'
      return h('section', { className: 'ph-studio', id: 'ph-customization', 'aria-label': t('studio.title') },
        h('header', { className: 'ph-studio-header' },
          h('div', null, h('span', { className: 'ph-studio-eyebrow' }, 'DESIGN STUDIO'),
            h('h3', null, t('studio.title')), h('p', null, t('studio.hint'))),
          h('button', { type: 'button', className: 'ph-studio-icon-button', 'aria-label': t('studio.close'),
            onClick: function () { store.customizing = false; bump() } }, ICONS.close(18))),
        h('div', { className: 'ph-studio-layout' },
          h('aside', { className: 'ph-studio-library', 'aria-label': t('studio.visibility') },
            h('div', { className: 'ph-studio-section-title' }, t('studio.visibility'), h('span', null, visible + ' / ' + registry.length)),
            h('p', { className: 'ph-studio-muted' }, t('studio.visibilityHint')),
            h('div', { className: 'ph-studio-card-list' }, orderedCards().map(function (entry) {
              var shown = cardVisible(entry)
              return h('div', { key: entry.id, className: 'ph-studio-card-row' + (entry.id === card.id ? ' is-selected' : '') + (!shown ? ' is-hidden' : '') },
                h('button', { type: 'button', className: 'ph-studio-card-select', 'aria-pressed': entry.id === card.id,
                  onClick: function () { uploadVersion.current += 1; selection[1](entry.id); errorState[1]('') } },
                  h('span', { className: 'ph-studio-card-icon', style: { color: textOf(entry.accent) || undefined } }, iconOf(entry, 17)),
                  h('span', null, textOf(entry.title))),
                h('button', { type: 'button', className: 'ph-studio-visibility', 'aria-label': t(shown ? 'studio.hide' : 'studio.add') + ' · ' + textOf(entry.title),
                  'aria-pressed': shown, title: t(shown ? 'studio.hide' : 'studio.add'),
                  onClick: function () { setCardVisible(entry, !shown) } }, shown ? ICONS.check(14) : ICONS.plus(14)))
            })),
            h('button', { type: 'button', className: 'ph-studio-text-button', onClick: function () { patchState({ hidden: [] }) } }, t('studio.showAll'))),
          h('div', { className: 'ph-studio-editor' },
            h('div', { className: 'ph-studio-preview', style: { '--ph-bed': textOf(card.accent) || '#7c83ff' } },
              liquidBed(card), h('span', { className: 'ph-glass' }), textureLayer(texture, card),
              h('div', { className: 'ph-studio-preview-content' },
                h('span', { className: 'ph-studio-eyebrow' }, t('studio.preview')),
                h('strong', null, textOf(card.title)),
                h('span', { className: 'ph-studio-muted' }, t(cardVisible(card) ? 'studio.onWall' : 'studio.offWall')))),
            h('div', { className: 'ph-studio-section-title' }, t('studio.pattern'),
              h('button', { type: 'button', className: 'ph-studio-text-button', onClick: function () { writeTexture(undefined); errorState[1]('') } }, t('studio.reset'))),
            h('div', { className: 'ph-studio-patterns', 'aria-label': t('studio.pattern') }, options.map(function (name) {
              return h('button', { type: 'button', key: name, className: 'ph-studio-pattern' + (chosen === name ? ' is-selected' : ''),
                'aria-pressed': chosen === name, title: t('studio.pattern.' + name),
                onClick: function () {
                  if (name === 'default') writeTexture(undefined)
                  else if (name === 'none') writeTexture(null)
                  else update({ icon: name, image: '' })
                } }, name === 'none' ? ICONS.close(22) : name === 'default' ? iconOf(card, 22) : ICONS[name](22),
                h('span', null, t('studio.pattern.' + name)))
            })),
            h('div', { className: 'ph-studio-import' },
              h('label', { className: 'ph-studio-upload' }, ICONS.plus(14), t('studio.upload'),
                h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', onChange: importImage })),
              h('span', { className: 'ph-studio-muted' }, t('studio.imageHint'))),
            errorState[0] ? h('p', { className: 'ph-studio-error', role: 'alert' }, errorState[0]) : null,
            h('fieldset', { className: 'ph-studio-placement', disabled: !texture },
              h('legend', null, t('studio.placement')),
              h('div', { className: 'ph-studio-anchors' }, ['left', 'center', 'right'].map(function (anchor) {
                return h('button', { type: 'button', key: anchor, 'aria-pressed': (spec.anchor || 'right') === anchor,
                  className: 'ph-studio-anchor' + ((spec.anchor || 'right') === anchor ? ' is-selected' : ''),
                  onClick: function () { update({ anchor: anchor, bleed: '0%' }) } }, t('studio.' + anchor))
              })),
              h('div', { className: 'ph-studio-ranges' },
                range('size', parseFloat(spec.size) || 128, 40, sizeUnit === 'px' ? 512 : 200, 1, sizeUnit, function (v) { update({ size: sizeUnit === 'px' ? v : v + '%' }) }),
                range('opacity', Math.round(textureOpacity(spec.opacity) * 100), 0, 30, 1, '%', function (v) { update({ opacity: v / 100 }) }),
                range('rotate', parseFloat(spec.rotate) || 0, -180, 180, 1, '°', function (v) { update({ rotate: v }) }),
                range('offsetX', parseFloat(spec.offset && spec.offset[0]) || 0, -160, 160, 1, 'px', function (v) { update({ offset: [v, spec.offset ? spec.offset[1] : 0] }) }),
                range('offsetY', parseFloat(spec.offset && spec.offset[1]) || 0, -160, 160, 1, 'px', function (v) { update({ offset: [spec.offset ? spec.offset[0] : 0, v] }) })),
              // The fade is opt-in, so the switch sits with its own position
              // instead of adding a sixth permanent slider. The position is
              // how far the dissolve reaches across the artwork: a larger value
              // starts the fade closer to the anchored edge.
              h('div', { className: 'ph-studio-fade' },
                h(UI.Switch, { value: fadeOn, label: t('studio.fade'), onChange: function (on) { update({ fade: on }) } }),
                h('span', { className: 'ph-studio-muted' }, t('studio.fadeHint'))),
              h('div', { className: 'ph-studio-fade-range' },
                range('fadePosition', fadePosition, 0, 100, 1, '%', function (v) { update({ fadePosition: v }) }, !fadeOn)),
              // Blend modes are the only way to drop an imported image's own
              // white (multiply) or black (screen) field without editing the
              // file, and luminosity keeps the shape while borrowing the hue.
              h('div', { className: 'ph-studio-blend' },
                h('span', { className: 'ph-studio-blend-label' }, t('studio.blend')),
                h('div', { className: 'ph-studio-blends', role: 'group', 'aria-label': t('studio.blend') },
                  TEXTURE_BLENDS.map(function (mode) {
                    return h('button', { type: 'button', key: mode, className: 'ph-studio-blend-option' + (blend === mode ? ' is-selected' : ''),
                      'aria-pressed': blend === mode, title: t('studio.blend.' + mode),
                      onClick: function () { update({ blend: mode }) } }, t('studio.blend.' + mode))
                  }))),
              h('p', { className: 'ph-studio-muted ph-studio-blend-hint' }, t('studio.blendHint'))),
            h('p', { className: 'ph-studio-muted ph-studio-save-note', role: 'status' }, t('studio.savedHint')))))
    }

    /** The wall a first-time user sees before any card is registered. */
    function EmptyState(props) {
      return h('div', { className: 'ph-empty' },
        h('div', { className: 'ph-empty-icon' }, ICONS.grid(28)),
        h('h3', null, props.t('panel.empty')),
        h('p', null, props.t('panel.emptyHint')),
        h('pre', { className: 'ph-empty-code' }, props.t('panel.example')),
      )
    }

    // ------------------------------------------------------------ the card

    /** One card cell: sizing, hover growth, drag handle, bubbles and content. */
    function CardCell(props) {
      var card = props.card
      var t = props.t
      var span = cardSpan(card)
      var hovered = store.hovered === card.id && !store.drag && !props.edit
      var dragging = Boolean(store.drag && store.drag.id === card.id)
      var notices = store.notifications[card.id]
      var record = cardEffectRecord(card)
      var api = cardApi(card)
      var background = backgroundProps(cardBackground(card))

      var hoverSpec = card.hover
      var grow = Number(hoverSpec.grow)
      var shellStyle = background.style ? Object.assign({}, background.style) : {}
      // `--ph-bed` is the card accent. It is set on the shell (not only on the
      // bed) so the spotlight can tint itself from the same value.
      if (card.accent) shellStyle['--ph-bed'] = card.accent
      if (hovered && !hoverSpec.disabled && !props.dimmed && Number.isFinite(grow) && grow !== 1) {
        // Scale only. The shell used to be absolutely positioned and grow by
        // negative `inset`, which no longer means anything now that the shell
        // is in flow — `inset` on a relative box moves it instead of resizing
        // it, so the card would jump out of its cell. A centred transform is
        // the same "grow without reflowing the grid" and it animates off the
        // existing transition.
        shellStyle.transform = 'scale(' + grow + ')'
      }

      var body
      if (hovered && !hoverSpec.disabled && hoverSpec.content) {
        body = safeRender(card, hoverSpec.content, api)
      } else {
        body = safeRender(card, card.content, api)
      }

      return h('div', {
        className: 'ph-cell ph-cell--' + props.density + (props.edit ? ' is-arranging' : '') + (store.designing === card.id && props.edit ? ' is-designing' : '') + (dragging ? ' is-dragging' : '') + (hovered ? ' is-hovered' : '') + (props.dimmed ? ' is-dimmed' : ''),
        'data-card-cell': card.id,
        style: { gridColumn: 'span ' + span.w, gridRow: 'span ' + span.h },
      },
        h('div', {
          className: 'ph-shell' + (cardEffectNames(card).length > 0 ? ' ' + cardEffectNames(card).join(' ') : ''),
          style: shellStyle,
          onPointerDown: function (event) {
            // The ripple grows from where the pointer landed, so the origin has
            // to be written before :active turns the animation on.
            if (!record.ripple) return
            var el = event.currentTarget
            if (!el || typeof el.getBoundingClientRect !== 'function') return
            if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
            var rect = el.getBoundingClientRect()
            el.style.setProperty('--ph-ripple-x', (event.clientX - rect.left) + 'px')
            el.style.setProperty('--ph-ripple-y', (event.clientY - rect.top) + 'px')
          },
          onPointerEnter: function (event) {
            if (event.pointerType !== 'mouse' || store.drag) return
            // The spotlight's origin is measured once per hover: measuring on
            // every pointermove would force a layout per frame.
            if (hasSpotlight(record) && event.currentTarget && typeof event.currentTarget.getBoundingClientRect === 'function') {
              event.currentTarget.__phRect = event.currentTarget.getBoundingClientRect()
            }
            store.hovered = card.id
            bump()
          },
          onPointerMove: function (event) {
            if (!hasSpotlight(record)) return
            var el = event.currentTarget
            if (!el || !el.style || typeof el.style.setProperty !== 'function') return
            if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
            var rect = el.__phRect
            if (!rect) {
              if (typeof el.getBoundingClientRect !== 'function') return
              rect = el.getBoundingClientRect()
              el.__phRect = rect
            }
            // Written straight to the element: a spotlight must not re-render.
            el.style.setProperty('--ph-mx', (event.clientX - rect.left) + 'px')
            el.style.setProperty('--ph-my', (event.clientY - rect.top) + 'px')
          },
          onPointerLeave: function (event) {
            if (event.currentTarget) event.currentTarget.__phRect = null
            if (event.pointerType !== 'mouse') return
            if (store.hovered !== card.id) return
            store.hovered = null
            bump()
          },
          onClick: function (event) {
            if (props.edit || store.drag) return
            // A click that landed on a registered control belongs to that
            // control; only a click on the card itself expands it.
            var target = event && event.target
            if (target && typeof target.closest === 'function' &&
              target.closest('button, a, input, select, textarea, .ph-foot, .ph-combo, .ph-bubble-wrap, .ph-size-controls')) return
            if (card.expandable !== false) expandCard(card.id)
          },
        },
          background.layer || liquidBed(card),
          h('span', { className: 'ph-glass', 'aria-hidden': 'true' }),
          record.sheen ? h('span', { className: 'ph-sheen', 'aria-hidden': 'true' }) : null,
          // After the glass on purpose: the glass's backdrop-filter blurs
          // everything painted below it, a texture included.
          textureLayer(cardTexture(card), card),
          h('div', {
            className: 'ph-head',
            onPointerDown: props.edit ? function (event) {
              if (event.target && event.target.closest && event.target.closest('button, input, a')) return
              beginDrag(event, card, 'header')
            } : null,
          },
            props.edit ? h('button', {
              type: 'button', className: 'ph-handle', title: t('panel.drag'),
              onPointerDown: function (event) { event.stopPropagation(); beginDrag(event, card, 'handle') },
              'aria-label': t('layout.dragCard', { title: textOf(card.title) }),
            }, ICONS.drag(14)) : null,
            h('span', { className: 'ph-card-icon' }, iconOf(card, 16)),
            h('span', { className: 'ph-card-title', title: textOf(card.title) }, textOf(card.title)),
            card.subtitle ? h('span', { className: 'ph-card-subtitle' }, textOf(card.subtitle)) : null,
            h('span', { className: 'ph-head-spacer' }),
            props.edit ? h('span', { className: 'ph-layout-rank' }, String(orderedCards().filter(cardVisible).indexOf(card) + 1).padStart(2, '0')) : null,
            h(NoticeBubble, { cardId: card.id, list: notices }),
            !props.edit && card.expandable !== false ? h('button', {
              type: 'button', className: 'ph-open-card', 'aria-label': t('layout.openCard', { title: textOf(card.title) }),
              onClick: function (event) { event.stopPropagation(); expandCard(card.id) },
            }, ICONS.expand(13)) : null,
          ),
          h('div', { className: 'ph-body' }, h(CardBoundary, { cardId: card.id }, body)),
          card.actions.length > 0 && !props.edit ? h('div', { className: 'ph-foot' }, renderActions(card, card.actions, { showLabel: true })) : null,
          props.edit ? h('div', { className: 'ph-layout-controls' },
            h('button', { type: 'button', className: 'ph-layout-design', 'aria-pressed': store.designing === card.id,
              onClick: function () { store.designing = store.designing === card.id ? null : card.id; bump() } }, ICONS.setting(13), t('design.title'), h('span', null, span.w + '×' + span.h)),
            h('span', { className: 'ph-head-spacer' }),
            h('button', { type: 'button', className: 'ph-layout-nudge', 'aria-label': t('layout.earlier', { title: textOf(card.title) }),
              disabled: orderedCards().filter(cardVisible).indexOf(card) === 0, onClick: function () { nudgeCard(card, -1) } }, '←'),
            h('button', { type: 'button', className: 'ph-layout-nudge', 'aria-label': t('layout.later', { title: textOf(card.title) }),
              disabled: orderedCards().filter(cardVisible).indexOf(card) === orderedCards().filter(cardVisible).length - 1, onClick: function () { nudgeCard(card, 1) } }, '→')) : null,
        ),
      )
    }

    /** @returns a card's icon as an element, resolving a string name through ICONS. */
    function iconOf(card, size) {
      var icon = card.icon
      if (icon === null || icon === undefined) return ICONS.grid(size)
      if (typeof icon === 'string') {
        return ICONS[icon] ? ICONS[icon](size) : h('span', { className: 'ph-glyph' }, icon)
      }
      if (typeof icon === 'function') return icon(size, card)
      return icon
    }

    // ----------------------------------------------------------- drag/drop

    /** A DOM-only drag image: no duplicate card hooks, requests or React renders. */
    function createDragPreview(card, x, y) {
      var cell = Array.prototype.find.call(document.querySelectorAll('[data-card-cell]'), function (node) { return node.getAttribute('data-card-cell') === card.id })
      if (!cell || typeof cell.cloneNode !== 'function') return { move: function () {}, finish: function () {} }
      var rect = cell.getBoundingClientRect()
      var preview = cell.cloneNode(true)
      preview.className = 'ph-drag-preview'
      preview.removeAttribute('data-card-cell')
      preview.setAttribute('aria-hidden', 'true')
      preview.setAttribute('inert', '')
      preview.querySelectorAll('[id]').forEach(function (node) { node.removeAttribute('id') })
      Object.assign(preview.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', gridColumn: '', gridRow: '' })
      var panel = cell.closest('.ph-panel') || document.body
      panel.appendChild(preview)
      var dx = 0; var dy = 0
      return {
        move: function (nextX, nextY) {
          dx = nextX - x; dy = nextY - y
          preview.style.transform = 'translate3d(' + dx + 'px,' + dy + 'px,0)'
        },
        finish: function () {
          var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
          if (reduced || typeof preview.animate !== 'function' || !cell.isConnected) { preview.remove(); return }
          var visibility = cell.style.visibility
          cell.style.visibility = 'hidden'
          var frame = window.requestAnimationFrame || function (callback) { callback() }
          frame(function () {
            if (cell.__phLayoutAnimation) { cell.__phLayoutAnimation.cancel(); cell.__phLayoutAnimation = null }
            var destination = cell.getBoundingClientRect()
            var animation = preview.animate([
              { transform: 'translate3d(' + dx + 'px,' + dy + 'px,0)', width: rect.width + 'px', height: rect.height + 'px', opacity: 1 },
              { transform: 'translate3d(' + (destination.left - rect.left) + 'px,' + (destination.top - rect.top) + 'px,0)', width: destination.width + 'px', height: destination.height + 'px', opacity: 1 },
            ], { duration: 190, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' })
            var done = function () { cell.style.visibility = visibility; preview.remove() }
            animation.onfinish = done
            animation.oncancel = done
          })
        },
      }
    }

    /**
     * Start a pointer-driven reorder. A mouse drag begins immediately from the
     * header or the handle; a touch drag needs a short hold on the handle, so a
     * normal swipe still scrolls the wall.
     * @param event - the pointerdown event.
     * @param card - card being moved.
     * @param origin - `header` or `handle`.
     */
    function beginDrag(event, card, origin) {
      if (store.drag) return
      if (event.pointerType === 'mouse' && event.button !== 0) return
      var pointerType = event.pointerType || 'mouse'
      var startX = event.clientX
      var startY = event.clientY
      var activated = false
      var timer = null
      var frame = null
      var point = { x: startX, y: startY }
      var preview = null
      var lastOver = null
      var target = event.currentTarget
      var scroller = target.closest ? target.closest('.ph-stage') : null
      var originalOrder = (store.state.order || []).slice()
      try { if (target.setPointerCapture) target.setPointerCapture(event.pointerId) } catch (error) { void error }

      var cleanup = function () {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        window.removeEventListener('keydown', onDragKey)
        window.removeEventListener('blur', onCancel)
        if (frame !== null && window.cancelAnimationFrame) window.cancelAnimationFrame(frame)
        frame = null
        try { if (target.releasePointerCapture) target.releasePointerCapture(event.pointerId) } catch (error) { void error }
        if (timer !== null) clearTimeout(timer)
      }
      var activate = function () {
        if (activated) return
        activated = true
        preview = createDragPreview(card, startX, startY)
        store.drag = { id: card.id, pointerType: pointerType, origin: origin }
        document.body.classList.add('ph-dragging')
        bump()
      }
      function paint() {
        frame = null
        preview.move(point.x, point.y)
        var scrolling = false
        if (scroller) {
          var bounds = scroller.getBoundingClientRect()
          var distance = point.y < bounds.top + 56 ? point.y - bounds.top - 56 : point.y > bounds.bottom - 56 ? point.y - bounds.bottom + 56 : 0
          var oldScroll = scroller.scrollTop
          if (distance) scroller.scrollTop += Math.max(-18, Math.min(18, distance * .28))
          scrolling = scroller.scrollTop !== oldScroll
        }
        var over = cardIdAtPoint(point.x, point.y)
        if (over && over !== card.id && over !== lastOver) { lastOver = over; reorderCards(card.id, over) }
        else if (!over || over === card.id) lastOver = null
        if (scrolling && window.requestAnimationFrame) frame = window.requestAnimationFrame(paint)
      }
      function matchesPointer(pointerEvent) { return pointerEvent.pointerId === undefined || event.pointerId === undefined || pointerEvent.pointerId === event.pointerId }
      function onMove(moveEvent) {
        if (!matchesPointer(moveEvent)) return
        if (!activated) {
          if (Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) > 10) cleanup()
          return
        }
        if (moveEvent.cancelable) moveEvent.preventDefault()
        point = { x: moveEvent.clientX, y: moveEvent.clientY }
        if (frame === null) {
          if (window.requestAnimationFrame) frame = window.requestAnimationFrame(paint)
          else paint()
        }
      }
      function onUp(upEvent) {
        if (upEvent && !matchesPointer(upEvent)) return
        if (activated) {
          if (upEvent && Number.isFinite(upEvent.clientX) && Number.isFinite(upEvent.clientY)) point = { x: upEvent.clientX, y: upEvent.clientY }
          if (frame !== null && window.cancelAnimationFrame) window.cancelAnimationFrame(frame)
          paint()
        }
        cleanup()
        if (!activated) return
        store.drag = null
        document.body.classList.remove('ph-dragging')
        bump()
        preview.finish()
        scheduleSave()
      }
      function onCancel(cancelEvent) {
        if (cancelEvent && !matchesPointer(cancelEvent)) return
        cleanup()
        if (!activated) return
        var animate = layoutTransition()
        store.drag = null
        store.state = Object.assign({}, store.state, { order: originalOrder })
        document.body.classList.remove('ph-dragging')
        bump(); animate(); preview.finish(); scheduleSave()
      }
      function onDragKey(event) { if (event.key === 'Escape') { event.preventDefault(); onCancel() } }
      window.addEventListener('pointermove', onMove, { passive: false })
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      window.addEventListener('keydown', onDragKey)
      window.addEventListener('blur', onCancel)
      if (pointerType === 'mouse' || origin === 'handle') {
        if (pointerType === 'mouse') activate()
        else timer = setTimeout(activate, 200)
      }
    }

    // --------------------------------------------------------- focus card

    /**
     * The expanded card.
     *
     * It is not a page of its own and it is not a cell of the wall either: the
     * card lifts out of the grid into a floating pane over it, three quarters of
     * the wall wide, while the wall underneath keeps every card exactly where it
     * was and goes uniformly out of focus. Expanding is therefore reversible
     * context, not a mode switch, and nothing else on the page moves.
     */
    function FocusCard(props) {
      var card = props.card
      var t = props.t
      var api = cardApi(card)
      var record = cardEffectRecord(card)
      var background = backgroundProps(cardBackground(card))
      var paneRef = React.useRef(null)
      React.useEffect(function () {
        var pane = paneRef.current
        if (!pane || typeof document === 'undefined') return
        var previous = document.activeElement
        var close = pane.querySelector('.ph-back')
        if (close) close.focus({ preventScroll: true })
        function trap(event) {
          if (event.key !== 'Tab') return
          var scope = Array.prototype.slice.call(pane.querySelectorAll('button,a[href],input,select,textarea,summary,[tabindex="0"]'))
          var portal = document.querySelector('.ph-popover-layer')
          if (portal) scope = scope.concat(Array.prototype.slice.call(portal.querySelectorAll('button,a[href],input,select,textarea,[tabindex="0"]')))
          var stops = scope.filter(function (node) { return !node.disabled && node.offsetParent !== null })
          if (!stops.length) return
          var first = stops[0]; var last = stops[stops.length - 1]
          if (event.shiftKey && (document.activeElement === first || stops.indexOf(document.activeElement) < 0)) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && (document.activeElement === last || stops.indexOf(document.activeElement) < 0)) { event.preventDefault(); first.focus() }
        }
        document.addEventListener('keydown', trap)
        return function () {
          document.removeEventListener('keydown', trap)
          if (previous && previous.isConnected && previous.focus) previous.focus({ preventScroll: true })
        }
      }, [card.id])
      var detailActions = Array.isArray(card.detailActions) ? card.detailActions : []
      var body = card.detail
        ? safeRender(card, card.detail, api)
        : h('div', { className: 'ph-detail-default' }, safeRender(card, card.content, api))
      // The FLIP origin captured when the card was clicked. Absent (a direct
      // `api.open` call, a re-measure failure) the pane simply fades in.
      var from = store.focusFrom
      var style = { width: (FOCUS_WIDTH * 100) + '%' }
      if (background.style) Object.assign(style, background.style)
      if (card.accent) style['--ph-bed'] = textOf(card.accent)
      if (from) {
        style['--ph-fdx'] = from.dx + 'px'
        style['--ph-fdy'] = from.dy + 'px'
        style['--ph-fsx'] = String(from.scale)
      }
      return h('div', {
        className: 'ph-focus-card', ref: paneRef, role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'ph-focus-title',
        'data-card-focus': card.id,
        style: style,
      },
        background.layer || liquidBed(card),
        h('span', { className: 'ph-glass', 'aria-hidden': 'true' }),
        record.sheen ? h('span', { className: 'ph-sheen is-on', 'aria-hidden': 'true' }) : null,
        textureLayer(cardTexture(card), card),
        h('div', { className: 'ph-focus-head' },
          h('span', { className: 'ph-card-icon' }, iconOf(card, 18)),
          h('div', { className: 'ph-focus-titles' },
              h('span', { className: 'ph-focus-context' }, t('panel.title') + ' / ' + t('design.detail')),
              h('h2', { id: 'ph-focus-title' }, textOf(card.detailTitle) || textOf(card.title)),
              card.subtitle ? h('p', null, textOf(card.subtitle)) : null,
            ),
            h('span', { className: 'ph-head-spacer' }),
            h(NoticeBubble, { cardId: card.id, list: store.notifications[card.id] }),
            h('kbd', { className: 'ph-focus-escape', 'aria-hidden': 'true' }, 'Esc'),
            h('button', {
              type: 'button', className: 'ph-back', title: t('panel.collapse'), 'aria-label': t('panel.collapse'), onClick: collapseCard,
            }, ICONS.close(17)),
          ),
          h('div', { className: 'ph-focus-toolbar' },
            renderActions(card, card.actions.concat(detailActions), { showLabel: true }),

          ),
          h('details', { className: 'ph-focus-design', key: card.id },
            h('summary', null, ICONS.setting(14), t('design.appearance'), h('span', null, cardSpan(card).w + ' × ' + cardSpan(card).h), ICONS.chevron(12)),
            h(CardDesign, { card: card, t: t })),
          h('div', { className: 'ph-focus-body' },
            h(CardBoundary, { cardId: card.id }, body),
          ),
      )
    }

    // --------------------------------------------------------------- panel

    /**
     * The panel's stylesheet, as elements the panel itself owns: the base sheet
     * plus every fragment a card or a custom effect registered. Rendering them
     * here instead of writing into the document keeps the framework inside the
     * React tree, so an unmounted panel leaves nothing behind.
     * @returns an array of `<style>` elements.
     */
    function styleSheets() {
      var sheets = [h('style', { key: 'ph-base' }, STYLES)]
      Object.keys(customCss).forEach(function (key) {
        sheets.push(h('style', { key: key }, customCss[key]))
      })
      return sheets
    }

    // ------------------------------------------------------- session bridge

    /**
     * Identity selector for the session hooks.
     *
     * The main slot forwards the session stores as selector hooks
     * (`SnapshotSelectorHook`), so the bridge must pass one. It wants the whole
     * snapshot and a re-render on every change, which is what an identity
     * selector asks the store for. Module-level so its identity never changes.
     */
    function bridgeSelector(value) { return value }

    /**
     * Copy `useSessionStatus()` into `runtime.sessionStatus`.
     *
     * The panel is the root component of the `main` slot, so ui-session's
     * provided hooks arrive as standard props (`useSessionStatus`,
     * `useSessions` — see ui-slots' `standardHookPropName`). A card is not
     * rendered by the engine and never sees those props, so the snapshot is
     * moved onto `runtime` and read back through `cardApi`.
     *
     * Mounted only when the prop is a function. A host without a session store
     * declares the hook absent, and the smoke harness never provides it; in
     * both cases the bridge is not mounted at all and a card reads `null`.
     * Calling a hook conditionally inside one component would break the hook
     * order — deciding in the parent whether to mount the component does not.
     */
    function SessionStatusBridge(props) {
      var snapshot = props.useSessionStatus(bridgeSelector)
      runtime.sessionStatus = snapshot === undefined || snapshot === null ? null : snapshot
      return null
    }

    /** Copy `useSessions()` into `runtime.sessionList`; same contract as above. */
    function SessionListBridge(props) {
      var snapshot = props.useSessions(bridgeSelector)
      runtime.sessionList = snapshot === undefined || snapshot === null ? null : snapshot
      return null
    }

    /** The panel registered on the `main` slot. */
    function HomePanel(props) {
      useStore()
      if (typeof React.useLayoutEffect === 'function') React.useLayoutEffect(function () {
        if (pendingLayoutTransition) pendingLayoutTransition()
      })
      var state = React.useState(function () { return { t: runtime.t } })
      var seat = state[0]
      var t = props && typeof props.t === 'function' ? props.t : seat.t
      React.useEffect(function () {
        if (props && typeof props.t === 'function') seat.t = props.t
      }, [props && props.t])
      React.useEffect(function () { void bootstrap() }, [])
      React.useEffect(function () {
        var onKey = function (event) {
          if (event.key === 'Escape') {
            if (store.drag) return
            if (store.customizing) { store.customizing = false; bump() }
            else if (store.expanded) collapseCard()
            else if (store.designing) { store.designing = null; bump() }
            else if (store.state.settings && store.state.settings.edit) patchState({ settings: Object.assign({}, store.state.settings, { edit: false }) })
          }
        }
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('keydown', onKey) }
      }, [])
      if (store.expanded && !registryById[store.expanded]) store.expanded = null
      var settings = store.state.settings || {}
      var density = settings.density || 'standard'
      var cards = orderedCards().filter(cardVisible)
      var focus = store.expanded ? registryById[store.expanded] : null
      // The bridges are the panel's first children, before the wall. React
      // renders children in order, so both snapshots are on `runtime` before the
      // first card renders; the smoke harness's eager createElement evaluates
      // them first for the same reason. A card therefore never reads the
      // previous render's snapshot. A missing prop yields null, not a bridge.
      var statusBridge = props && typeof props.useSessionStatus === 'function'
        ? h(SessionStatusBridge, { key: 'ph-session-status', useSessionStatus: props.useSessionStatus })
        : null
      var listBridge = props && typeof props.useSessions === 'function'
        ? h(SessionListBridge, { key: 'ph-session-list', useSessions: props.useSessions })
        : null
      return h('div', { className: 'ph-root' }, styleSheets(),
        h('div', { className: 'ph-panel ph-density-' + density + (settings.edit ? ' is-arranging' : '') + (focus ? ' is-focused' : '') },
          statusBridge,
          listBridge,
          h(Toolbar, { t: t }),
          store.customizing ? h(CustomizationStudio, { t: t }) : null,
          settings.edit && !focus ? h(ArrangementBar, { t: t }) : null,
          settings.edit && store.designing && !focus ? h(LayoutInspector, { t: t }) : null,
          store.hostError ? h('div', { className: 'ph-host-error' }, runtime.t('panel.stateError') + store.hostError) : null,
          h(ToastLayer, { t: t }),
          cards.length === 0
            ? (registry.length ? h('div', { className: 'ph-empty ph-hidden-empty' },
              ICONS.layers(28), h('h3', null, t('studio.empty')),
              h('button', { type: 'button', className: 'ph-customize-trigger', onClick: function () { store.customizing = true; bump() } }, ICONS.plus(15), t('studio.addCards')))
              : h(EmptyState, { t: t }))
            : h('div', { className: 'ph-stage' },
              h('div', {
                className: 'ph-grid' + (focus ? ' is-blurred' : '') + (settings.edit ? ' is-arranging' : ''),
                inert: focus ? '' : undefined, 'aria-hidden': focus ? true : undefined,
                // A click on the wall itself — not on any card — puts the
                // focused card back down.
                onClick: function (event) {
                  if (!focus) return
                  if (event && event.target === event.currentTarget) collapseCard()
                },
              }, cards.map(function (card) {
                return h(CardCell, {
                  key: card.id, card: card, t: t, density: density,
                  edit: Boolean(settings.edit), dimmed: Boolean(focus),
                })
              })),
              focus
                ? h('div', {
                  className: 'ph-focus-layer',
                  // The pane floats over the wall; the space around it is the
                  // way back down.
                  onClick: function (event) {
                    if (event && event.target === event.currentTarget) collapseCard()
                  },
                }, h(FocusCard, { card: focus, t: t }))
                : null,
            ),
          // Every dropdown and notice panel is drawn here, above the wall and
          // outside the card that opened it.
          h(PopoverLayer),
        ),
      )
    }

    /** Page-level toasts raised through `api.toast`. */
    function ToastLayer(props) {
      if (store.toasts.length === 0) return null
      return h('div', { className: 'ph-toasts' }, store.toasts.map(function (entry) {
        return h('div', { key: entry.id, className: 'ph-toast ph-toast--' + entry.level },
          h('span', { className: 'ph-toast-dot', style: { background: NOTICE_COLORS[entry.level] || NOTICE_COLORS.info } }),
          entry.text,
        )
      }))
    }

    // -------------------------------------------------------------- bootstrap

    var bootstrapped = false
    /** Load the persisted layout and install card hooks exactly once. */
    function bootstrap() {
      if (bootstrapped) return Promise.resolve()
      bootstrapped = true
      registry.forEach(function (card) { runOnMount(card) })
      return remoteCall('homepage/state', {}).then(function (persisted) {
        if (persisted && typeof persisted === 'object') {
          store.state = stateDocumentOf(persisted)
          writeStateCache(store.state)
        }
        store.hostReady = true
        bump()
        return store.state
      }).catch(function (error) {
        store.hostError = String(error && error.message ? error.message : error)
        store.hostReady = true
        bump()
        return null
      })
    }

    /** Run a card's `onMount` once, tolerating a throw. */
    function runOnMount(card) {
      if (!card.onMount) return
      try { card.onMount(cardApi(card)) }
      catch (error) { notify(card.id, 'error', String(error && error.message ? error.message : error)) }
    }

    // ------------------------------------------------------------- sidebar

    /** A stable selector: the reporter wants the whole snapshot, not a slice. */
    function workspaceSnapshotOf(value) { return value }
    /** A stable selector for the session list, for the same reason. */
    function sessionListOf(value) { return value }

    /**
     * Hands the sidebar's project list to the plugin store. Renders nothing.
     *
     * The project titles come from the workspace snapshot and the session rows
     * (titles, running/pinned/archived flags, and which session the main view
     * holds) from the session list; both are standard props at root scope.
     *
     * It rides inside the panel icon because that is the one entry this plugin
     * owns in a root-scoped slot: the card that names these projects has no slot
     * props of its own, and the sidebar is the only place that knows their
     * titles. A second `sidebar.panellist` registration would be worse than
     * useless — the sidebar turns every entry of that slot into a rail icon
     * (packages/client/ui-sidebar/src/client/index.ts:50).
     */
    function WorkspaceReporter(props) {
      var workspaces = props && props.useWorkspaces
      var sessions = props && props.useSessions
      var snapshot = typeof workspaces === 'function' ? workspaces(workspaceSnapshotOf) : null
      var list = typeof sessions === 'function' ? sessions(sessionListOf) : null
      React.useEffect(function () { reportWorkspaces(snapshot, list) }, [snapshot, list])
      return null
    }

    /**
     * The sidebar entry icon. The owner hands the slot `size` and `active`.
     *
     * The icon is the element itself, with no wrapper: an extra inline box would
     * shift the baseline, and this entry sits in a row of shipped icons. The
     * layout rides on the element too, because this icon is on screen before the
     * panel has ever mounted and cannot depend on the panel sheet. The fragment
     * holding the reporter draws no box, so the icon is still the only element.
     */
    function SidebarIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 18
      var active = !!(props && props.active)
      return h(React.Fragment, null,
        h(WorkspaceReporter, {
          useWorkspaces: props ? props.useWorkspaces : null,
          useSessions: props ? props.useSessions : null,
        }),
        h(Svg, {
          size: size,
          className: 'ph-sidebar-icon' + (active ? ' is-active' : ''),
          style: { display: 'block', width: size + 'px', height: size + 'px', opacity: active ? 1 : 0.78 },
        }, h('path', { d: 'M3 10.5 12 3l9 7.5' }), h('path', { d: 'M5 9.5V21h14V9.5' }), h('path', { d: 'M10 21v-6h4v6' })),
      )
    }

    // ------------------------------------------------------------ styles

    // A UI face with real CJK coverage: the panel inherits its host's font, which
    // on a bare desktop falls back to a serif-ish default for the Chinese cards.
    var UI_FONT = 'var(--dsw-font-family,"Segoe UI Variable Text","Segoe UI",-apple-system,' +
      'BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei UI","Microsoft YaHei",' +
      'system-ui,"Helvetica Neue",Arial,sans-serif)'
    var MONO_FONT = 'var(--dsw-font-family-mono,ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,' +
      '"Cascadia Mono","Liberation Mono",monospace)'

    // A 128px fractal-noise tile as an SVG data URI: the grain that gives a flat
// colour wash its tooth. Inlined because the plugin ships no image assets and
// the texture has to survive offline.
var GRAIN = 'url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22' +
  '%20width%3D%22128%22%20height%3D%22128%22%3E%3Cfilter%20id%3D%22g%22%3E' +
  '%3CfeTurbulence%20type%3D%22fractalNoise%22%20baseFrequency%3D%220.9%22%20numOctaves%3D%223%22%20stitchTiles%3D%22stitch%22%2F%3E' +
  '%3CfeColorMatrix%20type%3D%22saturate%22%20values%3D%220%22%2F%3E%3C%2Ffilter%3E' +
  '%3Crect%20width%3D%22128%22%20height%3D%22128%22%20filter%3D%22url(%23g)%22%2F%3E%3C%2Fsvg%3E")'

    var SIDEBAR_STYLES = [
      // The host mounts this region as a bare custom element inside its own
      // column, so the element itself has to carry the height chain. Without it
      // nothing bounds the list: the region grows to its content and the list's
      // own overflow-y never engages, so the tail of a long tree is unreachable.
      'homepage-sidebar{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;' +
        'height:100%;max-height:100%;overflow:hidden}',
      '.ph-sb{flex:1 1 auto;display:flex;flex-direction:column;min-width:0;min-height:0;' +
        'font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.ph-sb-body{flex:1 1 auto;display:flex;flex-direction:column;min-width:0;min-height:0;' +
        'container-type:inline-size;container-name:ph-sidebar}',
      // The wide header spans into the room the rail would use, so it stays
      // content-sized: letting it grow would push the list down to the middle of
      // the region and leave a dead band above it.
      '.ph-sb-wide{flex:none;display:flex;flex-direction:column;min-width:0;min-height:0}',
      '.ph-sb-rail{display:none;flex-direction:column;align-items:center;gap:2px;padding:4px 0}',
      '@container ph-sidebar (max-width:120px){.ph-sb-wide{display:none}.ph-sb-rail{display:flex}' +
        '.ph-sb-scroll{display:none}}',

      // Region header: a label, an inline search that grows into the room, and
      // the action cluster that gives that room back while search is open.
      '.ph-sb-bar{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:4px;' +
        'height:36px;margin-bottom:4px;border-radius:var(--dsw-radius-md,8px);overflow:hidden;' +
        'color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.ph-sb-bar-label{flex:none;max-width:45%;min-width:0;overflow:hidden;white-space:nowrap;' +
        'transition:max-width 180ms ease,opacity 120ms ease}',
      '.ph-sb-bar-label.is-hidden{max-width:0;opacity:0}',
      '.ph-sb-bar-search{flex:1 1 auto;max-width:28px;min-width:0;display:flex;align-items:center;' +
        'margin-left:auto;transition:max-width 180ms ease}',
      '.ph-sb-bar-search.is-open{max-width:100%}',
      '.ph-sb-bar-actions{flex:none;display:flex;align-items:center;gap:4px;max-width:64px;opacity:1;' +
        'overflow:hidden;transition:max-width 180ms ease,opacity 120ms ease}',
      '.ph-sb-bar-actions.is-hidden{max-width:0;opacity:0;pointer-events:none}',
      '.ph-sb-search{display:flex;align-items:center;width:100%;height:28px;box-sizing:border-box;' +
        'border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;cursor:text;' +
        'color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      '.ph-sb-search.is-open{height:30px;padding-right:4px;border:0.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.16));' +
        'border-radius:var(--dsw-radius-md,8px);color:var(--dsw-alias-label-caption,#adb2b8)}',
      '.ph-sb-sbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;' +
        'padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;cursor:pointer;' +
        'color:inherit;font-family:inherit}',
      '.ph-sb-search.is-open .ph-sb-sbtn{height:30px}',
      '.ph-sb-search:not(.is-open) .ph-sb-sbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
      '.ph-sb-sinput{flex:1 1 auto;width:0;min-width:0;border:0;outline:none;background:transparent;' +
        'font-family:inherit;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#e6e8ea);' +
        'opacity:0;pointer-events:none;transition:opacity 120ms ease}',
      '.ph-sb-search.is-open .ph-sb-sinput{margin-left:-2px;opacity:1;pointer-events:auto}',
      '.ph-sb-sinput::placeholder{color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.ph-sb-clear{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;' +
        'padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;cursor:pointer;' +
        'color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      '.ph-sb-clear:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',

      // One icon button for the header, the rail and the rows; the row cluster
      // shrinks it to the shipped 18px hover glyph.
      '.ph-sb-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;' +
        'padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;cursor:pointer;' +
        'color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      '.ph-sb-icon:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));' +
        'color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.ph-sb-icon:focus-visible,.ph-sb-sbtn:focus-visible,.ph-sb-clear:focus-visible,' +
        '.ph-sb-row:focus-visible,.ph-sb-more:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ' +
        'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:-2px}',
      '.ph-sb-rail .ph-sb-icon{width:36px;height:36px;border-radius:var(--dsw-radius-md,8px);' +
        'color:var(--dsw-alias-label-primary,#e6e8ea)}',

      // The list is the only scrolling region. The negative inline margins let
      // a row hover fill the shell's own padding, and the stable gutter keeps
      // rows from shifting when the scrollbar appears.
      '.ph-sb-list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;' +
        'margin-left:-4px;padding-left:4px;padding-bottom:16px;scrollbar-gutter:stable}',
      '.ph-sb-fade{position:absolute;left:0;right:0;bottom:0;height:24px;pointer-events:none;' +
        'background:linear-gradient(to bottom,transparent,var(--dsw-specific-sidebar-fill,transparent))}',
      '.ph-sb-scroll{position:relative;flex:1 1 auto;min-height:0;display:flex;flex-direction:column}',
      // Rail shape, restated after the base rule: a container query loses to any
      // later normal rule of the same specificity, so hiding the list up in the
      // first @container block is not enough — the squeezed tree would keep
      // drawing itself under the icon column.
      '@container ph-sidebar (max-width:120px){.ph-sb-scroll{display:none}}',

      // Rows: one shape for a group heading, a project and a session; the
      // indent is the shipped custom property, one step per level.
      '.ph-sb-group{display:flex;flex-direction:column}',
      '.ph-sb-group + .ph-sb-group{margin-top:4px}',
      '.ph-sb-group-body{display:flex;flex-direction:column}',
      '.ph-sb-group-body > * + *,.ph-sb-list > * + *{margin-top:2px}',
      '.ph-sb-row{display:flex;align-items:center;gap:6px;box-sizing:border-box;' +
        'border-radius:var(--dsw-radius-md,8px);padding:0 8px;' +
        'padding-inline-start:calc(8px + var(--ph-sb-indent,0px));cursor:pointer;user-select:none;' +
        'color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.ph-sb-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
      '.ph-sb-row.is-open{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
      '.ph-sb-group-head{--ph-sb-indent:0px;height:34px}',
      '.ph-sb-project{--ph-sb-indent:12px;height:32px}',
      '.ph-sb-session{--ph-sb-indent:24px;height:32px;gap:0}',
      '.ph-sb-session.is-current{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
      '.ph-sb-project.is-orphan .ph-sb-title{opacity:.7}',
      '.ph-sb-slot{flex:none;width:16px;height:20px;display:inline-flex;align-items:center;justify-content:center;' +
        'color:var(--dsw-alias-label-tertiary,#81858c)}',
      // The caret is a control of its own inside that slot (the folder beside
      // it is not), so it carries the button reset the row expects; the rule
      // below still hides it until the row is hovered or open.
      '.ph-sb-chev,.ph-sb-folder{display:inline-flex;align-items:center;justify-content:center;' +
        'width:16px;height:20px;padding:0;border:0;background:transparent;color:inherit;cursor:pointer}',
      // The shipped row shows the folder, and swaps it for the expand arrow on
      // hover: the arrow is the affordance, the folder the resting state.
      '.ph-sb-chev{display:none}',
      '.ph-sb-row:hover .ph-sb-chev,.ph-sb-row:focus-visible .ph-sb-chev,.ph-sb-row.is-open .ph-sb-chev{display:inline-flex}',
      '.ph-sb-row:hover .ph-sb-folder,.ph-sb-row:focus-visible .ph-sb-folder,.ph-sb-row.is-open .ph-sb-folder{display:none}',
      // The shipped row arrow is a filled right-hand triangle that turns down
      // when the row opens (`.arrow` / `.arrowOpen{rotate(90deg)}`), and this
      // region's caret is drawn the same way.
      '.ph-sb-chev svg{transition:transform 150ms ease;transform:rotate(0deg)}',
      '.ph-sb-chev.is-open svg{transform:rotate(90deg)}',
      '.ph-sb-folder.is-active{color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.ph-sb-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'font-size:14px;line-height:20px}',
      '.ph-sb-meta{flex:none;margin-left:6px;font-size:10px;line-height:16px;' +
        'color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.ph-sb-title-editing{flex:1 1 auto;min-width:0}',
      // Trailing actions surface on hover with the shipped 18px glyphs, so a
      // quiet row stays a row of text.
      '.ph-sb-actions{flex:none;display:none;align-items:center;gap:10px}',
      '.ph-sb-row:hover .ph-sb-actions,.ph-sb-row:focus-within .ph-sb-actions,.ph-sb-row.is-open .ph-sb-actions{display:inline-flex}',
      '.ph-sb-actions .ph-sb-icon{width:18px;height:18px;border-radius:var(--dsw-radius-xs,4px)}',
      '.ph-sb-row:hover .ph-sb-meta,.ph-sb-row.is-open .ph-sb-meta{display:none}',
      '.ph-sb-dot{flex:none;display:inline-flex;width:6px;height:6px;margin:0 5px;border-radius:50%;' +
        'background:var(--dsw-alias-label-dimmed,#5b5f66)}',
      '.ph-sb-dot.is-run{background:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.ph-sb-dot.is-done{background:var(--dsw-alias-state-success-primary,#46a758)}',
      '.ph-sb-dot.is-error{background:var(--dsw-alias-state-error-primary,#e5484d)}',
      // A group or project marker: the same filled circle as the state dot, but
      // it takes whatever colour the document stored (inline `color`).
      '.ph-sb-mark{flex:none;display:inline-flex;width:6px;height:6px;margin:0 6px 0 0;' +
        'border-radius:50%;background:currentColor}',
      '.ph-sb-pin{flex:none;display:inline-flex;width:16px;height:20px;align-items:center;justify-content:center;' +
        'color:var(--dsw-alias-label-caption,#adb2b8)}',

      '.ph-sb-more{width:100%;box-sizing:border-box;height:28px;border:0;border-radius:var(--dsw-radius-sm,6px);' +
        'padding:0 12px 0 calc(28px + var(--ph-sb-indent,0px));background:transparent;cursor:pointer;' +
        'text-align:left;font-family:inherit;font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.ph-sb-more:hover{color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      '.ph-sb-empty{padding:16px 12px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.ph-sb-error{padding:0 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.ph-sb-crashed{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:12px;' +
        'font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#9aa4b2)}',

      // A content-search hit keeps the shipped search row: title over a muted
      // meta line that names the project.
      '.ph-sb-result{display:flex;flex-direction:column;align-items:stretch;width:100%;box-sizing:border-box;' +
        'min-height:48px;border:0;border-radius:var(--dsw-radius-lg,10px);padding:4px 8px;background:transparent;' +
        'cursor:pointer;text-align:left;color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.ph-sb-result:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
      '.ph-sb-result-head{display:flex;align-items:center;min-width:0}',
      '.ph-sb-result-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'font-size:14px;line-height:20px}',
      '.ph-sb-result-meta{display:flex;align-items:center;gap:6px;min-width:0;margin-left:20px}',
      '.ph-sb-result-ws{flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.ph-sb-result-ws:only-child{max-width:100%}',
      '.ph-sb-result-snippet{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#9aa4b2)}',

      // Inline editors and the fallback dialog, for the case where the shell
      // hands this bundle no UI kit.
      '.ph-sb-field{box-sizing:border-box;width:100%;height:32px;padding:0 8px;font-family:inherit;font-size:14px;line-height:22px;' +
        'color:var(--dsw-alias-label-primary,#e6e8ea);background:var(--dsw-alias-bg-layer-1,#17181a);' +
        'border:0.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.2));border-radius:var(--dsw-radius-md,8px);' +
        'outline:none}',
      '.ph-sb-field:focus{border-color:var(--dsw-alias-state-business-primary,#3b6fe0)}',
      '.ph-sb-field::placeholder{color:var(--dsw-alias-label-dimmed,#6b7076)}',
      '.ph-sb-form{display:flex;flex-direction:column;gap:8px}',
      '.ph-sb-form-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      '.ph-sb-form-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.ph-sb-form-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:4px}',

      // The kit's `Button` does not exist without the shell, so a dialog drawn
      // in the fallback keeps the same metrics instead of borrowing a menu row:
      // one control height, centred label, an outline for the quiet actions and
      // the filled business colour for the commit. This is the difference the
      // reader notices — the menu row has no border, a left-aligned label and
      // a text colour meant for a list, so a footer of them reads as unstyled.
      '.ph-sb-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;' +
        'height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;' +
        'font-family:inherit;font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer;' +
        'color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.ph-sb-btn:disabled{cursor:not-allowed;opacity:.4}',
      '.ph-sb-btn--sm{height:28px;padding:0 10px;font-size:12px;line-height:18px;' +
        'border-radius:var(--dsw-radius-sm,6px)}',
      '.ph-sb-btn--primary{background:var(--dsw-alias-button-primary-fill,#3b6fe0);' +
        'color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.ph-sb-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#4e7ef0)}',
      '.ph-sb-btn--outline{border:0.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.24))}',
      '.ph-sb-btn--outline:hover:not(:disabled),' +
        '.ph-sb-btn--ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
      '.ph-sb-btn-icon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px}',
      // A destructive confirm keeps the shell's own error token; the element
      // selector outranks the kit button's variant rules, which are ordered
      // before or after this sheet depending on load order.
      'button.ph-sb-danger,button.ph-sb-danger:hover:not(:disabled){' +
        'background:var(--dsw-alias-state-error-primary,#e5484d);' +
        'color:var(--dsw-alias-label-primary-foreground,#fff)}',

      // The popover this region draws when the kit is absent: the same list the
      // kit would draw, in the region's own sheet. The surface is the shell's
      // own layer token — `--dsw-alias-bg-elevated` does not exist, and its
      // dark literal is what kept this card dark in a light theme.
      '.ph-sb-pop{z-index:60;min-width:190px;max-height:60vh;overflow:auto;padding:4px;' +
        'border:0.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));' +
        'border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,#1f2124);' +
        'box-shadow:0 12px 32px rgba(0,0,0,.32)}',
      '.ph-sb-pop-layer{position:fixed;inset:0;z-index:59}',
      // A dialog drawn without the kit: centred over the page, on a dimmed
      // mask, so it lands where the reader is looking instead of in the page's
      // top-left corner, and the mask (or Escape, or the cancel button) closes
      // it — a layer over the whole page with no way out is what made the old
      // card read as "stuck".
      '.ph-sb-pop-layer--center{display:flex;align-items:center;justify-content:center;padding:24px;' +
        'background:rgba(0,0,0,.32)}',
      '.ph-sb-pop--dialog{position:relative;min-width:360px;max-width:min(560px,92vw);max-height:74vh}',
      '.ph-sb-dialog-title{font-size:13px;font-weight:600;line-height:20px;' +
        'color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.ph-sb-dialog-body{display:flex;flex-direction:column;gap:6px}',
      // The shell's `Modal` portals itself, so the element the region wraps it
      // in must not add a box of its own.
      '.ph-sb-modal{display:contents}',
      '.ph-sb-pop-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 8px;' +
        'border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;cursor:pointer;text-align:left;' +
        'font-family:inherit;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.ph-sb-pop-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
      '.ph-sb-pop-item.is-current{font-weight:600}',
      '.ph-sb-pop-item.is-danger{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.ph-sb-pop-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ph-sb-pop-trail{flex:none;font-size:11px;opacity:.7}',
      '.ph-sb-pop-label{padding:5px 8px 2px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;' +
        'color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.ph-sb-pop-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l2,rgba(255,255,255,.12))}',

      // The region's own directory browser (the shell's `Modal` draws the card
      // when the kit is there; these are the rows both draw).
      '.ph-sb-dir{display:flex;flex-direction:column;gap:6px;min-height:180px;max-height:46vh}',
      '.ph-sb-dir-crumbs{display:flex;align-items:center;flex-wrap:wrap;gap:0 2px;min-height:22px}',
      // The trail turns into a path field: the shipped browser lets a reader
      // type an absolute path instead of walking to it.
      '.ph-sb-dir-path{display:flex;align-items:center;gap:6px;min-height:22px}',
      '.ph-sb-dir-path-field{flex:1 1 auto;width:auto}',
      '.ph-sb-dir-edit{margin-left:auto}',
      '.ph-sb-dir-seat{display:inline-flex;align-items:center;gap:2px}',
      // The region's chevron glyph points down; the trail needs it pointing at
      // the next segment, the same way the shipped browser's crumb row does.
      '.ph-sb-dir-chev{display:inline-flex;align-items:center;transform:rotate(-90deg);' +
        'color:var(--dsw-alias-label-caption,#6b7076)}',
      '.ph-sb-dir-crumb{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 2px;' +
        'border:0;border-radius:var(--dsw-radius-xs,4px);background:transparent;cursor:pointer;' +
        'font-family:inherit;font-size:13px;line-height:20px;font-weight:500;' +
        'color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.ph-sb-dir-crumb:hover{color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.ph-sb-dir-crumb:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ' +
        'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b6fe0));outline-offset:1px}',
      '.ph-sb-dir-crumb.is-current{color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.ph-sb-dir-list{display:flex;flex-direction:column;gap:1px;min-height:0;overflow:auto}',
      '.ph-sb-dir-row{display:flex;align-items:center;gap:4px;width:100%;box-sizing:border-box;height:28px;padding:0 4px;' +
        'border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;cursor:pointer;text-align:left;' +
        'font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.ph-sb-dir-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
      // The shipped row keeps its focus ring inside the scrolling column; a
      // ring outside the row would be clipped by the list.
      '.ph-sb-dir-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ' +
        'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b6fe0));outline-offset:-2px}',
      '.ph-sb-dir-row.is-hidden{opacity:.62}',
      '.ph-sb-dir-icon{flex:none;display:inline-flex;opacity:.7}',
      '.ph-sb-dir-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ph-sb-dir-note{padding:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      '.ph-sb-dir-newfold{display:flex;align-items:center;gap:6px}',
      '.ph-sb-dir-newfold .ph-sb-field{flex:1 1 auto}',
      // The footer toggle from the shipped browser: plain text at control size,
      // no border, and the pressed state marked by a trailing check so the
      // label never shifts; the spacer puts the pair of actions at the end.
      '.ph-sb-dir-toggle{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;padding:0;' +
        'font-family:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer;' +
        'color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      '.ph-sb-dir-toggle:hover{color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.ph-sb-dir-toggle.is-on{color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.ph-sb-dir-toggle-check{display:inline-flex;align-items:center}',
      '.ph-sb-dir-gap{flex:1 1 0}',
    ].join('\n')

var STYLES = [
      '.ph-panel{position:relative;display:flex;flex-direction:column;gap:12px;padding:16px;height:100%;overflow:hidden;' +
        '--ph-max:1180px;--ph-gap:14px;--ph-row:196px;' +
        'font-family:' + UI_FONT + ';font-size:13px;line-height:1.45;letter-spacing:0;' +
        '-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;' +
        'color:var(--dsw-alias-label-primary,#e6e6e6);box-sizing:border-box}',

      // A quiet, theme-native design studio: tinted surfaces, crisp controls,
      // editorial hierarchy. No external font or image requests.
      '.ph-customize-trigger{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:7px 12px;border-radius:10px;' +
        'font:inherit;font-weight:600;cursor:pointer;border:1px solid color-mix(in srgb,currentColor 12%,transparent);' +
        'color:inherit;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));transition:background .18s,box-shadow .18s}',
      '.ph-customize-trigger:hover,.ph-customize-trigger.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#7c83ff) 12%,transparent);' +
        'border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#7c83ff) 40%,transparent)}',
      '.ph-studio{flex:none;width:100%;max-width:var(--ph-max);margin:0 auto;box-sizing:border-box;border-radius:20px;' +
        'border:1px solid color-mix(in srgb,currentColor 12%,transparent);background:var(--dsw-alias-bg-layer-1,#202126);' +
        'box-shadow:0 12px 36px #0000000a;overflow:auto;max-height:70%;scrollbar-width:thin;container-type:inline-size;' +
        'scrollbar-color:color-mix(in srgb,currentColor 22%,transparent) transparent}',
      '.ph-studio-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:20px 22px 16px;' +
        'border-bottom:1px solid color-mix(in srgb,currentColor 8%,transparent)}',
      '.ph-studio-eyebrow{display:block;font-size:9px;font-weight:700;letter-spacing:.16em;color:var(--dsw-alias-label-secondary,#9199ac)}',
      '.ph-studio-header h3{font-size:20px;letter-spacing:-.035em;line-height:1.4;margin:5px 0 3px;font-weight:650}',
      '.ph-studio-header p{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#9199ac)}',
      '.ph-studio-icon-button{display:grid;place-items:center;border:0;border-radius:8px;width:30px;height:30px;background:transparent;color:inherit;cursor:pointer}',
      '.ph-studio-icon-button:hover{background:color-mix(in srgb,currentColor 8%,transparent)}',
      '.ph-studio-layout{display:grid;grid-template-columns:minmax(180px,.8fr) minmax(0,2fr)}',
      '.ph-studio-library{padding:18px;border-right:1px solid color-mix(in srgb,currentColor 8%,transparent);min-width:0}',
      '.ph-studio-section-title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;font-weight:650;margin-bottom:9px}',
      '.ph-studio-section-title>span{font-size:10px;color:var(--dsw-alias-label-secondary,#9199ac);font-variant-numeric:tabular-nums}',
      '.ph-studio-muted{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#9199ac);margin:0 0 12px}',
      '.ph-studio-card-list{display:flex;flex-direction:column;gap:4px;max-height:330px;overflow:auto;scrollbar-width:thin}',
      '.ph-studio-card-row{display:flex;align-items:center;border:1px solid transparent;border-radius:11px;min-width:0;padding:3px;transition:background .18s}',
      '.ph-studio-card-row:hover{background:color-mix(in srgb,currentColor 4%,transparent)}',
      '.ph-studio-card-row.is-selected{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#7c83ff) 9%,transparent);' +
        'border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#7c83ff) 24%,transparent)}',
      '.ph-studio-card-row.is-hidden .ph-studio-card-select{color:var(--dsw-alias-label-secondary,#9199ac)}',
      '.ph-studio-card-select{display:flex;align-items:center;gap:9px;flex:1;min-width:0;padding:6px;background:none;border:0;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer}',
      '.ph-studio-card-select>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ph-studio-card-icon{display:grid;place-items:center;width:28px;height:28px;flex:none;border-radius:8px;background:color-mix(in srgb,currentColor 8%,transparent)}',
      '.ph-studio-visibility{display:grid;place-items:center;flex:none;width:28px;height:28px;border-radius:8px;cursor:pointer;' +
        'border:1px solid color-mix(in srgb,currentColor 14%,transparent);background:transparent;color:inherit}',
      '.ph-studio-visibility[aria-pressed=true]{color:var(--dsw-alias-brand-primary,#7c83ff);background:color-mix(in srgb,currentColor 10%,transparent)}',
      '.ph-studio-text-button{border:0;background:transparent;color:var(--dsw-alias-brand-primary,#7c83ff);font:inherit;font-size:11px;padding:6px 0;cursor:pointer}',
      '.ph-studio-editor{padding:20px 24px;min-width:0}',
      '.ph-studio-preview{position:relative;isolation:isolate;overflow:hidden;min-height:132px;border-radius:15px;margin-bottom:18px;' +
        'background:color-mix(in srgb,var(--ph-bed) 5%,var(--dsw-alias-bg-layer-2,#25262c));' +
        'box-shadow:inset 0 0 0 1px color-mix(in srgb,currentColor 9%,transparent)}',
      '.ph-studio-preview-content{position:relative;z-index:2;display:flex;align-items:flex-start;flex-direction:column;gap:9px;padding:22px;pointer-events:none}',
      '.ph-studio-preview-content strong{font-size:23px;font-weight:600;letter-spacing:-.04em}.ph-studio-preview-content .ph-studio-muted{margin:0}',
      '.ph-studio-patterns{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px}',
      '.ph-studio-pattern{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:12px 4px;border-radius:11px;' +
        'border:1px solid color-mix(in srgb,currentColor 10%,transparent);background:transparent;color:inherit;font:inherit;font-size:10px;cursor:pointer;transition:background .18s,border-color .18s}',
      '.ph-studio-pattern:hover{background:color-mix(in srgb,currentColor 5%,transparent)}',
      '.ph-studio-pattern.is-selected{color:var(--dsw-alias-brand-primary,#7c83ff);border-color:currentColor;background:color-mix(in srgb,currentColor 7%,transparent)}',
      '.ph-studio-import{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:12px 0 18px}.ph-studio-import .ph-studio-muted{margin:0}',
      '.ph-studio-upload{position:relative;display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:7px 10px;border-radius:8px;' +
        'border:1px dashed color-mix(in srgb,currentColor 22%,transparent);cursor:pointer;overflow:hidden}',
      '.ph-studio-upload input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}',
      '.ph-studio-placement{border:0;padding:0;margin:0;min-width:0}.ph-studio-placement:disabled{opacity:.4}',
      '.ph-studio-placement legend{font-size:12px;font-weight:650;margin-bottom:10px}',
      '.ph-studio-anchors{display:flex;padding:3px;border-radius:9px;gap:3px;background:color-mix(in srgb,currentColor 5%,transparent);margin-bottom:15px}',
      '.ph-studio-anchor{flex:1;padding:6px;border:1px solid transparent;border-radius:7px;color:inherit;background:transparent;font:inherit;font-size:11px;cursor:pointer}',
      '.ph-studio-anchor.is-selected{background:var(--dsw-alias-bg-layer-2,#303138);box-shadow:0 1px 4px #0000000c;border-color:color-mix(in srgb,currentColor 8%,transparent)}',
      '.ph-studio-ranges{display:grid;grid-template-columns:1fr 1fr;gap:12px 24px}.ph-studio-range{display:flex;flex-direction:column;gap:7px;min-width:0}',
      '.ph-studio-range>span{display:flex;justify-content:space-between;font-size:11px}.ph-studio-range output{color:var(--dsw-alias-label-secondary,#9199ac);font-variant-numeric:tabular-nums}',
      '.ph-studio-range input{width:100%;margin:0;accent-color:var(--dsw-alias-brand-primary,#7c83ff);cursor:pointer}',
      '.ph-studio-range.is-disabled{opacity:.5}.ph-studio-range input:disabled{opacity:.5;cursor:not-allowed}',
      '.ph-studio-fade{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:2px 0 9px}',
      '.ph-studio-fade .ph-studio-muted{margin:0;font-size:10px}',
      '.ph-studio-fade-range{display:grid;margin:0 0 16px}',
      '.ph-studio-blend{display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
      '.ph-studio-blend-label{font-size:11px;font-weight:650;flex:none}',
      '.ph-studio-blends{display:flex;flex:1 1 260px;min-width:0;padding:3px;border-radius:9px;gap:3px;' +
        'background:color-mix(in srgb,currentColor 5%,transparent);flex-wrap:wrap}',
      '.ph-studio-blend-option{flex:1 1 auto;min-width:54px;padding:6px 8px;border:1px solid transparent;border-radius:7px;' +
        'color:inherit;background:transparent;font:inherit;font-size:11px;cursor:pointer}',
      '.ph-studio-blend-option.is-selected{background:var(--dsw-alias-bg-layer-2,#303138);box-shadow:0 1px 4px #0000000c;' +
        'border-color:color-mix(in srgb,currentColor 8%,transparent)}',
      '.ph-studio-blend-hint{margin:7px 0 0;font-size:10px}',
      '.ph-studio-save-note{margin:17px 0 0;font-size:10px}.ph-studio-error{color:var(--dsw-alias-state-error-primary,#e5484d);font-size:11px}',
      '.ph-hidden-empty{display:flex;flex-direction:column;align-items:center;gap:12px}.ph-hidden-empty h3{margin:0}',
      '.ph-panel:has(.ph-studio) .ph-stage{overflow:auto;scrollbar-width:thin}',
      '.ph-studio button:focus-visible,.ph-customize-trigger:focus-visible,.ph-studio input:focus-visible,.ph-studio-upload:focus-within{' +
        'outline:2px solid var(--dsw-alias-brand-primary,#7c83ff);outline-offset:3px}',
      '@container(max-width:700px){.ph-studio-layout{grid-template-columns:1fr}.ph-studio-library{border-right:0;border-bottom:1px solid color-mix(in srgb,currentColor 8%,transparent)}' +
        '.ph-studio-card-list{max-height:160px}.ph-studio-editor{padding:16px}.ph-studio-ranges{gap:12px}}',
      '@media(max-width:700px){.ph-studio-layout{grid-template-columns:1fr}.ph-studio-library{border-right:0;border-bottom:1px solid color-mix(in srgb,currentColor 8%,transparent)}' +
        '.ph-studio-card-list{max-height:160px}.ph-studio-editor{padding:16px}.ph-studio-header{padding:16px}.ph-studio{max-height:75%}.ph-studio-ranges{gap:12px}}',
      '@media(prefers-reduced-motion:reduce){.ph-root *,.ph-root *::before,.ph-root *::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}',

      // toolbar
      '.ph-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;' +
        'width:100%;max-width:var(--ph-max,1120px);margin:0 auto}',

      '.ph-toolbar-title{display:flex;align-items:center;gap:8px;font-weight:650;font-size:15px}',

      '.ph-toolbar-icon{display:inline-flex;opacity:.75}',

      '.ph-count{font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;' +
        'background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08));color:var(--dsw-alias-label-secondary,#9aa4b2)}',

      '.ph-toolbar-tools{display:flex;align-items:center;gap:14px;margin-left:auto;flex-wrap:wrap}',

      // The wall. Five columns and a bounded width, so a card's shape follows
      // its declared span instead of the window: a 1x1 card stays a tile and a
      // 2x1 card stays a banner. Rows are sized by content — a card that holds
      // one reading is as tall as that reading, not as tall as the tallest card
      // on the wall used to force it to be. Nothing here scrolls.
      '.ph-stage{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}',

      // `dense` is what keeps the wall from turning into a staircase. Placement is
      // first-fit over the card order: nearly every 2-wide card leaves a 1-cell
      // tail at one row's fifth column, and sparse flow (the default) only ever
      // moves its cursor forward — it will not come back to that cell, so the hole
      // stays a hole while the rest of the wall grows downward past it. Dense flow
      // sends the next card that fits into the earliest hole, which costs strict
      // "cards appear in list order" reading order and buys a wall without notches.
      '.ph-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));' +
        'gap:var(--ph-gap,14px);grid-auto-rows:auto;grid-auto-flow:row dense;align-content:start;' +
        'width:100%;max-width:var(--ph-max,1180px);margin:0 auto;padding:2px;' +
        'transition:filter .34s cubic-bezier(.2,.8,.3,1),opacity .34s,transform .34s}',

      // While a card is up, the wall stays exactly where it was and goes out of
      // focus as one sheet.
      '.ph-grid.is-blurred{filter:blur(9px) saturate(.8);opacity:.55;transform:scale(.985);pointer-events:none}',

      // `--ph-row` is a floor, not a height: density sets how much air a card
      // gets at minimum, the content decides the rest.
      '.ph-density-compact{--ph-gap:12px;--ph-row:112px}',

      '.ph-density-standard{--ph-gap:14px;--ph-row:128px}',

      '.ph-density-cozy{--ph-gap:18px;--ph-row:152px}',

      '.ph-cell{position:relative;display:grid;min-width:0;min-height:0}',

      '.ph-cell.is-hovered,.ph-cell.is-dragging{z-index:40}',

      '.ph-cell.is-dragging{opacity:.88}',

      // Liquid glass. The shell owns the silhouette and the depth; the glass
      // layer above the card's bed does the frosting. The edge is a hairline
      // ring folded into the shadow rather than a border, so it costs no
      // layout and follows the theme's border token: without it a translucent
      // card dissolves into a same-coloured page, which is what happened in
      // light mode where the fill is white on white.
      // The shell is in flow so the card can size to its content: an absolutely
      // positioned shell contributes no height, which is what forced every card
      // onto a fixed row. `grid-area:1/1` keeps it filling the cell while the
      // cell (and therefore the row) grows with whatever the card renders.
      '.ph-shell{position:relative;grid-area:1/1;min-height:var(--ph-row,128px);' +
        'display:flex;flex-direction:column;border-radius:22px;overflow:hidden;cursor:default;' +
        'background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#15171c) 44%,transparent);' +
        'border:0;' +
        'box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l1,rgba(127,132,140,.22)),' +
        'var(--dsw-elevation-panel,0 .5px 0 rgba(255,255,255,.14),0 10px 30px -14px rgba(0,0,0,.5));' +
        'transition:transform .2s cubic-bezier(.2,.8,.3,1),box-shadow .2s,border-radius .2s}',

      // The bed: ONE flat tint of the card's accent. A ramp that runs accent ->
      // white -> accent is two colours fighting inside one card; a single hue
      // stays calm and keeps the accent readable as a colour rather than as a
      // gradient. 3% is a whisper on purpose: the surface reads as white that
      // leans (#F5F6FB blue / #F9FCF9 green / #FEFCF8 amber) because a heavier
      // colour is exactly what makes any colour step shout.
      // `--ph-bed` is the card accent.
      '.ph-bed{background:color-mix(in srgb,var(--ph-bed,var(--dsw-alias-brand-primary,#5b8cff)) 3%,transparent)}',

      // The grain rides ON the glass, not under it: `.ph-glass` carries
      // `backdrop-filter`, so anything painted below it is blurred — a 128px
      // noise tile behind a 22px blur averages out into the flat wash it was
      // meant to break up.
      '.ph-glass::after{content:"";position:absolute;inset:0;pointer-events:none;' +
        'background-image:' + GRAIN + ';background-size:128px 128px;opacity:.04}',

      // The glass is the frosting itself: the backdrop filter over a hair of
      // white. White is literal here, NOT `--dsw-alias-label-primary`: that token
      // is the *text* colour, which is near-black in light mode, so using it as a
      // light veil painted a dark wash over every card (measured: it took a
      // #F4F7FF surface down to #E9EBF3). The state-layer hovers below still use
      // the label token on purpose — a darkening hover in light mode is the
      // conventional treatment, and that is exactly what a state layer is.
      '.ph-glass{position:absolute;inset:0;pointer-events:none;border-radius:inherit;' +
        'z-index:1;' +
        'background:color-mix(in srgb,#fff 5%,transparent);' +
        'backdrop-filter:var(--dsw-menu-backdrop-filter,blur(22px) saturate(170%));' +
        '-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(22px) saturate(170%))}',

      // The card texture: an identifying mark the card prints on its own surface.
      // It sits at `z-index:1` — above the bed and the glass, below the type at
      // `z-index:2` — and is painted after the glass in the DOM for the same
      // reason the glass is not painted last: a `backdrop-filter` blurs what is
      // below it, so a mark underneath comes back a smear. The mark is sized
      // from the card's *height* and kept square, anchored right and bled by
      // `--ph-tex-bleed`, so a wide card shows its left portion only: the
      // fragment is the point. `overflow:hidden` hands the cropping to the card
      // edge, which is why nothing here measures anything.
      '.ph-tex{position:absolute;inset:0;z-index:1;pointer-events:none;border-radius:inherit;overflow:hidden;' +
        'display:flex;align-items:center;justify-content:flex-end;' +
        'color:var(--ph-tex-tint,var(--dsw-alias-brand-primary,#5b8cff));opacity:var(--ph-tex-opacity,.05)}',
      '.ph-tex--left{justify-content:flex-start}',
      '.ph-tex--center{justify-content:center}',
      '.ph-tex-mark{flex:none;display:flex;align-items:center;justify-content:center;' +
        'height:var(--ph-tex-size,128%);width:auto;aspect-ratio:1;' +
        'transform:translate(var(--ph-tex-x,0px),var(--ph-tex-y,0px)) rotate(var(--ph-tex-rotate,0deg));' +
        'background-repeat:no-repeat;background-position:center;background-size:contain}',
      '.ph-tex--right .ph-tex-mark{margin-right:var(--ph-tex-bleed,-14%)}',
      '.ph-tex--left .ph-tex-mark{margin-left:var(--ph-tex-bleed,-14%)}',
      // The optional fade belongs to the mark, not to the card: the mark is
      // bled off the anchored edge, so the far edge is the one that would cut
      // the picture inside the card. Masking the mark dissolves exactly that
      // edge; masking the card would leave the picture's hard rectangle. The
      // direction follows the anchor — left-aligned artwork is transparent to
      // the right — and `--ph-tex-fade` is how much of the far side dissolves
      // (0% keeps a hard edge, 100% carries the fade across the whole mark).
      // A centre anchor dissolves both sides.
      '.ph-tex--fade.ph-tex--left .ph-tex-mark{-webkit-mask-image:linear-gradient(to right,#000 calc(100% - var(--ph-tex-fade,55%)),transparent 100%);' +
        'mask-image:linear-gradient(to right,#000 calc(100% - var(--ph-tex-fade,55%)),transparent 100%)}',
      '.ph-tex--fade.ph-tex--right .ph-tex-mark{-webkit-mask-image:linear-gradient(to left,#000 calc(100% - var(--ph-tex-fade,55%)),transparent 100%);' +
        'mask-image:linear-gradient(to left,#000 calc(100% - var(--ph-tex-fade,55%)),transparent 100%)}',
      '.ph-tex--fade.ph-tex--center .ph-tex-mark{-webkit-mask-image:linear-gradient(to right,transparent 0%,#000 var(--ph-tex-fade-half,27.5%),#000 calc(100% - var(--ph-tex-fade-half,27.5%)),transparent 100%);' +
        'mask-image:linear-gradient(to right,transparent 0%,#000 var(--ph-tex-fade-half,27.5%),#000 calc(100% - var(--ph-tex-fade-half,27.5%)),transparent 100%)}',
      // A blended mark must blend with its own card, not the wall behind it.
      // Isolating every card would change what the glass's backdrop filter
      // sees, so only the cards that actually carry a blend are isolated.
      '.ph-shell:has(>.ph-tex--blend),.ph-focus-card:has(>.ph-tex--blend){isolation:isolate}',
      // An icon arrives with its own 16px width/height attributes; CSS wins over
      // those attributes, which is what lets one icon serve both the 16px header
      // slot and a 200px watermark.
      '.ph-tex-mark>*{display:block;width:100%;height:100%}',

      // The specular sweep: a band of light that crosses the glass on hover. Off
      // by default — a band of light IS a gradient — and kept faint for the cards
      // that still ask for it.
      '.ph-sheen{position:absolute;inset:0;pointer-events:none;border-radius:inherit;z-index:1;opacity:0;' +
        'background:linear-gradient(112deg,transparent 34%,color-mix(in srgb,#fff 6%,transparent) 48%,transparent 62%);' +
        'transition:opacity .3s}',

      // The pointer spotlight: a soft pool of the card's own accent that follows
      // the pointer. `--ph-mx/--ph-my` are written straight to the element on
      // pointermove, so the glow never goes through React.
      '.ph-fx-spotlight::before{content:"";position:absolute;inset:0;pointer-events:none;border-radius:inherit;z-index:1;opacity:0;' +
        'background:radial-gradient(240px circle at var(--ph-mx,50%) var(--ph-my,50%),' +
        'color-mix(in srgb,var(--ph-bed,var(--dsw-alias-brand-primary,#5b8cff)) 26%,transparent) 0%,transparent 70%);' +
        'transition:opacity .25s ease-out}',

      '.ph-cell.is-dragging .ph-shell{transform:scale(.98);border-radius:16px;' +
        'box-shadow:0 0 0 1.5px var(--dsw-alias-brand-primary,#4d7cff),var(--dsw-elevation-panel,0 10px 30px -14px rgba(0,0,0,.5))}',

      // Every hover effect lives behind this guard: a touch screen has no hover,
      // and a sticky :hover after a tap is worse than no effect at all.
      '@media (hover: hover) and (pointer: fine){' +
        '.ph-cell.is-hovered .ph-sheen{opacity:1}' +
        '.ph-cell.is-hovered .ph-fx-spotlight::before{opacity:1}' +
        '.ph-cell.is-hovered .ph-shell{box-shadow:var(--dsw-elevation-prominent,0 .5px 0 rgba(255,255,255,.2),0 22px 48px -18px rgba(0,0,0,.6))}}',

      '.ph-bg-layer{position:absolute;inset:0;pointer-events:none;border-radius:inherit}',

      // head
      '.ph-head{display:flex;align-items:center;gap:7px;padding:9px 11px 5px;position:relative;z-index:2}',

      '.ph-card-icon{display:inline-flex;opacity:.85;flex:none}',

      '.ph-card-title{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60%}',

      '.ph-card-subtitle{font-size:10.5px;color:var(--dsw-alias-label-secondary,#9aa4b2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',

      '.ph-head-spacer{flex:1}',

      '.ph-handle{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:0;' +
        'border-radius:6px;background:transparent;color:inherit;cursor:grab;touch-action:none;opacity:0;transition:opacity .15s}',

      '.ph-cell.is-hovered .ph-handle,.ph-handle:focus-visible{opacity:.8}',

      '.ph-handle:active{cursor:grabbing}',

      '.ph-size-controls{display:inline-flex}',

      // body
      '.ph-body{flex:1;min-height:0;overflow:hidden;padding:2px 12px 8px;position:relative;z-index:2}',

      '.ph-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 11px 9px;position:relative;z-index:2}',

      // card content primitives
      '.ph-stat{display:flex;flex-direction:column;gap:1px;min-width:0}',

      '.ph-stat-label{font-size:10.5px;color:var(--dsw-alias-label-secondary,#9aa4b2);white-space:nowrap}',

      '.ph-stat-value{font-size:17px;font-weight:650;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',

      '.ph-stat-hint{font-size:10px;color:var(--dsw-alias-label-secondary,#9aa4b2)}',

      '.ph-row{display:flex;align-items:center;gap:14px}',

      '.ph-row.is-wrap{flex-wrap:wrap}',

      '.ph-divider{height:1px;background:var(--dsw-alias-border-l1,rgba(255,255,255,.09));margin:8px 0}',

      '.ph-chip{display:inline-block;padding:1px 8px;border-radius:999px;font-size:10.5px;font-weight:600;' +
        'background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08));color:var(--dsw-alias-label-secondary,#9aa4b2);white-space:nowrap}',

      // The tint carries the state; the text stays the app's ink. A chip that
      // paints its own label in the state colour is unreadable on a card whose
      // accent is that same colour — the toolchain card's green bed measured as
      // green-on-green. The inset ring keeps the state legible as a mark, so the
      // hue still reads without asking the eye to separate hue from hue.
      '.ph-chip--ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2ea043) 22%,transparent);' +
        'color:var(--dsw-alias-label-primary,#e6e6e6);' +
        'box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--dsw-alias-state-success-primary,#2ea043) 55%,transparent)}',

      '.ph-chip--warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d29922) 22%,transparent);' +
        'color:var(--dsw-alias-label-primary,#e6e6e6);' +
        'box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d29922) 55%,transparent)}',

      '.ph-chip--error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 22%,transparent);' +
        'color:var(--dsw-alias-label-primary,#e6e6e6);' +
        'box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 55%,transparent)}',

      '.ph-inline-empty{font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa4b2);padding:6px 0}',

      '.ph-card-error{font-size:11px;color:var(--dsw-alias-state-error-primary,#e5484d);display:flex;flex-direction:column;gap:4px}',

      '.ph-card-error code{font-size:10px;opacity:.85;white-space:pre-wrap;word-break:break-word}',

      // controls
      '.ph-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',

      '.ph-action{display:inline-flex;align-items:center;gap:6px}',

      '.ph-action-labelled{display:inline-flex;align-items:center;gap:6px}',

      '.ph-action-label{font-size:10.5px;color:var(--dsw-alias-label-secondary,#9aa4b2)}',

      '.ph-btn{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:8px;font-size:11px;font-weight:600;' +
        'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));' +
        'color:var(--dsw-alias-label-primary,#e6e6e6);cursor:pointer;font-family:inherit;transition:background .15s,border-color .15s}',

      '.ph-btn:hover:not(:disabled){background:var(--dsw-alias-bg-overlay,rgba(255,255,255,.12))}',

      '.ph-btn:disabled{opacity:.45;cursor:not-allowed}',

      '.ph-btn--primary{background:var(--dsw-alias-brand-primary,#2b5cff);border-color:transparent;color:#fff}',

      '.ph-btn-icon{display:inline-flex}',

      '.ph-segmented{display:inline-flex;padding:2px;border-radius:9px;gap:2px;' +
        'background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09))}',

      '.ph-segment{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:11px;font-weight:600;' +
        'padding:3px 9px;border-radius:7px;cursor:pointer;font-family:inherit;white-space:nowrap;transition:background .15s,color .15s}',

      '.ph-segment.is-active{background:var(--dsw-alias-bg-overlay,rgba(255,255,255,.14));color:var(--dsw-alias-label-primary,#fff)}',

      '.ph-switch{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:inherit;cursor:pointer;' +
        'font-family:inherit;font-size:11px;padding:0}',

      '.ph-switch-track{width:28px;height:16px;border-radius:999px;position:relative;flex:none;transition:background .18s;' +
        'background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.14));border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16))}',

      '.ph-switch.is-on .ph-switch-track{background:var(--dsw-alias-brand-primary,#2b5cff);border-color:transparent}',

      '.ph-switch-knob{position:absolute;top:1px;left:1px;width:12px;height:12px;border-radius:50%;background:#fff;' +
        'transition:transform .18s cubic-bezier(.2,.8,.3,1)}',

      '.ph-switch.is-on .ph-switch-knob{transform:translateX(12px)}',

      '.ph-switch:disabled{opacity:.45;cursor:not-allowed}',

      '.ph-combo{position:relative;display:inline-flex;align-items:stretch}',

      '.ph-combo-main{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-right:0;border-radius:8px 0 0 8px;' +
        'background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));color:inherit;font-size:11px;font-weight:600;' +
        'padding:3px 9px;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px}',

      '.ph-combo-caret{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:0 8px 8px 0;' +
        'background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));color:inherit;font-size:10px;padding:3px 6px;cursor:pointer}',

      '.ph-combo-main:hover,.ph-combo-caret:hover{background:var(--dsw-alias-bg-overlay,rgba(255,255,255,.12))}',

      // Every popover lives in one portal layer so a menu is never clipped by the
      // card it belongs to. The layer itself is inert — only its content takes
      // the pointer, which is what lets an outside press reach the wall and
      // dismiss the menu.
      '.ph-popover-layer{position:fixed;inset:0;z-index:200;pointer-events:none}',
      '.ph-popover-layer>*{pointer-events:auto}',

      '.ph-combo-menu{position:fixed;z-index:1;min-width:130px;padding:5px;border-radius:12px;' +
        'background:var(--dsw-alias-bg-overlay,#1c1f26);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));' +
        'box-shadow:0 16px 38px rgba(0,0,0,.42);display:flex;flex-direction:column}',

      '.ph-combo-item{text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-primary,#e6e6e6);' +
        'font-size:11.5px;padding:5px 8px;border-radius:7px;cursor:pointer;font-family:inherit}',

      '.ph-combo-item:hover{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.1))}',

      '.ph-combo-item.is-active{color:var(--dsw-alias-brand-primary,#7fa2ff);font-weight:700}',

      '.ph-stepper{display:inline-flex;align-items:center;gap:2px;border-radius:8px;padding:1px;' +
        'background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09))}',

      '.ph-stepper-btn{width:17px;height:17px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;' +
        'font-size:12px;line-height:1;font-family:inherit}',

      '.ph-stepper-btn:hover:not(:disabled){background:var(--dsw-alias-bg-overlay,rgba(255,255,255,.14))}',

      '.ph-stepper-btn:disabled{opacity:.35;cursor:not-allowed}',

      '.ph-stepper-value{font-size:10.5px;font-variant-numeric:tabular-nums;min-width:24px;text-align:center}',

      '.ph-field{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11.5px;padding:3px 0}',

      '.ph-field-label{color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      // the body takes the rest of the row, so a text field in a field row
      // spans what is left instead of collapsing to its content
      '.ph-field-body{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;justify-content:flex-end}',

      // a text setting: the value is a path or a name, so it needs to be
      // selectable and read at a glance — a filled box, monospaced on request
      '.ph-input{flex:1 1 auto;min-width:0;box-sizing:border-box;padding:4px 9px;border-radius:8px;font:inherit;' +
        'font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary,#e6e6e6);outline:none;' +
        'border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#e6e6e6) 18%,transparent);' +
        'background:color-mix(in srgb,var(--dsw-alias-label-primary,#e6e6e6) 6%,transparent)}',
      '.ph-input::placeholder{color:var(--dsw-alias-label-tertiary,#9aa4b2)}',
      '.ph-input:focus{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8cff) 70%,transparent);' +
        'box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8cff) 22%,transparent)}',
      '.ph-input:disabled{opacity:.5}',

      // the DSH card's one-line verdict: a link, because clicking it expands the
      // card, and a link that does nothing visible on hover reads as text
      '.ph-dsh-state{font-size:11.5px;text-decoration:none}',
      '.ph-dsh-state:hover{text-decoration:underline}',
      '.ph-dsh-state.is-new{color:var(--dsw-alias-state-warning-primary,#d29922)}',
      '.ph-dsh-ok{color:var(--dsw-alias-state-success-primary,#2ea043)}',
      '.ph-dsh-fail{color:var(--dsw-alias-state-error-primary,#f85149)}',

      '.ph-link{border:0;background:transparent;color:var(--dsw-alias-brand-primary,#7fa2ff);cursor:pointer;font-size:11px;' +
        'font-family:inherit;padding:0;text-decoration:underline}',

      // bubbles: an annunciator pill in the card's top-right corner
      '.ph-bubble{display:inline-flex;align-items:center;gap:4px;border:0;border-radius:999px;font-size:9.5px;' +
        'font-weight:700;padding:2px 7px 2px 5px;cursor:pointer;font-family:inherit;line-height:1.5;' +
        'color:var(--ph-notice,#fff);' +
        'background:color-mix(in srgb,var(--ph-notice,#888) 22%,transparent);' +
        'box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--ph-notice,#888) 55%,transparent);' +
        'transition:background .16s}',
      '.ph-bubble:hover{background:color-mix(in srgb,var(--ph-notice,#888) 34%,transparent)}',
      '.ph-bubble-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--ph-notice,#888);' +
        'box-shadow:0 0 0 2.5px color-mix(in srgb,var(--ph-notice,#888) 26%,transparent)}',
      '.ph-bubble-count{font-variant-numeric:tabular-nums}',

      // the notice panel: the card's live notices, in the portal layer
      '.ph-notice-panel{width:252px;max-height:260px;overflow:auto;padding:7px;border-radius:16px;' +
        'background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-overlay,#1c1f26));' +
        'box-shadow:var(--dsw-elevation-panel,0 .5px 0 rgba(255,255,255,.14),0 14px 34px -10px rgba(0,0,0,.5));' +
        'backdrop-filter:var(--dsw-menu-backdrop-filter,blur(22px) saturate(160%));' +
        'display:flex;flex-direction:column;gap:2px}',
      '.ph-notice-head{display:flex;align-items:center;gap:6px;padding:1px 4px 5px}',
      '.ph-notice-title{flex:1;font-size:10.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;' +
        'color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      '.ph-notice-clear{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9aa4b2);cursor:pointer;' +
        'font-size:10.5px;font-family:inherit;padding:2px 5px;border-radius:7px}',
      '.ph-notice-clear:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 9%,transparent);' +
        'color:var(--dsw-alias-label-primary,#e6e6e6)}',
      '.ph-notice-row{display:flex;align-items:flex-start;gap:7px;font-size:11.5px;padding:5px 6px;border-radius:10px}',
      '.ph-notice-row:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 7%,transparent)}',
      '.ph-notice-mark{width:7px;height:7px;border-radius:50%;margin-top:4px;flex:none;background:var(--ph-notice,#888);' +
        'box-shadow:0 0 0 2.5px color-mix(in srgb,var(--ph-notice,#888) 24%,transparent)}',
      '.ph-notice-text{flex:1;word-break:break-word;line-height:1.45}',
      '.ph-notice-x{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9aa4b2);cursor:pointer;' +
        'display:inline-flex;align-items:center;justify-content:center;padding:2px;border-radius:6px}',
      '.ph-notice-x:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 12%,transparent);color:inherit}',
      '.ph-notice-more{font-size:10.5px;color:var(--dsw-alias-label-secondary,#9aa4b2);padding:3px 6px 1px;text-align:center}',

      // toasts
      '.ph-toasts{position:absolute;right:16px;bottom:16px;display:flex;flex-direction:column;gap:7px;z-index:90;pointer-events:none}',

      '.ph-toast{display:flex;align-items:center;gap:7px;font-size:11.5px;padding:7px 11px;border-radius:10px;' +
        'background:var(--dsw-alias-bg-overlay,#1c1f26);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));' +
        'box-shadow:0 10px 26px rgba(0,0,0,.4);animation:ph-toast-in .2s ease}',

      '.ph-toast-dot{width:7px;height:7px;border-radius:50%;flex:none}',

      '@keyframes ph-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',

      // empty + host error
      '.ph-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;' +
        'text-align:center;color:var(--dsw-alias-label-secondary,#9aa4b2);padding:20px}',

      '.ph-empty h3{margin:0;font-size:14px;color:var(--dsw-alias-label-primary,#e6e6e6)}',

      '.ph-empty p{margin:0;font-size:12px;max-width:420px;line-height:1.55}',

      '.ph-empty-icon{opacity:.4}',

      '.ph-empty-code{text-align:left;font-size:10.5px;line-height:1.5;padding:11px 13px;border-radius:10px;max-width:100%;' +
        'white-space:pre-wrap;overflow-wrap:anywhere;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));' +
        'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09));color:var(--dsw-alias-label-secondary,#9aa4b2)}',

      '.ph-host-error{font-size:11px;color:var(--dsw-alias-state-warn-primary,#d29922)}',

      // hero: the one-glance reading a preview shows
      '.ph-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;height:100%;' +
        'padding:2px 2px 4px;min-width:0}',
      '.ph-hero--wait{flex-direction:column;align-items:flex-start;justify-content:center;gap:3px}',
      '.ph-hero-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:none}',
      '.ph-hero-side{display:flex;flex-direction:column;align-items:flex-end;gap:1px;min-width:0;text-align:right;flex:none}',
      // The chip row is the card's last child and may hold more chips than a
      // narrow card has width for, so it wraps and stays right-aligned rather
      // than running under the neighbour or forcing the hero values to shrink.
      '.ph-hero-row{display:flex;align-items:center;gap:7px;min-width:0;flex-wrap:wrap;justify-content:flex-end}',
      // A dim label that leads a right-aligned row: the chips keep the right
      // edge, the label takes whatever is left of it.
      '.ph-row-lead{margin-right:auto}',

      // A card whose value IS its readings (a version per tool) does not want a
      // big number: it wants a spec list. Two columns at a card's usual width
      // and one when it is narrow (190px is a name plus the longest version
      // with room to spare, so the columns never squeeze), and the name column
      // is a fixed width so the versions line up instead of ragging.
      '.ph-specs{display:flex;flex-direction:column;justify-content:space-between;gap:6px;height:100%;min-width:0;padding:2px 2px 4px}',
      '.ph-spec-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));' +
        'gap:3px 16px;align-content:center;min-width:0}',
      '.ph-spec{display:flex;align-items:baseline;gap:8px;min-width:0}',
      '.ph-spec-name{flex:0 0 auto;min-width:54px;font-size:11px;' +
        'color:var(--dsw-alias-label-secondary,#9aa4b2);white-space:nowrap}',
      '.ph-spec-value{font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ph-spec-value--error{color:var(--dsw-alias-state-error-primary,#e5484d);font-weight:500}',
      '.ph-spec-value--warn{color:var(--dsw-alias-state-warn-primary,#d29922);font-weight:500}',
      '.ph-spec-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-width:0;font-size:11px;' +
        'color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      '.ph-spec-warn{color:var(--dsw-alias-state-warn-primary,#d29922)}',

      // A meter row is a reading with a ceiling: name, share as a percentage,
      // then the share as a bar at the far right. The bar is a tint, so the
      // state colour is allowed to live there — the percentage stays ink, the
      // same rule the status chips follow. `data-tone` is only set when the
      // reading is actually under pressure, so a calm bar keeps the card's own
      // brand colour instead of turning the whole stack green.
      '.ph-meters{display:flex;flex-direction:column;gap:7px;min-width:0}',
      '.ph-meter{display:flex;align-items:center;gap:10px;min-width:0}',
      '.ph-meter-name{flex:0 0 auto;min-width:56px;font-size:11.5px;' +
        'color:var(--dsw-alias-label-secondary,#9aa4b2);white-space:nowrap}',
      '.ph-meter-value{flex:0 0 auto;margin-left:auto;font-size:12.5px;font-weight:600;' +
        'font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.ph-meter-bar{flex:0 0 auto;position:relative;width:64px;height:6px;border-radius:999px;' +
        'overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e6e6e6) 13%,transparent)}',
      '.ph-meter-fill{display:block;height:100%;border-radius:inherit;' +
        'background:var(--dsw-alias-brand-primary,#7fa2ff)}',
      '.ph-meter[data-tone="warn"] .ph-meter-fill{background:var(--dsw-alias-state-warn-primary,#d29922)}',
      '.ph-meter[data-tone="error"] .ph-meter-fill{background:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.ph-hero-value{font-size:30px;font-weight:600;letter-spacing:-.03em;line-height:1.08;' +
        'font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
      '.ph-hero-value--sm{font-size:18px;font-weight:600}',
      '.ph-hero-value--accent{color:var(--dsw-alias-brand-primary,#7fa2ff)}',
      '.ph-hero-value--ok{font-size:20px;color:var(--dsw-alias-state-success-primary,#2ea043)}',
      // An address is the one value in the panel that has to be read character by
      // character — `127.0.0.1:7890` in a proportional face hides typos — so it
      // gets the monospace stack and tabular figures.
      '.ph-hero-value--mono{font-family:' + MONO_FONT + ';font-size:19px;font-weight:600;' +
        'font-variant-numeric:tabular-nums;letter-spacing:-.02em}',
      '.ph-hero-label{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b2);white-space:nowrap;' +
        'overflow:hidden;text-overflow:ellipsis;max-width:100%}',
      '.ph-hero-label--error{color:var(--dsw-alias-state-error-primary,#e5484d)}',

      // focus: the expanded card, floating over the wall.
      '.ph-focus-layer{position:absolute;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:4px}',

      '.ph-focus-card{position:relative;display:flex;flex-direction:column;max-width:100%;max-height:100%;' +
        'min-height:min(340px,100%);' +
        'border-radius:26px;overflow:hidden;transform-origin:top left;' +
        // A step more opaque than a preview card: the wall behind is blurred,
        // and it has to stay a backdrop instead of competing with the content.
        'background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#15171c) 58%,transparent);' +
        'box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l1,rgba(127,132,140,.22)),' +
        'var(--dsw-elevation-prominent,0 .5px 0 rgba(255,255,255,.2),0 30px 70px -24px rgba(0,0,0,.62));' +
        'animation:ph-grow .36s cubic-bezier(.2,.82,.24,1) both}',

      // One card growing out of another: the first frame is the source card's
      // own rectangle (`--ph-fd*` / `--ph-fsx` measured on click), the last is
      // the pane's resting box.
      '@keyframes ph-grow{from{opacity:.28;border-radius:22px;' +
        'transform:translate3d(var(--ph-fdx,0px),var(--ph-fdy,0px),0) scale(var(--ph-fsx,.84))}' +
        'to{opacity:1;border-radius:26px;transform:translate3d(0,0,0) scale(1)}}',

      // The sheen is a hover affordance on the wall; on the pane it is part of
      // the material.
      '.ph-sheen.is-on{opacity:1}',

      '.ph-focus-head{display:flex;align-items:center;gap:10px;padding:16px 20px 8px;position:relative;z-index:2}',

      '.ph-focus-titles h2{margin:0;font-size:17px;font-weight:650;letter-spacing:-.01em}',

      '.ph-focus-titles p{margin:1px 0 0;font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa4b2)}',

      '.ph-back{display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:999px;font-size:11.5px;font-weight:600;' +
        'border:0;background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 10%,transparent);' +
        'color:inherit;cursor:pointer;font-family:inherit;transition:background .16s}',
      '.ph-back:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 18%,transparent)}',

      '.ph-focus-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:2px 20px 12px;position:relative;z-index:2}',

      // The expanded body is the only part of the focus card that may overflow:
      // the title and the toolbar stay put and the content scrolls under them.
      // `overflow:hidden` clipped a long card (the toolchain's sixteen rows)
      // against the panel edge with no way to reach the rest of it.
      '.ph-focus-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;' +
        'scrollbar-gutter:stable;padding:6px 20px 22px;position:relative;z-index:2}',

      '.ph-detail-default{font-size:13px}',

      // sidebar icon
      '.ph-sidebar-icon{display:inline-flex;align-items:center;justify-content:center;width:100%;height:100%;opacity:.78;transition:opacity .15s}',

      '.ph-sidebar-icon.is-active,.ph-sidebar-icon:hover{opacity:1}',

      // bars
      '.ph-bars{display:flex;align-items:flex-end;gap:3px}',

      '.ph-bar{flex:1;min-width:3px;border-radius:3px 3px 2px 2px;position:relative;' +
        'background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2b5cff) 34%,transparent);transition:background .15s}',

      '.ph-bar:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2b5cff) 70%,transparent)}',

      '.ph-bar.is-highlight{background:var(--dsw-alias-brand-primary,#2b5cff)}',

      '.ph-bar-fill{display:none}',

      // effects
      '.ph-fx-outline{position:relative}',

      '.ph-fx-outline::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:2px;pointer-events:none;z-index:3;' +
        'background:conic-gradient(from var(--ph-angle,0deg),transparent 0deg,' +
        'color-mix(in srgb,var(--ph-bed,var(--dsw-alias-brand-primary,#2b5cff)) 100%,transparent) 85deg,transparent 160deg,' +
        'transparent 360deg);' +
        '-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;' +
        'mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude;' +
        'animation:ph-fx-rotate 3s linear infinite}',

      '@property --ph-angle{syntax:"<angle>";inherits:false;initial-value:0deg}',

      '@keyframes ph-fx-rotate{to{--ph-angle:360deg}}',

      '.ph-fx-glow{animation:ph-fx-breathe 3.4s ease-in-out infinite}',

      '@keyframes ph-fx-breathe{0%,100%{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ph-bed,#7fa2ff) 20%,transparent),0 3px 12px #00000012}' +
        '50%{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ph-bed,#7fa2ff) 60%,transparent),0 0 28px 3px color-mix(in srgb,var(--ph-bed,#7fa2ff) 35%,transparent)}}',

      '.ph-fx-float{animation:ph-fx-float 5.5s ease-in-out infinite}',

      '@keyframes ph-fx-float{0%,100%{translate:0 0}50%{translate:0 -7px}}',

      '.ph-fx-scan::before{content:"";position:absolute;top:0;left:-60%;width:45%;height:100%;pointer-events:none;' +
        'z-index:1;background:linear-gradient(105deg,transparent,color-mix(in srgb,var(--ph-bed,#7fa2ff) 24%,transparent),rgba(255,255,255,.26),transparent);animation:ph-fx-scan 3s ease-in-out infinite}',

      '@keyframes ph-fx-scan{0%{left:-60%}55%{left:120%}100%{left:120%}}',

      '.ph-fx-sheen::before{content:"";position:absolute;inset:0;pointer-events:none;' +
        'background:linear-gradient(160deg,rgba(255,255,255,.1),transparent 45%)}',

      '.ph-fx-ripple{overflow:hidden}',

      '.ph-fx-ripple:active::after{content:"";position:absolute;left:var(--ph-ripple-x,50%);top:var(--ph-ripple-y,50%);' +
        'width:8px;height:8px;border-radius:50%;pointer-events:none;transform:translate(-50%,-50%);' +
        'background:radial-gradient(circle,color-mix(in srgb,var(--dsw-alias-brand-primary,#2b5cff) 55%,transparent),transparent 70%);' +
        'animation:ph-fx-ripple .55s ease-out}',

      '@keyframes ph-fx-ripple{from{opacity:.85;width:8px;height:8px}to{opacity:0;width:220px;height:220px}}',

      'body.ph-dragging{cursor:grabbing;user-select:none}',

      // Modern arrangement and design tools, shared by tiles and detail panes.
      '.ph-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
      '.ph-arrange-toggle{display:inline-flex;align-items:center;gap:7px;padding:8px 13px;border-radius:11px;border:1px solid transparent;' +
        'background:color-mix(in srgb,currentColor 5%,transparent);color:inherit;font:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:background .2s,border-color .2s}',
      '.ph-arrange-toggle:hover{background:color-mix(in srgb,currentColor 9%,transparent)}',
      '.ph-arrange-toggle.is-active{background:var(--dsw-alias-brand-primary,#7fa2ff);color:var(--dsw-alias-bg-base,#111318);box-shadow:0 3px 12px #00000014}',
      '.ph-toolbar{padding:3px 0 6px}.ph-toolbar-title{font-size:18px;letter-spacing:-.035em}.ph-toolbar-tools{gap:8px}',
      '.ph-arrangement-bar{display:flex;align-items:center;gap:12px;flex:none;width:100%;max-width:var(--ph-max);box-sizing:border-box;margin:0 auto;padding:12px 15px;' +
        'border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#7fa2ff) 7%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#7fa2ff) 18%,transparent)}',
      '.ph-arrangement-mark{display:grid;place-items:center;color:var(--dsw-alias-brand-primary,#7fa2ff)}',
      '.ph-arrangement-bar strong{font-size:12px;font-weight:650}.ph-arrangement-bar p{margin:3px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      '.ph-panel.is-arranging .ph-stage{overflow:auto;padding:4px;scrollbar-width:thin}.ph-grid.is-arranging{grid-auto-flow:row}',
      '.ph-cell.is-arranging .ph-shell{box-shadow:inset 0 0 0 1px color-mix(in srgb,currentColor 16%,transparent);border-radius:18px;transform:none!important;animation:none}',
      '.ph-cell.is-arranging .ph-shell::before,.ph-cell.is-arranging .ph-shell::after{animation:none;opacity:0}',
      '.ph-cell.is-designing .ph-shell{box-shadow:inset 0 0 0 2px var(--dsw-alias-brand-primary,#7fa2ff),0 6px 20px #0000000a}',
      '.ph-cell.is-dragging{opacity:1;outline-offset:-2px;outline:2px dashed color-mix(in srgb,var(--dsw-alias-brand-primary,#7fa2ff) 48%,transparent);border-radius:20px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#7fa2ff) 7%,transparent)}',
      '.ph-cell.is-dragging>*{visibility:hidden}',
      '.ph-drag-preview{position:fixed;z-index:1000;display:flex;flex-direction:column;pointer-events:none!important;margin:0;box-sizing:border-box;will-change:transform;contain:layout style}',
      '.ph-drag-preview>.ph-shell{flex:1;min-height:0;transform:none!important;translate:none!important;scale:1!important;animation:none!important;transition:none!important;border-radius:20px;background:var(--dsw-alias-bg-layer-1,#15171c);box-shadow:0 24px 60px -12px #00000055,0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary,#7fa2ff) 55%,transparent)}',
      '.ph-drag-preview .ph-handle{visibility:visible}.ph-drag-preview .ph-shell:before,.ph-drag-preview .ph-shell:after{animation:none!important}',
      '.ph-cell.is-arranging .ph-head{cursor:grab}.ph-layout-rank{font-size:10px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      '.ph-handle{min-width:28px;min-height:28px!important;touch-action:none}',
      '.ph-layout-controls{position:relative;z-index:2;display:flex;align-items:center;gap:4px;padding:8px 10px;margin-top:3px;border-top:1px solid color-mix(in srgb,currentColor 7%,transparent)}',
      '.ph-layout-design{display:flex;align-items:center;gap:6px;border:0;background:transparent;color:inherit;font:inherit;font-size:11px;cursor:pointer;padding:6px;border-radius:7px}',
      '.ph-layout-design>span{font-size:10px;opacity:.6;font-variant-numeric:tabular-nums}.ph-layout-design[aria-pressed=true]{color:var(--dsw-alias-brand-primary,#7fa2ff)}',
      '.ph-layout-design:hover,.ph-layout-nudge:hover:not(:disabled){background:color-mix(in srgb,currentColor 7%,transparent)}',
      '.ph-layout-nudge{width:29px;height:29px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer}',
      '.ph-layout-nudge:disabled{opacity:.3;cursor:default}',
      '.ph-open-card{display:grid;place-items:center;width:25px;height:25px;border:0;border-radius:7px;background:color-mix(in srgb,currentColor 5%,transparent);color:inherit;cursor:pointer;opacity:0;transition:opacity .2s,background .2s}',
      '.ph-shell:hover .ph-open-card,.ph-shell:focus-within .ph-open-card{opacity:.8}.ph-open-card:hover{opacity:1;background:color-mix(in srgb,currentColor 12%,transparent)}',
      '@media(hover:none){.ph-open-card{opacity:.7}}',
      '.ph-layout-inspector{flex:none;max-height:48%;overflow:auto;width:100%;max-width:var(--ph-max);margin:0 auto;box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 12%,transparent);' +
        'border-radius:17px;background:var(--dsw-alias-bg-layer-1,#17191e);scrollbar-width:thin;animation:ph-toast-in .22s ease}',
      '.ph-inspector-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid color-mix(in srgb,currentColor 7%,transparent);font-size:12px}',
      '.ph-card-design{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:24px;padding:16px 18px}',
      '.ph-design-section{min-width:0}.ph-design-heading{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:12px;font-size:12px}',
      '.ph-design-heading>span{font-size:10px;color:var(--dsw-alias-label-secondary,#9aa4b2);font-variant-numeric:tabular-nums}',
      '.ph-size-presets{display:grid;grid-template-columns:repeat(auto-fit,minmax(52px,1fr));gap:6px}',
      '.ph-size-preset,.ph-motion-preset{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;min-width:0;padding:10px 4px;' +
        'border:1px solid color-mix(in srgb,currentColor 11%,transparent);border-radius:10px;background:transparent;color:inherit;font:inherit;font-size:10px;cursor:pointer;transition:background .18s,border-color .18s}',
      '.ph-size-preset:hover,.ph-motion-preset:hover{background:color-mix(in srgb,currentColor 4%,transparent)}',
      '.ph-size-preset.is-active,.ph-motion-preset.is-active{border-color:var(--dsw-alias-brand-primary,#7fa2ff);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#7fa2ff) 8%,transparent);color:var(--dsw-alias-brand-primary,#7fa2ff)}',
      '.ph-size-schematic{height:30px;display:flex;align-items:center;justify-content:center;width:100%}.ph-size-schematic i{display:block;border:1.5px solid currentColor;border-radius:4px;background:color-mix(in srgb,currentColor 12%,transparent)}',
      '.ph-design-custom-size{display:flex;align-items:center;gap:10px;margin-top:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:10px}',
      '.ph-design-custom-size label{display:flex;align-items:center;gap:7px}.ph-design-custom-size input{width:46px;padding:5px 3px 5px 7px;font:inherit;font-size:11px;color:var(--dsw-alias-label-primary,#e6e6e6);' +
        'border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:7px;background:var(--dsw-alias-bg-layer-2,#1e2126)}',
      '.ph-motion-presets{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px}',
      '.ph-motion-sample{position:relative;display:grid;place-items:center;width:34px;height:24px;overflow:hidden;border-radius:7px;background:var(--dsw-alias-bg-layer-2,#1e2126);' +
        'box-shadow:inset 0 0 0 1px color-mix(in srgb,currentColor 15%,transparent);color:var(--ph-bed,var(--dsw-alias-brand-primary,#7fa2ff))}',
      '.ph-motion-sample i{display:block;width:14px;height:3px;opacity:.4;border-radius:5px;background:currentColor}',
      '.ph-motion-preset:not(:hover):not(.is-active) .ph-motion-sample,.ph-motion-preset:not(:hover):not(.is-active) .ph-motion-sample::before,.ph-motion-preset:not(:hover):not(.is-active) .ph-motion-sample::after{animation-play-state:paused}',
      '.ph-motion-sample.ph-fx-spotlight::before{opacity:1;background:radial-gradient(circle at 65% 40%,color-mix(in srgb,var(--ph-bed,#7fa2ff) 65%,transparent),transparent 75%)}',
      '.ph-motion-sample.ph-fx-glow{overflow:visible}.ph-design-description{min-height:15px;margin:10px 0 0;font-size:10px;color:var(--dsw-alias-label-secondary,#9aa4b2);line-height:1.5}',
      '.ph-motion-trigger{display:inline-flex;gap:3px;padding:3px;border-radius:8px;background:color-mix(in srgb,currentColor 5%,transparent);margin-top:10px}',
      '.ph-motion-trigger button{padding:5px 9px;font:inherit;font-size:10px;cursor:pointer;border:0;border-radius:6px;background:transparent;color:inherit}',
      '.ph-motion-trigger .is-active{background:var(--dsw-alias-bg-layer-1,#17191e);box-shadow:0 1px 4px #00000012}',
      '.ph-motion-hover:not(:hover):not(:focus-within),.ph-motion-hover:not(:hover):not(:focus-within)::before,.ph-motion-hover:not(:hover):not(:focus-within)::after{animation:none;opacity:1}',
      '.ph-motion-hover.ph-fx-scan:not(:hover):not(:focus-within)::before,.ph-motion-hover.ph-fx-outline:not(:hover):not(:focus-within)::after{opacity:0}',
      '.ph-focus-design{position:relative;z-index:2;margin:0 22px 10px;flex:none;max-height:40vh;overflow:auto;border:1px solid color-mix(in srgb,currentColor 9%,transparent);border-radius:12px;scrollbar-width:thin}',
      '.ph-focus-design summary{display:flex;align-items:center;gap:7px;padding:9px 12px;cursor:pointer;list-style:none;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b2);user-select:none}',
      '.ph-focus-design summary::-webkit-details-marker{display:none}.ph-focus-design summary>span{margin-left:auto;font-size:10px;font-variant-numeric:tabular-nums}.ph-focus-design[open] summary{border-bottom:1px solid color-mix(in srgb,currentColor 7%,transparent)}',
      '.ph-focus-design[open] summary>svg:last-child{rotate:180deg}.ph-focus-toolbar:empty{display:none}',
      '.ph-focus-head{padding:22px 24px 14px;gap:13px}.ph-focus-head>.ph-card-icon{display:grid;place-items:center;width:42px;height:42px;border-radius:13px;background:color-mix(in srgb,var(--ph-bed,#7fa2ff) 12%,transparent);color:var(--ph-bed,#7fa2ff)}',
      '.ph-focus-context{display:block;font-size:10px;color:var(--dsw-alias-label-secondary,#9aa4b2);margin-bottom:3px;letter-spacing:.02em}.ph-focus-titles{min-width:0}',
      '.ph-focus-titles h2{font-size:21px;font-weight:650;letter-spacing:-.035em;overflow-wrap:anywhere}',
      '.ph-focus-escape{font:inherit;font-size:9px;padding:3px 5px;border-radius:5px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      '.ph-back{display:grid;place-items:center;padding:0;width:32px;height:32px;border-radius:10px;flex:none}',
      '.ph-focus-toolbar{gap:10px;padding:0 24px 13px}.ph-focus-body{padding:8px 24px 24px;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,currentColor 22%,transparent) transparent}',
      '.ph-focus-card{max-width:1080px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#15171c) 94%,transparent);border-radius:24px}',
      '.ph-focus-card>.ph-tex{opacity:calc(var(--ph-tex-opacity,.05)*.25)}.ph-focus-card>.ph-glass{backdrop-filter:blur(26px) saturate(125%)}',
      '.ph-focus-body>.ph-section{padding:15px;border-radius:14px;background:color-mix(in srgb,currentColor 3%,transparent)}',
      '.ph-focus-body .ph-table{border-collapse:separate;border-spacing:0}.ph-focus-body .ph-table th{position:sticky;top:0;background:var(--dsw-alias-bg-layer-1,#17191e);z-index:1}',
      '.ph-arrange-toggle:focus-visible,.ph-layout-controls button:focus-visible,.ph-card-design button:focus-visible,.ph-card-design input:focus-visible,.ph-focus-design summary:focus-visible,.ph-open-card:focus-visible,.ph-back:focus-visible{' +
        'outline:2px solid var(--dsw-alias-brand-primary,#7fa2ff);outline-offset:3px}',
      '@media(max-width:800px){.ph-card-design{grid-template-columns:1fr;gap:18px}.ph-focus-head{padding:16px;gap:9px}.ph-focus-titles h2{font-size:18px}' +
        '.ph-focus-body{padding:6px 16px 18px}.ph-focus-toolbar{padding:0 16px 10px}.ph-focus-design{margin:0 16px 10px}.ph-focus-escape{display:none}.ph-arrangement-bar p{max-width:280px}}',
      '@media(max-width:480px){.ph-motion-presets{grid-template-columns:repeat(3,minmax(0,1fr))}.ph-toolbar-title{font-size:16px}.ph-toolbar-tools{margin-left:0}.ph-layout-inspector{max-height:55%}}',

      // card content layout
      // `display:contents` keeps the style sheets out of the layout, so the
      // panel is a direct child of the host's column and inherits its face.
      '.ph-root{display:contents}',

      '.ph-token-stat{display:flex;align-items:flex-end;justify-content:space-between;gap:12px}',

      '.ph-token-stat .ph-stat:last-child{text-align:right;align-items:flex-end}',

      '.ph-network{display:flex;flex-direction:column;gap:6px}',

      '.ph-network-chips{display:flex;gap:5px;flex-wrap:wrap}',

      '.ph-calendar{display:flex;flex-direction:column;gap:8px;height:100%}',

      // The preview holds the date and nothing else, so it centres rather than
      // pinning one line to the top of a 196px card.
      '.ph-calendar--solo{justify-content:center;gap:0}',

      '.ph-calendar-head{display:flex;align-items:baseline;gap:9px}',

      '.ph-calendar-day{font-size:32px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}',

      '.ph-calendar-meta{display:flex;flex-direction:column;min-width:0}',

      '.ph-calendar-weekday{font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa4b2)}',

      '.ph-calendar-weekstrip{display:flex;gap:3px}',

      '.ph-calendar-wd{flex:1;text-align:center;font-size:10px;padding:3px 0;border-radius:6px;' +
        'color:var(--dsw-alias-label-secondary,#9aa4b2);background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05))}',

      '.ph-calendar-wd.is-today{background:var(--dsw-alias-brand-primary,#2b5cff);color:#fff;font-weight:700}',

      '.ph-calendar-chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:auto}',

      '.ph-axis{display:flex;font-size:10px;color:var(--dsw-alias-label-secondary,#9aa4b2);margin-top:3px}',

      // detail blocks
      '.ph-detail-block{display:flex;flex-direction:column;gap:10px;font-size:12.5px;max-width:1000px}',

      '.ph-detail-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px}',

      '.ph-detail-stats--tight{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}',

      '.ph-section-head{display:flex;align-items:center;gap:9px}',

      '.ph-section-head h4,.ph-section-title{margin:0;font-size:12.5px;font-weight:650}',

      '.ph-section-title{margin-bottom:2px}',

      '.ph-kv{display:flex;flex-direction:column;gap:4px}',

      '.ph-kv-row{display:flex;gap:12px;align-items:baseline;padding:3px 0;' +
        'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}',

      '.ph-kv-key{flex:0 0 130px;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b2);word-break:break-word}',

      '.ph-kv-value{flex:1;font-size:11.5px;word-break:break-word}',

      '.ph-mono{font-family:' + MONO_FONT + ';font-size:11px;' +
        'font-variant-numeric:tabular-nums;letter-spacing:0}',

      '.ph-break{word-break:break-all}',

      '.ph-pre{margin:0;padding:9px 11px;border-radius:9px;font-size:11px;line-height:1.5;overflow:auto;white-space:pre-wrap;' +
        'word-break:break-all;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));' +
        'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09))}',

      '.ph-note{margin:0;font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary,#9aa4b2)}',

      // A finding is what the user came to read, so it does not use the note size,
      // and its head is a real button (the whole row folds it) so the list can be
      // read and opened from the keyboard.
      '.ph-audit-findings{display:flex;flex-direction:column;gap:6px}',
      '.ph-audit-finding{border-radius:9px;overflow:hidden;' +
        'background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));' +
        'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}',
      '.ph-audit-finding-head{display:flex;align-items:center;gap:8px;width:100%;margin:0;padding:7px 9px;' +
        'border:0;background:transparent;color:inherit;font-family:inherit;font-size:13px;font-weight:600;' +
        'text-align:left;cursor:pointer}',
      '.ph-audit-finding-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ph-audit-finding-tag{flex:none;font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;' +
        'background:var(--dsw-alias-interactive-bg,rgba(255,255,255,.07));color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      '.ph-audit-finding-more{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.ph-audit-finding-body{display:flex;flex-direction:column;gap:7px;padding:0 9px 9px}',
      '.ph-audit-finding-detail{margin:0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.ph-audit-risk{display:flex;flex-direction:column;gap:4px;padding:7px 9px;border-radius:8px;' +
        'background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03));' +
        'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07))}',
      '.ph-audit-risk-row{display:flex;gap:8px;margin:0;font-size:12px;line-height:1.55}',
      '.ph-audit-risk-key{flex:0 0 62px;font-weight:600;color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      '.ph-audit-risk-value{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary,#e6e8ea);word-break:break-word}',
      '.ph-audit-risk-missing{margin:0;font-size:12px;line-height:1.55;color:var(--dsw-alias-state-warn-primary,#d29922)}',
      '.ph-audit-finding-ref{margin:0;font-family:' + MONO_FONT + ';font-size:11px;word-break:break-all;' +
        'color:var(--dsw-alias-label-tertiary,#81858c)}',
      '@media (hover: hover) and (pointer: fine){' +
        '.ph-audit-finding-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}}',

      '.ph-links{display:flex;gap:14px;flex-wrap:wrap}',

      '.ph-table{display:flex;flex-direction:column;font-size:11.5px}',

      '.ph-table-row{display:grid;grid-template-columns:150px minmax(140px,2fr) 130px 60px 70px;gap:10px;align-items:center;' +
        'padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}',

      '.ph-table-head{font-size:10.5px;color:var(--dsw-alias-label-secondary,#9aa4b2);font-weight:600}',

      '.ph-table-name{display:flex;align-items:center;gap:5px;font-weight:600;word-break:break-word}',

      // toolchain list: the tool, then its version over the path that wins
      '.ph-tools{display:flex;flex-direction:column}',

      '.ph-tool{display:grid;grid-template-columns:minmax(84px,auto) minmax(0,1fr) auto;gap:10px;' +
        'align-items:baseline;padding:5px 0;' +
        'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}',

      '.ph-tool:last-child{border-bottom:0}',

      '.ph-tool-name{font-size:12px;font-weight:600;word-break:break-word}',

      // Two chips in one grid cell: a fourth child would be placed on a new
      // grid row and break the column alignment of the list.
      '.ph-tool-tags{display:flex;align-items:center;gap:6px;justify-content:flex-end;flex-wrap:wrap}',

      '.ph-tool-facts{display:flex;flex-direction:column;gap:1px;min-width:0}',

      '.ph-tool-version{font-size:11.5px;word-break:break-word}',

      '.ph-tool-path{font-family:' + MONO_FONT + ';font-size:10.5px;' +
        'color:var(--dsw-alias-label-secondary,#9aa4b2);word-break:break-all}',

      // calendar grid
      '.ph-cal-toolbar{display:flex;align-items:center;gap:8px}',

      '.ph-cal-month{font-size:14px;font-weight:650;min-width:130px}',

      // The month fills its body instead of squaring every cell: a day is not a
      // square, and 6 rows of squares overflow any sane card, which clipped the
      // last week. Rows share the height, so the whole month always fits.
      '.ph-cal-grid{display:grid;grid-template-columns:repeat(7,minmax(30px,1fr));gap:3px;' +
        'flex:1;min-height:0;overflow:auto;grid-auto-rows:minmax(26px,1fr)}',
      '.ph-cal-grid.has-week{grid-template-columns:34px repeat(7,minmax(30px,1fr))}',

      '.ph-cal-head{text-align:center;font-size:10px;font-weight:600;padding:3px 0;' +
        'color:var(--dsw-alias-label-secondary,#9aa4b2)}',

      '.ph-cal-head.is-weekend{color:var(--dsw-alias-state-warn-primary,#d29922)}',

      '.ph-cal-weekcol{text-align:center;font-size:10px;color:var(--dsw-alias-label-secondary,#9aa4b2);' +
        'display:flex;align-items:center;justify-content:center}',

      '.ph-cal-day{position:relative;min-height:0;border-radius:8px;display:flex;align-items:center;' +
        'justify-content:center;font-size:11.5px;font-variant-numeric:tabular-nums;' +
        'background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));transition:background .15s}',

      '.ph-cal-day:hover{background:var(--dsw-alias-bg-overlay,rgba(255,255,255,.12))}',

      '.ph-cal-day.is-foreign{opacity:.34}',

      '.ph-cal-day.is-weekend:not(.is-foreign){color:var(--dsw-alias-state-warn-primary,#d29922)}',

      '.ph-cal-day.is-today{background:var(--dsw-alias-brand-primary,#2b5cff);color:#fff;font-weight:700}',

      // The wall narrows its column count before it lets a card be squeezed: a
      // span keeps meaning the same shape at every width.
      '@media (max-width:1280px){.ph-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}',

      '@media (max-width:1040px){.ph-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}',

      '@media (max-width:860px){.ph-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}',

      '@media (max-width:760px){' +
        '.ph-grid{grid-template-columns:1fr;grid-auto-rows:auto}' +
        '.ph-cell{grid-column:1 / -1 !important;grid-row:auto !important;min-height:var(--ph-row,170px)}' +
        '.ph-shell{min-height:var(--ph-row,128px)}' +
        '.ph-panel{padding:12px}' +
        '.ph-cell.is-hovered .ph-shell{transform:none}' +
        '.ph-focus-card{width:100%}' +
        '}',

      '@media (prefers-reduced-motion:reduce){' +
        '.ph-fx-outline::after,.ph-fx-glow,.ph-fx-float,.ph-fx-scan::before{animation:none}' +
        '.ph-focus-card{animation:none}' +
        '.ph-grid{transition:none}' +
        '.ph-shell{transition:none}' +
        '}',

      // ------------------------------------------- sidebar workspace groups
      // These render inside the shipped Session "…" menu and two 16px row
      // cells, so they copy the shipped menu item's metrics (min-height,
      // padding, radius, hover fill) instead of inventing a second look.
      '.ph-group-menu{display:flex;flex-direction:column;min-width:196px}',

      '.ph-group-label,.ph-group-row{display:flex;align-items:center;gap:7px;width:100%;min-width:0;' +
        'min-height:30px;padding:5px 8px;border:0;border-radius:8px;background:transparent;' +
        'color:inherit;font:inherit;font-size:12.5px;line-height:18px;text-align:left;cursor:pointer}',

      '.ph-group-label:hover,.ph-group-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',

      '.ph-group-row.is-current{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8cff) 14%,transparent)}',

      '.ph-group-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

      '.ph-group-hint{flex:0 0 auto;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9aa4b2)}',

      // The picker opens inside the menu it was clicked in, indented under its
      // own entry so which row is being tagged stays visible.
      '.ph-group-list{display:flex;flex-direction:column;gap:1px;margin:1px 0 2px 9px;padding-left:7px;' +
        'border-left:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14))}',

      '.ph-group-new{display:flex;align-items:center;gap:5px;padding:2px 0 3px 1px}',

      '.ph-group-new .ph-input{min-height:26px;font-size:12px}',

      '.ph-group-new .ph-btn{padding:4px 8px;font-size:11.5px}',

      // The colour dot: 8px, and a neutral grey one means "no group".
      '.ph-group-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;' +
        'background:var(--dsw-alias-label-tertiary,#9aa4b2);box-shadow:inset 0 0 0 1px rgba(255,255,255,.16)}',

      '.ph-group-hover{display:flex;align-items:center;gap:6px;font-size:11.5px;' +
        'color:var(--dsw-alias-label-secondary,#9aa4b2)}',

      // The manager card: one group per line on the wall face, and the editors in
      // the expanded face, which reuse the sidebar's dot and name classes.
      '.ph-groups-card{display:flex;flex-direction:column;gap:7px;min-width:0}',

      '.ph-groups-list{display:flex;flex-direction:column;gap:4px;min-width:0}',

      '.ph-group-line{display:flex;align-items:center;gap:7px;font-size:12px;min-width:0}',

      '.ph-group-line--loose{color:var(--dsw-alias-label-secondary,#9aa4b2)}',

      '.ph-group-count{flex:0 0 auto;font-size:10.5px;white-space:nowrap;' +
        'color:var(--dsw-alias-label-tertiary,#9aa4b2)}',

      '.ph-groups-detail{display:flex;flex-direction:column;gap:10px}',

      '.ph-groups-bar{display:flex;align-items:center;justify-content:space-between;gap:8px}',

      '.ph-groups-new{display:flex;align-items:center;gap:6px}',

      '.ph-groups-new .ph-input{flex:1 1 auto;min-height:28px;font-size:12px}',

      '.ph-group-editors{display:flex;flex-direction:column;gap:9px}',

      '.ph-group-editor{display:flex;flex-direction:column;gap:7px;padding:8px 10px;border-radius:10px;' +
        'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));' +
        'background:var(--dsw-alias-interactive-bg,rgba(255,255,255,.03))}',

      '.ph-group-editor-head{display:flex;align-items:center;gap:7px;min-width:0}',

      '.ph-group-editor-title{flex:0 1 300px;min-width:0}',

      '.ph-group-editor-title .ph-input{width:100%;min-height:26px;font-size:12px}',

      '.ph-group-editor-body{display:flex;flex-direction:column;gap:7px}',

      '.ph-group-tools{flex:0 0 auto;display:flex;align-items:center;gap:2px}',

      '.ph-group-tools .ph-btn{padding:3px 7px;font-size:11px}',

      '.ph-group-tools .ph-btn:last-child{margin-left:5px}',

      '.ph-swatches{display:flex;align-items:center;gap:5px;flex-wrap:wrap}',

      '.ph-swatch{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;' +
        'padding:0;border-radius:50%;cursor:pointer;line-height:0;border:1px solid rgba(255,255,255,.3)}',

      '.ph-swatch.is-on{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary,#5b8cff)}',

      '.ph-swatch--none{background:transparent;color:var(--dsw-alias-label-tertiary,#9aa4b2)}',

      '.ph-members{display:flex;flex-wrap:wrap;gap:4px}',

      '.ph-member{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:1px 2px 1px 7px;' +
        'border-radius:999px;font-size:11px;background:var(--dsw-alias-interactive-bg,rgba(255,255,255,.07))}',

      '.ph-member-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}',

      // A project the document still names but the sidebar no longer lists: kept
      // visible and removable, drawn as the raw id it is.
      '.ph-member.is-orphan{background:transparent;' +
        'border:1px dashed var(--dsw-alias-border-l2,rgba(255,255,255,.18))}',

      '.ph-member.is-orphan .ph-member-name,.ph-loose-name.is-orphan{font-family:' + MONO_FONT + ';font-size:10.5px}',

      '.ph-member-x{padding:1px;border:0;border-radius:50%;cursor:pointer;line-height:0;' +
        'background:transparent;color:var(--dsw-alias-label-tertiary,#9aa4b2)}',

      '.ph-member-x:hover{color:var(--dsw-alias-label-primary,#e6e9ef)}',

      '.ph-loose{display:flex;flex-direction:column;gap:5px}',

      '.ph-loose-row{display:flex;align-items:center;gap:8px;min-width:0}',

      '.ph-loose-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}',

      '.ph-select{flex:0 0 auto;max-width:150px;min-height:26px;padding:2px 6px;font-size:11.5px;border-radius:7px;' +
        'color:var(--dsw-alias-label-primary,#e6e9ef);' +
        'background:var(--dsw-alias-interactive-bg,rgba(255,255,255,.06));' +
        'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14))}',

      '.ph-groups-error{color:var(--dsw-alias-state-error-primary,#e5484d)}',

      '.ph-combo-item.is-current{background:var(--dsw-alias-interactive-bg,rgba(255,255,255,.08));font-weight:600}',
      SIDEBAR_STYLES,
    ].join('\n')

    // ------------------------------------------------------------ plugin

    var name = 'dsh-homepage'

    /**
     * The card the Plugins page draws for this plugin's row. DSH renders a
     * plugin's configuration page from a CLIENT slot registration, not from the
     * Host Config schema alone: the schema supplies the form state, and this is
     * what renders it. The page passes the form for this row's namespace, so no
     * settings service is reached here.
     */

    /** Subscribe one config-form controller; the page owns the write queue. */
    function useFormSnapshot(controller) {
      var pair = React.useState(function () { return controller.getSnapshot() })
      React.useEffect(function () {
        var off = controller.subscribe(function () { pair[1](controller.getSnapshot()) })
        return function () { if (typeof off === 'function') off() }
      }, [controller])
      return pair[0]
    }

    /** The package page card: the same form behind the settings service. */
    function BundleSettingsCard(props) {
      var controller = props.form
      var snapshot = useFormSnapshot(controller)
      return React.createElement(ToolSettingsCard, {
        view: props.view,
        form: {
          state: snapshot,
          mutate: function (ops, revision) { return controller.mutate(ops, revision) },
        },
      })
    }

    /**
     * The DSH client UI primitives the Plugins page itself renders with, so the
     * switch and the segmented control look like every other settings row. The
     * module is optional: without it the card degrades to native controls.
     */
    var settingsUi = (function () {
      try {
        if (typeof require !== 'function') return null
        var ui = require('@deepseek-ai/dsh-client-ui-primitives')
        return ui && typeof ui === 'object' ? ui : null
      } catch (error) {
        return null
      }
    })()

    /**
     * The card the Plugins page draws for this plugin's row. DSH renders a
     * plugin's configuration page from a CLIENT slot registration, not from the
     * Host Config schema alone: the schema supplies the form state, and this is
     * what renders it. The page passes the form for this row's namespace, so no
     * settings service is reached here.
     */
    function ToolSettingsCard(props) {
      var t = runtime.t
      var form = props.form
      if (props.view === 'summary') {
        var current = form && form.state && form.state.value
        return h('span', null, current && current.exposeTool === true
          ? t('settings.summaryOn')
          : t('settings.summaryOff'))
      }
      var hintStyle = { fontSize: '12px', opacity: 0.7, marginTop: '2px' }
      if (!form || !form.state) return h('p', { style: hintStyle }, t('settings.unavailable'))
      var state = form.state
      var value = state.value || {}
      var busy = state.status !== 'ready' || state.writable === false
      var write = function (field, next) {
        if (busy) return
        try {
          var result = form.mutate([{ op: 'set', path: [field], value: next }], state.revision)
          if (result && typeof result.catch === 'function') result.catch(function () {})
        } catch (error) { void error }
      }
      var Switch = settingsUi && (typeof settingsUi.Switch === 'function' ? settingsUi.Switch : null)
      var Segmented = settingsUi
        ? (typeof settingsUi.SegmentedControl === 'function' ? settingsUi.SegmentedControl
          : (typeof settingsUi.SegmentedTabs === 'function' ? settingsUi.SegmentedTabs : null))
        : null
      var expose = value.exposeTool === true
      var language = typeof value.toolLanguage === 'string' ? value.toolLanguage : 'auto'
      var rowStyle = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '18px', padding: '12px 0', borderTop: '1px solid rgba(127,127,127,0.18)' }
      var labelStyle = { fontSize: '13px', fontWeight: 600 }
      return h('div', { style: { display: 'grid', maxWidth: '640px' } },
        h('div', { style: rowStyle },
          h('div', { style: { minWidth: 0 } },
            h('div', { style: labelStyle }, t('settings.expose')),
            h('div', { style: hintStyle }, t('settings.exposeHint'))),
          Switch
            ? h(Switch, { checked: expose, disabled: busy, onChange: function (next) { write('exposeTool', next === true) } })
            : h('input', { type: 'checkbox', checked: expose, disabled: busy, onChange: function (event) { write('exposeTool', event.target.checked) } })),
        h('div', { style: rowStyle },
          h('div', { style: labelStyle }, t('settings.language')),
          Segmented
            ? h(Segmented, {
              value: language,
              disabled: busy,
              options: ['auto', 'en', 'zh'].map(function (option) {
                return { value: option, label: t('settings.language.' + option) }
              }),
              onChange: function (next) { write('toolLanguage', next) },
            })
            : h('select', {
              value: language,
              disabled: busy,
              onChange: function (event) { write('toolLanguage', event.target.value) },
            }, ['auto', 'en', 'zh'].map(function (option) {
              return h('option', { key: option, value: option }, t('settings.language.' + option))
            }))),
      )
    }    // `sessions`, `workspaces`, `uiWorkspace` and `layout` are what the sidebar
    // list occupant drives: it lists real projects and sessions, so it navigates
    // and edits through the same services the shipped browser uses, and it reads
    // them by name instead of through slot props (see `sidebarServices`).
    // `layout` is the shell's own sidebar service: its `toggleSidebar()` is the
    // only way to leave the icon rail, which the region draws while collapsed.
    var inject = ['slots', 'connection', 'locale', 'sessions', 'workspaces', 'uiWorkspace', 'layout']

    /**
     * Mount the client half: dictionaries, styles, the three shipped cards and
     * the two slot registrations (the sidebar entry and the main panel).
     * @param ctx - client plugin context.
     * @returns nothing; every disposable is owned by the plugin fiber.
     */
    function apply(ctx) {
      var slots = ctx.slots
      var connection = ctx.connection
      var locale = ctx.locale

      // The sidebar list occupant navigates and edits through the workspace
      // services. `inject` above declares them, but the lookup stays defensive:
      // a host without them still mounts the cards, and the list renders
      // read-only instead of taking the region down with it.
      sidebarServices.workspaces = serviceOf(ctx, 'workspaces')
      sidebarServices.sessions = serviceOf(ctx, 'sessions')
      sidebarServices.uiWorkspace = serviceOf(ctx, 'uiWorkspace')
      sidebarServices.layout = serviceOf(ctx, 'layout')

      runtime.call = connection && typeof connection.rpc === 'object' && typeof connection.rpc.call === 'function'
        ? function (channel, endpoint, payload) { return connection.rpc.call(channel, endpoint, payload) }
        : null

      // Cards reach the main view through the workspace service. Without it the
      // call answers false instead of throwing out of a click handler; with it,
      // the navigation is started and reported as accepted.
      runtime.openSession = function (sessionId) {
        try {
          var id = sessionId === undefined || sessionId === null ? '' : String(sessionId).trim()
          if (id === '') return false
          var ui = sidebarServices.uiWorkspace
          if (!ui || typeof ui.openSession !== 'function') return false
          ui.openSession(id)
          return true
        } catch (error) {
          return false
        }
      }

      // A workspace has no session to switch to: opening it starts (or resumes)
      // the workspace's session and replaces the main view. The navigation is
      // asynchronous, so a rejection is swallowed here and reported as accepted;
      // the workspace shell owns the visible failure state.
      runtime.openWorkspace = function (workspaceId) {
        try {
          var id = workspaceId === undefined || workspaceId === null ? '' : String(workspaceId).trim()
          if (id === '') return false
          var ui = sidebarServices.uiWorkspace
          if (!ui || typeof ui.openWorkspace !== 'function') return false
          var started = ui.openWorkspace(id)
          if (started && typeof started.then === 'function') {
            started.then(function () {}, function () {})
          }
          return true
        } catch (error) {
          return false
        }
      }

      // The collector and action layers, reached over the same sessionless
      // channel as every other endpoint. Both answer structurally: a transport
      // failure is data for the card (an empty snapshot, a refused action), not
      // an unhandled rejection escaping a click handler.
      runtime.collect = function (names, options) {
        var force = Boolean(options && options.force)
        return remoteCall('homepage/collect', { options: { names: names, force: force } })
          .then(function (value) {
            if (value && typeof value === 'object') return value
            return { at: Date.now(), entries: {} }
          }, function (error) {
            return { at: Date.now(), entries: {}, error: errorText(error) }
          })
      }
      runtime.act = function (action, payload) {
        var id = action === undefined || action === null ? '' : String(action)
        return remoteCall('homepage/act', { options: { action: id, payload: payload } })
          .then(function (value) {
            if (value && typeof value === 'object') return value
            return { ok: false, action: id, error: 'act: the host answered with no result' }
          }, function (error) {
            return { ok: false, action: id, error: errorText(error) }
          })
      }

      // The stylesheet is rendered by the panel itself (see styleSheets), so a
      // custom effect registered before the panel mounts still lands: it only
      // records text, and the first render picks the record up.
      runtime.insertCss = insertCss

      // The locale service owns the strings, and a third-party card can arrive at
      // any time with its own, so the registration stays replaceable:
      // refreshDictionaries() re-registers the merged maps and disposes the
      // previous registration first.
      runtime.locale = locale
      ctx.effect(function () {
        var dispose = registerDictionaries()
        return function () {
          if (typeof dispose === 'function') dispose()
          if (dictionaryDisposer === dispose) dictionaryDisposer = null
        }
      }, name + ': dictionaries')

      var bound = locale.bind(NS)
      runtime.t = function (key, params) {
        try { return bound(key, params) } catch (error) { return key }
      }

      // The shipped cards registered themselves when this factory materialized
      // (lib/cards/*, spliced in at build time); there is nothing to install.

      slots.inject('sidebar.panellist', function () {
        return slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: SIDEBAR_ORDER, label: function () { return runtime.t('panel.title') }, locale: NS },
          function (props) { return React.createElement(SidebarIcon, props) },
        )
      })
      slots.inject('main', function () {
        return slots.register(
          { name: 'main', key: PANEL_ID, locale: NS, order: DETAIL_ORDER },
          function (props) { return React.createElement(HomePanel, props) },
        )
      })

      // The package page shows the same switch directly, which is where a user
      // looks first. It needs the settings service, so it is optional: without
      // it the row page above is still reachable.
      if (typeof ctx.inject === 'function') {
        ctx.inject(['configForms'], function (scope) {
          if (!scope || !scope.configForms || typeof scope.configForms.get !== 'function') return
          var controller = scope.configForms.get(name)
          slots.inject('plugins.bundle.config', function () {
            return slots.register(
              { name: 'plugins.bundle.config', key: name, locale: NS },
              function (props) { return React.createElement(BundleSettingsCard, { view: props.view, form: controller }) },
            )
          })
        })
      }
      // The model-facing tool is opt-in, and its switch lives on this plugin's
      // row in the Plugins page. The row key is `<package>#<row id>`.
      slots.inject('plugins.row.config', function () {
        return slots.register(
          { name: 'plugins.row.config', key: name + '#' + name, locale: NS },
          function (props) { return React.createElement(ToolSettingsCard, props) },
        )
      })
      // Card files queued their own slot work while this module was evaluating
      // (see onApply); the services exist by now.
      for (var i = 0; i < applyTasks.length; i += 1) {
        try { applyTasks[i](ctx) } catch (error) { console.error('homepage: apply task failed', error) }
      }

      globalThis.__DSH_HOMEPAGE__ = Object.assign(globalThis.__DSH_HOMEPAGE__ || {}, {
        version: 1,
        namespace: NS,
        plugin: name,
        // A versioned surface for an external card plugin. It exposes the same
        // primitives a shipped card gets through `kit`, so an external card is
        // not forced to import the framework or reach into its internals.
        sdk: {
          h: h, React: React, UI: UI, ICONS: ICONS, runtime: runtime, dict: dict,
          hooks: hooks, useRemote: useRemote, useClock: useClock,
          useAnnounce: useAnnounce, useNoticeOnce: useNoticeOnce,
          remoteCall: remoteCall, requestReload: requestReload, publishReloader: publishReloader,
          pushToast: pushToast, notify: notify, cardApi: cardApi,
          expandCard: expandCard, collapseCard: collapseCard,
          currencySymbol: currencySymbol, primaryWallet: primaryWallet,
          dayKey: dayKey, kv: kv, withAlpha: withAlpha, textOf: textOf,
          formatNumber: formatNumber, iconOf: iconOf, onApply: onApply,
        },
        define: defineCard,
        remove: removeCard,
        get: function (id) { return registryById[id] || null },
        cardApi: function (id) { return registryById[id] ? cardApi(registryById[id]) : null },
        list: function () { return registry.slice() },
        ui: UI,
        icons: ICONS,
        effects: EFFECTS,
        defineEffect: defineEffect,
        // Identification, for a plugin that registers into this wall: who owns a
        // card, a serializable manifest of the whole registry, a change feed, and
        // a scoped handle that can only touch its own cards.
        has: has,
        ownerOf: ownerOf,
        cardsOf: cardsOf,
        owners: owners,
        manifest: manifest,
        subscribeRegistry: subscribeRegistry,
        unregister: unregisterOwner,
        plugin: pluginHandle,
        backgrounds: bg,
        notify: notify,
        clearNotifications: clearNotifications,
        toast: pushToast,
        open: expandCard,
        close: collapseCard,
        reorder: reorderCards,
        subscribe: subscribeStore,
        hooks: hooks,
        snapshot: function () { return store },
        load: bootstrap,
        state: function () { return store.state },
        // The sidebar workspace-group document, for a plugin that wants to read
        // or extend the grouping without going through a slot.
        sidebar: {
          snapshot: function () { return sidebar },
          load: loadSidebarLayout,
          mutate: mutateSidebarLayout,
          colors: SIDEBAR_COLORS.slice(),
          groups: sidebarGroups,
          members: sidebarMembers,
          // Which project rows the reader has opened or closed, keyed by
          // workspace id. The value is the stored answer or — like the shell's
          // own `groupExpansion` — a default the caller supplies for a row that
          // has never been touched.
          expanded: sidebarExpanded,
          expandedOf: sidebarExpandedOf,
          // The takeover switch, the same pair the card's own control uses: a
          // read and a write, so a caller never has to know the migration rule
          // that decides what a stored `mode` means.
          mode: function (layout) { return sidebarMode(layout) },
          setMode: function (mode) {
            return mutateSidebarLayout(function (live) { return withMode(live, mode) })
          },
          // The component that draws the region when the document asks for the
          // grouped list. It takes no props — everything it needs is on the
          // document and on the projection the sidebar icon reports — so a test
          // with no browser can render it directly.
          projects: function () { return Kit.sidebarProjects || null },
        },
      })
    }

    // --------------------------------------------------------- dictionaries

    /** Chinese dictionary. Every key here must exist in `EN` too. */
    var ZH = {
      'settings.summaryOn': '模型工具已开启',
      'settings.summaryOff': '模型工具已关闭',
      'settings.expose': '允许模型调用 homepage 工具',
      'settings.exposeHint': '开启后会话可读取本机的卡片数据；关闭时该工具不会出现在模型上下文中。',
      'settings.language': '工具文本语言',
      'settings.language.auto': '跟随界面',
      'settings.language.en': 'English',
      'settings.language.zh': '中文',
      'settings.unavailable': '配置尚未加载',
      'panel.title': '主页',
      'panel.density': '密度',
      'density.compact': '紧凑',
      'density.compact.hint': '同屏放下更多卡片',
      'density.standard': '标准',
      'density.standard.hint': '默认间距与卡片尺寸',
      'density.cozy': '宽松',
      'density.cozy.hint': '更大的卡片与更大的留白',
      'panel.edit': '编辑',
      'panel.edit.hint': '开启后可以拖拽排序、调整卡片大小与动效',
      'panel.drag': '拖拽排序',
      'panel.autoSize': '复位尺寸',
      'layout.arrange': '整理布局',
      'layout.done': '完成',
      'layout.hint': '拖动卡片标题调整顺序，或用箭头移动；点「设计」调整大小与动效。Esc 取消拖动。',
      'layout.moved': '{title} 已移至第 {position} 位',
      'layout.dragCard': '拖动 {title}',
      'layout.openCard': '查看 {title} 详情',
      'layout.earlier': '将 {title} 前移',
      'layout.later': '将 {title} 后移',
      'design.title': '设计',
      'design.close': '收起设计面板',
      'design.size': '卡片尺寸',
      'design.size.tile': '方块',
      'design.size.wide': '横幅',
      'design.size.feature': '重点',
      'design.size.panorama': '全景',
      'design.size.full': '通栏',
      'design.width': '宽',
      'design.height': '高',
      'design.motion': '动效',
      'design.trigger': '动效触发方式',
      'design.trigger.always': '持续播放',
      'design.trigger.hover': '悬停 / 聚焦',
      'design.appearance': '外观与布局',
      'design.detail': '详情',
      'studio.title': '自定义',
      'studio.hint': '让工作区，长成你的样子。',
      'studio.close': '收起自定义',
      'studio.visibility': '卡片显示',
      'studio.visibilityHint': '选择卡片编辑图案，用右侧按钮隐藏或添加。',
      'studio.hide': '隐藏卡片',
      'studio.add': '添加卡片',
      'studio.addCards': '添加卡片',
      'studio.showAll': '显示全部卡片',
      'studio.empty': '留白，也是一种布局',
      'studio.preview': '实时预览',
      'studio.onWall': '已显示在工作区',
      'studio.offWall': '已隐藏 · 随时可以添加回来',
      'studio.pattern': '卡片图案',
      'studio.reset': '恢复默认',
      'studio.upload': '导入图片',
      'studio.imageHint': 'PNG / JPG / WebP · 最大 512 KB',
      'studio.imageError': '请选择不超过 512 KB 的 PNG、JPG 或 WebP 图片。',
      'studio.placement': '图案摆放',
      'studio.left': '居左',
      'studio.center': '居中',
      'studio.right': '居右',
      'studio.size': '缩放',
      'studio.opacity': '不透明度',
      'studio.rotate': '旋转',
      'studio.offsetX': '水平偏移',
      'studio.offsetY': '垂直偏移',
      'studio.fade': '渐变透明',
      'studio.fadeHint': '向对齐边界的另一侧渐隐，不留硬边。',
      'studio.fadePosition': '渐变位置',
      'studio.blend': '融合',
      'studio.blendHint': '压掉图片自带的底色，让图案更像卡面本身。',
      'studio.blend.normal': '正常',
      'studio.blend.multiply': '正片叠底',
      'studio.blend.screen': '滤色',
      'studio.blend.luminosity': '明度',
      'studio.blend.soft-light': '柔光',
      'studio.savedHint': '修改自动保存 · 隐藏卡片保留原有数据与设置',
      'studio.pattern.default': '默认',
      'studio.pattern.none': '无图案',
      'studio.pattern.orbit': '轨道',
      'studio.pattern.bloom': '花序',
      'studio.pattern.waves': '流线',
      'studio.pattern.grid': '网格',
      'studio.pattern.cube': '立方',
      'studio.pattern.network': '经纬',
      'studio.pattern.layers': '层叠',
      'studio.pattern.branch': '分支',
      'panel.collapse': '收起',
      'panel.effects': '动效',
      'panel.size': '尺寸',
      'panel.empty': '还没有注册任何卡片',
      'panel.emptyHint': '任何插件都可以在浏览器端注册卡片；下面的对象就是完整的注册接口。',
      'panel.example': "const mine = globalThis.__DSH_HOMEPAGE__.plugin('my-plugin')\nmine.define({\n  id: 'my-card',\n  title: '我的卡片',\n  size: { w: 2, h: 1 },        // 默认显示大小（网格列/行跨度）\n  content: (api) => React.createElement('div', null, '内容'),\n  detail: (api) => React.createElement('div', null, '展开后的主要内容'),\n  actions: [{ id: 'mode', type: 'segmented', label: '模式', options: [...] }],\n  effects: { outline: 'glow', ripple: true },\n})\n",
      'panel.stateError': '状态无法保存：',
      'common.refresh': '刷新',
      'common.force': '强制刷新',
      'common.copy': '复制',
      'common.copyRaw': '复制原始值',
      'common.copied': '已复制：',
      'common.copyFailed': '复制失败',
      'common.today': '今天',
      'common.yesterday': '昨天',
      'common.none': '无',
      'common.error': '读取失败',
      'common.retry': '重试',
      'common.notReady': '卡片尚未加载',
      'notice.dismiss': '忽略',
      'notice.clearAll': '全部清除',
      'notice.title': '通知',
      'notice.more': '另有 {count} 条',
      'card.renderFailed': '这张卡片渲染失败',
      'card.contentFailed': '卡片内容构建失败',

      'fx.none.label': '无动效',
      'fx.none.description': '静态卡片，不播放任何动画。',
      'fx.outline.label': '描边流光',
      'fx.outline.description': '沿边框流动的高光描边。',
      'fx.glow.label': '呼吸辉光',
      'fx.glow.description': '外阴影缓慢呼吸。',
      'fx.scan.label': '扫光',
      'fx.scan.description': '周期性掠过的斜向高光。',
      'fx.float.label': '悬浮',
      'fx.float.description': '上下轻微浮动。',
      'fx.spotlight.label': '聚光',
      'fx.spotlight.description': '光晕跟随指针。',

      'sidebar.group.assign': '归入分组',
      'sidebar.group.ungrouped': '未分组',
      'sidebar.group.new': '新建分组…',
      'sidebar.group.name': '分组名称',
      'sidebar.group.create': '创建',
      'sidebar.group.cancel': '取消',
      'sidebar.group.remove': '移出分组',
      'sidebar.group.delete': '删除分组',
      'sidebar.group.rename': '重命名',
      'sidebar.group.color': '颜色标记',
      'sidebar.group.none': '不加标记',
      'sidebar.group.sortRecent': '按改动时间排序',
      'sidebar.group.sortManual': '按默认顺序',
      'sidebar.group.marked': '已分组',
      'sidebar.group.empty': '还没有分组',
      'sidebar.group.count': '{count} 个项目',
      'sidebar.group.more': '还有 {count} 个',
      'sidebar.card.title': '工作区分组',
      'sidebar.groups.empty': '还没有分组，展开后可新建',
      'sidebar.manager.create': '新建分组',
      'sidebar.manager.loose': '未归类',
      'sidebar.manager.empty': '侧边栏还没有项目',
      'sidebar.manager.mode': '侧边栏列表',
      'sidebar.manager.pending': '正在读取分组…',
      'sidebar.group.members': '成员',
      'sidebar.group.noMembers': '这个分组还没有项目',
      'sidebar.group.moveUp': '上移',
      'sidebar.group.moveDown': '下移',
      'sidebar.group.removeHint': '移出这个分组',
      'sidebar.group.deleteHint': '删除分组后其中的项目回到未归类，项目本身不受影响',
      'sidebar.group.deleteAsk': '删除分组「{title}」？其中的项目会回到未归类。',
      'sidebar.member.orphan': '分组文档里还有这条记录，侧边栏已不再列出这个项目',
      // The list that takes over the sidebar region while `mode` is 'grouped'.
      'sidebar.list.title': '项目',
      'sidebar.list.newGroup': '新建分组',
      'sidebar.list.newProject': '添加项目',
      'sidebar.list.manage': '管理分组…',
      'sidebar.list.useNative': '改用官方列表',
      'sidebar.list.useGrouped': '改用分组列表',
      'sidebar.list.refresh': '刷新',
      'sidebar.list.search': '搜索会话',
      'sidebar.list.searching': '正在搜索…',
      'sidebar.list.empty': '还没有项目',
      'sidebar.list.noMatch': '没有匹配的会话',
      'sidebar.list.newSession': '新建会话',
      'sidebar.list.addProject': '添加项目…',
      'sidebar.list.rename': '重命名',
      'sidebar.list.create': '创建',
      'sidebar.list.chooseFolder': '选择',
      'sidebar.list.newFolder': '新建文件夹',
      'sidebar.list.showHidden': '显示隐藏项',
      'sidebar.list.folderName': '文件夹名称',
      'sidebar.list.dirHome': '主目录',
      'sidebar.list.editPath': '输入路径',
      'sidebar.list.dirLoading': '正在读取…',
      'sidebar.list.dirEmpty': '没有子文件夹',
      'sidebar.list.dirHiddenOnly': '没有可见的子文件夹，隐藏项已折叠',
      'sidebar.list.dirTruncated': '文件夹太多，只列出了前一部分',
      'sidebar.list.dirFailed': '读不到这个目录：{reason}',
      'sidebar.list.apply': '确定',
      'sidebar.list.more': '更多',
      'sidebar.list.count': '{count} 个会话',
      'sidebar.list.unarchive': '取消归档',
      'sidebar.list.failed': '操作失败：{reason}',
      'sidebar.list.readonly': '只读：当前宿主没有提供工作区服务',
      'sidebar.list.crashed': '分组列表出错了，可以先换回官方列表',
      'sidebar.list.narrow': '展开侧边栏',
      'sidebar.when.now': '刚刚',
      'sidebar.when.minutes': '{count} 分钟前',
      'sidebar.when.hours': '{count} 小时前',
      'sidebar.when.days': '{count} 天前',
      'sidebar.session.new': '新会话',
      'sidebar.session.untitled': '未命名会话',
      'sidebar.session.pin': '置顶会话',
      'sidebar.session.unpin': '取消置顶',
      'sidebar.session.fork': '分叉会话',
      'sidebar.session.archive': '归档会话',
      'sidebar.session.copyId': '复制会话 ID',
      'sidebar.project.move': '归入分组',
      'sidebar.project.group': '分组',
      'sidebar.project.newGroup': '新建分组…',
      'sidebar.project.noGroup': '移出分组',
      'sidebar.project.rename': '重命名',
      'sidebar.project.pin': '置顶项目',
      'sidebar.project.unpin': '取消置顶',
      'sidebar.project.delete': '删除工作区',
      'sidebar.project.deleteAsk': '从侧边栏移除「{title}」？项目目录与其中的会话都不会被删除。',
      'sidebar.group.collapse': '折叠',
      'sidebar.group.expand': '展开',

    }

    /** English dictionary, mirroring `ZH` key for key. */
    var EN = {
      'settings.summaryOn': 'Model tool is on',
      'settings.summaryOff': 'Model tool is off',
      'settings.expose': 'Let models call the homepage tool',
      'settings.exposeHint': "When on, a session can read this machine's card data; when off the tool is absent from the model context.",
      'settings.language': 'Tool text language',
      'settings.language.auto': 'Follow the UI',
      'settings.language.en': 'English',
      'settings.language.zh': '中文',
      'settings.unavailable': 'Settings are not loaded yet',
      'panel.title': 'Home',
      'panel.density': 'Density',
      'density.compact': 'Compact',
      'density.compact.hint': 'Fit more cards on screen',
      'density.standard': 'Standard',
      'density.standard.hint': 'Default spacing and card size',
      'density.cozy': 'Cozy',
      'density.cozy.hint': 'Larger cards with more breathing room',
      'panel.edit': 'Edit',
      'panel.edit.hint': 'Drag to reorder, resize cards and pick an animation',
      'panel.drag': 'Drag to reorder',
      'panel.autoSize': 'Reset sizes',
      'layout.arrange': 'Arrange',
      'layout.done': 'Done',
      'layout.hint': 'Drag a card header or use its arrows to reorder. Choose Design for size and motion. Esc cancels a drag.',
      'layout.moved': '{title} moved to position {position}',
      'layout.dragCard': 'Drag {title}',
      'layout.openCard': 'View {title} details',
      'layout.earlier': 'Move {title} earlier',
      'layout.later': 'Move {title} later',
      'design.title': 'Design',
      'design.close': 'Close design panel',
      'design.size': 'Card size',
      'design.size.tile': 'Tile',
      'design.size.wide': 'Wide',
      'design.size.feature': 'Feature',
      'design.size.panorama': 'Panorama',
      'design.size.full': 'Full',
      'design.width': 'Width',
      'design.height': 'Height',
      'design.motion': 'Motion',
      'design.trigger': 'Motion trigger',
      'design.trigger.always': 'Continuous',
      'design.trigger.hover': 'Hover / focus',
      'design.appearance': 'Appearance & layout',
      'design.detail': 'Details',
      'studio.title': 'Customize',
      'studio.hint': 'A workspace that feels like you.',
      'studio.close': 'Close customization',
      'studio.visibility': 'Card visibility',
      'studio.visibilityHint': 'Select a card to style it. Toggle to hide or add.',
      'studio.hide': 'Hide card',
      'studio.add': 'Add card',
      'studio.addCards': 'Add cards',
      'studio.showAll': 'Show all cards',
      'studio.empty': 'A little room to breathe',
      'studio.preview': 'Live preview',
      'studio.onWall': 'Visible in your workspace',
      'studio.offWall': 'Hidden · ready whenever you are',
      'studio.pattern': 'Card artwork',
      'studio.reset': 'Restore default',
      'studio.upload': 'Import image',
      'studio.imageHint': 'PNG / JPG / WebP · up to 512 KB',
      'studio.imageError': 'Choose a PNG, JPG or WebP image no larger than 512 KB.',
      'studio.placement': 'Artwork placement',
      'studio.left': 'Left',
      'studio.center': 'Center',
      'studio.right': 'Right',
      'studio.size': 'Scale',
      'studio.opacity': 'Opacity',
      'studio.rotate': 'Rotation',
      'studio.offsetX': 'Horizontal offset',
      'studio.offsetY': 'Vertical offset',
      'studio.fade': 'Gradient fade',
      'studio.fadeHint': 'Dissolves toward the opposite edge instead of cutting hard.',
      'studio.fadePosition': 'Fade position',
      'studio.blend': 'Blend',
      'studio.blendHint': 'Eases the artwork’s own backdrop so it reads as part of the card.',
      'studio.blend.normal': 'Normal',
      'studio.blend.multiply': 'Multiply',
      'studio.blend.screen': 'Screen',
      'studio.blend.luminosity': 'Luminosity',
      'studio.blend.soft-light': 'Soft light',
      'studio.savedHint': 'Changes save automatically · hiding keeps your data and settings',
      'studio.pattern.default': 'Default',
      'studio.pattern.none': 'None',
      'studio.pattern.orbit': 'Orbit',
      'studio.pattern.bloom': 'Bloom',
      'studio.pattern.waves': 'Flow',
      'studio.pattern.grid': 'Grid',
      'studio.pattern.cube': 'Cube',
      'studio.pattern.network': 'Globe',
      'studio.pattern.layers': 'Layers',
      'studio.pattern.branch': 'Branch',
      'panel.collapse': 'Collapse',
      'panel.effects': 'Effect',
      'panel.size': 'Size',
      'panel.empty': 'No cards registered yet',
      'panel.emptyHint': 'Any plugin can register a card from the browser side; the object below is the whole interface.',
      'panel.example': "const mine = globalThis.__DSH_HOMEPAGE__.plugin('my-plugin')\nmine.define({\n  id: 'my-card',\n  title: 'My card',\n  size: { w: 2, h: 1 },        // default grid span, in columns and rows\n  content: (api) => React.createElement('div', null, 'Content'),\n  detail: (api) => React.createElement('div', null, 'Expanded body'),\n  actions: [{ id: 'mode', type: 'segmented', label: 'Mode', options: [...] }],\n  effects: { outline: 'glow', ripple: true },\n})\n",
      'panel.stateError': 'State could not be saved: ',
      'common.refresh': 'Refresh',
      'common.force': 'Force refresh',
      'common.copy': 'Copy',
      'common.copyRaw': 'Copy raw value',
      'common.copied': 'Copied: ',
      'common.copyFailed': 'Copy failed',
      'common.today': 'Today',
      'common.yesterday': 'Yesterday',
      'common.none': 'none',
      'common.error': 'Read failed',
      'common.retry': 'Retry',
      'common.notReady': 'Cards are not loaded yet',
      'notice.dismiss': 'Dismiss',
      'notice.clearAll': 'Clear all',
      'notice.title': 'Notices',
      'notice.more': '{count} more',
      'card.renderFailed': 'This card failed to render',
      'card.contentFailed': 'The card content could not be built',

      'fx.none.label': 'No motion',
      'fx.none.description': 'A still card that plays no animation.',
      'fx.outline.label': 'Flowing outline',
      'fx.outline.description': 'A highlight that travels along the border.',
      'fx.glow.label': 'Breathing glow',
      'fx.glow.description': 'The outer shadow breathes slowly.',
      'fx.scan.label': 'Sheen scan',
      'fx.scan.description': 'A diagonal highlight that sweeps past periodically.',
      'fx.float.label': 'Float',
      'fx.float.description': 'A gentle up and down drift.',
      'fx.spotlight.label': 'Spotlight',
      'fx.spotlight.description': 'A soft light that follows the pointer.',

      'sidebar.group.assign': 'Add to group',
      'sidebar.group.ungrouped': 'Ungrouped',
      'sidebar.group.new': 'New group…',
      'sidebar.group.name': 'Group name',
      'sidebar.group.create': 'Create',
      'sidebar.group.cancel': 'Cancel',
      'sidebar.group.remove': 'Remove from group',
      'sidebar.group.delete': 'Delete group',
      'sidebar.group.rename': 'Rename',
      'sidebar.group.color': 'Colour tag',
      'sidebar.group.none': 'No tag',
      'sidebar.group.sortRecent': 'Sort by recently changed',
      'sidebar.group.sortManual': 'Sort by default order',
      'sidebar.group.marked': 'Grouped',
      'sidebar.group.empty': 'No groups yet',
      'sidebar.group.count': '{count} projects',
      'sidebar.group.more': '{count} more',
      'sidebar.card.title': 'Workspace groups',
      'sidebar.groups.empty': 'No groups yet, expand this card to make one',
      'sidebar.manager.create': 'New group',
      'sidebar.manager.loose': 'Ungrouped',
      'sidebar.manager.empty': 'The sidebar has no projects yet',
      'sidebar.manager.mode': 'Sidebar list',
      'sidebar.manager.pending': 'Reading groups…',
      'sidebar.group.members': 'Members',
      'sidebar.group.noMembers': 'This group has no projects yet',
      'sidebar.group.moveUp': 'Move up',
      'sidebar.group.moveDown': 'Move down',
      'sidebar.group.removeHint': 'Remove from this group',
      'sidebar.group.deleteHint': 'Deleting a group returns its projects to ungrouped; the projects are untouched',
      'sidebar.group.deleteAsk': 'Delete the group "{title}"? Its projects go back to ungrouped.',
      'sidebar.member.orphan': 'The document still names this project; the sidebar no longer lists it',
      // The list that takes over the sidebar region while `mode` is 'grouped'.
      'sidebar.list.title': 'Projects',
      'sidebar.list.newGroup': 'New group',
      'sidebar.list.newProject': 'Add project',
      'sidebar.list.manage': 'Manage groups…',
      'sidebar.list.useNative': 'Use the shipped list',
      'sidebar.list.useGrouped': 'Use the grouped list',
      'sidebar.list.refresh': 'Refresh',
      'sidebar.list.search': 'Search sessions',
      'sidebar.list.searching': 'Searching…',
      'sidebar.list.empty': 'No projects yet',
      'sidebar.list.noMatch': 'No matching session',
      'sidebar.list.newSession': 'New session',
      'sidebar.list.addProject': 'Add a project…',
      'sidebar.list.rename': 'Rename',
      'sidebar.list.create': 'Create',
      'sidebar.list.chooseFolder': 'Select',
      'sidebar.list.newFolder': 'New folder',
      'sidebar.list.showHidden': 'Show hidden files',
      'sidebar.list.folderName': 'Folder name',
      'sidebar.list.dirHome': 'Home',
      'sidebar.list.editPath': 'Type a path',
      'sidebar.list.dirLoading': 'Loading…',
      'sidebar.list.dirEmpty': 'No subfolders',
      'sidebar.list.dirHiddenOnly': 'No visible subfolders; hidden items are folded',
      'sidebar.list.dirTruncated': 'Too many folders; only the first ones are listed',
      'sidebar.list.dirFailed': 'Cannot read this folder: {reason}',
      'sidebar.list.apply': 'Apply',
      'sidebar.list.more': 'More',
      'sidebar.list.count': '{count} sessions',
      'sidebar.list.unarchive': 'Unarchive',
      'sidebar.list.failed': 'That action failed: {reason}',
      'sidebar.list.readonly': 'Read-only: this host provides no workspace services',
      'sidebar.list.crashed': 'The grouped list failed; the shipped list is one click away',
      'sidebar.list.narrow': 'Expand the sidebar',
      'sidebar.when.now': 'just now',
      'sidebar.when.minutes': '{count} min ago',
      'sidebar.when.hours': '{count} h ago',
      'sidebar.when.days': '{count} d ago',
      'sidebar.session.new': 'New session',
      'sidebar.session.untitled': 'Untitled session',
      'sidebar.session.pin': 'Pin session',
      'sidebar.session.unpin': 'Unpin session',
      'sidebar.session.fork': 'Fork session',
      'sidebar.session.archive': 'Archive session',
      'sidebar.session.copyId': 'Copy session ID',
      'sidebar.project.move': 'Assign to a group',
      'sidebar.project.group': 'Group',
      'sidebar.project.newGroup': 'New group…',
      'sidebar.project.noGroup': 'Remove from group',
      'sidebar.project.rename': 'Rename',
      'sidebar.project.pin': 'Pin project',
      'sidebar.project.unpin': 'Unpin project',
      'sidebar.project.delete': 'Delete workspace',
      'sidebar.project.deleteAsk': 'Remove "{title}" from the sidebar? The folder and its sessions are kept.',
      'sidebar.group.collapse': 'Collapse',
      'sidebar.group.expand': 'Expand',

    }

    // ----------------------------------------------- shipped cards (see cards.js)

    /** Reload callbacks a card publisher can invoke from a registered action. */
    var reloaders = {}

    /**
     * Publish a card's reload function so its own actions can trigger it.
     *
     * A card mounts more than one component that reads the host - the compact
     * preview and the expanded detail each hold their own poll - so an id has a
     * list, and a manual refresh has to reach all of them. Refreshing only the
     * last one to mount would leave the visible half stale.
     */
    function publishReloader(id, fn) {
      if (!reloaders[id]) reloaders[id] = []
      reloaders[id].push(fn)
      return function () {
        var list = reloaders[id]
        if (!list) return
        var at = list.indexOf(fn)
        if (at >= 0) list.splice(at, 1)
        if (list.length === 0) delete reloaders[id]
      }
    }

    /** Fire every reloader a mounted card published. */
    function requestReload(id, force) {
      var list = reloaders[id]
      if (!Array.isArray(list) || list.length === 0) {
        pushToast(runtime.t('common.notReady'), 'warn')
        return
      }
      list.slice().forEach(function (fn) { fn(force === true) })
    }


    /** @returns one key/value row. */
    function kv(key, value) {
      return h('div', { className: 'ph-kv-row', key: key },
        h('span', { className: 'ph-kv-key' }, key),
        h('span', { className: 'ph-kv-value ph-mono ph-break' }, value === undefined || value === null ? '—' : String(value)),
      )
    }



    // -------------------------------------------------- card authoring kit

    /**
     * Merge one card module's strings into the namespace dictionaries.
     * @param entries - `{ zh, en }`; either half may be omitted.
     * @returns nothing.
     */
    function dict(entries) {
      if (!entries) return
      if (entries.zh) Object.assign(ZH, entries.zh)
      if (entries.en) Object.assign(EN, entries.en)
    }

    /** The live locale registration, so a later card can replace it. */
    var dictionaryDisposer = null

    /**
     * Push the merged dictionaries to the locale service, replacing whatever was
     * registered before. Called by `apply`, and again whenever a definition
     * brings its own `dict` — a card registered long after boot still gets its
     * strings resolved.
     * @returns the disposer the locale service handed back, if any.
     */
    function registerDictionaries() {
      if (!runtime.locale || typeof runtime.locale.register !== 'function') return null
      if (typeof dictionaryDisposer === 'function') {
        try { dictionaryDisposer() } catch (error) { void error }
      }
      dictionaryDisposer = runtime.locale.register(NS, { zh: ZH, en: EN })
      return dictionaryDisposer
    }

    /** @returns nothing. Re-register the dictionaries after they grew. */
    function refreshDictionaries() { registerDictionaries() }

    // ------------------------------------------- sidebar workspace groups

    /**
     * The sidebar workspace-group document: which project sits in which group,
     * with which colour and order, and whether it is hidden. This is display
     * state owned by this plugin — no workspace, session or project fact is ever
     * written back to DSH, and dropping a group touches nothing real.
     *
     * One document, one writer. The sidebar entries (a project's "…" menu and
     * its hover actions) and the manager card all call `mutateSidebarLayout`: an
     * edit lands locally at once, the whole document is saved after a short
     * debounce — the host replaces rather than merges, so a deleted group really
     * goes — and the host's normalised answer becomes the new document.
     */
    /**
     * The client services the sidebar list occupant drives, captured by `apply`.
     * A `null` member means this host does not provide that service: every
     * action is then skipped and the list renders read-only, rather than
     * throwing inside a region the user cannot see a stack trace for.
     */
    var sidebarServices = { workspaces: null, sessions: null, uiWorkspace: null, layout: null }
    /**
     * @param ctx - client plugin context.
     * @param name - client service name.
     * @returns the service, or null when it is not provided here.
     */
    function serviceOf(ctx, name) {
      try {
        if (ctx && typeof ctx.get === 'function') return ctx.get(name) || null
        return ctx ? (ctx[name] || null) : null
      } catch (error) {
        return null
      }
    }

    var sidebar = { version: 0, layout: null, at: 0, phase: 'idle', error: null, workspaces: null, current: null, signature: '' }
    var sidebarSubscribers = new Set()
    var sidebarSaveTimer = null
    var sidebarSaveSeq = 0
    var SIDEBAR_SAVE_DEBOUNCE_MS = 400
    // Kept in step with the host's `SIDEBAR_VERSION`; the client stamps every
    // document it edits with it.
    var SIDEBAR_VERSION = 1

    /** The palette a group colour is picked from. */
    var SIDEBAR_COLORS = ['#e5484d', '#f76808', '#f5c542', '#46a758', '#12a594', '#0090ff', '#6e56cf', '#e93d82']

    /** @returns the sidebar store version, the snapshot `useSyncExternalStore` reads. */
    function sidebarVersion() { return sidebar.version }
    /** @param listener - called after every change. @returns an unsubscribe function. */
    function subscribeSidebar(listener) {
      sidebarSubscribers.add(listener)
      return function () { sidebarSubscribers.delete(listener) }
    }
    /** Publish a sidebar change to every subscribed component. */
    function bumpSidebar() {
      sidebar.version += 1
      sidebarSubscribers.forEach(function (listener) {
        try { listener() } catch (error) { console.error('homepage: sidebar subscriber failed', error) }
      })
    }
    /**
     * Merge a patch into the live document and notify.
     * @param patch - subset of `{ layout, at, phase, error }`.
     */
    function patchSidebar(patch) {
      if (patch.layout !== undefined) sidebar.layout = patch.layout
      if (patch.at !== undefined) sidebar.at = patch.at
      if (patch.phase !== undefined) sidebar.phase = patch.phase
      if (patch.error !== undefined) sidebar.error = patch.error
      bumpSidebar()
    }
    /**
     * @param error - anything thrown.
     * @returns a message a card can show.
     */
    function sidebarMessage(error) {
      if (!error) return 'unknown error'
      if (typeof error === 'string') return error
      return String(error.message !== undefined ? error.message : error)
    }
    /**
     * The project list the sidebar last handed us, as
     * `{ id, title, path, sessions, rows }` per project, plus the session the
     * main view currently holds in `sidebar.current`.
     *
     * It is display-only cache — deliberately never saved — and it exists
     * because a card has no slot props of its own: naming a member in the
     * manager card would otherwise show raw workspace ids, and the list this
     * plugin draws inside the sidebar has no `useWorkspaces` prop of its own
     * either (it is a custom element, not a slot entry). `WorkspaceReporter`
     * inside the sidebar's own panel icon is the writer; it is mounted for the
     * whole app session, so the list is there before anything reads it.
     *
     * @param entry - anything.
     * @returns one clean `{ id, title, display, blank, running, pinned, archived, updatedAt }`.
     */
    function normalizeSessionRow(entry) {
      var row = entry && typeof entry === 'object' ? entry : {}
      return {
        id: String(row.id === undefined || row.id === null ? '' : row.id),
        title: String(row.title === undefined || row.title === null ? '' : row.title),
        display: String(row.display === undefined || row.display === null ? '' : row.display),
        blank: !!row.blank,
        running: !!row.running,
        pinned: !!row.pinned,
        archived: !!row.archived,
        updatedAt: Number(row.updatedAt) || 0,
      }
    }
    /**
     * @param value - a workspace projection array.
     * @returns a clean projection array.
     */
    function normalizeWorkspaceProjection(value) {
      if (!Array.isArray(value)) return []
      return value.map(function (entry) {
        var item = entry && typeof entry === 'object' ? entry : {}
        var rows = Array.isArray(item.rows) ? item.rows.map(normalizeSessionRow) : []
        return {
          id: String(item.id === undefined || item.id === null ? '' : item.id),
          title: String(item.title === undefined || item.title === null ? '' : item.title),
          path: String(item.path === undefined || item.path === null ? '' : item.path),
          sessions: rows.length || (Number(item.sessions) || 0),
          rows: rows,
        }
      }).filter(function (entry) { return entry.id !== '' })
    }
    /**
     * @param value - an id collection: a Set, a Map or an array.
     * @returns its members as strings.
     */
    function idListOf(value) {
      var ids = []
      if (value && typeof value.forEach === 'function') {
        value.forEach(function (entry) { ids.push(String(entry)) })
      } else if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i += 1) ids.push(String(value[i]))
      }
      return ids
    }
    /**
     * The session the main view holds — the row the shipped browser marks as
     * current. Mirrors `mainSessionId` in
     * `packages/client/ui-workspace/src/client/tree.ts:38`.
     * @param list - the `useSessions` snapshot, or null.
     * @returns the session id, or null.
     */
    function currentSessionId(list) {
      var byId = list && list.byId && typeof list.byId === 'object' ? list.byId : null
      if (!byId) return null
      var ids = Object.keys(byId)
      for (var i = 0; i < ids.length; i += 1) {
        var summary = byId[ids[i]]
        var retained = summary && summary.retainedBy ? summary.retainedBy : null
        if (retained && Number(retained.mainView) > 0) return ids[i]
      }
      return null
    }
    /**
     * Normalise a path for comparison: forward slashes, no trailing separator.
     * @param value - a path, or anything at all.
     * @returns the comparable text.
     */
    function pathTextOf(value) {
      var text = String(value === undefined || value === null ? '' : value).replace(/\\/g, '/')
      while (text.length > 1 && text.charAt(text.length - 1) === '/') text = text.slice(0, -1)
      return text
    }
    /**
     * The workspace a session was created in, found from its own working
     * directory rather than from the registry's assignment. The registry only
     * learns about a new session — or a fork of one — on its next refresh, so a
     * row keyed off that assignment would appear a moment late; the cwd is on
     * the session from the first event. The deepest workspace whose path
     * contains the cwd wins, which is what makes a session started in a
     * subdirectory land on the workspace that owns that directory.
     * @param items - the workspace views.
     * @param cwd - the session's working directory.
     * @returns the owning view, or null.
     */
    function workspaceOfCwd(items, cwd) {
      var target = pathTextOf(cwd)
      if (target === '') return null
      var lower = target.toLowerCase()
      var best = null
      var bestLength = -1
      for (var i = 0; i < items.length; i += 1) {
        var view = items[i] && typeof items[i] === 'object' ? items[i] : null
        if (!view) continue
        var base = pathTextOf(view.path)
        if (base === '') continue
        var baseLower = base.toLowerCase()
        var exact = lower === baseLower
        var inside = lower.length > baseLower.length
          && lower.slice(0, baseLower.length) === baseLower
          && target.charAt(base.length) === '/'
        if ((exact || inside) && base.length > bestLength) {
          best = view
          bestLength = base.length
        }
      }
      return best
    }
    /**
     * @param snapshot - the `useWorkspaces` snapshot a slot occupant receives.
     * @param list - the `useSessions` snapshot, when the caller has one.
     * @returns the projection of its items, with each project's sessions.
     */
    function projectionOfWorkspaces(snapshot, list) {
      var items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
      var byId = list && list.byId && typeof list.byId === 'object' ? list.byId : {}
      var pinned = idListOf(snapshot ? snapshot.pinnedSessionIds : null)
      var archived = idListOf(snapshot ? snapshot.archivedSessionIds : null)
      /**
       * @param key - the session id.
       * @param summary - its session-list summary, or an empty object.
       * @returns the projected row.
       */
      function rowOf(key, summary) {
        return {
          id: key,
          title: summary.title,
          display: summary.displayTitle,
          blank: summary.blank,
          running: summary.running,
          pinned: pinned.indexOf(key) !== -1,
          archived: archived.indexOf(key) !== -1,
          updatedAt: summary.updatedAt,
        }
      }
      var assigned = {}
      var extra = {}
      var projection = items.map(function (item) {
        var view = item && typeof item === 'object' ? item : {}
        var ids = Array.isArray(view.sessionIds) ? view.sessionIds : []
        return {
          id: view.workspaceId,
          title: view.title,
          path: view.path,
          rows: ids.map(function (id) {
            var key = String(id)
            assigned[key] = true
            return rowOf(key, byId[key] && typeof byId[key] === 'object' ? byId[key] : {})
          }),
        }
      })
      // A session the registry has not assigned yet — a new session, or a fork
      // of one — still knows where it was created, so it is filed under that
      // workspace now instead of waiting for the registry to catch up.
      var ids = list && Array.isArray(list.ids) ? list.ids : []
      for (var i = 0; i < ids.length; i += 1) {
        var id = String(ids[i])
        if (assigned[id]) continue
        var summary = byId[id]
        if (!summary || typeof summary !== 'object') continue
        var holder = workspaceOfCwd(items, summary.cwd)
        if (!holder) continue
        var workspaceId = String(holder.workspaceId)
        var rows = extra[workspaceId]
        if (!rows) { rows = []; extra[workspaceId] = rows }
        rows.push(rowOf(id, summary))
      }
      for (var p = 0; p < projection.length; p += 1) {
        var added = extra[String(projection[p].id)]
        if (added && added.length > 0) projection[p].rows = projection[p].rows.concat(added)
      }
      return normalizeWorkspaceProjection(projection)
    }
    /**
     * A cheap fingerprint of a whole projection: comparing strings catches a
     * renamed session or a moved running dot without a deep walk per render.
     * @param items - the projection array.
     * @param current - the current session id, or null.
     * @returns the fingerprint.
     */
    function projectionSignature(items, current) {
      var parts = [String(current || '')]
      for (var i = 0; i < items.length; i += 1) {
        var item = items[i]
        parts.push(item.id, item.title, item.path, String(item.sessions))
        for (var j = 0; j < item.rows.length; j += 1) {
          var row = item.rows[j]
          parts.push(
            row.id, row.title, row.display, row.blank ? '1' : '0', row.running ? '1' : '0',
            row.pinned ? '1' : '0', row.archived ? '1' : '0', String(row.updatedAt),
          )
        }
      }
      return parts.join('\u0001')
    }
    /**
     * Publish the sidebar's project list. Called from an effect, so an
     * unchanged list costs one comparison and no render.
     * @param snapshot - the `useWorkspaces` snapshot, or null.
     * @param list - the `useSessions` snapshot, or null.
     */
    function reportWorkspaces(snapshot, list) {
      var items = projectionOfWorkspaces(snapshot, list)
      var current = currentSessionId(list)
      var signature = projectionSignature(items, current)
      if (signature === sidebar.signature) return
      sidebar.signature = signature
      sidebar.workspaces = items
      sidebar.current = current
      bumpSidebar()
    }


    /**
     * Read the stored document. Concurrent callers share one request.
     * @param force - re-read even when a read has already answered.
     * @returns a promise of the document.
     */
    var sidebarLoad = null
    function loadSidebarLayout(force) {
      if (sidebarLoad && !force) return sidebarLoad
      if (!sidebar.layout) patchSidebar({ phase: 'loading', error: null })
      sidebarLoad = remoteCall('homepage/sidebarLayout', {}).then(function (value) {
        patchSidebar({
          layout: value && value.layout ? value.layout : null,
          at: value && typeof value.at === 'number' ? value.at : 0,
          phase: 'ready',
          error: null,
        })
        return sidebar.layout
      }).catch(function (error) {
        sidebarLoad = null
        patchSidebar({ phase: 'error', error: sidebarMessage(error) })
        throw error
      })
      return sidebarLoad
    }
    /**
     * Edit the document. The editor sees the live layout and returns the next
     * one (or null to decline); the result is published immediately and saved
     * once the edits settle.
     * @param editor - `(layout) => nextLayout`.
     * @returns a promise of the saved document.
     */
    function mutateSidebarLayout(editor) {
      var current = sidebar.layout
      var next = null
      try { next = editor(current) } catch (error) { return Promise.reject(error) }
      if (!next || next === current) return Promise.resolve(current)
      var seq = ++sidebarSaveSeq
      patchSidebar({ layout: next, at: Date.now(), phase: 'saving', error: null })
      return new Promise(function (resolve, reject) {
        if (sidebarSaveTimer) clearTimeout(sidebarSaveTimer)
        sidebarSaveTimer = setTimeout(function () {
          sidebarSaveTimer = null
          remoteCall('homepage/saveSidebarLayout', { layout: sidebar.layout }).then(function (value) {
            if (seq !== sidebarSaveSeq) { resolve(sidebar.layout); return }
            patchSidebar({
              layout: value && value.layout ? value.layout : sidebar.layout,
              at: value && typeof value.at === 'number' ? value.at : sidebar.at,
              phase: 'ready',
              error: null,
            })
            resolve(sidebar.layout)
          }).catch(function (error) {
            if (seq !== sidebarSaveSeq) { resolve(sidebar.layout); return }
            patchSidebar({ phase: 'error', error: sidebarMessage(error) })
            reject(error)
          })
        }, SIDEBAR_SAVE_DEBOUNCE_MS)
      })
    }
    /**
     * Subscribe a component to the document. The first subscriber starts the
     * read, so every entry and the manager card stay on one request.
     * @returns the live sidebar store object.
     */
    function useSidebarLayout() {
      React.useSyncExternalStore(subscribeSidebar, sidebarVersion)
      React.useEffect(function () { loadSidebarLayout(false).catch(function () {}) }, [])
      return sidebar
    }

    // ------------------------------------------------- document editing

    /**
     * Which list the sidebar region shows. `'native'` leaves the shipped
     * workspace browser in charge; `'grouped'` shadows it with this plugin's
     * group-aware list. Anything unrecognised reads as the default, so a host
     * that hands back a future mode still renders a list.
     * @param layout - a document, or the live one when the argument is omitted.
     * @returns `'native'` or `'grouped'`.
     */
    function sidebarMode(layout) {
      var document = layout === undefined ? sidebar.layout : layout
      if (!document) return 'grouped'
      return document.mode === 'native' ? 'native' : 'grouped'
    }
    /**
     * @param layout - the document.
     * @param mode - `'native'` or `'grouped'`.
     * @returns the next document.
     */
    function withMode(layout, mode) {
      var base = layout && typeof layout === 'object' ? layout : {}
      return Object.assign({}, base, { version: SIDEBAR_VERSION, mode: mode === 'native' ? 'native' : 'grouped' })
    }

    /** @returns the groups array of a document (never null). */
    function sidebarGroups(layout) {
      return layout && Array.isArray(layout.groups) ? layout.groups : []
    }
    /** @returns the members map of a document (never null). */
    function sidebarMembers(layout) {
      return layout && layout.members && typeof layout.members === 'object' ? layout.members : {}
    }
    /**
     * @param layout - the document.
     * @param groupId - group id.
     * @returns the group record, or null.
     */
    function sidebarGroupOf(layout, groupId) {
      if (!groupId) return null
      var groups = sidebarGroups(layout)
      for (var i = 0; i < groups.length; i += 1) {
        if (groups[i] && groups[i].id === groupId) return groups[i]
      }
      return null
    }
    /**
     * @param layout - the document.
     * @param workspaceId - workspace id.
     * @returns the member record, or null.
     */
    function sidebarMemberOf(layout, workspaceId) {
      if (!workspaceId) return null
      return sidebarMembers(layout)[workspaceId] || null
    }
    /** @returns the `view.expanded` map of a document (never null). */
    function sidebarExpanded(layout) {
      var view = layout && layout.view && typeof layout.view === 'object' ? layout.view : null
      var map = view && view.expanded && typeof view.expanded === 'object' ? view.expanded : null
      return map || {}
    }
    /**
     * Is one workspace row open? `fallback` is the caller's own default for a row
     * the user has never touched — the shell's answer is "closed", and only the
     * region drawing the row knows whether the current Session makes an
     * exception. `hasOwnProperty`, not truthiness: a stored `false` is the user
     * having closed the row, and it must not read as "no opinion yet" or the
     * next autofocus would reopen it.
     *
     * @param layout - the document.
     * @param workspaceId - workspace id.
     * @param fallback - what to answer when the map has no entry.
     * @returns whether the row is open.
     */
    function sidebarExpandedOf(layout, workspaceId, fallback) {
      var map = sidebarExpanded(layout)
      if (workspaceId && Object.prototype.hasOwnProperty.call(map, workspaceId)) {
        return map[workspaceId] === true
      }
      return fallback === true
    }
    /**
     * The colour a workspace is drawn with: its own tag first, then its group's.
     * @param layout - the document.
     * @param workspaceId - workspace id.
     * @returns `#rrggbb`, or null when untagged.
     */
    function sidebarColorOf(layout, workspaceId) {
      var member = sidebarMemberOf(layout, workspaceId)
      if (member && member.color) return member.color
      var group = sidebarGroupOf(layout, member ? member.group : null)
      return group && group.color ? group.color : null
    }
    /** @returns a group id that cannot collide with one already in the document. */
    function newGroupId(layout) {
      var used = {}
      var groups = sidebarGroups(layout)
      for (var i = 0; i < groups.length; i += 1) used[String(groups[i] && groups[i].id)] = true
      var base = 'g' + Date.now().toString(36)
      var id = base
      var suffix = 1
      while (used[id]) { suffix += 1; id = base + '-' + suffix }
      return id
    }
    /**
     * Append a group.
     * @param layout - the document.
     * @param title - group name.
     * @param color - `#rrggbb`, or null.
     * @returns the next document, and the new group.
     */
    function withNewGroup(layout, title, color) {
      var base = layout && typeof layout === 'object' ? layout : {}
      var group = {
        id: newGroupId(base),
        title: String(title || runtime.t('sidebar.group.new')).slice(0, 60),
        color: color || SIDEBAR_COLORS[sidebarGroups(base).length % SIDEBAR_COLORS.length],
        icon: null,
        order: sidebarGroups(base).length,
        collapsed: false,
        // How the section orders its projects: the order the shell reports them
        // in, or newest first.
        sort: 'manual',
      }
      // Stamped like `withMode`: a structural edit is not a reason to write the
      // document back down to version 1, which the read path would then migrate.
      return { layout: Object.assign({}, base, { version: SIDEBAR_VERSION, groups: sidebarGroups(base).concat([group]) }), group: group }
    }
    /**
     * Patch one group (title, colour, order, collapsed, sort).
     * @param layout - the document.
     * @param groupId - group id.
     * @param patch - fields to merge.
     * @returns the next document.
     */
    function withGroupPatch(layout, groupId, patch) {
      var base = layout && typeof layout === 'object' ? layout : {}
      return Object.assign({}, base, {
        groups: sidebarGroups(base).map(function (group) {
          return group && group.id === groupId ? Object.assign({}, group, patch) : group
        }),
      })
    }
    /**
     * Drop a group; its members fall back to the ungrouped bucket (nothing real
     * is touched, the assignments are simply cleared).
     * @param layout - the document.
     * @param groupId - group id.
     * @returns the next document.
     */
    function withoutGroup(layout, groupId) {
      var base = layout && typeof layout === 'object' ? layout : {}
      var members = sidebarMembers(base)
      var next = {}
      Object.keys(members).forEach(function (id) {
        var member = members[id]
        next[id] = member && member.group === groupId ? Object.assign({}, member, { group: null }) : member
      })
      return Object.assign({}, base, {
        groups: sidebarGroups(base).filter(function (group) { return !group || group.id !== groupId }),
        members: next,
      })
    }
    /**
     * Merge fields into one workspace's member record, creating it when needed.
     * @param layout - the document.
     * @param workspaceId - workspace id (required).
     * @param patch - `{ group, color, hidden, alias, order, pinned }` subset; `group: null` ungroups.
     * @returns the next document.
     */
    function withWorkspace(layout, workspaceId, patch) {
      if (!workspaceId) return layout
      var base = layout && typeof layout === 'object' ? layout : {}
      var members = sidebarMembers(base)
      var current = members[workspaceId] || { group: null, order: Object.keys(members).length, color: null, hidden: false, alias: null, pinned: false }
      var next = {}
      Object.keys(members).forEach(function (id) { next[id] = members[id] })
      next[workspaceId] = Object.assign({}, current, patch)
      // Same stamp as `withMode`: assigning a project must not downgrade the
      // document, or the next read migrates a stored `native` choice away.
      return Object.assign({}, base, { version: SIDEBAR_VERSION, members: next })
    }
    /**
     * Remember whether one workspace row is open. It lives in `view`, not in the
     * member record: forgetting a workspace's colour and group must not also
     * lose where the user had left its row.
     *
     * @param layout - the document.
     * @param workspaceId - workspace id (required).
     * @param expanded - whether the row is open.
     * @returns the next document.
     */
    function withWorkspaceExpanded(layout, workspaceId, expanded) {
      if (!workspaceId) return layout
      var base = layout && typeof layout === 'object' ? layout : {}
      var view = base.view && typeof base.view === 'object' ? base.view : {}
      var current = sidebarExpanded(base)
      var map = {}
      Object.keys(current).forEach(function (id) { map[id] = current[id] })
      map[workspaceId] = expanded === true
      // Same stamp as `withMode`: a view edit must not write the document back
      // down to version 1, which the read path would then migrate.
      return Object.assign({}, base, {
        version: SIDEBAR_VERSION,
        view: Object.assign({}, view, { expanded: map }),
      })
    }
    /**
     * Forget a workspace's member record entirely.
     * @param layout - the document.
     * @param workspaceId - workspace id.
     * @returns the next document.
     */
    function withoutWorkspace(layout, workspaceId) {
      var base = layout && typeof layout === 'object' ? layout : {}
      var members = sidebarMembers(base)
      if (!Object.prototype.hasOwnProperty.call(members, workspaceId)) return base
      var next = {}
      Object.keys(members).forEach(function (id) { if (id !== workspaceId) next[id] = members[id] })
      return Object.assign({}, base, { members: next })
    }

    // --------------------------------------------------- deferred apply work

    /**
     * Card files are spliced into this module and evaluated *before* `apply`
     * runs, so a card that wants to register into a shell slot cannot do it
     * inline. It queues the work here and `apply` runs it with the client
     * context once the services are there.
     */
    var applyTasks = []
    /** @param fn - `(ctx) => void`, run once at apply time. */
    function onApply(fn) { if (typeof fn === 'function') applyTasks.push(fn) }

    /**
     * What a card module is handed. A card file is spliced inside
     * `(function (kit) { ... })(Kit)` by scripts/build-client.mjs, so it pulls the
     * names it needs off `kit` and then registers itself: dropping a file into
     * lib/cards/ is the whole registration step.
     */
    var Kit = {
      h: h, React: React, UI: UI, ICONS: ICONS,
      // The sidebar region's own sheet, so the card modules that draw it can
      // assert a rule lives where they expect (and so a styles test can pin it
      // without loading the whole panel sheet).
      SIDEBAR_STYLES: SIDEBAR_STYLES,
      defineCard: defineCard, removeCard: removeCard, dict: dict, runtime: runtime,
      useRemote: useRemote, useClock: useClock, useAnnounce: useAnnounce, useNoticeOnce: useNoticeOnce,
      remoteCall: remoteCall, requestReload: requestReload, publishReloader: publishReloader,
      pushToast: pushToast, notify: notify, cardApi: cardApi,
      expandCard: expandCard, collapseCard: collapseCard,
      currencySymbol: currencySymbol, primaryWallet: primaryWallet, dayKey: dayKey, kv: kv,
      withAlpha: withAlpha, textOf: textOf, formatNumber: formatNumber, iconOf: iconOf,
      onApply: onApply,
      useSidebarLayout: useSidebarLayout, loadSidebarLayout: loadSidebarLayout,
      mutateSidebarLayout: mutateSidebarLayout, subscribeSidebar: subscribeSidebar,
      SIDEBAR_COLORS: SIDEBAR_COLORS, sidebarMode: sidebarMode, withMode: withMode,
      sidebarServices: sidebarServices, serviceOf: serviceOf,
      sidebarGroupOf: sidebarGroupOf, sidebarMemberOf: sidebarMemberOf, sidebarColorOf: sidebarColorOf,
      sidebarGroups: sidebarGroups, sidebarMembers: sidebarMembers,
      sidebarExpanded: sidebarExpanded, sidebarExpandedOf: sidebarExpandedOf,
      withNewGroup: withNewGroup, withGroupPatch: withGroupPatch, withoutGroup: withoutGroup,
      withWorkspace: withWorkspace, withoutWorkspace: withoutWorkspace,
      withWorkspaceExpanded: withWorkspaceExpanded,
      reportWorkspaces: reportWorkspaces,
    }

    // ------------------------------------------- shipped cards (one file each)
    // Spliced by scripts/build-client.mjs in filename order. Each module
    // self-registers: there is no central list to keep in sync.
    // ------------------------------------------------------------ device
    // lib/cards/device.js
    ;(function (kit) {

      var h = kit.h
      var React = kit.React
      var UI = kit.UI
      var runtime = kit.runtime
      var defineCard = kit.defineCard
      var dict = kit.dict
      var useRemote = kit.useRemote
      var useAnnounce = kit.useAnnounce
      var requestReload = kit.requestReload
      var publishReloader = kit.publishReloader
      var kv = kit.kv

      // -------------------------------------------------------- readings

      /**
       * Bytes as a short human string, base 1024.
       * @param value - a byte count.
       * @returns e.g. `8.4 GB`.
       */
      function bytes(value) {
        var count = Number(value)
        if (!isFinite(count) || count <= 0) return '0 B'
        var units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
        var index = Math.min(units.length - 1, Math.floor(Math.log(count) / Math.log(1024)))
        var scaled = count / Math.pow(1024, index)
        var digits = scaled >= 10 || Math.round(scaled) === scaled ? 0 : 1
        return scaled.toFixed(digits) + ' ' + units[index]
      }

      /**
       * A 0..1 ratio as a whole percentage.
       * @param ratio - the ratio, or null.
       * @returns e.g. `42%`, or an em dash when there is no reading.
       */
      function percent(ratio) {
        var value = Number(ratio)
        if (!isFinite(value)) return '—'
        return Math.round(Math.max(0, Math.min(1, value)) * 100) + '%'
      }

      /**
       * The chip tone for a load ratio.
       * @param ratio - 0..1.
       * @param warn - the ratio that turns it amber.
       * @param danger - the ratio that turns it red.
       * @returns `ok`, `warn` or `error`.
       */
      function loadTone(ratio, warn, danger) {
        var value = Number(ratio) || 0
        if (value >= danger) return 'error'
        if (value >= warn) return 'warn'
        return 'ok'
      }

      /**
       * Seconds as a short duration.
       * @param seconds - an uptime.
       * @returns e.g. `3d 4h`.
       */
      function duration(seconds) {
        var total = Math.max(0, Math.floor(Number(seconds) || 0))
        var days = Math.floor(total / 86400)
        var hours = Math.floor((total % 86400) / 3600)
        var minutes = Math.floor((total % 3600) / 60)
        if (days > 0) return days + 'd ' + hours + 'h'
        if (hours > 0) return hours + 'h ' + minutes + 'm'
        return minutes + 'm'
      }

      /** The temperature unit the card's own control asks for. */
      function unitOf(api) { return api.control('unit') === 'f' ? 'f' : 'c' }

      /**
       * Celsius in the chosen unit.
       * @param temperature - the sample's temperature block.
       * @param unit - `c` or `f`.
       * @returns e.g. `61 °C`, or null when no sensor answered.
       */
      function temperatureText(temperature, unit) {
        var celsius = temperature && typeof temperature.celsius === 'number' ? temperature.celsius : null
        if (celsius === null) return null
        var value = unit === 'f' ? celsius * 9 / 5 + 32 : celsius
        return Math.round(value) + (unit === 'f' ? ' °F' : ' °C')
      }

      /**
       * Why a temperature reading is missing, in the reader's language.
       * @param reason - the host's reason code.
       * @returns the sentence for that code, falling back to the generic one.
       */
      function temperatureReason(t, reason) {
        var known = { noSensor: true, permission: true, unsupported: true, timeout: true, error: true, skipped: true }
        return t('device.tempReason.' + (known[reason] === true ? reason : 'error'))
      }

      /**
       * Why there is no GPU reading, named for a reader. The host reports a
       * probe code, not a sentence; an unknown code falls back to the generic
       * failure instead of printing a dictionary key.
       * @param t - the translator.
       * @param reason - the host's reason code.
       * @returns the sentence for that code.
       */
      function gpuReason(t, reason) {
        var known = { unsupported: true, noCounters: true, permission: true, timeout: true, error: true, skipped: true }
        return t('device.gpuReason.' + (known[reason] === true ? reason : 'error'))
      }

      /**
       * The chip tone for a temperature: 85 °C and up is throttling territory.
       * @param temperature - the sample's temperature block.
       * @returns `ok`, `warn` or `error`.
       */
      function temperatureTone(temperature) {
        var celsius = temperature && typeof temperature.celsius === 'number' ? temperature.celsius : null
        if (celsius === null) return null
        if (celsius >= 85) return 'error'
        if (celsius >= 75) return 'warn'
        return 'ok'
      }

      /**
       * The polling interval, in ms, that the card's own control asks for.
       * @param api - the card's API bag.
       * @returns the interval in ms, at least one second.
       */
      function intervalMs(api) {
        var value = Number(api.control('interval'))
        if (!isFinite(value) || value <= 0) value = 5
        return Math.max(1, value) * 1000
      }

      /**
       * One chart series from the host's sample history.
       * @param history - the sample history, oldest first.
       * @param key - `cpu` (0..1), `memory` (0..1) or `temperature` (celsius).
       * @param unit - `c` or `f`, for the temperature series.
       * @returns `{ values, peak, average, first, last }`, with values on the
       *   fixed 0..100 scale for ratios and on the series' own scale for °C.
       */
      function series(history, key, unit) {
        var points = (history || []).filter(function (entry) { return entry && typeof entry[key] === 'number' })
        var values = points.map(function (entry) {
          var raw = entry[key]
          var clock = new Date(entry.at)
          var stamp = isFinite(clock.getTime()) ? clock.toLocaleTimeString() : ''
          if (key === 'temperature') {
            var shown = unit === 'f' ? raw * 9 / 5 + 32 : raw
            return { value: shown, title: stamp + ' · ' + Math.round(shown) + (unit === 'f' ? ' °F' : ' °C') }
          }
          return { value: raw * 100, title: stamp + ' · ' + percent(raw) }
        })
        var numbers = values.map(function (entry) { return entry.value })
        var sum = numbers.reduce(function (left, right) { return left + right }, 0)
        return {
          values: values,
          peak: numbers.length > 0 ? Math.max.apply(null, numbers) : null,
          average: numbers.length > 0 ? sum / numbers.length : null,
          first: points.length > 0 ? points[0].at : null,
          last: points.length > 0 ? points[points.length - 1].at : null,
        }
      }

      /**
       * The window a chart covers, as a human sentence.
       * @param t - the translator.
       * @param chart - a `series()` result.
       * @returns e.g. `last 42 samples`.
       */
      function windowText(t, chart) {
        var span = chart.first !== null && chart.last !== null ? Math.max(0, chart.last - chart.first) : 0
        // A window shorter than a minute is the normal case here (the default
        // cadence is seconds), and `duration` would render all of it as `0m`.
        var label = span >= 60000 ? duration(span / 1000) : Math.round(span / 1000) + 's'
        return t('device.window', { count: chart.values.length, span: label })
      }

      // ============================================================ 4. device

      /** The compact device card: processor, memory and a temperature verdict. */
      /**
       * One meter row: the name, the share as a percentage, then the share as a
       * bar at the far right.
       * @param name - the row's label.
       * @param ratio - the 0..1 share, or null when there is no reading.
       * @param tone - `warn`/`error` while the reading is under pressure, else null.
       * @param title - the hover line that explains the number.
       * @returns the row element.
       */
      function meter(name, ratio, tone, title) {
        var value = Number(ratio)
        var share = isFinite(value) ? Math.max(0, Math.min(1, value)) : null
        // A ratio of 0.07 is 7.000000000000001% in binary floating point, and a
        // width string like that is noise in the DOM and in every dump.
        var width = share === null ? 0 : Math.round(share * 1000000) / 10000
        return h('div', {
          className: 'ph-meter',
          'data-tone': tone || undefined,
          title: title || undefined,
        },
          h('span', { className: 'ph-meter-name' }, name),
          h('span', { className: 'ph-meter-value' }, percent(ratio)),
          h('span', { className: 'ph-meter-bar' },
            h('span', { className: 'ph-meter-fill', style: { width: width + '%' } })))
      }

      /**
       * The pressure a reading is under, or null while it is calm. A bar that is
       * always green says nothing, so the state colour is reserved for the point
       * where the reading actually needs attention.
       * @param ratio - 0..1.
       * @returns `warn`, `error` or null.
       */
      function pressure(ratio) {
        var value = Number(ratio)
        if (!isFinite(value)) return null
        if (value >= 0.92) return 'error'
        if (value >= 0.75) return 'warn'
        return null
      }

      /**
       * `used / total` when a total is known, else null — a row with no reading
       * must not claim `0 B / 0 B` in its tooltip.
       * @param used - bytes used.
       * @param total - bytes total.
       * @returns the pair, or null.
       */
      function pairText(used, total) {
        return Number(total) > 0 ? bytes(used) + ' / ' + bytes(total) : null
      }

      function DeviceCard(props) {
        var t = props.t
        var api = props.api
        var remote = useRemote('homepage/device', {}, { refreshMs: intervalMs(api) })
        var data = remote.data
        var error = remote.error
        React.useEffect(function () {
          return publishReloader('device', function () { void remote.reload(false) })
        }, [remote.reload])
        // A device that reads fine is not news: only a failed read is worth a
        // bubble. But the host half mounts lazily, so the very first poll after
        // a page load can lose a race and answer 404 while every later poll is
        // fine - a hiccup must not become a notice. The bubble therefore waits
        // for the failure to survive a retry, which is what makes it a
        // condition rather than a race.
        useAnnounce(api, 'device',
          error && remote.failures > 1
            ? { level: 'error', text: t('device.notice.unavailable', { reason: error }) }
            : null)
        if (error) return h('div', null, h(UI.Chip, { tone: 'error' }, t('common.error')), h('p', { className: 'ph-inline-empty' }, error))
        if (!data) return h('div', { className: 'ph-hero ph-hero--wait' }, h('span', { className: 'ph-hero-value' }, '—'))
        var cpu = data.cpu || {}
        var memory = data.memory || {}
        var system = data.system || {}
        var temperature = data.temperature || {}
        var gpu = data.gpu || {}
        var video = gpu.memory || {}
        var heat = temperatureText(temperature, unitOf(api))
        var gpuName = String(gpu.name || '').trim()
        // The preview answers "how loaded is this machine": four readings that
        // each have a ceiling, so the number and the share are read together.
        // Cores, storage and the history live in `DeviceDetail`.
        return h('div', { className: 'ph-specs' },
          h('div', { className: 'ph-meters' },
            meter(t('device.cpu'), cpu.usage, pressure(cpu.usage),
              t('device.cores', { count: cpu.count }) + (cpu.model ? ' · ' + cpu.model : '')),
            meter(t('device.memory'), memory.usage, pressure(memory.usage), pairText(memory.used, memory.total)),
            meter(t('device.gpu'), gpu.usage, pressure(gpu.usage),
              gpuName ? gpuName + (gpu.engine ? ' · ' + gpu.engine : '') : t('device.gpuUnavailable')),
            meter(t('device.vram'), video.usage, pressure(video.usage), pairText(video.used, video.total)),
          ),
          // The adapter names the machine's second processor; it leads the foot
          // row so the two chips stay where every other card puts them.
          h('div', { className: 'ph-hero-row' },
            gpuName ? h('span', { className: 'ph-hero-label ph-row-lead', title: gpuName }, gpuName) : null,
            h(UI.Chip, { tone: temperatureTone(temperature) }, heat || t('device.tempUnavailable')),
            h(UI.Chip, null, t('device.uptime') + ' ' + duration(system.uptime)),
          ),
        )
      }

      var deviceStylesReady = false
      function ensureDeviceStyles() {
        if (deviceStylesReady || typeof runtime.insertCss !== 'function') return
        runtime.insertCss([
          '.ph-device-detail{--ph-device-tint:color-mix(in srgb,var(--ph-accent,#7c3aed) 6%,var(--dsw-alias-bg-layer-1,#fff));width:100%;gap:14px}',
          '.ph-device-detail .ph-device-hero{grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}',
          '.ph-device-hero>.ph-stat{padding:17px 16px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:15px;background:var(--ph-device-tint);gap:7px}',
          '.ph-device-hero .ph-stat-value{font-size:clamp(27px,3.4vw,36px);line-height:1.15;letter-spacing:-.04em;font-weight:700}',
          '.ph-device-detail .ph-stat-label{font-size:12px;white-space:normal}.ph-device-detail .ph-stat-hint{font-size:11px;line-height:1.5;overflow-wrap:anywhere}',
          '.ph-device-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:4px 16px 2px}.ph-device-facts>.ph-stat{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;align-items:baseline}.ph-device-facts .ph-stat-value{font-size:16px;text-align:right;white-space:normal}.ph-device-facts .ph-stat-hint{grid-column:1/-1}',
          '.ph-device-panel{display:flex;flex-direction:column;gap:12px;min-width:0;padding:18px 20px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:16px;background:var(--dsw-alias-bg-layer-1,#fff)}',
          '.ph-device-detail .ph-section-head{flex-wrap:wrap;gap:6px 12px}.ph-device-detail .ph-section-head h4,.ph-device-detail .ph-section-title{font-size:14px;letter-spacing:-.01em}',
          '.ph-device-history>.ph-section-head:not(:first-child){padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,#eef0f2)}.ph-device-history>.ph-section-head:not(:first-child) h4{font-size:12px}.ph-device-history .ph-bars{padding:8px 10px 0;border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f6f7f9)}',
          '.ph-device-detail .ph-axis{justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:11px}',
          '.ph-device-detail .ph-kv{gap:0}.ph-device-detail .ph-kv-row{padding:8px 0;gap:16px}.ph-device-detail .ph-kv-row:last-child{border-bottom:0}.ph-device-detail .ph-kv-key{flex-basis:120px;font-size:12px}.ph-device-detail .ph-kv-value{font-size:12px;line-height:1.5;min-width:0;font-variant-numeric:tabular-nums}',
          '.ph-device-storage .ph-kv{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 18px}.ph-device-storage .ph-kv-row{flex-direction:column;gap:5px;border:0}.ph-device-storage .ph-kv-row:first-child{grid-column:1/-1;flex-direction:row;border-bottom:1px solid var(--dsw-alias-border-l1,#eef0f2)}.ph-device-storage .ph-kv-key{flex-basis:auto}.ph-device-storage .ph-kv-value{font-size:16px;font-weight:600}.ph-device-storage .ph-kv-row:first-child .ph-kv-value{font-size:12px}',
          '@media(max-width:700px){.ph-device-detail .ph-device-hero{grid-template-columns:repeat(2,minmax(0,1fr))}.ph-device-hero>.ph-stat{padding:14px}.ph-device-panel{padding:15px}.ph-device-detail .ph-kv-key{flex-basis:95px}}',
          '@media(max-width:420px){.ph-device-facts{grid-template-columns:1fr;padding:2px 6px}.ph-device-hero .ph-stat-value{font-size:28px}.ph-device-detail .ph-section-head .ph-head-spacer{display:none}.ph-device-detail .ph-kv-row{gap:10px}.ph-device-detail .ph-kv-key{flex-basis:82px}.ph-device-storage .ph-kv-value{font-size:14px}}',
        ].join(''))
        deviceStylesReady = true
      }

      /** The expanded device page: the history, per-core load and the machine's facts. */
      function DeviceDetail(props) {
        ensureDeviceStyles()
        var t = props.t
        var api = props.api
        var unit = unitOf(api)
        var showCores = api.control('cores') !== false
        var remote = useRemote('homepage/device', {}, { refreshMs: intervalMs(api) })
        var data = remote.data
        var error = remote.error
        React.useEffect(function () {
          return publishReloader('device', function () { void remote.reload(false) })
        }, [remote.reload])
        if (error) return h('div', { className: 'ph-detail-block' }, h('div', { className: 'ph-card-error' }, h('strong', null, t('common.error')), h('code', null, error)))
        if (!data) return h('div', { className: 'ph-detail-block' }, h('p', { className: 'ph-inline-empty' }, t('common.refresh') + '…'))

        var cpu = data.cpu || {}
        var memory = data.memory || {}
        var system = data.system || {}
        var disk = data.disk || null
        var temperature = data.temperature || {}
        var gpu = data.gpu || {}
        var video = gpu.memory || {}
        var gpuName = String(gpu.name || '').trim()
        var heat = temperatureText(temperature, unit)
        var cores = Array.isArray(cpu.cores) ? cpu.cores : []
        var load = series(data.history, 'cpu', unit)
        var usage = series(data.history, 'memory', unit)
        var summary = function (chart, scale) {
          if (chart.peak === null) return null
          var peak = scale === 'ratio' ? percent(chart.peak / 100) : Math.round(chart.peak) + (unit === 'f' ? ' °F' : ' °C')
          var average = scale === 'ratio' ? percent(chart.average / 100) : Math.round(chart.average) + (unit === 'f' ? ' °F' : ' °C')
          return t('device.peak') + ' ' + peak + ' · ' + t('device.average') + ' ' + average
        }
        var axis = function (chart) {
          if (chart.first === null) return null
          return h('div', { className: 'ph-axis' },
            h('span', null, new Date(chart.first).toLocaleTimeString()),
            h('span', null, t('device.samples', { count: chart.values.length })),
            h('span', null, new Date(chart.last).toLocaleTimeString()),
          )
        }

        return h('div', { className: 'ph-detail-block ph-device-detail' },
          h('div', { className: 'ph-detail-stats ph-detail-stats--tight ph-device-hero' },
            h(UI.Stat, { label: t('device.cpu'), value: percent(cpu.usage), hint: t('device.cores', { count: cpu.count }) }),
            h(UI.Stat, { label: t('device.memory'), value: percent(memory.usage), hint: bytes(memory.used) + ' / ' + bytes(memory.total) }),
            h(UI.Stat, {
              label: t('device.gpu'),
              value: percent(gpu.usage),
              hint: gpuName ? (gpu.engine ? gpuName + ' · ' + gpu.engine : gpuName) : t('device.gpuUnavailable'),
            }),
            h(UI.Stat, { label: t('device.vram'), value: percent(video.usage), hint: pairText(video.used, video.total) }),
          ),
          h('div', { className: 'ph-device-facts' },
            h(UI.Stat, {
              label: t('device.temperature'),
              value: heat || t('device.tempUnavailable'),
              hint: heat === null ? temperatureReason(t, temperature.reason) : null,
            }),
            h(UI.Stat, { label: t('device.uptime'), value: duration(system.uptime), hint: system.hostname || null }),
          ),

          h('section', { className: 'ph-device-panel ph-device-history', 'aria-label': t('device.history') },
          h('div', { className: 'ph-section-head' },
            h('h4', null, t('device.history')),
            h('span', { className: 'ph-head-spacer' }),
            h('span', { className: 'ph-note' }, windowText(t, load)),
          ),
          h('div', { className: 'ph-section-head' },
            h('h4', { className: 'ph-section-title' }, t('device.cpuHistory')),
            h('span', { className: 'ph-head-spacer' }),
            h('span', { className: 'ph-note' }, summary(load, 'ratio')),
          ),
          h(UI.Bars, { values: load.values, max: 100, height: 56 }),
          h('div', { className: 'ph-section-head' },
            h('h4', { className: 'ph-section-title' }, t('device.memoryHistory')),
            h('span', { className: 'ph-head-spacer' }),
            h('span', { className: 'ph-note' }, summary(usage, 'ratio')),
          ),
          h(UI.Bars, { values: usage.values, max: 100, height: 56 }),
          axis(load),
          ),

          showCores && cores.length > 0 ? h('section', { className: 'ph-device-panel', 'aria-label': t('device.coresTitle') },
            h('h4', { className: 'ph-section-title' }, t('device.coresTitle')),
            h(UI.Bars, {
              values: cores.map(function (value, index) {
                return { value: (Number(value) || 0) * 100, title: t('device.core', { index: index + 1 }) + ' · ' + percent(value) }
              }),
              max: 100,
              height: 48,
            }),
          ) : null,

          disk ? h('section', { className: 'ph-device-panel ph-device-storage', 'aria-label': t('device.storage') },
            h('h4', { className: 'ph-section-title' }, t('device.storage')),
            h('div', { className: 'ph-kv' },
              kv(t('device.volume'), disk.path + ' · ' + percent(disk.usage)),
              kv(t('device.used'), bytes(disk.used)),
              kv(t('device.free'), bytes(disk.free)),
              kv(t('device.total'), bytes(disk.total)),
            ),
          ) : null,

          h('section', { className: 'ph-device-panel ph-device-system', 'aria-label': t('device.system') },
          h('h4', { className: 'ph-section-title' }, t('device.system')),
          h('div', { className: 'ph-kv' },
            kv(t('device.processor'), cpu.model || '—'),
            kv(t('device.gpu'), gpuName || (gpu.reason ? gpuReason(t, gpu.reason) : '—')),
            pairText(video.used, video.total) ? kv(t('device.vram'), pairText(video.used, video.total)) : null,
            kv(t('device.speed'), cpu.speedMhz ? cpu.speedMhz + ' MHz' : '—'),
            kv(t('device.coresTitle'), String(cpu.count === undefined ? '—' : cpu.count)),
            cpu.loadavg ? kv(t('device.loadavg'), cpu.loadavg.map(function (value) { return Number(value).toFixed(2) }).join(' · ')) : null,
            kv(t('device.platform'), system.platform + ' · ' + system.arch + ' · ' + system.release),
            kv(t('device.hostname'), system.hostname || '—'),
            kv(t('device.node'), system.node || '—'),
            kv(t('device.sampled'), new Date(data.at).toLocaleString()),
            kv(t('device.cadence'), t('device.cadenceValue', { seconds: Math.round(intervalMs(api) / 1000) })),
          ),
          ),
        )
      }
        defineCard({
          id: 'device',
          shipped: true,
          order: 40,
          title: function () { return runtime.t('card.device.title') },
          icon: 'device',
          size: { w: 2, h: 2 },
          // Four meter rows need two rows of height: at 2x1 the last rows would
          // be clipped by the card's own overflow, which reads as a bug.
          minSize: { w: 2, h: 2 },
          maxSize: { w: 4, h: 3 },
          accent: '#7c3aed',
          texture: true,
          effects: { outline: 'scan', sheen: false, ripple: false, float: false },
          content: function (api) { return h(DeviceCard, { api: api, t: runtime.t }) },
          detail: function (api) { return h(DeviceDetail, { api: api, t: runtime.t }) },
          detailActions: [
            {
              id: 'interval', type: 'segmented', label: function () { return runtime.t('device.interval') }, value: '5',
              options: [
                { value: '2', label: function () { return runtime.t('device.every', { seconds: 2 }) } },
                { value: '5', label: function () { return runtime.t('device.every', { seconds: 5 }) } },
                { value: '15', label: function () { return runtime.t('device.every', { seconds: 15 }) } },
                { value: '60', label: function () { return runtime.t('device.every', { seconds: 60 }) } },
              ],
            },
            { id: 'unit', type: 'switch', label: function () { return runtime.t('device.unit') }, value: false },
            { id: 'cores', type: 'switch', label: function () { return runtime.t('device.showCores') }, value: true },
            {
              id: 'refresh', type: 'combo', label: function () { return runtime.t('common.refresh') }, value: 'now',
              options: [{ value: 'now', label: function () { return runtime.t('common.refresh') } }],
              run: function () { requestReload('device', false) },
            },
          ],
        })

      dict({
        zh: {
          'card.device.title': '设备状态',
          'device.cpu': '处理器',
          'device.cores': '{count} 核',
          'device.core': '核心 {index}',
          'device.memory': '内存',
          'device.gpu': 'GPU',
          'device.vram': '显存',
          'device.gpuUnavailable': '未检测到独立的 GPU 计数器',
          'device.gpuReason.unsupported': '此平台不提供 GPU 计数器',
          'device.gpuReason.noCounters': '系统未启用 GPU 性能计数器',
          'device.gpuReason.permission': '无权读取 GPU 计数器',
          'device.gpuReason.timeout': '读取 GPU 计数器超时',
          'device.gpuReason.skipped': '本次采样跳过了 GPU',
          'device.gpuReason.error': '读取 GPU 计数器失败',
          'device.temperature': '温度',
          'device.tempUnavailable': '温度不可用',
          'device.uptime': '已运行',
          'device.history': '负载历史',
          'device.cpuHistory': '处理器占用',
          'device.memoryHistory': '内存占用',
          'device.window': '最近 {count} 次采样 · {span}',
          'device.samples': '{count} 次采样',
          'device.peak': '峰值',
          'device.average': '平均',
          'device.coresTitle': '每核心',
          'device.storage': '存储',
          'device.volume': '卷',
          'device.used': '已用',
          'device.free': '可用',
          'device.total': '容量',
          'device.system': '运行环境',
          'device.processor': '处理器型号',
          'device.speed': '主频',
          'device.loadavg': '平均负载',
          'device.platform': '系统',
          'device.hostname': '主机名',
          'device.node': 'Node',
          'device.sampled': '采样于',
          'device.cadence': '采样间隔',
          'device.cadenceValue': '{seconds} 秒',
          'device.tempReason.noSensor': '系统没有提供温度传感器',
          'device.tempReason.permission': '读取温度被拒绝，通常需要管理员权限',
          'device.tempReason.unsupported': '当前平台不支持读取温度',
          'device.tempReason.timeout': '读取温度超时',
          'device.tempReason.error': '读取温度失败',
          'device.tempReason.skipped': '周期采样不读温度',
          'device.notice.unavailable': '读不到设备状态：{reason}',
          'device.interval': '刷新',
          'device.every': '{seconds} 秒',
          'device.unit': '华氏度',
          'device.showCores': '显示每核',
        },
        en: {
          'card.device.title': 'Device',
          'device.cpu': 'Processor',
          'device.cores': '{count} cores',
          'device.core': 'Core {index}',
          'device.memory': 'Memory',
          'device.gpu': 'GPU',
          'device.vram': 'VRAM',
          'device.gpuUnavailable': 'No GPU counters found',
          'device.gpuReason.unsupported': 'this platform has no GPU counters',
          'device.gpuReason.noCounters': 'GPU performance counters are not enabled',
          'device.gpuReason.permission': 'the GPU counters are not readable',
          'device.gpuReason.timeout': 'reading the GPU counters timed out',
          'device.gpuReason.skipped': 'this sample skipped the GPU',
          'device.gpuReason.error': 'reading the GPU counters failed',
          'device.temperature': 'Temperature',
          'device.tempUnavailable': 'No temperature',
          'device.uptime': 'Up',
          'device.history': 'Load history',
          'device.cpuHistory': 'Processor load',
          'device.memoryHistory': 'Memory load',
          'device.window': 'last {count} samples · {span}',
          'device.samples': '{count} samples',
          'device.peak': 'peak',
          'device.average': 'average',
          'device.coresTitle': 'Per core',
          'device.storage': 'Storage',
          'device.volume': 'Volume',
          'device.used': 'Used',
          'device.free': 'Free',
          'device.total': 'Capacity',
          'device.system': 'Runtime',
          'device.processor': 'Processor model',
          'device.speed': 'Clock',
          'device.loadavg': 'Load average',
          'device.platform': 'System',
          'device.hostname': 'Hostname',
          'device.node': 'Node',
          'device.sampled': 'Sampled at',
          'device.cadence': 'Interval',
          'device.cadenceValue': '{seconds} s',
          'device.tempReason.noSensor': 'The system exposes no temperature sensor',
          'device.tempReason.permission': 'Reading the temperature was refused; it usually needs administrator rights',
          'device.tempReason.unsupported': 'This platform has no temperature reading',
          'device.tempReason.timeout': 'Reading the temperature timed out',
          'device.tempReason.error': 'Reading the temperature failed',
          'device.tempReason.skipped': 'The periodic sample skips the temperature',
          'device.notice.unavailable': 'Cannot read the device state: {reason}',
          'device.interval': 'Refresh',
          'device.every': '{seconds}s',
          'device.unit': 'Fahrenheit',
          'device.showCores': 'Per core',
        },
      })
    })(Kit)

    // --------------------------------------------------------------- dsh
    // lib/cards/dsh.js
    ;(function (kit) {

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
    })(Kit)

    // ----------------------------------------------------------- hygiene
    // lib/cards/hygiene.js
    ;(function (kit) {

  var h = kit.h
  var React = kit.React
  var UI = kit.UI
  var ICONS = kit.ICONS
  var runtime = kit.runtime
  var defineCard = kit.defineCard
  var dict = kit.dict
  var useRemote = kit.useRemote
  var pushToast = kit.pushToast

  var ACCENT = '#a06a1f'
  var LOG_DAYS = 7
  var DAY_MS = 24 * 60 * 60 * 1000
  var UNIT_NAMES = ['B', 'KB', 'MB', 'GB', 'TB']

  /**
   * Coerce a value to a usable byte count.
   * @param {unknown} value - anything a host document might carry.
   * @returns {number} a finite, non-negative number.
   */
  function toNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0
    if (typeof value === 'string' && value.trim() !== '') {
      var parsed = Number(value)
      if (Number.isFinite(parsed) && parsed > 0) return parsed
    }
    return 0
  }

  /**
   * Coerce a value to display text.
   * @param {unknown} value - anything a host document might carry.
   * @param {string} fallback - text used when the value is missing.
   * @returns {string} the text.
   */
  function toText(value, fallback) {
    if (typeof value === 'string') return value
    if (value === undefined || value === null) return fallback
    try {
      return String(value)
    } catch (error) {
      return fallback
    }
  }

  /**
   * Format a byte count the way the card shows every size.
   * @param {unknown} value - byte count.
   * @returns {string} e.g. `0 B`, `980 B`, `1.5 KB`, `97 MB`.
   */
  function formatBytes(value) {
    var bytes = toNumber(value)
    if (bytes <= 0) return '0 B'
    if (bytes < 1024) return Math.round(bytes) + ' B'
    var size = bytes
    var unit = 0
    while (size >= 1024 && unit < UNIT_NAMES.length - 1) {
      size /= 1024
      unit += 1
    }
    var text = size.toFixed(size >= 100 ? 0 : 1)
    if (text.slice(-2) === '.0') text = text.slice(0, -2)
    return text + ' ' + UNIT_NAMES[unit]
  }

  /**
   * Pull a human reason out of whatever a failed action returned.
   * @param {unknown} result - a structured failure, an Error, or a string.
   * @returns {string} a trimmed message, or ''.
   */
  function failureReason(result) {
    if (result === undefined || result === null) return ''
    if (typeof result === 'string') return result.trim()
    if (typeof result !== 'object') return toText(result, '').trim()
    var parts = [result.error, result.message, result.reason]
    for (var index = 0; index < parts.length; index += 1) {
      var part = parts[index]
      if (part === undefined || part === null || part === '') continue
      if (typeof part === 'object' && typeof part.message === 'string') return part.message.trim()
      var text = toText(part, '').trim()
      if (text !== '') return text
    }
    return ''
  }

  /**
   * Reduce a host document to the numbers and rows this card draws.
   *
   * Pure and defensive: a missing document, a partial one, and one with strings
   * where numbers belong all answer with the same shape. The host's own totals
   * win when present; the category rows are the fallback breakdown.
   * @param {unknown} doc - the `homepage/hygiene` document.
   * @param {unknown} failure - the remote error, if there was one.
   * @returns {object} the reading the card renders.
   */
  function summarize(doc, failure) {
    var source = doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc : null
    var rows = source !== null && Array.isArray(source.categories) ? source.categories : []
    var categories = []
    var sumBytes = 0
    var sumFiles = 0
    var sumReclaimBytes = 0
    var sumReclaimFiles = 0
    var largestBytes = 0

    for (var index = 0; index < rows.length; index += 1) {
      var item = rows[index]
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      var id = toText(item.id, '').trim()
      if (id === '') continue
      var bytes = toNumber(item.bytes)
      var files = Math.round(toNumber(item.files))
      var reclaimBytes = toNumber(item.reclaimableBytes)
      var reclaimFiles = Math.round(toNumber(item.reclaimableFiles))
      categories.push({
        id: id,
        path: toText(item.path, ''),
        exists: item.exists === true,
        bytes: bytes,
        files: files,
        truncated: item.truncated === true,
        reclaimableBytes: reclaimBytes,
        reclaimableFiles: reclaimFiles,
      })
      sumBytes += bytes
      sumFiles += files
      sumReclaimBytes += reclaimBytes
      sumReclaimFiles += reclaimFiles
      if (bytes > largestBytes) largestBytes = bytes
    }

    var errorText = failureReason(failure)
    var available = source !== null && source.available === true
    return {
      available: available,
      loading: source === null && errorText === '',
      reason: toText(source === null ? '' : source.reason, '').trim(),
      error: errorText,
      root: toText(source === null ? '' : source.root, '').trim(),
      at: toNumber(source === null ? 0 : source.at),
      totalBytes: source !== null && typeof source.totalBytes === 'number' && source.totalBytes >= 0 ? source.totalBytes : sumBytes,
      totalFiles: source !== null && typeof source.totalFiles === 'number' && source.totalFiles >= 0 ? source.totalFiles : sumFiles,
      reclaimableBytes:
        source !== null && typeof source.reclaimableBytes === 'number' && source.reclaimableBytes >= 0
          ? source.reclaimableBytes
          : sumReclaimBytes,
      reclaimableFiles:
        source !== null && typeof source.reclaimableFiles === 'number' && source.reclaimableFiles >= 0
          ? source.reclaimableFiles
          : sumReclaimFiles,
      categoryCount: categories.length,
      largestBytes: largestBytes,
      categories: categories,
    }
  }

  var STYLE = [
    '.ph-hy{--ph-hy-accent:' + ACCENT + ';',
    '--ph-hy-ink:var(--dsw-alias-label-primary,#1f2328);',
    '--ph-hy-ink2:var(--dsw-alias-label-secondary,#57606a);',
    '--ph-hy-ink3:var(--dsw-alias-label-tertiary,#8b949e);',
    '--ph-hy-line:var(--dsw-alias-border-l2,#e5e7eb);',
    '--ph-hy-line-soft:var(--dsw-alias-border-l1,#eef0f2);',
    '--ph-hy-surface:var(--dsw-alias-bg-layer-1,#fff);',
    '--ph-hy-sunken:var(--dsw-alias-bg-layer-2,#f6f7f9);',
    '--ph-hy-hover:var(--dsw-alias-interactive-bg-hover,rgba(31,35,40,.045));',
    '--ph-hy-warn:var(--dsw-alias-state-warn-primary,#b45309);',
    '--ph-hy-error:var(--dsw-alias-state-error-primary,#dc2626);',
    'color:var(--ph-hy-ink)}',
    '.ph-hy-preview{display:flex;flex-direction:column;justify-content:space-between;gap:6px;height:100%;min-height:0}',
    '.ph-hy-readings{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}',
    '.ph-hy-hero,.ph-hy-side{display:flex;flex-direction:column;min-width:0}',
    '.ph-hy-side{align-items:flex-end;text-align:right}',
    '.ph-hy-hero-num{font-size:clamp(22px,2.4vw,30px);font-weight:650;line-height:1.05;letter-spacing:-.02em;font-variant-numeric:tabular-nums}',
    '.ph-hy-hero-label,.ph-hy-side-label{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--ph-hy-ink3);white-space:nowrap}',
    '.ph-hy-side-num{font-size:16px;font-weight:650;line-height:1.2;color:var(--ph-hy-accent);font-variant-numeric:tabular-nums}',
    '.ph-hy-foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--ph-hy-ink2);min-height:16px}',
    '.ph-hy-sep{color:var(--ph-hy-ink3)}',
    '.ph-hy-warn{display:inline-flex;align-items:center;gap:5px;margin-left:auto;padding:1px 7px;border-radius:999px;background:var(--ph-hy-sunken);color:var(--ph-hy-warn);font-size:10.5px;white-space:nowrap}',
    '.ph-hy-warn-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}',
    '.ph-hy-loading{margin:0;font-size:11px;color:var(--ph-hy-ink3)}',
    '.ph-hy-flag{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ph-hy-warn)}',
    '.ph-hy-flag svg{flex:none}',
    '.ph-hy-page{display:flex;flex-direction:column;gap:14px;max-width:760px;width:100%}',
    '.ph-hy-head{display:flex;align-items:center;justify-content:flex-end;gap:9px}',
    '.ph-hy-head-spacer{flex:1}',
    '.ph-hy-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:1px solid var(--ph-hy-line);border-radius:9px;background:var(--ph-hy-surface);color:var(--ph-hy-ink2);cursor:pointer}',
    '.ph-hy-iconbtn:disabled{opacity:.5;cursor:default}',
    '.ph-hy-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}',
    '.ph-hy-stats .ph-stat{padding:9px 11px;border:1px solid var(--ph-hy-line);border-radius:12px;background:var(--ph-hy-sunken)}',
    '.ph-hy-stats .ph-stat-value{font-variant-numeric:tabular-nums}',
    '.ph-hy-block-title{margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--ph-hy-ink3)}',
    '.ph-hy-rows{display:flex;flex-direction:column;gap:7px}',
    '.ph-hy-row{padding:9px 12px;border:1px solid var(--ph-hy-line);border-radius:12px;background:var(--ph-hy-surface)}',
    '.ph-hy-row.is-absent{opacity:.55}',
    '.ph-hy-row-top{display:flex;align-items:baseline;gap:8px}',
    '.ph-hy-row-name{font-size:13px;font-weight:600;min-width:0;white-space:nowrap}',
    '.ph-hy-row-size{margin-left:auto;font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.ph-hy-row-files{font-size:11px;color:var(--ph-hy-ink3);white-space:nowrap}',
    '.ph-hy-bar{height:4px;margin-top:7px;border-radius:2px;background:var(--ph-hy-line-soft);overflow:hidden}',
    '.ph-hy-bar i{display:block;height:100%;border-radius:2px;background:var(--ph-hy-accent);opacity:.85}',
    '.ph-hy-chip{padding:1px 6px;border:1px solid var(--ph-hy-warn);border-radius:999px;color:var(--ph-hy-warn);font-size:10px;white-space:nowrap}',
    '.ph-hy-empty{display:flex;flex-direction:column;gap:3px;padding:10px 12px;border:1px solid var(--ph-hy-warn);border-radius:12px;background:var(--ph-hy-sunken)}',
    '.ph-hy-empty b{font-size:12px;color:var(--ph-hy-warn)}',
    '.ph-hy-empty span{font-size:11px;color:var(--ph-hy-ink2)}',
    '.ph-hy-clean{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:12px 14px;border:1px solid var(--ph-hy-line);border-radius:14px;background:var(--ph-hy-sunken)}',
    '.ph-hy-clean-text{min-width:0;display:flex;flex-direction:column;gap:3px}',
    '.ph-hy-clean-title{margin:0;font-size:13px;font-weight:650}',
    '.ph-hy-clean-note{margin:0;font-size:12px;color:var(--ph-hy-ink2)}',
    '.ph-hy-clean-counts{margin:0;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}',
    '.ph-hy-clean-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.ph-hy-confirm-q{font-size:12px;color:var(--ph-hy-warn)}',
    '.ph-hy-btn{padding:6px 12px;border:1px solid var(--ph-hy-line);border-radius:9px;background:var(--ph-hy-surface);color:var(--ph-hy-ink);font-size:12px;font-weight:600;cursor:pointer}',
    '.ph-hy-btn:disabled{opacity:.5;cursor:default}',
    '.ph-hy-btn.is-primary{border-color:transparent;background:var(--ph-hy-accent);color:#fff}',
    '.ph-hy-btn.is-danger{border-color:transparent;background:var(--ph-hy-warn);color:#fff}',
    '@media (hover:hover) and (pointer:fine){',
    '.ph-hy-iconbtn:hover:not(:disabled){background:var(--ph-hy-hover)}',
    '.ph-hy-btn:hover:not(:disabled){background:var(--ph-hy-hover)}',
    '.ph-hy-btn.is-primary:hover:not(:disabled),.ph-hy-btn.is-danger:hover:not(:disabled){filter:brightness(1.06)}',
    '}',
    '@media (max-width:760px){',
    '.ph-hy-stats{grid-template-columns:repeat(2,minmax(0,1fr))}',
    '.ph-hy-clean{align-items:stretch}',
    '.ph-hy-clean-actions{justify-content:flex-end}',
    '}',
    '@media (prefers-reduced-motion:reduce){.ph-hy,.ph-hy *{transition:none!important;animation:none!important}}',
  ].join('')

  var styleSeat = { done: false }

  /**
   * Insert the card stylesheet once per window.
   * @returns {void}
   */
  function ensureStyles() {
    if (styleSeat.done) return
    styleSeat.done = true
    try {
      runtime.insertCss(STYLE)
    } catch (error) {
      void error
    }
  }

  /**
   * The 2x1 preview: readings only, no controls.
   * @param {object} props - `{ api, t }`.
   * @returns {object} the preview element.
   */
  function HygieneCard(props) {
    ensureStyles()
    var t = props.t
    var remote = useRemote('homepage/hygiene', { options: {} }, { refreshMs: 120000 })
    var reading = summarize(remote.data, remote.error)
    var notices = null
    if (reading.loading) {
      notices = h('p', { className: 'ph-hy-loading' }, t('hygiene.loading'))
    } else if (!reading.available) {
      notices = h(
        'div',
        { className: 'ph-hy-flag' },
        ICONS.warn(13),
        h('span', null, t('hygiene.unavailable.title')),
      )
    }
    return h(
      'div',
      { className: 'ph-hy ph-hy-preview' + (reading.available ? '' : ' is-unavailable') },
      h(
        'div',
        { className: 'ph-hy-readings' },
        h(
          'div',
          { className: 'ph-hy-hero', title: reading.root || undefined },
          h('span', { className: 'ph-hy-hero-num' }, formatBytes(reading.totalBytes)),
          h('span', { className: 'ph-hy-hero-label' }, t('hygiene.preview.data')),
        ),
        h(
          'div',
          { className: 'ph-hy-side' },
          h('span', { className: 'ph-hy-side-num' }, formatBytes(reading.reclaimableBytes)),
          h('span', { className: 'ph-hy-side-label' }, t('hygiene.preview.reclaim')),
        ),
      ),
      notices,
      h(
        'div',
        { className: 'ph-hy-foot' },
        h('span', null, t('hygiene.preview.categories', { count: reading.categoryCount })),
        h('span', { className: 'ph-hy-sep' }, '·'),
        h('span', null, t('hygiene.files', { count: reading.totalFiles })),
        reading.reclaimableFiles > 0
          ? h(
              'span',
              { className: 'ph-hy-warn' },
              h('i', { className: 'ph-hy-warn-dot' }),
              t('hygiene.preview.reclaimFiles', { count: reading.reclaimableFiles }),
            )
          : null,
      ),
    )
  }

  /**
   * One category row with a size bar relative to the largest category.
   * @param {object} props - `{ item, largest, t }`.
   * @returns {object} the row element.
   */
  function CategoryRow(props) {
    var item = props.item
    var t = props.t
    var share = props.largest > 0 ? Math.max(2, Math.round((item.bytes / props.largest) * 100)) : 0
    return h(
      'div',
      { className: 'ph-hy-row' + (item.exists ? '' : ' is-absent'), title: item.path || undefined },
      h(
        'div',
        { className: 'ph-hy-row-top' },
        h('span', { className: 'ph-hy-row-name' }, t('hygiene.category.' + item.id)),
        item.truncated ? h('span', { className: 'ph-hy-chip' }, t('hygiene.truncated')) : null,
        h('span', { className: 'ph-hy-row-size' }, formatBytes(item.bytes)),
        h('span', { className: 'ph-hy-row-files' }, t('hygiene.files', { count: item.files })),
      ),
      h('div', { className: 'ph-hy-bar' }, h('i', { style: { width: share + '%' } })),
    )
  }

  /**
   * The expanded page: stats, category rows, and the guarded cleanup block.
   * @param {object} props - `{ api, t }`.
   * @returns {object} the page element.
   */
  function HygieneDetail(props) {
    ensureStyles()
    var api = props.api
    var t = props.t
    var remote = useRemote('homepage/hygiene', { options: {} }, { refreshMs: 120000 })
    var busyState = React.useState(false)
    var busy = busyState[0]
    var setBusy = busyState[1]
    var confirmState = React.useState(false)
    var confirming = confirmState[0]
    var setConfirming = confirmState[1]
    var reading = summarize(remote.data, remote.error)
    var cleanable = reading.available && reading.reclaimableFiles > 0

    /**
     * Re-scan the home without flashing the busy state.
     * @returns {void}
     */
    function refresh() {
      void remote.reload(true)
    }

    /**
     * Enter the two-step confirm.
     * @returns {void}
     */
    function askConfirm() {
      if (!cleanable || busy) return
      setConfirming(true)
    }

    /**
     * Leave the confirm without deleting anything.
     * @returns {void}
     */
    function cancelConfirm() {
      if (busy) return
      setConfirming(false)
    }

    /**
     * Call the one write action and report its outcome.
     * @returns {void}
     */
    function runClean() {
      if (busy) return
      setBusy(true)
      Promise.resolve()
        .then(function () {
          if (typeof api.act !== 'function') throw new Error(t('hygiene.clean.reason'))
          return api.act('hygiene.logs.prune', { olderThanDays: LOG_DAYS })
        })
        .then(
          function (result) {
            if (result !== null && typeof result === 'object' && result.ok === true) {
              var value = result.value !== null && typeof result.value === 'object' ? result.value : {}
              pushToast(
                t('hygiene.clean.done', {
                  count: Math.round(toNumber(value.removed)),
                  size: formatBytes(value.bytes),
                }),
              )
              setConfirming(false)
              void remote.reload(true)
              return
            }
            pushToast(
              t('hygiene.clean.failed', {
                reason: failureReason(result) || t('hygiene.clean.reason'),
              }),
              'error',
            )
          },
          function (error) {
            pushToast(
              t('hygiene.clean.failed', {
                reason: failureReason(error) || t('hygiene.clean.reason'),
              }),
              'error',
            )
          },
        )
        .then(
          function () {
            setBusy(false)
          },
          function () {
            setBusy(false)
          },
        )
    }

    var notices = null
    if (reading.loading) {
      notices = h('p', { className: 'ph-hy-loading' }, t('hygiene.loading'))
    } else if (!reading.available) {
      notices = h(
        'div',
        { className: 'ph-hy-empty' },
        h('b', null, t('hygiene.unavailable.title')),
        h('span', null, reading.error ? t('hygiene.load.failed', { reason: reading.error }) : t('hygiene.unavailable.hint')),
      )
    }

    var actions = null
    if (confirming) {
      actions = [
        h(
          'span',
          { key: 'question', className: 'ph-hy-confirm-q' },
          t('hygiene.clean.confirm', {
            count: reading.reclaimableFiles,
            size: formatBytes(reading.reclaimableBytes),
          }),
        ),
        h(
          'button',
          {
            key: 'go',
            type: 'button',
            className: 'ph-hy-btn is-danger',
            onClick: runClean,
            disabled: busy,
          },
          busy ? t('hygiene.clean.busy') : t('hygiene.clean.confirmGo'),
        ),
        h(
          'button',
          {
            key: 'cancel',
            type: 'button',
            className: 'ph-hy-btn',
            onClick: cancelConfirm,
            disabled: busy,
          },
          t('hygiene.clean.cancel'),
        ),
      ]
    } else {
      actions = h(
        'button',
        {
          type: 'button',
          className: 'ph-hy-btn is-primary',
          onClick: askConfirm,
          disabled: !cleanable || busy,
        },
        t('hygiene.clean.action'),
      )
    }

    return h(
      'div',
      { className: 'ph-hy ph-hy-page' },
      h(
        'header',
        { className: 'ph-hy-head' },
        h('span', { className: 'ph-hy-head-spacer' }),
        h(
          'button',
          {
            type: 'button',
            className: 'ph-hy-iconbtn',
            title: t('hygiene.page.refresh'),
            'aria-label': t('hygiene.page.refresh'),
            onClick: refresh,
            disabled: remote.busy === true,
          },
          ICONS.refresh(15),
        ),
      ),
      notices,
      h(
        'div',
        { className: 'ph-hy-stats' },
        h(UI.Stat, { label: t('hygiene.stat.total'), value: formatBytes(reading.totalBytes) }),
        h(UI.Stat, { label: t('hygiene.stat.files'), value: String(reading.totalFiles) }),
        h(UI.Stat, { label: t('hygiene.stat.categories'), value: String(reading.categoryCount) }),
        h(UI.Stat, { label: t('hygiene.stat.reclaim'), value: formatBytes(reading.reclaimableBytes) }),
      ),
      h(
        'section',
        { className: 'ph-hy-block' },
        h('h4', { className: 'ph-hy-block-title' }, t('hygiene.page.categories')),
        h(
          'div',
          { className: 'ph-hy-rows' },
          reading.categories.map(function (item) {
            return h(CategoryRow, { key: item.id, item: item, largest: reading.largestBytes, t: t })
          }),
        ),
      ),
      h(
        'section',
        { className: 'ph-hy-clean' },
        h(
          'div',
          { className: 'ph-hy-clean-text' },
          h('h4', { className: 'ph-hy-clean-title' }, t('hygiene.clean.title')),
          h('p', { className: 'ph-hy-clean-note' }, t('hygiene.clean.note')),
          h(
            'p',
            { className: 'ph-hy-clean-counts' },
            cleanable
              ? t('hygiene.clean.counts', {
                  count: reading.reclaimableFiles,
                  size: formatBytes(reading.reclaimableBytes),
                })
              : t('hygiene.clean.none'),
          ),
        ),
        h('div', { className: 'ph-hy-clean-actions' }, actions),
      ),
    )
  }

  defineCard({
    id: 'hygiene',
    shipped: true,
    order: 45,
    title: function () {
      return runtime.t('hygiene.title')
    },
    icon: function (size) {
      return ICONS.layers(size)
    },
    size: { w: 2, h: 1 },
    minSize: { w: 1, h: 1 },
    maxSize: { w: 4, h: 3 },
    accent: ACCENT,
    texture: { icon: 'layers', opacity: 5, size: 118, bleed: '-16%' },
    tags: ['storage', 'logs', 'cleanup'],
    refreshMs: 120000,
    content: function (api) {
      return h(HygieneCard, { api: api, t: runtime.t })
    },
    detail: function (api) {
      return h(HygieneDetail, { api: api, t: runtime.t })
    },
    formatBytes: formatBytes,
    summarize: summarize,
    dict: {
      zh: {
        'hygiene.title': 'DSH 存储',
        'hygiene.preview.data': 'DSH 数据',
        'hygiene.preview.reclaim': '可清理',
        'hygiene.preview.categories': '{count} 个分类',
        'hygiene.preview.reclaimFiles': '{count} 个旧日志',
        'hygiene.files': '{count} 个文件',
        'hygiene.loading': '读取中…',
        'hygiene.load.failed': '读取失败：{reason}',
        'hygiene.unavailable.title': '数据目录不可用',
        'hygiene.unavailable.hint': '未找到 DSH 数据目录，或无法读取。',
        'hygiene.page.refresh': '刷新',
        'hygiene.page.categories': '分类占用',
        'hygiene.stat.total': '总占用',
        'hygiene.stat.files': '文件数',
        'hygiene.stat.categories': '分类',
        'hygiene.stat.reclaim': '可清理',
        'hygiene.truncated': '已截断',
        'hygiene.category.sessions': '会话',
        'hygiene.category.storages': '存储',
        'hygiene.category.logs': '日志',
        'hygiene.category.cache': '缓存',
        'hygiene.category.attachments': '附件',
        'hygiene.category.profiles': '档案',
        'hygiene.clean.title': '日志清理',
        'hygiene.clean.note': '只删除 logs 下 7 天前的 .log 文件',
        'hygiene.clean.counts': '{count} 个文件 · {size}',
        'hygiene.clean.none': '没有超过 7 天的 .log 文件',
        'hygiene.clean.action': '清理',
        'hygiene.clean.confirm': '确认清理 {count} 个文件（{size}）',
        'hygiene.clean.confirmGo': '确认清理',
        'hygiene.clean.cancel': '取消',
        'hygiene.clean.busy': '清理中…',
        'hygiene.clean.done': '已清理 {count} 个文件，释放 {size}',
        'hygiene.clean.failed': '清理失败：{reason}',
        'hygiene.clean.reason': '主机没有返回结果',
      },
      en: {
        'hygiene.title': 'DSH storage',
        'hygiene.preview.data': 'DSH data',
        'hygiene.preview.reclaim': 'Reclaimable',
        'hygiene.preview.categories': '{count} categories',
        'hygiene.preview.reclaimFiles': '{count} old logs',
        'hygiene.files': '{count} files',
        'hygiene.loading': 'Reading…',
        'hygiene.load.failed': 'Could not read: {reason}',
        'hygiene.unavailable.title': 'Data directory unavailable',
        'hygiene.unavailable.hint': 'The DSH data directory was not found or could not be read.',
        'hygiene.page.refresh': 'Refresh',
        'hygiene.page.categories': 'By category',
        'hygiene.stat.total': 'Total size',
        'hygiene.stat.files': 'Files',
        'hygiene.stat.categories': 'Categories',
        'hygiene.stat.reclaim': 'Reclaimable',
        'hygiene.truncated': 'Truncated',
        'hygiene.category.sessions': 'Sessions',
        'hygiene.category.storages': 'Storages',
        'hygiene.category.logs': 'Logs',
        'hygiene.category.cache': 'Cache',
        'hygiene.category.attachments': 'Attachments',
        'hygiene.category.profiles': 'Profiles',
        'hygiene.clean.title': 'Log cleanup',
        'hygiene.clean.note': 'Only .log files under logs older than 7 days',
        'hygiene.clean.counts': '{count} files · {size}',
        'hygiene.clean.none': 'No .log files older than 7 days',
        'hygiene.clean.action': 'Clean',
        'hygiene.clean.confirm': 'Clean {count} files ({size})?',
        'hygiene.clean.confirmGo': 'Clean now',
        'hygiene.clean.cancel': 'Cancel',
        'hygiene.clean.busy': 'Cleaning…',
        'hygiene.clean.done': 'Removed {count} files, freed {size}',
        'hygiene.clean.failed': 'Cleanup failed: {reason}',
        'hygiene.clean.reason': 'the host returned no result',
      },
    },
  })
    })(Kit)

    // ----------------------------------------------------------- network
    // lib/cards/network.js
    ;(function (kit) {

      var h = kit.h
      var React = kit.React
      var UI = kit.UI
      var ICONS = kit.ICONS
      var runtime = kit.runtime
      var defineCard = kit.defineCard
      var dict = kit.dict
      var useRemote = kit.useRemote
      var useClock = kit.useClock
      var useAnnounce = kit.useAnnounce
      var remoteCall = kit.remoteCall
      var requestReload = kit.requestReload
      var publishReloader = kit.publishReloader
      var pushToast = kit.pushToast
      var currencySymbol = kit.currencySymbol
      var primaryWallet = kit.primaryWallet
      var dayKey = kit.dayKey
      var kv = kit.kv

      // -------------------------------------------------------- clipboard

      /** Copy text to the clipboard, falling back to a hidden textarea. */
      function copyText(text, label) {
        var value = String(text)
        var done = function () { pushToast((label || '') + value) }
        var fallback = function () {
          try {
            var area = document.createElement('textarea')
            area.value = value
            area.setAttribute('readonly', 'readonly')
            area.style.position = 'fixed'
            area.style.opacity = '0'
            document.body.appendChild(area)
            area.select()
            document.execCommand('copy')
            document.body.removeChild(area)
            done()
          } catch (error) { pushToast(runtime.t('common.copyFailed'), 'error') }
        }
        try {
          // navigator.clipboard needs a secure context: the documented deployment
          // is http on a LAN address, where it is absent, so the textarea path is
          // the normal one there rather than the exceptional one.
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(value).then(done, fallback)
            return
          }
        } catch (error) { void error }
        fallback()
      }

      // =========================================================== 3. network

      /** The compact network card: the proxy in force, or a direct verdict. */
      function NetworkCard(props) {
        var t = props.t
        var api = props.api
        var remote = useRemote('homepage/environment', {}, { refreshMs: 300000 })
        var data = remote.data
        var error = remote.error
        React.useEffect(function () {
          return publishReloader('network', function () { void remote.reload(false) })
        }, [remote.reload])
        var proxies = data ? (data.proxies || []).filter(function (entry) { return entry.kind === 'proxy' }) : []
        var primary = proxies.length > 0 ? proxies[0] : null
        var target = primary ? (primary.host || primary.masked) + (primary.port ? ':' + primary.port : '') : null
        // Only a real failure is worth the user's attention: a proxy in force is
        // what the card is for, and masked credentials are not a problem.
        useAnnounce(api, 'network',
          error ? { level: 'error', text: t('network.notice.unavailable', { reason: error }) } : null)
        if (error) return h('div', null, h(UI.Chip, { tone: 'error' }, t('common.error')), h('p', { className: 'ph-inline-empty' }, error))
        if (!data) return h('div', { className: 'ph-hero ph-hero--wait' }, h('span', { className: 'ph-hero-value' }, '—'))
        // The preview answers only "what is my traffic going through": the proxy
        // endpoint and whether it needs credentials. Every variable, the TLS list
        // and the raw spelling live in `NetworkDetail`.
        if (!primary) {
          return h('div', { className: 'ph-hero' },
            h('span', { className: 'ph-hero-value ph-hero-value--ok' }, t('network.direct')),
            h('span', { className: 'ph-hero-label' }, t('network.proxy')),
          )
        }
        return h('div', { className: 'ph-hero' },
          h('span', { className: 'ph-hero-value ph-hero-value--mono' }, (primary.host || primary.masked) + (primary.port ? ':' + primary.port : '')),
          h('div', { className: 'ph-hero-row' },
            h('span', { className: 'ph-hero-label' }, primary.name),
            h(UI.Chip, { tone: primary.hasAuth ? 'warn' : 'ok' }, (primary.protocol || 'http') + (primary.hasAuth ? ' · auth' : '')),
          ),
        )
      }

      /** The expanded network page: every proxy variable, TLS vars and runtime facts. */
      function NetworkDetail(props) {
        var t = props.t
        var api = props.api
        var reveal = api.control('reveal') === true
        var showTls = api.control('tls') !== false
        var view = api.control('view') || 'table'
        var remote = useRemote('homepage/environment', {}, { refreshMs: 0 })
        var data = remote.data
        var error = remote.error
        React.useEffect(function () {
          return publishReloader('network', function () { void remote.reload(false) })
        }, [remote.reload])
        if (error) return h('div', { className: 'ph-detail-block' }, h('div', { className: 'ph-card-error' }, h('strong', null, t('common.error')), h('code', null, error)))
        if (!data) return h('div', { className: 'ph-detail-block' }, h('p', { className: 'ph-inline-empty' }, t('common.refresh') + '…'))

        var proxies = (data.proxies || []).filter(function (entry) { return entry.kind === 'proxy' })
        var bypass = (data.proxies || []).filter(function (entry) { return entry.kind === 'bypass' })
        var textValue = function (entry) { return reveal ? entry.raw : entry.masked }

        return h('div', { className: 'ph-detail-block' },
          h('div', { className: 'ph-section-head' },
            h('h4', null, t('network.variables')),
            h('span', { className: 'ph-head-spacer' }),
            h(UI.ComboButton, {
              label: t('common.copy'),
              value: reveal ? 'raw' : 'masked',
              options: [{ value: 'masked', label: t('common.copy') }, { value: 'raw', label: t('common.copyRaw') }],
              onRun: function (value) {
                var payload = proxies.map(function (entry) { return entry.name + '=' + (value === 'raw' ? entry.raw : entry.masked) }).join('\n')
                copyText(payload, t('common.copied') + '\n')
              },
            }),
          ),
          proxies.length === 0
            ? h('p', { className: 'ph-inline-empty' }, t('network.noProxies'))
            : view === 'text'
              ? h('pre', { className: 'ph-pre' }, proxies.map(function (entry) { return entry.name + '=' + textValue(entry) }).join('\n'))
              : h('div', { className: 'ph-table' },
                h('div', { className: 'ph-table-row ph-table-head' },
                  h('span', null, t('network.spellings')), h('span', null, t('network.value')),
                  h('span', null, t('network.host')), h('span', null, t('network.port')), h('span', null, t('network.protocol')),
                ),
                proxies.map(function (entry) {
                  return h('div', { className: 'ph-table-row', key: entry.name },
                    h('span', { className: 'ph-table-name', title: (entry.spellings || []).join(', ') },
                      entry.name, entry.hasAuth ? h(UI.Chip, { tone: 'warn', title: t('network.authHint') }, 'auth') : null),
                    h('span', { className: 'ph-mono ph-break', title: entry.raw }, textValue(entry)),
                    h('span', { className: 'ph-mono' }, entry.host || '—'),
                    h('span', { className: 'ph-mono' }, entry.port === null || entry.port === undefined ? '—' : String(entry.port)),
                    h('span', { className: 'ph-mono' }, entry.protocol || '—'),
                  )
                }),
              ),
          bypass.length > 0 ? h('div', null,
            h(UI.Divider, null),
            h('h4', { className: 'ph-section-title' }, t('network.bypass')),
            h('pre', { className: 'ph-pre' }, bypass.map(function (entry) { return entry.name + '=' + entry.raw }).join('\n')),
          ) : null,
          (data.redirectors || []).length > 0 ? h('div', null,
            h(UI.Divider, null),
            h('h4', { className: 'ph-section-title' }, t('network.redirectors')),
            h('div', { className: 'ph-kv' }, data.redirectors.map(function (entry) {
              return h('div', { className: 'ph-kv-row', key: entry.name },
                h('span', { className: 'ph-kv-key' }, entry.name),
                h('span', { className: 'ph-kv-value ph-mono ph-break' }, entry.value),
              )
            })),
          ) : null,
          showTls && (data.tls || []).length > 0 ? h('div', null,
            h(UI.Divider, null),
            h('h4', { className: 'ph-section-title' }, t('network.tls')),
            h('div', { className: 'ph-kv' }, data.tls.map(function (entry) {
              return h('div', { className: 'ph-kv-row', key: entry.name },
                h('span', { className: 'ph-kv-key' }, entry.name),
                h('span', { className: 'ph-kv-value ph-mono ph-break' }, entry.value),
              )
            })),
          ) : null,
          h(UI.Divider, null),
          h('div', { className: 'ph-kv' },
            kv(t('network.platform'), data.platform + ' · ' + data.arch),
            kv(t('network.node'), data.node),
            kv(t('network.cwd'), data.cwd),
            kv(t('network.dshHome'), data.dshHome),
          ),
        )
      }
        defineCard({
          id: 'network',
          shipped: true,
          order: 30,
          title: function () { return runtime.t('card.network.title') },
          icon: 'network',
          size: { w: 2, h: 1 },
          minSize: { w: 1, h: 1 },
          maxSize: { w: 4, h: 3 },
          accent: '#d29922',
          texture: true,
          effects: { outline: 'outline', sheen: false, ripple: false, float: false },
          content: function (api) { return h(NetworkCard, { api: api, t: runtime.t }) },
          detail: function (api) { return h(NetworkDetail, { api: api, t: runtime.t }) },
          detailActions: [
            {
              id: 'view', type: 'segmented', label: function () { return runtime.t('network.view') }, value: 'table',
              options: [
                { value: 'table', label: function () { return runtime.t('network.viewTable') } },
                { value: 'text', label: function () { return runtime.t('network.viewText') } },
              ],
            },
            { id: 'reveal', type: 'switch', label: function () { return runtime.t('network.reveal') }, value: false },
            { id: 'tls', type: 'switch', label: function () { return runtime.t('network.showTls') }, value: true },
            {
              id: 'refresh', type: 'combo', label: function () { return runtime.t('common.refresh') }, value: 'now',
              options: [{ value: 'now', label: function () { return runtime.t('common.refresh') } }],
              run: function () { requestReload('network', false) },
            },
          ],
        })

      dict({
        zh: {
          'card.network.title': '网络环境',
          'network.direct': '直连',
          'network.proxy': '代理',
          'network.variables': '代理变量',
          'network.bypass': '直连白名单',
          'network.redirectors': '其他转发',
          'network.tls': '证书变量',
          'network.platform': '运行环境',
          'network.host': '主机',
          'network.port': '端口',
          'network.protocol': '协议',
          'network.spellings': '变量名',
          'network.value': '值',
          'network.reveal': '显示凭据',
          'network.showTls': '证书变量',
          'network.view': '视图',
          'network.viewTable': '表格',
          'network.viewText': '文本',
          'network.authHint': '含凭据（默认掩码）',
          'network.noProxies': '没有设置 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY。',
          'network.notice.unavailable': '读不到进程环境：{reason}',
          'network.cwd': '工作目录',
          'network.node': 'Node',
          'network.dshHome': 'DSH_HOME',
        },
        en: {
          'card.network.title': 'Network',
          'network.direct': 'Direct',
          'network.proxy': 'Proxy',
          'network.variables': 'Proxy variables',
          'network.bypass': 'Bypass list',
          'network.redirectors': 'Other redirectors',
          'network.tls': 'Certificate variables',
          'network.platform': 'Runtime',
          'network.host': 'Host',
          'network.port': 'Port',
          'network.protocol': 'Scheme',
          'network.spellings': 'Names',
          'network.value': 'Value',
          'network.reveal': 'Reveal credentials',
          'network.showTls': 'Certificate vars',
          'network.view': 'View',
          'network.viewTable': 'Table',
          'network.viewText': 'Text',
          'network.authHint': 'Carries credentials (masked)',
          'network.noProxies': 'No HTTP_PROXY / HTTPS_PROXY / ALL_PROXY is set.',
          'network.notice.unavailable': 'Cannot read the process environment: {reason}',
          'network.cwd': 'Working dir',
          'network.node': 'Node',
          'network.dshHome': 'DSH_HOME',
        },
      })
    })(Kit)

    // ------------------------------------------------------ plugin-audit
    // lib/cards/plugin-audit.js
    ;(function (kit) {

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

  // Two ways to review, and the choice is the user's every time: `install` hands a
  // clean plugin to the host's installer as soon as the review clears it, `review`
  // never installs anything on its own — the verdict is kept in the history and the
  // user installs it from there if they want it.
  var MODE_INSTALL = 'install'
  var MODE_REVIEW = 'review'

  // A review reports through its own session, so the host learns the verdict the
  // moment the session does; asking again is what turns that into card state. The
  // timer dies the moment the audit reaches a state the host will not leave on its
  // own — and it also gives up after a minute of a host that never moves, so one
  // wedged install cannot keep asking forever.
  var POLL_MS = 1500
  var POLL_LIMIT = 40
  var LIVE = { running: true, safe: true, installing: true }

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
        return { level: 'warn', text: t('pluginAudit.notice.warn', { plugin: plugin }) }
      case 'unsafe':
        return { level: 'error', text: t('pluginAudit.notice.unsafe', { plugin: plugin }) }
      case 'failed':
        return { level: 'error', text: audit.detail || t('pluginAudit.notice.failed', { plugin: plugin }) }
      case 'safe':
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
    var picked = React.useState(MODE_INSTALL)
    var mode = picked[0]
    var setMode = picked[1]
    function start(target, chosen) {
      if (busy) return
      var wanted = String(target || '').trim()
      if (!wanted) return
      var decision = chosen === MODE_REVIEW ? MODE_REVIEW : MODE_INSTALL
      setError('')
      setBusy('start')
      api.remote(START, { options: { target: wanted, mode: decision } })
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
    return { busy: Boolean(busy), error: error, mode: mode, setMode: setMode, start: start }
  }

  /**
   * The one control the card draws itself: what to review, how the host should treat
   * a clean result, and the button that starts the review. The framework's action bar
   * only takes a static `disabled`, so a button whose state follows what has been
   * typed has to be drawn here. The field is controlled by the body around it, so the
   * wall's preview and the expanded card share one draft.
   *
   * The mode belongs to the request rather than to a setting: `install` is the card's
   * headline behaviour (review, then install only if it clears), `review` stops at the
   * verdict and leaves the install to the user — which is what lets somebody queue
   * several reviews and decide afterwards, without anything installing itself.
   */
  function TargetRow(props) {
    var t = props.t
    var busy = props.busy === true
    var onStart = props.onStart
    var draft = props.draft
    var setDraft = props.setDraft
    var mode = props.mode === MODE_REVIEW ? MODE_REVIEW : MODE_INSTALL
    var setMode = props.setMode
    // The wall reads as one action — type a name and start — so the choice between
    // the two modes is drawn only where there is room to explain it: the expanded
    // card passes `mode` down, the preview does not.
    var chooseMode = props.mode !== undefined
    function submit() {
      var wanted = String(draft || '').trim()
      if (!wanted || busy) return
      onStart(wanted, mode)
      setDraft('')
    }
    return h('div', { className: 'ph-loose' },
      chooseMode
        ? h('div', { className: 'ph-loose-row' },
            h(UI.Segmented, {
              options: [
                {
                  value: MODE_INSTALL,
                  label: t('pluginAudit.mode.install'),
                  title: t('pluginAudit.mode.installHint'),
                },
                {
                  value: MODE_REVIEW,
                  label: t('pluginAudit.mode.review'),
                  title: t('pluginAudit.mode.reviewHint'),
                },
              ],
              value: mode,
              disabled: busy,
              onChange: function (next) {
                if (typeof setMode === 'function') setMode(next === MODE_REVIEW ? MODE_REVIEW : MODE_INSTALL)
              },
            }))
        : null,
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
   * Whether a record can still be installed from. A `warn` verdict always can — that
   * is the confirmation the warning asked for — and so can a review-only audit that
   * came back `safe`: the mode postponed the install, it did not forbid it. An
   * `unsafe` verdict is never installable, and a running one has nothing to install.
   */
  function canInstall(audit) {
    if (!audit) return false
    if (audit.state === 'warn') return true
    return audit.state === 'safe' && audit.mode === 'review'
  }

  /** Whether the record still offers a way to turn the install down. */
  function canDecline(audit) {
    return !!audit && (audit.state === 'warn' || audit.state === 'unsafe')
  }

  /**
   * The buttons a verdict needs. `warn` is the verdict the card may install from
   * after asking; a review-only `safe` record can be installed from the record
   * itself, because the user asked to be the one who decides. An `unsafe` verdict
   * keeps only the decline, which is the safe answer — never an override.
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
      open
        ? h('div', { className: 'ph-audit-finding-body' },
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
              : null)
        : null)
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
        h('span', { className: 'ph-loose-name', title: auditName(audit, t) }, auditName(audit, t)),
        audit.mode === 'review' ? h('span', { className: 'ph-note' }, t('pluginAudit.mode.review')) : null),
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
          audit.mode === 'review' ? h('span', { className: 'ph-note' }, t('pluginAudit.mode.review')) : null,
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
  function AuditDetail(props) {
    var api = props.api
    var t = props.t
    var view = useAudit(api)
    useAnnounce(api, 'pluginAudit', auditNotice(view.audit, t))
    var starter = useStarter(api, view)
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
    function openRecord(id) {
      api.setControl('auditId', id)
      setPane('current')
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
    return h('div', { className: 'ph-detail-block' },
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
          setPane(wanted)
        },
      }),
      pane === 'history'
        ? h('div', { className: 'ph-loose' },
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
        : h('div', { className: 'ph-loose' },
            h('div', { className: 'ph-section-head' }, h('h4', { className: 'ph-section-title' }, t('pluginAudit.section.target'))),
            h(TargetRow, {
              t: t, busy: starter.busy, mode: starter.mode, setMode: starter.setMode,
              onStart: starter.start, draft: draft, setDraft: setDraft,
            }),
            starter.error ? h('span', { className: 'ph-groups-error' }, starter.error) : null,
            view.error ? h('span', { className: 'ph-groups-error' }, String(view.error)) : null,
            audit
              ? h('div', { className: 'ph-kv' },
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
                    h('span', { className: 'ph-kv-key' }, t('pluginAudit.kv.mode')),
                    h('span', { className: 'ph-kv-value' },
                      t(audit.mode === 'review' ? 'pluginAudit.mode.review' : 'pluginAudit.mode.install'))),
                  h('div', { className: 'ph-kv-row' },
                    h('span', { className: 'ph-kv-key' }, t('pluginAudit.kv.state')),
                    h('span', { className: 'ph-kv-value' }, stateText(t, audit.state) + (audit.stage ? ' · ' + progressText(t, audit) : ''))),
                  h('div', { className: 'ph-kv-row' },
                    h('span', { className: 'ph-kv-key' }, t('pluginAudit.kv.installed')),
                    h('span', { className: 'ph-kv-value' }, t(audit.installed ? 'pluginAudit.value.yes' : 'pluginAudit.value.no'))))
              : h('p', { className: 'ph-note' }, view.error ? t('pluginAudit.error.status') : (view.busy ? t('pluginAudit.loading') : t('pluginAudit.idle'))),
            audit && audit.detail ? h('p', { className: 'ph-note' }, String(audit.detail)) : null,
            audit && (canInstall(audit) || canDecline(audit)) ? h(VerdictActions, { api: api, t: t, audit: audit, view: view }) : null,
            h('div', { className: 'ph-section-head' }, h('h4', { className: 'ph-section-title' }, t('pluginAudit.section.verdict'))),
            h('p', { className: 'ph-note' }, audit && audit.summary ? String(audit.summary) : t('pluginAudit.summary.none')),
            h('div', { className: 'ph-section-head' }, h('h4', { className: 'ph-section-title' }, t('pluginAudit.section.findings'))),
            findings.length === 0
              ? h('p', { className: 'ph-note' }, t('pluginAudit.findings.none'))
              : h('div', { className: 'ph-audit-findings' }, sortFindings(findings).map(function (finding, index) {
                  return h(FindingRow, { t: t, finding: finding, key: 'f' + index })
                })),
            h('div', { className: 'ph-section-head' }, h('h4', { className: 'ph-section-title' }, t('pluginAudit.section.session'))),
            audit ? h(SessionRow, { t: t, audit: audit }) : h('p', { className: 'ph-note' }, t('pluginAudit.session.none'))))
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
      // The changed-audit signal (see SIGNAL): a control rather than component state
      // because the preview and the expanded body are separate instances that must
      // agree, and a control is the one value the framework shares between them.
      { id: 'auditSignal', type: 'text', hidden: true, value: '' },
    ],
  })

  dict({
    zh: {
      'card.pluginAudit.title': '插件审核',

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
      'pluginAudit.notice.safe': '{plugin} 审核通过，宿主正在安装',
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
      'pluginAudit.mode.install': '审核后安装',
      'pluginAudit.mode.review': '仅审核',
      'pluginAudit.mode.installHint': '通过后自动安装',
      'pluginAudit.mode.reviewHint': '只给结论，不自动安装；之后可在审核记录里安装',
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
      'pluginAudit.history.view': '查看',

      'pluginAudit.kv.plugin': '插件',
      'pluginAudit.kv.version': '版本',
      'pluginAudit.kv.mode': '方式',
      'pluginAudit.kv.compat': '版本相容',
      'pluginAudit.kv.repo': '仓库',
      'pluginAudit.kv.state': '状态',
      'pluginAudit.kv.installed': '已安装',
      'pluginAudit.value.none': '—',
      'pluginAudit.value.yes': '是',
      'pluginAudit.value.no': '否',
      'pluginAudit.compat.ok': '本机 {runtime}，声明的范围相容',
      'pluginAudit.compat.bad': '本机 {runtime}，声明的范围 {required} 装不上',
      'pluginAudit.compat.unknown': '无法判断（没有读到本机 DSH 版本）',
    },
    en: {
      'card.pluginAudit.title': 'Plugin audit',

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
      'pluginAudit.notice.safe': '{plugin} passed the review, so the host is installing it',
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
      'pluginAudit.mode.install': 'Review then install',
      'pluginAudit.mode.review': 'Review only',
      'pluginAudit.mode.installHint': 'installs it once the review clears',
      'pluginAudit.mode.reviewHint': 'verdict only; nothing installs, and the record can install later',
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
      'pluginAudit.history.view': 'View',

      'pluginAudit.kv.plugin': 'Plugin',
      'pluginAudit.kv.version': 'Version',
      'pluginAudit.kv.mode': 'Mode',
      'pluginAudit.kv.compat': 'Version fit',
      'pluginAudit.kv.repo': 'Repository',
      'pluginAudit.kv.state': 'State',
      'pluginAudit.kv.installed': 'Installed',
      'pluginAudit.value.none': '—',
      'pluginAudit.value.yes': 'yes',
      'pluginAudit.value.no': 'no',
      'pluginAudit.compat.ok': 'runs {runtime}, the declared range fits',
      'pluginAudit.compat.bad': 'runs {runtime}, the declared range {required} does not fit',
      'pluginAudit.compat.unknown': 'cannot tell (no runtime version was read)',
    },
  })
    })(Kit)

    // ---------------------------------------------------------- projects
    // lib/cards/projects.js
    ;(function (kit) {

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
    })(Kit)

    // ---------------------------------------------------------- sessions
    // lib/cards/sessions.js
    ;(function (kit) {

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
    })(Kit)

    // ------------------------------------------------------ sidebar-list
    // lib/cards/sidebar-list.js
    ;(function (kit) {
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
    })(Kit)

    // ----------------------------------------------------------- sidebar
    // lib/cards/sidebar.js
    ;(function (kit) {

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
    })(Kit)

    // ------------------------------------------------------------- skill
    // lib/cards/skill.js
    ;(function (kit) {

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
    })(Kit)

    // ------------------------------------------------------------- token
    // lib/cards/token.js
    ;(function (kit) {

      var h = kit.h
      var React = kit.React
      var UI = kit.UI
      var ICONS = kit.ICONS
      var runtime = kit.runtime
      var defineCard = kit.defineCard
      var dict = kit.dict
      var useRemote = kit.useRemote
      var useClock = kit.useClock
      var useAnnounce = kit.useAnnounce
      var remoteCall = kit.remoteCall
      var requestReload = kit.requestReload
      var publishReloader = kit.publishReloader
      var pushToast = kit.pushToast
      var currencySymbol = kit.currencySymbol
      var primaryWallet = kit.primaryWallet
      var dayKey = kit.dayKey
      var kv = kit.kv

      // ============================================================ 1. tokens

      var TOKEN_LOW_BALANCE = 5

      /**
       * The account notice, called by both the preview and the expanded body.
       *
       * It is a hook rather than an element so the bubble survives the switch
       * between the two views: the level is derived from the data, not from which
       * view happens to be on screen. Returns nothing.
       */
      /**
       * The token card's notice is an annunciator: it speaks only when the user
       * has a reason to act (signed out, unreachable, low balance) and retracts
       * itself once that is no longer true. A healthy balance is not news.
       */
      function useTokenNotice(api, t, data, error) {
        var wallet = primaryWallet(data)
        var amount = wallet ? currencySymbol(wallet.currency) + wallet.balance : null
        var notice = null
        if (error) {
          var signedOut = Boolean(data && data.error && data.error.reason === 'signed-out')
          notice = {
            level: signedOut ? 'warn' : 'error',
            text: signedOut ? t('token.notice.signedOut') : t('token.notice.unavailable', { reason: error }),
          }
        } else if (wallet && Number(wallet.balance) < TOKEN_LOW_BALANCE) {
          notice = { level: 'warn', text: t('token.notice.low', { amount: amount }) }
        }
        useAnnounce(api, 'token', notice)
      }

      /**
       * The compact token card.
       *
       * The card's job is to answer "how much is left and what did today cost", so
       * the preview is two numbers and nothing else: no ranges, no switches, no
       * percentages. Everything adjustable lives in `TokenDetail`.
       */
      function TokenCard(props) {
        var api = props.api
        var t = props.t
        var days = api.control('days') || 14
        var remote = useRemote('homepage/overview', { options: { historyDays: days } }, { refreshMs: 90000 })
        var data = remote.data
        var error = remote.error || (data && data.error ? data.error.message : null)
        var wallet = primaryWallet(data)
        var amount = wallet ? currencySymbol(wallet.currency) + wallet.balance : null

        React.useEffect(function () {
          return publishReloader('token', function (force) {
            void remote.reload(false)
            if (force) void remoteCall('homepage/refresh', {}).then(function () { void remote.reload(true) }).catch(function () {})
          })
        }, [remote.reload])

        useTokenNotice(api, t, data, error)

        if (!data && !error) {
          return h('div', { className: 'ph-hero ph-hero--wait' }, h('span', { className: 'ph-hero-value' }, '—'))
        }
        if (!wallet && error) {
          return h('div', { className: 'ph-hero ph-hero--wait' },
            h('span', { className: 'ph-hero-value' }, '—'),
            h('span', { className: 'ph-hero-label ph-hero-label--error' },
              data && data.account && data.account.status === 'signed-out' ? t('token.signedOut') : t('token.unavailable')),
          )
        }
        var today = data.today || {}
        return h('div', { className: 'ph-hero' },
          h('div', { className: 'ph-hero-main' },
            h('span', { className: 'ph-hero-value ph-hero-value--accent' }, amount || '—'),
            h('span', { className: 'ph-hero-label' }, t('token.balance')),
          ),
          h('div', { className: 'ph-hero-side' },
            h('span', { className: 'ph-hero-value ph-hero-value--sm' }, currencySymbol(today.currency) + (today.spend || '0.00')),
            h('span', { className: 'ph-hero-label' }, t('token.today')),
          ),
        )
      }

      // Detail-only styling leaves the compact card and the shared focus chrome alone.
      var tokenStylesReady = false
      function ensureTokenStyles() {
        if (tokenStylesReady || typeof runtime.insertCss !== 'function') return
        runtime.insertCss([
          '.ph-token-detail{--ph-token-tint:color-mix(in srgb,var(--dsw-alias-brand-primary,#2b5cff) 7%,var(--dsw-alias-bg-layer-1,#fff));width:100%;gap:16px}',
          '.ph-token-detail .ph-token-hero{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
          '.ph-token-hero>.ph-stat{padding:20px 22px;border-radius:18px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-2,#f6f7f9);gap:6px}',
          '.ph-token-hero>.ph-stat:first-child{background:var(--ph-token-tint);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#2b5cff) 22%,var(--dsw-alias-border-l2,#e5e7eb))}',
          '.ph-token-hero .ph-stat-value{font-size:clamp(28px,4vw,42px);line-height:1.15;letter-spacing:-.04em;font-weight:700;white-space:normal;overflow-wrap:anywhere}',
          '.ph-token-hero>.ph-stat:first-child .ph-stat-value{color:var(--dsw-alias-brand-primary,#2b5cff)}',
          '.ph-token-detail .ph-stat-label{font-size:12px;white-space:normal}',
          '.ph-token-detail .ph-stat-hint{font-size:11px;overflow-wrap:anywhere}',
          '.ph-token-panel{display:flex;flex-direction:column;gap:14px;padding:18px 20px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:16px;background:var(--dsw-alias-bg-layer-1,#fff);min-width:0}',
          '.ph-token-detail .ph-section-head{flex-wrap:wrap}.ph-token-detail .ph-section-head h4,.ph-token-detail .ph-section-title{font-size:14px;letter-spacing:-.01em}',
          '.ph-token-detail .ph-token-facts{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding:12px 14px;border-radius:11px;background:var(--dsw-alias-bg-layer-2,#f6f7f9)}',
          '.ph-token-facts .ph-stat{gap:4px}.ph-token-facts .ph-stat-value{font-size:20px;letter-spacing:-.02em}',
          '.ph-token-detail .ph-axis{font-size:11px;gap:10px;flex-wrap:wrap}',
          '.ph-token-detail .ph-kv-row{padding:10px 0}.ph-token-detail .ph-kv-key{flex:1;font-size:12px}.ph-token-detail .ph-kv-value{flex:1;text-align:right;font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}',
          '.ph-token-detail .ph-links{margin:0;gap:8px}.ph-token-detail .ph-link{padding:7px 12px;border-radius:9px;background:var(--ph-token-tint);text-decoration:none;transition:background .15s}',
          '.ph-token-detail .ph-link:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2b5cff) 14%,var(--dsw-alias-bg-layer-1,#fff))}.ph-token-detail .ph-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2b5cff);outline-offset:3px}',
          '@media(max-width:540px){.ph-token-detail{gap:12px}.ph-token-hero>.ph-stat{padding:16px 14px;border-radius:13px}.ph-token-hero .ph-stat-value{font-size:28px}.ph-token-panel{padding:14px}.ph-token-detail .ph-token-facts{gap:10px;padding:12px}.ph-token-facts .ph-stat-value{font-size:17px}.ph-token-detail .ph-section-head .ph-head-spacer{display:none}}',
          '@media(prefers-reduced-motion:reduce){.ph-token-detail .ph-link{transition:none}}',
        ].join(''))
        tokenStylesReady = true
      }

      /** The expanded token page: history chart and wallets. */
      function TokenDetail(props) {
        ensureTokenStyles()
        var api = props.api
        var t = props.t
        var days = api.control('days') || 14
        var showBonus = api.control('bonus') === true
        var remote = useRemote('homepage/overview', { options: { historyDays: days } }, { refreshMs: 120000 })
        var data = remote.data
        var error = remote.error || (data && data.error ? data.error.message : null)
        React.useEffect(function () {
          return publishReloader('token', function (force) {
            void remote.reload(false)
            if (force) void remoteCall('homepage/refresh', {}).then(function () { void remote.reload(true) }).catch(function () {})
          })
        }, [remote.reload])

        useTokenNotice(api, t, data, error)

        if (!data) {
          return h('div', { className: 'ph-detail-block' },
            error
              ? h('div', { className: 'ph-card-error' }, h('strong', null, t('common.error')), h('code', null, error))
              : h('p', { className: 'ph-inline-empty' }, t('common.refresh') + '…'),
          )
        }
        var history = Array.isArray(data.history) ? data.history.slice().reverse() : []
        var today = data.today || {}
        var sum = history.reduce(function (total, day) { return total + Number(day.spend || 0) }, 0)
        var peak = history.reduce(function (best, day) { return Number(day.spend) > Number(best.spend || 0) ? day : best }, { spend: '0' })
        var wallet = primaryWallet(data)
        var links = accountLinks(data.account && data.account.links, t)
        return h('div', { className: 'ph-detail-block ph-token-detail' },
          h('div', { className: 'ph-detail-stats ph-token-hero' },
            h(UI.Stat, { label: t('token.balance'), value: wallet ? currencySymbol(wallet.currency) + wallet.balance : '—' }),
            h(UI.Stat, { label: t('token.today'), value: currencySymbol(today.currency) + (today.spend || '0.00'), hint: today.open && today.last ? today.open + ' → ' + today.last : null }),
          ),
          h('section', { className: 'ph-token-panel', 'aria-label': t('token.history') },
          h('div', { className: 'ph-section-head' },
            h('h4', null, t('token.history')),
            h('span', { className: 'ph-head-spacer' }),
            today.partial ? h(UI.Chip, { tone: 'warn' }, t('token.partial')) : null,
          ),
          h('div', { className: 'ph-detail-stats ph-token-facts' },
            h(UI.Stat, { label: t('token.sum', { count: history.length }), value: currencySymbol(today.currency) + sum.toFixed(2) }),
            h(UI.Stat, { label: t('token.avg'), value: currencySymbol(today.currency) + (history.length ? (sum / history.length).toFixed(2) : '0.00') }),
            h(UI.Stat, { label: t('token.peak'), value: currencySymbol(today.currency) + (peak.spend || '0.00'), hint: peak.day || null }),
          ),
          history.length === 0
            ? h('p', { className: 'ph-inline-empty' }, t('token.noHistory'))
            : h(UI.Bars, {
              height: 120,
              values: history.map(function (day, index) {
                var currency = currencySymbol(day.currency || today.currency)
                return {
                  value: Number(day.spend || 0),
                  highlight: index === history.length - 1,
                  title: day.day + '  ' + currency + (day.spend || '0.00') + (day.partial ? '  (' + t('token.partial') + ')' : ''),
                }
              }),
            }),
          h('div', { className: 'ph-axis' },
            h('span', null, history.length > 0 ? history[0].day : ''),
            h('span', { className: 'ph-head-spacer' }),
            h('span', null, history.length > 0 ? history[history.length - 1].day : ''),
          ),
          ),
          h('section', { className: 'ph-token-panel', 'aria-label': t('token.wallets') },
          h('h4', { className: 'ph-section-title' }, t('token.wallets')),
          h('div', { className: 'ph-kv' },
            (data.wallets || []).map(function (entry) {
              return h('div', { className: 'ph-kv-row', key: 'w' + entry.currency },
                h('span', { className: 'ph-kv-key' }, entry.currency),
                h('span', {
                  className: 'ph-kv-value',
                  title: entry.raw && entry.raw !== entry.balance ? entry.raw : null,
                }, currencySymbol(entry.currency) + entry.balance),
              )
            }),
            showBonus ? (data.bonusWallets || []).map(function (entry) {
              return h('div', { className: 'ph-kv-row', key: 'b' + entry.currency },
                h('span', { className: 'ph-kv-key' }, t('token.bonus') + ' · ' + entry.currency),
                h('span', {
                  className: 'ph-kv-value',
                  title: entry.raw && entry.raw !== entry.balance ? entry.raw : null,
                }, currencySymbol(entry.currency) + entry.balance),
              )
            }) : null,
            (data.wallets || []).length === 0 ? h('p', { className: 'ph-inline-empty' }, t('token.unavailable')) : null,
          ),
          error ? h('div', null,
            h(UI.Divider, null),
            h('div', { className: 'ph-kv' },
              h('div', { className: 'ph-kv-row' },
                h('span', { className: 'ph-kv-key' }, t('common.error')),
                h('span', { className: 'ph-kv-value', style: { color: 'var(--dsw-alias-state-error-primary,#e5484d)' } }, error),
              ),
            ),
          ) : null,
          links.length > 0 ? h('div', { className: 'ph-links' }, links.map(function (link) {
            return h('a', { className: 'ph-link', key: link.href, href: link.href, target: '_blank', rel: 'noreferrer' }, link.label)
          })) : null,
          ),
        )
      }

      /** @returns up to two `{ label, href }` account links found on the account view. */
      function accountLinks(links, t) {
        if (!links || typeof links !== 'object') return []
        var out = []
        Object.keys(links).forEach(function (key) {
          var value = links[key]
          if (typeof value !== 'string' || !/^https?:\/\//.test(value)) return
          var lower = key.toLowerCase()
          var label = lower.indexOf('top') >= 0 || lower.indexOf('recharge') >= 0
            ? t('token.link.topUp')
            : lower.indexOf('usage') >= 0 || lower.indexOf('billing') >= 0 ? t('token.link.usage') : key
          out.push({ label: label, href: value })
        })
        return out.slice(0, 2)
      }

        defineCard({
          id: 'token',
          shipped: true,
          order: 10,
          title: function () { return runtime.t('card.token.title') },
          icon: 'token',
          size: { w: 2, h: 1 },
          minSize: { w: 1, h: 1 },
          maxSize: { w: 4, h: 3 },
          accent: '#2b5cff',
          texture: true,
          // No explicit background: the default material is a flat wash tinted by
          // `accent`, which keeps every card the same material instead of three
          // different ones.
          // No sheen either: it is a diagonal band of light, which is a gradient —
          // the one thing the art direction ruled out. It stays available per card
          // from the effect picker; it is just not on by default.
          effects: { outline: 'glow', sheen: false, spotlight: true, ripple: false, float: false },
          refreshMs: 90000,
          content: function (api) { return h(TokenCard, { api: api, t: runtime.t }) },
          detail: function (api) { return h(TokenDetail, { api: api, t: runtime.t }) },
          // Nothing here is a control: the token card's whole job is to be read,
          // so its three settings appear only once the card is expanded.
          detailActions: [
            {
              id: 'days', type: 'segmented', label: function () { return runtime.t('token.range') },
              value: 14,
              options: [
                { value: 7, label: '7' }, { value: 14, label: '14' }, { value: 30, label: '30' },
              ],
            },
            { id: 'bonus', type: 'switch', label: function () { return runtime.t('token.showBonus') }, value: false },
            {
              id: 'refresh', type: 'combo', label: function () { return runtime.t('common.refresh') }, value: 'sample',
              options: [
                { value: 'sample', label: function () { return runtime.t('common.refresh') } },
                { value: 'force', label: function () { return runtime.t('common.force') } },
              ],
              run: function (value) { requestReload('token', value === 'force') },
            },
          ],
        })

      dict({
        zh: {
          'card.token.title': 'Token 统计',
          'token.today': '今日消费',
          'token.balance': '余额',
          'token.bonus': '赠送余额',
          'token.range': '统计范围',
          'token.showBonus': '赠送余额',
          'token.history': '每日消费',
          'token.partial': '区间可能不完整',
          'token.sum': '{count} 天合计',
          'token.avg': '日均',
          'token.peak': '最高一天',
          'token.wallets': '账户钱包',
          'token.unavailable': '账户服务未挂载',
          'token.signedOut': '未登录 DeepSeek 账户',
          'token.noHistory': '还没有历史记录，采样几次之后这里会出现趋势图。',
          'token.notice.low': '余额偏低：{amount}',
          'token.notice.unavailable': '读不到账户余额：{reason}',
          'token.notice.signedOut': '未登录 DeepSeek 账户，无法读取余额。',
          'token.link.usage': '用量明细',
          'token.link.topUp': '充值',
        },
        en: {
          'card.token.title': 'Token usage',
          'token.today': 'Spent today',
          'token.balance': 'Balance',
          'token.bonus': 'Bonus balance',
          'token.range': 'Range',
          'token.showBonus': 'Bonus balance',
          'token.history': 'Daily spend',
          'token.partial': 'Window may be incomplete',
          'token.sum': '{count}-day total',
          'token.avg': 'Daily average',
          'token.peak': 'Peak day',
          'token.wallets': 'Wallets',
          'token.unavailable': 'Account service not mounted',
          'token.signedOut': 'Not signed in to DeepSeek',
          'token.noHistory': 'No history yet. A few samples and the trend shows up here.',
          'token.notice.low': 'Balance is low: {amount}',
          'token.notice.unavailable': 'Balance unavailable: {reason}',
          'token.notice.signedOut': 'Not signed in to DeepSeek; the balance cannot be read.',
          'token.link.usage': 'Usage',
          'token.link.topUp': 'Top up',
        },
      })
    })(Kit)

    // -------------------------------------------------------- tool-usage
    // lib/cards/tool-usage.js
    ;(function (kit) {

  var h = kit.h
  var React = kit.React
  var UI = kit.UI
  var ICONS = kit.ICONS
  var runtime = kit.runtime
  var defineCard = kit.defineCard
  var dict = kit.dict
  var useRemote = kit.useRemote

  var ACCENT = '#b03a68'
  var REFRESH_MS = 60000
  var UNIT_NAMES = ['', 'k', 'M', 'B', 'T']

  /**
   * Coerce a value to a usable count.
   * @param {unknown} value - anything a host document might carry.
   * @returns {number} a finite, non-negative number.
   */
  function toNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0
    if (typeof value === 'string' && value.trim() !== '') {
      var parsed = Number(value)
      if (Number.isFinite(parsed) && parsed > 0) return parsed
    }
    return 0
  }

  /**
   * Coerce a value to display text.
   * @param {unknown} value - anything a host document might carry.
   * @param {string} fallback - text used when the value is missing.
   * @returns {string} the text.
   */
  function toText(value, fallback) {
    if (typeof value === 'string') return value
    if (value === undefined || value === null) return fallback
    try {
      return String(value)
    } catch (error) {
      return fallback
    }
  }

  /** @returns the value when it is a plain object, else null. */
  function objectOf(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  }

  /** @returns the value when it is an array, else an empty array. */
  function arrayOf(value) {
    return Array.isArray(value) ? value : []
  }

  /**
   * Pull a human reason out of whatever a failed action returned.
   * @param {unknown} result - a structured failure, an Error, or a string.
   * @returns {string} a trimmed message, or ''.
   */
  function failureReason(result) {
    if (result === undefined || result === null) return ''
    if (typeof result === 'string') return result.trim()
    if (typeof result !== 'object') return toText(result, '').trim()
    var parts = [result.error, result.message, result.reason]
    for (var index = 0; index < parts.length; index += 1) {
      var part = parts[index]
      if (part === undefined || part === null || part === '') continue
      if (typeof part === 'object' && typeof part.message === 'string') return part.message.trim()
      var text = toText(part, '').trim()
      if (text !== '') return text
    }
    return ''
  }

  /** @returns a share rounded to a whole percent, 0 when the denominator is zero. */
  function shareOf(value, largest) {
    var total = toNumber(largest)
    if (total <= 0) return 0
    return Math.max(2, Math.round((toNumber(value) / total) * 100))
  }

  /** @returns a compact count: `999`, `1.2k`, `12k`, `1.2M`. */
  function formatCompact(value) {
    var number = toNumber(value)
    if (number <= 0) return '0'
    if (number < 1000) return String(Math.round(number))
    var unit = Math.floor(Math.log(number) / Math.log(1000))
    if (unit < 1) unit = 1
    if (unit > UNIT_NAMES.length - 1) unit = UNIT_NAMES.length - 1
    var scaled = number / Math.pow(1000, unit)
    if (scaled >= 999.5 && unit < UNIT_NAMES.length - 1) {
      unit += 1
      scaled /= 1000
    }
    var text = scaled >= 10 ? String(Math.round(scaled)) : scaled.toFixed(1)
    if (text.slice(-2) === '.0') text = text.slice(0, -2)
    return text + UNIT_NAMES[unit]
  }

  /** @returns an exact count with thousands separators: `12345` -> `12,345`. */
  function formatInt(value) {
    return String(Math.round(toNumber(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  /** @returns an estimated token count, always carrying the estimate mark. */
  function formatTokens(value) {
    return '≈' + formatCompact(value)
  }

  /** @returns a 0..1 rate as a percentage: `0%`, `0.42%`, `3.2%`, `12%`. */
  function formatPercent(value) {
    var rate = toNumber(value)
    if (rate > 1 && rate <= 100) rate = rate / 100
    if (rate > 1) rate = 1
    if (rate <= 0) return '0%'
    var percent = rate * 100
    if (percent >= 10) return Math.round(percent) + '%'
    var text = percent >= 1 ? percent.toFixed(1) : percent.toFixed(2)
    if (text.slice(-2) === '.0') text = text.slice(0, -2)
    if (text === '0.00') text = '0.01'
    return text + '%'
  }

  /** @returns a duration: `0 ms`, `420 ms`, `1.2 s`, `2 min`. */
  function formatMs(value) {
    var ms = toNumber(value)
    if (ms <= 0) return '0 ms'
    if (ms < 1) return '<1 ms'
    if (ms < 1000) return Math.round(ms) + ' ms'
    var seconds = ms / 1000
    if (seconds < 60) {
      var secText = seconds >= 10 ? String(Math.round(seconds)) : seconds.toFixed(1)
      if (secText.slice(-2) === '.0') secText = secText.slice(0, -2)
      return secText + ' s'
    }
    var minutes = seconds / 60
    var minText = minutes >= 10 ? String(Math.round(minutes)) : minutes.toFixed(1)
    if (minText.slice(-2) === '.0') minText = minText.slice(0, -2)
    return minText + ' min'
  }

  /**
   * Read a rate a host may have declared, and fall back to errors / calls.
   * A value above 1 but within 100 is read as a percentage, so a host that
   * declares `3.2` is not rendered as 320%.
   * @returns {number} a 0..1 rate.
   */
  function rateOf(value, calls, errors) {
    var rate = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
    if (Number.isFinite(rate) && rate >= 0) {
      if (rate > 1 && rate <= 100) return rate / 100
      return Math.min(1, rate)
    }
    var count = toNumber(calls)
    if (count <= 0) return 0
    return Math.min(1, toNumber(errors) / count)
  }

  /**
   * Normalize one host tool row.
   * @param {unknown} item - a tool entry from totals or one project.
   * @returns {object|null} the row, or null when it has no usable name.
   */
  function readTool(item) {
    var source = objectOf(item)
    if (source === null) return null
    var name = toText(source.name, '').trim()
    if (name === '') return null
    var calls = Math.round(toNumber(source.calls))
    var errors = Math.round(toNumber(source.errors))
    var ms = toNumber(source.ms)
    var argTokens = toNumber(source.argTokens)
    var outTokens = toNumber(source.outTokens)
    return {
      name: name,
      calls: calls,
      errors: errors,
      errorRate: rateOf(source.errorRate, calls, errors),
      argChars: Math.round(toNumber(source.argChars)),
      outChars: Math.round(toNumber(source.outChars)),
      argTokens: argTokens,
      outTokens: outTokens,
      tokens: argTokens + outTokens,
      ms: ms,
      avgMs: calls > 0 ? ms / calls : 0,
    }
  }

  /** @returns the rows sorted by calls, then by name. */
  function sortTools(rows) {
    rows.sort(function (left, right) {
      if (right.calls !== left.calls) return right.calls - left.calls
      if (left.name < right.name) return -1
      if (left.name > right.name) return 1
      return 0
    })
    return rows
  }

  /** @returns every usable tool row from a host list, sorted. */
  function readTools(value) {
    var rows = arrayOf(value)
    var tools = []
    for (var index = 0; index < rows.length; index += 1) {
      var row = readTool(rows[index])
      if (row !== null) tools.push(row)
    }
    return sortTools(tools)
  }

  /** @returns the top tool entries a project declares, cleaned and capped. */
  function readTop(value) {
    var rows = arrayOf(value)
    var top = []
    for (var index = 0; index < rows.length; index += 1) {
      var source = objectOf(rows[index])
      if (source === null) continue
      var name = toText(source.name, '').trim()
      if (name === '') continue
      top.push({ name: name, calls: Math.round(toNumber(source.calls)) })
    }
    return top
  }

  /** @returns one normalized project, or null when it has no usable key. */
  function readProject(item) {
    var source = objectOf(item)
    if (source === null) return null
    var path = toText(source.path, '').trim()
    var key = toText(source.key, '').trim() || path
    if (key === '') return null
    var calls = Math.round(toNumber(source.calls))
    var errors = Math.round(toNumber(source.errors))
    var tools = readTools(source.tools)
    var ms = toNumber(source.ms)
    var argTokens = toNumber(source.argTokens)
    var outTokens = toNumber(source.outTokens)
    return {
      key: key,
      label: toText(source.label, '').trim() || key,
      path: path,
      sessions: Math.round(toNumber(source.sessions)),
      calls: calls,
      errors: errors,
      errorRate: rateOf(source.errorRate, calls, errors),
      argChars: Math.round(toNumber(source.argChars)),
      outChars: Math.round(toNumber(source.outChars)),
      argTokens: argTokens,
      outTokens: outTokens,
      tokens: argTokens + outTokens,
      ms: ms,
      avgMs: calls > 0 ? ms / calls : 0,
      toolCount: Math.round(toNumber(source.toolCount)) || tools.length,
      top: readTop(source.top),
      tools: tools,
    }
  }

  /**
   * Reduce a host document to the numbers and rows this card draws.
   *
   * Pure and defensive: a missing document, a partial one, and one with strings
   * where numbers belong all answer with the same shape. The host's own totals
   * win when present; the tool rows are the fallback breakdown.
   * @param {unknown} doc - the `homepage/toolUsage` document.
   * @param {unknown} failure - the remote error, if there was one.
   * @returns {object} the reading the card renders.
   */
  function summarize(doc, failure) {
    var source = objectOf(doc)
    var errorText = failureReason(failure)
    var windowSource = source === null ? null : objectOf(source.window)
    var totalsSource = source === null ? null : objectOf(source.totals)
    var tools = source === null ? [] : readTools(source.tools)

    var rawProjects = source === null ? [] : arrayOf(source.projects)
    var projects = []
    for (var index = 0; index < rawProjects.length; index += 1) {
      var project = readProject(rawProjects[index])
      if (project !== null) projects.push(project)
    }
    projects.sort(function (left, right) {
      if (right.calls !== left.calls) return right.calls - left.calls
      return left.label < right.label ? -1 : left.label > right.label ? 1 : 0
    })

    var sumCalls = 0
    var sumErrors = 0
    var sumArgChars = 0
    var sumOutChars = 0
    var sumArgTokens = 0
    var sumOutTokens = 0
    var sumMs = 0
    for (var toolIndex = 0; toolIndex < tools.length; toolIndex += 1) {
      sumCalls += tools[toolIndex].calls
      sumErrors += tools[toolIndex].errors
      sumArgChars += tools[toolIndex].argChars
      sumOutChars += tools[toolIndex].outChars
      sumArgTokens += tools[toolIndex].argTokens
      sumOutTokens += tools[toolIndex].outTokens
      sumMs += tools[toolIndex].ms
    }

    var declaredCalls = totalsSource !== null && typeof totalsSource.calls === 'number' && totalsSource.calls >= 0
    var calls = declaredCalls ? totalsSource.calls : sumCalls
    var errors = totalsSource !== null && typeof totalsSource.errors === 'number' && totalsSource.errors >= 0
      ? totalsSource.errors
      : sumErrors
    var argTokens = totalsSource !== null && typeof totalsSource.argTokens === 'number' && totalsSource.argTokens >= 0
      ? totalsSource.argTokens
      : sumArgTokens
    var outTokens = totalsSource !== null && typeof totalsSource.outTokens === 'number' && totalsSource.outTokens >= 0
      ? totalsSource.outTokens
      : sumOutTokens
    var ms = totalsSource !== null && typeof totalsSource.ms === 'number' && totalsSource.ms >= 0 ? totalsSource.ms : sumMs
    var errorRate = totalsSource !== null && (typeof totalsSource.errorRate === 'number' || typeof totalsSource.errorRate === 'string')
      ? rateOf(totalsSource.errorRate, calls, errors)
      : rateOf(undefined, calls, errors)

    var windowSessions = windowSource === null ? projects.length : Math.round(toNumber(windowSource.sessions))
    return {
      available: source !== null && source.available === true,
      loading: source === null && errorText === '',
      partial: source !== null && source.partial === true,
      reason: toText(source === null ? '' : source.reason, '').trim(),
      error: errorText,
      at: source === null ? 0 : toNumber(source.at),
      window: {
        sessions: windowSessions,
        projects: windowSource === null ? projects.length : Math.round(toNumber(windowSource.projects)),
        scannedSessions: windowSource === null ? 0 : Math.round(toNumber(windowSource.scannedSessions)),
        firstAt: windowSource === null ? 0 : toNumber(windowSource.firstAt),
        lastAt: windowSource === null ? 0 : toNumber(windowSource.lastAt),
      },
      totals: {
        calls: Math.round(calls),
        errors: Math.round(errors),
        errorRate: errorRate,
        argChars: totalsSource !== null && typeof totalsSource.argChars === 'number' && totalsSource.argChars >= 0
          ? Math.round(totalsSource.argChars)
          : sumArgChars,
        outChars: totalsSource !== null && typeof totalsSource.outChars === 'number' && totalsSource.outChars >= 0
          ? Math.round(totalsSource.outChars)
          : sumOutChars,
        argTokens: argTokens,
        outTokens: outTokens,
        tokens: argTokens + outTokens,
        ms: ms,
        avgMs: calls > 0 ? ms / calls : 0,
      },
      tools: tools,
      toolCount: tools.length,
      projects: projects,
      projectCount: projects.length,
      topTool: tools.length > 0 ? tools[0] : null,
    }
  }

  var STYLE = [
    '.ph-tu{--ph-tu-accent:' + ACCENT + ';',
    '--ph-tu-ink:var(--dsw-alias-label-primary,#1f2328);',
    '--ph-tu-ink2:var(--dsw-alias-label-secondary,#57606a);',
    '--ph-tu-ink3:var(--dsw-alias-label-tertiary,#8b949e);',
    '--ph-tu-line:var(--dsw-alias-border-l2,#e5e7eb);',
    '--ph-tu-line-soft:var(--dsw-alias-border-l1,#eef0f2);',
    '--ph-tu-surface:var(--dsw-alias-bg-layer-1,#fff);',
    '--ph-tu-sunken:var(--dsw-alias-bg-layer-2,#f6f7f9);',
    '--ph-tu-hover:var(--dsw-alias-interactive-bg-hover,rgba(31,35,40,.045));',
    '--ph-tu-warn:var(--dsw-alias-state-warn-primary,#b45309);',
    '--ph-tu-error:var(--dsw-alias-state-error-primary,#dc2626);',
    'color:var(--ph-tu-ink)}',
    '.ph-tu-preview{display:flex;flex-direction:column;justify-content:space-between;gap:6px;height:100%;min-height:0}',
    '.ph-tu-readings{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}',
    '.ph-tu-hero,.ph-tu-side{display:flex;flex-direction:column;min-width:0}',
    '.ph-tu-side{align-items:flex-end;text-align:right}',
    '.ph-tu-hero-num{font-size:clamp(22px,2.4vw,30px);font-weight:650;line-height:1.05;letter-spacing:-.02em;font-variant-numeric:tabular-nums}',
    '.ph-tu-hero-label,.ph-tu-side-label{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--ph-tu-ink3);white-space:nowrap}',
    '.ph-tu-side-num{font-size:16px;font-weight:650;line-height:1.2;color:var(--ph-tu-accent);font-variant-numeric:tabular-nums}',
    '.ph-tu-lead{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11.5px;color:var(--ph-tu-ink2)}',
    '.ph-tu-lead-tag{flex:none;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--ph-tu-ink3)}',
    '.ph-tu-lead-name{min-width:0;font-weight:600;color:var(--ph-tu-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ph-tu-lead-count{margin-left:auto;flex:none;color:var(--ph-tu-ink3);font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.ph-tu-lead.is-empty{color:var(--ph-tu-ink3)}',
    '.ph-tu-foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--ph-tu-ink2);min-height:16px}',
    '.ph-tu-sep{color:var(--ph-tu-ink3)}',
    '.ph-tu-flag{display:inline-flex;align-items:center;gap:4px;margin-left:auto;padding:1px 7px;border-radius:999px;background:var(--ph-tu-sunken);color:var(--ph-tu-accent);font-size:10.5px;white-space:nowrap}',
    '.ph-tu-flag.is-warn{color:var(--ph-tu-warn)}',
    '.ph-tu-flag svg{flex:none}',
    '.ph-tu-loading{margin:0;font-size:11px;color:var(--ph-tu-ink3)}',
    '.ph-tu-page{display:flex;flex-direction:column;gap:14px;max-width:760px;width:100%}',
    '.ph-tu-head{display:flex;align-items:center;justify-content:flex-end;gap:9px}',
    '.ph-tu-head-spacer{flex:1}',
    '.ph-tu-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:1px solid var(--ph-tu-line);border-radius:9px;background:var(--ph-tu-surface);color:var(--ph-tu-ink2);cursor:pointer}',
    '.ph-tu-iconbtn:disabled{opacity:.5;cursor:default}',
    '.ph-tu-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}',
    '.ph-tu-stats .ph-stat{padding:9px 11px;border:1px solid var(--ph-tu-line);border-radius:12px;background:var(--ph-tu-sunken)}',
    '.ph-tu-stats .ph-stat-value{font-variant-numeric:tabular-nums}',
    '.ph-tu-block-title{margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--ph-tu-ink3)}',
    '.ph-tu-switch{display:flex;align-items:center;gap:6px;overflow-x:auto;padding:1px 1px 5px;scrollbar-width:thin}',
    '.ph-tu-chip{display:inline-flex;align-items:center;flex:none;max-width:200px;height:26px;padding:0 10px;border:1px solid var(--ph-tu-line);border-radius:999px;background:var(--ph-tu-surface);color:var(--ph-tu-ink2);font-size:11.5px;font-weight:600;white-space:nowrap;cursor:pointer;overflow:hidden;text-overflow:ellipsis}',
    '.ph-tu-chip.is-active{border-color:transparent;background:var(--ph-tu-accent);color:#fff}',
    '.ph-tu-chip-count{margin-left:5px;font-size:10.5px;font-weight:500;font-variant-numeric:tabular-nums;opacity:.65}',
    '.ph-tu-proj{display:flex;flex-direction:column;gap:9px;padding:10px 12px;border:1px solid var(--ph-tu-line);border-radius:12px;background:var(--ph-tu-sunken)}',
    '.ph-tu-proj-head{display:flex;align-items:baseline;gap:8px;min-width:0}',
    '.ph-tu-proj-name{min-width:0;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ph-tu-proj-path{min-width:0;flex:1;font-size:11px;color:var(--ph-tu-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right}',
    '.ph-tu-proj-reads{display:flex;align-items:flex-start;gap:18px;flex-wrap:wrap}',
    '.ph-tu-proj-reading{display:flex;flex-direction:column;gap:1px}',
    '.ph-tu-proj-reading b{font-size:13px;font-weight:650;font-variant-numeric:tabular-nums}',
    '.ph-tu-proj-reading i{font-style:normal;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--ph-tu-ink3)}',
    '.ph-tu-proj-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
    '.ph-tu-proj-top-label{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--ph-tu-ink3)}',
    '.ph-tu-proj-tool{display:inline-flex;align-items:center;gap:5px;max-width:180px;padding:1px 7px;border:1px solid var(--ph-tu-line);border-radius:999px;background:var(--ph-tu-surface);font-size:10.5px;color:var(--ph-tu-ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ph-tu-proj-tool b{font-weight:600;color:var(--ph-tu-ink);overflow:hidden;text-overflow:ellipsis}',
    '.ph-tu-proj-tool span{font-variant-numeric:tabular-nums;color:var(--ph-tu-ink3)}',
    '.ph-tu-rows{display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;padding-right:2px}',
    '.ph-tu-row{padding:8px 10px;border:1px solid var(--ph-tu-line);border-radius:11px;background:var(--ph-tu-surface)}',
    '.ph-tu-row-top{display:flex;align-items:baseline;gap:8px;min-width:0}',
    '.ph-tu-row-name{min-width:0;flex:1;font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ph-tu-row-err{flex:none;padding:1px 6px;border-radius:999px;background:color-mix(in srgb,var(--ph-tu-error) 12%,transparent);color:var(--ph-tu-error);font-size:10.5px;font-weight:600;white-space:nowrap}',
    '.ph-tu-row-calls{flex:none;font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.ph-tu-bar{height:4px;margin-top:6px;border-radius:2px;background:var(--ph-tu-line-soft);overflow:hidden}',
    '.ph-tu-bar i{display:block;height:100%;border-radius:2px;background:var(--ph-tu-accent);opacity:.85}',
    '.ph-tu-row-meta{display:flex;align-items:baseline;gap:10px;margin-top:6px;font-size:10.5px;color:var(--ph-tu-ink3);white-space:nowrap}',
    '.ph-tu-row-avg{margin-left:auto}',
    '.ph-tu-rows-empty{margin:0;padding:10px 12px;border:1px dashed var(--ph-tu-line);border-radius:11px;font-size:11.5px;color:var(--ph-tu-ink3)}',
    '.ph-tu-empty{display:flex;flex-direction:column;gap:3px;padding:10px 12px;border:1px solid var(--ph-tu-warn);border-radius:12px;background:var(--ph-tu-sunken)}',
    '.ph-tu-empty b{font-size:12px;color:var(--ph-tu-warn)}',
    '.ph-tu-empty span{font-size:11px;color:var(--ph-tu-ink2)}',
    '.ph-tu-note{margin:0;font-size:11px;color:var(--ph-tu-ink3)}',
    '@media (hover:hover) and (pointer:fine){',
    '.ph-tu-iconbtn:hover:not(:disabled){background:var(--ph-tu-hover)}',
    '.ph-tu-chip:hover:not(.is-active){background:var(--ph-tu-hover)}',
    '}',
    '@media (max-width:760px){',
    '.ph-tu-stats{grid-template-columns:repeat(2,minmax(0,1fr))}',
    '.ph-tu-rows{max-height:240px}',
    '.ph-tu-row-avg{display:none}',
    '}',
    '@media (prefers-reduced-motion:reduce){.ph-tu,.ph-tu *{transition:none!important;animation:none!important}}',
  ].join('')

  var styleSeat = { done: false }

  /**
   * Insert the card stylesheet once per window.
   * @returns {void}
   */
  function ensureStyles() {
    if (styleSeat.done) return
    styleSeat.done = true
    try {
      runtime.insertCss(STYLE)
    } catch (error) {
      void error
    }
  }

  /**
   * The 2x1 preview: the three readings, no controls.
   * @param {object} props - `{ api, t }`.
   * @returns {object} the preview element.
   */
  function ToolUsageCard(props) {
    ensureStyles()
    var t = props.t
    var remote = useRemote('homepage/toolUsage', { options: {} }, { refreshMs: REFRESH_MS })
    var reading = summarize(remote.data, remote.error)

    var lead
    if (reading.topTool !== null) {
      lead = h(
        'div',
        { className: 'ph-tu-lead', title: reading.topTool.name },
        h('span', { className: 'ph-tu-lead-tag' }, t('toolUsage.preview.top')),
        h('span', { className: 'ph-tu-lead-name' }, reading.topTool.name),
        h('span', { className: 'ph-tu-lead-count' }, t('toolUsage.preview.topCalls', { count: formatInt(reading.topTool.calls) })),
      )
    } else {
      lead = h('div', { className: 'ph-tu-lead is-empty' }, t('toolUsage.preview.none'))
    }

    var notices = null
    if (reading.loading) {
      notices = h('p', { className: 'ph-tu-loading' }, t('toolUsage.loading'))
    } else if (!reading.available) {
      notices = h(
        'div',
        { className: 'ph-tu-flag is-warn' },
        ICONS.warn(13),
        h('span', null, t('toolUsage.preview.unavailable')),
      )
    } else if (reading.partial) {
      notices = h(
        'div',
        { className: 'ph-tu-flag' },
        ICONS.info(13),
        h('span', null, t('toolUsage.preview.partial')),
      )
    }

    return h(
      'div',
      { className: 'ph-tu ph-tu-preview' + (reading.available ? '' : ' is-unavailable') },
      h(
        'div',
        { className: 'ph-tu-readings' },
        h(
          'div',
          { className: 'ph-tu-hero' },
          h('span', { className: 'ph-tu-hero-num' }, formatCompact(reading.totals.calls)),
          h('span', { className: 'ph-tu-hero-label' }, t('toolUsage.preview.calls')),
        ),
        h(
          'div',
          { className: 'ph-tu-side' },
          h('span', { className: 'ph-tu-side-num' }, formatTokens(reading.totals.tokens)),
          h('span', { className: 'ph-tu-side-label' }, t('toolUsage.preview.tokens')),
        ),
      ),
      lead,
      notices,
      h(
        'div',
        { className: 'ph-tu-foot' },
        h('span', null, t('toolUsage.preview.tools', { count: formatInt(reading.toolCount) })),
        h('span', { className: 'ph-tu-sep' }, '·'),
        h('span', null, t('toolUsage.preview.projects', { count: formatInt(reading.projectCount) })),
      ),
    )
  }

  /**
   * One tool row: name, call bar, calls, error chip and the estimated sizes.
   * @param {object} props - `{ row, largest, t }`.
   * @returns {object} the row element.
   */
  function ToolRow(props) {
    var row = props.row
    var t = props.t
    var share = shareOf(row.calls, props.largest)
    return h(
      'div',
      { className: 'ph-tu-row', role: 'listitem', title: row.name },
      h(
        'div',
        { className: 'ph-tu-row-top' },
        h('span', { className: 'ph-tu-row-name', title: row.name }, row.name),
        row.errors > 0
          ? h(
              'span',
              { className: 'ph-tu-row-err', title: t('toolUsage.row.errors', { count: formatInt(row.errors) }) },
              formatPercent(row.errorRate),
            )
          : null,
        h('span', { className: 'ph-tu-row-calls' }, formatInt(row.calls)),
      ),
      h('div', { className: 'ph-tu-bar' }, h('i', { style: { width: share + '%' } })),
      h(
        'div',
        { className: 'ph-tu-row-meta' },
        h('span', null, t('toolUsage.row.in', { value: formatTokens(row.argTokens) })),
        h('span', null, t('toolUsage.row.out', { value: formatTokens(row.outTokens) })),
        h('span', { className: 'ph-tu-row-avg' }, t('toolUsage.row.avg', { value: formatMs(row.avgMs) })),
      ),
    )
  }

  /**
   * The expanded page: stats, project switcher, and the scrollable tool table.
   * @param {object} props - `{ api, t }`.
   * @returns {object} the page element.
   */
  function ToolUsageDetail(props) {
    ensureStyles()
    var t = props.t
    var remote = useRemote('homepage/toolUsage', { options: {} }, { refreshMs: REFRESH_MS })
    var selectedState = React.useState('')
    var selected = selectedState[0]
    var setSelected = selectedState[1]
    var reading = summarize(remote.data, remote.error)

    var active = null
    for (var index = 0; index < reading.projects.length; index += 1) {
      if (reading.projects[index].key === selected) active = reading.projects[index]
    }
    var activeKey = active === null ? '' : active.key
    var rows = active === null ? reading.tools : active.tools
    var largest = 0
    for (var rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      if (rows[rowIndex].calls > largest) largest = rows[rowIndex].calls
    }

    /**
     * Re-read the host without flashing the busy state.
     * @returns {void}
     */
    function refresh() {
      void remote.reload(true)
    }

    var notices = null
    if (reading.loading) {
      notices = h('p', { className: 'ph-tu-loading' }, t('toolUsage.loading'))
    } else if (!reading.available) {
      notices = h(
        'div',
        { className: 'ph-tu-empty' },
        h('b', null, t('toolUsage.unavailable.title')),
        h('span', null, reading.error
          ? t('toolUsage.load.failed', { reason: reading.error })
          : reading.reason || t('toolUsage.unavailable.hint')),
      )
    }

    var chips = [
      h(
        'button',
        {
          key: 'all',
          type: 'button',
          className: 'ph-tu-chip' + (activeKey === '' ? ' is-active' : ''),
          'aria-pressed': activeKey === '',
          title: t('toolUsage.page.allHint'),
          onClick: function () { setSelected('') },
        },
        t('toolUsage.page.all'),
        h('span', { className: 'ph-tu-chip-count' }, formatInt(reading.totals.calls)),
      ),
    ]
    for (var projectIndex = 0; projectIndex < reading.projects.length; projectIndex += 1) {
      var project = reading.projects[projectIndex]
      chips.push(
        h(
          'button',
          {
            key: 'p' + projectIndex,
            type: 'button',
            className: 'ph-tu-chip' + (activeKey === project.key ? ' is-active' : ''),
            'aria-pressed': activeKey === project.key,
            title: project.path || project.label,
            onClick: (function (key) {
              return function () { setSelected(key) }
            })(project.key),
          },
          project.label,
          h('span', { className: 'ph-tu-chip-count' }, formatInt(project.calls)),
        ),
      )
    }

    var projectBlock = null
    if (active !== null) {
      var topChips = active.top.slice(0, 3).map(function (entry, topIndex) {
        return h(
          'span',
          { key: 't' + topIndex, className: 'ph-tu-proj-tool', title: entry.name },
          h('b', null, entry.name),
          h('span', null, formatInt(entry.calls)),
        )
      })
      projectBlock = h(
        'div',
        { className: 'ph-tu-proj' },
        h(
          'div',
          { className: 'ph-tu-proj-head' },
          h('span', { className: 'ph-tu-proj-name', title: active.label }, active.label),
          h('span', { className: 'ph-tu-proj-path', title: active.path || undefined }, active.path),
        ),
        h(
          'div',
          { className: 'ph-tu-proj-reads' },
          h(
            'span',
            { className: 'ph-tu-proj-reading' },
            h('b', null, formatInt(active.sessions)),
            h('i', null, t('toolUsage.stat.sessions')),
          ),
          h(
            'span',
            { className: 'ph-tu-proj-reading' },
            h('b', null, formatInt(active.calls)),
            h('i', null, t('toolUsage.stat.calls')),
          ),
          h(
            'span',
            { className: 'ph-tu-proj-reading' },
            h('b', null, formatInt(active.toolCount)),
            h('i', null, t('toolUsage.stat.tools')),
          ),
        ),
        active.top.length > 0
          ? h(
              'div',
              { className: 'ph-tu-proj-top' },
              h('span', { className: 'ph-tu-proj-top-label' }, t('toolUsage.project.top')),
              topChips,
            )
          : null,
      )
    }

    var table
    if (rows.length === 0) {
      table = h('p', { className: 'ph-tu-rows-empty' }, t('toolUsage.page.empty'))
    } else {
      table = h(
        'div',
        { className: 'ph-tu-rows', role: 'list' },
        rows.map(function (row) {
          return h(ToolRow, { key: row.name, row: row, largest: largest, t: t })
        }),
      )
    }

    return h(
      'div',
      { className: 'ph-tu ph-tu-page' },
      h(
        'header',
        { className: 'ph-tu-head' },
        h('span', { className: 'ph-tu-head-spacer' }),
        h(
          'button',
          {
            type: 'button',
            className: 'ph-tu-iconbtn',
            title: t('toolUsage.page.refresh'),
            'aria-label': t('toolUsage.page.refresh'),
            onClick: refresh,
            disabled: remote.busy === true,
          },
          ICONS.refresh(15),
        ),
      ),
      notices,
      h(
        'div',
        { className: 'ph-tu-stats' },
        h(UI.Stat, { label: t('toolUsage.stat.calls'), value: formatInt(reading.totals.calls) }),
        h(UI.Stat, {
          label: t('toolUsage.stat.errors'),
          value: formatPercent(reading.totals.errorRate),
        }),
        h(UI.Stat, { label: t('toolUsage.stat.args'), value: formatTokens(reading.totals.argTokens) }),
        h(UI.Stat, { label: t('toolUsage.stat.out'), value: formatTokens(reading.totals.outTokens) }),
      ),
      h(
        'section',
        { className: 'ph-tu-block' },
        h('h4', { className: 'ph-tu-block-title' }, t('toolUsage.page.projects')),
        h('div', { className: 'ph-tu-switch', role: 'group', 'aria-label': t('toolUsage.page.projects') }, chips),
        projectBlock,
      ),
      h(
        'section',
        { className: 'ph-tu-block' },
        h('h4', { className: 'ph-tu-block-title' }, t('toolUsage.page.tools')),
        table,
      ),
      h(
        'p',
        { className: 'ph-tu-note' },
        reading.partial
          ? t('toolUsage.partial')
          : t('toolUsage.window.cumulative', { count: formatInt(reading.window.sessions) }),
      ),
    )
  }

  defineCard({
    id: 'tool-usage',
    shipped: true,
    order: 55,
    title: function () {
      return runtime.t('toolUsage.title')
    },
    icon: function (size) {
      return ICONS.grid(size)
    },
    size: { w: 2, h: 1 },
    minSize: { w: 1, h: 1 },
    maxSize: { w: 4, h: 3 },
    accent: ACCENT,
    texture: { icon: 'grid', opacity: 5, size: 118, bleed: '-16%' },
    tags: ['tools', 'tokens', 'usage'],
    refreshMs: REFRESH_MS,
    content: function (api) {
      return h(ToolUsageCard, { api: api, t: runtime.t })
    },
    detail: function (api) {
      return h(ToolUsageDetail, { api: api, t: runtime.t })
    },
    formatCompact: formatCompact,
    formatInt: formatInt,
    formatTokens: formatTokens,
    formatPercent: formatPercent,
    formatMs: formatMs,
    summarize: summarize,
    dict: {
      zh: {
        'toolUsage.title': '工具用量',
        'toolUsage.preview.calls': '累计调用',
        'toolUsage.preview.tokens': '估算令牌',
        'toolUsage.preview.top': '最常用',
        'toolUsage.preview.topCalls': '{count} 次',
        'toolUsage.preview.tools': '{count} 个工具',
        'toolUsage.preview.projects': '{count} 个项目',
        'toolUsage.preview.none': '还没有工具调用记录',
        'toolUsage.preview.partial': '部分数据',
        'toolUsage.preview.unavailable': '用量不可用',
        'toolUsage.loading': '正在读取调用记录…',
        'toolUsage.load.failed': '读取失败：{reason}',
        'toolUsage.unavailable.title': '工具用量不可用',
        'toolUsage.unavailable.hint': 'DSH 尚未提供会话的调用记录。',
        'toolUsage.page.refresh': '刷新',
        'toolUsage.page.projects': '按项目',
        'toolUsage.page.tools': '工具明细',
        'toolUsage.page.all': '全部',
        'toolUsage.page.allHint': '所有项目的调用',
        'toolUsage.page.empty': '这里还没有调用记录',
        'toolUsage.stat.calls': '调用',
        'toolUsage.stat.errors': '错误率',
        'toolUsage.stat.args': '输入令牌',
        'toolUsage.stat.out': '输出令牌',
        'toolUsage.stat.sessions': '会话',
        'toolUsage.stat.tools': '工具',
        'toolUsage.row.errors': '{count} 次错误',
        'toolUsage.row.in': '入 {value}',
        'toolUsage.row.out': '出 {value}',
        'toolUsage.row.avg': '均 {value}',
        'toolUsage.project.top': '常用工具',
        'toolUsage.partial': '扫描不完整：部分会话未能读取，数字是下限。',
        'toolUsage.window.cumulative': '累计 {count} 个已存会话，不是今日数据',
      },
      en: {
        'toolUsage.title': 'Tool usage',
        'toolUsage.preview.calls': 'Calls',
        'toolUsage.preview.tokens': 'Est. tokens',
        'toolUsage.preview.top': 'Most used',
        'toolUsage.preview.topCalls': '{count} calls',
        'toolUsage.preview.tools': '{count} tools',
        'toolUsage.preview.projects': '{count} projects',
        'toolUsage.preview.none': 'No tool calls recorded yet',
        'toolUsage.preview.partial': 'Partial data',
        'toolUsage.preview.unavailable': 'Usage unavailable',
        'toolUsage.loading': 'Reading call records…',
        'toolUsage.load.failed': 'Could not read: {reason}',
        'toolUsage.unavailable.title': 'Tool usage unavailable',
        'toolUsage.unavailable.hint': 'DSH has not provided call records for stored sessions yet.',
        'toolUsage.page.refresh': 'Refresh',
        'toolUsage.page.projects': 'By project',
        'toolUsage.page.tools': 'Tool detail',
        'toolUsage.page.all': 'All',
        'toolUsage.page.allHint': 'Calls across every project',
        'toolUsage.page.empty': 'No calls recorded here yet',
        'toolUsage.stat.calls': 'Calls',
        'toolUsage.stat.errors': 'Error rate',
        'toolUsage.stat.args': 'Input tokens',
        'toolUsage.stat.out': 'Output tokens',
        'toolUsage.stat.sessions': 'Sessions',
        'toolUsage.stat.tools': 'Tools',
        'toolUsage.row.errors': '{count} errors',
        'toolUsage.row.in': 'in {value}',
        'toolUsage.row.out': 'out {value}',
        'toolUsage.row.avg': 'avg {value}',
        'toolUsage.project.top': 'Top tools',
        'toolUsage.partial': 'Scan incomplete: some sessions could not be read, so these numbers are a lower bound.',
        'toolUsage.window.cumulative': 'Cumulative over {count} stored sessions, not today',
      },
    },
  })
    })(Kit)

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    exports.defineCard = defineCard
    exports.cardApi = cardApi
    exports.UI = UI
    exports.ICONS = ICONS
    exports.bg = bg
    exports.EFFECTS = EFFECTS
    exports.STYLES = STYLES
    exports.hooks = hooks
    exports._internal = {
      store: store, bump: bump, notify: notify, remoteCall: remoteCall, runtime: runtime,
      useStore: useStore, useRemote: useRemote, useClock: useClock, useNoticeOnce: useNoticeOnce,
      orderedCards: orderedCards, cardSpan: cardSpan, expandCard: expandCard, collapseCard: collapseCard,
      patchState: patchState, patchSection: patchSection, cardEffectRecord: cardEffectRecord,
      cardEffectNames: cardEffectNames, backgroundProps: backgroundProps, iconOf: iconOf,
      renderAction: renderAction, renderActions: renderActions, currencySymbol: currencySymbol,
      dayKey: dayKey, formatNumber: formatNumber,
      // The session bridge is mounted by the panel and never reached from a card,
      // so its contract is exercised through these three directly.
      SessionStatusBridge: SessionStatusBridge, SessionListBridge: SessionListBridge,
      bridgeSelector: bridgeSelector,
    }
    return module.exports
  },
})
