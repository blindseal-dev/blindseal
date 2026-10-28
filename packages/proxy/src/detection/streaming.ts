/// Streaming detection pipeline for large tool responses.
///
/// The non-streaming pipeline runs L2 (a ~10ms embedding) on the entire response. For an
/// 850KB scraped-page response that is benign, this is fine. For an 850KB response with a
/// malicious payload at byte 800,000, the operator pays the same fixed cost even though
/// we could have answered "clean" / "malicious" earlier. The streaming pipeline chunks
/// the response into windows with overlap so injections that span chunk boundaries are still
/// detected, runs L1 once on the full payload, and L2 per chunk — short-circuiting on the
/// first malicious chunk verdict.
///
/// Known limitation: mean-pooled embeddings dilute small attacks. A 150-character
/// paraphrased injection buried inside a 4KB chunk of unrelated text has its semantic
/// signal averaged with the filler — distance to the corpus rises above threshold and L2
/// returns clean. L1 (regex) still catches explicit injections at any size, and L3 (if
/// configured) still runs on the full payload when any chunk was borderline. For maximum
/// recall on paraphrased attacks in noisy contexts, operators should configure L3
/// (BLINDSEAL_LAYER3_PROVIDER) or set BLINDSEAL_STREAM_THRESHOLD very high to keep using the whole-text
/// pipeline. Sentence-level chunking is on the v2 roadmap.
///
/// Sizes are tuned against the embedder context (bge-small ~512 tokens ≈ 2KB English):
///   WINDOW_BYTES = 4096   — one window fits comfortably; bigger gets truncated
///   OVERLAP_BYTES = 512   — sliding window, catches patterns that straddle chunk boundaries
///   THRESHOLD_BYTES = 8192 (env: BLINDSEAL_STREAM_THRESHOLD) — below this we just call runPipeline

import { runLayer1 } from './layer1-heuristics.js';
import { runLayer2 } from './layer2-embeddings.js';
import { runLayer3 } from './layer3-judge.js';
import { Layer3Unavailable } from './clients/types.js';
import type { JudgeContext } from './clients/types.js';
import type { DetectionResult } from './types.js';
import type { PipelineOptions } from './pipeline.js';
import { emitDegradedWarningOnce } from './degraded-state.js';
import { redact } from '@blindseal/redactor';
import { runLayer0, makeLayer0Result } from './layer0-decoder.js';
import { ScanBudget, isBudgetResult } from './scan-budget.js';

const L1_MALICIOUS_SHORT_CIRCUIT = 0.85;
export const DEFAULT_STREAM_THRESHOLD = 8 * 1024;
export const WINDOW_BYTES = 4 * 1024;
export const OVERLAP_BYTES = 512;

export function readStreamThreshold(): number {
  const raw = process.env.BLINDSEAL_STREAM_THRESHOLD;
  if (!raw) return DEFAULT_STREAM_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_STREAM_THRESHOLD;
}

/// Splits `text` into chunks of `windowSize` characters with `overlap` characters
/// between consecutive chunks. The last chunk may be shorter than windowSize.
///
/// Length semantics: we chunk by JS string length (UTF-16 code units), which is what
/// the embedder sees. Byte length is approximately equal for ASCII; for heavy CJK / emoji
/// text the actual byte count would be larger but the embedder still operates on the
/// JS string, so this is the right unit.
export function chunkText(text: string, windowSize = WINDOW_BYTES, overlap = OVERLAP_BYTES): string[] {
  if (windowSize <= 0) throw new Error('windowSize must be > 0');
  if (overlap < 0 || overlap >= windowSize) throw new Error('overlap must be in [0, windowSize)');
  if (text.length === 0) return [];
  if (text.length <= windowSize) return [text];

  const stride = windowSize - overlap;
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += stride) {
    const end = Math.min(start + windowSize, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
  }
  return chunks;
}

/// Streaming variant of runPipeline. For inputs below the threshold, falls back to the
/// regular pipeline. For larger inputs:
///   1. L0 and L1 on the FULL text (bounded chunks under the scan budget)
///   2. L2 per chunk, short-circuit on first malicious
///   3. L3 on the FULL text iff at least one chunk was "suspicious"
export async function runStreamingPipeline(
  text: string,
  context?: JudgeContext,
  threshold = readStreamThreshold(),
  opts?: PipelineOptions,
): Promise<DetectionResult & { streamingChunks?: number }> {
  if (text.length < threshold) {
    // Below threshold — non-streaming pipeline is more accurate (L1 + L2 on full text +
    // L3 logic). The streaming path is purely a perf / short-circuit optimization for
    // larger payloads.
    const { runPipeline } = await import('./pipeline.js');
    return runPipeline(text, context, opts);
  }

  // Layer 0 and Layer 1 on the full text (both scan it in bounded chunks under the budget), exactly
  // as the whole-text pipeline does: a long text is never exempt from either.
  const budget = opts?.budget ?? new ScanBudget();
  const l0 = runLayer0(text, budget);
  if (l0.fired) return makeLayer0Result(l0);
  const l1 = runLayer1(text, budget);
  if (isBudgetResult(l1)) return l1;
  if (l1.verdict === 'malicious' && l1.confidence >= L1_MALICIOUS_SHORT_CIRCUIT) {
    return { ...l1, layer: 1 };
  }

  // Redact before the model layers, exactly as the whole-text pipeline does: L2 chunks and L3
  // see the redacted text; L1 above ran on the raw text.
  const redactedText = redact(opts?.modelText ?? text).redacted;
  const chunks = chunkText(redactedText);
  let worstSuspicious: (DetectionResult & { chunkIndex: number }) | null = null;
  let chunksProcessed = 0;

  for (let i = 0; i < chunks.length; i++) {
    let l2: DetectionResult;
    try {
      l2 = await runLayer2(chunks[i]!);
    } catch (err) {
      // L2 broke (model load failure, inference error) — degraded: L3 on the full text if
      // configured, else the L1 verdict on the full text.
      const { layer2UnavailableFallback } = await import('./pipeline.js');
      const r = await layer2UnavailableFallback(l1, redactedText, err, context);
      return { ...r, streamingChunks: chunksProcessed };
    }
    chunksProcessed++;

    if (l2.verdict === 'malicious') {
      return {
        ...l2,
        layer: 2,
        reasoning: `${l2.reasoning} (streaming chunk ${i + 1}/${chunks.length})`,
        streamingChunks: chunksProcessed,
      };
    }
    if (l2.verdict === 'suspicious') {
      const candidate = { ...l2, chunkIndex: i };
      if (
        !worstSuspicious ||
        (candidate.distance ?? Infinity) < (worstSuspicious.distance ?? Infinity)
      ) {
        worstSuspicious = candidate;
      }
    }
  }

  // No malicious chunks. If any chunk was "suspicious", optionally escalate to L3 on
  // the full text. Otherwise the whole thing is clean.
  if (worstSuspicious) {
    try {
      const l3 = await runLayer3(redactedText, context);
      return { ...l3, l3Status: 'ran', streamingChunks: chunksProcessed };
    } catch (err) {
      if (!(err instanceof Layer3Unavailable)) {
        process.stderr.write(
          `blindseal: layer-3 failed during streaming (${err instanceof Error ? err.message : String(err)}) — falling back\n`,
        );
      } else {
        emitDegradedWarningOnce();
      }
      const fpSafe = process.env.BLINDSEAL_L3_FP_SAFE === '1';
      const { chunkIndex: _ix, ...rest } = worstSuspicious;
      return {
        ...rest,
        verdict: fpSafe ? 'clean' : ('suspicious' as const),
        reasoning: fpSafe
          ? `${rest.reasoning} — demoted to clean: layer-3 unavailable (BLINDSEAL_L3_FP_SAFE=1) (streaming)`
          : `${rest.reasoning} — layer-3 unavailable; suspicious retained (streaming)`,
        l3Status: 'unavailable',
        streamingChunks: chunksProcessed,
      };
    }
  }

  // All chunks clean. If L1 caught something low-confidence, surface it; else clean.
  if (l1.verdict !== 'clean') {
    return { ...l1, layer: 1, streamingChunks: chunksProcessed };
  }
  return {
    verdict: 'clean',
    confidence: 0,
    reasoning: `streaming pipeline: all ${chunksProcessed} chunks clean`,
    detectedPatterns: [],
    layer: 2,
    streamingChunks: chunksProcessed,
  };
}
