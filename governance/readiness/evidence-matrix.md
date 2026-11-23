# MBS §26 evidence matrix (MVP-001, S1–S11)

The 23 points of MBS §26, each mapped to the migrations and modules that implement it, the checks that verify it, the
levels reached and the gaps. Then the MBS §19 and IMP §29 technical conditions mapped to the points.

State: the S11 head `5283fda` (pass 1 `8e5d70a`, pass 2A `a3f68c5`, pass 2B with the ARCH-D14 correction `e6d45c6`,
independent-review corrections `5283fda`), and the PS-A6 revision at `2a1b94f` (implementation `c445960`; review
corrections and the S6 offered-start correction `d9d1151`; verification corrections `2a1b94f`), cited as such. Dated
run summaries, including the Builder's final validation at `5283fda` (2026-11-22), the PS-A6 validation on the
`d9d1151` tree (2026-11-22 and 2026-11-23) and the PS-A6 proof at `2a1b94f` (2026-11-23), are in
[`../evidence/mvp-001-verification-evidence.json`](../evidence/mvp-001-verification-evidence.json).

## How to read it

- **Points are cited by number only.** The words in parentheses after a number are this pack's own label for the
  repository area that carries the evidence, not the specification's wording.
- **Proof names.** "S1" … "S10" are `apps/web/tests/mvp-001-s<N>-db-proof.mjs`; "offers" is
  `mvp-001-s6-offers-db-proof.mjs`; "S11" is `mvp-001-s11-db-proof.mjs` (57 checks); "operations" is
  `mvp-001-s11-operations-db-proof.mjs` (55 checks); "ps-a6" is `mvp-001-s11-ps-a6-db-proof.mjs` (32 checks at
  `2a1b94f`, 31 at `d9d1151`); "m4", "p3-904", "p5-001" and "registration-abuse" are the earlier proofs of those names.
  Identifiers repeat across proofs, so a check is always cited with its proof.
- **S11 L1 tests.** "S11-n" are the tests of `mvp-001-s11-completion.test.mjs` (16); "S11B-n" of
  `mvp-001-s11-operations.test.mjs` (19); "S11C-n" of `mvp-001-s11-workspaces.test.mjs` (18); "PSA6-n" of
  `mvp-001-s11-ps-a6.test.mjs` (9, at `2a1b94f`).
- **S11 L5 journeys.** Three committed explicit-run scripts at `5283fda`, four at `2a1b94f` (loopback and development
  class only), each run on a disposable local stack; final runs recorded by the Builder on 2026-11-22:
  `apps/web/tests/mvp-001-s11-l5-journey.mjs` 9/9 (cancellation and freed slot; start, end and completed Booking; review
  submitted and published; complaint, assignment and Legal Hold; staff outcome of a stale Consultation),
  `mvp-001-s11-l5-operations.mjs` 9/9 (staff home, operations and system health, client administration, audit, referral
  operations and finance summary, attorney lifecycle, refusals by direct URL) and `mvp-001-s11-l5-workspaces.mjs` 6/6
  (client home, payments, messages, settings and privacy; the ARCH-D14 notification; the attorney dashboard and pages;
  refusals by direct URL; the week view across time zones). Earlier pass runs recorded by the Builder: pass 1 7/7, pass
  2A 8/8, pass 2B 5/5, 7/7 and 8/8. For the PS-A6 revision (2026-11-22, a fresh local stack with all 76 migrations,
  development class): `apps/web/tests/mvp-001-s11-l5-ps-a6.mjs` 8/8 ("L5 ps-a6": break-glass request by one staff member
  and approval by another, read-only access audited per access, revocation and refusal after; client data request
  submitted, assigned and decided, deletion-allowed refused under a Legal Hold, withdrawal; a complaint statement seen
  by staff and not by the counterparty; a complaint policy version created, approved and activated through the staff
  policy pages, then classification and resolution with its codes), and the three scripts above again 9/9, 9/9 and 6/6,
  all on the `d9d1151` tree. L5 was not re-run after `2a1b94f` (an internal SQL rewrite with the same coverage and a
  no-script fallback, covered by ps-a6 DR-5, DR-7, CC-6 and PSA6-9).
- **"L2 proof" means** the check exists in code and a run was recorded as passing (in the slice PR description or in
  the Builder's S11 records); dated run summaries are in the evidence JSON. L4 result documents are kept by the Builder
  and are not in the repository (ARCH-D4).
- **Level reached** lists every level with recorded evidence for the point. L6 is on HOLD for every point.

## Summary

| Point | Label (this pack's own)                       | Levels reached               | Main gap                                                                         |
| ----- | --------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| 1     | accounts, sessions, capabilities              | L1, L2, L5                   | Break-glass serves no document content; `service_role` audit insert (ARCH-D6)    |
| 2     | row policies and privilege boundaries         | L1, L2, L5                   | aal1 direct reads on P1 participant policies                                     |
| 3     | verification evidence, eligibility, lifecycle | L1, L2, L5                   | Rejoin detection uses licence numbers only                                       |
| 4     | availability, Holds, bookability              | L1, L2, L5                   | Reschedule not built                                                             |
| 5     | discovery and Referral creation               | L1, L2, L5                   | Referral outcomes never recorded (taxonomy gated)                                |
| 6     | quotes, offers, Requests                      | L1, L2, L5                   | Fee values are development configuration only                                    |
| 7     | payment engine                                | L1, L2, L3, L4 (partial), L5 | Signed webhook at L4; hosted payment page in a browser; live mode not authorized |
| 8     | concurrent attorney decisions                 | L1, L2, L5                   | Concurrency evidence is L2 only                                                  |
| 9     | Bookings                                      | L2, L5                       | Reschedule (supersede) not built                                                 |
| 10    | Consultation states, timing, completion       | L1, L2, L5                   | Financial treatment of PM rows 11–16, 18, 21, 22 gated                           |
| 11    | media rooms and the video adapter             | L1, L2, L3, L4 (partial), L5 | Real participant join and signed webhook at L4                                   |
| 12    | protected resources, documents, Legal Holds   | L1, L2, L5                   | No deletion feature (DOC-DEL); `retention_rules` unused                          |
| 13    | Notifications                                 | L1, L2, L3, L4 (partial), L5 | Signed webhook and status reads at L4                                            |
| 14    | failures and retries                          | L1, L2, L3, L5               | Simulated providers for failure paths                                            |
| 15    | release, refund, reversal entries             | L1, L2, L4 (partial), L5     | Refund and cancellation entitlements gated                                       |
| 16    | review exceptions and reconciliation          | L1, L2, L5                   | Reconciliation runs only when staff request it                                   |
| 17    | audit events and the audit workspace          | L1, L2, L5                   | ARCH-D6; no action code for step-up or privileged denial                         |
| 18    | operational jobs                              | L1, L2, L5                   | No hosted worker trigger; four sweeps not observed firing                        |
| 19    | reviews                                       | L1, L2, L5                   | Moderation rules are an owner and counsel gate                                   |
| 20    | complaints                                    | L1, L2, L5                   | Classification and resolution need a configured complaint policy version         |
| 21    | Regulatory Mode handling                      | L1, L2                       | Regulatory Mode administration is migration-only until M14                       |
| 22    | launch gates and the four-way gate            | L1, L2, L5                   | `policy_not_current` outcome not asserted                                        |
| 23    | public pages and the three workspaces         | L1, L2, L5                   | Public content gated; earlier pages keep page-local navigation                   |

---

## Point 1 (accounts, sessions, capabilities)

- **Implemented in.** P1 authorization foundation; S1 `20261117030000` (capability administration); S2 `20261118030000`
  (session assurance, aal2 in the database) and `20261118040000` (PS-A4 sign-in and recovery abuse counters); S11
  `20261127010000` and `20261127080000` (nine capability catalog rows, no grant), `20261127120000` (client
  administration); at `2a1b94f`, `20261127190000` (break-glass, PS-A6 §2: capability `approve_break_glass`) and
  `20261127200000` (data requests, PS-A6 §3: capability `manage_data_requests`), no grant. Application:
  `src/application/client-registration.ts`, `account-recovery.ts`, step-up modules,
  `src/application/administration-workspace.ts`; identity adapters under `src/infrastructure/identity/`.
- **L2.** S1 CAP-1 (grant, expiry, revocation, no self-grant), CAP-2, CAP-3, POL-3, LG-2. S2 AAL-1–8, ABUSE-1–14,
  JOB-13, JOB-14. p3-904 PRIV-1–5, R1-1–5, R2-1–2, C-1–10, R3-1–5. m4 SEC-1–3. registration-abuse C1–C29, T1–T4.
  Per-slice authorization: S6 AUTH-1, offers OFF-3 and OFF-5, S7 AUTHZ-1, S8 AUTHZ-1–2, S9 ACC-2 and ST-1, S10 MSG-1
  and DOC-4. S11 CAP-1 (five codes), STAFF-1, REV-2, CMP-3, HOLD-1. Operations CAP-1 (four codes), CLI-1 (client
  reads need the global `manage_client_accounts` grant at aal2), CLI-2 (suspend and reactivate, audited, never one's
  own account), CLI-3 (PM row 46), CONC-2 (suspension racing a client's Request creation), NAMES-1, CORR-R3 (Users
  holding an Attorney Profile are outside client administration). ps-a6 BG-1–BG-7 (break-glass request, approval by
  another holder in scope, revocation, derived states, the one audited access path, no other path honours a grant, the
  guard for every role), DR-1, DR-3, PRIV-1, CC-1–CC-3, CC-5.
- **L1.** `security-shell.test.mjs` 1–17; `authentication-session.test.mjs` 1–9; `authentication-entry.test.mjs`;
  `account-recovery.test.mjs`; `client-registration.test.mjs`; `attorney-access.test.mjs`;
  `attorney-application.test.mjs`; `client-principal-source.test.mjs`; `step-up.test.mjs` S2-A1–A13;
  `step-up-routes.test.mjs` S2-R1–R12 (53 step-up-gated pages, line 207); `authentication-abuse.test.mjs`
  1–22; `registration-abuse-control.test.mjs`; `m4-audit-authorization.test.mjs` M4-AZ1–AZ4;
  `staff-configuration.test.mjs` SC-1, SC-3, SC-10, SC-13. S11B-1 (every page and action under `app/client`,
  `app/attorney` and `app/staff` enumerated from the file system and behind its gate), S11B-9, S11C-1. PSA6-1–PSA6-3,
  PSA6-8, PSA6-9; `step-up-routes.test.mjs` pins 57 pages at `2a1b94f` (line 211).
- **L5.** S1 (authentication flows; staff access with and without grants), S2 (throttling, suspicious sign-in, MFA
  enrolment and step-up). S11 operations journey (client suspension and reactivation; refusal by direct URL without
  the capability); S11 workspaces journey (every new client and attorney page refuses the wrong user by direct URL);
  L5 ps-a6 (break-glass request, approval by another staff member, audited access, revocation and refusal after).
- **Gaps.**
  - Break-glass was not built at `5283fda`; it is built at `2a1b94f` (PS-A6 §2). Its one access path serves the
    Consultation record, the newest 500 Messages and the document list (metadata of current versions), not document
    content (`20261127190000:44–45`); serving content would need a break-glass-named server path (an optional
    enhancement).
  - Registration stays default-deny (Packet §4); D-7 (password rule on reset) is gated (Packet §7).
  - No recovery path for a lost MFA device; access tokens issued before a suspicious-sign-in session end verify until
    expiry (S2 PR residual risks).
  - `service_role` may insert audit rows directly (`20260921051204:299`), retained in S11 (ARCH-D6; owner question).
  - A staff member can revoke their own last capability-administration grant (S1 PR).
  - Staff accounts and Users holding an Attorney Profile are excluded from client administration (`20261127120000`
    header; review correction R3); how dual-role accounts are administered is an owner question.

## Point 2 (row policies and privilege boundaries)

- **Implemented in.** Row level security on every relation; function-only writes with revoke-only privilege loops in
  every slice; S11 `20261127040000` (one SELECT row policy on `reviews`), restricted `complaint_cases` and
  `legal_holds` (no API role privilege); at `2a1b94f`, restricted `break_glass_grants` and `data_requests` (no API role
  privilege, no row policy).
- **L2.** m4 RLS-1–3. p5-001 ISO-1–5, PRIV-1–4. S1 ENV-4, CAP-3. S2 PRIV-1–3. S3 PRIV-1–2, META-1, AUTH-1–3, ART-3,
  V2-PRIV-1–2, V2-AI-4, V2-JR-3–5. S4 PRIV-1–3. S5 PRIV-1–4, PUB-6–8, REF-3, REF-8. S6 PRIV-1–4, AUTH-1. Offers OFF-2,
  OFF-5, MSG-3. S7 PRIV-1–2, AUTHZ-1. S8 AUTHZ-1–2, VIS-1. S9 PRIV-1–2, ACC-2, ACC-5, EV-4. S10 PRIV-1–3, MSG-1–3,
  DOC-2–4, DOC-13, NOT-8. S11 PRIV-1 (reviews, complaint cases and legal holds function-only), PRIV-2 (every S11
  command and read security definer, search_path pinned, authenticated only except one public read; internal, guard
  and trigger functions executable by no API role), CMP-2, STAFF-8, REV-3. Operations PRIV-1 (every new staff read and
  command security definer with `pg_catalog, pg_temp`, authenticated only; internal functions by no API role), PRIV-2,
  AUD-1, AUD-2, REF-1, CLI-1, D8, SURF-0 (the six pass 2B reads: definer, authenticated only, no identifier
  argument), SURF-1–SURF-6 (own records only, minimum columns), SURF-7 (guessed identifiers and manipulated client
  state answer nothing). ps-a6 MIG-3 (row level security on both PS-A6 relations; no privilege for `anon`,
  `authenticated` or `service_role`), PRIV-1, BG-6, CV-6 (the statement only to the complainant and in-scope staff).
- **L1.** `client-intake-routes.test.mjs` 3; `client-registration.test.mjs` 37 (privileged client and RPC fences);
  `discovery.test.mjs` S5-5, S5-6; `consultations.test.mjs` S9-5; S11B-1, S11B-2, S11B-12; S11-14, S11-16; S11C-1,
  S11C-3.
- **L5.** S5 (no licence number, email or user id on the public profile), S8 (no client data shown to the attorney),
  S10 (opaque document paths); S11 operations and workspaces journeys (direct-URL refusals).
- **Gaps.** P1 participant row policies let an attorney at aal1 read their own consultation, engagement, media,
  notification and grant rows directly (S8–S10 PR residual risks). `anon` executes five public reads: three S5 reads
  (`public_discovery_filters`, `public_attorney_directory`, `public_attorney_profile`, `20261121020000:789–795`), the S6
  offers read `public_attorney_offers` (`20261122040000:1758`) and `public_attorney_reviews` (`20261127040000:534`). The per-role grant inventory is pinned piecewise by the
  `PRIV-*` checks of each proof, not in one place.

## Point 3 (verification evidence, the eligibility engine and attorney lifecycle)

- **Implemented in.** P1 attorney verification and eligibility; P3-904 `20261106090000`; S1 `20261117020000`
  (eligibility conformance); S3 `20261119030000` (verification artifacts); S11 `20261127110000` (reinstate and
  remove, rejoin detection, the waitlist reads and compliance reads) and `20261127140000` (eligibility approval
  validation, D5). Application: `src/application/eligibility-assessment.ts`, `staff-verification.ts`,
  `attorney-professional.ts`, `administration-workspace.ts`.
- **L2.** m4 CON-1, APP-1–4, SEC-1–3. p3-904 R1-1–5, R3-1–5, INT-1–3, REG-1–4. S1 SCH-1, PS-A2-N8. S3 ART-1–3. S5
  REC-1. S8 REVAL-1, REVAL-5, REV-1–6. S9 ST-5. Operations LIFE-1 (remove and reinstate under the suspend intent's
  rule), LIFE-2 (guards), LIFE-3 (removal keeps every record; S8 routing for both intents), REJ-1–3 (rejoin detection
  on licence save, application submission and approval; approval waits for a human), WAIT-1 (staff waitlist read),
  WAIT-2 (a waitlist-only attorney is never listed, selected, referred or eligible), CMPL-1–3, CONC-1, CONC-3, CONC-4,
  D5 (eligibility parameters validated at approval), SURF-6 (`attorney_compliance_records`, the attorney's own
  records, no evidence content).
- **L1.** `eligibility-assessment.test.mjs` M4-E1–E11; `staff-verification.test.mjs` M4-S1–S9;
  `staff-verification-paging.test.mjs`; `attorney-professional.test.mjs`; `attorney-application.test.mjs`;
  `m4-routes.test.mjs` M4-R1–R6; `m4-infrastructure.test.mjs` M4-I1–I6; `mvp-001-s1-environment.test.mjs` S1-D6.
  S11B-10 (lifecycle commands), S11B-11 (compliance sections per capability, each failing independently), S11B-14
  (neutral waitlist state on the professional page), S11C-10 and S11C-10b (the attorney's own compliance page).
- **L5.** S1 (verification queue paging). S11 operations journey (suspend, reinstate and remove an attorney from the
  compliance workspace); S11 workspaces journey (the attorney's compliance page). No browser journey of a full application-to-approval verification within MVP-001.
- **Gaps.** Rejoin detection compares licence numbers only; other identity signals are follow-ups (owner question 6
  of pass 2A). The verification page shows a `review_required` approval as locked (owner question 4). Eligibility
  that lapses only through time is detected at the next decision point (S8, S9 PRs). The eligibility engine exists in
  TypeScript and in SQL (architecture verification, section 6.2).

## Point 4 (availability, Holds, bookability)

- **Implemented in.** S4 `20261120010000`–`20261120030000`; S11 `20261127020000` (an ended Booking frees its slot);
  since `d9d1151`, `20261127220000` (the S6 offered starts keep only a start that one availability window contains
  whole, as the bookability check requires). Application: `src/application/attorney-schedule.ts`.
- **L2.** S4, all 46 checks: MIG-1–2, PRIV-1–3, POL-0–1, AV-1–5, IN-1–4, BK-1–4, HO-1–7, CC-1–7 (the seven IMP §20
  concurrency tests), INV-1–6 (MBS §9 invariants), INT-1–5, AUD-1. S1 SCH-3. S6 REQ-4, EXP-2, CC-2, CC-4. S8 REVAL-2,
  REVAL-3. S11 BOOK-1 and CAN-1 (a cancelled or completed Booking no longer blocks its slot; another client's Request
  for it is created). Operations D5 (bookability and the scheduling keys validated at approval). S6 QUOTE-3 (added in
  `d9d1151`: no offered start spans two adjacent windows or midnight) and the containment check in S6 QUOTE-2.
- **L1.** `attorney-schedule.test.mjs` S4-A1–A11; S11C-12 and S11C-17 (the read-only week view, including windows
  of zones west and east of UTC).
- **L5.** S4 (schedule page, zones, Instant mode, sign-out); S11 journey script (the slot is free again after a
  cancellation).
- **Gaps.** Reschedule is not built. Presence rides on the Instant intent's lease; the 30-second heartbeat assumes a
  larger presence window (S4 PR). Hold values are development configuration only. No scheduling sweep was observed
  firing under `pg_cron`.

## Point 5 (discovery and Referral creation)

- **Implemented in.** S5 `20261121010000`–`20261121030000`; S11 `20261127110000` (three S5 reads replaced forward so a
  waitlist jurisdiction lists and presents nobody: `discovery_presented_set` `:376`, `discovery_jurisdiction_listed`
  `:491`, `public_attorney_profile` `:523`), `20261127130000` (read-only referral operations).
- **L2.** S5 PUB-1–8, REC-1, REF-1–8, CC-1–2, OUT-1, IMM-1, AUD-1. Operations WAIT-2, REF-1 (referral operations read
  only and minimal).
- **L1.** `discovery.test.mjs` S5-1–S5-14 (S5-11 banned claims); S11B-8.
- **L5.** S5 journey with database verification; S11 operations journey (referral operations page).
- **Gaps.**
  - Allocation (`allocated`) is not implemented; only `client_selected` is created (S5 PR).
  - No workflow records a Referral outcome: `referral_record_outcome` (`20261121030000:332`) still has no caller; the
    taxonomy is gated (S5 question 4, S6 question 5).
  - Ranking and further filters are gated; the order is neutral by name.
  - Only the `waitlist` lifecycle state is consulted by discovery; other non-live states keep the S5 behaviour (S5
    question 1).
  - A Request created from a Referral made before its jurisdiction moved to the waitlist is not blocked (pass 2A
    residual; owner question 7).

## Point 6 (quotes, offers, Requests)

- **Implemented in.** S6 `20261122010000`–`20261122040000` (PS-A3 offers); S11 `20261127140000` (D7: the quote,
  response-window, message-limit and offer-option readers cast through `numeric`).
- **L2.** S6 all 32 checks at `5283fda`, 33 since `d9d1151` (QUOTE-3 added with the offered-start correction). Offers
  all 18 (OFF-1–6, CFG-1–3, CUR-1, APR-1, MSG-1–4, PUB-1, CC-1–2). S8 CC-7. Operations D7.
- **L1.** `consultation-request.test.mjs` S6-1–S6-14; `consultation-offers.test.mjs` OFFERS-1–7;
  `discovery.test.mjs` S5-14.
- **L5.** S6 (eight steps).
- **Gaps.** The instant path follows the Domain Model order (payment before the attorney decision); a different G-2
  answer needs a forward migration. The platform fee is hidden from clients pending a disclosure decision. All fee
  values are development configuration.

## Point 7 (payment engine)

- **Implemented in.** S7 `20261123010000`–`20261123020000`; S8 `20261124020000`; S11 `20261127020000`
  (`staff_request_release`, completion consequences), `20261127150000` (D3: capture re-checks the four-way gate),
  `20261127140000` (D2: staff read the Regulatory Modes of a jurisdiction). Application: `src/application/payments.ts`;
  `src/infrastructure/payments/` (`stripe-provider.ts`, `stripe-webhook.ts`, `payment-adapter.ts`,
  `payment-jobs.ts`).
- **L2.** S7 all 36 checks (tests cite Payment Matrix rows). S8 ACC-1–9, DEC-2, CC-6. S9 ST-2–4, END-2. S11 STAFF-5,
  STAFF-7, REL-1, PROD-1, CORR-R1a–R1c (an ended Consultation is not payable; a later authorization or capture moves
  nothing and opens a review item), CORR-R5 (the completion capture needs the gate for every recorded version).
  Operations GATE-2, GATE-3, FIN-1, D2, SURF-1 (the client's own payment history).
- **L1/L3.** `payments.test.mjs` S7-1–S7-21; `stripe-provider.test.mjs` S7-L3-1–9 (simulated provider); S11B-16 and
  S11B-17 (D1: in a production class the payment settings refuse the test-mode key and webhook value, payments report
  unavailable and the webhook route records nothing); S11B-15 (D2); S11C-4 (payment history).
- **L4.** Stripe test mode, 2026-11-18: 7/7 scenarios, 42/42 assertions (S7 PR). Under Packet §5 the integration is
  "implemented; sandbox verification outstanding".
- **L5.** S7 (payment step with payments unconfigured; simulated events; receipt; finance workspace); S11 operations
  journey (finance summary); S11 workspaces journey (client payment history with a simulated authorization).
- **Gaps.** A real signed webhook delivery is not verified at L4; the hosted payment page was never exercised in a
  browser. Payments are unavailable in a production class until live mode is separately authorized (D1); no live-key
  support exists. G-1–G-5, refund and cancellation entitlements are unresolved; payouts and transfers are excluded.
  Manual-capture authorizations expire at the card networks (S7 PR).

## Point 8 (concurrent attorney decisions)

- **Implemented in.** S8 `20261124020000`; the S11 completion commands take the same lock order (`20261127020000`
  header, "Lock order").
- **L2.** S8 CC-1–9, REVAL-4. S4 CC-3, CC-5. S11 CONC-1 (cancel racing start), CONC-2, CONC-3, CONC-4 (end racing
  end-early), CONC-9 (mixed load, zero deadlocks). Operations CONC-1 (two removals of one profile), CONC-5 (mixed load).
- **L1.** `attorney-requests.test.mjs` S8-APP-3, S8-APP-4.
- **L5.** S8 (single-session accept and decline).
- **Gaps.** Concurrency evidence is L2 only, on PostgreSQL 16.

## Point 9 (Bookings)

- **Implemented in.** S4 `20261120030000`; S8 `20261124020000`; S11 `20261127020000`: every terminal transition of a
  Consultation ends its confirmed Booking in the same transaction (`consultation_complete_booking` `:179`, the
  cancellation `:541`, `consultation_end` replaced forward `:1172`, kept in its later replacement
  `20261127180000:1092`). This closes ARCH-D13.
- **L2.** S4 INV-1, INV-5, INV-6, CC-3, CC-4, CC-6, HO-7, INT-2. S8 ACC-1, DEC-1, INT-3, REVAL-4, CC-4. S11 BOOK-1,
  CAN-1, CAN-3.
- **L1.** None specific (Booking is database-owned).
- **L5.** S8 (Booking confirmed with the Hold's times); S11 journey script (Booking cancelled or completed).
- **Gaps.** Reschedule (supersede) is not built. A scheduled Request cannot defer Consultation creation (S8 PR).

## Point 10 (Consultation states, timing and completion types)

- **Implemented in.** S8 `20261124020000`; S9 `20261125010000`–`20261125030000`; S11 `20261127010000` (outcome
  vocabulary: completed `normal | early_by_agreement | manual_resolution`, cancelled
  `client_cancelled | attorney_cancelled`, no_show `client_no_show | attorney_no_show | both_no_show`,
  technical_failure `neither_connected | mid_consultation_failure`), `20261127020000` (the commands and their payment
  consequences), `20261127180000` (R2: no cancellation at or after the nominal end; R5). Application:
  `src/application/consultations.ts`, `consultation-outcomes.ts`; `src/infrastructure/consultations/completion-adapter.ts`;
  the attorney's history (`/attorney/consultations/history`, `20261127170000`).
- **L2.** S8 INT-1, INT-2, ACC-1–9. S9 CFG-1–3, TIME-1–4, ST-1–6, ENG-1, END-1–4, CC-1–6, EXIT-1. S11 OUT-1, EARLY-1,
  EARLY-2, CAN-1–3, STAFF-1–8, MBS16-1 (late provider evidence opens an exception, nothing rewritten), MBS16-2 (no
  no-show inferred from a missing provider callback), PROD-1, CORR-R2, CORR-R5, EXIT-1, CONC-1–4. Operations OPS-2
  (stale and active Consultation counts), GATE-4, SURF-4 (the attorney's ended Consultations).
- **L1.** `consultations.test.mjs` S9-1–S9-7; S11-1–S11-7; S11C-7, S11C-8.
- **L5.** S9 (waiting room, start, Rosuno's join step, reconnect, end; the provider's room page never loaded in the
  container, so no real participant join was observed); S11 journey script (cancellation, start, end, staff outcome).
- **Gaps.** PM rows 11–16, 18, 21 and 22 are policy-gated (thresholds and refund treatments undecided): a
  cancellation with a live payment attempt and the staff no-show and mid-consultation failure outcomes leave the
  payment as it is and open one review exception (S11 CAN-1, STAFF-6); the exception is `neither_connected` (PM row
  17, settled), which releases an uncaptured authorization (S11 STAFF-5); an early completion follows row 20 and makes
  no refund (S11 EARLY-1). Early completion is the attorney's recorded declaration; a two-party confirmation would
  need a lifecycle state that does not exist (owner question). Whether a cancellation after the scheduled start but
  before the end should be refused is an owner question. No deadline after acceptance when an
  authorization never arrives (S8 PR).

## Point 11 (media rooms and the video adapter)

- **Implemented in.** S9 `20261125010000`–`20261125030000`. Application: `src/application/media-provider.ts`;
  `src/infrastructure/media/` (`daily-provider.ts`, `daily-webhook.ts`, `media-jobs.ts`).
- **L2.** S9 ROOM-1–4, ACC-1–4, MBS14-1–3, EV-1–4, OBS-1, END-3, PRIV-1–2. S11 CAN-2 (the Media Room closes on a
  cancellation), MBS16-1.
- **L1/L3.** `daily-provider.test.mjs` S9-L3-1–10 (simulated provider); `consultations.test.mjs` S9-3, S9-5, S9-6,
  S9-7; provider-name fences `payments.test.mjs` S7-20, `communications.test.mjs` S10-C7, S11-15, S11B-13.
- **L4.** Daily, against the real provider REST API: 7/7 scenarios, 13/13 assertions (S9 PR). "Implemented; sandbox
  verification outstanding".
- **L5.** S9 (with the real provider REST API: room created, Rosuno's join step, room deleted after the end; the
  provider's room page itself never loaded).
- **Gaps.** A real participant join and a signed webhook are not verified at L4; the signature scheme was implemented
  from secondary sources (S9 PR). The UI and the CSP are tied to the provider's embeddable page (architecture
  verification, section 3.2).

## Point 12 (protected resources, documents and Legal Holds)

- **Implemented in.** S3 `20261119010000`–`20261119030000`; S10 `20261126040000`, `20261126050000` (PS-A5); S11
  `20261127050000` (Legal Hold guards, `staff_place_legal_hold` `:210`, `staff_release_legal_hold` `:254`, coverage of
  complaint-case and user scopes in `resource_under_legal_hold` `:128`). Application:
  `src/application/protected-resources.ts`, `legal-holds.ts`; the attorney's document list (`/attorney/documents`,
  `attorney_documents`, `20261127170000`).
- **L2.** S3 CON-1–2, HOLD-1, PRIV-1–2, VM-1–3, AUTH-1–3, META-1, ART-1–3, STO-1, AUD-1. S10 DOC-1–14, CONC-4,
  CONC-8–11. S11 HOLD-1–3, CONC-8, MBS16-5. Operations SURF-5 (document metadata only, no storage path). ps-a6 DR-5 (a
  deletion request cannot be decided allowed while an unreleased Legal Hold covers the requester, for each of the five
  scope types and the counterparty paths), DR-7 (since `2a1b94f`: the rule in one pass with 8,000 Resources and 400
  holds, agreeing with `resource_under_legal_hold`) and CC-6 (a hold racing that decision, both orders).
- **L1.** `protected-resources.test.mjs` S3-M1–M4, S3-V1–V6, S3-A1–A4, S3-L1; `protected-resources-infrastructure.test.mjs`
  S3-I1–I7; `communications.test.mjs` S10-C3, S10-C4, S10-C9, S10-C10; `security-headers.test.mjs` 5; S11-13; S11C-9.
- **L5.** S3, S10 (database-authorized short-lived link; revocation removes access); S11 journey script (Legal Hold
  placed from a complaint case); L5 ps-a6 (a deletion request refused while a Legal Hold covers the client).
- **Gaps.** No deletion feature (DOC-DEL unresolved); `retention_rules` has no reader or writer. Signed links are
  bearer links for 60 seconds; rejected upload bytes stay in private Storage; the owner role can delete a current
  document version when no hold applies (S3, S10 PRs). 1 MB ceiling; no upload rate limit (S10 question 6). A Legal
  Hold on a complaint case linked to no Consultation covers nothing (owner question).

## Point 13 (Notifications)

- **Implemented in.** S10 `20261126010000`, `20261126020000`; S11 `20261127070000` (four types:
  `consultation_cancelled`, `consultation_outcome_recorded`, `review_available`, `complaint_received`; type check v2).
  Application: `src/application/notifications.ts` (the eleven types since `e6d45c6`, `:62–74`; templates `:249`),
  `notification-center.ts` (link rule `:71–72, 141–144`); `src/infrastructure/notifications/`; the message inboxes
  (`consultation_threads`, `20261127170000`).
- **L2.** S10 NOT-1–13, MSG-6, CONC-1, CONC-5, CONC-7. S11 NOT-1, NOT-2 (a refused notification never fails the
  business event). Operations OPS-2 (retrying and permanently failed counts), SURF-3 (inboxes), SURF-8 (ARCH-D14: the
  database's serialized center and job context are read by the application's own readers).
- **L1/L3.** `resend-provider.test.mjs` S10-L3-1–12 (simulated provider); `communications.test.mjs` S10-C5, S10-C6;
  S11C-6; S11C-14 (the application's types equal the database's), S11C-15, S11C-16.
- **L4.** Resend, real sends to the provider's own test recipients only: 8/8 counted scenarios and one observation
  (S10 PR). "Implemented; sandbox verification outstanding".
- **L5.** S10 (worker drain with accepted sends; simulated webhook); S11 workspaces journey (a `review_available`
  notification renders in the client's center).
- **Gaps.** Signed webhook and delivery-status reads not verified at L4. Emails wait for a worker run; no hosted
  trigger (rule 14). Identity-provider emails are outside this lifecycle. No staff notifications; critical and
  acknowledgement types are unconfigured.

## Point 14 (failures and retries)

- **L2.** S2 JOB-5–12. S7 AUTH-2, CAP-2, REF-2, RECON-1, WH-2. S9 MBS14-1. S10 NOT-3, NOT-5, NOT-6, NOT-11, NOT-12.
  p3-904 R3-5 and p5-001 APP-2. registration-abuse C13–C16, T1–T3. S11 NOT-2, MBS16-1, MBS16-2.
- **L1/L3.** `job-worker.test.mjs` W-1–W-10; `stripe-provider.test.mjs` S7-L3-4, S7-L3-9; `daily-provider.test.mjs`
  S9-L3-10; `resend-provider.test.mjs` S10-L3-3, S10-L3-9; `m4-audit-authorization.test.mjs` M4-AU3;
  `authentication-abuse.test.mjs` 3, 7, 12.
- **L5.** S2 (retry, backoff, escalation through the worker route).
- **Gaps.** Provider failure paths are exercised with simulated providers. Attempts permitted during a protection
  outage are not counted (S2 PR). Streamed error pages answer HTTP 200 for not-found (S5, S6 PRs).

## Point 15 (release, refund, reversal entries)

- **L2.** S7 REF-1, REF-2, CC-3, LED-1, REL-1–3, DSP-1. S8 DEC-1, DEC-2, EXP-2. S11 STAFF-5 (release on
  `neither_connected`; critical exception when funds were captured), REL-1 (`staff_request_release`), CAN-1, CAN-2,
  CORR-R1b, CORR-R1c.
  Operations GATE-2, GATE-3 (no capture under a closed gate; nothing released automatically), FIN-1 (the finance
  summary equals the ledger).
- **L1.** `payments.test.mjs` S7-8, S7-9, S7-17, S7-18.
- **L4.** Stripe scenarios A2 (release), R1 (partial refund, replay, remainder, over-refund refused), D1 (S7 PR).
- **L5.** S7 (finance workspace); S11 operations journey (finance summary).
- **Gaps.** Entitlement is not decided: captured funds after a Request ends open a critical exception for a manual
  refund (S7 question 2). Disputes are observed, not settled. Refunds and releases do not re-check the four-way gate
  (they check the environment status only); whether they should is an owner question (see `four-way-gate-tests.md`).

## Point 16 (review exceptions and reconciliation)

- **Implemented in.** S7 `20261123020000` (exceptions and staff reconciliation); S8 `20261124030000` (change
  reviews); S11 `20261127030000` (exception families: financial, compliance, operations, each with one capability),
  `20261127080000` (`rejoin_review` and `client_account_review` join the compliance family), `20261127150000`
  (`capture_gate_closed`).
- **L2.** S7 RECON-1, EXC-1, AUTH-3, WH-2, CAP-2, REL-3. S8 REV-1–6. S9 MBS14-3, OBS-1, END-2. S10 NOT-4, NOT-5. S11
  FAM-1, REL-1, STAFF-6, EXIT-1. Operations REJ-2, CLI-3, GATE-2, GATE-3, CONC-4 (two resolutions of one item),
  OPS-2 (open items by family and severity).
- **L1.** `payments.test.mjs` S7-10, S7-16, S7-19; S11-7.
- **L5.** S7 (exceptions in the finance workspace); S11 operations journey (compliance items).
- **Gaps.** Reconciliation runs only when staff request it; no schedule exists. A change examines at most 1,000 open
  matters (S8 PR).

## Point 17 (audit events and the audit workspace)

- **Implemented in.** P1 `audit_events` (append-only guard); every definer function writes its own audit rows; S11
  `20261127090000` (`staff_audit_events` `:128`, `staff_audit_event` `:221`, scope `audit_view_scope` `:41`; each read
  audited). Application: `src/application/operations-workspace.ts`; pages `app/staff/audit/`.
- **L2.** p3-904 R3-1, R3-2. m4 AUD-1. p5-001 AT-1. S1 ENV-2, POL-2, CAP-1, CAP-2. S2 JOB-6, JOB-13, ABUSE-8–11,
  ABUSE-13. Minimization: S3 AUD-1 and V2-AUD-1, S4–S8 AUD-1. S11 STAFF-4 (evidence snapshot in the outcome's audit
  event). Operations PRIV-2 (anon and authenticated refused 42501; `service_role` grant recorded as retained), AUD-1
  (scope), AUD-2 (one event), AUD-3 (filters and paging), AUD-4 (each read audited once), AUD-5 (security group over
  existing codes), CORR-R4 (free text redacted on read by `audit_snapshot_redacted`, `20261127180000:862`; stored rows
  unchanged). ps-a6 BG-5 (one `break_glass.accessed` event with the grant id per access, `20261127190000:796–801`),
  CV-6 (no audit event carries the complaint statement).
- **L1.** `m4-audit-authorization.test.mjs` M4-AU1–AU6; `observability.test.mjs` 1–8; S11B-4, S11B-5.
- **L5.** S1 (each staff step checked against its audit row); S11 operations journey (audit page with filters); L5
  ps-a6 (each break-glass opening audited once with the grant's id).
- **Gaps.** `service_role` keeps INSERT on `audit_events` (ARCH-D6; pinned by m4 AUD-1 and p3-904 PRIV-2; owner
  question 1). No action code records a step-up or a privileged denial, so the security group lists none (owner
  question 2). Free text (notes, profile text, reasons) stays stored in audit rows; the workspace only redacts it on
  read (owner question). `job_cancel_for_subject` writes no audit row of its own (S2 PR).

## Point 18 (operational jobs)

- **Implemented in.** S2 `20261118010000`, `20261118020000`; S11 `20261127100000` (operations summary: jobs by state,
  oldest due pending job, scheduler registration of the five sweeps).
- **L2.** S2 JOB-1–14, PRIV-1–3, MIG-1. S10 NOT-6. S7 RECON-1. S9 ROOM-3. Operations OPS-1, OPS-2.
- **L1.** `job-worker.test.mjs` W-1–W-10; `job-worker-infrastructure.test.mjs` J-I1–J-I12;
  `staff-configuration.test.mjs` SC-18–SC-20; S11B-6, S11B-7.
- **L5.** S2 (`pg_cron` job sweep on a local stack; worker route); S11 operations journey (operations and system
  health pages).
- **Gaps.** No hosted trigger for the worker route (rule 14). Of the five `pg_cron` schedules only the job sweep was
  observed firing; proof clusters have no `pg_cron`, so the operations summary answers 0 for the scheduler there.

## Point 19 (reviews)

- **Implemented in.** S11 `20261127040000`: the `reviews` relation with exactly the PS §21.1 columns; `review_submit`
  `:236` (the server establishes every fact; the attorney is never an input); moderation by `moderate_reviews` holders;
  `public_attorney_reviews` `:468` (count and average computed at read time, never stored). Application:
  `src/application/reviews.ts`; pages `app/client/reviews/`, `app/attorney/reviews/`, `app/staff/reviews/`.
- **L2.** S11 REV-1 (guard for every role), REV-2 (moderation scope), REV-3 (public read), MBS16-3 (invalid attempts
  fail server-side), MBS16-4 (duplicates prevented), CONC-5, CONC-6, EXIT-1.
- **L1.** S11-8, S11-9, S11-10.
- **L5.** S11 journey script (review submitted, published, shown with count and average on the public profile).
- **Gaps.** Moderation rules are an owner and counsel gate (Packet §3): nothing publishes automatically. The 1 to 5
  rating scale and the review text limit are fixed technical values (`20261127040000` header; owner question).

## Point 20 (complaints)

- **Implemented in.** S11 `20261127060000`: `complaint_open` `:327` (the complainant is the caller; PM row 47: nothing
  else changes), restricted reads, staff assignment and escalation; classification and resolution behind the
  `complaint_vocabulary` seam. At `2a1b94f`, `20261127210000` (PS-A6 §§4–5): the `complaint` policy type
  (`complaint_vocabulary` `:164` selects through `policy_select_version`; approval validation
  `complaint_parameters_valid` `:54`) and `complaint_cases.statement` (`:202–205`; `complaint_open` re-created with
  the optional statement, `:282`). Application: `src/application/complaints.ts`; pages `app/client/complaints/`,
  `app/attorney/complaints/`, `app/staff/complaints/`.
- **L2.** S11 CMP-1–5, MBS16-5 (evidence preserved, access controls respected), CORR-R6 (a repeated assignment
  changes and audits nothing), CONC-7, EXIT-1. Operations CMPL-1 (complaint counts for `manage_complaints` holders).
  ps-a6 CV-1 (approval validation both ways), CV-2 (the staff policy surfaces), CV-3 (selection by jurisdiction or
  platform scope; a development version never selected in a production-class database), CV-4 (classification and
  resolution with the configured codes), CV-5 and CV-6 (the statement: bounds, immutability, restriction).
- **L1.** S11-11, S11-12; PSA6-7.
- **L5.** S11 journey script (problem reported, case assigned, Legal Hold placed; at `2a1b94f` its step 3b classifies
  and resolves through a real complaint policy version, with no synthetic function fixture); L5 ps-a6 (a statement seen
  by staff and not by the counterparty; a complaint version created, approved and activated through the staff policy
  pages, then classification and resolution with its codes).
- **Gaps.** Classification and resolution work once a `complaint` policy version is configured for the case's scope;
  nothing is seeded, so until an environment is configured they answer `configuration_unavailable`. At `5283fda` the
  policy type and the statement did not exist; both are implemented at `2a1b94f`.

## Point 21 (Regulatory Mode handling)

- **Evidence.**
  - None of the PS §28 relations is created by any migration, and none is referenced (69 `create table` statements for
    67 relations at `5283fda`, 71 for 69 at `2a1b94f`; S7 MIG-2 asserts that `payouts` does not exist).
  - Payments record the jurisdiction's single active Regulatory Mode; none or two refuses (S7 FP1-1, FP1-2).
  - Eligibility selection treats a mode-specific version as undetermined (`eligibility-assessment.test.mjs` M4-E2,
    M4-E3; `20261117020000:65–80`).
  - Jurisdiction lifecycle changes route open matters to review without changing them (S8 REV-3).
  - Staff can read the Regulatory Modes mapped to a jurisdiction and create mode-scoped policy versions through the
    staff surface (`staff_jurisdiction_regulatory_modes`, `20261127140000:49`; operations D2; S11B-15). This closes
    ARCH-D2.
- **Gaps.** M14 activation is outside the Program. Regulatory Modes and their jurisdiction mappings are written only
  by reviewed migrations until M14 (`20261117030000:1458–1460`). Their `status` and `approval_status` are not
  interpreted (`20261123020000:113–115`). Payment Matrix row 45 cannot be detected (S8 PR).
  `tools/p0/tests/p1-011-contract.test.mjs:39` holds a list of deferred relations for one P1 migration only (S11
  creates one of them, `reviews`, under its own Packet slice); no test asserts the absence of the PS §28 relations for
  the whole migration set.

## Point 22 (launch gates and the four-way gate)

- **L2.** S1 LG-1, LG-2, ENV-1–4, PS-A2-P1–P2, PS-A2-N1–N10. S7 PROD-1. S8 PROD-1, PROD-2. S9 PROD-1, PROD-2. S10
  MSG-7, NOT-10. S11 PROD-1. Operations GATE-1 (all sixteen combinations; only all-true permits; each other answers
  its first failing condition, `launch_authorization_missing` included), GATE-2, GATE-3 (capture), GATE-4
  (`consultation_ready_if_due`), GATE-5 (every function in the migrations that calls a gate helper has an entry in
  the inventory). S11 CORR-R5 (completion with a capture needs the gate for every recorded version). Unrecorded
  environment: m4 ENV-1, p3-904 ENV-1, S4 POL-0, S5 ENV-1, S6 ENV-1.
- **L1.** `mvp-001-s1-environment.test.mjs` S1-ENV-1–3; `eligibility-assessment.test.mjs` M4-E11;
  `staff-configuration.test.mjs` SC-5, SC-6; `provider-configuration.test.mjs` M1-1–M1-4; `mvp-001-s1-binding.test.mjs`
  D9-1–D9-3; S11B-7 (system health reports whether this deployment's settings match the recorded environment).
- **L5.** S1 (authorization refused before gates; gate, evaluation, authorization, `live`).
- **Gaps.** The `policy_not_current` outcome of `client_authorize_payment` (`20261127180000:310`) is asserted by no
  test. Details and the list of operations that are not gated in [`four-way-gate-tests.md`](four-way-gate-tests.md).

## Point 23 (public pages and the three workspaces)

- **Evidence at `5283fda`.** 85 pages (`app/**/page.tsx`), 30 action modules, 34 form modules, 5 route handlers. At
  `2a1b94f`: 89 pages, 33 action modules, 37 form modules, 5 route handlers (the four staff break-glass and data-request
  pages; the client privacy page gained its form).
  - Public: `/`, `/find-an-attorney`, `/attorneys/[attorney]` (with published reviews since S11), `/find-an-attorney/select`,
    `/how-it-works`, `/for-attorneys`, `/about`, `/help`, `/contact`, `/privacy`, `/terms`, `/disclosures`, sign-in,
    sign-up, password recovery.
  - Client: `/client`, `/client/intakes/[intake]`, `/client/requests/new`, `/client/requests/[request]`,
    `/client/payments` and `[payment]`, `/client/consultations` and `[consultation]`, `/client/messages`,
    `/client/reviews`, `/client/complaints`, `/client/notifications`, `/client/settings`, `/client/privacy`.
  - Attorney: `/attorney`, `/attorney/dashboard`, `/attorney/apply`, `/attorney/professional` (waitlist state),
    `/attorney/compliance`, `/attorney/schedule` and `/attorney/schedule/week`, `/attorney/offers`,
    `/attorney/earnings`, `/attorney/requests` and detail, `/attorney/consultations`, detail and `history`,
    `/attorney/messages`, `/attorney/documents`, `/attorney/reviews`, `/attorney/complaints`, `/attorney/notifications`.
  - Staff: `/staff` (links grouped by area), verification, policies (with Regulatory Mode selection), jurisdictions,
    launch, catalog, capabilities, intake configuration, jurisdiction review, jobs, finance (payments, detail,
    exceptions, summary), operations, system health, audit and one event, compliance, attorneys (lifecycle),
    clients and one client, referrals, consultations and one Consultation, reviews, complaints and one case, Legal
    Holds; at `2a1b94f`, break-glass and one grant (`/staff/break-glass`, `/staff/break-glass/[grant]`) and data
    requests and one request (`/staff/data-requests`, `/staff/data-requests/[request]`).
  - Account: `/account/security`, `/account/step-up`.
- **L1.** `public-site.test.mjs` S5-P1–P2; `public-entry-points.test.mjs` PE-1–4; `discovery.test.mjs` S5-2, S5-3,
  S5-12, S5-13; route tests per workspace; `security-headers.test.mjs` 1–6; `design-system.test.mjs` 1–23;
  `application-shell.test.mjs`; S11B-1 (MBS §18.6: every client, attorney and staff page and action is behind its gate,
  so a new unprotected surface fails), S11B-3 (staff home grouped by area), S11-16, S11C-1 (the pass 2B pages), S11C-2
  (one navigation per workspace), S11C-4–S11C-13. PSA6-8 (the PS-A6 pages ask the step-up gate first or re-verify the
  client, and read only through their own use case).
- **L2.** Unknown or guessed identifiers answer nothing: on the S11 staff reads (operations AUD-2, CLI-1, LIFE-2; S11
  STAFF-1, CMP-1); the six pass 2B reads take no identifier at all (operations SURF-0, SURF-7).
- **L5.** Section 0.4 of the S1–S10 inventory as recorded in the evidence JSON; the three S11 journey scripts; L5
  ps-a6.
- **Client workspace (MBS §18.2), at `5283fda`.**

  | Surface                 | State                                                                                                                                                                                                                                                          | Evidence                   |
  | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
  | Home                    | Implemented in pass 2B: Consultations in progress or ready and the next upcoming one, Find an attorney, links to every client area (`/client`)                                                                                                                 | S11C-7; workspaces journey |
  | Consultations           | Existed (S9, S11 pass 1): list and detail with cancellation and review                                                                                                                                                                                         | S9, S11 tests              |
  | Payments                | Implemented in pass 2B: history, newest first, 25 per page, state, amount, recorded refund, links to the existing receipts (`/client/payments`, `client_payments`)                                                                                             | SURF-1; S11C-4             |
  | Messages                | Implemented in pass 2B: an inbox of the client's threads with messaging status, count and last message time, no body (`/client/messages`, `consultation_threads`)                                                                                              | SURF-3; S11C-6             |
  | Reviews and complaints  | Existed (S11 pass 1)                                                                                                                                                                                                                                           | S11 REV, CMP checks        |
  | Notifications           | Existed (S10); S11 types readable since the ARCH-D14 correction                                                                                                                                                                                                | S11C-16; SURF-8            |
  | Profile / settings      | Implemented read-only in pass 2B: display name, account state, created date, notification center link (`/client/settings`). No display-name edit: no function exists. `/account/security` refuses client accounts, so it is not linked                         | SURF-2; S11C-5             |
  | Privacy / data controls | At `2a1b94f` (PS-A6 §3): a request form for the five types, the client's own requests with withdrawal, neutral fixed labels and "Recorded decision" (`/client/privacy`; PSA6-4; L5 ps-a6). At `5283fda`: counts of seven record categories and no request form | SURF-2; S11C-5; ps-a6 DR-1 |
  | Help / complaints       | Linked                                                                                                                                                                                                                                                         | S11C-2                     |

- **Attorney workspace (MBS §18.3), at `5283fda`.**

  | Surface            | State                                                                                                                                                                                                                                                                 | Evidence                    |
  | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
  | Dashboard          | Implemented in pass 2B at `/attorney/dashboard` (consultations, requests, availability, earnings and alerts, each section failing independently); `/attorney` stays the fence-pinned access-standing page with one Dashboard link                                     | S11C-11; workspaces journey |
  | Consultations      | Requests and upcoming or active existed; history implemented in pass 2B (`/attorney/consultations/history`, `attorney_consultation_history`)                                                                                                                          | SURF-4; S11C-8              |
  | Schedule           | Management existed (S4); a read-only week view implemented in pass 2B (`/attorney/schedule/week`)                                                                                                                                                                     | S11C-12, S11C-17            |
  | Messages           | Implemented in pass 2B (`/attorney/messages`, `consultation_threads`)                                                                                                                                                                                                 | SURF-3; S11C-6              |
  | Documents          | Implemented in pass 2B, metadata only (`/attorney/documents`, `attorney_documents`)                                                                                                                                                                                   | SURF-5; S11C-9              |
  | Compliance         | Implemented in pass 2B (`/attorney/compliance`): profile stage, licences with waitlist and verification state, insurance, discipline findings, authorisations, latest recorded eligibility, record and evidence dates; no evidence content, licence number or carrier | SURF-6; S11C-10, S11C-10b   |
  | Earnings, offers   | Existed (S6, S7)                                                                                                                                                                                                                                                      | S6, S7 tests                |
  | Profile / settings | Existing professional profile page and account security, linked                                                                                                                                                                                                       | S11C-2                      |

  One shared navigation component per workspace (`src/presentation/workspace-navigation.tsx`) is shown on the new
  pages; pages that existed before pass 2B keep page-local links.

- **Staff workspace (MBS §18.4).** Present: applications and verification, compliance (licences, insurance, discipline,
  waitlist, review items), jurisdictions, referral operations (read-only), complaints, payments, refunds (S7 staff
  refund), reconciliation exceptions, revenue and financial summary, clients, staff capabilities, security and audit,
  system health, policy management. Not presented: panels, surveys and other Regulatory-Mode-conditional sections
  (`20261127110000` header). Not built at `5283fda`: privacy and data requests (PS-A6). At `2a1b94f`: data requests
  (`/staff/data-requests`, `manage_data_requests`, global grant) and break-glass access (`/staff/break-glass`, linked
  from the staff home for every active staff member).
- **Gaps.** The home page is still the interface-foundation demonstration and the eight public content pages render a
  fixed "not yet available" statement (content is owner and counsel gated). Pages that existed before pass 2B keep
  page-local navigation. Owner questions from pass 2B: compliance alert lead time (none applied), client display-name
  editing, the client sign-in security offering, `/attorney` as the dashboard, the `review_available` link target, and
  attorneys seeing Consultations in `created`.

---

## MBS §19 and IMP §29 technical conditions

### IMP §29 technical conditions

The thirteen technical conditions are cited by their position in IMP §29; the label in parentheses is this pack's own.

| Position (label)            | Evidence at `5283fda`                                                                                                                                                                                                                                                                   | Gaps                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1 (client journey)          | L2: S9 EXIT-1, S10 EXIT-1, S11 EXIT-1 (function level, providers simulated). L5 per slice (S3, S5, S6, S7 unconfigured, S9, S10); S11 journey script and workspaces journey (client home, payments, messages, settings, privacy)                                                        | No single browser journey from Intake to a completed, paid Consultation; no real hosted payment page in a browser       |
| 2 (attorney journey)        | L5: S4, S6, S8, S9; S11 journey script (start, end); S11 workspaces journey (dashboard, history, week view, messages, documents, compliance); L2 EXIT-1 as above                                                                                                                        | Application-to-approval journey not re-run in MVP-001                                                                   |
| 3 (staff operations)        | L5: S1 (37 staff steps), S2, S7; S11 journey script (staff outcome) and operations journey (9/9). L2: S11 EXIT-1 (operations without direct database edits), operations LIFE, CLI, REJ, AUD, OPS; L1: S11B-1–S11B-19; L5 ps-a6 (8/8)                                                    | Regulatory Mode creation is migration-only (M14); a data-request decision executes nothing (no executor)                |
| 4 (security)                | Points 1 and 2; `security-headers.test.mjs`; webhook authenticity S7-L3-5/7, S9-L3-6/8, S10-L3-5/7; D1 S11B-16/17; D8 operations D8; review corrections R1–R6; PS-A6 at `2a1b94f`: ps-a6 MIG-3, PRIV-1, BG-6                                                                            | `script-src 'unsafe-inline'`; ARCH-D6; D9 remainder; the IMP §40 security review not performed                          |
| 5 (row-level security)      | Point 2 (`PRIV-*`, `ISO-*`, `RLS-*` checks in every proof; S11 PRIV-1; operations SURF-0–SURF-7)                                                                                                                                                                                        | aal1 direct reads on P1 participant policies                                                                            |
| 6 (concurrency)             | S4 CC-1–7; S5 CC-1–2; S6 CC-1–4, EXP-5; offers CC-1–2; S7 CC-1–4; S8 CC-1–9; S9 CC-1–6; S10 CONC-1–11; S11 CONC-1–9; operations CONC-1–5; p3-904 C-1–10; p5-001 CON-1–4; S2 JOB-3, ABUSE-5; ps-a6 CC-1–7 (at `2a1b94f`)                                                                 | L2 only; PostgreSQL 16 (the hosted platform runs 17)                                                                    |
| 7 (payments)                | Point 7                                                                                                                                                                                                                                                                                 | Point 7 gaps                                                                                                            |
| 8 (reconciliation)          | Point 16                                                                                                                                                                                                                                                                                | No scheduled reconciliation                                                                                             |
| 9 (failing providers)       | S7 AUTH-2, CAP-2, REF-2, RECON-1; S9 MBS14-1, MBS14-3; S10 NOT-3–5, NOT-11; S11 MBS16-1, MBS16-2, NOT-2; adapter error mapping S7-L3-4, S10-L3-3                                                                                                                                        | Simulated providers; real webhook paths unverified                                                                      |
| 10 (jobs)                   | Point 18                                                                                                                                                                                                                                                                                | No hosted trigger; four sweeps not observed firing                                                                      |
| 11 (Storage)                | Point 12                                                                                                                                                                                                                                                                                | Proofs use a stand-in for the Storage schema; real Storage only in L5 (S3, S10)                                         |
| 12 (logging and monitoring) | `observability.test.mjs` 1–8; `src/infrastructure/observability/log.ts`, `request-log.ts`; correlation id in `proxy.ts`; staff job view; S11 operations dashboard and system health (counts only; operations OPS-1, OPS-2; S11B-6, S11B-7)                                              | Hosted checks are outside the database view (L6 HOLD); alert delivery from `security.protection_unavailable` unverified |
| 13 (backup and restore)     | [`backup-restore-procedure.md`](backup-restore-procedure.md): `apps/web/tests/mvp-001-s11-restore-proof.mjs`, run 7 at `2a1b94f` (2026-11-23, 76 migrations, 7/7 PASS), run 6 at `d9d1151` and the earlier runs; P0-level `governance/evidence/p0-restore-validation.json` (2026-08-28) | Hosted backup and restore (Storage objects, identity data, `pg_cron`) is L6 and on HOLD                                 |

### MBS §19 technical-complete requirements mapped to the points

The twenty technical-complete requirements are cited by their position in MBS §19.

| MBS §19 position | Where the evidence is                 |
| ---------------- | ------------------------------------- |
| 1, 2             | IMP §29 rows 1 and 2 above; point 23  |
| 3, 4             | points 1 and 2                        |
| 5                | point 5                               |
| 6                | points 3 and 4                        |
| 7, 8             | points 6 and 7                        |
| 9, 10, 11        | points 9, 10 and 11                   |
| 12, 13           | points 12 and 13                      |
| 14, 15, 16       | points 14, 15 and 16                  |
| 17, 18           | points 17 and 18                      |
| 19               | point 22 and `four-way-gate-tests.md` |
| 20               | point 23                              |

The ten production-readiness evidence items of MBS §19 are production gates outside the Program (Packet §1).
Repository evidence bears on four of them, cited by position: item 5 (S1 PS-A2-N1–N8; operations GATE-1–GATE-5),
items 6 and 9 (D1: a production class refuses test-mode payment configuration, so payments are unavailable in
production until live mode is separately authorized; provider settings are separate per-environment variables, see
[`production-configuration-checklist.md`](production-configuration-checklist.md)) and item 10 (IMP §29 row 12).
