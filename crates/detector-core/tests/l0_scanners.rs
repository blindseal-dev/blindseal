//! The guest cannot compile regexes, so L0's span finders (src/l0.rs `spans`) are hand-written
//! scanners. This proves each one equals the regex it replaces — the regex-automata build of the
//! same pattern the TS reference uses — on every parity-corpus input and on random text drawn from an
//! alphabet that stresses the patterns (base64 characters, `=`, `+`, `%`, `0x`, `&#x`, `;`).
use blindseal_detector_core::l0::spans;
use regex_automata::{dfa::regex::Regex, util::syntax};
use serde::Deserialize;

fn re(pat: &str, ci: bool) -> Regex {
    Regex::builder().syntax(syntax::Config::new().unicode(true).utf8(false).case_insensitive(ci)).build(pat).unwrap()
}

#[derive(Deserialize)]
struct Vector {
    input: String,
}

fn corpus() -> Vec<String> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../evals/vectors/parity.json");
    let raw = std::fs::read_to_string(path).expect("read parity.json");
    let v: Vec<Vector> = serde_json::from_str(&raw).unwrap();
    v.into_iter().map(|v| v.input).collect()
}

/// Deterministic xorshift text generator over a pattern-stressing alphabet.
fn random_texts(n: usize) -> Vec<String> {
    const ALPHA: &[&str] = &[
        "a", "b", "Z", "9", "0", "x", "X", "+", "/", "=", "%", "4", "f", "F", "&", "#", ";", " ", "\n", "-", ".", "_",
        "0x", "%4", "%41", "&#x", "&#", "==", "ff", "aGVsbG8", "é", "\u{200B}", "ignore", "QUJD",
    ];
    let mut state: u64 = 0x9E3779B97F4A7C15;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    (0..n)
        .map(|_| {
            let len = (next() % 90) as usize;
            let mut s = String::new();
            for _ in 0..len {
                // bias toward long runs of one class
                let pick = ALPHA[(next() % ALPHA.len() as u64) as usize];
                let reps = if next() % 4 == 0 { 1 + (next() % 40) as usize } else { 1 };
                for _ in 0..reps {
                    s.push_str(pick);
                }
            }
            s
        })
        .collect()
}

fn inputs() -> Vec<String> {
    let mut v = corpus();
    v.extend(random_texts(6000));
    v
}

fn spans_of(re: &Regex, t: &str) -> Vec<(usize, usize)> {
    re.find_iter(t).map(|m| (m.start(), m.end())).collect()
}

#[test]
fn base64_spans_equal_the_regex() {
    let r = re(r"[A-Za-z0-9+/]{20,}={1,2}|[A-Za-z0-9/]{5,}[+][A-Za-z0-9+/]{15,}", false);
    for t in inputs() {
        assert_eq!(spans::base64(&t, 15), spans_of(&r, &t), "base64 spans differ on {t:?}");
    }
}

#[test]
fn hex_spans_equal_the_regex() {
    let r = re(r"(?:0x)?[0-9a-fA-F]{32,}", false);
    for t in inputs() {
        let got: Vec<(usize, usize)> = spans::hex(&t).into_iter().map(|(s, _, e)| (s, e)).collect();
        assert_eq!(got, spans_of(&r, &t), "hex spans differ on {t:?}");
        // the digits start after an `0x` prefix exactly when the match starts with one
        for (s, d, _) in spans::hex(&t) {
            assert_eq!(d - s, if t[s..].starts_with("0x") { 2 } else { 0 });
        }
    }
}

#[test]
fn url_spans_and_percent_count_equal_the_regexes() {
    let r = re(r"(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]|%[0-9a-fA-F]{2}){8,}", false);
    let pct = re(r"%[0-9a-fA-F]{2}", false);
    for t in inputs() {
        assert_eq!(spans::url(&t), spans_of(&r, &t), "url spans differ on {t:?}");
        assert_eq!(spans::percent_count(&t), pct.find_iter(&t).count(), "percent count differs on {t:?}");
    }
}

#[test]
fn entity_runs_and_refs_equal_the_regexes() {
    let run = re(r"(?:&#x?[0-9a-fA-F]+;){4,}", true);
    let hexref = re(r"&#x([0-9a-fA-F]+);", true);
    let decref = re(r"&#([0-9]+);", true);
    for t in inputs() {
        assert_eq!(spans::entity_runs(&t), spans_of(&run, &t), "entity runs differ on {t:?}");
        let got: Vec<(usize, usize)> = spans::refs(&t, true).into_iter().map(|(s, _, _, e)| (s, e)).collect();
        assert_eq!(got, spans_of(&hexref, &t), "hex refs differ on {t:?}");
        let got: Vec<(usize, usize)> = spans::refs(&t, false).into_iter().map(|(s, _, _, e)| (s, e)).collect();
        assert_eq!(got, spans_of(&decref, &t), "decimal refs differ on {t:?}");
    }
}

#[test]
fn homoglyph_table_has_no_ascii_keys_and_no_duplicates() {
    use blindseal_detector_core::HOMOGLYPHS;
    let mut seen = std::collections::BTreeSet::new();
    for (from, to) in HOMOGLYPHS {
        assert!(!from.is_ascii(), "{from:?} is ASCII");
        assert!(to.is_ascii_alphabetic(), "{to:?} is not an ASCII letter");
        assert!(seen.insert(*from), "duplicate table entry {from:?}");
    }
}
