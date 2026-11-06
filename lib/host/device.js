/**
 * dsh-homepage — Host half, device metrics.
 *
 * Samples what the machine itself can report: CPU load (system-wide and per
 * core), memory pressure, a best-effort package temperature, GPU load and video
 * memory, and the free space of the system drive. The browser half cannot reach
 * any of this, so the host samples it and the device card renders one
 * `DeviceSample` document.
 *
 * Contract:
 *
 *  - `sampleDevice()` never rejects. A source that fails degrades to `null` or
 *    to a `reason` code and every other field still comes back;
 *  - CPU usage needs two readings, so the previous `os.cpus()` snapshot is kept
 *    in module state. The first call of a process waits ~250 ms and reads again
 *    rather than reporting a meaningless 0;
 *  - a sample taken less than a second ago is memoized, and a sample still in
 *    flight is shared by every caller, because several subscribers poll the
 *    same endpoint at once;
 *  - the temperature probe costs a subprocess, so it is cached for
 *    `temperatureTtlMs`. `temperature: false` skips it outright;
 *  - the GPU counters are the expensive read: Windows needs one PowerShell
 *    spawn and Linux needs one `nvidia-smi` spawn when no sysfs card answers,
 *    so the verdict is cached for `gpuTtlMs`, and a failed verdict for
 *    `GPU_FAILURE_TTL_MS`. A Linux machine whose amdgpu publishes
 *    `gpu_busy_percent` reads plain files and spawns nothing at all. `gpu: false`
 *    skips the block outright;
 *  - a stale temperature or GPU cache is served immediately while its probe
 *    refreshes in the background; only the first request (a cold cache) waits.
 *    That is what keeps a fast poll as cheap as a performance panel: CPU,
 *    memory and disk are read in-process, and the subprocess blocks are
 *    refreshed on their own slower cadence;
 *  - the plugin arms no background sampler: every sample is on demand, so an
 *    installed page nobody opened probes nothing. `startDeviceSampler()` exists
 *    for a caller that wants the cheap history path, and it never spawns;
 *  - history is an in-memory ring buffer per process only — it is deliberately
 *    NOT persisted anywhere;
 *  - every source is injectable through `options`, which is what lets the unit
 *    test run without touching real hardware.
 *
 * @module dsh-homepage/host/device
 */
import { promises as fsp } from 'node:fs'
import { statfsSync } from 'node:fs'
import { cpus as osCpus, freemem as osFreemem, hostname as osHostname, loadavg as osLoadavg,
  platform as osPlatform, arch as osArch, release as osRelease, totalmem as osTotalmem,
  uptime as osUptime } from 'node:os'
import { spawn } from 'node:child_process'

/** Kelvin-to-Celsius offset; ACPI reports tenths of kelvin. */
const KELVIN_OFFSET = 273.15
/** A sample younger than this is handed back untouched. */
const MIN_SAMPLE_INTERVAL_MS = 1000
/** Wait between the two readings that make the first CPU number real. */
const FIRST_SAMPLE_DELAY_MS = 250
/** How long one PowerShell probe may run before it is killed. */
const COMMAND_TIMEOUT_MS = 2500
/** Thermal zone readings outside this band are treated as noise, not heat. */
const PLAUSIBLE_CELSIUS_MIN = -50
const PLAUSIBLE_CELSIUS_MAX = 200
/** Platform spellings that count as Windows here. */
const WINDOWS_PLATFORMS = new Set(['win32', 'windows', 'win'])
/** Child-process environment shape errors that mean "not permitted". */
const PERMISSION_CODES = new Set(['EACCES', 'EPERM'])

/** How long one GPU probe's verdict is reused; that probe costs a subprocess. */
const GPU_TTL_MS = 30000

/**
 * How long a failed GPU verdict is reused.
 *
 * A machine whose counters are disabled, unreadable or slow kept paying a
 * PowerShell spawn on every poll. Reusing the failure for a minute turns a
 * per-poll subprocess into one a minute without hiding a recovered machine for
 * long.
 */
const GPU_FAILURE_TTL_MS = 60000

/**
 * How long the GPU probe may run before it is killed.
 *
 * Deliberately larger than `COMMAND_TIMEOUT_MS`: that spawn collects two GPU
 * counter sets, the video controller list and the driver's VRAM registry value
 * in one process, which was measured at 0.7..2.5 s on a real Windows box - close
 * enough to the thermal budget that a cold WMI call intermittently timed out and
 * the card lost its GPU reading entirely.
 */
const GPU_TIMEOUT_MS = 8000

/** The driver counts a 0..100 percentage; the document reports a 0..1 ratio. */
const PERCENT_SCALE = 100

/**
 * Where the NVIDIA driver publishes its version.
 *
 * Reading this one file is the cheap "is there an NVIDIA card here" test that
 * gates the `nvidia-smi` spawn: on a machine without the driver the path is
 * absent, so a pure AMD box never pays for a subprocess.
 */
const NVIDIA_PROC_PATH = '/proc/driver/nvidia/version'

/**
 * The one `nvidia-smi` query the sampler needs.
 *
 * CSV without units parses without a column-width table: the utilization and
 * memory columns are bare numbers (MiB), and a card that cannot answer spells
 * the field `[N/A]` rather than dropping the column.
 */
const NVIDIA_QUERY = 'name,utilization.gpu,memory.used,memory.total'

/** `nvidia-smi` reports MiB; the document counts bytes. */
const MIB = 1024 * 1024

/** An `nvidia-smi` that cannot be found is a common case, not an error. */
const MISSING_TOOL_RE = /ENOENT|not found|no such file/i

/** `system_profiler` spells video memory as `8 GB` or `1536 MB`. */
const PROFILER_SIZE_RE = /^\s*([\d.]+)\s*(GB|MB|KB)\s*$/i

/** A display profiler run answers a static question, so it may take its time. */
const DISPLAY_PROFILER_TIMEOUT_MS = 6000

/**
 * hwmon chips that carry a CPU package temperature, most specific first.
 *
 * `/sys/class/thermal` is the ACPI tree, and on most machines it points at a
 * board or chassis zone rather than the package. The package lives in one of
 * these chips: `coretemp` on Intel, `k10temp` (or the out-of-tree `zenpower`)
 * on AMD, the `*_thermal` pair on ARM SoCs.
 */
const CPU_HWMON_ORDER = ['coretemp', 'k10temp', 'zenpower', 'k8temp', 'cpu_thermal', 'soc_thermal']

/** Adapter names that mean "a virtual or remote display", not a real card. */
const VIRTUAL_ADAPTER_RE =
  /virtual|remote|displaylink|spacedesk|parsec|sunshine|basic display|indirect display/i

/** A real display adapter enumerates on a bus; a software one sits under ROOT/SWD. */
const VIRTUAL_ADAPTER_ID_RE = /^(?:ROOT|SWD)\\/i

/** The two `0x…` groups after `luid_` in a GPU counter instance name. */
const GPU_LUID_RE = /luid_(0x[0-9a-f]+)_(0x[0-9a-f]+)/i

/** The engine type token of a GPU engine instance name. */
const GPU_ENGINE_RE = /engtype_([A-Za-z0-9_]+)/i

/** The default `os` surface; a fake is substituted wholesale by the test. */
const DEFAULT_OS = {
  cpus: osCpus,
  totalmem: osTotalmem,
  freemem: osFreemem,
  loadavg: osLoadavg,
  uptime: osUptime,
  platform: osPlatform,
  arch: osArch,
  release: osRelease,
  hostname: osHostname,
}

/** Default sleeps on the timers/promises implementation, falling back to a timer. */
let defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
try {
  const timers = await import('node:timer/promises')
  if (typeof timers.setTimeout === 'function') defaultSleep = (ms) => timers.setTimeout(ms)
} catch { /* older runtime: the setTimeout fallback above stands */ }

/** Node older than 18.15 has no fs.statfs at all. */
let defaultStatfs = null
try {
  const fs = await import('node:fs')
  if (typeof fs.statfsSync === 'function') defaultStatfs = fs.statfsSync
} catch { /* leaves statfs null, so disk degrades to null */ }

// ------------------------------------------------------------------ state

/** Previous `os.cpus()` snapshot, the second half of every usage delta. */
let prevTimes = null
/** Epoch ms of the previous real sample, the basis of `sampleSeconds`. */
let prevAt = null
/** The memoized last document, handed back inside the dedupe window. */
let lastSample = null
/** Cached temperature verdict plus the epoch ms it was taken at. */
let temperatureCache = null

/** Cached GPU block plus the epoch ms the probe finished at. */
let gpuCache = null
/** The GPU probe currently in flight, shared by concurrent readers. */
let gpuPending = null
/** The temperature probe currently in flight, shared by concurrent readers. */
let temperaturePending = null
/** The sample currently in flight, shared by concurrent readers. */
let samplePending = null
/** Bumped by `resetDeviceCache()`; a stale probe must not refill a reset cache. */
let cacheEpoch = 0
/** Appended per real sample; in memory for this process only. */
let history = []
/** Set once the first call has paid for its second CPU reading. */
let firstReadDone = false

// -------------------------------------------------------------- utilities

/**
 * Coerce a value to a finite number.
 * @param value - anything.
 * @returns the number, or null when it is not finite.
 */
function toFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Round to a fixed number of decimals without exponent notation.
 * @param value - finite number.
 * @param digits - decimal places.
 * @returns the rounded number.
 */
function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * Clamp a number into a closed range.
 * @param value - finite number.
 * @param min - lower bound.
 * @param max - upper bound.
 * @returns the clamped number.
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Convert a byte count into the document's shape.
 * @param total - total bytes.
 * @param free - free bytes.
 * @returns `{ total, free, used, usage }`, or null when the inputs are unusable.
 */
function byteStats(total, free) {
  if (total === null || free === null || total <= 0 || free < 0) return null
  const used = Math.max(0, total - free)
  return { total: total, free: free, used: used, usage: round(clamp(used / total, 0, 1), 4) }
}

/**
 * Read a sysfs file, reporting absence as null instead of throwing.
 * @param readFile - the resolved `readFile`.
 * @param path - absolute path.
 * @returns the trimmed text, or null when the path cannot be read.
 */
async function readText(readFile, path) {
  try {
    const value = await readFile(path, 'utf8')
    if (value === null || value === undefined) return null
    return String(value).trim()
  } catch { return null }
}

/**
 * Read a one-number sysfs file.
 * @param readFile - the resolved `readFile`.
 * @param path - absolute path.
 * @returns the number, or null when the file is missing or not numeric.
 */
async function readNumber(readFile, path) {
  const text = await readText(readFile, path)
  if (text === null || text === '') return null
  return toFinite(Number(text))
}

/**
 * Tell whether a sysfs path exists and carries something — the gate for a paid
 * probe. An empty read is not evidence of a driver: a `/proc` entry that answers
 * with nothing has nothing to gate on.
 * @param readFile - the resolved `readFile`.
 * @param path - absolute path.
 * @returns true only when the file was readable and not empty.
 */
async function hasPath(readFile, path) {
  const text = await readText(readFile, path)
  return text !== null && text !== ''
}

/**
 * Build the document's memory block from a used/total pair.
 *
 * A total of 0 or null means "the driver does not publish it", which must not
 * become a pressure of Infinity or a misleading 0%.
 * @param used - bytes in use, or null.
 * @param total - bytes the adapter owns, or null.
 * @returns `{ used, total, usage }`.
 */
function memoryBlock(used, total) {
  const usable = toFinite(total) !== null && total > 0 ? total : null
  const inUse = toFinite(used) !== null && used >= 0 ? used : null
  return {
    used: inUse,
    total: usable,
    usage:
      inUse !== null && usable !== null
        ? round(clamp(inUse / usable, 0, 1), 4)
        : null,
  }
}

/**
 * Call `os.loadavg()` and keep the result only when the platform fills it.
 * @param os - the injected `os` surface.
 * @returns the one-minute average triple, or null.
 */
function readLoadavg(os) {
  try {
    const value = os.loadavg()
    if (!Array.isArray(value) || value.length < 1) return null
    const average = toFinite(value[0])
    if (average === null || average <= 0) return null
    return value.slice(0, 3).map((entry) => round(toFinite(entry) || 0, 2))
  } catch { return null }
}

/**
 * Read the CPU inventory without ever throwing.
 * @param os - the injected `os` surface.
 * @returns the `os.cpus()` array, or an empty array.
 */
function safeCpus(os) {
  try {
    const value = os.cpus()
    return Array.isArray(value) ? value : []
  } catch { return [] }
}

// -------------------------------------------------------------------- cpu

/**
 * Project `os.cpus()` onto just the tick counters, so the previous reading is
 * a few numbers rather than a deep copy of the whole inventory.
 * @param list - the `os.cpus()` result.
 * @returns one `{ times }` entry per core, or null when there are no cores.
 */
function cpuSnapshot(list) {
  if (!Array.isArray(list) || list.length === 0) return null
  return list.map((entry) => ({
    times: {
      user: (entry && entry.times && toFinite(entry.times.user)) || 0,
      nice: (entry && entry.times && toFinite(entry.times.nice)) || 0,
      sys: (entry && entry.times && toFinite(entry.times.sys)) || 0,
      idle: (entry && entry.times && toFinite(entry.times.idle)) || 0,
      irq: (entry && entry.times && toFinite(entry.times.irq)) || 0,
    },
  }))
}

/** @returns the busy fraction of one `times` object; 0 when the window is empty. */
function coreUsage(before, after) {
  const totalBefore = before.times.user + before.times.nice + before.times.sys + before.times.idle + before.times.irq
  const totalAfter = after.times.user + after.times.nice + after.times.sys + after.times.idle + after.times.irq
  const totalDelta = totalAfter - totalBefore
  if (totalDelta <= 0) return 0
  const idleDelta = after.times.idle - before.times.idle
  return clamp(1 - idleDelta / totalDelta, 0, 1)
}

/**
 * Difference two CPU snapshots into a usage reading.
 * @param prev - the earlier snapshot, or null.
 * @param next - the later snapshot, or null.
 * @returns `{ usage, cores }`; both are 0 when the window cannot be measured.
 */
export function cpuUsage(prev, next) {
  if (!prev || !next) return { usage: 0, cores: [] }
  if (!Array.isArray(prev) || !Array.isArray(next)) return { usage: 0, cores: [] }
  let previous = prev
  let current = next
  let count = Math.min(previous.length, current.length)
  if (count === 0) {
    count = Math.max(previous.length, current.length)
    previous = []
    current = []
  }
  if (count === 0) return { usage: 0, cores: [] }
  const cores = []
  for (let index = 0; index < count; index += 1) {
    const before = previous[index]
    const after = current[index]
    if (!before || !after || !before.times || !after.times) {
      cores.push(0)
      continue
    }
    cores.push(coreUsage(before, after))
  }
  const average = cores.reduce((sum, value) => sum + value, 0) / cores.length
  return { usage: clamp(average, 0, 1), cores: cores }
}

// ----------------------------------------------------------------- memory

/**
 * Read memory pressure through the injected `os`.
 * @param os - the injected `os` surface.
 * @returns the memory block with swap defaulted to 0.
 */
function readMemory(os) {
  let total = null
  let free = null
  try {
    total = toFinite(os.totalmem())
    free = toFinite(os.freemem())
  } catch { /* both stay null and the zeroed block below stands */ }
  const block = byteStats(total, free)
  if (block === null) {
    return { total: 0, free: 0, used: 0, usage: 0, swapTotal: 0, swapFree: 0, swapUsed: 0 }
  }
  const blockWithSwap = { ...block }
  for (const field of ['swapTotal', 'swapFree', 'swapUsed']) {
    blockWithSwap[field] = toFinite(os[field]) || 0
  }
  return blockWithSwap
}

/**
 * Resolve the system drive and its root directory.
 * @param platform - the resolved platform string.
 * @returns the drive label and root path.
 */
function systemDrive(platform) {
  const fromEnv = typeof process.env.SystemDrive === 'string' && process.env.SystemDrive.trim() !== ''
    ? process.env.SystemDrive.trim()
    : 'C:'
  return platform === 'win32' ? { drive: fromEnv, path: fromEnv + '\\' } : { drive: null, path: '/' }
}

/**
 * Read free space with `statfsSync`, which only exists on Node >= 18.15.
 * @param statfs - the injected `statfsSync`, or null.
 * @param root - directory to measure.
 * @returns `{ path, total, free, used, usage }` or null.
 */
function readDisk(statfs, root) {
  if (typeof statfs !== 'function') return null
  try {
    const info = statfs(root)
    if (!info) return null
    const bsize = toFinite(info.bsize)
    const blocks = toFinite(info.blocks)
    const bfree = toFinite(info.bfree)
    if (bsize === null || blocks === null || bfree === null || bsize <= 0) return null
    const block = byteStats(blocks * bsize, bfree * bsize)
    if (block === null) return null
    return { path: root, total: block.total, free: block.free, used: block.used, usage: block.usage }
  } catch { return null }
}

// ------------------------------------------------------------ temperature

/**
 * Parse an ACPI thermal zone reading, which is tenths of kelvin.
 * @param value - the raw `CurrentTemperature` value.
 * @returns degrees Celsius, or null when the value is not a plausible reading.
 */
export function parseThermalKelvinTenths(value) {
  let raw = null
  if (typeof value === 'number') raw = value
  else if (typeof value === 'string' && value.trim() !== '') raw = Number(value.trim())
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return null
  const celsius = round(raw / 10 - KELVIN_OFFSET, 2)
  if (celsius < PLAUSIBLE_CELSIUS_MIN || celsius > PLAUSIBLE_CELSIUS_MAX) return null
  return celsius
}

/**
 * Parse the JSON one hardware-monitor sensor query prints.
 *
 * The row's field names are accepted in Pascal and camel spelling because the
 * serialized shape differs between WMI providers and PowerShell versions.
 * @param text - the command's stdout.
 * @returns `{ celsius, name }` for the best CPU row, or null.
 */
export function parseSensorJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  let rows = null
  try {
    let value = JSON.parse(text)
    if (typeof value === 'string') value = JSON.parse(value)
    rows = Array.isArray(value) ? value : [value]
  } catch { return null }
  const candidates = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const raw = row.Value !== undefined ? row.Value : row.value
    const celsius = toFinite(typeof raw === 'string' ? Number(raw) : raw)
    if (celsius === null || celsius < PLAUSIBLE_CELSIUS_MIN || celsius > PLAUSIBLE_CELSIUS_MAX) continue
    candidates.push({ celsius: round(celsius, 2), name: String(row.Name !== undefined ? row.Name : (row.name || '')) })
  }
  if (candidates.length === 0) return null
  const cpu = candidates.find((entry) => /cpu|package|核心|处理器/i.test(entry.name))
  if (cpu) return cpu
  return candidates.reduce((best, entry) => (entry.celsius > best.celsius ? entry : best), candidates[0])
}

/**
 * Run one probe command and normalize its result, whatever the injection does.
 * @param run - the resolved `runCommand`.
 * @param command - executable path.
 * @param args - argv.
 * @param opts - spawn options.
 * @returns `{ ok, stdout, stderr, reason }`.
 */
async function invoke(run, command, args, opts) {
  try {
    const result = await run(command, args, opts)
    if (!result || typeof result !== 'object') return { ok: false, stdout: '', stderr: '', reason: 'error' }
    return {
      ok: result.ok === true,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      reason: result.reason,
    }
  } catch { return { ok: false, stdout: '', stderr: '', reason: 'error' } }
}

/**
 * Map one failed probe onto the document's reason vocabulary.
 * @param result - the `invoke` result.
 * @returns `'permission'`, `'timeout'` or `'error'`.
 */
function failureReason(result) {
  if (result.reason === 'timeout') return 'timeout'
  if (/access|denied|拒绝/i.test(result.stderr)) return 'permission'
  return 'error'
}

/**
 * Wrap the probe children in the exact shape `sampleDevice` needs.
 * @param spawnFn - the resolved `spawn`.
 * @returns an async `runCommand(command, args, opts)`.
 */
function spawnRunCommand(spawnFn) {
  return (command, args, opts) => new Promise((resolve) => {
    let child = null
    try {
      child = spawnFn(command, args, {
        windowsHide: true,
        timeout: (opts && toFinite(opts.timeout)) || COMMAND_TIMEOUT_MS,
      })
    } catch { resolve({ ok: false, stdout: '', stderr: '', reason: 'error' }); return }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', (chunk) => { stdout += chunk })
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (code) => {
      if (code && PERMISSION_CODES.has(code.code)) finish({ ok: false, stdout: stdout, stderr: String(code.message || ''), reason: 'permission' })
      else finish({ ok: false, stdout: stdout, stderr: String((code && code.message) || code || ''), reason: 'error' })
    })
    child.on('close', (code, signal) => {
      if (signal) { finish({ ok: false, stdout: stdout, stderr: stderr, reason: 'timeout' }); return }
      finish({ ok: code === 0, stdout: stdout, stderr: stderr, reason: code === 0 ? null : 'exit' })
    })
    timer = setTimeout(() => {
      try { child.kill() } catch { /* the process may already be gone */ }
      finish({ ok: false, stdout: stdout, stderr: stderr, reason: 'timeout' })
    }, (opts && toFinite(opts.timeout)) || COMMAND_TIMEOUT_MS)
  })
}

/** @returns the fixed query script for the two hardware-monitor providers. */
function hardwareMonitorScript(root) {
  const query = "SELECT Name,Value FROM Sensor WHERE SensorType='Temperature'"
  return '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
    'Get-CimInstance -Namespace ' + root + " -ClassName Sensor -Filter \"" + query + '" | ' +
    'Select-Object Name,Value | ConvertTo-Json -Compress'
}

/**
 * Query one hardware-monitor root, preferring a CPU row.
 * @param run - the resolved `runCommand`.
 * @param root - the WMI namespace.
 * @returns `{ celsius, source }` or null.
 */
async function readHardwareMonitor(run, root) {
  const args = ['-NoProfile', '-NonInteractive', '-Command', hardwareMonitorScript(root)]
  const result = await invoke(run, 'powershell.exe', args, { timeout: COMMAND_TIMEOUT_MS })
  if (!result.ok) return null
  const parsed = parseSensorJson(result.stdout)
  if (!parsed) return null
  return { celsius: parsed.celsius, source: root.indexOf('LibreHardwareMonitor') >= 0 ? 'lhm' : 'ohm', _name: parsed.name }
}

/**
 * Query the ACPI thermal zone, whose value is tenths of kelvin.
 * @param run - the resolved `runCommand`.
 * @returns `{ celsius, source }` or null.
 */
async function readAcpiThermalZone(run) {
  const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
    'Get-CimInstance -Namespace root/WMI -ClassName MSAcpi_ThermalZoneTemperature | ' +
    'Select-Object -ExpandProperty CurrentTemperature'
  const args = ['-NoProfile', '-NonInteractive', '-Command', script]
  const result = await invoke(run, 'powershell.exe', args, { timeout: COMMAND_TIMEOUT_MS })
  if (!result.ok) return null
  const celsius = parseThermalKelvinTenths(result.stdout.trim())
  if (celsius === null) return null
  return { celsius: celsius, source: 'acpi' }
}

/**
 * Read the ACPI thermal zone through the unprivileged performance counters.
 *
 * The root/WMI class carries the same number but its ACL refuses a normal
 * user, which is how a machine ends up reporting no sensor at all while the
 * counters answer happily. Values are tenths of kelvin per zone.
 * @param run - the resolved `runCommand`.
 * @returns `{ celsius, source }` or null.
 */
async function readAcpiPerfCounters(run) {
  const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
    'Get-CimInstance -Namespace root/cimv2 -ClassName ' +
    'Win32_PerfFormattedData_Counters_ThermalZoneInformation | ' +
    'Select-Object -ExpandProperty HighPrecisionTemperature'
  const args = ['-NoProfile', '-NonInteractive', '-Command', script]
  const result = await invoke(run, 'powershell.exe', args, { timeout: COMMAND_TIMEOUT_MS })
  if (!result.ok) return null
  let hottest = null
  for (const line of String(result.stdout).split(/\r?\n/)) {
    const celsius = parseThermalKelvinTenths(line.trim())
    if (celsius === null) continue
    if (hottest === null || celsius > hottest) hottest = celsius
  }
  if (hottest === null) return null
  return { celsius: hottest, source: 'acpi_perf' }
}

/**
 * Read every Linux thermal zone and keep the hottest, which is the package.
 * @param readFile - the resolved `readFile`.
 * @param readdir - the resolved `readdir`.
 * @returns `{ celsius, source }` or a `reason` when the zones are unreadable.
 */
async function readThermalZones(readFile, readdir) {
  let entries = []
  try {
    entries = await readdir('/sys/class/thermal')
  } catch (error) {
    if (error && PERMISSION_CODES.has(error.code)) return { celsius: null, source: null, reason: 'permission' }
    return { celsius: null, source: null, reason: 'unsupported' }
  }
  const zones = entries
    .map((entry) => (typeof entry === 'string' ? entry : (entry && entry.name)))
    .filter((name) => typeof name === 'string' && name.indexOf('thermal_zone') === 0)
  if (zones.length === 0) return { celsius: null, source: null, reason: 'unsupported' }
  let hottest = null
  for (const zone of zones) {
    try {
      const text = await readFile('/sys/class/thermal/' + zone + '/temp', 'utf8')
      const milli = toFinite(Number(String(text).trim()))
      if (milli === null) continue
      const celsius = round(milli / 1000, 2)
      if (celsius < PLAUSIBLE_CELSIUS_MIN || celsius > PLAUSIBLE_CELSIUS_MAX) continue
      if (hottest === null || celsius > hottest) hottest = celsius
    } catch { /* one unreadable zone must not lose the others */ }
  }
  if (hottest === null) return { celsius: null, source: null, reason: 'noSensor' }
  return { celsius: hottest, source: 'thermal_zone' }
}

/**
 * Read the CPU package temperature out of the hwmon tree.
 *
 * `hwmon3` today may be `hwmon5` after the next boot, so the directory number
 * means nothing: each chip is identified by its own `name` file and then read
 * through whichever temperature inputs it publishes. A known chip is preferred
 * over the ACPI zones below, because on most machines those describe the board
 * or the chassis and never reach the package.
 * @param deps - the resolved dependency bag.
 * @returns `{ celsius, source, reason }`; `noSensor` when the tree exists but
 *   holds no CPU chip, `unsupported` when there is no tree at all.
 */
async function readHwmonCpu(deps) {
  let entries = []
  try {
    entries = await deps.readdir('/sys/class/hwmon')
  } catch (error) {
    if (error && PERMISSION_CODES.has(error.code)) return { celsius: null, source: null, reason: 'permission' }
    return { celsius: null, source: null, reason: 'unsupported' }
  }
  const dirs = entries
    .map((entry) => (typeof entry === 'string' ? entry : entry && entry.name))
    .filter((name) => typeof name === 'string' && /^hwmon\d+$/.test(name))
  const found = new Map()
  for (const dir of dirs) {
    const base = '/sys/class/hwmon/' + dir + '/'
    const chip = ((await readText(deps.readFile, base + 'name')) || '').toLowerCase()
    if (CPU_HWMON_ORDER.indexOf(chip) < 0 || found.has(chip)) continue
    let hottest = null
    for (let index = 1; index <= 8; index += 1) {
      const milli = await readNumber(deps.readFile, base + 'temp' + index + '_input')
      if (milli === null) continue
      const celsius = round(milli / 1000, 2)
      if (celsius < PLAUSIBLE_CELSIUS_MIN || celsius > PLAUSIBLE_CELSIUS_MAX) continue
      if (hottest === null || celsius > hottest) hottest = celsius
    }
    if (hottest !== null) found.set(chip, hottest)
  }
  for (const chip of CPU_HWMON_ORDER) {
    if (found.has(chip)) return { celsius: found.get(chip), source: 'hwmon', reason: null }
  }
  return { celsius: null, source: null, reason: 'noSensor' }
}

/**
 * Resolve where the package temperature comes from, in the platform's order.
 * @param deps - the resolved dependency bag.
 * @returns `{ celsius, source, reason }`.
 */
async function readTemperature(deps) {
  if (deps.platform === 'win32') {
    try {
      const lhm = await readHardwareMonitor(deps.runCommand, 'root/LibreHardwareMonitor')
      if (lhm) return { celsius: lhm.celsius, source: lhm.source, reason: null }
      const ohm = await readHardwareMonitor(deps.runCommand, 'root/OpenHardwareMonitor')
      if (ohm) return { celsius: ohm.celsius, source: ohm.source, reason: null }
      const acpi = await readAcpiThermalZone(deps.runCommand)
      if (acpi) return { celsius: acpi.celsius, source: acpi.source, reason: null }
      const perf = await readAcpiPerfCounters(deps.runCommand)
      if (perf) return { celsius: perf.celsius, source: perf.source, reason: null }
      return { celsius: null, source: null, reason: 'noSensor' }
    } catch { return { celsius: null, source: null, reason: 'error' } }
  }
  const chip = await readHwmonCpu(deps)
  if (chip.celsius !== null) return chip
  const zones = await readThermalZones(deps.readFile, deps.readdir)
  if (zones.celsius !== null) return { celsius: zones.celsius, source: zones.source, reason: null }
  // A refused hwmon tree is more specific than "this machine has no sensor".
  if (chip.reason === 'permission' || zones.reason === 'permission') {
    return { celsius: null, source: null, reason: 'permission' }
  }
  return { celsius: null, source: null, reason: zones.reason || chip.reason || 'unsupported' }
}

/**
 * Run one temperature probe, sharing it with any caller already waiting.
 *
 * The cache is stamped when the probe finishes rather than when it started, so
 * a slow subprocess is not immediately stale. `resetDeviceCache()` bumps the
 * epoch, which keeps a probe that lands after a reset from repopulating it.
 * @param deps - the resolved dependency bag.
 * @returns `{ celsius, source, reason }`.
 */
async function probeTemperature(deps) {
  if (temperaturePending !== null) return temperaturePending
  const epoch = cacheEpoch
  const run = (async () => {
    const value = await readTemperature(deps)
    if (epoch === cacheEpoch) {
      temperatureCache = { at: deps.now(), value: value, ttlMs: deps.temperatureTtlMs }
    }
    return value
  })()
  temperaturePending = run
  try {
    return await run
  } finally {
    if (temperaturePending === run) temperaturePending = null
  }
}

/**
 * The temperature block for one sample.
 *
 * A performance panel must stay cheap at a fast cadence, so this never blocks a
 * poll on the subprocess probe:
 *  - a warm cache answers directly;
 *  - a stale cache answers with its last value at once and refreshes in the
 *    background — the next poll picks the new reading up;
 *  - a cold cache (the first request after start) waits once, so the card is
 *    never blank.
 * @param deps - the resolved dependency bag.
 * @returns `{ celsius, source, reason }`.
 */
async function temperature(deps) {
  const at = deps.now()
  if (temperatureCache && at - temperatureCache.at < temperatureCache.ttlMs) return temperatureCache.value
  const stale = temperatureCache ? temperatureCache.value : null
  const run = probeTemperature(deps)
  if (stale === null) return run
  run.catch(() => {})
  return stale
}

// -------------------------------------------------------------------- gpu

/**
 * Parse one GPU counter instance name into its adapter id and engine type.
 *
 * The driver spells an engine instance
 * `pid_10148_luid_0x00000000_0x00016656_phys_0_eng_0_engtype_3D`: the LUID is
 * the second `0x…` group after `luid_` — the low half of the adapter's 64-bit
 * id, not the pid and not the `eng` number — and the trailing token is the
 * engine. The `GPUAdapterMemory` rows carry the same two `0x…` groups without
 * an engine, which is why both sides are keyed the same way.
 * @param name - the raw counter instance name.
 * @returns `{ luid, engine }`, or null when the name is not an engine instance.
 */
export function parseGpuEngineName(name) {
  if (typeof name !== 'string' || name === '') return null
  const luid = GPU_LUID_RE.exec(name)
  const engine = GPU_ENGINE_RE.exec(name)
  if (!luid || !engine) return null
  return { luid: luid[2].toLowerCase(), engine: engine[1] }
}

/**
 * Aggregate the per-process GPU engine counters into one reading per adapter.
 *
 * A driver publishes one row per process, engine number and engine type, so the
 * same engine type appears many times per process. Summing every row would
 * report several hundred percent on a busy machine, so the percentages are
 * first summed WITHIN one engine type and the busiest engine type is then the
 * adapter's overall load — the number Task Manager shows.
 * @param rows - `{ Name, UtilizationPercentage }` counter rows.
 * @returns a plain object keyed by luid → `{ usage, engine }`; `usage` is a
 *   0..1 ratio clamped to 1 and `engine` is the type that produced it.
 */
export function gpuUsageByLuid(rows) {
  const sums = {}
  for (const row of listOf(rows)) {
    if (!row || typeof row !== 'object') continue
    const parsed = parseGpuEngineName(row.Name)
    const percent = numericField(row, 'UtilizationPercentage')
    if (!parsed || percent === null || percent < 0) continue
    const engines = sums[parsed.luid] || (sums[parsed.luid] = {})
    engines[parsed.engine] = (engines[parsed.engine] || 0) + percent
  }
  const readings = {}
  for (const luid of Object.keys(sums)) {
    let engine = null
    let best = -1
    for (const type of Object.keys(sums[luid])) {
      if (sums[luid][type] > best) {
        best = sums[luid][type]
        engine = type
      }
    }
    readings[luid] = { usage: round(clamp(best / PERCENT_SCALE, 0, 1), 4), engine: engine }
  }
  return readings
}

/**
 * Read the real video-memory size out of a registry-tool blob.
 *
 * `HardwareInformation.qwMemorySize` is a hex QWORD — `reg query` prints it as
 * `REG_QWORD    0x2fc300000` — and it is the only place the true size of a
 * modern card survives: `Win32_VideoController.AdapterRAM` is a 32-bit field
 * and truncates anything above 4 GiB.
 * @param text - the registry tool's output.
 * @returns the byte count, or null when no plausible hex QWORD is present.
 */
export function parseQwMemorySize(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const match = /0x([0-9a-f]+)/i.exec(text)
  if (!match) return null
  const bytes = Number.parseInt(match[1], 16)
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > Number.MAX_SAFE_INTEGER) return null
  return bytes
}

/**
 * Parse the one JSON document the GPU probe prints.
 * @param text - the command's stdout.
 * @returns the parsed object, or null; a double-encoded string is unwrapped.
 */
export function parseGpuJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  let value = null
  try {
    value = JSON.parse(text)
    if (typeof value === 'string') value = JSON.parse(value)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  return value
}

/**
 * The empty GPU block, carrying the reason the reading is missing.
 * @param reason - null once an adapter was found, else the probe's code.
 * @returns the document's `gpu` block.
 */
function emptyGpu(reason) {
  return {
    name: '',
    vendor: '',
    usage: null,
    engine: null,
    memory: { used: null, total: null, usage: null },
    reason: reason,
  }
}

/**
 * Wrap a payload field that may arrive as a single object where a list belongs.
 * `ConvertTo-Json` collapses a one-element array into that element.
 * @param value - the JSON field.
 * @returns an array; empty when the field is missing.
 */
function listOf(value) {
  if (Array.isArray(value)) return value
  return value === null || value === undefined ? [] : [value]
}

/**
 * Read a numeric JSON field, accepting the string spelling a tool may emit.
 * @param row - the row object.
 * @param key - the field name.
 * @returns the number, or null.
 */
function numericField(row, key) {
  if (!row || typeof row !== 'object') return null
  const raw = row[key]
  return toFinite(typeof raw === 'string' ? Number(raw.trim()) : raw)
}

/** @returns the luid inside a counter instance name, or null. */
function parseLuid(name) {
  if (typeof name !== 'string') return null
  const match = GPU_LUID_RE.exec(name)
  return match ? match[2].toLowerCase() : null
}

/**
 * Name the vendor behind an adapter; the driver gives us the name, nothing more.
 * @param name - the `Win32_VideoController` name.
 * @returns `'nvidia'`, `'amd'`, `'intel'` or '' when it is not recognised.
 */
function gpuVendor(name) {
  const text = typeof name === 'string' ? name : ''
  if (/nvidia|geforce|quadro|rtx|gtx/i.test(text)) return 'nvidia'
  if (/amd|radeon|advanced micro/i.test(text)) return 'amd'
  if (/intel|iris|uhd graphics/i.test(text)) return 'intel'
  return ''
}

/** @returns true when a controller is a virtual or remote display, not a card. */
function isVirtualAdapter(name, pnp) {
  if (VIRTUAL_ADAPTER_ID_RE.test(String(pnp))) return true
  return VIRTUAL_ADAPTER_RE.test(String(name))
}

/**
 * Choose the luid the engine and memory readings describe.
 *
 * `Win32_VideoController` carries no LUID, so the adapter the document names
 * cannot be joined to its counter rows directly. The row holding the most
 * dedicated video memory is the physical card in every arrangement this can see
 * — a virtual or integrated adapter is left at zero — so that row's luid is
 * used; when nothing has allocated dedicated memory yet, the busiest adapter
 * answers instead.
 * @param rows - the memory rows as `{ luid, dedicated, shared }`.
 * @param readings - the engine readings, keyed by luid.
 * @returns the luid, or null when there is nothing to choose from.
 */
function pickAdapterLuid(rows, readings) {
  let richest = null
  for (const row of rows) {
    if (richest === null || row.dedicated > richest.dedicated) richest = row
  }
  if (richest && richest.dedicated > 0) return richest.luid
  let busiest = null
  for (const luid of Object.keys(readings)) {
    if (busiest === null || readings[luid].usage > readings[busiest].usage) busiest = luid
  }
  if (busiest !== null) return busiest
  return richest ? richest.luid : null
}

/**
 * Reduce the probe's JSON into the document's GPU block.
 * @param data - the parsed probe payload.
 * @returns the `gpu` block; `reason` stays null once an adapter was found.
 */
function composeGpu(data) {
  const controllers = []
  for (const row of listOf(data.controllers)) {
    if (!row || typeof row !== 'object') continue
    const name = String(row.Name === undefined ? '' : row.Name).trim()
    const pnp = String(row.PNPDeviceID === undefined ? '' : row.PNPDeviceID).trim()
    const ram = numericField(row, 'AdapterRAM')
    if (name === '' && pnp === '') continue
    controllers.push({
      name: name,
      ram: ram !== null && ram > 0 ? ram : null,
      virtual: isVirtualAdapter(name, pnp),
    })
  }
  if (controllers.length === 0) return emptyGpu('noCounters')

  const memoryRows = []
  for (const row of listOf(data.memory)) {
    if (!row || typeof row !== 'object') continue
    const luid = parseLuid(row.Name)
    if (!luid) continue
    memoryRows.push({
      luid: luid,
      dedicated: numericField(row, 'DedicatedUsage') || 0,
      shared: numericField(row, 'SharedUsage') || 0,
    })
  }

  const readings = gpuUsageByLuid(listOf(data.engines))

  // The registry QWORD is the driver's own byte count; AdapterRAM is 32-bit.
  let registryTotal = null
  for (const row of listOf(data.vram)) {
    if (!row || typeof row !== 'object') continue
    const bytes = parseQwMemorySize(row.text === undefined ? row.Text : row.text)
    if (bytes !== null && (registryTotal === null || bytes > registryTotal)) registryTotal = bytes
  }

  // A virtual adapter is never the card the panel should describe, and between
  // two real cards the larger one is the adapter the reader cares about.
  const physical = controllers.filter((entry) => entry.virtual !== true)
  const pool = physical.length > 0 ? physical : controllers
  const adapter = pool.reduce(
    (best, entry) =>
      entry.ram !== null && (best.ram === null || entry.ram > best.ram) ? entry : best,
    pool[0],
  )

  const total = registryTotal !== null && physical.length > 0 ? registryTotal : adapter.ram
  const luid = pickAdapterLuid(memoryRows, readings)
  const memoryRow = memoryRows.find((row) => row.luid === luid) || null
  const reading = luid !== null ? readings[luid] : null
  const used = memoryRow ? memoryRow.dedicated : null

  return {
    name: adapter.name,
    vendor: gpuVendor(adapter.name),
    usage: reading ? reading.usage : null,
    engine: reading ? reading.engine : null,
    memory: {
      used: used,
      total: total,
      usage:
        used !== null && total !== null && total > 0
          ? round(clamp(used / total, 0, 1), 4)
          : null,
    },
    reason: null,
  }
}

/**
 * The one PowerShell script that answers the whole GPU block.
 *
 * One spawn, not four: the engine counters, the adapter memory, the video
 * controllers and the driver's registry VRAM size are collected into a single
 * compact JSON object. The VRAM value is read back through `reg query`, whose
 * blob is the only place a normal user can see `HardwareInformation.qwMemorySize`
 * — the provider view of that key refuses some of its children. The script uses
 * no double quotes at all so no outer layer can mangle it.
 * @returns the `-Command` argument.
 */
const GPU_QUERY_SCRIPT = [
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
  "$ErrorActionPreference='SilentlyContinue';",
  "$basePs='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';",
  "$baseReg='HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';",
  '$eng=@(Get-CimInstance -Namespace root/cimv2 -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Select-Object Name,UtilizationPercentage);',
  '$mem=@(Get-CimInstance -Namespace root/cimv2 -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | Select-Object Name,DedicatedUsage,SharedUsage);',
  '$vc=@(Get-CimInstance -Namespace root/cimv2 -ClassName Win32_VideoController | Select-Object Name,PNPDeviceID,AdapterRAM);',
  "$vram=@(foreach($k in @(Get-ChildItem $basePs -ErrorAction SilentlyContinue)){ if($k.PSChildName -match '^\\d+$'){ $t=(& reg.exe query ($baseReg+'\\'+$k.PSChildName) /v HardwareInformation.qwMemorySize 2>$null) -join ([char]10); if($t.Trim()){ @{key=$k.PSChildName;text=$t} } } });",
  '[pscustomobject]@{engines=$eng;memory=$mem;controllers=$vc;vram=$vram} | ConvertTo-Json -Compress -Depth 6',
].join('')

/**
 * Map a failed GPU probe onto the document's reason vocabulary.
 * @param result - the `invoke` result.
 * @returns `'permission'` or `'error'`.
 */
function gpuFailureReason(result) {
  if (result.reason === 'permission') return 'permission'
  if (/access|denied|拒绝/i.test(result.stderr)) return 'permission'
  return 'error'
}

/**
 * Read GPU load and video memory on Windows in one PowerShell spawn.
 * @param deps - the resolved dependency bag.
 * @returns the `gpu` block; never throws.
 */
async function readGpuWindows(deps) {
  const args = ['-NoProfile', '-NonInteractive', '-Command', GPU_QUERY_SCRIPT]
  const result = await invoke(deps.runCommand, 'powershell.exe', args, {
    timeout: GPU_TIMEOUT_MS,
  })
  const data = parseGpuJson(result.stdout)
  if (!data) return emptyGpu(result.ok ? 'noCounters' : gpuFailureReason(result))
  return composeGpu(data)
}

/**
 * Choose between the amdgpu cards that answered.
 *
 * A hybrid machine publishes a row per card; the discrete one is the reading a
 * reader asks for, and it is the one with the larger dedicated VRAM. When no
 * card publishes a size, the busiest answers; otherwise the first one does.
 * @param candidates - `{ usage, used, total }` per card.
 * @returns the candidate to report.
 */
function pickLinuxCard(candidates) {
  let richest = null
  for (const entry of candidates) {
    if (entry.total === null || entry.total <= 0) continue
    if (richest === null || entry.total > richest.total) richest = entry
  }
  if (richest !== null) return richest
  let busiest = candidates[0]
  for (const entry of candidates) {
    if (entry.usage > busiest.usage) busiest = entry
  }
  return busiest
}

/**
 * Read GPU load and video memory on Linux, best effort.
 *
 * Two drivers can answer, and the free one is tried first: `amdgpu` publishes
 * `gpu_busy_percent` and the `mem_info_vram_*` files in sysfs, so a machine
 * whose card answers there never pays for a subprocess. NVIDIA publishes
 * nothing in sysfs, so `NVIDIA_PROC_PATH` is read as the gate for the
 * `nvidia-smi` fallback — its absence is the whole test, and it is what keeps
 * a pure AMD box subprocess-free.
 *
 * Nothing here throws: an unreadable tree is `unsupported`, and a card that
 * answers without a VRAM size still reports its load.
 * @param deps - the resolved dependency bag.
 * @returns the `gpu` block.
 */
async function readGpuLinux(deps) {
  let entries = []
  try {
    entries = await deps.readdir('/sys/class/drm')
  } catch (error) {
    if (error && PERMISSION_CODES.has(error.code)) return emptyGpu('permission')
    return emptyGpu('unsupported')
  }
  const cards = entries
    .map((entry) => (typeof entry === 'string' ? entry : entry && entry.name))
    .filter((name) => typeof name === 'string' && /^card\d+$/.test(name))
    .sort()
  const candidates = []
  for (const card of cards) {
    const base = '/sys/class/drm/' + card + '/device/'
    const busy = await readNumber(deps.readFile, base + 'gpu_busy_percent')
    if (busy === null || busy < 0) continue
    candidates.push({
      usage: round(clamp(busy / PERCENT_SCALE, 0, 1), 4),
      used: await readNumber(deps.readFile, base + 'mem_info_vram_used'),
      total: await readNumber(deps.readFile, base + 'mem_info_vram_total'),
    })
  }
  if (candidates.length > 0) {
    const best = pickLinuxCard(candidates)
    return {
      name: '',
      vendor: '',
      usage: best.usage,
      engine: null,
      memory: memoryBlock(best.used, best.total),
      reason: null,
    }
  }
  // Only amdgpu answers in sysfs; every other driver needs its own tool.
  if (await hasPath(deps.readFile, NVIDIA_PROC_PATH)) return await readGpuNvidia(deps)
  return emptyGpu('unsupported')
}

/**
 * Parse the CSV `nvidia-smi --format=csv,noheader,nounits` prints.
 *
 * One line per adapter, four columns, no header and no units. A field the card
 * cannot report arrives as `[N/A]`, which is dropped rather than coerced: a
 * line without a real memory size cannot become a VRAM reading.
 * @param text - the command's stdout.
 * @returns one `{ name, usage, used, total }` per adapter with a real size.
 */
export function parseNvidiaCsv(text) {
  if (typeof text !== 'string' || text.trim() === '') return []
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const parts = trimmed.split(',').map((part) => part.trim())
    if (parts.length < 4) continue
    const usage = toFinite(Number(parts[1]))
    const usedMiB = toFinite(Number(parts[2]))
    const totalMiB = toFinite(Number(parts[3]))
    if (usage === null || totalMiB === null || totalMiB <= 0) continue
    rows.push({
      name: parts[0] === '[N/A]' ? '' : parts[0],
      usage: round(clamp(usage / PERCENT_SCALE, 0, 1), 4),
      used: usedMiB === null ? null : Math.round(usedMiB * MIB),
      total: Math.round(totalMiB * MIB),
    })
  }
  return rows
}

/**
 * Read GPU load and video memory from `nvidia-smi`, best effort.
 *
 * The binary is missing from some service PATHs and absent entirely when the
 * driver is unloaded; both describe the machine rather than a defect, so they
 * are `unsupported` and not `error`.
 * @param deps - the resolved dependency bag.
 * @returns the `gpu` block.
 */
async function readGpuNvidia(deps) {
  const args = ['--query-gpu=' + NVIDIA_QUERY, '--format=csv,noheader,nounits']
  const result = await invoke(deps.runCommand, 'nvidia-smi', args, {
    timeout: COMMAND_TIMEOUT_MS,
  })
  if (!result.ok) {
    if (MISSING_TOOL_RE.test(result.stderr)) return emptyGpu('unsupported')
    return emptyGpu(gpuFailureReason(result))
  }
  const rows = parseNvidiaCsv(result.stdout)
  if (rows.length === 0) return emptyGpu('noCounters')
  // A multi-card machine answers one row per adapter; the largest is the card.
  const best = rows.reduce(
    (largest, entry) => (entry.total > largest.total ? entry : largest),
    rows[0],
  )
  return {
    name: best.name,
    vendor: 'nvidia',
    usage: best.usage,
    engine: null,
    memory: memoryBlock(best.used, best.total),
    reason: null,
  }
}

/**
 * Parse a `system_profiler` size string into bytes.
 * @param text - `8 GB`, `1536 MB` or `512 KB`.
 * @returns the byte count, or null when the string is not a size.
 */
export function parseProfilerSize(text) {
  if (typeof text !== 'string') return null
  const match = PROFILER_SIZE_RE.exec(text)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const unit = match[2].toUpperCase()
  const factor = unit === 'GB' ? 1024 * MIB : unit === 'MB' ? MIB : 1024
  return Math.round(value * factor)
}

/**
 * Read the adapter's identity and video memory on macOS.
 *
 * macOS publishes no utilization a normal user may read — the only figure
 * exists behind `powermetrics`, which demands root — so this block reports the
 * card and its memory and leaves `usage` null. That is a real answer with a
 * hole in it rather than a missing source, so `reason` stays null.
 * @param deps - the resolved dependency bag.
 * @returns the `gpu` block.
 */
async function readGpuDarwin(deps) {
  const args = ['SPDisplaysDataType', '-json']
  const result = await invoke(deps.runCommand, 'system_profiler', args, {
    timeout: DISPLAY_PROFILER_TIMEOUT_MS,
  })
  if (!result.ok) {
    if (MISSING_TOOL_RE.test(result.stderr)) return emptyGpu('unsupported')
    return emptyGpu(gpuFailureReason(result))
  }
  const data = parseGpuJson(result.stdout)
  const cards = listOf(data && data.SPDisplaysDataType)
  let best = null
  for (const card of cards) {
    if (!card || typeof card !== 'object') continue
    const name = String(card.sppci_model || card._name || '').trim()
    const total = parseProfilerSize(card.spdisplays_vram) || parseProfilerSize(card.spdisplays_vram_shared)
    if (name === '' && total === null) continue
    const entry = { name: name, total: total }
    if (best === null || (entry.total || 0) > (best.total || 0)) best = entry
  }
  if (best === null) return emptyGpu('noCounters')
  return {
    name: best.name,
    vendor: gpuVendor(best.name),
    usage: null,
    engine: null,
    memory: memoryBlock(null, best.total),
    reason: null,
  }
}

/**
 * Resolve the GPU reading for the platform at hand, degrading on every path.
 * @param deps - the resolved dependency bag.
 * @returns the `gpu` block; never rejects.
 */
async function readGpu(deps) {
  try {
    if (deps.platform === 'win32') return await readGpuWindows(deps)
    if (deps.platform === 'darwin') return await readGpuDarwin(deps)
    return await readGpuLinux(deps)
  } catch {
    return emptyGpu('error')
  }
}

/**
 * Run one GPU probe, sharing it with any caller already waiting.
 *
 * The cache is stamped when the probe finishes, and a failed verdict gets the
 * longer `GPU_FAILURE_TTL_MS` so a broken counter provider is not retried at
 * poll speed. The epoch guard keeps a late probe out of a reset cache.
 * @param deps - the resolved dependency bag.
 * @returns the `gpu` block; never rejects.
 */
async function probeGpu(deps) {
  if (gpuPending !== null) return gpuPending
  const epoch = cacheEpoch
  const run = (async () => {
    const value = await readGpu(deps)
    if (epoch === cacheEpoch) {
      const failed = !value || value.usage === null
      gpuCache = {
        at: deps.now(),
        value: value,
        ttlMs: failed ? GPU_FAILURE_TTL_MS : deps.gpuTtlMs,
      }
    }
    return value
  })()
  gpuPending = run
  try {
    return await run
  } finally {
    if (gpuPending === run) gpuPending = null
  }
}

/**
 * The GPU block for one sample.
 *
 * The probe is the most expensive read the surface makes, so a poll never waits
 * for a refresh: a warm cache answers directly, a stale cache answers with its
 * last value while the probe runs in the background, and only a cold cache (the
 * first request) waits. That is what lets the card poll quickly for CPU and
 * memory without making the GPU a per-poll subprocess.
 * @param deps - the resolved dependency bag.
 * @returns the `gpu` block; never rejects.
 */
async function gpuReading(deps) {
  const at = deps.now()
  if (gpuCache && at - gpuCache.at < gpuCache.ttlMs) return gpuCache.value
  const stale = gpuCache ? gpuCache.value : null
  const run = probeGpu(deps)
  if (stale === null) return run
  run.catch(() => {})
  return stale
}

// ------------------------------------------------------------------ cache

/**
 * Drop every cache and the history, so a test starts from the first-call path
 * exactly as a fresh process would. Tests only; the host never calls this.
 * @returns nothing.
 */
export function resetDeviceCache() {
  cacheEpoch += 1
  prevTimes = null
  prevAt = null
  lastSample = null
  temperatureCache = null
  temperaturePending = null
  gpuCache = null
  gpuPending = null
  samplePending = null
  history = []
  firstReadDone = false
}

// ----------------------------------------------------------------- wiring

/**
 * Resolve every injectable against its real default.
 * @param options - the caller's overrides.
 * @returns the dependency bag used for one sample.
 */
function resolve(options) {
  const input = options && typeof options === 'object' ? options : {}
  const os = input.os || DEFAULT_OS
  const platform = typeof input.platform === 'string' && input.platform !== ''
    ? input.platform
    : (typeof os.platform === 'function' ? String(os.platform()) : process.platform)
  return {
    os: os,
    now: typeof input.now === 'function' ? input.now : Date.now,
    runCommand: typeof input.runCommand === 'function' ? input.runCommand : spawnRunCommand(spawn),
    statfs: typeof input.statfs === 'function' ? input.statfs : defaultStatfs,
    readFile: typeof input.readFile === 'function' ? input.readFile : fsp.readFile,
    readdir: typeof input.readdir === 'function' ? input.readdir : fsp.readdir,
    sleep: typeof input.sleep === 'function' ? input.sleep : defaultSleep,
    temperatureTtlMs: toFinite(input.temperatureTtlMs) !== null && input.temperatureTtlMs >= 0
      ? input.temperatureTtlMs
      : 120000,
    temperature: input.temperature !== false,
    gpuTtlMs: toFinite(input.gpuTtlMs) !== null && input.gpuTtlMs >= 0
      ? input.gpuTtlMs
      : GPU_TTL_MS,
    gpu: input.gpu !== false,
    historyLimit: toFinite(input.historyLimit) !== null && input.historyLimit >= 0
      ? Math.floor(input.historyLimit)
      : 120,
    platform: platform,
  }
}

/**
 * Pay for one extra reading when the process has no earlier snapshot yet, so
 * the first usage number is measured over a real interval instead of being 0.
 * @param deps - the resolved dependency bag.
 * @returns nothing; `prevTimes` is filled in.
 */
async function primeFirstRead(deps) {
  if (firstReadDone) return
  firstReadDone = true
  const before = cpuSnapshot(safeCpus(deps.os))
  if (!before) return
  await deps.sleep(FIRST_SAMPLE_DELAY_MS)
  const after = cpuSnapshot(safeCpus(deps.os))
  if (!after) return
  prevTimes = after
  prevAt = deps.now()
}

/**
 * Read every source and build the document.
 * @param deps - the resolved dependency bag.
 * @returns the sample document.
 */
async function gather(deps) {
  await primeFirstRead(deps)
  const at = deps.now()
  const cores = safeCpus(deps.os)
  const snapshot = cpuSnapshot(cores)
  const usage = cpuUsage(prevTimes, snapshot)
  prevTimes = snapshot || prevTimes
  const sampleSeconds = prevAt === null ? 0 : round(Math.max(0, at - prevAt) / 1000, 2)
  const previousAt = prevAt
  prevAt = at
  const memory = readMemory(deps.os)
  // The two hardware blocks are independent: a cold start pays for them in
  // parallel rather than one after the other. Once warm, both resolve from
  // cache in the same tick, so a fast poll never waits on a subprocess.
  const blocks = await Promise.all([
    deps.temperature ? temperature(deps) : { celsius: null, source: null, reason: 'skipped' },
    deps.gpu ? gpuReading(deps) : emptyGpu('skipped'),
  ])
  const thermal = blocks[0]
  const gpu = blocks[1]
  const drive = systemDrive(deps.platform)

  const cpu = {
    usage: round(usage.usage, 4),
    cores: usage.cores.map((value) => round(value, 4)),
    count: cores.length,
    model: String((cores[0] && cores[0].model) || '').trim(),
    speedMhz: Math.round(toFinite(cores[0] && cores[0].speed) || 0),
    loadavg: readLoadavg(deps.os),
  }

  let hostname = ''
  let uptime = 0
  let arch = deps.platform
  let release = ''
  try { hostname = String(deps.os.hostname()) } catch { hostname = '' }
  try { uptime = Math.round(toFinite(deps.os.uptime()) || 0) } catch { uptime = 0 }
  try { arch = String(deps.os.arch()) } catch { arch = deps.platform }
  try { release = String(deps.os.release()) } catch { release = '' }

  const entry = { at: at, cpu: cpu, memory: memory, temperature: thermal, gpu: gpu }
  history.push(entry)
  if (history.length > deps.historyLimit) history.splice(0, history.length - deps.historyLimit)

  return {
    at: at,
    sampleSeconds: previousAt === null ? 0 : sampleSeconds,
    cpu: cpu,
    memory: memory,
    temperature: thermal,
    gpu: gpu,
    disk: readDisk(deps.statfs, drive.path),
    system: {
      platform: deps.platform,
      arch: arch,
      release: release,
      hostname: hostname,
      uptime: uptime,
      node: process.version,
      cpuModel: cpu.model,
      drive: drive.drive,
    },
    history: history.slice(),
  }
}

// --------------------------------------------------------------- sampling

/**
 * Sample the machine's CPU, memory, temperature, GPU and disk.
 *
 * Never rejects: every source that fails degrades to `null`, to a `reason`
 * code, or to zeros, and the rest of the document still comes back. A call
 * inside the one-second dedupe window returns the memoized document unchanged,
 * and a call made while a sample is still gathering shares that sample instead
 * of starting a second set of probes.
 * @param options - injectable sources and limits; see the module docblock.
 * @returns the sample document.
 */
export async function sampleDevice(options = {}) {
  const deps = resolve(options)
  const at = deps.now()
  if (lastSample && at - lastSample.at < MIN_SAMPLE_INTERVAL_MS) return lastSample
  if (samplePending !== null) return samplePending
  const run = (async () => {
    try {
      const sample = await gather(deps)
      lastSample = sample
      return sample
    } catch (error) {
      return {
        at: deps.now(),
        sampleSeconds: 0,
        cpu: { usage: 0, cores: [], count: 0, model: '', speedMhz: 0, loadavg: null },
        memory: { total: 0, free: 0, used: 0, usage: 0, swapTotal: 0, swapFree: 0, swapUsed: 0 },
        temperature: { celsius: null, source: null, reason: 'error' },
        gpu: emptyGpu('error'),
        disk: null,
        system: {
          platform: deps.platform,
          arch: deps.platform,
          release: '',
          hostname: '',
          uptime: 0,
          node: process.version,
          cpuModel: '',
          drive: null,
        },
        history: history.slice(),
        error: error && error.message ? String(error.message) : 'sample failed',
      }
    }
  })()
  samplePending = run
  try {
    return await run
  } finally {
    if (samplePending === run) samplePending = null
  }
}

// ------------------------------------------------------ periodic sampling

/**
 * Start the cheap periodic sampler that keeps the history ring buffer fed.
 *
 * The tick samples with `temperature: false` and `gpu: false`, so it never
 * spawns a subprocess and never blocks on either cache; a failing tick is
 * swallowed the same way `sampleDevice` swallows its sources. The interval is
 * unref-ed when the timer offers it, so it can never hold the host process open.
 * @param options - the same injectables `sampleDevice` takes, plus `intervalMs`,
 *   `setInterval` and `clearInterval` so a test can drive it with a fake timer.
 * @returns a `stop()` function that clears the interval; calling it twice is safe.
 */
export function startDeviceSampler(options = {}) {
  const input = options && typeof options === 'object' ? options : {}
  const intervalMs = toFinite(input.intervalMs) !== null && input.intervalMs > 0 ? input.intervalMs : 15000
  const setTimer = typeof input.setInterval === 'function' ? input.setInterval : setInterval
  const clearTimer = typeof input.clearInterval === 'function' ? input.clearInterval : clearInterval
  let timer = null
  let stopped = false

  const tick = () => { sampleDevice({ ...input, temperature: false, gpu: false }).catch(() => {}) }

  try {
    timer = setTimer(tick, intervalMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  } catch { timer = null }

  return function stop() {
    if (stopped) return
    stopped = true
    if (timer === null) return
    try { clearTimer(timer) } catch { /* already gone */ }
    timer = null
  }
}
