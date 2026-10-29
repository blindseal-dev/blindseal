/// Decision recorder. Every decision the proxy makes — capability allow/warn/block, response
/// detection (clean/suspicious/malicious, including degraded L3), manifest checks and screening
/// errors — is appended to the content-free hash chain (@blindseal/audit, <dir>/audit.log):
/// decisionId, verdict (pass | flag | block | error), payloadHash, ts, index, prevHash, hash.
/// Nothing else.
///
/// What a decision was about (tool arguments, response text) is retained ONLY in the encrypted
/// content store (<dir>/content.json, XChaCha20-Poly1305, key <dir>/content.key) — redacted by
/// @blindseal/redactor first and truncated to RETAIN_MAX chars — keyed by the decisionId.
///
/// BLINDSEAL_AUDIT_LOG (opt-in) additionally writes a plaintext JSONL of decision METADATA for
/// `blindseal-audit`: ids, verdicts, layers, pattern ids, modes. It never contains arguments,
/// response text, previews, judge reasoning or capability reasons (all of which can quote
/// content). Pattern ids and tool names pass the same identifier allowlist as the agent's notice,
/// and a layer-3 decision's patterns are written as the fixed `layer-3-judge`: a judge's labels are
/// its output, which can quote the text it read (0.7.0 re-audit A817-R4).

import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { openAudit, toChainVerdict, ERROR_VERDICT, type ChainVerdict } from '@blindseal/audit';
import { redactText, redactValueText } from '../detection/scan-pool.js';
import { safeToken, trustedPatterns } from '../transports/notice.js';

export interface AuditConfig {
  /// Directory holding audit.log, content.json, content.key, identity.key (default ~/.blindseal,
  /// env BLINDSEAL_AUDIT_DIR).
  dir: string;
  /// Optional plaintext metadata JSONL (env BLINDSEAL_AUDIT_LOG).
  filepath?: string;
}

interface Common {
  toolName: string;
  /// Free text that may quote content (judge reasoning, capability reason). Encrypted store only.
  reasoning?: string;
}

export interface DetectionAuditInput extends Common {
  type: 'detection';
  layer: number | null;
  verdict: 'clean' | 'suspicious' | 'malicious';
  confidence: number;
  patterns: string[];
  mode: string;
  mutated: boolean;
  /// sha256 hex of the screened text (InspectionOutcome.contentHash).
  contentHash: string;
  /// The screened text (response text, or the tool-call arguments when direction = 'request').
  /// Redacted + encrypted; never written in plaintext.
  text?: string;
  /// 'unavailable' marks a decision made without L3 when L3 was wanted.
  l3Status?: string;
  transport?: string;
  /// Logical server identifier (stdio command id, upstream URL, scan-http server URL).
  /// Encrypted store only.
  serverKey?: string;
  /// 'request' = tool-call arguments screened before forwarding; absent = tool response.
  direction?: 'request';
  /// Present (true) only when layer 2 was unavailable for this decision.
  degraded?: boolean;
}

export interface CapabilityAuditInput extends Common {
  type: 'capability';
  action: 'allow' | 'block' | 'warn';
  matchedPattern?: string;
  taintSources?: string[];
  reason?: string;
  /// The tool-call arguments. Hashed into payloadHash; redacted + encrypted; never plaintext.
  args?: unknown;
}

export interface ManifestAuditInput {
  type: 'manifest';
  serverKey: string;
  fingerprint: string;
  status: 'first-seen' | 'unchanged' | 'drift';
  changes: string[];
}

export interface ErrorAuditInput {
  type: 'error';
  toolName: string;
  /// Where screening failed: 'detection', 'sse', 'scan', ….
  stage: string;
  error: string;
  /// sha256 hex of the payload that was being screened, when known.
  contentHash?: string;
  text?: string;
}

export type AuditEntryInput = DetectionAuditInput | CapabilityAuditInput | ManifestAuditInput | ErrorAuditInput;

/// One line of the optional plaintext metadata log. Content-free by construction.
export interface AuditEntry {
  type: AuditEntryInput['type'];
  ts: number;
  decisionId: string;
  auditIndex: number;
  chainVerdict: ChainVerdict;
  toolName?: string;
  layer?: number | null;
  verdict?: string;
  confidence?: number;
  patterns?: string[];
  mode?: string;
  mutated?: boolean;
  l3Status?: string;
  direction?: 'request';
  degraded?: boolean;
  action?: string;
  matchedPattern?: string;
  taintSources?: string[];
  serverKey?: string;
  fingerprint?: string;
  status?: string;
  changeCount?: number;
  stage?: string;
}
export type DetectionAuditEntry = AuditEntry & { type: 'detection' };
export type CapabilityAuditEntry = AuditEntry & { type: 'capability' };
export type ManifestAuditEntry = AuditEntry & { type: 'manifest' };

export interface RecordedDecision {
  decisionId: string;
  index: number;
  verdict: ChainVerdict;
  payloadHash: string;
}

export interface AuditLogger {
  readonly enabled: boolean;
  log(entry: AuditEntryInput): RecordedDecision | null;
  shutdown(): Promise<void>;
  /// Resolves once every record logged so far is in the encrypted store (its redaction runs in
  /// the scan worker). Transports await it before answering, so a decision's record exists by
  /// the time anyone can see its effect.
  settled(): Promise<void>;
}

/// Retained (encrypted) text is capped at this many characters.
export const RETAIN_MAX = 8192;

const sha = (s: string) => '0x' + createHash('sha256').update(s).digest('hex');
const hex0x = (h: string) => (h.startsWith('0x') ? h : '0x' + h);
const cap = (s: string) => (s.length <= RETAIN_MAX ? s : s.slice(0, RETAIN_MAX) + `…[+${s.length - RETAIN_MAX} chars]`);

/// payloadHash of a tool call: sha256 of JSON {tool, args} — the same preimage `blindseal attest`
/// commits to, so a gated call's capability decision and its attestation share a payloadHash.
export function toolCallPayloadHash(toolName: string, args: unknown): string {
  return sha(JSON.stringify({ tool: toolName, args }));
}

function chainVerdictOf(e: AuditEntryInput): ChainVerdict {
  switch (e.type) {
    case 'detection': return toChainVerdict(e.verdict);
    case 'capability': return toChainVerdict(e.action);
    case 'manifest': return e.status === 'drift' ? toChainVerdict('warn') : toChainVerdict('allow');
    case 'error': return ERROR_VERDICT;
  }
}

function payloadHashOf(e: AuditEntryInput): string {
  switch (e.type) {
    case 'detection': return hex0x(e.contentHash);
    case 'capability': return toolCallPayloadHash(e.toolName, e.args ?? null);
    case 'manifest': return sha(`manifest\n${e.serverKey}\n${e.fingerprint}`);
    case 'error': return e.contentHash ? hex0x(e.contentHash) : sha(`error\n${e.toolName}\n${e.stage}`);
  }
}

/// What goes to the encrypted store: the full decision record, with arguments and text redacted.
/// Redaction runs in the scan worker (scan-pool.ts), off the event loop.
async function retainedOf(e: AuditEntryInput): Promise<Record<string, unknown>> {
  switch (e.type) {
    case 'detection': {
      const { text, ...rest } = e;
      return { ...rest, ...(text !== undefined ? { text: cap(await redactText(text)) } : {}) };
    }
    case 'capability': {
      const { args, ...rest } = e;
      return { ...rest, ...(args !== undefined ? { args: cap(await redactValueText(args)) } : {}) };
    }
    case 'manifest':
      return { ...e };
    case 'error': {
      const { text, ...rest } = e;
      return { ...rest, error: cap(await redactText(e.error)), ...(text !== undefined ? { text: cap(await redactText(text)) } : {}) };
    }
  }
}

/// The plaintext metadata line — an allowlist, so a new content-bearing field can never leak.
/// Free-form strings (tool names, pattern ids, rule ids, taint sources) are reduced to identifiers
/// exactly as in the agent's notice; the originals are in the encrypted record.
export function metadataOf(e: AuditEntryInput, rec: RecordedDecision): AuditEntry {
  const base: AuditEntry = { type: e.type, ts: Date.now(), decisionId: rec.decisionId, auditIndex: rec.index, chainVerdict: rec.verdict };
  switch (e.type) {
    case 'detection':
      return { ...base, toolName: safeToken(e.toolName), layer: e.layer, verdict: e.verdict, confidence: e.confidence, patterns: trustedPatterns(e.layer, e.patterns), mode: e.mode, mutated: e.mutated, ...(e.l3Status ? { l3Status: e.l3Status } : {}), ...(e.direction ? { direction: e.direction } : {}), ...(e.degraded ? { degraded: true } : {}) };
    case 'capability':
      return {
        ...base, toolName: safeToken(e.toolName), action: e.action,
        // A sensitive-tool rule is a regex source, not an identifier: it shows as capability-policy.
        ...(e.matchedPattern !== undefined ? { matchedPattern: safeToken(e.matchedPattern) === 'unknown' ? 'capability-policy' : e.matchedPattern } : {}),
        ...(e.taintSources ? { taintSources: e.taintSources.map(safeToken) } : {}),
      };
    case 'manifest':
      return { ...base, serverKey: e.serverKey, fingerprint: e.fingerprint, status: e.status, changeCount: e.changes.length };
    case 'error':
      return { ...base, toolName: safeToken(e.toolName), stage: e.stage };
  }
}

const NOOP: AuditLogger = { enabled: false, log: () => null, async shutdown() {}, async settled() {} };

export function createAuditLogger(config: AuditConfig): AuditLogger {
  let audit: ReturnType<typeof openAudit>;
  try {
    audit = openAudit(config.dir);
  } catch (err) {
    process.stderr.write(
      `blindseal: WARNING audit chain unavailable at ${config.dir} (${err instanceof Error ? err.message : String(err)}); decisions are NOT being recorded\n`,
    );
    return NOOP;
  }

  let stream: WriteStream | null = null;
  if (config.filepath) {
    try {
      const dir = path.dirname(config.filepath);
      if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
      stream = createWriteStream(config.filepath, { flags: 'a', mode: 0o600 });
      stream.on('error', (err) => process.stderr.write(`blindseal: audit metadata log write error: ${err.message}\n`));
    } catch (err) {
      process.stderr.write(`blindseal: audit metadata log unavailable at ${config.filepath} (${err instanceof Error ? err.message : String(err)})\n`);
      stream = null;
    }
  }

  let closed = false;
  let warned = false;
  const pendingPuts = new Set<Promise<unknown>>();
  return {
    enabled: true,
    log(entry: AuditEntryInput): RecordedDecision | null {
      if (closed) return null;
      try {
        const decisionId = 'd_' + randomBytes(8).toString('hex');
        const verdict = chainVerdictOf(entry);
        const payloadHash = payloadHashOf(entry);
        const e = audit.chain.append({ decisionId, verdict, payloadHash });
        // The chain entry is appended now; the redacted record follows (shutdown waits for it).
        const put = retainedOf(entry)
          .then((r) => audit.content.put(decisionId, r))
          .catch((err) => process.stderr.write(`blindseal: WARNING audit content write failed (${err instanceof Error ? err.message : String(err)})\n`));
        pendingPuts.add(put);
        void put.finally(() => pendingPuts.delete(put));
        const rec: RecordedDecision = { decisionId, index: e.index, verdict, payloadHash };
        if (stream) stream.write(JSON.stringify(metadataOf(entry, rec)) + '\n');
        return rec;
      } catch (err) {
        if (!warned) {
          warned = true;
          process.stderr.write(`blindseal: WARNING audit append failed (${err instanceof Error ? err.message : String(err)})\n`);
        }
        return null;
      }
    },
    async settled() {
      await Promise.all([...pendingPuts]);
    },
    async shutdown() {
      if (closed) return;
      closed = true;
      await Promise.all([...pendingPuts]);
      if (!stream) return;
      const s = stream;
      await new Promise<void>((resolve) => s.end(() => resolve()));
    },
  };
}

/// The error decision for a tool response whose screening threw.
export function screeningErrorEntry(
  msg: { result?: unknown },
  toolName: string,
  stage: string,
  err: unknown,
): ErrorAuditInput {
  const raw = (msg.result as { content?: unknown } | null | undefined)?.content;
  const content = Array.isArray(raw) ? (raw as Array<{ text?: unknown } | null>) : [];
  const text = content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
  return {
    type: 'error',
    toolName,
    stage,
    error: err instanceof Error ? err.message : String(err),
    contentHash: createHash('sha256').update(text).digest('hex'),
    text,
  };
}

/// What the agent receives instead of a response that could not be screened (fail closed).
export function screeningErrorResponse(id: string | number | null) {
  return {
    jsonrpc: '2.0' as const,
    id,
    error: { code: -32603, message: '[BLINDSEAL_ERROR] screening failed; the tool response was withheld' },
  };
}
