/// The API end to end against the fake prover and the mocked facilitator. No real proof, no network.
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { createBackend } from '../src/backends/index.js';
import { createBilling, type Billing } from '../src/billing/x402.js';
import { parseConfig, type HostConfig } from '../src/config.js';
import { ProofQueue } from '../src/jobs/queue.js';
import { JobStore } from '../src/jobs/store.js';
import { createServer } from '../src/server.js';
import { CLEAN_CALL, FAKE_PROVER, FEE_PAYER, FIXTURE_ATTESTATION, INJECTED_CALL, MAINNET, PAYER, PAY_TO, fixtureAttestation, rmTmp, startMockFacilitator, tmpDir, waitFor } from './helpers.js';

interface Running { url: string; store: JobStore; queue: ProofQueue; billing?: Billing; close: () => Promise<void> }

async function startHost(over: Partial<HostConfig> & { facilitatorUrl: string; dataDir: string }): Promise<Running> {
  const config = parseConfig({ host: '127.0.0.1', port: 1, backend: 'local', proverPath: FAKE_PROVER, concurrency: 1, paymentNetwork: 'solana', ...over });
  const store = JobStore.open(config.dataDir);
  const queue = new ProofQueue({ store, backend: createBackend(config, () => {}), concurrency: 1, tmpRoot: config.dataDir });
  const billing = await createBilling(config, { publicUrl: 'http://prover.test' });
  const server = createServer({ config: { ...config, publicUrl: 'http://prover.test' }, store, queue, billing, log: (l) => { if (/error/.test(l)) process.stderr.write(l + '\n'); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, store, queue, billing, close: async () => { await queue.shutdown(); await new Promise<void>((r) => server.close(() => r())); } };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/// What an x402 client does after a 402: pick the requirement and sign; here the "signature" is a word the mock knows.
function paymentHeader(required: PaymentRequired, transaction: string): string {
  return encodePaymentSignatureHeader({ x402Version: 2, resource: required.resource, accepted: required.accepts[0]!, payload: { transaction } });
}

const CLEAN_BODY = { call: CLEAN_CALL, expirySlot: 463600736 };

describe('prover host API', () => {
  let facilitator: Awaited<ReturnType<typeof startMockFacilitator>>;
  beforeAll(async () => { process.env.FAKE_PROVER_FIXTURE = FIXTURE_ATTESTATION; facilitator = await startMockFacilitator(); });
  afterAll(async () => { await facilitator.close(); });
  afterEach(() => { facilitator.calls.splice(0); delete process.env.FAKE_PROVER_EXIT; });

  describe('billing on (0.50 USDC)', () => {
    let host: Running;
    let dir: string;
    beforeAll(async () => { dir = tmpDir(); host = await startHost({ facilitatorUrl: facilitator.url, dataDir: dir, priceUsdc: '0.50', payTo: PAY_TO }); });
    afterAll(async () => { await host.close(); rmTmp(dir); });

    it('GET /healthz says what a proof costs', async () => {
      const h = await (await fetch(`${host.url}/healthz`)).json() as Record<string, unknown>;
      expect(h.ok).toBe(true);
      expect(h.billing).toMatchObject({ network: MAINNET, amount: '500000', priceUsdc: '0.50', payTo: PAY_TO, asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
    });

    it('no payment → 402 with the x402 v2 requirements, and no facilitator verify/settle', async () => {
      const res = await post(host.url, CLEAN_BODY);
      expect(res.status).toBe(402);
      const header = res.headers.get('payment-required');
      expect(header).toBeTruthy();
      const required = decodePaymentRequiredHeader(header!);
      expect(required.x402Version).toBe(2);
      expect(required.resource.url).toBe('http://prover.test/jobs');
      expect(required.accepts).toHaveLength(1);
      const r: PaymentRequirements = required.accepts[0]!;
      expect(r).toMatchObject({ scheme: 'exact', network: MAINNET, amount: '500000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: PAY_TO, maxTimeoutSeconds: 60 });
      expect(r.extra.feePayer).toBe(FEE_PAYER);
      const body = await res.json() as { accepts: PaymentRequirements[]; error: string };
      expect(body.error).toBe('payment required');
      expect(body.accepts[0]).toEqual(r);
      expect(facilitator.calls).toEqual([]);
      expect(host.store.list()).toEqual([]);
    });

    it('a payment the facilitator rejects → 402, nothing settled, no job', async () => {
      const required = decodePaymentRequiredHeader((await post(host.url, CLEAN_BODY)).headers.get('payment-required')!);
      const res = await post(host.url, CLEAN_BODY, { 'payment-signature': paymentHeader(required, 'bad') });
      expect(res.status).toBe(402);
      expect(decodePaymentRequiredHeader(res.headers.get('payment-required')!).error).toBe('invalid_transaction');
      expect(facilitator.calls.map((c) => c.path)).toEqual(['/verify']);
      expect(host.store.list()).toEqual([]);
    });

    it('a settlement the facilitator cannot complete → 402, no job', async () => {
      const required = decodePaymentRequiredHeader((await post(host.url, CLEAN_BODY)).headers.get('payment-required')!);
      const res = await post(host.url, CLEAN_BODY, { 'payment-signature': paymentHeader(required, 'settle-fails') });
      expect(res.status).toBe(402);
      expect(facilitator.calls.map((c) => c.path)).toEqual(['/verify', '/settle']);
      expect(host.store.list()).toEqual([]);
    });

    it('a good payment → verified, settled, job created; the proof lands and the attestation is served', async () => {
      const required = decodePaymentRequiredHeader((await post(host.url, CLEAN_BODY)).headers.get('payment-required')!);
      const res = await post(host.url, { ...CLEAN_BODY, decisionId: 'd_hosted_test' }, { 'payment-signature': paymentHeader(required, 'good') });
      expect(res.status).toBe(202);
      const job = await res.json() as Record<string, unknown> & { id: string; payment: Record<string, unknown>; action: Record<string, unknown> };
      expect(job.status).toBe('queued');
      expect(job.decisionId).toBe('d_hosted_test');
      expect(job.expirySlot).toBe('463600736');
      expect(job.payloadHash).toBe('0x7de7653d813c022fbf4fb0ca7a8909f5325fbd54895bd87b2d878bfbfdf47dec'); // the fixture's
      expect(job.action).toMatchObject({ targetProgram: '9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa', instruction: '0x981894646560fc2b', amount: '1000000', recipient: CLEAN_CALL.args.to, sourceAuthority: CLEAN_CALL.args.from });
      expect(job.payment).toMatchObject({ status: 'settled', payer: PAYER, amount: '500000', network: MAINNET });
      expect(String(job.payment.transaction)).toMatch(/^mock-signature-/);
      expect(decodePaymentResponseHeader(res.headers.get('payment-response')!).success).toBe(true);
      expect(facilitator.calls.map((c) => c.path)).toEqual(['/verify', '/settle']);
      // the facilitator saw exactly the requirements we published
      expect((facilitator.calls[1]!.body.paymentRequirements as PaymentRequirements).amount).toBe('500000');

      const done = await waitFor(async () => (await (await fetch(`${host.url}/jobs/${job.id}`)).json()) as Record<string, unknown>, (j) => j.status === 'done');
      expect(done.payment).toMatchObject({ status: 'settled' });
      const att = await fetch(`${host.url}/jobs/${job.id}/attestation`);
      expect(att.status).toBe(200);
      expect(await att.json()).toEqual(fixtureAttestation());
      expect(host.store.readPayload(job.id)).toBeUndefined();
    });

    it('a refused payload (base64 injection in the memo) → 422 before any facilitator call', async () => {
      const required = decodePaymentRequiredHeader((await post(host.url, CLEAN_BODY)).headers.get('payment-required')!);
      facilitator.calls.splice(0);
      const before = host.store.list().length;
      const res = await post(host.url, { call: INJECTED_CALL, expirySlot: 1 }, { 'payment-signature': paymentHeader(required, 'good') });
      expect(res.status).toBe(422);
      const body = await res.json() as Record<string, unknown>;
      expect(body.code).toBe('verdict');
      expect(body.verdict).toBe('malicious');
      expect(body.patterns).toEqual(['l0-base64->instruction-prefix:ignore-previous']);
      expect(facilitator.calls).toEqual([]);
      expect(host.store.list().length).toBe(before);
    });

    it('a call that is not an on-chain action → 422, no facilitator call', async () => {
      const res = await post(host.url, { call: { tool: 'read_file', args: { path: '/etc/hosts' } }, noExpiry: true }, { 'payment-signature': 'ignored' });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe('not-an-action');
      expect(facilitator.calls).toEqual([]);
    });

    it('a backend failure after settlement → job failed with payment charged-failed', async () => {
      process.env.FAKE_PROVER_EXIT = '1';
      const required = decodePaymentRequiredHeader((await post(host.url, CLEAN_BODY)).headers.get('payment-required')!);
      const res = await post(host.url, CLEAN_BODY, { 'payment-signature': paymentHeader(required, 'good') });
      expect(res.status).toBe(202);
      const { id } = await res.json() as { id: string };
      const failed = await waitFor(async () => (await (await fetch(`${host.url}/jobs/${id}`)).json()) as Record<string, unknown>, (j) => j.status === 'failed');
      expect(failed.payment).toMatchObject({ status: 'charged-failed', payer: PAYER });
      expect((failed.error as { code: string }).code).toBe('ProverExitError');
      const att = await fetch(`${host.url}/jobs/${id}/attestation`);
      expect(att.status).toBe(409);
      expect(facilitator.calls.map((c) => c.path)).toEqual(['/verify', '/settle']); // settled once, never again
    });

    it('bad requests are 400 and cost nothing', async () => {
      expect((await post(host.url, { payload: '%%%' })).status).toBe(400);
      expect((await post(host.url, { call: { tool: 'x' } })).status).toBe(400);
      expect((await post(host.url, { call: CLEAN_CALL, expirySlot: 'soon' })).status).toBe(400);
      expect((await post(host.url, { call: CLEAN_CALL, expirySlot: 5, noExpiry: true })).status).toBe(400);
      expect((await post(host.url, { call: CLEAN_CALL, nonce: '0x12' })).status).toBe(400);
      expect((await fetch(`${host.url}/jobs/j_doesnotexist000`)).status).toBe(404);
      expect((await fetch(`${host.url}/nope`)).status).toBe(404);
      expect(facilitator.calls).toEqual([]);
    });
  });

  describe('billing off (price 0)', () => {
    it('queues a clean payload without payment and never talks to the facilitator', async () => {
      const dir = tmpDir();
      const host = await startHost({ facilitatorUrl: facilitator.url, dataDir: dir, priceUsdc: '0' });
      try {
        expect(host.billing).toBeUndefined();
        expect(((await (await fetch(`${host.url}/healthz`)).json()) as { billing: string }).billing).toBe('off');
        // raw payload bytes, base64: the exact bytes are what is hashed
        const payload = Buffer.from(JSON.stringify(CLEAN_CALL)).toString('base64');
        const res = await post(host.url, { payload, noExpiry: true });
        expect(res.status).toBe(202);
        const job = await res.json() as { id: string; payment: { status: string }; expirySlot: string };
        expect(job.payment).toEqual({ status: 'not-billed' });
        expect(job.expirySlot).toBe('2000000000');
        await waitFor(async () => (await (await fetch(`${host.url}/jobs/${job.id}`)).json()) as { status: string }, (j) => j.status === 'done');
        expect(await (await fetch(`${host.url}/jobs/${job.id}/attestation`)).json()).toEqual(fixtureAttestation());
        expect(facilitator.calls).toEqual([]);
      } finally { await host.close(); rmTmp(dir); }
    });
  });
});
