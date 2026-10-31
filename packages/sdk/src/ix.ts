// Pure, environment-agnostic part of the SDK: constants, types, PDAs, hashing (byte-for-byte
// detector-core / on-chain), Anchor wire encoding and every instruction builder. Imported by the
// localnet suite (CommonJS) and by index.ts (adds submit / verifyOffchain, which need Node APIs).
import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from '@solana/web3.js';

export const PROGRAM_ID = new PublicKey('6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx');
export const TRANSFER_GATE_ID = new PublicKey('9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa');
export const CHAIN_ID_SOLANA_MAINNET = 1;
/** Genesis hash of Solana mainnet-beta — the only cluster submit() will talk to. */
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';
/** Compute-unit limit for a gated transaction: Groth16 verify + nullifier creation + the gated
 *  action (the transfer-gate transaction measures ~269k on localnet, docs/performance.md). */
export const VERIFY_CU_LIMIT = 400_000;

/** detectorVersion (= SP1 vkey hash of the guest ELF) of the CURRENT guest: release 0.7.0, which binds
 *  the screened payload to the action before hashing (crates/guest/elf; `cargo prove vkey --elf`). */
export const CURRENT_VKEY = '0x00cdf40c21b14717fd783bdecb539b762094b3b0da75a567f4b6cc088e9f2967';
/** Earlier guests still recognised so existing attestations (the mainnet samples, history) keep
 *  verifying. Pre-0.7.0 guests did NOT bind the payload to the action; the owner removes these from
 *  the on-chain allowlist once a sample under CURRENT_VKEY has landed. */
export const LEGACY_VKEYS: readonly string[] = ['0x006a0d1e62646623f1d2b9af7f3792c4d15aa7d6107bdb089a0760fd5b29331e'];
/** On-chain cap on allowed_vkeys (blindseal-verify MAX_VKEYS). */
export const MAX_VKEYS = 8;
/** Default vkey allowlist for a fresh Config: the current guest + the legacy ones. */
export const DEFAULT_ALLOWED_VKEYS: readonly string[] = [CURRENT_VKEY, ...LEGACY_VKEYS];
/** The default policy root (detector-core's L1 rules + zero-width threshold; evals/vectors/policy-root.txt). */
export const DEFAULT_POLICY_ROOT = '0x36a9e9457db6ecfd752a379fc9279ad6a0acfea07928f61e2f3638a685c38397';

export const ACTION_DOMAIN = 'blindseal.action.v1';
export const NULLIFIER_DOMAIN = 'blindseal.nullifier.v1';

export interface AttestationAction {
  targetProgram: string;   // base58
  sourceAuthority: string; // base58
  instruction: string;     // 0x + 16 hex
  recipient: string;       // base58 ('' = none)
  mint: string;            // base58 ('' = native)
  amount: string;          // decimal u64
}

/** attestation.json as written by crates/prover / `blindseal attest`. */
export interface Attestation {
  version: number;
  decisionId?: string | null;
  chainId: number;
  payloadHash: string;
  policyRoot: string;
  detectorVersion: string;
  actionHash: string;
  nullifier: string;
  expirySlot: number;
  nonce: string;
  action: AttestationAction;
  publicInputs: [string];
  proof: { protocol: 'groth16'; curve: 'bn254'; bytes: string };
}

export interface ActionArgs {
  chainId: number;
  targetProgram: PublicKey;
  sourceAuthority: PublicKey;
  instruction: Uint8Array; // 8
  recipient: PublicKey;
  mint: PublicKey;
  amount: bigint;
  nonce: Uint8Array; // 32
}

export const hex = (s: string): Buffer => Buffer.from(s.replace(/^0x/i, ''), 'hex');
const pk = (s: string): PublicKey => (s ? new PublicKey(s) : PublicKey.default);

export function actionArgsFrom(att: Attestation): ActionArgs {
  return {
    chainId: att.chainId,
    targetProgram: pk(att.action.targetProgram),
    sourceAuthority: pk(att.action.sourceAuthority),
    instruction: hex(att.action.instruction),
    recipient: pk(att.action.recipient),
    mint: pk(att.action.mint),
    amount: BigInt(att.action.amount),
    nonce: hex(att.nonce),
  };
}

// ---- PDAs ----
export const configPda = (programId = PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0];
export const policyRootPda = (root: Uint8Array, programId = PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from('policy'), Buffer.from(root)], programId)[0];
export const nullifierPda = (nullifier: Uint8Array, programId = PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from('nullifier'), Buffer.from(nullifier)], programId)[0];

// ---- hashing (byte-for-byte detector-core / on-chain) ----
const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

export function computeActionHash(a: ActionArgs, payloadHash: Uint8Array, policyRoot: Uint8Array, detectorVersion: Uint8Array, expirySlot: bigint): Buffer {
  return createHash('sha256')
    .update(ACTION_DOMAIN).update(u16le(a.chainId))
    .update(a.targetProgram.toBytes()).update(a.sourceAuthority.toBytes()).update(a.instruction)
    .update(a.recipient.toBytes()).update(a.mint.toBytes()).update(u64le(a.amount))
    .update(payloadHash).update(policyRoot).update(detectorVersion).update(u64le(expirySlot)).update(a.nonce)
    .digest();
}
export const computeNullifier = (actionHash: Uint8Array): Buffer =>
  createHash('sha256').update(NULLIFIER_DOMAIN).update(actionHash).digest();

// ---- action binding: the labelled action fields vs what the proof commits to ----
export type ActionBindingField = 'actionHash' | 'nullifier';
/**
 * Result of `recomputeActionBinding`. The proof commits to actionHash and nullifier only as hashes;
 * the action fields (`action.*`, `chainId`, `nonce`) in the file are labels. Recomputing the hash from
 * them, over the COMMITTED payloadHash / policyRoot / detectorVersion / expirySlot, shows whether the
 * file's action is the one that was proven — an edited amount or recipient hashes to something else.
 */
export interface ActionBinding {
  /** false when the file carries no `action` object: there is nothing to recompute. */
  checked: boolean;
  /** sha256(ACTION_DOMAIN ‖ chainId ‖ action fields ‖ committed inputs ‖ nonce), when the fields were usable. */
  actionHash?: string;
  /** sha256(NULLIFIER_DOMAIN ‖ committed actionHash): what the nullifier must be. */
  nullifier?: string;
  /** `actionHash` when the recomputed hash differs from the committed one; `nullifier` when the committed nullifier does not derive from the committed actionHash. */
  mismatches: ActionBindingField[];
  /** why the action fields could not be hashed (missing nonce, malformed pubkey, hex or amount); a failure like a mismatch. */
  error?: string;
}

const U64_MAX = (1n << 64n) - 1n;

/** The action fields as the prover wrote them, validated byte-for-byte to what `computeActionHash` hashes. */
export function actionArgsStrict(att: Pick<Attestation, 'chainId' | 'nonce' | 'action'>): ActionArgs {
  const a = att.action;
  if (!a || typeof a !== 'object') throw new Error('action is missing');
  if (!Number.isInteger(att.chainId) || att.chainId < 0 || att.chainId > 0xffff) throw new Error(`chainId must be a u16, got ${String(att.chainId)}`);
  if (typeof att.nonce !== 'string' || !/^(0x)?[0-9a-f]{64}$/i.test(att.nonce)) throw new Error('nonce must be 32 bytes of hex');
  if (typeof a.instruction !== 'string' || !/^(0x)?[0-9a-f]{16}$/i.test(a.instruction)) throw new Error('action.instruction must be 8 bytes of hex');
  if (typeof a.amount !== 'string' || !/^\d+$/.test(a.amount) || BigInt(a.amount) > U64_MAX) throw new Error('action.amount must be a decimal u64 string');
  for (const k of ['targetProgram', 'sourceAuthority', 'recipient', 'mint'] as const) {
    if (typeof a[k] !== 'string') throw new Error(`action.${k} must be a base58 string ('' for none)`);
    if (a[k]) { try { new PublicKey(a[k]); } catch { throw new Error(`action.${k} is not a valid public key`); } }
  }
  return actionArgsFrom(att as Attestation);
}

/**
 * Recompute actionHash from the file's action fields and nonce over the COMMITTED public inputs, and the
 * nullifier from the committed actionHash; compare both to the committed values. Hex is compared
 * case-insensitively. Never throws: unusable fields are reported in `error`.
 */
export function recomputeActionBinding(att: Partial<Pick<Attestation, 'chainId' | 'nonce' | 'action'>>, decoded: DecodedPublicInputs): ActionBinding {
  if (att.action === undefined || att.action === null) return { checked: false, mismatches: [] };
  const out: ActionBinding = { checked: true, mismatches: [] };
  try {
    const args = actionArgsStrict(att as Pick<Attestation, 'chainId' | 'nonce' | 'action'>);
    const h = computeActionHash(args, hex(decoded.payloadHash), hex(decoded.policyRoot), hex(decoded.detectorVersion), BigInt(decoded.expirySlot));
    out.actionHash = '0x' + h.toString('hex');
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  out.nullifier = '0x' + computeNullifier(hex(decoded.actionHash)).toString('hex');
  if (out.actionHash !== undefined && out.actionHash !== decoded.actionHash.toLowerCase()) out.mismatches.push('actionHash');
  if (out.nullifier !== decoded.nullifier.toLowerCase()) out.mismatches.push('nullifier');
  return out;
}

/** One sentence per problem in an `ActionBinding`, or null when it is fine (or unchecked). */
export function actionBindingReason(b: ActionBinding, decoded: DecodedPublicInputs): string | null {
  if (!b.checked) return null;
  const parts: string[] = [];
  if (b.error) parts.push(`action fields unusable: ${b.error}`);
  if (b.mismatches.includes('actionHash')) parts.push(`action mismatch: the action fields hash to ${b.actionHash} but the proof commits to actionHash ${decoded.actionHash}`);
  if (b.mismatches.includes('nullifier')) parts.push(`nullifier mismatch: derived from the committed actionHash it is ${b.nullifier} but the proof commits to ${decoded.nullifier}`);
  return parts.length ? parts.join('; ') : null;
}

// ---- the committed public-input blob ----
// `publicInputs[0]` is the guest's public values in commit order (crates/guest/src/main.rs):
//   [0..32)    payloadHash      [32..64)   policyRoot      [64..96)   detectorVersion
//   [96..128)  actionHash       [128..160) nullifier       [160..168) expirySlot (u64 LE)
// 168 bytes = 336 hex chars. This is the ONLY data the proof binds; the six labeled top-level
// fields of attestation.json are convenience copies and must be checked against it.
export const PUBLIC_INPUTS_LEN = 168;

/** The six committed fields as 0x-prefixed lower-case hex; `expirySlot` is a decimal u64 string. */
export interface DecodedPublicInputs {
  payloadHash: string;
  policyRoot: string;
  detectorVersion: string;
  actionHash: string;
  nullifier: string;
  expirySlot: string;
}

/** Byte-level view of the same six fields (used by the instruction builders). */
export interface DecodedPublicInputsBytes {
  payloadHash: Buffer;
  policyRoot: Buffer;
  detectorVersion: Buffer;
  actionHash: Buffer;
  nullifier: Buffer;
  expirySlot: bigint;
}

/**
 * Decode the 168-byte committed blob into its six fields.
 * - Given a hex string (`publicInputs[0]`, with or without `0x`), returns 0x-prefixed lower-case
 *   hex fields and `expirySlot` as a decimal string — the shape `verifyOffchain` reports as `decoded`.
 * - Given raw bytes, returns Buffers and a bigint expiry (the form the instruction builders use).
 * Throws if the input is not exactly 168 bytes (or not valid hex).
 */
export function decodePublicInputs(blobHex: string): DecodedPublicInputs;
export function decodePublicInputs(blob: Uint8Array): DecodedPublicInputsBytes;
export function decodePublicInputs(blob: string | Uint8Array): DecodedPublicInputs | DecodedPublicInputsBytes {
  if (typeof blob === 'string') {
    const h = blob.trim().replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]*$/.test(h) || h.length % 2 !== 0) throw new Error('publicInputs is not a hex string');
    const b = decodeBytes(Buffer.from(h, 'hex'));
    const hx = (x: Buffer) => '0x' + x.toString('hex');
    return {
      payloadHash: hx(b.payloadHash), policyRoot: hx(b.policyRoot), detectorVersion: hx(b.detectorVersion),
      actionHash: hx(b.actionHash), nullifier: hx(b.nullifier), expirySlot: b.expirySlot.toString(),
    };
  }
  return decodeBytes(blob);
}

function decodeBytes(blob: Uint8Array): DecodedPublicInputsBytes {
  if (blob.length !== PUBLIC_INPUTS_LEN) throw new Error(`publicInputs must be ${PUBLIC_INPUTS_LEN} bytes, got ${blob.length}`);
  const b = Buffer.from(blob);
  return {
    payloadHash: b.subarray(0, 32), policyRoot: b.subarray(32, 64), detectorVersion: b.subarray(64, 96),
    actionHash: b.subarray(96, 128), nullifier: b.subarray(128, 160), expirySlot: b.readBigUInt64LE(160),
  };
}

// ---- Anchor wire encoding ----
export const discriminator = (name: string): Buffer =>
  createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

const vecU8 = (b: Uint8Array) => { const len = Buffer.alloc(4); len.writeUInt32LE(b.length); return Buffer.concat([len, Buffer.from(b)]); };

export function encodeActionArgs(a: ActionArgs): Buffer {
  return Buffer.concat([
    u16le(a.chainId), a.targetProgram.toBuffer(), a.sourceAuthority.toBuffer(), Buffer.from(a.instruction),
    a.recipient.toBuffer(), a.mint.toBuffer(), u64le(a.amount), Buffer.from(a.nonce),
  ]);
}

export interface VerifyAccounts {
  payer: PublicKey;
  /** Pass when the program runs in allowlist mode; omit otherwise. */
  policyRoot?: PublicKey | null;
  programId?: PublicKey;
}

/**
 * `verify_and_consume(proof, public_inputs, action)`: the account list and data a gated program
 * forwards in its CPI. The verifier accepts it ONLY as a CPI from `action.targetProgram` issued by
 * the top-level instruction — sent as a top-level instruction it fails `DirectCallNotAllowed`.
 * Accounts: config, policy_root (optional), nullifier, payer, system_program, instructions sysvar.
 */
export function buildVerifyIx(att: Attestation, action: ActionArgs, accounts: VerifyAccounts): TransactionInstruction {
  const programId = accounts.programId ?? PROGRAM_ID;
  const proof = hex(att.proof.bytes);
  const blob = hex(att.publicInputs[0]);
  const { nullifier } = decodePublicInputs(blob);
  const data = Buffer.concat([discriminator('verify_and_consume'), vecU8(proof), vecU8(blob), encodeActionArgs(action)]);
  const policy = accounts.policyRoot === undefined ? policyRootPda(decodePublicInputs(blob).policyRoot, programId) : accounts.policyRoot;
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda(programId), isSigner: false, isWritable: false },
      // Anchor optional account: pass the program id itself for None.
      { pubkey: policy ?? programId, isSigner: false, isWritable: false },
      { pubkey: nullifierPda(nullifier, programId), isSigner: false, isWritable: true },
      { pubkey: accounts.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ---- admin instructions (authority only) ----
const boolB = (b: boolean) => Buffer.from([b ? 1 : 0]);
const vecVkeys = (v: Uint8Array[]) => { const len = Buffer.alloc(4); len.writeUInt32LE(v.length); return Buffer.concat([len, ...v.map((k) => Buffer.from(k))]); };
const option = (present: boolean, body: Buffer) => (present ? Buffer.concat([Buffer.from([1]), body]) : Buffer.from([0]));

/** `initialize(allowed_vkeys, allowlist_policies)` — creates the Config PDA; `authority` pays and becomes the authority.
 *  Defaults (0.7.0): the current + legacy vkeys, and approved policies ON — only attestations under a
 *  registered policy root verify (register it with `buildRegisterPolicyRootIx`, or use `buildDefaultInitIxs`). */
export function buildInitializeIx(authority: PublicKey, allowedVkeys: Uint8Array[] = DEFAULT_ALLOWED_VKEYS.map(hex), allowlistPolicies = true, programId = PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda(programId), isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([discriminator('initialize'), vecVkeys(allowedVkeys), boolB(allowlistPolicies)]),
  });
}

/** `set_config(allowed_vkeys?, allowlist_policies?, paused?)` — each `undefined` leaves the field unchanged. */
export function buildSetConfigIx(authority: PublicKey, o: { allowedVkeys?: Uint8Array[]; allowlistPolicies?: boolean; paused?: boolean }, programId = PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda(programId), isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([
      discriminator('set_config'),
      option(o.allowedVkeys !== undefined, o.allowedVkeys ? vecVkeys(o.allowedVkeys) : Buffer.alloc(0)),
      option(o.allowlistPolicies !== undefined, boolB(o.allowlistPolicies ?? false)),
      option(o.paused !== undefined, boolB(o.paused ?? false)),
    ]),
  });
}

/** `register_policy_root(root)` — authority only; creates PDA(["policy", root]). */
export function buildRegisterPolicyRootIx(authority: PublicKey, root: Uint8Array, programId = PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda(programId), isSigner: false, isWritable: false },
      { pubkey: policyRootPda(root, programId), isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([discriminator('register_policy_root'), Buffer.from(root)]),
  });
}

/** The default initialisation: `initialize(current + legacy vkeys, allowlist_policies = true)` then
 *  `register_policy_root(DEFAULT_POLICY_ROOT)` — approved policies on, the default policy approved. */
export function buildDefaultInitIxs(authority: PublicKey, programId = PROGRAM_ID): TransactionInstruction[] {
  return [
    buildInitializeIx(authority, DEFAULT_ALLOWED_VKEYS.map(hex), true, programId),
    buildRegisterPolicyRootIx(authority, hex(DEFAULT_POLICY_ROOT), programId),
  ];
}

/** `set_authority(new_authority)` — hands the Config authority over. BOTH the current authority and
 *  `newAuthority` must sign (a mistyped key cannot take the config); emits `AuthorityChanged`. */
export function buildSetAuthorityIx(authority: PublicKey, newAuthority: PublicKey, programId = PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda(programId), isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: newAuthority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([discriminator('set_authority'), newAuthority.toBuffer()]),
  });
}

/** Decode the Config account (8 disc ‖ 32 authority ‖ vec<[u8;32]> ‖ bool allowlist ‖ bool paused ‖ u8 bump). */
export function decodeConfig(data: Uint8Array) {
  const b = Buffer.from(data);
  const n = b.readUInt32LE(40);
  const vkeys: string[] = [];
  for (let i = 0; i < n; i++) vkeys.push('0x' + b.subarray(44 + i * 32, 76 + i * 32).toString('hex'));
  const off = 44 + n * 32;
  return { authority: new PublicKey(b.subarray(8, 40)).toBase58(), allowedVkeys: vkeys, allowlistPolicies: b[off] === 1, paused: b[off + 1] === 1, bump: b[off + 2] };
}

// ---- transfer-gate (example gated program) ----
/** `gated_transfer(proof, public_inputs, nonce, amount)`: the gate CPIs verify_and_consume with the
 *  action IT executes, then transfers `amount` lamports source → recipient in the same tx. Must be a
 *  top-level instruction (the verifier refuses a deeper nesting). Accounts: source, recipient,
 *  config, policy_root (optional), nullifier, verify_program, system_program, instructions sysvar. */
export function buildGatedTransferIx(att: Attestation, accounts: { source: PublicKey; recipient: PublicKey; policyRoot?: PublicKey | null; gateId?: PublicKey; verifyId?: PublicKey }): TransactionInstruction {
  const gateId = accounts.gateId ?? TRANSFER_GATE_ID;
  const verifyId = accounts.verifyId ?? PROGRAM_ID;
  const proof = hex(att.proof.bytes);
  const blob = hex(att.publicInputs[0]);
  const { nullifier, policyRoot } = decodePublicInputs(blob);
  const amount = Buffer.alloc(8); amount.writeBigUInt64LE(BigInt(att.action.amount));
  const data = Buffer.concat([discriminator('gated_transfer'), vecU8(proof), vecU8(blob), hex(att.nonce), amount]);
  const policy = accounts.policyRoot === undefined ? policyRootPda(policyRoot, verifyId) : accounts.policyRoot;
  return new TransactionInstruction({
    programId: gateId,
    keys: [
      { pubkey: accounts.source, isSigner: true, isWritable: true },
      { pubkey: accounts.recipient, isSigner: false, isWritable: true },
      { pubkey: configPda(verifyId), isSigner: false, isWritable: false },
      { pubkey: policy ?? gateId, isSigner: false, isWritable: false }, // Anchor optional None = program id
      { pubkey: nullifierPda(nullifier, verifyId), isSigner: false, isWritable: true },
      { pubkey: verifyId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // forwarded to the verifier, which reads it to check that its caller is the target program
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ---- Nullifier record ----
/** Decode a Nullifier PDA (8 disc ‖ u64 consumed_at_slot ‖ 32 consumer_program ‖ 32 action_hash ‖ u8 bump).
 *  `consumerProgram` is the program that consumed it by CPI (records written before the caller check
 *  carry the all-zero key for a direct submission). */
export function decodeNullifier(data: Uint8Array) {
  const b = Buffer.from(data);
  if (b.length < 81) throw new Error(`Nullifier account must be 81 bytes, got ${b.length}`);
  return {
    consumedAtSlot: b.readBigUInt64LE(8),
    consumerProgram: new PublicKey(b.subarray(16, 48)),
    actionHash: '0x' + b.subarray(48, 80).toString('hex'),
    bump: b[80],
  };
}
