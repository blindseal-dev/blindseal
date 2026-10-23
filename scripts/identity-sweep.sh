#!/usr/bin/env bash
# BLINDSEAL.md §7 identity sweep over the whole tracked tree (+ untracked, minus ignored).
# PART A: hard-fail anywhere. PART B: the base project's names, allowed only in LICENSE and the
# named docs. The grep list itself lives in .identity-sweep (gitignored) if present; falls back to
# the built-in patterns below. Exit 1 on any hit.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
A_RE='blindseal|blindseal|blindseal|\bintervention\b'
B_RE='blindseal|partner-chain|transfer-gate|@blindseal'
B_ALLOW='^(LICENSE|BLINDSEAL\.md|DECISIONS\.md|README\.md|FRONTEND\.md|RH-INTEGRATION\.md|docs/.*\.md)$'
[ -f .identity-sweep ] && A_RE="$(tr '\n' '|' < .identity-sweep | sed 's/|$//')"
FILES=$(git ls-files --cached --others --exclude-standard | grep -vE '\.(png|jpg|woff2?|wasm|bin|so|cast)$')
fail=0
hitsA=$(echo "$FILES" | xargs grep -IlniE "$A_RE" 2>/dev/null | grep -vE '^scripts/identity-sweep\.sh$|build\.sh$')
if [ -n "$hitsA" ]; then echo "PART A hits:"; echo "$hitsA" | sed 's/^/  /'; fail=1; fi
hitsB=$(echo "$FILES" | xargs grep -IlniE "$B_RE" 2>/dev/null | grep -vE "$B_ALLOW" | grep -vE '^scripts/identity-sweep\.sh$')
if [ -n "$hitsB" ]; then echo "PART B hits outside allowed docs:"; echo "$hitsB" | sed 's/^/  /'; fail=1; fi
# binaries we ship: no identity strings inside
for b in packages/verifier-wasm/pkg/blindseal_verifier_bg.wasm target/deploy/blindseal_verify.so target/deploy/transfer_gate.so; do
  [ -f "$b" ] && strings "$b" | grep -qiE 'blindseal|blindseal|/Users/|/home/' && { echo "identity string inside $b"; fail=1; }
done
# commit metadata
git log --format='%an %ae %cn %ce %s %b' | grep -iE 'blindseal|blindseal|blindseal' >/dev/null && { echo "PART A in commit metadata"; fail=1; }
[ $fail -eq 0 ] && echo "identity sweep: clean" ; exit $fail
