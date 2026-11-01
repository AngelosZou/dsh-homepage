# Card API

`dsh-homepage` renders a wall of cards in a DSH sidebar panel. Any plugin that loads the
client bundle can register its own cards through `globalThis.__DSH_HOMEPAGE__`
(interface version `1`, client locale namespace `homepage`).

## Registering a card

```js
const mine = globalThis.__DSH_HOMEPAGE__.plugin('my-plugin')
mine.define({
  id: 'my-card',
  title: 'My card',              // string | () => string
  version: '1.2.0',              // optional; appears in manifest()
  size: { w: 2, h: 1 },
  dict: { zh: { 'my-card.label': '模式' }, en: { 'my-card.label': 'Mode' } },
  background: globalThis.__DSH_HOMEPAGE__.backgrounds.mesh('#2b5cff', 0.2),
  texture: true,
  effects: { outline: 'glow' },
  actions: [{ id: 'mode', type: 'segmented', label: 'Mode', options: [
    { value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }],
  content: (api) => React.createElement('div', null, 'mode: ' + api.control('mode')),
  detail: (api) => React.createElement('div', null, 'the expanded content'),
})
```

`define` returns the normalized card. Re-defining an existing id replaces it in place and
keeps the user's saved size, effects and control values. Replacing another plugin's card —
including a built-in one — requires `override: true`, otherwise it throws.

## Plugin handle

`__DSH_HOMEPAGE__.plugin(name)` returns a handle stamped with that owner name:

| Member | Description |
| --- | --- |
| `name` | Owner name the handle was created with. |
| `define(definition)` | Registers a card owned by this plugin. |
| `remove(id)` | Removes one of its cards; throws for another owner's card. |
| `list()` / `get(id)` | This plugin's cards, or one of them. |
| `has(id)` / `ownerOf(id)` / `cardsOf(owner)` | Read-only identification. |
| `manifest()` | Serializable descriptions of this plugin's cards (no render functions). |
| `defineEffect(name, spec)` | Animation preset owned by this plugin. |
| `unregister()` | Removes every card this plugin registered; built-in cards stay. |

## Registry and panel

| Member | Description |
| --- | --- |
| `version` / `namespace` | Interface version (`1`) and client locale namespace (`homepage`). |
| `define` / `remove` / `get` | Unscoped card registration and lookup. |
| `cardApi(id)` | The `api` object of a card, or `null`. |
| `has(id)` / `ownerOf(id)` / `cardsOf(owner)` / `owners()` | Registry identification. |
| `manifest(id?)` | Serializable card descriptions; all cards when `id` is omitted. |
| `subscribeRegistry(listener)` | Change feed for `define` / `replace` / `remove`; returns an unsubscribe function. |
| `unregister(owner)` | Removes every card belonging to `owner`. |
| `backgrounds` | Builders: `mesh(color, strength)`, `gradient(from, to, angle)`, `grid(color, size)`, `css(value)`. |
| `effects` / `icons` / `ui` / `hooks` | Effect presets, icon set, UI primitives, framework hooks. |
| `defineEffect(name, spec)` | Registers a preset: `{label, description, className, css}`. |
| `notify(level, text)` / `clearNotifications()` / `toast(text)` | Panel notifications. |
| `open(id)` / `close()` | Expand or collapse a card. |

## Card definition fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | string | — (required) | Unique card id. |
| `title` / `subtitle` / `detailTitle` | string \| `() => string` | `id` / `null` | Captions; functions are evaluated on render, so they follow the locale. |
| `icon` | `(size) => element` | `null` | Icon for the given pixel size; `icons.*` has the built-in set. |
| `size` | `{w, h}` | `{1, 1}` | Default grid span, clamped to 1..4 columns and rows. |
| `minSize` / `maxSize` | `{w, h}` | `1×1` / `4×4` | Bounds for the size stepper. |
| `accent` | string | `null` | Card accent colour. |
| `background` | string \| builder | `null` | Replaces the default bed with a CSS value or a `backgrounds.*` result. |
| `texture` | `true` \| string \| object | `null` | Watermark layer: the card icon, an icon name, or a texture spec (below). |
| `content` | `(api) => element` | returns `null` | Preview body. |
| `detail` | `(api) => element` | `null` | Expanded page body. |
| `hover` | `{grow, content, disabled}` | `{grow: 1.045}` | Hover growth factor, hover-only content and an opt-out. |
| `actions` | action[] | `[]` | Controls shown in the preview. |
| `detailActions` | action[] | `[]` | Controls shown only in the expanded page. |
| `effects` | `{outline, ripple, sheen, float, spotlight}` | all off | Animation defaults (see Effects). |
| `refreshMs` | number | `0` | Refresh hint for polling bodies; the card still owns its timer. |
| `expandable` / `draggable` / `resizable` | boolean | `true` | Turn that interaction off. |
| `onMount` / `onExpand` / `onCollapse` | `(api) => void` | `null` | Lifecycle callbacks. |
| `tags` / `order` / `version` | string[] / number / string | `[]` / `0` / `null` | Manifest tags, initial position hint (drag order wins) and registrant version. |
| `dict` | `{zh, en}` | `null` | Card-local strings merged into the locale service. |
| `override` | boolean | `false` | Required to replace another plugin's card. |

## The `api` object

`content`, `detail`, lifecycle callbacks and action handlers receive one `api`:

| Member | Description |
| --- | --- |
| `id` / `def` | Card id and the normalized definition. |
| `controls` / `control(id)` / `setControl(id, value)` | Current control values; writing a value fires that action's `onChange`. |
| `notify(level, text)` / `announce(level, text)` / `retract()` | Adds a notice; sets or retracts the single live notice. `level` is `info`, `warn` or `error`. |
| `clearNotifications()` / `toast(text)` | Clears this card's notices; one-shot corner toast. |
| `expand()` / `collapse()` | Opens or closes this card's expanded page. |
| `setSize({w, h})` / `setEffect(name)` / `setBackground(bg)` / `repaint()` / `format(number)` | Persisted appearance changes; repaint asks for a re-render; thousands-separated number formatting. |
| `remote(endpoint, args)` | Calls a Host endpoint (see Remote endpoints). |
| `collect(names?, {force}?)` / `act(action, payload)` | Reads the collector (`{at, entries}`) or runs a Host action (`{ok, action, value}` / `{ok: false, action, error}`); neither rejects. |
| `sessionStatus` / `sessionList` | Live session snapshot and catalog, or `null` when the host has no session store. |
| `openSession(id)` / `openWorkspace(id)` | Navigates the main view; returns whether it started. |
| `hovered` / `dragging` / `expanded` / `editing` / `density` | Interaction state; every change re-renders. |

Framework hooks are on `hooks`: `useStore()`, `useRemote(endpoint, args, {refreshMs, enabled})`
(returns `{data, error, busy, reload, at, failures}`), `useClock(ms)`, `useNoticeOnce(api, key, level, text)`
and `useAnnounce(api, key, notice)`.

## Controls (`actions` / `detailActions`)

| `type` | Renders | Extra fields |
| --- | --- | --- |
| `segmented` | Segmented control | `options` |
| `switch` | Toggle | — |
| `combo` | Main button plus dropdown | `options`, `run(current, api)` |
| `stepper` | Numeric stepper | `min`, `max`, `format` |
| `text` | Single-line input (commits on Enter/blur, Escape restores) | `placeholder`, `mono` |
| omitted / other | Plain button | `run(api)`, `disabled`, `tone` |

Common fields: `id` (required), `label`, `icon`, `tooltip`, `value`, `onChange(value, api)`.
The initial value is `action.value`, else the first option; a `switch` defaults to `false`.
Values persist per card in `home-state.json`.

## Effects

Presets: `none`, `outline`, `glow`, `scan`, `float`, `spotlight`; `effects.outline` selects
one, while `ripple`, `sheen`, `float` and `spotlight` are independent booleans.
`defineEffect(name, {label, description, className, css})` adds a preset; its `css` is
injected once and removed with the panel.

## Backgrounds and texture

`background` accepts a CSS value or a builder: `mesh(color, strength)`,
`gradient(from, to, angle)`, `grid(color, size)`, `css(value)`.

`texture` accepts `true` (the card icon), an icon name, or an object:

| Field | Type | Description |
| --- | --- | --- |
| `icon` / `image` | string | Built-in icon name, or a data/`http(s)` image URL. |
| `opacity` | number 0..100 | Watermark opacity; default 5. |
| `tint` | string | CSS colour; defaults to the card accent. |
| `size` / `bleed` | number \| CSS length | Watermark size and overflow beyond the card edge; a number is px. |
| `anchor` | `left` \| `center` \| `right` | Edge the watermark grows from; default `right`. |
| `fit` | `contain` \| `cover` | Image fit mode. |
| `offset` | `[x, y]` | Position offset. |
| `rotate` | number \| `"Ndeg"` | Rotation in degrees. |
| `fade` / `fadePosition` | boolean / number 0..100 | Dissolves toward the edge opposite `anchor`. |
| `blend` | `normal` \| `multiply` \| `screen` \| `luminosity` \| `soft-light` | Blend mode of the layer. |

## Dictionaries

Client strings go through the locale service: pass `dict: {zh, en}` on the definition (or
call `dict({zh, en})` in the module) and read with `runtime.t(key, params)`. Both
dictionaries must carry the identical key set; do not hard-code user-visible text.

## Remote endpoints

All endpoints live in the `homepage` namespace and take one argument object. Call them
with `api.remote('homepage/<method>', { options })` or
`useRemote('homepage/<method>', { options }, opts)`; the options field is ignored by
endpoints marked —.

| Endpoint | Options | Returns |
| --- | --- | --- |
| `overview` / `refresh` | `{historyDays, force}` / — | Balance, today's spend, history, account state; `refresh` forces a resample first. |
| `environment` / `device` | — | Platform, Node, cwd, proxy/TLS/redirector variables; CPU, memory, GPU/VRAM, temperature, disk, system info, sample history. |
| `dsh` / `dshCheck` | — | Upstream commit and release, read routes and cache state / re-reads upstream past the TTL. |
| `dshLocal` / `dshInstall` | `{root?}` / `{root?, version, ref}` | `{root, versions}` of unpacked cores; launch result of a detached core install. An empty root means the auto-detected install root. |
| `sidebarLayout` / `saveSidebarLayout` | — / `{layout}` | The workspace-group document `{layout, at}`, and its saved form. |
| `state` / `saveState` | — / `{patch}` | Persisted UI state; and the state after applying a patch. |
| `collect` / `act` | `{names?, force?}` / `{action, payload}` | Collector snapshot `{at, entries}`; action result `{ok, action, value}` or `{ok: false, action, error}`. |
| `projects` | `{force?}` | Workspace registry plus per-repo git readings; `available: false` when the registry is missing. |
| `hygiene` | `{force?}` | Category sizes, largest items and reclaimable logs under `<DSH_HOME>`. |
| `toolUsage` | `{force?}` | Per-tool calls, errors, argument/output volume, estimated tokens and time, grouped by project. |
| `pluginAuditStart` | `{target, mode?}` | Starts an audit (`mode`: `install` or `review`) and returns the record. |
| `pluginAuditStatus` / `pluginAuditList` | `{auditId?}` / — | One audit or the newest one (`null` when none); `{audits}`, newest first. |
| `pluginAuditDecide` | `{auditId, decision, override?}` | The updated audit record. |
| `skillList` | `{cwd?}` | Scanned roots, effective catalog, duplicates and `counts`. |
| `skillSetEnabled` | `{name, mode, cwd?}` | Fresh catalog after writing `off` / `model-off` / `on`. |
| `skillContent` | `{name, cwd?}` | Frontmatter table, verbatim body, sibling files, truncation and unreadable reason. |
| `skillSources` | — | External Skill sources and their reachability. |
| `skillSearch` | `{query, source?, limit?}` | Normalized results and `failures[]`. |
| `skillDetail` | `{id}` or `{source, ref}` | Package file list and `SKILL.md` body. |
| `skillInstall` | `{id, source, ref, destination, force?}` | The installed Skill entry and counts. |

## Model-facing tool

The plugin can register one DSH tool, `homepage`, so a session can read what the wall
shows:

```json
{ "section": "overview", "refresh": false }
```

`section` is one of `overview`, `environment`, `device`, `dsh`, `skills`, `projects`,
`hygiene`, `runtime`, `all` (default `all`); `refresh: true` re-reads the account balance
instead of using the sampled value.

**It is off by default.** The tool reads the user's machine and would otherwise sit in
every model's context, so enabling it is an explicit choice: open `dsh-homepage` on the
**Plugins** page and use the configuration section there (or the row's own page, which
carries the same switch), or set `config: { exposeTool: true }` on the entry in
`cordis.patch.yml`. `toolLanguage` picks the language of the rendered text — `auto`
follows the saved UI locale and otherwise answers in English, while `en` and `zh` pin it.
Both options are volatile: a change takes effect without restarting `dsh web`.

The page is a **client** registration: DSH renders a plugin's configuration from a
`plugins.bundle.config` / `plugins.row.config` slot, so a Host `Config` schema alone
produces no UI — this plugin registers both cards itself, keyed
`<package>#<row id>` for the row page and by package name for the bundle page.

## State storage

One directory: `<DSH_HOME>/storages/dsh-homepage/` (`DSH_HOME` defaults to `~/.dsh`).

| File | Contents |
| --- | --- |
| `home-state.json` | Card order, sizes, backgrounds, artwork overrides, effects, control values, UI settings. |
| `balance-ledger.json` | Daily balance samples (180 days). |
| `sidebar-layout.json` | Sidebar groups and workspace membership (`version: 1`). |
| `tool-usage.json` | Incremental per-session tool index. |
| `plugin-audit-history.json` | The plugin reviews the audit card started, with their verdicts. |

Writes go through a sibling `.tmp` file plus `rename`, so an existing file is never left
half-written.
