// The attested public inputs, for display. The guest/on-chain commitment is a single 168-byte blob
// (publicInputs[0]): payloadHash‖policyRoot‖detectorVersion‖actionHash‖nullifier (5×32 bytes) then
// an 8-byte little-endian expirySlot. The dashboard decodes that blob into the six labelled fields
// for display (FRONTEND-CONTRACT.md: "clients decode publicInputs[0] into those six fields … they
// verify against the blob, not the fields"). Mock list fixtures may still carry the decoded
// 6-element array; both shapes render the same six rows, so a real attestation and a fixture look
// identical in the sheet.
export interface PublicInputField { label: string; value: string; hash: boolean; }

const LABELS = ['payloadHash', 'policyRoot', 'detectorVersion', 'actionHash', 'nullifier', 'expirySlot'] as const;
const BLOB_BYTES = 168; // 5×32 + 8

export function splitPublicInputs(publicInputs: readonly string[] | undefined): PublicInputField[] {
  const pi = publicInputs ?? [];

  // Already-decoded 6-element array (mock fixtures): first five are hashes, last is the slot.
  if (pi.length >= 6) {
    return LABELS.map((label, i) => ({ label, value: pi[i] ?? '', hash: i < 5 }));
  }

  // Real single-blob commitment: slice into the six fields.
  if (pi.length === 1) {
    const hex = pi[0].replace(/^0x/, '');
    if (hex.length >= 2 * BLOB_BYTES) {
      const fields: PublicInputField[] = LABELS.slice(0, 5).map((label, i) => ({
        label, value: '0x' + hex.slice(i * 64, i * 64 + 64), hash: true,
      }));
      fields.push({ label: 'expirySlot', value: decodeLeU64(hex.slice(160 * 2, 160 * 2 + 16)), hash: false });
      return fields;
    }
  }

  // Unknown shape: show whatever is there, labelled by position.
  return pi.map((value, i) => ({ label: LABELS[i] ?? `#${i}`, value, hash: true }));
}

/** Decode a little-endian u64 from an 8-byte hex string (no 0x) to a decimal string. */
function decodeLeU64(hex: string): string {
  let v = 0n;
  for (let i = hex.length - 2; i >= 0; i -= 2) v = (v << 8n) | BigInt(parseInt(hex.slice(i, i + 2), 16));
  return v.toString();
}
