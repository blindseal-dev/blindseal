// Verifier boundary. Runs the REAL SP1 v5 Groth16 check in-browser via @blindseal/verifier-wasm
// (wasm-bindgen build of crates/verifier-wasm) — the same check the on-chain program does via
// sp1-solana (M2). The TS schema check stays so malformed input still produces the step list; the
// wasm does the cryptographic proof step. The .wasm is served from the site's own origin
// (public/blindseal_verifier_bg.wasm) — nothing is uploaded.
import init, { verify_attestation_json } from '@blindseal/verifier-wasm';
import { isDisclosure, verifyDisclosure, isCleanWindow, type Disclosure } from './disclosure';

export interface VerifyStep { id: string; label: string; ok: boolean | null; detail: string; }
export interface VerifyResult { valid: boolean; steps: VerifyStep[]; error?: string; }

const hex = /^0x[0-9a-f]+$/i;
const WASM_URL = '/blindseal_verifier_bg.wasm'; // copied into public/ at build (scripts/sync-wasm.mjs)

// Instantiate the wasm once, from our own origin. Explicit URL so Next/webpack does not need to
// resolve the glue's import.meta.url default.
let ready: Promise<unknown> | null = null;
const ensure = () => (ready ??= init({ module_or_path: WASM_URL }));

export async function verifyAttestation(json: string): Promise<VerifyResult> {
  let a: any;
  try { a = JSON.parse(json); } catch { return { valid: false, error: 'Not valid JSON.', steps: [] }; }
  if (isDisclosure(a)) return verifyDisclosureDoc(a);
  const proof = a?.proof?.bytes, pub = a?.publicInputs?.[0], vkey = a?.detectorVersion;
  const schemaOk = !!(proof && hex.test(proof)) && !!(pub && hex.test(pub)) && !!(vkey && hex.test(vkey)) && typeof a.expirySlot === 'number';

  // Real Groth16 verification: Groth16Verifier::verify(proof, publicInputs[0], detectorVersion,
  // GROTH16_VK). A tampered proof or a wrong vkey fails the curve/pairing check in the wasm.
  let proofOk = false;
  let proofDetail = 'proof did not verify';
  if (schemaOk) {
    try {
      await ensure();
    } catch (e) {
      ready = null; // a failed load (CSP/404/MIME) must not be cached — allow a retry
      return { valid: false, error: `Verifier failed to load: ${e instanceof Error ? e.message : String(e)}`, steps: [] };
    }
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

/** A disclosure.json (BLINDSEAL.md §3.6): signature + in-window chain consistency, in the browser. */
async function verifyDisclosureDoc(d: Disclosure): Promise<VerifyResult> {
  const v = await verifyDisclosure(d);
  const n = d.entries.length;
  const clean = isCleanWindow(d);
  const steps: VerifyStep[] = [
    { id: 'schema', label: 'Disclosure is well-formed', ok: true, detail: `window #${d.from}–#${d.to}, ${n} content-free entries` },
    { id: 'signature', label: 'Signed by the stated proxy identity', ok: v.ok ? true : (v.reason === 'signature mismatch' || v.reason?.startsWith('bad signer') ? false : true), detail: v.ok ? `ed25519 over the canonical window · signer ${d.signerPubkey.slice(0, 16)}…` : (v.reason ?? 'signature did not verify') },
    { id: 'chain', label: 'Entry hashes reproduce and link in order', ok: v.ok ? true : (v.reason?.includes('hash mismatch') || v.reason?.includes('prevHash') ? false : null), detail: v.ok ? `${n} entries recomputed from their six fields; every prevHash links to the previous hash` : (v.reason ?? '') },
    { id: 'clean', label: 'Clean window', ok: v.ok ? clean : null, detail: v.ok ? (clean ? 'every disclosed decision passed' : 'window contains non-pass verdicts (still a valid disclosure)') : 'not evaluated' },
    { id: 'content', label: 'No content disclosed', ok: true, detail: 'only ids, verdicts, payload hashes and timestamps are in this file' },
  ];
  return { valid: v.ok, steps };
}
