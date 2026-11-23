# Release-artifact and migration traceability procedure (IMP §8)

How a change in this repository is traced from its commit to an environment and back to a rollback reference, who
performs each step, and how `pnpm run p0:validate` enforces the links. It describes the procedure as it works now; it
authorizes no application, release or deployment. State: the S11 head `5283fda`; section 5 also records `2a1b94f`.

## 1. The chain

```text
commit (immutable SHA on owner main)
  → migration register   governance/migrations/reviewed-migrations.json   one entry per migration file
  → release record       governance/releases/traceability.json            links commit, work items, decisions, migrations
  → artifact digest      sha256 of the applied artifact, in the release record
  → environment          staging | production | unclassified external project, in the release record
  → drift baseline       governance/schema-drift/baseline.json            the environment's migration inventory and catalog fingerprint
  → rollback reference   in the release record and in each migration's rollback plan
```

Supporting records: the authority references (`governance/authority-references.json`), the Decision Log
(`governance/decision-log.json`), the work items (`governance/work-items/index.json`) and dated evidence under
`governance/evidence/`.

## 2. Steps and who performs them

| Step                             | What happens                                                                                                                                                                                                                                                                                                                      | Who                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1. Migration written             | A new forward-only file under `supabase/migrations/` with a register entry: `reviewed: false`, `reviewed_by: "pending designated human PR review"`, `reviewed_at: null`, `applied_environment: "none"`, no release reference, a dependency on its predecessor, a rollback plan; listed in the owning work item's `migration_refs` | Builder, under an adopted Packet                                           |
| 2. Validation                    | L1 suite, every L2 proof (each proof checks the migration order and registration), `p0:validate`, the guard self-check                                                                                                                                                                                                            | Builder                                                                    |
| 3. Publication and pull request  | `git push` of the work-item branch; the pull request                                                                                                                                                                                                                                                                              | Owner gate (publication and PR creation only on the owner's word)          |
| 4. Designated approval and merge | Designated human approval of the exact head; merge into owner `main`                                                                                                                                                                                                                                                              | Owner (never the Builder)                                                  |
| 5. Application to Staging        | Rollback-only validation, then application of the merged migrations to Staging, in a separate owner-authorized session                                                                                                                                                                                                            | Owner authorization; the authorized session                                |
| 6. Records of the application    | Register entries become `reviewed: true` with reviewer and time and `applied_environment: "staging"` and a release reference; a release record (commit, work items, decisions, migrations, validation evidence, artifact digest, environment, reviewer, rollback reference, creation time); a new drift baseline; dated evidence  | Builder records the facts the owner and the session supply; owner confirms |
| 7. Production                    | Only through the locked release procedure; outside this Program (M15)                                                                                                                                                                                                                                                             | Owner                                                                      |

## 3. How `p0:validate` enforces it

`pnpm run p0:validate` runs `validateRepository` (`tools/p0/lib/controls.mjs:8618`). The traceability rules:

- **Register and files match exactly.** Every migration file has exactly one register entry and every entry resolves
  to one file; order, uniqueness and dependencies are checked (`validateMigrationRegister`, `controls.mjs:5673`;
  inventory comparison at `:5948–5954`).
- **Unreviewed means unapplied.** A product migration with `reviewed: false` must have the pending reviewer text, no
  review time, `applied_environment: "none"` and no release reference; "a reviewed or persistently applied migration
  may not remain pending" (`:5825–5836`). A reviewed migration needs at least one release reference (`:5930–5935`).
- **Bidirectional release links.** Every release a migration names must list that migration, and every migration a
  release lists must name that release (`validateTraceabilityConsistency`, `:6910`).
- **Release records.** A full 40-character commit SHA that resolves in the local repository, a `sha256:` artifact
  digest, an environment of `staging`, `production` or an unclassified external project, work items, decisions,
  validation evidence and a reviewer; no secret-like value (`validateReleaseRegister`, `:6845`).
- **Ownership.** Each appended migration is listed by every work item it names, and each decision it names names an
  owning work item (`validateAppendedMigrationTraceability`, `:5639`).
- **Drift baseline.** The baseline's identity, migration inventory, accepted evidence digests and catalog fingerprint
  are recomputed into its digest and checked against the register (`validateDriftReport`, `:5957`).

## 4. What "the tested artifact" means here

The application's tested artifact is the production build of a commit. Two values are read when the build
configuration loads (`apps/web/next.config.ts:58–59`: the project origin for `media-src` and the media provider label
for `frame-src`), and public settings with the `NEXT_PUBLIC_` prefix are inlined at build time. A build made for one
environment can therefore carry that environment's origins. Whether the hosting platform fixes the header table at
build time or evaluates it at start has not been verified (ARCH-F17; L6, HOLD). Until it is, a release record for the
application must name the commit **and** the environment the build was made for, and a build is promoted only to the
environment it was built for. The database artifact is the exact migration file set at the commit
(`apps/web/tests/mvp-001-s11-restore-proof.mjs` reports its SHA-256; see `backup-restore-procedure.md`).

## 5. Current state at `5283fda` and `2a1b94f`

| Record                                    | State                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration register                        | 72 entries, one per migration file. Sequence 1 (P0 security control): reviewed, applied to an unclassified external project. Sequences 2–15 (P1-001 … P1-011, P2-007, P3-904): reviewed and applied to Staging. Sequences 16–72 (P5-001 and the 56 MVP-001 migrations, S1–S11): `reviewed: false`, `applied_environment: "none"`                                                                                      |
| S11 migrations                            | Sequences 55–72 (`20261127010000`–`20261127180000`, 18 files), all `reviewed: false`, `applied_environment: "none"` (S11 MIG-1; operations MIG-1, SURF-0, CORR-0)                                                                                                                                                                                                                                                     |
| S11 migrations at `2a1b94f`               | 76 register entries; sequences 16–76 (P5-001 and 60 MVP-001 migrations) unreviewed. S11: sequences 55–76 (22 files). Sequences 73–76 (`20261127190000`–`20261127220000`: break-glass, data requests, complaint configuration, the S6 offered-start correction), each depending on the one before it, are `reviewed: false`, `applied_environment: "none"`, with no release reference (ps-a6 MIG-1; S6 MIG-1)          |
| PS-A6 authority                           | Authority register `PHYSICAL-SPECIFICATION-AMENDMENT-PS-A6-LOCKED` (`pending_lock_condition`) and Decision Log `DEC-20261122-PS-A6-BREAK-GLASS-DATA-REQUESTS-COMPLAINTS` (`a3f6ddc`); register entries 73–75 cite both. Persistent application of migrations 73–76 needs the completed Lock Condition and a separate database authorization (`outstanding-items.md`, section 6)                                       |
| Release register                          | 15 records: one unclassified external P0 record and 14 Staging application records, the last `REL-20261114-P3-904-STAGING-APPLICATION` (created 2026-11-14T14:51:22Z). No production record. Unchanged at `2a1b94f`                                                                                                                                                                                                   |
| Drift baseline                            | `rosuno-staging-p3-904-20261114-v1`: 15 migrations, 13 accepted evidence files, `drift_status: clean` (checked 2026-11-14); unchanged at `2a1b94f`                                                                                                                                                                                                                                                                    |
| Staging application of MVP-001 migrations | The register and the Decision Log record no MVP-001 migration as applied to any persistent environment; Staging application of the later slices is handled by a separate owner-authorized session, whose facts are then recorded through step 6                                                                                                                                                                       |
| Register sequence 16 (P5-001)             | `reviewed: false` / `none`, while `governance/evidence/mvp-001-s1-staging-reconciliation.json` records it as applied on Staging. Correcting the entry needs the owner's approval and application facts (Packet REC-1); until then the drift baseline stays at 15                                                                                                                                                      |
| Designated approval facts                 | Not supplied for S1–S5 (recorded as pending); reviewer stated by the owner and time not supplied for S6–S10 (Decision Log, `DEC-20261117-MVP-001-TECHNICAL-COMPLETION-PROGRAM`). The entry's review line and the work item's scope, S11 acceptance criteria and validation commands were corrected by the Builder (the work item at `5283fda`, the Decision Log line in the working tree), pending owner confirmation |

**State after the MVP-001 records update (2026-11-23).** The table above is the state at `5283fda` and `2a1b94f`. Since the records update: the register records sequences 2–76 as reviewed and applied to Staging (16: P5-001; 17–76: MVP-001 S1–S11); the release register holds 17 records, adding `REL-20261115-20261116-P5-001-STAGING-APPLICATION` and `REL-20261123-MVP-001-S1-S11-STAGING-APPLICATION`; the drift baseline is `rosuno-staging-mvp-001-s11-20261123-v1` (76 migrations, 15 accepted evidence files, `drift_status: clean`, checked 2026-11-23T13:35:17Z); PS-A6 is `active`; the designated approval facts for PRs #95–#106 are recorded.

## 6. Rollback references

Every register entry carries a rollback plan; for MVP-001 migrations it reads, in substance, "before merge:
forward-only correction commits on the Program branch; after merge: a separately reviewed forward corrective
migration", with the rows the correction must never remove. A release record carries the same reference for its
environment. `governance/rollback-recovery.md` lists what a release record must identify for rollback. An applied
migration is never edited; a historical migration is never modified, deleted or renamed.
