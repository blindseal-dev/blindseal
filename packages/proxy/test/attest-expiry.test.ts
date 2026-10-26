import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { EXPIRY_WINDOW_SLOTS, expiryWarning, readLastProofSeconds, recordProofSeconds } from '../src/cli/attest.js';

describe('attest expiry window', () => {
  it('defaults to 40,000 slots (≈ 4.4 h)', () => { expect(EXPIRY_WINDOW_SLOTS).toBe(40_000); });
  it('does not warn without a recorded proof, or when the last proof fit in half the window', () => {
    expect(expiryWarning(undefined)).toBeUndefined();
    expect(expiryWarning(7_000)).toBeUndefined();          // 1.9 h < 2.2 h
  });
  it('warns when the last proof exceeded half the window', () => {
    const w = expiryWarning(8_200);                        // 2.3 h > 2.2 h
    expect(w).toMatch(/last proof on this machine took 2\.3 h/); expect(w).toMatch(/--expiry/);
  });
  it('records and reads the last proof time (0600 file under ~/.blindseal)', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'bs-')), 'prover-times.json');
    expect(readLastProofSeconds(f)).toBeUndefined();
    recordProofSeconds(8160.4, f); expect(readLastProofSeconds(f)).toBe(8160);
  });
});
