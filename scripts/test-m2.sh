#!/usr/bin/env bash
# Run the M2 suite (tests/m2.spec.ts) and the payout-gate suite (tests/payout-gate.spec.ts) on a local
# validator we control: Agave 4.3.1 with the programs loaded at genesis at their fixed ids. `anchor test`'s own validator/deploy path used a
# different Solana release on this machine and could not load the v1.57-built programs
# ("Program is not deployed" / "program does not exist"); the direct validator works (see the
# admin smoke). Location-relative; prints the suite output and tests/m2-metrics.json.
# The test-only forwarder (programs/rogue-caller) is loaded at an id from a keypair generated here,
# in the temp dir, on every run — never stored in the repo — and handed to the suite as ROGUE_CALLER_ID.
# The suite initializes the localnet Config with the SDK defaults: BOTH guest vkeys (the current one and
# the legacy one the committed localnet proof was made with) and approved policies on.
# BLINDSEAL_SO_DIR overrides where the program binaries are loaded from (default target/deploy), e.g.
# to run this suite against an older build. BLINDSEAL_RPC_PORT (default 8899) picks the validator's RPC port
# (faucet = port + 1000, ledger dir suffixed with it) so two suites can run side by side on one machine.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
export PATH="$HOME/.cargo/bin:$PATH"
REL="$HOME/.local/share/solana/install/releases/stable-487f1df22d4c1972c51408c346da9499b11e1366/solana-release/bin"
[ -d "$REL" ] && export PATH="$REL:$PATH"
SO="${BLINDSEAL_SO_DIR:-target/deploy}"
[ -f "$SO/blindseal_verify.so" ] || { echo "build first: scripts/build-programs.sh"; exit 1; }
[ -f "$SO/rogue_caller.so" ] || { echo "build first (rogue_caller.so missing): scripts/build-programs.sh"; exit 1; }
[ -f "$SO/payout_gate.so" ] || { echo "build first (payout_gate.so missing): scripts/build-programs.sh"; exit 1; }
[ -f tests/fixtures/attestation-test.json ] || { echo "missing tests/fixtures/attestation-test.json (the localnet proof)"; exit 1; }
WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
[ -f "$WALLET" ] || solana-keygen new --no-bip39-passphrase -s -o "$WALLET" >/dev/null
PORT="${BLINDSEAL_RPC_PORT:-8899}"; FAUCET=$((PORT + 1000)); URL="http://127.0.0.1:$PORT"
LEDGER="${TMPDIR:-/tmp}/blindseal-m2-ledger-$PORT"; rm -rf "$LEDGER"
ROGUE_DIR="$(mktemp -d)"
solana-keygen new --no-bip39-passphrase -s -o "$ROGUE_DIR/rogue-caller.json" >/dev/null
ROGUE_CALLER_ID="$(solana-keygen pubkey "$ROGUE_DIR/rogue-caller.json")"; rm -rf "$ROGUE_DIR"
solana-test-validator -q -r --ledger "$LEDGER" --rpc-port "$PORT" --faucet-port "$FAUCET" \
  --bpf-program 6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx "$SO/blindseal_verify.so" \
  --bpf-program 9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa "$SO/transfer_gate.so" \
  --bpf-program EPgeMVvpCDaCGoav5NDFBySPTxASBQfVEvaUY6KPKL4k "$SO/payout_gate.so" \
  --bpf-program "$ROGUE_CALLER_ID" "$SO/rogue_caller.so" > /dev/null 2>&1 &
VPID=$!
trap 'kill $VPID 2>/dev/null; wait $VPID 2>/dev/null || true' EXIT
for i in $(seq 1 60); do solana cluster-version -u "$URL" >/dev/null 2>&1 && break; sleep 1; done
echo "validator up (${i}s): $(solana --version)"
solana airdrop 10 "$(solana-keygen pubkey "$WALLET")" -u "$URL" >/dev/null  # the RPC forwards to its own faucet
export ANCHOR_PROVIDER_URL="$URL" ANCHOR_WALLET="$WALLET" ROGUE_CALLER_ID
# payout-gate.spec.ts runs after m2.spec.ts on the same validator (it reuses the Config and policy root
# the M2 suite set up, and initialises them itself when run alone).
pnpm exec ts-mocha -p ./tests/tsconfig.json -t 1000000 tests/m2.spec.ts tests/payout-gate.spec.ts
echo; cat tests/m2-metrics.json
