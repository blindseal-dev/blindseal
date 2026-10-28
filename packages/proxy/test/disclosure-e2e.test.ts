// Audit finding #10 (0.7.0), end to end: a REAL `blindseal attest` run (mock-prover mode: the
// prover stand-in copies the committed mainnet Groth16 attestation for the same tool call, so
// the proof and payloadHash are real) → the real hash chain and a real ed25519-signed
// disclosure from `blindseal audit disclose` → `blindseal verify` (CLI) and the browser
// verifier's disclosure logic (apps/site/app/verify, WebCrypto under Node). Both must call the
// window clean, because attest records the canonical CLEAN_VERDICT.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAttestCli } from '../src/cli/attest.js';
import { runAuditCli } from '../src/cli/audit.js';
import { runVerifyCli } from '../src/cli/verify.js';
import * as site from '../../../apps/site/app/verify/disclosure.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(here, '../../../tests/fixtures');
const TOOLCALL = path.join(FIX, 'mainnet-toolcall.json');
const REAL_ATTESTATION = path.join(FIX, 'attestation-mainnet.json');

let dir: string;
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const orig = process.stdout.write.bind(process.stdout);
  let out = '';
  (process.stdout as unknown as { write: unknown }).write = (s: string | Uint8Array) => { out += String(s); return true; };
  try { return { code: await fn(), out }; } finally { (process.stdout as unknown as { write: unknown }).write = orig; }
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bs-e2e-'));
  const prover = path.join(dir, 'mock-prover.mjs');
  writeFileSync(prover, `#!/usr/bin/env node
import { copyFileSync } from 'node:fs';
const a = process.argv.slice(2);
copyFileSync(${JSON.stringify(REAL_ATTESTATION)}, a[a.indexOf('--out') + 1]);
`);
  chmodSync(prover, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('attest → disclose → verify (CLI + browser) agree on the clean verdict (audit #10)', () => {
  it('a real attest decision discloses as a clean window in both verifiers', async () => {
    const auditDir = path.join(dir, 'home');
    const att = path.join(dir, 'attestation.json');
    const real = JSON.parse(readFileSync(REAL_ATTESTATION, 'utf8')) as { payloadHash: string; expirySlot: number; action: { targetProgram: string } };

    const a = await capture(() => runAttestCli([
      TOOLCALL, '--out', att, '--target-program', real.action.targetProgram,
      '--expiry', String(real.expirySlot), '--prover', path.join(dir, 'mock-prover.mjs'), '--audit-dir', auditDir,
    ]));
    expect(a.code).toBe(0);

    const discFile = path.join(dir, 'disclosure.json');
    expect((await capture(() => runAuditCli(['disclose', '--from', '0', '--to', '0', '--dir', auditDir, '--out', discFile]))).code).toBe(0);
    const disclosure = JSON.parse(readFileSync(discFile, 'utf8')) as site.Disclosure;

    // The disclosed decision is the one the attestation proves.
    expect(disclosure.entries).toHaveLength(1);
    expect(disclosure.entries[0]!.payloadHash).toBe(real.payloadHash);

    // CLI verify: the attestation (real Groth16) and the disclosure.
    const va = await capture(() => runVerifyCli([att]));
    expect(va.code).toBe(0);
    expect(va.out).toMatch(/: VALID\n/);
    const vd = await capture(() => runVerifyCli([discFile]));
    expect(vd.code).toBe(0);
    expect(vd.out).toMatch(/: VALID\n/);
    expect(vd.out).toMatch(/clean window: yes/);

    // Browser verifier logic (the code the /verify page runs).
    expect(await site.verifyDisclosure(disclosure)).toEqual({ ok: true });
    expect(site.isCleanWindow(disclosure)).toBe(true);
  }, 60_000);
});
