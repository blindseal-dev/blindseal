/// Server → agent screening for EVERY JSON-RPC message, whatever its shape (0.7.0 re-audit).
///
/// The earlier design started from a shape check ("is this a tool-call result?") and scanned
/// the fields it knew about. Each gap the audit found came from that: a field the scanner did not
/// know, a key the parse lost, or envelope fields that survived a block. This module inverts it:
///
///   - Parse with null-prototype objects, so a literal `"__proto__"` key is an ordinary own key.
///   - Correlate every reply with the agent request it answers; a reply nobody asked for is dropped.
///   - Validate the reply against the method it answers; a malformed reply is blocked, not forwarded.
///   - Screen every string in the message (keys and values, at any depth, envelope included).
///     L0/L1 see the raw strings; L2/L3 see the key-redacted structured form.
///   - On block, build a new reply from an allowlist. Nothing from the original survives.
///
/// Transports call `screenServerMessage` for each element and serialise what it returns, so the
/// agent only ever receives bytes produced from the screened, parsed value.

import { createHash } from 'node:crypto';
import { runPipeline } from '../detection/pipeline.js';
import { screenEach, modelForms, decodeBlobInWorker } from '../detection/scan-pool.js';
import { readMaxBlobBytes, type BlobDecode } from './blob-decode.js';
import { noticeText, detectionNotice } from './notice.js';
import { ScanBudget } from '../detection/scan-budget.js';
import { inDecisionScope } from '../detection/degraded-state.js';
import { rankVerdict, type DetectionResult, type Verdict } from '../detection/types.js';

export type BlindsealMode = 'block' | 'warn' | 'log';

// Parsing and serialising without prototype surprises: json-tools.ts (shared with the scan worker,
// which must not load this module's model-layer imports).
export { isPlainObject, parseJson, MAX_JSON_DEPTH, stableStringify, stringLeaves, jsonStringLeaves } from './json-tools.js';
import { isPlainObject, stableStringify, stringLeaves, withoutScreened, type Obj } from './json-tools.js';

// ---------------------------------------------------------------------------------------------
// Request/reply correlation.

export interface PendingEntry {
  id: string | number;
  method: string;
  /// tools/call only.
  toolName?: string;
}

/// Ids of agent requests still waiting for a reply. `1` and `"1"` are different ids.
export class PendingRequests {
  private readonly m = new Map<string, PendingEntry>();
  constructor(private readonly cap = 10_000) {}
  static key(id: string | number): string {
    return `${typeof id}:${String(id)}`;
  }
  /// Records an agent → server message if it is a request (has a method and a string/number id).
  track(msg: unknown): void {
    if (!isPlainObject(msg) || typeof msg.method !== 'string') return;
    const id = msg.id;
    if (typeof id !== 'string' && typeof id !== 'number') return;
    let toolName: string | undefined;
    if (msg.method === 'tools/call' && isPlainObject(msg.params) && typeof msg.params.name === 'string') toolName = msg.params.name;
    const k = PendingRequests.key(id);
    this.m.delete(k);
    this.m.set(k, { id, method: msg.method, toolName });
    if (this.m.size > this.cap) this.m.delete(this.m.keys().next().value!);
  }
  /// Forget a request the proxy answered itself (a blocked outbound call).
  forget(id: unknown): void {
    if (typeof id === 'string' || typeof id === 'number') this.m.delete(PendingRequests.key(id));
  }
  take(id: unknown): PendingEntry | undefined {
    if (typeof id !== 'string' && typeof id !== 'number') return undefined;
    const k = PendingRequests.key(id);
    const e = this.m.get(k);
    if (e) this.m.delete(k);
    return e;
  }
  peek(id: unknown): PendingEntry | undefined {
    if (typeof id !== 'string' && typeof id !== 'number') return undefined;
    return this.m.get(PendingRequests.key(id));
  }
  get size(): number {
    return this.m.size;
  }
}

// ---------------------------------------------------------------------------------------------
// Validation (by the method the reply answers).

/// Why a reply cannot be forwarded as-is, or null when its shape is acceptable.
export function replyShapeProblem(msg: Obj, method: string): string | null {
  if (msg.jsonrpc !== '2.0') return 'jsonrpc is not "2.0"';
  const hasResult = 'result' in msg;
  const hasError = 'error' in msg;
  if (hasResult === hasError) return 'a reply must carry exactly one of result or error';
  if (hasError) {
    const e = msg.error;
    if (!isPlainObject(e)) return 'error is not an object';
    if (!Number.isInteger(e.code)) return 'error.code is not an integer';
    if (typeof e.message !== 'string') return 'error.message is not a string';
    return null;
  }
  if (method === 'tools/call') return toolResultProblem(msg.result);
  return null;
}

/// A tools/call result per the MCP schema: `content` an array of objects with a string `type`
/// (text items carry a string `text`), optional boolean `isError`, optional object
/// `structuredContent`. A result with structuredContent and no content is tolerated.
export function toolResultProblem(result: unknown): string | null {
  if (!isPlainObject(result)) return 'result is not an object';
  if ('content' in result) {
    if (!Array.isArray(result.content)) return 'content is not an array';
    for (const item of result.content) {
      if (!isPlainObject(item)) return 'a content item is not an object';
      if (typeof item.type !== 'string') return 'a content item has no string type';
      if (item.type === 'text' && typeof item.text !== 'string') return 'a text item has no string text';
    }
  } else if (!('structuredContent' in result)) {
    return 'result has neither content nor structuredContent';
  }
  if ('isError' in result && typeof result.isError !== 'boolean') return 'isError is not a boolean';
  if ('structuredContent' in result && !isPlainObject(result.structuredContent)) return 'structuredContent is not an object';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Screening.

export interface ScreenOutcome {
  verdict: Verdict;
  layer?: number;
  result: DetectionResult | null;
  /// Stable JSON of the message without its id/jsonrpc (raw; for the encrypted store and taint).
  scannedText: string;
  contentHash: string;
  degraded: boolean;
}

// ---------------------------------------------------------------------------------------------
// Embedded binary (blob-decode.ts): `data` of image/audio items and every `blob` field.

const SEPARATE = '[screened separately]';

interface BlobSite {
  value: string;
  media?: { type: 'image' | 'audio'; mimeType: unknown };
}

const siteKey = (site: BlobSite) => (site.media ? `${site.media.type}|${String(site.media.mimeType)}` : 'blob') + '\u0000' + site.value;

/// Calls `visit` for each embedded-binary site: the `data` string of any object whose `type` is
/// "image" or "audio", and the string under any `blob` key. `visit` returns the replacement.
function mapBlobSites(v: unknown, visit: (site: BlobSite) => string, depth = 0): unknown {
  if (Array.isArray(v)) return v.map((x) => mapBlobSites(x, visit, depth + 1));
  if (!isPlainObject(v)) return v;
  const isMedia = (v.type === 'image' || v.type === 'audio') && typeof v.data === 'string';
  const o = Object.create(null) as Obj;
  for (const k of Object.keys(v)) {
    const val = v[k];
    if (k === 'blob' && typeof val === 'string') o[k] = visit({ value: val });
    else if (k === 'data' && isMedia) o[k] = visit({ value: val as string, media: { type: v.type as 'image' | 'audio', mimeType: v.mimeType } });
    else o[k] = mapBlobSites(val, visit, depth + 1);
  }
  return o;
}

interface BlobScreen {
  /// The body with each site replaced: validated media by a size marker, decoded blobs by
  /// SEPARATE (their text is screened on its own), oversized blobs by SEPARATE. A blob that is
  /// not base64 keeps its raw value, so the string passes still read it.
  body: Obj;
  /// Decoded text of every non-media blob.
  texts: string[];
  /// One result per invalid blob (not base64 / oversized): non-clean, blocked in block mode.
  problems: DetectionResult[];
}

async function screenBlobs(body: Obj): Promise<BlobScreen> {
  const sites = new Map<string, BlobSite>();
  mapBlobSites(body, (site) => { sites.set(siteKey(site), site); return site.value; });
  const decoded = new Map<string, BlobDecode>();
  const max = readMaxBlobBytes();
  await Promise.all([...sites].map(async ([key, site]) => {
    // Size first, without copying a huge string to the worker.
    const d: BlobDecode = Math.floor((site.value.length * 3) / 4) > max
      ? { kind: 'invalid', reason: 'oversized' }
      : await decodeBlobInWorker(site.value, site.media);
    decoded.set(key, d);
  }));
  const texts: string[] = [];
  const problems: DetectionResult[] = [];
  for (const d of decoded.values()) {
    if (d.kind === 'text' || d.kind === 'binary') texts.push(d.text);
    if (d.kind === 'invalid') problems.push(blobProblem(d.reason));
  }
  const out = mapBlobSites(body, (site) => {
    const d = decoded.get(siteKey(site))!;
    if (d.kind === 'media') return `[media: ${site.value.length} chars]`;
    if (d.kind === 'invalid' && d.reason === 'not-base64') return site.value;
    return SEPARATE;
  }) as Obj;
  return { body: out, texts, problems };
}

function blobProblem(reason: 'not-base64' | 'oversized'): DetectionResult {
  return {
    verdict: 'suspicious',
    confidence: 0.5,
    reasoning: reason === 'oversized'
      ? `an embedded blob is larger than the ${readMaxBlobBytes()}-byte limit (BLINDSEAL_MAX_BLOB_BYTES) and was not screened`
      : 'an embedded blob or media item is not valid base64, so its content cannot be screened',
    detectedPatterns: [reason === 'oversized' ? 'blob-oversized' : 'blob-not-base64'],
    layer: 0,
    l3Status: 'skipped_gate',
  };
}

/// Protocol vocabulary: a body whose remaining strings are all from here carries no free text
/// beyond what was already screened, so the whole-body model passes are skipped.
const STRUCTURAL = new Set([
  'result', 'content', 'type', 'text', 'image', 'audio', 'resource', 'resource_link', 'isError',
  'structuredContent', 'mimeType', 'data', 'blob', '[screened separately]',
]);

/// The free-text surfaces of a tools/call result screened on their own (best L2 signal):
/// content[].text and content[].resource.text.
function textSurfaces(result: unknown): string[] {
  const out: string[] = [];
  if (!isPlainObject(result) || !Array.isArray(result.content)) return out;
  for (const item of result.content) {
    if (!isPlainObject(item)) continue;
    if (item.type === 'text' && typeof item.text === 'string') out.push(item.text);
    if (isPlainObject(item.resource) && typeof item.resource.text === 'string') out.push(item.resource.text);
  }
  return out;
}

/// The message minus `id` and `jsonrpc` (everything else, envelope extensions included).
export function messageBody(msg: Obj): Obj {
  const body = Object.create(null) as Obj;
  for (const k of Object.keys(msg)) if (k !== 'id' && k !== 'jsonrpc') body[k] = msg[k];
  return body;
}

/// Screens every string of one message, in two phases:
///   1. Layer 0/1 (in the scan worker): text items, the decoded text of every blob, every other
///      string on its own, and all strings joined in the order the agent receives them.
///   2. Unless phase 1 already found it malicious, the model layers: the full pipeline on each
///      text item and decoded blob, then on the rest of the body (stable JSON and joined leaves)
///      with L2/L3 seeing its key-redacted form.
/// Validated binary media (blob-decode.ts) is the only content not screened.
export async function screenMessage(msg: Obj, toolName: string, mcpMethod: string): Promise<ScreenOutcome> {
  const body = messageBody(msg);
  let worst: DetectionResult | null = null;
  let degraded = false;
  const consider = (r: DetectionResult) => {
    if (r.degraded) degraded = true;
    if (r.verdict !== 'clean' && (!worst || rankVerdict(r.verdict) > rankVerdict(worst.verdict))) worst = r;
  };
  const ctx = { toolName, mcpMethod };
  // One Layer 0/1 time allowance for every pass below: a message that cannot be fully scanned in
  // time gets the non-clean budget result (blocked in block mode), never a partial clean.
  const budget = new ScanBudget();

  await inDecisionScope(async () => {
    const blobs = await screenBlobs(body);
    blobs.problems.forEach(consider);
    const noMedia = blobs.body;
    const items = textSurfaces(noMedia.result);
    const texts = [...items, ...blobs.texts];
    const skip = new Set(items);

    // Phase 1. Each text, and every other string on its own (keys included): an injection is
    // never diluted by, or split across, its neighbours. Then the string values, and values with
    // keys, joined in the order the agent receives them: a phrase split across neighbouring
    // fields must not slip between two leaves.
    consider(await screenEach(texts, budget));
    consider(await screenEach(stringLeaves(noMedia).filter((s) => !skip.has(s) && s.length >= 8), budget));
    consider(await screenEach([
      stringLeaves(noMedia, 'as-sent', false).join('\n'),
      stringLeaves(noMedia, 'as-sent', true).join('\n'),
    ], budget));
    if ((worst as DetectionResult | null)?.verdict === 'malicious') return; // the model layers cannot change that

    // Phase 2.
    for (const t of texts) consider(await runPipeline(t, ctx, { budget }));
    const rest = withoutScreened(noMedia, skip);
    const leaves = stringLeaves(rest);
    if (leaves.every((s) => STRUCTURAL.has(s))) return;
    const json = stableStringify(rest);
    const forms = await modelForms(stableStringify(noMedia), [...skip]);
    consider(await runPipeline(json, ctx, { modelText: forms.json, budget }));
    const joined = leaves.join('\n');
    if (joined && joined !== json) consider(await runPipeline(joined, ctx, { modelText: forms.leaves, budget }));
  });

  const scannedText = stableStringify(body);
  const w = worst as DetectionResult | null;
  return {
    verdict: w ? w.verdict : 'clean',
    layer: w?.layer,
    result: w,
    scannedText,
    contentHash: createHash('sha256').update(scannedText).digest('hex'),
    degraded,
  };
}

// ---------------------------------------------------------------------------------------------
// Replies the proxy builds itself (allowlisted fields only).

/// JSON-RPC error code for content Blindseal withheld (server-defined range -32000..-32099).
export const BLOCKED_CODE = -32001;

/// The whole reply the agent gets in place of a blocked one. For tools/call it is a tool result
/// (`content` = the notice, `isError: true`); a reply to any other method becomes a JSON-RPC
/// error, since a tool-result shape would be invalid there. Only `jsonrpc`, the id of the
/// agent's own request, and the proxy's notice appear.
export function buildBlockedReply(pending: PendingEntry, text: string): Obj {
  if (pending.method === 'tools/call') {
    return { jsonrpc: '2.0', id: pending.id, result: { content: [{ type: 'text', text }], isError: true } };
  }
  return { jsonrpc: '2.0', id: pending.id, error: { code: BLOCKED_CODE, message: text } };
}

export function buildWarningItem(toolName: string, r: DetectionResult): { type: 'text'; text: string } {
  return { type: 'text', text: detectionNotice('BLINDSEAL_WARNING', 'response', toolName, r) };
}

// ---------------------------------------------------------------------------------------------
// One server → agent message.

export type MessageKind = 'reply' | 'request' | 'notification' | 'invalid';

export interface ScreenedMessage {
  kind: MessageKind;
  /// What to send to the agent; null = drop it.
  forward: Obj | null;
  /// The request this reply answers (replies only).
  pending?: PendingEntry;
  /// tools/call tool name, else the method.
  label: string;
  outcome?: ScreenOutcome;
  /// Set when the message was dropped or replaced without (or before) detection.
  problem?: string;
  /// Screening threw: the message was withheld (fail closed).
  error?: unknown;
  mutated: boolean;
}

/// The proxy's answer to an agent message it could not parse (JSON-RPC -32700, id null). The
/// message is not forwarded: what the gate cannot read, the server must not receive.
export function parseErrorReply(): Obj {
  return { jsonrpc: '2.0', id: null, error: { code: -32700, message: '[BLINDSEAL] parse error: the message was not forwarded' } };
}

/// Why an agent → server element cannot be gated (and so is not forwarded), or null. The gate
/// screens tools/call by name and arguments, so a tools/call whose name is not a string is refused
/// rather than passed on for a lenient server to coerce; anything that is not a JSON-RPC object
/// (a nested batch, a bare value) is refused too.
export function inboundProblem(el: unknown): string | null {
  if (!isPlainObject(el)) return 'not a JSON-RPC message object';
  if (el.method === 'tools/call') {
    if (!isPlainObject(el.params) || typeof el.params.name !== 'string' || el.params.name.length === 0) {
      return 'tools/call needs params.name as a string';
    }
  }
  return null;
}

/// The proxy's answer to an agent element it refuses to forward (JSON-RPC -32600).
export function invalidRequestReply(id: unknown, problem: string): Obj {
  return { jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null, error: { code: -32600, message: `[BLINDSEAL] invalid request (${problem}): not forwarded` } };
}

/// The proxy's answer to an agent request whose screening threw (fail closed, not forwarded).
export function requestScreeningErrorReply(id: string | number): { jsonrpc: '2.0'; id: string | number; error: { code: number; message: string } } {
  return { jsonrpc: '2.0', id, error: { code: -32603, message: '[BLINDSEAL_ERROR] request screening failed; the call was not forwarded' } };
}

/// What the agent receives instead of a reply that could not be screened (fail closed).
export function buildScreeningErrorReply(pending: PendingEntry): Obj {
  return {
    jsonrpc: '2.0',
    id: pending.id,
    error: { code: -32603, message: '[BLINDSEAL_ERROR] screening failed; the tool response was withheld' },
  };
}

export async function screenServerMessage(
  msg: unknown,
  pendingRequests: PendingRequests,
  mode: BlindsealMode,
): Promise<ScreenedMessage> {
  if (!isPlainObject(msg)) {
    return { kind: 'invalid', forward: null, label: 'unknown', problem: 'not a JSON-RPC object', mutated: true };
  }
  if ('method' in msg && ('result' in msg || 'error' in msg)) {
    return { kind: 'invalid', forward: null, label: 'unknown', problem: 'a message cannot carry both a method and a result/error', mutated: true };
  }
  const isReply = !('method' in msg);
  if (!isReply) {
    // A server request or notification (sampling, elicitation, logging, progress, …).
    const kind: MessageKind = 'id' in msg ? 'request' : 'notification';
    const label = typeof msg.method === 'string' ? msg.method : 'unknown';
    if (typeof msg.method !== 'string' || msg.jsonrpc !== '2.0') {
      return { kind: 'invalid', forward: null, label, problem: 'malformed request or notification', mutated: true };
    }
    let outcome: ScreenOutcome;
    try {
      outcome = await screenMessage(msg, label, label);
    } catch (error) {
      return { kind, forward: null, label, error, mutated: true };
    }
    if (outcome.verdict !== 'clean' && mode === 'block') {
      return { kind, forward: null, label, outcome, mutated: true };
    }
    return { kind, forward: msg, label, outcome, mutated: false };
  }

  const pending = pendingRequests.take(msg.id);
  if (!pending) {
    return { kind: 'reply', forward: null, label: 'unknown', problem: 'reply to no outstanding request', mutated: true };
  }
  const label = pending.toolName ?? pending.method;
  const problem = replyShapeProblem(msg, pending.method);
  if (problem) {
    return {
      kind: 'reply', pending, label, problem, mutated: true,
      // The problem description stays on stderr and in the audit log: the notice is the template.
      forward: buildBlockedReply(pending, noticeText('BLINDSEAL_BLOCKED', { direction: 'response', tool: label, verdict: 'malformed', layer: null, patterns: ['reply-shape'] })),
    };
  }
  let outcome: ScreenOutcome;
  try {
    outcome = await screenMessage(msg, label, pending.method);
  } catch (error) {
    return { kind: 'reply', pending, label, error, mutated: true, forward: buildScreeningErrorReply(pending) };
  }
  if (outcome.verdict === 'clean' || !outcome.result || mode === 'log') {
    return { kind: 'reply', forward: msg, pending, label, outcome, mutated: false };
  }
  if (mode === 'warn') {
    if (pending.method === 'tools/call' && isPlainObject(msg.result) && Array.isArray(msg.result.content)) {
      msg.result.content = [buildWarningItem(label, outcome.result), ...msg.result.content];
      return { kind: 'reply', forward: msg, pending, label, outcome, mutated: true };
    }
    return { kind: 'reply', forward: msg, pending, label, outcome, mutated: false };
  }
  return {
    kind: 'reply', pending, label, outcome, mutated: true,
    forward: buildBlockedReply(pending, detectionNotice('BLINDSEAL_BLOCKED', 'response', label, outcome.result)),
  };
}
