/// Mainnet reads for the verifier program (server-side only — the dashboard and site never talk
/// to an RPC from the browser; they ask us, same-origin, so zero-egress holds for the UI).
/// Read-only JSON-RPC over fetch; no SDK dependency. RPC = BLINDSEAL_RPC_URL, else the public
/// endpoint (rate-limited — logged once). `BLINDSEAL_RPC_URL=off` disables reads (tests).
import { createHash } from 'node:crypto';

export const VERIFY_PROGRAM_ID = 'merZNYKpKwwX4CGgzvma3jPvLfrMTkZcb1cSXUKANcb';
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
import { createPublicKey } from 'node:crypto';
function isOnCurve(pk: Uint8Array): boolean {
  // An Ed25519 public key is on-curve iff Node can import it as an Ed25519 key.
  try {
    createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pk)]), format: 'der', type: 'spki' });
    return true;
  } catch { return false; }
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

export interface ExplorerSnapshot {
  live: boolean;
  programId: string;
  verifications: number;
  policyRoots: { root: string; registeredAtSlot: number }[];
  consumers: { id: string; calls: number }[];
  perDay: number[]; // last 14 days, oldest first (slot-time approximation: 0.4 s/slot)
  currentSlot?: number;
  rpc: 'configured' | 'public' | 'off';
  error?: string;
}

/// Public reads only: counts of consumed nullifiers, registered policy roots, consumer programs.
export async function getExplorerSnapshot(): Promise<ExplorerSnapshot> {
  const empty: ExplorerSnapshot = { live: false, programId: VERIFY_PROGRAM_ID, verifications: 0, policyRoots: [], consumers: [], perDay: new Array(14).fill(0), rpc: process.env.BLINDSEAL_RPC_URL === 'off' ? 'off' : process.env.BLINDSEAL_RPC_URL ? 'configured' : 'public' };
  if (!rpcUrl()) return empty;
  try {
    const slot = await rpc<number>('getSlot', [{ commitment: 'confirmed' }]);
    const accts = await rpc<{ pubkey: string; account: { data: [string, string] } }[]>('getProgramAccounts', [VERIFY_PROGRAM_ID, { encoding: 'base64', commitment: 'confirmed' }]);
    const nfDisc = disc('Nullifier'), prDisc = disc('PolicyRoot');
    const consumers = new Map<string, number>();
    const perDay = new Array(14).fill(0);
    let verifications = 0;
    const policyRoots: ExplorerSnapshot['policyRoots'] = [];
    for (const a of accts) {
      const d = Buffer.from(a.account.data[0], 'base64');
      if (d.subarray(0, 8).equals(nfDisc) && d.length >= 81) {
        verifications++;
        const consumer = b58(d.subarray(16, 48));
        consumers.set(consumer, (consumers.get(consumer) ?? 0) + 1);
        const ageDays = Math.floor(((slot - Number(d.readBigUInt64LE(8))) * 0.4) / 86400);
        if (ageDays >= 0 && ageDays < 14) perDay[13 - ageDays]++;
      } else if (d.subarray(0, 8).equals(prDisc) && d.length >= 49) {
        policyRoots.push({ root: '0x' + d.subarray(8, 40).toString('hex'), registeredAtSlot: Number(d.readBigUInt64LE(40)) });
      }
    }
    return { ...empty, live: true, verifications, policyRoots, perDay, currentSlot: slot,
      consumers: [...consumers].map(([id, calls]) => ({ id: id === '11111111111111111111111111111111' ? 'direct submit' : id, calls })).sort((x, y) => y.calls - x.calls) };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
}
