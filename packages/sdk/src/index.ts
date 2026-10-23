// Blindseal SDK (BLINDSEAL.md §3.8). Mainnet is the only deploy target: chainId 1 = Solana
// mainnet, 2 is reserved. `submit()` refuses any RPC whose genesis hash is not mainnet-beta's.
//
// Instructions are encoded by hand in Anchor's wire format (8-byte discriminator + Borsh args),
// so the SDK needs no IDL at runtime and nothing but @solana/web3.js. The on-chain program's
// IDL is shipped alongside for consumers that want the Anchor client (idl/).
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  type Signer,
} from '@solana/web3.js';

export const PROGRAM_ID = new PublicKey('merZNYKpKwwX4CGgzvma3jPvLfrMTkZcb1cSXUKANcb');
export const TRANSFER_GATE_ID = new PublicKey('ErAS5x2oUky3aCJPasSKNaf8USVE9of5vzHHCPWwSEVG');
export const CHAIN_ID_SOLANA_MAINNET = 1;
/** Genesis hash of Solana mainnet-beta — the only cluster submit() will talk to. */
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';
/** Groth16 verify + nullifier creation; measured on localnet (docs/performance.md). */
export const VERIFY_CU_LIMIT = 400_000;

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

export const hex = (s: string): Buffer => Buffer.from(s.replace(/^0x/, ''), 'hex');
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

/** Decode the 168-byte committed blob into its six fields. */
export function decodePublicInputs(blob: Uint8Array) {
  if (blob.length !== 168) throw new Error(`publicInputs must be 168 bytes, got ${blob.length}`);
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

/** `verify_and_consume(proof, public_inputs, action)` for composing into a gated transaction. */
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
    ],
    data,
  });
}

export class WrongClusterError extends Error {
  constructor(public readonly got: string) {
    super(`RPC genesis hash ${got} is not Solana mainnet-beta (${MAINNET_GENESIS_HASH}); refusing to send`);
  }
}

export interface SubmitOptions {
  wallet: Signer | Keypair;
  rpcUrl?: string;        // default BLINDSEAL_RPC_URL or the public mainnet endpoint
  connection?: Connection;
  policyRoot?: PublicKey | null;
  computeUnits?: number;
  /** Test hook only: skip the genesis guard (localnet). Never set in production. */
  allowNonMainnet?: boolean;
}

/**
 * Submit an attestation directly (no gated program): verifies on-chain and consumes the nullifier.
 * Refuses any cluster whose genesis hash is not mainnet-beta's — chainId 1 is the only chain.
 */
export async function submit(att: Attestation, opts: SubmitOptions): Promise<string> {
  if (att.chainId !== CHAIN_ID_SOLANA_MAINNET) throw new Error(`attestation chainId ${att.chainId} is not Solana mainnet (1)`);
  const conn = opts.connection ?? new Connection(opts.rpcUrl ?? process.env.BLINDSEAL_RPC_URL ?? DEFAULT_RPC_URL, 'confirmed');
  if (!opts.allowNonMainnet) {
    const genesis = await conn.getGenesisHash();
    if (genesis !== MAINNET_GENESIS_HASH) throw new WrongClusterError(genesis);
  }
  const action = actionArgsFrom(att);
  const ix = buildVerifyIx(att, action, { payer: opts.wallet.publicKey, policyRoot: opts.policyRoot });
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

export interface VerifyResult { ok: boolean; reason: string | null; }

/** Off-chain Groth16 verify via the same wasm the verify pages use. */
export async function verifyOffchain(att: Attestation): Promise<VerifyResult> {
  const wasm = await import('@blindseal/verifier-wasm');
  const { readFileSync } = await import('node:fs');
  const req = createRequire(import.meta.url);
  const bytes = readFileSync(req.resolve('@blindseal/verifier-wasm/bg.wasm'));
  wasm.initSync({ module: bytes });
  return JSON.parse(wasm.verify_attestation_json(JSON.stringify(att))) as VerifyResult;
}

// ---- admin instructions (authority only) ----
const boolB = (b: boolean) => Buffer.from([b ? 1 : 0]);
const vecVkeys = (v: Uint8Array[]) => { const len = Buffer.alloc(4); len.writeUInt32LE(v.length); return Buffer.concat([len, ...v.map((k) => Buffer.from(k))]); };
const option = (present: boolean, body: Buffer) => (present ? Buffer.concat([Buffer.from([1]), body]) : Buffer.from([0]));

/** `initialize(allowed_vkeys, allowlist_policies)` — creates the Config PDA; `authority` pays and becomes the authority. */
export function buildInitializeIx(authority: PublicKey, allowedVkeys: Uint8Array[], allowlistPolicies: boolean, programId = PROGRAM_ID): TransactionInstruction {
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
 *  action IT executes, then transfers `amount` lamports source → recipient in the same tx. */
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
    ],
    data,
  });
}
