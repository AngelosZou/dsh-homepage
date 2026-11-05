/**
 * A small, strict tar reader for audit snapshots.
 *
 * The audit card reads code that may be hostile, so this parser is deliberately
 * narrower than a general-purpose tar implementation:
 *
 *  - it never writes anything to disk and never resolves a path;
 *  - it validates every header checksum and refuses a malformed stream;
 *  - it caps the entry count, per-file bytes and total file bytes;
 *  - it returns PAX/GNU long names only as metadata, so the caller decides what
 *    is safe to keep.
 *
 * The caller still has to validate paths (the parser cannot know the snapshot
 * root) and must never treat a `symlink`/`hardlink` entry as a file to follow.
 *
 * @module
 */

const BLOCK = 512

/** Thrown when the byte stream is not a tar archive this module can trust. */
export class TarError extends Error {
  /**
   * @param message - what is wrong with the stream.
   */
  constructor(message) {
    super(message)
    this.name = 'TarError'
  }
}

/** @returns a NUL-terminated ASCII/UTF-8 string out of one header field. */
function field(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8')
}

/**
 * Parse a tar numeric field. GNU base-256 is accepted because real archives use
 * it for large members; anything unreadable becomes zero rather than throwing,
 * and the size check above still bounds the result.
 * @param buffer - the whole archive.
 * @param offset - field offset.
 * @param length - field length.
 * @returns the number, or 0 when the field is empty.
 */
function numberField(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length)
  if (slice.length === 0) return 0
  if ((slice[0] & 0x80) !== 0) {
    let value = slice[0] & 0x7f
    for (let index = 1; index < slice.length; index += 1) value = value * 256 + slice[index]
    return value
  }
  const text = slice.toString('ascii').replace(/\0.*$/u, '').trim()
  if (text === '') return 0
  const parsed = Number.parseInt(text, 8)
  return Number.isFinite(parsed) ? parsed : 0
}

/** @returns the header checksum as written in the archive. */
function checksumField(buffer, offset) {
  return numberField(buffer, offset + 148, 8)
}

/** @returns the unsigned header checksum that should match the field. */
function computedChecksum(header) {
  let sum = 0
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index]
  }
  return sum
}

/** @returns true for the all-zero block that ends an archive. */
function isZeroBlock(block) {
  for (const byte of block) if (byte !== 0) return false
  return true
}

/**
 * Parse one PAX extended header payload.
 * @param data - the header payload.
 * @returns a key/value map; malformed records are ignored.
 */
function parsePax(data) {
  const result = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(data.toString('ascii', offset, space), 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) break
    const record = data.toString('utf8', space + 1, offset + length - 1)
    const equals = record.indexOf('=')
    if (equals > 0) result[record.slice(0, equals)] = record.slice(equals + 1)
    offset += length
  }
  return result
}

/** @returns a typeflag reduced to the vocabulary the snapshot stores. */
function kindOf(typeflag) {
  if (typeflag === '0' || typeflag === '\0' || typeflag === '7') return 'file'
  if (typeflag === '5') return 'dir'
  if (typeflag === '2') return 'symlink'
  if (typeflag === '1') return 'hardlink'
  if (typeflag === '6') return 'fifo'
  if (typeflag === '3' || typeflag === '4') return 'device'
  return 'other'
}

/**
 * Parse a (possibly uncompressed) tar archive.
 *
 * Each returned entry keeps `data` as a view into `archive`, so the caller must
 * consume or copy it before the archive buffer is released. `skipped` is true
 * when the member is larger than `maxFileBytes`; `truncated` is true when the
 * entry or byte cap stopped the walk early.
 *
 * @param archive - the uncompressed tar bytes.
 * @param options - `{ maxEntries, maxFileBytes, maxTotalFileBytes }`.
 * @returns `{ entries, truncated }`.
 * @throws {TarError} when a header or a member extends past the archive.
 */
export function readTar(archive, options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : 40000
  const maxFileBytes = Number.isFinite(options.maxFileBytes) && options.maxFileBytes > 0
    ? options.maxFileBytes
    : 2 * 1024 * 1024
  const maxTotalFileBytes = Number.isFinite(options.maxTotalFileBytes) && options.maxTotalFileBytes > 0
    ? options.maxTotalFileBytes
    : 128 * 1024 * 1024

  const entries = []
  let offset = 0
  let fileBytes = 0
  let truncated = false
  let pax = {}
  let globalPax = {}
  let longName = null
  let longLink = null

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK)
    if (isZeroBlock(header)) break
    const expected = checksumField(archive, offset)
    const actual = computedChecksum(header)
    if (expected !== actual) {
      throw new TarError('tar header checksum mismatch at offset ' + offset)
    }

    const typeflag = String.fromCharCode(header[156] || 0x30)
    const size = numberField(archive, offset + 124, 12)
    const dataStart = offset + BLOCK
    const rawEnd = dataStart + size
    if (rawEnd > archive.length) throw new TarError('tar member extends past the end of the archive')

    const name = field(header, 0, 100)
    const prefix = field(header, 345, 155)
    const link = field(header, 157, 100)
    const path = prefix === '' ? name : prefix + '/' + name

    if (typeflag === 'x' || typeflag === 'g') {
      const parsed = parsePax(archive.subarray(dataStart, rawEnd))
      if (typeflag === 'x') pax = { ...pax, ...parsed }
      else globalPax = { ...globalPax, ...parsed }
      offset = rawEnd + ((BLOCK - (size % BLOCK)) % BLOCK)
      continue
    }
    if (typeflag === 'L') {
      longName = field(archive.subarray(dataStart, rawEnd), 0, rawEnd - dataStart)
      offset = rawEnd + ((BLOCK - (size % BLOCK)) % BLOCK)
      continue
    }
    if (typeflag === 'K') {
      longLink = field(archive.subarray(dataStart, rawEnd), 0, rawEnd - dataStart)
      offset = rawEnd + ((BLOCK - (size % BLOCK)) % BLOCK)
      continue
    }

    const merged = { ...globalPax, ...pax }
    const entryPath = merged.path !== undefined ? merged.path : longName !== null ? longName : path
    const entryLink = merged.linkpath !== undefined ? merged.linkpath : longLink !== null ? longLink : link
    const entrySize = merged.size !== undefined ? Number.parseInt(merged.size, 10) : size
    if (!Number.isFinite(entrySize) || entrySize < 0) throw new TarError('tar member has an invalid size')
    // A PAX `size` overrides the header field, and the data length follows the
    // override — not the placeholder in the header.
    const dataEnd = dataStart + entrySize
    if (dataEnd > archive.length) throw new TarError('tar member extends past the end of the archive')
    const kind = kindOf(typeflag)

    const entry = {
      path: entryPath,
      kind,
      size: Number.isFinite(entrySize) ? entrySize : size,
      mode: numberField(archive, offset + 100, 8),
      linkname: entryLink,
      data: null,
      skipped: false,
    }

    if (kind === 'file') {
      fileBytes += entry.size
      if (entry.size > maxFileBytes) {
        entry.skipped = true
      } else {
        entry.data = archive.subarray(dataStart, dataEnd)
      }
    }

    entries.push(entry)
    pax = {}
    longName = null
    longLink = null
    offset = dataEnd + ((BLOCK - (entrySize % BLOCK)) % BLOCK)

    if (entries.length >= maxEntries || fileBytes > maxTotalFileBytes) {
      truncated = true
      break
    }
  }

  return { entries, truncated }
}
