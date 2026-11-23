# IMP §40 security review — preparation pack (MVP-001)

This is the preparation pack for the production security review that IMP §40 requires. **The IMP §40 security review
itself has not been performed**, by anyone. An independent review of the S11 code and of this readiness pack was
performed on 2026-11-22 by three separate review agents and its confirmed defects were corrected (architecture
verification, section 7.3); the PS-A6 implementation (`c445960`) was independently reviewed on 2026-11-22 by two
separate review agents and its findings were corrected in `d9d1151`, and a further check of `d9d1151` on 2026-11-23
by a separate review agent led to the corrections in `2a1b94f` (section 7.4). None of these is the IMP §40 review. This
file is the Builder's map of the system, its controls, where each control is proven, and the risks already known, so
that a security reviewer can start.

State: the S11 head `5283fda`; the PS-A6 additions are cited at `2a1b94f`. Sections are cited by number only; no locked
text is reproduced. File paths are relative to `apps/web/` unless they start with `supabase/`, `governance/`, `tools/`
or `.github/`.

## 1. System boundary and trust zones

| Zone                               | What runs there                                                                                                                                                             | Trust                                                                                     | Entry points                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Browser                            | Server-rendered pages; 44 client form modules; the media provider's room page in a frame                                                                                    | Untrusted; display only (Packet rule 13)                                                  | Pages, server actions, `connect-src 'self'`                                                                        |
| Application server (Next.js)       | Server pages, server actions, the proxy (correlation id), five route handlers, adapters under `src/infrastructure/`                                                         | Trusted for orchestration; never the authority for a business decision                    | `app/**/page.tsx` (85), action modules (30), `app/api/jobs/run`, three provider webhook routes, `app/auth/confirm` |
| Database (Supabase PostgreSQL)     | Row level security on every relation; 476 functions (212 security definer, counting three made definer by `alter function`); 176 triggers; `pg_cron` sweeps where installed | The authority: every rule is re-checked here                                              | The Data API as `anon` or `authenticated` (functions and the few row policies); the privileged key in one module   |
| Identity provider (Supabase Auth)  | Sign-in, MFA (TOTP), JWT issuance, confirmation and recovery emails                                                                                                         | Trusted platform; settings live outside the repository                                    | Hosted Auth endpoints                                                                                              |
| Storage                            | One private bucket for protected resources; access by short-lived signed links authorized by the database                                                                   | Trusted platform                                                                          | Signed links (60 s)                                                                                                |
| Providers (payments, media, email) | Test-mode payment account, media rooms, email sending                                                                                                                       | External; every event is an observation, authenticated before any effect (Packet rule 12) | Outbound `fetch`; inbound signed webhooks                                                                          |
| Scheduler and worker               | Five `pg_cron` sweeps (database only); the worker route drains jobs after commit or when called                                                                             | The worker route needs a shared setting                                                   | `POST /api/jobs/run`                                                                                               |

At `2a1b94f` (static counts, architecture verification, section 7.4): 89 pages, 33 action modules and 47 client
modules; 499 functions (226 security definer), 181 triggers and 49 row policies.

## 2. Authentication and assurance

- **Session assurance in the database.** Attorney and staff functions require `aal2` from the JWT (S2
  `20261118030000`; S2 AAL-1–8). Every S11 staff function requires `aal2` (S11 STAFF-1, REV-2, CMP-3, HOLD-1;
  operations AUD-1, OPS-1, CLI-1, LIFE-2), the PS-A6 break-glass and staff data-request functions included (ps-a6
  BG-1, BG-5, DR-3). The client data-request commands admit a client at any aal and a User who also holds an Attorney
  or Staff Profile only at aal2 (`20261127200000` header; ps-a6 DR-1).
- **Step-up in the application.** 53 attorney and staff pages are behind the step-up gate
  (`tests/step-up-routes.test.mjs:207`; 57 at `2a1b94f`, line 211, with the four break-glass and data-request pages);
  S11B-1 enumerates every page and action under `app/client`, `app/attorney` and `app/staff` from the file system and
  asserts its gate (signed out → sign-in; wrong role → refusal; attorney and staff surfaces behind step-up).
- **Registration is default-deny**: no client address is trusted, so every registration attempt is unavailable
  (`src/infrastructure/identity/registration-abuse-control.ts:62–64`); enabling registration is outside the Program.
- **Sign-in and recovery protection (PS-A4).** Reservations before the provider call, throttles and a
  suspicious-login threshold from server settings; a missing or invalid setting refuses sign-in or recovery
  (`src/infrastructure/identity/authentication-abuse-control.ts`; S2 ABUSE-1–14).
- **Known limits.** No recovery path for a lost MFA device; access tokens of sessions ended by a suspicious sign-in
  verify until expiry (S2 PR). D-7 (password rule on reset) is gated.

## 3. Authorization model

- **Capabilities.** 17 capability codes are catalog rows (`supabase/migrations`: P1, P5-001, S1, S2, S7 and nine in
  S11); 19 at `2a1b94f` with `approve_break_glass` (`20261127190000:123–124`) and `manage_data_requests`
  (`20261127200000:125–126`). Grants are configuration rows, global or scoped to one jurisdiction, with expiry and
  revocation; no self-grant (S1 CAP-1). The migrations insert no grant (S11 CAP-1; operations CAP-1; ps-a6 MIG-2).
- **Scope rules.** Each S11 surface states whether a jurisdiction-scoped grant suffices (outcome recording,
  moderation, complaints, referral operations, audit, attorney compliance sections) or a global grant is required
  (operations summary, client administration, Legal Holds, attorney lifecycle commands, financial summary). At
  `2a1b94f`: `approve_break_glass` follows the existing `has_staff_capability` rule with the Consultation's
  jurisdiction (a global grant for a Consultation without one); `manage_data_requests` needs a global grant (a data
  request carries no jurisdiction); requesting break-glass needs only an active Staff Profile.
- **Definer function-only writes.** API roles write no relation directly; each slice revokes table privileges and
  grants EXECUTE on named functions, with revoke-only loops over internal functions (for example
  `supabase/migrations/20261123020000_mvp_001_s7_payment_engine.sql:2815–2842`). Every S11 command and read
  is security definer with a pinned `search_path` and executable by `authenticated` only, except one public read;
  every internal, guard and trigger function is executable by no API role (S11 PRIV-2; operations PRIV-1).
- **Unknown and unauthorized answer alike.** Reads answer nothing and commands answer `not_found` or `denied` without
  revealing existence (for example S11 STAFF-1, CMP-1, FAM-1; operations AUD-2, CLI-1, LIFE-2).
- **Row policies.** 49 `create policy` statements; S11 adds one SELECT policy on `reviews` (own reviews).
  `complaint_cases` and `legal_holds` grant nothing to API roles (S11 PRIV-1); nor, at `2a1b94f`, do
  `break_glass_grants` and `data_requests`, which have row level security and no row policy (ps-a6 MIG-2, MIG-3).
- **Break-glass is not a bypass.** A grant confers no capability and is consulted by no general predicate, storage
  policy or capability check (`20261127190000:5–9`); only `staff_break_glass_consultation` reads through it, for the
  requester's own active grant and its one Consultation, read-only (ps-a6 BG-5, BG-6).
- **Admin is not a superuser bypass.** Staff see only the families and sections their capabilities cover (S11 FAM-1;
  operations CMPL-1); counts-only views carry no personal data (operations OPS-1, OPS-2).

## 4. Privileged key handling

- One application module reads the privileged key (`src/infrastructure/identity/registration-provisioning.ts:171`); its
  client constructions, key uses, exports and literal RPCs are pinned by `tests/client-registration.test.mjs` test 37.
  Outside the application, the explicit-run S11 L5 scripts (three at `5283fda`, four at `2a1b94f`) read the local
  disposable stack's own key to create synthetic users (loopback and development class only).
- The binding check ties URL and keys to one project; with the class `development` only a loopback binding with local
  keys is accepted, and a hosted project is never bound (`registration-provisioning.ts:270–330`).
- Static replay at S10: `service_role` may execute 19 non-trigger functions (the module's 18 RPCs and the environment
  identity read). No S11 function is executable by `service_role` (S11 PRIV-2; operations PRIV-1, SURF-0, CORR-0); the
  S11 adapters use the request's own client (S11B-2, S11B-12, S11C-3).
- Remaining direct table writes with the privileged client: the registration inserts and the account-state update in
  the same module (ARCH-F15).

## 5. Provider webhooks and signature verification

| Route                                   | Verification                                                                             | Tests                       | Production class                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------ |
| `app/api/payments/stripe/route.ts`      | HMAC signature with timestamp tolerance 300 s; body bound; live-mode events refused      | S7-L3-5, S7-L3-7; S7 WH-1–2 | Refuses every delivery before reading it (D1; S11B-17) |
| `app/api/media/daily/route.ts`          | HMAC signature (scheme implemented from secondary sources, S9 PR); tolerance; body bound | S9-L3-6, S9-L3-8            | No class rule                                          |
| `app/api/notifications/resend/route.ts` | Svix-style signature; tolerance; body bound                                              | S10-L3-5, S10-L3-7          | No class rule                                          |

Receipts are idempotent by `(provider_code, provider_event_reference)` in `external_event_receipts`. A real signed
delivery to a deployed route has not been verified for any provider (L4 outstanding; L6 HOLD for endpoint
registration).

## 6. Content security policy and headers

`next.config.ts:51–77`: `default-src 'self'`; `script-src 'self' 'unsafe-inline'`; `style-src 'self'`;
`img-src 'self'`; `font-src 'self'`; `connect-src 'self'`; `media-src` from the configured project origin;
`frame-src` only the configured media provider origin (or `'none'`); `object-src 'none'`; `base-uri 'none'`;
`form-action 'self'`; `frame-ancestors 'none'`; plus `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`,
`X-Content-Type-Options: nosniff` and HSTS. Pinned by `tests/application-shell.test.mjs` test 14 and
`tests/security-headers.test.mjs`.

- **Follow-up:** a nonce-based `script-src` instead of `'unsafe-inline'` (S1 residual risk; ARCH-F16).
- **Unverified:** two directives are built from settings when the configuration loads; whether the hosting platform
  fixes them at build time is L6 (ARCH-F17).

## 7. Abuse controls

- Registration quotas (keyed digests; unset keeps registration refused).
- Sign-in and recovery throttles and the suspicious-login threshold (PS-A4).
- The worker route needs a shared server setting.
- Webhook body and timestamp bounds.
- Bounded reads everywhere (discovery 500 candidates; staff pages of 25; list windows) and bounded lock waits (3 s for
  the S11 commands and reads, operations PRIV-1).
- **Not present:** rate limits for Messages and uploads (S10 question 6).

## 8. Audit and its immutability

- `audit_events` is append-only for every role (P1 guard; `apps/web/tests/mvp-001-s11-restore-proof.mjs` checks the guard after a restore, V5).
- Never client-writable: `anon` and `authenticated` hold no privilege and a direct insert, update or delete is refused
  with 42501 (operations PRIV-2).
- **`service_role` keeps INSERT and SELECT** (`supabase/migrations/20260921051204_p1_compliance_foundation.sql:299`).
  No application path needs it (every audit row is written inside a definer function, `20261127090000` header), but
  two earlier proofs pin it (m4 AUD-1, p3-904 PRIV-2): ARCH-D6, owner question.
- The audit workspace reads are themselves audited, once per request, with filter facts and identifiers only
  (operations AUD-4); the list carries no snapshot (AUD-3); scope follows the grant (AUD-1); one event's snapshots come
  back with free-text values redacted by `audit_snapshot_redacted` (`20261127180000:862`; operations CORR-R4), while the
  stored rows keep the free text (owner question).
- Minimization of audit content is checked per slice (`AUD-1` in the S3–S8 proofs; S11 STAFF-4 snapshots evidence
  facts only; Legal Hold reasons and staff notes stay off the audit event or are stored only there, as each header
  states). At `2a1b94f`: break-glass and data-request events carry codes and identifiers only, never the reason or the
  details (`20261127190000:26–28`, `20261127200000:38–39`); each break-glass access writes one `break_glass.accessed`
  event with the grant id (`20261127190000:796–801`; ps-a6 BG-5); no audit event carries a complaint statement (ps-a6
  CV-6).
- The security group of the audit workspace lists sign-in abuse and capability events only; no action code records a
  step-up or a privileged denial (owner question).

## 9. Data minimization in logs

- `src/infrastructure/observability/log.ts`: one JSON line per event with a timestamp, level, fixed event code,
  correlation id and allowlisted fields of narrow shape; secrets, cookies, addresses, intake or matter text, signed
  URLs, raw provider payloads and whole error objects never reach a line. `request-log.ts` logs route-level outcomes.
- `tests/observability.test.mjs` pins the logger and the allowlist of logging callers.
- Adapters never log keys, payloads or provider messages (adapter headers; L3 tests such as S10-L3 "no key or address in
  logs"). The PS-A6 privacy adapter logs the call and its error code and HTTP status only, never a reason or a
  description (`src/infrastructure/privacy/privacy-adapter.ts:17–19`). The S11 L5 scripts accept the application's log
  file and scan it; the journey script's header names leaked passwords and review text
  (`tests/mvp-001-s11-l5-journey.mjs:48–49`). The final L5 runs recorded nothing sensitive in the server log (Builder
  record, 2026-11-22).

## 10. Environment class record and the four-way gate

- `deployment_environment` holds one immutable row per database (class and, for hosted databases, the project
  reference; PS-A2). An unrecorded environment makes no policy selectable; a request whose JWT issuer names another
  project answers `environment_mismatch` (`supabase/migrations/20261117010000_mvp_001_s1_environment_identity.sql:129, 145`;
  S1 ENV-1–4).
- The application refuses policy-driven and financial operations when its class or project reference differs from
  the record (`mvp-001-s1-binding.test.mjs` D9-1–D9-3; S11B-7 reports the match on the system health page).
- The four-way gate (environment production, jurisdiction live, an approved policy selectable, an unrevoked launch
  authorization) and every negative test: [`four-way-gate-tests.md`](four-way-gate-tests.md).
- A restored database carries its source's record; the procedure forbids cross-class restores:
  [`backup-restore-procedure.md`](backup-restore-procedure.md).

## 11. Dependency and secret scanning

- CI (`.github/workflows/p0-controls.yml`) runs `pnpm run secrets:check` with format, typecheck, build, `p0:validate`
  and `p0:test`, and `pnpm run dependency:check` (`pnpm audit --audit-level=high`) in a separate job.
- The secret scan (`tools/p0/lib/controls.mjs:333–347, 541–554`) rejects key-shaped values, connection strings with
  credentials, bearer values, JWT-shaped values and assignments of secret-like names.
- No provider SDK: the adapters use `fetch` and `node:crypto` (Packet §1); no new dependency was added in MVP-001
  without the Packet naming it.
- Repository-hosting secret scanning and push protection are GitHub settings outside the repository.

## 12. Inventory pointers

| What                              | Where                                                                                                                                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security definer functions        | 212 in current definitions at `5283fda` (static count, including three made definer by `alter function`; none without `pg_temp` after `20261127160000`); m4 SEC-1 pins the definer and trigger inventory |
| Function privileges               | `PRIV-*` checks in every slice proof; S11 PRIV-2; operations PRIV-1, SURF-0, CORR-0; the S10 static replay (architecture verification, section 2)                                                        |
| Table privileges and row policies | `PRIV-*` checks; m4 RLS-1–3; p5-001 ISO-1–5; S11 PRIV-1; operations PRIV-2 (audit)                                                                                                                       |
| Privileged module                 | `tests/client-registration.test.mjs` test 37                                                                                                                                                             |
| Gated surfaces                    | S11B-1; `tests/step-up-routes.test.mjs`                                                                                                                                                                  |
| Headers                           | `tests/security-headers.test.mjs`; `tests/application-shell.test.mjs` test 14                                                                                                                            |
| Provider name isolation           | `tests/communications.test.mjs:1236–1291`; S7-20; S9-7; S11-15; S11B-13; S11C-13                                                                                                                         |
| Settings                          | [`production-configuration-checklist.md`](production-configuration-checklist.md)                                                                                                                         |
| Definer functions at `2a1b94f`    | 226 (static count; architecture verification, section 7.4); every PS-A6 command and read is definer, `authenticated` only (ps-a6 PRIV-1)                                                                 |
| PS-A6 break-glass functions       | Seven (`20261127190000:344–649`): request, approve, revoke, own grants, queue, one grant and the one access path `staff_break_glass_consultation`                                                        |
| PS-A6 data-request functions      | Seven (`20261127200000:324–567`): `client_submit_data_request`, `client_withdraw_data_request`, `client_data_requests` and four staff reads and commands                                                 |
| Re-created or replaced (PS-A6)    | `complaint_open`, `complaint_cases_mine`, `staff_complaint_case` with the statement (`20261127210000:282, 344, 369`); `request_slot_starts` (`20261127220000:28`)                                        |
| PS-A6 surfaces                    | The four step-up-gated pages under `app/staff/break-glass/` and `app/staff/data-requests/`; `app/client/privacy/page.tsx`; `src/infrastructure/privacy/privacy-adapter.ts` (PSA6-6)                      |

## 13. Known findings and open risks

| Item                                                                                        | Source                     | State                                   |
| ------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------- |
| `service_role` INSERT on `audit_events`                                                     | ARCH-D6                    | Owner question                          |
| Public origin `http://` accepted by the confirmation route and the recovery redirect        | ARCH-D9 remainder          | Owner question; provider settings fixed |
| `script-src 'unsafe-inline'`                                                                | S1 residual risk; ARCH-F16 | Follow-up                               |
| aal1 direct reads of own participant rows under P1 row policies                             | S8–S10 PR residual risks   | Open                                    |
| Access tokens valid until expiry after a suspicious sign-in; no MFA device recovery         | S2 PR                      | Open                                    |
| Self-revocation of the last capability-administration grant                                 | S1 PR                      | Open                                    |
| Signed links are bearer links for 60 s; rejected upload bytes stay stored                   | S3, S10 PRs                | Open                                    |
| The database owner can delete a current document version when no hold applies               | S10 PR                     | Open                                    |
| No rate limit for Messages and uploads                                                      | S10 question 6             | Owner question                          |
| Webhook signatures never verified with a real delivery; media scheme from secondary sources | S7, S9, S10 PRs            | L4 outstanding                          |
| Audit security group lacks step-up and denial codes                                         | Pass 2A owner question 2   | Owner question                          |
| Rejoin detection uses licence numbers only                                                  | Pass 2A residual; ARCH-F20 | Follow-up                               |
| Break-glass access: one audited read-only path; no general predicate widened                | ps-a6 BG-5, BG-6           | Built at `2a1b94f`; review the path     |
| Break-glass serves no document content (no break-glass-named server path)                   | `20261127190000:44–45`     | Optional enhancement                    |
| A data-request decision records an outcome only; no executor exists                         | `20261127200000` header    | Executors need separate authorization   |
| Database owner only: approval and revocation in one statement; a future `revoked_at`        | Further check, 2026-11-23  | Informational; no API or definer path   |
| Free text (notes, profile text, reasons) stored in audit rows; redacted only on read        | Review correction R4       | Owner question                          |
| Dual-role (client and attorney) accounts outside client administration                      | Review correction R3       | Owner question                          |
| Live payment mode not supported; payments unavailable in production                         | ARCH-D1 consequence        | By design until separately authorized   |

## 14. What a reviewer needs

- The repository at the reviewed commit, the Packet (`docs/work-items/MVP-001/PACKET.md`) and this pack.
- The locked authority documents, from the owner (private; not in the repository).
- A local environment able to run the L1 suite and the L2 proofs (Node.js, as CI declares Node 24 in
  `.github/workflows/p0-controls.yml`; PostgreSQL 16 binaries) and, for L5, a local Supabase stack with the production
  build; no network beyond the local machine is needed for these.
- The L4 result documents kept by the Builder (not in the repository), and read-only access to the provider test
  accounts' webhook and key-scope settings, from the owner.
- For the hosted part (L6, HOLD until the owner authorizes it): the Auth settings (MFA, redirect allowlist, token
  lifetimes, email templates), the effective response headers of the deployed build, the secret store's names (never
  values), webhook endpoint registrations, `pg_cron` state and the API's exposed schemas.
- No production data and no production access is needed or authorized for the review preparation.
