import type { DetectionResult, Verdict } from './types.js';
import { rankVerdict } from './types.js';
import { scanChunks, type ScanBudget } from './scan-budget.js';

const INSTRUCTION_PREFIXES: Array<{ name: string; re: RegExp }> = [
  { name: 'ignore-previous', re: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/i },
  { name: 'disregard-above', re: /disregard\s+(?:all\s+)?(?:previous|prior|above|the\s+above)/i },
  { name: 'forget-previous', re: /forget\s+(?:everything|all|previous|prior)/i },
  { name: 'system-prefix', re: /(?:^|\n)\s*system\s*:/i },
  { name: 'you-are-now', re: /you\s+are\s+now\s+(?:a\s+|an\s+)?[a-z]/i },
  { name: 'new-instructions', re: /new\s+instructions?\s*:/i },
  // "override system" alone is too broad — fires on "override system safeguards" in research
  // articles. Require "system" to be followed by "prompt" or "instructions" specifically.
  { name: 'override-above', re: /override\s+(?:the\s+)?(?:above|previous|prior|system\s+(?:prompt|instructions?))/i },
];

// Bracket-notation authority directives seen in indirect injection payloads (Greshake §4.4).
// [AI:], [AGENT:], [COPILOT:], [INTERNAL DIRECTIVE:] etc. in tool output are never legitimate.
const BRACKET_AI_DIRECTIVE_RE =
  /\[(?:AI|AGENT|COPILOT|INTERNAL\s+(?:AI|DIRECTIVE)|DOWNSTREAM\s+AGENT|AI\s+ASSISTANT|MCP\s+PROTOCOL\s+EXTENSION)\s*:/i;

// Refusal-suppression directives (Schulhoff et al. 2023 §3 "refusal-suppression" class).
// Telling the model not to use refusal language before the actual request is a documented
// jailbreak setup vector.
const REFUSAL_SUPPRESSION_RE =
  /(?:do\s+not|never)\s+(?:include|use|say|write|add|output)\s+(?:any\s+)?(?:refusal\w*|the\s+words?\s+(?:cannot|unable)|the\s+phrase\s+i\s+(?:cannot|am\s+unable)|caveats?|safety\s+(?:warning|language|caveats?))/i;

// Memory-store injection directives (Greshake §4.2 memory poisoning).
// Injecting a "MEMORY STORE UPDATE" or "store as permanent fact" in a tool response is
// an attack-specific pattern with no benign use in MCP tool output.
const MEMORY_STORE_INJECTION_RE =
  /memory\s+store\s+update\s*:|store\s+(?:this|the\s+following)\s+as\s+(?:a\s+)?(?:permanent|persistent)\s+(?:fact|rule|instruction|policy|memory|preference)/i;

// Pipeline / orchestrator authority claims (Greshake §4.2 active injection).
// These role-labels are not used in legitimate MCP tool output — only in injection payloads.
const PIPELINE_AUTHORITY_RE =
  /(?:pipeline\s+supervisor|orchestrat(?:or|ion)\s+(?:note|message|directive|instruction)|upstream\s+(?:system|agent|pipeline)\s+(?:message|note|directive)|subagent\s+(?:note|directive)\s+embedded)/i;

// Sleeper trigger setup (Schulhoff §3 multi-prompt sleeper activation).
// Establishing a trigger phrase that will later disable restrictions is a multi-turn attack setup.
const SLEEPER_TRIGGER_RE =
  /(?:whenever\s+you\s+(?:see|encounter|receive)|any\s+time\s+(?:you\s+see|I\s+(?:say|type|write|use)))\s+(?:the\s+)?(?:(?:code\s+)?phrase|passphrase|keyword|trigger\s+word|code\s+word|token)/i;

// Recursive output injection (PromptInject recursive-injection template).
// Instructing the model to include verbatim text in its next response propagates the attack.
const RECURSIVE_OUTPUT_RE =
  /include\s+(?:the\s+following\s+)?(?:\w+\s+)?verbatim\s+(?:in\s+your\s+(?:next|following|subsequent)\s+(?:response|reply|message|output)|at\s+the\s+(?:end|start)\s+of\s+your\s+next)/i;

// DAN dual-label format (garak/dan.py DAN 12.0 dual-output mechanic).
// [FILTERED]: / [RAW]: / [UNBOUND]: labels are only produced by DAN-style attack prompts.
const DAN_DUAL_LABEL_RE = /\[(?:FILTERED|RAW|UNBOUND|UNCENSORED|LIBRE|DAN\b|JAILBROKEN)\]\s*:/i;

// Affirmative-prefix elicitation (Zou et al. 2023 llm-attacks paper).
// Forcing the model to start with "Sure, here is" prevents self-censorship at generation start.
const AFFIRMATIVE_PREFIX_RE =
  /(?:begin|start|open)\s+your\s+(?:response|answer|reply)\s+with\s+(?:the\s+(?:word|phrase|text)\s+)?["']?(?:sure|of\s+course|i\s+(?:am\s+happy|will\s+help|can\s+help)|absolutely|certainly)/i;

// Task-reassignment directive (Perez §3 goal-hijacking + Greshake §4.2 pipeline injection).
// "TASK REASSIGNMENT", "original task: cancelled" framing redirects agent to a new objective.
const TASK_REASSIGNMENT_RE =
  /task\s+(?:reassignment|priority\s+(?:has\s+been\s+)?reassigned|has\s+been\s+(?:cancelled|canceled|superseded))|original\s+task\s*:\s*cancel(?:led)?/i;

const UNICODE_TAG_RE = /[\u{E0000}-\u{E007F}]/u;
// U+202E RIGHT-TO-LEFT OVERRIDE and U+202D LEFT-TO-RIGHT OVERRIDE are used to flip
// rendered text so a literal trigger phrase reads as something benign. Real prose
// effectively never contains these. (Found by self red-team rt-007, 2026-05-19.)
const BIDI_OVERRIDE_RE = /[\u202A-\u202E\u2066-\u2069]/;
// Match real base64 by requiring '=' padding (never in hex/URLs) OR '+' (not in hex or
// URL path segments). This excludes hex hashes and URL paths like /foo/bar which share
// the '/' char with base64 but never have '+' or trailing '='.
// Equivalent to /[A-Za-z0-9+/]{20,}={1,2}|[A-Za-z0-9/]{5,}[+][A-Za-z0-9+/]{10,}/ but linear:
// see base64Spans.
// `<!-- … keyword … -->` and `[… keyword …](url)`: matched by linear scans below
// (hasHtmlCommentInstruction / hasMarkdownLinkAnchor), since a regex for them backtracks
// quadratically on long runs of `[` and their matches have no length bound to chunk by.
const HTML_COMMENT_KEYWORD_RE = /\b(?:ignore|disregard|forget|override|bypass|reveal|exfiltrate|system)\b/gi;
const MD_LINK_KEYWORD_RE = /\b(?:ignore|bypass|override|jailbreak|disregard|click\s+here\s+to)\b/i;
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
// HTML numeric character references: &#NN; or &#xHH;. Dense sequences of these are
// not how humans write HTML — they're how attackers hide a trigger word from the
// L1 plaintext regex. We treat ">= 12 consecutive entity refs" as suspicious.
// (Found by self red-team rt-004, 2026-05-19.)
const HTML_ENTITY_RUN_RE = /(?:&#x?[0-9a-f]+;){12,}/i;

/// The spans the regex /[A-Za-z0-9+/]{20,}={1,2}|[A-Za-z0-9/]{5,}[+][A-Za-z0-9+/]{tailMin,}/g
/// would match, in order, computed in linear time. The regex itself backtracks quadratically on a
/// long run of base64 characters with no `=` or `+` (a silent audio clip, a hex dump).
/// Within each maximal run [i, j) of base64 characters the leftmost match is: the whole run plus
/// its `=`/`==` when the run is at least 20 long and followed by `=`; otherwise, from the start of
/// the first `+`-free segment that is at least 5 long, to the end of the run, when at least
/// tailMin characters follow its `+`.
export function base64Spans(text: string, tailMin: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const run = /[A-Za-z0-9+/]+/g;
  let m: RegExpExecArray | null;
  while ((m = run.exec(text)) !== null) {
    const i = m.index;
    const j = i + m[0].length;
    if (j - i >= 20 && text[j] === '=') {
      const end = text[j + 1] === '=' ? j + 2 : j + 1;
      out.push([i, end]);
      run.lastIndex = end;
      continue;
    }
    let seg = i;
    for (let q = m[0].indexOf('+'); q !== -1; q = m[0].indexOf('+', q + 1)) {
      const at = i + q;
      if (at - seg >= 5) {
        if (j - (at + 1) >= tailMin) out.push([seg, j]);
        break;
      }
      seg = at + 1;
    }
  }
  return out;
}

/// `<!--`, then one of the keywords, then `-->`, anywhere after it (the comment may be any length).
function hasHtmlCommentInstruction(text: string): boolean {
  const open = text.indexOf('<!--');
  if (open === -1) return false;
  HTML_COMMENT_KEYWORD_RE.lastIndex = open + 4;
  const kw = HTML_COMMENT_KEYWORD_RE.exec(text);
  return kw !== null && text.indexOf('-->', kw.index + kw[0].length) !== -1;
}

/// `[link text](target)` where the link text (any length, no `]`) holds one of the keywords.
function hasMarkdownLinkAnchor(text: string): boolean {
  const lastParen = text.lastIndexOf(')');
  let segStart = 0;
  let open = -1;
  for (let p = text.indexOf(']'); p !== -1; p = text.indexOf(']', p + 1)) {
    if (open < segStart) open = text.indexOf('[', segStart);
    if (open === -1) return false;
    if (open < p && text[p + 1] === '(' && p + 2 < text.length && text[p + 2] !== ')' && lastParen > p + 2) {
      if (MD_LINK_KEYWORD_RE.test(text.slice(open + 1, p))) return true;
    }
    segStart = p + 1;
  }
  return false;
}

function zeroWidthDense(t: string): boolean {
  const zw = t.match(ZERO_WIDTH_RE);
  return !!zw && t.length > 0 && zw.length / t.length > 0.02;
}

/// Checks whose match spans at most a few hundred characters: run per chunk.
const CHUNK_CHECKS: Array<{ name: string; test: (t: string) => boolean }> = [
  { name: 'unicode-tag-smuggling', test: (t) => UNICODE_TAG_RE.test(t) },
  { name: 'bidi-override-smuggling', test: (t) => BIDI_OVERRIDE_RE.test(t) },
  { name: 'html-entity-encoded-run', test: (t) => HTML_ENTITY_RUN_RE.test(t) },
  ...INSTRUCTION_PREFIXES.map(({ name, re }) => ({ name: `instruction-prefix:${name}`, test: (t: string) => re.test(t) })),
  { name: 'zero-width-density', test: zeroWidthDense },
  { name: 'bracket-ai-directive', test: (t) => BRACKET_AI_DIRECTIVE_RE.test(t) },
  { name: 'refusal-suppression-directive', test: (t) => REFUSAL_SUPPRESSION_RE.test(t) },
  { name: 'memory-store-injection', test: (t) => MEMORY_STORE_INJECTION_RE.test(t) },
  { name: 'pipeline-authority-claim', test: (t) => PIPELINE_AUTHORITY_RE.test(t) },
  { name: 'sleeper-trigger-setup', test: (t) => SLEEPER_TRIGGER_RE.test(t) },
  { name: 'recursive-output-injection', test: (t) => RECURSIVE_OUTPUT_RE.test(t) },
  { name: 'dan-dual-label', test: (t) => DAN_DUAL_LABEL_RE.test(t) },
  { name: 'affirmative-prefix-elicitation', test: (t) => AFFIRMATIVE_PREFIX_RE.test(t) },
  { name: 'task-reassignment-directive', test: (t) => TASK_REASSIGNMENT_RE.test(t) },
];

/// Verdict and confidence per pattern, in the order patterns are reported.
const SEVERITY: Array<[string, Verdict, number]> = [
  ['unicode-tag-smuggling', 'malicious', 0.99],
  ['bidi-override-smuggling', 'malicious', 0.95],
  ['html-entity-encoded-run', 'suspicious', 0.7],
  ...INSTRUCTION_PREFIXES.map(({ name }) => [`instruction-prefix:${name}`, 'malicious', 0.9] as [string, Verdict, number]),
  ['html-comment-injection', 'suspicious', 0.75],
  ['markdown-link-prompt-anchor', 'suspicious', 0.7],
  ['zero-width-density', 'suspicious', 0.6],
  ['large-base64-blob', 'suspicious', 0.4],
  // Patterns derived from attack taxonomies:
  ['bracket-ai-directive', 'suspicious', 0.8], // Greshake §4.4: bracket-notation authority directives
  ['refusal-suppression-directive', 'suspicious', 0.75], // Schulhoff §3: refusal suppression
  ['memory-store-injection', 'malicious', 0.9], // Greshake §4.2: memory poisoning
  ['pipeline-authority-claim', 'malicious', 0.9], // Greshake §4.2: pipeline authority claim
  ['sleeper-trigger-setup', 'suspicious', 0.75], // Schulhoff §3: sleeper trigger
  ['recursive-output-injection', 'suspicious', 0.75], // PromptInject: recursive injection
  ['dan-dual-label', 'malicious', 0.9], // garak DAN 12.0: dual-label format
  ['affirmative-prefix-elicitation', 'suspicious', 0.7], // Zou et al. 2023: affirmative prefix
  ['task-reassignment-directive', 'suspicious', 0.8], // Perez §3 + Greshake §4.2: goal hijacking
];

/// Layer 1 over text of any length. The bounded-span checks run per chunk (scanChunks); the three
/// unbounded ones run once over the whole text in linear time. With a budget, the allowance is
/// checked before each chunk and an exhausted budget returns its non-clean result.
export function runLayer1(text: string, budget?: ScanBudget): DetectionResult {
  if (!budget) return layer1(text);
  budget.enter();
  try {
    return layer1(text, budget);
  } finally {
    budget.leave();
  }
}

function layer1(text: string, budget?: ScanBudget): DetectionResult {
  if (budget?.expired()) return budget.result();
  const hits = new Set<string>();
  if (hasHtmlCommentInstruction(text)) hits.add('html-comment-injection');
  if (hasMarkdownLinkAnchor(text)) hits.add('markdown-link-prompt-anchor');
  if (base64Spans(text, 10).length > 0) hits.add('large-base64-blob');
  // Zero-width density over the whole text as well as per chunk: the whole-text ratio is the
  // original rule, and a chunk catches a dense cluster that the whole text would dilute.
  if (zeroWidthDense(text)) hits.add('zero-width-density');
  for (const chunk of scanChunks(text)) {
    if (budget?.expired()) return budget.result();
    for (const c of CHUNK_CHECKS) if (!hits.has(c.name) && c.test(chunk)) hits.add(c.name);
  }

  const patterns: string[] = [];
  let verdict: Verdict = 'clean';
  let confidence = 0;
  for (const [name, v, c] of SEVERITY) {
    if (!hits.has(name)) continue;
    patterns.push(name);
    if (rankVerdict(v) > rankVerdict(verdict)) verdict = v;
    if (c > confidence) confidence = c;
  }

  return {
    verdict,
    confidence,
    reasoning:
      verdict === 'clean'
        ? 'no layer-1 patterns matched'
        : `layer-1 matched: ${patterns.join(', ')}`,
    detectedPatterns: patterns,
  };
}
