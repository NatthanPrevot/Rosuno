#!/usr/bin/env bash
# rosuno-guard (cloud fork edition rev 2, derived from UOM v1.8 rev 5 draft): merge-boundary check posted as the required
# status "rosuno-guard". Reads git objects only; executes nothing from the PR.
# Usage: rosuno-guard.sh <base-sha> <head-ref> <head-branch> <approved-ref>
#   <approved-ref> = tip of the OWNER repository's branch with the same name as the PR head branch. Only the owner can
#   push there, so a matching Packet blob proves the Packet is the owner-approved one.
set -euo pipefail
fail(){ echo "::error::ROSUNO-GUARD: $*"; exit 1; }
lc(){ printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
BASE="${1:?base}"; HEAD="$(git rev-parse --verify "${2:?head}^{commit}")"; BRANCH="${3:?branch}"
APPROVED="$(git rev-parse --verify -q "${4:?approved-ref}^{commit}")" || fail "approved Packet branch not found on the owner repository"
[[ "$BRANCH" =~ ^wi/([A-Z][A-Z0-9]*-[0-9]{3})(-[a-z0-9-]+)?$ ]] || fail "branch '$BRANCH' is not wi/<ID>[-slug]"
ID="${BASH_REMATCH[1]}"; PK="docs/work-items/$ID/PACKET.md"
MB="$(git merge-base "$BASE" "$HEAD")"
[ "$(git ls-tree "$HEAD" -- "$PK" | cut -d' ' -f1-2)" = "100644 blob" ] || fail "Packet $PK missing at head or not a regular file"
git cat-file -e "$MB:$PK" 2>/dev/null && fail "Packet $PK already exists on base"
FIRST="$(git log --format=%H --diff-filter=A "$MB..$HEAD" -- "$PK" | tail -1)"
[ -n "$FIRST" ] || fail "Packet not added on this branch"
# The Packet commit must be the branch's first commit, a non-merge, and must add the Packet and nothing else.
OLDEST="$(git rev-list --reverse --topo-order "$MB..$HEAD" | sed -n 1p)"
[ "$OLDEST" = "$FIRST" ] || fail "Packet commit is not the first commit on the branch (earlier commit: $OLDEST)"
[ "$(git rev-list --parents -n 1 "$FIRST" | wc -w | tr -d ' ')" = 2 ] || fail "Packet commit must not be a merge"
git merge-base --is-ancestor "$FIRST^" "$BASE" || fail "Packet commit's parent is not on the base branch"
[ "$(git diff-tree --no-commit-id --name-status -r "$FIRST")" = "$(printf 'A\t%s' "$PK")" ] || fail "Packet commit must add only the Packet (it also changes other paths)"
[ -z "$(git diff --name-only "$FIRST" "$HEAD" -- "$PK")" ] || fail "Packet changed after it was added (re-audit required)"
# Approval binding: the Packet must be byte-identical to the Packet on the owner's same-named branch.
AB="$(git rev-parse -q --verify "$APPROVED:$PK" 2>/dev/null)" || fail "owner branch $BRANCH has no $PK (Packet not approved/published by the owner)"
[ "$AB" = "$(git rev-parse "$HEAD:$PK")" ] || fail "Packet differs from the owner-approved Packet on owner branch $BRANCH"
PKT="$(git show "$HEAD:$PK")"
# Packet identity (UOM v1.8 §16.1): exactly one WORK_ITEM, BRANCH and BASE_SHA line each, bound to the real branch and base.
cnt(){ grep -c "^$1:" <<<"$PKT" || true; }
val(){ sed -n "s/^$1:[[:space:]]*//p" <<<"$PKT" | sed 's/[[:space:]]*$//'; }
for k in WORK_ITEM BRANCH BASE_SHA; do [ "$(cnt "$k")" = 1 ] || fail "Packet must contain exactly one $k line"; done
[ "$(val WORK_ITEM)" = "$ID" ] || fail "Packet WORK_ITEM '$(val WORK_ITEM)' does not match branch work item '$ID'"
[ "$(val BRANCH)" = "$BRANCH" ] || fail "Packet BRANCH '$(val BRANCH)' does not match the PR head branch '$BRANCH'"
PBASE="$(val BASE_SHA)"
[[ "$PBASE" =~ ^[0-9a-f]{40}$ ]] || fail "Packet BASE_SHA must be a full 40-hex commit SHA"
[ "$PBASE" = "$(git rev-parse "$FIRST^")" ] || fail "Packet BASE_SHA $PBASE is not the parent of the Packet commit"
list(){ awk -v k="$1:" '$0==k{f=1;next} /^[A-Z_]+:/{f=0} f&&/^[[:space:]]*- /{sub(/^[[:space:]]*- /,"");print}' <<<"$PKT"; }
ALLOWED="$(list ALLOWED_SCOPE)"; FORBIDDEN="$(list FORBIDDEN_SCOPE)"
[ -n "$ALLOWED" ] || fail "ALLOWED_SCOPE is empty"
grep -q '^FORBIDDEN_SCOPE:[[:space:]]*$' <<<"$PKT" || fail "FORBIDDEN_SCOPE field missing (it may be an empty list)"
MIGS="$(sed -n 's/^MIGRATIONS:[[:space:]]*//p' <<<"$PKT" | head -1)"; [ -n "$MIGS" ] || fail "MIGRATIONS field missing"
TYPE="$(sed -n 's/^TYPE:[[:space:]]*//p' <<<"$PKT" | head -1)"; TYPE="${TYPE:-FEATURE}"
matches(){ local p="$1" g; while IFS= read -r g; do [ -n "$g" ] || continue; case "$p" in $g) return 0;; esac; done <<<"$2"; return 1; }
ERR=0; e(){ echo "::error::$*"; ERR=1; }
# Case-fold collisions introduced by this branch, at EVERY path prefix (directories as well as files):
# on a case-insensitive checkout `apps/WEB/...` and `apps/web/...` are the same directory.
caseclash(){ git ls-tree -r --name-only "$1" | awk -F/ '{p=""; for(i=1;i<=NF;i++){p=(i==1)?$i:p"/"$i; print p}}' \
  | LC_ALL=C sort -u | awk '{print tolower($0)"\t"$0}' | LC_ALL=C sort -u | cut -f1 | LC_ALL=C uniq -d; }
NEWDUP="$(LC_ALL=C comm -13 <(caseclash "$MB") <(caseclash "$HEAD"))"
[ -z "$NEWDUP" ] || e "case-insensitive path collision: $NEWDUP"
# Case-only replacement ACROSS base and head: a head path or directory spelled differently from a base path that is
# identical ignoring case (e.g. base apps/web/... removed, head apps/WEB/... added). Same-case paths and new names pass.
prefixes(){ git ls-tree -r --name-only "$1" | awk -F/ '{p=""; for(i=1;i<=NF;i++){p=(i==1)?$i:p"/"$i; print p}}' | LC_ALL=C sort -u; }
XALIAS="$(awk 'NR==FNR{b[$0]=1; lb[tolower($0)]=$0; next} !($0 in b) && (tolower($0) in lb){print lb[tolower($0)]" -> "$0}' \
  <(prefixes "$MB") <(prefixes "$HEAD") | sed -n 1,5p)"
[ -z "$XALIAS" ] || e "case-only change of an existing base path: $XALIAS"
# History rule (cloud rev 2): the owner merges with "Create a merge commit", so EVERY commit on the branch reaches main.
# The branch must be linear, and each commit after the Packet commit is checked on its own, as well as the final diff.
# A change that is later reverted (Packet, protected/kit file, existing migration, out-of-scope path, credential
# file, symlink) is therefore still a violation.
COMMITS="$(git rev-list --reverse --topo-order "$MB..$HEAD")"
for c in $COMMITS; do
  [ "$(git rev-list --parents -n 1 "$c" | wc -w | tr -d ' ')" = 2 ] || fail "merge commit $c on the branch (linear history required)"
done
MBMIGS="$(git ls-tree -r --name-only "$MB" -- supabase/migrations | tr '[:upper:]' '[:lower:]')"
# check_diff <from> <to> <label> <final:0|1>: per-path checks on one diff (raw, with modes, NUL-delimited).
check_diff(){
  local FROM="$1" TO="$2" W="$3" FINAL="$4" META P SM DM ST L m
  while IFS= read -r -d '' META && IFS= read -r -d '' P; do
    read -r SM DM _ _ ST <<<"${META#:}"
    for m in "$SM" "$DM"; do case "$m" in 000000|100644|100755) ;; *) e "[$W] $P has git mode $m (symlink/submodule/special objects are not allowed)";; esac; done
    L="$(lc "$P")"
    if [ "$L" = "$(lc "$PK")" ]; then
      if [ "$FINAL" = 1 ]; then [ "$P" = "$PK" ] && [ "$ST" = A ] || e "[$W] $P case-aliases or alters the Packet"
      else e "[$W] Packet path $P changed after the Packet commit (even if later reverted; re-audit required)"; fi
      continue
    fi
    # Every other changed path, of every kind and TYPE, is checked against BOTH scopes. FORBIDDEN wins on overlap.
    { matches "$P" "$FORBIDDEN" || matches "$L" "$(lc "$FORBIDDEN")"; } && e "[$W] $P ($ST) is inside FORBIDDEN_SCOPE (case-insensitive)"
    matches "$P" "$ALLOWED" || e "[$W] $P ($ST) is outside ALLOWED_SCOPE"
    case "$L" in
      .gitmodules) e "[$W] .gitmodules change (submodules not allowed)";;
      supabase/migrations/*)
        if [[ "$P" != supabase/migrations/* ]]; then e "[$W] $P: migrations path with non-canonical case"
        elif grep -Fxq -- "$L" <<<"$MBMIGS"; then e "[$W] existing migration $P changed or aliased (status $ST; forward-only)"
        elif [ "$MIGS" = none ]; then e "[$W] new migration $P but Packet says MIGRATIONS: none"; fi;;
      docs/work-items/*|rosuno-authority/*) e "[$W] $P is outside this work item's writable area";;
      supabase/config.toml|supabase/seed*|supabase/seeds/*) [ "$TYPE" = PROCESS ] || e "[$W] $P (database config/seed) requires a TYPE: PROCESS work item";;
      .github/*|.claude/*|claude.md|agents.md|docs/process/*) [ "$TYPE" = PROCESS ] || e "[$W] $P is process/kit scope; requires a TYPE: PROCESS work item";;
    esac
    # Public repository: credential-like files are never accepted (templates named *.env.example are allowed).
    case "$L" in *.env.example) ;; .env|.env.*|*/.env|*/.env.*|*.pem|*.key|*.p12|*.pfx|*id_rsa*|*id_ed25519*)
      e "[$W] $P looks like a secret/credential file (never commit to a public repository)";; esac
  done < <(git diff --raw -z --no-renames --no-abbrev "$FROM" "$TO")
}
for c in $COMMITS; do [ "$c" = "$FIRST" ] || check_diff "$c^" "$c" "commit ${c:0:12}" 0; done
check_diff "$MB" "$HEAD" "final diff" 1
[ "$ERR" = 0 ] || fail "violations above"
PSHA="$(git show "$HEAD:$PK" | { command -v shasum >/dev/null && shasum -a 256 || sha256sum; } | cut -d' ' -f1)"
echo "ROSUNO-GUARD PASS work_item=$ID packet_sha256=$PSHA base=$MB head=$HEAD approved=$APPROVED"
