#!/usr/bin/env bash
# Identity sweep over the whole tracked tree (+ untracked, minus ignored), shipped binaries and commit
# metadata. Every pattern lives in the uncommitted pattern file — `.identity-sweep` at the repo root, or
# $IDENTITY_SWEEP_FILE — so this script carries no names. File format and sections: scripts/lib/identity-patterns.sh.
#   personal    → fail anywhere (files, binaries, commit metadata)
#   base        → fail outside base-allow paths, ignoring lines matched by base-generic
#   competitor  → fail anywhere in the tracked tree
# Exit 1 on any hit, or if the pattern file is missing or has no personal patterns.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
. "$ROOT/scripts/lib/identity-patterns.sh"
PF="$(identity_file "$ROOT")"
[ -f "$PF" ] || { echo "identity pattern file missing ($PF; set IDENTITY_SWEEP_FILE or create .identity-sweep) — cannot sweep"; exit 1; }
A_RE="$(identity_patterns "$PF" personal)"
B_RE="$(identity_patterns "$PF" base)"
B_GENERIC="$(identity_patterns "$PF" base-generic)"
B_ALLOW="$(identity_patterns "$PF" base-allow)"
COMP_RE="$(identity_patterns "$PF" competitor)"
[ -n "$A_RE" ] || { echo "identity pattern file has no personal patterns"; exit 1; }
echo "patterns: personal $(echo "$A_RE" | tr '|' '\n' | grep -c .), base $(echo "$B_RE" | tr '|' '\n' | grep -c .), competitor $(echo "$COMP_RE" | tr '|' '\n' | grep -c .)"
NEVER='__identity_sweep_no_match__'
FILES=$(git ls-files --cached --others --exclude-standard | grep -vE '\.(png|jpg|woff2?|wasm|bin|so|cast)$' | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done)
# the pattern file itself, when it sits inside the tree (CI writes it outside), is never swept
FILES=$(printf '%s\n' "$FILES" | grep -vxF '.identity-sweep')
fail=0
if [ -n "$COMP_RE" ]; then
  ch=$(git grep -ilE "$COMP_RE" 2>/dev/null || true)
  [ -n "$ch" ] && { echo "competitor names in tracked files:"; echo "$ch" | sed 's/^/  /'; fail=1; }
fi
hitsA=$(printf '%s\n' "$FILES" | tr '\n' '\0' | xargs -0 grep -IliE "$A_RE" 2>/dev/null)
if [ -n "$hitsA" ]; then echo "personal-name hits:"; echo "$hitsA" | sed 's/^/  /'; fail=1; fi
if [ -n "$B_RE" ]; then
  hitsB=$(printf '%s\n' "$FILES" | tr '\n' '\0' | xargs -0 grep -IiE "$B_RE" /dev/null 2>/dev/null | grep -viE "${B_GENERIC:-$NEVER}" | cut -d: -f1 | sort -u | grep -vE "^(${B_ALLOW:-$NEVER})$")
  if [ -n "$hitsB" ]; then echo "base-project names outside allowed paths:"; echo "$hitsB" | sed 's/^/  /'; fail=1; fi
fi
# shipped binaries: no identity strings or home paths inside
for b in packages/verifier-wasm/pkg/blindseal_verifier_bg.wasm target/deploy/blindseal_verify.so target/deploy/transfer_gate.so; do
  [ -f "$b" ] && strings "$b" | grep -qiE "$A_RE|/Users/|/home/" && { echo "identity string inside $b"; fail=1; }
done
# commit metadata (authors, committers, messages)
git log --format='%an %ae %cn %ce %s %b' | grep -qiE "$A_RE" && { echo "personal name in commit metadata"; fail=1; }
[ $fail -eq 0 ] && echo "identity sweep: clean"
exit $fail
