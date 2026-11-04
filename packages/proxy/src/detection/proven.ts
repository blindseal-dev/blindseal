/// Payload screening as the proof asserts it (release 0.8.0). Mirror of detector-core `screen.rs`;
/// both run evals/vectors/payload-screen.json in the parity gate.
///
/// The screened payload is the tool call serialized as JSON (`JSON.stringify({tool, args})`). In that
/// serialization control characters and other escapable characters become two-character escapes
/// (`\n`, `\t`, `\u000b`), so the proven layers run on the raw text alone miss an injection that only
/// reads as one unescaped — "ignore\nprevious instructions" in an argument. Releases before 0.8.0
/// screened the raw text only; the 0.7.x proxy's live screening, which reads each string of the parsed
/// call's arguments, was not affected (before 0.7.0 the proxy did not screen arguments at all).
///
/// The proof asserts L1 and L0 pass on the raw payload AND on every JSON string leaf (object keys and
/// string values, any depth, unescaped), each screened as its own text. The payload must parse as JSON
/// the way serde_json parses it (`strictJsonLeaves`); otherwise it is refused as `unparseable-payload`.
/// The result is order-independent (the union of pattern names) because the two parsers visit object
/// members in different orders.
import { runLayer0 } from './layer0-decoder.js';
import { runLayer1 } from './layer1-heuristics.js';
import type { Verdict } from './types.js';
import { rankVerdict } from './types.js';

export const UNPARSEABLE = 'unparseable-payload';
/// The deepest nesting serde_json parses with its default recursion limit (128): at most 127 arrays or
/// objects inside one another. Calibrated by the parity vectors `parse:depth-*`.
export const SERDE_MAX_DEPTH = 127;

/// A lone surrogate (half of a UTF-16 pair with no partner): serde_json refuses a `\udXXX` escape like this.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const wellFormed = (s: string) => !LONE_SURROGATE.test(s);

export interface PayloadScreen {
  verdict: Verdict;
  /// Sorted union of L1 pattern names over every screened text (L1 directly and the L1 match of the
  /// first L0 candidate that fired).
  patterns: string[];
  /// Distinct string leaves screened (keys and values).
  leaves: number;
  clean: boolean;
}

/// Every distinct string leaf of `payload` (keys and values, any depth), or null when serde_json would
/// not parse it: invalid JSON, nesting deeper than its recursion limit, a string with a lone surrogate
/// (serde_json rejects `\ud800` without its pair), or a number outside f64 range.
export function strictJsonLeaves(payload: string): Set<string> | null {
  let v: unknown;
  try {
    v = JSON.parse(payload);
  } catch {
    return null;
  }
  const out = new Set<string>();
  let ok = true;
  const walk = (x: unknown, depth: number): void => {
    if (!ok) return;
    if (typeof x === 'string') {
      if (!wellFormed(x)) ok = false;
      else out.add(x);
    } else if (typeof x === 'number') {
      if (!Number.isFinite(x)) ok = false;
    } else if (Array.isArray(x)) {
      if (depth + 1 > SERDE_MAX_DEPTH) { ok = false; return; }
      for (const e of x) walk(e, depth + 1);
    } else if (x !== null && typeof x === 'object') {
      if (depth + 1 > SERDE_MAX_DEPTH) { ok = false; return; }
      for (const [k, e] of Object.entries(x as Record<string, unknown>)) {
        if (!wellFormed(k)) { ok = false; return; }
        out.add(k);
        walk(e, depth + 1);
      }
    }
  };
  walk(v, 0);
  return ok ? out : null;
}

/// The proven layers over the raw payload and every JSON string leaf. Clean only if every text passes
/// both L1 and L0. What `blindseal attest` checks before it starts the prover, and what the guest
/// asserts.
export function screenPayload(payload: string): PayloadScreen {
  const leaves = strictJsonLeaves(payload);
  if (!leaves) return { verdict: 'malicious', patterns: [UNPARSEABLE], leaves: 0, clean: false };
  let verdict: Verdict = 'clean';
  const patterns = new Set<string>();
  const absorb = (v: Verdict, p: string[]) => {
    if (rankVerdict(v) > rankVerdict(verdict)) verdict = v;
    for (const x of p) patterns.add(x);
  };
  for (const t of [payload, ...leaves]) {
    const l1 = runLayer1(t);
    absorb(l1.verdict, l1.detectedPatterns);
    const l0 = runLayer0(t);
    if (l0.fired && l0.l1Match) absorb(l0.l1Match.verdict, l0.l1Match.detectedPatterns);
  }
  const sorted = [...patterns].sort();
  return { verdict, patterns: sorted, leaves: leaves.size, clean: verdict === 'clean' };
}
