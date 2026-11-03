# ROSUNO P3-002 — Attorney Account and Application Creation

**REV3 — FOCUSED INDEPENDENT BACKUP REVIEW CANDIDATE**

**STATUS: REVIEW ONLY — NOT ADOPTED**

WORK_ITEM: P3-002  
TYPE: FEATURE  
BRANCH: wi/P3-002-attorney-application-entry  
BASE_SHA: 2e298f7ad43df8432c55cfa0bf8b4edbc6123cb6  
MIGRATIONS: none  
ALLOWED_SCOPE:
- apps/web/app/attorney/page.tsx
- apps/web/app/attorney/apply/page.tsx
- apps/web/app/attorney/apply/actions.ts
- apps/web/src/application/attorney-application.ts
- apps/web/src/infrastructure/identity/attorney-application-provisioning.ts
- apps/web/src/infrastructure/identity/registration-provisioning.ts
- apps/web/tests/attorney-application.test.mjs
- apps/web/tests/attorney-access.test.mjs
- apps/web/tests/client-registration.test.mjs

FORBIDDEN_SCOPE:
- docs/work-items/*
- rosuno-authority/*
- governance/*
- .github/*
- .claude/*
- CLAUDE.md
- docs/process/*
- supabase/*
- apps/web/app/sign-up/*
- apps/web/app/sign-in/*
- apps/web/app/auth/*
- apps/web/app/forgot-password/*
- apps/web/app/reset-password/*
- apps/web/src/application/client-registration.ts
- apps/web/src/infrastructure/identity/registration-abuse-control.ts
- apps/web/src/infrastructure/identity/client-principal-source.ts
- apps/web/src/infrastructure/identity/attorney-principal-source.ts
- apps/web/src/infrastructure/identity/server-session-source.ts
- apps/web/src/infrastructure/identity/supabase-server.ts
- apps/web/src/application/security.ts
- .replit
- .replitignore
- package.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- .env
- .env.*
- .gitmodules

## 1. Authority

Controlling authority:

1. Eleven current LOCKED Rosuno originals.
2. Adopted UOM v1.7.8 and C1 rev5.9.
3. Owner-approved P3-002 Applicant Profile Creation Authorization, including all ten conditions.
4. This Packet, following Independent Backup PASS and express owner adoption.
5. Existing canonical implementation.

Relevant locked requirements:

- MVP Build Specification V1.0: M2, M4 and server-authority requirements.
- Technical Architecture V0.2: Identity & Access §3.1; Attorney §3.2.
- Physical Supabase/PostgreSQL Specification V1.0: §§4–5 and 10–11.
- Existing P1 identity, authorization and attorney foundations.
- P2 authentication, registration and Security Shell foundations.
- P3-001 Existing-Attorney Access Entry.

The owner's applicant-creation authorization is accepted and must not be reopened without a specific authority conflict.

## 2. Objective

Implement secure initial Attorney Profile creation for an existing, active, authenticated and email-confirmed Rosuno User.

The implementation must reuse existing identity infrastructure and the existing privileged Supabase credential/project-binding boundary.

Application initiation and privileged profile creation remain separate operations.

The initial profile is created only in `applicant` state.

No professional verification, approval, eligibility, bookability or other marketplace authority is granted.

## 3. Authorized applicant creation

### Existing User

The server must independently establish:

- Fresh authenticated Supabase Auth identity.
- Confirmed email status.
- Exactly one linked Rosuno User.
- `users.account_state = active`.
- No existing Attorney Profile.

The server derives the authoritative User association.

The applicant cannot supply an authoritative User ID, Attorney ID, profile state, role or privilege.

A specifically authorized server-side operation may insert one Attorney Profile linked to the verified User, initialized to `applicant`.

### Existing Attorney Profile

Do not create another profile.

Preserve existing states:

- `applicant`
- `under_review`
- `approved`
- `suspended`
- `removed`

Do not reset, promote or revive a profile.

Unknown or inconsistent states fail closed.

### Existing Client Profile

Preserve existing User and Client Profile relationships and permissions.

Client status neither grants nor prevents the owner's separately approved applicant-creation authority.

### New-account entry

D-04 remains default-denied.

An unauthenticated visitor may view informational attorney-registration content, but P3-002 must not introduce an alternative registration mechanism.

No unconfirmed account or missing Rosuno User may be provisioned through P3-002.

## 4. Required shared provisioning integration

### Existing canonical module

`apps/web/src/infrastructure/identity/registration-provisioning.ts`

This file is expressly added to ALLOWED_SCOPE.

The implementation must reuse its existing server-only privileged Supabase credential handling and project-binding protections.

### Permitted modifications

Claude may make the minimum necessary changes to this existing module to support P3-002's specifically authorized attorney-applicant creation operation.

Permitted changes include:

- A narrowly scoped attorney-applicant provisioning function or factory.
- Reuse of existing project-binding and privileged-client construction logic.
- Minimal internal refactoring needed to share those protections safely.
- Required identity-bound insert/read behavior through a narrowly defined application port.
- Directly related regression corrections.

The implementation must not export a privileged Supabase client, service credential, general-purpose database executor or unrestricted administration interface.

### Mandatory preservation

The existing module must continue to:

- Keep privileged credentials server-side.
- Verify the expected Supabase project binding.
- Reject missing, malformed or mismatched configuration.
- Avoid request-cookie or browser-controlled credential inheritance.
- Prevent credential exposure to presentation code.
- Preserve existing client-registration and quota behavior.
- Preserve separation between privileged provisioning and unprivileged confirmation-email operations.

Do not create a second independent privileged credential-loading or project-binding mechanism in `attorney-application-provisioning.ts`.

That module may provide a narrowly scoped attorney-specific adapter, but must delegate privileged client construction and project binding to the existing shared provisioning boundary.

### Other registration infrastructure

The broad `registration-*` FORBIDDEN_SCOPE pattern is removed.

`registration-abuse-control.ts` remains expressly forbidden.

All other registration infrastructure is outside ALLOWED_SCOPE unless separately authorized.

`client-registration.ts`, existing signup actions and the D-04 registration boundary remain unchanged.

## 5. Canonical data contract

Use the existing `public.attorney_profiles` table.

| Column | Source |
|---|---|
| `id` | Database-generated UUID |
| `user_id` | Verified server-side User association |
| `profile_state` | Server-controlled `applicant` |
| `created_at` | Existing database default |
| `updated_at` | Existing database default |

No separate application table, migration, role boolean or verification flag.

Existing unique-User constraints remain authoritative.

The trusted operation must prevent duplicate records and avoid converting uncertain persistence outcomes into success.

## 6. Required behavior

1. Existing eligible User opens the attorney application entry.
2. Server independently verifies identity and eligibility to request initial creation.
3. User explicitly initiates the applicant-creation request.
4. The authorized server operation uses the existing privileged project-binding infrastructure.
5. The operation creates at most one initial Attorney Profile.
6. The application presents a safe, accurate result.
7. Established applicants may use the existing P3-001 restricted workspace according to its independent authorization checks.

A failed or uncertain operation must not produce an invented success.

A retry must not create an additional profile.

## 7. Acceptance criteria

**A1 — Identity:** Creation requires fresh, confirmed authentication and an exact active User association.

**A2 — Authorization:** Only the owner-approved P3-002 server-side applicant-creation operation may provision the profile.

**A3 — Server authority:** All authoritative identity, association and state values are server-derived.

**A4 — Correct creation:** At most one Attorney Profile is created for the verified User, initialized exclusively to `applicant`.

**A5 — Existing profiles:** No duplicate creation, state reset, privilege promotion or suspended-profile revival.

**A6 — Concurrency:** Repeated and concurrent submissions preserve database uniqueness and cannot create unauthorized state.

**A7 — Existing relationships:** Client Profile and User relationships and permissions remain intact.

**A8 — P3-001 preservation:** Existing attorney-principal resolution and restricted workspace behavior remain unchanged.

**A9 — D-04:** Existing default-deny public registration behavior remains unchanged.

**A10 — Privileged provisioning:** The existing server-only credential/project-binding boundary is reused. No independent privileged credential mechanism is introduced.

**A11 — Regression preservation:** Existing client-registration, confirmation, quota, credential-isolation and project-binding behavior remain intact.

**A12 — Failure handling:** Missing authorization, uncertain writes, provider failures and inconsistent identity fail closed without leaking sensitive information.

**A13 — Presentation:** Entry, existing-application, denial and unavailable states are clear, accessible and responsive.

**A14 — Scope:** No unauthorized paths, dependencies, migrations, credentials, privileges, policies or external-environment changes.

**A15 — Validation:** All Packet-prescribed tests and existing required repository controls pass.

## 8. Required tests

### Applicant creation

- Valid confirmed active User without an Attorney Profile.
- Valid User with an existing Client Profile.
- Anonymous, unconfirmed, inactive and malformed identities.
- Existing applicant, under-review, approved, suspended and removed profiles.
- Cross-account creation attempts and IDOR.
- Spoofed identity, role and state inputs.
- Duplicate, repeated and concurrent submissions.
- Failed inserts and uncertain persistence outcomes.

### Shared provisioning

- Existing project binding succeeds only for valid configuration.
- Missing or mismatched configuration fails closed.
- Privileged credentials remain inaccessible to browser/presentation code.
- No privileged client or general-purpose executor is exposed.
- Existing client registration remains unchanged.
- Existing confirmation and quota behavior remains unchanged.
- D-04 continues denying unauthorized public registration.

### Existing P3-001 functionality

- Valid restricted workspace access remains intact.
- Existing denied lifecycle states remain denied.
- Client/staff/anonymous access cannot gain attorney privileges.
- No self-verification, eligibility or bookability authority is introduced.

Use existing tests wherever appropriate.

The authorized `client-registration.test.mjs` may be updated only as necessary to protect shared provisioning regressions. Do not rewrite historical assertions simply to make tests pass.

## 9. Validation

Required commands and evidence:

- `pnpm install --frozen-lockfile`
- Targeted P3-002 tests.
- Existing attorney-access tests.
- Relevant client-registration and identity/security regressions.
- `pnpm run p2:application-shell:test`
- `pnpm run format:check`
- `pnpm run typecheck`
- `pnpm run build`
- `pnpm run p0:validate`
- `pnpm run p0:test`
- `pnpm run secrets:check`
- `pnpm run dependency:check`
- `git diff --check`
- Genuine committed-head `rosuno-guard` against the approved owner Packet.

Reuse unchanged SHA-bound evidence where controlling authority permits.

Do not weaken tests, guards or security controls.

## 10. Engineering autonomy

Following the required Packet adoption, owner/Builder Packet publication, independent Packet verification and separate implementation authorization, Claude may autonomously:

- Implement the complete approved task.
- Diagnose ordinary implementation failures.
- Correct directly related defects in permitted files.
- Refactor authorized code as necessary.
- Add and improve authorized tests.
- Repeat required validations.
- Produce ordinary forward-only implementation commits.
- Prepare one consolidated completion receipt.

No separate owner approval is needed for routine engineering activity already within the authorized implementation boundary.

This does not override effective Claude permissions or independent publication gates.

## 11. Completion receipt

Claude reports:

- Work-item ID and Packet identity.
- Repository and branch.
- Base, parent, HEAD and tree.
- Changed paths and blobs.
- Exact test and validation outcomes.
- Credential/project-binding regression results.
- Genuine `rosuno-guard` result.
- Clean working-tree and index status.
- Unresolved exceptions or limitations.

## 12. STOP conditions

STOP → REPORT → WAIT for:

- Locked-authority conflict.
- Unverified provisioning authorization.
- Need for an unauthorized schema, credential or permission change.
- Need to bypass the existing privileged project-binding boundary.
- Need to weaken D-04 or existing client registration.
- Unexpected Git, Packet, dependency or migration drift.
- Necessary changes outside the authorized scope.
- Security-control failure or unexplained validation discrepancy.

## 13. Completion boundary

P3-002 establishes initial applicant creation only.

It does not establish professional verification, approved attorney eligibility, practice authorization, consultation readiness, public-registration activation, payments or production readiness.

Supabase persistence, Replit synchronization, deployment and production operations require separate authorization.

**REV3 remains a candidate until Independent Backup PASS and express owner adoption.**
