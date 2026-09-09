# Rosuno Implementation Controls

This directory contains the accepted P0 controls and bounded P1 implementation evidence. Locked external artifacts define Rosuno; repository records may only trace and implement an authorized slice.

## Scope and authority

- The locked P0-001 requirement set remains the authority. This repository stores references to it only; it does not copy, amend, or reinterpret locked text.
- Every decision, bounded work item, release record, and reviewed migration must link to an authority reference and its supporting evidence.
- Unknown human reviewer identity remains an explicit external dependency unless verified review evidence exists. P1-001 and P1-003 record verified Rosuno approvals; an identity must never be silently invented.

## Control map

| Area              | Local control                                                                                                                  | External dependency                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Branches          | `main` is the integration branch; release branches are created only for a traced release                                       | GitHub protected-branch/ruleset configuration      |
| Pull requests     | The PR template requires scope, authority, work item, validation, release, migration, and rollback evidence                    | GitHub required review and required-check rules    |
| Ownership         | `CODEOWNERS` names the repository owner, `@NatthanPrevot`, as the owner of repository content                                  | Reviewer state remains explicit per bounded record |
| Commits           | One logical P0 change per commit; commit messages reference a bounded work item                                                | Remote merge enforcement                           |
| Traceability      | Authority → decision → work item → commit/PR → release artifact → migration evidence                                           | Release hosting and PR metadata                    |
| Environments      | Development, staging/test, and production have distinct scopes and no implicit inheritance                                     | Replit/GitHub environment configuration            |
| Secrets           | Values never belong in source, examples, logs, decisions, work items, or release records                                       | Secret store policy and CI secret scanning         |
| Migrations        | The applied P0 control, its inventory-only CLI representation, and all five ordered reviewed Staging migrations are registered | Future protected review and migration execution    |
| Schema drift      | A deterministic source-controlled Rosuno Staging foundation baseline binds exact migration and accepted evidence digests       | Future approved baseline transitions               |
| Releases          | A release is not traceable until all required references and validation evidence exist                                         | Remote release artifact and approval               |
| Rollback/recovery | Every future release records a reversible action and recovery owner/status                                                     | Runtime operator and production controls           |
| Logging           | Structured, minimal, redacted logs are required; credentials and sensitive payloads are prohibited                             | Runtime log sink and retention controls            |
| Provider security | Least privilege, server-side credentials, no raw tokens, and explicit provider ownership are required                          | Provider account and scope configuration           |

## Branch and pull-request controls

`main` is the integration branch and `release` is protected. Neither may be used to bypass review.

A pull request is complete only when it identifies one bounded work item, lists the authority references and decisions, describes the exact logical commits, reports all local validations, records environment scope, states migration and drift impact, includes rollback/recovery information, and contains no secret values. The designated human reviewer is unresolved until an external repository administrator assigns one.

## Logical commits and traceability

Commit messages should use `P0-<work-item-id>: <single logical change>`. A change may not combine unrelated controls. The traceability chain is:

```text
locked authority reference
  → decision record
  → bounded work item
  → logical commit and pull request
  → release artifact
  → reviewed migration/drift evidence
  → validation evidence
```

## Environment and secrets boundary

The examples under `governance/environments/` contain placeholders only. Development, staging/test, and production are separate scopes. Production may not inherit development or staging values, and no shared secret scope is accepted by the local validator. Secret names may be referenced in metadata; secret values may not appear anywhere in the repository or its logs.

## Migration and schema-drift review

The reviewed-migration register contains the applied P0 security control and the exact five-version P1 foundation history applied only to Rosuno Staging. The original P1-002 SQL and pre-review evidence remain immutable historical records, while current lifecycle evidence records PR #4 implementation approval and merge, persistent Staging application, PR #6 validation-evidence approval and merge, later defect discovery, the PR #10 forward-only correction, and PR #11 closure. P1-003 and the P1-002 correction evidence bind the preserved jurisdiction contract, corrected catalog fingerprint, zero relevant rows, restricted grants, approved default-deny INFO findings, tooling limitations, and unchanged historical migration bytes. Any ordering gap, duplicate, scope expansion, unregistered file, generated history entry, unapproved security finding, or false review/application claim fails local validation.

The baseline under `governance/schema-drift/baseline.json` is the current source-controlled Rosuno Staging foundation manifest. Its digest is recomputed from the Staging identity, exact five migration IDs and artifact digests, accepted P1-003 and P1-002 correction evidence digests, and corrected V2 catalog fingerprint. An empty product-schema baseline, missing Staging evidence, mismatched identity or digest, or migration inventory contradiction fails local validation.

The P0 CLI migration file is an inventory representation of the already-applied historical Staging row. It was sourced from one read-only stored statement, does not authorize replay, and does not represent a remote history or schema mutation.

## Release, rollback, and recovery

The P0 security-control record and four bounded P1 Staging application records are present; none represents a production release or repository deployment. A traceability artifact must include its immutable commit, bounded work items, decisions, migration references, validation evidence, artifact digest, environment, reviewer state, rollback reference, and recovery evidence. Rollback is a controlled action with an explicit trigger, last-known-good reference, owner, verification, and recovery path.

## Logging and provider security

Logs must be structured and minimal. Never log secrets, authorization headers, raw provider responses containing credentials, or sensitive payloads. Provider access must be server-side, least-privileged, scoped to the environment, auditable, and revocable. No provider workflow is implemented by this foundation.

## Enforcement status

The local artifacts, schemas, validators, tests, formatting, type checking, build check, secret scan, and dependency audit are intended to be executable controls. GitHub branch protection, required CI checks, required human approval, and remote CODEOWNERS enforcement remain external dependencies. Supabase non-production backup/restore execution also remains external; the repository intentionally creates no resource, schema, or data for it.
