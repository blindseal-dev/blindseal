// Blindseal plugin for Solana Agent Kit v2.
//
// What it does: `agent.use(blindsealPlugin(...))` replaces the agent's wallet with a guarded one. Before
// the wallet signs (or signs and sends) a transaction, every SOL or SPL transfer in it that is
// authorised by the agent's key must be covered by a Blindseal attestation for EXACTLY that transfer —
// same payer, same recipient (for SPL: the OWNER of the destination token account), same mint, same
// amount — that verifies (proof + action binding), has not expired and whose nullifier is not consumed
// on chain. Otherwise signing is refused with an error that names the first mismatched field. The
// shared check is `@blindseal/attestation-check`; the same one the x402 gate runs.
//
// Attestations reach the plugin through its store: `agent.methods.blindsealProvideAttestation(att)`
// (any Blindseal attestation.json, base64 or object), or the `BLINDSEAL_GUARDED_TRANSFER` action /
// `blindsealTransfer` method, which takes the attestation together with the transfer and sends it
// through the guarded wallet. Instructions that are not transfers (compute budget, memo, swaps…) are
// left alone by default (`otherInstructions: 'allow'`); set 'refuse' to sign nothing but attested
// transfers.
//
// The kit is NOT a dependency: `Plugin`, `Action` and `BaseWallet` below are structural copies of
// solana-agent-kit's `packages/core/src/types` (v2), so the plugin type-checks against the real kit
// without pulling its runtime dependency tree into this package. `zod` is the one runtime dependency,
// because the kit's `Action.schema` is a zod schema that its framework adapters introspect.
import {
  PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction,
  type Connection, type SendOptions, type TransactionSignature,
} from '@solana/web3.js';
import { z } from 'zod';
import {
  AttestationRefusedError, actionMismatch, checkAttestation, nullifierOf, parseAttestation,
  type ActionField, type Attestation, type ChainReader, type CheckFail, type ExpectedAction,
} from '@blindseal/attestation-check';

export { AttestationRefusedError, connectionReader, rpcReader } from '@blindseal/attestation-check';
export type { Attestation, ChainReader } from '@blindseal/attestation-check';

// ---- structural copies of solana-agent-kit v2 types (packages/core/src/types) ----
export interface BaseWallet {
  readonly publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]>;
  sendTransaction?: <T extends Transaction | VersionedTransaction>(transaction: T) => Promise<string>;
  signAndSendTransaction: <T extends Transaction | VersionedTransaction>(transaction: T, options?: SendOptions) => Promise<{ signature: TransactionSignature }>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}
/** The part of `SolanaAgentKit` a plugin touches. */
export interface AgentLike {
  wallet: BaseWallet;
  connection: Connection;
  config: { signOnly?: boolean };
}
export interface ActionExample { input: Record<string, unknown>; output: Record<string, unknown>; explanation: string }
export interface Action {
  name: string;
  similes: string[];
  description: string;
  examples: ActionExample[][];
  schema: z.ZodType<unknown>;
  handler: (agent: AgentLike, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}
export interface Plugin {
  name: string;
  methods: Record<string, (...args: never[]) => unknown>;
  actions: Action[];
  initialize(agent: AgentLike): void;
}

// ---- transfers in a transaction ----
export const SPL_TOKEN_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const COMPUTE_BUDGET_ID = new PublicKey('ComputeBudget111111111111111111111111111111');
export const MEMO_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
/** Instructions the guard never counts as "other": they cannot move funds. */
export const HARMLESS_PROGRAMS: readonly PublicKey[] = [COMPUTE_BUDGET_ID, MEMO_ID, ASSOCIATED_TOKEN_ID];

export const associatedTokenAddress = (owner: PublicKey, mint: PublicKey, tokenProgram = SPL_TOKEN_ID): PublicKey =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_ID)[0];

export interface DecodedIx { programId: PublicKey; keys: PublicKey[]; data: Uint8Array }

/** Instructions of a legacy or versioned transaction. Throws when keys live in address lookup tables. */
export function instructionsOf(tx: Transaction | VersionedTransaction): DecodedIx[] {
  if (tx instanceof VersionedTransaction) {
    const msg = tx.message;
    if (msg.addressTableLookups.length > 0) throw new Error('transaction uses address lookup tables; the guard cannot read its accounts');
    const keys = msg.staticAccountKeys;
    return msg.compiledInstructions.map((ix) => ({ programId: keys[ix.programIdIndex]!, keys: ix.accountKeyIndexes.map((i) => keys[i]!), data: ix.data }));
  }
  return tx.instructions.map((ix) => ({ programId: ix.programId, keys: ix.keys.map((k) => k.pubkey), data: new Uint8Array(ix.data) }));
}

/** A transfer the guard must cover. `recipient` is the paid owner; for SPL it is resolved from the destination token account. */
export interface Transfer {
  kind: 'sol' | 'spl';
  authority: PublicKey;
  /** The destination account (wallet for SOL, token account for SPL). */
  destination: PublicKey;
  /** Who is paid: the SOL recipient, or the owner of the destination token account. */
  recipient: PublicKey;
  mint: PublicKey | null;
  amount: bigint;
}

/**
 * The transfers in a transaction, with SPL destinations resolved to their owners: from a create-ATA
 * instruction in the same transaction when there is one, else by reading the token account on chain
 * (layout: mint[0..32] owner[32..64]). An SPL destination that cannot be resolved throws, so an unknown
 * destination is never silently waved through. Also returns whether any OTHER (non-harmless, non-transfer)
 * instruction is present.
 */
export async function transfersOf(ixs: DecodedIx[], chain: ChainReader): Promise<{ transfers: Transfer[]; others: PublicKey[] }> {
  const transfers: Transfer[] = [];
  const others: PublicKey[] = [];
  // ATAs created in this transaction: ata → { owner, mint }
  const created = new Map<string, { owner: PublicKey; mint: PublicKey }>();
  for (const ix of ixs) {
    if (ix.programId.equals(ASSOCIATED_TOKEN_ID) && ix.keys.length >= 4) created.set(ix.keys[1]!.toBase58(), { owner: ix.keys[2]!, mint: ix.keys[3]! });
  }
  for (const ix of ixs) {
    const d = Buffer.from(ix.data);
    if (ix.programId.equals(SystemProgram.programId)) {
      if (d.length >= 12 && d.readUInt32LE(0) === 2 && ix.keys.length >= 2) {
        transfers.push({ kind: 'sol', authority: ix.keys[0]!, destination: ix.keys[1]!, recipient: ix.keys[1]!, mint: null, amount: d.readBigUInt64LE(4) });
      } else {
        others.push(ix.programId); // create account, allocate, assign…: not a transfer, counted as other
      }
      continue;
    }
    if (ix.programId.equals(SPL_TOKEN_ID) || ix.programId.equals(TOKEN_2022_ID)) {
      let authority: PublicKey | undefined; let destination: PublicKey | undefined; let amount = 0n; let mint: PublicKey | null = null;
      if (d.length >= 9 && d[0] === 12 && ix.keys.length >= 4) { destination = ix.keys[2]!; authority = ix.keys[3]!; amount = d.readBigUInt64LE(1); mint = ix.keys[1]!; }
      else if (d.length >= 9 && d[0] === 3 && ix.keys.length >= 3) { destination = ix.keys[1]!; authority = ix.keys[2]!; amount = d.readBigUInt64LE(1); }
      if (!authority || !destination) { others.push(ix.programId); continue; } // approve, burn, close…: other
      const hit = created.get(destination.toBase58());
      let owner: PublicKey; let acctMint: PublicKey;
      if (hit) { owner = hit.owner; acctMint = hit.mint; }
      else {
        const info = await chain.getAccountInfo(destination);
        if (!info || info.data.length < 72) throw new Error(`destination token account ${destination.toBase58()} does not exist; create it in the same transaction or pass the transfer explicitly`);
        acctMint = new PublicKey(info.data.subarray(0, 32)); owner = new PublicKey(info.data.subarray(32, 64));
      }
      if (mint && !mint.equals(acctMint)) throw new Error(`TransferChecked mint ${mint.toBase58()} differs from the destination account's ${acctMint.toBase58()}`);
      transfers.push({ kind: 'spl', authority, destination, recipient: owner, mint: acctMint, amount });
      continue;
    }
    if (!HARMLESS_PROGRAMS.some((p) => p.equals(ix.programId))) others.push(ix.programId);
  }
  return { transfers, others };
}

// ---- the attestation store ----
/** Attestations the agent has been handed, keyed by nullifier. One attestation covers one transfer. */
export class AttestationStore {
  private readonly byNullifier = new Map<string, Attestation>();
  add(input: unknown): Attestation {
    const att = parseAttestation(input);
    const { nullifier } = nullifierOf(att);
    this.byNullifier.set(nullifier, att);
    return att;
  }
  remove(att: Attestation): void { this.byNullifier.delete(nullifierOf(att).nullifier); }
  get size(): number { return this.byNullifier.size; }
  list(): Attestation[] { return [...this.byNullifier.values()]; }
  /**
   * The stored attestation whose action equals `expected`, or the closest one (fewest differing fields,
   * ties to the first stored) with its first mismatch — so a refusal can name the field.
   */
  find(expected: ExpectedAction): { match: Attestation } | { match: null; closest?: { attestation: Attestation; field: ActionField; expected: string; got: string } } {
    let closest: { attestation: Attestation; field: ActionField; expected: string; got: string; rank: number } | undefined;
    for (const att of this.byNullifier.values()) {
      const mm = actionMismatch(att, expected);
      if (!mm) return { match: att };
      const rank = ACTION_RANK[mm.field];
      if (!closest || rank > closest.rank) closest = { attestation: att, ...mm, rank };
    }
    return closest ? { match: null, closest: { attestation: closest.attestation, field: closest.field, expected: closest.expected, got: closest.got } } : { match: null };
  }
}
// later fields = more of the action already agreed; the candidate that gets furthest is the closest
const ACTION_RANK: Record<ActionField, number> = { chainId: 0, targetProgram: 1, instruction: 2, sourceAuthority: 3, recipient: 4, mint: 5, amount: 6 };

// ---- the guard ----
export interface GuardOptions {
  chain: ChainReader;
  store?: AttestationStore;
  /** Non-transfer instructions (swaps, program calls): sign them ('allow', default) or refuse ('refuse'). */
  otherInstructions?: 'allow' | 'refuse';
  /** When the integrator knows the gated program that will consume the attestation. */
  consumer?: { targetProgram: string; instruction: string };
  verifyProgramId?: PublicKey;
  /** Remove an attestation from the store once a transaction using it was signed (default true). */
  consumeOnSign?: boolean;
}

/** Thrown when the guard refuses to sign. `field` names the first mismatched action field when that is the cause. */
export class TransferRefusedError extends Error {
  constructor(public readonly transfer: Transfer | null, public readonly code: CheckFail['code'] | 'no_attestation' | 'other_instruction' | 'unreadable', public readonly field: ActionField | undefined, detail: string) {
    super(`blindseal: refusing to sign: ${code}${field ? ` (${field})` : ''}: ${detail}`);
    this.name = 'TransferRefusedError';
  }
}

const describe = (t: Transfer) => `${t.kind === 'sol' ? 'SOL' : `mint ${t.mint!.toBase58()}`} ${t.amount} to ${t.recipient.toBase58()}`;

/**
 * Check one transaction: every transfer authorised by `signer` needs a matching, valid, live, unconsumed
 * attestation from the store. Returns the attestations used (in transfer order) or throws
 * `TransferRefusedError`. Transfers authorised by other keys are not this wallet's to gate and are ignored.
 */
export async function guardTransaction(tx: Transaction | VersionedTransaction, signer: PublicKey, opts: GuardOptions): Promise<Attestation[]> {
  const store = opts.store ?? new AttestationStore();
  let ixs: DecodedIx[];
  try { ixs = instructionsOf(tx); } catch (e) { throw new TransferRefusedError(null, 'unreadable', undefined, (e as Error).message); }
  let decoded: Awaited<ReturnType<typeof transfersOf>>;
  try { decoded = await transfersOf(ixs, opts.chain); } catch (e) { throw new TransferRefusedError(null, 'unreadable', undefined, (e as Error).message); }
  if ((opts.otherInstructions ?? 'allow') === 'refuse' && decoded.others.length) {
    throw new TransferRefusedError(null, 'other_instruction', undefined, `transaction calls ${decoded.others.map((p) => p.toBase58()).join(', ')}; only attested transfers are signed`);
  }
  const used: Attestation[] = [];
  const usedNullifiers = new Set<string>();
  for (const t of decoded.transfers.filter((t) => t.authority.equals(signer))) {
    const expected: ExpectedAction = { sourceAuthority: signer.toBase58(), recipient: t.recipient.toBase58(), mint: t.mint?.toBase58() ?? '', amount: t.amount, ...(opts.consumer ?? {}) };
    const found = store.find(expected);
    if (!found.match) {
      if (found.closest) throw new TransferRefusedError(t, 'action_mismatch', found.closest.field, `no attestation for ${describe(t)}; the closest one has ${found.closest.field} ${found.closest.got || '(none)'} where the transfer has ${found.closest.expected || '(none)'}`);
      throw new TransferRefusedError(t, 'no_attestation', undefined, `no attestation for ${describe(t)}`);
    }
    const nf = nullifierOf(found.match).nullifier;
    if (usedNullifiers.has(nf)) throw new TransferRefusedError(t, 'no_attestation', undefined, `attestation ${nf} already covers another transfer in this transaction`);
    const r = await checkAttestation(found.match, expected, opts.chain, { verifyProgramId: opts.verifyProgramId });
    if (!r.ok) throw new TransferRefusedError(t, r.code, r.field, r.reason);
    usedNullifiers.add(nf);
    used.push(found.match);
  }
  return used;
}

/** Wrap a wallet: every sign / signAndSend / send goes through `guardTransaction` first. */
export function guardWallet(wallet: BaseWallet, opts: GuardOptions): BaseWallet {
  const store = opts.store ?? new AttestationStore();
  const o = { ...opts, store };
  const consume = (used: Attestation[]) => { if (o.consumeOnSign ?? true) for (const a of used) store.remove(a); };
  const guard = async (tx: Transaction | VersionedTransaction) => consume(await guardTransaction(tx, wallet.publicKey, o));
  const guarded: BaseWallet = {
    get publicKey() { return wallet.publicKey; },
    async signTransaction(tx) { await guard(tx); return wallet.signTransaction(tx); },
    async signAllTransactions(txs) { for (const tx of txs) await guard(tx); return wallet.signAllTransactions(txs); },
    signAndSendTransaction: async (tx, options) => { await guard(tx); return wallet.signAndSendTransaction(tx, options); },
    signMessage: (m) => wallet.signMessage(m),
  };
  if (wallet.sendTransaction) {
    const send = wallet.sendTransaction;
    guarded.sendTransaction = async (tx) => { await guard(tx); return send(tx); };
  }
  return guarded;
}

// ---- the plugin ----
export interface BlindsealPluginOptions extends Omit<GuardOptions, 'store'> {
  store?: AttestationStore;
}

const transferSchema = z.object({
  to: z.string().describe('recipient wallet (base58); for SPL the token owner, the ATA is derived'),
  amount: z.union([z.string(), z.number()]).describe('atomic units: lamports, or token base units'),
  mint: z.string().optional().describe('SPL mint (base58); omit for native SOL'),
  attestation: z.union([z.string(), z.record(z.unknown())]).describe('the Blindseal attestation for exactly this transfer (base64 or JSON)'),
  decimals: z.number().int().min(0).max(255).optional().describe('token decimals (SPL only; required to use TransferChecked)'),
});
export type GuardedTransferInput = z.infer<typeof transferSchema>;

/** Build the transfer transaction (SOL, or SPL via TransferChecked between ATAs). */
export function buildTransfer(from: PublicKey, input: GuardedTransferInput): Transaction {
  const to = new PublicKey(input.to);
  const amount = BigInt(input.amount);
  const tx = new Transaction();
  if (!input.mint) {
    tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: amount }));
    return tx;
  }
  const mint = new PublicKey(input.mint);
  const data = Buffer.alloc(input.decimals === undefined ? 9 : 10);
  data[0] = input.decimals === undefined ? 3 : 12;
  data.writeBigUInt64LE(amount, 1);
  if (input.decimals !== undefined) data[9] = input.decimals;
  const keys = input.decimals === undefined
    ? [
        { pubkey: associatedTokenAddress(from, mint), isSigner: false, isWritable: true },
        { pubkey: associatedTokenAddress(to, mint), isSigner: false, isWritable: true },
        { pubkey: from, isSigner: true, isWritable: false },
      ]
    : [
        { pubkey: associatedTokenAddress(from, mint), isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: associatedTokenAddress(to, mint), isSigner: false, isWritable: true },
        { pubkey: from, isSigner: true, isWritable: false },
      ];
  tx.add(new TransactionInstruction({ programId: SPL_TOKEN_ID, keys, data }));
  return tx;
}

/** The plugin. `agent.use(blindsealPlugin({ chain }))` guards the agent's wallet from then on. */
export function blindsealPlugin(opts: BlindsealPluginOptions): Plugin & { store: AttestationStore } {
  const store = opts.store ?? new AttestationStore();
  const guardOpts: GuardOptions = { ...opts, store };

  const transfer = async (agent: AgentLike, raw: unknown): Promise<Record<string, unknown>> => {
    const input = transferSchema.parse(raw);
    let amount: bigint;
    try { amount = BigInt(input.amount); } catch { throw new Error(`amount ${JSON.stringify(input.amount)} is not an integer`); }
    const att = store.add(input.attestation);
    // the attestation must be for this transfer BEFORE anything is built: a plain, early refusal
    const expected: ExpectedAction = { sourceAuthority: agent.wallet.publicKey.toBase58(), recipient: input.to, mint: input.mint ?? '', amount, ...(opts.consumer ?? {}) };
    const mm = actionMismatch(att, expected);
    if (mm) { store.remove(att); throw new AttestationRefusedError({ ok: false, code: 'action_mismatch', field: mm.field, reason: `attestation ${mm.field} is ${mm.got || '(none)'}, the transfer's is ${mm.expected || '(none)'}`, attestation: att }); }
    const tx = buildTransfer(agent.wallet.publicKey, input);
    tx.feePayer = agent.wallet.publicKey;
    tx.recentBlockhash = (await agent.connection.getLatestBlockhash()).blockhash;
    if (agent.config.signOnly) {
      const signed = await agent.wallet.signTransaction(tx); // the guarded wallet runs the full check
      return { status: 'signed', nullifier: nullifierOf(att).nullifier, transaction: signed.serialize({ requireAllSignatures: false }).toString('base64') };
    }
    const { signature } = await agent.wallet.signAndSendTransaction(tx);
    return { status: 'sent', signature, nullifier: nullifierOf(att).nullifier };
  };

  const action: Action = {
    name: 'BLINDSEAL_GUARDED_TRANSFER',
    similes: ['attested transfer', 'send with blindseal attestation', 'screened payment'],
    description: 'Send SOL or an SPL token to a recipient, only with a valid, unconsumed Blindseal attestation for exactly this transfer (payer, recipient, mint, amount). Refuses otherwise, naming the first mismatched field.',
    examples: [[{
      input: { to: '7yWHC82fn96N6XTJBXdwkSBQHtLZZJTjr4SxXtGLQM24', amount: '1000000', attestation: '<base64 attestation.json>' },
      output: { status: 'sent', signature: '<tx signature>', nullifier: '0x…' },
      explanation: 'A 0.001 SOL transfer whose attestation names this payer, recipient and amount.',
    }]],
    schema: transferSchema,
    handler: (agent, input) => transfer(agent, input),
  };

  return {
    name: 'blindseal',
    store,
    methods: {
      /** Hand the guard an attestation for a transfer the agent will sign later. Returns its nullifier. */
      blindsealProvideAttestation: ((input: unknown) => nullifierOf(store.add(input)).nullifier) as (...args: never[]) => unknown,
      /** Build, check and send (or sign) a transfer covered by `attestation`. */
      blindsealTransfer: transfer as (...args: never[]) => unknown,
      /** Attestations currently held, by nullifier. */
      blindsealHeldAttestations: (() => store.list().map((a) => nullifierOf(a).nullifier)) as (...args: never[]) => unknown,
    },
    actions: [action],
    initialize(agent) {
      agent.wallet = guardWallet(agent.wallet, guardOpts);
    },
  };
}
