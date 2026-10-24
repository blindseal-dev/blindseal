#!/usr/bin/env bash
# Pre-publish audit (BLINDSEAL.md §7): packs each publishable package the way `npm publish` would, extracts
# the tarball and scans EVERY file in it for personal names (the local .identity-sweep list — never
# committed), the base/other project names, e-mail addresses other than the project's, secrets (npm/GitHub/
# AWS tokens, private keys, Solana keypair arrays), absolute home paths, and the package.json identity
# fields. Exit 1 on any hit. Usage: scripts/npm-pack-audit.sh [package dirs…]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
PKGS=("$@"); [ ${#PKGS[@]} -gt 0 ] || PKGS=(packages/proxy packages/sdk packages/verifier-wasm)
A_RE="$( [ -f .identity-sweep ] && grep -v '^#' .identity-sweep | grep . | tr '\n' '|' | sed 's/|$//' || echo '__none__')"
B_RE='blindseal|partner-chain|transfer-gate|@blindseal|\bblindseal\b|BLINDSEAL_|\bveil\b'
SECRET_RE='npm_[A-Za-z0-9]{30,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|BEGIN (RSA|OPENSSH|EC|PGP) PRIVATE KEY|"privateKey"|_authToken'
PATH_RE='/Users/[a-z]+|/home/[a-z]+|C:\\Users'
TMP="$(mktemp -d)"; fail=0
for p in "${PKGS[@]}"; do
  name="$(node -p "require('./$p/package.json').name")"; ver="$(node -p "require('./$p/package.json').version")"
  echo "→ $name@$ver ($p)"
  if node -e "process.exit(require('./$p/package.json').scripts?.build ? 0 : 1)"; then (cd "$p" && pnpm build >/dev/null 2>&1) || { echo "   ✗ build failed"; fail=1; continue; }; fi
  tgz="$(cd "$p" && npm pack --ignore-scripts --json --pack-destination "$TMP" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].filename))")"
  d="$TMP/$name"; mkdir -p "$d"; tar -xzf "$TMP/$tgz" -C "$d"
  n="$(find "$d/package" -type f | wc -l | tr -d ' ')"; echo "   files in tarball: $n"
  for f in author contributors maintainers homepage bugs repository funding; do v="$(node -p "JSON.stringify(require('$d/package/package.json').$f ?? null)")"; [ "$v" = "null" ] || echo "   package.json.$f = $v"; done
  hits() { local label="$1" re="$2"; local out; out="$(grep -rnIiE "$re" "$d/package" 2>/dev/null | grep -vE 'node_modules' | head -8 || true)"; if [ -n "$out" ]; then echo "   ✗ $label:"; echo "$out" | sed "s|$d/package/|      |" | cut -c1-160; fail=1; else echo "   ✓ no $label"; fi; }
  hits "personal names (PART A)" "$A_RE"
  hits "base / other project names" "$B_RE"
  hits "secrets / tokens / keys" "$SECRET_RE"
  hits "absolute home paths" "$PATH_RE"
  em="$(grep -rnoIE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' "$d/package" 2>/dev/null | grep -viE 'blindseal@proton\.me|users\.noreply\.github\.com|example\.com|@modelcontextprotocol|@blindseal/|@solana/|@types/|@noble/|@anthropic|@openai|@babel|@eslint|@vitest|npm:' | head -6 || true)"
  if [ -n "$em" ]; then echo "   ✗ other e-mail addresses:"; echo "$em" | sed "s|$d/package/|      |" | cut -c1-160; fail=1; else echo "   ✓ no foreign e-mail addresses"; fi
  kp="$(grep -rlE '^\[([0-9]{1,3},){63}[0-9]{1,3}\]' "$d/package" 2>/dev/null | head -3 || true)"; if [ -n "$kp" ]; then echo "   ✗ keypair-shaped JSON: $kp"; fail=1; else echo "   ✓ no keypair files"; fi
done
rm -rf "$TMP"
[ $fail -eq 0 ] && echo "npm pack audit: clean" || { echo "npm pack audit: FAILED"; exit 1; }
