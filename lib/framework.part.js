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
      // A card registered after the wall booted is mounted only if it is on
      // the wall; a hidden one waits until it is shown.
      if (bootstrapped && store.hostReady && cardVisible(next)) mountCard(next)
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
      delete mountedCards[id]
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
        if (settings.enabled === false) {
          alive.current = false
          return undefined
        }
        alive.current = true
        void load(false)
        if (!settings.refreshMs) return function () { alive.current = false }
        var base = Math.max(1000, Number(settings.refreshMs) || 0)
        var timer = null
        // Re-arm one timer at a time with a little jitter. Cards that mounted
        // together would otherwise refresh together forever, and every peak is
        // paid by the host at once; ±10% spreads them without changing the
        // cadence a reader sees.
        var arm = function () {
          var delay = Math.round(base * (0.9 + Math.random() * 0.2))
          timer = setTimeout(function () {
            timer = null
            if (!alive.current) return
            void load(true)
            arm()
          }, delay)
          // A card test (or a headless host) must not be kept alive by a poll
          // it never sees fire; a browser timer has no unref and ignores this.
          if (timer && typeof timer.unref === 'function') timer.unref()
        }
        arm()
        return function () {
          alive.current = false
          if (timer !== null) clearTimeout(timer)
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
      // A card is mounted when it reaches the wall, not when it was defined.
      if (visible) mountCard(card)
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
    /** Cards whose `onMount` already ran; one entry per card id. */
    var mountedCards = Object.create(null)

    /**
     * Run a card's `onMount` the first time it is actually on the wall.
     *
     * A hidden card is disabled: it is not rendered, it polls nothing, and it
     * must not get lifecycle work either. The old bootstrap ran every
     * registered card's `onMount` before the persisted visibility was known,
     * so a disabled card still armed whatever its hook armed.
     * @param card - a registered card.
     */
    function mountCard(card) {
      if (mountedCards[card.id] === true) return
      mountedCards[card.id] = true
      runOnMount(card)
    }

    /** Mount every card the persisted layout puts on the wall. */
    function mountVisibleCards() {
      orderedCards().filter(cardVisible).forEach(mountCard)
    }

    /** Load the persisted layout and install card hooks exactly once. */
    function bootstrap() {
      if (bootstrapped) return Promise.resolve()
      bootstrapped = true
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
      }).then(function (value) {
        // Only after the visibility document is in hand: a card the user hid
        // is not mounted and runs nothing.
        mountVisibleCards()
        return value
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
     * holds) from the session list; both are standard props at root scope. The
     * UI status map is the third: it is what lets a row carry a pending
     * approval, an unread completion or a running child, which the session list
     * alone cannot express.
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
      var statuses = props && props.useSessionStatus
      var snapshot = typeof workspaces === 'function' ? workspaces(workspaceSnapshotOf) : null
      var list = typeof sessions === 'function' ? sessions(sessionListOf) : null
      // The UI status map is the same store the panel bridge copies: it is what
      // tells a pending approval, an unread completion and a running child
      // apart from an idle row. A host without it leaves the projection on the
      // session list's own `running` flag.
      var status = typeof statuses === 'function' ? statuses(bridgeSelector) : null
      React.useEffect(function () { reportWorkspaces(snapshot, list, status) }, [snapshot, list, status])
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
          useSessionStatus: props ? props.useSessionStatus : null,
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
      // The shipped row drops its whole resting strip while it is hovered, so
      // the pinned marker gives way to the hover buttons as well.
      '.ph-sb-row:hover .ph-sb-pin,.ph-sb-row:focus-within .ph-sb-pin,.ph-sb-row.is-open .ph-sb-pin{display:none}',

      '.ph-sb-more{width:100%;box-sizing:border-box;height:28px;border:0;border-radius:var(--dsw-radius-sm,6px);' +
        'padding:0 12px 0 calc(28px + var(--ph-sb-indent,0px));background:transparent;cursor:pointer;' +
        'text-align:left;font-family:inherit;font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.ph-sb-more:hover{color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      // Show more continues the Session rows above it, so it takes their indent;
      // the shape itself is the quiet full-width button beside it.
      '.ph-sb-overflow{--ph-sb-indent:24px}',
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
      '.ph-sb-dir-crumbs{display:flex;align-items:center;flex-wrap:wrap;gap:0 2px;min-height:22px;flex:none}',
      // The trail turns into a path field: the shipped browser lets a reader
      // type an absolute path instead of walking to it.
      '.ph-sb-dir-path{display:flex;align-items:center;gap:6px;min-height:22px;flex:none}',
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
      // The list is the one child that gives way when the dialog hits its
      // height: a row of text shrunk to fit its box, which is how the target
      // line lost its lower half. Every other child keeps its height, and the
      // list scrolls instead.
      '.ph-sb-dir-list{display:flex;flex-direction:column;gap:1px;min-height:0;overflow:auto;flex:1 1 auto}',
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
      '.ph-sb-dir-note{padding:4px;font-size:12px;line-height:18px;flex:none;' +
      'color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      // The target is a path, and the part of it that tells two folders apart is
      // the end: it wraps rather than ellipsizing the folder away, and it never
      // gives up height to the scrolling list below it (a clipped line is what a
      // shrunk flex item with `overflow:hidden` looks like).
      '.ph-sb-dir-target{flex:none;overflow-wrap:anywhere;' +
      'color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.ph-sb-dir-newfold{display:flex;align-items:center;gap:6px;flex:none}',
      // The error line sits in the same column: it is the one thing the reader
      // must be able to read, so it keeps its height like the notes above it.
      '.ph-sb-dir .ph-sb-form-error{flex:none}',
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

      // the DSH card's outcome lines: a build that started, and one that did not
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
      // A reading the machine could not produce is a fact, not a failure: it
      // stays in the ordinary ink so the card never looks broken over it.
      '.ph-spec-value--muted{color:var(--dsw-alias-label-secondary,#9aa4b2);font-weight:500}',
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
      '.ph-audit-detail{gap:18px}.ph-audit-detail>.ph-loose{gap:14px}',
      '.ph-audit-launch{position:relative;padding:24px;border-radius:18px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#e6e8ea) 14%,transparent);background:linear-gradient(125deg,rgba(99,102,241,.09),transparent 65%),var(--dsw-alias-bg-layer-2,rgba(255,255,255,.035));box-shadow:0 8px 28px rgba(0,0,0,.035)}',
      '.ph-audit-launch-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px;flex-wrap:wrap}',
      '.ph-audit-launch-heading{display:flex;align-items:center;gap:12px}.ph-audit-launch-icon{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:rgba(99,102,241,.12);color:var(--dsw-alias-label-primary,#e6e8ea);font-size:23px}',
      '.ph-audit-launch-title{margin:0;font-size:18px;font-weight:650;letter-spacing:-.025em}',
      '.ph-audit-prompt-trigger{display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:6px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.04));color:inherit;font:inherit;font-size:12px;cursor:pointer;transition:background .16s,border-color .16s}',
      '.ph-audit-prompt-trigger:hover,.ph-audit-prompt-trigger[aria-expanded=true]{background:rgba(99,102,241,.12);border-color:rgba(129,140,248,.5)}.ph-audit-prompt-badge{font-size:10px;padding:2px 6px;border-radius:5px;background:rgba(127,127,127,.1);color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      '.ph-audit-target-form{gap:14px}.ph-audit-target-form>.ph-loose-row:last-child{order:-1;display:flex;gap:10px;flex-wrap:nowrap}.ph-audit-target-form .ph-input{min-width:0;flex:1;height:48px;padding:0 15px;border-radius:12px;font-size:14px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.12))}',
      '.ph-audit-target-form>.ph-loose-row:last-child button{min-height:48px;flex:none;padding:0 24px;border-radius:12px;font-size:13px;font-weight:650}.ph-audit-target-form .ph-segment{min-height:30px;font-size:11px;padding:5px 12px}.ph-audit-target-form .ph-segmented{padding:3px}',
      '.ph-audit-detail>.ph-segmented{display:flex;width:100%;box-sizing:border-box;padding:5px;gap:5px;border-radius:13px}.ph-audit-detail>.ph-segmented>.ph-segment{flex:1;min-height:42px;font-size:14px;font-weight:650;border-radius:9px;transition:background .2s,color .2s,box-shadow .2s}',
      '.ph-audit-models{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:12px;margin-top:18px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09))}.ph-audit-model-field{display:flex;flex-direction:column;gap:7px;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b2)}.ph-audit-model-field select{width:100%;min-width:0;height:38px;border-radius:9px;padding:0 10px;color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.ph-audit-settings.ph-audit-reveal{margin-top:20px;padding-top:20px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));transition:grid-template-rows .25s ease,opacity .2s ease,margin .25s,padding .25s,border-color .25s}.ph-audit-settings[hidden]{margin-top:0;padding-top:0;border-color:transparent}',
      '.ph-audit-reveal,.ph-audit-reveal[hidden]{display:grid;grid-template-rows:1fr;opacity:1;transition:grid-template-rows .25s ease,opacity .2s ease}.ph-audit-reveal[hidden]{grid-template-rows:0fr;opacity:0;pointer-events:none}.ph-audit-reveal-inner{min-height:0;overflow:hidden;visibility:visible;transition:visibility .25s}.ph-audit-reveal[hidden]>.ph-audit-reveal-inner{visibility:hidden}.ph-audit-settings>.ph-loose{gap:12px}',
      '@keyframes ph-audit-enter{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}.ph-audit-pane{animation:ph-audit-enter .16s ease both}.ph-audit-result{animation:ph-audit-enter .22s ease both}.ph-audit-detail button{transition:background .18s,color .18s,border-color .18s,box-shadow .18s}',
      '@supports(interpolate-size:allow-keywords){.ph-audit-metadata{interpolate-size:allow-keywords}.ph-audit-metadata::details-content{overflow:hidden;block-size:0;opacity:0;transition:block-size .25s,opacity .2s,content-visibility .25s allow-discrete}.ph-audit-metadata[open]::details-content{block-size:auto;opacity:1}}',
      '@media(max-width:600px){.ph-audit-models{grid-template-columns:1fr}}@media(prefers-reduced-motion:reduce){.ph-audit-detail *,.ph-audit-detail *::details-content{animation:none!important;transition:none!important}}',
      '.ph-audit-editor-head{display:flex;align-items:center;justify-content:space-between;font-size:13px}.ph-audit-editor-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}.ph-audit-editor-footer>[role=status]{margin-right:auto}.ph-audit-editor-footer button{min-height:34px;padding:6px 12px;border-radius:8px}',
      '.ph-audit-metadata>summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);padding:6px 0}',
      '.ph-audit-prompt{width:100%;min-height:260px;resize:vertical;box-sizing:border-box;font-family:inherit;font-size:12px;line-height:1.8;padding:14px;border-radius:10px}',
      '.ph-audit-prompt-trigger:focus-visible{outline:2px solid #818cf8;outline-offset:3px}@media(max-width:600px){.ph-audit-launch{padding:16px}.ph-audit-target-form>.ph-loose-row:last-child{flex-wrap:wrap}.ph-audit-target-form>.ph-loose-row:last-child button{width:100%}.ph-audit-target-form .ph-input{flex-basis:100%}}',
      '.ph-audit-result-actions{margin:16px 0}.ph-audit-result-actions button{min-height:36px;padding:7px 16px;border-radius:9px}',
      '.ph-audit-result{padding:20px;border-radius:16px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09))}',
      '.ph-audit-result-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ph-audit-name{font-size:15px;overflow-wrap:anywhere}',
      '.ph-audit-detail .ph-audit-finding-head{padding:11px 12px}.ph-audit-detail .ph-audit-finding-title{white-space:normal;overflow-wrap:anywhere;line-height:1.5}',
      '.ph-audit-summary{font-size:14px;line-height:1.75;margin:12px 0;color:var(--dsw-alias-label-primary,#e6e8ea);overflow-wrap:anywhere}',
      '.ph-audit-metadata .ph-kv{margin-top:10px}.ph-audit-detail summary:focus-visible{outline:2px solid currentColor;outline-offset:3px;border-radius:4px}',
      // The DSH core card leads with what it is FOR, because the machine it is
      // mounted on is often not the machine it is about: a packaged DSH has no
      // build to update. The panel carries the purpose, the state and the two
      // readings; everything else folds away below it.
      '.ph-dsh-detail{gap:16px}',
      '.ph-dsh-launch{position:relative;padding:22px;border-radius:18px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#e6e8ea) 14%,transparent);background:linear-gradient(125deg,rgba(79,70,229,.09),transparent 65%),var(--dsw-alias-bg-layer-2,rgba(255,255,255,.035));box-shadow:0 8px 28px rgba(0,0,0,.035)}',
      '.ph-dsh-launch-head{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:12px;flex-wrap:wrap}',
      '.ph-dsh-launch-heading{display:flex;align-items:center;gap:12px}',
      '.ph-dsh-launch-icon{display:grid;place-items:center;width:38px;height:38px;border-radius:12px;background:rgba(79,70,229,.14);color:var(--dsw-alias-label-primary,#e6e8ea);font-size:20px;line-height:1}',
      '.ph-dsh-launch-title{margin:0;font-size:17px;font-weight:650;letter-spacing:-.025em}',
      '.ph-dsh-purpose{margin:0;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary,#9aa4b2);max-width:64ch}',
      '.ph-dsh-scope{margin:8px 0 0;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-primary,#e6e8ea);max-width:64ch}',
      '.ph-dsh-reason{margin:8px 0 0;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-state-warn-primary,#d29922);max-width:64ch}',
      '.ph-dsh-readings{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-top:16px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}',
      '.ph-dsh-reading{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.ph-dsh-reading-label{font-size:10.5px;color:var(--dsw-alias-label-secondary,#9aa4b2)}',
      '.ph-dsh-reading-value{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
      '.ph-dsh-more{display:inline-flex;align-items:center;gap:7px;align-self:flex-start;margin-top:2px;padding:6px 11px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.04));color:var(--dsw-alias-label-secondary,#9aa4b2);font:inherit;font-size:11.5px;cursor:pointer;transition:background .16s,color .16s,border-color .16s}',
      '.ph-dsh-more:hover{background:rgba(99,102,241,.1);border-color:rgba(129,140,248,.4);color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.ph-dsh-reveal,.ph-dsh-reveal[hidden]{display:grid;grid-template-rows:1fr;opacity:1;transition:grid-template-rows .25s ease,opacity .2s ease}.ph-dsh-reveal[hidden]{grid-template-rows:0fr;opacity:0;pointer-events:none}.ph-dsh-reveal-inner{min-height:0;overflow:hidden;visibility:visible;transition:visibility .25s}.ph-dsh-reveal[hidden]>.ph-dsh-reveal-inner{visibility:hidden}',
      '.ph-dsh-detail button{transition:background .18s,color .18s,border-color .18s}',
      '@media(max-width:600px){.ph-dsh-launch{padding:16px}}',
      '.ph-audit-findings{display:flex;flex-direction:column;gap:8px}',
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
      // Two optional capabilities, deliberately outside `inject`: a host that
      // does not provide them must still mount this plugin, so they are read
      // by name and may answer null. `shortcuts` is the shell's own keyboard
      // registry (its catalog carries the effective keycaps a menu row shows);
      // `remote.session` is the Session remote namespace (its `rename` and
      // `canOpenWorkspacePath` calls are what a session row needs).
      sidebarServices.shortcuts = serviceOf(ctx, 'shortcuts')
      sidebarServices.remoteSession = serviceOf(ctx, 'remote.session')

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
      'sidebar.list.dirTarget': '将在此创建工作区：{path}',
      'sidebar.list.dirFailed': '读不到这个目录：{reason}',
      'sidebar.list.apply': '确定',
      'sidebar.list.more': '更多',
      'sidebar.list.count': '{count} 个会话',
      // The shipped browser's overflow control: one click adds five rows, and
      // the last click reveals the remainder (labels match ui-workspace).
      'sidebar.list.expand': '展开其余 {count} 个会话',
      'sidebar.list.collapse': '收起',
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
      'sidebar.session.copyId': '复制 Session ID',
      'sidebar.session.reveal': '在文件夹显示',
      'sidebar.session.finder': '在 Finder 中显示',
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
      'sidebar.list.dirTarget': 'Creates the workspace in: {path}',
      'sidebar.list.dirFailed': 'Cannot read this folder: {reason}',
      'sidebar.list.apply': 'Apply',
      'sidebar.list.more': 'More',
      'sidebar.list.count': '{count} sessions',
      'sidebar.list.expand': 'Show {count} more sessions',
      'sidebar.list.collapse': 'Show less',
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
      'sidebar.session.copyId': 'Copy Session ID',
      'sidebar.session.reveal': 'Show in folder',
      'sidebar.session.finder': 'Show in Finder',
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
    var sidebarServices = { workspaces: null, sessions: null, uiWorkspace: null, layout: null, shortcuts: null, remoteSession: null }
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

    var sidebar = {
      version: 0, layout: null, at: 0, phase: 'idle', error: null,
      workspaces: null, current: null, subagents: null, signature: '',
    }
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
     * @returns one clean `{ id, title, display, blank, running, runningChild, pending, completed, pinned, archived, updatedAt }`.
     */
    function normalizeSessionRow(entry) {
      var row = entry && typeof entry === 'object' ? entry : {}
      return {
        id: String(row.id === undefined || row.id === null ? '' : row.id),
        title: String(row.title === undefined || row.title === null ? '' : row.title),
        display: String(row.display === undefined || row.display === null ? '' : row.display),
        blank: !!row.blank,
        running: !!row.running,
        runningChild: !!row.runningChild,
        pending: !!row.pending,
        completed: !!row.completed,
        pinned: !!row.pinned,
        archived: !!row.archived,
        updatedAt: Number(row.updatedAt) || 0,
        // The working directory travels with the row: a reveal action opens
        // the folder this Session runs in, and it is read from the row rather
        // than re-queried from a service at click time.
        cwd: String(row.cwd === undefined || row.cwd === null ? '' : row.cwd),
      }
    }
    /**
     * Read one workspace instant: the Host stamps Workspace rows with ISO-8601
     * strings, while a projection that was already reduced can carry epoch
     * milliseconds. Both are wanted by the list, which orders by them.
     * @param value - an ISO-8601 instant, epoch milliseconds, or anything else.
     * @returns epoch milliseconds, or 0 when it names no time.
     */
    function epochOf(value) {
      if (typeof value === 'number') return isFinite(value) && value > 0 ? value : 0
      var text = String(value === undefined || value === null ? '' : value)
      if (text === '') return 0
      var parsed = Date.parse(text)
      return isFinite(parsed) && parsed > 0 ? parsed : 0
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
          // When the Workspace itself was registered. A project with no Sessions
          // is not old — creating it is an event — so the list's recency order
          // counts this alongside its newest Session.
          createdAt: epochOf(item.createdAt),
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
     * @param status - the `useSessionStatus` map, when the caller has one.
     * @returns the projection of its items, with each project's sessions.
     */
    function projectionOfWorkspaces(snapshot, list, status) {
      var items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
      var byId = list && list.byId && typeof list.byId === 'object' ? list.byId : {}
      var pinned = idListOf(snapshot ? snapshot.pinnedSessionIds : null)
      var archived = idListOf(snapshot ? snapshot.archivedSessionIds : null)
      var statuses = status && typeof status.get === 'function' ? status : null
      /**
       * @param key - the session id.
       * @returns its UI status row, or null when the host has no status store.
       */
      function statusOf(key) {
        var entry = statuses ? statuses.get(key) : null
        return entry && typeof entry === 'object' ? entry : null
      }
      /**
       * Whether one Session has a running child. The shipped browser raises a
       * parent's watermark for that too, because the override hides the child's
       * own row, so the parent is the only place the activity could show.
       * @param key - the parent session id.
       * @returns true when its subagent catalog names a running child.
       */
      function runningChildOf(key) {
        var projections = list && list.projectionsBySession && typeof list.projectionsBySession === 'object'
          ? list.projectionsBySession : null
        var block = projections ? projections[key] : null
        var values = block && block.values ? block.values : null
        var catalog = values && Array.isArray(values.subagentCatalog) ? values.subagentCatalog : null
        if (!catalog) return false
        for (var i = 0; i < catalog.length; i += 1) {
          var child = catalog[i] && catalog[i].id !== undefined && catalog[i].id !== null
            ? String(catalog[i].id) : ''
          if (child === '') continue
          var childStatus = statusOf(child)
          var running = childStatus && typeof childStatus.running === 'boolean'
            ? childStatus.running
            : !!(byId[child] && byId[child].running)
          if (running) return true
        }
        return false
      }
      /**
       * @param key - the session id.
       * @param summary - its session-list summary, or an empty object.
       * @returns the projected row.
       */
      function rowOf(key, summary) {
        // The UI status map is fresher than the list summary for `running`, and
        // it is the only source for the three attention facts the shipped
        // browser raises a watermark for (pending interaction, unread
        // completion, running child).
        var status = statusOf(key)
        return {
          id: key,
          title: summary.title,
          display: summary.displayTitle,
          blank: summary.blank,
          running: status && typeof status.running === 'boolean' ? status.running : !!summary.running,
          runningChild: runningChildOf(key),
          pending: !!(status && status.pendingInteraction),
          completed: !!(status && status.completionUnread),
          pinned: pinned.indexOf(key) !== -1,
          archived: archived.indexOf(key) !== -1,
          updatedAt: summary.updatedAt,
          // The session's working directory, carried like the shipped row
          // carries it: a reveal action needs it, and the list already holds
          // it per session.
          cwd: summary.cwd,
        }
      }
      /**
       * Whether a session belongs in the sidebar at all. A subagent session —
       * a spawned subagent or an Agent Teams member — is never a peer row: the
       * shipped browser keeps it out of every list, workspace groups and search
       * alike, and reaches it through the parent Session's own catalog
       * (`sessionVisible` in
       * `packages/client/ui-workspace/src/client/tree.ts`). Without this filter
       * the projection turned every running subagent into another sidebar
       * session and filled the list with children nobody opened. A row with no
       * summary yet stays: it is a real Session whose summary has not landed.
       * @param summary - the `useSessions` row, or undefined.
       * @returns false only for a subagent-origin Session.
       */
      function sessionListed(summary) {
        return !summary || summary.origin !== 'subagent'
      }
      var assigned = {}
      var extra = {}
      var projection = items.map(function (item) {
        var view = item && typeof item === 'object' ? item : {}
        var ids = Array.isArray(view.sessionIds) ? view.sessionIds : []
        var rows = []
        for (var r = 0; r < ids.length; r += 1) {
          var key = String(ids[r])
          if (!sessionListed(byId[key])) continue
          assigned[key] = true
          rows.push(rowOf(key, byId[key] && typeof byId[key] === 'object' ? byId[key] : {}))
        }
        return {
          id: view.workspaceId,
          title: view.title,
          path: view.path,
          createdAt: epochOf(view.createdAt),
          rows: rows,
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
        if (!sessionListed(summary)) continue
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
     * The Session ids the sidebar must never draw. A subagent Session — a
     * spawned subagent or an Agent Teams member — is a child of the Session
     * that started it, and the shipped browser hides it from workspace groups
     * and search results alike (`sessionVisible` in
     * `packages/client/ui-workspace/src/client/tree.ts`). The projection drops
     * those rows; the ids are published too because a content search hits
     * Sessions directly and its results would otherwise re-introduce them.
     * @param list - the `useSessions` snapshot, or null.
     * @returns `{ id: true }` for every subagent-origin Session.
     */
    function subagentIdsOf(list) {
      var byId = list && list.byId && typeof list.byId === 'object' ? list.byId : {}
      var ids = {}
      var keys = Object.keys(byId)
      for (var i = 0; i < keys.length; i += 1) {
        var summary = byId[keys[i]]
        if (summary && summary.origin === 'subagent') ids[keys[i]] = true
      }
      return ids
    }
    /**
     * A cheap fingerprint of a whole projection: comparing strings catches a
     * renamed session or a moved running dot without a deep walk per render.
     * @param items - the projection array.
     * @param current - the current session id, or null.
     * @param subagents - the hidden subagent id set.
     * @returns the fingerprint.
     */
    function projectionSignature(items, current, subagents) {
      var parts = [String(current || ''), Object.keys(subagents).sort().join(',')]
      for (var i = 0; i < items.length; i += 1) {
        var item = items[i]
        parts.push(item.id, item.title, item.path, String(item.sessions), String(item.createdAt))
        for (var j = 0; j < item.rows.length; j += 1) {
          var row = item.rows[j]
          parts.push(
            row.id, row.title, row.display, row.blank ? '1' : '0', row.running ? '1' : '0',
            row.runningChild ? '1' : '0', row.pending ? '1' : '0', row.completed ? '1' : '0',
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
     * @param status - the `useSessionStatus` map, or null.
     */
    function reportWorkspaces(snapshot, list, status) {
      var items = projectionOfWorkspaces(snapshot, list, status)
      var current = currentSessionId(list)
      var subagents = subagentIdsOf(list)
      var signature = projectionSignature(items, current, subagents)
      if (signature === sidebar.signature) return
      sidebar.signature = signature
      sidebar.workspaces = items
      sidebar.current = current
      sidebar.subagents = subagents
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
    /* @cards */

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
