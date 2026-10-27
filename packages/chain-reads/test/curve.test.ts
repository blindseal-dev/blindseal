// node --test (Node ≥ 22.18 strips types natively). No RPC: the expectations are public mainnet facts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { isOnCurve, findProgramAddress, VERIFY_PROGRAM_ID } from '../src/index.ts';

test('real Ed25519 public keys are on-curve', () => {
  for (let i = 0; i < 32; i++) {
    const pk = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    assert.equal(isOnCurve(pk), true);
  }
});

test('random 32-byte values are not all on-curve (Node 24 createPublicKey accepted every one)', () => {
  let off = 0;
  for (let i = 0; i < 64; i++) if (!isOnCurve(randomBytes(32))) off++;
  assert.ok(off > 0, 'expected some off-curve values');
  assert.equal(isOnCurve(new Uint8Array(31)), false);
});

test('the mainnet nullifier PDA resolves to the account the consuming tx created (7iwA4nxn…)', () => {
  // Consumed event nullifier (tx 7iwA4nxnBG73…, slot 460579127) → PDA [b"nullifier", nullifier] of the verifier
  // that consumed it: the 0.5.0 verifier (merZNYK…, paused since 0.5.2), not today's VERIFY_PROGRAM_ID
  const nullifier = Buffer.from('fea1d3eca4c3ee68eadf478f8096599b1725acdbcf2975fbb5b7de96b96a15f1', 'hex');
  assert.equal(findProgramAddress([Buffer.from('nullifier'), nullifier], 'merZNYKpKwwX4CGgzvma3jPvLfrMTkZcb1cSXUKANcb'), '4Ejfezkv4SzjQAa5KpvsMaHHMKY2JUJi6xEiBwEnaB3c');
  assert.notEqual(VERIFY_PROGRAM_ID, 'merZNYKpKwwX4CGgzvma3jPvLfrMTkZcb1cSXUKANcb');
});
