/// The CPU-bound screening steps, as messages: run in the scan worker (scan-worker.ts), or inline
/// when no worker could be started (scan-pool.ts says so on stderr). Pure functions of their input.

import { redact, redactStructure, redactValue } from '@blindseal/redactor';
import { screenLayer0, makeLayer0Result, type L0Result } from './layer0-decoder.js';
import { screenLayer1 } from './layer1-heuristics.js';
import { ScanBudget } from './scan-budget.js';
import { rankVerdict, type DetectionResult } from './types.js';
import { decodeBlob, type BlobDecode } from '../transports/blob-decode.js';
import { parseJson, stableStringify, jsonStringLeaves, withoutScreened } from '../transports/json-tools.js';

export type ScanOp =
  /// Layer 0 then Layer 1 on `text`, within `ms`. Layer 1 is skipped only when Layer 0 fired on
  /// more than the base64-blob heuristic (callers then use Layer 0's result).
  | { op: 'scan'; text: string; ms: number }
  /// The outbound verdict (outboundVerdict) of each text; the worst one, stopping at the first
  /// malicious or once the allowance runs out.
  | { op: 'outbound-each'; texts: string[]; ms: number }
  /// redact(text).redacted
  | { op: 'redact'; text: string }
  /// redactValue(parseJson(json)).redacted: a structured value (tool-call arguments) by key and value.
  | { op: 'redact-value'; json: string }
  /// The key-redacted model forms of a JSON value: strings in `skip` (screened on their own)
  /// become a marker. Returns its stable JSON and its joined string leaves.
  | { op: 'model-forms'; json: string; skip: string[] }
  /// decodeBlob(value, media)
  | { op: 'blob'; value: string; media?: { type: 'image' | 'audio'; mimeType: unknown }; mimeType?: unknown };


export type ScanResult =
  | { op: 'scan'; l0: L0Result; l1: DetectionResult | null; usedMs: number }
  | { op: 'outbound-each'; result: DetectionResult; usedMs: number }
  | { op: 'redact'; redacted: string }
  | { op: 'redact-value'; redacted: string }
  | { op: 'model-forms'; json: string; leaves: string }
  | { op: 'blob'; decoded: BlobDecode };


export function runScanOp(req: ScanOp): ScanResult {
  switch (req.op) {
    case 'scan': {
      const budget = new ScanBudget(req.ms);
      const l0 = screenLayer0(req.text, budget);
      const decisive = l0.fired && !(l0.l1Match?.detectedPatterns ?? []).every((p) => p.endsWith('large-base64-blob'));
      const l1 = decisive ? null : screenLayer1(req.text, budget);
      return { op: 'scan', l0, l1, usedMs: budget.usedMs() };
    }
    case 'outbound-each': {
      const budget = new ScanBudget(req.ms);
      let worst = outboundClean();
      for (const t of req.texts) {
        if (!t) continue;
        const r = outboundVerdict(screenLayer0(t, budget), () => screenLayer1(t, budget));
        if (rankVerdict(r.verdict) > rankVerdict(worst.verdict)) worst = r;
        if (worst.verdict === 'malicious' || budget.expired()) break;
      }
      if (budget.expired() && worst.verdict !== 'malicious') worst = budget.result();
      return { op: 'outbound-each', result: worst, usedMs: budget.usedMs() };
    }
    case 'redact':
      return { op: 'redact', redacted: redact(req.text).redacted };
    case 'redact-value':
      return { op: 'redact-value', redacted: redactValue(parseJson(req.json)).redacted };
    case 'model-forms': {
      const redacted = withoutScreened(redactStructure(parseJson(req.json)).value, new Set(req.skip));
      return { op: 'model-forms', json: stableStringify(redacted), leaves: jsonStringLeaves(redacted) };
    }
    case 'blob':
      return { op: 'blob', decoded: decodeBlob(req.value, req.media, undefined, req.mimeType) };
  }
}


export function outboundVerdict(l0: L0Result, l1Of: () => DetectionResult): DetectionResult {
  const isBase64Only = (patterns: string[]) =>
    patterns.length > 0 && patterns.every((p) => p.endsWith('large-base64-blob'));
  if (l0.fired && !isBase64Only(l0.l1Match?.detectedPatterns ?? [])) return makeLayer0Result(l0);
  // Layer 0 did not fire, or only on a base64 blob: Layer 1 decides on the raw text.
  const l1 = l1Of();
  if (l1.verdict === 'clean' || isBase64Only(l1.detectedPatterns)) return outboundClean();
  return { ...l1, layer: 1, l3Status: 'skipped_gate' };
}

export function outboundClean(): DetectionResult {
  return {
    verdict: 'clean',
    confidence: 0,
    reasoning: 'outbound: no layer-0/layer-1 patterns matched',
    detectedPatterns: [],
    layer: 1,
    l3Status: 'skipped_gate',
  };
}
