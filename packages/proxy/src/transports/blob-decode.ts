/// Embedded binary in server messages: MCP `blob` fields (embedded resources, resources/read
/// contents) and the `data` of image/audio content items, all base64 by the protocol.
///
/// Only one shape is exempt from screening: an image or audio item whose `data` is strict base64
/// of a file of the declared type (magic bytes match its mimeType) that is not valid UTF-8. That
/// is binary media, which the agent's model receives as media; Blindseal does not screen what an
/// image or a sound contains. Everything else is decoded and its text screened: textual
/// resources, any other blob, media that is not what it claims to be. A blob that is not base64,
/// or is over the size cap, is reported as such (the caller blocks it in block mode).
///
/// Pure and dependency-free: it runs in the scan worker.

export type BlobDecode =
  /// Validated binary media of its declared type: not text-screened.
  | { kind: 'media' }
  /// Decoded to valid UTF-8: screened as text.
  | { kind: 'text'; text: string }
  /// Decoded to non-UTF-8 bytes: its printable runs are screened as text.
  | { kind: 'binary'; text: string }
  | { kind: 'invalid'; reason: 'not-base64' | 'oversized' };

export const DEFAULT_MAX_BLOB_BYTES = 10 * 1024 * 1024;

export function readMaxBlobBytes(): number {
  const n = Number(process.env.BLINDSEAL_MAX_BLOB_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_BLOB_BYTES;
}

// Strict base64: the standard alphabet, length a multiple of four, `=` padding (at most two) only
// at the end. Line breaks (CRLF or LF, as MIME encoders wrap) are removed before the check; no
// other whitespace. A single-class regex: no per-character backtracking state on large blobs.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

type Magic = (b: Buffer) => boolean;
const at = (b: Buffer, off: number, ascii: string) => b.length >= off + ascii.length && b.toString('latin1', off, off + ascii.length) === ascii;
const bytes = (b: Buffer, sig: number[]) => b.length >= sig.length && sig.every((x, i) => b[i] === x);
const ftyp = (brands: string[]): Magic => (b) => at(b, 4, 'ftyp') && brands.includes(b.toString('latin1', 8, 12));

/// Declared subtype → signature of a file of that type. Only these types can be exempt.
const IMAGE_MAGIC: Record<string, Magic> = {
  png: (b) => bytes(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: (b) => bytes(b, [0xff, 0xd8, 0xff]),
  jpg: (b) => bytes(b, [0xff, 0xd8, 0xff]),
  gif: (b) => at(b, 0, 'GIF87a') || at(b, 0, 'GIF89a'),
  webp: (b) => at(b, 0, 'RIFF') && at(b, 8, 'WEBP'),
  bmp: (b) => at(b, 0, 'BM'),
  tiff: (b) => bytes(b, [0x49, 0x49, 0x2a, 0x00]) || bytes(b, [0x4d, 0x4d, 0x00, 0x2a]),
  avif: ftyp(['avif', 'avis']),
  heic: ftyp(['heic', 'heix', 'mif1', 'msf1']),
  'x-icon': (b) => bytes(b, [0x00, 0x00, 0x01, 0x00]),
  'vnd.microsoft.icon': (b) => bytes(b, [0x00, 0x00, 0x01, 0x00]),
};
const wav: Magic = (b) => at(b, 0, 'RIFF') && at(b, 8, 'WAVE');
const mpeg: Magic = (b) => at(b, 0, 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0);
const AUDIO_MAGIC: Record<string, Magic> = {
  wav, 'x-wav': wav, wave: wav, 'vnd.wave': wav,
  mpeg, mp3: mpeg,
  ogg: (b) => at(b, 0, 'OggS'),
  opus: (b) => at(b, 0, 'OggS'),
  flac: (b) => at(b, 0, 'fLaC'),
  'x-flac': (b) => at(b, 0, 'fLaC'),
  mp4: ftyp(['M4A ', 'mp42', 'isom', 'M4B ']),
  m4a: ftyp(['M4A ', 'mp42', 'isom']),
  'x-m4a': ftyp(['M4A ', 'mp42', 'isom']),
  aac: (b) => b.length >= 2 && b[0] === 0xff && (b[1]! & 0xf6) === 0xf0,
  webm: (b) => bytes(b, [0x1a, 0x45, 0xdf, 0xa3]),
  aiff: (b) => at(b, 0, 'FORM') && at(b, 8, 'AIFF'),
  'x-aiff': (b) => at(b, 0, 'FORM') && at(b, 8, 'AIFF'),
};

/// The magic-bytes check for a declared mimeType on an item of `type`, or null when that
/// combination can never be exempt (wrong family, unknown subtype, SVG and other text formats).
function magicFor(type: 'image' | 'audio', mimeType: unknown): Magic | null {
  if (typeof mimeType !== 'string') return null;
  const m = /^([a-z]+)\/([a-z0-9.+-]+)\s*(?:;.*)?$/i.exec(mimeType.trim());
  if (!m || m[1]!.toLowerCase() !== type) return null;
  const table = type === 'image' ? IMAGE_MAGIC : AUDIO_MAGIC;
  return Object.prototype.hasOwnProperty.call(table, m[2]!.toLowerCase()) ? table[m[2]!.toLowerCase()]! : null;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/// Runs of 8+ printable ASCII characters (plus tab/newline), as `strings` would print them.
function printableRuns(b: Buffer): string {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i <= b.length; i++) {
    const c = i < b.length ? b[i]! : -1;
    const printable = (c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d;
    if (printable) { if (start < 0) start = i; continue; }
    if (start >= 0 && i - start >= 8) out.push(b.toString('latin1', start, i));
    start = -1;
  }
  return out.join('\n');
}

/// Decodes one blob. `media` is set for the `data` of an image/audio item (its declared type
/// and mimeType); a `blob` field is never exempt.
export function decodeBlob(value: string, media?: { type: 'image' | 'audio'; mimeType: unknown }, maxBytes = readMaxBlobBytes()): BlobDecode {
  const b64 = value.includes('\n') ? value.replace(/\r?\n/g, '') : value;
  if (Math.floor((b64.length * 3) / 4) > maxBytes) return { kind: 'invalid', reason: 'oversized' };
  if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) return { kind: 'invalid', reason: 'not-base64' };
  const buf = Buffer.from(b64, 'base64');
  let text: string | null = null;
  try { text = utf8.decode(buf); } catch { text = null; }
  if (media && text === null) {
    const magic = magicFor(media.type, media.mimeType);
    if (magic && magic(buf)) return { kind: 'media' };
  }
  return text !== null ? { kind: 'text', text } : { kind: 'binary', text: printableRuns(buf) };
}
