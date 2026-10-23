import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startMockApi, type MockApiHandle } from '../src/api/mock-server.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures');
const TOKEN = 'test-token-123';

let api: MockApiHandle;
let base: string;
const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

beforeAll(async () => {
  api = await startMockApi({ port: 0, fixturesDir: FIXTURES, token: TOKEN, emitIntervalMs: 60 });
  base = api.url; // http://127.0.0.1:<port>/api
});
afterAll(async () => { await api.close(); });

describe('mock API — auth', () => {
  it('401s without a token', async () => {
    const r = await fetch(`${base}/status`);
    expect(r.status).toBe(401);
    const b = await r.json();
    expect(b.error.code).toBe('UNAUTHORIZED');
  });
  it('accepts a valid bearer token', async () => {
    const r = await fetch(`${base}/status`, auth);
    expect(r.status).toBe(200);
  });
});

describe('mock API — status', () => {
  it('returns the Status shape with mock:true', async () => {
    const s = await (await fetch(`${base}/status`, auth)).json();
    expect(s.mock).toBe(true);
    expect(typeof s.version).toBe('string');
    expect(s.policyRoot).toMatch(/^0x[0-9a-f]+$/);
    expect(s.audit).toHaveProperty('index');
    // Matches the mockups' fixtures.js default: L3 local (→ 'tee' under ?state=tee), prover healthy,
    // connection live. The ?state= / BLINDSEAL_MOCK_STATE switches flip these.
    expect(s.l3.mode).toBe('local');
    expect(s.prover.available).toBe(true);
    expect(s.connection).toBe('live');
  });

  it('honors ?state= switches (empty, tee, unauthorized)', async () => {
    const empty = await (await fetch(`${base}/decisions?state=empty`, auth)).json();
    expect(empty.items).toHaveLength(0);
    const tee = await (await fetch(`${base}/status?state=tee`, auth)).json();
    expect(tee.l3.mode).toBe('tee');
    const un = await fetch(`${base}/decisions?state=unauthorized`, auth);
    expect(un.status).toBe(401);
  });
});

describe('mock API — decisions', () => {
  it('paginates with cursor/limit and returns nextCursor', async () => {
    const r = await (await fetch(`${base}/decisions?limit=50`, auth)).json();
    expect(r.items).toHaveLength(50);
    expect(r.nextCursor).toBe('50');
    const keys = Object.keys(r.items[0]);
    for (const k of ['id', 'ts', 'server', 'tool', 'verdict', 'layers', 'payloadHash', 'redactedHash', 'policyRoot', 'auditIndex', 'auditHash']) {
      expect(keys).toContain(k);
    }
  });
  it('filters by verdict', async () => {
    const r = await (await fetch(`${base}/decisions?verdict=block&limit=200`, auth)).json();
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((d: any) => d.verdict === 'block')).toBe(true);
  });
  it('gets one decision and reveal requires X-Confirm', async () => {
    const list = await (await fetch(`${base}/decisions?limit=1`, auth)).json();
    const id = list.items[0].id;
    const one = await fetch(`${base}/decisions/${id}`, auth);
    expect(one.status).toBe(200);
    const noConfirm = await fetch(`${base}/decisions/${id}/reveal`, { method: 'POST', headers: auth.headers });
    expect(noConfirm.status).toBe(400);
    const ok = await fetch(`${base}/decisions/${id}/reveal`, { method: 'POST', headers: { ...auth.headers, 'x-confirm': 'reveal' } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).payload).toContain(id);
  });
  it('404s an unknown decision', async () => {
    const r = await fetch(`${base}/decisions/nope`, auth);
    expect(r.status).toBe(404);
  });
});

describe('mock API — audit', () => {
  it('head + verify (chain intact)', async () => {
    const head = await (await fetch(`${base}/audit/head`, auth)).json();
    expect(head).toHaveProperty('hash');
    const v = await (await fetch(`${base}/audit/verify`, { method: 'POST', headers: auth.headers })).json();
    expect(v.ok).toBe(true);
    expect(v.brokenAt).toBeUndefined();
  });
  it('disclose returns a signed, content-free window', async () => {
    const d = await (await fetch(`${base}/audit/disclose`, { method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json' }, body: JSON.stringify({ from: 0, to: 5 }) })).json();
    expect(d.entries).toHaveLength(6);
    expect(d.signature).toMatch(/^[0-9a-f]{128}$/); // a real ed25519 signature (64 bytes, hex)
    expect(d.entries[0]).not.toHaveProperty('payload');
    const { verifyDisclosure } = await import('@blindseal/audit');
    expect(verifyDisclosure(d)).toEqual({ ok: true }); // signed by the mock identity, chain reproduces
  });
});

describe('mock API — CORS', () => {
  it('answers OPTIONS preflight (no token) and reflects a localhost origin', async () => {
    const r = await fetch(`${base}/status`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' } });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(r.headers.get('access-control-allow-headers')).toContain('authorization');
  });
  it('sets ACAO on an authed GET from a localhost origin', async () => {
    const r = await fetch(`${base}/status`, { headers: { ...auth.headers, origin: 'http://127.0.0.1:5173' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
  });
});

describe('mock API — policy & attestations', () => {
  it('GET policy returns rules + root', async () => {
    const p = await (await fetch(`${base}/policy`, auth)).json();
    // The 22 committed L1 rules from detector-core (root is over 22 DFA leaves + 1 zero-width leaf).
    expect(p.rules.length).toBe(22);
    expect(p.root).toBe('0x36a9e9457db6ecfd752a379fc9279ad6a0acfea07928f61e2f3638a685c38397');
  });
  it('lists attestations and filters by status', async () => {
    const all = await (await fetch(`${base}/attestations`, auth)).json();
    expect(all.length).toBe(6);
    expect(all.every((a: any) => typeof a.id === 'string')).toBe(true);
    const consumed = await (await fetch(`${base}/attestations?status=consumed`, auth)).json();
    expect(consumed.every((a: any) => a.status === 'consumed')).toBe(true);
  });
  it('navigates list -> detail by id, and a created attestation is fetchable', async () => {
    const all = await (await fetch(`${base}/attestations`, auth)).json();
    const one = await fetch(`${base}/attestations/${all[0].id}`, auth);
    expect(one.status).toBe(200);
    expect((await one.json()).id).toBe(all[0].id);
    const withAction = (await (await fetch(`${base}/decisions?limit=200`, auth)).json()).items.find((d: any) => d.action);
    const created = await (await fetch(`${base}/attestations`, { method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json' }, body: JSON.stringify({ decisionId: withAction.id }) })).json();
    const got = await fetch(`${base}/attestations/${created.id}`, auth);
    expect(got.status).toBe(200);
    expect((await got.json()).id).toBe(created.id);
  });
  it('create: 202 for a decision with action, 422 for one without', async () => {
    const withAction = (await (await fetch(`${base}/decisions?limit=200`, auth)).json()).items.find((d: any) => d.action);
    const noAction = (await (await fetch(`${base}/decisions?limit=200`, auth)).json()).items.find((d: any) => !d.action);
    const r1 = await fetch(`${base}/attestations`, { method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json' }, body: JSON.stringify({ decisionId: withAction.id }) });
    expect(r1.status).toBe(202);
    expect((await r1.json()).id).toMatch(/^att_/);
    const r2 = await fetch(`${base}/attestations`, { method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json' }, body: JSON.stringify({ decisionId: noAction.id }) });
    expect(r2.status).toBe(422);
    expect((await r2.json()).error.code).toBe('NO_ACTION_FIELDS');
  });
});

describe('mock API — WS /events', () => {
  it('streams a decision event', async () => {
    const wsUrl = base.replace(/^http/, 'ws') + `/events?token=${TOKEN}`;
    const got = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => { ws.close(); reject(new Error('no decision event within 3s')); }, 3000);
      ws.addEventListener('message', (ev: any) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'decision') { clearTimeout(timer); ws.close(); resolve(msg); }
      });
      ws.addEventListener('error', (e: any) => { clearTimeout(timer); reject(e); });
    });
    expect(got.type).toBe('decision');
    expect(got.data).toHaveProperty('verdict');
  });
  it('rejects WS without a token', async () => {
    const wsUrl = base.replace(/^http/, 'ws') + '/events';
    const failed = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener('open', () => { ws.close(); resolve(false); });
      ws.addEventListener('error', () => resolve(true));
    });
    expect(failed).toBe(true);
  });
});
