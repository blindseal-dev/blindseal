#!/usr/bin/env bash
# Rehearse the 0.8.0 Config migration end to end on a local validator (tests/fee-migration.spec.ts):
# the CURRENTLY DEPLOYED verifier is loaded as an upgradeable program, initialized (303-byte Config),
# upgraded in place to the freshly built binary, and the spec then shows the legacy account still reads
# and consumes, `set_fee(0, treasury)` reallocs it to 343 bytes, and a consume under `set_fee(n, treasury)`
# moves exactly n lamports. transfer-gate is loaded from the new build (it must forward the new accounts).
#
# Needs the deployed verifier binary, which is not in the repo:
#   solana program dump 6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx <dir>/blindseal_verify.so -u <mainnet rpc>
#   BLINDSEAL_OLD_VERIFY_SO=<dir>/blindseal_verify.so scripts/test-fee-migration.sh
# Location-relative; run after scripts/build-programs.sh. scripts/test-m2.sh runs this when the variable is set.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
export PATH="$HOME/.cargo/bin:$PATH"
REL="$HOME/.local/share/solana/install/releases/stable-487f1df22d4c1972c51408c346da9499b11e1366/solana-release/bin"
[ -d "$REL" ] && export PATH="$REL:$PATH"
# BLINDSEAL_RPC_PORT (default 8899) moves the validator to its own ports and ledger so two suites can run
# on one machine: RPC P (websocket P+1), faucet P+1001, gossip P+1002, dynamic range P+1100..P+1300.
PORT="${BLINDSEAL_RPC_PORT:-8899}"; URL="http://127.0.0.1:$PORT"
PORT_FLAGS=(--rpc-port "$PORT" --faucet-port "$((PORT + 1001))")
[ "$PORT" = 8899 ] || PORT_FLAGS+=(--gossip-port "$((PORT + 1002))" --dynamic-port-range "$((PORT + 1100))-$((PORT + 1300))")
OLD="${BLINDSEAL_OLD_VERIFY_SO:-}"
[ -n "$OLD" ] && [ -f "$OLD" ] || { echo "set BLINDSEAL_OLD_VERIFY_SO to the deployed verifier binary (see the header)"; exit 1; }
SO="${BLINDSEAL_SO_DIR:-target/deploy}"
[ -f "$SO/blindseal_verify.so" ] && [ -f "$SO/transfer_gate.so" ] || { echo "build first: scripts/build-programs.sh"; exit 1; }
[ -f tests/fixtures/attestation-test.json ] || { echo "missing tests/fixtures/attestation-test.json"; exit 1; }
WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
[ -f "$WALLET" ] || solana-keygen new --no-bip39-passphrase -s -o "$WALLET" >/dev/null
WALLET_PK="$(solana-keygen pubkey "$WALLET")"
LEDGER="${TMPDIR:-/tmp}/blindseal-fee-migration-ledger-$PORT"; rm -rf "$LEDGER"
# The verifier as deployed, upgradeable by the test wallet; the gate from the new build. The verifiable-build
# image emits sBPF v0 ELFs (the deployed binaries are v0 too); a fresh test validator activates every feature,
# including SIMD-0500 (B8JJ…, "disable deployment of SBPF v0/v1/v2 programs"), which mainnet has not
# activated — deactivate it so the in-place upgrade behaves as on mainnet today.
solana-test-validator -q -r --ledger "$LEDGER" "${PORT_FLAGS[@]}" \
  --deactivate-feature B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g \
  --upgradeable-program 6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx "$OLD" "$WALLET_PK" \
  --bpf-program 9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa "$SO/transfer_gate.so" > /dev/null 2>&1 &
VPID=$!
trap 'kill $VPID 2>/dev/null; wait $VPID 2>/dev/null || true' EXIT
for i in $(seq 1 60); do solana cluster-version -u $URL >/dev/null 2>&1 && break; sleep 1; done
echo "validator up (${i}s): $(solana --version); old verifier $(wc -c < "$OLD" | tr -d ' ') B, new $(wc -c < "$SO/blindseal_verify.so" | tr -d ' ') B"
solana airdrop 20 "$WALLET_PK" -u $URL >/dev/null
export ANCHOR_PROVIDER_URL=$URL ANCHOR_WALLET="$WALLET" BLINDSEAL_NEW_VERIFY_SO="$SO/blindseal_verify.so"
pnpm exec ts-mocha -p ./tests/tsconfig.json -t 1000000 tests/fee-migration.spec.ts
