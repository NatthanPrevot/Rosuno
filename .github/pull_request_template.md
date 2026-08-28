## P0 change record

- Bounded work item: `WI-`
- Decision records: `DEC-` or `none`
- Authority references: `P0-001-LOCKED`
- Logical commit scope: one control change only

## Scope

- [ ] This change is P0-only.
- [ ] Product, domain, schema, UI, auth, provider workflow, demo, and P1 work are absent.
- [ ] Out-of-scope items are explicitly listed below.

In scope:

Out of scope:

## Control evidence

- Environment: `development` / `staging` / `production` / `none`
- Release traceability reference: `REL-` or `none`
- Reviewed migration references: `none` unless explicitly listed
- Schema-drift result: `clean` / `not applicable`
- Rollback reference:
- Recovery owner/status:
- Restore evidence reference: `governance/evidence/p0-restore-validation.json` or `none`
- [ ] CLI event-trigger omission and source-authoritative recovery are recorded.
- [ ] Roles-dump normalization is limited to one statement and both hashes are recorded.
- [ ] ACL/default-privilege limitations, parity, behavior, timing, and cleanup are recorded.

## Validation

```text
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run typecheck
pnpm run build
pnpm run p0:validate
pnpm run p0:test
pnpm run secrets:check
pnpm run dependency:check
```

- [ ] All applicable checks passed.
- [ ] Intentional failure-path tests passed by rejecting invalid inputs.
- [ ] Clean non-production validation was completed or marked externally pending.

## Secrets and providers

- [ ] No secret values, credentials, tokens, or private keys are present in this PR.
- [ ] No provider workflow was added.
- [ ] Any provider-security impact is documented without exposing credentials.

## Review and merge

- [ ] The PR is linked to one bounded work item.
- [ ] The designated reviewer is identified externally or remains explicitly unresolved.
- [ ] Required CI and human approval are enforced by repository settings, or the external dependency is recorded.
- [ ] No direct push or remote rule bypass was used.
