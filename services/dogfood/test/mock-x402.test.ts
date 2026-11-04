/// The x402-solana client against the in-process merchant: a full 402 → pay → 200 round trip with an
/// ephemeral wallet and the mock RPC. No network, no funds.
import { describe, it, expect, afterEach } from 'vitest';
import { Keypair, type VersionedTransaction } from '@solana/web3.js';
import { createX402Client } from 'x402-solana/client';
import { MOCK_PAY_TO, startMockX402Server, type MockX402Server, CLEAN_BODY } from '../src/mock/x402-server.js';
import { decodeReceiptHeader } from '../src/x402-receipt.js';

let mock: MockX402Server | undefined;
afterEach(async () => { await mock?.close(); mock = undefined; });

function client(mock: MockX402Server, kp: Keypair, amount: bigint, beforePayment?: Parameters<typeof createX402Client>[0]['beforePayment']) {
  return createX402Client({
    wallet: { address: kp.publicKey.toBase58(), signTransaction: async (tx: VersionedTransaction) => { tx.sign([kp]); return tx; } },
    network: 'solana',
    rpcUrl: mock.rpcUrl,
    amount,
    ...(beforePayment ? { beforePayment } : {}),
  });
}

describe('x402 purchase against the mock merchant', () => {
  it('answers 402, accepts the signed payment and returns the body with a receipt', async () => {
    mock = await startMockX402Server({ priceAtomic: '10000' });
    const kp = Keypair.generate();
    const plain = await fetch(mock.resourceUrl);
    expect(plain.status).toBe(402);
    expect(plain.headers.get('payment-required')).toBeTruthy();

    const res = await client(mock, kp, 100_000n).fetch(mock.resourceUrl);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { body: string };
    expect(body.body).toBe(CLEAN_BODY);
    const receipt = decodeReceiptHeader(res.headers) as { success: boolean; payer: string; transaction: string };
    expect(receipt.success).toBe(true);
    expect(receipt.payer).toBe(kp.publicKey.toBase58());
    expect(receipt.transaction).toMatch(/^dry-run:[0-9a-f]{64}$/);
    expect(mock.payments).toHaveLength(1);
    expect(mock.payments[0]!.payTo).toBe(MOCK_PAY_TO);
  });

  it('the client refuses a price above the cap before signing anything', async () => {
    mock = await startMockX402Server({ priceAtomic: '500000' });
    const kp = Keypair.generate();
    await expect(client(mock, kp, 100_000n).fetch(mock.resourceUrl)).rejects.toThrow(/exceeds maximum/);
    expect(mock.payments).toHaveLength(0);
  });

  it('a beforePayment allowlist refuses an unknown payTo', async () => {
    mock = await startMockX402Server();
    const kp = Keypair.generate();
    const c = client(mock, kp, 0n, (req) => (req.payTo === MOCK_PAY_TO ? { abort: true, reason: 'not allowlisted' } : undefined));
    await expect(c.fetch(mock.resourceUrl)).rejects.toThrow(/not allowlisted/);
    expect(mock.payments).toHaveLength(0);
  });

  it('the merchant rejects a payment that is not signed by the payer', async () => {
    mock = await startMockX402Server();
    const payload = { x402Version: 2, accepted: { amount: '10000', payTo: MOCK_PAY_TO }, payload: { transaction: Buffer.from([1, 2, 3]).toString('base64') } };
    const res = await fetch(mock.resourceUrl, { headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payload)).toString('base64') } });
    expect(res.status).toBe(400);
  });
});
