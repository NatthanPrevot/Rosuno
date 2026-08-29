# Rosuno

Rosuno is a controlled implementation repository. P0 controls are accepted and P1 work proceeds only through bounded, reviewed migrations.

## P0 execution-control foundation

The accepted P0 foundation lives under `governance/`, with executable checks under `tools/p0/`. It governs authority references, bounded decisions and work items, environment and secret boundaries, migration and schema-drift review, release traceability, rollback/recovery, logging, and provider-security controls. The reviewed P1-001 Physical Migration 1 artifact and its bounded Rosuno Staging application are recorded without adding application behavior.

## Run & validate

- `pnpm install --frozen-lockfile` — deterministic dependency installation
- `pnpm run format:check` — formatting gate
- `pnpm run typecheck` — TypeScript check with no emitted files
- `pnpm run build` — repository build gate using the same no-emit check
- `pnpm run p0:validate` — validates the accepted P0 controls and the currently authorized P1 migration boundary
- `pnpm run p0:test` — success and intentional failure-path control tests
- `pnpm run secrets:check` — tracked-file secret scan
- `pnpm run dependency:check` — high-severity dependency audit

## Enforcement boundary

Local validation is executable here. GitHub protected branches and required CI remain external enforcement. P1-001 records verified Rosuno approval and persistent application only to Rosuno Staging; production and later P1 work require separate authorization.

## Product boundary

There is still no application source, UI, authentication workflow, provider workflow, demo data, or production deployment. The only product artifact is the reviewed P1/1A `public.users` migration; later profiles, authorization, jurisdiction, scheduling, payment, consultation, and P2 work remain absent. The workspace package list remains empty and runtime dependencies remain absent.
