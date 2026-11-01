/**
 * The tool-usage card — what the model called, how much text crossed the wire,
 * and how often a call came back an error, cumulative over every stored session.
 *
 * The preview answers the three questions a glance can absorb: how many calls,
 * which tool leads, and roughly how many tokens the arguments and outputs are.
 * The expanded page repeats those as exact stats, then breaks them down as one
 * row per tool with a call bar, and lets the reader switch to a project to see
 * which tools that workspace prefers.
 *
 * Two things are deliberate. Tokens are always prefixed with an estimate mark,
 * because the host counts characters and divides; and the readings are
 * cumulative, never "today", which the page footer says in words. Everything
 * except the accent is a `--dsw-alias-*` token, and the card never assumes the
 * host answered: a missing, partial, or unavailable document all draw.
 */

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
