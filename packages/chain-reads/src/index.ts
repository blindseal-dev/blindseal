/// Mainnet reads for the verifier program (server-side only — the dashboard and site never talk
/// to an RPC from the browser; they ask us, same-origin, so zero-egress holds for the UI).
/// Read-only JSON-RPC over fetch; no SDK dependency. RPC = BLINDSEAL_RPC_URL, else the public
/// endpoint (rate-limited — logged once). `BLINDSEAL_RPC_URL=off` disables reads (tests).
import { createHash } from 'node:crypto';

export const VERIFY_PROGRAM_ID = '6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx';
export const PUBLIC_MAINNET_RPC = 'https://api.mainnet-beta.solana.com';
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

let warned = false;
export function rpcUrl(): string | null {
  const u = process.env.BLINDSEAL_RPC_URL;
  if (u === 'off') return null;
  if (u) return u;
  if (!warned) {
    warned = true;
    process.stderr.write('blindseal: BLINDSEAL_RPC_URL unset — using the public mainnet RPC (rate-limited; ~100 req/10s per IP). Set your own endpoint for production.\n');
  }
  return PUBLIC_MAINNET_RPC;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const url = rpcUrl();
  if (!url) throw new Error('rpc disabled (BLINDSEAL_RPC_URL=off)');
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 429) throw new Error('rpc rate-limited (429) — set BLINDSEAL_RPC_URL');
  const j = (await res.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result as T;
}

/// Anchor account discriminator: sha256("account:<Name>")[..8]
const disc = (name: string) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
const b58 = (bytes: Uint8Array) => bs58encode(bytes);

// --- base58 (encode only; small, dependency-free) ---
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58encode(bytes: Uint8Array): string {
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) { carry += digits[j]! << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join('');
}
function bs58decode(s: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of s) {
    let carry = ALPHABET.indexOf(ch);
    if (carry < 0) throw new Error('bad base58');
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j]! * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0; while (zeros < s.length && s[zeros] === '1') zeros++;
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

// --- PDA derivation without web3.js: find_program_address = sha256(seeds‖bump‖program‖"ProgramDerivedAddress") off-curve ---
// On-curve test = Ed25519 point decompression (RFC 8032 §5.1.3) in BigInt: `crypto.createPublicKey`
// is NOT a substitute — Node 24 imports any 32 bytes as an Ed25519 SPKI key without checking the
// curve, which made every candidate look on-curve and findProgramAddress throw "no PDA bump".
const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n; // -121665/121666 mod p
const SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752n; // 2^((p-1)/4)
function modPow(b: bigint, e: bigint, m: bigint): bigint { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }
export function isOnCurve(pk: Uint8Array): boolean {
  if (pk.length !== 32) return false;
  let y = 0n; for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(pk[i]!);
  const sign = (y >> 255n) & 1n; y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const y2 = (y * y) % P, u = (y2 - 1n + P) % P, v = (D * y2 + 1n) % P;   // x² = u/v
  const v3 = (v * v % P) * v % P, v7 = (v3 * v3 % P) * v % P;
  let x = (u * v3 % P) * modPow(u * v7 % P, (P - 5n) / 8n, P) % P;        // candidate root
  const vx2 = v * (x * x % P) % P;
  if (vx2 === u) { /* root found */ }
  else if (vx2 === (P - u) % P) x = x * SQRT_M1 % P;
  else return false;                                                        // x² is not a square → not a point
  if (x === 0n && sign === 1n) return false;
  return true;
}
export function findProgramAddress(seeds: Uint8Array[], programId: string): string {
  const prog = bs58decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump)); h.update(prog); h.update('ProgramDerivedAddress');
    const cand = h.digest();
    if (!isOnCurve(cand)) return b58(cand);
  }
  throw new Error('no PDA bump');
}

export interface NullifierStatus {
  nullifier: string;
  consumed: boolean;
  pda: string;
  consumedAtSlot?: number;
  consumerProgram?: string;
  actionHash?: string;
  cluster: 'mainnet-beta';
  rpc: 'configured' | 'public';
}

/// Nullifier PDA = [b"nullifier", nullifier32]. Layout: 8 disc ‖ u64 LE slot ‖ 32 consumer ‖ 32 actionHash ‖ u8 bump.
export async function getNullifierStatus(nullifierHex: string): Promise<NullifierStatus> {
  const nf = Buffer.from(nullifierHex.replace(/^0x/, ''), 'hex');
  if (nf.length !== 32) throw new Error('nullifier must be 32 bytes');
  const pda = findProgramAddress([Buffer.from('nullifier'), nf], VERIFY_PROGRAM_ID);
  const r = await rpc<{ value: { data: [string, string] } | null }>('getAccountInfo', [pda, { encoding: 'base64', commitment: 'confirmed' }]);
  const base: NullifierStatus = { nullifier: nullifierHex, consumed: false, pda, cluster: 'mainnet-beta', rpc: process.env.BLINDSEAL_RPC_URL ? 'configured' : 'public' };
  if (!r.value) return base;
  const data = Buffer.from(r.value.data[0], 'base64');
  if (data.length < 81 || !data.subarray(0, 8).equals(disc('Nullifier'))) return base;
  return {
    ...base, consumed: true,
    consumedAtSlot: Number(data.readBigUInt64LE(8)),
    consumerProgram: b58(data.subarray(16, 48)),
    actionHash: '0x' + data.subarray(48, 80).toString('hex'),
  };
}

/// Public program names. A consumer program shows a name only where one is published; everything
/// else is "No public name" in the explorer. Pubkey::default() is the verifier's marker for a direct
/// submission (SDK submit / CLI) with no gated program.
export const KNOWN_PROGRAM_NAMES: Record<string, string> = {
  '9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa': 'transfer-gate (example)',
  '11111111111111111111111111111111': 'Direct submission (no gated program)',
};

/// Anchor event discriminator: sha256("event:<Name>")[..8] — Consumed = [30,74,68,130,40,188,227,125]
const eventDisc = (name: string) => createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);

export interface ExplorerSnapshot {
  /// false → offline: `error` says why (BLINDSEAL_RPC_URL=off, a failed or rate-limited read)
  live: boolean;
  programId: string;
  cluster: 'mainnet-beta';
  rpc: 'configured' | 'public' | 'off';
  /// current slot (confirmed) at read time; 0 when offline
  slot: number;
  /// wall-clock ms of the read (the server's clock); a cached snapshot keeps its own
  updatedAt: number;
  /// total = Nullifier PDAs owned by the program (one per consumed attestation);
  /// perDay = the last 90 UTC days ending on the read's day, oldest first, every day present
  consumed: { total: number; perDay: { day: string; count: number }[] };
  /// from the `Consumed` events (policy_root field) in the program's confirmed transactions
  policyRoots: { root: string; count: number }[];
  /// from the Nullifier PDAs' consumer_program field (Pubkey::default() = direct submission)
  consumerPrograms: { programId: string; count: number; name?: string }[];
  /// provenance: how many PDAs / signatures / events were read, whether the signature scan hit
  /// its cap, and how many consumptions had to be day-bucketed from their slot (no event found)
  source: { nullifierAccounts: number; signaturesScanned: number; consumedEvents: number; truncated: boolean; slotBucketed: number };
  error?: { code: 'RPC_OFF' | 'RPC_RATE_LIMITED' | 'RPC_UNAVAILABLE'; message: string };
}

const DAY_MS = 86_400_000;
const SIGNATURE_CAP = 1000;     // the program is new; bounded so the public RPC is never walked
const TX_CONCURRENCY = 4;
const SNAPSHOT_TTL_MS = 60_000; // module-memory cache: a live snapshot is reused for 60 s

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
function rpcMode(): ExplorerSnapshot['rpc'] { return process.env.BLINDSEAL_RPC_URL === 'off' ? 'off' : process.env.BLINDSEAL_RPC_URL ? 'configured' : 'public'; }

function offline(code: NonNullable<ExplorerSnapshot['error']>['code'], message: string): ExplorerSnapshot {
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  return {
    live: false, programId: VERIFY_PROGRAM_ID, cluster: 'mainnet-beta', rpc: rpcMode(), slot: 0, updatedAt: Date.now(),
    consumed: { total: 0, perDay: Array.from({ length: 90 }, (_, i) => ({ day: utcDay(today - (89 - i) * DAY_MS), count: 0 })) },
    policyRoots: [], consumerPrograms: [],
    source: { nullifierAccounts: 0, signaturesScanned: 0, consumedEvents: 0, truncated: false, slotBucketed: 0 },
    error: { code, message },
  };
}

interface SigInfo { signature: string; slot: number; blockTime: number | null; err: unknown | null }
interface TxInfo { slot: number; blockTime: number | null; meta: { err: unknown | null; logMessages?: string[] } | null }

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

async function readSnapshot(): Promise<ExplorerSnapshot> {
  const now = Date.now();
  const slot = await rpc<number>('getSlot', [{ commitment: 'confirmed' }]);

  // 1. the Nullifier PDAs: one per consumed attestation → total, consumer program, consumed slot
  const accts = await rpc<{ pubkey: string; account: { data: [string, string] } }[]>('getProgramAccounts', [VERIFY_PROGRAM_ID, { encoding: 'base64', commitment: 'confirmed' }]);
  const nfDisc = disc('Nullifier');
  const nullifiers = new Map<string, { consumer: string; slot: number }>();
  for (const a of accts) {
    const d = Buffer.from(a.account.data[0], 'base64');
    if (d.length >= 81 && d.subarray(0, 8).equals(nfDisc)) nullifiers.set(a.pubkey, { consumer: b58(d.subarray(16, 48)), slot: Number(d.readBigUInt64LE(8)) });
  }

  // 2. the Consumed events: the PDA stores no policy root, so each consumption's root (and its real
  //    blockTime) comes from the event the program emits in the consuming transaction's logs
  const sigs = await rpc<SigInfo[]>('getSignaturesForAddress', [VERIFY_PROGRAM_ID, { limit: SIGNATURE_CAP, commitment: 'confirmed' }]);
  const ok = sigs.filter((s) => s.err == null); // a failed tx (e.g. the rejected replay) consumed nothing
  const cDisc = eventDisc('Consumed');
  const events: { nullifier: Buffer; root: string; consumer: string; blockTime: number | null; slot: number }[] = [];
  const txs = await mapLimit(ok, TX_CONCURRENCY, (s) => rpc<TxInfo | null>('getTransaction', [s.signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]));
  txs.forEach((tx, i) => {
    if (!tx?.meta || tx.meta.err != null) return;
    for (const line of tx.meta.logMessages ?? []) {
      if (!line.startsWith('Program data: ')) continue;
      let b: Buffer; try { b = Buffer.from(line.slice(14), 'base64'); } catch { continue; }
      if (b.length < 136 || !b.subarray(0, 8).equals(cDisc)) continue;
      events.push({ nullifier: Buffer.from(b.subarray(8, 40)), root: '0x' + b.subarray(72, 104).toString('hex'), consumer: b58(b.subarray(104, 136)), blockTime: tx.blockTime ?? ok[i]!.blockTime, slot: tx.slot });
    }
  });

  // 3. day buckets (UTC): from the event's blockTime; a consumption whose event was not in the scan
  //    (cap hit, or no blockTime) is bucketed from its consumed slot anchored to now (0.4 s/slot)
  const perDayMap = new Map<string, number>();
  const bump = (day: string) => perDayMap.set(day, (perDayMap.get(day) ?? 0) + 1);
  const roots = new Map<string, number>();
  const seenPda = new Set<string>();
  let slotBucketed = 0;
  for (const e of events) {
    roots.set(e.root, (roots.get(e.root) ?? 0) + 1);
    if (e.blockTime != null) bump(utcDay(e.blockTime * 1000));
    else { slotBucketed++; bump(utcDay(now - (slot - e.slot) * 400)); }
    if (events.length !== nullifiers.size) seenPda.add(findProgramAddress([Buffer.from('nullifier'), e.nullifier], VERIFY_PROGRAM_ID));
  }
  if (events.length !== nullifiers.size) {
    for (const [pda, n] of nullifiers) if (!seenPda.has(pda)) { slotBucketed++; bump(utcDay(now - (slot - n.slot) * 400)); }
  }
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const perDay = Array.from({ length: 90 }, (_, i) => { const day = utcDay(today - (89 - i) * DAY_MS); return { day, count: perDayMap.get(day) ?? 0 }; });

  const consumers = new Map<string, number>();
  for (const n of nullifiers.values()) consumers.set(n.consumer, (consumers.get(n.consumer) ?? 0) + 1);

  return {
    live: true, programId: VERIFY_PROGRAM_ID, cluster: 'mainnet-beta', rpc: rpcMode(), slot, updatedAt: now,
    consumed: { total: nullifiers.size, perDay },
    policyRoots: [...roots].map(([root, count]) => ({ root, count })).sort((a, b) => b.count - a.count),
    consumerPrograms: [...consumers].map(([programId, count]) => ({ programId, count, ...(KNOWN_PROGRAM_NAMES[programId] ? { name: KNOWN_PROGRAM_NAMES[programId] } : {}) })).sort((a, b) => b.count - a.count),
    source: { nullifierAccounts: nullifiers.size, signaturesScanned: sigs.length, consumedEvents: events.length, truncated: sigs.length >= SIGNATURE_CAP, slotBucketed },
  };
}

let cached: { at: number; snap: ExplorerSnapshot } | null = null;
let inflight: Promise<ExplorerSnapshot> | null = null;

/// Public reads only: consumed attestations (total, per UTC day), policy roots in use, consumer
/// programs. A live snapshot is cached in module memory for 60 s (one read serves every visitor in
/// that window; concurrent callers share one in-flight read). Failures are never cached, so a Retry
/// really re-reads. Never throws: an unreachable RPC is a `live: false` snapshot with `error`.
export async function getExplorerSnapshot(): Promise<ExplorerSnapshot> {
  if (!rpcUrl()) return offline('RPC_OFF', 'Mainnet reads are switched off on this server (BLINDSEAL_RPC_URL=off).');
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.snap;
  if (inflight) return inflight;
  inflight = readSnapshot()
    .then((snap) => { cached = { at: Date.now(), snap }; return snap; })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return /429|rate-limited/i.test(msg)
        ? offline('RPC_RATE_LIMITED', 'The public Solana RPC is rate-limiting this server. Retry in a moment.')
        : offline('RPC_UNAVAILABLE', 'Solana RPC unreachable. Retry in a moment.');
    })
    .finally(() => { inflight = null; });
  return inflight;
}
