#!/usr/bin/env node
/**
 * Build lib/client.js from lib/framework.part.js plus one module per card in
 * lib/cards/.
 *
 * Why a build step exists at all: the browser receives exactly ONE artifact per
 * plugin — `window.__ModuleLoader__.load({ id, factory })` — and the client
 * module system resolves modules by package name, not by relative path, so a
 * plugin cannot fetch its own chunks at runtime. Card
 * sources are therefore concatenated into that single factory at build time,
 * which is what lets each card live in its own file without a runtime import.
 *
 * Discovery is by directory: drop `lib/cards/<id>.js` in and it is registered.
 * Files whose name starts with `_` are skipped, so a shared partial can live
 * beside the cards without being treated as one.
 *
 * Usage:
 *   node scripts/build-client.mjs           write lib/client.js
 *   node scripts/build-client.mjs --check   exit 1 when it is out of date
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DEFAULT_AUDIT_INSTRUCTIONS } from '../lib/audit-instructions.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const frameworkPath = join(root, 'lib', 'framework.part.js')
const cardsDir = join(root, 'lib', 'cards')
const outPath = join(root, 'lib', 'client.js')
const MARKER = '    /* @cards */'

/** @returns the card source files, in the order they are spliced. */
export function cardFiles(dir = cardsDir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.js') && !name.startsWith('_'))
    .sort()
}

/**
 * Normalize CRLF to LF.
 *
 * `.gitattributes` checks every text file out with `eol=lf`, but a worktree that
 * predates the attribute (or an editor that saved CRLF) must not change what
 * this script produces: the same commit has to build the same bytes on every
 * machine, or `--check` fails for reasons that have nothing to do with the code.
 *
 * @param text - a source file's text, with either line ending.
 * @returns the text with LF endings only.
 */
export function normalizeEol(text) {
  return String(text).replace(/\r\n/g, '\n')
}

/** Indent every non-empty line of a block by two spaces. */
function indent(text) {
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? line : '  ' + line))
    .join('\n')
}

/**
 * @param source - one card's source text, already normalized to LF.
 * @returns the card body without its module doc comment (already in the banner).
 */
function stripHeader(source) {
  // `\r?\n` as well as normalization, so a caller that hands over CRLF source
  // directly still gets its header removed instead of shipping it twice.
  return source.replace(/^\/\*\*[\s\S]*?\*\/\r?\n/, '')
}

/**
 * @param options - `{ framework, cards }`: the framework source and the card
 *   sources keyed by filename.
 * @returns the artifact text.
 */
export function compose({ framework, cards }) {
  // Normalized once, here, so the artifact is a function of the committed text
  // and not of the line endings the worktree happens to hold.
  const source = normalizeEol(framework)
  const count = source.split(MARKER).length - 1
  if (count !== 1) throw new Error('framework.part.js must contain exactly one ' + MARKER + ' marker, found ' + count)
  if (cards.length === 0) throw new Error('no card sources found in ' + cardsDir)

  const spliced = cards
    .map(([name, cardSource]) => {
      const id = name.replace(/\.js$/, '')
      const banner = '    // ' + '-'.repeat(Math.max(4, 66 - id.length)) + ' ' + id + '\n'
        + '    // lib/cards/' + name + '\n'
      return banner + '    ;(function (kit) {\n' + indent(stripHeader(normalizeEol(cardSource)).replace("/* @audit-instructions */ ''", () => JSON.stringify(DEFAULT_AUDIT_INSTRUCTIONS))) + '    })(Kit)\n'
    })
    .join('\n')

  const banner = '/**\n'
    + ' * dsh-homepage — Client half. GENERATED FILE — do not edit.\n'
    + ' *\n'
    + ' * Built by scripts/build-client.mjs from lib/framework.part.js plus every\n'
    + ' * module in lib/cards/ (one file per card, spliced in filename order). Run\n'
    + ' * `npm run build` after changing either, and `npm run check:build` before\n'
    + ' * shipping: it fails while this file is out of date. Line endings are\n'
    + ' * normalized on both sides, so a CRLF worktree cannot stale this file.\n'
    + ' *\n'
    + ' * The card sources are the finished text of each module, so read those for\n'
    + ' * anything below the framework: lib/cards/' + cards.map(([name]) => name).join(', lib/cards/') + '\n'
    + ' */\n'

  // The replacement must be a function: a card may legitimately contain `$&`
  // (a RegExp escape, for example), and String.replace would expand it into the
  // marker itself — a corruption that still parses, so only a diff or a
  // composition test catches it.
  return banner + source.replace(MARKER, () => spliced.trimEnd())
}

/** @returns `{ artifact, framework, cards }` read from disk. */
export function readSources() {
  const framework = readFileSync(frameworkPath, 'utf8')
  const cards = cardFiles().map((name) => [name, readFileSync(join(cardsDir, name), 'utf8')])
  return { framework, cards }
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (invokedDirectly) {
  const { framework, cards } = readSources()
  const artifact = compose({ framework, cards })
  if (process.argv.includes('--check')) {
    const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : ''
    // Compare with line endings normalized: a CRLF checkout of a committed LF
    // artifact is not a stale artifact, and failing on it would report a
    // platform difference as a build defect.
    if (normalizeEol(current) !== normalizeEol(artifact)) {
      const a = normalizeEol(current).split('\n')
      const b = normalizeEol(artifact).split('\n')
      let line = 0
      while (line < Math.max(a.length, b.length) && a[line] === b[line]) line += 1
      console.error('lib/client.js is out of date with lib/framework.part.js + lib/cards/.')
      console.error('  first difference at line ' + (line + 1))
      console.error('  on disk : ' + String(a[line] === undefined ? '<eof>' : a[line]).slice(0, 110))
      console.error('  rebuilt : ' + String(b[line] === undefined ? '<eof>' : b[line]).slice(0, 110))
      console.error('  run: npm run build')
      process.exit(1)
    }
    console.log('build-client: lib/client.js is up to date (' + cards.length + ' card modules)')
  } else {
    writeFileSync(outPath, artifact)
    console.log('build-client: wrote lib/client.js (' + artifact.split('\n').length + ' lines, ' + cards.length + ' card modules)')
  }
}
