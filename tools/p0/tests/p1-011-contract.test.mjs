import assert from "node:assert/strict";
import { test } from "node:test";
import {
  columns,
  foreignKeyCount,
  readMigrationSql,
  required,
  tables,
} from "../lib/p1-011-contract-data.mjs";
import { buildRollbackValidation } from "../p1-011-rollback.mjs";

const sql = readMigrationSql();

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

test("P1-011 is exactly the bounded four-relation Physical 1K foundation", () => {
  assert.deepEqual(
    [...sql.matchAll(/create table public\.(\w+)/gi)].map((match) => match[1]),
    tables,
  );
  assert.doesNotMatch(
    sql,
    /create table public\.(payouts|reviews|lrs_certifications|governance_records|panels|panel_memberships|panel_criteria_versions|client_surveys|limited_means_service_configurations|automated_referral_quality_records)\b/i,
  );
  assert.doesNotMatch(sql, /insert into public\./i);
});

test("P1-011 preserves the exact locked Physical 1K columns and nullability", () => {
  for (const table of tables) {
    assert.deepEqual(actualColumns(table), expectedColumns(columns[table]));
    const body = tableBody(table);

    for (const name of required[table].split(" ")) {
      if (name === "id") {
        assert.match(body, /^\s*id uuid primary key\b/im);
      } else {
        assert.match(
          body,
          new RegExp(`^\\s*${name}\\s+[^\\n,]*\\bnot null\\b`, "im"),
          `${table}.${name} must be required`,
        );
      }
    }
  }
});

test("P1-011 has exactly the authority-supported concrete foreign keys", () => {
  const foreignKeys = [
    ...sql.matchAll(
      /constraint\s+\w+_fkey[\s\S]*?foreign key\s*\([^)]+\)[\s\S]*?on update restrict[\s\S]*?on delete restrict/gi,
    ),
  ];
  assert.equal(foreignKeys.length, foreignKeyCount);
  assert.doesNotMatch(
    tableBody("legal_holds"),
    /foreign key\s*\(\s*scope_id\s*\)/i,
  );
});

test("Audit Event is append-only and not an end-user writable current-state table", () => {
  assert.match(
    sql,
    /create function public\.prevent_audit_event_mutation\(\)/i,
  );
  assert.match(
    sql,
    /create trigger audit_events_immutable[\s\S]*before update or delete on public\.audit_events/i,
  );
  assert.match(
    sql,
    /grant select, insert on table public\.audit_events to service_role/i,
  );
  assert.doesNotMatch(
    sql,
    /grant\s+(?:[^;]*\bupdate\b|[^;]*\bdelete\b)[^;]*on table public\.audit_events/i,
  );
});

test("Retention Rule remains versioned policy and does not hard-code a retention period", () => {
  assert.match(
    sql,
    /policy_version_id uuid not null[\s\S]*references public\.policy_versions \(id\)/i,
  );
  assert.match(sql, /policy_type <> 'retention'/i);
  assert.match(
    sql,
    /Retention Rule jurisdiction contradicts its Policy Version scope/i,
  );
  assert.doesNotMatch(
    sql,
    /\b(retention_days|retention_months|retention_years|purge_after_days)\b/i,
  );
});

test("Legal Hold is structural disposition control without defining DOC-DEL", () => {
  assert.match(
    sql,
    /create index legal_holds_scope_idx\s+on public\.legal_holds \(scope_type, scope_id, status\)/i,
  );
  assert.match(sql, /constraint legal_holds_release_pair_check/i);
  assert.doesNotMatch(
    sql,
    /create (?:function|procedure)[\s\S]*\b(purge|erase|delete_resource|physical_delete)\b/i,
  );
  assert.doesNotMatch(sql, /\bdeleted_at\b/i);
});

test("P1-011 does not invent closed actor, retention, Legal Hold, or complaint vocabularies", () => {
  for (const table of [
    "audit_events",
    "retention_rules",
    "legal_holds",
    "complaint_cases",
  ]) {
    const body = tableBody(table);
    assert.doesNotMatch(
      body,
      /\bin\s*\(\s*'(?:open|closed|active|released|pending|resolved|platform|lrs|state_bar)/i,
    );
  }
});

test("P1-011 is fail-closed at the end-user boundary with bounded trusted mutation", () => {
  for (const table of tables) {
    assert.match(
      sql,
      new RegExp(
        `alter table public\\.${table} enable row level security`,
        "i",
      ),
    );
    assert.match(
      sql,
      new RegExp(
        `revoke all on table public\\.${table}[\\s\\S]*?from public, anon, authenticated, service_role`,
        "i",
      ),
    );
    assert.doesNotMatch(
      sql,
      new RegExp(
        `grant[^;]*on table public\\.${table} to (?:anon|authenticated)`,
        "i",
      ),
    );
    assert.doesNotMatch(
      sql,
      new RegExp(`grant[^;]*\\bdelete\\b[^;]*on table public\\.${table}`, "i"),
    );
  }
  assert.doesNotMatch(sql, /create policy\b/i);
});

test("P1-011 includes only authority-supported indexes and Complaint updated_at behavior", () => {
  assert.match(
    sql,
    /create index audit_events_resource_idx\s+on public\.audit_events \(resource_type, resource_id, occurred_at\)/i,
  );
  assert.match(
    sql,
    /create trigger complaint_cases_set_updated_at[\s\S]*execute function public\.set_updated_at\(\)/i,
  );
});

test("P1-011 rollback helper is local generation and ends in ROLLBACK", () => {
  const result = buildRollbackValidation();
  assert.ok(result.checks.length >= 8);
  assert.match(result.sql, /^BEGIN;/);
  assert.match(result.sql, /create table public\.audit_events/i);
  assert.match(result.sql, /Retention Rule rejects a non-retention policy/);
  assert.match(result.sql, /Legal Hold release pair cannot be partial/);
  assert.match(result.sql, /ROLLBACK;\s*$/);
  assert.doesNotMatch(result.sql, /\bCOMMIT;\b/i);
});
