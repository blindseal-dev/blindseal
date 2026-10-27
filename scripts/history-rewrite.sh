#!/usr/bin/env bash
# Pre-public history rewrite. LOCAL ONLY — never pushes.
#   1. backup: refs/backup/pre-rewrite + a git bundle under ~/.blindseal/backup/
#   2. git filter-repo over refs/heads/main:
#        - every commit's author AND committer = the project identity
#        - Co-Authored-By / session-URL trailers stripped from messages
#        - messages: the local `.history-msg-subs` pairs (old<TAB>new) applied
#        - blobs: the local `.history-subs` pairs applied to every TEXT blob EXCEPT blobs that belong
#          (in any revision) to the paths where the base project's name was allowed — LICENSE, the
#          named docs and docs/ (ALLOWED_PATHS below); the `personal` patterns of the local identity
#          pattern file (.identity-sweep or $IDENTITY_SWEEP_FILE; format in scripts/lib/identity-patterns.sh)
#          are replaced in every blob and message
#      Neither list is ever committed — this script carries no names.
#      paths: the local `.history-path-renames` pairs (old<TAB>new) rename files in every revision, so old
#      names never appear in diff headers; `.history-drop-paths` removes directories that were never Blindseal's
#   3. sweep refs/heads/main only (not the backup ref): every diff, message and identity.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
export PATH="/opt/homebrew/bin:$PATH"
NAME="blindseal"; EMAIL="347208916+blindseal-dev@users.noreply.github.com"
ALLOWED_PATHS=(LICENSE BLINDSEAL.md DECISIONS.md README.md FRONTEND.md docs)
. "$ROOT/scripts/lib/identity-patterns.sh"
PF="$(identity_file "$ROOT")"
for f in "$PF" .history-subs .history-msg-subs; do [ -f "$f" ] || { echo "$f missing (local list)"; exit 1; }; done
A_RE="$(identity_patterns "$PF" personal)"
[ -n "$A_RE" ] || { echo "no personal patterns in $PF"; exit 1; }
B_RE="$(grep -v '^#' .history-subs | grep . | cut -f1 | tr '\n' '|' | sed 's/|$//')"
[ -z "$(git remote)" ] || { echo "remotes exist: $(git remote | tr '\n' ' ') — remove them first (this never pushes)"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean"; exit 1; }

echo "→ backup"
mkdir -p "$HOME/.blindseal/backup"
git update-ref refs/backup/pre-rewrite HEAD
git bundle create "$HOME/.blindseal/backup/blindseal-pre-rewrite-$(date -u +%Y%m%dT%H%M%SZ).bundle" --all >/dev/null
echo "   refs/backup/pre-rewrite = $(git rev-parse --short refs/backup/pre-rewrite); bundle in ~/.blindseal/backup/"

echo "→ blobs on allowed paths (every revision of main)"
git rev-list refs/heads/main | while read -r c; do git ls-tree -r "$c" -- "${ALLOWED_PATHS[@]}" 2>/dev/null; done | awk '{print $3}' | sort -u > /tmp/bs_allowed_blobs.txt
echo "   $(wc -l < /tmp/bs_allowed_blobs.txt | tr -d ' ') blob ids exempt from the PART B substitutions"

echo "→ rewrite"
python3 - "$A_RE" <<'PY' > /tmp/bs_subs.py
import sys, re
pats = [p for p in sys.argv[1].split("|") if p]
def pairs(path):
    out = []
    for line in open(path, encoding="utf-8"):
        line = line.rstrip("\n")
        if not line or line.startswith("#") or "\t" not in line: continue
        a, b = line.split("\t", 1); out.append((a.encode(), b.encode()))
    return out
print("import re")
print("B_PAIRS = " + repr(pairs(".history-subs")))
print("M_PAIRS = " + repr(pairs(".history-msg-subs")))
print("A_PATS = " + repr([re.escape(p).encode() for p in pats]))
print("ALLOWED = set(l.strip().encode() for l in open('/tmp/bs_allowed_blobs.txt') if l.strip())")
print("def scrub_a(d):")
print("    for p in A_PATS: d = re.sub(b'(?i)' + p, b'blindseal', d)")
print("    return d")
print("def scrub_blob(d, oid):")
print("    if oid not in ALLOWED:")
print("        for a, b in B_PAIRS: d = d.replace(a, b)")
print("    return scrub_a(d)")
print("def scrub_msg(d):")
print("    for a, b in M_PAIRS: d = d.replace(a, b)")
print("    return scrub_a(d)")
PY
COMMIT_CB="$(cat <<PY
import re, sys
sys.path.insert(0, "/tmp"); import bs_subs
commit.author_name = b"$NAME"; commit.author_email = b"$EMAIL"
commit.committer_name = b"$NAME"; commit.committer_email = b"$EMAIL"
lines = commit.message.split(b"\n")
keep = [l for l in lines if not re.match(rb"^(Co-Authored-By|Co-authored-by|Signed-off-by|Session|Session-URL|Claude-Session):", l)
        and not re.search(rb"https?://claude\.ai/", l)]
commit.message = bs_subs.scrub_msg(b"\n".join(keep).rstrip(b"\n") + b"\n")
PY
)"
BLOB_CB="$(cat <<'PY'
import sys
sys.path.insert(0, "/tmp"); import bs_subs
if b"\x00" not in blob.data[:8000]:
    blob.data = bs_subs.scrub_blob(blob.data, blob.original_id)
PY
)"
# base-product directories that were never part of Blindseal (local `.history-drop-paths`, one per
# line): removed from every revision — their path names would otherwise survive in diff headers.
DROP=()
if [ -f .history-drop-paths ]; then
  while IFS= read -r p; do [ -n "$p" ] && [ "${p#\#}" = "$p" ] && DROP+=(--path "$p"); done < .history-drop-paths
fi
if [ ${#DROP[@]} -gt 0 ]; then
  for p in $(grep -v '^#' .history-drop-paths | grep .); do [ -e "$p" ] && { echo "refusing: $p exists in the current tree"; exit 1; }; done
  echo "   dropping from every revision: $(grep -v '^#' .history-drop-paths | grep . | tr '\n' ' ')"
  rm -rf .git/filter-repo   # stale state from a previous pass makes filter-repo's metadata step assert
  git filter-repo --force --refs refs/heads/main "${DROP[@]}" --invert-paths
fi
RENAME=()
if [ -f .history-path-renames ]; then
  while IFS=$'\t' read -r a b; do [ -n "$a" ] && [ "${a#\#}" = "$a" ] && [ -n "$b" ] && RENAME+=(--path-rename "$a:$b"); done < .history-path-renames
fi
if [ ${#RENAME[@]} -gt 0 ]; then
  echo "   renaming in every revision: $(grep -v '^#' .history-path-renames | grep . | cut -f1 | tr '\n' ' ')"
  rm -rf .git/filter-repo
  git filter-repo --force --refs refs/heads/main "${RENAME[@]}"
fi
rm -rf .git/filter-repo
git filter-repo --force --refs refs/heads/main --commit-callback "$COMMIT_CB" --blob-callback "$BLOB_CB"
rm -f /tmp/bs_subs.py /tmp/bs_allowed_blobs.txt

echo "→ history sweep (refs/heads/main only)"
fail=0
ids=$(git log refs/heads/main --format='%an <%ae>%n%cn <%ce>' | grep -v '^$' | sort -u)
echo "   identities: $(echo "$ids" | tr '\n' ';')"
[ "$ids" = "$NAME <$EMAIL>" ] || { echo "   ✗ an identity other than the project's remains"; fail=1; }
tr=$(git log refs/heads/main --format='%B' | grep -cE "^Co-Authored-By:|claude\.ai/" || true)
echo "   trailers remaining: $tr"; [ "$tr" = "0" ] || fail=1
ahits=$(git log -p refs/heads/main --format='commit %H%n%an %ae %cn %ce%n%B' | grep -ciE "$A_RE" || true)
echo "   PART A hits across every diff + message + identity: $ahits"; [ "$ahits" = "0" ] || fail=1
bhits=$(git log -p refs/heads/main --format='%B' -- . ':!LICENSE' ':!BLINDSEAL.md' ':!DECISIONS.md' ':!README.md' ':!FRONTEND.md' ':!docs' | grep -ciE "$B_RE" || true)
echo "   PART B occurrences across every diff + message outside the allowed paths: $bhits"; [ "$bhits" = "0" ] || fail=1
[ $fail -eq 0 ] && echo "history sweep: clean" || { echo "history sweep: FAILED"; exit 1; }
echo "done — review: git log --oneline | head; backup at refs/backup/pre-rewrite (delete after the owner's review)"
