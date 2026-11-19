// MVP-001 S9 disposable PostgreSQL proof (M11 Consultation / Media).
// Explicitly invoked only:
//
//   node apps/web/tests/mvp-001-s9-db-proof.mjs
//
// Deliberately not a *.test.mjs file, so no application test run, p0:test,
// or CI job starts it. It uses Node built-ins and the system-installed
// PostgreSQL 16 initdb, pg_ctl, and psql binaries.
//
// It creates a new mode-0700 temporary directory, initializes a new cluster
// owned by an unprivileged account (never root), and starts it with TCP
// disabled and a private Unix-domain socket (port 54345, so it can run next
// to the MVP-001 S8 proof). The roles anon, authenticated, and service_role
// (BYPASSRLS), the synthetic auth schema (auth.users and an auth.uid() that
// reads request.jwt.claim.sub), the hosted platform's default privileges,
// and a no-op public.rls_auto_enable() are synthetic objects of this cluster
// only. Every migration is applied unmodified, in order, each in one
// transaction, to two databases: the main database records its environment
// as development; a second one records production (a synthetic 20-letter
// project reference) for the production gate probes. The three S9
// migrations must follow S8 and be registered.
//
// Configuration: every policy version of the development database is
// development configuration created by the owner role inside this disposable
// cluster (Packet rule 9). The two S9 timing keys
// (consultation_join_window_seconds, consultation_overrun_seconds), the
// engagement parameters (G-5, G-1) and the payment_flow parameters (G-2/G-3)
// differ per synthetic jurisdiction so that every configured path is
// exercised both ways; they, the XTS test currency code, the synthetic_*
// modality codes, the SYN_* Regulatory Modes and every Request, payment,
// room, provider session reference, participant reference and exception are
// synthetic test data (FP-1 section 3.4), never product values or decisions.
// The production database uses owner-walked authority versions with a
// synthetic verified reference, or development rows planted with triggers
// bypassed for the negative probes; its Consultation fixtures are planted by
// the owner with triggers bypassed (the production gate, not the fixture, is
// what the probes examine).
//
// The providers are simulated: the probes play the worker (claim a job as the
// owner, read payment_job_context or media_job_context and record results
// through payment_record_operation or media_record_operation as service_role)
// and the webhook routes (payment_record_provider_event and
// media_record_provider_event as service_role). No provider, Supabase
// project, network service or pre-existing cluster is contacted, and nothing
// persists after the run. Some probes shift a fixture Consultation's recorded
// times as the owner with triggers bypassed (the proof cannot wait the 35
// minutes a permitted window lasts), and ENG-1 removes an Engagement S8
// recorded so the start alone decides; each says so.
//
// Request sessions are modelled as PostgREST sets them from a verified JWT:
// request.jwt.claim.sub and the JSON request.jwt.claims (clients at aal1,
// attorneys at aal2 unless a probe says otherwise); anonymous requests run as
// anon without a subject.
//
// The probes cover the MVP-001 Packet S9 acceptance for the database: every
// MBS section 14 failure test (named MBS14-1 .. MBS14-4 in the probes), the
// IMP section 25 exit (a consultation conducted end to end without direct
// database intervention, a reconnect that never duplicates the Consultation,
// provider disagreement that creates reconciliation, never silent
// correction), the server-controlled timing both ways, exactly one Media Room
// per Consultation, media authorization, the start and end preconditions with
// each capture moment (PM rows 19 and 20 and INV-1, INV-11, INV-12, INV-13),
// participation evidence idempotency and stale observations, the production
// gate, audit minimization, and the race list under real concurrency with two
// or more persistent sessions, with the exact observed outcomes. The
// correction probes (F1 to F8 of the S9 review) are named with "correction"
// in their titles: ROOM-4, TIME-4, ENG-1, END-4, OBS-1 and PROD-2, and the
// amended ACC, ST, TIME, MBS14-1, EXIT-1 and PROD-1 probes. The JSON
// report goes to stdout; exit 0 means PASS, 1 FAIL, 2 cleanup failure.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54345;
const DB = "rosuno_s9_proof";
const PROD_DB = "rosuno_s9_proof_production";
const PRODUCTION_REF = "syntheticnineprodref";
const REPOSITORY_ROOT = path.resolve(
  path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
  "../../..",
);
const MIGRATIONS = path.join(REPOSITORY_ROOT, "supabase/migrations");
const S8_LAST = "20261124030000_mvp_001_s8_change_review.sql";
const S9_MIGRATIONS = Object.freeze([
  "20261125010000_mvp_001_s9_media_integrity.sql",
  "20261125020000_mvp_001_s9_consultation_media.sql",
  "20261125030000_mvp_001_s9_media_evidence.sql",
]);
// MVP-001 S10: the five S10 migrations follow the S9 migrations (applied by
// this proof as later registered migrations; registered and checked by the
// S10 proof).
const S10_MIGRATIONS = Object.freeze([
  "20261126010000_mvp_001_s10_communication_integrity.sql",
  "20261126020000_mvp_001_s10_notifications.sql",
  "20261126030000_mvp_001_s10_messages.sql",
  "20261126040000_mvp_001_s10_documents.sql",
  // MVP-001 S10 (PS-A5): the document version lineage.
  "20261126050000_mvp_001_s10_document_versioning.sql",
]);

const report = {
  proof: "MVP-001 S9 disposable local PostgreSQL proof",
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
    path.join(os.tmpdir(), "rosuno-mvp-001-s9-db-proof-"),
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
    if (S9_MIGRATIONS.includes(file)) {
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
  // S9 follows S8, contiguous and in order, and every S9 migration is
  // registered unreviewed (sequences 47 to 49) and applied nowhere. MVP-001
  // S10: then exactly the five S10 migrations (registered and checked by the
  // S10 proof).
  const s8 = files.indexOf(S8_LAST);
  assert.ok(s8 >= 0, "the last S8 migration is present");
  assert.deepEqual(files.slice(s8 + 1), [...S9_MIGRATIONS, ...S10_MIGRATIONS]);
  const workItems = JSON.parse(
    fs.readFileSync(
      path.join(REPOSITORY_ROOT, "governance/work-items/index.json"),
      "utf8",
    ),
  ).work_items;
  const program = workItems.find(
    (item) => item.work_item_id === "WI-P2-MVP-001-TECHNICAL-COMPLETION",
  );
  S9_MIGRATIONS.forEach((file, index) => {
    const id = file.replace(/\.sql$/, "");
    const row = registered.find(
      (migration) => migration.artifact_path === `supabase/migrations/${file}`,
    );
    assert.ok(row, `${file} is registered`);
    assert.equal(row.migration_id, id);
    assert.equal(row.sequence, 47 + index);
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
  report.migrations.s9 = [...S9_MIGRATIONS];
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
    const mark = `__S9_${this.label}_${this.n}__`;
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
    process.stderr.write(`[s9-proof] PASS ${name}\n`);
  } catch (error) {
    failed = true;
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
    process.stderr.write(`[s9-proof] FAIL ${name}\n${error?.stack ?? error}\n`);
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
      `insert into public.licenses (id, attorney_id, jurisdiction_id, license_number, reported_status) values ('${licence}', '${profile}', '${jurisdiction}', 'SYN-S9-LIC-${String(licenceNumber).padStart(4, "0")}', 'synthetic-active');
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
    `update public.operational_jobs set state = 'running', locked_at = now(), locked_by = 's9-proof', attempt_count = attempt_count + 1, available_at = now() + interval '60 seconds' where id = '${jobId}';`,
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
    `select public.job_complete('${jobId}', 's9-proof');`,
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

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// S9 configuration, seed and call helpers
// ---------------------------------------------------------------------------

const ENGAGEMENT = (creation, effective) => ({
  consultation_creation: creation,
  engagement_effective: effective,
});
const FLOW_ALL = (authorization, capture) =>
  FLOW(authorization, authorization, capture);
// The two S9 timing keys of the scheduling policy (synthetic test values).
const TIMING = (join, overrun) => ({
  consultation_join_window_seconds: join,
  consultation_overrun_seconds: overrun,
});
// Near-term scheduled slots are allowed in these synthetic jurisdictions.
const NEAR = Object.freeze({
  minimum_notice_seconds: 0,
  hold_pre_slot_interval_seconds: 0,
});
const STANDARD = ENGAGEMENT("attorney_acceptance", "at_consultation_start");

// The synthetic configuration of each jurisdiction (test values only; G-1,
// G-2, G-3, G-5 and the S9 timing keys stay configuration).
const JURISDICTIONS = Object.freeze({
  // Capture at the attorney's acceptance; the Engagement effective at the
  // consultation start (S8 left this moment to S9).
  A: {
    flow: FLOW_ALL(BEFORE, "at_attorney_acceptance"),
    engagement: STANDARD,
    scheduling: SCHEDULING(TIMING(600, 300)),
  },
  // Capture at the consultation start; near-term scheduled slots, a 600-second
  // join window.
  G: {
    flow: FLOW_ALL(BEFORE, "at_consultation_start"),
    engagement: STANDARD,
    scheduling: SCHEDULING({ ...TIMING(600, 300), ...NEAR }),
  },
  // Capture at the consultation completion; the Engagement effective at the
  // acceptance.
  C: {
    flow: FLOW_ALL(BEFORE, "at_consultation_completion"),
    engagement: ENGAGEMENT("attorney_acceptance", "at_attorney_acceptance"),
    scheduling: SCHEDULING(TIMING(600, 300)),
  },
  // Capture at the authorization; the Engagement effective at the Request.
  U: {
    flow: FLOW_ALL(BEFORE, "at_authorization"),
    engagement: ENGAGEMENT("attorney_acceptance", "at_request"),
    scheduling: SCHEDULING(TIMING(600, 300)),
  },
  // The Consultation only once the payment is captured (S8 deferred
  // creation); capture at acceptance.
  D: {
    flow: FLOW_ALL(BEFORE, "at_attorney_acceptance"),
    engagement: ENGAGEMENT(
      "attorney_acceptance_and_payment_captured",
      "at_payment_capture",
    ),
    scheduling: SCHEDULING(TIMING(600, 300)),
  },
  // No S9 timing keys (fail closed).
  N: {
    flow: FLOW_ALL(BEFORE, "at_consultation_start"),
    engagement: STANDARD,
    scheduling: SCHEDULING(NEAR),
  },
  // A malformed join window (outside 0..86400).
  M: {
    flow: FLOW_ALL(BEFORE, "at_consultation_start"),
    engagement: STANDARD,
    scheduling: SCHEDULING({ ...TIMING(90000, 300), ...NEAR }),
  },
  // A zero join window and no overrun; near-term scheduled slots.
  T: {
    flow: FLOW_ALL(BEFORE, "at_consultation_start"),
    engagement: STANDARD,
    scheduling: SCHEDULING({ ...TIMING(0, 0), ...NEAR }),
  },
  // Eligibility probes (a licence status change).
  E: {
    flow: FLOW_ALL(BEFORE, "at_consultation_start"),
    engagement: STANDARD,
    scheduling: SCHEDULING(TIMING(600, 300)),
  },
  // Eligibility probes (the eligibility version is closed: undetermined).
  F: {
    flow: FLOW_ALL(BEFORE, "at_consultation_start"),
    engagement: STANDARD,
    scheduling: SCHEDULING(TIMING(600, 300)),
  },
  // Ending without the timing configuration (END-4 closes this scheduling
  // version once its Consultation is live).
  X: {
    flow: FLOW_ALL(BEFORE, "at_attorney_acceptance"),
    engagement: STANDARD,
    scheduling: SCHEDULING(TIMING(600, 300)),
  },
});

function seed() {
  world.mode = newRegulatoryMode("SYN_S9_MARKETPLACE");
  world.J = {};
  world.policies = {};
  world.policies.bookability = policy("bookability", null, {
    presence_window_seconds: 600,
  });
  world.platform = policy("fee", null, PLATFORM);
  for (const [key, config] of Object.entries(JURISDICTIONS)) {
    const id = newJurisdiction(`SYN_S9_${key}`);
    world.J[key] = id;
    const versions = {};
    versions.eligibility = policy("eligibility", id, ELIGIBILITY);
    versions.scheduling = policy("scheduling", id, config.scheduling);
    versions.referral = policy("referral", id, {
      outcome_codes: ["synthetic_closed"],
    });
    versions.fee = policy("fee", id, FEE());
    mapMode(id, world.mode);
    versions.payment_flow = policy("payment_flow", id, config.flow, world.mode);
    for (const type of ["payment", "cancellation", "refund"]) {
      versions[type] = policy(type, id, {}, world.mode);
    }
    versions.engagement = policy(
      "engagement",
      id,
      config.engagement,
      world.mode,
    );
    world.policies[key] = versions;
  }
  world.ann = attorney({
    name: "Ann Synthetic",
    jurisdictions: Object.values(world.J),
  });
  world.grantor = newAccount();
  sql(
    `insert into public.staff_profiles (user_id, staff_state) values ('${world.grantor.user}', 'active');`,
  );
  world.policyAdmin = newAccount();
  sql(
    `insert into public.staff_profiles (user_id, staff_state) values ('${world.policyAdmin.user}', 'active');
     insert into public.capability_grants (user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at)
       values ('${world.policyAdmin.user}', 'manage_policy_configuration', '${world.grantor.user}', null, now() - interval '1 day');`,
  );
}

let lawyers = 0;
// A new approved attorney licensed in the given jurisdictions (by key).
function lawyer(...keys) {
  lawyers += 1;
  return attorney({
    name: `Synthetic Attorney ${lawyers}`,
    jurisdictions: keys.map((key) => world.J[key]),
  });
}

const asAttorney = (lawyer, statement, options = {}) =>
  as("authenticated", lawyer.auth, statement, options);
const rowsAsAttorney = (lawyer, statement, options = {}) =>
  rowsAs("authenticated", lawyer.auth, statement, options);

const ACCEPT_SQL = (request) =>
  `select outcome || '|' || coalesce(consultation_id::text, '') || '|' || coalesce(problem, '') from public.attorney_accept_request(${lit(request)});`;
const DECLINE_SQL = (request) =>
  `select outcome from public.attorney_decline_request(${lit(request)});`;
const WITHDRAW_SQL = (request) =>
  `select outcome from public.request_withdraw(${lit(request)});`;

function parseAccept(line) {
  const [outcome, consultation, problem] = (line ?? "").split("|");
  return {
    outcome,
    consultation: consultation || null,
    problem: problem || null,
  };
}

const accept = (lawyer, request, options = {}) =>
  parseAccept(asAttorney(lawyer, ACCEPT_SQL(request), options));
const decline = (lawyer, request, options = {}) =>
  asAttorney(lawyer, DECLINE_SQL(request), options);

// A real Request through request_create, for a given or new client, from a
// new owner-fixture Referral.
function makeRequest({
  jurisdiction,
  requestPath = "scheduled",
  lawyer = world.ann,
  client = null,
  message = null,
  slot: slotAt = null,
}) {
  const owner = client ?? newClient();
  const referral = ownerReferral({
    client: owner,
    lawyer,
    jurisdiction,
    requestPath,
  });
  const slot = requestPath === "scheduled" ? (slotAt ?? nextSlot()) : null;
  const line = asClient(
    owner,
    `select outcome || '|' || coalesce(request_id::text, '') || '|' || coalesce(problem, '') from public.request_create(${lit(referral)}, ${lit(requestPath)}, 'synthetic_video', 30, ${slot === null ? "null" : `${lit(slot)}::timestamptz`}, ${message === null ? "null::text" : lit(message)});`,
  );
  const [outcome, request, problem] = line.split("|");
  assert.equal(outcome, "created", `request_create: ${line}`);
  return {
    client: owner,
    referral,
    request,
    problem,
    jurisdiction,
    requestPath,
    lawyer,
    slot,
  };
}

// A Request whose payment is authorized through the real S7 paths (the
// client's authorization, the checkout job and the provider's event), so a
// flow that authorizes before the decision moves it to awaiting_attorney.
function authorizedRequest(options) {
  const scenario = makeRequest(options);
  const created = authorize(scenario.client, scenario.request);
  assert.equal(created.outcome, "created", created.line);
  runJob("payment.checkout", "payment_transaction", created.payment, () =>
    obs("checkout_open", { checkout_reference: checkoutRef() }),
  );
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
  return { ...scenario, payment: created.payment, reference, total };
}

function confirmCapture(scenario) {
  return runJob(
    "payment.capture",
    "payment_transaction",
    scenario.payment,
    () =>
      obs("capture_confirmed", {
        payment_reference: scenario.reference,
        amount_minor: scenario.total,
        currency_code: "XTS",
      }),
  );
}

const rowOf = (table, where) =>
  jsonOf(
    `select row_to_json(t)::text from public.${table} t where ${where} limit 1;`,
  );
const requestOf = (id) => rowOf("consultation_requests", `id = '${id}'`);
const holdOf = (request) =>
  rowOf("slot_holds", `consultation_request_id = '${request}'`);
const consultationOf = (request) =>
  rowOf("consultations", `consultation_request_id = '${request}'`);
const bookingsOf = (consultation) =>
  jsonOf(
    `select coalesce(json_agg(row_to_json(b) order by b.created_at), '[]'::json)::text from public.bookings b where consultation_id = '${consultation}';`,
  );
const engagementsOf = (consultation) =>
  jsonOf(
    `select coalesce(json_agg(row_to_json(g) order by g.created_at), '[]'::json)::text from public.engagements g where consultation_id = '${consultation}';`,
  );
const livePaymentOf = (request) =>
  rowOf(
    "payment_transactions",
    `consultation_request_id = '${request}' order by created_at desc`,
  );
const auditsOf = (resourceId, action) =>
  jsonOf(
    `select coalesce(json_agg(json_build_object('actor_type', actor_type, 'actor_user_id', actor_user_id, 'reason_code', reason_code, 'after', after_snapshot, 'before', before_snapshot, 'policy_references', policy_references) order by occurred_at, id), '[]'::json)::text from public.audit_events where resource_id = '${resourceId}' and action_code = ${lit(action)};`,
  );
const ms = (timestamp) => new Date(timestamp).getTime();

// Counts that a refusal must leave unchanged.
const WRITE_TABLES = Object.freeze([
  "consultations",
  "engagements",
  "bookings",
  "eligibility_evaluations",
  "bookability_evaluations",
  "audit_events",
  "payment_transactions",
  "operational_jobs",
  "reconciliation_exceptions",
]);
const writeCounts = () =>
  Object.fromEntries(
    WRITE_TABLES.map((t) => [
      t,
      Number(sql(`select count(*) from public.${t};`)),
    ]),
  );

async function attorneySession(label, account, aal = "aal2") {
  const s = await session(label);
  const claims = JSON.stringify({
    sub: account.auth,
    role: "authenticated",
    aal,
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

async function serviceSession(label) {
  const s = await session(label);
  await s.ok("begin;");
  await s.ok("set local role service_role;");
  return s;
}

async function ownerSession(label) {
  const s = await session(label);
  await s.ok("begin;");
  return s;
}

const lastLine = (rows) => rows[rows.length - 1];

async function untilPast(timestamp) {
  const target = ms(timestamp) + 300;
  while (Date.now() < target) {
    await sleep(100);
  }
}

const EVENT_SQL = (eventId, observation) =>
  `select outcome || '|' || coalesce(processing_state, '') from public.payment_record_provider_event('stripe', ${lit(eventId)}, 'payment_intent.amount_capturable_updated', now(), ${lit(`sha256:${sha256(eventId)}`)}, ${lit(observation)}::jsonb);`;

// ---------------------------------------------------------------------------
// S9 helpers
// ---------------------------------------------------------------------------

// A scheduled slot starting in about `seconds` (whole seconds, UTC).
const nearSlot = (seconds) =>
  new Date(
    Math.ceil((Date.now() + seconds * 1000) / 1000) * 1000,
  ).toISOString();
const isoAgo = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();
const isoIn = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();
// A database timestamp in the observed-instant form of the media vocabulary.
const instantOf = (timestamp) => new Date(timestamp).toISOString();

// A Consultation accepted through the real S6, S7 and S8 paths: the client's
// Request and payment authorization, the attorney's acceptance and, when the
// acceptance asked for it, the confirmed capture.
function acceptedConsultation({
  key,
  requestPath = "instant",
  who,
  slot = null,
  capture = true,
  client = null,
}) {
  const s = authorizedRequest({
    jurisdiction: world.J[key],
    requestPath,
    lawyer: who,
    slot,
    client,
  });
  const decision = accept(who, s.request);
  assert.equal(decision.outcome, "accepted", JSON.stringify(decision));
  if (capture && livePaymentOf(s.request).state === "capture_pending") {
    confirmCapture(s);
  }
  const consultation = consultationOf(s.request);
  return { ...s, lawyer: who, consultation: consultation?.id ?? null };
}

const roomOf = (consultation) =>
  rowOf("media_rooms", `consultation_id = '${consultation}'`);
const roomName = (roomId) => `r${roomId.replaceAll("-", "")}`;
const consultationRow = (consultation) =>
  rowOf("consultations", `id = '${consultation}'`);

function jsonAs(account, statement, options) {
  const line = as("authenticated", account.auth, statement, options);
  return line.startsWith("ERROR") ? line : JSON.parse(line);
}

const ACCESS_SQL = (c) =>
  `select row_to_json(x)::text from public.consultation_media_access(${lit(c)}) x;`;
const START_SQL = (c) =>
  `select row_to_json(x)::text from public.consultation_start(${lit(c)}) x;`;
const END_SQL = (c) =>
  `select row_to_json(x)::text from public.consultation_end(${lit(c)}) x;`;
const CLIENT_VIEW_SQL = (c) =>
  `select row_to_json(x)::text from public.client_consultation(${lit(c)}) x;`;
const ATTORNEY_VIEW_SQL = (c) =>
  `select row_to_json(x)::text from public.attorney_consultation(${lit(c)}) x;`;

const clientAccess = (s) =>
  jsonAs(s.client, ACCESS_SQL(s.consultation), { aal: "aal1" });
const attorneyAccess = (s, options = {}) =>
  jsonAs(s.lawyer, ACCESS_SQL(s.consultation), options);
const start = (s, options = {}) =>
  jsonAs(s.lawyer, START_SQL(s.consultation), options);
const end = (s, options = {}) =>
  jsonAs(s.lawyer, END_SQL(s.consultation), options);
// The one row a participant read answers, or null when it answers none.
function oneRowAs(account, statement, options) {
  const rows = rowsAs("authenticated", account.auth, statement, options);
  assert.ok(rows.length <= 1, statement);
  return rows.length === 0 ? null : JSON.parse(rows[0]);
}
const clientView = (s) =>
  oneRowAs(s.client, CLIENT_VIEW_SQL(s.consultation), { aal: "aal1" });
const attorneyView = (s, options = {}) =>
  oneRowAs(s.lawyer, ATTORNEY_VIEW_SQL(s.consultation), options);

function mediaContextOf(jobId) {
  return JSON.parse(
    as(
      "service_role",
      null,
      `select row_to_json(c)::text from public.media_job_context('${jobId}') c;`,
    ),
  );
}

function mediaRecord(jobId, observation) {
  return as(
    "service_role",
    null,
    `select public.media_record_operation('${jobId}', 'daily', ${lit(observation)}::jsonb);`,
  );
}

// Runs one open media job end to end with a simulated provider result.
function runMediaJob(type, roomId, resultOf) {
  const job = openJob(type, "media_room", roomId);
  assert.ok(job, `an open ${type} job for ${roomId}`);
  claimJob(job);
  const context = mediaContextOf(job);
  const observation = resultOf(context);
  const outcome = observation === null ? null : mediaRecord(job, observation);
  assert.equal(completeJob(job), "completed");
  return { job, context, outcome };
}

function openRoom(roomId) {
  const run = runMediaJob("media.room_create", roomId, (context) => ({
    kind: "room_created",
    room_name: context.room_name,
    expires_at: instantOf(context.expires_at),
  }));
  assert.equal(run.outcome, "applied", JSON.stringify(run));
  return run;
}

let mediaEvents = 0;
const MEDIA_EVENT_SQL = (eventId, eventType, observation) =>
  `select outcome || '|' || coalesce(processing_state, '') from public.media_record_provider_event('daily', ${lit(eventId)}, ${lit(eventType)}, now(), ${lit(`sha256:${sha256(eventId)}`)}, ${lit(observation)}::jsonb);`;

// The probe plays the media webhook route: one authenticated provider event.
function mediaEvent(eventType, observation, eventId = null) {
  mediaEvents += 1;
  const id =
    eventId ?? `daily_${sha256(`${mediaEvents}-${uid()}`).slice(0, 40)}`;
  const line = as(
    "service_role",
    null,
    MEDIA_EVENT_SQL(id, eventType, observation),
  );
  const [outcome, processing] = line.split("|");
  return { id, outcome, processing, line };
}

const participantRef = () => `p-${uid()}`;
const sessionRef = () => `m-${uid()}`;

function itemsOf(type, consultation) {
  return jsonOf(
    `select coalesce(json_agg(json_build_object('severity', severity, 'status', status, 'source_type', source_type, 'canonical_type', canonical_type, 'evidence', evidence_reference) order by detected_at, id), '[]'::json)::text from public.reconciliation_exceptions where exception_type = ${lit(type)} and canonical_id = '${consultation}';`,
  );
}

const S9_TABLES = Object.freeze([
  ...WRITE_TABLES,
  "media_rooms",
  "media_sessions",
  "session_participation_records",
  "external_event_receipts",
]);
const s9Counts = () =>
  Object.fromEntries(
    S9_TABLES.map((t) => [t, Number(sql(`select count(*) from public.${t};`))]),
  );

// Fixture time shift (owner, triggers bypassed): the proof cannot wait the
// 35 minutes a permitted window lasts, so the Consultation's recorded
// creation (and start) move into the past.
function shiftConsultation(consultation, minutes) {
  sql(
    `begin;
     set local session_replication_role = replica;
     update public.consultations set created_at = created_at - interval '${minutes} minutes', started_at = started_at - interval '${minutes} minutes' where id = '${consultation}';
     commit;`,
  );
}

const SWEEP_SQL = "select public.consultation_media_sweep()::text;";
const sweep = () => JSON.parse(sql(SWEEP_SQL));

// ---------------------------------------------------------------------------
// MIG and PRIV: migrations, catalog and privileges
// ---------------------------------------------------------------------------

const S9_AUTHENTICATED_API = Object.freeze([
  "consultation_media_access(uuid)",
  "consultation_start(uuid)",
  "consultation_end(uuid)",
  "client_consultation(uuid)",
  "attorney_consultation(uuid)",
  "attorney_consultations()",
]);

const S9_SERVICE_API = Object.freeze([
  "media_job_context(uuid)",
  "media_record_operation(uuid, text, jsonb)",
  "media_record_provider_event(text, text, text, timestamp with time zone, text, jsonb)",
]);

const S9_INTERNAL = Object.freeze([
  "consultation_context(uuid)",
  "consultation_media_lifecycle()",
  "consultation_media_sweep()",
  "consultation_participation(uuid)",
  "consultation_ready_if_due(uuid, boolean)",
  "consultation_timing(uuid, timestamp with time zone)",
  "consultation_timing_policy(uuid, timestamp with time zone)",
  "consultation_view(uuid)",
  "consultation_window(text, timestamp with time zone, timestamp with time zone, integer, timestamp with time zone, timestamp with time zone, integer, integer)",
  "decision_record_engagement_if_due(consultations, jsonb, consultation_requests, timestamp with time zone, uuid)",
  "media_apply_observation(uuid, text, jsonb, text, uuid)",
  "media_exact_keys(jsonb, text[])",
  "media_instant_valid(jsonb)",
  "media_observation_valid(jsonb)",
  "media_production_problem(uuid, jsonb, timestamp with time zone)",
  "media_record_participant(media_rooms, uuid, uuid, uuid, text, uuid, timestamp with time zone, timestamp with time zone, uuid, timestamp with time zone, text, text, uuid)",
  "media_record_session(media_rooms, text, text, timestamp with time zone, timestamp with time zone, uuid, timestamp with time zone, text, text, uuid)",
  "media_reference_valid(jsonb)",
  "media_result_max(text, text)",
  "media_room_integrity()",
  "media_room_name_valid(jsonb)",
  "media_room_of_provider_name(text)",
  "media_room_provider_name(uuid)",
  "media_session_integrity()",
  "media_user_reference_valid(jsonb)",
  "policy_parameters_approvable(text, uuid, jsonb)",
  "session_participation_append_only()",
]);

const executors = (signature) =>
  sql(
    `select coalesce(string_agg(r.rolname, ',' order by r.rolname), '') from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') and has_function_privilege(r.rolname, 'public.${signature}', 'execute');`,
  );

const MEDIA_TABLES = Object.freeze([
  "media_rooms",
  "media_sessions",
  "session_participation_records",
]);

async function migrationChecks() {
  await check(
    "MIG-1 the three S9 migrations follow S8 in order, are registered unreviewed (sequences 47 to 49) and applied nowhere, are Program migration refs, and apply on plain PostgreSQL to a development and a production-class database; the only notice is the consultation migration's pg_cron absence (the schedule is registered only where pg_cron exists)",
    () => {
      assert.deepEqual(report.migrations.s9, [...S9_MIGRATIONS]);
      assert.deepEqual(report.migrations.notices, {
        [S9_MIGRATIONS[0]]: [],
        [S9_MIGRATIONS[1]]: [
          "pg_cron is not available: no schedule registered (commands and reads still evaluate consultation timing)",
        ],
        [S9_MIGRATIONS[2]]: [],
      });
      return report.migrations.notices;
    },
  );

  await check(
    "MIG-2 no relation, column, type, row policy, view, sequence, policy type, capability or seed row is added (Packet rules 8, 10 and 16): the S9 texts create none and insert into no catalog table; the consultations, media_rooms, media_sessions and session_participation_records columns are the P1 ones; the policy type catalog is unchanged; the only new index is the participation idempotency index and two lookup indexes",
    () => {
      for (const file of S9_MIGRATIONS) {
        const text = fs
          .readFileSync(path.join(MIGRATIONS, file), "utf8")
          .replace(/--[^\n]*/g, "");
        assert.doesNotMatch(
          text,
          /create\s+table|add\s+column|create\s+type|create\s+policy|create\s+view|create\s+sequence|insert\s+into\s+public\.(policy_types|policy_versions|capability_definitions|capability_grants|deployment_environment|jurisdictions|practice_areas|regulatory_modes)/i,
          file,
        );
      }
      const columns = (table) =>
        sql(
          `select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = '${table}';`,
        );
      assert.equal(
        columns("consultations"),
        "id,consultation_request_id,client_id,attorney_id,request_path,referral_policy_version_id,fee_policy_version_id,engagement_policy_version_id,cancellation_policy_version_id,modality,state,started_at,ended_at,outcome_code,created_at,updated_at",
      );
      assert.equal(
        columns("media_rooms"),
        "id,consultation_id,modality,state,created_at,ended_at",
      );
      assert.equal(
        columns("media_sessions"),
        "id,media_room_id,provider_code,provider_session_reference,started_at,ended_at,provider_state,created_at",
      );
      assert.equal(
        columns("session_participation_records"),
        "id,media_session_id,participant_user_id,joined_at,left_at,observed_participation,provider_observation_reference,created_at",
      );
      assert.equal(
        sql(
          "select string_agg(code, ',' order by code) from public.policy_types;",
        ),
        "automated_referral_quality,bookability,cancellation,eligibility,engagement,fee,governance,notification,payment,payment_flow,referral,refund,reporting,retention,scheduling",
      );
      assert.equal(
        sql(
          "select count(*) from pg_policies where schemaname = 'public' and cmd <> 'SELECT';",
        ),
        "0",
      );
      assert.equal(
        sql(
          "select string_agg(indexname, ',' order by indexname) from pg_indexes where schemaname = 'public' and tablename in ('media_rooms', 'media_sessions', 'session_participation_records');",
        ),
        "media_rooms_consultation_id_key,media_rooms_pkey,media_rooms_state_idx,media_sessions_pkey,media_sessions_provider_reference_key,media_sessions_room_started_idx,session_participation_records_observation_unique_idx,session_participation_records_pkey",
      );
    },
  );

  await check(
    "PRIV-1 media_rooms, media_sessions and session_participation_records are function-only: no API role holds INSERT, UPDATE, DELETE or TRUNCATE (SELECT unchanged: authenticated under the P1 participant row policies, service_role; anon none), and direct writes are refused for authenticated and service_role",
    () => {
      for (const table of MEDIA_TABLES) {
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
            role === "anon" ? "f" : "t",
            `${role} SELECT ${table}`,
          );
        }
      }
      for (const role of ["authenticated", "service_role"]) {
        const sub = role === "service_role" ? null : world.ann.auth;
        assert.equal(
          as(role, sub, "update public.media_rooms set state = 'open';"),
          "ERROR 42501",
        );
        assert.equal(
          as(
            role,
            sub,
            "insert into public.media_sessions (media_room_id, provider_code, provider_session_reference, started_at, provider_state) values (gen_random_uuid(), 'daily', 'synthetic', now(), 'ongoing');",
          ),
          "ERROR 42501",
        );
        assert.equal(
          as(role, sub, "delete from public.session_participation_records;"),
          "ERROR 42501",
        );
      }
    },
  );

  await check(
    "PRIV-2 function privileges: the participant functions are security definer, pin their search_path and are executable by authenticated only (the three commands also bound their lock waits); the worker and webhook functions by service_role only; every internal and trigger function by no API role; anon executes nothing S9 adds",
    () => {
      for (const signature of S9_AUTHENTICATED_API) {
        assert.equal(executors(signature), "authenticated", signature);
        assert.equal(
          sql(
            `select prosecdef::text || '|' || exists (select 1 from unnest(proconfig) c where c = 'search_path=pg_catalog, pg_temp')::text from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          "true|true",
          signature,
        );
      }
      for (const signature of S9_SERVICE_API) {
        assert.equal(executors(signature), "service_role", signature);
        assert.equal(
          sql(
            `select prosecdef::text from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          "true",
          signature,
        );
      }
      for (const signature of S9_INTERNAL) {
        assert.equal(executors(signature), "", signature);
      }
      assert.equal(
        sql(
          "select string_agg(p.proname || ':' || array_to_string(p.proconfig, ';'), ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('consultation_media_access', 'consultation_start', 'consultation_end');",
        ),
        "consultation_end:search_path=pg_catalog, pg_temp;lock_timeout=3s,consultation_media_access:search_path=pg_catalog, pg_temp;lock_timeout=3s,consultation_start:search_path=pg_catalog, pg_temp;lock_timeout=3s",
      );
      // The lifecycle trigger runs inside S8's and S7's security definer
      // transactions: it runs as its owner with a fixed search_path.
      assert.equal(
        sql(
          "select prosecdef::text || '|' || array_to_string(proconfig, ';') from pg_proc where oid = 'public.consultation_media_lifecycle()'::regprocedure;",
        ),
        "true|search_path=pg_catalog, pg_temp",
      );
      for (const role of ["anon", "service_role"]) {
        assert.equal(
          as(
            role,
            null,
            "select * from public.consultation_media_access(gen_random_uuid());",
          ),
          "ERROR 42501",
        );
        assert.equal(
          as(
            role,
            null,
            "select * from public.consultation_start(gen_random_uuid());",
          ),
          "ERROR 42501",
        );
      }
      for (const role of ["anon", "authenticated"]) {
        assert.equal(
          as(
            role,
            role === "authenticated" ? world.ann.auth : null,
            "select * from public.media_job_context(gen_random_uuid());",
          ),
          "ERROR 42501",
        );
      }
      assert.equal(
        sql(
          "select string_agg(tgname, ',' order by tgname) from pg_trigger where not tgisinternal and tgrelid in ('public.media_rooms'::regclass, 'public.media_sessions'::regclass, 'public.session_participation_records'::regclass, 'public.consultations'::regclass);",
        ),
        // MVP-001 S10 re-pin: and exactly the readiness notification trigger
        // of the later registered S10 notifications migration
        // (20261126020000), which emits the participants' consultation_ready
        // Notifications when a Consultation becomes ready.
        "consultations_change_guard,consultations_media_lifecycle,consultations_no_truncate,consultations_notification_events,consultations_payment_consistency,consultations_relationship_consistency,consultations_set_updated_at,media_rooms_change_guard,media_rooms_no_truncate,media_sessions_change_guard,media_sessions_no_truncate,session_participation_records_append_only,session_participation_records_no_truncate,session_participation_records_participant_consistency",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// CFG: the two timing keys, approval validation and fail-closed seams
// ---------------------------------------------------------------------------

async function configurationChecks() {
  await check(
    "CFG-1 (Packet rule 6) the timing keys: consultation_join_window_seconds and consultation_overrun_seconds are integers within 0..86400 of the scheduling version the S4 resolver selects; without either (an existing S4 version) or with a malformed one the reader answers policy_incomplete (no default); the S4 scheduling policy itself is unaffected",
    () => {
      const read = (key) =>
        sql(
          `select outcome || '|' || coalesce(join_window_seconds::text, '') || '|' || coalesce(overrun_seconds::text, '') from public.consultation_timing_policy('${world.J[key]}', now());`,
        );
      assert.equal(read("A"), "selected|600|300");
      assert.equal(read("T"), "selected|0|0");
      assert.equal(read("N"), "policy_incomplete||");
      assert.equal(read("M"), "policy_incomplete||");
      assert.equal(
        sql(
          `select outcome from public.scheduling_policy('scheduling', '${world.J.N}', now());`,
        ),
        "selected",
      );
      assert.equal(
        sql(
          `select outcome from public.scheduling_policy('scheduling', '${world.J.M}', now());`,
        ),
        "selected",
      );
      assert.equal(
        sql(
          "select outcome from public.consultation_timing_policy(gen_random_uuid(), now());",
        ),
        "no_applicable_policy",
      );
      const within = (value) =>
        sql(
          `select public.pricing_integer_within(${lit(JSON.stringify(value))}::jsonb, 0, 86400);`,
        );
      assert.deepEqual([0, 86400, 600].map(within), ["t", "t", "t"]);
      assert.deepEqual([-1, 86401, 1.5, "600", null].map(within), [
        "f",
        "f",
        "f",
        "f",
        "f",
      ]);
    },
  );

  await check(
    "CFG-2 approval validation (PS section 8.4): a scheduling version without the S9 keys (every existing one) and one with well-formed keys are approved; one carrying a malformed key answers parameters_invalid and stays in counsel_review; the earlier schemas (engagement) still apply",
    () => {
      const approval = (type, parameters, mode = null) => {
        const id = uid();
        sql(
          `insert into public.policy_versions (id, policy_type_code, jurisdiction_id, regulatory_mode_id, version_label, parameters, status, effective_from, development_only)
           values ('${id}', ${lit(type)}, '${world.J.A}', ${lit(mode)}, ${lit(`synthetic-approval-${id.slice(0, 8)}`)}, ${lit(parameters)}::jsonb, 'draft', now() + interval '30 days', false);
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
      assert.deepEqual(approval("scheduling", SCHEDULING()), {
        outcome: "applied",
        status: "approved",
      });
      assert.deepEqual(approval("scheduling", SCHEDULING(TIMING(900, 600))), {
        outcome: "applied",
        status: "approved",
      });
      for (const bad of [
        SCHEDULING(TIMING(-1, 300)),
        SCHEDULING(TIMING(600, 86401)),
        SCHEDULING({ consultation_join_window_seconds: "600" }),
        SCHEDULING({ consultation_overrun_seconds: 1.5 }),
      ]) {
        assert.deepEqual(
          approval("scheduling", bad),
          { outcome: "parameters_invalid", status: "counsel_review" },
          JSON.stringify(bad),
        );
      }
      assert.deepEqual(
        approval(
          "engagement",
          { consultation_creation: "attorney_acceptance" },
          world.mode,
        ),
        { outcome: "parameters_invalid", status: "counsel_review" },
      );
    },
  );

  await check(
    "CFG-3 (fail closed; MBS section 2.10) without the timing keys nothing opens: an instant Consultation (created ready by S8 with its Media Room) answers configuration_unavailable to media access and to the start (timing_policy_incomplete); a malformed key alike; a scheduled Consultation never becomes ready, neither lazily nor by the sweep; nothing changes",
    () => {
      const who = lawyer("N", "M");
      const instant = acceptedConsultation({ key: "N", who });
      assert.equal(consultationRow(instant.consultation).state, "ready");
      const malformed = acceptedConsultation({ key: "M", who: lawyer("M") });
      const scheduled = acceptedConsultation({
        key: "N",
        requestPath: "scheduled",
        who,
        slot: nearSlot(40),
      });
      assert.equal(consultationRow(scheduled.consultation).state, "scheduled");
      const before = s9Counts();
      const answers = {
        client: clientAccess(instant).outcome,
        attorney: attorneyAccess(instant).outcome,
        start: start(instant),
        malformedStart: start(malformed),
        scheduledAccess: clientAccess(scheduled).outcome,
      };
      assert.deepEqual(answers, {
        client: "configuration_unavailable",
        attorney: "configuration_unavailable",
        start: {
          outcome: "configuration_unavailable",
          problem: "timing_policy_incomplete",
          started_at: null,
        },
        malformedStart: {
          outcome: "configuration_unavailable",
          problem: "timing_policy_incomplete",
          started_at: null,
        },
        scheduledAccess: "configuration_unavailable",
      });
      assert.deepEqual(s9Counts(), before);
      sweep();
      assert.equal(consultationRow(scheduled.consultation).state, "scheduled");
      assert.equal(roomOf(scheduled.consultation), null);
      assert.equal(consultationRow(instant.consultation).state, "ready");
      const view = clientView(scheduled);
      assert.deepEqual(
        [view.state, view.ready_due, view.opens_at, view.closes_at],
        ["scheduled", false, null, null],
      );
      return answers;
    },
  );
}

// ---------------------------------------------------------------------------
// TIME: server-controlled timing
// ---------------------------------------------------------------------------

async function timingChecks() {
  await check(
    "TIME-1 (TA section 48; MBS section 2.8) scheduled -> ready lazily: with a zero join window a scheduled Consultation is not open before its Booking starts (media access not_open_yet with opens_at = the Booking start; the start not_ready) and the read derives nothing early; once the start passes, the read answers ready_due while the state is still scheduled (a read records nothing), and the next command records ready (system actor, reason join_window_open, the scheduling version among the policy references) and creates the one Media Room (pending) with its creation job, answering waiting (correction F4: nothing is granted before the start)",
    async () => {
      const slot = nearSlot(30);
      const s = acceptedConsultation({
        key: "T",
        requestPath: "scheduled",
        who: lawyer("T"),
        slot,
      });
      world.sweepDue = [
        acceptedConsultation({
          key: "T",
          requestPath: "scheduled",
          who: lawyer("T"),
          slot,
        }),
        acceptedConsultation({
          key: "T",
          requestPath: "scheduled",
          who: lawyer("T"),
          slot,
        }),
      ];
      assert.equal(consultationRow(s.consultation).state, "scheduled");
      assert.equal(roomOf(s.consultation), null);
      const early = clientAccess(s);
      assert.equal(early.outcome, "not_open_yet");
      assert.equal(ms(early.opens_at), ms(slot));
      assert.deepEqual(start(s), {
        outcome: "not_ready",
        problem: "scheduled",
        started_at: null,
      });
      const before = clientView(s);
      assert.deepEqual(
        [
          before.state,
          before.ready_due,
          ms(before.opens_at),
          ms(before.closes_at),
        ],
        ["scheduled", false, ms(slot), ms(slot) + 30 * 60000],
      );
      await untilPast(slot);
      const due = attorneyView(s);
      assert.deepEqual([due.state, due.ready_due], ["scheduled", true]);
      assert.equal(consultationRow(s.consultation).state, "scheduled");
      // Correction F4: the command records ready, but nothing is granted
      // before the attorney's start: the waiting room.
      const answer = attorneyAccess(s);
      assert.equal(answer.outcome, "waiting");
      assert.equal(answer.room_name, null);
      assert.equal(consultationRow(s.consultation).state, "ready");
      const room = roomOf(s.consultation);
      assert.equal(room.state, "pending");
      assert.ok(openJob("media.room_create", "media_room", room.id));
      const ready = auditsOf(s.consultation, "consultation.ready");
      assert.deepEqual(
        [ready.length, ready[0].actor_type, ready[0].reason_code],
        [1, "system", "join_window_open"],
      );
      assert.deepEqual(ready[0].policy_references, [
        {
          policy_type_code: "scheduling",
          policy_version_id: world.policies.T.scheduling,
        },
      ]);
      assert.equal(auditsOf(room.id, "media_room.created").length, 1);
      world.lazy = s;
      return { early: early.outcome, after: answer.outcome };
    },
  );

  await check(
    "TIME-2 scheduled -> ready by the database-only sweep: due Consultations become ready with one Media Room each; a row another transaction holds is skipped and counted busy (it stays scheduled until a later run); a second run changes nothing",
    async () => {
      const [first, second] = world.sweepDue;
      const holder = await ownerSession("sweep-holder");
      await holder.ok(
        `select id from public.consultations where id = '${second.consultation}' for update;`,
      );
      const run1 = sweep();
      assert.ok(run1.ready >= 1, JSON.stringify(run1));
      assert.ok(run1.busy >= 1, JSON.stringify(run1));
      assert.equal(consultationRow(first.consultation).state, "ready");
      assert.equal(consultationRow(second.consultation).state, "scheduled");
      await holder.ok("rollback;");
      holder.close();
      const run2 = sweep();
      assert.equal(consultationRow(second.consultation).state, "ready");
      const rooms = count(
        "media_rooms",
        `consultation_id in ('${first.consultation}', '${second.consultation}')`,
      );
      const run3 = sweep();
      assert.equal(run3.ready, 0);
      assert.equal(
        count(
          "media_rooms",
          `consultation_id in ('${first.consultation}', '${second.consultation}')`,
        ),
        rooms,
      );
      assert.equal(rooms, 2);
      return { run1, run2, run3 };
    },
  );

  await check(
    "TIME-3 the permitted window: scheduled = the Booking's start minus the join window (600 s) to its end plus the overrun (300 s), recorded ready at the first command once open, and unchanged by the start, however late (correction F5: never past the booked slot plus the overrun); instant = the Consultation's creation to the creation plus the requested duration plus the overrun; both participants read the same server-computed window",
    () => {
      const slot = nearSlot(40);
      const scheduled = acceptedConsultation({
        key: "G",
        requestPath: "scheduled",
        who: lawyer("G"),
        slot,
      });
      const view = clientView(scheduled);
      assert.deepEqual(
        [view.state, view.ready_due, ms(view.opens_at), ms(view.closes_at)],
        ["scheduled", true, ms(slot) - 600000, ms(slot) + 30 * 60000 + 300000],
      );
      assert.equal(clientAccess(scheduled).outcome, "waiting");
      assert.equal(consultationRow(scheduled.consultation).state, "ready");
      // Correction F5: a start never lengthens a scheduled window; it stays
      // the Booking's end plus the overrun (inside the booked slot plus the
      // configured overrun, so it cannot overlap the attorney's next Booking).
      assert.equal(start(scheduled).outcome, "started");
      const startedView = clientView(scheduled);
      assert.equal(startedView.state, "live");
      assert.deepEqual(
        [ms(startedView.opens_at), ms(startedView.closes_at)],
        [ms(slot) - 600000, ms(slot) + 30 * 60000 + 300000],
      );
      shiftConsultation(scheduled.consultation, -20);
      const lateView = clientView(scheduled);
      assert.ok(ms(lateView.started_at) > ms(slot) + 15 * 60000);
      assert.equal(ms(lateView.closes_at), ms(slot) + 30 * 60000 + 300000);
      const instant = acceptedConsultation({ key: "A", who: lawyer("A") });
      const row = consultationRow(instant.consultation);
      const client = clientView(instant);
      const attorneySide = attorneyView(instant);
      assert.equal(ms(client.opens_at), ms(row.created_at));
      assert.equal(
        ms(client.closes_at),
        ms(row.created_at) + 30 * 60000 + 300000,
      );
      assert.deepEqual(
        [attorneySide.opens_at, attorneySide.closes_at],
        [client.opens_at, client.closes_at],
      );
      world.scheduledG = scheduled;
      return {
        scheduled: [view.opens_at, view.closes_at],
        instant: [client.opens_at, client.closes_at],
      };
    },
  );
  await check(
    "TIME-4 (correction F7: the sweep never locks a Consultation that is not due) a scheduled Consultation within the sweep's one-day prefilter whose window opens in about 20 minutes is held FOR UPDATE by another transaction: the sweep neither waits nor counts it busy and records nothing for it, and consultation_ready_if_due with the sweep's SKIP LOCKED mode answers scheduled for it without waiting; a due Consultation held the same way is still skipped and counted busy (TIME-2)",
    async () => {
      const notDue = acceptedConsultation({
        key: "G",
        requestPath: "scheduled",
        who: lawyer("G"),
        slot: nearSlot(1800),
      });
      assert.equal(consultationRow(notDue.consultation).state, "scheduled");
      assert.equal(clientView(notDue).ready_due, false);
      const holder = await ownerSession("sweep-not-due-holder");
      await holder.ok(
        `select id from public.consultations where id = '${notDue.consultation}' for update;`,
      );
      const started = Date.now();
      const run = sweep();
      const direct = sql(
        `select public.consultation_ready_if_due('${notDue.consultation}', true);`,
      );
      const elapsed = Date.now() - started;
      await holder.ok("rollback;");
      holder.close();
      assert.equal(run.busy, 0, JSON.stringify(run));
      assert.equal(direct, "scheduled");
      assert.ok(elapsed < 2500, `no lock wait (${elapsed} ms)`);
      assert.equal(consultationRow(notDue.consultation).state, "scheduled");
      assert.equal(roomOf(notDue.consultation), null);
      return { run, direct, elapsed_ms: elapsed };
    },
  );
}

// ---------------------------------------------------------------------------
// ROOM: exactly one Media Room per Consultation
// ---------------------------------------------------------------------------

async function roomChecks() {
  await check(
    "ROOM-1 (MBS section 14: exactly one logical Media Room, only when business state permits) the Media Room is created once, pending, when the Consultation enters ready, with one media.room_create job and one system audit event: at S8's instant acceptance, at S8's creation deferred to the confirmed capture (none before), and at S9's scheduled -> ready (none while scheduled); a second Media Room for the same Consultation is refused by the P1 unique key",
    () => {
      const instant = acceptedConsultation({ key: "A", who: lawyer("A") });
      const room = roomOf(instant.consultation);
      assert.deepEqual(
        [room.state, room.modality, room.ended_at],
        ["pending", "synthetic_video", null],
      );
      assert.equal(
        count(
          "operational_jobs",
          `job_type = 'media.room_create' and subject_id = '${room.id}'`,
        ),
        1,
      );
      const created = auditsOf(room.id, "media_room.created");
      assert.deepEqual(
        [created.length, created[0].actor_type, created[0].reason_code],
        [1, "system", "consultation_ready"],
      );
      const deferredLawyer = lawyer("D");
      const s = authorizedRequest({
        jurisdiction: world.J.D,
        requestPath: "instant",
        lawyer: deferredLawyer,
      });
      const decision = accept(deferredLawyer, s.request);
      assert.deepEqual(
        [decision.outcome, decision.consultation],
        ["accepted", null],
      );
      assert.equal(consultationOf(s.request), null);
      confirmCapture(s);
      const deferred = consultationOf(s.request);
      assert.equal(deferred.state, "ready");
      assert.equal(roomOf(deferred.id).state, "pending");
      assert.equal(
        count("media_rooms", `consultation_id = '${deferred.id}'`),
        1,
      );
      assert.equal(
        count("media_rooms", `consultation_id = '${world.lazy.consultation}'`),
        1,
      );
      assert.equal(
        refused(
          `insert into public.media_rooms (consultation_id, modality, state) values ('${instant.consultation}', 'synthetic_video', 'pending');`,
        ),
        "23505",
      );
      world.instantA = instant;
      world.deferred = {
        ...s,
        consultation: deferred.id,
        lawyer: deferredLawyer,
      };
      return { instant: room.id, deferred: roomOf(deferred.id).id };
    },
  );

  await check(
    "ROOM-2 the Media Room guard holds for every role, the owner included: never deleted or truncated; created only pending for a ready or live Consultation with its modality; forward-only (pending -> open | closing, open -> closing, closing -> closed), ended_at exactly at closed and once; its Consultation and modality never change",
    () => {
      const room = roomOf(world.instantA.consultation);
      assert.equal(
        refused(`delete from public.media_rooms where id = '${room.id}';`),
        "55000",
      );
      assert.equal(refused("truncate public.media_rooms cascade;"), "55000");
      assert.equal(
        refused(
          `insert into public.media_rooms (consultation_id, modality, state) values ('${world.sweepDue[0].consultation}', 'synthetic_video', 'open');`,
        ),
        "23514",
      );
      const scheduledOnly = acceptedConsultation({
        key: "T",
        requestPath: "scheduled",
        who: lawyer("T"),
        slot: nearSlot(3600),
      });
      assert.equal(
        refused(
          `insert into public.media_rooms (consultation_id, modality, state) values ('${scheduledOnly.consultation}', 'synthetic_video', 'pending');`,
        ),
        "23514",
      );
      assert.equal(
        refused(
          `update public.media_rooms set state = 'closed', ended_at = now() where id = '${room.id}';`,
        ),
        "55000",
      );
      assert.equal(
        refused(
          `update public.media_rooms set ended_at = now() where id = '${room.id}';`,
        ),
        "23514",
      );
      assert.equal(
        refused(
          `update public.media_rooms set modality = 'synthetic_audio' where id = '${room.id}';`,
        ),
        "55000",
      );
      assert.equal(
        refused(
          `update public.media_rooms set consultation_id = '${world.deferred.consultation}' where id = '${room.id}';`,
        ),
        "55000",
      );
      acceptedThenRolledBack(
        `update public.media_rooms set state = 'open' where id = '${room.id}';
         update public.media_rooms set state = 'closing' where id = '${room.id}';
         update public.media_rooms set state = 'closed', ended_at = now() where id = '${room.id}';`,
      );
      assert.equal(
        refused(
          `update public.media_rooms set state = 'open' where id = '${room.id}';
           update public.media_rooms set state = 'pending' where id = '${room.id}';`,
        ),
        "55000",
      );
      world.scheduledOnly = scheduledOnly;
    },
  );

  await check(
    "ROOM-3 (S2 job protocol; TA section 16.2) the creation job: media_job_context answers act with the derived provider room name (r and 32 hexadecimal digits of the Media Room id) and the provider expiry at the window end; the recorded room_created (with the provider room's expiry, correction F1) opens the Media Room (one system audit event) and, the expiry being the window end, enqueues no expiry update; a malformed observation, a missing or malformed expiry, another room's name or a kind the job may not report is invalid; a report after completion is not_running",
    () => {
      const room = roomOf(world.instantA.consultation);
      const job = openJob("media.room_create", "media_room", room.id);
      claimJob(job);
      const context = mediaContextOf(job);
      const window = clientView(world.instantA);
      assert.deepEqual(
        [
          context.outcome,
          context.operation,
          context.media_room_id,
          context.room_name,
          context.room_state,
        ],
        ["act", "room_create", room.id, roomName(room.id), "pending"],
      );
      assert.equal(ms(context.expires_at), ms(window.closes_at));
      assert.equal(
        sql(
          `select public.media_room_of_provider_name('${roomName(room.id)}');`,
        ),
        room.id,
      );
      const expiry = instantOf(context.expires_at);
      assert.equal(
        mediaRecord(job, {
          kind: "room_created",
          room_name: roomName(room.id),
          expires_at: expiry,
          extra: 1,
        }),
        "invalid",
      );
      assert.equal(
        mediaRecord(job, {
          kind: "room_created",
          room_name: roomName(uid()),
          expires_at: expiry,
        }),
        "invalid",
      );
      // Correction F1: room_created carries the expiry the provider room has.
      for (const missing of [
        { kind: "room_created", room_name: roomName(room.id) },
        {
          kind: "room_created",
          room_name: roomName(room.id),
          expires_at: "soon",
        },
      ]) {
        assert.equal(mediaRecord(job, missing), "invalid");
      }
      assert.equal(
        mediaRecord(job, {
          kind: "room_deleted",
          room_name: roomName(room.id),
        }),
        "invalid",
      );
      assert.equal(
        mediaRecord(job, {
          kind: "room_created",
          room_name: roomName(room.id),
          expires_at: expiry,
        }),
        "applied",
      );
      // The provider room carries the window end: no expiry update is due.
      assert.equal(openJob("media.room_update", "media_room", room.id), null);
      assert.equal(completeJob(job), "completed");
      assert.equal(
        mediaRecord(job, {
          kind: "room_created",
          room_name: roomName(room.id),
          expires_at: expiry,
        }),
        "not_running",
      );
      assert.equal(roomOf(world.instantA.consultation).state, "open");
      const opened = auditsOf(room.id, "media_room.opened");
      assert.deepEqual(
        [opened.length, opened[0].actor_type, opened[0].reason_code],
        [1, "system", "provider_room_created"],
      );
      return context;
    },
  );

  await check(
    "ROOM-4 (correction F1: the provider room never keeps an expiry before the window end) an instant Consultation whose Media Room is still pending when the attorney starts (its creation job in flight with the earlier window end): the start enqueues no update for the pending room; the recorded room_created reports the earlier expiry, opens the Media Room and enqueues one media.room_update job, whose context carries the new window end; an update reporting an expiry other than the window end answers outdated (the job runs again) and one with the window end no_effect; a repeated creation of the open room reporting an outdated expiry enqueues the update too",
    () => {
      const s = acceptedConsultation({ key: "A", who: lawyer("A") });
      // Fixture time shift: the creation one minute earlier, so the window
      // end moves measurably with the start.
      shiftConsultation(s.consultation, 1);
      const room = roomOf(s.consultation);
      assert.equal(room.state, "pending");
      const create = openJob("media.room_create", "media_room", room.id);
      claimJob(create);
      const inFlight = mediaContextOf(create);
      assert.equal(inFlight.outcome, "act");
      assert.equal(start(s).outcome, "started");
      assert.equal(roomOf(s.consultation).state, "pending");
      assert.equal(openJob("media.room_update", "media_room", room.id), null);
      const window = clientView(s);
      assert.ok(ms(window.closes_at) >= ms(inFlight.expires_at) + 55000);
      assert.equal(
        mediaRecord(create, {
          kind: "room_created",
          room_name: roomName(room.id),
          expires_at: instantOf(inFlight.expires_at),
        }),
        "applied",
      );
      assert.equal(completeJob(create), "completed");
      assert.equal(roomOf(s.consultation).state, "open");
      const update = openJob("media.room_update", "media_room", room.id);
      assert.ok(update, "an expiry update after the outdated creation");
      claimJob(update);
      const context = mediaContextOf(update);
      assert.deepEqual(
        [context.outcome, context.operation, ms(context.expires_at)],
        ["act", "room_update", ms(window.closes_at)],
      );
      const before = s9Counts();
      assert.equal(
        mediaRecord(update, {
          kind: "room_updated",
          room_name: roomName(room.id),
          expires_at: instantOf(inFlight.expires_at),
        }),
        "outdated",
      );
      assert.deepEqual(s9Counts(), before);
      assert.equal(
        mediaRecord(update, {
          kind: "room_updated",
          room_name: roomName(room.id),
          expires_at: instantOf(context.expires_at),
        }),
        "no_effect",
      );
      assert.equal(completeJob(update), "completed");
      assert.equal(consultationRow(s.consultation).state, "live");
      // A repeated creation of the open room that reports an outdated expiry.
      sql(
        `select public.job_enqueue('media.room_create', 'media_room', '${room.id}', now(), 8);`,
      );
      const again = openJob("media.room_create", "media_room", room.id);
      claimJob(again);
      assert.equal(
        mediaRecord(again, {
          kind: "room_created",
          room_name: roomName(room.id),
          expires_at: instantOf(inFlight.expires_at),
        }),
        "no_effect",
      );
      assert.equal(completeJob(again), "completed");
      assert.ok(openJob("media.room_update", "media_room", room.id));
      return {
        created_with: inFlight.expires_at,
        window_end: window.closes_at,
        update: context.expires_at,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// ACC: media authorization (TA section 46)
// ---------------------------------------------------------------------------

async function accessChecks() {
  await check(
    "ACC-1 (TA section 46; correction F4: the start's checks gate the meeting) while the Consultation is ready, inside its window on an open Media Room, neither participant is granted anything (waiting, no room name, no audit); once the attorney has started, media access is granted to the Consultation's own client (aal1) and attorney (aal2): the provider room name, the role, the participant's own User id, not-before = the window start and an expiry of at most 600 seconds; each grant is audited (role, Consultation, Media Room, times; never a token) with the scheduling version",
    () => {
      const ready = world.instantA;
      assert.equal(roomOf(ready.consultation).state, "open");
      const readyCounts = s9Counts();
      const readyWindow = clientView(ready);
      for (const waiting of [clientAccess(ready), attorneyAccess(ready)]) {
        assert.deepEqual(
          [
            waiting.outcome,
            waiting.room_name,
            waiting.participant_user_id,
            waiting.not_before,
            waiting.expires_at,
            ms(waiting.opens_at),
          ],
          ["waiting", null, null, null, null, ms(readyWindow.opens_at)],
        );
      }
      assert.deepEqual(s9Counts(), readyCounts);
      assert.equal(
        auditsOf(ready.consultation, "consultation.media_access_granted")
          .length,
        0,
      );
      const s = acceptedConsultation({ key: "A", who: lawyer("A") });
      openRoom(roomOf(s.consultation).id);
      assert.equal(clientAccess(s).outcome, "waiting");
      assert.equal(start(s).outcome, "started");
      world.liveAccess = s;
      const before = Date.now();
      const client = clientAccess(s);
      const attorneySide = attorneyAccess(s);
      const after = Date.now();
      const room = roomOf(s.consultation);
      const window = clientView(s);
      assert.deepEqual(
        [
          client.outcome,
          client.room_name,
          client.participant_role,
          client.participant_user_id,
        ],
        ["granted", roomName(room.id), "client", s.client.user],
      );
      assert.deepEqual(
        [
          attorneySide.outcome,
          attorneySide.room_name,
          attorneySide.participant_role,
          attorneySide.participant_user_id,
        ],
        ["granted", roomName(room.id), "attorney", s.lawyer.user],
      );
      for (const grant of [client, attorneySide]) {
        assert.equal(ms(grant.not_before), ms(window.opens_at));
        assert.ok(ms(grant.expires_at) <= after + 600000 + 1000);
        assert.ok(ms(grant.expires_at) >= before + 600000 - 5000);
      }
      const audits = auditsOf(
        s.consultation,
        "consultation.media_access_granted",
      );
      assert.deepEqual(
        audits.map((a) => [
          a.actor_type,
          a.actor_user_id,
          a.reason_code,
          Object.keys(a.after).sort().join(","),
        ]),
        [
          [
            "client",
            s.client.user,
            "media_access",
            "consultation_state,expires_at,media_room_id,not_before,participant_role",
          ],
          [
            "attorney",
            s.lawyer.user,
            "media_access",
            "consultation_state,expires_at,media_room_id,not_before,participant_role",
          ],
        ],
      );
      assert.deepEqual(audits[0].policy_references, [
        {
          policy_type_code: "scheduling",
          policy_version_id: world.policies.A.scheduling,
        },
      ]);
      return {
        ready: "waiting",
        client: client.outcome,
        attorney: attorneySide.outcome,
      };
    },
  );

  await check(
    "ACC-2 (MBS14-4 unauthorized room access is denied) another client, another attorney, an attorney at aal1, an unknown id and no id all answer not_found alike (no existence oracle), with nothing written; the room name of another Consultation is never answered",
    () => {
      const s = world.instantA;
      const stranger = newClient();
      const otherLawyer = lawyer("A");
      const before = s9Counts();
      const answers = [
        jsonAs(stranger, ACCESS_SQL(s.consultation), { aal: "aal1" }),
        jsonAs(otherLawyer, ACCESS_SQL(s.consultation)),
        jsonAs(s.lawyer, ACCESS_SQL(s.consultation), { aal: "aal1" }),
        jsonAs(s.client, ACCESS_SQL(uid()), { aal: "aal1" }),
        jsonAs(
          s.client,
          "select row_to_json(x)::text from public.consultation_media_access(null) x;",
          { aal: "aal1" },
        ),
      ];
      for (const answer of answers) {
        assert.deepEqual(answer, {
          outcome: "not_found",
          room_name: null,
          participant_role: null,
          participant_user_id: null,
          not_before: null,
          expires_at: null,
          opens_at: null,
        });
      }
      assert.deepEqual(s9Counts(), before);
      return answers.map((a) => a.outcome);
    },
  );

  await check(
    "ACC-3 the expiry never passes the permitted window: a live Consultation whose window ends in about five minutes gets an expiry at the window end, not now plus 600 seconds; once the window has passed, access answers ended and nothing is granted (fixture time shift: the Consultation's creation moved into the past by the owner)",
    () => {
      const s = acceptedConsultation({ key: "A", who: lawyer("A") });
      openRoom(roomOf(s.consultation).id);
      assert.equal(start(s).outcome, "started");
      shiftConsultation(s.consultation, 30);
      const near = clientAccess(s);
      const window = clientView(s);
      assert.equal(near.outcome, "granted");
      assert.equal(ms(near.expires_at), ms(window.closes_at));
      assert.ok(ms(near.expires_at) < Date.now() + 600000 - 60000);
      shiftConsultation(s.consultation, 10);
      const audits = count("audit_events", `resource_id = '${s.consultation}'`);
      const past = attorneyAccess(s);
      assert.equal(past.outcome, "ended");
      assert.equal(past.room_name, null);
      assert.equal(
        count("audit_events", `resource_id = '${s.consultation}'`),
        audits,
      );
      // A ready Consultation past its window (never started) answers ended
      // too; ST-1 refuses its start (window_passed).
      const unstarted = acceptedConsultation({ key: "A", who: lawyer("A") });
      openRoom(roomOf(unstarted.consultation).id);
      shiftConsultation(unstarted.consultation, 40);
      assert.equal(clientAccess(unstarted).outcome, "ended");
      assert.equal(consultationRow(unstarted.consultation).state, "ready");
      world.pastWindow = unstarted;
      return { near: near.outcome, past: past.outcome };
    },
  );

  await check(
    "ACC-4 (MBS14-2 a reconnect never creates a second Consultation; TA section 46) repeated access to a live Consultation (five grants each for the client and the attorney, as reconnects do) always answers the same provider room of the same Media Room; no Consultation, Media Room or job is added, only one audit event per grant",
    () => {
      const s = world.liveAccess;
      const consultations = count("consultations");
      const rooms = count("media_rooms");
      const jobs = count("operational_jobs");
      const audits = count("audit_events");
      const names = new Set();
      for (let i = 0; i < 5; i += 1) {
        names.add(clientAccess(s).room_name);
        names.add(attorneyAccess(s).room_name);
      }
      assert.deepEqual([...names], [roomName(roomOf(s.consultation).id)]);
      assert.deepEqual(
        [
          count("consultations"),
          count("media_rooms"),
          count("operational_jobs"),
          count("audit_events"),
        ],
        [consultations, rooms, jobs, audits + 10],
      );
      return { grants: 10, rooms: names.size };
    },
  );

  await check(
    "ACC-5 the participants' reads: client_consultation for the Consultation's own client and attorney_consultation / attorney_consultations for its own attorney at aal2 answer the server state, window, Media Room state and evidence; another client, another attorney, an attorney at aal1 and an unknown id get no row; nothing of the provider or the other participant's identity is answered",
    () => {
      const s = world.instantA;
      const client = clientView(s);
      assert.deepEqual(Object.keys(client), [
        "consultation_id",
        "state",
        "ready_due",
        "request_path",
        "modality",
        "duration_minutes",
        "booking_starts_at",
        "booking_ends_at",
        "opens_at",
        "closes_at",
        "started_at",
        "ended_at",
        "outcome_code",
        "media_state",
        "attorney_joined_at",
        "attorney_left_at",
        "client_joined_at",
        "client_left_at",
        "both_present",
        "either_left",
        "provider_sessions",
        "reconnections",
      ]);
      assert.deepEqual(
        [
          client.state,
          client.media_state,
          client.request_path,
          client.duration_minutes,
          client.provider_sessions,
        ],
        ["ready", "open", "instant", 30, 0],
      );
      assert.deepEqual(attorneyView(s), client);
      const stranger = newClient();
      assert.equal(
        oneRowAs(stranger, CLIENT_VIEW_SQL(s.consultation), { aal: "aal1" }),
        null,
      );
      assert.equal(
        oneRowAs(lawyer("A"), ATTORNEY_VIEW_SQL(s.consultation)),
        null,
      );
      assert.equal(attorneyView(s, { aal: "aal1" }), null);
      assert.equal(
        oneRowAs(s.client, CLIENT_VIEW_SQL(uid()), { aal: "aal1" }),
        null,
      );
      assert.equal(oneRowAs(s.lawyer, CLIENT_VIEW_SQL(s.consultation)), null);
      const list = rowsAsAttorney(
        s.lawyer,
        "select consultation_id || '|' || state from public.attorney_consultations();",
      );
      assert.deepEqual(list, [`${s.consultation}|ready`]);
      assert.deepEqual(
        rowsAsAttorney(
          s.lawyer,
          "select consultation_id from public.attorney_consultations();",
          { aal: "aal1" },
        ),
        [],
      );
      return client;
    },
  );
}

// ---------------------------------------------------------------------------
// START and END
// ---------------------------------------------------------------------------

const unchanged = (s) => ({
  consultation: consultationRow(s.consultation),
  payment: livePaymentOf(s.request),
  engagements: engagementsOf(s.consultation),
  room: roomOf(s.consultation),
});

async function startChecks() {
  await check(
    "ST-1 (the client can neither start nor end; TA section 48) refusals change nothing: the client (aal1) and an attorney at aal1 are denied, another attorney and an unknown id answer not_found, a scheduled Consultation not yet open answers not_ready, a Consultation past its window answers window_passed; no Consultation, payment, Engagement, Media Room, evaluation, audit event or job changes",
    () => {
      const s = world.instantA;
      const otherLawyer = lawyer("A");
      const before = s9Counts();
      const snapshot = unchanged(s);
      const answers = {
        client: jsonAs(s.client, START_SQL(s.consultation), { aal: "aal1" }),
        clientEnd: jsonAs(s.client, END_SQL(s.consultation), { aal: "aal1" }),
        aal1: start(s, { aal: "aal1" }),
        other: jsonAs(otherLawyer, START_SQL(s.consultation)),
        unknown: jsonAs(s.lawyer, START_SQL(uid())),
        notReady: start(world.scheduledOnly),
        windowPassed: start(world.pastWindow),
      };
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(answers).map(([k, v]) => [
            k,
            `${v.outcome}|${v.problem ?? ""}`,
          ]),
        ),
        {
          client: "denied|",
          clientEnd: "denied|",
          aal1: "denied|",
          other: "not_found|",
          unknown: "not_found|",
          notReady: "not_ready|scheduled",
          windowPassed: "window_passed|",
        },
      );
      assert.deepEqual(s9Counts(), before);
      assert.deepEqual(unchanged(s), snapshot);
      return answers;
    },
  );

  await check(
    "ST-2 (PM INV-8 and INV-14; capture at_attorney_acceptance) payment readiness: with the capture still pending (capture_pending) and after a refused capture (capture_failed) the start answers payment_not_ready with the payment state and changes nothing (and neither participant is granted the room, correction F4); once captured the attorney starts: live with started_at inside the window, Engagement version 1 effective exactly at the start (engagement at_consultation_start, which S8 left to S9), the provider room's expiry update enqueued, one audit event with the eligibility, scheduling, payment_flow and engagement policy references; a second start answers already_started; the window now runs from the start",
    () => {
      const who = lawyer("A");
      const pending = acceptedConsultation({ key: "A", who, capture: false });
      assert.equal(livePaymentOf(pending.request).state, "capture_pending");
      openRoom(roomOf(pending.consultation).id);
      const before = s9Counts();
      const snapshot = unchanged(pending);
      assert.deepEqual(start(pending), {
        outcome: "payment_not_ready",
        problem: "capture_pending",
        started_at: null,
      });
      assert.deepEqual(s9Counts(), before);
      assert.deepEqual(unchanged(pending), snapshot);
      // Correction F4: after a refused start nothing is granted.
      assert.deepEqual(
        [clientAccess(pending).outcome, attorneyAccess(pending).outcome],
        ["waiting", "waiting"],
      );
      const failed = acceptedConsultation({
        key: "A",
        who: lawyer("A"),
        capture: false,
      });
      runJob("payment.capture", "payment_transaction", failed.payment, () =>
        obs("capture_refused", { payment_reference: failed.reference }),
      );
      assert.equal(livePaymentOf(failed.request).state, "capture_failed");
      assert.deepEqual(start(failed), {
        outcome: "payment_not_ready",
        problem: "capture_failed",
        started_at: null,
      });
      assert.equal(consultationRow(failed.consultation).state, "ready");
      confirmCapture(pending);
      assert.equal(livePaymentOf(pending.request).state, "captured");
      const evaluations = count("eligibility_evaluations");
      const answer = start(pending);
      assert.equal(answer.outcome, "started", JSON.stringify(answer));
      const row = consultationRow(pending.consultation);
      assert.deepEqual([row.state, row.started_at !== null], ["live", true]);
      assert.equal(ms(answer.started_at), ms(row.started_at));
      assert.equal(count("eligibility_evaluations"), evaluations + 1);
      const engagements = engagementsOf(pending.consultation);
      assert.deepEqual(
        engagements.map((g) => [g.version_number, g.state, ms(g.effective_at)]),
        [[1, "effective", ms(row.started_at)]],
      );
      const room = roomOf(pending.consultation);
      assert.ok(openJob("media.room_update", "media_room", room.id));
      const started = auditsOf(pending.consultation, "consultation.started");
      assert.equal(started.length, 1);
      assert.deepEqual(
        [
          started[0].actor_type,
          started[0].actor_user_id,
          started[0].reason_code,
          started[0].after.state,
          started[0].after.capture_requested,
        ],
        ["attorney", who.user, "attorney_started", "live", false],
      );
      const types = started[0].policy_references.map((r) => r.policy_type_code);
      for (const type of [
        "eligibility",
        "scheduling",
        "payment_flow",
        "engagement",
      ]) {
        assert.ok(types.includes(type), type);
      }
      assert.deepEqual(start(pending).outcome, "already_started");
      const view = attorneyView(pending);
      assert.equal(
        ms(view.closes_at),
        ms(row.started_at) + 30 * 60000 + 300000,
      );
      const updateJob = openJob("media.room_update", "media_room", room.id);
      claimJob(updateJob);
      const context = mediaContextOf(updateJob);
      assert.deepEqual(
        [context.outcome, ms(context.expires_at)],
        ["act", ms(view.closes_at)],
      );
      assert.equal(
        mediaRecord(updateJob, {
          kind: "room_updated",
          room_name: roomName(room.id),
          expires_at: instantOf(context.expires_at),
        }),
        "no_effect",
      );
      assert.equal(completeJob(updateJob), "completed");
      world.liveA = pending;
      return answer;
    },
  );

  await check(
    "ST-3 (capture at_consultation_start; PM row 20 seam) the start requests the configured capture in the same transaction: the authorized payment moves to capture_pending with one capture job (the provider call follows commit) and the Engagement becomes effective at the start; with the payment not authorized (capture already pending) the start answers payment_not_ready",
    () => {
      const s = acceptedConsultation({ key: "G", who: lawyer("G") });
      assert.equal(livePaymentOf(s.request).state, "authorized");
      const answer = start(s);
      assert.equal(answer.outcome, "started", JSON.stringify(answer));
      assert.equal(livePaymentOf(s.request).state, "capture_pending");
      assert.equal(
        count(
          "operational_jobs",
          `job_type = 'payment.capture' and subject_id = '${s.payment}'`,
        ),
        1,
      );
      assert.equal(engagementsOf(s.consultation).length, 1);
      assert.equal(
        auditsOf(s.consultation, "consultation.started")[0].after
          .capture_requested,
        true,
      );
      world.liveG = s;
      return answer;
    },
  );

  await check(
    "ST-4 (capture at_authorization; Engagement at_request) a captured payment is ready for the start and the Engagement recorded at the acceptance (at_request) is not recorded twice; with the payment flow capturing at completion an authorized payment is ready and nothing is captured at the start",
    () => {
      const u = acceptedConsultation({ key: "U", who: lawyer("U") });
      assert.equal(livePaymentOf(u.request).state, "captured");
      assert.equal(engagementsOf(u.consultation).length, 1);
      assert.equal(start(u).outcome, "started");
      assert.equal(engagementsOf(u.consultation).length, 1);
      const c = acceptedConsultation({ key: "C", who: lawyer("C") });
      assert.equal(livePaymentOf(c.request).state, "authorized");
      assert.equal(start(c).outcome, "started");
      assert.equal(livePaymentOf(c.request).state, "authorized");
      assert.equal(
        count(
          "operational_jobs",
          `job_type = 'payment.capture' and subject_id = '${c.payment}'`,
        ),
        0,
      );
      world.liveC = c;
      world.liveU = u;
      return {
        u: livePaymentOf(u.request).state,
        c: livePaymentOf(c.request).state,
      };
    },
  );

  await check(
    "ST-5 (PM INV-12; PM rows 39-41 counsel-gated) the start is a decision point: an attorney no longer eligible gets not_eligible, the fresh not_eligible Eligibility Evaluation and one start_refused audit event are kept, and the Consultation stays ready, the payment authorized, no Engagement recorded (nothing ends the Consultation), and neither participant is granted the room (correction F4); an attorney whose eligibility cannot be determined (no eligibility policy in force) gets eligibility_unavailable and nothing is kept at all",
    () => {
      const who = lawyer("E");
      const s = acceptedConsultation({ key: "E", who });
      sql(
        `update public.licenses set reported_status = 'synthetic-suspended' where attorney_id = '${who.profile}';`,
      );
      const snapshot = unchanged(s);
      const evaluations = count("eligibility_evaluations");
      const answer = start(s);
      assert.deepEqual(answer, {
        outcome: "not_eligible",
        problem: "not_eligible",
        started_at: null,
      });
      assert.deepEqual(unchanged(s), snapshot);
      assert.equal(count("eligibility_evaluations"), evaluations + 1);
      assert.equal(
        sql(
          `select result from public.eligibility_evaluations where attorney_id = '${who.profile}' order by evaluated_at desc, id desc limit 1;`,
        ),
        "not_eligible",
      );
      const refusedAudit = auditsOf(
        s.consultation,
        "consultation.start_refused",
      );
      assert.deepEqual(
        [
          refusedAudit.length,
          refusedAudit[0].reason_code,
          refusedAudit[0].after.state,
        ],
        [1, "attorney_not_eligible", "ready"],
      );
      // Correction F4: a refused start opens nothing: on its open Media Room
      // neither participant is granted the room (the waiting room stays).
      openRoom(roomOf(s.consultation).id);
      const grants = auditsOf(
        s.consultation,
        "consultation.media_access_granted",
      ).length;
      assert.deepEqual(
        [clientAccess(s).outcome, attorneyAccess(s).outcome],
        ["waiting", "waiting"],
      );
      assert.equal(
        auditsOf(s.consultation, "consultation.media_access_granted").length,
        grants,
      );
      const f = acceptedConsultation({ key: "F", who: lawyer("F") });
      sql(
        `update public.policy_versions set effective_until = now() where id = '${world.policies.F.eligibility}';`,
      );
      const before = s9Counts();
      const fSnapshot = unchanged(f);
      const undetermined = start(f);
      assert.deepEqual(undetermined, {
        outcome: "eligibility_unavailable",
        problem: null,
        started_at: null,
      });
      assert.deepEqual(s9Counts(), before);
      assert.deepEqual(unchanged(f), fSnapshot);
      return {
        notEligible: answer.outcome,
        undetermined: undetermined.outcome,
      };
    },
  );

  await check(
    "ENG-1 (correction F8: the start records only an Engagement that takes effect at the start) with the engagement version effective at_request (capture at authorization) or at_attorney_acceptance (capture at completion) and no Engagement present at the start (fixture: the one S8 recorded at the acceptance removed by the owner, triggers bypassed), the start records none: no backfill with a past effective time, the start audit names no Engagement; with at_consultation_start the start records Engagement version 1 effective exactly at the start",
    () => {
      const results = {};
      for (const key of ["U", "C"]) {
        const s = acceptedConsultation({ key, who: lawyer(key) });
        assert.equal(engagementsOf(s.consultation).length, 1, key);
        sql(
          `begin;
           set local session_replication_role = replica;
           delete from public.engagements where consultation_id = '${s.consultation}';
           commit;`,
        );
        assert.equal(engagementsOf(s.consultation).length, 0, key);
        const answer = start(s);
        assert.equal(answer.outcome, "started", JSON.stringify(answer));
        assert.equal(engagementsOf(s.consultation).length, 0, key);
        const started = auditsOf(s.consultation, "consultation.started");
        assert.equal(started[0].after.engagement_id, null, key);
        results[key] = engagementsOf(s.consultation).length;
      }
      const g = acceptedConsultation({ key: "G", who: lawyer("G") });
      assert.equal(engagementsOf(g.consultation).length, 0);
      assert.equal(start(g).outcome, "started");
      const row = consultationRow(g.consultation);
      assert.deepEqual(
        engagementsOf(g.consultation).map((e) => [
          e.version_number,
          e.state,
          ms(e.effective_at),
        ]),
        [[1, "effective", ms(row.started_at)]],
      );
      results.G = 1;
      return results;
    },
  );

  await check(
    "ST-6 (MB sections 32-33 busy; S8 carry-forward) an attorney already in a live Consultation cannot start another one: with two ready Consultations accepted, the first start wins and the second answers attorney_in_consultation with nothing changed; it can start once the first has ended",
    () => {
      const who = lawyer("G");
      const first = acceptedConsultation({ key: "G", who });
      const second = acceptedConsultation({ key: "G", who });
      assert.equal(start(first).outcome, "started");
      const snapshot = unchanged(second);
      assert.deepEqual(start(second), {
        outcome: "attorney_in_consultation",
        problem: null,
        started_at: null,
      });
      assert.deepEqual(unchanged(second), snapshot);
      assert.equal(end(first).outcome, "completed");
      assert.equal(start(second).outcome, "started");
      return "attorney_in_consultation";
    },
  );
}

async function endChecks() {
  await check(
    "END-1 (PM row 20, the attorney's declaration of normal completion) the attorney ends a live Consultation: completed with ended_at and completion reason normal; the Media Room moves to closing with one delete job and one final observation job (system audit); one attorney audit event; a second end answers ended, the end of a ready Consultation not_started, the client's end denied; media access afterwards answers ended (no grant after a terminal state)",
    () => {
      const s = world.liveA;
      const room = roomOf(s.consultation);
      const answer = end(s);
      assert.equal(answer.outcome, "completed", JSON.stringify(answer));
      const row = consultationRow(s.consultation);
      assert.deepEqual(
        [
          row.state,
          row.outcome_code,
          row.ended_at !== null,
          ms(answer.ended_at),
        ],
        ["completed", "normal", true, ms(row.ended_at)],
      );
      assert.equal(roomOf(s.consultation).state, "closing");
      assert.ok(openJob("media.room_delete", "media_room", room.id));
      assert.ok(openJob("media.observe", "media_room", room.id));
      assert.equal(
        auditsOf(room.id, "media_room.closing")[0].reason_code,
        "consultation_completed",
      );
      const completed = auditsOf(s.consultation, "consultation.completed");
      assert.deepEqual(
        [
          completed.length,
          completed[0].actor_type,
          completed[0].after.outcome_code,
        ],
        [1, "attorney", "normal"],
      );
      assert.equal(end(s).outcome, "ended");
      assert.equal(end(world.instantA).outcome, "not_started");
      assert.equal(
        jsonAs(s.client, END_SQL(s.consultation), { aal: "aal1" }).outcome,
        "denied",
      );
      assert.equal(clientAccess(s).outcome, "ended");
      assert.equal(attorneyAccess(s).outcome, "ended");
      const view = clientView(s);
      assert.deepEqual(
        [view.state, view.outcome_code, view.media_state],
        ["completed", "normal", "closing"],
      );
      return answer;
    },
  );

  await check(
    "END-2 (capture at_consultation_completion; PM INV-11) the end requests the configured capture (capture_pending, one capture job); a payment no longer capturable at completion is never absorbed silently: the Consultation completes and one high capture_unavailable_at_completion Reconciliation Exception surfaces it",
    () => {
      const c = world.liveC;
      assert.equal(end(c).outcome, "completed");
      assert.equal(livePaymentOf(c.request).state, "capture_pending");
      assert.equal(
        count(
          "operational_jobs",
          `job_type = 'payment.capture' and subject_id = '${c.payment}'`,
        ),
        1,
      );
      const other = acceptedConsultation({ key: "C", who: lawyer("C") });
      assert.equal(start(other).outcome, "started");
      sql(
        `update public.payment_transactions set state = 'release_pending' where id = '${other.payment}';`,
      );
      assert.equal(end(other).outcome, "completed");
      assert.equal(consultationRow(other.consultation).state, "completed");
      const items = jsonOf(
        `select coalesce(json_agg(json_build_object('severity', severity, 'source_type', source_type, 'evidence', evidence_reference)), '[]'::json)::text from public.reconciliation_exceptions where exception_type = 'capture_unavailable_at_completion' and source_id = '${other.consultation}';`,
      );
      assert.deepEqual(
        [
          items.length,
          items[0].severity,
          items[0].source_type,
          items[0].evidence.payment_state,
        ],
        [1, "high", "consultation", "release_pending"],
      );
      return items[0];
    },
  );

  await check(
    "END-3 (MBS section 14; PM row 19 brief drop) provider observations never change the Consultation: a participant leaving and rejoining and the provider session ending leave a live Consultation live, its payment and Engagement unchanged; only the attorney's end completes it",
    () => {
      const s = world.liveG;
      const room = roomOf(s.consultation);
      if (room.state === "pending") {
        openRoom(room.id);
      }
      const snapshot = unchanged(s);
      const session = sessionRef();
      const out = participantRef();
      const back = participantRef();
      sql(
        `select public.job_enqueue('media.observe', 'media_room', '${room.id}', now(), 3);`,
      );
      const observe = runMediaJob("media.observe", room.id, () => ({
        kind: "meetings_observed",
        room_name: roomName(room.id),
        sessions: [
          {
            session_reference: session,
            started_at: isoAgo(20),
            ended_at: isoAgo(1),
            participants: [
              {
                participant_reference: out,
                user_id: s.client.user,
                joined_at: isoAgo(19),
                left_at: isoAgo(12),
              },
              {
                participant_reference: back,
                user_id: s.client.user,
                joined_at: isoAgo(10),
                left_at: isoAgo(1),
              },
              {
                participant_reference: participantRef(),
                user_id: s.lawyer.user,
                joined_at: isoAgo(18),
                left_at: isoAgo(1),
              },
            ],
          },
        ],
      }));
      assert.equal(observe.outcome, "applied");
      const after = unchanged(s);
      assert.deepEqual(after.consultation, snapshot.consultation);
      assert.deepEqual(after.payment, snapshot.payment);
      assert.deepEqual(after.engagements, snapshot.engagements);
      assert.equal(consultationRow(s.consultation).state, "live");
      const view = attorneyView(s);
      assert.deepEqual(
        [
          view.both_present,
          view.either_left,
          view.provider_sessions,
          view.reconnections,
        ],
        [true, true, 1, 1],
      );
      return view;
    },
  );

  await check(
    "END-4 (correction F3: ending is protective and needs no timing configuration) a live Consultation whose jurisdiction no longer has a scheduling version in force (closed once it was live): media access answers configuration_unavailable, yet the attorney ends it: completed with completion reason normal and its Media Room closing",
    () => {
      const s = acceptedConsultation({ key: "X", who: lawyer("X") });
      openRoom(roomOf(s.consultation).id);
      assert.equal(start(s).outcome, "started");
      sql(
        `update public.policy_versions set effective_until = now() where id = '${world.policies.X.scheduling}';`,
      );
      assert.equal(clientAccess(s).outcome, "configuration_unavailable");
      const answer = end(s);
      assert.equal(answer.outcome, "completed", JSON.stringify(answer));
      const row = consultationRow(s.consultation);
      assert.deepEqual(
        [row.state, row.outcome_code, row.ended_at !== null],
        ["completed", "normal", true],
      );
      assert.equal(roomOf(s.consultation).state, "closing");
      return { access: "configuration_unavailable", end: answer.outcome };
    },
  );
}

// ---------------------------------------------------------------------------
// EV: provider sessions, participation evidence and disagreement (MBS
// section 14 failure tests)
// ---------------------------------------------------------------------------

const participationOf = (consultation) =>
  jsonOf(
    `select coalesce(json_agg(json_build_object('reference', p.provider_observation_reference, 'user', p.participant_user_id, 'joined_at', p.joined_at, 'left_at', p.left_at, 'observed', p.observed_participation) order by p.created_at, p.id), '[]'::json)::text from public.session_participation_records p join public.media_sessions s on s.id = p.media_session_id join public.media_rooms m on m.id = s.media_room_id where m.consultation_id = '${consultation}';`,
  );
const sessionsOf = (consultation) =>
  jsonOf(
    `select coalesce(json_agg(row_to_json(s) order by s.started_at, s.id), '[]'::json)::text from public.media_sessions s join public.media_rooms m on m.id = s.media_room_id where m.consultation_id = '${consultation}';`,
  );

// The sweep's observation job of a Media Room (enqueued as the sweep does).
function ensureObserveJob(roomId) {
  sql(
    `select public.job_enqueue('media.observe', 'media_room', '${roomId}', now(), 3);`,
  );
}

function observeWith(roomId, sessions) {
  ensureObserveJob(roomId);
  return runMediaJob("media.observe", roomId, () => ({
    kind: "meetings_observed",
    room_name: roomName(roomId),
    sessions,
  }));
}

async function evidenceChecks() {
  await check(
    "MBS14-1 (provider outage does not silently mutate canonical Consultation state) the provider room cannot be created: every attempt of the creation job fails and the S2 protocol retries with backoff, then escalates the job when its 8 attempts are used up (visible, audited); the Media Room stays pending, the Consultation ready, the payment and Engagement unchanged; media access answers waiting while ready and, once the attorney has started, preparing, and grants nothing",
    () => {
      const s = acceptedConsultation({ key: "G", who: lawyer("G") });
      const room = roomOf(s.consultation);
      const snapshot = unchanged(s);
      const job = openJob("media.room_create", "media_room", room.id);
      const answers = [];
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        claimJob(job);
        answers.push(
          as(
            "service_role",
            null,
            `select public.job_fail('${job}', 's9-proof', 'handler_failed', 'The job handler reported a failure.');`,
          ),
        );
      }
      assert.deepEqual(answers, [
        ...Array.from({ length: 7 }, () => "retry_scheduled"),
        "escalated",
      ]);
      assert.equal(
        sql(`select state from public.operational_jobs where id = '${job}';`),
        "escalated",
      );
      assert.deepEqual(unchanged(s), snapshot);
      assert.equal(roomOf(s.consultation).state, "pending");
      // While ready: the waiting room (correction F4); once the attorney has
      // started: preparing. Nothing is granted and no job is added.
      let jobs = count("operational_jobs");
      assert.equal(clientAccess(s).outcome, "waiting");
      assert.equal(attorneyAccess(s).outcome, "waiting");
      assert.equal(count("operational_jobs"), jobs);
      assert.equal(start(s).outcome, "started");
      assert.equal(roomOf(s.consultation).state, "pending");
      jobs = count("operational_jobs");
      assert.equal(clientAccess(s).outcome, "preparing");
      assert.equal(attorneyAccess(s).outcome, "preparing");
      assert.equal(count("operational_jobs"), jobs);
      assert.equal(itemsOf("media_room_missing", s.consultation).length, 0);
      return answers;
    },
  );

  await check(
    "MBS14-2 (a reconnect does not create a duplicate Consultation; IMP section 25 exit) two provider sessions with each participant reconnecting (a new participant reference each time) are recorded under the one Media Room of the one Consultation: two media_sessions, four append-only participation records with role and observation kind only; the derived evidence shows both joined, both present together, a departure and two reconnections; repeated media grants answer the same room; no Consultation or Media Room is added",
    () => {
      const s = world.liveU;
      const room = roomOf(s.consultation);
      if (room.state === "pending") {
        openRoom(room.id);
      }
      const consultations = count("consultations");
      const rooms = count("media_rooms");
      const first = sessionRef();
      const second = sessionRef();
      const refs = {
        a1: participantRef(),
        c1: participantRef(),
        a2: participantRef(),
        c2: participantRef(),
      };
      world.reconnect = { s, room, first, second, refs };
      const sessions = [
        {
          session_reference: first,
          started_at: isoAgo(30),
          ended_at: isoAgo(20),
          participants: [
            {
              participant_reference: refs.a1,
              user_id: s.lawyer.user,
              joined_at: isoAgo(29),
              left_at: isoAgo(20),
            },
            {
              participant_reference: refs.c1,
              user_id: s.client.user,
              joined_at: isoAgo(28),
              left_at: isoAgo(20),
            },
          ],
        },
        {
          session_reference: second,
          started_at: isoAgo(15),
          ended_at: null,
          participants: [
            {
              participant_reference: refs.a2,
              user_id: s.lawyer.user,
              joined_at: isoAgo(14),
              left_at: null,
            },
            {
              participant_reference: refs.c2,
              user_id: s.client.user,
              joined_at: isoAgo(13),
              left_at: null,
            },
          ],
        },
      ];
      world.reconnect.sessions = sessions;
      assert.equal(observeWith(room.id, sessions).outcome, "applied");
      for (let i = 0; i < 3; i += 1) {
        assert.equal(clientAccess(s).room_name, roomName(room.id));
        assert.equal(attorneyAccess(s).room_name, roomName(room.id));
      }
      assert.deepEqual(
        [count("consultations"), count("media_rooms")],
        [consultations, rooms],
      );
      const recorded = sessionsOf(s.consultation);
      assert.deepEqual(
        recorded.map((x) => [
          x.provider_code,
          x.provider_session_reference,
          x.provider_state,
        ]),
        [
          ["daily", first, "ended"],
          ["daily", second, "ongoing"],
        ],
      );
      const evidence = participationOf(s.consultation);
      assert.equal(evidence.length, 4);
      for (const row of evidence) {
        assert.deepEqual(Object.keys(row.observed).sort(), [
          "observation",
          "participant_role",
          "source_type",
        ]);
        assert.equal(row.observed.source_type, "operational_job");
      }
      const view = clientView(s);
      assert.deepEqual(
        [
          view.attorney_joined_at !== null,
          view.client_joined_at !== null,
          view.both_present,
          view.either_left,
          view.provider_sessions,
          view.reconnections,
          view.state,
        ],
        [true, true, true, true, 2, 2, "live"],
      );
      return view;
    },
  );

  await check(
    "EV-1 (TA section 53 idempotency and stale observations) replaying the same provider observation adds nothing (no_effect); an older observation of a session moves its start only earlier; its end is recorded once; an ongoing observation of an ended session, and an end before the start, are stale and change nothing; the evidence and session guards refuse updates, deletes and truncates for every role, the owner included",
    () => {
      const { s, room, second, sessions } = world.reconnect;
      const before = s9Counts();
      assert.equal(observeWith(room.id, sessions).outcome, "no_effect");
      const after = s9Counts();
      assert.deepEqual(
        { ...after, operational_jobs: before.operational_jobs },
        before,
      );
      const earlier = isoAgo(40);
      assert.equal(
        observeWith(room.id, [
          {
            session_reference: second,
            started_at: earlier,
            ended_at: null,
            participants: [],
          },
        ]).outcome,
        "applied",
      );
      const session = () =>
        sessionsOf(s.consultation).find(
          (x) => x.provider_session_reference === second,
        );
      assert.equal(ms(session().started_at), ms(earlier));
      assert.equal(
        observeWith(room.id, [
          {
            session_reference: second,
            started_at: isoAgo(15),
            ended_at: null,
            participants: [],
          },
        ]).outcome,
        "no_effect",
      );
      assert.equal(ms(session().started_at), ms(earlier));
      const ended = isoAgo(2);
      assert.equal(
        observeWith(room.id, [
          {
            session_reference: second,
            started_at: earlier,
            ended_at: ended,
            participants: [],
          },
        ]).outcome,
        "applied",
      );
      assert.deepEqual(
        [session().provider_state, ms(session().ended_at)],
        ["ended", ms(ended)],
      );
      assert.equal(
        observeWith(room.id, [
          {
            session_reference: second,
            started_at: earlier,
            ended_at: null,
            participants: [],
          },
        ]).outcome,
        "stale",
      );
      assert.equal(session().provider_state, "ended");
      assert.equal(
        observeWith(room.id, [
          {
            session_reference: sessionRef(),
            started_at: isoAgo(5),
            ended_at: isoAgo(10),
            participants: [],
          },
        ]).outcome,
        "stale",
      );
      assert.equal(
        observeWith(room.id, [
          {
            session_reference: second,
            started_at: earlier,
            ended_at: ended,
            participants: [
              {
                participant_reference: participantRef(),
                user_id: s.client.user,
                joined_at: isoAgo(5),
                left_at: isoAgo(9),
              },
            ],
          },
        ]).outcome,
        "stale",
      );
      const sessionId = session().id;
      for (const statement of [
        `update public.media_sessions set started_at = now() where id = '${sessionId}';`,
        `update public.media_sessions set ended_at = null, provider_state = 'ongoing' where id = '${sessionId}';`,
        `update public.media_sessions set provider_session_reference = 'synthetic-other' where id = '${sessionId}';`,
        `delete from public.media_sessions where id = '${sessionId}';`,
        "truncate public.media_sessions cascade;",
        `update public.session_participation_records set left_at = now() where media_session_id = '${sessionId}';`,
        `delete from public.session_participation_records where media_session_id = '${sessionId}';`,
        "truncate public.session_participation_records;",
      ]) {
        assert.equal(refused(statement), "55000", statement);
      }
      return session();
    },
  );

  await check(
    "MBS14-3 (provider evidence conflicting with canonical state creates a Reconciliation Exception; IMP section 25 'provider disagreement creates reconciliation, not silent correction') a participant whose user id is not the client's or attorney's (or who presents none) opens one critical media_unrecognized_participant item and records nothing for it; the provider reporting no room while the Media Room is open for a live Consultation opens one high media_room_missing item; a provider session or a join after the Consultation became terminal opens one high media_activity_outside_consultation item; one open item per type and Consultation (a repeat adds none), each audited once with minimized evidence (identifiers, states, roles, sources; never a name or provider payload); the Consultation, payment and Engagement never change",
    () => {
      const { s, room, second } = world.reconnect;
      const snapshot = unchanged(s);
      const stranger = participantRef();
      const outcome = observeWith(room.id, [
        {
          session_reference: second,
          started_at: isoAgo(40),
          ended_at: isoAgo(2),
          participants: [
            {
              participant_reference: stranger,
              user_id: uid(),
              joined_at: isoAgo(6),
              left_at: isoAgo(3),
            },
            {
              participant_reference: participantRef(),
              user_id: null,
              joined_at: isoAgo(6),
              left_at: null,
            },
          ],
        },
      ]).outcome;
      assert.equal(outcome, "contradiction");
      const unrecognized = itemsOf(
        "media_unrecognized_participant",
        s.consultation,
      );
      assert.deepEqual(
        [
          unrecognized.length,
          unrecognized[0].severity,
          unrecognized[0].status,
          unrecognized[0].source_type,
          unrecognized[0].canonical_type,
        ],
        [1, "critical", "open", "consultation", "consultation"],
      );
      assert.deepEqual(Object.keys(unrecognized[0].evidence).sort(), [
        "consultation_state",
        "media_room_id",
        "media_session_id",
        "participant_reference",
        "source_id",
        "source_type",
        "user_id_presented",
      ]);
      assert.equal(
        participationOf(s.consultation).filter((r) => r.reference === stranger)
          .length,
        0,
      );
      ensureObserveJob(room.id);
      const missing = runMediaJob("media.observe", room.id, () => ({
        kind: "room_missing",
        room_name: roomName(room.id),
      }));
      assert.equal(missing.outcome, "contradiction");
      assert.deepEqual(
        itemsOf("media_room_missing", s.consultation).map((i) => [
          i.severity,
          i.status,
        ]),
        [["high", "open"]],
      );
      assert.deepEqual(unchanged(s).consultation, snapshot.consultation);
      assert.deepEqual(unchanged(s).payment, snapshot.payment);
      assert.deepEqual(unchanged(s).engagements, snapshot.engagements);
      assert.equal(end(s).outcome, "completed");
      const late = mediaEvent("participant.joined", {
        kind: "participant_joined",
        room_name: roomName(room.id),
        participant_reference: participantRef(),
        user_id: s.lawyer.user,
        joined_at: isoIn(180),
      });
      assert.equal(late.processing, "contradiction", late.line);
      const lateSession = mediaEvent("meeting.started", {
        kind: "meeting_started",
        room_name: roomName(room.id),
        session_reference: sessionRef(),
        started_at: isoIn(200),
      });
      assert.equal(lateSession.processing, "contradiction", lateSession.line);
      const outside = itemsOf(
        "media_activity_outside_consultation",
        s.consultation,
      );
      assert.deepEqual(
        [
          outside.length,
          outside[0].severity,
          outside[0].evidence.consultation_state,
        ],
        [1, "high", "completed"],
      );
      const repeat = observeWith(room.id, [
        {
          session_reference: second,
          started_at: isoAgo(40),
          ended_at: isoAgo(2),
          participants: [
            {
              participant_reference: participantRef(),
              user_id: uid(),
              joined_at: isoAgo(4),
              left_at: null,
            },
          ],
        },
      ]).outcome;
      assert.equal(repeat, "contradiction");
      assert.equal(
        itemsOf("media_unrecognized_participant", s.consultation).length,
        1,
      );
      const opened = jsonOf(
        `select coalesce(json_agg(a.after_snapshot ->> 'exception_type' order by a.occurred_at), '[]'::json)::text from public.audit_events a join public.reconciliation_exceptions e on e.id = a.resource_id where a.action_code = 'reconciliation_exception.opened' and e.canonical_id = '${s.consultation}';`,
      );
      assert.deepEqual([...opened].sort(), [
        "media_activity_outside_consultation",
        "media_room_missing",
        "media_unrecognized_participant",
      ]);
      const row = consultationRow(s.consultation);
      assert.deepEqual([row.state, row.outcome_code], ["completed", "normal"]);
      return {
        unrecognized: unrecognized[0].severity,
        outside: outside[0].severity,
      };
    },
  );

  await check(
    "EV-2 (PS section 23.1; Packet rule 12) the media webhook path: each authenticated event is one receipt (provider daily, the minimized observation and digest only), unique per event reference: a duplicate delivery answers duplicate with the first outcome and adds nothing; out-of-order deliveries (a departure before its join) are harmless; participant events attach to the session running at the join and enqueue one observation job; meeting.ended never ends the Consultation; an unknown room of Rosuno's form is unmatched with one medium media_unknown_room item, any other room name unmatched without one, an ignored kind ignored, and a malformed event invalid with no receipt",
    () => {
      const s = acceptedConsultation({ key: "G", who: lawyer("G") });
      const room = roomOf(s.consultation);
      openRoom(room.id);
      assert.equal(start(s).outcome, "started");
      const meeting = sessionRef();
      const started = mediaEvent("meeting.started", {
        kind: "meeting_started",
        room_name: roomName(room.id),
        session_reference: meeting,
        started_at: isoAgo(10),
      });
      assert.equal(started.processing, "applied", started.line);
      const ref = participantRef();
      const left = mediaEvent("participant.left", {
        kind: "participant_left",
        room_name: roomName(room.id),
        participant_reference: ref,
        user_id: s.client.user,
        joined_at: isoAgo(8),
        left_at: isoAgo(4),
      });
      assert.equal(left.processing, "applied", left.line);
      const joinedObservation = {
        kind: "participant_joined",
        room_name: roomName(room.id),
        participant_reference: ref,
        user_id: s.client.user,
        joined_at: isoAgo(8),
      };
      const joined = mediaEvent("participant.joined", joinedObservation);
      assert.equal(joined.processing, "applied", joined.line);
      const receipts = count("external_event_receipts");
      const duplicate = mediaEvent(
        "participant.joined",
        joinedObservation,
        joined.id,
      );
      assert.deepEqual(
        [duplicate.outcome, duplicate.processing],
        ["duplicate", "applied"],
      );
      assert.equal(count("external_event_receipts"), receipts);
      assert.equal(participationOf(s.consultation).length, 2);
      assert.ok(openJob("media.observe", "media_room", room.id));
      const receipt = jsonOf(
        `select row_to_json(x)::text from (select provider_code, event_type, processing_state, correlation_reference, minimal_payload from public.external_event_receipts where provider_event_reference = '${joined.id}') x;`,
      );
      assert.deepEqual(
        [
          receipt.provider_code,
          receipt.event_type,
          receipt.processing_state,
          receipt.correlation_reference,
        ],
        ["daily", "participant.joined", "applied", room.id],
      );
      assert.deepEqual(Object.keys(receipt.minimal_payload).sort(), [
        "joined_at",
        "kind",
        "participant_reference",
        "provider_created_at",
        "room_name",
        "user_id",
      ]);
      const endedEvent = mediaEvent("meeting.ended", {
        kind: "meeting_ended",
        room_name: roomName(room.id),
        session_reference: meeting,
        started_at: isoAgo(10),
        ended_at: isoAgo(1),
      });
      assert.equal(endedEvent.processing, "applied");
      assert.equal(consultationRow(s.consultation).state, "live");
      const unknownRoom = uid();
      const unknown = mediaEvent("participant.joined", {
        ...joinedObservation,
        room_name: roomName(unknownRoom),
      });
      assert.equal(unknown.processing, "unmatched");
      const unknownReceipt = sql(
        `select id from public.external_event_receipts where provider_event_reference = '${unknown.id}';`,
      );
      assert.equal(
        count(
          "reconciliation_exceptions",
          `exception_type = 'media_unknown_room' and source_type = 'external_event_receipt' and source_id = '${unknownReceipt}' and severity = 'medium'`,
        ),
        1,
      );
      const exceptions = count("reconciliation_exceptions");
      assert.equal(
        mediaEvent("participant.joined", {
          ...joinedObservation,
          room_name: "lobby",
        }).processing,
        "unmatched",
      );
      assert.equal(count("reconciliation_exceptions"), exceptions);
      assert.equal(
        mediaEvent("recording.started", { kind: "ignored" }).processing,
        "ignored",
      );
      const before = count("external_event_receipts");
      for (const [eventId, observation] of [
        ["daily_synthetic_bad_1", { ...joinedObservation, extra: true }],
        [
          "daily_synthetic_bad_2",
          { ...joinedObservation, joined_at: "yesterday" },
        ],
        [
          "daily_synthetic_bad_3",
          { kind: "room_created", room_name: roomName(room.id) },
        ],
        ["daily-hyphenated-reference", joinedObservation],
      ]) {
        assert.equal(
          as(
            "service_role",
            null,
            MEDIA_EVENT_SQL(eventId, "participant.joined", observation),
          ),
          "invalid|",
          eventId,
        );
      }
      assert.equal(count("external_event_receipts"), before);
      world.webhookLive = s;
      return { receipt: receipt.processing_state };
    },
  );

  await check(
    "EV-3 (TA section 46: the provider room must not remain accessible) deletion: a closing Media Room's delete job waits while its creation job is still running (so a room being created is deleted after it exists), a creation result then changes nothing, and the delete acts; the recorded deletion closes the Media Room once (ended_at, system audit) and enqueues one more observation job, which acts on the closed room",
    () => {
      const s = acceptedConsultation({ key: "G", who: lawyer("G") });
      const room = roomOf(s.consultation);
      const create = openJob("media.room_create", "media_room", room.id);
      claimJob(create);
      assert.equal(start(s).outcome, "started");
      assert.equal(end(s).outcome, "completed");
      assert.equal(roomOf(s.consultation).state, "closing");
      const remove = openJob("media.room_delete", "media_room", room.id);
      claimJob(remove);
      assert.equal(mediaContextOf(remove).outcome, "wait");
      assert.equal(
        mediaRecord(create, {
          kind: "room_created",
          room_name: roomName(room.id),
          expires_at: isoIn(1800),
        }),
        "no_effect",
      );
      assert.equal(completeJob(create), "completed");
      const context = mediaContextOf(remove);
      assert.deepEqual(
        [context.outcome, context.operation],
        ["act", "room_delete"],
      );
      assert.equal(
        mediaRecord(remove, {
          kind: "room_deleted",
          room_name: roomName(room.id),
        }),
        "applied",
      );
      assert.equal(completeJob(remove), "completed");
      const closed = roomOf(s.consultation);
      assert.deepEqual(
        [closed.state, closed.ended_at !== null],
        ["closed", true],
      );
      assert.equal(auditsOf(room.id, "media_room.closed").length, 1);
      const observe = openJob("media.observe", "media_room", room.id);
      claimJob(observe);
      assert.equal(mediaContextOf(observe).outcome, "act");
      assert.equal(
        mediaRecord(observe, {
          kind: "meetings_observed",
          room_name: roomName(room.id),
          sessions: [],
        }),
        "no_effect",
      );
      assert.equal(completeJob(observe), "completed");
      assert.equal(
        refused(
          `update public.media_rooms set state = 'closing' where id = '${room.id}';`,
        ),
        "55000",
      );
      return closed;
    },
  );

  await check(
    "EV-4 the participants' RLS reads of the media relations (P1 participant policies, unchanged): the client and the attorney see their own Consultation's Media Room, sessions and participation records; another client sees none",
    () => {
      const s = world.reconnect.s;
      const counts = (account, aal) =>
        rowsAs(
          "authenticated",
          account.auth,
          `select (select count(*) from public.media_rooms where consultation_id = '${s.consultation}') || '|' || (select count(*) from public.media_sessions m join public.media_rooms r on r.id = m.media_room_id where r.consultation_id = '${s.consultation}') || '|' || (select count(*) from public.session_participation_records p join public.media_sessions m on m.id = p.media_session_id join public.media_rooms r on r.id = m.media_room_id where r.consultation_id = '${s.consultation}');`,
          { aal },
        )[0];
      const own = sql(
        `select 1 || '|' || (select count(*) from public.media_sessions m join public.media_rooms r on r.id = m.media_room_id where r.consultation_id = '${s.consultation}') || '|' || (select count(*) from public.session_participation_records p join public.media_sessions m on m.id = p.media_session_id join public.media_rooms r on r.id = m.media_room_id where r.consultation_id = '${s.consultation}');`,
      );
      assert.equal(counts(s.client, "aal1"), own);
      assert.equal(counts(s.lawyer, "aal2"), own);
      assert.equal(counts(newClient(), "aal1"), "0|0|0");
      return own;
    },
  );

  await check(
    "OBS-1 (correction F2: bounded observation; an expired provider room is no disagreement) the sweep enqueues an observation job only for open Media Rooms whose permitted window has not ended or ended less than 600 seconds ago (a fixed technical grace), never for one whose window ended long ago (fixture time shift); the provider reporting no room opens a media_room_missing item only while the window has not ended, never after it; the attorney's list ranks the Consultations whose window is open first, then upcoming ones, and those whose window has passed last (the most recent first)",
    () => {
      const who = lawyer("A");
      const owner = newClient();
      const current = acceptedConsultation({ key: "A", who, client: owner });
      const recent = acceptedConsultation({ key: "A", who, client: owner });
      const stale = acceptedConsultation({ key: "A", who, client: owner });
      for (const c of [current, recent, stale]) {
        openRoom(roomOf(c.consultation).id);
      }
      // Fixture time shift: the recent window ended about a minute ago, the
      // stale one about 85 minutes ago (instant: creation + 30 min + 300 s).
      shiftConsultation(recent.consultation, 36);
      shiftConsultation(stale.consultation, 120);
      const upcoming = acceptedConsultation({
        key: "A",
        requestPath: "scheduled",
        who,
        client: owner,
      });
      assert.equal(consultationRow(upcoming.consultation).state, "scheduled");
      const rooms = {
        current: roomOf(current.consultation).id,
        recent: roomOf(recent.consultation).id,
        stale: roomOf(stale.consultation).id,
      };
      for (const id of Object.values(rooms)) {
        assert.equal(openJob("media.observe", "media_room", id), null);
      }
      const run = sweep();
      assert.ok(openJob("media.observe", "media_room", rooms.current));
      assert.ok(openJob("media.observe", "media_room", rooms.recent));
      assert.equal(openJob("media.observe", "media_room", rooms.stale), null);
      ensureObserveJob(rooms.stale);
      const missing = {};
      for (const [key, c] of [
        ["stale", stale],
        ["recent", recent],
        ["current", current],
      ]) {
        const result = runMediaJob("media.observe", rooms[key], () => ({
          kind: "room_missing",
          room_name: roomName(rooms[key]),
        }));
        missing[key] = [
          result.outcome,
          itemsOf("media_room_missing", c.consultation).length,
        ];
      }
      assert.deepEqual(missing, {
        stale: ["no_effect", 0],
        recent: ["no_effect", 0],
        current: ["contradiction", 1],
      });
      const order = rowsAsAttorney(
        who,
        "select consultation_id from public.attorney_consultations();",
      );
      assert.deepEqual(order, [
        current.consultation,
        upcoming.consultation,
        recent.consultation,
        stale.consultation,
      ]);
      return { sweep: run, missing, order: order.length };
    },
  );
}

// ---------------------------------------------------------------------------
// CC: real concurrency (persistent sessions)
// ---------------------------------------------------------------------------

const answerOf = (rows) => {
  const line = lastLine(rows);
  return line === undefined ? null : JSON.parse(line);
};

async function concurrencyChecks() {
  await check(
    "CC-1 two simultaneous starts of one Consultation (the same attorney in two sessions): the second waits on the attorney's scheduling lock and, once the first commits, answers already_started; one start, one Engagement, one audit event",
    async () => {
      const s = acceptedConsultation({ key: "G", who: lawyer("G") });
      const first = await attorneySession("cc1-a", s.lawyer);
      const second = await attorneySession("cc1-b", s.lawyer);
      const a = answerOf(await first.ok(START_SQL(s.consultation)));
      const pending = second.send(START_SQL(s.consultation));
      await blockedOnLock(second.pid);
      await first.ok("commit;");
      const b = answerOf((await pending).rows);
      await second.ok("commit;");
      assert.deepEqual([a.outcome, b.outcome], ["started", "already_started"]);
      assert.equal(engagementsOf(s.consultation).length, 1);
      assert.equal(auditsOf(s.consultation, "consultation.started").length, 1);
      report.concurrency.two_starts_one_consultation = [a.outcome, b.outcome];
      return report.concurrency.two_starts_one_consultation;
    },
  );

  await check(
    "CC-2 (MB sections 32-33; the S8 carry-forward for simultaneous instant consultations) two simultaneous starts of two ready Consultations of the same attorney: serialized by the attorney's scheduling lock, the first wins and the second answers attorney_in_consultation; exactly one live Consultation",
    async () => {
      const who = lawyer("G");
      const one = acceptedConsultation({ key: "G", who });
      const two = acceptedConsultation({ key: "G", who });
      const first = await attorneySession("cc2-a", who);
      const second = await attorneySession("cc2-b", who);
      const a = answerOf(await first.ok(START_SQL(one.consultation)));
      const pending = second.send(START_SQL(two.consultation));
      await blockedOnLock(second.pid);
      await first.ok("commit;");
      const b = answerOf((await pending).rows);
      await second.ok("commit;");
      assert.deepEqual(
        [a.outcome, b.outcome],
        ["started", "attorney_in_consultation"],
      );
      assert.equal(
        count(
          "consultations",
          `attorney_id = '${who.profile}' and state = 'live'`,
        ),
        1,
      );
      assert.equal(consultationRow(two.consultation).state, "ready");
      report.concurrency.two_starts_two_consultations = [a.outcome, b.outcome];
      return report.concurrency.two_starts_two_consultations;
    },
  );

  await check(
    "CC-3 a start racing the end and a provider observation: the end waits for the start and then completes the now live Consultation; a webhook observation on the same Media Room waits for the start's room lock and then records its evidence; no deadlock",
    async () => {
      const s = acceptedConsultation({ key: "G", who: lawyer("G") });
      const room = roomOf(s.consultation);
      openRoom(room.id);
      const meeting = sessionRef();
      mediaEvent("meeting.started", {
        kind: "meeting_started",
        room_name: roomName(room.id),
        session_reference: meeting,
        started_at: isoAgo(5),
      });
      const starter = await attorneySession("cc3-start", s.lawyer);
      const ender = await attorneySession("cc3-end", s.lawyer);
      const hook = await serviceSession("cc3-hook");
      const a = answerOf(await starter.ok(START_SQL(s.consultation)));
      const ending = ender.send(END_SQL(s.consultation));
      await blockedOnLock(ender.pid);
      const eventId = `daily_${sha256(uid()).slice(0, 40)}`;
      const observing = hook.send(
        MEDIA_EVENT_SQL(eventId, "participant.joined", {
          kind: "participant_joined",
          room_name: roomName(room.id),
          participant_reference: participantRef(),
          user_id: s.client.user,
          joined_at: isoAgo(2),
        }),
      );
      await blockedOnLock(hook.pid);
      await starter.ok("commit;");
      // Each waiting session commits as soon as its own statement returns: the
      // end and the observation then queue on the Media Room in either order.
      const [endedResult, observedResult] = await Promise.all([
        ending.then(async (result) => {
          await ender.ok("commit;");
          return result;
        }),
        observing.then(async (result) => {
          await hook.ok("commit;");
          return result;
        }),
      ]);
      assert.deepEqual(
        [endedResult.sqlstate, observedResult.sqlstate],
        ["00000", "00000"],
        endedResult.stderr + observedResult.stderr,
      );
      const ended = answerOf(endedResult.rows);
      const observed = lastLine(observedResult.rows);
      assert.equal(a.outcome, "started");
      assert.equal(ended.outcome, "completed");
      assert.equal(observed, "recorded|applied");
      assert.equal(consultationRow(s.consultation).state, "completed");
      report.concurrency.start_end_observation = [
        a.outcome,
        ended.outcome,
        observed,
      ];
      return report.concurrency.start_end_observation;
    },
  );

  await check(
    "CC-4 a start racing the ready sweep: the start records scheduled -> ready and live in its own transaction; the concurrent sweep skips the locked row (busy) and creates nothing; afterwards the Consultation is live with exactly one Media Room",
    async () => {
      const s = acceptedConsultation({
        key: "G",
        requestPath: "scheduled",
        who: lawyer("G"),
        slot: nearSlot(40),
      });
      assert.equal(consultationRow(s.consultation).state, "scheduled");
      const starter = await attorneySession("cc4-start", s.lawyer);
      const owner = await ownerSession("cc4-sweep");
      const a = answerOf(await starter.ok(START_SQL(s.consultation)));
      const swept = JSON.parse(lastLine(await owner.ok(SWEEP_SQL)));
      await owner.ok("commit;");
      await starter.ok("commit;");
      assert.equal(a.outcome, "started");
      assert.ok(swept.busy >= 1, JSON.stringify(swept));
      assert.equal(consultationRow(s.consultation).state, "live");
      assert.equal(
        count("media_rooms", `consultation_id = '${s.consultation}'`),
        1,
      );
      assert.equal(auditsOf(s.consultation, "consultation.ready").length, 1);
      report.concurrency.start_versus_sweep = {
        start: a.outcome,
        sweep: swept,
      };
      return report.concurrency.start_versus_sweep;
    },
  );

  await check(
    "CC-5 media access racing the end: an access request that arrives while the end is uncommitted waits on the Consultation and then answers ended (no grant after the terminal state); an access that holds the Consultation first is granted and the end then waits and completes (the grant preceded the end)",
    async () => {
      const s = acceptedConsultation({ key: "G", who: lawyer("G") });
      openRoom(roomOf(s.consultation).id);
      assert.equal(start(s).outcome, "started");
      const ender = await attorneySession("cc5-end", s.lawyer);
      const viewer = await clientSession("cc5-client", s.client);
      const ended = answerOf(await ender.ok(END_SQL(s.consultation)));
      const asking = viewer.send(ACCESS_SQL(s.consultation));
      await blockedOnLock(viewer.pid);
      await ender.ok("commit;");
      const late = answerOf((await asking).rows);
      await viewer.ok("commit;");
      assert.deepEqual(
        [ended.outcome, late.outcome, late.room_name],
        ["completed", "ended", null],
      );
      const t = acceptedConsultation({ key: "G", who: lawyer("G") });
      openRoom(roomOf(t.consultation).id);
      assert.equal(start(t).outcome, "started");
      const holder = await clientSession("cc5-client-2", t.client);
      const finisher = await attorneySession("cc5-end-2", t.lawyer);
      const granted = answerOf(await holder.ok(ACCESS_SQL(t.consultation)));
      const finishing = finisher.send(END_SQL(t.consultation));
      await blockedOnLock(finisher.pid);
      await holder.ok("commit;");
      const finished = answerOf((await finishing).rows);
      await finisher.ok("commit;");
      assert.deepEqual(
        [granted.outcome, finished.outcome],
        ["granted", "completed"],
      );
      report.concurrency.access_versus_end = {
        end_first: [ended.outcome, late.outcome],
        access_first: [granted.outcome, finished.outcome],
      };
      return report.concurrency.access_versus_end;
    },
  );

  await check(
    "CC-6 (deadlock freedom under mixed load) seven persistent autocommit sessions run 84 interleaved operations on six Consultations of one attorney and one client (starts and ends from two attorney sessions, media access from two client sessions, the ready sweep from the owner, provider webhook observations from the service role, and licence touches that run the S8 review trigger): no deadlock (40P01) or lock timeout (55P03), every answer is a fixed outcome, and the invariants hold (at most one live Consultation of the attorney; each Consultation one Media Room; every completed one normal with a closing or closed Media Room)",
    async () => {
      const who = lawyer("G");
      const owner = newClient();
      const cases = Array.from({ length: 6 }, () =>
        acceptedConsultation({ key: "G", who, client: owner }),
      );
      for (const c of cases) {
        openRoom(roomOf(c.consultation).id);
      }
      const deadlocksBefore = Number(
        sql(
          "select deadlocks from pg_stat_database where datname = current_database();",
        ),
      );
      let seedValue = 20261125;
      const random = (n) => {
        seedValue = (seedValue * 1103515245 + 12345) % 2147483648;
        return Math.floor(seedValue / 65536) % n;
      };
      const autocommit = async (label, role, account, aal) => {
        const s = await session(label);
        if (role !== null) {
          await s.ok(`set role ${role};`);
          if (account !== null) {
            await s.ok(
              `select set_config('request.jwt.claim.sub', ${lit(account.auth)}, false) is not null;`,
            );
            await s.ok(
              `select set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: account.auth, role, aal }))}, false) is not null;`,
            );
          }
        }
        return s;
      };
      const pick = () => cases[random(cases.length)];
      const plans = [
        [
          "att1",
          "authenticated",
          who,
          "aal2",
          () => (random(3) === 0 ? END_SQL : START_SQL)(pick().consultation),
        ],
        [
          "att2",
          "authenticated",
          who,
          "aal2",
          () => (random(3) === 0 ? END_SQL : START_SQL)(pick().consultation),
        ],
        [
          "cli1",
          "authenticated",
          owner,
          "aal1",
          () => ACCESS_SQL(pick().consultation),
        ],
        [
          "cli2",
          "authenticated",
          owner,
          "aal1",
          () => ACCESS_SQL(pick().consultation),
        ],
        ["own", null, null, null, () => SWEEP_SQL],
        [
          "hook",
          "service_role",
          null,
          null,
          () => {
            const c = pick();
            return MEDIA_EVENT_SQL(
              `daily_${sha256(uid()).slice(0, 40)}`,
              "participant.joined",
              {
                kind: "participant_joined",
                room_name: roomName(roomOf(c.consultation).id),
                participant_reference: participantRef(),
                user_id: c.client.user,
                joined_at: isoAgo(1),
              },
            );
          },
        ],
        [
          "fact",
          null,
          null,
          null,
          () =>
            `update public.licenses set reported_status = 'synthetic-active' where attorney_id = '${who.profile}';`,
        ],
      ];
      const sessions = [];
      for (const [label, role, account, aal] of plans) {
        sessions.push(await autocommit(`cc6-${label}`, role, account, aal));
      }
      const statements = plans.map((plan) =>
        Array.from({ length: 12 }, plan[4]),
      );
      const results = await Promise.all(
        sessions.map(async (s, index) => {
          const answers = [];
          for (const statement of statements[index]) {
            const result = await s.send(statement);
            answers.push({
              sqlstate: result.sqlstate,
              answer: lastLine(result.rows) ?? "",
            });
          }
          return answers;
        }),
      );
      for (const s of sessions) {
        s.close();
      }
      const all = results.flat();
      assert.deepEqual(
        [...new Set(all.map((r) => r.sqlstate))],
        ["00000"],
        JSON.stringify(all.filter((r) => r.sqlstate !== "00000")),
      );
      const answers = {};
      for (const r of all) {
        let key = r.answer;
        if (key.startsWith("{")) {
          const parsed = JSON.parse(key);
          key =
            parsed.outcome ?? (parsed.ready !== undefined ? "sweep" : "other");
        } else {
          key = key.split("|").slice(0, 2).join("|");
        }
        answers[key] = (answers[key] ?? 0) + 1;
      }
      for (const key of Object.keys(answers)) {
        assert.ok(
          [
            "started",
            "already_started",
            "attorney_in_consultation",
            "completed",
            "ended",
            "not_started",
            "granted",
            // Correction F4: media access before the start is the waiting room.
            "waiting",
            "sweep",
            "recorded|applied",
            "recorded|no_effect",
            "recorded|contradiction",
            "",
          ].includes(key),
          key,
        );
      }
      assert.ok(
        Number(
          sql(
            `select count(*) from public.consultations where attorney_id = '${who.profile}' and state = 'live';`,
          ),
        ) <= 1,
      );
      for (const c of cases) {
        const row = consultationRow(c.consultation);
        assert.equal(
          count("media_rooms", `consultation_id = '${c.consultation}'`),
          1,
        );
        if (row.state === "completed") {
          assert.equal(row.outcome_code, "normal");
          assert.ok(
            ["closing", "closed"].includes(roomOf(c.consultation).state),
          );
        }
      }
      sql("select pg_stat_force_next_flush();");
      const deadlocksAfter = Number(
        sql(
          "select deadlocks from pg_stat_database where datname = current_database();",
        ),
      );
      assert.equal(deadlocksAfter, deadlocksBefore);
      report.concurrency.mixed_load = {
        operations: all.length,
        answers,
        deadlocks: deadlocksAfter - deadlocksBefore,
      };
      return report.concurrency.mixed_load;
    },
  );
}

// ---------------------------------------------------------------------------
// PROD: a production-class database
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

// A production-class jurisdiction with a launch authorization and the given
// lifecycle state, and its scheduling version (approved and active, or a
// planted development row).
function prodJurisdiction(key, lifecycle, scheduling) {
  const id = newJurisdiction(`SYN_S9_PROD_${key}`, PROD_DB, "ready");
  prodSql(
    `insert into public.launch_authorizations (jurisdiction_id, authorized_at, authorized_by_user_id, reason) values ('${id}', now() - interval '1 day', '${prod.grantor.user}', 'synthetic launch authorization');
     update public.jurisdictions set lifecycle_state = '${lifecycle}' where id = '${id}';`,
  );
  const parameters = SCHEDULING(TIMING(600, 300));
  const version =
    scheduling === "planted"
      ? prodPlantedDevelopment("scheduling", id, parameters)
      : prodActivePolicy("scheduling", id, parameters);
  return { id, scheduling: version };
}

// A ready instant Consultation with an open Media Room, planted by the owner
// with triggers bypassed (the production gate is what is examined).
function prodReadyConsultation(jurisdiction, state = "ready") {
  const client = newAccount("active", PROD_DB);
  const attorneyAccount = newAccount("active", PROD_DB);
  const ids = {
    clientProfile: uid(),
    attorneyProfile: uid(),
    intake: uid(),
    referral: uid(),
    request: uid(),
    consultation: uid(),
    room: uid(),
    referralPolicy: uid(),
  };
  prodSql(
    `begin;
     set local session_replication_role = replica;
     insert into public.client_profiles (id, user_id) values ('${ids.clientProfile}', '${client.user}');
     insert into public.attorney_profiles (id, user_id, profile_state, display_name, years_experience) values ('${ids.attorneyProfile}', '${attorneyAccount.user}', 'approved', 'Synthetic Prod Attorney', 5);
     insert into public.intakes (id, client_id, state) values ('${ids.intake}', '${ids.clientProfile}', 'submitted');
     insert into public.policy_versions (id, policy_type_code, jurisdiction_id, version_label, parameters, status, effective_from, development_only) values ('${ids.referralPolicy}', 'referral', '${jurisdiction.id}', 'synthetic-planted-referral-${ids.referralPolicy.slice(0, 8)}', '{}'::jsonb, 'draft', now() - interval '1 day', false);
     insert into public.referrals (id, intake_id, attorney_id, jurisdiction_id, attempt_ordinal, allocation_method) values ('${ids.referral}', '${ids.intake}', '${ids.attorneyProfile}', '${jurisdiction.id}', 1, 'client_selected');
     insert into public.consultation_requests (id, intake_id, client_id, selected_attorney_id, referral_id, request_path, referral_policy_version_id, requested_modality, requested_duration_minutes, state, response_deadline_at, accepted_at)
       values ('${ids.request}', '${ids.intake}', '${ids.clientProfile}', '${ids.attorneyProfile}', '${ids.referral}', 'instant', '${ids.referralPolicy}', 'synthetic_video', 30, 'accepted', now() + interval '1 hour', now());
     insert into public.consultations (id, consultation_request_id, client_id, attorney_id, request_path, referral_policy_version_id, modality, state, started_at)
       values ('${ids.consultation}', '${ids.request}', '${ids.clientProfile}', '${ids.attorneyProfile}', 'instant', '${ids.referralPolicy}', 'synthetic_video', '${state}', ${state === "live" ? "now()" : "null"});
     insert into public.media_rooms (id, consultation_id, modality, state) values ('${ids.room}', '${ids.consultation}', 'synthetic_video', 'open');
     commit;`,
  );
  return { ...ids, client, attorney: attorneyAccount };
}

// A payment of a planted Consultation (owner, triggers bypassed) whose payment
// flow version (active, not development-only) captures at the given moment.
function prodLivePayment(c, jurisdiction, capture, state) {
  const flow = uid();
  const payment = uid();
  const captured = state === "captured";
  prodSql(
    `begin;
     set local session_replication_role = replica;
     insert into public.policy_versions (id, policy_type_code, jurisdiction_id, regulatory_mode_id, version_label, parameters, status, effective_from, development_only, approved_at, approved_by_user_id)
       values ('${flow}', 'payment_flow', '${jurisdiction.id}', '${prod.mode}', 'synthetic-planted-flow-${flow.slice(0, 8)}', ${lit(FLOW_ALL(BEFORE, capture))}::jsonb, 'active', now() - interval '1 day', false, now() - interval '2 days', '${prod.grantor.user}');
     insert into public.payment_transactions (id, fee_calculation_id, consultation_request_id, consultation_id, jurisdiction_id, regulatory_mode_id, referral_policy_version_id, payment_policy_version_id, fee_policy_version_id, payment_flow_policy_version_id, engagement_policy_version_id, cancellation_policy_version_id, refund_policy_version_id, state, amount_authorized_minor, amount_captured_minor, currency_code, provider_code, provider_payment_reference, authorized_at, captured_at)
       values ('${payment}', '${uid()}', '${c.request}', '${c.consultation}', '${jurisdiction.id}', '${prod.mode}', '${c.referralPolicy}', '${uid()}', '${uid()}', '${flow}', '${uid()}', '${uid()}', '${uid()}', '${state}', 5000, ${captured ? "5000" : "null"}, 'XTS', 'stripe', 'pi_synthetic_${payment.slice(0, 8)}', now() - interval '1 hour', ${captured ? "now() - interval '30 minutes'" : "null"});
     commit;`,
  );
  return { payment, flow };
}

async function productionChecks() {
  await check(
    "PROD-1 (MBS section 19; TA section 32 F1-F2; Packet section 4 four-way gate) in a production-class database media decisions never use development configuration and need the four-way gate for the jurisdiction: with only a development timing version (never selected in a production-class database, PS-A2) media access answers configuration_unavailable and the start configuration_unavailable timing_no_applicable_policy; with an approved, active timing version in a jurisdiction that is not live, configuration_unavailable production_gate_closed; the room creation job waits; nothing changes; with all four conditions a ready Consultation waits for the start and a live one is granted (so the gate, not a blanket refusal, decides)",
    () => {
      prod.grantor = newAccount("active", PROD_DB);
      prodSql(
        `insert into public.staff_profiles (user_id, staff_state) values ('${prod.grantor.user}', 'active');`,
      );
      const planted = prodJurisdiction("PLANTED", "live", "planted");
      const notLive = prodJurisdiction("RESTRICTED", "restricted", "active");
      const live = prodJurisdiction("LIVE", "live", "active");
      const answers = {};
      const counts = () =>
        prodSql(
          "select (select count(*) from public.audit_events) || '|' || (select count(*) from public.operational_jobs) || '|' || (select count(*) from public.media_rooms where state = 'open') || '|' || (select count(*) from public.consultations where state = 'live');",
        );
      for (const [key, jurisdiction] of [
        ["planted", planted],
        ["not_live", notLive],
        ["live", live],
      ]) {
        const c = prodReadyConsultation(jurisdiction);
        const before = counts();
        const access = asIn(
          PROD_DB,
          "authenticated",
          c.client.auth,
          `select outcome from public.consultation_media_access('${c.consultation}');`,
          { aal: "aal1" },
        );
        const startAnswer = asIn(
          PROD_DB,
          "authenticated",
          c.attorney.auth,
          `select outcome || '|' || coalesce(problem, '') from public.consultation_start('${c.consultation}');`,
        );
        answers[key] = { access, start: startAnswer };
        if (key !== "live") {
          assert.equal(counts(), before, key);
        }
      }
      assert.deepEqual(answers, {
        planted: {
          access: "configuration_unavailable",
          start: "configuration_unavailable|timing_no_applicable_policy",
        },
        not_live: {
          access: "configuration_unavailable",
          start: "configuration_unavailable|production_gate_closed",
        },
        live: {
          access: "waiting",
          start: "payment_not_ready|no_payment",
        },
      });
      // With all four conditions a live Consultation's participant is granted
      // the room (correction F4: a ready one waits for the start).
      const liveConsultation = prodReadyConsultation(live, "live");
      assert.equal(
        asIn(
          PROD_DB,
          "authenticated",
          liveConsultation.client.auth,
          `select outcome from public.consultation_media_access('${liveConsultation.consultation}');`,
          { aal: "aal1" },
        ),
        "granted",
      );
      const pending = prodReadyConsultation(notLive);
      prodSql(
        `begin;
         set local session_replication_role = replica;
         update public.media_rooms set state = 'pending' where id = '${pending.room}';
         commit;
         select public.job_enqueue('media.room_create', 'media_room', '${pending.room}', now(), 8);`,
      );
      const job = prodSql(
        `select id from public.operational_jobs where subject_id = '${pending.room}' and job_type = 'media.room_create';`,
      );
      prodSql(
        `update public.operational_jobs set state = 'running', locked_at = now(), locked_by = 's9-proof', attempt_count = attempt_count + 1, available_at = now() + interval '60 seconds' where id = '${job}';`,
      );
      assert.equal(
        asIn(
          PROD_DB,
          "service_role",
          null,
          `select outcome from public.media_job_context('${job}');`,
        ),
        "wait",
      );
      return answers;
    },
  );

  await check(
    "PROD-2 (correction F3: in a production-class database the end needs the four-way gate only when it will request a capture) the attorney ends a live Consultation in a jurisdiction with no applicable timing version and no payment, and one in a jurisdiction that is not live whose payment was captured at the acceptance: both completed; in that jurisdiction a live Consultation whose payment flow captures at completion is refused configuration_unavailable production_gate_closed and nothing changes",
    () => {
      prod.mode = prod.mode ?? newRegulatoryMode("SYN_S9_PROD_MODE", PROD_DB);
      const planted = prodJurisdiction("END_PLANTED", "live", "planted");
      const notLive = prodJurisdiction(
        "END_RESTRICTED",
        "restricted",
        "active",
      );
      const endAs = (c) =>
        asIn(
          PROD_DB,
          "authenticated",
          c.attorney.auth,
          `select outcome || '|' || coalesce(problem, '') from public.consultation_end('${c.consultation}');`,
        );
      const noPayment = prodReadyConsultation(planted, "live");
      const captured = prodReadyConsultation(notLive, "live");
      prodLivePayment(captured, notLive, "at_attorney_acceptance", "captured");
      const atCompletion = prodReadyConsultation(notLive, "live");
      prodLivePayment(
        atCompletion,
        notLive,
        "at_consultation_completion",
        "authorized",
      );
      const stateOf = (c) =>
        prodSql(
          `select c.state || '|' || m.state || '|' || (select count(*) from public.audit_events a where a.resource_id = c.id) || '|' || (select count(*) from public.operational_jobs j where j.subject_id = m.id) || '|' || coalesce((select string_agg(p.state, ',') from public.payment_transactions p where p.consultation_id = c.id), 'none') from public.consultations c join public.media_rooms m on m.consultation_id = c.id where c.id = '${c.consultation}';`,
        );
      const before = stateOf(atCompletion);
      const answers = {
        no_payment: endAs(noPayment),
        captured: endAs(captured),
        at_completion: endAs(atCompletion),
      };
      assert.deepEqual(answers, {
        no_payment: "completed|",
        captured: "completed|",
        at_completion: "configuration_unavailable|production_gate_closed",
      });
      assert.equal(stateOf(atCompletion), before);
      assert.ok(before.startsWith("live|open|"), before);
      for (const c of [noPayment, captured]) {
        assert.ok(stateOf(c).startsWith("completed|closing|"), stateOf(c));
      }
      return answers;
    },
  );
}

// ---------------------------------------------------------------------------
// IMP section 25 exit: one consultation end to end through the functions only
// ---------------------------------------------------------------------------

async function exitCheck() {
  await check(
    "EXIT-1 (IMP section 25 exit; PM row 20) a client and an attorney conduct a test consultation without direct database intervention: Request, authorization and acceptance (S6-S8), the Media Room created and opened by the worker, both participants in the waiting room until the attorney's start (correction F4), then both authorized, the provider's participation evidence recorded, a brief drop and reconnect (PM row 19: still live), the attorney's end (completed, normal), the provider room deleted and closed; the derived evidence shows both joined and present together; the client sees the ended Consultation",
    () => {
      const who = lawyer("G");
      const s = acceptedConsultation({ key: "G", who });
      const room = roomOf(s.consultation);
      // The waiting room (correction F4): nothing is granted before the start.
      assert.equal(clientAccess(s).outcome, "waiting");
      openRoom(room.id);
      assert.equal(clientAccess(s).outcome, "waiting");
      assert.equal(attorneyAccess(s).outcome, "waiting");
      assert.equal(start(s).outcome, "started");
      assert.equal(attorneyAccess(s).outcome, "granted");
      assert.equal(clientAccess(s).outcome, "granted");
      const meeting = sessionRef();
      const clientRef = participantRef();
      mediaEvent("meeting.started", {
        kind: "meeting_started",
        room_name: roomName(room.id),
        session_reference: meeting,
        started_at: isoAgo(6),
      });
      mediaEvent("participant.joined", {
        kind: "participant_joined",
        room_name: roomName(room.id),
        participant_reference: clientRef,
        user_id: s.client.user,
        joined_at: isoAgo(5),
      });
      const attorneyRef = participantRef();
      mediaEvent("participant.joined", {
        kind: "participant_joined",
        room_name: roomName(room.id),
        participant_reference: attorneyRef,
        user_id: s.lawyer.user,
        joined_at: isoAgo(4),
      });
      mediaEvent("participant.left", {
        kind: "participant_left",
        room_name: roomName(room.id),
        participant_reference: clientRef,
        user_id: s.client.user,
        joined_at: isoAgo(5),
        left_at: isoAgo(2),
      });
      assert.equal(clientAccess(s).outcome, "granted");
      mediaEvent("participant.joined", {
        kind: "participant_joined",
        room_name: roomName(room.id),
        participant_reference: participantRef(),
        user_id: s.client.user,
        joined_at: isoAgo(1),
      });
      assert.equal(consultationRow(s.consultation).state, "live");
      assert.equal(end(s).outcome, "completed");
      const removed = runMediaJob("media.room_delete", room.id, () => ({
        kind: "room_deleted",
        room_name: roomName(room.id),
      }));
      assert.equal(removed.outcome, "applied");
      const view = clientView(s);
      assert.deepEqual(
        [
          view.state,
          view.outcome_code,
          view.media_state,
          view.both_present,
          view.reconnections,
          view.client_joined_at !== null,
          view.attorney_joined_at !== null,
        ],
        ["completed", "normal", "closed", true, 1, true, true],
      );
      assert.equal(clientAccess(s).outcome, "ended");
      return view;
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
    sql(
      `select public.record_deployment_environment('production', '${PRODUCTION_REF}');`,
      PROD_DB,
    );
    report.environment = {
      main: sql("select environment_class from public.deployment_environment;"),
      production: sql(
        "select environment_class from public.deployment_environment;",
        PROD_DB,
      ),
    };
    seed();
    await migrationChecks();
    await configurationChecks();
    await timingChecks();
    await roomChecks();
    await accessChecks();
    await startChecks();
    await endChecks();
    await evidenceChecks();
    await exitCheck();
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
