#!/usr/bin/env bash
# Move the upgrade authority of BOTH programs to a hardware-wallet key. Run by the OWNER with the Ledger
# connected and unlocked (Solana app open); it never runs unattended. Usage:
#   scripts/move-upgrade-authority.sh <NEW_AUTHORITY_PUBKEY>
# It shows the current state, asks for an explicit "yes", moves each program with --skip-new-upgrade-authority-signer-check
# OFF (so the Ledger must sign to prove the new key is live), then re-reads both programs.
set -euo pipefail
NEW="${1:?usage: $0 <new-authority-pubkey from the Ledger>}"
RPC="${BLINDSEAL_RPC_URL:-https://api.mainnet-beta.solana.com}"
OLD_KEY="$HOME/.blindseal/mainnet-authority.json"
PROGRAMS=(6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx 9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa)
echo "current authority: $(solana-keygen pubkey "$OLD_KEY")"; echo "new authority (Ledger): $NEW"
for id in "${PROGRAMS[@]}"; do solana program show "$id" --url "$RPC" | grep -E "Program Id|Authority"; done
read -r -p "Type 'yes' to move both programs to $NEW: " ok; [ "$ok" = "yes" ] || { echo "aborted"; exit 1; }
for id in "${PROGRAMS[@]}"; do
  solana program set-upgrade-authority "$id" --upgrade-authority "$OLD_KEY" --new-upgrade-authority "usb://ledger?key=0" --url "$RPC" --keypair "$OLD_KEY"
done
for id in "${PROGRAMS[@]}"; do solana program show "$id" --url "$RPC" | grep -E "Program Id|Authority"; done
echo "Record the two signatures above in docs/internal/REPORT.md and docs/LAUNCH-CHECKLIST.md; then delete the old key from ~/.blindseal only after a test upgrade signs from the Ledger."
