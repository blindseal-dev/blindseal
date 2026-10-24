#!/usr/bin/env bash
# BLINDSEAL.md §7 identity sweep over the whole tracked tree (+ untracked, minus ignored).
# PART A: the personal-identity grep list, which lives ONLY in the local, gitignored
# `.identity-sweep` (one pattern per line; `#` comments) — hard-fail anywhere, incl. shipped
# binaries and commit metadata. PART B: the base project's names, allowed only in LICENSE and
# the named docs. Exit 1 on any hit.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
[ -f .identity-sweep ] || { echo ".identity-sweep (the PART A grep list, kept local) is missing — cannot sweep"; exit 1; }
A_RE="$(grep -v '^#' .identity-sweep | grep . | tr '\n' '|' | sed 's/|$//')"
[ -n "$A_RE" ] || { echo ".identity-sweep is empty"; exit 1; }
B_RE='blindseal|partner-chain|transfer-gate|@blindseal|\bblindseal\b|BLINDSEAL_'
# Third-party products that legitimately carry the word (HashiCorp Blindseal, ansible-blindseal) inside eval
# fixtures — exempt per line, not per file, so product residue elsewhere in the same file still fails.
B_GENERIC='hashicorp blindseal|blindseal \(hashicorp\)|ansible-blindseal|x-blindseal-token|blindseal-pki\.|\bblindseal (token|write|read|kv|login|pki)\b'
B_ALLOW='^(LICENSE|BLINDSEAL\.md|DECISIONS\.md|README\.md|FRONTEND\.md|RH-INTEGRATION\.md|docs/.*\.md)$'
FILES=$(git ls-files --cached --others --exclude-standard | grep -vE '\.(png|jpg|woff2?|wasm|bin|so|cast)$')
fail=0
hitsA=$(echo "$FILES" | xargs grep -IlniE "$A_RE" 2>/dev/null)
if [ -n "$hitsA" ]; then echo "PART A hits:"; echo "$hitsA" | sed 's/^/  /'; fail=1; fi
hitsB=$(echo "$FILES" | xargs grep -IniE "$B_RE" 2>/dev/null | grep -viE "$B_GENERIC" | cut -d: -f1 | sort -u | grep -vE "$B_ALLOW" | grep -vE '^scripts/(identity-sweep|npm-pack-audit)\.sh$')
if [ -n "$hitsB" ]; then echo "PART B hits outside allowed docs:"; echo "$hitsB" | sed 's/^/  /'; fail=1; fi
# shipped binaries: no identity strings or home paths inside
for b in packages/verifier-wasm/pkg/blindseal_verifier_bg.wasm target/deploy/blindseal_verify.so target/deploy/transfer_gate.so; do
  [ -f "$b" ] && strings "$b" | grep -qiE "$A_RE|/Users/|/home/" && { echo "identity string inside $b"; fail=1; }
done
# commit metadata (authors, committers, messages)
git log --format='%an %ae %cn %ce %s %b' | grep -qiE "$A_RE" && { echo "PART A in commit metadata"; fail=1; }
[ $fail -eq 0 ] && echo "identity sweep: clean"
exit $fail
