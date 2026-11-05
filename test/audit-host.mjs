/**
 * test/audit-host.mjs — the host half of the plugin-audit card, without a
 * network and without the engine.
 *
 * `lib/host/audit.js` is a pure module on purpose: parsing a target, reading a
 * manifest for the signals worth knowing, validating what an audit session
 * reported, and keeping the audits. Everything that touches the world —
 * the registry, the app's HTTP server, the session, the installer — is injected
 * by the caller, so this suite can pin the behaviour that matters:
 *
 *  - the four identifier shapes a user actually types, and the exact spec DSH's
 *    installer gets;
 *  - that a registry failure is reported with its reason instead of becoming an
 *    empty manifest (a card that shows "no problems found" because the fetch
 *    failed is worse than one that shows nothing);
 *  - that an install-time script is surfaced as evidence, not as a verdict;
 *  - that a model answer is untrusted input: an illegal verdict is refused, an
 *    unknown level degrades, and the strings are bounded;
 *  - that one audit reports once, and that a `warn` needs the user's answer
 *    while a `safe` does not.
 */
import assert from 'node:assert/strict'
import { DEFAULT_AUDIT_INSTRUCTIONS as sharedInstructions } from '../lib/audit-instructions.js'
import {
  AUDIT_LEVELS,
  AUDIT_SCENARIOS,
  AUDIT_STATES,
  AUDIT_TOOL_NAME,
  AUDIT_VERDICTS,
  DEFAULT_AUDIT_INSTRUCTIONS,
  auditToolParameters,
  buildAuditPrompt,
  compareVersions,
  compatibilityCheck,
  createAuditRegistry,
  needsConfirmation,
  normalizeVerdict,
  parseTarget,
  resolveTarget,
  satisfiesRange,
  staticFindings,
  verdictAcknowledgement,
  versionFromEntry,
} from '../lib/host/audit.js'

// ------------------------------------------------------------------ harness

/** A packument for one package, in the shape the registry answers with. */
function packument(name, versions) {
  const map = {}
  for (const version of Object.keys(versions)) map[version] = Object.assign({ name, version }, versions[version])
  return { name, 'dist-tags': { latest: Object.keys(versions).pop() }, versions: map }
}

/**
 * A `fetchJson` that answers from a URL map and records every URL it was asked
 * for, so a test can assert *which* registry was tried.
 */
function fixtureFetch(map) {
  const urls = []
  return {
    urls,
    async fetchJson(url) {
      urls.push(url)
      const answer = map[url]
      if (answer === undefined) throw new Error('HTTP 404 for ' + url)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

// ------------------------------------------------------------- parseTarget

const npm = parseTarget('dsh-note')
assert.equal(npm.kind, 'npm')
assert.equal(npm.name, 'dsh-note')
assert.equal(npm.spec, 'dsh-note', 'a bare name goes to the installer as it was typed')
assert.equal(npm.version, null)

const pinned = parseTarget('dsh-note@1.2.3')
assert.equal(pinned.name, 'dsh-note')
assert.equal(pinned.version, '1.2.3')
assert.equal(pinned.spec, 'dsh-note@1.2.3', 'a pinned package keeps its version')

const scoped = parseTarget('@deepseek-ai/dsh-app-boot@0.2.1')
assert.equal(scoped.name, '@deepseek-ai/dsh-app-boot')
assert.equal(scoped.version, '0.2.1')

const shorthand = parseTarget('SomeOwner/some-plugin')
assert.equal(shorthand.kind, 'github')
assert.equal(shorthand.full, 'SomeOwner/some-plugin')
assert.equal(shorthand.repo, 'https://github.com/SomeOwner/some-plugin')
assert.equal(shorthand.spec, 'github:SomeOwner/some-plugin', 'a shorthand becomes a github spec, not a package name')

const webUrl = parseTarget('https://github.com/owner/repo.git')
assert.equal(webUrl.kind, 'github')
assert.equal(webUrl.full, 'owner/repo', 'the .git suffix and the host are dropped')
assert.equal(webUrl.repo, 'https://github.com/owner/repo')

const prefixed = parseTarget('github:owner/repo')
assert.equal(prefixed.kind, 'vcs')
assert.equal(prefixed.spec, 'github:owner/repo')
assert.equal(prefixed.repo, 'https://github.com/owner/repo')

const local = parseTarget('D:\\Projects\\node\\thing')
assert.equal(local.kind, 'spec', 'a Windows path is a spec, not a package name')
assert.equal(local.name, 'thing')

const refTarget = parseTarget('owner/repo#v1.2.3')
assert.equal(refTarget.ref, 'v1.2.3', 'a GitHub shorthand can pin a ref')
assert.equal(refTarget.spec, 'github:owner/repo#v1.2.3', 'the pinned ref travels to the installer')
const refUrl = parseTarget('https://github.com/owner/repo#main')
assert.equal(refUrl.full, 'owner/repo', 'a URL hash is not part of the repository name')
assert.equal(refUrl.ref, 'main', 'a URL hash pins a ref')
const refPrefixed = parseTarget('github:owner/repo#main')
assert.equal(refPrefixed.kind, 'vcs')
assert.equal(refPrefixed.ref, 'main', 'a github: prefix keeps its ref')
assert.equal(refPrefixed.spec, 'github:owner/repo#main')

assert.throws(() => parseTarget('   '), /empty target/, 'an empty target has no default')

// ---------------------------------------------------------- staticFindings

const risky = staticFindings({
  name: 'x',
  version: '1.0.0',
  main: 'lib/index.js',
  scripts: { build: 'tsc', postinstall: 'node scripts/fetch.js' },
  dependencies: { 'some-git-dep': 'git+https://github.com/o/r.git' },
  peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0' },
})
const installWarning = risky.find((item) => item.title.includes('安装期'))
assert.ok(installWarning, 'an install-time script is surfaced')
assert.equal(installWarning.level, 'warn')
assert.equal(installWarning.ref, 'package.json#scripts')
assert.ok(installWarning.detail.includes('postinstall: node scripts/fetch.js'), 'the evidence quotes the script')
assert.equal(
  installWarning.detail.includes('build'),
  false,
  'a build script is not an install-time script',
)
assert.ok(risky.some((item) => item.title.includes('非登记表') && item.level === 'warn'), 'a git dependency is a warning')
assert.ok(risky.some((item) => item.title === '入口' && item.level === 'info'), 'the entry point is information')
assert.ok(
  risky.some((item) => item.title.includes('DSH 版本范围')),
  'the peer range is information the reader should see',
)

const clean = staticFindings({ name: 'x', version: '1.0.0', repository: { url: 'git+https://github.com/o/r.git' }, main: 'lib/index.js' })
assert.equal(
  clean.some((item) => item.level === 'warn'),
  false,
  'a package with a repository and no install script carries no warning',
)
const homeless = staticFindings({ name: 'x', version: '1.0.0' })
assert.ok(
  homeless.some((item) => item.title.includes('没有可读的源码地址') && item.level === 'warn'),
  'no repository means the audit cannot read the source, and that is said out loud',
)

// ---------------------------------------------------------- resolveTarget

const registry = 'https://registry.npmjs.org/'
const npmFetch = fixtureFetch({
  'https://registry.npmjs.org/dsh-note': packument('dsh-note', {
    '1.4.0': { repository: { url: 'git+https://github.com/o/note.git' }, description: 'notes', scripts: { postinstall: 'node x.js' } },
  }),
})
const resolvedNpm = await resolveTarget('dsh-note', { fetchJson: npmFetch.fetchJson })
assert.equal(resolvedNpm.version, '1.4.0', 'the latest version is resolved from the registry')
assert.equal(resolvedNpm.repo, 'https://github.com/o/note')
assert.equal(resolvedNpm.spec, 'dsh-note@1.4.0', 'the installer gets the resolved version')
assert.equal(resolvedNpm.source, 'https://registry.npmjs.org/dsh-note')
assert.equal(npmFetch.urls[0], 'https://registry.npmjs.org/dsh-note', 'the canonical registry is asked first')
assert.ok(
  resolvedNpm.findings.some((item) => item.title.includes('安装期')),
  'the manifest signals travel with the resolved target',
)

const pinnedFetch = fixtureFetch({
  'https://registry.npmjs.org/dsh-note': packument('dsh-note', { '1.0.0': {}, '2.0.0': {} }),
})
const resolvedPin = await resolveTarget('dsh-note@1.0.0', { fetchJson: pinnedFetch.fetchJson })
assert.equal(resolvedPin.version, '1.0.0', 'a pinned version is honoured, not the latest')
assert.equal(resolvedPin.spec, 'dsh-note@1.0.0')

const fallbackFetch = fixtureFetch({
  'https://mirrors.cloud.tencent.com/npm/dsh-note': packument('dsh-note', { '3.1.0': {} }),
})
const resolvedFallback = await resolveTarget('dsh-note', { fetchJson: fallbackFetch.fetchJson })
assert.deepEqual(
  fallbackFetch.urls,
  ['https://registry.npmjs.org/dsh-note', 'https://mirrors.cloud.tencent.com/npm/dsh-note'],
  'the mirror is tried only after the canonical registry fails',
)
assert.equal(resolvedFallback.version, '3.1.0')

const deadFetch = fixtureFetch({})
await assert.rejects(
  () => resolveTarget('dsh-note', { fetchJson: deadFetch.fetchJson }),
  /npm 登记表没有回答 dsh-note/,
  'a registry that cannot answer is a named failure, not an empty manifest',
)

const scopedFetch = fixtureFetch({
  'https://registry.npmjs.org/@scope%2Fpkg': packument('@scope/pkg', { '0.0.1': {} }),
})
const resolvedScoped = await resolveTarget('@scope/pkg', { fetchJson: scopedFetch.fetchJson })
assert.equal(resolvedScoped.version, '0.0.1', 'a scoped name is requested in its registry form')
assert.equal(scopedFetch.urls[0], 'https://registry.npmjs.org/@scope%2Fpkg')

const githubFetch = fixtureFetch({
  'https://raw.githubusercontent.com/o/r/HEAD/package.json': {
    name: 'the-plugin',
    version: '0.3.0',
    description: 'a plugin',
    repository: { url: 'https://github.com/o/r' },
  },
  'https://raw.githubusercontent.com/o/r/v1/package.json': {
    name: 'the-plugin',
    version: '0.3.0',
    description: 'a plugin',
    repository: { url: 'https://github.com/o/r' },
  },
})
const resolvedGithub = await resolveTarget('o/r', { fetchJson: githubFetch.fetchJson })
assert.equal(resolvedGithub.name, 'the-plugin', 'the repository manifest names the package')
assert.equal(resolvedGithub.version, '0.3.0')
assert.equal(resolvedGithub.spec, 'github:o/r', 'a repository is installed as a github spec')
assert.equal(resolvedGithub.findings.some((item) => item.level === 'warn'), false, 'a readable repository with a clean manifest has nothing to warn about')
const resolvedRef = await resolveTarget('o/r#v1', { fetchJson: githubFetch.fetchJson })
assert.equal(resolvedRef.spec, 'github:o/r#v1', 'resolution keeps the user-pinned ref in the install spec')
assert.equal(resolvedRef.ref, 'v1', 'and on the resolved target')

const bareFetch = fixtureFetch({})
const resolvedBare = await resolveTarget('o/r', { fetchJson: bareFetch.fetchJson })
assert.equal(resolvedBare.spec, 'github:o/r', 'an unreadable manifest does not lose the target')
assert.ok(
  resolvedBare.findings.some((item) => item.title.includes('读不到仓库根目录')),
  'and the audit is told the source could not be read',
)

// --------------------------------------------------------- verdict intake

const good = normalizeVerdict({
  verdict: 'WARN',
  summary: '  装上了，但安装期会下载东西  ',
  findings: [
    { level: 'warn', title: '下载后执行', detail: 'fetch(...).then(eval)', ref: 'lib/index.js:42' },
    { level: 'nonsense', title: '未知等级' },
    { level: 'error', detail: '没有标题也要留下' },
  ],
})
assert.equal(good.verdict, 'warn', 'the verdict is lowercased')
assert.equal(good.summary, '装上了，但安装期会下载东西')
assert.equal(good.findings.length, 3, 'a finding without a title is kept, titled by its detail')
assert.equal(good.findings[1].level, 'info', 'an unknown level degrades to info rather than failing the audit')
assert.equal(good.findings[2].title, '没有标题也要留下')

assert.throws(() => normalizeVerdict({ verdict: 'maybe', summary: 'x' }), /verdict 必须是/, 'an illegal verdict is refused')
assert.throws(() => normalizeVerdict({ verdict: 'safe', summary: '   ' }), /summary 不能为空/)
assert.throws(() => normalizeVerdict({}), /verdict 必须是/)

const capped = normalizeVerdict({
  verdict: 'safe',
  summary: 'ok',
  findings: Array.from({ length: 60 }, (unused, index) => ({ level: 'info', title: 'finding ' + index })),
})
assert.equal(capped.findings.length, 40, 'the findings are capped at what the card can draw')
const longDetail = normalizeVerdict({ verdict: 'warn', summary: 'x', findings: [{ level: 'warn', title: 't', detail: 'y'.repeat(2000) }] })
assert.ok(longDetail.findings[0].detail.length < 1300, 'a long detail is cut')
assert.ok(longDetail.findings[0].detail.endsWith('…'), 'and marked as cut')

// A warn finding has to answer four questions — what the code does, why the plugin
// has it, what it could cost, and which situation it belongs to — because that is
// what a reader needs before deciding. The fields are cut like everything else, and
// a situation outside the vocabulary degrades to `other` rather than being invented.
const withRisk = normalizeVerdict({
  verdict: 'warn',
  summary: 'x',
  findings: [{
    level: 'warn',
    title: 't',
    risk: { role: 'r'.repeat(2000), why: 'why', impact: 'impact', scenario: 'SUPPLY-CHAIN' },
  }],
})
assert.equal(withRisk.findings[0].risk.scenario, 'supply-chain', 'the situation is matched case-insensitively')
assert.equal(withRisk.findings[0].risk.why, 'why')
assert.ok(withRisk.findings[0].risk.role.length < 1300, 'the risk fields are cut like every other field')

const oddRisk = normalizeVerdict({
  verdict: 'warn',
  summary: 'x',
  findings: [{ level: 'warn', title: 't', risk: { role: 'r', why: 'w', impact: 'i', scenario: 'made-up' } }],
})
assert.equal(oddRisk.findings[0].risk.scenario, 'other', 'an unknown situation becomes other, it is never invented')

const emptyRisk = normalizeVerdict({
  verdict: 'warn',
  summary: 'x',
  findings: [{ level: 'warn', title: 't', risk: { role: '  ', why: '', impact: '', scenario: 'other' } }],
})
assert.equal(emptyRisk.findings[0].risk, undefined, 'an empty explanation is left out rather than drawn empty')
assert.ok(AUDIT_SCENARIOS.includes('supply-chain'), 'and the vocabulary the prompt offers is the one the host accepts')

// The install-time evidence carries its own explanation: a warning the card cannot
// ask a session about still has to say which situation it is.
const scriptRisk = staticFindings({ scripts: { postinstall: 'sh install.sh' } })
  .find((item) => item.level === 'warn')
assert.equal(scriptRisk.risk.scenario, 'supply-chain', 'an install script is named as a supply-chain entry, got ' + JSON.stringify(scriptRisk.risk))
assert.ok(scriptRisk.risk.role !== '' && scriptRisk.risk.impact !== '', 'and it explains its role and its cost')

// ------------------------------------------------------------- the registry

let clock = 1000
let minted = 0
const registryService = createAuditRegistry({ now: () => (clock += 10), makeId: () => 'audit-' + (minted += 1) })
const opened = registryService.start({
  target: resolvedNpm,
  findings: resolvedNpm.findings,
})
assert.equal(opened.id, 'audit-1')
assert.equal(opened.startedAt, 1010, 'the injected clock stamps the record')
assert.equal(opened.state, 'running')
assert.equal(opened.verdict, null)
assert.equal(opened.installed, false)
assert.ok(AUDIT_STATES.includes(opened.state))

assert.equal(registryService.get('nope'), null, 'an unknown audit reads as null')
assert.throws(() => registryService.status('nope'), /没有这次审核的记录/)
assert.throws(() => registryService.recordVerdict('nope', { verdict: 'safe', summary: 'x' }), /没有这次审核的记录/)
assert.throws(() => registryService.patch('nope', {}), /没有这次审核的记录/)

registryService.attachSession(opened.id, { id: 'sess-1', title: 'audit dsh-note' })
const attached = registryService.status(opened.id)
assert.equal(attached.stage, 'reading')
assert.equal(attached.session.id, 'sess-1')

const prompt = registryService.prompt(opened.id)
assert.ok(prompt.includes('audit-1'), 'the prompt carries the id the report must quote')
assert.ok(prompt.includes('https://github.com/o/note'), 'and the source to read')
assert.ok(prompt.includes('dsh-note'), 'and the name')
assert.ok(prompt.includes(AUDIT_TOOL_NAME), 'and the tool it reports through')
assert.ok(prompt.includes('postinstall'), 'and the static signals already known')
assert.ok(prompt.includes('safe') && prompt.includes('warn') && prompt.includes('unsafe'), 'and the three verdicts')
assert.ok(prompt.includes('不要执行仓库里的代码'), 'the session is told not to run what it reads')

const reported = registryService.recordVerdict(opened.id, {
  verdict: 'warn',
  summary: '安装期会下载并执行脚本',
  findings: [{ level: 'error', title: '远程代码执行', ref: 'scripts/postinstall.js:3' }],
})
assert.equal(reported.state, 'warn')
assert.equal(reported.verdict, 'warn')
assert.equal(reported.summary, '安装期会下载并执行脚本')
assert.ok(reported.findings.length >= 2, 'the reported findings join the static ones')
assert.ok(reported.findings.some((item) => item.ref === 'scripts/postinstall.js:3'))
assert.throws(() => registryService.recordVerdict(opened.id, { verdict: 'safe', summary: 'late' }), /已经汇报过/, 'one audit reports once')

assert.equal(needsConfirmation('warn'), true)
assert.equal(needsConfirmation('unsafe'), true)
assert.equal(needsConfirmation('safe'), false)
assert.ok(verdictAcknowledgement('unsafe').includes('拒绝'))
assert.ok(verdictAcknowledgement('safe').includes('不会自动安装'))

const declined = registryService.decide(opened.id, 'decline')
assert.equal(declined.state, 'declined')
const installing = registryService.decide(opened.id, 'install')
assert.equal(installing.state, 'installing')
assert.throws(() => registryService.decide(opened.id, 'maybe'), /decision 必须是/)
registryService.patch(opened.id, { state: 'installed', installed: true })
assert.equal(registryService.status(opened.id).installed, true)

const fresh = registryService.start({ target: resolvedGithub })
assert.throws(() => registryService.decide(fresh.id, 'install'), /还没有结论/, 'an audit without a verdict cannot be installed')
const listed = registryService.list()
assert.equal(listed.length, 2)
assert.equal(listed[0].id, fresh.id, 'the newest audit is first')

// A reader gets a copy: nothing handed out through an endpoint can rewrite the
// record the next reader sees.
const copy = registryService.status(opened.id)
copy.findings.push({ level: 'error', title: 'injected' })
copy.state = 'safe'
assert.equal(registryService.status(opened.id).state, 'installed')
assert.equal(
  registryService.status(opened.id).findings.some((item) => item.title === 'injected'),
  false,
  'the registry hands out copies',
)

// --------------------------------------------------------------- the tool

const parameters = auditToolParameters()
assert.deepEqual(parameters.properties.verdict.enum, AUDIT_VERDICTS, 'the tool offers exactly the three verdicts')
assert.deepEqual(parameters.properties.findings.items.properties.level.enum, AUDIT_LEVELS)
assert.deepEqual(parameters.properties.findings.items.properties.risk.properties.scenario.enum, AUDIT_SCENARIOS,
  'the tool offers exactly the situations the card can name')
assert.deepEqual(parameters.properties.findings.items.properties.risk.required.slice().sort(),
  ['impact', 'role', 'scenario', 'why'], 'a risk block must answer all four questions')
for (const field of ['auditId', 'verdict', 'summary']) {
  assert.ok(parameters.required.includes(field), 'the tool requires ' + field)
}
assert.equal(AUDIT_TOOL_NAME, 'report_plugin_audit', 'the prompt and the tool registration share one name')

const promptOf = buildAuditPrompt({ id: 'a-1', target: { input: 'x', name: 'x' }, findings: [] })
assert.ok(promptOf.includes('a-1'), 'a prompt can be written for a record without a session')

// Editable guidance is shared with the client build; context and constraints
// belong to the host even when the user replaces the entire guidance text.
{
  assert.equal(DEFAULT_AUDIT_INSTRUCTIONS, sharedInstructions, 'the host re-exports the shared default')
  assert.ok(sharedInstructions.includes('1. 取源码'), 'the default contains the review workflow')
  assert.ok(!sharedInstructions.includes('auditId'), 'the dynamic report id is not editable guidance')
  assert.ok(!sharedInstructions.includes('不要执行仓库里的代码'), 'safety constraints stay with the host')
  const audit = {
    id: 'custom-audit',
    target: { input: 'owner/plugin', name: 'plugin', version: '1.2.3', repo: 'https://github.com/owner/plugin' },
    findings: [{ level: 'warn', title: 'postinstall', detail: 'node setup.js' }],
    compatibility: { runtime: '0.2.1', incompatible: [{ name: 'dsh' }] },
    source: {
      kind: 'npm', label: 'plugin@1.2.3', ref: '1.2.3', fileCount: 2, byteCount: 42,
      artifactSha256: 'b'.repeat(64), truncated: false, anomalies: [{ code: 'symlink', path: 'bin/x' }],
    },
  }
  const defaultPrompt = buildAuditPrompt(audit)
  assert.ok(defaultPrompt.includes(sharedInstructions), 'omitting guidance preserves the default workflow')
  assert.ok(defaultPrompt.includes('源码快照'), 'the prompt names the host-prepared snapshot')
  assert.ok(defaultPrompt.includes('b'.repeat(64)), 'the prompt carries the audited digest')
  assert.ok(defaultPrompt.includes('symlink'), 'the prompt reports snapshot anomalies as evidence')
  assert.ok(defaultPrompt.includes('没有 shell'), 'the prompt states the session has no shell')
  for (const blank of ['', ' \t\r\n\u3000', ' '.repeat(20000)]) {
    assert.equal(buildAuditPrompt(audit, blank), defaultPrompt, 'blank guidance falls back to the default')
  }
  const custom = '  重点核查网络请求。\n保留缩进和换行。  '
  {
    const text = buildAuditPrompt(audit, custom)
    assert.ok(text.includes(custom), 'custom guidance retains its formatting')
    assert.ok(!text.includes(sharedInstructions), 'custom guidance replaces the default')
    for (const required of [
      'owner/plugin', 'plugin @ 1.2.3', 'https://github.com/owner/plugin',
      'postinstall：node setup.js', '本机 DSH 版本：0.2.1', '版本相容性',
      AUDIT_TOOL_NAME, '`auditId` 必须是 `custom-audit`',
      '`summary`', '`findings`', '`level`', '只汇报一次', '不确定就给 `warn`',
      '不要修改任何文件', '不要自己安装插件', '不要执行仓库里的代码',
      '只做审核',
    ]) {
      assert.ok(text.slice(text.indexOf(custom) + custom.length).includes(required), 'host appends required context or constraint: ' + required)
    }
  }
  const boundary = '审'.repeat(20000)
  assert.ok(buildAuditPrompt(audit, boundary).includes(boundary), '20000 characters are accepted intact')
  for (const invalid of [null, false, 42, {}, [], new String('text')]) {
    assert.throws(() => buildAuditPrompt(audit, invalid), /prompt.*字符串/, 'non-string guidance is rejected')
  }
  for (const tooLong of ['审'.repeat(20001), ' '.repeat(20001)]) {
    assert.throws(() => buildAuditPrompt(audit, tooLong), /prompt.*20000/, 'the limit applies before trimming')
  }
  const customRegistry = createAuditRegistry({ makeId: () => audit.id })
  customRegistry.start(audit)
  assert.ok(customRegistry.prompt(audit.id, custom).includes(custom), 'the registry forwards custom guidance')
  assert.ok(customRegistry.prompt(audit.id).includes(sharedInstructions), 'an override does not change future defaults')
}

// ------------------------------------------------- version compatibility
//
// The check the market's own compatibility pass performs, kept here so the card
// can say "this cannot be installed on this runtime" *before* a doomed install.
// The ranges below are the real ones seen in this profile's own cache.

const runtime = '0.2.1-alpha.3'
const rangeCases = [
  ['^0.1.0-rc.6', runtime, false, 'a caret range stops before 0.2.0, which is what DSH itself refuses'],
  ['>=0.1.1-rc.1 <0.3.0', runtime, true, 'a two-sided range with room for it'],
  ['^0.2.0', runtime, true, 'a caret range that contains it'],
  ['~1.2.3', '1.2.9', true, 'a tilde range keeps the minor'],
  ['~1.2.3', '1.3.0', false, 'and refuses the next minor'],
  ['1.2.x', '1.2.7', true, 'a wildcard placeholder matches on the written numbers'],
  ['1.2.x', '1.3.0', false],
  ['*', runtime, true],
  ['1.0.0 - 1.4.0', '1.2.0', true, 'a hyphen range is a two-sided range'],
  ['>=1.0.0 <2.0.0 || >=3.0.0', '2.5.0', false, 'the two alternatives are tried in turn'],
  ['>=1.0.0 <2.0.0 || >=3.0.0', '3.1.0', true],
  ['weird~thing', runtime, null, 'a range this module cannot read is "cannot tell", never "does not fit"'],
  ['', runtime, null],
  ['^0.2.0', '', null, 'without a runtime version there is nothing to compare against'],
]
for (const [range, version, expected, why] of rangeCases) {
  assert.equal(satisfiesRange(range, version), expected, (why ? why + ': ' : '') + range + ' vs ' + version)
}
assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1, 'a prerelease sorts before the release')
assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
assert.equal(compareVersions('0.2.1-alpha.3', '0.2.0'), 1)

const incompatible = compatibilityCheck({ peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6', '@deepseek-ai/dsh-agent': '*' } }, runtime)
assert.equal(incompatible.compatible, false, 'an out-of-range peer makes the package incompatible')
assert.deepEqual(incompatible.incompatible.map((item) => item.name), ['@deepseek-ai/dsh-tools'])
assert.equal(incompatible.findings[0].level, 'error', 'and the verdict carries the level the user sees')
assert.ok(incompatible.findings[0].detail.includes(runtime), 'the finding names this runtime')

const fitting = compatibilityCheck({ peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.1-rc.1 <0.3.0' } }, runtime)
assert.equal(fitting.compatible, true)
assert.equal(fitting.findings[0].level, 'info')
assert.ok(fitting.findings[0].detail.includes('预发布'), 'a prerelease runtime is called out, because npm judges those strictly')

const noRuntime = compatibilityCheck({ peerDependencies: { '@deepseek-ai/dsh-tools': '^0.2.0' } }, '')
assert.equal(noRuntime.compatible, null, 'without a runtime version the answer is "cannot tell"')
assert.equal(noRuntime.findings[0].level, 'info')
assert.ok(noRuntime.findings[0].detail.includes('@deepseek-ai/dsh-tools'), 'and the declared range is still reported')

const unreadable = compatibilityCheck({ peerDependencies: { '@deepseek-ai/dsh-tools': 'weird~thing' } }, runtime)
assert.equal(unreadable.compatible, null)
assert.equal(unreadable.findings[0].level, 'warn', 'an unreadable range is a warning, not a refusal')

const plainPackage = compatibilityCheck({ dependencies: { lodash: '^4.0.0' } }, runtime)
assert.deepEqual(plainPackage.required, {}, 'only @deepseek-ai/dsh* entries count')
assert.deepEqual(plainPackage.findings, [])
assert.equal(compatibilityCheck(null, runtime).compatible, true, 'a manifest with nothing declared has nothing to contradict')

// Which DSH is running: the entry script sits inside the checkout, and only a
// `@deepseek-ai/dsh*` manifest may answer — never the plugin's own.
const fakeManifests = {
  'C:/harness/apps/cli/bin/package.json': JSON.stringify({ name: 'some-plugin', version: '9.9.9' }),
  'C:/harness/apps/cli/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: runtime }),
}
const readFileFake = async (path) => {
  const answer = fakeManifests[String(path).replace(/\\/g, '/')]
  if (answer === undefined) throw new Error('ENOENT ' + path)
  return answer
}
assert.equal(
  await versionFromEntry('C:\\harness\\apps\\cli\\bin\\dsh.js', { readFile: readFileFake }),
  runtime,
  'the version comes from the harness manifest, skipping the plugin manifest on the way up',
)
assert.equal(await versionFromEntry('C:\\nowhere\\x.js', { readFile: readFileFake }), '', 'an unknown layout answers nothing')

// ------------------------------------------------------- one review path
//
// There is no install mode any more: every audit is a read-only review, and the
// user decides about installing from the record. The prompt says so, and no
// verdict acknowledgement promises an automatic install.
{
  const registry = createAuditRegistry({ now: () => 1000, makeId: () => 'a1' })
  const target = { input: 'dsh-note', name: 'dsh-note', version: '1.2.3', repo: 'acme/dsh-note' }
  const audit = registry.start({ target, findings: [] })
  assert.equal(Object.prototype.hasOwnProperty.call(audit, 'mode'), false, 'records no longer carry a mode')
  assert.ok(registry.prompt('a1').includes('只做审核'), 'the prompt describes the single review path')
  assert.ok(verdictAcknowledgement('safe').includes('不会自动安装'), 'a clean verdict never installs by itself')
  assert.ok(verdictAcknowledgement('warn').includes('确认'), 'a warning still asks the user')
}

// ------------------------------------------------------------ the history
//
// The card shows every review the host holds, so the registry has to be able to
// take what a previous process wrote and hand back what should be written next.
{
  const calls = []
  const registry = createAuditRegistry({ now: () => 5000, makeId: () => 'new-1', onChange: () => calls.push(1) })
  const taken = registry.load([
    { id: 'old-1', state: 'warn', target: { name: 'dsh-old' }, startedAt: 1000, updatedAt: 1000, verdict: 'warn', summary: 'old one' },
    { id: 'old-1', state: 'safe', target: { name: 'dsh-old' }, startedAt: 1000, updatedAt: 1000 },
    null,
    { noId: true },
    { id: 'old-2', state: 'installed', target: { name: 'dsh-old' }, startedAt: 2000, updatedAt: 3000, installed: true, findings: [{ level: 'info', title: 'x' }] },
  ])
  assert.equal(taken, 2, 'only records that look like audits are taken')
  const list = registry.list()
  assert.deepEqual(list.map((entry) => entry.id), ['old-2', 'old-1'], 'newest first')
  assert.equal(list[1].verdict, 'warn', 'a loaded record keeps its verdict')
  assert.equal(list[0].installed, true, 'and what was done about it')
  registry.start({ target: { name: 'dsh-note' }, findings: [] })
  assert.ok(calls.length >= 1, 'every change tells the caller it is time to save')
  const snapshot = registry.snapshot()
  assert.equal(snapshot.length, 3, 'the snapshot is everything the registry holds')
  assert.equal(snapshot[0].id, 'new-1', 'newest first')
  assert.equal(snapshot[1].id, 'old-2', 'with the loaded ones behind it')
  assert.equal(snapshot[1].id, snapshot[1].id.trim(), 'and it is a plain copy, safe to write')
}

console.log('audit-host: all assertions passed')
