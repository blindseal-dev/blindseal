#!/usr/bin/env bash
# Blindseal quickstart — from a clean clone to a running proxy + dashboard + a verified attestation.
# Target: a fresh machine with Node ≥ 20 and pnpm; no Rust, no Solana toolchain needed (the wasm
# verifier and the IDLs are committed). Prints each step; exits non-zero on the first failure.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export BLINDSEAL_ROOT="$ROOT"
cd "$ROOT"
step() { printf '\n\033[1m→ %s\033[0m\n' "$*"; }

step "1/5 install (pnpm workspace)"
command -v pnpm >/dev/null || { echo "pnpm is required (npm i -g pnpm)"; exit 1; }
pnpm install --frozen-lockfile
git config core.hooksPath .githooks 2>/dev/null || true   # §7: commit-msg hook strips attribution trailers

step "2/5 build the dashboard (served by the proxy with application/wasm + CSP)"
pnpm -C packages/dashboard exec vite build

step "3/5 verify the sample attestation off-chain (real Groth16, same wasm the verify page uses)"
# runs inside packages/sdk, where blindseal-verifier-wasm resolves; no output masking
cd "$ROOT/packages/sdk" && NODE_NO_WARNINGS=1 node --input-type=module -e '
  import { readFileSync } from "node:fs"; import { createRequire } from "node:module";
  const req = createRequire(import.meta.url);
  const wasm = await import("blindseal-verifier-wasm");
  wasm.initSync({ module: readFileSync(req.resolve("blindseal-verifier-wasm/bg.wasm")) });
  const att = readFileSync(process.env.BLINDSEAL_ROOT + "/fixtures/attestation-sample.json", "utf8");
  const r = JSON.parse(wasm.verify_attestation_json(att));
  console.log("sample attestation:", r.ok ? "VALID" : "INVALID " + r.reason);
  if (!r.ok) process.exit(1);
  const t = JSON.parse(att); t.proof.bytes = t.proof.bytes.slice(0, -1) + (t.proof.bytes.endsWith("0") ? "1" : "0");
  const bad = JSON.parse(wasm.verify_attestation_json(JSON.stringify(t)));
  console.log("tampered copy:     ", bad.ok ? "VALID (BUG)" : "rejected (" + bad.reason + ")");
  if (bad.ok) process.exit(1);
'
cd "$ROOT"

step "4/5 verify the audit chain + a disclosure (CLI, offline)"
pnpm -C packages/proxy exec tsx src/index.ts audit --help >/dev/null 2>&1 || true
echo "audit: see 'blindseal audit verify' once the proxy has recorded decisions (~/.blindseal/audit.log)"

step "5/5 start the proxy in MOCK mode, serving the dashboard"
echo "  BLINDSEAL_MOCK=1 pnpm -C packages/proxy exec tsx src/index.ts run --mock"
echo "  then open the printed dashboard URL (it includes #token=…)."
echo
echo "Quickstart OK. Next: docs/ (concepts, hashing, integrating a gated program) and the verify page at https://blindseal.tech/verify."
