// Release 0.8.0 fee switch: Config decodes in both layouts, set_fee and the new account slots encode as the
// program expects, submit() reads the treasury from the chain.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import * as sdk from '../src/index.js';

const FIXTURE = JSON.parse(readFileSync(join(__dirname, '../../../tests/fixtures/attestation-test.json'), 'utf8'));
const SOURCE = Keypair.fromSeed(createHash('sha256').update('blindseal-localnet:source-authority').digest());

/** Config bytes as the program writes them: disc ‖ authority ‖ vec vkeys ‖ allowlist ‖ paused ‖ bump [‖ fee ‖ treasury]. */
const configBytes = (o: { authority: PublicKey; vkeys: Buffer[]; fee?: bigint; treasury?: PublicKey; size: number }) => {
  const parts = [createHash('sha256').update('account:Config').digest().subarray(0, 8), o.authority.toBuffer()];
  const n = Buffer.alloc(4); n.writeUInt32LE(o.vkeys.length); parts.push(n, ...o.vkeys, Buffer.from([1, 0, 254]));
  if (o.fee !== undefined) { const f = Buffer.alloc(8); f.writeBigUInt64LE(o.fee); parts.push(f, (o.treasury ?? PublicKey.default).toBuffer()); }
  const b = Buffer.concat(parts);
  expect(b.length).toBeLessThanOrEqual(o.size);
  return Buffer.concat([b, Buffer.alloc(o.size - b.length)]);
};

describe('decodeConfig: both layouts', () => {
  const authority = Keypair.generate().publicKey;
  const vkeys = sdk.DEFAULT_ALLOWED_VKEYS.map(sdk.hex);
  it('pre-0.8.0 account (303 bytes): fee 0, no treasury, hasFeeFields false', () => {
    const c = sdk.decodeConfig(configBytes({ authority, vkeys, size: sdk.CONFIG_SIZE_LEGACY }));
    expect(c.authority).toBe(authority.toBase58());
    expect(c.allowedVkeys).toEqual(sdk.DEFAULT_ALLOWED_VKEYS);
    expect(c.allowlistPolicies).toBe(true);
    expect(c.paused).toBe(false);
    expect(c.bump).toBe(254);
    expect(c.feeLamports).toBe(0n);
    expect(c.treasury).toBe(PublicKey.default.toBase58());
    expect(c.hasFeeFields).toBe(false);
    expect(sdk.CONFIG_SIZE_LEGACY).toBe(303);
  });
  it('0.8.0 account (343 bytes): fee and treasury read after the bump, whatever the vkey count', () => {
    const treasury = Keypair.generate().publicKey;
    for (const ks of [vkeys, vkeys.slice(0, 1), Array.from({ length: 8 }, (_, i) => Buffer.alloc(32, i + 1))]) {
      const c = sdk.decodeConfig(configBytes({ authority, vkeys: ks, fee: 12_345n, treasury, size: sdk.CONFIG_SIZE }));
      expect(c.allowedVkeys).toHaveLength(ks.length);
      expect(c.feeLamports).toBe(12_345n);
      expect(c.treasury).toBe(treasury.toBase58());
      expect(c.hasFeeFields).toBe(true);
    }
    expect(sdk.CONFIG_SIZE).toBe(343);
    // 8 vkeys + fee fields fill the account exactly
    expect(8 + 32 + 4 + 8 * 32 + 3 + 8 + 32).toBe(sdk.CONFIG_SIZE);
  });
  it('a grown account with the fee still 0 and the zero-key treasury reads like the legacy one, except hasFeeFields', () => {
    const c = sdk.decodeConfig(configBytes({ authority, vkeys, fee: 0n, size: sdk.CONFIG_SIZE }));
    expect(c.feeLamports).toBe(0n);
    expect(c.treasury).toBe(PublicKey.default.toBase58());
    expect(c.hasFeeFields).toBe(true);
  });
});

describe('treasuryAccount', () => {
  const payer = Keypair.generate().publicKey;
  it('is the configured treasury, or the fee payer while none is configured', () => {
    const t = Keypair.generate().publicKey;
    expect(sdk.treasuryAccount(t.toBase58(), payer).equals(t)).toBe(true);
    expect(sdk.treasuryAccount(t, payer).equals(t)).toBe(true);
    expect(sdk.treasuryAccount(PublicKey.default.toBase58(), payer).equals(payer)).toBe(true);
    expect(sdk.treasuryAccount(null, payer).equals(payer)).toBe(true);
    expect(sdk.treasuryAccount(undefined, payer).equals(payer)).toBe(true);
  });
});

describe('set_fee builder', () => {
  const authority = Keypair.generate().publicKey, treasury = Keypair.generate().publicKey;
  it('config (writable) ‖ authority (signer, writable: pays the realloc) ‖ system program; data = disc ‖ u64 LE ‖ treasury', () => {
    const ix = sdk.buildSetFeeIx(authority, 12_345, treasury);
    expect(ix.programId.equals(sdk.PROGRAM_ID)).toBe(true);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [sdk.configPda().toBase58(), false, true],
      [authority.toBase58(), true, true],
      [SystemProgram.programId.toBase58(), false, false],
    ]);
    const fee = Buffer.alloc(8); fee.writeBigUInt64LE(12_345n);
    expect(ix.data).toEqual(Buffer.concat([sdk.discriminator('set_fee'), fee, treasury.toBuffer()]));
    expect(ix.data).toHaveLength(48);
    expect(sdk.buildSetFeeIx(authority, 12_345n, treasury).data).toEqual(ix.data);
  });
  it('matches the program IDL (account order, args, event, Config fields)', () => {
    const idl = JSON.parse(readFileSync(join(__dirname, '../idl/blindseal_verify.json'), 'utf8'));
    const ins = idl.instructions.find((i: any) => i.name === 'set_fee');
    expect(ins, 'set_fee in the IDL').toBeTruthy();
    expect(ins.accounts.map((a: any) => [a.name, !!a.signer, !!a.writable])).toEqual([['config', false, true], ['authority', true, true], ['system_program', false, false]]);
    expect(ins.args.map((a: any) => [a.name, a.type])).toEqual([['fee_lamports', 'u64'], ['treasury', 'pubkey']]);
    expect(Buffer.from(ins.discriminator)).toEqual(sdk.discriminator('set_fee'));
    const cfg = idl.types.find((t: any) => t.name === 'Config');
    expect(cfg.type.fields.map((f: any) => f.name)).toEqual(['authority', 'allowed_vkeys', 'allowlist_policies', 'paused', 'bump', 'fee_lamports', 'treasury']);
    expect(idl.events.map((e: any) => e.name)).toContain('FeeChanged');
  });
});

describe('the fee accounts in the gated transfer', () => {
  it('buildGatedTransferIx puts the given treasury after the nullifier, writable, not a signer', () => {
    const treasury = Keypair.generate().publicKey;
    const ix = sdk.buildGatedTransferIx(FIXTURE, { source: SOURCE.publicKey, recipient: new PublicKey(FIXTURE.action.recipient), treasury });
    const idl = JSON.parse(readFileSync(join(__dirname, '../idl/transfer_gate.json'), 'utf8'));
    const names = idl.instructions.find((i: any) => i.name === 'gated_transfer').accounts.map((a: any) => a.name);
    const slot = names.indexOf('treasury');
    expect(slot).toBe(names.indexOf('nullifier') + 1);
    expect(ix.keys[slot].pubkey.equals(treasury)).toBe(true);
    expect(ix.keys[slot].isWritable).toBe(true);
    expect(ix.keys[slot].isSigner).toBe(false);
    expect(ix.keys).toHaveLength(names.length);
  });
  it('buildVerifyIx: an explicit fee payer and treasury land in the fee_payer / treasury slots', () => {
    const payer = Keypair.generate().publicKey, feePayer = Keypair.generate().publicKey, treasury = Keypair.generate().publicKey;
    const ix = sdk.buildVerifyIx(FIXTURE, sdk.actionArgsFrom(FIXTURE), { payer, feePayer, treasury });
    expect(ix.keys.map((k) => k.pubkey.toBase58()).slice(3, 6)).toEqual([payer, feePayer, treasury].map((k) => k.toBase58()));
    expect(ix.keys[4].isSigner && ix.keys[4].isWritable).toBe(true);
    expect(!ix.keys[5].isSigner && ix.keys[5].isWritable).toBe(true);
  });
  it('submit() reads Config and passes its treasury; reports the fee', async () => {
    const treasury = Keypair.generate().publicKey;
    const att = { ...FIXTURE, expirySlot: 2_000_000_000 };
    let raw: Buffer | null = null;
    const conn = {
      getGenesisHash: async () => sdk.MAINNET_GENESIS_HASH,
      getAccountInfo: async (k: PublicKey) => {
        expect(k.equals(sdk.configPda())).toBe(true);
        const d = Buffer.alloc(sdk.CONFIG_SIZE);
        createHash('sha256').update('account:Config').digest().subarray(0, 8).copy(d, 0);
        d.writeUInt32LE(0, 40); d[44] = 1; d[46] = 254;
        d.writeBigUInt64LE(777n, 47); treasury.toBuffer().copy(d, 55);
        return { data: d, owner: sdk.PROGRAM_ID, lamports: 1, executable: false };
      },
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 0 }),
      sendRawTransaction: async (b: Buffer) => { raw = b; return 'sig'; },
      confirmTransaction: async () => ({ value: { err: null } }),
    } as any;
    const seen: [bigint, string][] = [];
    expect(await sdk.submit(att, { wallet: SOURCE, connection: conn, onFee: (f, t) => { seen.push([f, t]); } })).toBe('sig');
    expect(seen).toEqual([[777n, treasury.toBase58()]]);
    const { Transaction } = await import('@solana/web3.js');
    const gated = Transaction.from(raw!).instructions.find((i) => i.programId.equals(sdk.TRANSFER_GATE_ID))!;
    expect(gated.keys[5].pubkey.equals(treasury)).toBe(true);
    expect(gated.keys[5].isWritable).toBe(true);
  });
});
