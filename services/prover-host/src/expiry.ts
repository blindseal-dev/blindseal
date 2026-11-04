/// The attestation's expiry slot: given by the client, the no-expiry sentinel, or the current mainnet
/// slot plus the same window `blindseal attest` uses.
export const NO_EXPIRY_SLOT = '2000000000';
export const EXPIRY_WINDOW_SLOTS = 40_000; // ≈ 4.4 h at 0.4 s/slot

export class ExpiryError extends Error {
  constructor(message: string, public readonly status: 400 | 503) { super(message); this.name = 'ExpiryError'; }
}

export async function fetchCurrentSlot(rpcUrl: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`RPC answered HTTP ${res.status}`);
  const j = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`getSlot: ${j.error.message}`);
  if (typeof j.result !== 'number') throw new Error('getSlot returned no slot');
  return j.result;
}

export async function resolveExpiry(
  input: { expirySlot?: unknown; noExpiry?: unknown }, rpcUrl: string, fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (input.expirySlot !== undefined && input.noExpiry === true) throw new ExpiryError('expirySlot and noExpiry are mutually exclusive', 400);
  if (input.noExpiry === true) return NO_EXPIRY_SLOT;
  if (input.expirySlot !== undefined) {
    const s = typeof input.expirySlot === 'number' ? String(input.expirySlot) : input.expirySlot;
    if (typeof s !== 'string' || !/^\d{1,10}$/.test(s)) throw new ExpiryError('expirySlot must be a slot number', 400);
    return String(BigInt(s));
  }
  try {
    return String((await fetchCurrentSlot(rpcUrl, fetchImpl)) + EXPIRY_WINDOW_SLOTS);
  } catch (e) {
    throw new ExpiryError(`could not fetch the current slot (${(e as Error).message}); pass expirySlot or noExpiry`, 503);
  }
}
