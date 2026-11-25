// P2-924 disposable local PostgreSQL proof: development regulatory mode and the audited bootstrap of the first two
// staff administrators, both for non-production databases only.
//
// Requires the PostgreSQL 16 initdb, pg_ctl and psql binaries; no network. Every migration in supabase/migrations is
// applied, in order, to four databases whose recorded environment classes are staging, development, production and
// unrecorded. The P2-924 migration is pinned by SHA-256.
//
// Preparation mode (before the migration is committed): set P2_924_REPOSITORY_ROOT to a checkout of owner main and
// P2_924_DRAFT_MIGRATION to the draft file; the draft is then applied after every committed migration. In the
// repository neither variable is set.
//
// Run: node apps/web/tests/p2-924-db-proof.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54392;
const REPOSITORY_ROOT =
  process.env.P2_924_REPOSITORY_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATIONS = path.join(REPOSITORY_ROOT, "supabase/migrations");
const P2_924_MIGRATION = "20261128010000_p2_924_development_regulatory_mode_and_staff_bootstrap.sql";
const P2_924_SHA256 = "6971040c3b19565b5a26ebfaa0cc5c4e655a62fa1fda3fae7fa707bfe6d2c1ea";
const DBS = Object.freeze({
  stg: "p2924_staging",
  dev: "p2924_development",
  prd: "p2924_production",
  unr: "p2924_unrecorded",
});
const STAGING_REF = "syntheticstagingproo";
const PRODUCTION_REF = "syntheticproductionx";
const AUTH = "P2-924 proof authorization";
const OUTCOMES = new Set([
  "activated", "already_active", "already_exists", "invalid", "environment_unrecorded", "environment_mismatch",
  "environment_not_permitted", "bootstrapped", "administrator_exists", "user_not_active", "already_staff",
  "authorizer_not_active",
]);

const checks = [];
let state = null;

// ---------------------------------------------------------------------------
// Cluster and psql
// ---------------------------------------------------------------------------

function identity() {
  if (process.getuid() !== 0) return { uid: process.getuid(), gid: process.getgid(), spawn: {} };
  const entry = fs.readFileSync("/etc/passwd", "utf8").split("\n").find((line) => line.startsWith("nobody:"));
  const fields = entry?.split(":") ?? [];
  if (fields[2] !== "65534" || fields[3] !== "65534") {
    throw new Error("no unprivileged nobody:65534 account to run PostgreSQL");
  }
  return { uid: 65534, gid: 65534, spawn: { uid: 65534, gid: 65534 } };
}
const childEnvironment = () => ({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC", HOME: "/" });
function run(tool, args, input) {
  return spawnSync(path.join(BIN, tool), args, {
    env: childEnvironment(),
    encoding: "utf8",
    input,
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
    cwd: state.tmp,
    ...state.id.spawn,
  });
}
const psqlArgs = (db) => [
  "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose",
  "-h", state.sock, "-p", String(PORT), "-U", "postgres", "-d", db,
];
function sql(script, db) {
  const result = run("psql", psqlArgs(db), script);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const sqlstateOf = (text) => /ERROR:\s+([0-9A-Z]{5}):/.exec(text ?? "")?.[1] ?? null;
const lit = (value) => (value === null ? "null" : `'${String(value).replaceAll("'", "''")}'`);

// One statement as an API request in its own transaction: the last output line, or "ERROR <sqlstate>".
function as(role, sub, statement, db) {
  const lines = ["begin;", `set local role ${role};`];
  if (sub !== null) {
    lines.push(`select set_config('request.jwt.claim.sub', ${lit(sub)}, true) is not null;`);
    lines.push(
      `select set_config('request.jwt.claims', ${lit(JSON.stringify({ sub, role, aal: "aal2" }))}, true) is not null;`,
    );
  }
  lines.push(statement, "commit;", "");
  const result = run("psql", psqlArgs(db), lines.join("\n"));
  if (result.status === 0) {
    const out = result.stdout.trim().split("\n");
    return out[out.length - 1];
  }
  return `ERROR ${sqlstateOf(result.stderr)}`;
}

// An owner statement that must fail: its SQLSTATE.
function refused(statement, db) {
  const result = run("psql", psqlArgs(db), ["begin;", statement, "commit;"].join("\n"));
  assert.notEqual(result.status, 0, `expected a refusal: ${statement}`);
  return sqlstateOf(result.stderr);
}

// A psql session running in the background; resolves to its output lines that are function outcomes.
function background(script, db) {
  return new Promise((resolve) => {
    const child = spawn(path.join(BIN, "psql"), psqlArgs(db), {
      env: childEnvironment(),
      cwd: state.tmp,
      ...state.id.spawn,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) =>
      resolve({
        code,
        err,
        lines: out.split("\n"),
        outcomes: out.split("\n").map((l) => l.split("|")[0]).filter((l) => OUTCOMES.has(l)),
      }),
    );
    child.stdin.end(script);
  });
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: String(error.message).replace(/\s+/g, " ").slice(0, 700) });
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: String(error.message).replace(/\s+/g, " ").slice(0, 700) });
  }
}

function startCluster() {
  const id = identity();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rosuno-p2-924-db-proof-"));
  const sock = path.join(tmp, "socket");
  state = { id, tmp, sock, started: false, data: path.join(tmp, "data") };
  fs.chmodSync(tmp, 0o700);
  fs.chownSync(tmp, id.uid, id.gid);
  fs.mkdirSync(sock, { mode: 0o700 });
  fs.chownSync(sock, id.uid, id.gid);
  const init = run("initdb", [
    "-D", state.data, "-U", "postgres", "--auth=trust", "--encoding=UTF8", "--locale=C", "--no-instructions",
    "--no-sync",
  ]);
  assert.equal(init.status, 0, init.stderr);
  fs.writeFileSync(path.join(state.data, "pg_hba.conf"), "local all all trust\n");
  fs.appendFileSync(
    path.join(state.data, "postgresql.conf"),
    `\nlisten_addresses = ''\nport = ${PORT}\nunix_socket_directories = '${sock}'\n` +
      "unix_socket_permissions = 0700\nfsync = off\ntimezone = 'UTC'\nmax_connections = 40\n",
  );
  const started = run("pg_ctl", ["-D", state.data, "-w", "-t", "60", "-s", "-l", path.join(tmp, "postgres.log"), "start"]);
  assert.equal(started.status, 0, started.stderr);
  state.started = true;
}
function teardown() {
  if (state === null) return;
  if (state.started) run("pg_ctl", ["-D", state.data, "-w", "-t", "60", "-s", "-m", "fast", "stop"]);
  fs.rmSync(state.tmp, { recursive: true, force: true });
}

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

function migrationPaths() {
  const committed = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const draft = process.env.P2_924_DRAFT_MIGRATION;
  if (committed.includes(P2_924_MIGRATION)) {
    assert.equal(committed[committed.length - 1], P2_924_MIGRATION, "P2-924 is the newest migration");
    return committed.map((f) => path.join(MIGRATIONS, f));
  }
  assert.ok(draft, "the P2-924 migration is neither committed nor supplied as a draft");
  assert.equal(path.basename(draft), P2_924_MIGRATION);
  return [...committed.map((f) => path.join(MIGRATIONS, f)), draft];
}
function apply(db, files) {
  for (const file of files) {
    const result = run(
      "psql",
      ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-1", "-h", state.sock, "-p", String(PORT), "-U", "postgres", "-d", db],
      fs.readFileSync(file, "utf8"),
    );
    assert.equal(result.status, 0, `${db} ${path.basename(file)}: ${result.stderr}`);
  }
}

function user(db, accountState = "active") {
  const authId = randomUUID();
  sql(`insert into auth.users (id, email) values ('${authId}', 'synthetic-${authId}@proof.invalid');`, db);
  const id = sql(
    `insert into public.users (auth_user_id, display_name, account_state) values ('${authId}', 'Synthetic', '${accountState}') returning id;`,
    db,
  );
  return { id, auth: authId };
}
const jurisdiction = (db, code) =>
  sql(`insert into public.jurisdictions (code, name, region_type) values ('${code}', 'Synthetic ${code}', 'synthetic') returning id;`, db);

const ENV = Object.freeze({
  stg: ["staging", STAGING_REF],
  dev: ["development", null],
  prd: ["production", PRODUCTION_REF],
});
const activate = (key, j, auth = AUTH, env = ENV[key]) =>
  `select outcome || '|' || coalesce(regulatory_mode_id::text, '') from public.activate_development_regulatory_mode(${lit(env[0])}, ${lit(env[1])}, ${j === null ? "null" : lit(j)}, ${lit(auth)});`;
const bootstrap = (key, a, b, by, { expires = null, auth = AUTH, env = ENV[key] } = {}) =>
  `select outcome from public.bootstrap_staff_administrators(${lit(env[0])}, ${lit(env[1])}, ${lit(a)}, ${lit(b)}, ${lit(by)}, ${expires === null ? "null" : expires}, ${lit(auth)});`;
// The epoch seconds a session printed after a marker ("T1|<epoch>").
const stamp = (result, marker) => Number(result.lines.find((l) => l.startsWith(`${marker}|`))?.split("|")[1]);
// Runs `holder` (which holds its locks for 1.5 s before committing) and, 0.4 s later, `contender`. Returns both
// results; the contender's stamp must not precede the holder's pre-commit stamp if it waited for the holder.
async function race(db, holder, contender) {
  const first = background(`begin;\n${holder}\nselect pg_sleep(1.5);\nselect 'T1|' || extract(epoch from clock_timestamp());\ncommit;\n`, db);
  await delay(400);
  const second = background(`${contender}\nselect 'T2|' || extract(epoch from clock_timestamp());\n`, db);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  return { holder: a, contender: b, waited: stamp(b, "T2") >= stamp(a, "T1") };
}
const outcomeOf = (text) => text.split("|")[0];

// ---------------------------------------------------------------------------
// Proof
// ---------------------------------------------------------------------------

const ACTIVATE_SIGNATURE = "public.activate_development_regulatory_mode(text, text, uuid, text)";
const BOOTSTRAP_SIGNATURE = "public.bootstrap_staff_administrators(text, text, uuid, uuid, uuid, timestamptz, text)";

async function prove() {
  startCluster();
  const files = migrationPaths();
  const p2924 = files[files.length - 1];
  check("the P2-924 migration bytes are the pinned bytes", () =>
    assert.equal(createHash("sha256").update(fs.readFileSync(p2924)).digest("hex"), P2_924_SHA256));
  sql(
    "create role anon nologin noinherit; create role authenticated nologin noinherit; create role service_role nologin noinherit bypassrls;",
    "postgres",
  );
  for (const db of Object.values(DBS)) {
    sql(fixtureFor(db), "postgres");
    apply(db, files);
  }
  sql(`select public.record_deployment_environment('staging', '${STAGING_REF}');`, DBS.stg);
  sql("select public.record_deployment_environment('development', null);", DBS.dev);
  sql(`select public.record_deployment_environment('production', '${PRODUCTION_REF}');`, DBS.prd);

  // Shape, privilege and accessor use.
  check("the migration adds exactly two functions and no column", () => {
    const columns = (db) => sql("select count(*) from information_schema.columns where table_schema in ('public', 'auth');", db);
    assert.equal(columns(DBS.stg), columns(DBS.unr));
    assert.equal(
      sql("select string_agg(proname, ',' order by proname) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('activate_development_regulatory_mode', 'bootstrap_staff_administrators');", DBS.stg),
      "activate_development_regulatory_mode,bootstrap_staff_administrators",
    );
  });
  check("only the database owner may execute either function", () => {
    const matrix = sql(`select string_agg(r || '|' || has_function_privilege(r, f, 'execute'), E'\\n' order by r, f)
      from unnest(array['anon', 'authenticated', 'service_role', 'postgres']) as r,
           unnest(array['${ACTIVATE_SIGNATURE}', '${BOOTSTRAP_SIGNATURE}']) as f;`, DBS.stg);
    const entries = matrix.split("\n");
    assert.equal(entries.length, 8);
    for (const entry of entries) {
      const [role, allowed] = entry.split("|");
      assert.equal(allowed, role === "postgres" ? "true" : "false", entry);
    }
  });
  check("both functions are security invoker with a pinned search_path", () =>
    assert.equal(
      sql("select string_agg(proname || ':' || prosecdef || ':' || array_to_string(proconfig, ';'), ',' order by proname) from pg_proc where proname in ('activate_development_regulatory_mode', 'bootstrap_staff_administrators');", DBS.stg),
      "activate_development_regulatory_mode:false:search_path=pg_catalog, pg_temp;lock_timeout=3s,bootstrap_staff_administrators:false:search_path=pg_catalog, pg_temp;lock_timeout=3s",
    ));
  check("PS-A2 section 5: both read the environment only through the accessor, never the relation", () => {
    const bodies = sql("select string_agg(proname || '=' || (prosrc ~ 'deployment_environment_identity\\(') || ':' || (prosrc ~ 'deployment_environment([^_]|$)'), ',' order by proname) from pg_proc where proname in ('activate_development_regulatory_mode', 'bootstrap_staff_administrators');", DBS.stg);
    assert.equal(bodies, "activate_development_regulatory_mode=true:false,bootstrap_staff_administrators=true:false");
  });
  for (const role of ["anon", "authenticated", "service_role"]) {
    check(`${role} is refused (42501) by both functions through the API`, () => {
      const sub = role === "authenticated" ? randomUUID() : null;
      assert.equal(as(role, sub, activate("stg", randomUUID()), DBS.stg), "ERROR 42501");
      assert.equal(as(role, sub, bootstrap("stg", randomUUID(), randomUUID(), randomUUID()), DBS.stg), "ERROR 42501");
    });
  }

  // 1. Development regulatory mode.
  const J = jurisdiction(DBS.stg, "SYN_STAGING_1");
  check("target confirmation: a wrong class or project reference writes nothing", () => {
    assert.equal(outcomeOf(sql(activate("stg", J, AUTH, ["production", STAGING_REF]), DBS.stg)), "environment_mismatch");
    assert.equal(outcomeOf(sql(activate("stg", J, AUTH, ["staging", PRODUCTION_REF]), DBS.stg)), "environment_mismatch");
    assert.equal(outcomeOf(sql(activate("stg", J, AUTH, ["staging", null]), DBS.stg)), "environment_mismatch");
    assert.equal(sql("select count(*) from public.regulatory_modes;", DBS.stg), "0");
  });
  check("unrecorded environment answers environment_unrecorded", () => {
    const Ju = jurisdiction(DBS.unr, "SYN_UNR_1");
    assert.equal(outcomeOf(sql(activate("stg", Ju, AUTH, ["staging", STAGING_REF]), DBS.unr)), "environment_unrecorded");
  });
  check("production, correctly confirmed, is refused and writes nothing", () => {
    const Jp = jurisdiction(DBS.prd, "SYN_PROD_1");
    assert.equal(outcomeOf(sql(activate("prd", Jp), DBS.prd)), "environment_not_permitted");
    assert.equal(
      sql("select (select count(*) from public.regulatory_modes) + (select count(*) from public.jurisdiction_regulatory_modes) + (select count(*) from public.audit_events where action_code like 'regulatory_mode.%');", DBS.prd),
      "0",
    );
  });
  check("null, unknown jurisdiction and missing or oversized authorization are invalid", () => {
    assert.equal(outcomeOf(sql(activate("stg", null), DBS.stg)), "invalid");
    assert.equal(outcomeOf(sql(activate("stg", randomUUID()), DBS.stg)), "invalid");
    assert.equal(outcomeOf(sql(activate("stg", J, " "), DBS.stg)), "invalid");
    assert.equal(outcomeOf(sql(activate("stg", J, "x".repeat(201)), DBS.stg)), "invalid");
  });
  check("before activation the payment path has no mode", () =>
    assert.equal(sql(`select outcome from public.payment_regulatory_mode('${J}', now());`, DBS.stg), "regulatory_mode_unavailable"));
  let mode = null;
  check("staging: activation succeeds", () => {
    const [outcome, id] = sql(activate("stg", J), DBS.stg).split("|");
    assert.equal(outcome, "activated");
    mode = id;
  });
  check("the rows carry only descriptive development labels", () => {
    assert.equal(
      sql(`select code || '|' || status || '|' || name from public.regulatory_modes where id = '${mode}';`, DBS.stg),
      "DEV_SYN_STAGING_1|development_configuration|Development configuration (not a regulatory approval)",
    );
    assert.equal(
      sql(`select approval_status || '|' || (active_until is null) from public.jurisdiction_regulatory_modes where regulatory_mode_id = '${mode}';`, DBS.stg),
      "development_configuration|true",
    );
  });
  check("the payment path selects the development mode", () =>
    assert.equal(sql(`select outcome || '|' || regulatory_mode_id from public.payment_regulatory_mode('${J}', now());`, DBS.stg), `selected|${mode}`));
  check("the activation audit records the authorization, role, transaction and environment", () => {
    const snapshot = JSON.parse(
      sql(`select after_snapshot::text from public.audit_events where action_code = 'regulatory_mode.development_activated' and resource_id = '${mode}' and actor_type = 'system' and actor_user_id is null and reason_code = 'owner_authorized_operation';`, DBS.stg),
    );
    assert.equal(snapshot.authorization_reference, AUTH);
    assert.equal(snapshot.executed_by_role, "postgres");
    assert.equal(snapshot.environment_class, "staging");
    assert.equal(snapshot.project_ref, STAGING_REF);
    assert.equal(snapshot.jurisdiction_id, J);
    assert.ok(Number.isInteger(snapshot.transaction_id));
  });
  check("audit events are append-only", () => {
    assert.ok(refused("update public.audit_events set reason_code = 'changed' where action_code = 'regulatory_mode.development_activated';", DBS.stg));
    assert.ok(refused("delete from public.audit_events where action_code = 'regulatory_mode.development_activated';", DBS.stg));
  });
  check("a second activation answers already_active and adds nothing", () => {
    assert.equal(outcomeOf(sql(activate("stg", J), DBS.stg)), "already_active");
    assert.equal(sql("select count(*) from public.regulatory_modes;", DBS.stg), "1");
  });
  check("the production financial gate stays closed with the mode", () =>
    assert.equal(sql(`select permitted || '|' || reason from public.production_financial_gate('${J}', 'payment_flow', '${mode}', now());`, DBS.stg), "false|environment_not_production"));
  check("development: activation succeeds", () =>
    assert.equal(outcomeOf(sql(activate("dev", jurisdiction(DBS.dev, "SYN_DEV_1")), DBS.dev)), "activated"));
  check("nothing interprets the labels: the only other reader is the staff display read, which never filters on them", () => {
    const readers = sql(`select coalesce(string_agg(proname, ',' order by proname), '') from pg_proc
      where pronamespace = 'public'::regnamespace and proname <> 'activate_development_regulatory_mode'
        and (prosrc ~* 'approval_status' or prosrc ~* 'm\\.status');`, DBS.stg);
    assert.equal(readers, "staff_jurisdiction_regulatory_modes");
    const body = sql("select prosrc from pg_proc where proname = 'staff_jurisdiction_regulatory_modes';", DBS.stg);
    assert.ok(!/approval_status|m\.status/i.test(body.slice(body.search(/\bwhere\b/i))));
  });
  const J2 = jurisdiction(DBS.stg, "SYN_STAGING_2");
  await checkAsync("concurrency: two simultaneous activations of one jurisdiction yield exactly one mapping", async () => {
    const r = await race(DBS.stg, activate("stg", J2), activate("stg", J2));
    assert.deepEqual([r.holder.outcomes[0], r.contender.outcomes[0]], ["activated", "already_active"]);
    assert.ok(r.waited, "the second activation waited for the first to commit");
    assert.equal(sql(`select count(*) from public.jurisdiction_regulatory_modes where jurisdiction_id = '${J2}';`, DBS.stg), "1");
  });
  const J3 = jurisdiction(DBS.stg, "SYN_STAGING_3");
  const J4 = jurisdiction(DBS.stg, "SYN_STAGING_4");
  await checkAsync("cross-operation: a direct regulatory-mode write waits for an activation in progress", async () => {
    const r = await race(
      DBS.stg,
      activate("stg", J3),
      `insert into public.regulatory_modes (code, name, status) values ('DIRECT_${J4.slice(0, 4).toUpperCase()}', 'direct', 'x');`,
    );
    assert.equal(r.holder.outcomes[0], "activated");
    assert.ok(r.waited, "the direct write waited for the activation to commit");
  });

  // 2. Staff bootstrap (non-production only; truthful grantor).
  const O = user(DBS.stg); // the authorizing person
  const A = user(DBS.stg);
  const B = user(DBS.stg);
  const P = user(DBS.stg, "pending_verification");
  check("bootstrap target confirmation: a wrong class or project reference writes nothing", () => {
    assert.equal(sql(bootstrap("stg", A.id, B.id, O.id, { env: ["production", PRODUCTION_REF] }), DBS.stg), "environment_mismatch");
    assert.equal(sql(bootstrap("stg", A.id, B.id, O.id, { env: ["staging", null] }), DBS.stg), "environment_mismatch");
    assert.equal(sql("select count(*) from public.staff_profiles;", DBS.stg), "0");
  });
  check("bootstrap in an unrecorded environment answers environment_unrecorded", () => {
    const [U1, U2, U3] = [user(DBS.unr), user(DBS.unr), user(DBS.unr)];
    assert.equal(sql(bootstrap("stg", U1.id, U2.id, U3.id), DBS.unr), "environment_unrecorded");
  });
  check("production bootstrap is prohibited and writes nothing", () => {
    const [G, H, I] = [user(DBS.prd), user(DBS.prd), user(DBS.prd)];
    assert.equal(sql(bootstrap("prd", G.id, H.id, I.id), DBS.prd), "environment_not_permitted");
    assert.equal(
      sql("select (select count(*) from public.staff_profiles) + (select count(*) from public.capability_grants) + (select count(*) from public.audit_events where action_code like '%.bootstrapped');", DBS.prd),
      "0",
    );
  });
  check("bootstrap invalid inputs: same grantee, authorizer among grantees, past expiry, authorization", () => {
    assert.equal(sql(bootstrap("stg", A.id, A.id, O.id), DBS.stg), "invalid");
    assert.equal(sql(bootstrap("stg", A.id, B.id, A.id), DBS.stg), "invalid");
    assert.equal(sql(bootstrap("stg", A.id, B.id, B.id), DBS.stg), "invalid");
    assert.equal(sql(bootstrap("stg", A.id, B.id, O.id, { expires: "now() - interval '1 second'" }), DBS.stg), "invalid");
    assert.equal(sql(bootstrap("stg", A.id, B.id, O.id, { auth: "" }), DBS.stg), "invalid");
    assert.equal(sql(bootstrap("stg", A.id, B.id, O.id, { auth: "x".repeat(201) }), DBS.stg), "invalid");
  });
  check("bootstrap refuses an authorizer who is not active", () =>
    assert.equal(sql(bootstrap("stg", A.id, B.id, P.id), DBS.stg), "authorizer_not_active"));
  check("bootstrap refuses a grantee who is not active", () =>
    assert.equal(sql(bootstrap("stg", A.id, P.id, O.id), DBS.stg), "user_not_active"));
  check("bootstrap: both grants truthfully name the authorizing user, with the stated expiry", () => {
    assert.equal(sql(bootstrap("stg", A.id, B.id, O.id, { expires: "now() + interval '90 days'" }), DBS.stg), "bootstrapped");
    assert.equal(sql(`select count(*) from public.staff_profiles where user_id in ('${A.id}', '${B.id}') and staff_state = 'active';`, DBS.stg), "2");
    assert.equal(
      sql(`select string_agg(capability_code || ':' || (granted_by_user_id = '${O.id}'::uuid) || ':' || (jurisdiction_id is null) || ':' || (expires_at > now() + interval '89 days'), ',') from public.capability_grants;`, DBS.stg),
      "manage_staff_capabilities:true:true:true,manage_staff_capabilities:true:true:true",
    );
    assert.equal(sql(`select count(*) from public.capability_grants where granted_by_user_id in ('${A.id}', '${B.id}');`, DBS.stg), "0");
  });
  check("bootstrap audit: four append-only system events with the authorizer and authorization trail", () => {
    const rows = sql("select after_snapshot::text from public.audit_events where actor_type = 'system' and reason_code = 'owner_authorized_operation' and action_code in ('staff_profile.bootstrapped', 'capability_grant.bootstrapped');", DBS.stg)
      .split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.length, 4);
    for (const snapshot of rows) {
      assert.equal(snapshot.authorization_reference, AUTH);
      assert.equal(snapshot.authorized_by_user_id, O.id);
      assert.equal(snapshot.executed_by_role, "postgres");
      assert.equal(snapshot.environment_class, "staging");
    }
    assert.equal(new Set(rows.map((s) => s.transaction_id)).size, 1, "one transaction");
  });
  const C = user(DBS.stg);
  const D = user(DBS.stg);
  check("bootstrap is refused while an administrator exists", () =>
    assert.equal(sql(bootstrap("stg", C.id, D.id, O.id), DBS.stg), "administrator_exists"));
  check("a bootstrapped administrator grants through the audited function", () =>
    assert.equal(as("authenticated", A.auth, `select outcome from public.staff_grant_capability('${B.id}', 'view_audit_events', null, null);`, DBS.stg), "created"));
  check("a bootstrapped administrator still cannot self-grant", () =>
    assert.equal(as("authenticated", A.auth, `select outcome from public.staff_grant_capability('${A.id}', 'view_audit_events', null, null);`, DBS.stg), "self_grant_refused"));

  // Cross-operation race protection (the holder keeps its locks 1.5 s before committing).
  await checkAsync("cross-operation: a grant revocation waits for a bootstrap in progress", async () => {
    const grant = sql(`select id from public.capability_grants where user_id = '${A.id}' and capability_code = 'view_audit_events' limit 1;`, DBS.stg)
      || sql(`select id from public.capability_grants where user_id = '${B.id}' and capability_code = 'view_audit_events' limit 1;`, DBS.stg);
    const r = await race(DBS.stg, bootstrap("stg", C.id, D.id, O.id), `update public.capability_grants set revoked_at = clock_timestamp() where id = '${grant}';`);
    assert.equal(r.holder.outcomes[0], "administrator_exists");
    assert.ok(r.waited, "the revocation waited for the bootstrap to commit");
  });
  await checkAsync("cross-operation: a pending revocation of every administrator is seen, never a stale administrator", async () => {
    const r = await race(
      DBS.stg,
      "update public.capability_grants set revoked_at = clock_timestamp() where capability_code = 'manage_staff_capabilities' and revoked_at is null;",
      bootstrap("stg", C.id, D.id, O.id),
    );
    assert.ok(r.waited, "the bootstrap waited for the revocation to commit");
    assert.equal(r.contender.outcomes[0], "bootstrapped", "the bootstrap saw the committed revocation (lockout recovery)");
  });
  check("bootstrap refuses an existing staff member", () => {
    const [E, F, Q] = [user(DBS.dev), user(DBS.dev), user(DBS.dev)];
    sql(`insert into public.staff_profiles (user_id, staff_state) values ('${E.id}', 'deactivated');`, DBS.dev);
    assert.equal(sql(bootstrap("dev", E.id, F.id, Q.id), DBS.dev), "already_staff");
  });
  const W = [user(DBS.dev), user(DBS.dev), user(DBS.dev), user(DBS.dev), user(DBS.dev)];
  await checkAsync("concurrency: two simultaneous bootstraps yield exactly one pair of administrators", async () => {
    const before = Number(sql("select count(*) from public.staff_profiles;", DBS.dev));
    const r = await race(DBS.dev, bootstrap("dev", W[0].id, W[1].id, W[4].id), bootstrap("dev", W[2].id, W[3].id, W[4].id));
    assert.deepEqual([r.holder.outcomes[0], r.contender.outcomes[0]], ["bootstrapped", "administrator_exists"]);
    assert.ok(r.waited, "the second bootstrap waited for the first to commit");
    assert.equal(Number(sql("select count(*) from public.staff_profiles;", DBS.dev)), before + 2);
  });
  const [G, H] = [user(DBS.dev), user(DBS.dev)];
  await checkAsync("cross-operation: an account-state change of a candidate waits for a bootstrap in progress", async () => {
    const r = await race(DBS.dev, bootstrap("dev", G.id, H.id, W[4].id), `update public.users set account_state = 'suspended' where id = '${G.id}';`);
    assert.equal(r.holder.outcomes[0], "administrator_exists");
    assert.ok(r.waited, "the account-state change waited for the bootstrap to commit");
  });
  await checkAsync("cross-operation: an account-state change of an existing administrator waits for a bootstrap in progress", async () => {
    const r = await race(DBS.dev, bootstrap("dev", G.id, H.id, W[4].id), `update public.users set account_state = 'suspended' where id = '${W[0].id}';`);
    assert.ok(r.waited, "the administrator's account-state change waited for the bootstrap to commit");
  });
  await checkAsync("cross-operation: a staff-state change waits for a bootstrap in progress", async () => {
    const r = await race(DBS.dev, bootstrap("dev", G.id, H.id, W[4].id), `update public.staff_profiles set staff_state = 'removed' where user_id = '${W[1].id}';`);
    assert.ok(r.waited, "the staff-state change waited for the bootstrap to commit");
  });
}

let fatal = null;
try {
  await prove();
} catch (error) {
  fatal = String(error.message).replace(/\s+/g, " ").slice(0, 900);
} finally {
  teardown();
}
const failed = checks.filter((c) => !c.ok);
const report = {
  proof: "P2-924 disposable local PostgreSQL proof",
  fatal,
  summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length },
  failures: failed,
  result: fatal === null && failed.length === 0 ? "PASS" : "FAIL",
};
console.log(JSON.stringify(report, null, 2));
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}`);
process.exit(report.result === "PASS" ? 0 : 1);
