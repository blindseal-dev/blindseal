import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY_ENTRY = path.resolve(__dirname, '../src/index.ts');

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', PROXY_ENTRY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
}

describe('cli dispatch', () => {
  it('unknown command → "unknown command" + help banner, exit 2 (never spawned as a server)', () => {
    const r = run(['foo']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('blindseal: unknown command "foo"');
    expect(r.stderr).toMatch(/Usage/);
    expect(r.stderr).not.toMatch(/failed to spawn/);
  });

  it('unknown flag → exit 2 with help', () => {
    const r = run(['--bogus']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown flag "--bogus"');
  });

  it('wrapping without "--" is refused', () => {
    const r = run(['--port', '1234']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/requires "--"/);
  });

  it('"--" with no command is refused', () => {
    const r = run(['--']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no command after "--"/);
  });

  it('--help lists the product commands with the published names', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    for (const s of ['blindseal init', 'blindseal run --mock', 'blindseal -- <command>', 'blindseal attest', 'blindseal verify', 'blindseal dashboard', 'blindseal init --wrap']) {
      expect(r.stdout).toContain(s);
    }
    expect(r.stdout).not.toMatch(/@blindseal\/proxy|npx @blindseal|FRONTEND|TELEMETRY|\bM0\b/);
  });

  it('--version prints the package version', () => {
    const r = run(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^blindseal \d+\.\d+\.\d+/);
  });

  it('init --wrap --dry-run previews a config without writing it', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'blindseal-wrap-'));
    try {
      const cfg = path.join(dir, 'claude_desktop_config.json');
      const original = JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] } } }, null, 2);
      writeFileSync(cfg, original);
      const r = run(['init', '--wrap', '--dry-run', '--config', cfg], { NO_COLOR: '1' });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Plan:/);
      expect(r.stdout).toMatch(/wrap-stdio/);
      expect(r.stdout).toMatch(/--dry-run: not writing/);
      expect(require('node:fs').readFileSync(cfg, 'utf8')).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
