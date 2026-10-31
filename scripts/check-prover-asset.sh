#!/usr/bin/env bash
# Check the released prover binary that packages/proxy/src/prover/manifest.json pins — the one
# `blindseal attest` downloads — actually runs and is the committed guest:
#   1. download <release>/<asset>, <release>/SHA256SUMS and <release>/SHA256SUMS.<platform>; the asset's
#      sha256 must equal its SHA256SUMS line AND the manifest's pin
#   2. the committed guest ELF (crates/guest/elf/blindseal-guest) must have sha256
#      $EXPECTED_GUEST_ELF_SHA256 and appear byte for byte inside the binary (include_bytes!)
#   3. run the binary in execute-only mode (BLINDSEAL_EXECUTE=1: the SP1 executor, no proof) on the
#      mainnet sample's tool call and action (tests/fixtures/mainnet-toolcall-demo.json,
#      attestation-mainnet-demo-0.7.0.json); the public values it prints (payloadHash, policyRoot,
#      detectorVersion, actionHash, nullifier, expirySlot) and VKEY must equal the attestation's
# The release is treated as untrusted input: downloads land in their own directory, nothing is run
# from inside it, and the embed check runs python3 -I with paths as arguments.
#
#   scripts/check-prover-asset.sh [linux-x64|darwin-arm64] [workdir]     (default: host platform, mktemp)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
MANIFEST=packages/proxy/src/prover/manifest.json
# sha256 of crates/guest/elf/blindseal-guest. Changes only with a deliberate guest change, together with
# a new prover release and manifest pin.
EXPECTED_GUEST_ELF_SHA256=dd3c49340646af0a249851d6f14afccc21d52bf1cd40610308420ced241899db
FIX_ATT=tests/fixtures/attestation-mainnet-demo-0.7.0.json
FIX_CALL=tests/fixtures/mainnet-toolcall-demo.json

case "${1:-}" in
  linux-x64|darwin-arm64) PLATFORM=$1 ;;
  "") case "$(uname -s)-$(uname -m)" in Linux-x86_64) PLATFORM=linux-x64 ;; Darwin-arm64) PLATFORM=darwin-arm64 ;; *) echo "unsupported host $(uname -s)-$(uname -m); pass linux-x64 or darwin-arm64"; exit 2 ;; esac ;;
  *) echo "usage: $0 [linux-x64|darwin-arm64] [workdir]"; exit 2 ;;
esac
WORK="${2:-$(mktemp -d)}"; DL="$WORK/dl"; mkdir -p "$DL"
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
j() { node -e "const m=require(process.argv[1]); console.log(($2))" "$ROOT/$1"; }

RELEASE=$(j $MANIFEST 'm.release'); VERSION=$(j $MANIFEST 'm.version')
ASSET=$(j $MANIFEST "m.assets['$PLATFORM'].name"); PINNED=$(j $MANIFEST "m.assets['$PLATFORM'].sha256")
echo "manifest: prover $VERSION, $PLATFORM asset $ASSET"
echo "release:  $RELEASE"

# 1 · download + sha256 (SHA256SUMS line and manifest pin). The release carries SHA256SUMS (written with the
# darwin build) and SHA256SUMS.linux-x64 (written by the prover-linux workflow); the asset must be in one of them.
curl -sSfL --retry 3 -o "$DL/$ASSET" "$RELEASE/$ASSET"
curl -sSfL --retry 3 -o "$DL/SHA256SUMS" "$RELEASE/SHA256SUMS"
curl -sfL --retry 3 -o "$DL/SHA256SUMS.$PLATFORM" "$RELEASE/SHA256SUMS.$PLATFORM" || rm -f "$DL/SHA256SUMS.$PLATFORM"
GOT=$(sha256 "$DL/$ASSET")
SUMS=$(cat "$DL"/SHA256SUMS* | grep -E "[[:space:]]\*?$ASSET\$" | awk '{print $1}' | sort -u || true)
echo "sha256:   $GOT"
echo "listed:   $(ls "$DL" | grep SHA256SUMS | tr '\n' ' ')"
[ -n "$SUMS" ] || { echo "FAIL: $ASSET is not listed in SHA256SUMS or SHA256SUMS.$PLATFORM"; exit 1; }
[ "$(echo "$SUMS" | wc -l | tr -d ' ')" = 1 ] || { echo "FAIL: SHA256SUMS files disagree about $ASSET: $(echo $SUMS)"; exit 1; }
[ "$GOT" = "$SUMS" ] || { echo "FAIL: sha256 differs from SHA256SUMS ($SUMS)"; exit 1; }
[ "$GOT" = "$PINNED" ] || { echo "FAIL: sha256 differs from the manifest pin ($PINNED)"; exit 1; }
echo "ok: sha256 equals SHA256SUMS and the manifest pin"

# 2 · the committed guest ELF, verbatim inside the binary
ELF=crates/guest/elf/blindseal-guest
ELF_SHA=$(sha256 "$ELF")
echo "guest ELF: $ELF_SHA ($(wc -c < "$ELF" | tr -d ' ') bytes)"
[ "$ELF_SHA" = "$EXPECTED_GUEST_ELF_SHA256" ] || { echo "FAIL: committed guest ELF sha256 is not $EXPECTED_GUEST_ELF_SHA256"; exit 1; }
python3 -I - "$DL/$ASSET" "$ROOT/$ELF" <<'PY'
import sys
binary = open(sys.argv[1], 'rb').read(); elf = open(sys.argv[2], 'rb').read()
n = binary.count(elf)
if n != 1:
    print(f"FAIL: the guest ELF appears {n} times in the binary (expected exactly once)"); sys.exit(1)
print(f"ok: the guest ELF is embedded verbatim at offset {binary.find(elf)}")
PY

# 3 · execute-only run on the mainnet sample: the public values must reproduce
chmod +x "$DL/$ASSET"
PAYLOAD="$WORK/payload.json"
node -e "const c=require(process.argv[1]); process.stdout.write(JSON.stringify({ tool: c.toolName, args: c.args }))" "$ROOT/$FIX_CALL" > "$PAYLOAD"
att() { j $FIX_ATT "$1"; }
set +e
OUT=$(BLINDSEAL_EXECUTE=1 "$DL/$ASSET" --payload "$PAYLOAD" --out "$WORK/unused.json" \
  --chain-id "$(att m.chainId)" --target-program "$(att m.action.targetProgram)" --source-authority "$(att m.action.sourceAuthority)" \
  --recipient "$(att m.action.recipient)" --mint "$(att m.action.mint)" --amount "$(att m.action.amount)" --instruction "$(att m.action.instruction)" \
  --expiry "$(att m.expirySlot)" --nonce "$(att m.nonce)" 2>"$WORK/stderr.log"); RC=$?
set -e
echo "$OUT" | grep -E '^(VKEY|CYCLES|payloadHash|policyRoot|detectorVersion|actionHash|nullifier|expirySlot) ' | sed 's/^/  /'
[ $RC -eq 0 ] || { echo "FAIL: execute-only run exited $RC"; tail -20 "$WORK/stderr.log"; exit 1; }
fail=0
check() { local got; got=$(echo "$OUT" | awk -v k="$1" '$1==k{print $2}'); if [ "$got" != "$2" ]; then echo "FAIL: $1 is $got, the attestation has $2"; fail=1; fi; }
check payloadHash "$(att m.payloadHash)"; check policyRoot "$(att m.policyRoot)"; check detectorVersion "$(att m.detectorVersion)"
check actionHash "$(att m.actionHash)"; check nullifier "$(att m.nullifier)"; check expirySlot "$(att m.expirySlot)"; check VKEY "$(att m.detectorVersion)"
[ $fail -eq 0 ] || exit 1
echo "ok: the $PLATFORM prover $VERSION reproduces every public value of the mainnet sample"
