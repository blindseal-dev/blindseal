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
  ManifestChecker,
  type InitializeResult,
  type ToolsListResult,
} from '../manifest/index.js';
import { createAuditLogger, screeningErrorEntry, screeningErrorResponse, type AuditLogger, type RecordedDecision } from '../audit/index.js';
import { createScanStore, type ScanStore } from '../persistence/index.js';
import {
  buildCapabilityBlockedResponse,
  buildOutboundBlockedResponse,
  inspectToolCallArguments,
  inspectToolCallResponse,
  isToolCallResponse,
  responseText,
  type InspectionOutcome,
  type JsonRpcMessage,
  type ToolCallResult,
} from './shared.js';
import { serializeSseEvent, streamScanSse } from './sse-scan.js';

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
  const manifest =
    config.manifest.mode !== 'off' ? new ManifestChecker('http', [opts.upstream], config.manifest) : null;
  const audit: AuditLogger = createAuditLogger(config.audit);
  const scanStore: ScanStore = createScanStore(config.persistence);

  if (scanStore.enabled) {
    process.stderr.write(
      `blindseal: persisting scan history to ${scanStore.dbPath} (set BLINDSEAL_PERSIST=0 to disable)\n`,
    );
  }

  const upstreamUrl = opts.upstream;

  /// Agent → server gate for ONE tools/call element: outbound L0/L1 screen on the arguments,
  /// then the capability / trade gate. Returns the synthetic reply when the call must not be
  /// forwarded, null when it may go upstream.
  /// An id-less tools/call (a notification) is gated the same way; blocked, it is dropped
  /// ('drop': there is no id to answer).
  function gateToolCall(msg: JsonRpcMessage, toolName: string, toolArgs: unknown): JsonRpcMessage | 'drop' | null {
    const id = msg.id;
    const outbound = inspectToolCallArguments(toolName, toolArgs, config.mode);
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
          serverKey: upstreamUrl,
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
        decision.reason ?? 'tainted args',
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

  /// Audit + persistence + taint for one screened tool-call response.
  function recordScreened(
    scannedMsg: JsonRpcMessage & { result: ToolCallResult },
    scannedTool: string,
    outcome: InspectionOutcome,
    transport: 'http' | 'sse',
  ): void {
    if (outcome.verdict !== 'clean') {
      process.stderr.write(
        `blindseal[${transport === 'sse' ? 'http/sse' : 'http'}]: ${outcome.verdict} (L${outcome.layer ?? '?'}) from '${scannedTool}' (mode=${config.mode}${outcome.mutated ? ', mutated' : ''}${outcome.degraded ? ', degraded' : ''})\n`,
      );
    }
    let recorded: RecordedDecision | null = null;
    if (audit.enabled) {
      recorded = audit.log({
        ...(outcome.degraded ? { degraded: true } : {}),
        type: 'detection',
        toolName: scannedTool,
        layer: outcome.layer ?? null,
        verdict: outcome.verdict,
        confidence: outcome.result?.confidence ?? 0,
        patterns: outcome.result?.detectedPatterns ?? [],
        mode: config.mode,
        mutated: outcome.mutated,
        reasoning: outcome.result?.reasoning,
        contentHash: outcome.contentHash,
        text: outcome.scannedText,
        l3Status: outcome.result?.l3Status,
        transport,
        serverKey: upstreamUrl,
      });
    }
    if (scanStore.enabled) {
      try {
        scanStore.insert({
          serverKey: upstreamUrl,
          transport,
          toolName: scannedTool,
          verdict: outcome.verdict,
          layer: outcome.layer ?? null,
          confidence: outcome.result?.confidence ?? 0,
          patterns: outcome.result?.detectedPatterns ?? [],
          contentHash: outcome.contentHash,
          decisionId: recorded?.decisionId ?? null,
          mode: config.mode,
          mutated: outcome.mutated,
          degraded: outcome.degraded,
        });
      } catch (err) {
        process.stderr.write(`blindseal: persistence insert failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    if (config.capability.enabled || config.tradePolicy.enabled) {
      const content = responseText(scannedMsg.result);
      if (content.length > 0) {
        taint.add({ toolName: scannedTool, content, addedAt: Date.now(), trusted: isTrustedSource(scannedTool, config.tradePolicy) });
      }
    }
  }

  function observeManifest(respMsg: JsonRpcMessage): void {
    if (!manifest) return;
    const result = respMsg.result as Record<string, unknown> | undefined;
    if (!result || typeof result !== 'object') return;
    if ('serverInfo' in result || 'protocolVersion' in result) {
      manifest.observeInitialize(result as InitializeResult);
    }
    if ('tools' in result && Array.isArray(result.tools)) {
      manifest.observeToolsList(result as ToolsListResult);
    }
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

  /// Server → agent for ONE JSON-RPC response element. Every element shaped like a tool-call
  /// result is screened — matched to its request by id, and screened as 'unknown' when no
  /// tools/call with that id was seen (a mismatched id must not be a way around screening).
  /// A screening failure withholds that element only (fail closed).
  async function screenResponseElement(
    respMsg: JsonRpcMessage,
    toolNameById: Map<string | number, string>,
    transport: 'http' | 'sse',
  ): Promise<JsonRpcMessage> {
    observeManifest(respMsg);
    if (!isToolCallResponse(respMsg)) return respMsg;
    const toolName = (respMsg.id != null ? toolNameById.get(respMsg.id) : undefined) ?? 'unknown';
    let outcome: InspectionOutcome;
    try {
      outcome = await inspectToolCallResponse(respMsg, toolName, config.mode);
    } catch (err) {
      audit.log(screeningErrorEntry(respMsg, toolName, transport === 'sse' ? 'sse' : 'detection', err));
      return screeningErrorResponse(respMsg.id ?? null) as unknown as JsonRpcMessage;
    }
    recordScreened(respMsg, toolName, outcome, transport);
    return respMsg;
  }

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      sendJson(res, 200, { ok: true, upstream: upstreamUrl });
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
    try { parsedReq = JSON.parse(reqText); } catch { parsedReq = undefined; }
    const isBatch = Array.isArray(parsedReq);
    const elements: unknown[] = isBatch ? (parsedReq as unknown[]) : parsedReq !== undefined ? [parsedReq] : [];
    const toolNameById = new Map<string | number, string>();
    const synthetic: JsonRpcMessage[] = [];
    const forwarded: unknown[] = [];
    let dropped = 0;
    for (const el of elements) {
      const m = el && typeof el === 'object' && !Array.isArray(el) ? (el as JsonRpcMessage) : null;
      if (m && m.method === 'tools/call') {
        const params = m.params as { name?: unknown; arguments?: unknown } | undefined;
        if (params && typeof params.name === 'string') {
          const reply = gateToolCall(m, params.name, params.arguments);
          if (reply === 'drop') { dropped++; continue; }
          if (reply) { synthetic.push(reply); continue; }
          if (m.id != null) toolNameById.set(m.id, params.name);
        }
      }
      forwarded.push(el);
    }

    // Everything was answered by the proxy: nothing goes upstream.
    if (elements.length > 0 && forwarded.length === 0) {
      if (synthetic.length === 0) { res.writeHead(202); res.end(); return; } // only dropped notifications
      sendJson(res, 200, isBatch ? synthetic : synthetic[0]);
      return;
    }
    const forwardBody = synthetic.length === 0 && dropped === 0 ? reqText : JSON.stringify(isBatch ? forwarded : forwarded[0]);

    // Forward to upstream.
    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...forwardableHeaders(req.headers) },
        body: forwardBody,
      });
    } catch (err) {
      process.stderr.write(`blindseal[http]: upstream fetch failed: ${err}\n`);
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
          {
            toolName: null,
            toolNameFor: (id) => (id != null ? toolNameById.get(id) : undefined),
            mode: config.mode,
            async onScanned(scannedMsg, scannedTool, outcome) {
              recordScreened(scannedMsg, scannedTool, outcome, 'sse');
            },
            onScreeningError(msg, scannedTool, err) {
              audit.log(screeningErrorEntry(msg, scannedTool, 'sse', err));
            },
          },
          (chunk) => {
            res.write(chunk);
          },
        );
      } catch (err) {
        process.stderr.write(`blindseal[http/sse]: stream scan failed: ${err}\n`);
        audit.log({ type: 'error', toolName: [...toolNameById.values()][0] ?? 'unknown', stage: 'sse', error: err instanceof Error ? err.message : String(err) });
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
    try { parsedResp = JSON.parse(respText); } catch { parsedResp = undefined; }
    if (parsedResp === undefined || parsedResp === null || typeof parsedResp !== 'object') {
      if (synthetic.length > 0) {
        // Upstream sent nothing parseable (e.g. 202 for notifications) but the proxy answered
        // blocked elements itself: those answers must still reach the agent.
        sendJson(res, 200, isBatch ? synthetic : synthetic[0]);
        return;
      }
      // Not JSON-RPC — pass through verbatim.
      res.writeHead(upstreamResp.status, { 'Content-Type': upstreamCT || 'application/json' });
      res.end(respText);
      return;
    }

    let out: unknown;
    if (Array.isArray(parsedResp)) {
      const screened: unknown[] = [];
      for (const el of parsedResp) {
        screened.push(el && typeof el === 'object' && !Array.isArray(el)
          ? await screenResponseElement(el as JsonRpcMessage, toolNameById, 'http')
          : el);
      }
      out = [...synthetic, ...screened];
    } else {
      const one = await screenResponseElement(parsedResp as JsonRpcMessage, toolNameById, 'http');
      out = synthetic.length > 0 ? [...synthetic, one] : one;
    }

    const payload = JSON.stringify(out);
    res.writeHead(upstreamResp.status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload).toString(),
    });
    res.end(payload);
  });

  server.listen(opts.listenPort, opts.listenHost ?? '127.0.0.1', () => {
    process.stderr.write(
      `blindseal[http]: listening on ${opts.listenHost ?? '127.0.0.1'}:${opts.listenPort} → ${upstreamUrl}\n`,
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
