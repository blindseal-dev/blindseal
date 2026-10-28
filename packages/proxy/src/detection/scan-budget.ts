/// Bounded scanning for Layer 0/1.
///
/// Every regex check runs on chunks of at most SCAN_CHUNK characters, so its cost per chunk is
/// bounded whatever the input looks like, and the time spent is checked against an allowance
/// between chunks. An allowance is shared by every pass over one message (`ScanBudget`): when it
/// runs out, the scan stops and returns a `screening-budget-exceeded` result, which is non-clean,
/// so block mode blocks the message instead of forwarding text that was not fully scanned.
///
/// No text is skipped because of its length. Chunks overlap by SCAN_OVERLAP characters, so any
/// match up to that span lies wholly inside one chunk; runs of whitespace are collapsed first, so
/// padding between the words of a phrase cannot push it past the overlap. The checks whose match
/// has no length bound (base64 runs, HTML comments, markdown link text) do not use the chunks:
/// they are linear scans over the whole text (layer1-heuristics.ts).

import type { DetectionResult } from './types.js';

export const SCAN_CHUNK = 4096;
export const SCAN_OVERLAP = 512;
export const DEFAULT_SCAN_BUDGET_MS = 2000;
export const BUDGET_PATTERN = 'screening-budget-exceeded';

export function readScanBudgetMs(): number {
  const raw = process.env.BLINDSEAL_SCAN_BUDGET_MS;
  if (!raw) return DEFAULT_SCAN_BUDGET_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SCAN_BUDGET_MS;
}

/// The Layer 0/1 time allowance for one message. Only time spent inside Layer 0/1 counts
/// (runLayer0/runLayer1 bracket their work with enter/leave), so awaiting the model layers between
/// passes does not use it up. Once spent it stays spent.
export class ScanBudget {
  readonly ms: number;
  private used = 0;
  private depth = 0;
  private since = 0;
  private spent = false;

  constructor(ms = readScanBudgetMs()) {
    this.ms = ms;
  }

  enter(): void {
    if (this.depth++ === 0) this.since = performance.now();
  }

  leave(): void {
    if (--this.depth === 0) this.used += performance.now() - this.since;
  }

  expired(): boolean {
    if (!this.spent) {
      const used = this.depth > 0 ? this.used + performance.now() - this.since : this.used;
      if (used > this.ms) this.spent = true;
    }
    return this.spent;
  }

  result(): DetectionResult {
    return {
      verdict: 'suspicious',
      confidence: 0.5,
      reasoning: `layer-0/1 screening did not finish within its ${this.ms} ms budget; the text was not fully scanned`,
      detectedPatterns: [BUDGET_PATTERN],
      layer: 1,
      l3Status: 'skipped_gate',
    };
  }
}

export function isBudgetResult(r: DetectionResult | undefined): boolean {
  return !!r && r.detectedPatterns.includes(BUDGET_PATTERN);
}

/// Runs of two or more whitespace characters become one (a newline if the run held one). U+FEFF
/// is whitespace to JS regexes but is a zero-width character to Layer 1, so it is kept.
export function collapseWhitespace(text: string): string {
  return text.replace(/[^\S﻿]{2,}/g, (m) => (m.includes('\n') ? '\n' : ' '));
}

/// The chunks Layer 1's bounded-span regexes run on. Text up to SCAN_CHUNK is one chunk, unchanged.
/// A later chunk is prefixed with "\u0001" plus the character before it: the real preceding
/// character keeps `\b` and `\n`-anchored matches exact at the cut, and the sentinel keeps `^`
/// from matching mid-text. A match in a chunk is therefore always a match in the full text.
export function scanChunks(text: string): string[] {
  if (text.length <= SCAN_CHUNK) return [text];
  const t = collapseWhitespace(text);
  if (t.length <= SCAN_CHUNK) return [t];
  const out: string[] = [];
  const stride = SCAN_CHUNK - SCAN_OVERLAP;
  for (let start = 0; start < t.length; start += stride) {
    const end = Math.min(start + SCAN_CHUNK, t.length);
    out.push(start === 0 ? t.slice(0, end) : '\u0001' + t.slice(start - 1, end));
    if (end === t.length) break;
  }
  return out;
}
