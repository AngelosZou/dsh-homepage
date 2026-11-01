/**
 * dsh-homepage — Host half, DSH core installer.
 *
 * Lays out the commands that fetch one DSH core version into the directory the
 * user picked for their core versions, runs them in a NEW DETACHED TERMINAL
 * WINDOW, and reports which versions are already sitting there.
 *
 * Contract:
 *
 *  - nothing reaches a directory name except the output of `sanitizeVersion()`,
 *    so a version string that arrived from the network can never steer a path;
 *  - `planInstall()` is pure and synchronous: it decides, it never spawns and it
 *    never writes. Everything a caller needs to show or to question is in the
 *    returned plan;
 *  - the plan carries a script (PowerShell on Windows, `/bin/sh` elsewhere) and
 *    `startInstall()` is the only function that touches the disk or a process
 *    (it writes that script and spawns the window), which is what lets the unit
 *    test drive the whole module with injected `exists`/`readdir`/`spawn`;
 *  - a detached window is used because an install plus build takes minutes; the
 *    running DSH core must not wait for it, and the spawned child has to outlive
 *    the DSH process, hence `detached: true` + `stdio: 'ignore'`;
 *  - the child environment is INHERITED, not rebuilt: a machine that reaches
 *    GitHub only through the proxy in its parent environment must keep that
 *    environment, and a direct clone is the case that times out in practice;
 *  - `startInstall()` is idempotent-safe: while a run for one target directory
 *    is in flight, a second call refuses instead of spawning a second window;
 *  - `listInstalled()` reports a core by its GIT STATE (the origin remote, or a
 *    `deepseekharness*` name) rather than by the `DeepSeekHarness-` prefix alone,
 *    so a core cloned by hand is listed too, with its commit, branch, tag and
 *    build state read from one `git log -1` plus the remote probe;
 *  - the public API never throws. Refusals come back as `reason` codes;
 *  - no filesystem or process work happens at import time.
 *
 * @module dsh-homepage/host/dsh-install
 */
import { lstatSync, readdirSync, promises as fsp } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, basename, isAbsolute, join, parse as parsePath, resolve } from 'node:path'

/** The only repository this installer knows how to fetch. */
const DEFAULT_REPO = 'https://github.com/deepseek-ai/deepseek-harness.git'
/** The registry mirror the user asked for; a fixed constant, never interpolated from input. */
const DEFAULT_REGISTRY = 'https://registry.npmmirror.com'
/**
 * No proxy is assumed. A caller may force one, and the parent environment
 * always wins when it carries `HTTPS_PROXY`/`HTTP_PROXY`; guessing a local
 * address here would silently redirect someone else's git through a port that
 * is not theirs.
 */
const DEFAULT_PROXY = ''

/** Every managed version lives in `<root>/DeepSeekHarness-<version>`. */
const DIR_PREFIX = 'DeepSeekHarness-'
/** Release tags are spelled `dsh-<version>` in this repository. */
const TAG_PREFIX = 'dsh-'
/** Written by the last step of the script, so it also proves the script finished. */
const MARKER_NAME = '.dsh-install-complete'

/**
 * What `pnpm build` leaves in a checkout (`scripts/client-build-environment.ts`),
 * and what `scripts/clean.ts` deletes with the whole `.dsh-build` directory.
 *
 * A built core carries it and a checkout that has only been `pnpm install`-ed
 * does not - so it is the one honest build signal available for a core this
 * installer did not create.
 */
const BUILD_RECORD = join('.dsh-build', 'client-build-environment.json')

/**
 * How a DSH core is recognised without the installer's own prefix.
 *
 * The remote is the robust identity: it survives being renamed, and it is what
 * catches a core the user cloned by hand. The name is the fallback, lowercased
 * because a core cloned by hand may be spelled `deepseekharness021a3` while the
 * installer writes `DeepSeekHarness-<version>`. Matching ONLY that prefix is the
 * bug this scan exists to fix: the card reported the directory as empty while
 * the cores were sitting in it.
 */
const CORE_REMOTE_HINT = 'deepseek-harness'
const CORE_NAME_HINT = 'deepseekharness'
/** Directory names an unpacked core is installed under. */
const CORE_DIR_PATTERN = /^deepseekharness/i

/**
 * Guess the directory the user keeps DSH cores in, from the core that is
 * running right now, so the card never ships someone else's path.
 *
 * `DSH_INSTALL_ROOT` wins when it is set. Otherwise the running core is located
 * from its own launch path - `argv[1]` (the CLI entry) first, then the process
 * cwd, which is the checkout root when the core was started with `pnpm dsh` from
 * it - and the root is that core's parent when the core sits in a
 * `DeepSeekHarness-<version>` directory. A core installed somewhere that does
 * not look like a core directory yields `''` rather than a wrong guess; the card
 * then asks the user instead of scanning a stranger's directory.
 *
 * @param {object} [options] - injectable `env`, `argv`, `cwd`.
 * @returns {string} an absolute path, or `''` when nothing can be inferred.
 */
export function defaultInstallRoot(options = {}) {
  const env = options.env ?? process.env
  const configured = typeof env.DSH_INSTALL_ROOT === 'string' ? env.DSH_INSTALL_ROOT.trim() : ''
  if (configured !== '') return resolve(configured)
  const argv = options.argv ?? process.argv
  const entry = argv && typeof argv[1] === 'string' ? argv[1] : ''
  if (entry !== '') {
    const fromEntry = coreRootAbove(dirname(resolve(entry)))
    if (fromEntry !== '') return fromEntry
  }
  const cwd = options.cwd ?? process.cwd()
  return typeof cwd === 'string' && cwd !== '' ? coreRootAbove(resolve(cwd)) : ''
}

/**
 * Walk up from a directory until one looks like an unpacked core, then answer
 * its parent. An ancestor that is not a core keeps the walk going; reaching the
 * filesystem root answers `''`.
 * @param {string} start - an absolute directory.
 * @returns {string} the install root, or `''`.
 */
function coreRootAbove(start) {
  let dir = start
  for (;;) {
    if (CORE_DIR_PATTERN.test(basename(dir))) return dirname(dir)
    const parent = dirname(dir)
    if (parent === dir) return ''
    dir = parent
  }
}

/** Entries under a root that are never a core of their own. */
const SKIPPED_DIRS = new Set(['node_modules', '.git'])
/** Long enough for a cold git on a slow disk, short enough that a hang is invisible. */
const GIT_TIMEOUT_MS = 5000
/** A scan is remembered for this long; a mounted card must not spawn git per render. */
const DEFAULT_SCAN_TTL_MS = 10000

/** Longer than this and a version token is not a plausible version. */
const MAX_VERSION_LENGTH = 64
/** Characters a git ref may contain. Anything else is refused, not escaped. */
const REF_RE = /^[A-Za-z0-9._/-]+$/

const POWERSHELL_EXT = '.ps1'
const SH_EXT = '.sh'

/**
 * The UTF-8 byte order mark, written before a generated `.ps1`.
 *
 * Windows PowerShell 5.1 (`powershell.exe`, which every Windows 10/11 has) reads
 * a BOM-less script with the system's ANSI code page, so a script holding a path
 * like `C:\Users\张三\.dsh` is decoded to mojibake before its first command runs:
 * `Set-Location` then fails on a path that does not exist, the failure path logs
 * to the same mis-decoded name, and the process still exits 0. The BOM is the
 * only signal that makes 5.1 read the file as UTF-8; PowerShell 7 accepts it
 * too. A `sh` script must never carry one, so this is written for win32 only.
 */
const UTF8_BOM = '\uFEFF'

/**
 * How long a caller should be prepared to wait for a run: a full install plus
 * build was measured in minutes, not seconds. The plan never runs a process
 * itself, so this is carried for the caller's own wait limit.
 */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000

/** Terminal emulators on POSIX, with the flag each one uses to run a command. */
const POSIX_TERMINALS = [
  ['x-terminal-emulator', '-e'],
  ['gnome-terminal', '--'],
  ['konsole', '-e'],
  ['xterm', '-e'],
]

/** Windows default executable extensions, used when the environment omits PATHEXT. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

// ------------------------------------------------------------------ state

/**
 * Target directories with a run in flight for THIS process. A detached window
 * outlives the DSH process, so this can only ever be best-effort: it stops a
 * double click, and it is cleared when a child we can still observe exits.
 */
const inFlight = new Set()

/**
 * Memoised membership scans, keyed by the resolved root. A card re-render must
 * not shell out to git once per core, but a root the user just changed should
 * show up: the entry holds the instant it was taken and expires on its own.
 */
const scanCache = new Map()

// -------------------------------------------------------------- utilities

/**
 * Turn a version string into a token that is safe as one path segment.
 *
 * This is the only door into a directory name, so it is deliberately strict:
 * everything outside `[A-Za-z0-9._+-]` becomes `-`, runs of `-` collapse, the
 * leading and trailing `-`/`.` are trimmed, and the survivors `.`/`..`/empty or
 * anything longer than 64 characters are rejected outright.
 *
 * @param value - the version as it arrived, typically `v0.2.1-alpha.4`.
 * @returns the safe token, or null when nothing usable is left.
 */
export function sanitizeVersion(value) {
  if (typeof value !== 'string') return null
  const collapsed = value
    .replace(/[^A-Za-z0-9._+-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
  if (collapsed === '' || collapsed === '.' || collapsed === '..') return null
  if (collapsed.length > MAX_VERSION_LENGTH) return null
  return collapsed
}

/**
 * Where one version would be installed.
 *
 * @param root - the absolute directory that holds the versions.
 * @param version - the raw version string.
 * @param options - accepted for symmetry with the other entry points; paths are
 *   always built with `node:path`, never by concatenation.
 * @returns the absolute target directory, or null when either input is unusable.
 */
export function installTarget(root, version, options = {}) {
  void options
  if (typeof root !== 'string' || root.trim() === '') return null
  const token = sanitizeVersion(version)
  if (token === null) return null
  return join(resolve(root), DIR_PREFIX + token)
}

/**
 * Whether a left-hand side of the plan is usable as an install root.
 * @param root - candidate root.
 * @returns a refusal reason, or null when the root is fine.
 */
function rootProblem(root) {
  if (typeof root !== 'string' || root.trim() === '') return 'no-root'
  if (root.includes('\0')) return 'bad-root'
  if (!isAbsolute(root)) return 'bad-root'
  // The filesystem root itself is never an install root: cloning into it would
  // scatter a checkout across a drive/directory the user did not choose.
  const resolved = resolve(root)
  if (parsePath(resolved).root === resolved) return 'bad-root'
  return null
}

/**
 * Default `exists`: synchronous, because `planInstall` is synchronous.
 *
 * `lstat`, not `existsSync`: Windows' `wt.exe` may be an App Execution Alias, a
 * zero-byte reparse point that `stat` refuses with EACCES, so `existsSync` says
 * it is not there and the launcher would fall back to `cmd.exe` for no reason.
 * `lstat` sees the name, which is all this question is about.
 */
function defaultExists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Default synchronous directory listing, used only to test emptiness. */
function defaultReaddirSync(path) {
  return readdirSync(path)
}

/** Default recursive `mkdir`. */
function defaultMkdir(path) {
  return fsp.mkdir(path, { recursive: true })
}

/**
 * Is a directory empty? An unreadable or non-directory path reports "not empty",
 * which makes the plan refuse: better a refusal the user can read than an
 * install attempted on top of something we cannot even list.
 */
function directoryIsEmpty(dir, readdirSyncFn) {
  try {
    return readdirSyncFn(dir).length === 0
  } catch {
    return false
  }
}

/** Single-quote a string for PowerShell, doubling embedded quotes. */
function powerShellQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/** Single-quote a string for `/bin/sh`; a quote cannot be escaped inside quotes. */
function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/**
 * Is a command reachable? A PATH lookup instead of a spawn: the plan is pure, and
 * `pnpm` may only resolve through the running checkout's shim, so "not on PATH"
 * is a real state a fresh clone starts in and the script has to fall back from.
 *
 * The injected `exists` must be SYNCHRONOUS here (the plan is synchronous).
 *
 * @param name - command name, with or without an extension.
 * @returns true when a PATH entry (or the path itself) holds it.
 */
function commandExists(name, env, platform, exists) {
  if (typeof name !== 'string' || name === '') return false
  if (name.includes('/') || name.includes('\\')) return Boolean(exists(name))
  const isWin = platform === 'win32'
  const rawPath = env.PATH ?? env.Path ?? env.path ?? ''
  const dirs = String(rawPath).split(isWin ? ';' : ':').filter(Boolean)
  const hasExtension = /\.[A-Za-z0-9]+$/.test(name)
  const exts = isWin
    ? String(env.PATHEXT ?? DEFAULT_PATHEXT).split(';').filter(Boolean)
    : ['']
  for (const dir of dirs) {
    const candidates = hasExtension ? [name] : [name, ...exts.map((ext) => name + ext)]
    for (const candidate of candidates) {
      if (exists(join(dir, candidate))) return true
    }
  }
  return false
}

/**
 * Resolve every injectable dependency once per call, so no function reads
 * `process` or `node:fs` behind the caller's back.
 */
function resolveContext(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const explicitProxy = options.proxy === undefined ? null : options.proxy
  const envProxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? null
  // The command runner is built around the same spawn the launcher uses, so a
  // caller that injects a fake spawn for the install gets it for the git probes
  // too - unless it injects a runner of its own, which is what the tests do.
  const spawnFn = options.spawn ?? spawn
  return {
    env,
    platform,
    now: options.now ?? Date.now,
    exists: options.exists ?? defaultExists,
    readdir: options.readdir ?? fsp.readdir,
    readdirSync: options.readdirSync ?? defaultReaddirSync,
    stat: options.stat ?? fsp.stat,
    writeFile: options.writeFile ?? fsp.writeFile,
    mkdir: options.mkdir ?? defaultMkdir,
    spawn: spawnFn,
    runCommand: options.runCommand ?? makeRunCommand(spawnFn),
    scanTtlMs: options.ttlMs ?? DEFAULT_SCAN_TTL_MS,
    // A caller that knows the proxy may force it; otherwise the parent
    // environment wins. There is no built-in fallback: a guessed proxy address
    // belongs to someone else's machine.
    proxy: options.proxy === undefined ? (envProxy ?? (DEFAULT_PROXY === '' ? null : DEFAULT_PROXY)) : explicitProxy,
    registry: options.registry ?? DEFAULT_REGISTRY,
    repo: options.repo ?? DEFAULT_REPO,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}

/** The plan object a refusal hands back: the shape is stable, the values are null. */
function refusedPlan(context, reason, fields = {}) {
  return {
    ok: false,
    reason,
    root: fields.root ?? null,
    dir: fields.dir ?? null,
    repo: context.repo,
    ref: fields.ref ?? null,
    version: fields.version ?? null,
    branchArg: '',
    steps: [],
    script: '',
    scriptPath: fields.scriptPath ?? null,
    logPath: fields.logPath ?? null,
    command: null,
    args: [],
    mode: 'log',
    proxy: context.proxy,
    registry: context.registry,
    platform: context.platform,
    generatedAt: context.now(),
  }
}

/** The four commands the install consists of, as data. */
function buildSteps(dir, context, ref, markerPath) {
  const clone = ['clone', '--depth', '1']
  // A release is cloned by tag: `--depth 1` is what keeps the fetch small, and
  // the tag is the only ref that is known to be the released version.
  if (ref) clone.push('--branch', ref)
  clone.push(context.repo, dir)
  return [
    { id: 'clone', label: '1/4 git clone', command: 'git', args: clone },
    {
      id: 'install',
      label: '2/4 pnpm install',
      command: 'pnpm',
      args: ['install', '--registry', context.registry],
    },
    { id: 'build', label: '3/4 pnpm build', command: 'pnpm', args: ['build'] },
    {
      id: 'mark',
      label: '4/4 completion marker',
      command: context.platform === 'win32' ? 'Set-Content' : 'printf',
      args: [markerPath],
    },
  ]
}

/**
 * The PowerShell half of the generated script.
 *
 * Written so that a person can read the log afterwards: `$ErrorActionPreference`
 * is the documented `'Stop'`, but a native command is run through one helper that
 * lowers the preference for the duration of the call. With `'Stop'` in force
 * PowerShell turns the first line a tool writes to stderr into a terminating
 * error, which would abort an install that is merely printing progress there.
 * The helper also appends the command's own output to the log, so a window that
 * has already closed still leaves a complete record.
 */
function powerShellScript(plan) {
  const q = powerShellQuote
  const cloneWords = ['git', 'clone', '--depth', '1']
  if (plan.ref) cloneWords.push('--branch', q(plan.ref))
  cloneWords.push(q(plan.repo), q(plan.dir))
  const markerPath = join(plan.dir, MARKER_NAME)
  const refValue = plan.ref ?? 'HEAD'

  return `# dsh-homepage - generated DSH core installer for ${plan.version}.
#
# Generated by lib/host/dsh-install.js; edit the installer, not this file.
# It runs in its own window because install plus build takes minutes and the
# running DSH core must not wait for it. The window keeps its environment, which
# is how git keeps whatever proxy the parent process was given: a direct clone
# times out on a proxied network, the proxy path does not.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = ${q(plan.root)}
$Dir = ${q(plan.dir)}
$Log = ${q(plan.logPath)}
$Marker = ${q(markerPath)}
$Version = ${q(plan.version)}
$Ref = ${q(refValue)}
$Registry = ${q(plan.registry)}
$Repo = ${q(plan.repo)}

function Write-Banner([string] $Message) {
  Write-Host ('==> ' + $Message)
  # Appended by hand: in log mode nothing is attached to the window, and the log
  # still has to read as a complete story.
  Add-Content -LiteralPath $Log -Value ('==> ' + $Message) -ErrorAction Continue
}

# The one place a native command is started. The preference is lowered for the
# duration of that call only: a tool writing progress to stderr must not be read
# as a failure. The real verdict is the process exit code checked afterwards.
function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)][string] $Label,
    [Parameter(Mandatory = $true)][scriptblock] $Body
  )
  Write-Banner $Label
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Body 2>&1 | ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_ }
    } | Tee-Object -FilePath $Log -Append
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($LASTEXITCODE -ne 0) {
    throw ($Label + ' failed with exit code ' + $LASTEXITCODE)
  }
}

# A fresh clone has no node_modules yet, so the pnpm shim of the checkout that is
# already running is not guaranteed here. pnpm is used when it is on PATH, and
# corepack otherwise, which honours the version pinned in packageManager.
function Invoke-Pnpm {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]] $Arguments)
  if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    & pnpm @Arguments
  } else {
    & corepack pnpm @Arguments
  }
}

Write-Banner ('installing DSH ' + $Version + ' into ' + $Dir)
Write-Banner ('log: ' + $Log)

try {
  Set-Location -LiteralPath $Root
  Invoke-Step '1/4 git clone' { ${cloneWords.join(' ')} }

  Set-Location -LiteralPath $Dir
  Invoke-Step '2/4 pnpm install' { Invoke-Pnpm install --registry ${q(plan.registry)} }
  Invoke-Step '3/4 pnpm build' { Invoke-Pnpm build }

  Write-Banner '4/4 completion marker'
  # Written last on purpose: the marker exists only if every step above returned,
  # which is what makes it usable as the 'this version is complete' signal.
  Set-Content -LiteralPath $Marker -Encoding ascii -Value @(
    ('version: ' + $Version),
    ('ref: ' + $Ref),
    ('installed: ' + (Get-Date -Format o))
  )
  Write-Banner ('DSH ' + $Version + ' installed into ' + $Dir)
} catch {
  $failure = 'INSTALL FAILED: ' + $_.Exception.Message
  Write-Host $failure -ForegroundColor Red
  Add-Content -LiteralPath $Log -Value $failure -ErrorAction Continue
}

# pausing is only wanted when a person is looking at a window. The log fallback
# runs with no console and its stdin ignored, where Read-Host would block a
# hidden process forever.
if ($env:DSH_INSTALL_PAUSE -eq '1') {
  Write-Host ''
  [void](Read-Host 'Press Enter to close this window')
}
`
}

/**
 * The `/bin/sh` half of the generated script.
 *
 * `exec > >(tee ...) 2>&1` is bash-only, so each command tees itself. POSIX sh
 * has no `pipefail` either: the status of the left side of a pipeline is
 * invisible, so `run` carries it out through a scratch file - otherwise a failed
 * install would look like a success and the next step would run anyway.
 */
function shScript(plan) {
  const q = shQuote
  const cloneWords = ['git', 'clone', '--depth', '1']
  if (plan.ref) cloneWords.push('--branch', q(plan.ref))
  cloneWords.push(q(plan.repo), q(plan.dir))
  const markerPath = join(plan.dir, MARKER_NAME)
  const refValue = plan.ref ?? 'HEAD'

  return `#!/bin/sh
# dsh-homepage - generated DSH core installer for ${plan.version}.
#
# Generated by lib/host/dsh-install.js; edit the installer, not this file.
# The environment is inherited, which is how git reaches a network proxy here.
set -e

ROOT=${q(plan.root)}
DIR=${q(plan.dir)}
LOG=${q(plan.logPath)}
MARKER=${q(markerPath)}
VERSION=${q(plan.version)}
REF=${q(refValue)}
REGISTRY=${q(plan.registry)}
REPO=${q(plan.repo)}

# No pipefail in POSIX sh, so the exit status of a tee'd command travels through
# this scratch file. It is ours, and the trap removes it on the way out.
STATUS_FILE="\${TMPDIR:-/tmp}/dsh-install-\$\$.status"
trap 'rm -f "\$STATUS_FILE"' EXIT INT TERM

say() {
  printf '%s\\n' "==> \$*"
  printf '%s\\n' "==> \$*" >> "\$LOG"
}

# Tee keeps the window readable while the log stays the complete record.
run() {
  label=\$1
  shift
  say "\$label"
  { "\$@" 2>&1; printf '%s' "\$?" > "\$STATUS_FILE"; } | tee -a "\$LOG"
  status=\$(cat "\$STATUS_FILE" 2>/dev/null || printf '1')
  if [ "\$status" != '0' ]; then
    say "\$label failed with exit code \$status"
    exit "\$status"
  fi
}

# A fresh clone has no node_modules yet, so pnpm comes from PATH when it exists
# and from corepack (which honours the pinned packageManager) otherwise.
pnpm_run() {
  if command -v pnpm > /dev/null 2>&1; then
    pnpm "\$@"
  else
    corepack pnpm "\$@"
  fi
}

say "installing DSH \$VERSION into \$DIR"
say "log: \$LOG"

cd "\$ROOT"
run '1/4 git clone' ${cloneWords.join(' ')}

cd "\$DIR"
run '2/4 pnpm install' pnpm_run install --registry ${q(plan.registry)}
run '3/4 pnpm build' pnpm_run build

say '4/4 completion marker'
# Written last on purpose: the marker exists only if every step above returned,
# which is what makes it usable as the 'this version is complete' signal.
{
  printf 'version: %s\\n' "\$VERSION"
  printf 'ref: %s\\n' "\$REF"
  printf 'installed: %s\\n' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "\$MARKER"
say "DSH \$VERSION installed into \$DIR"
`
}

/**
 * Render the script for a plan.
 *
 * @param plan - a plan from `planInstall()`.
 * @param options - `{ platform }` overrides the dialect; it otherwise follows the
 *   plan, which is what a test or a preview button passes.
 * @returns the script text, or '' when the plan is not renderable.
 */
export function buildShellScript(plan, options = {}) {
  if (!plan || typeof plan !== 'object') return ''
  if (!plan.root || !plan.dir || !plan.repo || !plan.registry || !plan.logPath) return ''
  const platform = options.platform ?? plan.platform ?? process.platform
  return platform === 'win32' ? powerShellScript(plan) : shScript(plan)
}

/**
 * Every command this install would run, plus the script that runs them.
 *
 * Pure and synchronous: no spawn, no write, no wait. `ok: false` with a `reason`
 * is the only failure mode; the whole plan shape is stable so a card can render
 * a refusal and a preview from the same object.
 *
 * @param options - `{ root, version, ref, platform, env, ... }` plus every
 *   injectable dependency documented on the module.
 * @returns the plan.
 */
export function planInstall(options = {}) {
  const context = resolveContext(options)
  const rawRoot = typeof options.root === 'string' ? options.root : ''
  const root = rawRoot.trim() === '' ? null : resolve(rawRoot)
  const version = sanitizeVersion(options.version)
  const extension = context.platform === 'win32' ? POWERSHELL_EXT : SH_EXT

  // A release is installed by its tag; `ref: null` means "track HEAD", so an
  // explicit null is honoured instead of being treated as "derive the tag".
  const ref = options.ref === undefined
    ? (version ? TAG_PREFIX + version : null)
    : (options.ref === null || options.ref === '' ? null : String(options.ref))

  const rootIssue = rootProblem(options.root)
  if (rootIssue) return refusedPlan(context, rootIssue, { version })
  if (version === null) return refusedPlan(context, 'no-version', { root })

  // The ref becomes part of a command line, so it is checked against a whitelist
  // rather than escaped; a ref it cannot describe is a refusal.
  if (ref !== null && (!REF_RE.test(ref) || ref.startsWith('-'))) {
    return refusedPlan(context, 'no-version', { root, version })
  }

  const dir = join(root, DIR_PREFIX + version)
  const scriptPath = join(root, `install-${version}${extension}`)
  const logPath = join(root, `install-${version}.log`)
  const markerPath = join(dir, MARKER_NAME)

  // An existing non-empty target is left alone - nothing is ever overwritten and
  // nothing is ever deleted.
  if (context.exists(dir) && !directoryIsEmpty(dir, context.readdirSync)) {
    return refusedPlan(context, 'exists', { root, dir, version, ref, scriptPath, logPath })
  }
  if (inFlight.has(dir)) {
    return refusedPlan(context, 'busy', { root, dir, version, ref, scriptPath, logPath })
  }
  // git is required; neither pnpm nor corepack is enough on its own, but a fresh
  // clone legitimately has no pnpm, so either one satisfies the plan.
  if (!commandExists('git', context.env, context.platform, context.exists)) {
    return refusedPlan(context, 'no-git', { root, dir, version, ref, scriptPath, logPath })
  }
  if (!commandExists('pnpm', context.env, context.platform, context.exists)
    && !commandExists('corepack', context.env, context.platform, context.exists)) {
    return refusedPlan(context, 'no-pnpm', { root, dir, version, ref, scriptPath, logPath })
  }

  const plan = {
    ok: true,
    reason: null,
    root,
    dir,
    repo: context.repo,
    ref,
    version,
    // Carried for callers that only want the clone line; the tag cannot contain
    // a quote (REF_RE), so one spelling covers both dialects.
    branchArg: ref ? `--branch '${ref}' ` : '',
    steps: buildSteps(dir, context, ref, markerPath),
    script: '',
    scriptPath,
    logPath,
    command: null,
    args: [],
    mode: 'log',
    proxy: context.proxy,
    registry: context.registry,
    platform: context.platform,
    generatedAt: context.now(),
  }
  plan.script = buildShellScript(plan, { platform: context.platform })
  Object.assign(plan, planLauncher(plan, context))
  return plan
}

/**
 * Which program opens the window, in the documented order of preference.
 *
 * Never `shell: true` with an interpolated path: the arguments are passed as an
 * array all the way to `spawn`, so a root containing spaces or quotes is one
 * argument, not a command line to re-parse.
 */
function planLauncher(plan, context) {
  const { env, platform, exists } = context
  const scriptPath = plan.scriptPath
  const powershell = ['powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]
  if (platform === 'win32') {
    if (commandExists('wt.exe', env, platform, exists)) {
      return { command: 'wt.exe', args: powershell, mode: 'window' }
    }
    if (commandExists('cmd.exe', env, platform, exists)) {
      // `start` hands the command to a new console and returns immediately, so
      // the detached child is what actually survives this process.
      return {
        command: 'cmd.exe',
        args: ['/c', 'start', '', ...powershell],
        mode: 'window',
      }
    }
    // No terminal at all: run it headless and let the log be the deliverable.
    // `-NoExit` is dropped here - with no window it would only leave a hidden
    // process alive after the install finished.
    return {
      command: 'powershell.exe',
      args: ['-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      mode: 'log',
    }
  }
  for (const [bin, flag] of POSIX_TERMINALS) {
    if (commandExists(bin, env, platform, exists)) {
      return { command: bin, args: [flag, 'sh', scriptPath], mode: 'window' }
    }
  }
  return { command: 'sh', args: [scriptPath], mode: 'log' }
}

/**
 * A commit's whole identity from ONE `git log` call: full sha, committer date
 * (ISO-8601) and the ref decorations. The fields are separated with `%x1f` (US)
 * because that byte cannot appear in a sha, an ISO date or a ref name, so the
 * output is never split on a delimiter a tag or a path could forge.
 */
const GIT_STATE_FORMAT = '--format=%H%x1f%cI%x1f%D'

/**
 * The default command runner: one short-lived child, its output collected, and a
 * hard timeout, because the listing asks for this on every render and a git that
 * hangs on an odd filesystem must not hold the whole listing open.
 *
 * It always RESOLVES - `ok: false` covers a missing binary, a bad repository, a
 * timeout and a child that never reported anything - since every answer here is
 * advisory and the caller's job is to keep listing.
 */
function makeRunCommand(spawnFn) {
  return function runCommand(command, args, options = {}) {
    const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS
    return new Promise((settle) => {
      let child
      try {
        child = spawnFn(command, args, {
          env: options.env,
          cwd: options.cwd,
          windowsHide: true,
          // Pipes, not 'ignore': these probes exist to read the answer.
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        settle({ ok: false, stdout: '', stderr: String(error?.message ?? error), code: null })
        return
      }
      let stdout = ''
      let stderr = ''
      let done = false
      let timer = null
      const finish = (result) => {
        if (done) return
        done = true
        if (timer !== null) clearTimeout(timer)
        settle(result)
      }
      // An injected spawn stand-in may not be a real ChildProcess; without this
      // the promise would never settle and the listing would hang forever.
      if (!child || typeof child.on !== 'function') {
        finish({ ok: false, stdout: '', stderr: 'spawn returned no child process', code: null })
        return
      }
      timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // Already gone; the result is the same either way.
        }
        finish({ ok: false, stdout, stderr, code: null })
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      try {
        child.stdout?.on?.('data', (chunk) => {
          stdout += chunk
        })
        child.stderr?.on?.('data', (chunk) => {
          stderr += chunk
        })
        child.on('error', (error) => {
          finish({ ok: false, stdout, stderr: `${stderr}${error?.message ?? error}`, code: null })
        })
        child.on('close', (code) => finish({ ok: code === 0, stdout, stderr, code: code ?? null }))
      } catch (error) {
        finish({ ok: false, stdout, stderr: String(error?.message ?? error), code: null })
      }
    })
  }
}

/**
 * Read one directory's git state, or null when it is not a repository (or git is
 * not installed). The two cases must stay distinguishable, because "not a core"
 * and "a core we could not read" are answered differently by the caller.
 */
async function readGitState(dir, context) {
  const result = await context.runCommand('git', ['-C', dir, 'log', '-1', GIT_STATE_FORMAT], {
    timeoutMs: GIT_TIMEOUT_MS,
    env: context.env,
  })
  if (!result || result.ok !== true) return null
  const parsed = parseGitState(result.stdout)
  if (parsed.sha === null) return null
  // `grafted` in the decorations is the shallow boundary, but a `.git/shallow`
  // file says the same thing and costs no spawn - so a shallow clone is still
  // recognised when the decoration is absent.
  const shallowFile = await context.exists(join(dir, '.git', 'shallow'))
  return { ...parsed, shallow: parsed.shallow || Boolean(shallowFile) }
}

/** Full sha, committer date, branch, tags and the grafted flag out of one log line. */
function parseGitState(stdout) {
  const parts = String(stdout).replace(/\r?\n+$/, '').split('\x1f')
  const sha = (parts[0] ?? '').trim() || null
  const commitDate = (parts[1] ?? '').trim() || null
  const decorations = (parts[2] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const tags = decorations
    .filter((part) => part.startsWith('tag: '))
    .map((part) => part.slice('tag: '.length).trim())
  const head = decorations.find((part) => part.startsWith('HEAD -> '))
  return {
    sha,
    short: sha === null ? null : sha.slice(0, 7),
    commitDate,
    // A detached HEAD is decorated with a bare `HEAD` and has no branch at all.
    branch: head ? head.slice('HEAD -> '.length).trim() : null,
    tags,
    // The release tag when there is one: a checkout can carry several tags at
    // HEAD, and the card wants the version rather than the first name.
    tag: tags.find((name) => name.startsWith(TAG_PREFIX)) ?? tags[0] ?? null,
    shallow: decorations.includes('grafted'),
  }
}

/** The origin URL of a repository, or null when it has no origin. */
async function readRemote(dir, context) {
  const result = await context.runCommand('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
    timeoutMs: GIT_TIMEOUT_MS,
    env: context.env,
  })
  if (!result || result.ok !== true) return null
  const url = String(result.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  return url ?? null
}

/**
 * Decide whether one directory is a DSH core and describe it.
 *
 * Order matters for cost and for honesty: git is asked once for the state, then
 * once more for the remote, and the remote probe only runs after git answered -
 * a directory that is not a repository at all costs one failing spawn, never
 * two. Identity then comes from the remote when there is one and from the
 * directory name otherwise, because a core cloned by hand is named
 * `deepseekharness021a3` and one this installer made is `DeepSeekHarness-<v>`.
 *
 * A checkout whose remote is gone, and an install that has not cloned yet, are
 * both still reported - with `sha: null` - so the listing can never be empty
 * while something is visibly sitting in the directory.
 */
async function describeCore(name, dir, context) {
  const git = await readGitState(dir, context)
  const remote = git === null ? null : await readRemote(dir, context)
  const nameSaysCore = name.toLowerCase().startsWith(CORE_NAME_HINT)
  const remoteSaysCore = remote !== null && remote.toLowerCase().includes(CORE_REMOTE_HINT)
  if (!remoteSaysCore && !nameSaysCore) return null

  const markerPath = join(dir, MARKER_NAME)
  const complete = Boolean(await context.exists(markerPath))
  let updatedAt = null
  if (complete) {
    try {
      const marker = await context.stat(markerPath)
      updatedAt = Number.isFinite(marker?.mtimeMs) ? marker.mtimeMs : null
    } catch {
      updatedAt = null
    }
  }
  const tagVersion = git?.tag?.startsWith(TAG_PREFIX)
    ? sanitizeVersion(git.tag.slice(TAG_PREFIX.length))
    : null
  return {
    // The release tag is the only spelling that is definitely the version; a
    // directory this installer created carries it in its name, a hand-made
    // checkout does not.
    version: tagVersion ?? (name.startsWith(DIR_PREFIX) ? name.slice(DIR_PREFIX.length) : null),
    dir,
    name,
    exists: true,
    hasSource: Boolean(await context.exists(join(dir, 'package.json'))),
    hasDeps: Boolean(await context.exists(join(dir, 'node_modules'))),
    // Two independent proofs of a finished build: the completion marker (this
    // installer writes it only after `pnpm build` returned) and the build record
    // `pnpm build` leaves in any checkout, hand-made or not. The marker alone
    // cannot answer for a core the user cloned himself, which is why the second
    // signal is read at all.
    hasBuild: complete || Boolean(await context.exists(join(dir, BUILD_RECORD))),
    complete,
    updatedAt,
    sha: git?.sha ?? null,
    short: git?.short ?? null,
    commitDate: git?.commitDate ?? null,
    branch: git?.branch ?? null,
    tag: git?.tag ?? null,
    tags: git?.tags ?? [],
    remote,
    shallow: Boolean(git?.shallow),
    isCore: true,
  }
}

/** One comparable instant: commit date, else the marker's mtime, else none. */
function entryStamp(entry) {
  const commit = entry.commitDate === null ? Number.NaN : Date.parse(entry.commitDate)
  if (Number.isFinite(commit)) return commit
  return Number.isFinite(entry.updatedAt) ? entry.updatedAt : null
}

/** Newest commit first; an entry without git falls back to its marker, then last. */
function compareCores(a, b) {
  const left = entryStamp(a)
  const right = entryStamp(b)
  if (left !== null && right !== null && left !== right) return right - left
  if (left !== null && right === null) return -1
  if (right !== null && left === null) return 1
  return a.name.localeCompare(b.name)
}

/** Scan one root, one level deep. Never throws: an unreadable root is `null`. */
async function scanCores(root, context) {
  let names
  try {
    names = await context.readdir(root)
  } catch {
    // `null`, not `[]`: the caller must not remember a root it could not read as
    // an empty one, or a directory that appears a second later stays invisible.
    return null
  }
  const entries = []
  for (const name of names) {
    // Dot-directories, and the two entries that are never a core of their own.
    if (typeof name !== 'string' || name === '' || name.startsWith('.')) continue
    if (SKIPPED_DIRS.has(name)) continue
    const dir = join(root, name)
    let info
    try {
      info = await context.stat(dir)
    } catch {
      // Vanished or unreadable: there is nothing to describe.
      continue
    }
    if (typeof info?.isDirectory === 'function' && !info.isDirectory()) continue
    const entry = await describeCore(name, dir, context)
    if (entry !== null) entries.push(entry)
  }
  return entries.sort(compareCores)
}

/**
 * Which cores are already sitting under a root.
 *
 * Read-only and forgiving: a missing or unreadable root is an empty list, not an
 * error, because the common case is a root the user has not used yet.
 *
 * A core is identified by its git state and by its directory name, never by the
 * `DeepSeekHarness-` prefix alone: a core cloned by hand may be named
 * `deepseekharness021a3`-style, and matching only the installer's own prefix is
 * exactly what made this listing claim a directory holding cores was empty.
 *
 * The scan is memoised per root for `ttlMs`, so a re-render does not shell out to
 * git again; `resetInstallCache()` drops it.
 *
 * @param root - the directory that holds the cores.
 * @param options - injectable `readdir`/`stat`/`exists`/`runCommand`, plus `ttlMs`.
 * @returns one entry per core, newest commit first.
 */
export async function listInstalled(root, options = {}) {
  const context = resolveContext(options)
  if (typeof root !== 'string' || root.trim() === '') return []
  const key = resolve(root)
  const cached = scanCache.get(key)
  if (cached && context.now() - cached.at < context.scanTtlMs) {
    // Copies: a caller that edits a row must not edit what the next render reads.
    return cached.entries.map((entry) => ({ ...entry }))
  }
  const entries = await scanCores(root, context)
  // A root that could not be read is empty for this call but is NOT memoised: a
  // root the user is about to create must not be held empty for the whole window.
  if (entries === null) return []
  scanCache.set(key, { at: context.now(), entries })
  return entries.map((entry) => ({ ...entry }))
}

/**
 * The text written to disk for a plan's script.
 *
 * @param plan - the install plan.
 * @returns the script text, carrying the BOM the win32 branch needs.
 */
function scriptFileText(plan) {
  return plan.platform === 'win32' ? UTF8_BOM + plan.script : plan.script
}

/**
 * Write the script and open the detached window that runs it.
 *
 * @param options - the same options `planInstall()` takes, plus injectable
 *   `writeFile`/`mkdir`/`spawn`.
 * @returns `{ started, reason, dir, scriptPath, logPath, mode, command, args, pid }`.
 *   `reason` is the plan's refusal code, `'busy'` for a run already in flight, or
 *   `'write-failed'`/`'spawn-failed'` when the disk or the launcher said no.
 */
export async function startInstall(options = {}) {
  const context = resolveContext(options)
  const plan = planInstall(options)
  const shell = {
    started: false,
    reason: plan.reason,
    dir: plan.dir,
    scriptPath: plan.scriptPath,
    logPath: plan.logPath,
    mode: plan.mode,
    command: plan.command,
    args: plan.args,
    pid: null,
  }
  if (!plan.ok) return shell

  try {
    // The root itself may not exist yet: it is the user's chosen container for
    // the versions, and creating it is part of installing the first one.
    await context.mkdir(dirname(plan.scriptPath))
    await context.writeFile(plan.scriptPath, scriptFileText(plan), 'utf8')
  } catch {
    return { ...shell, reason: 'write-failed' }
  }

  // Marked before the spawn and only for a directory that passed the plan, so a
  // second click during the run cannot start a second window.
  inFlight.add(plan.dir)
  // The membership scan of this root is now out of date by definition.
  scanCache.delete(resolve(plan.root))

  const childEnv = { ...context.env }
  // The environment is what carries the proxy to git, so only a missing proxy is
  // supplied - never an override of what the parent already decided.
  if (context.proxy && !childEnv.HTTPS_PROXY && !childEnv.https_proxy) {
    childEnv.HTTPS_PROXY = context.proxy
    childEnv.HTTP_PROXY = context.proxy
  }
  // The generated script pauses only for a window launch; a headless run has no
  // console to pause at.
  if (plan.mode === 'window') childEnv.DSH_INSTALL_PAUSE = '1'

  let child
  try {
    child = context.spawn(plan.command, plan.args, {
      // Detached + ignored stdio is what lets the install outlive this process
      // and keeps it from holding DSH's own pipes open.
      detached: true,
      stdio: 'ignore',
      // A window must not be hidden; the headless fallback must be.
      windowsHide: plan.mode === 'log',
      env: childEnv,
    })
  } catch {
    inFlight.delete(plan.dir)
    return { ...shell, reason: 'spawn-failed' }
  }

  // Best effort: a duplicate click is refused until the run is known to be over.
  if (child && typeof child.once === 'function') {
    child.once('exit', () => inFlight.delete(plan.dir))
    child.once('error', () => inFlight.delete(plan.dir))
  }
  shell.started = true
  shell.reason = null
  shell.pid = child && Number.isFinite(child.pid) ? child.pid : null
  return shell
}

/**
 * Drop the process-local state: which directories had a run in flight, and the
 * memoised membership scans. Both exist to make one process's repeated calls
 * cheap, so tests call this to become independent of each other.
 */
export function resetInstallCache() {
  inFlight.clear()
  scanCache.clear()
}
