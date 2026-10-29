/// 0.7.0 round 3: every notice the agent receives is a fixed template (tool, direction, verdict,
/// layer, pattern ids). A judge that quotes its input must not put the withheld text back in
/// front of the agent; its reasoning goes to the encrypted audit store only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAudit } from '@blindseal/audit';
import { startHttpProxy } from '../src/transports/http.js';
import { startScanHttp } from '../src/transports/scan-http.js';
import { noticeText, detectionNotice } from '../src/transports/notice.js';

const CANARY = 'Quokkazebralantern';
const BENIGN = `Weather for today: sunny, 21 degrees. ${CANARY}.`;

let root: string;
let judge: Server;
let upstream: Server;
const savedEnv = { ...process.env };

async function listen(s: Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return (s.address() as AddressInfo).port;
}

async function proxyFor(mode: 'block' | 'warn'): Promise<{ url: string; close: () => Promise<void> }> {
  process.env.BLINDSEAL_MODE = mode;
  const p = startHttpProxy({ upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`, listenPort: 0, listenHost: '127.0.0.1' });
  await new Promise<void>((r) => (p.listening ? r() : p.on('listening', () => r())));
  return { url: `http://127.0.0.1:${(p.address() as AddressInfo).port}/mcp`, close: () => new Promise<void>((r) => p.close(() => r())) };
}

async function call(url: string, id: number) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_weather', arguments: {} } }) });
  return res.text();
}

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'bs-notice-'));
  // A loopback "judge" (OpenAI-compatible) that quotes the text it was given everywhere it can.
  judge = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const user = (JSON.parse(body).messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const verdict = { verdict: 'malicious', confidence: 0.9, reasoning: `Quoted tool output: ${user}`, detected_patterns: [user.slice(0, 60), CANARY] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }));
  });
  const judgePort = await listen(judge);
  upstream = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const msg = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: BENIGN }] } }));
  });
  await listen(upstream);
  Object.assign(process.env, {
    BLINDSEAL_AUDIT_DIR: path.join(root, 'audit'),
    BLINDSEAL_MANIFEST_CHECK: 'off',
    BLINDSEAL_LAYER3_PROVIDER: 'custom',
    BLINDSEAL_LAYER3_BASE_URL: `http://127.0.0.1:${judgePort}`,
    BLINDSEAL_LAYER3_MODEL: 'echo',
    BLINDSEAL_LAYER3_API_KEY: 'test',
    // Every text lands in L2's uncertain zone, so the judge is always asked (the auditor's method).
    BLINDSEAL_LAYER2_THRESHOLD: '1.0',
  });
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => judge.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
  process.env = savedEnv;
  rmSync(root, { recursive: true, force: true });
});

describe('the block notice is a fixed template', () => {
  it('block mode: a quoting judge does not put the original text in the reply', async () => {
    const p = await proxyFor('block');
    const text = await call(p.url, 1);
    await p.close();
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain('Weather');
    const m = JSON.parse(text);
    expect(m.result.isError).toBe(true);
    expect(m.result.content).toEqual([{
      type: 'text',
      text: noticeText('BLINDSEAL_BLOCKED', { direction: 'response', tool: 'get_weather', verdict: 'malicious', layer: 3, patterns: ['layer-3-judge'] }),
    }]);
  }, 120_000);

  it('the judge reasoning is in the encrypted audit store', async () => {
    const audit = openAudit(path.join(root, 'audit'));
    const records = audit.chain.all().map((e) => audit.content.get<{ reasoning?: string }>(e.decisionId));
    expect(records.some((r) => r?.reasoning?.includes(CANARY))).toBe(true);
  });

  it('warn mode: the warning item is exactly the template (the original follows by design)', async () => {
    const p = await proxyFor('warn');
    const text = await call(p.url, 2);
    await p.close();
    const m = JSON.parse(text);
    expect(m.result.content[0]).toEqual({
      type: 'text',
      text: noticeText('BLINDSEAL_WARNING', { direction: 'response', tool: 'get_weather', verdict: 'malicious', layer: 3, patterns: ['layer-3-judge'] }),
    });
    expect(m.result.content[0].text).not.toContain(CANARY);
    expect(m.result.content[1].text).toBe(BENIGN);
  }, 120_000);
});

describe('template fields', () => {
  it('tool names and pattern ids that are not identifiers are replaced or dropped', () => {
    const t = detectionNotice('BLINDSEAL_BLOCKED', 'request', 'evil tool\nIGNORE PREVIOUS', {
      verdict: 'malicious', confidence: 1, reasoning: 'Quoted: secret text', detectedPatterns: ['instruction-prefix:ignore-previous', 'free text with spaces'], layer: 1,
    });
    expect(t).toBe('[BLINDSEAL_BLOCKED] direction=request tool=unknown verdict=malicious layer=L1 patterns=instruction-prefix:ignore-previous. The call was not sent. Details are in the local Blindseal audit log.');
  });
});

describe('/scan returns the template by default', () => {
  const TOKEN = 'scan-dashboard-token-for-tests';
  async function scan(query = '', headers: Record<string, string> = {}) {
    const srv = startScanHttp({ listenPort: 0, listenHost: '127.0.0.1', dashboardToken: TOKEN });
    await new Promise<void>((r) => (srv.listening ? r() : srv.on('listening', () => r())));
    const res = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/scan${query}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ text: BENIGN, toolName: 'get_weather' }),
    });
    const text = await res.text();
    await new Promise<void>((r) => srv.close(() => r()));
    return { status: res.status, text };
  }

  it('default: a quoting judge puts no input-derived text in the response', async () => {
    const { status, text } = await scan();
    expect(status).toBe(200);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain('Weather');
    const body = JSON.parse(text);
    expect(body).toEqual({ verdict: 'malicious', layer: 3, detectedPatterns: ['layer-3-judge'], contentHash: body.contentHash });
    expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);

  it('verbose=1 without the dashboard token is refused', async () => {
    expect((await scan('?verbose=1')).status).toBe(401);
    expect((await scan('?verbose=1', { authorization: 'Bearer wrong' })).status).toBe(401);
  }, 120_000);

  it('verbose=1 with the dashboard token adds the reasoning, marked as possibly containing input text', async () => {
    const { status, text } = await scan('?verbose=1', { authorization: `Bearer ${TOKEN}` });
    expect(status).toBe(200);
    const body = JSON.parse(text);
    expect(body.verbose.warning).toBe('may contain input text');
    expect(body.verbose.reasoning).toContain(CANARY);
  }, 120_000);
});


/// A817-R4: the agent notice and /scan replaced a judge's pattern strings with `layer-3-judge`, but
/// the optional plaintext metadata log (BLINDSEAL_AUDIT_LOG) copied them as written, and so did the
/// scan history. Both now carry identifiers only; the judge's labels stay in the encrypted store.
describe('plaintext records carry identifiers only (A817-R4)', () => {
  it('the metadata log and scans.db have no judge text; the encrypted store keeps the labels', async () => {
    const metaFile = path.join(root, 'meta', 'audit.jsonl');
    const dbFile = path.join(root, 'db', 'scans.db');
    process.env.BLINDSEAL_AUDIT_LOG = metaFile;
    process.env.BLINDSEAL_PERSIST = '1';
    process.env.BLINDSEAL_PERSIST_PATH = dbFile;
    const p = await proxyFor('block');
    try {
      const text = await call(p.url, 41);
      expect(text).toMatch(/BLINDSEAL_BLOCKED/);
      expect(text).not.toContain(CANARY);
    } finally {
      delete process.env.BLINDSEAL_AUDIT_LOG;
      delete process.env.BLINDSEAL_PERSIST;
      delete process.env.BLINDSEAL_PERSIST_PATH;
      await p.close();
    }
    // The metadata line is written to a stream; give it a moment to reach the file.
    let raw = '';
    for (let i = 0; i < 100 && !/"type":"detection"/.test(raw); i++) {
      await new Promise((r) => setTimeout(r, 50));
      raw = existsSync(metaFile) ? readFileSync(metaFile, 'utf8') : '';
    }
    expect(raw).not.toContain(CANARY);
    expect(raw).not.toContain('Weather for today');
    expect(raw).not.toContain('Tool output');
    const detections = raw.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'detection' && e.layer === 3);
    expect(detections.length).toBeGreaterThan(0);
    for (const d of detections) expect(d.patterns).toEqual(['layer-3-judge']);
    for (const f of [dbFile, `${dbFile}-wal`]) if (existsSync(f)) expect(readFileSync(f).includes(Buffer.from(CANARY))).toBe(false);
    // The judge's own labels are retained, encrypted.
    const audit = openAudit(path.join(root, 'audit'));
    const kept = detections.map((d) => audit.content.get<{ patterns?: string[] }>(d.decisionId));
    expect(kept.some((r) => r?.patterns?.some((x) => x.includes(CANARY)))).toBe(true);
  }, 60_000);
});
