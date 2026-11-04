// The gate against the 0.7.0 mainnet demo attestation (real proof; its nullifier IS consumed on mainnet,
// the fake ChainReader decides here). Payments are given explicitly (`body.payment`) and, for the x402
// exact scheme, as a partially signed transaction the extractor decodes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { PROGRAM_ID, nullifierPda, hex, type Attestation } from 'blindseal-sdk';
import {
  ASSOCIATED_TOKEN_ID, ATTESTATION_HEADER, SPL_TOKEN_ID, GateRefusedError, associatedTokenAddress, createGate, decodeTransaction,
  fetchGate, nodeHttpGate, requireAllowed, transfersIn, x402Payment,
  type ChainReader, type Decision, type GateRequest,
} from '../src/index.js';

const FIXTURE = JSON.parse(readFileSync(join(__dirname, '../../../tests/fixtures/attestation-mainnet-demo-0.7.0.json'), 'utf8')) as Attestation;
const HEADER = Buffer.from(JSON.stringify(FIXTURE)).toString('base64');
const NF_PDA = nullifierPda(hex(FIXTURE.nullifier), PROGRAM_ID);
const LIVE = Number(FIXTURE.expirySlot) - 10;
const chainAt = (slot: number, consumed: PublicKey[] = []): ChainReader => ({
  async getAccountInfo(a) { return consumed.some((k) => k.equals(a)) ? { owner: PROGRAM_ID, data: new Uint8Array(81) } : null; },
  async getSlot() { return slot; },
});

const payment = { payer: FIXTURE.action.sourceAuthority, recipient: FIXTURE.action.recipient, mint: '', amount: FIXTURE.action.amount };
const req = (over: Partial<typeof payment> = {}, headers: Record<string, string> = { [ATTESTATION_HEADER]: HEADER }): GateRequest =>
  ({ headers, body: { payment: { ...payment, ...over } } });
const SOL_THRESHOLD = { '': '500000' }; // half the fixture's amount

describe('createGate — thresholds', () => {
  const gate = createGate({ chain: chainAt(LIVE), thresholds: SOL_THRESHOLD });

  it('passes a payment below the threshold without looking at the header', async () => {
    const d = await gate(req({ amount: '499999' }, {}));
    expect(d).toMatchObject({ allow: true, gated: false, code: 'below_threshold' });
  });

  it('a mint with no threshold passes by default and is gated with unlistedMints: require', async () => {
    const usdc = PublicKey.unique().toBase58();
    expect(await gate(req({ mint: usdc, amount: '1' }, {}))).toMatchObject({ allow: true, gated: false, code: 'ungated_mint' });
    const strict = createGate({ chain: chainAt(LIVE), thresholds: SOL_THRESHOLD, unlistedMints: 'require' });
    expect(await strict(req({ mint: usdc, amount: '1' }, {}))).toMatchObject({ allow: false, status: 402, code: 'missing_attestation' });
  });

  it('threshold keys: "native" / "SOL" / the zero key all mean native SOL; the threshold is inclusive', async () => {
    for (const key of ['native', 'SOL', PublicKey.default.toBase58()]) {
      const g = createGate({ chain: chainAt(LIVE), thresholds: { [key]: 1_000_000n } });
      expect(await g(req({}, {}))).toMatchObject({ allow: false, code: 'missing_attestation' });
      expect(await g(req({ amount: '999999' }, {}))).toMatchObject({ allow: true, code: 'below_threshold' });
    }
  });

  it('refuses a request with no readable payment (400)', async () => {
    expect(await gate({ headers: {}, body: {} })).toMatchObject({ allow: false, status: 400, code: 'no_payment' });
    expect(await gate({ headers: {}, body: { payment: { payer: 'x' } } })).toMatchObject({ allow: false, status: 400, code: 'no_payment' });
    expect(await gate({ headers: {}, body: 'not json at all' })).toMatchObject({ allow: false, status: 400, code: 'no_payment' }); // a string body is parsed; JSON errors refuse
  });
});

describe('createGate — at or above the threshold', () => {
  const gate = createGate({ chain: chainAt(LIVE), thresholds: SOL_THRESHOLD });

  it('passes with a valid attestation for exactly this payment', async () => {
    const d = await gate(req());
    expect(d).toMatchObject({ allow: true, gated: true, code: 'attested', nullifier: FIXTURE.nullifier });
    if (d.allow && d.gated) expect(d.attestation.actionHash).toBe(FIXTURE.actionHash);
  });

  it('header lookup is case-insensitive and accepts Headers objects', async () => {
    expect((await gate(req({}, { 'X-Blindseal-Attestation': HEADER }))).allow).toBe(true);
    expect((await gate({ headers: new Headers({ 'X-Blindseal-Attestation': HEADER }), body: { payment } })).allow).toBe(true);
  });

  it('refuses a missing header (402)', async () => {
    expect(await gate(req({}, {}))).toMatchObject({ allow: false, status: 402, code: 'missing_attestation' });
  });

  it('refuses a payment that differs from the attestation, naming the first differing field (403)', async () => {
    expect(await gate(req({ amount: '1000001' }))).toMatchObject({ allow: false, status: 403, code: 'action_mismatch', field: 'amount' });
    expect(await gate(req({ recipient: PublicKey.unique().toBase58() }))).toMatchObject({ allow: false, code: 'action_mismatch', field: 'recipient' });
    expect(await gate(req({ payer: PublicKey.unique().toBase58() }))).toMatchObject({ allow: false, code: 'action_mismatch', field: 'sourceAuthority' });
    const usdc = PublicKey.unique().toBase58();
    const g = createGate({ chain: chainAt(LIVE), thresholds: { [usdc]: 1 } });
    expect(await g(req({ mint: usdc }))).toMatchObject({ allow: false, code: 'action_mismatch', field: 'mint' });
  });

  it('refuses a consumed nullifier, an expired attestation, a bad proof and a malformed header', async () => {
    const consumed = createGate({ chain: chainAt(LIVE, [NF_PDA]), thresholds: SOL_THRESHOLD });
    expect(await consumed(req())).toMatchObject({ allow: false, status: 403, code: 'consumed' });
    const late = createGate({ chain: chainAt(Number(FIXTURE.expirySlot) + 1), thresholds: SOL_THRESHOLD });
    expect(await late(req())).toMatchObject({ allow: false, status: 403, code: 'expired' });
    const tampered = { ...FIXTURE, proof: { ...FIXTURE.proof, bytes: FIXTURE.proof.bytes.replace(/.$/, (c) => (c === '0' ? '1' : '0')) } };
    expect(await gate(req({}, { [ATTESTATION_HEADER]: Buffer.from(JSON.stringify(tampered)).toString('base64') }))).toMatchObject({ allow: false, status: 403, code: 'invalid_proof' });
    expect(await gate(req({}, { [ATTESTATION_HEADER]: '!!not-base64!!' }))).toMatchObject({ allow: false, status: 400, code: 'malformed' });
  });

  it('with a consumer stated, the attestation must target that program and instruction', async () => {
    const bound = createGate({ chain: chainAt(LIVE), thresholds: SOL_THRESHOLD, consumer: { targetProgram: FIXTURE.action.targetProgram, instruction: FIXTURE.action.instruction } });
    expect((await bound(req())).allow).toBe(true);
    const other = createGate({ chain: chainAt(LIVE), thresholds: SOL_THRESHOLD, consumer: { targetProgram: PublicKey.unique().toBase58(), instruction: FIXTURE.action.instruction } });
    expect(await other(req())).toMatchObject({ allow: false, code: 'action_mismatch', field: 'targetProgram' });
  });

  it('fails closed when the chain is unreadable', async () => {
    const down = createGate({ chain: { getAccountInfo: async () => { throw new Error('down'); }, getSlot: async () => { throw new Error('down'); } }, thresholds: SOL_THRESHOLD });
    expect(await down(req())).toMatchObject({ allow: false, status: 403, code: 'chain_unavailable' });
  });

  it('requireAllowed throws a GateRefusedError carrying the decision', async () => {
    await expect(requireAllowed(gate, req({}, {}))).rejects.toBeInstanceOf(GateRefusedError);
    await expect(requireAllowed(gate, req({ amount: '1000001' }))).rejects.toThrow(/action_mismatch \(amount\)/);
    expect((await requireAllowed(gate, req())).code).toBe('attested');
  });
});

// ---- the x402 exact-scheme body: payment read from the client's partially signed transaction ----
const payer = Keypair.generate();
const merchant = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const blockhash = 'EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k';
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const transferChecked = (amount: bigint, dest = associatedTokenAddress(merchant, mint)) => new TransactionInstruction({
  programId: SPL_TOKEN_ID,
  keys: [
    { pubkey: associatedTokenAddress(payer.publicKey, mint), isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: dest, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
  ],
  data: Buffer.concat([Buffer.from([12]), u64(amount), Buffer.from([6])]),
});
const v0 = (ixs: TransactionInstruction[]) => {
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  tx.sign([payer]);
  return Buffer.from(tx.serialize()).toString('base64');
};
const x402Body = (transaction: string, over: Record<string, unknown> = {}) => ({
  paymentPayload: { x402Version: 1, scheme: 'exact', network: 'solana', payload: { transaction } },
  paymentRequirements: { scheme: 'exact', network: 'solana', maxAmountRequired: '1000', asset: mint.toBase58(), payTo: merchant.toBase58(), resource: 'https://example.com/r', description: '', ...over },
});

describe('x402Payment — exact scheme on Solana', () => {
  it('reads payer, recipient (payTo), mint (asset) and amount from the TransferChecked to the merchant ATA', () => {
    const p = x402Payment({ headers: {}, body: x402Body(v0([transferChecked(1500n)])) });
    expect(p).toEqual({ payer: payer.publicKey.toBase58(), recipient: merchant.toBase58(), mint: mint.toBase58(), amount: 1500n });
  });

  it('v2 bodies carry the requirements as paymentPayload.accepted with `amount`', () => {
    const body = { paymentPayload: { x402Version: 2, accepted: { scheme: 'exact', amount: '1000', asset: mint.toBase58(), payTo: merchant.toBase58() }, payload: { transaction: v0([transferChecked(1000n)]) } } };
    expect(x402Payment({ headers: {}, body })?.amount).toBe(1000n);
  });

  it('legacy transactions and plain Transfer (tag 3) decode too; System transfers for native SOL', () => {
    const legacy = new Transaction({ recentBlockhash: blockhash, feePayer: payer.publicKey }).add(new TransactionInstruction({
      programId: SPL_TOKEN_ID,
      keys: [
        { pubkey: associatedTokenAddress(payer.publicKey, mint), isSigner: false, isWritable: true },
        { pubkey: associatedTokenAddress(merchant, mint), isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([3]), u64(7n)]),
    }));
    legacy.sign(payer);
    const b64 = legacy.serialize({ requireAllSignatures: false }).toString('base64');
    expect(x402Payment({ headers: {}, body: x402Body(b64, { maxAmountRequired: '7' }) })?.amount).toBe(7n);

    const sol = v0([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: merchant, lamports: 42 })]);
    expect(x402Payment({ headers: {}, body: x402Body(sol, { asset: '', maxAmountRequired: '42' }) })).toEqual({ payer: payer.publicKey.toBase58(), recipient: merchant.toBase58(), mint: '', amount: 42n });
  });

  it('refuses: no transfer to the merchant, two of them, under the required amount, lookup tables', () => {
    const elsewhere = transferChecked(1500n, associatedTokenAddress(Keypair.generate().publicKey, mint));
    expect(() => x402Payment({ headers: {}, body: x402Body(v0([elsewhere])) })).toThrow(/no transfer to/);
    expect(() => x402Payment({ headers: {}, body: x402Body(v0([transferChecked(1000n), transferChecked(1000n)])) })).toThrow(/more than one/);
    expect(() => x402Payment({ headers: {}, body: x402Body(v0([transferChecked(999n)])) })).toThrow(/below the required/);
    expect(() => x402Payment({ headers: {}, body: x402Body('', {}) })).toThrow(/transaction is missing/);
    expect(x402Payment({ headers: {}, body: { unrelated: true } })).toBeNull();
    expect(transfersIn(decodeTransaction(v0([transferChecked(5n)])))).toHaveLength(1);
    expect(ASSOCIATED_TOKEN_ID.toBase58()).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  });

  it('end to end: an SPL payment at the threshold needs an attestation; the fixture (native SOL) does not match it', async () => {
    const gate = createGate({ chain: chainAt(LIVE), thresholds: { [mint.toBase58()]: '1000' } });
    expect(await gate({ headers: {}, body: x402Body(v0([transferChecked(1000n)])) })).toMatchObject({ allow: false, status: 402, code: 'missing_attestation' });
    expect(await gate({ headers: { [ATTESTATION_HEADER]: HEADER }, body: x402Body(v0([transferChecked(1000n)])) })).toMatchObject({ allow: false, status: 403, code: 'action_mismatch', field: 'sourceAuthority' });
  });
});

// ---- adapters ----
describe('adapters', () => {
  const gate = createGate({ chain: chainAt(LIVE), thresholds: SOL_THRESHOLD });

  const fakeReq = (body: unknown, headers: Record<string, string>): IncomingMessage => {
    const r = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
    (r as { headers: Record<string, string> }).headers = headers;
    return r;
  };
  const fakeRes = () => {
    const out = { statusCode: 200, headers: {} as Record<string, string>, body: '' };
    const res = {
      get statusCode() { return out.statusCode; }, set statusCode(v: number) { out.statusCode = v; },
      setHeader(k: string, v: string) { out.headers[k] = v; },
      end(b?: string) { out.body = b ?? ''; },
    } as unknown as ServerResponse;
    return { res, out };
  };

  it('node:http: refusals are answered with the decision status and a JSON body; allowed requests reach next', async () => {
    let reached: Decision | null = null;
    const handler = nodeHttpGate(gate, (_req, res, decision) => { reached = decision; res.statusCode = 200; res.end('ok'); });
    const { res, out } = fakeRes();
    const d = await handler(fakeReq({ payment: { ...payment, amount: '1000001' } }, { [ATTESTATION_HEADER]: HEADER }), res);
    expect(d.allow).toBe(false);
    expect(out.statusCode).toBe(403);
    expect(JSON.parse(out.body)).toEqual({ error: 'action_mismatch', reason: expect.stringMatching(/amount/), field: 'amount' });
    expect(reached).toBeNull();

    const ok = fakeRes();
    await handler(fakeReq({ payment }, { [ATTESTATION_HEADER]: HEADER }), ok.res);
    expect(ok.out.statusCode).toBe(200);
    expect(reached).toMatchObject({ allow: true, code: 'attested' });

    const bad = fakeRes();
    const r = Readable.from([Buffer.from('{not json')]) as unknown as IncomingMessage; (r as { headers: Record<string, string> }).headers = {};
    expect(await handler(r, bad.res)).toMatchObject({ allow: false, status: 400 });
  });

  it('fetch-style: a Response for refusals, next for allowed', async () => {
    const handler = fetchGate(gate, (_r, decision) => new Response(decision.code, { status: 200 }));
    const make = (body: unknown, headers: Record<string, string>) => new Request('http://facilitator.invalid/verify', { method: 'POST', headers, body: JSON.stringify(body) });
    const refused = await handler(make({ payment }, {}));
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ error: 'missing_attestation' });
    const allowed = await handler(make({ payment }, { [ATTESTATION_HEADER]: HEADER }));
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe('attested');
    const below = await handler(make({ payment: { ...payment, amount: '1' } }, {}));
    expect(await below.text()).toBe('below_threshold');
  });
});
