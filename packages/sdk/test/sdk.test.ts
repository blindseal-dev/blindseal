import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from '@solana/web3.js';
import {
  computeActionHash, computeNullifier, discriminator, hex, actionArgsFrom, buildVerifyIx, buildGatedTransferIx, submit,
  configPda, nullifierPda, policyRootPda, decodeNullifier, PROGRAM_ID, TRANSFER_GATE_ID, WrongClusterError, UnsupportedTargetError,
  type Attestation,
} from '../src/index.js';

// The localnet test attestation (tests/fixtures/attestation-test.json) is produced by `blindseal-prover`, whose zkVM
// runs detector-core's hashing; the SDK must reproduce its values byte-for-byte. Read from the fixture, so the
// suite follows a re-prove (new gate id / wallets) without hand-edited literals.
const FIXTURE = JSON.parse(readFileSync(join(__dirname, '../../../tests/fixtures/attestation-test.json'), 'utf8'));
const DRY_RUN = {
  payloadHash: FIXTURE.payloadHash as string,
  policyRoot: FIXTURE.policyRoot as string,
  detectorVersion: FIXTURE.detectorVersion as string,
  actionHash: FIXTURE.actionHash as string,
  nullifier: FIXTURE.nullifier as string,
  expirySlot: BigInt(FIXTURE.expirySlot),
  nonce: FIXTURE.nonce as string,
};
const ACTION = FIXTURE.action as { targetProgram: string; sourceAuthority: string; recipient: string; mint: string; amount: string; instruction: string };

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

// The fixture's source authority, derived exactly as tests/m2.spec.ts does (fixed seed, nothing stored).
const SOURCE = Keypair.fromSeed(createHash('sha256').update('blindseal-localnet:source-authority').digest());

describe('buildVerifyIx', () => {
  it('targets the fixed program id with config / policy / nullifier / payer / system / instructions-sysvar accounts', () => {
    const att = attestation();
    const payer = Keypair.generate().publicKey;
    const ix = buildVerifyIx(att, actionArgsFrom(att), { payer });
    expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
    expect(ix.keys[0].pubkey.equals(configPda())).toBe(true);
    expect(ix.keys[2].pubkey.equals(nullifierPda(hex(DRY_RUN.nullifier)))).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[3].pubkey.equals(payer)).toBe(true);
    expect(ix.keys[3].isSigner).toBe(true);
    expect(ix.keys[4].pubkey.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys[5].pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY)).toBe(true);
    expect(ix.keys[5].isWritable || ix.keys[5].isSigner).toBe(false);
    expect(ix.keys).toHaveLength(6);
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

describe('buildGatedTransferIx', () => {
  it('matches the IDL account order and forwards the instructions sysvar', () => {
    const att = attestation();
    const recipient = new PublicKey(ACTION.recipient);
    const ix = buildGatedTransferIx(att, { source: SOURCE.publicKey, recipient });
    const idl = JSON.parse(readFileSync(join(__dirname, '../idl/transfer_gate.json'), 'utf8'));
    const names = idl.instructions.find((i: any) => i.name === 'gated_transfer').accounts.map((a: any) => a.name);
    expect(names).toEqual(['source', 'recipient', 'config', 'policy_root', 'nullifier', 'verify_program', 'system_program', 'instructions']);
    expect(ix.programId.equals(TRANSFER_GATE_ID)).toBe(true);
    const want = [SOURCE.publicKey, recipient, configPda(), policyRootPda(hex(DRY_RUN.policyRoot)), nullifierPda(hex(DRY_RUN.nullifier)), PROGRAM_ID, SystemProgram.programId, SYSVAR_INSTRUCTIONS_PUBKEY];
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(want.map((k) => k.toBase58()));
    expect(ix.keys[0].isSigner && ix.keys[0].isWritable).toBe(true);
    expect(ix.data.subarray(0, 8)).toEqual(discriminator('gated_transfer'));
  });
  it('verify_and_consume IDL accounts end with the instructions sysvar', () => {
    const idl = JSON.parse(readFileSync(join(__dirname, '../idl/blindseal_verify.json'), 'utf8'));
    const accts = idl.instructions.find((i: any) => i.name === 'verify_and_consume').accounts;
    expect(accts.map((a: any) => a.name)).toEqual(['config', 'policy_root', 'nullifier', 'payer', 'system_program', 'instructions']);
    expect(accts[5].address).toBe(SYSVAR_INSTRUCTIONS_PUBKEY.toBase58());
    const errs = idl.errors.map((e: any) => [e.code, e.name]);
    expect(errs.slice(-3)).toEqual([[6011, 'DirectCallNotAllowed'], [6012, 'NestedCallNotAllowed'], [6013, 'CallerNotTargetProgram']]);
  });
});

describe('decodeNullifier', () => {
  it('reads slot / consumer program / actionHash / bump', () => {
    const b = Buffer.alloc(81);
    b.writeBigUInt64LE(123n, 8);
    TRANSFER_GATE_ID.toBuffer().copy(b, 16);
    hex(DRY_RUN.actionHash).copy(b, 48);
    b[80] = 254;
    const n = decodeNullifier(b);
    expect(n.consumedAtSlot).toBe(123n);
    expect(n.consumerProgram.equals(TRANSFER_GATE_ID)).toBe(true);
    expect(n.actionHash).toBe(DRY_RUN.actionHash);
    expect(n.bump).toBe(254);
  });
});

describe('submit() sends the gated transaction only', () => {
  const noNetwork = () => {
    const calls: string[] = [];
    const conn = new Proxy({}, { get: (_t, k) => async () => { calls.push(String(k)); throw new Error('no network expected'); } }) as any;
    return { calls, conn };
  };
  it('throws for a target program other than transfer-gate, before any RPC call', async () => {
    const { calls, conn } = noNetwork();
    const att = attestation({ action: { ...ACTION, targetProgram: Keypair.generate().publicKey.toBase58() } });
    const p = submit(att, { wallet: SOURCE, connection: conn });
    await expect(p).rejects.toBeInstanceOf(UnsupportedTargetError);
    await expect(submit(att, { wallet: SOURCE, connection: conn })).rejects.toThrow(/submit through the target program; the verifier only accepts CPI from it/);
    expect(calls).toEqual([]);
  });
  it('throws when the wallet is not the source authority, before any RPC call', async () => {
    const { calls, conn } = noNetwork();
    await expect(submit(attestation(), { wallet: Keypair.generate(), connection: conn })).rejects.toThrow(/not the attestation's source authority/);
    expect(calls).toEqual([]);
  });
  it('sends one gated_transfer instruction to transfer-gate, signed by the source authority', async () => {
    let raw: Buffer | null = null;
    const conn = {
      getGenesisHash: async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 0 }),
      sendRawTransaction: async (b: Buffer) => { raw = b; return 'sig'; },
      confirmTransaction: async () => ({ value: { err: null } }),
    } as any;
    expect(await submit(attestation(), { wallet: SOURCE, connection: conn })).toBe('sig');
    const { Transaction } = await import('@solana/web3.js');
    const tx = Transaction.from(raw!);
    expect(tx.feePayer!.equals(SOURCE.publicKey)).toBe(true);
    expect(tx.verifySignatures()).toBe(true);
    const gated = tx.instructions.filter((i) => i.programId.equals(TRANSFER_GATE_ID));
    expect(gated).toHaveLength(1);
    expect(tx.instructions.some((i) => i.programId.equals(PROGRAM_ID))).toBe(false); // never the verifier directly
    expect(gated[0].data.subarray(0, 8)).toEqual(discriminator('gated_transfer'));
    expect(gated[0].keys.at(-1)!.pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY)).toBe(true);
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
    await expect(submit(attestation(), { wallet: SOURCE, connection: fakeConn })).rejects.toBeInstanceOf(WrongClusterError);
    expect(calls).toEqual(['genesis']);
  });
});
