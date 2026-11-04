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
# to run this suite against an older build. With BLINDSEAL_OLD_VERIFY_SO set (the deployed verifier
# binary), the 0.8.0 Config migration rehearsal (scripts/test-fee-migration.sh) runs afterwards.
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
SO="${BLINDSEAL_SO_DIR:-target/deploy}"
[ -f "$SO/blindseal_verify.so" ] || { echo "build first: scripts/build-programs.sh"; exit 1; }
[ -f "$SO/rogue_caller.so" ] || { echo "build first (rogue_caller.so missing): scripts/build-programs.sh"; exit 1; }
[ -f "$SO/payout_gate.so" ] || { echo "build first (payout_gate.so missing): scripts/build-programs.sh"; exit 1; }
[ -f tests/fixtures/attestation-test.json ] || { echo "missing tests/fixtures/attestation-test.json (the localnet proof)"; exit 1; }
WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
[ -f "$WALLET" ] || solana-keygen new --no-bip39-passphrase -s -o "$WALLET" >/dev/null
LEDGER="${TMPDIR:-/tmp}/blindseal-m2-ledger-$PORT"; rm -rf "$LEDGER"
ROGUE_DIR="$(mktemp -d)"
solana-keygen new --no-bip39-passphrase -s -o "$ROGUE_DIR/rogue-caller.json" >/dev/null
ROGUE_CALLER_ID="$(solana-keygen pubkey "$ROGUE_DIR/rogue-caller.json")"; rm -rf "$ROGUE_DIR"
solana-test-validator -q -r --ledger "$LEDGER" "${PORT_FLAGS[@]}" \
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
# One @solana/web3.js copy for the suite and for Anchor: with two, a Transaction built by the suite fails the
# Connection's instanceof check (TypeError ... numRequiredSignatures) — a lockfile problem, reported as one.
node -e "const fs=require('fs'),path=require('path'); const a=fs.realpathSync(require.resolve('@solana/web3.js')); const b=fs.realpathSync(require.resolve('@solana/web3.js',{paths:[path.dirname(require.resolve('@coral-xyz/anchor'))]})); if(a!==b){console.error('two @solana/web3.js copies (regenerate pnpm-lock.yaml):\\n '+a+'\\n '+b);process.exit(1)}"
# payout-gate.spec.ts runs after m2.spec.ts on the same validator (it reuses the Config and policy root
# the M2 suite set up, and initialises them itself when run alone).
pnpm exec ts-mocha -p ./tests/tsconfig.json -t 1000000 tests/m2.spec.ts tests/payout-gate.spec.ts
echo; cat tests/m2-metrics.json
if [ -n "${BLINDSEAL_OLD_VERIFY_SO:-}" ]; then
  kill $VPID 2>/dev/null; wait $VPID 2>/dev/null || true; trap - EXIT
  echo; echo "→ 0.8.0 Config migration rehearsal (scripts/test-fee-migration.sh)"
  scripts/test-fee-migration.sh
else
  echo "(migration rehearsal skipped: set BLINDSEAL_OLD_VERIFY_SO to the deployed verifier binary to run scripts/test-fee-migration.sh)"
fi
