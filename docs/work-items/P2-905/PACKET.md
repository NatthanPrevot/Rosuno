# ROSUNO — P2-905 Optimized Claude Workflow Controls
## Bounded TYPE: PROCESS Implementation Packet REV3 — DRAFT FOR BACKUP

**STATUS: REV3 GATE 0 COMPATIBILITY CORRECTION DRAFT ONLY, NOT BACKUP-PASSED, NOT ADOPTED, NOT AUTHORITY TO MUTATE.** This REV3 replaces the prior **unadopted** 12-path draft solely for a new Backup audit; it is not a branch or a commit. The ID `P2-905` is proposed and was absent from the observed 28-item canonical work-item register on 2026-10-23; verify absence again before final Packet freeze. No implementation, Gate 1, repository PR, permission change or Claude session is authorized now.

```yaml
WORK_ITEM: P2-905
TYPE: PROCESS
BRANCH: wi/P2-905-claude-workflow-controls-v1
BASE_SHA: 18e040a56e388b8e840c4ec5475f0451551d9fcf
BASE_CONDITION: MUST MATCH canonical main immediately before branch creation; otherwise STOP and issue new audited Packet bytes
MIGRATIONS: none
ALLOWED_SCOPE:
- docs/work-items/P2-905/PACKET.md
- .github/scripts/rosuno-guard.sh
- .github/scripts/rosuno-guard-trust.sh
- .github/workflows/rosuno-guard.yml
- .github/scripts/rosuno-process-guard.py
- .github/scripts/rosuno-owner-executor-preflight.py
- .github/scripts/tests/test-rosuno-process-guard.py
- .github/scripts/tests/test-rosuno-owner-executor-preflight.py
- .github/workflows/rosuno-process-guard.yml
- CLAUDE.md
- .claude/settings.json
- docs/process/p2-905-enablement-contract.md
- tools/p0/lib/controls.mjs
- tools/p0/tests/p0-controls.test.mjs
FORBIDDEN_SCOPE:
- rosuno-authority/*
- .replit
- .replitignore
- supabase/*
- apps/*
- pnpm-lock.yaml
- package.json
- pnpm-workspace.yaml
- .github/workflows/p0-controls.yml
- .github/CODEOWNERS
- .github/pull_request_template.md
- .github/scripts/*.sh.bak
- .github/workflows/*-copy.yml
- .claude/settings.local.json
- AGENTS.md
- .gitmodules
- .env
- .env.*
- tools/p0/fast-control.mjs
- tools/p0/lib/fast-control.mjs
- docs/work-items/P2-007/*
- docs/work-items/P2-904/*
DATABASE_CONTACT: NO
REMOTE_DATABASE_MUTATION: NO
PRODUCTION: NO
OLD_SUPABASE: NO
EXECUTOR_WHILE_CURRENT_UOM_ACTIVE: Controlled human + separately audited current C1-compatible Builder route; no new executor privileges
OWNER_REPO_EXECUTOR: DISABLED UNTIL SEPARATE ENABLEMENT
CLAUDE_GATE7: DISABLED UNTIL SEPARATE ENABLEMENT
GITHUB_GUARD_POLICY_CHANGE: NOT AUTHORIZED BY THIS PACKET
ALLOW_HISTORY_REWRITE: NO
```

**Packet body** is this file's exact bytes upon future owner freeze; the exact Backup PASS must identify an externally computed `PACKET_BODY_SHA256` (not appended inside these bytes). Do not treat the current candidate as owner adoption. UOM v1.8/C1 rev6 candidate documents accompany it as nonoperative outside-repository authorities, **not public fork source files**. Preserve current v1.7/C1 rev5.1 originals byte-for-byte. Public Packet contains document title and section pointers only, not confidential locked passages.

## 1. Objective / definition of done

Implement the *minimum* repository-process changes necessary to **enable future bounded automation safely, conditionally**. Do not activate automation in this PROCESS PR. Required deliverables:

1. A verified Gate 0 compatibility-audit input/output schema and a read-only collection/validation path (no access to private authority file contents in public repo).
2. A machine-checked Class A rule schema and tests preserving security assertions, with Class B/C stop tests.
3. An inert owner/fork grant + executor-principal verification layer; cannot mutate owner repo until a separately approved enablement grant/credential proof. No stored keys, tokens or new GitHub Apps created by this Packet.
4. A real **owner-side PROCESS/closure PR guard** with provenance/scope/per-commit trust checks and its own distinct GitHub check context. It must be installed in an explicitly **staged/disabled-for-permissions** state until a separate verified policy/required-check enablement gate; PROCESS/closure PR audit uses independent explicit review during bootstrap.
5. Trust-binder refinement that does **not** silently allow App/bot-authored PRs. Bot support remains disabled pending positive proof of App identity, PD-1 policy, triggering, status source and negative tests.
6. Extend Claude instructions/config to permit a **named, separately owner-granted Gate 7 closure candidate role** only after independent commissioning. No remote DB or owner-repo rights.
7. Targeted unit/system tests for source binding, skipped-owner guard, PR/head movement, App identity, fork ancestry, Class A negative assertions, historical migrations, and recovery receipts, plus Node-invoked Python security suites and six-path neutral-file admission/near-miss regression coverage.
8. Read-only deployment/rollout dossier with exact resulting commit/tree/check hashes; owner/Backup can decide separate authority adoption and enablement without repeated manual assembly.

Success for the PROCESS PR is **correct, fail-closed, inactive-by-default code plus tests**; it is NOT an assertion that owner-side automation, Claude Gate 7 or new GitHub rules are enabled.

## 2. Base and current checks (proposal-time observations, not executable assumptions)

- Owner repo: `NatthanPrevot/Rosuno`; ID `1349842353`; default protected `main`; observed SHA `18e040a56e388b8e840c4ec5475f0451551d9fcf` (PR #78 merge).
- Fork: `RosunoBackup/Rosuno`; ID `1413917279`; observed `main` SHA `f0d311d7f4880d703bf45b6654ea28620e28e0bc`, a five-commit ancestor of owner main as observed. No fast-forward authorized now; re-check fork-only commits, branch and config before future sync.
- Current required owner-main checks: `deterministic install`, `format, typecheck, build, controls`, `dependency and security checks`, `rosuno-guard`. The latter currently passes owner PRs by skipping Builder-specific checks; new owner-side process guard must be independently enforced before activation.
- Replit app `83ab90bb-a9ea-4302-bc30-2aeca40eb0f2`; actual shell worktree, Git common dir/worktrees, `.replit` and Replit Agent effects not inspected at drafting. Reconcile before any Replit-local writes.
- Staging `mxjlvmowmodzdtdfgqpb`, 14 history entries; LAST `20261020070000_p2_registration_abuse_control` in observed read-only migration history. No DB operation in this work item; OLD `ddltrtkunctovnjuyluk` remains noncanonical.
- GitHub owner executor App ID/installation ID, fork executor App ID/installation ID, Claude live cloud tool permissions **UNVERIFIED — ENABLEMENT HOLD**.

## 3. Exact proposed implementation allowlist

**REV3 exact proposed file set (14 paths):**

| Path | Action/purpose |
|---|---|
| `docs/work-items/P2-905/PACKET.md` | Exact future Backup-passed public Packet; published by owner, not Claude. |
| `.github/scripts/rosuno-guard.sh` | Preserve and strengthen existing trust/per-commit checks; never relax Builder protections. |
| `.github/scripts/rosuno-guard-trust.sh` | Owner-process/closure classification, hard deny for unknown actors/unsupported App principal. |
| `.github/workflows/rosuno-guard.yml` | Correct owner-process classified invocation; no skip-is-success, trusted default-branch code only. |
| `.github/scripts/rosuno-process-guard.py` | Implement authentic GitHub context/policy check (not synthetic fixture evaluator). |
| `.github/scripts/rosuno-owner-executor-preflight.py` | Read-only grant/identity/schema validation; mutation entrypoints permanently disabled until enablement. |
| `.github/scripts/tests/test-rosuno-process-guard.py` | Positive/negative per-commit, exact-head, actor, source, closure tests. |
| `.github/scripts/tests/test-rosuno-owner-executor-preflight.py` | Identity/allowlist/grant expiry, fork-only, wrong credential tests. |
| `.github/workflows/rosuno-process-guard.yml` | New status context, allowed only after separate check-source/ruleset proof; NOT operationally required/activated by this Packet. |
| `CLAUDE.md` | Add conditional `CLOSURE_CANDIDATE` contract and mandatory Gate 0 audit; preserve all fork restrictions. |
| `.claude/settings.json` | Preserve connector isolation and deny rules; no host tool enablement. |
| `docs/process/p2-905-enablement-contract.md` | Public-safe immutable rollout/negative-test plan and exact contract references; no credentials. |
| `tools/p0/lib/controls.mjs` | Extend `validateNeutralPaths()` by exactly the six previously rejected named new PROCESS paths; retain every existing accepted path and rejection. No glob, directory-level wildcard, or generalized PROCESS exemption. |
| `tools/p0/tests/p0-controls.test.mjs` | Preserve all existing security/near-miss tests; add exact-path positive/negative inventory tests and mandatory Python-suite execution under the existing Node `p0:test` invocation. |

**No unnamed extra paths.** The two P0 files above are the only REV3 scope expansion, addressing the six known neutral-path rejections. The existing `p0-controls.yml` is a Fast-Control immutable bootstrap file and MUST NOT change. Existing CI invokes `pnpm run p0:test`; the approved `tools/p0/tests/p0-controls.test.mjs` path provides a fail-closed Node-to-Python test bridge, so neither a 15th CI-workflow path nor a package-script change is required *under the bounded design described in §6*. If this design cannot work on the verified runner, STOP as Class B and obtain a new Packet audit rather than add a path silently. No new runtime/test dependency, version bump, Python `pip install`, manifest, lockfile, network service, or altered test count tolerance is allowed.

**Forbidden/protected:** all eleven LOCKED originals, `rosuno-authority/`, `.replit`, `supabase/`, `apps/`, product routes/tests, package manifests, lockfiles, `.env*`, Git internals/config, unknown `.github/` paths, unseen permissions/branch protection/ruleset settings, Cloud App installations, human reviewer settings, Supabase and deployed services. Historical migration bytes immutable.

### 3A. REV3 Machine-Readable Packet and P0 Scope Contract

The fenced YAML header contains **exactly one** beginning-of-line `WORK_ITEM:`, `BRANCH:`, `BASE_SHA:`, `ALLOWED_SCOPE:` and `FORBIDDEN_SCOPE:`. The latter lists use the existing `rosuno-guard.sh` top-level syntax (`- <literal path>` between uppercase field headings). `ALLOWED_SCOPE` enumerates exactly the fourteen §3 paths and **nothing else**. `FORBIDDEN_SCOPE` is additional denial, not an alternative allowlist: existing guard's `FORBIDDEN wins` and per-commit prohibitions remain binding. Existing Packet-first-commit, owner-mirrored exact blob, base/branch binding, case-insensitive collision, special file mode and immutable migration checks stay unchanged. Do not reinterpret table rows as parsed guard policy.

The neutral-path validator `tools/p0/lib/controls.mjs` currently rejects exactly these six new named PROCESS files, which are approved **only as proposed additions** to its existing exact-file `allowedCloudBuilderProcessPaths` set:

- `.github/scripts/rosuno-process-guard.py`
- `.github/scripts/rosuno-owner-executor-preflight.py`
- `.github/scripts/tests/test-rosuno-process-guard.py`
- `.github/scripts/tests/test-rosuno-owner-executor-preflight.py`
- `.github/workflows/rosuno-process-guard.yml`
- `docs/process/p2-905-enablement-contract.md`

All existing allowed entries must remain accepted. Add positive tests for exactly these six and preserve/extend negatives for sibling names, suffixes, case aliases, alternative directories, symlinks, worktree/manifest/migration hazards and any extra `.github`, `.claude`, `docs/process` path. **No blanket approval of `docs/process/*`, `.github/*`, or entire script/test directories.** The P0 validator and its tests are themselves the two additional 14-file scope paths. A failing existing assertion is not a Class A permission to weaken it.

## 4. Gate 0 compatibility audit before future Packet adoption

A bounded read-only Claude audit must inspect the current actual HEAD, exact existing guard/trust/workflow source, all scripts/tests importing guard code, `.claude/settings.json`, CLAUDE.md, relevant CI and Fast-Control entrypoints, repo/test runtime versions, git-history/migration protections and fork packet-mirror assumptions. Its findings must be attached as a no-secret report with SHA-labeled inspected files. The Gate 0 static audit identified two Class B blockers and an unverified Claude environment, which REV3 addresses by this bounded contract and controlled-human bootstrap fallback; live Cloud execution remains unproven.

**Known likely compatibility pressures:** old `rosuno-guard` success via skip on owner-repository PRs, owner-only PD-1 event actor, `pull_request_target` trust boundary, future post-2026-11-02 PD-1 recheck, GitHub Actions token workflow recursion prevention, App versus human author, fork lag and Cloud Builder fork-only tool isolation. These are **issues to verify and test**, not permission to change safeguards unconditionally.

The owner/Primary must reconcile the audit and Backup must PASS the final exact Packet before implementation. If the report demonstrates another file is needed, STOP and revise Packet before code.

## 5. Class A allowance — narrow and explicit

Only after exact Packet acceptance, and **only where the live effective Claude permission policy independently allows the actual edit**, may Claude autonomously correct the explained in-scope matters below without fresh microapprovals. Under the currently observed `.claude/settings.json`, the named `.github` changes remain **denied to Claude during bootstrap**: they must instead be made by a separately authorized controlled human executor, not by weakening or circumventing deny rules. A Class A classification is not a credential, a tool permission, or a way to override higher authority:

- `CA-905-1`: Python/shell formatting or syntax in **new** owner-process guard/preflight and their named tests; no change to actor/authorization semantics. Run syntax + full unit tests.
- `CA-905-2`: Deterministic fixture or expected message changes in **new** named `test-rosuno-*` tests solely to align a *documented canonical identity schema*, while maintaining every negative outcome. Run case plus complete guard suite.
- `CA-905-3`: Changes to explicit `CLOSURE_CANDIDATE` **wording** inside `CLAUDE.md` required by verified host API/session names, without expanding tools, connectors, repo access or mutating permission behavior; Backup checks exact diff.

**Never Class A:** modifying any frozen existing security/negative assertion or its test coverage, relaxing a guard, adding a path, altering runtime token permissions, bypassing workflow policy, raising dependency versions, changing `.replit`, GitHub ruleset/PD-1, migrations, database or product code. Those need Class B authorization, new Packet and independent review. Any unexplained failure is Class C STOP.

## 6. Security and trust acceptance criteria

- **Technical guard positive:** a genuine trusted-default-branch owner-origin PROCESS or closure PR with authenticated per-gate grant, exact HEAD/base, actor/source, per-commit scope and historical invariants passes `rosuno-process-guard` **without waiting for its own check, any concurrently running CI job or Backup**. The check must be emitted by real GitHub Actions on that PR/HEAD; synthetic PASS alone never supplies it.
- **Post-CI readiness positive:** once all required source-bound checks, including `rosuno-process-guard`, have actually succeeded, Independent Backup audits that exact HEAD; the separate Gate 3 readiness verifier requires both verified CI and Backup PASS. A changed HEAD voids readiness.
- Negative tests: grant failing shipped schema, alias/mismatched fields, unauthenticated or expired grant, wrong App/installation actor or account, stolen/spoofed grant metadata, `github-actions[bot]` misrepresented as owner, stale HEAD/base, extra path, branch rename, source repo mismatch, symlink/case alias, historical migration edit then revert, out-of-scope configuration, weakened Class A security assertion, skipped/duplicate guard, multiple PRs for one HEAD, failed or fabricated CI status, no Backup exact-head PASS. A pre-CI technical guard blocked by absent Backup is itself an error to reject.
- Owner-process guard code only runs from trusted default branch. Any checkout of PR head is **data only**, with no execution under statuses-write token.
- Guard must preserve existing `rosuno-guard` required status and builder workflow. New `rosuno-process-guard` source-binding/required-check is a **separate** GitHub policy grant, not part of this Packet's automatic actions.
- Bot-authored owner PR path explicitly OFF until separate approved platform actor/PD-1 trigger proof. Test `App-authored PR -> full CI+guards -> independent Backup` in disposable repository before allowing any real PR automation.
- Credential and network controls: no service tokens in Claude cloud; App tokens minted by isolated runner; log secrets never; owner and fork roles cannot share credentials; `Rosuno` approval manual.
- Full test suite: existing `pnpm` install pinned lock, format/typecheck/build, `p0:validate`, `p0:test`, secret/dependency checks and Fast-Control as authorized for the PROCESS candidate, in addition to new guard negatives. Preserve prior historical accepted CI results; do not claim new test PASS before run.
- **Mandatory Python CI execution without new CI paths:** `tools/p0/tests/p0-controls.test.mjs` already runs under `node --test tools/p0/tests/*.test.mjs` via `pnpm run p0:test`. Add separately named Node tests that invoke `python3 .github/scripts/tests/test-rosuno-process-guard.py` and `python3 .github/scripts/tests/test-rosuno-owner-executor-preflight.py` directly using `spawnSync` in a read-only, bounded synthetic-fixture context, no network, no external credential or third-party dependency. Each Python file must expose `unittest.TestCase` cases and end with `if __name__ == "__main__": unittest.main(verbosity=2)` or an independently reviewed equivalent whose process exit/status is authoritative. For EACH invoked Python script, reject Python-not-found, signal, timeout, nonzero exit, absent `Ran N tests`, `N=0`, missing final `OK`, skipped tests, unexpected file/credential access or partial output. Capture per-file test count/exit in CI logs; never allow missing fixtures, `pass`, no-op, or skipped tests to be interpreted as success. Python filenames contain hyphens: **do not use default unittest discovery** (`python3 -m unittest discover ...` finds zero tests for these names in the observed probe). A direct-script harness and exact stdout/stderr parser are required. If Python is missing from a future runner, CI must fail closed, not silently skip or install a new dependency.
- **Trust-separated runners:** The new Python tests execute only inside the existing `pull_request` P0 workflow with its `contents: read` job token; do not execute PR-controlled Python tests in the existing `pull_request_target` owner write-token guard. Keep the new owner-process check installed/disabled-for-enablements and verify it separately from the four presently required contexts. Offline `python3 -m py_compile` alone is not a substitute for executed negative tests.
- **Source-bound acceptance:** Independent auditor sees a real PR `p0:test` step executing Node file plus both named Python cases, nonzero case counts, positive/negative decision receipts, and preserved preexisting security cases. Synthetic standalone demonstrations are evidence of feasibility only, not CI or role/identity proof.

## 7. PROCESS delivery gates (under CURRENT operative v1.7/C1 until successor adopted)

0. Primary/Claude read-only audit, resolve compatibility, freeze Packet; Backup exact-byte PASS; owner separate Packet adoption.
1. Owner separately authorizes narrowly scoped local branch/Packet publication and an approved Builder context under existing controls. No use of proposed C1 Gate 7 permission for implementing this PROCESS work item.
2A. **Bootstrap execution eligibility: HOLD pending lawful route proof.** Current UOM v1.7 assigns native-file implementation authorship to its bounded Builder; its owner-executed diagnostics/commits do **not** by themselves grant unrestricted human authorship. C1 rev5.1 uses a fork-only Cloud Builder, while current `.claude/settings.json` denies edits under `.github`, `.claude`, `CLAUDE.md`, and `docs/process` despite the prose TYPE: PROCESS exception. Claude may supply read-only analysis and only those fork edits positively allowed by its *effective* permissions. A controlled human executor for the denied PROCESS files is a proposed fallback **only if separately authorized and independently verified as conforming to operative UOM/C1 and locked authority, or under a formally adopted narrow PROCESS bootstrap exception**; this Packet is not such an exception. The owner must not infer permission from possession of a Shell or GitHub token. Before any Gate 1/2A file mutation, document executable actor/credential role, exact fourteen-path scope, Packet-first/fork provenance and human-owner authorization. If this cannot be proved within existing authority, STOP for a separately audited compatibility decision. Do not relax deny, swap tools/connectors, use shadow worktrees, or forge guard PASS. Class A only where actual effective tooling permits it.
2B. Owner separately authorizes protected PR, real current four required checks, and Backup exact-head PR audit; additionally require independent manual/process proof of new guard code because it is not yet a required status.
3. Separately owner-authorized `Rosuno` human exact-head approval.
4. Separately owner-authorized normal merge commit; independent two-parent/blob/CI proof.
5/6. N/A (this is PROCESS only, no database change).
7. Separate bounded governance closure only if governing register/Packet requires it, with independent evidence and protected workflow; **do not activate successor Gate 7 Claude permission to close its own commissioning work**.

**No actual installation/permissions change occurs in this drafting package.** After protected implementation merge, verify new controls against disposable repo; only then propose exact permission/ruleset/Cloud enablement changes in an independently authorized next operation. Owner may then choose to adopt successor UOM/C1 exact versions; sequencing of adoption versus enablement shall never allow new permissions to operate against unproven guards.

## 8. Acceptance receipts / follow-on enablement

Required artifacts: exact candidate/Packet hashes; scope/parent/Git blobs per commit; exact six-path P0 validator positive/negative results; named Node-to-Python bridge logs showing both Python suites executed and nonzero tests with no skipped cases; completed unit, guard and full validation; workflow run IDs and source-bound checks; exact GitHub owner/fork ID/candidate head; Backup Packet/PR PASS; `Rosuno` approval; merge parents; postmerge guard and enablement readiness status; no DB contact. Include failure logs and negative test matrix. Independent auditor judges PASS/CORRECTIONS/STOP on actual evidence.

**Completion classification:** `PROCESS_IMPLEMENTATION_PASS` means installed, reviewed, inactive controls; it is not `AUTOMATION_ENABLED`. Only separate final approval plus verified App/CI/cloud tests can produce `AUTOMATION_ENABLED` and `CLOUD_GATE7_ENABLED`. If trial fails, retain human PR fallback and old C1 restrictions.

### 8A. Consolidated REV3 compatibility freeze checklist (all mandatory)

1. Compare current owner `main` exactly to `18e040a56e388b8e840c4ec5475f0451551d9fcf` and fork `main` ancestry to the evidence snapshot; re-baseline via a new Packet if changed rather than silently proceeding.
2. Confirm all five machine-required Packet headings and exact fourteen literal allow paths using the existing guard's parser (no markdown-table dependence). Confirm field cardinality, BASE/BRANCH/WORK_ITEM identity, forbidden wins and unchanged Packet-first-commit rule.
3. Confirm exactly six newly admitted neutral paths, with the old five Cloud Builder allow entries and every near-miss negative still enforced; refuse wildcard widening and historical edits.
4. Confirm `p0:test` can execute both **direct-script** Python security suites on the existing `ubuntu-latest` runner from the existing approved P0 Node test file; the Node harness must reject missing Python, zero/skipped tests, timeout and nonzero result, and must not hide a failed test behind green summary. Existing `.github/workflows/p0-controls.yml`, `package.json`, pnpm lock and Fast-Control bootstrap bytes stay untouched.
5. Confirm the owner-repository guard's current `MODE=owner` success is *not* incorrectly treated as new PROCESS enforcement. The PROCESS guard is not required or enabled before separate live trials, source-bound check evidence and owner grant.
6. Confirm Claude effective cloud permissions, host tools and fork/owner isolation from an actual read-only attestation. Until proven, controlled human executor handles denied PROCESS paths; do not weaken `.claude` deny rules or claim an unobserved Cloud role is authorized.
7. Confirm no new Python third-party imports/dependencies, no `.env`, App credentials, Supabase, Replit or product changes. P2-007 remains closed and P2-906 is independent.
8. Freeze REV3 exact bytes only after independent Backup PASS and separate owner adoption. Gate 1 publication, implementation, PR, review, merge and enablement remain independent grants.

## 9. STOP criteria

Any mismatch in locked authority, canonical repo/fork root/common-dir/worktrees, unexpected index/untracked file or commit, remote URLs, fork divergence, altered `.replit`, protected guard config, migration history/hash, dependency, package/CI change, unverified owner-PR actor, inability to distinguish review account, unknown cloud MCP/secret, or unexpected schema/security difference → **STOP → REPORT → WAIT**. Do not auto-delete, force reset, rebase, squash, fix an existing failure by suppressing tests, change credential scope or rerun blindly.

**Packet disposition:** REV3 is a proposed **14-path** replacement for the original 12-path draft, pending exact-byte Independent Backup review and owner adoption before any Gate 1 execution. No new work-item implementation is implied by the drafting authorization.
