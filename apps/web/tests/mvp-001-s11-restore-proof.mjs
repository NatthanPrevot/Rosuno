// MVP-001 S11 non-production backup/restore verification (disposable local
// PostgreSQL). Explicitly invoked only:
//
//   node apps/web/tests/mvp-001-s11-restore-proof.mjs
//
// Deliberately not a *.test.mjs file, so no application test run, p0:test,
// or CI job starts it. It uses Node built-ins and the system-installed
// PostgreSQL 16 initdb, pg_ctl, psql, pg_dump and pg_restore binaries.
//
// The repository root is the third parent of this file's directory
// (apps/web/tests -> repository root). ROSUNO_REPOSITORY_ROOT, when set,
// overrides it (for a run of a copy kept outside the repository); its value
// is never printed.
//
// Cluster handling follows the MVP-001 disposable proof harnesses: a new
// mode-0700 temporary directory, a cluster initialized and run by an
// unprivileged account (nobody:65534 when started as root, never root), TCP
// disabled and a private Unix-domain socket (port 54350, outside the range of
// the slice proofs). The roles anon, authenticated and service_role
// (BYPASSRLS), the synthetic auth schema (auth.users with the identity
// provider's email column, and an auth.uid() that reads
// request.jwt.claim.sub), the hosted platform's default privileges and a
// no-op public.rls_auto_enable() are synthetic objects of this cluster only.
// Every migration in supabase/migrations is applied unmodified, in order,
// each in one transaction.
//
// Procedure (MVP-001 Packet slice S11 backup/restore verification; IMP
// section 29 backup/recovery verification; IMP section 35 tested from a clean
// environment):
//   1. Source database: every migration applied; the environment recorded as
//      development through record_deployment_environment; a small synthetic
//      data set planted by the owner role (users, a client profile with an
//      intake, an attorney profile, staff profiles with one capability grant,
//      a jurisdiction, development policy versions, and the audit event the
//      environment recording writes). Every value is synthetic test data;
//      addresses use the reserved .invalid domain.
//   2. Backup: pg_dump --format=custom (schema and data, owners and
//      privileges kept); its SHA-256, size and table-of-contents entry count.
//   3. Restore into a new empty database of the same cluster (created from
//      template0, verified empty) with pg_restore; exit status and every error
//      line are recorded and must be absent.
//   4. Comparison of source and restore: a catalog fingerprint (functions,
//      relations, columns, constraints, indexes, triggers, row policies,
//      relation, column, function, schema and default grants, RLS flags,
//      sequences with their state, types, extensions, comments), per-table
//      row counts and content digests, and the deployment_environment record.
//   5. Behavioural checks, run on both databases with equal outcomes required:
//      immutable guards still refuse, a SECURITY DEFINER predicate still runs
//      as authenticated with a synthetic JWT, and anon still cannot read
//      protected relations.
//   6. The environment-record hazard: the restore carries the source's
//      immutable environment record. A second source recorded as production
//      (a synthetic 20-letter project reference) is dumped and restored the
//      same way, and the binding check is shown as the application would see
//      it under a JWT issued by the recorded project and by another project.
//   7. The hosted-only coverage gaps are reported as procedure steps for a
//      hosted restore (not exercised here).
//
// No Supabase project, network service or pre-existing cluster is contacted,
// and nothing persists after the run: the dump lives inside the temporary
// directory, which teardown removes. The JSON report goes to stdout (no
// secrets, no paths); exit 0 means PASS, 1 FAIL, 2 cleanup failure.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54350;
const SOURCE_DB = "rosuno_restore_source";
const TARGET_DB = "rosuno_restore_target";
const HAZARD_SOURCE_DB = "rosuno_restore_hazard_source";
const HAZARD_TARGET_DB = "rosuno_restore_hazard_target";
// Synthetic 20-letter project references (never a real project).
const SYNTHETIC_PRODUCTION_REF = "syntheticproductionx";
const SYNTHETIC_STAGING_REF = "syntheticstagingrefx";

const ROOT_OVERRIDE = process.env.ROSUNO_REPOSITORY_ROOT;
const REPOSITORY_ROOT =
  ROOT_OVERRIDE !== undefined && ROOT_OVERRIDE !== ""
    ? path.resolve(ROOT_OVERRIDE)
    : path.resolve(
        path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
        "../../..",
      );
const MIGRATIONS = path.join(REPOSITORY_ROOT, "supabase/migrations");

const report = {
  proof:
    "MVP-001 S11 non-production backup/restore verification (disposable local PostgreSQL)",
  repository_root: ROOT_OVERRIDE ? "override" : "script_location",
  migrations: {},
  cluster: {},
  source: {},
  backup: {},
  restore: {},
  comparison: {},
  behaviour: {},
  environment_record_hazard: {},
  hosted_restore_procedure_steps: [],
  checks: [],
  timings_ms: {},
};
let state = null;
let failed = false;

// ---------------------------------------------------------------------------
// Cluster and one-shot tools (modelled on the MVP-001 proof harnesses)
// ---------------------------------------------------------------------------

function unprivilegedIdentity() {
  if (process.getuid() !== 0) {
    return { uid: process.getuid(), gid: process.getgid(), spawn: {} };
  }
  const entry = fs
    .readFileSync("/etc/passwd", "utf8")
    .split("\n")
    .find((line) => line.startsWith("nobody:"));
  const fields = entry?.split(":") ?? [];
  if (fields[2] !== "65534" || fields[3] !== "65534") {
    throw new Error("no unprivileged nobody:65534 account to run PostgreSQL");
  }
  return { uid: 65534, gid: 65534, spawn: { uid: 65534, gid: 65534 } };
}

function childEnvironment() {
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    HOME: "/",
  };
}

function run(tool, args, input) {
  return spawnSync(path.join(BIN, tool), args, {
    env: childEnvironment(),
    encoding: "utf8",
    input,
    timeout: 300000,
    maxBuffer: 256 * 1024 * 1024,
    cwd: state.tmp,
    ...state.identity.spawn,
  });
}

const connection = () => [
  "-h",
  state.socketDir,
  "-p",
  String(PORT),
  "-U",
  "postgres",
];

function psqlArgs(db) {
  return [
    "-X",
    "-q",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-v",
    "VERBOSITY=verbose",
    ...connection(),
    "-d",
    db,
  ];
}

function psql(script, db) {
  return run("psql", psqlArgs(db), script);
}

function sql(script, db) {
  const result = psql(script, db);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function sqlstateOf(text) {
  return /ERROR:\s+([0-9A-Z]{5}):/.exec(text ?? "")?.[1] ?? null;
}

// The SQLSTATE of an owner statement that must fail, in its own transaction.
function refused(statement, db) {
  const result = psql(["begin;", statement, "commit;"].join("\n"), db);
  if (result.status === 0) {
    return "ACCEPTED";
  }
  return sqlstateOf(result.stderr);
}

function lit(value) {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `'${text.replaceAll("'", "''")}'`;
}

// The session lines of one request as PostgREST sets them from a verified
// JWT: a role, an optional subject (request.jwt.claim.sub) and the JSON claims
// (request.jwt.claims). aal null omits the claims; iss adds an issuer.
function sessionLines(role, sub, { aal = "aal2", iss = null } = {}) {
  const lines = [`set local role ${role};`];
  if (sub !== null) {
    lines.push(
      `select set_config('request.jwt.claim.sub', ${lit(sub)}, true) is not null;`,
    );
  }
  if (aal !== null || iss !== null) {
    const claims = { role };
    if (sub !== null) {
      claims.sub = sub;
    }
    if (aal !== null) {
      claims.aal = aal;
    }
    if (iss !== null) {
      claims.iss = iss;
    }
    lines.push(
      `select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true) is not null;`,
    );
  }
  return lines;
}

// One statement as a request, in its own transaction (rolled back): the last
// output line, or "ERROR <sqlstate>".
function as(db, role, sub, statement, options = {}) {
  const result = psql(
    [
      "begin;",
      ...sessionLines(role, sub, options),
      statement,
      "rollback;",
      "",
    ].join("\n"),
    db,
  );
  if (result.status === 0) {
    const lines = result.stdout.trim().split("\n");
    return lines[lines.length - 1];
  }
  return `ERROR ${sqlstateOf(result.stderr)}`;
}

const ROLES = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
`;

const fixtureFor = (db) => `
create database ${db} template template0 encoding 'UTF8' locale 'C';
\\connect ${db}
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create function public.rls_auto_enable() returns void language sql as $$ select $$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
`;

function pgCtl(args) {
  const result = run("pg_ctl", [
    "-D",
    state.dataDir,
    "-w",
    "-t",
    "60",
    "-s",
    ...args,
  ]);
  assert.equal(result.status, 0, result.stderr);
}

function startCluster() {
  const identity = unprivilegedIdentity();
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "rosuno-mvp-001-s11-restore-proof-"),
  );
  const socketDir = path.join(tmp, "socket");
  state = { identity, tmp, socketDir, started: false };
  fs.chmodSync(tmp, 0o700);
  fs.chownSync(tmp, identity.uid, identity.gid);
  fs.mkdirSync(socketDir, { mode: 0o700 });
  fs.chownSync(socketDir, identity.uid, identity.gid);
  const dataDir = path.join(tmp, "data");
  state.dataDir = dataDir;
  const init = run("initdb", [
    "-D",
    dataDir,
    "-U",
    "postgres",
    "--auth=trust",
    "--encoding=UTF8",
    "--locale=C",
    "--no-instructions",
    "--no-sync",
  ]);
  assert.equal(init.status, 0, init.stderr);
  fs.writeFileSync(path.join(dataDir, "pg_hba.conf"), "local all all trust\n");
  fs.appendFileSync(
    path.join(dataDir, "postgresql.conf"),
    [
      "",
      "listen_addresses = ''",
      `port = ${PORT}`,
      `unix_socket_directories = '${socketDir}'`,
      "unix_socket_permissions = 0700",
      "fsync = off",
      "timezone = 'UTC'",
      "max_connections = 30",
      "",
    ].join("\n"),
  );
  pgCtl(["-l", path.join(tmp, "postgres.log"), "start"]);
  state.started = true;
  const settings = JSON.parse(
    sql(
      "select json_build_object('version', current_setting('server_version'), 'listen_addresses', current_setting('listen_addresses'), 'tcp', inet_server_addr() is not null)::text;",
      "postgres",
    ),
  );
  assert.equal(settings.listen_addresses, "");
  assert.equal(settings.tcp, false);
  report.cluster = {
    ...settings,
    port: PORT,
    postmaster_uid: identity.uid,
    pg_dump: run("pg_dump", ["--version"]).stdout.trim(),
    pg_restore: run("pg_restore", ["--version"]).stdout.trim(),
  };
}

function teardown() {
  if (state === null) {
    return true;
  }
  if (state.started) {
    run("pg_ctl", [
      "-D",
      state.dataDir,
      "-w",
      "-t",
      "60",
      "-s",
      "-m",
      "fast",
      "stop",
    ]);
  }
  fs.rmSync(state.tmp, { recursive: true, force: true });
  return !fs.existsSync(state.tmp);
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const uid = () => randomUUID();

async function check(name, body) {
  try {
    const detail = await body();
    report.checks.push({
      name,
      result: "PASS",
      ...(detail === undefined ? {} : { detail }),
    });
    process.stderr.write(`[s11-restore-proof] PASS ${name}\n`);
  } catch (error) {
    failed = true;
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
    process.stderr.write(
      `[s11-restore-proof] FAIL ${name}\n${error?.stack ?? error}\n`,
    );
  }
}

async function timed(label, body) {
  const started = performance.now();
  try {
    return await body();
  } finally {
    report.timings_ms[label] = Math.round(performance.now() - started);
  }
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

function migrationFiles() {
  assert.ok(
    fs.existsSync(MIGRATIONS),
    "supabase/migrations not found under the repository root (set ROSUNO_REPOSITORY_ROOT when running a copy outside the repository)",
  );
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function applyMigrationsTo(db, files) {
  for (const file of files) {
    const result = run(
      "psql",
      ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-1", ...connection(), "-d", db],
      fs.readFileSync(path.join(MIGRATIONS, file), "utf8"),
    );
    assert.equal(result.status, 0, `${db} ${file}: ${result.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Synthetic source data (owner role; test data only)
// ---------------------------------------------------------------------------

const world = {};

function newAccount(label) {
  const auth = uid();
  const user = uid();
  sql(
    `insert into auth.users (id, email) values ('${auth}', ${lit(`restore-${label}@synthetic.invalid`)});
     insert into public.users (id, auth_user_id, account_state) values ('${user}', '${auth}', 'active');`,
    SOURCE_DB,
  );
  return { auth, user };
}

// Development configuration created by the owner role in this disposable
// database only: test values, never product values.
function policy(type, jurisdiction, parameters) {
  const id = uid();
  sql(
    `insert into public.policy_versions (id, policy_type_code, jurisdiction_id, regulatory_mode_id, version_label, parameters, status, effective_from, development_only)
     values ('${id}', ${lit(type)}, ${lit(jurisdiction)}, null, ${lit(`synthetic-restore-${type}`)}, ${lit(parameters)}::jsonb, 'draft', now() - interval '1 hour', true);`,
    SOURCE_DB,
  );
  return id;
}

function seedSource() {
  report.source.environment_record_id = sql(
    "select public.record_deployment_environment('development', null);",
    SOURCE_DB,
  );
  world.jurisdiction = uid();
  sql(
    `insert into public.jurisdictions (id, code, name, region_type, lifecycle_state) values ('${world.jurisdiction}', 'SYN_RESTORE_A', 'Synthetic Restore A', 'synthetic', 'unsupported');`,
    SOURCE_DB,
  );
  world.client = newAccount("client");
  world.clientProfile = uid();
  world.intake = uid();
  sql(
    `insert into public.client_profiles (id, user_id) values ('${world.clientProfile}', '${world.client.user}');
     insert into public.intakes (id, client_id, state) values ('${world.intake}', '${world.clientProfile}', 'submitted');`,
    SOURCE_DB,
  );
  world.attorney = newAccount("attorney");
  world.attorneyProfile = uid();
  sql(
    `insert into public.attorney_profiles (id, user_id, profile_state, display_name, years_experience) values ('${world.attorneyProfile}', '${world.attorney.user}', 'approved', 'Synthetic Restore Attorney', 7);`,
    SOURCE_DB,
  );
  world.grantor = newAccount("grantor");
  world.staff = newAccount("staff");
  sql(
    `insert into public.staff_profiles (user_id, staff_state) values ('${world.grantor.user}', 'active');
     insert into public.staff_profiles (user_id, staff_state) values ('${world.staff.user}', 'active');
     insert into public.capability_grants (user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at)
       values ('${world.staff.user}', 'manage_policy_configuration', '${world.grantor.user}', null, now() - interval '1 day');`,
    SOURCE_DB,
  );
  world.referralPolicy = policy("referral", world.jurisdiction, {
    outcome_codes: ["synthetic_closed"],
  });
  world.bookabilityPolicy = policy("bookability", null, {
    presence_window_seconds: 600,
  });
  report.source.planted = {
    auth_users: 4,
    users: 4,
    client_profiles: 1,
    intakes: 1,
    attorney_profiles: 1,
    staff_profiles: 2,
    capability_grants: 1,
    jurisdictions: 1,
    development_policy_versions: 2,
    audit_events_by_environment_recording: 1,
  };
}

// ---------------------------------------------------------------------------
// Catalog fingerprint, row digests and environment record
// ---------------------------------------------------------------------------

const USER_SCHEMAS = `n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'`;

// Normalizations, each a representation difference pg_dump introduces by
// design, never a semantic one:
// - privileges are compared as effective ACLs: a null ACL is the owner's
//   default (acldefault), which pg_dump omits; an explicit ACL equal to that
//   default (left by REVOKE ... FROM PUBLIC and the API roles) restores as
//   null. The raw representation counts are reported separately;
// - columns are compared by ordinal position among live columns: a restore
//   renumbers attnum and drops the holes dropped columns leave;
// - a CHECK constraint whose deparsed text differs is re-parsed on the source
//   (added NOT VALID inside a rolled-back transaction) and accepted only when
//   the re-parsed text equals the restore's text exactly (the parser
//   flattens nested AND chains when the dump is replayed).
const FINGERPRINT_QUERIES = Object.freeze({
  schemas: `select n.nspname as k, pg_get_userbyid(n.nspowner) as owner, coalesce(n.nspacl, acldefault('n', n.nspowner))::text as acl
    from pg_namespace n where ${USER_SCHEMAS}`,
  functions: `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as k,
      p.prokind as kind, l.lanname as language, md5(p.prosrc) as prosrc_md5, p.prosecdef as security_definer,
      p.proconfig as config, coalesce(p.proacl, acldefault('f', p.proowner))::text as acl, p.provolatile as volatility, p.proleakproof as leakproof,
      p.proisstrict as strict, pg_get_function_result(p.oid) as result, pg_get_userbyid(p.proowner) as owner
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
    where ${USER_SCHEMAS}`,
  relations: `select n.nspname || '.' || c.relname as k, c.relkind as kind, c.relrowsecurity as rls_enabled,
      c.relforcerowsecurity as rls_forced, coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 's' else 'r' end::"char", c.relowner))::text as acl, pg_get_userbyid(c.relowner) as owner,
      c.reloptions as options, c.relpersistence as persistence,
      case when c.relkind in ('v', 'm') then md5(pg_get_viewdef(c.oid)) end as view_definition_md5
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where ${USER_SCHEMAS} and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')`,
  columns: `select n.nspname || '.' || c.relname || '.' || a.attname as k, row_number() over (partition by a.attrelid order by a.attnum) as position,
      format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
      pg_get_expr(d.adbin, d.adrelid) as "default", a.attgenerated as generated, a.attidentity as identity,
      co.collname as collation, a.attacl::text as acl
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    left join pg_collation co on co.oid = a.attcollation and a.attcollation <> 0
    where ${USER_SCHEMAS} and c.relkind in ('r', 'p', 'v', 'm', 'f') and a.attnum > 0 and not a.attisdropped`,
  constraints: `select coalesce(n.nspname || '.' || c.relname, tn.nspname || '.' || t.typname) || '.' || k.conname as k,
      k.conrelid::regclass::text as relation,
      k.contype as type, pg_get_constraintdef(k.oid) as definition, k.convalidated as validated,
      k.condeferrable as deferrable, k.condeferred as deferred
    from pg_constraint k
    left join pg_class c on c.oid = k.conrelid left join pg_namespace n on n.oid = c.relnamespace
    left join pg_type t on t.oid = k.contypid left join pg_namespace tn on tn.oid = t.typnamespace
    where coalesce(n.nspname, tn.nspname) not in ('pg_catalog', 'information_schema')`,
  indexes: `select schemaname || '.' || indexname as k, tablename as "table", indexdef as definition
    from pg_indexes where schemaname not in ('pg_catalog', 'information_schema')`,
  triggers: `select n.nspname || '.' || c.relname || '.' || t.tgname as k, t.tgenabled as enabled,
      t.tgfoid::regprocedure::text as function, pg_get_triggerdef(t.oid) as definition
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where ${USER_SCHEMAS} and not t.tgisinternal`,
  policies: `select schemaname || '.' || tablename || '.' || policyname as k, permissive, roles::text as roles,
      cmd as command, qual, with_check
    from pg_policies`,
  default_privileges: `select pg_get_userbyid(d.defaclrole) || '.' || coalesce(n.nspname, '*') || '.' || d.defaclobjtype::text as k,
      d.defaclacl::text as acl
    from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace`,
  sequences: `select schemaname || '.' || sequencename as k, data_type::text as type, start_value, min_value, max_value,
      increment_by, cycle, last_value, pg_get_userbyid((select relowner from pg_class where oid = (quote_ident(schemaname) || '.' || quote_ident(sequencename))::regclass)) as owner
    from pg_sequences`,
  types: `select n.nspname || '.' || t.typname as k, t.typtype as type,
      (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) as labels,
      format_type(t.typbasetype, t.typtypmod) as base, t.typnotnull as not_null, coalesce(t.typacl, acldefault('T', t.typowner))::text as acl
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where ${USER_SCHEMAS}
      and (t.typtype in ('e', 'd', 'r', 'm')
           or (t.typtype = 'c' and exists (select 1 from pg_class c where c.oid = t.typrelid and c.relkind = 'c')))`,
  extensions: `select e.extname as k, e.extversion as version, n.nspname as schema
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace`,
  // Comments on objects created after initdb (object identifier 16384 and above).
  comments: `select o.type || ' ' || o.identity as k, md5(d.description) as description_md5
    from pg_description d cross join lateral pg_identify_object(d.classoid, d.objoid, d.objsubid) as o
    where d.objoid >= 16384`,
});

function fingerprint(db) {
  const out = {};
  for (const [category, query] of Object.entries(FINGERPRINT_QUERIES)) {
    const rows = JSON.parse(
      sql(
        `select coalesce(json_agg(row_to_json(x) order by x.k), '[]'::json)::text from (${query}) as x;`,
        db,
      ),
    );
    out[category] = rows;
  }
  return out;
}

function compareFingerprints(left, right, reparse) {
  const result = {};
  let equal = true;
  for (const category of Object.keys(FINGERPRINT_QUERIES)) {
    const a = left[category];
    const b = right[category];
    const aText = JSON.stringify(a);
    const bText = JSON.stringify(b);
    let same = aText === bText;
    let normalized = [];
    if (!same && category === "constraints" && a.length === b.length) {
      const index = new Map(b.map((row) => [row.k, row]));
      const rewritten = a.map((row) => {
        const other = index.get(row.k);
        if (
          other === undefined ||
          JSON.stringify(row) === JSON.stringify(other) ||
          row.type !== "c" ||
          row.relation === null ||
          JSON.stringify({ ...row, definition: null }) !==
            JSON.stringify({ ...other, definition: null })
        ) {
          return row;
        }
        const canonical = reparse(row.relation, row.definition);
        if (canonical !== other.definition) {
          return row;
        }
        normalized.push(row.k);
        return { ...row, definition: canonical };
      });
      same = JSON.stringify(rewritten) === bText;
    }
    const entry = {
      source_count: a.length,
      restore_count: b.length,
      sha256: sha256(aText),
      equal: same,
      ...(normalized.length > 0
        ? { reparsed_check_constraints: normalized }
        : {}),
    };
    if (!same) {
      equal = false;
      entry.restore_sha256 = sha256(bText);
      const index = new Map(b.map((row) => [row.k, JSON.stringify(row)]));
      const keys = new Set(a.map((row) => row.k));
      entry.differences = [
        ...a
          .filter((row) => index.get(row.k) !== JSON.stringify(row))
          .map((row) => ({
            k: row.k,
            source: row,
            restore: index.get(row.k) ?? null,
          })),
        ...b
          .filter((row) => !keys.has(row.k))
          .map((row) => ({ k: row.k, source: null, restore: row })),
      ].slice(0, 10);
    }
    result[category] = entry;
  }
  return { equal, categories: result };
}

// The canonical text of a CHECK constraint definition as the parser
// re-reads it on the given database (rolled back; nothing persists).
function reparseCheck(db, relation, definition) {
  const name = "rosuno_restore_proof_reparse";
  const result = psql(
    [
      "begin;",
      `alter table ${relation} add constraint ${name} ${definition} not valid;`,
      `select pg_get_constraintdef(oid) from pg_constraint where conname = '${name}' and conrelid = ${lit(relation)}::regclass;`,
      "rollback;",
    ].join("\n"),
    db,
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().replace(/ NOT VALID$/, "");
}

function rawAclRepresentation(db) {
  return JSON.parse(
    sql(
      `select json_build_object(
         'relations_with_null_acl', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where ${USER_SCHEMAS} and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and c.relacl is null),
         'functions_with_null_acl', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where ${USER_SCHEMAS} and p.proacl is null))::text;`,
      db,
    ),
  );
}

function userTables(db) {
  return sql(
    `select quote_ident(n.nspname) || '.' || quote_ident(c.relname)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where ${USER_SCHEMAS} and c.relkind in ('r', 'p')
     order by 1;`,
    db,
  )
    .split("\n")
    .filter((line) => line !== "");
}

// Per-table row count and a content digest (md5 over the rows' text forms in
// C-collation order; UTC session). The owner is a superuser, so row policies
// (forced or not) do not hide rows.
function tableDigests(db) {
  const tables = userTables(db);
  const parts = tables.map(
    (table) =>
      `select ${lit(table)} as t, count(*) as n, md5(coalesce(string_agg(r::text, E'\\n' order by r::text collate "C"), '')) as d from only ${table} as r`,
  );
  const rows = JSON.parse(
    sql(
      `select coalesce(json_agg(row_to_json(x) order by x.t), '[]'::json)::text from (${parts.join("\nunion all\n")}) as x;`,
      db,
    ),
  );
  return Object.fromEntries(
    rows.map((row) => [row.t, { rows: Number(row.n), digest: row.d }]),
  );
}

function environmentRecord(db) {
  return JSON.parse(
    sql(
      "select coalesce(json_agg(row_to_json(d)), '[]'::json)::text from public.deployment_environment as d;",
      db,
    ),
  );
}

// ---------------------------------------------------------------------------
// Backup and restore
// ---------------------------------------------------------------------------

function backup(db, file) {
  const dump = run("pg_dump", [
    ...connection(),
    "-d",
    db,
    "--format=custom",
    "--file",
    file,
  ]);
  assert.equal(dump.status, 0, dump.stderr);
  const bytes = fs.readFileSync(file);
  const list = run("pg_restore", ["--list", file]);
  assert.equal(list.status, 0, list.stderr);
  const entries = list.stdout.split("\n").filter((line) => /^\d+;/.test(line));
  return {
    format: "custom",
    sha256: sha256(bytes),
    size_bytes: bytes.length,
    toc_entries: entries.length,
    table_data_entries: entries.filter((line) => line.includes(" TABLE DATA "))
      .length,
    acl_entries: entries.filter((line) => line.includes(" ACL ")).length,
    pg_dump_stderr: dump.stderr
      .split("\n")
      .filter((line) => line.trim() !== ""),
  };
}

function restoreInto(db, file) {
  sql(
    `create database ${db} template template0 encoding 'UTF8' locale 'C';`,
    "postgres",
  );
  const before = Number(
    sql(
      `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where ${USER_SCHEMAS};`,
      db,
    ),
  );
  assert.equal(before, 0, "the restore target is empty before the restore");
  const restored = run("pg_restore", [...connection(), "-d", db, file]);
  const errorLines = restored.stderr
    .split("\n")
    .filter((line) => /error|ERROR|FATAL|warning|WARNING/.test(line));
  return {
    target_created_from: "template0",
    target_relations_before: before,
    exit_status: restored.status,
    error_lines: errorLines,
  };
}

// ---------------------------------------------------------------------------
// Behavioural checks (run identically on source and restore)
// ---------------------------------------------------------------------------

const PROTECTED_RELATIONS = Object.freeze([
  "users",
  "client_profiles",
  "attorney_profiles",
  "staff_profiles",
  "capability_grants",
  "audit_events",
  "deployment_environment",
  "policy_versions",
  "intakes",
]);

function behaviour(db) {
  const out = {};
  out.audit_events_update = refused(
    "update public.audit_events set reason_code = reason_code where action_code = 'deployment_environment.recorded';",
    db,
  );
  out.audit_events_delete = refused(
    "delete from public.audit_events where action_code = 'deployment_environment.recorded';",
    db,
  );
  out.deployment_environment_update = refused(
    "update public.deployment_environment set environment_class = 'staging', project_ref = 'syntheticstagingrefx';",
    db,
  );
  out.deployment_environment_delete = refused(
    "delete from public.deployment_environment;",
    db,
  );
  out.deployment_environment_truncate = refused(
    "truncate public.deployment_environment;",
    db,
  );
  out.deployment_environment_second_record = refused(
    `select public.record_deployment_environment('staging', ${lit(SYNTHETIC_STAGING_REF)});`,
    db,
  );
  out.deployment_environment_direct_insert = refused(
    "insert into public.deployment_environment (environment_class) values ('development');",
    db,
  );
  out.development_policy_change = refused(
    `update public.policy_versions set parameters = '{}'::jsonb where id = '${world.referralPolicy}';`,
    db,
  );
  out.policy_versions_delete = refused(
    `delete from public.policy_versions where id = '${world.referralPolicy}';`,
    db,
  );
  // SECURITY DEFINER predicate (reads auth.uid() and the aal claim).
  out.staff_capability_aal2 = as(
    db,
    "authenticated",
    world.staff.auth,
    "select public.has_staff_capability('manage_policy_configuration', null, false);",
  );
  out.staff_capability_aal1 = as(
    db,
    "authenticated",
    world.staff.auth,
    "select public.has_staff_capability('manage_policy_configuration', null, false);",
    { aal: "aal1" },
  );
  out.staff_capability_other_user = as(
    db,
    "authenticated",
    world.client.auth,
    "select public.has_staff_capability('manage_policy_configuration', null, false);",
  );
  out.staff_capability_anon = as(
    db,
    "anon",
    null,
    "select public.has_staff_capability('manage_policy_configuration', null, false);",
    { aal: null },
  );
  out.environment_identity_authenticated = as(
    db,
    "authenticated",
    world.client.auth,
    "select concat_ws('|', environment_class, coalesce(project_ref, '<null>')) from public.deployment_environment_identity();",
  );
  out.environment_identity_anon = as(
    db,
    "anon",
    null,
    "select environment_class from public.deployment_environment_identity();",
    { aal: null },
  );
  out.anon_reads = {};
  for (const relation of PROTECTED_RELATIONS) {
    out.anon_reads[relation] = as(
      db,
      "anon",
      null,
      `select count(*) from public.${relation};`,
      { aal: null },
    );
  }
  out.authenticated_client_visible_users = as(
    db,
    "authenticated",
    world.client.auth,
    "select count(*) from public.users;",
  );
  out.authenticated_client_reads_audit_events = as(
    db,
    "authenticated",
    world.client.auth,
    "select count(*) from public.audit_events;",
  );
  return out;
}

function assertBehaviour(b) {
  for (const key of [
    "audit_events_update",
    "audit_events_delete",
    "deployment_environment_update",
    "deployment_environment_delete",
    "deployment_environment_truncate",
    "deployment_environment_second_record",
    "development_policy_change",
    "policy_versions_delete",
  ]) {
    assert.ok(
      b[key] !== "ACCEPTED" && b[key] !== null,
      `${key} must be refused (got ${b[key]})`,
    );
  }
  assert.equal(b.deployment_environment_second_record, "55000");
  assert.equal(b.deployment_environment_direct_insert, "23505");
  assert.equal(b.staff_capability_aal2, "t");
  assert.equal(b.staff_capability_aal1, "f");
  assert.equal(b.staff_capability_other_user, "f");
  assert.equal(b.staff_capability_anon, "ERROR 42501");
  assert.equal(b.environment_identity_authenticated, "development|<null>");
  assert.equal(b.environment_identity_anon, "ERROR 42501");
  for (const [relation, outcome] of Object.entries(b.anon_reads)) {
    assert.ok(
      outcome === "ERROR 42501" || outcome === "0",
      `anon must not read public.${relation} (got ${outcome})`,
    );
  }
  assert.equal(b.authenticated_client_reads_audit_events, "ERROR 42501");
}

// The binding check as the application would see it: the recorded identity,
// the environment status (owner, with the request claims a JWT would carry)
// and the resolver outcome for a development policy scope.
function bindingView(db, recordedRef) {
  const status = (iss) =>
    as(db, "postgres", null, "select public.rosuno_environment_status();", {
      aal: iss === null ? null : "aal2",
      iss,
    });
  const resolve = (iss) =>
    as(
      db,
      "postgres",
      null,
      "select concat_ws('|', outcome, coalesce(development_only::text, '<null>')) from public.policy_select_version('bookability', null, null, now());",
      { aal: iss === null ? null : "aal2", iss },
    );
  const issuer = (ref) => `https://${ref}.supabase.co/auth/v1`;
  const view = {
    identity: sql(
      "select concat_ws('|', environment_class, coalesce(project_ref, '<null>')) from public.deployment_environment_identity();",
      db,
    ),
    status_without_claims: status(null),
    status_under_staging_project_jwt: status(issuer(SYNTHETIC_STAGING_REF)),
    resolver_without_claims: resolve(null),
    resolver_under_staging_project_jwt: resolve(issuer(SYNTHETIC_STAGING_REF)),
  };
  if (recordedRef !== null) {
    view.status_under_recorded_project_jwt = status(issuer(recordedRef));
  }
  return view;
}

// ---------------------------------------------------------------------------
// Hosted-only coverage (procedure steps; not exercised by this proof)
// ---------------------------------------------------------------------------

const HOSTED_STEPS = Object.freeze([
  {
    area: "storage_objects",
    gap: "pg_dump copies the storage schema's object metadata rows at most, never the object bytes held by the storage service.",
    step: "After a hosted restore, list the protected buckets and verify a sample of object checksums and the object-row count against the source evidence; a metadata row without its object (or the reverse) is a failure.",
  },
  {
    area: "auth_schema",
    gap: "The auth schema is owned and versioned by the platform; a project-level dump/restore of it is not supported, and this proof restores only its own synthetic stand-in.",
    step: "Restore through the platform's own backup or point-in-time recovery; verify the auth user count against the source and that every public.users.auth_user_id resolves to an auth user (no orphans).",
  },
  {
    area: "pg_cron",
    gap: "The disposable cluster has no pg_cron; job schedules and the extension state live in the hosted database and are created conditionally by the migrations.",
    step: "After a hosted restore, verify that the pg_cron extension exists and that the scheduled jobs the migrations register are present, active and not duplicated; suspend them during the drill if they would act on restored data.",
  },
  {
    area: "vault_secrets",
    gap: "Vault secrets and their encryption keys are platform-managed and are not reproduced by a plain dump/restore.",
    step: "Verify the presence (names only, never values) of the secrets the deployment needs; re-provision them in the target through the platform, never from the dump.",
  },
  {
    area: "provider_side_state",
    gap: "State held by external providers (payment, media, notification delivery, identity provider settings, webhooks, edge function secrets) is outside the database.",
    step: "Point the drill target at provider sandboxes only; verify that webhooks and redirect URLs of the restored target do not reach production providers.",
  },
  {
    area: "roles_and_project_settings",
    gap: "Cluster roles (anon, authenticated, service_role and platform roles), their settings, and project network, API and authentication configuration are not part of a database dump.",
    step: "Verify that the target project's roles exist and that the API exposes only the expected schemas before any request is made against the restored data.",
  },
  {
    area: "environment_record",
    gap: "The restored database carries the source's immutable deployment_environment record (class and project reference).",
    step: "Restore only into a target of the same environment class as the source; record both classes before the drill and refuse the restore if they differ. Never alter, disable triggers on, or re-record deployment_environment to make a restore fit.",
  },
]);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const total = performance.now();
  const files = migrationFiles();
  await timed("cluster_start", () => startCluster());

  report.migrations = {
    count: files.length,
    first: files[0]?.replace(/\.sql$/, "") ?? null,
    last: files[files.length - 1]?.replace(/\.sql$/, "") ?? null,
    set_sha256: sha256(
      files
        .map(
          (file) =>
            `${file} ${sha256(fs.readFileSync(path.join(MIGRATIONS, file)))}`,
        )
        .join("\n"),
    ),
    applied_unmodified_each_in_one_transaction: true,
  };

  await timed("migrations", () => {
    sql(ROLES, "postgres");
    sql(fixtureFor(SOURCE_DB), "postgres");
    assert.equal(
      sql(
        "select count(*) from pg_available_extensions where name = 'pg_cron';",
        "postgres",
      ),
      "0",
      "this disposable cluster has no pg_cron",
    );
    applyMigrationsTo(SOURCE_DB, files);
  });

  // A byte-for-byte copy of the migrated, still unrecorded source for the
  // production-class hazard demonstration.
  sql(`create database ${HAZARD_SOURCE_DB} template ${SOURCE_DB};`, "postgres");

  await timed("seed", () => seedSource());

  const sourceDump = path.join(state.tmp, "source.dump");
  report.backup = await timed("backup", () => backup(SOURCE_DB, sourceDump));
  report.restore = await timed("restore", () =>
    restoreInto(TARGET_DB, sourceDump),
  );

  await check("pg_restore completes without errors", () => {
    assert.equal(
      report.restore.exit_status,
      0,
      report.restore.error_lines.join("\n"),
    );
    assert.deepEqual(report.restore.error_lines, []);
    return {
      exit_status: report.restore.exit_status,
      error_lines: report.restore.error_lines.length,
    };
  });

  let sourcePrint;
  let targetPrint;
  await timed("compare", async () => {
    sourcePrint = fingerprint(SOURCE_DB);
    targetPrint = fingerprint(TARGET_DB);
    const compared = compareFingerprints(
      sourcePrint,
      targetPrint,
      (relation, definition) => reparseCheck(SOURCE_DB, relation, definition),
    );
    report.comparison.catalog = compared;
    report.comparison.raw_acl_representation = {
      source: rawAclRepresentation(SOURCE_DB),
      restore: rawAclRepresentation(TARGET_DB),
    };
    await check("catalog fingerprint of the restore equals the source", () => {
      assert.ok(compared.equal, "catalog fingerprints differ");
      assert.ok(sourcePrint.functions.length > 0);
      assert.ok(sourcePrint.policies.length > 0);
      return {
        categories: Object.fromEntries(
          Object.entries(compared.categories).map(([k, v]) => [
            k,
            v.source_count,
          ]),
        ),
        overall_sha256: sha256(JSON.stringify(sourcePrint)),
      };
    });

    const sourceRows = tableDigests(SOURCE_DB);
    const targetRows = tableDigests(TARGET_DB);
    const differing = Object.keys({ ...sourceRows, ...targetRows }).filter(
      (table) =>
        JSON.stringify(sourceRows[table]) !== JSON.stringify(targetRows[table]),
    );
    const nonEmpty = Object.fromEntries(
      Object.entries(sourceRows).filter(([, v]) => v.rows > 0),
    );
    report.comparison.rows = {
      tables: Object.keys(sourceRows).length,
      non_empty_tables: Object.keys(nonEmpty).length,
      total_rows: Object.values(sourceRows).reduce((n, v) => n + v.rows, 0),
      digest_of_digests: sha256(JSON.stringify(sourceRows)),
      differing_tables: differing,
      non_empty: nonEmpty,
    };
    await check(
      "row counts and content digests of every table are equal",
      () => {
        assert.deepEqual(differing, []);
        for (const table of [
          "auth.users",
          "public.users",
          "public.client_profiles",
          "public.attorney_profiles",
          "public.jurisdictions",
          "public.policy_versions",
          "public.audit_events",
          "public.deployment_environment",
        ]) {
          assert.ok(
            sourceRows[table]?.rows > 0,
            `${table} carries planted rows`,
          );
        }
        return {
          tables: report.comparison.rows.tables,
          total_rows: report.comparison.rows.total_rows,
        };
      },
    );

    const sourceEnv = environmentRecord(SOURCE_DB);
    const targetEnv = environmentRecord(TARGET_DB);
    report.comparison.environment_record = {
      source: sourceEnv.map(({ environment_class, project_ref }) => ({
        environment_class,
        project_ref,
      })),
      equal: JSON.stringify(sourceEnv) === JSON.stringify(targetEnv),
    };
    await check(
      "the deployment_environment record is restored unchanged",
      () => {
        assert.equal(sourceEnv.length, 1);
        assert.deepEqual(targetEnv, sourceEnv);
        assert.equal(targetEnv[0].environment_class, "development");
        assert.equal(targetEnv[0].id, report.source.environment_record_id);
        return { environment_class: targetEnv[0].environment_class };
      },
    );
  });

  await timed("behaviour", async () => {
    const sourceBehaviour = behaviour(SOURCE_DB);
    const targetBehaviour = behaviour(TARGET_DB);
    report.behaviour = {
      restore: targetBehaviour,
      equal_to_source:
        JSON.stringify(sourceBehaviour) === JSON.stringify(targetBehaviour),
    };
    await check(
      "behavioural checks on the restore hold and equal the source",
      () => {
        assertBehaviour(targetBehaviour);
        assert.deepEqual(targetBehaviour, sourceBehaviour);
      },
    );
    await check(
      "the restore still carries no data change from the checks",
      () => {
        assert.deepEqual(tableDigests(TARGET_DB), tableDigests(SOURCE_DB));
      },
    );
  });

  await timed("environment_hazard", async () => {
    const devView = bindingView(TARGET_DB, null);
    sql(
      `select public.record_deployment_environment('production', ${lit(SYNTHETIC_PRODUCTION_REF)});`,
      HAZARD_SOURCE_DB,
    );
    const hazardDump = path.join(state.tmp, "hazard.dump");
    const hazardBackup = backup(HAZARD_SOURCE_DB, hazardDump);
    const hazardRestore = restoreInto(HAZARD_TARGET_DB, hazardDump);
    const prodView = bindingView(HAZARD_TARGET_DB, SYNTHETIC_PRODUCTION_REF);
    const rerecord = refused(
      `select public.record_deployment_environment('staging', ${lit(SYNTHETIC_STAGING_REF)});`,
      HAZARD_TARGET_DB,
    );
    const correction = refused(
      `update public.deployment_environment set environment_class = 'staging', project_ref = ${lit(SYNTHETIC_STAGING_REF)};`,
      HAZARD_TARGET_DB,
    );
    const devConfigInProduction = refused(
      "insert into public.policy_versions (policy_type_code, version_label, parameters, status, effective_from, development_only) values ('bookability', 'synthetic-restore-hazard', '{}'::jsonb, 'draft', now(), true);",
      HAZARD_TARGET_DB,
    );
    report.environment_record_hazard = {
      development_backup_restored: devView,
      production_class_backup: {
        source_recorded: `production|${SYNTHETIC_PRODUCTION_REF} (synthetic)`,
        backup_sha256: hazardBackup.sha256,
        restore_exit_status: hazardRestore.exit_status,
        restore_error_lines: hazardRestore.error_lines,
        restored_binding_view: prodView,
        re_record_as_staging: rerecord,
        correct_record_in_place: correction,
        development_configuration_creation: devConfigInProduction,
      },
      finding:
        "A restore carries the source's immutable environment record. A production backup restored into a staging (or any other) project keeps environment_class production and the production project reference: every request carrying the target project's JWT issuer is answered environment_mismatch and every policy-driven function fails closed; the record cannot be re-recorded or corrected in place. A session without JWT claims (the owner, a scheduled job or a worker) is not bound by the issuer check: it sees status ok and the source's class, so a restored production record would let server-side work run as production in the wrong project. A development backup restored anywhere keeps development and makes its development configuration selectable whenever no hosted issuer is presented. The procedure must therefore refuse a restore whose source class differs from the target class, and keep scheduled jobs and workers stopped on a drill target until the record is verified.",
    };
    await check(
      "environment-record hazard: the restore keeps the source class and the binding check fails closed elsewhere",
      () => {
        assert.equal(devView.identity, "development|<null>");
        assert.equal(devView.status_without_claims, "ok");
        assert.equal(
          devView.status_under_staging_project_jwt,
          "environment_mismatch",
        );
        assert.equal(devView.resolver_without_claims, "selected|true");
        assert.equal(
          devView.resolver_under_staging_project_jwt,
          "environment_mismatch|<null>",
        );
        assert.equal(
          hazardRestore.exit_status,
          0,
          hazardRestore.error_lines.join("\n"),
        );
        assert.deepEqual(hazardRestore.error_lines, []);
        assert.equal(
          prodView.identity,
          `production|${SYNTHETIC_PRODUCTION_REF}`,
        );
        assert.equal(prodView.status_under_recorded_project_jwt, "ok");
        assert.equal(
          prodView.status_under_staging_project_jwt,
          "environment_mismatch",
        );
        assert.equal(
          prodView.resolver_under_staging_project_jwt,
          "environment_mismatch|<null>",
        );
        assert.equal(rerecord, "55000");
        assert.equal(correction, "55000");
        assert.equal(devConfigInProduction, "23514");
      },
    );
  });

  report.hosted_restore_procedure_steps = HOSTED_STEPS;
  report.timings_ms.total = Math.round(performance.now() - total);
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  failed = true;
  report.checks.push({
    name: "proof run",
    result: "FAIL",
    error: String(error?.message ?? error),
  });
  process.stderr.write(`[s11-restore-proof] ERROR ${error?.stack ?? error}\n`);
} finally {
  let cleaned = false;
  try {
    cleaned = teardown();
  } catch (error) {
    process.stderr.write(`[s11-restore-proof] cleanup error ${error}\n`);
  }
  report.cluster.removed = cleaned;
  report.result = !cleaned ? "CLEANUP_FAILURE" : failed ? "FAIL" : "PASS";
  exitCode = !cleaned ? 2 : failed ? 1 : 0;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
process.exit(exitCode);
