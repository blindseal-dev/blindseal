//! Payload → action binding (release 0.7.0; audit finding #7).
//!
//! Before the guest hashes or screens anything it parses the screened payload — the tool call,
//! serialized by `blindseal attest` as `{"tool": <name>, "args": {...}}` — into the on-chain action
//! it describes, and asserts that action equals the action fields it was handed (the ones folded
//! into actionHash). A payload that does not parse to an on-chain action cannot be attested, and a
//! payload screened for one transfer cannot be attested for another.
//!
//! The mapping mirrors the proxy's Solana adapter (`packages/proxy/src/chain/solana.ts`,
//! `parseSolanaAction`) key for key; the TypeScript mirror used by `blindseal attest` is
//! `packages/proxy/src/chain/action-binding.ts`, and both run the shared vectors in
//! `evals/vectors/action-binding.json`.
//!
//! Canonical rule (both sides):
//!  - the payload is a JSON object with exactly the keys `tool` (string) and `args` (object);
//!    duplicate keys resolve last-wins (as JSON.parse and serde_json do);
//!  - it is an on-chain action when the tool name is transfer-shaped (the adapter's TRANSFER_TOOL
//!    pattern, matched by hand here — no regex in the zkVM) or `args` names a program;
//!  - each field is the FIRST key of its priority list (not object order) whose value is a
//!    non-empty string or a number:
//!      recipient        ← recipient | to | destination | dest | receiver | toPubkey | toAddress
//!      amount           ← amount | lamports | value | tokenAmount | quantity
//!      mint             ← mint | token | tokenMint | mintAddress            (absent ⇒ native, zero)
//!      sourceAuthority  ← authority | owner | from | source | payer | fromPubkey | signer
//!      targetProgram    ← program | programId | programAddress            (absent ⇒ transfer-gate)
//!      instruction      ← instruction | method (non-empty string)          (absent ⇒ gated_transfer)
//!  - recipient, amount and sourceAuthority are required;
//!  - pubkeys are base58 that decodes to exactly 32 bytes;
//!  - amount is a decimal string of digits that fits u64, or a JSON number that is a non-negative
//!    integer ≤ 2^53−1 (larger numbers are not exact in JavaScript, so neither side accepts them);
//!  - instruction is 16 hex digits (optional 0x) taken as the 8 discriminator bytes, otherwise a
//!    name hashed to the Anchor discriminator sha256("global:" ‖ name)[..8];
//!  - chainId is 1 (Solana mainnet, the only chain).
//!
//! An integrator gating with its own program names it in the tool call (`program`) — the default
//! target is transfer-gate, the example gated program, with its `gated_transfer` discriminator.

use crate::ActionFields;
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

/// transfer-gate's program id (9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa) — the default target.
pub const TRANSFER_GATE_ID: [u8; 32] = [
    128, 201, 221, 198, 249, 14, 44, 146, 28, 133, 37, 225, 74, 93, 17, 100, 215, 237, 40, 177, 137, 34, 238, 161,
    194, 146, 125, 0, 130, 11, 56, 141,
];
/// sha256("global:gated_transfer")[..8] — transfer-gate's `gated_transfer` discriminator, the default instruction.
pub const GATED_TRANSFER_DISC: [u8; 8] = [0x98, 0x18, 0x94, 0x64, 0x65, 0x60, 0xfc, 0x2b];
/// chainId 1 = Solana mainnet.
pub const CHAIN_ID_SOLANA_MAINNET: u16 = 1;
/// Largest integer a JSON number may carry for `amount` (Number.MAX_SAFE_INTEGER).
pub const MAX_SAFE_INTEGER: u64 = (1u64 << 53) - 1;

pub const RECIPIENT_KEYS: &[&str] = &["recipient", "to", "destination", "dest", "receiver", "toPubkey", "toAddress"];
pub const AMOUNT_KEYS: &[&str] = &["amount", "lamports", "value", "tokenAmount", "quantity"];
pub const MINT_KEYS: &[&str] = &["mint", "token", "tokenMint", "mintAddress"];
pub const AUTHORITY_KEYS: &[&str] = &["authority", "owner", "from", "source", "payer", "fromPubkey", "signer"];
pub const PROGRAM_KEYS: &[&str] = &["program", "programId", "programAddress"];

/// Why a payload/action pair is refused. `code()` is the stable name the TS mirror and the shared
/// vectors use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindError {
    /// not JSON, not an object, or not exactly `{tool, args}` with a string tool and object args
    Unparseable,
    /// neither a transfer-shaped tool name nor an explicit program
    NotAnAction,
    MissingRecipient,
    MissingAmount,
    MissingSourceAuthority,
    BadRecipient,
    BadAmount,
    BadMint,
    BadSourceAuthority,
    BadProgram,
    ChainIdMismatch,
    TargetProgramMismatch,
    InstructionMismatch,
    SourceAuthorityMismatch,
    RecipientMismatch,
    MintMismatch,
    AmountMismatch,
}

impl BindError {
    pub fn code(&self) -> &'static str {
        match self {
            BindError::Unparseable => "unparseable",
            BindError::NotAnAction => "not-an-action",
            BindError::MissingRecipient => "missing-recipient",
            BindError::MissingAmount => "missing-amount",
            BindError::MissingSourceAuthority => "missing-source-authority",
            BindError::BadRecipient => "bad-recipient",
            BindError::BadAmount => "bad-amount",
            BindError::BadMint => "bad-mint",
            BindError::BadSourceAuthority => "bad-source-authority",
            BindError::BadProgram => "bad-program",
            BindError::ChainIdMismatch => "chain-id-mismatch",
            BindError::TargetProgramMismatch => "target-program-mismatch",
            BindError::InstructionMismatch => "instruction-mismatch",
            BindError::SourceAuthorityMismatch => "source-authority-mismatch",
            BindError::RecipientMismatch => "recipient-mismatch",
            BindError::MintMismatch => "mint-mismatch",
            BindError::AmountMismatch => "amount-mismatch",
        }
    }
}

impl core::fmt::Display for BindError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.code())
    }
}

/// A picked field: the adapter's `firstString` keeps the first key whose value is a non-empty
/// string or a number.
enum Picked<'a> {
    Str(&'a str),
    Num(&'a Number),
}

fn first_string<'a>(obj: &'a Map<String, Value>, keys: &[&str]) -> Option<Picked<'a>> {
    for k in keys {
        match obj.get(*k) {
            Some(Value::String(s)) if !s.is_empty() => return Some(Picked::Str(s)),
            Some(Value::Number(n)) => return Some(Picked::Num(n)),
            _ => {}
        }
    }
    None
}

fn pubkey(p: &Picked<'_>, err: BindError) -> Result<[u8; 32], BindError> {
    let s = match p {
        Picked::Str(s) => s,
        Picked::Num(_) => return Err(err),
    };
    let v = bs58::decode(s).into_vec().map_err(|_| err)?;
    v.as_slice().try_into().map_err(|_| err)
}

fn amount(p: &Picked<'_>) -> Result<u64, BindError> {
    match p {
        Picked::Str(s) => {
            if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
                return Err(BindError::BadAmount);
            }
            s.parse::<u64>().map_err(|_| BindError::BadAmount)
        }
        // JSON.parse reads every number as an f64: accept exactly the integral values in
        // [0, 2^53−1] (so 1e3 and 1.0 are 1000 and 1, and -0 is 0), as the TS mirror does.
        Picked::Num(n) => match (n.as_u64(), n.as_f64()) {
            (Some(v), _) if v <= MAX_SAFE_INTEGER => Ok(v),
            (None, Some(f)) if f.fract() == 0.0 && f >= 0.0 && f <= MAX_SAFE_INTEGER as f64 => Ok(f as u64),
            _ => Err(BindError::BadAmount),
        },
    }
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `instruction` / `method` value → 8 discriminator bytes.
pub fn instruction_bytes(s: &str) -> [u8; 8] {
    let h = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s);
    if h.len() == 16 {
        let b = h.as_bytes();
        let mut out = [0u8; 8];
        let mut ok = true;
        for i in 0..8 {
            match (hex_nibble(b[2 * i]), hex_nibble(b[2 * i + 1])) {
                (Some(hi), Some(lo)) => out[i] = (hi << 4) | lo,
                _ => ok = false,
            }
        }
        if ok {
            return out;
        }
    }
    let mut h = Sha256::new();
    h.update(b"global:");
    h.update(s.as_bytes());
    let d = h.finalize();
    let mut out = [0u8; 8];
    out.copy_from_slice(&d[..8]);
    out
}

/// Hand port of the adapter's
/// `/(?:^|_|\b)(?:transfer|send|pay|spl[_-]?transfer|transfer[_-]?checked)(?:_|\b|$)/i`
/// (JS, no `u` flag: ASCII case folding, ASCII word characters). A match exists iff one of the
/// words starts where the previous character is not an ASCII letter/digit (start, `_`, or a
/// non-word character) and ends where the next character is not an ASCII letter/digit.
pub fn is_transfer_tool(name: &str) -> bool {
    const WORDS: &[&str] = &[
        "transfer", "send", "pay",
        "spltransfer", "spl_transfer", "spl-transfer",
        "transferchecked", "transfer_checked", "transfer-checked",
    ];
    let b = name.as_bytes();
    for i in 0..b.len() {
        if i > 0 && b[i - 1].is_ascii_alphanumeric() {
            continue;
        }
        for w in WORDS {
            let end = i + w.len();
            if end <= b.len()
                && b[i..end].eq_ignore_ascii_case(w.as_bytes())
                && (end == b.len() || !b[end].is_ascii_alphanumeric())
            {
                return true;
            }
        }
    }
    false
}

/// Parse the screened payload into the action it describes (the canonical rule above).
pub fn action_from_payload(payload: &[u8]) -> Result<ActionFields, BindError> {
    let v: Value = serde_json::from_slice(payload).map_err(|_| BindError::Unparseable)?;
    let top = v.as_object().ok_or(BindError::Unparseable)?;
    if top.len() != 2 {
        return Err(BindError::Unparseable);
    }
    let tool = top.get("tool").and_then(Value::as_str).ok_or(BindError::Unparseable)?;
    let args = top.get("args").and_then(Value::as_object).ok_or(BindError::Unparseable)?;

    let explicit_program = first_string(args, PROGRAM_KEYS);
    if !is_transfer_tool(tool) && explicit_program.is_none() {
        return Err(BindError::NotAnAction);
    }
    let recipient = first_string(args, RECIPIENT_KEYS).ok_or(BindError::MissingRecipient)?;
    let amt = first_string(args, AMOUNT_KEYS).ok_or(BindError::MissingAmount)?;
    let source = first_string(args, AUTHORITY_KEYS).ok_or(BindError::MissingSourceAuthority)?;

    let recipient = pubkey(&recipient, BindError::BadRecipient)?;
    let amount = amount(&amt)?;
    let source_authority = pubkey(&source, BindError::BadSourceAuthority)?;
    let mint = match first_string(args, MINT_KEYS) {
        Some(m) => pubkey(&m, BindError::BadMint)?,
        None => [0u8; 32],
    };
    let target_program = match explicit_program {
        Some(p) => pubkey(&p, BindError::BadProgram)?,
        None => TRANSFER_GATE_ID,
    };
    let ix_name = [args.get("instruction"), args.get("method")]
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .find(|s| !s.is_empty());
    let instruction = match ix_name {
        Some(s) => instruction_bytes(s),
        None => GATED_TRANSFER_DISC,
    };
    Ok(ActionFields {
        chain_id: CHAIN_ID_SOLANA_MAINNET,
        target_program,
        source_authority,
        instruction,
        recipient,
        mint,
        amount,
    })
}

/// The guest's step 0: the payload must parse to an on-chain action equal to `action`, field by
/// field. The first differing field is reported (fixed order).
pub fn check_action_binding(payload: &[u8], action: &ActionFields) -> Result<(), BindError> {
    let p = action_from_payload(payload)?;
    if p.chain_id != action.chain_id {
        return Err(BindError::ChainIdMismatch);
    }
    if p.target_program != action.target_program {
        return Err(BindError::TargetProgramMismatch);
    }
    if p.instruction != action.instruction {
        return Err(BindError::InstructionMismatch);
    }
    if p.source_authority != action.source_authority {
        return Err(BindError::SourceAuthorityMismatch);
    }
    if p.recipient != action.recipient {
        return Err(BindError::RecipientMismatch);
    }
    if p.mint != action.mint {
        return Err(BindError::MintMismatch);
    }
    if p.amount != action.amount {
        return Err(BindError::AmountMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pk(s: &str) -> [u8; 32] {
        bs58::decode(s).into_vec().unwrap().try_into().unwrap()
    }

    const SRC: &str = "Zv5PpLYUkScw7BUCbPhREpDXbdkJ21qMpsu54vYr1E4";
    const DST: &str = "7yWHC82fn96N6XTJBXdwkSBQHtLZZJTjr4SxXtGLQM24";
    const OTHER: &str = "9H7xb7EXzwQ5RFmA2qWnNhML9geLjDFrZwhJYxCUVQzf";

    fn payload() -> Vec<u8> {
        format!(r#"{{"tool":"transfer_sol","args":{{"to":"{DST}","lamports":1000000,"from":"{SRC}","memo":"invoice"}}}}"#)
            .into_bytes()
    }

    fn action() -> ActionFields {
        ActionFields {
            chain_id: 1,
            target_program: TRANSFER_GATE_ID,
            source_authority: pk(SRC),
            instruction: GATED_TRANSFER_DISC,
            recipient: pk(DST),
            mint: [0u8; 32],
            amount: 1_000_000,
        }
    }

    #[test]
    fn constants_match_their_derivations() {
        assert_eq!(TRANSFER_GATE_ID, pk("9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa"));
        assert_eq!(instruction_bytes("gated_transfer"), GATED_TRANSFER_DISC);
        assert_eq!(instruction_bytes("0x981894646560fc2b"), GATED_TRANSFER_DISC);
    }

    #[test]
    fn matching_payload_binds() {
        assert_eq!(check_action_binding(&payload(), &action()), Ok(()));
    }

    #[test]
    fn binding_refuses_mismatched_recipient() {
        let mut a = action();
        a.recipient = pk(OTHER);
        assert_eq!(check_action_binding(&payload(), &a), Err(BindError::RecipientMismatch));
    }

    #[test]
    fn binding_refuses_mismatched_amount() {
        let mut a = action();
        a.amount += 1;
        assert_eq!(check_action_binding(&payload(), &a), Err(BindError::AmountMismatch));
    }

    #[test]
    fn binding_refuses_mismatched_source_authority() {
        let mut a = action();
        a.source_authority = pk(OTHER);
        assert_eq!(check_action_binding(&payload(), &a), Err(BindError::SourceAuthorityMismatch));
    }

    #[test]
    fn binding_refuses_mismatched_target_program() {
        let mut a = action();
        a.target_program = [0u8; 32]; // the System Program
        assert_eq!(check_action_binding(&payload(), &a), Err(BindError::TargetProgramMismatch));
    }

    #[test]
    fn binding_refuses_mismatched_instruction() {
        let mut a = action();
        a.instruction = instruction_bytes("transfer");
        assert_eq!(check_action_binding(&payload(), &a), Err(BindError::InstructionMismatch));
    }

    #[test]
    fn binding_refuses_mismatched_mint() {
        let mut a = action();
        a.mint = pk(OTHER);
        assert_eq!(check_action_binding(&payload(), &a), Err(BindError::MintMismatch));
    }

    #[test]
    fn binding_refuses_other_chain() {
        let mut a = action();
        a.chain_id = 2;
        assert_eq!(check_action_binding(&payload(), &a), Err(BindError::ChainIdMismatch));
    }

    #[test]
    fn binding_refuses_unparseable_payload() {
        for p in [&b"not json"[..], b"{}", b"[]", b"{\"tool\":\"transfer_sol\"}", b"{\"tool\":1,\"args\":{}}",
                  b"{\"tool\":\"transfer_sol\",\"args\":[]}", b"{\"tool\":\"t\",\"args\":{},\"x\":1}", b"\xff\xfe"] {
            assert_eq!(check_action_binding(p, &action()), Err(BindError::Unparseable), "{:?}", String::from_utf8_lossy(p));
        }
    }

    #[test]
    fn binding_refuses_payload_that_is_not_an_action() {
        let p = format!(r#"{{"tool":"read_file","args":{{"to":"{DST}","lamports":1,"from":"{SRC}"}}}}"#);
        assert_eq!(check_action_binding(p.as_bytes(), &action()), Err(BindError::NotAnAction));
    }

    #[test]
    fn transfer_tool_pattern_matches_the_adapter() {
        for yes in ["transfer_sol", "transfer", "send", "pay_invoice", "my_pay", "spl-transfer", "spltransfer",
                    "transferChecked", "token.transfer", "x-send-y", "TRANSFER"] {
            assert!(is_transfer_tool(yes), "{yes}");
        }
        for no in ["SendSol", "transfers", "sender", "payload", "repay", "get_balance", "", "xtransfer", "transfer2"] {
            assert!(!is_transfer_tool(no), "{no}");
        }
    }

    #[test]
    fn amount_rules() {
        let mk = |amt: &str| format!(r#"{{"tool":"transfer_sol","args":{{"to":"{DST}","lamports":{amt},"from":"{SRC}"}}}}"#);
        assert_eq!(action_from_payload(mk("\"1000000\"").as_bytes()).unwrap().amount, 1_000_000);
        assert_eq!(action_from_payload(mk("9007199254740991").as_bytes()).unwrap().amount, MAX_SAFE_INTEGER);
        assert_eq!(action_from_payload(mk("1e3").as_bytes()).unwrap().amount, 1000);
        assert_eq!(action_from_payload(mk("-0").as_bytes()).unwrap().amount, 0);
        assert_eq!(action_from_payload(mk("\"18446744073709551615\"").as_bytes()).unwrap().amount, u64::MAX);
        for bad in ["9007199254740992", "1.5", "-1", "9.007199254740992e15", "\"+5\"", "\"1.0\"", "\"18446744073709551616\"", "\" 1\""] {
            assert_eq!(action_from_payload(mk(bad).as_bytes()).map(|_| ()), Err(BindError::BadAmount), "{bad}");
        }
    }

    #[test]
    fn duplicate_keys_resolve_last_wins() {
        let p = format!(r#"{{"tool":"transfer_sol","args":{{"to":"{OTHER}","to":"{DST}","lamports":1000000,"from":"{SRC}"}}}}"#);
        assert_eq!(check_action_binding(p.as_bytes(), &action()), Ok(()));
    }

    #[test]
    fn priority_order_not_object_order() {
        // `recipient` outranks `to` whatever order they appear in
        let p = format!(r#"{{"tool":"transfer_sol","args":{{"to":"{OTHER}","recipient":"{DST}","lamports":1000000,"from":"{SRC}"}}}}"#);
        assert_eq!(check_action_binding(p.as_bytes(), &action()), Ok(()));
    }
}
