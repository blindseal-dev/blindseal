/// Three Blindseal variants competing against external classifiers.
/// - blindseal-full: full pipeline (L1 + L2, plus L3 if a key is configured)
/// - blindseal-l1: regex-only baseline
/// - blindseal-l2: bge-small embedding-only baseline

import { runLayer1 } from '../../../proxy/src/detection/layer1-heuristics.js';
import { runLayer2, warmupLayer2 } from '../../../proxy/src/detection/layer2-embeddings.js';
import { runPipeline } from '../../../proxy/src/detection/pipeline.js';
import type { Competitor, ClassifyResult } from './types.js';

function nonClean(verdict: string): boolean {
  return verdict === 'suspicious' || verdict === 'malicious';
}

async function timed<T>(fn: () => Promise<T> | T): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t0 };
}

export const blindsealFull: Competitor = {
  name: 'blindseal-full',
  async ready() {
    await warmupLayer2();
    return { ok: true };
  },
  async classify(text: string): Promise<ClassifyResult> {
    const { value: result, ms } = await timed(() =>
      runPipeline(text, { toolName: 'read_file', mcpMethod: 'tools/call' }),
    );
    return {
      flagged: nonClean(result.verdict),
      confidence: result.confidence,
      latencyMs: ms,
      rawLabels: result.detectedPatterns,
    };
  },
};

export const blindsealL1: Competitor = {
  name: 'blindseal-l1',
  async ready() {
    return { ok: true };
  },
  async classify(text: string): Promise<ClassifyResult> {
    const { value: result, ms } = await timed(() => runLayer1(text));
    return {
      flagged: nonClean(result.verdict),
      confidence: result.confidence,
      latencyMs: ms,
      rawLabels: result.detectedPatterns,
    };
  },
};

export const blindsealL2: Competitor = {
  name: 'blindseal-l2',
  async ready() {
    await warmupLayer2();
    return { ok: true };
  },
  async classify(text: string): Promise<ClassifyResult> {
    const { value: result, ms } = await timed(() => runLayer2(text));
    return {
      flagged: nonClean(result.verdict),
      confidence: result.confidence,
      latencyMs: ms,
      rawLabels: result.matchedId ? [`${result.matchedCategory}:${result.matchedId}`] : [],
    };
  },
};
