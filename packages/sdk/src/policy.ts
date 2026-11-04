/**
 * Stateless action policy and the v2 policy root (release 0.8.0). Mirror of detector-core
 * `action_policy.rs`; both run evals/vectors/action-policy.json.
 *
 *   actionPolicyHash = sha256("blindseal.action-policy.v1"
 *                             ‖ u32le |R| ‖ R…  ‖ u8 hasMax ‖ u64le max  ‖ u32le |P| ‖ P…
 *                             ‖ u32le |I| ‖ I…  ‖ u32le |M| ‖ M…)
 *   policyRoot       = sha256("blindseal.policy.v2" ‖ rulesRoot ‖ actionPolicyHash)
 *
 * Lists are sorted by their bytes and deduplicated before hashing and checking. "No maximum" is
 * `maxAmount: null` (hasMax = 0), never 0. The native asset is the all-zero key
 * 11111111111111111111111111111111. An empty list means no constraint on that field.
 */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

export const ACTION_POLICY_DOMAIN = 'blindseal.action-policy.v1';
export const POLICY_V2_DOMAIN = 'blindseal.policy.v2';
/** Merkle root over the committed L1 rule DFAs (detector-core `policy_root_from_serialized`): the 0.7
 *  policy root, and the `rulesRoot` input of every 0.8.0 policy root. */
export const RULES_ROOT = '0x36a9e9457db6ecfd752a379fc9279ad6a0acfea07928f61e2f3638a685c38397';

/** The policy file format (`blindseal attest --action-policy`, `blindseal-prover --action-policy`). */
export interface ActionPolicyJson {
  recipients?: string[];      // base58
  maxAmount?: string | number | null;
  targetPrograms?: string[];  // base58
  instructions?: string[];    // 0x + 16 hex
  mints?: string[];           // base58; the native asset is 11111111111111111111111111111111
}

export interface ActionPolicy {
  recipients: Uint8Array[];
  maxAmount: bigint | null;
  targetPrograms: Uint8Array[];
  instructions: Uint8Array[];
  mints: Uint8Array[];
}

export interface PolicyAction {
  targetProgram: Uint8Array;
  instruction: Uint8Array;
  recipient: Uint8Array;
  mint: Uint8Array;
  amount: bigint;
}

export type PolicyErrorCode =
  | 'recipient-not-allowed' | 'amount-over-max' | 'target-program-not-allowed' | 'instruction-not-allowed' | 'mint-not-allowed';

export const EMPTY_ACTION_POLICY: ActionPolicy = { recipients: [], maxAmount: null, targetPrograms: [], instructions: [], mints: [] };

const KEYS = ['recipients', 'maxAmount', 'targetPrograms', 'instructions', 'mints'];
const U64_MAX = (1n << 64n) - 1n;

function cmp(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
function canon(v: Uint8Array[]): Uint8Array[] {
  const s = [...v].sort(cmp);
  return s.filter((x, i) => i === 0 || cmp(x, s[i - 1]!) !== 0);
}
const eq = (a: Uint8Array, b: Uint8Array) => cmp(a, b) === 0;
const has = (list: Uint8Array[], x: Uint8Array) => list.some((y) => eq(y, x));

export function canonicalPolicy(p: ActionPolicy): ActionPolicy {
  return { recipients: canon(p.recipients), maxAmount: p.maxAmount, targetPrograms: canon(p.targetPrograms), instructions: canon(p.instructions), mints: canon(p.mints) };
}

/** Parse the policy file format; unknown keys and malformed entries throw (as the prover refuses them). */
export function parseActionPolicy(j: ActionPolicyJson): ActionPolicy {
  if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new Error('action policy: not a JSON object');
  for (const k of Object.keys(j)) if (!KEYS.includes(k)) throw new Error(`action policy: unknown key ${JSON.stringify(k)}`);
  const keys = (k: 'recipients' | 'targetPrograms' | 'mints'): Uint8Array[] => {
    const v = j[k];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new Error(`action policy: ${k}: expected an array`);
    return v.map((s) => {
      if (typeof s !== 'string') throw new Error(`action policy: ${k}: entries are base58 strings`);
      return new PublicKey(s).toBytes();
    });
  };
  let instructions: Uint8Array[] = [];
  if (j.instructions !== undefined && j.instructions !== null) {
    if (!Array.isArray(j.instructions)) throw new Error('action policy: instructions: expected an array');
    instructions = j.instructions.map((s) => {
      const h = typeof s === 'string' ? s.replace(/^0x/, '') : '';
      if (!/^[0-9a-fA-F]{16}$/.test(h)) throw new Error(`action policy: instructions: ${String(s)} is not 8 bytes of hex`);
      return Uint8Array.from(Buffer.from(h, 'hex'));
    });
  }
  let maxAmount: bigint | null = null;
  const m = j.maxAmount;
  if (typeof m === 'string' && /^[0-9]+$/.test(m)) maxAmount = BigInt(m);
  else if (typeof m === 'number' && Number.isSafeInteger(m) && m >= 0) maxAmount = BigInt(m);
  else if (m !== undefined && m !== null) throw new Error('action policy: maxAmount: a decimal string, a number or null');
  if (maxAmount !== null && maxAmount > U64_MAX) throw new Error('action policy: maxAmount: not a u64');
  return canonicalPolicy({ recipients: keys('recipients'), maxAmount, targetPrograms: keys('targetPrograms'), instructions, mints: keys('mints') });
}

function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function u64le(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; }

export function actionPolicyHash(p: ActionPolicy): Uint8Array {
  const c = canonicalPolicy(p);
  const h = createHash('sha256').update(ACTION_POLICY_DOMAIN);
  h.update(u32le(c.recipients.length)); for (const r of c.recipients) h.update(r);
  h.update(Buffer.from([c.maxAmount === null ? 0 : 1])); h.update(u64le(c.maxAmount ?? 0n));
  h.update(u32le(c.targetPrograms.length)); for (const x of c.targetPrograms) h.update(x);
  h.update(u32le(c.instructions.length)); for (const x of c.instructions) h.update(x);
  h.update(u32le(c.mints.length)); for (const x of c.mints) h.update(x);
  return new Uint8Array(h.digest());
}

const hex32 = (s: string) => { const h = s.replace(/^0x/i, ''); if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error(`not 32-byte hex: ${s}`); return Buffer.from(h, 'hex'); };

/** policyRoot = sha256("blindseal.policy.v2" ‖ rulesRoot ‖ actionPolicyHash), as 0x-hex. */
export function policyRootV2(rulesRoot: string, policyHash: Uint8Array): string {
  return '0x' + createHash('sha256').update(POLICY_V2_DOMAIN).update(hex32(rulesRoot)).update(policyHash).digest('hex');
}

/** The policy root a proof under `policy` (and the committed rules) carries. */
export function policyRootFor(policy: ActionPolicy = EMPTY_ACTION_POLICY, rulesRoot: string = RULES_ROOT): string {
  return policyRootV2(rulesRoot, actionPolicyHash(policy));
}

/** First violated constraint, in the guest's order (recipient, amount, program, instruction, mint). */
export function checkActionPolicy(p: ActionPolicy, a: PolicyAction): PolicyErrorCode | null {
  if (p.recipients.length && !has(p.recipients, a.recipient)) return 'recipient-not-allowed';
  if (p.maxAmount !== null && a.amount > p.maxAmount) return 'amount-over-max';
  if (p.targetPrograms.length && !has(p.targetPrograms, a.targetProgram)) return 'target-program-not-allowed';
  if (p.instructions.length && !has(p.instructions, a.instruction)) return 'instruction-not-allowed';
  if (p.mints.length && !has(p.mints, a.mint)) return 'mint-not-allowed';
  return null;
}
