# Migration and schema-drift control

There is no product schema and no product migration in this repository. One already-applied P0 security-control migration is recorded solely for migration-history derivability, validation evidence, and drift prevention.

Every migration record must have a unique ordered identifier, an accountable owner, reviewer state, authority, decision, work-item, release, and artifact references, a dependency list, a rollback plan, non-production validation evidence, and a clean schema-drift result. Migrations must be reviewed and applied in order. Every discovered migration artifact must have exactly one register entry, and every register entry must resolve to one artifact. Missing predecessors, duplicate sequence numbers, unknown references, drift findings, unregistered files, or production-only validation fail the gate.

The baseline under `governance/schema-drift/baseline.json` is intentionally empty and clean. It is not a product schema and must not be expanded without an approved P0/P1 scope decision. A future non-empty baseline must include an immutable digest, a non-production check environment, timestamp, and evidence; database introspection and restore execution remain external controls.
