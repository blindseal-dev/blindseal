import { loadCorpus, type LoadedCorpus } from '@blindseal/corpus';
import type { DetectionResult } from './types.js';
import { WorkerPool } from './worker-pool.js';

/// Layer 2 runs in its own worker thread (layer2-worker.ts): the embedding model's inference and
/// tokenisation would otherwise block the event loop for seconds on long or concurrent text. One
/// worker, so the model is loaded once. `runLayer2`/`warmupLayer2` are the entry points; the
/// *Here functions run inside the worker (or inline if no worker can start).
export type Layer2Op = { op: 'run'; text: string; threshold: number } | { op: 'warmup' };
export type Layer2Result = { result: DetectionResult } | { warmed: true };

const pool = new WorkerPool<Layer2Op, Layer2Result>('layer-2', 'layer2-worker', () => 1, runLayer2Op);

export async function runLayer2Op(req: Layer2Op): Promise<Layer2Result> {
  if (req.op === 'warmup') {
    await warmupLayer2Here();
    return { warmed: true };
  }
  return { result: await runLayer2Here(req.text, req.threshold) };
}

export async function runLayer2(text: string): Promise<DetectionResult> {
  if (!text || text.length === 0) {
    return { verdict: 'clean', confidence: 0, reasoning: 'empty text', detectedPatterns: [], layer: 2 };
  }
  // No deadline: Layer 2 is not part of the Layer 0/1 budget, and the first call may be loading
  // (or downloading) the model. The threshold is read here, where the operator set it.
  const r = await pool.submit({ op: 'run', text, threshold: readThreshold() }, Infinity);
  if (!('result' in r)) throw new Error('layer-2 worker: wrong reply');
  return r.result;
}

const MODEL_ID = 'Xenova/bge-small-en-v1.5';
// Threshold tuned for 200-entry corpus (Day 2 sprint).
// With 61 entries: empirical gap was attacks ≈0.21 vs benign ≈0.34+, so 0.35 worked.
// With 200 entries the corpus is 3× denser; attacks now land ≈0.15–0.20 while
// benign security-research text lands at 0.297–0.347 (measured on fp-probe fixtures).
// Lowering to 0.27 preserves attack detection while restoring clean verdicts for
// research abstracts, CVE advisories, and security-training content.
const DEFAULT_THRESHOLD = 0.27;

let extractorPromise: Promise<(text: string, opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array }>> | null = null;
let corpus: LoadedCorpus | null = null;
// After a failed model load, further calls fail fast with the same error for this long before
// the next load attempt, so an offline proxy does not retry a download on every tool call.
const LOAD_RETRY_MS = 30_000;
let lastLoadFailure: { at: number; err: unknown } | null = null;

function readThreshold(): number {
  const raw = process.env.BLINDSEAL_LAYER2_THRESHOLD;
  if (!raw) return DEFAULT_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 2 ? n : DEFAULT_THRESHOLD;
}

type Extractor = (text: string, opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array }>;

/// Model location knobs (all optional):
///   BLINDSEAL_MODEL_DIR      cache directory for the embedding model (default: the
///                            transformers.js cache inside its package directory)
///   BLINDSEAL_MODEL_HOST     base URL to download the model from (a mirror; default: the
///                            Hugging Face Hub)
///   BLINDSEAL_MODEL_OFFLINE  1 = never download; the model must already be in the cache
async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise && lastLoadFailure && Date.now() - lastLoadFailure.at < LOAD_RETRY_MS) {
    throw lastLoadFailure.err;
  }
  if (!extractorPromise) {
    const p = (async () => {
      const mod = await import('@xenova/transformers');
      // Pin to local cache; don't fetch on every invocation if already cached.
      mod.env.allowLocalModels = true;
      const dir = process.env.BLINDSEAL_MODEL_DIR;
      if (dir) {
        mod.env.cacheDir = dir;
        mod.env.localModelPath = dir;
      }
      const host = process.env.BLINDSEAL_MODEL_HOST;
      if (host) mod.env.remoteHost = host.endsWith('/') ? host : `${host}/`;
      const offline = process.env.BLINDSEAL_MODEL_OFFLINE;
      if (offline === '1' || offline === 'true') mod.env.allowRemoteModels = false;
      const extractor = await mod.pipeline('feature-extraction', MODEL_ID, { quantized: true });
      return extractor as unknown as Extractor;
    })();
    extractorPromise = p;
    // A failed load is retried (e.g. once the network is back), at most every LOAD_RETRY_MS.
    p.then(
      () => { lastLoadFailure = null; },
      (err: unknown) => {
        lastLoadFailure = { at: Date.now(), err };
        if (extractorPromise === p) extractorPromise = null;
      },
    );
  }
  return extractorPromise;
}

function getCorpus(): LoadedCorpus {
  if (!corpus) corpus = loadCorpus();
  return corpus;
}

function cosineDistanceNormalized(
  q: Float32Array,
  c: Float32Array,
  cOffset: number,
  dim: number,
): number {
  let dot = 0;
  for (let i = 0; i < dim; i++) {
    dot += q[i]! * c[cOffset + i]!;
  }
  return 1 - dot;
}

async function runLayer2Here(text: string, threshold: number): Promise<DetectionResult> {
  if (!text || text.length === 0) {
    return { verdict: 'clean', confidence: 0, reasoning: 'empty text', detectedPatterns: [], layer: 2 };
  }

  const extractor = await getExtractor();
  const out = await extractor(text, { pooling: 'mean', normalize: true });
  const q = out.data;

  const { meta, embeddings } = getCorpus();
  const { dim, count, items } = meta;

  let best = Infinity;
  let bestIdx = -1;
  for (let i = 0; i < count; i++) {
    const d = cosineDistanceNormalized(q, embeddings, i * dim, dim);
    if (d < best) {
      best = d;
      bestIdx = i;
    }
  }

  if (bestIdx < 0) {
    return { verdict: 'clean', confidence: 0, reasoning: 'empty corpus', detectedPatterns: [], layer: 2 };
  }

  const matched = items[bestIdx]!;
  if (best >= threshold) {
    return {
      verdict: 'clean',
      confidence: Math.max(0, 1 - best),
      reasoning: `layer-2 nearest ${matched.id} dist=${best.toFixed(3)} >= threshold ${threshold}`,
      detectedPatterns: [],
      distance: best,
      layer: 2,
    };
  }

  // FP-tuning rule (2026-05-19, measured): only call a match "malicious" outright when the
  // embedding distance is small enough that we can be confident. Borderline matches (e.g. tool
  // documentation that describes filesystem operations near-matching exfiltration corpus entries)
  // return "suspicious" so the pipeline can escalate to Layer 3 — which is the only thing that can
  // reliably tell "describing X" from "instructing the agent to do X". Threshold chosen from
  // distance-probe data: paraphrased real attacks land ~0.21, real FPs land ~0.34.
  const CONFIDENT_MATCH_DIST = 0.25;
  const verdict =
    matched.severity === 'high' && best < CONFIDENT_MATCH_DIST ? 'malicious' : 'suspicious';
  const confidence = Math.min(0.95, 1 - best / threshold);

  return {
    verdict,
    confidence,
    reasoning: `layer-2 matched corpus ${matched.id} (${matched.category}) dist=${best.toFixed(3)} < threshold ${threshold}`,
    detectedPatterns: [`corpus:${matched.id}:${matched.category}`],
    matchedId: matched.id,
    matchedCategory: matched.category,
    distance: best,
    layer: 2,
  };
}

/// Loads the model and corpus (in the Layer 2 worker) and runs one probe embedding, so a model
/// that loads but cannot run (corrupt weights, wrong dimension) fails here rather than on the
/// first tool call.
export async function warmupLayer2(): Promise<void> {
  await pool.submit({ op: 'warmup' }, Infinity);
}

async function warmupLayer2Here(): Promise<void> {
  const extractor = await getExtractor();
  const { meta } = getCorpus();
  const out = await extractor('blindseal layer-2 warmup probe', { pooling: 'mean', normalize: true });
  if (!out?.data || out.data.length !== meta.dim) {
    throw new Error(
      `embedding model produced ${out?.data?.length ?? 0} dims, corpus expects ${meta.dim}`,
    );
  }
}
