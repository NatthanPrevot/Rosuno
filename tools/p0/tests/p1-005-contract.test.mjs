import assert from "node:assert/strict";
import { test } from "node:test";
import {
  columns,
  readMigrationSql,
  required,
  tables,
} from "../lib/p1-005-contract-data.mjs";

const sql = readMigrationSql();

test("P1-005 SQL is exactly the bounded four-relation foundation", () => {
  assert.deepEqual(
    [...sql.matchAll(/create table public\.(\w+)/gi)].map((match) => match[1]),
    tables,
  );

  assert.equal((sql.match(/enable row level security/gi) || []).length, 4);
  assert.equal((sql.match(/create policy/gi) || []).length, 4);
  assert.equal((sql.match(/for select\s+to authenticated/gi) || []).length, 4);
  assert.equal((sql.match(/create trigger/gi) || []).length, 2);
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
    /\b(?:manage_attorney_verification|capability_definitions|capability_grants|attorney_profiles)\b/i,
  );

  assert.doesNotMatch(sql, /\b90\s+days?\b|interval\s*'90\s+days?'/i);
});

test("P1-005 columns, defaults, and lifecycle checks match the physical contract", () => {
  assert.match(
    sql,
    /state in \(\s*'draft',\s*'submitted',\s*'active',\s*'expired',\s*'superseded',\s*'closed'\s*\)/i,
  );
  assert.doesNotMatch(sql, /'inactive'/i);

  assert.match(
    sql,
    /generated_at timestamptz not null,\s*model_reference text/i,
  );
  assert.doesNotMatch(sql, /generated_at timestamptz not null default/i);
  assert.doesNotMatch(sql, /expires_at timestamptz\s+default/i);

  assert.match(sql, /check \(btrim\(context_type\) <> ''\)/i);
  assert.match(sql, /check \(btrim\(suggestion_type\) <> ''\)/i);

  assert.match(
    sql,
    /\(confirmed_at is null and confirmed_by_user_id is null\)[\s\S]*?\(confirmed_at is not null and confirmed_by_user_id is not null\)/i,
  );
  assert.match(
    sql,
    /not \(confirmed_at is not null and rejected_at is not null\)/i,
  );
  assert.match(
    sql,
    /\(reviewed_at is null and reviewed_by_user_id is null\)[\s\S]*?\(reviewed_at is not null and reviewed_by_user_id is not null\)/i,
  );
});

test("P1-005 foreign keys and indexes are restrictive and exact", () => {
  assert.equal((sql.match(/foreign key\s*\(/gi) || []).length, 7);
  assert.equal(
    (sql.match(/on update restrict\s+on delete restrict/gi) || []).length,
    7,
  );

  const indexes = [
    "intakes_client_state_idx",
    "jurisdiction_assessments_intake_idx",
    "jurisdiction_assessments_ai_suggestion_idx",
    "ai_suggestions_context_idx",
  ];

  assert.deepEqual(
    [...sql.matchAll(/create index\s+(\w+)/gi)].map((match) => match[1]),
    indexes,
  );

  assert.match(
    sql,
    /create index jurisdiction_assessments_ai_suggestion_idx[\s\S]*?where ai_suggestion_id is not null;/i,
  );
});

test("P1-005 RLS exposes authenticated SELECT only through client ownership", () => {
  const authenticatedGrants = [
    ...sql.matchAll(
      /grant\s+([^;]+?)\s+on table public\.(\w+)\s+to authenticated;/gi,
    ),
  ];

  assert.equal(authenticatedGrants.length, 4);
  for (const grant of authenticatedGrants) {
    assert.equal(grant[1].trim().toLowerCase(), "select");
    assert.ok(tables.includes(grant[2]));
  }

  assert.doesNotMatch(
    sql,
    /grant\s+(?:insert|update|delete|[^;]*,\s*(?:insert|update|delete))[^;]*to authenticated;/i,
  );

  assert.match(
    sql,
    /create policy client_profiles_select_own[\s\S]*?u\.id = client_profiles\.user_id[\s\S]*?u\.auth_user_id = \(select auth\.uid\(\)\)/i,
  );
  assert.match(
    sql,
    /create policy intakes_select_own[\s\S]*?c\.id = intakes\.client_id[\s\S]*?u\.auth_user_id = \(select auth\.uid\(\)\)/i,
  );
  assert.match(
    sql,
    /create policy jurisdiction_assessments_select_own[\s\S]*?i\.id = jurisdiction_assessments\.intake_id[\s\S]*?u\.auth_user_id = \(select auth\.uid\(\)\)/i,
  );

  const aiPolicy = sql.match(
    /create policy ai_suggestions_select_own([\s\S]*?)create trigger client_profiles_set_updated_at/i,
  )?.[1];

  assert.ok(aiPolicy);
  assert.match(aiPolicy, /context_type = 'intake'/i);
  assert.match(aiPolicy, /context_type = 'jurisdiction_assessment'/i);
  assert.doesNotMatch(aiPolicy, /attorney/i);
});

test("P1-005 service_role mutation surface is bounded exactly", () => {
  assert.match(
    sql,
    /grant select, insert, update on table public\.client_profiles to service_role;/i,
  );
  assert.match(
    sql,
    /grant select, insert, update on table public\.intakes to service_role;/i,
  );
  assert.match(
    sql,
    /grant select, insert on table public\.ai_suggestions to service_role;/i,
  );
  assert.match(
    sql,
    /grant select, insert on table public\.jurisdiction_assessments to service_role;/i,
  );

  const columnGrant = (table) => {
    const match = sql.match(
      new RegExp(
        `grant update \\(([^)]*)\\) on table public\\.${table} to service_role;`,
        "i",
      ),
    );
    assert.ok(match, `missing ${table} column UPDATE grant`);
    return match[1]
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .sort();
  };

  assert.deepEqual(columnGrant("ai_suggestions"), [
    "confirmed_at",
    "confirmed_by_user_id",
    "presented_at",
    "rejected_at",
  ]);

  assert.deepEqual(columnGrant("jurisdiction_assessments"), [
    "review_status",
    "reviewed_at",
    "reviewed_by_user_id",
  ]);

  assert.doesNotMatch(sql, /grant[^;]*delete[^;]*service_role/i);
});

test("P1-005 reuses only set_updated_at and preserves advisory AI semantics", () => {
  assert.match(
    sql,
    /create trigger client_profiles_set_updated_at[\s\S]*?execute function public\.set_updated_at\(\);/i,
  );
  assert.match(
    sql,
    /create trigger intakes_set_updated_at[\s\S]*?execute function public\.set_updated_at\(\);/i,
  );

  assert.match(
    sql,
    /assessment is recorded provenance and never determines governing law by itself/i,
  );
  assert.match(
    sql,
    /AI output is advisory only and cannot establish authoritative Rosuno business or legal state/i,
  );
  assert.match(
    sql,
    /Trusted application writers must validate context existence and authorization before insert/i,
  );
});
