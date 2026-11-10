#!/usr/bin/env bash
# rosuno-guard (cloud fork edition rev 2, derived from UOM v1.8 rev 5 draft): merge-boundary check posted as the required
# status "rosuno-guard". Reads git objects only; executes nothing from the PR.
# Usage: rosuno-guard.sh <base-sha> <head-ref> <head-branch> <approved-ref>
#   <approved-ref> = tip of the OWNER repository's branch with the same name as the PR head branch. Only the owner can
#   push there, so a matching Packet blob proves the Packet is the owner-approved one.
set -euo pipefail
fail(){ echo "::error::ROSUNO-GUARD: $*"; exit 1; }
lc(){ printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
normal_guard() (
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
for k in WORK_ITEM BRANCH BASE_SHA TYPE MIGRATIONS ALLOWED_SCOPE FORBIDDEN_SCOPE; do [ "$(cnt "$k")" = 1 ] || fail "Packet must contain exactly one $k line"; done
[ "$(val WORK_ITEM)" = "$ID" ] || fail "Packet WORK_ITEM '$(val WORK_ITEM)' does not match branch work item '$ID'"
[ "$(val BRANCH)" = "$BRANCH" ] || fail "Packet BRANCH '$(val BRANCH)' does not match the PR head branch '$BRANCH'"
PBASE="$(val BASE_SHA)"
[[ "$PBASE" =~ ^[0-9a-f]{40}$ ]] || fail "Packet BASE_SHA must be a full 40-hex commit SHA"
[ "$PBASE" = "$(git rev-parse "$FIRST^")" ] || fail "Packet BASE_SHA $PBASE is not the parent of the Packet commit"
[ "$MB" = "$PBASE" ] || fail "merge-base $MB does not equal approved Packet BASE_SHA $PBASE"
list(){ awk -v k="$1:" '$0==k{f=1;next} /^[A-Z_]+:/{f=0} f&&/^[[:space:]]*- /{sub(/^[[:space:]]*- /,"");print}' <<<"$PKT"; }
ALLOWED="$(list ALLOWED_SCOPE)"; FORBIDDEN="$(list FORBIDDEN_SCOPE)"
[ -n "$ALLOWED" ] || fail "ALLOWED_SCOPE is empty"
[ "$(printf '%s\n' "$ALLOWED" | LC_ALL=C sort -f | uniq -i | wc -l | tr -d ' ')" = "$(printf '%s\n' "$ALLOWED" | wc -l | tr -d ' ')" ] || fail "duplicate/case-aliased allowlist entry"
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

)

# P2-914: immutable, one-time combined P3-003/P3-904 history. The ordinary
# guard above is invoked unchanged on both separately approved Packet segments.
# P2-915: the same exact branch may complete only as the pinned P3-904 recovery:
# the immutable P3-904 Packet and three implementation commits, then exactly one
# security correction commit (the single permitted edit of the one P3-904
# migration) and one final administrative registration commit (exactly three
# governance paths, append-only, pending/unapplied/unreleased). It requires the
# P2-915 PROCESS Packet in the PR base (protected Owner main) and a separately
# GitHub-authenticated, unedited, unique owner approval comment on this PR that
# binds every exact value. A PASS is structural only: never security acceptance,
# review, CI success or merge authorization.
combined_guard() (
  local ORIGINAL_BASE='8449593d0baccac377f4884ede522d00fa1cc997'
  local OWNER_PACKET_COMMIT='ae9c644967c702972f8c14a964d78e4bb4c2a83b'
  local BUILDER_PACKET_COMMIT='405956f9f4a14432a12fc7eacb10e33c0278e39d'
  local ORIGINAL_PACKET_BLOB='c394078a7440d5e48bce81c33d7a581d951d1c74'
  local ORIGINAL_TREE='c9823d197923c17c146bdc10b0ec47a1cc8564c0'
  local ORIGINAL_BRANCH='wi/P3-003-attorney-trust-professional-setup'
  local CORRECTION_BRANCH='wi/P3-904-p3-003-security-correction'
  local ORIGINAL_APPROVAL='refs/rosuno/p3-003-approved'
  local ORIGINAL_PACKET_PATH='docs/work-items/P3-003/PACKET.md'
  local CORRECTION_PACKET_PATH='docs/work-items/P3-904/PACKET.md'
  local ORIGINAL_COMMITS=(
    '77b29508b1ed9c5a8e79c352be04016d956e30d4'
    'ac9c5feba15a4f2453ebbca907ecdac372a55f32'
    '4e548818d38f86f18fadcc3072293be58493d679'
    '9cedce919b05288800574d0c96049415c892926d'
    '4425c5f5f3be59bdb08b14c20eb4afa5f6701893'
    'ba6fc7888ea842b89d70e44cee62203af68c52fd'
    '4d22a2b2c8916e01da24227e7f5b1235b3de1ebe'
    'b3fda55231625d440f3aa536e36c30e1dbb5b94a'
  )
  # P2-915 pins (adopted P2-915 Packet §2, §4, §5).
  local P3904_PACKET_COMMIT='b90c1ca17daaaae10b63c70acc31842efc673d87'
  local P3904_PACKET_BLOB='b4b6fc9f080f28b3a385ad09f3431c9a8c3f2bba'
  local P3904_COMMITS=(
    '2cfd62900f3d4281fb813f9e1ceac4cafc6d226e'
    '90ef51fcaac6d5737ed41cd4465dc99bcb7c9898'
    '1c4acec9df60fa0c59f8bd61e8053d744ed36478'
  )
  local P3904_TREE='c585ff8046e69278c4c8b0cce868c1a469019f28'
  local P3904_MIGRATION='supabase/migrations/20261106090000_p3_904_professional_write_boundary.sql'
  local P3904_MIGRATION_ID='20261106090000_p3_904_professional_write_boundary'
  local P3904_MIGRATION_BLOB='d54a86e20f57bde5c09f38bdc2d95ecc8b28391c'
  local P2915_PACKET_COMMIT='4daf4fa10924dee60567f8403e0356e2f16b186f'
  local P2915_PACKET_PATH='docs/work-items/P2-915/PACKET.md'
  local P2915_PACKET_BLOB='c02a8740944c2dbf418609e55d99301c87270331'
  local GOVERNANCE_PATHS=(
    'governance/migrations/reviewed-migrations.json'
    'governance/work-items/index.json'
    'governance/decision-log.json'
  )
  local OWNER_REPOSITORY='NatthanPrevot/Rosuno'
  local OWNER_LOGIN='NatthanPrevot'
  local BUILDER_REPOSITORY='RosunoBackup/Rosuno'
  local APPROVAL_MARKER='ROSUNO-P2-915-P3-904-GOVERNANCE-APPROVAL-V1'
  local REVOCATION_MARKER='ROSUNO-P2-915-P3-904-GOVERNANCE-REVOCATION-V1'
  local MARKER_FAMILY='ROSUNO-P2-915-P3-904-GOVERNANCE-'
  local APPROVAL_SCOPE='pending-unapplied-unreleased-registration-of-exactly-these-three-governance-paths'
  local BASE="${1:?base}" HEAD BRANCH="${3:?branch}" APPROVED BASE_COMMIT
  HEAD="$(git rev-parse --verify "${2:?head}^{commit}")" || fail 'P3-904 head unavailable'
  APPROVED="$(git rev-parse --verify -q "${4:?approved-ref}^{commit}")" || fail 'P3-904 owner approval unavailable'
  [ "$BRANCH" = "$CORRECTION_BRANCH" ] || fail 'P3-904 branch identity mismatch'
  [ "$(git merge-base "$BASE" "$HEAD")" = "$ORIGINAL_BASE" ] || fail 'P3-904 combined merge-base mismatch'
  git merge-base --is-ancestor "$ORIGINAL_BASE" "$BASE" || fail 'P3-904 PR base not descended from original base'
  BASE_COMMIT="$(git rev-parse --verify "$BASE^{commit}")" || fail 'P3-904 PR base unavailable'

  # The additional original-approval ref is fetched only by the trusted workflow.
  [ "$(git rev-parse --verify -q "${ORIGINAL_APPROVAL}^{commit}" 2>/dev/null)" = "$OWNER_PACKET_COMMIT" ] \
    || fail 'P3-003 owner approval ref absent or moved'
  [ "$(git rev-parse "$ORIGINAL_APPROVAL:$ORIGINAL_PACKET_PATH")" = "$ORIGINAL_PACKET_BLOB" ] \
    || fail 'P3-003 owner Packet blob mismatch'
  [ "$(git rev-parse "$BUILDER_PACKET_COMMIT:$ORIGINAL_PACKET_PATH")" = "$ORIGINAL_PACKET_BLOB" ] \
    || fail 'P3-003 Builder Packet blob mismatch'
  [ "$(git rev-parse "${OWNER_PACKET_COMMIT}^1")" = "$ORIGINAL_BASE" ] \
    || fail 'P3-003 owner Packet parent mismatch'
  [ "$(git rev-parse "${BUILDER_PACKET_COMMIT}^1")" = "$ORIGINAL_BASE" ] \
    || fail 'P3-003 Builder Packet parent mismatch'
  [ "$(git diff-tree --no-commit-id --name-status -r "$BUILDER_PACKET_COMMIT")" = \
    "$(printf 'A\t%s' "$ORIGINAL_PACKET_PATH")" ] || fail 'P3-003 Packet commit is not Packet-only'

  # Pin the complete immutable original history, including the Packet commit.
  local -a EXPECTED=("$BUILDER_PACKET_COMMIT" "${ORIGINAL_COMMITS[@]}")
  local -a ACTUAL=()
  mapfile -t ACTUAL < <(git rev-list --reverse --topo-order \
    "$ORIGINAL_BASE..${ORIGINAL_COMMITS[7]}")
  [ "${#ACTUAL[@]}" -eq "${#EXPECTED[@]}" ] || fail 'P3-003 original commit count mismatch'
  local i prior="$ORIGINAL_BASE"
  for i in "${!EXPECTED[@]}"; do
    [ "${ACTUAL[i]}" = "${EXPECTED[i]}" ] || fail "P3-003 original commit $i differs"
    [ "$(git rev-list --parents -n 1 "${EXPECTED[i]}")" = "${EXPECTED[i]} $prior" ] \
      || fail "P3-003 original commit $i parent differs"
    prior="${EXPECTED[i]}"
  done
  local ORIGINAL_HEAD="${ORIGINAL_COMMITS[7]}"
  [ "$(git rev-parse "${ORIGINAL_HEAD}^{tree}")" = "$ORIGINAL_TREE" ] \
    || fail 'P3-003 original tree mismatch'
  git merge-base --is-ancestor "$ORIGINAL_HEAD" "$HEAD" \
    || fail 'P3-003 original HEAD not an ancestor of P3-904'

  # P2-915 provenance: the adopted PROCESS Packet must already be integrated
  # into the PR base (protected Owner main), never asserted by the PR itself.
  git merge-base --is-ancestor "$P2915_PACKET_COMMIT" "$BASE_COMMIT" 2>/dev/null \
    || fail 'P2-915 PROCESS Packet commit is not integrated into the PR base (protected Owner main)'
  [ "$(git rev-parse --verify -q "$BASE_COMMIT:$P2915_PACKET_PATH" 2>/dev/null)" = "$P2915_PACKET_BLOB" ] \
    || fail 'P2-915 PROCESS Packet blob on the PR base differs from the adopted Packet'

  # Exact P3-904 recovery history: Packet commit, three immutable commits,
  # one security correction, one final administrative registration commit.
  local -a P3904_EXPECTED=("$P3904_PACKET_COMMIT" "${P3904_COMMITS[@]}")
  local -a CHAIN=()
  mapfile -t CHAIN < <(git rev-list --reverse --topo-order "$ORIGINAL_HEAD..$HEAD")
  prior="$ORIGINAL_HEAD"
  for i in "${!P3904_EXPECTED[@]}"; do
    [ "${CHAIN[i]:-}" = "${P3904_EXPECTED[i]}" ] \
      || fail "P3-904 immutable commit $i differs or is missing (exact pinned P3-904 history required)"
    [ "$(git rev-list --parents -n 1 "${P3904_EXPECTED[i]}")" = "${P3904_EXPECTED[i]} $prior" ] \
      || fail "P3-904 immutable commit $i parent differs"
    prior="${P3904_EXPECTED[i]}"
  done
  [ "$(git rev-parse "${P3904_COMMITS[2]}^{tree}")" = "$P3904_TREE" ] \
    || fail 'P3-904 immutable original tree mismatch'
  [ "$(git diff-tree --no-commit-id -r --raw --no-abbrev "$P3904_PACKET_COMMIT")" = \
    "$(printf ':000000 100644 %s %s A\t%s' 0000000000000000000000000000000000000000 "$P3904_PACKET_BLOB" "$CORRECTION_PACKET_PATH")" ] \
    || fail 'P3-904 Packet commit is not the pinned Packet-only commit'
  [ "${#CHAIN[@]}" -ge 5 ] || fail 'P3-904 security correction commit missing (only a completed recovery is accepted)'
  [ "${#CHAIN[@]}" -ge 6 ] || fail 'P3-904 administrative registration commit missing'
  [ "${#CHAIN[@]}" -eq 6 ] \
    || fail "P3-904 recovery must be exactly one security and one administrative commit after the immutable chain (found $((${#CHAIN[@]} - 4)))"
  local SECURITY="${CHAIN[4]}" ADMIN="${CHAIN[5]}"
  [ "$(git rev-list --parents -n 1 "$SECURITY")" = "$SECURITY ${P3904_COMMITS[2]}" ] \
    || fail 'P3-904 security correction commit must have the immutable original HEAD as its only parent'
  [ "$(git rev-list --parents -n 1 "$ADMIN")" = "$ADMIN $SECURITY" ] \
    || fail 'P3-904 administrative commit must have the security correction commit as its only parent'
  [ "$ADMIN" = "$HEAD" ] || fail 'P3-904 administrative commit is not the PR head'

  # Reuse ALL existing per-commit, mode, case, migration, Packet and scope
  # protections for each approval independently; do not reimplement them.
  # Hide intermediate segment PASS lines, never diagnostics. pipefail retains
  # failures from either independently validated segment. The P3-904 segment
  # ends at the security commit; the administrative commit is checked below.
  normal_guard "$ORIGINAL_BASE" "$ORIGINAL_HEAD" "$ORIGINAL_BRANCH" "$ORIGINAL_APPROVAL" \
    | sed '/^ROSUNO-GUARD PASS /d'
  normal_guard "$ORIGINAL_HEAD" "$SECURITY" "$CORRECTION_BRANCH" "$APPROVED" \
    | sed '/^ROSUNO-GUARD PASS /d'

  # Migration events across the whole correction history: only the pinned
  # introduction and one later forward-only modification of the same path.
  local ADDED=0 CORRECTED=0 c META P SM DM SB DB ST L
  for c in "${CHAIN[@]}"; do
    while IFS= read -r -d '' META && IFS= read -r -d '' P; do
      read -r SM DM SB DB ST <<<"${META#:}"
      L="$(lc "$P")"
      case "$L" in supabase/migrations|supabase/migrations/*) ;; *) continue ;; esac
      if [ "$P" != "$P3904_MIGRATION" ]; then
        [ "$L" != "$(lc "$P3904_MIGRATION")" ] || fail "P3-904 migration case alias: $P ($ST)"
        [ "$ST" != A ] || fail "P3-904 additional migration not permitted: $P"
        fail "P3-904 history changes another migration: $P ($ST)"
      fi
      if [ "$c" = "${P3904_COMMITS[0]}" ]; then
        [ "$ST" = A ] && [ "$DM" = 100644 ] && [ "$DB" = "$P3904_MIGRATION_BLOB" ] \
          || fail 'P3-904 migration not introduced by the pinned commit with the pinned blob'
        ADDED=$((ADDED+1))
      elif [ "$c" = "$SECURITY" ]; then
        [ "$ST" != D ] || fail "P3-904 migration deleted: $P"
        [ "$ST" = M ] || fail "P3-904 migration re-added or replaced: $P ($ST)"
        [ "$SM" = 100644 ] && [ "$DM" = 100644 ] || fail "P3-904 migration mode change: $SM -> $DM"
        [ "$SB" = "$P3904_MIGRATION_BLOB" ] || fail 'P3-904 correction does not start from the original migration blob'
        CORRECTED=$((CORRECTED+1))
      elif [ "$c" = "$ADMIN" ]; then
        fail "P3-904 migration change outside the single permitted correction commit: $P ($ST)"
      else
        fail "P3-904 migration change before the pinned original HEAD: $P ($ST)"
      fi
    done < <(git diff-tree --no-commit-id -r --raw -z --no-renames --no-abbrev "$c")
  done
  [ "$ADDED" -eq 1 ] || fail "P3-904 requires exactly one new migration (found $ADDED)"
  [ "$CORRECTED" -eq 1 ] || fail "P3-904 requires exactly one correction of the original migration (found $CORRECTED)"
  [ "$(git ls-tree "$HEAD" -- "$P3904_MIGRATION" | cut -d' ' -f1-2)" = '100644 blob' ] \
    || fail 'P3-904 corrected migration missing at head or not a regular file'
  [ "$(git rev-parse "$HEAD:$P3904_MIGRATION")" != "$P3904_MIGRATION_BLOB" ] \
    || fail 'P3-904 migration correction reverted to the original bytes'
  # Exactly one new migration filename; all historical migrations byte-identical.
  [ "$(git ls-tree -r "$HEAD" -- supabase/migrations | awk -F'\t' -v p="$P3904_MIGRATION" '$2 != p')" = \
    "$(git ls-tree -r "$ORIGINAL_BASE" -- supabase/migrations)" ] \
    || fail 'P3-904 historical migration inventory changed'
  [ "$(git show "$HEAD:$CORRECTION_PACKET_PATH" | \
    sed -n 's/^MIGRATIONS:[[:space:]]*//p')" != none ] \
    || fail 'P3-904 Packet does not allow a migration'

  # Additionally reject case-only aliases that span both approved segments.
  local XALIAS
  XALIAS="$(awk 'NR==FNR { base[$0]=1; lower[tolower($0)]=$0; next }
    !($0 in base) && (tolower($0) in lower) {print lower[tolower($0)] " -> " $0}' \
    <(git ls-tree -r --name-only "$ORIGINAL_BASE" | awk -F/ '{p="";for(i=1;i<=NF;i++){p=(i==1)?$i:p"/"$i;print p}}' | LC_ALL=C sort -u) \
    <(git ls-tree -r --name-only "$HEAD" | awk -F/ '{p="";for(i=1;i<=NF;i++){p=(i==1)?$i:p"/"$i;print p}}' | LC_ALL=C sort -u))"
  [ -z "$XALIAS" ] || fail "cross-segment case-only path alias: $XALIAS"

  command -v jq >/dev/null || fail 'P2-915 requires jq'
  local T
  T="$(mktemp -d)" || fail 'P2-915 temporary directory unavailable'
  trap 'rm -rf "$T"' EXIT

  # Administrative registration commit: exactly the three governance paths,
  # modified in place, from registers identical to the PR base's.
  local EXPECTED_ADMIN ACTUAL_ADMIN g n
  EXPECTED_ADMIN="$(printf '%s\n' "${GOVERNANCE_PATHS[@]}" | LC_ALL=C sort)"
  ACTUAL_ADMIN="$(git diff-tree --no-commit-id -r --name-only --no-renames "$ADMIN" | LC_ALL=C sort)"
  [ "$ACTUAL_ADMIN" = "$EXPECTED_ADMIN" ] \
    || fail "P2-915 administrative commit must change exactly the three governance paths (changed: $(printf '%s' "$ACTUAL_ADMIN" | tr '\n' ' '))"
  while IFS= read -r -d '' META && IFS= read -r -d '' P; do
    read -r SM DM SB DB ST <<<"${META#:}"
    [ "$ST" = M ] && [ "$SM" = 100644 ] && [ "$DM" = 100644 ] \
      || fail "P2-915 administrative commit must modify $P in place as a regular file ($ST $SM -> $DM)"
  done < <(git diff-tree --no-commit-id -r --raw -z --no-renames --no-abbrev "$ADMIN")
  # Byte-level append-only: every prior byte up to the last existing record is
  # kept, followed only by ",\n", the appended record and the same closing.
  local SUFFIX=$'\n  ]\n}\n' PLEN
  n=0
  for g in "${GOVERNANCE_PATHS[@]}"; do
    n=$((n+1))
    [ "$(git rev-parse "$SECURITY:$g")" = "$(git rev-parse "$ORIGINAL_BASE:$g")" ] \
      || fail "P2-915 pre-registration $g differs from the original base"
    [ "$(git rev-parse --verify -q "$BASE_COMMIT:$g" 2>/dev/null)" = "$(git rev-parse "$SECURITY:$g")" ] \
      || fail "P2-915 registration base drift: $g on the PR base differs from the pre-registration P3-904 state"
    git show "$SECURITY:$g" >"$T/prior-$n.json"
    git show "$ADMIN:$g" >"$T/next-$n.json"
    PLEN="$(wc -c <"$T/prior-$n.json" | tr -d ' ')"
    [ "$PLEN" -gt 7 ] \
      && cmp -s <(tail -c 7 "$T/prior-$n.json") <(printf '%s' "$SUFFIX") \
      && cmp -s <(tail -c 7 "$T/next-$n.json") <(printf '%s' "$SUFFIX") \
      && cmp -s <(head -c "$((PLEN - 7))" "$T/prior-$n.json") <(head -c "$((PLEN - 7))" "$T/next-$n.json") \
      && cmp -s <(tail -c "+$((PLEN - 6))" "$T/next-$n.json" | head -c 2) <(printf ',\n') \
      || fail "P2-915 administrative commit rewrites existing bytes of $g (append-only: one record after the last existing record)"
  done
  local REGISTRATION
  REGISTRATION="$(jq -n -r \
    --slurpfile pm "$T/prior-1.json" --slurpfile nm "$T/next-1.json" \
    --slurpfile pw "$T/prior-2.json" --slurpfile nw "$T/next-2.json" \
    --slurpfile pd "$T/prior-3.json" --slurpfile nd "$T/next-3.json" \
    --arg mid "$P3904_MIGRATION_ID" --arg mpath "$P3904_MIGRATION" '
    def appended($p; $n; $k; $label):
      if ($p|type) != "object" or ($n|type) != "object" then error("\($label) is not a JSON object")
      elif ($p|keys) != ($n|keys) then error("\($label) top-level keys changed")
      elif ($p|del(.[$k])) != ($n|del(.[$k])) then error("\($label) non-record fields changed")
      elif ($p[$k]|type) != "array" or ($n[$k]|type) != "array" then error("\($label) \($k) is not an array")
      elif ($n[$k]|length) != ($p[$k]|length) + 1 then
        error("\($label) must append exactly one record (delta \(($n[$k]|length) - ($p[$k]|length)))")
      elif $n[$k][0:($p[$k]|length)] != $p[$k] then error("\($label) existing records changed or reordered")
      else $n[$k][-1] end;
    def has_string($v): type == "array" and any(.[]; . == $v);
    def fields: ["applied_environment","artifact_path","authority_refs","decision_refs","depends_on",
      "drift_check","migration_id","migration_kind","non_production_validation","release_refs",
      "reviewed","reviewed_at","reviewed_by","rollback_plan","sequence","work_item_refs"] | sort;
    if ($pm|length) != 1 or ($nm|length) != 1 or ($pw|length) != 1 or ($nw|length) != 1
       or ($pd|length) != 1 or ($nd|length) != 1 then "ERR\tgovernance file is not exactly one JSON document"
    else try (
      appended($pm[0]; $nm[0]; "migrations"; "reviewed-migrations.json") as $m
      | appended($pw[0]; $nw[0]; "work_items"; "work-items/index.json") as $w
      | appended($pd[0]; $nd[0]; "decisions"; "decision-log.json") as $d
      | if ($m|type) != "object" or ($m|keys) != fields then
          error("appended migration must have exactly the reviewed-register fields")
        elif $m.migration_id != $mid or $m.artifact_path != $mpath or $m.migration_kind != "product" then
          error("appended migration is not the single P3-904 migration")
        elif $m.sequence != ($nm[0].migrations|length) then error("appended migration sequence is not its register position")
        elif $m.reviewed != false or $m.reviewed_by != "pending designated human PR review" or $m.reviewed_at != null
             or $m.applied_environment != "none" or $m.release_refs != [] then
          error("appended migration is not in the pending, unapplied, unreleased reviewed-candidate state")
        elif any($pm[0].migrations[]; (.migration_id? == $mid) or (.artifact_path? == $mpath)) then
          error("P3-904 migration already registered")
        elif ($w|type) != "object" or ($w.work_item_id|type) != "string" or $w.work_item_id == "" then
          error("appended work item lacks a work_item_id")
        elif ($d|type) != "object" or ($d.decision_id|type) != "string" or $d.decision_id == "" then
          error("appended decision lacks a decision_id")
        elif any($pw[0].work_items[]; .work_item_id? == $w.work_item_id) then error("appended work item id collides")
        elif any($pd[0].decisions[]; .decision_id? == $d.decision_id) then error("appended decision id collides")
        elif $m.work_item_refs != [$w.work_item_id] then error("migration work_item_refs must name exactly the appended work item")
        elif $m.decision_refs != [$d.decision_id] then error("migration decision_refs must name exactly the appended decision")
        elif $w.migration_refs != [$mid] then error("appended work item migration_refs must name exactly the P3-904 migration")
        elif $w.release_refs != [] then error("appended work item must not claim a release")
        elif ($w.decision_refs | has_string($d.decision_id)) | not then error("appended work item does not reference the appended decision")
        elif ($d.work_item_refs | has_string($w.work_item_id)) | not then error("appended decision does not reference the appended work item")
        else "OK\t\($w.work_item_id)\t\($d.decision_id)" end
    ) catch "ERR\t\(.)" end')" || fail 'P2-915 governance registers are not valid JSON'
  [ "${REGISTRATION%%$'\t'*}" = OK ] || fail "P2-915 registration: ${REGISTRATION#*$'\t'}"

  # Separately GitHub-authenticated owner approval of these exact bytes,
  # retrieved from the fixed owner-repository API, never from PR content.
  command -v gh >/dev/null || fail 'P2-915 approval: gh unavailable (fail closed)'
  [ -n "${GH_TOKEN:-}" ] || fail 'P2-915 approval: trusted workflow token unavailable (fail closed)'
  [ "${REPO:-}" = "$OWNER_REPOSITORY" ] || fail 'P2-915 approval: trusted workflow repository is not the owner repository'
  [[ "${PR_NUMBER:-}" =~ ^[1-9][0-9]{0,8}$ ]] || fail 'P2-915 approval: trusted workflow PR number unavailable'
  [ "${HEAD_SHA:-}" = "$HEAD" ] || fail 'P2-915 approval: trusted event head differs from the checked head'
  [ "${BASE_SHA:-}" = "$BASE_COMMIT" ] || fail 'P2-915 approval: trusted event base differs from the checked base'
  gh_get() {
    local out="$1"; shift
    gh api "$@" >"$T/$out" 2>"$T/gh.err" \
      || fail "P2-915 approval: GitHub API request failed for ${!#} (fail closed): $(head -c 300 "$T/gh.err" | tr -d '\r' | head -n 1)"
  }
  # Any governance marker outside the owner's issue comments is ambiguous.
  no_marker_in() {
    local file="$1" what="$2" found
    found="$(jq -s -r --arg family "$MARKER_FAMILY" '
      [ .[] | if type == "array" then .[] else error("page is not a JSON array") end
        | if type == "object" then . else error("malformed record") end
        | select(((.body // "") | ascii_downcase | contains($family | ascii_downcase))) | .id ]
      | if length == 0 then "NONE" else "ID\t\(.[0])" end' "$T/$file")" \
      || fail "P2-915 approval: $what response is not valid (fail closed)"
    [ "$found" = NONE ] \
      || fail "P2-915 approval: governance marker in $what ${found#*$'\t'}; approval and revocation are owner issue comments only (ambiguous)"
  }
  gh_get owner.json "users/$OWNER_LOGIN"
  local OWNER_ID
  OWNER_ID="$(jq -r --arg login "$OWNER_LOGIN" '
    if type == "object" and .login == $login and .type == "User" and (.id|type) == "number" and .id > 0
    then .id else "ERR" end' "$T/owner.json")" || fail 'P2-915 approval: owner account response unreadable'
  [[ "$OWNER_ID" =~ ^[1-9][0-9]*$ ]] || fail 'P2-915 approval: owner account identity could not be verified'
  gh_get pull.json "repos/$OWNER_REPOSITORY/pulls/$PR_NUMBER"
  local PULL
  PULL="$(jq -r --argjson pr "$PR_NUMBER" --arg head "$HEAD" --arg base "$BASE_COMMIT" --arg family "$MARKER_FAMILY" \
    --arg branch "$CORRECTION_BRANCH" --arg repo "$OWNER_REPOSITORY" --arg fork "$BUILDER_REPOSITORY" \
    --arg login "$OWNER_LOGIN" --argjson owner "$OWNER_ID" '
    if type != "object" then "pull request response is not an object"
    elif .number != $pr then "pull request number mismatch"
    elif .state != "open" then "pull request is not open"
    elif .head.sha != $head then "pull request head is not the checked head (stale or moved)"
    elif .head.ref != $branch or .head.repo.full_name != $fork then "pull request head source mismatch"
    elif .base.ref != "main" or .base.repo.full_name != $repo then "pull request base is not owner main"
    elif .base.sha != $base then "pull request base is not the checked base (stale or moved)"
    elif .user.login != $login or .user.id != $owner then "pull request author is not the verified owner account"
    elif ((.title // "") + "\n" + (.body // "")) | ascii_downcase | contains($family | ascii_downcase) then
      "governance marker in the pull request title or description; approval is a separate owner issue comment only"
    else "OK" end' "$T/pull.json")" || fail 'P2-915 approval: pull request response unreadable'
  [ "$PULL" = OK ] || fail "P2-915 approval: $PULL"
  gh_get reviews.json --paginate "repos/$OWNER_REPOSITORY/pulls/$PR_NUMBER/reviews?per_page=100"
  no_marker_in reviews.json 'pull request review'
  gh_get review-comments.json --paginate "repos/$OWNER_REPOSITORY/pulls/$PR_NUMBER/comments?per_page=100"
  no_marker_in review-comments.json 'pull request review comment'
  gh_get comments.json --paginate "repos/$OWNER_REPOSITORY/issues/$PR_NUMBER/comments?per_page=100"
  local BLOB_REGISTER BLOB_INDEX BLOB_DECISIONS EXPECTED_BODY
  BLOB_REGISTER="$(git rev-parse "$ADMIN:${GOVERNANCE_PATHS[0]}")"
  BLOB_INDEX="$(git rev-parse "$ADMIN:${GOVERNANCE_PATHS[1]}")"
  BLOB_DECISIONS="$(git rev-parse "$ADMIN:${GOVERNANCE_PATHS[2]}")"
  EXPECTED_BODY="$(printf '%s\n' \
    "$APPROVAL_MARKER" \
    "repository=$OWNER_REPOSITORY" \
    "pull_request=$PR_NUMBER" \
    "branch=$CORRECTION_BRANCH" \
    "security_commit=$SECURITY" \
    "administrative_commit=$ADMIN" \
    "head=$HEAD" \
    "base=$BASE_COMMIT" \
    "${GOVERNANCE_PATHS[0]}=$BLOB_REGISTER" \
    "${GOVERNANCE_PATHS[1]}=$BLOB_INDEX" \
    "${GOVERNANCE_PATHS[2]}=$BLOB_DECISIONS" \
    "approval=$APPROVAL_SCOPE")"
  local APPROVAL
  APPROVAL="$(jq -s -r --arg login "$OWNER_LOGIN" --argjson owner "$OWNER_ID" \
    --arg family "$MARKER_FAMILY" --arg approve "$APPROVAL_MARKER" --arg revoke "$REVOCATION_MARKER" \
    --arg expected "$EXPECTED_BODY" '
    def norm: gsub("\r"; "") | sub("\n+$"; "");
    try (
      [ .[] | if type == "array" then .[] else error("comment page is not a JSON array") end ]
      | map(if type == "object" and (.id|type) == "number" and (.user|type) == "object"
              and (.user.login|type) == "string" and (.user.id|type) == "number"
              and (.created_at|type) == "string" and (.updated_at|type) == "string"
              and ((.body|type) == "string" or .body == null)
            then .body = (.body // "") else error("malformed comment record") end) as $all
      | if ($all | map(.id) | unique | length) != ($all | length) then error("duplicate comment ids in the paginated response") else . end
      | ($all | map(select(.body | ascii_downcase | contains($family | ascii_downcase)))) as $marked
      | ($marked | map(select(.user.login != $login or .user.id != $owner))) as $foreign
      | if ($foreign | length) > 0 then
          error("governance marker comment \($foreign[0].id) is not authored by the verified owner account (\($foreign[0].user.login), id \($foreign[0].user.id)); ambiguous")
        elif any($marked[]; .body | ascii_downcase | contains($revoke | ascii_downcase)) then
          error("current owner revocation comment present")
        else . end
      | ($marked | map(select(.body | contains($approve)))) as $approvals
      | ($marked | map(select(.body | contains($approve) | not))) as $other
      | if ($other | length) > 0 then error("unrecognized or conflicting owner governance marker in comment \($other[0].id)")
        elif ($approvals | length) == 0 then error("no owner approval comment on this pull request")
        elif ($approvals | length) > 1 then error("\($approvals | length) owner approval comments (duplicate or conflicting)")
        else $approvals[0] end
      | . as $a
      | if $a.created_at != $a.updated_at then error("approval comment \($a.id) was edited after creation")
        else . end
      | ($a.body | norm | split("\n")) as $got
      | ($expected | split("\n")) as $want
      | if $got != $want then
          ([range(0; [($got|length), ($want|length)] | max)] | map(select($got[.] != $want[.])) | first) as $line
          | error("approval comment \($a.id) does not bind the exact current values (first mismatch at line \($line + 1): expected \(($want[$line] // "<end of body>") | split("=")[0]))")
        else "OK\t\($a.id)\t\($a.user.id)\t\($a.created_at)\t\($a.updated_at)\t\($a.body | @base64)" end
    ) catch "ERR\t\(.)"' "$T/comments.json")" \
    || fail 'P2-915 approval: comment response is not valid JSON (fail closed)'
  [ "${APPROVAL%%$'\t'*}" = OK ] || fail "P2-915 approval: ${APPROVAL#*$'\t'}"
  local COMMENT_ID AUTHOR_ID CREATED_AT UPDATED_AT BODY_B64 BODY_SHA
  IFS=$'\t' read -r _ COMMENT_ID AUTHOR_ID CREATED_AT UPDATED_AT BODY_B64 <<<"$APPROVAL"
  BODY_SHA="$(printf '%s' "$BODY_B64" | base64 -d | { command -v shasum >/dev/null && shasum -a 256 || sha256sum; } | cut -d' ' -f1)"
  [[ "$BODY_SHA" =~ ^[0-9a-f]{64}$ ]] || fail 'P2-915 approval: comment body digest unavailable'

  echo "ROSUNO-GUARD AUDIT p2915_owner_approval repository=$OWNER_REPOSITORY pr=$PR_NUMBER comment_id=$COMMENT_ID author=$OWNER_LOGIN author_id=$AUTHOR_ID created_at=$CREATED_AT updated_at=$UPDATED_AT body_sha256=$BODY_SHA head=$HEAD base=$BASE_COMMIT security=$SECURITY administrative=$ADMIN reviewed_migrations=$BLOB_REGISTER work_items=$BLOB_INDEX decision_log=$BLOB_DECISIONS"
  echo "ROSUNO-GUARD PASS combined=P3-003+P3-904 recovery=P2-915 head=$HEAD base=$ORIGINAL_BASE original=$ORIGINAL_HEAD p3904_original=${P3904_COMMITS[2]} security=$SECURITY administrative=$ADMIN pr_base=$BASE_COMMIT approval_comment=$COMMENT_ID"
)

# Only this exact branch receives the two independently checked Packet segments.
# Every unrelated work item continues through the unmodified normal guard.
if [ "${3:-}" = 'wi/P3-904-p3-003-security-correction' ]; then
  combined_guard "$@"
else
  normal_guard "$@"
fi
