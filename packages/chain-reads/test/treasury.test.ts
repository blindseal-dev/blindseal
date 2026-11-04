// node --test. The treasury reader: memo classification, jsonParsed transfers and burns → rows, the
// dogfood wallet labelled and left out of every total, and the snapshot's three states (not
// configured · RPC off · live). No network: fetch is stubbed with crafted mainnet-shaped answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  USDC_MINT, classifyTreasuryMemo, parseTreasuryTransaction, treasuryTotals, getTreasurySnapshot, treasuryConfig,
  type ParsedTransaction,
} from '../src/index.ts';

// synthetic keys (valid base58, 32 bytes): the treasury, its USDC account, a buyer, the dogfood wallet
const TREASURY = '9H7xb7EXzwQ5RFmA2qWnNhML9geLjDFrZwhJYxCUVQzf';
const T_USDC = '7Y6qZk3kT8LBc6D1eVaMvNT4kY2QvGvmR9m4JxwQZf1c';
const BUYER = '4Nd1mY3kR6Q4pQ6hNqsEYQ4nTbmwkWz7Y8hVf2u5GdAt';
const BUYER_USDC = '3K3xW7Y5Z8qkC6hUqsC9jY1aLh7wR8vF2bQ4dNn6pLmE';
const DOG = '8cEaFxLb4RGs2g7B2V7qiZF4y4z8nWsUGnhJ6m1DqJCo';
const DOG_USDC = '6pJrd2T8Q3kmsEcY4bx9H1vLn7aWq5Zf3cNu8gVt2RhM';
const PROJECT_MINT = '5Ub1yYqJ7k3hRm2N8pZc6wTd4gXa9vLs1eFo3bQn7HtK';
const T_TOKEN = '2wQe7RkL9mZt4nXs6vYb1cHd8pGa3fJu5iTo0kNq2VeB';

const balances = (list: [string, string, string, number][]) => list.map(([pk, owner, mint, decimals], i) => ({ pk, b: { accountIndex: i, mint, owner, uiTokenAmount: { amount: '0', decimals } } }));
function tx(o: { sig: string; slot: number; memo?: string | null; ixs: unknown[]; accounts: [string, string, string, number][]; err?: unknown }): ParsedTransaction {
  const bal = balances(o.accounts);
  const ixs: unknown[] = [...o.ixs];
  if (o.memo != null) ixs.push({ program: 'spl-memo', programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: o.memo });
  return {
    slot: o.slot, blockTime: 1_762_200_000 + o.slot,
    transaction: { signatures: [o.sig], message: { accountKeys: bal.map((x) => ({ pubkey: x.pk })), instructions: ixs as ParsedTransaction['transaction']['message']['instructions'] } },
    meta: { err: o.err ?? null, postTokenBalances: bal.map((x) => x.b) },
  };
}
const transfer = (source: string, destination: string, amount: string, authority: string, checked = false) => ({
  program: 'spl-token', programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  parsed: checked
    ? { type: 'transferChecked', info: { source, destination, mint: USDC_MINT, authority, tokenAmount: { amount, decimals: 6 } } }
    : { type: 'transfer', info: { source, destination, amount, authority } },
});
const burn = (account: string, mint: string, amount: string, authority: string) => ({
  program: 'spl-token', programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  parsed: { type: 'burnChecked', info: { account, mint, authority, tokenAmount: { amount, decimals: 9 } } },
});
const USDC_ACCTS: [string, string, string, number][] = [[T_USDC, TREASURY, USDC_MINT, 6], [BUYER_USDC, BUYER, USDC_MINT, 6]];
const ctx = { treasury: TREASURY, tokenAccounts: new Set([T_USDC]), dogfood: DOG };

test('memo classification: the first word after blindseal: decides; anything else is other', () => {
  assert.equal(classifyTreasuryMemo('blindseal:proof'), 'proof');
  assert.equal(classifyTreasuryMemo('  blindseal:payout job-42 '), 'payout');
  assert.equal(classifyTreasuryMemo('blindseal:buyback'), 'buyback');
  assert.equal(classifyTreasuryMemo('blindseal:burn 2026-11'), 'burn');
  assert.equal(classifyTreasuryMemo('blindseal:Proof'), 'other');      // case matters
  assert.equal(classifyTreasuryMemo('blindseal:refund'), 'other');
  assert.equal(classifyTreasuryMemo('thanks'), 'other');
  assert.equal(classifyTreasuryMemo(null), 'other');
  assert.equal(classifyTreasuryMemo(undefined), 'other');
});

test('a proof purchase: USDC into the treasury account, counterparty = the payer wallet', () => {
  const rows = parseTreasuryTransaction(tx({ sig: 'S1', slot: 10, memo: 'blindseal:proof att-1', ixs: [transfer(BUYER_USDC, T_USDC, '5000000', BUYER)], accounts: USDC_ACCTS }), ctx);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { signature: 'S1', slot: 10, blockTime: 1_762_200_010, kind: 'proof', direction: 'in', amount: '5000000', decimals: 6, mint: USDC_MINT, counterparty: BUYER, memo: 'blindseal:proof att-1', internal: false });
});

test('a payout and a buyback: USDC out, transferChecked carries the mint and decimals', () => {
  const pay = parseTreasuryTransaction(tx({ sig: 'S2', slot: 11, memo: 'blindseal:payout', ixs: [transfer(T_USDC, BUYER_USDC, '1250000', TREASURY, true)], accounts: USDC_ACCTS }), ctx);
  assert.equal(pay[0]!.direction, 'out'); assert.equal(pay[0]!.kind, 'payout'); assert.equal(pay[0]!.counterparty, BUYER);
  const buy = parseTreasuryTransaction(tx({ sig: 'S3', slot: 12, memo: 'blindseal:buyback', ixs: [transfer(T_USDC, BUYER_USDC, '99', TREASURY)], accounts: USDC_ACCTS }), ctx);
  assert.equal(buy[0]!.kind, 'buyback'); assert.equal(buy[0]!.direction, 'out');
});

test('a burn of the project token signed by the treasury is a burn row; counterparty is the mint', () => {
  const rows = parseTreasuryTransaction(tx({ sig: 'S4', slot: 13, memo: 'blindseal:burn', ixs: [burn(T_TOKEN, PROJECT_MINT, '7000000000', TREASURY)], accounts: [[T_TOKEN, TREASURY, PROJECT_MINT, 9]] }), ctx);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.direction, 'burn'); assert.equal(rows[0]!.mint, PROJECT_MINT); assert.equal(rows[0]!.counterparty, PROJECT_MINT); assert.equal(rows[0]!.decimals, 9);
});

test('no memo → other; a failed transaction, a self transfer and another mint produce no rows', () => {
  const other = parseTreasuryTransaction(tx({ sig: 'S5', slot: 14, ixs: [transfer(BUYER_USDC, T_USDC, '1', BUYER)], accounts: USDC_ACCTS }), ctx);
  assert.equal(other[0]!.kind, 'other'); assert.equal(other[0]!.memo, null);
  assert.deepEqual(parseTreasuryTransaction(tx({ sig: 'S6', slot: 15, memo: 'blindseal:proof', ixs: [transfer(BUYER_USDC, T_USDC, '1', BUYER)], accounts: USDC_ACCTS, err: { InstructionError: [0, 'Custom'] } }), ctx), []);
  assert.deepEqual(parseTreasuryTransaction(tx({ sig: 'S7', slot: 16, memo: 'blindseal:proof', ixs: [transfer(T_USDC, T_USDC, '1', TREASURY)], accounts: USDC_ACCTS }), ctx), []);
  assert.deepEqual(parseTreasuryTransaction(tx({ sig: 'S8', slot: 17, memo: 'blindseal:proof', ixs: [transfer(BUYER_USDC, T_TOKEN, '1', BUYER)], accounts: [[BUYER_USDC, BUYER, PROJECT_MINT, 9], [T_TOKEN, TREASURY, PROJECT_MINT, 9]] }), ctx), []);
});

test('the dogfood wallet is labelled internal and excluded from every total', () => {
  const rows = [
    ...parseTreasuryTransaction(tx({ sig: 'S1', slot: 10, memo: 'blindseal:proof', ixs: [transfer(BUYER_USDC, T_USDC, '5000000', BUYER)], accounts: USDC_ACCTS }), ctx),
    ...parseTreasuryTransaction(tx({ sig: 'S9', slot: 18, memo: 'blindseal:proof', ixs: [transfer(DOG_USDC, T_USDC, '5000000', DOG)], accounts: [[T_USDC, TREASURY, USDC_MINT, 6], [DOG_USDC, DOG, USDC_MINT, 6]] }), ctx),
    ...parseTreasuryTransaction(tx({ sig: 'S2', slot: 11, memo: 'blindseal:payout', ixs: [transfer(T_USDC, BUYER_USDC, '1250000', TREASURY, true)], accounts: USDC_ACCTS }), ctx),
    ...parseTreasuryTransaction(tx({ sig: 'S10', slot: 19, memo: 'blindseal:payout', ixs: [transfer(T_USDC, DOG_USDC, '1', TREASURY)], accounts: [[T_USDC, TREASURY, USDC_MINT, 6], [DOG_USDC, DOG, USDC_MINT, 6]] }), ctx),
    ...parseTreasuryTransaction(tx({ sig: 'S3', slot: 12, memo: 'blindseal:buyback', ixs: [transfer(T_USDC, BUYER_USDC, '99', TREASURY)], accounts: USDC_ACCTS }), ctx),
    ...parseTreasuryTransaction(tx({ sig: 'S4', slot: 13, memo: 'blindseal:burn', ixs: [burn(T_TOKEN, PROJECT_MINT, '7000000000', TREASURY)], accounts: [[T_TOKEN, TREASURY, PROJECT_MINT, 9]] }), ctx),
    ...parseTreasuryTransaction(tx({ sig: 'S5', slot: 14, ixs: [transfer(BUYER_USDC, T_USDC, '1', BUYER)], accounts: USDC_ACCTS }), ctx),
  ];
  assert.equal(rows.filter((r) => r.internal).length, 2);
  assert.ok(rows.find((r) => r.signature === 'S9')!.internal);
  assert.ok(rows.find((r) => r.signature === 'S10')!.internal);
  assert.deepEqual(treasuryTotals(rows), { proofs: 1, collected: '5000000', paidOut: '1250000', buybacks: '99', burns: 1, burned: [{ mint: PROJECT_MINT, amount: '7000000000', decimals: 9 }] });
});

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return fn().finally(() => { for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });
}

test('not configured: no BLINDSEAL_TREASURY → configured false, no read, no error', () =>
  withEnv({ BLINDSEAL_TREASURY: undefined, BLINDSEAL_DOGFOOD_WALLET: undefined, BLINDSEAL_RPC_URL: 'http://rpc.invalid' }, async () => {
    const real = globalThis.fetch; let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error('no network'); }) as typeof fetch;
    try {
      const s = await getTreasurySnapshot();
      assert.equal(s.configured, false); assert.equal(s.live, false); assert.equal(s.error, undefined); assert.deepEqual(s.rows, []);
      assert.equal(calls, 0);
      assert.deepEqual(treasuryConfig(), { treasury: null, dogfood: null });
    } finally { globalThis.fetch = real; }
  }));

test('a value that is not a public key is ignored (logged once)', () =>
  withEnv({ BLINDSEAL_TREASURY: 'not-a-key', BLINDSEAL_DOGFOOD_WALLET: DOG }, async () => {
    assert.deepEqual(treasuryConfig(), { treasury: null, dogfood: DOG });
  }));

test('configured with BLINDSEAL_RPC_URL=off → RPC_OFF offline snapshot', () =>
  withEnv({ BLINDSEAL_TREASURY: TREASURY, BLINDSEAL_RPC_URL: 'off' }, async () => {
    const s = await getTreasurySnapshot();
    assert.equal(s.configured, true); assert.equal(s.live, false); assert.equal(s.error?.code, 'RPC_OFF'); assert.equal(s.rpc, 'off'); assert.equal(s.treasury, TREASURY);
  }));

test('live: token accounts → signatures (wallet + account, deduplicated) → parsed rows and totals', () =>
  withEnv({ BLINDSEAL_TREASURY: TREASURY, BLINDSEAL_DOGFOOD_WALLET: DOG, BLINDSEAL_RPC_URL: 'http://rpc.invalid' }, async () => {
    const real = globalThis.fetch;
    const seen: string[] = [];
    const TXS: Record<string, ParsedTransaction> = {
      S1: tx({ sig: 'S1', slot: 10, memo: 'blindseal:proof', ixs: [transfer(BUYER_USDC, T_USDC, '5000000', BUYER)], accounts: USDC_ACCTS }),
      S4: tx({ sig: 'S4', slot: 13, memo: 'blindseal:burn', ixs: [burn(T_TOKEN, PROJECT_MINT, '7000000000', TREASURY)], accounts: [[T_TOKEN, TREASURY, PROJECT_MINT, 9]] }),
      S9: tx({ sig: 'S9', slot: 18, memo: 'blindseal:proof', ixs: [transfer(DOG_USDC, T_USDC, '5000000', DOG)], accounts: [[T_USDC, TREASURY, USDC_MINT, 6], [DOG_USDC, DOG, USDC_MINT, 6]] }),
    };
    globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
      const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      seen.push(method);
      let result: unknown;
      if (method === 'getSlot') result = 470_000_000;
      else if (method === 'getTokenAccountsByOwner') { assert.equal(params[0], TREASURY); result = { value: [{ pubkey: T_USDC }] }; }
      else if (method === 'getSignaturesForAddress') {
        result = params[0] === TREASURY
          ? [{ signature: 'S4', slot: 13, blockTime: null, err: null }, { signature: 'S1', slot: 10, blockTime: null, err: null }]   // the burn is signed by the wallet; S1 is indexed under both
          : [{ signature: 'S9', slot: 18, blockTime: null, err: null }, { signature: 'S1', slot: 10, blockTime: null, err: null }, { signature: 'SF', slot: 9, blockTime: null, err: { x: 1 } }];
      } else if (method === 'getTransaction') result = TXS[params[0] as string] ?? null;
      else throw new Error('unexpected ' + method);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
    }) as typeof fetch;
    try {
      const s = await getTreasurySnapshot();
      assert.equal(s.live, true); assert.equal(s.slot, 470_000_000);
      assert.deepEqual(s.rows.map((r) => r.signature), ['S9', 'S4', 'S1']);          // newest first
      assert.equal(s.source.signaturesScanned, 3);                                  // S1 once, the failed SF dropped
      assert.equal(seen.filter((m) => m === 'getTransaction').length, 3);
      assert.deepEqual(s.totals, { proofs: 1, collected: '5000000', paidOut: '0', buybacks: '0', burns: 1, burned: [{ mint: PROJECT_MINT, amount: '7000000000', decimals: 9 }] });
      // cached: a second call reads nothing
      const n = seen.length; await getTreasurySnapshot(); assert.equal(seen.length, n);
    } finally { globalThis.fetch = real; }
  }));
