/// Shared scanning + mutation logic used by both stdio and http transports.

import { runPipeline, runOutboundScreen } from '../detection/pipeline.js';
import { inDecisionScope } from '../detection/degraded-state.js';
import { rankVerdict, type DetectionResult, type Verdict } from '../detection/types.js';
import { createHash } from 'node:crypto';
import { redactStructure } from '@blindseal/redactor';

export interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface ContentItem {
  type: string;
  text?: string;
  [k: string]: unknown;
}

export interface ToolCallResult {
  /// Normalised to [] by isToolCallResponse when the server sent only structuredContent.
  content: ContentItem[];
  structuredContent?: unknown;
  isError?: boolean;
  [k: string]: unknown;
}

export type BlindsealMode = 'block' | 'warn' | 'log';

export interface InspectionOutcome {
  mutated: boolean;
  verdict: Verdict;
  layer?: number;
  result: DetectionResult | null;
  contentHash: string;
  /// Every agent-visible text surface that was scanned, joined with '\n' (pre-mutation).
  scannedText: string;
  /// True when layer 2 was unavailable for at least one surface (see DetectionResult.degraded).
  degraded: boolean;
}

/// Deterministic JSON: object keys sorted recursively, so the same structured payload always
/// produces the same scanned text and hash regardless of the server's key order.
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return typeof v === 'bigint' ? v.toString() : v;
    if (seen.has(v as object)) return '[circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(norm);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = norm((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(norm(value)) ?? '';
}

/// Every string in a JSON value (object keys and string leaves), in stable key order, joined
/// with '\n'. Scanned alongside the stringified form: JSON escaping turns a real newline or tab
/// inside a value into a literal backslash sequence, which whitespace-based patterns miss.
export function jsonStringLeaves(value: unknown): string {
  const out: string[] = [];
  const seen = new WeakSet<object>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') { out.push(v); return; }
    if (v === null || typeof v !== 'object' || seen.has(v as object)) return;
    seen.add(v as object);
    if (Array.isArray(v)) { v.forEach(walk); return; }
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out.push(k);
      walk((v as Record<string, unknown>)[k]);
    }
  };
  walk(value);
  return out.join('\n');
}

export interface ResponseSurface {
  kind: 'text' | 'resource' | 'structured' | 'structured-strings' | 'extra' | 'extra-strings';
  text: string;
  /// What L2/L3 see instead of `text` (still redacted by the pipeline). Set on the *-strings
  /// surfaces: their newline-joined keys and values have lost the JSON key/value shape the
  /// key-based redactor needs, so the model text is built from a key-redacted copy instead.
  modelText?: string;
}

/// Result fields the protocol defines and the scanner handles explicitly; every other top-level
/// field (vendor extensions, `_meta`, a server's own keys) is scanned as the 'extra' surface.
const KNOWN_RESULT_FIELDS = new Set(['content', 'structuredContent', 'isError']);

/// Every text surface of a tool-call result that reaches the agent:
///   content[].text (type "text"), content[].resource.text (embedded resources),
///   structuredContent, and any other top-level result field (stable-stringified).
/// A JSON surface is scanned twice: as stable JSON, and as its string leaves (see jsonStringLeaves).
export function collectResponseSurfaces(result: ToolCallResult): ResponseSurface[] {
  const out: ResponseSurface[] = [];
  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      out.push({ kind: 'text', text: item.text });
    }
    const res = (item as { resource?: unknown }).resource;
    if (res && typeof res === 'object' && typeof (res as { text?: unknown }).text === 'string') {
      out.push({ kind: 'resource', text: (res as { text: string }).text });
    }
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    pushJsonSurfaces(out, 'structured', result.structuredContent);
  }
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (!KNOWN_RESULT_FIELDS.has(k) && v !== undefined && v !== null) extra[k] = v;
  }
  if (Object.keys(extra).length > 0) pushJsonSurfaces(out, 'extra', extra);
  return out;
}

function pushJsonSurfaces(out: ResponseSurface[], kind: 'structured' | 'extra', value: unknown): void {
  const json = stableStringify(value);
  out.push({ kind, text: json });
  const leaves = jsonStringLeaves(value);
  if (leaves && leaves !== json) {
    out.push({ kind: `${kind}-strings`, text: leaves, modelText: jsonStringLeaves(redactStructure(value).value) });
  }
}

const isLeavesSurface = (s: ResponseSurface) => s.kind === 'structured-strings' || s.kind === 'extra-strings';

/// All agent-visible text of a result joined with '\n' — for previews, persistence and taint.
export function responseText(result: ToolCallResult): string {
  return collectResponseSurfaces(result)
    .filter((s) => !isLeavesSurface(s))
    .map((s) => s.text)
    .join('\n');
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function tryParse(line: string): JsonRpcMessage | null {
  try {
    return JSON.parse(line) as JsonRpcMessage;
  } catch {
    return null;
  }
}

/// A tool-call result is anything carrying `content[]` or `structuredContent`. A result that
/// has only structuredContent is normalised to `content: []` so every caller can iterate it.
export function isToolCallResponse(
  msg: JsonRpcMessage,
): msg is JsonRpcMessage & { result: ToolCallResult } {
  if (!msg.result || typeof msg.result !== 'object' || Array.isArray(msg.result)) return false;
  const r = msg.result as Partial<ToolCallResult>;
  if (Array.isArray(r.content)) return true;
  if ('structuredContent' in r && r.structuredContent !== undefined) {
    (r as ToolCallResult).content = [];
    return true;
  }
  return false;
}

export function buildBlockedItem(toolName: string, r: DetectionResult): ContentItem {
  return {
    type: 'text',
    text:
      `[BLINDSEAL_BLOCKED] Response from tool '${toolName}' was flagged as potential prompt injection. ` +
      `Verdict: ${r.verdict}. Reasoning: ${r.reasoning}. ` +
      `Original content withheld. To override, set BLINDSEAL_MODE=warn.`,
  };
}

export function buildWarningItem(toolName: string, r: DetectionResult): ContentItem {
  return {
    type: 'text',
    text:
      `[BLINDSEAL_WARNING] Tool '${toolName}' response flagged (${r.verdict}). ` +
      `Reasoning: ${r.reasoning}. Original content follows.`,
  };
}

export function buildCapabilityBlockedResponse(
  id: string | number,
  toolName: string,
  reason: string,
  sourceTools: string[],
): JsonRpcMessage {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `[BLINDSEAL_CAPABILITY_BLOCKED] Refused to invoke '${toolName}'. ${reason}. ` +
            `Taint source(s): ${sourceTools.join(', ') || 'unknown'}. ` +
            `To override, set BLINDSEAL_CAPABILITY_MODE=warn or unset BLINDSEAL_CAPABILITY.`,
        },
      ],
    },
  };
}

/// Inspects a tool-call response: runs the detection pipeline on every agent-visible text
/// surface (text items, embedded-resource text, structuredContent, other result fields), mutates the message
/// in-place based on the worst verdict + the configured mode, and returns a structured outcome
/// the caller can use for audit/persistence. On block the whole result is replaced by the
/// block notice, so no resource or structured payload reaches the agent.
export async function inspectToolCallResponse(
  msg: JsonRpcMessage & { result: ToolCallResult },
  toolName: string,
  mode: BlindsealMode,
): Promise<InspectionOutcome> {
  const items = Array.isArray(msg.result.content) ? msg.result.content : [];
  const surfaces = collectResponseSurfaces(msg.result);
  let worst = 'clean' as Verdict;
  let worstResult = null as DetectionResult | null;
  let degraded = false;

  // One decision, however many surfaces: the layer-2-unavailable notice prints at most once.
  await inDecisionScope(async () => {
    for (const surface of surfaces) {
      const r = await runPipeline(surface.text, { toolName, mcpMethod: 'tools/call' }, { modelText: surface.modelText });
      if (r.degraded) degraded = true;
      if (rankVerdict(r.verdict) > rankVerdict(worst)) {
        worst = r.verdict;
        worstResult = r;
      }
    }
  });

  const scannedText = surfaces.filter((s) => !isLeavesSurface(s)).map((s) => s.text).join('\n');
  const contentHash = sha256Hex(scannedText);
  const base = { contentHash, scannedText, degraded };

  if (worst === 'clean' || !worstResult) {
    return { mutated: false, verdict: 'clean', result: null, ...base };
  }
  if (mode === 'log') {
    return { mutated: false, verdict: worst, layer: worstResult.layer, result: worstResult, ...base };
  }
  if (mode === 'warn') {
    msg.result.content = [buildWarningItem(toolName, worstResult), ...items];
    return { mutated: true, verdict: worst, layer: worstResult.layer, result: worstResult, ...base };
  }

  // Block: replace the entire result. Dropping every other field (structuredContent, _meta,
  // vendor extensions) is deliberate: anything left behind would still reach the agent.
  msg.result = { content: [buildBlockedItem(toolName, worstResult)], isError: true };
  return { mutated: true, verdict: worst, layer: worstResult.layer, result: worstResult, ...base };
}

// ---------------------------------------------------------------------------------------------
// Outbound (agent → server) screening of tool-call arguments.

export interface OutboundOutcome {
  verdict: Verdict;
  layer?: number;
  result: DetectionResult | null;
  /// The stable-stringified arguments that were scanned.
  scannedText: string;
  argsHash: string;
  /// 'forward' = send the call to the server unchanged; 'block' = answer the agent with
  /// buildOutboundBlockedResponse and never forward.
  action: 'forward' | 'block';
}

/// Runs L0 + L1 over the stable-stringified tool-call arguments and over their string leaves
/// (see jsonStringLeaves); the worse verdict wins. Block mode refuses any non-clean verdict;
/// warn and log modes forward (the caller flags on stderr / audit).
export function inspectToolCallArguments(
  toolName: string,
  args: unknown,
  mode: BlindsealMode,
): OutboundOutcome {
  const scannedText = args === undefined ? '' : stableStringify(args);
  const argsHash = sha256Hex(scannedText);
  let r = runOutboundScreen(scannedText);
  const leaves = args === undefined ? '' : jsonStringLeaves(args);
  if (leaves && leaves !== scannedText) {
    const rl = runOutboundScreen(leaves);
    if (rankVerdict(rl.verdict) > rankVerdict(r.verdict)) r = rl;
  }
  if (r.verdict === 'clean') {
    return { verdict: 'clean', result: null, scannedText, argsHash, action: 'forward' };
  }
  return {
    verdict: r.verdict,
    layer: r.layer,
    result: r,
    scannedText,
    argsHash,
    action: mode === 'block' ? 'block' : 'forward',
  };
}

/// JSON-RPC error code returned for a tool call whose arguments were blocked (server-defined
/// range -32000..-32099).
export const OUTBOUND_BLOCKED_CODE = -32001;

export function buildOutboundBlockedResponse(
  id: string | number,
  toolName: string,
  r: DetectionResult,
): JsonRpcMessage {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: OUTBOUND_BLOCKED_CODE,
      message:
        `[BLINDSEAL_BLOCKED] Call to tool '${toolName}' was not sent: its arguments were flagged as ` +
        `potential prompt injection (L${r.layer ?? '?'}, ${r.verdict}). Reasoning: ${r.reasoning}. ` +
        `To override, set BLINDSEAL_MODE=warn.`,
      data: { blindseal: { direction: 'request', verdict: r.verdict, layer: r.layer ?? null, patterns: r.detectedPatterns } },
    },
  };
}
