// MVP-001 S4 disposable PostgreSQL proof (M6 Scheduling foundation).
// Explicitly invoked only:
//
//   node apps/web/tests/mvp-001-s4-db-proof.mjs
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
// one transaction; the three S4 migrations must follow S3 and be registered.
// The database records its environment as development, and every policy
// version used here is development configuration created by the owner role
// inside this disposable cluster (Packet rule 9): the values are test values,
// never product values.
//
// Request sessions are modelled as PostgREST sets them from a verified JWT:
// request.jwt.claim.sub and the JSON request.jwt.claims ("aal": "aal2" after
// a Supabase Auth MFA step-up, "aal1" before it; "session_id" and "exp" as
// Supabase Auth issues them).
//
// The probes cover the MVP-001 Packet S4 acceptance list for the database:
// migration order and registration; the function and privilege inventory
// (writes function-only, service_role narrowed to SELECT); every S4
// integrity guard for every role, the owner included; scheduling policy
// selection (unrecorded environment, no policy, incomplete, conflict); IANA
// validation; daylight-saving gap and overlap exclusion and correct UTC
// windows across transitions; the attorney schedule functions (outcomes,
// aal2, ownership, abuse bounds, audit); the application session and Instant
// mode (bound to one session, a new session starts off, sign-out turns it
// off and it stays off at the next sign-in, server lease expiry, presence
// needs a policy and a recent server observation, aal1 refused); Bookability
// evidence (append-only, each factor with its reason, Available Now needs
// intent, presence and eligibility; unset policy is not bookable); the Slot
// Hold lifecycle (acquisition outcomes, expiry from policy, release,
// conversion, lazy expiry with no scheduler, the bounded sweep, Hold expiry
// expiring its Request atomically); the seven IMP section 20 concurrency
// tests under real concurrency with persistent sessions; MBS section 9
// invariants 1-6 each explicitly; and audit minimization.
//
// MVP-001 S5 update: the three S5 migrations follow S4 (S4 stays contiguous
// and in order right after S3), and a Referral now commits only with its
// point-in-time evidence (20261121010000), so the synthetic Requests' owner
// fixture also writes, with each Referral, its allocation method, an
// eligible Eligibility Evaluation, a pool entry, a presentation and a
// bookable referral-context Bookability Evaluation. No Supabase
// project, network service, or pre-existing cluster is contacted, nothing
// persists after the run, and every value is synthetic test data. The JSON
// report goes to stdout; exit 0 means PASS, 1 FAIL, 2 cleanup failure.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54339;
const DB = "rosuno_s4_proof";
const REPOSITORY_ROOT = path.resolve(
  path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
  "../../..",
);
const MIGRATIONS = path.join(REPOSITORY_ROOT, "supabase/migrations");
const S3_LAST = "20261119070000_mvp_001_s3_intake_lifecycle_correction.sql";
const S4_MIGRATIONS = Object.freeze([
  "20261120010000_mvp_001_s4_scheduling_integrity.sql",
  "20261120020000_mvp_001_s4_availability_instant.sql",
  "20261120030000_mvp_001_s4_holds_bookability.sql",
]);

const report = {
  proof: "MVP-001 S4 disposable local PostgreSQL proof",
  migrations: {},
  checks: [],
  concurrency: {},
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
function refused(statement, db = DB) {
  const result = psql(["begin;", statement, "commit;"].join("\n"), db);
  assert.notEqual(result.status, 0, `expected a refusal: ${statement}`);
  return sqlstateOf(result.stderr);
}

// An owner statement that must succeed, inside a transaction rolled back.
function acceptedThenRolledBack(statement, db = DB) {
  const result = psql(["begin;", statement, "rollback;"].join("\n"), db);
  assert.equal(result.status, 0, `${statement}\n${result.stderr}`);
  return result.stdout.trim();
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

const nowSeconds = () => Math.floor(Date.now() / 1000);

// The session lines of one request: a role, an optional JWT subject, and the
// JWT claims. With a subject, the claims default to an aal2 session; aal
// "aal1" models a session before MFA step-up and aal null a request without
// claims. A provider session ({ id, exp }) adds the session_id and exp claims
// Supabase Auth issues.
function sessionLines(role, sub, { aal = "aal2", session = null } = {}) {
  const lines = [`set local role ${role};`];
  if (sub !== null) {
    lines.push(
      `select set_config('request.jwt.claim.sub', ${lit(sub)}, true) is not null;`,
    );
    if (aal !== null) {
      const claims = { sub, role, aal };
      if (session !== null) {
        claims.session_id = session.id;
        claims.exp = session.exp;
      }
      lines.push(
        `select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true) is not null;`,
      );
    }
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

// All output lines of one request statement (for row-returning reads).
function rowsAs(role, sub, statement, options = {}) {
  const result = psql(
    [
      "begin;",
      ...sessionLines(role, sub, options),
      statement,
      "commit;",
      "",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .trim()
    .split("\n")
    .filter((line) => line !== "" && line !== "t");
}

const uid = () => randomUUID();
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function count(table, where = "true") {
  return Number(sql(`select count(*) from public.${table} where ${where};`));
}

const FIXTURE = `
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

const ROLES = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
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
    path.join(os.tmpdir(), "rosuno-mvp-001-s4-db-proof-"),
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
      "max_connections = 60",
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
  for (const open of [...openSessions]) {
    try {
      open.child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
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

function migrationFiles() {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function applyMigrations() {
  const files = migrationFiles();
  const registered = JSON.parse(
    fs.readFileSync(
      path.join(
        REPOSITORY_ROOT,
        "governance/migrations/reviewed-migrations.json",
      ),
      "utf8",
    ),
  ).migrations;
  // S4 follows S3, contiguous and in order, and every S4 migration is
  // registered unreviewed and applied nowhere. MVP-001 S5: only the three S5
  // migrations, contiguous and in order, follow S4.
  const s3 = files.indexOf(S3_LAST);
  assert.ok(s3 >= 0, "the last S3 migration is present");
  assert.deepEqual(files.slice(s3 + 1, s3 + 1 + S4_MIGRATIONS.length), [
    ...S4_MIGRATIONS,
  ]);
  assert.deepEqual(files.slice(s3 + 1 + S4_MIGRATIONS.length), [
    "20261121010000_mvp_001_s5_referral_integrity.sql",
    "20261121020000_mvp_001_s5_discovery.sql",
    "20261121030000_mvp_001_s5_referral.sql",
  ]);
  const workItems = JSON.parse(
    fs.readFileSync(
      path.join(REPOSITORY_ROOT, "governance/work-items/index.json"),
      "utf8",
    ),
  ).work_items;
  const program = workItems.find(
    (item) => item.work_item_id === "WI-P2-MVP-001-TECHNICAL-COMPLETION",
  );
  for (const file of S4_MIGRATIONS) {
    const id = file.replace(/\.sql$/, "");
    const row = registered.find(
      (migration) => migration.artifact_path === `supabase/migrations/${file}`,
    );
    assert.ok(row, `${file} is registered`);
    assert.equal(row.migration_id, id);
    assert.equal(row.reviewed, false);
    assert.equal(row.applied_environment, "none");
    assert.ok(program.migration_refs.includes(id), `${id} is a Program ref`);
  }
  sql(ROLES, "postgres");
  sql(FIXTURE, "postgres");
  assert.equal(
    sql("select count(*) from pg_available_extensions where name = 'pg_cron';"),
    "0",
    "this disposable cluster has no pg_cron",
  );
  const notices = {};
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
    if (S4_MIGRATIONS.includes(file)) {
      notices[file] = [...result.stderr.matchAll(/NOTICE:\s+(.*)/g)].map(
        (match) => match[1],
      );
    }
  }
  report.migrations.applied = files.length;
  report.migrations.s4 = [...S4_MIGRATIONS];
  report.migrations.notices = notices;
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
    const mark = `__S4_${this.label}_${this.n}__`;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${this.label}: no answer to ${statement}`)),
        30000,
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
    process.stderr.write(`[s4-proof] PASS ${name}\n`);
  } catch (error) {
    failed = true;
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
    process.stderr.write(`[s4-proof] FAIL ${name}\n${error?.stack ?? error}\n`);
  } finally {
    // A probe that failed half-way must not leave a transaction holding locks
    // into the next check: end its backends (rolling back) and its clients.
    for (const open of [...openSessions]) {
      if (Number.isInteger(open.pid)) {
        psql(`select pg_terminate_backend(${open.pid});`);
      }
      open.child.kill("SIGKILL");
      openSessions.delete(open);
    }
  }
}

// ---------------------------------------------------------------------------
// Synthetic seed and call helpers
// ---------------------------------------------------------------------------

const world = {};
let ordinal = 0;

function newAccount(accountState = "active") {
  const auth = uid();
  const user = uid();
  sql(
    `insert into auth.users (id) values ('${auth}');
     insert into public.users (id, auth_user_id, account_state) values ('${user}', '${auth}', '${accountState}');`,
  );
  return { auth, user };
}

function newAttorney(profileState = "approved") {
  const ids = newAccount();
  const profile = uid();
  sql(
    `insert into public.attorney_profiles (id, user_id, profile_state) values ('${profile}', '${ids.user}', '${profileState}');`,
  );
  return { ...ids, profile };
}

function newClient() {
  const ids = newAccount();
  const client = uid();
  const intake = uid();
  sql(
    `insert into public.client_profiles (id, user_id) values ('${client}', '${ids.user}');
     insert into public.intakes (id, client_id, state) values ('${intake}', '${client}', 'submitted');`,
  );
  return { ...ids, client, intake };
}

function newJurisdiction(code) {
  const id = uid();
  sql(
    `insert into public.jurisdictions (id, code, name, region_type) values ('${id}', '${code}', 'Synthetic ${code}', 'synthetic');`,
  );
  return id;
}

// Development configuration created by the owner role in this disposable
// database only (Packet rule 9): test values, never product values.
function policy(
  type,
  jurisdiction,
  parameters,
  { from = "now() - interval '1 hour'" } = {},
) {
  const id = uid();
  sql(
    `insert into public.policy_versions (id, policy_type_code, jurisdiction_id, version_label, parameters, status, effective_from, development_only)
     values ('${id}', ${lit(type)}, ${lit(jurisdiction)}, ${lit(`synthetic-${type}-${id.slice(0, 8)}`)}, ${lit(parameters)}::jsonb, 'draft', ${from}, true);`,
  );
  return id;
}

function closePolicy(id) {
  sql(
    `update public.policy_versions set effective_until = now() where id = '${id}';`,
  );
}

const SCHEDULING = (overrides = {}) => ({
  hold_response_window_seconds: 900,
  hold_pre_slot_interval_seconds: 300,
  pending_hold_cap: 50,
  minimum_notice_seconds: 3600,
  ...overrides,
});

function eligibility(attorney, jurisdiction, result = "eligible") {
  const id = uid();
  sql(
    `insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, context_id, evaluated_at, policy_references, result, factor_results, evidence_references, as_of)
     values ('${id}', '${attorney.profile}', '${jurisdiction}', 'jurisdiction', null, now(), '[]'::jsonb, '${result}', '[]'::jsonb, '{}'::jsonb, now());`,
  );
  return id;
}

// Seven recurring all-day rules (ISO weekdays 1..7) in one time zone.
function allDay(attorney, zone = "UTC") {
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    sql(
      `insert into public.availability_rules (attorney_id, rule_kind, timezone_name, weekday, local_start_time, local_end_time, effective_from, active)
       values ('${attorney.profile}', 'recurring', ${lit(zone)}, ${weekday}, '00:00', '24:00', current_date - 7, true);`,
    );
  }
}

const DAY_MS = 86400000;
// An ISO instant: the UTC midnight offsetDays from today, plus hours:minutes.
function at(offsetDays, hours, minutes = 0) {
  const midnight = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  return new Date(
    midnight + offsetDays * DAY_MS + (hours * 60 + minutes) * 60000,
  ).toISOString();
}

function requestSql({
  request,
  referral,
  attorney,
  client,
  jurisdiction,
  path: requestPath = "scheduled",
  deadline = null,
}) {
  ordinal += 1;
  // MVP-001 S5: the Referral's point-in-time evidence, in the same
  // transaction (20261121010000).
  const evaluation = uid();
  return `insert into public.referrals (id, intake_id, attorney_id, jurisdiction_id, attempt_ordinal, allocation_method)
    values ('${referral}', '${client.intake}', '${attorney.profile}', '${jurisdiction}', ${ordinal}, 'client_selected');
  insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, context_id, evaluated_at, policy_references, result, factor_results, evidence_references, as_of)
    values ('${evaluation}', '${attorney.profile}', '${jurisdiction}', 'jurisdiction', null, now(), '[]'::jsonb, 'eligible', '[]'::jsonb, '{}'::jsonb, now());
  insert into public.referral_eligible_pool_entries (referral_id, attorney_id, eligibility_evaluation_id, eligible_as_of)
    values ('${referral}', '${attorney.profile}', '${evaluation}', now());
  insert into public.referral_presentations (referral_id, attorney_id, display_position, narrowing_actor, shown_at)
    values ('${referral}', '${attorney.profile}', 1, 'platform', now());
  insert into public.bookability_evaluations (attorney_id, eligibility_evaluation_id, context_type, context_id, evaluated_at, as_of, modality, constraint_results, result)
    values ('${attorney.profile}', '${evaluation}', 'referral', '${referral}', now(), now(), 'synthetic', '[]'::jsonb, 'bookable');
  insert into public.consultation_requests (id, intake_id, client_id, selected_attorney_id, referral_id, request_path, referral_policy_version_id, requested_modality, state, response_deadline_at)
    values ('${request}', '${client.intake}', '${client.client}', '${attorney.profile}', '${referral}', '${requestPath}', '${world.referralPolicy}', 'video', 'pending', ${deadline === null ? "null" : lit(deadline)});`;
}

const ACQUIRE = (request, start, end) =>
  `select outcome || '|' || coalesce(hold_id::text, '') || '|' || coalesce(problem, '') from public.scheduling_acquire_hold('${request}', ${lit(start)}, ${lit(end)});`;

function parseHold(line) {
  const [outcome, hold, problem] = (line ?? "").split("|");
  return { outcome, hold: hold || null, problem: problem || null };
}

// A scheduled Request and its Hold in one transaction, committed when asked.
// A refused acquisition cannot commit: the P1 deferred Request/Hold check
// rejects an open scheduled Request without an active Hold.
function scheduledHold({
  attorney,
  client,
  jurisdiction,
  start,
  end,
  deadline = null,
  commit = true,
}) {
  const request = uid();
  const referral = uid();
  const result = psql(
    [
      "begin;",
      requestSql({
        request,
        referral,
        attorney,
        client,
        jurisdiction,
        deadline,
      }),
      ACQUIRE(request, start, end),
      commit ? "commit;" : "rollback;",
    ].join("\n"),
  );
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  return {
    ...parseHold(lines[lines.length - 1]),
    request,
    referral,
    committed: commit && result.status === 0,
    sqlstate: sqlstateOf(result.stderr),
  };
}

const ACCEPT = (request) =>
  `update public.consultation_requests set state = 'accepted', accepted_at = clock_timestamp() where id = '${request}';`;

const CONSULTATION = (consultation, request, attorney, client, requestPath) =>
  `insert into public.consultations (id, consultation_request_id, client_id, attorney_id, request_path, referral_policy_version_id, modality, state)
   values ('${consultation}', '${request}', '${client.client}', '${attorney.profile}', '${requestPath}', '${world.referralPolicy}', 'video', 'scheduled');`;

const CONVERT = (hold, consultation) =>
  `select outcome || '|' || coalesce(booking_id::text, '') from public.scheduling_convert_hold_to_booking('${hold}', '${consultation}');`;

// Acceptance of a held scheduled Request: the attorney lock first, then the
// Request, the Consultation and the conversion, in one transaction.
function acceptAndConvert({ attorney, client, request, hold, commit = true }) {
  const consultation = uid();
  const result = psql(
    [
      "begin;",
      `select public.scheduling_lock_attorney('${attorney.profile}');`,
      ACCEPT(request),
      CONSULTATION(consultation, request, attorney, client, "scheduled"),
      CONVERT(hold, consultation),
      commit ? "commit;" : "rollback;",
    ].join("\n"),
  );
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  const [outcome, booking] = (lines[lines.length - 1] ?? "").split("|");
  return {
    outcome,
    booking: booking || null,
    consultation,
    status: result.status,
    sqlstate: sqlstateOf(result.stderr),
  };
}

// An accepted instant Request and its Consultation (no Hold), for direct
// Booking probes.
function instantConsultation(attorney, client) {
  const request = uid();
  const referral = uid();
  const consultation = uid();
  sql(
    [
      "begin;",
      requestSql({
        request,
        referral,
        attorney,
        client,
        jurisdiction: world.J.A,
        path: "instant",
      }),
      ACCEPT(request),
      CONSULTATION(consultation, request, attorney, client, "instant"),
      "commit;",
    ].join("\n"),
  );
  return { request, consultation };
}

const BOOKING = (consultation, attorney, client, start, end) =>
  `insert into public.bookings (consultation_id, attorney_id, client_id, starts_at, ends_at, status)
   values ('${consultation}', '${attorney.profile}', '${client.client}', ${lit(start)}, ${lit(end)}, 'confirmed');`;

function newSession(lifetimeSeconds = 3600) {
  return { id: uid(), exp: nowSeconds() + lifetimeSeconds };
}

function asAttorney(attorney, statement, options = {}) {
  return as("authenticated", attorney.auth, statement, options);
}

function seed() {
  world.J = {
    A: newJurisdiction("SYN_S4_A"),
    B: newJurisdiction("SYN_S4_B"),
    C: newJurisdiction("SYN_S4_C"),
    D: newJurisdiction("SYN_S4_D"),
  };
  // FK target for synthetic Requests (any policy version satisfies it).
  world.referralPolicy = policy("referral", world.J.A, {});
  world.scheduling = {
    A: policy("scheduling", world.J.A, SCHEDULING()),
    // Short Holds for expiry probes.
    C: policy(
      "scheduling",
      world.J.C,
      SCHEDULING({
        hold_response_window_seconds: 3,
        hold_pre_slot_interval_seconds: 0,
        minimum_notice_seconds: 0,
      }),
    ),
    // A small cap and a long pre-slot interval.
    D: policy(
      "scheduling",
      world.J.D,
      SCHEDULING({
        hold_pre_slot_interval_seconds: 600,
        pending_hold_cap: 2,
        minimum_notice_seconds: 60,
      }),
    ),
  };
  // Jurisdiction B deliberately has no scheduling policy.
  world.atty = newAttorney("approved");
  world.other = newAttorney("approved");
  world.applicant = newAttorney("applicant");
  world.suspended = newAttorney("suspended");
  world.instant = newAttorney("approved");
  world.instantApplicant = newAttorney("under_review");
  world.holder = newAttorney("approved");
  world.racer = newAttorney("approved");
  world.capped = newAttorney("approved");
  world.expiring = newAttorney("approved");
  world.tokyo = newAttorney("approved");
  world.booker = newAttorney("approved");
  for (const attorney of [
    world.holder,
    world.racer,
    world.capped,
    world.expiring,
    world.booker,
  ]) {
    allDay(attorney);
  }
  world.client1 = newClient();
  world.client2 = newClient();
  world.client3 = newClient();
}

// ---------------------------------------------------------------------------
// Inventory and privileges
// ---------------------------------------------------------------------------

// The P1 columns of every relation S4 uses (Packet rule 16: no column added).
const P1_COLUMNS = Object.freeze({
  availability_rules:
    "id,attorney_id,rule_kind,timezone_name,weekday,specific_date,local_start_time,local_end_time,effective_from,effective_until,active,created_at,updated_at",
  blackouts:
    "id,attorney_id,starts_at,ends_at,reason_code,created_at,updated_at",
  slot_holds:
    "id,consultation_request_id,attorney_id,slot_start_at,slot_end_at,held_at,expires_at,released_at,release_reason,created_at",
  bookings:
    "id,consultation_id,attorney_id,client_id,starts_at,ends_at,status,supersedes_booking_id,created_at,superseded_at,cancelled_at",
  instant_availability_intents:
    "id,attorney_id,application_session_id,enabled_at,expires_at,revoked_at,created_at",
  bookability_evaluations:
    "id,attorney_id,eligibility_evaluation_id,context_type,context_id,evaluated_at,as_of,modality,presence_observed,presence_trust_method,instant_intent_observed,slot_start_at,slot_end_at,availability_basis,constraint_results,result,created_at",
  application_sessions:
    "id,user_id,auth_session_reference,expires_at,revoked_at,created_at,started_at,ended_at",
  consultation_requests:
    "id,intake_id,client_id,selected_attorney_id,referral_id,request_path,referral_policy_version_id,engagement_policy_version_id,requested_modality,state,response_deadline_at,created_at,accepted_at,declined_at,expired_at,cancelled_at",
});

const S4_RELATIONS = Object.freeze([
  "availability_rules",
  "blackouts",
  "slot_holds",
  "bookings",
  "instant_availability_intents",
  "bookability_evaluations",
  "application_sessions",
]);

// API functions: authenticated only, security definer, fixed settings.
const API_FUNCTIONS = Object.freeze({
  "attorney_create_availability_rule(text, text, integer, date, time, time, date, date)":
    "v|search_path=pg_catalog, pg_temp;lock_timeout=3s",
  "attorney_deactivate_availability_rule(uuid)":
    "v|search_path=pg_catalog, pg_temp;lock_timeout=3s",
  "attorney_create_blackout(timestamptz, timestamptz, text)":
    "v|search_path=pg_catalog, pg_temp;lock_timeout=3s",
  "attorney_remove_blackout(uuid)":
    "v|search_path=pg_catalog, pg_temp;lock_timeout=3s",
  "attorney_schedule_calendar(date, integer)":
    "s|search_path=pg_catalog, pg_temp",
  "scheduling_touch_session()":
    "v|search_path=pg_catalog, pg_temp;lock_timeout=3s",
  "attorney_set_instant_intent(boolean)":
    "v|search_path=pg_catalog, pg_temp;lock_timeout=3s",
  "scheduling_end_session()":
    "v|search_path=pg_catalog, pg_temp;lock_timeout=3s",
  "attorney_instant_status()": "s|search_path=pg_catalog, pg_temp",
});

// Internal building blocks and guards: executable by no API role, invoker.
const INTERNAL_FUNCTIONS = Object.freeze([
  "scheduling_policy(text, uuid, timestamptz)",
  "scheduling_local_instant(timestamp, text)",
  "scheduling_expand_availability(uuid, date, date)",
  "scheduling_audit(uuid, text, text, text, uuid, jsonb, jsonb, text)",
  "scheduling_session_claims()",
  "scheduling_observe_session(uuid)",
  "scheduling_presence(uuid)",
  "scheduling_renew_instant_lease(uuid, timestamptz)",
  "scheduling_slot_problem(uuid, timestamptz, timestamptz, uuid)",
  "scheduling_lock_attorney(uuid)",
  "scheduling_evaluate_bookability(uuid, uuid, text, uuid, text, timestamptz, timestamptz)",
  "scheduling_expire_hold_if_due(uuid, boolean)",
  "scheduling_acquire_hold(uuid, timestamptz, timestamptz)",
  "scheduling_release_hold(uuid)",
  "scheduling_convert_hold_to_booking(uuid, uuid)",
  "scheduling_expiry_sweep()",
  "slot_hold_integrity()",
  "booking_integrity()",
  "booking_consultation_consistency()",
  "availability_rule_integrity()",
  "blackout_integrity()",
  "instant_intent_integrity()",
  "application_session_integrity()",
  "bookability_evaluation_append_only()",
]);

async function inventoryChecks() {
  await check(
    "MIG-1 the three S4 migrations follow S3 last and in order, are registered unreviewed and applied nowhere, are Program migration refs, and apply on plain PostgreSQL with the pg_cron step skipped",
    () => {
      const notice = report.migrations.notices[S4_MIGRATIONS[2]];
      assert.deepEqual(notice, [
        "pg_cron is not available: no schedule registered (commands still expire due Holds)",
      ]);
      return { applied: report.migrations.applied };
    },
  );
  await check(
    "MIG-2 no relation, column, enum type, policy type, capability or seed row is added: the P1 columns are unchanged and the S4 migration texts create none",
    () => {
      for (const [table, columns] of Object.entries(P1_COLUMNS)) {
        assert.equal(
          sql(
            `select string_agg(attname, ',' order by attnum) from pg_attribute where attrelid = 'public.${table}'::regclass and attnum > 0 and not attisdropped;`,
          ),
          columns,
          table,
        );
      }
      for (const file of S4_MIGRATIONS) {
        const text = fs
          .readFileSync(path.join(MIGRATIONS, file), "utf8")
          .replace(/--[^\n]*/g, "");
        assert.doesNotMatch(
          text,
          /create\s+table|add\s+column|create\s+type|insert\s+into\s+public\.(policy_types|policy_versions|capability_definitions|capability_grants|deployment_environment)/i,
          file,
        );
      }
      assert.equal(count("policy_types"), 15);
    },
  );
  await check(
    "PRIV-1 writes are function-only: no API role holds INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER (table or column level) on any S4 relation; SELECT grants are unchanged (authenticated on rules, Blackouts and intents under own-row policies; service_role on all seven)",
    () => {
      const privileges = [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
      ];
      const observed = {};
      for (const table of S4_RELATIONS) {
        for (const role of ["anon", "authenticated", "service_role"]) {
          const held = privileges.filter(
            (privilege) =>
              sql(
                `select has_table_privilege('${role}', 'public.${table}', '${privilege}');`,
              ) === "t",
          );
          for (const column of ["INSERT", "UPDATE", "REFERENCES"]) {
            if (
              sql(
                `select has_any_column_privilege('${role}', 'public.${table}', '${column}');`,
              ) === "t"
            ) {
              held.push(`column:${column}`);
            }
          }
          observed[`${role}:${table}`] = held.join(",");
        }
      }
      const expected = {};
      for (const table of S4_RELATIONS) {
        expected[`anon:${table}`] = "";
        expected[`authenticated:${table}`] = [
          "availability_rules",
          "blackouts",
          "instant_availability_intents",
        ].includes(table)
          ? "SELECT"
          : "";
        expected[`service_role:${table}`] = "SELECT";
      }
      assert.deepEqual(observed, expected);
      for (const table of S4_RELATIONS) {
        assert.equal(
          sql(
            `select relrowsecurity from pg_class where oid = 'public.${table}'::regclass;`,
          ),
          "t",
          table,
        );
      }
    },
  );
  await check(
    "PRIV-2 function inventory: the nine API functions are security definer, owned by the owner role, with search_path pinned (and lock_timeout on every write), executable by authenticated only; every internal building block and guard is security invoker with search_path pinned and executable by no API role nor by a role holding only PUBLIC privileges",
    () => {
      sql("create role s4_probe nologin;");
      for (const [signature, settings] of Object.entries(API_FUNCTIONS)) {
        const [volatility, config] = settings.split("|");
        assert.equal(
          sql(
            `select prosecdef::text || '|' || provolatile::text || '|' || array_to_string(proconfig, ';') || '|' || pg_get_userbyid(proowner) from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          `true|${volatility}|${config}|postgres`,
          signature,
        );
        for (const [role, allowed] of [
          ["anon", "f"],
          ["authenticated", "t"],
          ["service_role", "f"],
          ["s4_probe", "f"],
        ]) {
          assert.equal(
            sql(
              `select has_function_privilege('${role}', 'public.${signature}', 'EXECUTE');`,
            ),
            allowed,
            `${role} ${signature}`,
          );
        }
      }
      for (const signature of INTERNAL_FUNCTIONS) {
        assert.equal(
          sql(
            `select prosecdef::text || '|' || array_to_string(proconfig, ';') from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          signature === "scheduling_expiry_sweep()"
            ? "false|search_path=pg_catalog, pg_temp;lock_timeout=3s"
            : "false|search_path=pg_catalog, pg_temp",
          signature,
        );
        for (const role of [
          "anon",
          "authenticated",
          "service_role",
          "s4_probe",
        ]) {
          assert.equal(
            sql(
              `select has_function_privilege('${role}', 'public.${signature}', 'EXECUTE');`,
            ),
            "f",
            `${role} ${signature}`,
          );
        }
      }
      // Every function S4 comments as its own is in one of the two lists.
      const commented = sql(
        "select string_agg(p.oid::regprocedure::text, ';' order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and obj_description(p.oid, 'pg_proc') like 'MVP-001 S4%';",
      ).split(";");
      const listed = [...Object.keys(API_FUNCTIONS), ...INTERNAL_FUNCTIONS].map(
        (signature) => sql(`select 'public.${signature}'::regprocedure::text;`),
      );
      assert.deepEqual([...commented].sort(), [...listed].sort());
      sql("drop role s4_probe;");
      return {
        api_functions: Object.keys(API_FUNCTIONS).length,
        internal_functions: INTERNAL_FUNCTIONS.length,
      };
    },
  );
  await check(
    "PRIV-3 anon and the service role cannot call any S4 API function, and direct DML by authenticated or service_role on every S4 relation is refused (42501)",
    () => {
      for (const signature of Object.keys(API_FUNCTIONS)) {
        const name = signature.slice(0, signature.indexOf("("));
        for (const role of ["anon", "service_role"]) {
          assert.equal(
            sql(
              `select has_function_privilege('${role}', 'public.${signature}', 'EXECUTE');`,
            ),
            "f",
            `${role} ${name}`,
          );
        }
      }
      for (const role of ["authenticated", "service_role"]) {
        const sub = role === "authenticated" ? world.atty.auth : null;
        for (const statement of [
          `insert into public.availability_rules (attorney_id, rule_kind, timezone_name, weekday, local_start_time, local_end_time, effective_from, active) values ('${world.atty.profile}', 'recurring', 'UTC', 1, '09:00', '10:00', current_date, true);`,
          `insert into public.blackouts (attorney_id, starts_at, ends_at) values ('${world.atty.profile}', now() + interval '1 day', now() + interval '2 days');`,
          "update public.availability_rules set active = false;",
          "delete from public.blackouts;",
          "update public.slot_holds set release_reason = 'released', released_at = now();",
          "update public.bookings set status = 'cancelled', cancelled_at = now();",
          "update public.instant_availability_intents set revoked_at = now();",
          "update public.application_sessions set ended_at = now();",
          "delete from public.bookability_evaluations;",
          `insert into public.application_sessions (user_id, auth_session_reference, started_at, expires_at) values ('${world.atty.user}', 'synthetic-reference-0001', now(), now() + interval '1 hour');`,
        ]) {
          assert.equal(
            as(role, sub, statement),
            "ERROR 42501",
            `${role}: ${statement}`,
          );
        }
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Scheduling policy
// ---------------------------------------------------------------------------

function selectPolicy(type, jurisdiction) {
  return sql(
    `select outcome || '|' || coalesce(policy_version_id::text, '') || '|' || coalesce(parameters::text, '') from public.scheduling_policy(${lit(type)}, ${lit(jurisdiction)}::uuid, now());`,
  ).split("|");
}

async function unrecordedChecks() {
  await check(
    "POL-0 before the environment is recorded nothing is selectable: scheduling_policy answers environment_unrecorded",
    () => {
      assert.deepEqual(selectPolicy("scheduling", null), [
        "environment_unrecorded",
        "",
        "",
      ]);
      assert.deepEqual(selectPolicy("bookability", null), [
        "environment_unrecorded",
        "",
        "",
      ]);
    },
  );
}

async function policyChecks() {
  await check(
    "POL-1 scheduling and bookability values come only from the selected policy version: unset answers no_applicable_policy, every required key must be an integer within wide sanity bounds (else policy_incomplete), two applicable versions are a conflict, an unknown type is invalid, and the selected parameters are exactly the required keys",
    () => {
      assert.deepEqual(selectPolicy("scheduling", world.J.B), [
        "no_applicable_policy",
        "",
        "",
      ]);
      const selected = selectPolicy("scheduling", world.J.A);
      assert.equal(selected[0], "selected");
      assert.equal(selected[1], world.scheduling.A);
      assert.deepEqual(JSON.parse(selected[2]), SCHEDULING());
      assert.deepEqual(selectPolicy("fee", world.J.A), ["invalid", "", ""]);
      const variants = [
        {},
        { ...SCHEDULING(), pending_hold_cap: 0 },
        { ...SCHEDULING(), hold_response_window_seconds: 0 },
        { ...SCHEDULING(), minimum_notice_seconds: -1 },
        { ...SCHEDULING(), minimum_notice_seconds: 1.5 },
        { ...SCHEDULING(), hold_pre_slot_interval_seconds: "300" },
        { ...SCHEDULING(), pending_hold_cap: 10001 },
        (() => {
          const partial = SCHEDULING();
          delete partial.hold_pre_slot_interval_seconds;
          return partial;
        })(),
      ];
      const incomplete = variants.map((parameters, index) => {
        const jurisdiction = newJurisdiction(`SYN_S4_I${index}`);
        const id = policy("scheduling", jurisdiction, parameters);
        const answer = selectPolicy("scheduling", jurisdiction);
        assert.deepEqual(answer, ["policy_incomplete", id, ""], index);
        return answer[0];
      });
      const bookability = newJurisdiction("SYN_S4_IB");
      policy("bookability", bookability, { presence_window_seconds: 0 });
      assert.equal(
        selectPolicy("bookability", bookability)[0],
        "policy_incomplete",
      );
      const conflict = newJurisdiction("SYN_S4_CF");
      policy("scheduling", conflict, SCHEDULING());
      policy("scheduling", conflict, SCHEDULING());
      assert.deepEqual(selectPolicy("scheduling", conflict), [
        "policy_conflict",
        "",
        "",
      ]);
      return { incomplete_variants: incomplete.length };
    },
  );
}

// ---------------------------------------------------------------------------
// Availability, Blackouts, calendar, time zones
// ---------------------------------------------------------------------------

const CREATE_RULE = ({
  kind = "recurring",
  zone = "America/New_York",
  weekday = 1,
  date = null,
  start = "09:00",
  end = "17:00",
  from = "current_date",
  until = "null",
}) =>
  `select outcome || '|' || coalesce(rule_id::text, '') from public.attorney_create_availability_rule(${lit(kind)}, ${lit(zone)}, ${weekday === null ? "null" : weekday}, (${date === null ? "null" : date})::date, ${lit(start)}::time, ${lit(end)}::time, (${from === null ? "null" : from})::date, (${until})::date);`;

function expand(attorney, from, to) {
  return sql(
    `select coalesce(string_agg(local_date || ' ' || timezone_name || ' ' || to_char(window_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') || '/' || to_char(window_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"'), ';' order by window_start), '') from public.scheduling_expand_availability('${attorney.profile}', '${from}', '${to}');`,
  );
}

async function availabilityChecks() {
  await check(
    "AV-1 attorney_create_availability_rule: created for the caller's own approved profile at aal2 (recurring and one-time), invalid for malformed shapes and non-IANA zones (validated by the database), denied at aal1, without claims, for a client, an unknown caller, a suspended profile; audited once with the rule's content and no other identity",
    () => {
      const created = asAttorney(world.atty, CREATE_RULE({}));
      const [outcome, rule] = created.split("|");
      assert.equal(outcome, "created");
      world.rule = rule;
      const oneTime = asAttorney(
        world.atty,
        CREATE_RULE({
          kind: "one_time",
          weekday: null,
          date: "current_date + 3",
          from: null,
          zone: "Europe/Paris",
        }),
      );
      assert.equal(oneTime.split("|")[0], "created");
      for (const [label, options] of [
        ["unknown zone", { zone: "Mars/Phobos" }],
        ["case-folded zone", { zone: "america/new_york" }],
        ["blank zone", { zone: "" }],
        ["weekday 0", { weekday: 0 }],
        ["weekday 8", { weekday: 8 }],
        ["start after end", { start: "17:00", end: "09:00" }],
        ["empty window", { start: "09:00", end: "09:00" }],
        ["recurring without start date", { from: null }],
        ["recurring end before start", { until: "current_date - 1" }],
        ["far past start date", { from: "current_date - 30" }],
        [
          "one-time with weekday",
          { kind: "one_time", date: "current_date + 1", from: null },
        ],
        [
          "one-time with effective dates",
          { kind: "one_time", weekday: null, date: "current_date + 1" },
        ],
        ["unknown kind", { kind: "weekly" }],
      ]) {
        assert.equal(
          asAttorney(world.atty, CREATE_RULE(options)),
          "invalid|",
          label,
        );
      }
      assert.equal(
        asAttorney(world.atty, CREATE_RULE({}), { aal: "aal1" }),
        "denied|",
      );
      assert.equal(
        asAttorney(world.atty, CREATE_RULE({}), { aal: null }),
        "denied|",
      );
      assert.equal(
        as("authenticated", world.client1.auth, CREATE_RULE({})),
        "denied|",
      );
      assert.equal(as("authenticated", uid(), CREATE_RULE({})), "denied|");
      assert.equal(asAttorney(world.suspended, CREATE_RULE({})), "denied|");
      assert.equal(as("anon", null, CREATE_RULE({})), "ERROR 42501");
      assert.equal(
        count(
          "audit_events",
          `action_code = 'availability_rule.created' and resource_id = '${rule}' and actor_user_id = '${world.atty.user}' and actor_type = 'attorney'`,
        ),
        1,
      );
      assert.equal(
        sql(
          `select string_agg(k, ',' order by k) from audit_events, jsonb_object_keys(after_snapshot) k where resource_id = '${rule}';`,
        ),
        "effective_from,effective_until,local_end_time,local_start_time,rule_kind,specific_date,timezone_name,weekday",
      );
    },
  );
  await check(
    "AV-2 the active-rule abuse bound (200) answers rate_limited; deactivation answers deactivated, then already_inactive; another attorney's rule and an unknown id answer not_found; aal1 is denied; audited",
    () => {
      const bounded = newAttorney("approved");
      sql(
        `insert into public.availability_rules (attorney_id, rule_kind, timezone_name, specific_date, local_start_time, local_end_time, active)
         select '${bounded.profile}', 'one_time', 'UTC', current_date + g, '09:00', '10:00', true from generate_series(1, 200) g;`,
      );
      assert.equal(asAttorney(bounded, CREATE_RULE({})), "rate_limited|");
      const deactivate = (attorney, id, options) =>
        asAttorney(
          attorney,
          `select public.attorney_deactivate_availability_rule(${lit(id)});`,
          options,
        );
      assert.equal(deactivate(world.other, world.rule), "not_found");
      assert.equal(deactivate(world.atty, uid()), "not_found");
      assert.equal(
        deactivate(world.atty, world.rule, { aal: "aal1" }),
        "denied",
      );
      assert.equal(deactivate(world.atty, world.rule), "deactivated");
      assert.equal(deactivate(world.atty, world.rule), "already_inactive");
      assert.equal(
        count(
          "audit_events",
          `action_code = 'availability_rule.deactivated' and resource_id = '${world.rule}'`,
        ),
        1,
      );
      assert.equal(
        sql(
          `select active::text || '|' || (updated_at > created_at)::text from public.availability_rules where id = '${world.rule}';`,
        ),
        "false|true",
      );
    },
  );
  await check(
    "AV-3 Blackouts: created for a future end at aal2; invalid for a past end, an inverted or too long range (366 days), a far start or a malformed reason code; denied at aal1 and for a suspended profile; removed only before it starts (not_removable once started), another attorney's or an unknown one is not_found; every change audited",
    () => {
      const create = (attorney, starts, ends, reason, options) =>
        asAttorney(
          attorney,
          `select outcome || '|' || coalesce(blackout_id::text, '') from public.attorney_create_blackout(${starts}, ${ends}, ${lit(reason)});`,
          options,
        );
      const future = create(
        world.atty,
        "now() + interval '2 days'",
        "now() + interval '3 days'",
        "personal_leave",
      );
      assert.equal(future.split("|")[0], "created");
      world.futureBlackout = future.split("|")[1];
      const started = create(
        world.atty,
        "now() - interval '1 hour'",
        "now() + interval '1 hour'",
        null,
      );
      assert.equal(started.split("|")[0], "created");
      world.startedBlackout = started.split("|")[1];
      for (const [label, starts, ends, reason] of [
        [
          "past end",
          "now() - interval '2 days'",
          "now() - interval '1 day'",
          null,
        ],
        [
          "inverted",
          "now() + interval '2 days'",
          "now() + interval '1 day'",
          null,
        ],
        [
          "too long",
          "now() + interval '1 day'",
          "now() + interval '400 days'",
          null,
        ],
        [
          "far start",
          "now() + interval '4000 days'",
          "now() + interval '4001 days'",
          null,
        ],
        [
          "reason case",
          "now() + interval '1 day'",
          "now() + interval '2 days'",
          "Leave",
        ],
        [
          "reason spaces",
          "now() + interval '1 day'",
          "now() + interval '2 days'",
          "on leave",
        ],
        [
          "reason too short",
          "now() + interval '1 day'",
          "now() + interval '2 days'",
          "x",
        ],
      ]) {
        assert.equal(
          create(world.atty, starts, ends, reason),
          "invalid|",
          label,
        );
      }
      assert.equal(
        create(
          world.atty,
          "now() + interval '1 day'",
          "now() + interval '2 days'",
          null,
          {
            aal: "aal1",
          },
        ),
        "denied|",
      );
      assert.equal(
        create(
          world.suspended,
          "now() + interval '1 day'",
          "now() + interval '2 days'",
          null,
        ),
        "denied|",
      );
      const remove = (attorney, id, options) =>
        asAttorney(
          attorney,
          `select public.attorney_remove_blackout(${lit(id)});`,
          options,
        );
      assert.equal(remove(world.atty, world.startedBlackout), "not_removable");
      assert.equal(remove(world.other, world.futureBlackout), "not_found");
      assert.equal(remove(world.atty, uid()), "not_found");
      assert.equal(
        remove(world.atty, world.futureBlackout, { aal: "aal1" }),
        "denied",
      );
      const second = create(
        world.atty,
        "now() + interval '5 days'",
        "now() + interval '6 days'",
        null,
      ).split("|")[1];
      assert.equal(remove(world.atty, second), "removed");
      assert.equal(count("blackouts", `id = '${second}'`), 0);
      assert.equal(
        count(
          "audit_events",
          `resource_id = '${second}' and action_code in ('blackout.created', 'blackout.removed')`,
        ),
        2,
      );
      const bounded = newAttorney("approved");
      sql(
        `insert into public.blackouts (attorney_id, starts_at, ends_at)
         select '${bounded.profile}', now() + make_interval(days => g), now() + make_interval(days => g) + interval '1 hour' from generate_series(1, 500) g;`,
      );
      assert.equal(
        create(
          bounded,
          "now() + interval '1 day'",
          "now() + interval '2 days'",
          null,
        ),
        "rate_limited|",
      );
    },
  );
  await check(
    "AV-4 time zones and daylight saving: windows are stored and returned as UTC instants with the rule's IANA zone; a window whose local start or end falls in a gap (America/New_York 2027-03-14 02:30, Europe/Paris 2027-03-28 02:15) or an overlap (America/New_York 2027-11-07 01:30) is not offered that date while the same rule is offered on ordinary dates; windows across a transition carry the correct offsets; effective dates bound recurring rules; a one-time rule applies on its date only",
    () => {
      const dst = newAttorney("approved");
      const rule = (zone, weekday, start, end, extra = "") =>
        sql(
          `insert into public.availability_rules (attorney_id, rule_kind, timezone_name, weekday, local_start_time, local_end_time, effective_from, effective_until, active)
           values ('${dst.profile}', 'recurring', '${zone}', ${weekday}, '${start}', '${end}', '2027-01-01', ${extra || "null"}, true);`,
        );
      // Sundays (ISO 7) in New York.
      rule("America/New_York", 7, "02:30", "04:00");
      rule("America/New_York", 7, "01:30", "02:15");
      rule("America/New_York", 7, "09:00", "17:00");
      assert.equal(
        expand(dst, "2027-03-07", "2027-03-07"),
        "2027-03-07 America/New_York 2027-03-07T06:30Z/2027-03-07T07:15Z;2027-03-07 America/New_York 2027-03-07T07:30Z/2027-03-07T09:00Z;2027-03-07 America/New_York 2027-03-07T14:00Z/2027-03-07T22:00Z",
      );
      // Spring forward: 02:30 does not exist; 01:30-02:15 ends in the gap.
      assert.equal(
        expand(dst, "2027-03-14", "2027-03-14"),
        "2027-03-14 America/New_York 2027-03-14T13:00Z/2027-03-14T21:00Z",
      );
      assert.equal(
        expand(dst, "2027-03-21", "2027-03-21"),
        "2027-03-21 America/New_York 2027-03-21T05:30Z/2027-03-21T06:15Z;2027-03-21 America/New_York 2027-03-21T06:30Z/2027-03-21T08:00Z;2027-03-21 America/New_York 2027-03-21T13:00Z/2027-03-21T21:00Z",
      );
      // Fall back: 01:30 occurs twice; the 02:30 window is unambiguous.
      assert.equal(
        expand(dst, "2027-11-07", "2027-11-07"),
        "2027-11-07 America/New_York 2027-11-07T07:30Z/2027-11-07T09:00Z;2027-11-07 America/New_York 2027-11-07T14:00Z/2027-11-07T22:00Z",
      );
      assert.equal(
        expand(dst, "2027-10-31", "2027-10-31").split(";").length,
        3,
      );
      // Europe/Paris spring forward (02:00 -> 03:00 on 2027-03-28).
      sql(
        `insert into public.availability_rules (attorney_id, rule_kind, timezone_name, specific_date, local_start_time, local_end_time, active)
         values ('${dst.profile}', 'one_time', 'Europe/Paris', '2027-03-28', '02:15', '03:30', true),
                ('${dst.profile}', 'one_time', 'Europe/Paris', '2027-03-29', '02:15', '03:30', true);`,
      );
      const paris = expand(dst, "2027-03-28", "2027-03-29")
        .split(";")
        .filter((w) => w.includes("Paris"));
      assert.deepEqual(paris, [
        "2027-03-29 Europe/Paris 2027-03-29T00:15Z/2027-03-29T01:30Z",
      ]);
      // Effective dates bound a recurring rule (ISO 3 = Wednesday).
      rule("Asia/Kolkata", 3, "10:00", "11:00", "'2027-01-13'");
      assert.deepEqual(
        expand(dst, "2027-01-06", "2027-01-20")
          .split(";")
          .filter((w) => w.includes("Kolkata")),
        [
          "2027-01-06 Asia/Kolkata 2027-01-06T04:30Z/2027-01-06T05:30Z",
          "2027-01-13 Asia/Kolkata 2027-01-13T04:30Z/2027-01-13T05:30Z",
        ],
      );
      // The expansion is bounded to 63 local dates.
      assert.equal(expand(dst, "2027-01-01", "2027-03-05"), "");
      for (const [local, zone, instant] of [
        ["2027-03-14 02:30", "America/New_York", ""],
        ["2027-11-07 01:30", "America/New_York", ""],
        ["2027-04-04 01:45", "Australia/Lord_Howe", ""],
        ["2027-07-01 09:00", "Asia/Kolkata", "2027-07-01 03:30:00+00"],
        ["2027-03-14 03:30", "America/New_York", "2027-03-14 07:30:00+00"],
      ]) {
        assert.equal(
          sql(
            `select coalesce(public.scheduling_local_instant('${local}', '${zone}')::text, '');`,
          ),
          instant,
          `${zone} ${local}`,
        );
      }
    },
  );
  await check(
    "AV-5 attorney_schedule_calendar: the caller's own windows (UTC with zone and local date), Blackouts (removable or started), active Holds and confirmed Bookings only, with no client, Request or Intake detail; nothing at aal1, for another caller, or out of bounds",
    () => {
      const read = (attorney, from, days, options) =>
        rowsAs(
          "authenticated",
          attorney.auth,
          `select entry_kind || '|' || coalesce(timezone_name, '') || '|' || coalesce(entry_state, '') || '|' || coalesce(reason_code, '') from public.attorney_schedule_calendar(${from}, ${days});`,
          options,
        );
      const rows = read(world.atty, "current_date", 14);
      assert.ok(
        rows.some((r) => r.startsWith("window|Europe/Paris|available")),
      );
      assert.ok(rows.includes("blackout||removable|personal_leave"));
      assert.ok(rows.includes("blackout||started|"));
      assert.equal(
        sql(
          "select pg_get_function_result('public.attorney_schedule_calendar(date, integer)'::regprocedure);",
        ),
        "TABLE(entry_kind text, entry_id uuid, starts_at timestamp with time zone, ends_at timestamp with time zone, timezone_name text, local_date date, entry_state text, reason_code text)",
      );
      assert.deepEqual(
        read(world.atty, "current_date", 14, { aal: "aal1" }),
        [],
      );
      assert.deepEqual(read(world.atty, "current_date", 0), []);
      assert.deepEqual(read(world.atty, "current_date", 32), []);
      assert.deepEqual(read(world.atty, "current_date + 4000", 7), []);
      assert.deepEqual(read(world.client1, "current_date", 14), []);
      assert.ok(
        !read(world.other, "current_date", 14).some((r) =>
          r.includes("personal_leave"),
        ),
      );
      return { rows: rows.length };
    },
  );
}

// ---------------------------------------------------------------------------
// Application session, Instant mode, Presence
// ---------------------------------------------------------------------------

const TOUCH = "select public.scheduling_touch_session();";
const SET_INTENT = (enabled) =>
  `select public.attorney_set_instant_intent(${enabled === null ? "null" : enabled});`;
const END_SESSION = "select public.scheduling_end_session();";

function instantStatus(attorney, sessionClaims, options = {}) {
  const value = as(
    "authenticated",
    attorney.auth,
    "select coalesce((select row_to_json(s)::text from public.attorney_instant_status() s), 'none');",
    { session: sessionClaims, ...options },
  );
  return value === "none" ? null : JSON.parse(value);
}

function presenceOf(attorney) {
  return JSON.parse(
    sql(
      `select row_to_json(p)::text from public.scheduling_presence('${attorney.profile}') p;`,
    ),
  );
}

function sessionRow(sessionClaims) {
  const value = sql(
    `select coalesce((select row_to_json(s)::text from public.application_sessions s where auth_session_reference = '${sha256(sessionClaims.id)}'), 'none');`,
  );
  return value === "none" ? null : JSON.parse(value);
}

function intentOf(sessionRowValue) {
  const value = sql(
    `select coalesce((select row_to_json(i)::text from public.instant_availability_intents i where application_session_id = '${sessionRowValue.id}'), 'none');`,
  );
  return value === "none" ? null : JSON.parse(value);
}

const ms = (timestamp) => new Date(timestamp).getTime();

async function instantChecks() {
  const attorney = world.instant;
  const s1 = newSession(3600);
  world.s1 = s1;
  await check(
    "IN-1 scheduling_touch_session records the server's observation from the verified JWT only: denied without aal2 or claims, for a client, a suspended profile or an unknown caller; no_session without a session_id claim or with an expired token; observed creates one application session per provider session (reference = hex SHA-256 of session_id, never the token), audited once, and later touches only move its expiry forward",
    () => {
      assert.equal(
        asAttorney(attorney, TOUCH, { session: s1, aal: "aal1" }),
        "denied",
      );
      assert.equal(asAttorney(attorney, TOUCH, { aal: null }), "denied");
      assert.equal(
        as("authenticated", world.client1.auth, TOUCH, { session: s1 }),
        "denied",
      );
      assert.equal(
        asAttorney(world.suspended, TOUCH, { session: newSession() }),
        "denied",
      );
      assert.equal(
        as("authenticated", uid(), TOUCH, { session: newSession() }),
        "denied",
      );
      assert.equal(asAttorney(attorney, TOUCH), "no_session");
      assert.equal(
        asAttorney(attorney, TOUCH, {
          session: { id: uid(), exp: nowSeconds() - 5 },
        }),
        "no_session",
      );
      assert.equal(
        asAttorney(attorney, TOUCH, {
          session: { id: "not a session id!", exp: nowSeconds() + 60 },
        }),
        "no_session",
      );
      assert.equal(asAttorney(attorney, TOUCH, { session: s1 }), "observed");
      const first = sessionRow(s1);
      assert.ok(first, "the application session exists");
      assert.equal(first.user_id, attorney.user);
      assert.equal(first.auth_session_reference, sha256(s1.id));
      assert.equal(ms(first.expires_at), s1.exp * 1000);
      assert.equal(first.ended_at, null);
      assert.equal(asAttorney(attorney, TOUCH, { session: s1 }), "observed");
      assert.equal(
        asAttorney(attorney, TOUCH, {
          session: { id: s1.id, exp: s1.exp + 600 },
        }),
        "observed",
      );
      assert.equal(ms(sessionRow(s1).expires_at), (s1.exp + 600) * 1000);
      assert.equal(
        asAttorney(attorney, TOUCH, {
          session: { id: s1.id, exp: s1.exp + 60 },
        }),
        "observed",
      );
      assert.equal(ms(sessionRow(s1).expires_at), (s1.exp + 600) * 1000);
      s1.exp += 600;
      assert.equal(
        count("application_sessions", `user_id = '${attorney.user}'`),
        1,
      );
      assert.equal(
        count(
          "audit_events",
          `action_code = 'application_session.started' and actor_user_id = '${attorney.user}'`,
        ),
        1,
      );
      // The same provider session claimed by another User is refused.
      assert.equal(asAttorney(world.other, TOUCH, { session: s1 }), "denied");
      assert.equal(
        count(
          "application_sessions",
          `auth_session_reference = '${sha256(s1.id)}'`,
        ),
        1,
      );
    },
  );
  await check(
    "IN-2 Instant mode refuses explicitly without configuration: with no complete jurisdiction-neutral bookability policy, enabling answers unavailable, the status reports the policy as not configured, and Presence is not observed (presence_policy_unavailable); a profile that is not approved, an aal1 session and a null switch are refused",
    () => {
      assert.equal(
        asAttorney(attorney, SET_INTENT(true), { session: s1 }),
        "unavailable",
      );
      const status = instantStatus(attorney, s1);
      assert.equal(status.instant_on, false);
      assert.equal(status.presence_configured, false);
      assert.equal(status.session_active, true);
      assert.deepEqual(presenceOf(attorney), {
        observed: false,
        trust_method: "server_session_observation",
        reason: "presence_policy_unavailable",
        policy_version_id: null,
      });
      assert.equal(
        asAttorney(world.instantApplicant, SET_INTENT(true), {
          session: newSession(),
        }),
        "denied",
      );
      assert.equal(
        asAttorney(attorney, SET_INTENT(true), { session: s1, aal: "aal1" }),
        "denied",
      );
      assert.equal(
        asAttorney(attorney, SET_INTENT(null), { session: s1 }),
        "invalid",
      );
      assert.equal(instantStatus(attorney, s1, { aal: "aal1" }), null);
      assert.equal(
        count(
          "instant_availability_intents",
          `attorney_id = '${attorney.profile}'`,
        ),
        0,
      );
    },
  );
  await check(
    "IN-3 the Instant intent is a server lease: enabling binds it to the current session with expires_at = observation + presence_window_seconds (capped by the session); touches within the window move it forward; without an observation within the window it expires, Presence is no longer observed, a later touch does not revive it, and only enabling again turns it on",
    async () => {
      world.presenceShort = policy("bookability", null, {
        presence_window_seconds: 2,
      });
      assert.equal(
        asAttorney(attorney, SET_INTENT(true), { session: s1 }),
        "enabled",
      );
      const row = sessionRow(s1);
      let intent = intentOf(row);
      assert.equal(intent.attorney_id, attorney.profile);
      assert.equal(intent.revoked_at, null);
      const lease = ms(intent.expires_at) - ms(intent.enabled_at);
      assert.ok(lease >= 1990 && lease <= 2010, `lease ${lease}`);
      assert.equal(
        asAttorney(attorney, SET_INTENT(true), { session: s1 }),
        "unchanged",
      );
      assert.equal(presenceOf(attorney).observed, true);
      assert.equal(instantStatus(attorney, s1).instant_on, true);
      assert.equal(
        count(
          "audit_events",
          `action_code = 'instant_intent.enabled' and resource_id = '${intent.id}' and policy_references @> '[{"policy_version_id": "${world.presenceShort}"}]'::jsonb`,
        ),
        1,
      );
      await sleep(1200);
      const before = ms(intent.expires_at);
      assert.equal(asAttorney(attorney, TOUCH, { session: s1 }), "observed");
      intent = intentOf(row);
      assert.ok(
        ms(intent.expires_at) > before,
        "a touch moved the lease forward",
      );
      await sleep(1200);
      assert.equal(instantStatus(attorney, s1).instant_on, true);
      await sleep(2600);
      assert.equal(instantStatus(attorney, s1).instant_on, false);
      assert.equal(presenceOf(attorney).reason, "presence_not_observed");
      const lapsed = ms(intentOf(row).expires_at);
      assert.equal(asAttorney(attorney, TOUCH, { session: s1 }), "observed");
      assert.equal(
        ms(intentOf(row).expires_at),
        lapsed,
        "a touch never revives a lapsed lease",
      );
      assert.equal(instantStatus(attorney, s1).instant_on, false);
      assert.equal(
        asAttorney(attorney, SET_INTENT(true), { session: s1 }),
        "enabled",
      );
      const again = intentOf(row);
      assert.ok(ms(again.enabled_at) > ms(intent.enabled_at));
      assert.equal(
        count(
          "instant_availability_intents",
          `attorney_id = '${attorney.profile}'`,
        ),
        1,
      );
    },
  );
  await check(
    "IN-4 Instant intent is bound to its application session: a new session starts with Instant mode off; sign-out (scheduling_end_session) ends the session and revokes its intent, audited; the ended session can no longer be touched or enabled; the next sign-in starts off; disabling revokes every intent of the attorney; a session past its token expiry carries no intent",
    async () => {
      closePolicy(world.presenceShort);
      world.presenceLong = policy("bookability", null, {
        presence_window_seconds: 3600,
      });
      // The short lease of IN-3 may still be running: switch off, then on.
      assert.ok(
        ["disabled", "unchanged"].includes(
          asAttorney(attorney, SET_INTENT(false), { session: s1 }),
        ),
      );
      assert.equal(
        asAttorney(attorney, SET_INTENT(true), { session: s1 }),
        "enabled",
      );
      let status = instantStatus(attorney, s1);
      assert.equal(status.instant_on, true);
      assert.equal(status.presence_configured, true);
      const s2 = newSession(3600);
      assert.equal(asAttorney(attorney, TOUCH, { session: s2 }), "observed");
      status = instantStatus(attorney, s2);
      assert.equal(status.instant_on, false);
      assert.equal(status.other_sessions_on, 1);
      assert.equal(asAttorney(attorney, END_SESSION, { session: s1 }), "ended");
      const ended = sessionRow(s1);
      assert.notEqual(ended.ended_at, null);
      assert.notEqual(intentOf(ended).revoked_at, null);
      assert.equal(
        count(
          "audit_events",
          `action_code = 'application_session.ended' and resource_id = '${ended.id}' and reason_code = 'sign_out'`,
        ),
        1,
      );
      status = instantStatus(attorney, s1);
      assert.equal(status.session_active, false);
      assert.equal(status.instant_on, false);
      assert.equal(asAttorney(attorney, TOUCH, { session: s1 }), "no_session");
      assert.equal(
        asAttorney(attorney, SET_INTENT(true), { session: s1 }),
        "no_session",
      );
      assert.equal(
        asAttorney(attorney, END_SESSION, { session: s1 }),
        "no_session",
      );
      assert.equal(asAttorney(attorney, END_SESSION), "no_session");
      // The next sign-in is a new provider session: Instant mode is off.
      const s3 = newSession(3600);
      assert.equal(asAttorney(attorney, TOUCH, { session: s3 }), "observed");
      status = instantStatus(attorney, s3);
      assert.equal(status.instant_on, false);
      assert.equal(status.other_sessions_on, 0);
      assert.equal(presenceOf(attorney).observed, false);
      // Disabling revokes every unrevoked intent of the attorney.
      assert.equal(
        asAttorney(attorney, SET_INTENT(true), { session: s2 }),
        "enabled",
      );
      assert.equal(
        asAttorney(attorney, SET_INTENT(true), { session: s3 }),
        "enabled",
      );
      assert.equal(
        asAttorney(attorney, SET_INTENT(false), { session: s3 }),
        "disabled",
      );
      assert.equal(
        count(
          "instant_availability_intents",
          `attorney_id = '${attorney.profile}' and revoked_at is null`,
        ),
        0,
      );
      assert.equal(
        asAttorney(attorney, SET_INTENT(false), { session: s3 }),
        "unchanged",
      );
      // A session whose token expires carries no intent after that instant.
      const s4 = newSession(3);
      assert.equal(
        asAttorney(attorney, SET_INTENT(true), { session: s4 }),
        "enabled",
      );
      const short = intentOf(sessionRow(s4));
      assert.equal(ms(short.expires_at), s4.exp * 1000);
      await sleep(Math.max(0, s4.exp * 1000 - Date.now()) + 600);
      assert.equal(presenceOf(attorney).observed, false);
      assert.equal(asAttorney(attorney, TOUCH, { session: s4 }), "no_session");
      // Leave one live session with Instant mode on for the Bookability probes.
      world.s5 = newSession(3600);
      assert.equal(
        asAttorney(attorney, SET_INTENT(true), { session: world.s5 }),
        "enabled",
      );
      assert.equal(presenceOf(attorney).observed, true);
    },
  );
}

// ---------------------------------------------------------------------------
// Bookability
// ---------------------------------------------------------------------------

function evaluate(
  attorney,
  eligibilityId,
  {
    context = "consultation_request",
    contextId = uid(),
    modality = "video",
    start = null,
    end = null,
  } = {},
) {
  const answer = sql(
    `select result || '|' || coalesce(evaluation_id::text, '') from public.scheduling_evaluate_bookability('${attorney.profile}', ${lit(eligibilityId)}, ${lit(context)}, ${lit(contextId)}, ${lit(modality)}, ${lit(start)}, ${lit(end)});`,
  );
  const [result, id] = answer.split("|");
  if (id === "") {
    return { result, id: null, row: null };
  }
  const row = JSON.parse(
    sql(
      `select row_to_json(b)::text from public.bookability_evaluations b where id = '${id}';`,
    ),
  );
  return { result, id, row };
}

const reasons = (row) =>
  row.constraint_results.map(
    (factor) => `${factor.factor}:${factor.passed}:${factor.reason}`,
  );

async function bookabilityChecks() {
  const attorney = world.instant;
  const eligible = eligibility(attorney, world.J.A, "eligible");
  world.instantEligible = eligible;
  await check(
    "BK-1 Available Now requires all of eligibility, the Instant intent and Presence (and not being in a started Consultation): the evaluation appends one row with each factor and its reason, the server presence trust method, the observed intent and presence, and the intent as its basis",
    () => {
      const ok = evaluate(attorney, eligible);
      assert.equal(ok.result, "bookable");
      assert.deepEqual(reasons(ok.row), [
        "eligibility:true:eligible",
        "instant_intent:true:intent_on",
        "presence:true:presence_observed",
        "consultation:true:not_in_consultation",
      ]);
      assert.equal(ok.row.presence_observed, true);
      assert.equal(ok.row.instant_intent_observed, true);
      assert.equal(ok.row.presence_trust_method, "server_session_observation");
      assert.equal(ok.row.slot_start_at, null);
      assert.ok(ok.row.availability_basis.instant_intent_id);
      assert.equal(
        ok.row.constraint_results[2].policy_version_id,
        world.presenceLong,
      );
      assert.equal(ok.row.evaluated_at, ok.row.as_of);
      for (const result of ["not_eligible", "undetermined"]) {
        const other = evaluate(
          attorney,
          eligibility(attorney, world.J.A, result),
        );
        assert.equal(other.result, "not_bookable");
        assert.equal(
          reasons(other.row)[0],
          `eligibility:false:eligibility_${result}`,
        );
      }
    },
  );
  await check(
    "BK-2 each missing condition makes the attorney not bookable with its recorded reason: Instant mode off (intent_off, presence_not_observed), a started and unended Consultation (in_consultation), and an unset presence policy (presence_policy_unavailable)",
    () => {
      assert.equal(
        asAttorney(attorney, SET_INTENT(false), { session: world.s5 }),
        "disabled",
      );
      const off = evaluate(attorney, eligible);
      assert.equal(off.result, "not_bookable");
      assert.deepEqual(reasons(off.row).slice(1, 3), [
        "instant_intent:false:intent_off",
        "presence:false:presence_not_observed",
      ]);
      assert.equal(off.row.instant_intent_observed, false);
      assert.equal(off.row.presence_observed, false);
      assert.equal(
        asAttorney(attorney, SET_INTENT(true), { session: world.s5 }),
        "enabled",
      );
      const { consultation } = instantConsultation(attorney, world.client1);
      sql(
        `update public.consultations set started_at = now() where id = '${consultation}';`,
      );
      const busy = evaluate(attorney, eligible);
      assert.equal(busy.result, "not_bookable");
      assert.equal(reasons(busy.row)[3], "consultation:false:in_consultation");
      sql(
        `update public.consultations set ended_at = now() where id = '${consultation}';`,
      );
      assert.equal(evaluate(attorney, eligible).result, "bookable");
      closePolicy(world.presenceLong);
      const unset = evaluate(attorney, eligible);
      assert.equal(unset.result, "not_bookable");
      assert.equal(
        reasons(unset.row)[2],
        "presence:false:presence_policy_unavailable",
      );
      world.presenceLong = policy("bookability", null, {
        presence_window_seconds: 3600,
      });
      assert.equal(evaluate(attorney, eligible).result, "bookable");
    },
  );
  await check(
    "BK-3 scheduled Bookability: eligible and a holdable slot is bookable with its availability window as basis; otherwise not bookable with the slot problem (notice, outside_availability, blackout, policy_unavailable for a jurisdiction without scheduling policy); presence fields stay empty",
    () => {
      const holder = world.holder;
      const holderEligible = eligibility(holder, world.J.A);
      world.holderEligible = holderEligible;
      const ok = evaluate(holder, holderEligible, {
        start: at(2, 10),
        end: at(2, 11),
      });
      assert.equal(ok.result, "bookable");
      assert.deepEqual(reasons(ok.row), [
        "eligibility:true:eligible",
        "slot:true:slot_available",
      ]);
      assert.equal(
        ok.row.constraint_results[1].policy_version_id,
        world.scheduling.A,
      );
      assert.equal(ok.row.availability_basis.timezone_name, "UTC");
      assert.equal(ok.row.presence_observed, null);
      assert.equal(ok.row.presence_trust_method, null);
      assert.equal(ok.row.instant_intent_observed, null);
      const soon = new Date(Date.now() + 30 * 60000).toISOString();
      const soonEnd = new Date(Date.now() + 60 * 60000).toISOString();
      assert.equal(
        reasons(
          evaluate(holder, holderEligible, { start: soon, end: soonEnd }).row,
        )[1],
        "slot:false:notice",
      );
      sql(
        `insert into public.blackouts (attorney_id, starts_at, ends_at) values ('${holder.profile}', ${lit(at(4, 9))}, ${lit(at(4, 12))});`,
      );
      assert.equal(
        reasons(
          evaluate(holder, holderEligible, { start: at(4, 10), end: at(4, 11) })
            .row,
        )[1],
        "slot:false:blackout",
      );
      const atty = eligibility(world.atty, world.J.A);
      assert.equal(
        reasons(
          evaluate(world.atty, atty, { start: at(2, 10), end: at(2, 11) }).row,
        )[1],
        "slot:false:outside_availability",
      );
      const unset = eligibility(holder, world.J.B);
      assert.equal(
        reasons(
          evaluate(holder, unset, { start: at(2, 10), end: at(2, 11) }).row,
        )[1],
        "slot:false:policy_unavailable",
      );
      // A slot across two adjacent windows is not inside one window.
      assert.equal(
        reasons(
          evaluate(holder, holderEligible, { start: at(2, 23), end: at(3, 1) })
            .row,
        )[1],
        "slot:false:outside_availability",
      );
    },
  );
  await check(
    "BK-4 malformed evaluations are refused without a row: another attorney's Eligibility Evaluation, an unknown context type, a missing context id, a blank modality, one slot bound only, an unknown Eligibility Evaluation",
    () => {
      const before = count("bookability_evaluations");
      const otherEligible = eligibility(world.other, world.J.A);
      for (const [label, attorneyValue, eligibilityValue, options] of [
        ["other attorney", attorney, otherEligible, {}],
        ["listing context", attorney, eligible, { context: "listing" }],
        ["no context id", attorney, eligible, { contextId: null }],
        ["blank modality", attorney, eligible, { modality: " " }],
        ["one bound", attorney, eligible, { start: at(2, 10) }],
        ["unknown eligibility", attorney, uid(), {}],
      ]) {
        assert.equal(
          evaluate(attorneyValue, eligibilityValue, options).result,
          "invalid",
          label,
        );
      }
      assert.equal(count("bookability_evaluations"), before);
    },
  );
}

// ---------------------------------------------------------------------------
// Slot Holds and Bookings
// ---------------------------------------------------------------------------

function holdRow(id) {
  return JSON.parse(
    sql(
      `select row_to_json(h)::text from public.slot_holds h where id = '${id}';`,
    ),
  );
}

function requestRow(id) {
  return JSON.parse(
    sql(
      `select row_to_json(r)::text from public.consultation_requests r where id = '${id}';`,
    ),
  );
}

function slotProblem(attorney, start, end, jurisdiction) {
  return sql(
    `select coalesce(public.scheduling_slot_problem('${attorney.profile}', ${lit(start)}, ${lit(end)}, ${lit(jurisdiction)}), 'none');`,
  );
}

async function untilPast(timestamp, slackMs = 400) {
  await sleep(Math.max(0, ms(timestamp) - Date.now()) + slackMs);
}

async function holdChecks() {
  const holder = world.holder;
  await check(
    "HO-1 scheduling_acquire_hold holds an open scheduled Request's slot for its selected attorney: held_at now and expires_at = now + hold_response_window_seconds when nothing earlier applies; the slot is then a hold_conflict for that attorney and the Request stays open",
    () => {
      const held = scheduledHold({
        attorney: holder,
        client: world.client1,
        jurisdiction: world.J.A,
        start: at(2, 10),
        end: at(2, 11),
      });
      assert.equal(held.outcome, "held");
      assert.equal(held.committed, true);
      world.heldA = held;
      const row = holdRow(held.hold);
      assert.equal(row.attorney_id, holder.profile);
      assert.equal(row.consultation_request_id, held.request);
      assert.equal(ms(row.expires_at) - ms(row.held_at), 900000);
      assert.equal(row.released_at, null);
      assert.equal(requestRow(held.request).state, "pending");
      assert.equal(
        slotProblem(holder, at(2, 10), at(2, 11), world.J.A),
        "hold_conflict",
      );
      assert.equal(
        slotProblem(holder, at(2, 10, 30), at(2, 11, 30), world.J.A),
        "hold_conflict",
      );
      assert.equal(
        slotProblem(holder, at(2, 11), at(2, 12), world.J.A),
        "none",
      );
      assert.equal(
        reasons(
          evaluate(holder, world.holderEligible, {
            start: at(2, 10),
            end: at(2, 11),
          }).row,
        )[1],
        "slot:false:hold_conflict",
      );
    },
  );
  await check(
    "HO-2 the server expiry is the earliest of the response window, the slot start minus the pre-slot interval, and the Request's response deadline; a Hold that would expire at once is refused (too_late)",
    () => {
      const deadline = new Date(Date.now() + 120000).toISOString();
      const byDeadline = scheduledHold({
        attorney: holder,
        client: world.client1,
        jurisdiction: world.J.A,
        start: at(2, 13),
        end: at(2, 14),
        deadline,
      });
      assert.equal(byDeadline.outcome, "held");
      assert.equal(ms(holdRow(byDeadline.hold).expires_at), ms(deadline));
      // Near-term slots inside one UTC day (the windows are whole UTC days).
      const nearSlot = (minutesAhead, lengthMinutes) => {
        let start = new Date(Date.now() + minutesAhead * 60000);
        start.setUTCSeconds(0, 0);
        let end = new Date(start.getTime() + lengthMinutes * 60000);
        if (start.getUTCDate() !== new Date(end.getTime() - 1).getUTCDate()) {
          start = new Date(Math.floor(end.getTime() / DAY_MS) * DAY_MS);
          end = new Date(start.getTime() + lengthMinutes * 60000);
        }
        return [start, end];
      };
      const [start, end] = nearSlot(20, 5);
      const capped = world.capped;
      const byInterval = scheduledHold({
        attorney: capped,
        client: world.client2,
        jurisdiction: world.J.D,
        start: start.toISOString(),
        end: end.toISOString(),
      });
      assert.equal(byInterval.outcome, "held", JSON.stringify(byInterval));
      assert.equal(
        ms(holdRow(byInterval.hold).expires_at),
        start.getTime() - 600000,
      );
      world.cappedFirst = byInterval;
      const [lateStart, lateEnd] = nearSlot(5, 1);
      const tooLate = scheduledHold({
        attorney: capped,
        client: world.client2,
        jurisdiction: world.J.D,
        start: lateStart.toISOString(),
        end: lateEnd.toISOString(),
      });
      assert.equal(tooLate.outcome, "too_late");
      assert.equal(tooLate.committed, false);
      assert.equal(tooLate.sqlstate, "23514");
    },
  );
  await check(
    "HO-3 refusals: not_available with the problem (hold_conflict, outside_availability, blackout, notice), policy_unavailable for a jurisdiction without scheduling policy, cap_reached at pending_hold_cap, invalid for an instant Request, an ended Request, a Request that already has a Hold or missing arguments, not_found for an unknown Request; a refused acquisition can never commit its Request (the P1 Request/Hold check), so nothing is persisted",
    () => {
      const requestsBefore = count("consultation_requests");
      const holdsBefore = count("slot_holds");
      const attempt = (attorney, jurisdiction, start, end) =>
        scheduledHold({
          attorney,
          client: world.client3,
          jurisdiction,
          start,
          end,
        });
      const conflict = attempt(holder, world.J.A, at(2, 10, 15), at(2, 10, 45));
      assert.deepEqual(
        [conflict.outcome, conflict.problem],
        ["not_available", "hold_conflict"],
      );
      const outside = attempt(world.atty, world.J.A, at(2, 10), at(2, 11));
      assert.deepEqual(
        [outside.outcome, outside.problem],
        ["not_available", "outside_availability"],
      );
      const blackout = attempt(holder, world.J.A, at(4, 10), at(4, 11));
      assert.deepEqual(
        [blackout.outcome, blackout.problem],
        ["not_available", "blackout"],
      );
      const soon = attempt(
        holder,
        world.J.A,
        new Date(Date.now() + 10 * 60000).toISOString(),
        new Date(Date.now() + 20 * 60000).toISOString(),
      );
      assert.deepEqual(
        [soon.outcome, soon.problem],
        ["not_available", "notice"],
      );
      assert.equal(
        attempt(holder, world.J.B, at(2, 15), at(2, 16)).outcome,
        "policy_unavailable",
      );
      // Cap 2 in jurisdiction D: the second Hold is accepted, the third is not.
      const second = attempt(world.capped, world.J.D, at(3, 9), at(3, 10));
      assert.equal(second.outcome, "held");
      assert.equal(
        attempt(world.capped, world.J.D, at(3, 11), at(3, 12)).outcome,
        "cap_reached",
      );
      for (const result of [conflict, outside, blackout, soon]) {
        assert.equal(result.committed, false);
        assert.equal(result.sqlstate, "23514");
      }
      const invalid = (prefix, call) => {
        const request = uid();
        const referral = uid();
        const result = psql(
          [
            "begin;",
            prefix(request, referral),
            call(request),
            "rollback;",
          ].join("\n"),
        );
        assert.equal(result.status, 0, result.stderr);
        return parseHold(result.stdout.trim().split("\n").pop());
      };
      const instantPrefix = (request, referral) =>
        requestSql({
          request,
          referral,
          attorney: holder,
          client: world.client3,
          jurisdiction: world.J.A,
          path: "instant",
        });
      assert.equal(
        invalid(instantPrefix, (r) => ACQUIRE(r, at(2, 17), at(2, 18))).outcome,
        "invalid",
      );
      const endedPrefix = (request, referral) =>
        `${requestSql({ request, referral, attorney: holder, client: world.client3, jurisdiction: world.J.A })}
         update public.consultation_requests set state = 'cancelled', cancelled_at = clock_timestamp() where id = '${request}';`;
      assert.equal(
        invalid(endedPrefix, (r) => ACQUIRE(r, at(2, 17), at(2, 18))).outcome,
        "invalid",
      );
      assert.equal(
        invalid(
          () => "",
          () => ACQUIRE(world.heldA.request, at(2, 17), at(2, 18)),
        ).outcome,
        "invalid",
      );
      assert.equal(
        invalid(
          () => "",
          () => ACQUIRE(uid(), at(2, 17), at(2, 18)),
        ).outcome,
        "not_found",
      );
      assert.equal(
        invalid(
          () => "",
          () =>
            `select outcome || '||' from public.scheduling_acquire_hold(null, ${lit(at(2, 17))}, ${lit(at(2, 18))});`,
        ).outcome,
        "invalid",
      );
      assert.equal(count("consultation_requests"), requestsBefore + 1);
      assert.equal(count("slot_holds"), holdsBefore + 1);
    },
  );
  await check(
    "HO-4 release: refused while the Request is open (request_open); released once the caller has ended the Request in the same transaction; already_ended afterwards; not_found for an unknown Hold",
    () => {
      const held = scheduledHold({
        attorney: holder,
        client: world.client2,
        jurisdiction: world.J.A,
        start: at(2, 18),
        end: at(2, 19),
      });
      assert.equal(held.outcome, "held");
      assert.equal(
        sql(`select public.scheduling_release_hold('${held.hold}');`),
        "request_open",
      );
      assert.equal(
        sql(
          `begin;
           select public.scheduling_lock_attorney('${holder.profile}');
           update public.consultation_requests set state = 'cancelled', cancelled_at = clock_timestamp() where id = '${held.request}';
           select public.scheduling_release_hold('${held.hold}');
           commit;`,
        )
          .split("\n")
          .pop(),
        "released",
      );
      const row = holdRow(held.hold);
      assert.equal(row.release_reason, "released");
      assert.notEqual(row.released_at, null);
      assert.equal(
        sql(`select public.scheduling_release_hold('${held.hold}');`),
        "already_ended",
      );
      assert.equal(
        sql(`select public.scheduling_release_hold('${uid()}');`),
        "not_found",
      );
      assert.equal(
        slotProblem(holder, at(2, 18), at(2, 19), world.J.A),
        "none",
      );
    },
  );
  await check(
    "HO-5 expiry needs no scheduler: a Hold past its server deadline stops counting at once; the next command for that attorney (an acquisition) expires it first, its open Request moves to expired in the same transaction, one system audit event records it, and the slot can be held again",
    async () => {
      const expiring = world.expiring;
      const first = scheduledHold({
        attorney: expiring,
        client: world.client1,
        jurisdiction: world.J.C,
        start: at(2, 10),
        end: at(2, 11),
      });
      assert.equal(first.outcome, "held");
      const firstRow = holdRow(first.hold);
      assert.equal(ms(firstRow.expires_at) - ms(firstRow.held_at), 3000);
      assert.equal(
        sql(`select public.scheduling_expire_hold_if_due('${first.hold}');`),
        "active",
      );
      await untilPast(firstRow.expires_at);
      assert.equal(holdRow(first.hold).released_at, null, "nothing ran");
      assert.equal(
        slotProblem(expiring, at(2, 10), at(2, 11), world.J.C),
        "none",
      );
      const second = scheduledHold({
        attorney: expiring,
        client: world.client2,
        jurisdiction: world.J.C,
        start: at(2, 10),
        end: at(2, 11),
      });
      assert.equal(second.outcome, "held");
      const expired = holdRow(first.hold);
      assert.equal(expired.release_reason, "expired");
      const request = requestRow(first.request);
      assert.equal(request.state, "expired");
      assert.notEqual(request.expired_at, null);
      assert.equal(
        count(
          "audit_events",
          `action_code = 'slot_hold.expired' and resource_id = '${first.hold}' and actor_type = 'system' and actor_user_id is null and reason_code = 'expires_at_reached'`,
        ),
        1,
      );
      assert.equal(
        sql(`select public.scheduling_expire_hold_if_due('${first.hold}');`),
        "ended",
      );
      assert.equal(
        sql(`select public.scheduling_expire_hold_if_due('${uid()}');`),
        "not_found",
      );
      world.expiringSecond = second;
    },
  );
  await check(
    "HO-6 the bounded sweep expires every due Hold (and its open Request) in one pass and answers its counts; a second pass finds nothing",
    async () => {
      const expiring = world.expiring;
      const made = [11, 13, 15].map((hour) =>
        scheduledHold({
          attorney: expiring,
          client: world.client3,
          jurisdiction: world.J.C,
          start: at(2, hour),
          end: at(2, hour + 1),
        }),
      );
      for (const held of made) {
        assert.equal(held.outcome, "held");
      }
      await untilPast(holdRow(made[2].hold).expires_at);
      const swept = JSON.parse(
        sql("select public.scheduling_expiry_sweep()::text;"),
      );
      // The fourth (HO-5's) may already have been expired lazily by these
      // acquisitions for the same attorney.
      assert.ok(swept.expired >= 3, JSON.stringify(swept));
      assert.equal(swept.busy, 0);
      for (const held of [...made, world.expiringSecond]) {
        assert.equal(holdRow(held.hold).release_reason, "expired");
        assert.equal(requestRow(held.request).state, "expired");
      }
      assert.deepEqual(
        JSON.parse(sql("select public.scheduling_expiry_sweep()::text;")),
        {
          expired: 0,
          busy: 0,
        },
      );
    },
  );
  await check(
    "HO-7 conversion: acceptance converts the active Hold into exactly one confirmed Booking with the Hold's times, for the Consultation's attorney and client; the Hold ends as converted; the slot is then a booking_conflict; a second conversion is already_ended; a Consultation of another Request is not_found; a due Hold is expired and refused (expired)",
    async () => {
      const held = scheduledHold({
        attorney: holder,
        client: world.client2,
        jurisdiction: world.J.A,
        start: at(5, 10),
        end: at(5, 11),
      });
      assert.equal(held.outcome, "held");
      const converted = acceptAndConvert({
        attorney: holder,
        client: world.client2,
        request: held.request,
        hold: held.hold,
      });
      assert.equal(converted.outcome, "booked", JSON.stringify(converted));
      assert.equal(converted.status, 0);
      world.booked = { ...held, ...converted };
      const booking = JSON.parse(
        sql(
          `select row_to_json(b)::text from public.bookings b where id = '${converted.booking}';`,
        ),
      );
      const hold = holdRow(held.hold);
      assert.equal(booking.status, "confirmed");
      assert.equal(ms(booking.starts_at), ms(hold.slot_start_at));
      assert.equal(ms(booking.ends_at), ms(hold.slot_end_at));
      assert.equal(booking.attorney_id, holder.profile);
      assert.equal(booking.client_id, world.client2.client);
      assert.equal(booking.consultation_id, converted.consultation);
      assert.equal(hold.release_reason, "converted");
      assert.equal(
        slotProblem(holder, at(5, 10), at(5, 11), world.J.A),
        "booking_conflict",
      );
      const blocked = scheduledHold({
        attorney: holder,
        client: world.client3,
        jurisdiction: world.J.A,
        start: at(5, 10, 30),
        end: at(5, 11, 30),
      });
      assert.deepEqual(
        [blocked.outcome, blocked.problem],
        ["not_available", "booking_conflict"],
      );
      assert.equal(
        reasons(
          evaluate(holder, world.holderEligible, {
            start: at(5, 10),
            end: at(5, 11),
          }).row,
        )[1],
        "slot:false:booking_conflict",
      );
      assert.equal(
        sql(CONVERT(held.hold, converted.consultation)),
        "already_ended|",
      );
      assert.equal(
        sql(CONVERT(world.heldA.hold, converted.consultation)),
        "not_found|",
      );
      assert.equal(sql(CONVERT(uid(), converted.consultation)), "not_found|");
      const short = scheduledHold({
        attorney: world.expiring,
        client: world.client1,
        jurisdiction: world.J.C,
        start: at(3, 10),
        end: at(3, 11),
      });
      assert.equal(short.outcome, "held");
      await untilPast(holdRow(short.hold).expires_at);
      const late = acceptAndConvert({
        attorney: world.expiring,
        client: world.client1,
        request: short.request,
        hold: short.hold,
        commit: false,
      });
      assert.equal(late.outcome, "expired");
      assert.equal(
        count("bookings", `consultation_id = '${late.consultation}'`),
        0,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// IMP section 20 concurrency tests (real concurrency, persistent sessions)
// ---------------------------------------------------------------------------

function activeOverlap(attorney, start, end) {
  return count(
    "slot_holds",
    `attorney_id = '${attorney.profile}' and released_at is null and expires_at > clock_timestamp() and tstzrange(slot_start_at, slot_end_at, '[)') && tstzrange(${lit(start)}::timestamptz, ${lit(end)}::timestamptz, '[)')`,
  );
}

async function openRequest(sessionObj, attorney, client, jurisdiction) {
  const request = uid();
  const referral = uid();
  await sessionObj.ok("begin;");
  await sessionObj.ok(
    requestSql({ request, referral, attorney, client, jurisdiction }),
  );
  return request;
}

async function concurrencyChecks() {
  const racer = world.racer;
  await check(
    "CC-1 (IMP 20: two clients competing for one slot) two concurrent transactions each create a scheduled Request and acquire the same attorney/slot: the second waits on the attorney lock, then answers not_available/hold_conflict and cannot commit its Request; exactly one Hold exists. The same race through direct owner inserts that bypass the functions is refused by the P1 trigger (23P01)",
    async () => {
      const [start, end] = [at(6, 10), at(6, 11)];
      const a = await session("cc1a");
      const b = await session("cc1b");
      await openRequest(a, racer, world.client1, world.J.A).then(
        async (request) => {
          const rows = await a.ok(ACQUIRE(request, start, end));
          assert.equal(parseHold(rows[0]).outcome, "held");
        },
      );
      const requestB = await openRequest(b, racer, world.client2, world.J.A);
      const pending = b.send(ACQUIRE(requestB, start, end));
      const blocked = await blockedOnLock(b.pid);
      await a.ok("commit;");
      const answer = parseHold((await pending).rows[0]);
      assert.deepEqual(
        [answer.outcome, answer.problem],
        ["not_available", "hold_conflict"],
      );
      const committed = await b.send("commit;");
      assert.equal(committed.sqlstate, "23514");
      assert.equal(activeOverlap(racer, start, end), 1);
      assert.equal(count("consultation_requests", `id = '${requestB}'`), 0);
      // Direct inserts (owner role, no function): the P1 trigger serializes.
      const [s2, e2] = [at(6, 6), at(6, 7)];
      const ra = await openRequest(a, racer, world.client1, world.J.A);
      await a.ok(
        `insert into public.slot_holds (consultation_request_id, attorney_id, slot_start_at, slot_end_at, held_at, expires_at) values ('${ra}', '${racer.profile}', ${lit(s2)}, ${lit(e2)}, clock_timestamp(), clock_timestamp() + interval '10 minutes');`,
      );
      const rb = await openRequest(b, racer, world.client2, world.J.A);
      const direct = b.send(
        `insert into public.slot_holds (consultation_request_id, attorney_id, slot_start_at, slot_end_at, held_at, expires_at) values ('${rb}', '${racer.profile}', ${lit(s2)}, ${lit(e2)}, clock_timestamp(), clock_timestamp() + interval '10 minutes');`,
      );
      const directBlocked = await blockedOnLock(b.pid);
      await a.ok("commit;");
      assert.equal((await direct).sqlstate, "23P01");
      await b.send("rollback;");
      assert.equal(activeOverlap(racer, s2, e2), 1);
      a.close();
      b.close();
      report.concurrency.two_clients_one_slot = {
        winner: "held",
        loser: `${answer.outcome}/${answer.problem}`,
        loser_waited_on_lock: blocked,
        loser_commit_sqlstate: committed.sqlstate,
        direct_insert_loser_waited_on_lock: directBlocked,
        direct_insert_loser_sqlstate: "23P01",
      };
    },
  );
  await check(
    "CC-2 (IMP 20: overlapping Holds) concurrent acquisitions of overlapping but different slots for one attorney: the second waits, then answers hold_conflict; one active Hold covers the range",
    async () => {
      const a = await session("cc2a");
      const b = await session("cc2b");
      const ra = await openRequest(a, racer, world.client1, world.J.A);
      assert.equal(
        parseHold((await a.ok(ACQUIRE(ra, at(6, 13), at(6, 14))))[0]).outcome,
        "held",
      );
      const rb = await openRequest(b, racer, world.client2, world.J.A);
      const pending = b.send(ACQUIRE(rb, at(6, 13, 30), at(6, 14, 30)));
      const blocked = await blockedOnLock(b.pid);
      await a.ok("commit;");
      const answer = parseHold((await pending).rows[0]);
      assert.deepEqual(
        [answer.outcome, answer.problem],
        ["not_available", "hold_conflict"],
      );
      await b.send("rollback;");
      assert.equal(activeOverlap(racer, at(6, 13), at(6, 14, 30)), 1);
      a.close();
      b.close();
      report.concurrency.overlapping_holds = {
        winner: "held [13:00,14:00)",
        loser: `${answer.outcome}/${answer.problem} [13:30,14:30)`,
        loser_waited_on_lock: blocked,
      };
    },
  );
  await check(
    "CC-3 (IMP 20: Hold versus current Booking) an acquisition overlapping a Booking being created by a concurrent acceptance waits, then answers booking_conflict; a direct Booking insert overlapping a Hold being acquired concurrently waits, then is refused (23P01)",
    async () => {
      const held = scheduledHold({
        attorney: racer,
        client: world.client1,
        jurisdiction: world.J.A,
        start: at(6, 16),
        end: at(6, 17),
      });
      assert.equal(held.outcome, "held");
      const a = await session("cc3a");
      const b = await session("cc3b");
      const consultation = uid();
      await a.ok("begin;");
      await a.ok(`select public.scheduling_lock_attorney('${racer.profile}');`);
      await a.ok(ACCEPT(held.request));
      await a.ok(
        CONSULTATION(
          consultation,
          held.request,
          racer,
          world.client1,
          "scheduled",
        ),
      );
      assert.equal(
        (await a.ok(CONVERT(held.hold, consultation)))[0].split("|")[0],
        "booked",
      );
      const rb = await openRequest(b, racer, world.client2, world.J.A);
      const pending = b.send(ACQUIRE(rb, at(6, 16, 30), at(6, 17, 30)));
      const blocked = await blockedOnLock(b.pid);
      await a.ok("commit;");
      const answer = parseHold((await pending).rows[0]);
      assert.deepEqual(
        [answer.outcome, answer.problem],
        ["not_available", "booking_conflict"],
      );
      await b.send("rollback;");
      // The reverse: a Hold being acquired, a Booking inserted directly.
      const { consultation: instant } = instantConsultation(
        racer,
        world.client3,
      );
      const ra = await openRequest(a, racer, world.client1, world.J.A);
      assert.equal(
        parseHold((await a.ok(ACQUIRE(ra, at(6, 19), at(6, 20))))[0]).outcome,
        "held",
      );
      await b.ok("begin;");
      const direct = b.send(
        BOOKING(instant, racer, world.client3, at(6, 19, 30), at(6, 20, 30)),
      );
      const directBlocked = await blockedOnLock(b.pid);
      await a.ok("commit;");
      assert.equal((await direct).sqlstate, "23P01");
      await b.send("rollback;");
      assert.equal(count("bookings", `consultation_id = '${instant}'`), 0);
      a.close();
      b.close();
      report.concurrency.hold_versus_booking = {
        acquisition_during_conversion: `${answer.outcome}/${answer.problem}`,
        acquisition_waited_on_lock: blocked,
        booking_during_acquisition_sqlstate: "23P01",
        booking_waited_on_lock: directBlocked,
      };
    },
  );
  await check(
    "CC-4 (IMP 20: overlapping confirmed Bookings) two concurrent confirmed Bookings of different Consultations overlapping for one attorney: the second waits, then is refused (23P01); one current Booking covers the range",
    async () => {
      const first = instantConsultation(racer, world.client1);
      const second = instantConsultation(racer, world.client2);
      const a = await session("cc4a");
      const b = await session("cc4b");
      await a.ok("begin;");
      await a.ok(
        BOOKING(first.consultation, racer, world.client1, at(7, 10), at(7, 11)),
      );
      await b.ok("begin;");
      const pending = b.send(
        BOOKING(
          second.consultation,
          racer,
          world.client2,
          at(7, 10, 30),
          at(7, 11, 30),
        ),
      );
      const blocked = await blockedOnLock(b.pid);
      await a.ok("commit;");
      const answer = await pending;
      assert.equal(answer.sqlstate, "23P01");
      await b.send("rollback;");
      assert.equal(
        count(
          "bookings",
          `attorney_id = '${racer.profile}' and status = 'confirmed' and tstzrange(starts_at, ends_at, '[)') && tstzrange(${lit(at(7, 10))}::timestamptz, ${lit(at(7, 11, 30))}::timestamptz, '[)')`,
        ),
        1,
      );
      a.close();
      b.close();
      report.concurrency.overlapping_bookings = {
        winner: "confirmed",
        loser_sqlstate: answer.sqlstate,
        loser_waited_on_lock: blocked,
      };
    },
  );
  await check(
    "CC-5 (IMP 20: Hold expiration race) conversion and expiry of one Hold racing at its deadline end in exactly one outcome in every order: (i) a conversion that took the attorney lock before the deadline commits the Booking, while the sweep skips the busy attorney and a concurrent expiry waits and then finds the Hold ended; (ii) an expiry that holds the lock past the deadline commits, and an acceptance waiting on the attorney lock then finds the Request expired; (iii) an acceptance and an expiry fired together after the deadline: whichever wins, the Hold ends expired, its Request expired, no Booking, one expiry audit",
    async () => {
      const expiring = world.expiring;
      const a = await session("cc5a");
      const b = await session("cc5b");
      const c = await session("cc5c");
      // (i) conversion first.
      const one = scheduledHold({
        attorney: expiring,
        client: world.client1,
        jurisdiction: world.J.C,
        start: at(8, 10),
        end: at(8, 11),
      });
      assert.equal(one.outcome, "held");
      const consultationOne = uid();
      await a.ok("begin;");
      await a.ok(
        `select public.scheduling_lock_attorney('${expiring.profile}');`,
      );
      await a.ok(ACCEPT(one.request));
      await a.ok(
        CONSULTATION(
          consultationOne,
          one.request,
          expiring,
          world.client1,
          "scheduled",
        ),
      );
      assert.equal(
        (await a.ok(CONVERT(one.hold, consultationOne)))[0].split("|")[0],
        "booked",
      );
      await untilPast(holdRow(one.hold).expires_at);
      const swept = JSON.parse(
        (await c.ok("select public.scheduling_expiry_sweep()::text;"))[0],
      );
      assert.ok(swept.busy >= 1, JSON.stringify(swept));
      const expiry = b.send(
        `select public.scheduling_expire_hold_if_due('${one.hold}');`,
      );
      const expiryBlocked = await blockedOnLock(b.pid);
      await a.ok("commit;");
      assert.equal((await expiry).rows[0], "ended");
      assert.equal(holdRow(one.hold).release_reason, "converted");
      assert.equal(
        count(
          "bookings",
          `consultation_id = '${consultationOne}' and status = 'confirmed'`,
        ),
        1,
      );
      assert.equal(
        count(
          "audit_events",
          `action_code = 'slot_hold.expired' and resource_id = '${one.hold}'`,
        ),
        0,
      );
      // (ii) expiry first.
      const two = scheduledHold({
        attorney: expiring,
        client: world.client2,
        jurisdiction: world.J.C,
        start: at(8, 12),
        end: at(8, 13),
      });
      assert.equal(two.outcome, "held");
      await untilPast(holdRow(two.hold).expires_at);
      await a.ok("begin;");
      assert.equal(
        (
          await a.ok(
            `select public.scheduling_expire_hold_if_due('${two.hold}');`,
          )
        )[0],
        "expired",
      );
      await b.ok("begin;");
      const lock = b.send(
        `select public.scheduling_lock_attorney('${expiring.profile}');`,
      );
      const lockBlocked = await blockedOnLock(b.pid);
      await a.ok("commit;");
      assert.equal((await lock).sqlstate, "00000");
      const accepted = await b.ok(
        `update public.consultation_requests set state = 'accepted', accepted_at = clock_timestamp() where id = '${two.request}' and state = 'pending' returning id;`,
      );
      assert.deepEqual(accepted, []);
      await b.send("rollback;");
      assert.equal(holdRow(two.hold).release_reason, "expired");
      assert.equal(requestRow(two.request).state, "expired");
      // (iii) fired together after the deadline.
      const three = scheduledHold({
        attorney: expiring,
        client: world.client3,
        jurisdiction: world.J.C,
        start: at(8, 14),
        end: at(8, 15),
      });
      assert.equal(three.outcome, "held");
      await untilPast(holdRow(three.hold).expires_at);
      const consultationThree = uid();
      // Both are sent at once. The acceptance's transaction stays open until
      // it is rolled back (as an acceptance refused by an expired Hold would
      // be), so the expiry's answer is awaited only after that.
      const acceptanceSent = a.send(
        [
          "begin;",
          `select public.scheduling_lock_attorney('${expiring.profile}');`,
          ACCEPT(three.request),
          CONSULTATION(
            consultationThree,
            three.request,
            expiring,
            world.client3,
            "scheduled",
          ),
          CONVERT(three.hold, consultationThree),
        ].join("\n"),
      );
      const expirySent = b.send(
        `select public.scheduling_expire_hold_if_due('${three.hold}');`,
      );
      const acceptance = await acceptanceSent;
      await a.send("rollback;");
      const expiryThree = await expirySent;
      const conversionAnswer =
        acceptance.sqlstate === "00000"
          ? acceptance.rows[acceptance.rows.length - 1]
          : `ERROR ${acceptance.sqlstate}`;
      assert.ok(
        ["expired|", "already_ended|"].includes(conversionAnswer) ||
          conversionAnswer.startsWith("ERROR 23514") ||
          conversionAnswer.startsWith("ERROR 25P02"),
        conversionAnswer,
      );
      if (
        count("slot_holds", `id = '${three.hold}' and released_at is null`) ===
        1
      ) {
        // The acceptance won, expired the Hold inside its own transaction and
        // rolled back; the waiting expiry then ran on the restored Hold.
        assert.fail("the Hold must be ended");
      }
      assert.equal(holdRow(three.hold).release_reason, "expired");
      assert.equal(requestRow(three.request).state, "expired");
      assert.equal(
        count("bookings", `consultation_id = '${consultationThree}'`),
        0,
      );
      assert.equal(count("consultations", `id = '${consultationThree}'`), 0);
      assert.equal(
        count(
          "audit_events",
          `action_code = 'slot_hold.expired' and resource_id = '${three.hold}'`,
        ),
        1,
      );
      a.close();
      b.close();
      c.close();
      report.concurrency.hold_expiration_race = {
        conversion_first: {
          booking: "confirmed",
          sweep: swept,
          expiry_waited_on_lock: expiryBlocked,
          expiry_answer: "ended",
        },
        expiry_first: {
          expiry_answer: "expired",
          acceptance_waited_on_lock: lockBlocked,
          acceptance_found_request: "expired (0 rows accepted)",
        },
        simultaneous: {
          acceptance_answer: conversionAnswer,
          expiry_answer: expiryThree.rows[0] ?? `ERROR ${expiryThree.sqlstate}`,
          final: "hold expired, request expired, no booking, one expiry audit",
        },
      };
    },
  );
  await check(
    "CC-6 (IMP 20: Booking/currentness) two concurrent confirmed Bookings for one Consultation: the second waits, then is refused by the one-current-Booking index (23505); exactly one current Booking",
    async () => {
      const { consultation } = instantConsultation(racer, world.client1);
      const a = await session("cc6a");
      const b = await session("cc6b");
      await a.ok("begin;");
      await a.ok(
        BOOKING(consultation, racer, world.client1, at(9, 10), at(9, 11)),
      );
      await b.ok("begin;");
      const pending = b.send(
        BOOKING(consultation, racer, world.client1, at(9, 14), at(9, 15)),
      );
      const blocked = await blockedOnLock(b.pid);
      await a.ok("commit;");
      const answer = await pending;
      assert.equal(answer.sqlstate, "23505");
      await b.send("rollback;");
      assert.equal(
        count(
          "bookings",
          `consultation_id = '${consultation}' and status = 'confirmed'`,
        ),
        1,
      );
      a.close();
      b.close();
      report.concurrency.booking_currentness = {
        winner: "confirmed",
        loser_sqlstate: answer.sqlstate,
        loser_waited_on_lock: blocked,
      };
    },
  );
  await check(
    "CC-7 (IMP 20: time zone boundary) two clients whose sessions run in Asia/Tokyo and America/New_York request the same instant written in their own local time, inside an Asia/Tokyo window that crosses UTC midnight: the second waits, then answers hold_conflict; the stored Hold is the one UTC instant; slots before or after the window are outside_availability",
    async () => {
      const tokyo = world.tokyo;
      const localDate = sql(
        "select to_char((now() at time zone 'Asia/Tokyo')::date + 4, 'YYYY-MM-DD');",
      );
      const weekday = sql(
        `select extract(isodow from date '${localDate}')::int;`,
      );
      sql(
        `insert into public.availability_rules (attorney_id, rule_kind, timezone_name, weekday, local_start_time, local_end_time, effective_from, active)
         values ('${tokyo.profile}', 'recurring', 'Asia/Tokyo', ${weekday}, '08:00', '10:00', current_date, true);`,
      );
      const windowRow = sql(
        `select to_char(window_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') || '|' || to_char(window_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') from public.scheduling_expand_availability('${tokyo.profile}', '${localDate}', '${localDate}');`,
      );
      const [windowStart, windowEnd] = windowRow.split("|");
      assert.ok(
        windowStart.endsWith("T23:00Z") && windowEnd.endsWith("T01:00Z"),
        windowRow,
      );
      const utcStart = sql(
        `select to_char(('${localDate} 08:30'::timestamp at time zone 'Asia/Tokyo') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');`,
      );
      const utcEnd = sql(
        `select to_char(('${localDate} 09:30'::timestamp at time zone 'Asia/Tokyo') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');`,
      );
      const newYork = (instant) =>
        sql(
          `select to_char('${instant}'::timestamptz at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI');`,
        );
      const a = await session("cc7a");
      const b = await session("cc7b");
      await a.ok("set time zone 'Asia/Tokyo';");
      await b.ok("set time zone 'America/New_York';");
      const ra = await openRequest(a, tokyo, world.client1, world.J.A);
      const held = parseHold(
        (
          await a.ok(ACQUIRE(ra, `${localDate} 08:30`, `${localDate} 09:30`))
        )[0],
      );
      assert.equal(held.outcome, "held");
      const rb = await openRequest(b, tokyo, world.client2, world.J.A);
      const pending = b.send(ACQUIRE(rb, newYork(utcStart), newYork(utcEnd)));
      const blocked = await blockedOnLock(b.pid);
      await a.ok("commit;");
      const answer = parseHold((await pending).rows[0]);
      assert.deepEqual(
        [answer.outcome, answer.problem],
        ["not_available", "hold_conflict"],
      );
      await b.send("rollback;");
      a.close();
      b.close();
      assert.equal(
        sql(
          `select to_char(slot_start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '|' || to_char(slot_end_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from public.slot_holds where id = '${held.hold}';`,
        ),
        `${utcStart}|${utcEnd}`,
      );
      const plusHours = (instant, hours) =>
        new Date(ms(instant) + hours * 3600000).toISOString();
      assert.equal(
        slotProblem(
          tokyo,
          plusHours(utcStart, 1),
          plusHours(utcEnd, 1),
          world.J.A,
        ),
        "outside_availability",
      );
      assert.equal(
        slotProblem(
          tokyo,
          plusHours(utcStart, -1),
          plusHours(utcEnd, -1),
          world.J.A,
        ),
        "outside_availability",
      );
      report.concurrency.time_zone_boundary = {
        local_date_tokyo: localDate,
        window_utc: windowRow,
        tokyo_client: `${localDate} 08:30 Asia/Tokyo -> held`,
        new_york_client: `${newYork(utcStart)} America/New_York -> ${answer.outcome}/${answer.problem}`,
        loser_waited_on_lock: blocked,
        stored_utc: `${utcStart}/${utcEnd}`,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// MBS section 9 invariants 1-6
// ---------------------------------------------------------------------------

async function invariantChecks() {
  const booker = world.booker;
  await check(
    "INV-1 at most one confirmed Booking per Consultation, and zero is valid: the partial unique index exists, a Consultation without a Booking is accepted, a second confirmed Booking for one Consultation is refused (23505), and the CC-6 race left exactly one",
    () => {
      assert.match(
        sql(
          "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'bookings_one_confirmed_per_consultation_idx';",
        ),
        /UNIQUE INDEX .* ON public\.bookings USING btree \(consultation_id\) WHERE \(status = 'confirmed'::text\)/,
      );
      const { consultation } = instantConsultation(booker, world.client1);
      assert.equal(count("bookings", `consultation_id = '${consultation}'`), 0);
      sql(BOOKING(consultation, booker, world.client1, at(10, 10), at(10, 11)));
      assert.equal(
        refused(
          BOOKING(consultation, booker, world.client1, at(10, 14), at(10, 15)),
        ),
        "23505",
      );
      assert.ok(report.concurrency.booking_currentness);
    },
  );
  await check(
    "INV-2 overlapping active Holds for one attorney are impossible structurally: a direct owner insert overlapping an active Hold is refused (23P01) whatever path writes it, and the CC-1 and CC-2 races left one",
    () => {
      const held = scheduledHold({
        attorney: booker,
        client: world.client1,
        jurisdiction: world.J.A,
        start: at(10, 16),
        end: at(10, 17),
      });
      assert.equal(held.outcome, "held");
      const request = uid();
      const referral = uid();
      assert.equal(
        refused(
          `${requestSql({ request, referral, attorney: booker, client: world.client2, jurisdiction: world.J.A })}
           insert into public.slot_holds (consultation_request_id, attorney_id, slot_start_at, slot_end_at, held_at, expires_at)
           values ('${request}', '${booker.profile}', ${lit(at(10, 16, 30))}, ${lit(at(10, 17, 30))}, clock_timestamp(), clock_timestamp() + interval '5 minutes');`,
        ),
        "23P01",
      );
      assert.ok(report.concurrency.two_clients_one_slot);
      assert.ok(report.concurrency.overlapping_holds);
      world.bookerHold = held;
    },
  );
  await check(
    "INV-3 a scheduled Request and its Hold are one unit: a scheduled Request without a Hold cannot commit, a refused acquisition cannot commit its Request, and an instant Request cannot have a Hold (23514 at commit)",
    () => {
      const request = uid();
      const referral = uid();
      assert.equal(
        refused(
          requestSql({
            request,
            referral,
            attorney: booker,
            client: world.client1,
            jurisdiction: world.J.A,
          }),
        ),
        "23514",
      );
      const refusedHold = scheduledHold({
        attorney: booker,
        client: world.client1,
        jurisdiction: world.J.A,
        start: at(10, 16),
        end: at(10, 17),
      });
      assert.equal(refusedHold.outcome, "not_available");
      assert.equal(refusedHold.sqlstate, "23514");
      assert.equal(
        count("consultation_requests", `id = '${refusedHold.request}'`),
        0,
      );
      const instant = uid();
      const instantReferral = uid();
      assert.equal(
        refused(
          `${requestSql({ request: instant, referral: instantReferral, attorney: booker, client: world.client1, jurisdiction: world.J.A, path: "instant" })}
           insert into public.slot_holds (consultation_request_id, attorney_id, slot_start_at, slot_end_at, held_at, expires_at)
           values ('${instant}', '${booker.profile}', ${lit(at(10, 20))}, ${lit(at(10, 21))}, clock_timestamp(), clock_timestamp() + interval '5 minutes');`,
        ),
        "23514",
      );
    },
  );
  await check(
    "INV-4 an ended or expired Request cannot keep an active Hold: ending a Request while its Hold stays active cannot commit (23514), accepting without converting cannot commit, release refuses while the Request is open, Hold expiry expires the open Request in the same transaction (HO-5, HO-6), and an ended Hold can never become active again (55000)",
    () => {
      const held = world.bookerHold;
      for (const change of [
        `update public.consultation_requests set state = 'cancelled', cancelled_at = clock_timestamp() where id = '${held.request}';`,
        `update public.consultation_requests set state = 'declined', declined_at = clock_timestamp() where id = '${held.request}';`,
        ACCEPT(held.request),
      ]) {
        assert.equal(refused(change), "23514", change);
      }
      assert.equal(
        sql(`select public.scheduling_release_hold('${held.hold}');`),
        "request_open",
      );
      assert.equal(
        refused(
          `update public.slot_holds set released_at = null, release_reason = null where id = '${world.booked.hold}';`,
        ),
        "55000",
      );
      assert.equal(requestRow(world.heldA.request).state, "pending");
    },
  );
  await check(
    "INV-5 no Booking before acceptance: a Booking needs an existing Consultation (23503) whose Request is accepted (a Request moved off accepted cannot get a Booking, 23514), for exactly its attorney and client (23514), and is created confirmed (23514); conversion requires the accepted Request's Consultation",
    () => {
      const { request, consultation } = instantConsultation(
        booker,
        world.client2,
      );
      assert.equal(
        refused(BOOKING(uid(), booker, world.client2, at(11, 10), at(11, 11))),
        "23503",
      );
      assert.equal(
        refused(
          BOOKING(consultation, booker, world.client1, at(11, 10), at(11, 11)),
        ),
        "23514",
      );
      assert.equal(
        refused(
          BOOKING(
            consultation,
            world.racer,
            world.client2,
            at(11, 10),
            at(11, 11),
          ),
        ),
        "23514",
      );
      assert.equal(
        refused(
          `insert into public.bookings (consultation_id, attorney_id, client_id, starts_at, ends_at, status, cancelled_at)
           values ('${consultation}', '${booker.profile}', '${world.client2.client}', ${lit(at(11, 10))}, ${lit(at(11, 11))}, 'cancelled', now());`,
        ),
        "23514",
      );
      assert.equal(
        refused(
          `update public.consultation_requests set state = 'pending', accepted_at = null where id = '${request}';
           ${BOOKING(consultation, booker, world.client2, at(11, 10), at(11, 11))}`,
        ),
        "23514",
      );
      acceptedThenRolledBack(
        BOOKING(consultation, booker, world.client2, at(11, 10), at(11, 11)),
      );
    },
  );
  await check(
    "INV-6 overlapping current Bookings for one attorney are impossible: a direct overlapping confirmed Booking is refused (23P01), a non-overlapping one is accepted, and the CC-4 race left one",
    () => {
      const other = instantConsultation(booker, world.client3);
      assert.equal(
        refused(
          BOOKING(
            other.consultation,
            booker,
            world.client3,
            at(10, 10, 30),
            at(10, 11, 30),
          ),
        ),
        "23P01",
      );
      acceptedThenRolledBack(
        BOOKING(
          other.consultation,
          booker,
          world.client3,
          at(10, 11),
          at(10, 12),
        ),
      );
      assert.ok(report.concurrency.overlapping_bookings);
    },
  );
}

// ---------------------------------------------------------------------------
// Integrity guards (every role, the owner included)
// ---------------------------------------------------------------------------

async function integrityChecks() {
  await check(
    "INT-1 Slot Holds: never deleted or truncated; attorney, request, slot and server expiry never change (expires_at is never extended); a Hold ends once with both released_at and a known reason; an ended Hold is immutable",
    () => {
      const active = world.heldA.hold;
      const ended = world.booked.hold;
      for (const [statement, state] of [
        [`delete from public.slot_holds where id = '${active}';`, "55000"],
        ["truncate public.slot_holds;", "55000"],
        [
          `update public.slot_holds set slot_start_at = slot_start_at + interval '1 minute' where id = '${active}';`,
          "55000",
        ],
        [
          `update public.slot_holds set expires_at = expires_at + interval '1 hour' where id = '${active}';`,
          "55000",
        ],
        [
          `update public.slot_holds set expires_at = expires_at - interval '1 second' where id = '${active}';`,
          "55000",
        ],
        [
          `update public.slot_holds set attorney_id = '${world.racer.profile}' where id = '${active}';`,
          "55000",
        ],
        [
          `update public.slot_holds set released_at = now(), release_reason = 'withdrawn' where id = '${active}';`,
          "23514",
        ],
        [
          `update public.slot_holds set released_at = now() where id = '${active}';`,
          "23514",
        ],
        [
          `update public.slot_holds set release_reason = 'released' where id = '${active}';`,
          "23514",
        ],
        [
          `update public.slot_holds set release_reason = 'released' where id = '${ended}';`,
          "55000",
        ],
        [
          `update public.slot_holds set released_at = released_at + interval '1 second' where id = '${ended}';`,
          "55000",
        ],
      ]) {
        assert.equal(refused(statement), state, statement);
      }
      acceptedThenRolledBack(
        `update public.slot_holds set released_at = now(), release_reason = 'released' where id = '${active}';`,
      );
    },
  );
  await check(
    "INT-2 Bookings: never deleted or truncated; nothing but the status changes; confirmed moves only to superseded, cancelled or completed with that transition's timestamp; an ended Booking is immutable",
    () => {
      const booking = world.booked.booking;
      for (const [statement, state] of [
        [`delete from public.bookings where id = '${booking}';`, "55000"],
        ["truncate public.bookings;", "55000"],
        [
          `update public.bookings set starts_at = starts_at + interval '1 minute' where id = '${booking}';`,
          "55000",
        ],
        [
          `update public.bookings set client_id = '${world.client1.client}' where id = '${booking}';`,
          "55000",
        ],
        [
          `update public.bookings set status = 'superseded' where id = '${booking}';`,
          "23514",
        ],
        [
          `update public.bookings set status = 'cancelled', cancelled_at = now() where id = '${booking}'; update public.bookings set status = 'confirmed', cancelled_at = null where id = '${booking}';`,
          "55000",
        ],
        [
          `update public.bookings set status = 'completed' where id = '${booking}'; update public.bookings set status = 'cancelled', cancelled_at = now() where id = '${booking}';`,
          "55000",
        ],
      ]) {
        assert.equal(refused(statement), state, statement);
      }
      for (const statement of [
        `update public.bookings set status = 'superseded', superseded_at = now() where id = '${booking}';`,
        `update public.bookings set status = 'cancelled', cancelled_at = now() where id = '${booking}';`,
        `update public.bookings set status = 'completed' where id = '${booking}';`,
      ]) {
        acceptedThenRolledBack(statement);
      }
    },
  );
  await check(
    "INT-3 availability rules and Blackouts: a rule is never deleted, truncated or edited and only deactivated (never reactivated); a Blackout is never edited or truncated and is deleted only before it starts",
    () => {
      for (const [statement, state] of [
        [
          `delete from public.availability_rules where id = '${world.rule}';`,
          "55000",
        ],
        ["truncate public.availability_rules;", "55000"],
        [
          `update public.availability_rules set timezone_name = 'Europe/Paris' where attorney_id = '${world.holder.profile}';`,
          "55000",
        ],
        [
          `update public.availability_rules set local_end_time = '23:00' where attorney_id = '${world.holder.profile}';`,
          "55000",
        ],
        [
          `update public.availability_rules set active = true where id = '${world.rule}';`,
          "55000",
        ],
        [
          `update public.blackouts set reason_code = 'other_reason' where id = '${world.futureBlackout}';`,
          "55000",
        ],
        [
          `delete from public.blackouts where id = '${world.startedBlackout}';`,
          "55000",
        ],
        ["truncate public.blackouts;", "55000"],
      ]) {
        assert.equal(refused(statement), state, statement);
      }
      acceptedThenRolledBack(
        `update public.availability_rules set active = false where attorney_id = '${world.holder.profile}';`,
      );
      acceptedThenRolledBack(
        `delete from public.blackouts where id = '${world.futureBlackout}';`,
      );
    },
  );
  await check(
    "INT-4 Instant intents and application sessions: never deleted or truncated; an intent keeps its attorney, session and creation time, its expiry and enabling time only move forward, and its revocation is cleared only by enabling again (and stays within its live session); a session keeps its user, reference and start, its expiry only moves forward and is fixed once ended, and ended_at and revoked_at are each set once",
    () => {
      const live = sessionRow(world.s5);
      const intent = intentOf(live);
      const ended = sessionRow(world.s1);
      for (const [statement, state] of [
        [
          `delete from public.instant_availability_intents where id = '${intent.id}';`,
          "55000",
        ],
        ["truncate public.instant_availability_intents;", "55000"],
        [
          `update public.instant_availability_intents set application_session_id = '${ended.id}' where id = '${intent.id}';`,
          "55000",
        ],
        [
          `update public.instant_availability_intents set attorney_id = '${world.atty.profile}' where id = '${intent.id}';`,
          "55000",
        ],
        [
          `update public.instant_availability_intents set expires_at = expires_at - interval '1 second' where id = '${intent.id}';`,
          "55000",
        ],
        [
          `update public.instant_availability_intents set enabled_at = enabled_at - interval '1 second' where id = '${intent.id}';`,
          "55000",
        ],
        [
          `update public.instant_availability_intents set revoked_at = now() where id = '${intent.id}'; update public.instant_availability_intents set revoked_at = now() + interval '1 second' where id = '${intent.id}';`,
          "55000",
        ],
        [
          `update public.instant_availability_intents set revoked_at = now() where id = '${intent.id}'; update public.instant_availability_intents set revoked_at = null where id = '${intent.id}';`,
          "55000",
        ],
        [
          `update public.instant_availability_intents set enabled_at = now() + interval '1 second', revoked_at = now() + interval '2 seconds' where id = '${intent.id}';`,
          "55000",
        ],
        [
          `update public.instant_availability_intents set expires_at = expires_at + interval '2 hours' where id = '${intent.id}';`,
          "23514",
        ],
        [
          `delete from public.application_sessions where id = '${ended.id}';`,
          "55000",
        ],
        [
          "truncate public.application_sessions, public.instant_availability_intents;",
          "55000",
        ],
        [
          `update public.application_sessions set user_id = '${world.atty.user}' where id = '${live.id}';`,
          "55000",
        ],
        [
          `update public.application_sessions set auth_session_reference = '${sha256(uid())}' where id = '${live.id}';`,
          "55000",
        ],
        [
          `update public.application_sessions set started_at = started_at - interval '1 second' where id = '${live.id}';`,
          "55000",
        ],
        [
          `update public.application_sessions set expires_at = expires_at - interval '1 second' where id = '${live.id}';`,
          "55000",
        ],
        [
          `update public.application_sessions set expires_at = expires_at + interval '1 hour' where id = '${ended.id}';`,
          "55000",
        ],
        [
          `update public.application_sessions set ended_at = ended_at + interval '1 second' where id = '${ended.id}';`,
          "55000",
        ],
        [
          `update public.application_sessions set revoked_at = now() where id = '${live.id}'; update public.application_sessions set revoked_at = now() + interval '1 second' where id = '${live.id}';`,
          "55000",
        ],
      ]) {
        assert.equal(refused(statement), state, statement);
      }
      acceptedThenRolledBack(
        `update public.instant_availability_intents set revoked_at = now() where id = '${intent.id}'; update public.instant_availability_intents set revoked_at = null, enabled_at = now() + interval '1 millisecond' where id = '${intent.id}';`,
      );
      acceptedThenRolledBack(
        `update public.application_sessions set expires_at = expires_at + interval '1 minute' where id = '${live.id}';`,
      );
    },
  );
  await check(
    "INT-5 Bookability Evaluations are append-only evidence (no update, delete or truncate by any role) and only bookable or not_bookable results with an identified referral or consultation request context are accepted",
    () => {
      const id = sql(
        "select id from public.bookability_evaluations order by created_at limit 1;",
      );
      const insert = (result, context, contextId) =>
        `insert into public.bookability_evaluations (attorney_id, eligibility_evaluation_id, context_type, context_id, evaluated_at, as_of, modality, constraint_results, result)
         values ('${world.instant.profile}', '${world.instantEligible}', ${lit(context)}, ${lit(contextId)}, now(), now(), 'video', '[]'::jsonb, ${lit(result)});`;
      for (const [statement, state] of [
        [
          `update public.bookability_evaluations set result = 'bookable' where id = '${id}';`,
          "55000",
        ],
        [
          `delete from public.bookability_evaluations where id = '${id}';`,
          "55000",
        ],
        ["truncate public.bookability_evaluations;", "55000"],
        [insert("maybe", "referral", uid()), "23514"],
        [insert("bookable", "listing", uid()), "23514"],
        [insert("bookable", "referral", null), "23514"],
      ]) {
        assert.equal(refused(statement), state, statement);
      }
      acceptedThenRolledBack(insert("not_bookable", "referral", uid()));
      assert.equal(
        as(
          "service_role",
          null,
          `update public.bookability_evaluations set result = 'bookable' where id = '${id}';`,
        ),
        "ERROR 42501",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Audit minimization
// ---------------------------------------------------------------------------

const AUDIT_SHAPES = Object.freeze({
  "availability_rule.created": [
    "",
    "effective_from,effective_until,local_end_time,local_start_time,rule_kind,specific_date,timezone_name,weekday",
  ],
  "availability_rule.deactivated": ["active", "active"],
  "blackout.created": ["", "ends_at,reason_code,starts_at"],
  "blackout.removed": ["ends_at,reason_code,starts_at", ""],
  "application_session.started": ["", "expires_at"],
  "application_session.ended": ["", "revoked_intents"],
  "instant_intent.enabled": ["", "expires_at"],
  "instant_intent.disabled": ["", "revoked_intents"],
  "slot_hold.expired": ["expires_at,state", "release_reason,request_expired"],
});

async function auditChecks() {
  await check(
    "AUD-1 S4 audit events are minimal: each action records only its fixed snapshot keys, attorney or system actors, no jurisdiction; no client, Intake, Request content, provider session id or session reference appears in any S4 audit event; a session's touches are not audited beyond its first observation",
    () => {
      const shapes = JSON.parse(
        sql(
          `select json_object_agg(action_code, shape)::text from (
             select action_code,
               string_agg(distinct coalesce((select string_agg(k, ',' order by k) from jsonb_object_keys(coalesce(before_snapshot, '{}'::jsonb)) k), '') || '/' ||
                 coalesce((select string_agg(k, ',' order by k) from jsonb_object_keys(coalesce(after_snapshot, '{}'::jsonb)) k), ''), ';') as shape
             from public.audit_events
             where action_code in (${Object.keys(AUDIT_SHAPES).map(lit).join(", ")})
             group by action_code
           ) s;`,
        ),
      );
      for (const [action, [before, after]] of Object.entries(AUDIT_SHAPES)) {
        assert.equal(shapes[action], `${before}/${after}`, action);
      }
      assert.equal(
        count(
          "audit_events",
          `action_code in (${Object.keys(AUDIT_SHAPES).map(lit).join(", ")}) and (jurisdiction_id is not null or actor_type not in ('attorney', 'system'))`,
        ),
        0,
      );
      const forbidden = [
        world.client1.client,
        world.client2.client,
        world.client3.client,
        world.client1.intake,
        world.client2.intake,
        world.client3.intake,
        world.client1.user,
        world.client2.user,
        world.client3.user,
        world.s1.id,
        world.s5.id,
        sha256(world.s1.id),
        sha256(world.s5.id),
        world.heldA.request,
      ];
      assert.equal(
        count(
          "audit_events",
          `action_code in (${Object.keys(AUDIT_SHAPES).map(lit).join(", ")}) and (coalesce(before_snapshot::text, '') || coalesce(after_snapshot::text, '') || coalesce(policy_references::text, '')) ~ ${lit(forbidden.join("|"))}`,
        ),
        0,
      );
      assert.equal(
        count(
          "audit_events",
          `action_code = 'application_session.started' and actor_user_id = '${world.instant.user}'`,
        ),
        count("application_sessions", `user_id = '${world.instant.user}'`),
      );
      return shapes;
    },
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  try {
    startCluster();
    applyMigrations();
    await unrecordedChecks();
    sql("select public.record_deployment_environment('development', null);");
    report.environment = sql(
      "select environment_class from public.deployment_environment;",
    );
    seed();
    await inventoryChecks();
    await policyChecks();
    await availabilityChecks();
    await instantChecks();
    await bookabilityChecks();
    await holdChecks();
    await concurrencyChecks();
    await invariantChecks();
    await integrityChecks();
    await auditChecks();
  } catch (error) {
    report.error = String(error?.stack ?? error);
    failed = true;
  }
  const cleaned = teardown();
  report.cleanup = cleaned;
  report.summary = {
    checks: report.checks.length,
    passed: report.checks.filter((c) => c.result === "PASS").length,
    failed: report.checks.filter((c) => c.result === "FAIL").length,
  };
  report.result = failed ? "FAIL" : cleaned ? "PASS" : "CLEANUP-FAILED";
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = failed ? 1 : cleaned ? 0 : 2;
}

await main();
