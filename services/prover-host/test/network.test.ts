import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NetworkBackend } from '../src/backends/network.js';
import { proverArgs, shq } from '../src/backends/prover-args.js';
import type { ProofJob } from '../src/backends/types.js';

function job(tmp: string): ProofJob {
  return { id: 'n1', payloadPath: path.join(tmp, 'p.json'), out: path.join(tmp, 'out.json'), action: { chainId: 1, targetProgram: 'T', sourceAuthority: 'S', instruction: '0x0102030405060708', recipient: 'R', mint: '', amount: '5' }, expirySlot: 123 };
}

describe('NetworkBackend', () => {
  it('refuses without the acknowledgement and without the network key, before spawning anything', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'blindseal-net-'));
    let spawned = 0;
    const spawnImpl = (() => { spawned++; return new EventEmitter(); }) as unknown as typeof import('node:child_process').spawn;
    await expect(new NetworkBackend({ proverBinary: '/p', acknowledged: false }, { spawnImpl, env: { NETWORK_PRIVATE_KEY: 'k' } }).prove(job(tmp), new AbortController().signal)).rejects.toThrow(/not acknowledged/);
    await expect(new NetworkBackend({ proverBinary: '/p', acknowledged: true }, { spawnImpl, env: {} }).prove(job(tmp), new AbortController().signal)).rejects.toThrow(/NETWORK_PRIVATE_KEY is not set/);
    expect(spawned).toBe(0);
  });

  it('runs the prover in --mode network with BLINDSEAL_NETWORK_ACKNOWLEDGED=1 and returns the attestation it wrote', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'blindseal-net-'));
    const j = job(tmp);
    let seen: { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | undefined;
    const spawnImpl = ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      seen = { cmd, args, env: opts.env };
      const child = new EventEmitter();
      setTimeout(() => { writeFileSync(j.out, JSON.stringify({ version: 1, proveMs: 7, prover: { mode: 'network', host: 'network', version: '0.0.0' } })); child.emit('close', 0); }, 0);
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    const log: string[] = [];
    const att = await new NetworkBackend({ proverBinary: '/p', acknowledged: true, log: (l) => log.push(l) }, { spawnImpl, env: { NETWORK_PRIVATE_KEY: 'k', HOME: '/h' } }).prove(j, new AbortController().signal);
    expect(att.prover?.mode).toBe('network');
    expect(seen!.cmd).toBe('/p');
    expect(seen!.args.slice(0, 2)).toEqual(['--mode', 'network']);
    expect(seen!.args).toEqual(['--mode', 'network', ...proverArgs(j, j.payloadPath, j.out)]);
    expect(seen!.env.BLINDSEAL_NETWORK_ACKNOWLEDGED).toBe('1');
    expect(seen!.env.NETWORK_PRIVATE_KEY).toBe('k');
    expect(log[0]).toMatch(/leave this machine for the Succinct prover network/);
    expect(log.join('\n')).not.toContain('k\n');
  });
});

describe('proverArgs / shq', () => {
  it('mirrors the prover command line; nonce and decision id only when present', () => {
    const j = job('/t');
    expect(proverArgs(j, '/r/p.json', '/r/o.json')).toEqual(['--payload', '/r/p.json', '--out', '/r/o.json', '--chain-id', '1', '--target-program', 'T', '--source-authority', 'S', '--recipient', 'R', '--mint', '', '--amount', '5', '--instruction', '0x0102030405060708', '--expiry', '123']);
    expect(proverArgs({ ...j, nonce: '0xab', decisionId: 'd' }, 'p', 'o').slice(-4)).toEqual(['--nonce', '0xab', '--decision-id', 'd']);
    expect(shq("it's")).toBe(`'it'\\''s'`);
    expect(shq('')).toBe(`''`);
  });
});
