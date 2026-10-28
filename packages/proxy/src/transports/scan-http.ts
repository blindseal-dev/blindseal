/// Scan-only HTTP transport.
/// Exposes a single POST /scan endpoint that runs raw text through the existing
/// detection pipeline (runPipeline), returning the DetectionResult as JSON. This is not
/// an MCP transport — it is a back-end service for external callers (e.g. a demo site)
/// that want a verdict on free-form text.
///
/// The response is the same fixed template the agent-facing notices use (notice.ts): verdict,
/// layer, pattern ids (and the hash of the scanned text). Detector reasoning can quote the input
/// (an AI judge explains what it read), so it is returned only on request: `?verbose=1` with the
/// dashboard token as `Authorization: Bearer <token>`. It is always in the encrypted audit store.
///
/// Detection logic is reused verbatim. Every scan verdict (and every pipeline failure) is a
/// decision and is appended to the audit hash chain like the MCP transports' decisions.
/// Capability gating, taint tracking, manifest checking and local scan persistence are not
/// wired here — they require MCP-protocol context (tool calls, server identifiers, session
/// boundaries) that a free-form scan endpoint doesn't have.

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { loadConfig } from '../config.js';
import { httpServerIdentifier } from './server-id.js';
import { runPipeline } from '../detection/pipeline.js';
import { sha256Hex } from './shared.js';
import { createAuditLogger } from '../audit/index.js';
import { timingSafeEqual } from 'node:crypto';
import { resolveDashboardToken } from '../paths.js';
import { noticePatterns } from './notice.js';

export interface ScanHttpOptions {
  listenPort: number;
  listenHost?: string;
  /// Logical server identifier recorded with each scan (e.g. "https://github.com/blindseal-dev/blindseal").
  /// Per-request overrides via the serverUrl body field take precedence.
  defaultServerUrl?: string;
  /// The token that unlocks `?verbose=1` (default: ~/.blindseal/dashboard.token, as for `blindseal run`).
  dashboardToken?: string;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(\S+)$/.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const DEFAULT_MAX_BODY = 256 * 1024; // 256 KB — comfortably above the demo's 8 KB cap
const MAX_TEXT_BYTES = 256 * 1024;

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

export interface ScanRequestBody {
  text: string;
  toolName?: string;
  serverUrl?: string;
}

function parseRequestBody(raw: string): ScanRequestBody | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'body must be JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'body must be a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.text !== 'string') {
    return { error: 'field "text" is required and must be a string' };
  }
  if (Buffer.byteLength(obj.text, 'utf8') > MAX_TEXT_BYTES) {
    return { error: `field "text" exceeds ${MAX_TEXT_BYTES} bytes` };
  }
  const out: ScanRequestBody = { text: obj.text };
  if (typeof obj.toolName === 'string') out.toolName = obj.toolName;
  if (typeof obj.serverUrl === 'string') out.serverUrl = obj.serverUrl;
  return out;
}

export function startScanHttp(opts: ScanHttpOptions): Server {
  const config = loadConfig(); // same env validation as the MCP transports
  const audit = createAuditLogger(config.audit);

  const defaultServerUrl = opts.defaultServerUrl ?? 'scan-http:blindseal';
  const dashboardToken = resolveDashboardToken(opts.dashboardToken);

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';

    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      sendJson(res, 200, {
        ok: true,
      });
      return;
    }

    if (req.method !== 'POST' || path !== '/scan') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const verbose = new URLSearchParams(url.split('?')[1] ?? '').get('verbose') === '1';
    if (verbose && !tokenMatches(req.headers.authorization, dashboardToken)) {
      sendJson(res, 401, { error: 'verbose=1 needs the dashboard token (Authorization: Bearer <token>)' });
      return;
    }

    let bodyBuf: Buffer;
    try {
      bodyBuf = await readBody(req, DEFAULT_MAX_BODY);
    } catch (err) {
      sendJson(res, 413, { error: err instanceof Error ? err.message : 'body read failed' });
      return;
    }

    const parsed = parseRequestBody(bodyBuf.toString('utf8'));
    if ('error' in parsed) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }

    const toolName = parsed.toolName ?? 'scan';
    const serverUrl = parsed.serverUrl ?? defaultServerUrl;
    const contentHash = sha256Hex(parsed.text);

    let result;
    try {
      result = await runPipeline(parsed.text, { toolName });
    } catch (err) {
      process.stderr.write(
        `blindseal[scan-http]: pipeline failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      audit.log({ type: 'error', toolName, stage: 'scan', error: err instanceof Error ? err.message : String(err), contentHash, text: parsed.text });
      sendJson(res, 500, { error: 'pipeline failed' });
      return;
    }

    audit.log({
      type: 'detection',
      toolName,
      layer: result.layer ?? null,
      verdict: result.verdict,
      confidence: result.confidence,
      patterns: result.detectedPatterns,
      mode: 'scan',
      mutated: false,
      reasoning: result.reasoning,
      contentHash,
      text: parsed.text,
      l3Status: result.l3Status,
      transport: 'scan-http',
      serverKey: serverUrl ? httpServerIdentifier(serverUrl) : undefined,
      ...(result.degraded ? { degraded: true } : {}),
    });

    if (result.verdict !== 'clean') {
      process.stderr.write(
        `blindseal[scan-http]: ${result.verdict} (L${result.layer ?? '?'}) tool=${toolName} confidence=${result.confidence.toFixed(2)}\n`,
      );
    }

    await audit.settled();
    sendJson(res, 200, {
      verdict: result.verdict,
      layer: result.layer ?? null,
      detectedPatterns: noticePatterns(result),
      contentHash,
      ...(verbose
        ? {
            verbose: {
              warning: 'may contain input text',
              reasoning: result.reasoning,
              detectedPatterns: result.detectedPatterns,
              confidence: result.confidence,
              matchedId: result.matchedId,
              matchedCategory: result.matchedCategory,
              distance: result.distance,
              l3Status: result.l3Status,
              degraded: result.degraded === true,
            },
          }
        : {}),
    });
  });

  server.listen(opts.listenPort, opts.listenHost ?? '127.0.0.1', () => {
    process.stderr.write(
      `blindseal[scan-http]: listening on ${opts.listenHost ?? '127.0.0.1'}:${opts.listenPort}\n`,
    );
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void audit.shutdown();
      server.close(() => process.exit(0));
    });
  }

  return server;
}
