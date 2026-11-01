/**
 * Card module: Network environment: the proxy in force, TLS variables and redirectors.
 *
 * Spliced into the client factory by scripts/build-client.mjs, inside
 * `(function (kit) { ... })(Kit)`, so this file may assume `kit` is in scope.
 * It defines and registers itself — adding a card is adding this file.
 *
 * @module dsh-homepage/cards/network
 */

    var h = kit.h
    var React = kit.React
    var UI = kit.UI
    var ICONS = kit.ICONS
    var runtime = kit.runtime
    var defineCard = kit.defineCard
    var dict = kit.dict
    var useRemote = kit.useRemote
    var useClock = kit.useClock
    var useAnnounce = kit.useAnnounce
    var remoteCall = kit.remoteCall
    var requestReload = kit.requestReload
    var publishReloader = kit.publishReloader
    var pushToast = kit.pushToast
    var currencySymbol = kit.currencySymbol
    var primaryWallet = kit.primaryWallet
    var dayKey = kit.dayKey
    var kv = kit.kv

    // -------------------------------------------------------- clipboard

    /** Copy text to the clipboard, falling back to a hidden textarea. */
    function copyText(text, label) {
      var value = String(text)
      var done = function () { pushToast((label || '') + value) }
      var fallback = function () {
        try {
          var area = document.createElement('textarea')
          area.value = value
          area.setAttribute('readonly', 'readonly')
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          document.execCommand('copy')
          document.body.removeChild(area)
          done()
        } catch (error) { pushToast(runtime.t('common.copyFailed'), 'error') }
      }
      try {
        // navigator.clipboard needs a secure context: the documented deployment
        // is http on a LAN address, where it is absent, so the textarea path is
        // the normal one there rather than the exceptional one.
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(value).then(done, fallback)
          return
        }
      } catch (error) { void error }
      fallback()
    }

    // =========================================================== 3. network

    /** The compact network card: the proxy in force, or a direct verdict. */
    function NetworkCard(props) {
      var t = props.t
      var api = props.api
      var remote = useRemote('homepage/environment', {}, { refreshMs: 300000 })
      var data = remote.data
      var error = remote.error
      React.useEffect(function () {
        return publishReloader('network', function () { void remote.reload(false) })
      }, [remote.reload])
      var proxies = data ? (data.proxies || []).filter(function (entry) { return entry.kind === 'proxy' }) : []
      var primary = proxies.length > 0 ? proxies[0] : null
      var target = primary ? (primary.host || primary.masked) + (primary.port ? ':' + primary.port : '') : null
      // Only a real failure is worth the user's attention: a proxy in force is
      // what the card is for, and masked credentials are not a problem.
      useAnnounce(api, 'network',
        error ? { level: 'error', text: t('network.notice.unavailable', { reason: error }) } : null)
      if (error) return h('div', null, h(UI.Chip, { tone: 'error' }, t('common.error')), h('p', { className: 'ph-inline-empty' }, error))
      if (!data) return h('div', { className: 'ph-hero ph-hero--wait' }, h('span', { className: 'ph-hero-value' }, '—'))
      // The preview answers only "what is my traffic going through": the proxy
      // endpoint and whether it needs credentials. Every variable, the TLS list
      // and the raw spelling live in `NetworkDetail`.
      if (!primary) {
        return h('div', { className: 'ph-hero' },
          h('span', { className: 'ph-hero-value ph-hero-value--ok' }, t('network.direct')),
          h('span', { className: 'ph-hero-label' }, t('network.proxy')),
        )
      }
      return h('div', { className: 'ph-hero' },
        h('span', { className: 'ph-hero-value ph-hero-value--mono' }, (primary.host || primary.masked) + (primary.port ? ':' + primary.port : '')),
        h('div', { className: 'ph-hero-row' },
          h('span', { className: 'ph-hero-label' }, primary.name),
          h(UI.Chip, { tone: primary.hasAuth ? 'warn' : 'ok' }, (primary.protocol || 'http') + (primary.hasAuth ? ' · auth' : '')),
        ),
      )
    }

    /** The expanded network page: every proxy variable, TLS vars and runtime facts. */
    function NetworkDetail(props) {
      var t = props.t
      var api = props.api
      var reveal = api.control('reveal') === true
      var showTls = api.control('tls') !== false
      var view = api.control('view') || 'table'
      var remote = useRemote('homepage/environment', {}, { refreshMs: 0 })
      var data = remote.data
      var error = remote.error
      React.useEffect(function () {
        return publishReloader('network', function () { void remote.reload(false) })
      }, [remote.reload])
      if (error) return h('div', { className: 'ph-detail-block' }, h('div', { className: 'ph-card-error' }, h('strong', null, t('common.error')), h('code', null, error)))
      if (!data) return h('div', { className: 'ph-detail-block' }, h('p', { className: 'ph-inline-empty' }, t('common.refresh') + '…'))

      var proxies = (data.proxies || []).filter(function (entry) { return entry.kind === 'proxy' })
      var bypass = (data.proxies || []).filter(function (entry) { return entry.kind === 'bypass' })
      var textValue = function (entry) { return reveal ? entry.raw : entry.masked }

      return h('div', { className: 'ph-detail-block' },
        h('div', { className: 'ph-section-head' },
          h('h4', null, t('network.variables')),
          h('span', { className: 'ph-head-spacer' }),
          h(UI.ComboButton, {
            label: t('common.copy'),
            value: reveal ? 'raw' : 'masked',
            options: [{ value: 'masked', label: t('common.copy') }, { value: 'raw', label: t('common.copyRaw') }],
            onRun: function (value) {
              var payload = proxies.map(function (entry) { return entry.name + '=' + (value === 'raw' ? entry.raw : entry.masked) }).join('\n')
              copyText(payload, t('common.copied') + '\n')
            },
          }),
        ),
        proxies.length === 0
          ? h('p', { className: 'ph-inline-empty' }, t('network.noProxies'))
          : view === 'text'
            ? h('pre', { className: 'ph-pre' }, proxies.map(function (entry) { return entry.name + '=' + textValue(entry) }).join('\n'))
            : h('div', { className: 'ph-table' },
              h('div', { className: 'ph-table-row ph-table-head' },
                h('span', null, t('network.spellings')), h('span', null, t('network.value')),
                h('span', null, t('network.host')), h('span', null, t('network.port')), h('span', null, t('network.protocol')),
              ),
              proxies.map(function (entry) {
                return h('div', { className: 'ph-table-row', key: entry.name },
                  h('span', { className: 'ph-table-name', title: (entry.spellings || []).join(', ') },
                    entry.name, entry.hasAuth ? h(UI.Chip, { tone: 'warn', title: t('network.authHint') }, 'auth') : null),
                  h('span', { className: 'ph-mono ph-break', title: entry.raw }, textValue(entry)),
                  h('span', { className: 'ph-mono' }, entry.host || '—'),
                  h('span', { className: 'ph-mono' }, entry.port === null || entry.port === undefined ? '—' : String(entry.port)),
                  h('span', { className: 'ph-mono' }, entry.protocol || '—'),
                )
              }),
            ),
        bypass.length > 0 ? h('div', null,
          h(UI.Divider, null),
          h('h4', { className: 'ph-section-title' }, t('network.bypass')),
          h('pre', { className: 'ph-pre' }, bypass.map(function (entry) { return entry.name + '=' + entry.raw }).join('\n')),
        ) : null,
        (data.redirectors || []).length > 0 ? h('div', null,
          h(UI.Divider, null),
          h('h4', { className: 'ph-section-title' }, t('network.redirectors')),
          h('div', { className: 'ph-kv' }, data.redirectors.map(function (entry) {
            return h('div', { className: 'ph-kv-row', key: entry.name },
              h('span', { className: 'ph-kv-key' }, entry.name),
              h('span', { className: 'ph-kv-value ph-mono ph-break' }, entry.value),
            )
          })),
        ) : null,
        showTls && (data.tls || []).length > 0 ? h('div', null,
          h(UI.Divider, null),
          h('h4', { className: 'ph-section-title' }, t('network.tls')),
          h('div', { className: 'ph-kv' }, data.tls.map(function (entry) {
            return h('div', { className: 'ph-kv-row', key: entry.name },
              h('span', { className: 'ph-kv-key' }, entry.name),
              h('span', { className: 'ph-kv-value ph-mono ph-break' }, entry.value),
            )
          })),
        ) : null,
        h(UI.Divider, null),
        h('div', { className: 'ph-kv' },
          kv(t('network.platform'), data.platform + ' · ' + data.arch),
          kv(t('network.node'), data.node),
          kv(t('network.cwd'), data.cwd),
          kv(t('network.dshHome'), data.dshHome),
        ),
      )
    }
      defineCard({
        id: 'network',
        shipped: true,
        order: 30,
        title: function () { return runtime.t('card.network.title') },
        icon: 'network',
        size: { w: 2, h: 1 },
        minSize: { w: 1, h: 1 },
        maxSize: { w: 4, h: 3 },
        accent: '#d29922',
        texture: true,
        effects: { outline: 'outline', sheen: false, ripple: false, float: false },
        content: function (api) { return h(NetworkCard, { api: api, t: runtime.t }) },
        detail: function (api) { return h(NetworkDetail, { api: api, t: runtime.t }) },
        detailActions: [
          {
            id: 'view', type: 'segmented', label: function () { return runtime.t('network.view') }, value: 'table',
            options: [
              { value: 'table', label: function () { return runtime.t('network.viewTable') } },
              { value: 'text', label: function () { return runtime.t('network.viewText') } },
            ],
          },
          { id: 'reveal', type: 'switch', label: function () { return runtime.t('network.reveal') }, value: false },
          { id: 'tls', type: 'switch', label: function () { return runtime.t('network.showTls') }, value: true },
          {
            id: 'refresh', type: 'combo', label: function () { return runtime.t('common.refresh') }, value: 'now',
            options: [{ value: 'now', label: function () { return runtime.t('common.refresh') } }],
            run: function () { requestReload('network', false) },
          },
        ],
      })

    dict({
      zh: {
        'card.network.title': '网络环境',
        'network.direct': '直连',
        'network.proxy': '代理',
        'network.variables': '代理变量',
        'network.bypass': '直连白名单',
        'network.redirectors': '其他转发',
        'network.tls': '证书变量',
        'network.platform': '运行环境',
        'network.host': '主机',
        'network.port': '端口',
        'network.protocol': '协议',
        'network.spellings': '变量名',
        'network.value': '值',
        'network.reveal': '显示凭据',
        'network.showTls': '证书变量',
        'network.view': '视图',
        'network.viewTable': '表格',
        'network.viewText': '文本',
        'network.authHint': '含凭据（默认掩码）',
        'network.noProxies': '没有设置 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY。',
        'network.notice.unavailable': '读不到进程环境：{reason}',
        'network.cwd': '工作目录',
        'network.node': 'Node',
        'network.dshHome': 'DSH_HOME',
      },
      en: {
        'card.network.title': 'Network',
        'network.direct': 'Direct',
        'network.proxy': 'Proxy',
        'network.variables': 'Proxy variables',
        'network.bypass': 'Bypass list',
        'network.redirectors': 'Other redirectors',
        'network.tls': 'Certificate variables',
        'network.platform': 'Runtime',
        'network.host': 'Host',
        'network.port': 'Port',
        'network.protocol': 'Scheme',
        'network.spellings': 'Names',
        'network.value': 'Value',
        'network.reveal': 'Reveal credentials',
        'network.showTls': 'Certificate vars',
        'network.view': 'View',
        'network.viewTable': 'Table',
        'network.viewText': 'Text',
        'network.authHint': 'Carries credentials (masked)',
        'network.noProxies': 'No HTTP_PROXY / HTTPS_PROXY / ALL_PROXY is set.',
        'network.notice.unavailable': 'Cannot read the process environment: {reason}',
        'network.cwd': 'Working dir',
        'network.node': 'Node',
        'network.dshHome': 'DSH_HOME',
      },
    })
