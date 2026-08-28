# Logging control

Logging is an execution-control concern only. No runtime logger is implemented here.

Future logs must be structured, minimal, environment-scoped, and safe to retain. They may include event name, timestamp, severity, bounded work-item reference, release reference, environment, outcome, and a correlation identifier. They must not include secret values, authorization headers, private keys, credentials, raw provider payloads, or sensitive user data.

Failures must be explicit and actionable. A control failure records the failed control, safe evidence reference, environment, and next action without copying sensitive input into the log.
