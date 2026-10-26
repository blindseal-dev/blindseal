import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVER_MANIFEST, ProverUnavailableError, proverUnavailableMessage, resolveProver, type ProverManifest } from '../src/prover/resolve.js';

const BIN = Buffer.from('#!/bin/sh\necho fake prover\n');
const SHA = createHash('sha256').update(BIN).digest('hex');

function manifest(sha: string = SHA): ProverManifest {
  return {
    version: '9.9.9',
    release: 'https://example.invalid/releases/download/prover-v9.9.9',
    assets: { 'darwin-arm64': { name: 'blindseal-prover-darwin-arm64', sha256: sha }, 'linux-x64': { name: 'blindseal-prover-linux-x64', sha256: sha } },
  };
}

function fakeFetch(body: Buffer, status = 200): typeof fetch {
  const calls: string[] = [];
  const f = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(status === 200 ? body : 'nope', { status });
  }) as unknown as typeof fetch;
  (f as unknown as { calls: string[] }).calls = calls;
  return f;
}

let tmp: string;
let home: string;
beforeEach(() => { tmp = mkdtempSync(path.join(os.tmpdir(), 'blindseal-prover-')); home = path.join(tmp, 'home'); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('prover resolution', () => {
  it('ships a manifest with the release shape (sha256 values may still be TBD)', () => {
    expect(PROVER_MANIFEST.version).toBe('0.5.1');
    expect(PROVER_MANIFEST.release).toBe('https://github.com/blindseal-dev/blindseal/releases/download/prover-v0.5.1');
    expect(Object.keys(PROVER_MANIFEST.assets).sort()).toEqual(['darwin-arm64', 'linux-x64']);
    expect(PROVER_MANIFEST.assets['darwin-arm64']!.name).toBe('blindseal-prover-darwin-arm64');
  });

  it('--prover wins over $BLINDSEAL_PROVER and the installed binary', async () => {
    const explicit = path.join(tmp, 'explicit'); writeFileSync(explicit, BIN);
    const fromEnv = path.join(tmp, 'env'); writeFileSync(fromEnv, BIN);
    mkdirSync(path.join(home, 'bin'), { recursive: true });
    writeFileSync(path.join(home, 'bin', 'blindseal-prover-9.9.9'), BIN);
    const fetchImpl = fakeFetch(BIN);
    expect(await resolveProver({ explicit, env: { BLINDSEAL_PROVER: fromEnv }, home, manifest: manifest(), platform: 'darwin-arm64', cwd: tmp, fetchImpl })).toBe(explicit);
    expect(await resolveProver({ env: { BLINDSEAL_PROVER: fromEnv }, home, manifest: manifest(), platform: 'darwin-arm64', cwd: tmp, fetchImpl })).toBe(fromEnv);
    expect(await resolveProver({ env: {}, home, manifest: manifest(), platform: 'darwin-arm64', cwd: tmp, fetchImpl })).toBe(path.join(home, 'bin', 'blindseal-prover-9.9.9'));
    expect((fetchImpl as unknown as { calls: string[] }).calls).toHaveLength(0);
  });

  it('--prover pointing at a missing file is a plain error', async () => {
    await expect(resolveProver({ explicit: path.join(tmp, 'nope'), env: {}, home, manifest: manifest(), platform: 'linux-x64', cwd: tmp })).rejects.toThrow(/no such file/);
  });

  it('downloads on first use, verifies sha256, installs 0755 under ~/.blindseal/bin and logs one line', async () => {
    const fetchImpl = fakeFetch(BIN);
    const log: string[] = [];
    const p = await resolveProver({ env: {}, home, manifest: manifest(), platform: 'linux-x64', cwd: tmp, fetchImpl, log: (l) => log.push(l) });
    expect(p).toBe(path.join(home, 'bin', 'blindseal-prover-9.9.9'));
    expect(readFileSync(p)).toEqual(BIN);
    expect(statSync(p).mode & 0o777).toBe(0o755);
    expect((fetchImpl as unknown as { calls: string[] }).calls).toEqual(['https://example.invalid/releases/download/prover-v9.9.9/blindseal-prover-linux-x64']);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/downloaded prover 9\.9\.9 for linux-x64/);
    expect(readdirSync(path.join(home, 'bin')).filter((f) => f.endsWith('.part'))).toHaveLength(0);
  });

  it('refuses a sha256 mismatch and installs nothing', async () => {
    const fetchImpl = fakeFetch(Buffer.from('tampered'));
    await expect(resolveProver({ env: {}, home, manifest: manifest(), platform: 'linux-x64', cwd: tmp, fetchImpl })).rejects.toBeInstanceOf(ProverUnavailableError);
    expect(existsSync(path.join(home, 'bin', 'blindseal-prover-9.9.9'))).toBe(false);
  });

  it('treats a "TBD" sha as unavailable without downloading', async () => {
    const fetchImpl = fakeFetch(BIN);
    await expect(resolveProver({ env: {}, home, manifest: manifest('TBD'), platform: 'darwin-arm64', cwd: tmp, fetchImpl })).rejects.toThrow(proverUnavailableMessage('darwin-arm64'));
    expect((fetchImpl as unknown as { calls: string[] }).calls).toHaveLength(0);
  });

  it('unsupported platform / failed download → exactly the actionable message', async () => {
    const msg = proverUnavailableMessage('win32-x64');
    expect(msg).toBe(
      'blindseal attest: no prover binary for win32-x64. Build it: git clone https://github.com/blindseal-dev/blindseal && cd blindseal && cargo build --release -p blindseal-prover, then pass --prover <path> or set BLINDSEAL_PROVER.',
    );
    await expect(resolveProver({ env: {}, home, manifest: manifest(), platform: 'win32-x64', cwd: tmp, fetchImpl: fakeFetch(BIN) })).rejects.toThrow(msg);
    await expect(resolveProver({ env: {}, home, manifest: manifest(), platform: 'linux-x64', cwd: tmp, fetchImpl: fakeFetch(BIN, 404) })).rejects.toThrow(proverUnavailableMessage('linux-x64'));
  });
});
