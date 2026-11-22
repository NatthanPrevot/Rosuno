# MVP-001 — Final MVP architecture verification (S1–S11)

Read-only assessment of the committed tree at the S11 head `5283fda` (branch `wi/MVP-001-technical-completion`; owner
`main` `b3205cd` plus the S11 records commit `cc22b8f`, S11 pass 1 `8e5d70a`, pass 2A `a3f68c5`, pass 2B with the
ARCH-D14 correction `e6d45c6`, and the independent-review corrections `5283fda`). This is a verification of the
existing architecture, not a redesign.

## 0. Method and evidence standard

- Every statement cites a repository path with a line at `5283fda`, a test or proof check, or a register entry.
  Migrations are cited as `<14-digit version>:<line>`; application files relative to `apps/web/`. Proof checks are
  cited with their proof ("S9 PROD-1", "operations GATE-4"; "S11" is `mvp-001-s11-db-proof.mjs`, "operations" is
  `mvp-001-s11-operations-db-proof.mjs`).
- Three levels are kept apart:
  - **Implemented**: the capability exists in committed code.
  - **Verified extensibility**: a seam exists and something exercises it (a test, a second implementation, or a
    configuration-driven path that a proof drives with more than one value).
  - **Future possibility (unproven)**: plausible, not exercised.
- Provider wording: a single adapter behind a port is **isolated**, never "interchangeable". Nothing in this
  repository is interchangeable at run time: every provider is wired statically to exactly one adapter.
- Classification: **DEFECT** (wrong or risky now; small), **FOLLOW-UP** (larger; an explicit later item),
  **ACCEPTABLE** (deliberate MVP trade-off, with the reason).
- Counts of database objects are derived from the statements in the migration files (static), not from a live
  catalog. A function counts as security definer when its current definition says so or a later
  `alter function … security definer` makes it so (three functions: `20261122010000:287–292`,
  `20261124010000:359–360`). On `b3205cd` this method gives 392 distinct functions, 162 security definer and 15 definer
  functions without `pg_temp` (the S1–S10 draft said 159 definer because it missed those three). Section 9 lists what
  was executed and what was not.

### Size of what was assessed

| Part                                                                           | Files | Lines  |
| ------------------------------------------------------------------------------ | ----- | ------ |
| `app/` (85 pages, 34 form modules, 30 action modules, 5 route handlers)        | 167   | 27,998 |
| `src/application` (use cases and ports)                                        | 51    | 39,413 |
| `src/infrastructure` (adapters)                                                | 43    | 14,784 |
| `src/presentation` (design system, 16 label modules, workspace navigation)     | 20    | 5,347  |
| `tests/*.test.mjs` (L1/L3)                                                     | 56    | 60,828 |
| `tests/*-db-proof.mjs` (L2; 654 checks)                                        | 17    | 72,582 |
| `tests/*-l4.mjs` (L4 runners)                                                  | 3     | 1,241  |
| `tests/*-l5-*.mjs` (L5 journey scripts)                                        | 3     | 2,494  |
| `supabase/migrations` (67 relations, 476 functions, 176 triggers, 49 policies) | 72    | 47,286 |

The S11 migrations are 18 files and 8,364 lines (`20261127010000`–`20261127180000`, register sequences 55–72). The
654 L2 checks are the 542 of the fifteen S1–S10 proofs plus S11 (57) and operations (55). The restore proof
`apps/web/tests/mvp-001-s11-restore-proof.mjs` (1,310 lines, 7 checks) is committed in the S11 PR and is not in these
counts.

---

## 1. UI/UX customization

### Implemented

- **One design system, strictly encapsulated.** `src/presentation/design-system.tsx` (680 lines, 28 exported
  primitives) renders native elements with fixed `rs-*` classes; `app/globals.css` (1,444 lines) holds every token,
  four density contexts and the primitive styles. Both files are unchanged since S10. Callers cannot pass `className`,
  `style` or raw markup.
- **Pages use primitives only.** `className=` occurs outside the design system in exactly two places, the raw
  `<a className="rs-button">` anchors at `app/client/consultations/[consultation]/forms.tsx:293` and
  `app/attorney/consultations/[consultation]/forms.tsx:448`. No `style={…}` exists in `app/` or `src/`.
- **One page pattern**, continued by every S11 page: a server page calls one application use case with a sources
  object from an adapter and renders the answer; a `"use server"` action module hands the form to the use case; a
  `"use client"` form module shows the fixed message of the returned state (44 client modules). S11 adds
  `src/application/consultation-outcomes.ts`, `reviews.ts`, `complaints.ts`, `legal-holds.ts`,
  `operations-workspace.ts`, `administration-workspace.ts`, `participant-workspaces.ts`, `workspace-support.ts`, two
  shared staff components (`app/staff/review-items.tsx`, `app/staff/review-item-list.tsx`) and one shared navigation
  component per workspace (`src/presentation/workspace-navigation.tsx`).
- **Label modules.** 16 files under `src/presentation/*-labels.ts`; S11 adds `completion-labels.ts`,
  `operations-labels.ts` and `workspace-labels.ts`.

### Verified extensibility

- **Token-level restyling without touching pages** (`tests/design-system.test.mjs` tests 4 and 20). Unchanged.
- **Density variants** used by real pages (`<Page density="client">` at `app/client/page.tsx:74`; `app/staff/frame.tsx`).
- **New state or outcome wording** by adding a key to a typed `Record<Code, …>`; S11's outcome codes, operations
  metrics and workspace categories each needed a label (S11-15, S11B-13, S11C-13).
- **A new protected surface is caught automatically.** S11B-1 enumerates every page and server action under
  `app/client`, `app/attorney` and `app/staff` from the file system and asserts each is behind its gate (MBS §18.6), so
  an unprotected new surface fails the suite; pass 2B's pages are covered by it and by S11C-1.
- **A shared navigation component** (`src/presentation/workspace-navigation.tsx`) is used by 10 page files (S11C-2).

### Future possibilities (unproven)

- A brand redesign, localization and a persistent workspace shell are possible; nothing exercises them.

### Limitations and hard-coded dependencies

1. **The visual identity is pinned** by `tests/design-system.test.mjs` (2,824 lines; token names, spacing values,
   font stacks, palette rules, exported primitives, bans on styling, icon, font and motion packages, image and font
   files and remote references). A rebrand rewrites much of it.
2. **The root layout cannot carry navigation** (test 22 of the same file); `app/layout.tsx` is still the only layout.
3. **No shared workspace shell.** Counted on one basis (files under `app/` that define a function whose name ends in
   `Frame`): 23 at S10, 28 at `a3f68c5`, 38 at `5283fda`. Only `app/staff/frame.tsx`, `src/presentation/public-site.tsx`
   and the S11 navigation component are shared; pages that existed before pass 2B keep page-local links.
4. **Copy lives in several layers**: label modules, inline JSX, application validation messages and the email
   templates in `src/application/notifications.ts:249`.
5. **Display locale and time zone are fixed** (UTC by string slicing; literal locales `en-US` and `en-GB`), as at S10;
   the attorney week view reads one local day on each side of its UTC week (S11C-17).
6. **The CSP constrains UI choices** (`next.config.ts:51–64`), and the file is pinned as an exact snapshot
   (`tests/application-shell.test.mjs` test 14) and by `tests/security-headers.test.mjs`.
7. **The home page is still the interface-foundation demonstration**; the public content pages render a fixed "not
   yet available" statement (content is owner and counsel gated).
8. **Source-contract tests make UI change expensive**: 423 `assert.doesNotMatch` and 556 `assert.match` occurrences in
   the L1 files at `5283fda` (383 and 493 at S10); `tests/client-registration.test.mjs` is 4,457 lines.

### Findings

| Id   | Finding                                                                                       | Class                                                  |
| ---- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| UI-1 | Design-system encapsulation, token-only restyling, typed label maps                           | ACCEPTABLE (tests 4, 8, 20)                            |
| UI-2 | Two raw `className="rs-button"` anchors (lines above)                                         | ACCEPTABLE (minor); use `ButtonLink` when next touched |
| UI-3 | No shared workspace layout; 38 files with a local frame; root layout pinned                   | FOLLOW-UP (ARCH-F8)                                    |
| UI-4 | Copy in several layers; no localization seam                                                  | FOLLOW-UP (ARCH-F8)                                    |
| UI-5 | UTC-only display and literal locales                                                          | FOLLOW-UP (ARCH-F8)                                    |
| UI-6 | Interface-foundation home page; placeholder public content                                    | FOLLOW-UP (ARCH-F7); MBS §26 point 23 gap              |
| UI-7 | Brand, imagery and fonts banned by tests and CSP                                              | ACCEPTABLE now; FOLLOW-UP for a rebrand (ARCH-F6)      |
| UI-8 | Cost of source-contract tests; S11B-1 adds an enumerating gate test that lowers it for gating | FOLLOW-UP (ARCH-F6)                                    |

---

## 2. Database schema evolution

### Implemented

- **Forward-only migrations.** 72 files: 1 P0, 12 P1, 1 P2, 1 P3-904, 1 P5-001 and 56 MVP-001 (S1–S10: 38; S11:
  18). Each slice proof checks the order of its predecessors; S11 MIG-1, operations MIG-1, SURF-0 and CORR-0 check that
  the S11 files follow in order and are registered unreviewed (sequences 55–72).
- **Replace-forward functions.** 560 function definitions for 476 distinct functions (442 for 392 at S10). S11 adds 84
  functions and replaces 34 definitions forward. `policy_parameters_approvable` is defined six times (latest
  `20261127140000:175`), `payment_confirm_authorization` four times (latest `20261127180000:361`), `consultation_end`
  three times (latest `20261127180000:1092`). S11 performs no `drop function`.
- **Setting changes without restating bodies.** `20261127160000` alters the `search_path` of fifteen definer
  functions with `alter function … set` (D8) and changes no body, signature, owner or privilege, as S6 and S8 did for
  three trigger functions (`20261122010000:287–294`, `20261124010000:359–362`).
- **Guards.** 176 `create trigger` statements (166 at S10). S11 adds deferred and guard triggers for the outcome
  vocabulary (`20261127010000`), `reviews`, `complaint_cases`, `legal_holds`, the S11 notification events and rejoin
  detection (`20261127110000:196, 201`); pass 2B and the review corrections add none (SURF-0, CORR-0).
- **Versioned vocabulary constraints.** `notifications_type_v1_check` → `notifications_type_v2_check`
  (`20261127070000`), the second exercise of the vocabulary-version precedent after `resources_kind_v2_check` (S10).
- **Amendments absorbed with minimal surface.** PS-A1 to PS-A5 are `active` in `governance/authority-references.json`.
  S11 adds one relation, `reviews`, with exactly the PS §21.1 columns (`20261127040000`; S11 MIG-2), and no other
  relation or column: operations MIG-2, SURF-0 and CORR-0 assert that the catalog after each later S11 migration
  equals the catalog after pass 1 in every relation, column, type, constraint, index, row policy, policy type and
  table-grant listing. PS-A6 is not adopted and nothing of it exists.
- **Function-only writes.** `reviews` (SELECT for authenticated under one row policy), `complaint_cases` and
  `legal_holds` (no API role privilege) are written only through functions (S11 PRIV-1).
- **Function privileges.** Every S11 command and read is security definer with a pinned search_path and executable
  by `authenticated` only, except `public_attorney_reviews` (`anon` and `authenticated`, `20261127040000:534`); every
  internal, guard and trigger function S11 adds or replaces is executable by no API role, including
  `audit_snapshot_redacted` (`20261127180000:862`) (S11 PRIV-2; operations PRIV-1, SURF-0, CORR-0). No S11 function is
  executable by `service_role`. The whole-set static replay of function privileges done at S10 (235 executable by no
  API role, 113 by `authenticated` only, 39 by `service_role` only, 4 by `anon` and `authenticated`, 1 by
  `authenticated` and `service_role`) was not repeated for S11.
- **Search path.** In current definitions, 212 functions are security definer and 264 security invoker (162 and 230 at
  S10); none of the definer functions lacks `pg_temp` in its `search_path` after `20261127160000` (operations D8).

### Verified extensibility

- **Vocabulary evolution by a new constraint version**: twice (S10 resource kinds; S11 notification types, S11 NOT-1).
- **A new policy parameter without a new policy type**: S9, S10, and S11's approval validation of keys the readers
  already read (operations D5), each proven both ways.
- **Behaviour change by configuration only**: offers CFG-3 and CFG-2; S11's outcome window follows the governing
  scheduling version (S11 STAFF-2, PROD-1).
- **Function signature change with re-granted privileges**: four `drop function` cases up to S10, covered by the
  `PRIV-*` inventories.
- **A setting change without a body restatement**: S6, S8 and S11 (`20261127160000`; operations D8).

### Future possibilities (unproven)

- Renaming or dropping a column, splitting a relation or changing cardinality has no precedent after P1 and would need
  a bounded amendment (Packet rule 16).

### Limitations and risks

1. **Whole-body restatement hides the real change.** D7 replaced five readers forward only to change one cast each
   (`20261127140000:256, 453, 491, 522, 573`); the review corrections replace eleven functions to change named
   branches (`20261127180000` header). The headers say so, but a reviewer still diffs whole bodies.
2. **One central validator grows per slice.** `policy_parameters_approvable` has been replaced by six consecutive
   slices; it still ends in `else true` for types without a reader (`20261127140000:248`).
3. **Cost of one new migration** (observed again in S11): a register entry, the later-migration list in every earlier
   slice proof, the definer and trigger inventories in `tests/m4-db-proof.mjs` SEC-1, capability catalog snapshots in
   the S2, P5-001 and S11 proofs.
4. **Guard triggers enumerate columns**; nothing lists which functions write which relation.
5. **Strict readers on both sides.** Functions return fixed shapes and the application reads them with exact-column
   readers, so a database vocabulary change also needs every TypeScript reader of it. ARCH-D14 was such a case (the
   four S11 notification types existed in the database before the application); since `e6d45c6`, S11C-14 asserts that
   the application's notification types equal the database's list.
6. **Drift control is behind the schema.** `governance/schema-drift/baseline.json` describes Staging at 15
   migrations (P3-904, checked 2026-11-14). The register lists sequences 16–72 (P5-001 and all 56 MVP-001 migrations)
   as `reviewed: false`, `applied_environment: "none"`; `governance/evidence/mvp-001-s1-staging-reconciliation.json`
   records P5-001 as applied on Staging.
7. **Two policy-selection implementations in SQL** (`policy_select_version`, `eligibility_selected_policy`) and a third
   in TypeScript. D5 extracted the eligibility parameter checks into `eligibility_parameters_valid`
   (`20261127140000:79`) for approval; selection still has its own copy.

### Findings

| Id   | Finding                                                                             | Class                                                                        |
| ---- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| DB-1 | Forward-only discipline, function-only writes, versioned checks, minimal amendments | ACCEPTABLE (eleven slices, proven per slice)                                 |
| DB-2 | Approval validation (ARCH-D5)                                                       | Fixed for every key a reader reads; scope-per-type rule not added (ARCH-F28) |
| DB-3 | Integer casts in five readers (ARCH-D7)                                             | Fixed (`20261127140000`; operations D7)                                      |
| DB-4 | Definer functions without `pg_temp` (ARCH-D8)                                       | Fixed (`20261127160000`; operations D8)                                      |
| DB-5 | `service_role` INSERT on `audit_events` (ARCH-D6)                                   | DEFECT left; owner question                                                  |
| DB-6 | Whole-body restatement, central validator growth, per-migration fence cost          | FOLLOW-UP (ARCH-F5)                                                          |
| DB-7 | Drift baseline and register do not describe the current Staging state (ARCH-D11)    | Records; register sequence 16 needs owner facts                              |
| DB-8 | Guard and writer inventories are implicit                                           | FOLLOW-UP (ARCH-F5)                                                          |

---

## 3. Provider interchangeability

Common facts for all three providers:

- **Name isolation is test-enforced**: no file under `src/application`, `src/presentation` or any page names a
  provider (`tests/communications.test.mjs:1236–1291`, `tests/payments.test.mjs` S7-20, `tests/consultations.test.mjs`
  S9-7, S11-15, S11B-13, S11C-13).
- **Static wiring.** Each provider is constructed in fixed composition modules; nothing selects an adapter from
  configuration.
- **Routes carry the provider name**: `app/api/payments/stripe/route.ts`, `app/api/media/daily/route.ts`,
  `app/api/notifications/resend/route.ts`; the fourth route handler is the worker route `app/api/jobs/run/route.ts`.
- **Shared receipt relation** `external_event_receipts`, keyed by `(provider_code, provider_event_reference)`.
- **No SDK.** All three adapters use `fetch` and `node:crypto` (Packet §1).
- **Configuration reader.** `src/infrastructure/environment/provider-configuration.ts:51–110` answers configured,
  unconfigured or refused; nothing defaults; placeholders are refused (`:44–48`). Per-class patterns (`:27, 89`) are
  used by real settings: the payment key and webhook value are refused in a production class
  (`src/infrastructure/payments/stripe-provider.ts:74, 79–82, 92–95`), and the public origin must be `https` in staging
  and production for the payment and email adapters (`stripe-provider.ts:77, 84–91`;
  `src/infrastructure/notifications/resend-provider.ts:86–95`).
- **System health reads shapes only.** `providerStatuses` (`src/infrastructure/staff/operations-adapter.ts:471–496`)
  reports each provider area configured only when its API settings and its webhook signing setting have their
  declared shapes (review correction A6; S11B-7), never a value and without a network call; the AI area is always not
  configured (gate D-4).

### 3.1 Payments (Stripe) — PARTIALLY COUPLED

| Layer       | Where the provider or its concepts appear                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database    | The literal provider code in `client_authorize_payment` (current definition `20261127180000:158`, literal at `:338`; first written at `20261123020000:1806`). Job types `payment.checkout`, `payment.capture`, `payment.release`, `payment.refund`, `payment.reconcile`; hosted-checkout observation kinds in `payment_apply_observation` (`20261123020000:900`). `payment_job_context` answers no provider code (`20261123020000:2543`). |
| Application | `PaymentProvider` (`src/application/payments.ts:246–274`): hosted checkout, payment retrieve/capture/cancel, refunds; checkout-expiry bounds in the application layer (`:284–285`).                                                                                                                                                                                                                                                       |
| Composition | `src/infrastructure/payments/payment-jobs.ts`, `payment-adapter.ts`, `stripe-webhook.ts`.                                                                                                                                                                                                                                                                                                                                                 |
| Settings    | The key setting (test-mode shape; refused in production since S11 D1), the webhook value (refused in production), the public origin (`stripe-provider.ts:79–95`).                                                                                                                                                                                                                                                                         |
| Tests       | `stripe-provider.test.mjs` (L3), `payments.test.mjs`, `mvp-001-s7-stripe-l4.mjs` (L4), S7 proof, S11B-16, S11B-17.                                                                                                                                                                                                                                                                                                                        |

- **Core dependence on provider concepts**: a hosted redirect checkout that later yields a payment reference is built
  into the port, the job types, the observation vocabulary and one client function name; separate authorization and
  capture is a business requirement of `payment_flow` (G-2/G-3).
- **Verified**: the port is exercised by a fake provider (`payments.test.mjs` S7-5 to S7-11) and the real adapter
  against a fake HTTP server (S7-L3-9). No second adapter exists.
- **Production class (S11 D1)**: no payment key or webhook value is accepted, so payments report unavailable and the
  webhook route answers unavailable before reading a delivery (S11B-16, S11B-17). Live mode stays a separately
  authorized change; the event reader still refuses live-mode events (`stripe-provider.ts:762`).
- **Ended Consultations are not payable (review correction R1)**: the payment step and authorization refuse for a
  terminal Consultation, and a confirmation that arrives after a cancellation or an unperformed ending requests no
  capture and records no Engagement (S11 CORR-R1a, CORR-R1b, CORR-R1c).
- **Replacing the provider** needs a new adapter and webhook module, a route, settings, a forward migration replacing
  the provider code literal, fence amendments, L3 tests and an L4 runner; a provider without a hosted checkout also
  needs the port, `payment_job_context`, the observation vocabulary and the checkout job reshaped (ARCH-F2).

### 3.2 Video (Daily) — PARTIALLY COUPLED

| Layer       | Where the provider or its concepts appear                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database    | No provider name; the adapter passes its code; Rosuno derives the provider room name from the Media Room id. Meeting-token lifetime 600 s, observation grace 600 s (`20261125020000:757, 1288`). |
| Application | `MediaProvider` (`src/application/media-provider.ts:376–399`); `RoomView` carries provider-shaped fields.                                                                                        |
| Composition | `src/infrastructure/media/media-jobs.ts`, `src/infrastructure/consultations/consultation-adapter.ts`.                                                                                            |
| Settings    | API key, domain label, webhook value (`src/infrastructure/media/daily-provider.ts:61–75`); no class pattern.                                                                                     |
| UI          | The provider's prebuilt page in an `<iframe>` (`app/client/consultations/[consultation]/forms.tsx:112`, `app/attorney/consultations/[consultation]/forms.tsx:131`).                              |
| Build/CSP   | `frame-src` built from the domain label when the configuration loads (`next.config.ts:38–48, 59`), pinned by `application-shell.test.mjs` test 14 and `security-headers.test.mjs` test 6.        |

- **Core dependence**: the database is provider-neutral; the application and UI depend on an iframe-embeddable room
  reached with a URL token. A provider that needs a browser SDK would need a client component, a dependency the Packet
  does not allow, and CSP changes (ARCH-F3).
- **Verified**: test doubles (`consultations.test.mjs` S9-3) and the real adapter against a fake server
  (S9-L3-10). The database is exercised only with the code `daily` (for example `tests/mvp-001-s9-db-proof.mjs:1575`).
- **S11**: completion never infers a no-show or failure from provider events or their absence (S11 MBS16-2); late
  provider evidence opens an exception and rewrites nothing (S11 MBS16-1); a cancellation closes the room through the
  S9 lifecycle (S11 CAN-2).

### 3.3 Email (Resend) — ISOLATED

| Layer       | Where the provider or its concepts appear                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Database    | No provider name; the provider code is a parameter (`20261126020000:648, 961`).                                               |
| Application | `EmailProvider { providerCode, send(message, idempotencyKey) }` (`src/application/notifications.ts:198–205`).                 |
| Composition | `src/infrastructure/notifications/notification-jobs.ts`, `resend-webhook.ts`.                                                 |
| Settings    | API key, sender address, public origin (https outside development since S11 D9), webhook value (`resend-provider.ts:76–100`). |
| Tests       | `resend-provider.test.mjs` (L3), `communications.test.mjs`, `mvp-001-s10-resend-l4.mjs` (L4), S10 proof.                      |

- **Verified**: the S10 proof drives the notification core with the provider code `synthetic_mail` (13 occurrences in
  `tests/mvp-001-s10-db-proof.mjs`), never `resend`.
- **Not covered by this seam**: identity-provider confirmation and recovery emails.
- **S11 notification types (ARCH-D14, fixed in `e6d45c6`)**: the application's type list now holds the eleven
  database types (`src/application/notifications.ts:62–74`), each with a fixed minimal email template (`:249`; the
  four S11 entries at `:282–297`) and a center label (`src/presentation/communication-labels.ts:326–330`). Fixing it
  exposed a second defect: the notification center rejected the database's `/complaints` link path, so its link
  pattern now admits `/client/complaints` and `/attorney/complaints`, and only for `complaint_received`
  (`src/application/notification-center.ts:71–72, 141–144`). Evidence: S11C-14 (the application list equals the
  database's), S11C-15, S11C-16, operations SURF-8, and the pass 2B and final L5 workspace journeys.

### 3.4 A further notification channel (SMS and similar) — COUPLED to email and in-app

Unchanged since S10: the channel check admits exactly `in_app` and `email`; `notification_lifecycle` hard-codes both
state machines; `notification_emit` creates one in-app and one email Notification per recipient; the job context
reads the recipient's email address; there is no telephone number, channel preference or consent record. S11 added
four types on the same two channels (`20261127070000`). Adding SMS needs a bounded amendment, a `_v2` channel
constraint, replaced functions, a second port, templates, an adapter with its webhook and proofs. Class: FOLLOW-UP
(ARCH-F4).

### 3.5 Other providers

- **AI suggestions — isolated, no implementation.** `src/infrastructure/ai/intake-suggestion-provider.ts` answers
  unavailable without a network call (gate D-4).
- **Storage and identity — coupled by the locked architecture** (database functions use `auth.uid()` and JWT claims;
  the environment status recognises only the hosted issuer form, `20261117010000:176–183`). ACCEPTABLE.

### Findings

| Id    | Finding                                                                                               | Class                                                     |
| ----- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| PRV-1 | Test-mode payment configuration accepted in a production class (ARCH-D1)                              | Fixed (S11B-16, S11B-17)                                  |
| PRV-2 | Public origin admits `http://` (ARCH-D9)                                                              | Partly fixed: provider settings yes; two route readers no |
| PRV-3 | Provider code literal in a database function; hosted-checkout model in the core; live mode needs code | FOLLOW-UP (ARCH-F2)                                       |
| PRV-4 | Video UI and CSP tied to one embeddable page; CSP value read when the build configuration loads       | FOLLOW-UP (ARCH-F3, ARCH-F17)                             |
| PRV-5 | Notification core specific to email plus in-app; identity emails outside it                           | FOLLOW-UP (ARCH-F4)                                       |
| PRV-6 | One adapter per port, static wiring, provider-named routes                                            | ACCEPTABLE (names isolated and fenced)                    |
| PRV-7 | S11 notification types unknown to the application readers (ARCH-D14)                                  | Fixed (`e6d45c6`; S11C-14–16, operations SURF-8)          |

---

## 4. Jurisdiction configuration

### Implemented

- **No jurisdiction rule in code**, as at S10: jurisdictions, policies, launch gates and the four-way gate are rows
  and data-driven functions (`policy_select_version`, `20261117010000:404–469`; `production_financial_gate`,
  `20261117030000:1212–1259`).
- **Currency comes from the jurisdiction's Fee Policy**; minor-unit digits from the runtime's currency data.
- **Launch gates are rows**; a structural trigger refuses a live jurisdiction without an authorization
  (`20260830023823:358`).
- **The waitlist is the lifecycle state, not a new structure (S11).** Three S5 reads were replaced forward with one
  added condition each so that a jurisdiction whose `lifecycle_state` is `waitlist` lists and presents nobody
  (`discovery_presented_set` `20261127110000:376`, `discovery_jurisdiction_listed` `:491`, `public_attorney_profile`
  `:523`); the staff waitlist read lists licence claims there (operations WAIT-1, WAIT-2), and the attorney's own
  compliance page shows the waitlist state per licence (pass 2B, `/attorney/compliance`).
- **Rejoin detection is per jurisdiction**: a licence matches when its jurisdiction and normalized number
  (`license_number_normalized`, `20261127110000:94`) equal a licence of a different, removed profile
  (`attorney_rejoin_detect` `:104`; operations REJ-1–3).
- **Scoped staff authority across S11**: outcome recording, moderation, complaints, referral operations, audit and
  attorney compliance sections honour jurisdiction-scoped grants; client administration, operations, Legal Holds and
  attorney lifecycle commands need a global grant (S11 STAFF-1, REV-2, CMP-3, HOLD-1; operations AUD-1, REF-1, CLI-1,
  OPS-1, LIFE-2).
- **Mode-scoped policy versions through the staff surface (S11 D2)**: `staff_jurisdiction_regulatory_modes`
  (`20261127140000:49`) lists the modes mapped to a jurisdiction; the form offers them
  (`app/staff/policies/forms.tsx:51–52, 117–119`) and the use case passes the chosen mode
  (`src/application/staff-configuration.ts:3431, 3533–3581`) to the existing parameter (operations D2; S11B-15).
- **PS §28 machinery is absent, not dormant.** No migration creates any PS §28 relation; nothing references one.

### Verified extensibility

- Several jurisdictions at once (S5 PUB-1, REF-4); a second currency (offers CUR-1); jurisdiction-scoped staff
  authority (S1 POL-3; S3 V2-JR-3; the S11 scope checks above); launch per jurisdiction (S1 LG-1; the S7–S11 proofs
  run live and non-live jurisdictions in one production-class database); daylight-saving zones (S4 AV-4, CC-7; the
  week view's zones west and east of UTC, S11C-17).

### What adding a second jurisdiction requires

No code; data, plus a reviewed migration for any Regulatory Mode mapping until M14. The data: the jurisdiction row;
attorney licences and verification evidence; jurisdiction-scoped `eligibility`, `scheduling`, `fee` and `referral`
versions; Regulatory-Mode-scoped `payment_flow`, `payment`, `engagement`, `cancellation` and `refund` versions
(creatable through the staff surface since S11 D2); launch gates, evaluations, authorization and the lifecycle change.
The Regulatory Mode and its mapping to the jurisdiction are written only by a reviewed migration until M14
(`20261117030000:1458–1460`).

### Limitations

1. **Regulatory Modes have no administration**: no function writes `regulatory_modes` or
   `jurisdiction_regulatory_modes` (ARCH-F1; M14). Staff can read them through the D2 function only.
2. **`approval_status` and `status` of Regulatory Modes are stored but not interpreted** (`20261123020000:113–115`).
3. **Only the waitlist state is consulted by discovery.** Other non-live states keep the S5 behaviour; referral,
   request, quote and Hold creation are not gated by the lifecycle (S5 owner question 1; ARCH-F13). A Request created
   from a Referral made before the jurisdiction moved to the waitlist is not blocked (pass 2A residual; ARCH-F21).
4. **No content model for jurisdiction-specific disclosures** (ARCH-F7).
5. **A discovery candidate bound of 500 per jurisdiction** (`20261121020000:351, 460`).

### Findings

| Id    | Finding                                                | Class                                           |
| ----- | ------------------------------------------------------ | ----------------------------------------------- |
| JUR-1 | No hard-coded jurisdiction rule                        | ACCEPTABLE (verified)                           |
| JUR-2 | PS §28 objects do not exist                            | ACCEPTABLE (conditionality holds by absence)    |
| JUR-3 | Mode-scoped versions not creatable by staff (ARCH-D2)  | Fixed (operations D2; S11B-15)                  |
| JUR-4 | Regulatory Mode administration is migration-only       | FOLLOW-UP (ARCH-F1; M14)                        |
| JUR-5 | Lifecycle consulted by discovery for `waitlist` only   | FOLLOW-UP (ARCH-F13, ARCH-F21; owner decisions) |
| JUR-6 | No content model for jurisdiction-specific disclosures | FOLLOW-UP (ARCH-F7)                             |

---

## 5. Business-policy flexibility

### 5.1 Policy types and parameter keys actually read

| Type                                                                 | Scope asked by the reader      | Keys read (reader)                                                                                                                                                                   | Validated at approval (`20261127140000:175`)                    |
| -------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `eligibility`                                                        | jurisdiction                   | `schema`, `license.*`, `insurance.*`, `discipline.*`, `practice_area.*` (`eligibility_selected_policy`, `20261117020000:15`)                                                         | **Yes since S11** (`eligibility_parameters_valid`, `:79`)       |
| `bookability`                                                        | platform                       | `presence_window_seconds` (`scheduling_policy`, `20261120020000:57`)                                                                                                                 | **Yes since S11** (1–86,400)                                    |
| `scheduling`                                                         | jurisdiction                   | hold window, pre-slot interval, pending cap, minimum notice (S4); two response windows (S6); join window and overrun (S9, read by `consultation_timing_policy` `20261127140000:573`) | **Yes since S11** for all eight keys when present               |
| `referral`                                                           | jurisdiction                   | `outcome_codes` (`referral_record_outcome`, no caller); `request_message_maximum_characters` (`request_message_limit`, `20261127140000:491`)                                         | Yes (outcome codes since S11: 1–100 distinct lower-snake codes) |
| `fee`                                                                | platform / jurisdiction        | permitted durations and modalities; currency, quote validity, price bounds, rounding, fee components                                                                                 | Yes                                                             |
| `payment_flow`                                                       | jurisdiction + Regulatory Mode | `instant` and `scheduled`, each `authorization` and `capture`                                                                                                                        | Yes                                                             |
| `engagement`                                                         | jurisdiction + Regulatory Mode | `consultation_creation`, `engagement_effective`, optional post-consultation message window                                                                                           | Yes                                                             |
| `notification`                                                       | platform                       | optional critical and acknowledgement types (eleven types admitted since S11)                                                                                                        | Yes, when present                                               |
| `payment`, `cancellation`, `refund`                                  | jurisdiction + Regulatory Mode | none (recorded as provenance; S11 cancellation and outcome reviews cite the recorded versions)                                                                                       | No schema exists (gated)                                        |
| `retention`, `reporting`, `governance`, `automated_referral_quality` | —                              | no reader                                                                                                                                                                            | —                                                               |

The validator still ends in `else true` for types that no reader reads, and nothing checks that a version's scope fits
its type (a `bookability` version with a jurisdiction is approvable and never selected). Parameters must be a JSON
object for every type (`policy_versions_parameters_check`, `20260830023823:142–143`).

### 5.2 The two S10 defects in this mechanism

- **ARCH-D5 — fixed for every key a reader reads** (operations D5, both ways); the scope-per-type rule was not added
  (ARCH-F28).
- **ARCH-D7 — fixed**: the five readers cast through `numeric` (`20261127140000:256` `pricing_quote`, `:453`
  `request_response_window`, `:491` `request_message_limit`, `:522` `attorney_consultation_offer_options`, `:573`
  `consultation_timing_policy`; operations D7).

### 5.3 Fixed technical constants that behave like policy

The S10 list stands (upload ceiling 1,000,000 bytes and five content types; signed URL 60 s; voice-memo bounds;
meeting token and observation grace 600 s; job retry and lease bounds; discovery bounds; referral attempts; scheduling
abuse bounds; request review grid; list windows; checkout expiry bounds; webhook tolerance 300 s and body bounds;
authentication-abuse windows; registration quotas; password minimum; presence heartbeat). S11 adds:

| Value                                                                                                   | Where                                                                         | Notes                                                            |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Review rating 1–5; review text at most 20,000 characters                                                | `20261127040000` header and constraints                                       | Owner question (fixed technical values)                          |
| Public reviews: newest 50 per attorney                                                                  | `public_attorney_reviews`, `20261127040000:468`                               |                                                                  |
| Staff outcome window fail-safe: nominal end plus 86,400 s when the configured window cannot be computed | `20261127020000` header ("The window rule")                                   | The upper bound of `consultation_overrun_seconds`; basis audited |
| A cancellation refused at or after the nominal end (review correction R2)                               | `consultation_cancel`, `20261127180000:541`                                   | Cancellation between the start and the end: owner question       |
| Staff notes at most 500 characters (attorney lifecycle, client account)                                 | `20261127110000`, `20261127120000` headers                                    |                                                                  |
| Legal Hold reason at most 2,000 characters                                                              | `20261127050000` header                                                       |                                                                  |
| Staff and client pages of 25 rows plus one; participant lists of at most 200                            | `20261127090000`, `20261127110000`–`20261127130000`, `20261127170000` headers |                                                                  |
| Finance summary period at most 366 days                                                                 | `20261127130000` header                                                       |                                                                  |
| PM row 46 review evidence: at most 100 open Requests and 100 open Consultations                         | `20261127120000` header                                                       |                                                                  |
| Lock waits bounded at 3 s for the volatile S11 commands and reads                                       | operations PRIV-1, CORR-0                                                     |                                                                  |

Policy-like values held in environment variables (voice-memo limit, abuse thresholds, registration quotas) still change
only with a restart, are not audited in the database and cannot differ per jurisdiction (ARCH-F12).

### 5.4 Vocabularies

Closed by check constraints or guard triggers, mirrored in TypeScript: request, consultation, engagement and payment
states; ledger entry types; exception status and severity; media room states; notification types (eleven in the
database and, since `e6d45c6`, in the application, kept equal by S11C-14); channels (2); resource kinds (3);
jurisdiction lifecycle (7); policy status (8); review states (submitted, published, rejected); complaint workflow
states (opened, in_review, escalated, resolved); Legal Hold status for the S11 scope types (active, released).
**Consultation outcomes**: twelve codes, each allowed only with its terminal state (`20261127010000` header; S11
OUT-1), recorded by commands and never inferred.

Open by pattern: modalities and durations, exception types, outcome code pattern, provider codes, capability codes
(seeded rows: 17), launch gate codes, Referral outcome codes (policy list), complaint category and resolution codes
(lower-snake, behind the `complaint_vocabulary` seam).

**Exception families (S11).** Every exception type belongs to one family and each family to one capability: financial
(`manage_financial_operations`; also every unknown type), compliance (`manage_compliance_reviews`: eligibility and
jurisdiction change reviews, `rejoin_review`, `client_account_review`) and operations
(`manage_consultation_operations`: the S9 media types and `notification_delivery_failed`) (`20261127030000`,
`20261127080000`; S11 FAM-1).

`referral_record_outcome` still has no caller (FOLLOW-UP ARCH-F14).

### 5.5 Gated values correctly left as configuration

The S10 table stands (G-1–G-5, Hold and scheduling values, fee values, the messaging window, join window and overrun,
critical and acknowledgement types, Referral outcome taxonomy, voice-memo limit, D-4, D-3, intake visibility, refund
and cancellation entitlements, DOC-DEL and retention). S11 adds:

| Gate                                                                  | Seam                                                                                                                                                                                                                                                                                                      | Evidence that unset refuses or changes nothing |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| PM rows 11–16, 18, 21, 22 (cancellation, no-show, failure treatments) | Cancellations and the staff no-show and mid-consultation failure outcomes leave the payment as it is and open one review exception; no "late" classification. Exception: `neither_connected` (PM row 17, settled) releases an uncaptured authorization. An early completion follows row 20 with no refund | S11 STAFF-5, STAFF-6, CAN-1, CAN-2, EARLY-1    |
| Review moderation rules                                               | Human publication by `moderate_reviews` holders; nothing automatic                                                                                                                                                                                                                                        | S11 REV-2, MBS16-3                             |
| Complaint vocabularies (PS-A6 policy type)                            | `complaint_vocabulary` answers no selected vocabulary; classify and resolve answer `configuration_unavailable`                                                                                                                                                                                            | S11 CMP-4                                      |
| Release or keep holding an authorization under a closed capture gate  | `capture_gate_closed` exception; nothing released automatically                                                                                                                                                                                                                                           | operations GATE-2, GATE-3                      |
| Payment confirmed after a Consultation ended unperformed              | No capture and no Engagement; one high review item for a human (review correction R1)                                                                                                                                                                                                                     | S11 CORR-R1b, CORR-R1c                         |

No default, seed or constant was found for any G-1…G-5 or CA-* item.

### Findings

| Id    | Finding                                               | Class                                 |
| ----- | ----------------------------------------------------- | ------------------------------------- |
| POL-1 | Gated values are configuration and unset refuses      | ACCEPTABLE (verified per slice)       |
| POL-2 | Approval validation (ARCH-D5)                         | Fixed for read keys; ARCH-F28 remains |
| POL-3 | Integer casts (ARCH-D7)                               | Fixed                                 |
| POL-4 | Staff edit parameters as raw JSON                     | FOLLOW-UP (ARCH-F9)                   |
| POL-5 | Policy-like values in environment settings            | FOLLOW-UP (ARCH-F12)                  |
| POL-6 | Technical bounds awaiting owner confirmation (S4–S11) | ACCEPTABLE pending the owner's answer |
| POL-7 | Referral outcomes never recorded                      | FOLLOW-UP (ARCH-F14)                  |

---

## 6. Cross-cutting coupling and maintainability

### 6.1 Largest files

| Lines | File                                                 | Kind          |
| ----- | ---------------------------------------------------- | ------------- |
| 8,899 | `apps/web/tests/mvp-001-s11-db-proof.mjs`            | L2 proof      |
| 7,033 | `apps/web/tests/mvp-001-s11-operations-db-proof.mjs` | L2 proof      |
| 6,975 | `apps/web/tests/mvp-001-s10-db-proof.mjs`            | L2 proof      |
| 5,321 | `apps/web/tests/p3-904-db-proof.mjs`                 | L2 proof      |
| 4,867 | `apps/web/tests/mvp-001-s9-db-proof.mjs`             | L2 proof      |
| 4,596 | `apps/web/src/application/staff-configuration.ts`    | source        |
| 4,457 | `apps/web/tests/client-registration.test.mjs`        | L1 fence test |

Largest S11 migrations: `20261127020000_mvp_001_s11_completion` (1,396 lines),
`20261127180000_mvp_001_s11_review_corrections` (1,354), `20261127110000_mvp_001_s11_attorney_operations` (914).

### 6.2 The same rule in TypeScript and SQL

As at S10 (eligibility assessment and policy selection; provider observation shapes; the email address rule; the intake
question-set format; vocabularies; numeric bounds; local time to UTC). S11 adds the outcome vocabulary
(`src/application/consultation-outcomes.ts` and `20261127010000`, kept equal by S11-1), the early-completion test of
"before the nominal end" (S11-4, decided by the server) and the notification types (kept equal by S11C-14 since the
ARCH-D14 correction). The database is always the authority; the TypeScript copies are pre-checks and presentation.

### 6.3 The privileged-client module

`src/infrastructure/identity/registration-provisioning.ts` is unchanged since S10: the only application module that
reads the privileged key (line 171), 13 clients, 18 literal RPCs, pinned by `tests/client-registration.test.mjs` test 37. The S11 adapters call their functions through the request's own client
(`src/infrastructure/consultations/completion-adapter.ts:669`; `src/infrastructure/workspaces/workspace-adapter.ts:193,
208`, S11C-3; `operations-adapter.ts`, S11B-2 and S11B-12), and no S11 function is executable by `service_role`. The
S10 observations stand (module growth and naming; direct registration writes; ARCH-F15).

### 6.4 Source-contract ("fence") tests

What they pin is unchanged in kind. S11 amended them only by exact admission, added RPC blocks for the three S11
adapters and the enumerating gate test S11B-1. The step-up gate pins 53 pages (`step-up-routes.test.mjs:207`).

### 6.5 The proof harness

- 17 proof files, each with its own copy of the cluster bootstrap; S11 uses ports 54347 and 54348; the restore proof
  uses 54350.
- Proofs are explicit-run only; CI (`.github/workflows/p0-controls.yml`) runs format, typecheck, build, the P0
  validator, the tool tests, the application tests, the secret scan and, in a separate job, the dependency audit; it
  runs no L2 proof, no L4 runner and no L5 journey.
- Proofs run on PostgreSQL 16 without `pg_cron` and without the Storage schema; the hosted platform runs PostgreSQL 17.
- **L5 scripts.** Three journey scripts are committed, all explicit-run, loopback and development class only:
  `apps/web/tests/mvp-001-s11-l5-journey.mjs` (9 steps), `mvp-001-s11-l5-operations.mjs` (9 steps) and
  `mvp-001-s11-l5-workspaces.mjs` (6 steps). No S1–S10 journey script is committed; their results are PR prose.
- **Evidence summaries.** `governance/evidence/mvp-001-verification-evidence.json` (this pack) summarizes the recorded
  runs per slice and level. L4 result documents remain outside the repository.

### 6.6 Other coupling worth knowing

- **Build-time environment values.** `next.config.ts` reads two settings when the configuration loads to build CSP
  directives (lines 38–59). Whether `next start` uses the build-time header table was not verified (ARCH-F17).
- **The environment record is immutable for every role.** A restored database keeps the source's class and project
  reference; the backup and restore procedure states the rule (no cross-class restore; jobs stay stopped until the
  record is checked) and the restore proof shows the effect (see `backup-restore-procedure.md`).
- **Audit rows double as state** for attorney information requests (`registration-provisioning.ts`), and they keep
  free text (staff notes, profile text, reasons); the audit workspace now redacts it on read
  (`audit_snapshot_redacted`, `20261127180000:862`; operations CORR-R4) while the stored rows are unchanged (owner
  question).
- **Identity-provider calls and environment reads inside `app/`** for the oldest flows (`app/auth/confirm/route.ts:61`,
  `app/forgot-password/actions.ts:30`), unlike later slices, which go through adapters. These two readers are the D9
  remainder.
- **No reconciliation schedule.** Reconciliation runs only when staff request it; the five `pg_cron` schedules are
  expiry and job sweeps (the operations summary lists exactly those five, `20261127100000` header).
- **Workspace read cost.** `consultation_threads` and `attorney_documents` grow with an attorney's Consultation count
  (each capped at 200 rows), and the attorney dashboard makes about seven reads (review-correction residual risks).

### 6.7 Would anything force a major rewrite?

Nothing found would. The largest single-change risks, in order: a second notification channel; a payment provider
without a hosted checkout; a video provider without an embeddable page; a rebrand or workspace-shell redesign; an
upload path above 1 MB.

### Findings

| Id   | Finding                                                                             | Class                                                             |
| ---- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| X-1  | Run evidence above L2 code (ARCH-D4)                                                | Partly fixed (three L5 scripts, the restore proof, evidence JSON) |
| X-2  | Stale control documents (ARCH-D10)                                                  | Fixed in this pack                                                |
| X-3  | Record inconsistencies (ARCH-D11)                                                   | Fixed pending owner confirmation, except register sequence 16     |
| X-4  | Proof harness duplication, per-migration list edits, no CI run, PostgreSQL 16 vs 17 | FOLLOW-UP (ARCH-F5)                                               |
| X-5  | Fence-test volume and duplicated helpers                                            | FOLLOW-UP (ARCH-F6)                                               |
| X-6  | Eligibility engine twice; three policy-selection implementations                    | FOLLOW-UP (ARCH-F10)                                              |
| X-7  | Privileged module growth and naming; direct registration writes                     | FOLLOW-UP (ARCH-F15)                                              |
| X-8  | Build-time environment values and artifact promotion                                | FOLLOW-UP (ARCH-F17), unverified                                  |
| X-9  | Restore versus the immutable environment record                                     | Procedure written and drilled locally (ARCH-F18); hosted part L6  |
| X-10 | Large use-case modules and SQL functions                                            | ACCEPTABLE                                                        |
| X-11 | Booking status never changed (ARCH-D13)                                             | Fixed in S11 pass 1                                               |
| X-12 | A database vocabulary extended without its TypeScript readers (ARCH-D14)            | Fixed (`e6d45c6`); equality test S11C-14                          |

---

## 7. DEFECT status

### 7.1 Status table

| Id       | Defect (S1–S10 assessment, plus S11)                                | Status at `5283fda`                                      | Where                                                                                                                                                                                                    | Evidence                                                                           |
| -------- | ------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| ARCH-D1  | Test-mode payment configuration accepted in a production class      | **Fixed**                                                | `stripe-provider.ts:74, 79–82, 92–95`                                                                                                                                                                    | S11B-16, S11B-17 (L1)                                                              |
| ARCH-D2  | Mode-scoped policy versions not creatable through the staff surface | **Fixed**                                                | `20261127140000:49`; `staff-configuration.ts:3431, 3533–3581`; `app/staff/policies/forms.tsx:51–52, 117–119`                                                                                             | operations D2; S11B-15                                                             |
| ARCH-D3  | Capture requested without re-evaluating the four-way gate           | **Fixed**                                                | `20261127150000:28` (`payment_capture_gate_problem`); `payment_confirm_authorization` latest `20261127180000:361` (gate at `:446`)                                                                       | operations GATE-2, GATE-3                                                          |
| ARCH-D4  | Evidence above L2 not reproducible from the repository              | **Partly fixed**                                         | Three L5 scripts; `apps/web/tests/mvp-001-s11-restore-proof.mjs`; `governance/evidence/mvp-001-verification-evidence.json`                                                                               | L4 documents and S1–S10 L5 scripts not in the repository                           |
| ARCH-D5  | Approval validation incomplete                                      | **Fixed for every key a reader reads**; scope rule left  | `20261127140000:79, 175`                                                                                                                                                                                 | operations D5                                                                      |
| ARCH-D6  | `service_role` can insert audit rows                                | **Left (owner question)**                                | `20260921051204:299`; examined in `20261127090000` header                                                                                                                                                | operations PRIV-2 records the retained grant; pinned by m4 AUD-1 and p3-904 PRIV-2 |
| ARCH-D7  | Integer casts in five policy readers                                | **Fixed**                                                | `20261127140000:256, 453, 491, 522, 573`                                                                                                                                                                 | operations D7                                                                      |
| ARCH-D8  | Fifteen definer functions without `pg_temp`                         | **Fixed**                                                | `20261127160000` (fifteen `alter function` statements)                                                                                                                                                   | operations D8                                                                      |
| ARCH-D9  | Public origin admits `http://` in every class                       | **Partly fixed**                                         | Fixed: `stripe-provider.ts:84–91`, `resend-provider.ts:88–95`. Unchanged: `app/auth/confirm/route.ts:61–72`, `src/application/account-recovery.ts:185–191` (used by `app/forgot-password/actions.ts:30`) | S11B-18                                                                            |
| ARCH-D10 | Governance control documents stale                                  | **Fixed in this pack**                                   | `governance/README.md`, `logging.md`, `provider-security.md`, `release-traceability.md`, `migration-review.md`                                                                                           | —                                                                                  |
| ARCH-D11 | Record inconsistencies                                              | **Fixed pending owner confirmation**, except sequence 16 | Decision Log review line (working tree); work item scope, S11 acceptance and validation commands (`5283fda`); register sequence 16 still open                                                            | —                                                                                  |
| ARCH-D12 | Four-way gate negative tests missing                                | **Fixed**; residual noted                                | `apps/web/tests/mvp-001-s11-operations-db-proof.mjs`                                                                                                                                                     | operations GATE-1–GATE-5                                                           |
| ARCH-D13 | A Booking's status never changes                                    | **Fixed (S11 pass 1)**                                   | `20261127020000:179–196` (completion), `:536–546` (cancellation); `consultation_end` latest `20261127180000:1092` (Booking completed at `:1200`)                                                         | S11 BOOK-1, CAN-1                                                                  |
| ARCH-D14 | S11 notification types unknown to the application readers           | **Fixed (`e6d45c6`)**                                    | `src/application/notifications.ts:62–74, 249, 282–297`; `src/application/notification-center.ts:71–72, 141–144`; `src/presentation/communication-labels.ts:326–330`                                      | S11C-14, S11C-15, S11C-16; operations SURF-8; L5 workspaces step 3                 |
| R1–R6    | Independent review findings on the code (section 7.3)               | **Fixed (`5283fda`)**                                    | `20261127180000`                                                                                                                                                                                         | S11 CORR-R1a, R1b, R1c, R2, R5, R6; operations CORR-0, CORR-R3, CORR-R4            |
| A1–A7    | Independent review findings on the application (section 7.3)        | **Fixed (`5283fda`)**                                    | Application files                                                                                                                                                                                        | S11B-7, S11B-11, S11B-19, S11C-7, S11C-12, S11C-17; S11-3, S11-15                  |

### 7.2 Notes per item

- **ARCH-D1.** In a production class the payment key and webhook settings match no value (`REFUSED_IN_CLASS`), so
  payments report unavailable and the webhook route refuses every delivery until live mode is separately authorized.
  No live-key support was added. Media and email settings have no class pattern (their keys carry no mode).
- **ARCH-D2.** Creating Regulatory Modes and mapping them stay out of scope (M14; ARCH-F1).
- **ARCH-D3.** Under a closed gate the payment stays authorized, no capture or capture job is created, and one
  critical `capture_gate_closed` exception records the problem; release or holding stays a human decision.
- **ARCH-D4.** Committed now: the three L5 scripts and the restore proof; this pack adds the dated evidence summary.
  Still outside the repository: the L4 result documents and any S1–S10 journey script.
- **ARCH-D5.** Remaining: `else true` for types with no reader (nothing to validate) and no scope-per-type rule
  (ARCH-F28).
- **ARCH-D6.** Every application audit row is written inside a definer function (`20261127090000` header), but the
  grant is pinned by two earlier proofs, so revoking it needs a changed expectation in those proofs: pass 2A owner
  question 1.
- **ARCH-D9.** The two route readers were left because fences pin one environment read each (pass 2A owner question
  5; ARCH-F23).
- **ARCH-D11.** The Builder corrected the Decision Log's review line for `DEC-20261117-MVP-001-TECHNICAL-COMPLETION-PROGRAM`
  in the working tree, and the work item's `in_scope`, `out_of_scope`, S11 acceptance criteria and validation commands
  at `5283fda`; both wait for the owner's confirmation in the S11 PR. Register sequence 16 (P5-001, `reviewed: false` /
  `none` while the S1 Staging reconciliation records it applied) stays open until the owner supplies its approval and
  application facts.
- **ARCH-D12.** All four conditions are asserted as the single failing condition (operations GATE-1, including
  `launch_authorization_missing`). Residual: the `policy_not_current` outcome of `client_authorize_payment`
  (`20261127180000:310`) is asserted by no test; document upload and replacement share `communication_window` with
  messages and have no closed-gate probe of their own; the S2–S6 proofs still contain no production-class database
  (ARCH-F29). Details in `four-way-gate-tests.md`.
- **ARCH-D14.** Found by this verification at `a3f68c5` by reading code (the center rejected a row of an unknown type,
  making the whole center unavailable, and the delivery job could not read its context). Fixed in `e6d45c6`: the
  application's type list, templates and labels now hold the four S11 types. Fixing it exposed a second defect, the
  center's link pattern rejecting the database's `/complaints` link path; the pattern now admits it for
  `complaint_received` only. S11C-14 keeps the application list equal to the database's, so the defect cannot recur
  for this vocabulary.

### 7.3 Independent review findings (performed 2026-11-22; fixed in `5283fda`)

The review was performed by three separate review agents (database migrations; application code and tests; readiness
pack and records). Its code findings were corrected in `20261127180000_mvp_001_s11_review_corrections` (63,499 bytes;
register sequence 72; `reviewed: false`, applied nowhere; eleven functions replaced with their signature, security
mode, search_path and grants; one internal function added; no relation, column, policy, policy type or seed) and in
application files; the pack's own findings are applied in this revision.

| Id    | Finding                                                                                                                                                                                                                                  | Correction and evidence                                                                                                                                                                            |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1    | High: a Consultation that had ended could still be paid, captured and given an effective Engagement                                                                                                                                      | A terminal Consultation is not payable; a later authorization requests no capture and a later capture records no Engagement, each reusing or opening one high review item (S11 CORR-R1a, R1b, R1c) |
| R2    | Medium: a cancellation after the booked slot turned a no-show into a cancellation                                                                                                                                                        | `consultation_cancel` answers `time_passed` at or after the nominal end (S11 CORR-R2; CONC-3 amended; S11-3, S11-15)                                                                               |
| R3    | Medium: Users holding an Attorney Profile were inside client administration                                                                                                                                                              | Excluded and answered `not_found`, as staff are (operations CORR-R3; CLI-3 amended)                                                                                                                |
| R4    | Free text was shown in the audit workspace's event detail                                                                                                                                                                                | `audit_snapshot_redacted` on read; stored rows unchanged (operations CORR-R4)                                                                                                                      |
| R5    | The capture refusal at completion checked only the `payment_flow` version                                                                                                                                                                | `consultation_apply_completion` and `consultation_end` also require the gate for every recorded version (S11 CORR-R5); S9 PROD-2 and S11 PROD-1 unchanged                                          |
| R6    | A repeated complaint assignment was audited again                                                                                                                                                                                        | A repeated assignment to the current assignee changes and audits nothing (S11 CORR-R6)                                                                                                             |
| A1–A7 | Application: pager parameter, week view across zones, compliance sections failing independently, complaint message, stale upcoming entries, system health requiring webhook settings, log lines and a two-step cancellation confirmation | S11B-19, S11C-12, S11C-17, S11B-11, S11C-7, S11B-7                                                                                                                                                 |

---

## 8. FOLLOW-UP items

ARCH-F1 to ARCH-F19 are the S1–S10 follow-ups, updated for S11; ARCH-F20 onwards are new.

| Id       | Item                                                 | Rough scope / state at `5283fda`                                                                                                                                                                 |
| -------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ARCH-F1  | Regulatory Mode administration                       | M14. Staff can now read modes (D2); creating and mapping modes is migration-only.                                                                                                                |
| ARCH-F2  | Payment provider seam completion                     | Provider code from configuration; provider code in `payment_job_context`; adapter registry; live-mode enablement as a separately authorized change with its own L4.                              |
| ARCH-F3  | Video provider seam                                  | Frame origin from the adapter into CSP; modality passed to the adapter; decide on SDK-based providers before any dependency request.                                                             |
| ARCH-F4  | Notification channels                                | Bounded amendment for contact number and consent; channel vocabulary v2; channel-neutral functions; second port; templates in presentation.                                                      |
| ARCH-F5  | Proof harness and migration ergonomics               | Shared harness; expected migration list derived from the register; "function → defining migration" and "relation → writers and guards" indexes; L2 in CI (a PROCESS item); PostgreSQL 17 parity. |
| ARCH-F6  | Fence-test consolidation                             | Shared helpers; property checks instead of full-file snapshots; S11B-1 shows the enumerating pattern.                                                                                            |
| ARCH-F7  | Public content                                       | Replace the interface-foundation home page; a content model for approved public and legal text per jurisdiction and Regulatory Mode; owner and counsel approval is the gate.                     |
| ARCH-F8  | Workspace shell and presentation consistency         | One shared navigation per workspace exists for the pass 2B pages; earlier pages keep page-local links; one date/time and money formatter; viewer time zone; copy consolidated.                   |
| ARCH-F9  | Typed policy editing                                 | Per-type forms generated from the validators; scope chosen by type.                                                                                                                              |
| ARCH-F10 | One eligibility engine                               | Keep the SQL derivation as the single owner; fold `eligibility_selected_policy` onto `policy_select_version` and `eligibility_parameters_valid`.                                                 |
| ARCH-F11 | Upload path                                          | Direct-to-Storage signed uploads to lift the 1 MB ceiling.                                                                                                                                       |
| ARCH-F12 | Policy-like settings                                 | Decide which environment-held values become audited configuration.                                                                                                                               |
| ARCH-F13 | Launch gating scope                                  | Owner decision on gating discovery, referral and request creation by lifecycle or launch authorization (S5 question 1); only `waitlist` is consulted today.                                      |
| ARCH-F14 | Referral outcomes                                    | Decide the event-to-code mapping; call `referral_record_outcome` from decline, acceptance, expiry and withdrawal.                                                                                |
| ARCH-F15 | Privileged gateway                                   | Rename and split `registration-provisioning.ts` by port; move the registration writes into a definer function.                                                                                   |
| ARCH-F16 | Script CSP                                           | Nonce-based `script-src` instead of `'unsafe-inline'`; part of the IMP §40 review pack.                                                                                                          |
| ARCH-F17 | Release artifact definition                          | State what "the tested artifact" is when public configuration and CSP origins are fixed at build time; verify header behaviour on the hosting platform (L6).                                     |
| ARCH-F18 | Restore and the environment record                   | Procedure written and drilled locally (`backup-restore-procedure.md`); the hosted part (Storage objects, identity data, `pg_cron`, platform-held values) is L6 and on HOLD.                      |
| ARCH-F19 | Scheduled reconciliation and sweep verification      | A periodic reconciliation job; evidence that every `pg_cron` schedule fires on the hosted platform (the operations summary shows registration, not firing).                                      |
| ARCH-F20 | Rejoin identity signals                              | Detection uses licence numbers only; identity documents, payment identity and contact details are candidates (pass 2A owner question 6).                                                         |
| ARCH-F21 | Waitlist and pre-existing Referrals                  | A Request created from a Referral made before its jurisdiction moved to the waitlist is not blocked; open Requests at that move (pass 2A owner question 7).                                      |
| ARCH-F22 | Verification page outcome `review_required`          | Shown as locked on the verification page (pass 2A owner question 4).                                                                                                                             |
| ARCH-F23 | D9 remainder                                         | The two route readers accept `http://` in every class; one shared reader with the class rule (pass 2A owner question 5).                                                                         |
| ARCH-F24 | PS-A6 features                                       | Break-glass, data requests, complaint vocabulary and statement: built only after the owner approves PS-A6 (decision note, not approved).                                                         |
| ARCH-F25 | Audit security group                                 | No action code records a step-up or a privileged denial (pass 2A owner question 2).                                                                                                              |
| ARCH-F26 | Account administration boundaries                    | Staff accounts and, since R3, Users holding an Attorney Profile are excluded from client administration, fail-closed choices (pass 2A question 3; correction-pass question 8).                   |
| ARCH-F27 | Early completion confirmation                        | The attorney's recorded declaration is the agreement; a two-party confirmation needs a lifecycle state (S11 pass 1 owner question).                                                              |
| ARCH-F28 | Policy scope per type at approval                    | Refuse a version whose scope cannot be selected for its type (D5 remainder).                                                                                                                     |
| ARCH-F29 | Remaining gate assertions                            | Assert `policy_not_current`; a closed-gate probe for document upload and replacement; production-class probes in the S2–S6 areas if the owner gates them (ARCH-F13).                             |
| ARCH-F30 | Vocabulary equality between database and application | Started: S11C-14 for notification types; to extend to the other shared vocabularies.                                                                                                             |
| ARCH-F31 | Free text in audit rows                              | The audit workspace redacts on read (R4); the stored rows keep free text and status strings (correction-pass owner question 10).                                                                 |
| ARCH-F32 | Workspace read cost                                  | `consultation_threads` and `attorney_documents` cost grows with an attorney's Consultation count; the dashboard makes about seven reads (review-correction residual risks).                      |

---

## 9. What was executed and what was not

### Executed in S11 (results recorded by the Builder; sources in the evidence JSON)

- **Final validation at `5283fda`** (Builder run, 2026-11-22): `pnpm run format:check`, `typecheck`, `build`,
  `p0:validate`, `secrets:check` and `dependency:check` exit 0; `pnpm run p0:test` exit 0 with 1,354/1,354 tool tests
  and 717/717 application tests; the DB proofs operations 55, S11 57, S10 55, S9 48, S8 51, S7 36, S6 32, offers 18,
  S5 29, S4 46, S3 35, S2 40, S1 27, p5-001 41, p3-904 37, m4 13, registration-abuse 34 (654), all passing.
- **L5** on a disposable local stack, development class (final runs on the correction-pass tree, 2026-11-22; the later
  R5 revision changes only production-class paths): `mvp-001-s11-l5-journey.mjs` 9/9, `mvp-001-s11-l5-operations.mjs`
  9/9, `mvp-001-s11-l5-workspaces.mjs` 6/6; no CSP or console errors. Earlier pass runs: pass 1 7/7, pass 2A 8/8,
  pass 2B 5/5, 7/7 and 8/8.
- **Restore drill** (`apps/web/tests/mvp-001-s11-restore-proof.mjs`, disposable PostgreSQL 16): final run at
  `5283fda` (2026-11-22T19:04:02Z, 72 migrations, 7/7 PASS); earlier runs at `e6d45c6` (71 migrations) and three
  against 61 migrations (`backup-restore-procedure.md`).
- **Independent review** of the code and of this pack: performed 2026-11-22 by three separate review agents; findings
  fixed in `5283fda` and in this revision (section 7.3). No external review (ChatGPT or the Independent Backup).
- **For this document**: static reads and counts of the committed tree at `5283fda` (and, to calibrate the counting
  method, of `b3205cd` and `a3f68c5`); `pnpm exec prettier`, `pnpm run secrets:check` and `pnpm run p0:validate` on the
  pack. No build, test, proof, server or network call was run for this document itself.

### Not verified

- Hosted behaviour (L6, HOLD): the deployed build, Staging, `pg_cron` firing, Auth settings, Storage, webhook
  registrations, header behaviour under `next start` (ARCH-F17).
- Real signed webhook deliveries for all three providers; a real participant join; Resend delivery-status reads; the
  real hosted payment page in a browser.
- Function privileges of the whole set were replayed statically at S10 only; for S11 the source is the S11 and
  operations `PRIV-*`, `SURF-0` and `CORR-0` checks. Table, column and sequence privileges were never recomputed from
  the text.
- PostgreSQL 17 parity of the proofs.
- The IMP §40 security review (not performed).

---

## 10. Statements of the S1–S10 assessment corrected at `5283fda`

The S1–S10 draft of this verification (prepared at `cc22b8f`, not committed) said the following; each no longer holds,
or did not hold.

| S1–S10 statement                                                                                            | At `5283fda`                                                                                                           |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 54 pages; 13 label modules; 34 client modules; 22 pages with a local frame                                  | 85 pages; 16 label modules; 44 client modules; 38 files with a local frame (23 at S10 on the same basis)               |
| Raw anchors at `forms.tsx:278`; iframes at `:97` and `:111`                                                 | Client `forms.tsx:293` and `:112`; attorney `forms.tsx:448` and `:131`                                                 |
| 442 definitions, 392 functions, 159 definer, 166 triggers, 48 policies, 54 migrations                       | 560, 476, 212, 176, 49, 72. The S10 definer figure was 162, not 159 (three functions made definer by `alter function`) |
| `policy_parameters_approvable` defined five times                                                           | Six (`20261127140000:175`)                                                                                             |
| Approval validation "No" for `eligibility`, `bookability`, six `scheduling` keys, `outcome_codes`           | Validated (operations D5)                                                                                              |
| Five readers cast JSON text straight to `integer`                                                           | Cast through `numeric` (`20261127140000`)                                                                              |
| Fifteen definer functions without `pg_temp`                                                                 | None (`20261127160000`)                                                                                                |
| Payment key pattern at `stripe-provider.ts:66–69`, event check at `:743`; no setting uses class patterns    | `:79–95` with production refusal; event check `:762`; class patterns used by the payment and public-origin settings    |
| Staff cannot read Regulatory Modes; mode-scoped versions need SQL                                           | `staff_jurisdiction_regulatory_modes` (`20261127140000:49`) and the form's mode selector                               |
| Discovery does not consult the jurisdiction lifecycle                                                       | `waitlist` is consulted (`20261127110000:376, 491, 523`)                                                               |
| Completion recorded only as `normal`                                                                        | Twelve outcome codes over four terminal states (`20261127010000`)                                                      |
| No function changes a Booking's status                                                                      | Every terminal transition ends the Booking (`20261127020000:179–196, 536–546`; `20261127180000:1200`)                  |
| Legal Holds have no function or surface                                                                     | `staff_place_legal_hold`, `staff_release_legal_hold` (`20261127050000:210, 254`); `/staff/legal-holds`                 |
| Capture on authorization not gated; `consultation_ready_if_due` and `launch_authorization_missing` untested | Gated (`20261127150000`); GATE-4; GATE-1                                                                               |
| `anon` executes four functions                                                                              | Five: three S5 reads, the S6 offers read (`20261122040000:1758`) and `public_attorney_reviews` (`20261127040000:534`)  |
| Seven notification types                                                                                    | Eleven, in the database (`20261127070000`) and the application (`e6d45c6`)                                             |
| No L5 journey script is committed; `governance/evidence/` holds no MVP-001 verification evidence            | Three L5 scripts committed; this pack adds the evidence summary                                                        |
| 15 proof files, 542 checks                                                                                  | 17 proof files, 654 checks, plus the restore proof                                                                     |
| "Nothing was executed" for the assessment                                                                   | Section 9                                                                                                              |
