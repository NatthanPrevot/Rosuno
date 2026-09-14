import assert from "node:assert/strict";
import { test } from "node:test";
import {
  columns,
  readMigrationSql,
  required,
  tables,
} from "../lib/p1-006-contract-data.mjs";

const sql = readMigrationSql();

function tableBody(table) {
  const match = sql.match(
    new RegExp(
      `create table public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
      "i",
    ),
  );

  assert.ok(match, `missing create table for ${table}`);
  return match[1];
}

function expectedColumns(definition) {
  return definition
    .split(" ")
    .map((item) => item.split(":")[0]);
}

function actualColumns(table) {
  return [...tableBody(table).matchAll(/^  ([a-z_]+)\s+/gim)]
    .map((match) => match[1])
    .filter((name) => name !== "constraint");
}

test("P1-006 SQL is exactly the bounded three-relation 1F foundation", () => {
  assert.deepEqual(
    [...sql.matchAll(/create table public\.(\w+)/gi)].map(
      (match) => match[1],
    ),
    tables,
  );

  assert.equal((sql.match(/enable row level security/gi) || []).length, 3);
  assert.equal((sql.match(/create policy/gi) || []).length, 0);
  assert.equal((sql.match(/create trigger/gi) || []).length, 0);
  assert.equal(
    (sql.match(/create\s+(?:or replace\s+)?function/gi) || []).length,
    0,
  );
  assert.equal((sql.match(/insert into public\./gi) || []).length, 0);

  assert.doesNotMatch(
    sql,
    /create\s+(?:or replace\s+)?(?:view|materialized view|schema|extension|procedure)|\b(?:commit|truncate|drop table|disable row level security)\b/i,
  );

  assert.doesNotMatch(
    sql,
    /create table public\.(?:consultation_requests|availability_rules|blackouts|slot_holds|bookings|instant_availability_intents|bookability_evaluations|consultations|fee_calculations|payment_transactions|ledger_entries|audit_events)/i,
  );
});

test("P1-006 columns and timestamp defaults match the locked physical surface", () => {
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

  assert.equal((sql.match(/default gen_random_uuid\(\)/gi) || []).length, 3);
  assert.equal(
    (
      sql.match(
        /created_at timestamptz not null default statement_timestamp\(\)/gi,
      ) || []
    ).length,
    3,
  );

  assert.doesNotMatch(
    sql,
    /(?:eligible_as_of|shown_at|outcome_recorded_at)\s+timestamptz[^,\n]*\bdefault\b/i,
  );

  assert.match(
    sql,
    /attorney_id uuid,\s*jurisdiction_id uuid not null/i,
  );
  assert.match(sql, /pool_reason jsonb,\s*created_at/i);
  assert.match(
    sql,
    /client_filter_context jsonb,\s*platform_presentation_filter_context jsonb,/i,
  );
});

test("P1-006 relationships, uniqueness, and indexes are restrictive and exact", () => {
  assert.equal((sql.match(/foreign key\s*\(/gi) || []).length, 8);
  assert.equal(
    (sql.match(/on update restrict\s+on delete restrict/gi) || []).length,
    8,
  );

  assert.equal((sql.match(/\bcheck\s*\(/gi) || []).length, 0);

  assert.match(
    sql,
    /constraint referrals_intake_attempt_ordinal_key\s+unique \(intake_id, attempt_ordinal\)/i,
  );

  assert.equal((sql.match(/\bunique\s*\(/gi) || []).length, 1);

  assert.deepEqual(
    [...sql.matchAll(/create index\s+(\w+)/gi)].map((match) => match[1]),
    [
      "referral_eligible_pool_entries_referral_idx",
      "referral_presentations_referral_display_idx",
    ],
  );

  assert.match(
    sql,
    /create index referral_eligible_pool_entries_referral_idx\s+on public\.referral_eligible_pool_entries \(referral_id\);/i,
  );

  assert.match(
    sql,
    /create index referral_presentations_referral_display_idx\s+on public\.referral_presentations \(referral_id, display_position\);/i,
  );

  assert.doesNotMatch(sql, /\bon delete cascade\b|\bon update cascade\b/i);
});

test("P1-006 RLS is fail-closed for ordinary end users", () => {
  assert.equal((sql.match(/revoke all on table public\./gi) || []).length, 3);

  assert.doesNotMatch(
    sql,
    /grant\s+[^;]+\s+on table public\.[^;]+\s+to (?:authenticated|anon|public);/i,
  );

  assert.equal((sql.match(/create policy/gi) || []).length, 0);
});

test("P1-006 service_role mutation surface preserves immutable evidence", () => {
  for (const table of tables) {
    assert.match(
      sql,
      new RegExp(
        `grant select, insert\\s+on table public\\.${table}\\s+to service_role;`,
        "i",
      ),
    );
  }

  const updateGrant = sql.match(
    /grant update\s*\(([^)]*)\)\s*on table public\.referrals to service_role;/i,
  );

  assert.ok(updateGrant);

  assert.deepEqual(
    updateGrant[1]
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .sort(),
    ["outcome_code", "outcome_recorded_at"],
  );

  assert.doesNotMatch(
    sql,
    /grant update[^;]*public\.referral_(?:eligible_pool_entries|presentations)[^;]*service_role/i,
  );

  assert.doesNotMatch(sql, /grant[^;]*delete[^;]*service_role/i);
});

test("P1-006 does not invent later-phase or regulatory truth", () => {
  assert.doesNotMatch(sql, /\breferral_policy_version_id\b/i);
  assert.doesNotMatch(sql, /\bbookability_evaluation_id\b/i);
  assert.doesNotMatch(
    sql,
    /\b(?:recommendation|best_match|is_recommended|paid_placement|subscription_priority)\b/i,
  );

  assert.doesNotMatch(
    sql,
    /attempt_ordinal\s+integer\s+not null\s+check|display_position\s+integer\s+not null\s+check/i,
  );

  assert.match(sql, /allocation_method text,/i);
  assert.match(sql, /outcome_code text,/i);
  assert.match(sql, /narrowing_actor text not null,/i);
});
