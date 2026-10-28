#!/usr/bin/env bash
# Release 0.7.0 on Solana MAINNET — STAGED for the owner; run one step at a time, by hand. Every step
# shows what it will do and waits for a typed confirmation; --dry-run prints the commands / transactions
# it would send and sends nothing.
#
#   scripts/mainnet-0.7.0.sh [--dry-run | --simulate] [--url <rpc>] <step> [step options]
#
#   --dry-run    print the commands / transactions it would send; sends nothing
#   --simulate   build the step's transaction(s) UNSIGNED and simulateTransaction them against the RPC
#                (sigVerify off) — logs, compute units, result, and the Config they would leave. Sends
#                nothing; re-run it right before signing. Step 0 cannot be simulated (an upgrade needs a
#                written buffer, and writing one is a send): --simulate 0 prints the cost plan instead.
#   --url <rpc>  RPC to use (default $BLINDSEAL_RPC_URL, else the public mainnet endpoint). Only mainnet-beta
#                or a LOCAL validator (127.0.0.1 / localhost, not devnet/testnet) is accepted — the local
#                one is for a rehearsal against solana-test-validator cloning mainnet. On a local cluster
#                only: c2's preconditions are reported but not enforced, and d takes
#                --new-authority-keypair <file> (a throwaway key standing in for the Ledger).
#
#   0    upgrade transfer-gate, THEN blindseal-verify, from verifiable builds
#        (solana-verify, solanafoundation/solana-verifiable-build:4.3.0), and check each deployed hash
#   b    register_policy_root(default policy root 0x36a9e9…)        (no-op if already registered)
#   a    set_config(allowlist_policies = true)                        (refuses unless the default root is registered)
#   c1   set_config(allowed_vkeys += CURRENT_VKEY 0x00cdf40c…)        (keeps the old vkey 0x006a0d1e…;
#                                                                      refuses unless a is done)
#   c2   LATER: set_config(allowed_vkeys −= old vkey). Preconditions (the step checks both): a 0.7.0
#        prover release is published and packages/proxy/src/prover/manifest.json points at it (until
#        then `blindseal attest` downloads prover 0.5.1 — old guest, old vkey — whose proofs c2 makes
#        unconsumable), and a new-vkey sample has landed on mainnet:
#          scripts/mainnet-0.7.0.sh c2 --new-sample <attestation.json>
#   d    optional: set_authority(<Ledger pubkey>) — the config authority moves to the Ledger; both sign
#          scripts/mainnet-0.7.0.sh d --ledger-pubkey <pubkey of usb://ledger?key=0>
#
# Order: 0 → b → a → c1, then (later) c2, then (optionally) d. b runs BEFORE a: turning approved policies
# on before the default root is registered would refuse every attestation in between. The gates enforce
# it: a refuses unless the root is registered, c1 unless a is done, c2 unless c1 is done.
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
RPC="${BLINDSEAL_RPC_URL:-https://api.mainnet-beta.solana.com}"  # --url overrides
AUTH="${BLINDSEAL_MAINNET_AUTHORITY:-$HOME/.blindseal/mainnet-authority.json}"
UPGRADE_AUTH="${BLINDSEAL_UPGRADE_AUTHORITY:-$AUTH}"
MAINNET_GENESIS="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
VERIFY_ID=6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx
GATE_ID=9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa
BUILD_IMAGE=solanafoundation/solana-verifiable-build:4.3.0
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
REL="$HOME/.local/share/solana/install/releases/stable-487f1df22d4c1972c51408c346da9499b11e1366/solana-release/bin"
[ -d "$REL" ] && export PATH="$REL:$PATH"

DRY=""; SIM=""; STEP=""; EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --simulate) SIM=1; DRY=1 ;;   # simulate implies: nothing is sent
    --url) RPC="${2:?--url needs a value}"; shift ;;
    0|a|b|c1|c2|d) STEP="$1" ;;
    --new-sample|--ledger-pubkey|--new-authority-keypair) EXTRA+=("$1" "${2:?$1 needs a value}"); shift ;;
    *) sed -n '2,42p' "$0"; exit 2 ;;
  esac
  shift
done
[ -n "$STEP" ] || { sed -n '2,42p' "$0"; exit 2; }

confirm() { # <phrase>
  if [ -n "$DRY" ]; then echo "   (dry run: would ask you to type '$1')"; return 0; fi
  local got; read -r -p "   type '$1' to continue: " got
  [ "$got" = "$1" ] || { echo "aborted"; exit 1; }
}
run() { # print (RPC URL redacted), then run unless dry
  local line="$*"; echo "   \$ ${line//$RPC/<rpc>}"
  [ -n "$DRY" ] || "$@"
}

echo "→ preflight (${SIM:+SIMULATION, }${DRY:+DRY RUN, }step $STEP)"
GEN=$(solana genesis-hash --url "$RPC")
LOCAL=""
if [ "$GEN" = "$MAINNET_GENESIS" ]; then CLUSTER=mainnet-beta
else
  host=$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$RPC")
  case "$host:$GEN" in
    *:EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG|*:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY) echo "RPC is devnet/testnet; refusing"; exit 1 ;;
    127.0.0.1:*|localhost:*) CLUSTER="LOCAL rehearsal validator (genesis $GEN)"; LOCAL=1 ;;
    *) echo "RPC is not mainnet-beta (genesis $GEN) and not a local validator; refusing"; exit 1 ;;
  esac
fi
[ -f "$AUTH" ] || { echo "authority keypair missing"; exit 1; }
AUTH_PK=$(solana-keygen pubkey "$AUTH")
echo "   cluster $CLUSTER   authority $AUTH_PK   balance $(solana balance "$AUTH_PK" --url "$RPC")"

case "$STEP" in
  0)
    echo "→ step 0: upgrade transfer-gate then blindseal-verify from verifiable builds ($BUILD_IMAGE)"
    [ -n "$SIM" ] || [ -z "$(git status --porcelain -- programs)" ] || { echo "programs/ has uncommitted changes — build from the tagged commit"; exit 1; }
    echo "   commit $(git rev-parse HEAD) (last change under programs/: $(git log -1 --format=%h -- programs))"
    UPGRADE_PK=$(solana-keygen pubkey "$UPGRADE_AUTH")
    for id in "$GATE_ID" "$VERIFY_ID"; do
      cur=$(solana program show "$id" --url "$RPC" | awk '/^Authority:/ {print $2}')
      [ "$cur" = "$UPGRADE_PK" ] || { echo "upgrade authority of $id is $cur, not $UPGRADE_PK (set BLINDSEAL_UPGRADE_AUTHORITY)"; exit 1; }
    done
    # a larger binary needs a larger ProgramData account: `program deploy` extends it first (this CLI
    # does so by default; --no-auto-extend exists) — else stop.
    solana program deploy --help 2>/dev/null | grep -q -- --no-auto-extend || {
      echo "this solana CLI does not auto-extend program data on upgrade; extend first:"
      echo "   solana program extend <program id> <additional bytes> -k <authority keypair> --url <rpc>"; exit 1; }
    if [ -z "$SIM" ]; then
      for lib in transfer_gate blindseal_verify; do
        run bash -c "cd programs && solana-verify build -b $BUILD_IMAGE --library-name $lib"
        [ -n "$DRY" ] || echo "   local executable hash $lib: $(solana-verify get-executable-hash "programs/target/deploy/$lib.so")"
      done
    fi
    # Cost plan. Rent-exempt minimums come from the cluster (mainnet's rent is lower than a local validator's
    # default). A buffer holds the binary + 37 bytes of header; ProgramData holds it + 45. `program deploy`
    # (upgrade) sends, per program (measured on the clone rehearsal with this CLI, 4.3.1):
    #   1 tx  System CreateAccount(buffer) + InitializeBuffer [+ ExtendProgram if the binary grew — the CLI
    #         extends by max(growth, 10240) bytes, in this same tx]; 2 signatures: payer + ephemeral buffer key
    #   ceil(size / WRITE_CHUNK) txs  Write
    #   1 tx  Upgrade — empties and closes the buffer and refunds its lamports to the payer (spill account).
    WRITE_CHUNK=1012   # program bytes per write tx with this CLI (measured on the clone rehearsal)
    rent() { solana rent "$1" --lamports --url "$RPC" | awk '/Rent-exempt minimum/ {print $3}'; }
    need=0; peak=0
    for pair in "transfer_gate:$GATE_ID" "blindseal_verify:$VERIFY_ID"; do
      lib="${pair%%:*}"; id="${pair##*:}"; so="programs/target/deploy/$lib.so"
      have=$(solana program show "$id" --url "$RPC" | awk '/^Data Length:/ {print $3}')
      [ -f "$so" ] || { echo "   $lib: ProgramData holds $have bytes; not built yet (no $so) — run without --simulate/--dry-run to build"; continue; }
      new=$(wc -c < "$so" | tr -d ' ')
      buf=$(rent $((new + 37))); grow=0; extb=0; ext=0
      [ "$new" -gt "$have" ] && { grow=$((new - have)); extb=$(( grow > 10240 ? grow : 10240 )); ext=$(( $(rent $((have + extb + 45))) - $(rent $((have + 45))) )); }
      writes=$(( (new + WRITE_CHUNK - 1) / WRITE_CHUNK )); txs=$(( writes + 2 ))
      echo "   $lib: ProgramData holds $have bytes, new binary $new bytes (grows $grow → extended by $extb); txs: 1 create buffer$([ $grow -gt 0 ] && echo ' + extend') + $writes writes + 1 upgrade = $txs"
      echo "      buffer rent held during the deploy $(node -p "($buf/1e9).toFixed(9)") SOL (refunded by the upgrade); ProgramData growth rent $(node -p "($ext/1e9).toFixed(9)") SOL (kept); fees $(node -p "(($txs+1)*5000/1e9).toFixed(9)") SOL"
      need=$(( need + ext + (txs + 1) * 5000 )); [ "$buf" -gt "$peak" ] && peak=$buf
    done
    bal=$(solana balance "$AUTH_PK" --url "$RPC" --lamports | awk '{print $1}')
    req=$(( need + peak + 20000000 ))   # + 0.02 SOL margin
    echo "   payer $AUTH_PK balance $(node -p "($bal/1e9).toFixed(9)") SOL; needs ≥ $(node -p "($req/1e9).toFixed(9)") SOL (largest buffer + growth + fees + 0.02 margin)"
    if [ "$bal" -lt "$req" ]; then
      [ -n "$SIM$DRY" ] && echo "   WARNING: balance too low — a real run refuses here" || { echo "balance too low; fund $AUTH_PK first"; exit 1; }
    fi
    if [ -n "$SIM" ]; then
      echo "   step 0 is not simulated: an upgrade needs a buffer already written on chain, and writing one is a send"
      echo "   (it costs the buffer rent). Rehearse it on a local clone instead: --url http://127.0.0.1:<port>"
      echo "step 0: cost plan only (simulation mode) — nothing sent"; exit 0
    fi
    for pair in "transfer_gate:$GATE_ID" "blindseal_verify:$VERIFY_ID"; do
      lib="${pair%%:*}"; id="${pair##*:}"
      echo "→ upgrade $lib ($id), deployed hash now: $(solana-verify get-program-hash "$id" --url "$RPC" 2>/dev/null || echo '?')"
      confirm "upgrade $lib"
      # If this stops mid-way (dropped writes, RPC error), the partly written buffer keeps its rent. Do NOT just
      # re-run (a second buffer may not fit the balance): resume with the printed buffer — recover its keypair
      # with `solana-keygen recover` from the printed seed phrase, then `solana program deploy … --buffer <file>` —
      # or reclaim it: `solana program close <buffer address> -k <authority> --url <rpc>`.
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
    if [ "$STEP" = c2 ]; then
      pv=$(node -p 'require("./packages/proxy/src/prover/manifest.json").version')
      if node -e 'const [a,b]=process.argv[1].split(".").map(Number); process.exit(a>0||b>=7?0:1)' "$pv"; then
        echo "   prover manifest $pv (≥ 0.7.0)"
      else
        msg="c2: the proxy's prover manifest is $pv — publish prover 0.7.0 (new guest) and update packages/proxy/src/prover/manifest.json first"
        if [ -n "$SIM$LOCAL" ]; then echo "   PRECONDITION NOT MET (a real mainnet send would refuse here): $msg"; else echo "$msg"; exit 1; fi
      fi
    fi
    if [ "$STEP" = d ] && [ -n "$LOCAL" ] && [ -z "$SIM" ]; then
      printf '%s\n' "${EXTRA[@]+"${EXTRA[@]}"}" | grep -qx -- --new-authority-keypair || { echo "d on a local rehearsal needs --new-authority-keypair <file> (stands in for the Ledger)"; exit 1; }
    elif [ "$STEP" = d ] && [ -z "$DRY" ]; then
      want=""; for ((i = 0; i < ${#EXTRA[@]}; i++)); do [ "${EXTRA[$i]}" = --ledger-pubkey ] && want="${EXTRA[$((i + 1))]}"; done
      [ -n "$want" ] || { echo "d needs --ledger-pubkey <pubkey>"; exit 1; }
      ledger=$(solana-keygen pubkey "usb://ledger?key=0") || { echo "Ledger not reachable: connect it, unlock it, open the Solana app"; exit 1; }
      [ "$ledger" = "$want" ] || { echo "the connected Ledger key is $ledger, not $want — stopping"; exit 1; }
      echo "   Ledger usb://ledger?key=0 = $ledger (matches)"
    fi
    pnpm -C packages/sdk build >/dev/null
    # always show the transaction first (read-only), then ask
    if [ -n "$SIM" ]; then
      BLINDSEAL_RPC_URL="$RPC" BLINDSEAL_MAINNET_AUTHORITY="$AUTH" pnpm exec tsx scripts/lib/mainnet-admin-0.7.0.mts --step "$STEP" --simulate "${EXTRA[@]+"${EXTRA[@]}"}"
      echo "step $STEP: simulated — nothing signed or sent"; exit 0
    fi
    BLINDSEAL_RPC_URL="$RPC" BLINDSEAL_MAINNET_AUTHORITY="$AUTH" pnpm exec tsx scripts/lib/mainnet-admin-0.7.0.mts --step "$STEP" --dry-run "${EXTRA[@]+"${EXTRA[@]}"}"
    [ -n "$DRY" ] && exit 0
    confirm "$STEP"
    BLINDSEAL_RPC_URL="$RPC" BLINDSEAL_MAINNET_AUTHORITY="$AUTH" pnpm exec tsx scripts/lib/mainnet-admin-0.7.0.mts --step "$STEP" "${EXTRA[@]+"${EXTRA[@]}"}"
    ;;
esac
echo "step $STEP done${DRY:+ (dry run — nothing sent)}"
