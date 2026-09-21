// Generates rollback-only P1-011 validation SQL.
// This module never connects to a database and never executes generated SQL.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readMigrationSql, tables } from "./lib/p1-011-contract-data.mjs";

const q = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const id = (n) => `01100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const u = (n) => `${q(id(n))}::uuid`;

export function buildRollbackValidation() {
  const statements = [
    "BEGIN;",
    "SET LOCAL statement_timeout = '90s';",
    "SET LOCAL lock_timeout = '5s';",
    readMigrationSql(),
    "SET CONSTRAINTS ALL IMMEDIATE;",
  ];
  const checks = [];

  const add = (sql) => statements.push(sql);
  const check = (name, expression, category = "structure") => {
    add(
      `DO $assert$ BEGIN IF (${expression}) IS DISTINCT FROM TRUE THEN RAISE EXCEPTION ${q(
        name,
      )}; END IF; END $assert$;`,
    );
    checks.push({ name, category });
  };
  const denied = (
    name,
    statement,
    sqlstate = "23514",
    category = "integrity",
  ) => {
    add(
      `DO $deny$ BEGIN BEGIN EXECUTE ${q(
        statement,
      )}; RAISE EXCEPTION 'Expected rejection: %',${q(
        name,
      )}; EXCEPTION WHEN SQLSTATE '${sqlstate}' THEN NULL; END; END $deny$;`,
    );
    checks.push({ name, category });
  };

  check(
    "all four P1-011 relations exist with RLS enabled",
    `(select count(*)
      from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public'
        and c.relname in (${tables.map(q).join(",")})
        and c.relkind='r'
        and c.relrowsecurity)=4`,
  );

  check(
    "ordinary authenticated role receives no direct P1-011 table privileges",
    `${tables
      .map(
        (table) =>
          `not has_any_column_privilege('authenticated','public.${table}','SELECT,INSERT,UPDATE')
           and not has_table_privilege('authenticated','public.${table}','DELETE')`,
      )
      .join(" and ")}`,
    "security",
  );

  check(
    "P1-011 grants no table DELETE privilege to service_role",
    `${tables
      .map(
        (table) =>
          `not has_table_privilege('service_role','public.${table}','DELETE')`,
      )
      .join(" and ")}`,
    "security",
  );

  add(`insert into auth.users(id) values
    (${u(101)}),
    (${u(102)});`);

  add(`
insert into public.users(id, auth_user_id, account_state)
values
  (${u(1)}, ${u(101)}, 'active'),
  (${u(2)}, ${u(102)}, 'active');`);

  add(`
insert into public.jurisdictions(
  id, code, name, region_type, lifecycle_state
)
values (
  ${u(3)}, 'P1011_TEST', 'P1-011 Test', 'state', 'staged'
);`);

  add(`
insert into public.policy_types(code, name)
values
  ('retention', 'Retention'),
  ('refund', 'Refund');`);

  add(`
insert into public.policy_versions(
  id,
  policy_type_code,
  jurisdiction_id,
  version_label,
  parameters,
  status
)
values
  (
    ${u(10)},
    'retention',
    ${u(3)},
    'validation-v1',
    '{}'::jsonb,
    'draft'
  ),
  (
    ${u(11)},
    'refund',
    ${u(3)},
    'validation-v1',
    '{}'::jsonb,
    'draft'
  );`);

  add(`
insert into public.audit_events(
  id,
  actor_user_id,
  actor_type,
  action_code,
  resource_type,
  resource_id,
  occurred_at
)
values (
  ${u(20)},
  ${u(1)},
  'validation_actor',
  'validation_action',
  'validation_resource',
  ${u(30)},
  statement_timestamp()
);`);

  denied(
    "Audit Event mutation is rejected",
    `update public.audit_events
       set action_code='rewritten'
       where id=${u(20)}`,
  );

  add(`
insert into public.retention_rules(
  id,
  record_class,
  jurisdiction_id,
  policy_version_id,
  retention_parameters,
  effective_from,
  status
)
values (
  ${u(21)},
  'validation_record_class',
  ${u(3)},
  ${u(10)},
  '{"validation":"no-duration-assumption"}'::jsonb,
  statement_timestamp(),
  'validation_state'
);`);

  denied(
    "Retention Rule rejects a non-retention policy",
    `insert into public.retention_rules(
       id,record_class,jurisdiction_id,policy_version_id,
       retention_parameters,effective_from,status
     ) values (
       ${u(22)},'wrong_policy',${u(3)},${u(11)},
       '{}'::jsonb,statement_timestamp(),'validation_state'
     )`,
  );

  denied(
    "Retention Rule immutable provenance is rejected",
    `update public.retention_rules
       set retention_parameters='{"rewritten":true}'::jsonb
       where id=${u(21)}`,
  );

  denied(
    "Legal Hold release pair cannot be partial",
    `insert into public.legal_holds(
       id,scope_type,scope_id,status,reason,started_at,
       created_by_user_id,released_at
     ) values (
       ${u(23)},'validation_scope',${u(30)},'validation_state',
       'validation reason',statement_timestamp(),${u(1)},statement_timestamp()
     )`,
  );

  add(`
insert into public.legal_holds(
  id,
  scope_type,
  scope_id,
  status,
  reason,
  started_at,
  created_by_user_id
)
values (
  ${u(24)},
  'validation_scope',
  ${u(30)},
  'validation_state',
  'validation reason',
  statement_timestamp(),
  ${u(1)}
);`);

  add(`
update public.legal_holds
set
  status = 'validation_release_state',
  released_at = statement_timestamp(),
  released_by_user_id = ${u(2)}
where id = ${u(24)};`);

  add(`
insert into public.complaint_cases(
  id,
  complainant_user_id,
  jurisdiction_id,
  state,
  opened_at
)
values (
  ${u(25)},
  ${u(1)},
  ${u(3)},
  'validation_state',
  statement_timestamp()
);`);

  check(
    "transient P1-011 fixtures exist",
    `(select count(*) from public.audit_events)=1
     and (select count(*) from public.retention_rules)=1
     and (select count(*) from public.legal_holds)=1
     and (select count(*) from public.complaint_cases)=1`,
    "behavior",
  );

  statements.push("ROLLBACK;");

  return {
    sql: statements.join("\n\n") + "\n",
    checks,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const destination = process.argv[2];
  if (!destination) {
    console.error("Usage: node tools/p0/p1-011-rollback.mjs <output.sql>");
    process.exit(2);
  }

  const result = buildRollbackValidation();
  writeFileSync(destination, result.sql);
  console.log(
    `Wrote ${destination} with ${result.checks.length} rollback-only validation checks.`,
  );
}
