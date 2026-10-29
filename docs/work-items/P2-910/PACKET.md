WORK_ITEM: P2-910
TYPE: PROCESS
BRANCH: wi/P2-910-p2-909-validator-compatibility
BASE_SHA: 78ad16ce8ce3256ea917ca900bed6f2c9cc24d33
MIGRATIONS: none
ALLOWED_SCOPE:
- tools/p0/lib/controls.mjs
FORBIDDEN_SCOPE:
- rosuno-authority/*
- supabase/*
- apps/*
- .github/*
- .claude/*
- CLAUDE.md
- AGENTS.md
- .replit
- .replitignore
- .env
- .env.*
- governance/*
- docs/process/*
- docs/work-items/P2-909/*
- tools/p0/tests/*
- package.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- apps/web/package.json

# ROSUNO — P2-910 P2-909 Validator Exact-Path Compatibility Prerequisite

**STATUS: GATE 0 PACKET CANDIDATE — INDEPENDENT BACKUP REVIEW ONLY; NOT ADOPTED, NOT PUBLISHED, NO EXECUTION AUTHORIZED.**

**Relationship to P2-909:** This is a proposed separate prerequisite PROCESS work item solely to remove the verified P0 validator conflict blocking the already-approved P2-909 runbook. It is not permission to resume P2-909 Gate 2A, modify the stopped Mac checkout, or begin an unrelated feature. The identifier `P2-910` and branch name are proposed, not claimed to be registered or adopted.

## 1. Authority and exact read-only baseline

The eleven accepted LOCKED Rosuno originals outrank the owner-adopted complete UOM v1.7.5 (SHA-256 `08ca2089c4b1950ed0a6f392a650589973a4e6a1afdb2c5d1e854b4b9e71da2c`) and C1 rev5.6 (SHA-256 `29f38d8782e89abbc3758a8c00c66629dd6fef4c958824ecc94ca0104354b575`), which outrank this proposed Packet, historical handoffs and implementation convenience. Relevant controlling rules include UOM §§15–17, 24, 28, 34–35 and the corresponding C1 Packet/Cloud Builder, protected-GitHub and reviewer requirements. The LOCKED Implementation Master Plan v1.0 work-item standard, P0 controls and STOP-on-conflict rules also apply. This public-safe Packet cites rather than republishes private locked texts.

Read-only GitHub observations at candidate preparation (2026-10-29; NOT future execution leases):

| Canonical reference | Observed SHA |
| --- | --- |
| `NatthanPrevot/Rosuno:main` | `78ad16ce8ce3256ea917ca900bed6f2c9cc24d33` |
| `RosunoBackup/Rosuno:main` | `78ad16ce8ce3256ea917ca900bed6f2c9cc24d33` |
| `NatthanPrevot/Rosuno:wi/P2-909-github-replit-sync-runbook` | `1e6ce7510fda037d54ce8a5c839c4d0b0e0bfe86` |
| `RosunoBackup/Rosuno:wi/P2-909-github-replit-sync-runbook` | `67967f96211268046058a2e7fa34cf7bff50fae3` |

The `main` Git tree at that SHA is `f262501c73a9882e564888058e0160a4bf695795`. The proposed `P2-910` Packet path `docs/work-items/P2-910/PACKET.md` on canonical `main`, and the proposed branch on both owner and fork, were not found in read-only GitHub checks. The canonical work-item register presently has 30 entries; it does not contain a `WI-P2-910-*` item. These findings must be refreshed immediately before any future authorized publication; do not normalize unexpected changes.

The already-approved P2-909 corrected runbook is SHA-256 `f1cac62bc51d455e56e45920e3c34c05ccf8c4ac1490fbddb23be706adcf591c`, proposed destination `docs/process/github-to-replit-sync.md`. The original P2-909 Packet and corrected runbook are NOT in this implementation scope. The existing Mac checkout `/Users/nate/rosuno-p2-909-executor` remains stopped with that corrected runbook staged and frozen dependencies installed; `git diff --cached --check` passed, but `pnpm run p0:validate` failed with `product implementation paths are present: docs/process/github-to-replit-sync.md`. The earlier original-runbook whitespace FAIL is also preserved. Neither failure may be relabeled PASS or erased.

## 2. Verified defect and narrowly bounded objective

At the stated base, `tools/p0/lib/controls.mjs` defines `allowedCloudBuilderProcessPaths` as an exact-string `Set`, checked during `validateNeutralPaths`. The set includes `docs/process/p2-905-enablement-contract.md` but does not include the approved P2-909 runbook path. `repositoryFiles()` includes the staged runbook via `git ls-files -co --exclude-standard`; the validator therefore fails deterministically when that path exists.

**Exact required implementation edit: add ONE string element to the existing set, adjacent to the existing process-document entry.** The intended diff is exactly:

```diff
     "docs/process/p2-905-enablement-contract.md",
+    "docs/process/github-to-replit-sync.md",
```

Do not add a wildcard, prefix allowance, alternate normalization, exception branch, suppression, conditional bypass, special-case validator return, or broader process-directory permission. Do not change any other line, file, tests, CI, guard, package, dependency, configuration, migration, UOM/C1 or authority. The sole implementation file is `tools/p0/lib/controls.mjs` (one-line insertion). A separate **owner-published Packet-only commit** at the proposed Packet path is required by the normal existing Packet-first workflow; it is not an implementation change and must not be bundled into the Builder's one-line implementation commit.

This exact-path admission is not approval to publish the runbook or to change the blocked P2-909 branch. It merely allows that *name* to appear in the repository file inventory; all other existing path restrictions and validation functions remain in force.

## 3. Allowed / forbidden impact and decisions

- **Capability / milestone:** P0 repository validator compatibility supporting the existing P2-909 process-document publication; no P2 product feature or service behavior.
- **Dependency:** The already-approved P2-909 runbook and independently verified deterministic validator failure. This prerequisite must merge on protected owner `main` before a compliant successor P2-909 baseline can be established.
- **Database / migrations / RLS:** None; historical migration files, fingerprints, schema, policies, privileges and every Supabase environment remain untouched.
- **Provider / secrets / credentials:** No provider integration, external app credentials, network permission, secret, GitHub setting, branch protection, deployment or production change.
- **Security:** Existing default-deny path behavior remains. Only the exact intended path is newly admitted. No changes to `rosuno-guard`, trusted CI, protected review or Claude deny settings.
- **Tests:** No tracked test files are added or modified. The existing P0 test suite is mandatory; targeted exact-path and negative near-miss checks are nonpersistent, in-memory invocations of the *existing* exported validator entry point.
- **Unresolved gates:** Packet exact-byte Backup PASS; owner Packet adoption; separately authorized owner/fork Packet-first publication; verified Builder environment/permissions; Gate 1 implementation; guarded fork publication; separately authorized owner-created PR; independent exact-head PR audit, required CI and designated Rosuno review; separately authorized protected normal merge. None is implied by this draft.

## 4. Required implementation and test contract

### 4.1 Exact-diff acceptance

Require `git diff`/commit-tree evidence that only `tools/p0/lib/controls.mjs` changed in the implementation commit and that the change is exactly the single line shown in §2. The implementation must have the separately audited fork Packet commit as its sole parent and preserve Packet/blob identity and pre-existing history. No amendments, merges, squashes, rebases, resets, force pushes or additional implementation paths. Confirm no file mode change, unintended line ending changes, added dependencies, or generated tracked/untracked artifacts.

### 4.2 Positive and negative exact-path tests (no tracked test file)

After the single-line candidate is placed, execute the following **proposed targeted test** in the authorized, verified Builder validation environment. This tests the real exported `validateApplicationSurface` function using an in-memory file inventory. It **creates no repository file** and is **not an implementation script**. The test must itself be reviewed with the final authorized execution instructions before use.

```bash
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { validateApplicationSurface } from './tools/p0/lib/controls.mjs';
const read = p => readFileSync(p, 'utf8');
const json = p => JSON.parse(read(p));
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean);
const allowed = 'docs/process/github-to-replit-sync.md';
assert(!files.includes(allowed), 'prerequisite branch unexpectedly already contains P2-909 runbook');
const context = {
  packageJson: json('package.json'),
  workspace: read('pnpm-workspace.yaml'),
  webPackageJson: json('apps/web/package.json'),
  npmrc: existsSync('.npmrc') ? read('.npmrc') : null,
  migrationRegister: json('governance/migrations/reviewed-migrations.json'),
};
const probe = extra => validateApplicationSurface({ ...context, files: [...files, allowed, ...extra] });
assert.doesNotThrow(() => probe([]), 'exact approved path must be admitted');
const denied = [
  'docs/process/github-to-replit-sync.md.bak',
  'docs/process/github-to-replit-sync.MD',
  'docs/process/Github-to-replit-sync.md',
  'docs/process/github-to-replit-sync.md/extra',
  'docs/process/other-runbook.md',
];
for (const path of denied) {
  assert.throws(
    () => probe([path]),
    e => e instanceof Error && e.message.includes(`product implementation paths are present: ${path}`),
    `near-miss path must remain denied: ${path}`,
  );
}
console.log('P2_910_EXACT_PATH_POSITIVE_AND_NEGATIVE_PASS');
NODE
```

The positive test must PASS, and **all five** negative probes must be rejected by the actual validator. Unexpected pass, unexpected error cause, missing export, bad environment, or any residual `p0:validate` failure is STOP → REPORT → WAIT, not permission to widen the edit. No negative probe writes a near-miss file to the repository.

### 4.3 Mandatory existing controls

Use the repository's existing package-manager and validation conventions and the adopted C1 execution role. No new tool or tracked script is approved. Required commands for the final candidate, subject to verified runtime identity and normal approved command review:

```bash
pnpm install --frozen-lockfile
pnpm run p0:validate
pnpm run p0:test
pnpm run format:check
pnpm run typecheck
pnpm run build
pnpm run secrets:check
pnpm run dependency:check
git diff --check
git diff --cached --check
```

The exact-path targeted test above is **additional**, not a replacement for any mandatory control. Preserve full actual results, including any failure, and verify unchanged manifest/lockfile and migration hashes, exact diff, working tree/index/generated output and Packet. The existing guard must run on the **actual committed implementation HEAD**, with owner-approved Packet provenance and `ROSUNO-GUARD PASS`, before any fork publication. GitHub's required exact-head P0 checks and `rosuno-guard` remain mandatory after PR creation. No validation result may be inferred from static analysis or from a different branch, tree, toolchain or run.

## 5. Normal protected workflow (separately gated)

**Gate 0 (this candidate):** Independent Backup audits this exact Packet body and records its SHA-256. Owner separately adopts the audited Packet. No repository mutation or release of the stopped P2-909 checkout follows automatically.

**Gate 1 — Packet-first publication and implementation authorization:** Following fresh read-only identity/refs/branch availability/parent/tree/protection/migration checks and separate owner permission, owner publishes this Packet as the **sole file in an owner Packet-only commit** at `docs/work-items/P2-910/PACKET.md` on the proposed owner work branch based on the then-verified approved main. Owner mirrors the byte-identical Packet on the corresponding existing/new fork work branch, per adopted C1. Exact Packet blobs/parent/tree/author and branch refs are independently verified before Builder implementation. If `main` moves before publication, STOP and prepare a new audited baseline rather than silently change `BASE_SHA`.

The normal permitted Claude Code Cloud Builder may natively edit only `tools/p0/lib/controls.mjs`; `.claude/settings.json` does not deny `Edit(/tools/p0/lib/controls.mjs)`, but effective cloud environment and permissions must be verified again. Claude cannot edit protected docs, use alternate tools to evade denied actions, or perform unauthorized provider writes. The single-line in-scope correction, normal tested candidate, and fork publication must follow adopted C1 and the reviewed Packet; all execution and transport remain contingent on separately applicable owner authorizations.

**Gate 2A:** Independently verify the fork's exact published implementation head, one-line scope, parent and immutable Packet, targeted test results, full mandatory validations, guard PASS and preserved history. Report PASS/READY FOR PR only on evidence, not expectation.

**Gate 2B:** Separately authorized owner manually creates the PR against `NatthanPrevot/Rosuno:main` under the required GitHub web workflow. Independent Backup audits the exact live PR head. No bot- or Builder-created PR.

**Gate 3:** Protected exact-head CI and the designated `Rosuno` reviewer approval are required. Reviewer request is not approval.

**Gate 4:** Separate owner authorization for the normal **two-parent merge commit** (no squash/rebase). Independently verify merge SHA/tree/parents, approved one-line scope, required checks/review and untouched migration history. A Git merge does not authorize Supabase, Replit, deployment or production mutation.

**After protected prerequisite merge:** Preserve the existing P2-909 owner/fork Packet commits, corrected staged Mac checkout, original runbook and **both** failed validation records. Do not merge/rebase/reset the old P2-909 branch. Propose and independently audit a **successor P2-909 Packet** against the newly verified protected-main commit and a new versioned branch under separate authorization. The adopted UOM v1.7.5 §15.4/C1 rev5.6 P2-909 human-placement exception currently pins the *old* branch and Packet parent; its continued applicability to a successor must be explicitly reconciled through the controlling adopted process before any successor execution. Do not silently carry that lease forward, amend historical procedural authority, or presume the successor inherits an executor permission. Resume P2-909 only after those required reconciliations and new bounded approvals.

## 6. Acceptance, observability, rollback and STOP rules

**Acceptance:** (a) one-line, one-path validator addition; (b) exact positive admission and all negative near misses pass; (c) all existing validation and GitHub protected checks pass on the exact accepted head; (d) independently verified owner-approved Packet carriage, linear commit ancestry, reviewer approval, normal owner merge and preservation of the existing P2-909 evidence; (e) a reviewed successor path for P2-909 established separately. This prerequisite is **not** completion of the runbook work item.

**Observability / durable evidence:** Retain exact Packet hash and blob, owner/fork branch tips, baseline and final commit/tree/parent SHAs, `tools/p0/lib/controls.mjs` blob/mode and exact diff, no-extra-file status, command logs for the positive and five negative tests, mandatory checks, committed-head guard, PR/CI/review/merge proof, and preserved P2-909 original whitespace and P0 validation failures. Store only in an already authorized durable evidence location; do not publish private credentials or invent an evidence store.

**Rollback/recovery:** No automatic rollback or history rewrite. Until protected merge, a failed candidate remains blocked; ordinary in-scope corrections are forward-only and require revalidation. After a protected merge, any actual defect must be remediated through a new, separately approved, forward-only correction. Do not remove the exact admission merely to make the old P2-909 checkout look clean. No DB rollback is applicable.

**STOP → REPORT → WAIT** for missing/changed authority, branch, parent, Packet, tree, GitHub protection, work-item ID collision, unexpected file/credential/configuration/migration differences, effective Builder permission/refusal, required validation failure, negative-test acceptance, non-`RosunoBackup` transport identity, unreviewed extra line/path, guard FAIL, or unsupported successor authorization. Do not bypass, waive, silently fix, erase evidence, or operate on OLD/production Supabase.

**Owner decision sought after Backup review:** Adopt the exact prerequisite Packet and separately authorize the normal Packet-first publication gate. **This draft authorizes no mutation, publication, PR, merge, P2-909 checkout change or P2-909 successor preparation.**
