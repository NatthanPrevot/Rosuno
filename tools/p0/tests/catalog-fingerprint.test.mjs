import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVED_ADVISOR_FINDINGS,
  canonicalizeCatalogRows,
  validateAdvisorFindings,
  validateCatalogBaseline,
  verifyCatalogFingerprint,
} from "../lib/catalog-fingerprint.mjs";

const categoryData = {
  table: {
    schema: "public",
    name: "users",
    kind: "table",
    owner: "postgres",
    comment: null,
  },
  column: {
    schema: "public",
    table: "users",
    name: "id",
    ordinal: 1,
    canonical_type: "uuid",
    nullable: false,
    default_expression: "gen_random_uuid()",
  },
  constraint: {
    schema: "public",
    table: "users",
    name: "users_pkey",
    type: "p",
    columns: ["id"],
    referenced_schema: null,
    referenced_table: null,
    referenced_columns: [],
    definition: "PRIMARY KEY (id)",
  },
  index: {
    schema: "public",
    table: "users",
    name: "users_pkey",
    definition:
      "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
  },
  foreign_key: {
    schema: "public",
    table: "users",
    name: "users_auth_user_id_fkey",
    columns: ["auth_user_id"],
    referenced_schema: "auth",
    referenced_table: "users",
    referenced_columns: ["id"],
    definition: "FOREIGN KEY (auth_user_id) REFERENCES auth.users(id)",
  },
  rls: {
    schema: "public",
    table: "users",
    enabled: true,
    forced: false,
  },
  policy: {
    schema: "public",
    table: "users",
    name: "users_select_own",
    command: "SELECT",
    roles: ["authenticated"],
    permissive: true,
    using_expression: "auth.uid() = auth_user_id",
    check_expression: null,
  },
  trigger: {
    schema: "public",
    table: "users",
    name: "users_set_updated_at",
    function: "public.set_updated_at",
    definition: "CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users",
  },
  function: {
    schema: "public",
    name: "set_updated_at",
    signature: "",
    return_type: "trigger",
    language: "plpgsql",
    volatility: "volatile",
    security_definer: false,
    configuration: ["search_path=pg_catalog"],
    definition: "CREATE FUNCTION public.set_updated_at() RETURNS trigger",
  },
  table_privilege: {
    schema: "public",
    table: "users",
    principal: "service_role",
    principal_name: "service_role",
    explicit_privileges: ["INSERT", "SELECT", "UPDATE"],
    effective_privileges: ["INSERT", "SELECT", "UPDATE"],
  },
  function_privilege: {
    schema: "public",
    function: "set_updated_at",
    signature: "",
    principal: "service_role",
    principal_name: "service_role",
    explicit_execute: true,
    effective_execute: true,
  },
};

function fixture() {
  return Object.entries(categoryData).map(([category, data]) => ({
    category,
    identity: `${category}-identity`,
    data: structuredClone(data),
  }));
}

test("catalog fingerprint is deterministic across ordering and invocations", () => {
  const rows = fixture();
  const first = canonicalizeCatalogRows(rows);
  const second = canonicalizeCatalogRows([...rows].reverse());
  const third = canonicalizeCatalogRows(structuredClone(rows));
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.sha256, third.sha256);
  assert.deepEqual(first.canonicalBytes, second.canonicalBytes);
});

test("documented SQL whitespace and volatile fields do not affect the hash", () => {
  const rows = fixture();
  rows[1].data.default_expression = "  gen_random_uuid( )  ";
  const equivalent = fixture();
  equivalent[1].data.default_expression = "gen_random_uuid( )";
  equivalent[1].data.oid = 123;
  equivalent[1].data.observed_at = "volatile";
  assert.equal(
    canonicalizeCatalogRows(rows).sha256,
    canonicalizeCatalogRows(equivalent).sha256,
  );
});

test("every relevant catalog/security change changes the fingerprint", () => {
  const mutations = [
    ["table", "owner", "other_owner"],
    ["column", "canonical_type", "text"],
    ["column", "nullable", true],
    ["column", "default_expression", null],
    ["constraint", "definition", "PRIMARY KEY (changed_id)"],
    ["foreign_key", "referenced_table", "changed_users"],
    ["index", "definition", "CREATE INDEX changed ON public.users (id)"],
    ["rls", "enabled", false],
    ["policy", "using_expression", "false"],
    ["trigger", "function", "public.changed_function"],
    ["function", "security_definer", true],
    ["table_privilege", "effective_privileges", ["SELECT"]],
  ];
  const baseline = canonicalizeCatalogRows(fixture()).sha256;
  for (const [category, field, value] of mutations) {
    const rows = fixture();
    rows.find((row) => row.category === category).data[field] = value;
    assert.notEqual(canonicalizeCatalogRows(rows).sha256, baseline);
  }
});

test("duplicate, missing, malformed, and ambiguous catalog rows fail closed", () => {
  const rows = fixture();
  assert.throws(
    () => canonicalizeCatalogRows([...rows, structuredClone(rows[0])]),
    /duplicate/,
  );
  assert.throws(
    () =>
      canonicalizeCatalogRows(rows.filter((row) => row.category !== "policy")),
    /category policy is absent/,
  );
  const malformed = fixture();
  delete malformed[0].data.owner;
  assert.throws(() => canonicalizeCatalogRows(malformed), /fields are invalid/);
  const ambiguous = fixture();
  ambiguous[0].data.owner = { name: "postgres" };
  assert.throws(() => canonicalizeCatalogRows(ambiguous), /ambiguous/);
});

test("advisor allowlist accepts exactly three stable identities", () => {
  const findings = APPROVED_ADVISOR_FINDINGS.map((identity) => {
    const table = identity.replace("rls_enabled_no_policy_public_", "");
    return {
      identity,
      name: "rls_enabled_no_policy",
      level: "INFO",
      schema: "public",
      table,
      type: "table",
    };
  });
  assert.equal(validateAdvisorFindings(findings), true);
  assert.throws(() => validateAdvisorFindings(findings.slice(1)), /missing/);
  assert.throws(
    () =>
      validateAdvisorFindings([
        ...findings,
        { ...findings[0], identity: "other_public_users", name: "other" },
      ]),
    /identity changed|unapproved/,
  );
  assert.throws(
    () =>
      validateAdvisorFindings([
        { ...findings[0], table: "changed" },
        ...findings.slice(1),
      ]),
    /identity changed/,
  );
});

test("catalog baseline verification fails on hash, byte, or count drift", () => {
  const result = canonicalizeCatalogRows(fixture());
  const baseline = {
    version: 1,
    scope: "P1-001 and P1-002 approved Staging catalog surface",
    query_contract: "tools/p0/lib/catalog-fingerprint.mjs#CATALOG_SQL",
    normalization_contract: "rosuno-p1-catalog-v1",
    encoding: "UTF-8",
    line_ending: "LF",
    hashing_algorithm: "SHA-256",
    canonical_byte_length: result.canonicalBytes.length,
    excluded_metadata: [
      "object identifiers",
      "transaction identifiers",
      "timestamps",
      "physical storage identifiers and locations",
      "generated execution ordering",
      "backend and session values",
      "environment-specific connection values",
    ],
    historical_diagnostic: {
      value: "9984150cd18477095c120c4a38115ff7",
      status: "non-canonical; derivation was not retained",
    },
    expected_category_counts: result.categoryCounts,
    sha256: result.sha256,
  };
  assert.doesNotThrow(() => validateCatalogBaseline(baseline));
  assert.equal(verifyCatalogFingerprint(result, baseline), true);
  for (const change of [
    (copy) => (copy.sha256 = "0".repeat(64)),
    (copy) => (copy.canonical_byte_length += 1),
    (copy) => (copy.expected_category_counts.table += 1),
  ]) {
    const copy = structuredClone(baseline);
    change(copy);
    assert.throws(() => verifyCatalogFingerprint(result, copy), /differs/);
  }
});
