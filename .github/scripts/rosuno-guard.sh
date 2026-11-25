#!/usr/bin/env bash
# rosuno-guard v5 (P2-927; v4 P2-920, v3 P2-919): merge-boundary check posted as the required status "rosuno-guard".
# Reads Git objects only; executes nothing from the PR. The trusted runner supplies every input.
#
# Usage: rosuno-guard.sh <base> <head> <head-branch> <owner-ref>
#   <base>          current owner `main` tip, fetched directly by the trusted runner (never PR metadata)
#   <head>          PR head commit
#   <head-branch>   PR head branch. It selects the route and is only a lookup hint, never an authorization:
#                     wi/<ID>[-slug]      Packet route (the v4 rules, unchanged)
#                     grant/<ID>/<slug>   standing-grant route (P2-927); refused until the owner activates it
#   <owner-ref>     a ref of the OWNER repository, fetched by the trusted runner. Only the owner can push there.
#                     Packet route: the owner branch with the same name, so a byte-identical Packet proves the Packet
#                     is the owner-adopted one (revisions are ordinary forward-only owner commits on that branch).
#                     Grant route: the owner grant-record branch holding .github/rosuno-grants/activation.json and
#                     .github/rosuno-grants/<ID>.json. Nothing in the PR can authorize the PR.
# Grant route environment, set by the trusted runner (never by the PR): EXPECTED_REPO, EXPECTED_BASE, BUILDER_FORK,
#   OWNER_LOGIN, ROSUNO_PR_AUTHOR, ROSUNO_HEAD_REPO; optional ROSUNO_NOW (YYYY-MM-DDTHH:MM:SSZ, default the clock).
#
# Rules shared by both routes (UOM v2.0 §§5, 9, 14 / C1 rev6.0 §C1.3; P2-927):
#   R0  up to date: <base> is an ancestor of <head>, so the checked net diff is exactly what lands on main.
#   R4  migrations on main are immutable; a new one needs route authorization, a canonical name and a timestamp
#       after every migration on main, and may not be registered as applied before merge.
#   R5  no new case-insensitive path collision or case-only alias against main.
#   R6  no commit in base..head contains a credential-like or private-authority path (public history is permanent).
#   Every changed path is a regular file; no private authority, submodule or credential file.
# Packet route (v4):
#   R1  branch is wi/<ID>[-slug].
#   R2  docs/work-items/<ID>/PACKET.md at head is byte-identical to the owner-approved Packet; header fields
#       exactly once, WORK_ITEM/BRANCH bound to the branch. BASE_SHA is provenance only. A Packet already on main
#       (merged work item) authorizes in-scope corrections when unchanged or when the head carries the owner's
#       revision from the owner branch (v4); the net diff is still judged against its scope.
#   R3  every path in the net diff base..head is inside ALLOWED_SCOPE and outside FORBIDDEN_SCOPE (FORBIDDEN wins,
#       case-insensitive); PROCESS-only control paths need TYPE: PROCESS; other work-item Packets only as literal
#       carried records.
# Grant route (P2-927, adopted Governance Modernization package v1.1; default inactive):
#   G1  branch is grant/<ID>/<slug>; <ID> only names the owner record to read. Many branches may share one grant.
#   G2  the owner activation record is valid and active, includes capability E, names the package digest registered
#       on <base> as GOVERNANCE-MODERNIZATION-V1.1 and a control commit that is already on <base>.
#   G3  exactly one owner grant record for <ID>: valid, profile DEV, active, issued_at <= now < expires_at; its
#       repository, base, source fork and owner equal the trusted runner's; the PR author is one of its PR authors,
#       and an author other than the owner also needs activated capability P. Malformed, duplicated, case-aliased,
#       unsupported or unknown records fail closed.
#   G4  effects on the net diff: control paths (CI, guard, validators and P0 tooling, Builder and tool configuration,
#       process records and Packets, package-manager settings, Supabase configuration and seeds, governance authority)
#       are never changed under a grant; grant exclusions win; package manifests may change only their dependency
#       fields, and they and the lockfile need effect `dependencies`; new migrations need effect `schema`; other
#       paths need effect `code`; governance records may record facts but never a persistent application or release,
#       and existing evidence files are immutable.
# History shape is not restricted: integration merges of main are normal; the net diff decides.
set -euo pipefail
export LC_ALL=C GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0
fail(){ echo "::error::ROSUNO-GUARD: $*"; exit 1; }
ERR=0; e(){ echo "::error::ROSUNO-GUARD: $*"; ERR=1; }
lc(){ printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
sha(){ { command -v shasum >/dev/null && shasum -a 256 || sha256sum; } | cut -d' ' -f1; }

BASE="$(git rev-parse --verify -q "${1:?base}^{commit}")" || fail "base commit not found"
HEAD="$(git rev-parse --verify -q "${2:?head}^{commit}")" || fail "head commit not found"
BRANCH="${3:?branch}"
APPROVED="$(git rev-parse --verify -q "${4:?approved-ref}^{commit}")" || fail "owner approval branch for $BRANCH not found"
ROUTE=packet; [[ "$BRANCH" == grant/* ]] && ROUTE=grant

if [ "$ROUTE" = packet ]; then
  # R1
  [[ "$BRANCH" =~ ^wi/([A-Z][A-Z0-9]*-[0-9]{3})(-[a-z0-9-]+)?$ ]] || fail "branch '$BRANCH' is not wi/<ID>[-slug]"
  ID="${BASH_REMATCH[1]}"; PK="docs/work-items/$ID/PACKET.md"
else
  # G1
  [[ "$BRANCH" =~ ^grant/([A-Z][A-Z0-9]*-[0-9]{3})/[a-z0-9][a-z0-9-]{0,62}$ ]] || fail "branch '$BRANCH' is not grant/<ID>/<slug>"
  ID="${BASH_REMATCH[1]}"; PK=""
fi

# R0
git merge-base --is-ancestor "$BASE" "$HEAD" || fail "head does not contain current main $BASE; merge main into the branch (never rebase)"

if [ "$ROUTE" = packet ]; then
# R2: approval binding
[ "$(git ls-tree "$HEAD" -- "$PK" | cut -d' ' -f1-2)" = "100644 blob" ] || fail "Packet $PK missing at head or not a regular file"
MERGED=0; git cat-file -e "$BASE:$PK" 2>/dev/null && MERGED=1
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
fi
matches(){ local p="$1" g; while IFS= read -r g; do [ -n "$g" ] || continue; case "$p" in $g) return 0;; esac; done <<<"$2"; return 1; }
literal(){ grep -Fxq -- "$1" <<<"$ALLOWED"; }

if [ "$ROUTE" = grant ]; then
# G2/G3: authorization comes only from the owner records at <owner-ref>, validated against the trusted runner's values.
for v in EXPECTED_REPO EXPECTED_BASE BUILDER_FORK OWNER_LOGIN ROSUNO_PR_AUTHOR ROSUNO_HEAD_REPO; do
  [ -n "${!v:-}" ] || fail "grant route needs $v from the trusted runner"
done
NOW="${ROSUNO_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
JQDEFS='
  def ts: type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
    and ((try (fromdateiso8601 | todateiso8601) catch "") == .);
  def text($max): type == "string" and length >= 1 and length <= $max and (explode | all(.[]; . >= 32 and . != 127));
  def login: type == "string" and test("^[A-Za-z0-9-]{1,39}$");
  def repo: type == "string" and test("^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$");
  def ieq($x): type == "string" and ascii_downcase == ($x | ascii_downcase);
  def fields($k): if (keys | sort) == ($k | sort) then empty
    else "fields must be exactly \($k | join(", ")) (missing: \(($k - keys) | join(", ")); unknown: \((keys - $k) | join(", ")))" end;'
jq -en --arg t "$NOW" "$JQDEFS"' $t | ts' >/dev/null || fail "ROSUNO_NOW '$NOW' is not YYYY-MM-DDTHH:MM:SSZ"
[[ "$ROSUNO_PR_AUTHOR" =~ ^[A-Za-z0-9-]{1,39}$ ]] || fail "PR author '$ROSUNO_PR_AUTHOR' is not a valid login"
[ "$(lc "$ROSUNO_HEAD_REPO")" = "$(lc "$BUILDER_FORK")" ] || fail "PR head repository '$ROSUNO_HEAD_REPO' is not the authorized Builder fork $BUILDER_FORK"
REGD="$(git cat-file blob "$BASE:governance/authority-references.json" 2>/dev/null | jq -r '
  [.references[]? | select(.authority_id == "GOVERNANCE-MODERNIZATION-V1.1") | .integrity]
  | if length == 1 then .[0] else "" end' 2>/dev/null || true)"
[[ "$REGD" =~ ^sha256:([0-9a-f]{64})$ ]] || fail "main registers no single GOVERNANCE-MODERNIZATION-V1.1 digest (governance/authority-references.json); the grant route cannot be activated"
DIGEST="${BASH_REMATCH[1]}"

GDIR=.github/rosuno-grants
OWNER_TREE="$(git ls-tree -r -z --name-only "$APPROVED" | tr '\0' '\n')"
# Loads one owner record into REC (compact JSON) and REC_SHA (SHA-256 of its exact bytes), or fails closed. The record
# must exist exactly once (no case alias), be a regular file of at most 64 KiB and hold exactly one JSON object without
# duplicate keys. Runs in the main shell so that a refusal is never lost inside a command substitution.
owner_record(){
  local p="$1" what="$2" n ent oid dup
  n="$(grep -Fxic -- "$p" <<<"$OWNER_TREE" || true)"
  [ "$n" = 1 ] || fail "$what: expected exactly one owner record $p on the owner grant branch, found $n"
  ent="$(git ls-tree "$APPROVED" -- "$p")"
  [[ "$ent" =~ ^100644\ blob\ ([0-9a-f]{40})$'\t' ]] || fail "$what: owner record $p is missing or not a regular file"
  oid="${BASH_REMATCH[1]}"
  [ "$(git cat-file -s "$oid")" -le 65536 ] || fail "$what: owner record $p is larger than 64 KiB"
  git cat-file blob "$oid" | jq -se 'length == 1 and (.[0] | type) == "object"' >/dev/null 2>&1 \
    || fail "$what: owner record $p is not exactly one JSON object"
  dup="$(git cat-file blob "$oid" | jq -c --stream 'select(length == 2) | .[0]' | sort | uniq -d | head -1)" \
    || fail "$what: owner record $p could not be read"
  [ -z "$dup" ] || fail "$what: owner record $p contains duplicate JSON keys ($dup)"
  REC="$(git cat-file blob "$oid" | jq -c .)" || fail "$what: owner record $p could not be read"
  REC_SHA="$(git cat-file blob "$oid" | sha)"
}
# Reports every refusal message for one record and fails closed when there is any.
report(){ local m found=0; while IFS= read -r m; do [ -n "$m" ] || continue; e "$1: $m"; found=1; done <<<"$2"; [ "$found" = 0 ] || fail "$1 refused"; }

owner_record "$GDIR/activation.json" activation; ACT="$REC"; ACT_SHA="$REC_SHA"
MSGS="$(jq -r --arg repo "$EXPECTED_REPO" --arg owner "$OWNER_LOGIN" --arg digest "$DIGEST" --arg now "$NOW" "$JQDEFS"'
  fields(["schema", "repository", "owner_login", "adopted_package_sha256", "control_commit", "decision_ref",
          "capabilities", "status", "activated_at"])
  // (
    if .schema != "rosuno-activation/v1" then "unsupported schema \(.schema | tojson) (expected \"rosuno-activation/v1\")"
    else
      (if .repository | ieq($repo) then empty else "is for repository \(.repository | tojson), not \($repo)" end),
      (if .owner_login | ieq($owner) then empty else "owner_login \(.owner_login | tojson) is not the owner \($owner)" end),
      (if .adopted_package_sha256 == $digest then empty
       else "adopted_package_sha256 does not equal the GOVERNANCE-MODERNIZATION-V1.1 digest registered on main" end),
      (if .control_commit | type == "string" and test("^[0-9a-f]{40}$") then empty else "control_commit must be a 40-hex commit" end),
      (if .decision_ref | text(500) then empty else "decision_ref must be 1-500 characters without control characters" end),
      (if .capabilities | type == "array" and length >= 1 and (unique | length) == length and all(.[]; . == "E" or . == "P")
       then (if .capabilities | index("E") then empty else "capability E (ordinary engineering) is not active" end)
       else "capabilities must be a non-empty set of E and P (no other capability is supported by this guard)" end),
      (if .status == "active" then empty elif .status == "revoked" then "the owner revoked the activation"
       else "status must be active or revoked" end),
      (if .activated_at | ts then (if (.activated_at | fromdateiso8601) <= ($now | fromdateiso8601) then empty
         else "not yet effective (activated_at \(.activated_at))" end)
       else "activated_at must be YYYY-MM-DDTHH:MM:SSZ" end)
    end)' <<<"$ACT")" || fail "activation: owner record could not be evaluated"
report activation "$MSGS"
CTRL="$(jq -r .control_commit <<<"$ACT")"
{ git cat-file -e "$CTRL^{commit}" 2>/dev/null && git merge-base --is-ancestor "$CTRL" "$BASE"; } \
  || fail "activation: control commit $CTRL is not on main"
CAPS=" $(jq -r '.capabilities | join(" ")' <<<"$ACT") "

owner_record "$GDIR/$ID.json" "grant $ID"; GRANT="$REC"; GRANT_SHA="$REC_SHA"
MSGS="$(jq -r --arg id "$ID" --arg repo "$EXPECTED_REPO" --arg base "$EXPECTED_BASE" --arg fork "$BUILDER_FORK" \
    --arg owner "$OWNER_LOGIN" --arg author "$ROSUNO_PR_AUTHOR" --arg now "$NOW" "$JQDEFS"'
  fields(["schema", "grant_id", "profile", "status", "repository", "base", "source_repository", "owner_login",
          "pr_authors", "purpose", "decision_ref", "effects", "exclusions", "issued_at", "expires_at"])
  // (
    if .schema != "rosuno-grant/v1" then "unsupported schema \(.schema | tojson) (expected \"rosuno-grant/v1\")"
    elif .grant_id != $id then "grant_id \(.grant_id | tojson) does not match the record name \($id)"
    elif .profile != "DEV" then "profile \(.profile | tojson) is not supported by the grant route (DEV only; control changes use a TYPE: PROCESS Packet)"
    elif .status == "revoked" then "the owner revoked this grant"
    elif .status != "active" then "status must be active or revoked"
    else
      (if .repository | ieq($repo) then empty else "is for repository \(.repository | tojson), not \($repo)" end),
      (if .base == $base then empty else "is for base \(.base | tojson), not \($base)" end),
      (if .source_repository | ieq($fork) then empty else "source_repository \(.source_repository | tojson) is not the Builder fork \($fork)" end),
      (if .owner_login | ieq($owner) then empty else "owner_login \(.owner_login | tojson) is not the owner \($owner)" end),
      (if .pr_authors | type == "array" and length >= 1 and length <= 20 and all(.[]; login)
            and ((map(ascii_downcase) | unique | length) == length)
       then (if any(.pr_authors[]; ieq($author)) then empty else "PR author \($author) is not one of the grant PR authors" end)
       else "pr_authors must be 1-20 distinct GitHub logins" end),
      (if .purpose | text(500) then empty else "purpose must be 1-500 characters without control characters" end),
      (if .decision_ref | text(500) then empty else "decision_ref must be 1-500 characters without control characters" end),
      (if .effects | type == "array" and length >= 1 and (unique | length) == length
            and all(.[]; . == "code" or . == "schema" or . == "dependencies") then empty
       else "effects must be a non-empty set of code, schema and dependencies" end),
      (if .exclusions | type == "array" and length <= 100 and all(.[]; text(200))
            and ((map(ascii_downcase) | unique | length) == length) then empty
       else "exclusions must be at most 100 distinct path patterns of 1-200 characters" end),
      (if (.issued_at | ts) and (.expires_at | ts) then
         (if (.issued_at | fromdateiso8601) < (.expires_at | fromdateiso8601) then empty else "expires_at must follow issued_at" end),
         (if (.issued_at | fromdateiso8601) <= ($now | fromdateiso8601) then empty else "not yet effective (issued_at \(.issued_at))" end),
         (if ($now | fromdateiso8601) < (.expires_at | fromdateiso8601) then empty else "expired at \(.expires_at)" end)
       else "issued_at and expires_at must be YYYY-MM-DDTHH:MM:SSZ" end)
    end)' <<<"$GRANT")" || fail "grant $ID: owner record could not be evaluated"
report "grant $ID" "$MSGS"
if [ "$(lc "$ROSUNO_PR_AUTHOR")" != "$(lc "$OWNER_LOGIN")" ] && [[ "$CAPS" != *" P "* ]]; then
  fail "grant $ID: PR author $ROSUNO_PR_AUTHOR is not the owner, and delegated PR authorship (capability P) is not active"
fi
EFFECTS=" $(jq -r '.effects | join(" ")' <<<"$GRANT") "
EXCL="$(jq -r '.exclusions[]' <<<"$GRANT")"
has_effect(){ [[ "$EFFECTS" == *" $1 "* ]]; }
fi

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
# Grant route: paths a standing grant never changes. A superset of process_only apart from the two package manifests
# (dependency fields only, below), adding every Packet, all P0 tooling and tests, package-manager settings and
# attribute files at any depth, other package manifests and lockfiles, and governance authority (governance paths are
# decided in grant_path).
grant_control(){
  case "$1" in
    package.json|apps/web/package.json|pnpm-lock.yaml) return 1;;
    .github/*|.claude/*|*/.claude/*|claude.md|*/claude.md|claude.local.md|*/claude.local.md) return 0;;
    agents.md|*/agents.md|.mcp.json|*/.mcp.json|docs/process/*|docs/work-items/*) return 0;;
    .gitattributes|*/.gitattributes|.npmrc|*/.npmrc|pnpm-workspace.yaml|*/pnpm-workspace.yaml) return 0;;
    .pnpmfile.cjs|*/.pnpmfile.cjs|*/package.json|*/pnpm-lock.yaml|.replit|.replitignore|tools/p0/*) return 0;;
    supabase/config.toml|supabase/seed*|supabase/seeds/*) return 0;;
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
# R4 for one supabase/migrations path. $4 is "yes" when the route authorizes new migrations; $5 is the refusal otherwise.
migration_rules(){
  local P="$1" L="$2" ST="$3"
  if [[ "$P" != supabase/migrations/* ]]; then e "$P: migrations path with non-canonical case"
  elif grep -Fxq -- "$L" <<<"$BASEMIGS"; then e "migration $P is on main and immutable (status $ST); add a new forward-only migration instead"
  elif [ "$ST" != A ]; then e "migration $P: unexpected status $ST"
  elif [ "$4" != yes ]; then e "$5"
  elif [[ ! "$P" =~ ^supabase/migrations/([0-9]{14})_[a-z0-9_]+\.sql$ ]]; then e "new migration $P must be named supabase/migrations/<14-digit UTC>_<lower_snake>.sql"
  elif [ -n "$MAXTS" ] && [[ ! "${BASH_REMATCH[1]}" > "$MAXTS" ]]; then e "new migration $P must sort after the newest migration on main ($MAXTS)"
  elif grep -Fxq -- "$P" <<<"$APPLIED"; then e "migration $P is registered as applied before merge (persistent application only from main)"
  fi
}

# R3/R4 for one path on the Packet route (the v4 rules).
packet_path(){
  local P="$1" L="$2" ST="$3" DM="$4"
  if [ "$L" = "$(lc "$PK")" ]; then
    { [ "$P" = "$PK" ] && { [ "$ST" = A ] || { [ "$MERGED" = 1 ] && [ "$ST" = M ]; }; }; } || e "$P case-aliases or alters the Packet"
    return
  fi
  case "$L" in
    docs/work-items/*)
      # Another work item's Packet may only be carried as a new, literally listed historical record
      # (e.g. P3-003's Packet inside the combined P3-904 history). Merged Packets stay immutable.
      if [[ "$P" =~ ^docs/work-items/[A-Z][A-Z0-9]*-[0-9]{3}/PACKET\.md$ ]] && [ "$ST" = A ] && [ "$DM" = 100644 ] && literal "$P"; then
        return
      fi
      e "$P ($ST) is another work item's record; only a new Packet listed literally in ALLOWED_SCOPE may be carried"; return;;
    rosuno-authority/*) e "$P: private authority documents never enter the repository"; return;;
    .gitmodules) e "$P: submodules are not allowed"; return;;
  esac
  credential_like "$L" && e "$P looks like a secret or credential file (never commit to a public repository)"
  { matches "$P" "$FORBIDDEN" || matches "$L" "$(lc "$FORBIDDEN")"; } && e "$P ($ST) is inside FORBIDDEN_SCOPE"
  matches "$P" "$ALLOWED" || e "$P ($ST) is outside ALLOWED_SCOPE"
  process_only "$L" && [ "$TYPE" != PROCESS ] && e "$P is a control path; it requires a TYPE: PROCESS Packet"
  case "$L" in
    supabase/migrations/*)
      migration_rules "$P" "$L" "$ST" "$([ "$MIGS" = "new allowed" ] && echo yes)" "new migration $P but the Packet says MIGRATIONS: $MIGS";;
  esac
}

# G4 for one path on the grant route.
grant_path(){
  local P="$1" L="$2" ST="$3" b h
  case "$L" in
    rosuno-authority/*) e "$P: private authority documents never enter the repository"; return;;
    .gitmodules) e "$P: submodules are not allowed"; return;;
  esac
  credential_like "$L" && e "$P looks like a secret or credential file (never commit to a public repository)"
  if { matches "$P" "$EXCL" || matches "$L" "$(lc "$EXCL")"; }; then e "$P ($ST) is excluded by grant $ID"; return; fi
  if grant_control "$L"; then
    e "$P ($ST) is a control path; a standing grant never changes it (control changes use a TYPE: PROCESS Packet)"; return
  fi
  case "$L" in
    supabase/migrations/*)
      migration_rules "$P" "$L" "$ST" "$(has_effect schema && echo yes)" "new migration $P but grant $ID does not include effect schema";;
    package.json|apps/web/package.json)
      if ! has_effect dependencies; then e "$P ($ST) is a package manifest; grant $ID does not include effect dependencies"
      elif [ "$ST" != M ] || [ "$P" != "$L" ]; then e "$P ($ST): a standing grant may only modify an existing package manifest"
      elif ! b="$(git cat-file blob "$BASE:$P" | jq -cS 'del(.dependencies, .devDependencies)' 2>/dev/null)" \
        || ! h="$(git cat-file blob "$HEAD:$P" | jq -cS 'del(.dependencies, .devDependencies)' 2>/dev/null)" \
        || [ -n "$(git cat-file blob "$HEAD:$P" | jq -c --stream 'select(length == 2) | .[0]' 2>/dev/null | sort | uniq -d | head -1)" ] \
        || [ "$(git cat-file blob "$HEAD:$P" | jq -r '[.dependencies // {}, .devDependencies // {}] | all(type == "object" and all(.[]; type == "string"))' 2>/dev/null)" != true ]; then
        e "$P at head is not one JSON object with string-valued dependencies and no duplicate keys"
      elif [ "$b" != "$h" ]; then
        e "$P: a standing grant may change only dependencies and devDependencies (scripts and every other field are control inputs)"
      fi;;
    pnpm-lock.yaml)
      if ! has_effect dependencies; then e "$P ($ST) is the lockfile; grant $ID does not include effect dependencies"
      elif [ "$ST" != M ] || [ "$P" != "$L" ]; then e "$P ($ST): a standing grant may only modify the existing lockfile"
      fi;;
    governance/*)
      case "$L" in
        governance/decision-log.json|governance/work-items/index.json|governance/readiness/*|"$REG") ;;
        governance/evidence/*) [ "$ST" = A ] || e "$P ($ST): existing evidence is immutable; add a new evidence file instead";;
        *) e "$P ($ST) is a governance control or persistent-application record; a standing grant never changes it";;
      esac;;
    *) has_effect code || e "$P ($ST) needs effect code, which grant $ID does not include";;
  esac
}

# R3/R4/G4: every changed path in the net diff (raw, NUL-delimited, no rename pairing).
while IFS= read -r -d '' META && IFS= read -r -d '' P; do
  read -r SM DM _ _ ST <<<"${META#:}"
  for m in "$SM" "$DM"; do case "$m" in 000000|100644|100755) ;; *) e "[final diff] $P has git mode $m (symlink/submodule/special objects are not allowed)";; esac; done
  L="$(lc "$P")"
  if [ "$ROUTE" = packet ]; then packet_path "$P" "$L" "$ST" "$DM"; else grant_path "$P" "$L" "$ST"; fi
done < <(git diff --raw -z --no-renames --no-abbrev "$BASE" "$HEAD")

# G4: under a grant the migration register may add unapplied rows but never records, changes or removes a persistent
# application (applied_environment, reviewed, release_refs). Recording a Staging application is not a DEV effect.
if [ "$ROUTE" = grant ] && ! git diff --quiet "$BASE" "$HEAD" -- "$REG"; then
  rows(){ git cat-file blob "$1:$REG" 2>/dev/null | jq -c '[.migrations[]? | {p: (.artifact_path // "" | tostring),
    a: (.applied_environment // "none"), r: (.reviewed // false), rel: (.release_refs // [])}]' 2>/dev/null || echo invalid; }
  RB="$(rows "$BASE")"; RH="$(rows "$HEAD")"
  if [ "$RH" = invalid ] || [ "$RB" = invalid ]; then e "$REG is not valid JSON"
  else
    while IFS= read -r m; do [ -z "$m" ] || e "$REG: $m"; done < <(jq -rn --argjson b "$RB" --argjson h "$RH" '
      ($b | map({key: .p, value: .}) | from_entries) as $bm | ($h | map({key: .p, value: .}) | from_entries) as $hm
      | ($b[] | select($hm[.p] == null) | "a standing grant may not remove the registered migration \(.p)"),
        ($h[] | . as $r | $bm[$r.p] as $o
         | if $o == null then select($r.a != "none" or $r.r != false or $r.rel != [])
             | "a standing grant may register \($r.p) only as unapplied and unreviewed (applied_environment none, reviewed false, no release_refs)"
           else select($r.a != $o.a or $r.r != $o.r or $r.rel != $o.rel)
             | "a standing grant may not record or change a persistent application of \($r.p)" end)')
  fi
fi

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
if [ "$ROUTE" = packet ]; then
  PSHA="$(git cat-file blob "$HB" | sha)"
  echo "ROSUNO-GUARD PASS work_item=$ID type=$TYPE packet_sha256=$PSHA base=$BASE head=$HEAD approved=$APPROVED"
else
  echo "ROSUNO-GUARD PASS route=grant grant=$ID profile=DEV grant_sha256=$GRANT_SHA activation_sha256=$ACT_SHA base=$BASE head=$HEAD owner_ref=$APPROVED"
fi
