/**
 * The model-facing tools of an audit session.
 *
 * These three tools are registered on the audit Agent's own scope. They expose
 * one immutable source snapshot and nothing else: no shell, no network, no
 * generic file reader, no write path. The session's global tools are hidden by
 * `tools.restrict`, and `audit-runner.js` installs a guard so a tool registered
 * later (by another plugin) is still refused at execution.
 *
 * @module
 */

import { SNAPSHOT_LIMITS } from './source-snapshot.js'

/** The exact names the audit session is allowed to call. */
export const AUDIT_SOURCE_TOOL_NAMES = Object.freeze([
  'audit_source_list',
  'audit_source_read',
  'audit_source_grep',
])

const MAX_TOOL_TEXT = 60000

/** @returns a truncated tool text with a visible marker. */
function bound(text) {
  const value = String(text)
  return value.length <= MAX_TOOL_TEXT ? value : value.slice(0, MAX_TOOL_TEXT - 40) + '\n…[output truncated]'
}

/** @returns the one plain-text result shape every tool uses. */
function textResult(text) {
  return { text: bound(text) }
}

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: String(value && value.text ? value.text : '') }],
}

/** @returns a one-line source summary shown before every answer. */
function sourceLine(source) {
  const parts = [
    'source: ' + String(source.label || ''),
    'kind: ' + String(source.kind || ''),
    'ref: ' + String(source.ref || '(none)'),
    'files: ' + String(source.fileCount || 0),
    'bytes: ' + String(source.byteCount || 0),
  ]
  if (Number(source.binaryFiles || 0) > 0) parts.push('binary: ' + String(source.binaryFiles))
  parts.push('snapshot: ' + (source.truncated ? 'truncated' : 'complete'))
  parts.push('sha256: ' + String(source.artifactSha256 || ''))
  return parts.join(' · ')
}

/** @returns the anomalies as a few short lines. */
function anomalyLines(source) {
  const items = Array.isArray(source.anomalies) ? source.anomalies.slice(0, 30) : []
  if (items.length === 0) return ''
  return '\nanomalies:\n' + items.map((item) => {
    const path = item && item.path ? ' ' + item.path : ''
    const detail = item && item.detail ? ' — ' + item.detail : ''
    return '- ' + String(item && item.code || 'anomaly') + path + detail
  }).join('\n')
}

/** @returns the display flags for one manifest entry. */
function flagsOf(entry) {
  const flags = [entry.kind]
  if (entry.binary) flags.push('binary')
  if (entry.skipped) flags.push('skipped')
  return flags.join(',')
}

/**
 * Build the three tool definitions for one snapshot.
 * @param snapshot - the object `prepareSource()` returned.
 * @returns an array of tool definitions, ready for `agentCtx.tools.register`.
 */
export function createAuditSourceTools(snapshot) {
  if (!snapshot || typeof snapshot.list !== 'function' || typeof snapshot.read !== 'function' || typeof snapshot.grep !== 'function') {
    throw new Error('audit source tools need a prepared snapshot')
  }

  return [
    {
      name: 'audit_source_list',
      description: 'List the fixed source snapshot the host prepared for this audit. '
        + 'Use an optional path prefix to narrow a large repository. '
        + 'There is no shell, network or arbitrary file reader in this session.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Optional file or directory prefix inside the snapshot.' },
          limit: { type: 'integer', description: 'Maximum entries to return (capped by the host).' },
        },
      },
      output: OUTPUT,
      async execute(args) {
        const input = args && typeof args === 'object' ? args : {}
        const listed = snapshot.list(typeof input.path === 'string' ? input.path : '', {
          limit: Number.isFinite(input.limit) ? input.limit : undefined,
        })
        const lines = [
          sourceLine(listed.source),
          'entries: ' + listed.total + (listed.truncated ? ' (showing ' + listed.entries.length + '; truncated)' : ''),
        ]
        for (const entry of listed.entries) {
          const link = entry.link ? ' -> ' + entry.link : ''
          lines.push(entry.path + '\t' + flagsOf(entry) + '\t' + entry.size + link)
        }
        return textResult(lines.join('\n') + anomalyLines(listed.source))
      },
    },
    {
      name: 'audit_source_read',
      description: 'Read one text file from the fixed source snapshot. '
        + 'Lines are numbered; use offset (1-based line) and limit to page through a large file.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Exact path from audit_source_list.' },
          offset: { type: 'integer', description: 'First line to return (1-based). Defaults to 1.' },
          limit: { type: 'integer', description: 'Maximum lines to return (the host caps this). Defaults to 400.' },
        },
        required: ['path'],
      },
      output: OUTPUT,
      async execute(args) {
        const input = args && typeof args === 'object' ? args : {}
        const result = await snapshot.read(String(input.path || ''), {
          offset: Number.isFinite(input.offset) ? input.offset : 1,
          limit: Number.isFinite(input.limit) ? input.limit : 400,
        })
        if (result.binary) {
          return textResult(sourceLine(snapshot.source) + '\n\n' + result.path + ' is binary ('
            + result.size + ' bytes, sha256 ' + result.sha256 + '); use the manifest and the audit findings instead of reading it as text.')
        }
        const header = 'file: ' + result.path + ' · lines ' + result.startLine + '-' + result.endLine
          + ' of ' + result.totalLines + (result.truncated ? ' (truncated)' : '')
        return textResult(sourceLine(snapshot.source) + '\n' + header + '\n\n' + result.text)
      },
    },
    {
      name: 'audit_source_grep',
      description: 'Search the fixed source snapshot for a literal string (not a regular expression). '
        + 'Returns path:line and a short excerpt. Case-insensitive by default.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          needle: { type: 'string', description: 'Literal text to find.' },
          path: { type: 'string', description: 'Optional file or directory prefix.' },
          caseSensitive: { type: 'boolean', description: 'Match case exactly. Defaults to false.' },
          maxResults: { type: 'integer', description: 'Maximum matches (the host caps this).' },
        },
        required: ['needle'],
      },
      output: OUTPUT,
      async execute(args) {
        const input = args && typeof args === 'object' ? args : {}
        if (String(input.needle || '').length > SNAPSHOT_LIMITS.grepNeedle) {
          throw new Error('grep string is too long')
        }
        const found = await snapshot.grep(String(input.needle || ''), {
          prefix: typeof input.path === 'string' ? input.path : '',
          caseSensitive: input.caseSensitive === true,
          maxResults: Number.isFinite(input.maxResults) ? input.maxResults : 100,
        })
        const lines = [
          sourceLine(snapshot.source),
          'matches: ' + found.matches.length + (found.truncated ? ' (truncated)' : '')
            + ' · files scanned: ' + found.filesScanned,
        ]
        for (const match of found.matches) lines.push(match.path + ':' + match.line + ': ' + match.text)
        return textResult(lines.join('\n') + anomalyLines(snapshot.source))
      },
    },
  ]
}
