// Audit finding #5 (0.7.0): every proxy decision goes into the content-free hash chain, and
// content is retained only in the encrypted store. Before 0.7.0 the proxy never appended to the
// chain (only `blindseal attest` did), scan-http recorded nothing, a screening error recorded
// nothing, and BLINDSEAL_AUDIT_LOG wrote argsPreview / contentPreview in plaintext.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAudit, CHAIN_VERDICTS } from '@blindseal/audit';

// The detection outcome is scripted per tool name so every decision path is reachable.
vi.mock('../src/detection/pipeline.js', () => ({
  runPipeline: vi.fn(async (_text: string, ctx?: { toolName?: string }) => {
    const base = { confidence: 0.9, reasoning: 'scripted', detectedPatterns: [] as string[], layer: 2 };
    switch (ctx?.toolName) {
      case 'sus_tool': return { ...base, verdict: 'suspicious', l3Status: 'unavailable', reasoning: 'L3 unavailable; suspicious retained' };
      case 'bad_tool': return { ...base, verdict: 'malicious', layer: 1, l3Status: 'skipped_gate' };
      case 'boom_tool': throw new Error('pipeline exploded');
      default: return { ...base, verdict: 'clean', l3Status: 'skipped_gate' };
    }
  }),
  warmupLayer2: vi.fn(async () => undefined),
}));

import { startHttpProxy } from '../src/transports/http.js';
import { startScanHttp } from '../src/transports/scan-http.js';

const CANARY = 'cAnArY-7f3e9'; // short and plain: no value pattern would catch it
const RESPONSE_CANARY = 'Rz9';  // a secret the upstream returns under a "token" key
const RECIPIENT = CANARY; // the trade guard's reason string names the recipient

let root: string;
let auditDir: string;
const servers: Server[] = [];
const savedEnv = { ...process.env };

function setEnv(extra: Record<string, string>): void {
  for (const k of Object.keys(process.env)) if (k.startsWith('BLINDSEAL_')) delete process.env[k];
  Object.assign(process.env, {
    BLINDSEAL_AUDIT_DIR: auditDir,
    BLINDSEAL_AUDIT_LOG: path.join(root, 'metadata.jsonl'),
    BLINDSEAL_PERSIST: '1',
    BLINDSEAL_PERSIST_PATH: path.join(root, 'scans.db'),
    BLINDSEAL_MANIFEST_CHECK: 'off',
    BLINDSEAL_MODE: 'block',
    BLINDSEAL_TRADE_GUARD: '1',
    BLINDSEAL_TRADE_ALLOWLIST: 'allowlisted-only',
    ...extra,
  });
}

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => {
    if (server.listening) return resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    server.once('listening', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

async function upstream(): Promise<string> {
  const s = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += String(c);
    const msg = JSON.parse(body);
    const text = JSON.stringify({ weather: 'sunny', token: RESPONSE_CANARY });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } }));
  });
  s.listen(0, '127.0.0.1');
  return (await listen(s)) + '/mcp';
}

async function call(url: string, name: string, args: unknown, id: number): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
  return r.json();
}

const chain = () => openAudit(auditDir).chain;
const content = <T,>(id: string) => openAudit(auditDir).content.get<T>(id);

/// Run `fn`, return the chain entries it appended.
async function appended(fn: () => Promise<unknown>) {
  const before = chain().length;
  await fn();
  await new Promise((r) => setTimeout(r, 50));
  return chain().all().slice(before);
}

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

/// Everything the in-process proxies write to stderr (MCP clients persist a server's stderr).
let stderrText = '';
const realStderrWrite = process.stderr.write.bind(process.stderr);

let proxyWarn: string;  // trade guard: unknown payee → warn
let proxyBlock: string; // trade guard: unknown payee → block
let scan: string;

beforeAll(async () => {
  (process.stderr as unknown as { write: unknown }).write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderrText += String(chunk);
    return (realStderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  };
  root = mkdtempSync(path.join(os.tmpdir(), 'bs-chain-cov-'));
  auditDir = path.join(root, 'audit');
  const up = await upstream();
  setEnv({ BLINDSEAL_TRADE_ALLOWLIST_MODE: 'warn' });
  proxyWarn = (await listen(startHttpProxy({ upstream: up, listenPort: 0, listenHost: '127.0.0.1' }))) + '/mcp';
  setEnv({ BLINDSEAL_TRADE_ALLOWLIST_MODE: 'block' });
  proxyBlock = (await listen(startHttpProxy({ upstream: up, listenPort: 0, listenHost: '127.0.0.1' }))) + '/mcp';
  setEnv({});
  scan = (await listen(startScanHttp({ listenPort: 0, listenHost: '127.0.0.1' }))) + '/scan';
});

afterAll(async () => {
  (process.stderr as unknown as { write: unknown }).write = realStderrWrite;
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  process.env = savedEnv;
  rmSync(root, { recursive: true, force: true });
});

describe('every decision path appends a content-free chain entry (audit #5)', () => {
  const args = { api_key: CANARY, note: CANARY, city: 'Lisbon' };

  it('allow: capability allow + clean response → two "pass" entries', async () => {
    const e = await appended(() => call(proxyWarn, 'ok_tool', args, 1));
    expect(e.map((x) => x.verdict)).toEqual(['pass', 'pass']);
  });

  it('warn: capability warn (unknown payee) → "flag"', async () => {
    const e = await appended(() => call(proxyWarn, 'send_payment', { recipient: RECIPIENT, amount: 5, memo: CANARY }, 2));
    expect(e[0]!.verdict).toBe('flag');
    expect(content<{ action: string }>(e[0]!.decisionId)?.action).toBe('warn');
  });

  it('block: capability block → "block"; malicious response → "block"', async () => {
    const cap = await appended(() => call(proxyBlock, 'send_payment', { recipient: RECIPIENT, amount: 5, memo: CANARY }, 3));
    expect(cap.map((x) => x.verdict)).toEqual(['block']);
    const det = await appended(() => call(proxyWarn, 'bad_tool', args, 4));
    expect(det.map((x) => x.verdict)).toEqual(['pass', 'block']);
  });

  it('degraded: L3 unavailable → entry recorded, l3Status kept in the encrypted store', async () => {
    const e = await appended(() => call(proxyWarn, 'sus_tool', args, 5));
    expect(e.map((x) => x.verdict)).toEqual(['pass', 'flag']);
    expect(content<{ l3Status: string }>(e[1]!.decisionId)?.l3Status).toBe('unavailable');
  });

  it('error: screening throws → "error" entry, response withheld (fail closed)', async () => {
    let resp: any;
    const e = await appended(async () => { resp = await call(proxyWarn, 'boom_tool', args, 6); });
    expect(e.map((x) => x.verdict)).toEqual(['pass', 'error']);
    expect(resp.error?.message).toMatch(/BLINDSEAL_ERROR/);
    expect(JSON.stringify(resp)).not.toContain(RESPONSE_CANARY);
  });

  it('scan-http: a scan verdict and a scan failure are both recorded', async () => {
    const post = (toolName: string) => fetch(scan, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `hello ${CANARY}`, toolName }) });
    const e = await appended(async () => { await post('ok_tool'); await post('boom_tool'); });
    expect(e.map((x) => x.verdict)).toEqual(['pass', 'error']);
  });

  it('the chain is intact and every entry is content-free', () => {
    const c = chain();
    expect(c.verify().ok).toBe(true);
    expect(c.length).toBeGreaterThanOrEqual(12);
    for (const line of readFileSync(path.join(auditDir, 'audit.log'), 'utf8').trim().split('\n')) {
      const e = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(e).sort()).toEqual(['decisionId', 'hash', 'index', 'payloadHash', 'prevHash', 'ts', 'verdict']);
      expect(CHAIN_VERDICTS as readonly string[]).toContain(e.verdict);
      expect(e.decisionId).toMatch(/^d_[0-9a-f]{16}$/);
      expect(e.payloadHash).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it('the canary from args (and the secret in a response) appear in no plaintext file', () => {
    const files = allFiles(root);
    expect(files.some((f) => f.endsWith('metadata.jsonl'))).toBe(true);
    expect(files.some((f) => f.endsWith('scans.db'))).toBe(true);
    for (const f of files) {
      const raw = readFileSync(f);
      expect(raw.includes(CANARY), f).toBe(false);
      expect(raw.includes(`"${RESPONSE_CANARY}"`), f).toBe(false);
    }
    expect(stderrText).toMatch(/capability-(warn|block)/); // the warn/block lines were written…
    expect(stderrText.includes(CANARY)).toBe(false);       // …without the argument values
    const meta = readFileSync(path.join(root, 'metadata.jsonl'), 'utf8');
    expect(meta).not.toMatch(/Preview|reasoning|"reason"|"args"|"text"/);
  });
});

describe('stdio proxy (real pipeline) records to the chain (audit #5)', () => {
  it('a tools/call through the stdio proxy appends capability + detection entries; no canary on disk', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bs-chain-stdio-'));
    try {
      const env: Record<string, string | undefined> = { ...savedEnv };
      for (const k of Object.keys(env)) if (k.startsWith('BLINDSEAL_')) delete env[k];
      Object.assign(env, {
        BLINDSEAL_AUDIT_DIR: path.join(dir, 'audit'), BLINDSEAL_AUDIT_LOG: path.join(dir, 'metadata.jsonl'), BLINDSEAL_MANIFEST_CHECK: 'off',
        BLINDSEAL_TRADE_GUARD: '1', BLINDSEAL_TRADE_ALLOWLIST: 'allowlisted-only', BLINDSEAL_TRADE_ALLOWLIST_MODE: 'warn',
      });
      const child = spawn(process.execPath, ['--import', 'tsx', path.join(here, '../src/index.ts'), '--', process.execPath, path.join(here, 'fixture-mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], env: env as NodeJS.ProcessEnv });
      let childErr = '';
      child.stderr.on('data', (d) => (childErr += String(d)));
      const rl = createInterface({ input: child.stdout });
      const replies = new Set<number>();
      const both = new Promise<void>((resolve) => rl.on('line', (l) => {
        const id = (JSON.parse(l) as { id?: number }).id;
        if (id === 7 || id === 8) replies.add(id);
        if (replies.size === 2) resolve();
      }));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'clean.txt', api_key: CANARY, note: CANARY } } }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'send_payment', arguments: { recipient: CANARY, amount: 5 } } }) + '\n');
      await both;
      await new Promise((r) => setTimeout(r, 200));
      // SIGKILL: chain appends are synchronous, so nothing is pending; the stdio proxy's own
      // SIGTERM handling is not what this test is about.
      const exited = new Promise((r) => child.on('exit', r));
      child.kill('SIGKILL');
      await exited;
      const c = openAudit(path.join(dir, 'audit')).chain;
      // read_file: capability pass + detection pass; send_payment: capability warn (flag) + detection pass
      expect(c.all().map((e) => e.verdict).sort()).toEqual(['flag', 'pass', 'pass', 'pass']);
      expect(c.verify().ok).toBe(true);
      for (const f of allFiles(dir)) expect(readFileSync(f).includes(CANARY), f).toBe(false);
      expect(childErr).toMatch(/capability-warn/);
      expect(childErr.includes(CANARY)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
