// MVP-001 S2 disposable PostgreSQL proof. Explicitly invoked only:
//
//   node apps/web/tests/mvp-001-s2-db-proof.mjs
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
// one transaction; the three S2 migrations must be registered in the
// migration register. This cluster has no pg_cron, so the scheduler
// migration must apply as a no-op.
//
// Request sessions are modelled as PostgREST sets them from a verified JWT:
// request.jwt.claim.sub and the JSON request.jwt.claims, whose "aal" member
// is "aal2" after a Supabase Auth MFA step-up and "aal1" before it.
//
// The probes cover the MVP-001 Packet S2 acceptance list for the database:
// the job lifecycle and its constraints, deterministic idempotency, claims
// with SKIP LOCKED under real concurrency, lease expiry decided without the
// sweeper, bounded attempts and visible escalation, duplicate execution
// without duplicate effect, backoff, cancellation for a terminal subject,
// pending jobs surviving a restart, the sweeper, staff administration
// (capability, aal2, audit), privileges, and session assurance for every
// staff and attorney authority helper (aal1 and claim-less sessions are
// refused as unauthorized callers; client functions are unaffected). No
// Supabase project, network service, or pre-existing cluster is contacted,
// nothing persists after the run, and every value is synthetic test data.
// The JSON report goes to stdout; exit 0 means PASS, 1 FAIL, 2 cleanup
// failure.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54337;
const DB = "rosuno_s2_proof";
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
const S2_MIGRATIONS = Object.freeze([
  "20261118010000_mvp_001_s2_operational_jobs.sql",
  "20261118020000_mvp_001_s2_job_scheduler.sql",
  "20261118030000_mvp_001_s2_session_assurance.sql",
]);
const CAPABILITIES = Object.freeze([
  "authorize_jurisdiction_launch",
  "manage_attorney_verification",
  "manage_intake_configuration",
  "manage_jurisdiction_configuration",
  "manage_operational_jobs",
  "manage_policy_configuration",
  "manage_staff_capabilities",
]);
const V1_KEY = "intake-questions-v1";
const V1 = JSON.parse(
  fs.readFileSync(
    path.join(
      REPOSITORY_ROOT,
      "apps/web/tests/fixtures/intake-questions-v1.canonical.txt",
    ),
    "utf8",
  ),
);
const SUBJECT = "synthetic_subject";
const OPEN = "('pending', 'running', 'escalated')";

const report = {
  proof: "MVP-001 S2 disposable local PostgreSQL proof",
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
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
    cwd: state.tmp,
    ...state.identity.spawn,
  });
}

function psqlArgs(db) {
  return [
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
  ];
}

function psql(script, db = DB) {
  return run("psql", psqlArgs(db), script);
}

function sql(script, db = DB) {
  const result = psql(script, db);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function sqlstateOf(text) {
  return /ERROR:\s+([0-9A-Z]{5}):/.exec(text ?? "")?.[1] ?? null;
}

// The SQLSTATE of an owner statement that must fail, in its own transaction.
function refused(statement) {
  const result = psql(["begin;", statement, "commit;"].join("\n"));
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

// The session lines of one request: a role, an optional JWT subject, and the
// JWT claims. With a subject, the claims default to an aal2 session; aal
// "aal1" models a session before MFA step-up and aal null a request without
// claims. claims (a raw string, or null) overrides both.
function sessionLines(role, sub, { aal = "aal2", claims } = {}) {
  const lines = [`set local role ${role};`];
  if (sub !== null) {
    lines.push(
      `select set_config('request.jwt.claim.sub', ${lit(sub)}, true) is not null;`,
    );
  }
  let raw = null;
  if (claims !== undefined) {
    raw = claims;
  } else if (sub !== null && aal !== null) {
    raw = JSON.stringify({ sub, role, aal });
  }
  if (raw !== null) {
    lines.push(
      `select set_config('request.jwt.claims', ${lit(raw)}, true) is not null;`,
    );
  }
  return lines;
}

// One statement as a request, in its own committed transaction: the last
// output line, or "ERROR <sqlstate>".
function as(role, sub, statement, options = {}) {
  const result = psql(
    [
      "begin;",
      ...sessionLines(role, sub, options),
      statement,
      "commit;",
      "",
    ].join("\n"),
  );
  if (result.status === 0) {
    const lines = result.stdout.trim().split("\n");
    return lines[lines.length - 1];
  }
  return `ERROR ${sqlstateOf(result.stderr)}`;
}

const uid = () => randomUUID();

function count(table, where = "true") {
  return Number(sql(`select count(*) from public.${table} where ${where};`));
}

const FIXTURE = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create database ${DB} template template0 encoding 'UTF8' locale 'C';
\\connect ${DB}
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
    path.join(os.tmpdir(), "rosuno-mvp-001-s2-db-proof-"),
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
      // Function call counts, so the proof can show the sweeper never ran.
      "track_functions = 'pl'",
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
  report.cluster = { ...settings, postmaster_uid: identity.uid };
}

function teardown() {
  if (state === null) {
    return true;
  }
  for (const session of openSessions) {
    try {
      session.child.kill("SIGKILL");
    } catch {
      // already gone
    }
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
  // S1 then S2, each contiguous and in order; every migration after S1 is a
  // registered migration.
  const s1 = files.indexOf(S1_MIGRATIONS[0]);
  assert.ok(s1 >= 0, "S1 migrations are present");
  assert.deepEqual(files.slice(s1, s1 + 4), [...S1_MIGRATIONS]);
  const s2 = files.indexOf(S2_MIGRATIONS[0]);
  assert.equal(s2, s1 + 4, "S2 migrations follow S1");
  assert.deepEqual(files.slice(s2, s2 + 3), [...S2_MIGRATIONS]);
  for (const file of files.slice(s1)) {
    assert.ok(
      registered.has(`supabase/migrations/${file}`),
      `${file} is registered`,
    );
  }
  sql(FIXTURE, "postgres");
  assert.equal(
    sql("select count(*) from pg_available_extensions where name = 'pg_cron';"),
    "0",
    "this disposable cluster has no pg_cron",
  );
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
        DB,
      ],
      fs.readFileSync(path.join(MIGRATIONS, file), "utf8"),
    );
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    if (file === S2_MIGRATIONS[1]) {
      report.migrations.scheduler_notice = /NOTICE:\s+(.*)/.exec(
        result.stderr,
      )?.[1];
    }
  }
  report.migrations.applied = files.length;
  report.migrations.s2 = [...S2_MIGRATIONS];
}

// ---------------------------------------------------------------------------
// Persistent sessions (real concurrency)
// ---------------------------------------------------------------------------

const openSessions = new Set();

class Session {
  constructor(label) {
    this.label = label;
    const args = psqlArgs(DB).map((a) =>
      a === "ON_ERROR_STOP=1" ? "ON_ERROR_STOP=0" : a,
    );
    this.child = spawn(path.join(BIN, "psql"), args, {
      env: childEnvironment(),
      cwd: state.tmp,
      stdio: ["pipe", "pipe", "pipe"],
      ...state.identity.spawn,
    });
    openSessions.add(this);
    this.out = "";
    this.err = "";
    this.n = 0;
    this.waiters = [];
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (d) => {
      this.out += d;
      this.pump();
    });
    this.child.stderr.on("data", (d) => {
      this.err += d;
    });
  }

  pump() {
    for (const waiter of [...this.waiters]) {
      const at = this.out.indexOf(waiter.mark);
      if (at < 0) {
        continue;
      }
      const eol = this.out.indexOf("\n", at);
      if (eol < 0) {
        continue;
      }
      const line = this.out.slice(at, eol);
      const body = this.out.slice(0, at);
      this.out = this.out.slice(eol + 1);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      const stderr = this.err;
      this.err = "";
      waiter.resolve({
        rows: body.split("\n").filter((row) => row !== ""),
        sqlstate: line.split(" ")[1],
        stderr,
      });
    }
  }

  send(statement) {
    this.n += 1;
    const mark = `__S2_${this.label}_${this.n}__`;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${this.label}: no answer to ${statement}`)),
        20000,
      );
      this.waiters.push({ mark, resolve, timer });
    });
    this.child.stdin.write(`${statement}\n\\echo ${mark} :SQLSTATE\n`);
    return promise;
  }

  async ok(statement) {
    const result = await this.send(statement);
    assert.equal(
      result.sqlstate,
      "00000",
      `${this.label}: ${statement}\n${result.stderr}`,
    );
    return result.rows;
  }

  async open() {
    this.pid = Number((await this.ok("select pg_backend_pid();"))[0]);
    return this;
  }

  close() {
    this.child.stdin.end();
    openSessions.delete(this);
  }
}

async function session(label) {
  return new Session(label).open();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function blockedOnLock(pid) {
  for (let i = 0; i < 400; i += 1) {
    const waitType = sql(
      `select coalesce(wait_event_type, '') from pg_stat_activity where pid = ${pid};`,
    );
    if (waitType === "Lock") {
      return true;
    }
    await sleep(25);
  }
  throw new Error(`backend ${pid} never blocked on a lock`);
}

// One psql process running a script asynchronously (for parallel claims).
function runAsync(script) {
  return new Promise((resolve) => {
    const child = spawn(path.join(BIN, "psql"), psqlArgs(DB), {
      env: childEnvironment(),
      cwd: state.tmp,
      stdio: ["pipe", "pipe", "pipe"],
      ...state.identity.spawn,
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("close", (status) => resolve({ status, out, err }));
    child.stdin.end(script);
  });
}

// ---------------------------------------------------------------------------
// Synthetic seed
// ---------------------------------------------------------------------------

const world = {};

function newAccount(accountState = "active") {
  const auth = uid();
  const user = uid();
  sql(
    `insert into auth.users (id) values ('${auth}');
     insert into public.users (id, auth_user_id, account_state) values ('${user}', '${auth}', '${accountState}');`,
  );
  return { auth, user };
}

function newStaff(grants, { staffState = "active" } = {}) {
  const ids = newAccount();
  sql(
    `insert into public.staff_profiles (user_id, staff_state) values ('${ids.user}', '${staffState}');`,
  );
  const grantIds = grants.map((g) => {
    const id = uid();
    sql(
      `insert into public.capability_grants (id, user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at, expires_at, revoked_at)
       values ('${id}', '${ids.user}', ${lit(g.capability)}, '${world.grantor.user}', ${lit(g.jurisdiction ?? null)},
               now() - interval '1 day', null, ${g.revoked ? "now() - interval '1 hour'" : "null"});`,
    );
    return id;
  });
  return { ...ids, grants: grantIds };
}

function seed() {
  world.jurisdiction = uid();
  sql(
    `insert into public.jurisdictions (id, code, name, region_type) values ('${world.jurisdiction}', 'SYN_S2', 'Synthetic S2', 'synthetic');`,
  );
  world.grantor = newAccount();
  sql(
    `insert into public.staff_profiles (user_id, staff_state) values ('${world.grantor.user}', 'active');`,
  );
  world.jobsAdmin = newStaff([{ capability: "manage_operational_jobs" }]);
  world.scopedAdmin = newStaff([
    {
      capability: "manage_operational_jobs",
      jurisdiction: world.jurisdiction,
    },
  ]);
  world.revokedAdmin = newStaff([
    { capability: "manage_operational_jobs", revoked: true },
  ]);
  world.deactivatedAdmin = newStaff(
    [{ capability: "manage_operational_jobs" }],
    { staffState: "deactivated" },
  );
  world.otherStaff = newStaff([{ capability: "manage_policy_configuration" }]);
  world.capabilityAdmin = newStaff([
    { capability: "manage_staff_capabilities" },
  ]);
  world.grantee = newStaff([]);
  world.verifier = newStaff([{ capability: "manage_attorney_verification" }]);
  world.intakeAdmin = newStaff([{ capability: "manage_intake_configuration" }]);
  // An applicant attorney (own professional writes) and an approved attorney
  // with a license (staff verification writes).
  world.applicant = newAccount();
  world.applicantProfile = uid();
  world.approved = newAccount();
  world.approvedProfile = uid();
  world.license = uid();
  sql(
    `insert into public.attorney_profiles (id, user_id, profile_state) values
       ('${world.applicantProfile}', '${world.applicant.user}', 'applicant'),
       ('${world.approvedProfile}', '${world.approved.user}', 'approved');
     insert into public.licenses (id, attorney_id, jurisdiction_id, license_number, reported_status)
       values ('${world.license}', '${world.approvedProfile}', '${world.jurisdiction}', 'SYN-S2-LIC', 'synthetic-active');`,
  );
  world.client = newAccount();
  sql(
    `insert into public.client_profiles (user_id) values ('${world.client.user}');`,
  );
  world.newcomer = newAccount();
  world.newcomer2 = newAccount();
}

// ---------------------------------------------------------------------------
// Job helpers
// ---------------------------------------------------------------------------

function enqueue(
  jobType,
  subjectId = null,
  { availableAt = "null", maxAttempts = 3, subjectType = SUBJECT } = {},
) {
  return sql(
    `select public.job_enqueue(${lit(jobType)}, ${subjectId === null ? "null" : lit(subjectType)}, ${lit(subjectId)}::uuid, ${availableAt}, ${maxAttempts});`,
  );
}

function job(id) {
  return JSON.parse(
    sql(
      `select to_jsonb(j) from public.operational_jobs as j where j.id = '${id}';`,
    ),
  );
}

function jobText(id) {
  return sql(
    `select to_jsonb(j)::text from public.operational_jobs as j where j.id = '${id}';`,
  );
}

// The worker credential's claim: the returned rows, in claim order.
function claim(worker, lease = 60, limit = 10) {
  const value = as(
    "service_role",
    null,
    `select coalesce(jsonb_agg(to_jsonb(r) - 'ordinality' order by r.ordinality), '[]'::jsonb) from public.job_claim(${lit(worker)}, ${lease}, ${limit}) with ordinality as r;`,
  );
  assert.ok(!value.startsWith("ERROR"), value);
  return JSON.parse(value);
}

function complete(worker, id) {
  return as(
    "service_role",
    null,
    `select public.job_complete(${lit(id)}::uuid, ${lit(worker)});`,
  );
}

function fail(worker, id, code = "provider_unavailable", message = null) {
  return as(
    "service_role",
    null,
    `select public.job_fail(${lit(id)}::uuid, ${lit(worker)}, ${lit(code)}, ${lit(message)});`,
  );
}

// Owner rescheduling of a pending job (the one same-state change allowed).
function makeDue(id) {
  sql(
    `update public.operational_jobs set available_at = clock_timestamp() - interval '1 second' where id = '${id}' and state = 'pending';`,
  );
}

// Cancels every open job so each check claims only its own jobs.
function settle() {
  sql(
    `update public.operational_jobs set state = 'cancelled', locked_at = null, locked_by = null, failed_at = null where state in ${OPEN};`,
  );
}

function auditOf(id) {
  return JSON.parse(
    sql(
      `select coalesce(jsonb_agg(jsonb_build_object('actor_user_id', actor_user_id, 'actor_type', actor_type, 'action_code', action_code, 'reason_code', reason_code, 'before', before_snapshot, 'after', after_snapshot) order by occurred_at, id), '[]'::jsonb) from public.audit_events where resource_type = 'operational_job' and resource_id = '${id}';`,
    ),
  );
}

function staffCall(principal, name, id, options = {}) {
  return as(
    "authenticated",
    principal.auth,
    `select public.${name}(${lit(id)}::uuid);`,
    options,
  );
}

function sweepCalls() {
  return Number(
    sql(
      "select coalesce(sum(calls), 0) from pg_stat_user_functions where schemaname = 'public' and funcname = 'operational_jobs_sweep';",
    ),
  );
}

// An escalated job: max_attempts attempts claimed and failed.
function escalatedJob(jobType, subjectId = null, maxAttempts = 1) {
  const id = enqueue(jobType, subjectId, { maxAttempts });
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    makeDue(id);
    const claimed = claim("w-escalate");
    assert.deepEqual(
      claimed.map((r) => r.job_id),
      [id],
    );
    const answer = fail("w-escalate", id, "provider_rejected", "synthetic");
    assert.equal(
      answer,
      attempt === maxAttempts ? "escalated" : "retry_scheduled",
    );
  }
  return id;
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
    process.stderr.write(`[s2-proof] PASS ${name}\n`);
  } catch (error) {
    failed = true;
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
    process.stderr.write(`[s2-proof] FAIL ${name}\n${error?.stack ?? error}\n`);
  }
}

async function migrationChecks() {
  await check(
    "MIG-1 the three S2 migrations apply after S1 and are registered; without pg_cron the scheduler migration applies cleanly as a no-op (no extension, no cron schema, no schedule)",
    () => {
      assert.equal(
        sql("select count(*) from pg_extension where extname = 'pg_cron';"),
        "0",
      );
      assert.equal(
        sql("select count(*) from pg_namespace where nspname = 'cron';"),
        "0",
      );
      assert.match(
        report.migrations.scheduler_notice ?? "",
        /pg_cron is not available/,
      );
      return { scheduler: "no-op without pg_cron" };
    },
  );
}

async function lifecycleChecks() {
  await check(
    "JOB-1 lifecycle and constraints: jobs are created pending; only the allowed transitions happen; completed and cancelled are terminal; identity is immutable; no job is deleted or truncated; the consistency checks exist",
    () => {
      settle();
      const names = sql(
        "select string_agg(conname, ',' order by conname) from pg_constraint where conrelid = 'public.operational_jobs'::regclass and contype = 'c' and conname not in ('operational_jobs_job_type_check', 'operational_jobs_state_check', 'operational_jobs_attempt_count_check', 'operational_jobs_max_attempts_check', 'operational_jobs_attempt_limit_check', 'operational_jobs_locked_by_check');",
      );
      assert.equal(
        names,
        [
          "operational_jobs_completion_consistency_check",
          "operational_jobs_error_code_format_check",
          "operational_jobs_error_message_bound_check",
          "operational_jobs_escalation_consistency_check",
          "operational_jobs_job_type_format_check",
          "operational_jobs_lease_consistency_check",
          "operational_jobs_lifecycle_state_check",
          "operational_jobs_locked_by_format_check",
          "operational_jobs_pending_attempts_check",
          "operational_jobs_running_attempts_check",
          "operational_jobs_subject_check",
        ].join(","),
      );
      const insert = (columns, values) =>
        refused(
          `insert into public.operational_jobs (${columns}) values (${values});`,
        );
      // Creation: pending, unclaimed, no attempts; formats and pairs.
      assert.equal(
        insert(
          "job_type, state, available_at, max_attempts",
          "'synthetic.job', 'running', now(), 3",
        ),
        "23514",
      );
      assert.equal(
        insert(
          "job_type, state, available_at, max_attempts",
          "'synthetic.job', 'bogus', now(), 3",
        ),
        "23514",
      );
      assert.equal(
        insert(
          "job_type, state, available_at, max_attempts, attempt_count",
          "'synthetic.job', 'pending', now(), 3, 1",
        ),
        "23514",
      );
      for (const type of ["X", "ab", "Synthetic.job", "9job", "job type"]) {
        assert.equal(
          insert(
            "job_type, state, available_at, max_attempts",
            `${lit(type)}, 'pending', now(), 3`,
          ),
          "23514",
          type,
        );
      }
      assert.equal(
        insert(
          "job_type, subject_type, state, available_at, max_attempts",
          "'synthetic.job', 'synthetic_subject', 'pending', now(), 3",
        ),
        "23514",
      );
      assert.equal(
        insert(
          "job_type, subject_type, subject_id, state, available_at, max_attempts",
          `'synthetic.job', 'Bad-Subject', '${uid()}', 'pending', now(), 3`,
        ),
        "23514",
      );
      // A pending job changes only its availability.
      const pending = enqueue("synthetic.lifecycle", null, {
        availableAt: "now() + interval '1 hour'",
      });
      for (const change of [
        "completed_at = now()",
        "failed_at = now()",
        "attempt_count = 1",
        "max_attempts = 9",
        "last_error_code = 'x'",
      ]) {
        assert.equal(
          refused(
            `update public.operational_jobs set ${change} where id = '${pending}';`,
          ),
          "23514",
          change,
        );
      }
      // Transitions that skip the protocol.
      assert.equal(
        refused(
          `update public.operational_jobs set state = 'completed', completed_at = now() where id = '${pending}';`,
        ),
        "23514",
      );
      assert.equal(
        refused(
          `update public.operational_jobs set state = 'escalated', failed_at = now() where id = '${pending}';`,
        ),
        "23514",
      );
      assert.equal(
        refused(
          `update public.operational_jobs set state = 'running', attempt_count = 1 where id = '${pending}';`,
        ),
        "23514",
        "running needs its lease",
      );
      assert.equal(
        refused(
          `update public.operational_jobs set job_type = 'synthetic.other' where id = '${pending}';`,
        ),
        "55000",
      );
      // A running job's bound changes only by a staff retry.
      settle();
      const running = enqueue("synthetic.lifecycle");
      assert.equal(claim("w-life").length, 1);
      assert.equal(
        refused(
          `update public.operational_jobs set max_attempts = 9 where id = '${running}';`,
        ),
        "23514",
      );
      assert.equal(
        refused(
          `update public.operational_jobs set state = 'running', attempt_count = attempt_count + 2 where id = '${running}';`,
        ),
        "23514",
      );
      // Escalated -> running is refused; escalated -> pending only raises.
      const escalated = escalatedJob("synthetic.lifecycle.escalated");
      assert.equal(
        refused(
          `update public.operational_jobs set state = 'running', failed_at = null, locked_at = now(), locked_by = 'x', attempt_count = attempt_count + 1 where id = '${escalated}';`,
        ),
        "23514",
      );
      // Terminal states.
      assert.equal(complete("w-life", running), "completed");
      assert.equal(
        refused(
          `update public.operational_jobs set state = 'pending', completed_at = null where id = '${running}';`,
        ),
        "55000",
      );
      // settle() cancelled the earlier pending job.
      assert.equal(job(pending).state, "cancelled");
      assert.equal(
        refused(
          `update public.operational_jobs set state = 'pending' where id = '${pending}';`,
        ),
        "55000",
      );
      // Never deleted, never truncated.
      assert.equal(
        refused(`delete from public.operational_jobs where id = '${running}';`),
        "55000",
      );
      assert.equal(refused("truncate public.operational_jobs;"), "55000");
      assert.equal(job(running).state, "completed");
      return { constraints: names.split(",").length };
    },
  );

  await check(
    "JOB-2 deterministic idempotency: one open job per (job_type, subject); enqueue answers the open job instead of duplicating, also under a concurrent enqueue; terminal jobs free the key; invalid input raises 22023",
    async () => {
      settle();
      const subject = uid();
      const first = enqueue("synthetic.notify", subject);
      assert.equal(enqueue("synthetic.notify", subject), first);
      assert.equal(
        count(
          "operational_jobs",
          `subject_id = '${subject}' and job_type = 'synthetic.notify'`,
        ),
        1,
      );
      const other = enqueue("synthetic.other", subject);
      assert.notEqual(other, first);
      const loose = [enqueue("synthetic.loose"), enqueue("synthetic.loose")];
      assert.notEqual(loose[0], loose[1]);
      // The index itself refuses a second open job for the key.
      assert.equal(
        refused(
          `insert into public.operational_jobs (job_type, subject_type, subject_id, state, available_at, max_attempts) values ('synthetic.notify', '${SUBJECT}', '${subject}', 'pending', now(), 3);`,
        ),
        "23505",
      );
      // An escalated job is still open; a completed or cancelled one is not.
      settle();
      const escalatedSubject = uid();
      const escalated = escalatedJob("synthetic.notify", escalatedSubject);
      assert.equal(enqueue("synthetic.notify", escalatedSubject), escalated);
      const doneSubject = uid();
      const done = enqueue("synthetic.notify", doneSubject);
      assert.equal(claim("w-idem").length, 1);
      assert.equal(complete("w-idem", done), "completed");
      const again = enqueue("synthetic.notify", doneSubject);
      assert.notEqual(again, done);
      // Invalid input.
      for (const args of [
        "'X', null, null, null, 3",
        "'synthetic.ok', null, null, null, 0",
        "'synthetic.ok', null, null, null, 26",
        "'synthetic.ok', null, null, null, null",
        "null, null, null, null, 3",
        `'synthetic.ok', 'synthetic_subject', null, null, 3`,
        `'synthetic.ok', null, '${uid()}', null, 3`,
        `'synthetic.ok', 'Bad Subject', '${uid()}', null, 3`,
      ]) {
        assert.equal(
          refused(`select public.job_enqueue(${args});`),
          "22023",
          args,
        );
      }
      // Concurrent enqueue of one subject: the second waits on the first and
      // answers its job.
      const raced = uid();
      const a = await session("enqueue-a");
      const b = await session("enqueue-b");
      try {
        await a.ok("begin;");
        const [idA] = await a.ok(
          `select public.job_enqueue('synthetic.raced', '${SUBJECT}', '${raced}', null, 3);`,
        );
        const pendingB = b.send(
          `select public.job_enqueue('synthetic.raced', '${SUBJECT}', '${raced}', null, 3);`,
        );
        await blockedOnLock(b.pid);
        await a.ok("commit;");
        const answerB = await pendingB;
        assert.equal(answerB.sqlstate, "00000", answerB.stderr);
        assert.deepEqual(answerB.rows, [idA]);
        assert.equal(count("operational_jobs", `subject_id = '${raced}'`), 1);
      } finally {
        a.close();
        b.close();
      }
      return { concurrent_enqueue: "second waited and answered the first" };
    },
  );
}

async function claimChecks() {
  await check(
    "JOB-3 claims use SKIP LOCKED: a session holding claimed rows in an open transaction does not block a second worker, which claims the remaining jobs; under real concurrency four workers claim 40 jobs with no job claimed twice",
    async () => {
      settle();
      const ids = [];
      for (let i = 6; i >= 1; i -= 1) {
        ids.push(
          enqueue("synthetic.skip", null, {
            availableAt: `now() - interval '${i} seconds'`,
          }),
        );
      }
      const a = await session("claim-a");
      const b = await session("claim-b");
      let first;
      let second;
      try {
        await a.ok("begin;");
        await a.ok("set local role service_role;");
        first = (
          await a.ok("select job_id from public.job_claim('w-a', 60, 3);")
        ).sort();
        await b.ok("set role service_role;");
        const started = Date.now();
        second = (
          await b.ok("select job_id from public.job_claim('w-b', 60, 10);")
        ).sort();
        assert.ok(Date.now() - started < 5000, "the second claim never waits");
        await a.ok("commit;");
      } finally {
        a.close();
        b.close();
      }
      assert.deepEqual(first, [...ids.slice(0, 3)].sort());
      assert.deepEqual(second, [...ids.slice(3)].sort());
      for (const id of ids) {
        const row = job(id);
        assert.equal(row.state, "running");
        assert.equal(row.attempt_count, 1);
        assert.equal(row.locked_by, first.includes(id) ? "w-a" : "w-b");
      }
      // Real concurrency: four psql processes claim in parallel.
      settle();
      const race = [];
      for (let i = 0; i < 40; i += 1) {
        race.push(enqueue("synthetic.race"));
      }
      const script = (worker) =>
        [
          "set role service_role;",
          ...Array.from(
            { length: 12 },
            () => `select job_id from public.job_claim(${lit(worker)}, 60, 2);`,
          ),
          "",
        ].join("\n");
      const results = await Promise.all(
        ["race-1", "race-2", "race-3", "race-4"].map((w) =>
          runAsync(script(w)),
        ),
      );
      const claimed = [];
      const perWorker = {};
      results.forEach((result, index) => {
        assert.equal(result.status, 0, result.err);
        const got = result.out.split("\n").filter(Boolean);
        perWorker[`race-${index + 1}`] = got.length;
        claimed.push(...got);
      });
      assert.equal(new Set(claimed).size, claimed.length, "no double claim");
      assert.deepEqual([...claimed].sort(), [...race].sort());
      assert.equal(
        count(
          "operational_jobs",
          `job_type = 'synthetic.race' and state = 'running' and attempt_count = 1`,
        ),
        40,
      );
      return { open_transaction: { first, second }, parallel: perWorker };
    },
  );

  await check(
    "JOB-4 claim order is available_at, created_at, id; a job not yet due is not claimed; the claim answers attempt and max_attempts and holds a lease",
    () => {
      settle();
      const early = enqueue("synthetic.order", null, {
        availableAt: "now() - interval '3 seconds'",
      });
      const middle = enqueue("synthetic.order", null, {
        availableAt: "now() - interval '2 seconds'",
        maxAttempts: 4,
      });
      const tieLow = "00000000-0000-4000-8000-000000000001";
      const tieHigh = "00000000-0000-4000-8000-000000000002";
      sql(
        `insert into public.operational_jobs (id, job_type, state, available_at, max_attempts, created_at)
         values ('${tieHigh}', 'synthetic.order', 'pending', now() - interval '1 second', 3, now() - interval '1 day'),
                ('${tieLow}', 'synthetic.order', 'pending', now() - interval '1 second', 3, now() - interval '1 day');`,
      );
      const future = enqueue("synthetic.order", null, {
        availableAt: "now() + interval '1 hour'",
      });
      const claimed = claim("w-order", 120, 10);
      assert.deepEqual(
        claimed.map((r) => r.job_id),
        [early, middle, tieLow, tieHigh],
      );
      assert.deepEqual(claimed[1], {
        job_id: middle,
        job_type: "synthetic.order",
        subject_type: null,
        subject_id: null,
        attempt: 1,
        max_attempts: 4,
      });
      assert.equal(job(future).state, "pending");
      const lease = Number(
        sql(
          `select round(extract(epoch from available_at - locked_at)) from public.operational_jobs where id = '${early}';`,
        ),
      );
      assert.equal(lease, 120);
      // The limit bounds a claim.
      settle();
      for (let i = 0; i < 3; i += 1) {
        enqueue("synthetic.limit");
      }
      assert.equal(claim("w-limit", 60, 2).length, 2);
      assert.equal(claim("w-limit", 60, 2).length, 1);
      assert.equal(claim("w-limit", 60, 2).length, 0);
      return { order: "available_at, created_at, id" };
    },
  );

  await check(
    "JOB-5 expiry is correct without the sweeper: a later claim reclaims expired leases (one more attempt, new owner) and escalates an exhausted one with one system audit event; the first holder's report answers not_owner; the sweeper never ran",
    async () => {
      settle();
      assert.equal(sweepCalls(), 0);
      const a = enqueue("synthetic.lease", null, { maxAttempts: 3 });
      const b = enqueue("synthetic.lease.last", null, { maxAttempts: 1 });
      const c = enqueue("synthetic.lease", null, { maxAttempts: 3 });
      assert.equal(claim("w-first", 5, 10).length, 3);
      // Not expired yet: nothing to claim.
      assert.equal(claim("w-second", 60, 10).length, 0);
      await sleep(5500);
      const reclaimed = claim("w-second", 60, 10);
      assert.deepEqual(reclaimed.map((r) => r.job_id).sort(), [a, c].sort());
      for (const row of reclaimed) {
        assert.equal(row.attempt, 2);
      }
      for (const id of [a, c]) {
        const row = job(id);
        assert.equal(row.state, "running");
        assert.equal(row.locked_by, "w-second");
        assert.equal(row.attempt_count, 2);
        assert.equal(row.last_error_code, "lease_expired");
      }
      const exhausted = job(b);
      assert.equal(exhausted.state, "escalated");
      assert.notEqual(exhausted.failed_at, null);
      assert.equal(exhausted.locked_by, null);
      assert.equal(exhausted.attempt_count, 1);
      const audit = auditOf(b);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].actor_type, "system");
      assert.equal(audit[0].actor_user_id, null);
      assert.equal(audit[0].action_code, "operational_job.escalated");
      assert.equal(audit[0].reason_code, "attempts_exhausted");
      assert.equal(audit[0].before.state, "running");
      assert.equal(audit[0].after.state, "escalated");
      // The first holder lost its lease.
      assert.equal(complete("w-first", a), "not_owner");
      assert.equal(fail("w-first", c), "not_owner");
      assert.equal(complete("w-second", a), "completed");
      assert.equal(sweepCalls(), 0, "the sweeper never ran");
      return { reclaimed: 2, escalated: 1, sweeper_calls: 0 };
    },
  );
}

async function attemptChecks() {
  await check(
    "JOB-6 attempts are bounded and exhaustion escalates visibly: retry_scheduled while attempts remain, then escalated with failed_at and exactly one system audit event (no error message in it); an escalated job is never claimed or reported again",
    () => {
      settle();
      const id = enqueue("synthetic.bounded", null, { maxAttempts: 2 });
      assert.equal(claim("w-bound").length, 1);
      assert.equal(
        fail("w-bound", id, "provider_timeout", "synthetic first failure"),
        "retry_scheduled",
      );
      let row = job(id);
      assert.equal(row.state, "pending");
      assert.equal(row.last_error_code, "provider_timeout");
      assert.equal(row.last_error_message, "synthetic first failure");
      assert.equal(row.locked_by, null);
      makeDue(id);
      assert.equal(claim("w-bound")[0].attempt, 2);
      assert.equal(
        fail("w-bound", id, "provider_timeout", "synthetic last failure"),
        "escalated",
      );
      row = job(id);
      assert.equal(row.state, "escalated");
      assert.notEqual(row.failed_at, null);
      assert.equal(row.locked_at, null);
      assert.equal(row.attempt_count, 2);
      assert.equal(row.max_attempts, 2);
      const audit = auditOf(id);
      assert.equal(audit.length, 1);
      assert.deepEqual(
        [
          audit[0].actor_type,
          audit[0].actor_user_id,
          audit[0].action_code,
          audit[0].reason_code,
        ],
        ["system", null, "operational_job.escalated", "attempts_exhausted"],
      );
      assert.equal(audit[0].after.last_error_code, "provider_timeout");
      assert.equal("last_error_message" in audit[0].after, false);
      assert.equal(claim("w-bound").length, 0);
      assert.equal(fail("w-bound", id), "not_running");
      assert.equal(complete("w-bound", id), "not_running");
      assert.equal(auditOf(id).length, 1);
      return { escalation_audit: audit[0].action_code };
    },
  );

  await check(
    "JOB-7 duplicate execution has no duplicate effect: a second completion, and any later failure report, answer not_running and change nothing",
    () => {
      settle();
      const id = enqueue("synthetic.duplicate");
      assert.equal(claim("w-dup").length, 1);
      assert.equal(complete("w-dup", id), "completed");
      const after = jobText(id);
      assert.equal(complete("w-dup", id), "not_running");
      assert.equal(fail("w-dup", id), "not_running");
      assert.equal(complete("w-other", id), "not_running");
      assert.equal(jobText(id), after);
      assert.equal(auditOf(id).length, 0);
      return { completed_once: true };
    },
  );

  await check(
    "JOB-8 report answers and input validation: not_owner for another worker, not_running for an unclaimed or unknown job; malformed worker, lease, limit and error code raise 22023; the error message is bounded",
    () => {
      settle();
      const id = enqueue("synthetic.answers");
      assert.equal(complete("w-ans", id), "not_running");
      assert.equal(fail("w-ans", id), "not_running");
      assert.equal(complete("w-ans", uid()), "not_running");
      assert.equal(claim("w-ans").length, 1);
      assert.equal(complete("w-intruder", id), "not_owner");
      assert.equal(fail("w-intruder", id), "not_owner");
      assert.equal(job(id).state, "running");
      for (const [worker, lease, limit] of [
        ["", 60, 1],
        ["bad worker", 60, 1],
        ["w".repeat(65), 60, 1],
        ["w-ok", 4, 1],
        ["w-ok", 3601, 1],
        ["w-ok", 60, 0],
        ["w-ok", 60, 51],
      ]) {
        assert.equal(
          as(
            "service_role",
            null,
            `select count(*) from public.job_claim(${lit(worker)}, ${lease}, ${limit});`,
          ),
          "ERROR 22023",
          `${worker}/${lease}/${limit}`,
        );
      }
      assert.equal(
        as(
          "service_role",
          null,
          "select count(*) from public.job_claim(null, 60, 1);",
        ),
        "ERROR 22023",
      );
      assert.equal(
        as("service_role", null, "select public.job_complete(null, 'w-ans');"),
        "ERROR 22023",
      );
      assert.equal(complete("bad worker", id), "ERROR 22023");
      for (const code of ["", "Bad-Code", "9code", "x".repeat(65)]) {
        assert.equal(fail("w-ans", id, code), "ERROR 22023", code);
      }
      assert.equal(fail("w-ans", id, null), "ERROR 22023");
      // Accepted classes in the bounds.
      assert.equal(claim("A.b:c-d_9", 5, 50).length, 0);
      assert.equal(claim("w-ans", 3600, 1).length, 0);
      const long = `synthetic\u0001failure\n${"x".repeat(700)}`;
      assert.equal(
        fail("w-ans", id, "provider_unavailable", long),
        "retry_scheduled",
      );
      const message = job(id).last_error_message;
      assert.equal(message.length, 500);
      assert.equal(/[\u0000-\u001f\u007f]/.test(message), false);
      assert.ok(message.startsWith("synthetic failure "));
      return { error_message_length: message.length };
    },
  );

  await check(
    "JOB-9 failure backoff is computed in the database: 30 s x 2^(attempt - 1), capped at one hour; available_at moves forward each time",
    () => {
      settle();
      const id = enqueue("synthetic.backoff", null, { maxAttempts: 25 });
      const observed = [];
      for (let attempt = 1; attempt <= 9; attempt += 1) {
        makeDue(id);
        assert.equal(claim("w-backoff")[0].attempt, attempt);
        assert.equal(fail("w-backoff", id, "provider_busy"), "retry_scheduled");
        const delay = Number(
          sql(
            `select extract(epoch from available_at - clock_timestamp()) from public.operational_jobs where id = '${id}';`,
          ),
        );
        const expected = Math.min(30 * 2 ** (attempt - 1), 3600);
        assert.ok(
          delay <= expected && delay > expected - 5,
          `attempt ${attempt}: ${delay} vs ${expected}`,
        );
        observed.push(Math.round(delay));
      }
      return { delays_seconds: observed };
    },
  );

  await check(
    "JOB-10 cancellation when the subject becomes terminal: every open job of the subject (pending, running, escalated) is cancelled and counted; completed jobs and other subjects are untouched; the holder's report answers not_running",
    () => {
      settle();
      const subject = uid();
      const otherSubject = uid();
      const escalated = escalatedJob("synthetic.cancel.c", subject);
      const running = enqueue("synthetic.cancel.b", subject);
      assert.deepEqual(
        claim("w-cancel").map((r) => r.job_id),
        [running],
      );
      const done = enqueue("synthetic.cancel.d", subject);
      assert.deepEqual(
        claim("w-cancel").map((r) => r.job_id),
        [done],
      );
      assert.equal(complete("w-cancel", done), "completed");
      const pending = enqueue("synthetic.cancel.a", subject, {
        availableAt: "now() + interval '1 hour'",
      });
      const unrelated = enqueue("synthetic.cancel.a", otherSubject, {
        availableAt: "now() + interval '1 hour'",
      });
      assert.equal(
        sql(
          `select public.job_cancel_for_subject('${SUBJECT}', '${subject}');`,
        ),
        "3",
      );
      for (const id of [escalated, running, pending]) {
        const row = job(id);
        assert.equal(row.state, "cancelled");
        assert.equal(row.locked_by, null);
        assert.equal(row.failed_at, null);
      }
      assert.equal(job(done).state, "completed");
      assert.equal(job(unrelated).state, "pending");
      assert.equal(complete("w-cancel", running), "not_running");
      assert.equal(
        sql(
          `select public.job_cancel_for_subject('${SUBJECT}', '${subject}');`,
        ),
        "0",
      );
      assert.equal(
        refused(`select public.job_cancel_for_subject(null, '${subject}');`),
        "22023",
      );
      assert.notEqual(enqueue("synthetic.cancel.a", subject), pending);
      return { cancelled: 3 };
    },
  );
}

async function durabilityChecks() {
  await check(
    "JOB-11 pending jobs survive restart: a job enqueued and committed before an immediate (crash) stop is still pending after restart and is claimed and completed",
    () => {
      settle();
      const id = enqueue("synthetic.durable", uid());
      assert.equal(job(id).state, "pending");
      assert.equal(openSessions.size, 0);
      pgCtl(["-m", "immediate", "stop"]);
      state.started = false;
      pgCtl(["-l", path.join(state.tmp, "postgres.log"), "start"]);
      state.started = true;
      const row = job(id);
      assert.equal(row.state, "pending");
      assert.equal(row.attempt_count, 0);
      assert.deepEqual(
        claim("w-restart").map((r) => r.job_id),
        [id],
      );
      assert.equal(complete("w-restart", id), "completed");
      return { restart: "pg_ctl stop -m immediate; pg_ctl start" };
    },
  );

  await check(
    "JOB-12 the sweeper reclaims expired leases with attempts left, escalates exhausted ones with one system audit event, leaves live leases and pending jobs untouched, writes nothing else, and is idempotent",
    async () => {
      settle();
      const reclaim = enqueue("synthetic.sweep", null, { maxAttempts: 3 });
      const exhaust = enqueue("synthetic.sweep.last", null, { maxAttempts: 1 });
      assert.equal(claim("w-sweep", 5, 10).length, 2);
      const live = enqueue("synthetic.sweep.live");
      assert.equal(claim("w-live", 3600, 10).length, 1);
      const waiting = enqueue("synthetic.sweep.waiting", null, {
        availableAt: "now() + interval '1 hour'",
      });
      const before = {
        live: jobText(live),
        waiting: jobText(waiting),
        audit: count("audit_events"),
      };
      await sleep(5500);
      assert.deepEqual(
        JSON.parse(sql("select public.operational_jobs_sweep();")),
        {
          reclaimed: 1,
          escalated: 1,
        },
      );
      const reclaimed = job(reclaim);
      assert.equal(reclaimed.state, "pending");
      assert.equal(reclaimed.attempt_count, 1);
      assert.equal(reclaimed.locked_by, null);
      assert.equal(reclaimed.last_error_code, "lease_expired");
      assert.equal(job(exhaust).state, "escalated");
      const audit = auditOf(exhaust);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].actor_type, "system");
      assert.equal(audit[0].action_code, "operational_job.escalated");
      assert.equal(jobText(live), before.live);
      assert.equal(jobText(waiting), before.waiting);
      assert.equal(count("audit_events"), before.audit + 1);
      assert.deepEqual(
        JSON.parse(sql("select public.operational_jobs_sweep();")),
        {
          reclaimed: 0,
          escalated: 0,
        },
      );
      // The reclaimed job is claimable at once.
      assert.deepEqual(
        claim("w-after-sweep").map((r) => [r.job_id, r.attempt]),
        [[reclaim, 2]],
      );
      return { first_sweep: { reclaimed: 1, escalated: 1 } };
    },
  );
}

async function staffChecks() {
  await check(
    "JOB-13 staff retry and cancel need manage_operational_jobs (global grant, active staff) AND an aal2 session; both are audited with the staff actor; a retry keeps the attempt history and adds one bounded round",
    () => {
      settle();
      const admin = world.jobsAdmin;
      const escalated = escalatedJob("synthetic.staff", uid(), 2);
      const pending = enqueue("synthetic.staff.pending", uid(), {
        availableAt: "now() + interval '1 hour'",
      });
      const done = enqueue("synthetic.staff.done");
      assert.equal(claim("w-staff").length, 1);
      assert.equal(complete("w-staff", done), "completed");
      const before = jobText(escalated);
      // Refused as unauthorized: aal1, claim-less, malformed claims, other
      // staff, a jurisdiction-scoped, revoked or deactivated grant holder, a
      // client.
      const denials = {
        aal1: staffCall(admin, "staff_retry_job", escalated, { aal: "aal1" }),
        claimless: staffCall(admin, "staff_retry_job", escalated, {
          aal: null,
        }),
        malformed: staffCall(admin, "staff_retry_job", escalated, {
          claims: "not json",
        }),
        other: staffCall(world.otherStaff, "staff_retry_job", escalated),
        scoped: staffCall(world.scopedAdmin, "staff_retry_job", escalated),
        revoked: staffCall(world.revokedAdmin, "staff_retry_job", escalated),
        deactivated: staffCall(
          world.deactivatedAdmin,
          "staff_retry_job",
          escalated,
        ),
        client: staffCall(world.client, "staff_retry_job", escalated),
        cancelAal1: staffCall(admin, "staff_cancel_job", pending, {
          aal: "aal1",
        }),
      };
      for (const [label, answer] of Object.entries(denials)) {
        assert.equal(answer, "denied", label);
      }
      assert.equal(jobText(escalated), before);
      assert.equal(job(pending).state, "pending");
      assert.equal(auditOf(pending).length, 0);
      // Authorized retry.
      assert.equal(staffCall(admin, "staff_retry_job", escalated), "applied");
      const retried = job(escalated);
      assert.equal(retried.state, "pending");
      assert.equal(retried.failed_at, null);
      assert.equal(retried.attempt_count, 2);
      assert.equal(retried.max_attempts, 4);
      assert.equal(
        sql(
          `select available_at <= clock_timestamp() from public.operational_jobs where id = '${escalated}';`,
        ),
        "t",
      );
      const retryAudit = auditOf(escalated).filter(
        (row) => row.action_code === "operational_job.retried",
      );
      assert.equal(retryAudit.length, 1);
      assert.equal(retryAudit[0].actor_user_id, admin.user);
      assert.equal(retryAudit[0].actor_type, "staff");
      assert.equal(retryAudit[0].before.state, "escalated");
      assert.equal(retryAudit[0].after.state, "pending");
      assert.equal(retryAudit[0].after.max_attempts, 4);
      assert.equal(
        staffCall(admin, "staff_retry_job", escalated),
        "invalid_transition",
      );
      assert.equal(staffCall(admin, "staff_retry_job", uid()), "not_found");
      assert.equal(staffCall(admin, "staff_retry_job", null), "invalid");
      // The retried job runs its new bounded round.
      assert.deepEqual(
        claim("w-staff").map((r) => [r.job_id, r.attempt, r.max_attempts]),
        [[escalated, 3, 4]],
      );
      // Authorized cancel.
      assert.equal(staffCall(admin, "staff_cancel_job", pending), "applied");
      assert.equal(job(pending).state, "cancelled");
      const cancelAudit = auditOf(pending);
      assert.equal(cancelAudit.length, 1);
      assert.deepEqual(
        [
          cancelAudit[0].actor_user_id,
          cancelAudit[0].actor_type,
          cancelAudit[0].action_code,
        ],
        [admin.user, "staff", "operational_job.cancelled"],
      );
      assert.equal(
        staffCall(admin, "staff_cancel_job", pending),
        "invalid_transition",
      );
      assert.equal(
        staffCall(admin, "staff_cancel_job", done),
        "invalid_transition",
      );
      assert.equal(staffCall(admin, "staff_cancel_job", escalated), "applied");
      assert.equal(complete("w-staff", escalated), "not_running");
      // Other API roles cannot execute the staff functions.
      for (const role of ["anon", "service_role"]) {
        assert.equal(
          as(role, null, `select public.staff_retry_job('${escalated}');`),
          "ERROR 42501",
          role,
        );
        assert.equal(
          as(role, null, `select public.staff_cancel_job('${escalated}');`),
          "ERROR 42501",
          role,
        );
      }
      return { denials: Object.keys(denials).length };
    },
  );

  await check(
    "JOB-14 staff job reads: an aal2 session with the global capability sees every job; aal1, claim-less, other staff, scoped grant holders, attorneys and clients see none; anon has no read privilege",
    () => {
      const total = count("operational_jobs");
      assert.ok(total > 0);
      const read = (principal, options = {}) =>
        as(
          "authenticated",
          principal.auth,
          "select count(*) from public.operational_jobs;",
          options,
        );
      assert.equal(read(world.jobsAdmin), String(total));
      assert.equal(read(world.jobsAdmin, { aal: "aal1" }), "0");
      assert.equal(read(world.jobsAdmin, { aal: null }), "0");
      assert.equal(read(world.otherStaff), "0");
      assert.equal(read(world.scopedAdmin), "0");
      assert.equal(read(world.revokedAdmin), "0");
      assert.equal(read(world.applicant), "0");
      assert.equal(read(world.client), "0");
      assert.equal(
        as("anon", null, "select count(*) from public.operational_jobs;"),
        "ERROR 42501",
      );
      return { total };
    },
  );
}

async function privilegeChecks() {
  await check(
    "PRIV-1 no API role writes operational_jobs (no table or column write grant); authenticated reads through the staff policy; service_role keeps SELECT; direct writes are refused",
    () => {
      for (const role of ["anon", "authenticated", "service_role"]) {
        for (const privilege of [
          "INSERT",
          "UPDATE",
          "DELETE",
          "TRUNCATE",
          "REFERENCES",
          "TRIGGER",
        ]) {
          assert.equal(
            sql(
              `select has_table_privilege('${role}', 'public.operational_jobs', '${privilege}');`,
            ),
            "f",
            `${role} ${privilege}`,
          );
        }
      }
      assert.equal(
        sql(
          "select count(*) from information_schema.column_privileges where table_schema = 'public' and table_name = 'operational_jobs' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC') and privilege_type <> 'SELECT';",
        ),
        "0",
      );
      assert.equal(
        sql(
          "select has_table_privilege('authenticated', 'public.operational_jobs', 'SELECT')::text || has_table_privilege('service_role', 'public.operational_jobs', 'SELECT')::text || has_table_privilege('anon', 'public.operational_jobs', 'SELECT')::text;",
        ),
        "truetruefalse",
      );
      assert.equal(
        sql(
          "select string_agg(polname || ':' || polcmd::text, ',') from pg_policy where polrelid = 'public.operational_jobs'::regclass;",
        ),
        "operational_jobs_staff_read:r",
      );
      assert.equal(
        sql(
          "select relrowsecurity from pg_class where oid = 'public.operational_jobs'::regclass;",
        ),
        "t",
      );
      for (const role of ["service_role", "authenticated"]) {
        assert.equal(
          as(
            role,
            role === "authenticated" ? world.jobsAdmin.auth : null,
            "insert into public.operational_jobs (job_type, state, available_at, max_attempts) values ('synthetic.direct', 'pending', now(), 3);",
          ),
          "ERROR 42501",
          role,
        );
        assert.equal(
          as(
            role,
            role === "authenticated" ? world.jobsAdmin.auth : null,
            "update public.operational_jobs set available_at = now();",
          ),
          "ERROR 42501",
          role,
        );
      }
      return { api_role_write_grants: 0 };
    },
  );

  await check(
    "PRIV-2 function privileges: only service_role executes job_claim, job_complete and job_fail; only authenticated executes the staff job functions; no API role executes job_enqueue, job_cancel_for_subject, the sweeper, the internal helpers or current_session_aal2; definer and search_path settings are fixed",
    () => {
      const exec = (role, signature) =>
        sql(
          `select has_function_privilege('${role}', 'public.${signature}', 'EXECUTE');`,
        ) === "t";
      const config = (signature) =>
        sql(
          `select prosecdef::text || '|' || array_to_string(proconfig, ';') || '|' || pg_get_userbyid(proowner) from pg_proc where oid = 'public.${signature}'::regprocedure;`,
        );
      const ROLES = ["anon", "authenticated", "service_role"];
      const expectations = [
        ["job_claim(text, integer, integer)", ["service_role"], true],
        ["job_complete(uuid, text)", ["service_role"], true],
        ["job_fail(uuid, text, text, text)", ["service_role"], true],
        ["staff_retry_job(uuid)", ["authenticated"], true],
        ["staff_cancel_job(uuid)", ["authenticated"], true],
        [
          "job_enqueue(text, text, uuid, timestamp with time zone, integer)",
          [],
          false,
        ],
        ["job_cancel_for_subject(text, uuid)", [], false],
        ["operational_jobs_sweep()", [], false],
      ];
      for (const [signature, allowed, definer] of expectations) {
        for (const role of ROLES) {
          assert.equal(
            exec(role, signature),
            allowed.includes(role),
            `${role} ${signature}`,
          );
        }
        assert.equal(exec("public", signature), false, `public ${signature}`);
        assert.equal(
          config(signature),
          `${definer}|search_path=pg_catalog, pg_temp;lock_timeout=3s|postgres`,
          signature,
        );
      }
      for (const signature of [
        "operational_jobs_lifecycle()",
        "operational_job_audit(uuid, text, text, uuid, jsonb, jsonb, text)",
        "operational_job_snapshot(operational_jobs)",
        "operational_job_error_message(text)",
        "operational_job_escalate(operational_jobs, text, text, text)",
        "current_session_aal2()",
      ]) {
        for (const role of [...ROLES, "public"]) {
          assert.equal(exec(role, signature), false, `${role} ${signature}`);
        }
        assert.equal(
          config(signature),
          "false|search_path=pg_catalog|postgres",
          signature,
        );
      }
      // The owner can call them; API callers are refused.
      assert.equal(
        as(
          "service_role",
          null,
          "select public.job_enqueue('synthetic.api', null, null, null, 3);",
        ),
        "ERROR 42501",
      );
      assert.equal(
        as("service_role", null, "select public.operational_jobs_sweep();"),
        "ERROR 42501",
      );
      assert.equal(
        as(
          "authenticated",
          world.jobsAdmin.auth,
          "select count(*) from public.job_claim('w-api', 60, 1);",
        ),
        "ERROR 42501",
      );
      assert.equal(
        as(
          "anon",
          null,
          "select count(*) from public.job_claim('w-api', 60, 1);",
        ),
        "ERROR 42501",
      );
      assert.equal(
        as(
          "authenticated",
          world.jobsAdmin.auth,
          "select public.current_session_aal2();",
        ),
        "ERROR 42501",
      );
      return { functions: expectations.length + 6 };
    },
  );

  await check(
    "PRIV-3 the capability catalog gains exactly manage_operational_jobs (seven codes); no grant, job or business row is created by the migrations; the triggers on operational_jobs are exactly the lifecycle and truncate guards",
    () => {
      assert.equal(
        sql(
          "select string_agg(capability_code, ',' order by capability_code) from public.capability_definitions;",
        ),
        CAPABILITIES.join(","),
      );
      assert.equal(
        sql(
          "select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = 'public.operational_jobs'::regclass and not tgisinternal;",
        ),
        "operational_jobs_lifecycle,operational_jobs_no_truncate",
      );
      assert.equal(
        sql(
          "select string_agg(indexrelid::regclass::text, ',' order by indexrelid::regclass::text) from pg_index where indrelid = 'public.operational_jobs'::regclass;",
        ),
        "operational_jobs_claimable_idx,operational_jobs_open_subject_unique,operational_jobs_pkey",
      );
      return { capability_codes: CAPABILITIES.length };
    },
  );
}

async function assuranceChecks() {
  const aalStates = [
    ["aal2", {}],
    ["aal1", { aal: "aal1" }],
    ["claim-less", { aal: null }],
  ];

  await check(
    'AAL-1 current_session_aal2 is true only for claims that are a JSON object with aal exactly "aal2"; missing, empty, malformed, non-object and other values are false',
    () => {
      const sub = uid();
      const value = (claims) =>
        as(
          "postgres",
          null,
          "select coalesce(public.current_session_aal2()::text, 'null');",
          { claims },
        );
      const cases = [
        [JSON.stringify({ sub, aal: "aal2" }), "true"],
        [JSON.stringify({ aal: "aal2", amr: [{ method: "totp" }] }), "true"],
        [JSON.stringify({ sub, aal: "aal1" }), "false"],
        [JSON.stringify({ sub }), "false"],
        [JSON.stringify({ aal: "AAL2" }), "false"],
        [JSON.stringify({ aal: "aal2 " }), "false"],
        [JSON.stringify({ aal: ["aal2"] }), "false"],
        [JSON.stringify({ aal: { level: "aal2" } }), "false"],
        [JSON.stringify({ aal: 2 }), "false"],
        [JSON.stringify(["aal2"]), "false"],
        [JSON.stringify("aal2"), "false"],
        ["not json", "false"],
        ["{", "false"],
        ["", "false"],
        [null, "false"],
      ];
      for (const [claims, expected] of cases) {
        assert.equal(value(claims), expected, String(claims));
      }
      return { cases: cases.length };
    },
  );

  await check(
    "AAL-2 has_staff_capability and the row policies that use it: true and visible for aal2 with the grant; false and empty for aal1 and claim-less sessions of the same identity and grant",
    () => {
      const admin = world.capabilityAdmin;
      const results = {};
      for (const [label, options] of aalStates) {
        results[label] = [
          as(
            "authenticated",
            admin.auth,
            "select coalesce(public.has_staff_capability('manage_staff_capabilities', null, false)::text, 'null');",
            options,
          ),
          as(
            "authenticated",
            admin.auth,
            "select count(*) from public.capability_definitions;",
            options,
          ),
          as(
            "authenticated",
            admin.auth,
            "select count(*) from public.capability_grants;",
            options,
          ),
        ];
      }
      assert.deepEqual(results.aal2.slice(0, 2), [
        "true",
        String(CAPABILITIES.length),
      ]);
      assert.ok(Number(results.aal2[2]) > 0);
      assert.deepEqual(results.aal1, ["false", "0", "0"]);
      assert.deepEqual(results["claim-less"], ["false", "0", "0"]);
      // Claims of the same subject without an aal member.
      assert.equal(
        as(
          "authenticated",
          admin.auth,
          "select coalesce(public.has_staff_capability('manage_staff_capabilities', null, false)::text, 'null');",
          {
            claims: JSON.stringify({ sub: admin.auth, role: "authenticated" }),
          },
        ),
        "false",
      );
      return results;
    },
  );

  await check(
    "AAL-3 has_manage_attorney_verification_scope and the M4 row policies: the verifier reads attorney profiles and licenses at aal2 only; aal1 and claim-less sessions see nothing of other attorneys; an attorney's own reads are unaffected",
    () => {
      const results = {};
      for (const [label, options] of aalStates) {
        results[label] = [
          as(
            "authenticated",
            world.verifier.auth,
            "select coalesce(public.has_manage_attorney_verification_scope(null, false)::text, 'null');",
            options,
          ),
          as(
            "authenticated",
            world.verifier.auth,
            "select count(*) from public.attorney_profiles;",
            options,
          ),
          as(
            "authenticated",
            world.verifier.auth,
            "select count(*) from public.licenses;",
            options,
          ),
        ];
      }
      assert.equal(results.aal2[0], "true");
      assert.ok(Number(results.aal2[1]) >= 2);
      assert.equal(results.aal2[2], "1");
      assert.deepEqual(results.aal1, ["false", "0", "0"]);
      assert.deepEqual(results["claim-less"], ["false", "0", "0"]);
      // Own-row reads need no step-up.
      for (const [, options] of aalStates) {
        assert.equal(
          as(
            "authenticated",
            world.approved.auth,
            "select count(*) from public.attorney_profiles;",
            options,
          ),
          "1",
        );
        assert.equal(
          as(
            "authenticated",
            world.approved.auth,
            "select count(*) from public.licenses;",
            options,
          ),
          "1",
        );
      }
      return results;
    },
  );

  await check(
    "AAL-4 lock_current_capability_staff (capability administration): aal1 and claim-less sessions are denied and write nothing; the same identity and grant at aal2 creates the grant",
    () => {
      const call = (options) =>
        as(
          "authenticated",
          world.capabilityAdmin.auth,
          `select to_jsonb(r) ->> 'outcome' from public.staff_grant_capability('${world.grantee.user}', 'manage_operational_jobs', null, null) as r;`,
          options,
        );
      const grants = () =>
        count("capability_grants", `user_id = '${world.grantee.user}'`);
      const before = grants();
      assert.equal(call({ aal: "aal1" }), "denied");
      assert.equal(call({ aal: null }), "denied");
      assert.equal(
        call({
          claims: JSON.stringify({
            sub: world.capabilityAdmin.auth,
            role: "authenticated",
          }),
        }),
        "denied",
      );
      assert.equal(grants(), before);
      assert.equal(call({}), "created");
      assert.equal(grants(), before + 1);
      return { aal1: "denied", claimless: "denied", aal2: "created" };
    },
  );

  await check(
    "AAL-5 lock_current_verification_staff (staff verification writes): aal1 and claim-less sessions are denied and audit nothing; aal2 applies with one audit event",
    () => {
      const call = (options) =>
        as(
          "authenticated",
          world.verifier.auth,
          `select public.staff_record_source_unavailable('license', '${world.license}', 'synthetic source unavailable');`,
          options,
        );
      const audits = () =>
        count(
          "audit_events",
          `action_code = 'verification_source_unavailable' and resource_id = '${world.license}'`,
        );
      assert.equal(call({ aal: "aal1" }), "denied");
      assert.equal(call({ aal: null }), "denied");
      assert.equal(audits(), 0);
      assert.equal(call({}), "applied");
      assert.equal(audits(), 1);
      return { aal1: "denied", claimless: "denied", aal2: "applied" };
    },
  );

  await check(
    "AAL-6 lock_current_intake_configuration_staff (intake configuration publication): aal1 and claim-less sessions are forbidden and publish nothing; aal2 publishes",
    () => {
      const call = (options) =>
        as(
          "authenticated",
          world.intakeAdmin.auth,
          `select to_jsonb(r) ->> 'outcome' from public.staff_publish_intake_question_set(${lit(V1_KEY)}, ${lit(V1)}::jsonb) as r;`,
          options,
        );
      assert.equal(call({ aal: "aal1" }), "forbidden");
      assert.equal(call({ aal: null }), "forbidden");
      assert.equal(count("intake_question_sets"), 0);
      assert.equal(call({}), "published");
      assert.equal(count("intake_question_sets"), 1);
      return { aal1: "forbidden", claimless: "forbidden", aal2: "published" };
    },
  );

  await check(
    "AAL-7 lock_current_attorney_profile (attorney professional writes): aal1 and claim-less sessions are denied and change nothing; the same attorney at aal2 applies",
    () => {
      const details = (name, options) =>
        as(
          "authenticated",
          world.applicant.auth,
          `select public.attorney_save_profile_details('applicant', ${lit(name)}, null, null, null);`,
          options,
        );
      const license = (number, options) =>
        as(
          "authenticated",
          world.applicant.auth,
          `select public.attorney_save_license_claim(null, null, '${world.jurisdiction}', ${lit(number)}, null, null, null);`,
          options,
        );
      const profile = () =>
        sql(
          `select coalesce(display_name, '') from public.attorney_profiles where id = '${world.applicantProfile}';`,
        );
      const licenses = () =>
        count("licenses", `attorney_id = '${world.applicantProfile}'`);
      assert.equal(
        details("Synthetic Attorney One", { aal: "aal1" }),
        "denied",
      );
      assert.equal(details("Synthetic Attorney One", { aal: null }), "denied");
      assert.equal(license("SYN-S2-A1", { aal: "aal1" }), "denied");
      assert.equal(license("SYN-S2-A1", { aal: null }), "denied");
      assert.equal(profile(), "");
      assert.equal(licenses(), 0);
      assert.equal(details("Synthetic Attorney One", {}), "applied");
      assert.equal(profile(), "Synthetic Attorney One");
      assert.equal(license("SYN-S2-A1", {}), "applied");
      assert.equal(licenses(), 1);
      return { aal1: "denied", claimless: "denied", aal2: "applied" };
    },
  );

  await check(
    "AAL-8 client functions and attorney_start_application are unaffected: aal1 and claim-less sessions start an application and create an intake",
    () => {
      for (const [principal, options] of [
        [world.newcomer, { aal: "aal1" }],
        [world.newcomer2, { aal: null }],
      ]) {
        assert.equal(
          as(
            "authenticated",
            principal.auth,
            "select profile_state from public.attorney_start_application();",
            options,
          ),
          "applicant",
        );
      }
      const intake = (options) =>
        as(
          "authenticated",
          world.client.auth,
          "select to_jsonb(r) ->> 'outcome' from public.client_create_intake() as r;",
          options,
        );
      assert.equal(intake({ aal: "aal1" }), "created");
      assert.equal(intake({ aal: null }), "created");
      assert.ok(
        Number(
          as(
            "authenticated",
            world.client.auth,
            "select count(*) from public.client_intake_practice_areas();",
            { aal: null },
          ),
        ) >= 0,
      );
      return {
        attorney_start_application: "applicant",
        client_intake: "created",
      };
    },
  );
}

async function main() {
  try {
    startCluster();
    applyMigrations();
    seed();
    await migrationChecks();
    await lifecycleChecks();
    await claimChecks();
    await attemptChecks();
    await durabilityChecks();
    await staffChecks();
    await privilegeChecks();
    await assuranceChecks();
  } catch (error) {
    report.error = String(error?.stack ?? error);
    failed = true;
  }
  const cleaned = teardown();
  report.cleanup = cleaned;
  report.result = failed ? "FAIL" : cleaned ? "PASS" : "CLEANUP-FAILED";
  report.summary = {
    passed: report.checks.filter((c) => c.result === "PASS").length,
    total: report.checks.length,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = failed ? 1 : cleaned ? 0 : 2;
}

await main();
