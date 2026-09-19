import assert from "node:assert/strict";
import { test } from "node:test";
import {
  columns,
  policyTypes,
  readMigrationSql,
  required,
  tables,
} from "../lib/p1-010-contract-data.mjs";
import { buildRollbackValidation } from "../p1-010-rollback.mjs";

const sql = readMigrationSql();

const functions = [
  "enforce_fee_calculation_integrity",
  "prevent_fee_calculation_mutation",
  "enforce_payment_transaction_integrity",
  "enforce_payment_request_consistency",
  "enforce_payment_consultation_consistency",
  "enforce_payment_regulatory_mapping_consistency",
  "enforce_ledger_entry_integrity",
  "prevent_ledger_entry_mutation",
];

const triggers = [
  "fee_calculations_integrity",
  "fee_calculations_immutable",
  "payment_transactions_integrity",
  "consultation_requests_payment_consistency",
  "consultations_payment_consistency",
  "jurisdiction_regulatory_modes_payment_consistency",
  "ledger_entries_integrity",
  "ledger_entries_immutable",
  "payment_transactions_set_updated_at",
  "reconciliation_exceptions_set_updated_at",
];

function tableBody(table) {
  const match = sql.match(
    new RegExp(`create table public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i"),
  );
  assert.ok(match, `missing create table for ${table}`);
  return match[1];
}

function expectedColumns(definition) {
  return definition.split(" ").map((item) => item.split(":")[0]);
}

function actualColumns(table) {
  return [...tableBody(table).matchAll(/^  ([a-z_]+)\s+/gim)]
    .map((match) => match[1])
    .filter((name) => name !== "constraint");
}

test("P1-010 is exactly the bounded five-relation Physical 1J foundation", () => {
  assert.deepEqual(
    [...sql.matchAll(/create table public\.(\w+)/gi)].map((match) => match[1]),
    tables,
  );
  assert.equal((sql.match(/enable row level security/gi) || []).length, 5);
  assert.equal((sql.match(/insert into public\./gi) || []).length, 0);
  assert.doesNotMatch(sql, /create table public\.payouts\b/i);
  assert.doesNotMatch(
    sql,
    /create table public\.(?:audit_events|retention_rules|legal_holds|complaint_cases)\b/i,
  );
});

test("P1-010 exact columns and required nullability match the frozen contract", () => {
  for (const table of tables) {
    assert.deepEqual(actualColumns(table), expectedColumns(columns[table]));
    for (const column of required[table].split(" ")) {
      const body = tableBody(table);
      if (column === "id") {
        assert.match(
          body,
          /^  id uuid primary key default gen_random_uuid\(\),?$/im,
        );
      } else {
        assert.match(
          body,
          new RegExp(`^  ${column}\\b[^\\n]*\\bnot null\\b`, "im"),
        );
      }
    }
  }

  for (const column of [
    "jurisdiction_id",
    "regulatory_mode_id",
    "referral_policy_version_id",
    "payment_policy_version_id",
    "fee_policy_version_id",
    "payment_flow_policy_version_id",
    "engagement_policy_version_id",
    "cancellation_policy_version_id",
    "refund_policy_version_id",
  ]) {
    assert.match(
      tableBody("payment_transactions"),
      new RegExp("^  " + column + " uuid not null,?$", "im"),
    );
  }
});

test("P1-010 has exactly seventeen concrete RESTRICT/RESTRICT foreign keys", () => {
  assert.equal((sql.match(/\bforeign key\b/gi) || []).length, 17);
  assert.equal((sql.match(/on update restrict/gi) || []).length, 17);
  assert.equal((sql.match(/on delete restrict/gi) || []).length, 17);

  assert.doesNotMatch(
    sql,
    /foreign key \(payout_id\)|foreign key \(source_id\)|foreign key \(canonical_id\)/i,
  );
  assert.doesNotMatch(
    sql,
    /on (?:update|delete) (?:cascade|set null|set default)/i,
  );
});

test("P1-010 FP-1 provenance and temporal Regulatory Mode rules are explicit", () => {
  for (const type of policyTypes) {
    assert.match(sql, new RegExp("'" + type + "'(?:::text)?", "i"));
  }

  assert.match(
    sql,
    /active_from <= new\.created_at[\s\S]*?new\.created_at < jrm\.active_until/i,
  );
  assert.match(sql, /does not interpret[\s\S]*?approval_status/i);
  assert.doesNotMatch(sql, /approval_status\s*=\s*'[^']+'/i);
  assert.match(sql, /Payment Transaction identity\/provenance is immutable/i);
  assert.match(
    sql,
    /Payment Transaction must match Fee Calculation Request, fee policy, and currency/i,
  );
});

test("P1-010 Fee Calculation is immutable and supersession is one linear same-Request chain", () => {
  assert.match(
    sql,
    /fee_calculations_one_root_per_request_idx[\s\S]*?where supersedes_fee_calculation_id is null/i,
  );
  assert.match(
    sql,
    /fee_calculations_one_successor_idx[\s\S]*?where supersedes_fee_calculation_id is not null/i,
  );
  assert.match(
    sql,
    /Fee Calculation supersession must remain within one Consultation Request/i,
  );
  assert.match(sql, /Fee Calculation is immutable/i);
});

test("P1-010 Ledger remains append-only and Payout stays inactive", () => {
  assert.match(tableBody("ledger_entries"), /check \(payout_id is null\)/i);
  assert.match(sql, /Ledger Entry is append-only/i);
  assert.match(sql, /Ledger Entry currency must match Payment Transaction/i);
  assert.doesNotMatch(sql, /create table public\.payouts/i);
});

test("P1-010 provider receipt identity is database-unique and noncanonical", () => {
  assert.match(
    tableBody("external_event_receipts"),
    /unique \(provider_code, provider_event_reference\)/i,
  );
  assert.match(
    sql,
    /Provider receipt state is not Rosuno business-state authority/i,
  );
});

test("P1-010 uses only SECURITY INVOKER financial enforcement functions", () => {
  assert.deepEqual(
    [...sql.matchAll(/create function public\.(\w+)/gi)].map(
      (match) => match[1],
    ),
    functions,
  );
  assert.equal(
    (sql.match(/security invoker/gi) || []).length,
    functions.length,
  );
  assert.doesNotMatch(sql, /security definer/i);

  assert.deepEqual(
    [...sql.matchAll(/create (?:constraint )?trigger (\w+)/gi)].map(
      (match) => match[1],
    ),
    triggers,
  );
});

test("P1-010 ordinary access fails closed and trusted mutation is column-bounded", () => {
  assert.doesNotMatch(
    sql,
    /grant\s+[^;]+\s+on table public\.[^;]+\s+to (?:authenticated|anon|public);/i,
  );
  assert.doesNotMatch(sql, /grant[^;]*delete[^;]*service_role/i);
  assert.match(
    sql,
    /grant update \([\s\S]*?consultation_id,[\s\S]*?state,[\s\S]*?failed_at[\s\S]*?payment_transactions to service_role;/i,
  );
  assert.doesNotMatch(
    sql,
    /grant update \([^)]*(?:jurisdiction_id|regulatory_mode_id|payment_policy_version_id|fee_policy_version_id)[^)]*\)[^;]*payment_transactions/i,
  );
});

test("P1-010 preserves unresolved G-1 through G-5 and seeds no persistent policy/business data", () => {
  assert.match(sql, /G-1 through G-5 remain unresolved/i);
  assert.equal((sql.match(/insert into public\./gi) || []).length, 0);
  assert.doesNotMatch(sql, /insert into public\.policy_types/i);
});

test("P1-010 rollback generator is import-safe, rollback-only, and covers frozen failure boundaries", () => {
  const built = buildRollbackValidation();
  assert.match(built.sql, /^BEGIN;/);
  assert.match(built.sql, /ROLLBACK;\s*$/);
  assert.doesNotMatch(built.sql, /\bCOMMIT\b/i);
  assert.ok(built.checks.length >= 10);

  for (const phrase of [
    "all five P1-010 relations exist with RLS enabled",
    "Payout relation is absent",
    "all seventeen concrete P1-010 foreign keys are RESTRICT/RESTRICT",
    "ordinary authenticated role receives no direct P1-010 table privileges",
    "second root Fee Calculation for one Request is rejected",
    "Payment Transaction wrong policy type is rejected",
    "Payment Transaction provenance update is rejected",
    "Ledger payout_id is NULL-only while Payout is inactive",
    "duplicate provider event receipt is rejected",
  ]) {
    assert.match(
      built.sql,
      new RegExp(phrase.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&")),
    );
  }
});
