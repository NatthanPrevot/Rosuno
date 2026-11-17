WORK_ITEM: MVP-001
TYPE: FEATURE
BRANCH: wi/MVP-001-technical-completion
BASE_SHA: 91af560f2654f63ea20b19da75a166ca274d0ddf
MIGRATIONS: new allowed
ALLOWED_SCOPE:
- apps/web/*
- pnpm-lock.yaml
- supabase/migrations/*
- governance/*
FORBIDDEN_SCOPE:
- rosuno-authority/*
- docs/process/*
- .github/*
- .claude/*
- */.claude/*
- .mcp.json
- */.mcp.json
- CLAUDE.md
- */CLAUDE.md
- CLAUDE.local.md
- */CLAUDE.local.md
- AGENTS.md
- */AGENTS.md
- tools/*
- package.json
- pnpm-workspace.yaml
- .npmrc
- .replit
- .replitignore
- replit.md
- supabase/config.toml
- supabase/seed*
- supabase/seeds/*
- governance/*schema*.json
- governance/*template*.json
- governance/control-fields.json
- governance/dl-eng-1-engineering-process-rulings.md
- governance/dl-eng-2-governance-simplification.md

# ROSUNO MVP-001 — Technical Completion Program

**STATUS: FINAL CANDIDATE for exact-byte owner adoption (2026-11-16). It authorizes nothing until the owner adopts it
on owner branch `wi/MVP-001-technical-completion` and grants implementation. It is a Program Packet under DL-ENG-3 and
is valid only with DL-ENG-3. It relies on the owner's exact-text approval of PS-A2 (§3), whose Lock Condition completes
when slice S1 merges.**

Independent review is optional (DL-ENG-2 G1). Locked documents are cited by section only; no locked text is
reproduced. Replit is on HOLD (§2 rule 14).

## 1. Program fields (IMP §§5, 7)

| Field | Value |
|---|---|
| ID | MVP-001; register entry `WI-P2-MVP-001-TECHNICAL-COMPLETION` (register grammar `WI-P0/P1/P2-`, same mapping pattern as P5-001) |
| Milestones | M1 residue, M2 hardening, M3 application machinery and the core M14 machinery (MBS §17 "core, always-available"), M4 corrections and compliance surfaces, M5 remainder, M6–M13, MBS §18 product surfaces, and the technical verification and readiness preparation for M15. **Excluded:** M14 activation and the M15 production decision (separate gates) |
| Objective | The MBS §27 technical-complete MVP against development-safe configuration and controlled test data, delivered as eleven bounded slices, each reviewed and accepted before the next |
| Locked sources | IMP §§1–13, 15–41, 43; MBS §§1–28; TA; PS §§1–53 with PS-A1, FP-1 and (from its Lock Condition) PS-A2; ROS; DM §§0–13; PM §§0–16; MB with MB-A1; RMS §§34–39 (REG-CA identifiers cited as identifiers only); SI flow traces A–C. Per-slice sections in §6 |
| Decisions | DL-ENG-1 (as amended), DL-ENG-2, DL-ENG-3; DEC-20260924-P1-CLOSURE-P2-TRANSITION; DEC-20261020-P2-007; DEC-20261028-P2-008; DEC-20261104-P3-002; DEC-20261113-P3-904; DEC-20261115-P5-001; the PS-A2 adoption entry |
| Dependencies | Owner `main` at or after BASE_SHA; slices in §6 order with the independence marks given there |
| Allowed files | Machine header. Dependency changes: only named security patches of the nine packages already allowed by the P0 validator (first: `next` past GHSA-mfr8-8qww-v76h, because `next build` currently halts on it); no new package name |
| Database impact | New forward-only migrations per slice; no change to any historical migration; one coherent change per migration (IMP §35) |
| RLS impact | Every relation a slice starts using gets policies and deny/positive tests before application use (MBS §20; PS §47); writes become function-only where a slice takes ownership, with `service_role` narrowed accordingly |
| Provider impact | Stripe (test mode), Daily, Resend and an AI-provider adapter, all on `fetch` + `node:crypto`; no provider SDK |
| Security impact | High (authentication, RLS, payments, storage, webhooks, physical model). Every slice PR carries a detailed Security / integrity section (UOM v2.0 §8; DL-ENG-2 G2) |
| Observability | Structured, data-minimized server logs with correlation IDs from S1; failure metrics per workflow; system-health and job views in the admin workspace (IMP §§15, 30) |
| Rollback | Forward corrective migration or restore, never destroying evidence (DL-ENG-1 R8); application changes reverted by forward commit |
| Stop conditions | §9 |
| Output | Per-slice report in the `CLAUDE.md` format plus the IMP §31 checkpoint facts (§8) |

## 2. Program rules

1. **Sequence.** One slice per session and one slice at a time, in §6 order. The next slice's implementation starts
   only after the previous slice's PR is merged. Read-only design of later slices may happen at any time. A blocked
   slice may be passed only for a slice marked independent (DL-ENG-3 P2, P4).
2. **One PR per slice** from `wi/MVP-001-technical-completion`. After each merge the branch continues with an
   integration merge of current owner `main`.
3. **Outcomes, not file lists.** Claude chooses the architecture, modules, files, migration boundaries, UI structure
   and test design inside the header scope, and reports the choices in the PR.
4. **Corrections.** Any defect inside this scope in earlier Rosuno work (P2-005 … P5-001) or in an earlier slice is
   corrected forward in the current slice PR and listed there (DL-ENG-3 P3; DL-ENG-1 R1). §7 lists the known ones.
5. **Fence tests.** Historical source-contract tests in `apps/web/tests` (single route handler; vocabulary bans on the
   home page, layout and design system; global `.delete(`, `.upsert(`, `createClient` and `service_role` bans; the
   privileged-module import allowlist) may be amended only to admit the exact new artifact a slice introduces, with an
   equal or stricter replacement assertion, each amendment listed in the PR's Security / integrity section. No fence is
   deleted without replacement. No RLS policy, constraint, check or test is weakened.
6. **Configuration seams.** G-1…G-5, CA-STAFF, CA-LM, CA-CLASS, CA-AUTO, CA-FEE, DOC-DEL, ELIG-MID, the PM §14
   scenarios and thresholds, and every DM §13 PROPOSED / OPEN / REGULATORY-GATED value are configuration only: never
   constants, defaults, enums, seeds or constraints (MBS §2.5; DL-ENG-1 R12). Unset means explicit failure or hold
   (MBS §§2.10, 23).
7. **Environment-anchored policy selection (PS-A2 §§2–6; TA §32 F1–F3; PS §44).**
   - Each database records its own environment class once (`development`, `staging` or `production`, with the
     project reference for hosted databases). The record is immutable and only the database owner role can write it.
   - **Executable development configuration** is a policy version with `development_only = true`. It is always
     `draft`, can never be approved, and is fixed at creation except for one closing of `effective_until`. It can be
     created, and selected, only when the recorded class is `development` or `staging`.
   - **Authority configuration** is selectable only when `development_only = false`, `status = 'active'`, the version
     is effective at the instant and it has verified authority provenance (the adopted P3-003 rule, generalized).
   - **Incomplete drafts** (`development_only = false` with status `draft`, `internal_review` or `counsel_review`) are
     never selectable anywhere.
   - Two applicable versions of any kind are a conflict: nothing is selected.
   - Selection happens only inside database functions, from canonical rows. A caller-supplied policy reference is
     accepted only if it equals what the database derives.
   - "Environment = PRODUCTION" in the four-way gate means recorded class `production` (MBS §§6, 19). If the
     environment is unrecorded, no policy is selectable, policy-driven functions refuse with `environment_unrecorded`,
     and the gate is false.
   - The application refuses every policy-driven or financial operation when its server-side environment class or
     expected project reference differs from the record. The database refuses with `environment_mismatch` when a
     request's Supabase JWT issuer names a different project.
8. **Policy-type catalog.** The catalog is PS §8.3 plus FP-1's `payment` and `payment_flow`, seeded by migration as
   reference data (PS §45), with codes as lower-snake forms of the PS names. The eligibility type code is `eligibility`
   (conformance correction SCH-4, §7). No other type is added without a bounded amendment.
9. **Development configuration** exists only in disposable databases and tests, or on Staging under separate owner
   authorization. It never satisfies a production gate (MBS §4).
10. **No synthetic persistent records.** End-to-end journeys run in disposable environments. Synthetic rows on
    Staging need separate owner authorization (FP-1 §3.4; DL-ENG-1 R10).
11. **Wording.** Jurisdiction relevance only as "may be relevant" (MB §27). None of the banned recommendation claims
    (MBS §10). No claim of live or approved regulatory status (MBS §17). Unapproved legal text is never rendered;
    content pages say that information is not yet available.
12. **Provider isolation.** Provider events are observations. Authenticity, replay protection and idempotency come
    before any effect. Disagreement creates a Reconciliation Exception (MBS §§2.7, 22, 24; IMP §§3, 23).
13. **Server authority.** Every expiry, acceptance, release, currentness and authorization decision is server-side.
    Browser timers only display (MBS §2.8).
14. **Replit HOLD.** No Replit-dependent modification (`.replit`, `.replitignore`, `replit.md`, deployment
    configuration) and no hosting or deployment conclusion until the owner reconciles the documented Replit
    discrepancy. Hosted-environment verification (level L6, §5) is outside this Program until then.
15. **Records.** Each slice PR updates the registers with the facts known before merge and records the previous slice's
    post-merge facts. New migrations are registered `reviewed: false`, `applied_environment: "none"`. Evidence of
    Staging operations is a standalone dated package, summarized in `governance/evidence/` (DL-ENG-3 P5).
16. **Physical-model changes** (relations, columns, cardinality, ownership, immutability) happen only after the owner
    adopts the bounded amendment and its Decision Log entry (DL-ENG-1 R9; DL-ENG-3 P6). Claude supplies the amendment
    as a new dated file; adoption is a forward revision of this Packet.

## 3. Amendments and owner gates

**PS-A2 — deployment environment identity and development-configuration designation.** A bounded supplement to PS
§§44 and 8.4, supplied as a separate private file. It adds exactly two things:
- one relation, `deployment_environment`: a single immutable row holding the environment class and, for hosted
  databases, the 20-letter project reference;
- one column, `policy_versions.development_only`.

Its semantics are rule 7.

*Field-level anti-duplication test (DL-ENG-1 R9; owner adoption of this Packet approves it):*
- `environment_class` and `project_ref` have no existing home. The application setting is a binding check, not a
  second source of truth.
- `development_only` is not derivable from existing fields:
  - `draft` status and the absence of verified authority are shared with incomplete drafts;
  - `version_label` and `parameters` are content;
  - a new lifecycle state would change the Domain Model.
- No other relation, column, policy type or lifecycle state is added.

*Adoption and registration sequence (noncircular; DL-ENG-3 P6; PS-A1 precedent):*
1. Before this Packet is adopted, the owner approves PS-A2's exact bytes (Lock Condition element 1).
2. S1 implements PS-A2 in disposable environments only, under this Packet and that approval (DL-ENG-1 R9).
3. The S1 PR registers PS-A2 in `governance/authority-references.json` with status `pending_lock_condition`, and
   records its adoption in the Decision Log (elements 2 and 3).
4. The S1 merge, after designated approval, completes the Lock Condition. From then on PS-A2 is LOCKED.
5. Only then may the S1 migration be applied to Staging, under the owner's separate authorization. After it is
   applied, Staging is recorded once as `staging` with project reference `mxjlvmowmodzdtdfgqpb`, under the same
   authorization, after verifying the target identity and that no record exists (PS-A2 §4). Either Claude, through the
   Rosuno — Supabase Staging connector, or the owner executes it.
6. S2's PR sets the PS-A2 register status to `active`, together with S1's post-merge facts.

**Later amendment PS-A3 (Claude drafts it as a new dated file when the owner answers; adopted as a forward revision).**
It covers only the items whose dependent parts stop until it is adopted:
- attorney listed price, enabled durations and modalities, and request duration — S6 request and fee parts;
- a written message on the request — S6;
- public profile fields beyond PS — S5 part;
- break-glass — S2 part; otherwise delivered in S11;
- document lineage, if needed — S10 part;
- the data-request lifecycle — S11 part;
- any additional policy type a slice demonstrates it needs — that slice.

**Gates handled inside slices.** Claude builds the seam; only the dependent part waits.

| Gate | Owner of the decision | Slice behaviour until decided |
|---|---|---|
| Voice-memo limit (MB §§35, 55 state 60 s; MBS §8 "approved limit") | Owner | Limit is configuration; uploads refuse until it is set |
| AI provider, capability and data authorization (D-4) | Owner | Adapter reports unavailable; persistence and confirmation flow complete |
| Intake expiry period; revision vs new intake (D-3) | Owner | Configuration with no default; expiry off |
| Hold duration and caps; instant countdown; presence trust (DM §13) | Owner | Policy values; development values in tests only |
| Public content, Privacy, Terms, disclosures; filters and ranking; referral outcome taxonomy | Owner / counsel | Objective filters only; unapproved content not rendered |
| Quote validity; 90-minute enablement; PM §14 scenarios and thresholds; G-1…G-5 | Owner / counsel | Policy seams |
| Intake visibility to an attorney before acceptance (REG-CA-035 equivalent) | Counsel | Nothing shown |
| Post-consultation messaging window (MB-A1 §1); DOC-DEL; retention; review moderation; complaint vocabularies | Owner / counsel | Configuration; deletion executors disabled |
| Provider accounts and test-mode credentials (Stripe, Daily, Resend, AI) | Owner / provider | Level-L3 contract tests only; integration not declared complete (§5) |
| Staging operations: migration application, recording Staging's environment class, catalogs, staff grants, intake question publication | Owner (persistent) | Engineering continues in disposable environments |

## 4. Invariants (all slices)

- **One owner per fact.** Canonical state has a single owner. Derived values (eligibility, bookability, presence) are
  never mutable truth.
- **Append-only evidence.** Evaluations, snapshots, fee calculations, ledger entries, receipts, participation records
  and audit events are append-only and reconstructible (MBS §§2.1–2.3, 20; PS §32).
- **Fresh evaluations.** Fresh eligibility and bookability evaluations are persisted at referral creation, request
  creation and acceptance (MBS §2.4).
- **Concurrency.** The MBS §9 invariants 1–6 hold. So do the IMP §11 transactional invariants: request and hold,
  exclusive acceptance, acceptance and booking, no duplicate consultation, expiry and release, cancellation against
  acceptance.
- **Payments.** Payment and consultation are independent state machines. The ledger is append-only. A duplicate or
  out-of-order provider event causes no duplicate or regressive effect (MBS §12; PM INV-1…INV-14).
- **Defense in depth:** authentication → authorization → RLS → server validation → business rules → resource access →
  audit (MBS §20). Privileged actions are audited atomically. There is no universal capability (MBS §5).
- **Four-way gate.** Production financial activity requires all four conditions; three are not enough (MBS §§6, 19).
- **Jurisdiction neutrality.** No jurisdiction rule is hard-coded. Jurisdiction-specific objects stay conditional
  (MBS §§2.6, 17).
- **Logs.** Logs never contain secrets, tokens, signed URLs, legal-matter text, payment credentials or raw provider
  payloads (IMP §15).
- **Never in this Program:** making a jurisdiction `live`, activating production payments, or enabling registration
  beyond default-deny.

## 5. Verification levels and completion rule

| Level | What | Where | Counts as |
|---|---|---|---|
| L1 | Unit and application tests (`apps/web/tests/*.test.mjs`, fake ports, synthetic Auth) | CI + local | Logic and contract evidence |
| L2 | Disposable-database proofs (`apps/web/tests/*-db-proof.mjs`, PostgreSQL 16): RLS deny/positive, function outcomes, concurrency, immutability, catalog snapshot | local (explicit run) | Database security and invariant evidence |
| L3 | Mocked integrations: provider contract tests with recorded payload shapes, signature verification and idempotency, using test doubles confined to tests (DL-ENG-1 R10) | CI + local | Adapter correctness only — **never integration completion** |
| L4 | Sandbox-provider tests: real Stripe test mode, Daily and Resend sandboxes, and the AI provider once named, using owner-provided test-mode credentials held as environment network secrets | local, Builder session | **Required** to declare an integration complete |
| L5 | Browser end-to-end journeys (preinstalled Playwright; explicit-run scripts, like L2) against a local full stack (`npx supabase start` + `next start`) | local | User-journey and product-surface evidence (MBS §18.6) |
| L6 | Hosted-environment verification (deployed build + Staging) | Staging (owner-authorized) | **HOLD** (rule 14); listed as outstanding in the M15 readiness pack |

**Completion rule.** A slice is accepted when its acceptance criteria hold at the levels named for it. Where L4 is
not yet possible (no sandbox credentials), the slice may merge with the integration recorded as "implemented;
sandbox verification outstanding" (a known exception in the checkpoint). It is declared complete only when L4 evidence
is recorded, in a later slice PR or in S11, with no new authorization. Rollback-only Staging validation and read-only
Staging verification of merged migrations run under the owner's authorization (standing delegation where given).

## 6. Slices

Each slice gives capability, sources, dependencies, database, provider, verification levels and acceptance. The
program rules, the invariants and §9 apply to every slice.

### S1 — Platform controls (IMP P3/P4 remainder; checkpoints A/B residue)
- **Capability:**
  - environment identity per PS-A2 and rule 7;
  - environment-aware configuration that refuses missing or fake provider values (M1);
  - policy lifecycle: draft → review → approved with verified authority references → scheduled / active / suspended /
    retired, immutable once approved;
  - a generic effective-dated resolver in the database that fails honestly when no policy applies and blocks on
    conflict (TA §31);
  - launch-gate evaluation, human launch authorization and the four-way gate function;
  - the policy-type catalog seed (rule 8);
  - staff surfaces for policy management, jurisdictions, practice areas, reference catalogs, staff and capability
    administration (grant, revoke, expire, all audited) and intake configuration publishing;
  - logging foundation with correlation IDs;
  - corrections D-1, D-2, D-3, D-4, D-5, D-6, D-8, D-9, D-11, D-14, SCH-1…SCH-4 and records REC-1 (§7).
- **Sources:** MBS §§4–6, 17, 18.4, 20; IMP §§8, 15, 17–18; TA §§31–36, 42; PS §§2, 5–9, 32, 44–45 with PS-A2; MB §§81–92.
- **Database:**
  - PS-A2: the `deployment_environment` relation with its initialization and accessor functions, and the
    `policy_versions.development_only` column with its creation, immutability and selection rules;
  - functions for policy versions, authority references, launch gates, evaluations and authorizations,
    jurisdictions, service areas, practice areas and capability grants;
  - immutability triggers on approved policy versions and on authority references once used;
  - `service_role` writes on those relations narrowed;
  - replacement P3-904 functions that generate primary keys server-side and use the `eligibility` code;
  - `availability_rules` checks.
- **Verification:** L1, L2, L5 (staff surfaces).
- **Acceptance:**
  - MBS §§4 and 6 completion criteria and failure tests;
  - PS-A2 positive tests:
    - a `staging`-class database selects an effective development configuration;
    - a `production`-class database selects an active, effective authority version with verified provenance;
    - disposable databases run as `development`;
  - PS-A2 negative tests (L2 unless marked):
    - creating a development configuration is rejected when the class is `production` or unrecorded;
    - a development row planted by the owner role with triggers bypassed is still never selected in a
      `production`-class database;
    - an unrecorded database selects nothing and refuses with `environment_unrecorded`, and the production gate is
      false;
    - incomplete drafts (`draft`, `internal_review` and `counsel_review` with `development_only = false`) are never
      selected in any class;
    - a development configuration outside its effective window is not selected;
    - changing a development configuration's `development_only`, scope, label, parameters, `effective_from` or status
      is rejected, and so is a second change to `effective_until`;
    - approving a development configuration is rejected, and a verified authority reference attached to it does not
      make it selectable;
    - in a `production`-class database, a caller-supplied development policy reference (for example to
      `staff_record_eligibility_evaluation`) is rejected;
    - `anon`, `authenticated` and `service_role` cannot read or write `deployment_environment`, cannot write
      `policy_versions` and cannot execute the initialization function, and `anon` cannot execute the accessor;
    - a second initialization is rejected, and so is any update, delete or truncate of the record;
    - initialization rejects an unknown class, a missing or malformed project reference for `staging` or
      `production`, and any project reference for `development`;
    - two applicable versions of any kind yield a conflict and no selection;
    - a JWT issuer naming another project yields `environment_mismatch`;
    - (L1) the application refuses policy-driven operations when its environment class or project reference
      differs from the record;
  - editing an approved policy refused;
  - approval without verified authority refused;
  - launch authorization without gates refused;
  - expired or revoked grant denied;
  - staff run policy, catalog and capability operations through the UI without SQL;
  - `pnpm run build` passes.

### S2 — Durable jobs, system actor, M2 hardening (IMP P3 remainder; MBS §21)
- **Job architecture (chosen; TA §§23, 27, 72; IMP §37; PS §24):**
  1. Deadline transitions are database functions, and every consequential command evaluates deadlines itself, so
     correctness never depends on scheduler timing.
  2. `pg_cron`, enabled by a forward migration, runs database-only sweeps: holds, requests, quotes, intake expiry,
     lease reclamation and escalation marking. It needs no secrets and no network.
  3. Provider side effects use a transactional outbox in `operational_jobs`.
  4. One claim-based worker in the Next.js server runtime performs them: claim with skip-locked semantics through a
     server-only function, lease, bounded attempts with backoff, deterministic idempotency keys, escalation on
     exhaustion, cancellation when the subject becomes terminal.
  5. The worker runs after commit in the originating request, and through a protected worker route for retries and
     backlog. The hosted trigger for that route is configured with hosting (rule 14). Until then a missing trigger only
     delays side effects; the delay is visible in the admin job view.
  - Edge Functions and a long-running worker are not used (second runtime and deploy path; TA §72).
- **Also:**
  - system/provider actor recording for trusted server operations;
  - suspicious-login detection and handling;
  - MFA step-up for attorney and staff sessions (Supabase Auth);
  - rate limits for sign-in and recovery;
  - break-glass if PS-A3 is adopted by then, otherwise in S11.
- **Sources:** MBS §§5, 21, 22; IMP §§17, 36; TA §§19–20, 23, 27, 38, 43; PS §24.
- **Verification:** L1, L2.
- **Acceptance:**
  - pending jobs survive restart;
  - attempts are bounded and exhaustion escalates visibly;
  - duplicate execution has no duplicate effect;
  - expiry is correct without the sweeper;
  - MBS §5 failure tests (authentication and recovery abuse, rate-limit bypass, suspicious-session boundary,
    capability escalation).

### S3 — M5 remainder and protected Storage (IMP P5) — independent of S4
- **Capability:**
  - private bucket and server-issued short-lived signed URLs after principal, capability, relationship, grant and
    legal-hold checks (IMP §13);
  - voice memo with a server-enforced, configured limit;
  - AI Suggestion: generate → persist → workflow confirmation, behind the adapter;
  - intake expiry and active / expired / superseded transitions, and post-submission semantics, as configuration;
  - category routing;
  - staff intake configuration and jurisdiction-assessment review;
  - privacy and help entry points;
  - verification-evidence upload (M4).
- **Sources:** MBS §§8, 15 (12B), 20; IMP §§13, 19; TA §§3.3, 7, 30, 57; PS §§12–13, 19, 29 with PS-A1; DM §6;
  MB §§25–27, 35, 55, 100–104.
- **Verification:** L1, L2, L5; L4 for AI only after D-4.
- **Acceptance:**
  - MBS §8 failure tests;
  - object-path guessing fails;
  - AI output never mutates protected state;
  - the voice-memo limit is enforced server-side;
  - intake survives decline and retry.

### S4 — M6 Scheduling foundation (IMP P6; checkpoint C) — independent of S3
- **Capability:** availability rules, blackouts, Instant mode with session-bound intent and server expiry, runtime
  presence, bookability evaluation persistence, slot-hold acquire/release, booking support, expiry sweeps, attorney
  Schedule UI (calendar, availability, blackouts, Instant mode), UTC storage with IANA context.
- **Sources:** MBS §9; IMP §20; TA §§10–11, 24, 59; PS §§6, 16, 34–35; DM §§2.6–2.7, 8; MB §§31–34, 41–44.
- **Verification:** L1, L2 (the seven IMP §20 concurrency tests and MBS §9 invariants 1–6), L5.

### S5 — M7 Discovery / Referral and public site (IMP P7; checkpoint D)
- **Capability:**
  - public Home, Find an Attorney, How Rosuno Works, For Attorneys, About, FAQ/Help, Contact, Privacy, Terms and
    disclosure surfaces, with a renderer that fails closed;
  - public attorney profiles with a field allowlist;
  - search with objective filters and sorting;
  - presentation with ordering and per-filter attribution;
  - client selection;
  - referral with fresh evaluations, pool snapshot, presented set, attempt ordinal and outcome;
  - a decision-point eligibility recorder for the referral, request and acceptance contexts;
  - discovery → sign-in handoff.
- **Sources:** MBS §§10, 17, 18.1, 18.6; IMP §§21, 38; TA §§8, 28–29, 55, 58; PS §14; DM §7; MB §§24, 28–30, 123–125.
- **Dependencies:** S4 for end-to-end acceptance.
- **Verification:** L1, L2, L5.
- **Acceptance:**
  - MBS §10 failure tests;
  - no protected data on public pages;
  - banned-claims tests;
  - direct-URL and guessed-identifier denial.

### S6 — M8 Request / Pricing (IMP P8; checkpoint E)
- **Capability:**
  - attorney price, duration and modality management (after PS-A3);
  - request creation with fresh evaluations;
  - atomic scheduled request + hold;
  - instant request;
  - immutable fee calculation from Fee Policy (development policy for technical completion);
  - quote validity and expiry;
  - request withdrawal;
  - review and confirmation UI;
  - message and voice-memo association per PS-A3.
- **Sources:** MBS §11; IMP §22; TA §§6, 58–59; PS §§15, 22.1, 35; DM §§2.4–2.5, 9; ROS §14.1; MB §§151–152; PM §§3–4.
- **Dependencies:** S5; PS-A3 for the price, duration and message parts.
- **Verification:** L1, L2, L5.
- **Acceptance:**
  - MBS §11 failure tests;
  - no zero-price fallback;
  - a missing or invalid price makes the attorney not bookable.

### S7 — M9 Payment infrastructure (IMP P9; checkpoint F)
- **Capability:**
  - engine boundary;
  - Stripe adapter (test mode): authorize, capture, release, refund, dispute observation;
  - webhook authenticity, receipt uniqueness and replay protection;
  - outbound idempotency;
  - payment state with FP-1 provenance;
  - ledger posting;
  - reconciliation exceptions and finance workspace;
  - development-safe configuration;
  - four-way gate enforcement;
  - client payment status, receipts and refunds;
  - ledger-derived attorney earnings.
- **Excluded:** payouts, transfers, Connect onboarding, live keys.
- **Sources:** MBS §§12, 19; IMP §§3, 23; TA §§15–16.1, 26, 32, 52–53; PS §§22–23, 33; PM; FP-1; MB §§46–47, 64–80;
  MB-A1 §2.
- **Verification:** L1, L2, L3, **L4 (Stripe test mode) for completion**, L5.
- **Acceptance:**
  - the IMP §23 exit list (success, authorization failure, capture failure, duplicate webhook, out-of-order webhook,
    refund, reconciliation);
  - MBS §12 failure tests;
  - tests cite PM rows.

### S8 — M10 Attorney decision / acceptance / booking (IMP P10, standalone; checkpoint G)
- **Capability:**
  - request queue and detail;
  - accept / decline;
  - serialized acceptance with a deterministic loser;
  - booking conversion and hold conversion/release;
  - payment and engagement transitions read from configuration;
  - consultation creation per G-5 configuration;
  - expiry and cancellation races;
  - jurisdiction or eligibility change routed to hold/review per configuration;
  - audit.
- **Sources:** MBS §13; IMP §24; TA §§6, 13–14, 60–63; PS §§17, 36; DM §9; PM rows 1–10, 39–45.
- **Verification:** L1, L2 (concurrency), L5.
- **Acceptance:** MBS §13 failure tests.

### S9 — M11 Consultation / Media (IMP P11; checkpoint H)
- **Capability:** consultation state machine, client and attorney workspaces, waiting room, one media room per
  consultation, Daily adapter with role-scoped tokens, provider sessions, participation evidence, reconnect handling,
  server-controlled timing, no recording.
- **Sources:** MBS §14; IMP §25; TA §§16.2, 46, 48, 53, 66; PS §§17–18, 23, 38; ROS §11.
- **Verification:** L1, L2, L3, **L4 (Daily sandbox) for completion**, L5.
- **Acceptance:** MBS §14 failure tests; IMP §25 exit, in a disposable environment.

### S10 — M12 Communications / Resources / Notifications (IMP P12; checkpoint I)
- **Capability:** three separately implemented parts (IMP §26):
  - consultation-scoped messages with a configurable post-consultation window;
  - documents, voice memos, sharing grants, versioning and secure access;
  - notification lifecycle, Resend adapter, durable delivery attempts, retries, observations and a notification
    center.
- **Sources:** MBS §15; IMP §26; TA §§16.3, 23, 27, 47, 57; PS §§19–20, 24, 29; ROS §§12, 15; MB §§51–55, 97–99;
  MB-A1 §1.
- **Verification:** L1, L2, L3, **L4 (Resend) for completion**, L5.
- **Acceptance:** MBS §15 failure tests for 12A–12C; a failed notification never rolls back a business event.

### S11 — M13, surface completion, technical verification and M15 readiness preparation (IMP P13; checkpoint J)
- **Capability:**
  - completion types (normal, early, cancellation, no-show, technical failure) with PM distinctions;
  - the `reviews` relation (PS §21.1) and the server-qualified review flow;
  - complaint foundation;
  - reconciliation and audit workspaces;
  - operations dashboard and system health;
  - privacy and data-request controls (with PS-A3);
  - legal-hold linkage;
  - attorney lifecycle operations: waitlist, rejoin prevention, audited suspension and removal;
  - compliance workspace;
  - the remaining admin, client and attorney surfaces (MBS §18);
  - break-glass if it was deferred from S2.
- **Technical verification and readiness preparation (no production action):**
  - the MBS §26 23-point evidence matrix;
  - the MBS §19 and IMP §29 technical-condition evidence;
  - a production security-review preparation pack (IMP §40);
  - a non-production backup/restore verification procedure;
  - a release-artifact and migration-set traceability procedure (IMP §8);
  - a production configuration checklist that excludes every development value;
  - four-way gate negative tests;
  - an outstanding-items list (L4 gaps, L6 HOLD, counsel and owner gates, M14).
- **Sources:** MBS §§16, 18, 19, 26–27; IMP §§8, 27, 29, 38–40; TA §§17–18, 20–21, 40–41, 49–51; PS §§21, 25–27, 30.4;
  PM §§5–7, 9; MB §§19, 22, 59–63, 81–92, 106, 114, 120–122.
- **Verification:** L1, L2, L5; L4 gaps closed where credentials exist.
- **Acceptance:** MBS §§16 and 18.6 failure tests; IMP §27 exit (operations without direct database edits); every
  MBS §26 point mapped to evidence or listed as an exception.

## 7. Known corrections included

| ID | Correction |
|---|---|
| D-1 | Remove the home-page account-creation call to action that always refuses |
| D-2 | Keep form input and errors across submissions |
| D-3 | Intake list limit and summary truncation |
| D-4 | Staff queue paging |
| D-5 | Security headers |
| D-6 | Staff record actions apply the review page's visibility rule (fail closed) |
| D-8 | Observability |
| D-9 | Local project binding in non-production only, production binding unchanged |
| D-11 | Workspace navigation |
| D-14 | Next.js security patch |
| SCH-1 | Server-generated primary keys (PS §2.2) |
| SCH-2 | Immutable policy versions and authority references (MBS §6; PS §32) |
| SCH-3 | Availability-rule checks |
| SCH-4 | Eligibility policy-type code `eligibility` (PS §8.3; DL-ENG-1 R1), replacing `attorney_eligibility` in the migration-15 functions (by forward migration) and in the application. No policy-type or policy-version rows exist yet, so no data changes |
| REC-1 | Records: the P5-001 carry-forward set (including the PR #95 approval facts, recorded only as the owner supplies them), PS-A1 `active`, P2-005 and P2-006 register entries, stale P2-900 and P2-901 entries, P3-002 limitation closure, and registration of DL-ENG-3 and of PS-A2 (as `pending_lock_condition` in S1; `active` in S2's records) |

D-7 (password rule on reset) stays gated (P2-008).

## 8. Commands and evidence (every slice)

```
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run typecheck
pnpm run build
pnpm run p0:validate
pnpm run p0:test
pnpm run secrets:check
pnpm run dependency:check
node apps/web/tests/<each>-db-proof.mjs        # all existing proofs plus each new slice proof (L2)
<explicit L5 journey scripts for the slice>     # local full stack
bash .github/scripts/rosuno-guard.sh <owner main SHA> HEAD wi/MVP-001-technical-completion refs/rosuno/approved
```

Each slice report uses the `CLAUDE.md` format plus the IMP §31 checkpoint facts: completed capabilities, tests by
level, known exceptions, configuration used, next dependency, rollback point. Invariant, financial and regulatory tests
cite PM rows or Decision Log entries (DL-ENG-1 R6).

## 9. Stop conditions

**STOP (Class B)** with the exact question and a recommendation:
- a gated value needed as data;
- a physical-model change not yet adopted;
- a path outside the header;
- a new npm package;
- a conflict between a locked source and this Packet or the repository;
- scope expansion;
- any IMP §43 condition.

Only the dependent part stops; independent work continues.

**STOP → REPORT → WAIT (Class C):**
- unexplained drift (files, branch, HEAD, Packet, migration bytes, Staging history or fingerprints);
- a security-critical issue;
- an undeclared credential.

**Never:**
- edit a historical migration or merged history;
- weaken a test, policy, constraint or check;
- fabricate data, evidence or reviews;
- touch Production or OLD Supabase;
- perform an owner-controlled operation without the owner's word or standing delegation;
- approve or review a PR.
