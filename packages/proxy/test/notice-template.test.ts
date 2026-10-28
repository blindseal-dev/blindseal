/// 0.7.0 round 3: every notice the agent receives is a fixed template (tool, direction, verdict,
/// layer, pattern ids). A judge that quotes its input must not put the withheld text back in
/// front of the agent; its reasoning goes to the encrypted audit store only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAudit } from '@blindseal/audit';
import { startHttpProxy } from '../src/transports/http.js';
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
