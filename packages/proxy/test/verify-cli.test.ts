import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePublicInputs, type Attestation } from 'blindseal-sdk';
import { verifyAttestationFile, formatDecoded, DECODED_LABELS } from '../src/cli/verify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAINNET = path.resolve(here, '../../../tests/fixtures/attestation-mainnet.json');

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
    expect(r.text).toContain('expirySlot       2000000000 (no expiry)');
  }, 30_000);

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
