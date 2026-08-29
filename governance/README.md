# Rosuno Implementation Controls

This directory contains the accepted P0 controls and bounded P1 implementation evidence. Locked external artifacts define Rosuno; repository records may only trace and implement an authorized slice.

## Scope and authority

- The locked P0-001 requirement set remains the authority. This repository stores references to it only; it does not copy, amend, or reinterpret locked text.
- Every decision, bounded work item, release record, and reviewed migration must link to an authority reference and its supporting evidence.
- Unknown human reviewer identity remains an explicit external dependency. It must not be silently substituted with an invented person.

## Control map

| Area              | Local control                                                                                               | External dependency                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Branches          | `main` is the integration branch; release branches are created only for a traced release                    | GitHub protected-branch/ruleset configuration             |
| Pull requests     | The PR template requires scope, authority, work item, validation, release, migration, and rollback evidence | GitHub required review and required-check rules           |
| Ownership         | `CODEOWNERS` names the repository owner, `@NatthanPrevot`, as the owner of repository content               | A designated human reviewer is still unresolved           |
| Commits           | One logical P0 change per commit; commit messages reference a bounded work item                             | Remote merge enforcement                                  |
| Traceability      | Authority → decision → work item → commit/PR → release artifact → migration evidence                        | Release hosting and PR metadata                           |
| Environments      | Development, staging/test, and production have distinct scopes and no implicit inheritance                  | Replit/GitHub environment configuration                   |
| Secrets           | Values never belong in source, examples, logs, decisions, work items, or release records                    | Secret store policy and CI secret scanning                |
| Migrations        | The applied P0 security control and proposed P1 Migration 1 are ordered and registered                      | Protected human review and persistent migration execution |
| Schema drift      | The baseline stays empty while the P1 migration is rollback-only; drift findings fail validation            | Post-application database introspection                   |
| Releases          | A release is not traceable until all required references and validation evidence exist                      | Remote release artifact and approval                      |
| Rollback/recovery | Every future release records a reversible action and recovery owner/status                                  | Runtime operator and production controls                  |
| Logging           | Structured, minimal, redacted logs are required; credentials and sensitive payloads are prohibited          | Runtime log sink and retention controls                   |
| Provider security | Least privilege, server-side credentials, no raw tokens, and explicit provider ownership are required       | Provider account and scope configuration                  |

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

The reviewed-migration register contains the applied P0 security control and the proposed P1/1A platform migration. The proposed migration is rollback-only validated and remains explicitly unreviewed and unapplied until the protected human gate is completed. Any ordering gap, duplicate, scope expansion, drift item, unregistered file, or false review/application claim fails local validation.

## Release, rollback, and recovery

One P0 security-control traceability record is present; it does not represent a product release or repository deployment. A release artifact must include its immutable commit, bounded work items, decisions, migration references, validation evidence, artifact digest, environment, reviewer state, rollback reference, and recovery evidence. Rollback is a controlled action with an explicit trigger, last-known-good reference, owner, verification, and recovery path.

## Logging and provider security

Logs must be structured and minimal. Never log secrets, authorization headers, raw provider responses containing credentials, or sensitive payloads. Provider access must be server-side, least-privileged, scoped to the environment, auditable, and revocable. No provider workflow is implemented by this foundation.

## Enforcement status

The local artifacts, schemas, validators, tests, formatting, type checking, build check, secret scan, and dependency audit are intended to be executable controls. GitHub branch protection, required CI checks, required human approval, and remote CODEOWNERS enforcement remain external dependencies. Supabase non-production backup/restore execution also remains external; the repository intentionally creates no resource, schema, or data for it.
