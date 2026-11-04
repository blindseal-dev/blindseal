#!/usr/bin/env bash
# A stand-in for the prover binary (crates/prover) so the tests never run a real proof.
# Takes the prover's CLI, copies the fixture attestation named by $FAKE_PROVER_FIXTURE to --out, and
# prints the two lines the real prover prints. $FAKE_PROVER_ARGS_FILE (optional) receives the argv, one
# per line; $FAKE_PROVER_EXIT (optional) makes it exit with that code without writing anything.
set -euo pipefail
out=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[$i]}" = "--out" ]; then out="${args[$((i + 1))]}"; fi
done
if [ -n "${FAKE_PROVER_ARGS_FILE:-}" ]; then printf '%s\n' "$@" > "$FAKE_PROVER_ARGS_FILE"; fi
if [ -n "${FAKE_PROVER_EXIT:-}" ]; then echo "fake prover: failing on purpose" >&2; exit "$FAKE_PROVER_EXIT"; fi
[ -n "$out" ] || { echo "fake prover: no --out" >&2; exit 2; }
cp "$FAKE_PROVER_FIXTURE" "$out"
echo "VKEY 0x00cdf40c21b14717fd783bdecb539b762094b3b0da75a567f4b6cc088e9f2967"
echo "PROVE_MS 7"
