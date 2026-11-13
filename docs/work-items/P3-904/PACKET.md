WORK_ITEM: P3-904
TYPE: FIX
BRANCH: wi/P3-904-p3-003-security-correction
BASE_SHA: 299a0e8d72f77e0b440c15eb5c7ffd29e7fd4061
MIGRATIONS: new allowed
ALLOWED_SCOPE:
- supabase/migrations/*
- apps/web/app/attorney/*
- apps/web/app/staff/*
- apps/web/src/application/attorney-application.ts
- apps/web/src/application/attorney-professional.ts
- apps/web/src/application/eligibility-assessment.ts
- apps/web/src/application/policy-selection.ts
- apps/web/src/application/professional-audit.ts
- apps/web/src/application/professional-identity.ts
- apps/web/src/application/professional-records.ts
- apps/web/src/application/staff-verification.ts
- apps/web/src/infrastructure/identity/attorney-application-provisioning.ts
- apps/web/src/infrastructure/identity/registration-provisioning.ts
- apps/web/src/infrastructure/professional/*
- apps/web/src/infrastructure/staff/*
- apps/web/src/presentation/professional-labels.ts
- apps/web/tests/*
- docs/work-items/P3-003/PACKET.md
- governance/decision-log.json
- governance/migrations/reviewed-migrations.json
- governance/work-items/index.json
FORBIDDEN_SCOPE:
- rosuno-authority/*
- docs/process/*
- .github/*
- .claude/*
- .mcp.json
- CLAUDE.md
- CLAUDE.local.md
- AGENTS.md
- tools/*
- supabase/config.toml
- supabase/seed*
- supabase/seeds/*
- governance/evidence/*
- governance/releases/*
- governance/schema-drift/*
- governance/environments/*
- governance/work-items/schema.json
- governance/work-items/template.json
- .replit
- .replitignore
- package.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- .npmrc
- .env
- .env.*
- .gitmodules

# ROSUNO P3-904 — P3-003 Security Correction (Packet revision 3)

**STATUS: REVISION 3 GATE 0 REVIEW CANDIDATE — NOT ADOPTED; NOT EXECUTABLE.** On owner adoption this revision replaces
revision 1 (blob `b4b6fc9f080f28b3a385ad09f3431c9a8c3f2bba`, SHA-256
`ba9783cd7a4125993f7107373ba7264259a02be51fe437fcbcdc35cd43dcbcbd`) by a forward-only owner commit on owner branch
`wi/P3-904-p3-003-security-correction` (UOM v1.7.10 §16.2). Revision 1 remains in history. §4.2a is a **new security
requirement proposed for owner approval**; adopting this revision adopts it.

## 0. Changes from revision 1

1. Authority: UOM v1.7.10, C1 rev5.11 and DL-ENG-1 replace UOM v1.7.8 and C1 rev5.9 (§1).
2. Integration: the guard v3 route replaces the P2-914 combined-history route and the revision 1 §8 sequence. P2-915
   (PR #91) and P2-918 are superseded; no step of this work item depends on them (§8.4).
3. Header: `BASE_SHA` is provenance, the owner `main` this revision was written against. ALLOWED_SCOPE adds the five
   P3-003 files that the combined net diff carries, the carried P3-003 Packet (listed literally) and the three governance
   files that migration registration requires (§9). `governance/*` and `docs/work-items/*` leave FORBIDDEN_SCOPE because
   FORBIDDEN wins and the allowlist is exhaustive; specific governance control paths stay forbidden.
4. Recovery: the original P3-904 commits, recovered from the owner-supplied evidence archive and verified in an isolated
   repository, are carried unchanged (§2.2, §8.1). Recovery establishes provenance only, not acceptance.
5. Execution: autonomous local engineering under the owner's grant (C1 rev5.11 §C1.2) replaces the revision 1 human
   command procedure (§6).
6. **New security requirement proposed for owner approval (§4.2a):** the database derives or verifies every persisted
   eligibility evaluation and rejects forged or unsupported determinations. Revision 1 did not settle this: its Gate 2
   implementation treated porting the eligibility engine to SQL as outside revision 1 and disclosed the gap as an
   unresolved risk. §4.2a adds no file, migration, eligibility factor or policy.
7. R2 names the actual historical column `staff_profiles.staff_state` (§3).
8. P3-002 applicant creation: the atomic-audit proof of §4.2 applies to the listed consequential operations; initial
   applicant creation keeps its accepted P3-002 behaviour (§4.2b).
9. The single P3-904 migration may be corrected before merge (DL-ENG-1 R8); it remains exactly one new migration (§4.6).
10. Governance registration is specified exactly: one migration row (P2-007 unapplied-candidate precedent), one
    work-item record and one Decision Log record, which the existing validators require for an appended migration (§9).

Unchanged in substance: R1–R3 (§3), §4.1 and §4.3–§4.6, the real-PostgreSQL proof (§7, extended for §4.2a), the
one-new-migration limit, the exclusions (§12) and every separate publication, review, merge and Supabase gate.

## 1. Authority, security status and gates

Controlling order: the eleven original LOCKED Rosuno authorities; UOM v1.7.10 (SHA-256
`e93cad1c43ffd9bd63d5d80af9542a8130f62145c1738397cbaf585d02d10df6`), in particular §§3A, 15, 16, 22, 28, 59 and 60;
C1 rev5.11 (SHA-256 `fc55f5c7aa934e96383e065edfba1867b70e1325a52ecee45378ad354f06887c`), §§C1.2–C1.6; DL-ENG-1
(SHA-256 `d3e84ddcd940cd8feefe4a6718e759d46546c756c09882e1c048e591d6e09b17`), rulings R1, R3, R5, R6, R8 and R10–R13;
the adopted P3-003 Packet (blob `c394078a7440d5e48bce81c33d7a581d951d1c74`, SHA-256
`43c8e164211772d673216595b8b025ba4423f7598eb5a01678426a23eed3a782`) and its acceptance criteria A1–A16; the adopted
P3-002 Packet and its accepted P2-913 closure, for applicant creation; this Packet. Locked sections relied on, by
reference only: Technical Architecture v0.2 §40 (audit architecture) and §55 (consequential revalidation rule); MVP
Build Specification v1.0 §20 (audit) and M4. No private authority text is copied here. MB-A1 is not engaged.

Risk: security FIX with a migration. Independent review of this revision and of the exact head is required
(UOM §59.1).

**Security status.** Recovering the original implementation (§2.2) proves its provenance only. The eligibility
decision-integrity defect (§4.2a) and every R1–R3 outcome remain open until the corrected implementation passes the §7
real-PostgreSQL proofs, including the §4.2a negative tests, and the exact-head independent security review.

P3-003 is implemented on the Builder branch but has never been independently accepted as safe. It merges only together
with this correction, never alone.

Gates, each separate: independent review and owner adoption of this revision; the owner's local-engineering grant
naming this Packet blob; Builder publication of an exact reviewed head (one `git push origin
wi/P3-904-p3-003-security-correction`, approved at the owner's prompt); owner PR; required CI; exact-head independent
security review (mandatory even when CI is green); designated human review; owner merge. A repository merge authorizes
no Supabase, Replit, Production, release or activation action. Staging application has its own gates (§8.5). OLD
Supabase is never touched.

## 2. History, provenance and reuse

### 2.1 Preserved history

- P3-003 Packet commit `405956f9f4a14432a12fc7eacb10e33c0278e39d` (parent
  `8449593d0baccac377f4884ede522d00fa1cc997`) and the eight P3-003 implementation commits ending at
  `b3fda55231625d440f3aa536e36c30e1dbb5b94a` (tree `c9823d197923c17c146bdc10b0ec47a1cc8564c0`).
- P3-904 Packet-first commit `b90c1ca17daaaae10b63c70acc31842efc673d87` (parent `b3fda55…`), carrying revision 1.
- Owner Packet branch: revision 1 commit `279a066b2fb3a46aecec5554d4f680344d14b0a3`; this revision follows it.

All of these stay byte-identical: no rewrite, rebase, squash, cherry-pick, amend or force push. History shape is
otherwise free under guard v3, and integration merges of current owner `main` are normal. The Packet copy on the branch
changes only to synchronize an adopted revision (UOM §16.4), in a commit of its own.

### 2.2 Original P3-904 implementation (recovered; carried unchanged)

- `2cfd62900f3d4281fb813f9e1ceac4cafc6d226e` (parent `b90c1ca…`): adds the single P3-904 migration.
- `90ef51fcaac6d5737ed41cd4465dc99bcb7c9898` (parent `2cfd629…`).
- `1c4acec9df60fa0c59f8bd61e8053d744ed36478` (parent `90ef51f…`, tree `c585ff8046e69278c4c8b0cce868c1a469019f28`).
- Migration `supabase/migrations/20261106090000_p3_904_professional_write_boundary.sql`, added only in `2cfd629…` and
  not changed since, blob `d54a86e20f57bde5c09f38bdc2d95ecc8b28391c`, SHA-256
  `16c57427fb59fb66c789f1a2e8036ddc3d8063ff8e8c694c8adea202b42f6b77`.
- Evidence archive `p3-904-gate2-evidence.tar.gz`, SHA-256
  `f641fde3fd69fe38fab61d099f41163ac7f79a7878c23bddd3c92085301e2e3e`; its Git bundle
  `01-git/p3-904-implementation.bundle`, SHA-256 `f7cc1dc7a52282d7ef242de031b32308f36bd45665e43b3cd4064889895461d6`,
  records a complete history (226 commits, no prerequisites).
- Isolated recovery verification (2026-11-13, disposable repository outside the canonical checkout): bundle verified;
  `git fsck --full --strict` clean; commit chain, parents, head tree, introducing commit and migration bytes as above;
  the fourteen historical migration blobs identical to owner `main` `299a0e8d72f77e0b440c15eb5c7ffd29e7fd4061`; all 39
  net-diff paths from `8449593…` inside ALLOWED_SCOPE with exactly one new migration; no non-regular object,
  credential-like path or private-authority path in any of the 13 commits after `8449593…`.

These commits are on no published branch. They are carried unchanged as the next commits after `b90c1ca…`, and every
correction follows as a new commit. Carrying them accepts none of their tests, evidence or earlier results; everything is
re-validated on the final head. If the canonical import (§8.1) does not reproduce these identities: STOP (Class C).

## 3. Correction goal and fixed security outcomes

The P3-003 work has not been independently accepted as safe for affected operations. Correct **R1, R2 and R3
together** while preserving P3-003 acceptance criteria A1–A16 (especially A4, A7, A8, A10 and A11), existing P3-001
attorney access and P3-002 applicant creation. These are security defects, not permission to redesign the product.

**R1 — Authorization-to-write race:** The service-role `registration-provisioning.ts` path performs direct privileged
professional, evidence, review and evaluation writes. Application-level re-checks cannot prevent revocation or
deactivation between the final check and the decisive database write. Place effective, operation-specific
authorization at the consequential database write boundary, with valid concurrency semantics and no bypass.

**R2 — Inactive principal reads:** `public.has_manage_attorney_verification_scope(uuid, boolean)` checks grants and
jurisdiction but does not deny inactive Rosuno Users (`users.account_state`) or Staff Profiles
(`staff_profiles.staff_state`, the column renamed from `lifecycle_state` by historical migration
`20260901012518_p1_authorization_scope_correction.sql`). Correct the predicate and the RLS behaviour that depends on it
without changing legitimate scope semantics. The predicate is defined in historical migration
`20260910075939_p1_attorney_verification_eligibility_foundation.sql`, which is on owner `main` and recorded as applied
to Staging; it is corrected only through the new forward migration (DL-ENG-1 R8).

**R3 — Non-atomic audit:** `runAuditedChange` uses separate requests for attempt, consequential mutation and outcome.
The mandatory final audit event and the consequential domain mutation must commit in the same database transaction,
including evidence-subject linkage where required. Failure of either side rolls back the transaction.

Reuse the existing relations, authorization grants, identity associations, evidence-subject tables, immutable audit
structure and lifecycle and eligibility semantics. Invent no staff policy, professional status, attorney eligibility,
verification evidence, production identity or regulatory decision.

## 4. Database design and implementation acceptance

### 4.1 Existing staff capability predicate (R2)

Keep the existing signature and return type: `public.has_manage_attorney_verification_scope(required_jurisdiction
uuid, allow_any_jurisdiction boolean) returns boolean`. Require a trusted matching authenticated principal, an active
Rosuno User, an active Staff Profile, a current unrevoked `manage_attorney_verification` grant, valid grant effective
times and the existing jurisdiction and resource restrictions. Preserve global and jurisdiction scope semantics.
Missing, inactive, ambiguous or stale authority denies. Enforce appropriate execution privileges and a controlled
`search_path`. This read-policy correction alone does not solve the privileged-write problem in R1.

### 4.2 Consequential operations — bounded design freedom

Design the **smallest safe set of operation-specific, typed PostgreSQL interfaces or demonstrably equivalent narrowly
bounded database operations**. Choose exact signatures only after inspecting the actual tables, owners, auth semantics,
grants and callers. No generic text/JSONB table-dispatch RPC, new generic permission layer, new business table or
general-purpose service abstraction is authorized. No implementation-specific signature is preapproved here.

Cover the existing attorney actions: applicant profile details; approved-profile presentation fields; license-claim
insert and revision; insurance-claim insert and revision; practice-area request insert, revision and withdrawal;
applicant submission.

Cover the existing staff actions: evidence recording with its mandatory subject association; source-unavailable
recording; license-source observation; discipline finding creation and permitted status transitions; practice-area
authorization decisions; Attorney Profile review transitions; consequential eligibility-evaluation persistence (§4.2a).

For each consequential operation listed above, prove: the correct authenticated actor and linked profile; allowed
columns; ownership; lifecycle state; jurisdiction and capability; concurrency guards; non-forgeable identity; atomic
audit; and failure behaviour. Attorney profile update inputs cannot control the professional verification decision,
policy or eligibility authority, or staff capabilities. Possessing a service-role credential never implies
authorization. Initial applicant creation is governed by §4.2b.

### 4.2a Decision integrity of persisted eligibility evaluations — NEW SECURITY REQUIREMENT PROPOSED FOR OWNER APPROVAL

**Status.** This requirement is not settled by revision 1. Adopting this revision adopts it. It is grounded in the
adopted P3-003 criteria A7 (eligibility consumes only actual approved and effective policy and evidence; never invented
eligibility) and A8 (complete, immutable evaluations), and in locked Technical Architecture §40 (eligibility decisions
are sensitive state-changing operations whose records are server-generated) and §55 (persisted Evaluations are the
historical evidence of what Rosuno knew). It adds no file, migration, eligibility factor, threshold or policy.

**Confirmed defect.** Under R1 and §4.3, staff eligibility-evaluation persistence runs under the real request-scoped
authenticated session, so any principal holding EXECUTE can call it directly, including an authorized staff member
acting outside the application. The recovered `public.staff_record_eligibility_evaluation` checks the caller's
authority, the reference shape, the attorney and jurisdiction ownership of referenced IDs, a recent `as_of`, and writes
the evaluation and its audit event atomically. It does not derive or verify the determination: it stores the caller's
`p_result` and `p_factor_results` verbatim; it accepts any existing `attorney_eligibility` policy version of the
jurisdiction whatever its status, effective window, mode or authority provenance; it accepts empty policy, factor and
evidence sets with any result, including `eligible`; it does not consult record states, the target's User account or
Attorney Profile lifecycle, or a
practice-area authorisation; and it validates references before the staff lock without locking the referenced rows. An
authorized staff caller can therefore persist an evaluation, including `eligible`, that the P3-003 assessment did not
produce or support.

**Requirement.** The persisted `result`, `factor_results`, `policy_references` and `evidence_references` are
consequential decision records and must not be caller-authored. The single P3-904 migration corrects
`staff_record_eligibility_evaluation` (or its replacement interface) so that, in the same transaction, after the staff
lock and with the referenced rows locked per §4.4, the database derives those values from the canonical rows or
verifies the submitted values against them. They must match exactly the assessment that the adopted P3-003 engine
(`eligibility-assessment.ts` with `policy-selection.ts`) produces from those rows at `as_of`; any difference is
rejected with nothing persisted. In particular:

- **Policy.** When the P3-003 selection rule selects a policy (type `attorney_eligibility`, approved and active as that
  rule defines, effective at `as_of`, mode-neutral and backed by verified authority provenance), the policy reference is
  exactly that version. When it selects none, the policy reference set is empty, the policy factor is undetermined, and
  the evaluation persists with the `undetermined` or `not_eligible` result the engine produces. Missing policy never
  produces `eligible`, and a reference to any other version is rejected.
- **Records and evidence.** Every referenced license, insurance, discipline and practice-area record and every evidence
  item belongs to the target attorney and to the evaluation's jurisdiction, and each record outcome is the one the
  engine derives from the record's current state.
- **Account and profile.** The account and profile factors are derived from the target's User account and Attorney
  Profile rows exactly as P3-003 derives them: a suspended User account makes the account factor fail, and a suspended
  Attorney Profile makes the profile factor fail.
- **Practice area.** For a practice-area context the factor follows P3-003: a missing required authorisation fails, a
  pending (requested) authorisation is undetermined, and an authorisation that the selected policy does not require is
  not required.
- **Composition.** The overall result is the P3-003 composition of the derived factors: `not_eligible` when any factor
  fails, otherwise `undetermined` when any factor is undetermined, otherwise `eligible`. `eligible` therefore requires
  every applicable factor to pass under the selected policy.

**Forged versus truthful negative evaluations.** An unauthorized operation (§4.4 and the §7 authorization matrix) and a
forged or unsupported determination are rejected. An authorized staff operation that records the truthful
`not_eligible` or `undetermined` assessment the engine derives is permitted and persists with its atomic audit,
including for a suspended User account or Attorney Profile, a missing or pending practice-area authorisation, or a
jurisdiction with no selectable policy.

**Limits.** The database may encode only the factor, selection and composition rules already adopted in P3-003
(A6–A8) and implemented in `eligibility-assessment.ts` and `policy-selection.ts`. It may not add, remove or reinterpret
any factor, threshold, policy status or policy parameter, and it confers no assessment authority beyond P3-003. If an
adopted rule cannot be decided in the database without interpreting policy content beyond P3-003: STOP (Class B) and
report the rule. Never fall back to persisting caller-authored results.

### 4.2b Initial applicant creation (P3-002)

Because direct DML on `attorney_profiles` is revoked (§4.6), P3-002 initial applicant creation moves to an
independently bounded database operation for the caller's own active User. It keeps the behaviour accepted under the
adopted P3-002 Packet and its P2-913 closure: one initial Attorney Profile in applicant state, no privilege conferred,
duplicate prevention, and no conversion of uncertain persistence into success. P3-904 neither adds nor removes an audit
obligation for it. Basis: neither the adopted P3-002 Packet nor its accepted closure requires an audit event for
applicant creation; locked Technical Architecture §40 and MVP Build Specification §20 tie audit to sensitive,
privileged, authorization, policy, money and verification operations, and the P2-913 closure records that applicant
creation confers no privilege. Any proposal to audit applicant creation is a separate FIX Packet against P3-002.

### 4.3 Function safety and privilege isolation

Inspect actual definer and invoker semantics and ownership. Revoke default `PUBLIC` execution as necessary, grant the
minimum appropriate roles, constrain `search_path`, avoid untrusted dynamic SQL, and reject unsupported parameters and
caller-supplied authoritative actor IDs. An authenticated RPC uses the real request-scoped authenticated session, never
a service-role request with a spoofed `user_id` argument. Review role inheritance and effective grants. If safe
privilege isolation cannot be proven for an existing necessary caller, report a concrete scope or authority blocker
rather than keep an unsafe bypass.

### 4.4 Revocation-serializable authorization (R1)

In the **same transaction** as the protected mutation, verify and hold appropriate locks over the User active state,
the Staff Profile state, the applicable capability grant, the target Attorney Profile and the affected professional
record, as necessary. Use a consistent lock order against legitimate grant revocation, suspension, deactivation,
expiration, scope revision and record-state changes. Prove these serialization semantics:

- Revocation or deactivation committed before the decisive authorization check causes denial.
- A mutation that has already validly acquired its authorization locks may complete before a later revocation commits.
- Authority cannot become invalid between the decisive check and the write without a serializable conflict or locking
  outcome.
- Deadlock, lock timeout, conflict and stale lifecycle roll back and fail closed.

Repeated application-level checks or an unlocked `SELECT` do not suffice. Use correct grant effective-time semantics.

### 4.5 Atomic domain mutation and audit (R3)

Write the mandatory final audit event **in the domain mutation's own database transaction**. If the final audit insert
fails, no domain change commits. If the domain change fails, no false success audit exists. Evidence and its required
evidence-subject links are atomic. Multi-record findings leave no misleading partial artifacts.

Preserve: append-only `audit_events`; actual actor attribution; jurisdiction and resource references; material
before-and-after evidence; reason and policy references where applicable; truthful retry and ambiguity reporting.
Optional attempt telemetry is not a substitute for atomic final success. Never fabricate an audit outcome after an
ambiguous network failure.

### 4.6 Database bypass prevention and the single migration

Retire the affected privileged direct DML interfaces once every valid caller has migrated, and remove bypassing
permissions as needed. Inspect these actual M4 relations independently: `attorney_profiles`, `licenses`,
`insurance_records`, `discipline_records`, `practice_area_authorisations`, `verification_evidence`,
`verification_evidence_subjects`, `eligibility_evaluations`.

Preserve necessary reads and legitimate unrelated operations. For `attorney_profiles`, keep P3-002 initial applicant
creation working through the bounded path of §4.2b. Inspect other actual writers before changing `audit_events` grants,
and never disable unrelated auditing. Prove that no affected application path keeps a database privilege or RPC route
that bypasses authorization and mandatory atomic audit. Application-layer checks alone never prevent direct
service-role writes.

**Migration.** Exactly one new forward-only migration across the whole branch: the recovered
`20261106090000_p3_904_professional_write_boundary.sql` (§2.2). It is neither merged to owner `main` nor applied to any
persistent environment, so later commits may correct it before merge (DL-ENG-1 R8); the original introducing commit and
bytes stay in history. It is never split into a second migration. Its timestamp must sort after the newest migration on
owner `main` (`20261020070000` at `BASE_SHA`); if a later migration reaches `main` first, a later commit may rename the
unmerged file. No historical migration is edited, deleted, renamed or replayed. The migration makes only necessary
function, policy, grant and transactional-interface changes and adds no business relation.

## 5. Application integration

Preserve the existing P3-003 UI and three-capability scope, P3-001 attorney entry, P3-002 applicant creation,
client-profile independence, default-deny public sign-up, the jurisdiction-neutral model and the existing authentic
provider boundaries.

Change only directly affected paths:
- replace privileged consequential writes with bounded transactional operations, passing real request-scoped
  identities;
- keep the current field and lifecycle validations, and surface failures reliably;
- keep retry, idempotency and ambiguous-persistence semantics;
- remove obsolete bypassing helpers once their callers have migrated;
- keep the required existing reads and the evidence and evaluation behaviour.

Failure-state changes in attorney and staff routes are allowed only when this correction causally needs them. The five
carried P3-003 files listed in ALLOWED_SCOPE (`eligibility-assessment.ts`, `policy-selection.ts`,
`professional-identity.ts`, `professional-records.ts`, `professional-labels.ts`) are listed so the combined net diff can
carry them. Change them only where R1–R3 or §4.2a causally require it, and never to change an adopted eligibility rule.
No new auth system, provider, product feature, billing or booking flow, or broad refactor.

## 6. Engineering under the grant

With this revision adopted and the owner's local-engineering grant for its blob (C1 rev5.11 §C1.2), the Builder may,
without per-edit or per-command approval:
- read, edit, build, debug, test and refactor within ALLOWED_SCOPE;
- run the §10 command set and disposable PostgreSQL proofs with synthetic data only;
- commit forward-only, each message starting `P3-904:`;
- merge current owner `main`, fetched from the owner repository, into the branch;
- correct the single unmerged P3-904 migration;
- run the guard self-check and send the review package.

It may not push, create or touch a PR, use any remote database, connector or credential beyond the session's Access
Profile, or touch a path outside ALLOWED_SCOPE, even temporarily.

- **Class A** — failed tests, defects or review findings inside this Packet: fix them, re-test and commit on the same
  branch under the same grant.
- **Class B** — STOP → REPORT → WAIT:
  - a needed path, migration or capability outside this Packet;
  - an authorization or eligibility design question the adopted authorities do not settle, including any §4.2a rule
    that would need interpretation beyond P3-003;
  - inability to prove R1, R2, R3 or §4.2a;
  - any need to edit a historical migration;
  - a validator requirement that §9 cannot meet truthfully.
- **Class C** — STOP → REPORT → WAIT: unexplained drift in owner `main`, the branch, the Packet, the recovered objects,
  migration bytes or the effective settings; an unexpected permission prompt or refusal.

A new diagnostic finding may change the technical design inside this envelope. It never changes the file scope, the
one-migration limit or the gates.

## 7. Required real-PostgreSQL security proof

Use a disposable PostgreSQL 16 instance, built with the system binaries as the existing repository harnesses do. Load
every migration on current owner `main` unmodified (fourteen at `BASE_SHA`), plus the single P3-904 migration. Compare
the full historical migration filenames and SHA-256 hashes with owner `main` before and after. Isolated synthetic
fixtures are allowed only in the disposable database, labelled as test data and never presented as live evidence.

**Authorization matrix:** active, correctly scoped User and Staff; inactive User; inactive Staff Profile; revoked,
expired, future, wrong-jurisdiction and resource-restricted grants; unrelated attorney or client; unauthenticated
caller; spoofed actor; unsupported operations and payloads. Verify the expected allow or deny at the database write
boundary and on the relevant RLS reads.

**Concurrent sessions (deterministic interleavings):** revocation before an authorized write; a write that obtains
valid locks before a later revocation; User suspension; Staff Profile deactivation; grant scope or jurisdiction change;
target record lifecycle conflict; timeout, deadlock and conflict rollback. Report transaction order, locks,
commit/rollback results and exactly when authority is evaluated.

**Atomicity:** a domain failure prevents a success audit; an audit failure prevents a committed domain mutation; a
subject-association failure rolls back the evidence; a partial multi-record failure rolls back everything; an
ambiguous response invents no success; a repeated request duplicates no consequential record.

**Decision integrity (§4.2a):** calling the evaluation interface directly as an authorized, correctly scoped staff
principal, each of these is rejected with nothing persisted:
- a result, factor outcome, record outcome, policy reference or evidence reference that differs from the derived
  assessment;
- `eligible` without a selected policy, or with empty factor or evidence references;
- a draft, review, scheduled, suspended, retired, expired, future, mode-specific or unverified-provenance policy
  version, or any version other than the one the P3-003 selection rule selects, including any version when none is
  selectable;
- a record or evidence item of another attorney or another jurisdiction;
- a passing account or profile factor for a suspended or otherwise non-qualifying User account or Attorney Profile;
- a practice-area factor outcome that differs from the derived one.

Each of these truthful evaluations is permitted and persists exactly the derived values with its atomic audit:
- `undetermined` with an empty policy reference set when no policy is selectable;
- `not_eligible` without a selected policy when a definite fact fails, for example a suspended User account;
- a suspended User account (account factor fails) and a suspended Attorney Profile (profile factor fails);
- a missing required practice-area authorisation (factor fails), a pending authorisation (factor undetermined), and an
  authorisation the selected policy does not require (factor not required).

A valid evaluation persists exactly the derived values. A parity test runs identical synthetic fixtures, including
these negative and undetermined cases, through `assessEligibility` and the database interface and requires identical
results. Each rejection test fails against the recovered uncorrected function where that function accepts the input,
and passes after the correction.

**Rollback and catalog reconciliation (backs §9):** applying the migration inside a transaction that is rolled back
returns the catalog exactly to its prior state; a committed disposable application produces a before/after catalog
diff that reconciles exactly with an explicit allowlist of the SQL objects the migration may create, replace, revoke or
grant; the evidence report is retained. Without this evidence §9 is not written.

**Effective privilege:** retired direct M4 writes fail for the ordinary authenticated role and for the previously
privileged application route; no bypassing function execution or inherited privilege remains. Verify effective table
and column DML, default function EXECUTE grants, function owners, schema exposure and request-scoped identity.

**Regression:** P3-001 entry; P3-002 creation with its accepted behaviour (§4.2b); P3-003 A1–A16; the independent
Client Profile; D-04 default-deny; the existing provider binding; immutable evidence and audit behaviour; eligibility
boundaries. A structural `rosuno-guard` PASS is never R1/R2/R3/§4.2a security acceptance.

## 8. Recovery, integration and gates

### 8.1 Canonical import (implementation session, after the grant)

- The archive's SHA-256 equals §2.2. Its members are listed before extraction and refused if any is absolute, contains
  `..`, or is a link or special file. It is extracted into a new, empty scratch directory outside the repository, and
  nothing in it is executed.
- Git objects are imported only from the verified bundle, into a non-branch local ref of the canonical checkout.
- The commit chain, parents, tree, introducing commit, migration blob and migration SHA-256 equal §2.2; the fourteen
  historical migration blobs equal owner `main`; every path changed in `b90c1ca..1c4acec` is inside ALLOWED_SCOPE; no
  commit contains a non-regular object, a credential-like path or a private-authority path.

The archive is kept unmodified outside the repository and cited by SHA-256; its contents are never committed.

### 8.2 Branch continuation

1. Create the local work branch at the verified `1c4acec…`, a fast-forward of the published `b90c1ca…`.
2. Commit the synchronized copy of this revision (exact bytes, verified blob).
3. Merge current owner `main` (no path changed on `main` since `8449593…` overlaps the branch).
4. Commit the corrections.
5. Make the §9 registration commit.

### 8.3 Guard

Guard v3 judges the net diff from current owner `main`. Before the review package,
`bash .github/scripts/rosuno-guard.sh <current owner main> HEAD wi/P3-904-p3-003-security-correction
refs/rosuno/approved` must print `ROSUNO-GUARD PASS work_item=P3-904 type=FIX`.

### 8.4 Superseded

The P2-914 combined-history route (retired by P2-919), revision 1 §8, P2-915 (PR #91) and P2-918. Closing or
withdrawing them is an owner action outside this Packet.

### 8.5 After merge

Staging application requires all of the following, each separately authorized:
- the migration on owner `main`;
- a fresh read-only preflight of the live Staging project: applied migration history and catalog drift against the
  recorded baseline (historical evidence alone is not live verification);
- Gate 5 rollback validation before Gate 6 application;
- separate owner authorization: owner-executed, or by the Builder only under an Access Profile that grants it.

Independent verification follows.

## 9. Governance registration (one commit, append-only)

After the correction is complete and the §7 proofs pass, one commit appends exactly three records and changes nothing
else. The existing validators require all three for an appended migration: a register row, a work-item record that
lists it, and at least one Decision Log record naming that work item.

- to `governance/migrations/reviewed-migrations.json`, one row, following the P2-007 unapplied-candidate precedent:
  `migration_id` `20261106090000_p3_904_professional_write_boundary`; `migration_kind` `product`; `sequence` 15;
  `artifact_path` the migration path; `authority_refs` naming existing locked authority identifiers only;
  `work_item_refs` the record below; `decision_refs` the decision below; `release_refs` empty; `reviewed` false;
  `reviewed_by`
  `pending designated human PR review`; `reviewed_at` null; `applied_environment` `none`; `non_production_validation`
  true and `drift_check` `clean`, each only once the §7 rollback and catalog-reconciliation evidence exists (as in the
  adopted P2-007 Packet, these describe the disposable database only and are not a claim that Staging was contacted or
  is current); `rollback_plan` a real forward-only plan (§11); `depends_on` the latest earlier registered migration
  (`20261020070000_p2_registration_abuse_control` at `BASE_SHA`).
- to `governance/work-items/index.json`, one record `WI-P2-P3-904-P3-003-SECURITY-CORRECTION`: priority `P2` (as the
  existing P3 records use); status `in_progress`; environment `none`; reviewer `Rosuno` with status `pending`;
  `decision_refs` the decision below; `release_refs` empty; `migration_refs` the migration above; `dependencies` naming
  only existing records the work depends on (`WI-P1-004-ATTORNEY-VERIFICATION-ELIGIBILITY-FOUNDATION`,
  `WI-P2-913-P3-002-GOVERNANCE-CLOSURE`); objective, scope, acceptance criteria and validation commands taken from this
  Packet; stating that the work carries and corrects P3-003.
- to `governance/decision-log.json`, one record `DEC-<UTC date of writing, YYYYMMDD>-P3-904-P3-003-SECURITY-CORRECTION`:
  status `accepted`, because the owner adopted this revision, citing the owner Packet commit that adopted it; owner
  `NatthanPrevot`; reviewer `Rosuno` with status `pending` until the designated PR review; `work_item_refs` the record
  above; `supersedes` empty; `expiry` null; `created_at` and `updated_at` the UTC time of writing. It records only what
  this revision decides: the R1–R3 correction, the §4.2a requirement, the §4.2b reading for applicant creation, and the
  unreviewed, unapplied migration candidate. DL-ENG-1 R3 also requires a Decision Log entry for a change that creates
  or interprets a requirement, which §4.2a and §4.2b do.

No record claims migration review, Staging application, release, live drift or reviewer approval. No existing record
changes. `p0:validate` and the full P0 suite must pass. If a validator requires a value that cannot be stated
truthfully: STOP (Class B); do not invent one. Post-merge closure and any Staging application record are separate
later work.

## 10. Validation and evidence

The Builder runs: `pnpm install --frozen-lockfile`; `pnpm run format:check`; `pnpm run typecheck`; `pnpm run build`;
`pnpm run p0:validate`; `pnpm run p0:test`; `pnpm run secrets:check`; `pnpm run dependency:check`;
`git diff --check <current owner main> HEAD`; the P3-904 disposable PostgreSQL proof; the guard self-check (§8.3).

Evidence:
- the archive SHA-256 and the canonical import verification;
- the new migration filename and hash, and the historical migration hashes;
- function signatures, owners and grants; effective table access; RLS behaviour;
- exact test configurations and results, including the §4.2a negative tests and parity test;
- original and new commit, parent and tree hashes;
- Packet hashes; changed-file scope; CI and reviewer status; documented STOPs.

Only tests actually run are reported as passing. Failed results stay failed until a later run demonstrates the
correction. Earlier evidence is reused only where it is byte- and configuration-bound and still applies.

## 11. FIX short form (DL-ENG-1 R5)

- ID: P3-904. Original work: P3-003 (Builder branch, unmerged); R2 also corrects the merged P1-004 migration
  `20260910075939_p1_attorney_verification_eligibility_foundation.sql`.
- Defect and evidence: R1–R3 (§3), confirmed by inspection of `b3fda55…` and of the P1-004 migration; the §4.2a
  decision-integrity defect, confirmed by inspection of the recovered `1c4acec…` migration and disclosed in its Gate 2
  evidence.
- Locked source: the locked references named in the adopted P3-003 Packet, as applied by P3-003 A4, A7, A8, A10 and
  A11; Technical Architecture §40 and §55; MVP Build Specification §20.
- Allowed files: the machine header.
- Database, RLS, provider and security impact: one new migration that replaces privileged direct DML with bounded
  transactional interfaces, corrects the staff predicate, removes bypassing grants and makes eligibility persistence
  derive or verify its determination. No new tables, roles, capabilities, providers, factors or policies, and no
  persistent environment change until separately authorized application.
- Acceptance and failure tests: §7; each fails on the uncorrected code where applicable and passes afterwards.
- Forward-only rollback: before merge, new commits on the branch; after merge, a reviewed forward corrective migration
  that restores the prior function definitions and grants. Nothing destroys evidence. Staging per §8.5.
- Stop conditions: §6.

## 12. Exclusions and Gate 0 review

- Preserve the jurisdiction-neutral, multi-state Rosuno architecture; no launch-jurisdiction assumptions.
- Attorneys remain independent legal-service providers; Rosuno provides marketplace technology, not legal services.
- No policy, regulatory, payment, verification or eligibility authority may be inferred from AI output.
- No new tables, customer or business records, fictitious professional approvals, staff capabilities, authentication
  routes, providers, booking or payment flows, infrastructure configuration or secrets.
- No OLD Supabase access, no live database mutation, and no publication, PR, merge or release under this Packet alone.
- This revision neither modifies nor replaces the P3-003 or P3-002 Packets.

Independent review examines:
1. the exact bytes and the authority;
2. that the ALLOWED_SCOPE additions are only those the combined net diff and migration registration require;
3. that §4.2a is presented as a new requirement for owner approval, adds no file, migration, factor or policy, and binds
   the database only to P3-003's adopted rules;
4. that §4.2b preserves accepted P3-002 behaviour without adding or removing an obligation;
5. that §2.2 and §8.1 preserve the original commits, migration history and evidence;
6. that §9 is truthful, minimal and validator-compatible;
7. the guard v3 route and the separation of gates;
8. the absence of any invented PASS, historical edit or unauthorized integration step.

Return **PASS — READY FOR OWNER ADOPTION** only with sufficient evidence; otherwise **HOLD** with the exact
unresolved constraint.

**Current outcome: CANDIDATE FOR INDEPENDENT REVIEW. No adoption, publication or implementation authorized. STOP.**
