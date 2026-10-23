#!/usr/bin/env bash
# Pre-public history rewrite (BLINDSEAL.md §7). LOCAL ONLY — never pushes.
#   1. backup: refs/backup/pre-rewrite + a git bundle under ~/.blindseal/backup/
#   2. git filter-repo over refs/heads/main: every commit's author AND committer = the project
#      identity; Co-Authored-By / session-URL trailers stripped; the substitutions in the local,
#      uncommitted `.history-subs` (old<TAB>new per line: the base project's names → Blindseal) are
#      applied to every text blob AND every commit message; the local `.identity-sweep` patterns are
#      replaced in blobs/messages too. Neither list is ever committed — this script carries no names.
#   3. sweep the WHOLE history (git log -p --all: every diff, message and identity) — exit 1 on a hit.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
export PATH="/opt/homebrew/bin:$PATH"
NAME="blindseal"; EMAIL="blindseal@users.noreply.github.com"
[ -f .identity-sweep ] || { echo ".identity-sweep missing (local PART A list)"; exit 1; }
[ -f .history-subs ] || { echo ".history-subs missing (local old<TAB>new substitutions)"; exit 1; }
A_RE="$(grep -v '^#' .identity-sweep | grep . | tr '\n' '|' | sed 's/|$//')"
B_RE="$(grep -v '^#' .history-subs | grep . | cut -f1 | tr '\n' '|' | sed 's/|$//')"
[ -z "$(git remote)" ] || { echo "remotes exist: $(git remote | tr '\n' ' ') — remove them first (this never pushes)"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean"; exit 1; }

echo "→ backup"
mkdir -p "$HOME/.blindseal/backup"
git update-ref refs/backup/pre-rewrite HEAD
git bundle create "$HOME/.blindseal/backup/blindseal-pre-rewrite-$(date -u +%Y%m%dT%H%M%SZ).bundle" --all >/dev/null
echo "   refs/backup/pre-rewrite = $(git rev-parse --short refs/backup/pre-rewrite); bundle in ~/.blindseal/backup/"

echo "→ rewrite (identity, trailers, substitutions in blobs + messages)"
# a python module with the substitutions (built from the local lists; deleted after the run)
python3 - "$A_RE" <<'PY' > /tmp/bs_subs.py
import sys, re
pats = [p for p in sys.argv[1].split("|") if p]
pairs = []
for line in open(".history-subs", encoding="utf-8"):
    line = line.rstrip("\n")
    if not line or line.startswith("#") or "\t" not in line: continue
    a, b = line.split("\t", 1); pairs.append((a.encode(), b.encode()))
print("import re")
print("PAIRS = " + repr(pairs))
print("A_PATS = " + repr([re.escape(p).encode() for p in pats]))
print("def scrub(d):")
print("    for a, b in PAIRS: d = d.replace(a, b)")
print("    for p in A_PATS: d = re.sub(b'(?i)' + p, b'blindseal', d)")
print("    return d")
PY
COMMIT_CB="$(cat <<PY
import re, sys
sys.path.insert(0, "/tmp"); import bs_subs
commit.author_name = b"$NAME"; commit.author_email = b"$EMAIL"
commit.committer_name = b"$NAME"; commit.committer_email = b"$EMAIL"
lines = commit.message.split(b"\n")
keep = [l for l in lines if not re.match(rb"^(Co-Authored-By|Co-authored-by|Signed-off-by|Session|Session-URL|Claude-Session):", l)
        and not re.search(rb"https?://claude\.ai/", l)]
commit.message = bs_subs.scrub(b"\n".join(keep).rstrip(b"\n") + b"\n")
PY
)"
BLOB_CB="$(cat <<'PY'
import sys
sys.path.insert(0, "/tmp"); import bs_subs
if b"\x00" not in blob.data[:8000]:
    blob.data = bs_subs.scrub(blob.data)
PY
)"
git filter-repo --force --refs refs/heads/main --commit-callback "$COMMIT_CB" --blob-callback "$BLOB_CB"
rm -f /tmp/bs_subs.py

echo "→ history sweep"
fail=0
ids=$(git log --all --format='%an <%ae>%n%cn <%ce>' | grep -v '^$' | sort -u)
echo "   identities: $(echo "$ids" | tr '\n' ';')"
[ "$ids" = "$NAME <$EMAIL>" ] || { echo "   ✗ an identity other than the project's remains"; fail=1; }
git log --all --format='%B' | grep -qE "^Co-Authored-By:|claude\.ai/" && { echo "   ✗ trailers remain"; fail=1; }
hits=$(git log -p --all --format='commit %H%n%an %ae %cn %ce%n%B' | grep -ciE "$A_RE" || true)
echo "   PART A hits across every diff + message + identity: $hits"
[ "$hits" = "0" ] || fail=1
bhits=$(git log -p --all --format='%B' -- . ':!LICENSE' ':!BLINDSEAL.md' ':!DECISIONS.md' ':!README.md' ':!FRONTEND.md' ':!RH-INTEGRATION.md' ':!docs/*.md' | grep -ciE "$B_RE" || true)
echo "   PART B occurrences across every diff + message outside the allowed docs: $bhits"
[ "$bhits" = "0" ] || fail=1
[ $fail -eq 0 ] && echo "history sweep: clean" || { echo "history sweep: FAILED"; exit 1; }
echo "done — review: git log --oneline | head; backup at refs/backup/pre-rewrite (delete after the owner's review)"
