import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeCatalogRows,
  validateAdvisorFindings,
  validateCatalogBaseline,
} from "./catalog-fingerprint.mjs";

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

export const P0_MIGRATION_ID =
  "20260828192126_p0_restrict_rls_auto_enable_execution";
export const P0_CLI_INVENTORY_PATH =
  "supabase/migrations/20260828192126_p0_restrict_rls_auto_enable_execution.sql";
const P0_STORED_EXECUTABLE_STATEMENT =
  "REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;";
const P0_STORED_STATEMENT_SHA256 =
  "2ba591b2767c43a32731c8b74b5ffaa07c47a41d096eee6fb3672aad9278c49d";
const P0_INVENTORY_RECONCILIATION_PATH =
  "governance/evidence/p0-cli-inventory-reconciliation.json";

const P1_REGULATORY_APPROVED_ADVISOR_FINDINGS = [
  "rls_enabled_no_policy:public.application_sessions",
  "rls_enabled_no_policy:public.capability_definitions",
  "rls_enabled_no_policy:public.capability_grants",
  "rls_enabled_no_policy:public.jurisdictions",
  "rls_enabled_no_policy:public.service_areas",
  "rls_enabled_no_policy:public.regulatory_modes",
  "rls_enabled_no_policy:public.jurisdiction_regulatory_modes",
  "rls_enabled_no_policy:public.policy_types",
  "rls_enabled_no_policy:public.policy_versions",
  "rls_enabled_no_policy:public.policy_authority_references",
  "rls_enabled_no_policy:public.launch_gates",
  "rls_enabled_no_policy:public.launch_gate_evaluations",
  "rls_enabled_no_policy:public.launch_authorizations",
];

const P1_AUTHORIZATION_CORRECTION_MIGRATION_ID =
  "20260901012518_p1_authorization_scope_correction";
const P1_AUTHORIZATION_CORRECTION_MIGRATION_PATH =
  "supabase/migrations/20260901012518_p1_authorization_scope_correction.sql";
const P1_AUTHORIZATION_CORRECTION_MIGRATION_SHA256 =
  "bf0cdabed8ffa41a65e793b9041c00dc7d2ca47eeef40c2750770e195b47d6c5";
const P1_AUTHORIZATION_CORRECTION_MIGRATION_BYTES = 10339;
const P1_AUTHORIZATION_CORRECTION_WORK_ITEM_ID =
  "WI-P1-002-AUTHORIZATION-SCOPE-CORRECTION";
const P1_AUTHORIZATION_CORRECTION_DECISION_ID =
  "DEC-20260831-P1-002-AUTHORIZATION-SCOPE-CORRECTION";
const P1_AUTHORIZATION_CORRECTION_RELEASE_ID =
  "REL-20260901-P1-002-CORRECTION-STAGING-APPLICATION";
const P1_AUTHORIZATION_CORRECTION_PR = 10;
const P1_AUTHORIZATION_CORRECTION_PR_URL =
  "https://github.com/NatthanPrevot/Rosuno/pull/10";
const P1_AUTHORIZATION_CORRECTION_APPROVED_HEAD =
  "fb5e281bc003fa3e79d06111d451be2eedfd40bf";
const P1_AUTHORIZATION_CORRECTION_MERGE_COMMIT =
  "eaf6204a64ac6c9e9666775b2a1e6c3ec31e0b3a";
const P1_AUTHORIZATION_CORRECTION_REVIEWED_AT = "2026-09-01T16:33:32Z";
const P1_AUTHORIZATION_CORRECTION_MERGED_AT = "2026-09-01T16:35:53Z";
const P1_AUTHORIZATION_CORRECTION_VALIDATED_AT = "2026-09-01T18:27:41.110779Z";
const P1_AUTHORIZATION_CORRECTION_ACCEPTED_AT = "2026-09-01T18:27:41Z";
const P1_AUTHORIZATION_CORRECTION_EVIDENCE_PATH =
  "governance/evidence/p1-002-authorization-scope-correction.json";
const P1_AUTHORIZATION_CORRECTION_FINGERPRINT_PATH =
  "governance/evidence/p1-002-corrected-catalog-fingerprint-v2.json";
const P1_AUTHORIZATION_CORRECTION_FINGERPRINT_FILE_SHA256 =
  "c5bb94594f8a82915ad5a9faabbee00ad90bf782914de072bee8a6a5fa333e6f";
const P1_AUTHORIZATION_CORRECTION_FINGERPRINT_FILE_BYTES = 62644;
const P1_AUTHORIZATION_CORRECTION_CATALOG_SHA256 =
  "72825bbbfe9d8f0bdbbc4bb7967d8a343f552a0db104cc62f2e6b2fabae4323e";
const P1_AUTHORIZATION_CORRECTION_CATALOG_BYTES = 31443;
const P1_AUTHORIZATION_CORRECTION_CATALOG_ROWS = 102;
const P1_AUTHORIZATION_CORRECTION_BASELINE_SHA256 =
  "dd8e1c374e29f92578a1f10892991a4eaeaa1cb329f688d017c7d7a040632030";
const P1_AUTHORIZATION_CORRECTION_STATE_SHA256 =
  "29e71a548176a97251d8b61ddbd4acd21a50fedd865f29c41e557ebddc336ad6";
const P1_AUTHORIZATION_CORRECTION_DRIFT_CHECK =
  "Rosuno Staging persistent application passed 39/39 post-application checks with exact five-version history, corrected catalog fingerprint, retained P1-003 contract, zero relevant rows, and zero additional advisor findings.";
const P1_AUTHORIZATION_CORRECTION_CATEGORY_COUNTS = {
  table: 4,
  column: 25,
  constraint: 20,
  index: 8,
  foreign_key: 7,
  rls: 4,
  policy: 1,
  trigger: 1,
  function: 2,
  table_privilege: 20,
  function_privilege: 10,
};
const P1_AUTHORIZATION_CORRECTION_APPROVED_ADVISOR_IDENTITIES = [
  "rls_enabled_no_policy_public_application_sessions",
  "rls_enabled_no_policy_public_capability_definitions",
  "rls_enabled_no_policy_public_capability_grants",
  "rls_enabled_no_policy_public_jurisdiction_regulatory_modes",
  "rls_enabled_no_policy_public_jurisdictions",
  "rls_enabled_no_policy_public_launch_authorizations",
  "rls_enabled_no_policy_public_launch_gate_evaluations",
  "rls_enabled_no_policy_public_launch_gates",
  "rls_enabled_no_policy_public_policy_authority_references",
  "rls_enabled_no_policy_public_policy_types",
  "rls_enabled_no_policy_public_policy_versions",
  "rls_enabled_no_policy_public_regulatory_modes",
  "rls_enabled_no_policy_public_service_areas",
];
const P1_AUTHORIZATION_CORRECTION_MIGRATION_HISTORY = [
  ["20260828192126", "p0_restrict_rls_auto_enable_execution"],
  ["20260829000015", "p1_platform_foundation"],
  ["20260829171701", "p1_authorization_foundation"],
  ["20260830023823", "p1_jurisdiction_policy_launch_foundation"],
  ["20260901012518", "p1_authorization_scope_correction"],
];
const P1_AUTHORIZATION_MIGRATION_ID =
  "20260829171701_p1_authorization_foundation";
const P1_AUTHORIZATION_MIGRATION_PATH =
  "supabase/migrations/20260829171701_p1_authorization_foundation.sql";
const P1_AUTHORIZATION_MIGRATION_SHA256 =
  "6471ac68949234e29ae1cc492eaa2f77dc15ca010998f72898284b8c9a855fec";
const P1_AUTHORIZATION_DECISION_ID = "DEC-20260829-P1-AUTHORIZATION-FOUNDATION";
const P1_AUTHORIZATION_WORK_ITEM_ID = "WI-P1-002-AUTHORIZATION-FOUNDATION";
const P1_AUTHORIZATION_RELEASE_ID = "REL-20260830-P1-002-STAGING-APPLICATION";
const P1_AUTHORIZATION_REVIEWED_AT = "2026-08-29T20:38:38Z";
const P1_AUTHORIZATION_ACCEPTED_AT = "2026-08-30T01:32:02Z";
const P1_AUTHORIZATION_LIFECYCLE_EVIDENCE_PATH =
  "governance/evidence/p1-002-governance-lifecycle-correction.json";
const P1_GOVERNANCE_CORRECTION_DECISION_ID =
  "DEC-20260902-P1-002-GOVERNANCE-CONTROL-CORRECTION";
const P1_GOVERNANCE_CORRECTION_WORK_ITEM_ID =
  "WI-P1-002-GOVERNANCE-CONTROL-CORRECTION";
const FOUNDATION_BASELINE_ID = "rosuno-staging-foundation-20260901-v1";
const FOUNDATION_BASELINE_DIGEST =
  "6bb6920c2d418d27d0c406399c79ad1be2d9705f30ca2d6d364e54211d3156e8";
const FOUNDATION_BASELINE_MIGRATIONS = [
  {
    sequence: 1,
    migration_id: "20260828192126_p0_restrict_rls_auto_enable_execution",
    artifact_path:
      "supabase/migrations/20260828192126_p0_restrict_rls_auto_enable_execution.sql",
    sha256: P0_STORED_STATEMENT_SHA256,
  },
  {
    sequence: 2,
    migration_id: "20260829000015_p1_platform_foundation",
    artifact_path:
      "supabase/migrations/20260829000015_p1_platform_foundation.sql",
    sha256: "67dfd44b2bd7525a588e6eb59c33a0056f3a5c67eec5f45dd93e6aab37f7afc8",
  },
  {
    sequence: 3,
    migration_id: P1_AUTHORIZATION_MIGRATION_ID,
    artifact_path: P1_AUTHORIZATION_MIGRATION_PATH,
    sha256: P1_AUTHORIZATION_MIGRATION_SHA256,
  },
  {
    sequence: 4,
    migration_id: "20260830023823_p1_jurisdiction_policy_launch_foundation",
    artifact_path:
      "supabase/migrations/20260830023823_p1_jurisdiction_policy_launch_foundation.sql",
    sha256: "94e9b746cf303154790bc51e8160f9184b2e9765e82ec2702e03030f7a79b7ee",
  },
  {
    sequence: 5,
    migration_id: P1_AUTHORIZATION_CORRECTION_MIGRATION_ID,
    artifact_path: P1_AUTHORIZATION_CORRECTION_MIGRATION_PATH,
    sha256: P1_AUTHORIZATION_CORRECTION_MIGRATION_SHA256,
  },
];
const FOUNDATION_BASELINE_EVIDENCE = [
  {
    path: "governance/evidence/p1-003-jurisdiction-policy-launch-foundation.json",
    sha256: "59f4facdc8115606cedf517b17f690f050b8203287289ca6735ddaa26d7c6f34",
  },
  {
    path: P1_AUTHORIZATION_CORRECTION_EVIDENCE_PATH,
    sha256: "4f63b0d550d5a1a589549d031a7184ec7072cd96fdbd20a47918613e0fc6136f",
  },
  {
    path: P1_AUTHORIZATION_CORRECTION_FINGERPRINT_PATH,
    sha256: P1_AUTHORIZATION_CORRECTION_FINGERPRINT_FILE_SHA256,
  },
];
const P1_AUTHORIZATION_CORRECTION_CHRONOLOGY = [
  {
    commit: "6dfb6a5a98e0456c7f1b6876f0441aa1f0299429",
    description: "premature empty migration",
  },
  {
    commit: "4fe3ea3651643410e1e2dcc6ce1585736e64b866",
    description: "explicit revert",
  },
  {
    commit: "17c2025c4b0eacc78d2926b8acb3fd26ecee89f5",
    description: "premature migration checkpoint",
  },
  {
    commit: "4261b2d716e25bcc858918cb391bd826de3b234e",
    description: "explicit revert",
  },
  {
    commit: "fc687c9736f81265b66de3905d278114edf13d61",
    description: "fresh authorized implementation",
  },
  {
    commit: "c64e403420850689b163bf0d6e37a12ab590b805",
    description: "authorized dependency-guard correction",
  },
  {
    commit: "b7b862f4d03eb7c3686f539fdedf33e6e6812300",
    description: "out-of-scope .replit Python module addition",
  },
  {
    commit: "b90f697164723be80029a8756b5dde79bd5f2c6c",
    description: "explicit forward-only revert restoring canonical .replit",
  },
  {
    commit: "7ddf5426cc870f417ff4c91f239906fc0f348cd2",
    description:
      "separate non-ancestor internal Replit checkpoint carrying the same out-of-scope .replit tree; preserved but never imported",
  },
  {
    commit: "7802140d20b9e8cc05dadb9c4c9d1a6556dddd34",
    description: "authorized v2 evidence checkpoint",
  },
  {
    commit: "ba58456e757c0c330b13f846685546f480626923",
    description: "authorized governance/control checkpoint",
  },
];

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
  if (!["P0", "P1"].includes(record.priority)) {
    fail(`${context}.priority must be P0 or P1`);
  }
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
  if (!/^WI-P(?:0|1)-[A-Z0-9][A-Z0-9-]*$/.test(record.work_item_id)) {
    fail(`${context}.work_item_id has an invalid format`);
  }
  if (!record.work_item_id.startsWith(`WI-${record.priority}-`)) {
    fail(`${context}.work_item_id must match its priority`);
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
  if (
    artifact.migration_id !== `${artifact.version}_${artifact.name}` ||
    artifact.version !== "20260828192126" ||
    artifact.name !== "p0_restrict_rls_auto_enable_execution"
  ) {
    fail(`${context} historical P0 version and name are invalid`);
  }
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

export function validateP0CliInventory(
  sql,
  artifactPath = P0_CLI_INVENTORY_PATH,
  context = "P0 CLI inventory",
) {
  if (artifactPath !== P0_CLI_INVENTORY_PATH) {
    fail(`${context} path is not the authorized historical P0 inventory path`);
  }
  if (sql !== P0_STORED_EXECUTABLE_STATEMENT) {
    fail(
      `${context} must contain exactly the stored single P0 executable statement`,
    );
  }
}

export function validateP0InventoryReconciliation(
  evidence,
  migration,
  inventorySql,
  context = "P0 inventory reconciliation",
) {
  requireExactFields(
    evidence,
    [
      "version",
      "reconciliation_id",
      "migration_id",
      "historical_authority",
      "inventory_artifact",
      "reconciliation",
    ],
    context,
  );
  if (
    evidence.version !== 1 ||
    evidence.reconciliation_id !== "P0-CLI-INVENTORY-20260828192126" ||
    evidence.migration_id !== P0_MIGRATION_ID ||
    migration?.migration_id !== P0_MIGRATION_ID ||
    migration?.artifact_path !==
      "governance/migrations/20260828192126_p0_restrict_rls_auto_enable_execution.json"
  ) {
    fail(`${context} migration identity is invalid`);
  }

  const authority = evidence.historical_authority;
  requireExactFields(
    authority,
    [
      "environment",
      "project_name",
      "project_ref",
      "history_schema",
      "history_table",
      "history_version",
      "row_count",
      "stored_statement_count",
      "stored_statement_sha256",
      "query_mode",
    ],
    `${context}.historical_authority`,
  );
  if (
    authority.environment !== "staging" ||
    authority.project_name !== "Rosuno Staging" ||
    authority.project_ref !== "mxjlvmowmodzdtdfgqpb" ||
    authority.history_schema !== "supabase_migrations" ||
    authority.history_table !== "schema_migrations" ||
    authority.history_version !== "20260828192126" ||
    authority.row_count !== 1 ||
    authority.stored_statement_count !== 1 ||
    authority.stored_statement_sha256 !== P0_STORED_STATEMENT_SHA256 ||
    authority.query_mode !== "read_only"
  ) {
    fail(`${context}.historical_authority does not prove the exact source row`);
  }

  const inventory = evidence.inventory_artifact;
  requireExactFields(
    inventory,
    ["path", "version", "name", "statement_count", "statement_sha256"],
    `${context}.inventory_artifact`,
  );
  if (
    inventory.path !== P0_CLI_INVENTORY_PATH ||
    inventory.version !== "20260828192126" ||
    inventory.name !== "p0_restrict_rls_auto_enable_execution" ||
    inventory.statement_count !== 1 ||
    inventory.statement_sha256 !== P0_STORED_STATEMENT_SHA256
  ) {
    fail(`${context}.inventory_artifact is invalid`);
  }
  validateP0CliInventory(inventorySql, inventory.path, `${context}.inventory`);

  const reconciliation = evidence.reconciliation;
  requireExactFields(
    reconciliation,
    [
      "purpose",
      "reason",
      "statement_semantics",
      "authority_conflict",
      "replay_authorized",
      "remote_history_mutated",
      "remote_schema_mutated",
    ],
    `${context}.reconciliation`,
  );
  if (
    reconciliation.purpose !==
      "repository inventory representation of an already-applied migration" ||
    reconciliation.reason !==
      "Rosuno Staging contains the historical P0 migration row while the local Supabase CLI inventory did not; representing its exact stored statement reconciles inventory without replay." ||
    reconciliation.statement_semantics !==
      "revoke direct EXECUTE from PUBLIC, anon, and authenticated while retaining postgres and service_role and changing nothing else" ||
    reconciliation.authority_conflict !== "none" ||
    reconciliation.replay_authorized !== false ||
    reconciliation.remote_history_mutated !== false ||
    reconciliation.remote_schema_mutated !== false
  ) {
    fail(`${context}.reconciliation is invalid`);
  }
  if (scanSecretLikeText(JSON.stringify(evidence), context).length > 0) {
    fail(`${context} contains a secret-like value`);
  }
}

export function validateP1PlatformMigration(
  sql,
  migration,
  context = "P1 platform migration",
) {
  if (migration.migration_id !== "20260829000015_p1_platform_foundation") {
    fail(`${context}.migration_id is not the authorized first P1 migration`);
  }
  requireBoundedString(sql, context, 20000);
  const createTables = [
    ...sql.matchAll(/\bcreate\s+table\s+([a-z0-9_.]+)/gi),
  ].map((match) => match[1].toLowerCase());
  if (JSON.stringify(createTables) !== JSON.stringify(["public.users"])) {
    fail(`${context} may create only public.users`);
  }
  const requiredPatterns = [
    /create\s+function\s+public\.set_updated_at\s*\(\s*\)/i,
    /security\s+invoker/i,
    /set\s+search_path\s*=\s*pg_catalog/i,
    /id\s+uuid\s+primary\s+key\s+default\s+gen_random_uuid\s*\(\s*\)/i,
    /auth_user_id\s+uuid\s+not\s+null/i,
    /references\s+auth\.users\s*\(\s*id\s*\)/i,
    /on\s+delete\s+restrict/i,
    /unique\s*\(\s*auth_user_id\s*\)/i,
    /alter\s+table\s+public\.users\s+enable\s+row\s+level\s+security/i,
    /revoke\s+all\s+on\s+table\s+public\.users\s+from\s+anon/i,
    /revoke\s+all\s+on\s+table\s+public\.users\s+from\s+authenticated/i,
    /grant\s+select\s+on\s+table\s+public\.users\s+to\s+authenticated/i,
    /revoke\s+all\s+on\s+table\s+public\.users\s+from\s+service_role/i,
    /grant\s+select\s*,\s*insert\s*,\s*update\s+on\s+table\s+public\.users\s+to\s+service_role/i,
    /create\s+policy\s+users_select_own/i,
    /to\s+authenticated\s+using\s*\(/i,
    /auth\.uid\s*\(\s*\)/i,
    /revoke\s+execute\s+on\s+function\s+public\.set_updated_at\s*\(\s*\)\s+from\s+public/i,
    /grant\s+execute\s+on\s+function\s+public\.set_updated_at\s*\(\s*\)\s+to\s+service_role/i,
    /create\s+trigger\s+users_set_updated_at/i,
  ];
  for (const pattern of requiredPatterns) {
    if (!pattern.test(sql)) fail(`${context} is missing ${pattern}`);
  }
  for (const state of [
    "pending_verification",
    "active",
    "suspended",
    "closed",
  ]) {
    if (!sql.includes(`'${state}'`)) {
      fail(`${context} is missing account state ${state}`);
    }
  }
  if (/security\s+definer/i.test(sql)) {
    fail(`${context} may not add a SECURITY DEFINER function`);
  }
  if (/\bcreate\s+extension\b/i.test(sql)) {
    fail(`${context} may not add an unproven extension dependency`);
  }
  if (/grant\s+[^;]*delete[^;]*\s+to\s+service_role/i.test(sql)) {
    fail(`${context} may not grant service_role identity deletion`);
  }
  if (
    /\b(client_profiles|attorney_profiles|staff_profiles|capability_grants|jurisdictions|consultation_requests|bookings|payments?)\b/i.test(
      sql,
    )
  ) {
    fail(`${context} crosses the authorized Migration 1 boundary`);
  }
  if (scanSecretLikeText(sql, context).length > 0) {
    fail(`${context} contains a secret-like value`);
  }
}

export function validateP1AuthorizationMigration(
  sql,
  migration,
  context = "P1 authorization migration",
) {
  if (
    migration.migration_id !== "20260829171701_p1_authorization_foundation" ||
    migration.sequence !== 3 ||
    migration.depends_on?.join("|") !== "20260829000015_p1_platform_foundation"
  ) {
    fail(`${context}.migration_id, sequence, or dependency is invalid`);
  }
  requireBoundedString(sql, context, 60000);
  const tables = [
    "client_profiles",
    "attorney_profiles",
    "staff_profiles",
    "capability_definitions",
    "capability_grants",
    "application_sessions",
  ];
  const createTables = [
    ...sql.matchAll(/\bcreate\s+table\s+([a-z0-9_.]+)/gi),
  ].map((match) => match[1].toLowerCase());
  if (
    JSON.stringify(createTables) !==
    JSON.stringify(tables.map((table) => `public.${table}`))
  ) {
    fail(
      `${context} must create exactly the six authorized Migration 2 tables`,
    );
  }
  for (const table of tables) {
    for (const pattern of [
      new RegExp(
        `alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`,
        "i",
      ),
      new RegExp(
        `revoke\\s+all\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+public`,
        "i",
      ),
      new RegExp(
        `revoke\\s+all\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+anon`,
        "i",
      ),
      new RegExp(
        `revoke\\s+all\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+authenticated`,
        "i",
      ),
      new RegExp(
        `revoke\\s+all\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+service_role`,
        "i",
      ),
      new RegExp(
        `grant\\s+select\\s*,\\s*insert\\s*,\\s*update\\s+on\\s+table\\s+public\\.${table}\\s+to\\s+service_role`,
        "i",
      ),
      new RegExp(
        `create\\s+trigger\\s+${table}_set_updated_at[\\s\\S]*?on\\s+public\\.${table}[\\s\\S]*?execute\\s+function\\s+public\\.set_updated_at\\s*\\(\\s*\\)`,
        "i",
      ),
    ]) {
      if (!pattern.test(sql)) fail(`${context} is missing ${pattern}`);
    }
  }
  for (const profile of [
    "client_profiles",
    "attorney_profiles",
    "staff_profiles",
  ]) {
    for (const pattern of [
      new RegExp(
        `constraint\\s+${profile}_user_id_key\\s+unique\\s*\\(\\s*user_id\\s*\\)`,
        "i",
      ),
      new RegExp(
        `constraint\\s+${profile}_user_id_fkey[\\s\\S]*?foreign\\s+key\\s*\\(\\s*user_id\\s*\\)[\\s\\S]*?references\\s+public\\.users\\s*\\(\\s*id\\s*\\)[\\s\\S]*?on\\s+update\\s+restrict[\\s\\S]*?on\\s+delete\\s+restrict`,
        "i",
      ),
      new RegExp(
        `grant\\s+select\\s+on\\s+table\\s+public\\.${profile}\\s+to\\s+authenticated`,
        "i",
      ),
      new RegExp(
        `create\\s+policy\\s+${profile}_select_own[\\s\\S]*?on\\s+public\\.${profile}[\\s\\S]*?to\\s+authenticated[\\s\\S]*?public\\.users[\\s\\S]*?auth\\.uid\\s*\\(\\s*\\)`,
        "i",
      ),
    ]) {
      if (!pattern.test(sql)) fail(`${context} is missing ${pattern}`);
    }
  }
  for (const profile of ["attorney_profiles", "staff_profiles"]) {
    for (const pattern of [
      new RegExp(
        `constraint\\s+${profile}_lifecycle_state_check[\\s\\S]*?pending_verification[\\s\\S]*?active[\\s\\S]*?suspended[\\s\\S]*?closed`,
        "i",
      ),
      new RegExp(
        `constraint\\s+${profile}_years_experience_check[\\s\\S]*?years_experience\\s+is\\s+null\\s+or\\s+years_experience\\s*>=\\s*0`,
        "i",
      ),
    ]) {
      if (!pattern.test(sql)) fail(`${context} is missing ${pattern}`);
    }
  }
  const requiredPatterns = [
    /constraint\s+capability_definitions_capability_code_key\s+unique\s*\(\s*capability_code\s*\)/i,
    /create\s+index\s+capability_grants_user_capability_idx\s+on\s+public\.capability_grants\s*\(\s*user_id\s*,\s*capability_definition_id\s*,\s*valid_from\s*\)/i,
    /jurisdiction_id\s+uuid\s*,/i,
    /constraint\s+capability_grants_validity_check[\s\S]*?valid_until\s+is\s+null\s+or\s+valid_until\s*>\s*valid_from/i,
    /constraint\s+capability_grants_granted_at_check[\s\S]*?granted_at\s*<=\s*valid_from/i,
    /constraint\s+capability_grants_revoked_at_check[\s\S]*?revoked_at\s+is\s+null\s+or\s+revoked_at\s*>=\s*granted_at/i,
    /constraint\s+application_sessions_session_reference_key\s+unique\s*\(\s*session_reference\s*\)/i,
    /create\s+table\s+public\.application_sessions[\s\S]*?constraint\s+application_sessions_user_id_fkey\s+foreign\s+key\s*\(\s*user_id\s*\)[\s\S]*?references\s+public\.users\s*\(\s*id\s*\)[\s\S]*?on\s+update\s+restrict[\s\S]*?on\s+delete\s+restrict/i,
    /constraint\s+application_sessions_expiry_check[\s\S]*?expires_at\s*>\s*created_at/i,
    /constraint\s+application_sessions_revoked_at_check[\s\S]*?revoked_at\s+is\s+null\s+or\s+revoked_at\s*>=\s*created_at/i,
  ];
  for (const pattern of requiredPatterns) {
    if (!pattern.test(sql)) fail(`${context} is missing ${pattern}`);
  }
  if (
    /foreign\s+key\s*\(\s*jurisdiction_id\s*\)/i.test(sql) ||
    /references\s+public\.jurisdictions/i.test(sql)
  ) {
    fail(
      `${context} may not add a jurisdiction foreign key before Migration 3`,
    );
  }
  if (
    /grant\s+[^;]*\s+on\s+table\s+public\.(?:capability_definitions|capability_grants|application_sessions)\s+to\s+(?:public|anon|authenticated)/i.test(
      sql,
    )
  ) {
    fail(`${context} may not expose capability or session tables`);
  }
  if (
    /grant\s+[^;]*delete[^;]*\s+to\s+service_role/i.test(sql) ||
    /grant\s+(?:insert|update|delete)[^;]*\s+to\s+authenticated/i.test(sql)
  ) {
    fail(`${context} weakens the required write boundary`);
  }
  if (
    /\bcreate\s+(?:or\s+replace\s+)?function\b/i.test(sql) ||
    /security\s+definer/i.test(sql) ||
    /\bcreate\s+extension\b/i.test(sql) ||
    /\b(?:insert\s+into|copy)\b/i.test(sql)
  ) {
    fail(`${context} may not add functions, extensions, or seed data`);
  }
  if (
    /\bcreate\s+table\s+public\.(?:instant_availability_intents|jurisdictions|consultation_requests|bookings|payments?)\b/i.test(
      sql,
    )
  ) {
    fail(`${context} crosses the authorized Migration 2 boundary`);
  }
  if (
    /\balter\s+(?:table|function)\s+public\.(?:users|set_updated_at)\b/i.test(
      sql,
    )
  ) {
    fail(`${context} may not alter P1-001 objects`);
  }
  if (scanSecretLikeText(sql, context).length > 0) {
    fail(`${context} contains a secret-like value`);
  }
}

export function validateP1AuthorizationCorrectionMigration(
  sql,
  migration,
  context = "P1 authorization scope correction migration",
) {
  if (
    migration.migration_id !== P1_AUTHORIZATION_CORRECTION_MIGRATION_ID ||
    migration.sequence !== 5 ||
    migration.depends_on?.join("|") !==
      "20260830023823_p1_jurisdiction_policy_launch_foundation"
  ) {
    fail(`${context}.migration_id, sequence, or dependency is invalid`);
  }
  requireBoundedString(sql, context, 20000);

  const droppedTables = [
    ...sql.matchAll(/\bdrop\s+table\s+public\.([a-z0-9_]+)/gi),
  ].map((match) => match[1].toLowerCase());
  if (
    JSON.stringify(droppedTables) !==
    JSON.stringify(["attorney_profiles", "client_profiles"])
  ) {
    fail(`${context} must drop exactly attorney_profiles and client_profiles`);
  }
  if (
    !/drop\s+table\s+public\.attorney_profiles\s+restrict\s*;/i.test(sql) ||
    !/drop\s+table\s+public\.client_profiles\s+restrict\s*;/i.test(sql) ||
    /\bcascade\b/i.test(sql)
  ) {
    fail(`${context} drops must be RESTRICT and may not use CASCADE`);
  }

  const allowedMutationTables = new Set([
    "attorney_profiles",
    "client_profiles",
    "staff_profiles",
    "capability_definitions",
    "capability_grants",
    "application_sessions",
  ]);
  const mutationTablePatterns = [
    /\b(?:alter\s+table|drop\s+table|comment\s+on\s+table|revoke\s+all\s+on\s+table)\s+public\.([a-z0-9_]+)/gi,
    /\bgrant\s+[^;]*?\s+on\s+table\s+public\.([a-z0-9_]+)/gi,
    /\bcomment\s+on\s+column\s+public\.([a-z0-9_]+)\.[a-z0-9_]+/gi,
    /\bdrop\s+trigger\s+[a-z0-9_]+\s+on\s+public\.([a-z0-9_]+)/gi,
  ];
  const mutationTables = mutationTablePatterns.flatMap((pattern) =>
    [...sql.matchAll(pattern)].map((match) => match[1].toLowerCase()),
  );
  const unauthorizedMutationTables = mutationTables.filter(
    (table) => !allowedMutationTables.has(table),
  );
  if (unauthorizedMutationTables.length > 0 || /\bbookings?\b/i.test(sql)) {
    fail(`${context} crosses the authorized P1-002 correction table boundary`);
  }

  for (const table of [
    "staff_profiles",
    "capability_definitions",
    "capability_grants",
    "application_sessions",
  ]) {
    if (!new RegExp(`alter\\s+table\\s+public\\.${table}\\b`, "i").test(sql)) {
      fail(`${context} does not retain and correct public.${table}`);
    }
  }
  if (
    /\b(?:drop|create)\s+table\s+public\.capability_grants\b/i.test(sql) ||
    !/alter\s+table\s+public\.capability_grants\b/i.test(sql)
  ) {
    fail(`${context} must correct capability_grants in place`);
  }
  if (
    !/capability_grants_jurisdiction_id_fkey/i.test(sql) ||
    !/foreign\s+key\s*\(\s*jurisdiction_id\s*\)\s+references\s+(?:public\.)?jurisdictions\s*\(\s*id\s*\)\s+on\s+update\s+restrict\s+on\s+delete\s+restrict/i.test(
      sql,
    ) ||
    !/Optional jurisdiction scope enforced by locked physical Migration 3\./.test(
      sql,
    )
  ) {
    fail(`${context} does not preserve the exact P1-003 jurisdiction contract`);
  }
  const digest = createHash("sha256").update(sql).digest("hex");
  if (
    digest !== P1_AUTHORIZATION_CORRECTION_MIGRATION_SHA256 ||
    Buffer.byteLength(sql, "utf8") !==
      P1_AUTHORIZATION_CORRECTION_MIGRATION_BYTES
  ) {
    fail(`${context} bytes differ from the authorized correction`);
  }
  if (scanSecretLikeText(sql, context).length > 0) {
    fail(`${context} contains a secret-like value`);
  }
}

export function validateP1RegulatoryMigration(
  sql,
  migration,
  context = "P1 jurisdiction/policy/launch migration",
) {
  if (
    migration.migration_id !==
      "20260830023823_p1_jurisdiction_policy_launch_foundation" ||
    migration.sequence !== 4 ||
    migration.depends_on?.join("|") !==
      "20260829171701_p1_authorization_foundation"
  ) {
    fail(`${context}.migration_id, sequence, or dependency is invalid`);
  }
  requireBoundedString(sql, context, 80000);
  const tables = [
    "jurisdictions",
    "service_areas",
    "regulatory_modes",
    "jurisdiction_regulatory_modes",
    "policy_types",
    "policy_versions",
    "policy_authority_references",
    "launch_gates",
    "launch_gate_evaluations",
    "launch_authorizations",
  ];
  const createTables = [
    ...sql.matchAll(/\bcreate\s+table\s+([a-z0-9_.]+)/gi),
  ].map((match) => match[1].toLowerCase());
  if (
    JSON.stringify(createTables) !==
    JSON.stringify(tables.map((table) => `public.${table}`))
  ) {
    fail(
      `${context} must create exactly the ten authorized Migration 3 tables`,
    );
  }
  for (const table of tables) {
    for (const pattern of [
      new RegExp(
        `alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`,
        "i",
      ),
      new RegExp(
        `revoke\\s+all\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+public`,
        "i",
      ),
      new RegExp(
        `revoke\\s+all\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+anon`,
        "i",
      ),
      new RegExp(
        `revoke\\s+all\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+authenticated`,
        "i",
      ),
      new RegExp(
        `revoke\\s+all\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+service_role`,
        "i",
      ),
      new RegExp(
        `grant\\s+select\\s*,\\s*insert\\s*,\\s*update\\s+on\\s+table\\s+public\\.${table}\\s+to\\s+service_role`,
        "i",
      ),
    ]) {
      if (!pattern.test(sql)) fail(`${context} is missing ${pattern}`);
    }
  }
  const requiredPatterns = [
    /constraint\s+jurisdictions_lifecycle_state_check[\s\S]*?'unsupported'[\s\S]*?'waitlist'[\s\S]*?'staged'[\s\S]*?'ready'[\s\S]*?'live'[\s\S]*?'restricted'[\s\S]*?'suspended'/i,
    /constraint\s+service_areas_jurisdiction_id_fkey[\s\S]*?references\s+public\.jurisdictions\s*\(\s*id\s*\)[\s\S]*?on\s+update\s+restrict[\s\S]*?on\s+delete\s+restrict/i,
    /constraint\s+jurisdiction_regulatory_modes_pkey\s+primary\s+key\s*\(\s*jurisdiction_id\s*,\s*regulatory_mode_id\s*,\s*active_from\s*\)/i,
    /constraint\s+policy_versions_scope_version_key\s+unique\s+nulls\s+not\s+distinct/i,
    /constraint\s+policy_versions_parameters_check[\s\S]*?jsonb_typeof\s*\(\s*parameters\s*\)\s*=\s*'object'/i,
    /constraint\s+policy_versions_status_check[\s\S]*?'draft'[\s\S]*?'internal_review'[\s\S]*?'counsel_review'[\s\S]*?'approved'[\s\S]*?'scheduled'[\s\S]*?'active'[\s\S]*?'suspended'[\s\S]*?'retired'/i,
    /constraint\s+policy_versions_approval_pair_check/i,
    /constraint\s+policy_versions_approval_state_check/i,
    /constraint\s+policy_authority_references_verified_actor_check/i,
    /alter\s+table\s+public\.capability_grants[\s\S]*?add\s+constraint\s+capability_grants_jurisdiction_id_fkey[\s\S]*?references\s+public\.jurisdictions\s*\(\s*id\s*\)[\s\S]*?on\s+update\s+restrict[\s\S]*?on\s+delete\s+restrict/i,
    /create\s+function\s+public\.enforce_policy_authority_provenance\s*\(\s*\)[\s\S]*?security\s+invoker[\s\S]*?set\s+search_path\s*=\s*pg_catalog/i,
    /approved policy version requires verified authority provenance/i,
    /create\s+function\s+public\.enforce_jurisdiction_live_authorization\s*\(\s*\)[\s\S]*?security\s+invoker[\s\S]*?set\s+search_path\s*=\s*pg_catalog/i,
    /live jurisdiction requires explicit active launch authorization/i,
    /create\s+constraint\s+trigger\s+policy_versions_require_authority/i,
    /create\s+constraint\s+trigger\s+policy_authority_references_preserve_approval/i,
    /create\s+constraint\s+trigger\s+jurisdictions_require_launch_authorization/i,
    /create\s+constraint\s+trigger\s+launch_authorizations_preserve_live_boundary/i,
  ];
  for (const pattern of requiredPatterns) {
    if (!pattern.test(sql)) fail(`${context} is missing ${pattern}`);
  }
  for (const functionName of [
    "enforce_policy_authority_provenance",
    "enforce_jurisdiction_live_authorization",
  ]) {
    for (const role of ["public", "anon", "authenticated"]) {
      const pattern = new RegExp(
        `revoke\\s+execute\\s+on\\s+function\\s+public\\.${functionName}\\s*\\(\\s*\\)\\s+from\\s+${role}`,
        "i",
      );
      if (!pattern.test(sql)) fail(`${context} is missing ${pattern}`);
    }
    for (const role of ["postgres", "service_role"]) {
      const pattern = new RegExp(
        `grant\\s+execute\\s+on\\s+function\\s+public\\.${functionName}\\s*\\(\\s*\\)\\s+to\\s+${role}`,
        "i",
      );
      if (!pattern.test(sql)) fail(`${context} is missing ${pattern}`);
    }
  }
  if (
    /\bcreate\s+policy\b/i.test(sql) ||
    /grant\s+[^;]*\s+on\s+table\s+public\.(?:jurisdictions|service_areas|regulatory_modes|jurisdiction_regulatory_modes|policy_types|policy_versions|policy_authority_references|launch_gates|launch_gate_evaluations|launch_authorizations)\s+to\s+(?:public|anon|authenticated)/i.test(
      sql,
    )
  ) {
    fail(`${context} may not add a client-facing policy or table privilege`);
  }
  if (
    /grant\s+[^;]*delete[^;]*\s+to\s+service_role/i.test(sql) ||
    /security\s+definer/i.test(sql) ||
    /\bcreate\s+extension\b/i.test(sql) ||
    /\b(?:insert\s+into|copy)\b/i.test(sql)
  ) {
    fail(`${context} weakens security or adds an extension or seed data`);
  }
  if (/\b(?:california|ca_lrs|lrs)\b/i.test(sql)) {
    fail(`${context} may not encode a California-specific core assumption`);
  }
  if (
    /\bcreate\s+table\s+public\.(?:attorney_service_areas|licenses|attorney_licenses|insurance|discipline|verification|instant_availability_intents|consultation_requests|bookings|payments?|referrals?)\b/i.test(
      sql,
    )
  ) {
    fail(`${context} crosses the authorized Migration 3 boundary`);
  }
  if (/\b(?:drop|truncate)\s+(?:table|function)\b/i.test(sql)) {
    fail(`${context} may not drop or truncate an existing object`);
  }
  if (scanSecretLikeText(sql, context).length > 0) {
    fail(`${context} contains a secret-like value`);
  }
}

const P1_REGULATORY_TABLES = [
  "jurisdictions",
  "service_areas",
  "regulatory_modes",
  "jurisdiction_regulatory_modes",
  "policy_types",
  "policy_versions",
  "policy_authority_references",
  "launch_gates",
  "launch_gate_evaluations",
  "launch_authorizations",
];

const P1_REGULATORY_CONSTRAINTS = [
  ["jurisdictions", "jurisdictions_pkey", "p"],
  ["jurisdictions", "jurisdictions_code_key", "u"],
  ["jurisdictions", "jurisdictions_code_check", "c"],
  ["jurisdictions", "jurisdictions_lifecycle_state_check", "c"],
  ["jurisdictions", "jurisdictions_require_launch_authorization", "t"],
  ["service_areas", "service_areas_pkey", "p"],
  ["service_areas", "service_areas_jurisdiction_id_code_key", "u"],
  ["service_areas", "service_areas_jurisdiction_id_fkey", "f"],
  ["service_areas", "service_areas_code_check", "c"],
  ["service_areas", "service_areas_effective_period_check", "c"],
  ["regulatory_modes", "regulatory_modes_pkey", "p"],
  ["regulatory_modes", "regulatory_modes_code_key", "u"],
  ["regulatory_modes", "regulatory_modes_code_check", "c"],
  ["jurisdiction_regulatory_modes", "jurisdiction_regulatory_modes_pkey", "p"],
  [
    "jurisdiction_regulatory_modes",
    "jurisdiction_regulatory_modes_jurisdiction_id_fkey",
    "f",
  ],
  [
    "jurisdiction_regulatory_modes",
    "jurisdiction_regulatory_modes_regulatory_mode_id_fkey",
    "f",
  ],
  [
    "jurisdiction_regulatory_modes",
    "jurisdiction_regulatory_modes_effective_period_check",
    "c",
  ],
  ["policy_types", "policy_types_pkey", "p"],
  ["policy_types", "policy_types_code_check", "c"],
  ["policy_versions", "policy_versions_pkey", "p"],
  ["policy_versions", "policy_versions_scope_version_key", "u"],
  ["policy_versions", "policy_versions_policy_type_code_fkey", "f"],
  ["policy_versions", "policy_versions_jurisdiction_id_fkey", "f"],
  ["policy_versions", "policy_versions_regulatory_mode_id_fkey", "f"],
  ["policy_versions", "policy_versions_approved_by_user_id_fkey", "f"],
  ["policy_versions", "policy_versions_supersedes_policy_version_id_fkey", "f"],
  ["policy_versions", "policy_versions_parameters_check", "c"],
  ["policy_versions", "policy_versions_status_check", "c"],
  ["policy_versions", "policy_versions_effective_period_check", "c"],
  ["policy_versions", "policy_versions_approval_pair_check", "c"],
  ["policy_versions", "policy_versions_approval_state_check", "c"],
  ["policy_versions", "policy_versions_effective_state_check", "c"],
  ["policy_versions", "policy_versions_not_self_superseding_check", "c"],
  ["policy_versions", "policy_versions_require_authority", "t"],
  ["policy_authority_references", "policy_authority_references_pkey", "p"],
  [
    "policy_authority_references",
    "policy_authority_references_policy_version_id_fkey",
    "f",
  ],
  [
    "policy_authority_references",
    "policy_authority_references_verified_by_user_id_fkey",
    "f",
  ],
  [
    "policy_authority_references",
    "policy_authority_references_verified_actor_check",
    "c",
  ],
  [
    "policy_authority_references",
    "policy_authority_references_preserve_approval",
    "t",
  ],
  ["launch_gates", "launch_gates_pkey", "p"],
  ["launch_gates", "launch_gates_jurisdiction_id_gate_code_key", "u"],
  ["launch_gates", "launch_gates_jurisdiction_id_fkey", "f"],
  ["launch_gates", "launch_gates_gate_code_check", "c"],
  ["launch_gate_evaluations", "launch_gate_evaluations_pkey", "p"],
  [
    "launch_gate_evaluations",
    "launch_gate_evaluations_launch_gate_id_fkey",
    "f",
  ],
  [
    "launch_gate_evaluations",
    "launch_gate_evaluations_evaluated_by_user_id_fkey",
    "f",
  ],
  [
    "launch_gate_evaluations",
    "launch_gate_evaluations_evidence_reference_check",
    "c",
  ],
  ["launch_authorizations", "launch_authorizations_pkey", "p"],
  ["launch_authorizations", "launch_authorizations_jurisdiction_id_fkey", "f"],
  [
    "launch_authorizations",
    "launch_authorizations_authorized_by_user_id_fkey",
    "f",
  ],
  ["launch_authorizations", "launch_authorizations_reason_check", "c"],
  ["launch_authorizations", "launch_authorizations_revoked_at_check", "c"],
  [
    "launch_authorizations",
    "launch_authorizations_preserve_live_boundary",
    "t",
  ],
];

const P1_REGULATORY_INDEXES = [
  [
    "jurisdiction_regulatory_modes",
    "jurisdiction_regulatory_modes_pkey",
    ["jurisdiction_id", "regulatory_mode_id", "active_from"],
    true,
    "jurisdiction_regulatory_modes_pkey",
    "p",
  ],
  [
    "jurisdictions",
    "jurisdictions_code_key",
    ["code"],
    false,
    "jurisdictions_code_key",
    "u",
  ],
  [
    "jurisdictions",
    "jurisdictions_pkey",
    ["id"],
    true,
    "jurisdictions_pkey",
    "p",
  ],
  [
    "launch_authorizations",
    "launch_authorizations_pkey",
    ["id"],
    true,
    "launch_authorizations_pkey",
    "p",
  ],
  [
    "launch_gate_evaluations",
    "launch_gate_evaluations_pkey",
    ["id"],
    true,
    "launch_gate_evaluations_pkey",
    "p",
  ],
  [
    "launch_gates",
    "launch_gates_jurisdiction_id_gate_code_key",
    ["jurisdiction_id", "gate_code"],
    false,
    "launch_gates_jurisdiction_id_gate_code_key",
    "u",
  ],
  ["launch_gates", "launch_gates_pkey", ["id"], true, "launch_gates_pkey", "p"],
  [
    "policy_authority_references",
    "policy_authority_references_pkey",
    ["id"],
    true,
    "policy_authority_references_pkey",
    "p",
  ],
  [
    "policy_types",
    "policy_types_pkey",
    ["code"],
    true,
    "policy_types_pkey",
    "p",
  ],
  [
    "policy_versions",
    "policy_versions_pkey",
    ["id"],
    true,
    "policy_versions_pkey",
    "p",
  ],
  [
    "policy_versions",
    "policy_versions_scope_version_key",
    [
      "policy_type_code",
      "jurisdiction_id",
      "regulatory_mode_id",
      "version_label",
    ],
    false,
    "policy_versions_scope_version_key",
    "u",
  ],
  [
    "regulatory_modes",
    "regulatory_modes_code_key",
    ["code"],
    false,
    "regulatory_modes_code_key",
    "u",
  ],
  [
    "regulatory_modes",
    "regulatory_modes_pkey",
    ["id"],
    true,
    "regulatory_modes_pkey",
    "p",
  ],
  [
    "service_areas",
    "service_areas_jurisdiction_id_code_key",
    ["jurisdiction_id", "code"],
    false,
    "service_areas_jurisdiction_id_code_key",
    "u",
  ],
  [
    "service_areas",
    "service_areas_pkey",
    ["id"],
    true,
    "service_areas_pkey",
    "p",
  ],
];

const P1_REGULATORY_FOREIGN_KEYS = [
  [
    "service_areas",
    "service_areas_jurisdiction_id_fkey",
    ["jurisdiction_id"],
    "jurisdictions",
    ["id"],
  ],
  [
    "jurisdiction_regulatory_modes",
    "jurisdiction_regulatory_modes_jurisdiction_id_fkey",
    ["jurisdiction_id"],
    "jurisdictions",
    ["id"],
  ],
  [
    "jurisdiction_regulatory_modes",
    "jurisdiction_regulatory_modes_regulatory_mode_id_fkey",
    ["regulatory_mode_id"],
    "regulatory_modes",
    ["id"],
  ],
  [
    "policy_versions",
    "policy_versions_policy_type_code_fkey",
    ["policy_type_code"],
    "policy_types",
    ["code"],
  ],
  [
    "policy_versions",
    "policy_versions_jurisdiction_id_fkey",
    ["jurisdiction_id"],
    "jurisdictions",
    ["id"],
  ],
  [
    "policy_versions",
    "policy_versions_regulatory_mode_id_fkey",
    ["regulatory_mode_id"],
    "regulatory_modes",
    ["id"],
  ],
  [
    "policy_versions",
    "policy_versions_approved_by_user_id_fkey",
    ["approved_by_user_id"],
    "users",
    ["id"],
  ],
  [
    "policy_versions",
    "policy_versions_supersedes_policy_version_id_fkey",
    ["supersedes_policy_version_id"],
    "policy_versions",
    ["id"],
  ],
  [
    "policy_authority_references",
    "policy_authority_references_policy_version_id_fkey",
    ["policy_version_id"],
    "policy_versions",
    ["id"],
  ],
  [
    "policy_authority_references",
    "policy_authority_references_verified_by_user_id_fkey",
    ["verified_by_user_id"],
    "users",
    ["id"],
  ],
  [
    "launch_gates",
    "launch_gates_jurisdiction_id_fkey",
    ["jurisdiction_id"],
    "jurisdictions",
    ["id"],
  ],
  [
    "launch_gate_evaluations",
    "launch_gate_evaluations_launch_gate_id_fkey",
    ["launch_gate_id"],
    "launch_gates",
    ["id"],
  ],
  [
    "launch_gate_evaluations",
    "launch_gate_evaluations_evaluated_by_user_id_fkey",
    ["evaluated_by_user_id"],
    "users",
    ["id"],
  ],
  [
    "launch_authorizations",
    "launch_authorizations_jurisdiction_id_fkey",
    ["jurisdiction_id"],
    "jurisdictions",
    ["id"],
  ],
  [
    "launch_authorizations",
    "launch_authorizations_authorized_by_user_id_fkey",
    ["authorized_by_user_id"],
    "users",
    ["id"],
  ],
  [
    "capability_grants",
    "capability_grants_jurisdiction_id_fkey",
    ["jurisdiction_id"],
    "jurisdictions",
    ["id"],
  ],
];

export const P1_REGULATORY_CATALOG_SQL = String.raw`
WITH target_tables(schema_name, table_name) AS (
  VALUES
    ('public','jurisdictions'),
    ('public','service_areas'),
    ('public','regulatory_modes'),
    ('public','jurisdiction_regulatory_modes'),
    ('public','policy_types'),
    ('public','policy_versions'),
    ('public','policy_authority_references'),
    ('public','launch_gates'),
    ('public','launch_gate_evaluations'),
    ('public','launch_authorizations')
),
constraint_rows AS (
  SELECT
    n.nspname::text AS "schema",
    tbl.relname::text AS "table",
    con.conname::text AS name,
    con.contype::text AS type,
    pg_get_constraintdef(con.oid, true) AS definition,
    ref_ns.nspname::text AS referenced_schema,
    ref.relname::text AS referenced_table
  FROM pg_constraint con
  JOIN pg_class tbl ON tbl.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = tbl.relnamespace
  JOIN target_tables target
    ON target.schema_name = n.nspname
   AND target.table_name = tbl.relname
  LEFT JOIN pg_class ref ON ref.oid = con.confrelid
  LEFT JOIN pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace
),
index_rows AS (
  SELECT
    n.nspname::text AS "schema",
    tbl.relname::text AS "table",
    idx.relname::text AS name,
    COALESCE((
      SELECT jsonb_agg(pg_get_indexdef(idx.oid, item.ordinal, true) ORDER BY item.ordinal)
      FROM generate_series(1, ind.indnkeyatts) item(ordinal)
    ), '[]'::jsonb) AS columns,
    ind.indisunique AS is_unique,
    ind.indisprimary AS is_primary,
    own_constraint.oid IS NOT NULL AS constraint_backed,
    own_constraint.conname::text AS associated_constraint_name,
    own_constraint.contype::text AS associated_constraint_type,
    pg_get_indexdef(idx.oid) AS definition
  FROM pg_index ind
  JOIN pg_class tbl ON tbl.oid = ind.indrelid
  JOIN pg_namespace n ON n.oid = tbl.relnamespace
  JOIN pg_class idx ON idx.oid = ind.indexrelid
  JOIN target_tables target
    ON target.schema_name = n.nspname
   AND target.table_name = tbl.relname
  LEFT JOIN pg_constraint own_constraint
    ON own_constraint.conindid = idx.oid
   AND own_constraint.conrelid = tbl.oid
   AND own_constraint.contype IN ('p', 'u', 'x')
),
foreign_key_rows AS (
  SELECT
    n.nspname::text AS "schema",
    src.relname::text AS "table",
    con.conname::text AS name,
    COALESCE((
      SELECT jsonb_agg(attr.attname ORDER BY item.ordinal)
      FROM unnest(con.conkey) WITH ORDINALITY item(attnum, ordinal)
      JOIN pg_attribute attr
        ON attr.attrelid = con.conrelid
       AND attr.attnum = item.attnum
    ), '[]'::jsonb) AS columns,
    ref_ns.nspname::text AS referenced_schema,
    ref.relname::text AS referenced_table,
    COALESCE((
      SELECT jsonb_agg(attr.attname ORDER BY item.ordinal)
      FROM unnest(con.confkey) WITH ORDINALITY item(attnum, ordinal)
      JOIN pg_attribute attr
        ON attr.attrelid = con.confrelid
       AND attr.attnum = item.attnum
    ), '[]'::jsonb) AS referenced_columns,
    pg_get_constraintdef(con.oid, true) AS definition,
    CASE con.confupdtype
      WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
      WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
      WHEN 'd' THEN 'SET DEFAULT'
    END AS update_action,
    CASE con.confdeltype
      WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
      WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
      WHEN 'd' THEN 'SET DEFAULT'
    END AS delete_action,
    con.condeferrable AS deferrable,
    con.condeferred AS initially_deferred,
    con.convalidated AS validated
  FROM pg_constraint con
  JOIN pg_class src ON src.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = src.relnamespace
  JOIN pg_class ref ON ref.oid = con.confrelid
  JOIN pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace
  LEFT JOIN target_tables target
    ON target.schema_name = n.nspname
   AND target.table_name = src.relname
  WHERE con.contype = 'f'
    AND (
      target.table_name IS NOT NULL
      OR (
        n.nspname = 'public'
        AND src.relname = 'capability_grants'
        AND con.conname = 'capability_grants_jurisdiction_id_fkey'
      )
    )
)
SELECT jsonb_build_object(
  'constraints', COALESCE((
    SELECT jsonb_agg(to_jsonb(item) ORDER BY item."schema", item."table", item.name)
    FROM constraint_rows item
  ), '[]'::jsonb),
  'indexes', COALESCE((
    SELECT jsonb_agg(to_jsonb(item) ORDER BY item."schema", item."table", item.name)
    FROM index_rows item
  ), '[]'::jsonb),
  'foreign_keys', COALESCE((
    SELECT jsonb_agg(to_jsonb(item) ORDER BY item."schema", item."table", item.name)
    FROM foreign_key_rows item
  ), '[]'::jsonb)
)::text;
`;

function catalogRowIdentity(row) {
  return `${row.schema}.${row.table}.${row.name}`;
}

function requireCatalogArray(value, expectedLength, context) {
  requireArray(value, context);
  if (value.length !== expectedLength) {
    fail(`${context} must contain exactly ${expectedLength} rows`);
  }
}

function requireStringArrayExact(value, expected, context) {
  if (
    !Array.isArray(value) ||
    JSON.stringify(value) !== JSON.stringify(expected)
  ) {
    fail(`${context} is structurally different`);
  }
}

export function validateP1RegulatoryCatalog(
  catalog,
  context = "P1 jurisdiction/policy/launch catalog",
) {
  requireExactFields(
    catalog,
    ["constraints", "indexes", "foreign_keys"],
    context,
  );

  const expectedConstraints = new Map(
    P1_REGULATORY_CONSTRAINTS.map(([table, name, type]) => [
      `public.${table}.${name}`,
      type,
    ]),
  );
  requireCatalogArray(
    catalog.constraints,
    expectedConstraints.size,
    `${context}.constraints`,
  );
  const observedConstraints = new Set();
  for (const [index, row] of catalog.constraints.entries()) {
    const rowContext = `${context}.constraints[${index}]`;
    requireExactFields(
      row,
      [
        "schema",
        "table",
        "name",
        "type",
        "definition",
        "referenced_schema",
        "referenced_table",
      ],
      rowContext,
    );
    const identity = catalogRowIdentity(row);
    if (observedConstraints.has(identity)) {
      fail(`${rowContext} duplicates ${identity}`);
    }
    observedConstraints.add(identity);
    const expectedType = expectedConstraints.get(identity);
    if (expectedType === undefined) {
      fail(`${rowContext} is an unexpected constraint ${identity}`);
    }
    if (row.type !== expectedType) {
      fail(`${rowContext} has the wrong constraint type`);
    }
    requireBoundedString(row.definition, `${rowContext}.definition`, 4000);
    if (row.type === "t" && row.definition !== "TRIGGER") {
      fail(`${rowContext} is not the reviewed constraint-trigger row`);
    }
  }
  for (const identity of expectedConstraints.keys()) {
    if (!observedConstraints.has(identity)) {
      fail(`${context}.constraints is missing ${identity}`);
    }
  }
  const constraintTriggerCount = catalog.constraints.filter(
    (row) => row.type === "t",
  ).length;
  const ordinaryConstraintCount =
    catalog.constraints.length - constraintTriggerCount;
  if (constraintTriggerCount !== 4 || ordinaryConstraintCount !== 49) {
    fail(
      `${context}.constraints has an invalid ordinary/trigger classification`,
    );
  }

  const expectedIndexes = new Map(
    P1_REGULATORY_INDEXES.map(
      ([table, name, columns, primary, constraintName, constraintType]) => [
        `public.${table}.${name}`,
        { columns, primary, constraintName, constraintType },
      ],
    ),
  );
  requireCatalogArray(
    catalog.indexes,
    expectedIndexes.size,
    `${context}.indexes`,
  );
  const observedIndexes = new Set();
  for (const [index, row] of catalog.indexes.entries()) {
    const rowContext = `${context}.indexes[${index}]`;
    requireExactFields(
      row,
      [
        "schema",
        "table",
        "name",
        "columns",
        "is_unique",
        "is_primary",
        "constraint_backed",
        "associated_constraint_name",
        "associated_constraint_type",
        "definition",
      ],
      rowContext,
    );
    const identity = catalogRowIdentity(row);
    if (observedIndexes.has(identity))
      fail(`${rowContext} duplicates ${identity}`);
    observedIndexes.add(identity);
    const expected = expectedIndexes.get(identity);
    if (expected === undefined) {
      fail(
        `${rowContext} is an unexpected standalone or constraint-backed index ${identity}`,
      );
    }
    requireStringArrayExact(
      row.columns,
      expected.columns,
      `${rowContext}.columns`,
    );
    requireBoundedString(row.definition, `${rowContext}.definition`, 4000);
    if (
      row.is_unique !== true ||
      row.is_primary !== expected.primary ||
      row.constraint_backed !== true ||
      row.associated_constraint_name !== expected.constraintName ||
      row.associated_constraint_type !== expected.constraintType
    ) {
      fail(`${rowContext} is not the reviewed constraint-backed index`);
    }
  }
  for (const identity of expectedIndexes.keys()) {
    if (!observedIndexes.has(identity))
      fail(`${context}.indexes is missing ${identity}`);
  }

  const expectedForeignKeys = new Map(
    P1_REGULATORY_FOREIGN_KEYS.map(
      ([table, name, columns, referencedTable, referencedColumns]) => [
        `public.${table}.${name}`,
        { columns, referencedTable, referencedColumns },
      ],
    ),
  );
  requireCatalogArray(
    catalog.foreign_keys,
    expectedForeignKeys.size,
    `${context}.foreign_keys`,
  );
  const observedForeignKeys = new Set();
  for (const [index, row] of catalog.foreign_keys.entries()) {
    const rowContext = `${context}.foreign_keys[${index}]`;
    requireExactFields(
      row,
      [
        "schema",
        "table",
        "name",
        "columns",
        "referenced_schema",
        "referenced_table",
        "referenced_columns",
        "definition",
        "update_action",
        "delete_action",
        "deferrable",
        "initially_deferred",
        "validated",
      ],
      rowContext,
    );
    const identity = catalogRowIdentity(row);
    if (observedForeignKeys.has(identity))
      fail(`${rowContext} duplicates ${identity}`);
    observedForeignKeys.add(identity);
    const expected = expectedForeignKeys.get(identity);
    if (expected === undefined) {
      fail(`${rowContext} is an unexpected foreign key ${identity}`);
    }
    requireStringArrayExact(
      row.columns,
      expected.columns,
      `${rowContext}.columns`,
    );
    requireStringArrayExact(
      row.referenced_columns,
      expected.referencedColumns,
      `${rowContext}.referenced_columns`,
    );
    requireBoundedString(row.definition, `${rowContext}.definition`, 4000);
    if (
      row.referenced_schema !== "public" ||
      row.referenced_table !== expected.referencedTable ||
      row.update_action !== "RESTRICT" ||
      row.delete_action !== "RESTRICT" ||
      row.deferrable !== false ||
      row.initially_deferred !== false ||
      row.validated !== true
    ) {
      fail(
        `${rowContext} is structurally different from the reviewed foreign key`,
      );
    }
  }
  for (const identity of expectedForeignKeys.keys()) {
    if (!observedForeignKeys.has(identity)) {
      fail(`${context}.foreign_keys is missing ${identity}`);
    }
  }
  const newTableForeignKeys = catalog.foreign_keys.filter((row) =>
    P1_REGULATORY_TABLES.includes(row.table),
  ).length;
  const capabilityGrantForeignKeys = catalog.foreign_keys.filter(
    (row) =>
      row.table === "capability_grants" &&
      row.name === "capability_grants_jurisdiction_id_fkey",
  ).length;
  if (newTableForeignKeys !== 15 || capabilityGrantForeignKeys !== 1) {
    fail(`${context}.foreign_keys has an invalid scope classification`);
  }

  return {
    total_constraint_rows: catalog.constraints.length,
    ordinary_constraints: ordinaryConstraintCount,
    constraint_triggers: constraintTriggerCount,
    constraint_backed_indexes: catalog.indexes.filter(
      (row) => row.constraint_backed,
    ).length,
    standalone_indexes: catalog.indexes.filter((row) => !row.constraint_backed)
      .length,
    new_table_foreign_keys: newTableForeignKeys,
    capability_grants_foreign_keys: capabilityGrantForeignKeys,
    total_p1_003_foreign_keys: catalog.foreign_keys.length,
  };
}

export function validateP1RegulatoryEvidence(evidence, migrationSql) {
  const context = "P1 jurisdiction/policy/launch evidence";
  requireExactFields(
    evidence,
    [
      "version",
      "evidence_id",
      "work_item_id",
      "scope",
      "authority_refs",
      "preflight",
      "migration",
      "transactional_validation",
      "persistent_application_validation",
      "schema_contract",
      "catalog_acceptance",
      "security",
      "catalog_fingerprint",
      "tooling_exceptions",
      "repository_validation",
      "review_traceability",
      "environment_integrity",
      "acceptance_state",
      "next_gate",
      "sensitive_payloads_present",
    ],
    context,
  );
  if (
    evidence.version !== 2 ||
    evidence.evidence_id !== "P1-003-JURISDICTION-POLICY-LAUNCH-FOUNDATION" ||
    evidence.work_item_id !==
      "WI-P1-003-JURISDICTION-POLICY-LAUNCH-FOUNDATION" ||
    evidence.scope !==
      "P1/1C physical Migration 3 jurisdiction, policy, and launch-gate foundation only"
  ) {
    fail(`${context} identity is invalid`);
  }
  const digest = createHash("sha256").update(migrationSql).digest("hex");
  const migration = evidence.migration;
  if (
    evidence.preflight?.environment !== "staging" ||
    evidence.preflight?.project_ref !== "mxjlvmowmodzdtdfgqpb" ||
    evidence.preflight?.migration_versions?.join("|") !==
      "20260828192126|20260829000015|20260829171701" ||
    evidence.preflight?.p0_p1_001_p1_002_catalog_exact !== true ||
    migration?.migration_id !==
      "20260830023823_p1_jurisdiction_policy_launch_foundation" ||
    migration?.version !== "20260830023823" ||
    migration?.name !== "p1_jurisdiction_policy_launch_foundation" ||
    migration?.path !==
      "supabase/migrations/20260830023823_p1_jurisdiction_policy_launch_foundation.sql" ||
    migration?.sha256 !== digest ||
    migration?.created_by_supabase_cli !== "2.116.0" ||
    migration?.persistent_application !== true ||
    migration?.application_count !== 1 ||
    migration?.seeded_rows !== 0 ||
    migration?.prior_migration_sha256?.["20260828192126"] !==
      "2ba591b2767c43a32731c8b74b5ffaa07c47a41d096eee6fb3672aad9278c49d" ||
    migration?.prior_migration_sha256?.["20260829000015"] !==
      "67dfd44b2bd7525a588e6eb59c33a0056f3a5c67eec5f45dd93e6aab37f7afc8" ||
    migration?.prior_migration_sha256?.["20260829171701"] !==
      "6471ac68949234e29ae1cc492eaa2f77dc15ca010998f72898284b8c9a855fec"
  ) {
    fail(`${context} preflight or migration record is invalid`);
  }
  const validation = evidence.transactional_validation;
  requireTimestamp(validation?.completed_at, `${context}.completed_at`);
  if (
    validation?.environment !== "staging" ||
    validation?.rollback_only !== true ||
    validation?.catalog_assertions !== "passed" ||
    validation?.happy_path !== "passed" ||
    validation?.failure_paths !== "passed" ||
    validation?.security_assertions !== "passed" ||
    validation?.rollback_verified !== true ||
    validation?.migration_history_unchanged !== true ||
    validation?.persistent_rows_after_rollback !== 0 ||
    validation?.persistent_objects_after_rollback !== 0
  ) {
    fail(`${context} transactional validation is invalid`);
  }

  const persistent = evidence.persistent_application_validation;
  requireExactFields(
    persistent,
    [
      "completed_at",
      "environment",
      "project_ref",
      "application_status",
      "migration_history",
      "pending_versions",
      "remote_only_versions",
      "duplicate_versions",
      "generated_or_unexpected_versions",
      "local_remote_reconciliation",
      "migration_sql_reapplied",
      "migration_history_repaired",
      "direct_history_edit",
    ],
    `${context}.persistent_application_validation`,
  );
  requireTimestamp(
    persistent.completed_at,
    `${context}.persistent_application_validation.completed_at`,
  );
  const expectedHistory = [
    ["20260828192126", "p0_restrict_rls_auto_enable_execution"],
    ["20260829000015", "p1_platform_foundation"],
    ["20260829171701", "p1_authorization_foundation"],
    ["20260830023823", "p1_jurisdiction_policy_launch_foundation"],
  ];
  requireCatalogArray(
    persistent.migration_history,
    expectedHistory.length,
    `${context}.persistent_application_validation.migration_history`,
  );
  for (const [index, [version, name]] of expectedHistory.entries()) {
    const row = persistent.migration_history[index];
    requireExactFields(
      row,
      ["version", "name", "occurrences"],
      `${context}.persistent_application_validation.migration_history[${index}]`,
    );
    if (row.version !== version || row.name !== name || row.occurrences !== 1) {
      fail(`${context} migration history is invalid`);
    }
  }
  if (
    persistent.environment !== "staging" ||
    persistent.project_ref !== "mxjlvmowmodzdtdfgqpb" ||
    persistent.application_status !== "passed" ||
    persistent.pending_versions !== 0 ||
    persistent.remote_only_versions !== 0 ||
    persistent.duplicate_versions !== 0 ||
    persistent.generated_or_unexpected_versions !== 0 ||
    persistent.local_remote_reconciliation !== "exact" ||
    persistent.migration_sql_reapplied !== false ||
    persistent.migration_history_repaired !== false ||
    persistent.direct_history_edit !== false
  ) {
    fail(`${context} persistent application state is invalid`);
  }

  const expectedTables = P1_REGULATORY_TABLES.map((table) => `public.${table}`);
  const expectedFunctions = [
    "public.enforce_policy_authority_provenance()",
    "public.enforce_jurisdiction_live_authorization()",
  ];
  const expectedTriggers = [
    "jurisdictions_set_updated_at",
    "regulatory_modes_set_updated_at",
    "policy_types_set_updated_at",
    "policy_versions_set_updated_at",
    "launch_gates_set_updated_at",
    "policy_versions_require_authority",
    "policy_authority_references_preserve_approval",
    "jurisdictions_require_launch_authorization",
    "launch_authorizations_preserve_live_boundary",
  ];
  if (
    evidence.schema_contract?.created_tables !== 10 ||
    evidence.schema_contract?.table_inventory?.join("|") !==
      expectedTables.join("|") ||
    evidence.schema_contract?.created_functions !== 2 ||
    evidence.schema_contract?.function_inventory?.join("|") !==
      expectedFunctions.join("|") ||
    evidence.schema_contract?.created_triggers !== 9 ||
    evidence.schema_contract?.trigger_inventory?.join("|") !==
      expectedTriggers.join("|") ||
    evidence.schema_contract?.created_explicit_indexes !== 0 ||
    evidence.schema_contract?.capability_grants_jurisdiction_fk !== true ||
    evidence.schema_contract?.policy_authority_provenance_enforced !== true ||
    evidence.schema_contract?.live_requires_launch_authorization !== true ||
    evidence.schema_contract?.prerequisites_imply_live !== false ||
    evidence.schema_contract?.active_policy_history_reconstructible !== true ||
    evidence.schema_contract?.counsel_values_seeded !== false ||
    evidence.schema_contract?.california_specific_columns !== 0 ||
    evidence.schema_contract?.attorney_service_areas_created !== false ||
    evidence.schema_contract?.later_p1_objects_created !== false ||
    !evidence.schema_contract?.financial_activity_rule?.includes(
      "environment, LIVE jurisdiction, approved policy, and launch authorization",
    )
  ) {
    fail(`${context} schema contract is invalid`);
  }

  const catalog = evidence.catalog_acceptance;
  const capabilityGrantForeignKey =
    catalog?.capability_grants_jurisdiction_id_fkey;
  requireExactFields(
    capabilityGrantForeignKey,
    [
      "constraint",
      "source",
      "target",
      "on_update",
      "on_delete",
      "deferrable",
      "initially_deferred",
      "validated",
      "structural_match",
    ],
    `${context}.catalog_acceptance.capability_grants_jurisdiction_id_fkey`,
  );
  if (
    catalog?.status !== "passed" ||
    catalog?.p1_003_tables !== 10 ||
    catalog?.p1_003_columns !== 77 ||
    catalog?.constraint_rows !== 53 ||
    catalog?.ordinary_constraints !== 49 ||
    catalog?.constraint_trigger_rows !== 4 ||
    catalog?.constraint_backed_indexes !== 15 ||
    catalog?.standalone_indexes !== 0 ||
    catalog?.new_table_foreign_keys !== 15 ||
    catalog?.capability_grants_foreign_keys !== 1 ||
    catalog?.total_p1_003_foreign_keys !== 16 ||
    capabilityGrantForeignKey.constraint !==
      "capability_grants_jurisdiction_id_fkey" ||
    capabilityGrantForeignKey.source !==
      "public.capability_grants(jurisdiction_id)" ||
    capabilityGrantForeignKey.target !== "public.jurisdictions(id)" ||
    capabilityGrantForeignKey.on_update !== "RESTRICT" ||
    capabilityGrantForeignKey.on_delete !== "RESTRICT" ||
    capabilityGrantForeignKey.deferrable !== false ||
    capabilityGrantForeignKey.initially_deferred !== false ||
    capabilityGrantForeignKey.validated !== true ||
    capabilityGrantForeignKey.structural_match !== true ||
    catalog?.reviewed_enforcement_functions !== 2 ||
    catalog?.reviewed_enabled_triggers !== 9 ||
    catalog?.rls_enabled_tables !== 10 ||
    catalog?.client_facing_policies !== 0 ||
    catalog?.reviewed_privilege_model !== "passed" ||
    catalog?.p1_003_rows !== 0 ||
    catalog?.unexpected_objects_or_grants !== 0 ||
    catalog?.california_specific_objects !== 0 ||
    catalog?.later_p1_objects !== 0 ||
    catalog?.p0_p1_001_p1_002_controls !== "intact"
  ) {
    fail(`${context} catalog acceptance is invalid`);
  }

  if (
    evidence.security?.rls_enabled_tables !== 10 ||
    evidence.security?.client_policies_created !== 0 ||
    evidence.security?.public_anon_authenticated_table_privileges !== 0 ||
    evidence.security?.service_role_privileges?.join("|") !==
      "SELECT|INSERT|UPDATE" ||
    evidence.security?.service_role_delete !== false ||
    evidence.security?.enforcement_functions_security !==
      "SECURITY INVOKER with search_path pg_catalog" ||
    evidence.security?.enforcement_function_execute?.PUBLIC !== false ||
    evidence.security?.enforcement_function_execute?.anon !== false ||
    evidence.security?.enforcement_function_execute?.authenticated !== false ||
    evidence.security?.enforcement_function_execute?.postgres !== true ||
    evidence.security?.enforcement_function_execute?.service_role !== true ||
    evidence.security?.advisor_gate !== "zero_unapproved_findings" ||
    evidence.security?.approved_info_findings?.join("|") !==
      P1_REGULATORY_APPROVED_ADVISOR_FINDINGS.join("|") ||
    evidence.security?.approved_p1_002_findings !== 3 ||
    evidence.security?.approved_p1_003_findings !== 10 ||
    evidence.security?.unapproved_findings !== 0
  ) {
    fail(`${context} security acceptance is invalid`);
  }

  const fingerprint = evidence.catalog_fingerprint;
  if (
    fingerprint?.scope !==
      "P1-001 and P1-002 approved Staging catalog surface" ||
    fingerprint?.algorithm !== "SHA-256" ||
    fingerprint?.sha256 !==
      "1d8e6182902d3c40d1b99c87bc80be2f146ef6a85f512b117e5c55b52878c12c" ||
    fingerprint?.canonical_byte_length !== 50602 ||
    fingerprint?.expected_p1_003_delta_rows?.join("|") !==
      "constraint:public.capability_grants.capability_grants_jurisdiction_id_fkey|foreign_key:public.capability_grants.capability_grants_jurisdiction_id_fkey" ||
    fingerprint?.reproduced_after_expected_delta_exclusion !== true
  ) {
    fail(`${context} catalog fingerprint is invalid`);
  }

  const cli = evidence.tooling_exceptions?.supabase_cli_schema_drift;
  const validator = evidence.tooling_exceptions?.catalog_validator;
  requireTimestamp(
    validator?.correction_approved_at,
    `${context}.tooling_exceptions.catalog_validator.correction_approved_at`,
  );
  if (
    cli?.tool !== "official Supabase CLI" ||
    cli?.version !== "2.116.0" ||
    cli?.environment !== "Replit" ||
    cli?.failure !==
      "OCI namespace entry for pg_isready failed: setns exit status 1" ||
    cli?.postgresql_initialized_and_ready !== true ||
    cli?.p1_003_sql_or_schema_comparison_reached !== false ||
    cli?.drift_sql_produced !== false ||
    cli?.classification !== "environment-specific tooling exception" ||
    cli?.compensating_direct_catalog_validation !== "passed" ||
    cli?.persisted_schema_defect !== false ||
    validator?.classification !== "validator classification/predicate defect" ||
    validator?.persisted_schema_defect !== false ||
    validator?.corrected_commit !==
      "8e3795663372ecac3641078d0271ddeb800d609b" ||
    validator?.protected_merge_commit !==
      "615e293c15897da5b4e39aabea568c5cf90bf9cf" ||
    validator?.correction_reviewed_by !== "Rosuno" ||
    validator?.correction_approved_at !== "2026-08-30T19:51:17Z" ||
    validator?.database_repair_required !== false
  ) {
    fail(`${context} tooling exception is invalid`);
  }

  const repository = evidence.repository_validation;
  requireTimestamp(
    repository?.completed_at,
    `${context}.repository_validation.completed_at`,
  );
  if (
    repository?.protected_main_commit !==
      "615e293c15897da5b4e39aabea568c5cf90bf9cf" ||
    repository?.ahead_behind !== "0/0" ||
    repository?.working_tree_clean !== true ||
    repository?.frozen_lockfile_install !== "passed" ||
    repository?.formatting !== "passed" ||
    repository?.typecheck !== "passed" ||
    repository?.build !== "passed" ||
    repository?.repository_controls !== "passed" ||
    repository?.tests_passed !== 43 ||
    repository?.tests_failed !== 0 ||
    repository?.secret_scan !== "passed" ||
    repository?.secret_scan_files !== 52 ||
    repository?.dependency_security_audit !== "no known vulnerabilities" ||
    repository?.migration_hashes_unchanged !== true
  ) {
    fail(`${context} repository acceptance is invalid`);
  }

  const implementationReview = evidence.review_traceability?.implementation;
  const validatorReview = evidence.review_traceability?.validator_correction;
  requireTimestamp(
    implementationReview?.approved_at,
    `${context}.review_traceability.implementation.approved_at`,
  );
  requireTimestamp(
    validatorReview?.approved_at,
    `${context}.review_traceability.validator_correction.approved_at`,
  );
  if (
    implementationReview?.pull_request !== 7 ||
    implementationReview?.approved_head !==
      "279742dbacc06d09050a6f8bb5c57cdca9142b23" ||
    implementationReview?.merge_commit !==
      "0ba2331b88fd5f045573b3e2d140f03e240b6a77" ||
    implementationReview?.reviewer !== "Rosuno" ||
    implementationReview?.approved_at !== "2026-08-30T05:02:26Z" ||
    validatorReview?.pull_request !== 8 ||
    validatorReview?.approved_head !==
      "8e3795663372ecac3641078d0271ddeb800d609b" ||
    validatorReview?.merge_commit !==
      "615e293c15897da5b4e39aabea568c5cf90bf9cf" ||
    validatorReview?.reviewer !== "Rosuno" ||
    validatorReview?.approved_at !== "2026-08-30T19:51:17Z"
  ) {
    fail(`${context} protected review traceability is invalid`);
  }

  const integrity = evidence.environment_integrity;
  if (
    integrity?.source_read_only_history?.join("|") !== "20260828192126" ||
    integrity?.source_mutated !== false ||
    integrity?.development_mutated !== false ||
    integrity?.production_contacted_or_mutated !== false ||
    integrity?.old_project_status !== "INACTIVE" ||
    integrity?.old_read_only_listing !== "timed_out" ||
    integrity?.old_mutated !== false ||
    integrity?.old_inspection_limitation !==
      "The final read-only OLD migration listing timed out; no successful final OLD catalog or history inspection is claimed." ||
    integrity?.staging_persistently_mutated !== true ||
    integrity?.staging_migration_history_exact !== true ||
    integrity?.p0_p1_001_p1_002_controls_unchanged !== true ||
    integrity?.migration_repair_or_reapplication !== false ||
    integrity?.seed_or_fake_business_data_introduced !== false ||
    evidence.acceptance_state !== "accepted_staging_application" ||
    evidence.next_gate !==
      "separate protected review before production or P1-004" ||
    evidence.sensitive_payloads_present !== false
  ) {
    fail(`${context} environment or acceptance state is invalid`);
  }
  validateReferences(
    evidence.authority_refs,
    new Set([
      "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED",
      "PHYSICAL-SUPABASE-POSTGRES-V1.0-LOCKED",
      "DOMAIN-MODEL-V1.4-LOCKED",
      "RELATIONAL-OBJECT-SPEC-V1.0-LOCKED",
      "SCHEMA-INVENTORY-V0.7-LOCKED",
      "TECHNICAL-ARCHITECTURE-V0.2-LOCKED",
    ]),
    `${context}.authority_refs`,
    5,
  );
  if (scanSecretLikeText(JSON.stringify(evidence), context).length > 0) {
    fail(`${context} contains secret-like content`);
  }
}

export function validateP1AuthorizationEvidence(
  evidence,
  migrationSql,
  catalogBaseline,
) {
  const context = "P1 authorization evidence";
  requireExactFields(
    evidence,
    [
      "version",
      "evidence_id",
      "work_item_id",
      "scope",
      "authority_refs",
      "preflight",
      "migration",
      "transactional_validation",
      "persistent_application_validation",
      "schema_contract",
      "privileges",
      "catalog_fingerprint",
      "security_advisor",
      "drift_tooling_exception",
      "environment_integrity",
      "acceptance_state",
      "next_gate",
      "sensitive_payloads_present",
    ],
    context,
  );
  if (
    evidence.version !== 2 ||
    evidence.evidence_id !== "P1-002-AUTHORIZATION-FOUNDATION" ||
    evidence.work_item_id !== "WI-P1-002-AUTHORIZATION-FOUNDATION" ||
    evidence.scope !==
      "P1/1B physical Migration 2 authorization foundation only"
  ) {
    fail(`${context} identity is invalid`);
  }
  const history = evidence.preflight?.migration_history;
  if (
    evidence.preflight?.environment !== "staging" ||
    history?.p0_version !== "20260828192126" ||
    history?.p0_occurrences !== 1 ||
    history?.p1_001_version !== "20260829000015" ||
    history?.p1_001_occurrences !== 1 ||
    history?.p1_002_version !== "20260829171701" ||
    history?.p1_002_occurrences !== 1 ||
    evidence.preflight?.public_users_row_count !== 0 ||
    evidence.preflight?.public_users_schema_exact !== true ||
    evidence.preflight?.p0_invariants_unchanged !== true ||
    evidence.preflight?.p1_001_invariants_unchanged !== true ||
    evidence.preflight?.schema_drift !==
      "cli_unavailable_compensating_catalog_passed"
  ) {
    fail(`${context} preflight is invalid`);
  }
  const migration = evidence.migration;
  const digest = createHash("sha256").update(migrationSql).digest("hex");
  const tables = [
    "public.client_profiles",
    "public.attorney_profiles",
    "public.staff_profiles",
    "public.capability_definitions",
    "public.capability_grants",
    "public.application_sessions",
  ];
  if (
    migration?.migration_id !== "20260829171701_p1_authorization_foundation" ||
    migration?.version !== "20260829171701" ||
    migration?.path !==
      "supabase/migrations/20260829171701_p1_authorization_foundation.sql" ||
    migration?.sha256 !== digest ||
    migration?.created_by_supabase_cli !== "2.116.0" ||
    migration?.created_tables?.join("|") !== tables.join("|") ||
    migration?.created_indexes?.join("|") !==
      "public.capability_grants_user_capability_idx" ||
    migration?.created_functions?.length !== 0 ||
    migration?.seeded_rows !== 0 ||
    migration?.persistent_application !== true
  ) {
    fail(`${context} migration record is invalid`);
  }
  const validation = evidence.transactional_validation;
  requireTimestamp(
    validation?.completed_at,
    `${context}.transactional_validation.completed_at`,
  );
  if (
    validation?.environment !== "staging" ||
    validation?.transaction !== "single transaction" ||
    validation?.rollback_only !== true ||
    [
      "catalog_assertions",
      "constraint_tests",
      "cross_user_profile_denial",
      "anon_denial",
      "authenticated_write_denial",
      "sensitive_capability_session_denial",
      "service_role_acl",
    ].some((field) => validation[field] !== "passed") ||
    [
      "no_universal_capability_seed",
      "p0_invariants_unchanged",
      "p1_001_invariants_unchanged",
      "zero_persistent_rows_after_rollback",
      "zero_persistent_objects_after_rollback",
      "migration_history_unchanged",
      "source_unchanged",
      "development_unchanged",
    ].some((field) => validation[field] !== true) ||
    validation.production_accessed !== false ||
    validation.old_project_accessed !== false ||
    validation.security_advisor_findings !== 0
  ) {
    fail(`${context} transactional validation is invalid`);
  }
  const contract = evidence.schema_contract;
  if (
    contract?.new_tables?.join("|") !== tables.join("|") ||
    contract?.profile_user_unique_relationships !== true ||
    contract?.profile_user_foreign_keys_restrictive !== true ||
    contract?.attorney_lifecycle_states?.join("|") !==
      "pending_verification|active|suspended|closed" ||
    contract?.staff_lifecycle_states?.join("|") !==
      "pending_verification|active|suspended|closed" ||
    [
      "optional_numeric_constraints_nonnegative",
      "capability_code_unique",
      "grant_history_timestamps",
      "grant_validity_constraints",
      "required_capability_grant_index",
      "jurisdiction_id_nullable_without_foreign_key",
      "session_reference_unique_opaque_non_secret",
      "session_time_constraints",
      "all_new_tables_rls_enabled",
      "no_capability_or_entity_seed",
    ].some((field) => contract[field] !== true)
  ) {
    fail(`${context} schema contract is invalid`);
  }
  if (
    evidence.privileges?.authenticated_profile_select_own !== true ||
    evidence.privileges?.authenticated_profile_writes !== false ||
    evidence.privileges?.anon_sensitive_access !== false ||
    evidence.privileges?.authenticated_sensitive_access !== false ||
    evidence.privileges?.service_role_select_insert_update !== true ||
    evidence.privileges?.service_role_delete !== false
  ) {
    fail(`${context} privilege boundary is invalid`);
  }
  const persistent = evidence.persistent_application_validation;
  requireTimestamp(
    persistent?.completed_at,
    `${context}.persistent_application_validation.completed_at`,
  );
  if (
    persistent?.environment !== "staging" ||
    persistent?.migration_history_exact !== true ||
    persistent?.public_table_count !== 7 ||
    persistent?.p1_002_table_count !== 6 ||
    persistent?.p1_002_column_count !== 41 ||
    persistent?.p1_002_constraint_count !== 28 ||
    persistent?.p1_002_index_count !== 12 ||
    persistent?.p1_002_foreign_key_count !== 6 ||
    persistent?.p1_002_policy_count !== 3 ||
    persistent?.p1_002_trigger_count !== 6 ||
    persistent?.p1_002_row_count !== 0 ||
    persistent?.application_sessions_user_id_fkey_exact !== true ||
    persistent?.p1_001_preserved !== true ||
    persistent?.unexpected_objects_grants_or_policies !== 0 ||
    persistent?.database_repair_required !== false
  ) {
    fail(`${context} persistent application validation is invalid`);
  }
  const baseline = validateCatalogBaseline(catalogBaseline);
  if (
    evidence.catalog_fingerprint?.baseline_path !==
      "governance/evidence/p1-002-catalog-fingerprint.json" ||
    evidence.catalog_fingerprint?.algorithm !== "SHA-256" ||
    evidence.catalog_fingerprint?.sha256 !== baseline.sha256 ||
    evidence.catalog_fingerprint?.canonical_byte_length !==
      baseline.canonical_byte_length ||
    evidence.catalog_fingerprint?.independent_read_only_runs !== 3 ||
    evidence.catalog_fingerprint?.all_runs_identical !== true ||
    evidence.catalog_fingerprint?.supplements_explicit_assertions !== true
  ) {
    fail(`${context} catalog fingerprint evidence is invalid`);
  }
  const advisor = evidence.security_advisor;
  validateAdvisorFindings(advisor?.findings);
  if (
    advisor?.gate !== "zero_unapproved_findings" ||
    advisor?.approved_findings !== 3 ||
    advisor?.unapproved_findings !== 0 ||
    advisor?.accepted_reason?.join("|") !==
      "PUBLIC, anon, and authenticated have no table privileges|the tables are server-controlled|service_role has exactly SELECT, INSERT, UPDATE and no DELETE or other table privileges|no client-facing policy is required by locked authority|no-policy RLS deliberately applies PostgreSQL default denial|allow policies would alter the boundary|USING(false) policies would be redundant lint suppression, not improvement"
  ) {
    fail(`${context} security advisor exception is invalid`);
  }
  const drift = evidence.drift_tooling_exception;
  if (
    drift?.tool !== "official Supabase CLI" ||
    drift?.version !== "2.116.0" ||
    drift?.environment !== "Replit" ||
    drift?.postgresql_initialized_and_ready !== true ||
    drift?.failure !==
      "OCI namespace entry for pg_isready failed: setns exit status 1" ||
    drift?.shadow_migration_or_schema_comparison_reached !== false ||
    drift?.drift_sql_produced !== false ||
    drift?.clean_cli_drift_claimed !== false ||
    drift?.compensating_direct_catalog_validation !== "passed" ||
    drift?.database_repair_required !== false
  ) {
    fail(`${context} drift tooling exception is invalid`);
  }
  if (
    evidence.environment_integrity?.source_contacted_or_mutated !== false ||
    evidence.environment_integrity?.development_contacted_or_mutated !==
      false ||
    evidence.environment_integrity?.production_contacted_or_mutated !== false ||
    evidence.environment_integrity?.old_contacted_or_mutated !== false ||
    evidence.environment_integrity?.authority !==
      "existing repository target and environment configuration evidence"
  ) {
    fail(`${context} environment integrity is invalid`);
  }
  if (
    evidence.acceptance_state !==
      "applied_to_staging_pending_protected_review" ||
    evidence.next_gate !==
      "protected human review before merge, production, or later P1 work" ||
    evidence.sensitive_payloads_present !== false
  ) {
    fail(`${context} acceptance gate is invalid`);
  }
  if (scanSecretLikeText(JSON.stringify(evidence), context).length > 0) {
    fail(`${context} contains a secret-like value`);
  }
}

export function validateP1AuthorizationLifecycleEvidence(evidence) {
  const context = "P1 authorization governance lifecycle evidence";
  requireExactFields(
    evidence,
    [
      "version",
      "evidence_id",
      "work_item_id",
      "decision_id",
      "scope",
      "authority_refs",
      "historical_records_preserved",
      "proposal",
      "implementation_review",
      "persistent_application",
      "validation_evidence_review",
      "defect_discovery",
      "forward_only_correction",
      "final_closure",
      "governance_closure",
      "current_governance",
      "boundaries",
      "sensitive_payloads_present",
    ],
    context,
  );
  if (
    evidence.version !== 2 ||
    evidence.evidence_id !== "P1-002-GOVERNANCE-LIFECYCLE-CORRECTION" ||
    evidence.work_item_id !== P1_GOVERNANCE_CORRECTION_WORK_ITEM_ID ||
    evidence.decision_id !== P1_GOVERNANCE_CORRECTION_DECISION_ID ||
    evidence.scope !==
      "Current P1-002 governance lifecycle and deterministic foundation baseline correction only"
  ) {
    fail(`${context} identity is invalid`);
  }
  const preserved = evidence.historical_records_preserved;
  if (
    preserved?.migration_path !== P1_AUTHORIZATION_MIGRATION_PATH ||
    preserved?.migration_sha256 !== P1_AUTHORIZATION_MIGRATION_SHA256 ||
    preserved?.pre_review_evidence_path !==
      "governance/evidence/p1-002-authorization-foundation.json" ||
    preserved?.pre_review_evidence_sha256 !==
      "29b6a33820e559557b8f3fd94f70762b5383a38833e3810486344a300eded43d" ||
    preserved?.historical_catalog_path !==
      "governance/evidence/p1-002-catalog-fingerprint.json" ||
    preserved?.migration_unchanged !== true ||
    preserved?.pre_review_evidence_unchanged !== true ||
    preserved?.historical_catalog_unchanged !== true
  ) {
    fail(`${context} historical preservation is invalid`);
  }
  const expectedReviews = [
    [
      evidence.implementation_review,
      4,
      "f2a2fcbd10bf9c7a7e6484cc2f5e545d0065d5e4",
      "6b279d56e8314abd7b7a7bf393e4de1e8a864235",
      P1_AUTHORIZATION_REVIEWED_AT,
      "2026-08-29T20:44:47Z",
    ],
    [
      evidence.validation_evidence_review,
      6,
      "be3de0daf91fad05fb76659149395040879748ea",
      "42fe78ee56e5dd599d3d600928f1c0d993141efe",
      P1_AUTHORIZATION_ACCEPTED_AT,
      "2026-08-30T01:39:16Z",
    ],
    [
      evidence.final_closure,
      11,
      "7b5ac880604596cc1c8dcb89ae61cff04fd4b84e",
      "b6970c23a5f64d118545d1a544965bf072cba1f6",
      "2026-09-01T19:19:35Z",
      "2026-09-01T19:26:31Z",
    ],
  ];
  for (const [
    review,
    number,
    head,
    merge,
    approvedAt,
    mergedAt,
  ] of expectedReviews) {
    if (
      review?.pull_request !== number ||
      review?.pull_request_url !==
        `https://github.com/NatthanPrevot/Rosuno/pull/${number}` ||
      review?.approved_head !== head ||
      review?.merge_commit !== merge ||
      review?.reviewer !== "Rosuno" ||
      review?.approved_at !== approvedAt ||
      review?.merged_at !== mergedAt
    ) {
      fail(`${context} PR #${number} traceability is invalid`);
    }
  }
  const governanceClosure = evidence.governance_closure;
  requireExactFields(
    governanceClosure,
    [
      "pull_request",
      "pull_request_url",
      "correction_head",
      "prior_main",
      "merge_commit",
      "merge_parents",
      "merge_tree",
      "reviewer",
      "review_status",
      "approved_at",
      "merged_at",
      "required_ci",
      "required_ci_all_passed",
    ],
    `${context}.governance_closure`,
  );
  const expectedGovernanceCi = [
    {
      name: "deterministic install",
      status: "completed",
      conclusion: "success",
      started_at: "2026-09-09T17:52:52Z",
      completed_at: "2026-09-09T17:53:09Z",
      details_url:
        "https://github.com/NatthanPrevot/Rosuno/actions/runs/34385608722/job/102580967834",
    },
    {
      name: "dependency and security checks",
      status: "completed",
      conclusion: "success",
      started_at: "2026-09-09T17:53:12Z",
      completed_at: "2026-09-09T17:53:23Z",
      details_url:
        "https://github.com/NatthanPrevot/Rosuno/actions/runs/34385608722/job/102581080288",
    },
    {
      name: "format, typecheck, build, controls",
      status: "completed",
      conclusion: "success",
      started_at: "2026-09-09T17:53:12Z",
      completed_at: "2026-09-09T17:53:27Z",
      details_url:
        "https://github.com/NatthanPrevot/Rosuno/actions/runs/34385608722/job/102581080316",
    },
  ];
  if (
    governanceClosure.pull_request !== 12 ||
    governanceClosure.pull_request_url !==
      "https://github.com/NatthanPrevot/Rosuno/pull/12" ||
    governanceClosure.correction_head !==
      "1c7b051489b3f7f936f8b3a57e651bfbe96e4701" ||
    governanceClosure.prior_main !==
      "b6970c23a5f64d118545d1a544965bf072cba1f6" ||
    governanceClosure.merge_commit !==
      "affcf955c3253fa8a6faeefe494de8891f94e64f" ||
    governanceClosure.merge_parents?.join("|") !==
      "b6970c23a5f64d118545d1a544965bf072cba1f6|1c7b051489b3f7f936f8b3a57e651bfbe96e4701" ||
    governanceClosure.merge_tree !==
      "e869df2a1bbb4fa383a259fd1a15788a501f7d96" ||
    governanceClosure.reviewer !== "Rosuno" ||
    governanceClosure.review_status !== "approved" ||
    governanceClosure.approved_at !== "2026-09-09T18:03:36Z" ||
    governanceClosure.merged_at !== "2026-09-09T18:09:50Z" ||
    JSON.stringify(governanceClosure.required_ci) !==
      JSON.stringify(expectedGovernanceCi) ||
    governanceClosure.required_ci_all_passed !== true
  ) {
    fail(`${context} PR #12 governance closure is invalid`);
  }
  const application = evidence.persistent_application;
  if (
    application?.environment !== "staging" ||
    application?.project_name !== "Rosuno Staging" ||
    application?.project_ref !== "mxjlvmowmodzdtdfgqpb" ||
    application?.migration_id !== P1_AUTHORIZATION_MIGRATION_ID ||
    application?.completed_at !== "2026-08-30T00:20:26Z" ||
    application?.validation_status !== "passed" ||
    application?.migration_history_exact !== true
  ) {
    fail(`${context} persistent application is invalid`);
  }
  const correction = evidence.forward_only_correction;
  if (
    correction?.migration_id !== P1_AUTHORIZATION_CORRECTION_MIGRATION_ID ||
    correction?.migration_sha256 !==
      P1_AUTHORIZATION_CORRECTION_MIGRATION_SHA256 ||
    correction?.pull_request !== P1_AUTHORIZATION_CORRECTION_PR ||
    correction?.pull_request_url !== P1_AUTHORIZATION_CORRECTION_PR_URL ||
    correction?.approved_head !== P1_AUTHORIZATION_CORRECTION_APPROVED_HEAD ||
    correction?.merge_commit !== P1_AUTHORIZATION_CORRECTION_MERGE_COMMIT ||
    correction?.reviewer !== "Rosuno" ||
    correction?.approved_at !== P1_AUTHORIZATION_CORRECTION_REVIEWED_AT ||
    correction?.merged_at !== P1_AUTHORIZATION_CORRECTION_MERGED_AT ||
    correction?.staging_validation_completed_at !==
      P1_AUTHORIZATION_CORRECTION_VALIDATED_AT ||
    correction?.staging_checks_passed !== 39 ||
    correction?.staging_checks_total !== 39 ||
    correction?.p1_003_contract_preserved !==
      "capability_grants_jurisdiction_id_fkey" ||
    correction?.corrected_catalog_sha256 !==
      P1_AUTHORIZATION_CORRECTION_CATALOG_SHA256
  ) {
    fail(`${context} forward-only correction is invalid`);
  }
  if (
    evidence.proposal?.decision_id !== P1_AUTHORIZATION_DECISION_ID ||
    evidence.proposal?.work_item_id !== P1_AUTHORIZATION_WORK_ITEM_ID ||
    evidence.proposal?.migration_id !== P1_AUTHORIZATION_MIGRATION_ID ||
    evidence.proposal?.proposed_at !== "2026-08-29T17:17:01Z" ||
    evidence.defect_discovery?.reopened !== true ||
    evidence.defect_discovery?.historical_records_rewritten !== false ||
    evidence.defect_discovery?.forward_only_correction_required !== true
  ) {
    fail(`${context} proposal or defect history is invalid`);
  }
  const governance = evidence.current_governance;
  if (
    governance?.original_decision_status !== "accepted" ||
    governance?.original_work_item_status !== "completed" ||
    governance?.original_migration_reviewed !== true ||
    governance?.original_migration_applied_environment !== "staging" ||
    governance?.original_release_id !== P1_AUTHORIZATION_RELEASE_ID ||
    governance?.correction_decision_status !== "accepted" ||
    governance?.correction_work_item_status !== "completed" ||
    governance?.governance_correction_decision_status !== "accepted" ||
    governance?.governance_correction_work_item_status !== "completed" ||
    governance?.governance_correction_reviewer !== "Rosuno" ||
    governance?.protected_review_pending !== false ||
    Object.values(evidence.boundaries ?? {}).some((value) => value !== false) ||
    evidence.sensitive_payloads_present !== false
  ) {
    fail(`${context} accepted governance closure boundary is invalid`);
  }
  if (scanSecretLikeText(JSON.stringify(evidence), context).length > 0) {
    fail(`${context} contains secret-like content`);
  }
}

function validateP1AuthorizationCorrectionFingerprint(
  fingerprint,
  migrationSql,
  sourceText = null,
) {
  const context = "P1 authorization correction fingerprint evidence";
  requireExactFields(
    fingerprint,
    [
      "version",
      "evidence_id",
      "work_item_id",
      "scope",
      "environment",
      "historical_fingerprints",
      "current_post_p1_003_baseline",
      "derivation",
      "migration",
      "canonicalization",
      "runs",
      "exact_equality",
      "rollback_and_restoration",
      "no_other_environments_contacted",
      "database_persistent_mutation",
      "migration_history_mutation",
      "authorized_tracked_mutation",
      "retention",
      "normalized_outputs",
    ],
    context,
  );
  if (
    fingerprint.version !== 2 ||
    fingerprint.evidence_id !== "P1-002-CORRECTED-CATALOG-FINGERPRINT-V2" ||
    fingerprint.work_item_id !== P1_AUTHORIZATION_CORRECTION_WORK_ITEM_ID ||
    fingerprint.scope !==
      "rollback-only corrected P1-002 four-table authorization catalog fingerprint against Rosuno Staging post-P1-003 baseline"
  ) {
    fail(`${context} identity is invalid`);
  }
  if (sourceText !== null) {
    const digest = createHash("sha256").update(sourceText).digest("hex");
    if (
      digest !== P1_AUTHORIZATION_CORRECTION_FINGERPRINT_FILE_SHA256 ||
      Buffer.byteLength(sourceText, "utf8") !==
        P1_AUTHORIZATION_CORRECTION_FINGERPRINT_FILE_BYTES ||
      JSON.stringify(JSON.parse(sourceText)) !== JSON.stringify(fingerprint)
    ) {
      fail(`${context} file bytes are not the authorized immutable evidence`);
    }
  }

  const migrationDigest = createHash("sha256")
    .update(migrationSql)
    .digest("hex");
  if (
    fingerprint.migration?.path !==
      P1_AUTHORIZATION_CORRECTION_MIGRATION_PATH ||
    fingerprint.migration?.sha256 !== migrationDigest ||
    fingerprint.migration?.sha256 !==
      P1_AUTHORIZATION_CORRECTION_MIGRATION_SHA256 ||
    fingerprint.migration?.bytes !==
      P1_AUTHORIZATION_CORRECTION_MIGRATION_BYTES ||
    fingerprint.migration?.executed_inside_transaction_only !== true ||
    fingerprint.migration?.persisted !== false
  ) {
    fail(`${context} migration evidence is invalid`);
  }

  const baseline = fingerprint.current_post_p1_003_baseline;
  if (
    baseline?.sha256 !== P1_AUTHORIZATION_CORRECTION_BASELINE_SHA256 ||
    baseline?.canonical_byte_length !== 51494 ||
    baseline?.row_count !== 173 ||
    baseline?.migration_history_exact !== true ||
    baseline?.public_table_count !== 17 ||
    baseline?.public_rows_zero !== true ||
    baseline?.correction_history_occurrences !== 0 ||
    baseline?.jurisdiction_fk_exact !== true ||
    baseline?.jurisdiction_comment_exact !== true ||
    baseline?.security_advisor_findings !== 13 ||
    baseline?.security_advisor_level !== "INFO"
  ) {
    fail(`${context} post-P1-003 baseline is invalid`);
  }
  const historical = fingerprint.historical_fingerprints;
  if (
    !Array.isArray(historical) ||
    historical.length !== 1 ||
    historical[0]?.label !==
      "preserved historical pre-P1-003 scoped baseline" ||
    historical[0]?.sha256 !==
      "1d8e6182902d3c40d1b99c87bc80be2f146ef6a85f512b117e5c55b52878c12c" ||
    historical[0]?.canonical_byte_length !== 50602 ||
    historical[0]?.retained_as_historical !== true
  ) {
    fail(`${context} historical fingerprint labeling is invalid`);
  }
  if (
    fingerprint.derivation?.source_query !==
      "tools/p0/lib/catalog-fingerprint.mjs#CATALOG_SQL" ||
    fingerprint.derivation?.source_sha256 !==
      "cedcca81b2604192f596c0e3a3f34a31aa4bfba86134a36d31595af42f5fdbb1" ||
    fingerprint.derivation?.retained_target_tables?.join("|") !==
      "public.staff_profiles|public.capability_definitions|public.capability_grants|public.application_sessions" ||
    fingerprint.derivation?.semantic_contract !== "rosuno-p1-catalog-v1" ||
    fingerprint.derivation?.reverse_derivation_exact !== true
  ) {
    fail(`${context} mechanical derivation proof is invalid`);
  }

  const snapshot = fingerprint.normalized_outputs?.snapshot;
  const canonical = canonicalizeCatalogRows(snapshot?.rows);
  if (
    snapshot?.format !== "rosuno-p1-catalog-v1" ||
    snapshot?.encoding !== "UTF-8" ||
    snapshot?.line_ending !== "LF" ||
    JSON.stringify(snapshot) !== JSON.stringify(canonical.snapshot) ||
    canonical.sha256 !== P1_AUTHORIZATION_CORRECTION_CATALOG_SHA256 ||
    canonical.canonicalBytes.length !==
      P1_AUTHORIZATION_CORRECTION_CATALOG_BYTES ||
    canonical.snapshot.rows.length !==
      P1_AUTHORIZATION_CORRECTION_CATALOG_ROWS ||
    JSON.stringify(canonical.categoryCounts) !==
      JSON.stringify(P1_AUTHORIZATION_CORRECTION_CATEGORY_COUNTS)
  ) {
    fail(`${context} normalized snapshot is invalid`);
  }

  const expectedFingerprint = {
    sha256: P1_AUTHORIZATION_CORRECTION_CATALOG_SHA256,
    canonical_byte_length: P1_AUTHORIZATION_CORRECTION_CATALOG_BYTES,
    row_count: P1_AUTHORIZATION_CORRECTION_CATALOG_ROWS,
    category_counts: P1_AUTHORIZATION_CORRECTION_CATEGORY_COUNTS,
  };
  requireArray(fingerprint.runs, `${context}.runs`, 2);
  if (fingerprint.runs.length !== 2) {
    fail(`${context} must contain exactly two runs`);
  }
  for (const [index, run] of fingerprint.runs.entries()) {
    const runId = `RUN${index + 1}`;
    if (
      run.run_id !== runId ||
      run.independent_psql_session !== true ||
      run.rollback_marker_text !== `V2_${runId}_ROLLBACK_COMPLETE` ||
      run.rollback_exit_status !== 0 ||
      run.before?.catalog_sha256 !==
        P1_AUTHORIZATION_CORRECTION_BASELINE_SHA256 ||
      run.after?.catalog_sha256 !==
        P1_AUTHORIZATION_CORRECTION_BASELINE_SHA256 ||
      run.before?.state_sha256 !== P1_AUTHORIZATION_CORRECTION_STATE_SHA256 ||
      run.after?.state_sha256 !== P1_AUTHORIZATION_CORRECTION_STATE_SHA256 ||
      JSON.stringify(run.before) !== JSON.stringify(run.after) ||
      run.restoration?.exact_catalog_canonical_bytes !== true ||
      run.restoration?.exact_persistent_state_bytes !== true ||
      run.restoration?.proven !== true ||
      JSON.stringify(run.fingerprint) !== JSON.stringify(expectedFingerprint)
    ) {
      fail(`${context} ${runId} rollback or restoration is invalid`);
    }
  }
  const runReferences = fingerprint.normalized_outputs?.run_references;
  if (
    !Array.isArray(runReferences) ||
    runReferences.length !== 2 ||
    runReferences.some(
      (reference, index) =>
        reference.run_id !== `RUN${index + 1}` ||
        reference.json_pointer !== "#/normalized_outputs/snapshot" ||
        reference.canonical_sha256 !==
          P1_AUTHORIZATION_CORRECTION_CATALOG_SHA256 ||
        reference.canonical_byte_length !==
          P1_AUTHORIZATION_CORRECTION_CATALOG_BYTES ||
        reference.row_count !== P1_AUTHORIZATION_CORRECTION_CATALOG_ROWS,
    )
  ) {
    fail(`${context} run references are invalid`);
  }
  if (
    Object.values(fingerprint.exact_equality).some((value) => value !== true) ||
    Object.values(fingerprint.rollback_and_restoration).some(
      (value) => value !== true,
    ) ||
    fingerprint.no_other_environments_contacted !== true ||
    fingerprint.database_persistent_mutation !== false ||
    fingerprint.migration_history_mutation !== false ||
    fingerprint.authorized_tracked_mutation?.join("|") !==
      P1_AUTHORIZATION_CORRECTION_FINGERPRINT_PATH
  ) {
    fail(`${context} equality, restoration, or mutation boundary is invalid`);
  }
  if (scanSecretLikeText(JSON.stringify(fingerprint), context).length > 0) {
    fail(`${context} contains secret-like content`);
  }
}

export function validateP1AuthorizationCorrectionEvidence(
  evidence,
  migrationSql,
  fingerprint,
  fingerprintSourceText = null,
) {
  const context = "P1 authorization scope correction evidence";
  requireExactFields(
    evidence,
    [
      "version",
      "evidence_id",
      "work_item_id",
      "decision_id",
      "scope",
      "authority_refs",
      "migration",
      "repository",
      "test_results",
      "rollback_validation",
      "staging_preservation",
      "persistent_application_validation",
      "review_traceability",
      "source_dev_mutation",
      "source_dev_scope_observation",
      "old_mutation",
      "old_reactivation",
      "old_scope_observation",
      "staging_persistent_correction_applied",
      "protected_review_completed",
      "merged",
      "pr_created",
      "catalog_fingerprint",
      "governance_state",
      "checkpoint_and_revert_history",
      "acceptance_state",
      "next_gate",
      "sensitive_payloads_present",
    ],
    context,
  );
  if (
    evidence.version !== 2 ||
    evidence.evidence_id !== "P1-002-AUTHORIZATION-SCOPE-CORRECTION" ||
    evidence.work_item_id !== P1_AUTHORIZATION_CORRECTION_WORK_ITEM_ID ||
    evidence.decision_id !== P1_AUTHORIZATION_CORRECTION_DECISION_ID ||
    evidence.scope !==
      "P1-002 authorization scope correction implemented, reviewed, and accepted after one-time Rosuno Staging application; rollback evidence retained"
  ) {
    fail(`${context} identity is invalid`);
  }
  const expectedAuthorities =
    "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED|PHYSICAL-SUPABASE-POSTGRES-V1.0-LOCKED|DOMAIN-MODEL-V1.4-LOCKED|RELATIONAL-OBJECT-SPEC-V1.0-LOCKED|SCHEMA-INVENTORY-V0.7-LOCKED";
  if (evidence.authority_refs?.join("|") !== expectedAuthorities) {
    fail(`${context} authority boundary is invalid`);
  }

  const migrationDigest = createHash("sha256")
    .update(migrationSql)
    .digest("hex");
  const migration = evidence.migration;
  if (
    migration?.migration_id !== P1_AUTHORIZATION_CORRECTION_MIGRATION_ID ||
    migration?.filename !==
      "20260901012518_p1_authorization_scope_correction.sql" ||
    migration?.path !== P1_AUTHORIZATION_CORRECTION_MIGRATION_PATH ||
    migration?.sha256 !== migrationDigest ||
    migration?.sha256 !== P1_AUTHORIZATION_CORRECTION_MIGRATION_SHA256 ||
    migration?.bytes !== P1_AUTHORIZATION_CORRECTION_MIGRATION_BYTES ||
    migration?.sequence !== 5 ||
    migration?.depends_on?.join("|") !==
      "20260830023823_p1_jurisdiction_policy_launch_foundation" ||
    migration?.reviewed !== true ||
    migration?.persistently_applied !== true
  ) {
    fail(`${context} migration summary is invalid`);
  }
  if (
    evidence.repository?.branch !== "p1-002-authorization-scope-correction" ||
    evidence.repository?.base_commit !==
      "b90f697164723be80029a8756b5dde79bd5f2c6c" ||
    evidence.repository?.validated_v2_evidence_commit !==
      "7802140d20b9e8cc05dadb9c4c9d1a6556dddd34" ||
    evidence.repository?.remote_correction_branch_present !== true
  ) {
    fail(`${context} repository baseline is invalid`);
  }
  const structural = evidence.test_results?.structural_security_failure;
  const observations = evidence.test_results?.authorization_observations;
  if (
    structural?.passed !== 30 ||
    structural?.total !== 30 ||
    structural?.result !== "passed" ||
    observations?.passed !== 7 ||
    observations?.total !== 7 ||
    observations?.result !== "passed"
  ) {
    fail(`${context} completed validation totals are invalid`);
  }
  const rollback = evidence.rollback_validation;
  if (
    rollback?.rollback_only !== true ||
    rollback?.run1_marker !== "V2_RUN1_ROLLBACK_COMPLETE" ||
    rollback?.run2_marker !== "V2_RUN2_ROLLBACK_COMPLETE" ||
    rollback?.run1_restored_before_run2 !== true ||
    rollback?.explicit_rollback_each_run !== true ||
    rollback?.exact_catalog_restoration !== true ||
    rollback?.exact_persistent_state_restoration !== true ||
    rollback?.baseline_catalog_sha256 !==
      P1_AUTHORIZATION_CORRECTION_BASELINE_SHA256 ||
    rollback?.persistent_state_sha256 !==
      P1_AUTHORIZATION_CORRECTION_STATE_SHA256 ||
    rollback?.migration_history_unchanged !== true
  ) {
    fail(`${context} rollback restoration summary is invalid`);
  }
  const staging = evidence.staging_preservation;
  if (
    staging?.p1_003_preserved !== true ||
    staging?.migration_count !== 4 ||
    staging?.public_table_count !== 17 ||
    staging?.public_row_count !== 0 ||
    staging?.security_advisor_info_findings !== 13 ||
    staging?.security_advisor_unapproved_findings !== 0 ||
    staging?.persistent_mutation !== false
  ) {
    fail(`${context} Staging preservation summary is invalid`);
  }
  if (
    evidence.source_dev_mutation !== false ||
    evidence.source_dev_scope_observation !==
      "source/dev wwcwfbzwljbjlaifklaj remains exactly P0 with zero public tables" ||
    evidence.old_mutation !== false ||
    evidence.old_reactivation !== false ||
    evidence.old_scope_observation !==
      "OLD ddltrtkunctovnjuyluk remains INACTIVE" ||
    evidence.staging_persistent_correction_applied !== true ||
    evidence.protected_review_completed !== true ||
    evidence.merged !== true ||
    evidence.pr_created !== true
  ) {
    fail(`${context} environment and publication observations are invalid`);
  }

  const persistent = evidence.persistent_application_validation;
  requireExactFields(
    persistent,
    [
      "completed_at",
      "environment",
      "project_ref",
      "reviewed_by",
      "reviewed_at",
      "application_status",
      "validation_checks_passed",
      "validation_checks_total",
      "migration_history",
      "pending_versions",
      "remote_only_versions",
      "duplicate_versions",
      "generated_or_unexpected_versions",
      "local_remote_reconciliation",
      "migration_sql_reapplied",
      "migration_history_repaired",
      "direct_history_edit",
      "final_surface",
      "catalog_validation",
      "p1_003_foreign_key",
      "security_advisor",
      "non_target_integrity",
    ],
    `${context}.persistent_application_validation`,
  );
  requireTimestamp(
    persistent.reviewed_at,
    `${context}.persistent_application_validation.reviewed_at`,
  );
  if (
    persistent.completed_at !== P1_AUTHORIZATION_CORRECTION_VALIDATED_AT ||
    persistent.environment !== "staging" ||
    persistent.project_ref !== "mxjlvmowmodzdtdfgqpb" ||
    persistent.reviewed_by !== "Rosuno" ||
    persistent.reviewed_at !== P1_AUTHORIZATION_CORRECTION_REVIEWED_AT ||
    persistent.application_status !== "passed" ||
    persistent.validation_checks_passed !== 39 ||
    persistent.validation_checks_total !== 39 ||
    persistent.pending_versions !== 0 ||
    persistent.remote_only_versions !== 0 ||
    persistent.duplicate_versions !== 0 ||
    persistent.generated_or_unexpected_versions !== 0 ||
    persistent.local_remote_reconciliation !== "exact" ||
    persistent.migration_sql_reapplied !== false ||
    persistent.migration_history_repaired !== false ||
    persistent.direct_history_edit !== false
  ) {
    fail(
      `${context} persistent application identity or reconciliation is invalid`,
    );
  }
  requireCatalogArray(
    persistent.migration_history,
    P1_AUTHORIZATION_CORRECTION_MIGRATION_HISTORY.length,
    `${context}.persistent_application_validation.migration_history`,
  );
  for (const [
    index,
    [version, name],
  ] of P1_AUTHORIZATION_CORRECTION_MIGRATION_HISTORY.entries()) {
    const row = persistent.migration_history[index];
    requireExactFields(
      row,
      ["version", "name", "occurrences"],
      `${context}.persistent_application_validation.migration_history[${index}]`,
    );
    if (row.version !== version || row.name !== name || row.occurrences !== 1) {
      fail(`${context} persistent migration history is invalid`);
    }
  }

  const surface = persistent.final_surface;
  requireExactFields(
    surface,
    [
      "retained_tables",
      "absent_tables",
      "retained_table_row_counts",
      "all_relevant_rows_zero",
    ],
    `${context}.persistent_application_validation.final_surface`,
  );
  if (
    surface.retained_tables?.join("|") !==
      "public.staff_profiles|public.capability_definitions|public.capability_grants|public.application_sessions" ||
    surface.absent_tables?.join("|") !==
      "public.attorney_profiles|public.client_profiles" ||
    JSON.stringify(surface.retained_table_row_counts) !==
      JSON.stringify({
        "public.staff_profiles": 0,
        "public.capability_definitions": 0,
        "public.capability_grants": 0,
        "public.application_sessions": 0,
      }) ||
    surface.all_relevant_rows_zero !== true
  ) {
    fail(`${context} final correction surface is invalid`);
  }

  const persistentCatalog = persistent.catalog_validation;
  requireExactFields(
    persistentCatalog,
    [
      "fingerprint",
      "canonical_byte_length",
      "row_count",
      "matches_retained_normalized_snapshot",
      "category_counts",
    ],
    `${context}.persistent_application_validation.catalog_validation`,
  );
  if (
    persistentCatalog.fingerprint !==
      P1_AUTHORIZATION_CORRECTION_CATALOG_SHA256 ||
    persistentCatalog.canonical_byte_length !==
      P1_AUTHORIZATION_CORRECTION_CATALOG_BYTES ||
    persistentCatalog.row_count !== P1_AUTHORIZATION_CORRECTION_CATALOG_ROWS ||
    persistentCatalog.matches_retained_normalized_snapshot !== true ||
    JSON.stringify(persistentCatalog.category_counts) !==
      JSON.stringify(P1_AUTHORIZATION_CORRECTION_CATEGORY_COUNTS)
  ) {
    fail(`${context} persistent catalog validation is invalid`);
  }

  const foreignKey = persistent.p1_003_foreign_key;
  requireExactFields(
    foreignKey,
    [
      "constraint",
      "definition",
      "on_update",
      "on_delete",
      "deferrable",
      "initially_deferred",
      "validated",
      "jurisdiction_id_comment",
    ],
    `${context}.persistent_application_validation.p1_003_foreign_key`,
  );
  if (
    foreignKey.constraint !== "capability_grants_jurisdiction_id_fkey" ||
    foreignKey.definition !==
      "FOREIGN KEY (jurisdiction_id) REFERENCES jurisdictions(id) ON UPDATE RESTRICT ON DELETE RESTRICT" ||
    foreignKey.on_update !== "RESTRICT" ||
    foreignKey.on_delete !== "RESTRICT" ||
    foreignKey.deferrable !== false ||
    foreignKey.initially_deferred !== false ||
    foreignKey.validated !== true ||
    foreignKey.jurisdiction_id_comment !==
      "Optional jurisdiction scope enforced by locked physical Migration 3."
  ) {
    fail(`${context} preserved P1-003 foreign key is invalid`);
  }

  const advisor = persistent.security_advisor;
  requireExactFields(
    advisor,
    ["level", "approved_identities", "additional_findings"],
    `${context}.persistent_application_validation.security_advisor`,
  );
  if (
    advisor.level !== "INFO" ||
    advisor.approved_identities?.join("|") !==
      P1_AUTHORIZATION_CORRECTION_APPROVED_ADVISOR_IDENTITIES.join("|") ||
    advisor.additional_findings !== 0
  ) {
    fail(`${context} persistent security-advisor validation is invalid`);
  }

  const nonTarget = persistent.non_target_integrity;
  requireExactFields(
    nonTarget,
    [
      "source_dev_project_ref",
      "source_dev_migration_history",
      "source_dev_public_table_count",
      "source_dev_unchanged",
      "production_accessed",
      "old_quarantined",
      "old_accessed",
      "old_mutated",
    ],
    `${context}.persistent_application_validation.non_target_integrity`,
  );
  if (
    nonTarget.source_dev_project_ref !== "wwcwfbzwljbjlaifklaj" ||
    nonTarget.source_dev_migration_history?.join("|") !== "20260828192126" ||
    nonTarget.source_dev_public_table_count !== 0 ||
    nonTarget.source_dev_unchanged !== true ||
    nonTarget.production_accessed !== false ||
    nonTarget.old_quarantined !== true ||
    nonTarget.old_accessed !== false ||
    nonTarget.old_mutated !== false
  ) {
    fail(`${context} persistent non-target integrity is invalid`);
  }

  const review = evidence.review_traceability;
  requireExactFields(
    review,
    [
      "pull_request",
      "pull_request_url",
      "approved_head",
      "merge_commit",
      "reviewer",
      "approved_at",
      "merged_at",
    ],
    `${context}.review_traceability`,
  );
  requireTimestamp(
    review.approved_at,
    `${context}.review_traceability.approved_at`,
  );
  requireTimestamp(
    review.merged_at,
    `${context}.review_traceability.merged_at`,
  );
  if (
    review.pull_request !== P1_AUTHORIZATION_CORRECTION_PR ||
    review.pull_request_url !== P1_AUTHORIZATION_CORRECTION_PR_URL ||
    review.approved_head !== P1_AUTHORIZATION_CORRECTION_APPROVED_HEAD ||
    review.merge_commit !== P1_AUTHORIZATION_CORRECTION_MERGE_COMMIT ||
    review.reviewer !== "Rosuno" ||
    review.approved_at !== P1_AUTHORIZATION_CORRECTION_REVIEWED_AT ||
    review.merged_at !== P1_AUTHORIZATION_CORRECTION_MERGED_AT
  ) {
    fail(`${context} review traceability is invalid`);
  }

  validateP1AuthorizationCorrectionFingerprint(
    fingerprint,
    migrationSql,
    fingerprintSourceText,
  );
  const catalog = evidence.catalog_fingerprint;
  const expectedRunSummary = {
    sha256: P1_AUTHORIZATION_CORRECTION_CATALOG_SHA256,
    canonical_byte_length: P1_AUTHORIZATION_CORRECTION_CATALOG_BYTES,
    row_count: P1_AUTHORIZATION_CORRECTION_CATALOG_ROWS,
  };
  if (
    catalog?.evidence_path !== P1_AUTHORIZATION_CORRECTION_FINGERPRINT_PATH ||
    catalog?.evidence_sha256 !==
      P1_AUTHORIZATION_CORRECTION_FINGERPRINT_FILE_SHA256 ||
    catalog?.evidence_bytes !==
      P1_AUTHORIZATION_CORRECTION_FINGERPRINT_FILE_BYTES ||
    catalog?.normalized_content_reference !== "#/normalized_outputs/snapshot" ||
    JSON.stringify(catalog?.category_counts) !==
      JSON.stringify(P1_AUTHORIZATION_CORRECTION_CATEGORY_COUNTS) ||
    JSON.stringify(catalog?.run1) !== JSON.stringify(expectedRunSummary) ||
    JSON.stringify(catalog?.run2) !== JSON.stringify(expectedRunSummary) ||
    catalog?.runs_identical !== true
  ) {
    fail(`${context} catalog reference is invalid`);
  }

  const governance = evidence.governance_state;
  if (
    governance?.decision_status !== "accepted" ||
    governance?.work_item_status !== "completed" ||
    governance?.reviewer_identity !== "Rosuno" ||
    governance?.reviewer_status !== "approved" ||
    governance?.reviewed !== true ||
    governance?.merged !== true ||
    governance?.released !== false ||
    governance?.persistently_applied !== true ||
    governance?.finally_closed !== true ||
    evidence.acceptance_state !== "accepted_staging_application" ||
    evidence.next_gate !==
      "separate protected review before production or P1-004" ||
    evidence.sensitive_payloads_present !== false
  ) {
    fail(`${context} accepted closure state is invalid`);
  }
  const history = evidence.checkpoint_and_revert_history;
  if (
    history?.reverted_attempts?.[0]?.attempt_commit !==
      "6dfb6a5a98e0456c7f1b6876f0441aa1f0299429" ||
    history?.reverted_attempts?.[0]?.revert_commit !==
      "4fe3ea3651643410e1e2dcc6ce1585736e64b866" ||
    history?.reverted_attempts?.[1]?.attempt_commit !==
      "17c2025c4b0eacc78d2926b8acb3fd26ecee89f5" ||
    history?.reverted_attempts?.[1]?.revert_commit !==
      "4261b2d716e25bcc858918cb391bd826de3b234e" ||
    history?.authorized_correction_commits?.join("|") !==
      "fc687c9736f81265b66de3905d278114edf13d61|c64e403420850689b163bf0d6e37a12ab590b805" ||
    history?.configuration_checkpoint?.commit !==
      "7ddf5426cc870f417ff4c91f239906fc0f348cd2" ||
    history?.configuration_checkpoint?.relationship !==
      "separate non-ancestor merge checkpoint; not the correction evidence commit and not imported into this branch" ||
    history?.canonical_configuration_restored_at !==
      "b90f697164723be80029a8756b5dde79bd5f2c6c" ||
    history?.v2_evidence_commit !==
      "7802140d20b9e8cc05dadb9c4c9d1a6556dddd34" ||
    JSON.stringify(history?.chronology) !==
      JSON.stringify(P1_AUTHORIZATION_CORRECTION_CHRONOLOGY) ||
    history?.internal_ledger_evidence?.commit !==
      "7ddf5426cc870f417ff4c91f239906fc0f348cd2" ||
    history?.internal_ledger_evidence?.description !==
      "separate non-ancestor internal Replit checkpoint carrying the same out-of-scope .replit tree" ||
    history?.internal_ledger_evidence?.preserved !== true ||
    history?.internal_ledger_evidence?.imported_into_active_branch !== false ||
    history?.history_integrity?.records_erased !== false ||
    history?.history_integrity?.history_rewritten !== false ||
    history?.history_integrity?.commits_merged !== false ||
    history?.history_integrity?.commits_released !== false ||
    history?.history_integrity?.commits_persistently_applied !== false
  ) {
    fail(`${context} checkpoint or revert history is invalid`);
  }
  if (scanSecretLikeText(JSON.stringify(evidence), context).length > 0) {
    fail(`${context} contains secret-like content`);
  }
}

export function validateP1PlatformEvidence(evidence, migrationSql) {
  requireExactFields(
    evidence,
    [
      "version",
      "evidence_id",
      "work_item_id",
      "scope",
      "authority_refs",
      "projects",
      "baseline",
      "migration",
      "transactional_validation",
      "persistent_application_validation",
      "security",
      "integrity",
      "acceptance_state",
      "next_gate",
      "sensitive_payloads_present",
    ],
    "P1 platform evidence",
  );
  if (
    evidence.version !== 1 ||
    evidence.evidence_id !== "P1-001-PLATFORM-FOUNDATION" ||
    evidence.work_item_id !== "WI-P1-001-PLATFORM-FOUNDATION" ||
    evidence.scope !== "P1/1A physical Migration 1 application identity only"
  ) {
    fail("P1 platform evidence identity is invalid");
  }
  if (
    evidence.projects?.development_ref !== "wwcwfbzwljbjlaifklaj" ||
    evidence.projects?.staging_ref !== "mxjlvmowmodzdtdfgqpb" ||
    evidence.projects?.old_project_accessed !== false
  ) {
    fail("P1 platform evidence project boundary is invalid");
  }
  if (
    evidence.baseline?.development_public_table_count !== 0 ||
    evidence.baseline?.staging_public_table_count !== 0 ||
    evidence.baseline?.ensure_rls_enabled !== true ||
    evidence.baseline?.rls_auto_enable_execute_roles?.join("|") !==
      "postgres|service_role"
  ) {
    fail("P1 platform evidence baseline is invalid");
  }
  const digest = createHash("sha256").update(migrationSql).digest("hex");
  if (
    evidence.migration?.migration_id !==
      "20260829000015_p1_platform_foundation" ||
    evidence.migration?.sha256 !== digest ||
    evidence.migration?.created_relations?.join("|") !== "public.users" ||
    evidence.migration?.created_functions?.join("|") !==
      "public.set_updated_at()" ||
    evidence.migration?.extension_changes?.length !== 0 ||
    evidence.migration?.later_migration_relations_created !== false ||
    evidence.migration?.persistent_application !== true
  ) {
    fail("P1 platform evidence migration record is invalid");
  }
  requireTimestamp(
    evidence.transactional_validation?.completed_at,
    "P1 platform evidence transactional_validation.completed_at",
  );
  if (
    evidence.transactional_validation?.environment !== "staging" ||
    evidence.transactional_validation?.catalog_assertions !== "passed" ||
    evidence.transactional_validation?.rollback !== "passed" ||
    evidence.transactional_validation?.users_absent_after_rollback !== true ||
    evidence.transactional_validation?.function_absent_after_rollback !==
      true ||
    evidence.transactional_validation?.migration_history_unchanged !== true ||
    evidence.transactional_validation?.source_unchanged !== true
  ) {
    fail("P1 platform evidence transactional validation is invalid");
  }
  const application = evidence.persistent_application_validation;
  requireExactFields(
    application,
    [
      "environment",
      "project_ref",
      "reviewed_by",
      "reviewed_at",
      "application_status",
      "migration_history",
      "history_reconciliation",
      "catalog_validation",
      "non_target_integrity",
    ],
    "P1 persistent application validation",
  );
  requireTimestamp(
    application.reviewed_at,
    "P1 persistent application validation.reviewed_at",
  );
  if (
    application.environment !== "staging" ||
    application.project_ref !== "mxjlvmowmodzdtdfgqpb" ||
    application.reviewed_by !== "Rosuno" ||
    application.reviewed_at !== "2026-08-29T15:16:33Z" ||
    application.application_status !== "passed"
  ) {
    fail("P1 persistent application identity is invalid");
  }
  const history = application.migration_history;
  requireExactFields(
    history,
    [
      "p0_version",
      "p0_occurrences",
      "reviewed_version",
      "reviewed_name",
      "reviewed_occurrences",
      "generated_version",
      "generated_occurrences",
    ],
    "P1 persistent application migration history",
  );
  if (
    history.p0_version !== "20260828192126" ||
    history.p0_occurrences !== 1 ||
    history.reviewed_version !== "20260829000015" ||
    history.reviewed_name !== "p1_platform_foundation" ||
    history.reviewed_occurrences !== 1 ||
    history.generated_version !== "20260829153932" ||
    history.generated_occurrences !== 0
  ) {
    fail("P1 persistent application migration history is invalid");
  }
  const reconciliation = application.history_reconciliation;
  requireExactFields(
    reconciliation,
    [
      "tool",
      "version",
      "exit_code",
      "migration_sql_rerun",
      "direct_history_edit",
    ],
    "P1 persistent application history reconciliation",
  );
  if (
    reconciliation.tool !== "official Supabase CLI" ||
    reconciliation.version !== "2.116.0" ||
    reconciliation.exit_code !== 0 ||
    reconciliation.migration_sql_rerun !== false ||
    reconciliation.direct_history_edit !== false
  ) {
    fail("P1 persistent application history reconciliation is invalid");
  }
  const catalog = application.catalog_validation;
  requireExactFields(
    catalog,
    [
      "reviewed_schema_exact",
      "drift_status",
      "users_row_count",
      "rls",
      "policy",
      "trigger",
      "function",
      "grants",
      "security_advisor_findings",
    ],
    "P1 persistent application catalog validation",
  );
  if (
    catalog.reviewed_schema_exact !== true ||
    catalog.drift_status !== "clean" ||
    catalog.users_row_count !== 0 ||
    ["rls", "policy", "trigger", "function", "grants"].some(
      (field) => catalog[field] !== "passed",
    ) ||
    catalog.security_advisor_findings !== 0
  ) {
    fail("P1 persistent application catalog validation is invalid");
  }
  const nonTarget = application.non_target_integrity;
  requireExactFields(
    nonTarget,
    [
      "source_unchanged",
      "development_unchanged",
      "production_accessed",
      "old_project_accessed",
      "repository_files_mutated_by_database_application",
    ],
    "P1 persistent application non-target integrity",
  );
  if (
    nonTarget.source_unchanged !== true ||
    nonTarget.development_unchanged !== true ||
    nonTarget.production_accessed !== false ||
    nonTarget.old_project_accessed !== false ||
    nonTarget.repository_files_mutated_by_database_application !== false
  ) {
    fail("P1 persistent application non-target integrity is invalid");
  }
  if (
    evidence.security?.users_rls_enabled !== true ||
    evidence.security?.anon_table_privileges?.length !== 0 ||
    evidence.security?.authenticated_table_privileges?.join("|") !== "SELECT" ||
    evidence.security?.service_role_table_privileges?.join("|") !==
      "SELECT|INSERT|UPDATE" ||
    evidence.security?.service_role_delete !== false ||
    evidence.security?.authenticated_select_policy !== "users_select_own" ||
    evidence.security?.authenticated_insert_denied_sqlstate !== "42501" ||
    evidence.security?.anon_select_denied_sqlstate !== "42501" ||
    evidence.security?.set_updated_at_security_definer !== false ||
    evidence.security?.set_updated_at_execute_roles?.join("|") !==
      "postgres|service_role" ||
    evidence.security?.development_security_advisor_findings !== 0 ||
    evidence.security?.staging_security_advisor_findings !== 0
  ) {
    fail("P1 platform evidence security state is invalid");
  }
  if (
    evidence.integrity?.one_user_per_auth_identity !== true ||
    evidence.integrity?.auth_identity_foreign_key !== true ||
    evidence.integrity?.auth_identity_delete_restricted !== true ||
    evidence.integrity?.account_states?.join("|") !==
      "pending_verification|active|suspended|closed" ||
    evidence.integrity?.server_uuid_default !== true ||
    evidence.integrity?.server_timestamp_defaults !== true ||
    evidence.integrity?.updated_at_trigger_enabled !== true
  ) {
    fail("P1 platform evidence integrity state is invalid");
  }
  if (
    evidence.acceptance_state !== "applied_to_staging" ||
    evidence.next_gate !==
      "separate protected review before production or later P1 work" ||
    evidence.sensitive_payloads_present !== false
  ) {
    fail("P1 platform evidence acceptance gate is invalid");
  }
  if (
    scanSecretLikeText(JSON.stringify(evidence), "P1 platform evidence").length
  ) {
    fail("P1 platform evidence contains a secret-like value");
  }
}

export function validateP1ApplicationTraceability(
  migrationRegister,
  workItemRegister,
  decisionRegister,
  releaseRegister,
) {
  const migration = migrationRegister.migrations.find(
    (entry) => entry.migration_id === "20260829000015_p1_platform_foundation",
  );
  const workItem = workItemRegister.work_items.find(
    (entry) => entry.work_item_id === "WI-P1-001-PLATFORM-FOUNDATION",
  );
  const decision = decisionRegister.decisions.find(
    (entry) => entry.decision_id === "DEC-20260829-P1-PLATFORM-FOUNDATION",
  );
  const release = releaseRegister.releases.find(
    (entry) => entry.release_id === "REL-20260829-P1-STAGING-APPLICATION",
  );
  const releaseId = "REL-20260829-P1-STAGING-APPLICATION";
  const approvedAt = "2026-08-29T15:16:33Z";

  if (
    !migration ||
    migration.reviewed !== true ||
    migration.reviewed_by !== "Rosuno" ||
    migration.reviewed_at !== approvedAt ||
    migration.applied_environment !== "staging" ||
    migration.non_production_validation !== true ||
    migration.drift_check !== "clean" ||
    migration.release_refs?.join("|") !== releaseId
  ) {
    fail("P1 applied migration traceability is invalid");
  }
  if (
    !workItem ||
    workItem.status !== "completed" ||
    workItem.environment !== "staging" ||
    workItem.reviewer?.identity !== "Rosuno" ||
    workItem.reviewer?.status !== "approved" ||
    workItem.updated_at !== approvedAt ||
    workItem.release_refs?.join("|") !== releaseId
  ) {
    fail("P1 applied work-item traceability is invalid");
  }
  if (
    !decision ||
    decision.status !== "accepted" ||
    decision.reviewer?.identity !== "Rosuno" ||
    decision.reviewer?.status !== "approved" ||
    decision.updated_at !== approvedAt ||
    !decision.evidence?.includes(
      "governance/evidence/p1-001-platform-foundation.json",
    ) ||
    !decision.evidence?.includes("governance/releases/traceability.json")
  ) {
    fail("P1 applied decision traceability is invalid");
  }
  if (
    !release ||
    release.commit_sha !== "0b08908621494476359bbbcdc173928bac8f4893" ||
    release.artifact_digest !==
      "sha256:67dfd44b2bd7525a588e6eb59c33a0056f3a5c67eec5f45dd93e6aab37f7afc8" ||
    release.environment !== "staging" ||
    release.reviewer?.identity !== "Rosuno" ||
    release.reviewer?.status !== "approved" ||
    release.created_at !== approvedAt ||
    release.work_item_refs?.join("|") !== "WI-P1-001-PLATFORM-FOUNDATION" ||
    release.decision_refs?.join("|") !==
      "DEC-20260829-P1-PLATFORM-FOUNDATION" ||
    release.migration_refs?.join("|") !==
      "20260829000015_p1_platform_foundation" ||
    !release.validation_evidence?.includes(
      "governance/evidence/p1-001-platform-foundation.json",
    ) ||
    !release.validation_evidence?.includes(
      "supabase/migrations/20260829000015_p1_platform_foundation.sql",
    )
  ) {
    fail("P1 Staging traceability record is invalid");
  }
}

export function validateP1AuthorizationLifecycleTraceability(
  migrationRegister,
  workItemRegister,
  decisionRegister,
  releaseRegister,
) {
  const migration = migrationRegister.migrations.find(
    (entry) => entry.migration_id === P1_AUTHORIZATION_MIGRATION_ID,
  );
  const workItem = workItemRegister.work_items.find(
    (entry) => entry.work_item_id === P1_AUTHORIZATION_WORK_ITEM_ID,
  );
  const decision = decisionRegister.decisions.find(
    (entry) => entry.decision_id === P1_AUTHORIZATION_DECISION_ID,
  );
  const release = releaseRegister.releases.find(
    (entry) => entry.release_id === P1_AUTHORIZATION_RELEASE_ID,
  );
  const governanceWorkItem = workItemRegister.work_items.find(
    (entry) => entry.work_item_id === P1_GOVERNANCE_CORRECTION_WORK_ITEM_ID,
  );
  const governanceDecision = decisionRegister.decisions.find(
    (entry) => entry.decision_id === P1_GOVERNANCE_CORRECTION_DECISION_ID,
  );
  if (
    !migration ||
    migration.reviewed !== true ||
    migration.reviewed_by !== "Rosuno" ||
    migration.reviewed_at !== P1_AUTHORIZATION_REVIEWED_AT ||
    migration.applied_environment !== "staging" ||
    migration.non_production_validation !== true ||
    migration.release_refs?.join("|") !== P1_AUTHORIZATION_RELEASE_ID
  ) {
    fail("P1-002 reviewed and applied migration traceability is invalid");
  }
  if (
    !workItem ||
    workItem.status !== "completed" ||
    workItem.reviewer?.identity !== "Rosuno" ||
    workItem.reviewer?.status !== "approved" ||
    workItem.updated_at !== P1_AUTHORIZATION_ACCEPTED_AT ||
    workItem.release_refs?.join("|") !== P1_AUTHORIZATION_RELEASE_ID
  ) {
    fail("P1-002 completed work-item traceability is invalid");
  }
  if (
    !decision ||
    decision.status !== "accepted" ||
    decision.reviewer?.identity !== "Rosuno" ||
    decision.reviewer?.status !== "approved" ||
    decision.updated_at !== P1_AUTHORIZATION_ACCEPTED_AT ||
    !decision.evidence?.includes(P1_AUTHORIZATION_LIFECYCLE_EVIDENCE_PATH) ||
    !decision.evidence?.includes("governance/releases/traceability.json")
  ) {
    fail("P1-002 accepted decision traceability is invalid");
  }
  if (
    !release ||
    release.commit_sha !== "6b279d56e8314abd7b7a7bf393e4de1e8a864235" ||
    release.work_item_refs?.join("|") !== P1_AUTHORIZATION_WORK_ITEM_ID ||
    release.decision_refs?.join("|") !== P1_AUTHORIZATION_DECISION_ID ||
    release.migration_refs?.join("|") !== P1_AUTHORIZATION_MIGRATION_ID ||
    release.artifact_digest !== `sha256:${P1_AUTHORIZATION_MIGRATION_SHA256}` ||
    release.environment !== "staging" ||
    release.reviewer?.identity !== "Rosuno" ||
    release.reviewer?.status !== "approved" ||
    release.created_at !== P1_AUTHORIZATION_ACCEPTED_AT ||
    !release.validation_evidence?.includes(
      P1_AUTHORIZATION_LIFECYCLE_EVIDENCE_PATH,
    )
  ) {
    fail("P1-002 historical Staging release traceability is invalid");
  }
  if (
    !governanceDecision ||
    governanceDecision.title !==
      "Accept P1-002 governance and baseline control correction" ||
    governanceDecision.status !== "accepted" ||
    governanceDecision.reviewer?.identity !== "Rosuno" ||
    governanceDecision.reviewer?.status !== "approved" ||
    governanceDecision.updated_at !== "2026-09-09T18:09:50Z" ||
    governanceDecision.impact !==
      "Accepted governance-only correction after Rosuno approval, successful required CI, and protected merge in PR #12. It performs no database operation, production activity, OLD access, or P1-004 work." ||
    !governanceDecision.evidence?.includes(
      P1_AUTHORIZATION_LIFECYCLE_EVIDENCE_PATH,
    ) ||
    !governanceWorkItem ||
    governanceWorkItem.status !== "completed" ||
    governanceWorkItem.reviewer?.identity !== "Rosuno" ||
    governanceWorkItem.reviewer?.status !== "approved" ||
    governanceWorkItem.updated_at !== "2026-09-09T18:09:50Z" ||
    !governanceWorkItem.acceptance_criteria?.includes(
      "PR #12 protected review, Rosuno approval, successful required CI, exact merge topology, and merge tree are recorded; the governance correction is finally accepted",
    ) ||
    governanceWorkItem.acceptance_criteria?.some((criterion) =>
      criterion.includes("remains locally pending"),
    ) ||
    governanceWorkItem.rollback_reference !==
      "Revert only the governance-closure commit; do not alter migration history or any database." ||
    governanceWorkItem.release_refs?.length !== 0 ||
    governanceWorkItem.migration_refs?.length !== 0
  ) {
    fail(
      "P1-002 governance correction must be accepted after PR #12 protected review",
    );
  }
}

export function validateP1RegulatoryTraceability(
  migrationRegister,
  workItemRegister,
  decisionRegister,
  releaseRegister,
) {
  const migrationId = "20260830023823_p1_jurisdiction_policy_launch_foundation";
  const workItemId = "WI-P1-003-JURISDICTION-POLICY-LAUNCH-FOUNDATION";
  const decisionId = "DEC-20260830-P1-JURISDICTION-POLICY-LAUNCH-FOUNDATION";
  const releaseId = "REL-20260830-P1-003-STAGING-APPLICATION";
  const reviewedAt = "2026-08-30T05:02:26Z";
  const acceptedAt = "2026-08-30T20:29:17Z";
  const migration = migrationRegister.migrations.find(
    (entry) => entry.migration_id === migrationId,
  );
  const workItem = workItemRegister.work_items.find(
    (entry) => entry.work_item_id === workItemId,
  );
  const decision = decisionRegister.decisions.find(
    (entry) => entry.decision_id === decisionId,
  );
  const release = releaseRegister.releases.find(
    (entry) => entry.release_id === releaseId,
  );

  if (
    !migration ||
    migration.reviewed !== true ||
    migration.reviewed_by !== "Rosuno" ||
    migration.reviewed_at !== reviewedAt ||
    migration.applied_environment !== "staging" ||
    migration.non_production_validation !== true ||
    migration.drift_check !==
      "Supabase CLI shadow comparison unavailable because Replit OCI setns failed during pg_isready before P1-003 SQL or schema comparison; compensating corrected direct-catalog validation passed and no clean CLI drift result is claimed." ||
    migration.release_refs?.join("|") !== releaseId
  ) {
    fail("P1-003 applied migration traceability is invalid");
  }
  if (
    !workItem ||
    workItem.status !== "completed" ||
    workItem.environment !== "staging" ||
    workItem.reviewer?.identity !== "Rosuno" ||
    workItem.reviewer?.status !== "approved" ||
    workItem.updated_at !== acceptedAt ||
    workItem.release_refs?.join("|") !== releaseId
  ) {
    fail("P1-003 applied work-item traceability is invalid");
  }
  if (
    !decision ||
    decision.status !== "accepted" ||
    decision.reviewer?.identity !== "Rosuno" ||
    decision.reviewer?.status !== "approved" ||
    decision.updated_at !== acceptedAt ||
    !decision.evidence?.includes(
      "governance/evidence/p1-003-jurisdiction-policy-launch-foundation.json",
    ) ||
    !decision.evidence?.includes("governance/releases/traceability.json")
  ) {
    fail("P1-003 applied decision traceability is invalid");
  }
  if (
    !release ||
    release.commit_sha !== "0ba2331b88fd5f045573b3e2d140f03e240b6a77" ||
    release.artifact_digest !==
      "sha256:94e9b746cf303154790bc51e8160f9184b2e9765e82ec2702e03030f7a79b7ee" ||
    release.environment !== "staging" ||
    release.reviewer?.identity !== "Rosuno" ||
    release.reviewer?.status !== "approved" ||
    release.created_at !== acceptedAt ||
    release.work_item_refs?.join("|") !== workItemId ||
    release.decision_refs?.join("|") !== decisionId ||
    release.migration_refs?.join("|") !== migrationId ||
    !release.validation_evidence?.includes(
      "governance/evidence/p1-003-jurisdiction-policy-launch-foundation.json",
    ) ||
    !release.validation_evidence?.includes(
      "supabase/migrations/20260830023823_p1_jurisdiction_policy_launch_foundation.sql",
    )
  ) {
    fail("P1-003 Staging traceability record is invalid");
  }
}

export function validateP1AuthorizationCorrectionTraceability(
  migrationRegister,
  workItemRegister,
  decisionRegister,
  releaseRegister,
) {
  const migration = migrationRegister.migrations.find(
    (entry) => entry.migration_id === P1_AUTHORIZATION_CORRECTION_MIGRATION_ID,
  );
  const workItem = workItemRegister.work_items.find(
    (entry) => entry.work_item_id === P1_AUTHORIZATION_CORRECTION_WORK_ITEM_ID,
  );
  const decision = decisionRegister.decisions.find(
    (entry) => entry.decision_id === P1_AUTHORIZATION_CORRECTION_DECISION_ID,
  );
  const release = releaseRegister.releases.find(
    (entry) => entry.release_id === P1_AUTHORIZATION_CORRECTION_RELEASE_ID,
  );
  if (
    !migration ||
    migration.migration_kind !== "product" ||
    migration.sequence !== 5 ||
    migration.artifact_path !== P1_AUTHORIZATION_CORRECTION_MIGRATION_PATH ||
    migration.work_item_refs?.join("|") !==
      P1_AUTHORIZATION_CORRECTION_WORK_ITEM_ID ||
    migration.decision_refs?.join("|") !==
      P1_AUTHORIZATION_CORRECTION_DECISION_ID ||
    migration.release_refs?.join("|") !==
      P1_AUTHORIZATION_CORRECTION_RELEASE_ID ||
    migration.reviewed !== true ||
    migration.reviewed_by !== "Rosuno" ||
    migration.reviewed_at !== P1_AUTHORIZATION_CORRECTION_REVIEWED_AT ||
    migration.applied_environment !== "staging" ||
    migration.non_production_validation !== true ||
    migration.drift_check !== P1_AUTHORIZATION_CORRECTION_DRIFT_CHECK ||
    migration.depends_on?.join("|") !==
      "20260830023823_p1_jurisdiction_policy_launch_foundation"
  ) {
    fail("P1 authorization correction migration traceability is invalid");
  }
  if (
    !workItem ||
    workItem.status !== "completed" ||
    workItem.environment !== "staging" ||
    workItem.reviewer?.identity !== "Rosuno" ||
    workItem.reviewer?.status !== "approved" ||
    workItem.updated_at !== P1_AUTHORIZATION_CORRECTION_ACCEPTED_AT ||
    workItem.decision_refs?.join("|") !==
      P1_AUTHORIZATION_CORRECTION_DECISION_ID ||
    workItem.migration_refs?.join("|") !==
      P1_AUTHORIZATION_CORRECTION_MIGRATION_ID ||
    workItem.release_refs?.join("|") !== P1_AUTHORIZATION_CORRECTION_RELEASE_ID
  ) {
    fail("P1 authorization correction work-item traceability is invalid");
  }
  if (
    !decision ||
    decision.status !== "accepted" ||
    decision.reviewer?.identity !== "Rosuno" ||
    decision.reviewer?.status !== "approved" ||
    decision.updated_at !== P1_AUTHORIZATION_CORRECTION_ACCEPTED_AT ||
    decision.work_item_refs?.join("|") !==
      P1_AUTHORIZATION_CORRECTION_WORK_ITEM_ID ||
    !decision.evidence?.includes(P1_AUTHORIZATION_CORRECTION_MIGRATION_PATH) ||
    !decision.evidence?.includes(P1_AUTHORIZATION_CORRECTION_EVIDENCE_PATH) ||
    !decision.evidence?.includes(
      P1_AUTHORIZATION_CORRECTION_FINGERPRINT_PATH,
    ) ||
    !decision.evidence?.includes("governance/releases/traceability.json")
  ) {
    fail("P1 authorization correction decision traceability is invalid");
  }
  if (
    !release ||
    release.commit_sha !== P1_AUTHORIZATION_CORRECTION_MERGE_COMMIT ||
    release.work_item_refs?.join("|") !==
      P1_AUTHORIZATION_CORRECTION_WORK_ITEM_ID ||
    release.decision_refs?.join("|") !==
      P1_AUTHORIZATION_CORRECTION_DECISION_ID ||
    release.migration_refs?.join("|") !==
      P1_AUTHORIZATION_CORRECTION_MIGRATION_ID ||
    release.artifact_digest !==
      `sha256:${P1_AUTHORIZATION_CORRECTION_MIGRATION_SHA256}` ||
    release.environment !== "staging" ||
    release.reviewer?.identity !== "Rosuno" ||
    release.reviewer?.status !== "approved" ||
    release.rollback_reference !== P1_AUTHORIZATION_CORRECTION_EVIDENCE_PATH ||
    release.created_at !== P1_AUTHORIZATION_CORRECTION_ACCEPTED_AT ||
    !release.validation_evidence?.includes(
      P1_AUTHORIZATION_CORRECTION_EVIDENCE_PATH,
    ) ||
    !release.validation_evidence?.includes(
      P1_AUTHORIZATION_CORRECTION_FINGERPRINT_PATH,
    ) ||
    !release.validation_evidence?.includes(
      P1_AUTHORIZATION_CORRECTION_MIGRATION_PATH,
    )
  ) {
    fail("P1 authorization correction Staging traceability is invalid");
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

export const P1_ATTORNEY_PENDING =
  "P1-004 rollback-only Rosuno Staging validation pending; local unreviewed/unapplied candidate; no release; five-migration persistent baseline unchanged.";
export const P1_ATTORNEY_VALIDATED =
  "P1-004 rollback-only Rosuno Staging validation passed with exact restoration of the five-migration baseline; local unreviewed/unapplied candidate; no release.";
const P1_ATTORNEY_EVIDENCE_PATH =
  "governance/evidence/p1-004-attorney-verification-eligibility-foundation.json";
const P1_ATTORNEY_CLOSURE_EVIDENCE_PATH =
  "governance/evidence/p1-004-governance-lifecycle-closure.json";
const P1_ATTORNEY_ID =
  /^([0-9]{14})_p1_attorney_verification_eligibility_foundation$/;

// Accepted P1-004 closure contract; changes require a separately reviewed gate.

const P1004_FINAL = {
  evidence: {
    version: 1,
    evidence_id: "P1-004-GOVERNANCE-LIFECYCLE-CLOSURE-20260910",
    work_item_id: "WI-P1-004-ATTORNEY-VERIFICATION-ELIGIBILITY-FOUNDATION",
    lifecycle: "ACCEPTED — COMPLETED — REVIEWED — STAGING — RELEASED — CLOSED",
    lifecycle_state: {
      repository_closure: true,
      staging_application: true,
      postapplication_readonly_verification: true,
    },
    authorization: {
      merge_base: "06fb7b6fe0616f724ac5cbe048b8a4a2964c6f60",
      tree: "18b8e9031474201e274924664b2c3cb81a452a3c",
      head: "a4712f5f092c1c6e44b04ff5fb5fe1ffba926e04",
      pull_request: 14,
      title: "P1-004: attorney verification and eligibility foundation",
      review: {
        identity: "Rosuno",
        status: "approved",
        review_id: "5169513513",
        approved_at: "2026-09-10T16:09:05Z",
      },
      merged_at: "2026-09-10T16:13:01Z",
      approved_head: "a4712f5f092c1c6e44b04ff5fb5fe1ffba926e04",
      merge_commit: "4dfc3b2b6e83f5a5bc9f54ef108f88306827c667",
      ordered_parents: [
        "06fb7b6fe0616f724ac5cbe048b8a4a2964c6f60",
        "a4712f5f092c1c6e44b04ff5fb5fe1ffba926e04",
      ],
    },
    migration: {
      id: "20260910075939_p1_attorney_verification_eligibility_foundation",
      sha256:
        "09107387d2bd699189a7cdf970c1de18f89ca5cde5074d596274d63361d59231",
      sequence: 6,
      history_versions: 6,
      history: [
        "20260828192126_p0_restrict_rls_auto_enable_execution",
        "20260829000015_p1_platform_foundation",
        "20260829171701_p1_authorization_foundation",
        "20260830023823_p1_jurisdiction_policy_launch_foundation",
        "20260901012518_p1_authorization_scope_correction",
        "20260910075939_p1_attorney_verification_eligibility_foundation",
      ],
    },
    release: {
      id: "REL-20260910-P1-004-STAGING-APPLICATION",
      commit_sha: "4dfc3b2b6e83f5a5bc9f54ef108f88306827c667",
      environment: "staging",
      project_ref: "mxjlvmowmodzdtdfgqpb",
      migration_id:
        "20260910075939_p1_attorney_verification_eligibility_foundation",
      migration_digest:
        "sha256:09107387d2bd699189a7cdf970c1de18f89ca5cde5074d596274d63361d59231",
      evidence_link:
        "governance/evidence/p1-004-governance-lifecycle-closure.json",
      supabase_cli: "2.116.0",
      application_exit: 0,
      created_at: "2026-09-10T18:27:37Z",
      created_at_semantics: "traceability record creation",
    },
    catalog_fingerprints: {
      baseline: {
        sha256:
          "72825bbbfe9d8f0bdbbc4bb7967d8a343f552a0db104cc62f2e6b2fabae4323e",
        canonical_byte_length: 31443,
        row_count: 102,
      },
      candidate: {
        sha256:
          "f79a78d39870ed25ac94ac58d646ea997c9bacf15199d0c1d1abe6dbfe634508",
        canonical_byte_length: 90175,
        row_count: 279,
      },
      scope:
        "baseline is the retained four-table foundation; candidate is exactly nine P1-004 relations and one approved helper",
      membership: {
        foundation: [
          "public.staff_profiles",
          "public.capability_definitions",
          "public.capability_grants",
          "public.application_sessions",
        ],
        candidate: [
          "public.attorney_profiles",
          "public.licenses",
          "public.insurance_records",
          "public.discipline_records",
          "public.practice_areas",
          "public.practice_area_authorisations",
          "public.verification_evidence",
          "public.eligibility_evaluations",
          "public.verification_evidence_subjects",
        ],
      },
      query_scopes: {
        foundation: {
          tables: [
            "public.staff_profiles",
            "public.capability_definitions",
            "public.capability_grants",
            "public.application_sessions",
          ],
          functions: ["public.rls_auto_enable", "public.set_updated_at"],
          principals: [
            "PUBLIC",
            "anon",
            "authenticated",
            "service_role",
            "owner",
          ],
          categories: [
            "table",
            "column",
            "constraint",
            "index",
            "foreign_key",
            "rls",
            "policy",
            "trigger",
            "function",
            "table_privilege",
            "function_privilege",
          ],
        },
        candidate: {
          tables: [
            "public.attorney_profiles",
            "public.licenses",
            "public.insurance_records",
            "public.discipline_records",
            "public.practice_areas",
            "public.practice_area_authorisations",
            "public.verification_evidence",
            "public.eligibility_evaluations",
            "public.verification_evidence_subjects",
          ],
          functions: ["public.has_manage_attorney_verification_scope"],
          principals: [
            "PUBLIC",
            "anon",
            "authenticated",
            "service_role",
            "owner",
          ],
          categories: [
            "table",
            "column",
            "constraint",
            "index",
            "foreign_key",
            "rls",
            "policy",
            "trigger",
            "function",
            "table_privilege",
            "function_privilege",
          ],
        },
      },
    },
    table_counts: {
      candidate_tables: 9,
      candidate_structural_tables_and_controls: 24,
    },
    validation: {
      retained_rollback_only_evidence:
        "governance/evidence/p1-004-attorney-verification-eligibility-foundation.json",
      zero_business_rows: true,
      sole_seed: {
        count: 1,
        description: "one capability seed only",
        capability_code: "manage_attorney_verification",
      },
      advisor: {
        info_count: 13,
        warn_count: 1,
        warn_bound:
          "Accepted only for the exact P1-004 helper and approved contract.",
        unexplained_local_event: true,
        additional_findings: 0,
      },
      advisor_findings: {
        info: [
          "rls_enabled_no_policy:public.application_sessions",
          "rls_enabled_no_policy:public.capability_definitions",
          "rls_enabled_no_policy:public.capability_grants",
          "rls_enabled_no_policy:public.jurisdiction_regulatory_modes",
          "rls_enabled_no_policy:public.jurisdictions",
          "rls_enabled_no_policy:public.launch_authorizations",
          "rls_enabled_no_policy:public.launch_gate_evaluations",
          "rls_enabled_no_policy:public.launch_gates",
          "rls_enabled_no_policy:public.policy_authority_references",
          "rls_enabled_no_policy:public.policy_types",
          "rls_enabled_no_policy:public.policy_versions",
          "rls_enabled_no_policy:public.regulatory_modes",
          "rls_enabled_no_policy:public.service_areas",
        ],
        warn: {
          code: "authenticated_security_definer_function_executable",
          target: {
            schema: "public",
            function: "has_manage_attorney_verification_scope",
            arguments: [
              "required_jurisdiction uuid",
              "allow_any_jurisdiction boolean",
            ],
            language: "sql",
            security_definer: true,
          },
        },
        unapproved: [],
      },
      helper_contract: {
        identity: "public.has_manage_attorney_verification_scope(uuid,boolean)",
        security_definer: true,
        stable: true,
        search_path: "pg_catalog",
        anon_execute: false,
        authenticated_execute: true,
        service_execute: false,
        diagnosis: {
          pg_get_function_identity_arguments:
            "required_jurisdiction uuid, allow_any_jurisdiction boolean",
          named_argument_mismatch: true,
          regprocedure_namespace_name_exactly_one: true,
          regprocedure:
            "public.has_manage_attorney_verification_scope(uuid,boolean)",
          database_discrepancy: false,
          failed_comparison: "uuid, boolean",
          function_row_incorrectly_excluded: true,
        },
        contract: {
          count: 1,
          callable:
            "public.has_manage_attorney_verification_scope(uuid,boolean)",
          named_arguments: ["required_jurisdiction", "allow_any_jurisdiction"],
          return_type: "boolean",
          language: "sql",
          volatility: "STABLE",
          security_definer: true,
          owner: "postgres",
          search_path: "pg_catalog",
          execute: {
            auth: true,
            PUBLIC: false,
            anon: false,
            service_role: false,
          },
          authenticated_select_capability_grants: false,
          identity_arguments:
            "required_jurisdiction uuid, allow_any_jurisdiction boolean",
        },
      },
      dry_run_reproduction: {
        cli: "2.116.0",
        exit: 0,
        up_to_date: false,
        migrations: [
          "20260910075939_p1_attorney_verification_eligibility_foundation.sql",
        ],
        persistent_change: false,
        output_sha256:
          "77b9d667679a58132daf4233942a61b669cb53e748d108e9c2b38a54baf7e08b",
        controlled_reproduction: {
          metadata_changes: 0,
          content_changes: 0,
          failed_to_reproduce: true,
          path_changes: 0,
        },
      },
      checks: [
        "exact six-version migration history",
        "both fingerprint scopes",
        "24/9 tables",
        "zero business rows",
        "sole seed",
        "exact Advisor state",
        "helper contract and false-negative diagnosis",
        "zero-change dry-run reproduction",
      ],
      business_row_counts: {
        attorney_profiles: 0,
        licenses: 0,
        insurance_records: 0,
        discipline_records: 0,
        practice_areas: 0,
        practice_area_authorisations: 0,
        verification_evidence: 0,
        eligibility_evaluations: 0,
        verification_evidence_subjects: 0,
      },
    },
    boundaries: {
      source_absent: true,
      development_absent: true,
      production_untouched: true,
      old_accessed: false,
      database_contacted_for_closure: false,
      one_application_exit: 0,
      unexplained_local_event:
        "retained evidence records an unexplained .local event; no attribution or authorization is inferred",
      local_state: {
        explained: false,
        attribution: null,
        cause: null,
        erased: false,
        status: "unexplained",
      },
      database_discrepancy: false,
    },
    historical_evidence_hashes: {
      candidate_rollback:
        "sha256:d7bce5ae1957543a8e3f6d21476b570f90bb7ceb0b39c8d7f55850a21fb428df",
      validation_details:
        "sha256:9c5944113486a56321ffb42d214399df57e883504cccf5f77985c2a77130c49d",
      p1_003:
        "sha256:59f4facdc8115606cedf517b17f690f050b8203287289ca6735ddaa26d7c6f34",
      p1_002_correction:
        "sha256:4f63b0d550d5a1a589549d031a7184ec7072cd96fdbd20a47918613e0fc6136f",
      p1_002_fingerprint:
        "sha256:c5bb94594f8a82915ad5a9faabbee00ad90bf782914de072bee8a6a5fa333e6f",
    },
    integrity: {
      historical_migrations_unchanged: true,
      historical_evidence_unchanged: true,
      production_untouched: true,
      old_not_accessed: true,
      sensitive_payloads_present: false,
    },
    database_contact: {
      repository_governance_closure: false,
      prior_separately_authorized_staging_application: true,
      subsequent_staging_verification: {
        contacted_database: true,
        read_only: true,
      },
    },
    fresh_reconciliation: {
      snapshot_timestamp: "2026-09-10T22:48:00.544397Z",
      isolation: "REPEATABLE READ",
      read_only: true,
      meaning:
        "new accepted catalog reconciliation, not original application time",
      advisor_observed_at: "2026-09-10T22:48:41.317Z",
    },
    unexpected_agent_checkpoint: {
      commit: "aa678911ff7fc41f630330de2a185c0bc11c4919",
      tree: "187a234d0fffe9bdf96d00a5c8405c349fcb54d4",
      parent: "cf8120776010af7c8836c8ba6d4b9736ec60012b",
      author: "Replit Agent",
      committer: "Replit Agent",
      author_timestamp: "2026-09-10T18:50:17Z",
      committer_timestamp: "2026-09-10T18:50:17Z",
      subject:
        "Update governance lifecycle evidence and add control automation tools",
      authorship_trailer: "Replit-Commit-Author: Agent",
      validation_at_discovery: {
        formatting_check: "failed",
        p0_closure_controls: "failed",
        full_p0_tests: "not completed",
        typecheck: "not completed",
        build: "not completed",
        secrets_check: "passed",
        dependency_security_audit: "passed",
        later_passing_full_validation_before_discovery_proven: false,
      },
      authorized_validated_commit: false,
      passing_full_validation_before_discovery_proven: false,
      pushed: false,
      remote_closure_branch_present_at_discovery: false,
      github_main_at_discovery: "4dfc3b2b6e83f5a5bc9f54ef108f88306827c667",
      exact_internal_trigger_proven: false,
      exact_internal_trigger: null,
      correction_paths: [
        "governance/evidence/p1-004-governance-lifecycle-closure.json",
        "governance/schema-drift/baseline.json",
        "tools/p0/lib/controls.mjs",
        "tools/p0/tests/p0-controls.test.mjs",
      ],
      observed_ref_movements: [
        {
          ref: "refs/heads/replit-agent",
          before: "d6a6be5a1ad171b71a1a44c36090fa0f01acc08d",
          after: "f90d9bcce907c001c992e833ee2189724a374643",
          exact_reflog_timestamp: null,
        },
        {
          ref: "refs/replit/agent-ledger",
          before: "d6a6be5a1ad171b71a1a44c36090fa0f01acc08d",
          after: "f90d9bcce907c001c992e833ee2189724a374643",
          exact_reflog_timestamp: null,
        },
        {
          ref: "refs/remotes/gitsafe-backup/main",
          before: "03b669ce3ea1b99ac4adb428a840ae1de6d9b546",
          after: "aa678911ff7fc41f630330de2a185c0bc11c4919",
          exact_reflog_timestamp: null,
        },
      ],
    },
  },
  migration: {
    migration_id:
      "20260910075939_p1_attorney_verification_eligibility_foundation",
    migration_kind: "product",
    sequence: 6,
    artifact_path:
      "supabase/migrations/20260910075939_p1_attorney_verification_eligibility_foundation.sql",
    authority_refs: [
      "PHYSICAL-SUPABASE-POSTGRES-V1.0-LOCKED",
      "DOMAIN-MODEL-V1.4-LOCKED",
      "RELATIONAL-OBJECT-SPEC-V1.0-LOCKED",
      "SCHEMA-INVENTORY-V0.7-LOCKED",
      "TECHNICAL-ARCHITECTURE-V0.2-LOCKED",
      "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED",
    ],
    work_item_refs: ["WI-P1-004-ATTORNEY-VERIFICATION-ELIGIBILITY-FOUNDATION"],
    decision_refs: ["DEC-20260910-P1-004-BOUNDED-CANDIDATE"],
    release_refs: ["REL-20260910-P1-004-STAGING-APPLICATION"],
    reviewed: true,
    reviewed_by: "Rosuno",
    reviewed_at: "2026-09-10T16:09:05Z",
    applied_environment: "staging",
    non_production_validation: true,
    drift_check:
      "Rosuno Staging persistent application passed exact six-version history, both catalog fingerprint scopes, zero business rows, exact Advisor state, and bounded closure checks.",
    rollback_plan:
      "If a later independently verified defect requires Staging rollback, remove only the sequence-6 migration through a separately reviewed non-production rollback migration; never edit migration history directly or alter P0/P1-001/P1-002/P1-003 controls.",
    depends_on: ["20260901012518_p1_authorization_scope_correction"],
  },
  decision: {
    decision_id: "DEC-20260910-P1-004-BOUNDED-CANDIDATE",
    title: "Implement the approved bounded P1-004 local candidate",
    status: "accepted",
    scope:
      "Original authorization: bounded local P1-004 implementation only. Current accepted lifecycle records later separately authorized gates.",
    decision:
      "Implement the supplied approved startup contract plus the user-approved narrow validator extension and exactly public.has_manage_attorney_verification_scope(uuid, boolean). These are implementation-level decisions; no higher authority is altered.",
    rationale:
      "The original implementation decision did not authorize PR creation, review, merge, persistent Staging application, release, or repository closure. Those later events occurred under separate explicit gates and are recorded in the closure evidence. Immutable candidate and rollback-only evidence preserve the original implementation history.",
    authority_refs: [
      "PHYSICAL-SUPABASE-POSTGRES-V1.0-LOCKED",
      "DOMAIN-MODEL-V1.4-LOCKED",
      "RELATIONAL-OBJECT-SPEC-V1.0-LOCKED",
      "SCHEMA-INVENTORY-V0.7-LOCKED",
      "TECHNICAL-ARCHITECTURE-V0.2-LOCKED",
      "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED",
    ],
    work_item_refs: ["WI-P1-004-ATTORNEY-VERIFICATION-ELIGIBILITY-FOUNDATION"],
    owner: "Rosuno P1-004 technical builder",
    reviewer: {
      identity: "Rosuno",
      status: "approved",
    },
    created_at: "2026-09-10T07:59:39Z",
    updated_at: "2026-09-10T18:27:37Z",
    supersedes: [],
    impact:
      "Records current accepted P1-004 lifecycle completion without broadening the original local implementation authorization. Later review, merge, Staging application, release, and governance closure remain separately authorized events; no production, OLD, or later-work authorization is granted.",
    evidence: [
      "governance/evidence/p1-004-attorney-verification-eligibility-foundation.json",
      "supabase/migrations/20260910075939_p1_attorney_verification_eligibility_foundation.sql",
      "governance/evidence/p1-004-governance-lifecycle-closure.json",
      "governance/releases/traceability.json",
      "governance/schema-drift/baseline.json",
    ],
    expiry: null,
  },
  work: {
    work_item_id: "WI-P1-004-ATTORNEY-VERIFICATION-ELIGIBILITY-FOUNDATION",
    title: "P1-004 local attorney, verification and eligibility candidate",
    objective:
      "Implement the user-approved nine-relation contract, exact read-only capability helper, and separate pending/validated candidate governance lifecycle.",
    in_scope: [
      "Nine approved P1-004 relations, exactly one approved read-only capability predicate, one capability seed, bounded integrity and RLS",
      "Two-file governance validator extension and P1-004 tests/evidence",
      "Rollback-only validation on mxjlvmowmodzdtdfgqpb followed by exact restoration",
    ],
    out_of_scope: [
      "Push, PR, review, merge, release, persistent Staging application",
      "Source/dev DDL, production, OLD, P1-005+, other helpers or relations",
    ],
    status: "completed",
    owner: "Rosuno P1-004 technical builder",
    reviewer: {
      identity: "Rosuno",
      status: "approved",
    },
    priority: "P1",
    authority_refs: [
      "PHYSICAL-SUPABASE-POSTGRES-V1.0-LOCKED",
      "DOMAIN-MODEL-V1.4-LOCKED",
      "RELATIONAL-OBJECT-SPEC-V1.0-LOCKED",
      "SCHEMA-INVENTORY-V0.7-LOCKED",
      "TECHNICAL-ARCHITECTURE-V0.2-LOCKED",
      "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED",
    ],
    decision_refs: ["DEC-20260910-P1-004-BOUNDED-CANDIDATE"],
    dependencies: ["WI-P1-002-AUTHORIZATION-SCOPE-CORRECTION"],
    acceptance_criteria: [
      "Exact approved canonical start and unchanged five historical migration bytes",
      "All local controls and bounded rollback-only security/integrity/history tests pass",
      "Exact independent restoration proof before any final local candidate commit",
    ],
    validation_commands: [
      "pnpm run p0:test",
      "pnpm run p0:validate",
      "pnpm run format:check",
      "pnpm run typecheck",
      "pnpm run build",
      "pnpm run dependency:check",
      "pnpm run secrets:check",
    ],
    environment: "staging",
    release_refs: ["REL-20260910-P1-004-STAGING-APPLICATION"],
    migration_refs: [
      "20260910075939_p1_attorney_verification_eligibility_foundation",
    ],
    rollback_reference:
      "governance/evidence/p1-004-attorney-verification-eligibility-foundation.json",
    created_at: "2026-09-10T07:59:39Z",
    updated_at: "2026-09-10T18:27:37Z",
  },
  release: {
    release_id: "REL-20260910-P1-004-STAGING-APPLICATION",
    commit_sha: "4dfc3b2b6e83f5a5bc9f54ef108f88306827c667",
    work_item_refs: ["WI-P1-004-ATTORNEY-VERIFICATION-ELIGIBILITY-FOUNDATION"],
    decision_refs: ["DEC-20260910-P1-004-BOUNDED-CANDIDATE"],
    migration_refs: [
      "20260910075939_p1_attorney_verification_eligibility_foundation",
    ],
    validation_evidence: [
      "governance/evidence/p1-004-governance-lifecycle-closure.json",
      "governance/evidence/p1-004-attorney-verification-eligibility-foundation.json",
      "supabase/migrations/20260910075939_p1_attorney_verification_eligibility_foundation.sql",
      "pnpm run p0:validate",
      "pnpm run p0:test",
    ],
    artifact_digest:
      "sha256:09107387d2bd699189a7cdf970c1de18f89ca5cde5074d596274d63361d59231",
    environment: "staging",
    reviewer: {
      identity: "Rosuno",
      status: "approved",
    },
    rollback_reference:
      "governance/evidence/p1-004-attorney-verification-eligibility-foundation.json",
    created_at: "2026-09-10T18:27:37Z",
  },
  protectedHashes: {
    "supabase/migrations/20260828192126_p0_restrict_rls_auto_enable_execution.sql":
      "2ba591b2767c43a32731c8b74b5ffaa07c47a41d096eee6fb3672aad9278c49d",
    "supabase/migrations/20260829000015_p1_platform_foundation.sql":
      "67dfd44b2bd7525a588e6eb59c33a0056f3a5c67eec5f45dd93e6aab37f7afc8",
    "supabase/migrations/20260829171701_p1_authorization_foundation.sql":
      "6471ac68949234e29ae1cc492eaa2f77dc15ca010998f72898284b8c9a855fec",
    "supabase/migrations/20260830023823_p1_jurisdiction_policy_launch_foundation.sql":
      "94e9b746cf303154790bc51e8160f9184b2e9765e82ec2702e03030f7a79b7ee",
    "supabase/migrations/20260901012518_p1_authorization_scope_correction.sql":
      "bf0cdabed8ffa41a65e793b9041c00dc7d2ca47eeef40c2750770e195b47d6c5",
    "supabase/migrations/20260910075939_p1_attorney_verification_eligibility_foundation.sql":
      "09107387d2bd699189a7cdf970c1de18f89ca5cde5074d596274d63361d59231",
    "governance/evidence/p1-004-attorney-verification-eligibility-foundation.json":
      "d7bce5ae1957543a8e3f6d21476b570f90bb7ceb0b39c8d7f55850a21fb428df",
    "governance/evidence/p1-004-validation-details.json":
      "9c5944113486a56321ffb42d214399df57e883504cccf5f77985c2a77130c49d",
  },
};

function p1004Exact(actual, expected, location) {
  if (expected === null || typeof expected !== "object") {
    if (actual !== expected) fail(`P1-004 ${location}: unexpected value`);
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length)
      fail(`P1-004 ${location}: array length/type mismatch`);
    expected.forEach((value, index) =>
      p1004Exact(actual[index], value, `${location}[${index}]`),
    );
    return;
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual))
    fail(`P1-004 ${location}: expected object`);
  const keys = Object.keys(expected).sort();
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(keys))
    fail(`P1-004 ${location}: field set mismatch`);
  for (const key of keys)
    p1004Exact(actual[key], expected[key], `${location}.${key}`);
}

function p1004Unique(records, field, value) {
  const found = records.filter((x) => x[field] === value);
  if (found.length !== 1)
    fail(`P1-004 ${field}: missing or duplicate ${value}`);
  return found[0];
}

export function validateP1AttorneyClosure(migration, sql, evidence) {
  p1004Exact(migration, P1004_FINAL.migration, "migration");
  p1004Exact(evidence, P1004_FINAL.evidence, "evidence");
  if (
    createHash("sha256").update(sql).digest("hex") !==
    P1004_FINAL.evidence.migration.sha256
  )
    fail("P1-004 migration SQL digest mismatch");
  for (const [relative, expected] of Object.entries(
    P1004_FINAL.protectedHashes,
  )) {
    const actual = createHash("sha256")
      .update(readFileSync(path.join(ROOT, relative)))
      .digest("hex");
    if (actual !== expected) fail(`P1-004 protected bytes: ${relative}`);
  }
  if (scanSecretLikeText(JSON.stringify(evidence), "P1-004 closure").length)
    fail("P1-004 closure contains a secret-like value");
}

export function validateP1AttorneyClosureTraceability(
  migrations,
  workItems,
  decisions,
  releases,
) {
  for (const [records, field, expected, label] of [
    [migrations.migrations, "migration_id", P1004_FINAL.migration, "migration"],
    [workItems.work_items, "work_item_id", P1004_FINAL.work, "work item"],
    [decisions.decisions, "decision_id", P1004_FINAL.decision, "decision"],
    [releases.releases, "release_id", P1004_FINAL.release, "release"],
  ]) {
    p1004Exact(p1004Unique(records, field, expected[field]), expected, label);
  }
  if (
    decisions.decisions.some(
      (x) =>
        x.decision_id === "DEC-20260910-P1-004-GOVERNANCE-LIFECYCLE-CLOSURE",
    )
  )
    fail("P1-004 duplicate closure decision remains");
}

// This predicate classifies only the explicitly authorized local candidate.
// It neither reviews a migration nor changes the persistent foundation.
export function validateP1AttorneyCandidate(migration, sql, evidence) {
  const context = "P1-004 candidate";
  requireExactFields(migration, MIGRATION_FIELDS, context);
  const match = P1_ATTORNEY_ID.exec(migration.migration_id);
  if (!match || match[1] <= "20260901012518") {
    fail(`${context} migration name/version is invalid`);
  }
  const stamp = match[1];
  requireTimestamp(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}Z`,
    `${context} version`,
  );
  if (
    migration.sequence !== 6 ||
    migration.migration_kind !== "product" ||
    migration.artifact_path !==
      `supabase/migrations/${migration.migration_id}.sql` ||
    JSON.stringify(migration.depends_on) !==
      JSON.stringify([P1_AUTHORIZATION_CORRECTION_MIGRATION_ID])
  )
    fail(`${context} sequence, kind, path, or predecessor is invalid`);
  if (
    migration.reviewed !== false ||
    migration.reviewed_by !== "pending designated human PR review" ||
    migration.reviewed_at !== null ||
    migration.applied_environment !== "none" ||
    !Array.isArray(migration.release_refs) ||
    migration.release_refs.length !== 0
  )
    fail(`${context} must remain unreviewed, unapplied, and unreleased`);
  requireNonEmptyString(sql, `${context} SQL artifact`);
  requireExactFields(
    evidence,
    [
      "version",
      "migration_id",
      "migration_sha256",
      "project_ref",
      "phase",
      "rollback_validation",
    ],
    `${context} evidence`,
  );
  if (
    evidence.version !== 1 ||
    evidence.migration_id !== migration.migration_id ||
    evidence.migration_sha256 !==
      createHash("sha256").update(sql).digest("hex") ||
    evidence.project_ref !== "mxjlvmowmodzdtdfgqpb"
  )
    fail(
      `${context} evidence does not identify the exact artifact and Staging target`,
    );
  if (migration.non_production_validation === false) {
    if (
      migration.drift_check !== P1_ATTORNEY_PENDING ||
      evidence.phase !== "rollback_only_pending" ||
      evidence.rollback_validation !== null
    ) {
      fail(
        `${context} pending state falsely claims completed rollback-only validation`,
      );
    }
    return "rollback_only_pending";
  }
  if (
    migration.non_production_validation !== true ||
    migration.drift_check !== P1_ATTORNEY_VALIDATED ||
    evidence.phase !== "rollback_only_validated"
  ) {
    fail(`${context} validation phase is inconsistent`);
  }
  const proof = evidence.rollback_validation;
  requireExactFields(
    proof,
    [
      "started_at",
      "rolled_back_at",
      "restored_at",
      "transaction_end",
      "checks",
      "before",
      "after",
    ],
    `${context} rollback proof`,
  );
  validateChronology(
    proof.started_at,
    proof.rolled_back_at,
    `${context} transaction`,
  );
  validateChronology(
    proof.rolled_back_at,
    proof.restored_at,
    `${context} restoration`,
  );
  if (proof.transaction_end !== "ROLLBACK")
    fail(`${context} lacks explicit rollback proof`);
  const categories = [
    "structure",
    "constraints",
    "rls",
    "service_privileges",
    "capability_helper",
    "corrections",
    "historical_independence",
  ];
  requireExactFields(proof.checks, categories, `${context} validation checks`);
  for (const category of categories) {
    requireArray(proof.checks[category], `${context} ${category}`, 1);
    uniqueIds(proof.checks[category], "name", `${context} ${category}`);
    for (const check of proof.checks[category]) {
      requireExactFields(check, ["name", "passed"], `${context} check`);
      if (check.passed !== true)
        fail(`${context} contains a failed validation check`);
    }
  }
  for (const state of [proof.before, proof.after]) {
    requireExactFields(
      state,
      [
        "migration_history",
        "catalog_rows",
        "public_tables",
        "public_function_count",
        "public_row_counts",
        "candidate_relations",
        "candidate_helper_present",
        "candidate_seed_count",
      ],
      `${context} restoration state`,
    );
    const catalog = canonicalizeCatalogRows(state.catalog_rows);
    if (
      JSON.stringify(state.migration_history) !==
        JSON.stringify(P1_AUTHORIZATION_CORRECTION_MIGRATION_HISTORY) ||
      catalog.sha256 !== P1_AUTHORIZATION_CORRECTION_CATALOG_SHA256 ||
      catalog.canonicalBytes.length !==
        P1_AUTHORIZATION_CORRECTION_CATALOG_BYTES ||
      catalog.snapshot.rows.length !==
        P1_AUTHORIZATION_CORRECTION_CATALOG_ROWS ||
      state.public_function_count !== 4 ||
      JSON.stringify(state.candidate_relations) !== "[]" ||
      state.candidate_helper_present !== false ||
      state.candidate_seed_count !== 0
    ) {
      fail(`${context} lacks exact five-migration baseline restoration`);
    }
    const tables = [
      "application_sessions",
      "capability_definitions",
      "capability_grants",
      "jurisdiction_regulatory_modes",
      "jurisdictions",
      "launch_authorizations",
      "launch_gate_evaluations",
      "launch_gates",
      "policy_authority_references",
      "policy_types",
      "policy_versions",
      "regulatory_modes",
      "service_areas",
      "staff_profiles",
      "users",
    ];
    if (JSON.stringify(state.public_tables) !== JSON.stringify(tables))
      fail(`${context} public table inventory differs`);
    requireExactFields(
      state.public_row_counts,
      tables,
      `${context} row counts`,
    );
    if (Object.values(state.public_row_counts).some((count) => count !== 0))
      fail(`${context} rows survive validation`);
  }
  return "rollback_only_validated";
}

function readP1AttorneyCandidate(migration) {
  if (migration.reviewed === true) {
    return validateP1AttorneyClosure(
      migration,
      readFileSync(path.join(ROOT, migration.artifact_path), "utf8"),
      readJson(P1_ATTORNEY_CLOSURE_EVIDENCE_PATH),
    );
  }
  return validateP1AttorneyCandidate(
    migration,
    readFileSync(path.join(ROOT, migration.artifact_path), "utf8"),
    readJson(P1_ATTORNEY_EVIDENCE_PATH),
  );
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
    let acceptedP1AttorneyCandidate = false;
    let acceptedP1ClientIntakeCandidate = false;
    requireExactFields(migration, MIGRATION_FIELDS, context);
    if (!["security_control", "product"].includes(migration.migration_kind)) {
      fail(`${context}.migration_kind is not allowed`);
    }
    if (migration.sequence !== index + 1) fail(`${context} is out of order`);
    requireNonEmptyString(migration.artifact_path, `${context}.artifact_path`);
    if (registeredArtifacts.has(migration.artifact_path)) {
      fail(`${context}.artifact_path is duplicated`);
    }
    registeredArtifacts.add(migration.artifact_path);
    if (migration.migration_kind === "security_control") {
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
      if (migration.migration_id === P0_MIGRATION_ID) {
        validateP0CliInventory(
          readFileSync(path.join(ROOT, P0_CLI_INVENTORY_PATH), "utf8"),
          P0_CLI_INVENTORY_PATH,
          `${context}.inventory`,
        );
        registeredArtifacts.add(P0_CLI_INVENTORY_PATH);
      }
    } else {
      const sql = readFileSync(
        path.join(ROOT, migration.artifact_path),
        "utf8",
      );
      if (migration.migration_id === "20260829000015_p1_platform_foundation") {
        if (
          migration.artifact_path !==
          "supabase/migrations/20260829000015_p1_platform_foundation.sql"
        ) {
          fail(`${context}.artifact_path is invalid for P1-001`);
        }
        validateP1PlatformMigration(sql, migration, `${context}.artifact`);
      } else if (
        migration.migration_id === "20260829171701_p1_authorization_foundation"
      ) {
        if (
          migration.artifact_path !==
          "supabase/migrations/20260829171701_p1_authorization_foundation.sql"
        ) {
          fail(`${context}.artifact_path is invalid for P1-002`);
        }
        validateP1AuthorizationMigration(sql, migration, `${context}.artifact`);
      } else if (
        migration.migration_id ===
        "20260830023823_p1_jurisdiction_policy_launch_foundation"
      ) {
        if (
          migration.artifact_path !==
          "supabase/migrations/20260830023823_p1_jurisdiction_policy_launch_foundation.sql"
        ) {
          fail(`${context}.artifact_path is invalid for P1-003`);
        }
        validateP1RegulatoryMigration(sql, migration, `${context}.artifact`);
      } else if (
        migration.migration_id === P1_AUTHORIZATION_CORRECTION_MIGRATION_ID
      ) {
        if (
          migration.artifact_path !== P1_AUTHORIZATION_CORRECTION_MIGRATION_PATH
        ) {
          fail(`${context}.artifact_path is invalid for the P1-002 correction`);
        }
        validateP1AuthorizationCorrectionMigration(
          sql,
          migration,
          `${context}.artifact`,
        );
      } else if (P1_ATTORNEY_ID.test(migration.migration_id)) {
        readP1AttorneyCandidate(migration);
        acceptedP1AttorneyCandidate = true;
      } else if (P1_CLIENT_INTAKE_ID.test(migration.migration_id)) {
        const candidateSql = readFileSync(
          path.join(ROOT, migration.artifact_path),
          "utf8",
        );
        validateP1ClientIntakeCandidate(migration, candidateSql);
        acceptedP1ClientIntakeCandidate = true;
      } else {
        fail(`${context}.artifact_path is outside the authorized P1 slice`);
      }
    }
    requireNonEmptyString(migration.rollback_plan, `${context}.rollback_plan`);
    if (migration.migration_kind === "security_control") {
      if (migration.reviewed !== true) fail(`${context} is not reviewed`);
      for (const field of ["reviewed_by", "reviewed_at"]) {
        requireNonEmptyString(migration[field], `${context}.${field}`);
      }
    } else if (migration.reviewed === false) {
      if (
        migration.reviewed_by !== "pending designated human PR review" ||
        migration.reviewed_at !== null ||
        migration.applied_environment !== "none" ||
        migration.release_refs.length !== 0
      ) {
        fail(
          `${context} proposed product migration gate is invalid; a reviewed or persistently applied migration may not remain pending`,
        );
      }
    } else if (migration.reviewed === true) {
      requireNonEmptyString(migration.reviewed_by, `${context}.reviewed_by`);
      requireTimestamp(migration.reviewed_at, `${context}.reviewed_at`);
    } else {
      fail(`${context}.reviewed must be boolean`);
    }
    if (
      ![
        "development",
        "staging",
        "none",
        UNCLASSIFIED_EXTERNAL_PROJECT,
      ].includes(migration.applied_environment)
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
      migration.applied_environment !== "none" &&
      migration.non_production_validation !== true
    ) {
      fail(`${context} must be validated in a non-production environment`);
    }
    if (
      migration.applied_environment === "none" &&
      !acceptedP1AttorneyCandidate &&
      !acceptedP1ClientIntakeCandidate &&
      (migration.migration_kind !== "product" ||
        migration.non_production_validation !== true)
    ) {
      fail(`${context} unapplied migration lacks rollback-only validation`);
    }
    const acceptedP1AuthorizationToolingException =
      migration.migration_id === "20260829171701_p1_authorization_foundation" &&
      migration.drift_check ===
        "Supabase CLI shadow comparison unavailable after PostgreSQL readiness because OCI setns failed before pg_isready; compensating deterministic direct-catalog validation passed and no clean CLI drift result is claimed.";
    const acceptedP1RegulatoryToolingException =
      migration.migration_id ===
        "20260830023823_p1_jurisdiction_policy_launch_foundation" &&
      migration.drift_check ===
        "Supabase CLI shadow comparison unavailable because Replit OCI setns failed during pg_isready before P1-003 SQL or schema comparison; compensating corrected direct-catalog validation passed and no clean CLI drift result is claimed.";
    const acceptedP1AuthorizationCorrectionValidation =
      migration.migration_id === P1_AUTHORIZATION_CORRECTION_MIGRATION_ID &&
      migration.applied_environment === "staging" &&
      migration.non_production_validation === true &&
      migration.drift_check === P1_AUTHORIZATION_CORRECTION_DRIFT_CHECK;
    if (
      migration.drift_check !== "clean" &&
      !acceptedP1AuthorizationToolingException &&
      !acceptedP1RegulatoryToolingException &&
      !acceptedP1AuthorizationCorrectionValidation &&
      !acceptedP1AttorneyCandidate &&
      !acceptedP1ClientIntakeCandidate
    ) {
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
      migration.reviewed ? 1 : 0,
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

export function validateDriftReport(report, migrationRegister = null) {
  requireExactFields(
    report,
    [
      "version",
      "product_schema_present",
      "baseline_id",
      "baseline_digest",
      "checked_environment",
      "checked_at",
      "project",
      "migration_inventory",
      "accepted_evidence",
      "catalog_fingerprint",
      "evidence",
      "drift_status",
      "drift_items",
    ],
    "schema drift report",
  );

  if (report.drift_status !== "clean")
    fail("schema drift status must be clean");

  if (!Array.isArray(report.drift_items) || report.drift_items.length !== 0)
    fail("schema drift items must be empty");

  if (report.product_schema_present !== true)
    fail(
      "product_schema_present must be true when reviewed product migrations exist",
    );

  const closedP1004 =
    report.baseline_id === "rosuno-staging-p1-004-20260910-v1";
  const closedP1005 =
    report.baseline_id === "rosuno-staging-p1-005-20260912-v1";

  const expectedCheckedAt = closedP1005
    ? P1_CLIENT_INTAKE_OBSERVED_AT
    : closedP1004
      ? "2026-09-10T22:48:00.544397Z"
      : P1_AUTHORIZATION_CORRECTION_VALIDATED_AT;

  if (
    report.version !== 1 ||
    (!closedP1004 &&
      !closedP1005 &&
      report.baseline_id !== FOUNDATION_BASELINE_ID) ||
    report.checked_environment !== "staging" ||
    report.checked_at !== expectedCheckedAt ||
    report.project?.name !== "Rosuno Staging" ||
    report.project?.project_ref !== "mxjlvmowmodzdtdfgqpb"
  ) {
    fail("schema drift Staging baseline identity is invalid");
  }

  const p1004Migration = {
    sequence: 6,
    migration_id:
      "20260910075939_p1_attorney_verification_eligibility_foundation",
    artifact_path:
      "supabase/migrations/20260910075939_p1_attorney_verification_eligibility_foundation.sql",
    sha256: "09107387d2bd699189a7cdf970c1de18f89ca5cde5074d596274d63361d59231",
  };

  const p1005Migration = {
    sequence: 7,
    migration_id: P1_CLIENT_INTAKE_MIGRATION_ID,
    artifact_path: P1_CLIENT_INTAKE_MIGRATION_PATH,
    sha256: P1_CLIENT_INTAKE_MIGRATION_SHA256,
  };

  const expectedInventory = closedP1005
    ? [...FOUNDATION_BASELINE_MIGRATIONS, p1004Migration, p1005Migration]
    : closedP1004
      ? [...FOUNDATION_BASELINE_MIGRATIONS, p1004Migration]
      : FOUNDATION_BASELINE_MIGRATIONS;

  if (
    JSON.stringify(report.migration_inventory) !==
    JSON.stringify(expectedInventory)
  ) {
    fail(
      "schema drift migration inventory contradicts the reviewed foundation",
    );
  }

  const register =
    migrationRegister ??
    readJson("governance/migrations/reviewed-migrations.json");

  if (
    register.product_migrations_present !== true ||
    ![5, 6, 7].includes(register.migrations?.length) ||
    register.migrations
      .slice(0, 5)
      .some(
        (migration, index) =>
          migration.sequence !==
            FOUNDATION_BASELINE_MIGRATIONS[index].sequence ||
          migration.migration_id !==
            FOUNDATION_BASELINE_MIGRATIONS[index].migration_id ||
          migration.reviewed !== true,
      )
  ) {
    fail("schema drift migration inventory contradicts the reviewed register");
  }

  if (closedP1004 && ![6, 7].includes(register.migrations.length))
    fail(
      "P1-004 baseline requires six accepted migrations plus at most one bounded overlay",
    );

  if (closedP1005 && register.migrations.length !== 7)
    fail("P1-005 baseline requires exactly seven accepted migrations");

  if (!closedP1004 && !closedP1005 && register.migrations.length === 7) {
    fail("P1-005 overlay requires the accepted P1-004 baseline");
  }

  if (register.migrations.length === 6) {
    if (closedP1004) {
      validateMigrationRegister(register, {}, repositoryFiles());
    } else {
      readP1AttorneyCandidate(register.migrations[5]);
    }
  }

  if (register.migrations.length === 7) {
    if (!closedP1004 && !closedP1005)
      fail("seven migrations require an accepted P1-004 or P1-005 baseline");

    validateMigrationRegister(register, {}, repositoryFiles());
  }

  for (const artifact of expectedInventory) {
    const digest = createHash("sha256")
      .update(readFileSync(path.join(ROOT, artifact.artifact_path)))
      .digest("hex");

    if (digest !== artifact.sha256)
      fail(
        `schema drift migration digest is invalid for ${artifact.migration_id}`,
      );
  }

  const p1004Evidence = {
    path: P1_ATTORNEY_CLOSURE_EVIDENCE_PATH,
    sha256: createHash("sha256")
      .update(readFileSync(path.join(ROOT, P1_ATTORNEY_CLOSURE_EVIDENCE_PATH)))
      .digest("hex"),
  };

  const p1005Evidence = {
    path: P1_CLIENT_INTAKE_CLOSURE_EVIDENCE_PATH,
    sha256: createHash("sha256")
      .update(
        readFileSync(path.join(ROOT, P1_CLIENT_INTAKE_CLOSURE_EVIDENCE_PATH)),
      )
      .digest("hex"),
  };

  const expectedEvidence = closedP1005
    ? [...FOUNDATION_BASELINE_EVIDENCE, p1004Evidence, p1005Evidence]
    : closedP1004
      ? [...FOUNDATION_BASELINE_EVIDENCE, p1004Evidence]
      : FOUNDATION_BASELINE_EVIDENCE;

  if (
    JSON.stringify(report.accepted_evidence) !==
      JSON.stringify(expectedEvidence) ||
    report.evidence?.join("|") !==
      expectedEvidence.map((item) => item.path).join("|")
  ) {
    fail("schema drift accepted evidence inventory is invalid");
  }

  for (const artifact of expectedEvidence) {
    const digest = createHash("sha256")
      .update(readFileSync(path.join(ROOT, artifact.path)))
      .digest("hex");

    if (digest !== artifact.sha256)
      fail(`schema drift evidence digest is invalid for ${artifact.path}`);
  }

  const expectedCatalog = closedP1005
    ? {
        sha256:
          "ae06fdc7035eee732689487dda79caeb48754502e988aba6ed7c6781780ddf6c",
        bytes: 231062,
        rows: 744,
      }
    : closedP1004
      ? {
          sha256:
            "f79a78d39870ed25ac94ac58d646ea997c9bacf15199d0c1d1abe6dbfe634508",
          bytes: 90175,
          rows: 279,
        }
      : {
          sha256: P1_AUTHORIZATION_CORRECTION_CATALOG_SHA256,
          bytes: P1_AUTHORIZATION_CORRECTION_CATALOG_BYTES,
          rows: P1_AUTHORIZATION_CORRECTION_CATALOG_ROWS,
        };

  if (
    report.catalog_fingerprint?.format !== "rosuno-p1-catalog-v1" ||
    report.catalog_fingerprint?.sha256 !== expectedCatalog.sha256 ||
    report.catalog_fingerprint?.canonical_byte_length !==
      expectedCatalog.bytes ||
    report.catalog_fingerprint?.row_count !== expectedCatalog.rows
  ) {
    fail("schema drift corrected catalog fingerprint is invalid");
  }

  const manifest = {
    baseline_id: report.baseline_id,
    checked_environment: report.checked_environment,
    project: report.project,
    migration_inventory: report.migration_inventory,
    accepted_evidence: report.accepted_evidence,
    catalog_fingerprint: report.catalog_fingerprint,
  };

  const digest = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");

  if (
    report.baseline_digest !== `sha256:${digest}` ||
    (!closedP1004 && !closedP1005 && digest !== FOUNDATION_BASELINE_DIGEST)
  ) {
    fail("schema drift baseline identity/digest is invalid");
  }
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
    "rosuno:preflight": "node tools/p0/fast-control.mjs preflight",
    "rosuno:check": "node tools/p0/fast-control.mjs check",
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
  const allowedP1Files = new Set([
    "supabase/migrations/20260828192126_p0_restrict_rls_auto_enable_execution.sql",
    "supabase/migrations/20260829000015_p1_platform_foundation.sql",
    "supabase/migrations/20260829171701_p1_authorization_foundation.sql",
    "supabase/migrations/20260830023823_p1_jurisdiction_policy_launch_foundation.sql",
    "supabase/migrations/20260901012518_p1_authorization_scope_correction.sql",
  ]);
  const forbidden = files.filter(
    (file) =>
      !allowedRootFiles.has(file) &&
      !allowedGithubFiles.has(file) &&
      !allowedP1Files.has(file) &&
      !/^supabase\/migrations\/[0-9]{14}_p1_attorney_verification_eligibility_foundation\.sql$/.test(
        file,
      ) &&
      !/^supabase\/migrations\/[0-9]{14}_p1_client_intake_ai_foundation\.sql$/.test(
        file,
      ) &&
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
  const correctionMigrationSql = readFileSync(
    path.join(ROOT, P1_AUTHORIZATION_CORRECTION_MIGRATION_PATH),
    "utf8",
  );
  const correctionFingerprintText = readFileSync(
    path.join(ROOT, P1_AUTHORIZATION_CORRECTION_FINGERPRINT_PATH),
    "utf8",
  );
  const correctionFingerprint = JSON.parse(correctionFingerprintText);

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
  const p0Migration = migrations.migrations.find(
    (migration) => migration.migration_id === P0_MIGRATION_ID,
  );
  validateP0InventoryReconciliation(
    readJson(P0_INVENTORY_RECONCILIATION_PATH),
    p0Migration,
    readFileSync(path.join(ROOT, P0_CLI_INVENTORY_PATH), "utf8"),
  );
  validateRestoreEvidence(
    readJson("governance/evidence/p0-restore-validation.json"),
  );
  validateP1PlatformEvidence(
    readJson("governance/evidence/p1-001-platform-foundation.json"),
    readFileSync(
      path.join(
        ROOT,
        "supabase/migrations/20260829000015_p1_platform_foundation.sql",
      ),
      "utf8",
    ),
  );
  validateP1AuthorizationEvidence(
    readJson("governance/evidence/p1-002-authorization-foundation.json"),
    readFileSync(
      path.join(
        ROOT,
        "supabase/migrations/20260829171701_p1_authorization_foundation.sql",
      ),
      "utf8",
    ),
    readJson("governance/evidence/p1-002-catalog-fingerprint.json"),
  );
  validateP1AuthorizationLifecycleEvidence(
    readJson(P1_AUTHORIZATION_LIFECYCLE_EVIDENCE_PATH),
  );
  validateP1RegulatoryEvidence(
    readJson(
      "governance/evidence/p1-003-jurisdiction-policy-launch-foundation.json",
    ),
    readFileSync(
      path.join(
        ROOT,
        "supabase/migrations/20260830023823_p1_jurisdiction_policy_launch_foundation.sql",
      ),
      "utf8",
    ),
  );
  validateP1AuthorizationCorrectionEvidence(
    readJson(P1_AUTHORIZATION_CORRECTION_EVIDENCE_PATH),
    correctionMigrationSql,
    correctionFingerprint,
    correctionFingerprintText,
  );
  validateDriftReport(
    readJson("governance/schema-drift/baseline.json"),
    migrations,
  );
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
  validateP1ApplicationTraceability(migrations, workItems, decisions, releases);
  validateP1AuthorizationLifecycleTraceability(
    migrations,
    workItems,
    decisions,
    releases,
  );
  validateP1AttorneyClosureTraceability(
    migrations,
    workItems,
    decisions,
    releases,
  );
  validateP1ClientIntakeTraceability(
    migrations,
    workItems,
    decisions,
    releases,
  );
  validateP1RegulatoryTraceability(migrations, workItems, decisions, releases);
  validateP1AuthorizationCorrectionTraceability(
    migrations,
    workItems,
    decisions,
    releases,
  );
  validateTraceabilityConsistency(migrations, releases);

  return {
    status: "passed",
    checks: [
      "controlled package, authorized paths, and empty application workspace",
      "locked authority references",
      "relational decision and work-item registers",
      "environment isolation",
      "migration inventory and clean drift baseline",
      "sanitized non-production restore evidence",
      "reviewed and applied P1 Staging migration evidence",
      "P1-002 reviewed historical Staging lifecycle and accepted governance correction",
      "P1-003 accepted persistent Staging application evidence",
      "P1-002 correction accepted persistent Staging application with preserved rollback evidence",
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

/* P1-005 bounded lifecycle controls.
 * Historical pending-candidate validation remains supported, while the
 * reviewed branch requires the exact protected-review, Staging application,
 * closure evidence, release traceability, and accepted seven-migration state.
 */
const P1_CLIENT_INTAKE_ID = /^([0-9]{14})_p1_client_intake_ai_foundation$/;
const P1_CLIENT_INTAKE_MIGRATION_ID =
  "20260911062917_p1_client_intake_ai_foundation";
const P1_CLIENT_INTAKE_MIGRATION_PATH =
  "supabase/migrations/20260911062917_p1_client_intake_ai_foundation.sql";
const P1_CLIENT_INTAKE_MIGRATION_SHA256 =
  "13be2baeaa808d38a5e209071c94a9c9565fbd1280aeae0395abc50502e2b375";
const P1_CLIENT_INTAKE_MIGRATION_BYTES = 8590;
const P1_CLIENT_INTAKE_DECISION_ID = "DEC-20260911-P1-005-BOUNDED-CANDIDATE";
const P1_CLIENT_INTAKE_WORK_ITEM_ID = "WI-P1-005-CLIENT-INTAKE-AI-FOUNDATION";
const P1_CLIENT_INTAKE_DEPENDENCY_ID =
  "20260910075939_p1_attorney_verification_eligibility_foundation";
const P1_CLIENT_INTAKE_DEPENDENCY_WORK_ITEM =
  "WI-P1-004-ATTORNEY-VERIFICATION-ELIGIBILITY-FOUNDATION";

const P1_CLIENT_INTAKE_RELEASE_ID = "REL-20260912-P1-005-STAGING-APPLICATION";
const P1_CLIENT_INTAKE_CLOSURE_EVIDENCE_PATH =
  "governance/evidence/p1-005-governance-lifecycle-closure.json";
const P1_CLIENT_INTAKE_REVIEWED_AT = "2026-09-12T06:15:51Z";
const P1_CLIENT_INTAKE_OBSERVED_AT = "2026-09-12T21:11:10.801292Z";
const P1_CLIENT_INTAKE_LIFECYCLE_AT = "2026-09-12T22:31:52Z";

const P1_CLIENT_INTAKE_PENDING_DRIFT =
  "Not yet executed. This is an unreviewed, unapplied local candidate; no database validation or persistent application has occurred.";
const P1_CLIENT_INTAKE_PENDING_ROLLBACK =
  "A separately authorized rollback-only Rosuno Staging validation must execute the candidate and fixtures in one transaction ending explicitly in ROLLBACK, then independently prove exact restoration of the accepted six-migration baseline before any candidate commit is authorized.";

const P1_CLIENT_INTAKE_CLOSED_DRIFT =
  "Rosuno Staging rollback-only validation passed exact restoration of the accepted six-migration baseline; persistent application then passed exact seven-version history, 28/28 RLS, zero P1-005 business rows, exact post-application catalog fingerprints, and zero unapproved security-advisor findings.";
const P1_CLIENT_INTAKE_CLOSED_ROLLBACK =
  "If a later independently verified defect requires Staging rollback, remove only the sequence-7 P1-005 change through a separately reviewed forward-only non-production rollback migration; never edit historical migration bytes or migration history directly, and preserve all earlier accepted controls.";

const P1_CLIENT_INTAKE_DECISION_SCOPE =
  "Original authorization: bounded local P1-005 implementation only. Current accepted lifecycle records later separately authorized protected review, merge, rollback-only Staging validation, persistent Staging application, and governance closure.";
const P1_CLIENT_INTAKE_DECISION_RATIONALE =
  "The original implementation decision did not authorize protected review, merge, database validation, persistent Staging application, release, or repository closure. Those later events occurred under separate explicit gates and are retained in the closure evidence. Historical migration bytes and the original bounded implementation remain unchanged.";
const P1_CLIENT_INTAKE_DECISION_IMPACT =
  "Records current accepted P1-005 lifecycle completion without broadening the original implementation authorization. No production, source/development database, OLD project-specific activity, Fast-Control bootstrap, P1-006, or later-work authorization is granted.";

const P1_CLIENT_INTAKE_AUTHORITY_REFS = [
  "PHYSICAL-SUPABASE-POSTGRES-V1.0-LOCKED",
  "DOMAIN-MODEL-V1.4-LOCKED",
  "RELATIONAL-OBJECT-SPEC-V1.0-LOCKED",
  "SCHEMA-INVENTORY-V0.7-LOCKED",
  "TECHNICAL-ARCHITECTURE-V0.2-LOCKED",
  "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED",
];

const P1_CLIENT_INTAKE_DECISION_EVIDENCE = [
  P1_CLIENT_INTAKE_MIGRATION_PATH,
  "tools/p0/p1-005-rollback.mjs",
  P1_CLIENT_INTAKE_CLOSURE_EVIDENCE_PATH,
  "governance/releases/traceability.json",
  "governance/schema-drift/baseline.json",
];

const P1_CLIENT_INTAKE_EXPECTED_RELEASE = {
  release_id: P1_CLIENT_INTAKE_RELEASE_ID,
  commit_sha: "f24890559fcf36521ca10a143d6b648f139fe540",
  work_item_refs: [P1_CLIENT_INTAKE_WORK_ITEM_ID],
  decision_refs: [P1_CLIENT_INTAKE_DECISION_ID],
  migration_refs: [P1_CLIENT_INTAKE_MIGRATION_ID],
  validation_evidence: [
    P1_CLIENT_INTAKE_CLOSURE_EVIDENCE_PATH,
    P1_CLIENT_INTAKE_MIGRATION_PATH,
    "tools/p0/p1-005-rollback.mjs",
    "pnpm run p0:validate",
    "pnpm run p0:test",
  ],
  artifact_digest:
    "sha256:13be2baeaa808d38a5e209071c94a9c9565fbd1280aeae0395abc50502e2b375",
  environment: "staging",
  reviewer: {
    identity: "Rosuno",
    status: "approved",
  },
  rollback_reference: "tools/p0/p1-005-rollback.mjs",
  created_at: P1_CLIENT_INTAKE_LIFECYCLE_AT,
};

function p1005Exact(actual, expected, location) {
  if (expected === null || typeof expected !== "object") {
    if (actual !== expected) fail(`P1-005 ${location}: unexpected value`);
    return;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length)
      fail(`P1-005 ${location}: array length/type mismatch`);

    expected.forEach((value, index) =>
      p1005Exact(actual[index], value, `${location}[${index}]`),
    );
    return;
  }

  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    fail(`P1-005 ${location}: expected object`);
  }

  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();

  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys))
    fail(`P1-005 ${location}: field set mismatch`);

  for (const key of expectedKeys)
    p1005Exact(actual[key], expected[key], `${location}.${key}`);
}

function p1005ExactlyOne(records, field, value, label) {
  const found = records.filter((record) => record[field] === value);

  if (found.length !== 1)
    fail(`P1-005 ${label}: missing or duplicate ${value}`);

  return found[0];
}

function validateP1ClientIntakeIdentity(migration, sql) {
  const context = "P1-005 migration";

  requireExactFields(migration, MIGRATION_FIELDS, context);

  if (
    !P1_CLIENT_INTAKE_ID.test(migration.migration_id) ||
    migration.migration_id !== P1_CLIENT_INTAKE_MIGRATION_ID
  ) {
    fail("P1-005 migration id is invalid");
  }

  if (
    migration.sequence !== 7 ||
    migration.migration_kind !== "product" ||
    migration.artifact_path !== P1_CLIENT_INTAKE_MIGRATION_PATH
  ) {
    fail("P1-005 migration sequence, kind, or artifact path mismatch");
  }

  requireStringArrayExact(
    migration.authority_refs,
    P1_CLIENT_INTAKE_AUTHORITY_REFS,
    "P1-005 authority_refs",
  );

  requireStringArrayExact(
    migration.work_item_refs,
    [P1_CLIENT_INTAKE_WORK_ITEM_ID],
    "P1-005 work_item_refs",
  );

  requireStringArrayExact(
    migration.decision_refs,
    [P1_CLIENT_INTAKE_DECISION_ID],
    "P1-005 decision_refs",
  );

  requireStringArrayExact(
    migration.depends_on,
    [P1_CLIENT_INTAKE_DEPENDENCY_ID],
    "P1-005 depends_on",
  );

  if (Buffer.byteLength(sql, "utf8") !== P1_CLIENT_INTAKE_MIGRATION_BYTES) {
    fail("P1-005 migration byte length mismatch");
  }

  const digest = createHash("sha256").update(sql).digest("hex");

  if (digest !== P1_CLIENT_INTAKE_MIGRATION_SHA256)
    fail("P1-005 migration SHA-256 mismatch");

  const createdTables = [...sql.matchAll(/create table public\.(\w+)/gi)].map(
    (match) => match[1],
  );

  if (
    JSON.stringify(createdTables) !==
    JSON.stringify([
      "client_profiles",
      "intakes",
      "ai_suggestions",
      "jurisdiction_assessments",
    ])
  ) {
    fail("P1-005 migration table scope mismatch");
  }

  if (/create\s+(?:or replace\s+)?function/i.test(sql))
    fail("P1-005 must not create a function");

  if (/insert into public\./i.test(sql))
    fail("P1-005 must not seed public data");
}

export function validateP1ClientIntakeClosure(migration, sql, evidence) {
  validateP1ClientIntakeIdentity(migration, sql);

  requireStringArrayExact(
    migration.release_refs,
    [P1_CLIENT_INTAKE_RELEASE_ID],
    "P1-005 release_refs",
  );

  if (
    migration.reviewed !== true ||
    migration.reviewed_by !== "Rosuno" ||
    migration.reviewed_at !== P1_CLIENT_INTAKE_REVIEWED_AT ||
    migration.applied_environment !== "staging" ||
    migration.non_production_validation !== true ||
    migration.drift_check !== P1_CLIENT_INTAKE_CLOSED_DRIFT ||
    migration.rollback_plan !== P1_CLIENT_INTAKE_CLOSED_ROLLBACK
  ) {
    fail("P1-005 closed migration lifecycle is invalid");
  }

  requireExactFields(
    evidence,
    [
      "version",
      "evidence_id",
      "work_item_id",
      "lifecycle",
      "lifecycle_state",
      "repository",
      "migration",
      "gate5",
      "gate6",
      "fingerprints",
      "security_advisor",
      "release",
      "boundaries",
      "integrity",
    ],
    "P1-005 closure evidence",
  );

  if (
    evidence.version !== 1 ||
    evidence.evidence_id !== "P1-005-GOVERNANCE-LIFECYCLE-CLOSURE-20260912" ||
    evidence.work_item_id !== P1_CLIENT_INTAKE_WORK_ITEM_ID ||
    evidence.lifecycle !==
      "ACCEPTED — COMPLETED — REVIEWED — STAGING — RELEASED — CLOSED"
  ) {
    fail("P1-005 closure evidence identity is invalid");
  }

  p1005Exact(
    evidence.lifecycle_state,
    {
      repository_closure: true,
      staging_application: true,
      postapplication_readonly_verification: true,
    },
    "closure lifecycle_state",
  );

  p1005Exact(
    evidence.repository,
    {
      canonical_main: "f24890559fcf36521ca10a143d6b648f139fe540",
      canonical_tree: "66e4dad568950e4029027d2f6fafefb9a8937900",
      protected_main: true,
      implementation: {
        pull_request: 16,
        title:
          "P1-005: Client / Intake / Jurisdiction Assessment / AI foundation",
        base: "ba7ac95c7667200472badb768b4062bbc3d63a66",
        head: "66f83120d3febfa504f3c2cf935caafa021a8cbb",
        merge_commit: "1d0131671aefa11d88ada4c770d59f45a3814fd9",
        review_id: "5185576354",
        approved_at: "2026-09-12T06:15:51Z",
        merged_at: "2026-09-12T06:24:24Z",
        workflow_run_id: 34649537302,
        workflow_conclusion: "success",
      },
      corrections: [
        {
          pull_request: 17,
          title: "P1-005: fix rollback generator import guard",
          base: "1d0131671aefa11d88ada4c770d59f45a3814fd9",
          head: "84a633b4a2c13119df74be307fffb50494f92a16",
          merge_commit: "b8b0aadb6e093c453f07cba391842f72e3fe5c89",
          review_id: "5187093171",
          approved_at: "2026-09-12T16:17:58Z",
          merged_at: "2026-09-12T16:35:56Z",
          workflow_run_id: 34703728948,
          workflow_conclusion: "success",
        },
        {
          pull_request: 18,
          title: "P1-005: fix rollback tool test import side effects",
          base: "b8b0aadb6e093c453f07cba391842f72e3fe5c89",
          head: "9b625c603b0b5e97273af616ae0714cf0055781e",
          merge_commit: "f24890559fcf36521ca10a143d6b648f139fe540",
          review_id: "5187387530",
          approved_at: "2026-09-12T17:43:11Z",
          merged_at: "2026-09-12T17:47:23Z",
          workflow_run_id: 34708429568,
          workflow_conclusion: "success",
        },
      ],
    },
    "closure repository",
  );

  p1005Exact(
    evidence.migration,
    {
      id: P1_CLIENT_INTAKE_MIGRATION_ID,
      sha256: P1_CLIENT_INTAKE_MIGRATION_SHA256,
      byte_length: P1_CLIENT_INTAKE_MIGRATION_BYTES,
      sequence: 7,
      history_versions: 7,
      history: [
        "20260828192126_p0_restrict_rls_auto_enable_execution",
        "20260829000015_p1_platform_foundation",
        "20260829171701_p1_authorization_foundation",
        "20260830023823_p1_jurisdiction_policy_launch_foundation",
        "20260901012518_p1_authorization_scope_correction",
        "20260910075939_p1_attorney_verification_eligibility_foundation",
        P1_CLIENT_INTAKE_MIGRATION_ID,
      ],
    },
    "closure migration",
  );

  p1005Exact(
    evidence.gate5,
    {
      result: "PASS",
      rollback_checks: 93,
      accepted_baseline_catalog: {
        sha256:
          "ba0d1128e01244d472edb8c2a38823024cf56a0134492a5d1f6f6d687593144a",
        canonical_byte_length: 200217,
        row_count: 642,
      },
      pre_post_state: "EXACT_MATCH",
      pre_post_catalog: "EXACT_MATCH",
      persistent_migration_history_change: "NONE",
      persistent_p1_005_ddl_dml: "NONE",
    },
    "closure gate5",
  );

  p1005Exact(
    evidence.gate6,
    {
      result: "PASS",
      project_ref: "mxjlvmowmodzdtdfgqpb",
      supabase_cli: "2.116.0",
      application_exit: 0,
      migration_history_count: 7,
      public_tables: 28,
      public_rls: 28,
      p1_005_rows: {
        client_profiles: 0,
        intakes: 0,
        jurisdiction_assessments: 0,
        ai_suggestions: 0,
      },
      capability_codes: ["manage_attorney_verification"],
    },
    "closure gate6",
  );

  p1005Exact(
    evidence.fingerprints,
    {
      snapshot_at: P1_CLIENT_INTAKE_OBSERVED_AT,
      transaction_read_only: true,
      p1_005_scope: {
        sha256:
          "d0dba48dd6a993af75ac24617708a43d64cce18229c4daf1773e70cf2499c34f",
        canonical_byte_length: 32663,
        row_count: 108,
      },
      final_28_table: {
        sha256:
          "ae06fdc7035eee732689487dda79caeb48754502e988aba6ed7c6781780ddf6c",
        canonical_byte_length: 231062,
        row_count: 744,
      },
    },
    "closure fingerprints",
  );

  p1005Exact(
    evidence.security_advisor,
    {
      observed_at: "2026-09-12T21:13:03.413Z",
      info_count: 13,
      warn_count: 1,
      unapproved_count: 0,
      info_targets: [
        "public.application_sessions",
        "public.capability_definitions",
        "public.capability_grants",
        "public.jurisdiction_regulatory_modes",
        "public.jurisdictions",
        "public.launch_authorizations",
        "public.launch_gate_evaluations",
        "public.launch_gates",
        "public.policy_authority_references",
        "public.policy_types",
        "public.policy_versions",
        "public.regulatory_modes",
        "public.service_areas",
      ],
      warning: {
        code: "authenticated_security_definer_function_executable",
        schema: "public",
        function: "has_manage_attorney_verification_scope",
        arguments: "required_jurisdiction uuid, allow_any_jurisdiction boolean",
        language: "sql",
        security_definer: true,
      },
    },
    "closure security advisor",
  );

  p1005Exact(
    evidence.release,
    {
      id: P1_CLIENT_INTAKE_RELEASE_ID,
      commit_sha: "f24890559fcf36521ca10a143d6b648f139fe540",
      environment: "staging",
      project_ref: "mxjlvmowmodzdtdfgqpb",
      migration_id: P1_CLIENT_INTAKE_MIGRATION_ID,
      migration_digest:
        "sha256:13be2baeaa808d38a5e209071c94a9c9565fbd1280aeae0395abc50502e2b375",
      evidence_link: P1_CLIENT_INTAKE_CLOSURE_EVIDENCE_PATH,
      supabase_cli: "2.116.0",
      application_exit: 0,
      created_at: P1_CLIENT_INTAKE_LIFECYCLE_AT,
      created_at_semantics: "traceability record creation",
    },
    "closure release",
  );

  p1005Exact(
    evidence.boundaries,
    {
      production_untouched: true,
      source_development_untouched: true,
      old_project_specific_query_or_mutation: false,
      old_used_as_canonical_state: false,
      fast_control_started: false,
      p1_006_started: false,
    },
    "closure boundaries",
  );

  p1005Exact(
    evidence.integrity,
    {
      historical_migrations_unchanged: true,
      p1_005_migration_sha256: P1_CLIENT_INTAKE_MIGRATION_SHA256,
      p1_005_migration_bytes: P1_CLIENT_INTAKE_MIGRATION_BYTES,
      no_fake_business_data: true,
      no_new_capability_seed: true,
      no_new_security_definer_helper: true,
    },
    "closure integrity",
  );

  if (scanSecretLikeText(JSON.stringify(evidence), "P1-005 closure").length) {
    fail("P1-005 closure contains a secret-like value");
  }

  return true;
}

export function validateP1ClientIntakeCandidate(migration, sql) {
  validateP1ClientIntakeIdentity(migration, sql);

  if (migration.reviewed === true) {
    validateP1ClientIntakeClosure(
      migration,
      sql,
      readJson(P1_CLIENT_INTAKE_CLOSURE_EVIDENCE_PATH),
    );
    return "closed";
  }

  requireStringArrayExact(migration.release_refs, [], "P1-005 release_refs");

  if (
    migration.reviewed !== false ||
    migration.reviewed_by !== "pending designated human PR review" ||
    migration.reviewed_at !== null ||
    migration.applied_environment !== "none" ||
    migration.non_production_validation !== false ||
    migration.drift_check !== P1_CLIENT_INTAKE_PENDING_DRIFT ||
    migration.rollback_plan !== P1_CLIENT_INTAKE_PENDING_ROLLBACK
  ) {
    fail("P1-005 pending migration lifecycle is invalid");
  }

  return "pending";
}

export function validateP1ClientIntakeTraceability(
  migrations,
  workItems,
  decisions,
  releases,
) {
  const migrationRecords = migrations.migrations;
  const workItemRecords = workItems.work_items;
  const decisionRecords = decisions.decisions;
  const releaseRecords = releases.releases;

  if (
    !Array.isArray(migrationRecords) ||
    !Array.isArray(workItemRecords) ||
    !Array.isArray(decisionRecords) ||
    !Array.isArray(releaseRecords)
  ) {
    fail("P1-005 traceability register is malformed");
  }

  const migration = p1005ExactlyOne(
    migrationRecords,
    "migration_id",
    P1_CLIENT_INTAKE_MIGRATION_ID,
    "migration",
  );

  const migrationSql = readFileSync(
    path.join(ROOT, migration.artifact_path),
    "utf8",
  );

  const state = validateP1ClientIntakeCandidate(migration, migrationSql);

  const decision = p1005ExactlyOne(
    decisionRecords,
    "decision_id",
    P1_CLIENT_INTAKE_DECISION_ID,
    "decision",
  );

  const workItem = p1005ExactlyOne(
    workItemRecords,
    "work_item_id",
    P1_CLIENT_INTAKE_WORK_ITEM_ID,
    "work item",
  );

  requireExactFields(decision, DECISION_FIELDS, "P1-005 decision");
  requireExactFields(workItem, WORK_ITEM_FIELDS, "P1-005 work item");

  if (state === "pending") {
    if (
      decision.status !== "proposed" ||
      decision.owner !== "Rosuno P1-005 technical builder"
    ) {
      fail("P1-005 pending decision mismatch");
    }

    p1005Exact(
      decision.reviewer,
      {
        identity: "pending designated human PR review",
        status: "pending",
      },
      "pending decision reviewer",
    );

    if (
      workItem.status !== "in_progress" ||
      workItem.environment !== "none" ||
      workItem.owner !== "Rosuno P1-005 technical builder"
    ) {
      fail("P1-005 pending work-item mismatch");
    }

    p1005Exact(
      workItem.reviewer,
      {
        identity: "pending designated human PR review",
        status: "pending",
      },
      "pending work reviewer",
    );

    requireStringArrayExact(
      workItem.release_refs,
      [],
      "P1-005 pending work release_refs",
    );

    const leakedRelease = releaseRecords.some(
      (release) =>
        release.migration_refs?.includes(P1_CLIENT_INTAKE_MIGRATION_ID) ||
        release.work_item_refs?.includes(P1_CLIENT_INTAKE_WORK_ITEM_ID) ||
        release.decision_refs?.includes(P1_CLIENT_INTAKE_DECISION_ID),
    );

    if (leakedRelease) fail("P1-005 pending candidate must not have a release");

    return true;
  }

  if (
    decision.status !== "accepted" ||
    decision.scope !== P1_CLIENT_INTAKE_DECISION_SCOPE ||
    decision.rationale !== P1_CLIENT_INTAKE_DECISION_RATIONALE ||
    decision.owner !== "Rosuno P1-005 technical builder" ||
    decision.updated_at !== P1_CLIENT_INTAKE_LIFECYCLE_AT ||
    decision.impact !== P1_CLIENT_INTAKE_DECISION_IMPACT
  ) {
    fail("P1-005 accepted decision lifecycle mismatch");
  }

  p1005Exact(
    decision.reviewer,
    {
      identity: "Rosuno",
      status: "approved",
    },
    "accepted decision reviewer",
  );

  requireStringArrayExact(
    decision.authority_refs,
    P1_CLIENT_INTAKE_AUTHORITY_REFS,
    "P1-005 decision authority_refs",
  );
  requireStringArrayExact(
    decision.work_item_refs,
    [P1_CLIENT_INTAKE_WORK_ITEM_ID],
    "P1-005 decision work_item_refs",
  );
  requireStringArrayExact(
    decision.supersedes,
    [],
    "P1-005 decision supersedes",
  );
  requireStringArrayExact(
    decision.evidence,
    P1_CLIENT_INTAKE_DECISION_EVIDENCE,
    "P1-005 decision evidence",
  );

  if (
    decision.created_at !== "2026-09-11T06:29:18Z" ||
    decision.expiry !== null
  ) {
    fail("P1-005 accepted decision immutable fields changed");
  }

  if (
    workItem.status !== "completed" ||
    workItem.owner !== "Rosuno P1-005 technical builder" ||
    workItem.priority !== "P1" ||
    workItem.environment !== "staging" ||
    workItem.created_at !== "2026-09-11T06:29:18Z" ||
    workItem.updated_at !== P1_CLIENT_INTAKE_LIFECYCLE_AT ||
    workItem.rollback_reference !== "tools/p0/p1-005-rollback.mjs"
  ) {
    fail("P1-005 completed work-item lifecycle mismatch");
  }

  p1005Exact(
    workItem.reviewer,
    {
      identity: "Rosuno",
      status: "approved",
    },
    "completed work reviewer",
  );

  requireStringArrayExact(
    workItem.authority_refs,
    P1_CLIENT_INTAKE_AUTHORITY_REFS,
    "P1-005 work authority_refs",
  );
  requireStringArrayExact(
    workItem.decision_refs,
    [P1_CLIENT_INTAKE_DECISION_ID],
    "P1-005 work decision_refs",
  );
  requireStringArrayExact(
    workItem.dependencies,
    [P1_CLIENT_INTAKE_DEPENDENCY_WORK_ITEM],
    "P1-005 work dependencies",
  );
  requireStringArrayExact(
    workItem.release_refs,
    [P1_CLIENT_INTAKE_RELEASE_ID],
    "P1-005 work release_refs",
  );
  requireStringArrayExact(
    workItem.migration_refs,
    [P1_CLIENT_INTAKE_MIGRATION_ID],
    "P1-005 work migration_refs",
  );

  const release = p1005ExactlyOne(
    releaseRecords,
    "release_id",
    P1_CLIENT_INTAKE_RELEASE_ID,
    "release",
  );

  p1005Exact(release, P1_CLIENT_INTAKE_EXPECTED_RELEASE, "release");

  const references = releaseRecords.filter(
    (item) =>
      item.migration_refs?.includes(P1_CLIENT_INTAKE_MIGRATION_ID) ||
      item.work_item_refs?.includes(P1_CLIENT_INTAKE_WORK_ITEM_ID) ||
      item.decision_refs?.includes(P1_CLIENT_INTAKE_DECISION_ID),
  );

  if (
    references.length !== 1 ||
    references[0].release_id !== P1_CLIENT_INTAKE_RELEASE_ID
  ) {
    fail("P1-005 release linkage is duplicated or inconsistent");
  }

  const evidence = readJson(P1_CLIENT_INTAKE_CLOSURE_EVIDENCE_PATH);

  validateP1ClientIntakeClosure(migration, migrationSql, evidence);

  return true;
}
