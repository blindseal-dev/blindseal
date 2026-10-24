// Blindseal SDK (BLINDSEAL.md §3.8). Mainnet is the only deploy target: chainId 1 = Solana
// mainnet, 2 is reserved. `submit()` refuses any RPC whose genesis hash is not mainnet-beta's.
// Everything encoding-related lives in ix.ts; this file adds the Node-dependent pieces.
import { createRequire } from 'node:module';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, type Signer } from '@solana/web3.js';
import {
  CHAIN_ID_SOLANA_MAINNET, DEFAULT_RPC_URL, MAINNET_GENESIS_HASH, PROGRAM_ID, VERIFY_CU_LIMIT,
  actionArgsFrom, buildVerifyIx, decodePublicInputs, hex, nullifierPda, type Attestation,
} from './ix.js';
export * from './ix.js';

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
  const wasm = await import('blindseal-verifier-wasm');
  const { readFileSync } = await import('node:fs');
  const req = createRequire(import.meta.url);
  const bytes = readFileSync(req.resolve('blindseal-verifier-wasm/bg.wasm'));
  wasm.initSync({ module: bytes });
  return JSON.parse(wasm.verify_attestation_json(JSON.stringify(att))) as VerifyResult;
}
