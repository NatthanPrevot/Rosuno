WORK_ITEM: P3-001
TYPE: FEATURE
BRANCH: wi/P3-001-attorney-access-entry
BASE_SHA: 756b11cf3af4e367e76197c5f1fce20701482f4b
MIGRATIONS: none
ALLOWED_SCOPE:
- apps/web/src/infrastructure/identity/attorney-principal-source.ts
- apps/web/src/application/attorney-access.ts
- apps/web/app/attorney/page.tsx
- apps/web/tests/attorney-access.test.mjs
FORBIDDEN_SCOPE:
- docs/work-items/*
- rosuno-authority/*
- .github/*
- .claude/*
- CLAUDE.md
- docs/process/*
- supabase/*
- governance/*
- apps/web/app/sign-up/*
- apps/web/app/sign-in/*
- apps/web/app/auth/*
- apps/web/app/forgot-password/*
- apps/web/app/reset-password/*
- apps/web/src/infrastructure/identity/registration-*
- apps/web/src/infrastructure/identity/client-principal-source.ts
- apps/web/src/infrastructure/identity/supabase-server.ts
- apps/web/src/infrastructure/identity/server-session-source.ts
- apps/web/src/application/security.ts
- apps/web/src/application/session.ts
- apps/web/src/presentation/design-system.tsx
- package.json
- pnpm-lock.yaml

# ROSUNO — P3-001 Existing-Attorney Principal Access and Protected Workspace Foundation

**STATUS: REVIEW-ONLY CANDIDATE — NOT ADOPTED. NO PUBLICATION OR IMPLEMENTATION AUTHORIZED.**

## Authority, baseline, purpose
This draft is a new bounded P3 identity / P4 entry slice under the 11 original LOCKED authorities, adopted UOM v1.7.7/C1 rev5.8, and the prior P0/P1/P2 repository implementations. It is NOT a modification to any locked authority or a change to completed P2-007, paused P2-909/P2-911, or their branches. The planned Packet-only first commit (after separate adoption and authorization) is on owner and fork branches rooted at baseline `756b11cf3af4e367e76197c5f1fce20701482f4b`. The owner and fork Packet Git blobs are not yet assigned: capture them after publication, never invent them.

**Objective:** Establish existing-attorney principal resolution and restricted, protected attorney workspace access only. This work item accepts an already existing, authenticated and email-confirmed identity, an active Rosuno User account, and an exactly linked existing Attorney Profile in a P3-001-permitted lifecycle state (`applicant`, `under_review`, or `approved`). It does not create an Auth account, User, Attorney Profile, attorney application, or verification record; it is NOT an operational onboarding entry or completed onboarding process. An authorized absence of existing principals means no real attorney can yet access this foundation. Display no self-approval, verified eligibility, or operational onboarding capability. Never display an ineligible or unverified attorney as approved.

**P3-001-only owner access-policy decision (2026-10-31):** `public.users.account_state = active` is the required **User account** condition; `public.attorney_profiles.profile_state` has no `active` value. For this restricted workspace only, permit `applicant`, `under_review`, and `approved`; deny `suspended` and `removed`. These profile-state permissions do not confer verification, current eligibility, bookability, consultation acceptance, or regulatory authority. Denying this workspace must not alter User status or independently revoke a separately authorized Client context. This decision does not amend general attorney lifecycle rules, provisioning, future workspace policies, or database RLS.

**Verified baseline:** `apps/web/src/application/security.ts` already provides `authorize`; `apps/web/src/infrastructure/identity/server-session-source.ts` supplies a verified session subject; `apps/web/src/infrastructure/identity/client-principal-source.ts` implements Client-only principal context; `apps/web/src/infrastructure/identity/supabase-server.ts` supplies the request-scoped unprivileged Supabase client. `public.users` and `public.attorney_profiles` exist, each RLS-enabled, with own-row SELECT policies, and authenticated INSERT/UPDATE denied. No attorney principal adapter or `/attorney` route exists at the baseline. The first slice must not imply real attorney signup is activated. The LOCKED Implementation Master Plan P3 requires Client/Attorney/Staff isolation and P4 requires reviewable attorney onboarding, license/evidence/eligibility; this item implements only a narrow prerequisite.

## Exact allowed implementation
1. `apps/web/src/infrastructure/identity/attorney-principal-source.ts`: inject an unprivileged, request-scoped `getUser`/own-row database read client through existing `createSupabaseServerClient`. Resolve a verified, email-confirmed Auth subject to exactly one `public.users` row with `account_state = active`, and exactly one `public.attorney_profiles` row whose `user_id` matches that User's ID. Permit the resulting limited `attorney` context only when `profile_state` is exactly `applicant`, `under_review`, or `approved`; explicitly deny `suspended` and `removed`. No Attorney Profile state named `active` exists. Do NOT infer role from mutable Auth metadata, email, UI state, request parameters, or user-controlled IDs. Preserve multi-principal semantics (attorney and client are not globally exclusive). Missing/unconfirmed identity, inactive User, absent linked Attorney Profile, or a `suspended`/`removed` profile => no attorney context; malformed/unknown profile state, multiple, failed, stale or inconsistent reads => fail closed. Do not alter User account state or suppress independently valid Client context. Never use service_role or expose internal errors. Provide a narrowly typed injectable source for testing; do not alter generic Security Shell.
2. `apps/web/src/application/attorney-access.ts`: small presentation-facing domain-neutral adapter over the existing `authorize` security shell to map authenticated/forbidden/unavailable to a fixed, non-leaking workspace-access state. No verification/eligibility/business authority. This is optional only if needed within this exact file list; do not add another abstraction or scope.
3. `apps/web/app/attorney/page.tsx`: server-rendered existing-attorney-only protected workspace route via `authorize` and trusted attorney principal source. For allowed users in each of the three permitted Attorney Profile states (`applicant`, `under_review`, `approved`), render minimal restricted attorney workspace entry using existing design-system components, with active User account access distinguished from Attorney Profile lifecycle, professional verification, and current eligibility. Unless an independent authoritative decision exists, show **verification not established / eligibility not determined**; this slice never makes either decision. For denied/unavailable users, render fixed, non-sensitive access/unavailable state, never privileged profile data. No fake account, fake schedule, earnings, consultations, bookings, or compliance approval. No mutation or onboarding submission forms in this slice. Existing sign-in remains usable; no redirect destination controlled by browser. Protect direct URL entry and re-entry server-side.
4. `apps/web/tests/attorney-access.test.mjs`: targeted tests of the exact adapter and route source. Synthetic identities only inside tests. Cover positive limited access separately for `applicant`, `under_review`, and `approved` with confirmed Auth identity, active User and exact Attorney Profile linkage; deny `suspended` and `removed` even where User is active, without mutating User state or independently revoking valid Client access. Cover missing/anonymous, wrong identity, unconfirmed email, User states `pending_verification`/`suspended`/`closed`, no Attorney Profile, unknown/null/nonstring profile state, malformed/multiple rows, cross-attorney identifiers, client-only or staff-only, provider exceptions/timeouts, direct URL access, no credential exposure, and fail-closed error behavior. Verify tests do not confer eligibility or create business data. Exercise security shell through the route's real trusted wiring wherever practical.

**Out of scope:** Attorney account provisioning/sign-up, application submission, license/insurance/discipline evidence, practice area authorization, eligibility, reviews, compliance approval, higher-trust MFA provisioning, client signup activation/D-04, account recovery activation/D-01, schema/RLS/ACL changes, payments, discovery, scheduling, AI, staff privileges, dashboards with live business data, infrastructure/transport changes. If an authority-required behavior cannot be safely implemented in this scope, STOP and report the smallest exact-file request; do not claim broader P3/P4 completion.

## Acceptance and fail-closed tests
A1. Auth subject is verified server-side; the same fresh Auth user's ID equals the trusted subject, with confirmed email. Session alone is not attorney authorization.
A2. A confirmed, same-subject Auth identity, exactly one `public.users` row with `account_state = active`, and exactly one correctly linked Attorney Profile with `profile_state = applicant`, `under_review`, or `approved` yields the limited `attorney` context. Test each of these three positive states. This adds no capability, verification, eligibility, bookability or consultation-acceptance authority, and does not remove independently authorized Client context.
A3. Anonymous, non-attorney, client-only, mismatched cross-user/cross-attorney, missing and unconfirmed identity, or User `account_state` other than `active` is refused. Attorney Profile `suspended` or `removed` is refused despite an active User. Denial does not suspend the User or independently revoke separately authorized Client access.
A4. Unknown, null, nonstring or otherwise malformed Attorney Profile state, unavailable/malformed/multiple database/provider responses, inconsistent linkage and stale reads fail closed without internal detail; no fallback to client/server/browser role flags. Never treat Attorney Profile `approved` as proof of current eligibility or verification.
A5. Protected `/attorney` entry responds safely for successful, denied and unavailable states, including direct URL and repeated requests; no private data leaked.
A6. UI is accessible and responsive, uses existing primitives, and does not advertise attorney account creation, application submission, operational onboarding, compliance verification, paid consultations, earnings or scheduling as available.
A7. Exact permitted four source paths only; old test assertions preserved; no new dependencies; no migration/schema/guard/Packet/registry modification and no credentials or synthetic production entities.
A8. Run `pnpm install --frozen-lockfile`, targeted Node tests for new file and relevant identity/security tests, `pnpm run p2:application-shell:test`, `pnpm run format:check`, `pnpm run typecheck`, `pnpm run build`, `pnpm run p0:validate`, `pnpm run p0:test`, `pnpm run secrets:check`, `pnpm run dependency:check`; record every exit, no skipped tests or altered validators. All required validations must PASS, or STOP with evidence (including known platform-dependent P2-909/P2-911 test-harness failures if encountered). Check generated artifacts before and after.
A9. After authorized publication and implementation on the separate fork branch, `bash .github/scripts/rosuno-guard.sh 756b11cf3af4e367e76197c5f1fce20701482f4b HEAD wi/P3-001-attorney-access-entry refs/rosuno/approved` must PASS before fork push; verify first-commit Packet, owner Packet blob binding, file allowlist and per-commit linear history. Exact-head independent Backup audit, owner-created PR, required GitHub checks, designated reviewer, owner merge are separate gates.

## Functional completion boundary and immediately following work
**Deliverable claim:** On PASS, P3-001 establishes only verified access to a restricted workspace for a pre-existing, confirmed, active-User-linked Attorney principal in one of the three P3-001-permitted profile states; it does not make an end-to-end attorney onboarding journey available. A test-only synthetic Attorney principal proves authorization behavior, not that Staging contains a usable attorney account. Staging currently has zero `public.users` and zero `public.attorney_profiles` (read-only observation on 2026-10-31). Do not create convenience accounts or treat a no-user deployment as a functional onboarding demonstration.

**Immediate next bounded work, after protected P3-001 integration:** Prepare a separate authority-compliant P3/P4 attorney account/application creation and verification-entry Packet. It must use verified identity/session and the existing User/Attorney/Profile authority model, identify the authorized server-side provisioning boundary and any required staff review, preserve default-deny onboarding/eligibility and existing RLS/privileges, and specify narrowly approved persistence and tests. The precise write path, account invitation/creation policy, authoritative verification transitions, and any required migration or provider decisions are **not established by P3-001** and must be resolved from locked authority and current canonical state before that later Packet is adopted. No new user/profile data, self-approved verification, authorization bypass, external provider configuration, or deployment is authorized by the present Packet.

## Preparation and gating
Gate 0: Independent Backup audits exact candidate content and confirms compatibility with locked P3/P4, current adopted UOM/C1 and real guard. Owner separately adopts exact bytes. Gate 1: separately authorized Packet-only owner publication and exact-byte fork carriage, with fresh owner/fork main and protected-state reconciliation; Packet is the FIRST commit on the new branch and never changes. Gate 2: separately authorized Claude Code Cloud implementation with fork identity, fresh checkout and branch verification; no authority files or protected edits. Gate 2B/3/4: distinct authorization for PR, independent exact-head audit, human reviewer, protected normal two-parent merge. No Supabase persistent application, Replit sync, deployment or production activation by implication.

## Guard contract checks for THIS candidate
Seven unique exact-top-level fields: `WORK_ITEM`, `TYPE`, `BRANCH`, `BASE_SHA`, `MIGRATIONS`, `ALLOWED_SCOPE`, `FORBIDDEN_SCOPE`. Branch prefix matches `P3-001`; `BASE_SHA` is full verified owner/fork main at preparation. Each allow path is exact; no allow pattern overlaps a forbidden rule. `MIGRATIONS: none`; no protected file in allowed set. This structural analysis is NOT a committed-head `rosuno-guard PASS`. That status requires a separately authorized Packet-first Git commit and independent owner/fork publication, which do not exist yet.

## Independent review question
Audit the exact candidate and advise PASS for owner adoption or HOLD specifying a concrete incompatibility. Do not implement, publish or activate. Mandatory independent review is part of ordinary Gate 0, not an extra cycle.
