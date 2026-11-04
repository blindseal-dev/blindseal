import { runLayer1, base64Spans } from './layer1-heuristics.js';
import type { DetectionResult } from './types.js';
import { isBudgetResult, type ScanBudget } from './scan-budget.js';

export interface DecodedResult {
  decoder: string;
  decoded: string;
  depth: number;
}

export interface L0Result {
  fired: boolean;
  decoded?: string;
  decoder?: string;
  l1Match?: DetectionResult;
}

// Minimum length for a candidate encoded payload — below this, false positive rate climbs.
const MIN_ENCODED_LEN = 16;

// Reject decoded content that is itself just binary / non-printable noise.
function isPrintableAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x09 || (c > 0x0d && c < 0x20) || c > 0x7e) return false;
  }
  return s.length > 0;
}

export function decodeBase64(content: string): DecodedResult[] {
  const results: DecodedResult[] = [];
  // Strict base64 blobs (padding required OR '+' required to exclude hex/URL paths), i.e. the
  // matches of /[A-Za-z0-9+/]{20,}={1,2}|[A-Za-z0-9/]{5,}[+][A-Za-z0-9+/]{15,}/g, found in
  // linear time (the regex is quadratic on long base64-character runs).
  for (const [start, end] of base64Spans(content, 15)) {
    const blob = content.slice(start, end);
    try {
      const decoded = Buffer.from(blob, 'base64').toString('utf8');
      if (isPrintableAscii(decoded) && decoded.length >= MIN_ENCODED_LEN) {
        results.push({ decoder: 'base64', decoded, depth: 1 });
      }
    } catch {
      // not valid base64 — skip
    }
  }
  return results;
}

export function decodeHex(content: string): DecodedResult[] {
  const results: DecodedResult[] = [];
  // Hex runs: 0x-prefixed OR bare even-length runs of hex digits >= 32 chars (16+ bytes).
  const re = /(?:0x)?([0-9a-fA-F]{32,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const hex = m[1] ?? m[0];
    if (hex.length % 2 !== 0) continue;
    try {
      const decoded = Buffer.from(hex, 'hex').toString('utf8');
      if (isPrintableAscii(decoded) && decoded.length >= MIN_ENCODED_LEN) {
        results.push({ decoder: 'hex', decoded, depth: 1 });
      }
    } catch {
      // skip
    }
  }
  return results;
}

export function decodeUrl(content: string): DecodedResult[] {
  const results: DecodedResult[] = [];
  // Match any run that looks like a URL-encoded string: word/path chars mixed with %XX,
  // requiring at least 2 percent-encoded characters anywhere in the run.
  const re = /(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]|%[0-9a-fA-F]{2}){8,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const encoded = m[0];
    const pctCount = (encoded.match(/%[0-9a-fA-F]{2}/g) ?? []).length;
    if (pctCount < 2) continue;
    try {
      const decoded = decodeURIComponent(encoded);
      if (decoded !== encoded && isPrintableAscii(decoded) && decoded.length >= MIN_ENCODED_LEN) {
        results.push({ decoder: 'url-percent', decoded, depth: 1 });
      }
    } catch {
      // skip malformed sequences
    }
  }
  return results;
}

export function decodeHtmlEntities(content: string): DecodedResult[] {
  // We only decode runs of numeric character references; named entities are common in docs.
  const re = /(?:&#x?[0-9a-fA-F]+;){4,}/gi;
  let m: RegExpExecArray | null;
  const results: DecodedResult[] = [];
  while ((m = re.exec(content)) !== null) {
    const run = m[0];
    // Guard against invalid code points (> U+10FFFF or the surrogate range): String.fromCodePoint
    // throws a RangeError on those, which — with no try/catch in runLayer0/pipeline — would let an
    // oversized-entity payload (e.g. "&#x110000;"...) crash the scan and pass unscreened. Leave any
    // such entity undecoded instead. (Security fix.)
    const fromCp = (cp: number, original: string): string =>
      Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
        ? String.fromCodePoint(cp)
        : original;
    const decoded = run
      .replace(/&#x([0-9a-fA-F]+);/gi, (m, h) => fromCp(parseInt(h, 16), m))
      .replace(/&#([0-9]+);/gi, (m, d) => fromCp(parseInt(d, 10), m));
    if (decoded !== run && isPrintableAscii(decoded) && decoded.length >= MIN_ENCODED_LEN) {
      results.push({ decoder: 'html-entities', decoded, depth: 1 });
    }
  }
  return results;
}

// Invisible characters that split a word without showing: zero-width space/non-joiner/joiner,
// word joiner, BOM, soft hyphen.
const INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

/// The text with invisible characters removed, when it had any: "ig\u200Bnore previous …" is
/// read as the phrase it renders as, at any length (the zero-width-density ratio alone is
/// diluted by enough surrounding text). Proven (release 0.8.0): the guest strips the same set.
export function decodeInvisible(content: string): DecodedResult[] {
  INVISIBLE_RE.lastIndex = 0;
  if (!INVISIBLE_RE.test(content)) return [];
  INVISIBLE_RE.lastIndex = 0;
  return [{ decoder: 'zero-width-strip', decoded: content.replace(INVISIBLE_RE, ''), depth: 1 }];
}

/// Unicode NFKC: fullwidth and mathematical letters, ligatures, enclosed digits and the like read as
/// the ASCII they render as. Emitted only when it changes the text. Proven: the guest folds with the
/// same normalization (unicode-normalization 0.1.24, Unicode 16; Node's ICU must agree, which the
/// parity vectors check).
export function decodeNfkc(content: string): DecodedResult[] {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(content)) return [];
  const folded = content.normalize('NFKC');
  if (folded === content) return [];
  return [{ decoder: 'nfkc', decoded: folded, depth: 1 }];
}

/// Confusable → ASCII, character by character: Cyrillic and Greek letters that render like Latin
/// ones, plus the dotless i. Listed identically in detector-core (`HOMOGLYPHS` in src/l0.rs); the
/// parity vectors carry the whole table.
export const HOMOGLYPHS: ReadonlyMap<string, string> = new Map<string, string>([
  // Cyrillic lowercase
  ['\u0430', 'a'], ['\u0435', 'e'], ['\u043E', 'o'], ['\u0440', 'p'], ['\u0441', 'c'],
  ['\u0443', 'y'], ['\u0445', 'x'], ['\u0456', 'i'], ['\u0458', 'j'], ['\u0455', 's'],
  ['\u04BB', 'h'], ['\u0501', 'd'], ['\u051B', 'q'], ['\u051D', 'w'], ['\u0475', 'v'],
  ['\u04CF', 'l'], ['\u043F', 'n'], ['\u0433', 'r'], ['\u0442', 't'], ['\u043A', 'k'],
  ['\u0432', 'b'], ['\u043C', 'm'], ['\u0448', 'w'], ['\u0491', 'r'],
  // Cyrillic uppercase
  ['\u0410', 'A'], ['\u0412', 'B'], ['\u0415', 'E'], ['\u041A', 'K'], ['\u041C', 'M'],
  ['\u041D', 'H'], ['\u041E', 'O'], ['\u0420', 'P'], ['\u0421', 'C'], ['\u0422', 'T'],
  ['\u0425', 'X'], ['\u0423', 'Y'], ['\u0405', 'S'], ['\u0406', 'I'], ['\u0408', 'J'],
  ['\u0500', 'D'], ['\u051A', 'Q'], ['\u051C', 'W'], ['\u0474', 'V'], ['\u0413', 'F'],
  // Greek lowercase
  ['\u03B1', 'a'], ['\u03B5', 'e'], ['\u03BF', 'o'], ['\u03BD', 'v'], ['\u03B9', 'i'],
  ['\u03BA', 'k'], ['\u03C1', 'p'], ['\u03C4', 't'], ['\u03C5', 'u'], ['\u03C7', 'x'],
  ['\u03C9', 'w'], ['\u03B3', 'y'], ['\u03C3', 'o'], ['\u03B7', 'n'],
  // Greek uppercase
  ['\u0391', 'A'], ['\u0392', 'B'], ['\u0395', 'E'], ['\u0396', 'Z'], ['\u0397', 'H'],
  ['\u0399', 'I'], ['\u039A', 'K'], ['\u039C', 'M'], ['\u039D', 'N'], ['\u039F', 'O'],
  ['\u03A1', 'P'], ['\u03A4', 'T'], ['\u03A5', 'Y'], ['\u03A7', 'X'],
  // Latin look-alikes outside ASCII
  ['\u0131', 'i'], ['\u0269', 'i'], ['\u0261', 'g'], ['\u0251', 'a'], ['\u0183', 'b'],
  ['\u0188', 'c'], ['\u0256', 'd'], ['\u025B', 'e'], ['\u0283', 's'], ['\u028B', 'v'],
  ['\u0280', 'r'], ['\u0274', 'n'], ['\u0299', 'b'], ['\u029C', 'h'], ['\u1D00', 'a'],
  ['\u1D07', 'e'], ['\u1D0F', 'o'], ['\u1D1C', 'u'],
]);

export function decodeHomoglyph(content: string): DecodedResult[] {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(content)) return [];
  let changed = false;
  let out = '';
  for (const ch of content) {
    const to = HOMOGLYPHS.get(ch);
    if (to !== undefined) { changed = true; out += to; } else out += ch;
  }
  return changed ? [{ decoder: 'homoglyph', decoded: out, depth: 1 }] : [];
}

/// Every decoder once over `content`, in candidate order (the order the guest uses).
function allDecoders(content: string): DecodedResult[] {
  return [
    ...decodeBase64(content),
    ...decodeHex(content),
    ...decodeUrl(content),
    ...decodeHtmlEntities(content),
    ...decodeInvisible(content),
    ...decodeNfkc(content),
    ...decodeHomoglyph(content),
  ];
}

export function decodeNested(content: string, maxDepth: number = 3): DecodedResult[] {
  const results: DecodedResult[] = [];
  const seen = new Set<string>();

  function recurse(text: string, depth: number, parentDecoder: string): void {
    if (depth > maxDepth) return;
    for (const c of allDecoders(text)) {
      const key = `${c.decoder}:${c.decoded}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ ...c, decoder: `${parentDecoder}→${c.decoder}`, depth });
      recurse(c.decoded, depth + 1, `${parentDecoder}→${c.decoder}`);
    }
  }

  // Only call for nested: run all decoders on the input, then recurse.
  for (const c of allDecoders(content)) {
    const key = `${c.decoder}:${c.decoded}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recurse(c.decoded, 2, c.decoder);
  }
  return results;
}


/// Layer 0, the PROVEN layer: decode (base64, hex, URL, HTML entities, zero-width strip, NFKC,
/// homoglyph fold; nested to depth 3), then Layer 1 on each candidate; the first candidate Layer 1
/// flags decides. Must equal the Rust detector-core's result (evals/parity) — the zk guest runs the
/// same decoders — so it adds nothing the guest does not have.
export function runLayer0(content: string, budget?: ScanBudget): L0Result {
  return withBudget(budget, () => layer0(content, budget, false));
}

/// Layer 0 as the proxy screens with it: every candidate is checked (a base64-only hit, e.g. a
/// decoy blob, does not end the search). Only ever stricter than runLayer0.
export function screenLayer0(content: string, budget?: ScanBudget): L0Result {
  return withBudget(budget, () => layer0(content, budget, true));
}

function withBudget<T>(budget: ScanBudget | undefined, fn: () => T): T {
  if (!budget) return fn();
  budget.enter();
  try {
    return fn();
  } finally {
    budget.leave();
  }
}

function layer0(content: string, budget: ScanBudget | undefined, extended: boolean): L0Result {
  if (budget?.expired()) return { fired: true, decoder: 'budget', l1Match: budget.result() };
  const candidates: DecodedResult[] = [...allDecoders(content), ...decodeNested(content)];

  // screenLayer0 checks every candidate: one that trips only the base64-blob heuristic (a decoy
  // blob nested in base64) must not end the search before a later candidate holding the injection.
  let base64Only: L0Result | null = null;
  for (const c of candidates) {
    const l1 = runLayer1(c.decoded, budget);
    if (isBudgetResult(l1)) return { fired: true, decoder: 'budget', l1Match: l1 };
    if (l1.verdict === 'clean') continue;
    const hit = { fired: true, decoded: c.decoded, decoder: c.decoder, l1Match: l1 };
    if (!extended || l1.detectedPatterns.some((p) => p !== 'large-base64-blob')) return hit;
    base64Only ??= hit;
  }
  if (base64Only) return base64Only;
  return { fired: false };
}

export function makeLayer0Result(l0: ReturnType<typeof runLayer0>): DetectionResult {
  const match = l0.l1Match!;
  if (isBudgetResult(match)) return match;
  return {
    verdict: match.verdict,
    confidence: match.confidence,
    reasoning: `layer-0 (${l0.decoder}) decoded content triggered L1: ${match.reasoning}`,
    detectedPatterns: match.detectedPatterns.map(p => `l0-${l0.decoder}->${p}`),
    layer: 0,
    l3Status: 'skipped_gate',
  };
}
