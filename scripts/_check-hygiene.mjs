/**
 * Guard the two file-level mistakes this repo has actually made: a UTF-8 BOM
 * (the engine's text parser and the module loader both reject one) and a
 * `client.js` edited by hand. Read-only.
 *
 * Usage: node scripts/_check-hygiene.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const roots = ['lib', 'test', 'scripts', 'locale', 'docs']
const files = []
for (const root of roots) {
  for (const name of readdirSync(root, { recursive: true })) {
    const path = join(root, String(name))
    if (statSync(path).isFile() && /\.(js|mjs|json|md)$/.test(path)) files.push(path)
  }
}
for (const name of ['README.md', 'README.zh.md', 'package.json', 'cordis.patch.yml']) files.push(name)

let bom = 0
let mojibake = 0
for (const path of files) {
  const bytes = readFileSync(path)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    console.log('BOM:', path)
    bom += 1
  }
  // A UTF-8 file decoded as ANSI and re-encoded leaves U+FFFD or a lone
  // replacement-ish CJK pair: an em dash (E2 80 94) read as GBK becomes U+9225
  // plus a stray byte. Neither can occur in deliberate text, so both are
  // reported. Chinese prose is fine — only these two code points are marks.
  const text = bytes.toString('utf8')
  const marks = (text.match(/\uFFFD|\u9225/g) || []).length
  if (marks > 0) {
    console.log('mojibake:', path, '(' + marks + ' mark(s): U+FFFD or U+9225)')
    mojibake += 1
  }
}
console.log('files checked:', files.length, '· with a BOM:', bom, '· with mojibake:', mojibake)

const locale = ['locale/zh.json', 'locale/en.json']
for (const path of locale) {
  const bytes = readFileSync(path)
  console.log(path, 'bytes:', bytes.length, '· BOM:', bytes[0] === 0xef)
}

// The two defects above are silent: a BOM breaks the engine's text parser and
// nothing else, and a mojibake byte is still valid UTF-8. So the check has to
// fail loudly, not print a line someone can scroll past. Its own self-test is
// planting one mark in a scanned file and watching this exit 1.
if (bom > 0 || mojibake > 0) {
  console.error('hygiene: ' + bom + ' BOM(s) and ' + mojibake + ' mojibake file(s) must be fixed')
  process.exitCode = 1
}
