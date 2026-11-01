/**
 * Card module: Device performance — processor, memory, storage and temperature.
 *
 * Spliced into the client factory by scripts/build-client.mjs, inside
 * `(function (kit) { ... })(Kit)`, so this file may assume `kit` is in scope.
 * It defines and registers itself — adding a card is adding this file.
 *
 * The readings come from the host half (`homepage/device`), which samples
 * them inside the host process: a browser cannot see them, and the numbers are
 * about the machine the host runs on rather than the one drawing the panel.
 *
 * @module dsh-homepage/cards/device
 */

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
