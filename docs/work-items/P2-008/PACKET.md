WORK_ITEM: P2-008
TYPE: FEATURE
BRANCH: wi/P2-008-account-recovery-v3
BASE_SHA: 89ebf6a014b85c27c481ba23bcf85543b685ceb2
MIGRATIONS: none
ALLOWED_SCOPE:
- apps/web/app/sign-in/page.tsx
- apps/web/app/forgot-password/page.tsx
- apps/web/app/forgot-password/actions.ts
- apps/web/app/reset-password/page.tsx
- apps/web/app/reset-password/actions.ts
- apps/web/src/application/account-recovery.ts
- apps/web/tests/account-recovery.test.mjs
- apps/web/tests/client-registration.test.mjs
FORBIDDEN_SCOPE:
- .github/*
- .claude/*
- CLAUDE.md
- AGENTS.md
- governance/*
- docs/process/*
- rosuno-authority/*
- supabase/*
- .replit
- .replitignore
- package.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- apps/web/package.json
- apps/web/app/auth/*
- apps/web/app/sign-in/actions.ts
- apps/web/app/sign-up/*
- apps/web/app/page.tsx
- apps/web/app/layout.tsx
- apps/web/app/globals.css
- apps/web/proxy.ts
- apps/web/src/application/authentication-entry.ts
- apps/web/src/application/client-registration.ts
- apps/web/src/application/security.ts
- apps/web/src/application/session.ts
- apps/web/src/infrastructure/*
- apps/web/src/presentation/*
- apps/web/tests/authentication-entry.test.mjs
REAL_DATABASE_CONTACT: NO
PRODUCTION: NO

# ROSUNO — P2-008 Existing-Account Password Recovery — REVISION 3 Gate 0 Candidate

**STATUS: REVISED GATE 0 CANDIDATE FOR INDEPENDENT BACKUP EXACT-BYTE AND RELEVANT LOCKED-AUTHORITY REVIEW ONLY. NOT ADOPTED. NOT PUBLISHED. NO IMPLEMENTATION OR CONFIGURATION AUTHORIZED.**

**Recovery design retained from Revision 2; Revision 3 corrects one inherited-test compatibility conflict:** Replace the original deliberately non-dispatching request-only slice with one bounded, genuinely usable *request → provider email → browser returns with provider-issued PKCE code → deliberate POST verifies code and changes password → confirmed session cleanup* flow. There is no value in presenting a working-looking recovery form which cannot recover an account. This candidate uses the already-installed Next.js 16, `@supabase/ssr` and `@supabase/supabase-js` clients, and existing server client/configuration. It does not propose new tables, dependencies, secrets, SMTP systems, flags, configuration, or generalized authentication infrastructure. Its **nonproduction implementation** can be fully tested using in-memory provider fixtures, but **actual outbound provider email may be enabled only when an existing compatible provider configuration is independently verified under a later deployment gate** (§5). This is not a claim that the presently deployed provider has already met those prerequisites.

## 1. Authority, baseline, limits

Authority order: the eleven accepted original private LOCKED Rosuno documents > subsequent express owner decisions > adopted UOM v1.7.3 and C1 rev5.4 > one Backup-PASSed and owner-adopted exact-byte Packet > source code. The headings retained inside the adopted consolidated UOM/C1 are immutable source history and do not nullify documented later adoption. Do not publish LOCKED originals into either public GitHub repository or a Claude Cloud session.

Relevant LOCKED originals: MVP Build Specification v1.0 Milestone 2 requires account recovery, **secure** account recovery and authentication/recovery abuse tests; Implementation Master Plan v1.0 §17 requires recovery, rate limiting and abuse controls. The existing P2-005 authentication boundary and P2-006/P2-007 registration security remain independent; recovery must not introduce business principal, attorney, staff, capability, or jurisdiction authority. Full M2 completion is *not* claimed.

Pinned last independently confirmed state: both `NatthanPrevot/Rosuno:main` and `RosunoBackup/Rosuno:main` = `89ebf6a014b85c27c481ba23bcf85543b685ceb2` after expressly authorized normal fast-forward. These are **candidate planning refs**, not a lease on future `main`; recheck before any separately authorized write gate. The existing repository has `/sign-in`, `/sign-up` and signup-only `/auth/confirm`; it has no approved recovery route, and P2-008 was not in the 29-entry work-item registry at the pinned SHA. The signup confirmation route (`type=email`) must not be repurposed, edited, or interpreted as recovery-token redemption.

## 2. Design selection and provider compatibility

**Chosen narrow architecture: provider-standard PKCE password recovery, deliberate POST completion, no GET-side account transition.** Supabase documentation confirms `resetPasswordForEmail(email, { redirectTo })`, recovery PKCE, `exchangeCodeForSession(code)` and `updateUser({ password })`, with allowed redirect URLs and existing Auth recovery email infrastructure. This supports a complete flow with the existing libraries, *subject to the deployed provider settings in §5*. No bespoke reset tokens, direct Auth table writes, admin credential access or new email sender.

- The request Server Action obtains one request-scoped existing unprivileged server Auth client through `createSupabaseServerClient()`; the provider operation is `auth.resetPasswordForEmail(validEmail, {redirectTo: fixedRecoveryUrl})` and is **not** a sign-in or user-creation operation. `fixedRecoveryUrl` is derived only from the existing server-controlled `ROSUNO_AUTH_PUBLIC_ORIGIN`, validated as one exact canonical HTTP(S) origin, plus fixed `/reset-password`. Never take origin/redirect from request headers, form fields, query parameters or cookies. No arbitrary `next` or external redirect. Do not add a new environment variable.
- The existing SSR client is PKCE-capable and uses request/response cookies to persist a temporary verifier for the **requesting browser**. Require documented proof from the installed dependency that the verifier is actually written and available on the subsequent callback. **No implicit-fragment grant, token parsing, magic-link fallback, untrusted token_hash, email OTP substitution, or direct session setter.** A different browser/device or missing verifier is a normal generic recovery failure, not permission to waive proof.
- Recovery email follows the provider's configured **Reset Password** template. The provider-generated link must return to the exact allowed `/reset-password` URL with an exchangeable PKCE `code`; only provider-authorized recovery is accepted. Never treat a supplied query value itself as proof. Existing email template, origin/redirect configuration and auth rate limits must be verified as a prerequisite, *not changed by this Packet*. If the provider actually produces a fragment, an unexpected code shape, or an unintended destination, STOP: do not improvise another flow or claim dispatch is usable.
- **Rosuno GET boundary, not upstream provider behavior:** The `/reset-password` GET renders an inert accessible password-and-confirmation form and an explicit submit control. It may display a bounded well-formed opaque code from its own fixed URL in a hidden field, but must not exchange a code, create or refresh a session specifically for recovery, call Auth recovery/update operations, change the password, or redirect to a supplied address on GET. Disable caching, indexing, external asset loading and referrer leakage for the sensitive recovery view to the extent achievable within the allowlisted page. Do not log, persist, emit into error text, or forward the code beyond this first-party form; no third-party analytics/prefetch. Existing proxy session maintenance is not new recovery authorization. **Separate upstream behavior:** Before the browser reaches Rosuno, a standard Supabase Reset Password email link may invoke Supabase `/auth/v1/verify` and consume its single-use verification token on a GET. Email-provider link scanners/prefetchers may consume that upstream link before the human opens it. An inert Rosuno GET does not prevent or undo such upstream consumption. Confirm actual link behavior at the existing provider/template compatibility gate; do not assert that the entire email-click sequence is GET-inert, bypass a consumed token, or introduce a template/configuration change under this Packet.
- On deliberate POST, the action validates the entire submitted form and new-password confirmation **before** consuming the one-time code. Only a well-formed single-use code with the same-browser PKCE verifier may be exchanged via the supported `auth.exchangeCodeForSession(code)`. Require provider-confirmed success, a coherent authenticated user/session issued **by this exchange**, and no caller-controlled subject or role. Then, and only then, invoke supported `auth.updateUser({ password })` for that one recovered Auth identity. Never use a preexisting signed-in account session, a bearer token from the client, or failed/missing exchange as authorization to change a password.
- **Session containment is an acceptance condition.** The exchange may write an authenticated session to the request's SSR cookie store; the action must terminate its newly established current-browser session with `signOut({scope:'local'})`, then establish a fresh trusted absence-of-session result before claiming success. Verify the actual response-cookie lifecycle and all partial-failure paths in installed SSR/Next runtime fixtures. An update failure, throw, ambiguous provider result or failed/unverifiable cleanup must not produce a successful/reset-complete message. If a verified safe outcome cannot be achieved in these eight paths without leaving an unintended valid recovery-authenticated browser session, **STOP → REPORT → WAIT; do not publish an ostensibly complete feature**, silently manipulate cookie internals, or expand scope. Explicitly document any ambiguity where password update may already have happened but confirmation/cleanup failed. Never globally sign out other user sessions unless separately authorized.
- On fully confirmed password update and session cleanup, show a truthful neutral completion result or redirect only to fixed first-party `/sign-in`. Do **not** represent delivery of a recovery email, identity verification, login privilege, Client/Attorney/Staff eligibility, or application authorization as established by request initiation alone.

**Password lifecycle gate (do not resolve by inference):** The owner-adopted D-01 password rule in P2-006 currently applies explicitly to registration; it was *not* authoritatively extended to password changes/resets. This draft does not invent a new recovery password policy, and does not import/change the registration validator under a forbidden path. The minimal reset action must preserve exact submitted password bytes, confirm exact equality, reject malformed input, avoid leaks, and respect the actual provider's accepted password bounds. **Independent Backup must evaluate the relevant locked requirements and whether extending D-01 to recovery requires a separate express owner decision before release.** That unresolved lifecycle decision is **not** a prerequisite for Gate 0 review, Packet adoption, or separately authorized nonproduction fixture-only implementation absent a demonstrated higher-authority conflict; release remains HOLD until any required owner decision is resolved. Do not implement a weaker or invented interpretation. A later correction to the eight-path allowlist would require a new exact-byte audit; no convenience scope expansion.

## 3. Exact permitted implementation (eight paths)

1. `apps/web/app/sign-in/page.tsx`: Add one fixed internal keyboard-accessible “Forgot password?” link. Do not modify sign-in or sign-out behavior.
2. `apps/web/app/forgot-password/page.tsx`: Existing-design responsive accessible email request form, semantic POST Server Action, input/pending/error/neutral outcome and fixed internal navigation. No GET-side email dispatch.
3. `apps/web/app/forgot-password/actions.ts`: Server-owned request action; existing request-scoped SSR Auth client; provider-standard `resetPasswordForEmail` with *only* server-trusted fixed redirect; provider-neutral orchestration; generic outcomes. Avoid leaking PKCE verifier, email, provider errors or account existence into response state.
4. `apps/web/app/reset-password/page.tsx`: Accessible inert callback/read and password/confirmation form. Render/link no outside destinations; explicitly handle missing/duplicate/malformed code as invalid; no automatic code redemption or session establishment on GET.
5. `apps/web/app/reset-password/actions.ts`: Server-owned POST completion using the same request-scoped client and `exchangeCodeForSession`, then `updateUser({password})` and local sign-out with trusted verification, in that sequence. No administrative API, direct database write, or uncontrolled redirect.
6. `apps/web/src/application/account-recovery.ts`: Minimal provider-neutral injectable request/completion orchestration, bounded email/code/password/form validation, fixed result types and failure-state handling; no duplicated Auth session/authorization infrastructure or mutable cross-request storage.
7. `apps/web/tests/account-recovery.test.mjs`: Deterministic Node `node:test` in-memory provider and Next cookie/SSR source-contract fixtures for full path and negative cases. No real identities, accounts, SMTP, provider network, external DB, or fake **business** entities.
8. `apps/web/tests/client-registration.test.mjs`: **Test 37 only**, for one precisely scoped inherited-test compatibility correction. Its existing loop reads all `app/` and `src/` TypeScript source paths and rejects `exchangeCodeForSession` everywhere. Amend that one prohibition to allow **exactly one direct, literal** `client.auth.exchangeCodeForSession(code)` call in the comment-free `app/reset-password/actions.ts` source **only** (repository path `apps/web/app/reset-password/actions.ts`), in the server-owned POST recovery action; reject the method anywhere else under `app/` or `src/`, more than one invocation in the permitted path, aliases/computed calls that do not satisfy the exact permitted shape, and all previously prohibited Auth methods on every path including this one. Keep the existing `.signUp(`, `signInWithOtp`, `generateLink`, invitation/admin, `.upsert(`, `.delete(`, privileged-client, public-key/secret, import, export, quota RPC and registration constraints operative and unchanged. Add targeted negative source-fixture assertions **within test 37** proving that a code-exchange call injected into a non-recovery source file and a second exchange in the recovery action fail the restriction. Keep other test-37 checks and all unrelated tests intact; do not remove the test, blanket-skip the file, or permit generic Auth code exchanges. This exception is not authorization to create sessions outside the recovery POST path.

**No ninth implementation path, dependency/config change, additional API endpoint, unrelated helper, refactor, or test relaxation beyond test 37's exact recovery exception may be inferred.** If the installed Next/SSR PKCE cookie behavior, response security requirements or failure cleanup cannot be met within these eight paths, stop and return a precise scope blocker for Backup/owner decision. Historical migrations are immutable.

## 4. Security, abuse, and deterministic acceptance

- **Request boundary:** exactly one bounded `email`, no malformed/repeated/unexpected fields, no arbitrary `redirectTo`, subject, password, code, role or privilege on initiation. Trim only outer email whitespace and validate; use one trusted target origin. Validate without revealing registered vs unregistered address. The method's provider response is not proof of message delivery. Return the same non-enumerating neutral request-state and user-visible copy for valid-looking emails regardless of account existence; unexpected provider errors must not leak sensitive details or imply assured delivery. When entirely unconfigured, report unavailable to all inputs consistently rather than pretend an operation ran.
- **Abuse boundary:** provider's actual `/auth/v1/recover` per-user/email rate limit and mail-delivery limits must be recorded under the later provider-environment gate. The client-facing server action must never bypass these limits, use an admin/reset workaround, repeat automatic sends, or manufacture a trusted IP from headers. Backup must examine whether this provider-native control suffices for this nonproduction work item under the locked recovery-abuse tests. **It is not asserted to be proof of production-grade rate limiting or resistance to distributed arbitrary-email abuse.** A proven deficiency means STOP, not an invented new rate-limiter framework.
- **Completion boundary:** POST only; no mutation on GET; missing/duplicate/replayed/invalid/expired/wrong-browser PKCE code, mismatched passwords, failed code exchange, missing/unreadable issued session, provider `updateUser` failure, failed sign-out, or unverifiable absence of session are all handled without successful completion claims. Recovery grants **no** Rosuno User/Client/Attorney/Staff application role; any transient provider session must be contained. Do not reuse signup `type=email` or a preexisting session to update credentials.
- **Password boundary:** never store, echo, log or URL-encode submitted passwords; exact confirmation match and actual provider-bound limitations. Do not turn provisional D-01 lifecycle scope into an implicit owner decision.
- **Compatibility:** unchanged sign-in/sign-out, signup confirmation, registration (including fail-closed abuse-control wiring), Security Shell, existing origin and SSR session protections; only the test-37 recovery-code exchange exception specified in §3 is permitted in the inherited registration test, and its unrelated assertions must remain enforced. No modified locked presentation or governance files; no new production/security claims.

Required negative fixtures include an inherited test-37 rejection of recovery-code exchange in any unauthorized `app/` or `src/` file and of a second exchange in the permitted action; an existing signed-in browser opening a recovery link, a missing PKCE verifier, code replay, mismatched/invalid new password, provider accepting an email request but no email delivered (never claim delivery), provider sending an unexpected fragment/callback (activation HOLD), partial token exchange followed by password-update failure, sign-out failure, and session-read uncertainty. For any case that cannot be safely contained and explained by the installed code, the Builder must stop instead of passing a weaker test. Test that no provider or email call happens on either GET and that code exchange never occurs for invalid form input. The test suite must demonstrate the selected end-to-end **fixture** path, not claim a live email/provider completion.

## 5. External activation prerequisites — no config mutation authorized

Implementation and deterministic validation are **nonproduction, network-free**. A separately authorized future provider/deployment read-only verification must establish ALL of the following before outbound recovery requests are enabled in any real Rosuno environment:

A. `ROSUNO_AUTH_PUBLIC_ORIGIN` is the intended first-party origin for that environment; the existing Supabase Auth allowed redirect URLs include exactly the corresponding `/reset-password` return (or a proven safe restrictive matching rule). No derived request header or wildcard assumption.

B. The current Reset Password email template actually uses the expected provider flow and yields a real recovery-specific PKCE `code` redirect for the installed SSR client, rather than an implicit URL fragment or wrong destination. Provider-generated email link semantics, upstream `/auth/v1/verify` processing, mail-link prefetch/scanner behavior, one-time use, expiry and same-browser verifier behavior must be verified. An inert Rosuno GET does not guarantee the upstream Supabase verification link was not consumed. No template editing is authorized here.

C. Existing provider delivery and actual recovery-rate-limit behavior satisfy the bounded nonproduction test contract without bypass, fake messages, or live test accounts invented by the Builder. Real email testing, if later necessary, requires separate bounded owner authorization and approved existing test identities only.

D. A verified recovery-completion transaction changes only the matching Auth account password, does not grant Rosuno application access, and leaves no unintended persistent recovery-authenticated browser session. Any D-01 lifecycle decision from §2 must be resolved through the correct authority gate before release.

**If A–D cannot be proven using pre-existing authorized configuration, the implementation may be reviewed as code-complete in fixtures but the feature remains DEPLOYMENT HOLD / NOT LIVE.** The developer must not add new configuration, secrets, email templates, endpoints or safety abstractions under this Packet merely to force a demo. The owner may separately choose a small authorized provider setting change or an explicitly non-operational staging slice; neither choice is authorized by this candidate. There is no success claim for a deployment that does not satisfy these conditions.

Provider references supporting only architectural feasibility, not actual Rosuno provider state:
- https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail
- https://supabase.com/docs/reference/javascript/auth-exchangecodeforsession
- https://supabase.com/docs/guides/auth/sessions/pkce-flow
- https://supabase.com/docs/guides/auth/passwords
- https://supabase.com/docs/guides/auth/redirect-urls
- https://supabase.com/docs/guides/auth/rate-limits

## 6. Builder validation, current commissioning boundaries

Only after Backup exact-byte PASS, express owner Packet adoption, fresh read-only reconciliation and separate owner authorization of the requisite individual publication/implementation gates: owner publishes immutable Packet-only commit on the new owner work branch; mirrors exact Packet on the same new fork branch; Claude Code Builder uses only `rosuno-builder` Cloud environment and the approved fork; Builder makes bounded source/test changes, runs checks, verifies the guard, commits linearly, and publishes fork-only. The **first genuine Claude fork publication** must establish the authenticated push principal as `RosunoBackup` by actual publication evidence; Git author/committer labels or a green connector UI do not prove authenticated Git identity. Do not use historical human publication exceptions, bot PR creation or advanced PROCESS automation.

Required checks in the later authorized Builder session, with versions, actual stdout, exit codes, changed-file list, per-commit history and cookie/security negative test evidence retained:

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
bash .github/scripts/rosuno-guard.sh 89ebf6a014b85c27c481ba23bcf85543b685ceb2 HEAD wi/P2-008-account-recovery-v3 refs/rosuno/approved
```

The owner repository retains four required protected CI checks and `rosuno-guard-trust`. All changes must remain inside the exact approved implementation allowlist (the first Packet-only commit follows C1's separate rule); no independent GitHub permission, Supabase mutation or ordinary implementation approval is created by an adopted Packet alone. On any unexpected branch/commit/config/migration/history difference, unmet provider semantics, uncontained session, failed inherited test, or authority conflict: **STOP → REPORT → WAIT**.

## 7. Gate sequence and specific Backup review questions

**Gate 0 now only:** Independent Backup reviews these exact bytes against relevant accepted LOCKED M2/security requirements, adopted UOM/C1, actual installed Next/SSR/Auth capabilities and unchanged code/tests. In particular, assess (1) whether eight paths can implement same-browser PKCE recovery and safely clear all recovery-established cookies after a failed or successful POST, including the one narrowly scoped test-37 exception and its negative regression assertions, (2) whether Rosuno's inert GET can coexist with upstream Supabase verification-link processing and email prefetching under the existing Reset Password template and provider compatibility gate, (3) whether account-abuse limits are adequate for the bounded nonproduction feature, and (4) whether D-01 password-policy lifecycle needs an express owner decision or separate audit before any feature activation. Return PASS, narrowly bounded CORRECTIONS, or BLOCKED; never claim certainty from documentation alone.

If Backup returns PASS on the exact body and no authority conflict is demonstrated, owner may *separately* adopt the Packet and authorize the **first** repository Packet publication gate; the unresolved D-01 recovery-lifecycle release decision remains explicitly deferred, not silently adopted. Owner/fork Packet mirroring, Claude implementation/publication, Primary 2A source review, separately owner-created PR (2B), four exact-head CI checks and guard, Independent Backup PR audit (3), designated human approval, and separately owner-authorized normal two-parent merge (4) remain distinct. No Supabase, production, configuration, template or email test mutation is approved by any of these steps.

**Gate 0 request:** Exact-byte and relevant LOCKED-authority review of `P2-008 REVISION 3`. A proposed SHA-256 is supplied as reference only, not as proof of PASS or owner adoption.
