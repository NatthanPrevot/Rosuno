WORK_ITEM: P5-001
TYPE: FEATURE
BRANCH: wi/P5-001-client-intake-foundation
BASE_SHA: bc54701c0af9ea9f5e5b40e7d5dac99fec8bdd00
MIGRATIONS: new allowed
ALLOWED_SCOPE:
- supabase/migrations/*
- apps/web/app/client/*
- apps/web/app/page.tsx
- apps/web/src/application/client-intake*
- apps/web/src/application/intake-question-set*
- apps/web/src/infrastructure/client/*
- apps/web/src/presentation/client-intake*
- apps/web/tests/*
- governance/decision-log.json
- governance/authority-references.json
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
- package.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- apps/web/package.json
- supabase/config.toml
- supabase/seed*
- supabase/seeds/*
- apps/web/app/attorney/*
- apps/web/app/staff/*
- apps/web/app/sign-up/*
- apps/web/app/sign-in/*
- apps/web/app/auth/*
- apps/web/app/forgot-password/*
- apps/web/app/reset-password/*
- apps/web/src/application/attorney-*
- apps/web/src/application/staff-*
- apps/web/src/application/professional-*
- apps/web/src/application/eligibility-*
- apps/web/src/application/policy-*
- apps/web/src/application/security.ts
- apps/web/src/application/session.ts
- apps/web/src/application/client-registration.ts
- apps/web/src/infrastructure/identity/*
- apps/web/src/infrastructure/professional/*
- apps/web/src/infrastructure/staff/*
- governance/schema-drift/*
- governance/releases/*
- governance/evidence/*
- governance/dl-eng-1-engineering-process-rulings.md
- governance/dl-eng-2-governance-simplification.md

# ROSUNO P5-001 — Client Intake Foundation (M5, first slice)

**STATUS: FINAL DRAFT for exact-byte owner adoption. It authorizes nothing until the owner adopts it and grants
implementation.**

Owner decisions applied:
- D1: Option A, approved.
- D2: Option A with database-managed, versioned configuration, approved in principle. The exact initial version is in
  §4 and is adopted with this Packet.
- Privacy and help entry points: deferred.

Independent review is optional (DL-ENG-2 G1).

## 1. Work-item fields (IMP §§5, 7)

| Field | Value |
|---|---|
| ID | P5-001; register entry `WI-P5-001-CLIENT-INTAKE-FOUNDATION` |
| Milestone | M5 Client / Intake / AI Suggestion (MBS §8; IMP §19 P5). This is the first slice; it does not complete M5 (§12) |
| Capability | Client Workspace foundation; Intake create, edit, submit and close; append-only content revisions; database-managed, versioned structured questions; optional description; client-stated jurisdictions as unreviewed assessments |
| Locked sources | IMP §§5–7, 11, 12, 19, 35, 38; MBS §§2, 8, 18, 20, 28; DM §§0, 2.8, 6; TA §§0, 3.3, 5.2, 7; ROS §§2.4, 6, 20–24; PS §§1–3, 5, 8, 12, 13, 26, 30–32, 39–43, 45, 46, 52A, 53; MB §§24–27, 100; RMS REG-CA-034, REG-CA-035 |
| Amendment | PS-A1, `PHYSICAL-SPECIFICATION-AMENDMENT-PS-A1-LOCKED`, SHA-256 `1612e751d6d94ffdf4c7c13f168d9e97bd85f793b03ccc5aa41e3d48eb1e803e`. Private; registered by identifier and hash only. Its §7 holds the DL-ENG-1 R9 field-level anti-duplication record, which this Packet's adoption approves |
| Decision | `DEC-<YYYYMMDD>-P5-001-CLIENT-INTAKE-FOUNDATION`, written into the register during implementation from the adopted draft |
| Unresolved, not decided here | RMS REG-CA-035 (counsel-gated: what may be collected, notices before collection, pre-acceptance disclosure); intake expiry period (PROPOSED); revision versus new Intake after submission (PROPOSED); the AI provider; voice memo limit and Storage; the reference-catalog contents on each persistent environment |
| Dependencies | met: P1-003, P1-004, P1-005 (on Staging); P2-003 security shell; P2-004 to P2-008 identity and client registration; P3-904 (Staging application complete) |

## 2. Objective

An authenticated client can do all of the following through the authorized UI:
- create Intakes;
- answer the current published question set and an optional description, saved as immutable revisions;
- submit the Intake, which records the jurisdictions the client stated as unreviewed suggestions;
- close the Intake.

The database enforces own-client isolation, revision and configuration immutability, version-correct validation,
serialized lifecycle transitions and rejection of stale writes. Nothing deletes an Intake or its content. Routine
question and limit changes are made by publishing a new configuration version, with no code change, migration or
deployment.

## 3. Database design (one forward-only migration)

The migration is `supabase/migrations/<UTC timestamp>_p5_001_client_intake_foundation.sql`, with a timestamp later
than `20261106090000`.

### 3.1 Relations
`intake_question_sets` and `intake_revisions`, exactly as PS-A1 §§1–3 defines them. The migration adds:
- RLS on both relations;
- SELECT for `authenticated` only: all published versions, and revisions of the caller's own Intakes;
- no INSERT, UPDATE or DELETE for any API role, including `service_role`;
- triggers that reject UPDATE and DELETE on both relations for every role.

### 3.2 Capability
The migration inserts one capability-catalog row, `manage_intake_configuration`, following the P1-004 precedent. It
inserts no question set, grant, catalog row or other business data.

### 3.3 Functions
- All are `SECURITY DEFINER` with `search_path` fixed to `pg_catalog`.
- `EXECUTE` is revoked from `public`, `anon` and `service_role` and granted to `authenticated` only. Helpers are
  executable by no API role.
- The actor is taken from `auth.uid()` only.
- Each function returns one fixed outcome code and carries no detail.

| Function | Effect | Outcomes |
|---|---|---|
| `client_create_intake()` | New `draft` for the caller's own Client Profile. Requires a published current version and the start rate limit (§3.4) | `created` (id), `rate_limited`, `unavailable` |
| `client_save_intake_revision(intake, expected_revision, question_set, practice_area, description, answers)` | Draft only. Appends revision n+1 when `expected_revision` equals the latest (null when none) and the version passes the selection rule (§3.5). Validates against that version. Rejects a save equal to the latest revision | `saved` (n), `unchanged`, `conflict`, `version_not_allowed`, `invalid`, `not_editable`, `rate_limited`, `not_found`, `unavailable` |
| `client_submit_intake(intake, expected_revision)` | `draft → submitted` when `expected_revision` is the latest. Requires every required question to be answered under the governing version, using the practice-area answer rule in §3.6, where an explicit "Not sure" is a complete answer. A selected practice area must still be active (otherwise `needs_update`). An explicit "Not sure" needs no practice area and produces no classification, eligibility, suggestion or routing record. Appends one `jurisdiction_assessments` row per stated jurisdiction (`source_type` `client_statement`, `review_status` `unreviewed`, basis naming the revision number and version key, `ai_suggestion_id` null). An exact replay returns `already_submitted` | `submitted`, `already_submitted`, `conflict`, `incomplete`, `needs_update`, `not_editable`, `not_found`, `unavailable` |
| `client_close_intake(intake)` | `draft`, `submitted` or `active` → `closed`; `closed_at` is set by the server. A replay returns `already_closed` | `closed`, `already_closed`, `not_found`, `unavailable` |
| `client_intake_practice_areas()` | id, code, name and active flag for active rows, plus rows referenced by the caller's own revisions | rows |
| `client_intake_jurisdictions()` | id, code and name of the jurisdiction catalog. Clients have no table grant | rows |
| `staff_publish_intake_question_set(version_key, definition)` | Publishes an immutable version (§3.6). Requires an active staff User with a valid, unrevoked, unexpired, global `manage_intake_configuration` grant | `published` (id), `invalid`, `duplicate_version`, `forbidden` |

### 3.4 Locks, rate limits and audit
- **Lock order:** User (active, `FOR SHARE`) → Client Profile (`FOR NO KEY UPDATE`, which serializes one client's
  intake writes so rate limits are exact) → Intake (`FOR UPDATE`).
- **Publication** is serialized by a table lock, and `published_at` must be strictly later than every earlier
  version.
- **Rate limits** come from the current version's `limits` and are rolling windows per client: revision saves across
  all of the client's Intakes, and Intake starts.
  - An exceeded limit returns `rate_limited` and stores nothing. Earlier revisions are untouched.
  - The UI tells the client the last saved version is safe, keeps the unsaved form, and allows retry.
  - There is no cap on total revisions or open Intakes.
- **Audit events** are written in the same transaction:
  - `client_intake_created`, `client_intake_submitted` and `client_intake_closed` carry identifiers, state, revision
    number and version key. They never carry intake content;
  - `intake_question_set_published` carries the version key and `sha256(definition::text)`.

  An audit failure rolls back the operation.

### 3.5 Version selection and draft continuation
- A save may cite only:
  - the Intake's governing version (that of its latest revision); or
  - the current version (latest `published_at`).
- A first save must cite the current version.
- Moving a draft to the current version is an explicit client action:
  - the UI pre-fills only the category, the description, and answers whose question identifier, kind and choice
    identifiers exist unchanged in the current version;
  - the client then saves;
  - earlier revisions are never translated or revalidated.
- Publishing a version never changes a saved revision.
- A draft can be submitted under its governing version.

### 3.6 Configuration definition, format 1 (validated in the database at publication and at every save)
- **Top level:** `format` (= 1), `questions`, `description`, `limits`. No other keys.
- **Question:**
  - `id`, matching `^[a-z][a-z0-9_]{1,39}$` and unique within the version;
  - `kind`;
  - `prompt`: 1–200 characters;
  - `help`: optional, 1–500 characters;
  - `required`: boolean;
  - for catalog kinds, `not_sure_label`: 1–80 characters;
  - for `single_choice`, `choices`: 2–20 entries of `{id, label}`, with each id matching the id pattern and unique
    within the question, and each label 1–80 characters.

  There are 1–20 questions in array order. A question identifier already published under a different `kind` is
  rejected.
- **Supported kinds:**
  - `practice_area`: at most one per version. A selected category is stored in `practice_area_id`. An explicit Not sure
    is stored as the answer value `"not_sure"` under the question id, with `practice_area_id` null. The two states mean:
    - **answered:** exactly one of the two is present;
    - **unanswered:** neither is present;
    - both present: `invalid`.

    A required question must be answered at submission. An optional question may be left unanswered. With no
    `practice_area` question in the version, both must be absent.
  - `jurisdictions`: at most one per version. The answer is `"not_sure"`, or an array of 1–50 distinct existing
    jurisdiction ids.
  - `single_choice`: the answer is one choice id.
- **`description`:** `prompt`, optional `help`, `required`.
- **`limits`:**
  - `description_max_characters`, 1–20,000;
  - `structured_answers_max_bytes`, 256–16,384, measured as the UTF-8 octets of `answers::text`;
  - `revision_saves_per_client` and `intake_starts_per_client`, each `{max: 1–10,000, window_seconds: 60–604,800}`.
- **Answers:** an object keyed by question id. Unknown keys, malformed values, unknown choices or ids, and a newly
  selected inactive practice area are rejected. Required questions are enforced at submission against the governing
  version; a draft may be partial. "Not sure" is an explicit answer and is distinct from an unanswered question.
- **Technical ceilings** are fixed security invariants in the migration, not business defaults:
  - the ranges above;
  - a column ceiling of 20,000 characters for `description`;
  - a column ceiling of 16,384 bytes for `structured_answers`.

### 3.7 Privilege narrowing
Revoke INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER on `intakes` and `jurisdiction_assessments` from
`public`, `anon`, `authenticated` and `service_role`. SELECT stays. No current writer exists.

## 4. Initial configuration version adopted with this Packet

- **Version key:** `intake-questions-v1`
- **Definition SHA-256:** `31a3245be9ecb6135f93e5141bd9d2314c7f30fb8cfd3389d5e8645fbfbdf395`
- **Byte length:** 1,296 bytes.
- **What is hashed:** the canonical PostgreSQL `jsonb` text form below, in UTF-8. The text is exactly
  `definition::text`.

| Order | id | Kind | Prompt (help) | Choices | Required |
|---|---|---|---|---|---|
| 1 | `practice_area` | practice_area | What do you need help with? | active practice areas, or Not sure | yes |
| 2 | `jurisdictions` | jurisdictions | Where did this happen? (Choose every state or jurisdiction that applies. If you are not sure, choose Not sure.) | one or more jurisdictions, or Not sure | yes |
| 3 | `court_case` | single_choice | Is there already a court case? | `yes` Yes · `no` No · `not_sure` Not sure | yes |
| 4 | `assistance_type` | single_choice | What kind of help are you looking for? | `understand_options` Understand my options · `document_help` Help with a document · `representation` Someone to represent me · `not_sure` Not sure | yes |
| — | description | — | Tell us in your own words (Optional.) | free text | no |

**Limits (adjustable defaults):**
- description: 4,000 characters;
- structured answers: 4,096 bytes;
- revision saves: 60 per client per hour;
- Intake starts: 10 per client per 24 hours.

**Exact definition:**

```json
{"format": 1, "limits": {"intake_starts_per_client": {"max": 10, "window_seconds": 86400}, "revision_saves_per_client": {"max": 60, "window_seconds": 3600}, "description_max_characters": 4000, "structured_answers_max_bytes": 4096}, "questions": [{"id": "practice_area", "kind": "practice_area", "prompt": "What do you need help with?", "required": true, "not_sure_label": "Not sure"}, {"id": "jurisdictions", "help": "Choose every state or jurisdiction that applies. If you are not sure, choose Not sure.", "kind": "jurisdictions", "prompt": "Where did this happen?", "required": true, "not_sure_label": "Not sure"}, {"id": "court_case", "kind": "single_choice", "prompt": "Is there already a court case?", "choices": [{"id": "yes", "label": "Yes"}, {"id": "no", "label": "No"}, {"id": "not_sure", "label": "Not sure"}], "required": true}, {"id": "assistance_type", "kind": "single_choice", "prompt": "What kind of help are you looking for?", "choices": [{"id": "understand_options", "label": "Understand my options"}, {"id": "document_help", "label": "Help with a document"}, {"id": "representation", "label": "Someone to represent me"}, {"id": "not_sure", "label": "Not sure"}], "required": true}], "description": {"help": "Optional.", "prompt": "Tell us in your own words", "required": false}}
```

**Not in any version without owner authorization:**
- "Who is involved?" or any question about other parties (REG-CA-035);
- any new substantive question.

## 5. Publication procedure (initial and routine)

The migration publishes nothing.

**When the procedure can run:** only after the migration has been applied to the target environment under its own
owner authorization. On Staging, rollback-only validation is the default first.

**Steps:**
1. The owner authorizes the publication, naming the environment, the version key and the definition SHA-256.
2. Through owner-controlled access, one active staff User holds a global `manage_intake_configuration` grant,
   time-boxed with `expires_at` where wanted. Creating the grant is itself an owner-authorized data operation.
3. That staff User, signed in, calls `rpc/staff_publish_intake_question_set` with the exact definition.
4. A read-only check confirms the version key, `published_at`, `sha256(definition::text)` and the audit event.

**Routine updates** repeat steps 1–4 with a new version key:
- no work item, migration, deployment or PR is needed when the change stays within the supported kinds and ceilings;
- owner approval, capability control and audit still apply.

**Changes that need engineering:** a new kind, a new format, a jurisdiction-specific set or a ceiling change.

## 6. Application scope

1. **`intake-question-set*`:** a generic parser, validator and renderer model for format 1. No question wording or
   limit is hard-coded. The database remains authoritative.
2. **`client-intake*`:** use cases with fixed outcomes, behind the unchanged Security Shell and the client principal
   context.
3. **`infrastructure/client/*`:**
   - RPC and read adapters on the request-scoped, unprivileged client;
   - no privileged credential.
4. **Routes:**
   - `/client`: the client's own Intakes, with state and last-saved time;
   - start an Intake;
   - `/client/intakes/[intake]`:
     - edit the draft from the governing version;
     - an "updated questions" notice with the explicit switch;
     - save, submit and close;
     - a submitted Intake is shown read-only;
   - an authenticated-session link from `/` to `/client`.

   Route parameters are validated as UUIDs. No browser value chooses an identity, state, version or revision.
5. **Wording rules:**
   - The jurisdiction display follows MB §27: attorneys in a jurisdiction "may be relevant", never that its law applies.
   - "Not sure" and multiple jurisdictions are shown as unresolved, and no inference is made from free text.
   - A practice-area "Not sure" is shown as "Category not yet identified". No category, eligibility or routing outcome
     is suggested from it.
   - With no published version: "Intake is not available yet".
6. **Presentation** uses the existing design system. No new fixed branding.

## 7. Out of scope

- AI Suggestions, and any write to `ai_suggestions`.
- Voice memos and Storage.
- Expiry processing: `expires_at` stays null, with no default.
- The `active`, `expired` and `superseded` transitions.
- Post-submission revision.
- Discovery, Referral and Request.
- Attorney or staff access to intake data.
- A staff or administration UI for configuration.
- Privacy and help entry points.
- Notices or disclosures.
- Reference-catalog writes.
- Any Staging, Production or OLD operation, including publishing `intake-questions-v1` anywhere persistent.
- Registration and identity changes.
- Dependencies.
- Control paths.
- Schema-drift baseline and release records.
- Payments, scheduling, regulatory, branding or provider work.

## 8. Invariants

1. Intakes, revisions and published versions are never updated or deleted. Content changes only by a new revision
   (DM §6).
2. Only the owning client reads or writes their intake data. No API role or service credential writes the three
   intake relations directly.
3. Stale or concurrent writes never displace newer content. Lifecycle operations are serialized and atomic with their
   audit evidence.
4. Answers are always interpreted against their governing version. A client cannot cite an unauthorized version.
5. Category and jurisdiction remain client statements and suggestions, never legal conclusions, eligibility or
   attorney selection. `practice_areas`, `jurisdictions` and `jurisdiction_assessments` keep canonical ownership.
6. No intake content appears in audit records, logs, errors or test output.
7. No hard-coded question, limit, launch jurisdiction, counsel-gated value or notice text.
8. Historical migrations stay byte-identical. The migration applies on a fresh database and on the current
   15-migration schema.

## 9. Impact

| Area | Impact |
|---|---|
| Database | Two new relations (PS-A1); the functions in §3.3; one capability-catalog row; narrowed privileges on two relations; audit inserts |
| RLS | Own-client SELECT on revisions; authenticated SELECT on published versions; no write policy |
| Provider | none |
| Security | The client write boundary and the configuration publication boundary. The PR gets a detailed "Security / integrity" section (UOM §8) |

## 10. Acceptance criteria

1. **Full client flow.** With `intake-questions-v1` published in a disposable database, a client creates, saves
   (several revisions), submits and closes an Intake through the UI. Every saved revision survives reload, a new
   session, a rejected save and a closed tab.
2. **Submission.** Submitted content is frozen and shown as submitted. Stated jurisdictions appear as unreviewed
   suggestions with their basis, and Not sure or several jurisdictions are shown as unresolved.
3. **Configuration change without code.** Publishing a second version changes the questions shown for new drafts with
   no code change. An existing draft keeps its governing version until the client switches, and can be submitted under
   it.
4. **Exact v1 bytes.** A test fixture holds the exact §4 definition, and the proof asserts
   `sha256(definition::text)` equals the §4 value after publication.
5. **Final-head checks.** All §11 checks pass on the final head, and the guard self-check prints `ROSUNO-GUARD PASS`.
6. **Register entries.** The migration is registered as `reviewed: false`, `applied_environment: none`,
   `non_production_validation: true` and `release_refs: []`. The work item, decision and PS-A1 authority reference are
   registered. No persistent environment is touched.

## 11. Tests and commands

### Failure tests (disposable PostgreSQL, `apps/web/tests/p5-001-db-proof.mjs`)

**Isolation and privileges:**
- Client B cannot read or act on client A's Intakes. A foreign Intake and a non-existent Intake give the same outcome.
- `anon`, attorney-only and staff-only principals are denied every client function.
- `service_role` and `authenticated` cannot write `intakes`, `jurisdiction_assessments`, `intake_revisions` or
  `intake_question_sets`.
- Helper functions are unexecutable by API roles.

**Immutability:** UPDATE and DELETE on both new relations fail for every role.

**Principal state:** an inactive or suspended User, an unconfirmed email, or a missing Client Profile is denied.

**Concurrency:**
- Equal `expected_revision` saves: exactly one succeeds.
- Save against submit, and save against close, are serialized.
- Rate limits are exact under concurrent saves.
- Two concurrent publications get distinct, ordered `published_at` values.
- Deterministic interleavings are observed through `pg_locks`.

**Validation:**
- every format rule in §3.6 is rejected when broken;
- unknown version and non-allowed older version are rejected;
- required-question bypass at submit is rejected;
- an unchanged save is rejected;
- a deactivated practice area is refused for new selection and at submit (`needs_update`), while history stays
  readable;
- a renamed catalog row leaves the stored revision unchanged;
- a reused question id with a different kind is rejected at publication.

**Practice-area answers** (each run under `intake-questions-v1` and, where stated, under test-only versions published
in the disposable database):
- **"Not sure" submits.** A required practice-area question answered "Not sure" (`practice_area_id` null, answer
  `"not_sure"`) submits with `submitted`. The submitted revision keeps exactly that state, and no `ai_suggestions` row
  or category-derived record is created. The only new assessments are those for stated jurisdictions.
- **Unanswered is incomplete.** A required practice-area question left unanswered (neither present) returns
  `incomplete`.
- **Both present is invalid.** A save with both a selected practice area and `"not_sure"` returns `invalid`, and
  nothing is stored.
- **Optional may be skipped.** In a test version with an optional practice-area question, leaving it unanswered
  submits.
- **No practice-area question.** In a test version without a practice-area question, a save with a practice area or a
  `"not_sure"` answer returns `invalid`, and submission succeeds without either.
- **Deactivated selection is recoverable.** A selected practice area deactivated after saving returns `needs_update`
  at submit. A new revision answering "Not sure" then submits, and the earlier revision is unchanged.

**Publication authority:**
- no grant, an expired grant, a revoked grant, a jurisdiction-scoped grant, or an inactive staff User:
  `forbidden`;
- a successful publication writes exactly one audit event, with the digest.

**Historical meaning:** after a new version is published, earlier revisions still validate against their own version.

**Atomicity:** an injected audit failure rolls back every operation.

**Migrations:**
- historical migrations are byte-checked;
- the migration applies on a fresh database and on the 15-migration schema;
- a rollback-only transaction restores the exact prior catalog fingerprint.

**Regression:**
- `m4-db-proof.mjs` and `p3-904-db-proof.mjs` are re-pinned to verify the 15-migration prefix byte-for-byte and then
  apply the later registered migrations;
- every existing assertion is kept.

**Application tests:** use cases, generic definition validator, outcome mapping, route access and wording rules.

### Commands
- the repository baseline: `pnpm install --frozen-lockfile`, `pnpm run format:check`, `pnpm run typecheck`,
  `pnpm run build`, `pnpm run p0:validate`, `pnpm run p0:test`, `pnpm run secrets:check`,
  `pnpm run dependency:check`;
- the disposable proofs: `node apps/web/tests/p5-001-db-proof.mjs`, `node apps/web/tests/p3-904-db-proof.mjs`,
  `node apps/web/tests/m4-db-proof.mjs`, `node apps/web/tests/registration-abuse-db-proof.mjs`;
- the guard self-check:
  `bash .github/scripts/rosuno-guard.sh <owner main SHA> HEAD wi/P5-001-client-intake-foundation refs/rosuno/approved`.

## 12. Observability, rollback, M5 status and stop conditions

- **Observability:**
  - audit events (§3.4);
  - fixed outcome codes;
  - unreadable states surface as "unavailable";
  - no content, identifiers or provider detail in logs (DL-ENG-1 R11).
- **Rollback, before merge:** forward commits on the branch.
- **Rollback, after merge:**
  - a forward corrective migration only;
  - no revision, version, assessment or audit row is removed;
  - persistent application waits for the PS-A1 Lock Condition and a separate owner database authorization, with
    rollback-only Staging validation by default.
- **P5-001 is not M5 completion.** These remain outstanding M5 obligations:
  - AI Suggestions;
  - voice memos and Storage;
  - privacy and help surfaces;
  - counsel-gated intake notices and disclosures (REG-CA-035);
  - attorney-decline and referral retry verification (with M7, M8 and M10);
  - the remaining MBS §8 criteria.

  Production intake collection stays disabled while REG-CA-035 is unresolved.
- **Stop (Class B or C)** on any of the following:
  - a question, choice, kind or behaviour beyond §§3–4;
  - intake data shown to attorneys or staff;
  - notice, disclosure or privacy text;
  - a relation, column or immutability change beyond PS-A1;
  - a counsel- or regulator-gated value;
  - catalog or configuration data written to a persistent environment;
  - an identity, registration or security-shell change;
  - a historical-migration difference;
  - unexplained drift;
  - any persistent-environment operation;
  - a dependency change;
  - an acceptance criterion that cannot be proven.
- **Output:** the CLAUDE.md report, listing the M5 obligations above as limitations.
