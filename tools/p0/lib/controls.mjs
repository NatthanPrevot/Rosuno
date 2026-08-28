import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export const DECISION_FIELDS = [
  "decision_id",
  "title",
  "status",
  "scope",
  "decision",
  "rationale",
  "authority_refs",
  "work_item_refs",
  "owner",
  "reviewer",
  "created_at",
  "updated_at",
  "supersedes",
  "impact",
  "evidence",
  "expiry",
];

export const WORK_ITEM_FIELDS = [
  "work_item_id",
  "title",
  "objective",
  "in_scope",
  "out_of_scope",
  "status",
  "owner",
  "reviewer",
  "priority",
  "authority_refs",
  "decision_refs",
  "dependencies",
  "acceptance_criteria",
  "validation_commands",
  "environment",
  "release_refs",
  "migration_refs",
  "rollback_reference",
  "created_at",
  "updated_at",
];

export const MIGRATION_FIELDS = [
  "migration_id",
  "migration_kind",
  "sequence",
  "artifact_path",
  "authority_refs",
  "work_item_refs",
  "decision_refs",
  "release_refs",
  "reviewed",
  "reviewed_by",
  "reviewed_at",
  "applied_environment",
  "non_production_validation",
  "drift_check",
  "rollback_plan",
  "depends_on",
];

export const RELEASE_FIELDS = [
  "release_id",
  "commit_sha",
  "work_item_refs",
  "decision_refs",
  "migration_refs",
  "validation_evidence",
  "artifact_digest",
  "environment",
  "reviewer",
  "rollback_reference",
  "created_at",
];

const UNCLASSIFIED_EXTERNAL_PROJECT = "unclassified_external_project";

const DIRECT_SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/i,
  /\bsk_(?:live|test)_[A-Za-z0-9_-]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/]+:[^@\s/]+@/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|client[_-]?secret|private[_-]?key|secret|password|passwd|session[_-]?secret|secret[_-]?access[_-]?key|credentials?)\b\s*[:=]\s*["']?([^\s"',;}]{8,})/gim;

const SAFE_EXAMPLE_VALUES =
  /^(?:placeholder|example|redacted|not[_-]?set|none|null|<[^>]+>)$/i;

function fail(message) {
  throw new Error(message);
}

function readJson(relativePath) {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
  } catch (error) {
    fail(`Unable to read ${relativePath}: ${error.message}`);
  }
}

function repositoryFiles() {
  return execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean);
}

function requireFields(record, fields, context) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    fail(`${context} must be an object`);
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      fail(`${context} is missing required field ${field}`);
    }
  }
}

function requireExactFields(record, fields, context) {
  requireFields(record, fields, context);
  const extras = Object.keys(record).filter((field) => !fields.includes(field));
  if (extras.length > 0)
    fail(`${context} contains unsupported field(s): ${extras.join(", ")}`);
}

function requireArray(value, context, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum) {
    fail(`${context} must be an array with at least ${minimum} item(s)`);
  }
}

function requireNonEmptyString(value, context) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${context} must be a non-empty string`);
  }
}

function requireBoundedString(value, context, maximum = 2000) {
  requireNonEmptyString(value, context);
  if (value.length > maximum) fail(`${context} exceeds ${maximum} characters`);
}

function requireStringArray(
  value,
  context,
  minimum = 0,
  { meaningful = false } = {},
) {
  requireArray(value, context, minimum);
  for (const [index, item] of value.entries()) {
    requireBoundedString(item, `${context}[${index}]`);
    if (
      meaningful &&
      /^(?:n\/a|none|null|placeholder|tbd|todo|unknown)$/i.test(item.trim())
    ) {
      fail(`${context}[${index}] must be a meaningful reference or statement`);
    }
  }
}

function requireTimestamp(value, context) {
  const parsed = typeof value === "string" ? new Date(value) : null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().replace(".000Z", "Z") !== value
  ) {
    fail(`${context} must be a valid UTC timestamp`);
  }
}

function validateChronology(createdAt, updatedAt, context) {
  requireTimestamp(createdAt, `${context}.created_at`);
  requireTimestamp(updatedAt, `${context}.updated_at`);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    fail(`${context}.updated_at may not precede created_at`);
  }
}

function uniqueIds(records, field, context) {
  const ids = new Set();
  for (const [index, record] of records.entries()) {
    requireNonEmptyString(record[field], `${context} ${index + 1}.${field}`);
    if (ids.has(record[field]))
      fail(`${context} ${field} values must be unique`);
    ids.add(record[field]);
  }
  return ids;
}

function validateReferences(values, allowed, context, minimum = 0) {
  requireStringArray(values, context, minimum);
  if (new Set(values).size !== values.length) {
    fail(`${context} contains duplicate references`);
  }
  if (allowed) {
    for (const value of values) {
      if (!allowed.has(value))
        fail(`${context} contains unknown reference ${value}`);
    }
  }
}

function validateReviewer(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must declare reviewer metadata`);
  }
  requireExactFields(value, ["identity", "status"], context);
  if (value.identity === null) {
    if (value.status !== "unresolved_external_dependency") {
      fail(`${context} must keep an unknown reviewer explicitly unresolved`);
    }
    return;
  }
  requireBoundedString(value.identity, `${context}.identity`, 200);
  if (!["pending", "approved", "rejected"].includes(value.status)) {
    fail(`${context}.status is not allowed for an identified reviewer`);
  }
}

export function validateAuthorityReferences(data) {
  requireArray(data.references, "authority references", 1);
  for (const [index, reference] of data.references.entries()) {
    const context = `authority reference ${index + 1}`;
    for (const field of [
      "authority_id",
      "title",
      "location",
      "integrity",
      "usage",
      "status",
    ]) {
      requireNonEmptyString(reference[field], `${context}.${field}`);
    }
    if (
      reference.locked !== true ||
      reference.content_copied !== false ||
      reference.reinterpreted !== false
    ) {
      fail(
        `${context} must remain a locked, reference-only, unmodified authority`,
      );
    }
  }
}

export function validateFieldRegistry(data) {
  for (const [name, fields] of [
    ["decision_log_required_fields", DECISION_FIELDS],
    ["work_item_required_fields", WORK_ITEM_FIELDS],
    ["migration_required_fields", MIGRATION_FIELDS],
    ["release_traceability_required_fields", RELEASE_FIELDS],
  ]) {
    requireArray(data[name], name, 1);
    if (JSON.stringify(data[name]) !== JSON.stringify(fields)) {
      fail(`${name} does not match the P0 control field registry`);
    }
  }
}

export function validateSchemaArtifact(schema, expectedFields, context) {
  if (
    schema.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
    schema.type !== "object" ||
    schema.additionalProperties !== false
  ) {
    fail(`${context} must be a strict JSON Schema 2020-12 object`);
  }
  if (JSON.stringify(schema.required) !== JSON.stringify(expectedFields)) {
    fail(`${context}.required does not match the P0 field registry`);
  }
  for (const field of expectedFields) {
    if (!schema.properties?.[field])
      fail(`${context} is missing property schema ${field}`);
  }
}

export function scanSecretLikeText(text, source = "input") {
  const findings = [];
  for (const pattern of DIRECT_SECRET_PATTERNS) {
    if (pattern.test(text))
      findings.push(`${source}: secret-like value detected`);
  }
  SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(SECRET_ASSIGNMENT_PATTERN)) {
    if (!SAFE_EXAMPLE_VALUES.test(match[1])) {
      findings.push(`${source}: assigned secret-like value detected`);
    }
  }
  return [...new Set(findings)];
}

export function validateDecisionRecord(
  record,
  context = "decision",
  references = {},
) {
  requireExactFields(record, DECISION_FIELDS, context);
  if (
    !["proposed", "accepted", "rejected", "superseded"].includes(record.status)
  ) {
    fail(`${context}.status is not allowed`);
  }
  if (!/^DEC-\d{8}-[A-Z0-9][A-Z0-9-]*$/.test(record.decision_id)) {
    fail(`${context}.decision_id has an invalid format`);
  }
  requireBoundedString(record.title, `${context}.title`, 200);
  requireBoundedString(record.scope, `${context}.scope`, 1000);
  requireBoundedString(record.decision, `${context}.decision`);
  requireBoundedString(record.rationale, `${context}.rationale`);
  requireBoundedString(record.owner, `${context}.owner`, 200);
  validateReferences(
    record.authority_refs,
    references.authorityIds,
    `${context}.authority_refs`,
    1,
  );
  validateReferences(
    record.work_item_refs,
    references.workItemIds,
    `${context}.work_item_refs`,
  );
  validateReferences(
    record.supersedes,
    references.decisionIds,
    `${context}.supersedes`,
  );
  if (record.supersedes.includes(record.decision_id)) {
    fail(`${context}.supersedes may not reference itself`);
  }
  requireBoundedString(record.impact, `${context}.impact`);
  requireStringArray(record.evidence, `${context}.evidence`, 1, {
    meaningful: true,
  });
  validateReviewer(record.reviewer, `${context}.reviewer`);
  validateChronology(record.created_at, record.updated_at, context);
  if (record.expiry !== null) {
    requireTimestamp(record.expiry, `${context}.expiry`);
    if (Date.parse(record.expiry) < Date.parse(record.created_at)) {
      fail(`${context}.expiry may not precede created_at`);
    }
  }
  if (scanSecretLikeText(JSON.stringify(record), context).length > 0) {
    fail(`${context} contains a secret-like value`);
  }
}

export function validateWorkItem(
  record,
  context = "work item",
  references = {},
) {
  requireExactFields(record, WORK_ITEM_FIELDS, context);
  if (record.priority !== "P0") fail(`${context}.priority must be P0`);
  if (
    ![
      "proposed",
      "approved",
      "in_progress",
      "blocked",
      "completed",
      "cancelled",
    ].includes(record.status)
  ) {
    fail(`${context}.status is not allowed`);
  }
  if (
    ![
      "development",
      "staging",
      "production",
      "none",
      UNCLASSIFIED_EXTERNAL_PROJECT,
    ].includes(record.environment)
  ) {
    fail(`${context}.environment is not allowed`);
  }
  if (!/^WI-P0-[A-Z0-9][A-Z0-9-]*$/.test(record.work_item_id)) {
    fail(`${context}.work_item_id has an invalid format`);
  }
  requireBoundedString(record.title, `${context}.title`, 200);
  requireBoundedString(record.objective, `${context}.objective`);
  requireBoundedString(record.owner, `${context}.owner`, 200);
  requireBoundedString(
    record.rollback_reference,
    `${context}.rollback_reference`,
    1000,
  );
  for (const field of [
    "in_scope",
    "out_of_scope",
    "acceptance_criteria",
    "validation_commands",
  ]) {
    requireStringArray(record[field], `${context}.${field}`, 1, {
      meaningful: true,
    });
  }
  validateReferences(
    record.authority_refs,
    references.authorityIds,
    `${context}.authority_refs`,
    1,
  );
  validateReferences(
    record.decision_refs,
    references.decisionIds,
    `${context}.decision_refs`,
  );
  validateReferences(
    record.dependencies,
    references.workItemIds,
    `${context}.dependencies`,
  );
  if (record.dependencies.includes(record.work_item_id)) {
    fail(`${context}.dependencies may not reference itself`);
  }
  validateReferences(
    record.release_refs,
    references.releaseIds,
    `${context}.release_refs`,
  );
  validateReferences(
    record.migration_refs,
    references.migrationIds,
    `${context}.migration_refs`,
  );
  validateReviewer(record.reviewer, `${context}.reviewer`);
  validateChronology(record.created_at, record.updated_at, context);
  if (scanSecretLikeText(JSON.stringify(record), context).length > 0) {
    fail(`${context} contains a secret-like value`);
  }
}

export function validateEnvironmentContract(contract) {
  const expected = ["development", "staging", "production"];
  if (JSON.stringify(contract.scope_names) !== JSON.stringify(expected)) {
    fail("environment scope names must be development, staging, production");
  }
  for (const environment of expected) {
    const config = contract.environments?.[environment];
    if (!config) fail(`missing ${environment} environment configuration`);
    if (
      config.config_scope !== environment ||
      config.secret_scope !== environment
    ) {
      fail(`${environment} must use its own configuration and secret scope`);
    }
    if (
      !Array.isArray(config.inherits_from) ||
      config.inherits_from.length !== 0
    ) {
      fail(`${environment} may not inherit configuration implicitly`);
    }
  }
  if (contract.rules?.shared_secret_scope_forbidden !== true) {
    fail("shared secret scope must be forbidden");
  }
  if (
    JSON.stringify(contract.rules?.production_must_not_inherit) !==
    JSON.stringify(["development", "staging"])
  ) {
    fail("production inheritance rule is incomplete");
  }
  if (
    JSON.stringify(contract.rules?.staging_must_not_inherit) !==
    JSON.stringify(["development"])
  ) {
    fail("staging inheritance rule is incomplete");
  }
}

export function validateEnvironmentExample(example, expectedEnvironment) {
  const context = `${expectedEnvironment} environment example`;
  if (example.environment !== expectedEnvironment)
    fail(`${context} has the wrong environment`);
  if (
    example.config_scope !== expectedEnvironment ||
    example.secret_scope !== expectedEnvironment
  ) {
    fail(`${context} does not isolate configuration and secrets`);
  }
  if (
    !Array.isArray(example.inherits_from) ||
    example.inherits_from.length !== 0
  ) {
    fail(`${context} must not inherit another environment`);
  }
  if (example.secret_values_present !== false)
    fail(`${context} must not contain secret values`);
  if (!example.values || typeof example.values !== "object") {
    fail(`${context} must contain only example metadata`);
  }
  if (scanSecretLikeText(JSON.stringify(example), context).length > 0) {
    fail(`${context} contains a secret-like value`);
  }
}

function migrationArtifactPaths(files) {
  return files.filter(
    (file) =>
      (file.startsWith("governance/migrations/") &&
        file !== "governance/migrations/reviewed-migrations.json") ||
      (!file.startsWith("governance/") &&
        (file.endsWith(".sql") ||
          /^(?:db|database|drizzle|migrations|prisma|supabase)\//i.test(file))),
  );
}

export function validateMigrationArtifact(artifact, migration, context) {
  requireExactFields(
    artifact,
    [
      "migration_id",
      "version",
      "name",
      "migration_kind",
      "target_project",
      "intent",
      "preserved_invariants",
      "validation_evidence",
      "schema_drift",
    ],
    context,
  );
  if (artifact.migration_id !== migration.migration_id) {
    fail(`${context}.migration_id does not match its register entry`);
  }
  if (!/^\d{14}$/.test(artifact.version)) {
    fail(`${context}.version must be a 14-digit migration version`);
  }
  requireBoundedString(artifact.name, `${context}.name`, 200);
  if (artifact.migration_kind !== "security_control") {
    fail(`${context}.migration_kind must be security_control`);
  }
  if (
    artifact.target_project?.name !== "Rosuno" ||
    artifact.target_project?.project_ref !== "wwcwfbzwljbjlaifklaj"
  ) {
    fail(`${context}.target_project must identify the active Rosuno project`);
  }
  if (
    artifact.intent?.execute_revoked_from?.join("|") !==
    "PUBLIC|anon|authenticated"
  ) {
    fail(
      `${context}.intent must revoke direct EXECUTE from PUBLIC, anon, and authenticated`,
    );
  }
  if (
    artifact.intent?.execute_retained_for?.join("|") !== "postgres|service_role"
  ) {
    fail(
      `${context}.intent must retain direct EXECUTE for postgres and service_role`,
    );
  }
  for (const invariant of [
    "function_body_unchanged",
    "security_definer_unchanged",
    "ensure_rls_event_trigger_unchanged",
    "schema_design_unchanged",
    "other_privileges_unchanged",
  ]) {
    if (artifact.preserved_invariants?.[invariant] !== true) {
      fail(`${context}.preserved_invariants.${invariant} must be true`);
    }
  }
  const evidence = artifact.validation_evidence;
  for (const [field, expected] of [
    ["anonymous_execute", false],
    ["authenticated_execute", false],
    ["postgres_execute", true],
    ["service_role_execute", true],
  ]) {
    if (evidence?.[field] !== expected) {
      fail(`${context}.validation_evidence.${field} is incorrect`);
    }
  }
  if (
    evidence.ensure_rls?.enabled !== true ||
    evidence.ensure_rls?.event !== "ddl_command_end" ||
    evidence.security_advisor?.findings_after_remediation !== 0 ||
    evidence.performance_advisor?.findings_after_remediation !== 0
  ) {
    fail(`${context} lacks the required Supabase validation evidence`);
  }
  if (
    artifact.schema_drift?.status !== "clean" ||
    artifact.schema_drift?.database_calls_made !== false
  ) {
    fail(`${context}.schema_drift must be clean without database calls`);
  }
  if (scanSecretLikeText(JSON.stringify(artifact), context).length > 0) {
    fail(`${context} contains a secret-like value`);
  }
}

export function validateRestoreEvidence(evidence) {
  requireExactFields(
    evidence,
    [
      "version",
      "evidence_id",
      "scope",
      "environment",
      "project_refs",
      "timing",
      "tools",
      "backup_restore",
      "security_reconciliation",
      "event_trigger_recovery",
      "parity",
      "limitations",
      "cleanup",
      "sensitive_payloads_present",
    ],
    "restore evidence",
  );
  if (
    evidence.version !== 1 ||
    evidence.evidence_id !== "P0-001-NON-PRODUCTION-RESTORE" ||
    evidence.environment !== "staging"
  ) {
    fail("restore evidence identity or environment is invalid");
  }
  if (
    evidence.project_refs?.source !== "wwcwfbzwljbjlaifklaj" ||
    evidence.project_refs?.target !== "mxjlvmowmodzdtdfgqpb"
  ) {
    fail("restore evidence project orientation is invalid");
  }
  for (const field of [
    "restore_started_at",
    "restore_completed_at",
    "validation_completed_at",
  ]) {
    requireTimestamp(
      evidence.timing?.[field],
      `restore evidence timing.${field}`,
    );
  }
  const restore = evidence.backup_restore;
  if (
    restore?.official_roles_schema_data !== "passed" ||
    restore?.official_migration_history !== "passed" ||
    restore?.migration_version !== "20260828192126" ||
    restore?.normalized_statement_count !== 1 ||
    restore?.parameter_acl_fingerprint !== "0c76cbe6bc3831caee75ade02f91dee6"
  ) {
    fail("restore evidence backup, history, or normalization is invalid");
  }
  for (const field of ["roles_original_sha256", "roles_normalized_sha256"]) {
    if (!/^[a-f0-9]{64}$/.test(restore?.[field] ?? "")) {
      fail(`restore evidence ${field} is invalid`);
    }
  }
  if (restore.roles_original_sha256 === restore.roles_normalized_sha256) {
    fail("restore evidence normalized roles hash must differ");
  }
  const reconciliation = evidence.security_reconciliation;
  if (
    reconciliation?.revoked_from?.join("|") !== "PUBLIC|anon|authenticated" ||
    reconciliation?.retained_for?.join("|") !== "postgres|service_role" ||
    reconciliation?.function_definition_fingerprint !==
      "6998ea6b4c2480f5d2e34b5dcf3f8d36" ||
    reconciliation?.owner !== "postgres" ||
    reconciliation?.security_definer !== true ||
    reconciliation?.migration_history_modified !== false ||
    reconciliation?.security_advisor_findings !== 0
  ) {
    fail("restore evidence security reconciliation is invalid");
  }
  const trigger = evidence.event_trigger_recovery;
  if (
    trigger?.authority !== "live source catalog" ||
    trigger?.name !== "ensure_rls" ||
    trigger?.event !== "ddl_command_end" ||
    trigger?.tags?.join("|") !== "CREATE TABLE|CREATE TABLE AS|SELECT INTO" ||
    trigger?.enabled !== "O" ||
    trigger?.owner !== "postgres" ||
    trigger?.function_identity !== "public.rls_auto_enable()" ||
    trigger?.behavior_test !== "passed" ||
    trigger?.probe_cleanup !== "passed"
  ) {
    fail("restore evidence event-trigger recovery is invalid");
  }
  if (
    evidence.parity?.status !== "passed" ||
    evidence.parity?.source_unchanged !== true ||
    evidence.parity?.source_security_advisor_findings !== 0 ||
    evidence.parity?.target_security_advisor_findings !== 0 ||
    evidence.cleanup?.temporary_material_removed !== true ||
    evidence.cleanup?.probe_object_absent !== true ||
    evidence.sensitive_payloads_present !== false
  ) {
    fail("restore evidence parity, cleanup, or redaction is invalid");
  }
  requireStringArray(evidence.limitations, "restore evidence limitations", 3, {
    meaningful: true,
  });
  if (scanSecretLikeText(JSON.stringify(evidence), "restore evidence").length) {
    fail("restore evidence contains secret-like content");
  }
}

export function validateMigrationRegister(
  register,
  references = {},
  files = [],
) {
  requireArray(register.migrations, "migration register");
  uniqueIds(register.migrations, "migration_id", "migration");
  const registeredArtifacts = new Set();
  for (const [index, migration] of register.migrations.entries()) {
    const context = `migration ${index + 1}`;
    requireExactFields(migration, MIGRATION_FIELDS, context);
    if (migration.migration_kind !== "security_control") {
      fail(`${context}.migration_kind must be security_control`);
    }
    if (migration.sequence !== index + 1) fail(`${context} is out of order`);
    requireNonEmptyString(migration.artifact_path, `${context}.artifact_path`);
    if (registeredArtifacts.has(migration.artifact_path)) {
      fail(`${context}.artifact_path is duplicated`);
    }
    registeredArtifacts.add(migration.artifact_path);
    if (
      !migration.artifact_path.startsWith("governance/migrations/") ||
      migration.artifact_path ===
        "governance/migrations/reviewed-migrations.json"
    ) {
      fail(
        `${context}.artifact_path must point to a governance migration artifact`,
      );
    }
    validateMigrationArtifact(
      readJson(migration.artifact_path),
      migration,
      `${context}.artifact`,
    );
    if (migration.reviewed !== true) fail(`${context} is not reviewed`);
    for (const field of ["reviewed_by", "reviewed_at", "rollback_plan"]) {
      requireNonEmptyString(migration[field], `${context}.${field}`);
    }
    if (
      !["development", "staging", UNCLASSIFIED_EXTERNAL_PROJECT].includes(
        migration.applied_environment,
      )
    ) {
      fail(`${context}.applied_environment is not recognized`);
    }
    if (
      migration.applied_environment === UNCLASSIFIED_EXTERNAL_PROJECT &&
      migration.non_production_validation !== false
    ) {
      fail(
        `${context} must not classify an unclassified external project as non-production`,
      );
    }
    if (
      migration.applied_environment !== UNCLASSIFIED_EXTERNAL_PROJECT &&
      migration.non_production_validation !== true
    ) {
      fail(`${context} must be validated in a non-production environment`);
    }
    if (migration.drift_check !== "clean") {
      fail(`${context} lacks a clean drift check`);
    }
    validateReferences(
      migration.authority_refs,
      references.authorityIds,
      `${context}.authority_refs`,
      1,
    );
    validateReferences(
      migration.work_item_refs,
      references.workItemIds,
      `${context}.work_item_refs`,
      1,
    );
    validateReferences(
      migration.decision_refs,
      references.decisionIds,
      `${context}.decision_refs`,
      1,
    );
    validateReferences(
      migration.release_refs,
      references.releaseIds,
      `${context}.release_refs`,
      1,
    );
    validateReferences(
      migration.depends_on,
      references.migrationIds,
      `${context}.depends_on`,
    );
  }
  const productMigrationsPresent = register.migrations.some(
    (migration) => migration.migration_kind === "product",
  );
  if (register.product_migrations_present !== productMigrationsPresent) {
    fail("product migration presence flag does not match the register");
  }
  const discovered = migrationArtifactPaths(files);
  if (
    JSON.stringify([...registeredArtifacts].sort()) !==
    JSON.stringify(discovered.sort())
  ) {
    fail("migration artifact inventory does not match the reviewed register");
  }
}

export function validateDriftReport(report) {
  requireFields(
    report,
    [
      "product_schema_present",
      "baseline_id",
      "baseline_digest",
      "checked_environment",
      "checked_at",
      "evidence",
      "drift_status",
      "drift_items",
    ],
    "schema drift report",
  );
  if (report.drift_status !== "clean")
    fail("schema drift status must be clean");
  if (!Array.isArray(report.drift_items) || report.drift_items.length !== 0) {
    fail("schema drift items must be empty");
  }
  requireArray(report.evidence, "schema drift evidence");
  if (report.product_schema_present === false) {
    if (
      report.baseline_id !== "none" ||
      report.baseline_digest !== null ||
      report.checked_environment !== "none" ||
      report.checked_at !== null ||
      report.evidence.length !== 0
    ) {
      fail("neutral schema drift baseline must remain empty");
    }
    return;
  }
  if (report.product_schema_present !== true)
    fail("product schema presence must be boolean");
  requireNonEmptyString(report.baseline_id, "schema drift baseline_id");
  if (!/^sha256:[a-f0-9]{64}$/i.test(report.baseline_digest)) {
    fail("schema drift baseline_digest must be immutable");
  }
  if (!["development", "staging"].includes(report.checked_environment)) {
    fail("schema drift must be checked outside production");
  }
  requireNonEmptyString(report.checked_at, "schema drift checked_at");
  requireArray(report.evidence, "schema drift evidence", 1);
}

export function validateReleaseRegister(
  register,
  references = {},
  commitExists = null,
) {
  requireArray(register.releases, "release register");
  uniqueIds(register.releases, "release_id", "release");
  for (const [index, release] of register.releases.entries()) {
    const context = `release ${index + 1}`;
    requireFields(release, RELEASE_FIELDS, context);
    for (const field of [
      "release_id",
      "commit_sha",
      "artifact_digest",
      "rollback_reference",
    ]) {
      requireNonEmptyString(release[field], `${context}.${field}`);
    }
    if (!/^[a-f0-9]{40}$/i.test(release.commit_sha)) {
      fail(`${context}.commit_sha must be a full immutable Git SHA`);
    }
    if (commitExists && !commitExists(release.commit_sha)) {
      fail(`${context}.commit_sha does not resolve to a local commit`);
    }
    if (!/^sha256:[a-f0-9]{64}$/i.test(release.artifact_digest)) {
      fail(`${context}.artifact_digest must be a SHA-256 digest`);
    }
    if (
      !["staging", "production", UNCLASSIFIED_EXTERNAL_PROJECT].includes(
        release.environment,
      )
    ) {
      fail(
        `${context}.environment must be staging, production, or an unclassified external project`,
      );
    }
    validateReferences(
      release.work_item_refs,
      references.workItemIds,
      `${context}.work_item_refs`,
      1,
    );
    validateReferences(
      release.decision_refs,
      references.decisionIds,
      `${context}.decision_refs`,
      1,
    );
    validateReferences(
      release.migration_refs,
      references.migrationIds,
      `${context}.migration_refs`,
    );
    requireArray(
      release.validation_evidence,
      `${context}.validation_evidence`,
      1,
    );
    validateReviewer(release.reviewer, `${context}.reviewer`);
    if (scanSecretLikeText(JSON.stringify(release), context).length > 0) {
      fail(`${context} contains a secret-like value`);
    }
  }
}

export function validateTraceabilityConsistency(
  migrationRegister,
  releaseRegister,
) {
  const migrations = new Map(
    migrationRegister.migrations.map((migration) => [
      migration.migration_id,
      migration,
    ]),
  );
  const releases = new Map(
    releaseRegister.releases.map((release) => [release.release_id, release]),
  );
  for (const migration of migrations.values()) {
    for (const releaseId of migration.release_refs) {
      if (
        !releases
          .get(releaseId)
          ?.migration_refs.includes(migration.migration_id)
      ) {
        fail(
          `release ${releaseId} must include migration ${migration.migration_id} bidirectionally`,
        );
      }
    }
  }
  for (const release of releases.values()) {
    for (const migrationId of release.migration_refs) {
      if (
        !migrations.get(migrationId)?.release_refs.includes(release.release_id)
      ) {
        fail(
          `migration ${migrationId} must include release ${release.release_id} bidirectionally`,
        );
      }
    }
  }
}

export function validateCiWorkflow(text) {
  if (/^\s*(?:container|environment|services)\s*:/m.test(text)) {
    fail("CI may not declare deployment environments, containers, or services");
  }
  const jobsSection = text.slice(text.indexOf("\njobs:\n") + 7);
  const jobIds = [...jobsSection.matchAll(/^  ([a-z][a-z0-9-]+):$/gm)].map(
    (match) => match[1],
  );
  const allowedJobs = [
    "deterministic-install",
    "quality-and-controls",
    "dependency-security",
  ];
  if (JSON.stringify(jobIds) !== JSON.stringify(allowedJobs)) {
    fail("CI job set must match the P0 control allowlist");
  }
  const checkouts = text.match(/uses:\s*actions\/checkout@v4/g) ?? [];
  const fullHistoryCheckouts =
    text.match(/uses:\s*actions\/checkout@v4\s+with:\s+fetch-depth:\s*0/g) ??
    [];
  if (
    checkouts.length !== 3 ||
    fullHistoryCheckouts.length !== checkouts.length
  ) {
    fail("every CI checkout must fetch full history for release traceability");
  }
  const allowedActions = new Set([
    "actions/checkout@v4",
    "pnpm/action-setup@v4",
    "actions/setup-node@v4",
  ]);
  const actions = [...text.matchAll(/^\s*-\s+uses:\s*(\S+)\s*$/gm)].map(
    (match) => match[1],
  );
  if (
    actions.length !== 9 ||
    actions.some((action) => !allowedActions.has(action))
  ) {
    fail("CI action set must match the P0 control allowlist");
  }
  const requiredCommands = [
    "pnpm install --frozen-lockfile",
    "pnpm run format:check",
    "pnpm run typecheck",
    "pnpm run build",
    "pnpm run p0:validate",
    "pnpm run p0:test",
    "pnpm run secrets:check",
    "pnpm run dependency:check",
  ];
  const runCommands = [...text.matchAll(/^\s*-\s+run:\s*(.+)\s*$/gm)].map(
    (match) => match[1].trim(),
  );
  if (runCommands.some((command) => !requiredCommands.includes(command))) {
    fail("CI run command is outside the P0 control allowlist");
  }
  for (const command of requiredCommands) {
    if (!runCommands.includes(command))
      fail(`CI is missing required command ${command}`);
  }
}

export function validatePackageJson(packageJson) {
  const expectedScripts = {
    preinstall:
      'sh -c \'rm -f package-lock.json yarn.lock; case "$npm_config_user_agent" in pnpm/*) ;; *) echo "Use pnpm instead" >&2; exit 1 ;; esac\'',
    typecheck: "tsc --noEmit --incremental false",
    build: "tsc --noEmit --incremental false",
    "format:check":
      'prettier --check "governance/**/*.{md,json,yaml,yml}" ".github/**/*.{md,yml,yaml}" "tools/**/*.mjs" "package.json" "pnpm-workspace.yaml" "tsconfig*.json"',
    lint: "pnpm run format:check",
    "p0:validate": "node tools/p0/validate.mjs",
    "p0:test": "node --test tools/p0/tests/*.test.mjs",
    "secrets:check": "node tools/p0/secret-scan.mjs",
    "dependency:check": "pnpm audit --audit-level=high",
  };
  if (JSON.stringify(packageJson.scripts) !== JSON.stringify(expectedScripts)) {
    fail("package scripts must match the P0 control allowlist");
  }
  if (
    packageJson.dependencies &&
    Object.keys(packageJson.dependencies).length > 0
  ) {
    fail("neutral repository must not declare runtime dependencies");
  }
  const devDependencies = Object.keys(packageJson.devDependencies ?? {}).sort();
  if (
    JSON.stringify(devDependencies) !==
    JSON.stringify(["prettier", "typescript"])
  ) {
    fail(
      "development dependencies must remain limited to Prettier and TypeScript",
    );
  }
}

export function validateNeutralPaths(files, packageJson) {
  validatePackageJson(packageJson);
  const allowedRootFiles = new Set([
    ".gitignore",
    ".npmrc",
    ".replit",
    ".replitignore",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "replit.md",
    "tsconfig.base.json",
    "tsconfig.json",
  ]);
  const allowedGithubFiles = new Set([
    ".github/CODEOWNERS",
    ".github/pull_request_template.md",
    ".github/workflows/p0-controls.yml",
  ]);
  const forbidden = files.filter(
    (file) =>
      !allowedRootFiles.has(file) &&
      !allowedGithubFiles.has(file) &&
      !file.startsWith("governance/") &&
      !file.startsWith("tools/p0/"),
  );
  if (forbidden.length > 0) {
    fail(`product implementation paths are present: ${forbidden.join(", ")}`);
  }
}

export function validateRepository() {
  const packageJson = readJson("package.json");
  const workspace = readFileSync(
    path.join(ROOT, "pnpm-workspace.yaml"),
    "utf8",
  );
  if (!/packages:\s*\[\]/.test(workspace))
    fail("workspace packages must remain empty");
  const files = repositoryFiles();
  validateNeutralPaths(files, packageJson);
  validateCiWorkflow(
    readFileSync(path.join(ROOT, ".github/workflows/p0-controls.yml"), "utf8"),
  );

  const authorityData = readJson("governance/authority-references.json");
  const decisions = readJson("governance/decision-log.json");
  const workItems = readJson("governance/work-items/index.json");
  const migrations = readJson("governance/migrations/reviewed-migrations.json");
  const releases = readJson("governance/releases/traceability.json");

  validateAuthorityReferences(authorityData);
  validateFieldRegistry(readJson("governance/control-fields.json"));
  validateSchemaArtifact(
    readJson("governance/decision-log.schema.json"),
    DECISION_FIELDS,
    "decision schema",
  );
  validateSchemaArtifact(
    readJson("governance/work-items/schema.json"),
    WORK_ITEM_FIELDS,
    "work-item schema",
  );
  requireArray(decisions.decisions, "decision log");
  requireArray(workItems.work_items, "work-item register");
  requireArray(migrations.migrations, "migration register");
  requireArray(releases.releases, "release register");

  const references = {
    authorityIds: uniqueIds(
      authorityData.references,
      "authority_id",
      "authority reference",
    ),
    decisionIds: uniqueIds(decisions.decisions, "decision_id", "decision"),
    workItemIds: uniqueIds(workItems.work_items, "work_item_id", "work item"),
    migrationIds: uniqueIds(migrations.migrations, "migration_id", "migration"),
    releaseIds: uniqueIds(releases.releases, "release_id", "release"),
  };

  for (const [index, decision] of decisions.decisions.entries()) {
    validateDecisionRecord(decision, `decision ${index + 1}`, references);
  }
  for (const [index, workItem] of workItems.work_items.entries()) {
    validateWorkItem(workItem, `work item ${index + 1}`, references);
  }

  validateEnvironmentContract(
    readJson("governance/environments/contract.json"),
  );
  for (const environment of ["development", "staging", "production"]) {
    validateEnvironmentExample(
      readJson(`governance/environments/${environment}.example.json`),
      environment,
    );
  }

  validateMigrationRegister(migrations, references, files);
  validateRestoreEvidence(
    readJson("governance/evidence/p0-restore-validation.json"),
  );
  validateDriftReport(readJson("governance/schema-drift/baseline.json"));
  validateReleaseRegister(releases, references, (sha) => {
    try {
      execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
        cwd: ROOT,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  });
  validateTraceabilityConsistency(migrations, releases);

  return {
    status: "passed",
    checks: [
      "neutral package, paths, and empty workspace",
      "locked authority references",
      "relational decision and work-item registers",
      "environment isolation",
      "migration inventory and clean drift baseline",
      "sanitized non-production restore evidence",
      "release traceability",
    ],
  };
}

export function scanRepositoryForSecrets() {
  const files = repositoryFiles();
  const findings = [];
  for (const file of files) {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    findings.push(...scanSecretLikeText(text, file));
  }
  if (findings.length > 0) fail(findings.join("\n"));
  return { status: "passed", scanned_files: files.length };
}

export { ROOT };
