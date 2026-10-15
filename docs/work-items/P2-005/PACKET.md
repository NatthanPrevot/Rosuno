WORK_ITEM: P2-005
TYPE: FEATURE
BRANCH: wi/P2-005-authentication-entry
BASE_SHA: 572bc7127a741d30c9245ca6ae04c0da014eee08
MIGRATIONS: none
ALLOWED_SCOPE:
- apps/web/app/page.tsx
- apps/web/app/sign-in/page.tsx
- apps/web/app/sign-in/actions.ts
- apps/web/src/application/authentication-entry.ts
- apps/web/tests/authentication-entry.test.mjs
- apps/web/tests/application-shell.test.mjs
- apps/web/tests/design-system.test.mjs
FORBIDDEN_SCOPE:
- apps/web/app/layout.tsx
- apps/web/app/globals.css
- apps/web/src/presentation/design-system.tsx
- apps/web/src/infrastructure/identity/*
- apps/web/src/application/security.ts
- apps/web/src/application/session.ts
- apps/web/src/application/shell.ts
- apps/web/proxy.ts
REAL_DATABASE_CONTACT: NO
PRODUCTION: NO

# ROSUNO — P2-005 Identity Entry: Existing-Account Sign-In / Sign-Out

**Status:** Primary finalized **Packet candidate for independent Backup Gate 0 audit only**. NOT YET BACKUP-PASSed, owner-authorized for Gate 1, committed, mirrored, executed or deployed. Target repository path upon *later separate* authorization: `docs/work-items/P2-005/PACKET.md`. This public-safe Packet is the whole proposed body; do not wrap, append, or change its bytes after audit. A Backup PASS must bind to the exact SHA-256 of this body.

## 1. Authority, current state and selected decision

- **Authority order:** current 11 private LOCKED Rosuno product authorities, then bounded owner decisions, then adopted UOM v1.7 as procedurally amended by owner-adopted Cloud Builder C1 **rev 5.1**, this Packet, and finally code. STOP on disagreement; never copy locked documents into public GitHub or Claude Cloud.
- **Applicable locked product sections:** Implementation Master Plan v1.0 LOCKED §17 (P3, M1/M2); MVP Build Specification v1.0 LOCKED Milestone 2; Technical Architecture v0.2 LOCKED §3.1 (Identity & Access), §19 (layered authorization), §56 (abuse/rate limiting); Physical Supabase/PostgreSQL Specification v1.0 LOCKED §§4–5 (Supabase Auth identity distinct from application identity/authorization). Other locked constraints remain operative.
- **Owner-selected next bounded feature:** First P3 slice is **existing Supabase Auth account sign-in and sign-out only**. This does NOT represent complete P3/M1/M2, client/attorney/staff onboarding, application identity provisioning or production readiness. The locked P3 roadmap requires those later separately scoped controls.
- **Read-only canonical baseline:** `NatthanPrevot/Rosuno` protected `main` at `572bc7127a741d30c9245ca6ae04c0da014eee08`, tree `439971c0cbb7c717843519b254c7f9a593aa120d`; Builder fork `RosunoBackup/Rosuno` `main` at the same SHA/tree (0/0 ahead/behind at the verified checkpoint). Four required checks on owner `main`: `deterministic install`; `format, typecheck, build, controls`; `dependency and security checks`; `rosuno-guard` (GitHub Actions app 15368). Reconcile again before Gate 1 publication; any drift is STOP, not automatic rebase.
- **Existing code:** Next.js 16.3.8 / React 19.3.0, `@supabase/ssr` ^0.12.7 and `@supabase/supabase-js` ^2.117.2, Node 24 and CI pnpm 10.26.1. `apps/web/src/infrastructure/identity/supabase-server.ts` supplies the request-scoped Supabase SSR server client and cookie exchange; `server-session-source.ts` trusts verified `getClaims().data.claims.sub` only. `apps/web/proxy.ts` refreshes the server session. `apps/web/src/application/session.ts`, `shell.ts`, and `security.ts` remain separate and unmodified. No `/sign-in` route, sign-in action, or sign-out action exists at base. The current homepage `getShellView()` has no supplied identity source and is therefore a foundation demonstration, not a working login. The P2-005 homepage must explicitly pass the existing trusted `SUPABASE_SERVER_SESSION_SOURCE` to `getShellView`.
- **Provider configuration:** Existing server code expects `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Do not create, add, inspect or use real credentials in Builder Cloud. No remote Supabase contact is authorized. Unconfigured behavior must be tested as unavailable. Do not change environment, Next, Supabase, package or repository settings.

## 2. Required functional implementation

1. **Sign-in page `/sign-in`:** A clear existing-account sign-in entry, with email and password controls, explicit labels, appropriate input types/autocomplete, visible keyboard focus, semantic form, suitable required-field validation, accessible generic errors and clear submission affordance. It must be responsive and professionally composed **using the existing locked P2-002 design primitives/tokens** (warm/cream base, restrained gold, accessible contrast, native focus/error semantics). No new theme, bespoke hard-coded palette, speculative redesign or alteration to the existing design-system files. Do not claim UI/accessibility certification without evidence.
2. **Real server-owned sign-in:** POST through a Next.js server action in `app/sign-in/actions.ts` (not client-only authentication). Use `createSupabaseServerClient()` and the existing provider-supported `supabase.auth.signInWithPassword({ email, password })`, with exact installed APIs confirmed at implementation. Handle malformed/missing inputs, configuration/provider unavailable, rejected credentials, thrown errors and unusable verification by failing closed; do not leak provider errors, identifiers, passwords or tokens. After apparent success, verify authenticated identity through the existing trusted server claims boundary before reporting success; clear any partial provider session on verification failure where the existing provider supports it, otherwise STOP on an unresolved unsafe state. Redirect only to fixed safe internal destination `/`; do not honor caller-supplied `next`, `returnTo`, role, user ID, capability or URL.
3. **Real server-owned sign-out:** A deliberate POST form/server action (the same small action module may export both actions), using provider `supabase.auth.signOut()` on the request-scoped client. Never use a state-changing GET or client-only state clearing. After successful logout, a fresh trusted claims/session read is anonymous; no cached authenticated presentation. If provider logout fails or is unavailable, do not falsely report success. No broad session-revocation or account-security policy is invented.
4. **Thin testable application operation boundary:** `src/application/authentication-entry.ts` contains only provider-neutral, injectable sign-in/sign-out orchestration, safe result codes and input checks required for focused deterministic tests. It holds no credentials between requests, never persists them, confers no app principal/role/capability, and makes no business or regulatory determination. Server actions own the framework/provider and cookie lifecycle. Do not build a generic identity framework or alternate credential store.
5. **Homepage entry:** Preserve the existing P2 shell/design-foundation page and insert only a small clearly labeled **Sign in** link for anonymous sessions and a **Sign out** POST form for authenticated sessions. Resolve presentation session state from `getShellView(SUPABASE_SERVER_SESSION_SOURCE)` only. Never display `claims.sub`, token or other sensitive identity; never treat authentication as proof of any profile, staff capability, attorney verification, legal eligibility, jurisdiction or booking right.
6. **Request/session safety:** Rely on documented Next Server Action origin/host protection and cookie handling; never disable or bypass those protections. Avoid credential-bearing GET URLs, unsafe redirects, raw error reflection, leaking values into logs/telemetry/tests/screenshots, or cache-sharing of session state. Use existing per-request dynamic rendering and safe post-action revalidation/redirect semantics. Missing/expired/tampered session or failed provider claims must remain anonymous/denied via the existing boundary. Do not import Supabase directly into generic presentation or policy modules.
7. **No invented records or policy:** Do not create accounts, clients, attorneys, staff, seeded users, new email flows, a fake successful login or payment/legal authority. Test exclusively against isolated in-memory stubs/fixtures; no live end-to-end claims in this work item.

## 3. Exact paths and allowed changes

The seven **literal** `ALLOWED_SCOPE` paths above are exhaustive; no wildcard additions. New: `app/sign-in/page.tsx`, `app/sign-in/actions.ts`, `src/application/authentication-entry.ts`, `tests/authentication-entry.test.mjs`. Modify only as needed: `app/page.tsx`, `tests/application-shell.test.mjs`, `tests/design-system.test.mjs`. New route folders are implicit in those paths.

- Keep `app/globals.css`, `app/layout.tsx`, `src/presentation/design-system.tsx`, the trusted Supabase identity boundary, `proxy.ts`, generic Security Shell and existing source session model untouched. Existing primitives include `Page`, `Surface`, `Stack`, `Heading`, `Text`, `FieldGroup`, `TextField`, `Button`, `ButtonLink`, `Alert` and `Status`.
- Existing foundation tests contain old **exact homepage shape** assumptions (including restricted imports, a single presentation expression, and no page conditionals), although their comments expressly anticipate later P3 session wiring. Adjust only the minimum such assumptions to admit this authorized entry UI and the trusted source; preserve and strengthen the actual security/design invariants. **Never delete, skip, weaken, or broadly waive** the historical tests or code restrictions to make a red check green. New tests must prove the additional behavior and continued absence of browser-owned identity authority. If a valid invariant cannot be preserved without expanding scope, STOP and report to the Primary.
- `MIGRATIONS: none`. No `supabase/` edits, existing migrations, new tables/columns/indexes/RLS/ACL, seeds, schema history changes, `package.json`, lockfile, dependency installation changes, global CSS, environment files, settings, docs other than the owner's Packet publication, workflow/guard, Git history rewrites or config adjustments. Later P3 M2 security requirements are not waived by this bounded first slice.

## 4. Acceptance criteria and deterministic validation

**Functional:**
- Anonymous request offers a usable `/sign-in` entry; page renders with existing design-system components and accessible email/password form, responsive on narrow/mobile widths, keyboard-operable and with nondisclosing inline error states.
- Stubbed provider acceptance + verified claims produces authentication on a fresh server request with correct cookie-backed session semantics; trusted view updates, without turning account existence into business authorization.
- Invalid/missing input, bad credentials, provider error/throw/unavailable configuration and malformed/expired/absent claims produce denied or neutral state with no sensitive material in output or URL. Fixed internal redirects only; no caller-injected redirect or identity.
- Valid intentional sign-out clears provider session as supported and future trusted reads are anonymous. Provider logout failure is not announced as success. GET cannot sign out.
- In-memory deterministic unit tests exercise successful/failed sign-in and sign-out, exception and redaction cases, state separation, fixed redirects, and no client-asserted identity. Existing session, Security Shell, application shell and design-system regression assertions remain effective.
- No runtime provider test against real staging, Production, OLD or other Supabase, and no real account creation. Build success **does not** certify real-provider production readiness.

**Exact commands for *later separately authorized* Builder Gate 1, only in the approved disposable `rosuno-builder` fork session, against the audited Packet:**

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
bash .github/scripts/rosuno-guard.sh 572bc7127a741d30c9245ca6ae04c0da014eee08 HEAD wi/P2-005-authentication-entry refs/rosuno/approved
```

Install/build may write only ignored disposable dependency/build outputs (`node_modules`, Next `dist`); these must never enter commits. Network needed for ordinary package installation/audit is governed by the already adopted C1 Trusted-network boundary; no ad hoc network route, MCP connector or remote database access. If a dependency command, version, network, guard or required check is blocked, STOP with native error evidence; do not substitute a workaround or change settings. Do not invoke root `rosuno:check` without a separately audited command contract, since its Fast-Control CLI requires exact `--base`, `--head`, `--branch` fields and expects canonical origin, not the Builder fork. The commands above match the existing root scripts and protected CI definitions as inspected on the base SHA.

**At separately authorized PR Gate 2B:** all four required GitHub checks successful on the exact PR head, including owner-triggered `rosuno-guard` with the correct PR number and Packet SHA; independent Backup PR PASS for the exact head; real designated Rosuno reviewer approval (not owner/Builder); separate owner merge-commit authorization. No automatic PR, approval or merge.

## 5. Workflow, authorization gates and STOP conditions

- **Gate 0 (NOW):** Independent Backup audits the **exact bytes** and reports `PASS`, `CORRECTIONS` or `STOP`. A PASS must report `PACKET_BODY_SHA256=<64 hex>` matching this proposed public-safe body; no change after PASS without re-audit. The owner separately chooses whether to authorize Gate 1.
- **Gate 1 (NOT YET AUTHORIZED):** After fresh relevant read-only reconciliation confirms unchanged identity/base/Packet/migration/config boundaries, the owner publishes exactly this `docs/work-items/P2-005/PACKET.md` as the **first, Packet-only commit** on owner `wi/P2-005-authentication-entry` branch from `BASE_SHA`; owner independently syncs fork main and mirrors the identical Packet as its first, Packet-only fork branch commit, confirming the Git blob equality. The owner then starts one fresh Claude Cloud session in `rosuno-builder` connected **only** as `RosunoBackup` to `RosunoBackup/Rosuno`. Only the separate bounded owner Gate 1 authorization permits these operations and the Builder's in-scope implementation/validation/fork push. Builder commits linear, forward-only to fork only and reports exact evidence; no Replit Agent.
- **Gate 2A (later):** Primary reviews exact fork branch/HEAD/diff/tests/guard read-only against Packet. Ordinary corrections only within this Packet. Changes to Packet/scope/authority or unexplained drift are decision gates, not Class A fixes.
- **Gate 2B/3/4 (later, separate owner gates):** Owner creates PR to canonical `main`; required checks and exact-head independent Backup audit; designated human reviewer approves; owner merges using a two-parent merge commit. GitHub merge does not authorize remote DB/Production deployment.
- **Environment:** no Supabase application or real database contact of any kind; no Staging, OLD/reference, Production, live external identity provider, credential inspection, secrets, GitHub settings/policy, authentication-provider policy, connector usage, regulatory assumptions or client/legal/business data. No fake production identities.
- **STOP immediately:** unexplained GitHub branch/tree/Packet deviation; unexpectedly modified/recreated tracked files or untracked code outside scope; mismatched repo/fork/account/Cloud environment; disallowed credential, tool or network contact; missing/changed dependencies; failed uncorrectable tests or migration changes; an actual need for registration, recovery, capability grants, account provisioning, schema/RLS, rate-limit infrastructure, extra paths/dependencies, counsel/legal decisions, provider contract exceptions or new configuration. Report exact evidence; WAIT for fresh independent Backup review and separate owner decision. Never bypass restrictions or weaken safeguards.

## 6. Required Builder completion evidence (only after separate Gate 1 authorization)

```
STATE: STABLE | BLOCKED
BRANCH / HEAD SHA / BRANCH URL:
BASE_SHA / PACKET BLOB / PACKET BODY SHA256:
CHANGED FILES (literal list):
TESTS RUN (exact command — exit/result; no secret output):
ROSUNO-GUARD SELF-CHECK (exact PASS line or failure):
UNAUTHORIZED/UNTRACKED CHANGES: NONE | detail
REFUSALS / LIMITATIONS:
RISKS / UNRESOLVED QUESTIONS:
```

**Governance restriction:** This document is a proposed exact public Packet body, not a command to execute. Its separate audit and owner implementation authorization are indispensable. Preserve original locked authority, UOM v1.7, original Cloud Builder C1 rev 5.1 and historical evidence unchanged.
