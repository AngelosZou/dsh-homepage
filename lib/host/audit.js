/**
 * dsh-homepage — plugin audit.
 *
 * The card's question is simple — "is this plugin safe to install?" — and no
 * cheap check can answer it. A static scan sees what a package declares; the
 * interesting risks (a postinstall that reads `~/.dsh`, a downloader that evals
 * what it fetched, a plugin that opens the owner's files to the network) only
 * show up when somebody reads the code. So the audit is a *session*: a real
 * agent turn that fetches the source, reads it, and reports a verdict back
 * through the `report_plugin_audit` tool.
 *
 * This module is the data half of that journey, and nothing else:
 *
 *  - `parseTarget()` / `resolveTarget()` turn whatever the user typed (an npm
 *    name, `owner/repo`, a git URL, a local path) into a name, a repository and
 *    the exact spec DSH's own installer accepts;
 *  - `staticFindings()` reads a package manifest for the signals that are worth
 *    knowing *before* anybody reads the source — install-time scripts, remote
 *    dependencies, a declared capability list;
 *  - `buildAuditPrompt()` writes the instruction the audit session receives;
 *  - `createAuditRegistry()` keeps the audits, their verdicts and their state,
 *    and is the only thing the tool and the endpoints share.
 *
 * It deliberately owns no session, no network call and no install: the caller
 * injects those, so every rule above is testable against fixtures and the
 * module never decides by itself that something is safe.
 *
 * @module
 */

import { dirname, join } from 'node:path'
import { DEFAULT_AUDIT_INSTRUCTIONS } from '../audit-instructions.js'

export { DEFAULT_AUDIT_INSTRUCTIONS }

/** The three answers an audit may produce, in ascending severity. */
export const AUDIT_VERDICTS = Object.freeze(['safe', 'warn', 'unsafe'])
/** Where an audit is in its life. `running` is the only pre-verdict state. */
export const AUDIT_STATES = Object.freeze([
  'running',
  'safe',
  'warn',
  'unsafe',
  'failed',
  'declined',
  'installing',
  'installed',
])
/** Finding severities the card can draw. */
export const AUDIT_LEVELS = Object.freeze(['info', 'warn', 'error'])
/**
 * How a risky construct could actually reach the user. A `warn` finding is only
 * useful if the reader can see which of these it is: a downloader that runs an
 * install script and a plugin that reads `~/.dsh` are both "suspicious", but one
 * is a supply-chain entry point and the other is a credential leak. The set is
 * deliberately short — a scenario the card cannot name is one the user cannot
 * weigh — and `other` is the honest remainder.
 */
export const AUDIT_SCENARIOS = Object.freeze([
  'supply-chain',
  'privilege-escalation',
  'sandbox-escape',
  'data-leak',
  'unsafe-publish',
  'other',
])
/**
 * What the host does with a `safe` verdict: install it, or stop at the report.
 * `review` exists because a review is worth having on its own — a user may want
 * to look at a package now and decide about installing it later, from the record.
 */
export const AUDIT_MODES = Object.freeze(['install', 'review'])
/** The model-facing tool the audit session reports through. */
export const AUDIT_TOOL_NAME = 'report_plugin_audit'
/**
 * Package-manifest script hooks that run code during installation. They are the
 * single most dangerous thing a plugin can carry: the code runs before anything
 * reviewed it, inside the profile, without a browser sandbox around it.
 */
const INSTALL_SCRIPT_KEYS = Object.freeze(['preinstall', 'install', 'postinstall', 'prepublishOnly', 'prepare'])
/** Registries tried in order. The second is the mirror the market uses in China. */
const NPM_REGISTRIES = Object.freeze([
  'https://registry.npmjs.org/',
  'https://mirrors.cloud.tencent.com/npm/',
])
/** Caps, so one enthusiastic model answer cannot become a megabyte of UI. */
const MAX_FINDINGS = 40
const MAX_FIELD = 1200
const MAX_SUMMARY = 2000
/** How many past audits the record keeps, on disk and in the card's list. */
const MAX_HISTORY = 50

/**
 * A mode the callers may send, reduced to one of `AUDIT_MODES`. Anything else is
 * the original behaviour — review then install — because that is what the card
 * promises when it cannot say otherwise.
 * @param value - the mode the caller sent.
 * @returns `'install'` or `'review'`.
 */
function toMode(value) {
  return value === 'review' ? 'review' : 'install'
}

/** @returns the last path segment of a spec, as a readable name. */
function lastSegment(value) {
  const text = String(value || '').replace(/[#?].*$/, '').replace(/[\\/]+$/, '')
  const parts = text.split(/[\\/]/)
  return (parts[parts.length - 1] || text).replace(/\.git$/i, '')
}

/** @returns a browsable https repository URL from a manifest's `repository`. */
function repositoryUrl(value) {
  const raw = typeof value === 'string' ? value : value && typeof value.url === 'string' ? value.url : ''
  if (raw === '') return null
  const trimmed = raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/i, '')
    .replace(/#.*$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : null
}

/**
 * Read an identifier the way a person wrote it. The three shapes that matter are
 * an npm package (`dsh-market`, `@scope/pkg@1.2.3`), a GitHub shorthand
 * (`owner/repo`, `https://github.com/owner/repo`, `github:owner/repo`) and
 * everything else, which is handed to DSH's installer as-is (a git URL, a
 * tarball, a `link:`/`file:` path).
 * @param raw - what the user typed.
 * @returns `{ input, kind, name, version, spec, full, repo }`.
 * @throws when the input is empty, because no default target exists.
 */
export function parseTarget(raw) {
  const input = typeof raw === 'string' ? raw.trim() : ''
  if (input === '') throw new Error('empty target')
  const githubUrl = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(input)
  if (githubUrl) {
    const full = githubUrl[1] + '/' + githubUrl[2].replace(/\.git$/i, '')
    return { input, kind: 'github', name: lastSegment(full), version: null, spec: 'github:' + full, full, repo: 'https://github.com/' + full }
  }
  const prefixed = /^(?:github|gitlab|bitbucket):([^\s]+)$/i.exec(input)
  if (prefixed) {
    const full = prefixed[1].replace(/\.git$/i, '')
    const isGithub = /^github:/i.test(input)
    return {
      input,
      kind: 'vcs',
      name: lastSegment(full),
      version: null,
      spec: input,
      full,
      repo: isGithub ? 'https://github.com/' + full : null,
    }
  }
  const shorthand = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+)$/.exec(input)
  if (shorthand) {
    const full = shorthand[1] + '/' + shorthand[2].replace(/\.git$/i, '')
    return { input, kind: 'github', name: lastSegment(full), version: null, spec: 'github:' + full, full, repo: 'https://github.com/' + full }
  }
  const looksLikeSpec = /^(git\+|git:|https?:\/\/|file:|link:|\.{0,2}\/|[A-Za-z]:[\\/])/i.test(input)
  if (looksLikeSpec) {
    return { input, kind: 'spec', name: lastSegment(input), version: null, spec: input, full: null, repo: null }
  }
  const scoped = /^(@[^/\s]+\/[^@\s]+)(?:@([^\s]+))?$/.exec(input) || /^([^@\s]+)(?:@([^\s]+))?$/.exec(input)
  if (scoped) {
    const version = scoped[2] || null
    return {
      input,
      kind: 'npm',
      name: scoped[1],
      version,
      spec: version ? scoped[1] + '@' + version : scoped[1],
      full: null,
      repo: null,
    }
  }
  return { input, kind: 'spec', name: input, version: null, spec: input, full: null, repo: null }
}

/**
 * The signals a manifest gives away before anybody reads the code. Each one is
 * evidence for the audit, never a verdict: plenty of honest plugins carry a
 * `postinstall`, and an audit that treated one as malice would be useless.
 * @param manifest - a parsed package.json.
 * @returns an array of `{ level, title, detail, ref }`.
 */
export function staticFindings(manifest) {
  const findings = []
  const pkg = manifest && typeof manifest === 'object' ? manifest : {}
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}
  const installScripts = INSTALL_SCRIPT_KEYS.filter((key) => typeof scripts[key] === 'string' && scripts[key].trim() !== '')
  if (installScripts.length > 0) {
    findings.push({
      level: 'warn',
      title: '安装期就会执行命令（' + installScripts.join('、') + '）',
      detail: installScripts.map((key) => key + ': ' + String(scripts[key]).trim()).join('\n'),
      ref: 'package.json#scripts',
      risk: {
        role: 'DSH 安装这个包时会先跑这些脚本，再让插件加载。',
        why: '多数用它们做编译或下载产物，属于惯例；但这段代码在插件被审核之前就已经在 profile 里运行了。',
        impact: '脚本可以读写 profile、环境变量与网络，够得着 DSH 自身的文件与凭据。',
        scenario: 'supply-chain',
      },
    })
  }
  const dependencies = Object.assign({}, pkg.dependencies, pkg.optionalDependencies)
  const remote = Object.keys(dependencies).filter((key) => /^(git|git\+|https?:|file:|link:)/i.test(String(dependencies[key])))
  if (remote.length > 0) {
    findings.push({
      level: 'warn',
      title: '依赖里包含非登记表的远程来源',
      detail: remote.map((key) => key + ': ' + String(dependencies[key])).join('\n'),
      ref: 'package.json#dependencies',
      risk: {
        role: '安装时从 git / 网址 / 本地路径取一份依赖代码进来。',
        why: '有时是为了用还没发版的修复；这类依赖不受 npm 登记表的校验与撤回机制约束。',
        impact: '同一版本号在不同时间可以指向不同代码，之后被换掉也不会留下版本记录。',
        scenario: 'supply-chain',
      },
    })
  }
  const entry = pkg.main || (pkg.exports && typeof pkg.exports === 'object' ? 'exports' : null)
  if (entry) {
    findings.push({
      level: 'info',
      title: '入口',
      detail: 'main: ' + String(pkg.main || '') + (pkg.exports ? '（另有 exports 映射）' : ''),
      ref: 'package.json#main',
    })
  }
  if (pkg.peerDependencies && typeof pkg.peerDependencies === 'object') {
    const peers = Object.keys(pkg.peerDependencies)
      .filter((key) => key === '@deepseek-ai/dsh' || key.startsWith('@deepseek-ai/dsh-'))
      .map((key) => key + ': ' + String(pkg.peerDependencies[key]))
    if (peers.length > 0) {
      findings.push({
        level: 'info',
        title: '声明的 DSH 版本范围',
        detail: peers.join('\n'),
        ref: 'package.json#peerDependencies',
      })
    }
  }
  if (!repositoryUrl(pkg.repository)) {
    findings.push({
      level: 'warn',
      title: '没有可读的源码地址',
      detail: '包清单里没有 repository 字段，审核只能依赖 npm 上的 tarball，请确认来源。',
      ref: 'package.json#repository',
      risk: {
        role: '没有仓库地址，审核会话只能读 npm 上那一份 tarball。',
        why: '发布时忘了写 repository 很常见，本身不是恶意。',
        impact: '看不到发布仓库的历史与 issue，也就无法核对「这份代码是谁、什么时候改的」。',
        scenario: 'unsafe-publish',
      },
    })
  }
  return findings
}

/**
 * Split `1.2.3-rc.4` into numbers and the prerelease tag. Anything unreadable
 * becomes zero, so a malformed range can never throw inside an audit.
 * @param value - a version string.
 * @returns `{ parts: [major, minor, patch], prerelease }`.
 */
function splitVersion(value) {
  const text = String(value || '').trim().replace(/^[v=]+/, '')
  const dash = text.indexOf('-')
  const core = dash === -1 ? text : text.slice(0, dash)
  const prerelease = dash === -1 ? '' : text.slice(dash + 1)
  const parts = core.split('.').map((piece) => {
    const number = Number.parseInt(piece, 10)
    return Number.isFinite(number) ? number : 0
  })
  while (parts.length < 3) parts.push(0)
  return { parts: parts.slice(0, 3), prerelease }
}

/**
 * Compare two versions the way a range means them: numbers first, and a
 * prerelease sorts before the same version without one (`1.0.0-rc.1 < 1.0.0`).
 * @returns -1, 0 or 1.
 */
export function compareVersions(left, right) {
  const a = splitVersion(left)
  const b = splitVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] < b.parts[index] ? -1 : 1
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === '') return 1
  if (b.prerelease === '') return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

/**
 * One comparator — `>=1.2.3`, `^1.2.3`, `1.2.x`, `*`.
 * @returns true, false, or null when the shape is not understood.
 */
function satisfiesComparator(comparator, version) {
  const text = String(comparator || '').trim()
  if (text === '' || text === '*' || text === 'x' || text === 'latest') return true
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(text)
  if (!match) return null
  const operator = match[1] || '='
  const target = match[2].trim()
  // A range this module does not understand is "cannot tell", not "does not fit":
  // reporting a broken range as an incompatibility would block a good install.
  if (!/^\d/.test(target)) return null
  if (/^[0-9xX*]+(\.[0-9xX*]+)*$/.test(target) && /[xX*]/.test(target)) {
    // `1.2.x` — only the numbers actually written have to line up.
    const wanted = splitVersion(target.replace(/[xX*]/g, '0')).parts
    const actual = splitVersion(version).parts
    const width = target.split('.').filter((piece) => !/[xX*]/.test(piece)).length
    for (let index = 0; index < width; index += 1) {
      if (wanted[index] !== actual[index]) return false
    }
    return true
  }
  const order = compareVersions(version, target)
  if (operator === '=') return order === 0
  if (operator === '>') return order > 0
  if (operator === '>=') return order >= 0
  if (operator === '<') return order < 0
  if (operator === '<=') return order <= 0
  // Caret and tilde: the comparator is the floor, the ceiling is implied.
  if (order < 0) return false
  const base = splitVersion(target).parts
  const actual = splitVersion(version).parts
  if (operator === '~') return actual[0] === base[0] && actual[1] === base[1]
  if (base[0] > 0) return actual[0] === base[0]
  if (base[1] > 0) return actual[1] === base[1]
  return actual[0] === 0 && actual[1] === 0 && actual[2] === base[2]
}

/**
 * Does `version` fit `range`? Handles the shapes plugin manifests actually use:
 * a bare version, `^`, `~`, `>=`/`<` comparisons, space-separated conjunctions
 * (`>=0.1.1-rc.1 <0.3.0`), hyphen ranges and `||`.
 *
 * `null` means "cannot tell", and the audit reports that as a warning rather
 * than as a pass: not knowing is not the same as being compatible. The one
 * deliberate simplification is npm's prerelease rule — a prerelease runtime is
 * judged by the numbers it carries, and the finding says so.
 *
 * @param range - the declared range.
 * @param version - the version to test.
 * @returns true, false or null.
 */
export function satisfiesRange(range, version) {
  const text = String(range || '').trim()
  if (text === '' || !version) return null
  let unknown = false
  for (const alternative of text.split('||')) {
    const hyphen = /^\s*([^\s]+)\s+-\s+([^\s]+)\s*$/.exec(alternative)
    const parts = hyphen
      ? ['>=' + hyphen[1], '<=' + hyphen[2]]
      : alternative.split(/\s+/).filter(Boolean)
    let fits = true
    for (const part of parts) {
      const verdict = satisfiesComparator(part, version)
      if (verdict === null) {
        unknown = true
        fits = false
        break
      }
      if (verdict === false) {
        fits = false
        break
      }
    }
    if (fits) return true
  }
  return unknown ? null : false
}

/**
 * The version half of the audit: which DSH versions a package asks for, and
 * whether this runtime is one of them. DSH itself refuses an incompatible
 * install, so saying it up front saves a doomed pnpm run — and the audit still
 * reports the *declared* ranges when the runtime version is unknown.
 *
 * Only `@deepseek-ai/dsh*` entries count, which is the same rule the market's
 * own compatibility check applies.
 *
 * @param manifest - the package manifest, or null.
 * @param runtimeVersion - this harness's version, or '' when unknown.
 * @returns `{ runtime, required, incompatible, unknown, compatible, findings }`.
 */
export function compatibilityCheck(manifest, runtimeVersion) {
  const pkg = manifest && typeof manifest === 'object' ? manifest : {}
  const runtime = String(runtimeVersion || '').trim()
  const declared = Object.assign({}, pkg.peerDependencies, pkg.dependencies)
  const required = {}
  for (const key of Object.keys(declared)) {
    if (key !== '@deepseek-ai/dsh' && !key.startsWith('@deepseek-ai/dsh-')) continue
    required[key] = String(declared[key])
  }
  const engines = pkg.engines && typeof pkg.engines === 'object' ? pkg.engines : {}
  for (const key of ['dsh', '@deepseek-ai/dsh']) {
    if (typeof engines[key] === 'string' && engines[key].trim() !== '') required['engines.' + key] = engines[key]
  }
  const names = Object.keys(required)
  const incompatible = []
  const unknown = []
  if (runtime !== '') {
    for (const name of names) {
      const verdict = satisfiesRange(required[name], runtime)
      const entry = { name, range: required[name], runtime }
      if (verdict === false) incompatible.push(entry)
      else if (verdict === null) unknown.push(entry)
    }
  }
  const findings = []
  const listing = (list) => list.map((item) => item.name + ' ' + item.range).join('、')
  if (names.length === 0) {
    // Nothing declared: the package may still work, but nothing vouches for it.
  } else if (runtime === '') {
    findings.push({
      level: 'info',
      title: '没能读到本机 DSH 版本',
      detail: '这台机器上的运行时版本没有读出来，声明的范围只作参考：' + listing(names.map((name) => ({ name, range: required[name] }))),
      ref: 'package.json#peerDependencies',
    })
  } else if (incompatible.length > 0) {
    findings.push({
      level: 'error',
      title: '版本不相容',
      detail:
        '本机 DSH 是 ' + runtime + '，这个包要求 ' + listing(incompatible) +
        '。DSH 安装时会拒绝它，请先确认有没有适用于当前版本的版本。',
      ref: 'package.json#peerDependencies',
    })
  } else if (unknown.length > 0) {
    findings.push({
      level: 'warn',
      title: '版本范围无法判断',
      detail: '本机 DSH 是 ' + runtime + '，这些范围读不出确定的边界：' + listing(unknown),
      ref: 'package.json#peerDependencies',
      risk: {
        role: '插件声明了它能配合哪些 DSH 版本，但这个范围（例如带预发布标签）没法机械判断。',
        why: '预发布版本号让范围比较失效，属于版本策略问题，不是恶意。',
        impact: '装上去以后可能因为接口变动而报错，甚至让 DSH 起不来。',
        scenario: 'unsafe-publish',
      },
    })
  } else {
    const prerelease = /-/.test(runtime)
    findings.push({
      level: 'info',
      title: '版本相容',
      detail:
        '本机 DSH 是 ' + runtime + '，落在 ' + listing(names.map((name) => ({ name, range: required[name] }))) + ' 之内' +
        (prerelease ? '（本机是预发布版本，判定按版本号区间计算，最终以 DSH 安装时的判断为准）' : '') + '。',
      ref: 'package.json#peerDependencies',
    })
  }
  const compatible = incompatible.length > 0 ? false : runtime === '' || unknown.length > 0 ? null : true
  return { runtime, required, incompatible, unknown, compatible, findings }
}

/**
 * The nearest `package.json` above a file, and its version. The harness's own
 * entry script lives inside the running checkout, so this answers "which DSH is
 * running" without importing anything from it. Only `@deepseek-ai/dsh*` manifests
 * count, so walking up from a script inside a plugin directory cannot answer with
 * that plugin's version.
 *
 * @param entry - a file path inside the harness, typically `process.argv[1]`.
 * @param options - `{ readFile, maxDepth }`, injectable for tests.
 * @returns the version, or '' when nothing readable was found.
 */
export async function versionFromEntry(entry, options = {}) {
  const readFile = options.readFile
  if (typeof readFile !== 'function' || !entry) return ''
  let directory = dirname(String(entry))
  for (let depth = 0; depth < (options.maxDepth || 10); depth += 1) {
    try {
      const text = await readFile(join(directory, 'package.json'), 'utf8')
      const pkg = JSON.parse(text)
      const name = pkg && typeof pkg.name === 'string' ? pkg.name : ''
      if (/^@deepseek-ai\/dsh($|-)/.test(name) && typeof pkg.version === 'string' && pkg.version.trim() !== '') {
        return pkg.version.trim()
      }
    } catch { /* no readable manifest here: keep walking up */ }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return ''
}

/** @returns the requested version's manifest out of an npm packument. */
function pickVersion(packument, wanted) {
  const versions = packument && packument.versions && typeof packument.versions === 'object' ? packument.versions : {}
  const distTags = packument && packument['dist-tags'] && typeof packument['dist-tags'] === 'object' ? packument['dist-tags'] : {}
  const exact = wanted && versions[wanted] ? wanted : null
  const version = exact || (typeof distTags.latest === 'string' ? distTags.latest : null) || Object.keys(versions).pop() || null
  const manifest = version ? versions[version] : null
  return { version, manifest: manifest && typeof manifest === 'object' ? manifest : null }
}

/** @returns a JSON body, or throws with the status that refused it. */
async function fetchJsonDefault(url, options) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: options.signal })
  if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url)
  return await response.json()
}

/**
 * Resolve a target into everything the audit and the installer need: a name, a
 * version, a repository to read and the spec DSH's `installBundle()` accepts.
 * The npm registry answers for a package; `raw.githubusercontent.com` answers for
 * a repository. A failure is reported with the reason rather than swallowed —
 * "we could not look" is a state the card has to show.
 * @param raw - what the user typed.
 * @param options - `{ fetchJson, signal, registries }`, injectable for tests.
 * @returns `{ ...target, repo, version, description, manifest, findings, source }`.
 */
export async function resolveTarget(raw, options = {}) {
  const fetchJson = options.fetchJson || fetchJsonDefault
  const registries = options.registries || NPM_REGISTRIES
  const target = parseTarget(raw)
  const findings = []
  let manifest = null
  let source = null
  if (target.kind === 'npm') {
    const failures = []
    for (const registry of registries) {
      const url = registry.replace(/\/+$/, '/') + encodeURIComponent(target.name).replace(/^%40/i, '@')
      try {
        const packument = await fetchJson(url, options)
        const picked = pickVersion(packument, target.version)
        manifest = picked.manifest
        if (picked.version) target.version = picked.version
        source = url
        break
      } catch (error) {
        failures.push(registry + ' → ' + (error && error.message ? error.message : String(error)))
      }
    }
    if (!manifest) throw new Error('npm 登记表没有回答 ' + target.name + '：' + failures.join('；'))
    target.repo = repositoryUrl(manifest.repository)
    target.description = typeof manifest.description === 'string' ? manifest.description : ''
    target.spec = target.version ? target.name + '@' + target.version : target.name
  } else if (target.kind === 'github' && target.full) {
    const url = 'https://raw.githubusercontent.com/' + target.full + '/HEAD/package.json'
    try {
      manifest = await fetchJson(url, options)
      source = url
      if (manifest && typeof manifest === 'object') {
        target.name = typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : target.name
        target.version = typeof manifest.version === 'string' ? manifest.version : null
        target.description = typeof manifest.description === 'string' ? manifest.description : ''
      }
    } catch (error) {
      findings.push({
        level: 'warn',
        title: '读不到仓库根目录的 package.json',
        detail: (error && error.message ? error.message : String(error)) + '。仓库可能没有把插件放在根目录。',
        ref: url,
        risk: {
          role: '宿主想从仓库根目录读一份包清单（名字、版本、依赖、安装脚本）。',
          why: '仓库结构各不相同，插件可能在子目录里。',
          impact: '清单读不到，静态证据与版本相容检查都只能跳过，审核只剩会话读到的代码。',
          scenario: 'other',
        },
      })
    }
    target.spec = 'github:' + target.full
  }
  if (manifest) findings.push(...staticFindings(manifest))
  return { ...target, manifest, findings, source }
}

/** @returns a value cut to `MAX_FIELD` characters. */
function cut(value, limit = MAX_FIELD) {
  const text = typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value)
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text
}

/**
 * The explanation a `warn` finding carries: what the construct does in the
 * plugin, why the plugin has it, what it could cost, and which of the scenarios
 * it is. Anything the model left out is simply absent — the card shows what it
 * got, and says so when a warning arrived without an explanation at all.
 * @param value - the finding's `risk` field, as the model sent it.
 * @returns `{ role, why, impact, scenario }`, or null when nothing was given.
 */
function normalizeRisk(value) {
  const item = value && typeof value === 'object' ? value : null
  if (!item) return null
  const role = cut(item.role, MAX_FIELD)
  const why = cut(item.why, MAX_FIELD)
  const impact = cut(item.impact, MAX_FIELD)
  const scenario = AUDIT_SCENARIOS.includes(String(item.scenario || '').toLowerCase())
    ? String(item.scenario).toLowerCase()
    : 'other'
  if (role === '' && why === '' && impact === '' && scenario === 'other') return null
  return { role, why, impact, scenario }
}

/**
 * Validate what the audit session reported — out of a model answer, so nothing is
 * trusted: an unknown verdict is a refusal (the tool tells the model to try again
 * with a legal one), an unknown finding level degrades to `info`, and every string
 * is cut to a displayable length.
 * @param payload - the tool arguments.
 * @returns `{ verdict, summary, findings }`.
 */
export function normalizeVerdict(payload) {
  const input = payload && typeof payload === 'object' ? payload : {}
  const verdict = typeof input.verdict === 'string' ? input.verdict.trim().toLowerCase() : ''
  if (!AUDIT_VERDICTS.includes(verdict)) {
    throw new Error('verdict 必须是 ' + AUDIT_VERDICTS.join(' / ') + ' 之一')
  }
  const summary = cut(input.summary, MAX_SUMMARY)
  if (summary === '') throw new Error('summary 不能为空：用一两句话说明结论和最重要的理由')
  const list = Array.isArray(input.findings) ? input.findings : []
  const findings = []
  for (const entry of list.slice(0, MAX_FINDINGS)) {
    const item = entry && typeof entry === 'object' ? entry : {}
    const level = AUDIT_LEVELS.includes(String(item.level || '').toLowerCase()) ? String(item.level).toLowerCase() : 'info'
    const title = cut(item.title, 200)
    const detail = cut(item.detail)
    if (title === '' && detail === '') continue
    const finding = { level, title: title || detail.slice(0, 80), detail, ref: cut(item.ref, 300) }
    const risk = normalizeRisk(item.risk)
    if (risk) finding.risk = risk
    findings.push(finding)
  }
  return { verdict, summary, findings }
}

/**
 * Validate editable guidance before starting any work. Only omitted or blank
 * strings use the default; a nonblank string keeps its original formatting.
 * @param prompt - optional guidance supplied by the card.
 * @returns the guidance text, without host-owned context or constraints.
 */
export function normalizeAuditInstructions(prompt) {
  if (prompt === undefined) return DEFAULT_AUDIT_INSTRUCTIONS
  if (typeof prompt !== 'string') throw new TypeError('prompt 必须是字符串')
  if (prompt.length > 20000) throw new RangeError('prompt 最多 20000 字符')
  return prompt.trim() === '' ? DEFAULT_AUDIT_INSTRUCTIONS : prompt
}

/**
 * The instruction the audit session receives. It is written for a reader that
 * has tools and no context: where the source is, what to look for, what the
 * three verdicts mean, and the exact shape the answer has to take.
 * @param audit - a record from the registry.
 * @param prompt - optional editable guidance; host context and constraints always follow.
 * @returns the prompt text.
 */
export function buildAuditPrompt(audit, prompt) {
  const instructions = normalizeAuditInstructions(prompt)
  const target = audit && audit.target ? audit.target : {}
  const lines = []
  lines.push('这台机器上有一张「插件审核」卡片，你负责这一次审核。请读完待审插件的源码，判断它是否安全，最后调用 `' + AUDIT_TOOL_NAME + '` 工具汇报结论。')
  lines.push('')
  lines.push('## 怎么做')
  lines.push(instructions)
  lines.push('')
  lines.push('## 待审对象')
  lines.push('- 用户输入：' + String(target.input || ''))
  lines.push('- 名称：' + String(target.name || '(未知)') + (target.version ? ' @ ' + target.version : ''))
  lines.push('- 仓库：' + String(target.repo || '(没有可读的源码地址)'))
  lines.push('- 安装方式：DSH 插件（Host half 在 DSH 进程里运行，Client half 在浏览器里运行）')
  if (audit && audit.compatibility && audit.compatibility.runtime) {
    lines.push('- 本机 DSH 版本：' + audit.compatibility.runtime)
    if (audit.compatibility.incompatible && audit.compatibility.incompatible.length > 0) {
      lines.push('- 版本相容性：这个包声明的范围装不上本机版本（DSH 安装时会拒绝），这一点要写进结论')
    }
  }
  const known = Array.isArray(audit && audit.findings) ? audit.findings : []
  if (known.length > 0) {
    lines.push('')
    lines.push('## 已知的静态信号（来自包清单，是证据不是结论）')
    for (const item of known) {
      lines.push('- [' + item.level + '] ' + item.title + (item.detail ? '：' + String(item.detail).split('\n')[0] : ''))
    }
  }
  lines.push('')
  lines.push('## 汇报要求与安全约束（始终适用）')
  lines.push('调用 `' + AUDIT_TOOL_NAME + '`，`auditId` 必须是 `' + String((audit && audit.id) || '') + '`；`summary` 用中文一到两句说清结论与最重要的理由；`findings` 每一项 `{ level, title, detail, ref }`（`warn` 再加 `risk: { role, why, impact, scenario }`），`level` 取 `info`/`warn`/`error`，`ref` 写具体位置（例如 `lib/index.js:120`）。')
  lines.push('只汇报一次。不确定就给 `warn`，并在 findings 里写清你没能看到什么。不要修改任何文件，不要自己安装插件，也不要执行仓库里的代码。')
  lines.push('')
  const mode = audit && audit.mode === 'review' ? 'review' : 'install'
  lines.push(mode === 'review'
    ? '这次是**仅审核**：卡片只把结论告诉用户并从记录里留着，不会安装任何东西。'
    : '这次是**审核后安装**：卡片会在 `safe` 时直接安装，`warn` 时提醒用户并要求确认，`unsafe` 时拒绝安装（除非用户明确覆盖）。')
  return lines.join('\n')
}

/**
 * The JSON schema of the report tool, kept next to the validation so the two
 * cannot drift apart.
 * @returns the tool's `parameters` schema.
 */
export function auditToolParameters() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      auditId: { type: 'string', description: 'The audit id from the prompt.' },
      verdict: { type: 'string', enum: AUDIT_VERDICTS.slice(), description: 'safe, warn or unsafe.' },
      summary: { type: 'string', description: 'One or two sentences: the verdict and the reason that decided it.' },
      findings: {
        type: 'array',
        description: 'The evidence, each with a file or URL reference.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            level: { type: 'string', enum: AUDIT_LEVELS.slice() },
            title: { type: 'string' },
            detail: { type: 'string' },
            ref: { type: 'string', description: 'Where it was seen, e.g. lib/index.js:120.' },
            risk: {
              type: 'object',
              description: 'Required on every warn finding: why the user should stop and weigh this.',
              additionalProperties: false,
              properties: {
                role: { type: 'string', description: 'What this code does in the plugin.' },
                why: { type: 'string', description: 'Why the plugin has it — a real need, or a copied habit.' },
                impact: { type: 'string', description: 'What an abuse of it would cost.' },
                scenario: {
                  type: 'string',
                  enum: AUDIT_SCENARIOS.slice(),
                  description: 'Which situation this risk belongs to.',
                },
              },
              required: ['role', 'why', 'impact', 'scenario'],
            },
          },
          required: ['level', 'title'],
        },
      },
    },
    required: ['auditId', 'verdict', 'summary'],
  }
}

/**
 * Keep the audits of one process. No I/O, no timers: the endpoints and the tool
 * are the only writers, and every reader gets a plain copy so a caller cannot
 * reach in and change a verdict. `onChange` is how the caller learns it is time
 * to save the history it keeps; `load` seeds the records a previous process left.
 * @param options - `{ now, makeId, onChange }`, injectable for tests.
 * @returns `{ start, get, list, load, snapshot, attachSession, recordVerdict, patch, decide, prompt, status }`.
 */
export function createAuditRegistry(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const makeId = typeof options.makeId === 'function'
    ? options.makeId
    : () => 'audit-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {}
  /** @type {Map<string, object>} */
  const audits = new Map()

  /** @returns a copy that a caller cannot use to mutate the record. */
  function copy(audit) {
    return JSON.parse(JSON.stringify(audit))
  }

  /** @returns the record, or throws a message the caller can show. */
  function need(id) {
    const audit = audits.get(String(id || ''))
    if (!audit) throw new Error('没有这次审核的记录：' + String(id || '(空)'))
    return audit
  }

  /** Tell the caller something changed, then hand back the record it passed. */
  function changed(audit) {
    onChange()
    return copy(audit)
  }

  /** @returns the newest records first, capped at the history size. */
  function ordered() {
    return Array.from(audits.values())
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, MAX_HISTORY)
  }

  return {
    /**
     * Open an audit. The caller has already resolved the target, so the prompt
     * can name the source.
     * @param input - `{ target, findings, compatibility, mode, session }`.
     * @returns the record.
     */
    start(input = {}) {
      const id = makeId()
      const at = now()
      const audit = {
        id,
        state: 'running',
        stage: 'resolved',
        detail: '正在准备审核会话…',
        mode: toMode(input.mode),
        target: input.target || null,
        findings: Array.isArray(input.findings) ? input.findings.slice(0, MAX_FINDINGS) : [],
        compatibility: input.compatibility && typeof input.compatibility === 'object' ? input.compatibility : null,
        session: input.session || null,
        verdict: null,
        summary: '',
        installed: false,
        install: null,
        startedAt: at,
        updatedAt: at,
      }
      audits.set(id, audit)
      return changed(audit)
    },
    /** @returns the record, or null. */
    get(id) {
      const audit = audits.get(String(id || ''))
      return audit ? copy(audit) : null
    },
    /** @returns every audit, newest first. */
    list() {
      return ordered().map(copy)
    },
    /**
     * Seed the records a previous process saved. Only records that still look
     * like audits are taken, and the oldest beyond the cap are dropped: a file
     * someone edited by hand must not be able to break the list.
     * @param records - what was read from disk.
     * @returns how many were taken.
     */
    load(records) {
      if (!Array.isArray(records)) return 0
      let taken = 0
      for (const record of records) {
        if (!record || typeof record !== 'object') continue
        const id = typeof record.id === 'string' && record.id !== '' ? record.id : ''
        if (id === '' || audits.has(id)) continue
        const at = Number(record.startedAt)
        audits.set(id, {
          id,
          state: typeof record.state === 'string' ? record.state : 'failed',
          stage: typeof record.stage === 'string' ? record.stage : 'loaded',
          detail: typeof record.detail === 'string' ? record.detail : '',
          mode: toMode(record.mode),
          target: record.target && typeof record.target === 'object' ? record.target : null,
          findings: Array.isArray(record.findings) ? record.findings.slice(0, MAX_FINDINGS) : [],
          compatibility: record.compatibility && typeof record.compatibility === 'object' ? record.compatibility : null,
          session: record.session && typeof record.session === 'object' ? record.session : null,
          verdict: typeof record.verdict === 'string' ? record.verdict : null,
          summary: typeof record.summary === 'string' ? record.summary : '',
          installed: record.installed === true,
          install: record.install && typeof record.install === 'object' ? record.install : null,
          startedAt: Number.isFinite(at) ? at : now(),
          updatedAt: Number(record.updatedAt) || (Number.isFinite(at) ? at : now()),
        })
        taken += 1
      }
      for (const audit of Array.from(audits.values()).sort((left, right) => left.startedAt - right.startedAt).slice(0, Math.max(0, audits.size - MAX_HISTORY))) {
        audits.delete(audit.id)
      }
      return taken
    },
    /** @returns the records as they should be written to disk, newest first. */
    snapshot() {
      return ordered().map(copy)
    },
    /**
     * Attach the session the audit runs in, once the caller has created it.
     * @param id - the audit id.
     * @param session - `{ id, title }`.
     * @param detail - what to show while it works.
     * @returns the record.
     */
    attachSession(id, session, detail) {
      const audit = need(id)
      audit.session = session || null
      audit.stage = 'reading'
      audit.detail = typeof detail === 'string' && detail !== '' ? detail : '审核会话正在读源码…'
      audit.updatedAt = now()
      return changed(audit)
    },
    /** @returns the prompt for one audit, with optional editable guidance. */
    prompt(id, instructions) {
      return buildAuditPrompt(need(id), instructions)
    },
    /**
     * Record what the session reported. One report per audit: a second call is
     * refused with the reason, which is exactly what the model should be told.
     * @param id - the audit id.
     * @param payload - the tool arguments.
     * @returns the record.
     */
    recordVerdict(id, payload) {
      const audit = need(id)
      if (audit.verdict) throw new Error('这次审核已经汇报过了（' + audit.verdict + '），不要重复汇报')
      const verdict = normalizeVerdict(payload)
      audit.verdict = verdict.verdict
      audit.summary = verdict.summary
      audit.state = verdict.verdict
      audit.stage = 'reported'
      audit.detail = verdict.summary
      audit.findings = audit.findings.concat(verdict.findings).slice(0, MAX_FINDINGS)
      audit.updatedAt = now()
      return changed(audit)
    },
    /**
     * Move an audit to a state the caller owns (installing, installed, failed,
     * declined) and record why.
     * @param id - the audit id.
     * @param patch - `{ state, stage, detail, install }`.
     * @returns the record.
     */
    patch(id, patch = {}) {
      const audit = need(id)
      if (typeof patch.state === 'string') audit.state = patch.state
      if (typeof patch.stage === 'string') audit.stage = patch.stage
      if (typeof patch.detail === 'string') audit.detail = patch.detail
      if (patch.install !== undefined) audit.install = patch.install
      if (patch.installed === true) audit.installed = true
      if (patch.compatibility !== undefined) audit.compatibility = patch.compatibility
      audit.updatedAt = now()
      return changed(audit)
    },
    /**
     * The user's answer to a `warn` verdict. A `safe` audit is installed by the
     * caller without asking, an `unsafe` one can only be overridden here.
     * @param id - the audit id.
     * @param decision - `install` or `decline`.
     * @returns the record.
     */
    decide(id, decision) {
      const audit = need(id)
      if (!audit.verdict) throw new Error('这次审核还没有结论')
      if (decision === 'decline') {
        audit.state = 'declined'
        audit.stage = 'declined'
        audit.detail = '已取消安装'
        audit.updatedAt = now()
        return changed(audit)
      }
      if (decision !== 'install') throw new Error('decision 必须是 install 或 decline')
      audit.state = 'installing'
      audit.stage = 'installing'
      audit.detail = '正在安装…'
      audit.updatedAt = now()
      return changed(audit)
    },
    /** @returns the record in the shape the endpoints return. */
    status(id) {
      return copy(need(id))
    },
  }
}

/** @returns true when a verdict needs the user's answer before installing. */
export function needsConfirmation(verdict) {
  return verdict === 'warn' || verdict === 'unsafe'
}

/** @returns the sentence the model sees after reporting. */
export function verdictAcknowledgement(verdict, mode) {
  if (verdict === 'safe') {
    return mode === 'review'
      ? '已记录：safe。这次只审核，卡片不会自动安装；用户可以在审核记录里选择安装。'
      : '已记录：safe。卡片会直接安装，并告诉用户没有发现问题。'
  }
  if (verdict === 'warn') return '已记录：warn。卡片会提醒用户并要求确认后才安装。'
  return '已记录：unsafe。卡片会拒绝安装并向用户报告风险。'
}
