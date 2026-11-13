#!/usr/bin/env bash
# rosuno-guard v3 (P2-919): merge-boundary check posted as the required status "rosuno-guard".
# Reads Git objects only; executes nothing from the PR. The trusted runner supplies every input.
#
# Usage: rosuno-guard.sh <base> <head> <head-branch> <approved-ref>
#   <base>          current owner `main` tip, fetched directly by the trusted runner (never PR metadata)
#   <head>          PR head commit
#   <head-branch>   PR head branch, wi/<ID>[-slug]
#   <approved-ref>  tip of the OWNER repository's branch with the same name. Only the owner can push there,
#                   so a byte-identical Packet proves the Packet is the owner-adopted one (revisions are
#                   ordinary forward-only owner commits on that branch).
#
# Rules (UOM v1.7.10 §28 / C1 rev5.11 §C1.3):
#   R0  up to date: <base> is an ancestor of <head>, so the checked net diff is exactly what lands on main.
#   R1  branch is wi/<ID>[-slug].
#   R2  the PR adds docs/work-items/<ID>/PACKET.md, byte-identical to the owner-approved Packet; header fields
#       exactly once, WORK_ITEM/BRANCH bound to the branch. BASE_SHA is provenance only.
#   R3  every path in the net diff base..head is inside ALLOWED_SCOPE and outside FORBIDDEN_SCOPE (FORBIDDEN wins,
#       case-insensitive); PROCESS-only control paths need TYPE: PROCESS; regular files only; no private
#       authority, submodule or credential files; other work-item Packets only as literal carried records.
#   R4  migrations on main are immutable; new ones need `MIGRATIONS: new allowed`, a canonical name and a
#       timestamp after every migration on main, and may not be registered as applied before merge.
#   R5  no new case-insensitive path collision or case-only alias against main.
#   R6  no commit in base..head contains a credential-like or private-authority path (public history is permanent).
# History shape is not restricted: integration merges of main are normal; the net diff decides.
set -euo pipefail
export LC_ALL=C GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0
fail(){ echo "::error::ROSUNO-GUARD: $*"; exit 1; }
ERR=0; e(){ echo "::error::ROSUNO-GUARD: $*"; ERR=1; }
lc(){ printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

BASE="$(git rev-parse --verify -q "${1:?base}^{commit}")" || fail "base commit not found"
HEAD="$(git rev-parse --verify -q "${2:?head}^{commit}")" || fail "head commit not found"
BRANCH="${3:?branch}"
APPROVED="$(git rev-parse --verify -q "${4:?approved-ref}^{commit}")" || fail "owner approval branch for $BRANCH not found"

# R1
[[ "$BRANCH" =~ ^wi/([A-Z][A-Z0-9]*-[0-9]{3})(-[a-z0-9-]+)?$ ]] || fail "branch '$BRANCH' is not wi/<ID>[-slug]"
ID="${BASH_REMATCH[1]}"; PK="docs/work-items/$ID/PACKET.md"

# R0
git merge-base --is-ancestor "$BASE" "$HEAD" || fail "head does not contain current main $BASE; merge main into the branch (never rebase)"

# R2: approval binding
[ "$(git ls-tree "$HEAD" -- "$PK" | cut -d' ' -f1-2)" = "100644 blob" ] || fail "Packet $PK missing at head or not a regular file"
git cat-file -e "$BASE:$PK" 2>/dev/null && fail "Packet $PK already exists on main (a merged work item is not reused; use a new work item)"
AB="$(git rev-parse -q --verify "$APPROVED:$PK" 2>/dev/null)" || fail "owner branch $BRANCH has no $PK (Packet not adopted by the owner)"
HB="$(git rev-parse "$HEAD:$PK")"
[ "$AB" = "$HB" ] || fail "Packet differs from the owner-approved Packet on owner branch $BRANCH (sync the Packet copy)"
PKT="$(git cat-file blob "$HB")"
[[ "$PKT" != *$'\r'* ]] || fail "Packet contains a carriage return"

# R2: header fields. Each field exactly once in the file; lists stop at a blank line, a code fence, a heading
# or the next field, so Packet body text is never absorbed into a scope list.
cnt(){ grep -c "^$1:" <<<"$PKT" || true; }
val(){ sed -n "s/^$1:[[:space:]]*//p" <<<"$PKT" | sed 's/[[:space:]]*$//'; }
for k in WORK_ITEM TYPE BRANCH BASE_SHA MIGRATIONS ALLOWED_SCOPE FORBIDDEN_SCOPE; do
  [ "$(cnt "$k")" = 1 ] || fail "Packet must contain exactly one $k line"
done
[ "$(val WORK_ITEM)" = "$ID" ] || fail "Packet WORK_ITEM '$(val WORK_ITEM)' does not match branch work item '$ID'"
[ "$(val BRANCH)" = "$BRANCH" ] || fail "Packet BRANCH '$(val BRANCH)' does not match the PR head branch '$BRANCH'"
[[ "$(val BASE_SHA)" =~ ^[0-9a-f]{40}$ ]] || fail "Packet BASE_SHA must be a full 40-hex commit SHA"
TYPE="$(val TYPE)"; [[ "$TYPE" =~ ^[A-Z]+$ ]] || fail "Packet TYPE '$TYPE' is not an upper-case word"
MIGS="$(val MIGRATIONS)"
case "$MIGS" in none|"new allowed") ;; *) fail "Packet MIGRATIONS must be 'none' or 'new allowed' (got '$MIGS')";; esac
grep -q '^ALLOWED_SCOPE:[[:space:]]*$' <<<"$PKT" || fail "ALLOWED_SCOPE must be a list header"
grep -q '^FORBIDDEN_SCOPE:[[:space:]]*$' <<<"$PKT" || fail "FORBIDDEN_SCOPE must be a list header (the list may be empty)"
list(){
  awk -v k="$1:" '
    $0==k {f=1; next}
    f && ($0 ~ /^[[:space:]]*$/ || $0 ~ /^```/ || $0 ~ /^#/ || $0 ~ /^[A-Z_]+:/) {f=0}
    f && /^- / {sub(/^- /,""); print; next}
    f {print "\001MALFORMED\001" $0}' <<<"$PKT"
}
ALLOWED="$(list ALLOWED_SCOPE)"; FORBIDDEN="$(list FORBIDDEN_SCOPE)"
[[ "$ALLOWED$FORBIDDEN" != *$'\001MALFORMED\001'* ]] || fail "scope lists may contain only '- <pattern>' lines"
[ -n "$ALLOWED" ] || fail "ALLOWED_SCOPE is empty"
[ "$(printf '%s\n' "$ALLOWED" | LC_ALL=C sort -f | uniq -i | wc -l | tr -d ' ')" = "$(printf '%s\n' "$ALLOWED" | wc -l | tr -d ' ')" ] \
  || fail "duplicate or case-aliased ALLOWED_SCOPE entry"
matches(){ local p="$1" g; while IFS= read -r g; do [ -n "$g" ] || continue; case "$p" in $g) return 0;; esac; done <<<"$2"; return 1; }
literal(){ grep -Fxq -- "$1" <<<"$ALLOWED"; }

# Control paths that only a TYPE: PROCESS Packet may change (validators, CI, Builder configuration and capability
# configuration at any depth, toolchain). Cloud sessions load .mcp.json servers without approval.
process_only(){
  case "$1" in
    .github/*|.claude/*|*/.claude/*|claude.md|*/claude.md|claude.local.md|*/claude.local.md) return 0;;
    agents.md|*/agents.md|.mcp.json|*/.mcp.json) return 0;;
    docs/process/*|.gitattributes|package.json|.npmrc|pnpm-workspace.yaml) return 0;;
    .replit|.replitignore|tools/p0/validate.mjs|tools/p0/secret-scan.mjs|tools/p0/fast-control.mjs) return 0;;
    tools/p0/lib/controls.mjs|tools/p0/lib/fast-control.mjs|supabase/config.toml|supabase/seed*|supabase/seeds/*) return 0;;
  esac; return 1
}
credential_like(){
  case "$1" in
    *.env.example) return 1;;
    .env|.env.*|*/.env|*/.env.*|*.pem|*.key|*.p12|*.pfx|*id_rsa*|*id_ed25519*) return 0;;
  esac; return 1
}

# R4 inputs: migrations on main, the newest main timestamp, and migrations registered as applied.
BASEMIGS="$(git ls-tree -r -z --name-only "$BASE" -- supabase/migrations | tr '\0' '\n' | tr '[:upper:]' '[:lower:]')"
MAXTS="$(sed -n 's#^supabase/migrations/\([0-9]\{14\}\)_.*#\1#p' <<<"$BASEMIGS" | sort | tail -1)"
REG=governance/migrations/reviewed-migrations.json
APPLIED=""
if git cat-file -e "$HEAD:$REG" 2>/dev/null; then
  APPLIED="$(git cat-file blob "$HEAD:$REG" | jq -r '.migrations[]? | select((.applied_environment // "none") != "none") | .artifact_path // empty')" \
    || fail "$REG at head is not valid JSON"
fi

# R3/R4: every changed path in the net diff (raw, NUL-delimited, no rename pairing).
while IFS= read -r -d '' META && IFS= read -r -d '' P; do
  read -r SM DM _ _ ST <<<"${META#:}"
  for m in "$SM" "$DM"; do case "$m" in 000000|100644|100755) ;; *) e "[final diff] $P has git mode $m (symlink/submodule/special objects are not allowed)";; esac; done
  L="$(lc "$P")"
  if [ "$L" = "$(lc "$PK")" ]; then
    { [ "$P" = "$PK" ] && [ "$ST" = A ]; } || e "$P case-aliases or alters the Packet"
    continue
  fi
  case "$L" in
    docs/work-items/*)
      # Another work item's Packet may only be carried as a new, literally listed historical record
      # (e.g. P3-003's Packet inside the combined P3-904 history). Merged Packets stay immutable.
      if [[ "$P" =~ ^docs/work-items/[A-Z][A-Z0-9]*-[0-9]{3}/PACKET\.md$ ]] && [ "$ST" = A ] && [ "$DM" = 100644 ] && literal "$P"; then
        continue
      fi
      e "$P ($ST) is another work item's record; only a new Packet listed literally in ALLOWED_SCOPE may be carried"; continue;;
    rosuno-authority/*) e "$P: private authority documents never enter the repository"; continue;;
    .gitmodules) e "$P: submodules are not allowed"; continue;;
  esac
  credential_like "$L" && e "$P looks like a secret or credential file (never commit to a public repository)"
  { matches "$P" "$FORBIDDEN" || matches "$L" "$(lc "$FORBIDDEN")"; } && e "$P ($ST) is inside FORBIDDEN_SCOPE"
  matches "$P" "$ALLOWED" || e "$P ($ST) is outside ALLOWED_SCOPE"
  process_only "$L" && [ "$TYPE" != PROCESS ] && e "$P is a control path; it requires a TYPE: PROCESS Packet"
  case "$L" in
    supabase/migrations/*)
      if [[ "$P" != supabase/migrations/* ]]; then e "$P: migrations path with non-canonical case"
      elif grep -Fxq -- "$L" <<<"$BASEMIGS"; then e "migration $P is on main and immutable (status $ST); add a new forward-only migration instead"
      elif [ "$ST" != A ]; then e "migration $P: unexpected status $ST"
      elif [ "$MIGS" != "new allowed" ]; then e "new migration $P but the Packet says MIGRATIONS: $MIGS"
      elif [[ ! "$P" =~ ^supabase/migrations/([0-9]{14})_[a-z0-9_]+\.sql$ ]]; then e "new migration $P must be named supabase/migrations/<14-digit UTC>_<lower_snake>.sql"
      elif [ -n "$MAXTS" ] && [[ ! "${BASH_REMATCH[1]}" > "$MAXTS" ]]; then e "new migration $P must sort after the newest migration on main ($MAXTS)"
      elif grep -Fxq -- "$P" <<<"$APPLIED"; then e "migration $P is registered as applied before merge (persistent application only from main)"
      fi;;
  esac
done < <(git diff --raw -z --no-renames --no-abbrev "$BASE" "$HEAD")

# R5: case collisions introduced against main, at every path prefix (directories as well as files).
prefixes(){ git ls-tree -r -z --name-only "$1" | tr '\0' '\n' | awk -F/ '{p=""; for(i=1;i<=NF;i++){p=(i==1)?$i:p"/"$i; print p}}' | LC_ALL=C sort -u; }
caseclash(){ prefixes "$1" | awk '{print tolower($0)}' | LC_ALL=C sort | LC_ALL=C uniq -d; }
NEWDUP="$(LC_ALL=C comm -13 <(caseclash "$BASE") <(caseclash "$HEAD"))"
[ -z "$NEWDUP" ] || e "case-insensitive path collision: $(head -5 <<<"$NEWDUP" | tr '\n' ' ')"
XALIAS="$(awk 'NR==FNR{b[$0]=1; lb[tolower($0)]=$0; next} !($0 in b) && (tolower($0) in lb){print lb[tolower($0)]" -> "$0}' \
  <(prefixes "$BASE") <(prefixes "$HEAD") | sed -n 1,5p)"
[ -z "$XALIAS" ] || e "case-only change of an existing main path: $XALIAS"

# R6: per-commit leak and object-mode check over every commit the PR adds to main's history (including merged side
# commits). A symlink, submodule or special object is refused even if a later commit replaces it (P2-905).
while IFS= read -r c; do
  while IFS= read -r -d '' ENT; do
    M="${ENT%% *}"; P="${ENT#*$'\t'}"
    L="$(lc "$P")"
    case "$M" in 100644|100755) ;; *) e "[commit ${c:0:12}] $P has git mode $M (symlink/submodule/special objects are not allowed)";; esac
    case "$L" in rosuno-authority/*) e "commit ${c:0:12} contains private authority path $P (public history is permanent)";; esac
    credential_like "$L" && e "commit ${c:0:12} contains credential-like path $P (public history is permanent)"
  done < <(git ls-tree -r -z "$c")
done < <(git rev-list "$BASE..$HEAD")

[ "$ERR" = 0 ] || fail "violations above"
PSHA="$(git cat-file blob "$HB" | { command -v shasum >/dev/null && shasum -a 256 || sha256sum; } | cut -d' ' -f1)"
echo "ROSUNO-GUARD PASS work_item=$ID type=$TYPE packet_sha256=$PSHA base=$BASE head=$HEAD approved=$APPROVED"
