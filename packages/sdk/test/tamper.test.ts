import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodePublicInputs, labelMismatches, verifyOffchain, recomputeActionBinding, actionBindingReason, computeNullifier, hex, LABELED_FIELDS, type Attestation, type LabeledField } from '../src/index.js';

// Real attestations (SP1 Groth16 proofs produced by the prover) from the repo fixtures.
const load = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as Attestation;
const FIXTURES = {
  mainnet: load('../../../tests/fixtures/attestation-mainnet.json'),
  test: load('../../../tests/fixtures/attestation-test.json'),
  demo070: load('../../../tests/fixtures/attestation-mainnet-demo-0.7.0.json'),
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
/** The action binding of an untouched fixture: checked, recomputed = committed, nothing wrong. */
const boundAction = (att: Attestation) => ({ checked: true, actionHash: att.actionHash.toLowerCase(), nullifier: att.nullifier.toLowerCase(), mismatches: [] });
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
    expect(r).toEqual({ ok: true, decoded: expected(att), mismatches: [], action: boundAction(att) });
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
      expect(r.action).toEqual(boundAction(att)); // the action fields still hash to the committed actionHash
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
    // and the binding: the action fields hash to the real actionHash, not the altered one, and the
    // committed nullifier no longer derives from the altered actionHash
    expect(r.action?.mismatches).toEqual(['actionHash', 'nullifier']);
    expect(r.action?.actionHash).toBe(FIXTURES.mainnet.actionHash.toLowerCase());
  });
  it('a flipped nullifier nibble in the blob: the proof fails and the nullifier no longer derives from actionHash', async () => {
    const t = clone(FIXTURES.mainnet);
    t.publicInputs = [flipNibbleAt(t.publicInputs[0], 2 + 64 * 4)]; // first nibble of nullifier
    const r = await verifyOffchain(t);
    expect(r.ok).toBe(false);
    expect(r.reason).not.toMatch(/^label mismatch/);
    expect(r.mismatches).toEqual(['nullifier']);
    expect(r.action?.mismatches).toEqual(['nullifier']);
    expect(r.action?.nullifier).toBe(FIXTURES.mainnet.nullifier.toLowerCase());
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
    expect(r.action).toEqual(boundAction(FIXTURES.mainnet));
  });
  it('legacy tampered fixture (six-entry publicInputs) fails and yields no decoded blob', async () => {
    const r = await verifyOffchain(LEGACY_TAMPERED);
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(r.decoded).toBeUndefined();
    expect(r.mismatches).toEqual([]);
    expect(r.action).toBeUndefined();
  });
});

/* ── 0.7.1: the action fields are labels too; the proof commits to them only through actionHash ── */
const OTHER_KEY = '9H7xb7EXzwQ5RFmA2qWnNhML9geLjDFrZwhJYxCUVQzf';
type ActionField = keyof Attestation['action'];
const ACTION_TAMPERS: Record<ActionField, (v: string) => string> = {
  amount: (v) => String(BigInt(v) + 1n),
  recipient: () => OTHER_KEY,
  mint: (v) => (v ? '' : OTHER_KEY),
  sourceAuthority: () => OTHER_KEY,
  targetProgram: () => OTHER_KEY,
  instruction: (v) => flipLastNibble(v),
};
function tamperAction(att: Attestation, field: ActionField): Attestation {
  const t = clone(att);
  t.action[field] = ACTION_TAMPERS[field](att.action[field]);
  return t;
}

describe('verifyOffchain tamper suite — action fields (blob and labels untouched)', () => {
  for (const [name, att] of Object.entries(FIXTURES)) {
    it.each(Object.keys(ACTION_TAMPERS) as ActionField[])(`${name}: an edited action.%s fails with an action mismatch`, async (field) => {
      const t = tamperAction(att, field);
      const r = await verifyOffchain(t);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/^action mismatch: the action fields hash to 0x[0-9a-f]{64} but the proof commits to actionHash 0x[0-9a-f]{64}$/);
      expect(r.reason).toContain(`commits to actionHash ${att.actionHash.toLowerCase()}`);
      expect(r.mismatches).toEqual([]);                       // the six labels still match the blob
      expect(r.decoded).toEqual(expected(att));               // and the proof itself verified
      expect(r.action?.checked).toBe(true);
      expect(r.action?.mismatches).toEqual(['actionHash']);
      expect(r.action?.actionHash).not.toBe(att.actionHash.toLowerCase());
      expect(r.action?.nullifier).toBe(att.nullifier.toLowerCase()); // the committed nullifier does derive from the committed actionHash
    });
  }
  it('an edited nonce or chainId fails the same way', async () => {
    const att = FIXTURES.demo070;
    for (const t of [{ ...clone(att), nonce: flipLastNibble(att.nonce) }, { ...clone(att), chainId: 2 }]) {
      const r = await verifyOffchain(t);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/^action mismatch/);
      expect(r.action?.mismatches).toEqual(['actionHash']);
    }
  });
  it('a file with no action object is not bound (checked: false) and otherwise verifies', async () => {
    const { action: _a, ...noAction } = clone(FIXTURES.demo070);
    const r = await verifyOffchain(noAction as unknown as Attestation);
    expect(r.ok).toBe(true);
    expect(r.action).toEqual({ checked: false, mismatches: [] });
  });
  it('unusable action fields fail with the reason, not a throw', async () => {
    const att = FIXTURES.demo070;
    const cases: [Partial<Attestation> | { action: Partial<Attestation['action']> }, RegExp][] = [
      [{ nonce: '0x1234' }, /nonce must be 32 bytes of hex/],
      [{ chainId: 70000 }, /chainId must be a u16/],
      [{ action: { ...att.action, amount: '-1' } }, /amount must be a decimal u64/],
      [{ action: { ...att.action, amount: '18446744073709551616' } }, /amount must be a decimal u64/],
      [{ action: { ...att.action, recipient: 'not-base58!' } }, /recipient is not a valid public key/],
      [{ action: { ...att.action, instruction: '0x98' } }, /instruction must be 8 bytes of hex/],
    ];
    for (const [patch, re] of cases) {
      const r = await verifyOffchain({ ...clone(att), ...patch } as Attestation);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/^action fields unusable: /);
      expect(r.reason).toMatch(re);
      expect(r.action?.error).toMatch(re);
    }
  });
  it('recomputeActionBinding is pure: committed values drive it, labels do not; hex case is ignored', () => {
    const att = FIXTURES.demo070;
    const dec = decodePublicInputs(att.publicInputs[0]);
    const upper = { ...clone(att), nonce: att.nonce.toUpperCase(), action: { ...att.action, instruction: att.action.instruction.toUpperCase() } };
    expect(recomputeActionBinding(upper, dec)).toEqual(boundAction(att));
    // a tampered actionHash LABEL does not change the binding (it is recomputed against the blob)
    expect(recomputeActionBinding({ ...clone(att), actionHash: '0x' + '00'.repeat(32) } as Attestation, dec)).toEqual(boundAction(att));
    expect(actionBindingReason(boundAction(att), dec)).toBeNull();
    expect(actionBindingReason({ checked: false, mismatches: [] }, dec)).toBeNull();
    expect('0x' + computeNullifier(hex(att.actionHash)).toString('hex')).toBe(att.nullifier.toLowerCase());
  });
});
