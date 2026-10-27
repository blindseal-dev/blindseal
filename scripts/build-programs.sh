#!/usr/bin/env bash
# Build the Anchor programs to SBF + generate IDLs. Location-relative.
#
# Why not plain `anchor build`: on this toolchain it kept selecting an old platform-tools
# (cargo 1.79, no edition2024) whatever was on PATH, so the SBF step is `cargo build-sbf
# --tools-version v1.57` directly (the proven m05 path), with its target dir OUTSIDE programs/
# (anchor treats every programs/* dir as a program). IDLs come from `anchor idl build`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"
if [ -d "$HOME/.local/share/solana/install/releases/stable-487f1df22d4c1972c51408c346da9499b11e1366/solana-release/bin" ]; then
  export PATH="$HOME/.local/share/solana/install/releases/stable-487f1df22d4c1972c51408c346da9499b11e1366/solana-release/bin:$PATH"
fi
rm -rf "$ROOT/programs/target"
for p in blindseal-verify transfer-gate rogue-caller; do  # rogue-caller: test-only (no IDL, never deployed)
  echo "→ cargo build-sbf $p"
  CARGO_TARGET_DIR="$ROOT/target/sbf" cargo build-sbf --tools-version v1.57 \
    --manifest-path "$ROOT/programs/$p/Cargo.toml" --sbf-out-dir "$ROOT/target/deploy"
done
mkdir -p "$ROOT/target/idl" "$ROOT/target/types"
for p in blindseal_verify transfer_gate; do
  echo "→ anchor idl build $p"
  ( cd "$ROOT" && CARGO_TARGET_DIR="$ROOT/target/idl-build" anchor idl build -p "$p" -o "target/idl/$p.json" -t "target/types/$p.ts" )
done
ls -la "$ROOT/target/deploy/"*.so "$ROOT/target/idl/"*.json
