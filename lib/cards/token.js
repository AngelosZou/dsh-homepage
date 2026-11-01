/**
 * Card module: Token usage: balance, today’s spend, history, wallet and account links.
 *
 * Spliced into the client factory by scripts/build-client.mjs, inside
 * `(function (kit) { ... })(Kit)`, so this file may assume `kit` is in scope.
 * It defines and registers itself — adding a card is adding this file.
 *
 * @module dsh-homepage/cards/token
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

    // ============================================================ 1. tokens

    var TOKEN_LOW_BALANCE = 5

    /**
     * The account notice, called by both the preview and the expanded body.
     *
     * It is a hook rather than an element so the bubble survives the switch
     * between the two views: the level is derived from the data, not from which
     * view happens to be on screen. Returns nothing.
     */
    /**
     * The token card's notice is an annunciator: it speaks only when the user
     * has a reason to act (signed out, unreachable, low balance) and retracts
     * itself once that is no longer true. A healthy balance is not news.
     */
    function useTokenNotice(api, t, data, error) {
      var wallet = primaryWallet(data)
      var amount = wallet ? currencySymbol(wallet.currency) + wallet.balance : null
      var notice = null
      if (error) {
        var signedOut = Boolean(data && data.error && data.error.reason === 'signed-out')
        notice = {
          level: signedOut ? 'warn' : 'error',
          text: signedOut ? t('token.notice.signedOut') : t('token.notice.unavailable', { reason: error }),
        }
      } else if (wallet && Number(wallet.balance) < TOKEN_LOW_BALANCE) {
        notice = { level: 'warn', text: t('token.notice.low', { amount: amount }) }
      }
      useAnnounce(api, 'token', notice)
    }

    /**
     * The compact token card.
     *
     * The card's job is to answer "how much is left and what did today cost", so
     * the preview is two numbers and nothing else: no ranges, no switches, no
     * percentages. Everything adjustable lives in `TokenDetail`.
     */
    function TokenCard(props) {
      var api = props.api
      var t = props.t
      var days = api.control('days') || 14
      var remote = useRemote('homepage/overview', { options: { historyDays: days } }, { refreshMs: 90000 })
      var data = remote.data
      var error = remote.error || (data && data.error ? data.error.message : null)
      var wallet = primaryWallet(data)
      var amount = wallet ? currencySymbol(wallet.currency) + wallet.balance : null

      React.useEffect(function () {
        return publishReloader('token', function (force) {
          void remote.reload(false)
          if (force) void remoteCall('homepage/refresh', {}).then(function () { void remote.reload(true) }).catch(function () {})
        })
      }, [remote.reload])

      useTokenNotice(api, t, data, error)

      if (!data && !error) {
        return h('div', { className: 'ph-hero ph-hero--wait' }, h('span', { className: 'ph-hero-value' }, '—'))
      }
      if (!wallet && error) {
        return h('div', { className: 'ph-hero ph-hero--wait' },
          h('span', { className: 'ph-hero-value' }, '—'),
          h('span', { className: 'ph-hero-label ph-hero-label--error' },
            data && data.account && data.account.status === 'signed-out' ? t('token.signedOut') : t('token.unavailable')),
        )
      }
      var today = data.today || {}
      return h('div', { className: 'ph-hero' },
        h('div', { className: 'ph-hero-main' },
          h('span', { className: 'ph-hero-value ph-hero-value--accent' }, amount || '—'),
          h('span', { className: 'ph-hero-label' }, t('token.balance')),
        ),
        h('div', { className: 'ph-hero-side' },
          h('span', { className: 'ph-hero-value ph-hero-value--sm' }, currencySymbol(today.currency) + (today.spend || '0.00')),
          h('span', { className: 'ph-hero-label' }, t('token.today')),
        ),
      )
    }

    // Detail-only styling leaves the compact card and the shared focus chrome alone.
    var tokenStylesReady = false
    function ensureTokenStyles() {
      if (tokenStylesReady || typeof runtime.insertCss !== 'function') return
      runtime.insertCss([
        '.ph-token-detail{--ph-token-tint:color-mix(in srgb,var(--dsw-alias-brand-primary,#2b5cff) 7%,var(--dsw-alias-bg-layer-1,#fff));width:100%;gap:16px}',
        '.ph-token-detail .ph-token-hero{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
        '.ph-token-hero>.ph-stat{padding:20px 22px;border-radius:18px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-2,#f6f7f9);gap:6px}',
        '.ph-token-hero>.ph-stat:first-child{background:var(--ph-token-tint);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#2b5cff) 22%,var(--dsw-alias-border-l2,#e5e7eb))}',
        '.ph-token-hero .ph-stat-value{font-size:clamp(28px,4vw,42px);line-height:1.15;letter-spacing:-.04em;font-weight:700;white-space:normal;overflow-wrap:anywhere}',
        '.ph-token-hero>.ph-stat:first-child .ph-stat-value{color:var(--dsw-alias-brand-primary,#2b5cff)}',
        '.ph-token-detail .ph-stat-label{font-size:12px;white-space:normal}',
        '.ph-token-detail .ph-stat-hint{font-size:11px;overflow-wrap:anywhere}',
        '.ph-token-panel{display:flex;flex-direction:column;gap:14px;padding:18px 20px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:16px;background:var(--dsw-alias-bg-layer-1,#fff);min-width:0}',
        '.ph-token-detail .ph-section-head{flex-wrap:wrap}.ph-token-detail .ph-section-head h4,.ph-token-detail .ph-section-title{font-size:14px;letter-spacing:-.01em}',
        '.ph-token-detail .ph-token-facts{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding:12px 14px;border-radius:11px;background:var(--dsw-alias-bg-layer-2,#f6f7f9)}',
        '.ph-token-facts .ph-stat{gap:4px}.ph-token-facts .ph-stat-value{font-size:20px;letter-spacing:-.02em}',
        '.ph-token-detail .ph-axis{font-size:11px;gap:10px;flex-wrap:wrap}',
        '.ph-token-detail .ph-kv-row{padding:10px 0}.ph-token-detail .ph-kv-key{flex:1;font-size:12px}.ph-token-detail .ph-kv-value{flex:1;text-align:right;font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}',
        '.ph-token-detail .ph-links{margin:0;gap:8px}.ph-token-detail .ph-link{padding:7px 12px;border-radius:9px;background:var(--ph-token-tint);text-decoration:none;transition:background .15s}',
        '.ph-token-detail .ph-link:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2b5cff) 14%,var(--dsw-alias-bg-layer-1,#fff))}.ph-token-detail .ph-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2b5cff);outline-offset:3px}',
        '@media(max-width:540px){.ph-token-detail{gap:12px}.ph-token-hero>.ph-stat{padding:16px 14px;border-radius:13px}.ph-token-hero .ph-stat-value{font-size:28px}.ph-token-panel{padding:14px}.ph-token-detail .ph-token-facts{gap:10px;padding:12px}.ph-token-facts .ph-stat-value{font-size:17px}.ph-token-detail .ph-section-head .ph-head-spacer{display:none}}',
        '@media(prefers-reduced-motion:reduce){.ph-token-detail .ph-link{transition:none}}',
      ].join(''))
      tokenStylesReady = true
    }

    /** The expanded token page: history chart and wallets. */
    function TokenDetail(props) {
      ensureTokenStyles()
      var api = props.api
      var t = props.t
      var days = api.control('days') || 14
      var showBonus = api.control('bonus') === true
      var remote = useRemote('homepage/overview', { options: { historyDays: days } }, { refreshMs: 120000 })
      var data = remote.data
      var error = remote.error || (data && data.error ? data.error.message : null)
      React.useEffect(function () {
        return publishReloader('token', function (force) {
          void remote.reload(false)
          if (force) void remoteCall('homepage/refresh', {}).then(function () { void remote.reload(true) }).catch(function () {})
        })
      }, [remote.reload])

      useTokenNotice(api, t, data, error)

      if (!data) {
        return h('div', { className: 'ph-detail-block' },
          error
            ? h('div', { className: 'ph-card-error' }, h('strong', null, t('common.error')), h('code', null, error))
            : h('p', { className: 'ph-inline-empty' }, t('common.refresh') + '…'),
        )
      }
      var history = Array.isArray(data.history) ? data.history.slice().reverse() : []
      var today = data.today || {}
      var sum = history.reduce(function (total, day) { return total + Number(day.spend || 0) }, 0)
      var peak = history.reduce(function (best, day) { return Number(day.spend) > Number(best.spend || 0) ? day : best }, { spend: '0' })
      var wallet = primaryWallet(data)
      var links = accountLinks(data.account && data.account.links, t)
      return h('div', { className: 'ph-detail-block ph-token-detail' },
        h('div', { className: 'ph-detail-stats ph-token-hero' },
          h(UI.Stat, { label: t('token.balance'), value: wallet ? currencySymbol(wallet.currency) + wallet.balance : '—' }),
          h(UI.Stat, { label: t('token.today'), value: currencySymbol(today.currency) + (today.spend || '0.00'), hint: today.open && today.last ? today.open + ' → ' + today.last : null }),
        ),
        h('section', { className: 'ph-token-panel', 'aria-label': t('token.history') },
        h('div', { className: 'ph-section-head' },
          h('h4', null, t('token.history')),
          h('span', { className: 'ph-head-spacer' }),
          today.partial ? h(UI.Chip, { tone: 'warn' }, t('token.partial')) : null,
        ),
        h('div', { className: 'ph-detail-stats ph-token-facts' },
          h(UI.Stat, { label: t('token.sum', { count: history.length }), value: currencySymbol(today.currency) + sum.toFixed(2) }),
          h(UI.Stat, { label: t('token.avg'), value: currencySymbol(today.currency) + (history.length ? (sum / history.length).toFixed(2) : '0.00') }),
          h(UI.Stat, { label: t('token.peak'), value: currencySymbol(today.currency) + (peak.spend || '0.00'), hint: peak.day || null }),
        ),
        history.length === 0
          ? h('p', { className: 'ph-inline-empty' }, t('token.noHistory'))
          : h(UI.Bars, {
            height: 120,
            values: history.map(function (day, index) {
              var currency = currencySymbol(day.currency || today.currency)
              return {
                value: Number(day.spend || 0),
                highlight: index === history.length - 1,
                title: day.day + '  ' + currency + (day.spend || '0.00') + (day.partial ? '  (' + t('token.partial') + ')' : ''),
              }
            }),
          }),
        h('div', { className: 'ph-axis' },
          h('span', null, history.length > 0 ? history[0].day : ''),
          h('span', { className: 'ph-head-spacer' }),
          h('span', null, history.length > 0 ? history[history.length - 1].day : ''),
        ),
        ),
        h('section', { className: 'ph-token-panel', 'aria-label': t('token.wallets') },
        h('h4', { className: 'ph-section-title' }, t('token.wallets')),
        h('div', { className: 'ph-kv' },
          (data.wallets || []).map(function (entry) {
            return h('div', { className: 'ph-kv-row', key: 'w' + entry.currency },
              h('span', { className: 'ph-kv-key' }, entry.currency),
              h('span', {
                className: 'ph-kv-value',
                title: entry.raw && entry.raw !== entry.balance ? entry.raw : null,
              }, currencySymbol(entry.currency) + entry.balance),
            )
          }),
          showBonus ? (data.bonusWallets || []).map(function (entry) {
            return h('div', { className: 'ph-kv-row', key: 'b' + entry.currency },
              h('span', { className: 'ph-kv-key' }, t('token.bonus') + ' · ' + entry.currency),
              h('span', {
                className: 'ph-kv-value',
                title: entry.raw && entry.raw !== entry.balance ? entry.raw : null,
              }, currencySymbol(entry.currency) + entry.balance),
            )
          }) : null,
          (data.wallets || []).length === 0 ? h('p', { className: 'ph-inline-empty' }, t('token.unavailable')) : null,
        ),
        error ? h('div', null,
          h(UI.Divider, null),
          h('div', { className: 'ph-kv' },
            h('div', { className: 'ph-kv-row' },
              h('span', { className: 'ph-kv-key' }, t('common.error')),
              h('span', { className: 'ph-kv-value', style: { color: 'var(--dsw-alias-state-error-primary,#e5484d)' } }, error),
            ),
          ),
        ) : null,
        links.length > 0 ? h('div', { className: 'ph-links' }, links.map(function (link) {
          return h('a', { className: 'ph-link', key: link.href, href: link.href, target: '_blank', rel: 'noreferrer' }, link.label)
        })) : null,
        ),
      )
    }

    /** @returns up to two `{ label, href }` account links found on the account view. */
    function accountLinks(links, t) {
      if (!links || typeof links !== 'object') return []
      var out = []
      Object.keys(links).forEach(function (key) {
        var value = links[key]
        if (typeof value !== 'string' || !/^https?:\/\//.test(value)) return
        var lower = key.toLowerCase()
        var label = lower.indexOf('top') >= 0 || lower.indexOf('recharge') >= 0
          ? t('token.link.topUp')
          : lower.indexOf('usage') >= 0 || lower.indexOf('billing') >= 0 ? t('token.link.usage') : key
        out.push({ label: label, href: value })
      })
      return out.slice(0, 2)
    }

      defineCard({
        id: 'token',
        shipped: true,
        order: 10,
        title: function () { return runtime.t('card.token.title') },
        icon: 'token',
        size: { w: 2, h: 1 },
        minSize: { w: 1, h: 1 },
        maxSize: { w: 4, h: 3 },
        accent: '#2b5cff',
        texture: true,
        // No explicit background: the default material is a flat wash tinted by
        // `accent`, which keeps every card the same material instead of three
        // different ones.
        // No sheen either: it is a diagonal band of light, which is a gradient —
        // the one thing the art direction ruled out. It stays available per card
        // from the effect picker; it is just not on by default.
        effects: { outline: 'glow', sheen: false, spotlight: true, ripple: false, float: false },
        refreshMs: 90000,
        content: function (api) { return h(TokenCard, { api: api, t: runtime.t }) },
        detail: function (api) { return h(TokenDetail, { api: api, t: runtime.t }) },
        // Nothing here is a control: the token card's whole job is to be read,
        // so its three settings appear only once the card is expanded.
        detailActions: [
          {
            id: 'days', type: 'segmented', label: function () { return runtime.t('token.range') },
            value: 14,
            options: [
              { value: 7, label: '7' }, { value: 14, label: '14' }, { value: 30, label: '30' },
            ],
          },
          { id: 'bonus', type: 'switch', label: function () { return runtime.t('token.showBonus') }, value: false },
          {
            id: 'refresh', type: 'combo', label: function () { return runtime.t('common.refresh') }, value: 'sample',
            options: [
              { value: 'sample', label: function () { return runtime.t('common.refresh') } },
              { value: 'force', label: function () { return runtime.t('common.force') } },
            ],
            run: function (value) { requestReload('token', value === 'force') },
          },
        ],
      })

    dict({
      zh: {
        'card.token.title': 'Token 统计',
        'token.today': '今日消费',
        'token.balance': '余额',
        'token.bonus': '赠送余额',
        'token.range': '统计范围',
        'token.showBonus': '赠送余额',
        'token.history': '每日消费',
        'token.partial': '区间可能不完整',
        'token.sum': '{count} 天合计',
        'token.avg': '日均',
        'token.peak': '最高一天',
        'token.wallets': '账户钱包',
        'token.unavailable': '账户服务未挂载',
        'token.signedOut': '未登录 DeepSeek 账户',
        'token.noHistory': '还没有历史记录，采样几次之后这里会出现趋势图。',
        'token.notice.low': '余额偏低：{amount}',
        'token.notice.unavailable': '读不到账户余额：{reason}',
        'token.notice.signedOut': '未登录 DeepSeek 账户，无法读取余额。',
        'token.link.usage': '用量明细',
        'token.link.topUp': '充值',
      },
      en: {
        'card.token.title': 'Token usage',
        'token.today': 'Spent today',
        'token.balance': 'Balance',
        'token.bonus': 'Bonus balance',
        'token.range': 'Range',
        'token.showBonus': 'Bonus balance',
        'token.history': 'Daily spend',
        'token.partial': 'Window may be incomplete',
        'token.sum': '{count}-day total',
        'token.avg': 'Daily average',
        'token.peak': 'Peak day',
        'token.wallets': 'Wallets',
        'token.unavailable': 'Account service not mounted',
        'token.signedOut': 'Not signed in to DeepSeek',
        'token.noHistory': 'No history yet. A few samples and the trend shows up here.',
        'token.notice.low': 'Balance is low: {amount}',
        'token.notice.unavailable': 'Balance unavailable: {reason}',
        'token.notice.signedOut': 'Not signed in to DeepSeek; the balance cannot be read.',
        'token.link.usage': 'Usage',
        'token.link.topUp': 'Top up',
      },
    })
