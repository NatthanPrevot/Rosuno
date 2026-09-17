// Generates rollback-only P1-008 validation SQL.
// This module never connects to a database and never executes generated SQL.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readMigrationSql, tables } from "./lib/p1-008-contract-data.mjs";

const q = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const id = (n) => `00800000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const u = (n) => `${q(id(n))}::uuid`;

const functions = [
  "enforce_consultation_relationships",
  "enforce_session_participant_relationship",
];

const indexes = [
  "consultations_attorney_state_started_at_idx",
  "consultations_client_state_started_at_idx",
  "engagements_one_current_effective_per_consultation_idx",
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

  const updateColumns = (table, count) => {
    check(
      `${table} update privilege is column-bounded`,
      `not has_table_privilege(
         'service_role',
         ${q(`public.${table}`)},
         'UPDATE'
       )
       and
       (select count(*)
        from pg_attribute a
        where a.attrelid=${q(`public.${table}`)}::regclass
          and a.attnum>0
          and not a.attisdropped
          and has_column_privilege(
            'service_role',
            ${q(`public.${table}`)},
            a.attname,
            'UPDATE'
          ))=${count}`,
      "privileges",
    );
  };

  const targetOids = tables
    .map((table) => `${q(`public.${table}`)}::regclass`)
    .join(",");

  check(
    "exact five P1-008 candidate relations",
    `(select count(*)
      from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public'
        and c.relkind='r'
        and c.relname in (${tables.map(q).join(",")}))=5`,
  );

  check(
    "all P1-008 candidate relations have RLS",
    `(select count(*)
      from pg_class
      where oid in (${targetOids})
        and relrowsecurity)=5`,
    "rls",
  );

  check(
    "P1-008 has exactly five ordinary-user policies",
    `(select count(*)
      from pg_policies
      where schemaname='public'
        and tablename in (${tables.map(q).join(",")}))=5`,
    "rls",
  );

  check(
    "P1-008 authority-backed indexes exist",
    `${indexes
      .map((index) => `to_regclass(${q(`public.${index}`)}) is not null`)
      .join(" and ")}`,
    "indexes",
  );

  check(
    "P1-008 Booking to Consultation FK is present and restrictive",
    `exists (
      select 1
      from pg_constraint c
      where c.conname='bookings_consultation_id_fkey'
        and c.conrelid='public.bookings'::regclass
        and c.confrelid='public.consultations'::regclass
        and c.contype='f'
        and c.confupdtype='r'
        and c.confdeltype='r'
        and pg_get_constraintdef(c.oid)
          ilike 'FOREIGN KEY (consultation_id) REFERENCES consultations(id)%'
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

    check(
      `authenticated access to ${table} is SELECT-only`,
      `has_table_privilege(
         'authenticated',
         ${q(`public.${table}`)},
         'SELECT'
       )
       and not has_table_privilege(
         'authenticated',
         ${q(`public.${table}`)},
         'INSERT'
       )
       and not has_table_privilege(
         'authenticated',
         ${q(`public.${table}`)},
         'UPDATE'
       )
       and not has_table_privilege(
         'authenticated',
         ${q(`public.${table}`)},
         'DELETE'
       )`,
      "privileges",
    );
  }

  updateColumns("consultations", 4);
  updateColumns("engagements", 3);
  updateColumns("media_rooms", 2);
  updateColumns("media_sessions", 3);

  check(
    "Participation evidence is append-only to service_role",
    `has_table_privilege(
       'service_role',
       'public.session_participation_records',
       'SELECT'
     )
     and has_table_privilege(
       'service_role',
       'public.session_participation_records',
       'INSERT'
     )
     and not has_table_privilege(
       'service_role',
       'public.session_participation_records',
       'UPDATE'
     )
     and not has_table_privilege(
       'service_role',
       'public.session_participation_records',
       'DELETE'
     )
     and
     (select count(*)
      from pg_attribute a
      where a.attrelid='public.session_participation_records'::regclass
        and a.attnum>0
        and not a.attisdropped
        and has_column_privilege(
          'service_role',
          'public.session_participation_records',
          a.attname,
          'UPDATE'
        ))=0`,
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
values
  (${u(3)}, ${u(1)}),
  (${u(23)}, ${u(20)});`);

  add(`
insert into public.intakes(id, client_id, state)
values (${u(4)}, ${u(3)}, 'active');`);

  add(`
insert into public.jurisdictions(id, code, name, region_type)
values (${u(5)}, 'P1008_TEST', 'P1-008 Test', 'state');`);

  add(`
insert into public.attorney_profiles(id, user_id, profile_state)
values
  (${u(6)}, ${u(2)}, 'approved'),
  (${u(21)}, ${u(20)}, 'approved'),
  (${u(22)}, ${u(1)}, 'approved');`);

  add(`
insert into public.policy_types(code, name)
values ('p1008_validation', 'P1-008 validation');`);

  add(`
insert into public.policy_versions(
  id,
  policy_type_code,
  version_label,
  parameters
)
values (
  ${u(8)},
  'p1008_validation',
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
    ${u(22)},
    ${u(5)},
    2,
    'validation_fixture'
  ),
  (
    ${u(18)},
    ${u(4)},
    ${u(6)},
    ${u(5)},
    3,
    'validation_fixture'
  );`);

  add("SET LOCAL ROLE service_role;");

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
    "accepted scheduled Request retains one released Hold",
    `(select state='accepted'
       and accepted_at is not null
      from public.consultation_requests
      where id=${u(11)})
     and
     (select released_at is not null
       and release_reason='accepted'
      from public.slot_holds
      where id=${u(12)})`,
    "fixture",
  );

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
  state,
  accepted_at
)
values (
  ${u(16)},
  ${u(4)},
  ${u(3)},
  ${u(22)},
  ${u(13)},
  'instant',
  ${u(8)},
  'video',
  'accepted',
  statement_timestamp()
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
  ${u(17)},
  ${u(4)},
  ${u(3)},
  ${u(6)},
  ${u(18)},
  'instant',
  ${u(8)},
  'video',
  'pending'
);`);

  add("SET CONSTRAINTS ALL IMMEDIATE;");

  add(`
insert into public.consultations(
  id,
  consultation_request_id,
  client_id,
  attorney_id,
  request_path,
  referral_policy_version_id,
  modality,
  state
)
values (
  ${u(30)},
  ${u(11)},
  ${u(3)},
  ${u(6)},
  'scheduled',
  ${u(8)},
  'video',
  'validation_fixture'
);`);

  check(
    "valid Consultation snapshots accepted Request provenance",
    `exists (
      select 1
      from public.consultations
      where id=${u(30)}
        and consultation_request_id=${u(11)}
        and client_id=${u(3)}
        and attorney_id=${u(6)}
        and request_path='scheduled'
        and referral_policy_version_id=${u(8)}
        and modality='video'
        and state='validation_fixture'
    )`,
    "relationships",
  );

  denied(
    "Consultation rejects attorney mismatch with accepted Request",
    `insert into public.consultations(
       id,
       consultation_request_id,
       client_id,
       attorney_id,
       request_path,
       referral_policy_version_id,
       modality,
       state
     )
     values (
       ${u(32)},
       ${u(11)},
       ${u(3)},
       ${u(21)},
       'scheduled',
       ${u(8)},
       'video',
       'validation_fixture'
     )`,
    "23514",
    "relationships",
  );

  denied(
    "Consultation rejects self-consultation",
    `insert into public.consultations(
       id,
       consultation_request_id,
       client_id,
       attorney_id,
       request_path,
       referral_policy_version_id,
       modality,
       state
     )
     values (
       ${u(33)},
       ${u(16)},
       ${u(3)},
       ${u(22)},
       'instant',
       ${u(8)},
       'video',
       'validation_fixture'
     )`,
    "23514",
    "relationships",
  );

  denied(
    "Consultation rejects non-accepted Request",
    `insert into public.consultations(
       id,
       consultation_request_id,
       client_id,
       attorney_id,
       request_path,
       referral_policy_version_id,
       modality,
       state
     )
     values (
       ${u(34)},
       ${u(17)},
       ${u(3)},
       ${u(6)},
       'instant',
       ${u(8)},
       'video',
       'validation_fixture'
     )`,
    "23514",
    "relationships",
  );

  add(`
update public.consultation_requests
set
  state='accepted',
  accepted_at=statement_timestamp()
where id=${u(17)};`);

  add(`
insert into public.consultations(
  id,
  consultation_request_id,
  client_id,
  attorney_id,
  request_path,
  referral_policy_version_id,
  modality,
  state
)
values (
  ${u(31)},
  ${u(17)},
  ${u(3)},
  ${u(6)},
  'instant',
  ${u(8)},
  'video',
  'validation_fixture'
);`);

  check(
    "second valid Consultation snapshots accepted instant Request provenance",
    `exists (
      select 1
      from public.consultations
      where id=${u(31)}
        and consultation_request_id=${u(17)}
        and client_id=${u(3)}
        and attorney_id=${u(6)}
        and request_path='instant'
        and referral_policy_version_id=${u(8)}
        and modality='video'
        and state='validation_fixture'
    )`,
    "relationships",
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
  ${u(80)},
  ${u(30)},
  ${u(6)},
  ${u(3)},
  statement_timestamp() + interval '5 days',
  statement_timestamp() + interval '5 days 1 hour',
  'confirmed'
);`);

  check(
    "Booking can reference P1-008 Consultation",
    `exists (
      select 1
      from public.bookings
      where id=${u(80)}
        and consultation_id=${u(30)}
        and attorney_id=${u(6)}
        and client_id=${u(3)}
        and status='confirmed'
    )`,
    "relationships",
  );

  denied(
    "Booking rejects missing Consultation",
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
       ${u(81)},
       ${u(999)},
       ${u(6)},
       ${u(3)},
       statement_timestamp() + interval '7 days',
       statement_timestamp() + interval '7 days 1 hour',
       'confirmed'
     )`,
    "23503",
    "relationships",
  );

  add("SET LOCAL ROLE service_role;");

  add(`
insert into public.engagements(
  id,
  consultation_id,
  engagement_policy_version_id,
  version_number,
  supersedes_engagement_id,
  effective_at,
  state
)
values
  (
    ${u(40)},
    ${u(30)},
    ${u(8)},
    1,
    null,
    null,
    'validation_fixture'
  ),
  (
    ${u(41)},
    ${u(30)},
    ${u(8)},
    2,
    ${u(40)},
    null,
    'validation_fixture'
  ),
  (
    ${u(42)},
    ${u(30)},
    ${u(8)},
    3,
    ${u(41)},
    statement_timestamp(),
    'validation_fixture'
  );`);

  check(
    "Engagement version history supports one structural current effective row",
    `(select count(*)
      from public.engagements
      where consultation_id=${u(30)})=3
     and
     (select count(*)
      from public.engagements
      where consultation_id=${u(30)}
        and version_number in (1,2,3))=3
     and
     (select supersedes_engagement_id=${u(40)}
      from public.engagements
      where id=${u(41)})
     and
     (select supersedes_engagement_id=${u(41)}
      from public.engagements
      where id=${u(42)})
     and
     (select count(*)
      from public.engagements
      where consultation_id=${u(30)}
        and effective_at is not null
        and ended_at is null)=1`,
    "relationships",
  );

  denied(
    "Engagement rejects duplicate version within Consultation",
    `insert into public.engagements(
       id,
       consultation_id,
       engagement_policy_version_id,
       version_number,
       supersedes_engagement_id,
       state
     )
     values (
       ${u(43)},
       ${u(30)},
       ${u(8)},
       3,
       ${u(42)},
       'validation_fixture'
     )`,
    "23505",
    "relationships",
  );

  denied(
    "Engagement rejects cross-Consultation supersession",
    `insert into public.engagements(
       id,
       consultation_id,
       engagement_policy_version_id,
       version_number,
       supersedes_engagement_id,
       state
     )
     values (
       ${u(44)},
       ${u(31)},
       ${u(8)},
       1,
       ${u(40)},
       'validation_fixture'
     )`,
    "23503",
    "relationships",
  );

  denied(
    "Engagement rejects second structural current effective row",
    `insert into public.engagements(
       id,
       consultation_id,
       engagement_policy_version_id,
       version_number,
       supersedes_engagement_id,
       effective_at,
       state
     )
     values (
       ${u(45)},
       ${u(30)},
       ${u(8)},
       4,
       ${u(42)},
       statement_timestamp(),
       'validation_fixture'
     )`,
    "23505",
    "relationships",
  );

  denied(
    "Engagement rejects non-positive version number",
    `insert into public.engagements(
       id,
       consultation_id,
       engagement_policy_version_id,
       version_number,
       state
     )
     values (
       ${u(46)},
       ${u(31)},
       ${u(8)},
       0,
       'validation_fixture'
     )`,
    "23514",
    "relationships",
  );

  add(`
insert into public.media_rooms(
  id,
  consultation_id,
  modality,
  state
)
values (
  ${u(50)},
  ${u(30)},
  'video',
  'validation_fixture'
);`);

  check(
    "Media Room is bound one-to-one to its Consultation",
    `exists (
      select 1
      from public.media_rooms
      where id=${u(50)}
        and consultation_id=${u(30)}
        and modality='video'
        and state='validation_fixture'
    )`,
    "relationships",
  );

  denied(
    "Media Room rejects second logical room for Consultation",
    `insert into public.media_rooms(
       id,
       consultation_id,
       modality,
       state
     )
     values (
       ${u(51)},
       ${u(30)},
       'video',
       'validation_fixture'
     )`,
    "23505",
    "relationships",
  );

  add(`
insert into public.media_sessions(
  id,
  media_room_id,
  provider_code,
  provider_session_reference,
  started_at,
  provider_state
)
values (
  ${u(60)},
  ${u(50)},
  'p1008_validation',
  'session-0001',
  statement_timestamp(),
  'connected'
);`);

  check(
    "Media Session is subordinate to its logical Media Room",
    `exists (
      select 1
      from public.media_sessions
      where id=${u(60)}
        and media_room_id=${u(50)}
        and provider_code='p1008_validation'
        and provider_session_reference='session-0001'
        and started_at is not null
        and provider_state='connected'
    )`,
    "relationships",
  );

  denied(
    "Media Session rejects duplicate provider identity",
    `insert into public.media_sessions(
       id,
       media_room_id,
       provider_code,
       provider_session_reference,
       provider_state
     )
     values (
       ${u(61)},
       ${u(50)},
       'p1008_validation',
       'session-0001',
       'connected'
     )`,
    "23505",
    "relationships",
  );

  add(`
insert into public.session_participation_records(
  id,
  media_session_id,
  participant_user_id,
  joined_at,
  observed_participation,
  provider_observation_reference
)
values
  (
    ${u(70)},
    ${u(60)},
    ${u(1)},
    statement_timestamp(),
    '{}'::jsonb,
    'client-observation-0001'
  ),
  (
    ${u(71)},
    ${u(60)},
    ${u(2)},
    statement_timestamp(),
    '{}'::jsonb,
    'attorney-observation-0001'
  );`);

  check(
    "Participation evidence records canonical Consultation participants",
    `(select count(*)
      from public.session_participation_records
      where media_session_id=${u(60)}
        and participant_user_id in (${u(1)}, ${u(2)}))=2`,
    "relationships",
  );

  denied(
    "Participation rejects unrelated Consultation user",
    `insert into public.session_participation_records(
       id,
       media_session_id,
       participant_user_id,
       joined_at,
       observed_participation,
       provider_observation_reference
     )
     values (
       ${u(72)},
       ${u(60)},
       ${u(20)},
       statement_timestamp(),
       '{}'::jsonb,
       'unrelated-observation-0001'
     )`,
    "23514",
    "relationships",
  );

  denied(
    "Participation evidence rejects UPDATE by service_role",
    `update public.session_participation_records
     set left_at=statement_timestamp()
     where id=${u(70)}`,
    "42501",
    "privileges",
  );

  denied(
    "Participation evidence rejects DELETE by service_role",
    `delete from public.session_participation_records
     where id=${u(70)}`,
    "42501",
    "privileges",
  );

  add(`
update public.media_sessions
set
  provider_state='ended',
  ended_at=statement_timestamp()
where id=${u(60)};`);

  check(
    "Provider session state does not mutate canonical Consultation or Engagement state",
    `(select state='validation_fixture'
       and ended_at is null
       and outcome_code is null
      from public.consultations
      where id=${u(30)})
     and
     (select count(*)
      from public.engagements
      where consultation_id=${u(30)}
        and effective_at is not null
        and ended_at is null)=1`,
    "boundaries",
  );

  add("RESET ROLE;");
  add("SET LOCAL ROLE authenticated;");

  add(
    `select pg_catalog.set_config(
      'request.jwt.claim.sub',
      ${q(id(101))},
      true
    );`,
  );

  check(
    "Client can read own P1-008 Consultation graph",
    `(select count(*) from public.consultations)=2
     and (select count(*) from public.engagements)=3
     and (select count(*) from public.media_rooms)=1
     and (select count(*) from public.media_sessions)=1
     and
     (select count(*)
      from public.session_participation_records)=2`,
    "rls",
  );

  add(
    `select pg_catalog.set_config(
      'request.jwt.claim.sub',
      ${q(id(102))},
      true
    );`,
  );

  check(
    "Attorney can read own P1-008 Consultation graph",
    `(select count(*) from public.consultations)=2
     and (select count(*) from public.engagements)=3
     and (select count(*) from public.media_rooms)=1
     and (select count(*) from public.media_sessions)=1
     and
     (select count(*)
      from public.session_participation_records)=2`,
    "rls",
  );

  add(
    `select pg_catalog.set_config(
      'request.jwt.claim.sub',
      ${q(id(103))},
      true
    );`,
  );

  check(
    "Unrelated authenticated user cannot read P1-008 Consultation graph",
    `(select count(*) from public.consultations)=0
     and (select count(*) from public.engagements)=0
     and (select count(*) from public.media_rooms)=0
     and (select count(*) from public.media_sessions)=0
     and
     (select count(*)
      from public.session_participation_records)=0`,
    "rls",
  );

  add("RESET ROLE;");

  check(
    "rollback fixture target-row counts are bounded",
    `(select count(*) from public.consultations)=2
     and (select count(*) from public.engagements)=3
     and (select count(*) from public.media_rooms)=1
     and (select count(*) from public.media_sessions)=1
     and
     (select count(*)
      from public.session_participation_records)=2
     and (select count(*) from public.bookings)=1`,
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
    throw new Error("P1-008 rollback generator requires an output path");
  }

  writeFileSync(outputPath, buildRollbackValidation().sql, "utf8");
}
