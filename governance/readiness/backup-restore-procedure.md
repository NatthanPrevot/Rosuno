# Non-production backup and restore procedure (MVP-001)

The operator procedure for a non-production backup and restore drill of the Rosuno database (Packet S11; IMP §29
backup and recovery verification; IMP §35, tested from a clean environment). It has two parts:

- **Local drill.** The explicit-run proof `apps/web/tests/mvp-001-s11-restore-proof.mjs` (committed in the S11 PR) on
  a disposable local PostgreSQL 16 cluster with synthetic data only. By the Packet §5 definitions this is disposable-database evidence
  (the L2 kind). Any operator can repeat it.
- **Hosted drill (L6, HOLD).** The same verification against a hosted non-production project. **Hosted backup and
  restore on the platform is L6 and is on HOLD** (Packet rule 14): it needs the owner's explicit authorization naming
  the operation and the target, and until then this document only lists its steps. No hosted drill has been run.

A drill never touches Production, never uses the retired (OLD) Supabase project and never restores into a project
that serves users. The only earlier restore evidence is P0-level: `governance/evidence/p0-restore-validation.json`
(2026-08-28; one migration; a non-production restore between two projects).

## 1. Prerequisites

| Item                | Local drill                                                                                      | Hosted drill (L6, HOLD)                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Authorization       | The work item                                                                                    | The owner's explicit word naming the operation and the target project              |
| Tools               | Node.js (CI declares Node 24); PostgreSQL 16 `initdb`, `pg_ctl`, `psql`, `pg_dump`, `pg_restore` | The platform's backup or point-in-time recovery; `psql` access to the drill target |
| Data                | Synthetic only, created by the proof (addresses on the reserved `.invalid` domain)               | Non-production only; reading real rows needs separate authorization                |
| Network             | None (Unix socket only; TCP disabled)                                                            | The configured project network only                                                |
| Confidential values | None                                                                                             | Held by the platform; never copied into files, logs or evidence                    |
| Migration set       | `supabase/migrations` at the commit under test                                                   | The same migration history as the commit under test                                |

## 2. Backup

1. Record the commit SHA, the migration count, the last migration id and the migration-set SHA-256 (the proof reports
   all four under `migrations`).
2. Record the source's environment class from `deployment_environment_identity()`. Record only whether a project
   reference is present; never write the reference into evidence.
3. Take the backup:
   - local: `pg_dump --format=custom` of the whole database, keeping owners and privileges; the proof reports the
     file's SHA-256, its size and its table-of-contents, table-data and ACL entry counts;
   - hosted: the platform backup or a point-in-time recovery point; record its timestamp and whether it is scheduled
     or on-demand, never a download URL.
4. Keep a local dump only inside the drill's mode-0700 temporary directory and delete it with the drill. Never commit
   a dump or attach one to a pull request or issue.

## 3. Restore target selection: the environment-record rule

The `deployment_environment` record (PS-A2) is part of the data and is immutable for every role. **A restored database
carries its source's immutable environment record** (class and project reference). The proof shows the effect:

| Restored record | A request with the target project's JWT | A session without JWT claims (owner, scheduled job, worker) |
| --------------- | --------------------------------------- | ----------------------------------------------------------- |
| `development`   | `environment_mismatch`; fails closed    | `ok`; development configuration selectable                  |
| `production`    | `environment_mismatch`; fails closed    | `ok`; runs as production in the wrong project               |

The record can be neither recorded again nor corrected in place (`record_deployment_environment` and `UPDATE` both
refuse with SQLSTATE 55000; creating development configuration in the restored production-class database refuses
with 23514). Rules:

1. **No cross-class restore.** Restore only into a target of the same environment class as the source. A Production
   backup is never restored into Staging or Development, and a Development backup is never restored into a hosted
   project. If the classes differ, refuse the restore and escalate (section 7).
2. Never disable triggers on `deployment_environment`, never delete or rewrite its row and never record it again to
   make a restore fit. Each of these is a Class C event.
3. **Jobs stay stopped until the record is checked.** Keep `pg_cron` schedules and workers on the target stopped until
   V4 and V9 (section 4) have passed, because sessions without claims are not bound by the issuer check.
4. Create a local target empty (`template0`) and confirm it has no user relations before the restore (the proof
   asserts `target_relations_before: 0`).

## 4. Restore and verification

Restore with `pg_restore` into the empty target. Record the exit status and every error or warning line; a non-zero
exit or any error line fails the drill. Then run the checks below; each maps to the proof report.

| Check | What                                                                                                                                                                                                                                                                                               | Report field / proof check                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| V1    | `pg_restore` exits 0 with no error lines                                                                                                                                                                                                                                                           | "pg_restore completes without errors"                                                                        |
| V2    | The catalog fingerprint is equal: functions (identity arguments, source digest, security definer, settings, ACL), relations (row level security enabled and forced, ACL, owner), columns, constraints, indexes, triggers, row policies, default privileges, sequences, types, extensions, comments | "catalog fingerprint of the restore equals the source"                                                       |
| V3    | Row count and content digest of every table are equal                                                                                                                                                                                                                                              | "row counts and content digests of every table are equal"                                                    |
| V4    | The environment record is identical (id, class, reference, creation instant)                                                                                                                                                                                                                       | "the deployment_environment record is restored unchanged"                                                    |
| V5    | The immutable guards refuse: an `audit_events` update or delete; a `deployment_environment` update, delete, truncate, second recording or second row; a change to or deletion of a development policy version                                                                                      | "behavioural checks on the restore hold and equal the source"                                                |
| V6    | A security definer predicate run as `authenticated` with a JWT subject and `aal` claim: true at aal2, false at aal1 and for another user, refused for `anon`                                                                                                                                       | `behaviour.restore.staff_capability_*`                                                                       |
| V7    | `anon` cannot read protected relations; an authenticated client sees only its own user row and no audit events                                                                                                                                                                                     | `behaviour.restore.anon_reads`, `behaviour.restore.authenticated_client_*`                                   |
| V8    | The checks changed no data                                                                                                                                                                                                                                                                         | "the restore still carries no data change from the checks"                                                   |
| V9    | The binding check as the application sees it: identity, status with and without a JWT issuer, resolver outcome                                                                                                                                                                                     | "environment-record hazard: the restore keeps the source class and the binding check fails closed elsewhere" |

The fingerprint compares representations normalized in three documented ways, none of which changes behaviour: ACLs
are compared as effective ACLs (an explicit owner-only ACL restores as the equivalent default; raw counts are kept in
`comparison.raw_acl_representation`); columns are compared by ordinal position (a restore closes the gaps dropped
columns leave); a CHECK constraint whose text differs is re-parsed on the source and passes only if the re-parsed text
equals the restore's text exactly (each listed under `reparsed_check_constraints`).

On a hosted target, run V1 to V9 with the same queries, through a role that has no business-data write path, inside
transactions that are rolled back.

## 5. Hosted-only checks (L6, HOLD)

`pg_dump` does not cover the following in a hosted project. Each is a step of the hosted drill (ARCH-F18).

- **Storage objects.** Object rows and object bytes are separate. Compare the bucket list, the object-row count and a
  sample of object checksums with the source evidence; an orphan on either side fails the drill.
- **Identity data (Auth schema).** Platform-owned. Restore it only through the platform backup or point-in-time
  recovery; then check the auth user count and that every `public.users.auth_user_id` resolves.
- **`pg_cron` schedules.** Check that the extension exists and that the five schedules the migrations register (job,
  Intake expiry, scheduling expiry, request expiry and media sweeps) are present once each; keep them suspended while
  the target holds restored data. The S11 operations summary reports which are registered and active
  (`supabase/migrations/20261127100000_mvp_001_s11_operations_dashboard.sql` header).
- **Platform-held confidential values.** Check by name only, never by value, that each needed value is present;
  re-provision through the platform, never from a dump.
- **Provider-side state.** Payment, media, email, identity-provider, webhook and function settings live outside the
  database. Point the target at provider sandboxes only and confirm no webhook or redirect reaches a production
  provider.
- **Roles and project settings.** Check that the API roles exist and that the API exposes only the expected schemas
  before any request reaches the restored data.
- **Environment record.** Apply section 3 before the restore, and V4 and V9 after it.

## 6. What the local proof verifies

The proof applies every migration unmodified, each in one transaction, to a disposable cluster; plants a synthetic
development-class state (identity users, users, a client, an Intake, an attorney, two staff members, a capability
grant, a jurisdiction, two development policy versions and the environment-recording audit event); takes a custom
dump; restores it into an empty database created from `template0`; and runs V1 to V9. It then records a
production-class source, backs it up and restores it, and shows that the restored record keeps its class, that it
cannot be recorded again or corrected, and that development configuration cannot be created there. It uses port 54350,
TCP disabled, and an unprivileged cluster account, and it removes the cluster and its directory at the end.

## 7. Evidence

Record a dated summary under `governance/evidence/` in the same pull request as the work it supports: the date, the
commit, the drill type (local, or hosted L6 when authorized) and the operator role (not a personal account); the
migration count, last migration and migration-set SHA-256; the backup SHA-256 and size (local) or the backup
timestamp and class (hosted); the restore exit status and error-line count; PASS or FAIL for V1 to V9 with the catalog
category counts, the overall fingerprint SHA-256 and the total row count; the hosted-only steps marked performed or
not performed; timings and the number of runs. Never record project references, URLs, keys, connection strings,
account names, real data or a review that did not happen. Within one commit the catalog fingerprint is deterministic;
the backup SHA-256 and row digests change on every run because synthetic identifiers and instants are new each time.

### Recorded runs

The run facts below are recorded by the Builder (the report documents stay outside the repository). The three
earliest runs were made with the proof before it was committed, from the Builder's working copy; their dates are the
file dates (UTC) of their report documents. The four later runs carry the start instant the Builder recorded. A cell
with a dash was not recorded for that run.

| Run                                        | Date                         | Migrations                                     | Migration-set SHA-256 (prefix) | Catalog (functions / relations / columns / constraints / indexes / triggers / policies) | Overall fingerprint (prefix) | Rows (tables) | Backup size (bytes) | Checks   | Result | Total time |
| ------------------------------------------ | ---------------------------- | ---------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------- | ------------- | ------------------- | -------- | ------ | ---------- |
| 1 (repository root override)               | 2026-11-20                   | 61, last `20261127070000` (S11 pass 1)         | `d78d13eeec7b`                 | 442 / 68 / 647 / 588 / 192 / 169 / 47                                                   | `cd2684ad21e5`               | 47 (68)       | 1,751,980           | 7/7 PASS | PASS   | 6,338 ms   |
| 2 (repository root override)               | 2026-11-20                   | 61, last `20261127070000`                      | `d78d13eeec7b`                 | same as run 1                                                                           | `cd2684ad21e5`               | 47 (68)       | 1,751,983           | 7/7 PASS | PASS   | 6,076 ms   |
| 3 (root from the script's future location) | 2026-11-20                   | 61, last `20261127070000`                      | `d78d13eeec7b`                 | same as run 1                                                                           | `cd2684ad21e5`               | 47 (68)       | 1,751,976           | 7/7 PASS | PASS   | 6,507 ms   |
| 4 (at `e6d45c6`)                           | started 2026-11-22T17:10:56Z | 71, last `20261127170000` (S11 pass 2B)        | `b8e072367e76`                 | 477 / 68 / 647 / 588 / 192 / 171 / 47                                                   | `a4b5651f6635`               | 51 (68)       | 1,850,086           | 7/7 PASS | PASS   | 6,050 ms   |
| 5 (at `5283fda`)                           | started 2026-11-22T19:04:02Z | 72, last `20261127180000` (review corrections) | `209ec267a110`                 | 478 / 68 / 647 / 588 / 192 / 171 / 47                                                   | `185c9c9a3e97`               | 51 (68)       | 1,859,183           | 7/7 PASS | PASS   | 5,151 ms   |
| 6 (at `d9d1151`)                           | started 2026-11-23T00:07:05Z | 76, last `20261127220000` (S6 correction)      | `dede44cbe2ae`                 | 501 / 70 / 672 / 606 / 200 / 176 / 47                                                   | `7264fe266200`               | 54 (70)       | 1,936,508           | 7/7 PASS | PASS   | 4,904 ms   |
| 7, final (at `2a1b94f`)                    | started 2026-11-23T00:46:26Z | 76, last `20261127220000` (S6 correction)      | `e652545f9f5c`                 | 501 / 70 / 672 / 606 / 200 / 176 / 47                                                   | `3d16f951e772`               | 54 (70)       | 1,938,795           | 7/7 PASS | PASS   | 5,516 ms   |

Run 7, the final run (at `2a1b94f`, the final migration set: migration `20261127200000` corrected in place after run 6),
used PostgreSQL 16.15; `pg_restore` exited 0 with no error lines; its custom-format dump has SHA-256
`e8fce4bc29113e0da5add8da32d710e1cf461ba8b88c014d545229ea350d7a56` and 2,378 table-of-contents entries; its environment
class `development` was restored unchanged and the environment-record hazard check passed; the cluster was removed.
Its full migration-set SHA-256 is `e652545f9f5c605a50bbc7a912db0bd69986992b411e8b270e4ca45d8256e9b9` and its full
overall fingerprint `3d16f951e7727621d075a5005134758c658638aa114afc34256350958657d6b6`. Run 6 (at `d9d1151`, the 76
migrations including PS-A6 and the S6 offered-start correction) used
PostgreSQL 16.15; `pg_restore` exited 0 with no error lines; its custom-format dump has SHA-256 prefix `a9411351bd0f`
and 2,378 table-of-contents entries; its environment class `development` was restored unchanged and the
environment-record hazard check passed. Its full migration-set SHA-256 is
`dede44cbe2ae7ea6ff46b9370d1a190cf16807e0d9f2b96a31c56623d0d4389c` and its full overall fingerprint
`7264fe266200f7fa706218a3888e0723152608939cc46563e16fb5f834e2a154`. Run 5 (at `5283fda`):
dump SHA-256 prefix `3ce53134ae47`, 2,274 table-of-contents entries, environment class `development` restored
unchanged, the hazard check passed, full migration-set SHA-256
`209ec267a110bd19b2306ae754e07f9148b9b80d656a9045abd2d0a2e73f10bd`. In the three earliest runs: PostgreSQL 16.15;
`pg_restore` exit 0 with no error lines; the target had 0 relations before the restore; two CHECK constraints were
re-parsed (`messages_body_v1_check`, `reviews_text_v1_check`); the behaviour on the restore equalled the source. In
every run the hosted-only steps were not performed (L6, HOLD).

## 8. Rollback and escalation

- **Local:** the proof always stops the cluster and removes its directory (exit 2 when that fails). A failed run
  leaves nothing to roll back. Report the failing check and re-run once; a repeated failure is a Class A defect when
  the harness causes it, otherwise it is escalated to the owner.
- **Hosted (L6):** the drill target is disposable. If a check fails, stop all jobs on it, record the failure and ask
  the owner whether to discard the target. Never "repair" restored data or the environment record.
- **Stop and escalate (Class B or C)** when the source and target classes differ, V4 fails, a hosted restore would
  touch Production or the retired project, a confidential value or a real identifier would appear in the evidence, or
  the target's migration history differs from the commit under test.
- A migration defect found by a drill is corrected only with a new forward-only migration under its own work item.
  An applied migration is never edited.
