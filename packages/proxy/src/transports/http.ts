/// HTTP / Streamable-HTTP MCP transport.
/// Listens locally, forwards every POST to a configured upstream MCP URL, scans responses with
/// the same detection pipeline + capability gate + manifest checker + audit as the stdio
/// path. Both single-shot JSON responses and Server-Sent Event streams are scanned: SSE events
/// are parsed at event boundaries, JSON-RPC tool-call responses are inspected, mutated if needed,
/// then re-serialized into the SSE stream.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { loadConfig } from '../config.js';
import {
  TaintStore,
  TradeRateState,
  decideCapability,
  decideTradePolicy,
  isTrustedSource,
  mergeDecisions,
} from '../capability/index.js';
import {
  openManifestChecker,
  type InitializeResult,
  type ToolsListResult,
} from '../manifest/index.js';
import { createAuditLogger, screeningErrorEntry, type AuditLogger, type RecordedDecision } from '../audit/index.js';
import { createScanStore, type ScanStore } from '../persistence/index.js';
import {
  buildCapabilityBlockedResponse,
  buildOutboundBlockedResponse,
  inspectToolCallArguments,
  responseText,
  type JsonRpcMessage,
} from './shared.js';
import { serializeSseEvent, streamScanSse } from './sse-scan.js';
import { inboundProblem, invalidRequestReply, isPlainObject, parseErrorReply, parseJson, PendingRequests, requestScreeningErrorReply, screenServerMessage } from './reply-screen.js';
import { displayUrl, httpServerIdentifier } from './server-id.js';

export interface HttpProxyOptions {
  upstream: string;
  listenPort: number;
  listenHost?: string;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

function forwardableHeaders(src: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.join(', ');
  }
  return out;
}

async function readBody(req: IncomingMessage, maxBytes = 5 * 1024 * 1024): Promise<Buffer> {
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

export function startHttpProxy(opts: HttpProxyOptions): Server {
  const config = loadConfig();
  const taint = new TaintStore(config.capability.windowSize);
  const tradeRate = new TradeRateState();
  const manifest = openManifestChecker('http', [opts.upstream], config.manifest);
  const audit: AuditLogger = createAuditLogger(config.audit);
  const scanStore: ScanStore = createScanStore(config.persistence);

  if (scanStore.enabled) {
    process.stderr.write(
      `blindseal: persisting scan history to ${scanStore.dbPath} (set BLINDSEAL_PERSIST=0 to disable)\n`,
    );
  }

  const upstreamUrl = opts.upstream;
  /// What is recorded and printed for this upstream: never the URL itself (it can carry a token).
  const serverId = httpServerIdentifier(upstreamUrl);

  /// Agent → server gate for ONE tools/call element: outbound L0/L1 screen on the arguments,
  /// then the capability / trade gate. Returns the synthetic reply when the call must not be
  /// forwarded, null when it may go upstream.
  /// An id-less tools/call (a notification) is gated the same way; blocked, it is dropped
  /// ('drop': there is no id to answer).
  async function gateToolCall(msg: JsonRpcMessage, toolName: string, toolArgs: unknown): Promise<JsonRpcMessage | 'drop' | null> {
    const id = msg.id;
    const outbound = await inspectToolCallArguments(toolName, toolArgs, config.mode);
    if (outbound.verdict !== 'clean') {
      process.stderr.write(
        `blindseal[http]: ${outbound.verdict} (L${outbound.layer ?? '?'}) arguments to '${toolName}' (mode=${config.mode}, ${outbound.action === 'block' ? 'not forwarded' : 'forwarded'})\n`,
      );
      if (audit.enabled) {
        audit.log({
          type: 'detection',
          direction: 'request',
          toolName,
          layer: outbound.layer ?? null,
          verdict: outbound.verdict,
          confidence: outbound.result?.confidence ?? 0,
          patterns: outbound.result?.detectedPatterns ?? [],
          mode: config.mode,
          mutated: outbound.action === 'block',
          reasoning: outbound.result?.reasoning,
          contentHash: outbound.argsHash,
          text: outbound.scannedText,
          transport: 'http',
          serverKey: serverId,
        });
      }
      if (outbound.action === 'block' && outbound.result) {
        return id == null ? 'drop' : buildOutboundBlockedResponse(id, toolName, outbound.result); // never forwarded
      }
    }

    const decision = mergeDecisions(
      decideCapability(toolName, toolArgs, taint, config.capability),
      decideTradePolicy(toolName, toolArgs, taint, config.tradePolicy, tradeRate),
    );
    if (audit.enabled) {
      audit.log({
        type: 'capability',
        toolName,
        action: decision.action,
        matchedPattern: decision.matchedPattern,
        taintSources: (decision.taintSources ?? []).map((s) => s.toolName),
        reason: decision.reason,
        args: toolArgs,
      });
    }
    if (decision.action === 'block') {
      process.stderr.write(
        `blindseal[http]: capability-block tool '${toolName}' (${decision.matchedPattern ?? 'policy'}; reason in the encrypted audit store)\n`,
      );
      if (id == null) return 'drop';
      return buildCapabilityBlockedResponse(
        id,
        toolName,
        decision.matchedPattern,
        (decision.taintSources ?? []).map((s) => s.toolName),
      );
    }
    if (decision.action === 'warn') {
      process.stderr.write(
        `blindseal[http]: capability-warn tool '${toolName}' (${decision.matchedPattern ?? 'policy'}; reason in the encrypted audit store)\n`,
      );
    }
    return null;
  }

  function observeManifest(method: string, result: unknown): void {
    if (!manifest) return;
    if (method === 'initialize') manifest.observeInitialize(result as InitializeResult);
    else if (method === 'tools/list') manifest.observeToolsList(result as ToolsListResult);
    else return;
    const verdict = manifest.finalizeIfReady();
    if (!verdict) return;
    const fp = verdict.fingerprint.fingerprint.slice(0, 12);
    if (verdict.status === 'drift') {
      process.stderr.write(
        `blindseal[http]: MANIFEST DRIFT (fp=${fp}, ${verdict.changes.length} changes)\n`,
      );
      for (const c of verdict.changes) process.stderr.write(`blindseal[http]:   - ${c}\n`);
      if (config.manifest.mode === 'strict') process.exit(3);
    }
    if (audit.enabled) {
      audit.log({
        type: 'manifest',
        serverKey: verdict.serverKey,
        fingerprint: verdict.fingerprint.fingerprint,
        status: verdict.status,
        changes: verdict.changes,
      });
    }
  }

  /// Server → agent for ONE JSON-RPC element (JSON body or SSE event): matched to the request it
  /// answers, validated and screened (reply-screen.ts), then audit, persistence and taint.
  /// Returns what the agent may receive, or null to drop it.
  /// Screens one server element; the decision's audit record is stored before it is answered.
  async function screenServerElement(...args: Parameters<typeof screenElement>): ReturnType<typeof screenElement> {
    const out = await screenElement(...args);
    await audit.settled();
    return out;
  }
  async function screenElement(
    el: unknown,
    pending: PendingRequests,
    transport: 'http' | 'sse',
  ): Promise<Record<string, unknown> | null> {
    const tag = transport === 'sse' ? 'http/sse' : 'http';
    const s = await screenServerMessage(el, pending, config.mode);
    if (s.error !== undefined) {
      audit.log(screeningErrorEntry(isPlainObject(el) ? el : {}, s.label, transport === 'sse' ? 'sse' : 'detection', s.error));
      process.stderr.write(`blindseal[${tag}]: screening failed for '${s.label}'; ${s.forward ? 'reply withheld' : 'message dropped'}\n`);
      return s.forward;
    }
    if (s.problem) {
      process.stderr.write(`blindseal[${tag}]: ${s.forward ? 'blocked' : 'dropped'} a server ${s.kind} (${s.problem})\n`);
      if (audit.enabled) audit.log({ type: 'error', toolName: s.label, stage: 'reply-shape', error: s.problem });
      return s.forward;
    }
    const outcome = s.outcome!;
    if (s.kind === 'reply' && s.pending && outcome.verdict === 'clean' && isPlainObject(el) && 'result' in el) {
      // A malformed initialize/tools/list result must not take the proxy down.
      try {
        observeManifest(s.pending.method, el.result);
      } catch (err) {
        process.stderr.write(`blindseal[http]: manifest check skipped (${err instanceof Error ? err.message : String(err)})\n`);
      }
    }
    if (outcome.verdict !== 'clean') {
      process.stderr.write(
        `blindseal[${tag}]: ${outcome.verdict} (L${outcome.layer ?? '?'}) ${s.kind} from '${s.label}' (mode=${config.mode}${s.mutated ? (s.forward ? ', replaced' : ', dropped') : ''}${outcome.degraded ? ', degraded' : ''})\n`,
      );
    }
    // Every tools/call reply is a decision on the record; other messages only when flagged.
    const isToolReply = s.kind === 'reply' && s.pending?.method === 'tools/call';
    if (!isToolReply && outcome.verdict === 'clean') return s.forward;
    let recorded: RecordedDecision | null = null;
    if (audit.enabled) {
      recorded = audit.log({
        ...(outcome.degraded ? { degraded: true } : {}),
        type: 'detection',
        toolName: s.label,
        layer: outcome.layer ?? null,
        verdict: outcome.verdict,
        confidence: outcome.result?.confidence ?? 0,
        patterns: outcome.result?.detectedPatterns ?? [],
        mode: config.mode,
        mutated: s.mutated,
        reasoning: outcome.result?.reasoning,
        contentHash: outcome.contentHash,
        text: outcome.scannedText,
        l3Status: outcome.result?.l3Status,
        transport,
        serverKey: serverId,
      });
    }
    if (scanStore.enabled) {
      try {
        scanStore.insert({
          serverKey: serverId,
          transport,
          toolName: s.label,
          verdict: outcome.verdict,
          layer: outcome.layer ?? null,
          confidence: outcome.result?.confidence ?? 0,
          patterns: outcome.result?.detectedPatterns ?? [],
          contentHash: outcome.contentHash,
          decisionId: recorded?.decisionId ?? null,
          mode: config.mode,
          mutated: s.mutated,
          degraded: outcome.degraded,
        });
      } catch (err) {
        process.stderr.write(`blindseal: persistence insert failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    if (isToolReply && s.forward && (config.capability.enabled || config.tradePolicy.enabled)) {
      const content = responseText(s.forward.result);
      if (content.length > 0) {
        taint.add({ toolName: s.label, content, addedAt: Date.now(), trusted: isTrustedSource(s.label, config.tradePolicy) });
      }
    }
    return s.forward;
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      // Fail closed: nothing from this exchange reaches the agent, and the server keeps running.
      process.stderr.write(`blindseal[http]: request failed (${err instanceof Error ? err.message : String(err)})\n`);
      if (!res.headersSent) sendJson(res, 500, { error: 'proxy error' });
      else res.destroy();
    });
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    let bodyBuf: Buffer;
    try {
      bodyBuf = await readBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'body read failed' });
      return;
    }

    // Parse as a JSON-RPC request or a JSON-RPC BATCH (array). Every tools/call element is
    // screened and gated on its own; a blocked element is answered by the proxy and removed
    // from what is forwarded.
    const reqText = bodyBuf.toString('utf8');
    let parsedReq: unknown;
    try { parsedReq = parseJson(reqText); } catch { parsedReq = undefined; }
    if (!isPlainObject(parsedReq) && !Array.isArray(parsedReq)) {
      // Not something the gate can screen (not JSON, too deeply nested to parse, a bare value):
      // never forwarded raw. The proxy answers as a JSON-RPC server would.
      sendJson(res, 400, parseErrorReply());
      return;
    }
    const isBatch = Array.isArray(parsedReq);
    const elements: unknown[] = isBatch ? (parsedReq as unknown[]) : parsedReq !== undefined ? [parsedReq] : [];
    /// Requests in this POST waiting for a reply; anything else the upstream answers is dropped.
    const pending = new PendingRequests();
    const synthetic: JsonRpcMessage[] = [];
    const forwarded: unknown[] = [];
    let dropped = 0;
    for (const el of elements) {
      const problem = inboundProblem(el);
      if (problem) {
        process.stderr.write(`blindseal[http]: refused an agent message (${problem}); not forwarded\n`);
        if (isPlainObject(el) && !('id' in el)) { dropped++; continue; }
        synthetic.push(invalidRequestReply(isPlainObject(el) ? el.id : undefined, problem) as JsonRpcMessage);
        continue;
      }
      const m = el as JsonRpcMessage;
      if (m.method === 'tools/call') {
        const params = m.params as { name?: unknown; arguments?: unknown } | undefined;
        if (params && typeof params.name === 'string') {
          let reply: JsonRpcMessage | 'drop' | null;
          try {
            reply = await gateToolCall(m, params.name, params.arguments);
          } catch (err) {
            // Fail closed: arguments the gate cannot serialise (e.g. nested too deeply) are not forwarded.
            process.stderr.write(`blindseal[http]: request screening failed (${err instanceof Error ? err.message : String(err)}); not forwarded\n`);
            reply = m.id == null ? 'drop' : (requestScreeningErrorReply(m.id) as JsonRpcMessage);
          }
          if (reply === 'drop') { dropped++; continue; }
          if (reply) { synthetic.push(reply); continue; }
        }
      }
      pending.track(el);
      forwarded.push(el);
    }

    await audit.settled(); // decisions are on record before anything is answered or forwarded
    // Everything was answered by the proxy: nothing goes upstream.
    if (elements.length > 0 && forwarded.length === 0) {
      if (synthetic.length === 0) { res.writeHead(202); res.end(); return; } // only dropped notifications
      sendJson(res, 200, isBatch ? synthetic : synthetic[0]);
      return;
    }
    // Re-serialised from what the gate screened.
    const forwardBody = JSON.stringify(isBatch ? forwarded : forwarded[0]);

    // Forward to upstream.
    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...forwardableHeaders(req.headers) },
        body: forwardBody,
      });
    } catch (err) {
      process.stderr.write(`blindseal[http]: upstream fetch failed: ${(err instanceof Error ? err.message : String(err)).split(upstreamUrl).join(displayUrl(upstreamUrl))}\n`);
      sendJson(res, 502, { error: 'upstream fetch failed' });
      return;
    }

    const upstreamCT = upstreamResp.headers.get('content-type') ?? '';
    // SSE streaming: parse each event and scan tool-call responses inline.
    if (upstreamCT.includes('text/event-stream')) {
      const headers: Record<string, string> = {};
      upstreamResp.headers.forEach((v, k) => {
        if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
      });
      res.writeHead(upstreamResp.status, headers);
      // The proxy's own replies to blocked batch elements go first, as one SSE event.
      if (synthetic.length > 0) res.write(serializeSseEvent(['event: message'], JSON.stringify(isBatch ? synthetic : synthetic[0])));
      if (!upstreamResp.body) {
        res.end();
        return;
      }
      try {
        await streamScanSse(
          upstreamResp.body,
          { screen: (el) => screenServerElement(el, pending, 'sse') },
          (chunk) => {
            res.write(chunk);
          },
        );
      } catch (err) {
        process.stderr.write(`blindseal[http/sse]: stream scan failed: ${err}\n`);
        audit.log({ type: 'error', toolName: 'unknown', stage: 'sse', error: err instanceof Error ? err.message : String(err) });
      }
      res.end();
      return;
    }

    // JSON path: scan + mutate as needed.
    let respText: string;
    try {
      respText = await upstreamResp.text();
    } catch (err) {
      sendJson(res, 502, { error: 'upstream read failed' });
      return;
    }

    let parsedResp: unknown;
    try { parsedResp = parseJson(respText); } catch { parsedResp = undefined; }
    if (!isPlainObject(parsedResp) && !Array.isArray(parsedResp)) {
      if (synthetic.length > 0) {
        // Upstream sent nothing usable (e.g. 202 for notifications) but the proxy answered
        // blocked elements itself: those answers must still reach the agent.
        sendJson(res, 200, isBatch ? synthetic : synthetic[0]);
        return;
      }
      if (respText.trim() === '') {
        // An empty body (202 Accepted for notifications) carries nothing to screen.
        res.writeHead(upstreamResp.status);
        res.end();
        return;
      }
      // Anything else that is not a JSON-RPC object or batch never reaches the agent.
      process.stderr.write('blindseal[http]: dropped an upstream body that is not a JSON-RPC message\n');
      sendJson(res, 502, { error: 'upstream reply was not a JSON-RPC message' });
      return;
    }

    const screened: unknown[] = [];
    for (const el of Array.isArray(parsedResp) ? parsedResp : [parsedResp]) {
      const r = await screenServerElement(el, pending, 'http');
      if (r) screened.push(r);
    }
    const all = [...synthetic, ...screened];
    if (all.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    const out: unknown = isBatch || Array.isArray(parsedResp) || all.length > 1 ? all : all[0];

    const payload = JSON.stringify(out);
    res.writeHead(upstreamResp.status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload).toString(),
    });
    res.end(payload);
  }

  server.listen(opts.listenPort, opts.listenHost ?? '127.0.0.1', () => {
    process.stderr.write(
      `blindseal[http]: listening on ${opts.listenHost ?? '127.0.0.1'}:${opts.listenPort} → ${displayUrl(upstreamUrl)}\n`,
    );
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void audit.shutdown();
      try { scanStore.close(); } catch { /* ignore */ }
      server.close(() => process.exit(0));
    });
  }

  return server;
}

export function isJsonRpcMessage(_m: unknown): _m is JsonRpcMessage {
  return true; // re-export guard, mostly for tests
}
