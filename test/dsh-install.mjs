/**
 * dsh-homepage — DSH core installer unit checks.
 *
 * Plain `node:assert/strict`, no framework, mirroring `toolchain-sampler.mjs`.
 *
 * The point of this suite is that nothing real is ever spawned, written or
 * waited for: every `exists`/`readdir`/`stat`/`writeFile`/`spawn` is injected, so
 * the plan, the generated script and the download-free paths are all exercised
 * without touching the network or the user's disk. The one deliberate exception
 * is the closing block, which uses a throwaway directory under the system temp
 * directory to prove the default filesystem wiring agrees with the fakes.
 *
 * Run with `node test/dsh-install.mjs`; the last line is the sentinel the smoke
 * script greps for.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse as parsePath, resolve, sep } from 'node:path'
import {
  buildShellScript,
  defaultInstallRoot,
  defaultRunningCore,
  desktopCore,
  installTarget,
  listInstalled,
  planInstall,
  resetInstallCache,
  sanitizeVersion,
  startInstall,
} from '../lib/host/dsh-install.js'

/** The plan keys the contract promises. */
const PLAN_KEYS = [
  'ok', 'reason', 'root', 'dir', 'repo', 'ref', 'version', 'branchArg', 'steps',
  'script', 'scriptPath', 'logPath', 'command', 'args', 'mode', 'proxy', 'registry',
]

/** The four steps of every install, in order. */
const STEP_IDS = ['clone', 'install', 'build', 'mark']

const REPO = 'https://github.com/deepseek-ai/deepseek-harness.git'
const REGISTRY = 'https://registry.npmmirror.com'
const PROXY = 'http://127.0.0.1:7890'

/**
 * A Windows-ish environment for the plans that are expected to succeed: PATH and
 * PATHEXT decide what `commandExists` believes is installed.
 */
function winEnv(extra = {}) {
  return { PATH: 'C:\\tools', PATHEXT: '.exe', ...extra }
}

/** A POSIX-ish environment for the launcher and script checks. */
function posixEnv(extra = {}) {
  return { PATH: '/usr/bin:/bin', ...extra }
}

// ------------------------------------------------------------------- surface

{
  for (const [name, fn] of Object.entries({
    buildShellScript,
    installTarget,
    listInstalled,
    planInstall,
    resetInstallCache,
    sanitizeVersion,
    startInstall,
  })) {
    assert.equal(typeof fn, 'function', name + ' is exported')
  }
  console.log('  exports: the seven contract functions are exported')
}

// ------------------------------------------------------------ sanitizeVersion

{
  assert.equal(sanitizeVersion('v0.2.1-alpha.4'), 'v0.2.1-alpha.4', 'a real version survives untouched')
  assert.equal(sanitizeVersion('  v0.2.1  '), 'v0.2.1', 'surrounding whitespace becomes trim-able dashes')
  assert.equal(sanitizeVersion('v1.2.3_rc+build.5'), 'v1.2.3_rc+build.5', '_ and + are kept')
  assert.equal(sanitizeVersion('a/b'), 'a-b', 'a path separator becomes a dash')
  assert.equal(sanitizeVersion('..\\..\\etc'), 'etc', 'a traversal attempt cannot survive as a path')
  assert.equal(sanitizeVersion('C:\\evil'), 'C-evil', 'a drive-qualified path becomes one harmless token')
  assert.equal(sanitizeVersion('../../etc/passwd'), 'etc-passwd', 'a relative walk collapses to one segment')
  assert.equal(sanitizeVersion('....'), null, 'dots only trim away to nothing')
  assert.equal(sanitizeVersion('..'), null, 'a parent reference is refused')
  assert.equal(sanitizeVersion('.'), null, 'the current directory is refused')
  assert.equal(sanitizeVersion(''), null, 'an empty version is refused')
  assert.equal(sanitizeVersion('   '), null, 'a blank version is refused')
  assert.equal(sanitizeVersion('版本'), null, 'a non-ASCII version has nothing usable left')
  assert.equal(sanitizeVersion('v1; rm -rf /'), 'v1-rm-rf', 'shell punctuation cannot survive')
  assert.equal(sanitizeVersion('a'.repeat(64)), 'a'.repeat(64), '64 characters is the limit, inclusive')
  assert.equal(sanitizeVersion('a'.repeat(65)), null, 'a longer token is refused')
  assert.equal(sanitizeVersion(undefined), null, 'a missing version is refused')
  assert.equal(sanitizeVersion(null), null, 'null is refused')
  assert.equal(sanitizeVersion(4), null, 'a non-string is refused')
  const token = sanitizeVersion('---a---')
  assert.equal(token, 'a', 'leading and trailing dashes are trimmed')
  console.log('  sanitizeVersion: separators, dots, unicode, length and non-strings all rejected safely')
}

// -------------------------------------------------------------- installTarget

{
  const root = join(process.cwd(), '.dsh-install-test', 'cores')
  const target = installTarget(root, 'v0.2.1-alpha.4')
  assert.equal(target, join(resolve(root), 'DeepSeekHarness-v0.2.1-alpha.4'), 'the target is root + prefix + token')
  assert.equal(target.includes('..'), false, 'the target never contains a parent reference')
  assert.equal(installTarget(root, '../../evil'), join(resolve(root), 'DeepSeekHarness-evil'),
    'a traversal version comes out as one segment under the root')
  assert.equal(installTarget('', 'v1'), null, 'an empty root has no target')
  assert.equal(installTarget(root, ''), null, 'an empty version has no target')
  assert.equal(installTarget(root, '版本'), null, 'an unusable version has no target')
  assert.equal(installTarget(root, 'v1', {}), installTarget(root, 'v1'), 'the options parameter is optional')
  console.log('  installTarget: joins under the root and returns null rather than guessing')
}

// ------------------------------------------------------ planInstall, a release

{
  const root = join(process.cwd(), '.dsh-install-test', 'cores')
  const plan = planInstall({
    root,
    version: 'v0.2.1-alpha.4',
    ref: 'dsh-v0.2.1-alpha.4',
    platform: 'win32',
    env: winEnv({ HTTPS_PROXY: PROXY }),
    exists: () => true,
    readdirSync: () => [],
  })
  for (const key of PLAN_KEYS) assert.ok(key in plan, 'the plan carries ' + key)
  assert.equal(plan.ok, true, 'a release plan is ok')
  assert.equal(plan.reason, null, 'an ok plan has no reason')
  assert.equal(plan.root, resolve(root), 'the root is absolute')
  assert.equal(plan.dir, join(resolve(root), 'DeepSeekHarness-v0.2.1-alpha.4'), 'the dir is absolute')
  assert.equal(plan.repo, REPO, 'the repository is the pinned one')
  assert.equal(plan.ref, 'dsh-v0.2.1-alpha.4', 'a release keeps the tag it was given')
  assert.equal(plan.version, 'v0.2.1-alpha.4', 'the version is the sanitized token')
  assert.equal(plan.branchArg, "--branch 'dsh-v0.2.1-alpha.4' ", 'the branch fragment is the clone-line spelling')
  assert.equal(plan.mode, 'window', 'a terminal is available on this machine')
  assert.equal(plan.command, 'wt.exe', 'Windows Terminal is preferred when it exists')
  assert.deepEqual(plan.args, [
    'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File',
    join(resolve(root), 'install-v0.2.1-alpha.4.ps1'),
  ], 'the window runs the generated script')
  assert.equal(plan.scriptPath, join(resolve(root), 'install-v0.2.1-alpha.4.ps1'), 'the script sits beside the target')
  assert.equal(plan.logPath, join(resolve(root), 'install-v0.2.1-alpha.4.log'), 'the log sits beside the target')
  assert.equal(plan.proxy, PROXY, 'the proxy is reported from the environment')
  assert.equal(plan.registry, REGISTRY, 'the registry mirror is the pinned one')
  assert.equal(typeof plan.generatedAt, 'number', 'the plan records when it was made')

  assert.deepEqual(plan.steps.map((step) => step.id), STEP_IDS, 'the four steps are in order')
  for (const step of plan.steps) {
    assert.equal(typeof step.label, 'string', 'the ' + step.id + ' step has a label')
    assert.equal(typeof step.command, 'string', 'the ' + step.id + ' step has a command')
    assert.ok(Array.isArray(step.args), 'the ' + step.id + ' step has an args array')
  }
  assert.deepEqual(plan.steps[0].args, [
    'clone', '--depth', '1', '--branch', 'dsh-v0.2.1-alpha.4', REPO, plan.dir,
  ], 'a release clones by tag, shallow')
  assert.deepEqual(plan.steps[1].args, ['install', '--registry', REGISTRY], 'the install step uses the mirror')
  assert.deepEqual(plan.steps[2].args, ['build'], 'the build step is the repo script')
  assert.ok(plan.script.length > 0, 'the script was rendered')
  console.log('  planInstall: a release clones the pinned tag shallowly and opens a window')
}

// ---------------------------------------------------------- planInstall, HEAD

{
  const root = join(process.cwd(), '.dsh-install-test', 'cores')
  const plan = planInstall({
    root,
    version: 'v0.2.1-alpha.4',
    ref: null,
    platform: 'win32',
    env: winEnv(),
    exists: () => true,
    readdirSync: () => [],
  })
  assert.equal(plan.ok, true, 'a HEAD plan is ok')
  assert.equal(plan.ref, null, 'an explicit null ref means HEAD')
  assert.equal(plan.branchArg, '', 'no branch fragment for HEAD')
  assert.deepEqual(plan.steps[0].args, ['clone', '--depth', '1', REPO, plan.dir], 'HEAD clones the default branch')
  assert.equal(plan.script.includes('--branch'), false, 'the HEAD script never asks for a branch')
  assert.equal(plan.script.includes('$Ref = '), true, 'the marker still records which ref was used')

  const derived = planInstall({ root, version: 'v0.2.1-alpha.4', platform: 'win32', env: winEnv(), exists: () => true, readdirSync: () => [] })
  assert.equal(derived.ref, 'dsh-v0.2.1-alpha.4', 'a version with no ref derives the release tag')
  console.log('  planInstall: an explicit null ref tracks HEAD, an omitted one derives the release tag')
}

// ------------------------------------------------------- planInstall, refusals

{
  const good = join(process.cwd(), '.dsh-install-test', 'cores')
  const absent = () => false
  const refuse = (options, reason, what) => {
    const plan = planInstall(options)
    assert.equal(plan.ok, false, what + ' is refused')
    assert.equal(plan.reason, reason, what + ' refuses with ' + reason)
    assert.equal(plan.script, '', what + ' renders no script')
    assert.equal(plan.command, null, what + ' names no launcher')
    return plan
  }
  refuse({ version: 'v1' }, 'no-root', 'a missing root')
  refuse({ root: '   ', version: 'v1' }, 'no-root', 'a blank root')
  refuse({ root: 'relative/cores', version: 'v1' }, 'bad-root', 'a relative root')
  refuse({ root: parsePath(process.cwd()).root, version: 'v1' }, 'bad-root', 'the filesystem root itself')
  refuse({ root: good }, 'no-version', 'a missing version')
  refuse({ root: good, version: '..' }, 'no-version', 'a traversal version')
  refuse({ root: good, version: 'v1', ref: 'bad ref!' }, 'no-version', 'a ref with a space')
  refuse({ root: good, version: 'v1', ref: '-rf' }, 'no-version', 'a ref that looks like an option')
  refuse({ root: good, version: 'v1', env: winEnv(), exists: absent, readdirSync: () => [] }, 'no-git', 'a machine without git')
  refuse({
    root: good,
    version: 'v1',
    env: winEnv(),
    exists: (path) => path.endsWith('git.exe'),
    readdirSync: () => [],
  }, 'no-pnpm', 'a machine with neither pnpm nor corepack')
  refuse({
    root: good,
    version: 'v1',
    env: winEnv(),
    exists: () => true,
    readdirSync: () => ['package.json'],
  }, 'exists', 'an existing non-empty target')

  // An empty directory is reusable: git clone is happy to fill one.
  const reusable = planInstall({
    root: good,
    version: 'v1',
    env: winEnv(),
    exists: () => true,
    readdirSync: () => [],
  })
  assert.equal(reusable.ok, true, 'an existing empty target is allowed')

  // An unreadable target is treated as non-empty: refusing beats installing on
  // top of something we could not even list.
  const unreadable = planInstall({
    root: good,
    version: 'v1',
    env: winEnv(),
    exists: () => true,
    readdirSync: () => { throw new Error('EACCES') },
  })
  assert.equal(unreadable.reason, 'exists', 'an unreadable target is refused, not overwritten')
  console.log('  planInstall refusals: no-root, bad-root, no-version, no-git, no-pnpm, exists')
}

// ------------------------------------------------- the generated PowerScript

{
  const root = join(process.cwd(), "quote's root", 'cores')
  const plan = planInstall({
    root,
    version: 'v0.2.1-alpha.4',
    ref: 'dsh-v0.2.1-alpha.4',
    platform: 'win32',
    env: winEnv(),
    exists: () => true,
    readdirSync: () => [],
  })
  const script = plan.script
  assert.equal(script.includes("$ErrorActionPreference = 'Stop'"), true, 'the script stops on the first real error')
  assert.equal(script.includes("$ProgressPreference = 'SilentlyContinue'"), true, 'the progress bar cannot eat the window')
  assert.equal(script.includes(
    'git clone --depth 1 --branch \'dsh-v0.2.1-alpha.4\' ' + powerShellQuote(REPO) + ' ' + powerShellQuote(plan.dir),
  ), true, 'the exact clone line is in the script')
  assert.equal(script.includes("Invoke-Pnpm install --registry '" + REGISTRY + "'"), true, 'the registry install is there')
  assert.equal(script.includes('corepack pnpm'), true, 'the corepack fallback is there')
  assert.equal(script.includes('Invoke-Pnpm build'), true, 'the build step is there')
  assert.equal(script.includes('Set-Location -LiteralPath $Root'), true, 'it starts in the root')
  assert.equal(script.includes('Set-Location -LiteralPath $Dir'), true, 'it continues in the target')
  assert.equal(script.includes('Set-Content -LiteralPath $Marker -Encoding ascii'), true, 'the marker is written')
  assert.equal(script.includes('-Encoding ascii'), true, 'the marker is plain ASCII so a reader cannot guess the encoding')
  assert.equal(script.includes("('version: ' + $Version)"), true, 'the marker records the version')
  assert.equal(script.includes("('ref: ' + $Ref)"), true, 'the marker records the ref')
  assert.equal(script.includes('Get-Date -Format o'), true, 'the marker records an ISO timestamp')
  assert.equal(script.includes('Tee-Object -FilePath $Log -Append'), true,
    'every native command is teed into the log')
  assert.equal(script.includes('$LASTEXITCODE -ne 0'), true, 'the exit code, not the stderr text, is the verdict')
  assert.equal(script.includes('Read-Host'), true, 'the window waits so a failure can be read')
  assert.equal(script.includes('$env:DSH_INSTALL_PAUSE'), true, 'the wait is conditional on a window launch')
  assert.equal(/^[\x20-\x7E\r\n\t]*$/.test(script), true, 'the script is pure ASCII, which is what BOM-less PowerShell reads')

  // The apostrophe in the root must be doubled, or the string ends there.
  assert.equal(script.includes("$Root = '" + plan.root.replace(/'/g, "''") + "'"), true,
    'a quote inside a path is doubled')
  assert.equal(script.includes("quote's root'"), false, 'the raw quote never appears undoubled')

  assert.equal(buildShellScript(plan).includes('git clone'), true, 'buildShellScript follows the plan platform')
  assert.equal(buildShellScript(plan, { platform: 'linux' }).startsWith('#!/bin/sh'), true,
    'an explicit platform overrides the dialect')
  assert.equal(buildShellScript(plan, { platform: 'linux' }).includes("'\\''"), true,
    'the POSIX dialect escapes a quote inside a path')
  assert.equal(buildShellScript(null), '', 'a null plan renders nothing')
  assert.equal(buildShellScript({}), '', 'an empty plan renders nothing')
  console.log('  script (powershell): clone, install, build, marker, tee and quote-doubling all present')
}

// ------------------------------------------------------ the generated sh script

{
  const root = '/opt/dsh/it' + "'" + 's root'
  const plan = planInstall({
    root,
    version: 'v0.2.1-alpha.4',
    ref: 'dsh-v0.2.1-alpha.4',
    platform: 'linux',
    env: posixEnv(),
    exists: () => true,
    readdirSync: () => [],
  })
  assert.equal(plan.ok, true, 'a POSIX plan is ok')
  const script = plan.script
  assert.equal(script.startsWith('#!/bin/sh\n'), true, 'the script is sh, not bash')
  assert.equal(script.includes('set -e'), true, 'the script stops on the first failure')
  assert.equal(script.includes(
    'run \'1/4 git clone\' git clone --depth 1 --branch \'dsh-v0.2.1-alpha.4\' ' + shQuote(REPO) + ' ' + shQuote(plan.dir),
  ), true, 'the exact clone line is in the script')
  assert.equal(script.includes("pnpm_run install --registry '" + REGISTRY + "'"), true, 'the registry install is there')
  assert.equal(script.includes('corepack pnpm'), true, 'the corepack fallback is there')
  assert.equal(script.includes('pnpm_run build'), true, 'the build step is there')
  assert.equal(script.includes('exec > >('), false, 'process substitution is bash-only and is not used')
  assert.equal(script.includes('set -o pipefail'), false, 'pipefail is not POSIX and is not set')
  assert.equal(script.includes('tee -a "$LOG"'), true, 'each command tees into the log')
  assert.equal(script.includes('> "$MARKER"'), true, 'the marker is written as the last step')
  assert.equal(script.includes('command -v pnpm'), true, 'the fallback is decided at run time')
  assert.equal(script.includes("it'\\''s root"), true, 'a quote inside a path is closed, escaped and reopened')
  assert.equal(/^[\x20-\x7E\r\n\t]*$/.test(script), true, 'the script is pure ASCII too')
  console.log('  script (sh): strict mode, tee, the marker last and an escaped quote in a path')
}

// -------------------------------------------------------------- listInstalled

{
  assert.deepEqual(await listInstalled(join('vroot', 'missing')), [], 'a missing root lists nothing')
  assert.deepEqual(await listInstalled(''), [], 'an empty root lists nothing')
  assert.deepEqual(await listInstalled(undefined), [], 'a missing root argument lists nothing')

  const root = join('vroot', 'cores')
  const staging = join(root, 'DeepSeekHarness-v0.1.0')
  const complete = join(root, 'DeepSeekHarness-v0.2.1-alpha.4')
  const foreign = join(root, 'SeedHarness-v9')
  const fs = memFs([
    root,
    staging,
    join(staging, 'package.json'),
    join(staging, 'node_modules'),
    complete,
    join(complete, 'package.json'),
    join(complete, 'node_modules'),
    join(complete, '.dsh-install-complete'),
    foreign,
    { path: join(root, 'loose-file.txt'), kind: 'file' },
  ], { [join(complete, '.dsh-install-complete')]: 2000, [join(staging, 'package.json')]: 1000 })

  // The foreign directory IS a git checkout - of something else. Its remote is
  // what proves it is not a core, which is the strongest form of the rule.
  const calls = []
  const runner = fakeGitRunner({
    [foreign]: {
      log: gitLog('f'.repeat(40), '2026-01-01T00:00:00+08:00', 'HEAD -> main, origin/main'),
      remote: gitRemote('https://github.com/example/seed-harness.git'),
    },
  }, calls)

  const listing = await listInstalled(root, { ...fs, runCommand: runner })
  assert.equal(listing.length, 2, 'only DSH cores are reported')
  assert.equal(listing[0].name, 'DeepSeekHarness-v0.2.1-alpha.4', 'the complete install sorts first')
  assert.equal(listing[0].version, 'v0.2.1-alpha.4', 'the version is the directory suffix')
  assert.equal(listing[0].dir, complete, 'the directory is absolute under the root')
  assert.equal(listing[0].exists, true, 'a listed version exists')
  assert.equal(listing[0].hasSource, true, 'package.json is the source signal')
  assert.equal(listing[0].hasDeps, true, 'node_modules is the dependency signal')
  assert.equal(listing[0].complete, true, 'the marker makes it complete')
  assert.equal(listing[0].hasBuild, true, 'the marker also proves the build step returned')
  assert.equal(listing[0].updatedAt, 2000, 'the marker mtime is the update time')

  assert.equal(listing[1].name, 'DeepSeekHarness-v0.1.0', 'the staged install comes second')
  assert.equal(listing[1].hasSource, true, 'a staged install has its source')
  assert.equal(listing[1].hasDeps, true, 'a staged install has its dependencies')
  assert.equal(listing[1].complete, false, 'without a marker it is not complete')
  assert.equal(listing[1].hasBuild, false, 'neither a marker nor a build record means not built')
  assert.equal(listing[1].updatedAt, null, 'no marker means no update time')
  assert.equal(listing.some((entry) => entry.name === 'SeedHarness-v9'), false, 'a checkout of something else is ignored')
  assert.equal(listing.some((entry) => entry.name === 'loose-file.txt'), false, 'a plain file is ignored')

  // These two have no usable git - the install-in-progress case - and must still
  // be listed, because "no git yet" is not the same as "not a version".
  assert.equal(listing.every((entry) => entry.sha === null), true, 'a core with no git is still listed, without a commit')
  assert.equal(listing.every((entry) => entry.isCore === true), true, 'and it is reported as a core')
  assert.equal(calls.filter((call) => call.args[1] === foreign).length, 2, 'a foreign checkout costs one state read and one remote read')
  assert.equal(calls.some((call) => call.args[1] === join(root, 'loose-file.txt')), false, 'a plain file is never probed with git')

  // `ttlMs: 0` because the scan above is still inside the memo window: this
  // assertion is about the readdir failure, not about the memo (which has its
  // own block below).
  const noRoot = await listInstalled(root, { readdir: async () => { throw new Error('ENOENT') }, ttlMs: 0 })
  assert.deepEqual(noRoot, [], 'an unreadable root is an empty list, not an error')
  console.log('  listInstalled: stages a version, ignores the rest, sorts the newest first')
}

// ------------------------------------------ listInstalled, identity by git state

{
  resetInstallCache()
  const root = join('vroot', 'DSH')
  const a3 = join(root, 'deepseekharness021a3')
  const a2 = join(root, 'deepseekharness021a2')
  const a1 = join(root, 'deepseekharness021a1')
  const rc = join(root, 'deepseekharness020rc1')
  const notes = join(root, 'notes')
  const marker = join(a3, '.dsh-install-complete')
  const fs = memFs([
    root,
    a3,
    a2,
    a1,
    rc,
    notes,
    join(root, 'node_modules'),
    join(root, '.git'),
    join(root, '.hidden'),
    join(a3, 'package.json'),
    join(a3, 'node_modules'),
    join(a2, 'node_modules'),
    join(a2, '.dsh-build', 'client-build-environment.json'),
    marker,
  ], { [marker]: 4242 })
  const calls = []
  const runner = fakeGitRunner({
    [a3]: {
      // The shape measured on this machine: a --depth 1 clone, so `grafted` is
      // the shallow boundary and there are no local tags at all.
      log: gitLog('571902028a75c64c1d767f4ae5fd099485f0ddf0', '2026-10-14T21:15:15+08:00', 'grafted, HEAD -> master, origin/master, origin/HEAD'),
      remote: gitRemote(REPO),
    },
    [a2]: {
      log: gitLog('c'.repeat(40), '2026-10-10T09:00:00+08:00', 'HEAD -> master, origin/master'),
      remote: gitRemote(REPO),
    },
    [a1]: {
      log: gitLog('b'.repeat(40), '2026-10-01T09:00:00+08:00', 'HEAD -> master, origin/master'),
      remote: gitRemote(REPO),
    },
    [rc]: {
      log: gitLog('a'.repeat(40), '2026-09-01T09:00:00+08:00', 'HEAD -> master, origin/master'),
      remote: gitRemote(REPO),
    },
  }, calls)

  const listing = await listInstalled(root, { ...fs, runCommand: runner, now: () => 1000 })
  assert.deepEqual(
    listing.map((entry) => entry.name),
    ['deepseekharness021a3', 'deepseekharness021a2', 'deepseekharness021a1', 'deepseekharness020rc1'],
    'four hand-cloned cores are listed, newest commit first',
  )

  const head = listing[0]
  assert.equal(head.sha, '571902028a75c64c1d767f4ae5fd099485f0ddf0', 'the full sha comes from git')
  assert.equal(head.short, '5719020', 'and a short form is carried for the card')
  assert.equal(head.commitDate, '2026-10-14T21:15:15+08:00', 'the committer date comes from git')
  assert.equal(head.branch, 'master', 'the branch is parsed out of the decorations')
  assert.equal(head.tag, null, 'a depth-1 clone has no local tags')
  assert.deepEqual(head.tags, [], 'and therefore no tag list')
  assert.equal(head.remote, REPO, 'the origin remote identifies it as a DSH core')
  assert.equal(head.shallow, true, 'the grafted decoration marks a shallow clone')
  assert.equal(head.isCore, true, 'it is reported as a core')
  assert.equal(head.version, null, 'a hand-cloned directory carries no version and git has no tag')
  assert.equal(head.complete, true, 'the completion marker is still read')
  assert.equal(head.updatedAt, 4242, 'and its mtime is the update time')
  assert.equal(head.hasSource, true, 'package.json is the source signal')
  assert.equal(head.hasDeps, true, 'node_modules is the dependency signal')
  assert.equal(head.hasBuild, true, 'the completion marker proves the build step returned')

  // A checkout that was built by hand: the build record is the only signal, and
  // the installer's marker is absent - the two proofs are independent.
  const handBuilt = listing[1]
  assert.equal(handBuilt.hasBuild, true, 'the build record proves a hand-made checkout was built')
  assert.equal(handBuilt.hasDeps, true, 'and its dependencies are there')
  assert.equal(handBuilt.complete, false, 'even though this installer never completed it')
  assert.equal(listing[3].hasBuild, false, 'a core with neither signal is reported as not built')

  const logCall = calls.find((call) => call.args[1] === a3 && call.args[2] === 'log')
  assert.equal(logCall.command, 'git', 'the state probe is one git call')
  assert.deepEqual(logCall.args, ['-C', a3, 'log', '-1', '--format=%H%x1f%cI%x1f%D'], 'with the exact format the parser expects')
  assert.equal(logCall.options.timeoutMs > 0 && logCall.options.timeoutMs <= 10000, true, 'a hung git cannot hold the listing open')
  const remoteCall = calls.find((call) => call.args[1] === a3 && call.args[2] === 'remote')
  assert.deepEqual(remoteCall.args, ['-C', a3, 'remote', 'get-url', 'origin'], 'the identity probe is the origin URL')

  assert.equal(listing.some((entry) => entry.name === 'notes'), false, 'a directory that is not a repository is skipped')
  assert.equal(calls.filter((call) => call.args[1] === notes).length, 1, 'and it costs exactly one failed probe')
  assert.equal(calls.filter((call) => call.args[1] === notes && call.args[2] === 'remote').length, 0, 'no remote probe after the log call already failed')
  for (const skipped of ['node_modules', '.git', '.hidden']) {
    assert.equal(calls.some((call) => call.args[1] === join(root, skipped)), false, skipped + ' is never probed')
  }
  assert.equal(calls.length, 5 + 4, 'four cores cost two probes each and the stray directory costs one')
  console.log('  listInstalled (git): hand-cloned cores are found by their remote and their sha')
}

// ------------------------------- listInstalled, tags, shallow and no git at all

{
  resetInstallCache()
  const root = join('vroot', 'mixed')
  const fork = join(root, 'my-fork')
  const tagged = join(root, 'deepseekharness-tagged')
  const noGit = join(root, 'DeepSeekHarness-v9.9.9')
  const broken = join(root, 'deepseekharness-broken')
  const fs = memFs([root, fork, tagged, noGit, broken, join(fork, '.git'), join(fork, '.git', 'shallow')])
  const calls = []
  const runner = fakeGitRunner({
    [fork]: {
      log: gitLog('d'.repeat(40), '2026-10-15T01:00:00Z', 'HEAD -> main'),
      remote: gitRemote(REPO),
    },
    [tagged]: {
      log: gitLog('e'.repeat(40), '2026-10-13T01:00:00Z', 'HEAD -> release, tag: dsh-v0.2.1-alpha.4, tag: v9'),
      remote: gitRemote(REPO),
    },
  }, calls)

  const listing = await listInstalled(root, { ...fs, runCommand: runner, now: () => 1 })
  assert.equal(listing.length, 4, 'a core is recognised by its remote OR by its name')

  const forkEntry = listing.find((entry) => entry.name === 'my-fork')
  assert.equal(forkEntry.isCore, true, 'the remote decides identity even when the name says nothing')
  assert.equal(forkEntry.branch, 'main', 'a non-master branch is read')
  assert.equal(forkEntry.tag, null, 'no tag decoration means no tag')
  assert.equal(forkEntry.version, null, 'and no version either')
  assert.equal(forkEntry.shallow, true, 'a .git/shallow file is a shallow clone, grafted or not')

  const taggedEntry = listing.find((entry) => entry.name === 'deepseekharness-tagged')
  assert.equal(taggedEntry.tag, 'dsh-v0.2.1-alpha.4', 'the release tag is preferred over the other tag')
  assert.deepEqual(taggedEntry.tags, ['dsh-v0.2.1-alpha.4', 'v9'], 'every tag at HEAD is reported')
  assert.equal(taggedEntry.version, 'v0.2.1-alpha.4', 'the version comes from the tagged release')
  assert.equal(taggedEntry.branch, 'release', 'and the branch is still read')
  assert.equal(taggedEntry.shallow, false, 'no grafted marker and no shallow file means a full clone')

  const noGitEntry = listing.find((entry) => entry.name === 'DeepSeekHarness-v9.9.9')
  assert.equal(noGitEntry.sha, null, 'a directory with no git has no commit')
  assert.equal(noGitEntry.short, null, 'and no short sha')
  assert.equal(noGitEntry.commitDate, null, 'and no commit date')
  assert.equal(noGitEntry.branch, null, 'and no branch')
  assert.equal(noGitEntry.tag, null, 'and no tag')
  assert.deepEqual(noGitEntry.tags, [], 'and an empty tag list')
  assert.equal(noGitEntry.remote, null, 'and no remote')
  assert.equal(noGitEntry.shallow, false, 'and it is not shallow')
  assert.equal(noGitEntry.isCore, true, 'but the installer prefix still makes it a core')
  assert.equal(noGitEntry.version, 'v9.9.9', 'with the version from its name')

  const brokenEntry = listing.find((entry) => entry.name === 'deepseekharness-broken')
  assert.equal(brokenEntry.sha, null, 'a core whose git call fails is reported rather than dropped')
  assert.equal(brokenEntry.isCore, true, 'and it is still identified by its name')

  assert.deepEqual(
    listing.slice(0, 2).map((entry) => entry.name),
    ['my-fork', 'deepseekharness-tagged'],
    'entries with a commit sort newest first',
  )
  assert.deepEqual(
    listing.slice(2).map((entry) => entry.name).sort(),
    ['DeepSeekHarness-v9.9.9', 'deepseekharness-broken'],
    'entries without a commit sort last',
  )
  console.log('  listInstalled (tags/shallow): a foreign remote name, a release tag and a missing git are all survivable')
}

// ------------------------------------------- listInstalled, the memoised scan

{
  resetInstallCache()
  const root = join('vroot', 'memo')
  const core = join(root, 'deepseekharness021a3')
  const fs = memFs([root, core])
  const calls = []
  const runner = fakeGitRunner({
    [core]: {
      log: gitLog('9'.repeat(40), '2026-10-14T21:15:15+08:00', 'HEAD -> master'),
      remote: gitRemote(REPO),
    },
  }, calls)

  let clock = 100000
  const options = { ...fs, runCommand: runner, now: () => clock }
  const first = await listInstalled(root, options)
  assert.equal(first.length, 1, 'the core is found')
  const afterFirst = calls.length
  assert.equal(afterFirst, 2, 'the first scan costs a state probe and a remote probe')

  const second = await listInstalled(root, options)
  assert.equal(calls.length, afterFirst, 'a second scan inside the window spawns nothing')
  assert.deepEqual(second.map((entry) => entry.name), first.map((entry) => entry.name), 'and answers the same')

  second[0].name = 'mutated-by-the-caller'
  const third = await listInstalled(root, options)
  assert.equal(third[0].name, 'deepseekharness021a3', 'a caller cannot poison the memo by editing a row')

  clock = 105000
  await listInstalled(root, options)
  assert.equal(calls.length, afterFirst, 'still inside the window')

  clock = 111000
  await listInstalled(root, options)
  assert.equal(calls.length, afterFirst + 2, 'past the window the scan runs again')

  const beforeTtlZero = calls.length
  await listInstalled(root, { ...options, ttlMs: 0 })
  await listInstalled(root, { ...options, ttlMs: 0 })
  assert.equal(calls.length, beforeTtlZero + 4, 'ttlMs: 0 turns the memo off')

  resetInstallCache()
  await listInstalled(root, options)
  assert.equal(calls.length, beforeTtlZero + 6, 'resetInstallCache drops the memo')

  // Starting an install invalidates the memo for its root: the target directory
  // is about to appear, so the card must not keep showing the pre-install list.
  const spawned = []
  const started = await startInstall({
    root: join(process.cwd(), 'vroot', 'memo'),
    version: 'v9.9.9',
    ref: 'dsh-v9.9.9',
    platform: 'win32',
    env: winEnv(),
    exists: () => true,
    readdirSync: () => [],
    mkdir: async () => {},
    writeFile: async () => {},
    spawn: fakeSpawn(spawned, 7),
  })
  assert.equal(started.started, true, 'the install starts')
  const beforeInstall = calls.length
  await listInstalled(root, options)
  assert.equal(calls.length > beforeInstall, true, 'starting an install drops the memo for its root')
  console.log('  listInstalled (memo): the scan is remembered per root and the reset clears it')
}

// -------------------------------------------------------------- startInstall

{
  resetInstallCache()
  const root = join(process.cwd(), '.dsh-install-test', 'cores')
  const written = []
  const calls = []
  const options = {
    root,
    version: 'v0.2.1-alpha.4',
    ref: 'dsh-v0.2.1-alpha.4',
    platform: 'win32',
    env: winEnv({ HTTPS_PROXY: PROXY }),
    exists: () => true,
    readdirSync: () => [],
    mkdir: async (path) => { written.push({ path: path, kind: 'mkdir' }) },
    writeFile: async (path, data) => { written.push({ path: path, kind: 'write', data: data }) },
    spawn: fakeSpawn(calls, 4242),
  }
  const plan = planInstall(options)
  const result = await startInstall(options)
  assert.equal(result.started, true, 'the install started')
  assert.equal(result.reason, null, 'a started install has no refusal reason')
  assert.equal(result.pid, 4242, 'the pid of the detached child is reported')
  assert.equal(result.dir, plan.dir, 'the result names the target')
  assert.equal(result.scriptPath, plan.scriptPath, 'the result names the script')
  assert.equal(result.logPath, plan.logPath, 'the result names the log')
  assert.equal(result.mode, 'window', 'the result reports the launch mode')

  assert.equal(written.length, 2, 'the root is made and the script is written')
  assert.deepEqual(written[0], { path: plan.root, kind: 'mkdir' }, 'the root is created recursively')
  assert.equal(written[1].path, plan.scriptPath, 'the script goes where the plan said')
  assert.equal(written[1].data.charCodeAt(0), 0xfeff,
    'the win32 script opens with a BOM, without which PowerShell 5.1 decodes it as ANSI')
  assert.equal(written[1].data, '\uFEFF' + plan.script, 'the file is the planned script, BOM included')

  assert.equal(calls.length, 1, 'exactly one process was spawned')
  assert.equal(calls[0].command, 'wt.exe', 'Windows Terminal opens the window')
  assert.deepEqual(calls[0].args, ['powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', plan.scriptPath],
    'wt is handed the PowerShell command line')
  assert.equal(calls[0].options.detached, true, 'the child outlives DSH')
  assert.equal(calls[0].options.stdio, 'ignore', 'no pipe is held open for minutes')
  assert.equal(calls[0].options.shell, undefined, 'no shell is used with an interpolated path')
  assert.equal(calls[0].options.windowsHide, false, 'a window launch is not hidden')
  assert.equal(calls[0].options.env.HTTPS_PROXY, PROXY, 'the parent environment, proxy and all, is inherited')
  assert.equal(calls[0].options.env.DSH_INSTALL_PAUSE, '1', 'the script is told a person is watching')
  console.log('  startInstall: writes the script and opens exactly one detached window')
}

{
  resetInstallCache()
  const root = join(process.cwd(), '.dsh-install-test', 'cores')
  const calls = []
  const result = await startInstall({
    root,
    version: 'v1',
    ref: null,
    platform: 'win32',
    env: winEnv(),
    // wt is missing, cmd and the tools are there: the documented fallback order.
    exists: (path) => !path.endsWith('wt.exe'),
    readdirSync: () => [],
    mkdir: async () => {},
    writeFile: async () => {},
    spawn: fakeSpawn(calls, 7),
  })
  assert.equal(result.started, true, 'the cmd fallback still starts')
  assert.equal(result.command, 'cmd.exe', 'without wt the classic console is the window')
  assert.deepEqual(calls[0].args, [
    '/c', 'start', '', 'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', result.scriptPath,
  ], 'cmd is told to start a PowerShell that survives')
  assert.equal(calls[0].options.windowsHide, false, 'the classic console is a window too')
  assert.equal(calls[0].options.env.DSH_INSTALL_PAUSE, '1', 'the pause flag travels with the window command')
  console.log('  startInstall: falls back to cmd start when Windows Terminal is absent')
}

{
  resetInstallCache()
  const root = join(process.cwd(), '.dsh-install-test', 'cores')
  const calls = []
  const result = await startInstall({
    root,
    version: 'v1',
    platform: 'win32',
    env: winEnv(),
    // Neither terminal is reachable: the log becomes the only interface.
    exists: (path) => /git\.exe$|pnpm\.exe$/.test(path),
    readdirSync: () => [],
    mkdir: async () => {},
    writeFile: async () => {},
    spawn: fakeSpawn(calls, 9),
  })
  assert.equal(result.started, true, 'the headless fallback still starts')
  assert.equal(result.mode, 'log', 'no terminal means log mode')
  assert.deepEqual(calls[0].args, ['-ExecutionPolicy', 'Bypass', '-File', result.scriptPath],
    'log mode drops -NoExit, which would only leave a hidden process alive')
  assert.equal(calls[0].options.windowsHide, true, 'a headless run is hidden')
  assert.equal(calls[0].options.env.DSH_INSTALL_PAUSE, undefined, 'nothing pauses with no console to pause at')
  console.log('  startInstall: with no terminal it runs headless and leaves the log behind')
}

{
  resetInstallCache()
  const root = join(process.cwd(), '.dsh-install-test', 'cores')
  const calls = []
  const written = []
  const result = await startInstall({
    root,
    version: 'v1',
    platform: 'linux',
    env: posixEnv(),
    exists: () => true,
    readdirSync: () => [],
    mkdir: async () => {},
    writeFile: async (path, data) => { written.push({ path: path, data: data }) },
    spawn: fakeSpawn(calls, 11),
  })
  assert.equal(result.command, 'x-terminal-emulator', 'the first POSIX terminal that exists wins')
  assert.deepEqual(calls[0].args, ['-e', 'sh', result.scriptPath], 'each terminal gets its own -e/-- spelling')
  assert.equal(result.scriptPath.endsWith('.sh'), true, 'a POSIX plan writes a .sh script')
  assert.equal(written.length, 1, 'only the script is written for a POSIX plan')
  assert.equal(written[0].path, result.scriptPath, 'the script goes where the plan said')
  assert.equal(written[0].data.charCodeAt(0) === 0xfeff, false, 'a .sh script never carries a BOM')
  assert.equal(written[0].data.split('\n')[0], '#!/bin/sh', 'and it opens with the sh shebang')
  console.log('  startInstall: POSIX opens the terminal with the flag that terminal uses')
}

{
  resetInstallCache()
  const root = join(process.cwd(), '.dsh-install-test', 'cores')
  const calls = []
  const refused = await startInstall({
    root: 'relative/cores',
    version: 'v1',
    platform: 'win32',
    env: winEnv(),
    exists: () => true,
    readdirSync: () => [],
    spawn: fakeSpawn(calls),
  })
  assert.equal(refused.started, false, 'a refused plan starts nothing')
  assert.equal(refused.reason, 'bad-root', 'the refusal carries the plan reason')
  assert.equal(refused.pid, null, 'a refusal has no pid')
  assert.equal(calls.length, 0, 'nothing at all is spawned on a refusal')

  const noVersion = await startInstall({ root, platform: 'win32', env: winEnv(), spawn: fakeSpawn(calls) })
  assert.equal(noVersion.started, false, 'a missing version starts nothing')
  assert.equal(noVersion.reason, 'no-version', 'and says so')
  assert.equal(calls.length, 0, 'still nothing spawned')

  const writeRefused = await startInstall({
    root,
    version: 'v1',
    platform: 'win32',
    env: winEnv(),
    exists: () => true,
    readdirSync: () => [],
    mkdir: async () => {},
    writeFile: async () => { throw new Error('EACCES') },
    spawn: fakeSpawn(calls),
  })
  assert.equal(writeRefused.started, false, 'an unwritable script path starts nothing')
  assert.equal(writeRefused.reason, 'write-failed', 'and reports why')
  assert.equal(calls.length, 0, 'a failed write never reaches a spawn')
  console.log('  startInstall: a refusal and a failed write spawn nothing at all')
}

// ------------------------------------------------------------------- the busy path

{
  resetInstallCache()
  const root = join(process.cwd(), '.dsh-install-test', 'cores')
  const calls = []
  const options = {
    root,
    version: 'v1',
    platform: 'win32',
    env: winEnv(),
    exists: () => true,
    readdirSync: () => [],
    mkdir: async () => {},
    writeFile: async () => {},
    spawn: fakeSpawn(calls, 31),
  }
  const first = await startInstall(options)
  assert.equal(first.started, true, 'the first click starts the run')
  const second = await startInstall(options)
  assert.equal(second.started, false, 'a second click during the run is refused')
  assert.equal(second.reason, 'busy', 'and the refusal says the directory is busy')
  assert.equal(calls.length, 1, 'only one window was ever opened')
  assert.equal(planInstall(options).reason, 'busy', 'the plan reports the same state')

  resetInstallCache()
  const after = await startInstall(options)
  assert.equal(after.started, true, 'after the reset the same directory can be planned again')
  assert.equal(calls.length, 2, 'and that is a genuinely new window')
  resetInstallCache()
  console.log('  resetInstallCache + busy: one window per directory, and the reset frees it')
}

// ------------------------------------------------------- the real filesystem

{
  // The fakes above prove the logic; this block proves the DEFAULTS wire to the
  // same conclusions - a real existing non-empty directory is still refused, and
  // a real marker is still what makes an install complete.
  //
  // Only the git probe is injected here: the point of the block is the default
  // FILESYSTEM wiring, and a test suite that shells out to git would depend on a
  // git being installed (and on this temp directory not being a repository).
  const noGit = async () => ({ ok: false, stdout: '', stderr: 'fatal: not a git repository', code: 128 })
  const temp = await mkdtemp(join(tmpdir(), 'dsh-install-'))
  try {
    const root = join(temp, 'cores')
    const target = join(root, 'DeepSeekHarness-v0.2.1-alpha.4')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'package.json'), '{}\n')

    const refused = planInstall({ root, version: 'v0.2.1-alpha.4', ref: 'dsh-v0.2.1-alpha.4' })
    assert.equal(refused.ok, false, 'a real existing target is refused')
    assert.equal(refused.reason, 'exists', 'and it is the exists reason')

    await mkdir(join(target, 'node_modules'), { recursive: true })
    await writeFile(join(target, '.dsh-install-complete'), 'version: v0.2.1-alpha.4\n')
    const listing = await listInstalled(root, { runCommand: noGit })
    assert.equal(listing.length, 1, 'the real directory is listed')
    assert.equal(listing[0].version, 'v0.2.1-alpha.4', 'with the version it was named after')
    assert.equal(listing[0].hasSource, true, 'the real package.json is seen')
    assert.equal(listing[0].hasDeps, true, 'the real node_modules is seen')
    assert.equal(listing[0].complete, true, 'the real marker makes it complete')
    assert.equal(typeof listing[0].updatedAt, 'number', 'the real marker mtime is read')
    assert.equal(listing[0].sha, null, 'and a directory with no git is listed without a commit')

    assert.deepEqual(await listInstalled(join(temp, 'nothing-here')), [], 'a real missing root is an empty list')
    assert.equal(dirname(target), root, 'the target really sits under the root')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
  console.log('  real filesystem: the default io agrees with the injected fakes')
}

// ---------------------------------------------------------------------- helpers

/** Single-quote a string for PowerShell, the way the generated script does. */
function powerShellQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/** Single-quote a string for /bin/sh, the way the generated script does. */
function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/**
 * A tiny in-memory filesystem in the injectable shape: synchronous `exists` and
 * `readdirSync` (the plan is synchronous), async `readdir`/`stat` (the listing is
 * not), and one mtime per entry for the marker checks.
 *
 * @param entries - paths; a string is a directory, `{ path, kind, mtimeMs }` is
 *   explicit about a file or a timestamp.
 */
function memFs(entries, times = {}) {
  const map = new Map()
  for (const entry of entries) {
    const path = typeof entry === 'string' ? entry : entry.path
    map.set(path, { kind: typeof entry === 'string' ? 'dir' : (entry.kind ?? 'dir') })
  }
  for (const [path, at] of Object.entries(times)) map.set(path, { kind: 'file', at: at })
  const children = (path) => {
    const prefix = path.endsWith(sep) ? path : path + sep
    return [...map.keys()]
      .filter((candidate) => candidate.startsWith(prefix))
      .map((candidate) => candidate.slice(prefix.length))
      .filter((rest) => rest !== '' && !rest.includes(sep))
  }
  return {
    exists: (path) => map.has(path),
    readdirSync: (path) => children(path),
    readdir: async (path) => children(path),
    stat: async (path) => {
      const entry = map.get(path)
      if (!entry) throw new Error('ENOENT: ' + path)
      return { isDirectory: () => entry.kind === 'dir', mtimeMs: entry.at ?? 0 }
    },
  }
}

/**
 * A spawn stand-in that records every call. `.once` is present because the real
 * child has it and `startInstall` uses it to learn when a run is over.
 */
function fakeSpawn(calls, pid = 1) {
  return (command, args, options) => {
    calls.push({ command: command, args: Array.isArray(args) ? args.slice(0) : args, options: options })
    return {
      pid: pid,
      once() {},
    }
  }
}

/** One `git log -1` answer in the shape the command runner returns. */
function gitLog(sha, date, refs) {
  return { ok: true, stdout: sha + '\x1f' + date + '\x1f' + refs + '\n', stderr: '', code: 0 }
}

/** One `git remote get-url origin` answer. */
function gitRemote(url) {
  return { ok: true, stdout: url + '\n', stderr: '', code: 0 }
}

/**
 * A git stand-in in the injectable `runCommand` shape: it answers by directory
 * and by verb, and records every call so a test can assert how many probes a
 * directory cost. A directory that is not in the map fails the way git fails
 * outside a repository - which is the case the scan has to survive with exactly
 * one spawn, never two.
 *
 * @param byDir - `{ [dir]: { log, remote } }`.
 * @param calls - the array every call is appended to.
 */
function fakeGitRunner(byDir, calls) {
  return async (command, args, options) => {
    calls.push({ command: command, args: args.slice(0), options: options })
    const dir = args[1]
    const spec = byDir[dir]
    if (!spec) return { ok: false, stdout: '', stderr: 'fatal: not a git repository', code: 128 }
    if (args[2] === 'log') return spec.log
    if (args[2] === 'remote') return spec.remote ?? { ok: false, stdout: '', stderr: '', code: 2 }
    return { ok: false, stdout: '', stderr: 'unexpected git verb', code: 1 }
  }
}

// ----------------------------------------------------- defaultInstallRoot

/**
 * The card must never ship someone else's directory, so the default root is
 * inferred from the core that is running: `DSH_INSTALL_ROOT` first, then the
 * core directory found above the CLI entry, then above the process cwd. A core
 * outside a core-looking directory is a refusal, not a guess.
 */
{
  const base = resolve(parsePath(tmpdir()).root, 'ph-default-root')
  const core = join(base, 'DeepSeekHarness-v0.9.9')
  const entry = join(core, 'apps', 'cli', 'bin', 'dsh.js')

  assert.equal(
    defaultInstallRoot({ env: {}, argv: ['node', entry], cwd: join(base, 'unrelated') }),
    base,
    'the root is the parent of the core the CLI was started from',
  )
  assert.equal(
    defaultInstallRoot({ env: {}, argv: ['node', join(base, 'no-such-entry.js')], cwd: core }),
    base,
    'the process cwd is the fallback',
  )
  assert.equal(
    defaultInstallRoot({ env: { DSH_INSTALL_ROOT: join(base, 'custom') }, argv: ['node', entry], cwd: core }),
    join(base, 'custom'),
    'DSH_INSTALL_ROOT wins',
  )
  assert.equal(
    defaultInstallRoot({ env: { DSH_INSTALL_ROOT: '   ' }, argv: ['node', entry], cwd: core }),
    base,
    'a blank DSH_INSTALL_ROOT is treated as unset',
  )
  assert.equal(
    defaultInstallRoot({ env: {}, argv: ['node', join(base, 'no-such-entry.js')], cwd: join(base, 'plain') }),
    '',
    'a core outside a core directory answers empty instead of guessing',
  )
  assert.equal(
    defaultInstallRoot({ env: {}, argv: ['node', join(base, 'deepseekharness021a3', 'bin', 'dsh.js')], cwd: base }),
    base,
    'the lowercase spelling a hand clone uses is recognised too',
  )
  assert.equal(
    defaultInstallRoot({ env: {}, argv: ['node', join(base, 'deepseek-harness', 'packages', 'cli', 'lib', 'index.js')], cwd: join(base, 'deepseek-harness') }),
    base,
    'the repository\'s documented clone name (with a hyphen) is a core directory',
  )
  assert.equal(
    defaultInstallRoot({
      env: {},
      argv: ['node', join(base, 'resources', 'runtime', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')],
      cwd: join(base, 'profiles', 'desktop'),
    }),
    '',
    'a packaged Desktop has no install root to infer from its launch path',
  )
  assert.equal(
    defaultRunningCore({ argv: ['node', entry], cwd: join(base, 'unrelated') }),
    core,
    'the running core is the core directory above the CLI entry',
  )
  assert.equal(
    defaultRunningCore({
      argv: ['node', join(base, 'deepseek-harness', 'packages', 'cli', 'lib', 'index.js')],
      cwd: base,
    }),
    join(base, 'deepseek-harness'),
    'a hyphenated clone reports the directory that is actually running',
  )
  assert.equal(
    defaultRunningCore({
      argv: ['node', join(base, 'resources', 'runtime', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')],
      cwd: join(base, 'profiles', 'desktop'),
    }),
    '',
    'a packaged Desktop has no core directory; its version comes from the launcher',
  )
}

// --------------------------------------------------------------- desktopCore

/**
 * A packaged Desktop ships the core inside the application bundle, so the
 * version the launcher passes to the Host is the only local reading there is.
 * A build without that variable must stay silent instead of inventing a core.
 */
{
  const entry = desktopCore({ env: { DSH_CLIENT_VERSION: '0.2.2-rc.1' } })
  assert.ok(entry, 'a Desktop build reports its bundled core')
  assert.equal(entry.kind, 'desktop', 'the entry says where the reading came from')
  assert.equal(entry.version, '0.2.2-rc.1', 'the version is the build version')
  assert.equal(entry.tag, 'dsh-v0.2.2-rc.1', 'the tag is the one the GitHub release uses')
  assert.equal(entry.sha, null, 'a packaged bundle has no commit to report')
  assert.equal(entry.isCore, true, 'the card lists it as a core')
  assert.equal(entry.hasBuild, true, 'a running packaged core is built by definition')
  assert.equal(desktopCore({ env: {} }), null, 'a local build has no Desktop version to report')
  assert.equal(desktopCore({ env: { DSH_CLIENT_VERSION: '   ' } }), null, 'a blank version is not a reading')
  assert.equal(desktopCore({ env: { DSH_CLIENT_VERSION: 'v0.2.2-rc.1' } }).version, '0.2.2-rc.1',
    'a leading v is accepted and normalised away')
}

console.log('dsh-install: all assertions passed')
