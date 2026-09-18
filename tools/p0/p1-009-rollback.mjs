// Generates rollback-only P1-009 validation SQL.
// This module never connects to a database and never executes generated SQL.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readMigrationSql, tables } from "./lib/p1-009-contract-data.mjs";

const q = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const id = (n) => `00900000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const u = (n) => `${q(id(n))}::uuid`;

export function buildRollbackValidation() {
  const migrationSql = readMigrationSql();
  const statements = [
    "BEGIN;",
    "SET LOCAL statement_timeout = '90s';",
    "SET LOCAL lock_timeout = '5s';",
    migrationSql,
    "SET CONSTRAINTS ALL IMMEDIATE;",
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
    "all eight P1-009 relations exist with RLS enabled",
    `(select count(*)
      from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public'
        and c.relname in (${tables.map(q).join(",")})
        and c.relkind='r'
        and c.relrowsecurity)=8`,
  );

  check(
    "all fourteen concrete P1-009 foreign keys are RESTRICT/RESTRICT",
    `(select count(*)
      from pg_constraint c
      join pg_class t on t.oid=c.conrelid
      join pg_namespace n on n.oid=t.relnamespace
      where n.nspname='public'
        and t.relname in (
          'resources','documents','voice_memos',
          'resource_sharing_grants','messages',
          'notifications','notification_attempts'
        )
        and c.contype='f'
        and c.confupdtype='r'
        and c.confdeltype='r')=14`,
  );

  check(
    "authenticated cannot read raw Storage locator columns",
    `not has_column_privilege(
       'authenticated','public.resources','storage_bucket','SELECT'
     )
     and not has_column_privilege(
       'authenticated','public.resources','storage_object_path','SELECT'
     )
     and has_column_privilege(
       'authenticated','public.resources','id','SELECT'
     )`,
    "security",
  );

  check(
    "service_role receives no P1-009 DELETE privilege",
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
    (${u(102)}),
    (${u(103)}),
    (${u(104)});`);

  add(`
insert into public.users(id, auth_user_id, account_state)
values
  (${u(1)}, ${u(101)}, 'active'),
  (${u(2)}, ${u(102)}, 'active'),
  (${u(20)}, ${u(103)}, 'active'),
  (${u(21)}, ${u(104)}, 'active');`);

  add(`
insert into public.client_profiles(id, user_id)
values
  (${u(3)}, ${u(1)}),
  (${u(23)}, ${u(21)});`);

  add(`
insert into public.intakes(id, client_id, state)
values (${u(4)}, ${u(3)}, 'active');`);

  add(`
insert into public.jurisdictions(id, code, name, region_type)
values (${u(5)}, 'P1009_TEST', 'P1-009 Test', 'state');`);

  add(`
insert into public.attorney_profiles(id, user_id, profile_state)
values (${u(6)}, ${u(2)}, 'approved');`);

  add(`
insert into public.policy_types(code, name)
values ('p1009_validation', 'P1-009 validation');`);

  add(`
insert into public.policy_versions(
  id,
  policy_type_code,
  version_label,
  parameters
)
values (
  ${u(8)},
  'p1009_validation',
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
values (
  ${u(9)},
  ${u(4)},
  ${u(6)},
  ${u(5)},
  1,
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
  state,
  accepted_at
)
values (
  ${u(11)},
  ${u(4)},
  ${u(3)},
  ${u(6)},
  ${u(9)},
  'instant',
  ${u(8)},
  'video',
  'accepted',
  statement_timestamp()
);`);

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
  'instant',
  ${u(8)},
  'video',
  'validation_fixture'
);`);

  add(`
insert into public.resources(
  id, resource_kind, owner_user_id, intake_id, consultation_id,
  storage_bucket, storage_object_path, mime_type, byte_size,
  content_digest, visibility_state, retention_state
)
values
  (
    ${u(40)}, 'validation_generic', ${u(1)}, ${u(4)}, null,
    'validation', 'resources/009040/original', 'audio/webm', 100,
    'digest-40', 'visible', 'retain'
  ),
  (
    ${u(43)}, 'validation_generic', ${u(1)}, null, ${u(30)},
    'validation', 'resources/009043/original', 'application/pdf', 200,
    'digest-43', 'visible', 'retain'
  ),
  (
    ${u(44)}, 'validation_generic', ${u(1)}, null, ${u(30)},
    'validation', 'resources/009044/original', 'application/pdf', 300,
    'digest-44', 'visible', 'retain'
  ),
  (
    ${u(45)}, 'validation_generic', ${u(2)}, null, ${u(30)},
    'validation', 'resources/009045/original', 'application/pdf', 400,
    'digest-45', 'visible', 'retain'
  ),
  (
    ${u(46)}, 'validation_generic', ${u(2)}, ${u(4)}, null,
    'validation', 'resources/009046/original', 'application/pdf', 500,
    'digest-46', 'visible', 'retain'
  );`);

  add(`
insert into public.documents(id, resource_id, document_type, version_label)
values
  (${u(47)}, ${u(43)}, 'validation', 'v1'),
  (${u(48)}, ${u(44)}, 'validation', 'v1');`);

  add(`
insert into public.voice_memos(
  id, resource_id, intake_id, duration_seconds
)
values (${u(42)}, ${u(40)}, ${u(4)}, 30);`);

  add(`
insert into public.resource_sharing_grants(
  id, resource_id, recipient_user_id,
  context_type, context_id, purpose_code,
  granted_at, expires_at, granted_by_user_id
)
values (
  ${u(50)}, ${u(44)}, ${u(2)},
  'validation_context', ${u(30)}, 'consultation_access',
  statement_timestamp() - interval '1 minute',
  statement_timestamp() + interval '1 hour',
  ${u(1)}
);`);

  add(`
insert into public.messages(
  id, consultation_id, sender_user_id, recipient_user_id,
  body, sent_at, visibility_state
)
values (
  ${u(51)}, ${u(30)}, ${u(1)}, ${u(2)},
  'validation message', statement_timestamp(), 'visible'
);`);

  add(`
insert into public.notifications(
  id, recipient_user_id, notification_type,
  source_event_type, source_event_id,
  channel, state
)
values (
  ${u(52)}, ${u(1)}, 'validation',
  'validation_event', ${u(30)},
  'email', 'pending'
);`);

  add(`
insert into public.notification_attempts(
  id, notification_id, provider_code, provider_reference,
  attempted_at, result
)
values (
  ${u(53)}, ${u(52)}, 'validation_provider', 'attempt-53',
  statement_timestamp(), 'accepted'
);`);

  add(`
insert into public.operational_jobs(
  id, job_type, subject_type, subject_id,
  state, available_at, max_attempts
)
values (
  ${u(54)}, 'validation_job', 'notification', ${u(52)},
  'pending', statement_timestamp(), 3
);`);

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
    "Client can read owned and own-Intake Resource metadata",
    `(select count(id) from public.resources)=4
     and (select count(*) from public.documents)=2
     and (select count(*) from public.voice_memos)=1
     and (select count(*) from public.resource_sharing_grants)=1
     and (select count(*) from public.messages)=1
     and (select count(*) from public.notifications)=1`,
    "rls",
  );

  denied(
    "Client cannot select raw Storage bucket",
    "select storage_bucket from public.resources limit 1",
    "42501",
    "security",
  );

  add(
    `select pg_catalog.set_config(
      'request.jwt.claim.sub',
      ${q(id(102))},
      true
    );`,
  );

  check(
    "Attorney sees own Resources plus explicitly shared client Resource only",
    `(select count(id) from public.resources)=3
     and (select count(*) from public.documents)=1
     and (select count(*) from public.voice_memos)=0
     and (select count(*) from public.resource_sharing_grants)=1
     and (select count(*) from public.messages)=1
     and (select count(*) from public.notifications)=0`,
    "rls",
  );

  check(
    "Consultation association alone does not disclose unshared client Resource",
    `not exists (
      select 1
      from public.resources
      where id=${u(43)}
    )
    and exists (
      select 1
      from public.resources
      where id=${u(44)}
    )`,
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
    "Unrelated authenticated user sees no protected P1-009 graph",
    `(select count(id) from public.resources)=0
     and (select count(*) from public.documents)=0
     and (select count(*) from public.voice_memos)=0
     and (select count(*) from public.resource_sharing_grants)=0
     and (select count(*) from public.messages)=0
     and (select count(*) from public.notifications)=0`,
    "rls",
  );

  add("RESET ROLE;");
  add("SET LOCAL ROLE service_role;");

  denied(
    "duplicate physical Resource identity is rejected",
    `insert into public.resources(
       id, resource_kind, owner_user_id,
       storage_bucket, storage_object_path,
       visibility_state, retention_state
     )
     values (
       ${u(60)}, 'validation_generic', ${u(1)},
       'validation', 'resources/009040/original',
       'visible', 'retain'
     )`,
    "23505",
    "identity",
  );

  denied(
    "simultaneously-authorizing duplicate Sharing Grant is rejected",
    `insert into public.resource_sharing_grants(
       id, resource_id, recipient_user_id,
       context_type, context_id, purpose_code,
       granted_at, expires_at, granted_by_user_id
     )
     values (
       ${u(61)}, ${u(44)}, ${u(2)},
       'validation_context', ${u(30)}, 'consultation_access',
       statement_timestamp(),
       statement_timestamp() + interval '2 hours',
       ${u(1)}
     )`,
    "23P01",
    "sharing",
  );

  add(`
insert into public.resource_sharing_grants(
  id, resource_id, recipient_user_id,
  context_type, context_id, purpose_code,
  granted_at, expires_at, granted_by_user_id
)
values (
  ${u(62)}, ${u(44)}, ${u(2)},
  'validation_context', ${u(30)}, 'consultation_access',
  statement_timestamp() + interval '2 hours',
  statement_timestamp() + interval '3 hours',
  ${u(1)}
);`);

  add(`
insert into public.resources(
  id, resource_kind, owner_user_id, intake_id,
  storage_bucket, storage_object_path,
  visibility_state, retention_state
)
values (
  ${u(63)}, 'validation_generic', ${u(20)}, ${u(4)},
  'validation', 'resources/009063/original',
  'visible', 'retain'
);`);

  denied(
    "Voice Memo rejects Resource owner inconsistent with Intake Client",
    `insert into public.voice_memos(
       id, resource_id, intake_id, duration_seconds
     )
     values (${u(64)}, ${u(63)}, ${u(4)}, 10)`,
    "23514",
    "voice_memo",
  );

  add(`
insert into public.resources(
  id, resource_kind, owner_user_id,
  storage_bucket, storage_object_path,
  visibility_state, retention_state
)
values (
  ${u(65)}, 'validation_generic', ${u(1)},
  'validation', 'resources/009065/original',
  'visible', 'retain'
);`);

  denied(
    "Voice Memo rejects missing Resource Intake identity",
    `insert into public.voice_memos(
       id, resource_id, intake_id, duration_seconds
     )
     values (${u(66)}, ${u(65)}, ${u(4)}, 10)`,
    "23514",
    "voice_memo",
  );

  denied(
    "Message rejects unrelated participant",
    `insert into public.messages(
       id, consultation_id, sender_user_id, recipient_user_id,
       body, sent_at, visibility_state
     )
     values (
       ${u(67)}, ${u(30)}, ${u(20)}, ${u(2)},
       'invalid', statement_timestamp(), 'visible'
     )`,
    "23514",
    "messages",
  );

  denied(
    "pre-Consultation/open-inbox Message cannot exist",
    `insert into public.messages(
       id, consultation_id, sender_user_id, recipient_user_id,
       body, sent_at, visibility_state
     )
     values (
       ${u(68)}, ${u(69)}, ${u(1)}, ${u(2)},
       'invalid', statement_timestamp(), 'visible'
     )`,
    "23503",
    "messages",
  );

  denied(
    "sent Message content UPDATE is denied to service_role",
    `update public.messages
     set body='rewritten'
     where id=${u(51)}`,
    "42501",
    "privileges",
  );

  add(`
update public.resource_sharing_grants
set revoked_at=statement_timestamp()
where id=${u(50)};`);

  denied(
    "Sharing Grant revocation cannot be cleared",
    `update public.resource_sharing_grants
     set revoked_at=null
     where id=${u(50)}`,
    "23514",
    "sharing",
  );

  add("RESET ROLE;");

  denied(
    "Resource owner change cannot contradict existing Voice Memo",
    `update public.resources
     set owner_user_id=${u(20)}
     where id=${u(40)}`,
    "23514",
    "voice_memo",
  );

  denied(
    "Intake client change cannot contradict existing Voice Memo",
    `update public.intakes
     set client_id=${u(23)}
     where id=${u(4)}`,
    "23514",
    "voice_memo",
  );

  denied(
    "Client Profile user change cannot contradict existing Voice Memo",
    `update public.client_profiles
     set user_id=${u(20)}
     where id=${u(3)}`,
    "23514",
    "voice_memo",
  );

  add("ROLLBACK;");

  return {
    sql: statements.join("\n\n") + "\n",
    checks,
  };
}

const directExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (directExecution) {
  const outputPath = process.argv[2];

  if (!outputPath) {
    throw new Error("P1-009 rollback generator requires an output path");
  }

  writeFileSync(outputPath, buildRollbackValidation().sql, "utf8");
}
