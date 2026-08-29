# Migration and schema-drift control

The register contains one already-applied P0 security-control migration and one proposed P1 product migration. The P1 migration is validated but not persistently applied; its external human review and application state must remain explicit.

Every migration record must have a unique ordered identifier, an accountable owner, reviewer state, authority, decision, work-item and artifact references, a dependency list, a rollback plan, validation evidence, and a clean schema-drift result. A proposed migration may temporarily have no release reference only while its designated reviewer and persistent application remain pending. Known development or staging targets require non-production validation. Migrations must be reviewed and applied in order. Every discovered migration artifact must have exactly one register entry, and every register entry must resolve to one artifact. Missing predecessors, duplicate sequence numbers, unknown references, drift findings, unregistered files, or unsupported environment claims fail the gate.

The baseline under `governance/schema-drift/baseline.json` remains empty and clean because the proposed P1 migration was rolled back after validation. It must become a non-empty immutable baseline only after reviewed persistent application.
