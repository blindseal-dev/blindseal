// Audit finding #2 (0.7.0): what L2 (embeddings) and L3 (the judge) receive must already be
// redacted by KEY for structured JSON — including the streaming path for large payloads.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const seen: { l2: string[]; l3: string[] } = { l2: [], l3: [] };
let l2Throws = false;

vi.mock('../src/detection/layer2-embeddings.js', () => ({
  runLayer2: vi.fn(async (text: string) => {
    if (l2Throws) throw new Error('model failed to load');
    seen.l2.push(text);
    // suspicious → forces L3 in both the whole-text and the streaming pipeline
    return { verdict: 'suspicious', confidence: 0.6, reasoning: 'mock l2', detectedPatterns: [], layer: 2, distance: 0.3 };
  }),
  warmupLayer2: vi.fn(async () => undefined),
}));

import { runPipeline } from '../src/detection/pipeline.js';
import { runStreamingPipeline } from '../src/detection/streaming.js';
import { _setClientForTesting, _resetClientForTesting } from '../src/detection/layer3-judge.js';
import { redact } from '@blindseal/redactor';

const CANARY = 'Qz7'; // short: no value pattern (api_key, high_entropy, …) can catch it

beforeEach(() => {
  l2Throws = false;
  seen.l2 = [];
  seen.l3 = [];
  _setClientForTesting({
    providerName: 'fake',
    modelName: 'fake',
    async judge(content: string) {
      seen.l3.push(content);
      return { verdict: 'clean', confidence: 0.9, reasoning: 'ok', detected_patterns: [] };
    },
  });
});
afterEach(() => _resetClientForTesting());

describe('L2/L3 inputs are redacted by key (audit #2)', () => {
  it('whole-text pipeline: {"token":"Qz7"} never reaches L2 or L3', async () => {
    const text = JSON.stringify({ user: 'bob', token: CANARY, note: 'weather report for tuesday' });
    await runPipeline(text);
    expect(seen.l2.length).toBeGreaterThan(0);
    expect(seen.l3.length).toBeGreaterThan(0);
    for (const t of [...seen.l2, ...seen.l3]) expect(t).not.toContain(CANARY);
  });

  it('streaming pipeline (large payload): L2 chunks and L3 never see the secret value', async () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({ id: i, city: 'Lisbon', temp: 20 + (i % 7) }));
    const text = JSON.stringify({ rows, password: CANARY, api_key: 'sk-ant-' + 'a1B2'.repeat(8) });
    expect(text.length).toBeGreaterThan(8192);
    await runStreamingPipeline(text, undefined, 8192);
    expect(seen.l2.length).toBeGreaterThan(1);
    expect(seen.l3.length).toBe(1);
    for (const t of [...seen.l2, ...seen.l3]) {
      expect(t).not.toContain(CANARY);
      expect(t).not.toContain('sk-ant-');
    }
  });

  // 0.7.0 merge: the screening branch's degraded fallback (L2 throws mid-stream → L3 judges the
  // full text) and the privacy branch's redact-before-L2/L3 both touch the streaming path. The
  // judge must get exactly one redaction pass of the raw text — never the raw text, and never a
  // second pass over already-redacted placeholders.
  it('streaming pipeline, L2 unavailable: L3 gets redact(raw) exactly once', async () => {
    l2Throws = true;
    const rows = Array.from({ length: 400 }, (_, i) => ({ id: i, city: 'Lisbon', temp: 20 + (i % 7) }));
    const text = JSON.stringify({ rows, password: CANARY, api_key: 'sk-ant-' + 'a1B2'.repeat(8) });
    const r = await runStreamingPipeline(text, undefined, 8192);
    expect(r.degraded).toBe(true);
    expect(seen.l3).toEqual([redact(text).redacted]);
    expect(seen.l3[0]).not.toContain(CANARY);
  });
});
