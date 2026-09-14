// Generates rollback-only P1-006 validation SQL.
// This module never connects to a database and never executes generated SQL.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readMigrationSql, tables } from "./lib/p1-006-contract-data.mjs";

const q = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const id = (n) => `00600000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const u = (n) => `${q(id(n))}::uuid`;

export function buildRollbackValidation() {
  const migrationSql = readMigrationSql();
  const statements = [
    "BEGIN;",
    "SET LOCAL statement_timeout = '90s';",
    "SET LOCAL lock_timeout = '5s';",
    migrationSql,
  ];
  const checks = [];

  const add = (statement) => statements.push(statement);

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
    sqlstate = "42501",
    category = "security",
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

  const targetOids = tables
    .map((table) => `${q(`public.${table}`)}::regclass`)
    .join(",");

  check(
    "exact three P1-006 candidate relations",
    `(select count(*)
      from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public'
        and c.relkind='r'
        and c.relname in (${tables.map(q).join(",")}))=3`,
  );

  check(
    "all P1-006 candidate relations have RLS",
    `(select count(*)
      from pg_class
      where oid in (${targetOids})
        and relrowsecurity)=3`,
    "rls",
  );

  check(
    "P1-006 candidate relations have no end-user policies",
    `(select count(*)
      from pg_policies
      where schemaname='public'
        and tablename in (${tables.map(q).join(",")}))=0`,
    "rls",
  );

  check(
    "P1-006 candidate constraints are exact",
    `(select count(*) from pg_constraint
        where conrelid in (${targetOids}) and contype='p')=3
     and
     (select count(*) from pg_constraint
        where conrelid in (${targetOids}) and contype='f')=8
     and
     (select count(*) from pg_constraint
        where conrelid in (${targetOids}) and contype='u')=1
     and
     (select count(*) from pg_constraint
        where conrelid in (${targetOids}) and contype='c')=0`,
    "constraints",
  );

  check(
    "all eight P1-006 foreign keys are restrictive validated immediate keys",
    `(select count(*)
      from pg_constraint
      where conrelid in (${targetOids})
        and contype='f'
        and confupdtype='r'
        and confdeltype='r'
        and not condeferrable
        and convalidated)=8`,
    "constraints",
  );

  check(
    "P1-006 attempt-order uniqueness exists",
    `exists (
      select 1
      from pg_constraint
      where conrelid='public.referrals'::regclass
        and conname='referrals_intake_attempt_ordinal_key'
        and contype='u'
    )`,
    "constraints",
  );

  check(
    "P1-006 has exactly two standalone lookup indexes",
    `(select count(*)
      from pg_index i
      join pg_class idx on idx.oid=i.indexrelid
      join pg_class tbl on tbl.oid=i.indrelid
      where tbl.oid in (${targetOids})
        and not exists (
          select 1
          from pg_constraint c
          where c.conindid=i.indexrelid
        ))=2
     and to_regclass('public.referral_eligible_pool_entries_referral_idx') is not null
     and to_regclass('public.referral_presentations_referral_display_idx') is not null`,
    "indexes",
  );

  check(
    "P1-006 candidate relations start empty",
    `${tables
      .map((table) => `(select count(*) from public.${table})=0`)
      .join(" and ")}`,
    "data",
  );

  for (const role of ["anon", "authenticated"]) {
    for (const table of tables) {
      for (const operation of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        check(
          `${role} ${table} ${operation} denied`,
          `not has_table_privilege(${q(role)},${q(
            `public.${table}`,
          )},${q(operation)})`,
          "privileges",
        );
      }
    }
  }

  for (const table of tables) {
    check(
      `service_role ${table} SELECT and INSERT only at table level`,
      `has_table_privilege('service_role',${q(`public.${table}`)},'SELECT')
       and has_table_privilege('service_role',${q(`public.${table}`)},'INSERT')
       and not has_table_privilege('service_role',${q(
         `public.${table}`,
       )},'DELETE')`,
      "privileges",
    );
  }

  check(
    "service_role referral UPDATE is limited to outcome columns",
    `not has_table_privilege('service_role','public.referrals','UPDATE')
     and has_column_privilege(
       'service_role','public.referrals','outcome_code','UPDATE'
     )
     and has_column_privilege(
       'service_role','public.referrals','outcome_recorded_at','UPDATE'
     )
     and
     (select count(*)
      from pg_attribute a
      where a.attrelid='public.referrals'::regclass
        and a.attnum>0
        and not a.attisdropped
        and has_column_privilege(
          'service_role','public.referrals',a.attname,'UPDATE'
        ))=2`,
    "privileges",
  );

  check(
    "eligible-pool evidence has no service_role UPDATE surface",
    `not has_any_column_privilege(
      'service_role',
      'public.referral_eligible_pool_entries',
      'UPDATE'
    )`,
    "privileges",
  );

  check(
    "presentation evidence has no service_role UPDATE surface",
    `not has_any_column_privilege(
      'service_role',
      'public.referral_presentations',
      'UPDATE'
    )`,
    "privileges",
  );

  add(`insert into auth.users(id) values(${u(101)}),(${u(102)});`);

  add(`
insert into public.users(id, auth_user_id, account_state)
values
  (${u(1)}, ${u(101)}, 'active'),
  (${u(2)}, ${u(102)}, 'active');`);

  add(`
insert into public.client_profiles(id, user_id)
values (${u(3)}, ${u(1)});`);

  add(`
insert into public.intakes(id, client_id, state)
values (${u(4)}, ${u(3)}, 'active');`);

  add(`
insert into public.jurisdictions(id, code, name, region_type)
values (${u(5)}, 'P1006_TEST', 'P1-006 Test', 'state');`);

  add(`
insert into public.attorney_profiles(id, user_id, profile_state)
values (${u(6)}, ${u(2)}, 'approved');`);

  add(`
insert into public.eligibility_evaluations(
  id,
  attorney_id,
  jurisdiction_id,
  context_type,
  evaluated_at,
  policy_references,
  result,
  factor_results,
  evidence_references,
  as_of
)
values (
  ${u(7)},
  ${u(6)},
  ${u(5)},
  'referral_validation',
  statement_timestamp(),
  '{}'::jsonb,
  'eligible',
  '{}'::jsonb,
  '{}'::jsonb,
  statement_timestamp()
);`);

  add("SET LOCAL ROLE service_role;");

  add(`
insert into public.referrals(
  id,
  intake_id,
  attorney_id,
  jurisdiction_id,
  attempt_ordinal,
  allocation_method
)
values (
  ${u(8)},
  ${u(4)},
  ${u(6)},
  ${u(5)},
  1,
  'validation_fixture'
);`);

  denied(
    "duplicate Intake attempt ordinal rejected",
    `insert into public.referrals(
       id,intake_id,attorney_id,jurisdiction_id,attempt_ordinal
     ) values (
       ${u(11)},
       ${u(4)},
       ${u(6)},
       ${u(5)},
       1
     )`,
    "23505",
    "constraints",
  );

  denied(
    "unknown Intake foreign key rejected",
    `insert into public.referrals(
       id,intake_id,attorney_id,jurisdiction_id,attempt_ordinal
     ) values (
       ${u(12)},
       ${u(999)},
       ${u(6)},
       ${u(5)},
       2
     )`,
    "23503",
    "constraints",
  );

  add(`
insert into public.referral_eligible_pool_entries(
  id,
  referral_id,
  attorney_id,
  eligibility_evaluation_id,
  eligible_as_of,
  pool_reason
)
values (
  ${u(9)},
  ${u(8)},
  ${u(6)},
  ${u(7)},
  statement_timestamp(),
  '{}'::jsonb
);`);

  add(`
insert into public.referral_presentations(
  id,
  referral_id,
  attorney_id,
  display_position,
  client_filter_context,
  platform_presentation_filter_context,
  narrowing_actor,
  shown_at
)
values (
  ${u(10)},
  ${u(8)},
  ${u(6)},
  1,
  '{}'::jsonb,
  '{}'::jsonb,
  'client',
  statement_timestamp()
);`);

  add(`
update public.referrals
set
  outcome_code='validation_outcome',
  outcome_recorded_at=statement_timestamp()
where id=${u(8)};`);

  check(
    "bounded Referral outcome update succeeds",
    `(select outcome_code='validation_outcome'
       and outcome_recorded_at is not null
      from public.referrals
      where id=${u(8)})`,
    "mutation",
  );

  denied(
    "service_role cannot rewrite Referral allocation context",
    `update public.referrals
       set allocation_method='rewritten'
       where id=${u(8)}`,
  );

  denied(
    "eligible-pool evidence is immutable",
    `update public.referral_eligible_pool_entries
       set pool_reason='{"changed":true}'::jsonb
       where id=${u(9)}`,
  );

  denied(
    "eligible-pool evidence cannot be deleted",
    `delete from public.referral_eligible_pool_entries
       where id=${u(9)}`,
  );

  denied(
    "presentation evidence is immutable",
    `update public.referral_presentations
       set display_position=2
       where id=${u(10)}`,
  );

  denied(
    "presentation evidence cannot be deleted",
    `delete from public.referral_presentations
       where id=${u(10)}`,
  );

  add("RESET ROLE;");
  add("SET LOCAL ROLE authenticated;");

  for (const table of tables) {
    denied(
      `authenticated direct read denied on ${table}`,
      `select * from public.${table} limit 1`,
    );
  }

  add("RESET ROLE;");

  check(
    "rollback fixture target-row counts are exact",
    `(select count(*) from public.referrals)=1
     and (select count(*) from public.referral_eligible_pool_entries)=1
     and (select count(*) from public.referral_presentations)=1`,
    "data",
  );

  add("ROLLBACK;");

  return {
    sql: statements.join("\n") + "\n",
    checks,
  };
}

const directExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (directExecution) {
  const outputPath = process.argv[2];

  if (!outputPath) {
    throw new Error("P1-006 rollback generator requires an output path");
  }

  writeFileSync(outputPath, buildRollbackValidation().sql, "utf8");
}
