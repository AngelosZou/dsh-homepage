/**
 * dsh-homepage — Host half, the sidebar workspace-group document.
 *
 * Owns the one persisted document behind the left sidebar's workspace grouping:
 * which group a workspace belongs to, the colour and icon that group carries,
 * the order groups and members render in, which rows are pinned and which are
 * hidden, and whether a group orders its members manually or by recency. It is
 * DISPLAY state only — nothing here ever writes a workspace, a session or a
 * project fact back to DSH — and a member that points at a workspace which no
 * longer exists is KEPT in the document (the sidebar filters it), so a project
 * that comes back keeps its group and colour.
 *
 * Contract:
 *
 *  - `normalizeSidebarLayout()` never throws on any input. `undefined`, `null`, a
 *    string, a number, an array, a function, a cyclic object, a wrong-typed
 *    field or a crafted `__proto__` key all resolve to a valid version-1
 *    document, and the result is idempotent: normalising it again changes
 *    nothing;
 *  - untrusted maps are read as PLAIN DATA. Only own data properties are read —
 *    a getter is never invoked and the prototype chain is never consulted — and
 *    the three keys that can reach an object's prototype (`__proto__`,
 *    `constructor`, `prototype`) are dropped, so a crafted document can only
 *    ever pollute itself;
 *  - the client sends the WHOLE document back on every edit, so
 *    `mergeSidebarLayout()` replaces a section instead of merging into it: a
 *    group the client deleted cannot survive. A section the patch OMITS is left
 *    alone (the client's own editors rebuild only the sections they touched) and
 *    an explicit `null` or empty one wipes it;
 *  - every mutator returns a normalised document stamped with the injected clock
 *    (`options.now`, `Date.now` by default), so a caller can render straight
 *    from the return value. Only `addSidebarGroup()` returns a second value;
 *  - `resolveSidebarSections()` is pure and read-only: it never stamps
 *    `updatedAt` and never writes anything;
 *  - `createSidebarStore()` is the only thing that touches the disk. Its `read()`
 *    treats a missing or corrupt file as the default document and never throws;
 *    its `write()` writes a temporary sibling and renames it over the target, so
 *    a crash can never leave half a document behind;
 *  - no filesystem work happens at import time and there are no dependencies
 *    beyond `node:fs` and `node:path`.
 *
 * @module dsh-homepage/host/sidebar
 */
import { promises as fsp } from 'node:fs'
import { join, resolve } from 'node:path'

/** The only document version this module reads and writes. */
export const SIDEBAR_VERSION = 1

/** The file the document lives in, inside the plugin's storage directory. */
const FILE_NAME = 'sidebar-layout.json'

/**
 * Map keys that can reach an object's prototype. The document is untrusted input
 * (a client can send anything at all), so these are dropped rather than copied.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** A group id is a stable, URL-safe token. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** A colour is a six-digit hex string; anything else means "no colour". */
const COLOR_RE = /^#[0-9a-fA-F]{6}$/

/** The two sidebar modes; `native` leaves the official browser alone. */
const MODES = new Set(['native', 'grouped'])

/** The two row densities. */
const DENSITIES = new Set(['cozy', 'compact'])

/** The two group sort modes; `manual` keeps the user's own member order. */
const SORTS = new Set(['manual', 'recent'])

/**
 * Every hard limit the document is clamped to. They exist so one bad client
 * cannot grow the file without bound — dropping the surplus is always better
 * than refusing the whole document.
 */
export const SIDEBAR_LIMITS = Object.freeze({
  groups: 50,
  members: 500,
  expanded: 500,
  id: 64,
  title: 60,
  alias: 60,
  icon: 24,
  ungroupedTitle: 60,
  order: 1000000,
})

/**
 * The document a fresh install (or an unreadable file) starts from. It is frozen
 * so a caller cannot accidentally edit the shared default; `defaultSidebarLayout()`
 * hands out a fresh, mutable copy.
 */
export const SIDEBAR_DEFAULTS = Object.freeze({
  version: SIDEBAR_VERSION,
  mode: 'grouped',
  groups: Object.freeze([]),
  members: Object.freeze({}),
  view: Object.freeze({
    showEmpty: false,
    density: 'cozy',
    ungroupedTitle: 'Ungrouped',
    expanded: Object.freeze({}),
  }),
  updatedAt: 0,
})

/**
 * One sidebar group.
 *
 * @typedef {object} SidebarGroup
 * @property {string} id - stable id, `/^[A-Za-z0-9_-]{1,64}$/`, unique in the document.
 * @property {string} title - 1..60 characters, whitespace collapsed.
 * @property {string|null} color - `#rrggbb`, lowercased, or null.
 * @property {string|null} icon - a short icon name, or null.
 * @property {number} order - integer in +/-1000000; ties fall back to insertion order.
 * @property {boolean} collapsed - whether the section is drawn collapsed.
 * @property {'manual'|'recent'} sort - how the section orders its members; `manual` keeps the stored order.
 */

/**
 * One workspace's display override.
 *
 * @typedef {object} SidebarMember
 * @property {string|null} group - a known group id, or null for ungrouped.
 * @property {number} order - integer in +/-1000000; ties fall back to the title.
 * @property {string|null} color - a per-workspace colour, or null to use the group's.
 * @property {boolean} hidden - whether the row is hidden from the sidebar.
 * @property {string|null} alias - a display-only rename, or null for the real title.
 * @property {boolean} pinned - whether the row is pinned to the top of its section.
 */

/**
 * The non-structural display options.
 *
 * `expanded` is the one field the host does not interpret: it remembers which
 * workspace rows the user opened, keyed by workspace id. Absent means "no
 * opinion yet", which is not the same as `false` — the client draws a row the
 * user never touched collapsed, and follows whatever is stored once they have.
 * That distinction is what makes the sidebar come back the way it was left.
 *
 * @typedef {object} SidebarView
 * @property {boolean} showEmpty - whether the sidebar may draw an empty section.
 * @property {'cozy'|'compact'} density - the row density.
 * @property {string} ungroupedTitle - the heading of the synthetic ungrouped bucket.
 * @property {Record<string, boolean>} expanded - per-workspace row expansion, keyed by workspace id.
 */

/**
 * The whole persisted document.
 *
 * @typedef {object} SidebarLayout
 * @property {number} version - always `SIDEBAR_VERSION`.
 * @property {'native'|'grouped'} mode - which sidebar renders.
 * @property {SidebarGroup[]} groups - at most `SIDEBAR_LIMITS.groups`, in insertion order.
 * @property {Record<string, SidebarMember>} members - keyed by workspace id.
 * @property {SidebarView} view - display options.
 * @property {number} updatedAt - when the document was last written.
 */

/**
 * A workspace as the sidebar sees it. `workspaceId` is the stable key; `title`
 * is what DSH calls the project and may be missing for a workspace that vanished.
 *
 * @typedef {object} SidebarWorkspaceInput
 * @property {string} workspaceId
 * @property {string} [title]
 * @property {string} [path]
 * @property {number} [updatedAt]
 */

/**
 * @returns {SidebarLayout} a fresh, mutable default document.
 */
export function defaultSidebarLayout() {
  return {
    version: SIDEBAR_VERSION,
    mode: SIDEBAR_DEFAULTS.mode,
    groups: [],
    members: {},
    view: { ...SIDEBAR_DEFAULTS.view, expanded: {} },
    updatedAt: 0,
  }
}

/**
 * Is this a plain record (not null, not an array, not a primitive)?
 * It says nothing about whether the record is *useful* — every field is read
 * defensively on its own.
 *
 * @param {unknown} value - anything a client could have sent.
 * @returns {boolean} true when `value` is an object worth probing.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one own DATA property without ever invoking a getter and without
 * consulting the prototype chain. `{}.constructor` and a block that inherits
 * `groups` from a prototype therefore both read as absent.
 *
 * @param {unknown} source - the record to read from.
 * @param {string} key - the property name.
 * @returns {unknown} the property value, or undefined when it is not own data.
 */
function ownField(source, key) {
  if (!isRecord(source)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

/**
 * Every own enumerable DATA entry of a map, in insertion order. Accessors are
 * skipped rather than invoked, and anything that is not a plain record gives an
 * empty list, so this is safe on a client-supplied object of any shape.
 *
 * @param {unknown} value - the map to walk.
 * @returns {Array<[string, unknown]>} the entries.
 */
function dataEntries(value) {
  const out = []
  if (!isRecord(value)) return out
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) out.push([key, descriptor.value])
  }
  return out
}

/**
 * Collapse runs of whitespace to one space and trim. A title that is only
 * whitespace is not a title.
 *
 * @param {unknown} value - a candidate string.
 * @returns {string|null} the collapsed text, or null when there is none.
 */
function collapseText(value) {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text === '' ? null : text
}

/**
 * A display string clamped to `max` characters. Over-long titles are truncated
 * rather than rejected: losing the tail beats losing the group.
 *
 * @param {unknown} value - a candidate string.
 * @param {number} max - the maximum length.
 * @returns {string|null} the clamped text, or null when there is none.
 */
function clampText(value, max) {
  const text = collapseText(value)
  if (text === null) return null
  return text.length <= max ? text : text.slice(0, max)
}

/**
 * @param {unknown} value - a candidate colour.
 * @returns {string|null} `#rrggbb` lowercased, or null.
 */
function toColor(value) {
  if (typeof value !== 'string' || !COLOR_RE.test(value)) return null
  return value.toLowerCase()
}

/**
 * @param {unknown} value - a candidate icon name.
 * @returns {string|null} an icon name at most `SIDEBAR_LIMITS.icon` characters, or null.
 */
function toIcon(value) {
  const text = collapseText(value)
  if (text === null || text.length > SIDEBAR_LIMITS.icon) return null
  return text
}

/**
 * A group's member-order mode. Anything that is not one of the two literals is
 * `manual`, which is the mode that never reorders a group on its own, so a bad
 * value cannot silently reshuffle what the user arranged.
 *
 * @param {unknown} value - a candidate sort mode.
 * @returns {'manual'|'recent'} the sort mode.
 */
function toSort(value) {
  return typeof value === 'string' && SORTS.has(value) ? value : 'manual'
}

/**
 * A finite integer clamped into +/-`SIDEBAR_LIMITS.order`.
 *
 * @param {unknown} value - a candidate order.
 * @param {number} fallback - what to use when `value` is not a finite number.
 * @returns {number} the order.
 */
function toOrder(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(-SIDEBAR_LIMITS.order, Math.min(SIDEBAR_LIMITS.order, Math.trunc(value)))
}

/**
 * The clock a mutator stamps the document with.
 *
 * @param {{now?: Function}} [options] - the injected options.
 * @returns {Function} a function returning the current time in ms.
 */
function clockOf(options) {
  return typeof options?.now === 'function' ? options.now : Date.now
}

/**
 * A normalised document stamped with the injected clock — what every mutator
 * returns. Normalising after the edit is what lets a mutator trust its own
 * argument: a bad title or an out-of-range order is fixed here, once.
 *
 * @param {unknown} layout - the document to finish.
 * @param {{now?: Function}} [options] - the injected options.
 * @returns {SidebarLayout} the finished document.
 */
function finish(layout, options) {
  const now = clockOf(options)
  return { ...normalizeSidebarLayout(layout), updatedAt: now() }
}

/**
 * One group, or null when it cannot be represented at all.
 *
 * A group with a usable id but an unusable title keeps its id as the title, so
 * a single bad rename does not lose the group or orphan every member in it.
 * A group whose id is missing, malformed, unsafe or already used is dropped.
 *
 * @param {unknown} value - the raw group.
 * @param {number} index - its position, used as the default order.
 * @param {Set<string>} usedIds - ids already taken by earlier groups.
 * @returns {SidebarGroup|null} the normalised group.
 */
function normalizeGroup(value, index, usedIds) {
  if (!isRecord(value)) return null
  const rawId = ownField(value, 'id')
  if (typeof rawId !== 'string' || !ID_RE.test(rawId) || UNSAFE_KEYS.has(rawId)) return null
  if (usedIds.has(rawId)) return null
  usedIds.add(rawId)
  return {
    id: rawId,
    title: clampText(ownField(value, 'title'), SIDEBAR_LIMITS.title) ?? rawId,
    color: toColor(ownField(value, 'color')),
    icon: toIcon(ownField(value, 'icon')),
    order: toOrder(ownField(value, 'order'), index),
    collapsed: ownField(value, 'collapsed') === true,
    sort: toSort(ownField(value, 'sort')),
  }
}

/**
 * One workspace's member record. A reference to a group that is not in the
 * document becomes `group: null`, which is the ungrouped bucket — the record is
 * kept, because the colour, alias and hidden flag are still the user's.
 *
 * @param {unknown} value - the raw member record.
 * @param {number} index - its position, used as the default order.
 * @param {Set<string>} groupIds - the ids that survived normalization.
 * @returns {SidebarMember} the normalised record.
 */
function normalizeMember(value, index, groupIds) {
  const source = isRecord(value) ? value : {}
  const rawGroup = ownField(source, 'group')
  return {
    group: typeof rawGroup === 'string' && groupIds.has(rawGroup) ? rawGroup : null,
    order: toOrder(ownField(source, 'order'), index),
    color: toColor(ownField(source, 'color')),
    hidden: ownField(source, 'hidden') === true,
    alias: clampText(ownField(source, 'alias'), SIDEBAR_LIMITS.alias),
    pinned: ownField(source, 'pinned') === true,
  }
}

/**
 * Which workspace rows the user has opened, as a plain id -> boolean map.
 *
 * A key follows the member rules (no unsafe names, no blank key); a value that
 * is not a boolean is dropped rather than coerced, because `"false"` is the one
 * reading that would silently open every row the user had closed. The map is
 * capped like the member table, and a document that omits it is not an error —
 * it simply has no opinion yet.
 *
 * @param {unknown} value - the raw `view.expanded` field.
 * @returns {Record<string, boolean>} the normalised map.
 */
function normalizeExpanded(value) {
  /** @type {Record<string, boolean>} */
  const expanded = {}
  let count = 0
  for (const [key, raw] of dataEntries(value)) {
    if (count >= SIDEBAR_LIMITS.expanded) break
    if (UNSAFE_KEYS.has(key) || key.trim() === '') continue
    if (typeof raw !== 'boolean') continue
    expanded[key] = raw
    count += 1
  }
  return expanded
}

/**
 * Turn anything at all into a valid version-1 document. Never throws, never
 * mutates its argument and is idempotent.
 *
 * @param {unknown} value - a document, a corrupt file, or hostile input.
 * @returns {SidebarLayout} the normalised document.
 */
export function normalizeSidebarLayout(value) {
  try {
    const source = isRecord(value) ? value : {}

    const rawMode = ownField(source, 'mode')
    const mode = MODES.has(rawMode) ? rawMode : SIDEBAR_DEFAULTS.mode

    const groups = []
    const usedIds = new Set()
    const rawGroups = ownField(source, 'groups')
    if (Array.isArray(rawGroups)) {
      for (const raw of rawGroups) {
        if (groups.length >= SIDEBAR_LIMITS.groups) break
        const group = normalizeGroup(raw, groups.length, usedIds)
        if (group !== null) groups.push(group)
      }
    }

    const members = {}
    let memberIndex = 0
    for (const [key, raw] of dataEntries(ownField(source, 'members'))) {
      if (memberIndex >= SIDEBAR_LIMITS.members) break
      if (UNSAFE_KEYS.has(key) || key.trim() === '') continue
      members[key] = normalizeMember(raw, memberIndex, usedIds)
      memberIndex += 1
    }

    const rawView = isRecord(ownField(source, 'view')) ? ownField(source, 'view') : {}
    const view = {
      showEmpty: ownField(rawView, 'showEmpty') === true,
      density: DENSITIES.has(ownField(rawView, 'density'))
        ? ownField(rawView, 'density')
        : SIDEBAR_DEFAULTS.view.density,
      ungroupedTitle:
        clampText(ownField(rawView, 'ungroupedTitle'), SIDEBAR_LIMITS.ungroupedTitle) ??
        SIDEBAR_DEFAULTS.view.ungroupedTitle,
      expanded: normalizeExpanded(ownField(rawView, 'expanded')),
    }

    const rawUpdatedAt = ownField(source, 'updatedAt')
    const updatedAt =
      typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) && rawUpdatedAt >= 0
        ? Math.floor(rawUpdatedAt)
        : 0

    return { version: SIDEBAR_VERSION, mode, groups, members, view, updatedAt }
  } catch {
    // A getter, a proxy or a cyclic structure got past the field guards. The
    // default document is the only safe answer, and it is always a valid one.
    return defaultSidebarLayout()
  }
}

/**
 * Apply a whole-document patch over the current document.
 *
 * Sections are replaced, not merged into: a client that sends a `groups` array
 * without a group has deleted that group, and it must not survive. A section the
 * patch omits is left as it was, because the client's editors rebuild only the
 * sections they touched; an explicit `null` or empty section wipes it. A patch
 * that is not a record leaves the document alone apart from the new timestamp.
 *
 * @param {unknown} current - the document as stored.
 * @param {unknown} patch - the sections the client sent back.
 * @param {{now?: Function}} [options] - the injected clock.
 * @returns {SidebarLayout} the next document.
 */
export function mergeSidebarLayout(current, patch, options = {}) {
  const base = normalizeSidebarLayout(current)
  if (!isRecord(patch)) return finish(base, options)
  const pick = (key, fallback) => (ownField(patch, key) === undefined ? fallback : ownField(patch, key))
  return finish(
    {
      version: SIDEBAR_VERSION,
      mode: pick('mode', base.mode),
      groups: pick('groups', base.groups),
      members: pick('members', base.members),
      view: pick('view', base.view),
      updatedAt: pick('updatedAt', base.updatedAt),
    },
    options,
  )
}

/**
 * The index of a group in a normalised document.
 *
 * @param {SidebarLayout} layout - the document.
 * @param {unknown} groupId - the group to find.
 * @returns {number} the index, or -1.
 */
function groupIndex(layout, groupId) {
  if (typeof groupId !== 'string') return -1
  return layout.groups.findIndex((group) => group.id === groupId)
}

/**
 * A fresh members map with every record passed through `change`, in order.
 *
 * @param {Record<string, SidebarMember>} members - the current map.
 * @param {(member: SidebarMember) => SidebarMember} change - the transform.
 * @returns {Record<string, SidebarMember>} the next map.
 */
function remapMembers(members, change) {
  const out = {}
  for (const [key, record] of dataEntries(members)) out[key] = change(record)
  return out
}

/**
 * A group id derived from a title, unique among `used`. The client generates its
 * own time-based ids, so this is only the fallback for a caller that did not.
 *
 * @param {string} title - the group title.
 * @param {Set<string>} used - ids already taken.
 * @returns {string} a valid, unused id.
 */
function allocateGroupId(title, used) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SIDEBAR_LIMITS.id - 2)
  const base = slug === '' ? 'g' : `g-${slug}`
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    const tail = `-${suffix}`
    candidate = base.slice(0, SIDEBAR_LIMITS.id - tail.length) + tail
    suffix += 1
  }
  return candidate
}

/**
 * Append a group.
 *
 * The group is appended last, exactly as the client's own `withNewGroup` does it
 * (`order` = the number of groups), so both halves of the plugin agree on where a
 * new group lands. Refusal — no usable title, or the document already holds
 * `SIDEBAR_LIMITS.groups` — comes back as `group: null` with the document
 * unchanged apart from its timestamp.
 *
 * @param {unknown} layout - the current document.
 * @param {{id?: string, title?: string, color?: string|null, icon?: string|null}} [group] - the new group.
 * @param {{now?: Function}} [options] - the injected clock.
 * @returns {{layout: SidebarLayout, group: SidebarGroup|null}} the next document and the group that was added.
 */
export function addSidebarGroup(layout, group = {}, options = {}) {
  const next = normalizeSidebarLayout(layout)
  const source = isRecord(group) ? group : {}
  const title = clampText(ownField(source, 'title'), SIDEBAR_LIMITS.title)
  if (title === null || next.groups.length >= SIDEBAR_LIMITS.groups) {
    return { layout: finish(next, options), group: null }
  }
  const used = new Set(next.groups.map((item) => item.id))
  const requested = ownField(source, 'id')
  const id =
    typeof requested === 'string' && ID_RE.test(requested) && !UNSAFE_KEYS.has(requested) && !used.has(requested)
      ? requested
      : allocateGroupId(title, used)
  next.groups = [
    ...next.groups,
    {
      id,
      title,
      color: toColor(ownField(source, 'color')),
      icon: toIcon(ownField(source, 'icon')),
      order: next.groups.length,
      collapsed: false,
      sort: 'manual',
    },
  ]
  const result = finish(next, options)
  return { layout: result, group: result.groups.find((item) => item.id === id) ?? null }
}

/**
 * Rename a group. An empty or unusable title leaves the group as it was, because
 * silently blanking a heading is worse than ignoring an empty input box.
 *
 * @param {unknown} layout - the current document.
 * @param {string} groupId - the group to rename.
 * @param {unknown} title - the new title.
 * @param {{now?: Function}} [options] - the injected clock.
 * @returns {SidebarLayout} the next document.
 */
export function renameSidebarGroup(layout, groupId, title, options = {}) {
  const next = normalizeSidebarLayout(layout)
  const index = groupIndex(next, groupId)
  const text = clampText(title, SIDEBAR_LIMITS.title)
  if (index !== -1 && text !== null) next.groups[index] = { ...next.groups[index], title: text }
  return finish(next, options)
}

/**
 * Set (or clear) a group's colour. `null` or anything that is not `#rrggbb`
 * clears the tag.
 *
 * @param {unknown} layout - the current document.
 * @param {string} groupId - the group to tag.
 * @param {unknown} color - `#rrggbb`, or null to clear.
 * @param {{now?: Function}} [options] - the injected clock.
 * @returns {SidebarLayout} the next document.
 */
export function setSidebarGroupColor(layout, groupId, color, options = {}) {
  const next = normalizeSidebarLayout(layout)
  const index = groupIndex(next, groupId)
  if (index !== -1) next.groups[index] = { ...next.groups[index], color: toColor(color) }
  return finish(next, options)
}

/**
 * Set a group's position. Groups sort by `order`, then by insertion order, so a
 * small number moves a group up. A non-numeric order leaves the group alone.
 *
 * @param {unknown} layout - the current document.
 * @param {string} groupId - the group to move.
 * @param {unknown} order - the new order.
 * @param {{now?: Function}} [options] - the injected clock.
 * @returns {SidebarLayout} the next document.
 */
export function setSidebarGroupOrder(layout, groupId, order, options = {}) {
  const next = normalizeSidebarLayout(layout)
  const index = groupIndex(next, groupId)
  if (index !== -1) next.groups[index] = { ...next.groups[index], order: toOrder(order, next.groups[index].order) }
  return finish(next, options)
}

/**
 * Set a group's member-order mode. Anything that is not `'manual'` or
 * `'recent'` falls back to `'manual'`, the mode that leaves the stored order
 * alone, so a bad client value can never reshuffle a section. An unknown group
 * leaves the document alone.
 *
 * @param {unknown} layout - the current document.
 * @param {string} groupId - the group to retune.
 * @param {unknown} sort - `'manual'` or `'recent'`.
 * @param {{now?: Function}} [options] - the injected clock.
 * @returns {SidebarLayout} the next document.
 */
export function setSidebarGroupSort(layout, groupId, sort, options = {}) {
  const next = normalizeSidebarLayout(layout)
  const index = groupIndex(next, groupId)
  if (index !== -1) next.groups[index] = { ...next.groups[index], sort: toSort(sort) }
  return finish(next, options)
}

/**
 * Drop a group. Its members are NOT dropped: their `group` becomes null, so they
 * fall back to the ungrouped bucket with their colour, alias and hidden flag
 * intact.
 *
 * @param {unknown} layout - the current document.
 * @param {string} groupId - the group to drop.
 * @param {{now?: Function}} [options] - the injected clock.
 * @returns {SidebarLayout} the next document.
 */
export function removeSidebarGroup(layout, groupId, options = {}) {
  const next = normalizeSidebarLayout(layout)
  if (groupIndex(next, groupId) === -1) return finish(next, options)
  next.groups = next.groups.filter((group) => group.id !== groupId)
  next.members = remapMembers(next.members, (member) =>
    member.group === groupId ? { ...member, group: null } : member,
  )
  return finish(next, options)
}

/**
 * Put a workspace in a group and set its display overrides. The workspace does
 * not have to exist: the record is kept (a project that comes back finds its
 * group again) and the sidebar simply never renders it.
 *
 * `group` may be null to move a workspace to the ungrouped bucket. The other
 * fields are optional and are PRESERVED when omitted, so
 * `assignWorkspace(layout, id, { group: 'g-work' })` is a safe re-group that
 * keeps the existing colour, alias, hidden and pinned flags. An ungrouped record
 * is still a record: use `unassignWorkspace()` to remove it entirely.
 *
 * @param {unknown} layout - the current document.
 * @param {string} workspaceId - the stable workspace id.
 * @param {{group?: string|null, order?: number, color?: string|null, hidden?: boolean, alias?: string|null, pinned?: boolean}} [assignment] - the fields to set.
 * @param {{now?: Function}} [options] - the injected clock.
 * @returns {SidebarLayout} the next document.
 */
export function assignWorkspace(layout, workspaceId, assignment = {}, options = {}) {
  const next = normalizeSidebarLayout(layout)
  if (typeof workspaceId !== 'string' || workspaceId.trim() === '' || UNSAFE_KEYS.has(workspaceId)) {
    return finish(next, options)
  }
  const source = isRecord(assignment) ? assignment : {}
  const current = Object.hasOwn(next.members, workspaceId) ? next.members[workspaceId] : null
  const rawGroup = ownField(source, 'group')
  const keep = (key, fallback) => (ownField(source, key) === undefined ? fallback : ownField(source, key))
  const record = {
    group: typeof rawGroup === 'string' && next.groups.some((group) => group.id === rawGroup) ? rawGroup : null,
    order: toOrder(ownField(source, 'order'), current === null ? Object.keys(next.members).length : current.order),
    color: toColor(keep('color', current === null ? null : current.color)),
    hidden: keep('hidden', current === null ? false : current.hidden) === true,
    alias: clampText(keep('alias', current === null ? null : current.alias), SIDEBAR_LIMITS.alias),
    pinned: keep('pinned', current === null ? false : current.pinned) === true,
  }
  next.members = { ...next.members, [workspaceId]: record }
  return finish(next, options)
}

/**
 * Forget a workspace's member record entirely, so it goes back to the plain
 * ungrouped bucket with no colour, alias or hidden flag. To keep those overrides
 * while ungrouping, call `assignWorkspace(layout, id, { group: null })` instead.
 *
 * @param {unknown} layout - the current document.
 * @param {string} workspaceId - the workspace to forget.
 * @param {{now?: Function}} [options] - the injected clock.
 * @returns {SidebarLayout} the next document.
 */
export function unassignWorkspace(layout, workspaceId, options = {}) {
  const next = normalizeSidebarLayout(layout)
  if (typeof workspaceId === 'string' && Object.hasOwn(next.members, workspaceId)) {
    const members = {}
    for (const [key, record] of dataEntries(next.members)) if (key !== workspaceId) members[key] = record
    next.members = members
  }
  return finish(next, options)
}

/**
 * Order two resolved members: by `order` first, then by the name the sidebar
 * actually draws. A codepoint comparison (not `localeCompare`) keeps the result
 * identical on every machine.
 *
 * @param {{order: number, displayName: string}} left - one member.
 * @param {{order: number, displayName: string}} right - the other.
 * @returns {number} -1, 0 or 1.
 */
function compareMembers(left, right) {
  if (left.order !== right.order) return left.order - right.order
  if (left.displayName === right.displayName) return 0
  return left.displayName < right.displayName ? -1 : 1
}

/**
 * Fold a document and a list of live workspaces into the sections the sidebar
 * draws. Pure and read-only — it never stamps `updatedAt`.
 *
 * `sections` holds the real groups, sorted by `order` then insertion order.
 * `ungrouped` is returned separately and is drawn LAST: it is a synthetic bucket,
 * it is never persisted and its title comes from `view.ungroupedTitle`. A
 * workspace with no member record, or whose group was deleted, lands there.
 * A member whose workspace is not in `workspaces` is simply not rendered, so a
 * deleted project disappears from the sidebar without losing its record.
 *
 * A resolved member carries the normalised member fields plus its display data;
 * `color` is the member's own override only. The effective colour follows the
 * client's rule: `member.color || section.color`.
 *
 * @param {unknown} layout - the document.
 * @param {SidebarWorkspaceInput[]} workspaces - the live workspaces.
 * @returns {{sections: Array<object>, ungrouped: object}} the sections, in draw order.
 */
export function resolveSidebarSections(layout, workspaces) {
  const doc = normalizeSidebarLayout(layout)
  const members = []
  if (Array.isArray(workspaces)) {
    const seen = new Set()
    workspaces.forEach((workspace, index) => {
      if (!isRecord(workspace)) return
      const workspaceId = ownField(workspace, 'workspaceId')
      if (typeof workspaceId !== 'string' || workspaceId.trim() === '') return
      if (seen.has(workspaceId)) return
      seen.add(workspaceId)
      const record = Object.hasOwn(doc.members, workspaceId) ? doc.members[workspaceId] : null
      const title = collapseText(ownField(workspace, 'title')) ?? workspaceId
      const alias = record === null ? null : record.alias
      const path = ownField(workspace, 'path')
      const updatedAt = ownField(workspace, 'updatedAt')
      members.push({
        workspaceId,
        title,
        displayName: alias ?? title,
        alias,
        group: record === null ? null : record.group,
        order: record === null ? index : record.order,
        color: record === null ? null : record.color,
        hidden: record === null ? false : record.hidden,
        path: typeof path === 'string' && path !== '' ? path : null,
        updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : null,
      })
    })
  }

  const ordered = doc.groups
    .map((group, index) => ({ group, index }))
    .sort((left, right) => left.group.order - right.group.order || left.index - right.index)

  const sections = ordered.map(({ group }) => {
    const rows = members.filter((member) => member.group === group.id).sort(compareMembers)
    return {
      id: group.id,
      title: group.title,
      color: group.color,
      icon: group.icon,
      order: group.order,
      collapsed: group.collapsed,
      memberCount: rows.length,
      members: rows,
    }
  })

  const loose = members.filter((member) => member.group === null).sort(compareMembers)
  return {
    sections,
    ungrouped: {
      id: null,
      title: doc.view.ungroupedTitle,
      color: null,
      icon: null,
      order: null,
      collapsed: false,
      memberCount: loose.length,
      members: loose,
    },
  }
}

/**
 * The on-disk half: one JSON document, one writer.
 *
 * Every dependency is injectable so the store can be tested without a real
 * filesystem — `readFile`, `writeFile`, `rename`, `mkdir` and `now` — and the
 * real ones are the `node:fs` promises. `root` is the plugin's storage directory
 * (`<DSH_HOME>/storages/dsh-homepage` in production); it falls back to
 * the working directory so a caller that forgets it still gets a usable store
 * instead of a crash.
 *
 * @param {{root?: string, readFile?: Function, writeFile?: Function, rename?: Function, mkdir?: Function, now?: Function}} [options] - the injected dependencies.
 * @returns {{path: string, read: Function, write: Function}} the store.
 */
export function createSidebarStore(options = {}) {
  const rawRoot = typeof options.root === 'string' && options.root.trim() !== '' ? options.root : process.cwd()
  const root = resolve(rawRoot)
  const path = join(root, FILE_NAME)
  const tempPath = `${path}.tmp`
  const readFileFn = options.readFile ?? fsp.readFile
  const writeFileFn = options.writeFile ?? fsp.writeFile
  const renameFn = options.rename ?? fsp.rename
  const mkdirFn = options.mkdir ?? fsp.mkdir
  const clock = clockOf(options)

  /**
   * Read the document. A missing file, an unreadable file and a file full of
   * nonsense all read as the default document — never an exception, because the
   * sidebar must draw something.
   *
   * @returns {Promise<{layout: SidebarLayout, at: number}>} the document and the instant it was written (0 when it never was).
   */
  async function read() {
    let text
    try {
      text = await readFileFn(path, 'utf8')
    } catch {
      return { layout: defaultSidebarLayout(), at: 0 }
    }
    let parsed
    try {
      parsed = JSON.parse(typeof text === 'string' ? text : String(text))
    } catch {
      return { layout: defaultSidebarLayout(), at: 0 }
    }
    const layout = normalizeSidebarLayout(parsed)
    return { layout, at: layout.updatedAt }
  }

  /**
   * Persist a whole-document patch. The document on disk is re-read first, so
   * two writers replace sections over the freshest copy rather than over a stale
   * one in memory.
   *
   * @param {unknown} patch - the sections the client sent back.
   * @returns {Promise<{layout: SidebarLayout, at: number}>} the document that was written.
   */
  async function write(patch) {
    const at = clock()
    const current = await read()
    const layout = mergeSidebarLayout(current.layout, patch, { now: () => at })
    const text = `${JSON.stringify(layout, null, 2)}\n`
    await mkdirFn(root, { recursive: true })
    await writeFileFn(tempPath, text, 'utf8')
    try {
      await renameFn(tempPath, path)
    } catch {
      // A filesystem that refuses the rename (a lock, an odd mount) still gets
      // the document: the direct write is the fallback, exactly as `writeJson`
      // in lib/index.js does it. The temporary sibling stays behind and the next
      // write overwrites it.
      await writeFileFn(path, text, 'utf8')
    }
    return { layout, at }
  }

  return { path, read, write }
}
