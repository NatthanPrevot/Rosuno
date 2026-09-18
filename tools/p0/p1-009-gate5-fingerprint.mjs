import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOG_FORMAT,
  CATALOG_SQL,
  canonicalizeCatalogRows,
} from "./lib/catalog-fingerprint.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const P1009_GATE5_CONTRACT_ID = "rosuno-p1-009-gate5-prestate-v1";

export const P1009_GATE5_EVIDENCE_ID = "P1-009-GATE5A-PRESTATE-CONTRACT-V1";

export const P1009_GATE5_DECISION_ID =
  "DEC-20260918-P1-009-GATE5A-PRESTATE-VERIFICATION";

export const P1009_GATE5_PROJECT_REF = "mxjlvmowmodzdtdfgqpb";

export const P1009_GATE5_SQL_PATH =
  "tools/p0/catalog/p1-009-gate5-prestate.sql";

export const P1009_GATE5_RUNNER_PATH = "tools/p0/p1-009-gate5-fingerprint.mjs";

export const P1009_GATE5_CANONICALIZER_PATH =
  "tools/p0/lib/catalog-fingerprint.mjs";

export const P1009_GATE5_TARGET_TABLES = [
  "ai_suggestions",
  "application_sessions",
  "attorney_profiles",
  "availability_rules",
  "blackouts",
  "bookability_evaluations",
  "bookings",
  "capability_definitions",
  "capability_grants",
  "client_profiles",
  "consultation_requests",
  "consultations",
  "discipline_records",
  "eligibility_evaluations",
  "engagements",
  "instant_availability_intents",
  "insurance_records",
  "intakes",
  "jurisdiction_assessments",
  "jurisdiction_regulatory_modes",
  "jurisdictions",
  "launch_authorizations",
  "launch_gate_evaluations",
  "launch_gates",
  "licenses",
  "media_rooms",
  "media_sessions",
  "policy_authority_references",
  "policy_types",
  "policy_versions",
  "practice_area_authorisations",
  "practice_areas",
  "referral_eligible_pool_entries",
  "referral_presentations",
  "referrals",
  "regulatory_modes",
  "service_areas",
  "session_participation_records",
  "slot_holds",
  "staff_profiles",
  "users",
  "verification_evidence",
  "verification_evidence_subjects",
];

export const P1009_GATE5_TARGET_FUNCTIONS = [
  {
    schema: "public",
    name: "enforce_bookability_eligibility_consistency",
    identity_args: "",
  },
  {
    schema: "public",
    name: "enforce_consultation_relationships",
    identity_args: "",
  },
  {
    schema: "public",
    name: "enforce_consultation_request_relationships",
    identity_args: "",
  },
  {
    schema: "public",
    name: "enforce_instant_intent_session_binding",
    identity_args: "",
  },
  {
    schema: "public",
    name: "enforce_jurisdiction_live_authorization",
    identity_args: "",
  },
  {
    schema: "public",
    name: "enforce_policy_authority_provenance",
    identity_args: "",
  },
  {
    schema: "public",
    name: "enforce_request_hold_consistency",
    identity_args: "",
  },
  {
    schema: "public",
    name: "enforce_scheduling_conflicts",
    identity_args: "",
  },
  {
    schema: "public",
    name: "enforce_session_participant_relationship",
    identity_args: "",
  },
  {
    schema: "public",
    name: "has_manage_attorney_verification_scope",
    identity_args: "required_jurisdiction uuid, allow_any_jurisdiction boolean",
  },
  {
    schema: "public",
    name: "rls_auto_enable",
    identity_args: "",
  },
  {
    schema: "public",
    name: "set_updated_at",
    identity_args: "",
  },
];

export const P1009_GATE5_PRINCIPALS = [
  "PUBLIC",
  "anon",
  "authenticated",
  "service_role",
  "owner",
];

export const P1009_GATE5_CATEGORIES = [
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
];

export const P1009_GATE5_MIGRATION_HISTORY = [
  "20260828192126_p0_restrict_rls_auto_enable_execution",
  "20260829000015_p1_platform_foundation",
  "20260829171701_p1_authorization_foundation",
  "20260830023823_p1_jurisdiction_policy_launch_foundation",
  "20260901012518_p1_authorization_scope_correction",
  "20260910075939_p1_attorney_verification_eligibility_foundation",
  "20260911062917_p1_client_intake_ai_foundation",
  "20260914000658_p1_marketplace_referral_foundation",
  "20260914231532_p1_scheduling_request_booking_bookability_foundation",
  "20260917045031_p1_consultation_engagement_media_foundation",
];

export const P1009_GATE5_INFO_ADVISOR_IDENTITIES = [
  "rls_enabled_no_policy:public.application_sessions",
  "rls_enabled_no_policy:public.bookability_evaluations",
  "rls_enabled_no_policy:public.bookings",
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
  "rls_enabled_no_policy:public.referral_eligible_pool_entries",
  "rls_enabled_no_policy:public.referral_presentations",
  "rls_enabled_no_policy:public.referrals",
  "rls_enabled_no_policy:public.regulatory_modes",
  "rls_enabled_no_policy:public.service_areas",
  "rls_enabled_no_policy:public.slot_holds",
];

export const P1009_GATE5_WARN_ADVISOR = {
  code: "authenticated_security_definer_function_executable",
  schema: "public",
  function: "has_manage_attorney_verification_scope",
  identity_args: "required_jurisdiction uuid, allow_any_jurisdiction boolean",
};

export const P1009_HISTORICAL_P1008 = {
  baseline_id: "rosuno-staging-p1-008-20260918-v1",
  sha256: "1926821eee5d37194358f5a0a0e30f2577f7bb08c9be5478ab21dd300e32ba04",
  canonical_byte_length: 410432,
  row_count: 1263,
};

const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;

function buildTableCte() {
  return `target_tables(schema_name, table_name) AS (
  VALUES
${P1009_GATE5_TARGET_TABLES.map(
  (table) => `    ('public',${sqlString(table)})`,
).join(",\n")}
),
`;
}

function buildFunctionCte() {
  return `target_functions(schema_name, function_name, identity_args) AS (
  VALUES
${P1009_GATE5_TARGET_FUNCTIONS.map(
  (fn) =>
    `    (${sqlString(fn.schema)},${sqlString(fn.name)},${sqlString(
      fn.identity_args,
    )})`,
).join(",\n")}
),
`;
}

export function buildP1009Gate5PrestateSql() {
  const tableAnchor = "target_tables(schema_name, table_name) AS (";
  const functionAnchor = "target_functions(schema_name, function_name) AS (";
  const principalsAnchor = "principals(principal, role_name) AS (";

  const tableStart = CATALOG_SQL.indexOf(tableAnchor);
  const functionStart = CATALOG_SQL.indexOf(functionAnchor);
  const principalsStart = CATALOG_SQL.indexOf(principalsAnchor);

  if (
    tableStart < 0 ||
    functionStart <= tableStart ||
    principalsStart <= functionStart
  ) {
    throw new Error("canonical catalog SQL anchors changed");
  }

  let body =
    CATALOG_SQL.slice(0, tableStart) +
    buildTableCte() +
    buildFunctionCte() +
    CATALOG_SQL.slice(principalsStart);

  const broadFunctionJoin =
    "JOIN target_functions f ON f.schema_name=n.nspname AND f.function_name=p.proname";

  const exactFunctionJoin =
    broadFunctionJoin +
    " AND f.identity_args=pg_get_function_identity_arguments(p.oid)";

  const pieces = body.split(broadFunctionJoin);

  if (pieces.length !== 3) {
    throw new Error("canonical catalog function join count changed");
  }

  body = pieces.join(exactFunctionJoin);

  return [
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;",
    "SET LOCAL statement_timeout = '30s';",
    "SET LOCAL lock_timeout = '5s';",
    body.trim(),
    "ROLLBACK;",
    "",
  ].join("\n");
}

export function readP1009Gate5PrestateSql() {
  return readFileSync(path.join(ROOT, P1009_GATE5_SQL_PATH), "utf8");
}

export function verifyP1009Gate5SqlArtifact(
  source = readP1009Gate5PrestateSql(),
) {
  const expected = buildP1009Gate5PrestateSql();

  if (source !== expected) {
    throw new Error(
      "P1-009 Gate 5 prestate SQL differs from deterministic derivation",
    );
  }

  return {
    sha256: createHash("sha256").update(source).digest("hex"),
    bytes: Buffer.byteLength(source, "utf8"),
  };
}

function expectedFunctionIdentity(fn) {
  return `${fn.schema}.${fn.name}(${fn.identity_args})`;
}

function categoryIdentities(rows, category) {
  return rows
    .filter((row) => row.category === category)
    .map((row) => row.identity)
    .sort();
}

function exactIdentitySet(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();

  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} identity scope differs`);
  }
}

export function validateP1009Gate5ScopeRows(rows) {
  if (!Array.isArray(rows)) {
    throw new Error("catalog rows must be an array");
  }

  exactIdentitySet(
    categoryIdentities(rows, "table"),
    P1009_GATE5_TARGET_TABLES.map((table) => `public.${table}`),
    "table",
  );

  const functionIdentities = P1009_GATE5_TARGET_FUNCTIONS.map(
    expectedFunctionIdentity,
  );

  exactIdentitySet(
    categoryIdentities(rows, "function"),
    functionIdentities,
    "function",
  );

  exactIdentitySet(
    categoryIdentities(rows, "table_privilege"),
    P1009_GATE5_TARGET_TABLES.flatMap((table) =>
      P1009_GATE5_PRINCIPALS.map((principal) => `public.${table}.${principal}`),
    ),
    "table privilege",
  );

  exactIdentitySet(
    categoryIdentities(rows, "function_privilege"),
    functionIdentities.flatMap((fn) =>
      P1009_GATE5_PRINCIPALS.map((principal) => `${fn}.${principal}`),
    ),
    "function privilege",
  );

  return true;
}

export function canonicalizeP1009Gate5Rows(rows) {
  const result = canonicalizeCatalogRows(rows);

  if (result.snapshot.format !== CATALOG_FORMAT) {
    throw new Error("catalog canonicalization format changed");
  }

  validateP1009Gate5ScopeRows(result.snapshot.rows);
  return result;
}

export function canonicalizeP1009Gate5RawNdjson(text) {
  const rows = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  return canonicalizeP1009Gate5Rows(rows);
}

function runCli() {
  const command = process.argv[2];

  if (command === "emit-sql") {
    process.stdout.write(buildP1009Gate5PrestateSql());
    return;
  }

  if (command === "canonicalize") {
    const rawPath = process.argv[3];
    const canonicalPath = process.argv[4];

    if (!rawPath || !canonicalPath) {
      throw new Error(
        "canonicalize requires raw NDJSON input and canonical output paths",
      );
    }

    const result = canonicalizeP1009Gate5RawNdjson(
      readFileSync(rawPath, "utf8"),
    );

    writeFileSync(canonicalPath, result.canonicalBytes);

    process.stdout.write(
      `${JSON.stringify({
        sha256: result.sha256,
        canonical_byte_length: result.canonicalBytes.length,
        row_count: result.snapshot.rows.length,
        category_counts: result.categoryCounts,
      })}\n`,
    );
    return;
  }

  throw new Error(
    "supported commands: emit-sql | canonicalize <raw.ndjson> <canonical.json>",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCli();
}
