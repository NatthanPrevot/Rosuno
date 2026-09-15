import assert from "node:assert/strict";
import { test } from "node:test";
import {
  columns,
  readMigrationSql,
  required,
  tables,
} from "../lib/p1-007-contract-data.mjs";

const sql = readMigrationSql();

const functions = [
  "enforce_consultation_request_relationships",
  "enforce_request_hold_consistency",
  "enforce_scheduling_conflicts",
  "enforce_instant_intent_session_binding",
  "enforce_bookability_eligibility_consistency",
];

const triggers = [
  "consultation_requests_relationship_consistency",
  "consultation_requests_hold_consistency",
  "slot_holds_request_consistency",
  "slot_holds_conflict_guard",
  "bookings_conflict_guard",
  "instant_availability_intents_session_binding",
  "bookability_evaluations_eligibility_consistency",
  "availability_rules_set_updated_at",
  "blackouts_set_updated_at",
];

const indexes = [
  "availability_rules_attorney_effective_idx",
  "blackouts_attorney_time_idx",
  "blackouts_time_range_gist_idx",
  "consultation_requests_intake_created_idx",
  "consultation_requests_attorney_state_idx",
  "slot_holds_attorney_time_idx",
  "slot_holds_time_range_gist_idx",
  "bookings_one_confirmed_per_consultation_idx",
  "bookings_attorney_time_idx",
  "bookings_time_range_gist_idx",
];

const policies = [
  "availability_rules_select_own",
  "blackouts_select_own",
  "consultation_requests_select_own_client",
  "instant_availability_intents_select_own",
];

const constraints = [
  "availability_rules_attorney_id_fkey",
  "availability_rules_rule_kind_check",
  "availability_rules_timezone_name_check",
  "availability_rules_local_time_check",
  "availability_rules_effective_period_check",
  "availability_rules_shape_check",
  "blackouts_attorney_id_fkey",
  "blackouts_time_range_check",
  "consultation_requests_referral_id_key",
  "consultation_requests_intake_id_fkey",
  "consultation_requests_client_id_fkey",
  "consultation_requests_selected_attorney_id_fkey",
  "consultation_requests_referral_id_fkey",
  "consultation_requests_referral_policy_version_id_fkey",
  "consultation_requests_engagement_policy_version_id_fkey",
  "consultation_requests_request_path_check",
  "consultation_requests_requested_modality_check",
  "consultation_requests_state_check",
  "consultation_requests_response_deadline_check",
  "consultation_requests_terminal_timestamp_count_check",
  "consultation_requests_accepted_timestamp_check",
  "consultation_requests_declined_timestamp_check",
  "consultation_requests_expired_timestamp_check",
  "consultation_requests_cancelled_timestamp_check",
  "slot_holds_consultation_request_id_key",
  "slot_holds_consultation_request_id_fkey",
  "slot_holds_attorney_id_fkey",
  "slot_holds_time_range_check",
  "slot_holds_expiry_check",
  "slot_holds_release_time_check",
  "bookings_attorney_id_fkey",
  "bookings_client_id_fkey",
  "bookings_supersession_identity_key",
  "bookings_supersedes_booking_id_fkey",
  "bookings_time_range_check",
  "bookings_status_check",
  "bookings_not_self_superseding_check",
  "bookings_superseded_at_check",
  "bookings_cancelled_at_check",
  "bookings_status_timestamp_check",
  "instant_availability_intents_application_session_id_key",
  "instant_availability_intents_attorney_id_fkey",
  "instant_availability_intents_application_session_id_fkey",
  "instant_availability_intents_expiry_check",
  "instant_availability_intents_revoked_at_check",
  "bookability_evaluations_attorney_id_fkey",
  "bookability_evaluations_eligibility_evaluation_id_fkey",
  "bookability_evaluations_context_type_check",
  "bookability_evaluations_modality_check",
  "bookability_evaluations_presence_trust_method_check",
  "bookability_evaluations_slot_pair_check",
  "bookability_evaluations_slot_range_check",
  "bookability_evaluations_result_check",
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

test("P1-007 SQL is exactly the bounded seven-relation Physical 1G foundation", () => {
  assert.deepEqual(
    [...sql.matchAll(/create table public\.(\w+)/gi)].map((match) => match[1]),
    tables,
  );

  assert.deepEqual(
    [...sql.matchAll(/create function public\.(\w+)/gi)].map(
      (match) => match[1],
    ),
    functions,
  );

  assert.deepEqual(
    [...sql.matchAll(/create (?:constraint )?trigger (\w+)/gi)].map(
      (match) => match[1],
    ),
    triggers,
  );

  assert.deepEqual(
    [...sql.matchAll(/create (?:unique )?index (\w+)/gi)].map(
      (match) => match[1],
    ),
    indexes,
  );

  assert.deepEqual(
    [...sql.matchAll(/create policy (\w+)/gi)].map((match) => match[1]),
    policies,
  );

  assert.equal((sql.match(/enable row level security/gi) || []).length, 7);
  assert.equal((sql.match(/insert into public\./gi) || []).length, 0);

  assert.doesNotMatch(
    sql,
    /create\s+(?:or replace\s+)?(?:view|materialized view|schema|extension|procedure)|\b(?:commit|truncate|drop table|disable row level security)\b/i,
  );

  assert.doesNotMatch(
    sql,
    /create table public\.(?:consultations|engagements|fee_calculations|payment_transactions|ledger_entries|media_rooms|media_sessions|session_participation_records|presence|presence_heartbeats|jobs|communications)/i,
  );
});

test("P1-007 columns, required fields, and server defaults match the frozen contract", () => {
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

  assert.equal((sql.match(/default gen_random_uuid\(\)/gi) || []).length, 7);
  assert.equal(
    (
      sql.match(
        /created_at timestamptz not null default statement_timestamp\(\)/gi,
      ) || []
    ).length,
    7,
  );
  assert.equal(
    (
      sql.match(
        /updated_at timestamptz not null default statement_timestamp\(\)/gi,
      ) || []
    ).length,
    2,
  );
});

test("P1-007 named constraint surface is exact", () => {
  assert.deepEqual(
    [...sql.matchAll(/^\s*constraint\s+(\w+)/gim)].map((match) => match[1]),
    constraints,
  );

  assert.equal(constraints.length, 53);

  assert.doesNotMatch(
    sql,
    /weekday\s+(?:between\s+0\s+and\s+6|between\s+1\s+and\s+7)/i,
  );

  assert.doesNotMatch(
    sql,
    /jsonb_typeof\s*\(\s*(?:availability_basis|constraint_results)\s*\)/i,
  );

  assert.doesNotMatch(sql, /\bas_of\s*<=\s*evaluated_at\b/i);

  assert.doesNotMatch(
    sql,
    /btrim\s*\(\s*(?:reason_code|release_reason)\s*\)\s*<>\s*''/i,
  );
});

test("P1-007 Availability preserves the approved open-ended recurring interpretation", () => {
  assert.match(
    sql,
    /effective_until is null\s+or\s+\(\s*effective_from is not null\s+and effective_until >= effective_from\s*\)/i,
  );

  assert.match(
    sql,
    /rule_kind = 'recurring'\s+and weekday is not null\s+and specific_date is null\s+and effective_from is not null/i,
  );

  assert.match(
    sql,
    /rule_kind = 'one_time'\s+and weekday is null\s+and specific_date is not null\s+and effective_from is null\s+and effective_until is null/i,
  );
});

test("P1-007 preserves the approved deferred Booking to Consultation FK boundary", () => {
  const body = tableBody("bookings");

  assert.match(body, /^  consultation_id uuid not null,/im);

  assert.doesNotMatch(
    sql,
    /foreign key\s*\(\s*consultation_id\s*\)\s*references public\.consultations/i,
  );

  assert.doesNotMatch(sql, /create table public\.consultations\b/i);
});

test("P1-007 Request and Hold consistency is transaction-boundary enforced", () => {
  assert.match(
    sql,
    /create constraint trigger consultation_requests_hold_consistency[\s\S]*?deferrable initially deferred[\s\S]*?execute function public\.enforce_request_hold_consistency\(\);/i,
  );

  assert.match(
    sql,
    /create constraint trigger slot_holds_request_consistency[\s\S]*?deferrable initially deferred[\s\S]*?execute function public\.enforce_request_hold_consistency\(\);/i,
  );

  assert.match(
    sql,
    /constraint slot_holds_consultation_request_id_key\s+unique \(consultation_request_id\)/i,
  );

  assert.match(sql, /request_path in \('instant', 'scheduled'\)/i);

  assert.match(
    sql,
    /if request_state_value in \(\s*'accepted',\s*'declined',\s*'expired',\s*'cancelled'\s*\)\s*and coalesce\(hold_active, false\) then[\s\S]*?raise exception\s*'terminal consultation request cannot retain an active slot hold'[\s\S]*?using errcode = '23514';/i,
  );
});

test("P1-007 Booking currentness, supersession identity, and scheduling conflicts are restrictive", () => {
  assert.match(
    sql,
    /constraint bookings_supersession_identity_key\s+unique \(id, consultation_id, attorney_id, client_id\)/i,
  );

  assert.match(
    sql,
    /foreign key\s*\(\s*supersedes_booking_id,\s*consultation_id,\s*attorney_id,\s*client_id\s*\)\s*references public\.bookings\s*\(\s*id,\s*consultation_id,\s*attorney_id,\s*client_id\s*\)/i,
  );

  assert.match(
    sql,
    /status in \(\s*'confirmed',\s*'superseded',\s*'cancelled',\s*'completed'\s*\)/i,
  );

  assert.match(
    sql,
    /create unique index bookings_one_confirmed_per_consultation_idx\s+on public\.bookings \(consultation_id\)\s+where status = 'confirmed';/i,
  );

  assert.equal((sql.match(/pg_advisory_xact_lock\s*\(/gi) || []).length, 2);

  assert.match(
    sql,
    /create trigger slot_holds_conflict_guard[\s\S]*?execute function public\.enforce_scheduling_conflicts\(\);/i,
  );

  assert.match(
    sql,
    /create trigger bookings_conflict_guard[\s\S]*?execute function public\.enforce_scheduling_conflicts\(\);/i,
  );
});

test("P1-007 Instant Intent is session-bound and cannot outlive the authoritative session", () => {
  assert.match(sql, /session_user_id <> attorney_user_id/i);

  assert.match(
    sql,
    /session_ended_at is not null\s+or session_revoked_at is not null\s+or session_expires_at <= pg_catalog\.clock_timestamp\(\)/i,
  );

  assert.match(sql, /new\.expires_at > session_expires_at/i);

  assert.match(
    sql,
    /instant availability intent cannot outlive application session/i,
  );

  assert.match(
    sql,
    /create trigger instant_availability_intents_session_binding[\s\S]*?before insert or update of[\s\S]*?attorney_id,[\s\S]*?application_session_id,[\s\S]*?enabled_at,[\s\S]*?expires_at[\s\S]*?execute function public\.enforce_instant_intent_session_binding\(\);/i,
  );
});

test("P1-007 Bookability evidence references matching Eligibility and remains append-only", () => {
  assert.match(sql, /eligibility_attorney_id <> new\.attorney_id/i);

  assert.match(
    sql,
    /bookability attorney does not match eligibility evaluation attorney/i,
  );

  assert.match(
    sql,
    /create trigger bookability_evaluations_eligibility_consistency[\s\S]*?before insert or update of[\s\S]*?attorney_id,[\s\S]*?eligibility_evaluation_id[\s\S]*?execute function public\.enforce_bookability_eligibility_consistency\(\);/i,
  );

  assert.match(
    sql,
    /grant select, insert\s+on table public\.bookability_evaluations\s+to service_role;/i,
  );

  assert.doesNotMatch(
    sql,
    /grant update[^;]*public\.bookability_evaluations[^;]*service_role/i,
  );

  assert.doesNotMatch(
    sql,
    /grant[^;]*delete[^;]*public\.bookability_evaluations[^;]*service_role/i,
  );
});

test("P1-007 RLS and privilege surface is fail-closed and least-privilege", () => {
  assert.equal((sql.match(/revoke all on table public\./gi) || []).length, 7);

  assert.equal((sql.match(/create policy/gi) || []).length, 4);

  assert.doesNotMatch(
    sql,
    /grant\s+[^;]+\s+on table public\.[^;]+\s+to (?:anon|public);/i,
  );

  assert.doesNotMatch(
    sql,
    /grant\s+(?:insert|update|delete)[^;]*\s+to authenticated;/i,
  );

  assert.doesNotMatch(sql, /grant[^;]*delete[^;]*service_role/i);

  assert.doesNotMatch(
    sql,
    /grant\s+[^;]+\s+on table public\.(?:slot_holds|bookings|bookability_evaluations)\s+to authenticated;/i,
  );

  assert.match(
    sql,
    /grant select\s+on table public\.bookings\s+to service_role;/i,
  );

  assert.doesNotMatch(
    sql,
    /grant (?:insert|update)[^;]*public\.bookings[^;]*service_role/i,
  );
});

test("P1-007 does not introduce speculative later-phase or jurisdiction-specific truth", () => {
  assert.doesNotMatch(
    sql,
    /\b(?:california|best_match|is_recommended|paid_placement|subscription_priority)\b/i,
  );

  assert.doesNotMatch(
    sql,
    /create table public\.(?:consultations|engagements|media_rooms|fee_calculations|payment_transactions|ledger_entries)/i,
  );

  assert.doesNotMatch(sql, /create table public\.[a-z_]*presence[a-z_]*\b/i);
});
