// Regenerates evals/vectors/action-policy.json: action policies → canonical actionPolicyHash, the v2
// policy root over the committed rules root, and the check outcome for a set of actions, computed by the
// SDK's TypeScript implementation (packages/sdk/src/policy.ts). The Rust implementation the guest runs
// (crates/detector-core/tests/action_policy_vectors.rs) asserts it reproduces every vector.
//   pnpm -C packages/proxy exec tsx ../../evals/action-policy/generate.ts
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import {
  actionPolicyHash, checkActionPolicy, parseActionPolicy, policyRootFor, RULES_ROOT, type ActionPolicyJson,
} from '../../packages/sdk/src/policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GATE = '9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa';
const DEMO_RECIPIENT = '6HwAr9cu97PENQ727LhLErACyGznWyenKpsfTVQ5rmXo';
const OTHER = '9H7xb7EXzwQ5RFmA2qWnNhML9geLjDFrZwhJYxCUVQzf';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NATIVE = '11111111111111111111111111111111';
const GATED = '0x981894646560fc2b';

const policies: Array<[string, ActionPolicyJson]> = [
  ['empty', {}],
  ['empty-explicit', { recipients: [], maxAmount: null, targetPrograms: [], instructions: [], mints: [] }],
  ['demo', { recipients: [DEMO_RECIPIENT], maxAmount: '10000000' }],
  ['max-zero', { maxAmount: '0' }],
  ['max-number', { maxAmount: 10000000 }],
  ['max-u64', { maxAmount: '18446744073709551615' }],
  ['recipients-unsorted-dup', { recipients: [OTHER, DEMO_RECIPIENT, OTHER] }],
  ['programs', { targetPrograms: [GATE] }],
  ['instructions', { instructions: [GATED, '0x0000000000000001'] }],
  ['mints-native', { mints: [NATIVE] }],
  ['mints-usdc', { mints: [USDC] }],
  ['everything', { recipients: [DEMO_RECIPIENT], maxAmount: '5000000', targetPrograms: [GATE], instructions: [GATED], mints: [NATIVE] }],
];

const b = (s: string) => new PublicKey(s).toBytes();
const actions: Array<[string, { targetProgram: string; instruction: string; recipient: string; mint: string; amount: string }]> = [
  ['sample', { targetProgram: GATE, instruction: GATED, recipient: DEMO_RECIPIENT, mint: NATIVE, amount: '1000000' }],
  ['other-recipient', { targetProgram: GATE, instruction: GATED, recipient: OTHER, mint: NATIVE, amount: '1000000' }],
  ['at-max', { targetProgram: GATE, instruction: GATED, recipient: DEMO_RECIPIENT, mint: NATIVE, amount: '10000000' }],
  ['over-max', { targetProgram: GATE, instruction: GATED, recipient: DEMO_RECIPIENT, mint: NATIVE, amount: '10000001' }],
  ['zero', { targetProgram: GATE, instruction: GATED, recipient: DEMO_RECIPIENT, mint: NATIVE, amount: '0' }],
  ['usdc', { targetProgram: GATE, instruction: GATED, recipient: DEMO_RECIPIENT, mint: USDC, amount: '1' }],
  ['other-program', { targetProgram: OTHER, instruction: GATED, recipient: DEMO_RECIPIENT, mint: NATIVE, amount: '1' }],
  ['other-instruction', { targetProgram: GATE, instruction: '0x0000000000000002', recipient: DEMO_RECIPIENT, mint: NATIVE, amount: '1' }],
];

const out = policies.map(([id, json]) => {
  const p = parseActionPolicy(json);
  return {
    id,
    policy: json,
    actionPolicyHash: '0x' + Buffer.from(actionPolicyHash(p)).toString('hex'),
    policyRoot: policyRootFor(p, RULES_ROOT),
    checks: Object.fromEntries(actions.map(([aid, a]) => [aid, checkActionPolicy(p, {
      targetProgram: b(a.targetProgram), instruction: Buffer.from(a.instruction.slice(2), 'hex'), recipient: b(a.recipient), mint: b(a.mint), amount: BigInt(a.amount),
    }) ?? 'ok'])),
  };
});
writeFileSync(path.join(ROOT, 'evals/vectors/action-policy.json'), JSON.stringify({ rulesRoot: RULES_ROOT, actions: Object.fromEntries(actions), policies: out }, null, 2) + '\n');
console.log(`wrote ${out.length} action-policy vectors; empty-policy root ${out[0]!.policyRoot}, demo root ${out[2]!.policyRoot}`);
