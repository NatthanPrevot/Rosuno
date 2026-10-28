WORK_ITEM: P2-908
TYPE: PROCESS
BRANCH: wi/P2-908-p2-008-governance-closure
BASE_SHA: 490c82ec32e4725a9d83532a99fe73f2a93aa03c
MIGRATIONS: none
ALLOWED_SCOPE:
- governance/work-items/index.json
- governance/decision-log.json
FORBIDDEN_SCOPE:
- rosuno-authority/*
- supabase/*
- apps/*
- .github/*
- .claude/*
- docs/process/*
- CLAUDE.md
- .replit
- .replitignore
- package.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- tools/*
- .env
- .env.*
- .gitmodules

# ROSUNO — P2-908 Governance Closure of P2-008

**STATUS: GATE 0 CANDIDATE ONLY — NOT AUDITED, NOT ADOPTED, NOT PUBLISHED.**

This is an administrative PROCESS closure candidate for the already protected-merged P2-008 Revision 3 implementation; it does **not** assign the next product work item. P2-908 is a **provisional unused identifier**, subject to exact-byte independent review and separate express owner adoption. Publication, implementation, PR creation, approval, merge and Supabase/configuration/deployment changes remain unauthorized.

## 1. Authority and pinned GitHub evidence

The eleven current accepted LOCKED Rosuno originals outrank owner decisions, adopted UOM v1.7.3 / C1 rev5.4, this Packet and source code. Cite private originals by title/version/section; do not copy private text into GitHub or Claude. The relevant locked scope is MVP Build Specification v1.0 Milestone 2 and Implementation Master Plan v1.0 §17, with the current technical architecture and already adopted P2-008 Packet. **M2 is not declared complete.**

Read-only verified owner repo `NatthanPrevot/Rosuno:main` = `490c82ec32e4725a9d83532a99fe73f2a93aa03c` and merge tree `1bbd50aef8f15a53f1edded206dd84bee181fe03`. PR #81 was created by `NatthanPrevot`, head `RosunoBackup:wi/P2-008-account-recovery-v3` `9ccc26706ff28ae320c9d89f49dbbfe96d9d353c`, base `89ebf6a014b85c27c481ba23bcf85543b685ceb2`, merged on `2026-10-28T05:08:56Z` using normal two-parent commit `490c82ec32e4725a9d83532a99fe73f2a93aa03c`. Ordered parents: `89ebf6a014b85c27c481ba23bcf85543b685ceb2`, then `9ccc26706ff28ae320c9d89f49dbbfe96d9d353c`; merge tree equals approved implementation tree. No rebase, squash or history rewrite. Original Packet SHA-256 `2d77a0e52b4eb423493d4fe8ed78ae9ad5e3c81cbbf653ad5cc8715c060235f4`, Git blob `acd4d44504bf83e11a1b751c0c3d73dba521bcfa`, owner Packet commit `7d8fc8db59c9addaf04cf8f57fe1dc1d943f0055`, fork Packet commit `2fc3ea435f3cbb2d59731c56360e9797da7480ad`; one subsequent linear implementation commit `9ccc26706ff28ae320c9d89f49dbbfe96d9d353c` changed exactly eight named paths, not configuration, dependencies or database migration. The eight paths are: apps/web/app/sign-in/page.tsx, apps/web/app/forgot-password/page.tsx, apps/web/app/forgot-password/actions.ts, apps/web/app/reset-password/page.tsx, apps/web/app/reset-password/actions.ts, apps/web/src/application/account-recovery.ts, apps/web/tests/account-recovery.test.mjs, apps/web/tests/client-registration.test.mjs.

Designated `Rosuno` reviewer APPROVED PR #81 on exact `9ccc26706ff28ae320c9d89f49dbbfe96d9d353c` (GitHub review ID `5677970144`, `2026-10-28T04:57:49Z`). GitHub P0 workflow `40634645045` and trusted guard workflow `40634641145` completed successfully: deterministic install; formatting/typecheck/build/controls; dependency/security; trusted-runner; plus `rosuno-guard` success — four GitHub jobs and the guard context. Independent Backup Gate 0, PR audit Gate 3 and post-merge PASS were expressly supplied by the owner, not independently reconstructed from a separately retained report here. Claude-reported fixture results included all nine Packet validation commands PASS, application shell `220/220`, p0:test `1269/1269`, and 45 recovery test cases/subcases; label these as Builder reports, not independent re-execution.

Current canonical governance at pinned main has **29 work items** (index blob `da9569f95cac90949df84123d773c800e6e97b2f`) and **40 decisions** (decision-log blob `31ef8da6037999204d6818b0a63dc76b6ca01548`). Neither contains the original P2-008 work item nor its closure decision. The two prospective IDs below were absent from the inspected arrays. Proposed `wi/P2-908-p2-008-governance-closure` was absent from both owner and fork when inspected, and the owner does not yet have `docs/work-items/P2-908/PACKET.md`. Fork `main` was still `89ebf6a014b85c27c481ba23bcf85543b685ceb2`, which is the already known, expected lag after PR #81; never treat it as automatically synchronized or authorize sync from this Packet.

These exact references are the **planning baseline**, not a future mutation lease: recheck each before any separately authorized write; unexpected drift means STOP → REPORT → WAIT.

## 2. Smallest proposed governance change

After exact-byte Gate 0 PASS and express owner adoption, add only:

1. **One append** to `governance/work-items/index.json`, original item ID `WI-P2-008-EXISTING-ACCOUNT-PASSWORD-RECOVERY`, status `completed` **for repository implementation only**, with reciprocal decision `DEC-20261028-P2-008-REPOSITORY-IMPLEMENTATION-CLOSURE`. Its `reviewer: Rosuno / approved` refers to original PR #81's completed designated review, **not** any future closure PR approval.
2. **One append** to `governance/decision-log.json`, proposed ID `DEC-20261028-P2-008-REPOSITORY-IMPLEMENTATION-CLOSURE`, status `accepted` **only upon the requisite governance acceptance**; reciprocal work-item ref `WI-P2-008-EXISTING-ACCOUNT-PASSWORD-RECOVERY`. The decision records verified Gate 0–4 lifecycle, exact scope, nonproduction limits and deferred release decisions.

Do not edit, reorder, reformat, replace, renumber or normalize any existing array entry, schema, earlier decision, prior closure or old source file. Preserve existing arrays and JSON style. Proposed new counts: **30 work items and 41 decisions**; 29/40 historical records retained in original order and original values. Preserve unique IDs, reciprocal refs, effective repository validators and real event times; an acceptance/status field in a *local preview* does not mean this candidate is already canonical. Any actual created/updated date must correspond to the event recorded, not PR #81's merge time copied into a closure field. Date portion of the decision ID is provisional until the date of the owner-approved closure decision is confirmed. Companion `GOVERNANCE_APPEND_REVIEW_PREVIEW.json` is a noncanonical review preview, not a file to commit.

**No third implementation path:** no extra evidence file, new schema, test, workflow or helper. P2-008 original Packet and eight implementation files are frozen historical inputs, not closure edit scope. Historical migration bytes, all Git parents and all previously accepted evidence remain immutable. Do not claim the old P2-008 Packet itself allowed governance editing; it explicitly did not.

## 3. Precise closure outcome and retained HOLDs

Permitted conclusion after the new governance closure actually merges and final audit passes: **P2-008 REPOSITORY_IMPLEMENTATION_COMPLETE / WORK ITEM CLOSED FOR BOUNDED NONPRODUCTION IMPLEMENTATION ONLY.** Neither that statement nor PR #81's merge is proof of a production-operational password recovery system or full Milestone 2 completion.

Unresolved without separate owner authorization:

- **D-01:** whether/which adopted registration password lifecycle rules govern password changes/resets; no inferred substitute policy.
- **Packet §5(A):** canonical `ROSUNO_AUTH_PUBLIC_ORIGIN` and exact Supabase Auth allowed recovery redirect for each target environment.
- **§5(B):** real provider Reset Password email template, compatible PKCE code callback, upstream token use/link-prefetch/scanner behavior, expiry and same-browser verifier proof.
- **§5(C):** real authorized email delivery and provider-native recovery rate-limit/abuse behavior; no invented accounts or unapproved live tests.
- **§5(D):** proven correct-account password update, no unauthorized application privilege and verified browser recovery-session cleanup.
- **Deployment HOLD:** no real provider activation, staging/production configuration change, deployment, release or Supabase mutation authorized; OLD Supabase remains forensic/reference only.

The independent user-supplied Backup PASS relates to protected source/PR/merge audit, **not** satisfaction of these live external dependencies. Repository work-item closure and future provider activation are separate gates.

## 4. Review and validation

Before freezing the candidate, independently recheck `NatthanPrevot/Rosuno:main`, both canonical JSON Git blobs and all existing records, P2-008 merge/parent/tree and original Packet, unique IDs, and current workflow guard. Verify no unreviewed edits, no unexpected newer merge, and no P2-008 record already accepted. Do not silently normalize drift; stop and report.

Validate the two proposed new JSON objects against the live `governance/work-items/schema.json` and `governance/decision-log.schema.json`; check all `required` fields, enums, lengths, actual event timestamps, unique IDs, reciprocal refs, 29→30 / 40→41 and append-only historical preservation. Test the complete eventual files with the existing validation and protected CI. The local review preview is **not** a substitute for running tests on a future real repository candidate, and not an assertion of a green future guard. Do not broaden scope or modify validator/test files if a count-coupled assertion conflicts; STOP → REPORT → WAIT.

For the future separately authorized Builder implementation, the same existing Cloud Builder fork workflow, Packet-only owner/fork commits, linear normal publication, exact-head PR/CI, independent Backup audit, designated `Rosuno` review and owner-operated two-parent merge apply. There is **no additional commissioning test, credential grant, test branch or new workflow** in this candidate. Existing guard has `TYPE: PROCESS` compatibility under the ordinary Builder path; a future exact-head live PASS is mandatory, not presumed. The owner manually creates/approves/merges GitHub PRs per the standing owner rule.

Required repo validations after a separately authorized implementation (exact commands where applicable):

```bash
pnpm install --frozen-lockfile
pnpm run p2:application-shell:test
pnpm run format:check
pnpm run typecheck
pnpm run build
pnpm run p0:validate
pnpm run p0:test
pnpm run secrets:check
pnpm run dependency:check
bash .github/scripts/rosuno-guard.sh 490c82ec32e4725a9d83532a99fe73f2a93aa03c HEAD wi/P2-908-p2-008-governance-closure refs/rosuno/approved
git diff --check
```

The original P2-008 feature required no new migration, and the proposed closure is repository-governance only: Gates 5–6 N/A **for this closure**, no Staging/Production or OLD Supabase contact. Preserve existing security and privacy boundaries.

## 5. Gate boundary and STOP conditions

**This candidate is not an authorization** to create `docs/work-items/P2-908/PACKET.md` on GitHub, sync the fork, use Claude Code, edit governance records, run privileged commands, create a PR, review, merge, deploy, or contact any Supabase environment. Required next step: exact-byte Packet and proposed-record review, then separate owner Packet adoption and the appropriately bounded publication/implementation gates under adopted UOM/C1.

STOP → REPORT → WAIT if any original Packet/merge/CI/review identity changes, a canonical record or ID already exists, schema fields require invention, effective guard conflicts, a new file/path becomes necessary, original governance records change unexpectedly, or an authority conflict is discovered. Future registration activation is only a **post-closure assessment candidate**, not an authorized successor item under this Packet.
