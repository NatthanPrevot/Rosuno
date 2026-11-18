// MVP-001 S7 disposable PostgreSQL proof (M9 Payment infrastructure).
// Explicitly invoked only:
//
//   node apps/web/tests/mvp-001-s7-db-proof.mjs
//
// Deliberately not a *.test.mjs file, so no application test run, p0:test,
// or CI job starts it. It uses Node built-ins and the system-installed
// PostgreSQL 16 initdb, pg_ctl, and psql binaries.
//
// It creates a new mode-0700 temporary directory, initializes a new cluster
// owned by an unprivileged account (never root), and starts it with TCP
// disabled and a private Unix-domain socket (port 54343, so it can run next
// to the MVP-001 S6 proofs). The roles anon, authenticated, and service_role
// (BYPASSRLS), the synthetic auth schema (auth.users and an auth.uid() that
// reads request.jwt.claim.sub), the hosted platform's default privileges,
// and a no-op public.rls_auto_enable() are synthetic objects of this cluster
// only. Every migration is applied unmodified, in order, each in one
// transaction, to two databases: the main database records its environment
// as development; a second one records production (a synthetic 20-letter
// project reference) for the production financial gate probes. The two S7
// migrations must follow S6 PS-A3 and be registered.
//
// Configuration: every policy version of the development database
// (eligibility, scheduling, bookability, referral, fee, payment,
// payment_flow, engagement, cancellation, refund) is development
// configuration created by the owner role inside this disposable cluster
// (Packet rule 9); the production database uses owner-walked authority
// versions with a synthetic verified reference, or development rows planted
// with triggers bypassed for the negative probes. The values, the XTS test
// currency code, the synthetic_* modality codes, the SYN_* Regulatory Modes
// and every payment, ledger, receipt, provider reference and exception are
// synthetic test data (FP-1 section 3.4), never product values.
//
// The provider is simulated: the probes play the worker (they claim a
// specific payment job as the owner, read payment_job_context and record
// results through payment_record_operation as service_role, exactly as the
// server-only worker port does) and the webhook route (they record events
// through payment_record_provider_event as service_role, as the route does
// after verifying the signature). No provider, Supabase project, network
// service or pre-existing cluster is contacted, and nothing persists after
// the run.
//
// Request sessions are modelled as PostgREST sets them from a verified JWT:
// request.jwt.claim.sub and the JSON request.jwt.claims (clients at aal1,
// attorneys and staff at aal2 unless a probe says otherwise); anonymous
// requests run as anon without a subject.
//
// The probes cover the MVP-001 Packet S7 acceptance for the database: the IMP
// section 23 exit list (success, authorization failure, capture failure,
// duplicate webhook, out-of-order webhook, refund, reconciliation); the MBS
// section 12 failure tests (authorization failure fails honestly; capture
// failure opens the exception path; a duplicate webhook is idempotent; a
// delayed or out-of-order webhook never overwrites newer state; a refund
// appends ledger entries; production cannot activate a development-only
// policy) and the four-way gate; FP-1 provenance (all seven policies, the
// Regulatory Mode, the jurisdiction; anything missing creates nothing); the
// flow-policy seam both ways; the lifecycle guards for every role; currency
// integrity and amounts; append-only ledger and idempotent posting; receipt
// uniqueness; dispute observation; withdrawal and expiry releasing the
// authorization; reconciliation and exhausted jobs; authorization; audit
// minimization; and real concurrency with two persistent sessions. Each
// probe names the Payment Matrix rows it covers (PM). The JSON report goes
// to stdout; exit 0 means PASS, 1 FAIL, 2 cleanup failure.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54343;
const DB = "rosuno_s7_proof";
const PROD_DB = "rosuno_s7_proof_production";
const PRODUCTION_REF = "syntheticsevenprodre";
const REPOSITORY_ROOT = path.resolve(
  path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
  "../../..",
);
const MIGRATIONS = path.join(REPOSITORY_ROOT, "supabase/migrations");
const S6_LAST = "20261122040000_mvp_001_s6_consultation_offers.sql";
const S7_MIGRATIONS = Object.freeze([
  "20261123010000_mvp_001_s7_payment_integrity.sql",
  "20261123020000_mvp_001_s7_payment_engine.sql",
]);
// MVP-001 S8: the three S8 migrations follow the S7 migrations (applied by
// this proof as later registered migrations; registered and checked by the S8
// proof).
const S8_MIGRATIONS = Object.freeze([
  "20261124010000_mvp_001_s8_decision_integrity.sql",
  "20261124020000_mvp_001_s8_attorney_decision.sql",
  "20261124030000_mvp_001_s8_change_review.sql",
]);

const report = {
  proof: "MVP-001 S7 disposable local PostgreSQL proof",
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

const fixtureFor = (db) => `
create database ${db} template template0 encoding 'UTF8' locale 'C';
\\connect ${db}
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
    path.join(os.tmpdir(), "rosuno-mvp-001-s7-db-proof-"),
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

function applyMigrationsTo(db, files) {
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
        db,
      ],
      fs.readFileSync(path.join(MIGRATIONS, file), "utf8"),
    );
    assert.equal(result.status, 0, `${db} ${file}: ${result.stderr}`);
    if (S7_MIGRATIONS.includes(file)) {
      notices[file] = [...result.stderr.matchAll(/NOTICE:\s+(.*)/g)].map(
        (match) => match[1],
      );
    }
  }
  return notices;
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
  // S7 follows S6 PS-A3, contiguous and in order, and every S7 migration is
  // registered unreviewed (sequences 42 and 43) and applied nowhere.
  // MVP-001 S8: then exactly the three S8 migrations.
  const s6 = files.indexOf(S6_LAST);
  assert.ok(s6 >= 0, "the S6 PS-A3 migration is present");
  assert.deepEqual(files.slice(s6 + 1), [...S7_MIGRATIONS, ...S8_MIGRATIONS]);
  const workItems = JSON.parse(
    fs.readFileSync(
      path.join(REPOSITORY_ROOT, "governance/work-items/index.json"),
      "utf8",
    ),
  ).work_items;
  const program = workItems.find(
    (item) => item.work_item_id === "WI-P2-MVP-001-TECHNICAL-COMPLETION",
  );
  S7_MIGRATIONS.forEach((file, index) => {
    const id = file.replace(/\.sql$/, "");
    const row = registered.find(
      (migration) => migration.artifact_path === `supabase/migrations/${file}`,
    );
    assert.ok(row, `${file} is registered`);
    assert.equal(row.migration_id, id);
    assert.equal(row.sequence, 42 + index);
    assert.equal(row.reviewed, false);
    assert.equal(row.applied_environment, "none");
    assert.ok(program.migration_refs.includes(id), `${id} is a Program ref`);
  });
  sql(ROLES, "postgres");
  sql(fixtureFor(DB), "postgres");
  sql(fixtureFor(PROD_DB), "postgres");
  assert.equal(
    sql("select count(*) from pg_available_extensions where name = 'pg_cron';"),
    "0",
    "this disposable cluster has no pg_cron",
  );
  report.migrations.notices = applyMigrationsTo(DB, files);
  applyMigrationsTo(PROD_DB, files);
  report.migrations.applied = files.length;
  report.migrations.s7 = [...S7_MIGRATIONS];
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
    const mark = `__S7_${this.label}_${this.n}__`;
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
    process.stderr.write(`[s7-proof] PASS ${name}\n`);
  } catch (error) {
    failed = true;
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
    process.stderr.write(`[s7-proof] FAIL ${name}\n${error?.stack ?? error}\n`);
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

const world = { ordinals: new Map(), slot: 0, events: 0 };

function newAccount(accountState = "active", db = DB) {
  const auth = uid();
  const user = uid();
  sql(
    `insert into auth.users (id) values ('${auth}');
     insert into public.users (id, auth_user_id, account_state) values ('${user}', '${auth}', '${accountState}');`,
    db,
  );
  return { auth, user };
}

function newJurisdiction(code, db = DB, lifecycle = "unsupported") {
  const id = uid();
  sql(
    `insert into public.jurisdictions (id, code, name, region_type, lifecycle_state) values ('${id}', '${code}', 'Synthetic ${code}', 'synthetic', '${lifecycle}');`,
    db,
  );
  return id;
}

function newRegulatoryMode(code, db = DB) {
  const id = uid();
  sql(
    `insert into public.regulatory_modes (id, code, name, status) values ('${id}', '${code}', 'Synthetic ${code}', 'synthetic');`,
    db,
  );
  return id;
}

function mapMode(jurisdiction, mode, db = DB) {
  sql(
    `insert into public.jurisdiction_regulatory_modes (jurisdiction_id, regulatory_mode_id, active_from, approval_status) values ('${jurisdiction}', '${mode}', now() - interval '1 day', 'synthetic');`,
    db,
  );
}

// Development configuration created by the owner role in this disposable
// database only (Packet rule 9): test values, never product values.
function policy(type, jurisdiction, parameters, mode = null) {
  const id = uid();
  sql(
    `insert into public.policy_versions (id, policy_type_code, jurisdiction_id, regulatory_mode_id, version_label, parameters, status, effective_from, development_only)
     values ('${id}', ${lit(type)}, ${lit(jurisdiction)}, ${lit(mode)}, ${lit(`synthetic-${type}-${id.slice(0, 8)}`)}, ${lit(parameters)}::jsonb, 'draft', now() - interval '1 hour', true);`,
  );
  return id;
}

const ELIGIBILITY = Object.freeze({
  schema: "rosuno.attorney_eligibility.v1",
  license: {
    qualifying_reported_statuses: ["synthetic-active"],
    evidence_max_age_days: 30,
  },
  insurance: {
    required: false,
    evidence_max_age_days: null,
    minimum_per_occurrence_minor: null,
    minimum_aggregate_minor: null,
    currency_code: null,
  },
  discipline: {
    disqualifying_statuses: ["synthetic-revoked"],
    cleared_statuses: ["synthetic-cleared"],
  },
  practice_area: { authorisation_required: true },
});

const SCHEDULING = (overrides = {}) => ({
  hold_response_window_seconds: 900,
  hold_pre_slot_interval_seconds: 300,
  pending_hold_cap: 500,
  minimum_notice_seconds: 3600,
  instant_request_response_window_seconds: 900,
  scheduled_request_response_window_seconds: 3600,
  ...overrides,
});

const COMPONENT = (basis, fixed = 0, minimum = null, maximum = null) => ({
  basis_points: basis,
  fixed_minor: fixed,
  minimum_minor: minimum,
  maximum_minor: maximum,
});

// A synthetic jurisdiction-scope Fee Policy (test values; XTS is the ISO
// 4217 testing code): platform fee 10%, client fee 2.5% + 50 within
// 100..2000, other required fee 1%.
const FEE = (overrides = {}) => ({
  currency_code: "XTS",
  quote_validity_seconds: 900,
  listed_price_minimum_minor: 1000,
  listed_price_maximum_minor: 100000,
  rounding: "half_up",
  platform_fee: COMPONENT(1000),
  client_fee: COMPONENT(250, 50, 100, 2000),
  other_required_fee: COMPONENT(100),
  ...overrides,
});

const PLATFORM = Object.freeze({
  permitted_durations_minutes: [30, 60],
  permitted_modalities: ["synthetic_video"],
});

// The synthetic payment_flow parameters (test configuration only; G-2/G-3
// stay configuration).
const FLOW = (instant, scheduled, capture = "at_attorney_acceptance") => ({
  instant: { authorization: instant, capture },
  scheduled: { authorization: scheduled, capture },
});
const BEFORE = "before_attorney_decision";
const AT_ACCEPTANCE = "at_attorney_acceptance";

let licenceNumber = 0;

function attorney({ name, jurisdictions = [] }) {
  const account = newAccount();
  const profile = uid();
  sql(
    `insert into public.attorney_profiles (id, user_id, profile_state, display_name, years_experience) values ('${profile}', '${account.user}', 'approved', ${lit(name)}, 7);`,
  );
  for (const jurisdiction of jurisdictions) {
    licenceNumber += 1;
    const licence = uid();
    const evidence = uid();
    sql(
      `insert into public.licenses (id, attorney_id, jurisdiction_id, license_number, reported_status) values ('${licence}', '${profile}', '${jurisdiction}', 'SYN-S7-LIC-${String(licenceNumber).padStart(4, "0")}', 'synthetic-active');
       insert into public.verification_evidence (id, jurisdiction_id, source_type, source_reference, retrieved_at, retrieved_by_user_id, evidence_summary, verification_method, discrepancy_flag)
         values ('${evidence}', '${jurisdiction}', 'synthetic register', 'synthetic entry', now() - interval '1 hour', '${world.staff.user}', 'synthetic evidence', 'synthetic lookup', false);
       insert into public.verification_evidence_subjects (verification_evidence_id, license_id) values ('${evidence}', '${licence}');`,
    );
  }
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    sql(
      `insert into public.availability_rules (attorney_id, rule_kind, timezone_name, weekday, local_start_time, local_end_time, effective_from, active)
       values ('${profile}', 'recurring', 'UTC', ${weekday}, '00:00', '24:00', current_date - 7, true);`,
    );
  }
  const session = uid();
  sql(
    `insert into public.application_sessions (id, user_id, auth_session_reference, started_at, expires_at) values ('${session}', '${account.user}', '${sha256(session)}', now() - interval '1 hour', now() + interval '3 hours');
     insert into public.instant_availability_intents (attorney_id, application_session_id, enabled_at, expires_at)
       values ('${profile}', '${session}', now(), now() + interval '2 hours');
     insert into public.attorney_consultation_offers (attorney_id, modality, duration_minutes, listed_price_minor, currency_code) values ('${profile}', 'synthetic_video', 30, 5000, 'XTS');`,
  );
  return { ...account, profile, name };
}

function newClient() {
  const account = newAccount();
  const client = uid();
  const intake = uid();
  sql(
    `insert into public.client_profiles (id, user_id) values ('${client}', '${account.user}');
     insert into public.intakes (id, client_id, state) values ('${intake}', '${client}', 'submitted');`,
  );
  return { ...account, client, intake };
}

function ownerReferral({ client, lawyer, jurisdiction, requestPath }) {
  const referral = uid();
  const evaluation = uid();
  const ordinal = (world.ordinals.get(client.intake) ?? 0) + 1;
  world.ordinals.set(client.intake, ordinal);
  const basis =
    requestPath === "scheduled"
      ? `'{"request_path": "scheduled"}'::jsonb`
      : "null";
  const presence = requestPath === "instant" ? "true" : "null";
  sql(
    `begin;
     insert into public.referrals (id, intake_id, attorney_id, jurisdiction_id, attempt_ordinal, allocation_method) values ('${referral}', '${client.intake}', '${lawyer.profile}', '${jurisdiction}', ${ordinal}, 'client_selected');
     insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, context_id, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${evaluation}', '${lawyer.profile}', '${jurisdiction}', 'jurisdiction', null, now(), '[]'::jsonb, 'eligible', '[]'::jsonb, '{}'::jsonb, now());
     insert into public.referral_eligible_pool_entries (referral_id, attorney_id, eligibility_evaluation_id, eligible_as_of) values ('${referral}', '${lawyer.profile}', '${evaluation}', now());
     insert into public.referral_presentations (referral_id, attorney_id, display_position, client_filter_context, narrowing_actor, shown_at) values ('${referral}', '${lawyer.profile}', 1, null, 'platform', now());
     insert into public.bookability_evaluations (attorney_id, eligibility_evaluation_id, context_type, context_id, evaluated_at, as_of, modality, presence_observed, availability_basis, constraint_results, result) values ('${lawyer.profile}', '${evaluation}', 'referral', '${referral}', now(), now(), 'unselected', ${presence}, ${basis}, '[]'::jsonb, 'bookable');
     commit;`,
  );
  return referral;
}

const DAY_MS = 86400000;
// The next free 30-minute slot of the synthetic attorneys (each scheduled
// Request holds its own), from the day after tomorrow on.
function nextSlot() {
  const n = world.slot;
  world.slot += 1;
  const midnight = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  return new Date(
    midnight + (2 + Math.floor(n / 40)) * DAY_MS + (n % 40) * 30 * 60000,
  ).toISOString();
}

const asClient = (client, statement) =>
  as("authenticated", client.auth, statement, { aal: "aal1" });

const rowsAsClient = (client, statement) =>
  rowsAs("authenticated", client.auth, statement, { aal: "aal1" });

// A real Request created through request_create by a new client from a new
// owner-fixture Referral.
function newRequest({ jurisdiction, requestPath = "instant", lawyer }) {
  const client = newClient();
  const referral = ownerReferral({
    client,
    lawyer: lawyer ?? world.ann,
    jurisdiction,
    requestPath,
  });
  const slot = requestPath === "scheduled" ? nextSlot() : null;
  const line = asClient(
    client,
    `select outcome || '|' || coalesce(request_id::text, '') || '|' || coalesce(problem, '') from public.request_create(${lit(referral)}, ${lit(requestPath)}, 'synthetic_video', 30, ${slot === null ? "null" : `${lit(slot)}::timestamptz`}, null::text);`,
  );
  const [outcome, request, problem] = line.split("|");
  assert.equal(outcome, "created", `request_create: ${line}`);
  return { client, referral, request, problem, jurisdiction, requestPath };
}

function authorize(client, request) {
  const line = asClient(
    client,
    `select outcome || '|' || coalesce(payment_transaction_id::text, '') || '|' || coalesce(problem, '') from public.client_authorize_payment(${lit(request)});`,
  );
  const [outcome, payment, problem] = line.split("|");
  return { outcome, payment: payment || null, problem: problem || null, line };
}

function jsonOf(statement, db = DB) {
  return JSON.parse(sql(statement, db) || "null");
}

const paymentOf = (id, db = DB) =>
  jsonOf(
    `select row_to_json(p)::text from public.payment_transactions p where id = '${id}';`,
    db,
  );

const requestStateOf = (id) =>
  sql(`select state from public.consultation_requests where id = '${id}';`);

const FINANCIAL_TABLES = Object.freeze([
  "payment_transactions",
  "ledger_entries",
  "reconciliation_exceptions",
  "external_event_receipts",
  "operational_jobs",
  "audit_events",
]);

const financialCounts = (db = DB) =>
  Object.fromEntries(
    FINANCIAL_TABLES.map((t) => [
      t,
      Number(sql(`select count(*) from public.${t};`, db)),
    ]),
  );

function openJob(type, subjectType, subjectId) {
  return (
    sql(
      `select id from public.operational_jobs where job_type = ${lit(type)} and subject_type = ${lit(subjectType)} and subject_id = '${subjectId}' and state in ('pending', 'running', 'escalated');`,
    ) || null
  );
}

// The probe plays the worker: one specific job is claimed as job_claim would
// (one more attempt, a lease), then the service role reads its context and
// records its result, and completes it.
function claimJob(jobId) {
  sql(
    `update public.operational_jobs set state = 'running', locked_at = now(), locked_by = 's7-proof', attempt_count = attempt_count + 1, available_at = now() + interval '60 seconds' where id = '${jobId}';`,
  );
}

function contextOf(jobId) {
  return JSON.parse(
    as(
      "service_role",
      null,
      `select row_to_json(c)::text from public.payment_job_context('${jobId}') c;`,
    ),
  );
}

function recordResult(jobId, observation) {
  return as(
    "service_role",
    null,
    `select public.payment_record_operation('${jobId}', ${lit(observation)}::jsonb);`,
  );
}

function completeJob(jobId) {
  return as(
    "service_role",
    null,
    `select public.job_complete('${jobId}', 's7-proof');`,
  );
}

// Runs one open payment job end to end with a simulated provider result:
// claim, context, record, complete. Answers the context and the record outcome.
function runJob(type, subjectType, subjectId, resultOf) {
  const job = openJob(type, subjectType, subjectId);
  assert.ok(job, `an open ${type} job for ${subjectId}`);
  claimJob(job);
  const context = contextOf(job);
  const observation = resultOf(context);
  const outcome = observation === null ? null : recordResult(job, observation);
  assert.equal(completeJob(job), "completed");
  return { job, context, outcome };
}

const obs = (kind, fields = {}) => ({ kind, ...fields });

// The probe plays the webhook route: one authenticated provider event.
function providerEvent(eventType, observation, eventId = null, db = DB) {
  world.events += 1;
  const id = eventId ?? `evt_synthetic_${world.events}_${uid().slice(0, 8)}`;
  const line = asIn(
    db,
    "service_role",
    null,
    `select outcome || '|' || coalesce(processing_state, '') from public.payment_record_provider_event('stripe', ${lit(id)}, ${lit(eventType)}, now(), ${lit(`sha256:${sha256(id)}`)}, ${lit(observation)}::jsonb);`,
  );
  const [outcome, processing] = line.split("|");
  return { id, outcome, processing, line };
}

// One request statement in a given database (as(), for the production one).
function asIn(db, role, sub, statement, options = {}) {
  const result = psql(
    [
      "begin;",
      ...sessionLines(role, sub, options),
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

const checkoutRef = () =>
  `cs_test_syn${uid().replaceAll("-", "").slice(0, 20)}`;
const paymentRef = () => `pi_syn${uid().replaceAll("-", "").slice(0, 20)}`;

// A payment taken to authorized through the real paths: the client's
// authorization, the checkout job and the provider's authorization event.
function authorizedPayment({ jurisdiction, requestPath = "instant" }) {
  const scenario = newRequest({ jurisdiction, requestPath });
  const created = authorize(scenario.client, scenario.request);
  assert.equal(created.outcome, "created", created.line);
  const checkout = checkoutRef();
  const run = runJob(
    "payment.checkout",
    "payment_transaction",
    created.payment,
    () => obs("checkout_open", { checkout_reference: checkout }),
  );
  assert.equal(run.outcome, "applied");
  const reference = paymentRef();
  const total = Number(
    sql(
      `select total_client_amount_minor from public.fee_calculations where consultation_request_id = '${scenario.request}';`,
    ),
  );
  const event = providerEvent(
    "payment_intent.amount_capturable_updated",
    obs("authorization_confirmed", {
      payment_transaction_id: created.payment,
      payment_reference: reference,
      amount_minor: total,
      currency_code: "XTS",
    }),
  );
  assert.equal(event.processing, "applied", event.line);
  return { ...scenario, payment: created.payment, checkout, reference, total };
}

function capturedPayment(options) {
  const p = authorizedPayment(options);
  assert.equal(
    sql(`select public.payment_request_capture('${p.payment}');`),
    "capture_requested",
  );
  const run = runJob("payment.capture", "payment_transaction", p.payment, () =>
    obs("capture_confirmed", {
      payment_reference: p.reference,
      amount_minor: p.total,
      currency_code: "XTS",
    }),
  );
  assert.equal(run.outcome, "applied");
  return p;
}

const ledgerOf = (payment) =>
  jsonOf(
    `select coalesce(json_agg(json_build_object('entry_type', entry_type, 'direction', direction, 'amount_minor', amount_minor, 'currency_code', currency_code, 'source_reference', source_reference, 'reason_code', reason_code) order by created_at, source_reference, case entry_type when 'client_payment' then 1 when 'attorney_share' then 2 when 'platform_fee' then 3 when 'client_fee' then 4 else 5 end), '[]'::json)::text from public.ledger_entries where payment_transaction_id = '${payment}';`,
  );

const exceptionsOf = (payment) =>
  jsonOf(
    `select coalesce(json_agg(json_build_object('exception_type', exception_type, 'severity', severity, 'status', status, 'source_type', source_type) order by detected_at, id), '[]'::json)::text from public.reconciliation_exceptions where canonical_id = '${payment}';`,
  );

function staffAs(statement, options = {}) {
  return as("authenticated", world.finance.auth, statement, options);
}

function staffRowsAs(account, statement, options = {}) {
  return rowsAs("authenticated", account.auth, statement, options);
}

function refund(payment, amounts, reason = "Synthetic staff refund reason") {
  const [share, platform, clientFee, other] = amounts;
  const line = staffAs(
    `select outcome || '|' || coalesce(refund_request_id::text, '') from public.staff_request_refund('${payment}', ${share}, ${platform}, ${clientFee}, ${other}, ${lit(reason)});`,
  );
  const [outcome, request] = line.split("|");
  return { outcome, request: request || null, line };
}

function seed() {
  world.mode = newRegulatoryMode("SYN_MARKETPLACE");
  world.otherMode = newRegulatoryMode("SYN_SECOND_MODE");
  const codes = {
    A: "SYN_S7_A", // complete: authorization before the decision on both paths
    B: "SYN_S7_B", // complete: authorization at the attorney's acceptance on both paths
    C: "SYN_S7_C", // no Regulatory Mode
    D: "SYN_S7_D", // two Regulatory Modes
    E: "SYN_S7_E", // a Regulatory Mode but no payment_flow version
    F: "SYN_S7_F", // a malformed payment_flow version
    G: "SYN_S7_G", // no payment version
    H: "SYN_S7_H", // no engagement version
    I: "SYN_S7_I", // no cancellation version
    K: "SYN_S7_K", // no refund version
    X: "SYN_S7_X", // complete, with a 6-second instant response window
    Z: "SYN_S7_Z", // complete, capture at_authorization
  };
  world.J = Object.fromEntries(
    Object.entries(codes).map(([key, code]) => [key, newJurisdiction(code)]),
  );
  const J = world.J;
  world.policies = {};
  world.policies.bookability = policy("bookability", null, {
    presence_window_seconds: 600,
  });
  world.platform = policy("fee", null, PLATFORM);
  for (const [key, id] of Object.entries(J)) {
    policy("eligibility", id, ELIGIBILITY);
    policy(
      "scheduling",
      id,
      key === "X"
        ? SCHEDULING({ instant_request_response_window_seconds: 6 })
        : SCHEDULING(),
    );
    world.policies[key] = {
      referral: policy("referral", id, { outcome_codes: ["synthetic_closed"] }),
      fee: policy("fee", id, FEE()),
    };
    if (key !== "C") {
      mapMode(id, world.mode);
    }
    if (key === "D") {
      mapMode(id, world.otherMode);
    }
    if (["C", "D", "E"].includes(key)) {
      continue;
    }
    const flow =
      key === "B"
        ? FLOW(AT_ACCEPTANCE, AT_ACCEPTANCE)
        : key === "Z"
          ? FLOW(BEFORE, BEFORE, "at_authorization")
          : key === "F"
            ? { instant: { authorization: BEFORE }, scheduled: {} }
            : FLOW(BEFORE, BEFORE);
    world.policies[key].payment_flow = policy(
      "payment_flow",
      id,
      flow,
      world.mode,
    );
    for (const type of ["payment", "engagement", "cancellation", "refund"]) {
      if (
        (type === "payment" && key === "G") ||
        (type === "engagement" && key === "H") ||
        (type === "cancellation" && key === "I") ||
        (type === "refund" && key === "K")
      ) {
        continue;
      }
      world.policies[key][type] = policy(type, id, {}, world.mode);
    }
  }
  world.ann = attorney({
    name: "Ann Synthetic",
    jurisdictions: Object.values(J),
  });
  world.bob = attorney({ name: "Bob Synthetic", jurisdictions: [J.A] });
  // Finance staff (a global manage_financial_operations grant) and a staff
  // member without it; each granted by another staff User.
  world.grantor = newAccount();
  sql(
    `insert into public.staff_profiles (user_id, staff_state) values ('${world.grantor.user}', 'active');`,
  );
  world.finance = newAccount();
  world.otherFinance = newAccount();
  world.plainStaff = newAccount();
  for (const member of [world.finance, world.otherFinance, world.plainStaff]) {
    sql(
      `insert into public.staff_profiles (user_id, staff_state) values ('${member.user}', 'active');`,
    );
  }
  for (const member of [world.finance, world.otherFinance]) {
    sql(
      `insert into public.capability_grants (user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at)
       values ('${member.user}', 'manage_financial_operations', '${world.grantor.user}', null, now() - interval '1 day');`,
    );
  }
  // Policy configuration staff for the approval probe.
  world.policyAdmin = newAccount();
  sql(
    `insert into public.staff_profiles (user_id, staff_state) values ('${world.policyAdmin.user}', 'active');
     insert into public.capability_grants (user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at)
       values ('${world.policyAdmin.user}', 'manage_policy_configuration', '${world.grantor.user}', null, now() - interval '1 day');`,
  );
}

async function clientSession(label, client) {
  const s = await session(label);
  const claims = JSON.stringify({
    sub: client.auth,
    role: "authenticated",
    aal: "aal1",
  });
  await s.ok("begin;");
  await s.ok("set local role authenticated;");
  await s.ok(
    `select set_config('request.jwt.claim.sub', ${lit(client.auth)}, true) is not null;`,
  );
  await s.ok(
    `select set_config('request.jwt.claims', ${lit(claims)}, true) is not null;`,
  );
  return s;
}

async function staffSession(label, account) {
  const s = await session(label);
  const claims = JSON.stringify({
    sub: account.auth,
    role: "authenticated",
    aal: "aal2",
  });
  await s.ok("begin;");
  await s.ok("set local role authenticated;");
  await s.ok(
    `select set_config('request.jwt.claim.sub', ${lit(account.auth)}, true) is not null;`,
  );
  await s.ok(
    `select set_config('request.jwt.claims', ${lit(claims)}, true) is not null;`,
  );
  return s;
}

async function serviceSession(label) {
  const s = await session(label);
  await s.ok("begin;");
  await s.ok("set local role service_role;");
  return s;
}

const lastLine = (rows) => rows[rows.length - 1];

// ---------------------------------------------------------------------------
// MIG and PRIV: migrations, catalog and privileges
// ---------------------------------------------------------------------------

const S7_DEFINER_API = Object.freeze({
  authenticated: [
    "attorney_payment_earnings()",
    "client_authorize_payment(uuid)",
    "client_payment_checkout(uuid)",
    "client_payment_receipt(uuid)",
    "client_request_payment(uuid)",
    "staff_assign_reconciliation_exception(uuid, boolean)",
    "staff_finance_exceptions(text, integer)",
    "staff_finance_ledger(uuid)",
    "staff_finance_payment(uuid)",
    "staff_finance_payments(text, integer)",
    "staff_finance_receipts(uuid)",
    "staff_request_reconciliation(uuid)",
    "staff_request_refund(uuid, bigint, bigint, bigint, bigint, text)",
    "staff_resolve_reconciliation_exception(uuid, text)",
  ],
  service_role: [
    "payment_job_context(uuid)",
    "payment_record_operation(uuid, jsonb)",
    "payment_record_provider_event(text, text, text, timestamp with time zone, text, jsonb)",
  ],
});

const S7_INTERNAL = Object.freeze([
  "external_event_receipt_lifecycle()",
  "ledger_entries_no_truncate()",
  "payment_advance_request(payment_transactions)",
  "payment_apply_observation(uuid, jsonb, text, uuid, text)",
  "payment_audit(uuid, text, text, payment_transactions, payment_transactions, text)",
  "payment_confirm_authorization(payment_transactions, text, bigint, text, text, uuid, text)",
  "payment_current_fee_calculation(uuid)",
  "payment_enqueue(text, text, uuid)",
  "payment_flow_for_path(uuid, text, timestamp with time zone)",
  "payment_flow_parameters_valid(jsonb)",
  "payment_flow_policy(uuid, uuid, timestamp with time zone)",
  "payment_job_escalated()",
  "payment_latest_refund_request(uuid)",
  "payment_observation_valid(jsonb)",
  "payment_of_job(operational_jobs)",
  "payment_open_exception(text, uuid, uuid, text, text, jsonb)",
  "payment_policy_references(payment_transactions)",
  "payment_post_capture(payment_transactions, uuid, text)",
  "payment_post_refund(payment_transactions, uuid, bigint, bigint, bigint, bigint, text)",
  "payment_refundable_components(uuid)",
  "payment_regulatory_mode(uuid, timestamp with time zone)",
  "payment_request_capture(uuid)",
  "payment_request_terminated()",
  "payment_snapshot(payment_transactions)",
  "payment_transaction_lifecycle()",
  "policy_parameters_approvable(text, uuid, jsonb)",
  "reconciliation_exception_lifecycle()",
]);

const executors = (signature) =>
  sql(
    `select coalesce(string_agg(r.rolname, ',' order by r.rolname), '') from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') and has_function_privilege(r.rolname, 'public.${signature}', 'execute');`,
  );

async function migrationChecks() {
  await check(
    "MIG-1 the two S7 migrations follow S6 PS-A3 in order, are registered unreviewed (sequences 42 and 43) and applied nowhere, are Program migration refs, and apply on plain PostgreSQL without notices, to a development and a production-class database",
    () => {
      assert.deepEqual(report.migrations.s7, [...S7_MIGRATIONS]);
      for (const file of S7_MIGRATIONS) {
        assert.deepEqual(report.migrations.notices[file], []);
      }
      return report.migrations.notices;
    },
  );

  await check(
    "MIG-2 no relation, column, type, row policy or policy type is added and public.payouts does not exist (FP-1 section 11); the S7 texts create none and insert exactly one capability catalog row, manage_financial_operations",
    () => {
      for (const file of S7_MIGRATIONS) {
        const text = fs
          .readFileSync(path.join(MIGRATIONS, file), "utf8")
          .replace(/--[^\n]*/g, "");
        assert.doesNotMatch(
          text,
          /create\s+table|add\s+column|create\s+type|create\s+policy|create\s+view|create\s+sequence|insert\s+into\s+public\.(policy_types|policy_versions|capability_grants|deployment_environment|jurisdictions|practice_areas|regulatory_modes)/i,
          file,
        );
      }
      const inserts = fs
        .readFileSync(path.join(MIGRATIONS, S7_MIGRATIONS[0]), "utf8")
        .match(/insert\s+into\s+public\.capability_definitions[^;]*;/gi);
      assert.equal(inserts.length, 1);
      assert.match(inserts[0], /'manage_financial_operations'/);
      assert.equal(
        sql(
          "select count(*) from public.capability_definitions where capability_code = 'manage_financial_operations';",
        ),
        "1",
      );
      assert.equal(sql("select to_regclass('public.payouts') is null;"), "t");
      assert.equal(
        sql(
          "select string_agg(code, ',' order by code) from public.policy_types where code like 'payment%';",
        ),
        "payment,payment_flow",
      );
      const columns = sql(
        "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'payment_transactions';",
      );
      assert.equal(
        columns,
        "id,fee_calculation_id,consultation_request_id,consultation_id,jurisdiction_id,regulatory_mode_id,referral_policy_version_id,payment_policy_version_id,fee_policy_version_id,payment_flow_policy_version_id,engagement_policy_version_id,cancellation_policy_version_id,refund_policy_version_id,state,amount_authorized_minor,amount_captured_minor,amount_refunded_minor,currency_code,provider_code,provider_payment_reference,authorized_at,captured_at,failed_at,created_at,updated_at",
      );
      for (const table of [
        "payment_transactions",
        "ledger_entries",
        "reconciliation_exceptions",
        "external_event_receipts",
      ]) {
        assert.equal(
          sql(
            `select count(*) from pg_policies where schemaname = 'public' and tablename = '${table}';`,
          ),
          "0",
          `${table} has no row policy`,
        );
      }
    },
  );

  await check(
    "PRIV-1 the four financial relations are function-only: no API role holds INSERT, UPDATE, DELETE or TRUNCATE (service_role keeps SELECT only; anon and authenticated hold none), and direct writes are refused for authenticated and service_role",
    () => {
      for (const table of [
        "payment_transactions",
        "ledger_entries",
        "reconciliation_exceptions",
        "external_event_receipts",
      ]) {
        for (const role of ["anon", "authenticated", "service_role"]) {
          for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
            assert.equal(
              sql(
                `select has_table_privilege('${role}', 'public.${table}', '${privilege}');`,
              ),
              "f",
              `${role} ${privilege} ${table}`,
            );
          }
          assert.equal(
            sql(
              `select has_any_column_privilege('${role}', 'public.${table}', 'UPDATE');`,
            ),
            "f",
          );
          assert.equal(
            sql(
              `select has_table_privilege('${role}', 'public.${table}', 'SELECT');`,
            ),
            role === "service_role" ? "t" : "f",
            `${role} SELECT ${table}`,
          );
        }
      }
      for (const role of ["authenticated", "service_role"]) {
        assert.equal(
          as(
            role,
            role === "service_role" ? null : world.finance.auth,
            "update public.payment_transactions set state = 'captured';",
          ),
          "ERROR 42501",
        );
        assert.equal(
          as(
            role,
            role === "service_role" ? null : world.finance.auth,
            "insert into public.ledger_entries (payment_transaction_id, entry_type, direction, amount_minor, currency_code, effective_at, source_reference, reason_code) values (gen_random_uuid(), 'client_payment', 'debit', 1, 'XTS', now(), 'capture:00000000-0000-0000-0000-000000000000', 'payment_captured');",
          ),
          "ERROR 42501",
        );
      }
    },
  );

  await check(
    "PRIV-2 function privileges: the client, attorney and staff functions are security definer and executable by authenticated only; the worker and webhook functions by service_role only; every internal and trigger function by no API role; anon executes nothing S7 adds; request_create keeps its authenticated-only grant",
    () => {
      for (const signature of S7_DEFINER_API.authenticated) {
        assert.equal(executors(signature), "authenticated", signature);
        assert.equal(
          sql(
            `select prosecdef from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          "t",
          signature,
        );
      }
      for (const signature of S7_DEFINER_API.service_role) {
        assert.equal(executors(signature), "service_role", signature);
      }
      for (const signature of S7_INTERNAL) {
        assert.equal(executors(signature), "", signature);
      }
      assert.equal(
        executors(
          "request_create(uuid, text, text, integer, timestamp with time zone, text)",
        ),
        "authenticated",
      );
      assert.equal(
        as(
          "anon",
          null,
          "select public.client_request_payment(gen_random_uuid());",
        ),
        "ERROR 42501",
      );
      // Every S7 definer pins its search_path.
      assert.equal(
        sql(
          "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and (p.proname like 'payment%' or p.proname like 'staff_finance%' or p.proname like 'client_%payment%' or p.proname like 'staff_%reconciliation%' or p.proname = 'staff_request_refund' or p.proname = 'attorney_payment_earnings') and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%');",
        ),
        "0",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// FLOW: the payment_flow schema, approval validation and the seam
// ---------------------------------------------------------------------------

async function flowChecks() {
  await check(
    "FLOW-1 the payment_flow schema: exactly instant and scheduled, each exactly authorization (before_attorney_decision | at_attorney_acceptance) and capture (at_authorization | at_attorney_acceptance | at_consultation_start | at_consultation_completion); anything else is invalid and a reader answers policy_incomplete (no default)",
    () => {
      const valid = (value) =>
        sql(
          `select public.payment_flow_parameters_valid(${lit(value)}::jsonb);`,
        );
      assert.equal(valid(FLOW(BEFORE, AT_ACCEPTANCE)), "t");
      assert.equal(
        valid(FLOW(AT_ACCEPTANCE, BEFORE, "at_consultation_completion")),
        "t",
      );
      for (const bad of [
        {},
        { instant: FLOW(BEFORE, BEFORE).instant },
        { ...FLOW(BEFORE, BEFORE), extra: 1 },
        FLOW("always", BEFORE),
        FLOW(BEFORE, BEFORE, "never"),
        {
          instant: { authorization: BEFORE },
          scheduled: { authorization: BEFORE, capture: "at_authorization" },
        },
        {
          instant: { authorization: BEFORE, capture: "at_authorization", x: 1 },
          scheduled: { authorization: BEFORE, capture: "at_authorization" },
        },
        [],
        "42",
      ]) {
        assert.equal(valid(bad), "f", JSON.stringify(bad));
      }
      const reader = jsonOf(
        `select row_to_json(f)::text from public.payment_flow_policy('${world.J.F}', '${world.mode}', now()) f;`,
      );
      assert.equal(reader.outcome, "policy_incomplete");
      assert.equal(reader.parameters, null);
    },
  );

  await check(
    "FLOW-2 approval validation (PS section 8.4): staff approval of a payment_flow version outside the schema answers parameters_invalid and leaves it in counsel_review; a valid one is approved",
    () => {
      const approval = (parameters) => {
        const id = uid();
        sql(
          `insert into public.policy_versions (id, policy_type_code, jurisdiction_id, regulatory_mode_id, version_label, parameters, status, effective_from, development_only)
           values ('${id}', 'payment_flow', '${world.J.A}', '${world.mode}', ${lit(`synthetic-approval-${id.slice(0, 8)}`)}, ${lit(parameters)}::jsonb, 'draft', now() + interval '30 days', false);
           insert into public.policy_authority_references (policy_version_id, authority_type, citation_text, source_title, retrieved_at, verified_by_user_id, verification_status)
             values ('${id}', 'synthetic', 'synthetic citation', 'synthetic source', now(), '${world.grantor.user}', 'verified');
           update public.policy_versions set status = 'internal_review' where id = '${id}';
           update public.policy_versions set status = 'counsel_review' where id = '${id}';`,
        );
        const updated = sql(
          `select updated_at from public.policy_versions where id = '${id}';`,
        );
        const outcome = as(
          "authenticated",
          world.policyAdmin.auth,
          `select public.staff_transition_policy_version('${id}', ${lit(updated)}::timestamptz, 'approved');`,
        );
        return {
          outcome,
          status: sql(
            `select status from public.policy_versions where id = '${id}';`,
          ),
        };
      };
      assert.deepEqual(approval({ instant: {} }), {
        outcome: "parameters_invalid",
        status: "counsel_review",
      });
      assert.deepEqual(approval(FLOW(BEFORE, AT_ACCEPTANCE)), {
        outcome: "applied",
        status: "approved",
      });
    },
  );

  await check(
    "SEAM-1 (PM rows 1, 6; G-2/G-3) authorization at the attorney's acceptance: a scheduled Request moves slot_held -> awaiting_attorney at creation with the payment_flow version in its audit event, no payment is asked for (not_required, step not_applicable), and an instant Request stays created (DM section 9 has no path without payment_authorized)",
    () => {
      const scheduled = newRequest({
        jurisdiction: world.J.B,
        requestPath: "scheduled",
      });
      assert.equal(requestStateOf(scheduled.request), "awaiting_attorney");
      const audit = jsonOf(
        `select row_to_json(a)::text from public.audit_events a where action_code = 'consultation_request.created' and resource_id = '${scheduled.request}';`,
      );
      assert.equal(audit.after_snapshot.state, "awaiting_attorney");
      assert.ok(
        audit.policy_references.some(
          (r) =>
            r.policy_type_code === "payment_flow" &&
            r.policy_version_id === world.policies.B.payment_flow,
        ),
      );
      assert.equal(
        authorize(scheduled.client, scheduled.request).outcome,
        "not_payable",
      );
      const instant = newRequest({ jurisdiction: world.J.B });
      assert.equal(requestStateOf(instant.request), "created");
      const before = financialCounts();
      assert.equal(
        authorize(instant.client, instant.request).outcome,
        "not_required",
      );
      assert.deepEqual(financialCounts(), before);
      const step = JSON.parse(
        asClient(
          instant.client,
          `select row_to_json(s)::text from public.client_request_payment('${instant.request}') s;`,
        ),
      );
      assert.equal(step.payment_step, "not_required_now");
      assert.equal(step.payable, false);
      assert.equal(step.payment_transaction_id, null);
    },
  );

  await check(
    "SEAM-2 (PM rows 1, 6) authorization before the attorney decision: both paths wait in their pre-decision state (instant created, scheduled slot_held) with step authorization_required; with no selectable flow (no Regulatory Mode, two modes, no version, a malformed version) the step is unavailable, nothing can be created and the Request stays where S6 leaves it",
    () => {
      for (const requestPath of ["instant", "scheduled"]) {
        const s = newRequest({ jurisdiction: world.J.A, requestPath });
        assert.equal(
          requestStateOf(s.request),
          requestPath === "instant" ? "created" : "slot_held",
        );
        const step = JSON.parse(
          asClient(
            s.client,
            `select row_to_json(s)::text from public.client_request_payment('${s.request}') s;`,
          ),
        );
        assert.equal(step.payment_step, "authorization_required");
        assert.equal(step.payable, true);
        assert.equal(step.total_client_amount_minor, 5225);
        assert.equal(step.currency_code, "XTS");
      }
      for (const key of ["C", "D", "E", "F"]) {
        for (const requestPath of ["instant", "scheduled"]) {
          const s = newRequest({ jurisdiction: world.J[key], requestPath });
          assert.equal(
            requestStateOf(s.request),
            requestPath === "instant" ? "created" : "slot_held",
          );
          const step = JSON.parse(
            asClient(
              s.client,
              `select row_to_json(s)::text from public.client_request_payment('${s.request}') s;`,
            ),
          );
          assert.equal(step.payment_step, "unavailable", key);
        }
      }
    },
  );
}

// ---------------------------------------------------------------------------
// FP1: provenance
// ---------------------------------------------------------------------------

async function provenanceChecks() {
  await check(
    "FP1-1 (PM INV-7, INV-9; FP-1 sections 2-8) a created payment records the Request's jurisdiction, its single active Regulatory Mode, the Request's referral version, the current Fee Calculation's fee version, currency and total, and the payment, payment_flow, engagement, cancellation and refund versions selected for that jurisdiction and mode; one client audit event carries all seven references; the checkout job is enqueued; a second call answers pending",
    () => {
      const s = newRequest({ jurisdiction: world.J.A });
      const before = financialCounts();
      const created = authorize(s.client, s.request);
      assert.equal(created.outcome, "created", created.line);
      const p = paymentOf(created.payment);
      const fee = jsonOf(
        `select row_to_json(c)::text from public.fee_calculations c where consultation_request_id = '${s.request}';`,
      );
      const P = world.policies.A;
      assert.equal(p.state, "pending_authorization");
      assert.equal(p.jurisdiction_id, world.J.A);
      assert.equal(p.regulatory_mode_id, world.mode);
      assert.equal(p.referral_policy_version_id, P.referral);
      assert.equal(p.fee_policy_version_id, P.fee);
      assert.equal(p.fee_calculation_id, fee.id);
      assert.equal(p.payment_policy_version_id, P.payment);
      assert.equal(p.payment_flow_policy_version_id, P.payment_flow);
      assert.equal(p.engagement_policy_version_id, P.engagement);
      assert.equal(p.cancellation_policy_version_id, P.cancellation);
      assert.equal(p.refund_policy_version_id, P.refund);
      assert.equal(p.currency_code, fee.currency_code);
      assert.equal(p.provider_code, "stripe");
      assert.equal(p.provider_payment_reference, null);
      assert.equal(p.amount_refunded_minor, 0);
      const after = financialCounts();
      assert.equal(after.payment_transactions, before.payment_transactions + 1);
      assert.equal(after.audit_events, before.audit_events + 1);
      assert.equal(after.operational_jobs, before.operational_jobs + 1);
      const audit = jsonOf(
        `select row_to_json(a)::text from public.audit_events a where resource_id = '${created.payment}';`,
      );
      assert.equal(audit.actor_type, "client");
      assert.equal(audit.action_code, "payment.created");
      assert.deepEqual(
        audit.policy_references.map((r) => r.policy_type_code).sort(),
        [
          "cancellation",
          "engagement",
          "fee",
          "payment",
          "payment_flow",
          "referral",
          "refund",
        ],
      );
      assert.ok(
        openJob("payment.checkout", "payment_transaction", created.payment),
      );
      const again = authorize(s.client, s.request);
      assert.deepEqual(
        [again.outcome, again.payment],
        ["pending", created.payment],
      );
      assert.deepEqual(financialCounts(), after);
    },
  );

  await check(
    "FP1-2 (FP-1 section 3; PM INV-11) any missing provenance fails honestly and creates nothing: no Regulatory Mode, two Regulatory Modes, no payment_flow version, a malformed one, no payment, engagement, cancellation or refund version each answer policy_unavailable with the missing piece",
    () => {
      const expected = {
        C: "regulatory_mode_unavailable",
        D: "regulatory_mode_conflict",
        E: "payment_flow_no_applicable_policy",
        F: "payment_flow_policy_incomplete",
        G: "payment_no_applicable_policy",
        H: "engagement_no_applicable_policy",
        I: "cancellation_no_applicable_policy",
        K: "refund_no_applicable_policy",
      };
      const answers = {};
      for (const [key, problem] of Object.entries(expected)) {
        const s = newRequest({ jurisdiction: world.J[key] });
        const before = financialCounts();
        const answer = authorize(s.client, s.request);
        answers[key] = answer.line;
        assert.deepEqual(
          [answer.outcome, answer.problem],
          ["policy_unavailable", problem],
        );
        assert.deepEqual(financialCounts(), before, key);
      }
      return answers;
    },
  );

  await check(
    "FP1-3 (FP-1 sections 4-8; PS section 33) the database refuses, for every role including the owner, a payment whose currency differs from its Fee Calculation, whose policy has the wrong type, whose Regulatory Mode mapping is not active, or whose referral version differs from the Request's",
    () => {
      const s = newRequest({ jurisdiction: world.J.A });
      const fee = sql(
        `select id from public.fee_calculations where consultation_request_id = '${s.request}';`,
      );
      const P = world.policies.A;
      const insert = (overrides) => {
        const v = {
          currency: "'XTS'",
          mode: `'${world.mode}'`,
          referral: `'${P.referral}'`,
          payment: `'${P.payment}'`,
          ...overrides,
        };
        return refused(
          `insert into public.payment_transactions (fee_calculation_id, consultation_request_id, jurisdiction_id, regulatory_mode_id, referral_policy_version_id, payment_policy_version_id, fee_policy_version_id, payment_flow_policy_version_id, engagement_policy_version_id, cancellation_policy_version_id, refund_policy_version_id, state, currency_code, provider_code)
           values ('${fee}', '${s.request}', '${world.J.A}', ${v.mode}, ${v.referral}, ${v.payment}, '${P.fee}', '${P.payment_flow}', '${P.engagement}', '${P.cancellation}', '${P.refund}', 'pending_authorization', ${v.currency}, 'stripe');`,
        );
      };
      assert.equal(insert({ currency: "'XXX'" }), "23514");
      assert.equal(insert({ payment: `'${P.refund}'` }), "23514");
      assert.equal(insert({ mode: `'${world.otherMode}'` }), "23514");
      assert.equal(
        insert({ referral: `'${world.policies.B.referral}'` }),
        "23514",
      );
      acceptedThenRolledBack(
        `insert into public.payment_transactions (fee_calculation_id, consultation_request_id, jurisdiction_id, regulatory_mode_id, referral_policy_version_id, payment_policy_version_id, fee_policy_version_id, payment_flow_policy_version_id, engagement_policy_version_id, cancellation_policy_version_id, refund_policy_version_id, state, currency_code, provider_code)
         values ('${fee}', '${s.request}', '${world.J.A}', '${world.mode}', '${P.referral}', '${P.payment}', '${P.fee}', '${P.payment_flow}', '${P.engagement}', '${P.cancellation}', '${P.refund}', 'pending_authorization', 'XTS', 'stripe');`,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// LIFE: the payment lifecycle guard for every role
// ---------------------------------------------------------------------------

async function lifecycleChecks() {
  await check(
    "LIFE-1 (PS sections 32-33) the payment guard holds for every role, the owner included: created only pending_authorization without provider facts; transitions only along the S7 lifecycle; provider facts recorded once; captured never above authorized and refunded never above captured; the refunded amount only grows while a refund is pending; terminal states never change; never deleted or truncated; FP-1 provenance immutable",
    () => {
      const p = capturedPayment({ jurisdiction: world.J.A });
      const id = p.payment;
      const s = newRequest({ jurisdiction: world.J.A });
      const pending = authorize(s.client, s.request).payment;
      const P = world.policies.A;
      const fee = sql(
        `select id from public.fee_calculations where consultation_request_id = '${s.request}';`,
      );
      assert.equal(
        refused(
          `insert into public.payment_transactions (fee_calculation_id, consultation_request_id, jurisdiction_id, regulatory_mode_id, referral_policy_version_id, payment_policy_version_id, fee_policy_version_id, payment_flow_policy_version_id, engagement_policy_version_id, cancellation_policy_version_id, refund_policy_version_id, state, currency_code, provider_code)
           values ('${fee}', '${s.request}', '${world.J.A}', '${world.mode}', '${P.referral}', '${P.payment}', '${P.fee}', '${P.payment_flow}', '${P.engagement}', '${P.cancellation}', '${P.refund}', 'authorized', 'XTS', 'stripe');`,
        ),
        "23514",
      );
      const updates = {
        "pending -> captured": [
          `update public.payment_transactions set state = 'captured' where id = '${pending}';`,
          "55000",
        ],
        "pending -> capture_pending": [
          `update public.payment_transactions set state = 'capture_pending' where id = '${pending}';`,
          "55000",
        ],
        "captured -> authorized": [
          `update public.payment_transactions set state = 'authorized' where id = '${id}';`,
          "55000",
        ],
        "captured amount changed": [
          `update public.payment_transactions set amount_captured_minor = 1 where id = '${id}';`,
          "55000",
        ],
        "authorized time changed": [
          `update public.payment_transactions set authorized_at = now() where id = '${id}';`,
          "55000",
        ],
        "refund outside refund_pending": [
          `update public.payment_transactions set amount_refunded_minor = 1 where id = '${id}';`,
          "55000",
        ],
        "reference replaced": [
          `update public.payment_transactions set provider_payment_reference = 'pi_synother000000000' where id = '${id}';`,
          "55000",
        ],
        "provenance changed": [
          `update public.payment_transactions set refund_policy_version_id = '${P.payment}' where id = '${id}';`,
          "23514",
        ],
        "currency changed": [
          `update public.payment_transactions set currency_code = 'XXX' where id = '${id}';`,
          "23514",
        ],
        delete: [
          `delete from public.payment_transactions where id = '${id}';`,
          "55000",
        ],
        truncate: ["truncate public.payment_transactions cascade;", "55000"],
        "state outside the lifecycle": [
          `update public.payment_transactions set state = 'paid' where id = '${pending}';`,
          "55000",
        ],
      };
      const answers = {};
      for (const [name, [statement, code]] of Object.entries(updates)) {
        answers[name] = refused(statement);
        assert.equal(answers[name], code, name);
      }
      // refunded above captured, through a pending refund (owner path).
      const r = refund(id, [4500, 0, 0, 0]);
      assert.equal(r.outcome, "requested");
      assert.equal(
        refused(
          `update public.payment_transactions set amount_refunded_minor = 999999, state = 'partially_refunded' where id = '${id}';`,
        ),
        "23514",
      );
      // A terminal payment never changes.
      const failed = newRequest({ jurisdiction: world.J.A });
      const f = authorize(failed.client, failed.request).payment;
      providerEvent(
        "payment_intent.payment_failed",
        obs("authorization_failed", { payment_transaction_id: f }),
      );
      assert.equal(paymentOf(f).state, "failed");
      assert.equal(
        refused(
          `update public.payment_transactions set provider_payment_reference = 'cs_test_synlate0000000' where id = '${f}';`,
        ),
        "55000",
      );
      assert.equal(
        refused(
          `update public.payment_transactions set state = 'cancelled' where id = '${f}';`,
        ),
        "55000",
      );
      return answers;
    },
  );
}

// ---------------------------------------------------------------------------
// AUTH: authorization success and failure
// ---------------------------------------------------------------------------

async function authorizationChecks() {
  await check(
    "AUTH-1 (IMP section 23 success; PM INV-1, INV-8, INV-14) the hosted checkout is recorded by the checkout job; a confirmed authorization of exactly the total moves the payment to authorized (the payment reference replaces the checkout reference) and the Request along DM section 9 in the same transaction (instant created -> payment_authorized -> awaiting_attorney, scheduled slot_held -> awaiting_attorney); no Consultation or Engagement is created",
    () => {
      for (const requestPath of ["instant", "scheduled"]) {
        const s = newRequest({ jurisdiction: world.J.A, requestPath });
        const created = authorize(s.client, s.request);
        const checkout = checkoutRef();
        const job = openJob(
          "payment.checkout",
          "payment_transaction",
          created.payment,
        );
        claimJob(job);
        const context = contextOf(job);
        assert.equal(context.outcome, "act");
        assert.equal(context.operation, "checkout");
        assert.equal(context.amount_minor, 5225);
        assert.equal(context.currency_code, "XTS");
        assert.equal(context.reference_kind, "none");
        assert.ok(context.checkout_expires_at);
        assert.equal(
          recordResult(
            job,
            obs("checkout_open", { checkout_reference: checkout }),
          ),
          "applied",
        );
        assert.equal(completeJob(job), "completed");
        assert.equal(
          paymentOf(created.payment).provider_payment_reference,
          checkout,
        );
        const checkoutRead = JSON.parse(
          asClient(
            s.client,
            `select row_to_json(c)::text from public.client_payment_checkout('${created.payment}') c;`,
          ),
        );
        assert.deepEqual(
          [checkoutRead.outcome, checkoutRead.checkout_reference],
          ["ready", checkout],
        );
        const reference = paymentRef();
        const consultations = Number(
          sql("select count(*) from public.consultations;"),
        );
        const event = providerEvent(
          "payment_intent.amount_capturable_updated",
          obs("authorization_confirmed", {
            payment_transaction_id: created.payment,
            payment_reference: reference,
            amount_minor: 5225,
            currency_code: "XTS",
          }),
        );
        assert.deepEqual(
          [event.outcome, event.processing],
          ["recorded", "applied"],
        );
        const p = paymentOf(created.payment);
        assert.equal(p.state, "authorized");
        assert.equal(p.amount_authorized_minor, 5225);
        assert.equal(p.provider_payment_reference, reference);
        assert.equal(requestStateOf(s.request), "awaiting_attorney");
        assert.equal(
          Number(sql("select count(*) from public.consultations;")),
          consultations,
        );
        const moved = jsonOf(
          `select row_to_json(a)::text from public.audit_events a where resource_id = '${s.request}' and action_code = 'consultation_request.payment_authorized';`,
        );
        assert.equal(moved.after_snapshot.state, "awaiting_attorney");
        assert.equal(
          moved.before_snapshot.state,
          requestPath === "instant" ? "created" : "slot_held",
        );
      }
    },
  );

  await check(
    "AUTH-2 (IMP section 23 authorization failure; MBS section 12; PM row 26) an authorization failure fails honestly: the payment becomes failed, the checkout release is enqueued, the Request is unchanged and the client sees the failure and may start a new attempt, which records a new payment with fresh provenance",
    () => {
      const s = newRequest({ jurisdiction: world.J.A });
      const first = authorize(s.client, s.request).payment;
      runJob("payment.checkout", "payment_transaction", first, () =>
        obs("checkout_open", { checkout_reference: checkoutRef() }),
      );
      const event = providerEvent(
        "payment_intent.payment_failed",
        obs("authorization_failed", {
          payment_transaction_id: first,
          payment_reference: paymentRef(),
        }),
      );
      assert.equal(event.processing, "applied");
      const p = paymentOf(first);
      assert.equal(p.state, "failed");
      assert.ok(p.failed_at);
      assert.equal(requestStateOf(s.request), "created");
      assert.ok(openJob("payment.release", "payment_transaction", first));
      const step = JSON.parse(
        asClient(
          s.client,
          `select row_to_json(s)::text from public.client_request_payment('${s.request}') s;`,
        ),
      );
      assert.deepEqual([step.payment_state, step.payable], ["failed", true]);
      const release = runJob(
        "payment.release",
        "payment_transaction",
        first,
        (c) => {
          assert.equal(c.outcome, "act");
          assert.equal(c.reference_kind, "checkout");
          return obs("checkout_expired", {
            checkout_reference: c.provider_reference,
          });
        },
      );
      assert.equal(release.outcome, "no_effect");
      const second = authorize(s.client, s.request);
      assert.equal(second.outcome, "created");
      assert.notEqual(second.payment, first);
      assert.equal(paymentOf(first).state, "failed");
    },
  );

  await check(
    "AUTH-3 (PM INV-11) an authorization of another amount or currency is recorded, released and opens a critical amount_mismatch exception; the Request does not move",
    () => {
      const s = newRequest({ jurisdiction: world.J.A });
      const id = authorize(s.client, s.request).payment;
      runJob("payment.checkout", "payment_transaction", id, () =>
        obs("checkout_open", { checkout_reference: checkoutRef() }),
      );
      const event = providerEvent(
        "payment_intent.amount_capturable_updated",
        obs("authorization_confirmed", {
          payment_transaction_id: id,
          payment_reference: paymentRef(),
          amount_minor: 5224,
          currency_code: "XTS",
        }),
      );
      assert.equal(event.processing, "contradiction");
      const p = paymentOf(id);
      assert.equal(p.state, "release_pending");
      assert.equal(p.amount_authorized_minor, 5224);
      assert.equal(requestStateOf(s.request), "created");
      assert.deepEqual(
        exceptionsOf(id).map((e) => [e.exception_type, e.severity, e.status]),
        [["amount_mismatch", "critical", "open"]],
      );
      const release = runJob(
        "payment.release",
        "payment_transaction",
        id,
        (c) => {
          assert.equal(c.reference_kind, "payment");
          return obs("authorization_released", {
            payment_reference: c.provider_reference,
          });
        },
      );
      assert.equal(release.outcome, "applied");
      assert.equal(paymentOf(id).state, "authorization_released");
    },
  );
}

// ---------------------------------------------------------------------------
// CAP, REF, LED: capture, refund and the ledger
// ---------------------------------------------------------------------------

async function captureChecks() {
  await check(
    "CAP-1 (PM INV-3; PS section 22.3) payment_request_capture (for S8) moves an authorized payment to capture_pending and enqueues the capture; a confirmed capture of the total posts client_payment debit 5225 against attorney_share 4500, platform_fee 500, client_fee 175 and other_required_fee 50 credits, balanced, in the payment's currency, once; a non-authorized payment answers not_authorized",
    () => {
      const p = authorizedPayment({ jurisdiction: world.J.A });
      assert.equal(
        sql(`select public.payment_request_capture('${p.payment}');`),
        "capture_requested",
      );
      assert.equal(paymentOf(p.payment).state, "capture_pending");
      assert.equal(
        sql(`select public.payment_request_capture('${p.payment}');`),
        "not_authorized",
      );
      const run = runJob(
        "payment.capture",
        "payment_transaction",
        p.payment,
        (c) => {
          assert.deepEqual(
            [
              c.outcome,
              c.operation,
              c.reference_kind,
              c.provider_reference,
              c.amount_minor,
            ],
            ["act", "capture", "payment", p.reference, 5225],
          );
          return obs("capture_confirmed", {
            payment_reference: p.reference,
            amount_minor: 5225,
            currency_code: "XTS",
          });
        },
      );
      assert.equal(run.outcome, "applied");
      const payment = paymentOf(p.payment);
      assert.deepEqual(
        [
          payment.state,
          payment.amount_captured_minor,
          payment.amount_refunded_minor,
        ],
        ["captured", 5225, 0],
      );
      const ledger = ledgerOf(p.payment);
      assert.deepEqual(
        ledger.map((l) => [l.entry_type, l.direction, l.amount_minor]),
        [
          ["client_payment", "debit", 5225],
          ["attorney_share", "credit", 4500],
          ["platform_fee", "credit", 500],
          ["client_fee", "credit", 175],
          ["other_required_fee", "credit", 50],
        ],
      );
      assert.ok(ledger.every((l) => l.currency_code === "XTS"));
      assert.ok(
        ledger.every(
          (l) =>
            l.source_reference === `capture:${p.payment}` &&
            l.reason_code === "payment_captured",
        ),
      );
      // A duplicate capture confirmation (the provider's own event) posts nothing.
      const duplicate = providerEvent(
        "payment_intent.succeeded",
        obs("capture_confirmed", {
          payment_reference: p.reference,
          amount_minor: 5225,
          currency_code: "XTS",
        }),
      );
      assert.equal(duplicate.processing, "no_effect");
      assert.equal(ledgerOf(p.payment).length, 5);
      assert.equal(
        sql(`select public.payment_request_capture(gen_random_uuid());`),
        "not_found",
      );
    },
  );

  await check(
    "CAP-2 (IMP section 23 capture failure; MBS section 12; PM row 27) a definitive capture failure moves the payment to capture_failed with a high capture_failed Reconciliation Exception for human resolution; no ledger entry is posted",
    () => {
      const p = authorizedPayment({ jurisdiction: world.J.A });
      sql(`select public.payment_request_capture('${p.payment}');`);
      const run = runJob(
        "payment.capture",
        "payment_transaction",
        p.payment,
        () => obs("capture_refused", { payment_reference: p.reference }),
      );
      assert.equal(run.outcome, "applied");
      const payment = paymentOf(p.payment);
      assert.equal(payment.state, "capture_failed");
      assert.ok(payment.failed_at);
      assert.equal(payment.amount_captured_minor, null);
      assert.deepEqual(
        exceptionsOf(p.payment).map((e) => [
          e.exception_type,
          e.severity,
          e.status,
          e.source_type,
        ]),
        [["capture_failed", "high", "open", "operational_job"]],
      );
      assert.equal(ledgerOf(p.payment).length, 0);
    },
  );

  await check(
    "CAP-3 (PM rows 1, 6; G-2) capture at_authorization: a confirmed authorization requests the capture in the same transaction (capture_pending and the capture job)",
    () => {
      const p = authorizedPayment({ jurisdiction: world.J.Z });
      assert.equal(paymentOf(p.payment).state, "capture_pending");
      assert.ok(openJob("payment.capture", "payment_transaction", p.payment));
      assert.equal(requestStateOf(p.request), "awaiting_attorney");
    },
  );
}

async function refundChecks() {
  await check(
    "REF-1 (IMP section 23 refund; MBS section 12; PM rows 28, 29; PS section 22.3) a staff refund records the request (staff audit event with the allocation, the reason and the refund policy version), moves the payment to refund_pending and enqueues the refund; a confirmed refund appends reversal entries and never edits the capture postings; partial then full refund reach partially_refunded and fully_refunded",
    () => {
      const p = capturedPayment({ jurisdiction: world.J.A });
      const capturePostings = ledgerOf(p.payment);
      const first = refund(p.payment, [1000, 100, 0, 0]);
      assert.equal(first.outcome, "requested", first.line);
      assert.equal(paymentOf(p.payment).state, "refund_pending");
      const audit = jsonOf(
        `select row_to_json(a)::text from public.audit_events a where id = '${first.request}';`,
      );
      assert.equal(audit.actor_type, "staff");
      assert.equal(audit.action_code, "payment.refund_requested");
      assert.equal(audit.after_snapshot.amount_minor, 1100);
      assert.equal(
        audit.after_snapshot.reason,
        "Synthetic staff refund reason",
      );
      assert.deepEqual(audit.policy_references, [
        {
          policy_type_code: "refund",
          policy_version_id: world.policies.A.refund,
        },
      ]);
      const run = runJob(
        "payment.refund",
        "payment_refund_request",
        first.request,
        (c) => {
          assert.deepEqual(
            [
              c.outcome,
              c.operation,
              c.amount_minor,
              c.refund_request_id,
              c.provider_reference,
            ],
            ["act", "refund", 1100, first.request, p.reference],
          );
          return obs("refund_confirmed", {
            payment_reference: p.reference,
            refund_reference: "re_synthetic_first",
            refund_request_id: first.request,
            amount_minor: 1100,
            currency_code: "XTS",
          });
        },
      );
      assert.equal(run.outcome, "applied");
      let payment = paymentOf(p.payment);
      assert.deepEqual(
        [payment.state, payment.amount_refunded_minor],
        ["partially_refunded", 1100],
      );
      const afterFirst = ledgerOf(p.payment);
      assert.deepEqual(afterFirst.slice(0, 5), capturePostings);
      assert.deepEqual(
        afterFirst
          .slice(5)
          .map((l) => [
            l.entry_type,
            l.direction,
            l.amount_minor,
            l.reason_code,
          ]),
        [
          ["client_payment", "credit", 1100, "payment_refunded"],
          ["attorney_share", "debit", 1000, "payment_refunded"],
          ["platform_fee", "debit", 100, "payment_refunded"],
        ],
      );
      // More than what remains of a component is refused, and nothing changes.
      assert.equal(
        refund(p.payment, [3501, 0, 0, 0]).outcome,
        "exceeds_refundable",
      );
      const second = refund(p.payment, [3500, 400, 175, 50]);
      assert.equal(second.outcome, "requested");
      // The provider's refund event confirms it first; the worker's later result has no effect.
      const event = providerEvent(
        "refund.updated",
        obs("refund_observed", {
          payment_reference: p.reference,
          refund_reference: "re_synthetic_second",
          refund_request_id: second.request,
          amount_minor: 4125,
          currency_code: "XTS",
          provider_status: "succeeded",
        }),
      );
      assert.equal(event.processing, "applied");
      const late = runJob(
        "payment.refund",
        "payment_refund_request",
        second.request,
        (c) => {
          assert.equal(c.outcome, "nothing_to_do");
          return obs("refund_confirmed", {
            payment_reference: p.reference,
            refund_reference: "re_synthetic_second",
            refund_request_id: second.request,
            amount_minor: 4125,
            currency_code: "XTS",
          });
        },
      );
      assert.equal(late.outcome, "no_effect");
      payment = paymentOf(p.payment);
      assert.deepEqual(
        [payment.state, payment.amount_refunded_minor],
        ["fully_refunded", 5225],
      );
      assert.equal(ledgerOf(p.payment).length, 5 + 3 + 5);
      assert.equal(refund(p.payment, [0, 0, 1, 0]).outcome, "not_refundable");
      const net = jsonOf(
        `select json_object_agg(entry_type, total)::text from (select entry_type, sum(case direction when 'credit' then amount_minor else -amount_minor end) as total from public.ledger_entries where payment_transaction_id = '${p.payment}' group by entry_type) x;`,
      );
      assert.deepEqual(net, {
        client_payment: 0,
        attorney_share: 0,
        platform_fee: 0,
        client_fee: 0,
        other_required_fee: 0,
      });
    },
  );

  await check(
    "REF-2 (PM INV-11) a refused refund returns the payment to its previous state with a high refund_failed exception; an unexpected provider refund (one Rosuno never asked for) opens a critical exception and changes nothing; a refund is refused while another is pending, and for invalid input",
    () => {
      const p = capturedPayment({ jurisdiction: world.J.A });
      const r = refund(p.payment, [100, 0, 0, 0]);
      assert.equal(
        refund(p.payment, [100, 0, 0, 0]).outcome,
        "refund_in_progress",
      );
      const run = runJob(
        "payment.refund",
        "payment_refund_request",
        r.request,
        () =>
          obs("refund_refused", {
            payment_reference: p.reference,
            refund_request_id: r.request,
          }),
      );
      assert.equal(run.outcome, "applied");
      assert.equal(paymentOf(p.payment).state, "captured");
      assert.deepEqual(
        exceptionsOf(p.payment).map((e) => e.exception_type),
        ["refund_failed"],
      );
      const unexpected = providerEvent(
        "refund.created",
        obs("refund_observed", {
          payment_reference: p.reference,
          refund_reference: "re_synthetic_dashboard",
          amount_minor: 200,
          currency_code: "XTS",
          provider_status: "succeeded",
        }),
      );
      assert.equal(unexpected.processing, "contradiction");
      assert.deepEqual(paymentOf(p.payment).amount_refunded_minor, 0);
      assert.deepEqual(
        exceptionsOf(p.payment).map((e) => [e.exception_type, e.severity]),
        [
          ["refund_failed", "high"],
          ["unexpected_provider_refund", "critical"],
        ],
      );
      for (const amounts of [
        [0, 0, 0, 0],
        [-1, 0, 0, 0],
      ]) {
        assert.equal(refund(p.payment, amounts).outcome, "invalid");
      }
      assert.equal(
        refund(p.payment, [1, 0, 0, 0], " padded").outcome,
        "invalid",
      );
      assert.equal(
        refund(p.payment, [1, 0, 0, 0], "x".repeat(501)).outcome,
        "invalid",
      );
    },
  );

  await check(
    "LED-1 (PM INV-3; PS sections 22.3, 32) the ledger is append-only for every role, the owner included (no update, delete or truncate), each posting happens once per (payment, entry type, source), and every entry needs a payment, a positive amount, the vocabulary and the payment's currency",
    () => {
      const p = capturedPayment({ jurisdiction: world.J.A });
      const entry = sql(
        `select id from public.ledger_entries where payment_transaction_id = '${p.payment}' limit 1;`,
      );
      assert.equal(
        refused(
          `update public.ledger_entries set amount_minor = 1 where id = '${entry}';`,
        ),
        "23514",
      );
      assert.equal(
        refused(`delete from public.ledger_entries where id = '${entry}';`),
        "23514",
      );
      assert.equal(refused("truncate public.ledger_entries;"), "55000");
      const insert = (fields) => {
        const v = {
          payment: `'${p.payment}'`,
          type: "'client_fee'",
          direction: "'credit'",
          amount: 1,
          currency: "'XTS'",
          source: `'capture:${p.payment}'`,
          reason: "'payment_captured'",
          ...fields,
        };
        return refused(
          `insert into public.ledger_entries (payment_transaction_id, entry_type, direction, amount_minor, currency_code, effective_at, source_reference, reason_code) values (${v.payment}, ${v.type}, ${v.direction}, ${v.amount}, ${v.currency}, now(), ${v.source}, ${v.reason});`,
        );
      };
      assert.equal(insert({}), "23505");
      assert.equal(insert({ payment: "null" }), "23514");
      assert.equal(insert({ amount: 0, source: `'refund:${uid()}'` }), "23514");
      assert.equal(
        insert({ type: "'payout'", source: `'refund:${uid()}'` }),
        "23514",
      );
      assert.equal(
        insert({ direction: "'sideways'", source: `'refund:${uid()}'` }),
        "23514",
      );
      assert.equal(
        insert({ currency: "'XXX'", source: `'refund:${uid()}'` }),
        "23514",
      );
      assert.equal(insert({ source: "'manual'" }), "23514");
      assert.equal(
        insert({ reason: "'other'", source: `'refund:${uid()}'` }),
        "23514",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// WH: webhook receipts, replay and out-of-order observations
// ---------------------------------------------------------------------------

async function webhookChecks() {
  await check(
    "WH-1 (IMP section 23 duplicate webhook; PM row 33; PS section 34) a provider event is recorded once: a replay answers duplicate with the first outcome, writes nothing and has no effect; the receipt keeps only the validated observation and a sha256 digest, and is never changed again, deleted or truncated; malformed input is refused",
    () => {
      const s = newRequest({ jurisdiction: world.J.A });
      const id = authorize(s.client, s.request).payment;
      runJob("payment.checkout", "payment_transaction", id, () =>
        obs("checkout_open", { checkout_reference: checkoutRef() }),
      );
      const observation = obs("authorization_confirmed", {
        payment_transaction_id: id,
        payment_reference: paymentRef(),
        amount_minor: 5225,
        currency_code: "XTS",
      });
      const first = providerEvent(
        "payment_intent.amount_capturable_updated",
        observation,
        "evt_synthetic_replay_one",
      );
      assert.deepEqual(
        [first.outcome, first.processing],
        ["recorded", "applied"],
      );
      const before = financialCounts();
      const replay = providerEvent(
        "payment_intent.amount_capturable_updated",
        observation,
        "evt_synthetic_replay_one",
      );
      assert.deepEqual(
        [replay.outcome, replay.processing],
        ["duplicate", "applied"],
      );
      assert.deepEqual(financialCounts(), before);
      const receipt = jsonOf(
        "select row_to_json(x)::text from public.external_event_receipts x where provider_event_reference = 'evt_synthetic_replay_one';",
      );
      assert.equal(receipt.processing_state, "applied");
      assert.equal(receipt.correlation_reference, id);
      assert.match(receipt.payload_digest, /^sha256:[0-9a-f]{64}$/);
      assert.deepEqual(Object.keys(receipt.minimal_payload).sort(), [
        "amount_minor",
        "currency_code",
        "kind",
        "payment_reference",
        "payment_transaction_id",
        "provider_created_at",
      ]);
      assert.equal(
        refused(
          `update public.external_event_receipts set processing_state = 'stale' where id = '${receipt.id}';`,
        ),
        "55000",
      );
      assert.equal(
        refused(
          `delete from public.external_event_receipts where id = '${receipt.id}';`,
        ),
        "55000",
      );
      assert.equal(
        refused("truncate public.external_event_receipts;"),
        "55000",
      );
      for (const bad of [
        { kind: "authorization_confirmed", amount_minor: -1 },
        { kind: "authorization_confirmed", raw_payload: {} },
        { kind: "made_up" },
        { kind: "checkout_open", checkout_reference: "cs_test_x123" },
        { kind: "authorization_failed", payment_reference: "pi with spaces" },
      ]) {
        assert.equal(
          providerEvent("payment_intent.payment_failed", bad).outcome,
          "invalid",
          JSON.stringify(bad),
        );
      }
      const unhandled = providerEvent("customer.created", obs("ignored"));
      assert.deepEqual(
        [unhandled.outcome, unhandled.processing],
        ["recorded", "ignored"],
      );
      const unknown = providerEvent(
        "payment_intent.payment_failed",
        obs("authorization_failed", { payment_reference: paymentRef() }),
      );
      assert.equal(unknown.processing, "unmatched");
      assert.equal(
        sql(
          `select exception_type from public.reconciliation_exceptions where source_id = (select id from public.external_event_receipts where provider_event_reference = '${unknown.id}');`,
        ),
        "unknown_payment_reference",
      );
    },
  );

  await check(
    "WH-2 (IMP section 23 out-of-order webhook; MBS section 12; PM rows 34, 36; TA section 53) an older or regressive observation never overwrites newer canonical state: a failure or an authorization delivered after the capture is stale; a capture Rosuno never requested, or a release it never asked for, opens an exception and changes nothing; a provider reference that disagrees with the recorded one opens provider_reference_mismatch",
    () => {
      const p = capturedPayment({ jurisdiction: world.J.A });
      const before = paymentOf(p.payment);
      const lateFailure = providerEvent(
        "payment_intent.payment_failed",
        obs("authorization_failed", {
          payment_transaction_id: p.payment,
          payment_reference: p.reference,
        }),
      );
      assert.equal(lateFailure.processing, "stale");
      const lateAuthorization = providerEvent(
        "payment_intent.amount_capturable_updated",
        obs("authorization_confirmed", {
          payment_transaction_id: p.payment,
          payment_reference: p.reference,
          amount_minor: 5225,
          currency_code: "XTS",
        }),
      );
      assert.equal(lateAuthorization.processing, "stale");
      const lateExpiry = providerEvent(
        "checkout.session.expired",
        obs("checkout_expired", { payment_transaction_id: p.payment }),
      );
      assert.equal(lateExpiry.processing, "stale");
      assert.deepEqual(paymentOf(p.payment), before);
      assert.equal(ledgerOf(p.payment).length, 5);
      const a = authorizedPayment({ jurisdiction: world.J.A });
      const unrequested = providerEvent(
        "payment_intent.succeeded",
        obs("capture_confirmed", {
          payment_reference: a.reference,
          amount_minor: 5225,
          currency_code: "XTS",
        }),
      );
      assert.equal(unrequested.processing, "contradiction");
      const unasked = providerEvent(
        "payment_intent.canceled",
        obs("authorization_released", { payment_reference: a.reference }),
      );
      assert.equal(unasked.processing, "contradiction");
      const mismatch = providerEvent(
        "payment_intent.payment_failed",
        obs("authorization_failed", {
          payment_transaction_id: a.payment,
          payment_reference: paymentRef(),
        }),
      );
      assert.equal(mismatch.processing, "contradiction");
      assert.equal(paymentOf(a.payment).state, "authorized");
      assert.deepEqual(
        exceptionsOf(a.payment).map((e) => e.exception_type),
        [
          "unexpected_provider_capture",
          "provider_state_contradiction",
          "provider_reference_mismatch",
        ],
      );
      const s = newRequest({ jurisdiction: world.J.A });
      const pending = authorize(s.client, s.request).payment;
      const checkout = checkoutRef();
      runJob("payment.checkout", "payment_transaction", pending, () =>
        obs("checkout_open", { checkout_reference: checkout }),
      );
      const wrongCheckout = providerEvent(
        "checkout.session.completed",
        obs("checkout_completed", {
          payment_transaction_id: pending,
          checkout_reference: checkoutRef(),
        }),
      );
      assert.equal(wrongCheckout.processing, "contradiction");
      assert.deepEqual(
        exceptionsOf(pending).map((e) => e.exception_type),
        ["provider_reference_mismatch"],
      );
      assert.equal(paymentOf(pending).state, "pending_authorization");
      // A completed checkout asks the worker to reconcile, which records the authorization.
      const completed = providerEvent(
        "checkout.session.completed",
        obs("checkout_completed", {
          checkout_reference: checkout,
          payment_reference: paymentRef(),
        }),
      );
      assert.equal(completed.processing, "applied");
      const reference = paymentRef();
      const reconciled = runJob(
        "payment.reconcile",
        "payment_transaction",
        pending,
        (c) => {
          assert.equal(c.reference_kind, "checkout");
          return obs("provider_state", {
            checkout_reference: checkout,
            payment_reference: reference,
            provider_status: "requires_capture",
            amount_capturable_minor: 5225,
            currency_code: "XTS",
          });
        },
      );
      assert.equal(reconciled.outcome, "applied");
      assert.equal(paymentOf(pending).state, "authorized");
      assert.equal(paymentOf(pending).provider_payment_reference, reference);
    },
  );
}

// ---------------------------------------------------------------------------
// DSP: disputes; REL: release on withdrawal and expiry; RECON: reconciliation
// ---------------------------------------------------------------------------

async function disputeAndReleaseChecks() {
  await check(
    "DSP-1 (PM row 30; MBS section 12 chargeback handling) a dispute is observed: the payment becomes charged_back with its amounts unchanged and a high dispute_opened exception (evidence kept); later dispute updates open their own exceptions; no ledger entry is posted and no refund can be asked for",
    () => {
      const p = capturedPayment({ jurisdiction: world.J.A });
      const opened = providerEvent(
        "charge.dispute.created",
        obs("dispute_opened", {
          payment_reference: p.reference,
          dispute_reference: "dp_synthetic_one",
          amount_minor: 5225,
          currency_code: "XTS",
          provider_status: "needs_response",
        }),
      );
      assert.equal(opened.processing, "applied");
      const payment = paymentOf(p.payment);
      assert.deepEqual(
        [
          payment.state,
          payment.amount_captured_minor,
          payment.amount_refunded_minor,
        ],
        ["charged_back", 5225, 0],
      );
      const updated = providerEvent(
        "charge.dispute.closed",
        obs("dispute_closed", {
          payment_reference: p.reference,
          dispute_reference: "dp_synthetic_one",
          provider_status: "won",
        }),
      );
      assert.equal(updated.processing, "no_effect");
      assert.deepEqual(
        exceptionsOf(p.payment).map((e) => [e.exception_type, e.severity]),
        [
          ["dispute_opened", "high"],
          ["dispute_closed", "medium"],
        ],
      );
      assert.equal(ledgerOf(p.payment).length, 5);
      assert.equal(paymentOf(p.payment).state, "charged_back");
      assert.equal(refund(p.payment, [1, 0, 0, 0]).outcome, "not_refundable");
    },
  );

  await check(
    "REL-1 (PM rows 3-5, 8-10; TA section 14 B3) withdrawing a Request releases its live attempt in the same transaction: a pending attempt and an authorized one become release_pending with the release enqueued; the release job expires the checkout (cancelled) or releases the authorization (authorization_released); nothing is captured; S6 guarantees hold (the Hold is released)",
    () => {
      const pendingScenario = newRequest({
        jurisdiction: world.J.A,
        requestPath: "scheduled",
      });
      const pending = authorize(
        pendingScenario.client,
        pendingScenario.request,
      ).payment;
      const checkout = checkoutRef();
      runJob("payment.checkout", "payment_transaction", pending, () =>
        obs("checkout_open", { checkout_reference: checkout }),
      );
      assert.equal(
        asClient(
          pendingScenario.client,
          `select outcome from public.request_withdraw('${pendingScenario.request}');`,
        ),
        "withdrawn",
      );
      assert.equal(paymentOf(pending).state, "release_pending");
      assert.equal(
        sql(
          `select released_at is not null from public.slot_holds where consultation_request_id = '${pendingScenario.request}';`,
        ),
        "t",
      );
      const audit = jsonOf(
        `select row_to_json(a)::text from public.audit_events a where resource_id = '${pending}' and action_code = 'payment.release_requested';`,
      );
      assert.equal(audit.reason_code, "request_cancelled");
      const expired = runJob(
        "payment.release",
        "payment_transaction",
        pending,
        (c) => {
          assert.deepEqual(
            [c.outcome, c.reference_kind, c.provider_reference],
            ["act", "checkout", checkout],
          );
          return obs("checkout_expired", { checkout_reference: checkout });
        },
      );
      assert.equal(expired.outcome, "applied");
      assert.equal(paymentOf(pending).state, "cancelled");
      const a = authorizedPayment({ jurisdiction: world.J.A });
      assert.equal(
        asClient(
          a.client,
          `select outcome from public.request_withdraw('${a.request}');`,
        ),
        "withdrawn",
      );
      assert.equal(paymentOf(a.payment).state, "release_pending");
      const released = runJob(
        "payment.release",
        "payment_transaction",
        a.payment,
        (c) => {
          assert.deepEqual(
            [c.reference_kind, c.provider_reference],
            ["payment", a.reference],
          );
          return obs("authorization_released", {
            payment_reference: a.reference,
            amount_minor: 5225,
            currency_code: "XTS",
          });
        },
      );
      assert.equal(released.outcome, "applied");
      const payment = paymentOf(a.payment);
      assert.deepEqual(
        [payment.state, payment.amount_captured_minor],
        ["authorization_released", null],
      );
      assert.equal(ledgerOf(a.payment).length, 0);
    },
  );

  await check(
    "REL-3 (PM rows 3-5, 8-10, INV-11) a Request that ends while its payment is captured or being captured never silently retains the funds: the withdrawal opens one critical funds_retained_after_request_end Reconciliation Exception for human resolution (the refund is not decided automatically), the payment, its amounts and its ledger are unchanged, and nothing is released",
    () => {
      const c = capturedPayment({ jurisdiction: world.J.A });
      const before = paymentOf(c.payment);
      const ledgerBefore = ledgerOf(c.payment);
      assert.equal(
        asClient(
          c.client,
          `select outcome from public.request_withdraw('${c.request}');`,
        ),
        "withdrawn",
      );
      assert.equal(requestStateOf(c.request), "cancelled");
      const after = paymentOf(c.payment);
      assert.deepEqual(
        [after.state, after.amount_captured_minor, after.amount_refunded_minor],
        [
          before.state,
          before.amount_captured_minor,
          before.amount_refunded_minor,
        ],
      );
      assert.equal(after.state, "captured");
      assert.deepEqual(ledgerOf(c.payment), ledgerBefore);
      assert.ok(!openJob("payment.release", "payment_transaction", c.payment));
      assert.deepEqual(exceptionsOf(c.payment), [
        {
          exception_type: "funds_retained_after_request_end",
          severity: "critical",
          status: "open",
          source_type: "consultation_request",
        },
      ]);
      const pending = authorizedPayment({ jurisdiction: world.J.A });
      assert.equal(
        sql(`select public.payment_request_capture('${pending.payment}');`),
        "capture_requested",
      );
      assert.equal(
        asClient(
          pending.client,
          `select outcome from public.request_withdraw('${pending.request}');`,
        ),
        "withdrawn",
      );
      assert.equal(paymentOf(pending.payment).state, "capture_pending");
      assert.deepEqual(
        exceptionsOf(pending.payment).map((e) => [
          e.exception_type,
          e.severity,
        ]),
        [["funds_retained_after_request_end", "critical"]],
      );
    },
  );

  await check(
    "REL-2 (PM rows 4, 5; MBS section 11 quote and deadline expiry) expiry releases the attempt with and without the sweep: the sweep expires a Request past its deadline and releases its authorized payment; a provider authorization arriving after another Request's deadline expires that Request first, then is recorded on the released attempt (never moving the Request) and the release cancels it",
    async () => {
      const a = authorizedPayment({ jurisdiction: world.J.X });
      const s = newRequest({ jurisdiction: world.J.X });
      const late = authorize(s.client, s.request).payment;
      const checkout = checkoutRef();
      runJob("payment.checkout", "payment_transaction", late, () =>
        obs("checkout_open", { checkout_reference: checkout }),
      );
      await sleep(6500);
      sql("select public.request_expiry_sweep();");
      assert.equal(requestStateOf(a.request), "expired");
      assert.equal(paymentOf(a.payment).state, "release_pending");
      assert.ok(openJob("payment.release", "payment_transaction", a.payment));
      // The other Request is past its deadline but not yet swept.
      const reference = paymentRef();
      const event = providerEvent(
        "payment_intent.amount_capturable_updated",
        obs("authorization_confirmed", {
          payment_transaction_id: late,
          payment_reference: reference,
          amount_minor: 5225,
          currency_code: "XTS",
        }),
      );
      assert.equal(requestStateOf(s.request), "expired");
      assert.equal(event.processing, "applied");
      const payment = paymentOf(late);
      assert.deepEqual(
        [
          payment.state,
          payment.amount_authorized_minor,
          payment.provider_payment_reference,
        ],
        ["release_pending", 5225, reference],
      );
      const released = runJob(
        "payment.release",
        "payment_transaction",
        late,
        (c) => {
          assert.deepEqual(
            [c.reference_kind, c.provider_reference],
            ["payment", reference],
          );
          return obs("authorization_released", {
            payment_reference: reference,
          });
        },
      );
      assert.equal(released.outcome, "applied");
      assert.equal(paymentOf(late).state, "authorization_released");
      assert.equal(authorize(s.client, s.request).outcome, "expired");
    },
  );

  await check(
    "RECON-1 (IMP section 23 reconciliation; TA sections 26, 52; PM row 36) staff request reconciliation through the job protocol; a provider snapshot that completes a pending operation records it, one that agrees has no effect, one that disagrees opens a reconciliation_mismatch exception; an exhausted payment job (real job_claim and job_fail) opens provider_operation_exhausted",
    () => {
      const p = capturedPayment({ jurisdiction: world.J.A });
      const line = staffAs(
        `select outcome || '|' || enqueued from public.staff_request_reconciliation('${p.payment}');`,
      );
      assert.equal(line, "requested|1");
      const agree = runJob(
        "payment.reconcile",
        "payment_transaction",
        p.payment,
        (c) => {
          assert.deepEqual([c.outcome, c.reference_kind], ["act", "payment"]);
          return obs("provider_state", {
            payment_reference: p.reference,
            provider_status: "succeeded",
            amount_received_minor: 5225,
            amount_refunded_minor: 0,
            currency_code: "XTS",
          });
        },
      );
      assert.equal(agree.outcome, "no_effect");
      staffAs(
        `select outcome from public.staff_request_reconciliation('${p.payment}');`,
      );
      const disagree = runJob(
        "payment.reconcile",
        "payment_transaction",
        p.payment,
        () =>
          obs("provider_state", {
            payment_reference: p.reference,
            provider_status: "succeeded",
            amount_received_minor: 5225,
            amount_refunded_minor: 300,
            currency_code: "XTS",
          }),
      );
      assert.equal(disagree.outcome, "contradiction");
      assert.deepEqual(
        exceptionsOf(p.payment).map((e) => e.exception_type),
        ["reconciliation_mismatch"],
      );
      // Capture outcome unknown, then the provider snapshot shows it succeeded (TA section 52).
      const q = authorizedPayment({ jurisdiction: world.J.A });
      sql(`select public.payment_request_capture('${q.payment}');`);
      sql(
        `select public.job_enqueue('payment.reconcile', 'payment_transaction', '${q.payment}', now(), 3);`,
      );
      const completes = runJob(
        "payment.reconcile",
        "payment_transaction",
        q.payment,
        () =>
          obs("provider_state", {
            payment_reference: q.reference,
            provider_status: "succeeded",
            amount_received_minor: 5225,
            amount_refunded_minor: 0,
            currency_code: "XTS",
          }),
      );
      assert.equal(completes.outcome, "applied");
      assert.equal(paymentOf(q.payment).state, "captured");
      assert.equal(ledgerOf(q.payment).length, 5);
      // Every live payment at once.
      const all = staffAs(
        "select outcome from public.staff_request_reconciliation(null);",
      );
      assert.equal(all, "requested");
      // Exhaustion through the real worker functions.
      const capture = openJob(
        "payment.capture",
        "payment_transaction",
        q.payment,
      );
      assert.ok(capture, "the capture job is still open");
      let escalated = false;
      for (let attempt = 0; attempt < 12 && !escalated; attempt += 1) {
        // First in claim order, and claimed alone, so no other job is touched.
        sql(
          `update public.operational_jobs set available_at = now() - interval '365 days' where id = '${capture}' and state = 'pending';`,
        );
        const claimed = rowsAs(
          "service_role",
          null,
          "select job_id from public.job_claim('s7-proof-exhaust', 30, 1);",
        );
        for (const job of claimed) {
          const answer = as(
            "service_role",
            null,
            `select public.job_fail('${job}', 's7-proof-exhaust', 'handler_failed', 'synthetic failure');`,
          );
          if (job === capture && answer === "escalated") {
            escalated = true;
          }
        }
      }
      assert.ok(escalated, "the capture job escalated");
      assert.ok(
        exceptionsOf(q.payment).some(
          (e) =>
            e.exception_type === "provider_operation_exhausted" &&
            e.source_type === "operational_job",
        ),
      );
    },
  );

  await check(
    "EXC-1 (PS section 22.5; TA section 26) staff assign and resolve exceptions through audited functions: assignment to oneself (no User id is an input; the assignee is always the caller) or clearing it, only while open; resolution once with bounded notes; for every role the detection facts are fixed, a resolved exception is final and nothing is deleted",
    () => {
      const p = authorizedPayment({ jurisdiction: world.J.A });
      providerEvent(
        "payment_intent.canceled",
        obs("authorization_released", { payment_reference: p.reference }),
      );
      const exception = sql(
        `select id from public.reconciliation_exceptions where canonical_id = '${p.payment}';`,
      );
      assert.equal(
        as(
          "authenticated",
          world.otherFinance.auth,
          `select public.staff_assign_reconciliation_exception('${exception}', true);`,
        ),
        "applied",
      );
      assert.equal(
        sql(
          `select assigned_to_user_id from public.reconciliation_exceptions where id = '${exception}';`,
        ),
        world.otherFinance.user,
      );
      assert.equal(
        as(
          "authenticated",
          world.plainStaff.auth,
          `select public.staff_assign_reconciliation_exception('${exception}', true);`,
        ),
        "denied",
      );
      assert.equal(
        staffAs(
          `select public.staff_assign_reconciliation_exception('${exception}', null);`,
        ),
        "invalid",
      );
      assert.equal(
        staffAs(
          `select public.staff_assign_reconciliation_exception('${exception}', false);`,
        ),
        "applied",
      );
      assert.equal(
        sql(
          `select coalesce(assigned_to_user_id::text, 'none') from public.reconciliation_exceptions where id = '${exception}';`,
        ),
        "none",
      );
      assert.equal(
        staffAs(
          `select public.staff_assign_reconciliation_exception('${exception}', true);`,
        ),
        "applied",
      );
      assert.equal(
        staffAs(
          `select public.staff_resolve_reconciliation_exception('${exception}', ' ');`,
        ),
        "invalid",
      );
      assert.equal(
        staffAs(
          `select public.staff_resolve_reconciliation_exception('${exception}', 'Synthetic resolution notes');`,
        ),
        "applied",
      );
      assert.equal(
        staffAs(
          `select public.staff_resolve_reconciliation_exception('${exception}', 'Again');`,
        ),
        "invalid_transition",
      );
      assert.equal(
        staffAs(
          `select public.staff_assign_reconciliation_exception('${exception}', false);`,
        ),
        "invalid_transition",
      );
      const row = jsonOf(
        `select row_to_json(e)::text from public.reconciliation_exceptions e where id = '${exception}';`,
      );
      assert.deepEqual(
        [row.status, row.resolution_notes, row.assigned_to_user_id],
        ["resolved", "Synthetic resolution notes", world.finance.user],
      );
      assert.equal(
        Number(
          sql(
            `select count(*) from public.audit_events where resource_id = '${exception}' and actor_type = 'staff';`,
          ),
        ),
        4,
      );
      assert.equal(
        refused(
          `update public.reconciliation_exceptions set resolution_notes = 'x' where id = '${exception}';`,
        ),
        "55000",
      );
      assert.equal(
        refused(
          `delete from public.reconciliation_exceptions where id = '${exception}';`,
        ),
        "55000",
      );
      assert.equal(
        refused("truncate public.reconciliation_exceptions;"),
        "55000",
      );
      assert.equal(
        refused(
          `update public.reconciliation_exceptions set severity = 'low' where status = 'open';`,
        ),
        "55000",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// AUTHZ and AUD: who sees what, and audit minimization
// ---------------------------------------------------------------------------

async function accessChecks() {
  await check(
    "AUTHZ-1 (MBS section 20; PS sections 30.2-30.4) a client sees and acts on only their own payments (another client's Request, attempt, checkout and receipt answer like unknown ones); an attorney sees only the ledger-derived earnings of their own Requests at aal2; finance staff see and act only with manage_financial_operations at aal2; anon executes nothing; the worker functions are refused to authenticated and the client functions to service_role",
    () => {
      const p = capturedPayment({ jurisdiction: world.J.A });
      const stranger = newClient();
      assert.equal(authorize(stranger, p.request).outcome, "not_found");
      for (const statement of [
        `select count(*) from public.client_request_payment('${p.request}');`,
        `select count(*) from public.client_payment_receipt('${p.payment}');`,
        `select count(*) from public.client_payment_checkout('${p.payment}');`,
      ]) {
        assert.equal(asClient(stranger, statement), "0", statement);
        assert.equal(asClient(p.client, statement), "1", statement);
      }
      const receipt = JSON.parse(
        asClient(
          p.client,
          `select row_to_json(r)::text from public.client_payment_receipt('${p.payment}') r;`,
        ),
      );
      assert.deepEqual(
        [
          receipt.payment_state,
          receipt.total_client_amount_minor,
          receipt.amount_captured_minor,
          receipt.refunds,
        ],
        ["captured", 5225, 5225, []],
      );
      assert.ok(!("platform_fee_minor" in receipt));
      const earnings = (account, options) =>
        rowsAs(
          "authenticated",
          account.auth,
          "select row_to_json(e)::text from public.attorney_payment_earnings() e;",
          options,
        ).map((line) => JSON.parse(line));
      const mine = earnings(world.ann).find(
        (e) => e.payment_transaction_id === p.payment,
      );
      assert.deepEqual(
        [
          mine.attributed_minor,
          mine.reversed_minor,
          mine.net_minor,
          mine.currency_code,
        ],
        [4500, 0, 4500, "XTS"],
      );
      assert.equal(earnings(world.bob).length, 0);
      assert.equal(earnings(world.ann, { aal: "aal1" }).length, 0);
      assert.equal(
        asClient(
          p.client,
          "select count(*) from public.attorney_payment_earnings();",
        ),
        "0",
      );
      const staffRows = (account, options) =>
        Number(
          as(
            "authenticated",
            account.auth,
            "select count(*) from public.staff_finance_payments('all', 0);",
            options,
          ),
        );
      assert.ok(staffRows(world.finance) > 0);
      assert.equal(staffRows(world.finance, { aal: "aal1" }), 0);
      assert.equal(staffRows(world.plainStaff), 0);
      assert.equal(staffRows(p.client), 0);
      assert.equal(
        as(
          "authenticated",
          world.finance.auth,
          `select count(*) from public.staff_finance_payment('${p.payment}');`,
        ),
        "1",
      );
      assert.equal(
        as(
          "authenticated",
          world.plainStaff.auth,
          `select count(*) from public.staff_finance_ledger('${p.payment}');`,
        ),
        "0",
      );
      assert.equal(
        as(
          "authenticated",
          world.finance.auth,
          `select count(*) from public.staff_finance_ledger('${p.payment}');`,
        ),
        "5",
      );
      for (const [account, options] of [
        [world.finance, { aal: "aal1" }],
        [world.plainStaff, {}],
        [p.client, {}],
      ]) {
        assert.equal(
          as(
            "authenticated",
            account.auth,
            `select outcome from public.staff_request_refund('${p.payment}', 1, 0, 0, 0, 'Synthetic reason');`,
            options,
          ),
          "denied",
        );
        assert.equal(
          as(
            "authenticated",
            account.auth,
            "select outcome from public.staff_request_reconciliation(null);",
            options,
          ),
          "denied",
        );
      }
      for (const signature of [
        `public.client_authorize_payment('${p.request}')`,
        `public.client_request_payment('${p.request}')`,
        "public.attorney_payment_earnings()",
        "public.staff_finance_payments('all', 0)",
        `public.payment_job_context('${p.payment}')`,
      ]) {
        assert.equal(
          as("anon", null, `select count(*) from ${signature};`),
          "ERROR 42501",
          signature,
        );
      }
      assert.equal(
        as(
          "authenticated",
          world.finance.auth,
          `select count(*) from public.payment_job_context('${p.payment}');`,
        ),
        "ERROR 42501",
      );
      assert.equal(
        as(
          "service_role",
          null,
          `select count(*) from public.client_authorize_payment('${p.request}');`,
        ),
        "ERROR 42501",
      );
      assert.equal(
        as(
          "authenticated",
          world.finance.auth,
          "select count(*) from public.payment_transactions;",
        ),
        "ERROR 42501",
      );
    },
  );

  await check(
    "AUD-1 (IMP section 15; Packet section 4 logs; PM INV-9) audit minimization: payment audit events carry state, amounts, currency and the policy versions but never a provider reference; the refund reason appears only in the staff refund request; resolution notes stay on the exception; every receipt's minimal payload holds only observation members and the provider time, never a raw payload or card data",
    () => {
      assert.equal(
        sql(
          "select count(*) from public.audit_events where (action_code like 'payment.%' or action_code like 'reconciliation_exception.%' or action_code = 'consultation_request.payment_authorized') and (coalesce(before_snapshot::text, '') || coalesce(after_snapshot::text, '')) ~ '(cs_test_|pi_syn|re_synthetic|dp_synthetic)';",
        ),
        "0",
      );
      assert.equal(
        sql(
          "select count(*) from public.audit_events where after_snapshot::text like '%Synthetic staff refund reason%' and action_code <> 'payment.refund_requested';",
        ),
        "0",
      );
      assert.equal(
        sql(
          "select count(*) from public.audit_events where coalesce(after_snapshot::text, '') like '%Synthetic resolution notes%';",
        ),
        "0",
      );
      const keys = sql(
        "select coalesce(string_agg(distinct k, ',' order by k), '') from public.external_event_receipts x cross join lateral jsonb_object_keys(x.minimal_payload) k;",
      ).split(",");
      const allowed = new Set([
        "kind",
        "payment_transaction_id",
        "checkout_reference",
        "payment_reference",
        "refund_reference",
        "refund_request_id",
        "dispute_reference",
        "amount_minor",
        "amount_capturable_minor",
        "amount_received_minor",
        "amount_refunded_minor",
        "currency_code",
        "provider_status",
        "provider_created_at",
      ]);
      assert.ok(
        keys.every((k) => allowed.has(k)),
        keys.join(","),
      );
      assert.equal(
        sql(
          "select count(*) from public.external_event_receipts where minimal_payload::text ~* '(card|cvc|exp_month|last4|email|billing)';",
        ),
        "0",
      );
      return { receipt_keys: keys };
    },
  );
}

// ---------------------------------------------------------------------------
// PROD: the production financial gate in a production-class database
// ---------------------------------------------------------------------------

const prod = {};

function prodSql(statement) {
  return sql(statement, PROD_DB);
}

function prodActivePolicy(type, jurisdiction, parameters, mode = null) {
  const id = uid();
  prodSql(
    `insert into public.policy_versions (id, policy_type_code, jurisdiction_id, regulatory_mode_id, version_label, parameters, status, effective_from, development_only)
     values ('${id}', ${lit(type)}, ${lit(jurisdiction)}, ${lit(mode)}, ${lit(`synthetic-prod-${type}-${id.slice(0, 8)}`)}, ${lit(parameters)}::jsonb, 'draft', now() - interval '1 day', false);
     insert into public.policy_authority_references (policy_version_id, authority_type, citation_text, source_title, retrieved_at, verified_by_user_id, verification_status)
       values ('${id}', 'synthetic', 'synthetic citation', 'synthetic source', now(), '${prod.grantor.user}', 'verified');
     update public.policy_versions set status = 'internal_review' where id = '${id}';
     update public.policy_versions set status = 'counsel_review' where id = '${id}';
     update public.policy_versions set status = 'approved', approved_at = now() - interval '2 days', approved_by_user_id = '${prod.grantor.user}' where id = '${id}';
     update public.policy_versions set status = 'active' where id = '${id}';`,
  );
  return id;
}

// An incomplete draft (counsel_review, never approved): never selectable.
function prodCounselReviewPolicy(type, jurisdiction, parameters, mode = null) {
  const id = uid();
  prodSql(
    `insert into public.policy_versions (id, policy_type_code, jurisdiction_id, regulatory_mode_id, version_label, parameters, status, effective_from, development_only)
     values ('${id}', ${lit(type)}, ${lit(jurisdiction)}, ${lit(mode)}, ${lit(`synthetic-review-${type}-${id.slice(0, 8)}`)}, ${lit(parameters)}::jsonb, 'draft', now() - interval '1 day', false);
     update public.policy_versions set status = 'internal_review' where id = '${id}';
     update public.policy_versions set status = 'counsel_review' where id = '${id}';`,
  );
  return id;
}

// A development row planted by the owner with every trigger bypassed (it can
// never be created in a production-class database).
function prodPlantedDevelopment(type, jurisdiction, parameters, mode = null) {
  const id = uid();
  prodSql(
    `begin;
     set local session_replication_role = replica;
     insert into public.policy_versions (id, policy_type_code, jurisdiction_id, regulatory_mode_id, version_label, parameters, status, effective_from, development_only)
       values ('${id}', ${lit(type)}, ${lit(jurisdiction)}, ${lit(mode)}, ${lit(`synthetic-planted-${type}-${id.slice(0, 8)}`)}, ${lit(parameters)}::jsonb, 'draft', now() - interval '1 day', true);
     commit;`,
  );
  return id;
}

function prodJurisdiction(
  key,
  lifecycle,
  { planted = [], unapproved = [] } = {},
) {
  const id = newJurisdiction(`SYN_S7_PROD_${key}`, PROD_DB, "ready");
  prodSql(
    `insert into public.jurisdiction_regulatory_modes (jurisdiction_id, regulatory_mode_id, active_from, approval_status) values ('${id}', '${prod.mode}', now() - interval '1 day', 'synthetic');
     insert into public.launch_authorizations (jurisdiction_id, authorized_at, authorized_by_user_id, reason) values ('${id}', now() - interval '1 day', '${prod.grantor.user}', 'synthetic launch authorization');
     update public.jurisdictions set lifecycle_state = '${lifecycle}' where id = '${id}';`,
  );
  const policies = {
    referral: prodActivePolicy("referral", id, {
      outcome_codes: ["synthetic_closed"],
    }),
    fee: prodActivePolicy("fee", id, FEE()),
    payment_flow: prodActivePolicy(
      "payment_flow",
      id,
      FLOW(BEFORE, BEFORE),
      prod.mode,
    ),
  };
  for (const type of ["payment", "engagement", "cancellation", "refund"]) {
    policies[type] = planted.includes(type)
      ? prodPlantedDevelopment(type, id, {}, prod.mode)
      : unapproved.includes(type)
        ? prodCounselReviewPolicy(type, id, {}, prod.mode)
        : prodActivePolicy(type, id, {}, prod.mode);
  }
  return { id, policies };
}

// An instant Request written by the owner with its same-transaction evidence
// (the production database has no synthetic scheduling configuration).
function prodRequest(jurisdiction, referralPolicy) {
  const client = newAccount("active", PROD_DB);
  const clientProfile = uid();
  const intake = uid();
  const referral = uid();
  const evaluation = uid();
  const request = uid();
  const requestEvaluation = uid();
  prodSql(
    `insert into public.client_profiles (id, user_id) values ('${clientProfile}', '${client.user}');
     insert into public.intakes (id, client_id, state) values ('${intake}', '${clientProfile}', 'submitted');
     begin;
     insert into public.referrals (id, intake_id, attorney_id, jurisdiction_id, attempt_ordinal, allocation_method) values ('${referral}', '${intake}', '${prod.attorney}', '${jurisdiction.id}', 1, 'client_selected');
     insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, context_id, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${evaluation}', '${prod.attorney}', '${jurisdiction.id}', 'jurisdiction', null, now(), '[]'::jsonb, 'eligible', '[]'::jsonb, '{}'::jsonb, now());
     insert into public.referral_eligible_pool_entries (referral_id, attorney_id, eligibility_evaluation_id, eligible_as_of) values ('${referral}', '${prod.attorney}', '${evaluation}', now());
     insert into public.referral_presentations (referral_id, attorney_id, display_position, client_filter_context, narrowing_actor, shown_at) values ('${referral}', '${prod.attorney}', 1, null, 'platform', now());
     insert into public.bookability_evaluations (attorney_id, eligibility_evaluation_id, context_type, context_id, evaluated_at, as_of, modality, presence_observed, availability_basis, constraint_results, result) values ('${prod.attorney}', '${evaluation}', 'referral', '${referral}', now(), now(), 'unselected', true, null, '[]'::jsonb, 'bookable');
     commit;
     begin;
     insert into public.consultation_requests (id, intake_id, client_id, selected_attorney_id, referral_id, request_path, referral_policy_version_id, requested_modality, requested_duration_minutes, state, response_deadline_at)
       values ('${request}', '${intake}', '${clientProfile}', '${prod.attorney}', '${referral}', 'instant', '${referralPolicy}', 'synthetic_video', 30, 'created', now() + interval '1 hour');
     insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, context_id, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${requestEvaluation}', '${prod.attorney}', '${jurisdiction.id}', 'jurisdiction', null, now(), '[]'::jsonb, 'eligible', '[]'::jsonb, '{}'::jsonb, now());
     insert into public.bookability_evaluations (attorney_id, eligibility_evaluation_id, context_type, context_id, evaluated_at, as_of, modality, constraint_results, result) values ('${prod.attorney}', '${requestEvaluation}', 'consultation_request', '${request}', now(), now(), 'synthetic_video', '[]'::jsonb, 'bookable');
     insert into public.fee_calculations (consultation_request_id, fee_policy_version_id, attorney_listed_price_minor, platform_fee_minor, client_fee_minor, tax_or_other_required_fee_minor, total_client_amount_minor, currency_code, quote_valid_until, calculated_at, calculation_snapshot)
       values ('${request}', '${jurisdiction.policies.fee}', 5000, 500, 175, 50, 5225, 'XTS', now() + interval '15 minutes', now(), '{"schema": "synthetic-owner-fixture"}'::jsonb);
     commit;`,
  );
  return { client, request };
}

function prodAuthorize(scenario) {
  const line = asIn(
    PROD_DB,
    "authenticated",
    scenario.client.auth,
    `select outcome || '|' || coalesce(payment_transaction_id::text, '') || '|' || coalesce(problem, '') from public.client_authorize_payment(${lit(scenario.request)});`,
    { aal: "aal1" },
  );
  const [outcome, payment, problem] = line.split("|");
  return { outcome, payment: payment || null, problem: problem || null, line };
}

function seedProduction() {
  prodSql(
    `select public.record_deployment_environment('production', '${PRODUCTION_REF}');`,
  );
  prod.grantor = newAccount("active", PROD_DB);
  prodSql(
    `insert into public.staff_profiles (user_id, staff_state) values ('${prod.grantor.user}', 'active');`,
  );
  prod.mode = newRegulatoryMode("SYN_PROD_MARKETPLACE", PROD_DB);
  const lawyer = newAccount("active", PROD_DB);
  prod.attorney = uid();
  prodSql(
    `insert into public.attorney_profiles (id, user_id, profile_state, display_name) values ('${prod.attorney}', '${lawyer.user}', 'approved', 'Prod Synthetic');`,
  );
  prod.live = prodJurisdiction("LIVE", "live");
  prod.staged = prodJurisdiction("STAGED", "staged");
  prod.unapproved = prodJurisdiction("UNAPPROVED", "live", {
    unapproved: ["cancellation"],
  });
  prod.devPayment = prodJurisdiction("DEVPAYMENT", "live", {
    planted: ["payment"],
  });
  prod.devReferral = prodJurisdiction("DEVREFERRAL", "live");
  prod.plantedReferral = prodPlantedDevelopment(
    "referral",
    prod.devReferral.id,
    {
      outcome_codes: ["synthetic_closed"],
    },
  );
}

async function productionChecks() {
  await check(
    "PROD-1 (MBS sections 12, 19; TA section 32 F1-F3; Packet section 4 four-way gate) in a production-class database a payment is created only when all four hold (environment production, jurisdiction live, every one of the seven policy versions approved and active with verified authority, launch authorization granted): three of four refuse (jurisdiction not live; a policy version not approved) and write nothing, and the P1 boundary keeps a live jurisdiction from losing its launch authorization; a development-only version is never usable (a planted payment version is never selected; a Request bound to a planted development referral version is refused)",
    () => {
      seedProduction();
      const answers = {};
      const cases = [
        [
          "staged",
          prod.staged,
          prod.staged.policies.referral,
          "production_gate_closed",
          "jurisdiction_not_live",
        ],
        [
          "unapproved",
          prod.unapproved,
          prod.unapproved.policies.referral,
          "policy_unavailable",
          "cancellation_no_applicable_policy",
        ],
        [
          "dev_payment",
          prod.devPayment,
          prod.devPayment.policies.referral,
          "policy_unavailable",
          "payment_no_applicable_policy",
        ],
        [
          "dev_referral",
          prod.devReferral,
          prod.plantedReferral,
          "production_gate_closed",
          "development_policy",
        ],
      ];
      for (const [
        name,
        jurisdiction,
        referralPolicy,
        outcome,
        problem,
      ] of cases) {
        const scenario = prodRequest(jurisdiction, referralPolicy);
        const before = financialCounts(PROD_DB);
        const answer = prodAuthorize(scenario);
        answers[name] = answer.line;
        assert.deepEqual(
          [answer.outcome, answer.problem],
          [outcome, problem],
          name,
        );
        assert.deepEqual(financialCounts(PROD_DB), before, name);
      }
      // The fourth condition cannot be missing for a live jurisdiction: the P1
      // boundary refuses a live jurisdiction without an active launch
      // authorization, so revoking it is refused here.
      assert.equal(
        refused(
          `update public.launch_authorizations set revoked_at = now() where jurisdiction_id = '${prod.live.id}';`,
          PROD_DB,
        ),
        "23514",
      );
      const scenario = prodRequest(prod.live, prod.live.policies.referral);
      const created = prodAuthorize(scenario);
      answers.all_four = created.line;
      assert.equal(created.outcome, "created", created.line);
      const p = paymentOf(created.payment, PROD_DB);
      assert.equal(p.regulatory_mode_id, prod.mode);
      assert.equal(p.payment_policy_version_id, prod.live.policies.payment);
      assert.equal(
        sql(
          `select bool_or(development_only) from public.policy_versions where id in ('${p.referral_policy_version_id}', '${p.payment_policy_version_id}', '${p.fee_policy_version_id}', '${p.payment_flow_policy_version_id}', '${p.engagement_policy_version_id}', '${p.cancellation_policy_version_id}', '${p.refund_policy_version_id}');`,
          PROD_DB,
        ),
        "f",
      );
      return answers;
    },
  );
}

// ---------------------------------------------------------------------------
// CC: real concurrency with two persistent sessions
// ---------------------------------------------------------------------------

const EVENT_SQL = (eventId, observation) =>
  `select outcome || '|' || coalesce(processing_state, '') from public.payment_record_provider_event('stripe', ${lit(eventId)}, 'payment_intent.amount_capturable_updated', now(), ${lit(`sha256:${sha256(eventId)}`)}, ${lit(observation)}::jsonb);`;

async function concurrencyChecks() {
  await check(
    "CC-1 (PM row 33; PS section 34) the same provider event delivered twice concurrently: the second delivery waits on the receipt key, then answers duplicate; exactly one receipt, one authorization and one audit event",
    async () => {
      const s = newRequest({ jurisdiction: world.J.A });
      const id = authorize(s.client, s.request).payment;
      runJob("payment.checkout", "payment_transaction", id, () =>
        obs("checkout_open", { checkout_reference: checkoutRef() }),
      );
      const observation = obs("authorization_confirmed", {
        payment_transaction_id: id,
        payment_reference: paymentRef(),
        amount_minor: 5225,
        currency_code: "XTS",
      });
      const eventId = `evt_synthetic_cc1_${uid().slice(0, 8)}`;
      const a = await serviceSession("cc1a");
      const b = await serviceSession("cc1b");
      const first = await a.ok(EVENT_SQL(eventId, observation));
      const second = b.send(EVENT_SQL(eventId, observation));
      await blockedOnLock(b.pid);
      await a.ok("commit;");
      const answer = await second;
      await b.ok("commit;");
      a.close();
      b.close();
      assert.equal(lastLine(first), "recorded|applied");
      assert.equal(lastLine(answer.rows), "duplicate|applied");
      assert.equal(
        sql(
          `select count(*) from public.external_event_receipts where provider_event_reference = '${eventId}';`,
        ),
        "1",
      );
      assert.equal(
        sql(
          `select count(*) from public.audit_events where resource_id = '${id}' and action_code = 'payment.authorized';`,
        ),
        "1",
      );
      assert.equal(paymentOf(id).state, "authorized");
      report.concurrency.duplicate_webhook = {
        first: lastLine(first),
        second: lastLine(answer.rows),
      };
    },
  );

  await check(
    "CC-2 (TA section 13 payment capture/refund boundary; PM rows 3-5) a capture request racing a release (the client's withdrawal), in both orders: the second waits on the attorney lock, then finds the payment no longer authorized; exactly one of capture_pending or release_pending, with exactly one open job",
    async () => {
      const outcomes = {};
      for (const order of ["capture_first", "release_first"]) {
        const p = authorizedPayment({ jurisdiction: world.J.A });
        const owner = await session(`cc2-owner-${order}`);
        const client = await clientSession(`cc2-client-${order}`, p.client);
        await owner.ok("begin;");
        const captureSql = `select public.payment_request_capture('${p.payment}');`;
        const withdrawSql = `select outcome from public.request_withdraw('${p.request}');`;
        let captureAnswer;
        let withdrawAnswer;
        if (order === "capture_first") {
          captureAnswer = lastLine(await owner.ok(captureSql));
          const pending = client.send(withdrawSql);
          await blockedOnLock(client.pid);
          await owner.ok("commit;");
          withdrawAnswer = lastLine((await pending).rows);
          await client.ok("commit;");
        } else {
          withdrawAnswer = lastLine(await client.ok(withdrawSql));
          const pending = owner.send(captureSql);
          await blockedOnLock(owner.pid);
          await client.ok("commit;");
          captureAnswer = lastLine((await pending).rows);
          await owner.ok("commit;");
        }
        owner.close();
        client.close();
        const state = paymentOf(p.payment).state;
        const jobs = sql(
          `select string_agg(job_type, ',' order by job_type) from public.operational_jobs where subject_id = '${p.payment}' and state in ('pending', 'running', 'escalated');`,
        );
        outcomes[order] = { captureAnswer, withdrawAnswer, state, jobs };
        assert.equal(withdrawAnswer, "withdrawn");
        if (order === "capture_first") {
          assert.deepEqual(
            [captureAnswer, state, jobs],
            ["capture_requested", "capture_pending", "payment.capture"],
          );
        } else {
          assert.deepEqual(
            [captureAnswer, state, jobs],
            ["not_authorized", "release_pending", "payment.release"],
          );
        }
      }
      report.concurrency.capture_vs_release = outcomes;
      return outcomes;
    },
  );

  await check(
    "CC-3 (TA section 13; PS section 33) two staff refunds racing on one captured payment: the second waits on the payment row, then answers refund_in_progress; one refund request, one job, and the refunded amount never exceeds the captured amount",
    async () => {
      const p = capturedPayment({ jurisdiction: world.J.A });
      const a = await staffSession("cc3a", world.finance);
      const b = await staffSession("cc3b", world.otherFinance);
      const refundSql = (reason) =>
        `select outcome from public.staff_request_refund('${p.payment}', 3000, 0, 0, 0, ${lit(reason)});`;
      const first = lastLine(await a.ok(refundSql("Synthetic first reason")));
      const second = b.send(refundSql("Synthetic second reason"));
      await blockedOnLock(b.pid);
      await a.ok("commit;");
      const answer = lastLine((await second).rows);
      await b.ok("commit;");
      a.close();
      b.close();
      assert.deepEqual([first, answer], ["requested", "refund_in_progress"]);
      assert.equal(
        sql(
          `select count(*) from public.audit_events where resource_id = '${p.payment}' and action_code = 'payment.refund_requested';`,
        ),
        "1",
      );
      assert.equal(
        sql(
          `select count(*) from public.operational_jobs where job_type = 'payment.refund' and subject_id in (select id from public.audit_events where resource_id = '${p.payment}');`,
        ),
        "1",
      );
      const payment = paymentOf(p.payment);
      assert.ok(payment.amount_refunded_minor <= payment.amount_captured_minor);
      report.concurrency.refund_race = { first, second: answer };
    },
  );

  await check(
    "CC-4 (PM rows 3-5; TA section 14 B3) a withdrawal racing the provider's authorization confirmation, in both orders: the second waits on the attorney lock; the end state is the same (Request cancelled, the attempt release_pending with the authorization recorded, nothing captured) and the release is enqueued exactly once",
    async () => {
      const outcomes = {};
      for (const order of ["withdraw_first", "authorization_first"]) {
        const s = newRequest({ jurisdiction: world.J.A });
        const id = authorize(s.client, s.request).payment;
        runJob("payment.checkout", "payment_transaction", id, () =>
          obs("checkout_open", { checkout_reference: checkoutRef() }),
        );
        const reference = paymentRef();
        const eventId = `evt_synthetic_cc4_${uid().slice(0, 8)}`;
        const observation = obs("authorization_confirmed", {
          payment_transaction_id: id,
          payment_reference: reference,
          amount_minor: 5225,
          currency_code: "XTS",
        });
        const client = await clientSession(`cc4-client-${order}`, s.client);
        const service = await serviceSession(`cc4-service-${order}`);
        const withdrawSql = `select outcome from public.request_withdraw('${s.request}');`;
        let withdrawAnswer;
        let eventAnswer;
        if (order === "withdraw_first") {
          withdrawAnswer = lastLine(await client.ok(withdrawSql));
          const pending = service.send(EVENT_SQL(eventId, observation));
          await blockedOnLock(service.pid);
          await client.ok("commit;");
          eventAnswer = lastLine((await pending).rows);
          await service.ok("commit;");
        } else {
          eventAnswer = lastLine(
            await service.ok(EVENT_SQL(eventId, observation)),
          );
          const pending = client.send(withdrawSql);
          await blockedOnLock(client.pid);
          await service.ok("commit;");
          withdrawAnswer = lastLine((await pending).rows);
          await client.ok("commit;");
        }
        client.close();
        service.close();
        const payment = paymentOf(id);
        const releases = sql(
          `select count(*) from public.operational_jobs where job_type = 'payment.release' and subject_id = '${id}';`,
        );
        outcomes[order] = {
          withdrawAnswer,
          eventAnswer,
          request: requestStateOf(s.request),
          payment: payment.state,
          releases,
        };
        assert.equal(withdrawAnswer, "withdrawn");
        assert.equal(eventAnswer, "recorded|applied");
        assert.equal(requestStateOf(s.request), "cancelled");
        assert.deepEqual(
          [
            payment.state,
            payment.amount_authorized_minor,
            payment.provider_payment_reference,
            payment.amount_captured_minor,
          ],
          ["release_pending", 5225, reference, null],
        );
        assert.equal(releases, "1");
      }
      report.concurrency.withdrawal_vs_authorization = outcomes;
      return outcomes;
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
    world.staff = newAccount();
    sql("select public.record_deployment_environment('development', null);");
    report.environment = sql(
      "select environment_class from public.deployment_environment;",
    );
    seed();
    await migrationChecks();
    await flowChecks();
    await provenanceChecks();
    await lifecycleChecks();
    await authorizationChecks();
    await captureChecks();
    await refundChecks();
    await webhookChecks();
    await disputeAndReleaseChecks();
    await accessChecks();
    await productionChecks();
    await concurrencyChecks();
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
