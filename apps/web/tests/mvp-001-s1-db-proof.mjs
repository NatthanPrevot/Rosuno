// MVP-001 S1 disposable PostgreSQL proof. Explicitly invoked only:
//
//   node apps/web/tests/mvp-001-s1-db-proof.mjs
//
// Deliberately not a *.test.mjs file, so no application test run, p0:test,
// or CI job starts it. It uses Node built-ins and the system-installed
// PostgreSQL 16 initdb, pg_ctl, and psql binaries.
//
// It creates a new mode-0700 temporary directory, initializes a new cluster
// owned by an unprivileged account (never root), and starts it with TCP
// disabled and a private Unix-domain socket. The roles anon, authenticated,
// and service_role (BYPASSRLS), the synthetic auth schema (auth.users and an
// auth.uid() that reads request.jwt.claim.sub), the hosted platform's default
// privileges, and a no-op public.rls_auto_enable() are synthetic objects of
// this cluster only. Every migration is applied unmodified, in order, each in
// one transaction, into a template database; the four S1 migrations must be
// registered in the migration register. Four databases are then cloned from
// the template: one left unrecorded and one recorded as each PS-A2
// environment class, because the record is immutable once written.
//
// The probes cover the MVP-001 Packet S1 acceptance list: PS-A2 positive and
// negative tests, the policy lifecycle and immutability, approval only with
// verified authority, the generic resolver (no policy, conflict, effective
// window), launch gates, human launch authorization and the four-way
// production financial gate, capability administration (grant, revoke,
// expiry, no self-grant, audit), staff configuration authority, the narrowed
// service_role writes, SCH-1 (server-generated keys), SCH-3 (availability
// checks) and SCH-4 (the policy-type catalog and the eligibility code). No
// Supabase project, network service, or pre-existing cluster is contacted,
// nothing persists after the run, and every value is synthetic test data.
// The JSON report goes to stdout; exit 0 means PASS, 1 FAIL, 2 cleanup
// failure.
//
// MVP-001 S2 update: the registered S2 migrations follow S1, so the S1
// migrations are asserted contiguous, in order, directly after P5-001, with
// every later migration registered (previously: S1 applies last). Staff
// authority and attorney professional writes need an aal2 session
// (20261118030000), so every request with a JWT subject also carries
// request.jwt.claims with "aal": "aal2", as PostgREST sets it from a
// verified, MFA-stepped-up JWT; CAP-1 adds the aal1 and claim-less refusals.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54336;
const BASE = "rosuno_s1_base";
const DBS = Object.freeze({
  unrecorded: "rosuno_s1_unrecorded",
  development: "rosuno_s1_development",
  staging: "rosuno_s1_staging",
  production: "rosuno_s1_production",
});
const STAGING_REF = "stagingrefabcdefghij";
const PRODUCTION_REF = "productionrefabcdefg";
const OTHER_REF = "otherprojectrefabcde";
const REPOSITORY_ROOT = path.resolve(
  path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
  "../../..",
);
const MIGRATIONS = path.join(REPOSITORY_ROOT, "supabase/migrations");
const S1_MIGRATIONS = Object.freeze([
  "20261117010000_mvp_001_s1_environment_identity.sql",
  "20261117020000_mvp_001_s1_professional_conformance.sql",
  "20261117030000_mvp_001_s1_configuration_administration.sql",
  "20261117040000_mvp_001_s1_availability_checks.sql",
]);
const POLICY_TYPES = Object.freeze([
  "automated_referral_quality",
  "bookability",
  "cancellation",
  "eligibility",
  "engagement",
  "fee",
  "governance",
  "notification",
  "payment",
  "payment_flow",
  "referral",
  "refund",
  "reporting",
  "retention",
  "scheduling",
]);
const ELIGIBILITY_PARAMETERS = Object.freeze({
  schema: "rosuno.attorney_eligibility.v1",
  license: {
    qualifying_reported_statuses: ["synthetic-active"],
    evidence_max_age_days: 30,
  },
  insurance: {
    required: false,
    evidence_max_age_days: 30,
    minimum_per_occurrence_minor: null,
    minimum_aggregate_minor: null,
    currency_code: null,
  },
  discipline: {
    disqualifying_statuses: ["synthetic-revoked"],
    cleared_statuses: [],
  },
  practice_area: { authorisation_required: false },
});

const report = {
  proof: "MVP-001 S1 disposable local PostgreSQL proof",
  migrations: {},
  checks: [],
  cluster: {},
};
let state = null;

// ---------------------------------------------------------------------------
// Cluster and one-shot psql
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

function run(tool, args, input) {
  return spawnSync(path.join(BIN, tool), args, {
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      HOME: "/",
    },
    encoding: "utf8",
    input,
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
    cwd: state.tmp,
    ...state.identity.spawn,
  });
}

function psql(script, db) {
  return run(
    "psql",
    [
      "-X",
      "-q",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "VERBOSITY=verbose",
      "-h",
      state.socketDir,
      "-p",
      String(PORT),
      "-U",
      "postgres",
      "-d",
      db,
    ],
    script,
  );
}

function sql(db, script) {
  const result = psql(script, db);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function sqlstateOf(text) {
  return /ERROR:\s+([0-9A-Z]{5}):/.exec(text ?? "")?.[1] ?? null;
}

// The SQLSTATE of a statement that must fail, run in its own transaction.
function refused(db, statement, { role = null, setup = "" } = {}) {
  const result = psql(
    [
      "begin;",
      setup,
      role === null ? "" : `set local role ${role};`,
      statement,
      "commit;",
    ].join("\n"),
    db,
  );
  assert.notEqual(result.status, 0, `expected a refusal: ${statement}`);
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

// One statement as a role and JWT subject (and optional JWT claims), in its
// own committed transaction: the last output line, or "ERROR <sqlstate>".
// MVP-001 S2: a request with a subject carries claims with "aal": "aal2"
// (merged under any explicit claims) unless aal names another level; aal
// null keeps only the explicit claims.
function as(
  db,
  role,
  sub,
  statement,
  { claims: explicit = null, aal = "aal2" } = {},
) {
  const claims =
    sub !== null && aal !== null
      ? { sub, role, aal, ...(explicit ?? {}) }
      : explicit;
  const result = psql(
    [
      "begin;",
      `set local role ${role};`,
      sub === null
        ? ""
        : `select set_config('request.jwt.claim.sub', ${lit(sub)}, true) is not null;`,
      claims === null
        ? ""
        : `select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true) is not null;`,
      statement,
      "commit;",
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

// A staff function's first answer row, as JSON, called by a JWT subject.
function staffRow(db, sub, call, options = {}) {
  const value = as(
    db,
    "authenticated",
    sub,
    `select to_jsonb(r) from ${call} as r;`,
    options,
  );
  assert.ok(!value.startsWith("ERROR"), `${call}: ${value}`);
  return JSON.parse(value);
}

function staffText(db, sub, call, options = {}) {
  return as(db, "authenticated", sub, `select ${call};`, options);
}

const uid = () => randomUUID();

function count(db, table, where = "true") {
  return Number(
    sql(db, `select count(*) from public.${table} where ${where};`),
  );
}

const FIXTURE = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create database ${BASE} template template0 encoding 'UTF8' locale 'C';
\\connect ${BASE}
create schema auth;
create table auth.users (id uuid primary key);
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

function startCluster() {
  const identity = unprivilegedIdentity();
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "rosuno-mvp-001-s1-db-proof-"),
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
      "",
    ].join("\n"),
  );
  const start = run("pg_ctl", [
    "-D",
    dataDir,
    "-l",
    path.join(tmp, "postgres.log"),
    "-w",
    "-t",
    "60",
    "-s",
    "start",
  ]);
  assert.equal(start.status, 0, start.stderr);
  state.started = true;
  const settings = JSON.parse(
    sql(
      "postgres",
      "select json_build_object('version', current_setting('server_version'), 'listen_addresses', current_setting('listen_addresses'), 'tcp', inet_server_addr() is not null)::text;",
    ),
  );
  assert.equal(settings.listen_addresses, "");
  assert.equal(settings.tcp, false);
  report.cluster = { ...settings, postmaster_uid: identity.uid };
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

function applyMigrations() {
  const files = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const registered = new Set(
    JSON.parse(
      fs.readFileSync(
        path.join(
          REPOSITORY_ROOT,
          "governance/migrations/reviewed-migrations.json",
        ),
        "utf8",
      ),
    ).migrations.map((migration) => migration.artifact_path),
  );
  for (const file of S1_MIGRATIONS) {
    assert.ok(files.includes(file), `${file} is present`);
    assert.ok(
      registered.has(`supabase/migrations/${file}`),
      `${file} is registered`,
    );
  }
  // MVP-001 S2 re-pin (was: S1 migrations apply last): S1 is contiguous, in
  // order, directly after P5-001, and every later migration is registered.
  const s1 = files.indexOf(S1_MIGRATIONS[0]);
  assert.ok(s1 > 0, "S1 migrations are present");
  assert.equal(
    files[s1 - 1],
    "20261115140653_p5_001_client_intake_foundation.sql",
    "S1 migrations follow P5-001",
  );
  assert.deepEqual(
    files.slice(s1, s1 + 4),
    [...S1_MIGRATIONS],
    "S1 migrations apply in order",
  );
  for (const file of files.slice(s1 + 4)) {
    assert.ok(
      registered.has(`supabase/migrations/${file}`),
      `${file} is a registered later migration`,
    );
  }
  report.migrations.later_registered = files.slice(s1 + 4);
  sql("postgres", FIXTURE);
  for (const file of files) {
    const result = run(
      "psql",
      [
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-1",
        "-h",
        state.socketDir,
        "-p",
        String(PORT),
        "-U",
        "postgres",
        "-d",
        BASE,
      ],
      fs.readFileSync(path.join(MIGRATIONS, file), "utf8"),
    );
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
  report.migrations.applied = files.length;
  report.migrations.s1 = [...S1_MIGRATIONS];
  for (const db of Object.values(DBS)) {
    sql("postgres", `create database ${db} template ${BASE};`);
  }
}

// ---------------------------------------------------------------------------
// Synthetic seed (per database)
// ---------------------------------------------------------------------------

const worlds = {};

function newAccount(db, accountState = "active") {
  const auth = uid();
  const user = uid();
  sql(
    db,
    `insert into auth.users (id) values ('${auth}');
     insert into public.users (id, auth_user_id, account_state) values ('${user}', '${auth}', '${accountState}');`,
  );
  return { auth, user };
}

function newStaff(db, grants, { grantor = null } = {}) {
  const ids = newAccount(db);
  sql(
    db,
    `insert into public.staff_profiles (user_id, staff_state) values ('${ids.user}', 'active');`,
  );
  const grantIds = grants.map((g) => {
    const id = uid();
    sql(
      db,
      `insert into public.capability_grants (id, user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at, expires_at, revoked_at)
       values ('${id}', '${ids.user}', ${lit(g.capability)}, '${grantor ?? ids.user}', ${lit(g.jurisdiction ?? null)},
               now() - interval '1 day', ${g.expiresAt ?? "null"}, ${g.revokedAt ?? "null"});`,
    );
    return id;
  });
  return { ...ids, grants: grantIds };
}

function seed(db) {
  const jurisdiction = uid();
  const other = uid();
  sql(
    db,
    `insert into public.jurisdictions (id, code, name, region_type) values
       ('${jurisdiction}', 'SYN_A', 'Synthetic A', 'synthetic'),
       ('${other}', 'SYN_B', 'Synthetic B', 'synthetic');`,
  );
  const grantor = newAccount(db);
  sql(
    db,
    `insert into public.staff_profiles (user_id, staff_state) values ('${grantor.user}', 'active');`,
  );
  const admin = newStaff(
    db,
    [
      { capability: "manage_policy_configuration" },
      { capability: "manage_jurisdiction_configuration" },
      { capability: "authorize_jurisdiction_launch" },
      { capability: "manage_staff_capabilities" },
      { capability: "manage_attorney_verification" },
    ],
    { grantor: grantor.user },
  );
  const attorneyAccount = newAccount(db);
  const attorney = uid();
  sql(
    db,
    `insert into public.attorney_profiles (id, user_id, profile_state) values ('${attorney}', '${attorneyAccount.user}', 'approved');
     insert into public.licenses (attorney_id, jurisdiction_id, license_number, reported_status)
       values ('${attorney}', '${jurisdiction}', 'SYN-LIC-1', 'synthetic-active');`,
  );
  worlds[db] = {
    jurisdiction,
    other,
    grantor,
    admin,
    attorney,
    attorneyAccount,
  };
  return worlds[db];
}

// Owner-level policy rows: a draft, walked through the lifecycle as the
// trigger allows (insert as draft, verified authority, then each step).
function ownerDraft(
  db,
  {
    type = "referral",
    jurisdiction,
    label,
    parameters = {},
    from = "now() - interval '1 day'",
    until = "null",
    development = false,
  },
) {
  const id = uid();
  sql(
    db,
    `insert into public.policy_versions (id, policy_type_code, jurisdiction_id, version_label, parameters, status, effective_from, effective_until, development_only)
     values ('${id}', ${lit(type)}, ${lit(jurisdiction)}, ${lit(label)}, ${lit(parameters)}::jsonb, 'draft', ${from}, ${until}, ${development});`,
  );
  return id;
}

function ownerVerifiedReference(db, version, verifier) {
  sql(
    db,
    `insert into public.policy_authority_references (policy_version_id, authority_type, citation_text, source_title, retrieved_at, verified_by_user_id, verification_status)
     values ('${version}', 'synthetic', 'synthetic citation', 'synthetic source', now(), '${verifier}', 'verified');`,
  );
}

function ownerActivate(db, version, approver) {
  sql(
    db,
    `update public.policy_versions set status = 'internal_review' where id = '${version}';
     update public.policy_versions set status = 'counsel_review' where id = '${version}';
     update public.policy_versions set status = 'approved', approved_at = now() - interval '2 days', approved_by_user_id = '${approver}' where id = '${version}';
     update public.policy_versions set status = 'active' where id = '${version}';`,
  );
}

function ownerActivePolicy(db, options) {
  const id = ownerDraft(db, options);
  ownerVerifiedReference(db, id, worlds[db].grantor.user);
  ownerActivate(db, id, worlds[db].grantor.user);
  return id;
}

// A development row planted by the owner with every trigger bypassed.
function plantDevelopmentRow(
  db,
  { type = "referral", jurisdiction, label, parameters = {} },
) {
  const id = uid();
  sql(
    db,
    `begin;
     set local session_replication_role = replica;
     insert into public.policy_versions (id, policy_type_code, jurisdiction_id, version_label, parameters, status, effective_from, development_only)
       values ('${id}', ${lit(type)}, ${lit(jurisdiction)}, ${lit(label)}, ${lit(parameters)}::jsonb, 'draft', now() - interval '1 day', true);
     commit;`,
  );
  return id;
}

function select(
  db,
  type,
  jurisdiction,
  { claims = null, asOf = "now()" } = {},
) {
  const statement = `select to_jsonb(r) from public.policy_select_version(${lit(type)}, ${lit(jurisdiction)}::uuid, null::uuid, ${asOf}) as r;`;
  const value =
    claims === null
      ? sql(db, statement)
      : as(db, "postgres", null, statement, { claims });
  assert.ok(!value.startsWith("ERROR"), value);
  return JSON.parse(value);
}

function eligibilitySelection(db, jurisdiction) {
  return JSON.parse(
    sql(
      db,
      `select public.eligibility_selected_policy('${jurisdiction}', now())::text;`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

let failed = false;

async function check(name, body) {
  try {
    const detail = await body();
    report.checks.push({
      name,
      result: "PASS",
      ...(detail === undefined ? {} : { detail }),
    });
    process.stderr.write(`[s1-proof] PASS ${name}\n`);
  } catch (error) {
    failed = true;
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
    process.stderr.write(`[s1-proof] FAIL ${name}\n${error?.stack ?? error}\n`);
  }
}

const D = DBS;

async function environmentChecks() {
  await check(
    "ENV-1 initialization rejects an unknown class, a missing or malformed project reference for staging or production, and any project reference for development; the database stays unrecorded",
    () => {
      for (const [klass, ref] of [
        ["test", null],
        [null, null],
        ["Production", PRODUCTION_REF],
        ["staging", null],
        ["production", null],
        ["staging", "short"],
        ["production", "ABCDEFGHIJKLMNOPQRST"],
        ["production", "abcdefghijklmnopqrst1"],
        ["production", "abcdefghij-lmnopqrst"],
        ["development", PRODUCTION_REF],
        ["development", ""],
      ]) {
        assert.equal(
          refused(
            D.unrecorded,
            `select public.record_deployment_environment(${lit(klass)}, ${lit(ref)});`,
          ),
          "22023",
          `${klass}/${ref}`,
        );
      }
      assert.equal(count(D.unrecorded, "deployment_environment"), 0);
      assert.equal(
        sql(D.unrecorded, "select public.rosuno_environment_class();"),
        "unrecorded",
      );
      assert.equal(
        sql(D.unrecorded, "select public.rosuno_environment_status();"),
        "environment_unrecorded",
      );
    },
  );
  await check(
    "ENV-2 recording each class: disposable databases run as development; staging and production carry their project reference; each recording is audited once",
    () => {
      sql(
        D.development,
        "select public.record_deployment_environment('development', null);",
      );
      sql(
        D.staging,
        `select public.record_deployment_environment('staging', '${STAGING_REF}');`,
      );
      sql(
        D.production,
        `select public.record_deployment_environment('production', '${PRODUCTION_REF}');`,
      );
      const expected = {
        [D.development]: {
          environment_class: "development",
          project_ref: null,
        },
        [D.staging]: { environment_class: "staging", project_ref: STAGING_REF },
        [D.production]: {
          environment_class: "production",
          project_ref: PRODUCTION_REF,
        },
        [D.unrecorded]: { environment_class: "unrecorded", project_ref: null },
      };
      for (const [db, identity] of Object.entries(expected)) {
        assert.deepEqual(
          JSON.parse(
            sql(
              db,
              "select to_jsonb(r) from public.deployment_environment_identity() as r;",
            ),
          ),
          identity,
          db,
        );
        assert.equal(
          count(
            db,
            "audit_events",
            "action_code = 'deployment_environment.recorded' and actor_type = 'database_owner'",
          ),
          db === D.unrecorded ? 0 : 1,
        );
      }
      // An authenticated session reads the same identity.
      assert.equal(
        as(
          D.production,
          "authenticated",
          null,
          "select project_ref from public.deployment_environment_identity();",
        ),
        PRODUCTION_REF,
      );
    },
  );
  await check(
    "ENV-3 a second initialization is refused, and so is any update, delete, or truncate of the record, even by the owner",
    () => {
      for (const db of [D.development, D.staging, D.production]) {
        assert.equal(
          refused(
            db,
            "select public.record_deployment_environment('development', null);",
          ),
          "55000",
        );
        assert.equal(
          refused(
            db,
            `select public.record_deployment_environment('production', '${OTHER_REF}');`,
          ),
          "55000",
        );
        assert.equal(
          refused(
            db,
            "update public.deployment_environment set environment_class = 'production';",
          ),
          "55000",
        );
        assert.equal(
          refused(
            db,
            `update public.deployment_environment set project_ref = '${OTHER_REF}';`,
          ),
          "55000",
        );
        assert.equal(
          refused(db, "delete from public.deployment_environment;"),
          "55000",
        );
        assert.equal(
          refused(db, "truncate public.deployment_environment;"),
          "55000",
        );
        assert.equal(count(db, "deployment_environment"), 1);
      }
    },
  );
  await check(
    "ENV-4 anon, authenticated, and service_role cannot read or write deployment_environment, cannot write policy_versions, and cannot execute the initialization function; anon cannot execute the accessor; the internal environment and gate functions are not executable by any API role",
    () => {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const db = D.production;
        assert.equal(
          refused(db, "select count(*) from public.deployment_environment;", {
            role,
          }),
          "42501",
          role,
        );
        assert.equal(
          refused(
            db,
            "insert into public.deployment_environment (environment_class, project_ref) values ('development', null);",
            { role },
          ),
          "42501",
          role,
        );
        assert.equal(
          refused(
            db,
            "update public.deployment_environment set project_ref = null;",
            { role },
          ),
          "42501",
          role,
        );
        assert.equal(
          refused(db, "delete from public.deployment_environment;", { role }),
          "42501",
          role,
        );
        assert.equal(
          refused(
            db,
            "select public.record_deployment_environment('development', null);",
            { role },
          ),
          "42501",
          role,
        );
        assert.equal(
          refused(
            db,
            `insert into public.policy_versions (policy_type_code, version_label, parameters) values ('referral', 'x', '{}'::jsonb);`,
            { role },
          ),
          "42501",
          role,
        );
        assert.equal(
          refused(
            db,
            "update public.policy_versions set version_label = 'x';",
            { role },
          ),
          "42501",
          role,
        );
        assert.equal(
          refused(db, "delete from public.policy_versions;", { role }),
          "42501",
          role,
        );
        for (const fn of [
          "public.rosuno_environment_class()",
          "public.rosuno_environment_status()",
          "public.policy_select_version(text, uuid, uuid, timestamptz)",
          "public.production_financial_gate(uuid, text, uuid, timestamptz)",
          "public.launch_gates_passed(uuid)",
          "public.record_deployment_environment(text, text)",
        ]) {
          assert.equal(
            sql(
              db,
              `select has_function_privilege('${role}', '${fn}', 'execute');`,
            ),
            "f",
            `${role} ${fn}`,
          );
        }
      }
      assert.equal(
        refused(
          D.production,
          "select * from public.deployment_environment_identity();",
          { role: "anon" },
        ),
        "42501",
      );
      assert.equal(
        sql(
          D.production,
          "select has_function_privilege('authenticated', 'public.deployment_environment_identity()', 'execute');",
        ),
        "t",
      );
    },
  );
}

async function selectionChecks() {
  await check(
    "PS-A2-P1 a staging-class database selects an effective development configuration, through the resolver and the eligibility selection",
    () => {
      const w = worlds[D.staging];
      const dev = ownerDraft(D.staging, {
        jurisdiction: w.jurisdiction,
        label: "staging-dev-1",
        development: true,
      });
      assert.deepEqual(select(D.staging, "referral", w.jurisdiction), {
        outcome: "selected",
        policy_version_id: dev,
        development_only: true,
      });
      const eligibility = ownerDraft(D.staging, {
        type: "eligibility",
        jurisdiction: w.jurisdiction,
        label: "staging-dev-eligibility",
        parameters: ELIGIBILITY_PARAMETERS,
        development: true,
      });
      const selected = eligibilitySelection(D.staging, w.jurisdiction);
      assert.equal(selected.status, "selected");
      assert.equal(selected.policy_version_id, eligibility);
      // A staff member creates one through the configuration function too.
      const created = staffRow(
        D.staging,
        w.admin.auth,
        `public.staff_create_policy_version('fee', '${w.jurisdiction}', null, 'staging-dev-fee', '{}'::jsonb, now() - interval '1 hour', null, null, true)`,
      );
      assert.equal(created.outcome, "created");
      assert.equal(
        select(D.staging, "fee", w.jurisdiction).policy_version_id,
        created.policy_version_id,
      );
    },
  );
  await check(
    "PS-A2-P2 a production-class database selects an active, effective authority version with verified provenance; the development database selects authority versions too",
    () => {
      for (const db of [D.production, D.development]) {
        const w = worlds[db];
        const active = ownerActivePolicy(db, {
          type: "referral",
          jurisdiction: w.jurisdiction,
          label: "authority-1",
        });
        assert.deepEqual(select(db, "referral", w.jurisdiction), {
          outcome: "selected",
          policy_version_id: active,
          development_only: false,
        });
        const eligibility = ownerActivePolicy(db, {
          type: "eligibility",
          jurisdiction: w.jurisdiction,
          label: "authority-eligibility",
          parameters: ELIGIBILITY_PARAMETERS,
        });
        assert.equal(
          eligibilitySelection(db, w.jurisdiction).policy_version_id,
          eligibility,
        );
      }
    },
  );
  await check(
    "PS-A2-N1 creating a development configuration is refused when the class is production or unrecorded, by the owner and through the staff function",
    () => {
      for (const db of [D.production, D.unrecorded]) {
        const w = worlds[db];
        assert.equal(
          refused(
            db,
            `insert into public.policy_versions (policy_type_code, jurisdiction_id, version_label, parameters, status, effective_from, development_only)
             values ('cancellation', '${w.jurisdiction}', 'dev-refused', '{}'::jsonb, 'draft', now(), true);`,
          ),
          "23514",
          db,
        );
      }
      const w = worlds[D.production];
      assert.equal(
        staffRow(
          D.production,
          w.admin.auth,
          `public.staff_create_policy_version('cancellation', '${w.jurisdiction}', null, 'dev-refused', '{}'::jsonb, now(), null, null, true)`,
        ).outcome,
        "environment_refused",
      );
      const u = worlds[D.unrecorded];
      assert.equal(
        staffRow(
          D.unrecorded,
          u.admin.auth,
          `public.staff_create_policy_version('cancellation', '${u.jurisdiction}', null, 'dev-refused', '{}'::jsonb, now(), null, null, true)`,
        ).outcome,
        "environment_unrecorded",
      );
      for (const db of [D.production, D.unrecorded]) {
        assert.equal(count(db, "policy_versions", "development_only"), 0);
      }
    },
  );
  await check(
    "PS-A2-N2 a development row planted by the owner with triggers bypassed is never selected in a production-class database, by the resolver, the eligibility selection, or the financial gate",
    () => {
      const w = worlds[D.production];
      plantDevelopmentRow(D.production, {
        type: "refund",
        jurisdiction: w.jurisdiction,
        label: "planted-refund",
      });
      assert.equal(
        select(D.production, "refund", w.jurisdiction).outcome,
        "no_applicable_policy",
      );
      plantDevelopmentRow(D.production, {
        type: "eligibility",
        jurisdiction: w.other,
        label: "planted-eligibility",
        parameters: ELIGIBILITY_PARAMETERS,
      });
      const selection = eligibilitySelection(D.production, w.other);
      assert.notEqual(selection.status, "selected");
      assert.equal(
        sql(
          D.production,
          `select to_jsonb(r) ->> 'permitted' from public.production_financial_gate('${w.jurisdiction}', 'refund', null, now()) as r;`,
        ),
        "false",
      );
    },
  );
  await check(
    "PS-A2-N3 an unrecorded database selects nothing and refuses with environment_unrecorded; the production financial gate is false",
    () => {
      const w = worlds[D.unrecorded];
      // Rows that would be selectable elsewhere.
      ownerActivePolicy(D.unrecorded, {
        type: "referral",
        jurisdiction: w.jurisdiction,
        label: "unrecorded-authority",
      });
      assert.deepEqual(select(D.unrecorded, "referral", w.jurisdiction), {
        outcome: "environment_unrecorded",
        policy_version_id: null,
        development_only: null,
      });
      assert.deepEqual(eligibilitySelection(D.unrecorded, w.jurisdiction), {
        status: "undetermined",
        reason: "environment_unrecorded",
      });
      assert.deepEqual(
        JSON.parse(
          sql(
            D.unrecorded,
            `select to_jsonb(r) from public.production_financial_gate('${w.jurisdiction}', 'referral', null, now()) as r;`,
          ),
        ),
        { permitted: false, reason: "environment_unrecorded" },
      );
    },
  );
  await check(
    "PS-A2-N4 incomplete drafts (draft, internal_review, counsel_review, not development) are never selected in any class, even with verified authority",
    () => {
      for (const db of [D.development, D.staging, D.production]) {
        const w = worlds[db];
        const version = ownerDraft(db, {
          type: "notification",
          jurisdiction: w.jurisdiction,
          label: "incomplete",
        });
        ownerVerifiedReference(db, version, w.grantor.user);
        for (const status of ["draft", "internal_review", "counsel_review"]) {
          if (status !== "draft") {
            sql(
              db,
              `update public.policy_versions set status = '${status}' where id = '${version}';`,
            );
          }
          assert.equal(
            select(db, "notification", w.jurisdiction).outcome,
            "no_applicable_policy",
            `${db} ${status}`,
          );
        }
      }
    },
  );
  await check(
    "PS-A2-N5 a development configuration outside its effective window is not selected",
    () => {
      const w = worlds[D.staging];
      ownerDraft(D.staging, {
        type: "retention",
        jurisdiction: w.jurisdiction,
        label: "future",
        from: "now() + interval '1 day'",
        development: true,
      });
      ownerDraft(D.staging, {
        type: "retention",
        jurisdiction: w.jurisdiction,
        label: "past",
        from: "now() - interval '3 days'",
        until: "now() - interval '1 day'",
        development: true,
      });
      assert.equal(
        select(D.staging, "retention", w.jurisdiction).outcome,
        "no_applicable_policy",
      );
      // Inside the future row's window it is selected.
      assert.equal(
        select(D.staging, "retention", w.jurisdiction, {
          asOf: "now() + interval '2 days'",
        }).outcome,
        "selected",
      );
    },
  );
  await check(
    "PS-A2-N6 changing a development configuration's development_only, scope, label, parameters, effective_from, or status is refused, and so is a second change to effective_until",
    () => {
      const w = worlds[D.staging];
      const dev = ownerDraft(D.staging, {
        type: "reporting",
        jurisdiction: w.jurisdiction,
        label: "fixed",
        development: true,
      });
      for (const assignment of [
        "development_only = false",
        "policy_type_code = 'governance'",
        `jurisdiction_id = '${w.other}'`,
        "jurisdiction_id = null",
        "version_label = 'changed'",
        `parameters = '{"changed": true}'::jsonb`,
        "effective_from = now() - interval '5 days'",
        "status = 'internal_review'",
      ]) {
        assert.equal(
          refused(
            D.staging,
            `update public.policy_versions set ${assignment} where id = '${dev}';`,
          ),
          "55000",
          assignment,
        );
      }
      sql(
        D.staging,
        `update public.policy_versions set effective_until = now() + interval '1 day' where id = '${dev}';`,
      );
      assert.equal(
        refused(
          D.staging,
          `update public.policy_versions set effective_until = now() + interval '2 days' where id = '${dev}';`,
        ),
        "55000",
      );
      assert.equal(
        refused(
          D.staging,
          `delete from public.policy_versions where id = '${dev}';`,
        ),
        "55000",
      );
    },
  );
  await check(
    "PS-A2-N7 approving a development configuration is refused, and a verified authority reference attached to it does not make it selectable in production",
    () => {
      const s = worlds[D.staging];
      const dev = ownerDraft(D.staging, {
        type: "scheduling",
        jurisdiction: s.jurisdiction,
        label: "approve-me",
        development: true,
      });
      ownerVerifiedReference(D.staging, dev, s.grantor.user);
      assert.equal(
        refused(
          D.staging,
          `update public.policy_versions set status = 'approved', approved_at = now(), approved_by_user_id = '${s.grantor.user}' where id = '${dev}';`,
        ),
        "55000",
      );
      const updatedAt = sql(
        D.staging,
        `select updated_at from public.policy_versions where id = '${dev}';`,
      );
      assert.equal(
        staffText(
          D.staging,
          s.admin.auth,
          `public.staff_transition_policy_version('${dev}', '${updatedAt}', 'internal_review')`,
        ),
        "locked",
      );
      const p = worlds[D.production];
      const planted = plantDevelopmentRow(D.production, {
        type: "scheduling",
        jurisdiction: p.jurisdiction,
        label: "planted-verified",
      });
      ownerVerifiedReference(D.production, planted, p.grantor.user);
      assert.equal(
        select(D.production, "scheduling", p.jurisdiction).outcome,
        "no_applicable_policy",
      );
    },
  );
  await check(
    "PS-A2-N8 in a production-class database a caller-supplied development policy reference to staff_record_eligibility_evaluation is refused, while the derived determination is accepted",
    () => {
      const w = worlds[D.production];
      const planted = plantDevelopmentRow(D.production, {
        type: "eligibility",
        jurisdiction: w.other,
        label: "planted-for-evaluation",
        parameters: ELIGIBILITY_PARAMETERS,
      });
      sql(
        D.production,
        `insert into public.licenses (attorney_id, jurisdiction_id, license_number, reported_status) values ('${w.attorney}', '${w.other}', 'SYN-LIC-B', 'synthetic-active');`,
      );
      const asOf = sql(D.production, "select to_json(now())::text;").replaceAll(
        '"',
        "",
      );
      const derived = JSON.parse(
        sql(
          D.production,
          `select public.eligibility_assessment('${w.attorney}', '${w.other}', null, '${asOf}')::text;`,
        ),
      );
      assert.deepEqual(derived.policy_references, []);
      const call = (references) =>
        staffText(
          D.production,
          w.admin.auth,
          `public.staff_record_eligibility_evaluation(null, '${w.attorney}', '${w.other}', 'jurisdiction', null, '${asOf}', ${lit(derived.result)}, ${lit(derived.factor_results)}::jsonb, ${lit(references)}::jsonb, ${lit(derived.evidence_references)}::jsonb)`,
        );
      const before = count(D.production, "eligibility_evaluations");
      assert.equal(
        call([
          {
            policy_version_id: planted,
            version_label: "planted-for-evaluation",
            policy_type_code: "eligibility",
          },
        ]),
        "invalid",
      );
      assert.equal(count(D.production, "eligibility_evaluations"), before);
      assert.equal(call(derived.policy_references), "applied");
      assert.equal(count(D.production, "eligibility_evaluations"), before + 1);
      // A caller-chosen evaluation key is refused (SCH-1).
      assert.equal(
        staffText(
          D.production,
          w.admin.auth,
          `public.staff_record_eligibility_evaluation('${uid()}', '${w.attorney}', '${w.other}', 'jurisdiction', null, '${asOf}', ${lit(derived.result)}, ${lit(derived.factor_results)}::jsonb, '[]'::jsonb, ${lit(derived.evidence_references)}::jsonb)`,
        ),
        "invalid",
      );
    },
  );
  await check(
    "PS-A2-N9 two applicable versions of any kind yield a conflict and no selection",
    () => {
      const w = worlds[D.staging];
      ownerActivePolicy(D.staging, {
        type: "governance",
        jurisdiction: w.jurisdiction,
        label: "authority-a",
      });
      ownerDraft(D.staging, {
        type: "governance",
        jurisdiction: w.jurisdiction,
        label: "dev-a",
        development: true,
      });
      assert.deepEqual(select(D.staging, "governance", w.jurisdiction), {
        outcome: "policy_conflict",
        policy_version_id: null,
        development_only: null,
      });
      ownerDraft(D.staging, {
        type: "bookability",
        jurisdiction: w.jurisdiction,
        label: "dev-1",
        development: true,
      });
      ownerDraft(D.staging, {
        type: "bookability",
        jurisdiction: w.jurisdiction,
        label: "dev-2",
        development: true,
      });
      assert.equal(
        select(D.staging, "bookability", w.jurisdiction).outcome,
        "policy_conflict",
      );
      const p = worlds[D.production];
      ownerActivePolicy(D.production, {
        type: "engagement",
        jurisdiction: p.jurisdiction,
        label: "authority-1",
      });
      ownerActivePolicy(D.production, {
        type: "engagement",
        jurisdiction: p.jurisdiction,
        label: "authority-2",
      });
      assert.equal(
        select(D.production, "engagement", p.jurisdiction).outcome,
        "policy_conflict",
      );
      // No policy at all, and a missing type, fail honestly.
      assert.equal(
        select(D.production, "payment_flow", p.jurisdiction).outcome,
        "no_applicable_policy",
      );
      assert.equal(
        JSON.parse(
          sql(
            D.production,
            "select to_jsonb(r) from public.policy_select_version(null, null, null, now()) as r;",
          ),
        ).outcome,
        "invalid",
      );
    },
  );
  await check(
    "PS-A2-N10 a JWT issuer naming another project yields environment_mismatch; the database's own project, and a non-project issuer, are accepted",
    () => {
      const w = worlds[D.production];
      const issuer = (ref) => ({
        iss: `https://${ref}.supabase.co/auth/v1`,
        sub: w.admin.auth,
        role: "authenticated",
      });
      assert.equal(
        select(D.production, "referral", w.jurisdiction, {
          claims: issuer(OTHER_REF),
        }).outcome,
        "environment_mismatch",
      );
      assert.equal(
        select(D.production, "referral", w.jurisdiction, {
          claims: issuer(PRODUCTION_REF),
        }).outcome,
        "selected",
      );
      // A development database reached with any hosted project's token.
      const d = worlds[D.development];
      assert.equal(
        select(D.development, "referral", d.jurisdiction, {
          claims: issuer(PRODUCTION_REF),
        }).outcome,
        "environment_mismatch",
      );
      // Unreadable claims are a mismatch, never "ok".
      assert.equal(
        JSON.parse(
          as(
            D.production,
            "postgres",
            null,
            `select set_config('request.jwt.claims', 'not json', true) is not null; select to_jsonb(r) from public.policy_select_version('referral', '${w.jurisdiction}', null, now()) as r;`,
          ),
        ).outcome,
        "environment_mismatch",
      );
      // The staff configuration functions and the eligibility selection
      // refuse under the mismatched issuer too.
      assert.equal(
        JSON.parse(
          as(
            D.production,
            "authenticated",
            w.admin.auth,
            `select to_jsonb(r) from public.staff_create_policy_version('payment', '${w.jurisdiction}', null, 'mismatch', '{}'::jsonb, now(), null, null, false) as r;`,
            { claims: issuer(OTHER_REF) },
          ),
        ).outcome,
        "environment_mismatch",
      );
    },
  );
}

async function lifecycleChecks() {
  await check(
    "POL-1 every version is created as a draft; editing an approved policy is refused; approved-family history is never deleted",
    () => {
      const w = worlds[D.production];
      assert.equal(
        refused(
          D.production,
          `insert into public.policy_versions (policy_type_code, jurisdiction_id, version_label, parameters, status, approved_at, approved_by_user_id, effective_from)
           values ('payment', '${w.jurisdiction}', 'born-active', '{}'::jsonb, 'active', now(), '${w.grantor.user}', now());`,
        ),
        "23514",
      );
      const active = ownerActivePolicy(D.production, {
        type: "payment",
        jurisdiction: w.jurisdiction,
        label: "immutable",
      });
      for (const assignment of [
        `parameters = '{"edited": true}'::jsonb`,
        "version_label = 'edited'",
        "effective_from = now() - interval '9 days'",
        "approved_at = now()",
        "status = 'draft'",
        "status = 'approved'",
      ]) {
        assert.equal(
          refused(
            D.production,
            `update public.policy_versions set ${assignment} where id = '${active}';`,
          ),
          "55000",
          assignment,
        );
      }
      assert.equal(
        refused(
          D.production,
          `delete from public.policy_versions where id = '${active}';`,
        ),
        "55000",
      );
      assert.equal(
        refused(D.production, "truncate public.policy_versions cascade;"),
        "55000",
      );
      // Its authority references are fixed too.
      assert.equal(
        refused(
          D.production,
          `update public.policy_authority_references set citation_text = 'edited' where policy_version_id = '${active}';`,
        ),
        "55000",
      );
      assert.equal(
        refused(
          D.production,
          `delete from public.policy_authority_references where policy_version_id = '${active}';`,
        ),
        "55000",
      );
      // Through the staff function, an approved version is locked.
      const updatedAt = sql(
        D.production,
        `select updated_at from public.policy_versions where id = '${active}';`,
      );
      assert.equal(
        staffText(
          D.production,
          w.admin.auth,
          `public.staff_revise_policy_draft('${active}', '${updatedAt}', 'edited', '{}'::jsonb, now(), null)`,
        ),
        "locked",
      );
      // Ending it once is allowed; a second end is refused.
      assert.equal(
        staffText(
          D.production,
          w.admin.auth,
          `public.staff_end_policy_version('${active}', now() + interval '1 day')`,
        ),
        "applied",
      );
      assert.equal(
        staffText(
          D.production,
          w.admin.auth,
          `public.staff_end_policy_version('${active}', now() + interval '2 days')`,
        ),
        "already_ended",
      );
    },
  );
  await check(
    "POL-2 the staff lifecycle: draft -> internal_review -> counsel_review -> approved only with verified authority and an effective start; each step audited; invalid transitions refused",
    () => {
      const w = worlds[D.production];
      const created = staffRow(
        D.production,
        w.admin.auth,
        `public.staff_create_policy_version('payment', '${w.other}', null, 'staff-lifecycle', '{"synthetic": true}'::jsonb, null, null, null, false)`,
      );
      assert.equal(created.outcome, "created");
      const id = created.policy_version_id;
      const at = () =>
        sql(
          D.production,
          `select updated_at from public.policy_versions where id = '${id}';`,
        );
      const step = (target) =>
        staffText(
          D.production,
          w.admin.auth,
          `public.staff_transition_policy_version('${id}', '${at()}', '${target}')`,
        );
      assert.equal(step("approved"), "invalid_transition");
      assert.equal(step("active"), "invalid_transition");
      assert.equal(step("internal_review"), "applied");
      assert.equal(step("counsel_review"), "applied");
      // No verified authority yet.
      assert.equal(step("approved"), "authority_unverified");
      const reference = staffRow(
        D.production,
        w.admin.auth,
        `public.staff_add_policy_authority_reference('${id}', 'synthetic', 'synthetic citation', 'https://example.test/synthetic', 'synthetic source', now())`,
      );
      assert.equal(reference.outcome, "created");
      assert.equal(step("approved"), "authority_unverified");
      // A plain-http source is refused.
      assert.equal(
        staffRow(
          D.production,
          w.admin.auth,
          `public.staff_add_policy_authority_reference('${id}', 'synthetic', 'c', 'http://example.test/x', 's', now())`,
        ).outcome,
        "invalid",
      );
      assert.equal(
        staffText(
          D.production,
          w.admin.auth,
          `public.staff_decide_policy_authority_reference('${reference.reference_id}', 'verified')`,
        ),
        "applied",
      );
      // Approval needs an effective start.
      assert.equal(step("approved"), "effective_period_required");
      assert.equal(
        staffText(
          D.production,
          w.admin.auth,
          `public.staff_revise_policy_draft('${id}', '${at()}', 'staff-lifecycle', '{"synthetic": true}'::jsonb, now() - interval '1 hour', null)`,
        ),
        "applied",
      );
      assert.equal(step("approved"), "applied");
      assert.equal(step("internal_review"), "invalid_transition");
      assert.equal(step("active"), "applied");
      assert.equal(
        select(D.production, "payment", w.other).policy_version_id,
        id,
      );
      // Once approved, the reference decision is locked.
      assert.equal(
        staffText(
          D.production,
          w.admin.auth,
          `public.staff_decide_policy_authority_reference('${reference.reference_id}', 'rejected')`,
        ),
        "locked",
      );
      const audits = sql(
        D.production,
        `select string_agg(action_code, ',' order by occurred_at, action_code) from public.audit_events where resource_id = '${id}';`,
      );
      assert.ok(audits.includes("policy_version.created"), audits);
      assert.equal(
        count(
          D.production,
          "audit_events",
          `resource_id = '${id}' and actor_user_id = '${w.admin.user}'`,
        ) >= 6,
        true,
      );
    },
  );
  await check(
    "POL-3 policy configuration needs a current manage_policy_configuration grant: expired, revoked, other-capability, and other-jurisdiction grants are denied",
    () => {
      const w = worlds[D.production];
      const call = (sub, jurisdiction = w.jurisdiction) =>
        staffRow(
          D.production,
          sub,
          `public.staff_create_policy_version('payment', ${lit(jurisdiction)}::uuid, null, 'denied-${uid().slice(0, 8)}', '{}'::jsonb, null, null, null, false)`,
        ).outcome;
      const expired = newStaff(
        D.production,
        [
          {
            capability: "manage_policy_configuration",
            expiresAt: "now() - interval '1 hour'",
          },
        ],
        { grantor: w.grantor.user },
      );
      const revoked = newStaff(
        D.production,
        [
          {
            capability: "manage_policy_configuration",
            revokedAt: "now() - interval '1 hour'",
          },
        ],
        { grantor: w.grantor.user },
      );
      const other = newStaff(
        D.production,
        [{ capability: "manage_attorney_verification" }],
        { grantor: w.grantor.user },
      );
      const scoped = newStaff(
        D.production,
        [{ capability: "manage_policy_configuration", jurisdiction: w.other }],
        { grantor: w.grantor.user },
      );
      for (const staff of [expired, revoked, other]) {
        assert.equal(call(staff.auth), "denied");
      }
      assert.equal(call(scoped.auth), "denied");
      assert.equal(call(scoped.auth, w.other), "created");
      assert.equal(call(scoped.auth, null), "denied");
      // Anonymous and attorney callers are denied.
      assert.equal(call(w.attorneyAccount.auth), "denied");
    },
  );
}

async function launchChecks() {
  await check(
    "LG-1 launch: authorization without passed gates is refused; going live needs passed gates and an authorization; the four-way production financial gate opens only when all hold",
    () => {
      const w = worlds[D.production];
      const j = staffRow(
        D.production,
        w.admin.auth,
        "public.staff_create_jurisdiction('SYN_L', 'Synthetic launch', 'synthetic')",
      );
      assert.equal(j.outcome, "created");
      const jid = j.jurisdiction_id;
      const at = () =>
        sql(
          D.production,
          `select updated_at from public.jurisdictions where id = '${jid}';`,
        );
      const gate = (reason) =>
        JSON.parse(
          sql(
            D.production,
            `select to_jsonb(r) from public.production_financial_gate('${jid}', 'referral', null, now()) as r;`,
          ),
        ).reason === reason;
      // No gates defined: nothing passes.
      assert.equal(
        staffRow(
          D.production,
          w.admin.auth,
          `public.staff_grant_launch_authorization('${jid}', 'synthetic')`,
        ).outcome,
        "launch_gates_unmet",
      );
      const g = staffRow(
        D.production,
        w.admin.auth,
        `public.staff_define_launch_gate('${jid}', 'synthetic_gate', true, 'Synthetic gate')`,
      );
      assert.equal(g.outcome, "created");
      assert.equal(
        staffText(
          D.production,
          w.admin.auth,
          `public.staff_change_jurisdiction_lifecycle('${jid}', '${at()}', 'live')`,
        ),
        "launch_gates_unmet",
      );
      assert.equal(
        staffRow(
          D.production,
          w.admin.auth,
          `public.staff_record_launch_gate_evaluation('${g.launch_gate_id}', 'failed', '{}'::jsonb, 'synthetic')`,
        ).outcome,
        "created",
      );
      assert.equal(
        staffRow(
          D.production,
          w.admin.auth,
          `public.staff_grant_launch_authorization('${jid}', 'synthetic')`,
        ).outcome,
        "launch_gates_unmet",
      );
      assert.equal(
        staffRow(
          D.production,
          w.admin.auth,
          `public.staff_record_launch_gate_evaluation('${g.launch_gate_id}', 'passed', '{}'::jsonb, 'synthetic')`,
        ).outcome,
        "created",
      );
      assert.equal(
        staffText(
          D.production,
          w.admin.auth,
          `public.staff_change_jurisdiction_lifecycle('${jid}', '${at()}', 'live')`,
        ),
        "launch_authorization_required",
      );
      assert.ok(gate("jurisdiction_not_live"));
      const authorization = staffRow(
        D.production,
        w.admin.auth,
        `public.staff_grant_launch_authorization('${jid}', 'synthetic')`,
      );
      assert.equal(authorization.outcome, "created");
      assert.equal(
        staffText(
          D.production,
          w.admin.auth,
          `public.staff_change_jurisdiction_lifecycle('${jid}', '${at()}', 'live')`,
        ),
        "applied",
      );
      assert.ok(gate("policy_not_approved"));
      ownerActivePolicy(D.production, {
        type: "referral",
        jurisdiction: jid,
        label: "launch-referral",
      });
      assert.deepEqual(
        JSON.parse(
          sql(
            D.production,
            `select to_jsonb(r) from public.production_financial_gate('${jid}', 'referral', null, now()) as r;`,
          ),
        ),
        { permitted: true, reason: "permitted" },
      );
      // A live jurisdiction's authorization cannot be revoked out from under it.
      assert.equal(
        staffText(
          D.production,
          w.admin.auth,
          `public.staff_revoke_launch_authorization('${authorization.launch_authorization_id}', 'synthetic')`,
        ),
        "jurisdiction_live",
      );
      // Launch history is append-only.
      assert.equal(
        refused(D.production, "delete from public.launch_gate_evaluations;"),
        "55000",
      );
      assert.equal(
        refused(
          D.production,
          "update public.launch_gate_evaluations set reason = 'edited';",
        ),
        "55000",
      );
      assert.equal(
        refused(
          D.production,
          `update public.launch_authorizations set reason = 'edited' where id = '${authorization.launch_authorization_id}';`,
        ),
        "55000",
      );
      // The same gate is never open outside production.
      const s = worlds[D.staging];
      assert.equal(
        JSON.parse(
          sql(
            D.staging,
            `select to_jsonb(r) from public.production_financial_gate('${s.jurisdiction}', 'referral', null, now()) as r;`,
          ),
        ).reason,
        "environment_not_production",
      );
    },
  );
  await check(
    "LG-2 a staff member without authorize_jurisdiction_launch cannot authorize a launch or record a gate evaluation",
    () => {
      const w = worlds[D.production];
      const plain = newStaff(
        D.production,
        [{ capability: "manage_jurisdiction_configuration" }],
        { grantor: w.grantor.user },
      );
      assert.equal(
        staffRow(
          D.production,
          plain.auth,
          `public.staff_grant_launch_authorization('${w.jurisdiction}', 'synthetic')`,
        ).outcome,
        "denied",
      );
    },
  );
}

async function capabilityChecks() {
  await check(
    "CAP-1 capability administration: grant, expiry, and revocation are audited; no self-grant; only active staff may receive a grant; an expired or revoked grant is denied; (MVP-001 S2) an aal1 or claim-less session is denied",
    () => {
      const w = worlds[D.production];
      const target = newStaff(D.production, [], { grantor: w.grantor.user });
      // MVP-001 S2: the same administrator before MFA step-up (aal1) or
      // without JWT claims is denied and grants nothing.
      for (const aal of ["aal1", null]) {
        assert.equal(
          staffRow(
            D.production,
            w.admin.auth,
            `public.staff_grant_capability('${target.user}', 'manage_policy_configuration', null, null)`,
            { aal },
          ).outcome,
          "denied",
          String(aal),
        );
      }
      assert.equal(
        count(D.production, "capability_grants", `user_id = '${target.user}'`),
        0,
      );
      assert.equal(
        staffRow(
          D.production,
          w.admin.auth,
          `public.staff_grant_capability('${w.admin.user}', 'manage_policy_configuration', null, null)`,
        ).outcome,
        "self_grant_refused",
      );
      assert.equal(
        staffRow(
          D.production,
          w.admin.auth,
          `public.staff_grant_capability('${w.attorneyAccount.user}', 'manage_policy_configuration', null, null)`,
        ).outcome,
        "target_not_active_staff",
      );
      const granted = staffRow(
        D.production,
        w.admin.auth,
        `public.staff_grant_capability('${target.user}', 'manage_policy_configuration', null, now() + interval '1 hour')`,
      );
      assert.equal(granted.outcome, "created");
      const probe = () =>
        staffRow(
          D.production,
          target.auth,
          `public.staff_create_policy_version('payment', '${w.jurisdiction}', null, 'cap-${uid().slice(0, 8)}', '{}'::jsonb, null, null, null, false)`,
        ).outcome;
      assert.equal(probe(), "created");
      assert.equal(
        staffText(
          D.production,
          w.admin.auth,
          `public.staff_revoke_capability('${granted.grant_id}')`,
        ),
        "applied",
      );
      assert.equal(
        staffText(
          D.production,
          w.admin.auth,
          `public.staff_revoke_capability('${granted.grant_id}')`,
        ),
        "already_revoked",
      );
      assert.equal(probe(), "denied");
      // A revoked grant stays revoked: history is revocation-only.
      assert.equal(
        refused(
          D.production,
          `update public.capability_grants set revoked_at = null where id = '${granted.grant_id}';`,
        ),
        "55000",
      );
      assert.equal(
        refused(
          D.production,
          `delete from public.capability_grants where id = '${granted.grant_id}';`,
        ),
        "55000",
      );
      for (const action of [
        "capability_grant.granted",
        "capability_grant.revoked",
      ]) {
        assert.equal(
          count(
            D.production,
            "audit_events",
            `resource_id = '${granted.grant_id}' and action_code = '${action}'`,
          ),
          1,
          action,
        );
      }
      // A non-administrator cannot grant.
      const plain = newStaff(
        D.production,
        [{ capability: "manage_policy_configuration" }],
        { grantor: w.grantor.user },
      );
      assert.equal(
        staffRow(
          D.production,
          plain.auth,
          `public.staff_grant_capability('${target.user}', 'manage_policy_configuration', null, null)`,
        ).outcome,
        "denied",
      );
    },
  );
  await check(
    "CAP-2 catalog administration (jurisdictions, service areas, practice areas) is capability-gated and audited",
    () => {
      const w = worlds[D.production];
      const outsider = newStaff(
        D.production,
        [{ capability: "manage_attorney_verification" }],
        { grantor: w.grantor.user },
      );
      assert.equal(
        staffRow(
          D.production,
          outsider.auth,
          "public.staff_create_practice_area('synthetic_area', 'Synthetic area')",
        ).outcome,
        "denied",
      );
      assert.equal(
        staffRow(
          D.production,
          outsider.auth,
          "public.staff_create_jurisdiction('SYN_X', 'Synthetic X', 'synthetic')",
        ).outcome,
        "denied",
      );
      const area = staffRow(
        D.production,
        w.admin.auth,
        "public.staff_create_practice_area('synthetic_area', 'Synthetic area')",
      );
      assert.equal(area.outcome, "created");
      assert.equal(
        staffRow(
          D.production,
          w.admin.auth,
          "public.staff_create_practice_area('synthetic_area', 'Duplicate')",
        ).outcome,
        "conflict",
      );
      assert.equal(
        staffRow(
          D.production,
          w.admin.auth,
          "public.staff_create_practice_area('Bad Code', 'x')",
        ).outcome,
        "invalid",
      );
      assert.equal(
        staffText(
          D.production,
          w.admin.auth,
          `public.staff_set_practice_area_active('${area.practice_area_id}', false)`,
        ),
        "applied",
      );
      assert.equal(
        staffText(
          D.production,
          w.admin.auth,
          `public.staff_set_practice_area_active('${area.practice_area_id}', false)`,
        ),
        "unchanged",
      );
      const service = staffRow(
        D.production,
        w.admin.auth,
        `public.staff_create_service_area('${w.jurisdiction}', 'SYN_SA', 'Synthetic service area', now(), null)`,
      );
      assert.equal(service.outcome, "created");
      for (const id of [area.practice_area_id, service.service_area_id]) {
        assert.ok(
          count(
            D.production,
            "audit_events",
            `resource_id = '${id}' and actor_user_id = '${w.admin.user}'`,
          ) >= 1,
        );
      }
    },
  );
  await check(
    "CAP-3 service_role writes on the configuration relations are narrowed; ordinary sessions read no configuration rows",
    () => {
      const db = D.production;
      for (const table of [
        "policy_versions",
        "policy_authority_references",
        "policy_types",
        "jurisdictions",
        "service_areas",
        "regulatory_modes",
        "jurisdiction_regulatory_modes",
        "launch_gates",
        "launch_gate_evaluations",
        "launch_authorizations",
        "practice_areas",
        "capability_grants",
      ]) {
        for (const privilege of ["insert", "update", "delete", "truncate"]) {
          assert.equal(
            sql(
              db,
              `select has_table_privilege('service_role', 'public.${table}', '${privilege}');`,
            ),
            "f",
            `${table} ${privilege}`,
          );
          for (const role of ["anon", "authenticated"]) {
            assert.equal(
              sql(
                db,
                `select has_table_privilege('${role}', 'public.${table}', '${privilege}');`,
              ),
              "f",
              `${role} ${table} ${privilege}`,
            );
          }
        }
      }
      const w = worlds[db];
      for (const table of [
        "capability_grants",
        "policy_versions",
        "launch_authorizations",
      ]) {
        assert.ok(count(db, table) > 0, table);
        assert.equal(
          as(
            db,
            "authenticated",
            w.attorneyAccount.auth,
            `select count(*) from public.${table};`,
          ),
          "0",
          table,
        );
        assert.equal(
          as(
            db,
            "anon",
            null,
            `select count(*) from public.${table};`,
          ).startsWith("ERROR 42501") ||
            as(db, "anon", null, `select count(*) from public.${table};`) ===
              "0",
          true,
          table,
        );
      }
    },
  );
}

async function conformanceChecks() {
  await check(
    "SCH-4 the policy-type catalog holds exactly the PS section 8.3 and FP-1 codes, and the eligibility selection uses the eligibility code",
    () => {
      const codes = sql(
        D.development,
        "select string_agg(code, ',' order by code) from public.policy_types;",
      ).split(",");
      assert.deepEqual(codes, [...POLICY_TYPES]);
      const w = worlds[D.development];
      // An attorney_eligibility version (the superseded code) is never used.
      assert.equal(
        count(D.development, "policy_types", "code = 'attorney_eligibility'"),
        0,
      );
      assert.equal(
        eligibilitySelection(D.development, w.jurisdiction).status,
        "selected",
      );
    },
  );
  await check(
    "SCH-1 attorney create paths refuse a caller-chosen key and generate one; an update needs both the key and its version",
    () => {
      const w = worlds[D.development];
      const applicant = newAccount(D.development);
      const profile = uid();
      sql(
        D.development,
        `insert into public.attorney_profiles (id, user_id, profile_state) values ('${profile}', '${applicant.user}', 'applicant');`,
      );
      const save = (id, expected, number) =>
        as(
          D.development,
          "authenticated",
          applicant.auth,
          `select public.attorney_save_license_claim(${lit(id)}::uuid, ${lit(expected)}::timestamptz, '${w.jurisdiction}', ${lit(number)}, null, null, null);`,
        );
      assert.equal(save(uid(), null, "SYN-CALLER"), "invalid");
      assert.equal(save(null, "2026-11-04T10:00:00Z", "SYN-NOKEY"), "invalid");
      assert.equal(
        count(D.development, "licenses", `attorney_id = '${profile}'`),
        0,
      );
      assert.equal(save(null, null, "SYN-SERVER"), "applied");
      const generated = sql(
        D.development,
        `select id from public.licenses where attorney_id = '${profile}';`,
      );
      assert.match(generated, /^[0-9a-f-]{36}$/);
      assert.equal(save(null, null, "SYN-SERVER"), "conflict");
      assert.equal(
        count(D.development, "licenses", `attorney_id = '${profile}'`),
        1,
      );
      assert.equal(
        count(D.development, "audit_events", `resource_id = '${generated}'`),
        1,
      );
    },
  );
  await check(
    "SCH-3 availability rules accept only an ISO weekday 1..7 and a time zone name the server knows",
    () => {
      const w = worlds[D.development];
      const insert = (weekday, zone) =>
        `insert into public.availability_rules (attorney_id, rule_kind, timezone_name, weekday, local_start_time, local_end_time, effective_from, active)
         values ('${w.attorney}', 'recurring', ${lit(zone)}, ${weekday}, '09:00', '17:00', current_date, true);`;
      for (const weekday of [0, 8, -1]) {
        assert.equal(
          refused(D.development, insert(weekday, "America/New_York")),
          "23514",
          String(weekday),
        );
      }
      for (const zone of [
        "Mars/Phobos",
        "EST5EDT-not",
        "",
        "america/new_york",
      ]) {
        assert.equal(refused(D.development, insert(1, zone)), "23514", zone);
      }
      for (const [weekday, zone] of [
        [1, "America/New_York"],
        [7, "Europe/Paris"],
        [3, "UTC"],
      ]) {
        sql(D.development, insert(weekday, zone));
      }
      assert.equal(
        count(
          D.development,
          "availability_rules",
          `attorney_id = '${w.attorney}'`,
        ),
        3,
      );
    },
  );
}

async function main() {
  try {
    startCluster();
    applyMigrations();
    for (const db of Object.values(DBS)) {
      seed(db);
    }
    await environmentChecks();
    await selectionChecks();
    await lifecycleChecks();
    await launchChecks();
    await capabilityChecks();
    await conformanceChecks();
  } catch (error) {
    report.error = String(error?.stack ?? error);
    failed = true;
  }
  const cleaned = teardown();
  report.cleanup = cleaned;
  report.result = failed ? "FAIL" : cleaned ? "PASS" : "CLEANUP-FAILED";
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = failed ? 1 : cleaned ? 0 : 2;
}

await main();
