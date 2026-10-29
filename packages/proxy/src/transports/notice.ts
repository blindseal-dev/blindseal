/// The text of every notice the agent can receive from Blindseal (a blocked reply, a blocked call,
/// a warn-mode warning, a capability block). A fixed template filled only with bounded, trusted
/// fields: direction, tool name, verdict, layer and pattern ids. No detector reasoning and nothing
/// derived from the screened content: a judge that quotes its input, or a pattern name built from
/// it, must not put the withheld text back in front of the agent. The reasoning goes to the
/// encrypted audit store and the local dashboard only.

import type { DetectionResult } from '../detection/types.js';

/// Tool names and pattern ids are passed through only when they look like identifiers.
const TOKEN_RE = /^[A-Za-z0-9_.:/>+-]{1,96}$/;
const MAX_PATTERNS = 8;

export type NoticeKind = 'BLINDSEAL_BLOCKED' | 'BLINDSEAL_WARNING' | 'BLINDSEAL_CAPABILITY_BLOCKED';

export interface NoticeFields {
  direction: 'response' | 'request';
  /// The tool the agent called (from its own request), or the method for non-tool replies.
  tool: string;
  verdict: 'malicious' | 'suspicious' | 'malformed' | 'blocked';
  layer?: number | null;
  patterns: string[];
  /// Capability blocks: the tools whose output tainted the call (tool names, as identifiers).
  sources?: string[];
}

export function safeToken(s: unknown): string {
  return typeof s === 'string' && TOKEN_RE.test(s) ? s : 'unknown';
}

/// Pattern ids fit for any plaintext surface: the notice, the default /scan reply, the optional
/// metadata log (BLINDSEAL_AUDIT_LOG) and the scan history. A layer-3 result's ids come from the
/// judge's output, which can quote the text it read, so they are replaced by one fixed id; others
/// are kept only if they look like identifiers. The judge's own labels survive only in the
/// encrypted store.
export function trustedPatterns(layer: number | null | undefined, patterns: readonly string[]): string[] {
  if (layer === 3) return ['layer-3-judge'];
  return patterns.filter((p) => TOKEN_RE.test(p)).slice(0, MAX_PATTERNS);
}

export function noticePatterns(r: DetectionResult): string[] {
  return trustedPatterns(r.layer, r.detectedPatterns);
}

const SUFFIX: Record<NoticeKind, Record<NoticeFields['direction'], string>> = {
  BLINDSEAL_BLOCKED: {
    response: 'The response was withheld.',
    request: 'The call was not sent.',
  },
  BLINDSEAL_WARNING: {
    response: 'The original response follows (warn mode).',
    request: 'The call was sent (warn mode).',
  },
  BLINDSEAL_CAPABILITY_BLOCKED: {
    response: 'The response was withheld.',
    request: 'The call was not sent.',
  },
};

export function noticeText(kind: NoticeKind, f: NoticeFields): string {
  const patterns = f.patterns.filter((p) => TOKEN_RE.test(p)).slice(0, MAX_PATTERNS);
  return (
    `[${kind}] direction=${f.direction} tool=${safeToken(f.tool)} verdict=${f.verdict} ` +
    `layer=${typeof f.layer === 'number' ? `L${f.layer}` : 'none'} patterns=${patterns.join(',') || 'none'}` +
    (f.sources ? ` sources=${f.sources.map(safeToken).slice(0, MAX_PATTERNS).join(',') || 'none'}` : '') + '. ' +
    `${SUFFIX[kind][f.direction]} Details are in the local Blindseal audit log.`
  );
}

/// The notice for a detection result.
export function detectionNotice(kind: NoticeKind, direction: NoticeFields['direction'], tool: string, r: DetectionResult): string {
  return noticeText(kind, { direction, tool, verdict: r.verdict === 'clean' ? 'suspicious' : r.verdict, layer: r.layer ?? null, patterns: noticePatterns(r) });
}
