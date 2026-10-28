/// SSE event-stream scanner for the HTTP transport. Each Server-Sent Event is parsed,
/// the `data:` field is extracted, JSON-decoded, and if it's a JSON-RPC tool-call response
/// the same detection pipeline that runs against non-streaming responses is applied. Modified
/// messages are re-serialized into the SSE event before forwarding to the client.
///
/// Spec: per https://html.spec.whatwg.org/multipage/server-sent-events.html SSE events are
/// blocks of `field: value` lines separated by blank lines (`\n\n` or `\r\n\r\n`). Multiple
/// `data:` lines in one event concatenate with `\n`. Comments start with `:`.

import {
  inspectToolCallResponse,
  isToolCallResponse,
  type JsonRpcMessage,
  type BlindsealMode,
  type ToolCallResult,
} from './shared.js';
import { screeningErrorResponse } from '../audit/index.js';

export interface SseScanHooks {
  /// Tool name to use when no per-id name is known (legacy single-call callers).
  toolName: string | null;
  /// Resolve the tool name of a response by its JSON-RPC id (batch requests). Responses with no
  /// known name are still screened, as 'unknown'.
  toolNameFor?: (id: string | number | undefined) => string | undefined;
  mode: BlindsealMode;
  /// Invoked AFTER inspectToolCallResponse mutates (or doesn't). Lets the transport hook
  /// audit, persistence, taint, attestation.
  onScanned?: (
    msg: JsonRpcMessage & { result: ToolCallResult },
    toolName: string,
    outcome: Awaited<ReturnType<typeof inspectToolCallResponse>>,
  ) => void | Promise<void>;
  /// Screening of one element threw: it is withheld (replaced by a JSON-RPC error).
  onScreeningError?: (msg: JsonRpcMessage & { result: ToolCallResult }, toolName: string, err: unknown) => void;
}

interface ParsedEvent {
  /// Original event block (newline-terminated lines, without the trailing blank line).
  raw: string;
  /// Lines that aren't `data:` (event:, id:, retry:, :comments). Preserved verbatim.
  preLines: string[];
  /// Concatenated payload from one or more `data:` lines.
  data: string | null;
}

export function parseSseEvent(block: string): ParsedEvent {
  const lines = block.split(/\r?\n/);
  const preLines: string[] = [];
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith('data:')) {
      // Per spec: strip exactly one leading space if present.
      let v = line.slice(5);
      if (v.startsWith(' ')) v = v.slice(1);
      dataLines.push(v);
    } else {
      preLines.push(line);
    }
  }
  return {
    raw: block,
    preLines,
    data: dataLines.length === 0 ? null : dataLines.join('\n'),
  };
}

export function serializeSseEvent(preLines: string[], data: string | null): string {
  const out: string[] = [...preLines];
  if (data !== null) {
    // Split on newlines so multi-line data is correctly encoded.
    for (const piece of data.split('\n')) out.push(`data: ${piece}`);
  }
  return out.join('\n') + '\n\n';
}

/// Process one fully-assembled SSE event block. Returns the byte string to forward.
export async function processSseEvent(block: string, hooks: SseScanHooks): Promise<string> {
  const parsed = parseSseEvent(block);
  if (parsed.data === null) {
    // No data — pass through verbatim, preserving the trailing blank line.
    return block + '\n\n';
  }

  let msg: JsonRpcMessage | JsonRpcMessage[] | null;
  try { msg = JSON.parse(parsed.data) as JsonRpcMessage | JsonRpcMessage[]; } catch { msg = null; }
  if (!msg || typeof msg !== 'object') {
    // Not JSON — pass through verbatim.
    return block + '\n\n';
  }

  // A batch response arrives as one JSON array in one event: screen every element.
  if (Array.isArray(msg)) {
    let changed = false;
    const out: unknown[] = [];
    for (const el of msg as unknown[]) {
      if (el && typeof el === 'object' && !Array.isArray(el)) {
        const r = await screenElement(el as JsonRpcMessage, hooks);
        if (r.screened) changed = true;
        out.push(r.msg);
      } else out.push(el);
    }
    return changed ? serializeSseEvent(parsed.preLines, JSON.stringify(out)) : block + '\n\n';
  }

  const r = await screenElement(msg, hooks);
  // Re-serialize the (possibly mutated) message; anything else passes through verbatim.
  return r.screened ? serializeSseEvent(parsed.preLines, JSON.stringify(r.msg)) : block + '\n\n';
}

async function screenElement(msg: JsonRpcMessage, hooks: SseScanHooks): Promise<{ msg: JsonRpcMessage; screened: boolean }> {
  // Non-tool-call messages (initialize, tools/list, errors, notifications) pass through.
  if (!isToolCallResponse(msg)) return { msg, screened: false };
  const toolName = hooks.toolNameFor?.(msg.id) ?? hooks.toolName ?? 'unknown';
  let outcome: Awaited<ReturnType<typeof inspectToolCallResponse>>;
  try {
    outcome = await inspectToolCallResponse(msg, toolName, hooks.mode);
  } catch (err) {
    if (!hooks.onScreeningError) throw err;
    hooks.onScreeningError(msg, toolName, err);
    return { msg: screeningErrorResponse(msg.id ?? null) as unknown as JsonRpcMessage, screened: true };
  }
  if (hooks.onScanned) await hooks.onScanned(msg, toolName, outcome);
  return { msg, screened: true };
}

/// Stream-scans an SSE upstream response. Reads chunks from the upstream body, buffers until
/// each event boundary (`\n\n` or `\r\n\r\n`), processes the event, and writes to the sink.
/// `write` is invoked with the bytes to forward to the client; `end` signals stream end.
export async function streamScanSse(
  upstreamBody: ReadableStream<Uint8Array>,
  hooks: SseScanHooks,
  write: (chunk: string) => void,
): Promise<void> {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const idx = findEventBoundary(buffer);
        if (idx === -1) break;
        const block = buffer.slice(0, idx.start);
        buffer = buffer.slice(idx.end);
        if (block.length === 0) continue; // empty leading blanks
        const out = await processSseEvent(block, hooks);
        write(out);
      }
    }

    // Flush trailing decoder bytes.
    buffer += decoder.decode();

    // Process any trailing event without a final blank line.
    if (buffer.trim().length > 0) {
      const out = await processSseEvent(buffer, hooks);
      write(out);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

/// Finds the next event-boundary in the buffer. Handles both `\n\n` and `\r\n\r\n`. Returns
/// the [start, end) indices of the boundary so the caller can slice (`buffer.slice(0, start)`
/// is the event, `buffer.slice(end)` is what remains).
function findEventBoundary(s: string): { start: number; end: number } | -1 {
  const idxLf = s.indexOf('\n\n');
  const idxCrlf = s.indexOf('\r\n\r\n');
  if (idxLf === -1 && idxCrlf === -1) return -1;
  if (idxCrlf === -1) return { start: idxLf, end: idxLf + 2 };
  if (idxLf === -1) return { start: idxCrlf, end: idxCrlf + 4 };
  // Take the earlier of the two.
  if (idxLf < idxCrlf) return { start: idxLf, end: idxLf + 2 };
  return { start: idxCrlf, end: idxCrlf + 4 };
}
