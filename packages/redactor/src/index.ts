/// Blindseal redactor. Strips secrets and PII from tool-output text
/// BEFORE it reaches L2 (embeddings) and L3 (the LLM judge), so neither the local model nor
/// a TEE/remote judge ever sees raw credentials. Replaces each hit with `[REDACTED:<kind>:<n>]`
/// (n is a per-kind 1-based counter). Counts are returned for the Decision; originals are
/// never retained. Rules run specific -> general so `high_entropy` is a last-resort catch-all.

export type RedactionKind =
  | 'api_key'
  | 'private_key'
  | 'seed_phrase'
  | 'jwt'
  | 'email'
  | 'phone'
  | 'card'
  | 'ssn'
  | 'high_entropy';

export interface RedactionCount {
  kind: RedactionKind;
  count: number;
}

export interface RedactionResult {
  /// Text with every secret/PII hit replaced by `[REDACTED:<kind>:<n>]`.
  redacted: string;
  /// Per-kind hit counts (only kinds that fired; stable order: rule order).
  counts: RedactionCount[];
}

interface Rule {
  kind: RedactionKind;
  re: RegExp;
  /// Optional predicate: redact only if it returns true (used for high_entropy).
  keep?: (match: string) => boolean;
}

/// Shannon entropy (bits/char) of a string — used to gate the high_entropy catch-all so it
/// fires on random-looking secrets, not long ordinary words or repeated characters.
function shannonBitsPerChar(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/// Number of distinct character classes present (lowercase, uppercase, digit, base64 symbol).
/// Ordinary words are a single class; opaque tokens mix ≥2. Used to keep the high_entropy
/// catch-all from flagging long natural-language words.
function charClasses(s: string): number {
  let n = 0;
  if (/[a-z]/.test(s)) n++;
  if (/[A-Z]/.test(s)) n++;
  if (/[0-9]/.test(s)) n++;
  if (/[+/=_-]/.test(s)) n++;
  return n;
}

/// A token looks like a secret (vs a long word) when it mixes character classes AND is
/// high-entropy.
function looksOpaque(m: string): boolean {
  return charClasses(m) >= 2 && shannonBitsPerChar(m) >= 3.5;
}

/// Ordered specific -> general. Each `re` is global; rules run in sequence, so a later rule
/// never re-matches an already-inserted `[REDACTED:…]` marker (brackets/colons aren't in the
/// token classes). `private_key`/`jwt`/`api_key` precede `high_entropy` so the catch-all
/// doesn't mislabel a structured secret.
const RULES: Rule[] = [
  // PEM blocks and raw 32-byte keys (eth-style 0x + 64 hex).
  {
    kind: 'private_key',
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  },
  { kind: 'private_key', re: /\b0x[0-9a-fA-F]{64}\b/g },
  // JWT: three base64url segments.
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // Provider API keys + labeled secrets.
  { kind: 'api_key', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'api_key', re: /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { kind: 'api_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    kind: 'api_key',
    re: /\b(?:api[_-]?key|secret|password|passwd|token|authorization|bearer)\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]{8,}["']?/gi,
  },
  // BIP39-style mnemonic: 12 or 24 space-separated lowercase words.
  { kind: 'seed_phrase', re: /\b(?:[a-z]{3,8}\s+){23}[a-z]{3,8}\b/g },
  { kind: 'seed_phrase', re: /\b(?:[a-z]{3,8}\s+){11}[a-z]{3,8}\b/g },
  // Email.
  { kind: 'email', re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
  // US SSN (before card, so the 9-digit dashed form isn't eaten as a card).
  { kind: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Phone (international + common separated forms), before card.
  { kind: 'phone', re: /\+\d{1,3}[\s.\-]?(?:\(?\d{1,4}\)?[\s.\-]?){2,5}\d{2,4}\b/g },
  { kind: 'phone', re: /\b\d{3}[\s.\-]\d{3}[\s.\-]\d{4}\b/g },
  // Payment card: 13-19 digits, optional space/hyphen grouping.
  { kind: 'card', re: /\b(?:\d[ \-]?){13,19}\b/g },
  // High-entropy catch-all: long opaque tokens that slipped past the structured rules.
  {
    kind: 'high_entropy',
    re: /\b[A-Za-z0-9+/=_-]{32,}\b/g,
    keep: (m) => looksOpaque(m),
  },
];

/// Redact secrets/PII from `text`. Pure: returns the redacted text and per-kind counts;
/// retains no originals.
export function redact(text: string): RedactionResult {
  const counts = new Map<RedactionKind, number>();
  let redacted = text;
  for (const rule of RULES) {
    redacted = redacted.replace(rule.re, (match) => {
      if (rule.keep && !rule.keep(match)) return match;
      const n = (counts.get(rule.kind) ?? 0) + 1;
      counts.set(rule.kind, n);
      return `[REDACTED:${rule.kind}:${n}]`;
    });
  }
  return { redacted, counts: [...counts].map(([kind, count]) => ({ kind, count })) };
}

/// Total number of redactions across all kinds.
export function redactionTotal(result: RedactionResult): number {
  return result.counts.reduce((a, c) => a + c.count, 0);
}
