WORK_ITEM: P2-902
TYPE: PROCESS
BRANCH: wi/P2-902-c1-packet-path-compatibility
BASE_SHA: 572bc7127a741d30c9245ca6ae04c0da014eee08
MIGRATIONS: none
ALLOWED_SCOPE:
- tools/p0/lib/controls.mjs
- tools/p0/tests/p0-controls.test.mjs
FORBIDDEN_SCOPE:
- .github/*
- .claude/*
- CLAUDE.md
- apps/*
- supabase/*
- governance/*
- package.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- .replit
- .replitignore
REAL_DATABASE_CONTACT: NO
PRODUCTION: NO

# ROSUNO — P2-902 Proposed C1 Packet-Path Compatibility PROCESS Packet

**Status:** Prospective public-safe Gate 0 candidate only. Work-item ID, exact Packet bytes and branch are PROPOSED, not yet accepted by independent Backup or selected/authorized by the owner. No Git publication, Claude execution, PR, merge, or validation waiver. If this candidate is adopted, the owner must separately authorize the corresponding controlled gates. A later base movement requires re-binding and re-audit, not silently reusing this body.

## 1. Authority and proven blocker

- **Controlling order:** current private LOCKED Rosuno product authority; expressly adopted bounded owner decisions; adopted UOM v1.7 with owner-adopted Cloud Builder C1 revision 5.1; a separately Backup-audited and owner-authorized work-item Packet; canonical code. This PROCESS item changes no product policy, locked text, UOM or C1.
- **Workflow contract:** C1 §C1.2 requires a first, owner-published, Packet-only commit at `docs/work-items/<ID>/PACKET.md`, byte-identically mirrored on the Builder fork. The installed `rosuno-guard` separately verifies the Packet and branch-specific authorized scope.
- **Verified base:** `NatthanPrevot/Rosuno` protected `main` and `RosunoBackup/Rosuno` `main` both `572bc7127a741d30c9245ca6ae04c0da014eee08`, tree `439971c0cbb7c717843519b254c7f9a593aa120d`. Four canonical required checks remain in force. Reconcile at every prospective gate; unexpected drift means STOP.
- **Specific defect:** `validateNeutralPaths()` in `tools/p0/lib/controls.mjs` admits predefined roots and current web-app files but rejects C1's exact Packet path. On the P2-005 Packet-only fork commit `3efddaf19842dd1bef55c623e4c085f8bfc32bd0`, Builder reported `p0:validate` exit 1 and `p0:test` 1157 pass / 10 fail. Those failures remained with the preserved seven-file implementation HEAD `4b18a0a760ce2a819ff9b86b704a7d9f4c7e3ba8`.
- **Preserved evidence:** P2-005 candidate is published on the Builder fork for preservation ONLY, remains BLOCKED / UNVALIDATED, and must not be rewritten, rebased, silently repaired, merged or represented as complete. This separate PROCESS work item does not authorize P2-005 continuation.

## 2. Exact corrective implementation

Modify only the two literal `ALLOWED_SCOPE` files above; the workflow's first, owner-published Packet-only commit is separately governed by C1 and is not an additional implementation path.

1. In `validateNeutralPaths()`, admit only C1-convention Packet files **when `state === WEB_APPLICATION_STATE`**. The narrow, anchored, case-sensitive candidate matcher is:

   ```js
   /^docs\/work-items\/[A-Z][A-Z0-9]*-[0-9]{3}\/PACKET\.md$/
   ```

   The identifier shape must match the installed `rosuno-guard` work-item identifier grammar. Keep the existing fail-closed path filtering for all other paths. Do not add an unrestricted `docs/`, `docs/**`, generic Markdown or wildcard exemption. Do not loosen control for `PRE_APPLICATION_STATE`.
2. Update only `tools/p0/tests/p0-controls.test.mjs` with focused regression tests. Existing tests, assertions and full historical coverage must remain operative.
3. Do not interpret an allowed path as authorization to create or change a Packet. The GitHub guard's owner-branch byte binding, first-commit-only rule, immutable Packet check, linear history, allowed/forbidden scopes, protected checks and independent review must remain unchanged.
4. No refactoring, new helpers except those indispensable to the exact testable change, dependency updates, generated state changes, scripts, CI settings, git hooks or guard edits. No rewrites of historical control evidence.

## 3. Required acceptance and negative tests

- In the **web-application state**, accept literal `docs/work-items/P2-005/PACKET.md` and the prospective PROCESS Packet path `docs/work-items/P2-902/PACKET.md`, alongside existing permitted repository paths.
- In the **pre-application state**, retain rejection of those Packet paths and all existing unexpected product paths.
- In the web-application state, reject near misses including: wrong case (`packet.md`, `Docs/`), misspelled segment, invalid work-item identifier, trailing slash, additional nested files (`docs/work-items/P2-005/NOTES.md`), sibling paths (`docs/other/...`), duplicate extensions (`PACKET.md.bak`), and any unrelated `docs/` content.
- Preserve rejection of unexpected root, deployment, `.github`, `.claude`, alternative package-manager and app paths; no relaxation of existing migration, secret, configuration, guard or historical-control invariants.
- Prove the P0 path validation and the full P0 test suite PASS with the correctly published PROCESS Packet present. Also prove strict rejection when an unauthorized `docs/` file is introduced in controlled deterministic test fixtures.
- Demonstrate no changes to the P2-005 preserved commit, approved Packet, fork history, canonical identity, schemas or remote environments. Do not claim P2-005 validation merely because the PROCESS branch passes.

## 4. Exact planned validation under a separate authorized Gate 1

Run on the verified disposable `rosuno-builder` fork session under C1 with the correct committed PROCESS Packet. Record actual Node and pnpm versions; the protected CI workflow separately pins Node 24 and pnpm 10.26.1. Do not alter cloud environment or dependency/configuration settings to mimic CI. A version difference is a reported limitation for Backup to assess; unexpected configuration drift requires STOP.

```bash
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run typecheck
pnpm run build
pnpm run p0:validate
pnpm run p0:test
pnpm run secrets:check
pnpm run dependency:check
bash .github/scripts/rosuno-guard.sh 572bc7127a741d30c9245ca6ae04c0da014eee08 HEAD wi/P2-902-c1-packet-path-compatibility refs/rosuno/approved
```

No real provider, external database, Supabase Staging/OLD/Production, configuration change, credential access or unrelated network contact is authorized. If a required check fails or the correction needs scope expansion, STOP and report rather than waive it.

## 5. Controlled publication and separate gates

- **Gate 0 NOW:** Independent Backup audits this exact public-safe candidate against original locked authority, adopted UOM v1.7, C1 rev 5.1, live repo and the proven incompatibility. Return PASS / CORRECTIONS / STOP with `PACKET_BODY_SHA256=<64-hex>` only after exact-byte approval. Owner must separately select the proposed PROCESS work item and authorize Gate 1.
- **Gate 1 ONLY AFTER AUTHORIZATION:** On fresh `main` preflight, owner creates `wi/P2-902-c1-packet-path-compatibility` and publishes only `docs/work-items/P2-902/PACKET.md` as its first non-merge commit; separately mirrors exact Packet bytes onto the same fork branch from the same base. Builder works within the two exact code/test paths, runs validations and guard, commits forward-only and publishes only to the fork.
- **Gate 2A:** Primary independently reviews the actual fork HEAD/diff/tests/guard; no ordinary correction outside these two code/test paths.
- **Gates 2B/3/4 separately:** Owner creates PR; all four exact-head GitHub required checks pass; independent Backup audits the PR HEAD; designated reviewer approves; owner separately authorizes a normal two-parent merge commit. No squash, rebase, force push, bypass or automatic database action.
- **History and P2-005 interaction:** Because protected `main` requires up-to-date branches and the C1 guard requires linear immutable Packet-first history, a PROCESS merge advancing `main` does **not** validate or automatically update old-base P2-005. A separately audited and owner-authorized new-base P2-005 continuation/restart will likely be necessary. Preserve original Packet and implementation SHAs as forensic/reusable review evidence; do not mutate them or presume reuse without a new decision.

## 6. STOP and evidence

STOP → REPORT → WAIT on unexpected remote refs, branch changes, failed exact Packet binding, unauthorized/untracked changes, security or CI regression, missing prerequisites, environment mismatch, or authority conflict. Report exact parent/HEAD/tree/Packet hashes; literal changed paths; test command/exit status and failing case; guard line; limitations; owner/fork main; any unresolved P2-005 implications. Preserve historical evidence unchanged.

**Non-executable proposal:** This document is for independent Backup Gate 0 audit only. It is not an owner authorization to create a branch, publish this Packet, start a Builder session, implement the control change, open a PR, merge, or mutate any database.
