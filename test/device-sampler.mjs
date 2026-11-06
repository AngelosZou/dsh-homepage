/**
 * Unit test for the host-side device sampler (`lib/host/device.js`).
 *
 * Plain script, no framework: `node test/device-sampler.mjs`. Every source is
 * injected, so the test passes on a machine with no temperature sensor at all
 * and never spawns a real subprocess.
 *
 * Run: node test/device-sampler.mjs
 */
import assert from 'node:assert/strict'
import { cpuUsage, gpuUsageByLuid, parseGpuEngineName, parseGpuJson, parseNvidiaCsv,
  parseQwMemorySize, parseSensorJson, parseThermalKelvinTenths, resetDeviceCache,
  sampleDevice, startDeviceSampler } from '../lib/host/device.js'

/** Milliseconds fixture used by every section, mirroring the module's own window. */
const STEP_MS = 5000

console.log('device-sampler: exercising pure helpers with injected fixtures')

// ------------------------------------------------------------ cpuUsage math

{
  // Hand-computed window. Every tick except `idle` counts as busy, so a core's
  // value is 1 - idleDelta / totalDelta. Both cores move by exactly 100 ticks;
  // core 0 is idle for 50 of them, core 1 for 75.
  const before = [
    { times: { user: 400, nice: 0, sys: 100, idle: 450, irq: 50 } },   // total 1000
    { times: { user: 200, nice: 0, sys: 100, idle: 675, irq: 25 } },   // total 1000
  ]
  const after = [
    { times: { user: 450, nice: 0, sys: 100, idle: 500, irq: 50 } },   // total 1100, idle +50
    { times: { user: 200, nice: 0, sys: 125, idle: 750, irq: 25 } },   // total 1100, idle +75
  ]
  const result = cpuUsage(before, after)
  assert.equal(result.cores.length, 2, 'one entry per core')
  assert.equal(result.cores[0], 0.5, 'core 0 used half the window')
  assert.equal(result.cores[1], 0.25, 'core 1 used a quarter of the window')
  assert.equal(result.usage, 0.375, 'system-wide usage is the core average')
  console.log('  cpuUsage: idle-fraction math, per-core array length and the system average')

  // A zero-length window must read as 0, never as NaN.
  const empty = cpuUsage([{ times: { user: 1, nice: 0, sys: 1, idle: 1, irq: 0 } }], [{ times: {
    user: 1, nice: 0, sys: 1, idle: 1, irq: 0 } }])
  assert.equal(empty.usage, 0, 'zero delta guards to 0')
  assert.ok(Number.isFinite(empty.cores[0]), 'per-core zero delta is finite')
  assert.equal(cpuUsage(null, null).usage, 0, 'a missing snapshot yields 0')
  console.log('  cpuUsage: zero-delta guard returns 0 (not NaN)')
}

// --------------------------------------------------- memory, disk, system

{
  resetDeviceCache()
  const calls = []
  const runCommand = async (command, args) => { calls.push(args); return { ok: false, stdout: '', stderr: '' } }

  const fixture = {
    total: 34359738368,
    free: 12884901888,
    hostname: 'DESKTOP-FIXTURE',
    uptime: 123456,
    platform: 'win32',
    arch: 'x64',
    release: '10.0.26100',
  }
  const statfs = () => ({ bsize: 4096, blocks: 244190646, bfree: 98304, bavail: 98304 })

  const sample = await sampleDevice({
    os: fakeOs({ total: fixture.total, free: fixture.free, fixture: fixture }),
    now: fakeClock(1792000000000),
    runCommand: runCommand,
    statfs: statfs,
    readdir: async () => [],
    readFile: async () => '',
    sleep: async () => {},
    platform: 'win32',
  })

  assert.equal(sample.memory.total, 34359738368, 'memory total comes from totalmem')
  assert.equal(sample.memory.free, 12884901888, 'memory free comes from freemem')
  assert.equal(sample.memory.used, 21474836480, 'used = total - free')
  assert.equal(sample.memory.usage, 0.625, 'usage = used / total')
  assert.equal(sample.memory.swapTotal, 0, 'swapTotal defaults to 0')
  assert.equal(sample.memory.swapFree, 0, 'swapFree defaults to 0')
  assert.equal(sample.memory.swapUsed, 0, 'swapUsed defaults to 0')
  console.log('  memory: used/total/usage math and zeroed swap defaults')

  assert.equal(sample.disk.path, 'C:\\', 'windows disk root is the system drive')
  assert.equal(sample.disk.total, 244190646 * 4096, 'disk total = blocks * bsize')
  assert.equal(sample.disk.free, 98304 * 4096, 'disk free = bfree * bsize')
  assert.equal(sample.disk.used, (244190646 - 98304) * 4096, 'disk used = (blocks - bfree) * bsize')
  assert.ok(sample.disk.usage > 0.99 && sample.disk.usage <= 1, 'disk usage is a fraction')
  console.log('  disk: statfs math, plus system drive and platform facts')

  assert.equal(sample.system.hostname, 'DESKTOP-FIXTURE', 'hostname comes from os')
  assert.equal(sample.system.arch, 'x64', 'arch comes from os')
  assert.equal(sample.system.release, '10.0.26100', 'release comes from os')
  assert.equal(sample.system.uptime, 123456, 'uptime comes from os')
  assert.equal(sample.system.drive, 'C:', 'the drive label is reported')
  assert.equal(sample.system.node, process.version, 'the node version is the running one')
  assert.equal(typeof sample.at, 'number', 'the sample carries an epoch-ms stamp')
  assert.ok(Array.isArray(sample.history) && sample.history.length === 1, 'the first sample is in history')
  console.log('  system: platform facts, drive label and history append')
}

// ------------------------------------------------------- pure parsers

{
  assert.equal(parseThermalKelvinTenths(3732), 100.05, '3732 tenths of kelvin is 100.05 C')
  assert.equal(parseThermalKelvinTenths('3732'), 100.05, 'a string reading parses the same way')
  assert.equal(parseThermalKelvinTenths(null), null, 'null is not a reading')
  assert.equal(parseThermalKelvinTenths(0), null, 'a zero reading is not a reading')
  assert.equal(parseThermalKelvinTenths('nonsense'), null, 'non-numeric text is not a reading')
  assert.equal(parseThermalKelvinTenths(floatOutOfRange()), null, 'an implausible reading is rejected')
  console.log('  parseThermalKelvinTenths: kelvin-tenths conversion plus invalid inputs')

  const single = JSON.stringify({ Name: 'CPU Package', Value: 61.5 })
  const parsed = parseSensorJson(single)
  assert.ok(parsed, 'a single-object payload parses')
  assert.equal(parsed.celsius, 61.5, 'the value is the celsius reading')
  assert.equal(parsed.name, 'CPU Package', 'the row name is kept')
  console.log('  parseSensorJson: single object, LibreHardwareMonitor shape')

  const array = JSON.stringify([
    { Name: 'GPU Core', Value: 72.4 },
    { Name: 'CPU Package', Value: 61.5 },
    { Name: 'System', Value: 44.0 },
  ])
  const fromArray = parseSensorJson(array)
  assert.ok(fromArray, 'an array payload parses')
  assert.equal(fromArray.name, 'CPU Package', 'the CPU row wins over the hotter GPU row')
  assert.equal(fromArray.celsius, 61.5, 'the CPU row carries its own reading')
  console.log('  parseSensorJson: array payload prefers the CPU/package row')

  const camel = parseSensorJson(JSON.stringify({ name: 'CPU Core', value: '55.25' }))
  assert.equal(camel.celsius, 55.25, 'camel-case keys and string values are accepted')
  const noCpu = parseSensorJson(JSON.stringify([{ Name: 'GPU', Value: 70 }, { Name: 'SSD', Value: 41 }]))
  assert.equal(noCpu.celsius, 70, 'without a CPU row the hottest is taken')
  assert.equal(parseSensorJson(JSON.stringify({ Name: 'Idle', Value: 0 })).celsius, 0,
    'a zero reading is plausible and is kept')
  assert.equal(parseSensorJson(JSON.stringify({ Name: 'Broken', Value: -300 })), null,
    'an implausible reading is dropped, leaving nothing')
  assert.equal(parseSensorJson(JSON.stringify([{ Name: 'Broken', Value: 9000 }, { Name: 'Also', Value: 'x' }])), null,
    'rows without a usable reading yield null')
  assert.equal(parseSensorJson('not json'), null, 'malformed json is null')
  assert.equal(parseSensorJson(''), null, 'empty output is null')
  assert.equal(parseSensorJson(null), null, 'a missing payload is null')
  console.log('  parseSensorJson: camel keys, max fallback and malformed input')
}

// ------------------------------------- temperature order + fall-through

{
  resetDeviceCache()
  const calls = []
  const runCommand = async (command, args) => {
    calls.push(args)
    // Source 1 answers but with a value that is not a temperature, source 2
    // exits non-zero, so the ACPI thermal zone is the one that finally reports.
    if (calls.length === 1) return { ok: true, stdout: 'CPU Package 61.5 / CPU Total 60.1', stderr: '' }
    if (calls.length === 2) return { ok: false, stdout: '', stderr: 'boom' }
    return { ok: true, stdout: '3362', stderr: '' }
  }
  const sample = await sampleDevice({
    os: fakeOs({}),
    now: fakeClock(1792000000000),
    runCommand: runCommand,
    readdir: async () => [],
    readFile: async () => '',
    sleep: async () => {},
    platform: 'win32',
    gpu: false,
  })

  assert.equal(calls.length, 3, 'all three Windows sources were tried in order')
  assert.ok(calls[0][3].indexOf('LibreHardwareMonitor') >= 0, 'source 1 is LibreHardwareMonitor')
  assert.ok(calls[1][3].indexOf('OpenHardwareMonitor') >= 0, 'source 2 is OpenHardwareMonitor')
  assert.ok(calls[2][3].indexOf('MSAcpi_ThermalZoneTemperature') >= 0, 'source 3 is the ACPI thermal zone')
  assert.equal(sample.temperature.celsius, 63.05, 'tenths of kelvin convert to celsius')
  assert.equal(sample.temperature.source, 'acpi', 'the source names the probe that answered')
  assert.equal(sample.temperature.reason, null, 'a successful probe carries no reason')
  console.log('  temperature: source order with fall-through LHM -> OHM -> ACPI')

  resetDeviceCache()
  const second = []
  const fallThrough = await sampleDevice({
    os: fakeOs({}),
    now: fakeClock(1792000000000),
    runCommand: async (command, args) => {
      second.push(args)
      if (second.length === 1) return { ok: false, stdout: '', stderr: 'Access is denied.' }
      return { ok: true, stdout: '{"Name":"CPU Package","Value":61.5}', stderr: '' }
    },
    readdir: async () => [],
    readFile: async () => '',
    sleep: async () => {},
    platform: 'win32',
    gpu: false,
  })
  assert.equal(second.length, 2, 'source 1 failed and source 2 answered')
  assert.ok(second[0][3].indexOf('LibreHardwareMonitor') >= 0, 'the failed source was LHM')
  assert.ok(second[1][3].indexOf('OpenHardwareMonitor') >= 0, 'the answering source was OHM')
  assert.equal(fallThrough.temperature.celsius, 61.5, 'the OHM row is parsed')
  assert.equal(fallThrough.temperature.source, 'ohm', 'the reported source is OHM')
  console.log('  temperature: a refused source 1 falls through to source 2')

  resetDeviceCache()
  const refused = []
  const counters = await sampleDevice({
    os: fakeOs({}),
    now: fakeClock(1792000000000),
    runCommand: async (command, args) => {
      refused.push(args)
      // The two hardware-monitor namespaces and the privileged root/WMI class
      // all refuse - which is what a normal user meets on a Windows laptop -
      // and only the performance counters answer, one line per thermal zone.
      if (args[3].indexOf('Win32_PerfFormattedData_Counters_ThermalZoneInformation') >= 0) {
        return { ok: true, stdout: '3010\r\n3025\r\n', stderr: '' }
      }
      return { ok: false, stdout: '', stderr: 'Access is denied. 拒绝访问' }
    },
    readdir: async () => [],
    readFile: async () => '',
    sleep: async () => {},
    platform: 'win32',
    gpu: false,
  })
  assert.equal(refused.length, 4, 'the performance counters are the last Windows source')
  assert.ok(refused[3][3].indexOf('root/cimv2') >= 0, 'they live in the ordinary cimv2 namespace')
  assert.equal(counters.temperature.celsius, 29.35, 'the hottest zone wins: 3025 tenths of kelvin')
  assert.equal(counters.temperature.source, 'acpi_perf', 'the source names the counters, not the WMI class')
  assert.equal(counters.temperature.reason, null, 'a counters reading is a real reading')
  console.log('  temperature: an unprivileged ACPI zone falls back to the performance counters')
}

// --------------------------------------------------- temperature caching

{
  resetDeviceCache()
  const calls = []
  const runCommand = async (command, args) => {
    calls.push(args)
    return { ok: true, stdout: '{"Name":"CPU Package","Value":58.25}', stderr: '' }
  }
  const options = {
    os: fakeOs({}),
    now: fakeClock(1792000000000),
    runCommand: runCommand,
    readdir: async () => [],
    readFile: async () => '',
    sleep: async () => {},
    platform: 'win32',
    gpu: false,
    temperatureTtlMs: 60000,
  }

  const first = await sampleDevice(options)
  assert.equal(first.temperature.celsius, 58.25, 'the first probe reads the sensor')
  assert.equal(first.temperature.source, 'lhm', 'the provider is LHM')
  const afterFirst = calls.length
  assert.ok(afterFirst >= 1, 'the first sample ran at least one command')

  options.now = fakeClock(1792000000000 + STEP_MS)
  const second = await sampleDevice(options)
  assert.equal(calls.length, afterFirst, 'inside the TTL no new command runs')
  assert.equal(second.temperature.celsius, 58.25, 'the cached verdict is reused')

  options.now = fakeClock(1792000000000 + 120000)
  const third = await sampleDevice(options)
  assert.ok(calls.length > afterFirst, 'past the TTL the probe runs again')
  assert.equal(third.temperature.celsius, 58.25, 'the refreshed verdict still parses')
  console.log('  temperature: TTL cache suppresses commands, expiry re-probes')
}

// ------------------------------------------- failing probe never throws

{
  resetDeviceCache()
  const runCommand = async () => { throw new Error('powershell disappeared') }
  const sample = await sampleDevice({
    os: fakeOs({}),
    now: fakeClock(1792000000000),
    runCommand: runCommand,
    readdir: async () => [],
    readFile: async () => '',
    sleep: async () => {},
    platform: 'win32',
  })

  assert.ok(sample, 'the sample still resolves when the probe throws')
  assert.equal(sample.temperature.celsius, null, 'a throwing probe yields no reading')
  assert.ok(['noSensor', 'error', 'permission', 'timeout', 'unsupported'].indexOf(sample.temperature.reason) >= 0,
    'the failure carries a reason code')
  assert.ok(sample.cpu.count >= 1, 'the cpu block is still populated')
  console.log('  failure: a throwing runCommand degrades to a reason, never a rejection')

  resetDeviceCache()
  const refused = await sampleDevice({
    os: fakeOs({}),
    now: fakeClock(1792000000000),
    runCommand: async () => ({ ok: false, stdout: '', stderr: 'Access is denied. 拒绝访问' }),
    readdir: async () => [],
    readFile: async () => '',
    sleep: async () => {},
    platform: 'win32',
  })
  assert.equal(refused.temperature.reason, 'noSensor',
    'every source refusing to answer still degrades to a reason')
  assert.equal(refused.temperature.celsius, null, 'and reports no temperature')
  console.log('  failure: an all-refused probe still yields a complete document')
}

// ------------------------------------------------ history ring buffer

{
  resetDeviceCache()
  const clock = fakeClock(1792000000000)
  const options = {
    os: fakeOs({}),
    now: clock,
    runCommand: async () => ({ ok: true, stdout: '{"Name":"CPU Package","Value":50}', stderr: '' }),
    readdir: async () => [],
    readFile: async () => '',
    sleep: async () => {},
    platform: 'linux',
    historyLimit: 3,
    temperatureTtlMs: 0,
  }

  // Four real samples, 2 s apart so each one clears the dedupe window. The cap
  // is 3, so the first must be gone and the other three must stay oldest-first.
  const times = [2000, 4000, 6000, 8000]
  const seen = []
  let last = null
  for (const offset of times) {
    options.now = fakeClock(1792000000000 + offset)
    last = await sampleDevice(options)
    seen.push(last.at)
  }
  assert.deepEqual(seen, [1792000002000, 1792000004000, 1792000006000, 1792000008000],
    'each sample reads the injected clock')
  assert.equal(last.history.length, 3, 'the ring buffer keeps exactly the limit')
  assert.deepEqual(last.history.map((entry) => entry.at), [seen[1], seen[2], seen[3]],
    'the first sample was dropped and the rest survive oldest-first')
  assert.ok(last.history[0].at < last.history[1].at && last.history[1].at < last.history[2].at,
    'history stays oldest-first')
  assert.equal(last.history[2].cpu.usage, last.cpu.usage, 'a history entry mirrors the live block')
  assert.equal(last.history[2].memory.total, last.memory.total, 'history carries memory too')
  assert.ok(last.history[2].temperature && 'celsius' in last.history[2].temperature, 'history carries temperature')
  console.log('  history: limit 3 drops the oldest, order is oldest-first')
}

// --------------------------------- first read, dedupe, periodic sampler

{
  resetDeviceCache()
  const clock = fakeClock(1792000000000)
  // The fixture advances on every read, so every delta below is a real one.
  let cpuReads = 0
  const os = fakeOs({ onCpus: () => { cpuReads += 1 } })
  const options = {
    os: os,
    now: clock,
    runCommand: async () => ({ ok: true, stdout: '{"Name":"CPU Package","Value":50}', stderr: '' }),
    readdir: async () => [],
    readFile: async () => '',
    sleep: async () => {},
    platform: 'linux',
  }

  // A fresh process has no earlier snapshot, so the sleep is observable.
  let slept = 0
  const first = await sampleDevice({ ...options, sleep: async (ms) => { slept += 1; return ms } })
  assert.equal(slept, 1, 'the first call waits once for a second CPU reading')
  assert.ok(cpuReads >= 2, 'the first call read os.cpus() at least twice for a real delta')
  const afterFirst = cpuReads
  assert.equal(first.sampleSeconds, 0, 'the first sample reports zero seconds')
  assert.equal(first.cpu.cores.length, 4, 'per-core usage is reported for every core')

  const duplicate = await sampleDevice(options)
  assert.equal(duplicate.at, first.at, 'a call inside the dedupe window returns the memoized sample')
  assert.equal(cpuReads, afterFirst, 'the dedupe window reads no CPU state')

  clock.advance(STEP_MS)
  const second = await sampleDevice(options)
  assert.ok(second.at > first.at, 'past the window a fresh sample is taken')
  assert.ok(second.sampleSeconds > 1, 'the second sample measures the elapsed window')
  assert.ok(cpuReads > afterFirst, 'a fresh sample reads the CPU counters again')
  console.log('  sampling: first-call double read, dedupe window and sampleSeconds')
}

{
  resetDeviceCache()
  const clock = fakeClock(1792000000000)
  const calls = []
  let tick = null
  let timeout = null
  let cleared = 0
  const sampleOptions = {
    os: fakeOs({}),
    now: clock,
    runCommand: async (command, args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' } },
    readdir: async () => [],
    readFile: async () => '',
    sleep: async () => {},
    platform: 'linux',
  }
  const stop = startDeviceSampler({
    ...sampleOptions,
    intervalMs: 15000,
    setInterval: (fn, ms) => { tick = fn; timeout = ms; return { unref() {} } },
    clearInterval: () => { cleared += 1; tick = null },
  })

  assert.equal(timeout, 15000, 'the periodic sampler uses the default cadence')
  assert.equal(typeof stop, 'function', 'startDeviceSampler returns a stop function')

  const ticks = tick
  assert.equal(typeof ticks, 'function', 'the interval was registered')

  // The cheap path taken on its own, before any tick.
  const explicit = await sampleDevice({ ...sampleOptions, temperature: false })
  assert.equal(explicit.temperature.reason, 'skipped', 'temperature:false skips the probe')
  assert.equal(explicit.temperature.celsius, null, 'and reports no temperature')
  assert.equal(explicit.temperature.source, null, 'and no temperature source')
  assert.equal(calls.length, 0, 'temperature:false spawns nothing')

  clock.advance(15000)
  await ticks()
  assert.equal(calls.length, 0, 'a periodic tick spawns no subprocess')

  // Let the tick's sample fall out of the dedupe window, then read the ring
  // buffer directly: it grew, so the tick really did take a sample.
  clock.advance(15000)
  await sampleDevice(sampleOptions)
  const ticked = (await sampleDevice(sampleOptions)).history[1]
  assert.ok(ticked, 'the tick left an entry in the ring buffer')
  assert.equal(ticked.at, 1792000000000 + 15000, 'the entry is stamped with the tick time')
  assert.equal(ticked.temperature.reason, 'skipped', 'the periodic tick kept its skip in history')
  assert.equal(ticked.temperature.celsius, null, 'the ticked entry reports no temperature')
  assert.equal(ticked.temperature.source, null, 'the ticked entry reports no source')
  assert.equal(calls.length, 0, 'no subprocess ran anywhere on the periodic path')
  console.log('  sampler: periodic tick performs no runCommand and reports skipped')

  stop()
  stop()
  assert.equal(cleared, 1, 'stop() clears the interval exactly once, so it is idempotent')
  assert.equal(tick, null, 'no tick survives stop()')
  console.log('  sampler: temperature:false skips the probe and stop() is idempotent')
}

// ---------------------------------------------------------------- gpu parse

{
  const parsed = parseGpuEngineName('pid_10148_luid_0x00000000_0x00016656_phys_0_eng_0_engtype_3D')
  assert.deepEqual(parsed, { luid: '0x00016656', engine: '3D' },
    'the luid is the second 0x group: not the pid, not the phys index')
  assert.equal(parseGpuEngineName('luid_0x00000000_0x00016656_phys_0'), null,
    'an adapter-memory instance carries no engine type')
  assert.equal(parseGpuEngineName('nonsense'), null, 'a foreign instance name is null')
  assert.equal(parseGpuEngineName(null), null, 'a missing name is null')
  assert.deepEqual(
    parseGpuEngineName('pid_7_luid_0x0000000A_0x0000ABCD_phys_0_eng_3_engtype_VideoDecode'),
    { luid: '0x0000abcd', engine: 'VideoDecode' },
    'the luid is case-folded so engine and memory rows share one key')
  console.log('  parseGpuEngineName: pid/luid/phys disambiguation, engine type, case folding')
}

{
  const rows = [
    { Name: 'pid_1_luid_0x00000000_0x000000AA_phys_0_eng_0_engtype_3D',
      UtilizationPercentage: 20 },
    { Name: 'pid_1_luid_0x00000000_0x000000AA_phys_0_eng_2_engtype_3D',
      UtilizationPercentage: 15 },
    { Name: 'pid_1_luid_0x00000000_0x000000AA_phys_0_eng_1_engtype_Copy',
      UtilizationPercentage: 10 },
    { Name: 'pid_1_luid_0x00000000_0x000000AA_phys_0_eng_3_engtype_Copy',
      UtilizationPercentage: 10 },
    { Name: 'pid_1_luid_0x00000000_0x000000AA_phys_0_eng_4_engtype_Copy',
      UtilizationPercentage: 10 },
    { Name: 'pid_1_luid_0x00000000_0x000000AA_phys_0_eng_5_engtype_Copy',
      UtilizationPercentage: 10 },
    { Name: 'pid_1_luid_0x00000000_0x000000AA_phys_0_eng_6_engtype_Copy',
      UtilizationPercentage: 10 },
    { Name: 'pid_1_luid_0x00000000_0x000000AA_phys_0_eng_7_engtype_Copy',
      UtilizationPercentage: 10 },
    { Name: 'pid_1_luid_0x00000000_0x000000AA_phys_0_eng_8_engtype_Copy',
      UtilizationPercentage: 10 },
    { Name: 'pid_1_luid_0x00000000_0x000000AA_phys_0_eng_9_engtype_Copy',
      UtilizationPercentage: 10 },
    { Name: 'pid_1_luid_0x00000000_0x000000AA_phys_0_eng_10_engtype_VideoDecode',
      UtilizationPercentage: 2 },
    { Name: 'pid_3_luid_0x00000000_0x000000BB_phys_0_eng_0_engtype_3D',
      UtilizationPercentage: 12 },
    { Name: 'pid_3_luid_0x00000000_0x000000BB_phys_0_eng_1_engtype_VideoDecode',
      UtilizationPercentage: 5 },
  ]
  const readings = gpuUsageByLuid(rows)
  assert.deepEqual(readings['0x000000aa'], { usage: 0.8, engine: 'Copy' },
    'eight Copy engines sum to 80 while a naive sum over every row would exceed 100')
  assert.deepEqual(readings['0x000000bb'], { usage: 0.12, engine: '3D' },
    'a second adapter is keyed by its own luid')
  assert.equal(readings['0x000000cc'], undefined, 'an adapter with no rows has no entry')
  assert.equal(gpuUsageByLuid([
    { Name: 'pid_9_luid_0x00000000_0x000000CC_phys_0_eng_0_engtype_3D',
      UtilizationPercentage: 140 },
  ])['0x000000cc'].usage, 1, 'a counter that overshoots is clamped to 1')
  assert.equal(gpuUsageByLuid([
    { Name: 'pid_9_luid_0x00000000_0x000000DD_phys_0_eng_0_engtype_3D',
      UtilizationPercentage: '7.5' },
  ])['0x000000dd'].usage, 0.075, 'a stringified counter is coerced')
  assert.deepEqual(gpuUsageByLuid([
    { Name: 'bad', UtilizationPercentage: 5 },
    { UtilizationPercentage: 5 },
    null,
  ]), {}, 'rows without a parseable luid are skipped, and so is a missing row')
  assert.deepEqual(gpuUsageByLuid(null), {}, 'a missing row list is an empty reading')
  console.log('  gpuUsageByLuid: per-engine summing, busiest engine, clamp and skipping')
}

{
  const blob = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\' +
    '{4d36e968-e325-11ce-bfc1-08002be10318}\\0000\r\n' +
    '    HardwareInformation.qwMemorySize    REG_QWORD    0x2fc300000\r\n\r\n'
  assert.equal(parseQwMemorySize(blob), 12820938752,
    'the hex QWORD is the real 12 GiB the 32-bit AdapterRAM cannot hold')
  assert.equal(parseQwMemorySize('    0x1000000000   '), 68719476736,
    'a 64 GiB value stays exact instead of overflowing')
  assert.equal(parseQwMemorySize('0X2FC300000'), 12820938752, 'an uppercase hex marker is accepted')
  assert.equal(parseQwMemorySize('    '), null, 'whitespace is not a value')
  assert.equal(parseQwMemorySize('no hex value here'), null, 'a blob without a value is null')
  assert.equal(parseQwMemorySize(null), null, 'a missing blob is null')
  console.log('  parseQwMemorySize: registry hex QWORD, exact above 4 GiB, invalid input')
}

{
  assert.deepEqual(parseGpuJson('{"engines":[],"memory":[]}'), { engines: [], memory: [] },
    'a compact JSON object parses')
  assert.deepEqual(parseGpuJson(JSON.stringify('{"engines":[]}')), { engines: [] },
    'a payload that arrived as a JSON string is unwrapped')
  assert.equal(parseGpuJson('not json'), null, 'malformed json is null')
  assert.equal(parseGpuJson(''), null, 'empty output is null')
  assert.equal(parseGpuJson(null), null, 'a missing payload is null')
  console.log('  parseGpuJson: compact object, double-encoded string, malformed input')
}

// ------------------------------------------------------------- gpu windows

/** The probe's payload, shaped like the JSON the RTX 5070 machine returned. */
const GPU_FIXTURE = {
  engines: [
    { Name: 'pid_10148_luid_0x00000000_0x00016656_phys_0_eng_0_engtype_3D',
      UtilizationPercentage: 0 },
    { Name: 'pid_10148_luid_0x00000000_0x00016656_phys_0_eng_0_engtype_3D',
      UtilizationPercentage: 23 },
    { Name: 'pid_900_luid_0x00000000_0x00022E07_phys_0_eng_1_engtype_Copy',
      UtilizationPercentage: 90 },
  ],
  memory: [
    { Name: 'luid_0x00000000_0x00022E07_phys_0', DedicatedUsage: 0, SharedUsage: 8192 },
    { Name: 'luid_0x00000000_0x00016656_phys_0', DedicatedUsage: 2265190400,
      SharedUsage: 84185088 },
  ],
  controllers: [
    { Name: 'GameViewer Virtual Display Adapter', PNPDeviceID: 'ROOT\\DISPLAY\\0000' },
    { Name: 'NVIDIA GeForce RTX 5070', PNPDeviceID: 'PCI\\VEN_10DE&DEV_2F04',
      AdapterRAM: 4293918720 },
  ],
  vram: [
    { key: '0000', text: '\r\n    HardwareInformation.qwMemorySize    REG_QWORD    ' +
      '0x2fc300000\r\n' },
    { key: '0001', text: '\r\n' },
  ],
}

/** The injected surface the GPU sections start from; override one field at a time. */
function gpuOptions(overrides = {}) {
  return {
    os: fakeOs({}),
    now: fakeClock(1792000000000),
    runCommand: async () => ({ ok: true, stdout: JSON.stringify(GPU_FIXTURE), stderr: '' }),
    readdir: async () => [],
    readFile: async () => '',
    sleep: async () => {},
    platform: 'win32',
    temperature: false,
    ...overrides,
  }
}

{
  resetDeviceCache()
  const calls = []
  const options = gpuOptions({
    runCommand: async (command, args, opts) => {
      calls.push({ command: command, args: args, opts: opts })
      return { ok: true, stdout: JSON.stringify(GPU_FIXTURE), stderr: '' }
    },
  })
  const sample = await sampleDevice(options)

  assert.equal(calls.length, 1, 'the whole GPU block costs exactly one PowerShell spawn')
  assert.equal(calls[0].command, 'powershell.exe', 'the probe runs through PowerShell')
  assert.deepEqual(calls[0].args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'],
    'a prompt-free, window-free invocation')
  const script = calls[0].args[3]
  assert.ok(script.indexOf('Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine') >= 0,
    'the engine counters are read')
  assert.ok(script.indexOf('Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory') >= 0,
    'the adapter memory counters are read')
  assert.ok(script.indexOf('Win32_VideoController') >= 0, 'the adapters are enumerated')
  assert.ok(script.indexOf('HardwareInformation.qwMemorySize') >= 0,
    'the driver registry key holds the real VRAM size')
  assert.ok(script.indexOf('ConvertTo-Json -Compress') >= 0, 'the payload is one compact document')
  assert.ok(script.indexOf('OutputEncoding') >= 0, 'utf8 is forced so adapter names survive')
  assert.equal(script.indexOf('"'), -1, 'no double quote can be mangled by an outer layer')
  assert.equal(calls[0].opts.timeout, 8000,
    'the GPU spawn outlives the 2.5s thermal budget, which clipped it on a real box')

  assert.equal(sample.gpu.name, 'NVIDIA GeForce RTX 5070', 'the virtual adapter is not the card')
  assert.equal(sample.gpu.vendor, 'nvidia', 'the vendor is named from the adapter name')
  assert.equal(sample.gpu.usage, 0.23, 'usage is a 0..1 ratio for the busiest engine type')
  assert.equal(sample.gpu.engine, '3D', 'the engine type that produced it')
  assert.equal(sample.gpu.memory.used, 2265190400, 'dedicated usage of the card that holds VRAM')
  assert.equal(sample.gpu.memory.total, 12820938752,
    'the registry QWORD beats the truncated AdapterRAM')
  assert.equal(sample.gpu.memory.usage, 0.1767, 'VRAM pressure is used/total')
  assert.equal(sample.gpu.reason, null, 'a reading that worked carries no reason')
  assert.equal(sample.temperature.reason, 'skipped', 'the rest of the document is untouched')
  console.log('  gpu: one windows spawn yields adapter, engine ratio and the real VRAM total')
}

{
  resetDeviceCache()
  const denied = await sampleDevice(gpuOptions({
    runCommand: async () => ({ ok: false, stdout: '', stderr: 'Access is denied. 拒绝访问' }),
  }))
  assert.equal(denied.gpu.reason, 'permission', 'a refused counter read is a permission reason')
  assert.equal(denied.gpu.name, '', 'no adapter is claimed when nothing was read')
  assert.equal(denied.gpu.usage, null, 'and there is no engine ratio')
  assert.equal(denied.gpu.memory.total, null, 'and no video memory')

  resetDeviceCache()
  const garbage = await sampleDevice(gpuOptions({
    runCommand: async () => ({ ok: true, stdout: 'not json at all', stderr: '' }),
  }))
  assert.equal(garbage.gpu.reason, 'noCounters', 'a payload that does not parse is noCounters')

  resetDeviceCache()
  const none = await sampleDevice(gpuOptions({
    runCommand: async () => ({
      ok: true,
      stdout: JSON.stringify({ engines: [], memory: [], controllers: [], vram: [] }),
      stderr: '',
    }),
  }))
  assert.equal(none.gpu.reason, 'noCounters', 'a machine with no video controller is noCounters')
  assert.equal(none.gpu.memory.total, null, 'and reports no memory')

  resetDeviceCache()
  const broken = await sampleDevice(gpuOptions({
    runCommand: async () => { throw new Error('spawn failed') },
  }))
  assert.equal(broken.gpu.reason, 'error', 'a probe that throws degrades instead of rejecting')
  assert.equal(broken.cpu.count, 4, 'and the rest of the document is still complete')
  assert.equal(broken.gpu.usage, null, 'with no engine ratio')
  console.log('  gpu: refused, malformed, empty and throwing probes all degrade with a reason')
}

{
  // No registry value at all: the 32-bit AdapterRAM is the only size there is.
  resetDeviceCache()
  const fallback = await sampleDevice(gpuOptions({
    runCommand: async () => ({
      ok: true,
      stdout: JSON.stringify({
        engines: [],
        memory: [
          { Name: 'luid_0x00000000_0x000000AA_phys_0', DedicatedUsage: 100, SharedUsage: 0 },
        ],
        controllers: [
          { Name: 'NVIDIA GeForce RTX 5070', PNPDeviceID: 'PCI\\VEN_10DE',
            AdapterRAM: 4293918720 },
        ],
        vram: [],
      }),
      stderr: '',
    }),
  }))
  assert.equal(fallback.gpu.memory.total, 4293918720,
    'without the registry value AdapterRAM is the fallback')
  assert.equal(fallback.gpu.memory.used, 100, 'dedicated usage comes from the counter row')
  assert.equal(fallback.gpu.usage, null, 'a card with no engine rows still reports its adapter')
  assert.equal(fallback.gpu.engine, null, 'and has no engine type to name')
  assert.equal(fallback.gpu.reason, null, 'the adapter was found, so there is no reason code')

  // A used counter with no total: the load is real, the pressure cannot be stated.
  resetDeviceCache()
  const partial = await sampleDevice(gpuOptions({
    runCommand: async () => ({
      ok: true,
      stdout: JSON.stringify({
        engines: GPU_FIXTURE.engines,
        memory: GPU_FIXTURE.memory,
        controllers: [{ Name: 'NVIDIA GeForce RTX 5070', PNPDeviceID: 'PCI\\VEN_10DE' }],
        vram: [],
      }),
      stderr: '',
    }),
  }))
  assert.equal(partial.gpu.memory.used, 2265190400, 'the used counter is still reported')
  assert.equal(partial.gpu.memory.total, null, 'an unknown total stays null')
  assert.equal(partial.gpu.memory.usage, null, 'so VRAM pressure cannot be computed')
  assert.equal(partial.gpu.usage, 0.23, 'but the engine ratio still works')

  // Only a virtual adapter answers: it is described, its VRAM is not attributed.
  resetDeviceCache()
  const virtualOnly = await sampleDevice(gpuOptions({
    runCommand: async () => ({
      ok: true,
      stdout: JSON.stringify({
        engines: [],
        memory: [],
        controllers: [
          { Name: 'GameViewer Virtual Display Adapter', PNPDeviceID: 'ROOT\\DISPLAY\\0000' },
        ],
        vram: [{ key: '0000', text: '    REG_QWORD    0x2fc300000\r\n' }],
      }),
      stderr: '',
    }),
  }))
  assert.equal(virtualOnly.gpu.name, 'GameViewer Virtual Display Adapter',
    'a machine with only a virtual display still names it')
  assert.equal(virtualOnly.gpu.vendor, '', 'an unrecognised vendor is empty, not a guess')
  assert.equal(virtualOnly.gpu.memory.total, null,
    'the registry value is not attributed to a virtual adapter')
  assert.equal(virtualOnly.gpu.reason, null, 'the adapter was found')
  console.log('  gpu: physical-card preference, AdapterRAM fallback and unknown VRAM')
}

// --------------------------------------------------------------- gpu other

{
  const files = {
    '/sys/class/drm/card0/device/gpu_busy_percent': '37\n',
    '/sys/class/drm/card0/device/mem_info_vram_used': '1073741824',
    '/sys/class/drm/card0/device/mem_info_vram_total': '8589934592',
  }
  const linuxBase = {
    os: fakeOs({}),
    now: fakeClock(1792000000000),
    runCommand: async () => { throw new Error('linux must not spawn a GPU probe') },
    readdir: async (path) => (path === '/sys/class/drm' ? ['card0', 'renderD128'] : []),
    readFile: async (path) => {
      if (path in files) return files[path]
      throw new Error('ENOENT')
    },
    sleep: async () => {},
    platform: 'linux',
    temperature: false,
  }

  resetDeviceCache()
  const sample = await sampleDevice(linuxBase)
  assert.equal(sample.gpu.usage, 0.37, 'sysfs reports 0..100 percent, the document a ratio')
  assert.equal(sample.gpu.memory.used, 1073741824, 'the vram used file is a byte count')
  assert.equal(sample.gpu.memory.total, 8589934592, 'and so is the total')
  assert.equal(sample.gpu.memory.usage, 0.125, 'pressure is used/total')
  assert.equal(sample.gpu.reason, null, 'a card that answered is a reading')
  assert.equal(sample.gpu.name, '', 'sysfs has no adapter name to offer')

  // A driver that publishes load but hides VRAM must not lose the load.
  resetDeviceCache()
  const busyOnly = await sampleDevice({
    ...linuxBase,
    readFile: async (path) => {
      if (path === '/sys/class/drm/card0/device/gpu_busy_percent') return '41\n'
      throw new Error('ENOENT')
    },
  })
  assert.equal(busyOnly.gpu.usage, 0.41, 'load is reported even when the driver hides VRAM')
  assert.equal(busyOnly.gpu.memory.total, null, 'with no total')
  assert.equal(busyOnly.gpu.memory.used, null, 'and no used value')

  resetDeviceCache()
  const noCards = await sampleDevice({ ...linuxBase, readdir: async () => [] })
  assert.equal(noCards.gpu.reason, 'unsupported', 'a tree with no card reports unsupported')
  assert.equal(noCards.gpu.usage, null, 'and no ratio')

  resetDeviceCache()
  const noTree = await sampleDevice({
    ...linuxBase,
    readdir: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
  })
  assert.equal(noTree.gpu.reason, 'unsupported', 'a machine without sysfs is unsupported')

  resetDeviceCache()
  const mac = await sampleDevice({
    ...linuxBase,
    platform: 'darwin',
    runCommand: async (command, args) => {
      assert.equal(command, 'system_profiler', 'macOS is asked through its own profiler')
      assert.deepEqual(args, ['SPDisplaysDataType', '-json'], 'in its JSON mode')
      return {
        ok: true,
        stderr: '',
        stdout: JSON.stringify({
          SPDisplaysDataType: [
            { _name: 'Apple M2 Pro', sppci_model: 'Apple M2 Pro', spdisplays_vram: '16 GB' },
          ],
        }),
      }
    },
  })
  assert.equal(mac.gpu.name, 'Apple M2 Pro', 'the profiler names the adapter')
  assert.equal(mac.gpu.usage, null, 'macOS publishes no utilization a normal user may read')
  assert.equal(mac.gpu.memory.total, 16 * 1024 ** 3, 'the VRAM string becomes a byte count')
  assert.equal(mac.gpu.memory.used, null, 'and there is no used figure to pair it with')
  assert.equal(mac.gpu.memory.usage, null, 'so no pressure is invented')
  assert.equal(mac.gpu.reason, null, 'a named adapter is an answer, not a missing source')

  resetDeviceCache()
  const headless = await sampleDevice({
    ...linuxBase,
    platform: 'darwin',
    runCommand: async () => ({ ok: true, stderr: '', stdout: '{"SPDisplaysDataType":[]}' }),
  })
  assert.equal(headless.gpu.reason, 'noCounters', 'a profiler with no adapter is noCounters')
  assert.equal(headless.gpu.name, '', 'and names nothing')
  console.log('  gpu: linux sysfs load/VRAM, missing tree, darwin profiler and headless mac')
}

// --------------------------------------------------------------- gpu nvidia

{
  const base = {
    os: fakeOs({}),
    now: fakeClock(1792000000000),
    readdir: async (path) => (path === '/sys/class/drm' ? ['card0'] : []),
    readFile: async (path) => {
      if (path === '/proc/driver/nvidia/version') return 'NVRM version: 570.86.16\n'
      throw new Error('ENOENT')
    },
    sleep: async () => {},
    platform: 'linux',
    temperature: false,
  }
  let spawned = 0
  const csv = [
    'NVIDIA GeForce RTX 5070, 23, 2160, 16376',
    'NVIDIA GeForce RTX 3060, 4, 512, 12288',
  ].join('\n')

  resetDeviceCache()
  const sample = await sampleDevice({
    ...base,
    runCommand: async (command, args) => {
      spawned += 1
      assert.equal(command, 'nvidia-smi', 'a driver with no sysfs counter is read by its tool')
      assert.ok(args[0].indexOf('--query-gpu=') === 0, 'the query lists fields, not a table')
      assert.equal(args[1], '--format=csv,noheader,nounits', 'CSV without units parses without widths')
      return { ok: true, stdout: csv, stderr: '' }
    },
  })
  assert.equal(spawned, 1, 'one spawn answers the whole block')
  assert.equal(sample.gpu.name, 'NVIDIA GeForce RTX 5070', 'the name comes with the query')
  assert.equal(sample.gpu.vendor, 'nvidia', 'the vendor is named')
  assert.equal(sample.gpu.usage, 0.23, 'utilization arrives as a 0..100 integer')
  assert.equal(sample.gpu.memory.used, 2160 * 1024 * 1024, 'MiB becomes bytes')
  assert.equal(sample.gpu.memory.total, 16376 * 1024 * 1024, 'and so does the total')
  assert.equal(sample.gpu.reason, null, 'a card that answered is a reading')

  // The gate is a file, not a guess: without the driver the tool is not spawned.
  resetDeviceCache()
  spawned = 0
  const noDriver = await sampleDevice({
    ...base,
    readFile: async () => { throw new Error('ENOENT') },
    runCommand: async () => { spawned += 1; throw new Error('nvidia-smi must not run') },
  })
  assert.equal(spawned, 0, 'a machine without /proc/driver/nvidia never spawns the tool')
  assert.equal(noDriver.gpu.reason, 'unsupported', 'and reports that the platform has no counters')

  // A driver present but a PATH that cannot see the binary is the shape of the
  // machine, not a defect, so ENOENT from the spawn is `unsupported`.
  resetDeviceCache()
  const missing = await sampleDevice({
    ...base,
    runCommand: async () => ({ ok: false, stdout: '', stderr: 'Error: spawn nvidia-smi ENOENT' }),
  })
  assert.equal(missing.gpu.reason, 'unsupported', 'a missing binary is not an error')

  resetDeviceCache()
  const refused = await sampleDevice({
    ...base,
    runCommand: async () => ({ ok: false, stdout: '', stderr: 'Access is denied.' }),
  })
  assert.equal(refused.gpu.reason, 'permission', 'a refused query keeps the permission reason')

  assert.deepEqual(parseNvidiaCsv('[N/A], [N/A], [N/A], [N/A]'), [],
    'a row with no real size cannot become a VRAM reading')
  assert.equal(parseNvidiaCsv('').length, 0, 'empty output is no rows')
  console.log('  gpu: nvidia-smi CSV, byte conversion, the /proc gate and its failure codes')
}

// ------------------------------------------------------- temperature hwmon

{
  const files = {
    '/sys/class/hwmon/hwmon1/name': 'acpitz\n',
    '/sys/class/hwmon/hwmon1/temp1_input': '27800\n',
    '/sys/class/hwmon/hwmon3/name': 'k10temp\n',
    '/sys/class/hwmon/hwmon3/temp1_input': '45000\n',
    '/sys/class/hwmon/hwmon3/temp3_input': '52000\n',
    '/sys/class/thermal/thermal_zone0/temp': '27800\n',
  }
  const base = {
    os: fakeOs({}),
    now: fakeClock(1792000000000),
    readdir: async (path) => {
      if (path === '/sys/class/hwmon') return ['hwmon1', 'hwmon3']
      if (path === '/sys/class/thermal') return ['thermal_zone0']
      return []
    },
    readFile: async (path) => {
      if (path in files) return files[path]
      throw new Error('ENOENT')
    },
    runCommand: async () => { throw new Error('linux must not spawn a temperature probe') },
    sleep: async () => {},
    platform: 'linux',
    gpu: false,
  }

  resetDeviceCache()
  const sample = await sampleDevice(base)
  assert.equal(sample.temperature.celsius, 52, 'the CPU chip wins over the ACPI zone')
  assert.equal(sample.temperature.source, 'hwmon', 'and the source says which tree answered')
  assert.equal(sample.temperature.reason, null, 'a real reading carries no reason')

  // A board sensor is not a CPU package: with no known chip the ACPI zone is
  // still better than nothing, so the reading falls back instead of losing the
  // temperature entirely.
  resetDeviceCache()
  const fallback = await sampleDevice({
    ...base,
    readdir: async (path) => {
      if (path === '/sys/class/hwmon') return ['hwmon1']
      if (path === '/sys/class/thermal') return ['thermal_zone0']
      return []
    },
  })
  assert.equal(fallback.temperature.celsius, 27.8, 'with no CPU chip the ACPI zone answers')
  assert.equal(fallback.temperature.source, 'thermal_zone', 'and is named as the fallback')

  resetDeviceCache()
  const none = await sampleDevice({ ...base, readdir: async () => [] })
  assert.equal(none.temperature.reason, 'unsupported', 'no tree at all is unsupported')
  console.log('  temperature: hwmon chip preference, ACPI fallback and an empty tree')
}

// ------------------------------------------------------------------ gpu cost

{
  resetDeviceCache()
  const clock = fakeClock(1792000000000)
  let probes = 0
  const options = gpuOptions({
    now: clock,
    gpuTtlMs: 5000,
    runCommand: async () => {
      probes += 1
      return { ok: true, stdout: JSON.stringify(GPU_FIXTURE), stderr: '' }
    },
  })
  const first = await sampleDevice(options)
  assert.equal(probes, 1, 'the first sample probes once')
  assert.equal(first.gpu.name, 'NVIDIA GeForce RTX 5070', 'and the block is filled')

  clock.advance(2000)
  const second = await sampleDevice(options)
  assert.equal(probes, 1, 'a poll inside gpuTtlMs reuses the reading')
  assert.equal(second.gpu.name, 'NVIDIA GeForce RTX 5070', 'with the same verdict')

  clock.advance(4000)
  const third = await sampleDevice(options)
  assert.equal(probes, 2, 'past the TTL the probe runs again')
  assert.equal(third.gpu.memory.total, 12820938752, 'the refreshed reading still parses')

  resetDeviceCache()
  await sampleDevice(options)
  assert.equal(probes, 3, 'resetDeviceCache() clears the GPU memo too')

  resetDeviceCache()
  const skipped = await sampleDevice({ ...options, gpu: false })
  assert.equal(probes, 3, 'gpu:false spawns nothing')
  assert.equal(skipped.gpu.reason, 'skipped', 'and says so')
  assert.equal(skipped.gpu.usage, null, 'with no ratio')
  assert.equal(skipped.gpu.memory.total, null, 'and no video memory')
  assert.equal(skipped.gpu.memory.used, null, 'and no used value')

  // The periodic tick takes that same cheap path on a Windows machine.
  resetDeviceCache()
  const tickClock = fakeClock(1792000000000)
  let tick = null
  const tickProbes = []
  const stop = startDeviceSampler(gpuOptions({
    now: tickClock,
    intervalMs: 15000,
    setInterval: (fn, ms) => {
      assert.equal(ms, 15000, 'the tick keeps the default cadence')
      tick = fn
      return { unref() {} }
    },
    clearInterval: () => { tick = null },
    runCommand: async (command, args) => {
      tickProbes.push(args)
      return { ok: true, stdout: JSON.stringify(GPU_FIXTURE), stderr: '' }
    },
  }))
  tickClock.advance(15000)
  await tick()
  // The tick's own sample is fired and not awaited, so let it land.
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(tickProbes.length, 0, 'a Windows warm-up tick spawns no subprocess at all')

  const ticked = await sampleDevice(gpuOptions({ now: tickClock }))
  assert.equal(ticked.gpu.reason, 'skipped', 'the tick recorded a skipped GPU block')
  assert.equal(ticked.history[ticked.history.length - 1].gpu.reason, 'skipped',
    'and the history entry carries the same skip')
  stop()
  console.log('  gpu: TTL cache, reset, gpu:false and the subprocess-free periodic tick')
}

// ------------------------------------------------------- probe sharing/cache

{
  // Two cards polling at the same instant must not pay for two subprocesses:
  // the sample in flight is handed to the second caller unchanged.
  resetDeviceCache()
  let probes = 0
  const options = gpuOptions({
    runCommand: async () => {
      probes += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { ok: true, stdout: JSON.stringify(GPU_FIXTURE), stderr: '' }
    },
  })
  const pair = await Promise.all([sampleDevice(options), sampleDevice(options)])
  assert.equal(probes, 1, 'two concurrent readers share the one GPU probe in flight')
  assert.equal(pair[0], pair[1], 'the second reader gets the same sample document')
  assert.equal(pair[0].gpu.usage, 0.23, 'and it is the real reading')
  console.log('  gpu: concurrent readers share one in-flight probe')
}

{
  // A broken or disabled counter provider used to spawn PowerShell on every
  // poll. The failure verdict is now cached, so the retry rate is bounded.
  resetDeviceCache()
  const clock = fakeClock(1792000000000)
  let probes = 0
  const options = gpuOptions({
    now: clock,
    runCommand: async () => {
      probes += 1
      return { ok: true, stdout: '', stderr: '' }
    },
  })
  const first = await sampleDevice(options)
  assert.equal(first.gpu.usage, null, 'an empty counter answer is a missing reading')
  clock.advance(10000)
  await sampleDevice(options)
  assert.equal(probes, 1, 'the failed verdict is reused inside the failure window')
  clock.advance(51000)
  await sampleDevice(options)
  assert.equal(probes, 2, 'after the failure window the probe is retried')

  // A working reading keeps its ordinary TTL (30s by default), so a fifteen
  // second poll reuses it instead of probing again.
  resetDeviceCache()
  const goodClock = fakeClock(1792000000000)
  let goodProbes = 0
  const good = gpuOptions({
    now: goodClock,
    runCommand: async () => {
      goodProbes += 1
      return { ok: true, stdout: JSON.stringify(GPU_FIXTURE), stderr: '' }
    },
  })
  await sampleDevice(good)
  goodClock.advance(15000)
  await sampleDevice(good)
  assert.equal(goodProbes, 1, 'a fifteen-second poll is served from the GPU cache')
  goodClock.advance(16000)
  await sampleDevice(good)
  assert.equal(goodProbes, 2, 'past thirty seconds the reading is refreshed')
  console.log('  gpu: failed verdicts back off for a minute, good ones for thirty seconds')
}

// ----------------------------------------------- stale-while-revalidate

{
  // A performance panel polls quickly without paying for the GPU probe on
  // every request: a stale verdict is served at once and the probe refreshes
  // it in the background. The first request (cold cache) is the only one that
  // waits.
  resetDeviceCache()
  const clock = fakeClock(1792000000000)
  const refreshed = JSON.parse(JSON.stringify(GPU_FIXTURE))
  refreshed.engines[0].UtilizationPercentage = 88
  refreshed.engines[1].UtilizationPercentage = 0
  let fixture = GPU_FIXTURE
  let probes = 0
  let deferred = false
  let release = null
  const options = gpuOptions({
    now: clock,
    runCommand: () => {
      probes += 1
      const body = { ok: true, stdout: JSON.stringify(fixture), stderr: '' }
      if (!deferred) return Promise.resolve(body)
      return new Promise((resolve) => { release = () => resolve(body) })
    },
  })

  const cold = await sampleDevice(options)
  assert.equal(cold.gpu.usage, 0.23, 'the cold sample waits once and gets a real reading')
  assert.equal(probes, 1, 'the cold sample pays for one probe')

  clock.advance(31000)
  fixture = refreshed
  deferred = true
  const stale = await sampleDevice(options)
  assert.equal(probes, 2, 'the stale poll starts a refresh')
  assert.equal(stale.gpu.usage, 0.23, 'but answers with the last verdict instead of waiting')
  assert.equal(typeof release, 'function', 'the refresh is actually in flight')

  release()
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
  clock.advance(1000)
  const fresh = await sampleDevice(options)
  assert.equal(fresh.gpu.usage, 0.88, 'the next poll reads the refreshed verdict')
  assert.equal(probes, 2, 'and does not start another probe')
  console.log('  gpu: stale-while-revalidate serves a fast poll without blocking on the probe')
}

// ------------------------------------------------------------- helpers

{
  resetDeviceCache()
  const sample = await sampleDevice({
    os: fakeOs({}),
    now: fakeClock(1792000000000),
    runCommand: async () => ({ ok: true, stdout: '', stderr: '' }),
    readdir: async () => [],
    readFile: async () => '',
    sleep: async () => {},
  })
  assert.equal(sample.system.platform, 'linux', 'the platform falls back to the injected os')
  assert.equal(sample.cpu.count, 4, 'the cpu count is the fixture length')
  assert.ok(sample.cpu.model.indexOf('Ryzen') >= 0, 'the cpu model is trimmed from the first core')
  assert.equal(sample.cpu.speedMhz, 3793, 'the clock speed is rounded')
  assert.deepEqual(sample.cpu.loadavg, [1.2, 1.1, 0.9], 'loadavg is passed through when the platform fills it')
  assert.equal(sample.cpu.cores.length, sample.cpu.count, 'cores and count agree')
  console.log('  sample: platform fallback, model, speed and loadavg shape')
}

/** A fixture clock: hand it around, advance it explicitly. */
function fakeClock(start) {
  let value = start
  const now = () => value
  now.advance = (ms) => { value += ms }
  return now
}

/** A JSON-encoded reading for a temperature far above any real machine. */
function floatOutOfRange() {
  return 20000 * 10
}

/**
 * A fake `os` surface with four cores.
 * @param spec - `total`/`free` memory bytes, `fixture` strings, and an `onCpus` hook.
 * @returns an object shaped like `node:os`.
 */
function fakeOs(spec = {}) {
  const fixture = spec.fixture || {}
  const cpus = [
    { model: 'AMD Ryzen 7 7840HS w/ Radeon 780M Graphics  ', speed: 3793,
      times: { user: 1000, nice: 0, sys: 500, idle: 5000, irq: 50 } },
    { model: 'AMD Ryzen 7 7840HS w/ Radeon 780M Graphics  ', speed: 3793,
      times: { user: 900, nice: 0, sys: 400, idle: 5500, irq: 40 } },
    { model: 'AMD Ryzen 7 7840HS w/ Radeon 780M Graphics  ', speed: 3793,
      times: { user: 800, nice: 0, sys: 300, idle: 6000, irq: 30 } },
    { model: 'AMD Ryzen 7 7840HS w/ Radeon 780M Graphics  ', speed: 3793,
      times: { user: 700, nice: 0, sys: 200, idle: 6500, irq: 20 } },
  ]
  return {
    // Each read advances the counters, so two reads describe a real window.
    cpus() {
      if (typeof spec.onCpus === 'function') spec.onCpus()
      return cpus.map((core) => ({
        model: core.model,
        speed: core.speed,
        times: {
          user: core.times.user += 100,
          nice: core.times.nice,
          sys: core.times.sys += 50,
          idle: core.times.idle += 100,
          irq: core.times.irq,
        },
      }))
    },
    totalmem: () => (spec.total === undefined ? 34359738368 : spec.total),
    freemem: () => (spec.free === undefined ? 12884901888 : spec.free),
    loadavg: () => [1.2, 1.1, 0.9],
    uptime: () => (fixture.uptime === undefined ? 98765 : fixture.uptime),
    platform: () => fixture.platform || 'linux',
    arch: () => fixture.arch || 'x64',
    release: () => fixture.release || '6.8.0-fixture',
    hostname: () => fixture.hostname || 'fixture-host',
  }
}

console.log('device-sampler: all assertions passed')
