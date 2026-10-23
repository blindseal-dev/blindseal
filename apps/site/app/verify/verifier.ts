// Isolated verifier boundary. Mock now; swap the body of verifyAttestation for a dynamic import of
// @blindseal/verifier-wasm (wasm-bindgen) when M1 ships — nothing else imports the verifier.
export interface VerifyStep { id: string; label: string; ok: boolean | null; detail: string; }
export interface VerifyResult { valid: boolean; steps: VerifyStep[]; error?: string; }

const hex = /^0x[0-9a-f]+$/i;

export async function verifyAttestation(json: string, canonical?: string): Promise<VerifyResult> {
  let a: any;
  try { a = JSON.parse(json); } catch { return { valid: false, error: 'Not valid JSON.', steps: [] }; }
  const proof = a?.proof?.bytes, pub = a?.publicInputs?.[0], vkey = a?.detectorVersion;
  const schemaOk = !!(proof && hex.test(proof)) && !!(pub && hex.test(pub)) && !!(vkey && hex.test(vkey)) && typeof a.expirySlot === 'number';
  // Mock proof check: structurally valid Groth16 fields present AND, when a canonical good
  // attestation is supplied, the proof + public inputs match it bit-for-bit (so a tampered copy
  // fails). The real swap ignores `canonical` and runs the WASM verifier:
  // Groth16Verifier::verify(proof, publicInputs[0], detectorVersion, GROTH16_VK).
  let proofOk = schemaOk;
  if (schemaOk && canonical) {
    try {
      const c = JSON.parse(canonical);
      proofOk = c.proof?.bytes === proof && JSON.stringify(c.publicInputs) === JSON.stringify(a.publicInputs);
    } catch { /* canonical unreadable → fall back to structural */ }
  }
  const steps: VerifyStep[] = [
    { id: 'schema', label: 'Attestation is well-formed', ok: schemaOk, detail: schemaOk ? 'proof, publicInputs and detectorVersion present' : 'missing or malformed proof / publicInputs / detectorVersion' },
    { id: 'proof', label: 'Groth16 proof verifies (in-browser)', ok: proofOk, detail: proofOk ? 'proof checks against the committed public inputs and vkey (mock verifier)' : 'proof did not verify' },
    { id: 'detector', label: 'Detector version is an allowlisted vkey', ok: null, detail: 'needs an allowlist or an RPC read — not checked offline' },
    { id: 'policy', label: 'Policy root is allowlisted on chain', ok: null, detail: 'needs a Solana RPC read — not checked offline' },
    { id: 'nullifier', label: 'Nullifier is not yet consumed', ok: null, detail: 'needs a Solana account read — not checked offline' },
  ];
  return { valid: proofOk, steps };
}

/** Flip the last proof nibble to produce a tampered copy for the demo loader. */
export function tamper(json: string): string {
  try {
    const a = JSON.parse(json);
    const b = String(a.proof.bytes);
    a.proof.bytes = b.slice(0, -1) + (b.slice(-1) === '0' ? '1' : '0');
    return JSON.stringify(a, null, 2);
  } catch { return json; }
}
