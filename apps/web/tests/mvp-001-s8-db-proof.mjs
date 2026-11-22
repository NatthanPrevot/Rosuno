// MVP-001 S8 disposable PostgreSQL proof (M10 Attorney decision /
// acceptance / booking).
// Explicitly invoked only:
//
//   node apps/web/tests/mvp-001-s8-db-proof.mjs
//
// Deliberately not a *.test.mjs file, so no application test run, p0:test,
// or CI job starts it. It uses Node built-ins and the system-installed
// PostgreSQL 16 initdb, pg_ctl, and psql binaries.
//
// It creates a new mode-0700 temporary directory, initializes a new cluster
// owned by an unprivileged account (never root), and starts it with TCP
// disabled and a private Unix-domain socket (port 54344, so it can run next
// to the MVP-001 S7 proof). The roles anon, authenticated, and service_role
// (BYPASSRLS), the synthetic auth schema (auth.users and an auth.uid() that
// reads request.jwt.claim.sub), the hosted platform's default privileges,
// and a no-op public.rls_auto_enable() are synthetic objects of this cluster
// only. Every migration is applied unmodified, in order, each in one
// transaction, to two databases: the main database records its environment
// as development; a second one records production (a synthetic 20-letter
// project reference) for the production gate probes. The three S8
// migrations must follow S7 and be registered.
//
// Configuration: every policy version of the development database
// (eligibility, scheduling, bookability, referral, fee, payment,
// payment_flow, engagement, cancellation, refund) is development
// configuration created by the owner role inside this disposable cluster
// (Packet rule 9); the production database uses owner-walked authority
// versions with a synthetic verified reference, or development rows planted
// with triggers bypassed for the negative probes. The engagement parameters
// (the G-5 Consultation creation condition and the G-1 effectiveness moment)
// and the payment_flow parameters (G-2/G-3) differ per synthetic
// jurisdiction so that every configured path is exercised both ways; they,
// the XTS test currency code, the synthetic_* modality codes, the SYN_*
// Regulatory Modes and every Request, payment, provider reference, review
// item and exception are synthetic test data (FP-1 section 3.4), never
// product values or decisions.
//
// The provider is simulated exactly as in the S7 proof: the probes play the
// worker (claim a payment job as the owner, read payment_job_context and
// record results through payment_record_operation as service_role) and the
// webhook route (payment_record_provider_event as service_role). No
// provider, Supabase project, network service or pre-existing cluster is
// contacted, and nothing persists after the run.
//
// Request sessions are modelled as PostgREST sets them from a verified JWT:
// request.jwt.claim.sub and the JSON request.jwt.claims (clients at aal1,
// attorneys and staff at aal2 unless a probe says otherwise); anonymous
// requests run as anon without a subject.
//
// The probes cover the MVP-001 Packet S8 acceptance for the database: every
// MBS section 13 failure test (named MBS13-1 .. MBS13-9 in the probes), the
// IMP section 11 transactional invariants (exclusive acceptance, acceptance
// and booking, no duplicate consultation, expiry and release, cancellation
// against acceptance), the mandatory acceptance revalidation, PM rows 1-10
// and 37-45 (each probe names its rows), authorization and visibility
// (nothing of the Intake, the client or the message before acceptance), the
// configuration seams both ways (Consultation creation, Engagement
// effectiveness, payment capture and authorization timing), the production
// gate, audit minimization, and the race list under real concurrency with
// two or more persistent sessions, with the exact observed outcomes. The
// JSON report goes to stdout; exit 0 means PASS, 1 FAIL, 2 cleanup failure.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54344;
const DB = "rosuno_s8_proof";
const PROD_DB = "rosuno_s8_proof_production";
const PRODUCTION_REF = "syntheticeightprodre";
const REPOSITORY_ROOT = path.resolve(
  path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
  "../../..",
);
const MIGRATIONS = path.join(REPOSITORY_ROOT, "supabase/migrations");
const S7_LAST = "20261123020000_mvp_001_s7_payment_engine.sql";
const S8_MIGRATIONS = Object.freeze([
  "20261124010000_mvp_001_s8_decision_integrity.sql",
  "20261124020000_mvp_001_s8_attorney_decision.sql",
  "20261124030000_mvp_001_s8_change_review.sql",
]);
// MVP-001 S9: the three S9 migrations follow the S8 migrations (applied by
// this proof as later registered migrations; registered and checked by the S9
// proof).
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

// MVP-001 S11: the seven S11 migrations follow the S10 migrations (applied by
// this proof as later registered migrations; registered and checked by the
// S11 proof).
const S11_MIGRATIONS = Object.freeze([
  "20261127010000_mvp_001_s11_completion_integrity.sql",
  "20261127020000_mvp_001_s11_completion.sql",
  "20261127030000_mvp_001_s11_exception_families.sql",
  "20261127040000_mvp_001_s11_reviews.sql",
  "20261127050000_mvp_001_s11_legal_holds.sql",
  "20261127060000_mvp_001_s11_complaints.sql",
  "20261127070000_mvp_001_s11_notification_events.sql",
]);
// MVP-001 S11 pass 2: the nine operations and administration migrations
// follow the seven pass 1 migrations (applied by this proof as later
// registered migrations; registered and checked by the S11 operations proof).
const S11_OPERATIONS_MIGRATIONS = Object.freeze([
  "20261127080000_mvp_001_s11_operations_integrity.sql",
  "20261127090000_mvp_001_s11_audit_workspace.sql",
  "20261127100000_mvp_001_s11_operations_dashboard.sql",
  "20261127110000_mvp_001_s11_attorney_operations.sql",
  "20261127120000_mvp_001_s11_client_administration.sql",
  "20261127130000_mvp_001_s11_referral_finance_reads.sql",
  "20261127140000_mvp_001_s11_policy_corrections.sql",
  "20261127150000_mvp_001_s11_capture_gate.sql",
  "20261127160000_mvp_001_s11_definer_search_path.sql",
]);
// MVP-001 S11 pass 2B: the participants' workspace reads follow
// (registered and checked by the S11 operations proof).
const S11_SURFACES_MIGRATIONS = Object.freeze([
  "20261127170000_mvp_001_s11_workspace_reads.sql",
]);
// MVP-001 S11 review corrections follow (registered and checked by the S11
// operations proof).
const S11_CORRECTIONS_MIGRATIONS = Object.freeze([
  "20261127180000_mvp_001_s11_review_corrections.sql",
]);

const report = {
  proof: "MVP-001 S8 disposable local PostgreSQL proof",
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
    path.join(os.tmpdir(), "rosuno-mvp-001-s8-db-proof-"),
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
    if (S8_MIGRATIONS.includes(file)) {
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
  // S8 follows S7, contiguous and in order, and every S8 migration is
  // registered unreviewed (sequences 44 to 46) and applied nowhere. MVP-001
  // S9: then exactly the three S9 migrations (registered and checked by the
  // S9 proof). MVP-001 S10: then exactly the five S10 migrations (registered
  // and checked by the S10 proof).
  const s7 = files.indexOf(S7_LAST);
  assert.ok(s7 >= 0, "the S7 payment engine migration is present");
  assert.deepEqual(files.slice(s7 + 1), [
    ...S8_MIGRATIONS,
    ...S9_MIGRATIONS,
    ...S10_MIGRATIONS,
    ...S11_MIGRATIONS,
    ...S11_OPERATIONS_MIGRATIONS,
    ...S11_SURFACES_MIGRATIONS,
    ...S11_CORRECTIONS_MIGRATIONS,
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
  S8_MIGRATIONS.forEach((file, index) => {
    const id = file.replace(/\.sql$/, "");
    const row = registered.find(
      (migration) => migration.artifact_path === `supabase/migrations/${file}`,
    );
    assert.ok(row, `${file} is registered`);
    assert.equal(row.migration_id, id);
    assert.equal(row.sequence, 44 + index);
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
  report.migrations.s8 = [...S8_MIGRATIONS];
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
    const mark = `__S8_${this.label}_${this.n}__`;
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
    process.stderr.write(`[s8-proof] PASS ${name}\n`);
  } catch (error) {
    failed = true;
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
    process.stderr.write(`[s8-proof] FAIL ${name}\n${error?.stack ?? error}\n`);
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
      `insert into public.licenses (id, attorney_id, jurisdiction_id, license_number, reported_status) values ('${licence}', '${profile}', '${jurisdiction}', 'SYN-S8-LIC-${String(licenceNumber).padStart(4, "0")}', 'synthetic-active');
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
    `update public.operational_jobs set state = 'running', locked_at = now(), locked_by = 's8-proof', attempt_count = attempt_count + 1, available_at = now() + interval '60 seconds' where id = '${jobId}';`,
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
    `select public.job_complete('${jobId}', 's8-proof');`,
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
// S8 configuration, seed and call helpers
// ---------------------------------------------------------------------------

const ENGAGEMENT = (creation, effective) => ({
  consultation_creation: creation,
  engagement_effective: effective,
});
const FLOW_ALL = (authorization, capture) =>
  FLOW(authorization, authorization, capture);

// The synthetic configuration of each jurisdiction (test values only; G-1,
// G-2, G-3 and G-5 stay configuration).
const JURISDICTIONS = Object.freeze({
  // Authorization before the decision, capture at acceptance; the
  // Consultation at acceptance alone; the Engagement effective at acceptance.
  A: {
    flow: FLOW_ALL(BEFORE, "at_attorney_acceptance"),
    engagement: ENGAGEMENT("attorney_acceptance", "at_attorney_acceptance"),
  },
  // Authorization at acceptance; the Engagement effective at consultation
  // start (S9); a referral version with a message maximum.
  B: {
    flow: FLOW_ALL(AT_ACCEPTANCE, "at_attorney_acceptance"),
    engagement: ENGAGEMENT("attorney_acceptance", "at_consultation_start"),
    message: 500,
  },
  // No engagement version (authorization at acceptance: no payment attempt
  // can exist without one).
  C: {
    flow: FLOW_ALL(AT_ACCEPTANCE, "at_attorney_acceptance"),
    engagement: null,
  },
  // A malformed engagement version.
  D: {
    flow: FLOW_ALL(BEFORE, "at_attorney_acceptance"),
    engagement: { consultation_creation: "attorney_acceptance" },
  },
  // The Consultation only once the payment is captured; capture at
  // acceptance; the Engagement effective at capture.
  E: {
    flow: FLOW_ALL(BEFORE, "at_attorney_acceptance"),
    engagement: ENGAGEMENT(
      "attorney_acceptance_and_payment_captured",
      "at_payment_capture",
    ),
  },
  // As E, with capture at authorization.
  F: {
    flow: FLOW_ALL(BEFORE, "at_authorization"),
    engagement: ENGAGEMENT(
      "attorney_acceptance_and_payment_captured",
      "at_payment_capture",
    ),
  },
  // Capture at consultation start; the Consultation at acceptance alone.
  G: {
    flow: FLOW_ALL(BEFORE, "at_consultation_start"),
    engagement: ENGAGEMENT("attorney_acceptance", "at_consultation_start"),
  },
  // The Consultation only with an Engagement effective at consultation start:
  // never satisfiable at the decision.
  H: {
    flow: FLOW_ALL(BEFORE, "at_consultation_start"),
    engagement: ENGAGEMENT(
      "attorney_acceptance_and_engagement_effective",
      "at_consultation_start",
    ),
  },
  // The Consultation with an authorized payment; the Engagement effective at
  // the Request.
  K: {
    flow: FLOW_ALL(BEFORE, "at_attorney_acceptance"),
    engagement: ENGAGEMENT(
      "attorney_acceptance_and_payment_authorized",
      "at_request",
    ),
  },
  // Authorization at acceptance; the flow version is closed mid-probe.
  N: {
    flow: FLOW_ALL(AT_ACCEPTANCE, "at_attorney_acceptance"),
    engagement: ENGAGEMENT("attorney_acceptance", "at_consultation_start"),
  },
  // The shortest quote validity the Fee Policy schema allows (60 seconds).
  Q: {
    flow: FLOW_ALL(AT_ACCEPTANCE, "at_attorney_acceptance"),
    engagement: ENGAGEMENT("attorney_acceptance", "at_consultation_start"),
    fee: FEE({ quote_validity_seconds: 60 }),
  },
  // An 8-second scheduled response window.
  X: {
    flow: FLOW_ALL(AT_ACCEPTANCE, "at_attorney_acceptance"),
    engagement: ENGAGEMENT("attorney_acceptance", "at_consultation_start"),
    scheduling: SCHEDULING({ scheduled_request_response_window_seconds: 8 }),
  },
  // An 8-second Hold response window.
  Y: {
    flow: FLOW_ALL(AT_ACCEPTANCE, "at_attorney_acceptance"),
    engagement: ENGAGEMENT("attorney_acceptance", "at_consultation_start"),
    scheduling: SCHEDULING({ hold_response_window_seconds: 8 }),
  },
  // Authorization before the decision with an 8-second instant window.
  Z: {
    flow: FLOW_ALL(BEFORE, "at_attorney_acceptance"),
    engagement: ENGAGEMENT("attorney_acceptance", "at_attorney_acceptance"),
    scheduling: SCHEDULING({ instant_request_response_window_seconds: 8 }),
  },
  // Review probes (eligibility changes).
  R: {
    flow: FLOW_ALL(AT_ACCEPTANCE, "at_attorney_acceptance"),
    engagement: ENGAGEMENT("attorney_acceptance", "at_consultation_start"),
  },
  // Review probes (an eligibility policy change).
  S: {
    flow: FLOW_ALL(AT_ACCEPTANCE, "at_attorney_acceptance"),
    engagement: ENGAGEMENT("attorney_acceptance", "at_consultation_start"),
  },
  // Review probes (a jurisdiction lifecycle change, money in flight).
  T: {
    flow: FLOW_ALL(BEFORE, "at_consultation_start"),
    engagement: ENGAGEMENT("attorney_acceptance", "at_consultation_start"),
  },
});

function seed() {
  world.mode = newRegulatoryMode("SYN_S8_MARKETPLACE");
  world.J = {};
  world.policies = {};
  world.policies.bookability = policy("bookability", null, {
    presence_window_seconds: 600,
  });
  world.platform = policy("fee", null, PLATFORM);
  for (const [key, config] of Object.entries(JURISDICTIONS)) {
    const id = newJurisdiction(`SYN_S8_${key}`);
    world.J[key] = id;
    const versions = {};
    versions.eligibility = policy("eligibility", id, ELIGIBILITY);
    versions.scheduling = policy(
      "scheduling",
      id,
      config.scheduling ?? SCHEDULING(),
    );
    versions.referral = policy("referral", id, {
      outcome_codes: ["synthetic_closed"],
      ...(config.message === undefined
        ? {}
        : { request_message_maximum_characters: config.message }),
    });
    versions.fee = policy("fee", id, config.fee ?? FEE());
    mapMode(id, world.mode);
    versions.payment_flow = policy("payment_flow", id, config.flow, world.mode);
    for (const type of ["payment", "cancellation", "refund"]) {
      versions[type] = policy(type, id, {}, world.mode);
    }
    if (config.engagement !== null) {
      versions.engagement = policy(
        "engagement",
        id,
        config.engagement,
        world.mode,
      );
    }
    world.policies[key] = versions;
  }
  const J = world.J;
  const all = Object.values(J);
  world.ann = attorney({ name: "Ann Synthetic", jurisdictions: all });
  world.bob = attorney({ name: "Bob Synthetic", jurisdictions: [J.A, J.B] });
  world.cal = attorney({ name: "Cal Synthetic", jurisdictions: [J.A, J.B] });
  world.dee = attorney({ name: "Dee Synthetic", jurisdictions: [J.R] });
  world.eve = attorney({ name: "Eve Synthetic", jurisdictions: [J.R] });
  world.fay = attorney({ name: "Fay Synthetic", jurisdictions: [J.R] });
  world.gus = attorney({ name: "Gus Synthetic", jurisdictions: [J.B] });
  world.hal = attorney({ name: "Hal Synthetic", jurisdictions: [J.B] });
  world.ivy = attorney({ name: "Ivy Synthetic", jurisdictions: [J.B] });
  world.jon = attorney({ name: "Jon Synthetic", jurisdictions: [J.S] });
  world.kim = attorney({ name: "Kim Synthetic", jurisdictions: [J.T] });
  world.lee = attorney({ name: "Lee Synthetic", jurisdictions: [J.R] });
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
}) {
  const owner = client ?? newClient();
  const referral = ownerReferral({
    client: owner,
    lawyer,
    jurisdiction,
    requestPath,
  });
  const slot = requestPath === "scheduled" ? nextSlot() : null;
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
// MIG and PRIV: migrations, catalog and privileges
// ---------------------------------------------------------------------------

const S8_DEFINER_API = Object.freeze([
  "attorney_accept_request(uuid)",
  "attorney_decline_request(uuid)",
  "attorney_request(uuid)",
  "attorney_requests()",
  "client_authorize_payment(uuid)",
  "client_request_decision(uuid)",
  "client_request_payment(uuid)",
]);

const S8_INTERNAL = Object.freeze([
  "consultation_integrity()",
  "decision_audit(uuid, text, text, text, uuid, jsonb, jsonb, text, jsonb, uuid)",
  "decision_create_consultation(uuid, uuid, jsonb, uuid, text, text)",
  "decision_deadline(uuid)",
  "decision_ended_reason(uuid)",
  "decision_engagement_parameters(uuid)",
  "decision_evaluate_bookability(consultation_requests, slot_holds, uuid, uuid)",
  "decision_evidence_subject_attorney(uuid, uuid, uuid, uuid)",
  "decision_open_matters(uuid, uuid)",
  "decision_open_review(text, text, uuid, text, uuid, jsonb)",
  "decision_payment_captured()",
  "decision_record_engagement_if_due(consultations, jsonb, consultation_requests, timestamp with time zone, uuid)",
  "decision_request_offered(uuid)",
  "decision_review_attorney(uuid, text)",
  "decision_review_attorney_fact()",
  "decision_review_attorney_profile()",
  "decision_review_attorney_user()",
  "decision_review_authority_reference()",
  "decision_review_eligibility_policy()",
  "decision_review_evidence()",
  "decision_review_evidence_subject()",
  "decision_review_jurisdiction(uuid, text, text)",
  "decision_review_jurisdiction_attorneys(uuid, text)",
  "decision_review_jurisdiction_state()",
  "decision_slot_problem(slot_holds, uuid)",
  "engagement_integrity()",
  "engagement_parameters_valid(jsonb)",
  "enforce_payment_consultation_consistency()",
  "payment_confirm_authorization(payment_transactions, text, bigint, text, text, uuid, text)",
  "payment_consultation_link_once()",
  "policy_parameters_approvable(text, uuid, jsonb)",
  "request_acceptance_evidence()",
]);

const executors = (signature) =>
  sql(
    `select coalesce(string_agg(r.rolname, ',' order by r.rolname), '') from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') and has_function_privilege(r.rolname, 'public.${signature}', 'execute');`,
  );

async function migrationChecks() {
  await check(
    "MIG-1 the three S8 migrations follow S7 in order, are registered unreviewed (sequences 44 to 46) and applied nowhere, are Program migration refs, and apply on plain PostgreSQL without notices, to a development and a production-class database",
    () => {
      assert.deepEqual(report.migrations.s8, [...S8_MIGRATIONS]);
      for (const file of S8_MIGRATIONS) {
        assert.deepEqual(report.migrations.notices[file], [], file);
      }
      return report.migrations.notices;
    },
  );

  await check(
    "MIG-2 no relation, column, type, row policy, view, sequence, policy type, capability or seed row is added (Packet rules 8, 10 and 16): the S8 texts create none and insert into no catalog table; the consultations and engagements columns are the P1 ones; the policy type catalog is unchanged",
    () => {
      for (const file of S8_MIGRATIONS) {
        const text = fs
          .readFileSync(path.join(MIGRATIONS, file), "utf8")
          .replace(/--[^\n]*/g, "");
        assert.doesNotMatch(
          text,
          /create\s+table|add\s+column|create\s+type|create\s+policy|create\s+view|create\s+sequence|insert\s+into\s+public\.(policy_types|policy_versions|capability_definitions|capability_grants|deployment_environment|jurisdictions|practice_areas|regulatory_modes)/i,
          file,
        );
      }
      assert.equal(
        sql(
          "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'consultations';",
        ),
        "id,consultation_request_id,client_id,attorney_id,request_path,referral_policy_version_id,fee_policy_version_id,engagement_policy_version_id,cancellation_policy_version_id,modality,state,started_at,ended_at,outcome_code,created_at,updated_at",
      );
      assert.equal(
        sql(
          "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'engagements';",
        ),
        "id,consultation_id,engagement_policy_version_id,version_number,supersedes_engagement_id,effective_at,ended_at,state,terms_reference,created_at,updated_at",
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
    },
  );

  await check(
    "PRIV-1 consultations and engagements are function-only: no API role holds INSERT, UPDATE, DELETE or TRUNCATE (SELECT unchanged: authenticated under the P1 participant row policies, service_role; anon none), and direct writes are refused for authenticated and service_role",
    () => {
      for (const table of ["consultations", "engagements"]) {
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
          as(role, sub, "update public.consultations set state = 'live';"),
          "ERROR 42501",
        );
        assert.equal(
          as(
            role,
            sub,
            "insert into public.engagements (consultation_id, engagement_policy_version_id, version_number, state) values (gen_random_uuid(), gen_random_uuid(), 1, 'presented');",
          ),
          "ERROR 42501",
        );
      }
    },
  );

  await check(
    "PRIV-2 function privileges: the attorney and client functions are security definer, pin their search_path and are executable by authenticated only; every internal and trigger function by no API role; anon and service_role execute nothing S8 adds",
    () => {
      for (const signature of S8_DEFINER_API) {
        assert.equal(executors(signature), "authenticated", signature);
        assert.equal(
          sql(
            `select prosecdef::text || '|' || exists (select 1 from unnest(proconfig) c where c = 'search_path=pg_catalog, pg_temp')::text from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          "true|true",
          signature,
        );
      }
      for (const signature of S8_INTERNAL) {
        assert.equal(executors(signature), "", signature);
      }
      // The deferred checks and the triggers that run at commit, or inside a
      // provider-recording transaction, run as their owner with a fixed
      // search_path; the P1 Consultation/payment check joins them (as S6
      // made the Request checks).
      assert.equal(
        sql(
          "select string_agg(proname || ':' || prosecdef::text || ':' || exists (select 1 from unnest(proconfig) c where c like 'search_path=%')::text, ',' order by proname) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('request_acceptance_evidence', 'enforce_payment_consultation_consistency', 'decision_payment_captured', 'decision_review_attorney_fact', 'decision_review_attorney_profile', 'decision_review_attorney_user', 'decision_review_authority_reference', 'decision_review_eligibility_policy', 'decision_review_evidence', 'decision_review_evidence_subject', 'decision_review_jurisdiction_state');",
        ),
        "decision_payment_captured:true:true,decision_review_attorney_fact:true:true,decision_review_attorney_profile:true:true,decision_review_attorney_user:true:true,decision_review_authority_reference:true:true,decision_review_eligibility_policy:true:true,decision_review_evidence:true:true,decision_review_evidence_subject:true:true,decision_review_jurisdiction_state:true:true,enforce_payment_consultation_consistency:true:true,request_acceptance_evidence:true:true",
      );
      for (const role of ["anon", "service_role"]) {
        assert.equal(
          as(
            role,
            null,
            "select * from public.attorney_accept_request(gen_random_uuid());",
          ),
          "ERROR 42501",
        );
        assert.equal(
          as(role, null, "select * from public.attorney_requests();"),
          "ERROR 42501",
        );
      }
      assert.equal(
        sql(
          "select string_agg(p.proname || ':' || array_to_string(p.proconfig, ';'), ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('attorney_accept_request', 'attorney_decline_request');",
        ),
        "attorney_accept_request:search_path=pg_catalog, pg_temp;lock_timeout=3s,attorney_decline_request:search_path=pg_catalog, pg_temp;lock_timeout=3s",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// CFG: the engagement schema, approval validation and fail-closed seams
// ---------------------------------------------------------------------------

async function configurationChecks() {
  await check(
    "CFG-1 (G-5, G-1; PM section 2) the engagement schema: exactly consultation_creation (attorney_acceptance | attorney_acceptance_and_payment_authorized | attorney_acceptance_and_payment_captured | attorney_acceptance_and_engagement_effective) and engagement_effective (at_request | at_attorney_acceptance | at_payment_capture | at_consultation_start); anything else is invalid and the reader answers no parameters (no default); a version of another type is never read as an engagement version",
    () => {
      const valid = (value) =>
        sql(
          `select public.engagement_parameters_valid(${lit(JSON.stringify(value))}::jsonb);`,
        );
      for (const creation of [
        "attorney_acceptance",
        "attorney_acceptance_and_payment_authorized",
        "attorney_acceptance_and_payment_captured",
        "attorney_acceptance_and_engagement_effective",
      ]) {
        for (const effective of [
          "at_request",
          "at_attorney_acceptance",
          "at_payment_capture",
          "at_consultation_start",
        ]) {
          assert.equal(valid(ENGAGEMENT(creation, effective)), "t");
        }
      }
      for (const value of [
        {},
        [],
        "attorney_acceptance",
        { consultation_creation: "attorney_acceptance" },
        { engagement_effective: "at_request" },
        { ...ENGAGEMENT("attorney_acceptance", "at_request"), extra: true },
        ENGAGEMENT("acceptance", "at_request"),
        ENGAGEMENT("attorney_acceptance", "at_capture"),
        ENGAGEMENT("attorney_acceptance", null),
        { consultation_creation: 1, engagement_effective: "at_request" },
      ]) {
        assert.equal(valid(value), "f", JSON.stringify(value));
      }
      assert.equal(
        sql(
          `select public.decision_engagement_parameters('${world.policies.D.engagement}') is null;`,
        ),
        "t",
      );
      assert.equal(
        sql(
          `select public.decision_engagement_parameters('${world.policies.A.payment_flow}') is null;`,
        ),
        "t",
      );
      assert.deepEqual(
        jsonOf(
          `select public.decision_engagement_parameters('${world.policies.A.engagement}')::text;`,
        ),
        JURISDICTIONS.A.engagement,
      );
    },
  );

  await check(
    "CFG-2 approval validation (PS section 8.4): staff approval of an engagement version outside the schema answers parameters_invalid and leaves it in counsel_review; a valid one is approved; the earlier schemas (payment_flow) still apply",
    () => {
      const approval = (type, parameters) => {
        const id = uid();
        sql(
          `insert into public.policy_versions (id, policy_type_code, jurisdiction_id, regulatory_mode_id, version_label, parameters, status, effective_from, development_only)
           values ('${id}', ${lit(type)}, '${world.J.A}', '${world.mode}', ${lit(`synthetic-approval-${id.slice(0, 8)}`)}, ${lit(parameters)}::jsonb, 'draft', now() + interval '30 days', false);
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
      assert.deepEqual(
        approval("engagement", {
          consultation_creation: "attorney_acceptance",
        }),
        { outcome: "parameters_invalid", status: "counsel_review" },
      );
      assert.deepEqual(approval("engagement", {}), {
        outcome: "parameters_invalid",
        status: "counsel_review",
      });
      assert.deepEqual(
        approval(
          "engagement",
          ENGAGEMENT("attorney_acceptance", "at_consultation_start"),
        ),
        { outcome: "applied", status: "approved" },
      );
      assert.deepEqual(approval("payment_flow", { instant: {} }), {
        outcome: "parameters_invalid",
        status: "counsel_review",
      });
    },
  );

  await check(
    'CFG-3 (MBS sections 2.10 and 13; TA section 60 "required policy is missing") unset configuration fails closed with a fixed outcome and changes nothing (no evaluation, audit event, Consultation, Booking, payment or job; the Request still awaits and keeps its Hold): no engagement version (configuration_unavailable engagement_no_applicable_policy), a malformed one (engagement_policy_incomplete), and no payment_flow version for a Request without a payment attempt (payment_flow_no_applicable_policy)',
    () => {
      const missing = makeRequest({ jurisdiction: world.J.C });
      const malformed = authorizedRequest({ jurisdiction: world.J.D });
      const flowless = makeRequest({ jurisdiction: world.J.N });
      assert.equal(requestStateOf(flowless.request), "awaiting_attorney");
      sql(
        `update public.policy_versions set effective_until = now() where id = '${world.policies.N.payment_flow}';`,
      );
      const answers = {};
      for (const [label, scenario, problem] of [
        ["missing", missing, "engagement_no_applicable_policy"],
        ["malformed", malformed, "engagement_policy_incomplete"],
        ["flowless", flowless, "payment_flow_no_applicable_policy"],
      ]) {
        const before = writeCounts();
        const hold = holdOf(scenario.request);
        const answer = accept(world.ann, scenario.request);
        answers[label] = answer;
        assert.deepEqual(answer, {
          outcome: "configuration_unavailable",
          consultation: null,
          problem,
        });
        assert.deepEqual(writeCounts(), before, label);
        assert.equal(requestStateOf(scenario.request), "awaiting_attorney");
        assert.deepEqual(holdOf(scenario.request), hold);
      }
      return answers;
    },
  );
}

// ---------------------------------------------------------------------------
// ACC: acceptance, the Consultation, the Booking, payment and Engagement per
// configuration
// ---------------------------------------------------------------------------

// The decision-point evidence written by the acceptance's own transaction
// (the deferred check compares xmin; here the audit event names them).
function acceptanceEvidence(request) {
  const audit = auditsOf(request, "consultation_request.accepted");
  assert.equal(audit.length, 1, "one acceptance audit event");
  const after = audit[0].after;
  const eligibility = rowOf(
    "eligibility_evaluations",
    `id = '${after.eligibility_evaluation_id}'`,
  );
  const bookability = rowOf(
    "bookability_evaluations",
    `id = '${after.bookability_evaluation_id}'`,
  );
  return { audit: audit[0], eligibility, bookability };
}

async function acceptanceChecks() {
  await check(
    "ACC-1 (MBS section 13 deliverables; MBS13-6; PM rows 6-7; INV-4; IMP section 11 acceptance + Booking conversion; DM sections 2.7 and 9) a scheduled Request authorized before the decision is accepted: awaiting_attorney -> accepted with the governing engagement version recorded; exactly one Consultation (created -> scheduled, the Request's provenance: fee policy of its Fee Calculation, the payment's engagement and cancellation versions); its Hold converted into exactly one confirmed Booking with the Hold's times; the fresh decision-point Eligibility and Bookability Evaluations (the held slot) persisted; capture at acceptance requested in the same transaction (capture_pending, one capture job; the provider call follows commit); the payment associated with the Consultation; the Engagement effective at the acceptance instant (configured at_attorney_acceptance); then the confirmed capture posts the ledger and changes no Consultation or Engagement",
    () => {
      const s = authorizedRequest({
        jurisdiction: world.J.A,
        requestPath: "scheduled",
      });
      assert.equal(requestStateOf(s.request), "awaiting_attorney");
      // PM rows 1 and 6; DM section 2.4: no Consultation exists merely
      // because a Request exists, and no Booking before acceptance (INV-4).
      assert.equal(consultationOf(s.request), null);
      assert.equal(count("bookings", `client_id = '${s.client.client}'`), 0);
      const hold = holdOf(s.request);
      const answer = accept(world.ann, s.request);
      assert.equal(answer.outcome, "accepted", JSON.stringify(answer));
      const request = requestOf(s.request);
      const consultation = consultationOf(s.request);
      assert.equal(answer.consultation, consultation.id);
      assert.equal(request.state, "accepted");
      assert.ok(request.accepted_at);
      assert.equal(
        request.engagement_policy_version_id,
        world.policies.A.engagement,
      );
      const payment = livePaymentOf(s.request);
      assert.deepEqual(
        {
          state: consultation.state,
          path: consultation.request_path,
          attorney: consultation.attorney_id,
          client: consultation.client_id,
          fee: consultation.fee_policy_version_id,
          engagement: consultation.engagement_policy_version_id,
          cancellation: consultation.cancellation_policy_version_id,
          modality: consultation.modality,
          started: consultation.started_at,
        },
        {
          state: "scheduled",
          path: "scheduled",
          attorney: world.ann.profile,
          client: s.client.client,
          fee: world.policies.A.fee,
          engagement: world.policies.A.engagement,
          cancellation: world.policies.A.cancellation,
          modality: "synthetic_video",
          started: null,
        },
      );
      const bookings = bookingsOf(consultation.id);
      assert.equal(bookings.length, 1);
      assert.equal(bookings[0].status, "confirmed");
      assert.equal(ms(bookings[0].starts_at), ms(hold.slot_start_at));
      assert.equal(ms(bookings[0].ends_at), ms(hold.slot_end_at));
      assert.equal(holdOf(s.request).release_reason, "converted");
      const evidence = acceptanceEvidence(s.request);
      assert.equal(evidence.eligibility.result, "eligible");
      assert.equal(evidence.eligibility.jurisdiction_id, world.J.A);
      assert.equal(evidence.bookability.result, "bookable");
      assert.equal(evidence.bookability.context_type, "consultation_request");
      assert.equal(evidence.bookability.context_id, s.request);
      assert.equal(
        ms(evidence.bookability.slot_start_at),
        ms(hold.slot_start_at),
      );
      assert.deepEqual(
        evidence.bookability.constraint_results.map((f) => f.reason),
        ["eligible", "slot_available"],
      );
      assert.ok(
        ms(evidence.eligibility.evaluated_at) > ms(hold.held_at),
        "a new decision-point record, after the Request's own",
      );
      assert.equal(payment.state, "capture_pending");
      assert.equal(payment.consultation_id, consultation.id);
      assert.ok(openJob("payment.capture", "payment_transaction", s.payment));
      const engagements = engagementsOf(consultation.id);
      assert.equal(engagements.length, 1);
      assert.deepEqual(
        [
          engagements[0].state,
          engagements[0].version_number,
          engagements[0].engagement_policy_version_id,
          ms(engagements[0].effective_at),
        ],
        ["effective", 1, world.policies.A.engagement, ms(request.accepted_at)],
      );
      assert.equal(evidence.audit.actor_user_id, world.ann.user);
      assert.equal(evidence.audit.actor_type, "attorney");
      assert.equal(evidence.audit.reason_code, "attorney_accepted");
      assert.deepEqual(
        evidence.audit.policy_references
          .filter((r) =>
            ["engagement", "payment_flow"].includes(r.policy_type_code),
          )
          .map((r) => r.policy_version_id),
        [world.policies.A.engagement, world.policies.A.payment_flow],
      );
      assert.equal(auditsOf(consultation.id, "consultation.created").length, 1);
      assert.equal(
        auditsOf(engagements[0].id, "engagement.effective").length,
        1,
      );
      assert.equal(auditsOf(s.payment, "payment.capture_requested").length, 1);
      const run = confirmCapture(s);
      assert.equal(run.outcome, "applied");
      assert.equal(livePaymentOf(s.request).state, "captured");
      assert.equal(ledgerOf(s.payment).length, 5);
      assert.equal(engagementsOf(consultation.id).length, 1);
      assert.equal(consultationOf(s.request).state, "scheduled");
      world.acceptedScheduled = { ...s, consultation: consultation.id };
      return {
        consultation: consultation.state,
        booking: bookings[0].status,
        hold: "converted",
        payment: payment.state,
        engagement: engagements[0].state,
      };
    },
  );

  await check(
    "ACC-2 (PM row 2; DM section 2.4: an instant Consultation never passes through scheduled) an instant Request authorized before the decision is accepted: one Consultation created -> ready, no Hold and no Booking; capture requested; the Bookability Evaluation is the instant one (eligibility, Instant intent, Presence, not in a Consultation)",
    () => {
      const s = authorizedRequest({
        jurisdiction: world.J.A,
        requestPath: "instant",
      });
      const answer = accept(world.ann, s.request);
      assert.equal(answer.outcome, "accepted", JSON.stringify(answer));
      const consultation = consultationOf(s.request);
      assert.equal(consultation.state, "ready");
      assert.equal(consultation.request_path, "instant");
      assert.deepEqual(bookingsOf(consultation.id), []);
      assert.equal(holdOf(s.request), null);
      assert.equal(livePaymentOf(s.request).state, "capture_pending");
      const evidence = acceptanceEvidence(s.request);
      assert.equal(evidence.bookability.slot_start_at, null);
      assert.deepEqual(
        evidence.bookability.constraint_results.map((f) => f.factor),
        ["eligibility", "instant_intent", "presence", "consultation"],
      );
      world.acceptedInstant = { ...s, consultation: consultation.id };
    },
  );

  await check(
    "ACC-3 (PM rows 6-7; G-3 configured at_attorney_acceptance; MBS13-9) a scheduled Request whose flow authorizes at the attorney's acceptance: before acceptance no payment can be started (not_payable, as S7 answers an awaiting Request); the acceptance creates the Consultation and converts the Hold with no payment attempt and no Engagement (configured at_consultation_start); then the client's authorization step opens (authorization_after_acceptance, payable), the attempt records the Consultation's engagement version and is associated with it, and a confirmed authorization of the accepted Request requests the capture at once (capture configured at acceptance, whose moment has passed)",
    () => {
      const s = makeRequest({ jurisdiction: world.J.B });
      assert.equal(requestStateOf(s.request), "awaiting_attorney");
      assert.equal(authorize(s.client, s.request).outcome, "not_payable");
      const answer = accept(world.ann, s.request);
      assert.equal(answer.outcome, "accepted", JSON.stringify(answer));
      const consultation = consultationOf(s.request);
      assert.equal(consultation.state, "scheduled");
      assert.equal(consultation.cancellation_policy_version_id, null);
      assert.equal(bookingsOf(consultation.id).length, 1);
      assert.equal(livePaymentOf(s.request), null);
      assert.deepEqual(engagementsOf(consultation.id), []);
      const step = () =>
        asClient(
          s.client,
          `select payment_step || '|' || payable::text || '|' || coalesce(payment_state, '') from public.client_request_payment('${s.request}');`,
        );
      assert.equal(step(), "authorization_after_acceptance|true|");
      const created = authorize(s.client, s.request);
      assert.equal(created.outcome, "created", created.line);
      const payment = paymentOf(created.payment);
      assert.equal(payment.consultation_id, consultation.id);
      assert.equal(
        payment.engagement_policy_version_id,
        world.policies.B.engagement,
      );
      assert.equal(
        step(),
        "authorization_after_acceptance|true|pending_authorization",
      );
      runJob("payment.checkout", "payment_transaction", created.payment, () =>
        obs("checkout_open", { checkout_reference: checkoutRef() }),
      );
      const reference = paymentRef();
      const event = providerEvent(
        "payment_intent.amount_capturable_updated",
        obs("authorization_confirmed", {
          payment_transaction_id: created.payment,
          payment_reference: reference,
          amount_minor: 5225,
          currency_code: "XTS",
        }),
      );
      assert.equal(event.processing, "applied", event.line);
      assert.equal(paymentOf(created.payment).state, "capture_pending");
      assert.equal(requestStateOf(s.request), "accepted");
      assert.equal(
        step(),
        "authorization_after_acceptance|false|capture_pending",
      );
      assert.equal(authorize(s.client, s.request).outcome, "not_payable");
      world.acceptedAtAcceptance = { ...s, consultation: consultation.id };
    },
  );

  await check(
    "ACC-4 (G-5 configured attorney_acceptance_and_payment_captured; PM row 2; MBS13-9) on the instant path the acceptance requests the capture and creates no Consultation yet; the confirmed capture then creates exactly one Consultation (created -> ready) and records the Engagement effective at the capture instant (configured at_payment_capture); a redelivered capture creates nothing more. On the scheduled path the same configuration can never hold at the decision (the Hold must become a Booking now): configuration_unavailable consultation_creation_unsatisfiable, and nothing changes",
    () => {
      const s = authorizedRequest({
        jurisdiction: world.J.E,
        requestPath: "instant",
      });
      const answer = accept(world.ann, s.request);
      assert.deepEqual(answer, {
        outcome: "accepted",
        consultation: null,
        problem: null,
      });
      assert.equal(requestStateOf(s.request), "accepted");
      assert.equal(consultationOf(s.request), null);
      assert.equal(livePaymentOf(s.request).state, "capture_pending");
      assert.equal(
        rowsAsClient(
          s.client,
          `select state || '|' || coalesce(consultation_id::text, '') from public.client_request_decision('${s.request}');`,
        )[0],
        "accepted|",
      );
      const run = confirmCapture(s);
      assert.equal(run.outcome, "applied");
      const consultation = consultationOf(s.request);
      assert.equal(consultation.state, "ready");
      const payment = livePaymentOf(s.request);
      assert.equal(payment.consultation_id, consultation.id);
      const engagements = engagementsOf(consultation.id);
      assert.equal(engagements.length, 1);
      assert.equal(ms(engagements[0].effective_at), ms(payment.captured_at));
      const created = auditsOf(consultation.id, "consultation.created");
      assert.deepEqual(
        [created.length, created[0].actor_type, created[0].reason_code],
        [1, "system", "payment_captured"],
      );
      const replay = providerEvent(
        "payment_intent.succeeded",
        obs("capture_confirmed", {
          payment_transaction_id: s.payment,
          payment_reference: s.reference,
          amount_minor: s.total,
          currency_code: "XTS",
        }),
      );
      assert.equal(replay.processing, "no_effect", replay.line);
      assert.equal(
        count("consultations", `consultation_request_id = '${s.request}'`),
        1,
      );
      assert.equal(
        count("engagements", `consultation_id = '${consultation.id}'`),
        1,
      );
      const scheduled = authorizedRequest({
        jurisdiction: world.J.E,
        requestPath: "scheduled",
      });
      const before = writeCounts();
      assert.deepEqual(accept(world.ann, scheduled.request), {
        outcome: "configuration_unavailable",
        consultation: null,
        problem: "consultation_creation_unsatisfiable",
      });
      assert.deepEqual(writeCounts(), before);
      assert.equal(requestStateOf(scheduled.request), "awaiting_attorney");
    },
  );

  await check(
    "ACC-5 (capture at_authorization; G-5 needs a captured payment; PM row 7) a scheduled Request whose capture is still pending answers payment_not_ready (capture_pending) and changes nothing; once the capture is confirmed the acceptance creates the Consultation and the Booking now, with the Engagement effective at the capture instant; the capture is not requested again",
    () => {
      const s = authorizedRequest({
        jurisdiction: world.J.F,
        requestPath: "scheduled",
      });
      assert.equal(livePaymentOf(s.request).state, "capture_pending");
      const before = writeCounts();
      assert.deepEqual(accept(world.ann, s.request), {
        outcome: "payment_not_ready",
        consultation: null,
        problem: "capture_pending",
      });
      assert.deepEqual(writeCounts(), before);
      assert.equal(confirmCapture(s).outcome, "applied");
      const answer = accept(world.ann, s.request);
      assert.equal(answer.outcome, "accepted", JSON.stringify(answer));
      const consultation = consultationOf(s.request);
      assert.equal(consultation.state, "scheduled");
      const payment = livePaymentOf(s.request);
      const engagements = engagementsOf(consultation.id);
      assert.equal(ms(engagements[0].effective_at), ms(payment.captured_at));
      assert.equal(auditsOf(s.payment, "payment.capture_requested").length, 1);
      world.capturedBeforeDecision = { ...s, consultation: consultation.id };
    },
  );

  await check(
    "ACC-6 (capture configured at consultation start; G-1 at_consultation_start; INV-8: acceptance does not make the payment financially active) the acceptance creates the Consultation and leaves the payment authorized, with no capture job and no Engagement",
    () => {
      const s = authorizedRequest({
        jurisdiction: world.J.G,
        requestPath: "scheduled",
      });
      assert.equal(accept(world.ann, s.request).outcome, "accepted");
      const consultation = consultationOf(s.request);
      assert.equal(consultation.state, "scheduled");
      assert.equal(livePaymentOf(s.request).state, "authorized");
      assert.equal(
        openJob("payment.capture", "payment_transaction", s.payment),
        null,
      );
      assert.deepEqual(engagementsOf(consultation.id), []);
    },
  );

  await check(
    "ACC-7 (G-5 configured with an Engagement effective only at consultation start) never satisfiable at the decision: configuration_unavailable consultation_creation_unsatisfiable, nothing changes",
    () => {
      const s = authorizedRequest({
        jurisdiction: world.J.H,
        requestPath: "scheduled",
      });
      const before = writeCounts();
      assert.deepEqual(accept(world.ann, s.request), {
        outcome: "configuration_unavailable",
        consultation: null,
        problem: "consultation_creation_unsatisfiable",
      });
      assert.deepEqual(writeCounts(), before);
    },
  );

  await check(
    "ACC-8 (G-5 configured attorney_acceptance_and_payment_authorized; G-1 at_request) the authorized payment satisfies the creation condition at the decision: the Consultation is created, the capture requested, and the Engagement recorded effective from the Request's creation instant",
    () => {
      const s = authorizedRequest({
        jurisdiction: world.J.K,
        requestPath: "scheduled",
      });
      assert.equal(accept(world.ann, s.request).outcome, "accepted");
      const consultation = consultationOf(s.request);
      const request = requestOf(s.request);
      const engagements = engagementsOf(consultation.id);
      assert.equal(engagements.length, 1);
      assert.equal(ms(engagements[0].effective_at), ms(request.created_at));
      assert.equal(livePaymentOf(s.request).state, "capture_pending");
    },
  );

  await check(
    'ACC-9 (TA section 60 "required payment state is invalid") an awaiting Request whose authorized attempt is being released answers payment_not_ready (release_pending) and changes nothing',
    () => {
      const s = authorizedRequest({
        jurisdiction: world.J.A,
        requestPath: "scheduled",
      });
      sql(
        `update public.payment_transactions set state = 'release_pending' where id = '${s.payment}';`,
      );
      const before = writeCounts();
      assert.deepEqual(accept(world.ann, s.request), {
        outcome: "payment_not_ready",
        consultation: null,
        problem: "release_pending",
      });
      assert.deepEqual(writeCounts(), before);
    },
  );
}

// ---------------------------------------------------------------------------
// REVAL: mandatory acceptance revalidation
// ---------------------------------------------------------------------------

async function revalidationChecks() {
  await check(
    "REVAL-1 (MBS13-3; PM row 38, settled; PM INV-12; TA section 60) an attorney no longer eligible at the decision point: the fresh Eligibility Evaluation is persisted (not_eligible) and the Request cannot proceed: it ends cancelled (system actor, reason attorney_not_eligible), its Hold is released after the state change and the authorization is released (release_pending, one release job); no Bookability Evaluation, Consultation or Booking; the client sees could_not_proceed; the earlier eligible evaluations stay as history",
    () => {
      const s = authorizedRequest({
        jurisdiction: world.J.A,
        requestPath: "scheduled",
        lawyer: world.cal,
      });
      const earlier = count(
        "eligibility_evaluations",
        `attorney_id = '${world.cal.profile}' and result = 'eligible'`,
      );
      sql(
        `update public.licenses set reported_status = 'synthetic-suspended' where attorney_id = '${world.cal.profile}' and jurisdiction_id = '${world.J.A}';`,
      );
      const bookability = count(
        "bookability_evaluations",
        `context_id = '${s.request}'`,
      );
      const answer = accept(world.cal, s.request);
      assert.equal(answer.outcome, "not_eligible", JSON.stringify(answer));
      assert.equal(answer.consultation, null);
      assert.equal(answer.problem, "not_eligible");
      const request = requestOf(s.request);
      assert.equal(request.state, "cancelled");
      assert.equal(holdOf(s.request).release_reason, "released");
      assert.equal(livePaymentOf(s.request).state, "release_pending");
      assert.ok(openJob("payment.release", "payment_transaction", s.payment));
      assert.equal(consultationOf(s.request), null);
      assert.equal(
        count("bookability_evaluations", `context_id = '${s.request}'`),
        bookability,
      );
      const ended = auditsOf(
        s.request,
        "consultation_request.ended_not_eligible",
      );
      assert.deepEqual(
        [ended.length, ended[0].actor_type, ended[0].reason_code],
        [1, "system", "attorney_not_eligible"],
      );
      const evaluation = rowOf(
        "eligibility_evaluations",
        `id = '${ended[0].after.eligibility_evaluation_id}'`,
      );
      assert.equal(evaluation.result, answer.problem);
      assert.equal(
        count(
          "eligibility_evaluations",
          `attorney_id = '${world.cal.profile}' and result = 'eligible'`,
        ),
        earlier,
      );
      assert.equal(
        rowsAsClient(
          s.client,
          `select state || '|' || coalesce(ended_reason, '') from public.client_request_decision('${s.request}');`,
        )[0],
        "cancelled|could_not_proceed",
      );
      world.ineligible = s;
    },
  );

  await check(
    'REVAL-2 (MBS13-4 "acceptance after bookability changes is revalidated"; MBS section 9) a held slot that stops being bookable (a Blackout over it) refuses the acceptance with the failed factor (not_bookable blackout): the fresh evaluations and one refusal audit event are kept, the Request still awaits with its Hold, nothing else changes; once the slot is bookable again the same Request is accepted on new evaluations',
    () => {
      const s = makeRequest({ jurisdiction: world.J.B });
      const hold = holdOf(s.request);
      const blackout = uid();
      sql(
        `insert into public.blackouts (id, attorney_id, starts_at, ends_at, reason_code) values ('${blackout}', '${world.ann.profile}', ${lit(hold.slot_start_at)}, ${lit(hold.slot_end_at)}, null);`,
      );
      const before = writeCounts();
      const answer = accept(world.ann, s.request);
      assert.deepEqual(answer, {
        outcome: "not_bookable",
        consultation: null,
        problem: "blackout",
      });
      const after = writeCounts();
      assert.equal(
        after.eligibility_evaluations,
        before.eligibility_evaluations + 1,
      );
      assert.equal(
        after.bookability_evaluations,
        before.bookability_evaluations + 1,
      );
      assert.equal(after.audit_events, before.audit_events + 1);
      assert.equal(after.consultations, before.consultations);
      assert.equal(after.bookings, before.bookings);
      assert.equal(requestStateOf(s.request), "awaiting_attorney");
      assert.deepEqual(holdOf(s.request), hold);
      const refused = auditsOf(
        s.request,
        "consultation_request.acceptance_refused",
      );
      assert.deepEqual(
        [refused.length, refused[0].reason_code, refused[0].after.problem],
        [1, "not_bookable", "blackout"],
      );
      const evaluation = rowOf(
        "bookability_evaluations",
        `id = '${refused[0].after.bookability_evaluation_id}'`,
      );
      assert.equal(evaluation.result, "not_bookable");
      sql(`delete from public.blackouts where id = '${blackout}';`);
      const second = accept(world.ann, s.request);
      assert.equal(second.outcome, "accepted", JSON.stringify(second));
      assert.notEqual(
        acceptanceEvidence(s.request).bookability.id,
        evaluation.id,
      );
    },
  );

  await check(
    "REVAL-3 (MBS13-4; DM section 8: Available Now needs Intent and Presence) an instant Request whose attorney lost Instant presence is refused (not_bookable intent_off) and stays awaiting; when Instant mode is on again it is accepted",
    () => {
      const s = authorizedRequest({
        jurisdiction: world.J.A,
        requestPath: "instant",
      });
      sql(
        `update public.instant_availability_intents set revoked_at = now() where attorney_id = '${world.ann.profile}' and revoked_at is null;`,
      );
      assert.deepEqual(accept(world.ann, s.request), {
        outcome: "not_bookable",
        consultation: null,
        problem: "intent_off",
      });
      assert.equal(requestStateOf(s.request), "awaiting_attorney");
      sql(
        `update public.instant_availability_intents set enabled_at = now(), revoked_at = null, expires_at = greatest(expires_at, now() + interval '2 hours') where attorney_id = '${world.ann.profile}';`,
      );
      assert.equal(accept(world.ann, s.request).outcome, "accepted");
    },
  );

  await check(
    'REVAL-4 (MBS section 13 "earlier evaluations ... cannot simply be reused"; IMP section 11 acceptance + Booking conversion; PS section 36) the deferred acceptance check holds for every role: an acceptance with no evaluation from its own transaction, or with only an eligible one, never commits; a scheduled acceptance whose Hold is released instead of converted into its Consultation\'s Booking never commits',
    () => {
      const instant = authorizedRequest({
        jurisdiction: world.J.A,
        requestPath: "instant",
      });
      const accepted = `update public.consultation_requests set state = 'accepted', accepted_at = now() where id = '${instant.request}';`;
      assert.equal(refused(accepted), "23514");
      assert.equal(
        refused(
          `insert into public.eligibility_evaluations (attorney_id, jurisdiction_id, context_type, context_id, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${world.ann.profile}', '${world.J.A}', 'jurisdiction', null, now(), '[]'::jsonb, 'eligible', '[]'::jsonb, '{}'::jsonb, now());
           ${accepted}`,
        ),
        "23514",
      );
      const scheduled = makeRequest({ jurisdiction: world.J.B });
      const hold = holdOf(scheduled.request);
      const evaluation = uid();
      assert.equal(
        refused(
          `insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, context_id, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${evaluation}', '${world.ann.profile}', '${world.J.B}', 'jurisdiction', null, now(), '[]'::jsonb, 'eligible', '[]'::jsonb, '{}'::jsonb, now());
           insert into public.bookability_evaluations (attorney_id, eligibility_evaluation_id, context_type, context_id, evaluated_at, as_of, modality, slot_start_at, slot_end_at, constraint_results, result) values ('${world.ann.profile}', '${evaluation}', 'consultation_request', '${scheduled.request}', now(), now(), 'synthetic_video', ${lit(hold.slot_start_at)}, ${lit(hold.slot_end_at)}, '[]'::jsonb, 'bookable');
           update public.consultation_requests set state = 'accepted', accepted_at = now() where id = '${scheduled.request}';
           select public.scheduling_release_hold('${hold.id}');`,
        ),
        "23514",
      );
      assert.equal(requestStateOf(instant.request), "awaiting_attorney");
      assert.equal(requestStateOf(scheduled.request), "awaiting_attorney");
    },
  );
}

// ---------------------------------------------------------------------------
// DEC: decline
// ---------------------------------------------------------------------------

async function declineChecks() {
  await check(
    "DEC-1 (PM row 8, settled; TA sections 7 and 14 B3; INV-6; MBS13-6) the attorney declines an authorized scheduled Request: awaiting_attorney -> declined (distinct from expiry), its Hold released after the state change, the authorization released by the S7 trigger (release_pending, one release job), no Consultation, Booking or Engagement, one attorney audit event; the Intake is untouched and the client selects again: a new Referral and a new Request from the same Intake",
    () => {
      const s = authorizedRequest({
        jurisdiction: world.J.A,
        requestPath: "scheduled",
      });
      const intake = rowOf("intakes", `id = '${s.client.intake}'`);
      assert.equal(decline(world.ann, s.request), "declined");
      const request = requestOf(s.request);
      assert.equal(request.state, "declined");
      assert.ok(request.declined_at);
      assert.equal(request.expired_at, null);
      assert.equal(holdOf(s.request).release_reason, "released");
      assert.equal(livePaymentOf(s.request).state, "release_pending");
      assert.ok(openJob("payment.release", "payment_transaction", s.payment));
      assert.equal(consultationOf(s.request), null);
      const audit = auditsOf(s.request, "consultation_request.declined");
      assert.deepEqual(
        [
          audit.length,
          audit[0].actor_type,
          audit[0].actor_user_id,
          audit[0].reason_code,
        ],
        [1, "attorney", world.ann.user, "attorney_declined"],
      );
      assert.equal(audit[0].after.payment_state, "release_pending");
      assert.deepEqual(rowOf("intakes", `id = '${s.client.intake}'`), intake);
      assert.equal(
        rowsAsClient(
          s.client,
          `select state || '|' || coalesce(ended_reason, '') || '|' || intake_id::text from public.client_request_decision('${s.request}');`,
        )[0],
        `declined|declined|${s.client.intake}`,
      );
      const retry = makeRequest({
        jurisdiction: world.J.A,
        client: s.client,
        lawyer: world.bob,
      });
      assert.notEqual(retry.request, s.request);
      assert.equal(requestStateOf(retry.request), "slot_held");
    },
  );

  await check(
    "DEC-2 (PM row 3; INV-11: never silently absorbed) declining an instant Request whose funds were already captured (capture configured at authorization) opens S7's critical funds_retained_after_request_end exception and leaves the payment captured for human resolution",
    () => {
      const s = authorizedRequest({
        jurisdiction: world.J.F,
        requestPath: "instant",
      });
      assert.equal(confirmCapture(s).outcome, "applied");
      assert.equal(decline(world.ann, s.request), "declined");
      assert.equal(livePaymentOf(s.request).state, "captured");
      assert.deepEqual(
        exceptionsOf(s.payment).map((e) => [e.exception_type, e.severity]),
        [["funds_retained_after_request_end", "critical"]],
      );
    },
  );

  await check(
    "DEC-3 deterministic decline outcomes: a second decline and an acceptance after it answer already_decided; a withdrawn Request answers withdrawn; nothing changes",
    () => {
      const s = makeRequest({ jurisdiction: world.J.B });
      assert.equal(decline(world.ann, s.request), "declined");
      const before = writeCounts();
      assert.equal(decline(world.ann, s.request), "already_decided");
      assert.deepEqual(accept(world.ann, s.request), {
        outcome: "already_decided",
        consultation: null,
        problem: "declined",
      });
      assert.deepEqual(writeCounts(), before);
      const w = makeRequest({ jurisdiction: world.J.B });
      assert.equal(asClient(w.client, WITHDRAW_SQL(w.request)), "withdrawn");
      const mid = writeCounts();
      assert.equal(decline(world.ann, w.request), "withdrawn");
      assert.equal(accept(world.ann, w.request).outcome, "withdrawn");
      assert.deepEqual(writeCounts(), mid);
    },
  );
}

// ---------------------------------------------------------------------------
// EXP: expiry against the decision
// ---------------------------------------------------------------------------

async function expiryChecks() {
  await check(
    "EXP-1 (PM row 9, settled; DM section 2.6; INV-5) an awaiting scheduled Request past its server response deadline is expired by the decision's own evaluation: the acceptance answers expired, the Request is expired (response_deadline_reached) with its Hold released, and a later decline answers expired; nothing is accepted",
    async () => {
      const s = makeRequest({ jurisdiction: world.J.X });
      await untilPast(requestOf(s.request).response_deadline_at);
      assert.deepEqual(accept(world.ann, s.request), {
        outcome: "expired",
        consultation: null,
        problem: null,
      });
      assert.equal(requestStateOf(s.request), "expired");
      assert.equal(
        auditsOf(s.request, "consultation_request.expired")[0].reason_code,
        "response_deadline_reached",
      );
      assert.ok(holdOf(s.request).released_at);
      assert.equal(decline(world.ann, s.request), "expired");
      assert.equal(consultationOf(s.request), null);
    },
  );

  await check(
    "EXP-2 (PM row 4, settled) an awaiting instant Request with an authorization, past its deadline, is expired by the sweep and the authorization released (release_pending, one release job); the acceptance then answers expired",
    async () => {
      const s = authorizedRequest({
        jurisdiction: world.J.Z,
        requestPath: "instant",
      });
      assert.equal(requestStateOf(s.request), "awaiting_attorney");
      await untilPast(requestOf(s.request).response_deadline_at);
      const swept = jsonOf("select public.request_expiry_sweep()::text;");
      assert.ok(swept.expired >= 1, JSON.stringify(swept));
      assert.equal(requestStateOf(s.request), "expired");
      assert.equal(livePaymentOf(s.request).state, "release_pending");
      assert.ok(openJob("payment.release", "payment_transaction", s.payment));
      assert.equal(accept(world.ann, s.request).outcome, "expired");
    },
  );
}

// Started first, checked before the concurrency probes (whose Hold sweeps would end it): the Fee Policy schema's shortest quote
// validity is 60 seconds.
async function quoteExpiryCheck() {
  await check(
    "EXP-3 (PM rows 5 and 10, settled; DM section 2.5; INV-6) an awaiting scheduled Request whose quote validity passed is expired by the acceptance's own evaluation (quote_expired) with its Hold released; the expired quote is never revived (the S6 guard refuses for every role)",
    async () => {
      const s = world.quoteScenario;
      const fee = rowOf(
        "fee_calculations",
        `consultation_request_id = '${s.request}'`,
      );
      await untilPast(fee.quote_valid_until);
      assert.equal(accept(world.ann, s.request).outcome, "expired");
      assert.equal(requestStateOf(s.request), "expired");
      assert.equal(
        auditsOf(s.request, "consultation_request.expired")[0].reason_code,
        "quote_expired",
      );
      assert.ok(holdOf(s.request).released_at);
      assert.equal(
        refused(
          `update public.consultation_requests set state = 'awaiting_attorney', expired_at = null where id = '${s.request}';`,
        ),
        "55000",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// INT: Consultation, Engagement, Booking and association guards
// ---------------------------------------------------------------------------

async function integrityChecks() {
  await check(
    "INT-1 (PS section 32; DM section 2.4; IMP section 11 no duplicate Consultation) the Consultation guard holds for every role: never deleted or truncated; created only in state created with the Request's provenance; a second Consultation for a Request is refused (unique); identity and provenance never change; forward-only transitions (an instant Consultation never scheduled, no step back), a terminal Consultation never changes; start recorded once",
    () => {
      const scheduled = world.acceptedScheduled;
      const instant = world.acceptedInstant;
      const c = scheduled.consultation;
      const request = requestOf(scheduled.request);
      const insert = (state, fee = world.policies.A.fee) =>
        `insert into public.consultations (consultation_request_id, client_id, attorney_id, request_path, referral_policy_version_id, fee_policy_version_id, modality, state) values ('${scheduled.request}', '${request.client_id}', '${request.selected_attorney_id}', 'scheduled', '${request.referral_policy_version_id}', '${fee}', 'synthetic_video', '${state}');`;
      assert.equal(refused(insert("scheduled")), "23514");
      assert.equal(refused(insert("created", world.policies.B.fee)), "23514");
      assert.equal(refused(insert("created")), "23505");
      for (const statement of [
        `delete from public.consultations where id = '${c}';`,
        "truncate public.consultations cascade;",
        `update public.consultations set modality = 'synthetic_audio' where id = '${c}';`,
        `update public.consultations set engagement_policy_version_id = null where id = '${c}';`,
        `update public.consultations set attorney_id = '${world.bob.profile}' where id = '${c}';`,
        `update public.consultations set state = 'created' where id = '${c}';`,
        `update public.consultations set state = 'live' where id = '${c}';`,
        `update public.consultations set state = 'scheduled' where id = '${instant.consultation}';`,
      ]) {
        assert.equal(refused(statement), "55000", statement);
      }
      acceptedThenRolledBack(
        `update public.consultations set state = 'ready' where id = '${c}';
         update public.consultations set state = 'live', started_at = now() where id = '${c}';
         update public.consultations set state = 'completed', ended_at = now(), outcome_code = 'synthetic' where id = '${c}';`,
      );
      assert.equal(
        refused(
          `update public.consultations set state = 'cancelled' where id = '${c}';
           update public.consultations set state = 'ready' where id = '${c}';`,
        ),
        "55000",
      );
      assert.equal(
        refused(
          `update public.consultations set started_at = now() where id = '${c}';
           update public.consultations set started_at = now() + interval '1 minute' where id = '${c}';`,
        ),
        "55000",
      );
      assert.equal(
        refused(
          `update public.consultations set state = 'bogus' where id = '${c}';`,
        ),
        "55000",
      );
    },
  );

  await check(
    "INT-2 (DM section 9; PS section 17.2) the Engagement guard holds for every role: never deleted or truncated; recorded presented or effective only, for its Consultation's engagement version; forward one step at a time (effective -> concluded), never back; effective time recorded once; a second current effective Engagement is refused (P1 unique)",
    () => {
      const c = world.acceptedScheduled.consultation;
      const engagement = engagementsOf(c)[0];
      for (const [statement, state] of [
        [
          `delete from public.engagements where id = '${engagement.id}';`,
          "55000",
        ],
        ["truncate public.engagements;", "55000"],
        [
          `update public.engagements set state = 'presented', effective_at = null where id = '${engagement.id}';`,
          "55000",
        ],
        [
          `update public.engagements set effective_at = effective_at - interval '1 minute' where id = '${engagement.id}';`,
          "55000",
        ],
        [
          `update public.engagements set engagement_policy_version_id = '${world.policies.B.engagement}' where id = '${engagement.id}';`,
          "55000",
        ],
        [
          `insert into public.engagements (consultation_id, engagement_policy_version_id, version_number, state) values ('${c}', '${world.policies.A.engagement}', 2, 'accepted');`,
          "23514",
        ],
        [
          `insert into public.engagements (consultation_id, engagement_policy_version_id, version_number, state) values ('${c}', '${world.policies.B.engagement}', 2, 'presented');`,
          "23514",
        ],
        [
          `insert into public.engagements (consultation_id, engagement_policy_version_id, version_number, state, effective_at) values ('${c}', '${world.policies.A.engagement}', 2, 'effective', now());`,
          "23505",
        ],
      ]) {
        assert.equal(refused(statement), state, statement);
      }
      acceptedThenRolledBack(
        `update public.engagements set state = 'concluded', ended_at = now() where id = '${engagement.id}';`,
      );
      acceptedThenRolledBack(
        `insert into public.engagements (consultation_id, engagement_policy_version_id, version_number, state) values ('${c}', '${world.policies.A.engagement}', 2, 'presented');`,
      );
    },
  );

  await check(
    "INT-3 (MBS section 9 invariants 1 and 5; FP-1 section 8) at most one current Booking per Consultation (a second confirmed Booking is refused) and the payment's Consultation association is set once",
    () => {
      const s = world.acceptedScheduled;
      const booking = bookingsOf(s.consultation)[0];
      const request = requestOf(s.request);
      assert.ok(
        ["23505", "23P01"].includes(
          refused(
            `insert into public.bookings (consultation_id, attorney_id, client_id, starts_at, ends_at, status) values ('${s.consultation}', '${request.selected_attorney_id}', '${request.client_id}', ${lit(booking.starts_at)}::timestamptz + interval '3 days', ${lit(booking.ends_at)}::timestamptz + interval '3 days', 'confirmed');`,
          ),
        ),
      );
      assert.equal(
        refused(
          `update public.payment_transactions set consultation_id = '${world.acceptedInstant.consultation}' where id = '${s.payment}';`,
        ),
        "55000",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// AUTHZ and VIS: authorization and visibility
// ---------------------------------------------------------------------------

const ATTORNEY_QUEUE_COLUMNS =
  "request_id,request_path,requested_modality,duration_minutes,slot_start_at,slot_end_at,attorney_listed_price_minor,platform_fee_minor,currency_code,response_deadline_at,decide_by,expired_due,created_at";
const ATTORNEY_DETAIL_COLUMNS =
  "request_id,state,expired_due,request_path,requested_modality,duration_minutes,slot_start_at,slot_end_at,attorney_listed_price_minor,platform_fee_minor,currency_code,response_deadline_at,decide_by,created_at,decided_at,ended_reason,consultation_id,consultation_state,booking_starts_at,booking_ends_at";

async function accessChecks() {
  await check(
    "AUTHZ-1 (MBS section 20; Packet S8 'own requests only at aal2') only the selected attorney at aal2 decides or reads a Request: another attorney's Request, an unknown id and a Request never offered (still waiting for its payment step) answer alike (not_found; no row); an attorney session at aal1 is denied and reads nothing; a client account is denied; anon and service_role cannot execute; nothing changes",
    () => {
      const s = makeRequest({ jurisdiction: world.J.B });
      const preDecision = makeRequest({ jurisdiction: world.J.A });
      assert.equal(requestStateOf(preDecision.request), "slot_held");
      const before = writeCounts();
      for (const id of [s.request, uid()]) {
        assert.deepEqual(accept(world.bob, id), {
          outcome: "not_found",
          consultation: null,
          problem: null,
        });
        assert.equal(decline(world.bob, id), "not_found");
        assert.deepEqual(
          rowsAsAttorney(
            world.bob,
            `select request_id from public.attorney_request('${id}');`,
          ),
          [],
        );
      }
      assert.equal(accept(world.ann, preDecision.request).outcome, "not_found");
      assert.equal(decline(world.ann, preDecision.request), "not_found");
      assert.deepEqual(
        rowsAsAttorney(
          world.ann,
          `select request_id from public.attorney_request('${preDecision.request}');`,
        ),
        [],
      );
      assert.equal(
        rowsAsAttorney(
          world.ann,
          "select request_id from public.attorney_requests();",
        ).includes(preDecision.request),
        false,
      );
      assert.equal(
        rowsAsAttorney(
          world.bob,
          "select request_id from public.attorney_requests();",
        ).includes(s.request),
        false,
      );
      assert.equal(
        accept(world.ann, s.request, { aal: "aal1" }).outcome,
        "denied",
      );
      assert.equal(decline(world.ann, s.request, { aal: "aal1" }), "denied");
      assert.deepEqual(
        rowsAsAttorney(
          world.ann,
          "select request_id from public.attorney_requests();",
          {
            aal: "aal1",
          },
        ),
        [],
      );
      assert.equal(
        asClient(s.client, ACCEPT_SQL(s.request)).split("|")[0],
        "denied",
      );
      assert.equal(asClient(s.client, DECLINE_SQL(s.request)), "denied");
      assert.deepEqual(writeCounts(), before);
      assert.equal(requestStateOf(s.request), "awaiting_attorney");
      world.openForAttorney = s;
    },
  );

  await check(
    "AUTHZ-2 the client's decision read answers only the caller's own Request: another client, an attorney and an unknown id get no row",
    () => {
      const s = world.acceptedScheduled;
      const other = newClient();
      assert.equal(
        rowsAsClient(
          s.client,
          `select state from public.client_request_decision('${s.request}');`,
        )[0],
        "accepted",
      );
      assert.deepEqual(
        rowsAsClient(
          other,
          `select state from public.client_request_decision('${s.request}');`,
        ),
        [],
      );
      assert.deepEqual(
        rowsAsAttorney(
          world.ann,
          `select state from public.client_request_decision('${s.request}');`,
        ),
        [],
      );
      assert.deepEqual(
        rowsAsClient(
          s.client,
          `select state from public.client_request_decision('${uid()}');`,
        ),
        [],
      );
    },
  );

  await check(
    "VIS-1 (Packet section 3 counsel gate 'intake visibility to an attorney before acceptance: nothing shown'; PS-A3 section 5) before acceptance the attorney's queue and detail answer exactly the allowed columns (path, modality, duration, held slot, attorney-side quote amounts and currency, deadlines, expiry flag), never the client's message, identity, Intake or Referral; the attorney reads no Request, Intake, Referral or Hold row directly; after acceptance the detail adds the Consultation's state and the Booking's times, and the attorney reads the Consultation through the P1 participant policy but still no Intake",
    () => {
      const message = "Synthetic private message for S8 visibility";
      const s = makeRequest({ jurisdiction: world.J.B, message });
      const queue = rowsAsAttorney(
        world.ann,
        `select row_to_json(q)::text from public.attorney_requests() q where q.request_id = '${s.request}';`,
      );
      assert.equal(queue.length, 1);
      const row = JSON.parse(queue[0]);
      assert.equal(Object.keys(row).join(","), ATTORNEY_QUEUE_COLUMNS);
      assert.deepEqual(
        [
          row.request_path,
          row.requested_modality,
          row.duration_minutes,
          row.attorney_listed_price_minor,
          row.platform_fee_minor,
          row.currency_code,
          row.expired_due,
        ],
        ["scheduled", "synthetic_video", 30, 5000, 500, "XTS", false],
      );
      const hold = holdOf(s.request);
      assert.equal(ms(row.decide_by), ms(hold.expires_at));
      const detail = JSON.parse(
        rowsAsAttorney(
          world.ann,
          `select row_to_json(d)::text from public.attorney_request('${s.request}') d;`,
        )[0],
      );
      assert.equal(Object.keys(detail).join(","), ATTORNEY_DETAIL_COLUMNS);
      const text = `${queue[0]} ${JSON.stringify(detail)}`;
      for (const secret of [
        message,
        s.client.client,
        s.client.intake,
        s.client.user,
        s.referral,
      ]) {
        assert.equal(text.includes(secret), false, secret);
      }
      for (const table of [
        "consultation_requests",
        "intakes",
        "referrals",
        "slot_holds",
        "bookings",
      ]) {
        const answer = asAttorney(
          world.ann,
          `select count(*) from public.${table};`,
        );
        assert.ok(
          answer === "0" || answer === "ERROR 42501",
          `${table}: ${answer}`,
        );
      }
      assert.equal(accept(world.ann, s.request).outcome, "accepted");
      const after = JSON.parse(
        rowsAsAttorney(
          world.ann,
          `select row_to_json(d)::text from public.attorney_request('${s.request}') d;`,
        )[0],
      );
      assert.equal(after.state, "accepted");
      assert.equal(after.consultation_state, "scheduled");
      assert.equal(ms(after.booking_starts_at), ms(hold.slot_start_at));
      assert.equal(JSON.stringify(after).includes(message), false);
      assert.equal(
        asAttorney(
          world.ann,
          `select count(*) from public.consultations where consultation_request_id = '${s.request}';`,
        ),
        "1",
      );
      assert.equal(
        asAttorney(world.ann, "select count(*) from public.intakes;"),
        "0",
      );
      assert.equal(
        asClient(
          s.client,
          `select client_message from public.client_request('${s.request}');`,
        ),
        message,
      );
    },
  );

  await check(
    "AUD-1 (IMP section 15; Packet section 4 logs; PM INV-9) audit minimization: every S8 audit event carries identifiers, states, evaluation, Hold, Booking, payment and Engagement facts and policy references only: never the client's message, a display name, a provider reference or free text; the acceptance event carries exactly its allowed keys",
    () => {
      const actions =
        "('consultation_request.accepted', 'consultation_request.declined', 'consultation_request.acceptance_refused', 'consultation_request.ended_not_eligible', 'consultation.created', 'engagement.effective', 'reconciliation_exception.opened')";
      assert.equal(
        sql(
          `select count(*) from public.audit_events where action_code in ${actions} and (coalesce(before_snapshot::text, '') || coalesce(after_snapshot::text, '')) ~ '(Synthetic private message|Synthetic|cs_test_|pi_syn)';`,
        ),
        "0",
      );
      const keys = sql(
        "select string_agg(distinct k, ',' order by k) from public.audit_events a cross join lateral jsonb_object_keys(a.after_snapshot) k where a.action_code = 'consultation_request.accepted';",
      );
      assert.equal(
        keys,
        "authorization_timing,bookability_evaluation_id,booking_id,capture_requested,capture_timing,consultation_created,consultation_creation,consultation_id,eligibility_evaluation_id,engagement_effective,engagement_id,hold_id,payment_state,payment_transaction_id,state",
      );
      return { accepted_keys: keys.split(",") };
    },
  );
}

// ---------------------------------------------------------------------------
// REV: eligibility and jurisdiction changes routed to review (PM rows 37-45)
// ---------------------------------------------------------------------------

const reviewsOf = (type, matterId) =>
  jsonOf(
    `select coalesce(json_agg(json_build_object('id', id, 'source_type', source_type, 'canonical_type', canonical_type, 'canonical_id', canonical_id, 'severity', severity, 'status', status, 'evidence', evidence_reference) order by detected_at, id), '[]'::json)::text from public.reconciliation_exceptions where exception_type = ${lit(type)} and source_id = '${matterId}';`,
  );

// What a review must never change.
function matterSnapshot(request) {
  const consultation = consultationOf(request);
  return {
    request: requestOf(request),
    hold: holdOf(request),
    consultation,
    bookings: consultation === null ? [] : bookingsOf(consultation.id),
    payments: jsonOf(
      `select coalesce(json_agg(row_to_json(p) order by p.created_at), '[]'::json)::text from public.payment_transactions p where consultation_request_id = '${request}';`,
    ),
  };
}

async function reviewChecks() {
  await check(
    "REV-1 (PM rows 37-40; rows 39-40 counsel-gated) an attorney's licence change that ends eligibility routes each open matter to review at commit, deciding nothing: an eligibility_change_review per matter (the undecided Request: medium, rows 37-38; the accepted, not started Consultation: high, rows 39-40), with the cause, the derived result and the states as evidence, each audited once; the Requests, the Consultation, its Booking and the Holds are unchanged; a further change opens no duplicate",
    () => {
      const pending = makeRequest({
        jurisdiction: world.J.R,
        lawyer: world.dee,
      });
      const acceptedCase = makeRequest({
        jurisdiction: world.J.R,
        lawyer: world.dee,
      });
      assert.equal(accept(world.dee, acceptedCase.request).outcome, "accepted");
      const consultation = consultationOf(acceptedCase.request);
      const before = [
        matterSnapshot(pending.request),
        matterSnapshot(acceptedCase.request),
      ];
      sql(
        `update public.licenses set reported_status = 'synthetic-suspended' where attorney_id = '${world.dee.profile}';`,
      );
      const onRequest = reviewsOf("eligibility_change_review", pending.request);
      const onConsultation = reviewsOf(
        "eligibility_change_review",
        consultation.id,
      );
      assert.equal(onRequest.length, 1);
      assert.equal(onConsultation.length, 1);
      assert.deepEqual(
        [
          onRequest[0].source_type,
          onRequest[0].canonical_type,
          onRequest[0].severity,
          onRequest[0].status,
          onRequest[0].evidence.payment_matrix_rows,
          onRequest[0].evidence.cause,
          onRequest[0].evidence.request_state,
        ],
        [
          "consultation_request",
          "consultation_request",
          "medium",
          "open",
          [37, 38],
          "licenses",
          "awaiting_attorney",
        ],
      );
      assert.deepEqual(
        [
          onConsultation[0].source_type,
          onConsultation[0].severity,
          onConsultation[0].evidence.payment_matrix_rows,
          onConsultation[0].evidence.consultation_state,
        ],
        ["consultation", "high", [39, 40], "scheduled"],
      );
      assert.notEqual(
        onConsultation[0].evidence.eligibility_result,
        "eligible",
      );
      assert.deepEqual(
        [matterSnapshot(pending.request), matterSnapshot(acceptedCase.request)],
        before,
      );
      for (const item of [onRequest[0], onConsultation[0]]) {
        assert.equal(
          auditsOf(item.id, "reconciliation_exception.opened").length,
          1,
        );
      }
      sql(
        `update public.licenses set reported_status = 'synthetic-lapsed' where attorney_id = '${world.dee.profile}';`,
      );
      assert.equal(
        reviewsOf("eligibility_change_review", pending.request).length,
        1,
      );
      assert.equal(
        reviewsOf("eligibility_change_review", consultation.id).length,
        1,
      );
      world.reviewed = { pending, acceptedCase, consultation: consultation.id };
      return {
        request: onRequest[0].evidence,
        consultation: onConsultation[0].evidence,
      };
    },
  );

  await check(
    "REV-2 (PM row 41, counsel-gated) eligibility ending during a live Consultation opens a high eligibility_change_review naming row 41; the live Consultation is not interrupted",
    () => {
      const s = makeRequest({ jurisdiction: world.J.R, lawyer: world.eve });
      assert.equal(accept(world.eve, s.request).outcome, "accepted");
      const consultation = consultationOf(s.request);
      sql(
        `update public.consultations set state = 'ready' where id = '${consultation.id}';
         update public.consultations set state = 'live', started_at = now() where id = '${consultation.id}';`,
      );
      sql(
        `update public.licenses set reported_status = 'synthetic-suspended' where attorney_id = '${world.eve.profile}';`,
      );
      const items = reviewsOf("eligibility_change_review", consultation.id);
      assert.deepEqual(
        [
          items.length,
          items[0].severity,
          items[0].evidence.payment_matrix_rows,
          items[0].evidence.consultation_state,
        ],
        [1, "high", [41], "live"],
      );
      assert.equal(consultationOf(s.request).state, "live");
    },
  );

  await check(
    "REV-3 (PM rows 42-44, regulator-gated) a jurisdiction lifecycle change opens a jurisdiction_change_review for every open matter there (the undecided Request with its authorization, the accepted Consultation with money in flight), recording the previous and new states and rows 42-44; nothing is changed; matters in other jurisdictions get none",
    () => {
      const pending = authorizedRequest({
        jurisdiction: world.J.T,
        requestPath: "scheduled",
        lawyer: world.kim,
      });
      const acceptedCase = authorizedRequest({
        jurisdiction: world.J.T,
        requestPath: "scheduled",
        lawyer: world.kim,
      });
      assert.equal(accept(world.kim, acceptedCase.request).outcome, "accepted");
      const consultation = consultationOf(acceptedCase.request);
      const before = [
        matterSnapshot(pending.request),
        matterSnapshot(acceptedCase.request),
      ];
      const elsewhere = count(
        "reconciliation_exceptions",
        "exception_type = 'jurisdiction_change_review'",
      );
      assert.equal(elsewhere, 0);
      sql(
        `update public.jurisdictions set lifecycle_state = 'restricted' where id = '${world.J.T}';`,
      );
      const onRequest = reviewsOf(
        "jurisdiction_change_review",
        pending.request,
      );
      const onConsultation = reviewsOf(
        "jurisdiction_change_review",
        consultation.id,
      );
      for (const items of [onRequest, onConsultation]) {
        assert.equal(items.length, 1);
        assert.deepEqual(
          [
            items[0].severity,
            items[0].evidence.previous_lifecycle_state,
            items[0].evidence.lifecycle_state,
            items[0].evidence.payment_matrix_rows,
          ],
          ["high", "unsupported", "restricted", [42, 43, 44]],
        );
      }
      assert.equal(onConsultation[0].evidence.payment_state, "authorized");
      assert.equal(
        count(
          "reconciliation_exceptions",
          "exception_type = 'jurisdiction_change_review'",
        ),
        2,
      );
      assert.deepEqual(
        [matterSnapshot(pending.request), matterSnapshot(acceptedCase.request)],
        before,
      );
    },
  );

  await check(
    "REV-4 (PM rows 37-41) an Attorney Profile suspension and a User account suspension each route the attorney's open matters to eligibility review; nothing is changed",
    () => {
      const suspended = makeRequest({
        jurisdiction: world.J.R,
        lawyer: world.fay,
      });
      const closedUser = makeRequest({
        jurisdiction: world.J.R,
        lawyer: world.lee,
      });
      const before = [
        matterSnapshot(suspended.request),
        matterSnapshot(closedUser.request),
      ];
      sql(
        `update public.attorney_profiles set profile_state = 'suspended' where id = '${world.fay.profile}';`,
      );
      sql(
        `update public.users set account_state = 'suspended' where id = '${world.lee.user}';`,
      );
      const a = reviewsOf("eligibility_change_review", suspended.request);
      const b = reviewsOf("eligibility_change_review", closedUser.request);
      assert.deepEqual(
        [a.length, a[0].evidence.cause, b.length, b[0].evidence.cause],
        [1, "attorney_profiles", 1, "users"],
      );
      assert.deepEqual(
        [matterSnapshot(suspended.request), matterSnapshot(closedUser.request)],
        before,
      );
    },
  );

  await check(
    "REV-5 (PM rows 37-41; TA section 63: no retroactive policy) an eligibility policy version change in a jurisdiction routes the open matters of every attorney there to review (cause policy_versions); a fact change that keeps the attorney eligible opens nothing",
    () => {
      const s = makeRequest({ jurisdiction: world.J.S, lawyer: world.jon });
      const benign = makeRequest({
        jurisdiction: world.J.B,
        lawyer: world.gus,
      });
      licenceNumber += 1;
      sql(
        `insert into public.licenses (attorney_id, jurisdiction_id, license_number, reported_status) values ('${world.gus.profile}', '${world.J.A}', 'SYN-S8-LIC-${String(licenceNumber).padStart(4, "0")}', 'synthetic-active');`,
      );
      assert.equal(
        count("reconciliation_exceptions", `source_id = '${benign.request}'`),
        0,
      );
      sql(
        `update public.policy_versions set effective_until = now() where id = '${world.policies.S.eligibility}';`,
      );
      const items = reviewsOf("eligibility_change_review", s.request);
      assert.deepEqual(
        [items.length, items[0].evidence.cause, items[0].severity],
        [1, "policy_versions", "medium"],
      );
      assert.equal(requestStateOf(s.request), "awaiting_attorney");
      world.undetermined = s;
    },
  );

  await check(
    "REVAL-5 (MBS section 2.10 and TA section 60 'required policy is missing'; PM row 38 covers not_eligible only) an attorney whose eligibility cannot be determined at the decision point (no eligibility policy in force in the jurisdiction: the engine answers undetermined, no_applicable_policy) is refused with eligibility_unavailable and nothing changes: no Eligibility or Bookability Evaluation, audit event, Consultation, Booking, payment or job is kept, the Request still awaits with its Hold; a configuration or data gap never ends the client's Request",
    () => {
      const s = world.undetermined;
      const hold = holdOf(s.request);
      const before = writeCounts();
      const answer = accept(world.jon, s.request);
      assert.deepEqual(answer, {
        outcome: "eligibility_unavailable",
        consultation: null,
        problem: null,
      });
      assert.deepEqual(writeCounts(), before);
      assert.equal(requestStateOf(s.request), "awaiting_attorney");
      assert.deepEqual(holdOf(s.request), hold);
      assert.equal(consultationOf(s.request), null);
      assert.equal(
        auditsOf(s.request, "consultation_request.ended_not_eligible").length,
        0,
      );
      return answer;
    },
  );

  await check(
    "REV-6 (PM rows 39-40; the engine's evidence inputs) a verification evidence change alone routes the attorney's open matters to review, deciding nothing: newly linked discrepant evidence on the licence (cause verification_evidence_subjects) and a discrepancy flag set on existing evidence (cause verification_evidence) each open one high eligibility_change_review for an accepted, not started Consultation; the Consultation, its Booking, the Request and its Hold are unchanged; an authority reference added to a jurisdiction's eligibility version runs the review and, with every attorney still eligible, opens nothing",
    () => {
      const cases = {};
      for (const [key, name] of [
        ["linked", "Mia Synthetic"],
        ["flagged", "Ned Synthetic"],
      ]) {
        const lawyer = attorney({ name, jurisdictions: [world.J.R] });
        const scenario = makeRequest({ jurisdiction: world.J.R, lawyer });
        assert.equal(accept(lawyer, scenario.request).outcome, "accepted");
        cases[key] = {
          lawyer,
          scenario,
          consultation: consultationOf(scenario.request).id,
          licence: sql(
            `select id from public.licenses where attorney_id = '${lawyer.profile}';`,
          ),
        };
      }
      const snapshots = () =>
        Object.values(cases).map((c) => matterSnapshot(c.scenario.request));
      const before = snapshots();
      const evidence = uid();
      sql(
        `insert into public.verification_evidence (id, jurisdiction_id, source_type, source_reference, retrieved_at, retrieved_by_user_id, evidence_summary, verification_method, discrepancy_flag)
           values ('${evidence}', '${world.J.R}', 'synthetic register', 'synthetic entry', now(), '${world.staff.user}', 'synthetic discrepant evidence', 'synthetic lookup', true);
         insert into public.verification_evidence_subjects (verification_evidence_id, license_id) values ('${evidence}', '${cases.linked.licence}');`,
      );
      sql(
        `update public.verification_evidence set discrepancy_flag = true where id in (select s.verification_evidence_id from public.verification_evidence_subjects s where s.license_id = '${cases.flagged.licence}');`,
      );
      const result = {};
      for (const [key, cause] of [
        ["linked", "verification_evidence_subjects"],
        ["flagged", "verification_evidence"],
      ]) {
        const items = reviewsOf(
          "eligibility_change_review",
          cases[key].consultation,
        );
        assert.deepEqual(
          [
            items.length,
            items[0].evidence.cause,
            items[0].severity,
            items[0].evidence.payment_matrix_rows,
          ],
          [1, cause, "high", [39, 40]],
          key,
        );
        assert.notEqual(items[0].evidence.eligibility_result, "eligible");
        result[key] = items[0].evidence.eligibility_result;
      }
      assert.deepEqual(snapshots(), before);
      const exceptions = count("reconciliation_exceptions");
      sql(
        `insert into public.policy_authority_references (policy_version_id, authority_type, citation_text, source_title, retrieved_at, verified_by_user_id, verification_status)
           values ('${world.policies.B.eligibility}', 'synthetic', 'synthetic citation', 'synthetic source', now(), '${world.staff.user}', 'verified');`,
      );
      assert.equal(count("reconciliation_exceptions"), exceptions);
      return result;
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

function prodJurisdiction(
  key,
  lifecycle,
  engagement,
  flow = FLOW_ALL(AT_ACCEPTANCE, "at_attorney_acceptance"),
) {
  const id = newJurisdiction(`SYN_S8_PROD_${key}`, PROD_DB, "ready");
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
    payment_flow: prodActivePolicy("payment_flow", id, flow, prod.mode),
  };
  const parameters = ENGAGEMENT("attorney_acceptance", "at_consultation_start");
  policies.engagement =
    engagement === "planted"
      ? prodPlantedDevelopment("engagement", id, parameters, prod.mode)
      : prodActivePolicy("engagement", id, parameters, prod.mode);
  return { id, policies };
}

// An instant Request written by the owner with its same-transaction
// evidence, then walked to awaiting_attorney by the owner (DM section 9).
function prodAwaitingRequest(jurisdiction) {
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
     insert into public.referrals (id, intake_id, attorney_id, jurisdiction_id, attempt_ordinal, allocation_method) values ('${referral}', '${intake}', '${prod.attorney.profile}', '${jurisdiction.id}', 1, 'client_selected');
     insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, context_id, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${evaluation}', '${prod.attorney.profile}', '${jurisdiction.id}', 'jurisdiction', null, now(), '[]'::jsonb, 'eligible', '[]'::jsonb, '{}'::jsonb, now());
     insert into public.referral_eligible_pool_entries (referral_id, attorney_id, eligibility_evaluation_id, eligible_as_of) values ('${referral}', '${prod.attorney.profile}', '${evaluation}', now());
     insert into public.referral_presentations (referral_id, attorney_id, display_position, client_filter_context, narrowing_actor, shown_at) values ('${referral}', '${prod.attorney.profile}', 1, null, 'platform', now());
     insert into public.bookability_evaluations (attorney_id, eligibility_evaluation_id, context_type, context_id, evaluated_at, as_of, modality, presence_observed, availability_basis, constraint_results, result) values ('${prod.attorney.profile}', '${evaluation}', 'referral', '${referral}', now(), now(), 'unselected', true, null, '[]'::jsonb, 'bookable');
     commit;
     begin;
     insert into public.consultation_requests (id, intake_id, client_id, selected_attorney_id, referral_id, request_path, referral_policy_version_id, requested_modality, requested_duration_minutes, state, response_deadline_at)
       values ('${request}', '${intake}', '${clientProfile}', '${prod.attorney.profile}', '${referral}', 'instant', '${jurisdiction.policies.referral}', 'synthetic_video', 30, 'created', now() + interval '1 hour');
     insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, context_id, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${requestEvaluation}', '${prod.attorney.profile}', '${jurisdiction.id}', 'jurisdiction', null, now(), '[]'::jsonb, 'eligible', '[]'::jsonb, '{}'::jsonb, now());
     insert into public.bookability_evaluations (attorney_id, eligibility_evaluation_id, context_type, context_id, evaluated_at, as_of, modality, constraint_results, result) values ('${prod.attorney.profile}', '${requestEvaluation}', 'consultation_request', '${request}', now(), now(), 'synthetic_video', '[]'::jsonb, 'bookable');
     insert into public.fee_calculations (consultation_request_id, fee_policy_version_id, attorney_listed_price_minor, platform_fee_minor, client_fee_minor, tax_or_other_required_fee_minor, total_client_amount_minor, currency_code, quote_valid_until, calculated_at, calculation_snapshot)
       values ('${request}', '${jurisdiction.policies.fee}', 5000, 500, 175, 50, 5225, 'XTS', now() + interval '15 minutes', now(), '{"schema": "synthetic-owner-fixture"}'::jsonb);
     commit;
     update public.consultation_requests set state = 'payment_authorized' where id = '${request}';
     update public.consultation_requests set state = 'awaiting_attorney' where id = '${request}';`,
  );
  return request;
}

async function productionChecks() {
  await check(
    "PROD-1 (MBS sections 13 and 19; TA section 32 F1-F2; Packet section 4 four-way gate) in a production-class database the decision never uses development configuration: with only a development engagement version the acceptance answers configuration_unavailable engagement_no_applicable_policy; with an approved, active engagement version in a jurisdiction that is not live the four-way gate refuses (production_gate_closed); nothing changes",
    () => {
      prodSql(
        `select public.record_deployment_environment('production', '${PRODUCTION_REF}');`,
      );
      prod.grantor = newAccount("active", PROD_DB);
      prodSql(
        `insert into public.staff_profiles (user_id, staff_state) values ('${prod.grantor.user}', 'active');`,
      );
      prod.mode = newRegulatoryMode("SYN_S8_PROD_MARKETPLACE", PROD_DB);
      const lawyer = newAccount("active", PROD_DB);
      prod.attorney = { ...lawyer, profile: uid() };
      prodSql(
        `insert into public.attorney_profiles (id, user_id, profile_state, display_name) values ('${prod.attorney.profile}', '${lawyer.user}', 'approved', 'Prod Synthetic');`,
      );
      const live = prodJurisdiction("LIVE", "live", "planted");
      const staged = prodJurisdiction("STAGED", "staged", "approved");
      const answers = {};
      for (const [label, jurisdiction, problem] of [
        ["live_planted", live, "engagement_no_applicable_policy"],
        ["staged_approved", staged, "production_gate_closed"],
      ]) {
        const request = prodAwaitingRequest(jurisdiction);
        const before = prodSql("select count(*) from public.audit_events;");
        const line = asIn(
          PROD_DB,
          "authenticated",
          prod.attorney.auth,
          ACCEPT_SQL(request),
        );
        answers[label] = line;
        assert.equal(line, `configuration_unavailable||${problem}`, label);
        assert.equal(
          prodSql(
            `select state from public.consultation_requests where id = '${request}';`,
          ),
          "awaiting_attorney",
        );
        assert.equal(
          prodSql("select count(*) from public.audit_events;"),
          before,
        );
        assert.equal(
          prodSql("select count(*) from public.consultations;"),
          "0",
        );
      }
      return answers;
    },
  );

  await check(
    "PROD-2 (MBS section 19; TA section 32 F2; Packet section 4 four-way gate) in a production-class database an acceptance whose payment attempt was already authorized (its recorded payment_flow and engagement versions, capture at acceptance) re-runs the four-way gate for the Request's jurisdiction: while the jurisdiction is live and launch-authorized the decision passes the gate (and, with no eligibility policy in force, answers eligibility_unavailable, nothing changed); once the jurisdiction is no longer live it answers configuration_unavailable production_gate_closed before any write: no capture is requested, no Consultation or job is created, the payment stays authorized and the Request awaits",
    () => {
      const gated = prodJurisdiction(
        "GATED",
        "live",
        "approved",
        FLOW_ALL(BEFORE, "at_attorney_acceptance"),
      );
      const request = prodAwaitingRequest(gated);
      const payment = uid();
      const planted = {};
      for (const type of ["payment", "cancellation", "refund"]) {
        planted[type] = uid();
      }
      // Owner fixture (disposable database): the authorized attempt the S7
      // paths would have recorded, written with triggers off; the three
      // recorded versions the decision never reads are planted the same way.
      prodSql(
        `begin;
         set local session_replication_role = replica;
         ${Object.entries(planted)
           .map(
             ([type, id]) =>
               `insert into public.policy_versions (id, policy_type_code, jurisdiction_id, regulatory_mode_id, version_label, parameters, status, effective_from, development_only) values ('${id}', '${type}', '${gated.id}', '${prod.mode}', 'synthetic-planted-${type}', '{}'::jsonb, 'draft', now() - interval '1 day', false);`,
           )
           .join("\n         ")}
         insert into public.payment_transactions (id, fee_calculation_id, consultation_request_id, jurisdiction_id, regulatory_mode_id, referral_policy_version_id, payment_policy_version_id, fee_policy_version_id, payment_flow_policy_version_id, engagement_policy_version_id, cancellation_policy_version_id, refund_policy_version_id, state, amount_authorized_minor, currency_code, provider_code, provider_payment_reference, authorized_at)
           select '${payment}', f.id, '${request}', '${gated.id}', '${prod.mode}', '${gated.policies.referral}', '${planted.payment}', '${gated.policies.fee}', '${gated.policies.payment_flow}', '${gated.policies.engagement}', '${planted.cancellation}', '${planted.refund}', 'authorized', f.total_client_amount_minor, f.currency_code, 'stripe', 'pi_synprodgate', now()
           from public.fee_calculations f where f.consultation_request_id = '${request}';
         commit;`,
      );
      const snapshot = () =>
        prodSql(
          `select r.state || '|' || p.state || '|' || (select count(*) from public.operational_jobs) || '|' || (select count(*) from public.consultations) || '|' || (select count(*) from public.eligibility_evaluations) from public.consultation_requests r join public.payment_transactions p on p.consultation_request_id = r.id where r.id = '${request}';`,
        );
      const open = snapshot();
      const audits = prodSql("select count(*) from public.audit_events;");
      const whileLive = asIn(
        PROD_DB,
        "authenticated",
        prod.attorney.auth,
        ACCEPT_SQL(request),
      );
      assert.equal(whileLive, "eligibility_unavailable||");
      assert.equal(snapshot(), open);
      assert.equal(
        prodSql("select count(*) from public.audit_events;"),
        audits,
      );
      prodSql(
        `update public.jurisdictions set lifecycle_state = 'restricted' where id = '${gated.id}';`,
      );
      const closed = snapshot();
      const auditsAfterChange = prodSql(
        "select count(*) from public.audit_events;",
      );
      const line = asIn(
        PROD_DB,
        "authenticated",
        prod.attorney.auth,
        ACCEPT_SQL(request),
      );
      assert.equal(line, "configuration_unavailable||production_gate_closed");
      assert.equal(snapshot(), closed);
      assert.equal(
        closed.split("|").slice(0, 2).join("|"),
        "awaiting_attorney|authorized",
      );
      assert.equal(
        prodSql("select count(*) from public.audit_events;"),
        auditsAfterChange,
      );
      return { whileLive, afterLifecycleChange: line };
    },
  );
}

// ---------------------------------------------------------------------------
// CC: races under real concurrency (persistent sessions)
// ---------------------------------------------------------------------------

const OFFER_SQL = (price) =>
  `select outcome || '|' || coalesce(offer_id::text, '') from public.attorney_set_consultation_offer('synthetic_video', 30, ${price}, 'XTS');`;

// Runs "first" in session a and leaves it uncommitted; sends "second" in
// session b, proves b waits on a lock, commits a, then reads b's answer and
// commits b. Answers both outcome lines.
async function raceOf(a, first, b, second) {
  const firstAnswer = lastLine(await a.ok(first));
  const pending = b.send(second);
  await blockedOnLock(b.pid);
  await a.ok("commit;");
  const result = await pending;
  assert.equal(result.sqlstate, "00000", result.stderr);
  const secondAnswer = lastLine(result.rows);
  await b.ok("commit;");
  a.close();
  b.close();
  return { first: firstAnswer, second: secondAnswer };
}

function decidedOnce(request) {
  const consultations = count(
    "consultations",
    `consultation_request_id = '${request}'`,
  );
  const consultation = consultationOf(request);
  return {
    state: requestStateOf(request),
    consultations,
    bookings:
      consultation === null
        ? 0
        : count(
            "bookings",
            `consultation_id = '${consultation.id}' and status = 'confirmed'`,
          ),
    hold: holdOf(request)?.release_reason ?? null,
    accepted_audits: auditsOf(request, "consultation_request.accepted").length,
    declined_audits: auditsOf(request, "consultation_request.declined").length,
  };
}

async function concurrencyChecks() {
  await check(
    "CC-1 (MBS13-1, MBS13-2, MBS13-5; TA section 14 B2; PS section 36; IMP section 24 concurrency) two acceptances of one Request in two persistent sessions: the second waits on the attorney's scheduling lock, then loses deterministically (already_decided, naming the winner's Consultation); exactly one Consultation, one confirmed Booking, one converted Hold and one acceptance audit event; a later retry answers the same",
    async () => {
      const s = makeRequest({ jurisdiction: world.J.B });
      const answers = await raceOf(
        await attorneySession("cc1-a", world.ann),
        ACCEPT_SQL(s.request),
        await attorneySession("cc1-b", world.ann),
        ACCEPT_SQL(s.request),
      );
      const first = parseAccept(answers.first);
      const second = parseAccept(answers.second);
      assert.equal(first.outcome, "accepted");
      assert.deepEqual(second, {
        outcome: "already_decided",
        consultation: first.consultation,
        problem: "accepted",
      });
      const state = decidedOnce(s.request);
      assert.deepEqual(state, {
        state: "accepted",
        consultations: 1,
        bookings: 1,
        hold: "converted",
        accepted_audits: 1,
        declined_audits: 0,
      });
      assert.deepEqual(accept(world.ann, s.request), second);
      report.concurrency.double_acceptance = { answers, state };
      return report.concurrency.double_acceptance;
    },
  );

  await check(
    "CC-2 (MBS13-8 cancellation and acceptance; IMP section 11) acceptance racing the client's withdrawal, in both orders: the second waits on the scheduling lock and gets the loser's fixed outcome (not_withdrawable after an acceptance; withdrawn after a withdrawal); the Hold is converted or released accordingly, never both, and no Consultation exists for a withdrawn Request",
    async () => {
      const outcomes = {};
      for (const order of ["accept_first", "withdraw_first"]) {
        const s = makeRequest({ jurisdiction: world.J.B });
        const attorneyS = await attorneySession(`cc2-a-${order}`, world.ann);
        const clientS = await clientSession(`cc2-c-${order}`, s.client);
        const answers =
          order === "accept_first"
            ? await raceOf(
                attorneyS,
                ACCEPT_SQL(s.request),
                clientS,
                WITHDRAW_SQL(s.request),
              )
            : await raceOf(
                clientS,
                WITHDRAW_SQL(s.request),
                attorneyS,
                ACCEPT_SQL(s.request),
              );
        outcomes[order] = { answers, state: decidedOnce(s.request) };
      }
      assert.equal(
        parseAccept(outcomes.accept_first.answers.first).outcome,
        "accepted",
      );
      assert.equal(outcomes.accept_first.answers.second, "not_withdrawable");
      assert.deepEqual(
        [
          outcomes.accept_first.state.state,
          outcomes.accept_first.state.consultations,
          outcomes.accept_first.state.hold,
        ],
        ["accepted", 1, "converted"],
      );
      assert.equal(outcomes.withdraw_first.answers.first, "withdrawn");
      assert.equal(
        parseAccept(outcomes.withdraw_first.answers.second).outcome,
        "withdrawn",
      );
      assert.deepEqual(
        [
          outcomes.withdraw_first.state.state,
          outcomes.withdraw_first.state.consultations,
          outcomes.withdraw_first.state.hold,
        ],
        ["cancelled", 0, "released"],
      );
      report.concurrency.acceptance_vs_withdrawal = outcomes;
      return outcomes;
    },
  );

  await check(
    "CC-3 (MBS13-7 expiration and acceptance; PM row 9; INV-5) acceptance racing expiry: an acceptance made before the deadline holds the scheduling lock while the deadline passes, the sweep skips the busy attorney (busy, nothing expired) and the acceptance commits; once the deadline has passed a lazy expiry holding the lock makes a waiting acceptance answer expired",
    async () => {
      const early = makeRequest({ jurisdiction: world.J.X });
      const a = await attorneySession("cc3-a", world.ann);
      const accepted = parseAccept(
        lastLine(await a.ok(ACCEPT_SQL(early.request))),
      );
      assert.equal(accepted.outcome, "accepted");
      await untilPast(requestOf(early.request).response_deadline_at);
      const swept = jsonOf("select public.request_expiry_sweep()::text;");
      assert.ok(swept.busy >= 1, JSON.stringify(swept));
      assert.equal(requestStateOf(early.request), "awaiting_attorney");
      await a.ok("commit;");
      a.close();
      assert.equal(requestStateOf(early.request), "accepted");
      assert.equal(holdOf(early.request).release_reason, "converted");
      const late = makeRequest({ jurisdiction: world.J.X });
      await untilPast(requestOf(late.request).response_deadline_at);
      const answers = await raceOf(
        await ownerSession("cc3-o"),
        `select public.request_expire_if_due('${late.request}', false);`,
        await attorneySession("cc3-b", world.ann),
        ACCEPT_SQL(late.request),
      );
      assert.equal(answers.first, "expired");
      assert.equal(parseAccept(answers.second).outcome, "expired");
      assert.equal(requestStateOf(late.request), "expired");
      assert.equal(consultationOf(late.request), null);
      report.concurrency.acceptance_vs_expiry = {
        sweep_during_acceptance: swept,
        lazy_expiry_first: answers,
      };
      return report.concurrency.acceptance_vs_expiry;
    },
  );

  await check(
    "CC-4 (MBS13-6, MBS13-7; MBS section 9 invariant 4; DM section 8) acceptance racing the Hold's own expiry: an acceptance holding the lock while the Hold's expiry passes converts it (the Hold sweep skips the busy attorney); once the Hold has expired, a sweep holding the lock expires Hold and Request and the waiting acceptance answers expired",
    async () => {
      const early = makeRequest({ jurisdiction: world.J.Y });
      const a = await attorneySession("cc4-a", world.ann);
      assert.equal(
        parseAccept(lastLine(await a.ok(ACCEPT_SQL(early.request)))).outcome,
        "accepted",
      );
      await untilPast(holdOf(early.request).expires_at);
      const swept = jsonOf("select public.scheduling_expiry_sweep()::text;");
      assert.ok(swept.busy >= 1, JSON.stringify(swept));
      await a.ok("commit;");
      a.close();
      const hold = holdOf(early.request);
      assert.equal(hold.release_reason, "converted");
      assert.ok(ms(hold.released_at) < ms(hold.expires_at));
      assert.equal(decidedOnce(early.request).bookings, 1);
      const late = makeRequest({ jurisdiction: world.J.Y });
      await untilPast(holdOf(late.request).expires_at);
      const answers = await raceOf(
        await ownerSession("cc4-o"),
        "select public.scheduling_expiry_sweep()::text;",
        await attorneySession("cc4-b", world.ann),
        ACCEPT_SQL(late.request),
      );
      assert.ok(JSON.parse(answers.first).expired >= 1, answers.first);
      assert.equal(parseAccept(answers.second).outcome, "expired");
      assert.equal(holdOf(late.request).release_reason, "expired");
      assert.equal(requestStateOf(late.request), "expired");
      report.concurrency.acceptance_vs_hold_expiry = {
        sweep_during_acceptance: swept,
        hold_expiry_first: answers,
      };
      return report.concurrency.acceptance_vs_hold_expiry;
    },
  );

  await check(
    "CC-5 (TA section 14 B2) acceptance racing decline, in both orders: the second waits and answers already_decided (naming the first decision); one decision, its own Hold outcome, one audit event",
    async () => {
      const outcomes = {};
      for (const order of ["accept_first", "decline_first"]) {
        const s = makeRequest({ jurisdiction: world.J.B });
        const one = await attorneySession(`cc5-1-${order}`, world.ann);
        const two = await attorneySession(`cc5-2-${order}`, world.ann);
        const answers =
          order === "accept_first"
            ? await raceOf(
                one,
                ACCEPT_SQL(s.request),
                two,
                DECLINE_SQL(s.request),
              )
            : await raceOf(
                one,
                DECLINE_SQL(s.request),
                two,
                ACCEPT_SQL(s.request),
              );
        outcomes[order] = { answers, state: decidedOnce(s.request) };
      }
      assert.equal(outcomes.accept_first.answers.second, "already_decided");
      assert.deepEqual(
        [
          outcomes.accept_first.state.state,
          outcomes.accept_first.state.hold,
          outcomes.accept_first.state.accepted_audits,
          outcomes.accept_first.state.declined_audits,
        ],
        ["accepted", "converted", 1, 0],
      );
      assert.deepEqual(parseAccept(outcomes.decline_first.answers.second), {
        outcome: "already_decided",
        consultation: null,
        problem: "declined",
      });
      assert.deepEqual(
        [
          outcomes.decline_first.state.state,
          outcomes.decline_first.state.hold,
          outcomes.decline_first.state.consultations,
          outcomes.decline_first.state.declined_audits,
        ],
        ["declined", "released", 0, 1],
      );
      report.concurrency.acceptance_vs_decline = outcomes;
      return outcomes;
    },
  );

  await check(
    "CC-6 (MBS13-9; PM rows 33-34; INV-13) acceptance racing the provider's authorization webhook: (a) a redelivered authorization of an authorized, awaiting Request in both orders: the second waits; the capture is requested exactly once and the webhook answers stale; (b) the authorization that moves a Request to awaiting_attorney: webhook first, the waiting acceptance is accepted; acceptance first, it answers not_found (not yet offered) and the waiting webhook then applies",
    async () => {
      const outcomes = {};
      for (const order of ["accept_first", "webhook_first"]) {
        const s = authorizedRequest({
          jurisdiction: world.J.A,
          requestPath: "scheduled",
        });
        const event = EVENT_SQL(
          `evt_synthetic_cc6_${uid().slice(0, 8)}`,
          obs("authorization_confirmed", {
            payment_transaction_id: s.payment,
            payment_reference: s.reference,
            amount_minor: s.total,
            currency_code: "XTS",
          }),
        );
        const a = await attorneySession(`cc6-a-${order}`, world.ann);
        const w = await serviceSession(`cc6-w-${order}`);
        const answers =
          order === "accept_first"
            ? await raceOf(a, ACCEPT_SQL(s.request), w, event)
            : await raceOf(w, event, a, ACCEPT_SQL(s.request));
        const captures = Number(
          sql(
            `select count(*) from public.operational_jobs where job_type = 'payment.capture' and subject_id = '${s.payment}';`,
          ),
        );
        outcomes[order] = {
          answers,
          request: requestStateOf(s.request),
          payment: livePaymentOf(s.request).state,
          captures,
        };
        assert.equal(requestStateOf(s.request), "accepted");
        assert.equal(livePaymentOf(s.request).state, "capture_pending");
        assert.equal(captures, 1);
      }
      assert.equal(outcomes.accept_first.answers.second, "recorded|stale");
      assert.equal(outcomes.webhook_first.answers.first, "recorded|stale");
      const moving = {};
      for (const order of ["webhook_first", "accept_first"]) {
        const s = makeRequest({ jurisdiction: world.J.A });
        const created = authorize(s.client, s.request);
        runJob("payment.checkout", "payment_transaction", created.payment, () =>
          obs("checkout_open", { checkout_reference: checkoutRef() }),
        );
        const event = EVENT_SQL(
          `evt_synthetic_cc6b_${uid().slice(0, 8)}`,
          obs("authorization_confirmed", {
            payment_transaction_id: created.payment,
            payment_reference: paymentRef(),
            amount_minor: 5225,
            currency_code: "XTS",
          }),
        );
        const a = await attorneySession(`cc6b-a-${order}`, world.ann);
        const w = await serviceSession(`cc6b-w-${order}`);
        const answers =
          order === "webhook_first"
            ? await raceOf(w, event, a, ACCEPT_SQL(s.request))
            : await raceOf(a, ACCEPT_SQL(s.request), w, event);
        moving[order] = { answers, request: requestStateOf(s.request) };
      }
      assert.equal(moving.webhook_first.answers.first, "recorded|applied");
      assert.equal(
        parseAccept(moving.webhook_first.answers.second).outcome,
        "accepted",
      );
      assert.equal(moving.webhook_first.request, "accepted");
      assert.equal(
        parseAccept(moving.accept_first.answers.first).outcome,
        "not_found",
      );
      assert.equal(moving.accept_first.answers.second, "recorded|applied");
      assert.equal(moving.accept_first.request, "awaiting_attorney");
      report.concurrency.acceptance_vs_authorization_webhook = {
        redelivery: outcomes,
        moving,
      };
      return report.concurrency.acceptance_vs_authorization_webhook;
    },
  );

  await check(
    "CC-7 (DM section 2.5; PM INV-2: the quote stays immutable) acceptance racing the attorney changing the offer price, in both orders: the profile row lock serializes them (the second waits); the Request is accepted on its original Fee Calculation, unchanged byte for byte, the authorized amount is the quoted total, and the new price only applies to new Requests",
    async () => {
      const outcomes = {};
      for (const [order, price] of [
        ["offer_first", 6100],
        ["accept_first", 6200],
      ]) {
        const s = authorizedRequest({
          jurisdiction: world.J.A,
          requestPath: "scheduled",
        });
        const fee = rowOf(
          "fee_calculations",
          `consultation_request_id = '${s.request}'`,
        );
        const offer = await attorneySession(`cc7-o-${order}`, world.ann);
        const decide = await attorneySession(`cc7-a-${order}`, world.ann);
        const answers =
          order === "offer_first"
            ? await raceOf(
                offer,
                OFFER_SQL(price),
                decide,
                ACCEPT_SQL(s.request),
              )
            : await raceOf(
                decide,
                ACCEPT_SQL(s.request),
                offer,
                OFFER_SQL(price),
              );
        const acceptLine =
          order === "offer_first" ? answers.second : answers.first;
        const offerLine =
          order === "offer_first" ? answers.first : answers.second;
        assert.equal(parseAccept(acceptLine).outcome, "accepted");
        assert.equal(offerLine.split("|")[0], "replaced");
        assert.deepEqual(
          rowOf("fee_calculations", `consultation_request_id = '${s.request}'`),
          fee,
        );
        assert.equal(
          livePaymentOf(s.request).amount_authorized_minor,
          fee.total_client_amount_minor,
        );
        assert.equal(
          consultationOf(s.request).fee_policy_version_id,
          fee.fee_policy_version_id,
        );
        outcomes[order] = {
          answers,
          quoted_total: fee.total_client_amount_minor,
        };
      }
      assert.equal(
        asAttorney(world.ann, OFFER_SQL(5000)).split("|")[0],
        "replaced",
      );
      report.concurrency.acceptance_vs_offer_change = outcomes;
      return outcomes;
    },
  );

  await check(
    "CC-8 (PM rows 38-40; deadlock freedom between staff fact changes and the decision) acceptance racing a licence change that ends eligibility, in both orders: acceptance first, the change waits on the decision's FOR SHARE lock and then routes the new Consultation to review (rows 39-40); change first, the decision waits on the licence row and then ends the Request as not eligible (row 38), with the pending Request routed to review; no deadlock",
    async () => {
      const first = makeRequest({ jurisdiction: world.J.B, lawyer: world.hal });
      const licence = (lawyer) =>
        `update public.licenses set reported_status = 'synthetic-suspended' where attorney_id = '${lawyer.profile}';`;
      const acceptFirst = await raceOf(
        await attorneySession("cc8-a", world.hal),
        ACCEPT_SQL(first.request),
        await ownerSession("cc8-o"),
        licence(world.hal),
      );
      assert.equal(parseAccept(acceptFirst.first).outcome, "accepted");
      const consultation = consultationOf(first.request);
      assert.equal(
        reviewsOf("eligibility_change_review", consultation.id).length,
        1,
      );
      const second = makeRequest({
        jurisdiction: world.J.B,
        lawyer: world.ivy,
      });
      const changeFirst = await raceOf(
        await ownerSession("cc8-o2"),
        licence(world.ivy),
        await attorneySession("cc8-b", world.ivy),
        ACCEPT_SQL(second.request),
      );
      assert.equal(parseAccept(changeFirst.second).outcome, "not_eligible");
      assert.equal(requestStateOf(second.request), "cancelled");
      assert.equal(
        reviewsOf("eligibility_change_review", second.request).length,
        1,
      );
      report.concurrency.acceptance_vs_eligibility_change = {
        acceptFirst,
        changeFirst,
      };
      return report.concurrency.acceptance_vs_eligibility_change;
    },
  );

  await check(
    "CC-9 (deadlock freedom under mixed load; IMP section 11) six persistent autocommit sessions run 72 interleaved operations on twelve Requests of one attorney (acceptances and declines from two attorney sessions, withdrawals from the client, Request and Hold sweeps from the database owner, offer price changes from a third attorney session, and licence touches that run the review trigger): no deadlock (40P01) or lock timeout (55P03), every answer is a fixed outcome, and the invariants hold (each accepted Request has exactly one Consultation, one confirmed Booking and a converted Hold; each declined or withdrawn Request a released Hold and no Consultation; no two confirmed Bookings of the attorney overlap)",
    async () => {
      const client = newClient();
      const requests = Array.from(
        { length: 12 },
        () =>
          makeRequest({ jurisdiction: world.J.B, lawyer: world.gus, client })
            .request,
      );
      const deadlocksBefore = Number(
        sql(
          "select deadlocks from pg_stat_database where datname = current_database();",
        ),
      );
      let seedValue = 20261124;
      const random = (n) => {
        seedValue = (seedValue * 1103515245 + 12345) % 2147483648;
        return Math.floor(seedValue / 65536) % n;
      };
      const autocommit = async (label, role, account, aal) => {
        const s = await session(label);
        if (role !== null) {
          await s.ok(`set role ${role};`);
          await s.ok(
            `select set_config('request.jwt.claim.sub', ${lit(account.auth)}, false) is not null;`,
          );
          await s.ok(
            `select set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: account.auth, role, aal }))}, false) is not null;`,
          );
        }
        return s;
      };
      const plans = [
        [
          "att1",
          "authenticated",
          world.gus,
          "aal2",
          () =>
            (random(3) === 0 ? DECLINE_SQL : ACCEPT_SQL)(requests[random(12)]),
        ],
        [
          "att2",
          "authenticated",
          world.gus,
          "aal2",
          () =>
            (random(3) === 0 ? DECLINE_SQL : ACCEPT_SQL)(requests[random(12)]),
        ],
        [
          "cli",
          "authenticated",
          client,
          "aal1",
          () => WITHDRAW_SQL(requests[random(12)]),
        ],
        [
          "own",
          null,
          null,
          null,
          () =>
            random(2) === 0
              ? "select public.request_expiry_sweep()::text;"
              : "select public.scheduling_expiry_sweep()::text;",
        ],
        [
          "att3",
          "authenticated",
          world.gus,
          "aal2",
          () => OFFER_SQL(5000 + 100 * random(3)),
        ],
        [
          "fact",
          null,
          null,
          null,
          () =>
            `update public.licenses set reported_status = 'synthetic-active' where attorney_id = '${world.gus.profile}';`,
        ],
      ];
      const sessions = [];
      for (const [label, role, account, aal] of plans) {
        sessions.push(await autocommit(`cc9-${label}`, role, account, aal));
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
      const states = [...new Set(all.map((r) => r.sqlstate))];
      assert.deepEqual(
        states,
        ["00000"],
        JSON.stringify(all.filter((r) => r.sqlstate !== "00000")),
      );
      const answers = {};
      for (const r of all) {
        const key = r.answer.split("|")[0].replace(/^\{.*/, "sweep");
        answers[key] = (answers[key] ?? 0) + 1;
      }
      for (const key of Object.keys(answers)) {
        assert.ok(
          [
            "accepted",
            "already_decided",
            "declined",
            "withdrawn",
            "not_withdrawable",
            "expired",
            "sweep",
            "replaced",
            "unchanged",
            "",
          ].includes(key),
          key,
        );
      }
      const summary = {};
      for (const request of requests) {
        const state = decidedOnce(request);
        summary[state.state] = (summary[state.state] ?? 0) + 1;
        if (state.state === "accepted") {
          assert.deepEqual(
            [
              state.consultations,
              state.bookings,
              state.hold,
              state.accepted_audits,
            ],
            [1, 1, "converted", 1],
            request,
          );
        } else if (state.state === "declined" || state.state === "cancelled") {
          assert.deepEqual(
            [state.consultations, state.hold],
            [0, "released"],
            request,
          );
        } else {
          assert.equal(state.state, "awaiting_attorney", request);
        }
      }
      assert.equal(
        sql(
          `select count(*) from public.bookings a join public.bookings b on a.id < b.id and a.attorney_id = b.attorney_id where a.attorney_id = '${world.gus.profile}' and a.status = 'confirmed' and b.status = 'confirmed' and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)');`,
        ),
        "0",
      );
      sql("select pg_stat_force_next_flush();");
      const deadlocksAfter = Number(
        sql(
          "select deadlocks from pg_stat_database where datname = current_database();",
        ),
      );
      assert.equal(deadlocksAfter, deadlocksBefore);
      assert.equal(
        asAttorney(world.gus, OFFER_SQL(5000)).split("|")[0].length > 0,
        true,
      );
      report.concurrency.mixed_load = {
        operations: all.length,
        answers,
        requests: summary,
        deadlocks: deadlocksAfter - deadlocksBefore,
      };
      return report.concurrency.mixed_load;
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
    world.quoteScenario = makeRequest({ jurisdiction: world.J.Q });
    await migrationChecks();
    await configurationChecks();
    await acceptanceChecks();
    await revalidationChecks();
    await declineChecks();
    await expiryChecks();
    await integrityChecks();
    await accessChecks();
    await reviewChecks();
    await productionChecks();
    await quoteExpiryCheck();
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
