// Regenerates evals/vectors/action-binding.json: payload → bound action (or refusal code), computed
// by the proxy's TypeScript binding (packages/proxy/src/chain/action-binding.ts). The Rust
// implementation the guest runs (crates/detector-core/tests/action_binding_vectors.rs) and the proxy
// test (packages/proxy/test/action-binding.test.ts) both assert they reproduce every vector.
//   pnpm -C packages/proxy exec tsx ../../evals/action-binding/generate.ts
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { actionFromPayload, BindError } from '../../packages/proxy/src/chain/action-binding.js';

const SRC = 'Zv5PpLYUkScw7BUCbPhREpDXbdkJ21qMpsu54vYr1E4';
const DST = '7yWHC82fn96N6XTJBXdwkSBQHtLZZJTjr4SxXtGLQM24';
const OTHER = '9H7xb7EXzwQ5RFmA2qWnNhML9geLjDFrZwhJYxCUVQzf';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PROG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const call = (tool: unknown, args: unknown) => JSON.stringify({ tool, args });
const base = { to: DST, lamports: 1000000, from: SRC };

const cases: Array<[string, string]> = [
  ['transfer_sol (the attest shape)', call('transfer_sol', { ...base, memo: 'invoice 2026-10 settlement' })],
  ['mainnet sample tool call', call('transfer_sol', { to: '6HwAr9cu97PENQ727LhLErACyGznWyenKpsfTVQ5rmXo', lamports: 1000000, from: 'GdPZNkh4Ugt3PCauGtUdNVDXsxDHFigbGqy4gjYGNC3L', memo: 'blindseal mainnet sample: one gated 0.001 SOL transfer from the demo wallet' })],
  ['string amount', call('send', { recipient: DST, amount: '42', authority: SRC })],
  ['u64 max string amount', call('pay', { to: DST, amount: '18446744073709551615', from: SRC })],
  ['leading-zero string amount', call('pay', { to: DST, amount: '007', from: SRC })],
  ['max safe integer amount', call('pay', { to: DST, amount: 9007199254740991, from: SRC })],
  ['zero amount', call('pay', { to: DST, amount: 0, from: SRC })],
  ['priority: recipient outranks to', call('transfer', { to: OTHER, recipient: DST, lamports: 5, from: SRC })],
  ['priority: authority outranks from', call('transfer', { to: DST, lamports: 5, from: OTHER, authority: SRC })],
  ['priority: empty string skipped', call('transfer', { recipient: '', to: DST, lamports: 5, from: SRC })],
  ['priority: boolean skipped', call('transfer', { recipient: true, to: DST, lamports: 5, from: SRC })],
  ['duplicate keys: last wins', `{"tool":"transfer_sol","args":{"to":"${OTHER}","to":"${DST}","lamports":1000000,"from":"${SRC}"}}`],
  ['mint present', call('spl_transfer', { to: DST, amount: '5', from: SRC, mint: MINT })],
  ['explicit program, non-transfer tool name', call('execute', { program: PROG, to: DST, amount: 5, owner: SRC })],
  ['explicit instruction name', call('transfer_sol', { ...base, instruction: 'transfer' })],
  ['explicit instruction hex', call('transfer_sol', { ...base, instruction: '0x981894646560FC2B' })],
  ['method key', call('transfer_sol', { ...base, method: 'gated_transfer' })],
  ['empty instruction falls back to method', call('transfer_sol', { ...base, instruction: '', method: 'x' })],
  ['tool: SendSol is not transfer-shaped', call('SendSol', base)],
  ['tool: token.transfer', call('token.transfer', base)],
  ['tool: transferChecked', call('transferChecked', base)],
  ['tool: transfers', call('transfers', base)],
  ['tool: repay', call('repay', base)],
  ['tool: x-send-y', call('x-send-y', base)],
  ['tool: TRANSFER', call('TRANSFER', base)],
  ['tool: non-ASCII before word', call('ésend', base)],
  ['not an action: read_file', call('read_file', { path: '/etc/hosts' })],
  ['missing recipient', call('transfer_sol', { lamports: 1, from: SRC })],
  ['missing amount', call('transfer_sol', { to: DST, from: SRC })],
  ['missing source authority', call('transfer_sol', { to: DST, lamports: 1 })],
  ['bad recipient (short base58)', call('transfer_sol', { to: '5', lamports: 1, from: SRC })],
  ['bad recipient (number)', call('transfer_sol', { to: 12, lamports: 1, from: SRC })],
  ['bad recipient (not base58)', call('transfer_sol', { to: '0OIl', lamports: 1, from: SRC })],
  ['bad source authority', call('transfer_sol', { to: DST, lamports: 1, from: 'nope' })],
  ['bad mint', call('transfer_sol', { ...base, mint: 'x' })],
  ['bad program', call('transfer_sol', { ...base, program: 'x' })],
  ['amount above 2^53-1', call('pay', { to: DST, amount: 9007199254740992, from: SRC })],
  ['fractional amount', call('pay', { to: DST, amount: 1.5, from: SRC })],
  ['negative amount', call('pay', { to: DST, amount: -1, from: SRC })],
  ['negative zero amount', `{"tool":"pay","args":{"to":"${DST}","amount":-0,"from":"${SRC}"}}`],
  ['exponent amount', `{"tool":"pay","args":{"to":"${DST}","amount":1e3,"from":"${SRC}"}}`],
  ['string amount with sign', call('pay', { to: DST, amount: '+5', from: SRC })],
  ['string amount with space', call('pay', { to: DST, amount: ' 5', from: SRC })],
  ['string amount above u64', call('pay', { to: DST, amount: '18446744073709551616', from: SRC })],
  ['fractional-looking integer amount', `{"tool":"pay","args":{"to":"${DST}","amount":1.0,"from":"${SRC}"}}`],
  ['exponent amount above 2^53-1', `{"tool":"pay","args":{"to":"${DST}","amount":9.007199254740992e15,"from":"${SRC}"}}`],
  ['unparseable: number overflows f64 (in memo)', `{"tool":"transfer_sol","args":{"to":"${DST}","lamports":1,"from":"${SRC}","memo":1e400}}`],
  ['unparseable: lone surrogate in memo', `{"tool":"transfer_sol","args":{"to":"${DST}","lamports":1,"from":"${SRC}","memo":"\\ud800"}}`],
  ['paired surrogate escape is fine', `{"tool":"transfer_sol","args":{"to":"${DST}","lamports":1,"from":"${SRC}","memo":"\\ud83d\\ude00"}}`],
  ['127 nested containers parse', `{"tool":"transfer_sol","args":{"to":"${DST}","lamports":1,"from":"${SRC}","memo":${'['.repeat(125)}${']'.repeat(125)}}}`],
  ['unparseable: 128 nested containers', `{"tool":"transfer_sol","args":{"to":"${DST}","lamports":1,"from":"${SRC}","memo":${'['.repeat(126)}${']'.repeat(126)}}}`],
  ['unparseable: not JSON', 'transfer 1 SOL to ' + DST],
  ['unparseable: array', '[]'],
  ['unparseable: missing args', JSON.stringify({ tool: 'transfer_sol' })],
  ['unparseable: args is an array', call('transfer_sol', [])],
  ['unparseable: tool not a string', call(7, base)],
  ['unparseable: extra top-level key', JSON.stringify({ tool: 'transfer_sol', args: base, chain: 'solana' })],
];

const vectors = cases.map(([name, payload]) => {
  try {
    return { name, payload, action: actionFromPayload(payload) };
  } catch (e) {
    if (e instanceof BindError) return { name, payload, error: e.code };
    throw e;
  }
});
const out = path.join(import.meta.dirname, '../vectors/action-binding.json');
writeFileSync(out, JSON.stringify({
  note: 'payload → bound action (or refusal code). Generated by evals/action-binding/generate.ts; checked by the Rust binding (detector-core) and the proxy test.',
  vectors,
}, null, 2) + '\n');
console.log(`wrote ${vectors.length} vectors → ${out}`);
