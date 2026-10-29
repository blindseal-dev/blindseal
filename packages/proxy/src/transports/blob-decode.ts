/// Embedded binary in server messages: MCP `blob` fields (embedded resources, resources/read
/// contents) and the `data` of image/audio content items, all base64 by the protocol.
///
/// Only one shape is exempt from screening: an image or audio item whose `data` is strict base64
/// of a file that parses as the declared type (media-validate.ts walks the whole container and
/// checks its checksums) and is not valid UTF-8. That is binary media, which the agent's model
/// receives as media; Blindseal does not screen what an image or a sound contains. Everything else
/// is decoded and its text screened: textual resources, any other blob, media that is not what it
/// claims to be or that no parser here can verify. A blob that is not base64, or is over the size
/// cap, is reported as such (the caller blocks it in block mode).
///
/// Pure and dependency-free: it runs in the scan worker.

import { isValidMedia } from './media-validate.js';

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

const bytes = (b: Buffer, sig: number[]) => b.length >= sig.length && sig.every((x, i) => b[i] === x);

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
  if (media && strict === null && isValidMedia(media.type, media.mimeType, buf)) return { kind: 'media' };
  return { kind: strict !== null ? 'text' : 'binary', texts: textReadings(buf, strict, mimeType ?? media?.mimeType) };
}
