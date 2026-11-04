import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVER_MANIFEST, ProverUnavailableError, assetAvailable, proverUnavailableMessage, resolveProver, resolveProverBinary, selectProverAsset, type ProverManifest } from '../src/prover/resolve.js';

const BIN = Buffer.from('#!/bin/sh\necho fake prover\n');
const SHA = createHash('sha256').update(BIN).digest('hex');

function manifest(sha: string = SHA, cudaSha: string = 'TBD'): ProverManifest {
  return {
    version: '9.9.9',
    release: 'https://example.invalid/releases/download/prover-v9.9.9',
    assets: {
      'darwin-arm64': { name: 'blindseal-prover-darwin-arm64', sha256: sha },
      'linux-x64': { name: 'blindseal-prover-linux-x64', sha256: sha },
      'linux-x64-cuda': { name: 'blindseal-prover-linux-x64-cuda', sha256: cudaSha },
    },
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
    expect(PROVER_MANIFEST.version).toBe('0.7.0');
    expect(PROVER_MANIFEST.release).toBe('https://github.com/blindseal-dev/blindseal/releases/download/prover-v0.7.0');
    expect(Object.keys(PROVER_MANIFEST.assets).sort()).toEqual(['darwin-arm64', 'linux-x64', 'linux-x64-cuda']);
    expect(PROVER_MANIFEST.assets['darwin-arm64']!.name).toBe('blindseal-prover-darwin-arm64');
    expect(PROVER_MANIFEST.assets['linux-x64-cuda']!.name).toBe('blindseal-prover-linux-x64-cuda');
    expect(PROVER_MANIFEST.guestElf?.sha256).toMatch(/^[0-9a-f]{64}$/);
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
      'blindseal attest: no prover binary for win32-x64. Build it: git clone https://github.com/blindseal-dev/blindseal && cd blindseal && cargo build --release --manifest-path crates/prover/Cargo.toml, then pass --prover crates/prover/target/release/blindseal-prover or set BLINDSEAL_PROVER.',
    );
    await expect(resolveProver({ env: {}, home, manifest: manifest(), platform: 'win32-x64', cwd: tmp, fetchImpl: fakeFetch(BIN) })).rejects.toThrow(msg);
    await expect(resolveProver({ env: {}, home, manifest: manifest(), platform: 'linux-x64', cwd: tmp, fetchImpl: fakeFetch(BIN, 404) })).rejects.toThrow(proverUnavailableMessage('linux-x64'));
  });

  describe('cuda variant selection (mocked GPU probe)', () => {
    const gpu = () => true;
    const noGpu = () => false;

    it('linux-x64 + GPU + released cuda asset → the cuda asset, mode cuda', () => {
      expect(selectProverAsset('linux-x64', manifest(SHA, SHA), gpu)).toEqual({ key: 'linux-x64-cuda', mode: 'cuda' });
    });

    it('no GPU → the CPU asset, and the probe decides nothing else', () => {
      expect(selectProverAsset('linux-x64', manifest(SHA, SHA), noGpu)).toEqual({ key: 'linux-x64', mode: 'cpu' });
    });

    it('a TBD cuda sha is "not released": the CPU asset with one explanatory line', () => {
      const log: string[] = [];
      expect(selectProverAsset('linux-x64', manifest(SHA, 'TBD'), gpu, (l) => log.push(l))).toEqual({ key: 'linux-x64', mode: 'cpu' });
      expect(log).toHaveLength(1);
      expect(log[0]).toMatch(/cuda prover 9\.9\.9 is not released yet .*TBD.*; using the CPU prover/);
      expect(assetAvailable({ name: 'x', sha256: 'TBD' })).toBe(false);
      expect(assetAvailable({ name: 'x', sha256: SHA })).toBe(true);
    });

    it('darwin-arm64 never picks cuda, even with a probe that says yes', () => {
      let probed = 0;
      expect(selectProverAsset('darwin-arm64', manifest(SHA, SHA), () => { probed++; return true; })).toEqual({ key: 'darwin-arm64', mode: 'cpu' });
      expect(probed).toBe(0);
    });

    it('downloads the cuda asset to its own installed name and reports mode cuda', async () => {
      const fetchImpl = fakeFetch(BIN);
      const r = await resolveProverBinary({ env: {}, home, manifest: manifest(SHA, SHA), platform: 'linux-x64', cwd: tmp, fetchImpl, gpuProbe: gpu, log: () => {} });
      expect(r).toEqual({ path: path.join(home, 'bin', 'blindseal-prover-9.9.9-cuda'), mode: 'cuda' });
      expect((fetchImpl as unknown as { calls: string[] }).calls).toEqual(['https://example.invalid/releases/download/prover-v9.9.9/blindseal-prover-linux-x64-cuda']);
      // second call: installed, no download
      const again = await resolveProverBinary({ env: {}, home, manifest: manifest(SHA, SHA), platform: 'linux-x64', cwd: tmp, fetchImpl: fakeFetch(BIN, 500), gpuProbe: gpu });
      expect(again.path).toBe(r.path);
    });

    it('an explicit binary (--prover / $BLINDSEAL_PROVER) is mode cpu whatever the GPU says', async () => {
      const explicit = path.join(tmp, 'explicit'); writeFileSync(explicit, BIN);
      expect(await resolveProverBinary({ explicit, env: {}, home, manifest: manifest(SHA, SHA), platform: 'linux-x64', cwd: tmp, gpuProbe: gpu })).toEqual({ path: explicit, mode: 'cpu' });
      expect(await resolveProverBinary({ env: { BLINDSEAL_PROVER: explicit }, home, manifest: manifest(SHA, SHA), platform: 'linux-x64', cwd: tmp, gpuProbe: gpu })).toEqual({ path: explicit, mode: 'cpu' });
    });

    it('resolveProver (path only) keeps working and never probes without a cuda asset', async () => {
      const m = manifest(); delete m.assets['linux-x64-cuda'];
      let probed = 0;
      const p = await resolveProver({ env: {}, home, manifest: m, platform: 'linux-x64', cwd: tmp, fetchImpl: fakeFetch(BIN), gpuProbe: () => { probed++; return true; }, log: () => {} });
      expect(p).toBe(path.join(home, 'bin', 'blindseal-prover-9.9.9'));
      expect(probed).toBe(0);
    });
  });
});
