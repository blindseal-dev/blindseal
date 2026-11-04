//! L0: decode-then-L1 (release 0.8.0: run inside the guest).
//!
//! Every decoder here is a port of the proxy's `layer0-decoder.ts` (`runLayer0`), which is the
//! TypeScript reference the parity harness (`evals/parity`) compares against. The guest cannot
//! compile regexes, so the span finders are hand-written linear scanners whose results equal the
//! reference regexes; `tests/l0_scanners.rs` proves that against the regex-automata versions on the
//! parity corpus and on random input.
//!
//! Decoders, in candidate order (the first candidate whose decoded text trips L1 decides):
//!  1. `base64`           strict base64 blobs (padding required, or a `+` inside the run), decoded the
//!                        way Node's `Buffer.from(blob, 'base64')` does: 6-bit groups, leftover bits and
//!                        anything from the first `=` on ignored;
//!  2. `hex`              `0x`-prefixed or bare even-length runs of ≥ 32 hex digits;
//!  3. `url-percent`      runs of URL characters with at least two `%XX`, percent-decoded as UTF-8;
//!  4. `html-entities`    runs of ≥ 4 numeric character references, hex refs first then decimal;
//!  5. `zero-width-strip` the text with invisible characters (U+200B–U+200D, U+2060, U+FEFF, U+00AD)
//!                        removed, when it had any;
//!  6. `nfkc`             the text's Unicode NFKC normalization, when it differs (fullwidth letters,
//!                        mathematical alphanumerics, ligatures, enclosed digits, …);
//!  7. `homoglyph`        the text with the confusables in `HOMOGLYPHS` folded to ASCII, when it had any;
//! then every decoder again on each candidate, nested to depth 3, deduplicated by `decoder:decoded`.
//! 1–4 keep only printable-ASCII results of at least `MIN_ENCODED_LEN` characters; 5–7 are
//! whole-text variants and keep whatever they produce.

use crate::RawResult;
use unicode_normalization::UnicodeNormalization;

pub const MIN_ENCODED_LEN: usize = 16;

/// Confusable → ASCII, applied character by character by the `homoglyph` decoder. Cyrillic and
/// Greek letters that render like Latin ones, plus the dotless i. Fullwidth and mathematical
/// letters are NFKC's job. Listed identically in the proxy (`HOMOGLYPHS` in layer0-decoder.ts);
/// `evals/parity` carries the whole table as a vector.
pub const HOMOGLYPHS: &[(char, char)] = &[
    // Cyrillic lowercase
    ('\u{0430}', 'a'), ('\u{0435}', 'e'), ('\u{043E}', 'o'), ('\u{0440}', 'p'), ('\u{0441}', 'c'),
    ('\u{0443}', 'y'), ('\u{0445}', 'x'), ('\u{0456}', 'i'), ('\u{0458}', 'j'), ('\u{0455}', 's'),
    ('\u{04BB}', 'h'), ('\u{0501}', 'd'), ('\u{051B}', 'q'), ('\u{051D}', 'w'), ('\u{0475}', 'v'),
    ('\u{04CF}', 'l'), ('\u{043F}', 'n'), ('\u{0433}', 'r'), ('\u{0442}', 't'), ('\u{043A}', 'k'),
    ('\u{0432}', 'b'), ('\u{043C}', 'm'), ('\u{0448}', 'w'), ('\u{0491}', 'r'),
    // Cyrillic uppercase
    ('\u{0410}', 'A'), ('\u{0412}', 'B'), ('\u{0415}', 'E'), ('\u{041A}', 'K'), ('\u{041C}', 'M'),
    ('\u{041D}', 'H'), ('\u{041E}', 'O'), ('\u{0420}', 'P'), ('\u{0421}', 'C'), ('\u{0422}', 'T'),
    ('\u{0425}', 'X'), ('\u{0423}', 'Y'), ('\u{0405}', 'S'), ('\u{0406}', 'I'), ('\u{0408}', 'J'),
    ('\u{0500}', 'D'), ('\u{051A}', 'Q'), ('\u{051C}', 'W'), ('\u{0474}', 'V'), ('\u{0413}', 'F'),
    // Greek lowercase
    ('\u{03B1}', 'a'), ('\u{03B5}', 'e'), ('\u{03BF}', 'o'), ('\u{03BD}', 'v'), ('\u{03B9}', 'i'),
    ('\u{03BA}', 'k'), ('\u{03C1}', 'p'), ('\u{03C4}', 't'), ('\u{03C5}', 'u'), ('\u{03C7}', 'x'),
    ('\u{03C9}', 'w'), ('\u{03B3}', 'y'), ('\u{03C3}', 'o'), ('\u{03B7}', 'n'),
    // Greek uppercase
    ('\u{0391}', 'A'), ('\u{0392}', 'B'), ('\u{0395}', 'E'), ('\u{0396}', 'Z'), ('\u{0397}', 'H'),
    ('\u{0399}', 'I'), ('\u{039A}', 'K'), ('\u{039C}', 'M'), ('\u{039D}', 'N'), ('\u{039F}', 'O'),
    ('\u{03A1}', 'P'), ('\u{03A4}', 'T'), ('\u{03A5}', 'Y'), ('\u{03A7}', 'X'),
    // Latin look-alikes outside ASCII
    ('\u{0131}', 'i'), ('\u{0269}', 'i'), ('\u{0261}', 'g'), ('\u{0251}', 'a'), ('\u{0183}', 'b'),
    ('\u{0188}', 'c'), ('\u{0256}', 'd'), ('\u{025B}', 'e'), ('\u{0283}', 's'), ('\u{028B}', 'v'),
    ('\u{0280}', 'r'), ('\u{0274}', 'n'), ('\u{0299}', 'b'), ('\u{029C}', 'h'), ('\u{1D00}', 'a'),
    ('\u{1D07}', 'e'), ('\u{1D0F}', 'o'), ('\u{1D1C}', 'u'),
];

/// Invisible characters the `zero-width-strip` decoder removes (TS `INVISIBLE_RE`).
pub fn is_invisible(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200D}' | '\u{2060}' | '\u{FEFF}' | '\u{00AD}')
}

fn is_printable_ascii(s: &str) -> bool {
    !s.is_empty()
        && s.bytes().all(|c| c == 0x09 || c == 0x0a || c == 0x0b || c == 0x0c || c == 0x0d || (0x20..=0x7e).contains(&c))
}

/// A decoded candidate (decoder label + decoded text), in discovery order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decoded {
    pub decoder: String,
    pub decoded: String,
}

// ---------------- span scanners (linear; equal to the reference regexes) ----------------

pub mod spans {
    //! Byte spans `(start, end)` of the encoded runs each decoder considers. All of them are ASCII
    //! runs, so byte offsets and UTF-16 offsets select the same text.

    fn is_b64(c: u8) -> bool {
        c.is_ascii_alphanumeric() || c == b'+' || c == b'/'
    }

    /// TS `base64Spans(text, tailMin)`: a run of ≥ 20 base64 characters followed by `=` or `==`
    /// (span includes the padding), or a run with a `+` preceded by ≥ 5 run characters and followed
    /// by ≥ `tail_min` more. Equals the regex
    /// `[A-Za-z0-9+/]{20,}={1,2}|[A-Za-z0-9/]{5,}[+][A-Za-z0-9+/]{tail_min,}`.
    pub fn base64(text: &str, tail_min: usize) -> Vec<(usize, usize)> {
        let b = text.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < b.len() {
            if !is_b64(b[i]) {
                i += 1;
                continue;
            }
            let start = i;
            while i < b.len() && is_b64(b[i]) {
                i += 1;
            }
            let j = i;
            if j - start >= 20 && j < b.len() && b[j] == b'=' {
                let end = if j + 1 < b.len() && b[j + 1] == b'=' { j + 2 } else { j + 1 };
                out.push((start, end));
                i = end;
                continue;
            }
            let mut seg = start;
            let mut q = start;
            while q < j {
                if b[q] == b'+' {
                    if q - seg >= 5 {
                        if j - (q + 1) >= tail_min {
                            out.push((seg, j));
                        }
                        break;
                    }
                    seg = q + 1;
                }
                q += 1;
            }
        }
        out
    }

    fn hex_run_end(b: &[u8], from: usize) -> usize {
        let mut k = from;
        while k < b.len() && b[k].is_ascii_hexdigit() {
            k += 1;
        }
        k
    }

    /// `(?:0x)?[0-9a-fA-F]{32,}`, leftmost, non-overlapping: `(start, digits_start, end)`.
    pub fn hex(text: &str) -> Vec<(usize, usize, usize)> {
        let b = text.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'0' && i + 1 < b.len() && b[i + 1] == b'x' {
                let end = hex_run_end(b, i + 2);
                if end - (i + 2) >= 32 {
                    out.push((i, i + 2, end));
                    i = end;
                    continue;
                }
            }
            if b[i].is_ascii_hexdigit() {
                let end = hex_run_end(b, i);
                if end - i >= 32 {
                    out.push((i, i, end));
                    i = end;
                    continue;
                }
            }
            i += 1;
        }
        out
    }

    fn is_url_char(c: u8) -> bool {
        c.is_ascii_alphanumeric() || b"._~!$&'()*+,;=:@/-".contains(&c)
    }

    /// Length of the URL token at `i`: 1 for a URL character, 3 for `%XX`, 0 otherwise.
    fn url_token(b: &[u8], i: usize) -> usize {
        if i < b.len() && is_url_char(b[i]) {
            1
        } else if i + 2 < b.len() && b[i] == b'%' && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() {
            3
        } else {
            0
        }
    }

    /// `(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]|%[0-9a-fA-F]{2}){8,}`, leftmost, non-overlapping.
    pub fn url(text: &str) -> Vec<(usize, usize)> {
        let b = text.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < b.len() {
            let mut k = i;
            let mut tokens = 0usize;
            loop {
                let t = url_token(b, k);
                if t == 0 {
                    break;
                }
                k += t;
                tokens += 1;
            }
            if tokens >= 8 {
                out.push((i, k));
                i = k;
            } else {
                i += 1;
            }
        }
        out
    }

    /// Number of `%XX` sequences (non-overlapping, left to right).
    pub fn percent_count(s: &str) -> usize {
        let b = s.as_bytes();
        let (mut i, mut n) = (0, 0);
        while i < b.len() {
            if i + 2 < b.len() && b[i] == b'%' && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() {
                n += 1;
                i += 3;
            } else {
                i += 1;
            }
        }
        n
    }

    /// Length of one numeric character reference at `i` (`&#` `x`? hexdigit+ `;`), 0 if none.
    fn entity_len(b: &[u8], i: usize) -> usize {
        if i + 1 >= b.len() || b[i] != b'&' || b[i + 1] != b'#' {
            return 0;
        }
        let mut k = i + 2;
        if k < b.len() && (b[k] == b'x' || b[k] == b'X') {
            k += 1;
        }
        let digits = k;
        while k < b.len() && b[k].is_ascii_hexdigit() {
            k += 1;
        }
        if k == digits || k >= b.len() || b[k] != b';' {
            return 0;
        }
        k + 1 - i
    }

    /// `(?:&#x?[0-9a-fA-F]+;){4,}` (case-insensitive `x`), leftmost, non-overlapping.
    pub fn entity_runs(text: &str) -> Vec<(usize, usize)> {
        let b = text.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < b.len() {
            let mut k = i;
            let mut n = 0usize;
            loop {
                let l = entity_len(b, k);
                if l == 0 {
                    break;
                }
                k += l;
                n += 1;
            }
            if n >= 4 {
                out.push((i, k));
                i = k;
            } else {
                i += 1;
            }
        }
        out
    }

    /// `&#x<hex>;` (hex = true) or `&#<dec>;` (hex = false) references: `(start, digits_start, digits_end, end)`.
    pub fn refs(text: &str, hex: bool) -> Vec<(usize, usize, usize, usize)> {
        let b = text.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i + 1 < b.len() {
            if b[i] == b'&' && b[i + 1] == b'#' {
                let mut k = i + 2;
                let ok_prefix = if hex {
                    if k < b.len() && (b[k] == b'x' || b[k] == b'X') {
                        k += 1;
                        true
                    } else {
                        false
                    }
                } else {
                    true
                };
                if ok_prefix {
                    let d = k;
                    while k < b.len() && (if hex { b[k].is_ascii_hexdigit() } else { b[k].is_ascii_digit() }) {
                        k += 1;
                    }
                    if k > d && k < b.len() && b[k] == b';' {
                        out.push((i, d, k, k + 1));
                        i = k + 1;
                        continue;
                    }
                }
            }
            i += 1;
        }
        out
    }
}

// ---------------- decoders ----------------

/// Node `Buffer.from(blob, 'base64')`: 6-bit groups up to the first `=`, leftover bits dropped.
fn node_base64(blob: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(blob.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in blob.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => continue,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    out
}

fn keep(decoder: &str, bytes: Vec<u8>, out: &mut Vec<Decoded>) {
    if let Ok(s) = String::from_utf8(bytes) {
        if is_printable_ascii(&s) && s.len() >= MIN_ENCODED_LEN {
            out.push(Decoded { decoder: decoder.into(), decoded: s });
        }
    }
}

pub fn decode_base64(content: &str) -> Vec<Decoded> {
    let mut out = Vec::new();
    for (s, e) in spans::base64(content, 15) {
        keep("base64", node_base64(&content[s..e]), &mut out);
    }
    out
}

pub fn decode_hex(content: &str) -> Vec<Decoded> {
    let mut out = Vec::new();
    for (_, d, e) in spans::hex(content) {
        let hex = &content[d..e];
        if hex.len() % 2 != 0 {
            continue;
        }
        let bytes: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
        keep("hex", bytes, &mut out);
    }
    out
}

/// decodeURIComponent on a run whose every `%` starts a `%XX`: bytes → UTF-8, invalid → None.
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hi = (b[i + 1] as char).to_digit(16)?;
            let lo = (b[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn decode_url(content: &str) -> Vec<Decoded> {
    let mut out = Vec::new();
    for (s, e) in spans::url(content) {
        let encoded = &content[s..e];
        if spans::percent_count(encoded) < 2 {
            continue;
        }
        if let Some(decoded) = percent_decode(encoded) {
            if decoded != encoded && is_printable_ascii(&decoded) && decoded.len() >= MIN_ENCODED_LEN {
                out.push(Decoded { decoder: "url-percent".into(), decoded });
            }
        }
    }
    out
}

/// Replace `&#x..;` (hex) or `&#..;` (decimal) references; a code point outside Unicode or in the
/// surrogate range is left undecoded.
fn replace_refs(s: &str, hex: bool) -> String {
    let mut result = String::with_capacity(s.len());
    let mut last = 0usize;
    for (start, d0, d1, end) in spans::refs(s, hex) {
        result.push_str(&s[last..start]);
        let digits = &s[d0..d1];
        match u32::from_str_radix(digits, if hex { 16 } else { 10 })
            .ok()
            .filter(|&cp| cp <= 0x10FFFF && !(0xD800..=0xDFFF).contains(&cp))
            .and_then(char::from_u32)
        {
            Some(c) => result.push(c),
            None => result.push_str(&s[start..end]),
        }
        last = end;
    }
    result.push_str(&s[last..]);
    result
}

pub fn decode_html_entities(content: &str) -> Vec<Decoded> {
    let mut out = Vec::new();
    for (s, e) in spans::entity_runs(content) {
        let run = &content[s..e];
        let decoded = replace_refs(&replace_refs(run, true), false);
        if decoded != run && is_printable_ascii(&decoded) && decoded.len() >= MIN_ENCODED_LEN {
            out.push(Decoded { decoder: "html-entities".into(), decoded });
        }
    }
    out
}

pub fn decode_zero_width(content: &str) -> Vec<Decoded> {
    if !content.chars().any(is_invisible) {
        return Vec::new();
    }
    vec![Decoded { decoder: "zero-width-strip".into(), decoded: content.chars().filter(|c| !is_invisible(*c)).collect() }]
}

pub fn decode_nfkc(content: &str) -> Vec<Decoded> {
    if content.is_ascii() {
        return Vec::new();
    }
    let folded: String = content.nfkc().collect();
    if folded == content {
        return Vec::new();
    }
    vec![Decoded { decoder: "nfkc".into(), decoded: folded }]
}

fn homoglyph(c: char) -> Option<char> {
    if c.is_ascii() {
        return None;
    }
    HOMOGLYPHS.iter().find(|(from, _)| *from == c).map(|(_, to)| *to)
}

pub fn decode_homoglyph(content: &str) -> Vec<Decoded> {
    if content.is_ascii() || !content.chars().any(|c| homoglyph(c).is_some()) {
        return Vec::new();
    }
    vec![Decoded { decoder: "homoglyph".into(), decoded: content.chars().map(|c| homoglyph(c).unwrap_or(c)).collect() }]
}

/// Every decoder once over `content`, in candidate order.
pub fn all_decoders(content: &str) -> Vec<Decoded> {
    let mut v = Vec::new();
    v.extend(decode_base64(content));
    v.extend(decode_hex(content));
    v.extend(decode_url(content));
    v.extend(decode_html_entities(content));
    v.extend(decode_zero_width(content));
    v.extend(decode_nfkc(content));
    v.extend(decode_homoglyph(content));
    v
}

/// Port of TS `decodeNested` (depth up to 3, dedup by `decoder:decoded`), discovery order.
pub fn decode_nested(content: &str) -> Vec<Decoded> {
    let mut results: Vec<Decoded> = Vec::new();
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    fn recurse(
        text: &str,
        depth: usize,
        parent: &str,
        max_depth: usize,
        seen: &mut std::collections::BTreeSet<String>,
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
            results.push(Decoded { decoder: label.clone(), decoded: c.decoded.clone() });
            recurse(&c.decoded, depth + 1, &label, max_depth, seen, results);
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

/// Decode, then `l1` on every candidate (top level, then nested): the first non-clean one decides.
/// Shared by the host (`run_layer0`, compiled rules) and the guest (`run_layer0_serialized`,
/// pre-serialized DFAs), so the two differ only in how L1 is evaluated.
pub fn run_layer0_with(content: &str, l1: &dyn Fn(&str) -> RawResult) -> Option<L0Fire> {
    let mut candidates = all_decoders(content);
    candidates.extend(decode_nested(content));
    for c in candidates {
        let r = l1(&c.decoded);
        if r.verdict != crate::Severity::Clean {
            return Some(L0Fire { decoder: c.decoder, l1: r });
        }
    }
    None
}
