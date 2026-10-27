# shellcheck shell=bash
# Shared reader for the identity pattern file. Sourced by scripts/identity-sweep.sh,
# scripts/npm-pack-audit.sh, scripts/history-rewrite.sh and packages/verifier-wasm/build.sh.
#
# The pattern file is never committed: `.identity-sweep` at the repo root (gitignored), or the path in
# $IDENTITY_SWEEP_FILE (CI writes it there from the IDENTITY_SWEEP_PATTERNS secret). Format:
#
#   # comment                  lines starting with '#' are comments (except section headers)
#   #[section]                 starts a section; the header is a comment to older readers
#   <ERE pattern>              one grep -E pattern per line, matched case-insensitively
#                              (keep each line free of `|`: older copies of these scripts split on it)
#
# Sections:
#   personal      personal names / handles. Hard fail anywhere: tracked and untracked files, shipped
#                 binaries, commit metadata. history-rewrite.sh replaces these in every blob and message.
#   base          names of the project this one grew out of and its products. Fail anywhere except
#                 paths matched by base-allow, and except lines matched by base-generic.
#   base-generic  per-line exemptions for base hits (third-party products that carry the same word).
#   base-allow    anchored path regexes (relative to the repo root) where base names are allowed.
#   competitor    competitor and other project names. Fail anywhere in the tracked tree and in npm tarballs.
#
# Lines before the first section header belong to `personal`, so a plain one-pattern-per-line file
# keeps working.

identity_file() {
  local root="$1"
  if [ -n "${IDENTITY_SWEEP_FILE:-}" ]; then printf '%s\n' "$IDENTITY_SWEEP_FILE"; else printf '%s\n' "$root/.identity-sweep"; fi
}

# identity_patterns_lines <file> <section> — the section's patterns, one per line.
identity_patterns_lines() {
  local file="$1" want="$2"
  [ -f "$file" ] || return 0
  awk -v want="$want" '
    /^#\[[a-z-]+\][[:space:]]*$/ { sec = $0; sub(/^#\[/, "", sec); sub(/\].*$/, "", sec); next }
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    { s = (sec == "" ? "personal" : sec); if (s == want) { sub(/[[:space:]]+$/, ""); print } }
  ' "$file"
}

# identity_patterns <file> <section> — the section's patterns joined with '|' into one ERE (empty if none).
# For grep -E only; never split the result on '|' (a pattern may itself contain an alternation).
identity_patterns() {
  identity_patterns_lines "$1" "$2" | paste -sd'|' -
}
