import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ROOT } from "../lib/controls.mjs";
import path from "node:path";

export const migrationPath =
  "supabase/migrations/20260910075939_p1_attorney_verification_eligibility_foundation.sql";
export const sql = readFileSync(path.join(ROOT, migrationPath), "utf8");
export const columns = {
  attorney_profiles:
    "id:uuid user_id:uuid display_name:text bio:text headline:text years_experience:smallint response_expectation_seconds:integer profile_state:text created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
  licenses:
    "id:uuid attorney_id:uuid jurisdiction_id:uuid license_number:text license_type:text effective_from:date effective_until:date reported_status:text created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
  insurance_records:
    "id:uuid attorney_id:uuid jurisdiction_id:uuid carrier_name:text policy_reference:text coverage_type:text per_occurrence_limit_minor:bigint aggregate_limit_minor:bigint currency_code:character(3) coverage_from:date coverage_until:date created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
  discipline_records:
    "id:uuid attorney_id:uuid jurisdiction_id:uuid external_reference:text finding_type:text opened_at:date resolved_at:date status:text details_reference:jsonb created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
  practice_areas: "id:uuid code:text name:text active:boolean",
  practice_area_authorisations:
    "id:uuid attorney_id:uuid jurisdiction_id:uuid practice_area_id:uuid status:text requested_at:timestamp_with_time_zone decided_at:timestamp_with_time_zone effective_from:timestamp_with_time_zone effective_until:timestamp_with_time_zone criteria_policy_version_id:uuid created_at:timestamp_with_time_zone updated_at:timestamp_with_time_zone",
  verification_evidence:
    "id:uuid jurisdiction_id:uuid source_type:text source_uri:text source_reference:text retrieved_at:timestamp_with_time_zone retrieved_by_user_id:uuid evidence_summary:text evidence_digest:text verification_method:text discrepancy_flag:boolean retention_class:text created_at:timestamp_with_time_zone",
  eligibility_evaluations:
    "id:uuid attorney_id:uuid jurisdiction_id:uuid context_type:text context_id:uuid evaluated_at:timestamp_with_time_zone policy_references:jsonb result:text factor_results:jsonb evidence_references:jsonb as_of:timestamp_with_time_zone created_at:timestamp_with_time_zone",
  verification_evidence_subjects:
    "id:uuid verification_evidence_id:uuid license_id:uuid insurance_record_id:uuid discipline_record_id:uuid practice_area_authorisation_id:uuid created_at:timestamp_with_time_zone",
};
export const required = {
  attorney_profiles: "id user_id profile_state created_at updated_at",
  licenses:
    "id attorney_id jurisdiction_id license_number created_at updated_at",
  insurance_records: "id attorney_id created_at updated_at",
  discipline_records: "id attorney_id jurisdiction_id created_at updated_at",
  practice_areas: "id code name active",
  practice_area_authorisations:
    "id attorney_id jurisdiction_id practice_area_id status requested_at created_at updated_at",
  verification_evidence: "id retrieved_at discrepancy_flag created_at",
  eligibility_evaluations:
    "id attorney_id jurisdiction_id context_type evaluated_at policy_references result factor_results evidence_references as_of created_at",
  verification_evidence_subjects: "id verification_evidence_id created_at",
};
export const tables = Object.keys(columns);

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
