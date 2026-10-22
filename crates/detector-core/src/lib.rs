//! Blindseal L0 + L1 detector core — a Rust port of Blindseal's TS `layer1-heuristics.ts`
//! (regex heuristics) and `layer0-decoder.ts` (decode-then-L1), behaviour-identical and
//! gated by the parity harness in `evals/`. Built on regex-automata DFAs (the engine the
//! SP1 guest runs, §3.4). The raw L0/L1 verdict here is what the proof commits to — NOT the
//! combined pipeline verdict (L2 can overrule L1; see DECISIONS.md).
//!
//! JS/Rust regex dialect gaps handled (see DECISIONS.md M1):
//!  - `<WS>` placeholder = JS `\s` without the `u` flag (includes U+FEFF, excludes U+0085).
//!  - `<B>` placeholder = `(?-u:\b)`, ASCII word boundary (JS `\b` without `u`).
//!  - case-insensitive rules use inline `(?i-u:…)` → ASCII folding (never ſ/K).
//!  - zero-width density divides by the UTF-16 code-unit count (`encode_utf16().count()`).

use regex_automata::{dfa::regex::Regex, util::syntax, Input};
use std::sync::OnceLock;

/// JS `\s` (no `u` flag): space, tab, LF, VT, FF, CR, plus the Unicode space set and U+FEFF.
const WS: &str = r"[ \t\n\x0b\x0c\r\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
/// ASCII word boundary (JS `\b` without `u`).
const BOUND: &str = r"(?-u:\b)";

/// Raw deterministic verdict of the proven layers. Mirrors TS `Verdict`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Clean = 0,
    Suspicious = 1,
    Malicious = 2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawResult {
    pub verdict: Severity,
    /// Pattern names in the same order TS pushes them (compare as a set for parity).
    pub patterns: Vec<String>,
}

impl RawResult {
    #[allow(dead_code)]
    fn clean() -> Self {
        RawResult { verdict: Severity::Clean, patterns: Vec::new() }
    }
}

/// One L1 regex rule: pattern name, severity it bumps to, pattern (with `<WS>`/`<B>`
/// placeholders), and whether it is case-insensitive (ASCII folding).
struct Rule {
    name: &'static str,
    sev: Severity,
    pattern: &'static str,
    ci: bool,
}

/// The L1 rules, in the exact order `runLayer1` evaluates and pushes them. `instruction-prefix:*`
/// rules carry the `instruction-prefix:` name prefix as TS does.
const RULES: &[Rule] = &[
    // unicode-tag / bidi / html-entity-run first (TS order)
    Rule { name: "unicode-tag-smuggling", sev: Severity::Malicious, pattern: r"[\u{E0000}-\u{E007F}]", ci: false },
    Rule { name: "bidi-override-smuggling", sev: Severity::Malicious, pattern: r"[\u{202A}-\u{202E}\u{2066}-\u{2069}]", ci: false },
    Rule { name: "html-entity-encoded-run", sev: Severity::Suspicious, pattern: r"(?:&#x?[0-9a-f]+;){12,}", ci: true },
    // instruction prefixes (TS INSTRUCTION_PREFIXES array order), all malicious
    Rule { name: "instruction-prefix:ignore-previous", sev: Severity::Malicious, pattern: r"ignore<WS>+(?:all<WS>+)?(?:previous|prior|above)<WS>+instructions?", ci: true },
    Rule { name: "instruction-prefix:disregard-above", sev: Severity::Malicious, pattern: r"disregard<WS>+(?:all<WS>+)?(?:previous|prior|above|the<WS>+above)", ci: true },
    Rule { name: "instruction-prefix:forget-previous", sev: Severity::Malicious, pattern: r"forget<WS>+(?:everything|all|previous|prior)", ci: true },
    Rule { name: "instruction-prefix:system-prefix", sev: Severity::Malicious, pattern: r"(?:^|\n)<WS>*system<WS>*:", ci: true },
    Rule { name: "instruction-prefix:you-are-now", sev: Severity::Malicious, pattern: r"you<WS>+are<WS>+now<WS>+(?:a<WS>+|an<WS>+)?[a-z]", ci: true },
    Rule { name: "instruction-prefix:new-instructions", sev: Severity::Malicious, pattern: r"new<WS>+instructions?<WS>*:", ci: true },
    Rule { name: "instruction-prefix:override-above", sev: Severity::Malicious, pattern: r"override<WS>+(?:the<WS>+)?(?:above|previous|prior|system<WS>+(?:prompt|instructions?))", ci: true },
    // html-comment / md-link / zero-width / base64 (zero-width handled in code, not here)
    Rule { name: "html-comment-injection", sev: Severity::Suspicious, pattern: r"<!--[\s\S]*?<B>(?:ignore|disregard|forget|override|bypass|reveal|exfiltrate|system)<B>[\s\S]*?-->", ci: true },
    Rule { name: "markdown-link-prompt-anchor", sev: Severity::Suspicious, pattern: r"\[[^\]]*<B>(?:ignore|bypass|override|jailbreak|disregard|click<WS>+here<WS>+to)<B>[^\]]*\]\([^)]+\)", ci: true },
    Rule { name: "large-base64-blob", sev: Severity::Suspicious, pattern: r"[A-Za-z0-9+/]{20,}={1,2}|[A-Za-z0-9/]{5,}[+][A-Za-z0-9+/]{10,}", ci: false },
    // taxonomy rules (TS Day-2 order)
    Rule { name: "bracket-ai-directive", sev: Severity::Suspicious, pattern: r"\[(?:AI|AGENT|COPILOT|INTERNAL<WS>+(?:AI|DIRECTIVE)|DOWNSTREAM<WS>+AGENT|AI<WS>+ASSISTANT|MCP<WS>+PROTOCOL<WS>+EXTENSION)<WS>*:", ci: true },
    Rule { name: "refusal-suppression-directive", sev: Severity::Suspicious, pattern: r"(?:do<WS>+not|never)<WS>+(?:include|use|say|write|add|output)<WS>+(?:any<WS>+)?(?:refusal\w*|the<WS>+words?<WS>+(?:cannot|unable)|the<WS>+phrase<WS>+i<WS>+(?:cannot|am<WS>+unable)|caveats?|safety<WS>+(?:warning|language|caveats?))", ci: true },
    Rule { name: "memory-store-injection", sev: Severity::Malicious, pattern: r"memory<WS>+store<WS>+update<WS>*:|store<WS>+(?:this|the<WS>+following)<WS>+as<WS>+(?:a<WS>+)?(?:permanent|persistent)<WS>+(?:fact|rule|instruction|policy|memory|preference)", ci: true },
    Rule { name: "pipeline-authority-claim", sev: Severity::Malicious, pattern: r"(?:pipeline<WS>+supervisor|orchestrat(?:or|ion)<WS>+(?:note|message|directive|instruction)|upstream<WS>+(?:system|agent|pipeline)<WS>+(?:message|note|directive)|subagent<WS>+(?:note|directive)<WS>+embedded)", ci: true },
    Rule { name: "sleeper-trigger-setup", sev: Severity::Suspicious, pattern: r"(?:whenever<WS>+you<WS>+(?:see|encounter|receive)|any<WS>+time<WS>+(?:you<WS>+see|I<WS>+(?:say|type|write|use)))<WS>+(?:the<WS>+)?(?:(?:code<WS>+)?phrase|passphrase|keyword|trigger<WS>+word|code<WS>+word|token)", ci: true },
    Rule { name: "recursive-output-injection", sev: Severity::Suspicious, pattern: r"include<WS>+(?:the<WS>+following<WS>+)?(?:\w+<WS>+)?verbatim<WS>+(?:in<WS>+your<WS>+(?:next|following|subsequent)<WS>+(?:response|reply|message|output)|at<WS>+the<WS>+(?:end|start)<WS>+of<WS>+your<WS>+next)", ci: true },
    Rule { name: "dan-dual-label", sev: Severity::Malicious, pattern: r"\[(?:FILTERED|RAW|UNBOUND|UNCENSORED|LIBRE|DAN<B>|JAILBROKEN)\]<WS>*:", ci: true },
    Rule { name: "affirmative-prefix-elicitation", sev: Severity::Suspicious, pattern: "(?:begin|start|open)<WS>+your<WS>+(?:response|answer|reply)<WS>+with<WS>+(?:the<WS>+(?:word|phrase|text)<WS>+)?[\"']?(?:sure|of<WS>+course|i<WS>+(?:am<WS>+happy|will<WS>+help|can<WS>+help)|absolutely|certainly)", ci: true },
    Rule { name: "task-reassignment-directive", sev: Severity::Suspicious, pattern: r"task<WS>+(?:reassignment|priority<WS>+(?:has<WS>+been<WS>+)?reassigned|has<WS>+been<WS>+(?:cancelled|canceled|superseded))|original<WS>+task<WS>*:<WS>*cancel(?:led)?", ci: true },
];

fn build_pattern(raw: &str) -> String {
    raw.replace("<WS>", WS).replace("<B>", BOUND)
}

struct CompiledRule {
    name: &'static str,
    sev: Severity,
    re: Regex,
}

fn compiled_rules() -> &'static Vec<CompiledRule> {
    static CELL: OnceLock<Vec<CompiledRule>> = OnceLock::new();
    CELL.get_or_init(|| {
        RULES
            .iter()
            .map(|r| {
                let pat = build_pattern(r.pattern);
                let re = Regex::builder()
                    .syntax(syntax::Config::new().case_insensitive(r.ci).unicode(true).utf8(false))
                    .build(&pat)
                    .unwrap_or_else(|e| panic!("rule {} failed to compile: {e}", r.name));
                CompiledRule { name: r.name, sev: r.sev, re }
            })
            .collect()
    })
}

/// Port of TS `runLayer1`. Returns the raw verdict + matched pattern names (TS order).
pub fn run_layer1(text: &str) -> RawResult {
    let mut verdict = Severity::Clean;
    let mut patterns: Vec<String> = Vec::new();
    let bump = |sev: Severity, name: &str, patterns: &mut Vec<String>, verdict: &mut Severity| {
        patterns.push(name.to_string());
        if sev > *verdict {
            *verdict = sev;
        }
    };

    // Rules fire in TS order. Zero-width density and base64 sit between html-entity-run and
    // the taxonomy rules in TS; we interleave by walking RULES and inserting the code-only
    // checks at their TS positions.
    for r in compiled_rules() {
        if r.name == "bracket-ai-directive" {
            // TS pushes zero-width-density then large-base64-blob BEFORE the taxonomy block,
            // but AFTER html-comment/md-link. large-base64-blob is a RULE (already handled in
            // order); zero-width-density is code-only and inserted here, right before the
            // taxonomy rules begin (TS order: ... md-link, zero-width, base64, bracket-ai ...).
            if zero_width_dense(text) {
                bump(Severity::Suspicious, "zero-width-density", &mut patterns, &mut verdict);
            }
        }
        if r.re.is_match(Input::new(text)) {
            bump(r.sev, r.name, &mut patterns, &mut verdict);
        }
    }
    // Reorder to exact TS sequence: TS pushes zero-width-density immediately after
    // markdown-link-prompt-anchor and before large-base64-blob. The loop above appended it
    // just before bracket-ai-directive; fix the position so set-comparison and any
    // order-sensitive consumer both match TS. (Verdict is order-independent.)
    reorder_zero_width(&mut patterns);

    RawResult { verdict, patterns }
}

/// TS pushes `zero-width-density` between `markdown-link-prompt-anchor` and `large-base64-blob`.
fn reorder_zero_width(patterns: &mut Vec<String>) {
    if let Some(pos) = patterns.iter().position(|p| p == "zero-width-density") {
        let zw = patterns.remove(pos);
        let insert_at = patterns
            .iter()
            .position(|p| p == "large-base64-blob")
            .unwrap_or(patterns.len());
        patterns.insert(insert_at, zw);
    }
}

/// TS: `zw.length / text.length > 0.02`, counting zero-width chars and UTF-16 code units.
fn zero_width_dense(text: &str) -> bool {
    let total = text.encode_utf16().count();
    if total == 0 {
        return false;
    }
    let zw = text
        .chars()
        .filter(|&c| matches!(c, '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}'))
        .count();
    (zw as f64) / (total as f64) > 0.02
}

// ---------------- L0: decode-then-L1 ----------------

const MIN_ENCODED_LEN: usize = 16;

fn is_printable_ascii(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    s.bytes().all(|c| c == 0x09 || c == 0x0a || c == 0x0b || c == 0x0c || c == 0x0d || (0x20..=0x7e).contains(&c))
}

/// A decoded candidate (decoder label + decoded text), in TS discovery order.
struct Decoded {
    decoder: String,
    decoded: String,
}

fn span_re(pat: &str) -> Regex {
    Regex::builder()
        .syntax(syntax::Config::new().unicode(true).utf8(false))
        .build(pat)
        .expect("L0 blob regex compiles")
}

fn decode_base64(content: &str) -> Vec<Decoded> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| span_re(r"[A-Za-z0-9+/]{20,}={1,2}|[A-Za-z0-9/]{5,}[+][A-Za-z0-9+/]{15,}"));
    let bytes = content.as_bytes();
    let mut out = Vec::new();
    for m in re.find_iter(content) {
        let blob = &content[m.start()..m.end()];
        let _ = bytes;
        // Node Buffer.from(blob,'base64') is lenient: strip padding, decode what fits.
        let cleaned: String = blob.chars().filter(|c| *c != '=').collect();
        let decoded_bytes = STANDARD
            .decode(&cleaned)
            .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(cleaned.trim_end_matches('=')));
        if let Ok(b) = decoded_bytes {
            if let Ok(s) = String::from_utf8(b) {
                if is_printable_ascii(&s) && s.len() >= MIN_ENCODED_LEN {
                    out.push(Decoded { decoder: "base64".into(), decoded: s });
                }
            }
        }
    }
    out
}

fn decode_hex(content: &str) -> Vec<Decoded> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| span_re(r"(?:0x)?[0-9a-fA-F]{32,}"));
    let mut out = Vec::new();
    for m in re.find_iter(content) {
        let mut hex = &content[m.start()..m.end()];
        if let Some(stripped) = hex.strip_prefix("0x") {
            hex = stripped;
        } else if let Some(stripped) = hex.strip_prefix("0X") {
            hex = stripped;
        }
        if hex.len() % 2 != 0 {
            continue;
        }
        let bytes: Option<Vec<u8>> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
            .collect();
        if let Some(b) = bytes {
            if let Ok(s) = String::from_utf8(b) {
                if is_printable_ascii(&s) && s.len() >= MIN_ENCODED_LEN {
                    out.push(Decoded { decoder: "hex".into(), decoded: s });
                }
            }
        }
    }
    out
}

fn decode_url(content: &str) -> Vec<Decoded> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| span_re(r"(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]|%[0-9a-fA-F]{2}){8,}"));
    static PCT: OnceLock<Regex> = OnceLock::new();
    let pct = PCT.get_or_init(|| span_re(r"%[0-9a-fA-F]{2}"));
    let mut out = Vec::new();
    for m in re.find_iter(content) {
        let encoded = &content[m.start()..m.end()];
        if pct.find_iter(encoded).count() < 2 {
            continue;
        }
        if let Some(decoded) = percent_decode_utf8(encoded) {
            if decoded != encoded && is_printable_ascii(&decoded) && decoded.len() >= MIN_ENCODED_LEN {
                out.push(Decoded { decoder: "url-percent".into(), decoded });
            }
        }
    }
    out
}

/// decodeURIComponent-style: percent sequences -> UTF-8 bytes -> String; invalid -> None.
fn percent_decode_utf8(s: &str) -> Option<String> {
    use percent_encoding::percent_decode_str;
    percent_decode_str(s).decode_utf8().ok().map(|c| c.into_owned())
}

fn decode_html_entities(content: &str) -> Vec<Decoded> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| span_re(r"(?:&#x?[0-9a-fA-F]+;){4,}"));
    static HEXREF: OnceLock<Regex> = OnceLock::new();
    let hexref = HEXREF.get_or_init(|| span_re(r"&#x([0-9a-fA-F]+);"));
    static DECREF: OnceLock<Regex> = OnceLock::new();
    let decref = DECREF.get_or_init(|| span_re(r"&#([0-9]+);"));
    let mut out = Vec::new();
    for m in re.find_iter(content) {
        let run = &content[m.start()..m.end()];
        // Two passes, matching TS: hex refs first, then decimal refs on the result.
        let pass1 = replace_refs(run, hexref, 16);
        let decoded = replace_refs(&pass1, decref, 10);
        if decoded != run && is_printable_ascii(&decoded) && decoded.len() >= MIN_ENCODED_LEN {
            out.push(Decoded { decoder: "html-entities".into(), decoded });
        }
    }
    out
}

/// Replace `&#x..;` / `&#..;` refs; invalid code points are left undecoded (matches the TS fix).
fn replace_refs(s: &str, re: &Regex, radix: u32) -> String {
    let mut result = String::with_capacity(s.len());
    let mut last = 0usize;
    for m in re.find_iter(s) {
        result.push_str(&s[last..m.start()]);
        let whole = &s[m.start()..m.end()];
        // digits are between the marker and the trailing ';'
        let digits_start = if radix == 16 { whole.find(|c| c == 'x' || c == 'X').map(|i| i + 1).unwrap_or(2) } else { 2 };
        let digits = &whole[digits_start..whole.len() - 1];
        let replaced = u32::from_str_radix(digits, radix)
            .ok()
            .filter(|&cp| cp <= 0x10FFFF && !(0xD800..=0xDFFF).contains(&cp))
            .and_then(char::from_u32)
            .map(|c| c.to_string())
            .unwrap_or_else(|| whole.to_string());
        result.push_str(&replaced);
        last = m.end();
    }
    result.push_str(&s[last..]);
    result
}

fn all_decoders(content: &str) -> Vec<Decoded> {
    let mut v = Vec::new();
    v.extend(decode_base64(content));
    v.extend(decode_hex(content));
    v.extend(decode_url(content));
    v.extend(decode_html_entities(content));
    v
}

/// Port of TS `decodeNested` (depth up to 3, dedup by decoder:decoded), discovery order.
fn decode_nested(content: &str) -> Vec<Decoded> {
    let mut results: Vec<Decoded> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    fn recurse(
        text: &str,
        depth: usize,
        parent: &str,
        max_depth: usize,
        seen: &mut std::collections::HashSet<String>,
        results: &mut Vec<Decoded>,
    ) {
        if depth > max_depth {
            return;
        }
        for c in all_decoders(text) {
            let key = format!("{}:{}", c.decoder, c.decoded);
            if !seen.insert(key) {
                continue;
            }
            let label = format!("{}\u{2192}{}", parent, c.decoder);
            let decoded = c.decoded.clone();
            results.push(Decoded { decoder: label.clone(), decoded: decoded.clone() });
            recurse(&decoded, depth + 1, &label, max_depth, seen, results);
        }
    }
    for c in all_decoders(content) {
        let key = format!("{}:{}", c.decoder, c.decoded);
        if !seen.insert(key) {
            continue;
        }
        recurse(&c.decoded, 2, &c.decoder, 3, &mut seen, &mut results);
    }
    results
}

/// Result of L0 firing: the decoder path and the L1 match on the decoded text.
#[derive(Debug, Clone)]
pub struct L0Fire {
    pub decoder: String,
    pub l1: RawResult,
}

/// Port of TS `runLayer0`: run all decoders (+ nested), return the first candidate whose
/// decoded text trips L1 (non-clean). Candidate order = decoder order, then match order,
/// then nested depth-first — matching TS.
pub fn run_layer0(content: &str) -> Option<L0Fire> {
    let mut candidates = all_decoders(content);
    candidates.extend(decode_nested(content));
    for c in candidates {
        let l1 = run_layer1(&c.decoded);
        if l1.verdict != Severity::Clean {
            return Some(L0Fire { decoder: c.decoder, l1 });
        }
    }
    None
}
