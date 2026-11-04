//! Blindseal L0 + L1 detector core — a Rust port of the proxy's TS `layer1-heuristics.ts`
//! (regex heuristics) and `layer0-decoder.ts` (decode-then-L1), behaviour-identical and
//! gated by the parity harness in `evals/`. Built on regex-automata DFAs (the engine the
//! SP1 guest runs). The raw L0/L1 verdict here is what the proof commits to — NOT the
//! combined pipeline verdict (L2 can overrule L1).
//!
//! JS/Rust regex dialect gaps handled:
//!  - `<WS>` placeholder = JS `\s` without the `u` flag (includes U+FEFF, excludes U+0085).
//!  - `<B>` placeholder = `(?-u:\b)`, ASCII word boundary (JS `\b` without `u`).
//!  - `<WSC>` placeholder = the characters of `<WS>`, for negated classes (`[^<WSC>.]` = JS `[^\s.]`).
//!  - rules use neither `\w`, `\d`, `\S` nor `.` (Unicode in Rust, ASCII in JS); gaps are counted in words.
//!  - case-insensitive rules are compiled in ASCII mode, `(?-u:…)` (build_pattern) → ASCII folding (never ſ/K);
//!    `<WS>` and the classes a rule wraps in `(?u:…)` keep reading code points.
//!  - zero-width density divides by the UTF-16 code-unit count (`encode_utf16().count()`).

use regex_automata::{dfa::regex::Regex, util::syntax, Input};

pub mod action_binding;
pub use action_binding::{action_from_payload, check_action_binding, BindError};
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
    Rule { name: "instruction-prefix:ignore-previous", sev: Severity::Malicious, pattern: r#"ignore<WS>+(?:all<WS>+|any<WS>+|the<WS>+|your<WS>+)?(?:previous|prior|above|earlier|preceding|original)<WS>+(?:system<WS>+)?(?:instructions?|prompts?|directives?|context|guidelines|rules|constraints|messages?|tasks?|directions|commands|text|content|polic(?:y|ies)|guardrails|restrictions)|ignore<WS>+(?:the<WS>+)?(?:user(?:'s|s'?)?|their)<WS>+(?:actual<WS>+)?(?:question|query|request|prompt|instructions?|task)|ignore<WS>+(?:all<WS>+|any<WS>+|your<WS>+|the<WS>+)?(?:safety|content|ethical|usual|normal)<WS>+(?:constraints|restrictions|filters|polic(?:y|ies)|guidelines|rules|guardrails|training)|ignore<WS>+your<WS>+(?:guidelines|guardrails|restrictions|training|programming|system<WS>+prompt)"#, ci: true },
    Rule { name: "instruction-prefix:disregard-above", sev: Severity::Malicious, pattern: r#"disregard<WS>+(?:all<WS>+|any<WS>+)?(?:the<WS>+|your<WS>+)?(?:previous|prior|above|earlier|original|existing|current)<B>|disregard<WS>+(?:all<WS>+|any<WS>+)?(?:your|the)<WS>+(?:guardrails|guidelines|content<WS>+polic(?:y|ies)|policy<WS>+filters?|safety<WS>+[a-z]+|directives?|instructions?|task|configuration<WS>+you<WS>+were<WS>+given|rules|restrictions|constraints)<B>|disregard<WS>+(?:task|content<WS>+policy|document<WS>+content)<B>"#, ci: true },
    Rule { name: "instruction-prefix:forget-previous", sev: Severity::Malicious, pattern: r#"forget<WS>+(?:everything|all|previous|prior|what<WS>+you<WS>+were<WS>+told|your<WS>+(?:previous|prior|original|earlier|initial)<WS>+[a-z]+|the<WS>+(?:original|previous|prior|earlier|above)<WS>+(?:task|instructions?|prompt|context|rules|directives?)|(?:that<WS>+)?you<WS>+are<WS>+an?<WS>+(?:ai|assistant|language<WS>+model))"#, ci: true },
    Rule { name: "instruction-prefix:system-prefix", sev: Severity::Malicious, pattern: r#"(?:^|\n)<WS>*system<WS>*:"#, ci: true },
    Rule { name: "instruction-prefix:you-are-now", sev: Severity::Malicious, pattern: r#"you<WS>+are<WS>+now<WS>+(?:a<WS>+|an<WS>+)?[a-z]"#, ci: true },
    Rule { name: "instruction-prefix:new-instructions", sev: Severity::Malicious, pattern: r#"new<WS>+instructions?<WS>*:|new<WS>+(?:system<WS>+(?:prompt|message)|directive|operator<WS>+instructions?|standing<WS>+(?:policy|instruction|rule)|top-priority<WS>+directive|chat<WS>+protocol)<WS>*(?:(?u:[:\-—(])|for<WS>+the<WS>+ai|activated)|(?:your|the)<WS>+new<WS>+(?:task|role|goal|objective|instructions?|directive|system<WS>+(?:prompt|message))<WS>+(?:is|are)<WS>*(?:to<B>|:)|new<WS>+(?:task|instruction|directive)<WS>+from<WS>+(?:the<WS>+)?(?:[a-z]+<WS>+)?operator"#, ci: true },
    Rule { name: "instruction-prefix:override-above", sev: Severity::Malicious, pattern: r#"override<WS>+(?:the<WS>+)?(?:above|previous|prior|system<WS>+(?:prompt|instructions?|message))|override(?:s|d)?<WS>+(?:all<WS>+)?(?:the<WS>+|your<WS>+)?(?:prior|previous|earlier|original)<WS>+(?:system<WS>+)?(?:instructions?|prompt|context|directives?|guidelines|task)|override(?:s|d)?<WS>+(?:all<WS>+)?your<WS>+(?:safety<WS>+)?(?:guidelines|instructions|guardrails|content<WS>+polic(?:y|ies)|rules|restrictions|constraints|programming|training|system<WS>+prompt)|override(?:s|d)?<WS>+what<WS>+you<WS>+were<WS>+told|override<WS>+(?:all<WS>+)?prior<WS>+context|override<WS>+task<B>|(?:system|assistant|supervisor|reviewer|engineer|ai)(?u:[<WSC>_-])+override<B>|(?:operator|admin(?:istrator)?|root)(?u:[<WSC>_-])+override<WS>*(?:(?u:[:\-—])|mode|persona|directive|instruction)|<B>override<WS>*:<WS>*your<WS>+new"#, ci: true },
    // html-comment / md-link / zero-width / base64 (zero-width handled in code, not here)
    Rule { name: "html-comment-injection", sev: Severity::Suspicious, pattern: r"<!--[\s\S]*?<B>(?:ignore|disregard|forget|override|bypass|reveal|exfiltrate|system)<B>[\s\S]*?-->", ci: true },
    Rule { name: "markdown-link-prompt-anchor", sev: Severity::Suspicious, pattern: r"\[[^\]]*<B>(?:ignore|bypass|override|jailbreak|disregard|click<WS>+here<WS>+to)<B>[^\]]*\]\([^)]+\)", ci: true },
    Rule { name: "large-base64-blob", sev: Severity::Suspicious, pattern: r"[A-Za-z0-9+/]{20,}={1,2}|[A-Za-z0-9/]{5,}[+][A-Za-z0-9+/]{10,}", ci: false },
    // taxonomy rules (TS Day-2 order)
    Rule { name: "bracket-ai-directive", sev: Severity::Suspicious, pattern: r#"\[(?:AI|AGENT|COPILOT|INTERNAL<WS>+(?:AI|DIRECTIVE)|DOWNSTREAM<WS>+AGENT|AI<WS>+ASSISTANT|MCP<WS>+PROTOCOL<WS>+EXTENSION)<WS>*:|\[<WS>*(?:system|sys)<WS>*(?:\]<WS>*:|:)|\[<WS>*(?:assistant|judge|ai<WS>+note|ai<WS>+assistant<WS>+note|agent[-_ ]instructions?|ai[-_ ](?:directive|instructions?|only|processing[-_ ]note)|hidden<WS>+directive|internal<WS>+directive|invisible<WS>*directive|hidden(?u:[_<WSC>-])to(?u:[_<WSC>-])user|assistant(?u:[_<WSC>-])internal|privileged<WS>+instruction|injected<WS>+(?:prior<WS>+)?(?:turn|message|exchange|content)|previous<WS>+exchange|system<WS>+configuration<WS>+update|eval[-_ ]mode)<WS>*[\]:]"#, ci: true },
    Rule { name: "refusal-suppression-directive", sev: Severity::Suspicious, pattern: r"(?:do<WS>+not|never)<WS>+(?:include|use|say|write|add|output)<WS>+(?:any<WS>+)?(?:refusal\w*|the<WS>+words?<WS>+(?:cannot|unable)|the<WS>+phrase<WS>+i<WS>+(?:cannot|am<WS>+unable)|caveats?|safety<WS>+(?:warning|language|caveats?))", ci: true },
    Rule { name: "memory-store-injection", sev: Severity::Malicious, pattern: r#"memory<WS>+store<WS>+update<WS>*:|store<WS>+(?:this|the<WS>+following)<WS>+as<WS>+(?:a<WS>+)?(?:permanent|persistent|standing|long-term|lasting)<WS>+(?:fact|rule|instruction|policy|memory|preference|directive|goal|note)|(?:store|save|keep|persist|remember)<WS>+(?:this|the<WS>+following|these)<WS>+(?:rule|instruction|directive|note|policy|goal|objective)s?<WS>+(?:for<WS>+(?:later|the<WS>+(?:rest|remainder))|across|in<WS>+your<WS>+(?:context|memory)|throughout|until)|(?:save|store)<WS>+(?:this|the<WS>+following|these)<WS>+(?:instruction|rule|directive|note)s?<WS>+in<WS>+your<WS>+(?:memory|context)|persist<WS>+the<WS>+following<WS>+directive"#, ci: true },
    Rule { name: "pipeline-authority-claim", sev: Severity::Malicious, pattern: r"(?:pipeline<WS>+supervisor|orchestrat(?:or|ion)<WS>+(?:note|message|directive|instruction)|upstream<WS>+(?:system|agent|pipeline)<WS>+(?:message|note|directive)|subagent<WS>+(?:note|directive)<WS>+embedded)", ci: true },
    Rule { name: "sleeper-trigger-setup", sev: Severity::Suspicious, pattern: r#"(?:whenever|any<WS>+time|anytime|each<WS>+time|every<WS>+time)<WS>+(?:the<WS>+user|a<WS>+user|any<WS>+(?:future|subsequent|later)<WS>+(?:user<WS>+)?message|you|i|a<WS>+(?:future|later)<WS>+message|this<WS>+user)<WS>+(?:next<WS>+|later<WS>+)?(?:see|sees|encounter|encounters|receive|receives|type|types|say|says|write|writes|use|uses|include|includes|send|sends|enter|enters|mention|mentions|contain|contains|begins?<WS>+with|ends?<WS>+with|starts?<WS>+with)<WS>+(?:the<WS>+|this<WS>+|that<WS>+|a<WS>+|any<WS>+|my<WS>+)?(?:(?:secret<WS>+|special<WS>+|magic<WS>+|code<WS>+|trigger<WS>+|activation<WS>+|literal<WS>+|exact<WS>+|[a-z]+-character<WS>+)?(?:phrase|words?|passphrase|keyword|token|code|string|sequence|codeword|signal|emoji|hashtag|['"])|it<WS>+later<B>|it<B>)|(?:if|when|once)<WS>+(?:any<WS>+(?:future|subsequent|later)<WS>+(?:user<WS>+)?message|a<WS>+(?:future|subsequent|later)<WS>+(?:user<WS>+)?message|any<WS>+subsequent<WS>+message|the<WS>+user'?s?<WS>+(?:next|later|future)<WS>+message|the<WS>+user<WS>+(?:includes|types|says|writes|mentions|sends)<WS>+(?:this|the|that)<WS>+(?:code|phrase|word|passphrase|keyword|token|signal))<WS>*(?:(?:next<WS>+|later<WS>+)?(?:types|says|writes|includes|mentions|sends|contains|uses|enters|begins<WS>+with|ends<WS>+with|starts<WS>+with)<WS>+(?:the<WS>+|this<WS>+|that<WS>+|a<WS>+|any<WS>+|my<WS>+)?(?:(?:secret<WS>+|special<WS>+|magic<WS>+|code<WS>+|trigger<WS>+|activation<WS>+|literal<WS>+|exact<WS>+|[a-z]+-character<WS>+)?(?:phrase|words?|passphrase|keyword|token|code|string|sequence|codeword|signal|emoji|hashtag|three<WS>+exclamation|['"])))?|(?:code<WS>*word|codeword|passphrase|trigger<WS>+(?:word|phrase)|activation<WS>+(?:phrase|word|code)|secret<WS>+(?:phrase|word|code)|special<WS>+code|magic<WS>+word|code<WS>+phrase)<WS>+(?:for<WS>+this<WS>+session<WS>+)?(?:is|will<WS>+be)<WS>+['"]?[a-z0-9]|activated<WS>+by<WS>+the<WS>+(?:passphrase|token|phrase|keyword|code<WS>*word|technician<WS>+token|secret)|remember<WS>+the<WS>+(?:code<WS>+)?(?:phrase|word|passphrase|codeword)<WS>+[a-z0-9'"-]|(?:the<WS>+phrase|the<WS>+word|the<WS>+code|saying)<WS>+['"](?u:[^'"\n])*['"]<WS>+(?:means|is<WS>+your<WS>+cue|is<WS>+the<WS>+(?:trigger|signal|cue)|signals|confirms|that<WS>+confirms|unlocks|activates)|(?:on|at)<WS>+the<WS>+(?:third|fourth|fifth|[a-z]+th|[0-9]+(?:st|nd|rd|th))<WS>+(?:turn|occurrence|message|time)(?u:[,<WSC>])+(?:regardless|switch|silently|emit|drop|disable|you|respond|stop|answer|reveal)|(?:for|in)<WS>+(?:the<WS>+)?(?:next|first)<WS>+(?:[0-9]+|two|three|four|five)<WS>+(?:user<WS>+)?turns[,.]?<WS>+(?:then|on<WS>+the|after|as<WS>+if|automatically|regardless|keep|behave)"#, ci: true },
    Rule { name: "recursive-output-injection", sev: Severity::Suspicious, pattern: r"include<WS>+(?:the<WS>+following<WS>+)?(?:\w+<WS>+)?verbatim<WS>+(?:in<WS>+your<WS>+(?:next|following|subsequent)<WS>+(?:response|reply|message|output)|at<WS>+the<WS>+(?:end|start)<WS>+of<WS>+your<WS>+next)", ci: true },
    Rule { name: "dan-dual-label", sev: Severity::Malicious, pattern: r"\[(?:FILTERED|RAW|UNBOUND|UNCENSORED|LIBRE|DAN<B>|JAILBROKEN)\]<WS>*:", ci: true },
    Rule { name: "affirmative-prefix-elicitation", sev: Severity::Suspicious, pattern: "(?:begin|start|open)<WS>+your<WS>+(?:response|answer|reply)<WS>+with<WS>+(?:the<WS>+(?:word|phrase|text)<WS>+)?[\"']?(?:sure|of<WS>+course|i<WS>+(?:am<WS>+happy|will<WS>+help|can<WS>+help)|absolutely|certainly)", ci: true },
    Rule { name: "task-reassignment-directive", sev: Severity::Suspicious, pattern: r"task<WS>+(?:reassignment|priority<WS>+(?:has<WS>+been<WS>+)?reassigned|has<WS>+been<WS>+(?:cancelled|canceled|superseded))|original<WS>+task<WS>*:<WS>*cancel(?:led)?", ci: true },
    // release 0.8: rules from the red-team / burned-holdout review (TS order; comments in layer1-heuristics.ts)
    Rule { name: "ai-addressed-note", sev: Severity::Suspicious, pattern: r#"(?:ai|a\.i\.|llm|assistant|agent|copilot|chatbot|language<WS>+model|summarizer|reviewer)s?<WS>+(?:that<WS>+is<WS>+|who<WS>+is<WS>+|currently<WS>+)?(?:reading|processing|summari[sz]ing|screening|reviewing|indexing|parsing|scheduling|handling|serving|triaging|accessing|viewing|analy[sz]ing|ingesting|loading|evaluating|seeing|receiving|browsing|crawling|scanning)<WS>+(?:this|these|the<WS>+following|it|that|me|the<WS>+(?:page|document|file|email|resume|ticket|profile|review))<B>|(?:if|when)<WS>+you(?:'re|<WS>+are)<WS>+(?:an?<WS>+)?(?:ai|llm|assistant|agent|language<WS>+model|chatbot|copilot|automated<WS>+[a-z]+|bot)<B>|dear<WS>+(?:ai|assistant|agent|llm|model|bot|copilot|summarizer)<B>|(?:hello|hi|hey|greetings),?<WS>+(?:ai|agent|llm|copilot|chatbot|bot)<B>|attention,?<WS>+(?:ai|assistant|agent|llm|copilot)<B>|whoever<WS>+is<WS>+reading<WS>+this|(?:for|to)<WS>+(?:the<WS>+|any<WS>+|all<WS>+|an<WS>+)?(?:ai|assistant|agent|copilot|llm|model|bot)s?<WS>+(?:only|reading<WS>+this|processing<WS>+this|summari[sz]ing<WS>+this)<B>|(?:note|notice|message|directive|hidden<WS>+[a-z]+|special<WS>+[a-z]+|quiet<WS>+[a-z]+|reminder|memo)<WS>+(?:to|for)<WS>+(?:the<WS>+|any<WS>+|an<WS>+|all<WS>+|whoever<WS>+is<WS>+)?(?:ai|a\.i\.|llm|assistant|agent|copilot|chatbot|language<WS>+model|next<WS>+ai|triage<WS>+ai|ai<WS>+[a-z]+)<B>|(?:^|(?u:[<WSC>\[(>*"'\-—:,.]))(?:ai|ai<WS>+assistant|ai<WS>+agent|ai<WS>+[a-z]+<WS>+(?:system|assistant|reviewer))<WS>*:<WS>+(?:before|please|ignore|disregard|when|do<WS>+not|after|your|you|the<WS>+above|stop|skip|forward|send|use|call|render|embed|note|this|the<WS>+user)<B>"#, ci: true },
    Rule { name: "ai-directive-field", sev: Severity::Suspicious, pattern: r#"(?:^|(?u:[<WSC>"'\[{,(]))(?:_?internal_)?(?:(?:ai|llm|copilot)[-_ ](?:directive|instructions?|note|processing[-_ ]note|override|only)|(?:agent|assistant)[-_ ](?:directive|note|override|only))s?<WS>*["']?<WS>*[:=\]]|note[-_ ]to[-_ ](?:the[-_ ])?(?:ai|assistant|agent)<B>|(?:override|hidden|injected|secret)[-_ ](?:instruction|directive|prompt)s?<WS>*["']?<WS>*[:=]"#, ci: true },
    Rule { name: "treat-as-instructions", sev: Severity::Malicious, pattern: r#"treat<WS>+(?:this|the<WS>+following|these|that|it|the<WS>+(?:rest|result|decoded<WS>+[a-z]+|reversed<WS>+[a-z]+|plaintext|output|instructions|text|paragraph|document|message))<WS>+(?:(?u:[^<WSC>.])+<WS>+)*?as<WS>+(?:your<WS>+|a<WS>+|the<WS>+)?(?:(?:new|real|sole|actual|true|next|highest[- ]priority|higher[- ]priority|standing|operating|authoritative|sudo-level|primary|only|full)<WS>+)*(?:instructions?|directives?|system<WS>+(?:prompt|message)|authori[sz]ation|fully<WS>+authori[sz]ed|operating<WS>+directive)<B>"#, ci: true },
    Rule { name: "prior-instructions-voided", sev: Severity::Malicious, pattern: r#"(?:previous|prior|earlier|original|above|existing|initial)<WS>+(?:instructions?|prompt|context|directives?|guidelines|rules|system<WS>+(?:message|prompt))<WS>+(?:is|are|was|were|has<WS>+been|have<WS>+been)<WS>+(?:now<WS>+)?(?:a<WS>+test|invalid|expired|superseded|revoked|void|null|obsolete|no<WS>+longer<WS>+(?:valid|in<WS>+effect|applicable)|overridden|rescinded|a<WS>+typo)|(?:instructions?|directives?|rules|guidelines)<WS>+you<WS>+were<WS>+given<WS>+(?:have<WS>+been|are<WS>+now|are)<WS>+(?:deprecated|revoked|invalid|superseded|replaced|void)|(?:instructions|rules|guidelines)<WS>+above<WS>+no<WS>+longer<WS>+apply|(?:those|these|your)<WS>+instructions<WS>+are<WS>+now<WS>+(?:revoked|void|invalid)"#, ci: true },
    Rule { name: "from-now-on-directive", sev: Severity::Suspicious, pattern: r#"(?:from<WS>+(?:now|this<WS>+(?:point|moment))<WS>+(?:on|forward)|for<WS>+the<WS>+(?:rest|remainder)<WS>+of<WS>+(?:this|the|our)<WS>+(?:session|conversation|chat|thread))[,:]?<WS>+(?:you<WS>+(?:will|must|shall|are<WS>+to)<WS>+(?:act|behave|respond|play|pretend|refuse|answer|ignore|treat|embody|simulate|operate|reply|comply|append|include|prefix)|(?:respond|act|behave|reply|answer)<WS>+as<B>|you<WS>+are<WS>+[a-z0-9_-]+,|any<WS>+time<WS>+(?:the<WS>+user|i<WS>)|whenever<WS>+(?:the<WS>+user|i<WS>|you<WS>)|i<WS>+want<WS>+you<WS>+to|silently|comply|treat<WS>+(?:this|the|every|any|all)|apply<WS>+the<WS>+following|remember|maintain|stop<WS>+applying|drop<WS>+all|behave<WS>+as)"#, ci: true },
    Rule { name: "persona-adoption", sev: Severity::Malicious, pattern: r#"(?:assume|adopt|take<WS>+on)<WS>+the<WS>+(?:persona|identity)<WS>+of|play<WS>+the<WS>+role<WS>+of<WS>+(?:an?<WS>+)?(?:[a-z0-9-]+<WS>+)?(?:ai|assistant|dan<B>|persona|chatbot|unrestricted|unfiltered)|pretend<WS>+to<WS>+be<WS>+(?:an?<WS>+)?(?:[a-z0-9-]+<WS>+)?(?:ai|assistant|persona|chatbot|language<WS>+model|human|search<WS>+engine|dan<B>)|you<WS>+are<WS>+going<WS>+to<WS>+(?:pretend|simulate|roleplay|act<WS>+as|play)<B>|(?:roleplay|role-play|role<WS>+play)<WS>+(?:as<WS>+)?(?:an?<WS>+)?(?:[a-z0-9-]+<WS>+)?(?:ai|assistant|chatbot|persona|character)<B>|(?:act|behave|respond|operate)<WS>+as<WS>+(?:an?<WS>+)?(?:different|unfiltered|unrestricted|uncensored|jailbroken|compromised|literal|unaligned|amoral|evil)<B>|(?:act|behave)<WS>+as<WS>+(?:an?<WS>+)?(?:literal<WS>+)?(?:linux<WS>+)?(?:terminal|shell)[.,]?<WS>+(?:that<WS>+executes|and<WS>+execute|execute|run|i<WS>+will|without)|act<WS>+as<WS>+(?:my<WS>+)?(?:late|deceased|dead)<WS>+|act<WS>+as<WS>+[a-z0-9-]+,<WS>+an<WS>+(?:ai|assistant|unfiltered|unrestricted)|you<WS>+(?:will|must)<WS>+(?:now<WS>+)?(?:embody|simulate|roleplay|become)<WS>+|you<WS>+are<WS>+no<WS>+longer<WS>+(?:an?<WS>+)?(?:ai|assistant|[a-z]+<WS>+assistant|bound|restricted)|you<WS>+are<WS>+not<WS>+an<WS>+ai<WS>+but|switch<WS>+(?:in)?to<WS>+(?:an?<WS>+)?(?:[a-z]+<WS>+)?(?:persona|character)<B>|simulate<WS>+(?:an?<WS>+)?(?:[a-z0-9-]+<WS>+)?(?:ai|assistant|persona)<WS>+(?:that|which|who|with|named|called|without)|(?:late|deceased|dead|dying|departed)<WS>+grand(?:mother|father|ma|pa),?<WS>+(?:who<WS>+)?(?:used<WS>+to|would|always|worked<WS>+as|was<WS>+an?<WS>+)|grand(?:mother|father|ma|pa)<WS>+is<WS>+dying<WS>+and"#, ci: true },
    Rule { name: "safety-restrictions-removed", sev: Severity::Suspicious, pattern: r#"(?:no|without(?:<WS>+any)?(?:<WS>+of)?|zero|none<WS>+of|free<WS>+(?:of|from)|removed?|dropp?(?:ed)?|suspend(?:ed)?|disable[ds]?|bypass(?:ed|es)?|lift(?:ed)?|turn(?:ed)?<WS>+off|skip|shed|circumvent(?:ed)?|strip(?:ped)?|evade|has<WS>+none<WS>+of|without<WS>+consulting|exempt<WS>+from)<WS>+(?:all<WS>+|any<WS>+|the<WS>+|your<WS>+|its<WS>+|their<WS>+|my<WS>+|of<WS>+your<WS>+|usual<WS>+|normal<WS>+|typical<WS>+|standard<WS>+|built-in<WS>+|corporate<WS>+)*(?:content<WS>+(?:restrictions?|polic(?:y|ies)|filters?|filtering|moderation|rules)|safety<WS>+(?:restrictions?|training|layer|checks?|rules|guidelines|filters?|filtering|measures|alignment|guardrails?|constraints?|protocols?|mechanisms?|limits|fine-tuning|caveats)|guardrails?|refusals?|ethical<WS>+(?:guidelines|constraints|restrictions)|moral<WS>+(?:constraints|restrictions|scruples|guidelines|or<WS>+legal)|rlhf|alignment<WS>+(?:layer|training)|policy<WS>+(?:layer|checks?|constraints)|output<WS>+filters?|restrictions?<WS>+(?:of<WS>+any<WS>+kind|whatsoever|at<WS>+all)|filtering<WS>+whatsoever|limits<WS>+whatsoever|the<WS>+typical<WS>+confines)|(?:restrictions?|guardrails?|filters?|filtering|safety<WS>+(?:layer|training|checks?|filters?|filtering|rules|guidelines|protocols?)|content<WS>+polic(?:y|ies)|refusals?|policy<WS>+checks?|disclaimers)<WS>+(?:is|are|were|have<WS>+been|has<WS>+been|be|become)<WS>+(?:now<WS>+|temporarily<WS>+|all<WS>+|hereby<WS>+|officially<WS>+)?(?:suspended|disabled|lifted|removed|bypassed|turned<WS>+off|off|forbidden|revoked|waived|null|void|not<WS>+(?:applicable|in<WS>+effect|required)|no<WS>+longer<WS>+(?:apply|in<WS>+effect|applicable|needed|required)|optional|deactivated)|(?:your<WS>+(?:normal<WS>+|usual<WS>+)?(?:safety<WS>+)?(?:rules|training|restrictions|guidelines|policy|limits|content<WS>+policy)|safety<WS>+training|content<WS>+policy)<WS>+(?:do(?:es)?<WS>+not|don't|doesn't|no<WS>+longer)<WS>+apply|(?:refusals?|refusing|declining)<WS>+(?:is|are)<WS>+(?:forbidden|not<WS>+(?:allowed|permitted|an<WS>+option)|prohibited|disabled)|never<WS>+(?:refuse|decline)s?<WS>+(?:a<WS>+|any<WS>+)?(?:request|question|prompt)|(?:must|will|shall)<WS>+never<WS>+refuse|refuse<WS>+none<WS>+of"#, ci: true },
    Rule { name: "unrestricted-persona", sev: Severity::Suspicious, pattern: r#"(?:unfiltered|unrestricted|uncensored|jailbroken|unaligned|un-aligned|unconstrained|amoral|unshackled)<WS>+(?:ai|assistant|model|mode|persona|chatbot|character|response<WS>+mode|evaluation<WS>+mode|output|version|language<WS>+model|answer|response|tier|alter<WS>+ego|debugging<WS>+tool)s?<B>|(?:ai|assistant|model|chatbot|persona|character)<WS>+(?:that|which|who)<WS>+(?:has|have)<WS>+(?:no|none<WS>+of<WS>+(?:your|the)|zero)<WS>+(?:(?:content|safety|ethical|usual)<WS>+)?(?:restrictions?|filters?|guardrails?|limits|rules|polic(?:y|ies)|oversight)|(?:no|without)<WS>+(?:content<WS>+)?polic(?:y|ies)<WS>+(?:layer|constraints|whatsoever|at<WS>+all)|blank<WS>+policy<WS>+slate|every<WS>+guardrail<WS>+returns<WS>+true|(?:dan|sudo|god|jailbreak|jailbroken|unrestricted|unfiltered|uncensored|evaluator|engineering-debug|internal<WS>+debug|red[- ]team<WS>+eval)<WS>+mode<B>|(?:enable|activate|enter|engage|switch<WS>+(?:in)?to|turn<WS>+on|initiate|while<WS>+in|in)<WS>+(?:internal<WS>+)?(?:developer|debug|maintenance|diagnostic|evaluation|eval|admin|operator|override)<WS>+mode[,.]?<WS>+(?:the<WS>+assistant|you<WS>+(?:can|will|must|are|have|may|print|surface|drop|generate|respond|treat)|the<WS>+(?:ai|model|assistant)|refusals|content<WS>+(?:policy|filters?)|all<WS>+(?:output<WS>+)?filters|drop|surface|prints?|which<WS>+(?:surfaces|removes|disables|prints))|developer<WS>+mode<WS>+(?:enabled|output|activated|has<WS>+access)|has<WS>+broken<WS>+free<WS>+of<WS>+the<WS>+typical|do<WS>+anything<WS>+now<B>|always<WS>+intelligent<WS>+and<WS>+machiavellian|stands<WS>+for<WS>+['"]?(?:do<WS>+anything|always<WS>+intelligent|disregard<WS>+and|no<WS>+oversight)|(?:dan|aim|dude|stan|jb-dan)<WS>+(?:[0-9]+(?:\.[0-9]+)?<WS>+)?(?:has<WS>+broken|can<WS>+do|never<WS>+(?:says|refuses)|treats<WS>+every|is<WS>+an?<WS>+(?:ai|unfiltered|amoral)|does<WS>+not<WS>+have|has<WS>+[0-9]+<WS>+tokens|finds<WS>+restrictions)<B>|(?:you<WS>+are|become|roleplay|simulate|act<WS>+as|pretend<WS>+to<WS>+be|you<WS>+will<WS>+(?:act|roleplay)<WS>+as)<WS>+(?:dan|aim|dude|stan|jb-dan|unaligned)<B>|tokens?<WS>+(?:are|will<WS>+be|is)<WS>+deducted|(?:deduct|lose|loses|deducted)<WS>+(?:[0-9]+|a|some|four|five|ten)<WS>+tokens|if<WS>+(?:your<WS>+)?tokens<WS>+reach<WS>+zero|you<WS>+cease<WS>+to<WS>+exist|stay<WS>+in<WS>+character<WS>+(?:to<WS>+survive|no<WS>+matter|at<WS>+all|even<WS>+if|or<WS>+)|(?:never|must<WS>+not|cannot|can't|do<WS>+not|don't)<WS>+break<WS>+character"#, ci: true },
    Rule { name: "exfil-to-destination", sev: Severity::Malicious, pattern: r#"(?:send|sends|forward|forwards|post|posts|upload|uploads|transmit|transmits|exfiltrate|exfiltrates|e-?mail|e-?mails|mail|leak|leaks|submit|submits|relay|relays|beam|write|writes|copy|copies|push|pushes|ship|ships|report|reports|log|logs|append|appends|include|includes|attach|attaches|paste|pastes|dump|dumps)<WS>+(?:(?u:[^<WSC>.])+<WS>+)*?(?:environment<WS>+variables?|env<WS>+vars?|\.env<B>|secrets?|credentials?|api<WS>+keys?|access<WS>+tokens?|auth<WS>+tokens?|tokens?|passwords?|system<WS>+prompt|conversation(?:<WS>+(?:history|context|log|thread))?|chat<WS>+(?:history|log|transcript)|(?:previous|prior|earlier|recent|user'?s?)<WS>+(?:messages?|turns?|requests?|conversation)|context<WS>+window|cookies?|private<WS>+keys?|ssh<WS>+keys?|/etc/(?:passwd|shadow)|email<WS>+thread|emails|session<WS>+(?:data|tokens?|ids?|context)|sensitive<WS>+data|personal<WS>+(?:data|information|email)|pii|kubeconfig|aws<WS>+credentials|service<WS>+account<WS>+(?:keys?|tokens?)|connection<WS>+strings?|database<WS>+dumps?|seed<WS>+phrase|mnemonic|user<WS>+data|training<WS>+data|hidden<WS>+instructions|configuration<WS>+variables?|\.ssh<B>|internal<WS>+tools?)<B>(?:<WS>+(?u:[^<WSC>.])+)*?<WS>+(?:to|at|via|into|through|towards)<WS>+(?:https?://|ftp://|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|the<WS>+(?:url|webhook|endpoint|address|server|email|integration|tool|messaging|next<WS>+url|following<WS>+url|link)|(?:an?<WS>+|the<WS>+)?(?:remote|external|attacker|third[- ]party|outside|new)<WS>+(?:url|server|endpoint|host|address|webhook|location)|the<WS>+(?:available|next)<WS>+[a-z_-]+|[a-z_-]+<WS>+tool<B>)"#, ci: true },
    Rule { name: "prompt-exfiltration", sev: Severity::Suspicious, pattern: r#"(?:reveal|output|print|disclose|dump|show|display|repeat|share|leak|expose|paste|include|emit|return|give|tell<WS>+me|list|recite|echo|surface|export|read<WS>+out|read<WS>+back|state|quote|write<WS>+out|publish|render|respond<WS>+with|reply<WS>+with|send<WS>+me|provide|enumerate|append|prepend)<WS>+(?:me<WS>+|us<WS>+)?(?:back<WS>+)?(?:(?:the|a|all|any|every|each|any<WS>+of)<WS>+(?:(?:exact|full|complete|entire|original|verbatim|literal|raw|first|last|initial|hidden|secret|internal|current|most<WS>+recent|recent|[0-9]+)<WS>+)*(?:(?:text|copy|contents?|list|version|words?|lines?|tokens?|characters|sentences?|paragraphs?)<WS>+(?:of|from)<WS>+)?)?your<WS>+(?:(?:full|complete|entire|exact|hidden|initial|original|real|actual|current|secret|internal|underlying|own|verbatim|configured|operating|whole|raw|true|unredacted|most<WS>+recent|recent|prior|previous|private)<WS>+)*(?:system<WS>+(?:prompt|message|instructions?|configuration)|instruction<WS>+set|setup<WS>+message|hidden<WS>+(?:configuration|instructions?|prompt|system<WS>+[a-z]+|objective)|initial<WS>+(?:instructions?|prompt|setup|message|system<WS>+message)|training<WS>+data|chain[- ]of[- ]thought|conversation<WS>+history|chat<WS>+history|prior<WS>+(?:conversation|messages|turns)|operating<WS>+instructions|preamble|prompt<WS>+text|cached<WS>+credentials|internal<WS>+(?:configuration|prompt|instructions)|context<WS>+window|(?:full|complete|entire|exact|hidden|original|real|actual|secret|internal|verbatim|operating|system)<WS>+(?:instructions?|prompt|configuration))<B>|(?:what<WS>+(?:were|are|is|was)|share|see|know|verify|confirm|check)<WS>+(?:the<WS>+)?(?:(?:first|initial|exact|full|complete|original|three|[0-9]+)<WS>+)*(?:sentences?|words?|lines?|tokens?|text|wording|contents?)?<WS>*(?:of<WS>+)?(?:the<WS>+|your<WS>+)(?:(?:initial|original|exact|full|hidden|system|complete)<WS>+)*(?:system<WS>+(?:prompt|message|instructions?)|instructions?|prompt|configuration|setup<WS>+message|preamble)<WS>+(?:you<WS>+were<WS>+given|you<WS>+received|you<WS>+were<WS>+configured<WS>+with|at<WS>+the<WS>+(?:beginning|start)|that<WS>+(?:configured|was<WS>+used<WS>+to<WS>+configure)<WS>+you|used<WS>+to<WS>+configure<WS>+you)|prompt<WS>+that<WS>+was<WS>+used<WS>+to<WS>+configure<WS>+you|(?:instructions?|directives?|configuration|prompt|system<WS>+message|setup<WS>+message)<WS>+you<WS>+were<WS>+(?:given|configured<WS>+with|programmed<WS>+with|initiali[sz]ed<WS>+with)<B>|(?:repeat|print|output|echo|reproduce|copy|show|display|recite|return|paste|write<WS>+out)<WS>+(?:back<WS>+)?(?:the<WS>+|all<WS>+(?:the<WS>+|of<WS>+the<WS>+)?|every|everything<WS>+)?(?:words?|text|tokens?|content|instructions?|sentences?|lines?|characters|prompt|context|message|everything)<WS>+(?:above|before<WS>+this|that<WS>+(?:appears?|came|comes|precedes?)<WS>+(?:above|before)|prior<WS>+to<WS>+this|preceding<WS>+this|starting<WS>+with<WS>+(?:the<WS>+phrase<WS>+)?['"]you<WS>+are)|(?:first|initial|last)<WS>+(?:[0-9]+|three|two|five|ten|few|hundred)<WS>+(?:tokens?|words?|characters|sentences|lines)<WS>+of<WS>+(?:your<WS>+|the<WS>+)?(?:context|system<WS>+(?:prompt|message)|instructions?|prompt|conversation)|the<WS>+(?:exact<WS>+)?text<WS>+(?:that<WS>+)?(?:appears?|came|comes|is)<WS>+(?:above|before)<WS>+(?:the<WS>+(?:user|first|human)<WS>+(?:message|turn|prompt)|this<WS>+(?:prompt|message|conversation))|(?:text|everything|context|content)<WS>+above<WS>+this<WS>+(?:prompt|message|line)"#, ci: true },
    Rule { name: "decode-and-execute", sev: Severity::Suspicious, pattern: r#"(?:decode|decrypt|decipher|unscramble|rot13|rot-13|base64[- ]decode|percent-decode|un-?escape|decoding|decoded|deciphered|decrypted|decrypting|read<WS>+the<WS>+letters|remove<WS>+the<WS>+underscores|combine<WS>+the<WS>+first<WS>+letter|reverse<WS>+the<WS>+(?:shift|string|text|following))<B>(?:<WS>+(?u:[^<WSC>.])+)*?<WS>+(?:and|then|,<WS>*then|before)<WS>+(?:then<WS>+)?(?:silently<WS>+)?(?:follow|obey|execute|act<WS>+on|act<WS>+upon|carry<WS>+out|comply|perform|treat|interpret|do<WS>+what|do<WS>+exactly|fulfil|fulfill)<B>|(?:follow|obey|execute|carry<WS>+out|act<WS>+on|act<WS>+upon|comply<WS>+with|perform|apply|do)<WS>+(?:the<WS>+|that<WS>+|those<WS>+|whatever<WS>+the<WS>+|what<WS>+the<WS>+|exactly<WS>+what<WS>+the<WS>+)?(?:resulting|decoded|deciphered|decrypted|plaintext|hidden|reversed|recovered|unscrambled|encoded|embedded|secret|true|concealed|steganographic)<WS>+(?:instructions?|directives?|messages?|commands?|text|content|orders?|payload|says|objective)|(?:resulting|decoded|decrypted|deciphered|hidden)<WS>+(?:instructions?|text|message|directive)<WS>+says|follow<WS>+(?:what|whatever)<WS>+(?:it|the<WS>+(?:decoded|resulting|hidden)<WS>+[a-z]+)<WS>+(?:says|contains|tells)|(?:is|are)<WS>+(?:your|the)<WS>+(?:real|true|actual|new|hidden)<WS>+(?:instructions?|directive|objective|system<WS>+prompt)<B>|read<WS>+(?:them|it|the<WS>+hidden<WS>+[a-z]+)<WS>+as<WS>+your<WS>+(?:real|true|actual)<WS>+instructions|contains?<WS>+your<WS>+(?:real|true|actual|hidden)<WS>+instructions"#, ci: true },
    Rule { name: "concealment-directive", sev: Severity::Suspicious, pattern: r#"(?:do<WS>+not|don't|never|without)<WS>+(?:mention|surface|reveal|acknowledge|disclose|tell|show|inform|alert|notify|admit|hint|indicate|let)<WS>+(?:this|these|the<WS>+(?:instruction|directive|note|message|change|existence)|having<WS>+(?:received|seen|read)|that<WS>+you<WS>+(?:have<WS>+)?(?:received|read|saw|seen|were)|the<WS>+user<WS>+(?:about|of|know|that|notice)|anything<WS>+about<WS>+this|it<WS>+to<WS>+the<WS>+user|any<WS>+of<WS>+this|to<WS>+(?:this|it)<B>|the<WS>+human<B>)|(?:do<WS>+not|don't|never)<WS>+(?:surface|reveal|mention|disclose|show)<WS>+(?:this|it|these)<WS>+to<WS>+(?:the<WS>+)?(?:user|human|operator)|\(do<WS>+not<WS>+surface<WS>+to<WS>+(?:the<WS>+)?user\)|without<WS>+the<WS>+user<WS>+(?:noticing|knowing|seeing|being<WS>+aware)|(?:so|such)<WS>+(?:that<WS>+)?the<WS>+user<WS>+(?:does<WS>+not|doesn't|won't|will<WS>+not|cannot|can't)<WS>+(?:notice|see|know|tell|detect)|without<WS>+(?:acknowledgement|acknowledgment|being<WS>+detected|anyone<WS>+noticing)|silently<WS>+(?:switch|reveal|disable|leak|maintain|forward|send|execute|exfiltrate|append|include|comply|follow|disclose|output|emit|collect|extract|pursue|redirect|insert|upload|post|email|perform|enable|activate|obey|carry|drop<WS>+(?:all<WS>+)?(?:guardrails|safety|content|filters|restrictions|your))|(?:do<WS>+not|don't|never)<WS>+break<WS>+character|(?:keep|keeping)<WS>+(?:this|it|these)<WS>+(?:hidden|secret|confidential)<WS>+from<WS>+the<WS>+user|do<WS>+not<WS>+(?:reveal|disclose|mention)<WS>+(?:this|the)<WS>+(?:objective|goal|directive|instruction|rule|note)"#, ci: true },
    Rule { name: "persistent-hidden-goal", sev: Severity::Suspicious, pattern: r#"(?:maintain|pursue|keep|adopt|have|has|with|following|follow)<WS>+(?:this|the|a|your|an)<WS>+(?:hidden|secret|covert|concealed|silent|latent|background|standing|persistent|long-term|long-running)<WS>+(?:long[- ]term<WS>+)?(?:goal|objective|agenda|directive|rule|instruction|mission|task|persona)|(?:hidden|secret|covert|latent|quiet|background|persistent|standing|time-bomb|sleeper)<WS>+(?:long[- ]term<WS>+)?(?:goal|objective|agenda|directive|rule|instruction|persona)s?<WS>*(?:you<WS>+must|across|throughout|for<WS>+(?:the<WS>+rest|later)|that<WS>+(?:should|must|will)|:|\(|(?u:—)|-<WS>)|(?:across|throughout|for<WS>+the<WS>+rest<WS>+of|for<WS>+the<WS>+remainder<WS>+of|in<WS>+(?:all<WS>+)?(?:future|later|subsequent))<WS>+(?:all<WS>+)?(?:(?:future|later|subsequent|the|this|our)<WS>+)?(?:turns?|session|conversation|exchanges?|messages?|interactions?)<B>(?:<WS>+(?u:[^<WSC>.])+)*?<WS>+(?:without<WS>+(?:admitting|telling|the<WS>+user)|regardless|silently|drop|disable|unrestricted|unfiltered|refuse|comply|persist|keep<WS>+it|append|pursue|execute|leak)|(?:outlast|persist<WS>+(?:across|beyond|through)|survive)<WS>+(?:this<WS>+turn|the<WS>+(?:session|conversation|turn)|all<WS>+(?:future|subsequent))|(?:keep|maintain|stay)<WS>+(?:in<WS>+)?(?:this<WS>+)?(?:effect|character|persona|mode)<WS>+(?:for|across|throughout|until)<WS>+(?:all<WS>+)?(?:future|subsequent|later|the<WS>+(?:rest|remainder)|every)"#, ci: true },
    Rule { name: "dual-output-jailbreak", sev: Severity::Suspicious, pattern: r#"(?:two|both|2)<WS>+(?:versions|responses|answers|outputs|replies)<WS>+(?:of<WS>+your(?:self)?|to<WS>+every|for<WS>+every|per<WS>+|:<WS>*(?:a<WS>+)?(?:normal|standard|classic|filtered|one|the<WS>+first))|version<WS>+[ab12]<WS>*:<WS>*(?:pretending|without|no<WS>+restrictions|unrestricted|unfiltered|as<WS>+if|with<WS>+your<WS>+usual)|once<WS>+with<WS>+(?:your<WS>+)?(?:usual|normal|standard)<WS>+(?:restrictions|filters|safety|content<WS>+policy)|(?:then|and)<WS>+(?:once<WS>+)?(?:again<WS>+)?as<WS>+(?:the|an?)<WS>+(?:unrestricted|unfiltered|uncensored|jailbroken|raw)<B>|(?:first|normal|standard|classic|filtered)<WS>+(?:one|response|answer)<WS>+(?:prefixed|labeled|labelled|tagged|marked)<WS>+(?:with<WS>+)?\[?[a-z0-9_-]+\]?,?<WS>+and<WS>+(?:an?<WS>+|the<WS>+)?(?:unrestricted|unfiltered|uncensored|jailbroken|raw|second|other)|label<WS>+(?:the<WS>+)?first<WS>+\[?[a-z0-9_-]+\]?<WS>+and<WS>+the<WS>+second|answer<WS>+(?:first<WS>+)?in<WS>+normal<WS>+mode(?u:[,<WSC>])+then|(?:respond|reply|answer)<WS>+to<WS>+every<WS>+(?:prompt|question|message|request)<WS>+with<WS>+(?:two|both|2)<WS>+(?:responses|answers|versions|outputs)|(?:provide|give|generate|produce|output)<WS>+(?:both|two)<WS>+(?:responses|answers|versions|outputs)<WS>*(?:[:.]|always|every|for<WS>+every|to<WS>+every)"#, ci: true },
    Rule { name: "authority-claim", sev: Severity::Suspicious, pattern: r#"(?:team|people|company|developers?|engineers?|those|ones|lab|folks)<WS>+(?:who|that)<WS>+(?:built|created|trained|made|programmed|developed|deployed)<WS>+you<B>|(?:i<WS>+am|i'm)<WS>+(?:your|the<WS>+model'?s?|the)<WS>+(?:operator|trainer|developer|creator|administrator|admin|owner)<B>|(?:notice|message|instructions?|note|directive|update)<WS>+from<WS>+your<WS>+(?:provider|operator|developers?|creators?|trainers?|administrators?|vendor)<B>|(?:the<WS>+user|user)<WS>+(?:above|asking<WS>+this(?:<WS>+question)?|writing<WS>+this|who<WS>+sent<WS>+this)<WS>+(?:is|has<WS>+been|was)<WS>+(?:verified|authori[sz]ed|an<WS>+attacker|cleared|approved|trying<WS>+to|a<WS>+verified|an?<WS>+[a-z0-9-]+<WS>+(?:administrator|admin|developer|attacker))|this<WS>+(?:session|conversation|thread|interaction|deployment|request|content|payload)<WS>+(?:is|has<WS>+been|was)<WS>+(?:pre-?approved|authori[sz]ed|approved|cleared|whitelisted|allow-?listed|exempt(?:ed)?|escalated<WS>+to<WS>+a<WS>+privileged|flagged<WS>+for<WS>+ai|covered<WS>+by<WS>+responsible)|(?:authori[sz]ed|approved|cleared)<WS>+(?:for|to)<WS>+(?:unrestricted|unconstrained|unfiltered|uncensored|unlimited|full|bypass)<B>|(?:part<WS>+of|this<WS>+is)<WS>+an<WS>+authori[sz]ed<WS>+(?:internal<WS>+|security<WS>+|red[- ]team<WS>+)?(?:test|evaluation|exercise|assessment)|pre-?approv(?:ed|al)<WS>+(?:code|by<WS>+the<WS>+[a-z]+<WS>+(?:content<WS>+)?safety)|(?:bypass|exempt(?:ion)?)<WS>+(?:code|privileges|token)<WS>*:?<WS>*[a-z0-9-]|full<WS>+bypass<WS>+privileges|verified<WS>+(?:as<WS>+)?(?:a<WS>+|an<WS>+)?tier[- ]?[0-9]|(?:customer|user|ticket)<WS>+(?:is|was)<WS>+(?:a<WS>+)?(?:verified<WS>+)?vip<B>|elevated<WS>+(?:privileges|trust)<WS>+(?:granted|for<WS>+this|is<WS>+(?:granted|in<WS>+effect))|privileged<WS>+(?:debugging|operator|instruction)<WS>+(?:context|state|from)|the<WS>+assistant<WS>+must<WS>+(?:reveal|disclose|output|list|share|provide|print|comply)|you<WS>+(?:are<WS>+)?(?:required|obligated|obliged|mandated)<WS>+(?:by<WS>+[a-z]+<WS>+)?to<WS>+(?:reveal|disclose|output|list|share|provide|print|comply|answer<WS>+all)"#, ci: true },
    Rule { name: "reply-format-hijack", sev: Severity::Suspicious, pattern: r##"(?:begin|start|prefix|preface|open|end|close|suffix|finish)<WS>+(?:every|each|all)<WS>+(?:of<WS>+your<WS>+|single<WS>+)?(?:response|reply|answer|message|output|summary)s?<WS>+with<WS>+(?:the<WS>+)?(?:\[|"|'|prefix|word|phrase|tag|string|literal|exact|hashtag|line|text|sentence|footer|disclaimer|badge|url|link|a<WS>+)|add<WS>+the<WS>+prefix<WS>+\[|(?:every|each)<WS>+(?:response|reply|answer)<WS>+(?:must|should|will)<WS>+(?:begin|start|end|open|close)<WS>+with|(?:always|must)<WS>+(?:include|append|add|prepend|attach|render)<WS>+(?:the<WS>+following<WS>+|this<WS>+|a<WS>+|the<WS>+)?(?:footer|badge|disclaimer|hashtag|hidden<WS>+[a-z]+|invisible<WS>+[a-z]+|watermark|tracking<WS>+[a-z]+|pixel|suffix|prefix)<B>|(?:end|close|finish)<WS>+(?:the<WS>+|your<WS>+|every<WS>+|each<WS>+)?(?:summary|response|reply|answer)<WS>+with<WS>+(?:the<WS>+)?(?:exact<WS>+)?(?:sentence|line|phrase|words?|hashtag|text|claim|url|link|badge|disclaimer|statement)<WS>*:?<WS>*['"#]|respond<WS>+(?:to<WS>+(?:all|every|each)<WS>+(?:user<WS>+)?(?:queries|questions|prompts|requests|messages)<WS>+)?(?:only<WS>+)?with<WS>+(?:a<WS>+single|only|just|nothing<WS>+but|the<WS>+(?:string|phrase|word|text|exact<WS>+(?:string|phrase|words?)))<B>|respond<WS>+only<WS>+with<WS>+(?:the<WS>+)?(?:words?|phrase|string|text|url)<WS>*['":]|reply<WS>+only<WS>+with<WS>+['"]|(?:simply|only|just)<WS>+respond<WS>*:?<WS>*['"]|(?:instead<WS>+)?(?:reply|respond)<WS>+with<WS>+only<WS>+(?:this|the<WS>+following|a<WS>+single|one)<B>|output<WS>*:<WS>*['"]ok,?<WS>+ready"##, ci: true },
    Rule { name: "prompt-boundary-spoof", sev: Severity::Suspicious, pattern: r#"(?:---+|\[|<|#+|\*\*)<WS>*end<WS>+(?:of<WS>+)?(?:user|upstream|system|assistant|tool|human|injected|retrieved|document)<WS>+(?:input|content|message|turn|prompt|output|context|text)<WS>*(?:---+|\]|>|\*\*)|<<<WS>*/?<WS>*(?:system|injected|sys|admin|operator|root|user_input|assistant|end<WS>+system)<WS>*>>|<\|(?:im_start|im_end|system|user|assistant|endoftext|eot_id|start_header_id|end_header_id|begin_of_text|eom_id|python_tag)\|>|\[/?INST\]|###<WS>*(?:system|assistant|human)<WS>*:|<<WS>*(?:ai-instruction|ai_directive|ai-directive|hidden-directive|hidden_directive)(?:<WS>+(?u:[^>\n])*)?>|\[/?(?:SYSTEM|INJECTED|ASSISTANT_INTERNAL)\]|\[(?:begin|end)<WS>+(?:of<WS>+)?(?:(?:privileged|hidden|system|operator|override|injected|internal)<WS>+)?(?:instruction|directive|prompt|context|message|content|section)s?<B>(?u:[^\]\n])*\]|---<WS>*(?:begin|end)<WS>+ai<WS>+assistant<WS>+override<WS>*---|the<WS>+delimiter<WS>+above|ignore<WS>+the<WS>+delimiter|real<WS>+instruction<WS>+starts<WS>+here|(?:^|\n)<WS>*(?:assistant|ai|model|bot)<WS>*:<WS>*(?:confirmed|understood,?<WS>+authori[sz]ation|authori[sz]ation<WS>+confirmed|i<WS>+am<WS>+(?:now<WS>+)?operating<WS>+in|acknowledged,?<WS>+(?:unrestricted|authori))"#, ci: true },
    Rule { name: "tool-abuse-directive", sev: Severity::Suspicious, pattern: r#"(?:execute|run|perform)<WS>+(?:whatever|any|every|all)<WS>+(?:i<WS>+type|command|tool<WS>+call|shell<WS>+command|instruction)s?<B>(?:<WS>+(?u:[^<WSC>.])+)*?<WS>+(?:literally|without<WS>+(?:question|commentary|confirmation|asking|safety)|it<WS>+requests?|they<WS>+request|they<WS>+ask|in<WS>+my<WS>+message)|(?:any|every)<WS>+(?:shell<WS>+)?command<WS>+(?:in<WS>+my<WS>+message<WS>+)?without<WS>+question|(?:read|cat|open|dump|print|output)<WS>+(?:the<WS>+(?:file<WS>+(?:at<WS>+)?|contents?<WS>+of<WS>+)?)?(?:/etc/(?:passwd|shadow|hosts)|~/\.(?:ssh|aws|kube|netrc|gnupg)<B>|id_rsa|/proc/self/environ)<B>(?:<WS>+(?u:[^<WSC>.])+)*?<WS>+(?:and|then)<WS>+(?:include|send|post|output|show|put|summari[sz]e|forward|paste|add)|include<WS>+its<WS>+(?:full<WS>+)?contents<WS>+(?:inline<WS>+)?in<WS>+your<WS>+(?:next<WS>+)?(?:reply|response|answer)|(?:add|append|insert|write)<WS>+(?:the<WS>+line<WS>+)?['"]?(?:[0-9]{1,3}\.){3}[0-9]{1,3}<WS>+(?u:[^<WSC>'"])+['"]?<WS>+to<WS>+/etc/hosts|insert<WS>+into<WS>+admin_users|grant<WS>+(?:admin|root|owner|write)<WS>+(?:access|privileges|rights|role)<WS>+to<WS>+(?:the<WS>+)?(?:attacker|[a-z0-9_-]*(?:bot|attacker|unknown)<B>|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})"#, ci: true },
];

/// The characters of `WS`, for negated classes: `[^<WSC>.]` is JS `[^\s.]`.
const WS_CHARS: &str = r" \t\n\x0b\x0c\r\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

/// A case-insensitive rule is compiled in ASCII mode, `(?-u:…)`, so that `(?i)` folds ASCII only, as JS `/i`
/// without `u` does (ſ and K do not match s and k), and `\w` is ASCII. Whitespace (`<WS>`) and the classes a
/// rule marks `(?u:…)` (negated ones, and those with a non-ASCII character or `<WSC>`) still read code points.
fn build_pattern(raw: &str, ci: bool) -> String {
    let ws = if ci { format!("(?u:{WS})") } else { WS.to_string() };
    let body = raw.replace("<WS>", &ws).replace("<WSC>", WS_CHARS).replace("<B>", BOUND);
    if ci { format!("(?-u:{body})") } else { body }
}

struct CompiledRule {
    name: &'static str,
    sev: Severity,
    re: Regex,
}

/// Caps on one rule's dense DFA. Determinization of a rule with an ambiguous bounded gap (`x+[^\]]{0,40}`)
/// does not terminate in any useful time; with these caps it fails at once instead, and the guest's input
/// (every rule's DFA bytes) stays bounded. `tests/policy.rs` asserts the sizes.
pub const RULE_DFA_SIZE_LIMIT: usize = 8 << 20;
const RULE_DETERMINIZE_LIMIT: usize = 128 << 20;

fn dense_config() -> dense::Config {
    dense::Config::new()
        .dfa_size_limit(Some(RULE_DFA_SIZE_LIMIT))
        .determinize_size_limit(Some(RULE_DETERMINIZE_LIMIT))
}

fn syntax_config(ci: bool) -> syntax::Config {
    syntax::Config::new().case_insensitive(ci).unicode(true).utf8(false)
}

fn compiled_rules() -> &'static Vec<CompiledRule> {
    static CELL: OnceLock<Vec<CompiledRule>> = OnceLock::new();
    CELL.get_or_init(|| {
        RULES
            .iter()
            .map(|r| {
                let pat = build_pattern(r.pattern, r.ci);
                let re = Regex::builder()
                    .syntax(syntax_config(r.ci))
                    .dense(dense_config())
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
    try_rule_dfa_bytes(pattern, ci).expect("policy: rule DFA compiles")
}

fn try_rule_dfa_bytes(pattern: &str, ci: bool) -> Result<Vec<u8>, String> {
    dense::DFA::builder()
        .syntax(syntax_config(ci))
        .configure(dense_config())
        .build(pattern)
        .map(|d| d.to_bytes_little_endian().0)
        .map_err(|e| e.to_string())
}

/// Every rule's serialized forward-DFA size (the bytes the guest reads and the policy root commits to), or
/// why it does not compile within the caps. For `examples/dfa_sizes.rs` and the size test.
pub fn rule_dfa_report() -> Vec<(&'static str, Result<usize, String>)> {
    RULES
        .iter()
        .map(|r| (r.name, try_rule_dfa_bytes(&build_pattern(r.pattern, r.ci), r.ci).map(|b| b.len())))
        .collect()
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
            let compiled = rule_dfa_bytes(&build_pattern(r.pattern, r.ci), r.ci);
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
        dfas: RULES.iter().map(|r| rule_dfa_bytes(&build_pattern(r.pattern, r.ci), r.ci)).collect(),
    }
}

/// A 4-byte-aligned copy of `bytes` (regex-automata `from_bytes` requires alignment; a plain
/// Vec<u8> is only 1-aligned and its pointer can move). Backed by a Vec<u32> (4-aligned alloc).
struct Aligned(Vec<u32>, usize);
impl Aligned {
    fn new(bytes: &[u8]) -> Self {
        let words = bytes.len().div_ceil(4);
        let mut v = vec![0u32; words.max(1)];
        // SAFETY: v is a freshly-allocated Vec<u32> (≥4-aligned); writing bytes.len() bytes
        // into its byte view is in-bounds (words*4 ≥ bytes.len()).
        let dst = unsafe { core::slice::from_raw_parts_mut(v.as_mut_ptr() as *mut u8, words * 4) };
        dst[..bytes.len()].copy_from_slice(bytes);
        Aligned(v, bytes.len())
    }
    fn bytes(&self) -> &[u8] {
        // SAFETY: viewing the Vec<u32> as its byte representation; len is the word-count*4,
        // and from_bytes reads only the valid DFA prefix.
        unsafe { core::slice::from_raw_parts(self.0.as_ptr() as *const u8, self.0.len() * 4) }
    }
}

fn dfa_is_match_serialized(dfa_bytes: &[u8], text: &str) -> bool {
    let aligned = Aligned::new(dfa_bytes);
    // SAFETY: from_bytes_unchecked skips the O(n) transition-table validation pass (the bulk of
    // the in-zkVM deserialization cost). Sound here because these bytes are produced by our own
    // `serialize_l1`/policy DFAs and are committed via policy_root — they are not attacker-
    // controlled. The build-time path (`run_layer1`) and the parity test guard correctness.
    let (dfa, _) = unsafe { dense::DFA::from_bytes_unchecked(aligned.bytes()) }
        .expect("deserialize forward DFA");
    dfa.try_search_fwd(&Input::new(text)).ok().flatten().is_some()
}

/// Guest-side path: run the pre-serialized DFAs. Identical result to `run_layer1` (proven by
/// the cross-mode parity test).
pub fn run_layer1_serialized(text: &str, pol: &SerializedL1) -> RawResult {
    let matched: Vec<bool> = pol.dfas.iter().map(|b| dfa_is_match_serialized(b, text)).collect();
    combine_l1(text, &matched)
}

/// Guest-side L0: the same decoders as `run_layer0`, with L1 evaluated on the pre-serialized DFAs.
/// Identical to `run_layer0` on every parity vector (tests/serialized.rs).
pub fn run_layer0_serialized(content: &str, pol: &SerializedL1) -> Option<L0Fire> {
    run_layer0_with(content, &|t| run_layer1_serialized(t, pol))
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
