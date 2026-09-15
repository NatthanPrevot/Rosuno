// Generates rollback-only P1-007 validation SQL.
// This module never connects to a database and never executes generated SQL.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readMigrationSql, tables } from "./lib/p1-007-contract-data.mjs";

const q = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const id = (n) => `00700000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const u = (n) => `${q(id(n))}::uuid`;

const functions = [
  "enforce_consultation_request_relationships",
  "enforce_request_hold_consistency",
  "enforce_scheduling_conflicts",
  "enforce_instant_intent_session_binding",
  "enforce_bookability_eligibility_consistency",
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
    "exact seven P1-007 candidate relations",
    `(select count(*)
      from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public'
        and c.relkind='r'
        and c.relname in (${tables.map(q).join(",")}))=7`,
  );

  check(
    "all P1-007 candidate relations have RLS",
    `(select count(*)
      from pg_class
      where oid in (${targetOids})
        and relrowsecurity)=7`,
    "rls",
  );

  check(
    "P1-007 has exactly four ordinary-user policies",
    `(select count(*)
      from pg_policies
      where schemaname='public'
        and tablename in (${tables.map(q).join(",")}))=4`,
    "rls",
  );

  check(
    "P1-007 authority-backed indexes exist",
    `${indexes
      .map((index) => `to_regclass(${q(`public.${index}`)}) is not null`)
      .join(" and ")}`,
    "indexes",
  );

  check(
    "P1-007 Booking to Consultation FK remains deferred",
    `not exists (
      select 1
      from pg_constraint c
      where c.conrelid='public.bookings'::regclass
        and c.contype='f'
        and pg_get_constraintdef(c.oid)
          ilike 'FOREIGN KEY (consultation_id)%'
    )`,
    "constraints",
  );

  for (const fn of functions) {
    check(
      `service_role can execute ${fn}`,
      `has_function_privilege(
        'service_role',
        ${q(`public.${fn}()`)},
        'EXECUTE'
      )`,
      "privileges",
    );

    check(
      `authenticated cannot execute ${fn}`,
      `not has_function_privilege(
        'authenticated',
        ${q(`public.${fn}()`)},
        'EXECUTE'
      )`,
      "privileges",
    );
  }

  for (const table of tables) {
    check(
      `service_role cannot DELETE ${table}`,
      `not has_table_privilege(
        'service_role',
        ${q(`public.${table}`)},
        'DELETE'
      )`,
      "privileges",
    );
  }

  check(
    "Booking application mutation remains fail-closed",
    `has_table_privilege('service_role','public.bookings','SELECT')
     and not has_table_privilege('service_role','public.bookings','INSERT')
     and not has_table_privilege('service_role','public.bookings','UPDATE')
     and not has_table_privilege('service_role','public.bookings','DELETE')`,
    "privileges",
  );

  check(
    "Bookability evidence is append-only to service_role",
    `has_table_privilege(
       'service_role','public.bookability_evaluations','SELECT'
     )
     and has_table_privilege(
       'service_role','public.bookability_evaluations','INSERT'
     )
     and not has_table_privilege(
       'service_role','public.bookability_evaluations','UPDATE'
     )
     and not has_table_privilege(
       'service_role','public.bookability_evaluations','DELETE'
     )`,
    "privileges",
  );

  check(
    "Request update privilege is column-bounded",
    `not has_table_privilege(
       'service_role','public.consultation_requests','UPDATE'
     )
     and
     (select count(*)
      from pg_attribute a
      where a.attrelid='public.consultation_requests'::regclass
        and a.attnum>0
        and not a.attisdropped
        and has_column_privilege(
          'service_role',
          'public.consultation_requests',
          a.attname,
          'UPDATE'
        ))=6`,
    "privileges",
  );

  check(
    "Hold update privilege is column-bounded",
    `not has_table_privilege(
       'service_role','public.slot_holds','UPDATE'
     )
     and
     (select count(*)
      from pg_attribute a
      where a.attrelid='public.slot_holds'::regclass
        and a.attnum>0
        and not a.attisdropped
        and has_column_privilege(
          'service_role',
          'public.slot_holds',
          a.attname,
          'UPDATE'
        ))=3`,
    "privileges",
  );

  check(
    "Instant Intent update privilege is column-bounded",
    `not has_table_privilege(
       'service_role',
       'public.instant_availability_intents',
       'UPDATE'
     )
     and
     (select count(*)
      from pg_attribute a
      where a.attrelid='public.instant_availability_intents'::regclass
        and a.attnum>0
        and not a.attisdropped
        and has_column_privilege(
          'service_role',
          'public.instant_availability_intents',
          a.attname,
          'UPDATE'
        ))=3`,
    "privileges",
  );

  add(`insert into auth.users(id) values
    (${u(101)}),
    (${u(102)}),
    (${u(103)});`);

  add(`
insert into public.users(id, auth_user_id, account_state)
values
  (${u(1)}, ${u(101)}, 'active'),
  (${u(2)}, ${u(102)}, 'active'),
  (${u(20)}, ${u(103)}, 'active');`);

  add(`
insert into public.client_profiles(id, user_id)
values (${u(3)}, ${u(1)});`);

  add(`
insert into public.intakes(id, client_id, state)
values (${u(4)}, ${u(3)}, 'active');`);

  add(`
insert into public.jurisdictions(id, code, name, region_type)
values (${u(5)}, 'P1007_TEST', 'P1-007 Test', 'state');`);

  add(`
insert into public.attorney_profiles(id, user_id, profile_state)
values
  (${u(6)}, ${u(2)}, 'approved'),
  (${u(21)}, ${u(20)}, 'approved');`);

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
values
  (
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
  ),
  (
    ${u(22)},
    ${u(21)},
    ${u(5)},
    'referral_validation',
    statement_timestamp(),
    '{}'::jsonb,
    'eligible',
    '{}'::jsonb,
    '{}'::jsonb,
    statement_timestamp()
  );`);

  add(`
insert into public.policy_types(code, name)
values ('p1007_validation', 'P1-007 validation');`);

  add(`
insert into public.policy_versions(
  id,
  policy_type_code,
  version_label,
  parameters
)
values (
  ${u(8)},
  'p1007_validation',
  'validation-v1',
  '{}'::jsonb
);`);

  add(`
insert into public.referrals(
  id,
  intake_id,
  attorney_id,
  jurisdiction_id,
  attempt_ordinal,
  allocation_method
)
values
  (
    ${u(9)},
    ${u(4)},
    ${u(6)},
    ${u(5)},
    1,
    'validation_fixture'
  ),
  (
    ${u(13)},
    ${u(4)},
    ${u(6)},
    ${u(5)},
    2,
    'validation_fixture'
  );`);

  add(`
insert into public.application_sessions(
  id,
  user_id,
  auth_session_reference,
  expires_at,
  started_at
)
values
  (
    ${u(10)},
    ${u(2)},
    'p1007-validation-session-0001',
    statement_timestamp() + interval '2 hours',
    statement_timestamp()
  ),
  (
    ${u(23)},
    ${u(1)},
    'p1007-validation-session-0002',
    statement_timestamp() + interval '2 hours',
    statement_timestamp()
  ),
  (
    ${u(24)},
    ${u(2)},
    'p1007-validation-session-0003',
    statement_timestamp() + interval '1 hour',
    statement_timestamp()
  ),
  (
    ${u(25)},
    ${u(2)},
    'p1007-validation-session-0004',
    statement_timestamp() + interval '2 hours',
    statement_timestamp()
  );`);

  add(`
update public.application_sessions
set ended_at=statement_timestamp()
where id=${u(25)};`);

  add("SET LOCAL ROLE service_role;");

  add(`
insert into public.availability_rules(
  id,
  attorney_id,
  rule_kind,
  timezone_name,
  specific_date,
  local_start_time,
  local_end_time,
  active
)
values (
  ${u(30)},
  ${u(6)},
  'one_time',
  'UTC',
  current_date + 1,
  '10:00'::time,
  '11:00'::time,
  true
);`);

  add(`
insert into public.blackouts(
  id,
  attorney_id,
  starts_at,
  ends_at
)
values (
  ${u(31)},
  ${u(6)},
  statement_timestamp() + interval '3 days',
  statement_timestamp() + interval '3 days 1 hour'
);`);

  add(`
insert into public.consultation_requests(
  id,
  intake_id,
  client_id,
  selected_attorney_id,
  referral_id,
  request_path,
  referral_policy_version_id,
  requested_modality,
  state
)
values (
  ${u(11)},
  ${u(4)},
  ${u(3)},
  ${u(6)},
  ${u(9)},
  'scheduled',
  ${u(8)},
  'video',
  'pending'
);`);

  add(`
insert into public.slot_holds(
  id,
  consultation_request_id,
  attorney_id,
  slot_start_at,
  slot_end_at,
  held_at,
  expires_at
)
values (
  ${u(12)},
  ${u(11)},
  ${u(6)},
  statement_timestamp() + interval '1 day',
  statement_timestamp() + interval '1 day 1 hour',
  statement_timestamp(),
  statement_timestamp() + interval '30 minutes'
);`);

  add("SET CONSTRAINTS ALL IMMEDIATE;");

  check(
    "scheduled Request and active Hold validate together",
    `(select count(*) from public.consultation_requests where id=${u(11)})=1
     and
     (select count(*) from public.slot_holds where id=${u(12)})=1`,
    "mutation",
  );

  denied(
    "terminal Request cannot retain active Hold",
    `update public.consultation_requests
       set state='cancelled',
           cancelled_at=statement_timestamp()
       where id=${u(11)}`,
    "23514",
    "constraints",
  );

  denied(
    "Request relationship identity cannot be rewritten",
    `update public.consultation_requests
       set selected_attorney_id=${u(21)}
       where id=${u(11)}`,
  );

  denied(
    "overlapping active Hold is rejected",
    `with new_request as (
       insert into public.consultation_requests(
         id,
         intake_id,
         client_id,
         selected_attorney_id,
         referral_id,
         request_path,
         referral_policy_version_id,
         requested_modality,
         state
       )
       values (
         ${u(14)},
         ${u(4)},
         ${u(3)},
         ${u(6)},
         ${u(13)},
         'scheduled',
         ${u(8)},
         'video',
         'pending'
       )
       returning id
     )
     insert into public.slot_holds(
       id,
       consultation_request_id,
       attorney_id,
       slot_start_at,
       slot_end_at,
       held_at,
       expires_at
     )
     select
       ${u(15)},
       id,
       ${u(6)},
       statement_timestamp() + interval '1 day 30 minutes',
       statement_timestamp() + interval '1 day 90 minutes',
       statement_timestamp(),
       statement_timestamp() + interval '30 minutes'
     from new_request`,
    "23P01",
    "concurrency",
  );

  add("RESET ROLE;");

  denied(
    "confirmed Booking cannot overlap active Hold",
    `insert into public.bookings(
       id,
       consultation_id,
       attorney_id,
       client_id,
       starts_at,
       ends_at,
       status
     )
     values (
       ${u(40)},
       ${u(50)},
       ${u(6)},
       ${u(3)},
       statement_timestamp() + interval '1 day 15 minutes',
       statement_timestamp() + interval '1 day 45 minutes',
       'confirmed'
     )`,
    "23P01",
    "concurrency",
  );

  add("SET LOCAL ROLE service_role;");

  add(`
with accepted_request as (
  update public.consultation_requests
  set
    state='accepted',
    accepted_at=statement_timestamp()
  where id=${u(11)}
  returning id
)
update public.slot_holds
set
  released_at=statement_timestamp(),
  release_reason='accepted'
where consultation_request_id in (
  select id from accepted_request
);`);

  check(
    "accepted Request and released Hold validate atomically",
    `(select state='accepted'
       and accepted_at is not null
      from public.consultation_requests
      where id=${u(11)})
     and
     (select released_at is not null
      from public.slot_holds
      where id=${u(12)})`,
    "mutation",
  );

  denied(
    "service_role Booking INSERT remains denied",
    `insert into public.bookings(
       id,
       consultation_id,
       attorney_id,
       client_id,
       starts_at,
       ends_at,
       status
     )
     values (
       ${u(42)},
       ${u(52)},
       ${u(6)},
       ${u(3)},
       statement_timestamp() + interval '2 days',
       statement_timestamp() + interval '2 days 1 hour',
       'confirmed'
     )`,
  );

  add("RESET ROLE;");

  add(`
insert into public.bookings(
  id,
  consultation_id,
  attorney_id,
  client_id,
  starts_at,
  ends_at,
  status
)
values (
  ${u(40)},
  ${u(50)},
  ${u(6)},
  ${u(3)},
  statement_timestamp() + interval '1 day',
  statement_timestamp() + interval '1 day 1 hour',
  'confirmed'
);`);

  denied(
    "overlapping confirmed Booking is rejected",
    `insert into public.bookings(
       id,
       consultation_id,
       attorney_id,
       client_id,
       starts_at,
       ends_at,
       status
     )
     values (
       ${u(41)},
       ${u(51)},
       ${u(6)},
       ${u(3)},
       statement_timestamp() + interval '1 day 30 minutes',
       statement_timestamp() + interval '1 day 90 minutes',
       'confirmed'
     )`,
    "23P01",
    "concurrency",
  );

  add("SET LOCAL ROLE service_role;");

  add(`
insert into public.instant_availability_intents(
  id,
  attorney_id,
  application_session_id,
  enabled_at,
  expires_at
)
values (
  ${u(32)},
  ${u(6)},
  ${u(10)},
  statement_timestamp(),
  statement_timestamp() + interval '1 hour'
);`);

  denied(
    "Instant Intent session owner mismatch is rejected",
    `insert into public.instant_availability_intents(
       id,
       attorney_id,
       application_session_id,
       enabled_at,
       expires_at
     )
     values (
       ${u(33)},
       ${u(6)},
       ${u(23)},
       statement_timestamp(),
       statement_timestamp() + interval '1 hour'
     )`,
    "23514",
    "constraints",
  );

  denied(
    "Instant Intent cannot outlive application session",
    `insert into public.instant_availability_intents(
       id,
       attorney_id,
       application_session_id,
       enabled_at,
       expires_at
     )
     values (
       ${u(34)},
       ${u(6)},
       ${u(24)},
       statement_timestamp(),
       statement_timestamp() + interval '2 hours'
     )`,
    "23514",
    "constraints",
  );

  denied(
    "ended application session cannot enable Instant Intent",
    `insert into public.instant_availability_intents(
       id,
       attorney_id,
       application_session_id,
       enabled_at,
       expires_at
     )
     values (
       ${u(35)},
       ${u(6)},
       ${u(25)},
       statement_timestamp(),
       statement_timestamp() + interval '1 hour'
     )`,
    "23514",
    "constraints",
  );

  add(`
insert into public.bookability_evaluations(
  id,
  attorney_id,
  eligibility_evaluation_id,
  context_type,
  evaluated_at,
  as_of,
  modality,
  constraint_results,
  result
)
values (
  ${u(36)},
  ${u(6)},
  ${u(7)},
  'scheduled_validation',
  statement_timestamp(),
  statement_timestamp(),
  'video',
  '{}'::jsonb,
  'bookable'
);`);

  denied(
    "Bookability Eligibility attorney mismatch is rejected",
    `insert into public.bookability_evaluations(
       id,
       attorney_id,
       eligibility_evaluation_id,
       context_type,
       evaluated_at,
       as_of,
       modality,
       constraint_results,
       result
     )
     values (
       ${u(37)},
       ${u(6)},
       ${u(22)},
       'scheduled_validation',
       statement_timestamp(),
       statement_timestamp(),
       'video',
       '{}'::jsonb,
       'bookable'
     )`,
    "23514",
    "constraints",
  );

  denied(
    "Bookability evidence cannot be rewritten",
    `update public.bookability_evaluations
       set result='rewritten'
       where id=${u(36)}`,
  );

  denied(
    "Bookability evidence cannot be deleted",
    `delete from public.bookability_evaluations
       where id=${u(36)}`,
  );

  add("RESET ROLE;");
  add("SET LOCAL ROLE authenticated;");

  add(
    `select pg_catalog.set_config(
      'request.jwt.claim.sub',
      ${q(id(102))},
      true
    );`,
  );

  check(
    "attorney can read own scheduling declarations and Instant Intent",
    `(select count(*) from public.availability_rules where id=${u(30)})=1
     and (select count(*) from public.blackouts where id=${u(31)})=1
     and
     (select count(*)
      from public.instant_availability_intents
      where id=${u(32)})=1`,
    "rls",
  );

  check(
    "attorney cannot read client Request through client-only policy",
    `(select count(*)
      from public.consultation_requests
      where id=${u(11)})=0`,
    "rls",
  );

  add(
    `select pg_catalog.set_config(
      'request.jwt.claim.sub',
      ${q(id(101))},
      true
    );`,
  );

  check(
    "client can read own Consultation Request",
    `(select count(*)
      from public.consultation_requests
      where id=${u(11)})=1`,
    "rls",
  );

  check(
    "client cannot read attorney scheduling declarations or Instant Intent",
    `(select count(*) from public.availability_rules where id=${u(30)})=0
     and (select count(*) from public.blackouts where id=${u(31)})=0
     and
     (select count(*)
      from public.instant_availability_intents
      where id=${u(32)})=0`,
    "rls",
  );

  denied(
    "authenticated cannot directly read Slot Holds",
    `select * from public.slot_holds limit 1`,
  );

  denied(
    "authenticated cannot directly read Bookings",
    `select * from public.bookings limit 1`,
  );

  denied(
    "authenticated cannot directly read Bookability evidence",
    `select * from public.bookability_evaluations limit 1`,
  );

  add("RESET ROLE;");

  check(
    "rollback fixture target-row counts are bounded",
    `(select count(*) from public.availability_rules)=1
     and (select count(*) from public.blackouts)=1
     and (select count(*) from public.consultation_requests)=1
     and (select count(*) from public.slot_holds)=1
     and (select count(*) from public.bookings)=1
     and (select count(*) from public.instant_availability_intents)=1
     and (select count(*) from public.bookability_evaluations)=1`,
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
    throw new Error("P1-007 rollback generator requires an output path");
  }

  writeFileSync(outputPath, buildRollbackValidation().sql, "utf8");
}
