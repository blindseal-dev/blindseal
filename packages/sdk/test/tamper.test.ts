import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodePublicInputs, labelMismatches, verifyOffchain, LABELED_FIELDS, type Attestation, type LabeledField } from '../src/index.js';

// Real attestations (SP1 Groth16 proofs produced by the prover) from the repo fixtures.
const load = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as Attestation;
const FIXTURES = {
  mainnet: load('../../../tests/fixtures/attestation-mainnet.json'),
  test: load('../../../tests/fixtures/attestation-test.json'),
};
// Legacy-format fixture: six separate publicInputs entries and a 32-byte "proof" — must not verify.
const LEGACY_TAMPERED = load('../../../fixtures/attestation-tampered.json');

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const flipLastNibble = (h: string) => h.slice(0, -1) + (h.slice(-1) === '0' ? '1' : '0');
const flipNibbleAt = (h: string, i: number) => h.slice(0, i) + (h[i] === '0' ? '1' : '0') + h.slice(i + 1);
const expected = (att: Attestation) => ({
  payloadHash: att.payloadHash.toLowerCase(), policyRoot: att.policyRoot.toLowerCase(), detectorVersion: att.detectorVersion.toLowerCase(),
  actionHash: att.actionHash.toLowerCase(), nullifier: att.nullifier.toLowerCase(), expirySlot: String(att.expirySlot),
});
/** Tamper the LABEL only (blob untouched). */
function tamperLabel(att: Attestation, field: LabeledField): Attestation {
  const t = clone(att);
  if (field === 'expirySlot') t.expirySlot = att.expirySlot + 1;
  else t[field] = flipLastNibble(att[field]);
  return t;
}

describe('decodePublicInputs (168-byte blob: 5 × 32-byte fields ‖ u64 LE expirySlot)', () => {
  it.each(Object.entries(FIXTURES))('%s fixture decodes to its labeled fields', (_n, att) => {
    expect(decodePublicInputs(att.publicInputs[0])).toEqual(expected(att));
  });
  it('accepts 0X / upper-case hex and no prefix', () => {
    const blob = FIXTURES.mainnet.publicInputs[0];
    const dec = expected(FIXTURES.mainnet);
    expect(decodePublicInputs(blob.toUpperCase())).toEqual(dec);
    expect(decodePublicInputs(blob.slice(2))).toEqual(dec);
  });
  it('rejects anything that is not 168 bytes', () => {
    expect(() => decodePublicInputs(FIXTURES.mainnet.publicInputs[0].slice(0, -2))).toThrow(/168 bytes, got 167/);
    expect(() => decodePublicInputs(LEGACY_TAMPERED.publicInputs[0])).toThrow(/168 bytes, got 32/);
    expect(() => decodePublicInputs('0xzz')).toThrow(/not a hex string/);
  });
  it('labelMismatches is hex-case / 0x / expiry-type insensitive', () => {
    const att = FIXTURES.mainnet;
    const dec = decodePublicInputs(att.publicInputs[0]);
    expect(labelMismatches({ ...att, payloadHash: att.payloadHash.toUpperCase(), nullifier: att.nullifier.slice(2), expirySlot: String(att.expirySlot) as any }, dec)).toEqual([]);
    expect(labelMismatches({ ...att, expirySlot: BigInt(att.expirySlot) as any }, dec)).toEqual([]);
    expect(labelMismatches({ ...att, expirySlot: undefined as any }, dec)).toEqual(['expirySlot']);
  });
});

describe('verifyOffchain on the real fixtures', () => {
  it.each(Object.entries(FIXTURES))('%s: proof verifies and every label matches the blob', async (_n, att) => {
    const r = await verifyOffchain(att);
    expect(r).toEqual({ ok: true, decoded: expected(att), mismatches: [] });
  });
});

describe('verifyOffchain tamper suite — labels (blob untouched)', () => {
  for (const [name, att] of Object.entries(FIXTURES)) {
    it.each([...LABELED_FIELDS])(`${name}: tampered %s label fails with label mismatch`, async (field) => {
      const r = await verifyOffchain(tamperLabel(att, field));
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/^label mismatch:/);
      expect(r.reason).toBe(`label mismatch: ${field}`);
      expect(r.mismatches).toEqual([field]);
      expect(r.decoded).toEqual(expected(att)); // decoded reflects the proven blob, not the tampered label
    });
  }
  it('several tampered labels are all listed, in canonical order', async () => {
    const t = tamperLabel(tamperLabel(FIXTURES.mainnet, 'nullifier'), 'policyRoot');
    const r = await verifyOffchain(t);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('label mismatch: policyRoot, nullifier');
    expect(r.mismatches).toEqual(['policyRoot', 'nullifier']);
  });
});

describe('verifyOffchain tamper suite — proof and blob (wasm rejects)', () => {
  it('a flipped blob byte fails the Groth16 check (reason from the wasm, not a label mismatch)', async () => {
    const t = clone(FIXTURES.mainnet);
    t.publicInputs = [flipNibbleAt(t.publicInputs[0], 2 + 64 * 3)]; // first nibble of actionHash
    const r = await verifyOffchain(t);
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(r.reason).not.toMatch(/^label mismatch/);
    expect(r.decoded).toBeDefined();
    expect(r.mismatches).toEqual(['actionHash']); // the label now disagrees with the altered blob too
  });
  it('a flipped expiry byte in the blob fails the Groth16 check', async () => {
    const t = clone(FIXTURES.mainnet);
    t.publicInputs = [flipLastNibble(t.publicInputs[0])];
    const r = await verifyOffchain(t);
    expect(r.ok).toBe(false);
    expect(r.reason).not.toMatch(/^label mismatch/);
    expect(r.mismatches).toEqual(['expirySlot']);
  });
  it('a flipped proof nibble fails with labels intact', async () => {
    const t = clone(FIXTURES.mainnet);
    t.proof.bytes = flipLastNibble(t.proof.bytes);
    const r = await verifyOffchain(t);
    expect(r.ok).toBe(false);
    expect(r.reason).not.toMatch(/^label mismatch/);
    expect(r.decoded).toEqual(expected(FIXTURES.mainnet));
    expect(r.mismatches).toEqual([]);
  });
  it('legacy tampered fixture (six-entry publicInputs) fails and yields no decoded blob', async () => {
    const r = await verifyOffchain(LEGACY_TAMPERED);
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(r.decoded).toBeUndefined();
    expect(r.mismatches).toEqual([]);
  });
});
