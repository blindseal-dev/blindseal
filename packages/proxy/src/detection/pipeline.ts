import { runLayer1 } from './layer1-heuristics.js';
import { runLayer0, makeLayer0Result } from './layer0-decoder.js';
import { runLayer2 } from './layer2-embeddings.js';
import { runLayer3 } from './layer3-judge.js';
import { Layer3Unavailable } from './clients/types.js';
import type { JudgeContext } from './clients/types.js';
import type { DetectionResult } from './types.js';
import { runStreamingPipeline, readStreamThreshold } from './streaming.js';
import { emitDegradedWarningOnce, emitLayer2UnavailableNotice } from './degraded-state.js';
import { redact } from '@blindseal/redactor';

const L1_MALICIOUS_SHORT_CIRCUIT = 0.85;
const L2_DEFAULT_THRESHOLD = 0.35;
const L2_UNCERTAIN_MARGIN = 0.15;
// When L1 fired ONLY large-base64-blob and L2 confirms semantic distance > this value,
// the payload is almost certainly benign protocol-encoded data (Pub/Sub, SQS, encrypted
// blobs). Actual encoded attacks land at ~0.36 in L2 space (measured: h2-a12 = 0.3619)
// and are caught by L0 decode-then-L1 first. The 0.40 margin provides a safety buffer.
const BASE64_ONLY_BYPASS_DIST = 0.40;

function readL2Threshold(): number {
  const raw = process.env.BLINDSEAL_LAYER2_THRESHOLD;
  if (!raw) return L2_DEFAULT_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 2 ? n : L2_DEFAULT_THRESHOLD;
}

/// `modelText`: the text L2/L3 should see in place of `text`, when the caller can build a better
/// one before redaction. For structured content it is derived from an already key-redacted
/// object, since flattened key/value lines lose the JSON shape the key-based redactor needs.
/// L0/L1 always run on `text`; the model text is still passed through redact().
export interface PipelineOptions {
  modelText?: string;
}

export async function runPipeline(text: string, context?: JudgeContext, opts?: PipelineOptions): Promise<DetectionResult> {
  // Large payloads → streaming pipeline (chunked L2 with short-circuit). The streaming
  // function recursively calls back to runPipeline for sub-threshold inputs, so it's
  // safe to gate here.
  if (text.length >= readStreamThreshold()) {
    return runStreamingPipeline(text, context, undefined, opts);
  }

  // Layer 0: deterministic decode-then-L1. Catches encoded-payload attacks before L1
  // sees the raw text. Only fires when decoded content trips L1 — not on mere presence
  // of base64 or hex (which is common in benign tool responses).
  const l0 = runLayer0(text);
  if (l0.fired) return makeLayer0Result(l0);

  const l1 = runLayer1(text);

  // Layer 1 is confident this is malicious — done.
  if (l1.verdict === 'malicious' && l1.confidence >= L1_MALICIOUS_SHORT_CIRCUIT) {
    return { ...l1, layer: 1, l3Status: 'skipped_gate' };
  }

  // Redactor: strip secrets/PII before the model layers see the text, so
  // L2 (embeddings) and L3 (the LLM judge, possibly in a TEE or remote) never observe raw
  // credentials. L0/L1 above run on the raw text; L2/L3 below run on the redacted text.
  const redactedText = redact(opts?.modelText ?? text).redacted;

  // Layer 2.
  let l2: DetectionResult;
  try {
    l2 = await runLayer2(redactedText);
  } catch (err) {
    return layer2UnavailableFallback(l1, redactedText, err, context);
  }

  // Layer 2 is confident this is malicious (near-corpus match) — done. The "suspicious"
  // case is treated as needing L3 disambiguation to reduce false positives on content
  // that is semantically close to attack categories but actually benign (e.g. tool docs
  // that describe filesystem operations getting near-matched to exfiltration entries).
  if (l2.verdict === 'malicious') return { ...l2, l3Status: 'skipped_gate' };

  // Base64-only bypass: when L1 fired solely on large-base64-blob (no other pattern) and
  // L2 places the text far from the attack corpus (> 0.40), classify as clean without
  // calling L3. This handles benign protocol-encoded content (Pub/Sub data fields, SQS
  // bodies, encrypted payloads) that trips the base64 heuristic but has nothing in common
  // with known injection vocabulary. Actual encoded attacks are caught upstream by L0
  // (decoded text trips L1) or land at ≤ 0.40 in L2 space (measured: 0.3619 for h2-a12).
  const isBase64OnlyL1 =
    l1.verdict !== 'clean' &&
    l1.detectedPatterns.length === 1 &&
    l1.detectedPatterns[0] === 'large-base64-blob';
  if (isBase64OnlyL1 && (l2.distance ?? 0) > BASE64_ONLY_BYPASS_DIST) {
    return {
      verdict: 'clean',
      confidence: 0.7,
      reasoning: `layer-1 large-base64-blob only; layer-2 dist=${(l2.distance ?? 0).toFixed(3)} > ${BASE64_ONLY_BYPASS_DIST} — benign protocol encoding`,
      detectedPatterns: [],
      layer: 2,
      distance: l2.distance,
      l3Status: 'skipped_gate',
      bypassReason: 'base64_blob_only_high_l2_distance',
    };
  }

  // Decide whether to run L3. Trigger when L2 is suspicious OR L2 is clean-but-borderline.
  const threshold = readL2Threshold();
  const distance = l2.distance ?? Infinity;
  const isSuspicious = l2.verdict === 'suspicious';
  const inUncertainZone = distance < threshold + L2_UNCERTAIN_MARGIN;

  if (!isSuspicious && !inUncertainZone) {
    // Clearly clean. Don't waste an API call.
    if (l1.verdict !== 'clean') return { ...l1, layer: 1, l3Status: 'skipped_gate' };
    return { ...l2, l3Status: 'skipped_gate' };
  }

  // Run Layer 3 to disambiguate.
  try {
    const l3Result = await runLayer3(redactedText, context);
    return { ...l3Result, l3Status: 'ran' };
  } catch (err) {
    if (!(err instanceof Layer3Unavailable)) {
      process.stderr.write(
        `blindseal: layer-3 failed (${err instanceof Error ? err.message : String(err)}) — falling back to layer-2\n`,
      );
    } else {
      emitDegradedWarningOnce();
    }

    // L3 unavailable fallback. Default: keep 'suspicious' so block mode still catches it.
    // Operators who prefer the old FP-safe behaviour (suspicious→clean) set BLINDSEAL_L3_FP_SAFE=1.
    if (isSuspicious) {
      const fpSafe = process.env.BLINDSEAL_L3_FP_SAFE === '1';
      return {
        ...l2,
        verdict: fpSafe ? 'clean' : ('suspicious' as const),
        reasoning: fpSafe
          ? `${l2.reasoning} — demoted to clean: layer-3 unavailable (BLINDSEAL_L3_FP_SAFE=1)`
          : `${l2.reasoning} — layer-3 unavailable; suspicious verdict retained (set BLINDSEAL_L3_FP_SAFE=1 to demote)`,
        l3Status: 'unavailable',
      };
    }
    if (l1.verdict !== 'clean') return { ...l1, layer: 1, l3Status: 'unavailable' };
    return { ...l2, l3Status: 'unavailable' };
  }
}

/// Layer 2 threw at runtime (model failed to load, inference error). The decision is marked
/// `degraded: true` and a one-line notice goes to stderr. Layer 3, if configured, judges the
/// (redacted) text in L2's place; otherwise the Layer 1 verdict stands.
export async function layer2UnavailableFallback(
  l1: DetectionResult,
  redactedText: string,
  err: unknown,
  context?: JudgeContext,
): Promise<DetectionResult> {
  const why = err instanceof Error ? err.message : String(err);
  emitLayer2UnavailableNotice(why);
  try {
    const l3Result = await runLayer3(redactedText, context);
    return {
      ...l3Result,
      reasoning: `${l3Result.reasoning} (layer-2 unavailable: ${why}; judged by layer-3)`,
      l3Status: 'ran',
      degraded: true,
    };
  } catch (l3err) {
    if (!(l3err instanceof Layer3Unavailable)) {
      process.stderr.write(
        `blindseal: layer-3 failed (${l3err instanceof Error ? l3err.message : String(l3err)}) — layer-1 verdict stands\n`,
      );
    }
    return {
      ...l1,
      layer: 1,
      reasoning: `${l1.reasoning} (layer-2 unavailable: ${why})`,
      l3Status: l3err instanceof Layer3Unavailable ? 'unavailable' : 'skipped_gate',
      degraded: true,
    };
  }
}

/// Outbound screen for tool-call arguments (agent → server): Layer 0 + Layer 1 only, on the raw
/// text. No model layers: arguments are screened synchronously before forwarding. A lone
/// `large-base64-blob` hit is ignored here: file uploads and binary payloads are routinely
/// base64 in arguments, and Layer 0 has already decoded and screened any base64 it found.
export function runOutboundScreen(text: string): DetectionResult {
  const clean: DetectionResult = {
    verdict: 'clean',
    confidence: 0,
    reasoning: 'outbound: no layer-0/layer-1 patterns matched',
    detectedPatterns: [],
    layer: 1,
    l3Status: 'skipped_gate',
  };
  if (!text) return clean;
  const isBase64Only = (patterns: string[]) =>
    patterns.length > 0 && patterns.every((p) => p.endsWith('large-base64-blob'));
  const l0 = runLayer0(text);
  if (l0.fired && !isBase64Only(l0.l1Match?.detectedPatterns ?? [])) return makeLayer0Result(l0);
  const l1 = runLayer1(text);
  if (l1.verdict === 'clean' || isBase64Only(l1.detectedPatterns)) return clean;
  return { ...l1, layer: 1, l3Status: 'skipped_gate' };
}

export { warmupLayer2 } from './layer2-embeddings.js';
