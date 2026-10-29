/// Is this byte string a file of its declared image or audio type? Structural parsers for every
/// type the media exemption (blob-decode.ts) can apply to. Each one walks the whole container the
/// way a decoder would open it (chunks, segments, frames, pages, boxes), checks the fields a decoder
/// relies on, verifies the checksums the format carries, and requires the structure to account for
/// every byte. A signature, a trailer or a plausible length field is not enough: a file "ID3 \xff
/// <instructions>" is not an MP3 and "\x89PNG…<text chunk>…IEND" with no IHDR, no IDAT and wrong
/// CRCs is not a PNG (0.7.0 re-audit A817-R3). What a decoder accepts is still not read: pixels,
/// samples, metadata text and comment chunks are the file's content, which is out of scope by
/// design (LIMITATIONS §15).
///
/// Pure and dependency-free except for zlib (PNG pixel data): it runs in the scan worker.

import { inflateSync } from 'node:zlib';

type Check = (b: Buffer) => boolean;

const at = (b: Buffer, off: number, ascii: string) => off >= 0 && b.length >= off + ascii.length && b.toString('latin1', off, off + ascii.length) === ascii;
const bytes = (b: Buffer, sig: number[], off = 0) => b.length >= off + sig.length && sig.every((x, i) => b[off + i] === x);
const FOURCC = /^[A-Za-z0-9 _!.-]{4}$/;

// ---------------------------------------------------------------------------------------------
// Checksums.

let CRC32_TABLE: Uint32Array | null = null;
/// IEEE CRC-32 (PNG chunks).
function crc32(b: Buffer): number {
  if (!CRC32_TABLE) {
    CRC32_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC32_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC32_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/// Ogg page CRC: polynomial 0x04c11db7, no reflection, initial 0, no final xor.
function oggCrc(b: Buffer): number {
  let c = 0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i]! << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
  }
  return c >>> 0;
}

/// CRC-8 (polynomial 0x07) of a FLAC frame header.
function crc8(b: Buffer, end: number): number {
  let c = 0;
  for (let i = 0; i < end; i++) {
    c ^= b[i]!;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

// ---------------------------------------------------------------------------------------------
// Images.

/// Decoded pixel data larger than this is not inflated to check (a 10 MiB PNG rarely decodes to
/// more); such a file is screened as text instead of exempted.
const MAX_PNG_RAW = 64 * 1024 * 1024;
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/// The size of the filtered scanlines IDAT must inflate to (Adam7 passes when interlaced).
function pngRawSize(w: number, h: number, bpp: number, interlaced: boolean): number {
  const rows = (pw: number, ph: number) => (pw > 0 && ph > 0 ? ph * (1 + Math.ceil((pw * bpp) / 8)) : 0);
  if (!interlaced) return rows(w, h);
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;
  let n = 0;
  for (const [xs, ys, xd, yd] of passes) n += rows(Math.ceil(Math.max(0, w - xs) / xd), Math.ceil(Math.max(0, h - ys) / yd));
  return n;
}

/// PNG: signature; chunks (length, type, data, CRC-32 verified) with IHDR first and valid, PLTE
/// before IDAT (required for indexed colour), at least one IDAT, consecutive, IEND last and
/// final; the concatenated IDAT inflates to exactly the scanline bytes the header implies.
const png: Check = (b) => {
  if (!bytes(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return false;
  let off = 8;
  let w = 0, h = 0, depth = 0, colour = 0, interlaced = false;
  let ihdr = false, plte = false, idat = false, idatDone = false;
  const data: Buffer[] = [];
  for (;;) {
    if (off + 12 > b.length) return false;
    const len = b.readUInt32BE(off);
    if (len > 0x7fffffff || off + 12 + len > b.length) return false;
    const type = b.toString('latin1', off + 4, off + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (crc32(b.subarray(off + 4, off + 8 + len)) !== b.readUInt32BE(off + 8 + len)) return false;
    const d = b.subarray(off + 8, off + 8 + len);
    if (!ihdr) {
      if (type !== 'IHDR' || len !== 13) return false;
      w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]!; colour = d[9]!;
      if (w === 0 || h === 0 || w > 0x7fffffff || h > 0x7fffffff) return false;
      if (!PNG_DEPTHS[colour]?.includes(depth) || d[10] !== 0 || d[11] !== 0 || d[12]! > 1) return false;
      interlaced = d[12] === 1;
      ihdr = true;
    } else if (type === 'IHDR') return false;
    else if (type === 'PLTE') {
      if (plte || idat || len === 0 || len % 3 !== 0 || len > 768 || colour === 0 || colour === 4) return false;
      plte = true;
    } else if (type === 'IDAT') {
      if (idatDone) return false;
      idat = true;
      data.push(d);
    } else if (type === 'IEND') {
      if (len !== 0 || !idat || off + 12 !== b.length || (colour === 3 && !plte)) return false;
      const expected = pngRawSize(w, h, PNG_CHANNELS[colour]! * depth, interlaced);
      if (expected > MAX_PNG_RAW) return false;
      try { return inflateSync(Buffer.concat(data), { maxOutputLength: expected }).length === expected; } catch { return false; }
    } else if (idat) idatDone = true;
    off += 12 + len;
  }
};

/// JPEG: SOI, then marker segments with valid lengths (a frame header, quantisation and Huffman
/// tables unless arithmetic-coded, a scan header), entropy-coded data skipped to the next marker
/// (byte stuffing and restart markers understood), EOI as the final two bytes.
const jpeg: Check = (b) => {
  if (!bytes(b, [0xff, 0xd8])) return false;
  let off = 2;
  let sof = false, sos = false, dqt = false, dht = false, arith = false;
  while (off < b.length) {
    if (b[off] !== 0xff) return false;
    while (off < b.length && b[off] === 0xff) off++; // fill bytes
    if (off >= b.length) return false;
    const m = b[off++]!;
    if (m === 0xd9) return sof && sos && dqt && (dht || arith) && off === b.length;
    if (m === 0x00 || m === 0xd8 || m === 0xff) return false;
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // standalone
    if (off + 2 > b.length) return false;
    const len = b.readUInt16BE(off);
    if (len < 2 || off + len > b.length) return false;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const nc = b[off + 7] ?? 0;
      if (len !== 8 + 3 * nc || nc < 1 || nc > 4 || b.readUInt16BE(off + 5) === 0) return false;
      if (m >= 0xc9) arith = true;
      sof = true;
    } else if (m === 0xc4) dht = true;
    else if (m === 0xdb) dqt = true;
    off += len;
    if (m === 0xda) {
      if (!sof) return false;
      sos = true;
      while (off < b.length) {
        if (b[off] === 0xff && off + 1 < b.length) {
          const n = b[off + 1]!;
          if (n !== 0 && n !== 0xff && !(n >= 0xd0 && n <= 0xd7)) break;
        }
        off++;
      }
    }
  }
  return false;
};

/// GIF data sub-blocks (length-prefixed, 0 terminates): the offset after the terminator, or -1.
function gifSubBlocks(b: Buffer, off: number): { end: number; bytes: number } {
  let n = 0;
  for (;;) {
    if (off >= b.length) return { end: -1, bytes: n };
    const len = b[off++]!;
    if (len === 0) return { end: off, bytes: n };
    off += len;
    n += len;
    if (off > b.length) return { end: -1, bytes: n };
  }
}

/// GIF: header, logical screen descriptor and colour table; then image descriptors (with their
/// colour tables, LZW code size and non-empty data sub-blocks) and extension blocks; the trailer
/// is the last byte and at least one image is present.
const gif: Check = (b) => {
  if (!(at(b, 0, 'GIF87a') || at(b, 0, 'GIF89a')) || b.length < 14) return false;
  let off = 13;
  if (b[10]! & 0x80) off += 3 << ((b[10]! & 7) + 1);
  let images = 0;
  for (;;) {
    if (off >= b.length) return false;
    const block = b[off++]!;
    if (block === 0x3b) return images > 0 && off === b.length;
    if (block === 0x2c) {
      if (off + 9 > b.length) return false;
      if (b.readUInt16LE(off + 4) === 0 || b.readUInt16LE(off + 6) === 0) return false;
      const flags = b[off + 8]!;
      off += 9;
      if (flags & 0x80) off += 3 << ((flags & 7) + 1);
      if (off >= b.length) return false;
      const lzw = b[off++]!;
      if (lzw < 1 || lzw > 8) return false;
      const sub = gifSubBlocks(b, off);
      if (sub.end < 0 || sub.bytes === 0) return false;
      off = sub.end;
      images++;
    } else if (block === 0x21) {
      if (off + 1 >= b.length) return false;
      off++;
      const sub = gifSubBlocks(b, off);
      if (sub.end < 0) return false;
      off = sub.end;
    } else return false;
  }
};

interface Chunk { id: string; off: number; len: number }

/// RIFF (WAV, WebP): the size field accounts for the file, every chunk header fits, chunks (with
/// their pad bytes) tile the file exactly.
function riffChunks(b: Buffer, form: string): Chunk[] | null {
  if (!at(b, 0, 'RIFF') || !at(b, 8, form) || b.readUInt32LE(4) + 8 !== b.length) return null;
  const out: Chunk[] = [];
  let off = 12;
  while (off < b.length) {
    if (off + 8 > b.length) return null;
    const id = b.toString('latin1', off, off + 4);
    const len = b.readUInt32LE(off + 4);
    if (!FOURCC.test(id) || off + 8 + len > b.length) return null;
    out.push({ id, off: off + 8, len });
    off += 8 + len + (len & 1);
  }
  return off === b.length || off === b.length + 1 ? out : null;
}

/// WebP: a RIFF/WEBP container whose first chunk is a VP8 key frame (frame tag, start code,
/// dimensions), a VP8L bitstream (signature, dimensions, version 0) or a VP8X header followed by
/// such a bitstream or animation frames.
const webp: Check = (b) => {
  const chunks = riffChunks(b, 'WEBP');
  if (!chunks || chunks.length === 0) return false;
  const vp8 = (c: Chunk) => {
    if (c.len < 10) return false;
    const tag = b[c.off]! | (b[c.off + 1]! << 8) | (b[c.off + 2]! << 16);
    const keyFrame = (tag & 1) === 0, version = (tag >> 1) & 7, show = (tag >> 4) & 1, part = tag >> 5;
    if (!keyFrame || version > 3 || !show || part === 0 || part > c.len - 10) return false;
    if (!bytes(b, [0x9d, 0x01, 0x2a], c.off + 3)) return false;
    return (b.readUInt16LE(c.off + 6) & 0x3fff) > 0 && (b.readUInt16LE(c.off + 8) & 0x3fff) > 0;
  };
  const vp8l = (c: Chunk) => {
    if (c.len < 5 || b[c.off] !== 0x2f) return false;
    const bits = b.readUInt32LE(c.off + 1);
    return (bits >>> 29) === 0; // version
  };
  const first = chunks[0]!;
  if (first.id === 'VP8 ') return vp8(first);
  if (first.id === 'VP8L') return vp8l(first);
  if (first.id !== 'VP8X' || first.len !== 10) return false;
  return chunks.slice(1).some((c) => (c.id === 'VP8 ' && vp8(c)) || (c.id === 'VP8L' && vp8l(c)) || (c.id === 'ANMF' && c.len > 16));
};

/// BMP: file header (size field, pixel-array offset), a DIB header of a known size with valid
/// dimensions, planes, bit depth and compression, and a pixel array that fits in the file.
const bmp: Check = (b) => {
  if (!at(b, 0, 'BM') || b.length < 26) return false;
  const size = b.readUInt32LE(2), dataOff = b.readUInt32LE(10), dib = b.readUInt32LE(14);
  if ((size !== 0 && size !== b.length) || ![12, 40, 52, 56, 64, 108, 124].includes(dib) || dataOff < 14 + dib || dataOff > b.length) return false;
  let w: number, h: number, planes: number, bpp: number, compression = 0, imageSize = 0;
  if (dib === 12) {
    if (b.length < 26) return false;
    w = b.readUInt16LE(18); h = b.readUInt16LE(20); planes = b.readUInt16LE(22); bpp = b.readUInt16LE(24);
  } else {
    if (b.length < 14 + 40) return false;
    w = b.readInt32LE(18); h = Math.abs(b.readInt32LE(22)); planes = b.readUInt16LE(26); bpp = b.readUInt16LE(28);
    compression = b.readUInt32LE(30); imageSize = b.readUInt32LE(34);
  }
  if (w <= 0 || h === 0 || planes !== 1 || ![1, 2, 4, 8, 16, 24, 32].includes(bpp)) return false;
  if (![0, 1, 2, 3, 4, 5, 6, 11, 12, 13].includes(compression)) return false;
  if (compression === 0 || compression === 3 || compression === 6) {
    const row = ((bpp * w + 31) >> 5) << 2;
    return dataOff + row * h <= b.length;
  }
  return imageSize > 0 && dataOff + imageSize <= b.length;
};

const TIFF_TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

/// TIFF: byte order and magic, the first IFD within the file, entries with valid types whose
/// out-of-line values lie inside the file, with width, length and strip or tile offsets present.
const tiff: Check = (b) => {
  const le = at(b, 0, 'II'), be = at(b, 0, 'MM');
  if ((!le && !be) || b.length < 8) return false;
  const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  if (u16(2) !== 42) return false;
  const ifd = u32(4);
  if (ifd < 8 || ifd + 2 > b.length) return false;
  const n = u16(ifd);
  if (n === 0 || ifd + 2 + 12 * n + 4 > b.length) return false;
  const tags = new Set<number>();
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + 12 * i;
    const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    if (type < 1 || type > 13) return false;
    const size = TIFF_TYPE_SIZE[type]! * count;
    if (size > 4 && u32(e + 8) + size > b.length) return false;
    tags.add(tag);
  }
  return tags.has(256) && tags.has(257) && (tags.has(273) || tags.has(324));
};

/// ICO / CUR: header with at least one directory entry; each entry's image lies inside the file
/// and is a PNG or a BITMAPINFOHEADER-led DIB.
const ico: Check = (b) => {
  if (b.length < 22 || b.readUInt16LE(0) !== 0 || ![1, 2].includes(b.readUInt16LE(2))) return false;
  const n = b.readUInt16LE(4);
  if (n === 0 || 6 + 16 * n > b.length) return false;
  for (let i = 0; i < n; i++) {
    const e = 6 + 16 * i;
    const size = b.readUInt32LE(e + 8), off = b.readUInt32LE(e + 12);
    if (size < 16 || off < 6 + 16 * n || off + size > b.length) return false;
    const img = b.subarray(off, off + size);
    if (bytes(img, [0x89, 0x50, 0x4e, 0x47])) { if (!png(img)) return false; }
    else if (img.readUInt32LE(0) !== 40 || img.readUInt16LE(12) !== 1 || ![1, 4, 8, 16, 24, 32].includes(img.readUInt16LE(14))) return false;
  }
  return true;
};

/// ISO base media file (MP4, M4A, AVIF, HEIC): boxes with valid sizes (including 64-bit and
/// to-end sizes) that tile the file, `ftyp` first with an accepted brand, the required boxes present.
function bmff(b: Buffer, brands: readonly string[], required: readonly string[][]): boolean {
  const seen = new Set<string>();
  let off = 0, first = true;
  while (off < b.length) {
    if (off + 8 > b.length) return false;
    let size = b.readUInt32BE(off), header = 8;
    const type = b.toString('latin1', off + 4, off + 8);
    if (!FOURCC.test(type)) return false;
    if (size === 1) {
      if (off + 16 > b.length) return false;
      const big = b.readBigUInt64BE(off + 8);
      if (big > BigInt(b.length - off)) return false;
      size = Number(big);
      header = 16;
    } else if (size === 0) size = b.length - off;
    if (size < header || off + size > b.length) return false;
    if (first) {
      if (type !== 'ftyp' || size < 16) return false;
      const found = [b.toString('latin1', off + 8, off + 12)];
      for (let p = off + 16; p + 4 <= off + size; p += 4) found.push(b.toString('latin1', p, p + 4));
      if (!found.some((x) => brands.includes(x))) return false;
      first = false;
    }
    seen.add(type);
    off += size;
  }
  return !first && required.every((alts) => alts.some((t) => seen.has(t)));
}
const avif: Check = (b) => bmff(b, ['avif', 'avis'], [['meta'], ['mdat']]);
const heic: Check = (b) => bmff(b, ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'], [['meta'], ['mdat']]);

export const IMAGE_CHECKS: Record<string, Check> = {
  png, jpeg, jpg: jpeg, gif, webp, bmp, 'x-ms-bmp': bmp, tiff, avif, heic, heif: heic, 'x-icon': ico, 'vnd.microsoft.icon': ico,
};

// ---------------------------------------------------------------------------------------------
// Audio.

/// WAV: RIFF/WAVE chunks; a `fmt ` chunk (known format tag, channels, rate, block alignment and
/// sample size consistent) before a `data` chunk.
const wav: Check = (b) => {
  const chunks = riffChunks(b, 'WAVE');
  if (!chunks) return false;
  const fmt = chunks.findIndex((c) => c.id === 'fmt ');
  const data = chunks.findIndex((c) => c.id === 'data');
  if (fmt < 0 || data < 0 || fmt > data) return false;
  const f = chunks[fmt]!;
  if (f.len < 16) return false;
  const tag = b.readUInt16LE(f.off), channels = b.readUInt16LE(f.off + 2), rate = b.readUInt32LE(f.off + 4);
  const align = b.readUInt16LE(f.off + 12), bits = b.readUInt16LE(f.off + 14);
  if (![1, 3, 6, 7, 0x11, 0x55, 0xfffe].includes(tag) || channels === 0 || rate === 0 || align === 0) return false;
  if (tag === 1 || tag === 3 || tag === 0xfffe) {
    if (![8, 16, 24, 32, 64].includes(bits) || align !== (channels * bits) / 8) return false;
  }
  return true;
};

/// AIFF / AIFF-C: FORM container whose chunks tile the file, with a valid COMM and an SSND chunk.
const aiff: Check = (b) => {
  if (!at(b, 0, 'FORM') || b.readUInt32BE(4) + 8 !== b.length) return false;
  const form = b.toString('latin1', 8, 12);
  if (form !== 'AIFF' && form !== 'AIFC') return false;
  let off = 12, comm = false, ssnd = false;
  while (off < b.length) {
    if (off + 8 > b.length) return false;
    const id = b.toString('latin1', off, off + 4), len = b.readUInt32BE(off + 4);
    if (!FOURCC.test(id) || off + 8 + len > b.length) return false;
    if (id === 'COMM') {
      if (len < 18 || b.readUInt16BE(off + 8) === 0) return false; // channels
      const bits = b.readUInt16BE(off + 14);
      if (bits < 1 || bits > 32) return false;
      comm = true;
    } else if (id === 'SSND') ssnd = true;
    off += 8 + len + (len & 1);
  }
  return comm && ssnd && (off === b.length || off === b.length + 1);
};

const MP3_RATES = [[44100, 48000, 32000], [22050, 24000, 16000], [11025, 12000, 8000]]; // MPEG1, 2, 2.5
const MP3_BITRATES = {
  // [version class][layer] in kbit/s; index 0 (free) and 15 (bad) are rejected.
  v1: { 1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], 2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] },
  v2: { 1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], 3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] },
} as const;

/// An MPEG audio frame header at `off`: its length and a key of the fields every frame of a file
/// shares, or null when the four bytes are not a valid header.
function mp3Frame(b: Buffer, off: number): { len: number; key: string } | null {
  if (off + 4 > b.length || b[off] !== 0xff || (b[off + 1]! & 0xe0) !== 0xe0) return null;
  const h1 = b[off + 1]!, h2 = b[off + 2]!;
  const versionBits = (h1 >> 3) & 3, layerBits = (h1 >> 1) & 3;
  if (versionBits === 1 || layerBits === 0) return null;
  const version = versionBits === 3 ? 0 : versionBits === 2 ? 1 : 2; // MPEG1, MPEG2, MPEG2.5
  const layer = (4 - layerBits) as 1 | 2 | 3;
  const bitrateIndex = h2 >> 4, rateIndex = (h2 >> 2) & 3, padding = (h2 >> 1) & 1;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const bitrate = (version === 0 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[layer][bitrateIndex]! * 1000;
  const rate = MP3_RATES[version]![rateIndex]!;
  let len: number;
  if (layer === 1) len = (Math.floor((12 * bitrate) / rate) + padding) * 4;
  else if (layer === 3 && version !== 0) len = Math.floor((72 * bitrate) / rate) + padding;
  else len = Math.floor((144 * bitrate) / rate) + padding;
  return { len, key: `${version}/${layer}/${rate}` };
}

/// A syncsafe 28-bit integer (ID3v2 sizes), or -1.
function syncsafe(b: Buffer, off: number): number {
  if (off + 4 > b.length) return -1;
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const x = b[off + i]!;
    if (x & 0x80) return -1;
    n = (n << 7) | x;
  }
  return n;
}

/// MP3: an optional ID3v2 tag (valid header, its declared size), then MPEG audio frames (valid
/// headers, all of one version, layer and rate) tiling the rest exactly, up to an optional ID3v1
/// tag at the end. At least one frame.
const mp3: Check = (b) => {
  let off = 0;
  if (at(b, 0, 'ID3')) {
    if (b.length < 10) return false;
    const major = b[3]!, flags = b[5]!, size = syncsafe(b, 6);
    if (major < 2 || major > 4 || b[4] === 0xff || size < 0) return false;
    off = 10 + size + (major === 4 && flags & 0x10 ? 10 : 0);
    if (off > b.length) return false;
  }
  let end = b.length;
  if (end - off >= 128 && at(b, end - 128, 'TAG')) end -= 128;
  let frames = 0;
  let key: string | null = null;
  while (off < end) {
    const f = mp3Frame(b, off);
    if (!f || off + f.len > end || (key !== null && f.key !== key)) return false;
    key = f.key;
    off += f.len;
    frames++;
  }
  return frames > 0 && off === end;
};

const AAC_RATES = 13;
/// AAC in ADTS: frames with valid headers (sync, layer 0, known sampling index, length ≥ header)
/// tiling the file, all with one sampling index. At least one frame.
const aac: Check = (b) => {
  let off = 0, frames = 0, rate = -1;
  while (off < b.length) {
    if (off + 7 > b.length || b[off] !== 0xff || (b[off + 1]! & 0xf6) !== 0xf0) return false;
    const r = (b[off + 2]! >> 2) & 0xf;
    const protection = b[off + 1]! & 1;
    const len = ((b[off + 3]! & 3) << 11) | (b[off + 4]! << 3) | (b[off + 5]! >> 5);
    if (r >= AAC_RATES || (rate >= 0 && r !== rate) || len < (protection ? 7 : 9) || off + len > b.length) return false;
    rate = r;
    off += len;
    frames++;
  }
  return frames > 0 && off === b.length;
};

/// Decodes the UTF-8-style coded number of a FLAC frame header; the offset after it, or -1.
function flacUtf8(b: Buffer, off: number): number {
  const x = b[off];
  if (x === undefined) return -1;
  let extra: number;
  if (x < 0x80) extra = 0;
  else if ((x & 0xe0) === 0xc0) extra = 1;
  else if ((x & 0xf0) === 0xe0) extra = 2;
  else if ((x & 0xf8) === 0xf0) extra = 3;
  else if ((x & 0xfc) === 0xf8) extra = 4;
  else if ((x & 0xfe) === 0xfc) extra = 5;
  else if (x === 0xfe) extra = 6;
  else return -1;
  for (let i = 1; i <= extra; i++) if (off + i >= b.length || (b[off + i]! & 0xc0) !== 0x80) return -1;
  return off + 1 + extra;
}

/// FLAC: marker; metadata blocks (STREAMINFO first and valid, known types) to the last one; then
/// the first audio frame's header: sync code, valid block-size, sample-rate, channel and
/// sample-size codes, coded frame number, and its CRC-8.
const flac: Check = (b) => {
  if (!at(b, 0, 'fLaC')) return false;
  let off = 4, first = true;
  for (;;) {
    if (off + 4 > b.length) return false;
    const head = b[off]!, type = head & 0x7f, len = (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!;
    if (type > 6 || off + 4 + len > b.length) return false;
    if (first) {
      if (type !== 0 || len !== 34) return false;
      const d = b.subarray(off + 4, off + 38);
      const minBlock = d.readUInt16BE(0), maxBlock = d.readUInt16BE(2);
      const rate = (d[10]! << 12) | (d[11]! << 4) | (d[12]! >> 4);
      if (minBlock < 16 || maxBlock < minBlock || rate === 0 || rate > 655350) return false;
      first = false;
    } else if (type === 0) return false;
    off += 4 + len;
    if (head & 0x80) break;
  }
  // First frame header.
  if (off + 6 > b.length || b[off] !== 0xff || (b[off + 1]! & 0xfe) !== 0xf8) return false;
  const blockSize = b[off + 2]! >> 4, rateCode = b[off + 2]! & 0xf;
  const channels = b[off + 3]! >> 4, sampleSize = (b[off + 3]! >> 1) & 7;
  if (blockSize === 0 || rateCode === 15 || channels > 10 || sampleSize === 3 || sampleSize === 7 || b[off + 3]! & 1) return false;
  let p = flacUtf8(b, off + 4);
  if (p < 0) return false;
  if (blockSize === 6) p += 1; else if (blockSize === 7) p += 2;
  if (rateCode === 12) p += 1; else if (rateCode === 13 || rateCode === 14) p += 2;
  if (p + 1 > b.length) return false;
  return crc8(b.subarray(off, p), p - off) === b[p];
};

/// Ogg: pages with the capture pattern, version 0, a lacing table that fits, and a correct page
/// CRC, tiling the file; the first page begins a stream (BOS) and identifies a known codec
/// (Opus, Vorbis, FLAC, Speex). `codec` restricts the first packet (audio/opus → OpusHead).
function ogg(b: Buffer, codec?: 'opus'): boolean {
  let off = 0, pages = 0;
  while (off < b.length) {
    if (off + 27 > b.length || !at(b, off, 'OggS') || b[off + 4] !== 0) return false;
    const flags = b[off + 5]!, segs = b[off + 26]!;
    if (off + 27 + segs > b.length) return false;
    let body = 0;
    for (let i = 0; i < segs; i++) body += b[off + 27 + i]!;
    const len = 27 + segs + body;
    if (off + len > b.length) return false;
    const page = Buffer.from(b.subarray(off, off + len));
    const crc = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    if (oggCrc(page) !== crc) return false;
    if (pages === 0) {
      if (!(flags & 0x02) || segs === 0) return false;
      const packet = off + 27 + segs;
      const known = codec === 'opus'
        ? at(b, packet, 'OpusHead')
        : at(b, packet, 'OpusHead') || at(b, packet, '\x01vorbis') || at(b, packet, '\x7fFLAC') || at(b, packet, 'Speex   ');
      if (!known) return false;
    }
    off += len;
    pages++;
  }
  return pages > 0 && off === b.length;
}

/// An EBML variable-length integer at `off`: its value (-1n for the reserved all-ones "unknown"
/// size) and width, or null.
function ebmlVint(b: Buffer, off: number, keepMarker: boolean): { value: bigint; width: number } | null {
  const x = b[off];
  if (x === undefined || x === 0) return null;
  let width = 1;
  while (!(x & (0x80 >> (width - 1)))) width++;
  if (off + width > b.length) return null;
  let value = BigInt(keepMarker ? x : x & (0xff >> width));
  let allOnes = (x & (0xff >> width)) === 0xff >> width;
  for (let i = 1; i < width; i++) {
    value = (value << 8n) | BigInt(b[off + i]!);
    if (b[off + i] !== 0xff) allOnes = false;
  }
  return { value: !keepMarker && allOnes ? -1n : value, width };
}

/// WebM: an EBML header whose DocType is webm or matroska, then a Segment whose children (ids and
/// sizes) tile it, with Info or Tracks present. An unknown-size Segment or Cluster runs to the end
/// of the file, as in a live-written file.
const webm: Check = (b) => {
  if (!bytes(b, [0x1a, 0x45, 0xdf, 0xa3])) return false;
  const size = ebmlVint(b, 4, false);
  if (!size || size.value < 0n || 4 + size.width + Number(size.value) > b.length) return false;
  const headerEnd = 4 + size.width + Number(size.value);
  let off = 4 + size.width, docType = '';
  while (off < headerEnd) {
    const id = ebmlVint(b, off, true);
    if (!id) return false;
    const len = ebmlVint(b, off + id.width, false);
    if (!len || len.value < 0n || off + id.width + len.width + Number(len.value) > headerEnd) return false;
    const start = off + id.width + len.width;
    if (id.value === 0x4282n) docType = b.toString('latin1', start, start + Number(len.value)).replace(/\0+$/, '');
    off = start + Number(len.value);
  }
  if (off !== headerEnd || (docType !== 'webm' && docType !== 'matroska')) return false;
  const seg = ebmlVint(b, off, true);
  if (!seg || seg.value !== 0x18538067n) return false;
  const segSize = ebmlVint(b, off + seg.width, false);
  if (!segSize) return false;
  off += seg.width + segSize.width;
  const segEnd = segSize.value < 0n ? b.length : off + Number(segSize.value);
  if (segEnd > b.length) return false;
  let info = false, tracks = false;
  while (off < segEnd) {
    const id = ebmlVint(b, off, true);
    if (!id) return false;
    const len = ebmlVint(b, off + id.width, false);
    if (!len) return false;
    if (id.value === 0x1549a966n) info = true;
    if (id.value === 0x1654ae6bn) tracks = true;
    if (len.value < 0n) { if (id.value !== 0x1f43b675n) return false; off = segEnd; break; } // unknown-size Cluster
    off += id.width + len.width + Number(len.value);
    if (off > segEnd) return false;
  }
  return off === segEnd && (info || tracks);
};

const MP4_AUDIO_BRANDS = ['M4A ', 'M4B ', 'M4P ', 'mp41', 'mp42', 'isom', 'iso2', 'iso5', 'iso6', 'dash', 'avc1', '3gp4', '3gp5', 'qt  '];
const mp4: Check = (b) => bmff(b, MP4_AUDIO_BRANDS, [['moov'], ['mdat', 'moof']]);

export const AUDIO_CHECKS: Record<string, Check> = {
  wav, 'x-wav': wav, wave: wav, 'vnd.wave': wav,
  mpeg: mp3, mp3, 'x-mpeg': mp3,
  ogg: (b) => ogg(b), 'x-ogg': (b) => ogg(b), opus: (b) => ogg(b, 'opus'),
  flac, 'x-flac': flac,
  mp4, m4a: mp4, 'x-m4a': mp4, 'x-mp4': mp4,
  aac, 'x-aac': aac, aacp: aac,
  webm,
  aiff, 'x-aiff': aiff, aifc: aiff, 'x-aifc': aiff,
};

/// The parser for a declared mimeType on an item of `type`, or null when that combination can
/// never be exempt (wrong family, unknown subtype, SVG and other text formats).
export function mediaCheckFor(type: 'image' | 'audio', mimeType: unknown): Check | null {
  if (typeof mimeType !== 'string') return null;
  const m = /^([a-z]+)\/([a-z0-9.+-]+)\s*(?:;.*)?$/i.exec(mimeType.trim());
  if (!m || m[1]!.toLowerCase() !== type) return null;
  const table = type === 'image' ? IMAGE_CHECKS : AUDIO_CHECKS;
  const sub = m[2]!.toLowerCase();
  return Object.prototype.hasOwnProperty.call(table, sub) ? table[sub]! : null;
}

/// True when `b` parses as a file of the declared type.
export function isValidMedia(type: 'image' | 'audio', mimeType: unknown, b: Buffer): boolean {
  const check = mediaCheckFor(type, mimeType);
  if (!check) return false;
  try { return check(b); } catch { return false; }
}
