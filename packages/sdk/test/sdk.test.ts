import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  computeActionHash, computeNullifier, discriminator, hex, actionArgsFrom, buildVerifyIx, submit,
  configPda, nullifierPda, PROGRAM_ID, TRANSFER_GATE_ID, WrongClusterError, type Attestation,
} from '../src/index.js';

// Values printed by `blindseal-prover` in BLINDSEAL_EXECUTE mode for the localnet test action
// (the zkVM ran detector-core's hashing); the SDK must reproduce them byte-for-byte.
const DRY_RUN = {
  payloadHash: '0x4c4bd908e89bcbd11226f59ab664ea69f5ba362e39808a7c6779fc84fa164ca4',
  policyRoot: '0x36a9e9457db6ecfd752a379fc9279ad6a0acfea07928f61e2f3638a685c38397',
  detectorVersion: '0x006a0d1e62646623f1d2b9af7f3792c4d15aa7d6107bdb089a0760fd5b29331e',
  actionHash: '0xcfbc8bd88ac15a0647504d4599333b56954f4ba9a088bb5dce6825f243e4bbd5',
  nullifier: '0x6ae18cf4955d1636f7268d4f81126a8c74178583d255697b841037964583258c',
  expirySlot: 2_000_000_000n,
  nonce: '0x1111111111111111111111111111111111111111111111111111111111111111',
};
const ACTION = {
  targetProgram: '9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa',
  sourceAuthority: '5j1SSqkKBoMB4QgzuffgS9H9SDSaGnpKZ3VNpTKUwy3o',
  instruction: '0x981894646560fc2b',
  recipient: '9H7xb7EXzwQ5RFmA2qWnNhML9geLjDFrZwhJYxCUVQzf',
  mint: '',
  amount: '1000000',
};

const attestation = (over: Partial<Attestation> = {}): Attestation => ({
  version: 1, chainId: 1, ...DRY_RUN, expirySlot: 2_000_000_000, action: ACTION,
  publicInputs: ['0x' + Buffer.concat([
    hex(DRY_RUN.payloadHash), hex(DRY_RUN.policyRoot), hex(DRY_RUN.detectorVersion),
    hex(DRY_RUN.actionHash), hex(DRY_RUN.nullifier), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(DRY_RUN.expirySlot); return b; })(),
  ]).toString('hex')],
  proof: { protocol: 'groth16', curve: 'bn254', bytes: '0x' + 'ab'.repeat(260) },
  ...over,
});

describe('blindseal-sdk hashing parity (detector-core / guest / on-chain)', () => {
  it('actionHash matches the zkVM for the localnet test action', () => {
    const a = actionArgsFrom(attestation());
    const h = computeActionHash(a, hex(DRY_RUN.payloadHash), hex(DRY_RUN.policyRoot), hex(DRY_RUN.detectorVersion), DRY_RUN.expirySlot);
    expect('0x' + h.toString('hex')).toBe(DRY_RUN.actionHash);
  });
  it('nullifier = sha256(domain || actionHash)', () => {
    expect('0x' + computeNullifier(hex(DRY_RUN.actionHash)).toString('hex')).toBe(DRY_RUN.nullifier);
  });
  it('transfer-gate discriminator is sha256("global:gated_transfer")[..8]', () => {
    expect('0x' + discriminator('gated_transfer').toString('hex')).toBe(ACTION.instruction);
  });
});

describe('buildVerifyIx', () => {
  it('targets the fixed program id with config / policy / nullifier / payer / system accounts', () => {
    const att = attestation();
    const payer = Keypair.generate().publicKey;
    const ix = buildVerifyIx(att, actionArgsFrom(att), { payer });
    expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
    expect(ix.keys[0].pubkey.equals(configPda())).toBe(true);
    expect(ix.keys[2].pubkey.equals(nullifierPda(hex(DRY_RUN.nullifier)))).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[3].pubkey.equals(payer)).toBe(true);
    expect(ix.keys[3].isSigner).toBe(true);
    expect(ix.data.subarray(0, 8)).toEqual(discriminator('verify_and_consume'));
    // Vec<u8> proof (260) + Vec<u8> blob (168) + ActionArgs (2+32+32+8+32+32+8+32 = 178)
    expect(ix.data.length).toBe(8 + 4 + 260 + 4 + 168 + 178);
  });
  it('passes the program id as the None optional policy_root account', () => {
    const att = attestation();
    const ix = buildVerifyIx(att, actionArgsFrom(att), { payer: PublicKey.default, policyRoot: null });
    expect(ix.keys[1].pubkey.equals(PROGRAM_ID)).toBe(true);
  });
  it('TRANSFER_GATE_ID is the attestation target', () => {
    expect(TRANSFER_GATE_ID.toBase58()).toBe(ACTION.targetProgram);
  });
});

describe('submit() mainnet guard', () => {
  it('refuses a non-mainnet chainId', async () => {
    await expect(submit(attestation({ chainId: 2 }), { wallet: Keypair.generate() })).rejects.toThrow(/not Solana mainnet/);
  });
  it('refuses an RPC whose genesis hash is not mainnet-beta and sends nothing', async () => {
    const calls: string[] = [];
    const fakeConn = {
      getGenesisHash: async () => { calls.push('genesis'); return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'; },
      getLatestBlockhash: async () => { calls.push('blockhash'); return { blockhash: 'x', lastValidBlockHeight: 0 }; },
      sendRawTransaction: async () => { calls.push('send'); return 'sig'; },
    } as any;
    await expect(submit(attestation(), { wallet: Keypair.generate(), connection: fakeConn })).rejects.toBeInstanceOf(WrongClusterError);
    expect(calls).toEqual(['genesis']);
  });
});
