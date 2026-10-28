import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
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
  openManifestChecker,
  type InitializeResult,
  type ManifestVerdict,
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
import { inboundProblem, invalidRequestReply, isPlainObject, parseErrorReply, parseJson, PendingRequests, requestScreeningErrorReply, screenServerMessage } from './reply-screen.js';
import { computeServerIdentifier } from './server-id.js';

function addResponseToTaint(
  msg: Record<string, unknown>,
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

export { computeServerIdentifier } from './server-id.js';

export function startProxy(cmd: string, args: string[]): void {
  const config = loadConfig();
  const serverIdentifier = computeServerIdentifier(cmd, args);
  /// Agent requests waiting for a reply; a server reply that answers none of them is dropped.
  const pending = new PendingRequests();
  const taint = new TaintStore(config.capability.windowSize);
  const tradeRate = new TradeRateState();
  const manifest = openManifestChecker(cmd, args, config.manifest);
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
  /// An id-less tools/call (a notification) is screened and gated the same way; when blocked it
  /// is dropped ('drop': nothing to reply to) instead of answered.
  async function gateToolCall(msg: JsonRpcMessage): Promise<JsonRpcMessage | 'drop' | null> {
    if (msg.method !== 'tools/call') return null;
    const params = msg.params as { name?: unknown; arguments?: unknown } | undefined;
    const name = params && typeof params.name === 'string' ? params.name : null;
    if (!name) return null;
    // Outbound screen (L0 + L1) on the arguments before anything else sees them.
    const outbound = await inspectToolCallArguments(name, params?.arguments, config.mode);
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
        return msg.id == null ? 'drop' : buildOutboundBlockedResponse(msg.id, name, outbound.result); // never forwarded
      }
    }

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
      if (msg.id == null) return 'drop';
      return buildCapabilityBlockedResponse(
        msg.id,
        name,
        decision.matchedPattern,
        (decision.taintSources ?? []).map((s) => s.toolName),
      ); // do NOT forward the original call to the child
    }
    return null;
  }

  // agent → server: outbound screen + capability gate run here, for a single message and for
  // every element of a JSON-RPC batch. Blocked calls are answered by the proxy and never reach
  // the server. What is forwarded is re-serialised from the parsed value the gate screened, so a
  // server that resolves duplicate keys differently cannot see arguments the gate did not.
  const inRl = createInterface({ input: process.stdin });
  // Lines are handled one at a time, in order (screening is async: it runs in the scan worker).
  let inChain: Promise<void> = Promise.resolve();
  inRl.on('line', (line) => {
    inChain = inChain.then(() => handleAgentLine(line)).catch((err) => {
      process.stderr.write(`blindseal: agent message handling failed (${err instanceof Error ? err.message : String(err)}); not forwarded\n`);
    });
  });
  async function handleAgentLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let parsed: unknown;
    try { parsed = parseJson(line); } catch { parsed = undefined; }
    if (!isPlainObject(parsed) && !Array.isArray(parsed)) {
      // Not something the gate can screen (not JSON, too deeply nested to parse, a bare value):
      // never forwarded raw. The proxy answers as a JSON-RPC server would.
      process.stdout.write(JSON.stringify(parseErrorReply()) + '\n');
      return;
    }
    /// Gate one element; a gate that throws (e.g. arguments nested too deeply to serialise)
    /// fails closed: the call is answered with an error and never forwarded.
    const gate = async (el: unknown): Promise<JsonRpcMessage | 'drop' | null> => {
      const problem = inboundProblem(el);
      if (problem) {
        process.stderr.write(`blindseal: refused an agent message (${problem}); not forwarded\n`);
        const id = isPlainObject(el) ? el.id : undefined;
        return isPlainObject(el) && !('id' in el) ? 'drop' : (invalidRequestReply(id, problem) as JsonRpcMessage);
      }
      try {
        return await gateToolCall(el as JsonRpcMessage);
      } catch (err) {
        process.stderr.write(`blindseal: request screening failed (${err instanceof Error ? err.message : String(err)}); not forwarded\n`);
        const id = (el as JsonRpcMessage).id;
        return id == null ? 'drop' : requestScreeningErrorReply(id);
      }
    };
    if (Array.isArray(parsed)) {
      const replies: JsonRpcMessage[] = [];
      const forward: unknown[] = [];
      for (const el of parsed) {
        const reply = await gate(el);
        if (reply === 'drop') continue;
        if (reply) replies.push(reply); else { pending.track(el); forward.push(el); }
      }
      await audit.settled(); // decisions are on record before anything is answered or forwarded
      if (replies.length > 0) process.stdout.write(JSON.stringify(replies) + '\n');
      if (forward.length > 0) childStdin.write(JSON.stringify(forward) + '\n');
      return;
    }
    const reply = await gate(parsed);
    await audit.settled();
    if (reply === 'drop') return;
    if (reply) {
      process.stdout.write(JSON.stringify(reply) + '\n');
      return;
    }
    pending.track(parsed);
    childStdin.write(JSON.stringify(parsed) + '\n');
  }
  inRl.on('close', () => {
    // After the lines still being screened have been forwarded.
    void inChain.then(() => childStdin.end());
  });

  // server → agent. Every message the server writes is parsed, matched to the agent request it
  // answers, validated and screened (reply-screen.ts); the agent receives only what
  // screenServerMessage returns, re-serialised from the screened value. Lines that are not a
  // JSON-RPC object or batch never reach the agent.
  function observeManifest(method: string, result: unknown): void {
    if (!manifest) return;
    if (method === 'initialize') manifest.observeInitialize(result as InitializeResult);
    else if (method === 'tools/list') manifest.observeToolsList(result as ToolsListResult);
    else return;
    const verdict = manifest.finalizeIfReady();
    if (!verdict) return;
    reportManifestVerdict(verdict, config.manifest.mode === 'strict' ? 'strict' : 'on');
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

  /// One server → agent element. Returns what to send to the agent, or null to drop it.
  /// Screens one server element; the decision's audit record is stored before it is answered.
  async function screenServerElement(...args: Parameters<typeof screenElement>): ReturnType<typeof screenElement> {
    const out = await screenElement(...args);
    await audit.settled();
    return out;
  }
  async function screenElement(el: unknown): Promise<Record<string, unknown> | null> {
    const s = await screenServerMessage(el, pending, config.mode);
    if (s.error !== undefined) {
      audit.log(screeningErrorEntry(isPlainObject(el) ? el : {}, s.label, 'detection', s.error));
      process.stderr.write(`blindseal: screening failed for '${s.label}'; ${s.forward ? 'reply withheld' : 'message dropped'}\n`);
      return s.forward;
    }
    if (s.problem) {
      process.stderr.write(`blindseal: ${s.forward ? 'blocked' : 'dropped'} a server ${s.kind} (${s.problem})\n`);
      if (audit.enabled) {
        audit.log({ type: 'error', toolName: s.label, stage: 'reply-shape', error: s.problem });
      }
      return s.forward;
    }
    const outcome = s.outcome!;
    if (s.kind === 'reply' && s.pending && outcome.verdict === 'clean' && isPlainObject(el) && 'result' in el) {
      // A malformed initialize/tools/list result must not take the proxy down.
      try {
        observeManifest(s.pending.method, el.result);
      } catch (err) {
        process.stderr.write(`blindseal: manifest check skipped (${err instanceof Error ? err.message : String(err)})\n`);
      }
    }
    if (outcome.verdict !== 'clean') {
      process.stderr.write(
        `blindseal: ${outcome.verdict} (L${outcome.layer ?? '?'}) ${s.kind} from '${s.label}' (mode=${config.mode}${s.mutated ? (s.forward ? ', replaced' : ', dropped') : ''}${outcome.degraded ? ', degraded' : ''})\n`,
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
        transport: 'stdio',
        serverKey: serverIdentifier,
      });
    }
    if (scanStore.enabled) {
      try {
        scanStore.insert({
          serverKey: serverIdentifier,
          transport: 'stdio',
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
      addResponseToTaint(s.forward, s.label, taint, isTrustedSource(s.label, config.tradePolicy));
    }
    return s.forward;
  }

  let chain: Promise<void> = Promise.resolve();
  const outRl = createInterface({ input: childStdout });
  outRl.on('line', (line) => {
    chain = chain.then(() => relayServerLine(line)).catch((err) => {
      // Fail closed for this line; the chain must keep running for the next one.
      process.stderr.write(`blindseal: dropped a server message (${err instanceof Error ? err.message : String(err)})\n`);
    });
  });
  async function relayServerLine(line: string): Promise<void> {
    {
      let parsed: unknown;
      try { parsed = parseJson(line); } catch { parsed = undefined; }
      if (Array.isArray(parsed)) {
        const out: unknown[] = [];
        for (const el of parsed) {
          const r = await screenServerElement(el);
          if (r) out.push(r);
        }
        if (out.length > 0) process.stdout.write(JSON.stringify(out) + '\n');
        return;
      }
      if (!isPlainObject(parsed)) {
        if (line.trim()) process.stderr.write('blindseal: dropped a server line that is not a JSON-RPC message\n');
        return;
      }
      const r = await screenServerElement(parsed);
      if (r) process.stdout.write(JSON.stringify(r) + '\n');
    }
  }

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
