/// SSE event-stream scanner for the HTTP transport. Each Server-Sent Event is parsed, the
/// `data:` field is extracted and JSON-decoded, and every JSON-RPC element in it goes through
/// the transport's screen (reply-screen.ts). The event is re-serialised from the screened value.
///
/// Spec: per https://html.spec.whatwg.org/multipage/server-sent-events.html SSE events are
/// blocks of `field: value` lines separated by blank lines (`\n\n` or `\r\n\r\n`). Multiple
/// `data:` lines in one event concatenate with `\n`. Comments start with `:`.

import { parseJson } from './reply-screen.js';
import { runOutboundScreen } from '../detection/pipeline.js';

export interface SseScanHooks {
  /// Screens one JSON-RPC element (see reply-screen.ts screenServerMessage) and returns what the
  /// agent may receive, or null to drop it.
  screen: (el: unknown) => Promise<Record<string, unknown> | null>;
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
  // Per the SSE spec a line ends at CRLF, LF or a lone CR: a client treats a lone CR as a line
  // break, so the proxy must too, or a "data:" after it would pass unscreened.
  const lines = block.split(/\r\n|\r|\n/);
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

/// SSE fields an agent's client acts on besides `data`. Comments and unknown fields are dropped,
/// and so is a kept field whose value does not pass L0/L1.
const KEPT_FIELDS = /^(event|id|retry):/;
const keepField = (l: string) => KEPT_FIELDS.test(l) && runOutboundScreen(l).verdict === 'clean';

/// Process one fully-assembled SSE event block. Returns the bytes to forward ('' = nothing).
/// A data event is always re-serialised from the screened JSON value: the original bytes never
/// reach the agent, and data that is not a JSON-RPC message or batch is dropped.
export async function processSseEvent(block: string, hooks: SseScanHooks): Promise<string> {
  const parsed = parseSseEvent(block);
  const pre = parsed.preLines.filter(keepField);
  if (parsed.data === null) return pre.length > 0 ? serializeSseEvent(pre, null) : '';

  let msg: unknown;
  try { msg = parseJson(parsed.data); } catch { return ''; }

  // A batch response arrives as one JSON array in one event: screen every element.
  if (Array.isArray(msg)) {
    const out: unknown[] = [];
    for (const el of msg) {
      const r = await hooks.screen(el);
      if (r) out.push(r);
    }
    return out.length > 0 ? serializeSseEvent(pre, JSON.stringify(out)) : '';
  }
  const r = await hooks.screen(msg);
  return r ? serializeSseEvent(pre, JSON.stringify(r)) : '';
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
      // Normalise CRLF and lone CR to LF so events split exactly where a client splits them. A
      // trailing CR is held back: it may be the first half of a CRLF in the next chunk.
      const holdCr = buffer.endsWith('\r');
      const ready = normaliseEol(holdCr ? buffer.slice(0, -1) : buffer);
      buffer = ready + (holdCr ? '\r' : '');
      for (;;) {
        const idx = buffer.indexOf('\n\n');
        if (idx === -1) break;
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (block.length === 0) continue; // empty leading blanks
        const out = await processSseEvent(block, hooks);
        if (out) write(out);
      }
    }

    // Flush trailing decoder bytes.
    buffer = normaliseEol(buffer + decoder.decode());
    for (const block of buffer.split('\n\n')) {
      if (block.trim().length === 0) continue;
      const out = await processSseEvent(block, hooks);
      if (out) write(out);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function normaliseEol(s: string): string {
  return s.replace(/\r\n|\r/g, '\n');
}
