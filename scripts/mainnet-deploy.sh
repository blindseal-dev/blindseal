#!/usr/bin/env bash
# Deploy blindseal-verify + transfer-gate to Solana MAINNET and initialise the verifier.
# Upgrade authority = the dedicated keypair in ~/.blindseal/mainnet-authority.json (docs/internal/BLOCKERS.md),
# NOT ~/.config/solana/id.json. Program keypairs live OFFLINE in ~/.blindseal/programs/ (never in the repo).
# Preflight refuses any RPC that is not mainnet-beta and any unfunded authority.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC="${BLINDSEAL_RPC_URL:-https://api.mainnet-beta.solana.com}"
AUTH="${BLINDSEAL_MAINNET_AUTHORITY:-$HOME/.blindseal/mainnet-authority.json}"
MAINNET_GENESIS="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
if [ -d "$HOME/.local/share/solana/install/releases/stable-487f1df22d4c1972c51408c346da9499b11e1366/solana-release/bin" ]; then
  export PATH="$HOME/.local/share/solana/install/releases/stable-487f1df22d4c1972c51408c346da9499b11e1366/solana-release/bin:$PATH"
fi

[ -f "$AUTH" ] || { echo "authority keypair missing: $AUTH"; exit 1; }
[ -f "$ROOT/target/deploy/blindseal_verify.so" ] || { echo "build first: scripts/build-programs.sh"; exit 1; }
[ "${BLINDSEAL_RPC_URL:-}" ] || echo "note: BLINDSEAL_RPC_URL unset — using the public mainnet RPC (rate-limited)"

echo "→ preflight"
GEN=$(solana genesis-hash --url "$RPC")
[ "$GEN" = "$MAINNET_GENESIS" ] || { echo "RPC is not mainnet-beta (genesis $GEN); refusing"; exit 1; }
AUTH_PK=$(solana-keygen pubkey "$AUTH")
BAL=$(solana balance "$AUTH_PK" --url "$RPC" | awk '{print $1}')
echo "   authority $AUTH_PK balance $BAL SOL"
awk -v b="$BAL" 'BEGIN{ if (b+0 < 3.0) { print "   needs ≥ 3 SOL for two program deploys + rent; fund it (docs/internal/BLOCKERS.md)"; exit 1 } }'

deploy() { # name
  local id; id=$(solana-keygen pubkey "$HOME/.blindseal/programs/$1-keypair.json")
  if solana program show "$id" --url "$RPC" >/dev/null 2>&1; then
    echo "→ $1 already deployed at $id — upgrading"
    solana program deploy "$ROOT/target/deploy/$1.so" --program-id "$HOME/.blindseal/programs/$1-keypair.json" \
      --upgrade-authority "$AUTH" -k "$AUTH" --url "$RPC" --commitment confirmed
  else
    echo "→ deploying $1 → $id"
    solana program deploy "$ROOT/target/deploy/$1.so" --program-id "$HOME/.blindseal/programs/$1-keypair.json" \
      --upgrade-authority "$AUTH" -k "$AUTH" --url "$RPC" --commitment confirmed
  fi
  echo "→ verify upgrade authority"
  solana program show "$id" --url "$RPC" | tee /dev/stderr | grep -q "Authority: $AUTH_PK" || { echo "upgrade authority is not $AUTH_PK"; exit 1; }
}
deploy blindseal_verify
deploy transfer_gate

echo "→ initialize Config + register the default policy root"
( cd "$ROOT" && BLINDSEAL_RPC_URL="$RPC" BLINDSEAL_MAINNET_AUTHORITY="$AUTH" pnpm exec tsx scripts/mainnet-init.mts )
echo "mainnet deploy complete. Record the program ids + signatures in docs/internal/REPORT.md."
