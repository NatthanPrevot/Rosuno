import assert from "node:assert/strict";
import { test } from "node:test";
import {
  columns,
  readMigrationSql,
  required,
  tables,
} from "../lib/p1-009-contract-data.mjs";
import { buildRollbackValidation } from "../p1-009-rollback.mjs";

const sql = readMigrationSql();

const functions = [
  "enforce_voice_memo_consistency",
  "enforce_message_relationships",
  "enforce_resource_sharing_grant_integrity",
  "has_resource_metadata_access",
];

const triggers = [
  "voice_memos_relationship_consistency",
  "resources_voice_memo_relationship_consistency",
  "intakes_voice_memo_relationship_consistency",
  "client_profiles_voice_memo_relationship_consistency",
  "resource_sharing_grants_integrity",
  "messages_relationship_consistency",
  "resources_set_updated_at",
];

const indexes = [
  "voice_memos_intake_id_idx",
  "resource_sharing_grants_authorization_lookup_idx",
  "messages_consultation_created_at_idx",
  "notifications_recipient_state_created_at_idx",
  "notification_attempts_notification_id_idx",
];

const policies = [
  "resources_select_authorized",
  "documents_select_authorized_resource",
  "voice_memos_select_authorized_resource",
  "resource_sharing_grants_select_owner_or_recipient",
  "messages_select_participant",
  "notifications_select_recipient",
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

test("P1-009 is exactly the bounded eight-relation Physical 1I foundation", () => {
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

  assert.equal((sql.match(/enable row level security/gi) || []).length, 8);
  assert.equal((sql.match(/insert into public\./gi) || []).length, 0);

  assert.doesNotMatch(
    sql,
    /create table public\.(?:fee_calculations|payment_transactions|ledger_entries|payouts|reconciliation_exceptions|external_event_receipts|audit_events|retention_rules|legal_holds|complaint_cases|reviews)\b/i,
  );
});

test("P1-009 exact columns, required fields, UUID defaults, and timestamps match the frozen contract", () => {
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

  assert.equal((sql.match(/default gen_random_uuid\(\)/gi) || []).length, 8);
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
    1,
  );
});

test("P1-009 has exactly fourteen concrete RESTRICT/RESTRICT foreign keys and leaves generic references non-FK", () => {
  assert.equal((sql.match(/\bforeign key\b/gi) || []).length, 14);
  assert.equal((sql.match(/on update restrict/gi) || []).length, 14);
  assert.equal((sql.match(/on delete restrict/gi) || []).length, 14);

  assert.doesNotMatch(
    sql,
    /foreign key \(context_id\)|foreign key \(source_event_id\)|foreign key \(subject_id\)/i,
  );
  assert.doesNotMatch(
    sql,
    /on (?:update|delete) (?:cascade|set null|set default)/i,
  );
});

test("P1-009 preserves D1 and D3 as deferred non-blocking boundaries", () => {
  assert.doesNotMatch(
    sql,
    /supersedes_document|document_family|document_series|document_versions/i,
  );
  assert.doesNotMatch(
    sql,
    /resource_kind\s+in\s*\(|resource_kind\s*=\s*'(?:document|voice_memo)'/i,
  );
  assert.doesNotMatch(sql, /cross[-_ ]?subtype|resource_subtype_exclus/i);
});

test("P1-009 enforces Resource identity and Voice Memo Intake/client ownership with deferred final-state checks", () => {
  assert.match(sql, /unique \(storage_bucket, storage_object_path\)/i);
  assert.match(sql, /duration_seconds between 0 and 60/i);

  for (const trigger of [
    "voice_memos_relationship_consistency",
    "resources_voice_memo_relationship_consistency",
    "intakes_voice_memo_relationship_consistency",
    "client_profiles_voice_memo_relationship_consistency",
  ]) {
    assert.match(
      sql,
      new RegExp(
        `create constraint trigger ${trigger}[\\s\\S]*?deferrable initially deferred`,
        "i",
      ),
    );
  }

  assert.match(
    sql,
    /r\.intake_id <> vm\.intake_id[\s\S]*?r\.owner_user_id <> c\.user_id/i,
  );
});

test("P1-009 Sharing Grant integrity serializes duplicate checks and preserves historical grants", () => {
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*?7009/i);
  assert.match(sql, /tstzrange\([\s\S]*?&&[\s\S]*?tstzrange\(/i);
  assert.match(
    sql,
    /duplicate Resource Sharing Grants may not simultaneously authorize access/i,
  );
  assert.match(sql, /revocation cannot be cleared or rewritten/i);
  assert.doesNotMatch(
    sql,
    /unique \(resource_id, recipient_user_id, context_type, context_id, purpose_code\)/i,
  );
});

test("P1-009 Resource RLS implements corrected I3 and withholds raw Storage locators", () => {
  const helper = sql.match(
    /create function public\.has_resource_metadata_access\(required_resource_id uuid\)[\s\S]*?\$function\$;/i,
  )?.[0];

  assert.ok(helper);
  assert.match(helper, /security definer/i);
  assert.match(helper, /r\.owner_user_id = caller\.id/i);
  assert.match(helper, /i\.id = r\.intake_id[\s\S]*?c\.user_id = caller\.id/i);
  assert.match(
    helper,
    /g\.recipient_user_id = caller\.id[\s\S]*?g\.granted_at <= statement_timestamp\(\)/i,
  );
  assert.doesNotMatch(helper, /consultation_id/i);

  const grant = sql.match(
    /grant select \(([\s\S]*?)\) on table public\.resources to authenticated;/i,
  );

  assert.ok(grant);
  assert.doesNotMatch(grant[1], /storage_bucket|storage_object_path/i);
  assert.doesNotMatch(
    sql,
    /grant select on table public\.resources to authenticated;/i,
  );
});

test("P1-009 Message persistence is Consultation-participant bound and sent content is immutable", () => {
  assert.match(
    sql,
    /Message participants must be the Consultation client and actual attorney/i,
  );
  assert.match(sql, /sent Message identity\/content is immutable/i);
  assert.match(
    sql,
    /Pre-Consultation\/open-inbox messaging is structurally excluded/i,
  );
  assert.match(
    sql,
    /grant update \(visibility_state\)[\s\S]*?public\.messages[\s\S]*?service_role/i,
  );
  assert.doesNotMatch(
    sql,
    /grant update \([^)]*body[^)]*\)[^;]*public\.messages/i,
  );
});

test("P1-009 Notification, attempt, and Operational Job authorities remain separate and least-privileged", () => {
  assert.match(
    sql,
    /grant update \([\s\S]*?state,[\s\S]*?sent_at,[\s\S]*?delivered_at,[\s\S]*?failed_at[\s\S]*?\) on table public\.notifications[\s\S]*?service_role;/i,
  );
  assert.match(
    sql,
    /grant select, insert\s+on table public\.notification_attempts\s+to service_role;/i,
  );
  assert.doesNotMatch(sql, /grant update[^;]*public\.notification_attempts/i);
  assert.doesNotMatch(
    sql,
    /grant select on table public\.(?:notification_attempts|operational_jobs) to authenticated/i,
  );
  assert.match(
    sql,
    /Generalized durable asynchronous execution\/retry infrastructure/i,
  );
});

test("P1-009 privilege surface grants no target DELETE and no authenticated mutation", () => {
  assert.doesNotMatch(sql, /grant[^;]*delete[^;]*service_role/i);
  assert.doesNotMatch(
    sql,
    /grant\s+(?:insert|update|delete)[^;]*\s+to authenticated;/i,
  );
  assert.doesNotMatch(
    sql,
    /grant\s+[^;]+\s+on table public\.[^;]+\s+to (?:anon|public);/i,
  );
});

test("P1-009 rollback generator is import-safe, rollback-only, and covers frozen failure boundaries", () => {
  const built = buildRollbackValidation();

  assert.match(built.sql, /^BEGIN;/);
  assert.match(built.sql, /ROLLBACK;\s*$/);
  assert.doesNotMatch(built.sql, /\bCOMMIT\b/i);
  assert.ok(built.checks.length >= 15);

  for (const phrase of [
    "all eight P1-009 relations exist with RLS enabled",
    "all fourteen concrete P1-009 foreign keys are RESTRICT/RESTRICT",
    "authenticated cannot read raw Storage locator columns",
    "Client can read owned and own-Intake Resource metadata",
    "Attorney sees own Resources plus explicitly shared client Resource only",
    "Consultation association alone does not disclose unshared client Resource",
    "simultaneously-authorizing duplicate Sharing Grant is rejected",
    "Voice Memo rejects Resource owner inconsistent with Intake Client",
    "Resource owner change cannot contradict existing Voice Memo",
  ]) {
    assert.match(
      built.sql,
      new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});
