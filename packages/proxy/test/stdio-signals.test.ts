/// The stdio proxy exits on SIGTERM / SIGINT (0.7.0 gap). Before 0.7.0 the handler forwarded the
/// signal to the server, the server exited, and the proxy re-raised the signal on itself — into
/// its own still-installed handler, which swallowed it: the proxy never exited.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnProxy } from './helpers/proxy-harness.js';

function server(dir: string, ignoreTerm: boolean): string {
  const f = path.join(dir, ignoreTerm ? 'stubborn.mjs' : 'server.mjs');
  writeFileSync(f, `
    import { createInterface } from 'node:readline';
    ${ignoreTerm ? "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {});" : ''}
    createInterface({ input: process.stdin }).on('line', (line) => {
      const m = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 's', version: '0' } } }) + '\\n');
    });
  `);
  return f;
}

async function runSignal(sig: NodeJS.Signals, ignoreTerm = false): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bs-sig-'));
  const h = spawnProxy({ fixture: server(dir, ignoreTerm), env: { BLINDSEAL_AUDIT_DIR: path.join(dir, 'audit') } });
  try {
    // Ready = an initialize round-trip through the proxy (the server is spawned and wired up).
    h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await h.next(90000);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
      h.child.once('exit', (code, signal) => r({ code, signal })),
    );
    h.child.kill(sig);
    return await Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), 12000))]);
  } finally {
    h.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('stdio proxy signal handling', () => {
  it('SIGTERM: the proxy exits (by SIGTERM) once the server has exited', async () => {
    const r = await runSignal('SIGTERM');
    expect(r, 'proxy still running 12s after SIGTERM').not.toBeNull();
    expect(r!.signal).toBe('SIGTERM');
  }, 120000);

  it('SIGINT: the proxy exits (by SIGINT)', async () => {
    const r = await runSignal('SIGINT');
    expect(r, 'proxy still running 12s after SIGINT').not.toBeNull();
    expect(r!.signal).toBe('SIGINT');
  }, 120000);

  it('a server that ignores SIGTERM is killed after the grace period and the proxy exits', async () => {
    const r = await runSignal('SIGTERM', true);
    expect(r, 'proxy still running 12s after SIGTERM').not.toBeNull();
    expect(r!.signal).toBe('SIGTERM');
  }, 120000);
});
