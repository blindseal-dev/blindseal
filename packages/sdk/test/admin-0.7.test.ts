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
  it('RULES_ROOT is the shared policy-root vector; DEFAULT/DEMO_POLICY_ROOT are its v2 roots; the 0.7 root is legacy', () => {
    const v = readFileSync(join(__dirname, '../../../evals/vectors/policy-root.txt'), 'utf8');
    expect(v).toContain(anyIx.RULES_ROOT);
    expect(anyIx.DEFAULT_POLICY_ROOT).toBe(anyIx.policyRootFor(anyIx.EMPTY_ACTION_POLICY));
    const demo = JSON.parse(readFileSync(join(__dirname, '../../../tests/fixtures/action-policy-demo.json'), 'utf8'));
    expect(anyIx.DEMO_POLICY_ROOT).toBe(anyIx.policyRootFor(anyIx.parseActionPolicy(demo)));
    expect(anyIx.LEGACY_POLICY_ROOTS).toEqual([anyIx.RULES_ROOT]);
  });
  it('transfer-gate pins exactly the default, demo and legacy roots', () => {
    const src = readFileSync(join(__dirname, '../../../programs/transfer-gate/src/lib.rs'), 'utf8');
    const pinned = (name: string) => {
      const m = src.match(new RegExp(`pub const ${name}: \\[u8; 32\\] = \\[([^\\]]+)\\]`));
      return '0x' + m![1]!.split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.replace('0x', '')).join('');
    };
    expect(pinned('DEFAULT_POLICY_ROOT')).toBe(anyIx.DEFAULT_POLICY_ROOT);
    expect(pinned('DEMO_POLICY_ROOT')).toBe(anyIx.DEMO_POLICY_ROOT);
    expect(pinned('LEGACY_POLICY_ROOT')).toBe(anyIx.LEGACY_POLICY_ROOTS[0]);
  });
  it('CURRENT_VKEY is the 0.8.0 guest (leaf screening, action policy); legacy keeps the 0.7.0 key (until c2) and the 0.6.0 key (localnet fixtures)', () => {
    expect(anyIx.CURRENT_VKEY).toBe('0x00bd130c8d3ccc302df81ae4a422c3bd7a9f8d56afccfa4eb934d4e4406e0378');
    expect(anyIx.LEGACY_VKEYS).not.toContain('0x00e9807a48c66829ce5297a0c3b423cf724b8e47d21fbd98f50b5fcb51e4a537');
    expect(anyIx.LEGACY_VKEYS).toEqual(['0x00cdf40c21b14717fd783bdecb539b762094b3b0da75a567f4b6cc088e9f2967', '0x006a0d1e62646623f1d2b9af7f3792c4d15aa7d6107bdb089a0760fd5b29331e']);
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
