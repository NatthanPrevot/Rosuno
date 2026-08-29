# Rollback and recovery control

No production release or deployment exists. This runbook defines the required evidence for a controlled migration/release and governs the reviewed P1 migration after its bounded persistent application to Rosuno Staging.

Every release record must identify:

- The release identifier and immutable commit SHA.
- The trigger and blast-radius assessment.
- The last-known-good release or artifact.
- The exact reversible action and its validation.
- The accountable owner and the unresolved/approved reviewer state.
- The target environment and recovery evidence.
- The escalation path when rollback is incomplete.

Recovery must be tested in a non-production environment before production use. A rollback must never be improvised from a mutable branch, an unreviewed migration, a secret value, or an untraceable artifact.
