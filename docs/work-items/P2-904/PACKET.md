WORK_ITEM: P2-904
TYPE: PROCESS
BRANCH: wi/P2-904-nextjs-oct2026-security-hotfix-v2
BASE_SHA: f0d311d7f4880d703bf45b6654ea28620e28e0bc
MIGRATIONS: none
ALLOWED_SCOPE:
- apps/web/package.json
- pnpm-lock.yaml
- apps/web/tests/authentication-session.test.mjs
FORBIDDEN_SCOPE:
- .github/**
- .claude/**
- CLAUDE.md
- docs/process/**
- governance/**
- supabase/**
- tools/**
- apps/web/src/**
- apps/web/app/**
- package.json
- pnpm-workspace.yaml
- .replit

# ROSUNO — P2-904: Next.js October 2026 Security Hotfix

**Status:** REVISION 2 GATE 0 CANDIDATE — Independent Backup review pending; not adopted, published, or executable. This public-safe replacement Packet retains work item `P2-904` on a new, unpublished `-v2` branch. The original P2-904 REV1.1 Packet, its published owner and fork Packet-only commits and branches, and its Builder Class B failure evidence remain historical and unmodified. The §8 REV1.1 citation addendum remains unchanged as historical text. The new Packet must be re-audited if canonical owner `main` moves from `BASE_SHA` before the new Packet-first branch is created.

## 1. Why this bounded PROCESS item exists

The accepted P2-007 Gate 7 REV3 local governance candidate passed Fast-Control preflight, P0 regression tests and 175/175 application tests, then failed at the preexisting `pnpm run dependency:check` gate because `pnpm audit --audit-level=high` found two critical and one high Next.js advisories. The production code and accepted Staging migration are not reopened by this finding. Do not weaken or omit dependency checking.

The `@rosuno/web` workspace currently declares `next: "^16.3.8"` while the lockfile resolves `next@16.3.8`. Official Vercel advisories GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr and GHSA-p3m5-59mp-jv5r mark Next.js 16.4.1 as a patched version (release 2026-10-14). This is a dependency-security correction, not new functionality.

**REV2 bounded compatibility correction.** In the original P2-904 Builder attempt, the exact Next.js 16.4.1 pin passed frozen install, format, typecheck, build, P0 validation, all 1,260 P0 control tests, secrets scan, and dependency-security audit, but one of 175 application tests failed: `apps/web/tests/authentication-session.test.mjs`, test 1, has an exact `manifest.dependencies` assertion still expecting `next: "^16.3.8"`. The original Packet forbade all test modifications; Claude stopped without an implementation commit or push. This revision authorizes **only that obsolete expected value** to change. These are previous Builder report observations, not new validation performed by this Packet.

## 2. Exact authorized design (no execution authorized by Packet preparation)

- Change **only** `apps/web/package.json`, `pnpm-lock.yaml`, and `apps/web/tests/authentication-session.test.mjs` in implementation commits after the first Packet-only commit. In the named test file, change **only test 1’s expected Next.js version** from `next: "^16.3.8"` to `next: "16.4.1"`; preserve the exact `assert.deepEqual(manifest.dependencies, ...)` check, all four other expected dependencies, and every other assertion. The test must still reject unauthorized additional or missing runtime dependencies. Do not change any migration, governance, application source, other test file, CI, kit, environment or root manifest file.
- The blanket `apps/web/tests/**` entry has been removed from `FORBIDDEN_SCOPE` **solely** because it would override the single added test allowlist path. The exact three-path `ALLOWED_SCOPE` remains exhaustive: every other test path is still prohibited. `FORBIDDEN_SCOPE` wins whenever a path matches both lists.
- Update only the `@rosuno/web` `next` direct dependency from `"^16.3.8"` to **exact** `"16.4.1"`. Exact pin is intentional: do not resolve unreviewed later Next.js versions under a caret range.
- Regenerate `pnpm-lock.yaml` deterministically using the existing repository pnpm version **10.26.1** with an appropriately scoped, authorized package-manager operation. The importer must resolve Next.js **16.4.1** exactly. Allow only the necessary version/integrity/resolution changes to `next` and its directly resulting `@next/*`/other transitive entries; each other lockfile difference requires itemized explanation and Backup/Primary review. Do not manually invent integrity hashes, omit optional platform binaries, discard peer-dependency metadata, or re-resolve the unrelated dependency graph.
- Keep React and React DOM at current declared versions, unless a genuine incompatibility is proven; any need to change them, another manifest, application source, a test file or assertion beyond the one explicitly authorized expected value, or settings is **STOP / report / new authorization**, not automatic scope expansion.
- No application behavior, database schema, RLS, ACL, environment settings, security controls or user-facing contract changes. No secrets, credentials, fake customer data, Staging contact or Production access.

## 3. Builder environment and starting conditions

- Cloud Builder C1 rev5.1 is the governing surface. Work only in the public fork `RosunoBackup/Rosuno` with `.claude/settings.json` and `CLAUDE.md` controls already installed; never supply private locked originals or any Rosuno credentials. Do not use Replit Agent or connect to Replit/Supabase.
- At an **independently authorized Gate 1**, the owner alone first publishes a Packet-only commit at `docs/work-items/P2-904/PACKET.md` on an owner branch of the same name based on `BASE_SHA`. The owner separately syncs the Builder fork `main` to the same base and mirrors the **exact Packet blob** as its first and only Packet commit on its matching branch. Verify both blobs match. The Builder then follows the normal C1 startup/verification sequence and works exclusively on the fork.
- Builder follows linear forward-only commit history; never rebase, squash, amend, force-push, alter the Packet after its first commit, or create a PR. Only the three exact allowed implementation paths may change in subsequent commits. Any scope/security discrepancy requires STOP → REPORT → WAIT.

## 4. Required validation and acceptance evidence

Validation is **future, gated execution** by the authorized Cloud Builder under C1; this review Packet runs nothing.

A. Identity and dependency diff: prior and candidate full commit SHAs, tree SHA, parent chain, Packet blob SHA, branch and remote; `git diff --name-status`, per-commit scope enforcement, `git diff --check`; exact dependency declaration and resolved lockfile `next@16.4.1`, including any Next.js-related transitive/peer changes and frozen lockfile resolution consistency.

B. Deterministic install and full CI parity using Node **24** and pnpm **10.26.1**, mirroring `.github/workflows/p0-controls.yml`:

```
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run typecheck
pnpm run build
pnpm run p0:validate
pnpm run p0:test
pnpm run secrets:check
pnpm run dependency:check
```

C. `pnpm run dependency:check` must exit **0** without audit-level changes, `--ignore`, policy exceptions, skipping advisories or other suppression. Record that the three specific GHSAs no longer affect the resolved `next` version. No PASS may be claimed if an additional high/critical advisory is reported.

D. Validate the unchanged application security/default-deny behavior with the existing P0 and app regression suites; report exact test counts and build/typecheck outcomes. Evaluate patch compatibility for Next App Router, Server Actions, React peers, SSR, image handling, and bundling without introducing an unrelated feature. Any application source change or test change beyond the one specifically authorized expected-value correction is a scope-stop, not a silent fix.

E. Verify `rosuno-guard` self-check and preserve complete Builder log and command exit statuses. Before any cleanup following a STOP, preserve full failure evidence, exact changed-file diff/patch and hash, toolchain versions, and current Git state in permitted non-repository evidence storage; if the environment cannot retain evidence durably, report that limitation. Never use a failure as authorization to commit or push. Report `BASE_SHA`, Packet SHA-256 / Git blob, branch head SHA, changed paths and lockfile diff, test/audit status, and security-advisory findings. Secrets must not be printed. No claim of protected CI PASS before it actually runs on the exact published PR head.

## 5. GitHub acceptance workflow — distinct owner gates

- Gate 0: Primary submits this Packet to independent Backup; obtain exact-byte PASS, then **separate owner adoption**. Confirm `BASE_SHA` and guard/CI continuity before Gate 1; if `main` moved, prepare a newly based Packet for review — never rebase an already approved work-item branch.
- Gate 1/2A: After explicit owner implementation authorization, owner publishes/mirrors the Packet; Cloud Builder implements/tests/pushes **only to fork**; Primary independently reads the published diff/commits and the guard self-check; Backup reviews candidate when required.
- Gate 2B: Separate owner authorization; **owner creates** protected PR in GitHub web, target `NatthanPrevot/Rosuno:main`, source `RosunoBackup:wi/P2-904-nextjs-oct2026-security-hotfix-v2`. Required checks: `deterministic install`, `format, typecheck, build, controls`, `dependency and security checks`, and `rosuno-guard` bound to correct PR/head. Owner trigger/PD-1 for guard remains a gate; no bypass. Independent Backup PR audit of exact SHA is required.
- Gate 3: Separate authorization; designated **Rosuno** human reviewer approves exact PR head after CI/guard and Backup PASS.
- Gate 4: Separate owner authorization; owner merges in GitHub web using **Create a merge commit** only; verify both parents, merge SHA, tree, checks, and canonical `main`. No squash, rebase or force-push.

## 6. Relationship to P2-007 Gate 7

- This is a separate security work item. It does **not** contain, copy, stage, commit or modify the uncommitted REV3 eight-file Gate 7 candidate stored in canonical Replit. The original P2-904 Packet branches and commits also remain untouched; REV2 is Packet-first on a separate versioned branch from the same verified base.
- Gate 7 remains HOLD while this hotfix is reviewed and implemented. After the **verified hotfix merge**, the owner separately authorizes preservation/reconciliation and controlled transfer of the exact REV3 changes onto a **new clean branch based on the new canonical `main`**, without rebase or historical rewrite; do not try to merge a dirty Replit worktree.
- The eight-file REV3 candidate and its earlier failing dependency-audit evidence remain retained. Gate 7 resumes with a new-base read-only reconciliation, Fast-Control under separate approval, final Independent Backup candidate review, then separately authorized local commit, branch publication, PR, human review, merge and post-merge closure checks. No further Staging catalog extraction, migration application, deployment or registration activation is part of either work item.

## 7. Stop conditions / rollback boundary

STOP → REPORT → WAIT for an unexpected base/head, stale or diverged fork, unexplained dependency/lockfile changes, new patched-version advisory, unsupported Next.js peer/runtime requirement, failing test/audit, missing CI/guard status, malformed Packet/commit order, unauthorized changed file, or any discrepancy in the preserved REV3 candidate. Do not auto-upgrade React, bypass checks, rewrite commits, reset protected history, delete existing evidence or retry failed validations without authorization.

Repository-only hotfix rollback, if needed after merge, must be separately authorized and forward-only (reviewed corrective commit/PR), never rebase/force-push or rewrite accepted history. No database rollback is implied or authorized.

## 8. Authority and references (public-safe identifiers only)

Eleven current locked Rosuno originals (exact owner-held hashes and filenames in private verification index) outrank this Packet. Relevant controlling documents: Rosuno Master Blueprint; Domain Model V1.4-LOCKED; Technical Architecture V0.2 CONSOLIDATED LOCKED; MVP Build Specification V1.0 LOCKED; Implementation Master Plan V1.0 LOCKED; related locked relational, physical/database, payment, regulatory and financial specifications. Procedure: owner-adopted Unified Operating Model v1.7, Cloud Builder C1 rev5.1. P2-007 Gate 0 REV5 remains unchanged. No locked original is reproduced, published or sent to Builder.

**§8 authority-citation addendum — revision 1.1 (Independent Backup review candidate; no requirements changed).** The following section identifiers were verified against the accepted originals; no non-public authority text is reproduced.

- **Rosuno Master Blueprint** (MVP Foundation, Version 1): §§4 and 105.
- **Rosuno Domain Model** (V1.4-LOCKED): §§1 and 11.
- **Technical Architecture Specification** (V0.2 CONSOLIDATED LOCKED): §§3.14 and 70.
- **MVP Build Specification** (V1.0 LOCKED): §§4 and 20.
- **Implementation Master Plan** (V1.0 LOCKED): §§2, 34 and 35.
- **Relational Object Specification** (V1.0 LOCKED): §§0–1.
- **Physical Supabase/PostgreSQL Specification** (accepted `v1-0-LOCKED` original; its internal 0.1 draft version heading is not amended): §§0–1.
- **Payment / Engagement Sequence Matrix** (V0.2 LOCKED): §§0–1.
- **Regulatory Master Specification** (V0.3 source-controlled research draft): §0.
- **Data / Schema Specification** (V0.7 Flow Trace & Inventory Approval): §§5–6.
- **Financial Provenance Physical Correction** (accepted locked FP-1 original): §§0 and 15.
- **Adopted procedure:** Unified Operating Model **v1.7**, §§16.1–16.3 and 28; **Cloud Builder C1 rev5.1**, §C1.2 (Gate 0 and Gate 1) and Appendix A.

Official public sources (release/2026-10-14):
- https://nextjs.org/blog/nextjs-security-update-october-14-2026
- https://github.com/vercel/next.js/releases/tag/v16.4.1
- https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw
- https://github.com/vercel/next.js/security/advisories/GHSA-673q-mjm6-r5xr
- https://github.com/vercel/next.js/security/advisories/GHSA-p3m5-59mp-jv5r

**Not a deployment or activation authorization.**
