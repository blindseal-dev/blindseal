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
#   add --execute to any of them for a dry run in the SP1 executor (minutes, no proof, nothing written)
#
# Both bind the seed-derived localnet wallets (tests/m2.spec.ts: sha256("blindseal-localnet:<label>"))
# and tests/fixtures/payload-test-current.json, whose tool call names exactly that transfer — the
# 0.7.0 guest refuses any other pairing. Local prover only, never the network; nothing is sent anywhere.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
export PATH="$HOME/.cargo/bin:$PATH"
WHICH="${1:-}"; MODE="${2:-}"
case "$WHICH" in current|altpolicy|all) ;; *) sed -n '2,21p' "$0"; exit 2;; esac
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

if [ "$WHICH" = current ] || [ "$WHICH" = all ]; then
  prove current tests/fixtures/attestation-test-current.json
fi
if [ "$WHICH" = altpolicy ] || [ "$WHICH" = all ]; then
  prove altpolicy tests/fixtures/attestation-test-altpolicy.json --policy-variant one-rule-copied
fi
[ -n "${BLINDSEAL_EXECUTE:-}" ] || echo "next: scripts/test-m2.sh (the pending cases now run)"
