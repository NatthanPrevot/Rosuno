// Generates a rollback-only validation batch; never connects to a database.
import { writeFileSync } from "node:fs";
import {
  columns,
  readMigrationSql,
  required,
  tables,
} from "./lib/p1-004-contract-data.mjs";
import { CATALOG_SQL } from "./lib/catalog-fingerprint.mjs";
const q = (s) => "'" + String(s).replaceAll("'", "''") + "'";
const id = (n) => `00400000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const u = (n) => `${q(id(n))}::uuid`;
export const foundationTables = [
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
];
export const baselineCatalogSql = CATALOG_SQL.replace(
  "    ('public','users'),\n    ('public','client_profiles'),\n    ('public','attorney_profiles'),\n",
  "",
);
export const candidateCatalogSql = CATALOG_SQL.replace(
  /target_tables\(schema_name, table_name\) AS \([\s\S]*?\),\ntarget_functions/,
  `target_tables(schema_name, table_name) AS (VALUES ${tables.map((t) => `('public',${q(t)})`).join(",")}),\ntarget_functions`,
).replace(
  "VALUES ('public','rls_auto_enable'), ('public','set_updated_at')",
  "VALUES ('public','has_manage_attorney_verification_scope')",
);
export const baselineStateSql = `select jsonb_build_object(
'migration_history',(select jsonb_agg(jsonb_build_array(version,name) order by version) from supabase_migrations.schema_migrations),
'public_tables',(select jsonb_agg(tablename order by tablename) from pg_tables where schemaname='public'),
'public_function_count',(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'),
'public_row_counts',jsonb_build_object(${foundationTables.map((t) => `${q(t)},(select count(*) from public.${t})`).join(",")}),
'candidate_relations',(select coalesce(jsonb_agg(c.relname order by c.relname),'[]'::jsonb) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (${tables.map(q).join(",")})),
'candidate_helper_present',to_regprocedure('public.has_manage_attorney_verification_scope(uuid,boolean)') is not null,
'candidate_seed_count',(select count(*) from public.capability_definitions where capability_code='manage_attorney_verification'),
'fixture_auth_rows',(select count(*) from auth.users where id in (${[101, 102, 103, 104].map(u).join(",")})),
'columns',(select count(*) from information_schema.columns where table_schema='public'),
'policies',(select count(*) from pg_policies where schemaname='public'),
'rls_enabled_count',(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity),
'triggers',(select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal)) as state;`;
export function buildRollbackValidation() {
  const sql = readMigrationSql();

  const statements = [
    "BEGIN;",
    "SET LOCAL statement_timeout = '90s';",
    "SET LOCAL lock_timeout = '5s';",
    sql,
  ];
  const checks = Object.fromEntries(
    [
      "structure",
      "constraints",
      "rls",
      "service_privileges",
      "capability_helper",
      "corrections",
      "historical_independence",
    ].map((k) => [k, []]),
  );
  const add = (s) => statements.push(s);
  const check = (name, expr, category = "structure") => {
    add(
      `DO $assert$ BEGIN IF (${expr}) IS DISTINCT FROM TRUE THEN RAISE EXCEPTION ${q(name)}; END IF; END $assert$;`,
    );
    checks[category].push({ name, passed: true });
  };
  const denied = (name, stmt, state = "42501", category = "rls") => {
    add(
      `DO $deny$ BEGIN BEGIN EXECUTE ${q(stmt)}; RAISE EXCEPTION 'Expected rejection: %',${q(name)}; EXCEPTION WHEN SQLSTATE '${state}' THEN NULL; END; END $deny$;`,
    );
    checks[category].push({ name, passed: true });
  };
  const owner = () => add("RESET ROLE;");
  const actor = (n) => {
    owner();
    add(`SELECT set_config('request.jwt.claim.sub',${q(id(n + 100))},true);`);
    add("SET LOCAL ROLE authenticated;");
  };
  const helper = (jur, any = false) =>
    `public.has_manage_attorney_verification_scope(${jur === null ? "null" : u(jur)},${any})`;
  const count = (t, p = "true") =>
    `(select count(*) from public.${t} where ${p})`;
  const targetOids = tables
    .map((t) => `${q("public." + t)}::regclass`)
    .join(",");
  check(
    "exact public table inventory",
    `(select array_agg(tablename::text order by tablename) from pg_tables where schemaname='public')=ARRAY[${[...foundationTables, ...tables].sort().map(q).join(",")}]::text[]`,
  );
  check(
    "all nine RLS enabled",
    `(select count(*) from pg_class where oid in (${targetOids}) and relrowsecurity)=9`,
  );
  const expected = Object.entries(columns).flatMap(([t, defs]) =>
    defs.split(" ").map((d, i) => {
      const [c, typ] = d.split(":");
      const def =
        c === "id"
          ? "gen_random_uuid()"
          : ["created_at", "updated_at"].includes(c)
            ? "statement_timestamp()"
            : t === "verification_evidence" && c === "discrepancy_flag"
              ? "false"
              : null;
      return `(${q(t)},${q(c)},${i + 1},${q(typ.replaceAll("_", " "))},${required[t].split(" ").includes(c)},${def === null ? "null::text" : q(def)})`;
    }),
  );
  check(
    "exact columns types nullability defaults order",
    `not exists (with expected(t,c,ord,typ,nn,def) as(values ${expected.join(",")}),actual as(select cl.relname::text t,a.attname::text c,a.attnum ord,format_type(a.atttypid,a.atttypmod) typ,a.attnotnull nn,pg_get_expr(d.adbin,d.adrelid) def from pg_class cl join pg_attribute a on a.attrelid=cl.oid left join pg_attrdef d on d.adrelid=cl.oid and d.adnum=a.attnum where cl.oid in (${targetOids}) and a.attnum>0 and not a.attisdropped) select 1 from expected e full join actual a using(t,c) where e.ord is distinct from a.ord or e.typ is distinct from a.typ or e.nn is distinct from a.nn or e.def is distinct from a.def)`,
  );
  check(
    "restrictive validated foreign keys",
    `not exists(select 1 from pg_constraint where conrelid in (${targetOids}) and contype='f' and (confupdtype<>'r' or confdeltype<>'r' or condeferrable or not convalidated))`,
  );
  for (const [kind, expectedCount] of [
    ["p", 9],
    ["f", 20],
    ["u", 4],
    ["c", 16],
  ]) {
    check(
      `exact constraint count ${kind}`,
      `(select count(*) from pg_constraint where conrelid in (${targetOids}) and contype=${q(kind)})=${expectedCount}`,
    );
  }
  check(
    "nine select-only authenticated policies",
    `(select count(*) from pg_policies where schemaname='public' and tablename in (${tables.map(q).join(",")}) and cmd='SELECT' and roles=ARRAY['authenticated']::name[])=9`,
  );
  check(
    "helper owner security stability search path boolean signature",
    `(select prosecdef and provolatile='s' and prorettype='boolean'::regtype and proargtypes='2950 16'::oidvector and proconfig=ARRAY['search_path=pg_catalog']::text[] and pg_get_userbyid(proowner) not in ('anon','authenticated','service_role') from pg_proc where oid='public.has_manage_attorney_verification_scope(uuid,boolean)'::regprocedure)`,
    "capability_helper",
  );
  check(
    "helper no mutation or dynamic SQL",
    `(select prosrc !~* '\\m(insert|update|delete|execute|set_config|call)\\M' from pg_proc where oid='public.has_manage_attorney_verification_scope(uuid,boolean)'::regprocedure)`,
    "capability_helper",
  );
  for (const role of ["anon", "authenticated", "service_role"])
    check(
      `helper execute ${role}`,
      `${role === "authenticated" ? "" : "not "}has_function_privilege(${q(role)},'public.has_manage_attorney_verification_scope(uuid,boolean)','EXECUTE')`,
      "capability_helper",
    );
  check(
    "authenticated grant table remains inaccessible",
    "not has_table_privilege('authenticated','public.capability_grants','SELECT')",
    "capability_helper",
  );
  check(
    "one permanent capability seed only",
    `${count("capability_definitions")}=1 and ${count("capability_definitions", "capability_code='manage_attorney_verification'")}=1`,
  );
  for (const t of tables)
    for (const op of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      check(
        `anon ${t} ${op}`,
        `not has_table_privilege('anon',${q("public." + t)},${q(op)})`,
        "service_privileges",
      );
      check(
        `authenticated ${t} ${op}`,
        `${op === "SELECT" ? "" : "not "}has_table_privilege('authenticated',${q("public." + t)},${q(op)})`,
        "service_privileges",
      );
      const allow =
        ["SELECT", "INSERT"].includes(op) ||
        (op === "UPDATE" && tables.slice(0, 6).includes(t)) ||
        (op === "DELETE" && t === "verification_evidence_subjects");
      check(
        `service ${t} ${op}`,
        `${allow ? "" : "not "}has_table_privilege('service_role',${q("public." + t)},${q(op)})`,
        "service_privileges",
      );
    }
  for (const col of columns.verification_evidence_subjects
    .split(" ")
    .map((s) => s.split(":")[0]))
    check(
      `service subject update ${col}`,
      `${["license_id", "insurance_record_id", "discipline_record_id", "practice_area_authorisation_id"].includes(col) ? "" : "not "}has_column_privilege('service_role','public.verification_evidence_subjects',${q(col)},'UPDATE')`,
      "service_privileges",
    );
  for (let n = 1; n <= 4; n++) {
    add(`insert into auth.users(id) values(${u(n + 100)});`);
    add(
      `insert into public.users(id,auth_user_id,account_state) values(${u(n)},${u(n + 100)},'active');`,
    );
  }
  add(
    `insert into public.staff_profiles(user_id,staff_state) values(${u(4)},'active');`,
  );
  add(
    `insert into public.jurisdictions(id,code,name,region_type) values(${u(11)},'P1_TEST_A','Disposable A','test'),(${u(12)},'P1_TEST_B','Disposable B','test');`,
  );
  add(
    `insert into public.attorney_profiles(id,user_id,profile_state) values(${u(21)},${u(1)},'approved'),(${u(22)},${u(2)},'applicant');`,
  );
  add(
    `insert into public.practice_areas(id,code,name,active) values(${u(31)},'test_active','Disposable active',true),(${u(32)},'test_inactive','Disposable inactive',false);`,
  );
  add(
    `insert into public.licenses(id,attorney_id,jurisdiction_id,license_number) values(${u(41)},${u(21)},${u(11)},'A1'),(${u(42)},${u(21)},${u(12)},'A2'),(${u(43)},${u(22)},${u(11)},'B1'),(${u(44)},${u(21)},${u(11)},'A3');`,
  );
  add(
    `insert into public.insurance_records(id,attorney_id,jurisdiction_id) values(${u(51)},${u(21)},${u(11)}),(${u(52)},${u(21)},null);`,
  );
  add(
    `insert into public.discipline_records(id,attorney_id,jurisdiction_id) values(${u(61)},${u(21)},${u(12)});`,
  );
  add(
    `insert into public.practice_area_authorisations(id,attorney_id,jurisdiction_id,practice_area_id,status,requested_at) values(${u(71)},${u(21)},${u(12)},${u(31)},'open_vocabulary',statement_timestamp());`,
  );
  add(
    `insert into public.verification_evidence(id,jurisdiction_id,retrieved_at,evidence_digest,source_reference,verification_method) values(${u(81)},${u(11)},statement_timestamp(),'digest E1','source E1','method E1'),(${u(82)},${u(12)},statement_timestamp(),'digest E2','source E2','method E2'),(${u(83)},null,statement_timestamp(),'digest E3','source E3','method E3');`,
  );
  for (const [n, e, c, s] of [
    [91, 81, "license_id", 41],
    [92, 82, "license_id", 41],
    [93, 81, "license_id", 42],
    [94, 81, "insurance_record_id", 52],
    [95, 81, "discipline_record_id", 61],
    [96, 81, "practice_area_authorisation_id", 71],
    [97, 83, "license_id", 41],
  ])
    add(
      `insert into public.verification_evidence_subjects(id,verification_evidence_id,${c}) values(${u(n)},${u(e)},${u(s)});`,
    );
  add(
    `insert into public.eligibility_evaluations(id,attorney_id,jurisdiction_id,context_type,evaluated_at,policy_references,result,factor_results,evidence_references,as_of) values(${u(201)},${u(21)},${u(11)},'test_decision',statement_timestamp(),'[]','test_result','{}',jsonb_build_object('verification_evidence_ids',jsonb_build_array(${u(81)}),'license_ids',jsonb_build_array(${u(41)})),statement_timestamp());`,
  );
  add("SET LOCAL ROLE anon;");
  for (const t of tables)
    for (const stmt of [
      `select * from public.${t}`,
      `insert into public.${t} default values`,
      `update public.${t} set id=id`,
      `delete from public.${t}`,
    ])
      denied(`anon ${stmt}`, stmt);
  denied("anon helper denied", `select ${helper(null)}`);
  actor(3);
  check("client active catalog only", `${count("practice_areas")}=1`, "rls");
  for (const t of tables.filter((t) => t !== "practice_areas"))
    check(`client private ${t}`, `${count(t)}=0`, "rls");
  actor(1);
  for (const [t, n] of [
    ["attorney_profiles", 1],
    ["licenses", 3],
    ["insurance_records", 2],
    ["discipline_records", 1],
    ["practice_area_authorisations", 1],
    ["practice_areas", 1],
  ])
    check(`attorney owns ${t}`, `${count(t)}=${n}`, "rls");
  for (const t of [
    "verification_evidence",
    "verification_evidence_subjects",
    "eligibility_evaluations",
  ])
    check(`attorney private ${t} denied`, `${count(t)}=0`, "rls");
  check(
    "cross-attorney license denied",
    `${count("licenses", `id=${u(43)}`)}=0`,
    "rls",
  );
  for (const t of tables)
    for (const stmt of [
      `insert into public.${t} default values`,
      `update public.${t} set id=id`,
      `delete from public.${t}`,
    ])
      denied(`authenticated ${stmt}`, stmt);
  denied(
    "authenticated cannot read grant rows",
    "select * from public.capability_grants",
  );
  owner();
  add(
    "insert into public.capability_definitions(capability_code) values('other_test_capability');",
  );
  const cases = [
    ["missing", null, false, false, false],
    [
      "wrong_capability",
      { code: "other_test_capability" },
      false,
      false,
      false,
    ],
    ["revoked", { revoked: "statement_timestamp()" }, false, false, false],
    [
      "expired",
      { expires: "statement_timestamp()-interval '1 day'" },
      false,
      false,
      false,
    ],
    [
      "future",
      { granted: "statement_timestamp()+interval '1 day'" },
      false,
      false,
      false,
    ],
    ["resource", { resource: "'{}'::jsonb" }, false, false, false],
    ["matching", {}, true, false, true],
    ["wrong_jurisdiction", { jur: 12 }, false, false, true],
    ["global", { jur: null }, true, true, true],
  ];
  for (const [name, g, match, global, any] of cases) {
    owner();
    add(`delete from public.capability_grants where user_id=${u(4)};`);
    if (g)
      add(
        `insert into public.capability_grants(user_id,capability_code,jurisdiction_id,granted_at,expires_at,revoked_at,resource_scope,granted_by_user_id) values(${u(4)},${q(g.code || "manage_attorney_verification")},${g.jur === null ? "null" : u(g.jur || 11)},${g.granted || "statement_timestamp()-interval '2 days'"},${g.expires || "null"},${g.revoked || "null"},${g.resource || "null"},${u(4)});`,
      );
    actor(4);
    check(
      `${name} matching scope`,
      `${helper(11)}=${match}`,
      "capability_helper",
    );
    check(
      `${name} null global-only`,
      `${helper(null)}=${global}`,
      "capability_helper",
    );
    check(
      `${name} any scope`,
      `${helper(null, true)}=${any}`,
      "capability_helper",
    );
    check(
      `${name} any ignores required jurisdiction`,
      `${helper(999, true)}=${any}`,
      "capability_helper",
    );
    check(
      `${name} profile global-only`,
      `${count("attorney_profiles")}=${global ? 2 : 0}`,
      "rls",
    );
    check(
      `${name} null Insurance global-only`,
      `${count("insurance_records", `id=${u(52)}`)}=${global ? 1 : 0}`,
      "rls",
    );
    check(
      `${name} null Evidence global-only`,
      `${count("verification_evidence", `id=${u(83)}`)}=${global ? 1 : 0}`,
      "rls",
    );
    check(
      `${name} inactive practice area`,
      `${count("practice_areas")}=${any ? 2 : 1}`,
      "rls",
    );
    if (name === "matching") {
      check(
        "matching subject and Evidence readable",
        `${count("verification_evidence_subjects", `id=${u(91)}`)}=1`,
        "rls",
      );
      for (const n of [92, 93, 94, 95, 96, 97])
        check(
          `association ${n} independent scope and Evidence guard`,
          `${count("verification_evidence_subjects", `id=${u(n)}`)}=0`,
          "rls",
        );
    }
    if (any) {
      const second = name === "wrong_jurisdiction";
      for (const [table, expectedCount] of [
        ["licenses", global ? 4 : second ? 1 : 3],
        ["insurance_records", global ? 2 : second ? 0 : 1],
        ["discipline_records", global || second ? 1 : 0],
        ["practice_area_authorisations", global || second ? 1 : 0],
        ["verification_evidence", global ? 3 : 1],
        ["eligibility_evaluations", second ? 0 : 1],
      ])
        check(
          `${name} exact ${table} visibility`,
          `${count(table)}=${expectedCount}`,
          "rls",
        );
      check(
        `${name} correction requires both scopes`,
        `(${helper(11)} and ${helper(12)})=${global}`,
        "capability_helper",
      );
    }
    if (name === "global")
      check(
        "global sees all mismatch and NULL associations",
        `${count("verification_evidence_subjects")}=7`,
        "rls",
      );
    if (!any)
      for (const t of tables.filter((t) => t !== "practice_areas"))
        check(`${name} denied ${t}`, `${count(t)}=0`, "rls");
  }
  actor(3);
  check(
    "caller cannot select another Rosuno User",
    `${count("users", `id=${u(4)}`)}=0`,
    "capability_helper",
  );
  check(
    "cannot borrow another User global grant",
    `not ${helper(11)} and not ${helper(null, true)}`,
    "capability_helper",
  );
  denied(
    "no caller-ID parameter",
    `select public.has_manage_attorney_verification_scope(${u(11)},false,${u(4)})`,
    "42883",
    "capability_helper",
  );
  owner();
  const bad = (name, stmt, state = "23514") =>
    denied(name, stmt, state, "constraints");
  bad(
    "duplicate attorney profile",
    `insert into public.attorney_profiles(user_id,profile_state) values(${u(1)},'applicant')`,
    "23505",
  );
  bad(
    "duplicate license",
    `insert into public.licenses(attorney_id,jurisdiction_id,license_number) values(${u(21)},${u(11)},'A1')`,
    "23505",
  );
  bad(
    "duplicate PAA",
    `insert into public.practice_area_authorisations(attorney_id,jurisdiction_id,practice_area_id,status,requested_at) values(${u(21)},${u(12)},${u(31)},'test',statement_timestamp())`,
    "23505",
  );
  for (const [t, col] of [
    ["attorney_profiles", "user_id"],
    ["licenses", "attorney_id"],
    ["licenses", "jurisdiction_id"],
    ["insurance_records", "attorney_id"],
    ["insurance_records", "jurisdiction_id"],
    ["discipline_records", "attorney_id"],
    ["discipline_records", "jurisdiction_id"],
    ["practice_area_authorisations", "attorney_id"],
    ["practice_area_authorisations", "jurisdiction_id"],
    ["practice_area_authorisations", "practice_area_id"],
    ["practice_area_authorisations", "criteria_policy_version_id"],
    ["verification_evidence", "jurisdiction_id"],
    ["verification_evidence", "retrieved_by_user_id"],
    ["eligibility_evaluations", "attorney_id"],
    ["eligibility_evaluations", "jurisdiction_id"],
    ["verification_evidence_subjects", "verification_evidence_id"],
  ])
    bad(
      `orphan ${t}.${col}`,
      `update public.${t} set ${col}=${u(999)} where id in (select id from public.${t} limit 1)`,
      "23503",
    );
  for (const col of [
    "license_id",
    "insurance_record_id",
    "discipline_record_id",
    "practice_area_authorisation_id",
  ])
    bad(
      `orphan subject ${col}`,
      `insert into public.verification_evidence_subjects(verification_evidence_id,${col}) values(${u(81)},${u(999)})`,
      "23503",
    );
  for (const [name, stmt] of [
    [
      "negative experience",
      "update public.attorney_profiles set years_experience=-1",
    ],
    [
      "negative response",
      "update public.attorney_profiles set response_expectation_seconds=-1",
    ],
    [
      "profile taxonomy",
      "update public.attorney_profiles set profile_state='invented'",
    ],
    [
      "license dates",
      "update public.licenses set effective_from='2026-02-01',effective_until='2026-01-01'",
    ],
    ["blank license", "update public.licenses set license_number=' '"],
    [
      "negative occurrence",
      "update public.insurance_records set per_occurrence_limit_minor=-1",
    ],
    [
      "negative aggregate",
      "update public.insurance_records set aggregate_limit_minor=-1",
    ],
    [
      "currency lowercase",
      "update public.insurance_records set currency_code='usd'",
    ],
    [
      "currency short",
      "update public.insurance_records set currency_code='US'",
    ],
    [
      "currency nonascii",
      "update public.insurance_records set currency_code='ÜSD'",
    ],
    [
      "insurance dates",
      "update public.insurance_records set coverage_from='2026-02-01',coverage_until='2026-01-01'",
    ],
    [
      "discipline dates",
      "update public.discipline_records set opened_at='2026-02-01',resolved_at='2026-01-01'",
    ],
    ["blank practice code", "update public.practice_areas set code=' '"],
    ["blank practice name", "update public.practice_areas set name=' '"],
    [
      "blank PAA status",
      "update public.practice_area_authorisations set status=' '",
    ],
    [
      "PAA decision dates",
      "update public.practice_area_authorisations set decided_at=requested_at-interval '1 day'",
    ],
    [
      "PAA effective dates",
      "update public.practice_area_authorisations set effective_from='2026-02-01',effective_until='2026-01-01'",
    ],
  ])
    bad(name, stmt);
  bad(
    "no subject",
    `insert into public.verification_evidence_subjects(verification_evidence_id) values(${u(81)})`,
  );
  bad(
    "multiple subjects",
    `insert into public.verification_evidence_subjects(verification_evidence_id,license_id,discipline_record_id) values(${u(81)},${u(41)},${u(61)})`,
  );
  bad(
    "duplicate subject",
    `insert into public.verification_evidence_subjects(verification_evidence_id,license_id) values(${u(81)},${u(41)})`,
    "23505",
  );
  add("SET LOCAL ROLE service_role;");
  for (const t of tables) {
    add(`select * from public.${t};`);
    add(`insert into public.${t} select * from public.${t} where false;`);
    if (tables.slice(0, 6).includes(t)) {
      add(`update public.${t} set id=id;`);
      denied(
        `service delete ${t}`,
        `delete from public.${t}`,
        "42501",
        "service_privileges",
      );
    }
    if (["verification_evidence", "eligibility_evaluations"].includes(t))
      for (const stmt of [
        `update public.${t} set id=id`,
        `delete from public.${t}`,
      ])
        denied(`immutable ${stmt}`, stmt, "42501", "service_privileges");
  }
  for (const c of ["id", "verification_evidence_id", "created_at"])
    denied(
      `association protected ${c}`,
      `update public.verification_evidence_subjects set ${c}=${c}`,
      "42501",
      "service_privileges",
    );
  add(`DO $history$ DECLARE original_e text; original_t1 text; original_created timestamptz; target uuid; BEGIN
 select row_to_json(e)::text into original_e from public.verification_evidence e where id=${u(81)};
 select row_to_json(e)::text into original_t1 from public.eligibility_evaluations e where id=${u(201)};
 select created_at into original_created from public.verification_evidence_subjects where id=${u(91)};
 foreach target in array ARRAY[${u(43)},${u(41)},${u(43)},${u(44)},${u(41)}] loop
  update public.verification_evidence_subjects set license_id=target where id=${u(91)};
  if not exists(select 1 from public.verification_evidence_subjects where id=${u(91)} and verification_evidence_id=${u(81)} and created_at=original_created and license_id=target) then raise exception 'replacement changed protected identity'; end if;
 end loop;
 update public.verification_evidence_subjects set license_id=null,insurance_record_id=${u(51)} where id=${u(91)};
 update public.verification_evidence_subjects set license_id=${u(41)},insurance_record_id=null where id=${u(91)};
 begin update public.verification_evidence_subjects set license_id=${u(42)} where id=${u(91)}; raise exception 'duplicate collision accepted'; exception when unique_violation then null; end;
 begin update public.verification_evidence_subjects set license_id=null where id=${u(91)}; raise exception 'zero target accepted'; exception when check_violation then null; end;
 begin update public.verification_evidence_subjects set insurance_record_id=${u(51)} where id=${u(91)}; raise exception 'multiple target accepted'; exception when check_violation then null; end;
 update public.verification_evidence_subjects set license_id=${u(43)} where id=${u(91)};
 if (select row_to_json(e)::text from public.eligibility_evaluations e where id=${u(201)}) is distinct from original_t1 then raise exception 'T1 changed after replacement'; end if;
 delete from public.verification_evidence_subjects where id=${u(91)};
 if exists(select 1 from public.verification_evidence_subjects where id=${u(91)}) then raise exception 'void failed'; end if;
 if (select row_to_json(e)::text from public.eligibility_evaluations e where id=${u(201)}) is distinct from original_t1 then raise exception 'T1 changed after void'; end if;
 if not exists(select 1 from public.eligibility_evaluations where id=${u(201)} and evidence_references->'verification_evidence_ids' @> jsonb_build_array(${u(81)}) and evidence_references->'license_ids' @> jsonb_build_array(${u(41)})) then raise exception 'T1 independent references lost'; end if;
 insert into public.verification_evidence_subjects(id,verification_evidence_id,license_id) values(${u(98)},${u(81)},${u(41)});
 begin insert into public.verification_evidence_subjects(verification_evidence_id,license_id) values(${u(81)},${u(41)}); raise exception 'restoration duplicate accepted'; exception when unique_violation then null; end;
 update public.verification_evidence_subjects set license_id=${u(43)} where id=${u(98)};
 if not exists(select 1 from public.verification_evidence_subjects where id=${u(98)} and verification_evidence_id=${u(81)} and license_id=${u(43)}) then raise exception 'T2 current professional basis mismatch'; end if;
 insert into public.eligibility_evaluations(id,attorney_id,jurisdiction_id,context_type,evaluated_at,policy_references,result,factor_results,evidence_references,as_of) values(${u(202)},${u(21)},${u(11)},'later_test_decision',statement_timestamp(),'[]','later_test_result','{}',jsonb_build_object('verification_evidence_ids',jsonb_build_array(${u(81)}),'license_ids',jsonb_build_array(${u(43)})),statement_timestamp());
 if (select count(*) from public.eligibility_evaluations where id in(${u(201)},${u(202)}))<>2 then raise exception 'T1 T2 coexistence failed'; end if;
 if (select row_to_json(e)::text from public.eligibility_evaluations e where id=${u(201)}) is distinct from original_t1 then raise exception 'T1 rewritten by T2'; end if;
 if (select row_to_json(e)::text from public.verification_evidence e where id=${u(81)}) is distinct from original_e then raise exception 'Evidence changed'; end if;
 END $history$;`);
  for (const name of [
    "replacement preserves identity",
    "pure void",
    "erroneous replacement reversal",
    "erroneous void restoration",
    "A B C A repeated corrections",
    "cross-type replacement",
    "duplicate collision rejected",
    "Evidence byte-for-byte unchanged",
  ])
    checks.corrections.push({ name, passed: true });
  for (const name of [
    "T1 byte-for-byte unchanged after correction and void",
    "T1 independent direct Evidence and professional identifiers",
    "T2 coexists without rewriting T1",
    "T2 direct references match the corrected association at its decision point",
  ])
    checks.historical_independence.push({ name, passed: true });
  owner();
  // Catch test/DDL errors inside a subtransaction so the outer batch always
  // reaches its explicit ROLLBACK. A failed result is never validation success.
  const catalogAggregate = candidateCatalogSql.replace(
    /SELECT jsonb_build_object\('category',category,'identity',identity,'data',data\)::text[\s\S]*$/,
    "SELECT jsonb_agg(jsonb_build_object('category',category,'identity',identity,'data',data)) FROM catalog_rows;",
  );
  const batch = `${statements.slice(0, 3).join("\n")}
DO $validation$
DECLARE catalog jsonb; column_acl jsonb; started text;
BEGIN
  started := to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"');
  BEGIN
    EXECUTE $candidate_batch$${statements.slice(3).join("\n\n")}$candidate_batch$;
    EXECUTE $candidate_catalog$${catalogAggregate}$candidate_catalog$ INTO catalog;
    SELECT jsonb_agg(jsonb_build_object('column',a.attname,'acl',a.attacl,'service_update',has_column_privilege('service_role',a.attrelid,a.attnum,'UPDATE')) order by a.attnum)
      INTO column_acl FROM pg_attribute a WHERE a.attrelid='public.verification_evidence_subjects'::regclass AND a.attnum>0 AND NOT a.attisdropped;
    PERFORM set_config('rosuno.p1004_result',jsonb_build_object('passed',true,'started_at',started,'checks',${q(JSON.stringify(checks))}::jsonb,'catalog_rows',catalog,'column_privileges',column_acl)::text,true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('rosuno.p1004_result',jsonb_build_object('passed',false,'started_at',started,'sqlstate',SQLSTATE,'error',SQLERRM)::text,true);
  END;
END $validation$;
SELECT current_setting('rosuno.p1004_result')::jsonb AS validation_result;
ROLLBACK;
`;
  return { sql: batch, checks };
}
if (process.argv[2])
  writeFileSync(process.argv[2], buildRollbackValidation().sql);
