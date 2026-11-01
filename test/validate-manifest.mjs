// Manifest validation for dsh-homepage.
//
// The plugin manager reads this manifest BEFORE the plugin is activated: it
// resolves `exports`, loads the locale files for the display name and
// description, pulls the icon through `./icon`, and honours `dsh.bundle.patch`
// plus `dsh.client`. A typo in any of those does not fail loudly at load time —
// the entry silently loses its title, its icon, or its browser half. So every
// path the manifest promises is resolved here, against the real files.
//
// Paths are resolved from this file, not from the shell's working directory, so
// the check behaves the same under `npm test` and under `node test/...`.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compose } from '../scripts/build-client.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function ok(condition, message) {
  if (condition) return true
  failures.push(message)
  return false
}

function readJson(rel) {
  const path = join(root, rel)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    failures.push(`${rel} is not valid JSON: ${error.message}`)
    return null
  }
}

// ---------------------------------------------------------------- package.json

const manifestPath = join(root, 'package.json')
ok(existsSync(manifestPath), 'package.json is missing')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

ok(manifest.name === 'dsh-homepage', `package name is "${manifest.name}", expected "dsh-homepage"`)
ok(typeof manifest.version === 'string' && /^\d+\.\d+\.\d+/.test(manifest.version), 'version is not semver')
ok(manifest.type === 'module', 'type must be "module": the halves are ESM')
ok(manifest.private === true || manifest.private === undefined, 'private should be true or omitted')
ok(manifest.license === 'MIT', `license is "${manifest.license}", expected "MIT"`)

// -------------------------------------------------------------------- exports

const exportsMap = manifest.exports || {}
const expectedExports = [
  ['.', './lib/index.js'],
  ['./client', './lib/client.js'],
  ['./cordis.patch.yml', './cordis.patch.yml'],
  ['./icon', './icon.svg'],
]
for (const [key, target] of expectedExports) {
  const entry = exportsMap[key]
  if (!ok(entry !== undefined, `exports["${key}"] is missing`)) continue
  const value = typeof entry === 'string' ? entry : entry.default
  ok(value === target, `exports["${key}"] resolves to "${value}", expected "${target}"`)
  ok(existsSync(join(root, value)), `exports["${key}"] points at a file that does not exist: ${value}`)
}
ok(
  './locale/*.json' in exportsMap,
  'exports["./locale/*.json"] is missing: the plugin manager reads the display metadata through it',
)

// `main` must agree with the "." export, or a host that ignores exports loads the
// wrong file. The bare and "./"-prefixed spellings both resolve, so compare
// normalized paths instead of raw strings.
const mainTarget = typeof manifest.main === 'string' ? manifest.main.replace(/^\.\//, '') : ''
ok(mainTarget === 'lib/index.js', `main is "${manifest.main}", expected "lib/index.js"`)

// ------------------------------------------------------------- dsh descriptors

ok(manifest.dsh && typeof manifest.dsh === 'object', 'the "dsh" descriptor block is missing')
const patch = manifest.dsh?.bundle?.patch
ok(typeof patch === 'string', 'dsh.bundle.patch is missing: the bundle would never be mounted')
if (typeof patch === 'string') ok(existsSync(join(root, patch)), `dsh.bundle.patch points at a missing file: ${patch}`)

const client = manifest.dsh?.client
ok(client && typeof client === 'object', 'dsh.client is missing: the browser half would never be served')
ok(client?.platform === 'web', `dsh.client.platform is "${client?.platform}", expected "web"`)
ok(Array.isArray(client?.inject) && client.inject.length > 0, 'dsh.client.inject must list the Harness packages the factory requires')

// ------------------------------------------------------------------ files list

// Everything the plugin touches at run time has to be published, because an
// installed copy is a filtered artifact: a file left out of `files` disappears.
const published = manifest.files || []
ok(published.length > 0, 'files is empty')
for (const entry of published) {
  const clean = entry.replace(/\/\*+[^/]*$/, '')
  ok(existsSync(join(root, clean)), `files lists a path that does not exist: ${entry}`)
}
for (const required of ['lib', 'cordis.patch.yml', 'icon.svg', 'locale']) {
  ok(published.some(entry => entry === required || entry.startsWith(required + '/') || entry === 'locale/*.json'),
    `files does not publish "${required}"`)
}

// --------------------------------------------------------------------- locales

for (const locale of ['en', 'zh']) {
  const dict = readJson(`locale/${locale}.json`)
  if (!ok(dict !== null, `locale/${locale}.json is missing or unreadable`)) continue
  ok(typeof dict.meta?.title === 'string' && dict.meta.title.length > 0,
    `locale/${locale}.json has no meta.title: the entry shows the raw package name instead`)
  ok(typeof dict.meta?.description === 'string' && dict.meta.description.length > 0,
    `locale/${locale}.json has no meta.description`)
}

// ------------------------------------------------------------------------- icon

const iconPath = join(root, 'icon.svg')
if (ok(existsSync(iconPath), 'icon.svg is missing')) {
  const bytes = statSync(iconPath).size
  ok(bytes <= 256 * 1024, `icon.svg is ${bytes} bytes; the icon cap is 256 KiB`)
  const svg = readFileSync(iconPath, 'utf8')
  ok(/^<svg[\s>]/.test(svg.trim()), 'icon.svg does not start with an <svg> root element')
  ok(svg.trim().endsWith('</svg>'), 'icon.svg is not closed')
  // An icon that references the network is rejected by the plugin manager.
  ok(!/https?:\/\//.test(svg.replace(/xmlns="[^"]*"/g, '')), 'icon.svg references an external URL')
}

// ------------------------------------------------------------------ cordis patch

const patchPath = join(root, typeof patch === 'string' ? patch : 'cordis.patch.yml')
if (ok(existsSync(patchPath), 'cordis.patch.yml is missing')) {
  const text = readFileSync(patchPath, 'utf8')
  ok(text.includes('- insert:'), 'cordis.patch.yml has no "- insert:" block')
  ok(text.includes(manifest.name), `cordis.patch.yml does not name "${manifest.name}"`)
  ok(/name:\s*'?dsh-homepage'?/.test(text), 'cordis.patch.yml does not declare the plugin name')
  ok(!text.includes('\t'), 'cordis.patch.yml contains a tab: YAML forbids tabs for indentation')
}

// --------------------------------------------------------------- test payloads

// `src-json` descriptors name the parameters the browser passes; a rename here
// silently breaks the endpoint, so the client's call sites and the host's
// descriptors are compared directly.
const hostSource = readFileSync(join(root, 'lib/index.js'), 'utf8')
const clientSource = readFileSync(join(root, 'lib/client.js'), 'utf8')
const endpoints = [...hostSource.matchAll(/remoteInvocation\(\s*'([A-Za-z0-9_]+)'/g)].map(m => m[1])
ok(endpoints.length > 0, 'lib/index.js declares no remote invocations')
for (const method of endpoints) {
  ok(clientSource.includes(`homepage/${method}`), `the client never calls the declared endpoint homepage/${method}`)
}
const namespaces = new Set([...clientSource.matchAll(/(?<![A-Za-z0-9_-])homepage\/([A-Za-z0-9_]+)/g)].map(m => m[1]))
for (const name of namespaces) {
  ok(endpoints.includes(name), `the client calls homepage/${name}, which the host does not declare`)
}

// The build splices card sources into the framework with String.replace. A card
// containing `$&` would be expanded into the marker text by a string
// replacement, and the corruption still parses, so this synthetic compose is
// the guard that keeps the replacement a function.
ok(!clientSource.includes('@cards'), 'the build marker must not survive into lib/client.js')
const dollarProbe = compose({
  framework: 'framework\n    /* @cards */\nend',
  cards: [['probe.js', 'var escape = "$&"']],
})
ok(dollarProbe.includes('var escape = "$&"'), 'a card source containing $& must survive the splice unexpanded')

// ------------------------------------------------------------------------ result

if (failures.length > 0) {
  console.error('validate-manifest: FAIL')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('validate-manifest: all assertions passed')
console.log(`  package    : ${manifest.name} ${manifest.version}`)
console.log(`  exports    : ${Object.keys(exportsMap).join(', ')}`)
console.log(`  endpoints  : ${endpoints.length} declared, all called by the client`)
