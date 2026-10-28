// Audit finding #8 (0.7.0): `blindseal attest` hands the screened tool call to the prover through
// a private temp dir (0700 dir, 0600 file) that is removed after success, after a thrown error,
// after a failed proof, and when the process is interrupted by SIGTERM mid-proof.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROXY_ENTRY = path.resolve(here, '../src/index.ts');
const FIX = path.resolve(here, '../../../tests/fixtures');
const TOOLCALL = path.join(FIX, 'mainnet-toolcall.json');
const REAL_ATTESTATION = path.join(FIX, 'attestation-mainnet.json');
const TARGET = (JSON.parse(readFileSync(REAL_ATTESTATION, 'utf8')) as { action: { targetProgram: string } }).action.targetProgram;

let root: string;   // per-test sandbox
let tmp: string;    // TMPDIR for the attest process: os.tmpdir() inside it resolves here
let marker: string; // the stub prover writes what it observed here

/// A prover stand-in that records the payload file's and dir's modes and its own pid, then
/// behaves per `mode`: ok (copy the real attestation), fail (exit 3), hang (sleep).
function stubProver(mode: 'ok' | 'fail' | 'hang'): string {
  const p = path.join(root, `prover-${mode}.mjs`);
  writeFileSync(p, `#!/usr/bin/env node
import { statSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
const a = process.argv.slice(2);
const payload = a[a.indexOf('--payload') + 1];
writeFileSync(${JSON.stringify(path.join('MARKER'))}.replace('MARKER', process.env.STUB_MARKER), JSON.stringify({
  pid: process.pid, payload, dir: path.dirname(payload),
  fileMode: statSync(payload).mode & 0o777, dirMode: statSync(path.dirname(payload)).mode & 0o777,
  content: readFileSync(payload, 'utf8'),
}));
if (${JSON.stringify(mode)} === 'ok') copyFileSync(${JSON.stringify(REAL_ATTESTATION)}, a[a.indexOf('--out') + 1]);
if (${JSON.stringify(mode)} === 'fail') process.exit(3);
if (${JSON.stringify(mode)} === 'hang') setTimeout(() => {}, 60_000);
`);
  chmodSync(p, 0o755);
  return p;
}

function attest(prover: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', PROXY_ENTRY, 'attest', TOOLCALL,
    '--out', path.join(root, 'attestation.json'), '--target-program', TARGET, '--no-expiry',
    '--prover', prover, '--audit-dir', path.join(root, 'audit')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TMPDIR: tmp, HOME: root, STUB_MARKER: marker, BLINDSEAL_RPC_URL: 'off' },
  });
  let err = '';
  child.stderr.on('data', (d) => (err += String(d)));
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; err: string }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal, err })));
  return { child, done };
}

// tsx keeps its compile cache in TMPDIR too; only blindseal's own entries count.
const leftovers = () => readdirSync(tmp).filter((n) => n.startsWith('blindseal'));
const observed = () => JSON.parse(readFileSync(marker, 'utf8')) as { pid: number; payload: string; dir: string; fileMode: number; dirMode: number; content: string };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'bs-attest-tmp-'));
  tmp = path.join(root, 'tmp');
  marker = path.join(root, 'marker.json');
  mkdirSync(tmp);
});
afterEach(() => {
  try { const o = observed(); if (alive(o.pid)) process.kill(o.pid, 'SIGKILL'); } catch { /* no marker */ }
  rmSync(root, { recursive: true, force: true });
});

describe('attest temp-file handling (audit #8)', () => {
  it('the payload sits in a private dir (0700) as a 0600 file, removed after success', async () => {
    const r = await attest(stubProver('ok')).done;
    expect(r.code, r.err).toBe(0);
    const o = observed();
    expect(o.dirMode).toBe(0o700);
    expect(o.fileMode).toBe(0o600);
    expect(path.dirname(o.dir)).toBe(tmp);           // mkdtemp under os.tmpdir()
    expect(o.content).toContain('transfer_sol');     // it really was the screened payload
    expect(existsSync(o.payload)).toBe(false);
    expect(leftovers()).toEqual([]);
  }, 60_000);

  it('cleans up when the prover fails', async () => {
    const r = await attest(stubProver('fail')).done;
    expect(r.code).toBe(1);
    expect(existsSync(observed().dir)).toBe(false);
    expect(leftovers()).toEqual([]);
  }, 60_000);

  it('cleans up after a thrown error (prover cannot be executed)', async () => {
    const p = stubProver('ok');
    chmodSync(p, 0o644); // exists (passes resolveProver) but spawn throws EACCES
    const r = await attest(p).done;
    expect(r.code).not.toBe(0);
    expect(leftovers()).toEqual([]);
  }, 60_000);

  it('SIGTERM mid-proof: kills the prover, removes the dir, then dies by SIGTERM', async () => {
    const { child, done } = attest(stubProver('hang'));
    const t0 = Date.now();
    while (!existsSync(marker)) {
      if (Date.now() - t0 > 40_000) throw new Error('prover never started');
      await new Promise((r) => setTimeout(r, 100));
    }
    const o = observed();
    expect(existsSync(o.payload)).toBe(true);
    child.kill('SIGTERM');
    const r = await done;
    expect(r.signal).toBe('SIGTERM');
    expect(existsSync(o.dir)).toBe(false);
    expect(leftovers()).toEqual([]);
    await new Promise((res) => setTimeout(res, 300));
    expect(alive(o.pid)).toBe(false);
  }, 60_000);
});
