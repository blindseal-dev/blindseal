// Release 0.7.0 admin defaults (audit finding #1 + the config-authority handover).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import * as sdk from '../src/index.js';

const anyIx = sdk as unknown as Record<string, any>;

describe('init helpers turn approved policies on by default', () => {
  const auth = Keypair.generate().publicKey;
  it('buildInitializeIx without arguments: allowlist_policies = true, current + legacy vkeys', () => {
    const ix = sdk.buildInitializeIx(auth);
    const d = ix.data;
    expect(d.subarray(0, 8)).toEqual(sdk.discriminator('initialize'));
    const n = d.readUInt32LE(8);
    const vkeys = Array.from({ length: n }, (_, i) => '0x' + d.subarray(12 + 32 * i, 44 + 32 * i).toString('hex'));
    expect(vkeys).toEqual([anyIx.CURRENT_VKEY, ...anyIx.LEGACY_VKEYS]);
    expect(d[12 + 32 * n], 'allowlist_policies byte').toBe(1);
  });
  it('buildDefaultInitIxs: initialize(allowlist on) then register the default policy root', () => {
    const [init, reg] = anyIx.buildDefaultInitIxs(auth) as ReturnType<typeof sdk.buildInitializeIx>[];
    expect(init.data[init.data.length - 1]).toBe(1);
    expect(reg.data.subarray(0, 8)).toEqual(sdk.discriminator('register_policy_root'));
    expect('0x' + reg.data.subarray(8).toString('hex')).toBe(anyIx.DEFAULT_POLICY_ROOT);
  });
  it('DEFAULT_POLICY_ROOT is the shared policy-root vector', () => {
    const v = readFileSync(join(__dirname, '../../../evals/vectors/policy-root.txt'), 'utf8');
    expect(v).toContain(anyIx.DEFAULT_POLICY_ROOT);
  });
  it('CURRENT_VKEY is the vkey pinned for the committed guest ELF, legacy keeps 0x006a0d1e…', () => {
    expect(anyIx.CURRENT_VKEY).toMatch(/^0x[0-9a-f]{64}$/);
    expect(anyIx.LEGACY_VKEYS).toContain('0x006a0d1e62646623f1d2b9af7f3792c4d15aa7d6107bdb089a0760fd5b29331e');
    expect(anyIx.LEGACY_VKEYS).not.toContain(anyIx.CURRENT_VKEY);
  });
});

describe('set_authority builder', () => {
  it('both the current and the new authority sign; data = disc ‖ new authority', () => {
    const cur = Keypair.generate().publicKey, next = Keypair.generate().publicKey;
    expect(typeof anyIx.buildSetAuthorityIx).toBe('function');
    const ix = anyIx.buildSetAuthorityIx(cur, next);
    expect(ix.programId.equals(sdk.PROGRAM_ID)).toBe(true);
    expect(ix.keys.map((k: any) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [sdk.configPda().toBase58(), false, true],
      [cur.toBase58(), true, false],
      [next.toBase58(), true, false],
    ]);
    expect(ix.data).toEqual(Buffer.concat([sdk.discriminator('set_authority'), next.toBuffer()]));
  });
  it('matches the program IDL (account order and arg)', () => {
    const idl = JSON.parse(readFileSync(join(__dirname, '../idl/blindseal_verify.json'), 'utf8'));
    const ins = idl.instructions.find((i: any) => i.name === 'set_authority');
    expect(ins, 'set_authority in the IDL').toBeTruthy();
    expect(ins.accounts.map((a: any) => [a.name, !!a.signer])).toEqual([['config', false], ['authority', true], ['new_authority', true]]);
    expect(ins.args.map((a: any) => a.name)).toEqual(['new_authority']);
    expect(Buffer.from(ins.discriminator)).toEqual(sdk.discriminator('set_authority'));
  });
});
