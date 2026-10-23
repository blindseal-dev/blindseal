#!/bin/bash
set -e
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(cd "$(dirname "$0")" && pwd)"
LEDGER="${TMPDIR:-/tmp}/blindseal-m05-ledger"
rm -rf "$LEDGER"
echo "=== starting solana-test-validator ==="
solana-test-validator --reset --quiet --ledger "$LEDGER" >/dev/null 2>&1 &
VAL=$!
cleanup() { kill $VAL 2>/dev/null; }
trap cleanup EXIT
# wait for RPC
for i in $(seq 1 40); do solana cluster-version >/dev/null 2>&1 && { echo "validator up"; break; }; sleep 1; done
solana airdrop 100 >/dev/null 2>&1 || true
sleep 1
echo "balance: $(solana balance 2>/dev/null)"
echo "=== deploying program ==="
PID=$(solana program deploy target/deploy/blindseal_m05_program.so --output json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).programId)}catch{console.log("")}})')
echo "program id: $PID"
[ -z "$PID" ] && { echo "DEPLOY FAILED"; exit 1; }
solana program show "$PID" 2>&1 | grep -iE "executable|owner|balance|authority|slot" || true
sleep 4
echo "=== running localnet verify client ==="
cd script
../target/release/m05-localnet "$PID"
