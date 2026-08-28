# Rollback and recovery control

No release or deployment exists in the neutral repository. This runbook defines the required evidence for a future controlled release without performing one.

Every release record must identify:

- The release identifier and immutable commit SHA.
- The trigger and blast-radius assessment.
- The last-known-good release or artifact.
- The exact reversible action and its validation.
- The accountable owner and the unresolved/approved reviewer state.
- The target environment and recovery evidence.
- The escalation path when rollback is incomplete.

Recovery must be tested in a non-production environment before production use. A rollback must never be improvised from a mutable branch, an unreviewed migration, a secret value, or an untraceable artifact.
