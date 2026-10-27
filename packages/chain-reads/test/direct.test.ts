// node --test. A Nullifier whose consumer_program is Pubkey::default() is a DIRECT submission (no gated
// program): the raw value is kept, `direct: true` flags it, and it is never counted as a consumer program.
// No network: fetch is stubbed with crafted mainnet-shaped JSON-RPC answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  DIRECT_CONSUMER, isDirectConsumer, parseNullifierAccount, aggregateConsumers, splitConsumers,
  getNullifierStatus, getExplorerSnapshot,
} from '../src/index.ts';

const GATE = '9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s: string): Buffer {
  let n = 0n; for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const out: number[] = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  return Buffer.from(out);
}
const disc = (p: string) => createHash('sha256').update(p).digest().subarray(0, 8);
function nullifierAccount(consumer: Buffer, slot: number): Buffer {
  const b = Buffer.alloc(81); disc('account:Nullifier').copy(b, 0); b.writeBigUInt64LE(BigInt(slot), 8);
  consumer.copy(b, 16); b.fill(0xab, 48, 80); b[80] = 255; return b;
}
function consumedEvent(nf: number, consumer: Buffer): string {
  const b = Buffer.alloc(136); disc('event:Consumed').copy(b, 0); b.fill(nf, 8, 40); b.fill(0x11, 72, 104); consumer.copy(b, 104);
  return 'Program data: ' + b.toString('base64');
}
function stubRpc(answer: (method: string, params: unknown[]) => unknown) {
  const real = globalThis.fetch; const prev = process.env.BLINDSEAL_RPC_URL;
  process.env.BLINDSEAL_RPC_URL = 'http://rpc.invalid';
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
    const { method, params } = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: answer(method, params) }), { status: 200 });
  }) as typeof fetch;
  return () => { globalThis.fetch = real; if (prev === undefined) delete process.env.BLINDSEAL_RPC_URL; else process.env.BLINDSEAL_RPC_URL = prev; };
}

test('the default key is the direct-submission marker', () => {
  assert.equal(DIRECT_CONSUMER, '1'.repeat(32));
  assert.equal(isDirectConsumer(DIRECT_CONSUMER), true);
  assert.equal(isDirectConsumer(GATE), false);
  assert.equal(isDirectConsumer(undefined), false);
});

test('parseNullifierAccount keeps the raw consumer and flags the default key', () => {
  const d = parseNullifierAccount(nullifierAccount(Buffer.alloc(32), 460579127))!;
  assert.equal(d.consumerProgram, DIRECT_CONSUMER);
  assert.equal(d.direct, true);
  assert.equal(d.consumedAtSlot, 460579127);
  const g = parseNullifierAccount(nullifierAccount(b58decode(GATE), 1))!;
  assert.equal(g.consumerProgram, GATE);
  assert.equal(g.direct, false);
  assert.equal(parseNullifierAccount(Buffer.alloc(81)), null);
});

test('aggregateConsumers flags direct; splitConsumers counts only real programs', () => {
  const list = aggregateConsumers([GATE, DIRECT_CONSUMER, DIRECT_CONSUMER, GATE, GATE]);
  assert.deepEqual(list, [
    { programId: GATE, count: 3, name: 'transfer-gate (example)' },
    { programId: DIRECT_CONSUMER, count: 2, direct: true },
  ]);
  const s = splitConsumers(list);
  assert.equal(s.programs.length, 1);
  assert.equal(s.programs[0]!.programId, GATE);
  assert.equal(s.direct, 2);
  assert.deepEqual(splitConsumers(aggregateConsumers([DIRECT_CONSUMER])), { programs: [], direct: 1 });
  // a snapshot from an older server (no `direct` flag) is still split on the raw value
  assert.deepEqual(splitConsumers([{ programId: DIRECT_CONSUMER, count: 4 }]), { programs: [], direct: 4 });
});

test('getNullifierStatus: a direct consumption reports the raw value and direct: true', async () => {
  const restore = stubRpc((m) => {
    assert.equal(m, 'getAccountInfo');
    return { value: { data: [nullifierAccount(Buffer.alloc(32), 99).toString('base64'), 'base64'] } };
  });
  try {
    const r = await getNullifierStatus('0x' + 'fe'.repeat(32));
    assert.equal(r.consumed, true);
    assert.equal(r.consumerProgram, DIRECT_CONSUMER);
    assert.equal(r.direct, true);
  } finally { restore(); }
  const restore2 = stubRpc(() => ({ value: { data: [nullifierAccount(b58decode(GATE), 99).toString('base64'), 'base64'] } }));
  try {
    const r = await getNullifierStatus('0x' + 'fe'.repeat(32));
    assert.equal(r.consumerProgram, GATE);
    assert.equal(r.direct, undefined);
  } finally { restore2(); }
});

test('getExplorerSnapshot: consumerPrograms keeps the direct entry, flagged', async () => {
  const restore = stubRpc((m) => {
    if (m === 'getSlot') return 460600000;
    if (m === 'getProgramAccounts') return [
      { pubkey: 'A', account: { data: [nullifierAccount(b58decode(GATE), 460579127).toString('base64'), 'base64'] } },
      { pubkey: 'B', account: { data: [nullifierAccount(Buffer.alloc(32), 460579200).toString('base64'), 'base64'] } },
    ];
    if (m === 'getSignaturesForAddress') return [{ signature: 's1', slot: 460579127, blockTime: 1761500000, err: null }, { signature: 's2', slot: 460579200, blockTime: 1761500100, err: null }];
    if (m === 'getTransaction') return { slot: 460579127, blockTime: 1761500000, meta: { err: null, logMessages: [consumedEvent(1, b58decode(GATE)), consumedEvent(2, Buffer.alloc(32))] } };
    throw new Error('unexpected ' + m);
  });
  try {
    const s = await getExplorerSnapshot();
    assert.equal(s.live, true);
    assert.equal(s.consumed.total, 2);
    const direct = s.consumerPrograms.find((p) => p.programId === DIRECT_CONSUMER)!;
    assert.equal(direct.direct, true);
    assert.equal(direct.name, undefined);
    assert.deepEqual(splitConsumers(s.consumerPrograms), { programs: [{ programId: GATE, count: 1, name: 'transfer-gate (example)' }], direct: 1 });
  } finally { restore(); }
});

test('the browser-safe mirror (consumers.ts) agrees with index.ts', async () => {
  const idx = await import('../src/index.ts');
  const mir = await import('../src/consumers.ts');
  assert.equal(mir.DIRECT_CONSUMER, idx.DIRECT_CONSUMER);
  assert.deepEqual(mir.KNOWN_PROGRAM_NAMES, idx.KNOWN_PROGRAM_NAMES);
  const input = [GATE, DIRECT_CONSUMER, 'So11111111111111111111111111111111111111112', GATE, DIRECT_CONSUMER, DIRECT_CONSUMER];
  assert.deepEqual(mir.aggregateConsumers(input), idx.aggregateConsumers(input));
  const list = idx.aggregateConsumers(input);
  assert.deepEqual(mir.splitConsumers(list), idx.splitConsumers(list));
  for (const v of [GATE, DIRECT_CONSUMER, undefined, null, '']) assert.equal(mir.isDirectConsumer(v), idx.isDirectConsumer(v));
});
