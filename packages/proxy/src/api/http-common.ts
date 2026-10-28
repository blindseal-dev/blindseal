/// HTTP plumbing shared by the local API servers (live: live-server.ts, sample data:
/// mock-server.ts): bearer auth, JSON replies, the dashboard static server with its CSP, and a
/// minimal server→client WebSocket.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.map': 'application/json', '.txt': 'text/plain',
};
/// Zero-egress by construction: only our origin (plus the WS back to it). `wasm-unsafe-eval` is
/// what lets the browser compile the verifier module under a CSP; no `unsafe-eval`.
const DASHBOARD_CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:", "font-src 'self'", "connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*",
  "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'",
].join('; ');

export function serveDashboard(res: ServerResponse, dist: string, pathname: string): boolean {
  // Runs before bearer auth, so nothing here may throw: a bad percent-encoding is a 400 and a
  // file-system error a 404, never an exception out of the request handler.
  let rel: string;
  try {
    rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request: malformed path encoding');
    return true;
  }
  if (rel.includes('\0')) return false;
  let file = path.normalize(path.join(dist, rel));
  if (!file.startsWith(path.normalize(dist + path.sep)) && file !== path.normalize(dist)) return false;
  let body: Buffer;
  try {
    if (!isFile(file)) file = path.join(dist, 'index.html'); // SPA (HashRouter) fallback; also directories
    if (!isFile(file)) return false;
    body = readFileSync(file);
  } catch {
    return false;
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type, 'content-length': body.length, 'content-security-policy': DASHBOARD_CSP,
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  res.end(body);
  return true;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/// Wraps a request handler so nothing it throws can take the server down: these servers answer
/// some paths before bearer auth, so an unauthenticated local request must never end the process.
export function guarded(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<unknown> | unknown,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const fail = (e: unknown) => {
      if (res.headersSent) return void res.destroy();
      const bad = e instanceof URIError || (e as { code?: string })?.code === 'ERR_INVALID_URL';
      sendErr(res, bad ? 400 : 500, bad ? 'BAD_REQUEST' : 'INTERNAL', bad ? 'malformed request path' : 'internal error');
    };
    try {
      Promise.resolve(handler(req, res)).catch(fail);
    } catch (e) {
      fail(e);
    }
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}
export function sendErr(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

export function bearerOk(req: IncomingMessage, token: string, url: URL): boolean {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth === `Bearer ${token}`) return true;
  // WS/browser convenience: ?token= on the query
  if (url.searchParams.get('token') === token) return true;
  return false;
}

export async function readBody(req: IncomingMessage): Promise<any> {
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
export function wsAccept(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}
export function wsFrame(text: string): Buffer {
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

