#!/usr/bin/env bash
# Regenerate @blindseal/verifier-wasm from the Rust crate (crates/verifier-wasm).
# Location-relative (no hardcoded home — see DECISIONS run-localnet.sh lesson).
# Requires: rustup wasm32-unknown-unknown target + wasm-bindgen-cli =0.2.129 (pinned to the crate).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CRATE="$HERE/../../crates/verifier-wasm"
PKG="$HERE/pkg"
export PATH="$HOME/.cargo/bin:$PATH"

# Remap the home prefix so dependency panic-paths don't embed the username in the .wasm.
export RUSTFLAGS="--remap-path-prefix=$HOME=~"

echo "→ cargo build (wasm32, release)"
( cd "$CRATE" && cargo build --release --lib --target wasm32-unknown-unknown )
WASM="$CRATE/target/wasm32-unknown-unknown/release/blindseal_verifier.wasm"

echo "→ wasm-bindgen --target web → pkg/"
rm -rf "$PKG" && mkdir -p "$PKG"
wasm-bindgen --target web --out-dir "$PKG" --out-name blindseal_verifier "$WASM"

echo "→ identity sweep (PART A) on the shipped binary"
if strings "$PKG"/blindseal_verifier_bg.wasm | grep -iqE 'blindseal|blindseal|/Users/|/home/'; then
  echo "‼ identity string found in wasm — aborting"; exit 1
fi
echo "✓ clean. pkg/ bytes:"; ls -la "$PKG"
