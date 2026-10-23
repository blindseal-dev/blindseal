// Verifier boundary. Runs the REAL SP1 v5 Groth16 check in-browser via @blindseal/verifier-wasm
// (wasm-bindgen build of crates/verifier-wasm) — the same check the on-chain program does via
// sp1-solana (M2). Nothing else imports the verifier. The TS schema check below stays so malformed
// input still produces the step list; the wasm does the cryptographic proof step.
import init, { verify_attestation_json } from '@blindseal/verifier-wasm';

export interface VerifyStep { id: string; label: string; ok: boolean | null; detail: string; }
export interface VerifyResult { valid: boolean; steps: VerifyStep[]; error?: string; }

const hex = /^0x[0-9a-f]+$/i;

// Instantiate the wasm once. Vite resolves `new URL('…_bg.wasm', import.meta.url)` inside the glue
// to the emitted asset, so no-arg init works and the module is fetched from our own origin.
let ready: Promise<unknown> | null = null;
const ensure = () => (ready ??= init());

export async function verifyAttestation(json: string): Promise<VerifyResult> {
  let a: any;
  try { a = JSON.parse(json); } catch { return { valid: false, error: 'Not valid JSON.', steps: [] }; }
  const proof = a?.proof?.bytes, pub = a?.publicInputs?.[0], vkey = a?.detectorVersion;
  const schemaOk = !!(proof && hex.test(proof)) && !!(pub && hex.test(pub)) && !!(vkey && hex.test(vkey)) && typeof a.expirySlot === 'number';

  // Real Groth16 verification: Groth16Verifier::verify(proof, publicInputs[0], detectorVersion,
  // GROTH16_VK). Only attempted when the fields are structurally present; a tampered proof or a
  // wrong vkey fails the curve/pairing check in the wasm.
  let proofOk = false;
  let proofDetail = 'proof did not verify';
  if (schemaOk) {
    await ensure();
    const r = JSON.parse(verify_attestation_json(json)) as { ok: boolean; reason: string | null };
    proofOk = r.ok;
    proofDetail = r.ok
      ? 'proof checks against the committed public inputs and vkey'
      : `proof did not verify${r.reason ? ` (${r.reason})` : ''}`;
  }

  const steps: VerifyStep[] = [
    { id: 'schema', label: 'Attestation is well-formed', ok: schemaOk, detail: schemaOk ? 'proof, publicInputs and detectorVersion present' : 'missing or malformed proof / publicInputs / detectorVersion' },
    { id: 'proof', label: 'Groth16 proof verifies (in-browser)', ok: proofOk, detail: proofDetail },
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
