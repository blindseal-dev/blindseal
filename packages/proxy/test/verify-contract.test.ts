import { describe, it, expect, vi } from 'vitest';

// verifyOffchain's contract: { ok, reason?, decoded, mismatches }. Stub it to exercise the
// mismatch rendering independently of the wasm verifier and of which sdk build is linked.
vi.mock('blindseal-sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('blindseal-sdk')>();
  return {
    ...real,
    verifyOffchain: vi.fn(async () => ({
      ok: false,
      reason: 'label mismatch: nullifier, expirySlot',
      decoded: { payloadHash: '0xaa', policyRoot: '0xbb', detectorVersion: '0xcc', actionHash: '0xdd', nullifier: '0xee', expirySlot: '42' },
      mismatches: ['nullifier', 'expirySlot'],
    })),
  };
});

import { verifyAttestationFile } from '../src/cli/verify.js';

describe('blindseal verify — label mismatch contract', () => {
  it('fails, prints the decoded fields, and names each differing label with both values', async () => {
    const att = {
      version: 1, chainId: 1, payloadHash: '0xaa', policyRoot: '0xbb', detectorVersion: '0xcc', actionHash: '0xdd',
      nullifier: '0xff', expirySlot: 99, nonce: '0x00', action: { targetProgram: '', sourceAuthority: '', instruction: '0x', recipient: '', mint: '', amount: '0' },
      publicInputs: ['0x'] as [string], proof: { protocol: 'groth16' as const, curve: 'bn254' as const, bytes: '0x' },
    };
    const r = await verifyAttestationFile('x.json', att);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('attestation x.json: INVALID — label mismatch: nullifier, expirySlot');
    expect(r.text).toContain('nullifier        0xee');
    expect(r.text).toContain('expirySlot       42');
    expect(r.text).toContain('label mismatch (2): nullifier, expirySlot');
    expect(r.text).toContain('nullifier: labeled 0xff ≠ decoded 0xee');
    expect(r.text).toContain('expirySlot: labeled 99 ≠ decoded 42');
    // an sdk build without the 0.7.1 action binding: reported, never assumed
    expect(r.action).toBeUndefined();
    expect(r.text).toContain('action binding   not checked (this sdk build does not recompute it)');
  });
});
