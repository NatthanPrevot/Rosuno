// Generates rollback-only P1-005 validation SQL. This module never connects to a database.
import { writeFileSync } from "node:fs";
import {
  columns,
  required,
  sql,
  tables,
} from "./tests/p1-005-contract.test.mjs";
import { CATALOG_SQL } from "./lib/catalog-fingerprint.mjs";

const q = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const id = (n) => `00500000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const u = (n) => `${q(id(n))}::uuid`;

export const acceptedP1004Tables = [
  "application_sessions",
  "capability_definitions",
  "capability_grants",
  "jurisdiction_regulatory_modes",
  "jurisdictions",
  "launch_authorizations",
  "launch_gate_evaluations",
  "launch_gates",
  "policy_authority_references",
  "policy_types",
  "policy_versions",
  "regulatory_modes",
  "service_areas",
  "staff_profiles",
  "users",
  "attorney_profiles",
  "licenses",
  "insurance_records",
  "discipline_records",
  "practice_areas",
  "practice_area_authorisations",
  "verification_evidence",
  "eligibility_evaluations",
  "verification_evidence_subjects",
];

const tableCtePattern =
  /target_tables\(schema_name, table_name\) AS \([\s\S]*?\),\ntarget_functions/;

const functionAnchor =
  "VALUES ('public','rls_auto_enable'), ('public','set_updated_at')";

if ((CATALOG_SQL.match(tableCtePattern) || []).length !== 1)
  throw new Error("Unexpected CATALOG_SQL target_tables shape");

if (CATALOG_SQL.split(functionAnchor).length - 1 !== 1)
  throw new Error("Unexpected CATALOG_SQL target_functions shape");

export const acceptedP1004CatalogSql = CATALOG_SQL.replace(
  tableCtePattern,
  `target_tables(schema_name, table_name) AS (VALUES ${acceptedP1004Tables
    .map((table) => `('public',${q(table)})`)
    .join(",")}),
target_functions`,
).replace(
  functionAnchor,
  "VALUES ('public','rls_auto_enable'), ('public','set_updated_at'), ('public','has_manage_attorney_verification_scope')",
);

export const candidateCatalogSql = CATALOG_SQL.replace(
  tableCtePattern,
  `target_tables(schema_name, table_name) AS (VALUES ${tables
    .map((table) => `('public',${q(table)})`)
    .join(",")}),
target_functions`,
).replace(functionAnchor, "VALUES ('public','set_updated_at')");

const baselineRowCounts = acceptedP1004Tables
  .map((table) => `${q(table)},(select count(*) from public.${table})`)
  .join(",");

export const baselineStateSql = `
select jsonb_build_object(
  'migration_history',
    (select coalesce(
      jsonb_agg(jsonb_build_array(version,name) order by version),
      '[]'::jsonb
    ) from supabase_migrations.schema_migrations),

  'public_tables',
    (select coalesce(
      jsonb_agg(tablename order by tablename),
      '[]'::jsonb
    ) from pg_tables where schemaname='public'),

  'public_functions',
    (select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'name',p.proname,
          'args',pg_get_function_identity_arguments(p.oid),
          'return_type',pg_get_function_result(p.oid),
          'owner',pg_get_userbyid(p.proowner),
          'security_definer',p.prosecdef,
          'volatility',p.provolatile,
          'config',p.proconfig,
          'definition',pg_get_functiondef(p.oid),
          'acl',p.proacl
        )
        order by p.proname,pg_get_function_identity_arguments(p.oid)
      ),
      '[]'::jsonb
    )
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'),

  'public_triggers',
    (select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'table_name',c.relname,
          'trigger_name',t.tgname,
          'function_name',p.proname,
          'definition',pg_get_triggerdef(t.oid,true),
          'internal',t.tgisinternal
        )
        order by c.relname,t.tgname
      ),
      '[]'::jsonb
    )
    from pg_trigger t
    join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace
    join pg_proc p on p.oid=t.tgfoid
    where n.nspname='public'),

  'public_policies',
    (select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'table_name',tablename,
          'policy_name',policyname,
          'permissive',permissive,
          'roles',roles,
          'cmd',cmd,
          'qual',qual,
          'with_check',with_check
        )
        order by tablename,policyname
      ),
      '[]'::jsonb
    )
    from pg_policies
    where schemaname='public'),

  'public_rls',
    (select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'table_name',c.relname,
          'rls',c.relrowsecurity,
          'force_rls',c.relforcerowsecurity
        )
        order by c.relname
      ),
      '[]'::jsonb
    )
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r'),

  'public_table_acl',
    (select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'table_name',c.relname,
          'owner',pg_get_userbyid(c.relowner),
          'acl',c.relacl,
          'anon_select',has_table_privilege('anon',c.oid,'SELECT'),
          'anon_insert',has_table_privilege('anon',c.oid,'INSERT'),
          'anon_update',has_table_privilege('anon',c.oid,'UPDATE'),
          'anon_delete',has_table_privilege('anon',c.oid,'DELETE'),
          'authenticated_select',has_table_privilege('authenticated',c.oid,'SELECT'),
          'authenticated_insert',has_table_privilege('authenticated',c.oid,'INSERT'),
          'authenticated_update',has_table_privilege('authenticated',c.oid,'UPDATE'),
          'authenticated_delete',has_table_privilege('authenticated',c.oid,'DELETE'),
          'service_select',has_table_privilege('service_role',c.oid,'SELECT'),
          'service_insert',has_table_privilege('service_role',c.oid,'INSERT'),
          'service_update',has_table_privilege('service_role',c.oid,'UPDATE'),
          'service_delete',has_table_privilege('service_role',c.oid,'DELETE')
        )
        order by c.relname
      ),
      '[]'::jsonb
    )
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r'),

  'public_column_acl',
    (select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'table_name',c.relname,
          'column_name',a.attname,
          'ordinal',a.attnum,
          'acl',a.attacl,
          'anon_update',has_column_privilege('anon',c.oid,a.attname,'UPDATE'),
          'authenticated_update',has_column_privilege('authenticated',c.oid,a.attname,'UPDATE'),
          'service_update',has_column_privilege('service_role',c.oid,a.attname,'UPDATE')
        )
        order by c.relname,a.attnum
      ),
      '[]'::jsonb
    )
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid
    where n.nspname='public'
      and c.relkind='r'
      and a.attnum>0
      and not a.attisdropped),

  'public_schema_acl',
    (select jsonb_build_object(
      'acl',n.nspacl,
      'owner',pg_get_userbyid(n.nspowner),
      'anon_usage',has_schema_privilege('anon','public','USAGE'),
      'authenticated_usage',has_schema_privilege('authenticated','public','USAGE'),
      'service_usage',has_schema_privilege('service_role','public','USAGE'),
      'anon_create',has_schema_privilege('anon','public','CREATE'),
      'authenticated_create',has_schema_privilege('authenticated','public','CREATE'),
      'service_create',has_schema_privilege('service_role','public','CREATE')
    )
    from pg_namespace n where n.nspname='public'),

  'public_row_counts',
    jsonb_build_object(${baselineRowCounts}),

  'candidate_relations',
    (select coalesce(
      jsonb_agg(c.relname order by c.relname),
      '[]'::jsonb
    )
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public'
      and c.relname in (${tables.map(q).join(",")})),

  'fixture_auth_rows',
    (select count(*) from auth.users
     where id in (${[101, 102, 103].map(u).join(",")}))
) as state;
`;

export function buildRollbackValidation() {
  const statements = [
    "BEGIN;",
    "SET LOCAL statement_timeout = '90s';",
    "SET LOCAL lock_timeout = '5s';",
    sql,
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

  const denied = (name, statement, state = "42501", category = "security") => {
    add(
      `DO $deny$ BEGIN BEGIN EXECUTE ${q(
        statement,
      )}; RAISE EXCEPTION 'Expected rejection: %',${q(
        name,
      )}; EXCEPTION WHEN SQLSTATE '${state}' THEN NULL; END; END $deny$;`,
    );
    checks.push({ name, category });
  };

  const owner = () => add("RESET ROLE;");

  const actor = (authNumber) => {
    owner();
    add(
      `SELECT set_config('request.jwt.claim.sub',${q(id(authNumber))},true);`,
    );
    add("SET LOCAL ROLE authenticated;");
  };

  const targetOids = tables
    .map((table) => `${q(`public.${table}`)}::regclass`)
    .join(",");

  const count = (table, predicate = "true") =>
    `(select count(*) from public.${table} where ${predicate})`;

  check(
    "exact four candidate relations",
    `(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname in (${tables
      .map(q)
      .join(",")}))=4`,
  );

  check(
    "all four candidate relations have RLS",
    `(select count(*) from pg_class where oid in (${targetOids}) and relrowsecurity)=4`,
    "rls",
  );

  const expectedColumns = Object.entries(columns).flatMap(
    ([table, definitions]) =>
      definitions.split(" ").map((definition, index) => {
        const [column, type] = definition.split(":");
        const defaultExpression =
          column === "id"
            ? "gen_random_uuid()"
            : ["created_at", "updated_at"].includes(column)
              ? "statement_timestamp()"
              : null;

        return `(${q(table)},${q(column)},${index + 1},${q(
          type.replaceAll("_", " "),
        )},${required[table].split(" ").includes(column)},${
          defaultExpression === null ? "null::text" : q(defaultExpression)
        })`;
      }),
  );

  check(
    "exact candidate columns types nullability defaults order",
    `not exists (
      with expected(t,c,ord,typ,nn,def) as (
        values ${expectedColumns.join(",")}
      ),
      actual as (
        select
          cl.relname::text t,
          a.attname::text c,
          a.attnum ord,
          format_type(a.atttypid,a.atttypmod) typ,
          a.attnotnull nn,
          pg_get_expr(d.adbin,d.adrelid) def
        from pg_class cl
        join pg_attribute a on a.attrelid=cl.oid
        left join pg_attrdef d
          on d.adrelid=cl.oid and d.adnum=a.attnum
        where cl.oid in (${targetOids})
          and a.attnum>0
          and not a.attisdropped
      )
      select 1
      from expected e
      full join actual a using(t,c)
      where e.ord is distinct from a.ord
         or e.typ is distinct from a.typ
         or e.nn is distinct from a.nn
         or e.def is distinct from a.def
    )`,
  );

  check(
    "seven restrictive validated foreign keys",
    `(select count(*) from pg_constraint where conrelid in (${targetOids}) and contype='f')=7
     and not exists(
       select 1 from pg_constraint
       where conrelid in (${targetOids})
         and contype='f'
         and (
           confupdtype<>'r'
           or confdeltype<>'r'
           or condeferrable
           or not convalidated
         )
     )`,
    "constraints",
  );

  check(
    "exact candidate constraint counts",
    `(select count(*) from pg_constraint where conrelid in (${targetOids}) and contype='p')=4
     and (select count(*) from pg_constraint where conrelid in (${targetOids}) and contype='f')=7
     and (select count(*) from pg_constraint where conrelid in (${targetOids}) and contype='u')=1
     and (select count(*) from pg_constraint where conrelid in (${targetOids}) and contype='c')=6`,
    "constraints",
  );

  check(
    "exact four authenticated SELECT policies",
    `(select count(*) from pg_policies
      where schemaname='public'
        and tablename in (${tables.map(q).join(",")})
        and cmd='SELECT'
        and roles=ARRAY['authenticated']::name[])=4`,
    "rls",
  );

  check(
    "candidate tables initially empty",
    `${tables.map((table) => `${count(table)}=0`).join(" and ")}`,
    "data",
  );

  check(
    "no P1-005 capability seed added",
    `(select count(*) from public.capability_definitions)=1
      and (select count(*) from public.capability_definitions
           where capability_code='manage_attorney_verification')=1`,
    "data",
  );

  for (const table of tables) {
    for (const operation of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      check(
        `anon ${table} ${operation}`,
        `not has_table_privilege('anon',${q(
          `public.${table}`,
        )},${q(operation)})`,
        "privileges",
      );

      check(
        `authenticated ${table} ${operation}`,
        `${
          operation === "SELECT" ? "" : "not "
        }has_table_privilege('authenticated',${q(
          `public.${table}`,
        )},${q(operation)})`,
        "privileges",
      );
    }
  }

  for (const operation of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
    check(
      `service client_profiles ${operation}`,
      `${
        ["SELECT", "INSERT", "UPDATE"].includes(operation) ? "" : "not "
      }has_table_privilege('service_role','public.client_profiles',${q(
        operation,
      )})`,
      "privileges",
    );

    check(
      `service intakes ${operation}`,
      `${
        ["SELECT", "INSERT", "UPDATE"].includes(operation) ? "" : "not "
      }has_table_privilege('service_role','public.intakes',${q(operation)})`,
      "privileges",
    );

    for (const table of ["ai_suggestions", "jurisdiction_assessments"]) {
      check(
        `service ${table} ${operation}`,
        `${
          ["SELECT", "INSERT"].includes(operation) ? "" : "not "
        }has_table_privilege('service_role',${q(
          `public.${table}`,
        )},${q(operation)})`,
        "privileges",
      );
    }
  }

  const allowedAiUpdates = new Set([
    "presented_at",
    "confirmed_at",
    "confirmed_by_user_id",
    "rejected_at",
  ]);

  const allowedAssessmentUpdates = new Set([
    "review_status",
    "reviewed_at",
    "reviewed_by_user_id",
  ]);

  for (const definition of columns.ai_suggestions.split(" ")) {
    const column = definition.split(":")[0];
    check(
      `service ai_suggestions update ${column}`,
      `${
        allowedAiUpdates.has(column) ? "" : "not "
      }has_column_privilege('service_role','public.ai_suggestions',${q(
        column,
      )},'UPDATE')`,
      "privileges",
    );
  }

  for (const definition of columns.jurisdiction_assessments.split(" ")) {
    const column = definition.split(":")[0];
    check(
      `service jurisdiction_assessments update ${column}`,
      `${
        allowedAssessmentUpdates.has(column) ? "" : "not "
      }has_column_privilege('service_role','public.jurisdiction_assessments',${q(
        column,
      )},'UPDATE')`,
      "privileges",
    );
  }

  for (const n of [101, 102, 103]) {
    add(`insert into auth.users(id) values(${u(n)});`);
  }

  for (const [userId, authId] of [
    [1, 101],
    [2, 102],
    [3, 103],
  ]) {
    add(
      `insert into public.users(id,auth_user_id,account_state)
       values(${u(userId)},${u(authId)},'active');`,
    );
  }

  add(
    `insert into public.attorney_profiles(id,user_id,profile_state)
     values(${u(71)},${u(3)},'approved');`,
  );

  add(
    `insert into public.jurisdictions(id,code,name,region_type)
     values
       (${u(11)},'P1005_TEST_A','Disposable A','test'),
       (${u(12)},'P1005_TEST_B','Disposable B','test');`,
  );

  add(
    `insert into public.client_profiles(id,user_id)
     values
       (${u(21)},${u(1)}),
       (${u(22)},${u(2)});`,
  );

  add(
    `insert into public.intakes(id,client_id,matter_reference,state)
     values
       (${u(31)},${u(21)},'matter-a','draft'),
       (${u(32)},${u(22)},'matter-b','active');`,
  );

  add(
    `insert into public.ai_suggestions(
       id,context_type,context_id,suggestion_type,suggestion_value,generated_at
     )
     values
       (${u(41)},'intake',${u(31)},'routing','{}',statement_timestamp()),
       (${u(42)},'jurisdiction_assessment',${u(51)},'routing','{}',statement_timestamp()),
       (${u(43)},'future_domain',${u(31)},'routing','{}',statement_timestamp());`,
  );

  add(
    `insert into public.jurisdiction_assessments(
       id,intake_id,jurisdiction_id,assessment_basis,source_type,ai_suggestion_id
     )
     values
       (${u(51)},${u(31)},${u(11)},'basis-a','human',${u(42)}),
       (${u(52)},${u(32)},${u(12)},'basis-b','human',null);`,
  );

  actor(101);

  check(
    "client one sees only own profile",
    `${count("client_profiles")}=1 and ${count(
      "client_profiles",
      `id=${u(22)}`,
    )}=0`,
    "rls",
  );

  check(
    "client one sees only own intake",
    `${count("intakes")}=1 and ${count("intakes", `id=${u(32)}`)}=0`,
    "rls",
  );

  check(
    "client one sees only own assessment",
    `${count("jurisdiction_assessments")}=1 and ${count(
      "jurisdiction_assessments",
      `id=${u(52)}`,
    )}=0`,
    "rls",
  );

  check(
    "client one sees recognized AI contexts and future context fails closed",
    `${count("ai_suggestions")}=2 and ${count(
      "ai_suggestions",
      `id=${u(43)}`,
    )}=0`,
    "rls",
  );

  denied(
    "authenticated intake write denied",
    `update public.intakes set state='closed' where id=${u(31)}`,
  );

  actor(103);

  for (const table of tables) {
    check(
      `attorney status alone grants no ${table} access`,
      `${count(table)}=0`,
      "rls",
    );
  }

  owner();
  add("SET LOCAL ROLE service_role;");

  add(
    `update public.ai_suggestions
     set presented_at=statement_timestamp()
     where id=${u(41)};`,
  );

  denied(
    "service cannot rewrite AI core suggestion type",
    `update public.ai_suggestions set suggestion_type='rewritten' where id=${u(
      41,
    )}`,
  );

  add(
    `update public.jurisdiction_assessments
     set review_status='reviewed',
         reviewed_at=statement_timestamp(),
         reviewed_by_user_id=${u(1)}
     where id=${u(51)};`,
  );

  denied(
    "service cannot rewrite assessment jurisdiction",
    `update public.jurisdiction_assessments set jurisdiction_id=${u(
      12,
    )} where id=${u(51)}`,
  );

  denied(
    "service cannot delete intake history",
    `delete from public.intakes where id=${u(31)}`,
  );

  add(
    `update public.ai_suggestions
     set confirmed_at=statement_timestamp(),
         confirmed_by_user_id=${u(1)}
     where id=${u(41)};`,
  );

  owner();

  check(
    "AI confirmation does not change authoritative intake state",
    `${count("intakes", `id=${u(31)} and state='draft'`)}=1`,
    "history",
  );

  check(
    "assessment core provenance remains intact",
    `${count(
      "jurisdiction_assessments",
      `id=${u(51)} and intake_id=${u(31)} and jurisdiction_id=${u(
        11,
      )} and assessment_basis='basis-a' and source_type='human'`,
    )}=1`,
    "history",
  );

  check(
    "intake and assessment rows remain preserved",
    `${count("intakes")}=2 and ${count("jurisdiction_assessments")}=2`,
    "history",
  );

  add(
    "-- Candidate catalog rows for deterministic canonicalization by the caller.",
  );
  add(candidateCatalogSql);

  add(
    `select jsonb_build_object(
       'passed',true,
       'check_count',${checks.length},
       'candidate_tables',${tables.length}
     ) as rosuno_p1005_result;`,
  );

  add("ROLLBACK;");

  return {
    sql: `${statements.join("\n\n")}\n`,
    checks,
    baselineStateSql,
    acceptedP1004CatalogSql,
    candidateCatalogSql,
  };
}

if (process.argv[2]) {
  writeFileSync(process.argv[2], buildRollbackValidation().sql);
}
