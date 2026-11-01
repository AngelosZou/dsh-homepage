/**
 * ui-primitives-stub: a browser-free stand-in for the real client UI library
 * `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The client bundle is about to render DSH's own primitives (Menu, Modal,
 * icons, ...). The real package is not installed in this repository and the
 * harness must not gain a dependency, so this module builds the same surface
 * out of plain React elements. It is deliberately small: it renders the shape
 * the smoke harness asserts on (roles, data-* attributes, text, callbacks) and
 * does not reproduce the library's DOM measurement, portals, focus trapping,
 * positioning or styling.
 *
 * Exported as a FACTORY, not a module that imports `react`: the harness's React
 * is a local shim inside test/smoke-client.mjs, so there is no installed 'react'
 * specifier to import. test/smoke-client.mjs calls createUiPrimitives(React)
 * once, at the point where its shim exists, and hands the result to the bundle
 * when it requires '@deepseek-ai/dsh-client-ui-primitives'.
 */

/**
 * Every icon the harness is allowed to hand out. A name outside this list throws
 * when it is read off the module, so a bundle that asks for an icon the stub
 * does not have fails by name instead of rendering `undefined`.
 */
export const UI_ICON_NAMES = Object.freeze([
  'IconChevronDownOutlineRegular',
  'IconChevronRightOutlineRegular',
  'IconTriangleRightFillRegular',
  'IconFolderCloseRegular',
  'IconFolderOpenRegular',
  'IconSearchOutlineRegular',
  'IconRefreshOutlineRegular',
  'IconProjectAddOutlineRegular',
  'IconFolderAddOutlineRegular',
  'IconNewChatOutlineRegular',
  'IconEditOutlineRegular',
  'IconTrashOutlineRegular',
  'IconEllipsisOutlineRegular',
  'IconMoreOutlineRegular',
  'IconPinOutlineRegular',
  'IconPinFillRegular',
  'IconArchiveOutlineRegular',
  'IconUnarchiveOutlineRegular',
  'IconCopyOutlineRegular',
  'IconPlusOutlineRegular',
  'IconCloseFillRegular',
  'IconCloseOutlineRegular',
  'IconCheckOutlineRegular',
  'IconFlatListOutlineRegular',
  'IconWorkspaceTreeOutlineRegular',
  'IconPanelLeftOutlineRegular',
  'IconCompactOutlineRegular',
  'IconFullscreenOutlineRegular',
  'IconBranchOutlineRegular',
  'IconWarningOutlineRegular',
])

/** `className` strings joined the way the harness's `hasClass` reads them. */
function classes(...names) {
  const kept = names.filter((name) => typeof name === 'string' && name.length > 0)
  return kept.length ? kept.join(' ') : undefined
}

/** The real MenuItem.shortcut is `{keys, aria}`; a bare string is accepted too. */
function shortcutText(shortcut) {
  if (shortcut === undefined || shortcut === null) return undefined
  if (typeof shortcut === 'string') return shortcut
  if (Array.isArray(shortcut)) return shortcut.join(' ')
  if (Array.isArray(shortcut.keys)) return shortcut.keys.join(' ')
  if (typeof shortcut.keys === 'string') return shortcut.keys
  return String(shortcut)
}

/** A disabled control keeps its handler off entirely, browsers do it natively. */
function guarded(disabled, handler) {
  return disabled ? undefined : handler
}

function createIcon(React, name) {
  function Icon(props) {
    const { size, className, style, title } = props || {}
    return React.createElement('svg', {
      'data-icon': name,
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      className,
      style,
      'aria-hidden': title ? undefined : 'true',
      role: title ? 'img' : undefined,
      focusable: 'false',
    })
  }
  Icon.displayName = name
  return Icon
}

/**
 * Build the primitives module from the harness's React object.
 * @param {object} React a React-compatible object with createElement/Fragment/useState
 */
export function createUiPrimitives(React) {
  if (!React || typeof React.createElement !== 'function') {
    throw new TypeError('createUiPrimitives(React) needs the harness React object (createElement missing)')
  }
  const h = React.createElement
  const Fragment = React.Fragment
  const useState = React.useState

  // ------------------------------------------------------------------ surface

  function MenuSurface(props) {
    const { children, ...rest } = props
    return h('div', rest, children)
  }

  function MenuGroup(props) {
    const { children, label, ...rest } = props
    return h('div', Object.assign({ 'aria-label': typeof label === 'string' ? label : undefined }, rest), children)
  }

  // ---------------------------------------------------------------- menu rows

  function MenuItemButton(props) {
    const { children, shortcut, icon, disabled, danger, separatorBefore, onSelect, className } = props
    const button = h('button', {
      type: 'button',
      role: 'menuitem',
      className,
      'data-shortcut': shortcutText(shortcut),
      'data-danger': danger ? 'true' : undefined,
      disabled: disabled ? true : undefined,
      onClick: guarded(disabled, (event) => {
        if (typeof onSelect === 'function') onSelect(event)
      }),
    }, icon === undefined || icon === null ? null : icon, children)
    if (!separatorBefore) return button
    return [h('div', { role: 'separator' }), button]
  }

  // ------------------------------------------------------------------- menu

  function Menu(props) {
    const {
      open, anchor, items, children, selectedId, selectedIds, onSelect,
      footer, className, listClassName,
    } = props
    // A single slot of state is what makes the submenus exclusive: opening one
    // replaces whatever was open before it.
    const [openSubmenu, setOpenSubmenu] = useState(null)
    // The anchor is the trigger the caller handed in, and the real component
    // renders it in place whether or not the list is up — a closed menu that
    // returned nothing would delete the very button that opens it. The closed
    // state therefore keeps the anchor in the wrapper span the real component
    // draws, and the open state adds the list beside it.
    const trigger = anchor === undefined || anchor === null ? null : anchor
    if (!open) return h('span', { className: classes('ui-menu-anchor', className) }, trigger)

    const select = (id) => {
      if (typeof onSelect === 'function') onSelect(id)
    }
    const isSelected = (id) => id !== undefined
      && (id === selectedId || (Array.isArray(selectedIds) && selectedIds.includes(id)))

    // Returns the nodes a single entry contributes; the caller splices them in
    // so that a submenu sits next to its trigger instead of wrapping it.
    const renderEntry = (item) => {
      if (!item || typeof item !== 'object') return []
      if (item.type === 'separator') return [h('div', { role: 'separator', 'data-id': item.id })]
      if (item.type === 'label') return [h('div', { 'data-id': item.id }, item.text)]

      const submenuItems = Array.isArray(item.submenu) ? item.submenu : null
      const submenuOpen = submenuItems !== null && openSubmenu === item.id
      const trigger = h('button', {
        type: 'button',
        role: 'menuitem',
        'data-id': item.id,
        'data-selected': isSelected(item.id) ? 'true' : undefined,
        'data-shortcut': shortcutText(item.shortcut),
        'data-danger': item.danger ? 'true' : undefined,
        disabled: item.disabled ? true : undefined,
        'aria-haspopup': submenuItems ? 'menu' : undefined,
        'aria-expanded': submenuItems ? submenuOpen : undefined,
        onClick: guarded(item.disabled, () => select(item.id)),
        onMouseEnter: submenuItems ? () => setOpenSubmenu(item.id) : undefined,
        onFocus: submenuItems ? () => setOpenSubmenu(item.id) : undefined,
      }, item.icon === undefined || item.icon === null ? null : item.icon, item.label)

      if (!submenuOpen) return [trigger]
      const submenu = h('div', { role: 'menu', className: 'ui-submenu' },
        submenuItems.flatMap((entry) => renderEntry(entry)))
      return [trigger, submenu]
    }

    const nodes = []
    if (trigger !== null) nodes.push(trigger)
    for (const item of Array.isArray(items) ? items : []) nodes.push(...renderEntry(item))
    // Slot-rendered entries arrive as children and belong in the same list.
    if (children !== undefined && children !== null) nodes.push(children)
    if (footer !== undefined && footer !== null) nodes.push(footer)

    return h('div', { role: 'menu', className: classes('ui-menu', className, listClassName) }, ...nodes)
  }

  // ------------------------------------------------------------------ modal

  function Modal(props) {
    const { open, title, description, children, footer, className } = props
    if (!open) return null
    return h('div', { role: 'dialog', 'aria-modal': 'true', className },
      title === undefined || title === null ? null : h('div', null, title),
      description === undefined || description === null ? null : h('div', null, description),
      children,
      footer === undefined || footer === null ? null : footer)
  }

  // ------------------------------------------------------------- form controls

  function Button(props) {
    // The shell's `Button` spreads everything else onto the <button>, so the
    // region's data-sb markers and aria-pressed reach the element exactly as
    // they do in the real page; the stub must not swallow them.
    const { children, onClick, disabled, title, type, className, icon, variant, size, ...rest } = props
    return h('button', {
      ...rest,
      type: type || 'button',
      className,
      disabled: disabled ? true : undefined,
      title,
      onClick: guarded(disabled, onClick),
    }, icon === undefined || icon === null ? null : icon, children)
  }

  function Input(props) {
    const { value, onChange, onKeyDown, placeholder, autoFocus, disabled, maxLength, type, className, id, name } = props
    return h('input', {
      type: type || 'text',
      value,
      placeholder,
      autoFocus: autoFocus ? true : undefined,
      disabled: disabled ? true : undefined,
      maxLength,
      className,
      id,
      name,
      onChange,
      onKeyDown,
    })
  }

  function Checkbox(props) {
    const { checked, onChange, label, disabled, className } = props
    return h('input', {
      type: 'checkbox',
      checked: checked === true,
      disabled: disabled ? true : undefined,
      className,
      'aria-label': typeof label === 'string' ? label : undefined,
      onChange: guarded(disabled, () => {
        if (typeof onChange === 'function') onChange({ target: { checked: !checked } })
      }),
    })
  }

  function Switch(props) {
    const { checked, onChange, label, disabled, title, className } = props
    return h('button', {
      type: 'button',
      role: 'switch',
      className,
      title,
      'aria-checked': checked === true,
      disabled: disabled ? true : undefined,
      onClick: guarded(disabled, () => {
        if (typeof onChange === 'function') onChange(!checked)
      }),
    }, label)
  }

  // The real InlineEditor is a multi-line field (pass `multiline`); the harness
  // default is the single-line `input` the task asked for.
  function InlineEditor(props) {
    const {
      value, label, placeholder, disabled, autoFocus, multiline,
      confirmLabel, cancelLabel, onSave, onSubmit, onCancel, onChange, className,
    } = props
    const submit = typeof onSubmit === 'function' ? onSubmit : onSave
    const field = h(multiline ? 'textarea' : 'input', {
      type: multiline ? undefined : 'text',
      value: value === undefined || value === null ? '' : value,
      placeholder,
      'aria-label': typeof label === 'string' ? label : undefined,
      autoFocus: autoFocus ? true : undefined,
      disabled: disabled ? true : undefined,
      onChange: (event) => {
        if (typeof onChange === 'function') onChange(event && event.target ? event.target.value : event)
      },
      onKeyDown: (event) => {
        if (!event) return
        const stop = () => { if (typeof event.preventDefault === 'function') event.preventDefault() }
        if (event.key === 'Enter' && !event.shiftKey && typeof submit === 'function') {
          stop()
          const typed = event.target && event.target.value !== undefined ? event.target.value : value
          submit(typed)
        } else if (event.key === 'Escape' && typeof onCancel === 'function') {
          stop()
          onCancel()
        }
      },
    })
    const confirm = h('button', {
      type: 'button',
      disabled: disabled ? true : undefined,
      onClick: guarded(disabled, () => {
        if (typeof submit === 'function') submit(value)
      }),
    }, confirmLabel || 'Save')
    const cancel = h('button', {
      type: 'button',
      disabled: disabled ? true : undefined,
      onClick: guarded(disabled, onCancel),
    }, cancelLabel || 'Cancel')
    return h('div', { className }, field, confirm, cancel)
  }

  // --------------------------------------------------------------- selection

  function SegmentedControl(props) {
    const { id, value, activeId, options, onChange, label, disabled, className } = props
    const current = value !== undefined ? value : activeId
    return h('div', {
      role: 'tablist',
      className,
      'data-id': id,
      'aria-label': typeof label === 'string' ? label : undefined,
    }, (Array.isArray(options) ? options : []).map((option) => h('button', {
      type: 'button',
      role: 'tab',
      'data-value': option.value,
      'aria-selected': option.value === current,
      title: option.title,
      disabled: disabled || option.disabled ? true : undefined,
      onClick: guarded(disabled || option.disabled, () => {
        if (typeof onChange === 'function') onChange(option.value)
      }),
    }, option.label === undefined ? option.value : option.label)))
  }

  // ------------------------------------------------------------------- atoms

  function Tooltip(props) {
    const { children } = props
    if (children === undefined || children === null) return null
    return Array.isArray(children) ? h(Fragment, null, ...children) : children
  }

  function HoverCard(props) {
    const { children } = props
    if (children === undefined || children === null) return null
    return Array.isArray(children) ? h(Fragment, null, ...children) : children
  }

  function StateDot(props) {
    const { state, className } = props
    const shared = { className, 'data-state': state }
    // The real StateDot animates 'ongoing' as an svg and paints every other
    // state as a span; both carry data-state, which is what tests read.
    if (state === 'ongoing') return h('svg', Object.assign({ viewBox: '0 0 8 8' }, shared))
    return h('span', shared)
  }

  function Pill(props) {
    const { children, className, tone, onClick, disabled, title } = props
    if (typeof onClick === 'function') {
      return h('button', {
        type: 'button',
        className,
        title,
        'data-tone': tone,
        disabled: disabled ? true : undefined,
        onClick: guarded(disabled, onClick),
      }, children)
    }
    return h('span', { className, 'data-tone': tone }, children)
  }

  function Tag(props) {
    const { children, className, tone } = props
    return h('span', { className, 'data-tone': tone }, children)
  }

  function Badge(props) {
    const { children, className, tone } = props
    return h('span', { className, 'data-tone': tone }, children)
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Deterministic short age: 'now' (< 1m), then 3m / 2h / 1d / 2w / 5mo / 1y.
   * `now` may be a Date or an epoch number; it defaults to Date.now(), so pass
   * it explicitly when a test must not depend on the wall clock.
   */
  function relativeTime(at, now) {
    const then = at instanceof Date ? at.getTime() : Number(at)
    const reference = now === undefined ? Date.now() : (now instanceof Date ? now.getTime() : Number(now))
    if (!Number.isFinite(then) || !Number.isFinite(reference)) return ''
    const seconds = Math.max(0, Math.round((reference - then) / 1000))
    const units = [
      [31536000, 'y'], [2592000, 'mo'], [604800, 'w'],
      [86400, 'd'], [3600, 'h'], [60, 'm'],
    ]
    for (const [size, unit] of units) {
      if (seconds >= size) return String(Math.floor(seconds / size)) + unit
    }
    return 'now'
  }

  let clipboardWrites = 0
  let clipboardText = ''
  /**
   * Resolves true without touching the DOM; `writeClipboard.calls` counts calls
   * and `writeClipboard.last` is the text of the last one.
   */
  async function writeClipboard(text) {
    clipboardWrites += 1
    clipboardText = String(text)
    return true
  }
  Object.defineProperty(writeClipboard, 'calls', { get: () => clipboardWrites })
  Object.defineProperty(writeClipboard, 'last', { get: () => clipboardText })
  writeClipboard.reset = () => { clipboardWrites = 0; clipboardText = '' }

  // -------------------------------------------------------------------- icons

  const icons = {}
  for (const name of UI_ICON_NAMES) icons[name] = createIcon(React, name)

  const surface = {
    Menu,
    MenuItemButton,
    MenuSurface,
    MenuGroup,
    Modal,
    Button,
    Input,
    InlineEditor,
    Checkbox,
    Switch,
    SegmentedControl,
    // The harness treats tabs as the same control; both names are exported
    // because the bundle may import either.
    SegmentedTabs: SegmentedControl,
    Tooltip,
    HoverCard,
    HoverCardGroup: HoverCard,
    StateDot,
    Pill,
    Tag,
    Badge,
    relativeTime,
    writeClipboard,
    UI_ICON_NAMES,
    ...icons,
  }

  // An unknown icon is a bundle bug: name it instead of rendering nothing.
  return new Proxy(surface, {
    get(target, key, receiver) {
      if (typeof key === 'symbol' || key in target) return Reflect.get(target, key, receiver)
      if (/^Icon/.test(key)) {
        throw new Error('test/ui-primitives-stub.mjs has no icon named "' + key + '" — add it to UI_ICON_NAMES (or check the real icon name)')
      }
      return undefined
    },
  })
}
