import assert from "node:assert/strict";
import { test } from "node:test";
import {
  columns,
  migrationPath,
  readMigrationSql,
  required,
  tables,
} from "../lib/p1-004-contract-data.mjs";

export { columns, migrationPath, required, tables };
export const sql = readMigrationSql();

test("P1-004 SQL has exactly the approved relations and single read-only helper", () => {
  assert.deepEqual(
    [...sql.matchAll(/create table public\.(\w+)/gi)].map((m) => m[1]),
    tables,
  );
  assert.deepEqual(
    [...sql.matchAll(/create function public\.(\w+)/gi)].map((m) => m[1]),
    ["has_manage_attorney_verification_scope"],
  );
  assert.equal((sql.match(/enable row level security/gi) || []).length, 9);
  assert.equal((sql.match(/create policy/gi) || []).length, 9);
  assert.equal((sql.match(/for select to authenticated/gi) || []).length, 9);
  assert.equal((sql.match(/create trigger/gi) || []).length, 5);
  assert.doesNotMatch(
    sql,
    /create\s+(?:or replace\s+)?(?:view|materialized view|schema|extension|procedure)|\b(?:commit|truncate|drop table|disable row level security)\s*;/i,
  );
  assert.doesNotMatch(
    sql,
    /\b(?:is_eligible|is_verified|is_bookable|is_available|verification_evidence_subject_corrections|client_profiles)\b/i,
  );
  assert.equal((sql.match(/insert into public\./gi) || []).length, 1);
  assert.doesNotMatch(
    sql,
    /grant\s+select\s+on\s+(?:table\s+)?public.capability_grants\s+to\s+authenticated/i,
  );
});

test("P1-004 helper has fixed caller, capability, timing, scope and execution boundary", () => {
  const helper = sql.match(
    /create function public\.has_manage_attorney_verification_scope\(([\s\S]*?)\$function\$;/i,
  )[1];
  assert.match(
    helper,
    /^\s*required_jurisdiction uuid, allow_any_jurisdiction boolean\s*\) returns boolean\s+language sql stable security definer\s+set search_path = pg_catalog/i,
  );
  assert.match(helper, /u\.auth_user_id = auth\.uid\(\)/);
  assert.match(helper, /u\.id = g\.user_id/);
  for (const expression of [
    "g.capability_code = 'manage_attorney_verification'",
    "g.granted_at <= statement_timestamp()",
    "g.revoked_at is null",
    "g.expires_at > statement_timestamp()",
    "g.resource_scope is null",
    "allow_any_jurisdiction is true or g.jurisdiction_id is null",
    "g.jurisdiction_id = required_jurisdiction",
  ])
    assert.ok(helper.includes(expression), expression);
  assert.doesNotMatch(
    helper,
    /\b(insert|update|delete|execute|set_config|perform|call)\b/i,
  );
  assert.match(
    sql,
    /revoke all on function public\.has_manage_attorney_verification_scope\(uuid, boolean\) from public, anon, authenticated, service_role;/,
  );
  assert.match(
    sql,
    /grant execute on function public\.has_manage_attorney_verification_scope\(uuid, boolean\) to authenticated;/,
  );
  assert.equal(
    (sql.match(/has_manage_attorney_verification_scope\(null, true\)/g) || [])
      .length,
    1,
  );
  assert.match(
    sql,
    /create policy practice_areas_select[\s\S]*?using \(active or public\.has_manage_attorney_verification_scope\(null, true\)\);/,
  );
});

test("P1-004 association and historical writer contracts are independently represented", () => {
  assert.equal((sql.match(/create unique index ves_/g) || []).length, 4);
  assert.match(
    sql,
    /grant update \(license_id, insurance_record_id, discipline_record_id, practice_area_authorisation_id\) on table public.verification_evidence_subjects to service_role;/,
  );
  assert.doesNotMatch(
    sql,
    /grant select, insert, update on table public\.(?:verification_evidence|eligibility_evaluations|verification_evidence_subjects) /,
  );
  const policy = sql.match(
    /create policy verification_evidence_subjects_select([\s\S]*?)\n\);/,
  )[1];
  assert.match(policy, /num_nonnulls\([\s\S]*?\) = 1/);
  assert.match(
    policy,
    /exists \(select 1 from public.verification_evidence e where e.id = verification_evidence_subjects.verification_evidence_id\)/,
  );
  assert.equal(
    (
      policy.match(
        /has_manage_attorney_verification_scope\(subject.jurisdiction_id, false\)/g,
      ) || []
    ).length,
    4,
  );
  assert.doesNotMatch(policy, /e\.jurisdiction_id|coalesce/i);
  assert.match(
    sql,
    /Writer contract: independently retain every relied-upon verification_evidence.id and direct professional-record identifiers/,
  );
});
