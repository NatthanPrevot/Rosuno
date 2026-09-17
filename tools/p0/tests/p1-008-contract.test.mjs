import assert from "node:assert/strict";
import { test } from "node:test";
import {
  columns,
  readMigrationSql,
  required,
  tables,
} from "../lib/p1-008-contract-data.mjs";

const sql = readMigrationSql();

const functions = [
  "enforce_consultation_relationships",
  "enforce_session_participant_relationship",
];

const triggers = [
  "consultations_relationship_consistency",
  "session_participation_records_participant_consistency",
  "consultations_set_updated_at",
  "engagements_set_updated_at",
];

const indexes = [
  "consultations_attorney_state_started_at_idx",
  "consultations_client_state_started_at_idx",
  "engagements_one_current_effective_per_consultation_idx",
];

const policies = [
  "consultations_select_participants",
  "engagements_select_consultation_participants",
  "media_rooms_select_consultation_participants",
  "media_sessions_select_consultation_participants",
  "session_participation_records_select_consultation_participants",
];

const constraints = [
  "consultations_consultation_request_id_key",
  "consultations_consultation_request_id_fkey",
  "consultations_client_id_fkey",
  "consultations_attorney_id_fkey",
  "consultations_referral_policy_version_id_fkey",
  "consultations_fee_policy_version_id_fkey",
  "consultations_engagement_policy_version_id_fkey",
  "consultations_cancellation_policy_version_id_fkey",
  "consultations_request_path_check",
  "consultations_modality_check",
  "consultations_state_check",
  "consultations_time_order_check",
  "engagements_consultation_version_key",
  "engagements_supersession_identity_key",
  "engagements_consultation_id_fkey",
  "engagements_engagement_policy_version_id_fkey",
  "engagements_supersedes_engagement_id_fkey",
  "engagements_version_number_check",
  "engagements_not_self_superseding_check",
  "engagements_state_check",
  "engagements_effective_period_check",
  "media_rooms_consultation_id_key",
  "media_rooms_consultation_id_fkey",
  "media_rooms_modality_check",
  "media_rooms_state_check",
  "media_sessions_provider_reference_key",
  "media_sessions_media_room_id_fkey",
  "media_sessions_provider_code_check",
  "media_sessions_provider_session_reference_check",
  "media_sessions_provider_state_check",
  "media_sessions_time_order_check",
  "session_participation_records_media_session_id_fkey",
  "session_participation_records_participant_user_id_fkey",
  "session_participation_records_time_order_check",
  "session_participation_records_provider_observation_reference_check",
  "bookings_consultation_id_fkey",
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

test("P1-008 SQL is exactly the bounded five-relation Physical 1H foundation", () => {
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

  assert.equal((sql.match(/enable row level security/gi) || []).length, 5);
  assert.equal((sql.match(/insert into public\./gi) || []).length, 0);

  assert.doesNotMatch(
    sql,
    /create\s+(?:or replace\s+)?(?:view|materialized view|schema|extension|procedure)|\b(?:commit|truncate|drop table|disable row level security)\b/i,
  );

  assert.doesNotMatch(
    sql,
    /create table public\.(?:fee_calculations|payment_transactions|ledger_entries|communications|jobs|presence|presence_heartbeats)\b/i,
  );
});

test("P1-008 columns, required fields, and server defaults match the frozen contract", () => {
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

  assert.equal((sql.match(/default gen_random_uuid\(\)/gi) || []).length, 5);

  assert.equal(
    (
      sql.match(
        /created_at timestamptz not null default statement_timestamp\(\)/gi,
      ) || []
    ).length,
    5,
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

test("P1-008 named constraint surface and referential actions are exact", () => {
  assert.deepEqual(
    [
      ...sql.matchAll(/(?:^\s*constraint\s+|^\s*add constraint\s+)(\w+)/gim),
    ].map((match) => match[1]),
    constraints,
  );

  assert.equal(constraints.length, 36);
  assert.equal((sql.match(/on update restrict/gi) || []).length, 15);
  assert.equal((sql.match(/on delete restrict/gi) || []).length, 15);

  assert.doesNotMatch(
    sql,
    /on (?:update|delete) (?:cascade|set null|set default)/i,
  );
});

test("P1-008 completes the deferred Booking to Consultation FK forward-only", () => {
  assert.match(
    sql,
    /alter table public\.bookings\s+add constraint bookings_consultation_id_fkey\s+foreign key \(consultation_id\)\s+references public\.consultations \(id\)\s+on update restrict\s+on delete restrict;/i,
  );

  assert.equal(
    (sql.match(/add constraint bookings_consultation_id_fkey/gi) || []).length,
    1,
  );
});

test("P1-008 Consultation provenance is frozen to the accepted Request without deciding G-5", () => {
  assert.match(
    sql,
    /constraint consultations_consultation_request_id_key\s+unique \(consultation_request_id\)/i,
  );

  assert.match(
    sql,
    /create trigger consultations_relationship_consistency[\s\S]*?before insert or update of[\s\S]*?consultation_request_id,[\s\S]*?client_id,[\s\S]*?attorney_id,[\s\S]*?request_path,[\s\S]*?referral_policy_version_id[\s\S]*?on public\.consultations[\s\S]*?execute function public\.enforce_consultation_relationships\(\);/i,
  );

  assert.match(
    sql,
    /consultation request\/client\/attorney\/path\/referral-policy provenance is immutable/i,
  );

  assert.match(
    sql,
    /consultation client does not match consultation request client/i,
  );

  assert.match(
    sql,
    /consultation attorney does not match consultation request selected attorney/i,
  );

  assert.match(
    sql,
    /consultation request_path does not match consultation request snapshot/i,
  );

  assert.match(
    sql,
    /consultation referral policy does not match consultation request policy/i,
  );

  assert.match(sql, /if request_state_value <> 'accepted' then/i);

  assert.match(sql, /consultation requires an accepted consultation request/i);

  assert.match(
    sql,
    /if consultation_client_user_id = consultation_attorney_user_id then/i,
  );

  assert.match(
    sql,
    /a user cannot be both client and attorney for the same consultation/i,
  );

  assert.equal(
    [...sql.matchAll(/create (?:constraint )?trigger (\w+)/gi)]
      .map((match) => match[1])
      .filter((name) => name.includes("consultation_request")).length,
    0,
  );

  assert.match(
    sql,
    /requires acceptance as a prerequisite without deciding the G-5 Consultation creation trigger/i,
  );
});

test("P1-008 Engagement history is structurally versioned without deciding G-1", () => {
  assert.match(
    sql,
    /constraint engagements_consultation_version_key\s+unique \(consultation_id, version_number\)/i,
  );

  assert.match(
    sql,
    /constraint engagements_supersession_identity_key\s+unique \(id, consultation_id\)/i,
  );

  assert.match(
    sql,
    /foreign key \(\s*supersedes_engagement_id,\s*consultation_id\s*\)\s*references public\.engagements \(\s*id,\s*consultation_id\s*\)/i,
  );

  assert.match(sql, /check \(version_number > 0\)/i);

  assert.match(
    sql,
    /supersedes_engagement_id is null\s+or supersedes_engagement_id <> id/i,
  );

  assert.match(
    sql,
    /create unique index engagements_one_current_effective_per_consultation_idx\s+on public\.engagements \(consultation_id\)\s+where effective_at is not null\s+and ended_at is null;/i,
  );

  assert.equal(
    functions.filter((name) => name.includes("engagement")).length,
    0,
  );

  assert.equal(
    triggers.filter(
      (name) =>
        name.includes("engagement") && name !== "engagements_set_updated_at",
    ).length,
    0,
  );

  assert.match(
    sql,
    /G-1 determines when effectiveness occurs; this relation only represents that approved result/i,
  );
});

test("P1-008 Media keeps one logical room and subordinate provider sessions", () => {
  assert.match(
    sql,
    /constraint media_rooms_consultation_id_key\s+unique \(consultation_id\)/i,
  );

  assert.match(
    sql,
    /constraint media_sessions_provider_reference_key\s+unique \(provider_code, provider_session_reference\)/i,
  );

  assert.match(
    sql,
    /One stable logical media context per Consultation\. Provider session instances remain subordinate infrastructure observations\./i,
  );

  assert.match(
    sql,
    /Provider media-session correlation and infrastructure state\. Provider state is not canonical Consultation state\./i,
  );

  assert.doesNotMatch(sql, /\bupdate\s+public\.consultations\b/i);
  assert.doesNotMatch(sql, /\bupdate\s+public\.engagements\b/i);
});

test("P1-008 participation evidence is canonical-participant bound and append-only", () => {
  assert.match(
    sql,
    /from public\.media_sessions as media_session[\s\S]*?join public\.media_rooms as media_room[\s\S]*?join public\.consultations as consultation[\s\S]*?join public\.client_profiles as client_profile[\s\S]*?join public\.attorney_profiles as attorney_profile/i,
  );

  assert.match(
    sql,
    /new\.participant_user_id <> consultation_client_user_id\s+and new\.participant_user_id <> consultation_attorney_user_id/i,
  );

  assert.match(sql, /session participant is not a consultation participant/i);

  assert.match(
    sql,
    /create trigger session_participation_records_participant_consistency\s+before insert\s+on public\.session_participation_records[\s\S]*?execute function public\.enforce_session_participant_relationship\(\);/i,
  );

  assert.match(
    sql,
    /grant select, insert\s+on table public\.session_participation_records\s+to service_role;/i,
  );

  assert.doesNotMatch(
    sql,
    /grant update[^;]*public\.session_participation_records[^;]*service_role/i,
  );

  assert.doesNotMatch(
    sql,
    /grant[^;]*delete[^;]*public\.session_participation_records[^;]*service_role/i,
  );

  assert.doesNotMatch(sql, /\bfinalized_at\b/i);

  assert.match(
    sql,
    /Durable append-only participation evidence across provider sessions\/reconnects[\s\S]*?INSERT does not define business\/legal finalization/i,
  );
});

test("P1-008 RLS and privilege surface is participant-scoped and fail-closed", () => {
  assert.equal((sql.match(/revoke all on table public\./gi) || []).length, 5);
  assert.equal((sql.match(/create policy/gi) || []).length, 5);

  assert.equal(
    (
      sql.match(
        /grant select on table public\.(?:consultations|engagements|media_rooms|media_sessions|session_participation_records) to authenticated;/gi,
      ) || []
    ).length,
    5,
  );

  assert.equal((sql.match(/\(select auth\.uid\(\)\)/gi) || []).length, 10);

  assert.doesNotMatch(
    sql,
    /grant\s+[^;]+\s+on table public\.[^;]+\s+to (?:anon|public);/i,
  );

  assert.doesNotMatch(
    sql,
    /grant\s+(?:insert|update|delete)[^;]*\s+to authenticated;/i,
  );

  assert.doesNotMatch(sql, /grant[^;]*delete[^;]*service_role/i);

  assert.equal(
    (
      sql.match(
        /grant execute on function public\.(?:enforce_consultation_relationships|enforce_session_participant_relationship)\(\)\s+to postgres, service_role;/gi,
      ) || []
    ).length,
    2,
  );

  assert.doesNotMatch(
    sql,
    /grant execute on function public\.(?:enforce_consultation_relationships|enforce_session_participant_relationship)\(\)[^;]*authenticated/i,
  );
});

test("P1-008 service_role updates remain column-bounded", () => {
  assert.match(
    sql,
    /grant update \(\s*state,\s*started_at,\s*ended_at,\s*outcome_code\s*\) on table public\.consultations\s+to service_role;/i,
  );

  assert.match(
    sql,
    /grant update \(\s*state,\s*effective_at,\s*ended_at\s*\) on table public\.engagements\s+to service_role;/i,
  );

  assert.match(
    sql,
    /grant update \(\s*state,\s*ended_at\s*\) on table public\.media_rooms\s+to service_role;/i,
  );

  assert.match(
    sql,
    /grant update \(\s*started_at,\s*ended_at,\s*provider_state\s*\) on table public\.media_sessions\s+to service_role;/i,
  );
});

test("P1-008 does not introduce provider, payment, jurisdiction, or later-phase authority", () => {
  assert.doesNotMatch(
    sql,
    /\b(?:california|best_match|is_recommended|paid_placement|subscription_priority)\b/i,
  );

  assert.doesNotMatch(
    sql,
    /create table public\.(?:fee_calculations|payment_transactions|ledger_entries|communications|jobs)\b/i,
  );

  assert.doesNotMatch(
    sql,
    /\b(?:provider_payload|raw_payload|webhook_payload|finalized_at)\b/i,
  );

  assert.match(
    sql,
    /Provider\/media observations remain evidence only and cannot independently[\s\S]*?complete a Consultation, establish\/terminate Engagement, earn a fee, or[\s\S]*?determine a refund\./i,
  );
});
