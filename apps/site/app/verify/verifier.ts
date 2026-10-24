// Verifier boundary — the REAL checks behind the S03 checklist. Step 2 runs the SP1 v5 Groth16
// check in-browser via blindseal-verifier-wasm (wasm-bindgen build of crates/verifier-wasm) — the
// same check the on-chain program does via sp1-solana. Steps 1 and 3 are plain TS (schema, and the
// public-input blob decoded into its six fields and cross-checked against the file). The .wasm is
// served from the site's own origin (public/blindseal_verifier_bg.wasm) — nothing is uploaded.
import init, { verify_attestation_json } from 'blindseal-verifier-wasm';
import { isDisclosure, verifyDisclosure, isCleanWindow, type Disclosure } from './disclosure';

export type AttestationDoc = {
  version?: unknown; actionHash?: string; policyRoot?: string; detectorVersion?: string; expirySlot?: unknown;
  nullifier?: string; payloadHash?: string; publicInputs?: unknown; proof?: { protocol?: unknown; curve?: unknown; bytes?: unknown };
  [k: string]: unknown;
};

const HEX64 = /^0x[0-9a-f]{64}$/i;
const HEX_PROOF = /^0x[0-9a-f]{520}$/i;   // 260 bytes: 4-byte vkey hash prefix + the 256-byte groth16 proof
const HEX_BLOB = /^0x[0-9a-f]{336}$/i;    // 168 bytes: 5 × 32-byte fields + u64 LE expiry slot
const REQUIRED = ['version', 'actionHash', 'policyRoot', 'detectorVersion', 'expirySlot', 'nullifier', 'publicInputs', 'proof'] as const;

/* ── step 1: schema ────────────────────────────────────────────────────── */
export interface SchemaResult { ok: boolean; errors: string[]; kind: 'attestation' | 'disclosure'; doc: AttestationDoc | Disclosure | null; }

export function schemaCheck(json: string): SchemaResult {
  let doc: unknown;
  try { doc = JSON.parse(json); } catch (e) { return { ok: false, errors: ['not valid JSON: ' + (e instanceof Error ? e.message : String(e))], kind: 'attestation', doc: null }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, errors: ['not an attestation object'], kind: 'attestation', doc: null };
  if (isDisclosure(doc)) return disclosureSchema(doc);
  const a = doc as AttestationDoc;
  const errors: string[] = [];
  for (const k of REQUIRED) if (a[k] === undefined || a[k] === null || a[k] === '') errors.push('missing field: ' + k);
  if (a.version !== undefined && a.version !== 1) errors.push('version must be 1');
  for (const k of ['actionHash', 'policyRoot', 'nullifier', 'detectorVersion', 'payloadHash'] as const) if (a[k] && !HEX64.test(String(a[k]))) errors.push(k + ' must be 0x + 64 hex');
  if (a.expirySlot !== undefined && !(Number.isInteger(a.expirySlot) && (a.expirySlot as number) >= 0)) errors.push('expirySlot must be a non-negative integer');
  if (a.publicInputs !== undefined) {
    if (!Array.isArray(a.publicInputs) || a.publicInputs.length !== 1) errors.push('publicInputs must be an array of one 168-byte blob');
    else if (!HEX_BLOB.test(String(a.publicInputs[0]))) errors.push('publicInputs[0] must be 0x + 336 hex (168 bytes)');
  }
  if (a.proof !== undefined) {
    if (typeof a.proof !== 'object' || !a.proof) errors.push('proof must be an object');
    else {
      if (a.proof.protocol !== 'groth16') errors.push('proof.protocol must be groth16');
      if (a.proof.curve !== 'bn254') errors.push('proof.curve must be bn254');
      if (!HEX_PROOF.test(String(a.proof.bytes ?? ''))) errors.push('proof.bytes must be 0x + 520 hex');
    }
  }
  return { ok: errors.length === 0, errors, kind: 'attestation', doc: a };
}

function disclosureSchema(d: Disclosure): SchemaResult {
  const errors: string[] = [];
  if (!Number.isInteger(d.from) || !Number.isInteger(d.to)) errors.push('from / to must be integers');
  if (!d.head || typeof d.head !== 'object') errors.push('missing field: head');
  if (typeof d.signerPubkey !== 'string' || !/^(0x)?[0-9a-f]{88}$/i.test(d.signerPubkey)) errors.push('signerPubkey must be 88 hex (Ed25519 SPKI DER)');
  if (!/^(0x)?[0-9a-f]{128}$/i.test(d.signature)) errors.push('signature must be 128 hex (ed25519)');
  if (!d.entries.length) errors.push('entries must not be empty');
  d.entries.forEach((e, i) => {
    for (const k of ['index', 'hash', 'prevHash', 'ts', 'verdict', 'decisionId', 'payloadHash'] as const) if (e[k] === undefined || e[k] === null || e[k] === '') errors.push('entries[' + i + '] missing field: ' + k);
  });
  return { ok: errors.length === 0, errors, kind: 'disclosure', doc: d };
}

/* ── step 2: the groth16 proof, in the wasm ────────────────────────────── */
const WASM_URL = '/blindseal_verifier_bg.wasm'; // copied into public/ at build (scripts/sync-wasm.mjs)
let ready: Promise<unknown> | null = null;
const ensure = () => (ready ??= init({ module_or_path: WASM_URL }));

export interface ProofResult { ok: boolean; reason: string | null; loadError?: boolean; }

export async function verifyProof(json: string): Promise<ProofResult> {
  try { await ensure(); } catch (e) {
    ready = null; // a failed load (CSP/404/MIME) must not be cached — allow a retry
    return { ok: false, reason: 'verifier failed to load: ' + (e instanceof Error ? e.message : String(e)), loadError: true };
  }
  // Groth16Verifier::verify(proof, publicInputs[0], detectorVersion, GROTH16_VK). A tampered proof
  // or a wrong vkey fails the curve/pairing check in the wasm.
  const r = JSON.parse(verify_attestation_json(json)) as { ok: boolean; reason: string | null };
  return { ok: r.ok, reason: r.reason };
}

/* ── step 3: the public-input blob → six fields, cross-checked with the file ── */
export interface Decoded {
  payloadHash: string; policyRoot: string; detectorVersion: string; actionHash: string; nullifier: string; expirySlot: string;
  proofBytes: number; mismatches: string[];
}

export function decodePublicInputs(a: AttestationDoc): Decoded {
  const hex = String((a.publicInputs as string[])[0]).replace(/^0x/, '').toLowerCase();
  const f = (i: number) => '0x' + hex.slice(i * 64, i * 64 + 64);
  let slot = 0n;
  const s = hex.slice(320, 336);
  for (let i = s.length - 2; i >= 0; i -= 2) slot = (slot << 8n) | BigInt(parseInt(s.slice(i, i + 2), 16));
  const dec: Decoded = {
    payloadHash: f(0), policyRoot: f(1), detectorVersion: f(2), actionHash: f(3), nullifier: f(4), expirySlot: slot.toString(),
    proofBytes: (String(a.proof?.bytes ?? '').length - 2) / 2, mismatches: [],
  };
  const same = (k: 'payloadHash' | 'policyRoot' | 'detectorVersion' | 'actionHash' | 'nullifier') => {
    const top = a[k]; if (top === undefined) return;
    if (String(top).toLowerCase() !== dec[k]) dec.mismatches.push(k + ' in the blob differs from the file’s ' + k);
  };
  (['payloadHash', 'policyRoot', 'detectorVersion', 'actionHash', 'nullifier'] as const).forEach(same);
  if (a.expirySlot !== undefined && String(a.expirySlot) !== dec.expirySlot) dec.mismatches.push('expirySlot in the blob differs from the file’s expirySlot');
  return dec;
}

/* ── disclosures (BLINDSEAL.md §3.6): signature, chain, clean window ───── */
export interface DisclosureResult { sigOk: boolean; chainOk: boolean | null; clean: boolean; reason: string | null; }

export async function verifyDisclosureSteps(d: Disclosure): Promise<DisclosureResult> {
  const v = await verifyDisclosure(d);
  if (v.ok) return { sigOk: true, chainOk: true, clean: isCleanWindow(d), reason: null };
  const r = v.reason ?? 'signature did not verify';
  const sigFail = r === 'signature mismatch' || r.startsWith('bad signer');
  return { sigOk: !sigFail, chainOk: sigFail ? null : false, clean: false, reason: r };
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
