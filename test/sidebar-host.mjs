/**
 * test/sidebar-host.mjs — acceptance test for `lib/host/sidebar.js`.
 *
 * Proves the four things the sidebar's storage half must never get wrong:
 *
 *  - garbage never becomes an exception. Every hostile document — a string, an
 *    array, a cycle, an accessor, an inherited field, `__proto__` — normalises to
 *    a valid version-1 document, and normalising twice changes nothing;
 *  - a section is replaced, not merged into. A group the client deleted cannot
 *    survive `mergeSidebarLayout()`, while a section the patch omitted is kept;
 *  - every mutator returns a normalised document stamped with the injected clock
 *    and never touches the document it was handed;
 *  - the two region options the client sends — a member's `pinned` boolean and a
 *    group's `manual`/`recent` sort mode — survive normalization, the whole-
 *    document patch, every mutation helper and the store round-trip;
 *  - the store reads a missing or corrupt file as the default document, writes
 *    through a temporary sibling plus a rename, and survives a rename refusal.
 *
 * The filesystem is injected for most of it; one deliberate block at the end
 * runs against a real temp directory so the rename ordering is proven on a real
 * filesystem and not only against the fake.
 *
 * Run: node test/sidebar-host.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  SIDEBAR_DEFAULTS,
  SIDEBAR_LIMITS,
  SIDEBAR_VERSION,
  addSidebarGroup,
  assignWorkspace,
  createSidebarStore,
  defaultSidebarLayout,
  mergeSidebarLayout,
  normalizeSidebarLayout,
  removeSidebarGroup,
  renameSidebarGroup,
  resolveSidebarSections,
  setSidebarGroupColor,
  setSidebarGroupOrder,
  setSidebarGroupSort,
  unassignWorkspace,
} from '../lib/host/sidebar.js'

const NOW = 1700000000000

// ------------------------------------------------------------- exports

{
  const expected = {
    SIDEBAR_VERSION: 'number',
    SIDEBAR_DEFAULTS: 'object',
    SIDEBAR_LIMITS: 'object',
    defaultSidebarLayout: 'function',
    normalizeSidebarLayout: 'function',
    mergeSidebarLayout: 'function',
    addSidebarGroup: 'function',
    renameSidebarGroup: 'function',
    setSidebarGroupColor: 'function',
    setSidebarGroupOrder: 'function',
    setSidebarGroupSort: 'function',
    removeSidebarGroup: 'function',
    assignWorkspace: 'function',
    unassignWorkspace: 'function',
    resolveSidebarSections: 'function',
    createSidebarStore: 'function',
  }
  const module = await import('../lib/host/sidebar.js')
  for (const [name, kind] of Object.entries(expected)) {
    assert.equal(typeof module[name], kind, `export ${name} must be a ${kind}`)
  }
  assert.equal(SIDEBAR_VERSION, 1)
  assert.deepEqual(Object.keys(SIDEBAR_LIMITS).sort(), [
    'alias',
    'expanded',
    'groups',
    'icon',
    'id',
    'members',
    'order',
    'title',
    'ungroupedTitle',
  ])
  assert.equal(SIDEBAR_LIMITS.groups, 50)
  assert.equal(SIDEBAR_LIMITS.members, 500)
  assert.equal(Object.isFrozen(SIDEBAR_LIMITS), true)
  assert.equal(Object.isFrozen(SIDEBAR_DEFAULTS), true)
  console.log('  exports: every named export exists with the frozen version and limits')
}

// ------------------------------------------------------ default document

{
  const a = defaultSidebarLayout()
  const b = defaultSidebarLayout()
  assert.deepEqual(a, {
    version: 1,
    mode: 'grouped',
    groups: [],
    members: {},
    view: { showEmpty: false, density: 'cozy', ungroupedTitle: 'Ungrouped', expanded: {} },
    updatedAt: 0,
  })
  assert.notEqual(a, b)
  assert.notEqual(a.groups, b.groups)
  assert.notEqual(a.members, b.members)
  assert.notEqual(a.view, b.view)
  a.groups.push({ id: 'g-x' })
  a.view.density = 'compact'
  assert.deepEqual(b.groups, [])
  assert.equal(b.view.density, 'cozy')
  assert.deepEqual(SIDEBAR_DEFAULTS.groups, [])
  assert.equal(SIDEBAR_DEFAULTS.view.density, 'cozy')
  console.log('  defaultSidebarLayout: a fresh, mutable copy that cannot poison the frozen default')
}

// ------------------------------------------- garbage normalises to default

{
  const hostile = [
    undefined,
    null,
    0,
    1,
    -7.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '',
    '   ',
    'nonsense',
    true,
    false,
    [],
    [1, 2, 3],
    () => {},
    Symbol('document'),
    123n,
    new Date(0),
    new Map([['groups', []]]),
    new Set([1]),
    /groups/,
  ]
  for (const value of hostile) {
    const layout = normalizeSidebarLayout(value)
    assert.deepEqual(layout, defaultSidebarLayout(), `garbage ${String(value)} must become the default document`)
    assert.deepEqual(normalizeSidebarLayout(layout), layout)
  }

  // A getter is data the module refuses to run, not data it runs and trusts.
  let invoked = false
  const accessor = { groups: [] }
  Object.defineProperty(accessor, 'members', {
    enumerable: true,
    get() {
      invoked = true
      return { 'w-1': { group: null } }
    },
  })
  const viaAccessor = normalizeSidebarLayout(accessor)
  assert.equal(invoked, false)
  assert.deepEqual(Object.keys(viaAccessor.members), [])

  // An inherited field is the prototype's, not the document's.
  const inherited = Object.create({ groups: [{ id: 'g-ghost', title: 'Ghost' }], mode: 'grouped' })
  inherited.mode = 'grouped'
  const fromPrototype = normalizeSidebarLayout(inherited)
  assert.deepEqual(fromPrototype.groups, [])
  assert.equal(fromPrototype.mode, 'grouped')

  // Everything at once, and a proxy that throws on every trap.
  const throwing = new Proxy(
    {},
    {
      get() {
        throw new Error('boom')
      },
      getOwnPropertyDescriptor() {
        throw new Error('boom')
      },
      ownKeys() {
        throw new Error('boom')
      },
    },
  )
  assert.deepEqual(normalizeSidebarLayout(throwing), defaultSidebarLayout())

  // A cycle is walked but never recursed into.
  const cyclic = { version: 1, mode: 'grouped' }
  cyclic.groups = [cyclic]
  cyclic.members = { 'w-1': cyclic }
  const fromCycle = normalizeSidebarLayout(cyclic)
  assert.equal(fromCycle.mode, 'grouped')
  assert.deepEqual(fromCycle.groups, [])
  assert.equal(fromCycle.members['w-1'].group, null)
  assert.deepEqual(normalizeSidebarLayout(fromCycle), fromCycle)

  assert.deepEqual(normalizeSidebarLayout(), defaultSidebarLayout())
  console.log('  normalize garbage: never throws, always a valid default, cycles and accessors included')
}

// ------------------------------------------------- clamping a messy document

{
  const messy = normalizeSidebarLayout({
    version: 99,
    mode: 'GROUPED',
    groups: [
      { id: 'g1', title: '   Real    Group   ', color: '#AABBCC', icon: 'layers', order: 3.9, collapsed: 'yes' },
      { id: 'g2', title: 'x'.repeat(80), color: '#abc', icon: 'y'.repeat(25), order: 9e9 },
      { id: 'g3', title: '   ', color: 'red', icon: 12, order: -9e9, collapsed: true },
    ],
    members: {
      'w-1': { group: 'g1', order: 1.7, color: '#FF0000', hidden: 1, alias: '  One  ' },
      'w-2': { group: 'g2', alias: 'a'.repeat(80) },
      'w-3': { group: 'g-ghost' },
      '  ': { group: 'g1' },
      'w-4': 'not a record',
    },
    view: { showEmpty: 1, density: 'COMPACT', ungroupedTitle: '  my   bucket  ' },
    updatedAt: 1234.9,
  })

  assert.equal(messy.version, 1, 'the version is always the frozen one')
  assert.equal(messy.mode, 'grouped', 'an unknown mode falls back to the default mode')
  assert.equal(messy.groups[0].title, 'Real Group')
  assert.equal(messy.groups[0].color, '#aabbcc', 'colours are lowercased')
  assert.equal(messy.groups[0].icon, 'layers')
  assert.equal(messy.groups[0].order, 3)
  assert.equal(messy.groups[0].collapsed, false, 'collapsed is strictly boolean')
  assert.equal(messy.groups[1].title.length, SIDEBAR_LIMITS.title)
  assert.equal(messy.groups[1].color, null, 'a three-digit colour is not a colour')
  assert.equal(messy.groups[1].icon, null, 'a 25-character icon is not an icon')
  assert.equal(messy.groups[1].order, SIDEBAR_LIMITS.order)
  assert.equal(messy.groups[2].title, 'g3', 'a group with no title keeps its id')
  assert.equal(messy.groups[2].order, -SIDEBAR_LIMITS.order)
  assert.equal(messy.groups[2].collapsed, true)

  assert.deepEqual(Object.keys(messy.members), ['w-1', 'w-2', 'w-3', 'w-4'], 'a blank workspace id is not a key')
  assert.deepEqual(messy.members['w-1'], {
    group: 'g1',
    order: 1,
    color: '#ff0000',
    hidden: false,
    alias: 'One',
    pinned: false,
  })
  assert.equal(messy.members['w-2'].alias.length, SIDEBAR_LIMITS.alias)
  assert.equal(messy.members['w-3'].group, null, 'an unknown group id becomes the ungrouped bucket')
  assert.deepEqual(messy.members['w-4'], {
    group: null,
    order: 3,
    color: null,
    hidden: false,
    alias: null,
    pinned: false,
  })

  assert.deepEqual(messy.view, { showEmpty: false, density: 'cozy', ungroupedTitle: 'my bucket', expanded: {} })
  assert.equal(messy.updatedAt, 1234)

  assert.deepEqual(
    normalizeSidebarLayout({ groups: [{ id: 'g1', title: 'A' }, { id: 'g2', title: 'B' }] }).groups.map(
      (group) => group.order,
    ),
    [0, 1],
    'a missing order falls back to the entry index',
  )
  assert.equal(normalizeSidebarLayout({ updatedAt: -5 }).updatedAt, 0)
  assert.equal(normalizeSidebarLayout({ updatedAt: 'now' }).updatedAt, 0)
  assert.equal(normalizeSidebarLayout({ mode: 'grouped' }).mode, 'grouped')
  assert.equal(normalizeSidebarLayout({ view: { density: 'compact' } }).view.density, 'compact')
  assert.equal(normalizeSidebarLayout({ view: { showEmpty: true } }).view.showEmpty, true)
  console.log('  normalize fields: titles, colours, icons, orders, the view and updatedAt are all clamped')
}

// ------------------------------------------ pin a workspace, sort a group

{
  // The two region options the client sends by exactly these names: a member's
  // `pinned` boolean and a group's `manual`/`recent` sort mode.
  const kept = normalizeSidebarLayout({
    version: 1,
    groups: [{ id: 'g1', title: 'x', sort: 'recent' }],
    members: { a: { pinned: true } },
  })
  assert.equal(kept.groups[0].sort, 'recent')
  assert.equal(kept.members.a.pinned, true)
  assert.deepEqual(kept.groups[0], {
    id: 'g1',
    title: 'x',
    color: null,
    icon: null,
    order: 0,
    collapsed: false,
    sort: 'recent',
  })
  assert.deepEqual(kept.members.a, {
    group: null,
    order: 0,
    color: null,
    hidden: false,
    alias: null,
    pinned: true,
  })
  assert.deepEqual(normalizeSidebarLayout(kept), kept, 'the two new fields are idempotent')
  assert.deepEqual(normalizeSidebarLayout(JSON.parse(JSON.stringify(kept))), kept)

  // Omitted means the defaults: an unpinned row, a manually ordered group.
  const plain = normalizeSidebarLayout({ groups: [{ id: 'g1', title: 'x' }], members: { a: {} } })
  assert.equal(plain.groups[0].sort, 'manual')
  assert.equal(plain.members.a.pinned, false)

  // Corrupt values fall back to the defaults instead of the wrong kind of truth.
  const corrupt = normalizeSidebarLayout({
    groups: [{ id: 'g1', title: 'x', sort: 'bogus' }],
    members: { a: { pinned: 'yes' } },
  })
  assert.equal(corrupt.groups[0].sort, 'manual', 'an unknown sort mode is manual')
  assert.equal(corrupt.members.a.pinned, false, 'only a real boolean true pins a row')
  for (const bad of ['RECENT', 'Recent', 1, 0, null, undefined, true, [], {}, () => {}]) {
    assert.equal(
      normalizeSidebarLayout({ groups: [{ id: 'g1', title: 'x', sort: bad }] }).groups[0].sort,
      'manual',
      `sort ${String(bad)} must be manual`,
    )
  }
  for (const bad of ['yes', 'true', 1, 0, null, undefined, {}, [], () => {}]) {
    assert.equal(
      normalizeSidebarLayout({ members: { a: { pinned: bad } } }).members.a.pinned,
      false,
      `pinned ${String(bad)} must be false`,
    )
  }
  assert.deepEqual(normalizeSidebarLayout(corrupt), corrupt)
  console.log('  normalize pin/sort: pinned is strictly boolean, sort is one of two literals, both idempotent')
}

// -------------------------------------- the expanded map (which rows are open)

{
  // `expanded` remembers which project rows the user opened. An explicit `false`
  // is a real answer — the user closed that row — so it must survive next to
  // `true`: dropping it is exactly what silently reopens a row the user shut.
  const kept = normalizeSidebarLayout({ view: { expanded: { 'w-a': true, 'w-b': false } } })
  assert.deepEqual(kept.view.expanded, { 'w-a': true, 'w-b': false })
  assert.equal(Object.hasOwn(kept.view.expanded, 'w-b'), true, 'a closed row is remembered, not forgotten')
  assert.equal(kept.view.expanded['w-b'], false, 'the stored answer is the boolean false, not a missing key')

  // Only a boolean counts. `"false"` is truthy, so coercing a string would open
  // exactly the rows the user closed — anything else is dropped instead.
  const junk = normalizeSidebarLayout({
    view: {
      expanded: {
        'w-open': true,
        a: 'true',
        b: 'false',
        c: 1,
        d: 0,
        e: null,
        f: undefined,
        g: [],
        h: {},
        i: Number.NaN,
        'w-shut': false,
      },
    },
  })
  assert.deepEqual(junk.view.expanded, { 'w-open': true, 'w-shut': false })

  // No opinion is not an error: an absent or unusable field normalises to {}.
  assert.deepEqual(defaultSidebarLayout().view.expanded, {})
  const one = defaultSidebarLayout()
  const two = defaultSidebarLayout()
  one.view.expanded['w-a'] = true
  assert.deepEqual(two.view.expanded, {}, 'one document cannot poison another through the expanded map')
  assert.equal(Object.isFrozen(SIDEBAR_DEFAULTS.view.expanded), true, 'the frozen default map stays frozen')
  assert.deepEqual(normalizeSidebarLayout({ view: {} }).view.expanded, {})
  assert.deepEqual(normalizeSidebarLayout({ view: { density: 'compact' } }).view.expanded, {})
  for (const bad of ['nonsense', [], null, undefined, 0, true, new Map([['w-a', true]])]) {
    assert.deepEqual(
      normalizeSidebarLayout({ view: { expanded: bad } }).view.expanded,
      {},
      `expanded ${String(bad)} must normalise to no opinion`,
    )
  }

  // The keys that can reach a prototype cannot enter the map, and a blank key is
  // not a workspace id. A crafted JSON `__proto__` is an own data key, so this is
  // the path that would otherwise assign through the setter.
  const nasty = JSON.parse(
    '{"view":{"expanded":{"__proto__":true,"constructor":true,"prototype":true,' +
      '"":true,"   ":true,"w-ok":true}}}',
  )
  const clean = normalizeSidebarLayout(nasty)
  assert.deepEqual(Object.keys(clean.view.expanded), ['w-ok'])
  assert.equal(clean.view.expanded['w-ok'], true)
  assert.equal(Object.hasOwn(clean.view.expanded, '__proto__'), false)
  assert.equal(Object.hasOwn(clean.view.expanded, 'constructor'), false)
  assert.equal(Object.hasOwn(clean.view.expanded, 'prototype'), false)
  assert.equal(Object.getPrototypeOf(clean.view.expanded), Object.prototype)

  // A getter is data the module refuses to run, exactly as for `members`.
  let invoked = false
  const viaAccessor = normalizeSidebarLayout({
    view: {
      get expanded() {
        invoked = true
        return { 'w-a': true }
      },
    },
  })
  assert.equal(invoked, false, 'a getter on expanded is never invoked')
  assert.deepEqual(viaAccessor.view.expanded, {})

  // Idempotent, and the document handed in is never touched: freeze it so a
  // stray write throws instead of passing silently.
  const frozen = Object.freeze({
    groups: Object.freeze([Object.freeze({ id: 'g-a', title: 'A' })]),
    view: Object.freeze({ expanded: Object.freeze({ 'w-a': true, 'w-b': false }) }),
  })
  const once = normalizeSidebarLayout(frozen)
  assert.deepEqual(normalizeSidebarLayout(once), once, 'normalising an expanded document twice changes nothing')
  assert.deepEqual(once.view.expanded, { 'w-a': true, 'w-b': false })
  assert.equal(Object.isFrozen(frozen.view.expanded), true)
  console.log('  view.expanded: a boolean map survives — false included — and junk keys and values are dropped')
}

// -------------------------------------------- the expanded map is capped

{
  const many = {}
  for (let index = 0; index < 600; index += 1) many[`w-${index}`] = index % 2 === 0
  const capped = normalizeSidebarLayout({ view: { expanded: many } })
  assert.equal(Object.keys(capped.view.expanded).length, SIDEBAR_LIMITS.expanded)
  assert.equal(Object.hasOwn(capped.view.expanded, 'w-0'), true)
  assert.equal(capped.view.expanded['w-0'], true)
  assert.equal(Object.hasOwn(capped.view.expanded, `w-${SIDEBAR_LIMITS.expanded - 1}`), true)
  assert.equal(
    Object.hasOwn(capped.view.expanded, `w-${SIDEBAR_LIMITS.expanded}`),
    false,
    'the entries past the limit are dropped, not kept',
  )
  assert.deepEqual(normalizeSidebarLayout(capped), capped)

  // Only an accepted boolean spends the budget, so junk mixed in ahead of a real
  // answer cannot evict it.
  const interleaved = {}
  for (let index = 0; index < 600; index += 1) interleaved[`junk-${index}`] = `not-a-boolean-${index}`
  for (let index = 0; index < 10; index += 1) interleaved[`w-${index}`] = index === 5 ? true : 'no'
  assert.deepEqual(
    normalizeSidebarLayout({ view: { expanded: interleaved } }).view.expanded,
    { 'w-5': true },
    'a rejected entry never spends the cap',
  )
  console.log('  view.expanded cap: the first ' + SIDEBAR_LIMITS.expanded + ' booleans survive in insertion order')
}

// ----------------------------------------------------- idempotent + limits

{
  const doc = normalizeSidebarLayout({
    mode: 'grouped',
    groups: [{ id: 'g-a', title: 'A', order: 2 }, { id: 'g-b', title: 'B' }],
    members: { 'w-1': { group: 'g-a', alias: 'x', order: 4 }, 'w-2': { group: 'g-b' } },
    view: { density: 'compact' },
    updatedAt: 5,
  })
  assert.deepEqual(normalizeSidebarLayout(doc), doc)
  assert.deepEqual(normalizeSidebarLayout(JSON.parse(JSON.stringify(doc))), doc)

  const duplicated = normalizeSidebarLayout({
    groups: [
      { id: 'dup', title: 'First', color: '#111111' },
      { id: 'dup', title: 'Second', color: '#222222' },
      { id: 'other', title: 'Other' },
    ],
    members: { 'w-1': { group: 'dup' } },
  })
  assert.deepEqual(duplicated.groups.map((group) => group.title), ['First', 'Other'])
  assert.equal(duplicated.groups[0].color, '#111111', 'the first group with an id wins')
  assert.equal(duplicated.members['w-1'].group, 'dup', 'the member still resolves to the surviving group')
  assert.deepEqual(normalizeSidebarLayout(duplicated), duplicated)

  const manyGroups = Array.from({ length: 60 }, (unused, index) => ({ id: `g-${index}`, title: `G${index}` }))
  const cappedGroups = normalizeSidebarLayout({ groups: manyGroups })
  assert.equal(cappedGroups.groups.length, SIDEBAR_LIMITS.groups)
  assert.equal(cappedGroups.groups[0].id, 'g-0')
  assert.equal(cappedGroups.groups[SIDEBAR_LIMITS.groups - 1].id, `g-${SIDEBAR_LIMITS.groups - 1}`)

  const manyMembers = {}
  for (let index = 0; index < 600; index += 1) manyMembers[`w-${index}`] = { group: null }
  const cappedMembers = normalizeSidebarLayout({ members: manyMembers })
  assert.equal(Object.keys(cappedMembers.members).length, SIDEBAR_LIMITS.members)
  assert.equal(Object.hasOwn(cappedMembers.members, 'w-0'), true)
  assert.equal(Object.hasOwn(cappedMembers.members, `w-${SIDEBAR_LIMITS.members}`), false)

  // A duplicated document is still a document, not an exception.
  const weird = { groups: { 0: { id: 'g-a' } }, members: ['w-1'], view: 'compact', updatedAt: [] }
  assert.deepEqual(normalizeSidebarLayout(weird), {
    version: 1,
    mode: 'grouped',
    groups: [],
    members: {},
    view: { showEmpty: false, density: 'cozy', ungroupedTitle: 'Ungrouped', expanded: {} },
    updatedAt: 0,
  })
  console.log('  normalize limits: idempotent, first duplicate id wins, groups and members are capped')
}

// -------------------------------------------------- prototype pollution

{
  const nasty = JSON.parse(
    '{"version":1,"mode":"grouped","groups":[{"id":"g1","title":"G"}],' +
      '"members":{"__proto__":{"polluted":true},"constructor":{"polluted":true},' +
      '"prototype":{"polluted":true},"w-1":{"group":"g1"}}}',
  )
  const clean = normalizeSidebarLayout(nasty)
  assert.deepEqual(Object.keys(clean.members), ['w-1'])
  assert.equal(Object.hasOwn(clean.members, '__proto__'), false)
  assert.equal(Object.hasOwn(clean.members, 'constructor'), false)
  assert.equal(Object.hasOwn(clean.members, 'prototype'), false)
  assert.equal(Object.getPrototypeOf(clean.members), Object.prototype)
  assert.equal({}.polluted, undefined)
  assert.equal(Object.prototype.polluted, undefined)
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)

  // The same three names cannot become group ids either.
  const badGroups = normalizeSidebarLayout({
    groups: [{ id: '__proto__', title: 'A' }, { id: 'constructor', title: 'B' }, { id: 'g-ok', title: 'C' }],
  })
  assert.deepEqual(badGroups.groups.map((group) => group.id), ['g-ok'])

  // A real own `__proto__` DATA property (not the setter) is still ignored.
  const hostile = { members: {} }
  Object.defineProperty(hostile.members, '__proto__', {
    value: { polluted: true },
    enumerable: true,
    writable: true,
    configurable: true,
  })
  assert.equal(Object.keys(hostile.members).includes('__proto__'), true)
  const cleaned = normalizeSidebarLayout(hostile)
  assert.equal(Object.getPrototypeOf(cleaned.members), Object.prototype)
  assert.deepEqual(Object.keys(cleaned.members), [])
  assert.equal({}.polluted, undefined)

  // An attacker's member map cannot reach the module's own outputs either.
  const assigned = assignWorkspace(defaultSidebarLayout(), '__proto__', { group: null })
  assert.equal(Object.hasOwn(assigned.members, '__proto__'), false)
  assert.equal(Object.getPrototypeOf(assigned.members), Object.prototype)
  console.log('  prototype safety: __proto__, constructor and prototype can never pollute anything')
}

// ------------------------------------------------ merge replaces a section

{
  const stored = normalizeSidebarLayout({
    mode: 'grouped',
    groups: [
      { id: 'g-a', title: 'A', order: 0 },
      { id: 'g-b', title: 'B', order: 1 },
    ],
    members: { 'w-1': { group: 'g-a', alias: 'One' }, 'w-2': { group: 'g-b' } },
    view: { density: 'compact' },
  })

  // The client sends back a `groups` array without g-b: it deleted that group,
  // so it must not survive anywhere in the file.
  const deleted = mergeSidebarLayout(stored, { groups: [{ id: 'g-a', title: 'A', order: 0 }] }, { now: () => 500 })
  assert.deepEqual(deleted.groups.map((group) => group.id), ['g-a'])
  assert.equal(JSON.stringify(deleted).includes('g-b'), false, 'a deleted group cannot survive the merge')
  assert.equal(deleted.members['w-1'].group, 'g-a')
  assert.equal(deleted.members['w-1'].alias, 'One')
  assert.equal(deleted.members['w-2'].group, null, 'a member of the deleted group falls back to ungrouped')
  assert.equal(deleted.mode, 'grouped', 'a section the patch omitted is kept')
  assert.equal(deleted.view.density, 'compact')
  assert.equal(deleted.updatedAt, 500)
  assert.equal(deleted.version, 1)
  assert.deepEqual(normalizeSidebarLayout(deleted), deleted)

  // An explicit null (or an empty value) wipes a section, and the mode falls
  // back to the default one — the grouped list.
  const wiped = mergeSidebarLayout(stored, { groups: null, members: null, view: null, mode: null })
  assert.deepEqual(wiped.groups, [])
  assert.deepEqual(wiped.members, {})
  assert.equal(wiped.mode, 'grouped')
  assert.deepEqual(wiped.view, SIDEBAR_DEFAULTS.view)

  // A patch that is not a record changes nothing but the timestamp.
  const untouched = mergeSidebarLayout(stored, 'nonsense', { now: () => 7 })
  assert.deepEqual(untouched.groups, stored.groups)
  assert.deepEqual(untouched.members, stored.members)
  assert.equal(untouched.updatedAt, 7)

  // A garbage base merges over the default rather than throwing.
  const fromGarbage = mergeSidebarLayout('not a document', { groups: [{ id: 'g-x', title: 'X' }] })
  assert.deepEqual(fromGarbage.groups.map((group) => group.id), ['g-x'])
  assert.deepEqual(fromGarbage.members, {})

  // The client's editors rebuild only the sections they touched, so a patch that
  // carries `groups` alone must leave `members` and `view` as they were on disk.
  const partial = mergeSidebarLayout(stored, { groups: [{ id: 'g-a', title: 'A' }, { id: 'g-b', title: 'B' }] })
  assert.deepEqual(Object.keys(partial.members), ['w-1', 'w-2'])
  assert.equal(partial.members['w-2'].group, 'g-b')
  assert.equal(partial.view.density, 'compact')
  console.log('  mergeSidebarLayout: sections are replaced whole, omitted ones survive, null wipes')
}

// ------------------------------------- merge replaces the whole `view`

{
  const stored = normalizeSidebarLayout({
    groups: [{ id: 'g-a', title: 'A' }],
    view: { density: 'compact', expanded: { 'w-a': true, 'w-b': false } },
  })

  // `view` is picked as one value and normalised whole, so an incoming view that
  // does not carry `expanded` gives the map up — along with every field it omits.
  // That is the contract the client must respect: send the whole view back.
  const replaced = mergeSidebarLayout(stored, { view: { density: 'cozy' } }, { now: () => 800 })
  assert.deepEqual(replaced.view.expanded, {}, 'a view without expanded gives the map up rather than keeping it')
  assert.equal(replaced.view.density, 'cozy')

  const incoming = mergeSidebarLayout(stored, { view: { expanded: { 'w-c': true } } }, { now: () => 801 })
  assert.deepEqual(incoming.view.expanded, { 'w-c': true }, 'the incoming map is the whole new map')
  assert.equal(incoming.view.density, 'cozy', 'a field the incoming view omits falls back, it is not merged in')

  // An omitted view is the one case that keeps what is stored.
  const omitted = mergeSidebarLayout(stored, { groups: [{ id: 'g-a', title: 'A' }] }, { now: () => 802 })
  assert.deepEqual(omitted.view.expanded, { 'w-a': true, 'w-b': false }, 'an omitted view keeps the open rows')
  assert.equal(omitted.view.density, 'compact')

  // An explicit null wipes the section, so the map goes with it.
  assert.deepEqual(mergeSidebarLayout(stored, { view: null }).view.expanded, {})

  // Every other mutator normalises through the same view, so an edit that is not
  // about the view cannot silently reopen the rows.
  const added = addSidebarGroup(stored, { title: 'Work' }, { now: () => 803 }).layout
  assert.deepEqual(added.view.expanded, { 'w-a': true, 'w-b': false }, 'adding a group keeps the open rows')
  const renamed = renameSidebarGroup(added, 'g-a', 'A2', { now: () => 804 })
  assert.deepEqual(renamed.view.expanded, { 'w-a': true, 'w-b': false }, 'renaming a group keeps the open rows')
  assert.deepEqual(normalizeSidebarLayout(replaced), replaced)
  console.log('  mergeSidebarLayout view: replaced whole, so an incoming view without expanded gives the map up')
}

// ------------------------------------------------------------ the list mode

{
  // The first release has only one document version, so the mode is whatever
  // the document says. An unknown mode falls back to the shipped grouped list;
  // a known one is kept even when the document carries no version at all.
  const stored = JSON.parse('{"version":1,"mode":"native","groups":[{"id":"g1","title":"Plugins"}]}')
  const kept = normalizeSidebarLayout(stored)
  assert.equal(kept.version, 1)
  assert.equal(kept.mode, 'native', 'a stored mode is kept as written')
  assert.equal(kept.groups.length, 1, 'nothing else about the document changes')

  const back = mergeSidebarLayout(kept, { mode: 'grouped' }, { now: () => 9 })
  assert.equal(back.version, 1)
  assert.equal(back.mode, 'grouped', 'the user may switch to the grouped list')

  assert.equal(normalizeSidebarLayout({ version: 1, mode: 'grouped' }).mode, 'grouped')
  assert.equal(normalizeSidebarLayout({ mode: 'native' }).mode, 'native', 'a missing version is not a legacy default')
  assert.equal(normalizeSidebarLayout({ version: 9, mode: 'nope' }).mode, 'grouped', 'an unknown mode falls back to grouped')
  console.log('  list mode: the stored mode is kept, an unknown one falls back to grouped')
}

// ------------------------------------------------------------- add a group

{
  const empty = defaultSidebarLayout()
  const first = addSidebarGroup(empty, { title: 'Work' }, { now: () => 1000 })
  assert.equal(first.group.id, 'g-work')
  assert.equal(first.group.order, 0)
  assert.equal(first.group.collapsed, false)
  assert.equal(first.group.sort, 'manual', 'a freshly created group sorts manually')
  assert.equal(first.layout.groups.length, 1)
  assert.equal(first.layout.updatedAt, 1000)
  assert.deepEqual(first.group, first.layout.groups[0])
  assert.deepEqual(empty.groups, [], 'the input document is never touched')

  const second = addSidebarGroup(
    first.layout,
    { id: 'g-custom', title: 'Custom', color: '#FF00AA', icon: 'star' },
    { now: () => 1001 },
  )
  assert.equal(second.group.id, 'g-custom')
  assert.equal(second.group.color, '#ff00aa')
  assert.equal(second.group.icon, 'star')
  assert.equal(second.group.order, 1, 'a new group is appended last')

  // A duplicate id is a detail: the group is still created with a fresh id.
  const third = addSidebarGroup(second.layout, { id: 'g-custom', title: 'Custom Two' })
  assert.notEqual(third.group.id, 'g-custom')
  assert.match(third.group.id, /^[A-Za-z0-9_-]{1,64}$/)
  assert.equal(third.layout.groups.length, 3)

  // A hostile id cannot become a group id.
  const unsafe = addSidebarGroup(third.layout, { id: '__proto__', title: 'Nasty' })
  assert.notEqual(unsafe.group.id, '__proto__')

  // A group with no usable title is refused rather than created blank.
  const refused = addSidebarGroup(third.layout, { title: '   ' })
  assert.equal(refused.group, null)
  assert.equal(refused.layout.groups.length, 3)
  assert.equal(typeof refused.layout.updatedAt, 'number')
  assert.equal(addSidebarGroup(third.layout, {}).group, null)
  assert.equal(addSidebarGroup(third.layout, null).group, null)

  let capped = defaultSidebarLayout()
  for (let index = 0; index < SIDEBAR_LIMITS.groups; index += 1) {
    capped = addSidebarGroup(capped, { title: `Group ${index}` }).layout
  }
  assert.equal(capped.groups.length, SIDEBAR_LIMITS.groups)
  const overLimit = addSidebarGroup(capped, { title: 'One too many' })
  assert.equal(overLimit.group, null)
  assert.equal(overLimit.layout.groups.length, SIDEBAR_LIMITS.groups)
  console.log('  addSidebarGroup: slugged ids, appended last, refused without a title, capped at the limit')
}

// -------------------------------------------- group rename, colour and order

{
  const start = addSidebarGroup(defaultSidebarLayout(), { title: 'Alpha' }).layout
  const added = addSidebarGroup(start, { title: 'Beta' }).layout

  const renamed = renameSidebarGroup(added, start.groups[0].id, '  Renamed   Group  ')
  assert.equal(renamed.groups[0].title, 'Renamed Group')
  assert.equal(renameSidebarGroup(renamed, start.groups[0].id, '   ').groups[0].title, 'Renamed Group')
  assert.equal(renameSidebarGroup(renamed, start.groups[0].id, 'x'.repeat(80)).groups[0].title.length, 60)
  assert.equal(renameSidebarGroup(renamed, 'g-missing', 'Nope').groups[0].title, 'Renamed Group')
  assert.equal(renameSidebarGroup(renamed, null, 'Nope').groups[0].title, 'Renamed Group')

  const colored = setSidebarGroupColor(renamed, start.groups[0].id, '#ABCDEF')
  assert.equal(colored.groups[0].color, '#abcdef')
  assert.equal(setSidebarGroupColor(colored, start.groups[0].id, 'not-a-colour').groups[0].color, null)
  assert.equal(setSidebarGroupColor(colored, start.groups[0].id, null).groups[0].color, null)

  const ordered = setSidebarGroupOrder(colored, added.groups[1].id, 99999999)
  assert.equal(ordered.groups[1].order, SIDEBAR_LIMITS.order)
  assert.equal(setSidebarGroupOrder(ordered, added.groups[1].id, -99999999).groups[1].order, -SIDEBAR_LIMITS.order)
  assert.equal(
    setSidebarGroupOrder(ordered, added.groups[1].id, 'first').groups[1].order,
    SIDEBAR_LIMITS.order,
    'a non-numeric order leaves the group alone',
  )
  assert.deepEqual(
    setSidebarGroupOrder(ordered, 'g-missing', 1).groups,
    ordered.groups,
    'an unknown group leaves the document alone',
  )
  console.log('  rename/colour/order: clamped, lowercased, and a no-op for a group that is not there')
}

// ------------------------------------------------ remove keeps its members

{
  const stored = normalizeSidebarLayout({
    groups: [
      { id: 'g-a', title: 'A' },
      { id: 'g-b', title: 'B' },
    ],
    members: {
      'w-1': { group: 'g-a', alias: 'One', color: '#123456', hidden: true },
      'w-2': { group: 'g-b' },
    },
  })
  const afterRemove = removeSidebarGroup(stored, 'g-a')
  assert.deepEqual(afterRemove.groups.map((group) => group.id), ['g-b'])
  assert.equal(Object.hasOwn(afterRemove.members, 'w-1'), true, 'a member is not deleted with its group')
  assert.deepEqual(afterRemove.members['w-1'], {
    group: null,
    order: 0,
    color: '#123456',
    hidden: true,
    alias: 'One',
    pinned: false,
  })
  assert.equal(afterRemove.members['w-2'].group, 'g-b')
  assert.deepEqual(removeSidebarGroup(stored, 'g-ghost').groups, stored.groups)
  assert.deepEqual(removeSidebarGroup(stored, 'g-ghost').members, stored.members)
  console.log('  removeSidebarGroup: the group goes, its members fall back to ungrouped with their overrides')
}

// ------------------------------------------------------- assign a workspace

{
  const stored = normalizeSidebarLayout({
    groups: [
      { id: 'g-a', title: 'A' },
      { id: 'g-b', title: 'B' },
    ],
    members: { 'w-1': { group: 'g-a' } },
  })

  const assigned = assignWorkspace(stored, 'w-2', {
    group: 'g-b',
    alias: '  Second  ',
    color: '#FF0000',
    hidden: true,
    order: -5,
  })
  assert.deepEqual(assigned.members['w-2'], {
    group: 'g-b',
    order: -5,
    color: '#ff0000',
    hidden: true,
    alias: 'Second',
    pinned: false,
  })

  // An omitted field is preserved: re-grouping keeps the colour, alias and flag.
  const regrouped = assignWorkspace(assigned, 'w-2', { group: 'g-a' })
  assert.deepEqual(regrouped.members['w-2'], {
    group: 'g-a',
    order: -5,
    color: '#ff0000',
    hidden: true,
    alias: 'Second',
    pinned: false,
  })

  // Explicit nulls clear the overrides; only `group` is required.
  const cleared = assignWorkspace(assigned, 'w-2', { group: null, alias: null, color: null, hidden: false })
  assert.deepEqual(cleared.members['w-2'], {
    group: null,
    order: -5,
    color: null,
    hidden: false,
    alias: null,
    pinned: false,
  })

  // An unknown group, or a missing `group`, means the ungrouped bucket.
  assert.equal(assignWorkspace(stored, 'w-3', { group: 'g-nope' }).members['w-3'].group, null)
  assert.equal(assignWorkspace(stored, 'w-3', {}).members['w-3'].group, null)
  assert.equal(assignWorkspace(stored, 'w-3', null).members['w-3'].group, null)

  // A workspace that is gone from DSH is still recorded, so it can come back.
  const ghost = assignWorkspace(stored, 'w-ghost', { group: 'g-a' })
  assert.equal(ghost.members['w-ghost'].group, 'g-a')
  assert.equal(ghost.members['w-ghost'].alias, null)

  // The default order is the current member count, as the client does it.
  assert.equal(assignWorkspace(stored, 'w-new', { group: 'g-a' }).members['w-new'].order, 1)

  // A blank or unsafe workspace id is refused outright.
  assert.deepEqual(assignWorkspace(stored, '', { group: 'g-a' }).members, stored.members)
  assert.deepEqual(assignWorkspace(stored, '   ', { group: 'g-a' }).members, stored.members)
  assert.deepEqual(assignWorkspace(stored, '__proto__', { group: 'g-a' }).members, stored.members)
  assert.deepEqual(assignWorkspace(stored, 42, { group: 'g-a' }).members, stored.members)

  // unassign forgets the record entirely.
  const forgotten = unassignWorkspace(assigned, 'w-2')
  assert.equal(Object.hasOwn(forgotten.members, 'w-2'), false)
  assert.deepEqual(Object.keys(forgotten.members), ['w-1'])
  assert.deepEqual(unassignWorkspace(stored, 'w-ghost').members, stored.members)
  console.log('  assignWorkspace/unassignWorkspace: partial patches are preserved, a bad id is refused')
}

// ------------------------- pin and sort through the mutation helpers

{
  const stored = normalizeSidebarLayout({
    groups: [
      { id: 'g1', title: 'Work', color: '#123456', icon: 'layers', order: 2, collapsed: true, sort: 'manual' },
    ],
    members: {
      a: { group: 'g1', order: 3, color: '#ABCDEF', hidden: true, alias: '  Alias  ', pinned: false },
    },
  })

  // A group patch that sets `sort` keeps id, title, colour, icon, order and
  // collapsed exactly as they were.
  const recent = setSidebarGroupSort(stored, 'g1', 'recent', { now: () => 314 })
  assert.deepEqual(recent.groups[0], {
    id: 'g1',
    title: 'Work',
    color: '#123456',
    icon: 'layers',
    order: 2,
    collapsed: true,
    sort: 'recent',
  })
  assert.equal(recent.updatedAt, 314)
  assert.deepEqual(normalizeSidebarLayout(recent), recent)
  assert.deepEqual(recent.members, stored.members, 'retuning a group never touches a member')
  assert.equal(
    setSidebarGroupSort(recent, 'g1', 'bogus').groups[0].sort,
    'manual',
    'an unknown sort mode falls back to manual',
  )
  assert.deepEqual(
    setSidebarGroupSort(recent, 'g-missing', 'recent').groups,
    recent.groups,
    'an unknown group leaves the document alone',
  )

  // Every other group mutation keeps the new field.
  assert.equal(renameSidebarGroup(recent, 'g1', 'Renamed').groups[0].sort, 'recent')
  assert.equal(setSidebarGroupColor(recent, 'g1', '#000000').groups[0].sort, 'recent')
  assert.equal(setSidebarGroupOrder(recent, 'g1', 9).groups[0].sort, 'recent')

  // A member patch that sets `pinned` keeps group, order, colour, hidden and
  // alias, and an omitted pin is preserved rather than reset.
  const pinned = assignWorkspace(stored, 'a', { group: 'g1', pinned: true }, { now: () => 315 })
  assert.deepEqual(pinned.members.a, {
    group: 'g1',
    order: 3,
    color: '#abcdef',
    hidden: true,
    alias: 'Alias',
    pinned: true,
  })
  assert.equal(assignWorkspace(stored, 'a', { group: 'g1' }).members.a.pinned, false, 'an omitted pin stays off')
  assert.equal(assignWorkspace(pinned, 'a', { group: 'g1' }).members.a.pinned, true, 'an omitted pin is preserved')
  assert.equal(
    assignWorkspace(stored, 'a', { group: 'g1', pinned: 'yes' }).members.a.pinned,
    false,
    'a hostile pin is false',
  )
  assert.equal(renameSidebarGroup(stored, 'g1', 'Renamed').members.a.pinned, false, 'a group edit never touches a member')

  // The whole-document patch the client actually sends carries both fields.
  const patched = mergeSidebarLayout(
    stored,
    {
      groups: [
        { id: 'g1', title: 'Work', color: '#123456', icon: 'layers', order: 2, collapsed: true, sort: 'recent' },
      ],
      members: { a: { group: 'g1', order: 3, color: '#abcdef', hidden: true, alias: 'Alias', pinned: true } },
    },
    { now: () => 316 },
  )
  assert.deepEqual(patched.groups[0], {
    id: 'g1',
    title: 'Work',
    color: '#123456',
    icon: 'layers',
    order: 2,
    collapsed: true,
    sort: 'recent',
  })
  assert.equal(patched.members.a.pinned, true)
  assert.deepEqual(normalizeSidebarLayout(patched), patched)

  // Dropping a group keeps its members, pin included.
  const dropped = removeSidebarGroup(recent, 'g1')
  assert.equal(dropped.members.a.group, null)
  assert.equal(dropped.members.a.pinned, false)
  console.log('  pin/sort patches: a group keeps its fields when sort moves, a member keeps its fields when pinned')
}

// ------------------------------------- every mutator normalises and stamps

{
  const stored = normalizeSidebarLayout({
    mode: 'grouped',
    groups: [{ id: 'g-a', title: 'A' }],
    members: { 'w-1': { group: 'g-a' } },
  })
  const snapshot = JSON.stringify(stored)

  const results = [
    renameSidebarGroup(stored, 'g-a', 'A2', { now: () => 4242 }),
    setSidebarGroupColor(stored, 'g-a', '#000000', { now: () => 4242 }),
    setSidebarGroupOrder(stored, 'g-a', 3, { now: () => 4242 }),
    setSidebarGroupSort(stored, 'g-a', 'recent', { now: () => 4242 }),
    removeSidebarGroup(stored, 'g-a', { now: () => 4242 }),
    assignWorkspace(stored, 'w-1', { group: null }, { now: () => 4242 }),
    unassignWorkspace(stored, 'w-1', { now: () => 4242 }),
    addSidebarGroup(stored, { title: 'New' }, { now: () => 4242 }).layout,
    mergeSidebarLayout(stored, { mode: 'native' }, { now: () => 4242 }),
  ]
  for (const layout of results) {
    assert.equal(layout.updatedAt, 4242, 'the injected clock stamps the document')
    assert.equal(layout.version, 1)
    assert.deepEqual(normalizeSidebarLayout(layout), layout, 'a mutator returns a normalised document')
    assert.equal(Object.isFrozen(layout), false)
  }
  assert.notEqual(results[0], stored)
  assert.equal(JSON.stringify(stored), snapshot, 'no mutator touches the document it was handed')

  // With no injected clock the stamp is the wall clock, still a valid document.
  const stamped = renameSidebarGroup(stored, 'g-a', 'A3')
  assert.equal(typeof stamped.updatedAt, 'number')
  assert.equal(Number.isFinite(stamped.updatedAt), true)
  assert.deepEqual(normalizeSidebarLayout(stamped), stamped)
  console.log('  mutators: normalised output, injected clock, and the input document is left untouched')
}

// ------------------------------------------------- resolve into sections

{
  const layout = normalizeSidebarLayout({
    mode: 'grouped',
    groups: [
      { id: 'g-work', title: 'Work', color: '#3B82F6', order: 2 },
      { id: 'g-lab', title: 'Lab', color: '#22C55E', order: 0 },
      { id: 'g-archive', title: 'Archive', color: null, order: 1, collapsed: true },
    ],
    members: {
      'w-2': { group: 'g-lab', order: 1, alias: '  Renamed  ' },
      'w-1': { group: 'g-lab', order: 0 },
      'w-3': { group: 'g-work', order: 0 },
      'w-4': { group: 'g-work', order: 1, hidden: true },
      'w-5': { group: 'g-archive', order: 0 },
      'w-6': { group: 'g-deleted', order: 5 },
      'w-ghost': { group: 'g-work' },
    },
    view: { ungroupedTitle: '未分组' },
  })
  const workspaces = [
    { workspaceId: 'w-1', title: 'Alpha', path: 'D:/p/alpha' },
    { workspaceId: 'w-2', title: 'Beta', path: 'D:/p/beta', updatedAt: 99 },
    { workspaceId: 'w-3', title: 'Gamma', path: 'D:/p/gamma' },
    { workspaceId: 'w-4', title: 'Delta', path: 'D:/p/delta' },
    { workspaceId: 'w-5', title: 'Epsilon', path: 'D:/p/epsilon' },
    { workspaceId: 'w-6', title: 'Zeta', path: 'D:/p/zeta' },
    { workspaceId: 'w-7', title: 'Eta', path: 'D:/p/eta' },
  ]
  const frozen = JSON.stringify(layout)
  const resolved = resolveSidebarSections(layout, workspaces)

  assert.deepEqual(
    resolved.sections.map((section) => section.title),
    ['Lab', 'Archive', 'Work'],
    'groups render by order, not by insertion order',
  )
  assert.deepEqual(
    resolved.sections.map((section) => section.memberCount),
    [2, 1, 2],
  )
  assert.equal(resolved.sections[0].color, '#22c55e')
  assert.equal(resolved.sections[1].collapsed, true)
  assert.equal(resolved.sections[2].id, 'g-work')

  const lab = resolved.sections[0]
  assert.deepEqual(lab.members.map((member) => member.workspaceId), ['w-1', 'w-2'])
  assert.equal(lab.members[1].alias, 'Renamed')
  assert.equal(lab.members[1].displayName, 'Renamed', 'an alias is what the sidebar draws')
  assert.equal(lab.members[1].title, 'Beta', 'the real workspace title is never changed')
  assert.equal(lab.members[1].path, 'D:/p/beta')
  assert.equal(lab.members[1].updatedAt, 99)
  assert.equal(lab.members[0].updatedAt, null)

  const work = resolved.sections[2]
  assert.deepEqual(work.members.map((member) => member.workspaceId), ['w-3', 'w-4'])
  assert.equal(work.members[1].hidden, true, 'a hidden member is resolved and flagged, not dropped')
  assert.equal(work.members[1].color, null)

  assert.equal(resolved.ungrouped.title, '未分组')
  assert.equal(resolved.ungrouped.id, null)
  assert.deepEqual(
    resolved.ungrouped.members.map((member) => member.workspaceId),
    ['w-6', 'w-7'],
    'a member of a deleted group and an unassigned workspace share the ungrouped bucket',
  )
  assert.equal(resolved.ungrouped.members[0].group, null)
  assert.equal(resolved.ungrouped.members[0].displayName, 'Zeta')
  assert.equal(resolved.ungrouped.members[1].order, 6, 'an unassigned workspace keeps its input order')

  assert.equal(JSON.stringify(layout), frozen, 'resolveSidebarSections is read-only')

  // Same order, different name: the name breaks the tie, deterministically.
  const tied = resolveSidebarSections(
    {
      groups: [{ id: 'g', title: 'G' }],
      members: { b: { group: 'g', order: 0 }, a: { group: 'g', order: 0 } },
    },
    [
      { workspaceId: 'b', title: 'Beta' },
      { workspaceId: 'a', title: 'Alpha' },
    ],
  )
  assert.deepEqual(tied.sections[0].members.map((member) => member.displayName), ['Alpha', 'Beta'])

  // Junk in, empty sections out — but the section list still exists.
  const fromJunk = resolveSidebarSections('nonsense', ['nope', null, { workspaceId: '' }, 42])
  assert.deepEqual(fromJunk.sections, [])
  assert.equal(fromJunk.ungrouped.memberCount, 0)
  assert.deepEqual(fromJunk.ungrouped.members, [])
  assert.equal(fromJunk.ungrouped.title, 'Ungrouped')

  // A workspace that vanished keeps its member record but is not rendered.
  assert.equal(JSON.stringify(resolved).includes('w-ghost'), false)
  assert.equal(layout.members['w-ghost'].group, 'g-work')

  // A member whose workspace is listed twice is rendered once.
  const twice = resolveSidebarSections(layout, [...workspaces, { workspaceId: 'w-1', title: 'Alpha again' }])
  assert.equal(twice.sections[0].members.filter((member) => member.workspaceId === 'w-1').length, 1)

  console.log(
    '  resolveSidebarSections: sections = ' +
      JSON.stringify(resolved.sections.map((section) => section.title)) +
      ', ungrouped last = ' +
      JSON.stringify(resolved.ungrouped.title) +
      ' (' +
      resolved.ungrouped.memberCount +
      ' rows)',
  )
}

// --------------------------------------------- store against an injected fs

{
  const fs = memFs()
  const store = createSidebarStore({ root: 'C:/virtual/dsh', now: () => NOW, ...fs })
  assert.equal(store.path, join('C:/virtual/dsh', 'sidebar-layout.json'))
  assert.equal(typeof store.read, 'function')
  assert.equal(typeof store.write, 'function')

  const missing = await store.read()
  assert.deepEqual(missing.layout, defaultSidebarLayout())
  assert.equal(missing.at, 0, 'a document that was never written has no write time')

  fs.calls.length = 0
  const written = await store.write({
    mode: 'grouped',
    groups: [{ id: 'g-a', title: 'A' }],
    members: { 'w-1': { group: 'g-a' } },
    view: { density: 'compact' },
  })
  assert.equal(written.at, NOW)
  assert.equal(written.layout.updatedAt, NOW)
  assert.deepEqual(written.layout.groups.map((group) => group.id), ['g-a'])
  assert.deepEqual(
    fs.calls,
    [
      ['readFile', store.path],
      ['mkdir', dirname(store.path)],
      ['writeFile', `${store.path}.tmp`],
      ['rename', `${store.path}.tmp`, store.path],
    ],
    'the document is written to a temporary sibling and renamed onto the target',
  )
  assert.equal(fs.files.size, 1)
  assert.equal(fs.files.has(store.path), true)
  assert.deepEqual(JSON.parse(fs.files.get(store.path)), written.layout)

  // A second write reads what is on disk first, so an omitted section survives.
  const second = await store.write({ groups: [{ id: 'g-b', title: 'B' }] })
  assert.deepEqual(second.layout.groups.map((group) => group.id), ['g-b'])
  assert.equal(second.layout.mode, 'grouped')
  assert.equal(second.layout.view.density, 'compact')
  assert.equal(second.layout.members['w-1'].group, null)

  const roundTrip = await store.read()
  assert.deepEqual(roundTrip.layout, second.layout)
  assert.equal(roundTrip.at, NOW)

  // Corruption reads as the default document instead of rejecting.
  fs.files.set(store.path, '{ not json at all')
  const broken = await store.read()
  assert.deepEqual(broken.layout, defaultSidebarLayout())
  assert.equal(broken.at, 0)

  // A filesystem that refuses the rename still gets the document.
  const stubborn = memFs()
  stubborn.rename = async () => {
    throw new Error('EPERM: operation not permitted')
  }
  const stubbornStore = createSidebarStore({ root: 'C:/virtual/other', now: () => NOW, ...stubborn })
  const forced = await stubbornStore.write({ groups: [{ id: 'g-a', title: 'A' }] })
  assert.deepEqual(forced.layout.groups.map((group) => group.id), ['g-a'])
  assert.equal(stubborn.files.has(stubbornStore.path), true)
  assert.deepEqual(JSON.parse(stubborn.files.get(stubbornStore.path)).groups[0].id, 'g-a')

  // A write of garbage still lands a valid document.
  const junk = await store.write('not a patch')
  assert.deepEqual({ ...junk.layout, updatedAt: 0 }, defaultSidebarLayout())
  assert.equal(junk.layout.updatedAt, NOW)
  console.log('  createSidebarStore (injected fs): missing and corrupt read as default, writes are atomic')
}

// ------------------------------------ pin and sort through a store round-trip

{
  const fs = memFs()
  const store = createSidebarStore({ root: 'C:/virtual/options', now: () => NOW, ...fs })
  const written = await store.write({
    groups: [{ id: 'g1', title: 'Work', sort: 'recent' }],
    members: { a: { group: 'g1', pinned: true } },
  })
  assert.equal(written.at, NOW)
  assert.equal(written.layout.groups[0].sort, 'recent')
  assert.equal(written.layout.members.a.pinned, true)
  assert.deepEqual(JSON.parse(fs.files.get(store.path)), written.layout)

  const roundTrip = await store.read()
  assert.equal(roundTrip.layout.groups[0].sort, 'recent')
  assert.equal(roundTrip.layout.members.a.pinned, true)
  assert.deepEqual(roundTrip.layout, written.layout)
  assert.deepEqual(normalizeSidebarLayout(roundTrip.layout), roundTrip.layout)

  // A later write that names neither section leaves them as they are on disk.
  const again = await store.write({ mode: 'native' })
  assert.equal(again.layout.groups[0].sort, 'recent')
  assert.equal(again.layout.members.a.pinned, true)
  console.log('  store round-trip: pinned and sort survive a write and a re-read')
}

// ------------------------------------ the open rows survive a store round-trip

{
  const fs = memFs()
  const store = createSidebarStore({ root: 'C:/virtual/expanded', now: () => NOW, ...fs })
  const written = await store.write({ view: { expanded: { 'w-a': true, 'w-b': false } } })
  assert.equal(written.layout.view.expanded['w-a'], true)
  assert.equal(written.layout.view.expanded['w-b'], false, 'a closed row survives the write')
  assert.deepEqual(JSON.parse(fs.files.get(store.path)), written.layout)

  const roundTrip = await store.read()
  assert.deepEqual(roundTrip.layout.view.expanded, { 'w-a': true, 'w-b': false })
  assert.equal(roundTrip.layout.view.expanded['w-b'], false, 'the file re-reads the closed row as false, not as absent')
  assert.deepEqual(roundTrip.layout, written.layout)
  assert.deepEqual(normalizeSidebarLayout(roundTrip.layout), roundTrip.layout)

  // A later patch that names another section leaves the open rows on disk alone.
  const again = await store.write({ mode: 'native' })
  assert.deepEqual(again.layout.view.expanded, { 'w-a': true, 'w-b': false })
  console.log('  store round-trip: view.expanded survives a write and a re-read, false included')
}

// ------------------------------------------ store round-trip on a real disk

{
  const temp = await mkdtemp(join(tmpdir(), 'dsh-sidebar-'))
  try {
    const store = createSidebarStore({ root: temp, now: () => NOW })
    assert.equal(store.path, join(temp, 'sidebar-layout.json'))

    const missing = await store.read()
    assert.deepEqual(missing.layout, defaultSidebarLayout())
    assert.equal(missing.at, 0)

    const first = await store.write({
      mode: 'grouped',
      groups: [{ id: 'g-work', title: 'Work', color: '#3B82F6' }],
      members: { 'w-1': { group: 'g-work', alias: 'One' } },
      view: { density: 'compact', ungroupedTitle: '未分组' },
    })
    assert.equal(first.at, NOW)
    assert.deepEqual(JSON.parse(await readFile(store.path, 'utf8')), first.layout)
    assert.deepEqual(
      (await readdir(temp)).sort(),
      ['sidebar-layout.json'],
      'the temporary sibling was renamed away, not left behind',
    )

    const removed = await store.write({ groups: [] })
    assert.deepEqual(removed.layout.groups, [])
    assert.equal(removed.layout.mode, 'grouped', 'an omitted section survives on disk')
    assert.equal(removed.layout.members['w-1'].group, null)
    assert.equal(removed.layout.view.ungroupedTitle, '未分组')

    await writeFile(store.path, '}{', 'utf8')
    const corrupt = await store.read()
    assert.deepEqual(corrupt.layout, defaultSidebarLayout())
    assert.equal(corrupt.at, 0)

    // A write over the corrupt file starts from the default document.
    const recovered = await store.write({ groups: [{ id: 'g-x', title: 'X' }] })
    assert.deepEqual(recovered.layout.groups.map((group) => group.id), ['g-x'])
    assert.deepEqual(recovered.layout.members, {})
    assert.deepEqual(JSON.parse(await readFile(store.path, 'utf8')), recovered.layout)

    // The two region options round-trip a real file too.
    const options = await store.write({
      groups: [{ id: 'g-work', title: 'Work', sort: 'recent' }],
      members: { 'w-1': { group: 'g-work', pinned: true } },
    })
    assert.equal(options.layout.groups[0].sort, 'recent')
    assert.equal(options.layout.members['w-1'].pinned, true)
    const optionsBack = await store.read()
    assert.equal(optionsBack.layout.groups[0].sort, 'recent')
    assert.equal(optionsBack.layout.members['w-1'].pinned, true)
    assert.deepEqual(JSON.parse(await readFile(store.path, 'utf8')), optionsBack.layout)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
  console.log('  createSidebarStore (real temp dir): a full round-trip, corrupt recovery, and cleanup')
}

// ------------------------------------- the open rows on a real disk, too

{
  const temp = await mkdtemp(join(tmpdir(), 'dsh-sidebar-expanded-'))
  try {
    const store = createSidebarStore({ root: temp, now: () => NOW })
    const first = await store.write({ view: { expanded: { 'w-a': true, 'w-b': false } } })
    assert.deepEqual(first.layout.view.expanded, { 'w-a': true, 'w-b': false })
    assert.deepEqual(JSON.parse(await readFile(store.path, 'utf8')).view.expanded, { 'w-a': true, 'w-b': false })

    // A second patch that omits `view` keeps what is on disk, false included: a
    // row the user closed must not reopen just because another edit ran.
    const second = await store.write({ groups: [{ id: 'g-a', title: 'A' }] })
    assert.deepEqual(second.layout.view.expanded, { 'w-a': true, 'w-b': false })
    const back = await store.read()
    assert.equal(back.layout.view.expanded['w-b'], false, 'a closed row is still closed after a real re-read')
    assert.deepEqual(back.layout, second.layout)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
  console.log('  createSidebarStore (real temp dir): view.expanded survives a real write and re-read')
}

// -------------------------------------------------------------- helpers

/**
 * An in-memory stand-in for `node:fs` promises that records every call, so a
 * test can prove the ORDER of the atomic write (temp file, then rename) without
 * a temporary-file shim.
 *
 * @returns {{files: Map<string, string>, calls: Array<Array<string>>, readFile: Function, writeFile: Function, rename: Function, mkdir: Function}} the fake filesystem.
 */
function memFs() {
  const files = new Map()
  const calls = []
  return {
    files,
    calls,
    async readFile(path) {
      calls.push(['readFile', path])
      if (!files.has(path)) {
        const error = new Error(`ENOENT: no such file or directory, open '${path}'`)
        error.code = 'ENOENT'
        throw error
      }
      return files.get(path)
    },
    async writeFile(path, text) {
      calls.push(['writeFile', path])
      files.set(path, text)
    },
    async rename(from, to) {
      calls.push(['rename', from, to])
      if (!files.has(from)) {
        const error = new Error(`ENOENT: no such file or directory, rename '${from}'`)
        error.code = 'ENOENT'
        throw error
      }
      files.set(to, files.get(from))
      files.delete(from)
    },
    async mkdir(path) {
      calls.push(['mkdir', path])
    },
  }
}

console.log('sidebar-host: all assertions passed')
