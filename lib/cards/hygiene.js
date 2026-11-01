/**
 * The hygiene card — a read-only inventory of the DSH home with one small,
 * deliberate cleanup: `.log` files under `logs` older than seven days.
 *
 * The preview is meant to be readable at 2x1 without any control: the total the
 * home occupies, the slice that is reclaimable, and a warning only when there
 * is something to clean. The expanded page adds the per-category breakdown and
 * a two-step confirm around the single delete action, because a wall card in
 * someone else's window should never delete anything on a single click.
 *
 * Everything except the accent is a `--dsw-alias-*` token; the card only ever
 * writes through the action layer, and it never assumes the host answered.
 */

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
