// Facilitator-side Blindseal gate for x402 payments.
//
// A facilitator's /verify and /settle receive `{ paymentPayload, paymentRequirements }`. This gate
// sits in front of them: it works out the payment being facilitated (payer, recipient, mint, amount),
// and for a payment at or above the configured threshold for its mint it requires the
// `X-Blindseal-Attestation` header (base64 of attestation.json) and runs the shared check — proof and
// action binding, the attestation's action equals THIS payment, not expired, nullifier not consumed on
// chain. Below the threshold the payment passes untouched. The decision is a plain value; two thin
// adapters turn it into a node:http handler or a fetch-style handler.
//
// How the payment is read (`extractPayment`, overridable):
//   - `body.payment = { payer, recipient, mint, amount }` — an explicit shape for facilitators that have
//     already decoded the payment;
//   - otherwise the x402 `exact` scheme on Solana: requirements (`paymentRequirements`, or v2's
//     `paymentPayload.accepted`) give `payTo` (recipient owner) and `asset` (mint), and
//     `paymentPayload.payload.transaction` is the client's partially signed transaction, in which the
//     spl-token / token-2022 TransferChecked (or Transfer) to the ATA(payTo, asset) names the payer
//     (its authority) and the amount. A System transfer to `payTo` is read the same way for native SOL.
//   A payment that cannot be read is refused (400): a gate that fails open on an unreadable payment is
//   not a gate.
import { PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import {
  AttestationRefusedError, checkAttestation,
  type ActionField, type Attestation, type ChainReader, type CheckCode, type CheckOk,
} from '@blindseal/attestation-check';

export { AttestationRefusedError, connectionReader, rpcReader } from '@blindseal/attestation-check';
export type { ChainReader, CheckCode } from '@blindseal/attestation-check';

export const ATTESTATION_HEADER = 'x-blindseal-attestation';

/** The payment being facilitated. `mint` is '' for native SOL; `amount` in atomic units. */
export interface Payment { payer: string; recipient: string; mint: string; amount: bigint }

export type HeadersLike = Record<string, string | string[] | undefined> | { get(name: string): string | null | undefined };
export interface GateRequest { headers: HeadersLike; body: unknown }

export interface GateOptions {
  /** Where expiry and nullifier status are read. Inject a fake in tests. */
  chain: ChainReader;
  /** Per mint ('' or 'native' for SOL): a payment with amount >= threshold needs an attestation. */
  thresholds: Record<string, bigint | number | string>;
  /** A mint with no threshold: pass it ('allow', default) or require an attestation for any amount ('require'). */
  unlistedMints?: 'allow' | 'require';
  /** How to read the payment from the request; default `x402Payment`. Return null when there is none. */
  extractPayment?: (req: GateRequest) => Payment | null | Promise<Payment | null>;
  /** Header carrying the attestation (default X-Blindseal-Attestation). */
  headerName?: string;
  /** When the facilitator knows which gated program will consume the attestation on chain. */
  consumer?: { targetProgram: string; instruction: string };
  verifyProgramId?: PublicKey;
}

export type DecisionCode = 'below_threshold' | 'ungated_mint' | 'attested' | 'no_payment' | 'missing_attestation' | CheckCode;

export type Decision =
  | { allow: true; gated: false; code: 'below_threshold' | 'ungated_mint'; payment: Payment; reason: string }
  | { allow: true; gated: true; code: 'attested'; payment: Payment; attestation: Attestation; nullifier: string; check: CheckOk }
  | { allow: false; status: 400 | 402 | 403; code: Exclude<DecisionCode, 'below_threshold' | 'ungated_mint' | 'attested'>; reason: string; field?: ActionField; payment?: Payment };

export type Gate = (req: GateRequest) => Promise<Decision>;

const toAmount = (v: bigint | number | string): bigint => (typeof v === 'bigint' ? v : BigInt(typeof v === 'number' ? Math.trunc(v) : v.trim()));

export function headerValue(headers: HeadersLike, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const v = (headers as { get(n: string): string | null | undefined }).get(name);
    return v == null ? undefined : v;
  }
  const rec = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  const v = key === undefined ? undefined : rec[key];
  return Array.isArray(v) ? v[0] : v;
}

/** Build the gate. The returned function never throws for a bad request; it returns a refusal. */
export function createGate(opts: GateOptions): Gate {
  const headerName = (opts.headerName ?? ATTESTATION_HEADER).toLowerCase();
  const extract = opts.extractPayment ?? x402Payment;
  const thresholds = new Map<string, bigint>();
  for (const [mint, t] of Object.entries(opts.thresholds)) thresholds.set(normMint(mint), toAmount(t));
  const unlisted = opts.unlistedMints ?? 'allow';

  return async (req) => {
    let payment: Payment | null;
    let mintKey: string;
    try {
      payment = await extract(req);
      if (!payment) return { allow: false, status: 400, code: 'no_payment', reason: 'no payment in the request' };
      mintKey = normMint(payment.mint); // a custom extractor may hand back a malformed mint
    } catch (e) { return { allow: false, status: 400, code: 'no_payment', reason: `payment could not be read: ${(e as Error).message}` }; }

    const threshold = thresholds.get(mintKey);
    if (threshold === undefined) {
      if (unlisted === 'allow') return { allow: true, gated: false, code: 'ungated_mint', payment, reason: `no threshold for mint ${payment.mint || 'SOL'}` };
    } else if (payment.amount < threshold) {
      return { allow: true, gated: false, code: 'below_threshold', payment, reason: `${payment.amount} is below the threshold ${threshold} for mint ${payment.mint || 'SOL'}` };
    }

    const raw = headerValue(req.headers, headerName);
    if (!raw) return { allow: false, status: 402, code: 'missing_attestation', reason: `payment of ${payment.amount} ${payment.mint || 'SOL'} needs a Blindseal attestation in ${headerName}`, payment };

    const result = await checkAttestation(raw, {
      sourceAuthority: payment.payer, recipient: payment.recipient, mint: payment.mint, amount: payment.amount,
      ...(opts.consumer ?? {}),
    }, opts.chain, { verifyProgramId: opts.verifyProgramId });
    if (!result.ok) {
      const status = result.code === 'malformed' ? 400 : 403;
      return { allow: false, status, code: result.code, reason: result.reason, ...(result.field ? { field: result.field } : {}), payment };
    }
    return { allow: true, gated: true, code: 'attested', payment, attestation: result.attestation, nullifier: result.nullifier, check: result };
  };
}

const normMint = (m: string): string => {
  const v = (m ?? '').trim();
  if (!v || v.toLowerCase() === 'native' || v.toLowerCase() === 'sol') return '';
  const k = new PublicKey(v);
  return k.equals(PublicKey.default) ? '' : k.toBase58();
};

// ---- payment extraction (x402 exact scheme on Solana) ----
export const SPL_TOKEN_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export const associatedTokenAddress = (owner: PublicKey, mint: PublicKey, tokenProgram = SPL_TOKEN_ID): PublicKey =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_ID)[0];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A decoded instruction, the same shape for legacy and versioned transactions. */
export interface DecodedIx { programId: PublicKey; keys: PublicKey[]; data: Uint8Array }

/** Decode a base64 transaction (versioned or legacy) into instructions with resolved static keys.
 *  Throws for a versioned transaction that needs address lookup tables (keys are not resolvable offline). */
export function decodeTransaction(b64: string): DecodedIx[] {
  const bytes = Buffer.from(b64, 'base64');
  let vt: VersionedTransaction | null = null;
  try { vt = VersionedTransaction.deserialize(bytes); } catch { vt = null; }
  if (vt && vt.version !== 'legacy') {
    const msg = vt.message;
    const keys = msg.staticAccountKeys;
    if (msg.addressTableLookups.length > 0) throw new Error('transaction uses address lookup tables; pass the payment explicitly');
    return msg.compiledInstructions.map((ix) => ({
      programId: keys[ix.programIdIndex]!,
      keys: ix.accountKeyIndexes.map((i) => keys[i]!),
      data: ix.data,
    }));
  }
  const tx = Transaction.from(bytes);
  return tx.instructions.map((ix) => ({ programId: ix.programId, keys: ix.keys.map((k) => k.pubkey), data: new Uint8Array(ix.data) }));
}

/** Every token or SOL transfer in the instructions: {payer (authority), destination account, amount, mint?}. */
export function transfersIn(ixs: DecodedIx[]): Array<{ programId: PublicKey; authority: PublicKey; destination: PublicKey; amount: bigint; mint?: PublicKey }> {
  const out: Array<{ programId: PublicKey; authority: PublicKey; destination: PublicKey; amount: bigint; mint?: PublicKey }> = [];
  for (const ix of ixs) {
    const d = Buffer.from(ix.data);
    if (ix.programId.equals(SystemProgram.programId) && d.length >= 12 && d.readUInt32LE(0) === 2 && ix.keys.length >= 2) {
      out.push({ programId: ix.programId, authority: ix.keys[0]!, destination: ix.keys[1]!, amount: d.readBigUInt64LE(4) });
    } else if ((ix.programId.equals(SPL_TOKEN_ID) || ix.programId.equals(TOKEN_2022_ID)) && d.length >= 9) {
      if (d[0] === 12 && ix.keys.length >= 4) { // TransferChecked: source, mint, destination, authority
        out.push({ programId: ix.programId, authority: ix.keys[3]!, destination: ix.keys[2]!, amount: d.readBigUInt64LE(1), mint: ix.keys[1]! });
      } else if (d[0] === 3 && ix.keys.length >= 3) { // Transfer: source, destination, authority (mint not in the instruction)
        out.push({ programId: ix.programId, authority: ix.keys[2]!, destination: ix.keys[1]!, amount: d.readBigUInt64LE(1) });
      }
    }
  }
  return out;
}

/**
 * The default extractor: `body.payment` when present, else the x402 exact-scheme body. Returns null when
 * the body carries no payment; throws when it carries one that cannot be read unambiguously.
 */
export function x402Payment(req: GateRequest): Payment | null {
  const body = typeof req.body === 'string' ? (JSON.parse(req.body) as unknown) : req.body;
  if (!isRecord(body)) return null;

  if (isRecord(body.payment)) {
    const p = body.payment;
    const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : undefined);
    const payer = str('payer') ?? str('sourceAuthority');
    const recipient = str('recipient') ?? str('payTo');
    const mint = str('mint') ?? str('asset') ?? '';
    const amount = p.amount;
    if (!payer || !recipient || (typeof amount !== 'string' && typeof amount !== 'number' && typeof amount !== 'bigint')) throw new Error('payment needs payer, recipient and amount');
    return { payer, recipient, mint: normMint(mint), amount: toAmount(amount) };
  }

  const payload = isRecord(body.paymentPayload) ? body.paymentPayload : undefined;
  const reqs = isRecord(body.paymentRequirements) ? body.paymentRequirements : payload && isRecord(payload.accepted) ? payload.accepted : undefined;
  if (!payload || !reqs) return null;
  const payTo = typeof reqs.payTo === 'string' ? reqs.payTo : undefined;
  const asset = typeof reqs.asset === 'string' ? reqs.asset : '';
  const required = typeof reqs.amount === 'string' ? reqs.amount : typeof reqs.maxAmountRequired === 'string' ? reqs.maxAmountRequired : undefined;
  if (!payTo) throw new Error('paymentRequirements.payTo is missing');
  const inner = isRecord(payload.payload) ? payload.payload : undefined;
  const txB64 = inner && typeof inner.transaction === 'string' ? inner.transaction : undefined;
  if (!txB64) throw new Error('paymentPayload.payload.transaction is missing (exact scheme on Solana)');

  const recipient = new PublicKey(payTo);
  const mint = normMint(asset);
  const transfers = transfersIn(decodeTransaction(txB64));
  const matching = mint
    ? transfers.filter((t) => !t.programId.equals(SystemProgram.programId)
        && (t.destination.equals(associatedTokenAddress(recipient, new PublicKey(mint), SPL_TOKEN_ID)) || t.destination.equals(associatedTokenAddress(recipient, new PublicKey(mint), TOKEN_2022_ID)))
        && (!t.mint || t.mint.toBase58() === mint))
    : transfers.filter((t) => t.programId.equals(SystemProgram.programId) && t.destination.equals(recipient));
  if (matching.length === 0) throw new Error(`no transfer to ${payTo} of ${mint || 'SOL'} in the payment transaction`);
  if (matching.length > 1) throw new Error('more than one transfer to the recipient in the payment transaction');
  const t = matching[0]!;
  if (required !== undefined && t.amount < toAmount(required)) throw new Error(`transfer of ${t.amount} is below the required ${required}`);
  return { payer: t.authority.toBase58(), recipient: recipient.toBase58(), mint, amount: t.amount };
}

// ---- adapters ----
export interface RefusalBody { error: DecisionCode; reason: string; field?: ActionField }
export const refusalBody = (d: Extract<Decision, { allow: false }>): RefusalBody => ({ error: d.code, reason: d.reason, ...(d.field ? { field: d.field } : {}) });

/** node:http: read the JSON body, decide, answer refusals with the decision's status, else call `next`. */
export function nodeHttpGate(gate: Gate, next: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, decision: Extract<Decision, { allow: true }>, body: unknown) => void | Promise<void>, limits: { maxBodyBytes?: number } = {}) {
  const max = limits.maxBodyBytes ?? 1 << 20;
  return async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<Decision> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c as string);
      size += b.length;
      if (size > max) { const d: Decision = { allow: false, status: 400, code: 'no_payment', reason: 'request body too large' }; respond(res, d); return d; }
      chunks.push(b);
    }
    let body: unknown = undefined;
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim()) { try { body = JSON.parse(text); } catch { const d: Decision = { allow: false, status: 400, code: 'no_payment', reason: 'body is not JSON' }; respond(res, d); return d; } }
    const decision = await gate({ headers: req.headers, body });
    if (!decision.allow) { respond(res, decision); return decision; }
    await next(req, res, decision, body);
    return decision;
  };
}
function respond(res: import('node:http').ServerResponse, d: Extract<Decision, { allow: false }>) {
  res.statusCode = d.status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(refusalBody(d)));
}

/** fetch-style: clone and parse the request body, decide, return a refusal Response or `next`'s. */
export function fetchGate(gate: Gate, next: (request: Request, decision: Extract<Decision, { allow: true }>, body: unknown) => Response | Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    let body: unknown = undefined;
    const text = await request.clone().text();
    if (text.trim()) { try { body = JSON.parse(text); } catch { return refusalResponse({ allow: false, status: 400, code: 'no_payment', reason: 'body is not JSON' }); } }
    const decision = await gate({ headers: request.headers, body });
    if (!decision.allow) return refusalResponse(decision);
    return next(request, decision, body);
  };
}
export const refusalResponse = (d: Extract<Decision, { allow: false }>): Response =>
  new Response(JSON.stringify(refusalBody(d)), { status: d.status, headers: { 'content-type': 'application/json' } });

/** Thrown by `requireAllowed`; carries the refusing decision. */
export class GateRefusedError extends Error {
  constructor(public readonly decision: Extract<Decision, { allow: false }>) {
    super(`blindseal x402 gate: ${decision.code}${decision.field ? ` (${decision.field})` : ''}: ${decision.reason}`);
    this.name = 'GateRefusedError';
  }
}

/** For callers that prefer an exception: throw on refusal, return the allowing decision otherwise. */
export async function requireAllowed(gate: Gate, req: GateRequest): Promise<Extract<Decision, { allow: true }>> {
  const d = await gate(req);
  if (d.allow) return d;
  throw new GateRefusedError(d);
}
