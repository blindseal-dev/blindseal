/// Blindseal local API — MOCK mode (M0). Serves fixtures/ over the FRONTEND.md §5
/// contract with a fake WS event stream, so the dashboard/site can be built day one.
/// No prover, policy engine, or audit chain is involved: this reads static JSON.
/// The real API (backed by the M1 engine) replaces the handlers, not the contract.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface MockApiOptions {
  port?: number;
  host?: string;
  fixturesDir: string;
  token?: string;        // explicit token (tests); otherwise read/create ~/.blindseal/dashboard.token
  emitIntervalMs?: number; // fake decision cadence (default 3000)
}

export interface MockApiHandle {
  url: string;
  token: string;
  port: number;
  close: () => Promise<void>;
}

interface Fixtures {
  decisions: any[];
  policy: any;
  audit: { head: any; genesis: string; entries: any[] };
  attestations: any[];
  sample: any;
}

function loadFixtures(dir: string): Fixtures {
  const read = (f: string) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  return {
    decisions: read('decisions.json'),
    policy: read('policy.json'),
    audit: read('audit.json'),
    attestations: read('attestations.json'),
    sample: read('attestation-sample.json'),
  };
}

export function resolveToken(explicit?: string): string {
  if (explicit) return explicit;
  const dir = path.join(os.homedir(), '.blindseal');
  const file = path.join(dir, 'dashboard.token');
  try {
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
    mkdirSync(dir, { recursive: true });
    const tok = randomBytes(24).toString('base64url');
    writeFileSync(file, tok + '\n', { mode: 0o600 });
    return tok;
  } catch {
    // homedir unwritable (CI sandbox): fall back to an ephemeral token
    return randomBytes(24).toString('base64url');
  }
}

// ---- helpers ----
const DOMAIN = 'blindseal.audit.v1';
const sha = (s: string) => '0x' + createHash('sha256').update(s).digest('hex');

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}
function sendErr(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function bearerOk(req: IncomingMessage, token: string, url: URL): boolean {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth === `Bearer ${token}`) return true;
  // WS/browser convenience: ?token= on the query
  if (url.searchParams.get('token') === token) return true;
  return false;
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined; // signal VALIDATION
  }
}

// ---- minimal WebSocket (server->client text frames only) ----
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsAccept(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}
function wsFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export function startMockApi(opts: MockApiOptions): Promise<MockApiHandle> {
  const port = opts.port ?? 7777;
  const host = opts.host ?? '127.0.0.1';
  const token = resolveToken(opts.token);
  const emitIntervalMs = opts.emitIntervalMs ?? 3000;
  const fx = loadFixtures(opts.fixturesDir);
  const startedAt = Date.now();

  const status = () => ({
    version: '0.0.0-mock',
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    upstreams: [{ name: 'mock-upstream', transport: 'stdio' as const, healthy: true }],
    policyRoot: fx.policy.root,
    detectorVersion: fx.decisions[0]?.detectorVersion ?? '0x',
    audit: fx.audit.head,
    prover: { available: false },
    l3: { mode: 'off' as const },
    mock: true,
  });

  const wsClients = new Set<Socket>();
  const broadcast = (obj: unknown) => {
    const frame = wsFrame(JSON.stringify(obj));
    for (const s of wsClients) {
      if (!s.destroyed) s.write(frame);
    }
  };

  // in-memory overlays so GET resolves items that aren't in the static fixtures:
  // attestations created via POST, and decisions pushed over the live WS stream.
  const createdAttestations = new Map<string, any>();
  const liveDecisions = new Map<string, any>();

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    const p = url.pathname;
    const method = req.method ?? 'GET';

    // CORS: the dashboard runs cross-origin on a Vite dev port, so a browser preflights.
    // Reflect only localhost/127.0.0.1 origins; answer OPTIONS before auth (it carries no token).
    const origin = req.headers['origin'];
    if (typeof origin === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-confirm');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (!p.startsWith('/api/')) return sendErr(res, 404, 'NOT_FOUND', 'unknown path');
    if (!bearerOk(req, token, url)) return sendErr(res, 401, 'UNAUTHORIZED', 'missing or invalid bearer token');
    const seg = p.slice('/api/'.length).split('/').filter(Boolean);

    try {
      // GET /api/status
      if (method === 'GET' && seg[0] === 'status' && seg.length === 1) return sendJson(res, 200, status());

      // GET /api/decisions  (cursor/limit/verdict/server/tool/from/to)
      if (method === 'GET' && seg[0] === 'decisions' && seg.length === 1) {
        const q = url.searchParams;
        let items = fx.decisions.slice();
        const vd = q.get('verdict'); if (vd) items = items.filter((d) => d.verdict === vd);
        const sv = q.get('server'); if (sv) items = items.filter((d) => d.server === sv);
        const tl = q.get('tool'); if (tl) items = items.filter((d) => d.tool === tl);
        const from = q.get('from'); if (from) items = items.filter((d) => d.ts >= from);
        const to = q.get('to'); if (to) items = items.filter((d) => d.ts <= to);
        const limit = Math.min(Math.max(Number.parseInt(q.get('limit') ?? '50', 10) || 50, 1), 200);
        const cursor = Number.parseInt(q.get('cursor') ?? '0', 10) || 0;
        const page = items.slice(cursor, cursor + limit);
        const nextCursor = cursor + limit < items.length ? String(cursor + limit) : undefined;
        return sendJson(res, 200, { items: page, ...(nextCursor ? { nextCursor } : {}) });
      }

      // GET /api/decisions/:id   POST /api/decisions/:id/reveal
      if (seg[0] === 'decisions' && seg.length >= 2) {
        const d = fx.decisions.find((x) => x.id === seg[1]) ?? liveDecisions.get(seg[1]!);
        if (!d) return sendErr(res, 404, 'NOT_FOUND', 'decision not found');
        if (method === 'GET' && seg.length === 2) {
          return sendJson(res, 200, { ...d, payloadRedacted: `[mock redacted payload for ${d.id}]` });
        }
        if (method === 'POST' && seg[2] === 'reveal' && seg.length === 3) {
          if (req.headers['x-confirm'] !== 'reveal') return sendErr(res, 400, 'VALIDATION', 'X-Confirm: reveal required');
          return sendJson(res, 200, { payload: `[mock raw payload for ${d.id} — synthetic]` });
        }
      }

      // GET /api/audit/head | /api/audit/entries | POST /api/audit/verify | /api/audit/disclose
      if (seg[0] === 'audit') {
        if (method === 'GET' && seg[1] === 'head') return sendJson(res, 200, fx.audit.head);
        if (method === 'GET' && seg[1] === 'entries') {
          const from = Number.parseInt(url.searchParams.get('from') ?? '0', 10) || 0;
          const to = Number.parseInt(url.searchParams.get('to') ?? String(fx.audit.head.index), 10);
          return sendJson(res, 200, fx.audit.entries.filter((e) => e.index >= from && e.index <= to));
        }
        if (method === 'POST' && seg[1] === 'verify') {
          // recompute the chain from genesis
          let prev = fx.audit.genesis;
          let brokenAt: number | undefined;
          for (const e of fx.audit.entries) {
            const core = { index: e.index, ts: e.ts, decisionId: e.decisionId, verdict: e.verdict, payloadHash: e.payloadHash, prevHash: prev };
            const h = sha(DOMAIN + JSON.stringify(core));
            if (h !== e.hash || e.prevHash !== prev) { brokenAt = e.index; break; }
            prev = e.hash;
          }
          return sendJson(res, 200, {
            ok: brokenAt === undefined,
            checkedFrom: 0,
            checkedTo: fx.audit.head.index,
            ...(brokenAt !== undefined ? { brokenAt } : {}),
          });
        }
        if (method === 'POST' && seg[1] === 'disclose') {
          const body = await readBody(req);
          if (!body || typeof body.from !== 'number' || typeof body.to !== 'number') return sendErr(res, 400, 'VALIDATION', 'from/to required');
          const entries = fx.audit.entries.filter((e) => e.index >= body.from && e.index <= body.to);
          return sendJson(res, 200, {
            from: body.from, to: body.to, head: fx.audit.head, entries,
            signerPubkey: sha('mock-proxy-identity').slice(0, 66),
            signature: sha('mock-sig:' + body.from + ':' + body.to),
          });
        }
      }

      // GET /api/policy | PUT /api/policy | POST /api/policy/dry-run
      if (seg[0] === 'policy') {
        if (method === 'GET' && seg.length === 1) return sendJson(res, 200, fx.policy);
        if (method === 'PUT' && seg.length === 1) {
          const body = await readBody(req);
          if (!body || !Array.isArray(body.rules)) return sendErr(res, 400, 'VALIDATION', 'rules[] required');
          const root = sha('policy:' + JSON.stringify(body.rules));
          return sendJson(res, 200, { ...fx.policy, rules: body.rules, root, version: (fx.policy.version ?? 1) + 1, updatedAt: new Date().toISOString() });
        }
        if (method === 'POST' && seg[1] === 'dry-run') {
          const body = await readBody(req);
          if (body === undefined) return sendErr(res, 400, 'VALIDATION', 'invalid JSON body');
          // echo a synthetic, NOT-logged decision
          const d = { ...fx.decisions[0], id: 'dryrun_' + Date.now(), ts: new Date().toISOString() };
          return sendJson(res, 200, d);
        }
      }

      // GET /api/attestations | GET /api/attestations/:id | POST create/submit/export
      if (seg[0] === 'attestations') {
        if (method === 'GET' && seg.length === 1) {
          const st = url.searchParams.get('status');
          const items = st ? fx.attestations.filter((a) => a.status === st) : fx.attestations;
          return sendJson(res, 200, items);
        }
        if (method === 'POST' && seg.length === 1) {
          const body = await readBody(req);
          if (!body || typeof body.decisionId !== 'string') return sendErr(res, 400, 'VALIDATION', 'decisionId required');
          const d = fx.decisions.find((x) => x.id === body.decisionId);
          if (!d) return sendErr(res, 404, 'NOT_FOUND', 'decision not found');
          if (!d.action) return sendErr(res, 422, 'NO_ACTION_FIELDS', 'decision has no on-chain action to attest');
          const id = 'att_' + randomBytes(5).toString('hex');
          // stash a generating attestation so GET /attestations/:id resolves it
          createdAttestations.set(id, {
            ...fx.sample, id, decisionId: d.id, status: 'generating', progressPct: 50, createdAt: new Date().toISOString(),
          });
          // simulate async generation over WS, and flip the stored status
          setTimeout(() => broadcast({ type: 'attestation', data: { id, status: 'generating', progressPct: 50 } }), 50);
          setTimeout(() => {
            const a = createdAttestations.get(id);
            if (a) { a.status = 'generated'; a.progressPct = 100; }
            broadcast({ type: 'attestation', data: { id, status: 'generated', progressPct: 100 } });
          }, 150);
          return sendJson(res, 202, { id });
        }
        if (seg.length >= 2) {
          const a = fx.attestations.find((x) => x.id === seg[1]) ?? createdAttestations.get(seg[1]!) ?? (seg[1] === 'sample' ? fx.sample : undefined);
          if (method === 'GET' && seg.length === 2) {
            if (!a) return sendErr(res, 404, 'NOT_FOUND', 'attestation not found');
            return sendJson(res, 200, a);
          }
          if (method === 'POST' && seg[2] === 'submit') {
            const body = await readBody(req);
            if (!body || (body.cluster !== 'devnet' && body.cluster !== 'mainnet-beta')) return sendErr(res, 400, 'VALIDATION', 'cluster must be devnet|mainnet-beta');
            return sendJson(res, 200, { txSig: sha('mock-txsig:' + seg[1]).slice(2, 90) });
          }
          if (method === 'GET' && seg[2] === 'export') {
            if (!a) return sendErr(res, 404, 'NOT_FOUND', 'attestation not found');
            const buf = Buffer.from(JSON.stringify(a, null, 2));
            res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="attestation-${seg[1]}.json"`, 'content-length': buf.length });
            return res.end(buf);
          }
        }
      }

      // GET /api/tee/quote
      if (method === 'GET' && seg[0] === 'tee' && seg[1] === 'quote') {
        return sendJson(res, 200, { mode: 'local' });
      }

      return sendErr(res, 404, 'NOT_FOUND', `no route for ${method} ${p}`);
    } catch (e) {
      return sendErr(res, 500, 'VALIDATION', (e as Error).message);
    }
  });

  // WS /events — minimal server->client stream
  server.on('upgrade', (req, socket: Socket) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    // canonical path is /api/events (same base as REST); /events accepted as an alias
    const isEvents = url.pathname === '/api/events' || url.pathname === '/events';
    if (!isEvents || !bearerOk(req, token, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
    );
    wsClients.add(socket);
    socket.write(wsFrame(JSON.stringify({ type: 'status', data: status() })));
    socket.on('close', () => wsClients.delete(socket));
    socket.on('error', () => wsClients.delete(socket));
  });

  // fake decision stream: replay fixtures round-robin
  let idx = 0;
  const timer = setInterval(() => {
    if (wsClients.size === 0) return;
    const base = fx.decisions[idx % fx.decisions.length];
    idx++;
    const live = { ...base, id: base.id + '_live' + idx, ts: new Date().toISOString() };
    liveDecisions.set(live.id, live);
    // cap the overlay so a long-running mock doesn't grow unbounded
    if (liveDecisions.size > 100) liveDecisions.delete(liveDecisions.keys().next().value as string);
    broadcast({ type: 'decision', data: live });
  }, emitIntervalMs);
  timer.unref?.();

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        url: `http://${host}:${actualPort}/api`,
        token,
        port: actualPort,
        close: () =>
          new Promise<void>((r) => {
            clearInterval(timer);
            for (const s of wsClients) s.destroy();
            wsClients.clear();
            server.close(() => r());
          }),
      });
    });
  });
}
