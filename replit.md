# Rosuno

Rosuno is a product-neutral repository for controlled software implementation.

## P0 execution-control foundation

The local P0 foundation lives under `governance/`, with executable checks under `tools/p0/`. It defines repository governance, authority references, bounded decisions and work items, environment and secret boundaries, migration and schema-drift review, release traceability, rollback/recovery, logging, and provider-security controls. It intentionally defines no product behavior or domain model.

## Run & validate

- `pnpm install --frozen-lockfile` — deterministic dependency installation
- `pnpm run format:check` — formatting gate
- `pnpm run typecheck` — TypeScript check with no emitted files
- `pnpm run build` — neutral build gate using the same no-emit check
- `pnpm run p0:validate` — validates all current P0 registers and neutral baselines
- `pnpm run p0:test` — success and intentional failure-path control tests
- `pnpm run secrets:check` — tracked-file secret scan
- `pnpm run dependency:check` — high-severity dependency audit

## Enforcement boundary

Local validation is executable here. Remote GitHub protected-branch/ruleset enforcement, required CI checks, required human approval, and the identity of a designated reviewer remain external dependencies. No remote setting is configured by this repository change. Supabase non-production restore execution also remains external; no resource, product schema, or data is created.

## Product boundary

There is no application source, UI, authentication, provider workflow, product schema, business table, product migration, demo data, or production deployment in this repository. The workspace package list remains empty and runtime dependencies remain absent.
