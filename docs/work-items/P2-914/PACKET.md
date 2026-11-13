WORK_ITEM: P2-914
TYPE: PROCESS
BRANCH: wi/P2-914-p3-003-p3-904-guard-accommodation
BASE_SHA: 8449593d0baccac377f4884ede522d00fa1cc997
MIGRATIONS: none
ALLOWED_SCOPE:
- .github/scripts/rosuno-guard.sh
- .github/workflows/rosuno-guard.yml
- tools/p0/tests/p0-rosuno-guard-combined-history.test.mjs
FORBIDDEN_SCOPE:
- rosuno-authority/*
- governance/*
- docs/process/*
- docs/work-items/*
- supabase/*
- apps/*
- .claude/*
- .github/scripts/rosuno-guard-trust.sh
- .github/scripts/tests/*
- .github/workflows/p0-controls.yml
- CLAUDE.md
- .replit
- .replitignore
- package.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- .env
- .env.*
- .gitmodules

# ROSUNO P2-914 — One-Time Protected Integration Accommodation

**STATUS: GATE 0 REVIEW CANDIDATE ONLY — NOT ADOPTED OR EXECUTABLE**

The Packet-only first commit adding `docs/work-items/P2-914/PACKET.md` is governed by the existing Packet-first procedure. That file is not an authorized subsequent implementation change. Its entry in FORBIDDEN_SCOPE intentionally prevents later Packet edits. Unlisted paths remain disallowed by the exact ALLOWED_SCOPE; FORBIDDEN_SCOPE overrides ALLOWED_SCOPE. The three explicitly allowed implementation files are not covered by any forbidden pattern. No new dependency or configuration change is authorized.

## 1. Authority and purpose

Controlling authority: the eleven authenticated current LOCKED Rosuno originals; adopted UOM v1.7.8 (SHA-256 `3754f678252620fe55dbe2264792ecc94a317dcd6da71308531bdd0dabefbeb0`); adopted C1 rev5.9 (SHA-256 `34f809e2b28b42b7d1828e524605c3cac092af873f29ef889f8eec5f7e38ab82`); the original adopted P3-003 Packet; and the P3-904 correction Packet only after separate Independent Backup PASS and owner adoption. Apply existing Packet-first, owner approval binding, CI, human review, and security gates. Do not change locked authority.

Purpose: resolve the demonstrated conflict between the mandatory security-acceptance gate and the existing single-Packet Git guard without merging the uncorrected P3-003 code, rewriting history, or weakening protections. Permit exactly one fully corrected combined P3-003/P3-904 implementation PR after all P3-904 security requirements are demonstrated. This PROCESS work item changes only the trusted guard, its narrowly necessary workflow fetch, and one regression-test file.

## 2. Immutable P3-003 history

Owner repository: `NatthanPrevot/Rosuno`. Builder repository: `RosunoBackup/Rosuno`.

Original base: `8449593d0baccac377f4884ede522d00fa1cc997`.

Owner P3-003 Packet-only commit: `ae9c644967c702972f8c14a964d78e4bb4c2a83b`.

Builder P3-003 Packet-only commit: `405956f9f4a14432a12fc7eacb10e33c0278e39d`.

Original Packet blob: `c394078a7440d5e48bce81c33d7a581d951d1c74`.

Eight original implementation commits in exact parent order:

1. `77b29508b1ed9c5a8e79c352be04016d956e30d4`
2. `ac9c5feba15a4f2453ebbca907ecdac372a55f32`
3. `4e548818d38f86f18fadcc3072293be58493d679`
4. `9cedce919b05288800574d0c96049415c892926d`
5. `4425c5f5f3be59bdb08b14c20eb4afa5f6701893`
6. `ba6fc7888ea842b89d70e44cee62203af68c52fd`
7. `4d22a2b2c8916e01da24227e7f5b1235b3de1ebe`
8. `b3fda55231625d440f3aa536e36c30e1dbb5b94a`

Final original tree: `c9823d197923c17c146bdc10b0ec47a1cc8564c0`. Verify each original commit's exact SHA and immediate parent; no rebase, duplicate, amendment, cherry-pick, squash, merge, or rewrite of original history.

## 3. Exact one-time guard accommodation

### 3.1 Fail-closed exception selection

Retain the normal guard path unmodified for all unrelated work items. Select the exceptional path only for head branch `wi/P3-904-p3-003-security-correction`, targeting the owner repository `main` from a trusted source under the existing PR author, origin, and single-open-PR trust bindings. Require the exact immutable P3-003 base, Packet boundary, eight-commit ancestry, and original tree above; require an independently approved P3-904 Packet. Never select by generic prefix, Packet text alone, or a caller-controlled environment switch. Any mismatch denies.

### 3.2 Original Packet boundary

Validate that the P3-003 Builder Packet-only commit is the first commit after its specified base and changes only `docs/work-items/P3-003/PACKET.md`, with the exact approved original Packet blob. Independently authenticate the original owner Packet from the pinned owner approval reference. Reapply the original Packet's exact ALLOWED_SCOPE, FORBIDDEN_SCOPE, and `MIGRATIONS: none` to every P3-003 implementation commit. Do not permit the correction Packet to authorize retroactive original changes.

### 3.3 Correction Packet boundary

The P3-904 Packet-only commit must be the immediate child, and only child on that chain, of `b3fda55231625d440f3aa536e36c30e1dbb5b94a`. It must add only `docs/work-items/P3-904/PACKET.md`. Verify its exact owner-approved Packet blob, metadata, branch, base, and immutable subsequent contents. Require at least one subsequent correction implementation commit and the single forward-only migration specified by its adopted Packet. Missing, empty, incomplete, reordered, or otherwise unauthorized correction history fails. The adopted P3-904 Packet, not this PROCESS Packet, determines correction application scope.

### 3.4 Per-commit checks

Keep each segment's independently approved allowlist, denylist, migration restrictions, protected-file constraints, credential checks, file-mode checks, case-collision checks, linear history, and historical migration immutability. Check every commit individually and the final branch diff. Reject merge commits, unexpected intermediate changes, Packet modifications, migration rewrites, and unauthorized files. No new success shortcut or synthetic green status.

### 3.5 Security acceptance remains separate and mandatory

A structurally passing Git guard cannot prove R1, R2, or atomic audit integrity. The original P3-003 HEAD alone must fail the special-path requirements. A Packet-only P3-904 branch must fail. Before authorization for the combined PR, the complete corrected application must pass the adopted P3-904 focused real-PostgreSQL authorization, concurrency, rollback, direct-write-denial, and P3-001/P3-002 regression checks, plus Independent Backup exact-head security PASS. Required CI and designated human review remain mandatory at the PR; only the owner may separately authorize the normal two-parent merge. No database deployment or production activation is implied.

## 4. Verified trusted workflow dependency

The existing `.github/workflows/rosuno-guard.yml` fetches the owner approval branch corresponding to the PR head, not also the original P3-003 approval branch. Under the exceptional path only, add the minimal read-only fetch of the original P3-003 owner approval reference, pinned to `ae9c644967c702972f8c14a964d78e4bb4c2a83b` and the original Packet blob `c394078a7440d5e48bce81c33d7a581d951d1c74`. Missing or changed approval fails closed.

Do not change event triggers, required status context, token permissions, trust-binding script, PR source restrictions, normal-path behavior, or untrusted-code execution controls. The trusted guard must still come from protected owner `main`, and untrusted PR code must not execute in the trusted workflow. This single additional owner approval fetch is the only verified reason for including `.github/workflows/rosuno-guard.yml`.

## 5. P3-904 owner-first Packet relationship

Preserve original history and both independent owner Packet approvals. Proposed P3-904 Builder correction branch begins at original Builder P3-003 HEAD `b3fda55231625d440f3aa536e36c30e1dbb5b94a`; its first commit adds only its owner-approved Packet. The owner P3-904 approval branch may originate from independently verified owner `main`; its Packet file must be byte-identical to the Builder correction Packet. The exceptional guard checks the deliberately different ancestry and two independent Packet blobs. This is a proposed one-time procedural accommodation requiring explicit owner adoption; it does not silently waive ordinary identical-parent mirroring for unrelated work. If current locked authority or adopted procedure prohibits it, STOP instead of implementing it.

## 6. Focused negative regression tests

Add exactly `tools/p0/tests/p0-rosuno-guard-combined-history.test.mjs`, discovered by the existing `p0:test` script. Use disposable local Git repositories and the actual guard script; no hosted system or seeded production actors.

The special guard must reject each of the following: (1) uncorrected P3-003 HEAD; (2) missing P3-904 Packet; (3) wrong correction Packet parent; (4) mismatched correction owner approval; (5) missing original owner approval; (6) wrong original Packet blob; (7) modified original SHA; (8) missing original commit; (9) reordered originals; (10) duplicate/cherry-picked originals; (11) unauthorized P3-003 migration; (12) P3-003 out-of-scope edit; (13) unauthorized P3-904 migration; (14) historical migration edit; (15) P3-904 out-of-scope edit; (16) modification of either Packet after creation; (17) intermediate unapproved commit; (18) nonlinear or merge history; (19) Packet-only correction; (20) attempted exception on another branch.

Preserve ordinary-path negative regression checks: missing/late Packet, wrong base, wrong owner approval, forbidden files, secrets, symlink/mode violations, case collisions, historical migration rewrites, invalid branch ID, and disallowed changes. A normal compliant work item still passes. Verify exception fetch is conditional, missing approval fails, existing trust binding remains active, and required checks and approval are not bypassed.

Include a structurally valid yet deliberately security-defective combined-history fixture: it must not be described as security-accepted or merge-eligible merely because Git history/scope validation succeeds. Independent security PASS and the protected checks remain separate conditions.

## 7. Required validations and exact evidence

Targeted test: `node --test tools/p0/tests/p0-rosuno-guard-combined-history.test.mjs`.

Existing controls: `pnpm install --frozen-lockfile`; `pnpm run format:check`; `pnpm run typecheck`; `pnpm run build`; `pnpm run p0:validate`; `pnpm run p0:test`; `pnpm run secrets:check`; `pnpm run dependency:check`; `git diff --check`; genuine committed-head `rosuno-guard`.

Retain exact Packet SHA-256; owner/Builder Packet blob equality; unchanged original eight commit SHAs/parents; old/new guard blob hashes; narrow workflow diff; new test blob; positive and negative test results; actual CI status; exact-head Independent Backup PASS; designated human review; separate owner merge authorization. No fabricated PASS or test-only CI bypass.

## 8. Implementation permissions and protected review

The effective Claude Cloud deny rules do not permit unrestricted editing of `.github/*`. Do not bypass those rules through alternate shells, identities, worktrees, or tools. Use the existing owner-authorized human deterministic protected-file procedure where required, after independent review of the exact bytes. Do not expand Claude permissions merely to ease implementation.

P2-914 proceeds through separately authorized Packet adoption, owner-first publication, Builder mirror, bounded implementation, committed-head validation, publication, owner-created PR, Independent Backup exact-head review, required CI, designated human approval, and separate owner-authorized normal two-parent merge. The accommodation becomes effective only after its protected merge. No uncorrected P3-003 merge is authorized.

Following verification of that control merge, P3-904 proceeds through its separately adopted Packet, explicitly approved two-base owner/Builder Packet relationship, one focused application/database correction cycle, real database security validation, and one protected combined-history P3-904 PR, with exact-head Independent Backup PASS, CI, human approval, and separate owner merge authorization. Supabase persistence, Replit sync, deployment, and activation remain separate gates.

## 9. STOP conditions and requested review

STOP → REPORT → WAIT on unexpected branch/head movement, authority mismatch, Packet identity conflict, original commit difference, unsupported protected permission, additional changed path, missing mandatory security proof, failed negative test, CI/reviewer failure, or unapproved procedure change.

**CURRENT AUTHORIZATION: PACKET PREPARATION ONLY.** No code change, guard implementation, branch creation, Packet publication, PR, merge, migration, Supabase mutation, Replit sync, or deployment is authorized.

Independent Backup should return **PASS — READY FOR OWNER ADOPTION** with the exact candidate SHA-256, or **HOLD** with the precise blocking conflict. STOP after review.
