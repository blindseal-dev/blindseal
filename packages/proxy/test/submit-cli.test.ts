import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { runSubmitCli } from '../src/cli/submit.js';

// `blindseal submit` performs the gated transfer: only transfer-gate attestations can be sent from
// the CLI, because the verifier accepts verify_and_consume only as a CPI from the target program.
const FIXTURE = new URL('../../../tests/fixtures/attestation-test.json', import.meta.url);

const capture = () => {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => { out += String(s); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((s: any) => { err += String(s); return true; });
  return { out: () => out, err: () => err };
};
afterEach(() => vi.restoreAllMocks());

describe('blindseal submit', () => {
  it('help says it performs the gated transfer with the source-authority wallet', async () => {
    const io = capture();
    expect(await runSubmitCli(['--help'])).toBe(0);
    expect(io.out()).toMatch(/gated transfer/);
    expect(io.out()).toMatch(/--wallet <source-authority keypair\.json>/);
    expect(io.out()).toMatch(/only accepts a CPI from the\s+attestation's target program/);
  });

  it('refuses an attestation for another target program before touching the network or the wallet', async () => {
    const att = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    att.action.targetProgram = Keypair.generate().publicKey.toBase58();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bs-submit-'));
    const file = path.join(dir, 'att.json');
    writeFileSync(file, JSON.stringify(att));
    const io = capture();
    // an unroutable RPC and a wallet path that does not exist: neither may be used
    const code = await runSubmitCli([file, '--rpc', 'http://127.0.0.1:9', '--wallet', path.join(dir, 'missing.json'), '--skip-offchain']);
    expect(code).toBe(1);
    expect(io.err()).toMatch(/submit through the target program; the verifier only accepts CPI from it/);
  });
});
