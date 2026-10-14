#!/usr/bin/env bash
# rosuno-guard trust binding (cloud rev 2). Decides, from the GitHub event payload only, whether this run may produce a
# rosuno-guard result at all, and in which mode. Reads JSON as data; executes nothing from the PR.
# Usage: rosuno-guard-trust.sh <event.json> <open-prs.txt>
#   open-prs.txt: one line per OPEN pull request in the owner repository: "<number> <head-sha>"
# Required env: EXPECTED_REPO (owner repo, e.g. NatthanPrevot/Rosuno), EXPECTED_BASE (main),
#               BUILDER_FORK (e.g. RosunoBackup/Rosuno), OWNER_LOGIN (e.g. NatthanPrevot)
# Prints MODE=builder (PR from the authorized Builder fork, created by the owner: full guard must run) or
# MODE=owner (PR from an owner-repository branch, created by the owner: governed by UOM v1.7 alone). Exit 1 otherwise.
set -euo pipefail
fail(){ echo "::error::ROSUNO-GUARD TRUST: $*"; exit 1; }
EV="${1:?event.json}"; PRS="${2:?open-prs.txt}"
for v in EXPECTED_REPO EXPECTED_BASE BUILDER_FORK OWNER_LOGIN; do [ -n "${!v:-}" ] || fail "$v not set"; done
lc(){ printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
j(){ jq -r "$1 // \"\"" "$EV"; }
[ "$(j .pull_request.number)" != "" ] || fail "not a pull_request event"
PRN="$(j .pull_request.number)"; HEAD_SHA="$(j .pull_request.head.sha)"
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "head SHA missing or malformed"
[ "$(j .pull_request.state)" = open ] || fail "pull request is not open"
# 1. The run must be in the owner repository, against its default branch `main`.
[ "$(lc "$(j .repository.full_name)")" = "$(lc "$EXPECTED_REPO")" ] || fail "workflow is running in $(j .repository.full_name), not $EXPECTED_REPO"
[ "$(lc "$(j .pull_request.base.repo.full_name)")" = "$(lc "$EXPECTED_REPO")" ] || fail "PR base repository is $(j .pull_request.base.repo.full_name), not $EXPECTED_REPO"
[ "$(j .pull_request.base.ref)" = "$EXPECTED_BASE" ] || fail "PR base branch is '$(j .pull_request.base.ref)', not '$EXPECTED_BASE'"
[ "$(j .repository.default_branch)" = "$EXPECTED_BASE" ] || fail "repository default branch is '$(j .repository.default_branch)', not '$EXPECTED_BASE'"
# 2. PR creation is the owner's separately authorized Gate 2B action (UOM v1.7): the PR author must be the owner.
[ "$(lc "$(j .pull_request.user.login)")" = "$(lc "$OWNER_LOGIN")" ] || fail "PR was created by '$(j .pull_request.user.login)', not the owner $OWNER_LOGIN"
# 3. Exactly one open PR in the owner repository may carry this head SHA (commit statuses attach to a SHA, not to a PR).
N="$(awk -v s="$HEAD_SHA" '$2==s' "$PRS" | wc -l | tr -d ' ')"
[ "$N" = 1 ] || fail "$N open PRs carry head $HEAD_SHA (a guard result must not be shared across PRs)"
[ "$(awk -v s="$HEAD_SHA" '$2==s{print $1}' "$PRS")" = "$PRN" ] || fail "the open PR carrying head $HEAD_SHA is not #$PRN"
# 4. Head source: the authorized Builder fork, or the owner repository itself. Anything else is refused.
HR="$(lc "$(j .pull_request.head.repo.full_name)")"
if [ "$HR" = "$(lc "$BUILDER_FORK")" ]; then
  [ "$(j .pull_request.head.repo.fork)" = true ] || fail "head repository $HR is not a fork"
  echo "MODE=builder"
elif [ "$HR" = "$(lc "$EXPECTED_REPO")" ]; then
  echo "MODE=owner"
else
  fail "head repository '${HR:-<deleted or unknown>}' is not the authorized Builder fork $BUILDER_FORK"
fi
