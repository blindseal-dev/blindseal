/// `blindseal verify <file>` — off-chain verification, offline. Accepts either an
/// attestation.json (real Groth16 verify via the wasm verifier, same code as the verify page) or a
/// disclosure.json (ed25519 signature + in-window hash-chain consistency). Exit 0 iff valid.
import { readFileSync } from 'node:fs';
import { verifyDisclosure, isCleanWindow, type Disclosure } from '@blindseal/audit';
import { verifyOffchain, type Attestation } from 'blindseal-sdk';

const HELP = `blindseal verify — verify an attestation.json or a disclosure.json offline

Usage:
  blindseal verify <file>
`;

export async function runVerifyCli(argv: string[]): Promise<number> {
  const file = argv[0];
  if (!file || file === '--help' || file === '-h') { process.stdout.write(HELP); return file ? 0 : 2; }
  const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (Array.isArray(doc.entries) && typeof doc.signature === 'string') {
    const d = doc as unknown as Disclosure;
    const v = verifyDisclosure(d);
    process.stdout.write(`disclosure ${file}: ${v.ok ? 'VALID' : `INVALID — ${v.reason}`}\n`);
    if (v.ok) process.stdout.write(`  window #${d.from}–#${d.to}, ${d.entries.length} entries, signer ${d.signerPubkey.slice(0, 16)}…, clean window: ${isCleanWindow(d) ? 'yes' : 'no'}\n`);
    return v.ok ? 0 : 1;
  }
  if (doc.proof && Array.isArray(doc.publicInputs)) {
    const r = await verifyOffchain(doc as unknown as Attestation);
    process.stdout.write(`attestation ${file}: ${r.ok ? 'VALID' : `INVALID — ${r.reason}`}\n`);
    return r.ok ? 0 : 1;
  }
  process.stderr.write('blindseal verify: not an attestation.json or a disclosure.json\n');
  return 2;
}
