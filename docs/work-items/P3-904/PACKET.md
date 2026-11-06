# ROSUNO P3-904 — P3-003 Security Correction Packet

**STATUS: GATE 0 REVIEW CANDIDATE — NOT ADOPTED OR EXECUTABLE**  
**Version:** Revised after P2-914 protected merge, 2026-11-06  
**Purpose:** One bounded, forward-only correction of three P3-003 security deficiencies. No new product capability.

```text
WORK_ITEM: P3-904
TYPE: FIX
BRANCH: wi/P3-904-p3-003-security-correction
BASE_SHA: b3fda55231625d440f3aa536e36c30e1dbb5b94a
MIGRATIONS: new allowed
ALLOWED_SCOPE:
- supabase/migrations/*
- apps/web/src/application/attorney-professional.ts
- apps/web/src/application/staff-verification.ts
- apps/web/src/application/professional-audit.ts
- apps/web/src/application/attorney-application.ts
- apps/web/src/infrastructure/identity/registration-provisioning.ts
- apps/web/src/infrastructure/identity/attorney-application-provisioning.ts
- apps/web/src/infrastructure/professional/*
- apps/web/src/infrastructure/staff/*
- apps/web/app/attorney/*
- apps/web/app/staff/*
- apps/web/tests/*
FORBIDDEN_SCOPE:
- rosuno-authority/*
- governance/*
- docs/process/*
- docs/work-items/*
- .github/*
- .claude/*
- CLAUDE.md
- tools/*
- supabase/config.toml
- supabase/seed*
- supabase/seeds/*
- .replit
- .replitignore
- package.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- .env
- .env.*
- .gitmodules
```

**Envelope rules.** Exactly **one** new forward-only migration file is allowed; no prior migration may be edited, deleted, renamed, or replayed. `docs/work-items/P3-904/PACKET.md` is permitted **only as the separate, owner-authorized Packet-only first commit**. It is forbidden in subsequent implementation commits. `FORBIDDEN_SCOPE` overrides `ALLOWED_SCOPE`; the allowlist is exhaustive. All historical migration names and bytes are immutable. No new dependencies, configuration, business tables, roles, capabilities or unrelated features.

## 1. Authority, provenance and gates

Controlling order: eleven current original LOCKED Rosuno authorities; adopted UOM v1.7.8 (SHA-256 `3754f678252620fe55dbe2264792ecc94a317dcd6da71308531bdd0dabefbeb0`); adopted C1 rev5.9 (SHA-256 `34f809e2b28b42b7d1828e524605c3cac092af873f29ef889f8eec5f7e38ab82`); original owner-approved P3-003 Packet; this P3-904 Packet **only after separate owner adoption**; independently verified canonical state. P2-914 supplies a narrow, merged **process guard accommodation**, not a new product or security authority. Its adoption/merge does not independently adopt this Packet or accept corrected security.

This candidate retains the original P3-904 technical correction envelope, replacing its obsolete §6 Git-integration alternatives with the already integrated P2-914 combined-history path. It does not rewrite the original P3-003 Packet, the P2-914 Packet or locked documents.

**Review/adoption gates:** Independent Backup Gate 0 exact-candidate PASS and express owner adoption are mandatory **before** Packet publication. Publication, local Builder implementation, original-commit transfer if needed, branch push, PR creation, PR review, protected merge, staging migration application, other Supabase changes, Replit synchronization and deployment are **separate** owner authorization gates. No staging or production mutation is authorized here. OLD Supabase is forensic-only.

## 2. Immutable original history and correction ancestry

- Owner: `NatthanPrevot/Rosuno`; Builder: `RosunoBackup/Rosuno`.
- Original P3-003 base: `8449593d0baccac377f4884ede522d00fa1cc997`.
- Original P3-003 owner Packet commit: `ae9c644967c702972f8c14a964d78e4bb4c2a83b`.
- Original P3-003 Builder Packet commit: `405956f9f4a14432a12fc7eacb10e33c0278e39d`.
- Original P3-003 Packet blob: `c394078a7440d5e48bce81c33d7a581d951d1c74`; SHA-256 `43c8e164211772d673216595b8b025ba4423f7598eb5a01678426a23eed3a782`.
- Original eight implementation commits in exact ancestry order:
  1. `77b29508b1ed9c5a8e79c352be04016d956e30d4`
  2. `ac9c5feba15a4f2453ebbca907ecdac372a55f32`
  3. `4e548818d38f86f18fadcc3072293be58493d679`
  4. `9cedce919b05288800574d0c96049415c892926d`
  5. `4425c5f5f3be59bdb08b14c20eb4afa5f6701893`
  6. `ba6fc7888ea842b89d70e44cee62203af68c52fd`
  7. `4d22a2b2c8916e01da24227e7f5b1235b3de1ebe`
  8. `b3fda55231625d440f3aa536e36c30e1dbb5b94a`.
- Original final tree: `c9823d197923c17c146bdc10b0ec47a1cc8564c0`.
- **Correction Packet-only first commit must have exactly one parent**, original P3-003 HEAD `b3fda55231625d440f3aa536e36c30e1dbb5b94a`, and add **only** `docs/work-items/P3-904/PACKET.md`. The owner Packet-approval branch is separately rooted at its independently approved owner baseline; do not invent its future SHA.
- P2-914 owner protected merge: PR #88, merge `b003c23475b8fd22c2ad7496df51923c5d3fa6e3`; parents `8449593d0baccac377f4884ede522d00fa1cc997` and `48fc838fdd3018da8ca453f57e61305ddd184f35`.
- All later P3-904 correction commits are linear; original commits and both Packets remain byte-identical. No rebase, cherry-pick, squash, amendment, force push, new artificial merge or rewrites.

## 3. Correction goal and fixed security outcomes

The originally published P3-003 work has not been independently accepted as safe for affected operations. Correct **R1, R2 and R3 together** while preserving P3-003 acceptance criteria A1–A16, especially A4, A10 and A11, existing P3-001 attorney access and P3-002 applicant creation. These are security defects, not permission to redesign the product.

**R1 — Authorization-to-write race:** The service-role `registration-provisioning.ts` path currently performs direct privileged professional/evidence/review/evaluation writes. Application-level authorization rechecks cannot prevent revocation or deactivation between the final check and decisive database write. Place effective, operation-specific authorization at the consequential database write boundary, with valid concurrency semantics and prevented bypasses.

**R2 — Inactive principal reads:** `public.has_manage_attorney_verification_scope(uuid, boolean)` presently checks grants/jurisdiction but does not deny inactive Rosuno Users or Staff Profiles. Correct the predicate and its affected RLS authorization behavior without changing legitimate scope semantics.

**R3 — Non-atomic audit:** `runAuditedChange` uses separate requests for attempts, consequential mutations and outcomes. Require the mandatory final audit event and consequential domain mutation in the same database transaction, including evidence-subject linkage where required. Failure of either side rolls back the transaction.

Existing relations, authorization grants, identity associations, evidence-subject tables, immutable audit structure and lifecycle/eligibility semantics must be reused. No invented staff policy, professional status, attorney eligibility, verification evidence, production identities or regulatory decision.

## 4. Database design and implementation acceptance

### 4.1 Existing staff capability predicate (R2)

Keep the existing signature and return type:

```sql
public.has_manage_attorney_verification_scope(
  required_jurisdiction uuid,
  allow_any_jurisdiction boolean
) returns boolean
```

Require a trusted matching authenticated principal, active Rosuno User, active Staff Profile, current unrevoked `manage_attorney_verification` grant, valid grant effective times, and existing jurisdiction/resource restrictions. Preserve global/jurisdiction scope semantics. Missing, inactive, ambiguous or stale authority denies. Enforce appropriate execution privileges and controlled `search_path`. Do not treat this read-policy correction alone as solving privileged-write R1.

### 4.2 Consequential operations — bounded design freedom

Design the **smallest safe set of operation-specific, typed PostgreSQL interfaces or demonstrably equivalent narrowly bounded database operations**; select exact signatures **after** inspecting actual tables, owners, auth semantics, grants and callers. A generic text/JSONB table-dispatch RPC, new generic permission layer, new business table or general-purpose service abstraction is not required or authorized. No implementation-specific signature is preapproved here.

Cover existing attorney actions: applicant profile details; approved-profile presentation fields; license-claim insert/revision; insurance-claim insert/revision; practice-area request insert/revision/withdrawal; applicant submission. Preserve P3-002 initial applicant creation by an independently bounded operation if that workflow would otherwise be blocked by direct-write revocation.

Cover existing staff actions: evidence recording and mandatory subject association; source-unavailable recording; license-source observation; discipline finding creation/permitted status transitions; practice-area authorization decision; Attorney Profile review transition; consequential eligibility-evaluation persistence.

For each operation prove correct authenticated actor and linked profile, allowed columns, ownership, lifecycle state, jurisdiction/capability, concurrency guards, non-forgeable identity, atomic audit and failure behavior. The professional verification decision, policy/eligibility authority and staff capabilities cannot be controlled by attorney profile update inputs. Authorization cannot be inferred from possessing a service-role credential.

### 4.3 Function safety and privilege isolation

Inspect actual definer/invoker semantics and ownership. Revoke default `PUBLIC` execution as necessary, grant the minimum appropriate roles, constrain search path, avoid untrusted dynamic SQL, reject unsupported parameters and caller-supplied authoritative actor IDs. Authenticated RPC must use the real request-scoped authenticated session, not a service-role request with a spoofed `user_id` argument. Review role inheritance and effective grants. If safe privilege isolation cannot be proven for an existing necessary caller, report a concrete scope/authority blocker rather than retain an unsafe bypass.

### 4.4 Revocation-serializable authorization (R1)

In the **same transaction** as the protected mutation, verify and hold appropriate locks over User active state, Staff Profile state, applicable capability grant, target Attorney Profile and affected professional record as necessary. Establish a consistent lock order against legitimate grant revocation, suspension, deactivation, expiration, scope revision and record-state changes. Prove serialization semantics:

- Revocation/deactivation committed before the decisive authorization check causes denial.
- A mutation that already validly acquired its authorization locks may complete before a later revocation commits.
- Authority cannot become invalid between the decisive check and write without a serializable conflict/locking outcome.
- Deadlock, lock timeout, conflict and stale lifecycle cause rollback/fail-closed behavior.

Do not assume repeated application-level checks or an unlocked `SELECT` suffice; use correct grant effective-time semantics.

### 4.5 Atomic domain mutation and audit (R3)

Write the mandatory final audit event **in the domain mutation's own database transaction**. If final audit insertion fails, no domain change commits; if the domain change fails, no false success audit exists. Evidence and required evidence-subject links must be atomic. Multi-record findings must not leave misleading partial artifacts. Preserve append-only `audit_events`, actual actor attribution, jurisdiction/resource references, material before/after evidence, reason and policy references where applicable and truthful retry/ambiguity reporting. Optional attempt telemetry is not a substitute for atomic final success. Do not fabricate audit outcomes on ambiguous network failure.

### 4.6 Database bypass prevention

Retire the affected privileged direct DML interfaces after all valid callers have migrated, and remove bypassing permissions as needed. Inspect these actual M4 relations independently:

`attorney_profiles`, `licenses`, `insurance_records`, `discipline_records`, `practice_area_authorisations`, `verification_evidence`, `verification_evidence_subjects`, `eligibility_evaluations`.

Preserve necessary reads and legitimate unrelated operations. For `attorney_profiles`, keep P3-002 initial applicant creation working through the corrected bounded path. Inspect other actual writers before changing `audit_events` grants; never disable unrelated auditing. Prove no affected application path retains a database privilege or RPC route that can bypass authorization and mandatory atomic audit. Do not claim that application-layer checks alone prevent direct service-role writes.

**Migration:** exactly one new forward-only migration introducing only necessary function/policy/grant/transactional-interface changes. The migration must not add unneeded business relations or rewrite any previously published migration.

## 5. Application integration

Preserve the existing P3-003 UI and three-capability scope, P3-001 attorney entry, P3-002 applicant creation, client-profile independence, default-deny public sign-up, current jurisdiction-neutral model and existing authentic provider boundaries.

Change only directly affected paths: replace privileged consequential writes with bounded transactional operations; pass real request-scoped identities; retain current field/lifecycle validations; reliably surface failures; retain retry/idempotency and ambiguous persistence semantics; remove obsolete bypassing helpers after callers migrate; preserve required existing reads, evidence and evaluation behavior. Necessary failure-state integrations in attorney/staff route paths are allowed only when causally needed by this correction. No new auth system, extra providers, product features, new billing/booking flow or broad refactor.

## 6. Permitted bounded engineering iteration (within this Packet)

Once **Gate 2 implementation is separately owner-authorized**, Claude may investigate root causes, inspect the actual in-scope implementation, choose the smallest technically correct approach, edit permitted files, debug failures, correct tests, write necessary regression coverage and iterate locally within the unchanged Packet. Correcting a failed test or discovered implementation bug **within ALLOWED_SCOPE** does not require a new owner decision per edit, a new Packet, or re-review of unchanged code. The implementation may use multiple forward-only commits as permitted by the adopted workflow, preserving full history. Preserve exact approved file and migration boundaries.

This grants **no standing shell, Bash, network, credential, environment or Git publication permission**. Claude's effective native-file permission prompts and denies remain operative; the user may approve individually requested **authorized native file edits** per UOM/C1. Human test/install/validation commands and their side effects remain subject to the existing separately reviewed and owner-authorized execution boundary; repeated execution of an already authorized bounded validation block does not require creating a new governance work item. Claude cannot silently edit `.github/**`, historical migrations, Packet files or other denied paths using alternate tools, worktrees or identities.

**Class A — routine in-scope correction:** continue under the same Packet and implementation gate; retain test failures and original evidence; repair with ordinary new edits/commits. A bounded owner-authorized execution block may be rerun within its existing permitted scope. Exact prior tests need not be re-audited absent material changes.

**Class B — STOP → REPORT → WAIT:** unexplained canonical drift, changed source/branch/baseline, Packet/hash/authority conflict, history anomaly, additional/edited migration, out-of-allowlist path, denied file/network capability, service/environment mismatch, authorization design requiring new capabilities or policies, inability to prove R1/R2/R3, or security failure demanding material scope expansion. Record precise blocker and smallest required separate owner decision. Never use local convenience to override locked authority or rewrite controlled history.

A new diagnostic finding may alter the technical implementation **inside** the accepted envelope, but may not alter the fixed Git ancestry, the exact Packet, the one-new-migration limit or the separate publication/review/deployment gates.

## 7. Required real-PostgreSQL security proof

Use a disposable PostgreSQL instance loaded with the **fourteen unmodified historical migrations**, plus the single P3-904 migration. Compare full historical migration filenames and SHA-256 hashes to the canonical inventory before/after. No fake production or business records: isolated synthetic test fixtures are allowed only in the disposable test database, clearly labelled test data and never represented as live evidence.

**Authorization matrix:** active, correctly scoped User/Staff; inactive User; inactive Staff Profile; revoked/expired/future/wrong-jurisdiction/resource-restricted grants; unrelated attorney/client; unauthenticated caller; spoofed actor; unsupported operations/payloads. Verify expected allow/deny at the **database write boundary and relevant RLS reads**.

**Concurrent PostgreSQL sessions (deterministic interleavings):** revocation before authorized write; write obtaining valid locks before subsequent revocation; User suspension; Staff Profile deactivation; grant scope/jurisdiction change; target record lifecycle conflict; timeout/deadlock/conflict rollback. Report transaction order, locks, commit/rollback results and precisely when authority is evaluated.

**Atomicity:** domain failure prevents success audit; audit failure prevents committed domain mutation; subject-association failure rolls back evidence; partial multi-record failure rolls back all; ambiguous response does not invent success; repeated request does not duplicate consequential records.

**Effective privilege proof:** direct retired M4 writes fail under ordinary authenticated role and previously privileged application route; no bypassing function execution or inherited privilege remains. Verify effective table/column DML, default function EXECUTE grants, function owners, schema exposure and request-scoped identity.

**Regression:** relevant P3-001 entry, P3-002 creation, P3-003 A1–A16, independent Client Profile, D-04 default-deny, existing provider binding, immutable evidence/audit behavior and eligibility boundaries. Never treat a structural `rosuno-guard` PASS as R1/R2/R3 security acceptance.

## 8. Protected Git integration — P2-914 adopted route

**The prior P3-904 candidate's conditional Stage A merge of the uncorrected P3-003 branch is superseded and is NOT authorized.** No unsafe original merge is needed or permitted merely to make CI pass.

P2-914 merged through owner PR #88 and modified the owner-trusted guard and narrowly required approval fetch. Its exception is selected **only** for the exact P3-904 correction branch, correct owner `main` target, trusted PR author/source/binding, original pinned P3-003 history and independently approved P3-904 Packet. No generic exception, test-only status or alternate control path.

Required sequence, each at its **own later owner gate**:

1. Owner adopts the **exact** Gate 0 PASSed P3-904 Packet. Verify exact text SHA-256/blob, identifier compatibility and authority before adoption.
2. Owner publishes a Packet-only commit on the explicitly approved Owner P3-904 branch rooted at the **then independently verified owner `main`**, without inventing future commit identities; authenticated owner approval branch must be available to the protected guard.
3. Builder publishes the **same exact Packet bytes** as its sole Packet-only first commit on `wi/P3-904-p3-003-security-correction`, parent exactly original P3-003 HEAD `b3fda55231625d440f3aa536e36c30e1dbb5b94a`. Verify owner/Builder Packet blob equality, source identity and branch constraints. Owner Packet branch base need not be the Builder correction base; the approved P2-914 exception handles the two independent Packet ancestries.
4. After separate Gate 2 implementation authorization, Claude implements **only** the adopted P3-904 envelope as linear forward-only correction commits on the Builder branch. Require at least one substantive correction commit and exactly one new migration. Preserve original eight P3-003 implementation commits and both Packets unchanged.
5. Perform the mandated real-PostgreSQL safety and regression tests, full controls and genuine combined `rosuno-guard` on the actual committed correction HEAD; retain the exact-head evidence. The guard rejects missing/incomplete correction segments, drift, unexpected commits, forged approval or out-of-scope migrations.
6. Publication, Owner-created protected PR from the Builder correction branch into Owner `main`, exact-head Independent Backup security review, required CI, designated `Rosuno` human approval and protected two-parent merge each require their applicable separate owner authorizations. **Independent security PASS is mandatory even if structural CI is green.** Never merge or deploy the uncorrected P3-003 branch alone.
7. Repository merge provides **no** Supabase, Replit, production, release or activation authorization. Any later staging migration application must have its own verified migration/history/security preflight and explicit approval.

No update-branch action that rewrites source ancestry, merge-base or original commits. No squash/rebase, cherry-pick, force push or amendment. Any change to owner base or effective trust/protections requires read-only reconciliation and, if unexplained, STOP.

## 9. Validation and evidence

Retain evidence bound to the genuine implementation tree and the actual reviewed executable commands. Expected existing repository validation commands, executed only through the owner-authorized human command procedure:

```sh
pnpm install --frozen-lockfile
pnpm run p2:application-shell:test
pnpm run format:check
pnpm run typecheck
pnpm run build
pnpm run p0:validate
pnpm run p0:test
pnpm run secrets:check
pnpm run dependency:check
git diff --check
```

Additionally: P3-904-specific PostgreSQL security/concurrency/rollback tests, exact authorization and migration inventory, P3-003 acceptance regressions, real committed-head `rosuno-guard` including genuine owner approval refs and unchanged historical ancestry. The final evidence must include the new migration filename/hash, original migration hashes, function signatures/owners/grants, effective table access, RLS behavior, exact test configurations/results, original and new commit/parent/tree hashes, Packet hashes, changed-file scope, CI/reviewer status and documented STOPs. Failed results remain failed until subsequent runs independently demonstrate correction; no fabricated PASS.

Only tests actually run may be reported as passing. Reuse previously accepted **byte- and configuration-bound** test evidence where still applicable; do not rerun source audits or validations merely for ceremony. New changed bytes require the relevant affected validations and exact-head security assessment.

## 10. Explicit exclusions and Gate 0 review checklist

- Preserve jurisdiction-neutral, multi-state Rosuno architecture; no California-specific assumptions.
- Attorneys remain independent legal-service providers; Rosuno provides marketplace technology, not legal services.
- No policy, regulatory, payment, verification or eligibility authority may be inferred from AI output.
- No new tables, customer/business records, fictitious professional approvals, staff capabilities, authentication routes, providers, booking/payment flows, infrastructure configuration or secrets.
- No OLD Supabase reference copy/reactivation, no live database mutation, no branch/PR/merge or release under this candidate.
- This Packet neither modifies nor replaces the P3-003 original Packet or the P2-914 accommodation.

**Independent Backup Gate 0 must examine:**

1. Eleven current LOCKED authority originals, adopted UOM/C1, exact candidate bytes, original P3-003 authority and scope; verify `P3-904` identifier against controlling roadmap/registry.
2. Original P3-003 commit/Packet ancestry and current P2-914 integrated guard, no conflicting trust/merge requirements.
3. Existing and proposed consequential attorney/staff write coverage, including P3-002 creation.
4. Real database RLS/ACL, existing function semantics, service-role bypasses, concurrency and atomic audit feasibility; whether one new migration and the allowlist suffice.
5. Explicit practical boundaries for ordinary local in-scope corrective cycles versus true STOP conditions, consistent with UOM/C1 effective Builder and human command permissions.
6. Absence of invented PASS, new business scope, historical edits or unauthorized integration steps.

Return **PASS — READY FOR OWNER ADOPTION** only with sufficient evidence; otherwise **HOLD** with the exact unresolved constraint. Gate 0 review may identify a required change to this *unadopted candidate*; it may not authorize implementation or quietly expand scope.

**Current outcome: CANDIDATE FOR INDEPENDENT BACKUP REVIEW ONLY. No adoption/publication/implementation authorized. STOP.**
