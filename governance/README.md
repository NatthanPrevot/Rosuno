# Rosuno P0 Execution-Control Foundation

This directory contains local, product-neutral controls for controlled software implementation. It does not define a product, domain, schema, business table, user workflow, provider workflow, or deployment.

## Scope and authority

- The locked P0-001 requirement set remains the authority. This repository stores references to it only; it does not copy, amend, or reinterpret locked text.
- Every decision, bounded work item, release record, and reviewed migration must link to an authority reference and its supporting evidence.
- Unknown human reviewer identity remains an explicit external dependency. It must not be silently substituted with an invented person.

## Control map

| Area              | Local control                                                                                               | External dependency                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Branches          | `main` is the integration branch; release branches are created only for a traced release                    | GitHub protected-branch/ruleset configuration            |
| Pull requests     | The PR template requires scope, authority, work item, validation, release, migration, and rollback evidence | GitHub required review and required-check rules          |
| Ownership         | `CODEOWNERS` names the repository owner, `@NatthanPrevot`, as the owner of repository content               | A designated human reviewer is still unresolved          |
| Commits           | One logical P0 change per commit; commit messages reference a bounded work item                             | Remote merge enforcement                                 |
| Traceability      | Authority → decision → work item → commit/PR → release artifact → migration evidence                        | Release hosting and PR metadata                          |
| Environments      | Development, staging/test, and production have distinct scopes and no implicit inheritance                  | Replit/GitHub environment configuration                  |
| Secrets           | Values never belong in source, examples, logs, decisions, work items, or release records                    | Secret store policy and CI secret scanning               |
| Migrations        | One already-applied, reviewed P0 security-control migration is recorded; no product migration exists        | Non-production database and reviewed migration execution |
| Schema drift      | A clean, empty baseline is recorded; any drift input fails validation                                       | Database introspection and restore drill                 |
| Releases          | A release is not traceable until all required references and validation evidence exist                      | Remote release artifact and approval                     |
| Rollback/recovery | Every future release records a reversible action and recovery owner/status                                  | Runtime operator and production controls                 |
| Logging           | Structured, minimal, redacted logs are required; credentials and sensitive payloads are prohibited          | Runtime log sink and retention controls                  |
| Provider security | Least privilege, server-side credentials, no raw tokens, and explicit provider ownership are required       | Provider account and scope configuration                 |

## Branch and pull-request controls

`main` is the only current integration branch. No release branch exists in this neutral baseline. A future release branch must be tied to one release record and must not be used to bypass review.

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

This repository has no product schema and no product migrations. The reviewed-migration register contains one already-applied P0 security-control migration and its supplied validation evidence. A migration record must be ordered, reviewed, non-production validated, drift checked, reversible, and linked to its work item, decision, release, and evidence. Any ordering gap, duplicate, drift item, or unreviewed entry fails local validation.

## Release, rollback, and recovery

One P0 security-control traceability record is present; it does not represent a product release or repository deployment. A release artifact must include its immutable commit, bounded work items, decisions, migration references, validation evidence, artifact digest, environment, reviewer state, rollback reference, and recovery evidence. Rollback is a controlled action with an explicit trigger, last-known-good reference, owner, verification, and recovery path.

## Logging and provider security

Logs must be structured and minimal. Never log secrets, authorization headers, raw provider responses containing credentials, or sensitive payloads. Provider access must be server-side, least-privileged, scoped to the environment, auditable, and revocable. No provider workflow is implemented by this foundation.

## Enforcement status

The local artifacts, schemas, validators, tests, formatting, type checking, build check, secret scan, and dependency audit are intended to be executable controls. GitHub branch protection, required CI checks, required human approval, and remote CODEOWNERS enforcement remain external dependencies. Supabase non-production backup/restore execution also remains external; the repository intentionally creates no resource, schema, or data for it.
