/// `blindseal verify <file>` — off-chain verification, offline. Accepts either an
/// attestation.json (real Groth16 verify via the wasm verifier, same code as the verify page) or a
/// disclosure.json (ed25519 signature + in-window hash-chain consistency). Exit 0 iff valid.
import { readFileSync } from 'node:fs';
import { verifyDisclosure, isCleanWindow, CLEAN_VERDICT, type Disclosure } from '@blindseal/audit';
import { verifyOffchain, decodePublicInputs, type ActionBinding, type Attestation, type VerifyResult } from 'blindseal-sdk';

const HELP = `blindseal verify — verify an attestation.json or a disclosure.json offline

Usage:
  blindseal verify <file>

An attestation is VALID only if the Groth16 proof checks out, every labeled field
(payloadHash, policyRoot, detectorVersion, actionHash, nullifier, expirySlot) matches
what the proof's public-input blob actually commits to, AND the action fields
(action.*, chainId, nonce) hash to the committed actionHash, from which the committed
nullifier derives. An edited amount, recipient, mint, source or program fails here,
not only on chain.
`;

/// The sentinel the prover writes for "no expiry" (--no-expiry).
export const NO_EXPIRY_SLOT = 2000000000;

export const DECODED_LABELS = ['payloadHash', 'policyRoot', 'detectorVersion', 'actionHash', 'nullifier', 'expirySlot'] as const;
export type DecodedLabel = (typeof DECODED_LABELS)[number];
export type DecodedFields = Record<DecodedLabel, string>;

/// verifyOffchain's contract: { ok, reason?, decoded, mismatches, action }. Older sdk builds return only
/// { ok, reason }; the decoded fields are then recovered from the public-input blob directly, and the
/// action binding (0.7.1) is reported as not checked.
type FullVerifyResult = VerifyResult & { decoded?: Partial<DecodedFields>; mismatches?: string[]; action?: ActionBinding };

/// The action-binding lines of the report (0.7.1): what the action fields hash to vs the proof.
export function formatActionBinding(b: ActionBinding | undefined, decoded: DecodedFields): string[] {
  if (!b) return ['  action binding   not checked (this sdk build does not recompute it)'];
  if (!b.checked) return ['  action binding   not checked (the file carries no action fields)'];
  const bad = b.error !== undefined || b.mismatches.length > 0;
  if (!bad) return ['  action binding   ok: action fields + nonce hash to the committed actionHash; the nullifier derives from it'];
  const lines = ['  action binding   MISMATCH'];
  if (b.error !== undefined) lines.push(`    action fields unusable: ${b.error}`);
  if (b.mismatches.includes('actionHash')) lines.push(`    actionHash: recomputed ${b.actionHash} ≠ committed ${decoded.actionHash}`);
  if (b.mismatches.includes('nullifier')) lines.push(`    nullifier: derived ${b.nullifier} ≠ committed ${decoded.nullifier}`);
  return lines;
}

export function formatDecoded(decoded: DecodedFields): string {
  const expiry = decoded.expirySlot;
  const expiryNote = String(expiry) === String(NO_EXPIRY_SLOT) ? ' (no expiry)' : '';
  return [
    `  payloadHash      ${decoded.payloadHash}`,
    `  policyRoot       ${decoded.policyRoot}`,
    `  detectorVersion  ${decoded.detectorVersion}`,
    `  actionHash       ${decoded.actionHash}`,
    `  nullifier        ${decoded.nullifier}`,
    `  expirySlot       ${expiry}${expiryNote}`,
  ].join('\n');
}

function decodedFrom(att: Attestation, r: FullVerifyResult): DecodedFields {
  const fallback = (() => {
    try { return decodePublicInputs(att.publicInputs[0]); } catch { return undefined; }
  })();
  const out = {} as DecodedFields;
  for (const k of DECODED_LABELS) {
    const v = r.decoded?.[k] ?? fallback?.[k];
    out[k] = v === undefined ? '(undecodable)' : String(v);
  }
  return out;
}

export interface AttestationReport { ok: boolean; reason: string | null; decoded: DecodedFields; mismatches: string[]; action: ActionBinding | undefined; text: string }

/// Verify an attestation and render the report `blindseal verify` prints.
export async function verifyAttestationFile(file: string, att: Attestation): Promise<AttestationReport> {
  const r = (await verifyOffchain(att)) as FullVerifyResult;
  const decoded = decodedFrom(att, r);
  const mismatches = r.mismatches ?? [];
  const lines: string[] = [`attestation ${file}: ${r.ok ? 'VALID' : `INVALID — ${r.reason ?? 'unknown reason'}`}`];
  lines.push(formatDecoded(decoded));
  if (mismatches.length > 0) {
    lines.push(`  label mismatch (${mismatches.length}): ${mismatches.join(', ')}`);
    for (const m of mismatches) {
      const labeled = (att as unknown as Record<string, unknown>)[m];
      const dec = (decoded as Record<string, string>)[m];
      if (labeled !== undefined) lines.push(`    ${m}: labeled ${String(labeled)} ≠ decoded ${dec ?? '?'}`);
    }
  }
  lines.push(...formatActionBinding(r.action, decoded));
  return { ok: r.ok, reason: r.reason ?? null, decoded, mismatches, action: r.action, text: lines.join('\n') + '\n' };
}

export async function runVerifyCli(argv: string[]): Promise<number> {
  const file = argv[0];
  if (!file || file === '--help' || file === '-h') { process.stdout.write(HELP); return file ? 0 : 2; }
  const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (Array.isArray(doc.entries) && typeof doc.signature === 'string') {
    const d = doc as unknown as Disclosure;
    const v = verifyDisclosure(d);
    process.stdout.write(`disclosure ${file}: ${v.ok ? 'VALID' : `INVALID — ${v.reason}`}\n`);
    if (v.ok) process.stdout.write(`  window #${d.from}–#${d.to}, ${d.entries.length} entries, signer ${d.signerPubkey.slice(0, 16)}…, clean window: ${isCleanWindow(d) ? 'yes' : 'no'} (clean = every verdict "${CLEAN_VERDICT}")\n`);
    return v.ok ? 0 : 1;
  }
  if (doc.proof && Array.isArray(doc.publicInputs)) {
    const report = await verifyAttestationFile(file, doc as unknown as Attestation);
    process.stdout.write(report.text);
    return report.ok ? 0 : 1;
  }
  process.stderr.write('blindseal verify: not an attestation.json or a disclosure.json\n');
  return 2;
}
