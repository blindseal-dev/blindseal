import { describe, it, expect } from 'vitest';
import { splitPublicInputs } from '../src/api/publicInputs';
// The real Groth16 attestation (length-1 blob) the verifier accepts — the mock /attestations/sample
// serves this exact object. Decoding its publicInputs[0] must reproduce the six named fields.
import real from '../../../fixtures/attestation-sample.json';

describe('splitPublicInputs', () => {
  it('decodes a real single-blob commitment into the six labelled fields', () => {
    const fields = splitPublicInputs(real.publicInputs);
    expect(fields.map((f) => f.label)).toEqual([
      'payloadHash', 'policyRoot', 'detectorVersion', 'actionHash', 'nullifier', 'expirySlot',
    ]);
    // Each 32-byte slice equals the matching top-level field.
    expect(fields[0].value).toBe(real.payloadHash);
    expect(fields[1].value).toBe(real.policyRoot);
    expect(fields[2].value).toBe(real.detectorVersion);
    expect(fields[3].value).toBe(real.actionHash);
    expect(fields[4].value).toBe(real.nullifier);
    // The 8-byte little-endian tail decodes to expirySlot, rendered as a plain number (not a hash).
    expect(fields[5].value).toBe(String(real.expirySlot));
    expect(fields[5].hash).toBe(false);
    expect(fields.slice(0, 5).every((f) => f.hash)).toBe(true);
  });

  it('passes an already-decoded 6-element array through unchanged', () => {
    const arr = ['0xa', '0xb', '0xc', '0xd', '0xe', '0x10b38340'];
    const fields = splitPublicInputs(arr);
    expect(fields.map((f) => f.value)).toEqual(arr);
    expect(fields[5].label).toBe('expirySlot');
    expect(fields[5].hash).toBe(false);
  });

  it('is safe on missing/empty input', () => {
    expect(splitPublicInputs(undefined)).toEqual([]);
    expect(splitPublicInputs([])).toEqual([]);
  });
});
