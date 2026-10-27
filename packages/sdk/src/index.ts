// Blindseal SDK. Mainnet is the only deploy target: chainId 1 = Solana
// mainnet, 2 is reserved. `submit()` refuses any RPC whose genesis hash is not mainnet-beta's.
// The verifier accepts verify_and_consume only as a CPI from the attestation's target program, so
// `submit()` sends the GATED transaction (transfer-gate's gated_transfer) and nothing else.
// Everything encoding-related lives in ix.ts; this file adds the Node-dependent pieces.
import { createRequire } from 'node:module';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, type Signer } from '@solana/web3.js';
import {
  CHAIN_ID_SOLANA_MAINNET, DEFAULT_RPC_URL, MAINNET_GENESIS_HASH, PROGRAM_ID, TRANSFER_GATE_ID, VERIFY_CU_LIMIT,
  actionArgsFrom, buildGatedTransferIx, decodePublicInputs, hex, nullifierPda, type Attestation, type DecodedPublicInputs,
} from './ix.js';
export * from './ix.js';

export class WrongClusterError extends Error {
  constructor(public readonly got: string) {
    super(`RPC genesis hash ${got} is not Solana mainnet-beta (${MAINNET_GENESIS_HASH}); refusing to send`);
  }
}

/** Thrown by `submit()` for an attestation whose target program is not transfer-gate. */
export class UnsupportedTargetError extends Error {
  constructor(public readonly targetProgram: string) {
    super(`attestation targets ${targetProgram || '(none)'}, not transfer-gate (${TRANSFER_GATE_ID.toBase58()}): submit through the target program; the verifier only accepts CPI from it`);
  }
}

export interface SubmitOptions {
  /** Signs and pays: must be the attestation's `action.sourceAuthority` (the gated transfer debits it). */
  wallet: Signer | Keypair;
  rpcUrl?: string;        // default BLINDSEAL_RPC_URL or the public mainnet endpoint
  connection?: Connection;
  policyRoot?: PublicKey | null;
  computeUnits?: number;
  /** Test hook only: skip the genesis guard (localnet). Never set in production. */
  allowNonMainnet?: boolean;
}

/**
 * Submit an attestation through its gated program: for a transfer-gate attestation, sends
 * `gated_transfer` (verify + consume + the screened transfer, atomically), signed by the source
 * authority wallet. The verifier accepts verify_and_consume only as a CPI from the attestation's
 * target program, so any other target throws `UnsupportedTargetError` — submit through that
 * program instead. Refuses any cluster whose genesis hash is not mainnet-beta's (chainId 1 is
 * the only chain). Every local check runs before the RPC is contacted.
 */
export async function submit(att: Attestation, opts: SubmitOptions): Promise<string> {
  if (att.chainId !== CHAIN_ID_SOLANA_MAINNET) throw new Error(`attestation chainId ${att.chainId} is not Solana mainnet (1)`);
  const action = actionArgsFrom(att);
  if (!action.targetProgram.equals(TRANSFER_GATE_ID)) throw new UnsupportedTargetError(att.action?.targetProgram ?? '');
  if (!action.sourceAuthority.equals(opts.wallet.publicKey)) {
    throw new Error(`wallet ${opts.wallet.publicKey.toBase58()} is not the attestation's source authority (${action.sourceAuthority.toBase58()}); the gated transfer must be signed by it`);
  }
  if (!action.mint.equals(PublicKey.default)) throw new Error('transfer-gate moves native SOL; this attestation names a mint');
  if (action.recipient.equals(PublicKey.default)) throw new Error('attestation has no recipient');
  const conn = opts.connection ?? new Connection(opts.rpcUrl ?? process.env.BLINDSEAL_RPC_URL ?? DEFAULT_RPC_URL, 'confirmed');
  if (!opts.allowNonMainnet) {
    const genesis = await conn.getGenesisHash();
    if (genesis !== MAINNET_GENESIS_HASH) throw new WrongClusterError(genesis);
  }
  const ix = buildGatedTransferIx(att, { source: opts.wallet.publicKey, recipient: action.recipient, policyRoot: opts.policyRoot });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnits ?? VERIFY_CU_LIMIT }), ix);
  tx.feePayer = opts.wallet.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(opts.wallet as Signer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
}

/** Has this attestation's nullifier been consumed on chain? */
export async function isConsumed(att: Attestation, conn: Connection, programId = PROGRAM_ID): Promise<boolean> {
  const { nullifier } = decodePublicInputs(hex(att.publicInputs[0]));
  const info = await conn.getAccountInfo(nullifierPda(nullifier, programId), 'confirmed');
  return info !== null;
}

/** Labeled top-level fields that must equal the committed public inputs. */
export const LABELED_FIELDS = ['payloadHash', 'policyRoot', 'detectorVersion', 'actionHash', 'nullifier', 'expirySlot'] as const;
export type LabeledField = (typeof LABELED_FIELDS)[number];

/**
 * Result of `verifyOffchain`.
 * - `ok`: true only if the Groth16 proof verifies AND every labeled field equals its decoded value.
 * - `reason`: present when `ok` is false — the wasm verifier's reason if the proof failed, otherwise
 *   `label mismatch: <field>[, <field>…]` (or the decode error if the blob is not 168 bytes).
 * - `decoded`: the six fields decoded from `publicInputs[0]`; present whenever the blob parses,
 *   even when the proof or the labels fail. Hex fields are 0x-prefixed lower-case; `expirySlot`
 *   is a decimal u64 string.
 * - `mismatches`: the labeled fields that differ from `decoded` (empty when none, or when the blob
 *   did not parse).
 */
export interface VerifyOffchainResult {
  ok: boolean;
  reason?: string;
  decoded?: DecodedPublicInputs;
  mismatches: string[];
}
/** @deprecated Use `VerifyOffchainResult`. */
export type VerifyResult = VerifyOffchainResult;

const normHex = (v: unknown): string => '0x' + String(v ?? '').trim().replace(/^0x/i, '').toLowerCase();
const normSlot = (v: unknown): string | null => {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? String(v) : null;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return BigInt(v.trim()).toString();
  return null;
};

/**
 * Compare the six labeled top-level fields of an attestation to the decoded committed blob.
 * Hex is compared case-insensitively with or without `0x`; `expirySlot` may be a number, bigint or
 * decimal string. A missing or malformed label counts as a mismatch. Returns the differing field
 * names in canonical order.
 */
export function labelMismatches(att: Partial<Record<LabeledField, unknown>>, decoded: DecodedPublicInputs): string[] {
  const out: string[] = [];
  for (const k of LABELED_FIELDS) {
    const same = k === 'expirySlot' ? normSlot(att.expirySlot) === decoded.expirySlot : normHex(att[k]) === decoded[k];
    if (!same) out.push(k);
  }
  return out;
}

let wasmReady: Promise<typeof import('blindseal-verifier-wasm')> | null = null;
const loadWasm = () => (wasmReady ??= (async () => {
  const wasm = await import('blindseal-verifier-wasm');
  const { readFileSync } = await import('node:fs');
  const req = createRequire(import.meta.url);
  wasm.initSync({ module: readFileSync(req.resolve('blindseal-verifier-wasm/bg.wasm')) });
  return wasm;
})().catch((e) => { wasmReady = null; throw e; }));

/**
 * Off-chain verify via the same wasm the verify pages use, then cross-check the labels.
 * 1. Decode `publicInputs[0]` into its six fields (see `decodePublicInputs`).
 * 2. Groth16 verify of `proof.bytes` against `publicInputs[0]`, using the DECODED `detectorVersion`
 *    as the vkey hash (the committed one — same as the on-chain program, which checks the vkey it
 *    verified with equals the blob's). The proof therefore stands or falls on the blob alone.
 * 3. Compare each labeled top-level field to the decoded value; any difference fails the result,
 *    because the proof binds only the blob — a tampered label would otherwise pass unnoticed.
 * Does NOT check expiry against the current slot, nullifier consumption or the on-chain allowlists.
 */
export async function verifyOffchain(att: Attestation): Promise<VerifyOffchainResult> {
  const wasm = await loadWasm();
  let decoded: DecodedPublicInputs | undefined;
  let decodeError: string | undefined;
  try {
    decoded = decodePublicInputs(String(att.publicInputs?.[0] ?? ''));
  } catch (e) {
    decodeError = e instanceof Error ? e.message : String(e);
  }
  const forWasm = decoded ? { ...att, detectorVersion: decoded.detectorVersion } : att;
  const proof = JSON.parse(wasm.verify_attestation_json(JSON.stringify(forWasm))) as { ok: boolean; reason: string | null };
  const mismatches = decoded ? labelMismatches(att, decoded) : [];
  if (!proof.ok) return { ok: false, reason: proof.reason ?? 'proof did not verify', decoded, mismatches };
  if (!decoded) return { ok: false, reason: decodeError ?? 'publicInputs did not decode', mismatches };
  if (mismatches.length) return { ok: false, reason: `label mismatch: ${mismatches.join(', ')}`, decoded, mismatches };
  return { ok: true, decoded, mismatches };
}
