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
  inspectToolCallResponse,
  isToolCallResponse,
  tryParse,
  type JsonRpcMessage,
  type ToolCallResult,
} from './shared.js';

function addResponseToTaint(
  msg: JsonRpcMessage & { result: ToolCallResult },
  toolName: string,
  taint: TaintStore,
  trusted: boolean,
): void {
  const now = Date.now();
  for (const item of msg.result.content) {
    if (item.type === 'text' && typeof item.text === 'string' && item.text.length > 0) {
      taint.add({ toolName, content: item.text, addedAt: now, trusted });
    }
  }
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

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
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
  const inRl = createInterface({ input: process.stdin });
  inRl.on('line', (line) => {
    const msg = tryParse(line);
    if (msg && msg.method === 'tools/call' && msg.id != null) {
      const params = msg.params as { name?: unknown; arguments?: unknown } | undefined;
      const name = params && typeof params.name === 'string' ? params.name : null;
      if (name) {
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
          const blocked = buildCapabilityBlockedResponse(
            msg.id,
            name,
            decision.reason ?? 'tainted args',
            (decision.taintSources ?? []).map((s) => s.toolName),
          );
          toolNameById.delete(msg.id);
          process.stdout.write(JSON.stringify(blocked) + '\n');
          return; // do NOT forward the original call to the child
        }
      }
    }
    childStdin.write(line + '\n');
  });
  inRl.on('close', () => {
    childStdin.end();
  });

  // server → agent: detection runs here. After mutation (if any), the final content
  // is added to the taint store so subsequent capability checks can see it.
  let chain: Promise<void> = Promise.resolve();
  const outRl = createInterface({ input: childStdout });
  outRl.on('line', (line) => {
    chain = chain.then(async () => {
      const msg = tryParse(line);
      if (!msg) {
        process.stdout.write(line + '\n');
        return;
      }

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

      if (isToolCallResponse(msg)) {
        const toolName =
          (msg.id != null ? toolNameById.get(msg.id) : undefined) ?? 'unknown';
        if (msg.id != null) toolNameById.delete(msg.id);

        let outcome: Awaited<ReturnType<typeof inspectToolCallResponse>>;
        try {
          outcome = await inspectToolCallResponse(msg, toolName, config.mode);
        } catch (err) {
          // Screening failed: record it and fail closed (the response is withheld).
          audit.log(screeningErrorEntry(msg, toolName, 'detection', err));
          process.stdout.write(JSON.stringify(screeningErrorResponse(msg.id ?? null)) + '\n');
          return;
        }
        if (outcome.verdict !== 'clean') {
          process.stderr.write(
            `blindseal: ${outcome.verdict} (L${outcome.layer ?? '?'}) response from '${toolName}' (mode=${config.mode}${outcome.mutated ? ', mutated' : ''})\n`,
          );
        }
        if (audit.enabled) {
          const previewText = (msg.result.content
            .map((c) => (typeof c.text === 'string' ? c.text : ''))
            .join('\n'));
          audit.log({
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
            text: previewText,
            l3Status: outcome.result?.l3Status,
          });
        }
        if (scanStore.enabled) {
          const rawText = msg.result.content
            .map((c) => (typeof c.text === 'string' ? c.text : ''))
            .join('\n');
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
            });
          } catch (err) {
            process.stderr.write(`blindseal: persistence insert failed: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }
        if (config.capability.enabled || config.tradePolicy.enabled)
          addResponseToTaint(msg, toolName, taint, isTrustedSource(toolName, config.tradePolicy));
      }

      process.stdout.write(JSON.stringify(msg) + '\n');
    });
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void audit.shutdown();
      try { scanStore.close(); } catch { /* ignore */ }
      if (!child.killed) child.kill(sig);
    });
  }
}

// Re-exported for tests.
export type { CapabilityConfig };
