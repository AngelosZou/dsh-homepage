/**
 * The audit runner: it turns one audit record into a real review session, reads
 * the verdict back out of the tool that session calls, and installs the plugin
 * when the verdict allows it.
 *
 * Everything the runner needs from the engine is injected, so the whole flow can
 * be exercised with fakes (`test/audit-runner.mjs`) without a running harness:
 *
 *   - `agents()`    the host `agents` service: `create()` builds the agent and
 *                   its session, and the agent id *is* the session id
 *   - `sessions()`  the host `sessions` service, to flush the log to disk
 *   - `prepareSource()` fetches one allowlisted artifact and freezes it into the
 *                   read-only snapshot the review session may read
 *   - `llm()`       the live provider/model registry, including reasoning efforts
 *   - `defaultModel()` the profile's default selection (read only)
 *   - `title()`     the `sessionTitle` service, for the session's name
 *   - `on()`        `ctx.on`, for the session's progress events
 *   - `install()`   `pluginManager.installBundle(spec, options)`
 *   - `fetchJson()` reads a registry packument or a GitHub manifest
 *   - `cwd()`       the directory the review session works in
 *
 * The audit Agent is deliberately not given a shell, a network tool or a generic
 * file reader. Its only tools are three scope-local readers over the frozen
 * snapshot plus the verdict tool; `guard()` is the execution boundary for
 * everything else, including tools another plugin registers later.
 *
 * The two halves of the verdict channel are deliberately different code paths:
 * the session reaches the verdict with a *tool* (`report_plugin_audit`, whose
 * `execute` receives the calling agent), and the browser reaches everything else
 * over the plugin's `homepage/*` remotes. Neither half parses the model's
 * prose.
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import {
  AUDIT_TOOL_NAME,
  auditToolParameters,
  compatibilityCheck,
  createAuditRegistry,
  needsConfirmation,
  normalizeAuditInstructions,
  resolveTarget,
  verdictAcknowledgement,
} from './audit.js'
import { AUDIT_SOURCE_TOOL_NAMES, createAuditSourceTools } from './source-tools.js'

const TOOL_DESCRIPTION =
  'Report the verdict of one plugin security review to the dsh-homepage ' +
  'audit card. Call it exactly once, at the end of the review: the card installs, ' +
  'asks about, or refuses the plugin from what this call says, so the summary and ' +
  'the findings are the only record the user sees.'

/** The id prefix every audit Session is created with. */
const AUDIT_SESSION_PREFIX = 'plugin-audit-'

/** The only tools an audit Agent may invoke. Everything else is denied. */
const AUDIT_ALLOWED_TOOLS = new Set([...AUDIT_SOURCE_TOOL_NAMES, AUDIT_TOOL_NAME])

/** @returns a message from an unknown throwable. */
function messageOf(error) {
  if (error && typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

/** @returns the text of a message's content blocks. */
function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * The llm package's own user message when it is reachable from this plugin, and
 * the same frozen shape when it is not (the shape is a plain object, so the only
 * thing the import buys is staying in step with it).
 */
async function userMessage(text) {
  const input = { content: [{ type: 'text', text }], source: { kind: 'user' } }
  try {
    const llm = await import('@deepseek-ai/dsh-llm')
    if (llm && typeof llm.createUserMessage === 'function') return llm.createUserMessage(input)
  } catch {
    /* not resolvable from this plugin: the shape below is the same one */
  }
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze(input.content.map((block) => Object.freeze({ ...block }))),
    source: Object.freeze({ ...input.source }),
  })
}

/**
 * Turn a `ChangeResult` from the plugin manager into the audit's own words.
 * @param result - what `installBundle()` answered.
 * @returns `{ state, detail, install }` for the record.
 */
export function describeInstall(result) {
  if (!result || typeof result !== 'object') {
    return { state: 'installed', detail: '已安装。', install: null }
  }
  const application = typeof result.application === 'string' ? result.application : ''
  const error = result.error && typeof result.error === 'object' ? result.error : null
  if (application === 'failed' || error) {
    const code = error && typeof error.code === 'string' ? error.code : 'install-failed'
    const reason = error && typeof error.message === 'string' ? error.message : ''
    const peers = error && Array.isArray(error.incompatible) ? error.incompatible : []
    const extra = peers
      .filter((item) => item && item.name)
      .map((item) => item.name + '（当前 ' + String(item.runtimeVersion || '?') + '）')
      .join('、')
    return {
      state: 'failed',
      detail: '安装失败（' + code + '）' + (reason ? '：' + reason : '') + (extra ? '；不相容：' + extra : ''),
      install: { application: application || 'failed', code },
    }
  }
  if (application === 'restart-required') {
    return { state: 'installed', detail: '已安装，重启 DSH 之后生效。', install: { application } }
  }
  if (application === 'cancelled') {
    return { state: 'declined', detail: '安装被取消。', install: { application } }
  }
  if (application === 'overridden') {
    return { state: 'declined', detail: '安装被现有策略覆盖，没有写入。', install: { application } }
  }
  const warnings = Array.isArray(result.warnings) ? result.warnings.length : 0
  return {
    state: 'installed',
    detail: warnings > 0 ? '已安装（' + warnings + ' 条警告）。' : '已安装。',
    install: { application: application || 'applied' },
  }
}

/**
 * Build the runner.
 * @param options - the injected engine surface (see the file comment).
 * @returns `{ models, start, status, list, decide, report, tool }`.
 */
export function createAuditRunner(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const makeId = typeof options.makeId === 'function'
    ? options.makeId
    : () => 'audit-' + randomUUID().slice(0, 8)
  const registry = createAuditRegistry({ now, makeId, onChange: () => scheduleSave() })
  // Which DSH this is: read once per process by the caller, empty when the layout
  // is unknown (the compatibility finding then says "could not tell").
  const runtimeVersion = typeof options.runtimeVersion === 'function'
    ? options.runtimeVersion
    : async () => ''
  // How long a session may take to start its first turn before the audit gives up
  // on it. A session that never runs is a failure, but one that is merely slow is
  // not: the wait is here so a prompt that never lands still ends the audit.
  const turnStartTimeoutMs = Number.isFinite(options.turnStartTimeoutMs) && options.turnStartTimeoutMs > 0
    ? Number(options.turnStartTimeoutMs)
    : 30000
  const fetchJson = typeof options.fetchJson === 'function'
    ? options.fetchJson
    : async (url, init) => {
      const response = await fetch(url, init)
      if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + url)
      return response.json()
    }
  /** The live runs, so the progress listener can be taken off again. */
  const runs = new Map()
  /** The prepared snapshot of each live audit, so the source tools can read it. */
  const sources = new Map()
  /** Agent/session id → audit id, for the execution guard. */
  const sessionToAudit = new Map()
  const prepareSource = typeof options.prepareSource === 'function' ? options.prepareSource : null

  /**
   * The record file, when the caller has one. The registry itself stays I/O-free:
   * it tells the runner when something changed, and the runner is what writes —
   * and it coalesces, so a burst of progress notes costs one write, not twenty.
   */
  const store = options.store && typeof options.store.read === 'function' && typeof options.store.write === 'function'
    ? options.store
    : null
  let loading = null
  let saving = false
  let dirty = false

  /** Read the saved history once, before the first answer that needs it. */
  function ensureLoaded() {
    if (loading) return loading
    loading = store
      ? Promise.resolve()
        .then(() => store.read())
        .then((records) => {
          registry.load(records)
          // A restarted process can still have audit Sessions in the sidebar.
          // Recognizing their ids keeps the execution guard on them even though
          // their per-snapshot tools are gone; only a re-audit can read source.
          for (const audit of registry.list()) {
            if (audit.session && audit.session.id !== undefined) {
              sessionToAudit.set(String(audit.session.id), audit.id)
            }
          }
        })
        .catch(() => { /* an unreadable history is an empty one */ })
      : Promise.resolve()
    return loading
  }

  /** Write the history back, coalescing everything that happens meanwhile. */
  function scheduleSave() {
    if (!store) return
    if (saving) {
      dirty = true
      return
    }
    saving = true
    dirty = false
    Promise.resolve()
      .then(() => store.write(registry.snapshot()))
      .catch(() => { /* losing a record must not break the run that made it */ })
      .then(() => {
        saving = false
        if (dirty) scheduleSave()
      })
  }

  /** @returns the live service, or null when this profile has none. */
  function serviceOf(key) {
    const read = options[key]
    if (typeof read !== 'function') return null
    try {
      return read() || null
    } catch {
      return null
    }
  }

  /** @returns the record, or null when the audit is no longer running. */
  function running(id) {
    const audit = registry.get(id)
    if (!audit || audit.state !== 'running') return null
    return audit
  }

  /** @returns every stable id an Agent/Session-like object carries. */
  function agentKeys(agent) {
    const keys = []
    if (agent && agent.id !== undefined && agent.id !== null) keys.push(String(agent.id))
    if (agent && agent.session && agent.session.id !== undefined && agent.session.id !== null) {
      keys.push(String(agent.session.id))
    }
    return keys
  }

  /** @returns true when `agent` is one of this process's live audit sessions. */
  function isAuditSession(agent) {
    return agentKeys(agent).some((key) => key.startsWith(AUDIT_SESSION_PREFIX) || sessionToAudit.has(key))
  }

  /**
   * The execution guard: the catalog restriction hides global tools, but another
   * plugin can register a tool after setup, and a model can still name it. This
   * check runs after pre-execute policy and approval, so it is the real boundary.
   * @param exec - one tool invocation.
   * @returns a denial reason, or undefined when the call is allowed.
   */
  function guard(exec) {
    if (!isAuditSession(exec && exec.agent)) return undefined
    const name = exec && typeof exec.name === 'string' ? exec.name : ''
    if (AUDIT_ALLOWED_TOOLS.has(name)) return undefined
    return '审核会话只能读取本次源码快照并汇报结论；工具 "' + (name || '(未命名)') + '" 不可用。'
  }

  /** Drop the live snapshot and its files once the audit can no longer read it. */
  function dropSource(id) {
    const snapshot = sources.get(id)
    sources.delete(id)
    if (snapshot && typeof snapshot.dispose === 'function') {
      Promise.resolve().then(() => snapshot.dispose()).catch(() => {})
    }
  }

  /** @returns the record in the shape the endpoints and the card use. */
  function present(audit) {
    if (!audit) return null
    const target = audit.target && typeof audit.target === 'object' ? audit.target : {}
    return {
      auditId: audit.id,
      state: audit.state,
      stage: audit.stage || '',
      detail: audit.detail || '',
      verdict: audit.verdict || null,
      summary: audit.summary || '',
      findings: Array.isArray(audit.findings) ? audit.findings.slice() : [],
      plugin: {
        input: target.input || '',
        kind: target.kind || '',
        name: target.name || '',
        version: target.version || '',
        repo: target.repo || '',
        spec: target.spec || '',
        description: target.description || '',
      },
      session: audit.session && audit.session.id !== undefined
        ? { id: String(audit.session.id), title: audit.session.title || '' }
        : null,
      // The runtime this package would be installed into: the card shows the
      // declared range next to the version it has to fit.
      compatibility: audit.compatibility || null,
      // The immutable source the review actually read (digest, ref, truncation).
      source: audit.source || null,
      installed: audit.state === 'installed',
      install: audit.install || null,
      startedAt: audit.startedAt || 0,
      updatedAt: audit.updatedAt || 0,
    }
  }

  /** Note what the session is doing, without ever failing its run over it. */
  function note(id, event) {
    if (!running(id)) return
    const type = event && typeof event.type === 'string' ? event.type : ''
    const data = event && event.data && typeof event.data === 'object' ? event.data : {}
    if (type === 'turn/start') {
      registry.patch(id, { stage: 'reading', detail: '审核会话正在读源码…' })
      return
    }
    if (type === 'tool/call') {
      const name = typeof data.name === 'string' ? data.name : ''
      registry.patch(id, { stage: 'tool', detail: '调用工具 ' + (name || '(未命名)') + '…' })
      return
    }
    if (type === 'assistant/message') {
      registry.patch(id, { stage: 'writing', detail: '审核会话正在写结论…' })
      return
    }
    if (type === 'turn/end') {
      registry.patch(id, { stage: 'finishing', detail: '审核会话正在收尾…' })
    }
  }

  /**
   * @param onTurnStart - called once, when the session starts its first turn: the
   * moment the review has actually begun, which is what `watch` waits for.
   * @returns the listener's disposer, or null when there is nothing to listen with.
   */
  function watchEvents(id, agent, onTurnStart) {
    const on = typeof options.on === 'function' ? options.on : null
    if (!on) return null
    let announced = false
    try {
      const off = on('session/event', (session, event) => {
        // `(session, event)` is the published shape; a bare event is accepted so
        // a renamed event stream cannot silence the progress line.
        const shaped = event && typeof event.type === 'string'
        const current = shaped ? event : session
        const owner = shaped ? session : null
        if (owner && String(owner.id !== undefined ? owner.id : owner) !== String(agent.id)) return
        if (!announced && current && current.type === 'turn/start' && typeof onTurnStart === 'function') {
          announced = true
          onTurnStart()
        }
        note(id, current)
      })
      return typeof off === 'function' ? off : null
    } catch {
      return null
    }
  }

  /** @returns the last thing the session said, for a run that ended without a verdict. */
  function lastAssistantText(agent) {
    try {
      const session = agent && agent.session
      const events = session && typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]
        if (!event || event.type !== 'assistant/message') continue
        const data = event.data && typeof event.data === 'object' ? event.data : {}
        const text = blocksToText(data.content || (data.message && data.message.content))
        if (text !== '') return text.slice(0, 400)
      }
    } catch {
      /* unreadable session: the audit still reports that no verdict arrived */
    }
    return ''
  }

  /** Land the session's log on disk, so the stock sidebar can list it. */
  async function flushSession(agent) {
    const sessions = serviceOf('sessions')
    if (!sessions || typeof sessions.flush !== 'function' || !agent || !agent.session) return
    try {
      await sessions.flush(agent.session)
    } catch {
      /* persistence is the loop's job as well: a failed flush is not a verdict */
    }
  }

  /** A review that ended without a report is a failed audit, not a silent one. */
  async function finish(id, agent) {
    const off = runs.get(id)
    if (typeof off === 'function') {
      try {
        off()
      } catch {
        /* the listener is already gone */
      }
    }
    runs.delete(id)
    await flushSession(agent)
    if (!running(id)) return
    const text = lastAssistantText(agent)
    registry.patch(id, {
      state: 'failed',
      stage: 'no-verdict',
      detail: '审核会话结束了，但没有调用 ' + AUDIT_TOOL_NAME + ' 汇报结论。'
        + (text === '' ? '' : '它最后说的是：' + text),
    })
    dropSource(id)
  }

  /**
   * Follow the review to its end in the background.
   *
   * The wait is on the session's **first turn**, not on `whenIdle()` directly:
   * `whenIdle()` resolves at once when the agent has nothing in flight, and this
   * runs before the prompt is delivered, so waiting on it straight away declared
   * "no verdict" while the session had not started yet — the card flashed `failed`
   * and then flipped to the real verdict when the report arrived. A turn is what
   * this waits for, with a timeout so a session that never starts at all still
   * ends the audit instead of leaving it `running` for ever.
   *
   * Without an event stream there is nothing to wait for but idle: `whenIdle()`
   * after the prompt is then the best signal available (and what the tests inject).
   */
  function watch(id, agent) {
    let settled = false
    let timer = null
    function begin() {
      if (settled) return
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      Promise.resolve()
        .then(() => (agent && typeof agent.whenIdle === 'function' ? agent.whenIdle() : null))
        .then(() => finish(id, agent))
        .catch(() => {})
    }
    const off = watchEvents(id, agent, begin)
    if (off) runs.set(id, off)
    else {
      begin()
      return
    }
    // No turn ever started: the session exists but nothing ran, so there is no idle
    // to wait for — the audit ends with that reason rather than staying running.
    timer = setTimeout(function giveUp() {
      if (settled) return
      settled = true
      timer = null
      Promise.resolve().then(() => finish(id, agent)).catch(() => {})
    }, turnStartTimeoutMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  /** @returns the session's title. */
  function titleFor(target) {
    const name = target && (target.name || target.input) ? String(target.name || target.input) : '未知插件'
    return '插件审核：' + name
  }

  /**
   * Record the requested model selection on the unpublished Agent before the
   * first step is prepared. `agentOptions` carries the same route as a fallback;
   * the explicit selection is what freezes the reasoning effort for the step.
   * The legacy `agent/request` hook is deliberately not used: DSH refuses a
   * request-time effort change after step preparation has fixed the route.
   */
  function applyModelSelection(agent, selection) {
    if (!selection || !agent || !agent.model || typeof agent.model.select !== 'function') return
    agent.model.select({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    })
  }

  /** Copy only the default selection fields exposed by the audit API. */
  function defaultSelection() {
    const defaults = serviceOf('defaultModel')
    const selected = defaults && typeof defaults.currentSelection === 'function'
      ? defaults.currentSelection()
      : null
    if (!selected || !selected.provider || !selected.model) return null
    return {
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }
  }

  /** Project the live catalog just as DSH's session-controller/catalog.ts does. */
  async function providerModels(llm, provider) {
    const models = await llm.listModels(provider)
    return Promise.all(models.map(async (model) => {
      const resolved = typeof llm.resolveModelInfo === 'function'
        ? await llm.resolveModelInfo(provider, model.id)
        : model
      return {
        provider,
        model: model.id,
        name: model.name,
        efforts: (resolved.reasoning?.efforts || []).map(({ id, name }) => ({ id, name })),
      }
    }))
  }

  /** Validate before fetching source or creating history; never change defaults. */
  async function selectModel(input) {
    const selected = input === undefined ? defaultSelection() : input
    if (input === undefined && selected === null) throw new Error('读不到默认模型，审核会话无法启动')
    if (!selected || typeof selected !== 'object' || Array.isArray(selected)
      || typeof selected.provider !== 'string' || selected.provider.trim() === ''
      || typeof selected.model !== 'string' || selected.model.trim() === '') {
      throw new Error('selection 必须包含 provider 和 model 字符串')
    }
    // An explicit model with no effort uses that model's own default, even when
    // it happens to be the profile's current model. Do not merge the selections.
    const selection = {
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }
    const llm = serviceOf('llm')
    if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
      throw new Error('llm 模型目录不可用，审核会话无法启动')
    }
    if (!(await llm.listProviders()).some((provider) => provider.id === selection.provider)) {
      throw new Error('审核模型 provider 不可用：' + selection.provider)
    }
    const models = await providerModels(llm, selection.provider)
    const model = models.find((entry) => entry.model === selection.model)
    if (!model) throw new Error('审核 model 不可用：' + selection.model)
    if (selection.reasoningEffort !== undefined
      && !model.efforts.some((effort) => effort.id === selection.reasoningEffort)) {
      throw new Error('审核模型不支持 reasoningEffort：' + String(selection.reasoningEffort))
    }
    return selection
  }

  /** Create the review session with its validated selection and hand it the prompt. */
  async function openSession(id, instructions, selection, snapshot) {
    const audit = registry.get(id)
    if (!audit) return
    let handle = null
    try {
      const agents = serviceOf('agents')
      if (!agents || typeof agents.create !== 'function') {
        throw new Error('agents 服务不可用，创建不了审核会话')
      }
      const dir = typeof options.cwd === 'function' ? await options.cwd() : undefined
      handle = await agents.create({
        sessionId: 'plugin-audit-' + randomUUID(),
        meta: { cwd: dir },
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        },
        setup: async (agentCtx, agent) => {
          const tools = agentCtx && agentCtx.tools
          if (!tools || typeof tools.register !== 'function'
            || typeof tools.restrict !== 'function'
            || typeof tools.guard !== 'function') {
            throw new Error('审核会话没有可限制、可 guard 的工具注册表，拒绝以不受限的能力开始')
          }
          for (const definition of createAuditSourceTools(snapshot)) tools.register(definition)
          // Only the verdict tool is a global; the three source tools above are
          // scope-local and survive this allow-list (the tools service keeps a
          // scope's own registrations visible). The global list therefore drops
          // to the report tool, and the runner's guard enforces it at execution.
          tools.restrict({ allow: [AUDIT_TOOL_NAME] })
          // Belt and braces: a guard scoped to this Agent still runs even if the
          // process-wide guard was not installed by an older host.
          tools.guard((exec) => {
            const name = exec && typeof exec.name === 'string' ? exec.name : ''
            return AUDIT_ALLOWED_TOOLS.has(name)
              ? undefined
              : '审核会话只能读取本次源码快照并汇报结论；工具 "' + (name || '(未命名)') + '" 不可用。'
          })
          applyModelSelection(agent, selection)
        },
      })
      const agent = handle && handle.agent
      if (!agent) throw new Error('审核会话没有创建成功')
      const title = titleFor(audit.target)
      const titles = serviceOf('title')
      if (titles && typeof titles.rename === 'function' && agent.session) {
        try {
          titles.rename(agent.session, title)
        } catch {
          /* the name is cosmetic: the verdict does not depend on it */
        }
      }
      // An audit reads and reports; it does not write. Ask for the read-only
      // preset as defence in depth, and keep the profile's default when this
      // profile has no such preset.
      const permissions = serviceOf('permissions')
      if (permissions && typeof permissions.set === 'function' && agent.session) {
        try {
          if (typeof permissions.resolve === 'function') permissions.resolve('read-only')
          permissions.set(agent.session, 'read-only')
        } catch {
          /* no read-only preset here: the profile default stands */
        }
      }
      registry.attachSession(id, { id: String(agent.id), title }, '审核会话正在读源码快照…')
      sessionToAudit.set(String(agent.id), id)
      watch(id, agent)
      const prompt = registry.prompt(id, instructions)
      if (typeof agent.followup === 'function') await agent.followup(await userMessage(prompt))
      else if (typeof agent.send === 'function') await agent.send(await userMessage(prompt))
      else throw new Error('审核会话不接受消息')
    } catch (error) {
      if (handle && typeof handle.dispose === 'function') {
        try {
          await handle.dispose()
        } catch {
          /* the failure worth reporting is the one already in hand */
        }
      }
      dropSource(id)
      registry.patch(id, {
        state: 'failed',
        stage: 'session-failed',
        detail: '创建审核会话失败：' + messageOf(error),
      })
    }
  }
  /** Install the audited plugin, after checking the source has not changed. */
  async function installOne(id) {
    const audit = registry.get(id)
    if (!audit) return null
    const target = audit.target && typeof audit.target === 'object' ? audit.target : {}
    const source = audit.source && typeof audit.source === 'object' ? audit.source : null
    const spec = source && typeof source.installSpec === 'string' && source.installSpec !== ''
      ? source.installSpec
      : target.spec
    const install = typeof options.install === 'function' ? options.install : null
    if (!spec || typeof install !== 'function') {
      return registry.patch(id, {
        state: 'failed',
        stage: 'install-failed',
        detail: !spec ? '这次审核没有可安装的规格。' : '插件安装服务不可用。',
      })
    }
    if (!source) {
      return registry.patch(id, {
        state: 'failed',
        stage: 'source-missing',
        detail: '这次审核没有可核验的源码快照，已拒绝安装。请重新审核。',
      })
    }
    if (source.pinned !== true) {
      return registry.patch(id, {
        state: 'failed',
        stage: 'source-unpinned',
        detail: '这次审核的源码没有固定到不可变版本（可能是 GitHub HEAD、没有摘要的 npm 包或本机目录），'
          + '安装可能装到没人审过的代码，已拒绝。请用精确版本或 commit 重新审核。',
      })
    }
    if (typeof source.installSpec !== 'string' || source.installSpec === '') {
      return registry.patch(id, {
        state: 'failed',
        stage: 'source-unpinned',
        detail: '这次审核没有记录可安装的固定规格，已拒绝安装。请重新审核。',
      })
    }
    registry.patch(id, {
      state: 'installing',
      stage: 'installing',
      detail: '正在安装 ' + (target.name || spec) + '…',
    })
    try {
      const result = await install(spec, { requestId: id })
      const described = describeInstall(result)
      if (described.state === 'installed') dropSource(id)
      return registry.patch(id, {
        state: described.state,
        stage: 'install',
        detail: described.detail,
        install: described.install,
        installed: described.state === 'installed',
      })
    } catch (error) {
      return registry.patch(id, {
        state: 'failed',
        stage: 'install-failed',
        detail: '安装失败：' + messageOf(error),
      })
    }
  }

  /**
   * What the review session calls when it has read the code. The calling agent's
   * session is checked against the audit's, because a report from another session
   * is not a report about this audit.
   * @param payload - the tool arguments.
   * @param exec - the tool run context, whose `agent` is the caller.
   * @returns the tool's value.
   */
  async function report(payload, exec) {
    const input = payload && typeof payload === 'object' ? payload : {}
    const id = typeof input.auditId === 'string' ? input.auditId.trim() : ''
    if (id === '') throw new Error('缺少 auditId：请用提示里给出的那次审核 id')
    const audit = registry.get(id)
    if (!audit) throw new Error('没有这次审核的记录：' + id)
    if (audit.state !== 'running') throw new Error('这次审核已经结束，不能再汇报')
    const calling = exec && exec.agent && exec.agent.id !== undefined ? String(exec.agent.id) : ''
    const expected = audit.session && audit.session.id !== undefined ? String(audit.session.id) : ''
    if (expected !== '' && calling !== expected) {
      throw new Error('这次审核在另一个会话里进行，当前会话不能替它汇报')
    }
    const recorded = registry.recordVerdict(id, input)
    // No verdict installs anything by itself. The audit reads hostile code, so a
    // prompt-injected "safe" must not become a silent install; the user confirms
    // from the card, and that decision is what `decide()` records.
    return { text: verdictAcknowledgement(recorded.verdict), verdict: recorded.verdict }
  }

  return {
    /** @returns live models and the profile default; unavailable providers are omitted. */
    async models() {
      const selection = defaultSelection()
      const llm = serviceOf('llm')
      if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
        return { models: [], defaultSelection: selection }
      }
      const providers = await llm.listProviders()
      const groups = await Promise.all(providers.map(async (provider) => {
        try { return await providerModels(llm, provider.id) }
        catch { return [] }
      }))
      return { models: groups.flat(), defaultSelection: selection }
    },
    /**
     * The card's one entry point: give it what the user typed, get back a running
     * audit. The session is open before this resolves, the verdict is not.
     * @param input - `{ target, prompt, selection }`, where prompt is optional
     *   guidance (at most 20000 characters), and selection is
     *   `{ provider, model, reasoningEffort? }` (omitted means the profile default).
     * @returns the audit in the endpoint shape.
     */
    async start(input = {}) {
      const instructions = normalizeAuditInstructions(input.prompt)
      const raw = typeof input.target === 'string' ? input.target.trim() : ''
      if (raw === '') throw new Error('请填写要审核的插件：npm 包名、owner/repo 或仓库地址')
      if (!prepareSource) throw new Error('本机没有源码快照服务，无法安全读取源码')
      const selection = await selectModel(input.selection)
      await ensureLoaded()
      const resolved = await resolveTarget(raw, { fetchJson })
      // Before a session is spent on it: does this runtime accept the package at
      // all? DSH refuses an incompatible install itself, so the audit says it up
      // front instead of letting the user wait for a pnpm run that cannot work.
      const compatibility = compatibilityCheck(resolved.manifest, await runtimeVersion())
      const audit = registry.start({
        target: resolved,
        findings: (Array.isArray(resolved.findings) ? resolved.findings : []).concat(compatibility.findings),
        compatibility,
      })
      // Freeze exactly what the review will read before the model sees anything.
      // The session gets data-only tools over this snapshot, never the network or
      // a shell, so the target cannot execute in, or leak out of, the host.
      const root = typeof options.cwd === 'function' ? await options.cwd() : undefined
      let snapshot = null
      try {
        const dir = root === undefined ? undefined : join(root, audit.id)
        snapshot = await prepareSource(resolved, {
          auditId: audit.id,
          root,
          dir,
          signal: input.signal,
          fetchJson,
        })
        if (!snapshot || !snapshot.source || typeof snapshot.source !== 'object') {
          throw new Error('源码快照没有返回来源信息')
        }
        sources.set(audit.id, snapshot)
        registry.patch(audit.id, { source: snapshot.source })
      } catch (error) {
        if (snapshot) dropSource(audit.id)
        registry.patch(audit.id, {
          state: 'failed',
          stage: 'source-failed',
          detail: '准备源码快照失败：' + messageOf(error),
        })
        return present(registry.get(audit.id))
      }
      await openSession(audit.id, instructions, selection, snapshot)
      return present(registry.get(audit.id))
    },
    /**
     * @param input - `{ auditId }`, or nothing for the newest audit.
     * @returns the audit in the endpoint shape, or null.
     */
    async status(input = {}) {
      await ensureLoaded()
      const id = typeof input.auditId === 'string' ? input.auditId.trim() : ''
      if (id === '') {
        const all = registry.list()
        return all.length > 0 ? present(all[0]) : null
      }
      return present(registry.get(id))
    },
    /** @returns every audit, newest first. */
    async list() {
      await ensureLoaded()
      return { audits: registry.list().map(present) }
    },
    /**
     * The user's answer to a verdict: install it, or decline. This is also the way
     * a `review`-only audit gets installed — the review is the point, the install
     * is a separate decision that the record keeps.
     * @param input - `{ auditId, decision, override }`.
     * @returns the audit in the endpoint shape.
     */
    async decide(input = {}) {
      await ensureLoaded()
      const id = typeof input.auditId === 'string' ? input.auditId.trim() : ''
      const audit = registry.get(id)
      if (!audit) throw new Error('没有这次审核的记录：' + String(id || '(空)'))
      if (input.decision !== 'install') {
        const declined = registry.decide(id, 'decline')
        dropSource(id)
        return present(declined)
      }
      if (audit.state === 'installed' || audit.state === 'installing') return present(audit)
      if (!audit.verdict) throw new Error('这次审核还没有结论，不能安装')
      if (audit.verdict === 'unsafe' && input.override !== true) {
        throw new Error('这次审核判定为恶意代码，卡片不会安装它')
      }
      // The same answer DSH's installer would give, said earlier and in words:
      // the package declares a harness version this machine does not have.
      if (audit.compatibility && audit.compatibility.compatible === false && input.override !== true) {
        throw new Error(
          '这个包声明的 DSH 版本范围装不上本机（本机 ' + String(audit.compatibility.runtime || '(未知)') +
          '），DSH 安装时会拒绝；要强制尝试请显式覆盖。',
        )
      }
      registry.decide(id, 'install')
      return present(await installOne(id))
    },
    /**
     * What the review session calls when it has read the code (see `report`).
     * @param payload - the tool arguments.
     * @param exec - the tool run context.
     * @returns the tool's value.
     */
    report,
    /** @returns true when an Agent is one of this process's live audit sessions. */
    isAuditSession,
    /** The execution guard the host registers with `ctx.tools.guard`. */
    guard,
    /** @returns true when a verdict has to be answered before installing. */
    needsConfirmation,
    /** @returns the model-facing tool definition for the verdict channel. */
    tool() {
      return {
        name: AUDIT_TOOL_NAME,
        description: TOOL_DESCRIPTION,
        parameters: auditToolParameters(),
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string' },
              verdict: { type: 'string', enum: ['safe', 'warn', 'unsafe'] },
            },
            required: ['text', 'verdict'],
          },
          render: (_args, value) => [{ type: 'text', text: String(value && value.text ? value.text : '') }],
        },
        execute: (args, exec) => report(args, exec),
      }
    },
  }
}
