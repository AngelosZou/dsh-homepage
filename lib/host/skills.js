/**
 * dsh-homepage — Host half, the local Skill library.
 *
 * Mirrors how the REAL DSH skill provider finds locally installed Skills
 * (`packages/skill/skill-filesystem/src/index.ts`): the same root table with the
 * same ranks, the same directory-bundle / flat-file discovery, the same YAML
 * frontmatter rules, and the same two invocation switches. A Skill is either a
 * directory holding `SKILL.md` (its resources live beside it) or a bare
 * `<name>.md` in the root; frontmatter must carry a kebab-case `name` and a
 * `description`, and `disable-model-invocation` / `user-invocable` decide
 * whether the model catalog and the human `/name` gesture see it.
 *
 * Rank decides which copy of a duplicated name wins — LOWER rank wins, ties
 * inside one rank break by root order:
 *
 * | Rank | Root | source | writable |
 * | --- | --- | --- | --- |
 * | 100 | `<projectRoot>/.dsh/skills` | `project-dsh` | yes |
 * | 200 | `<projectRoot>/.agents/skills` | `project-agents` | yes |
 * | 300 | each `customDirs` entry | `custom` | yes |
 * | 400 | `<dshHome>/skills` | `user-dsh` | yes (`.system/` skipped) |
 * | 500 | `<agentsHome>/skills` | `user-agents` | yes |
 * | 600 | `bundledDir` | `bundled` | **no — never written** |
 *
 * Contract:
 *
 *  - `list()` NEVER throws for one bad root. A root that cannot be listed —
 *    missing, a file, denied permissions — contributes a `warnings` line (or
 *    nothing at all when it simply does not exist) and the scan continues. A
 *    missing `~/.dsh/skills` and an absent project root are both normal;
 *  - a Skill whose frontmatter is missing or unusable is still LISTED, with a
 *    `note` (`'no-frontmatter'`, `'frontmatter-invalid'`, `'unreadable'`) and
 *    `writable: false`. The real provider would drop it from the catalog, but
 *    the card's whole job is to show what is installed and what is wrong with
 *    it. Such an entry counts as invalid and as disabled, never as enabled;
 *  - `setEnabled()` rewrites exactly the one or two frontmatter keys the mode
 *    needs. Every other byte survives: the line endings, the key order, the
 *    comments, the body. It is text surgery over the frontmatter block, not a
 *    re-serialization, so a hand-written `SKILL.md` comes back unchanged apart
 *    from the switch. A key that has to be ADDED is appended at the end of the
 *    block, so the existing lines never move;
 *  - the write goes through a sibling `.tmp` file plus `rename`, so a crash can
 *    never leave half a `SKILL.md` behind;
 *  - the bundled root is read-only, and so is any winning file that is not a
 *    plain file. Both refuse with a user-facing message instead of failing
 *    halfway through a write;
 *  - no filesystem work happens at import time and there are no dependencies
 *    beyond `node:fs` and `node:path`.
 *
 * @module dsh-homepage/host/skills
 */
import { promises as fsp } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Host-root ranks, exactly as `skill-filesystem` declares them. */
export const PROJECT_DSH_RANK = 100
export const PROJECT_AGENTS_RANK = 200
export const CUSTOM_RANK = 300
export const USER_DSH_RANK = 400
export const USER_AGENTS_RANK = 500
export const BUNDLED_SKILL_RANK = 600

/** A Skill name is kebab-case, exactly like the provider's `SKILL_NAME`. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The three states the card can ask for. */
const MODES = new Set(['off', 'model-off', 'on'])

/**
 * Frontmatter keys the provider REFUSES. A file carrying one of them is
 * invalid rather than accepted under the old spelling.
 */
export const LEGACY_INVOCATION_KEYS = Object.freeze({
  disableModelInvocation: 'disable-model-invocation',
  modelInvocable: 'disable-model-invocation',
  userInvocable: 'user-invocable',
})

/** The canonical frontmatter key that switches the model catalog off. */
const MODEL_KEY = 'disable-model-invocation'
/** The canonical frontmatter key that switches the human `/name` gesture off. */
const USER_KEY = 'user-invocable'

/** A frontmatter line: an indented or flushed `key: value` pair. */
const KEY_LINE_RE = /^([A-Za-z0-9_-]+)\s*:(?!:)(.*)$/

/** The sources whose provider is this local filesystem one. */
const FILESYSTEM_SOURCES = new Set([
  'project-dsh',
  'project-agents',
  'custom',
  'user-dsh',
  'user-agents',
  'bundled',
])

/** Path spellings that mean the awaited path simply is not there. */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR'])

// ------------------------------------------------------------- pure helpers

/**
 * Compare two strings by code point. The harness itself orders candidates this
 * way (`compareCodePoints`), and a code-point order is identical on every
 * machine — `localeCompare` is not.
 *
 * @param left - one string.
 * @param right - the other.
 * @returns -1, 0 or 1.
 */
export function compareCodePoints(left, right) {
  const a = String(left)
  const b = String(right)
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Is this a valid Skill name? The provider's grammar, verbatim.
 *
 * @param name - a candidate name.
 * @returns true for a non-empty kebab-case name.
 */
export function isSkillName(name) {
  return typeof name === 'string' && SKILL_NAME_RE.test(name)
}

/**
 * The error code of a thrown value, when it has one.
 *
 * @param error - whatever was caught.
 * @returns the string code, or null.
 */
function errorCode(error) {
  if (error === null || typeof error !== 'object') return null
  const code = error.code
  return typeof code === 'string' && code !== '' ? code : null
}

/**
 * Is this the code an absent path reports? A missing path is not an error.
 *
 * @param error - whatever was caught.
 * @returns true for ENOENT/ENOTDIR.
 */
function isAbsentPathError(error) {
  const code = errorCode(error)
  return code !== null && ABSENT_CODES.has(code)
}

/**
 * A short, single-line reason for a warning line.
 *
 * @param error - whatever was caught.
 * @returns the code when there is one, else the message.
 */
function reasonOf(error) {
  const code = errorCode(error)
  if (code !== null) return code
  if (error && typeof error.message === 'string' && error.message !== '') return error.message
  return 'unknown error'
}

/**
 * Fold a thrown value into a message string, tolerating anything.
 *
 * @param error - whatever was caught.
 * @returns a non-empty message.
 */
function messageOf(error) {
  if (error && typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

/**
 * One plain `key: value` line of a frontmatter block.
 *
 * Indented lines are ignored: they belong to a nested mapping (`metadata:`), and
 * the provider reads only the top level of the YAML document. Duplicate keys
 * keep the LAST occurrence, which is what a YAML parser does too.
 *
 * @param line - the line without its newline, `\r` still attached.
 * @returns the entry, or null when the line carries no value.
 */
export function parseFrontmatterLine(line) {
  const text = String(line).replace(/\r$/, '')
  const match = KEY_LINE_RE.exec(text)
  if (match === null) return null
  const parsed = parseScalar(match[2])
  if (parsed === undefined) return null
  return { key: match[1], value: parsed }
}

/**
 * Read one YAML scalar: single-quoted, double-quoted, or bare.
 *
 * A `#` only starts a comment OUTSIDE quotes, and inside a quoted scalar
 * everything after the closing quote is ignored — that is the one place where a
 * naive `split('#')` would corrupt a value.
 *
 * @param raw - the text after the `key:`.
 * @returns the scalar, or undefined when the text is empty or comment-only.
 */
export function parseScalar(raw) {
  const text = String(raw)
  const quote = text.indexOf("'")
  const double = text.indexOf('"')
  if (quote !== -1 && (double === -1 || quote < double)) return quotedScalar(text, quote, "'")
  if (double !== -1) return quotedScalar(text, double, '"')
  return bareScalar(text)
}

/**
 * Read a quoted scalar and ignore everything after its closing quote.
 *
 * @param text - the text after the `key:`.
 * @param start - the index of the opening quote.
 * @param mark - the quote character.
 * @returns the unquoted value.
 */
function quotedScalar(text, start, mark) {
  let value = ''
  let index = start + 1
  while (index < text.length) {
    const character = text[index]
    if (character === mark) {
      if (mark === "'" && text[index + 1] === "'") {
        value += "'"
        index += 2
        continue
      }
      return value
    }
    value += character
    index += 1
  }
  return value
}

/**
 * Read a bare (unquoted) scalar, stopping at an unquoted `#` comment.
 *
 * @param text - the text after the `key:`.
 * @returns the trimmed value, or undefined when there is none.
 */
function bareScalar(text) {
  const comment = text.indexOf('#')
  const body = (comment === -1 ? text : text.slice(0, comment)).trim()
  if (body === '') return undefined
  if (body === '~' || body.toLowerCase() === 'null') return null
  return body
}

/**
 * The `---`-delimited frontmatter block of a skill file, plus the raw text of
 * the block, which is what the write path needs.
 *
 * The file must START with a `---` line; the block runs to the next `---` line.
 *
 * @param raw - the whole file text.
 * @returns the parsed block, or null when there is none.
 */
export function parseFrontmatter(raw) {
  const text = typeof raw === 'string' ? raw : ''
  const firstEnd = text.indexOf('\n')
  if (firstEnd < 0) return null
  if (text.slice(0, firstEnd).replace(/\r$/, '') !== '---') return null
  const start = firstEnd + 1
  let lineStart = start
  while (lineStart <= text.length) {
    const nextNewline = text.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? text.length : nextNewline
    if (text.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return {
        data: parseFrontmatterData(text.slice(start, lineStart)),
        block: text.slice(start, lineStart),
        body: text.slice(nextNewline < 0 ? text.length : nextNewline + 1),
      }
    }
    if (nextNewline < 0) return null
    lineStart = nextNewline + 1
  }
  return null
}

/**
 * Turn the text of a frontmatter block into a plain data record.
 *
 * @param text - the block, without the two `---` lines.
 * @returns the top-level keys, last occurrence winning.
 */
export function parseFrontmatterData(text) {
  const data = Object.create(null)
  for (const line of String(text).split('\n')) {
    const entry = parseFrontmatterLine(line)
    if (entry !== null) data[entry.key] = entry.value
  }
  return data
}

/**
 * The provider's `frontmatterBoolean`, over an already-parsed string.
 *
 * `true/yes/on/1` are true, `false/no/off/0` are false; anything else — and the
 * bare `null`/`~` spellings, which YAML reads as null — throws, so a skill with
 * a nonsense switch is invalid rather than silently enabled.
 *
 * @param value - the parsed scalar.
 * @param key - the key it came from, used in the message.
 * @returns the boolean.
 */
export function parseBooleanScalar(value, key = MODEL_KEY) {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

/**
 * A non-empty string field, or null.
 *
 * @param data - the parsed frontmatter record.
 * @param key - the field to read.
 * @returns the trimmed value, or null.
 */
function stringField(data, key) {
  const value = data[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Validate and read one skill file's frontmatter.
 *
 * Never throws: a missing block, a bad name, a missing description and a legacy
 * invocation key are all reported through `note`, because the card has to SHOW
 * the broken skill rather than pretend it is not installed.
 *
 * @param raw - the whole file text.
 * @returns `{ name, description, whenToUse, modelInvocable, userInvocable, note }`.
 */
export function parseSkill(raw) {
  const front = parseFrontmatter(raw)
  if (front === null) return invalidSkill(null, 'no-frontmatter')
  const data = front.data
  for (const legacy of Object.keys(LEGACY_INVOCATION_KEYS)) {
    if (Object.hasOwn(data, legacy)) return invalidSkill(null, 'frontmatter-invalid')
  }
  const name = stringField(data, 'name')
  const description = stringField(data, 'description')
  let invocation
  try {
    invocation = parseInvocation(data)
  } catch {
    return invalidSkill(null, 'frontmatter-invalid')
  }
  if (name === null || !isSkillName(name)) {
    // A name that is missing or not kebab-case is unusable AS a name, so it is
    // not invocable — but the file is still listed under whatever it declares,
    // because the card's job is to show what is wrong with it.
    return { ...invalidSkill(name, 'frontmatter-invalid'), invocation }
  }
  if (description === null) return { ...invalidSkill(name, 'frontmatter-invalid'), invocation }
  return {
    name,
    description,
    whenToUse: stringField(data, 'whenToUse'),
    modelInvocable: invocation.modelInvocable,
    userInvocable: invocation.userInvocable,
    note: null,
  }
}

/**
 * The provider's `parseInvocationPolicy`.
 *
 * @param data - the parsed frontmatter record.
 * @returns `{ modelInvocable, userInvocable }`.
 */
export function parseInvocation(data) {
  for (const legacy of Object.keys(LEGACY_INVOCATION_KEYS)) {
    if (Object.hasOwn(data, legacy)) throw new Error(`frontmatter field "${legacy}" is unsupported`)
  }
  const disableModelInvocation = Object.hasOwn(data, MODEL_KEY)
    ? parseBooleanScalar(data[MODEL_KEY], MODEL_KEY)
    : undefined
  const userInvocable = Object.hasOwn(data, USER_KEY) ? parseBooleanScalar(data[USER_KEY], USER_KEY) : undefined
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

/**
 * The entry for a skill whose file cannot be used at all. Nothing is invocable,
 * so the arithmetic in `counts` stays honest: such a skill is invalid AND
 * disabled, never enabled.
 *
 * @param name - the name that could be recovered, or null.
 * @param note - why the file is unusable.
 * @returns the partial entry.
 */
function invalidSkill(name, note) {
  return {
    name,
    description: '',
    whenToUse: null,
    modelInvocable: false,
    userInvocable: false,
    note,
  }
}

/**
 * Rewrite the invocation switches of ONE frontmatter block.
 *
 * The transformation works on lines so that every byte outside the two lines it
 * owns survives: the key order, the line endings, the comments on other lines
 * and the body all come back exactly as they were read. A key that has to be
 * ADDED is appended at the END of the block, so the existing lines never move.
 *
 * Nothing is written when the modes' own keys already read the way they must, so
 * a file that is already in the requested state comes back byte-identical.
 *
 * @param raw - the whole file text.
 * @param mode - `'off'`, `'model-off'` or `'on'`.
 * @returns `{ text, changed }`, or null when there is no frontmatter to edit.
 */
export function rewriteFrontmatter(raw, mode) {
  const text = typeof raw === 'string' ? raw : ''
  const firstEnd = text.indexOf('\n')
  if (firstEnd < 0) return null
  if (text.slice(0, firstEnd).replace(/\r$/, '') !== '---') return null
  const blockStart = firstEnd + 1
  let lineStart = blockStart
  let closeStart = -1
  while (lineStart <= text.length) {
    const nextNewline = text.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? text.length : nextNewline
    if (text.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      closeStart = lineStart
      break
    }
    if (nextNewline < 0) return null
    lineStart = nextNewline + 1
  }
  if (closeStart < 0) return null

  const block = text.slice(blockStart, closeStart)
  const head = text.slice(0, blockStart)
  const tail = text.slice(closeStart)
  // A blank line inside the block is not a line to carry into the rewrite; the
  // final empty element after the split is NOT blank, it is what ends the last
  // line, so dropping it would glue the closing `---` onto the last key.
  const parts = block === '' ? [] : block.split('\n')
  const rawLines = parts.filter((line, index) => index === parts.length - 1 || line.replace(/\r$/, '').trim() !== '')
  const eol = block.includes('\r\n') ? '\r\n' : '\n'
  const lines = []
  const present = new Set()
  for (const line of rawLines) {
    const entry = parseFrontmatterLine(line)
    if (entry !== null) present.add(entry.key)
    lines.push({ raw: line, key: entry === null ? null : entry.key })
  }

  // 'on' drops the model key outright, and drops the user key only when it is
  // spelled `true` — which is the `user-invocable: true`-only line the contract
  // names. `user-invocable: false` is NOT that line: it is the user switch being
  // off on purpose, and 'on' leaves it alone.
  const dropModel = mode === 'on'
  const dropUserTrue = mode === 'on' && present.has(USER_KEY) && isTrueLine(lines, USER_KEY)
  // 'model-off' strips the false user line: it is a remainder of the old `off`
  // mode, and the contract's table has that key absent so the skill is reachable
  // by the human gesture again.
  const dropUserFalse = mode === 'model-off' && present.has(USER_KEY) && !isTrueLine(lines, USER_KEY)
  const kept = lines.filter((line) => {
    if (line.key === MODEL_KEY && dropModel) return false
    if (line.key === USER_KEY && (dropUserTrue || dropUserFalse)) return false
    return true
  })

  if (!dropModel) setLine(kept, MODEL_KEY, 'true', eol)
  if (mode === 'off') setLine(kept, USER_KEY, 'false', eol)

  const rewritten = kept.map((line) => line.raw).join('\n')
  const nextText = rewritten === block ? text : head + rewritten + tail
  return { text: nextText, changed: nextText !== text }
}

/**
 * Does the block already carry this key spelled as `true`?
 *
 * @param lines - the block's lines.
 * @param key - the key to look for.
 * @returns true when the key exists and reads as true.
 */
function isTrueLine(lines, key) {
  for (const line of lines) {
    if (line.key !== key) continue
    try {
      return parseBooleanScalar(parseFrontmatterLine(line.raw).value, key) === true
    } catch {
      return false
    }
  }
  return false
}

/**
 * Make one key read `value`, replacing its value in place when the key already
 * exists and appending a fresh line at the END of the block when it does not.
 *
 * Replacing is a text edit of that one line: the key and the line's own ending
 * survive, so a file that used `\r\n` still does, and so does every other line.
 * A trailing comment on the key is rewritten along with the value, because a
 * comment that described the old value would be a lie beside the new one.
 *
 * The block's final line is the `\n` that ends the key before the closing `---`,
 * so a new line goes BEFORE that one — appending past it would push the key out
 * of the frontmatter and into the body.
 *
 * @param lines - the block's lines, mutated in place.
 * @param key - the key to set.
 * @param value - the literal to write.
 * @param eol - the line ending the block uses.
 * @returns nothing.
 */
function setLine(lines, key, value, eol) {
  for (const line of lines) {
    if (line.key !== key) continue
    const ending = line.raw.endsWith('\r') ? '\r' : ''
    const kept = line.raw.replace(/\r$/, '').replace(/:(?!:)[\s\S]*$/, '').trimEnd()
    line.raw = `${kept}: ${value}${ending}`
    return
  }
  const tail =
    lines.length > 0 && lines[lines.length - 1].raw.replace(/\r$/, '') === ''
      ? lines.length - 1
      : lines.length
  lines.splice(tail, 0, { raw: `${key}: ${value}${eol === '\r\n' ? '\r' : ''}`, key })
}

// ------------------------------------------------------------------ store

/**
 * Resolve one injectable against its real default.
 *
 * @param provided - the caller's override, if any.
 * @param fallback - the real implementation.
 * @returns the function to call.
 */
function pick(provided, fallback) {
  return typeof provided === 'function' ? provided : fallback
}

/**
 * A plain text string, or ''.
 *
 * @param value - anything a fake filesystem may have returned.
 * @returns the text.
 */
function textOf(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * Coerce a directory listing into `{ name, type }` entries.
 *
 * A fake filesystem is allowed to answer with bare names or plain strings;
 * anything else that is not a usable entry is dropped rather than crashing the
 * scan.
 *
 * @param entries - whatever `readdir` resolved to.
 * @returns the normalised entries.
 */
function asEntries(entries) {
  if (!Array.isArray(entries)) return []
  const out = []
  for (const entry of entries) {
    if (typeof entry === 'string') {
      out.push({ name: entry, type: 'other' })
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.name !== 'string' || entry.name === '') continue
    out.push({ name: entry.name, type: typeof entry.type === 'string' ? entry.type : 'other' })
  }
  return out
}

/**
 * The local Skill library: discovery, the effective catalog, and the one write
 * this card is allowed to make.
 *
 * Every filesystem call is injectable, so the unit test can build a root tree
 * in memory — and inject a `stat` that fails — without a real disk. The default
 * `bundledDir` is `$DSH_BUNDLED_SKILL_DIR` resolved, because that is the
 * environment variable the harness itself reads.
 *
 * @param {object} options - the resolved host options.
 * @param {string} options.dshHome - the DSH config root (`dshHome()` in index.js). Required.
 * @param {string} [options.agentsHome] - the shared agents root; defaults to `<homedir>/.agents`.
 * @param {string|null} [options.bundledDir] - the read-only bundled root; defaults to `$DSH_BUNDLED_SKILL_DIR`.
 * @param {string[]} [options.customDirs] - extra roots, ranked 300.
 * @param {string|null} [options.projectCwd] - a session cwd; the project root is the nearest ancestor holding `.git`.
 * @param {Function} [options.readFile] - async `(path, encoding) => text`.
 * @param {Function} [options.readdir] - async `(path, options) => entries`.
 * @param {Function} [options.stat] - async `(path) => Stats`.
 * @param {Function} [options.realpath] - async `(path) => string`.
 * @param {Function} [options.writeFile] - async `(path, text, encoding)`.
 * @param {Function} [options.rename] - async `(from, to)`.
 * @param {Function} [options.mkdir] - async `(path, options)`.
 * @param {Function} [options.homedir] - `() => string`.
 * @returns {{list: Function, setEnabled: Function, roots: Function, parse: Function}} the store.
 */
export function createSkillStore(options = {}) {
  const input = options && typeof options === 'object' ? options : {}
  const readFileFn = pick(input.readFile, fsp.readFile)
  const readdirFn = pick(input.readdir, fsp.readdir)
  const statFn = pick(input.stat, fsp.stat)
  const realpathFn = pick(input.realpath, fsp.realpath)
  const writeFileFn = pick(input.writeFile, fsp.writeFile)
  const renameFn = pick(input.rename, fsp.rename)
  const mkdirFn = pick(input.mkdir, fsp.mkdir)
  const homedirFn = pick(input.homedir, osHomedir)

  if (typeof input.dshHome !== 'string' || input.dshHome.trim() === '') {
    throw new TypeError('createSkillStore: dshHome is required')
  }
  const dshHome = resolve(input.dshHome)
  const agentsHome =
    typeof input.agentsHome === 'string' && input.agentsHome.trim() !== ''
      ? resolve(input.agentsHome)
      : join(homedirFn(), '.agents')
  const bundledDir =
    typeof input.bundledDir === 'string' && input.bundledDir.trim() !== ''
      ? resolve(input.bundledDir)
      : typeof process.env.DSH_BUNDLED_SKILL_DIR === 'string' && process.env.DSH_BUNDLED_SKILL_DIR.trim() !== ''
        ? resolve(process.env.DSH_BUNDLED_SKILL_DIR)
        : null
  const customDirs = Array.isArray(input.customDirs)
    ? input.customDirs.filter((dir) => typeof dir === 'string' && dir.trim() !== '').map((dir) => resolve(dir))
    : []
  const defaultCwd = typeof input.projectCwd === 'string' && input.projectCwd.trim() !== ''
    ? resolve(input.projectCwd)
    : null
  let warningBudget = 0

  /**
   * Record a non-fatal problem. A hostile environment could otherwise grow
   * `warnings` without bound, so the list is capped and the overflow is counted.
   *
   * @param warnings - the list being built.
   * @param message - the line to add.
   * @returns nothing.
   */
  function warn(warnings, message) {
    if (warnings.length >= warningBudget) return
    warnings.push(message)
  }

  /**
   * The nearest ancestor of `cwd` that holds a `.git` entry, exactly like the
   * provider's `findProjectRoot`. Falls back to `cwd` itself when no ancestor
   * has one.
   *
   * @param cwd - an absolute session cwd.
   * @returns the project root.
   */
  async function findProjectRoot(cwd) {
    let current = cwd
    for (;;) {
      let present = false
      try {
        present = (await statFn(join(current, '.git'))) !== undefined
      } catch {
        present = false
      }
      if (present) return current
      const parent = dirname(current)
      if (parent === current) return cwd
      current = parent
    }
  }

  /**
   * Resolve an entry to 'directory' | 'file' | 'other', following symlinks the
   * way the provider does: a link is `stat`ed and a broken link is skipped.
   *
   * @param fullPath - the entry's full path.
   * @param type - the type `readdir` reported.
   * @param warnings - the list warnings are added to.
   * @returns the resolved kind, or null when the entry is not a skill candidate.
   */
  async function entryKind(fullPath, type, warnings) {
    if (type === 'directory' || type === 'file') return type
    if (type !== 'symlink' && type !== 'other') return null
    try {
      const info = await statFn(fullPath)
      if (info && typeof info.isDirectory === 'function' && info.isDirectory()) return 'directory'
      if (info && typeof info.isFile === 'function' && info.isFile()) return 'file'
      return null
    } catch (error) {
      // A broken link is the expected case here; the scan keeps going.
      warn(warnings, `${fullPath}: ${reasonOf(error)}`)
      return null
    }
  }

  /**
   * Read one skill file, distinguishing "unusable content" from "cannot read".
   *
   * @param path - the skill file.
   * @returns `{ text, unreadable }`.
   */
  async function readSkillText(path) {
    try {
      return { text: textOf(await readFileFn(path, 'utf8')), unreadable: false }
    } catch {
      return { text: '', unreadable: true }
    }
  }

  /**
   * The catalog entry one skill file contributes, or null when the file is not
   * a skill at all (a directory bundle with no `SKILL.md`).
   *
   * @param path - the skill file.
   * @param dir - the resource base: the bundle directory, or the root for a flat file.
   * @param kind - 'bundle' or 'flat'.
   * @param fallbackName - the directory/file name, used as a display name.
   * @param writable - whether this exact file may be edited.
   * @returns the entry, or null.
   */
  async function readEntry(path, dir, kind, fallbackName, writable) {
    const raw = await readSkillText(path)
    if (raw.unreadable) {
      if (kind === 'bundle') return null
      return { path, dir, kind, writable, ...invalidSkill(fallbackName, 'unreadable') }
    }
    const parsed = parseSkill(raw.text)
    return {
      path,
      dir,
      kind,
      writable,
      // A file with no usable `name` is still filed under the name it carries on
      // disk, so the card can show it and say what is wrong with it instead of
      // silently dropping the skill.
      name: parsed.name ?? fallbackName,
      description: parsed.description,
      whenToUse: parsed.whenToUse,
      modelInvocable: parsed.modelInvocable,
      userInvocable: parsed.userInvocable,
      note: parsed.note,
    }
  }

  /**
   * Scan one root directory. Never throws: a root that cannot be listed
   * contributes a warning line (or nothing, when it simply does not exist).
   *
   * @param root - one entry of the root table.
   * @param warnings - the list warnings are added to.
   * @returns `{ exists, entries }`.
   */
  async function scanRoot(root, warnings) {
    let entries
    try {
      entries = asEntries(await readdirFn(root.path, { withFileTypes: true, encoding: 'utf8' }))
    } catch (error) {
      if (isAbsentPathError(error)) return { exists: false, entries: [] }
      // The root may still exist as a file (ENOTDIR is absent-style and handled
      // above), so ask once more before deciding the directory is really gone.
      try {
        await statFn(root.path)
      } catch {
        warn(warnings, `${root.path}: ${reasonOf(error)}`)
        return { exists: false, entries: [] }
      }
      warn(warnings, `${root.path}: ${reasonOf(error)}`)
      return { exists: true, entries: [] }
    }

    const found = []
    for (const entry of entries.slice().sort((left, right) => compareCodePoints(left.name, right.name))) {
      // The real provider hides everything under `.system` in the user root:
      // those are the harness's own shims, not the user's skills.
      if (root.skipSystem === true && entry.name === '.system') continue
      const fullPath = join(root.path, entry.name)
      const kind = await entryKind(fullPath, entry.type, warnings)
      if (kind === 'directory') {
        const entryPath = join(fullPath, 'SKILL.md')
        const skill = await readEntry(entryPath, fullPath, 'bundle', entry.name, root.writable)
        if (skill !== null) found.push(skill)
        continue
      }
      if (kind === 'file' && entry.name.endsWith('.md')) {
        const skill = await readEntry(fullPath, root.path, 'flat', entry.name.slice(0, -3), root.writable)
        if (skill !== null) found.push(skill)
      }
    }
    return { exists: true, entries: found }
  }

  /**
   * Resolve the root table for one session cwd: project roots first (lowest
   * rank wins), then custom, then user, then the read-only bundled root.
   *
   * @param cwd - the session cwd, or null when there is none.
   * @returns the root list, in rank order.
   */
  function rootTable(cwd) {
    const roots = []
    if (cwd !== null) {
      roots.push({
        id: 'project-dsh',
        path: join(cwd, '.dsh', 'skills'),
        source: 'project-dsh',
        rank: PROJECT_DSH_RANK,
        label: null,
        writable: true,
        skipSystem: false,
        projectRoot: cwd,
      })
      roots.push({
        id: 'project-agents',
        path: join(cwd, '.agents', 'skills'),
        source: 'project-agents',
        rank: PROJECT_AGENTS_RANK,
        label: null,
        writable: true,
        skipSystem: false,
        projectRoot: cwd,
      })
    }
    for (const path of customDirs) {
      roots.push({
        id: `custom:${path}`,
        path,
        source: 'custom',
        rank: CUSTOM_RANK,
        label: null,
        writable: true,
        skipSystem: false,
        projectRoot: null,
      })
    }
    roots.push({
      id: 'user-dsh',
      path: join(dshHome, 'skills'),
      source: 'user-dsh',
      rank: USER_DSH_RANK,
      label: null,
      writable: true,
      skipSystem: true,
      projectRoot: null,
    })
    roots.push({
      id: 'user-agents',
      path: join(agentsHome, 'skills'),
      source: 'user-agents',
      rank: USER_AGENTS_RANK,
      label: null,
      writable: true,
      skipSystem: false,
      projectRoot: null,
    })
    if (bundledDir !== null) {
      roots.push({
        id: 'bundled',
        path: bundledDir,
        source: 'bundled',
        rank: BUNDLED_SKILL_RANK,
        label: null,
        writable: false,
        skipSystem: false,
        projectRoot: null,
      })
    }
    return roots
  }

  /**
   * The root list this store would scan right now, without touching the disk.
   *
   * @param cwd - an optional session cwd overriding `options.projectCwd`.
   * @returns the roots, in rank order.
   */
  function roots(cwd) {
    return rootTable(normalizeCwd(cwd))
  }

  /**
   * Fold a cwd argument into an absolute directory, or null.
   *
   * @param value - a cwd from the options object or a bare string.
   * @returns the absolute cwd, or null.
   */
  function normalizeCwd(value) {
    if (typeof value === 'string' && value.trim() !== '') return resolve(value)
    return defaultCwd
  }

  /**
   * The invocation policy of one catalog entry, as a small record.
   *
   * @param entry - a discovered entry.
   * @returns `{ modelInvocable, userInvocable }`.
   */
  function policyOf(entry) {
    return { modelInvocable: entry.modelInvocable === true, userInvocable: entry.userInvocable === true }
  }

  /**
   * Read the whole library: every root in rank order, one winning entry per
   * name, the duplicate list and the counts the preview draws.
   *
   * Never throws for one bad root, a missing user root or an absent project
   * root.
   *
   * @param {{cwd?: string}} [options] - an optional session cwd.
   * @returns the `skillList` document.
   */
  async function list(options = {}) {
    const call = options && typeof options === 'object' ? options : {}
    const cwd = normalizeCwd(call.cwd)
    warningBudget = 64
    const warnings = []
    // The project root is discovered at call time, not at construction time: a
    // store built per request must follow the session it was built for.
    let projectRoot = cwd
    if (cwd !== null) {
      try {
        projectRoot = await findProjectRoot(cwd)
      } catch {
        projectRoot = cwd
      }
    }
    const table = rootTable(cwd === null ? null : projectRoot)
    const rootsOut = []
    const all = []
    let order = 0
    for (const root of table) {
      const scanned = await scanRoot(root, warnings)
      rootsOut.push({
        id: root.id,
        path: root.path,
        source: root.source,
        rank: root.rank,
        label: root.label,
        writable: root.writable,
        exists: scanned.exists,
        count: scanned.entries.length,
      })
      for (const entry of scanned.entries) {
        all.push({ ...entry, source: root.source, rank: root.rank, order })
        order += 1
      }
    }

    // Rank first, then root order — the harness resolves a duplicated name the
    // same way (`compareIndexedCandidates`).
    all.sort((left, right) => left.rank - right.rank || left.order - right.order)

    const winners = new Map()
    const losersByName = new Map()
    for (const entry of all) {
      if (entry.name === null) continue
      if (!winners.has(entry.name)) {
        winners.set(entry.name, entry)
        continue
      }
      const losers = losersByName.get(entry.name) ?? []
      losers.push(entry.source)
      losersByName.set(entry.name, losers)
    }

    const skills = []
    for (const [, entry] of winners) {
      skills.push({
        name: entry.name,
        description: entry.description,
        whenToUse: entry.whenToUse,
        source: entry.source,
        provider: FILESYSTEM_SOURCES.has(entry.source) ? 'filesystem' : null,
        path: entry.path,
        dir: entry.dir,
        kind: entry.kind,
        modelInvocable: entry.modelInvocable === true,
        userInvocable: entry.userInvocable === true,
        writable: entry.writable === true && entry.note === null,
        shadowedBy: null,
        note: entry.note,
      })
    }
    skills.sort((left, right) => compareCodePoints(left.name, right.name))

    const duplicates = []
    for (const [name, losers] of losersByName) {
      const winner = winners.get(name)
      duplicates.push({ name, winner: winner === undefined ? null : winner.source, losers })
    }
    duplicates.sort((left, right) => compareCodePoints(left.name, right.name))

    return {
      generatedAt: Date.now(),
      dshHome,
      agentsHome,
      bundledDir,
      // The project root the project roots were resolved from — the nearest
      // ancestor of the session cwd that holds `.git`, or null when the session
      // has no cwd. It is what makes the two project rows below auditable.
      projectRoot: cwd === null ? null : projectRoot,
      roots: rootsOut,
      skills,
      duplicates,
      counts: countSkills(skills),
      warnings,
    }
  }

  /**
   * Load one skill's raw frontmatter, for a caller that already has the file
   * text (or the resource itself). `path` is only a label for diagnostics.
   *
   * @param text - the raw `SKILL.md` text.
   * @param path - an optional label.
   * @returns the parsed skill, plus its invocation policy.
   */
  function parse(text, path = null) {
    const parsed = parseSkill(textOf(text))
    return {
      path,
      name: parsed.name,
      description: parsed.description,
      whenToUse: parsed.whenToUse,
      modelInvocable: parsed.modelInvocable,
      userInvocable: parsed.userInvocable,
      note: parsed.note,
    }
  }

  /**
   * Flip one skill's invocation switches.
   *
   * Refuses — with a user-facing message naming the reason — when the name is
   * unknown, when the winning copy is read-only, when the file disagrees with
   * the name it is filed under, when there is no frontmatter to edit, or when
   * the file cannot be read. The host half adds its own `homepage: `
   * prefix; this half states the reason.
   *
   * @param {{name?: string, mode?: string, cwd?: string}} params - the skill name and the mode.
   * @returns the `skillSetEnabled` document.
   */
  async function setEnabled(params = {}) {
    const call = params && typeof params === 'object' ? params : {}
    const name = typeof call.name === 'string' ? call.name : ''
    const mode = typeof call.mode === 'string' ? call.mode : ''
    if (!MODES.has(mode)) throw new Error(`未知的启用模式「${mode}」`)
    if (name === '') throw new Error('缺少技能名称')

    const cwd = normalizeCwd(call.cwd)
    const before = await list(cwd === null ? {} : { cwd })
    const target = before.skills.find((skill) => skill.name === name)
    if (target === undefined) {
      if (before.duplicates.some((duplicate) => duplicate.name === name)) {
        throw new Error(`技能「${name}」没有可用的本地副本`)
      }
      throw new Error(`本地没有名为「${name}」的技能`)
    }
    // A skill the catalog marked unusable has no frontmatter to edit at all.
    // "The file cannot be read" is the more accurate reason for the two shapes
    // that got there by being unreadable; anything else is reported as the
    // missing block it is.
    if (target.note === 'unreadable') {
      throw new Error(`技能「${name}」的文件无法读取`)
    }
    if (target.note !== null) {
      throw new Error(`技能「${name}」没有可编辑的 frontmatter（${target.note}）`)
    }
    if (target.writable !== true) {
      throw new Error(`技能「${name}」来自只读来源，无法启用/停用`)
    }

    // The catalog was parsed from a copy of the text; the edit must run over the
    // file as it is RIGHT NOW, so re-read it and re-check the name it declares.
    let raw
    try {
      raw = textOf(await readFileFn(target.path, 'utf8'))
    } catch {
      throw new Error(`技能「${name}」的文件无法读取`)
    }
    const fileState = parseSkill(raw)
    if (fileState.note !== null) {
      throw new Error(`技能「${name}」没有可编辑的 frontmatter（${fileState.note}）`)
    }
    const expected = target.kind === 'flat' ? basename(target.path).slice(0, -3) : basename(dirname(target.path))
    if (fileState.name !== expected) {
      throw new Error(`技能「${name}」的 frontmatter 名称「${fileState.name}」与其所在位置「${expected}」不一致`)
    }

    const rewrite = rewriteFrontmatter(raw, mode)
    if (rewrite === null) throw new Error(`技能「${name}」没有可编辑的 frontmatter`)

    if (rewrite.changed) {
      const tempPath = `${target.path}.tmp`
      try {
        await writeFileFn(tempPath, rewrite.text, 'utf8')
        try {
          await renameFn(tempPath, target.path)
        } catch {
          // A filesystem that refuses the rename still gets the edit; this is
          // the same fallback `writeJson` in lib/index.js uses.
          await writeFileFn(target.path, rewrite.text, 'utf8')
        }
      } catch (error) {
        throw new Error(`技能「${name}」写入失败：${messageOf(error)}`)
      }
    }

    const after = await list(cwd === null ? {} : { cwd })
    // The policy comes from the file that was just written, not from a re-scan
    // that could in principle miss it: the answer must describe the edit.
    const written = parseSkill(rewrite.text)
    return {
      ok: true,
      name,
      mode,
      path: target.path,
      before: policyOf(target),
      after: { modelInvocable: written.modelInvocable, userInvocable: written.userInvocable },
      counts: after.counts,
      skills: after.skills,
    }
  }

  /**
   * Read one Skill's actual content: the body the model would be handed, the
   * frontmatter as labelled rows, and the resource files that travel with it.
   *
   * This is the read the card needs to show what a Skill IS, and it is
   * deliberately not a second discovery path: the name is resolved through
   * `list()` first, so it can only ever open what the catalog already shows as
   * the winning copy of that name. A file that cannot be read answers with a
   * `reason` instead of throwing, because "I could not read it" is something the
   * pane has to be able to say.
   *
   * @param {{name?: string, cwd?: string}} params - the skill name and an optional cwd.
   * @returns the `skillContent` document.
   */
  async function read(params = {}) {
    const call = params && typeof params === 'object' ? params : {}
    const name = typeof call.name === 'string' ? call.name : ''
    const cwd = normalizeCwd(call.cwd)
    const catalog = await list(cwd === null ? {} : { cwd })
    const entry = catalog.skills.find((skill) => skill.name === name)
    if (entry === undefined) throw new Error(`本地没有名为「${name}」的技能`)

    const result = {
      name: entry.name,
      path: entry.path,
      dir: entry.dir,
      source: entry.source,
      kind: entry.kind,
      writable: entry.writable === true,
      modelInvocable: entry.modelInvocable === true,
      userInvocable: entry.userInvocable === true,
      note: entry.note,
      bytes: 0,
      truncated: false,
      frontmatter: [],
      body: '',
      files: [],
      reason: null,
    }

    let raw
    try {
      raw = textOf(await readFileFn(entry.path, 'utf8'))
    } catch (error) {
      return { ...result, reason: 'unreadable: ' + messageOf(error) }
    }
    result.bytes = Buffer.byteLength(raw, 'utf8')
    const trimmed = raw.length > MAX_READ_BYTES ? raw.slice(0, MAX_READ_BYTES) : raw
    result.truncated = trimmed !== raw

    const front = parseFrontmatter(trimmed)
    if (front !== null) {
      for (const line of front.block.split('\n')) {
        const parsed = parseFrontmatterLine(line)
        if (parsed === null) continue
        const readable = showScalar(parsed.value)
        if (readable === null) continue
        result.frontmatter.push({ key: parsed.key, value: readable })
      }
      result.body = front.body.replace(/^\n+/, '')
    } else {
      // No frontmatter block at all: the whole file is the body. That is a real
      // shape (a flat `<name>.md` without metadata is still listed), and
      // pretending otherwise would show an empty pane for a readable file.
      result.body = trimmed
      result.note = result.note || 'no-frontmatter'
    }

    if (entry.kind === 'bundle') {
      try {
        result.files = await listFiles(entry.dir)
      } catch {
        result.files = []
      }
    }
    return result
  }

  /**
   * List a bundle's resource files relative to its directory, so the pane can
   * say what else the Skill brought without opening any of it.
   *
   * This lives inside the factory on purpose: it reads through the same injected
   * `readdir`/`stat` the scan uses, so a bundle listing follows the filesystem a
   * test or another host wired up rather than the real one.
   *
   * @param dir - the bundle directory.
   * @returns relative paths, sorted, capped, never including `SKILL.md` itself.
   */
  async function listFiles(dir) {
    const found = []
    const walk = async (base, prefix, depth) => {
      if (found.length >= MAX_LISTED_FILES || depth > 3) return
      let entries
      try {
        entries = await readdirFn(base, { withFileTypes: true, encoding: 'utf8' })
      } catch {
        // A directory that vanished or cannot be listed is not an error here:
        // the resources are a convenience, and the file itself already read.
        return
      }
      const names = entries
        .filter((entry) => !String(entry.name).startsWith('.'))
        .sort((left, right) => compareCodePoints(String(left.name), String(right.name)))
      for (const entry of names) {
        if (found.length >= MAX_LISTED_FILES) return
        const relative = prefix === '' ? String(entry.name) : prefix + '/' + String(entry.name)
        if (relative === 'SKILL.md') continue
        if (typeof entry.isDirectory !== 'function' || typeof entry.isFile !== 'function') continue
        if (entry.isDirectory()) {
          found.push({ path: relative, kind: 'dir', bytes: 0 })
          await walk(join(base, String(entry.name)), relative, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        let bytes = 0
        try {
          const info = await statFn(join(base, String(entry.name)))
          bytes = Number(info.size) || 0
        } catch {
          bytes = 0
        }
        found.push({ path: relative, kind: 'file', bytes })
      }
    }
    await walk(dir, '', 1)
    found.sort((left, right) => compareCodePoints(left.path, right.path))
    return found.slice(0, MAX_LISTED_FILES)
  }

  return { list, setEnabled, read, roots, parse }
}

/** The most of one file the reader will hand back, in bytes. */
const MAX_READ_BYTES = 480000
/** How many resource files one bundle listing reports. */
const MAX_LISTED_FILES = 60

/**
 * @param value - a parsed frontmatter scalar.
 * @returns it as display text, or null when there is nothing to show (a bare
 *   `null`/`~` reads as "no value", not as the word "null").
 */
function showScalar(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'object') return null
  const text = String(value)
  return text.trim() === '' ? null : text
}

/**
 * The four buckets the preview reads.
 *
 * A skill carrying a `note` is invalid AND disabled — it is listed so the user
 * can see what is wrong with it, but nothing can invoke it. `total` is therefore
 * always `enabled + userOnly + disabled`, and `invalid` counts a subset.
 *
 * @param skills - the effective catalog.
 * @returns `{ total, enabled, userOnly, disabled, writable, invalid }`.
 */
export function countSkills(skills) {
  const list = Array.isArray(skills) ? skills : []
  let enabled = 0
  let userOnly = 0
  let disabled = 0
  let writable = 0
  let invalid = 0
  for (const skill of list) {
    if (skill === null || typeof skill !== 'object') continue
    if (skill.note !== null && skill.note !== undefined) invalid += 1
    if (skill.writable === true) writable += 1
    if (skill.modelInvocable === true) enabled += 1
    else if (skill.userInvocable === true) userOnly += 1
    else disabled += 1
  }
  return { total: list.length, enabled, userOnly, disabled, writable, invalid }
}
