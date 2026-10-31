import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePublicInputs, type Attestation } from 'blindseal-sdk';
import { verifyAttestationFile, formatDecoded, formatActionBinding, DECODED_LABELS } from '../src/cli/verify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAINNET = path.resolve(here, '../../../tests/fixtures/attestation-mainnet.json');

const FIX = JSON.parse(readFileSync(new URL('../../../tests/fixtures/attestation-mainnet.json', import.meta.url), 'utf8')) as { expirySlot: number };

describe('blindseal verify — attestation report', () => {
  it('prints VALID and every decoded public-input field for the mainnet fixture', async () => {
    const att = JSON.parse(readFileSync(MAINNET, 'utf8')) as Attestation;
    const r = await verifyAttestationFile(MAINNET, att);
    expect(r.ok).toBe(true);
    expect(r.mismatches).toEqual([]);
    expect(r.text).toMatch(/^attestation .*attestation-mainnet\.json: VALID\n/);
    const blob = decodePublicInputs(att.publicInputs[0]);
    for (const k of DECODED_LABELS) {
      expect(r.decoded[k]).toBe(String(blob[k]));
      expect(r.text).toContain(`${k}`);
      expect(r.text).toContain(String(blob[k]));
    }
    expect(r.text).toContain(`expirySlot       ${FIX.expirySlot}`);
    expect(r.action).toEqual({ checked: true, actionHash: att.actionHash, nullifier: att.nullifier, mismatches: [] });
    expect(r.text).toContain('action binding   ok: action fields + nonce hash to the committed actionHash');
  }, 30_000);

  // 0.7.1: the action fields are labels the proof commits to only through actionHash
  const ACTION_EDITS: Record<string, (a: Attestation['action']) => Partial<Attestation['action']>> = {
    amount: (a) => ({ amount: String(BigInt(a.amount) + 1n) }),
    recipient: () => ({ recipient: 'Zv5PpLYUkScw7BUCbPhREpDXbdkJ21qMpsu54vYr1E4' }),
    mint: () => ({ mint: 'Zv5PpLYUkScw7BUCbPhREpDXbdkJ21qMpsu54vYr1E4' }),
    sourceAuthority: () => ({ sourceAuthority: 'Zv5PpLYUkScw7BUCbPhREpDXbdkJ21qMpsu54vYr1E4' }),
    targetProgram: () => ({ targetProgram: 'Zv5PpLYUkScw7BUCbPhREpDXbdkJ21qMpsu54vYr1E4' }),
  };
  for (const [field, edit] of Object.entries(ACTION_EDITS)) {
    it(`an edited action.${field} is INVALID with the recomputed and committed action hashes shown`, async () => {
      const att = JSON.parse(readFileSync(MAINNET, 'utf8')) as Attestation;
      const tampered: Attestation = { ...att, action: { ...att.action, ...edit(att.action) } };
      const r = await verifyAttestationFile('edited.json', tampered);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/^action mismatch: the action fields hash to 0x[0-9a-f]{64} but the proof commits to actionHash /);
      expect(r.mismatches).toEqual([]);          // the six labels are intact
      expect(r.action?.mismatches).toEqual(['actionHash']);
      expect(r.text).toMatch(/^attestation edited\.json: INVALID — action mismatch: /);
      expect(r.text).toContain('action binding   MISMATCH');
      expect(r.text).toContain(`actionHash: recomputed ${r.action?.actionHash} ≠ committed ${att.actionHash}`);
      expect(r.text).not.toContain('nullifier: derived');
    }, 30_000);
  }

  it('a file without action fields reports the binding as not checked and stays VALID', async () => {
    const { action: _a, ...att } = JSON.parse(readFileSync(MAINNET, 'utf8')) as Attestation;
    const r = await verifyAttestationFile('no-action.json', att as unknown as Attestation);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('action binding   not checked (the file carries no action fields)');
  }, 30_000);

  it('formatActionBinding renders each outcome', () => {
    const dec = { payloadHash: '0x01', policyRoot: '0x02', detectorVersion: '0x03', actionHash: '0x04', nullifier: '0x05', expirySlot: '123' };
    expect(formatActionBinding(undefined, dec)).toEqual(['  action binding   not checked (this sdk build does not recompute it)']);
    expect(formatActionBinding({ checked: false, mismatches: [] }, dec)).toEqual(['  action binding   not checked (the file carries no action fields)']);
    expect(formatActionBinding({ checked: true, actionHash: '0x04', nullifier: '0x05', mismatches: [] }, dec)).toHaveLength(1);
    expect(formatActionBinding({ checked: true, actionHash: '0x44', nullifier: '0x55', mismatches: ['actionHash', 'nullifier'] }, dec)).toEqual([
      '  action binding   MISMATCH', '    actionHash: recomputed 0x44 ≠ committed 0x04', '    nullifier: derived 0x55 ≠ committed 0x05',
    ]);
    expect(formatActionBinding({ checked: true, nullifier: '0x05', mismatches: [], error: 'nonce must be 32 bytes of hex' }, dec)).toEqual([
      '  action binding   MISMATCH', '    action fields unusable: nonce must be 32 bytes of hex',
    ]);
  });

  it('reports the decoded (blob) values, not the labels, when a label is tampered', async () => {
    const att = JSON.parse(readFileSync(MAINNET, 'utf8')) as Attestation;
    const tampered = { ...att, payloadHash: '0x' + 'ab'.repeat(32) };
    const r = await verifyAttestationFile('tampered.json', tampered);
    const blob = decodePublicInputs(att.publicInputs[0]);
    expect(r.decoded.payloadHash).toBe(blob.payloadHash);
    if (r.mismatches.length > 0) {
      // sdk with label checking: must fail and name the label
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/^label mismatch:/);
      expect(r.mismatches).toContain('payloadHash');
      expect(r.text).toContain('label mismatch (1): payloadHash');
      expect(r.text).toContain(`payloadHash: labeled ${tampered.payloadHash} ≠ decoded ${blob.payloadHash}`);
    }
  }, 30_000);

  it('formatDecoded renders one line per field', () => {
    const text = formatDecoded({ payloadHash: '0x01', policyRoot: '0x02', detectorVersion: '0x03', actionHash: '0x04', nullifier: '0x05', expirySlot: '123' });
    expect(text.split('\n')).toHaveLength(6);
    expect(text).toContain('expirySlot       123');
    expect(text).not.toContain('no expiry');
  });
});
