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
import { redactStructure } from '@blindseal/redactor';
import { runPipeline, runOutboundScreen } from '../detection/pipeline.js';
import { inDecisionScope } from '../detection/degraded-state.js';
import { rankVerdict, type DetectionResult, type Verdict } from '../detection/types.js';

export type BlindsealMode = 'block' | 'warn' | 'log';
type Obj = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Parsing and serialising without prototype surprises.

export function isPlainObject(v: unknown): v is Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/// JSON.parse into null-prototype objects. JSON.parse itself keeps a literal "__proto__" key as an
/// own property, but any later copy into a `{}` (assignment, Object.assign) turns it into a
/// prototype change and the key disappears from Object.keys. Null-prototype objects have no
/// `__proto__` accessor, so the key stays an ordinary property everywhere downstream.
export function parseJson(text: string): unknown {
  return toNullPrototype(JSON.parse(text));
}

/// JSON-RPC messages are shallow; anything nested deeper than this is refused at parse time (the
/// caller treats it as unparseable: never forwarded), so no later recursive step — redaction,
/// serialisation — can overflow the stack and take the proxy down.
export const MAX_JSON_DEPTH = 256;

/// Rebuilds every plain object of a parsed value with a null prototype. Iterative: a deeply nested
/// message must not overflow the stack here (a reviver recursed, threw at ~3000 levels, and the
/// caller then treated the line as "not JSON").
function toNullPrototype(root: unknown): unknown {
  const convert = (v: unknown): unknown => {
    if (!isPlainObject(v)) return v;
    const o = Object.create(null) as Obj;
    for (const k of Object.keys(v)) Object.defineProperty(o, k, { value: v[k], enumerable: true, writable: true, configurable: true });
    return o;
  };
  const top = convert(root);
  const stack: Array<[unknown, number]> = [[top, 1]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (depth > MAX_JSON_DEPTH) throw new RangeError(`JSON nested deeper than ${MAX_JSON_DEPTH} levels`);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) { v[i] = convert(v[i]); stack.push([v[i], depth + 1]); }
    } else {
      for (const k of Object.keys(v as Obj)) { (v as Obj)[k] = convert((v as Obj)[k]); stack.push([(v as Obj)[k], depth + 1]); }
    }
  }
  return top;
}

/// Deterministic JSON: object keys sorted recursively. Builds the string directly (no
/// intermediate object), so a "__proto__" key is serialised like any other key.
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const enc = (v: unknown): string | undefined => {
    if (v === null) return 'null';
    if (typeof v === 'bigint') return JSON.stringify(v.toString());
    if (typeof v !== 'object') return JSON.stringify(v);
    if (seen.has(v)) return JSON.stringify('[circular]');
    seen.add(v);
    let out: string;
    if (Array.isArray(v)) {
      out = '[' + v.map((x) => enc(x) ?? 'null').join(',') + ']';
    } else {
      const parts: string[] = [];
      for (const k of Object.keys(v).sort()) {
        const s = enc((v as Obj)[k]);
        if (s !== undefined) parts.push(JSON.stringify(k) + ':' + s);
      }
      out = '{' + parts.join(',') + '}';
    }
    seen.delete(v);
    return out;
  };
  return enc(value) ?? '';
}

/// Every string in a JSON value — object keys and string leaves — in stable key order. Iterative,
/// so a deeply nested reply cannot overflow the stack.
export function stringLeaves(value: unknown, order: 'sorted' | 'as-sent' = 'sorted', keys = true): string[] {
  const out: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string') { out.push(v); continue; }
    if (v === null || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
      continue;
    }
    const names = order === 'sorted' ? Object.keys(v).sort() : Object.keys(v);
    for (let i = names.length - 1; i >= 0; i--) {
      stack.push((v as Obj)[names[i]!]);
      if (keys) stack.push(names[i]!); // the key is visited before its value
    }
  }
  return out;
}

/// Leaves joined with '\n'. Scanned alongside the stable JSON: JSON escaping turns a real newline
/// or tab inside a value into a literal backslash sequence, which whitespace-based patterns miss.
export function jsonStringLeaves(value: unknown): string {
  return stringLeaves(value).join('\n');
}

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

/// Binary payloads by PROTOCOL position (never by value, and never by how the characters look): `data` of an image or
/// audio content item and `blob` of an embedded resource (MCP's base64 fields). The agent's model
/// receives these as media, not as text, so they are not text-screened at all: embedding base64
/// tells L2 nothing, it trips the large-base64-blob heuristic, and L0/L1 are quadratic on long
/// uniform runs (a silent audio clip is ~all "A"), which stalled the proxy for minutes.
/// (A character-ratio test was tried and both let prose through and rejected real PCM audio.)
function stripMedia(body: Obj): Obj {
  const result = body.result;
  if (!isPlainObject(result) || !Array.isArray(result.content)) return body;
  const marker = (v: string) => `[media: ${v.length} chars]`;
  const content = result.content.map((item) => {
    if (!isPlainObject(item)) return item;
    let out = item;
    const copy = () => (out === item ? (out = Object.assign(Object.create(null) as Obj, item)) : out);
    if ((item.type === 'image' || item.type === 'audio') && typeof item.data === 'string') copy().data = marker(item.data);
    if (isPlainObject(item.resource) && typeof item.resource.blob === 'string') {
      copy().resource = Object.assign(Object.create(null) as Obj, item.resource, { blob: marker(item.resource.blob) });
    }
    return out;
  });
  const r = Object.assign(Object.create(null) as Obj, result, { content });
  return Object.assign(Object.create(null) as Obj, body, { result: r });
}

/// The body with strings already screened on their own (text items) replaced by a short marker,
/// structure kept.
function withoutScreened(v: unknown, skip: Set<string>): unknown {
  if (typeof v === 'string') return skip.has(v) ? '[screened separately]' : v;
  if (Array.isArray(v)) return v.map((x) => withoutScreened(x, skip));
  if (isPlainObject(v)) {
    const o = Object.create(null) as Obj;
    for (const k of Object.keys(v)) o[k] = withoutScreened(v[k], skip);
    return o;
  }
  return v;
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

/// Screens every string of one message. Text items of a tool result run the full pipeline on
/// their own; every other string gets L0/L1 on its own; the rest of the body runs the full
/// pipeline as stable JSON and as joined leaves, with L2/L3 seeing the key-redacted form.
export async function screenMessage(msg: Obj, toolName: string, mcpMethod: string): Promise<ScreenOutcome> {
  const body = messageBody(msg);
  const texts = textSurfaces(body.result);
  const skip = new Set(texts);
  const noMedia = stripMedia(body);
  let worst: DetectionResult | null = null;
  let degraded = false;
  const consider = (r: DetectionResult) => {
    if (r.degraded) degraded = true;
    if (r.verdict !== 'clean' && (!worst || rankVerdict(r.verdict) > rankVerdict(worst.verdict))) worst = r;
  };
  const ctx = { toolName, mcpMethod };

  await inDecisionScope(async () => {
    for (const t of texts) consider(await runPipeline(t, ctx));

    // L0/L1 on every other string on its own (keys included): an injection is never diluted
    // by, or split across, its neighbours.
    for (const s of stringLeaves(noMedia)) {
      if (skip.has(s) || s.length < 8) continue;
      consider(runOutboundScreen(s));
    }
    // And L0/L1 over the string VALUES joined in the order the agent receives them (the passes
    // below sort keys and interleave them): a phrase split across neighbouring fields must not
    // slip between two leaves.
    consider(runOutboundScreen(stringLeaves(noMedia, 'as-sent', false).join('\n')));
    consider(runOutboundScreen(stringLeaves(noMedia, 'as-sent', true).join('\n'))); // keys too: a phrase split around a key

    const rest = withoutScreened(noMedia, skip);
    const leaves = stringLeaves(rest);
    if (leaves.every((s) => STRUCTURAL.has(s))) return;
    const redacted = withoutScreened(redactStructure(noMedia).value, skip);
    const json = stableStringify(rest);
    consider(await runPipeline(json, ctx, { modelText: stableStringify(redacted) }));
    const joined = leaves.join('\n');
    if (joined && joined !== json) consider(await runPipeline(joined, ctx, { modelText: jsonStringLeaves(redacted) }));
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

export function blockedNotice(toolName: string, reason: string): string {
  return (
    `[BLINDSEAL_BLOCKED] Response from tool '${toolName}' was flagged as potential prompt injection. ` +
    `${reason}. Original content withheld. To override, set BLINDSEAL_MODE=warn.`
  );
}

export function detectionReason(r: DetectionResult): string {
  return `Verdict: ${r.verdict}. Reasoning: ${r.reasoning}`;
}

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
  return {
    type: 'text',
    text: `[BLINDSEAL_WARNING] Tool '${toolName}' response flagged (${r.verdict}). Reasoning: ${r.reasoning}. Original content follows.`,
  };
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
      forward: buildBlockedReply(pending, blockedNotice(label, `The reply was malformed (${problem})`)),
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
    forward: buildBlockedReply(pending, blockedNotice(label, detectionReason(outcome.result))),
  };
}
