//! Blindseal L0 + L1 detector core — a Rust port of the proxy's TS `layer1-heuristics.ts`
//! (regex heuristics) and `layer0-decoder.ts` (decode-then-L1), behaviour-identical and
//! gated by the parity harness in `evals/`. Built on regex-automata DFAs (the engine the
//! SP1 guest runs). The raw L0/L1 verdict here is what the proof commits to — NOT the
//! combined pipeline verdict (L2 can overrule L1).
//!
//! JS/Rust regex dialect gaps handled:
//!  - `<WS>` placeholder = JS `\s` without the `u` flag (includes U+FEFF, excludes U+0085).
//!  - `<B>` placeholder = `(?-u:\b)`, ASCII word boundary (JS `\b` without `u`).
//!  - case-insensitive rules use inline `(?i-u:…)` → ASCII folding (never ſ/K).
//!  - zero-width density divides by the UTF-16 code-unit count (`encode_utf16().count()`).

use regex_automata::{dfa::regex::Regex, util::syntax, Input};

pub mod action_binding;
pub use action_binding::{action_from_payload, check_action_binding, BindError};
pub mod action_policy;
pub use action_policy::{policy_root_v2, ActionPolicy, PolicyError};
pub mod screen;
pub use screen::{json_string_leaves, screen_payload, screen_payload_prepared, screen_payload_with, ScreenResult};
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
/// Combine per-rule match results (in RULES order) into the raw verdict + pattern set,
/// shared by the build-time path (`run_layer1`) and the guest/serialized path
/// (`run_layer1_serialized`) so both are identical by construction.
fn combine_l1(text: &str, matched: &[bool]) -> RawResult {
    let mut verdict = Severity::Clean;
    let mut patterns: Vec<String> = Vec::new();
    let bump = |sev: Severity, name: &str, patterns: &mut Vec<String>, verdict: &mut Severity| {
        patterns.push(name.to_string());
        if sev > *verdict {
            *verdict = sev;
        }
    };
    for (i, r) in RULES.iter().enumerate() {
        // zero-width-density (code-only threshold) is inserted at its TS position, just
        // before the taxonomy block begins (… md-link, zero-width, base64, bracket-ai …).
        if r.name == "bracket-ai-directive" && zero_width_dense(text) {
            bump(Severity::Suspicious, "zero-width-density", &mut patterns, &mut verdict);
        }
        if matched[i] {
            bump(r.sev, r.name, &mut patterns, &mut verdict);
        }
    }
    reorder_zero_width(&mut patterns);
    RawResult { verdict, patterns }
}

/// Build-time path: compile the rule DFAs in-process and match. Used by the proxy/host.
pub fn run_layer1(text: &str) -> RawResult {
    let matched: Vec<bool> = compiled_rules().iter().map(|r| r.re.is_match(Input::new(text))).collect();
    combine_l1(text, &matched)
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

// ---------------- L0: decode-then-L1 (src/l0.rs) ----------------

pub mod l0;
pub use l0::{run_layer0_with, Decoded, L0Fire, HOMOGLYPHS};

/// Port of TS `runLayer0`, host path: every decoder (and nested, depth 3), then the compiled L1 rules
/// on each candidate; the first candidate L1 flags decides.
pub fn run_layer0(content: &str) -> Option<L0Fire> {
    run_layer0_with(content, &run_layer1)
}

// ---------------- policy commitment (canonical hashing spec) ----------------
// policyRoot = merkle_sha256(leaves), leaf_i = sha256("blindseal.rule.v1" || rule_id || layer
// || kind || compiled_bytes). compiled_bytes = serialized dense-DFA bytes for a regex rule,
// a fixed descriptor for the zero-width threshold. Tree sorted by rule_id; empty tree =
// sha256("blindseal.policy.empty.v1"). The guest (M1) recomputes this and commits it; the DFA
// bytes depend on the pinned regex-automata version, so a bump changes the root.
use regex_automata::dfa::dense;
use sha2::{Digest, Sha256};

const RULE_DOMAIN: &str = "blindseal.rule.v1";
const POLICY_EMPTY_DOMAIN: &str = "blindseal.policy.empty.v1";

fn rule_dfa_bytes(pattern: &str, ci: bool) -> Vec<u8> {
    dense::DFA::builder()
        .syntax(syntax::Config::new().case_insensitive(ci).unicode(true).utf8(false))
        .build(pattern)
        .expect("policy: rule DFA compiles")
        .to_bytes_little_endian()
        .0
}

fn leaf_hash(rule_id: &str, layer: &str, kind: &str, compiled: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(RULE_DOMAIN.as_bytes());
    h.update(rule_id.as_bytes());
    h.update(layer.as_bytes());
    h.update(kind.as_bytes());
    h.update(compiled);
    h.finalize().into()
}

/// Policy leaves (rule_id, hash), sorted by rule_id as the hashing spec requires.
fn policy_leaves() -> Vec<(String, [u8; 32])> {
    let mut leaves: Vec<(String, [u8; 32])> = RULES
        .iter()
        .map(|r| {
            let compiled = rule_dfa_bytes(&build_pattern(r.pattern), r.ci);
            (r.name.to_string(), leaf_hash(r.name, "L1", "regex", &compiled))
        })
        .collect();
    // zero-width density is a code-only threshold rule, not a DFA.
    leaves.push((
        "zero-width-density".to_string(),
        leaf_hash("zero-width-density", "L1", "threshold", b"zero_width_utf16_ratio>0.02"),
    ));
    leaves.sort_by(|a, b| a.0.cmp(&b.0));
    leaves
}

fn merkle_root(mut level: Vec<[u8; 32]>) -> [u8; 32] {
    if level.is_empty() {
        return Sha256::digest(POLICY_EMPTY_DOMAIN.as_bytes()).into();
    }
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for pair in level.chunks(2) {
            let mut h = Sha256::new();
            h.update(pair[0]);
            h.update(if pair.len() == 2 { pair[1] } else { pair[0] }); // duplicate last if odd
            next.push(h.finalize().into());
        }
        level = next;
    }
    level[0]
}

/// The committed policy root over the detector's L1 rules + the zero-width threshold.
pub fn policy_root() -> [u8; 32] {
    merkle_root(policy_leaves().into_iter().map(|(_, h)| h).collect())
}

pub fn policy_root_hex() -> String {
    let mut s = String::from("0x");
    for b in policy_root() {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Number of committed policy leaves (rules).
pub fn policy_leaf_count() -> usize {
    policy_leaves().len()
}

// ---------------- serialized / guest-side L1 execution ----------------
// The guest must NOT compile regexes (expensive, unbounded cycles). Instead the policy carries
// pre-serialized forward dense-DFA bytes (same bytes policy_root commits to), and the guest
// deserializes + runs them. `SerializedL1` is that policy; `run_layer1_serialized` runs it and
// is proven identical to the build-time `run_layer1` by the cross-mode parity test.
use regex_automata::dfa::Automaton;

/// Forward dense-DFA bytes for each L1 rule, in RULES order. This is what the guest runs and
/// what `policy_root` commits to.
pub struct SerializedL1 {
    pub dfas: Vec<Vec<u8>>,
}

/// Serialize the L1 rule DFAs (host / policy-commit time).
pub fn serialize_l1() -> SerializedL1 {
    SerializedL1 {
        dfas: RULES.iter().map(|r| rule_dfa_bytes(&build_pattern(r.pattern), r.ci)).collect(),
    }
}

/// A 4-byte-aligned copy of `bytes` (regex-automata `from_bytes` requires alignment; a plain
/// Vec<u8> is only 1-aligned and its pointer can move). Backed by a Vec<u32> (4-aligned alloc).
struct Aligned(Vec<u32>);
impl Aligned {
    fn new(bytes: &[u8]) -> Self {
        let words = bytes.len().div_ceil(4);
        let mut v = vec![0u32; words.max(1)];
        // SAFETY: v is a freshly-allocated Vec<u32> (≥4-aligned); writing bytes.len() bytes
        // into its byte view is in-bounds (words*4 ≥ bytes.len()).
        let dst = unsafe { core::slice::from_raw_parts_mut(v.as_mut_ptr() as *mut u8, words * 4) };
        dst[..bytes.len()].copy_from_slice(bytes);
        Aligned(v)
    }
    fn bytes(&self) -> &[u8] {
        // SAFETY: viewing the Vec<u32> as its byte representation; len is the word-count*4,
        // and from_bytes reads only the valid DFA prefix.
        unsafe { core::slice::from_raw_parts(self.0.as_ptr() as *const u8, self.0.len() * 4) }
    }
}

/// The rule DFAs, aligned once and deserialized once per run (release 0.8.0). The guest screens many
/// texts per payload (the raw text, every JSON string leaf, every decoded variant of each), so the
/// per-call copy + deserialization of the 0.7 path would dominate its cycles.
pub struct AlignedL1(Vec<Aligned>);

impl AlignedL1 {
    pub fn new(pol: &SerializedL1) -> Self {
        AlignedL1(pol.dfas.iter().map(|b| Aligned::new(b)).collect())
    }
    /// Deserialize every rule DFA (zero-copy views into the aligned buffers).
    pub fn prepare(&self) -> PreparedL1<'_> {
        PreparedL1(
            self.0
                .iter()
                .map(|a| {
                    // SAFETY: from_bytes_unchecked skips the O(n) transition-table validation pass (the
                    // bulk of the in-zkVM deserialization cost). Sound here because these bytes are
                    // produced by our own `serialize_l1` and are committed via the policy root — they are
                    // not attacker-controlled. The build-time path (`run_layer1`) and the cross-mode
                    // parity test guard correctness.
                    unsafe { dense::DFA::from_bytes_unchecked(a.bytes()) }.expect("deserialize forward DFA").0
                })
                .collect(),
        )
    }
}

/// Deserialized rule DFAs, in RULES order.
pub struct PreparedL1<'a>(Vec<dense::DFA<&'a [u32]>>);

/// Guest-side L1 on prepared DFAs. Identical result to `run_layer1` (cross-mode parity test).
pub fn run_layer1_prepared(text: &str, pol: &PreparedL1<'_>) -> RawResult {
    let matched: Vec<bool> =
        pol.0.iter().map(|dfa| dfa.try_search_fwd(&Input::new(text)).ok().flatten().is_some()).collect();
    combine_l1(text, &matched)
}

/// Guest-side path: run the pre-serialized DFAs. Identical result to `run_layer1` (proven by
/// the cross-mode parity test). Prepares the DFAs per call; the guest prepares them once.
pub fn run_layer1_serialized(text: &str, pol: &SerializedL1) -> RawResult {
    let aligned = AlignedL1::new(pol);
    run_layer1_prepared(text, &aligned.prepare())
}

/// Guest-side L0: the same decoders as `run_layer0`, with L1 evaluated on the pre-serialized DFAs.
/// Identical to `run_layer0` on every parity vector (tests/serialized.rs).
pub fn run_layer0_serialized(content: &str, pol: &SerializedL1) -> Option<L0Fire> {
    let aligned = AlignedL1::new(pol);
    let prepared = aligned.prepare();
    run_layer0_with(content, &|t| run_layer1_prepared(t, &prepared))
}

// ---------------- action binding: actionHash + nullifier (canonical hashing spec) ----------------
// actionHash commits the on-chain action the agent is about to take, bound to the screening.
// The guest computes it; the Solana consumer program recomputes it from the instruction IT is
// executing and compares. Layout is fixed and little-endian for scalars. sourceAuthority was
// added in the M1 spec amendment so an attestation screened for one authority can't move
// another's funds.

const ACTION_DOMAIN: &str = "blindseal.action.v1";
const NULLIFIER_DOMAIN: &str = "blindseal.nullifier.v1";

/// Parsed on-chain action (chain adapter output). 32-byte fields are zero when n/a; amount
/// is zero when n/a; mint is zero for the native asset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionFields {
    pub chain_id: u16,            // 1 = solana mainnet, 2 = reserved (no devnet), 3+ reserved for EVM
    pub target_program: [u8; 32],
    pub source_authority: [u8; 32],
    pub instruction: [u8; 8],     // anchor discriminator or sha256(name)[..8]
    pub recipient: [u8; 32],
    pub mint: [u8; 32],
    pub amount: u64,
}

/// The committed values the screening binds to (carried as public inputs alongside the action).
#[derive(Debug, Clone, Copy)]
pub struct Commitments {
    pub payload_hash: [u8; 32],
    pub policy_root: [u8; 32],
    pub detector_version: [u8; 32],
    pub expiry_slot: u64,
    pub nonce: [u8; 32],
}

/// actionHash = sha256(domain || chainId(LE) || targetProgram || sourceAuthority || instruction
/// || recipient || mint || amount(LE) || payloadHash || policyRoot || detectorVersion ||
/// expirySlot(LE) || nonce).
pub fn action_hash(a: &ActionFields, c: &Commitments) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(ACTION_DOMAIN.as_bytes());
    h.update(a.chain_id.to_le_bytes());
    h.update(a.target_program);
    h.update(a.source_authority);
    h.update(a.instruction);
    h.update(a.recipient);
    h.update(a.mint);
    h.update(a.amount.to_le_bytes());
    h.update(c.payload_hash);
    h.update(c.policy_root);
    h.update(c.detector_version);
    h.update(c.expiry_slot.to_le_bytes());
    h.update(c.nonce);
    h.finalize().into()
}

/// nullifier = sha256(domain || actionHash). A pure function of the action hash so a consumer
/// can't be tricked into accepting a nullifier for a different action.
pub fn nullifier(action_hash: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(NULLIFIER_DOMAIN.as_bytes());
    h.update(action_hash);
    h.finalize().into()
}

/// policyRoot recomputed from PROVIDED serialized DFA bytes (what the guest holds as input),
/// without rebuilding DFAs. Must equal `policy_root()` for the same rule set — the guest
/// commits this so the proof binds the policy it actually ran. (Proven equal by test.)
pub fn policy_root_from_serialized(pol: &SerializedL1) -> [u8; 32] {
    let mut leaves: Vec<(String, [u8; 32])> = RULES
        .iter()
        .enumerate()
        .map(|(i, r)| (r.name.to_string(), leaf_hash(r.name, "L1", "regex", &pol.dfas[i])))
        .collect();
    leaves.push((
        "zero-width-density".to_string(),
        leaf_hash("zero-width-density", "L1", "threshold", b"zero_width_utf16_ratio>0.02"),
    ));
    leaves.sort_by(|a, b| a.0.cmp(&b.0));
    merkle_root(leaves.into_iter().map(|(_, h)| h).collect())
}
