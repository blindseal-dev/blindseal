#!/usr/bin/env bash
# Release 0.7.0 on Solana MAINNET — STAGED for the owner; run one step at a time, by hand. Every step
# shows what it will do and waits for a typed confirmation; --dry-run prints the commands / transactions
# it would send and sends nothing.
#
#   scripts/mainnet-0.7.0.sh [--dry-run] <step>
#
#   0    upgrade transfer-gate, THEN blindseal-verify, from verifiable builds
#        (solana-verify, solanafoundation/solana-verifiable-build:4.3.0), and check each deployed hash
#   b    register_policy_root(default policy root 0x36a9e9…)        (no-op if already registered)
#   a    set_config(allowlist_policies = true)                        (refuses unless the default root is registered)
#   c1   set_config(allowed_vkeys += CURRENT_VKEY 0x00cdf40c…)        (keeps the old vkey 0x006a0d1e…)
#   c2   LATER, after a new-vkey sample has landed on mainnet: set_config(allowed_vkeys −= old vkey)
#          scripts/mainnet-0.7.0.sh c2 --new-sample <attestation.json>
#   d    optional: set_authority(<Ledger pubkey>) — the config authority moves to the Ledger; both sign
#          scripts/mainnet-0.7.0.sh d --ledger-pubkey <pubkey of usb://ledger?key=0>
#
# Order: 0 → b → a → c1, then (later) c2, then (optionally) d. b runs BEFORE a: turning approved policies
# on before the default root is registered would refuse every attestation in between.
#
# Upgrade order (step 0): no account layout changes in this release — `set_authority` is a new
# instruction, the gate's expected-policy-root check only reads `public_inputs`, Config / PolicyRoot /
# Nullifier are unchanged, and the gate's CPI into verify_and_consume is unchanged — so either order is
# safe. transfer-gate goes first so its new check is live before anything else changes.
#
# Signer for 0 / a / b / c1 / c2: ~/.blindseal/mainnet-authority.json ($BLINDSEAL_MAINNET_AUTHORITY), which
# must be the programs' upgrade authority (step 0) and the Config authority (a–d). If the upgrade
# authority has moved to the Ledger, set BLINDSEAL_UPGRADE_AUTHORITY='usb://ledger?key=0' for step 0.
# Every signature is printed (SIGNATURE …): record them in the release notes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
RPC="${BLINDSEAL_RPC_URL:-https://api.mainnet-beta.solana.com}"
AUTH="${BLINDSEAL_MAINNET_AUTHORITY:-$HOME/.blindseal/mainnet-authority.json}"
UPGRADE_AUTH="${BLINDSEAL_UPGRADE_AUTHORITY:-$AUTH}"
MAINNET_GENESIS="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
VERIFY_ID=6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx
GATE_ID=9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa
BUILD_IMAGE=solanafoundation/solana-verifiable-build:4.3.0
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
REL="$HOME/.local/share/solana/install/releases/stable-487f1df22d4c1972c51408c346da9499b11e1366/solana-release/bin"
[ -d "$REL" ] && export PATH="$REL:$PATH"

DRY=""; STEP=""; EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    0|a|b|c1|c2|d) STEP="$1" ;;
    --new-sample|--ledger-pubkey) EXTRA+=("$1" "${2:?$1 needs a value}"); shift ;;
    *) sed -n '2,30p' "$0"; exit 2 ;;
  esac
  shift
done
[ -n "$STEP" ] || { sed -n '2,30p' "$0"; exit 2; }

confirm() { # <phrase>
  if [ -n "$DRY" ]; then echo "   (dry run: would ask you to type '$1')"; return 0; fi
  local got; read -r -p "   type '$1' to continue: " got
  [ "$got" = "$1" ] || { echo "aborted"; exit 1; }
}
run() { # print, then run unless dry
  echo "   \$ $*"
  [ -n "$DRY" ] || "$@"
}

echo "→ preflight (${DRY:+DRY RUN, }step $STEP)"
GEN=$(solana genesis-hash --url "$RPC")
[ "$GEN" = "$MAINNET_GENESIS" ] || { echo "RPC is not mainnet-beta (genesis $GEN); refusing"; exit 1; }
[ -f "$AUTH" ] || { echo "authority keypair missing: $AUTH"; exit 1; }
AUTH_PK=$(solana-keygen pubkey "$AUTH")
echo "   rpc $RPC   authority $AUTH_PK   balance $(solana balance "$AUTH_PK" --url "$RPC")"

case "$STEP" in
  0)
    echo "→ step 0: upgrade transfer-gate then blindseal-verify from verifiable builds ($BUILD_IMAGE)"
    [ -z "$(git status --porcelain -- programs)" ] || { echo "programs/ has uncommitted changes — build from the tagged commit"; exit 1; }
    echo "   commit $(git rev-parse HEAD)"
    UPGRADE_PK=$(solana-keygen pubkey "$UPGRADE_AUTH")
    for id in "$GATE_ID" "$VERIFY_ID"; do
      cur=$(solana program show "$id" --url "$RPC" | awk '/^Authority:/ {print $2}')
      [ "$cur" = "$UPGRADE_PK" ] || { echo "upgrade authority of $id is $cur, not $UPGRADE_PK (set BLINDSEAL_UPGRADE_AUTHORITY)"; exit 1; }
    done
    for lib in transfer_gate blindseal_verify; do
      run bash -c "cd programs && solana-verify build -b $BUILD_IMAGE --library-name $lib"
      [ -n "$DRY" ] || echo "   local executable hash $lib: $(solana-verify get-executable-hash "programs/target/deploy/$lib.so")"
    done
    for pair in "transfer_gate:$GATE_ID" "blindseal_verify:$VERIFY_ID"; do
      lib="${pair%%:*}"; id="${pair##*:}"
      echo "→ upgrade $lib ($id), deployed hash now: $(solana-verify get-program-hash "$id" --url "$RPC" 2>/dev/null || echo '?')"
      confirm "upgrade $lib"
      run solana program deploy "programs/target/deploy/$lib.so" --program-id "$id" \
        --upgrade-authority "$UPGRADE_AUTH" -k "$AUTH" --url "$RPC" --commitment confirmed
      if [ -z "$DRY" ]; then
        want=$(solana-verify get-executable-hash "programs/target/deploy/$lib.so")
        got=$(solana-verify get-program-hash "$id" --url "$RPC")
        echo "   deployed hash $got"
        [ "$want" = "$got" ] || { echo "deployed hash does not match the verifiable build ($want) — stop and investigate"; exit 1; }
      fi
    done
    echo "   record the two 'Signature:' lines above in the release notes"
    ;;
  a|b|c1|c2|d)
    case "$STEP" in
      b)  what="register the default policy root" ;;
      a)  what="turn approved policies on" ;;
      c1) what="allow the 0.7.0 vkey (keep the old one)" ;;
      c2) what="remove the old vkey" ;;
      d)  what="hand the config authority to the Ledger" ;;
    esac
    echo "→ step $STEP: $what"
    if [ "$STEP" = d ] && [ -z "$DRY" ]; then
      want=""; for ((i = 0; i < ${#EXTRA[@]}; i++)); do [ "${EXTRA[$i]}" = --ledger-pubkey ] && want="${EXTRA[$((i + 1))]}"; done
      [ -n "$want" ] || { echo "d needs --ledger-pubkey <pubkey>"; exit 1; }
      ledger=$(solana-keygen pubkey "usb://ledger?key=0") || { echo "Ledger not reachable: connect it, unlock it, open the Solana app"; exit 1; }
      [ "$ledger" = "$want" ] || { echo "the connected Ledger key is $ledger, not $want — stopping"; exit 1; }
      echo "   Ledger usb://ledger?key=0 = $ledger (matches)"
    fi
    pnpm -C packages/sdk build >/dev/null
    # always show the transaction first (read-only), then ask
    BLINDSEAL_RPC_URL="$RPC" BLINDSEAL_MAINNET_AUTHORITY="$AUTH" pnpm exec tsx scripts/lib/mainnet-admin-0.7.0.mts --step "$STEP" --dry-run "${EXTRA[@]+"${EXTRA[@]}"}"
    [ -n "$DRY" ] && exit 0
    confirm "$STEP"
    BLINDSEAL_RPC_URL="$RPC" BLINDSEAL_MAINNET_AUTHORITY="$AUTH" pnpm exec tsx scripts/lib/mainnet-admin-0.7.0.mts --step "$STEP" "${EXTRA[@]+"${EXTRA[@]}"}"
    ;;
esac
echo "step $STEP done${DRY:+ (dry run — nothing sent)}"
