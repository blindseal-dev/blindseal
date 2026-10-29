/// Is this byte string a file of its declared image or audio type? Structural parsers for every
/// type the media exemption (blob-decode.ts) can apply to. Each one walks the whole container the
/// way a decoder would open it (chunks, segments, frames, pages, boxes), checks the fields a decoder
/// relies on, verifies the checksums the format carries, and requires the structure to account for
/// every byte. A signature, a trailer or a plausible length field is not enough, and neither is the
/// presence of a required part: its contents must be valid too (a quantisation table with no
/// entries, a TIFF with zero width, an MP4 `moov` with no track, a WebM Segment that ends before
/// the file does, a PNG scanline with filter type 255 are all refused; 0.7.0 final re-audit
/// A817-R3, two rounds). What a decoder accepts is still not read: pixels, samples, metadata text
/// and comment chunks are the file's content, which is out of scope by design (LIMITATIONS §15).
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
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;

/// The scanline layout IDAT must inflate to: [row count, bytes per row (filter byte included)] per
/// pass (one pass unless interlaced), and the total.
function pngScanlines(w: number, h: number, bpp: number, interlaced: boolean): { passes: Array<[number, number]>; total: number } {
  const passes: Array<[number, number]> = [];
  const add = (pw: number, ph: number) => { if (pw > 0 && ph > 0) passes.push([ph, 1 + Math.ceil((pw * bpp) / 8)]); };
  if (!interlaced) add(w, h);
  else for (const [xs, ys, xd, yd] of ADAM7) add(Math.ceil(Math.max(0, w - xs) / xd), Math.ceil(Math.max(0, h - ys) / yd));
  return { passes, total: passes.reduce((n, [rows, len]) => n + rows * len, 0) };
}

/// PNG: signature; chunks (length, type, data, CRC-32 verified) with IHDR first and valid, PLTE
/// before IDAT (required for indexed colour), at least one IDAT, consecutive, IEND last and
/// final; the concatenated IDAT inflates to exactly the scanlines the header implies, each with a
/// valid filter type (0–4).
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
      const lines = pngScanlines(w, h, PNG_CHANNELS[colour]! * depth, interlaced);
      if (lines.total > MAX_PNG_RAW) return false;
      let raw: Buffer;
      try { raw = inflateSync(Buffer.concat(data), { maxOutputLength: lines.total }); } catch { return false; }
      if (raw.length !== lines.total) return false;
      let p = 0;
      for (const [rows, len] of lines.passes) for (let r = 0; r < rows; r++, p += len) if (raw[p]! > 4) return false;
      return true;
    } else if (idat) idatDone = true;
    off += 12 + len;
  }
};

/// JPEG: SOI, then marker segments with valid lengths and contents: a frame header (components
/// with sampling factors and table ids), quantisation tables (64 entries each), Huffman tables
/// (count lists adding up to the segment) unless arithmetic-coded, scan headers naming frame
/// components, each followed by non-empty entropy-coded data skipped to the next marker (byte
/// stuffing and restart markers understood); EOI as the final two bytes.
const jpeg: Check = (b) => {
  if (!bytes(b, [0xff, 0xd8])) return false;
  let off = 2;
  let sof = false, sos = false, dqt = false, dht = false, arith = false, progressive = false;
  const componentIds = new Set<number>(), componentTq = new Map<number, number>();
  const qTables = new Set<number>(), hTables = new Set<number>(); // Huffman tables keyed class * 4 + id
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
    const seg = b.subarray(off + 2, off + len);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (sof) return false;
      const nc = seg[5] ?? 0;
      // Precision 8 or 12, non-zero height (a zero height deferred to a DNL marker is not supported
      // by common decoders and does not qualify) and width, 1–4 components.
      if (seg.length !== 6 + 3 * nc || nc < 1 || nc > 4 || ![8, 12].includes(seg[0]!) || seg.readUInt16BE(1) === 0 || seg.readUInt16BE(3) === 0) return false;
      for (let i = 0; i < nc; i++) {
        const id = seg[6 + 3 * i]!, hv = seg[7 + 3 * i]!, tq = seg[8 + 3 * i]!;
        if (componentIds.has(id) || (hv >> 4) < 1 || (hv >> 4) > 4 || (hv & 15) < 1 || (hv & 15) > 4 || tq > 3) return false;
        componentIds.add(id);
        componentTq.set(id, tq);
      }
      if (m >= 0xc9) arith = true;
      if (m === 0xc2 || m === 0xc6 || m === 0xca || m === 0xce) progressive = true;
      sof = true;
    } else if (m === 0xdb) {
      // DQT: tables of (Pq/Tq, 64 entries of 1 or 2 bytes) filling the segment exactly.
      let p = 0;
      if (seg.length === 0) return false;
      while (p < seg.length) {
        const pq = seg[p]! >> 4, tq = seg[p]! & 15;
        if (pq > 1 || tq > 3 || p + 1 + 64 * (pq + 1) > seg.length) return false;
        // No zero quantisation step.
        for (let i = 0; i < 64; i++) if ((pq ? seg.readUInt16BE(p + 1 + 2 * i) : seg[p + 1 + i]!) === 0) return false;
        qTables.add(tq);
        p += 1 + 64 * (pq + 1);
      }
      if (p !== seg.length) return false;
      dqt = true;
    } else if (m === 0xc4) {
      // DHT: tables of (Tc/Th, 16 counts, the symbols those counts add up to) filling the segment.
      let p = 0;
      if (seg.length === 0) return false;
      while (p < seg.length) {
        if (p + 17 > seg.length || (seg[p]! >> 4) > 1 || (seg[p]! & 15) > 3) return false;
        // Counts per code length must fit a prefix code (canonical Huffman), 1–256 symbols in all.
        let symbols = 0, code = 0;
        for (let i = 1; i <= 16; i++) {
          symbols += seg[p + i]!;
          code = (code + seg[p + i]!) * 2;
          if (code > 2 << i) return false;
        }
        if (symbols === 0 || symbols > 256) return false;
        hTables.add((seg[p]! >> 4) * 4 + (seg[p]! & 15));
        p += 17 + symbols;
      }
      if (p !== seg.length) return false;
      dht = true;
    } else if (m === 0xda) {
      if (!sof) return false;
      const ns = seg[0] ?? 0;
      if (ns < 1 || ns > 4 || seg.length !== 4 + 2 * ns) return false;
      // Spectral selection and successive approximation: baseline/sequential scans cover 0..63.
      const ss = seg[1 + 2 * ns]!, se = seg[2 + 2 * ns]!, ah = seg[3 + 2 * ns]! >> 4, al = seg[3 + 2 * ns]! & 15;
      if (se > 63 || ss > se || ah > 13 || al > 13 || (!progressive && (ss !== 0 || se !== 63 || ah !== 0 || al !== 0))) return false;
      for (let i = 0; i < ns; i++) {
        const cs = seg[1 + 2 * i]!, t = seg[2 + 2 * i]!, td = t >> 4, ta = t & 15;
        if (!componentIds.has(cs) || td > 3 || ta > 3 || !qTables.has(componentTq.get(cs)!)) return false;
        // Huffman-coded scans need their DC (ss = 0) and AC (se > 0) tables defined already;
        // progressive refinement scans (ah > 0) of DC coefficients use no table.
        if (!arith) {
          if (ss === 0 && ah === 0 && !hTables.has(td)) return false;
          if (se > 0 && !hTables.has(4 + ta)) return false;
        }
      }
      sos = true;
    }
    off += len;
    if (m === 0xda) {
      // Entropy-coded data: at least one byte, up to the next marker.
      const start = off;
      while (off < b.length) {
        if (b[off] === 0xff && off + 1 < b.length) {
          const n = b[off + 1]!;
          if (n !== 0 && n !== 0xff && !(n >= 0xd0 && n <= 0xd7)) break;
        }
        off++;
      }
      if (off === start) return false;
    }
  }
  return false;
};

/// GIF data sub-blocks (length-prefixed, 0 terminates): their concatenated bytes and the offset
/// after the terminator, or null.
function gifSubBlocks(b: Buffer, off: number): { end: number; data: Buffer } | null {
  const parts: Buffer[] = [];
  for (;;) {
    if (off >= b.length) return null;
    const len = b[off++]!;
    if (len === 0) return { end: off, data: Buffer.concat(parts) };
    if (off + len > b.length) return null;
    parts.push(b.subarray(off, off + len));
    off += len;
  }
}

/// Decodes a GIF image's LZW stream far enough to know it is one: every code is defined when used,
/// the stream ends with the end-of-information code (or exactly fills the image), and it produces
/// exactly `pixels` pixels. Pixel values themselves are not kept.
function gifLzwDecodes(data: Buffer, minCodeSize: number, pixels: number): boolean {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1, next = eoi + 1;
  const lengths = new Uint32Array(4096); // decoded length of each dictionary entry
  for (let i = 0; i < clear; i++) lengths[i] = 1;
  let prev = -1, out = 0, bitBuf = 0, bitCount = 0, p = 0;
  for (;;) {
    while (bitCount < codeSize) {
      if (p >= data.length) return false; // ran out before EOI
      bitBuf |= data[p++]! << bitCount;
      bitCount += 8;
    }
    const code = bitBuf & ((1 << codeSize) - 1);
    bitBuf >>>= codeSize;
    bitCount -= codeSize;
    if (code === clear) { codeSize = minCodeSize + 1; next = eoi + 1; prev = -1; continue; }
    if (code === eoi) return out === pixels && data.length - p <= 1;
    if (code > next || (code === next && prev < 0)) return false; // undefined code
    const len = code === next ? lengths[prev]! + 1 : lengths[code]!;
    out += len;
    if (out > pixels) return false;
    if (prev >= 0 && next < 4096) { lengths[next] = lengths[prev]! + 1; next++; if (next === 1 << codeSize && codeSize < 12) codeSize++; }
    prev = code;
    if (out === pixels) {
      // The image is full: the stream must end here, with the end-of-information code (or, at
      // most, bit padding). Data beyond the image is not pixel data.
      while (bitCount < codeSize && p < data.length) { bitBuf |= data[p++]! << bitCount; bitCount += 8; }
      if (bitCount < codeSize) return true; // the stream ends exactly with the image
      return (bitBuf & ((1 << codeSize) - 1)) === eoi && data.length - p <= 1;
    }
  }
}

/// GIF: header, logical screen descriptor and colour table; then image descriptors (with their
/// colour tables, LZW code size and data that decodes to exactly the image's pixels) and
/// extension blocks; the trailer is the last byte and at least one image is present.
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
      const w = b.readUInt16LE(off + 4), h = b.readUInt16LE(off + 6), flags = b[off + 8]!;
      if (w === 0 || h === 0) return false;
      off += 9;
      if (flags & 0x80) off += 3 << ((flags & 7) + 1);
      if (off >= b.length) return false;
      const lzw = b[off++]!;
      if (lzw < 1 || lzw > 8) return false;
      const sub = gifSubBlocks(b, off);
      if (!sub || sub.data.length === 0 || !gifLzwDecodes(sub.data, lzw, w * h)) return false;
      off = sub.end;
      images++;
    } else if (block === 0x21) {
      if (off + 1 >= b.length) return false;
      off++;
      const sub = gifSubBlocks(b, off);
      if (!sub) return false;
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
/// dimensions, first partition inside the chunk), a VP8L bitstream (signature, dimensions,
/// version 0) or a VP8X header (canvas dimensions) followed by such a bitstream or animation
/// frames. No chunk but the known ones.
const webp: Check = (b) => {
  const chunks = riffChunks(b, 'WEBP');
  if (!chunks || chunks.length === 0) return false;
  const KNOWN = new Set(['VP8 ', 'VP8L', 'VP8X', 'ANIM', 'ANMF', 'ALPH', 'ICCP', 'EXIF', 'XMP ']);
  if (!chunks.every((c) => KNOWN.has(c.id))) return false;
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
    return (bits >>> 29) === 0 && c.len > 5; // version 0, then image data
  };
  const first = chunks[0]!;
  if (first.id === 'VP8 ') return vp8(first);
  if (first.id === 'VP8L') return vp8l(first);
  if (first.id !== 'VP8X' || first.len !== 10) return false;
  const cw = 1 + (b[first.off + 4]! | (b[first.off + 5]! << 8) | (b[first.off + 6]! << 16));
  const ch = 1 + (b[first.off + 7]! | (b[first.off + 8]! << 8) | (b[first.off + 9]! << 16));
  if (cw === 0 || ch === 0) return false;
  return chunks.slice(1).some((c) => (c.id === 'VP8 ' && vp8(c)) || (c.id === 'VP8L' && vp8l(c)) || (c.id === 'ANMF' && c.len > 16));
};

/// A DIB (BMP / ICO bitmap) header: its validated layout (where the header plus colour table or
/// bit masks end, and how many pixel and mask bytes the image needs), or null. Arithmetic is kept
/// in doubles so oversized dimensions cannot wrap.
interface DibLayout { headerEnd: number; pixelBytes: number; maskBytes: number }
function dibLayout(d: Buffer, icon: boolean): DibLayout | null {
  if (d.length < 12) return null;
  const size = d.readUInt32LE(0);
  if (![12, 40, 52, 56, 64, 108, 124].includes(size) || d.length < size) return null;
  let w: number, h: number, planes: number, bpp: number, compression = 0, imageSize = 0, colours = 0;
  if (size === 12) {
    w = d.readUInt16LE(4); h = d.readUInt16LE(6); planes = d.readUInt16LE(8); bpp = d.readUInt16LE(10);
  } else {
    w = d.readInt32LE(4); h = d.readInt32LE(8); planes = d.readUInt16LE(12); bpp = d.readUInt16LE(14);
    compression = d.readUInt32LE(16); imageSize = d.readUInt32LE(20); colours = d.readUInt32LE(32);
  }
  if (icon) { if (h % 2 !== 0) return null; h /= 2; } // XOR bitmap over AND mask
  h = Math.abs(h);
  if (w <= 0 || h === 0 || planes !== 1 || ![1, 2, 4, 8, 16, 24, 32].includes(bpp)) return null;
  if (![0, 1, 2, 3, 4, 5, 6, 11, 12, 13].includes(compression) || (icon && compression !== 0)) return null;
  if (bpp <= 8 && colours > 1 << bpp) return null;
  let headerEnd = size;
  if (bpp <= 8) headerEnd += 4 * (colours || 1 << bpp);
  else if (compression === 3 && size === 40) headerEnd += 12;
  else if (compression === 6 && size === 40) headerEnd += 16;
  if (headerEnd > d.length) return null;
  const rowBytes = (bits: number) => Math.floor((bits * w + 31) / 32) * 4;
  if (compression === 0 || compression === 3 || compression === 6) {
    return { headerEnd, pixelBytes: rowBytes(bpp) * h, maskBytes: icon ? rowBytes(1) * h : 0 };
  }
  // Compressed (RLE / JPEG / PNG) pixel data: its declared size, which must be non-zero.
  return imageSize > 0 && !icon ? { headerEnd, pixelBytes: imageSize, maskBytes: 0 } : null;
}
/// An ICO bitmap: DIB header and colour table, then the XOR pixel rows and the AND mask, all inside
/// the image bytes.
function dibCheck(d: Buffer): boolean {
  const l = dibLayout(d, true);
  return l !== null && l.headerEnd + l.pixelBytes + l.maskBytes <= d.length;
}

/// BMP: file header (size field, pixel-array offset) and a valid DIB whose header and colour table
/// or masks end before the declared pixel-array offset, with the pixel array from that offset (and
/// a V5 header's colour profile, if any) ending the file.
const bmp: Check = (b) => {
  if (!at(b, 0, 'BM') || b.length < 26) return false;
  const size = b.readUInt32LE(2), dataOff = b.readUInt32LE(10);
  if ((size !== 0 && size !== b.length) || dataOff > b.length) return false;
  const l = dibLayout(b.subarray(14), false);
  if (l === null || 14 + l.headerEnd > dataOff) return false;
  let end = dataOff + l.pixelBytes;
  // BITMAPV5HEADER: an embedded ICC profile may follow the pixel array.
  if (b.readUInt32LE(14) === 124) {
    const profileOff = b.readUInt32LE(14 + 112), profileSize = b.readUInt32LE(14 + 116);
    if (profileSize > 0) {
      if (14 + profileOff < end) return false;
      end = 14 + profileOff + profileSize;
    }
  }
  return end === b.length;
};

const TIFF_TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

/// TIFF: byte order and magic, the first IFD within the file, entries with valid types whose
/// out-of-line values lie inside the file, with a non-zero width and length, a bit depth, and
/// strip (or tile) offsets and byte counts, every one inside the file.
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
  const entries = new Map<number, { type: number; count: number; at: number }>();
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + 12 * i;
    const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    if (type < 1 || type > 13 || entries.has(tag)) return false;
    const size = TIFF_TYPE_SIZE[type]! * count;
    const dataAt = size > 4 ? u32(e + 8) : e + 8;
    if (size > 4 && dataAt + size > b.length) return false;
    entries.set(tag, { type, count, at: dataAt });
  }
  /// The `i`th value of a SHORT/LONG entry, or -1.
  const value = (tag: number, i = 0): number => {
    const en = entries.get(tag);
    if (!en || i >= en.count) return -1;
    if (en.type === 3) return u16(en.at + 2 * i);
    if (en.type === 4) return u32(en.at + 4 * i);
    return -1;
  };
  const w = value(256), h = value(257);
  if (w <= 0 || h <= 0) return false;
  const bits = entries.has(258) ? value(258) : 1;
  if (![1, 2, 4, 8, 16, 32, 64].includes(bits)) return false;
  const [offTag, cntTag] = entries.has(273) ? [273, 279] : entries.has(324) ? [324, 325] : [0, 0];
  if (!offTag) return false;
  const offs = entries.get(offTag)!, cnts = entries.get(cntTag);
  if (!cnts || cnts.count !== offs.count || offs.count === 0) return false;
  for (let i = 0; i < offs.count; i++) {
    const o = value(offTag, i), c = value(cntTag, i);
    if (o < 0 || c <= 0 || o + c > b.length) return false;
  }
  return true;
};

/// ICO / CUR: header with at least one directory entry; each entry's image lies inside the file
/// and is a PNG or a DIB whose header, colour table, XOR bitmap and AND mask all fit.
const ico: Check = (b) => {
  if (b.length < 22 || b.readUInt16LE(0) !== 0 || ![1, 2].includes(b.readUInt16LE(2))) return false;
  const n = b.readUInt16LE(4);
  if (n === 0 || 6 + 16 * n > b.length) return false;
  for (let i = 0; i < n; i++) {
    const e = 6 + 16 * i;
    const size = b.readUInt32LE(e + 8), off = b.readUInt32LE(e + 12);
    if (size < 40 || off < 6 + 16 * n || off + size > b.length) return false;
    const img = b.subarray(off, off + size);
    if (bytes(img, [0x89, 0x50, 0x4e, 0x47])) { if (!png(img)) return false; }
    else if (!dibCheck(img)) return false;
  }
  return true;
};

// ---------------------------------------------------------------------------------------------
// ISO base media files (MP4 / M4A audio, AVIF / HEIC images).

interface Box { type: string; off: number; start: number; end: number }

/// The boxes tiling b[from, to): valid sizes (32-bit, 64-bit, to-end), FourCC types.
function boxes(b: Buffer, from: number, to: number): Box[] | null {
  const out: Box[] = [];
  let off = from;
  while (off < to) {
    if (off + 8 > to) return null;
    let size = b.readUInt32BE(off), header = 8;
    const type = b.toString('latin1', off + 4, off + 8);
    if (!FOURCC.test(type)) return null;
    if (size === 1) {
      if (off + 16 > to) return null;
      const big = b.readBigUInt64BE(off + 8);
      if (big > BigInt(to - off)) return null;
      size = Number(big);
      header = 16;
    } else if (size === 0) size = to - off;
    if (size < header || off + size > to) return null;
    out.push({ type, off, start: off + header, end: off + size });
    off += size;
  }
  return out;
}
/// Children of a container box; `fullBox` when the container itself is a FullBox (`meta`), whose
/// version and flags precede its children.
const child = (b: Buffer, box: Box, type: string, fullBox = false) => boxes(b, box.start + (fullBox ? 4 : 0), box.end)?.find((x) => x.type === type);
const children = (b: Buffer, box: Box, fullBox = false) => boxes(b, box.start + (fullBox ? 4 : 0), box.end);

/// A file's top-level boxes when `ftyp` comes first with an accepted brand; else null.
function bmffTop(b: Buffer, brands: readonly string[]): Box[] | null {
  const top = boxes(b, 0, b.length);
  if (!top || top.length === 0 || top[0]!.type !== 'ftyp' || top[0]!.end - top[0]!.start < 8) return null;
  const f = top[0]!;
  const found = [b.toString('latin1', f.start, f.start + 4)];
  for (let p = f.start + 8; p + 4 <= f.end; p += 4) found.push(b.toString('latin1', p, p + 4));
  return found.some((x) => brands.includes(x)) ? top : null;
}

/// HEIF-family image (AVIF, HEIC): a `meta` box with a `pict` handler, a primary item, item
/// infos including an image item of the expected codec, item locations whose extents lie inside
/// the file, and item properties with an image size and the codec configuration.
function heif(b: Buffer, brands: readonly string[], itemTypes: readonly string[], codecConfig: string): boolean {
  const top = bmffTop(b, brands);
  if (!top) return false;
  const meta = top.find((x) => x.type === 'meta');
  if (!meta || meta.end - meta.start < 4) return false;
  const hdlr = child(b, meta, 'hdlr', true);
  if (!hdlr || hdlr.end - hdlr.start < 12 || b.toString('latin1', hdlr.start + 8, hdlr.start + 12) !== 'pict') return false;
  if (!child(b, meta, 'pitm', true)) return false;
  // iinf: entry count, then infe boxes (version 2+: item id, protection, item type).
  const iinf = child(b, meta, 'iinf', true);
  if (!iinf || iinf.end - iinf.start < 6) return false;
  const v = b[iinf.start]!;
  const infes = boxes(b, iinf.start + 4 + (v === 0 ? 2 : 4), iinf.end);
  if (!infes || infes.length === 0) return false;
  let image = false;
  for (const e of infes) {
    if (e.type !== 'infe' || e.end - e.start < 4) return false;
    const ev = b[e.start]!;
    if (ev >= 2) {
      const idSize = ev === 2 ? 2 : 4;
      if (e.end - e.start < 4 + idSize + 2 + 4) return false;
      if (itemTypes.includes(b.toString('latin1', e.start + 4 + idSize + 2, e.start + 4 + idSize + 6))) image = true;
    }
  }
  if (!image) return false;
  // iloc: every extent inside the file.
  const iloc = child(b, meta, 'iloc', true);
  const idat = child(b, meta, 'idat', true);
  if (!iloc || !ilocExtentsInside(b, iloc, idat ? idat.end - idat.start : -1)) return false;
  // iprp/ipco: an image size and the codec configuration.
  const iprp = child(b, meta, 'iprp', true);
  const ipco = iprp && child(b, iprp, 'ipco');
  const props = ipco && children(b, ipco);
  if (!props) return false;
  const ispe = props.find((x) => x.type === 'ispe');
  if (!ispe || ispe.end - ispe.start < 12 || b.readUInt32BE(ispe.start + 4) === 0 || b.readUInt32BE(ispe.start + 8) === 0) return false;
  // av1C: 4 bytes starting with marker 1 / version 1; hvcC: a 23-byte header plus parameter arrays.
  return props.some((x) => x.type === codecConfig && (codecConfig === 'av1C' ? x.end - x.start === 4 && b[x.start] === 0x81 : x.end - x.start >= 23));
}

/// Parses an `iloc` box (versions 0–2) and checks that every extent lies inside the file (for
/// construction method 0, file offsets; method 1 offsets are into `idat`; method 2 is refused).
function ilocExtentsInside(b: Buffer, iloc: Box, idatSize: number): boolean {
  let p = iloc.start;
  const version = b[p]!;
  p += 4;
  if (version > 2 || p + 2 > iloc.end) return false;
  const offsetSize = b[p]! >> 4, lengthSize = b[p]! & 15, baseOffsetSize = b[p + 1]! >> 4, indexSize = version > 0 ? b[p + 1]! & 15 : 0;
  p += 2;
  if (![0, 4, 8].includes(offsetSize) || ![0, 4, 8].includes(lengthSize) || ![0, 4, 8].includes(baseOffsetSize) || ![0, 4, 8].includes(indexSize)) return false;
  const read = (size: number): number => {
    if (p + size > iloc.end) throw new RangeError('iloc');
    const v = size === 0 ? 0 : size === 2 ? b.readUInt16BE(p) : size === 4 ? b.readUInt32BE(p) : Number(b.readBigUInt64BE(p));
    p += size;
    return v;
  };
  try {
    const count = read(version < 2 ? 2 : 4);
    if (count === 0) return false;
    let anyExtent = false;
    for (let i = 0; i < count; i++) {
      read(version < 2 ? 2 : 4); // item id
      let method = 0;
      if (version > 0) method = read(2) & 15;
      read(2); // data reference index
      const base = read(baseOffsetSize);
      const extents = read(2);
      if (extents === 0) return false;
      for (let e = 0; e < extents; e++) {
        if (version > 0) read(indexSize);
        const off = read(offsetSize), len = read(lengthSize);
        if (len === 0) return false;
        // Method 0: file offsets. Method 1: offsets into the `idat` box, which must exist and hold
        // the extent. Method 2 (offsets into another item's data) is not resolved here: refused.
        if (method === 0 && base + off + len > b.length) return false;
        if (method === 1 && (idatSize < 0 || base + off + len > idatSize)) return false;
        if (method > 1) return false;
        anyExtent = true;
      }
    }
    return anyExtent && p === iloc.end;
  } catch { return false; }
}

const avif: Check = (b) => heif(b, ['avif', 'avis'], ['av01'], 'av1C');
const heic: Check = (b) => heif(b, ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'], ['hvc1', 'hev1'], 'hvcC');

const MP4_AUDIO_BRANDS = ['M4A ', 'M4B ', 'M4P ', 'mp41', 'mp42', 'isom', 'iso2', 'iso5', 'iso6', 'dash', 'avc1', '3gp4', '3gp5', 'qt  '];
/// Audio sample entries and the codec configuration box each must carry (null: none required,
/// as for uncompressed PCM).
const AUDIO_SAMPLE_ENTRIES: Record<string, string | null> = {
  mp4a: 'esds', alac: 'alac', 'ac-3': 'dac3', 'ec-3': 'dec3', Opus: 'dOps', fLaC: 'dfLa', samr: 'damr', sawb: 'damr',
  dtsc: 'ddts', dtse: 'ddts', dtsh: 'ddts', dtsl: 'ddts', mha1: 'mhaC', mhm1: 'mhaC', enca: 'sinf',
  sowt: null, twos: null, lpcm: null, ipcm: null, fpcm: null, ulaw: null, alaw: null, '.mp3': null, 'mp3 ': null,
  in24: null, in32: null, fl32: null, fl64: null, 'raw ': null, NONE: null, ima4: null,
};
/// FullBox payload sizes by version: movie header, track header, media header.
const FULLBOX_SIZES: Record<string, [number, number]> = { mvhd: [100, 112], tkhd: [84, 96], mdhd: [24, 36] };

/// A FullBox whose payload is exactly the size its version implies, with a non-zero timescale where
/// the box carries one (`mvhd`, `mdhd`).
function fullBoxSized(b: Buffer, box: Box | undefined): boolean {
  if (!box) return false;
  const sizes = FULLBOX_SIZES[box.type]!, version = b[box.start]!;
  if (version > 1 || box.end - box.start !== sizes[version]!) return false;
  if (box.type === 'mvhd' || box.type === 'mdhd') {
    const timescale = b.readUInt32BE(box.start + (version === 1 ? 20 : 12));
    if (timescale === 0) return false;
  }
  return true;
}

/// A sample-table FullBox: version/flags, an entry count, and `entrySize` bytes per entry filling
/// the payload. Returns the entry count, or -1.
function tableEntries(b: Buffer, box: Box | undefined, entrySize: number, lead = 0): number {
  if (!box || box.end - box.start < 8 + lead) return -1;
  const n = b.readUInt32BE(box.start + 4 + lead);
  return box.start + 8 + lead + n * entrySize === box.end ? n : -1;
}

/// An audio sample entry: the 28-byte fixed part (QuickTime versions 1 and 2 extend it), with a data
/// reference, at least one channel and a sample rate, followed by boxes including the codec's
/// configuration (directly, or inside a QuickTime `wave` box).
/// MPEG-4 descriptor at off: tag byte, then an expandable size (up to 4 bytes, high bit continues).
function descriptor(b: Buffer, off: number, end: number): { tag: number; start: number; end: number } | null {
  if (off + 2 > end) return null;
  const tag = b[off]!;
  let size = 0, p = off + 1, n = 0;
  for (;;) {
    if (p >= end || n === 4) return null;
    const x = b[p++]!;
    size = size * 128 + (x & 0x7f);
    n++;
    if (!(x & 0x80)) break;
  }
  return p + size <= end ? { tag, start: p, end: p + size } : null;
}
const MP4_AUDIO_OBJECT_TYPES = new Set([0x40, 0x66, 0x67, 0x68, 0x69, 0x6b, 0xa5, 0xa6, 0xa9, 0xac, 0xad, 0xdd, 0xe1]);
/// esds: an ES_Descriptor holding a DecoderConfigDescriptor of audio stream type with a known audio
/// object type and, for MPEG-4 audio, a DecoderSpecificInfo (AudioSpecificConfig) whose object
/// type, sampling frequency index and channel configuration are in range.
function esdsValid(b: Buffer, esds: Box): boolean {
  const es = descriptor(b, esds.start + 4, esds.end);
  if (!es || es.tag !== 0x03 || es.end - es.start < 3) return false;
  const flags = b[es.start + 2]!;
  let p = es.start + 3 + (flags & 0x80 ? 2 : 0) + (flags & 0x40 ? 1 + b[es.start + 3 + (flags & 0x80 ? 2 : 0)]! : 0) + (flags & 0x20 ? 2 : 0);
  let dcd: ReturnType<typeof descriptor> = null;
  while (p < es.end) {
    const d = descriptor(b, p, es.end);
    if (!d) return false;
    if (d.tag === 0x04) dcd = d;
    p = d.end;
  }
  if (!dcd || dcd.end - dcd.start < 13) return false;
  const objectType = b[dcd.start]!, streamType = b[dcd.start + 1]! >> 2;
  if (streamType !== 0x05 || !MP4_AUDIO_OBJECT_TYPES.has(objectType)) return false;
  if (objectType !== 0x40) return true;
  let q = dcd.start + 13, dsi: ReturnType<typeof descriptor> = null;
  while (q < dcd.end) {
    const d = descriptor(b, q, dcd.end);
    if (!d) return false;
    if (d.tag === 0x05) dsi = d;
    q = d.end;
  }
  if (!dsi || dsi.end - dsi.start < 2) return false;
  // AudioSpecificConfig: audioObjectType (5 bits; 31 escapes to 6 more), samplingFrequencyIndex
  // (4 bits; 15 escapes to a 24-bit frequency), channelConfiguration (4 bits). Every field must be
  // present in the descriptor's bytes.
  let bit = 0;
  const totalBits = (dsi.end - dsi.start) * 8;
  const bits = (n: number): number => {
    if (bit + n > totalBits) throw new RangeError('asc');
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = v * 2 + ((b[dsi.start + (bit >> 3)]! >> (7 - (bit & 7))) & 1);
    return v;
  };
  try {
    let audioObjectType = bits(5);
    if (audioObjectType === 31) audioObjectType = 32 + bits(6);
    const frequencyIndex = bits(4);
    const frequency = frequencyIndex === 15 ? bits(24) : frequencyIndex <= 12 ? 1 : 0;
    const channelConfig = bits(4);
    return audioObjectType !== 0 && frequency > 0 && channelConfig <= 7;
  } catch { return false; }
}

/// A QuickTime `wave` box's children; it may end with an 8-byte terminator atom of type 0.
function waveChildren(b: Buffer, wave: Box): Box[] {
  const terminated = wave.end - wave.start >= 8 && b.readUInt32BE(wave.end - 8) === 8 && b.readUInt32BE(wave.end - 4) === 0;
  return boxes(b, wave.start, terminated ? wave.end - 8 : wave.end) ?? [];
}

function audioSampleEntry(b: Buffer, e: Box): boolean {
  const need = AUDIO_SAMPLE_ENTRIES[e.type];
  if (need === undefined || e.end - e.start < 28) return false;
  const version = b.readUInt16BE(e.start + 8);
  const fixed = version === 0 ? 28 : version === 1 ? 44 : version === 2 ? 64 : -1;
  if (fixed < 0 || e.end - e.start < fixed) return false;
  if (b.readUInt16BE(e.start + 6) === 0 || b.readUInt16BE(e.start + 16) === 0 || b.readUInt32BE(e.start + 24) === 0) return false;
  const inner = boxes(b, e.start + fixed, e.end);
  if (!inner) return false;
  if (need === null) return true;
  const wave = inner.find((x) => x.type === 'wave');
  const config = inner.find((x) => x.type === need) ?? (wave ? waveChildren(b, wave).find((x) => x.type === need) : undefined);
  if (!config || config.end === config.start) return false;
  return need === 'esds' ? esdsValid(b, config) : true;
}

/// MP4 / M4A audio: `moov` with a sized movie header and at least one track with sized track and
/// media headers whose handler is sound, a sample description holding a valid audio sample entry,
/// and the sample tables (times, chunks, sizes, offsets) consistent, with chunk offsets inside the
/// file; samples present unless the file is fragmented (`moof`); then media (`mdat`) or fragments.
const mp4: Check = (b) => {
  const top = bmffTop(b, MP4_AUDIO_BRANDS);
  if (!top) return false;
  const moov = top.find((x) => x.type === 'moov');
  if (!moov || !fullBoxSized(b, child(b, moov, 'mvhd'))) return false;
  const fragmented = top.some((x) => x.type === 'moof');
  const mdats = top.filter((x) => x.type === 'mdat');
  if (!fragmented && mdats.length === 0) return false;
  // A fragmented file must carry at least one movie fragment with a track run of samples.
  if (fragmented && !top.some((moof) => moof.type === 'moof' && (children(b, moof) ?? []).some((traf) => traf.type === 'traf' && (children(b, traf) ?? []).some((trun) => trun.type === 'trun' && trun.end - trun.start >= 8 && b.readUInt32BE(trun.start + 4) > 0)))) return false;
  const traks = children(b, moov)?.filter((x) => x.type === 'trak') ?? [];
  let audio = false;
  for (const trak of traks) {
    const mdia = child(b, trak, 'mdia');
    const hdlr = mdia && child(b, mdia, 'hdlr');
    if (!fullBoxSized(b, child(b, trak, 'tkhd')) || !mdia || !fullBoxSized(b, child(b, mdia, 'mdhd'))) return false;
    // hdlr: version/flags, pre_defined, handler_type, 3 × reserved, name.
    if (!hdlr || hdlr.end - hdlr.start < 24) return false;
    const minf = child(b, mdia, 'minf');
    const stbl = minf && child(b, minf, 'stbl');
    if (!stbl) return false;
    // stsd: version/flags, entry count, sample entries.
    const stsd = child(b, stbl, 'stsd');
    if (!stsd || stsd.end - stsd.start < 8) return false;
    const entries = boxes(b, stsd.start + 8, stsd.end);
    if (!entries || entries.length === 0 || entries.length !== b.readUInt32BE(stsd.start + 4)) return false;
    // Sample tables: decoding times, sample-to-chunk, sizes (stsz: a constant size or one per
    // sample; stz2: packed field sizes), chunk offsets (every one inside the file).
    const stts = tableEntries(b, child(b, stbl, 'stts'), 8);
    const stsc = tableEntries(b, child(b, stbl, 'stsc'), 12);
    const stsz = child(b, stbl, 'stsz'), stz2 = child(b, stbl, 'stz2');
    let samples = -1;
    let sizeOf: (i: number) => number = () => 0;
    if (stsz && stsz.end - stsz.start >= 12) {
      const constant = b.readUInt32BE(stsz.start + 4);
      samples = tableEntries(b, stsz, constant === 0 ? 4 : 0, 4);
      sizeOf = constant === 0 ? (i) => b.readUInt32BE(stsz.start + 12 + 4 * i) : () => constant;
    } else if (stz2 && stz2.end - stz2.start >= 12) {
      const field = b[stz2.start + 7]!, n = b.readUInt32BE(stz2.start + 8);
      if ([4, 8, 16].includes(field) && stz2.start + 12 + Math.ceil((n * field) / 8) === stz2.end) {
        samples = n;
        sizeOf = field === 16 ? (i) => b.readUInt16BE(stz2.start + 12 + 2 * i) : field === 8 ? (i) => b[stz2.start + 12 + i]! : (i) => (b[stz2.start + 12 + (i >> 1)]! >> (i & 1 ? 0 : 4)) & 15;
      }
    }
    const stco = child(b, stbl, 'stco') ?? child(b, stbl, 'co64');
    const wide = stco?.type === 'co64';
    const chunks = tableEntries(b, stco, wide ? 8 : 4);
    if (stts < 0 || stsc < 0 || samples < 0 || chunks < 0) return false;
    if (!fragmented && (stts === 0 || stsc === 0 || samples === 0 || chunks === 0)) return false;
    // Sample-to-chunk: entries (first chunk, samples per chunk, description index) with increasing
    // first chunks from 1, assigning every sample to a chunk; each chunk's samples must lie within
    // the `mdat` that holds the chunk's offset.
    const stscBox = child(b, stbl, 'stsc')!;
    let sample = 0;
    for (let i = 0; i < stsc; i++) {
      const first = b.readUInt32BE(stscBox.start + 8 + 12 * i), per = b.readUInt32BE(stscBox.start + 12 + 12 * i), sdi = b.readUInt32BE(stscBox.start + 16 + 12 * i);
      const next = i + 1 < stsc ? b.readUInt32BE(stscBox.start + 8 + 12 * (i + 1)) : chunks + 1;
      if ((i === 0 && first !== 1) || per === 0 || sdi === 0 || sdi > entries.length || next <= first || next > chunks + 1) return false;
      for (let c = first; c < next; c++) {
        const o = wide ? Number(b.readBigUInt64BE(stco!.start + 8 + 8 * (c - 1))) : b.readUInt32BE(stco!.start + 8 + 4 * (c - 1));
        const holder = mdats.find((x) => o >= x.start && o < x.end);
        if (!holder) return false;
        let bytesInChunk = 0;
        for (let k = 0; k < per; k++, sample++) {
          if (sample >= samples) return false;
          bytesInChunk += sizeOf(sample);
        }
        if (o + bytesInChunk > holder.end) return false;
      }
    }
    if (sample !== samples) return false;
    if (stsc === 0 && chunks !== 0) return false;
    if (b.toString('latin1', hdlr.start + 8, hdlr.start + 12) === 'soun') {
      if (!entries.every((e) => audioSampleEntry(b, e))) return false;
      audio = true;
    }
  }
  return audio;
};

export const IMAGE_CHECKS: Record<string, Check> = {
  png, jpeg, jpg: jpeg, gif, webp, bmp, 'x-ms-bmp': bmp, tiff, avif, heic, heif: heic, 'x-icon': ico, 'vnd.microsoft.icon': ico,
};

// ---------------------------------------------------------------------------------------------
// Audio.

/// WAV: RIFF/WAVE chunks; a `fmt ` chunk (known format tag, channels, rate, block alignment and
/// sample size consistent) before a non-empty `data` chunk of whole blocks.
const wav: Check = (b) => {
  const chunks = riffChunks(b, 'WAVE');
  if (!chunks) return false;
  const fmt = chunks.findIndex((c) => c.id === 'fmt ');
  const data = chunks.findIndex((c) => c.id === 'data');
  if (fmt < 0 || data < 0 || fmt > data) return false;
  const f = chunks[fmt]!, d = chunks[data]!;
  if (f.len < 16 || d.len === 0) return false;
  const tag = b.readUInt16LE(f.off), channels = b.readUInt16LE(f.off + 2), rate = b.readUInt32LE(f.off + 4);
  const align = b.readUInt16LE(f.off + 12), bits = b.readUInt16LE(f.off + 14);
  if (![1, 3, 6, 7, 0x11, 0x55, 0xfffe].includes(tag) || channels === 0 || rate === 0 || align === 0) return false;
  if (tag === 1 || tag === 3 || tag === 0xfffe) {
    if (![8, 16, 24, 32, 64].includes(bits) || align !== (channels * bits) / 8 || d.len % align !== 0) return false;
  }
  return true;
};

/// AIFF / AIFF-C: FORM container whose chunks tile the file, a COMM chunk (channels, sample size,
/// frame count) and an SSND chunk holding at least the frames COMM declares.
const aiff: Check = (b) => {
  if (!at(b, 0, 'FORM') || b.readUInt32BE(4) + 8 !== b.length) return false;
  const form = b.toString('latin1', 8, 12);
  if (form !== 'AIFF' && form !== 'AIFC') return false;
  let off = 12, comm: { channels: number; frames: number; bits: number } | null = null, ssndBytes = -1;
  while (off < b.length) {
    if (off + 8 > b.length) return false;
    const id = b.toString('latin1', off, off + 4), len = b.readUInt32BE(off + 4);
    if (!FOURCC.test(id) || off + 8 + len > b.length) return false;
    if (id === 'COMM') {
      if (comm || len < (form === 'AIFC' ? 22 : 18)) return false;
      const channels = b.readUInt16BE(off + 8), frames = b.readUInt32BE(off + 10), bits = b.readUInt16BE(off + 14);
      if (channels === 0 || bits < 1 || bits > 32 || b.readUInt16BE(off + 16) === 0 /* sample-rate exponent */) return false;
      comm = { channels, frames, bits };
    } else if (id === 'SSND') {
      if (ssndBytes >= 0 || len < 8) return false;
      ssndBytes = len - 8 - b.readUInt32BE(off + 8);
    }
    off += 8 + len + (len & 1);
  }
  if (!comm || ssndBytes < 0 || (off !== b.length && off !== b.length + 1)) return false;
  // Uncompressed AIFF: the declared frames must be present (AIFF-C may be compressed).
  return form === 'AIFC' || ssndBytes >= comm.frames * comm.channels * Math.ceil(comm.bits / 8);
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
  const h1 = b[off + 1]!, h2 = b[off + 2]!, h3 = b[off + 3]!;
  const versionBits = (h1 >> 3) & 3, layerBits = (h1 >> 1) & 3;
  if (versionBits === 1 || layerBits === 0) return null;
  const version = versionBits === 3 ? 0 : versionBits === 2 ? 1 : 2; // MPEG1, MPEG2, MPEG2.5
  const layer = (4 - layerBits) as 1 | 2 | 3;
  const bitrateIndex = h2 >> 4, rateIndex = (h2 >> 2) & 3, padding = (h2 >> 1) & 1;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3 || (h3 & 3) === 2 /* reserved emphasis */) return null;
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
    if (r >= AAC_RATES || (rate >= 0 && r !== rate) || len <= (protection ? 7 : 9) || off + len > b.length) return false;
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
/// sample-size codes, coded frame number, and its CRC-8. (Frame lengths are not recoverable
/// without decoding, so later frames are not walked: LIMITATIONS §15.)
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
/// CRC, tiling the file; the first page begins a stream (BOS) with a valid identification header
/// of a known codec (Opus, Vorbis, FLAC, Speex); at least one later page carries data.
/// `codec` restricts the first packet (audio/opus → OpusHead).
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
      const p = off + 27 + segs;
      let known = false;
      if (at(b, p, 'OpusHead')) known = body >= 19 && b[p + 8] === 1 && b[p + 9]! > 0;
      else if (!codec && at(b, p, '\x01vorbis')) known = body >= 30 && b.readUInt32LE(p + 7) === 0 && b[p + 11]! > 0 && b.readUInt32LE(p + 12) > 0 && b[p + 29] === 1;
      else if (!codec && at(b, p, '\x7fFLAC')) known = body >= 51 && at(b, p + 9, 'fLaC');
      else if (!codec && at(b, p, 'Speex   ')) known = body >= 80;
      if (!known) return false;
    }
    off += len;
    pages++;
  }
  return pages > 1 && off === b.length;
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

interface Ebml { id: bigint; start: number; end: number; unknown: boolean }

/// The EBML elements tiling b[from, to); an unknown-size element (allowed only for the ids in
/// `unknownOk`) runs to `to`.
function ebmlChildren(b: Buffer, from: number, to: number, unknownOk: bigint[] = []): Ebml[] | null {
  const out: Ebml[] = [];
  let off = from;
  while (off < to) {
    const id = ebmlVint(b, off, true);
    if (!id) return null;
    const len = ebmlVint(b, off + id.width, false);
    if (!len) return null;
    const start = off + id.width + len.width;
    if (len.value < 0n) {
      if (!unknownOk.includes(id.value)) return null;
      out.push({ id: id.value, start, end: to, unknown: true });
      return out;
    }
    const end = start + Number(len.value);
    if (end > to) return null;
    out.push({ id: id.value, start, end, unknown: false });
    off = end;
  }
  return off === to ? out : null;
}

const EBML_SEGMENT = 0x18538067n, EBML_TRACKS = 0x1654ae6bn, EBML_TRACK_ENTRY = 0xaen, EBML_TRACK_TYPE = 0x83n, EBML_CODEC_ID = 0x86n;
const EBML_CLUSTER = 0x1f43b675n, EBML_SIMPLE_BLOCK = 0xa3n, EBML_BLOCK_GROUP = 0xa0n, EBML_BLOCK = 0xa1n, EBML_DOCTYPE = 0x4282n, EBML_TRACK_NUMBER = 0xd7n;

/// WebM: an EBML header whose DocType is webm or matroska; a Segment that reaches the end of the
/// file (its size, or unknown) whose children tile it, with a Tracks element holding an audio
/// track with a codec id, and at least one Cluster holding a block.
const webm: Check = (b) => {
  if (!bytes(b, [0x1a, 0x45, 0xdf, 0xa3])) return false;
  const top = ebmlChildren(b, 0, b.length, [EBML_SEGMENT]);
  if (!top || top.length !== 2 || top[0]!.id !== 0x1a45dfa3n || top[1]!.id !== EBML_SEGMENT) return false;
  const header = ebmlChildren(b, top[0]!.start, top[0]!.end);
  const docType = header?.find((e) => e.id === EBML_DOCTYPE);
  if (!docType || !['webm', 'matroska'].includes(b.toString('latin1', docType.start, docType.end).replace(/\0+$/, ''))) return false;
  const seg = top[1]!;
  if (seg.end !== b.length) return false;
  const kids = ebmlChildren(b, seg.start, seg.end, [EBML_CLUSTER]);
  if (!kids) return false;
  const tracks = kids.find((e) => e.id === EBML_TRACKS);
  if (!tracks) return false;
  const entries = ebmlChildren(b, tracks.start, tracks.end)?.filter((e) => e.id === EBML_TRACK_ENTRY) ?? [];
  const trackNumbers = new Set<bigint>();
  let audio = false;
  for (const t of entries) {
    const fields = ebmlChildren(b, t.start, t.end);
    const number = fields?.find((e) => e.id === EBML_TRACK_NUMBER);
    if (!number || number.end - number.start < 1 || number.end - number.start > 8) return false;
    let n = 0n;
    for (let p = number.start; p < number.end; p++) n = (n << 8n) | BigInt(b[p]!);
    if (n === 0n) return false;
    trackNumbers.add(n);
    const type = fields?.find((e) => e.id === EBML_TRACK_TYPE), codec = fields?.find((e) => e.id === EBML_CODEC_ID);
    if (!!type && type.end - type.start === 1 && b[type.start] === 2 && !!codec && codec.end > codec.start) audio = true;
  }
  if (!audio) return false;
  // A block: track number (vint), 16-bit timecode, flags, then frames. Its track must exist, and
  // when the flags announce lacing (Xiph, EBML or fixed-size), the lace headers must be present
  // and every frame's bytes must lie within the block.
  const blockOk = (start: number, end: number) => {
    const tn = ebmlVint(b, start, false);
    if (!tn || !trackNumbers.has(tn.value)) return false;
    let p = start + tn.width + 3;
    if (p > end) return false;
    const lacing = (b[p - 1]! >> 1) & 3;
    if (lacing === 0) return end - p >= 1;
    if (p >= end) return false;
    const frames = b[p++]! + 1;
    const sizes: number[] = [];
    if (lacing === 2) {
      if ((end - p) % frames !== 0 || end - p === 0) return false;
      return true;
    }
    if (lacing === 1) {
      for (let f = 0; f < frames - 1; f++) {
        let size = 0;
        for (;;) {
          if (p >= end) return false;
          const x = b[p++]!;
          size += x;
          if (x < 255) break;
        }
        sizes.push(size);
      }
    } else {
      const firstSize = ebmlVint(b, p, false);
      if (!firstSize || firstSize.value < 0n || p + firstSize.width > end) return false;
      p += firstSize.width;
      let size = Number(firstSize.value);
      sizes.push(size);
      for (let f = 1; f < frames - 1; f++) {
        const raw = ebmlVint(b, p, false);
        if (!raw || p + raw.width > end) return false;
        p += raw.width;
        // Signed delta: subtract the bias 2^(7·width − 1) − 1 from the unsigned value.
        const bias = (1n << BigInt(7 * raw.width - 1)) - 1n;
        const unsigned = raw.value < 0n ? (1n << BigInt(7 * raw.width)) - 1n : raw.value;
        size += Number(unsigned - bias);
        if (size < 0) return false;
        sizes.push(size);
      }
    }
    const laced = sizes.reduce((a, x) => a + x, 0);
    return sizes.every((x) => x >= 1) && end - p - laced >= 1; // the last frame takes the rest
  };
  const clusters = kids.filter((e) => e.id === EBML_CLUSTER);
  if (clusters.length === 0) return false;
  return clusters.some((c) => {
    const inner = c.unknown ? ebmlChildren(b, c.start, c.end, [EBML_CLUSTER]) : ebmlChildren(b, c.start, c.end);
    return !!inner && inner.some((e) => {
      if (e.id === EBML_SIMPLE_BLOCK) return blockOk(e.start, e.end);
      if (e.id !== EBML_BLOCK_GROUP) return false;
      const block = ebmlChildren(b, e.start, e.end)?.find((x) => x.id === EBML_BLOCK);
      return !!block && blockOk(block.start, block.end);
    });
  });
};

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
