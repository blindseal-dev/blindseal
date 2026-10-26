import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldHome } from '../src/cli/init.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY_ENTRY = path.resolve(__dirname, '../src/index.ts');

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(path.join(os.tmpdir(), 'blindseal-init-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('blindseal init — scaffold', () => {
  it('creates ~/.blindseal (0700) with identity key, policy and dashboard token', () => {
    const home = path.join(tmp, '.blindseal');
    const r = scaffoldHome(home);
    expect(existsSync(home)).toBe(true);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(home, 'identity.key')).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(home, 'identity.key'), 'utf8')).toMatch(/^302e020100300506032b657004220420[0-9a-f]{64}\n$/);
    expect(r.pubkeyHex).toMatch(/^302a300506032b6570032100[0-9a-f]{64}$/);
    const policy = JSON.parse(readFileSync(path.join(home, 'policy.json'), 'utf8'));
    expect(policy.rules).toHaveLength(22);
    expect(policy.root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(readFileSync(path.join(home, 'dashboard.token'), 'utf8').trim().length).toBeGreaterThan(20);
    expect(r.created).toHaveLength(4);
    expect(r.kept).toHaveLength(0);
  });

  it('is idempotent: a second run keeps every file byte-for-byte', () => {
    const home = path.join(tmp, '.blindseal');
    scaffoldHome(home);
    const before = ['identity.key', 'policy.json', 'dashboard.token'].map((f) => readFileSync(path.join(home, f), 'utf8'));
    const r = scaffoldHome(home);
    const after = ['identity.key', 'policy.json', 'dashboard.token'].map((f) => readFileSync(path.join(home, f), 'utf8'));
    expect(after).toEqual(before);
    expect(r.created).toHaveLength(0);
    expect(r.kept).toHaveLength(4);
  });

  it('`blindseal init` with HOME=<tmp> scaffolds there and prints the next commands', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', PROXY_ENTRY, 'init'], {
      encoding: 'utf8', env: { ...process.env, HOME: tmp }, timeout: 60_000,
    });
    expect(r.status).toBe(0);
    const home = path.join(tmp, '.blindseal');
    expect(existsSync(path.join(home, 'identity.key'))).toBe(true);
    expect(existsSync(path.join(home, 'policy.json'))).toBe(true);
    expect(existsSync(path.join(home, 'dashboard.token'))).toBe(true);
    expect(r.stdout).toContain('created');
    expect(r.stdout).toContain('blindseal run --mock');
    expect(r.stdout).toContain('blindseal -- <server command>');
    expect(r.stdout).not.toMatch(/init\b.*\bexit/);
  });

  it('`blindseal init --bogus` exits 2', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', PROXY_ENTRY, 'init', '--bogus'], {
      encoding: 'utf8', env: { ...process.env, HOME: tmp }, timeout: 60_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown argument');
  });
});
