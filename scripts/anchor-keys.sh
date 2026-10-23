#!/usr/bin/env bash
# Copy the committed program keypairs (keys/localnet) into target/deploy so `anchor build`/`test`
# use the fixed program ids (the test proof binds transfer_gate's id). Location-relative.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/target/deploy"
for p in blindseal_verify transfer_gate; do
  cp "$ROOT/keys/localnet/$p-keypair.json" "$ROOT/target/deploy/$p-keypair.json"
done
echo "anchor-keys: synced blindseal_verify + transfer_gate keypairs → target/deploy"
