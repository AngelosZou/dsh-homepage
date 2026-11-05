/**
 * audit-runner: the host half's chain, from a typed plugin name to an installed
 * plugin. The engine is injected, so this runs without an agent loop, a plugin
 * manager or the network.
 *
 * What it proves:
 *  1. `start()` resolves the target, opens a review session through `agents`
 *     (absolute cwd, no workspace, so the session lands in 未分组) and hands it a
 *     prompt that names both the audit id and where to read the source.
 *  2. The session's own events move the progress line, and another session's
 *     events do not.
 *  3. The verdict channel is bound to the audit's session: a report from another
 *     session is refused, and one audit cannot report twice.
 *  4. No verdict installs by itself: `safe` and `warn` wait for the user, `unsafe`
 *     refuses to install, and a declined verdict is a record of its own.
 *  5. The session is locked to the three snapshot tools plus the verdict tool; a
 *     global `bash`/`web_fetch` call is denied at execution.
 *  6. An install result is reported as what it is: restart-required is installed,
 *     a failed install keeps DSH's own reason, a cancelled install is declined.
 *  7. A review that ends without a verdict is failed, not silently running.
 *
 * Run: node test/audit-runner.mjs
 */
import { deepEqual, rejects } from 'node:assert/strict'
import { createAuditRunner, describeInstall } from '../lib/host/audit-runner.js'
import { AUDIT_TOOL_NAME } from '../lib/host/audit.js'
import { DEFAULT_AUDIT_INSTRUCTIONS } from '../lib/audit-instructions.js'

let failures = 0
function assert(condition, message) {
  if (condition) return
  failures += 1
  console.error('FAIL: ' + message)
}

function equal(actual, expected, message) {
  assert(actual === expected,
    message + ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')')
}

/** Let the fire-and-forget paths (install, idle watcher) settle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** What the fake npm registry answers, including the install script to flag. */
const PACKUMENT = {
  'dist-tags': { latest: '1.2.3' },
  versions: {
    '1.2.3': {
      name: 'dsh-note',
      version: '1.2.3',
      description: 'notes in the sidebar',
      repository: { type: 'git', url: 'git+https://github.com/example/dsh-note.git' },
      scripts: { postinstall: 'node scripts/setup.js' },
    },
  },
}

/** A package that declares a harness range this runtime is not in. */
const OLD_PACKUMENT = {
  'dist-tags': { latest: '0.9.0' },
  versions: {
    '0.9.0': {
      name: 'dsh-old',
      version: '0.9.0',
      description: 'written against an older harness',
      repository: { type: 'git', url: 'git+https://github.com/example/dsh-old.git' },
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' },
    },
  },
}

const DEFAULT_SELECTION = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
const MODEL_CATALOG = {
  'deepseek-official': [
    { id: 'deepseek-flash', name: 'DeepSeek Flash', reasoning: {
      efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low',
    } },
  ],
  custom: [
    { id: 'deepseek-flash', name: 'Custom Flash', reasoning: {
      efforts: [{ id: 'off', name: 'Disabled' }, { id: 'thorough', name: 'Thorough' }], defaultEffort: 'off',
    } },
    { id: 'plain', name: 'Plain model' },
  ],
}

/** The registry supplies reasoning metadata, without any hard-coded effort vocabulary. */
function modelRegistry() {
  return {
    listProviders: () => Object.keys(MODEL_CATALOG).map((id) => ({ id, name: id })),
    listModels: async (provider) => MODEL_CATALOG[provider],
  }
}

/** One prepared snapshot, enough for the runner and the three source tools. */
function fakeSnapshot() {
  const source = {
    kind: 'npm',
    label: 'dsh-note@1.2.3',
    ref: '1.2.3',
    requestedRef: '1.2.3',
    commit: null,
    installSpec: 'dsh-note@1.2.3',
    pinned: true,
    url: 'https://registry.npmjs.org/dsh-note/-/dsh-note-1.2.3.tgz',
    artifactSha256: 'a'.repeat(64),
    artifactBytes: 42,
    fileCount: 1,
    byteCount: 10,
    truncated: false,
    anomalies: [],
  }
  const file = { path: 'package.json', kind: 'file', size: 10, binary: false, skipped: false }
  return {
    source,
    manifest: { version: 1, source, files: [file] },
    list: () => ({ source, total: 1, truncated: false, entries: [file] }),
    read: async () => ({ path: 'package.json', totalLines: 1, startLine: 1, endLine: 1, text: '     1  {}', truncated: false }),
    grep: async () => ({ matches: [], filesScanned: 1, truncated: false }),
    verify: async () => ({ ok: true }),
    dispose: async () => {},
  }
}

/**
 * One fake engine: an `agents` service that remembers what it was asked for,
 * records what the review session said, and can be told when the turn is over.
 * @param options - `{ runtimeVersion, prepareSource }`.
 * @returns `{ state, runner }`.
 */
function makeEngine(options = {}) {
  const runtime = options.runtimeVersion === undefined ? '0.2.1-alpha.3' : options.runtimeVersion
  const state = {
    created: [], installs: [], requests: [], handlers: [], prepared: [],
    flushed: 0, installResult: null, disposed: 0,
  }
  let serial = 0
  const prepareSource = options.prepareSource === undefined
    ? async (target) => {
      state.prepared.push(target.input)
      return fakeSnapshot()
    }
    : options.prepareSource
  const withoutTools = options.withoutTools === true
  const agents = {
    async create(options) {
      const events = []
      let idleResolve = null
      const idle = new Promise((resolve) => { idleResolve = resolve })
      const session = { id: options.sessionId, header: options.meta, snapshotEvents: () => events.slice() }
      const hooks = []
      const toolLog = { registered: [], restricted: [], guards: [] }
      const agentCtx = {
        on: (event, handler) => { hooks.push({ event, handler }); return () => {} },
        ...(withoutTools ? {} : {
          tools: {
            register: (definition) => { toolLog.registered.push(definition); return () => {} },
            restrict: (filter) => { toolLog.restricted.push(filter); return () => {} },
            guard: (guard) => { toolLog.guards.push(guard); return () => {} },
          },
        }),
      }
      const agent = {
        id: options.sessionId,
        session,
        followups: [],
        whenIdle: () => idle,
        async followup(message) { agent.followups.push(message) },
      }
      state.created.push({ options, agent, events, idle: () => idleResolve(), hooks, toolLog, agentCtx })
      // The real engine runs `setup` during create, before the first turn.
      await options.setup(agentCtx)
      return { agent, dispose: async () => { state.disposed += 1 } }
    },
  }
  const runner = createAuditRunner({
    agents: () => agents,
    sessions: () => ({ flush: async () => { state.flushed += 1 } }),
    presets: () => null,
    // The profile's own model selection. Without one the review session cannot
    // render its persona, so the runner has to be given one to work with.
    defaultModel: () => (options.model === null ? null : {
      currentSelection: () => options.model || DEFAULT_SELECTION,
      set: () => { throw new Error('the global default must never be changed') },
    }),
    llm: () => options.llm === undefined ? modelRegistry() : options.llm,
    permissions: () => (options.permissions === undefined ? null : options.permissions),
    prepareSource,
    // The audit history file, when the case supplies one: the runner loads it
    // before its first answer and writes every change back through it.
    store: options.store,
    turnStartTimeoutMs: options.turnStartTimeoutMs,
    title: () => null,
    on: (event, handler) => {
      state.handlers.push(handler)
      return () => { state.handlers = state.handlers.filter((entry) => entry !== handler) }
    },
    install: async (spec, options) => {
      state.installs.push({ spec, options })
      return state.installResult || { changed: true, application: 'applied' }
    },
    fetchJson: async (url) => {
      state.requests.push(url)
      if (url.indexOf('dsh-old') >= 0) return OLD_PACKUMENT
      if (url.indexOf('dsh-note') >= 0) return PACKUMENT
      throw new Error('HTTP 404 for ' + url)
    },
    cwd: async () => 'C:/audit-dir',
    runtimeVersion: async () => runtime,
    now: () => 1700000000000,
    makeId: () => 'audit-' + (serial += 1),
  })
  return { state, runner }
}

/** Tell every listener about an event the review session published. */
function publish(state, session, event) {
  for (const handler of state.handlers.slice()) handler(session, event)
}

// -------------------------------------------------- live model selection

{
  const { runner } = makeEngine()
  deepEqual(await runner.models(), {
    models: Object.entries(MODEL_CATALOG).flatMap(([provider, models]) => models.map((model) => ({
      provider, model: model.id, name: model.name, efforts: model.reasoning?.efforts || [],
    }))),
    defaultSelection: DEFAULT_SELECTION,
  })
  const answer = await runner.models()
  answer.defaultSelection.reasoningEffort = 'low'
  answer.models[0].efforts[0].name = 'changed by caller'
  equal((await runner.models()).defaultSelection.reasoningEffort, 'high', 'catalog results do not mutate the global default')
  equal((await runner.models()).models[0].efforts[0].name, 'Low', 'catalog results do not mutate registry metadata')
}

{
  const llm = modelRegistry()
  const resolved = []
  llm.listProviders = () => [{ id: 'broken' }, { id: 'custom' }]
  llm.listModels = async (provider) => {
    if (provider === 'broken') throw new Error('offline')
    return [{ id: 'deepseek-flash', name: 'Custom Flash' }]
  }
  llm.resolveModelInfo = async (provider, model) => {
    resolved.push([provider, model])
    return { reasoning: { efforts: [{ id: 'configured', name: 'Configured', description: 'private metadata' }] } }
  }
  const { state, runner } = makeEngine({ llm })
  deepEqual((await runner.models()).models, [{
    provider: 'custom', model: 'deepseek-flash', name: 'Custom Flash', efforts: [{ id: 'configured', name: 'Configured' }],
  }])
  deepEqual(resolved, [['custom', 'deepseek-flash']])
  await runner.start({ target: 'dsh-note', selection: { provider: 'custom', model: 'deepseek-flash', reasoningEffort: 'configured' } })
  equal(state.created.length, 1, 'validation uses resolved reasoning metadata as the DSH catalog does')
  await rejects(runner.start({ target: 'dsh-note', selection: { provider: 'custom', model: 'deepseek-flash', reasoningEffort: 'thorough' } }), /reasoningEffort/)
}

{
  const { state, runner } = makeEngine()
  const selections = [
    undefined,
    { provider: 'custom', model: 'deepseek-flash', reasoningEffort: 'thorough' },
    { provider: 'custom', model: 'deepseek-flash', reasoningEffort: 'off' },
    { provider: 'custom', model: 'deepseek-flash' },
    { provider: 'custom', model: 'plain' },
    { provider: 'deepseek-official', model: 'deepseek-flash' },
  ]
  const audits = await Promise.all(selections.map((selection) => runner.start({ target: 'dsh-note', selection })))
  for (const [index, audit] of audits.entries()) {
    const selection = selections[index] || DEFAULT_SELECTION
    const created = state.created.find((entry) => entry.agent.id === audit.session.id)
    deepEqual(created.options.agentOptions, { provider: selection.provider, model: selection.model })
    const hooks = created.hooks
    const inherited = { provider: selection.provider, model: selection.model, reasoningEffort: 'high', extra: true }
    const request = await hooks[0].handler({ agent: { session: { requestHeader: () => undefined } } }, async () => inherited)
    deepEqual(request, { ...selection, extra: true })
    equal(inherited.reasoningEffort, 'high', 'the request hook does not mutate upstream request data')
    const other = { provider: 'another', model: 'another', reasoningEffort: 'keep' }
    deepEqual(await hooks[0].handler({ agent: {} }, async () => other), other)
  }
  deepEqual((await runner.models()).defaultSelection, DEFAULT_SELECTION)
}

{
  const writes = []
  const { state, runner } = makeEngine({ store: { read: async () => [], write: async (records) => { writes.push(records) } } })
  const invalid = [
    null, false, 'custom', [], {}, { provider: 'custom' }, { model: 'plain' },
    { provider: '', model: 'plain' }, { provider: 42, model: 'plain' },
    { provider: 'custom', model: [] }, { provider: 'custom', model: ' ' },
    { provider: 'unknown', model: 'plain' }, { provider: 'custom', model: 'unknown' },
    { provider: 'custom', model: 'plain', reasoningEffort: 'high' },
    ...['high', '', null, 42, false, {}, []].map((reasoningEffort) => ({ provider: 'custom', model: 'deepseek-flash', reasoningEffort })),
  ]
  for (const selection of invalid) {
    await rejects(runner.start({ target: 'dsh-note', selection }), /selection|provider|model|reasoningEffort/)
  }
  equal(state.requests.length, 0, 'invalid selections fetch no source')
  equal(state.created.length, 0, 'invalid selections open no sessions')
  equal(state.installs.length, 0, 'invalid selections install nothing')
  equal(writes.length, 0, 'invalid selections write no history')
  equal((await runner.list()).audits.length, 0, 'invalid selections create no audit records')
}

{
  const { state, runner } = makeEngine({ llm: null, model: null })
  deepEqual(await runner.models(), { models: [], defaultSelection: null })
  await rejects(runner.start({ target: 'dsh-note', selection: { provider: 'custom', model: 'plain' } }), /llm/)
  equal(state.created.length, 0, 'an unavailable registry cannot silently bypass validation')
  const explicit = makeEngine({ model: null })
  equal((await explicit.runner.start({ target: 'dsh-note', selection: { provider: 'custom', model: 'plain' } })).state,
    'running', 'explicit models work without a global default')
  for (const model of [
    { provider: 'missing', model: 'plain' },
    { provider: 'custom', model: 'plain', reasoningEffort: 'high' },
  ]) {
    const invalidDefault = makeEngine({ model })
    await rejects(invalidDefault.runner.start({ target: 'dsh-note' }), /provider|reasoningEffort/)
    equal(invalidDefault.state.created.length, 0, 'default selections are validated too')
  }
}

// -------------------------------------------------- editable audit guidance

{
  const { state, runner } = makeEngine()
  const prompts = ['  重点检查网络请求。\n逐项说明风险。  ', '审'.repeat(20000), undefined, '', ' \t\n\u3000']
  const audits = await Promise.all(prompts.map((prompt) => runner.start({ target: 'dsh-note', prompt, mode: 'review' })))
  for (const [index, audit] of audits.entries()) {
    const session = state.created.find((entry) => entry.agent.id === audit.session.id)
    const text = session.agent.followups[0].content[0].text
    const expected = index < 2 ? prompts[index] : DEFAULT_AUDIT_INSTRUCTIONS
    assert(text.includes(expected), 'each concurrent session receives its own guidance or the default')
    if (index < 2) assert(!text.includes(DEFAULT_AUDIT_INSTRUCTIONS), 'custom guidance replaces the default workflow')
    for (const required of [
      '`auditId` 必须是 `' + audit.auditId + '`', AUDIT_TOOL_NAME,
      'dsh-note @ 1.2.3', 'https://github.com/example/dsh-note', 'postinstall',
      '本机 DSH 版本', '仅审核', '只汇报一次',
      '不要修改任何文件', '不要自己安装插件', '不要执行仓库里的代码',
    ]) {
      assert(text.includes(required), 'a session always receives host-owned context: ' + required)
    }
  }
}

{
  const writes = []
  const { state, runner } = makeEngine({ store: { read: async () => [], write: async (records) => { writes.push(records) } } })
  const invalidPrompts = [null, false, 42, {}, [], new String('text'), 'x'.repeat(20001), ' '.repeat(20001)]
  for (const prompt of invalidPrompts) {
    let refused = ''
    try { await runner.start({ target: 'dsh-note', prompt }) } catch (error) { refused = error.message }
    assert(typeof prompt === 'string' ? /prompt.*20000/.test(refused) : /prompt.*字符串/.test(refused),
      'invalid guidance rejects with a useful validation error')
  }
  equal(state.requests.length, 0, 'invalid guidance triggers no source fetch')
  equal(state.created.length, 0, 'invalid guidance opens no session')
  equal(state.installs.length, 0, 'invalid guidance starts no install')
  equal(writes.length, 0, 'invalid guidance writes no history')
  equal((await runner.list()).audits.length, 0, 'invalid guidance creates no audit record')
}

// -------------------------------------------------- the review really starts

{
  const { state, runner } = makeEngine()
  const first = await runner.start({ target: 'dsh-note' })
  equal(first.state, 'running', 'an audit starts running')
  equal(first.plugin.name, 'dsh-note', 'the npm name comes off the resolved target')
  equal(first.plugin.version, '1.2.3', 'the latest version is resolved')
  assert(first.plugin.repo.indexOf('github.com/example/dsh-note') >= 0,
    'the repository is resolved, because that is where the review reads code')
  equal(first.plugin.spec, 'dsh-note@1.2.3', 'the spec is what the installer takes')
  assert(first.findings.some((finding) => finding.level === 'warn' && finding.detail.indexOf('postinstall') >= 0),
    'the manifest\'s own install script is carried into the audit as a warning')
  equal(state.requests.length, 1, 'one registry read answers the whole resolution')
  equal(state.created.length, 1, 'one review session is opened')
  equal(state.created[0].options.meta.cwd, 'C:/audit-dir', 'the session works in the audit directory')
  equal(state.created[0].options.meta.workspace, undefined, 'and joins no workspace')
  equal(state.created[0].options.meta.agentPreset, undefined,
    'the audit mounts no preset: its tools are the three source tools plus the verdict channel')
  // The model selection is not decoration: the profile's persona renders
  // {{model}} out of `agent.options.model`, so a session created without one
  // cannot assemble its prompt and the whole turn fails on the first message.
  equal(state.created[0].options.agentOptions.provider, 'deepseek-official',
    'the review session is created on the profile\'s own provider')
  equal(state.created[0].options.agentOptions.model, 'deepseek-flash',
    'and on its own model, which is what {{model}} renders')
  equal(typeof state.created[0].options.setup, 'function', 'creation also installs the session\'s own selection')
  equal(state.prepared.length, 1, 'the host prepared exactly one source snapshot')
  equal(first.source.artifactSha256, 'a'.repeat(64), 'the record carries the audited source digest')
  const registered = state.created[0].toolLog.registered.map((definition) => definition.name)
  deepEqual(registered, ['audit_source_list', 'audit_source_read', 'audit_source_grep'],
    'the session gets the three data-only source tools')
  deepEqual(state.created[0].toolLog.restricted[0], { allow: ['report_plugin_audit'] },
    'every global tool except the verdict channel is hidden from the session')
  equal(state.created[0].toolLog.guards.length, 1, 'the session also installs its own execution guard')
  equal(state.created[0].toolLog.guards[0]({ name: 'audit_source_read' }), undefined,
    'the scoped guard allows a source tool')
  assert(String(state.created[0].toolLog.guards[0]({ name: 'bash' })).indexOf('不可用') >= 0,
    'the scoped guard denies a shell tool')
  equal(String(first.session.id), String(state.created[0].agent.id), 'the record carries the session the card can open')
  const message = state.created[0].agent.followups[0]
  equal(message.role, 'user', 'the review session is driven by a user message')
  const text = message.content[0].text
  assert(text.indexOf(first.auditId) >= 0, 'the prompt names the audit id the verdict must carry')
  assert(text.indexOf(AUDIT_TOOL_NAME) >= 0, 'the prompt names the tool to report with')
  assert(text.indexOf('源码快照') >= 0, 'the prompt describes the host-prepared snapshot')
  assert(text.indexOf('audit_source_read') >= 0, 'the prompt names the only file tool the session has')
  assert(text.indexOf('a'.repeat(64)) >= 0, 'the prompt carries the digest the verdict is tied to')
  assert(text.indexOf('没有 shell') >= 0, 'the prompt states that no shell is available')
  assert(text.indexOf('raw.githubusercontent.com') === -1, 'the session is not told to fetch source over the network')

  // The session's own events are the progress line.
  const session = state.created[0].agent.session
  publish(state, session, { type: 'turn/start' })
  equal((await runner.status({ auditId: first.auditId })).stage, 'reading', 'a started turn shows in the record')
  publish(state, session, { type: 'tool/call', data: { name: 'audit_source_read' } })
  equal((await runner.status({ auditId: first.auditId })).detail.indexOf('audit_source_read') >= 0, true, 'the tool being called is named')
  publish(state, { id: 'someone-else' }, { type: 'turn/end' })
  equal((await runner.status({ auditId: first.auditId })).stage, 'tool', 'another session\'s events do not move this audit')

  // The verdict channel belongs to that session.
  let refused = ''
  try {
    await runner.report({ auditId: first.auditId, verdict: 'safe', summary: '看着没事。' }, { agent: { id: 'someone-else' } })
  } catch (error) { refused = error.message }
  assert(refused.indexOf('另一个会话') >= 0, 'a report from another session is refused')

  const safe = await runner.report({
    auditId: first.auditId,
    verdict: 'safe',
    summary: '读完了入口与依赖，没有发现可疑行为。',
    findings: [{ level: 'info', title: '入口只做 IPC 转发', ref: 'lib/index.js:12' }],
  }, { agent: { id: first.session.id } })
  equal(safe.verdict, 'safe', 'the tool answers with the verdict it recorded')
  assert(String(safe.text).indexOf('不会自动安装') >= 0, 'a safe verdict tells the session it is not installed automatically')
  await tick()
  await tick()
  equal(state.installs.length, 0, 'a safe verdict does not install by itself')
  const waiting = await runner.status({ auditId: first.auditId })
  equal(waiting.state, 'safe', 'the record waits at safe for the user')
  const installed = await runner.decide({ auditId: first.auditId, decision: 'install' })
  await tick()
  equal(state.installs.length, 1, 'the user can install from the record')
  equal(state.installs[0].spec, 'dsh-note@1.2.3', 'the install uses the resolved spec')
  equal(state.installs[0].options.requestId, first.auditId, 'and carries the audit id as its request id')
  equal(installed.state, 'installed', 'the record ends installed')
  equal(installed.installed, true, 'and says so in the field the card reads')
  equal(installed.verdict, 'safe', 'the verdict is kept')
  assert(installed.summary.indexOf('入口与依赖') >= 0, 'and so is the summary behind it')
  equal(installed.findings.length, 2, 'the evidence keeps both the manifest signal and what the review reported')
  assert(installed.findings.some((finding) => finding.ref === 'lib/index.js:12'), 'and the reported evidence is in it')
  equal(installed.source.artifactSha256, 'a'.repeat(64), 'the record still names the audited artifact')

  let twice = ''
  try {
    await runner.report({ auditId: first.auditId, verdict: 'warn', summary: '再报一次。' }, { agent: { id: first.session.id } })
  } catch (error) { twice = error.message }
  assert(twice.length > 0, 'an audit reports once')

  let empty = ''
  try { await runner.start({ target: '   ' }) } catch (error) { empty = error.message }
  assert(empty.length > 0, 'an empty target is refused with a reason')
}

// ------------------------------------------- source preparation and capability guard

{
  const { state, runner } = makeEngine({
    prepareSource: async () => { throw new Error('registry unreachable') },
  })
  const failed = await runner.start({ target: 'dsh-note' })
  equal(failed.state, 'failed', 'a failed source snapshot fails the audit before a session is opened')
  equal(failed.stage, 'source-failed', 'and says which stage failed')
  assert(failed.detail.indexOf('registry unreachable') >= 0, 'quoting the reason the snapshot gave')
  equal(failed.source, null, 'no source is recorded when none was prepared')
  equal(state.created.length, 0, 'no review session is opened without a snapshot')
}

{
  const { state, runner } = makeEngine({ withoutTools: true })
  const audit = await runner.start({ target: 'dsh-note' })
  equal(audit.state, 'failed', 'a session without a controllable tool registry is refused')
  equal(audit.stage, 'session-failed', 'and says the session failed to start')
  assert(audit.detail.indexOf('工具注册表') >= 0, 'quoting the missing capability')
  equal(state.created.length, 1, 'the creation was attempted')
  equal(state.created[0].agent.followups.length, 0, 'no prompt is delivered to an unrestricted session')
}

{
  const { state, runner } = makeEngine()
  const audit = await runner.start({ target: 'dsh-note' })
  const agent = state.created[0].agent
  equal(runner.isAuditSession(agent), true, 'the live audit agent is recognized')
  equal(runner.isAuditSession({ id: 'someone-else' }), false, 'another agent is not')
  assert(String(runner.guard({ agent, name: 'bash' })).indexOf('不可用') >= 0,
    'a shell call is denied at execution')
  assert(String(runner.guard({ agent, name: 'web_fetch' })).indexOf('不可用') >= 0,
    'a network call is denied at execution')
  equal(runner.guard({ agent, name: 'audit_source_read' }), undefined, 'a source tool is allowed')
  equal(runner.guard({ agent, name: 'report_plugin_audit' }), undefined, 'the verdict tool is allowed')
  equal(runner.guard({ agent: { id: 'other' }, name: 'bash' }), undefined,
    'the guard does not touch sessions that are not audits')
  equal((await runner.status({ auditId: audit.auditId })).source.kind, 'npm',
    'the record exposes the audited source metadata')
}

{
  const unpinned = fakeSnapshot()
  unpinned.source = { ...unpinned.source, pinned: false }
  const { state, runner } = makeEngine({ prepareSource: async () => unpinned })
  const audit = await runner.start({ target: 'dsh-note' })
  await runner.report({ auditId: audit.auditId, verdict: 'safe', summary: '看着没事。' },
    { agent: { id: audit.session.id } })
  const refused = await runner.decide({ auditId: audit.auditId, decision: 'install' })
  equal(refused.state, 'failed', 'an unpinned source is not installed')
  equal(refused.stage, 'source-unpinned', 'the record says why the install stopped')
  assert(refused.detail.indexOf('不可变版本') >= 0, 'quoting the reason')
  equal(state.installs.length, 0, 'nothing reached the installer')
}

{
  const pinned = fakeSnapshot()
  pinned.source = {
    ...pinned.source,
    kind: 'github',
    label: 'owner/repo@abc',
    ref: 'a'.repeat(40),
    installSpec: 'github:owner/repo#' + 'a'.repeat(40),
    pinned: true,
  }
  let verified = 0
  pinned.verify = async () => { verified += 1; return { ok: false, reason: 'should not be called' } }
  const { state, runner } = makeEngine({ prepareSource: async () => pinned })
  const audit = await runner.start({ target: 'dsh-note' })
  await runner.report({ auditId: audit.auditId, verdict: 'safe', summary: '看着没事。' },
    { agent: { id: audit.session.id } })
  const installed = await runner.decide({ auditId: audit.auditId, decision: 'install' })
  equal(installed.state, 'installed', 'a pinned artifact installs')
  equal(state.installs[0].spec, 'github:owner/repo#' + 'a'.repeat(40), 'the install uses the pinned source spec')
  equal(verified, 0, 'a pinned source is not re-fetched before install')
}

// --------------------------------------------- warn waits, unsafe refuses

{
  const { state, runner } = makeEngine()
  const warned = await runner.start({ target: 'dsh-note' })
  await runner.report({ auditId: warned.auditId, verdict: 'warn', summary: '装了 postinstall 脚本。' },
    { agent: { id: warned.session.id } })
  await tick()
  equal(state.installs.length, 0, 'a warn verdict does not install by itself')
  equal((await runner.status({ auditId: warned.auditId })).state, 'warn', 'the record waits at warn')
  const accepted = await runner.decide({ auditId: warned.auditId, decision: 'install' })
  equal(state.installs.length, 1, 'the user can accept the risk and install')
  equal(accepted.state, 'installed', 'and the record ends installed')

  const unsafe = await runner.start({ target: 'dsh-note' })
  await runner.report({ auditId: unsafe.auditId, verdict: 'unsafe', summary: '把 ~/.dsh 里的令牌发到一个陌生域名。' },
    { agent: { id: unsafe.session.id } })
  await tick()
  equal(state.installs.length, 1, 'an unsafe verdict does not install')
  let refused = ''
  try { await runner.decide({ auditId: unsafe.auditId, decision: 'install' }) } catch (error) { refused = error.message }
  assert(refused.indexOf('恶意') >= 0, 'installing it is refused with the reason')
  equal(state.installs.length, 1, 'and nothing was installed')
  equal((await runner.status({ auditId: unsafe.auditId })).state, 'unsafe', 'the record still says unsafe')
  const declined = await runner.decide({ auditId: unsafe.auditId, decision: 'decline' })
  equal(declined.state, 'declined', 'declining is recorded')
  let unknown = ''
  try { await runner.decide({ auditId: 'nope', decision: 'install' }) } catch (error) { unknown = error.message }
  assert(unknown.length > 0, 'deciding an audit that does not exist is an error, not a silent no-op')
}

// ------------------------------------------------- what an install answered

{
  equal(describeInstall({ application: 'restart-required' }).state, 'installed',
    'a restart-required install counts as installed')
  assert(describeInstall({ application: 'restart-required' }).detail.indexOf('重启') >= 0,
    'and says a restart is needed')
  assert(describeInstall({ application: 'applied', warnings: ['x'] }).detail.indexOf('警告') >= 0,
    'warnings the manager returned are not swallowed')
  const broken = describeInstall({
    application: 'failed',
    error: {
      code: 'incompatible-version',
      incompatible: [{ name: '@deepseek-ai/dsh-tools', runtimeVersion: '0.2.1-alpha.3' }],
    },
  })
  equal(broken.state, 'failed', 'a failed install is a failure')
  assert(broken.detail.indexOf('incompatible-version') >= 0, 'the failure names the code DSH gave')
  assert(broken.detail.indexOf('@deepseek-ai/dsh-tools') >= 0, 'and the peer that did not fit')
  equal(describeInstall({ application: 'cancelled' }).state, 'declined', 'a cancelled install is not an install')

  const { state, runner } = makeEngine()
  state.installResult = {
    application: 'failed',
    error: { code: 'incompatible-version', incompatible: [{ name: '@deepseek-ai/dsh-tools', runtimeVersion: '0.2.1-alpha.3' }] },
  }
  const audit = await runner.start({ target: 'dsh-note' })
  await runner.report({ auditId: audit.auditId, verdict: 'safe', summary: '没问题。' }, { agent: { id: audit.session.id } })
  const failed = await runner.decide({ auditId: audit.auditId, decision: 'install' })
  equal(failed.state, 'failed', 'an install that fails leaves the audit failed')
  assert(failed.detail.indexOf('incompatible-version') >= 0, 'with the reason DSH gave')
  equal(failed.installed, false, 'and the card is not told it was installed')
}

// ------------------------------------------- a review that never reports

{
  const { state, runner } = makeEngine()
  const audit = await runner.start({ target: 'dsh-note' })
  const record = state.created[0]
  // The end of the review is the end of its *turn*: the runner waits for the turn
  // to start before it waits for the agent to go idle, so a session that never
  // answers is only failed after it has actually had its turn.
  publish(state, { id: audit.session.id }, { type: 'turn/start' })
  record.events.push({
    type: 'assistant/message',
    data: { content: [{ type: 'text', text: '我没能确定它做了什么。' }] },
  })
  record.idle()
  await tick()
  await tick()
  const ended = await runner.status({ auditId: audit.auditId })
  equal(ended.state, 'failed', 'a review that ends without a verdict fails')
  equal(ended.stage, 'no-verdict', 'and says which state it is in')
  assert(ended.detail.indexOf('我没能确定') >= 0, 'quoting the last thing the session said')
  equal(state.flushed, 1, 'the session log is flushed, so the stock sidebar can list it')
}

// ---------------------------------- a slow session is not a failed session
//
// `agent.whenIdle()` resolves at once when the agent has nothing in flight, and it
// used to be awaited before the prompt was delivered — so every review was declared
// "no verdict" the moment it started, and then flipped to its real verdict when the
// report arrived. What the runner waits for is the session's first turn.

{
  const { state, runner } = makeEngine({ turnStartTimeoutMs: 50 })
  const audit = await runner.start({ target: 'dsh-note' })
  await tick()
  await tick()
  equal((await runner.status({ auditId: audit.auditId })).state, 'running',
    'a session that has not started its turn yet is still running')
  const record = state.created[0]
  publish(state, { id: audit.session.id }, { type: 'turn/start' })
  record.idle()
  await tick()
  await tick()
  const ended = await runner.status({ auditId: audit.auditId })
  equal(ended.state, 'failed', 'and once that turn ends without a report, it is failed')
}

{
  const { runner } = makeEngine({ turnStartTimeoutMs: 5 })
  const audit = await runner.start({ target: 'dsh-note' })
  await new Promise((resolve) => setTimeout(resolve, 25))
  await tick()
  const ended = await runner.status({ auditId: audit.auditId })
  equal(ended.state, 'failed', 'a session that never starts a turn is given up on')
  assert(ended.detail.indexOf('report_plugin_audit') >= 0, 'with the reason: it never reported')
}

// ---------------------------------------------------------- the tool itself

{
  const { state, runner } = makeEngine()
  const tool = runner.tool()
  equal(tool.name, 'report_plugin_audit', 'the tool is the verdict channel')
  equal(tool.parameters.required.join(','), 'auditId,verdict,summary', 'it requires an id, a verdict and a summary')
  equal(tool.parameters.properties.verdict.enum.join(','), 'safe,warn,unsafe', 'the verdict is one of three')
  const audit = await runner.start({ target: 'dsh-note' })
  const answered = await tool.execute(
    { auditId: audit.auditId, verdict: 'warn', summary: '需要用户确认。' },
    { agent: { id: audit.session.id } },
  )
  equal(answered.verdict, 'warn', 'calling the tool records the verdict')
  equal((await runner.status({ auditId: audit.auditId })).state, 'warn', 'and the record shows it')
  const rendered = tool.output.render({}, answered)
  equal(rendered[0].type, 'text', 'the value the model sees is text')
  assert(rendered[0].text.length > 0, 'and it says something')
  equal((await runner.list()).audits.length, 1, 'list() answers with the audits this process ran')
  equal((await runner.list()).audits[0].auditId, audit.auditId, 'newest first')
  equal((await runner.status({})).auditId, audit.auditId, 'no id means the newest audit')
  equal(await runner.status({ auditId: 'nope' }), null, 'an unknown id answers null')
  equal(state.created.length, 1, 'and no second session was opened')
}

// ------------------------------------------------- version compatibility
//
// DSH refuses to install a package whose declared harness range does not contain
// the running version, so the audit answers that *before* a session is spent and
// before the user waits for an install that cannot work. It is the same check the
// market performs; here it is the card's own.

{
  const { state, runner } = makeEngine({ runtimeVersion: '0.2.1-alpha.3' })
  const audit = await runner.start({ target: 'dsh-old' })
  equal(audit.compatibility.compatible, false, 'a peer range this runtime is not in is reported as incompatible')
  equal(audit.compatibility.runtime, '0.2.1-alpha.3', 'and the version it was measured against travels with it')
  const versionFinding = audit.findings.find((entry) => entry.title === '版本不相容')
  assert(versionFinding && versionFinding.level === 'error', 'the verdict carries an error-level finding')
  assert(state.created[0].agent.followups[0].content[0].text.includes('本机 DSH 版本'),
    'the review session is told which runtime it is reviewing for')
  const tool = runner.tool()
  await tool.execute(
    { auditId: audit.auditId, verdict: 'warn', summary: '版本不相容，但代码本身看起来正常。' },
    { agent: { id: audit.session.id } },
  )
  let refused = ''
  try {
    await runner.decide({ auditId: audit.auditId, decision: 'install' })
  } catch (error) {
    refused = String(error.message || error)
  }
  assert(refused.includes('版本范围装不上本机'), 'installing an incompatible package is refused with a reason')
  equal(state.installs.length, 0, 'and nothing was handed to the installer')
  await runner.decide({ auditId: audit.auditId, decision: 'install', override: true })
  await tick()
  equal(state.installs.length, 1, 'an explicit override still installs, because the user may know better')
}

// An unknown runtime is not an incompatible one: the card says it could not tell.
{
  const { runner } = makeEngine({ runtimeVersion: '' })
  const audit = await runner.start({ target: 'dsh-old' })
  equal(audit.compatibility.compatible, null, 'without a runtime version the answer is "cannot tell"')
  equal(audit.findings.find((entry) => entry.title === '版本不相容'), undefined, 'and nothing is called incompatible')
}

// ------------------------------------------------------------------ sessions
//
// The failure the first live run hit: a review session created without a model
// selection cannot assemble the profile's persona (`{{model}}` has no value), so
// the whole turn dies on its first message. The runner therefore refuses to open
// a session it cannot run, and leaves no half-made session behind.

{
  const { state, runner } = makeEngine({ model: null })
  await rejects(runner.start({ target: 'dsh-note' }), /默认模型/)
  equal((await runner.list()).audits.length, 0, 'a missing default is refused before creating an audit')
  equal(state.created.length, 0, 'no session is created without a model to run it on')
}

// The profile's own selection is carried onto the session's requests until it has
// a header of its own, so the reasoning effort it was created with is not lost.
{
  const { state, runner } = makeEngine()
  await runner.start({ target: 'dsh-note' })
  const hooks = state.created[0].hooks
  equal(hooks.length, 1, 'creation registers one request hook')
  equal(hooks[0].event, 'agent/request', 'on the request waterfall')
  const fresh = { session: { requestHeader: () => undefined } }
  const resolved = await hooks[0].handler({ agent: fresh }, async () => ({
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low',
  }))
  equal(resolved.reasoningEffort, 'high', 'the profile\'s reasoning effort is applied to the first request')
  const recorded = { session: { requestHeader: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) } }
  const kept = await hooks[0].handler({ agent: recorded }, async () => ({
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low',
  }))
  equal(kept.reasoningEffort, 'low', 'once the session has its own header the hook leaves it alone')
}

// --------------------------------------------------------- review only
//
// Review-then-install is the default, but a review on its own is worth having:
// the user can ask for several, keep them as records, and decide later. No mode
// installs a `safe` verdict by itself; this one simply never asked to, and the
// record still offers the install afterwards.
{
  const { state, runner } = makeEngine()
  const audit = await runner.start({ target: 'dsh-note', mode: 'review' })
  equal(audit.mode, 'review', 'the mode an audit was started with travels with it')
  const tool = runner.tool()
  const reported = await tool.execute(
    { auditId: audit.auditId, verdict: 'safe', summary: '源码正常，没有发现问题。' },
    { agent: { id: audit.session.id } },
  )
  await tick()
  equal(state.installs.length, 0, 'a review-only audit clears without installing anything')
  assert(String(reported.text).indexOf('不会自动安装') >= 0, 'and the session is told nothing was installed')
  const installed = await runner.decide({ auditId: audit.auditId, decision: 'install' })
  await tick()
  equal(state.installs.length, 1, 'the record itself can still be installed afterwards')
  equal(installed.state, 'installed', 'and the record says so')
}

// A mode that is neither of the two is the default, never a third state.
{
  const { runner } = makeEngine()
  const audit = await runner.start({ target: 'dsh-note', mode: 'something-else' })
  equal(audit.mode, 'install', 'an unknown mode falls back to review-then-install')
}

// ------------------------------------------------- the history across runs
//
// The card has a history pane, so the records have to outlive the process that
// made them: the runner reads the file before its first answer and writes every
// change back through it.
{
  const saved = {
    audits: [{
      id: 'audit-from-last-time',
      state: 'warn',
      stage: 'verdict',
      detail: '',
      mode: 'install',
      target: { input: 'dsh-note', kind: 'npm', name: 'dsh-note', version: '1.2.3', spec: 'dsh-note@1.2.3', repo: 'acme/dsh-note' },
      session: { id: 'plugin-audit-from-last-time', title: 'review: dsh-note' },
      findings: [{ level: 'warn', title: 'postinstall runs a shell script' }],
      verdict: 'warn',
      summary: '装了 postinstall 脚本。',
      startedAt: 1000,
      updatedAt: 2000,
    }],
  }
  const writes = []
  const { runner } = makeEngine({ store: { read: async () => saved.audits, write: async (records) => { writes.push(records) } } })
  const list = await runner.list()
  equal(list.audits.length, 1, 'a record left by the previous process is part of the history')
  equal(list.audits[0].auditId, 'audit-from-last-time', 'and keeps the id the card remembers')
  equal(list.audits[0].findings.length, 1, 'with the evidence it was decided on')
  equal(runner.isAuditSession({ id: 'plugin-audit-from-last-time' }), true,
    'a restored audit session is still recognized by the execution guard')
  assert(typeof runner.guard({ agent: { id: 'plugin-audit-from-last-time' }, name: 'bash' }) === 'string',
    'and a shell call on it is still denied')
  const fresh = await runner.start({ target: 'dsh-note' })
  await tick()
  assert(writes.length >= 1, 'starting an audit writes the history back')
  const last = writes[writes.length - 1]
  equal(last.length, 2, 'the file holds the old record and the new one')
  equal(last[0].id, fresh.auditId, 'newest first, and the file keeps the registrys own field name')
}

// A history that cannot be read is an empty history, not a card that breaks.
{
  const { runner } = makeEngine({
    store: { read: async () => { throw new Error('no file yet') }, write: async () => {} },
  })
  const list = await runner.list()
  equal(list.audits.length, 0, 'an unreadable history answers with nothing')
}

if (failures > 0) {
  console.error('audit-runner: ' + failures + ' assertion(s) failed')
  process.exit(1)
}
console.log('audit-runner: all assertions passed')
