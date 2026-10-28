import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { loadConfig } from '../config.js';
import {
  TaintStore,
  TradeRateState,
  decideCapability,
  decideTradePolicy,
  isTrustedSource,
  mergeDecisions,
  type CapabilityConfig,
} from '../capability/index.js';
import {
  ManifestChecker,
  type InitializeResult,
  type ManifestVerdict,
  type ToolsListResult,
} from '../manifest/index.js';
import { createAuditLogger, screeningErrorEntry, screeningErrorResponse, type AuditLogger } from '../audit/index.js';
import { createScanStore, type ScanStore } from '../persistence/index.js';
import {
  buildCapabilityBlockedResponse,
  buildOutboundBlockedResponse,
  inspectToolCallArguments,
  inspectToolCallResponse,
  isToolCallResponse,
  responseText,
  type JsonRpcMessage,
  type ToolCallResult,
} from './shared.js';

function addResponseToTaint(
  msg: JsonRpcMessage & { result: ToolCallResult },
  toolName: string,
  taint: TaintStore,
  trusted: boolean,
): void {
  const content = responseText(msg.result);
  if (content.length > 0) taint.add({ toolName, content, addedAt: Date.now(), trusted });
}

function reportManifestVerdict(verdict: ManifestVerdict, mode: 'on' | 'strict'): void {
  const fp = verdict.fingerprint.fingerprint.slice(0, 12);
  const server = verdict.fingerprint.serverName ?? '<unnamed>';
  if (verdict.status === 'first-seen') {
    process.stderr.write(
      `blindseal: manifest first-seen for '${server}' (fp=${fp}, ${verdict.fingerprint.tools.length} tools)\n`,
    );
    return;
  }
  if (verdict.status === 'unchanged') {
    process.stderr.write(`blindseal: manifest unchanged for '${server}' (fp=${fp})\n`);
    return;
  }
  // drift
  process.stderr.write(
    `blindseal: MANIFEST DRIFT for '${server}' (fp=${fp}) — ${verdict.changes.length} change${verdict.changes.length === 1 ? '' : 's'}:\n`,
  );
  for (const c of verdict.changes) process.stderr.write(`blindseal:   - ${c}\n`);
  if (mode === 'strict') {
    process.stderr.write('blindseal: strict mode — exiting with code 3\n');
    process.exit(3);
  }
}

/// Build a stable reputation identifier from the upstream command + args. The naive
/// "stdio:<cmd>" collapses every npx-launched server into one bucket, making the on-chain
/// score useless. We append the first non-flag arg (typically the package name or module),
/// stripping path / extension if it's a filesystem path. Examples:
///   npx -y @modelcontextprotocol/server-filesystem /tmp → stdio:npx:@modelcontextprotocol/server-filesystem
///   uvx mcp-server-git                                  → stdio:uvx:mcp-server-git
///   python -m mcp_server_fs                             → stdio:python:mcp_server_fs
///   node /home/user/server.js                           → stdio:node:server
///   npx (bare, no args)                                 → stdio:npx
export function computeServerIdentifier(cmd: string, args: string[]): string {
  let target: string | undefined;
  for (const a of args) {
    if (typeof a !== 'string' || a.length === 0) continue;
    if (a.startsWith('-')) continue;
    target = a;
    break;
  }
  if (!target) return `stdio:${cmd}`;
  // Strip filesystem paths down to basename-without-extension. Scoped npm packages
  // (@scope/name) also contain '/' but should be preserved as-is — distinguish by leading '@'.
  const looksLikePath =
    !target.startsWith('@') &&
    (target.startsWith('/') ||
      target.startsWith('./') ||
      target.startsWith('../') ||
      target.includes('\\'));
  if (looksLikePath) {
    target = path.basename(target).replace(/\.[a-z]+$/i, '');
  }
  return `stdio:${cmd}:${target}`;
}

export function startProxy(cmd: string, args: string[]): void {
  const config = loadConfig();
  const serverIdentifier = computeServerIdentifier(cmd, args);
  const toolNameById = new Map<string | number, string>();
  const taint = new TaintStore(config.capability.windowSize);
  const tradeRate = new TradeRateState();
  const manifest =
    config.manifest.mode !== 'off' ? new ManifestChecker(cmd, args, config.manifest) : null;
  const audit: AuditLogger = createAuditLogger(config.audit);
  const scanStore: ScanStore = createScanStore(config.persistence);

  if (scanStore.enabled) {
    process.stderr.write(
      `blindseal: persisting scan history to ${scanStore.dbPath} (set BLINDSEAL_PERSIST=0 to disable)\n`,
    );
  }

  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });

  child.on('error', (err) => {
    process.stderr.write(`blindseal: failed to spawn ${cmd}: ${err.message}\n`);
    process.exit(1);
  });

  // Shutdown. The proxy mirrors the child's exit: a code is passed through, a signal is
  // re-raised on the proxy itself. Our own SIGINT/SIGTERM listeners are removed first — with
  // them still installed the re-raised signal was swallowed and the proxy never exited.
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  let finishing = false;
  /// The signal the proxy itself received: re-raised on exit even if the server had to be
  /// SIGKILLed, so the parent sees the signal it sent.
  let requested: NodeJS.Signals | null = null;
  const finish = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
    if (finishing) return;
    finishing = true;
    try { await audit.shutdown(); } catch { /* ignore */ }
    try { scanStore.close(); } catch { /* ignore */ }
    if (signal) {
      for (const [sig, h] of signalHandlers) process.removeListener(sig, h);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  };

  child.on('exit', (code, signal) => {
    void finish(code, requested ?? signal);
  });

  const childStdin = child.stdin;
  const childStdout = child.stdout;
  if (!childStdin || !childStdout) {
    process.stderr.write('blindseal: child stdio not piped\n');
    process.exit(1);
  }

  // agent → server: capability gate runs here. Sensitive tool calls whose args overlap
  // a tainted source get rewritten into a synthetic [BLINDSEAL_CAPABILITY_BLOCKED] response
  // and never reach the server.
  /// Gate ONE tools/call element. Returns the synthetic reply when it must not be forwarded.
  function gateToolCall(msg: JsonRpcMessage): JsonRpcMessage | null {
    if (msg.method !== 'tools/call' || msg.id == null) return null;
    const params = msg.params as { name?: unknown; arguments?: unknown } | undefined;
    const name = params && typeof params.name === 'string' ? params.name : null;
    if (!name) return null;
    // Outbound screen (L0 + L1) on the arguments before anything else sees them.
    const outbound = inspectToolCallArguments(name, params?.arguments, config.mode);
    if (outbound.verdict !== 'clean') {
      process.stderr.write(
        `blindseal: ${outbound.verdict} (L${outbound.layer ?? '?'}) arguments to '${name}' (mode=${config.mode}, ${outbound.action === 'block' ? 'not forwarded' : 'forwarded'})\n`,
      );
      if (audit.enabled) {
        audit.log({
          type: 'detection',
          direction: 'request',
          toolName: name,
          layer: outbound.layer ?? null,
          verdict: outbound.verdict,
          confidence: outbound.result?.confidence ?? 0,
          patterns: outbound.result?.detectedPatterns ?? [],
          mode: config.mode,
          mutated: outbound.action === 'block',
          reasoning: outbound.result?.reasoning,
          contentHash: outbound.argsHash,
          text: outbound.scannedText,
          transport: 'stdio',
          serverKey: serverIdentifier,
        });
      }
      if (outbound.action === 'block' && outbound.result) {
        return buildOutboundBlockedResponse(msg.id, name, outbound.result); // never forwarded
      }
    }

    toolNameById.set(msg.id, name);

    const decision = mergeDecisions(
      decideCapability(name, params?.arguments, taint, config.capability),
      decideTradePolicy(name, params?.arguments, taint, config.tradePolicy, tradeRate),
    );
    if (audit.enabled) {
      audit.log({
        type: 'capability',
        toolName: name,
        action: decision.action,
        matchedPattern: decision.matchedPattern,
        taintSources: (decision.taintSources ?? []).map((s) => s.toolName),
        reason: decision.reason,
        args: params?.arguments,
      });
    }
    if (decision.action === 'warn') {
      process.stderr.write(
        `blindseal: capability-warn tool '${name}' (${decision.matchedPattern ?? 'policy'}; reason in the encrypted audit store)\n`,
      );
    } else if (decision.action === 'block') {
      process.stderr.write(
        `blindseal: capability-block tool '${name}' (${decision.matchedPattern ?? 'policy'}; reason in the encrypted audit store)\n`,
      );
      toolNameById.delete(msg.id);
      return buildCapabilityBlockedResponse(
        msg.id,
        name,
        decision.reason ?? 'tainted args',
        (decision.taintSources ?? []).map((s) => s.toolName),
      ); // do NOT forward the original call to the child
    }
    return null;
  }

  // agent → server: outbound screen + capability gate run here, for a single message and for
  // every element of a JSON-RPC batch. Blocked calls are answered by the proxy and never reach
  // the server.
  const inRl = createInterface({ input: process.stdin });
  inRl.on('line', (line) => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { parsed = undefined; }
    if (Array.isArray(parsed)) {
      const replies: JsonRpcMessage[] = [];
      const forward: unknown[] = [];
      for (const el of parsed) {
        const reply = el && typeof el === 'object' && !Array.isArray(el) ? gateToolCall(el as JsonRpcMessage) : null;
        if (reply) replies.push(reply); else forward.push(el);
      }
      if (replies.length > 0) process.stdout.write(JSON.stringify(replies) + '\n');
      if (forward.length > 0) childStdin.write((replies.length > 0 ? JSON.stringify(forward) : line) + '\n');
      return;
    }
    if (parsed && typeof parsed === 'object') {
      const reply = gateToolCall(parsed as JsonRpcMessage);
      if (reply) {
        process.stdout.write(JSON.stringify(reply) + '\n');
        return;
      }
    }
    childStdin.write(line + '\n');
  });
  inRl.on('close', () => {
    childStdin.end();
  });

  // server → agent: detection runs here. After mutation (if any), the final content
  // is added to the taint store so subsequent capability checks can see it.
  /// Server → agent for ONE response element: manifest observation, then — for anything shaped
  /// like a tool-call result, whether or not its id matches a call we saw — screening, audit,
  /// persistence and taint. Returns what to send to the agent (a screening failure withholds it).
  async function screenResponseElement(msg: JsonRpcMessage): Promise<JsonRpcMessage> {
    if (manifest && msg.result && typeof msg.result === 'object') {
      const result = msg.result as Record<string, unknown>;
      if ('serverInfo' in result || 'protocolVersion' in result) {
        manifest.observeInitialize(result as InitializeResult);
      }
      if ('tools' in result && Array.isArray(result.tools)) {
        manifest.observeToolsList(result as ToolsListResult);
      }
      const verdict = manifest.finalizeIfReady();
      if (verdict) {
        reportManifestVerdict(
          verdict,
          config.manifest.mode === 'strict' ? 'strict' : 'on',
        );
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
    }

    if (!isToolCallResponse(msg)) return msg;
    const toolName =
      (msg.id != null ? toolNameById.get(msg.id) : undefined) ?? 'unknown';
    if (msg.id != null) toolNameById.delete(msg.id);

    let outcome: Awaited<ReturnType<typeof inspectToolCallResponse>>;
    try {
      outcome = await inspectToolCallResponse(msg, toolName, config.mode);
    } catch (err) {
      // Screening failed: record it and fail closed (the response is withheld).
      audit.log(screeningErrorEntry(msg, toolName, 'detection', err));
      return screeningErrorResponse(msg.id ?? null) as unknown as JsonRpcMessage;
    }
    if (outcome.verdict !== 'clean') {
      process.stderr.write(
        `blindseal: ${outcome.verdict} (L${outcome.layer ?? '?'}) response from '${toolName}' (mode=${config.mode}${outcome.mutated ? ', mutated' : ''}${outcome.degraded ? ', degraded' : ''})\n`,
      );
    }
    if (audit.enabled) {
      audit.log({
        ...(outcome.degraded ? { degraded: true } : {}),
        type: 'detection',
        toolName,
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
        transport: 'stdio',
        serverKey: serverIdentifier,
      });
    }
    if (scanStore.enabled) {
      const rawText = responseText(msg.result);
      try {
        scanStore.insert({
          serverKey: serverIdentifier,
          transport: 'stdio',
          toolName,
          verdict: outcome.verdict,
          layer: outcome.layer ?? null,
          confidence: outcome.result?.confidence ?? 0,
          patterns: outcome.result?.detectedPatterns ?? [],
          contentHash: outcome.contentHash,
          rawText,
          reasoning: outcome.result?.reasoning ?? null,
          mode: config.mode,
          mutated: outcome.mutated,
          degraded: outcome.degraded,
        });
      } catch (err) {
        process.stderr.write(`blindseal: persistence insert failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    if (config.capability.enabled || config.tradePolicy.enabled)
      addResponseToTaint(msg, toolName, taint, isTrustedSource(toolName, config.tradePolicy));
    return msg;
  }

  // server → agent: detection runs here, on single messages and on every element of a batch.
  // After mutation (if any), the final content is added to the taint store so subsequent
  // capability checks can see it.
  let chain: Promise<void> = Promise.resolve();
  const outRl = createInterface({ input: childStdout });
  outRl.on('line', (line) => {
    chain = chain.then(async () => {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { parsed = undefined; }
      if (Array.isArray(parsed)) {
        const out: unknown[] = [];
        for (const el of parsed) {
          out.push(el && typeof el === 'object' && !Array.isArray(el) ? await screenResponseElement(el as JsonRpcMessage) : el);
        }
        process.stdout.write(JSON.stringify(out) + '\n');
        return;
      }
      if (!parsed || typeof parsed !== 'object') {
        process.stdout.write(line + '\n');
        return;
      }
      process.stdout.write(JSON.stringify(await screenResponseElement(parsed as JsonRpcMessage)) + '\n');
    });
  });

  // SIGINT/SIGTERM: forward to the server and exit when it does (see finish above). A server
  // that ignores the signal is killed after CHILD_KILL_GRACE_MS so the proxy cannot hang.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    const h = () => {
      requested ??= sig;
      if (child.exitCode !== null || child.signalCode !== null) {
        void finish(null, sig);
        return;
      }
      child.kill(sig);
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, CHILD_KILL_GRACE_MS).unref();
    };
    signalHandlers.set(sig, h);
    process.on(sig, h);
  }
}

/// How long a wrapped server gets to exit after SIGINT/SIGTERM before it is SIGKILLed.
export const CHILD_KILL_GRACE_MS = 5000;

// Re-exported for tests.
export type { CapabilityConfig };
