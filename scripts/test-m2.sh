#!/usr/bin/env bash
# Run the M2 suite (tests/m2.spec.ts) on a local validator we control: Agave 4.3.1 with both
# programs loaded at genesis at their fixed ids. `anchor test`'s own validator/deploy path used a
# different Solana release on this machine and could not load the v1.57-built programs
# ("Program is not deployed" / "program does not exist"); the direct validator works (see the
# admin smoke). Location-relative; prints the suite output and tests/m2-metrics.json.
# The test-only forwarder (programs/rogue-caller) is loaded at an id from a keypair generated here,
# in the temp dir, on every run — never stored in the repo — and handed to the suite as ROGUE_CALLER_ID.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
export PATH="$HOME/.cargo/bin:$PATH"
REL="$HOME/.local/share/solana/install/releases/stable-487f1df22d4c1972c51408c346da9499b11e1366/solana-release/bin"
[ -d "$REL" ] && export PATH="$REL:$PATH"
[ -f target/deploy/blindseal_verify.so ] || { echo "build first: scripts/build-programs.sh"; exit 1; }
[ -f target/deploy/rogue_caller.so ] || { echo "build first (rogue_caller.so missing): scripts/build-programs.sh"; exit 1; }
[ -f tests/fixtures/attestation-test.json ] || { echo "missing tests/fixtures/attestation-test.json (the localnet proof)"; exit 1; }
WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
[ -f "$WALLET" ] || solana-keygen new --no-bip39-passphrase -s -o "$WALLET" >/dev/null
LEDGER="${TMPDIR:-/tmp}/blindseal-m2-ledger"; rm -rf "$LEDGER"
ROGUE_DIR="$(mktemp -d)"
solana-keygen new --no-bip39-passphrase -s -o "$ROGUE_DIR/rogue-caller.json" >/dev/null
ROGUE_CALLER_ID="$(solana-keygen pubkey "$ROGUE_DIR/rogue-caller.json")"; rm -rf "$ROGUE_DIR"
solana-test-validator -q -r --ledger "$LEDGER" \
  --bpf-program 6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx target/deploy/blindseal_verify.so \
  --bpf-program 9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa target/deploy/transfer_gate.so \
  --bpf-program "$ROGUE_CALLER_ID" target/deploy/rogue_caller.so > /dev/null 2>&1 &
VPID=$!
trap 'kill $VPID 2>/dev/null; wait $VPID 2>/dev/null || true' EXIT
for i in $(seq 1 60); do solana cluster-version -u http://127.0.0.1:8899 >/dev/null 2>&1 && break; sleep 1; done
echo "validator up (${i}s): $(solana --version)"
solana airdrop 10 "$(solana-keygen pubkey "$WALLET")" -u http://127.0.0.1:8899 >/dev/null
export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET="$WALLET" ROGUE_CALLER_ID
pnpm exec ts-mocha -p ./tests/tsconfig.json -t 1000000 tests/m2.spec.ts
echo; cat tests/m2-metrics.json
