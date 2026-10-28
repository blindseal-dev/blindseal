/// Shared scanning + mutation logic used by both stdio and http transports.

import { screenEach } from '../detection/scan-pool.js';
import { noticeText, detectionNotice, noticePatterns, safeToken } from './notice.js';
import { ScanBudget } from '../detection/scan-budget.js';
import { rankVerdict, type DetectionResult, type Verdict } from '../detection/types.js';
import { createHash } from 'node:crypto';
import { isPlainObject, jsonStringLeaves, parseJson, PendingRequests, screenServerMessage, stableStringify } from './reply-screen.js';

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

export type { BlindsealMode } from './reply-screen.js';
import type { BlindsealMode } from './reply-screen.js';

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

export { stableStringify, jsonStringLeaves, parseJson } from './reply-screen.js';

/// Every string of a tool-call result (keys and values) joined with '\n' — what the capability
/// and trade gates treat as tainted content.
export function responseText(result: unknown): string {
  return jsonStringLeaves(result);
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function tryParse(line: string): JsonRpcMessage | null {
  try {
    return parseJson(line) as JsonRpcMessage;
  } catch {
    return null;
  }
}

/// A tool-call result shape: an object carrying `content[]` or `structuredContent`. Transports no
/// longer use this to decide what to screen (every server message is screened, see
/// reply-screen.ts); it remains for callers that only want to recognise the shape.
export function isToolCallResponse(
  msg: JsonRpcMessage,
): msg is JsonRpcMessage & { result: ToolCallResult } {
  if (!isPlainObject(msg.result)) return false;
  const r = msg.result as Partial<ToolCallResult>;
  return Array.isArray(r.content) || ('structuredContent' in r && r.structuredContent !== undefined);
}

/// The capability gate's refusal. The gate's reason (which can quote the arguments) goes to the
/// encrypted audit store only; the agent gets the notice template with the matched rule's id.
export function buildCapabilityBlockedResponse(
  id: string | number,
  toolName: string,
  matchedPattern: string | undefined,
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
          text: noticeText('BLINDSEAL_CAPABILITY_BLOCKED', {
            // A sensitive-tool rule is a regex source, not an identifier: it shows as capability-policy.
            direction: 'request', tool: toolName, verdict: 'blocked', layer: null,
            patterns: [matchedPattern && safeToken(matchedPattern) !== 'unknown' ? matchedPattern : 'capability-policy'], sources: sourceTools,
          }),
        },
      ],
    },
  };
}

/// Screens one tools/call reply in place (tests and single-message callers): the message is
/// treated as the answer to a tools/call with its own id. On block every own key is removed and
/// only `jsonrpc`, `id` and the blocked result are set, matching what the transports send.
export async function inspectToolCallResponse(
  msg: JsonRpcMessage & { result: ToolCallResult },
  toolName: string,
  mode: BlindsealMode,
): Promise<InspectionOutcome> {
  const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : 0;
  const pending = new PendingRequests();
  pending.track({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName } });
  const target = msg as unknown as Record<string, unknown>;
  if (target.jsonrpc === undefined) target.jsonrpc = '2.0';
  if (target.id === undefined) target.id = id;
  const s = await screenServerMessage(target, pending, mode);
  const outcome = s.outcome;
  if (s.forward !== target) {
    for (const k of Object.keys(target)) delete target[k];
    Object.assign(target, s.forward ?? {});
  }
  return {
    mutated: s.mutated,
    verdict: s.problem ? 'malicious' : (outcome?.verdict ?? 'clean'),
    layer: outcome?.layer,
    result: outcome?.result ?? null,
    contentHash: outcome?.contentHash ?? '',
    scannedText: outcome?.scannedText ?? '',
    degraded: outcome?.degraded ?? false,
  };
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
export async function inspectToolCallArguments(
  toolName: string,
  args: unknown,
  mode: BlindsealMode,
): Promise<OutboundOutcome> {
  const scannedText = args === undefined ? '' : stableStringify(args);
  const argsHash = sha256Hex(scannedText);
  const budget = new ScanBudget(); // one allowance for both passes over this call
  const leaves = args === undefined ? '' : jsonStringLeaves(args);
  // Both passes in one scan-worker round trip, off the event loop.
  const r = await screenEach(leaves && leaves !== scannedText ? [scannedText, leaves] : [scannedText], budget);
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
      message: detectionNotice('BLINDSEAL_BLOCKED', 'request', toolName, r),
      data: { blindseal: { direction: 'request', verdict: r.verdict, layer: r.layer ?? null, patterns: noticePatterns(r) } },
    },
  };
}
