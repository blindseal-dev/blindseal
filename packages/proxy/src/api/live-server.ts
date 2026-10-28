/// Blindseal local API — LIVE mode (`blindseal run`). Serves what the proxy actually recorded on
/// this machine, over the same contract the dashboard uses with the sample data (mock-server.ts):
///
///   decisions     the hash chain (<audit dir>/audit.log) joined with the encrypted content store
///                 (<audit dir>/content.json), decrypted here with the local key
///                 (<audit dir>/content.key). Content was redacted before it was stored; raw
///                 payloads are never retained, so "reveal" is refused.
///   audit         the same chain: head, entries, verify, and signed disclosures with the local
///                 identity key (<audit dir>/identity.key).
///   policy        ~/.blindseal/policy.json, READ-ONLY: it is the committed default rule set of this
///                 release's detector. The proxy does not load rule toggles from it, so editing it
///                 would change nothing; PUT /policy answers 501. The dry run screens the pasted
///                 text with the real pipeline (L0–L2, plus L3 if configured) without recording it.
///   attestations  <audit dir>/attestations/*.json, written by `blindseal attest`. Generating and
///                 submitting stay CLI-only (`blindseal attest`, `blindseal submit`): 501 here.
///
/// Nothing is fabricated: an empty chain is an empty list. New chain entries (from proxies running
/// in other processes) are pushed over the WebSocket by polling the chain.
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { openAudit, genesisPrevHash, loadIdentity, type AuditEntry } from '@blindseal/audit';
import { getNullifierStatus } from '@blindseal/chain-reads';
import { blindsealHome, nearestFixturesDir, packageVersion, resolveDashboardToken, shippedFixturesDir } from '../paths.js';
import { describeLayer3 } from '../detection/clients/factory.js';
import { guarded, serveDashboard, sendJson, sendErr, bearerOk, readBody, wsAccept, wsFrame } from './http-common.js';

export interface LiveApiOptions {
  port?: number;
  host?: string;
  /// Chain + encrypted store + identity (default $BLINDSEAL_AUDIT_DIR or ~/.blindseal).
  auditDir?: string;
  /// Where policy.json lives (default ~/.blindseal).
  home?: string;
  token?: string;
  dashboardDist?: string;
  /// How often the chain is polled for new entries to push over the WebSocket (default 1000 ms).
  pollMs?: number;
}

export interface LiveApiHandle {
  url: string;
  token: string;
  port: number;
  auditDir: string;
  close: () => Promise<void>;
}

type Verdict = 'pass' | 'flag' | 'block';
type Retained = Record<string, unknown> & { type?: string };

const sha = (s: string) => '0x' + createHash('sha256').update(s).digest('hex');

/// Chain verdict → dashboard verdict. "error" is a screening failure whose response was withheld
/// (fail closed), so the dashboard shows it as a block; the decision carries `error: true`.
function uiVerdict(v: string): Verdict {
  if (v === 'pass' || v === 'flag' || v === 'block') return v;
  return 'block';
}

const detectionVerdict = (v: unknown): Verdict | 'skip' =>
  v === 'clean' ? 'pass' : v === 'suspicious' ? 'flag' : v === 'malicious' ? 'block' : 'skip';

/// Counts of the redaction placeholders in retained text: [REDACTED:<kind>:<n>] (the redactor)
/// and [REDACTED_<KIND>] (older previews).
function redactionsOf(text: string): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/\[REDACTED:([a-z0-9_]+):\d+\]|\[REDACTED_([A-Z0-9_]+)\]/g)) {
    const k = (m[1] ?? m[2] ?? 'other').toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([kind, count]) => ({ kind, count }));
}

/// The redacted payload retained for a decision (what the detail page shows).
function retainedPayload(r: Retained | null): string | null {
  if (!r) return null;
  if (typeof r.text === 'string') return r.text;
  if (typeof r.args === 'string') return r.args;
  if (r.type === 'manifest') return JSON.stringify({ serverKey: r.serverKey, fingerprint: r.fingerprint, status: r.status, changes: r.changes }, null, 2);
  return null;
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return null; }
}

/// A prover binary is available locally (no download is attempted from here).
function proverAvailable(home: string): boolean {
  if (process.env.BLINDSEAL_PROVER && existsSync(process.env.BLINDSEAL_PROVER)) return true;
  try {
    if (readdirSync(path.join(home, 'bin')).some((f) => f.startsWith('blindseal-prover'))) return true;
  } catch { /* no bin dir */ }
  return false;
}

export function startLiveApi(opts: LiveApiOptions = {}): Promise<LiveApiHandle> {
  const port = opts.port ?? 7777;
  const host = opts.host ?? '127.0.0.1';
  const home = opts.home ?? blindsealHome();
  const auditDir = opts.auditDir ?? process.env.BLINDSEAL_AUDIT_DIR ?? home;
  const token = resolveDashboardToken(opts.token);
  const pollMs = opts.pollMs ?? 1000;
  const startedAt = Date.now();
  const policyPath = path.join(home, 'policy.json');
  const attestationsDir = path.join(auditDir, 'attestations');

  // The audit store is opened lazily: an empty or missing dir is an empty chain, not an error,
  // and nothing (identity / content key) is created until there is something to read.
  let audit: ReturnType<typeof openAudit> | null = null;
  const hasChain = () => existsSync(path.join(auditDir, 'audit.log'));
  const getAudit = () => {
    if (!audit && hasChain()) audit = openAudit(auditDir);
    return audit;
  };
  const entries = (): AuditEntry[] => getAudit()?.chain.all() ?? [];
  const content = (id: string): Retained | null => {
    const a = getAudit();
    if (!a || !existsSync(path.join(auditDir, 'content.key'))) return null;
    try { return a.content.get<Retained>(id); } catch { return null; }
  };

  const policy = () => readJson<Record<string, unknown>>(policyPath);
  const policyRoot = () => (policy()?.root as string | undefined) ?? '';
  const detectorVersion = () => (policy()?.detectorVersion as string | undefined) ?? '';

  const genesis = () => {
    const idPath = path.join(auditDir, 'identity.key');
    return existsSync(idPath) ? genesisPrevHash(loadIdentity(idPath).pubkeyHex) : '';
  };
  const head = () => {
    const h = getAudit()?.chain.head();
    return h ?? { index: -1, hash: genesis(), ts: new Date(startedAt).toISOString() };
  };

  const toDecision = (e: AuditEntry) => {
    const r = content(e.decisionId);
    const type = r?.type ?? 'unrecorded';
    const toolName = typeof r?.toolName === 'string' ? r.toolName : type === 'manifest' ? 'manifest' : '—';
    const server = typeof r?.serverKey === 'string' ? r.serverKey : typeof r?.transport === 'string' ? r.transport : '—';
    const text = retainedPayload(r) ?? '';
    const layers: Array<Record<string, unknown>> = [];
    if (type === 'detection' && typeof r?.layer === 'number') {
      layers.push({
        layer: `L${r.layer}`, ran: true, verdict: detectionVerdict(r.verdict),
        ruleIds: Array.isArray(r.patterns) ? r.patterns : [], score: typeof r.confidence === 'number' ? r.confidence : undefined, latencyMs: 0,
      });
      if (r.l3Status === 'unavailable' && r.layer !== 3) layers.push({ layer: 'L3', ran: false, verdict: 'skip', latencyMs: 0 });
    }
    return {
      id: e.decisionId,
      ts: e.ts,
      server,
      tool: toolName,
      kind: type,
      direction: r?.direction === 'request' || type === 'capability' || type === 'attest' ? 'request' : 'response',
      verdict: uiVerdict(e.verdict),
      ...(e.verdict === 'error' ? { error: true } : {}),
      layers,
      payloadHash: e.payloadHash,
      redactedHash: text ? sha(text) : '',
      redactions: redactionsOf(text),
      policyRoot: policyRoot(),
      detectorVersion: detectorVersion(),
      auditIndex: e.index,
      auditHash: e.hash,
      latencyMs: 0,
      ...(r?.degraded === true ? { degraded: true } : {}),
      ...(r === null ? { contentUnavailable: true } : {}),
      ...(attestationFor(e.decisionId) ? { attestationId: e.decisionId } : {}),
    };
  };

  const attestationFiles = (): string[] => {
    try { return readdirSync(attestationsDir).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  };
  const loadAttestation = (file: string) => {
    const full = path.join(attestationsDir, file);
    const a = readJson<Record<string, unknown>>(full);
    if (!a) return null;
    const id = path.basename(file, '.json');
    return {
      ...a,
      id,
      decisionId: (a.decisionId as string | undefined) ?? id,
      // A file on disk is a generated proof; whether it was submitted is an on-chain question
      // (the nullifier), answered per attestation by GET /api/nullifiers/:nullifier.
      status: (a.status as string | undefined) ?? 'generated',
      createdAt: (a.createdAt as string | undefined) ?? statSync(full).mtime.toISOString(),
      tee: (a.tee as unknown) ?? { mode: 'none' },
    };
  };
  const attestationFor = (decisionId: string) => existsSync(path.join(attestationsDir, `${decisionId}.json`));

  const status = () => {
    const l3 = describeLayer3();
    return {
      version: packageVersion(),
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      connection: 'live' as const,
      upstreams: [] as Array<{ name: string; transport: string; healthy: boolean }>,
      policyRoot: policyRoot(),
      detectorVersion: detectorVersion(),
      audit: head(),
      prover: { available: proverAvailable(home) },
      // The judge as configured in the environment of this `blindseal run` process.
      l3: { mode: l3.mode, label: l3.label },
      mock: false,
      dataSource: { auditDir, policyPath, attestationsDir },
    };
  };

  const wsClients = new Set<Socket>();
  const broadcast = (obj: unknown) => {
    const frame = wsFrame(JSON.stringify(obj));
    for (const s of wsClients) if (!s.destroyed) s.write(frame);
  };

  const server: Server = createServer(guarded(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    const p = url.pathname;
    const method = req.method ?? 'GET';

    const origin = req.headers['origin'];
    if (typeof origin === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-confirm');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (!p.startsWith('/api/')) {
      if (opts.dashboardDist && method === 'GET' && serveDashboard(res, opts.dashboardDist, p)) return;
      return sendErr(res, 404, 'NOT_FOUND', 'unknown path');
    }
    if (!bearerOk(req, token, url)) return sendErr(res, 401, 'UNAUTHORIZED', 'missing or invalid bearer token');
    const seg = p.slice('/api/'.length).split('/').filter(Boolean);

    try {
      if (method === 'GET' && seg[0] === 'status' && seg.length === 1) return sendJson(res, 200, status());

      if (method === 'GET' && seg[0] === 'decisions' && seg.length === 1) {
        const q = url.searchParams;
        const vd = q.get('verdict'); const sv = q.get('server'); const tl = q.get('tool');
        const from = q.get('from'); const to = q.get('to');
        const limit = Math.min(Math.max(Number.parseInt(q.get('limit') ?? '50', 10) || 50, 1), 200);
        const cursor = Number.parseInt(q.get('cursor') ?? '0', 10) || 0;
        // newest first; content is decrypted only for the entries that are examined
        const all = entries().slice().reverse();
        const page: unknown[] = [];
        let matched = 0;
        let nextCursor: string | undefined;
        for (const e of all) {
          if (vd && uiVerdict(e.verdict) !== vd) continue;
          if (from && e.ts < from) continue;
          if (to && e.ts > to) continue;
          const d = sv || tl ? toDecision(e) : null;
          if (sv && d!.server !== sv) continue;
          if (tl && d!.tool !== tl) continue;
          if (matched++ < cursor) continue;
          if (page.length === limit) { nextCursor = String(cursor + limit); break; }
          page.push(d ?? toDecision(e));
        }
        return sendJson(res, 200, { items: page, ...(nextCursor ? { nextCursor } : {}) });
      }

      if (seg[0] === 'decisions' && seg.length >= 2) {
        const e = entries().find((x) => x.decisionId === seg[1]);
        if (!e) return sendErr(res, 404, 'NOT_FOUND', 'decision not found');
        if (method === 'GET' && seg.length === 2) {
          const payload = retainedPayload(content(e.decisionId));
          return sendJson(res, 200, { ...toDecision(e), payloadRedacted: payload ?? '' });
        }
        if (method === 'POST' && seg[2] === 'reveal' && seg.length === 3) {
          return sendErr(res, 409, 'NOT_RETAINED', 'raw payloads are never retained: only the redacted text (shown above) is kept, encrypted');
        }
      }

      if (seg[0] === 'audit') {
        if (method === 'GET' && seg[1] === 'head') return sendJson(res, 200, head());
        if (method === 'GET' && seg[1] === 'entries') {
          const all = entries();
          const from = Number.parseInt(url.searchParams.get('from') ?? '0', 10) || 0;
          const to = Number.parseInt(url.searchParams.get('to') ?? String(all.length - 1), 10);
          return sendJson(res, 200, all.filter((e) => e.index >= from && e.index <= to));
        }
        if (method === 'POST' && seg[1] === 'verify') {
          const a = getAudit();
          if (!a) return sendJson(res, 200, { ok: true, checkedFrom: 0, checkedTo: -1 });
          const v = a.chain.verify() as { ok: boolean; brokenAt?: number };
          const n = a.chain.length;
          return sendJson(res, 200, { ok: v.ok, checkedFrom: 0, checkedTo: n - 1, ...(v.brokenAt !== undefined ? { brokenAt: v.brokenAt } : {}) });
        }
        if (method === 'POST' && seg[1] === 'disclose') {
          const body = await readBody(req);
          if (!body || typeof body.from !== 'number' || typeof body.to !== 'number') return sendErr(res, 400, 'VALIDATION', 'from/to required');
          const a = getAudit();
          if (!a) return sendErr(res, 409, 'EMPTY_CHAIN', 'the audit chain is empty');
          const v = a.chain.verify() as { ok: boolean; brokenAt?: number };
          if (!v.ok && v.brokenAt !== undefined && body.from <= v.brokenAt && body.to >= v.brokenAt)
            return sendErr(res, 409, 'CHAIN_BROKEN', `the chain is broken at #${v.brokenAt}; cannot disclose a range over it`);
          return sendJson(res, 200, a.disclose(body.from, body.to));
        }
      }

      if (seg[0] === 'policy') {
        if (method === 'GET' && seg.length === 1) {
          const pol = policy();
          if (!pol) return sendErr(res, 404, 'NO_POLICY', `no policy at ${policyPath} (run \`blindseal init\`)`);
          return sendJson(res, 200, { ...pol, readOnly: true, source: policyPath });
        }
        if (method === 'PUT' && seg.length === 1) {
          return sendErr(res, 501, 'READ_ONLY', `policy.json is read-only: it is the committed default rule set of this release, and the proxy does not load rule toggles from it, so an edit would change nothing`);
        }
        if (method === 'POST' && seg[1] === 'dry-run') {
          const body = await readBody(req);
          if (!body || typeof body.payload !== 'string') return sendErr(res, 400, 'VALIDATION', 'payload (string) required');
          const { runPipeline } = await import('../detection/pipeline.js');
          const t0 = Date.now();
          const r = await runPipeline(body.payload, { toolName: 'dry-run', mcpMethod: 'tools/call' });
          return sendJson(res, 200, {
            id: 'dryrun_' + Date.now(), ts: new Date().toISOString(), server: 'dry-run', tool: 'dry-run', direction: 'response',
            verdict: detectionVerdict(r.verdict), payloadHash: sha(body.payload), redactedHash: '', redactions: [],
            layers: [{ layer: `L${r.layer ?? 1}`, ran: true, verdict: detectionVerdict(r.verdict), ruleIds: r.detectedPatterns, score: r.confidence, latencyMs: Date.now() - t0 }],
            policyRoot: policyRoot(), detectorVersion: detectorVersion(), auditIndex: -1, auditHash: '', latencyMs: Date.now() - t0,
            ...(r.degraded ? { degraded: true } : {}),
          });
        }
      }

      if (seg[0] === 'attestations') {
        if (method === 'GET' && seg.length === 1) {
          const statusFilter = url.searchParams.get('status');
          const items = attestationFiles().map(loadAttestation).filter((a) => a && (!statusFilter || a.status === statusFilter));
          return sendJson(res, 200, items);
        }
        if (method === 'POST' && seg.length === 1) {
          return sendErr(res, 501, 'CLI_ONLY', 'generate attestations with `blindseal attest <toolcall.json> --target-program <id>`');
        }
        // The Verify page's "Load sample" / "Load tampered": the shipped sample attestation, which
        // is labelled as a sample there and is not listed among this machine's attestations.
        if (method === 'GET' && seg[1] === 'sample' && seg.length === 2) {
          const dir = shippedFixturesDir() ?? nearestFixturesDir();
          const sample = dir ? readJson<unknown>(path.join(dir, 'attestation-sample.json')) : null;
          if (!sample) return sendErr(res, 404, 'NOT_FOUND', 'no sample attestation in this install');
          return sendJson(res, 200, sample);
        }
        if (seg.length >= 2) {
          const file = `${seg[1]}.json`;
          const a = /^[A-Za-z0-9_.-]+$/.test(seg[1]!) && attestationFiles().includes(file) ? loadAttestation(file) : null;
          if (method === 'GET' && seg.length === 2) {
            if (!a) return sendErr(res, 404, 'NOT_FOUND', 'attestation not found');
            return sendJson(res, 200, a);
          }
          if (method === 'POST' && seg[2] === 'submit') {
            return sendErr(res, 501, 'CLI_ONLY', 'submit with `blindseal submit <attestation.json> --wallet <keypair>`');
          }
          if (method === 'GET' && seg[2] === 'export') {
            if (!a) return sendErr(res, 404, 'NOT_FOUND', 'attestation not found');
            const buf = Buffer.from(JSON.stringify(a, null, 2));
            res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="attestation-${seg[1]}.json"`, 'content-length': buf.length });
            return res.end(buf);
          }
        }
      }

      if (method === 'GET' && seg[0] === 'tee' && seg[1] === 'quote') return sendJson(res, 200, { mode: 'none' });

      if (seg[0] === 'nullifiers' && seg[1] && method === 'GET') {
        try {
          return sendJson(res, 200, await getNullifierStatus(seg[1]));
        } catch (e) {
          return sendErr(res, 502, 'RPC_UNAVAILABLE', e instanceof Error ? e.message : String(e));
        }
      }
      return sendErr(res, 404, 'NOT_FOUND', `no route for ${method} ${p}`);
    } catch (e) {
      return sendErr(res, 500, 'INTERNAL', (e as Error).message);
    }
  }));

  server.on('upgrade', (req, socket: Socket) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${host}:${port}`);
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      return socket.destroy();
    }
    const isEvents = url.pathname === '/api/events' || url.pathname === '/events';
    if (!isEvents || !bearerOk(req, token, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
    );
    wsClients.add(socket);
    socket.write(wsFrame(JSON.stringify({ type: 'status', data: status() })));
    socket.on('close', () => wsClients.delete(socket));
    socket.on('error', () => wsClients.delete(socket));
  });

  // Live stream: decisions appended by proxies in other processes since the last poll.
  let seen = entries().length;
  const timer = setInterval(() => {
    const all = entries();
    if (all.length <= seen) return;
    const fresh = all.slice(seen);
    seen = all.length;
    if (wsClients.size === 0) return;
    for (const e of fresh) broadcast({ type: 'decision', data: toDecision(e) });
  }, pollMs);
  timer.unref?.();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        url: `http://${host}:${actualPort}/api`,
        token,
        port: actualPort,
        auditDir,
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
