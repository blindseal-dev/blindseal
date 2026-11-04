/// The HTTP API.
///   POST /jobs                   screen → (expiry) → charge → queue; 202 with the job record
///   GET  /jobs/:id               the record (status queued | running | done | failed, payment, error)
///   GET  /jobs/:id/attestation   the attestation once done (409 before, 404 unknown)
///   GET  /healthz
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Billing } from './billing/x402.js';
import type { HostConfig } from './config.js';
import { ExpiryError, resolveExpiry } from './expiry.js';
import type { ProofQueue } from './jobs/queue.js';
import type { JobRecord, JobStore } from './jobs/store.js';
import { screenPayload } from './screen.js';

export const MAX_BODY_BYTES = 1 << 20;
export const VERSION = '0.1.0';

export interface ServerDeps {
  config: HostConfig;
  store: JobStore;
  queue: ProofQueue;
  billing?: Billing;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly extra: Record<string, unknown> = {}) { super(message); }
}

/// The accepted request body.
export interface JobRequest {
  payload: string;
  targetProgram?: string;
  instruction?: string;
  expirySlot?: unknown;
  noExpiry?: unknown;
  decisionId?: string;
  nonce?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/// `payload` (base64 of the exact bytes) or `call` ({tool|toolName, args}); the fields the prover CLI takes.
export function parseJobRequest(body: unknown): JobRequest {
  if (!isObj(body)) throw new HttpError(400, 'the body must be a JSON object');
  let payload: string;
  if (body.payload !== undefined) {
    if (typeof body.payload !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.payload)) throw new HttpError(400, 'payload must be base64');
    const bytes = Buffer.from(body.payload, 'base64');
    try { payload = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new HttpError(400, 'payload bytes are not UTF-8'); }
    if (body.call !== undefined) throw new HttpError(400, 'give payload or call, not both');
  } else if (isObj(body.call)) {
    const tool = body.call.tool ?? body.call.toolName;
    if (typeof tool !== 'string' || !isObj(body.call.args)) throw new HttpError(400, 'call must be { tool, args } (or { toolName, args })');
    payload = JSON.stringify({ tool, args: body.call.args });
  } else {
    throw new HttpError(400, 'give payload (base64 of the tool-call JSON) or call ({ tool, args })');
  }
  const opt = (k: string, re: RegExp, what: string): string | undefined => {
    const v = body[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !re.test(v)) throw new HttpError(400, `${k} must be ${what}`);
    return v;
  };
  return {
    payload,
    targetProgram: opt('targetProgram', /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'a base58 program id'),
    instruction: opt('instruction', /^(0x)?[0-9a-fA-F]{16}$/, '16 hex digits'),
    expirySlot: body.expirySlot,
    noExpiry: body.noExpiry,
    decisionId: opt('decisionId', /^[A-Za-z0-9_-]{1,64}$/, 'up to 64 letters, digits, _ or -'),
    nonce: opt('nonce', /^0x[0-9a-fA-F]{64}$/, '0x + 64 hex'),
  };
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new HttpError(413, `body larger than ${MAX_BODY_BYTES} bytes`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(text)); } catch { reject(new HttpError(400, 'the body is not JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n';
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(text);
}

export function createServer(deps: ServerDeps): Server {
  const { config, store, queue, billing } = deps;
  const log = deps.log ?? (() => {});
  const publicUrl = config.publicUrl ?? `http://${config.host}:${config.port}`;

  async function postJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const jr = parseJobRequest(body);
    // 1) what the guest asserts: binding + the proven layers. Free, and before any payment is looked at.
    const screened = screenPayload(jr.payload, { targetProgram: jr.targetProgram, instruction: jr.instruction });
    if (!screened.ok) {
      throw new HttpError(422, `refused (${screened.code}): ${screened.reason}; nothing was proved and nothing was charged`, { code: screened.code, verdict: screened.verdict, patterns: screened.patterns });
    }
    // 2) the expiry slot (may need the RPC) — before charging, so an RPC outage costs nobody anything
    let expirySlot: string;
    try { expirySlot = await resolveExpiry(jr, process.env.BLINDSEAL_RPC_URL || config.rpcUrl, deps.fetchImpl); }
    catch (e) { if (e instanceof ExpiryError) throw new HttpError(e.status, e.message); throw e; }
    // 3) payment: verify and settle, or answer 402
    let payment: JobRecord['payment'] = { status: 'not-billed' };
    let paymentHeaders: Record<string, string> = {};
    if (billing) {
      const outcome = await billing.charge(req, body);
      if (outcome.kind === 'rejected') {
        const r = outcome.response;
        send(res, r.status, r.isHtml ? String(r.body) : r.body ?? {}, r.headers);
        return;
      }
      payment = outcome.payment;
      paymentHeaders = outcome.headers;
    }
    // 4) queue
    const now = new Date().toISOString();
    const record: JobRecord = {
      id: 'j_' + randomBytes(8).toString('hex'), status: 'queued', createdAt: now, updatedAt: now,
      backend: config.backend, payloadHash: screened.payloadHash, action: screened.action, expirySlot,
      decisionId: jr.decisionId ?? 'd_' + randomBytes(8).toString('hex'), nonce: jr.nonce, payment,
    };
    store.create(record, jr.payload);
    queue.enqueue(record);
    log(`job ${record.id}: queued (payloadHash ${record.payloadHash}, payment ${payment.status})`);
    send(res, 202, { ...record, links: { self: `/jobs/${record.id}`, attestation: `/jobs/${record.id}/attestation` } }, { location: `${publicUrl}/jobs/${record.id}`, ...paymentHeaders });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', publicUrl);
    const m = req.method ?? 'GET';
    if (url.pathname === '/healthz' && m === 'GET') {
      send(res, 200, {
        ok: true, version: VERSION, backend: config.backend, queue: queue.stats(),
        billing: billing ? { network: billing.network, asset: billing.asset, amount: billing.amount, priceUsdc: config.priceUsdc, payTo: billing.payTo } : 'off',
      });
      return;
    }
    if (url.pathname === '/jobs') {
      if (m !== 'POST') throw new HttpError(405, 'POST /jobs');
      await postJob(req, res);
      return;
    }
    const job = /^\/jobs\/([^/]+)(\/attestation)?$/.exec(url.pathname);
    if (job) {
      if (m !== 'GET') throw new HttpError(405, 'GET only');
      const record = store.get(job[1]!);
      if (!record) throw new HttpError(404, 'no such job');
      if (!job[2]) { send(res, 200, record); return; }
      if (record.status !== 'done') throw new HttpError(409, `job is ${record.status}; no attestation yet`, { status: record.status, error: record.error });
      const att = store.readAttestation(record.id);
      if (att === undefined) throw new HttpError(500, 'attestation file missing');
      send(res, 200, att);
      return;
    }
    throw new HttpError(404, 'not found');
  }

  return createHttpServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) { send(res, e.status, { error: e.message, ...e.extra }); return; }
      log(`error: ${(e as Error).stack ?? String(e)}`);
      send(res, 500, { error: 'internal error' });
    });
  });
}
