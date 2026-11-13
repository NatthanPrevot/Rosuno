WORK_ITEM: P3-003
TYPE: FEATURE
BRANCH: wi/P3-003-attorney-trust-professional-setup
BASE_SHA: 8449593d0baccac377f4884ede522d00fa1cc997
MIGRATIONS: none
ALLOWED_SCOPE:
- apps/web/app/attorney/*
- apps/web/app/staff/*
- apps/web/app/layout.tsx
- apps/web/app/globals.css
- apps/web/src/application/attorney-*
- apps/web/src/application/staff-*
- apps/web/src/application/professional-*
- apps/web/src/application/verification-*
- apps/web/src/application/eligibility-*
- apps/web/src/application/policy-*
- apps/web/src/application/security.ts
- apps/web/src/infrastructure/identity/attorney-*
- apps/web/src/infrastructure/identity/staff-*
- apps/web/src/infrastructure/identity/registration-provisioning.ts
- apps/web/src/infrastructure/identity/server-session-source.ts
- apps/web/src/infrastructure/identity/supabase-server.ts
- apps/web/src/infrastructure/attorney/*
- apps/web/src/infrastructure/staff/*
- apps/web/src/infrastructure/professional/*
- apps/web/src/infrastructure/verification/*
- apps/web/src/infrastructure/eligibility/*
- apps/web/src/infrastructure/policy/*
- apps/web/src/presentation/*
- apps/web/tests/*
FORBIDDEN_SCOPE:
- rosuno-authority/*
- docs/work-items/*
- docs/process/*
- governance/*
- supabase/*
- .github/*
- .claude/*
- CLAUDE.md
- tools/*
- apps/web/app/sign-up/*
- apps/web/app/sign-in/*
- apps/web/app/auth/*
- apps/web/app/forgot-password/*
- apps/web/app/reset-password/*
- apps/web/src/application/client-registration.ts
- apps/web/src/infrastructure/identity/client-principal-source.ts
- apps/web/src/infrastructure/identity/registration-abuse-control.ts
- .replit
- .replitignore
- package.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- .env
- .env.*
- .gitmodules

# ROSUNO P3-003 — Attorney Trust & Professional Setup
## Bundled M4 Implementation Packet — Gate 0 Independent Backup Review Candidate

**STATUS: REVIEW CANDIDATE ONLY — NOT BACKUP-PASSED, NOT OWNER-ADOPTED, NOT PUBLISHED, NOT EXECUTABLE.** This document is the single prospective Packet for one cohesive work item containing several connected capabilities. It changes no existing authority and confers no implementation, publication, environment, PR, merge, or deployment permission. If later adopted, preserve these exact bytes (including this historical review banner) as the Packet committed on the controlled branch.

## 1. Authority, identity, baseline, and intended outcome

**Authority hierarchy:** the eleven original LOCKED Rosuno documents (all original SHA-256 digests verified against their accepted authority index) > owner-adopted Unified Operating Model **v1.7.8** (SHA-256 `3754f678252620fe55dbe2264792ecc94a317dcd6da71308531bdd0dabefbeb0`) and Claude Cloud Builder Package **C1 rev5.9** (SHA-256 `34f809e2b28b42b7d1828e524605c3cac092af873f29ef889f8eec5f7e38ab82`) > accepted work-item authorizations/Packets > independently verified implementation. This Packet never replaces, corrects, or republishes the originals.

Applicable locked references: **MVP Build Specification v1.0** (M2, M3, **M4**, §§18, 26–27); **Implementation Master Plan v1.0** (P4/M3–M4, staged jurisdiction/policy and verification sequence, §34 Git/migrations); **Domain Model LOCKED** (distinct Attorney Profile, license, insurance, discipline, practice authorization, Verification Evidence, Eligibility Evaluation, Bookability); **Technical Architecture v0.2** (Identity/Attorney/Eligibility & Verification modules; staff capabilities; verification source isolation); **Physical Supabase/PostgreSQL Specification v1.0** (§§4–5, 8, 10–11, 29–32); **Relational Object Specification v1.0** (professional-record ownership, evidence links, immutable evaluations); and the **Payment/Engagement Matrix v0.2** and **Regulatory Master Specification v0.3** for retained policy/regulatory gates. The remaining locked originals are preserved as superior authority; cite them by title/version, not private copied passages.

**Bounded starting state (read-only GitHub evidence, 2026-11-04):** owner `NatthanPrevot/Rosuno:main` = `8449593d0baccac377f4884ede522d00fa1cc997`, the protected two-parent PR #87 merge closing P3-002 for **nonproduction repository implementation only**. Builder `RosunoBackup/Rosuno:main` = `38dbb44c2ca134350508840c47466955c2a852a4` at Gate 0; its controlled fast-forward would require separate Gate 1 authorization. The proposed `wi/P3-003-attorney-trust-professional-setup` branch was absent on both repositories at this read-only inspection. Recheck every ref, existing branch, Packet path and environment identity at each subsequent authorized gate. A moving `main`, extra file, configuration drift, unexplained migration difference or existing branch is STOP, not silently rebased or normalized.

**Existing bounded foundations:** P3-001 existing-attorney workspace and P3-002 one-time active/confirmed User → Attorney Profile `applicant` creation are protected-merged and administratively closed; they grant neither professional verification nor current eligibility. P1 already introduced 14 migration files, including `20260910075939_p1_attorney_verification_eligibility_foundation.sql` (Git blob `f3e8a1e006a1a8770d90b03272bc9cccff3d3451`) with `licenses`, `insurance_records`, `discipline_records`, `practice_areas`, `practice_area_authorisations`, `verification_evidence`, `verification_evidence_subjects`, `eligibility_evaluations`, capability/RLS support and provenance relationships. These are **schema foundations, not working M4 workflows**. The accepted migration tree at the approved base is `6be2d384d257eeeb43189f568640f98077f2811d`; `.replit` blob is `f39d897b8c2721ded05c8031306e73eb4f3c3e8d`. Do not alter either.

**One coherent deliverable:** an existing authenticated attorney applicant can submit and maintain non-authoritative professional claims; appropriately authorized staff can inspect evidence, record source-grounded findings and make controlled review decisions; the server can derive **jurisdiction-/practice-/policy-aware** current Eligibility and persist immutable explainable evaluations at actual consequential decisions when valid authority inputs are present. Provide the connected restricted attorney and minimal staff UI needed to exercise the operations, plus development-safe tests. Application/profile lifecycle, verification evidence, professional authorization, current eligibility and marketplace readiness remain separate facts.

**Bundling decision:** this is one M4-centered work item with three integrated capabilities: (a) professional application/claim collection, (b) scoped staff verification and review, and (c) policy-gated professional readiness/Eligibility. No independent per-capability Packet or PR is intended. It does not absorb the M6 scheduling/bookability, M8 fee calculation or M10 acceptance phases. One consolidated governance closure may later record this **single** accepted work item, under the existing separately authorized protected PROCESS workflow; there is no standing closure authority here.

## 2. Concrete scope and exclusions

### 2.1 Attorney-submitted professional application / setup

- Build on **existing** server-authenticated P3-001 access and P3-002 applicant identity. Revalidate Auth subject, email confirmation as applicable, exact User linkage, active User state, own Attorney Profile, and permitted profile lifecycle for every protected action; do not accept identity, role, profile state, jurisdictional authority or verification status from client input.
- Provide usable responsive applicant/professional setup screens to enter, review, revise and submit **claims** about licensing jurisdiction/number and permitted professional profile information; applicable insurance claims and practice-area authorization **requests**, clearly labelled as unverified until actual authoritative review. Persist through the existing professional tables and trusted server operations, with provenance and no fabricated official findings. Treat `licenses.reported_status` as a source-observed value, **not** the attorney's own assertion of verified status.
- Support the existing Attorney Profile lifecycle (`applicant`, `under_review`, `approved`, `suspended`, `removed`) without adding invented canonical stages. Submission can request review without self-approval. “Additional information required” is a **conditional UI/review outcome**, not a compulsory new profile state or implicit privilege. Correctly present approved **profile state** separately from evidence verification, Eligibility and readiness.
- Permit editing of self-owned ordinary profile fields only within the locked physical schema and verified state rules. Never allow self-assignment of protected specializations, practice authorization, verified labels, professional status, Eligibility, staff powers, fee policy or regulatory permission. Preserve all Client Profile relationships and P3-001/P3-002 protections.
- Keep the minimum valid claim history and edit/audit attribution consistent with existing audit/evidence architecture. Changes to applicant claims must not silently rewrite previously relied-upon verification evidence or immutable evaluations. Re-review or a new evaluation is required after consequential changes.

### 2.2 Scoped staff verification and application review

- Add a **minimal**, protected staff review workspace/operations for M4 only: authorized application queue, applicant/professional record details, evidence/source findings, discrepancies, requests for missing information, explicit staff review action, and clear outcomes. Do not build the broader M13/M14 administrative suite.
- Require fresh authenticated Staff Profile **and** current, unrevoked, unexpired, correctly scoped `manage_attorney_verification` Capability Grant for each sensitive read and mutation; honor jurisdiction/resource scope, active account/staff state and any stronger-trust requirement already established by authority. A staff profile alone never grants privileges; no universal admin role, fake reviewer, convenience override, synthetic production user, seed grants or bootstrap shortcuts.
- Trusted server operations, not ordinary browser writes, own changes to professional records, verification findings, profile review transitions, and practice-area decisions. Reuse existing server-only credential/project-binding protection rather than adding another general-purpose privileged client or exposing a service-role credential. Restrict read scope at least as narrowly as existing RLS; do not use service-role privilege as authorization.
- Verification Evidence must retain source type/reference, retrieval time, method, reviewer identity, result/summary, discrepancies, digest/reference when applicable, jurisdiction, retention constraints and **integrity-safe link to each supported professional subject** through existing `verification_evidence_subjects`. Applicant claims and automated/provider observations remain claims/evidence, never independent Rosuno professional truth or a staff approval.
- Respect the locked effective-date, license, insurance, discipline and Practice Area Authorisation distinctions; practice authorization is not panel membership. Staff must not invent a regulator response or “verified” source. Where genuine external lookup/provider credentials or approved process are absent, show missing evidence and route for legitimate staff review or HOLD; no fake successful verification.
- Record auditable decisions and controlled transitions, including negative outcomes and the basis of approval/rejection; never silently discard adverse findings or change historical evidence. A denial/appeal path must not be invented beyond existing authorized states and source records.

### 2.3 Current Eligibility / professional readiness

- Implement a jurisdiction-/service-area-/practice-area-/policy-aware **server-derived current assessment** using actual professional records, current evidence and the applicable **approved, effective, authoritative policy** where one exists. Check license identity/status/effective dates, applicable insurance conditions, discipline, qualifications, practice authorizations, conditional panel participation, account/profile constraints and applicable service-area scope. Never hard-code California, Arizona or a launch jurisdiction's regulatory rules.
- Distinguish (1) account access, (2) application/profile review stage, (3) verification evidence/factor status, (4) current Eligibility, and (5) scheduling/Bookability/marketplace activation. `approved` profile state alone never implies eligible, and eligible never means bookable. No live presentation, referral, Talk Now, payment, scheduling or activation is authorized.
- Where required policy parameters, authority references, verification evidence, staff authority, jurisdiction/mode decisions or approved conditions are missing/stale/conflicting, return an explicit **blocked/unavailable/not determined** result with non-sensitive reasons; do not default to “eligible”, assert a new legal rule or synthesize an approved policy. Preserve all HOLDs, including G-1–G-5 and conditional jurisdiction-specific counsel questions.
- Persist immutable, explainable `eligibility_evaluations` **at genuine consequential evaluation points** (e.g. an explicitly authorized verification/readiness determination), carrying context, as-of time, factor results, source/evidence references and exact relevant policy-version references. A simple read-only dashboard rendering does not manufacture an operational evaluation/eligibility decision. Later adverse evidence generates a new evaluation; previous evidence/evaluations remain intact.
- Provide staff and attorney views of allowed, **separately labeled** readiness factors without exposing other attorneys' evidence, internal evaluation detail to unauthorized principals, confidential staff notes, or raw policy/financial/credential material. The attorney UI may display a safe derived status; it must not become the source of that status.

### 2.4 Small directly related integration corrections

- Claude may implement directly related application/service adapters, necessary UI components, ordinary in-scope refactors, compatibility fixes and regression tests across the **permitted subsystem globs** above, without recurring owner approval. Wildcards intentionally allow new files in the named attorney, staff, verification, eligibility, policy-read and test areas; they do **not** allow unrelated functionality even if a pathname technically matches.
- Review and, where directly exercised, correct the three documented P3-002 limitations **within this approved scope**: active-User read/insert race, generic failed-start/unconfirmed presentation, and actionable entry shown when privileged provisioning is unavailable. Do not falsely claim correction without reproducible tests; if safe correction requires a forbidden file or schema, preserve the original limitation and report the precise blocked dependency rather than bypassing scope.
- Preserve existing client registration, D-04 default-deny public signup, D-01/provider recovery HOLD, client/attorney/staff isolation, privileged project binding, rate/abuse protections, original P3-001 entry and P3-002 one-time creation invariants. Retest affected security boundaries after any authorized shared-layer edit.

### 2.5 Explicitly outside this bundle

- New public attorney registration/authentication, alternate client signup, direct applicant self-verification, staff identity/grant provisioning, fake staff/attorneys/business data, broad staff console, break-glass authorization expansion or a new policy-approval system.
- Attorney fee/rate creation, payment/Stripe onboarding, subscription, earnings, consultation preferences, calendar availability/instant intent/Talk Now, Bookability, discovery/referral, client intake, Consultation Request, payment, acceptance, booking or media. **Reason:** these are later M6–M10 capabilities and/or depend on unresolved fee/engagement/policy gates; their absence does not block safe M4 work.
- Full evidence-document upload/storage feature, unrestricted document sharing, automated regulator scraping, third-party verification integration or new retention policy. Existing secure artifact references may be **read only when actually authorized**; do not fake file attachment availability or expand M12 resource-sharing scope merely for this bundle.
- New schema, migration, RLS/ACL changes, database grants, policy defaults, seed records, new dependencies, repository controls, UOM/C1 changes, locked documents, historical migrations, governance registries, Git history rewrite, external provider contact, Staging/Production/OLD Supabase mutation, Replit sync, launch authorization or deployment.

## 3. Canonical contract and bounded engineering execution

### 3.1 Existing physical relations are the sole intended persistence basis

Use actual canonical relations, subject to read-only revalidation at implementation preflight: `users`, `attorney_profiles`, `staff_profiles`, `capability_definitions`, `capability_grants`, `jurisdictions`, `service_areas`, `policy_versions`, `policy_authority_references`, `licenses`, `insurance_records`, `discipline_records`, `practice_areas`, `practice_area_authorisations`, `verification_evidence`, `verification_evidence_subjects`, `eligibility_evaluations`, and existing audit architecture. Use only existing columns, constraints and server-authorized operations. The P1 M4 migration and any later immutable correction migrations govern physical reality; do not infer column names from earlier drafts when the live SQL differs.

**MIGRATIONS: none.** The existing 14-migration P1 foundation includes the intended tables and integrity-safe evidence-subject bridge. At Gate 0 no concrete requirement has been established that demands a new table/column/function/RLS policy. If authorized implementation discovers a **demonstrated** schema/constraint/security impossibility, STOP → REPORT → WAIT with exact affected object, source/locked conflict, proposed **forward-only** correction and required separate scope/owner decision. Never edit historical migrations or work around DB controls in app code. This is a genuine blocker only for the affected implementation slice, not unrelated build work.

### 3.2 Scope and boundary enforcement

The ALLOWED_SCOPE list covers connected Next.js attorney/staff routes, professional and review/eligibility services, identity/capability adapters, shared security integration and relevant design system/testing files. The only permitted modifications to existing sensitive shared infrastructure are **the minimum directly necessary** for this bundle, with unchanged authenticated identity/project-binding contracts and security regression evidence. Never export a privileged client or weaken the generic Security Shell. The FORBIDDEN_SCOPE list and runtime permissions always prevail over an allowed wildcard.

Claude may make multiple **forward-only local** logical implementation commits and correct ordinary in-scope defects without owner reauthorization once Gate 2 is separately authorized. Every commit must remain guard-compliant, not just the final diff; preserve the first Packet-only commit and exact Packet bytes. Do not stage or commit scratch scripts, logs, credentials, custom tools, migrations or additional Packet artifacts. No amend, rebase, squash, force push or hidden alternative worktree/actor.

### 3.3 Environment and source controls

Gate 2, **if later authorized**, uses existing `rosuno-builder` Claude Code Cloud, Builder fork only, Limited network, current `.claude/settings.json` deny rules, no custom credentials/setup scripts and no external MCP. Preserve current managed permissions. The session must first verify canonical root/Git directory/common directory, worktrees, branch/HEAD, clean status/index/untracked files, local/fork main, approved owner Packet binding via existing guard workflow, GitHub protections, migrations/hash inventory, `.replit`, dependency/config, security and environment boundaries. The known automatic `claude/...` bootstrap is allowed only through `CLAUDE.md`'s verified fork-only method; all unexplained drift is STOP.

Repository implementation/local commit, controlled original-commit publication, **owner-created PR**, independent Backup source/PR audit, `Rosuno` human review, **owner-authorized normal two-parent merge**, consolidated governance closure, Supabase persistent application, Replit synchronization and deployment are separate authorization gates. This Packet grants **none** of them at Gate 0. Owner performs PR/review/merge manually in GitHub web. No assumption that signing/Cloud publication identity is proven; preserve exact original commit and use the previously verified human Builder publication contingency if separately approved and needed.

## 4. End-to-end acceptance conditions

A1. **Identity:** Every attorney submission and staff action derives the Auth subject/active User, applicable confirmed identity, correct Attorney/Staff relationship and authority from a fresh server-side source. No identity/role/profile ID, jurisdiction scope or reviewer attribution can be spoofed.

A2. **Applicant claims:** An applicant can view/edit/submit supported professional claims within existing canonical tables, with accurate own-ownership and review status. Submitted data never becomes verified solely by submission, and no protected field or another attorney's profile can be changed.

A3. **Review lifecycle:** The staff queue and applicant status render distinct current application/profile states; authorized staff can request further information conditionally and make explicitly supported review transitions with auditable provenance. Existing `applicant`, `under_review`, `approved`, `suspended`, `removed` states remain intact; unknown transitions fail closed.

A4. **Staff grants:** Staff verification actions require actual active Staff context plus current exact scoped `manage_attorney_verification` grant. Revoked, expired, mismatched jurisdiction/resource scope, anonymous, attorney-only, client-only, inactive and spoofed staff principals are denied. No seeded production grants or broad admin substitute.

A5. **Source evidence:** Every relied-upon verification finding records truthful source, method, date, reviewer, relevant jurisdiction and comparison/discrepancy; the `verification_evidence_subjects` relationship has valid existing FK/one-subject semantics. External missing/unavailable sources do not become official approval.

A6. **Professional factors:** License, insurance, discipline and practice-area requests/authorizations retain separate record lifecycles. Attorneys cannot self-verify, self-authorize practice areas, self-suspend/revive other principals or silently overwrite adverse findings.

A7. **Policy gating:** Eligibility consumes only actual approved/effective applicable policy and evidence for the given jurisdiction/practice/service context. Missing, inactive, stale, conflicting or absent policy/authority inputs return blocked/undetermined, never invented eligibility. No jurisdiction hard-code.

A8. **Evaluation integrity:** Where a consequential evaluation is permitted, persist complete immutable `eligibility_evaluations` with as-of time, factor reasons and policy/evidence references. New adverse facts yield a later T2 evaluation without rewriting T1. Mere profile approval or view does not automatically create eligibility/bookability.

A9. **Separated readiness:** UI and server distinguish account access, profile lifecycle, evidence status, current Eligibility and operational readiness. No active marketplace availability, booking or discovery authority is introduced.

A10. **Security:** Prove positive and negative scope/RLS/IDOR behavior for attorney self-records, staff review/evidence access, another attorney, Client, unauthenticated principals and privileged mutations. Never assume service-role bypass itself authorizes domain operations. Exercise grant expiry/revocation and policy-state races where relevant.

A11. **Failure semantics:** Missing secrets/config, service read/write failure, ambiguous persistence, stale source, conflicting records, unavailable reviewer capability and external verification unavailability fail closed with truthful, safe user-facing status, retry/reconciliation guidance only where permitted; no false success.

A12. **Preservation:** P3-001/P3-002 behaviors and Client Profile independence are preserved; D-04 signup stays default-denied; no provider/account recovery activation. Existing three P3-002 limitations are either demonstrably corrected in directly affected code with tests or precisely reported as retained. No unauthorized cross-workflow regression.

A13. **Presentation:** Responsive accessible applicant/professional and minimal staff screens support the complete in-scope flow without hidden mandatory stages, confusing verification/eligibility conflation or mock operational success. Sensitive staff/evidence details remain private, with no public indexing of protected views.

A14. **Schema/history:** Exactly the authorized application/test source scope changes, no migration/registry/Packet/dependency/configuration change; original Git/migration history, authority files, existing security gates and external environments are preserved. No generated production entities, providers or counsel decisions.

A15. **Integration:** All in-scope user and staff transitions and negative authorization/policy paths work together through trusted application service boundaries. Report fixture-only versus actual local-database results distinctly; no claim of deployed or live end-to-end M4 operation.

A16. **Controls:** Every Packet-prescribed validation and genuine committed-head `rosuno-guard` must pass on the exact reviewed HEAD; mandatory GitHub checks and independently accepted source audit follow on the protected PR under later gates.

## 5. Minimum test matrix and validations

**Behavioral cases:** confirmed active attorney applicant with and without Client Profile; applicant repeated/revised claims; missing or mismatched licensing jurisdiction; rejected/expired insurance evidence; adverse discipline; multiple jurisdictions and practice areas; permitted/denied practice-area requests; previously approved or suspended/removed profile; an under-review applicant requesting more information; another attorney's record; grant current/expired/revoked/out-of-scope; staff capability absent; race on User/Staff/verification status; invalid policy status/effective dates; no policy authority; stale evidence/evaluation; T1→adverse fact→T2; no phantom Eligibility; P3-001/P3-002/registration regressions.

**Security/DB tests:** Exercise actual existing constraints/RLS with available permitted local ephemeral database test infrastructure where practical, plus synthetic/installed-client service fixtures. If local database coverage cannot run in the restricted Cloud environment, preserve accurate limitation evidence and do **not** report those cases as executed or use a remote database as a fallback. Unexpected schema/RLS/ACL differences against approved migration evidence are STOP. Do not use external accounts or provider APIs to manufacture positive test data; synthetic identities belong to isolated tests only.

**Existing repository commands (use exact available scripts, do not invent new scripts):**

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

Run the new focused M4 test files through the existing repository test runner. If needed use the existing `node --test` invocation for specific `.test.mjs` files, without adding dependencies or changing `package.json`. Preserve SHA-bound historical validation for unchanged P3-001/P3-002 code where valid; rerun only relevant regression suites when this bundle touches shared identity/security paths. If a shallow clone prevents P0 validation, use only the previously approved **history-only** fetch from the Builder fork, with unchanged refs/configuration and a read-only before/after receipt.

After authorized local commit(s), run the real committed-head guard with the **then-verified owner Packet branch** established by the controlled Packet-first workflow, never a guessed approval ref:

```sh
bash .github/scripts/rosuno-guard.sh \
  8449593d0baccac377f4884ede522d00fa1cc997 \
  HEAD \
  wi/P3-003-attorney-trust-professional-setup \
  refs/rosuno/approved
```

Require `ROSUNO-GUARD PASS work_item=P3-003` with exact adopted Packet SHA-256, correct base, reviewed head, and owner-matching Packet blob (fork-local approved ref alone does not constitute independent owner approval). Preserve test results, exact changed paths/blobs, migrations, source evidence and any unresolved limitations.

## 6. Existing HOLDs, dependencies, and completion boundary

**True dependencies:** P1 M3/M4 schema and staff capability foundation; P2 identity/security/auth infrastructure; protected-merged P3-001 attorney access and P3-002 applicant creation; current policy-version selection and server-trusted project binding. P2-913 governance closure is the repository-complete P3-002 predecessor at this approved base. No actual new feature or policy decision is inferred from a roadmap label.

**Development-safe now:** applicant/staff route and domain services; existing-table data contracts; provenance/evidence linking; capable staff-review interactions with explicit trust checks; deterministic current-eligibility composition with a fail-closed policy adapter; immutable historical evaluation at genuinely authorized decision boundaries; synthetic security and integration tests. No live staff or professional approval is implied.

**Conditional HOLDs (do not silently bypass; do not block unrelated authorized development):**
- **D-04** public registration trusted-ingress activation remains default-denied; this bundle is for existing authenticated Users only.
- **D-01** account-recovery/provider delivery remains unverified; unrelated to building M4 modules.
- Specific jurisdiction regulatory mode, license/insurance/discipline obligations, authority evidence, staff review mandates, panel/independence and eligibility thresholds remain counsel/policy gated until genuine approval. **Arizona-first preference is not itself an approved regulatory policy.** California-specific LRS obligations remain conditional, not generic rules.
- **G-1–G-5** fee/engagement/payment and related commercial decisions remain unresolved. No fee policy/value or attorney compensation assumption is inserted into this bundle.
- Live providers, private storage artifact integration, valid staff grant provisioning, production service-account configuration, Staging/Production deployment, Replit synchronization and D-04 activation are separately controlled. No synthetic production attorney/staff/client or approval event may be created for testing.
- Real policy-backed positive eligibility requires **actual** applicable approved/effective authority and supporting records. Absent those, production/business eligibility stays blocked even if a synthetic test proves the code path.
- Existing P3-002 three implementation limitations remain explicitly tracked unless this bundle proves a directly authorized correction. Separate future M6 Bookability, M8 Fee Calculation, M10 booking acceptance and regulated launch authority remain outstanding.

**Closure meaning:** Upon eventual independent Backup PASS, owner adoption, separate Packet publication, authorized local implementation, controlled exact-original-commit publication, successful CI/guard, independent source/PR audit, designated `Rosuno` human review, separate owner-protected merge and separately controlled **one bundled governance closure**, the work item can be declared **REPOSITORY_IMPLEMENTATION_COMPLETE / WORK ITEM CLOSED FOR BOUNDED NONPRODUCTION IMPLEMENTATION ONLY**. This does not certify that each policy-dependent branch is activated, that all M4 operational outcomes are live, that any regulator/attorney has been verified, or that any attorney is eligible or bookable.

**Governance implementation after merge:** If canonical closure is required, use the accepted P2-912/P2-913 PROCESS precedent to add **one combined work-item closure plus its reciprocal decision**, rather than three separate professional-evidence/staff/eligibility closures. No extra closure artifact, role, schema rewrite or shortcut authorization is created now. Because the current schema restricts work-item IDs to P0–P2, the closure identifier follows the independently adopted administrative P2 precedent if needed; do not invent a future numeric ID or claim closure before the protected merge and final verification.

## 7. Gate 0 Backup audit request and STOP rule

**Review the exact bytes** of this candidate against the eleven locked originals, adopted UOM v1.7.8/C1 rev5.9, verified owner baseline, current P1/P2/P3-001/P3-002 sources, M4 migration and guard/schema behavior. Specifically assess whether the three capabilities form one reviewable authorized work item, whether the wildcard allowlist and no-migration boundary are sufficient and safe, whether staff verification can be built without fabricated authority, whether the policy-gated Eligibility path remains honest, and whether all mandatory protected gates are retained.

Return either **PASS — READY FOR OWNER ADOPTION**, with the complete candidate SHA-256 and any nonblocking clarification, or **HOLD**, with one consolidated list of concrete locked-authority/schema/scope/implementation conflicts. Do not silently change this Packet. Any correction means a newly hashed candidate and separate owner adoption.

**STOP → REPORT → WAIT** on unexplained repository/Packet/branch/commit drift, unknown capability or source authority, schema/RLS/ACL conflict, disallowed required migration, permission/credential or network discrepancy, fabricated evidence, regulatory/policy ambiguity that affects an attempted privileged or eligibility decision, or any proposed action outside adopted scope. Preserve every historical commit and migration. Nothing in this Gate 0 Packet grants Git, database, provider, deployment or later-phase mutation.
