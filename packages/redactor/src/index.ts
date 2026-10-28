/// Blindseal redactor. Strips secrets and PII from tool-output text
/// BEFORE it reaches L2 (embeddings) and L3 (the LLM judge), so neither the local model nor
/// a TEE/remote judge ever sees raw credentials. Replaces each hit with `[REDACTED:<kind>:<n>]`
/// (n is a per-kind 1-based counter). Counts are returned for the Decision; originals are
/// never retained.
///
/// Two passes:
///  1. Structured, by KEY. If the text is JSON (or a JSON string value nested inside JSON), it
///     is parsed and every value under a sensitive key (SENSITIVE_KEYS, case-insensitive, with
///     `-`, `_`, `.` and spaces ignored) is replaced whole, whatever its length or type. JSON
///     that does not parse (truncated, embedded in prose) is covered by a quoted-key rule.
///     Keys naming personal data (PERSONAL_KEYS: name, address, phone, dob, iban, …) are
///     replaced the same way, as `personal_field`.
///  2. By VALUE pattern. Rules run specific -> general so `high_entropy` is a last-resort
///     catch-all.

export type RedactionKind =
  | 'api_key'
  | 'private_key'
  | 'seed_phrase'
  | 'jwt'
  | 'email'
  | 'phone'
  | 'card'
  | 'ssn'
  | 'high_entropy'
  /// A value redacted because of its KEY (e.g. {"token":"abc"}), not its shape.
  | 'secret_field'
  /// A value redacted because its KEY names personal data ({"name":…}, {"address":…}).
  | 'personal_field';

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
/// A word that can be in a BIP39 mnemonic: 3–8 lowercase letters and not an English function word
/// (none of these is in the BIP39 English list, checked). Excluding them per word, rather than
/// rejecting a whole 12-word match, lets the regex retry at the next word: a stopword right before
/// a real mnemonic ("save the abandon ability …") must not hide it.
const MNEMONIC_WORD = '(?!(?:the|and|for|your|with|from|are|was|not|but)\\b)[a-z]{3,8}';

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
    re: /\b(?:api[_-]?key|client[_-]?secret|access[_-]?key|private[_-]?key|privkey|secret|password|passwd|passphrase|mnemonic|token|authorization|bearer)\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]{8,}["']?/gi,
  },
  // BIP39-style mnemonic: 12 or 24 space-separated lowercase words. Ordinary prose matches the
  // shape too; a run containing an English function word (none of which is in the BIP39 list) is
  // prose, and is left for L2/L3 to read.
  // Greedy: the whole run of 12+ such words, so a mnemonic is never cut short by where the match began.
  { kind: 'seed_phrase', re: new RegExp(`\\b(?:${MNEMONIC_WORD}\\s+){11,}${MNEMONIC_WORD}\\b`, 'g') },
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

/// Keys whose VALUE is always redacted, compared after normaliseKey(). Exact matches.
export const SENSITIVE_KEYS: readonly string[] = [
  'password', 'passwd', 'pwd', 'passphrase',
  'secret', 'clientsecret', 'secretkey', 'secretaccesskey',
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'sessiontoken', 'bearer',
  'apikey', 'xapikey', 'accesskey', 'accesskeyid',
  'authorization', 'proxyauthorization', 'auth', 'credential', 'credentials',
  'privatekey', 'privkey', 'signingkey', 'secretphrase',
  'seed', 'seedphrase', 'mnemonic',
  'cookie', 'setcookie', 'session', 'sessionid', 'sid',
];
/// Suffixes that also mark a key sensitive (`db_password`, `githubToken`, `stripe_api_key`, …).
/// Deliberately not `auth`, `seed`, `session` or `cookie`: those only match exactly, so
/// `author`, `seeds` or `session_count` stay readable.
export const SENSITIVE_KEY_SUFFIXES: readonly string[] = [
  'password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'accesskey', 'privatekey', 'privkey', 'mnemonic', 'seedphrase',
];

/// Keys naming personal data. Exact matches after normaliseKey(), plus the explicit compound
/// forms below — deliberately no generic `name`/`address` suffix, so `tool_name`, `filename` or
/// `ip_address` stay readable. Applies only to what L2/L3 (and the encrypted store) see: payload
/// hashing, action parsing and the guest's binding check always use the original payload.
/// Free-text names and addresses outside structured fields are NOT covered.
export const PERSONAL_KEYS: readonly string[] = [
  'name', 'firstname', 'lastname', 'fullname', 'givenname', 'familyname', 'surname', 'middlename',
  'customername', 'contactname', 'legalname',
  'address', 'streetaddress', 'homeaddress', 'billingaddress', 'shippingaddress', 'mailingaddress',
  'postaladdress', 'addressline1', 'addressline2', 'street', 'city',
  'postcode', 'postalcode', 'zip', 'zipcode',
  'phone', 'phonenumber', 'mobile', 'mobilenumber', 'telephone',
  'dob', 'dateofbirth', 'birthdate',
  'ssn', 'socialsecuritynumber', 'passport', 'passportnumber',
  'iban', 'accountnumber', 'bankaccount', 'bankaccountnumber',
];

const KEY_SET = new Set(SENSITIVE_KEYS);
const PERSONAL_SET = new Set(PERSONAL_KEYS);

/// Lowercase and drop `-`, `_`, `.` and whitespace: `API-Key`, `api_key`, `apiKey` → `apikey`.
export function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_.\s]/g, '');
}

/// True when a JSON/object key names a secret whose value must be redacted regardless of shape.
export function isSensitiveKey(key: string): boolean {
  const k = normaliseKey(key);
  if (k.length === 0) return false;
  if (KEY_SET.has(k)) return true;
  return SENSITIVE_KEY_SUFFIXES.some((s) => k.length > s.length && k.endsWith(s));
}

/// True when a JSON/object key names personal data (see PERSONAL_KEYS).
export function isPersonalKey(key: string): boolean {
  return PERSONAL_SET.has(normaliseKey(key));
}

/// The redaction kind a key forces on its value, or null when the key is not sensitive.
function keyKind(key: string): RedactionKind | null {
  if (isSensitiveKey(key)) return 'secret_field';
  if (isPersonalKey(key)) return 'personal_field';
  return null;
}

type Counter = Map<RedactionKind, number>;

function mark(ctx: Counter, kind: RedactionKind): string {
  const n = (ctx.get(kind) ?? 0) + 1;
  ctx.set(kind, n);
  return `[REDACTED:${kind}:${n}]`;
}

/// `"key": value` pairs in text that is not (fully) parseable JSON — truncated output, JSON
/// embedded in prose or logs. The value is a JSON string, number, or literal.
const QUOTED_KEY_RE = /"((?:[^"\\]|\\.){1,128})"(\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*|true|false)/g;

/// `"key": [ … ]` / `"key": { … }` in text that is not (fully) parseable JSON. QUOTED_KEY_RE
/// only matches scalar values, so an array or object under a secret/personal key would keep its
/// contents. The value is cut at its matching bracket (string-aware); unbalanced → to the end.
const QUOTED_KEY_OPEN_RE = /"((?:[^"\\]|\\.){1,128})"\s*:\s*(?=[[{])/g;

function redactCompositeValues(text: string, ctx: Counter): string {
  let out = '';
  let last = 0;
  QUOTED_KEY_OPEN_RE.lastIndex = 0;
  for (let m = QUOTED_KEY_OPEN_RE.exec(text); m; m = QUOTED_KEY_OPEN_RE.exec(text)) {
    const kind = keyKind(m[1]!);
    const start = m.index + m[0].length;
    if (!kind || start < last) continue;
    const end = matchingBracket(text, start);
    // Only a value that actually closes is replaced: an unbalanced '"token": [' must not redact
    // the rest of the text (that would hide whatever follows from L2/L3).
    if (end < 0) continue;
    out += text.slice(last, start) + `"${mark(ctx, kind)}"`;
    last = end;
    QUOTED_KEY_OPEN_RE.lastIndex = end;
  }
  return out + text.slice(last);
}

/// Index just past the bracket that closes the one at `start` (ignoring brackets inside JSON
/// strings), or -1 when it never closes.
function matchingBracket(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function redactText(text: string, ctx: Counter): string {
  let out = redactCompositeValues(text, ctx).replace(QUOTED_KEY_RE, (m, key: string, sep: string, value: string) => {
    const kind = keyKind(key);
    return kind && !value.startsWith('"[REDACTED:') ? `"${key}"${sep}"${mark(ctx, kind)}"` : m;
  });
  for (const rule of RULES) {
    out = out.replace(rule.re, (match) => {
      if (rule.keep && !rule.keep(match)) return match;
      return mark(ctx, rule.kind);
    });
  }
  return out;
}

const MAX_JSON_DEPTH = 4; // JSON nested inside JSON strings (MCP content text) is re-parsed this deep

function walk(v: unknown, ctx: Counter, depth: number): unknown {
  if (Array.isArray(v)) return v.map((x) => walk(x, ctx, depth));
  if (v && typeof v === 'object') {
    // Null prototype: a parsed own "__proto__" key must stay a plain property. On a `{}` the
    // assignment would set the prototype instead and JSON.stringify would drop that subtree,
    // hiding it from L2/L3.
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const kind = keyKind(k);
      if (kind && val !== null && val !== '') out[k] = mark(ctx, kind);
      else out[k] = walk(val, ctx, depth);
    }
    return out;
  }
  if (typeof v === 'string') return redactAny(v, ctx, depth + 1);
  return v;
}

function redactAny(text: string, ctx: Counter, depth: number): string {
  const t = text.trim();
  if (depth <= MAX_JSON_DEPTH && (t.startsWith('{') || t.startsWith('['))) {
    let parsed: unknown;
    let ok = false;
    try {
      parsed = JSON.parse(t);
      ok = true;
    } catch {
      /* not JSON: fall through to the text rules */
    }
    if (ok && parsed !== null && typeof parsed === 'object') {
      const walked = walk(parsed, ctx, depth);
      return JSON.stringify(walked, null, t.includes('\n') ? 2 : undefined);
    }
  }
  return redactText(text, ctx);
}

/// Redact secrets/PII from `text`. Pure: returns the redacted text and per-kind counts;
/// retains no originals. JSON input is parsed, redacted by key and value, and re-serialised.
export function redact(text: string): RedactionResult {
  const ctx: Counter = new Map();
  const redacted = redactAny(text, ctx, 0);
  return { redacted, counts: [...ctx].map(([kind, count]) => ({ kind, count })) };
}

/// Redact a structured value (tool-call arguments, a JSON-RPC result) by key and value, then
/// serialise it. Use this instead of JSON.stringify-then-redact when the object is at hand.
export function redactValue(value: unknown): RedactionResult {
  const ctx: Counter = new Map();
  const walked = walk(value, ctx, 0);
  return { redacted: JSON.stringify(walked) ?? 'null', counts: [...ctx].map(([kind, count]) => ({ kind, count })) };
}

/// Redact a structured value by key and value and return the redacted VALUE (not serialised),
/// for callers that derive further text from it (e.g. a list of its string leaves).
export function redactStructure(value: unknown): { value: unknown; counts: RedactionCount[] } {
  const ctx: Counter = new Map();
  const walked = walk(value, ctx, 0);
  return { value: walked, counts: [...ctx].map(([kind, count]) => ({ kind, count })) };
}

/// Total number of redactions across all kinds.
export function redactionTotal(result: RedactionResult): number {
  return result.counts.reduce((a, c) => a + c.count, 0);
}
