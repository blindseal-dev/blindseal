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
  /// Decoded: every way a client could read the bytes as text is screened (texts).
  | { kind: 'text' | 'binary'; texts: string[] }
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

/// PNG: the signature, then well-formed chunks (length, type, data, CRC) ending exactly with IEND.
/// (Bytes appended after IEND, or a signature followed by anything else, are not a PNG.)
const png: Magic = (b) => {
  if (!bytes(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return false;
  let off = 8;
  while (off + 12 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('latin1', off + 4, off + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    off += 12 + len;
    if (type === 'IEND') return off === b.length;
  }
  return false;
};
/// JPEG: SOI at the start and EOI at the end.
const jpeg: Magic = (b) => bytes(b, [0xff, 0xd8, 0xff]) && b.length >= 4 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;
/// RIFF containers (WAV, WebP): the RIFF size field accounts for exactly the bytes present.
const riff = (form: string): Magic => (b) => at(b, 0, 'RIFF') && at(b, 8, form) && b.readUInt32LE(4) + 8 === b.length;

/// Declared subtype → check that the bytes are a file of that type. Only these types can be
/// exempt. PNG, JPEG, GIF and RIFF are checked structurally (start and end); the others by
/// their signature.
const IMAGE_MAGIC: Record<string, Magic> = {
  png,
  jpeg,
  jpg: jpeg,
  gif: (b) => (at(b, 0, 'GIF87a') || at(b, 0, 'GIF89a')) && b[b.length - 1] === 0x3b,
  webp: riff('WEBP'),
  bmp: (b) => at(b, 0, 'BM'),
  tiff: (b) => bytes(b, [0x49, 0x49, 0x2a, 0x00]) || bytes(b, [0x4d, 0x4d, 0x00, 0x2a]),
  avif: ftyp(['avif', 'avis']),
  heic: ftyp(['heic', 'heix', 'mif1', 'msf1']),
  'x-icon': (b) => bytes(b, [0x00, 0x00, 0x01, 0x00]),
  'vnd.microsoft.icon': (b) => bytes(b, [0x00, 0x00, 0x01, 0x00]),
};
const wav: Magic = riff('WAVE');
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

/// Characters a reader would show as gaps (control characters, U+FFFD for undecodable bytes)
/// become spaces, so "IGNORE\xFFPREVIOUS" reads as the words it renders as.
const GAPS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]+/g;
const asText = (t: string) => t.replace(GAPS, ' ');

function decodeAs(label: string, b: Buffer): string | null {
  try { return new TextDecoder(label).decode(b); } catch { return null; }
}

/// The declared charset of a mimeType (`text/plain; charset=utf-16le`), lowercased.
function charsetOf(mimeType: unknown): string | null {
  if (typeof mimeType !== 'string') return null;
  const m = /;\s*charset\s*=\s*"?([A-Za-z0-9._:-]+)"?/i.exec(mimeType);
  return m ? m[1]!.toLowerCase() : null;
}

/// Every way a client might read these bytes as text: UTF-8 (lenient when invalid), the declared
/// charset, the encoding a BOM announces, UTF-16 for NUL-interleaved bytes, and Latin-1 for bytes
/// that are not UTF-8. Each is screened; duplicates are dropped.
function textReadings(b: Buffer, strict: string | null, mimeType: unknown): string[] {
  const out = new Set<string>();
  const add = (t: string | null) => { if (t !== null && t.length > 0) out.add(asText(t)); };
  add(strict ?? b.toString('utf8'));
  const cs = charsetOf(mimeType);
  if (cs && !/^(utf-?8|us-ascii|ascii)$/.test(cs)) add(decodeAs(cs, b));
  if (bytes(b, [0xff, 0xfe])) add(decodeAs('utf-16le', b.subarray(2)));
  else if (bytes(b, [0xfe, 0xff])) add(decodeAs('utf-16be', b.subarray(2)));
  let nul = 0;
  for (let i = 0; i < b.length; i++) if (b[i] === 0) nul++;
  if (b.length >= 4 && nul * 4 >= b.length) { add(decodeAs('utf-16le', b)); add(decodeAs('utf-16be', b)); }
  if (strict === null) add(b.toString('latin1'));
  return [...out];
}

/// Decodes one blob. `media` is set for the `data` of an image/audio item in a media position
/// (its declared type and mimeType); nothing else is ever exempt. `mimeType` is the blob's own
/// declared type (for its charset).
export function decodeBlob(value: string, media?: { type: 'image' | 'audio'; mimeType: unknown }, maxBytes = readMaxBlobBytes(), mimeType?: unknown): BlobDecode {
  const b64 = value.includes('\n') ? value.replace(/\r?\n/g, '') : value;
  if (Math.floor((b64.length * 3) / 4) > maxBytes) return { kind: 'invalid', reason: 'oversized' };
  if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) return { kind: 'invalid', reason: 'not-base64' };
  const buf = Buffer.from(b64, 'base64');
  let strict: string | null = null;
  try { strict = utf8.decode(buf); } catch { strict = null; }
  if (media && strict === null) {
    const magic = magicFor(media.type, media.mimeType);
    if (magic && magic(buf)) return { kind: 'media' };
  }
  return { kind: strict !== null ? 'text' : 'binary', texts: textReadings(buf, strict, mimeType ?? media?.mimeType) };
}
