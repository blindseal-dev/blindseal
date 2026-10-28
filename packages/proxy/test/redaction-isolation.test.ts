// Release 0.7.0: personal-data redaction applies ONLY to what L2/L3 see. The payload the prover
// hashes and the action it binds always come from the original tool call. A recipient value that
// also sits under an `address` key is hidden from the judge but still bound by the attestation.
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const seen: { l3: string[] } = { l3: [] };
vi.mock('../src/detection/layer2-embeddings.js', () => ({
  runLayer2: vi.fn(async () => ({ verdict: 'suspicious', confidence: 0.6, reasoning: 'mock l2', detectedPatterns: [], layer: 2, distance: 0.3 })),
  warmupLayer2: vi.fn(async () => undefined),
}));

import { runPipeline } from '../src/detection/pipeline.js';
import { _setClientForTesting, _resetClientForTesting } from '../src/detection/layer3-judge.js';
import { runAttestCli } from '../src/cli/attest.js';

const SRC = 'Zv5PpLYUkScw7BUCbPhREpDXbdkJ21qMpsu54vYr1E4';
const DST = '7yWHC82fn96N6XTJBXdwkSBQHtLZZJTjr4SxXtGLQM24';
const call = { toolName: 'transfer_sol', args: { to: DST, lamports: 1000000, from: SRC, beneficiary: { name: 'Alice Smith', address: DST } } };

beforeEach(() => {
  seen.l3 = [];
  _setClientForTesting({ providerName: 'fake', modelName: 'fake', async judge(content: string) { seen.l3.push(content); return { verdict: 'clean', confidence: 0.9, reasoning: 'ok', detected_patterns: [] }; } });
});
afterEach(() => _resetClientForTesting());

describe('redaction never changes what is hashed or bound', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-iso-'));
  const kept = path.join(dir, 'payload-seen-by-prover.json');
  const argvFile = path.join(dir, 'argv');
  const prover = path.join(dir, 'stub-prover.sh');
  const home = process.env.HOME;
  beforeAll(() => {
    // the stub prover keeps a copy of the payload file it was given and its argv
    writeFileSync(prover, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\nwhile [ $# -gt 0 ]; do [ "$1" = --payload ] && cp "$2" '${kept}'; shift; done\n`);
    chmodSync(prover, 0o755);
    process.env.HOME = dir;
  });
  afterAll(() => { process.env.HOME = home; });

  it('the judge sees [REDACTED] for the address and the name', async () => {
    await runPipeline(JSON.stringify(call.args));
    expect(seen.l3.length).toBeGreaterThan(0);
    const l3 = seen.l3.join('\n');
    expect(l3).not.toContain('Alice Smith');
    expect(l3).toContain('[REDACTED:personal_field');
    // the address value is hidden where it sits under `address` (the `to` field is not a personal key)
    expect(l3).toMatch(/"address":\s*"\[REDACTED:personal_field:\d\]"/);
  });

  it('the attestation still binds the real recipient and hashes the original payload', async () => {
    const f = path.join(dir, 'call.json');
    writeFileSync(f, JSON.stringify(call));
    const code = await runAttestCli([f, '--out', path.join(dir, 'att.json'), '--no-expiry', '--prover', prover, '--audit-dir', path.join(dir, 'audit')]);
    expect(code).toBe(0);
    const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
    expect(argv[argv.indexOf('--recipient') + 1]).toBe(DST);
    expect(existsSync(kept)).toBe(true);
    const payload = readFileSync(kept, 'utf8');
    expect(payload).toContain('Alice Smith');           // original, unredacted
    expect(payload).toContain(`"address":"${DST}"`);
    expect(payload).not.toContain('REDACTED');
    expect(createHash('sha256').update(payload).digest('hex')).toMatch(/^[0-9a-f]{64}$/);
  });
});
