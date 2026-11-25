## Authorization

- Route: Packet `docs/work-items/<ID>/PACKET.md` on `wi/<ID>[-slug]`, or standing grant `<ID>` on `grant/<ID>/<slug>`
  (only once the owner has activated the route)
- What changed and why:

## Tests

Commands run on the final head and their results (CI on the exact head is the acceptance evidence):

```text
pnpm run format:check
pnpm run typecheck
pnpm run build
pnpm run p0:validate
pnpm run p0:test
pnpm run secrets:check
pnpm run dependency:check
```

- Failure tests for the changed behaviour:

## Security / integrity

<!-- One line is enough when there is no security impact. For authentication, authorization/RLS, protected
disclosure, payments, regulatory/eligibility, destructive or data-transforming migrations, storage, release or guard
trust: threats considered, tests proving the boundary, residual risks, and any independent assessment actually
performed. -->

## Environment and data impact

- Migrations: `none` / list (new migrations only; historical migrations unchanged)
- Persistent environments touched: `none` (repository merge applies nothing)
- Secrets: none in this PR

## Review

- Designated human approval of the exact head is required before merge. The owner merges.
- Independent review: `not requested` / `requested — <who, result>` (optional, owner's choice; a material trust or
  security change needs an independent assessment before the affected activation).
