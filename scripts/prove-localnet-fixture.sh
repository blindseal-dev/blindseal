#!/usr/bin/env bash
# Produce the REAL Groth16 localnet fixtures the 0.7.0 on-chain suite (scripts/test-m2.sh) uses when
# present. Each is a full local CPU prove under the committed guest ELF (≈ 2 h on the M-series dev
# machine; docs/performance.md) — run it yourself, then re-run scripts/test-m2.sh: the two cases
# reported as "pending" become real.
#
#   scripts/prove-localnet-fixture.sh current     → tests/fixtures/attestation-test-current.json
#       the current guest (vkey = CURRENT_VKEY), payload bound to the action: the suite's
#       "current-vkey attestation executes through the gate" case
#   scripts/prove-localnet-fixture.sh altpolicy   → tests/fixtures/attestation-test-altpolicy.json
#       the audit's "one rule copied" probe: the default policy with rule 0's DFA replaced by a copy
#       of rule 1's (prover --policy-variant one-rule-copied, test-only), so a different policy root;
#       the suite asserts transfer-gate refuses it on chain (UnexpectedPolicyRoot)
#   scripts/prove-localnet-fixture.sh all         → both, one after the other (≈ 4 h)
#   scripts/prove-localnet-fixture.sh payout      → tests/fixtures/attestation-payout-1.json and -2.json (≈ 4 h)
#       two SPL payouts through programs/payout-gate (batch_payout) from the seeded localnet payout wallets
#       (tests/payout-gate.spec.ts; payloads tests/fixtures/payload-payout-{1,2}.json). Until they exist the
#       suite reports the batch happy path, the amount-mismatch and the replay cases as pending.
#   add --execute to any of them for a dry run in the SP1 executor (minutes, no proof, nothing written)
#
# Both bind the seed-derived localnet wallets (tests/m2.spec.ts: sha256("blindseal-localnet:<label>"))
# and tests/fixtures/payload-test-current.json, whose tool call names exactly that transfer — the
# 0.7.0 guest refuses any other pairing. Local prover only, never the network; nothing is sent anywhere.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
export PATH="$HOME/.cargo/bin:$PATH"
WHICH="${1:-}"; MODE="${2:-}"
case "$WHICH" in current|altpolicy|all|payout) ;; *) sed -n '2,25p' "$0"; exit 2;; esac
[ "$MODE" = "--execute" ] && export BLINDSEAL_EXECUTE=1

cargo build --release --manifest-path crates/prover/Cargo.toml
PROVER=crates/prover/target/release/blindseal-prover

COMMON=(
  --payload tests/fixtures/payload-test-current.json
  --target-program 9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa   # transfer-gate
  --source-authority Zv5PpLYUkScw7BUCbPhREpDXbdkJ21qMpsu54vYr1E4  # seeded source-authority
  --recipient 7yWHC82fn96N6XTJBXdwkSBQHtLZZJTjr4SxXtGLQM24        # seeded recipient
  --amount 1000000
  --instruction 0x981894646560fc2b                                # gated_transfer
  --expiry 2000000000 --chain-id 1
)

prove() { # <name> <out> [extra prover args…]
  local name="$1" out="$2"; shift 2
  echo "→ $name: $PROVER ${COMMON[*]} --out $out $*"
  local t0=$SECONDS
  "$PROVER" "${COMMON[@]}" --out "$out" --decision-id "localnet-$name" "$@"
  echo "← $name done in $(( (SECONDS - t0) / 60 )) min"
}

# payout-gate: the seeded wallets payout-payer / payout-recipient-{1,2} / payout-mint (tests/payout-gate.spec.ts),
# batch_payout's discriminator sha256("global:batch_payout")[..8]; each payout is its own attestation.
PAYOUT_COMMON=(
  --target-program EPgeMVvpCDaCGoav5NDFBySPTxASBQfVEvaUY6KPKL4k   # payout-gate
  --source-authority i5cyemNLcZvjNpC6Td1BkinrXDc9krCAU6UFA5i7q9w  # seeded payout-payer
  --mint BianqHwTNRqBFDu4FjNVgNaJADMLRWgbiM8sLT3Es3cM             # seeded payout-mint
  --instruction 0x19eef5f04d0d4e44                                # batch_payout
  --expiry 2000000000 --chain-id 1
)
prove_payout() { # <n> <recipient> <amount>
  local n="$1" out="tests/fixtures/attestation-payout-$1.json"
  echo "→ payout-$n: $PROVER ${PAYOUT_COMMON[*]} --payload tests/fixtures/payload-payout-$n.json --recipient $2 --amount $3 --out $out"
  local t0=$SECONDS
  "$PROVER" "${PAYOUT_COMMON[@]}" --payload "tests/fixtures/payload-payout-$n.json" --recipient "$2" --amount "$3" --out "$out" --decision-id "localnet-payout-$n"
  echo "← payout-$n done in $(( (SECONDS - t0) / 60 )) min"
}

if [ "$WHICH" = payout ]; then
  prove_payout 1 H9GMqbp7bNsioYdjLeuDMkddpJ6Q6f7UiEU1gHi3zske 250000
  prove_payout 2 FvD47iqapuVfnHgFkMu5qbPwfktucUSyufLE7vEDRxzV 750000
fi
if [ "$WHICH" = current ] || [ "$WHICH" = all ]; then
  prove current tests/fixtures/attestation-test-current.json
fi
if [ "$WHICH" = altpolicy ] || [ "$WHICH" = all ]; then
  prove altpolicy tests/fixtures/attestation-test-altpolicy.json --policy-variant one-rule-copied
fi
[ -n "${BLINDSEAL_EXECUTE:-}" ] || echo "next: scripts/test-m2.sh (the pending cases now run)"
