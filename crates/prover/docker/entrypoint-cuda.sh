#!/usr/bin/env bash
# Entrypoint of Dockerfile.cuda: start the Moongate GPU prover server in this container, wait until it
# answers, then run the prover against it with every argument passed through. The server dies with the
# prover (trap), so a finished or failed proof never leaves a GPU process behind.
#   entrypoint-cuda.sh --payload ... --out ... (blindseal-prover flags)
#   MOONGATE_PORT (default 3000), BLINDSEAL_MOONGATE_URL (default http://127.0.0.1:$MOONGATE_PORT)
set -euo pipefail
PORT="${MOONGATE_PORT:-3000}"
export BLINDSEAL_MOONGATE_URL="${BLINDSEAL_MOONGATE_URL:-http://127.0.0.1:$PORT}"
export BLINDSEAL_PROVER_MODE="${BLINDSEAL_PROVER_MODE:-cuda}"

if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi -L >/dev/null 2>&1; then
  echo "entrypoint-cuda: no NVIDIA GPU visible (nvidia-smi failed); run with --gpus all and the NVIDIA container toolkit" >&2
  exit 4
fi

RUST_LOG="${MOONGATE_LOG:-info}" moongate-server &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true; wait "$SERVER" 2>/dev/null || true' EXIT

# moongate answers twirp POSTs only; any HTTP response at all means the port is open
for _ in $(seq 1 120); do
  if curl -s -o /dev/null -m 2 "$BLINDSEAL_MOONGATE_URL/" 2>/dev/null; then break; fi
  if ! kill -0 "$SERVER" 2>/dev/null; then echo "entrypoint-cuda: moongate-server exited before it was ready" >&2; exit 5; fi
  sleep 1
done

exec_mode="${BLINDSEAL_EXECUTE:-}"
if [ -n "$exec_mode" ]; then echo "entrypoint-cuda: BLINDSEAL_EXECUTE set: executor only, the GPU is idle" >&2; fi
blindseal-prover --mode cuda "$@"
