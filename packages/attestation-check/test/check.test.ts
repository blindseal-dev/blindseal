// The check against the 0.7.0 mainnet demo attestation (a real Groth16 proof). Its nullifier IS consumed on
// mainnet; here a fake ChainReader decides what the chain says, so every branch is reachable offline.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, type Attestation } from 'blindseal-sdk';
import {
  ACTION_FIELDS, actionMismatch, checkAttestation, isConsumed, nullifierOf, parseAttestation, rpcReader,
  type ChainReader, type ExpectedAction,
} from '../src/index.js';

const FIXTURE = JSON.parse(readFileSync(join(__dirname, '../../../tests/fixtures/attestation-mainnet-demo-0.7.0.json'), 'utf8')) as Attestation;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');

const expected: ExpectedAction = {
  sourceAuthority: FIXTURE.action.sourceAuthority,
  recipient: FIXTURE.action.recipient,
  mint: FIXTURE.action.mint,
  amount: FIXTURE.action.amount,
};

/** A chain at `slot` where the given PDAs hold a Nullifier record owned by the verifier. */
const chainAt = (slot: number, consumed: PublicKey[] = [], owner = PROGRAM_ID): ChainReader => ({
  async getAccountInfo(address) {
    return consumed.some((k) => k.equals(address)) ? { owner, data: new Uint8Array(81) } : null;
  },
  async getSlot() { return slot; },
});
const LIVE_SLOT = Number(FIXTURE.expirySlot) - 1000;

describe('parseAttestation', () => {
  it('accepts base64 JSON, JSON text and an object; rejects the rest with a plain message', () => {
    expect(parseAttestation(b64(FIXTURE)).nullifier).toBe(FIXTURE.nullifier);
    expect(parseAttestation(JSON.stringify(FIXTURE)).nullifier).toBe(FIXTURE.nullifier);
    expect(parseAttestation(FIXTURE)).toBe(FIXTURE);
    expect(() => parseAttestation('')).toThrow(/empty/);
    expect(() => parseAttestation('not base64!!')).toThrow(/neither JSON nor base64/);
    expect(() => parseAttestation(Buffer.from('hello').toString('base64'))).toThrow(/does not decode to JSON/);
    expect(() => parseAttestation({ ...FIXTURE, publicInputs: undefined })).toThrow(/publicInputs/);
    expect(() => parseAttestation({ ...FIXTURE, proof: {} })).toThrow(/proof\.bytes/);
    expect(() => parseAttestation({ ...FIXTURE, action: null })).toThrow(/action/);
    expect(() => parseAttestation([FIXTURE])).toThrow(/object/);
  });
});

describe('actionMismatch', () => {
  it('agrees with the fixture, zero key and empty string are the same mint, amounts compare as integers', () => {
    expect(actionMismatch(FIXTURE, expected)).toBeNull();
    expect(actionMismatch(FIXTURE, { ...expected, mint: PublicKey.default.toBase58() })).toBeNull();
    expect(actionMismatch(FIXTURE, { ...expected, amount: 1_000_000n })).toBeNull();
    expect(actionMismatch(FIXTURE, { ...expected, amount: 1_000_000 })).toBeNull();
    expect(actionMismatch(FIXTURE, { ...expected, targetProgram: FIXTURE.action.targetProgram, instruction: FIXTURE.action.instruction.toUpperCase() })).toBeNull();
  });

  it('names the first differing field in ACTION_FIELDS order', () => {
    expect(ACTION_FIELDS).toEqual(['chainId', 'targetProgram', 'instruction', 'sourceAuthority', 'recipient', 'mint', 'amount']);
    expect(actionMismatch(FIXTURE, { ...expected, amount: '1000001' })?.field).toBe('amount');
    expect(actionMismatch(FIXTURE, { ...expected, mint: PublicKey.unique().toBase58() })?.field).toBe('mint');
    const other = PublicKey.unique().toBase58();
    // recipient and amount both differ: recipient comes first
    expect(actionMismatch(FIXTURE, { ...expected, recipient: other, amount: '1' })?.field).toBe('recipient');
    expect(actionMismatch(FIXTURE, { ...expected, sourceAuthority: other })?.field).toBe('sourceAuthority');
    expect(actionMismatch(FIXTURE, { ...expected, targetProgram: other })?.field).toBe('targetProgram');
    expect(actionMismatch(FIXTURE, { ...expected, targetProgram: FIXTURE.action.targetProgram, instruction: '0x0000000000000000' })?.field).toBe('instruction');
    expect(actionMismatch(FIXTURE, { ...expected, chainId: 2 })?.field).toBe('chainId');
  });

  it('a malformed value is a mismatch of that field, not an exception', () => {
    const bad = { ...FIXTURE, action: { ...FIXTURE.action, recipient: 'not-a-key' } };
    const m = actionMismatch(bad, expected);
    expect(m?.field).toBe('recipient');
    expect(m?.got).toMatch(/malformed/);
    expect(actionMismatch(FIXTURE, { ...expected, amount: '1.5' })?.field).toBe('amount');
  });
});

describe('checkAttestation', () => {
  it('passes: real proof, matching action, live, unconsumed', async () => {
    const r = await checkAttestation(b64(FIXTURE), expected, chainAt(LIVE_SLOT));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.nullifier).toBe(FIXTURE.nullifier);
      expect(r.nullifierPda.equals(nullifierOf(FIXTURE).pda)).toBe(true);
      expect(r.expirySlot).toBe(BigInt(FIXTURE.expirySlot));
      expect(r.currentSlot).toBe(LIVE_SLOT);
    }
  });

  it('refuses a consumed nullifier (the chain says the PDA exists)', async () => {
    const r = await checkAttestation(FIXTURE, expected, chainAt(LIVE_SLOT, [nullifierOf(FIXTURE).pda]));
    expect(r).toMatchObject({ ok: false, code: 'consumed' });
    expect(await isConsumed(FIXTURE, chainAt(LIVE_SLOT, [nullifierOf(FIXTURE).pda]))).toBe(true);
    // an account at the PDA owned by someone else is not a Nullifier record
    expect(await isConsumed(FIXTURE, chainAt(LIVE_SLOT, [nullifierOf(FIXTURE).pda], PublicKey.unique()))).toBe(false);
  });

  it('refuses an expired attestation; the expiry slot itself is still live', async () => {
    expect(await checkAttestation(FIXTURE, expected, chainAt(Number(FIXTURE.expirySlot) + 1))).toMatchObject({ ok: false, code: 'expired' });
    expect((await checkAttestation(FIXTURE, expected, chainAt(Number(FIXTURE.expirySlot)))).ok).toBe(true);
  });

  it('refuses a mismatched action before touching the chain, naming the field', async () => {
    const chain: ChainReader = { getAccountInfo: async () => { throw new Error('must not be called'); }, getSlot: async () => { throw new Error('must not be called'); } };
    const r = await checkAttestation(FIXTURE, { ...expected, amount: '999999' }, chain);
    expect(r).toMatchObject({ ok: false, code: 'action_mismatch', field: 'amount' });
    expect((r as { reason: string }).reason).toMatch(/amount is 1000000, the transfer's is 999999/);
  });

  it('refuses a tampered proof and a tampered action label (binding), and malformed input', async () => {
    const proof = { ...FIXTURE, proof: { ...FIXTURE.proof, bytes: FIXTURE.proof.bytes.slice(0, -2) + (FIXTURE.proof.bytes.endsWith('00') ? '01' : '00') } };
    expect(await checkAttestation(proof, expected, chainAt(LIVE_SLOT))).toMatchObject({ ok: false, code: 'invalid_proof' });
    // an edited amount with the labels left alone: the action binding catches it before the mismatch check
    const edited = { ...FIXTURE, action: { ...FIXTURE.action, amount: '2000000' } };
    const r = await checkAttestation(edited, { ...expected, amount: '2000000' }, chainAt(LIVE_SLOT));
    expect(r).toMatchObject({ ok: false, code: 'invalid_proof' });
    expect((r as { reason: string }).reason).toMatch(/action mismatch/);
    expect(await checkAttestation('%%%', expected, chainAt(LIVE_SLOT))).toMatchObject({ ok: false, code: 'malformed' });
  });

  it('fails closed when the chain cannot be read', async () => {
    const down: ChainReader = { getAccountInfo: async () => { throw new Error('rpc down'); }, getSlot: async () => { throw new Error('rpc down'); } };
    expect(await checkAttestation(FIXTURE, expected, down)).toMatchObject({ ok: false, code: 'chain_unavailable' });
    const slotOnly: ChainReader = { ...chainAt(LIVE_SLOT), getAccountInfo: async () => { throw new Error('rpc down'); } };
    expect(await checkAttestation(FIXTURE, expected, slotOnly)).toMatchObject({ ok: false, code: 'chain_unavailable' });
  });
});

describe('rpcReader', () => {
  it('speaks JSON-RPC getSlot / getAccountInfo (base64) and surfaces errors', async () => {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const pda = nullifierOf(FIXTURE).pda;
    const fakeFetch = async (_url: string, init: { body: string }) => {
      const req = JSON.parse(init.body) as { method: string; params: unknown[] };
      calls.push(req);
      const result = req.method === 'getSlot'
        ? 123
        : req.method === 'getAccountInfo' && (req.params[0] as string) === pda.toBase58()
          ? { value: { owner: PROGRAM_ID.toBase58(), data: [Buffer.alloc(81, 7).toString('base64'), 'base64'] } }
          : { value: null };
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
    };
    const reader = rpcReader('http://rpc.invalid', fakeFetch);
    expect(await reader.getSlot()).toBe(123);
    expect(await reader.getAccountInfo(PublicKey.unique())).toBeNull();
    const info = await reader.getAccountInfo(pda);
    expect(info?.owner.equals(PROGRAM_ID)).toBe(true);
    expect(info?.data.length).toBe(81);
    expect(calls.map((c) => c.method)).toEqual(['getSlot', 'getAccountInfo', 'getAccountInfo']);
    expect(calls[1]?.params[1]).toMatchObject({ encoding: 'base64' });

    const erroring = rpcReader('http://rpc.invalid', async () => ({ ok: true, status: 200, json: async () => ({ error: { message: 'nope' } }) }));
    await expect(erroring.getSlot()).rejects.toThrow(/nope/);
    const http500 = rpcReader('http://rpc.invalid', async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(http500.getSlot()).rejects.toThrow(/HTTP 500/);
  });
});
