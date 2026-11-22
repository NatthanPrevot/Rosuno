// MVP-001 S11 disposable PostgreSQL proof (M13 Completion / Reviews /
// Complaint foundation / Operations, pass 1).
// Explicitly invoked only:
//
//   node apps/web/tests/mvp-001-s11-db-proof.mjs
//
// Deliberately not a *.test.mjs file, so no application test run, p0:test,
// or CI job starts it. It uses Node built-ins and the system-installed
// PostgreSQL 16 initdb, pg_ctl, and psql binaries.
//
// It creates a new mode-0700 temporary directory, initializes a new cluster
// owned by an unprivileged account (never root), and starts it with TCP
// disabled and a private Unix-domain socket (port 54347, so it can run next
// to the MVP-001 S10 proof). The roles anon, authenticated, and service_role
// (BYPASSRLS), the synthetic auth schema (auth.users with the identity
// provider's email column, and an auth.uid() that reads
// request.jwt.claim.sub), the hosted platform's default privileges, and a
// no-op public.rls_auto_enable() are synthetic objects of this cluster only.
// Every migration is applied unmodified, in order, each in one transaction,
// to two databases: the main database records its environment as
// development; a second one records production (a synthetic 20-letter
// project reference) for the production gate probes. The seven S11
// migrations must follow S10 and be registered.
//
// Configuration: every policy version of the development database is
// development configuration created by the owner role inside this disposable
// cluster (Packet rule 9). The payment flows (capture at the consultation
// start, at its completion or at the attorney's acceptance; authorization
// before the decision or only after it), the S9 timing keys (present, or
// absent for the fail-safe window rule), the engagement parameters, the XTS
// test currency, the synthetic modality, the SYN_* Regulatory Mode and every
// Request, payment, review, complaint, hold reason, address (on the reserved
// .invalid domain), provider reference and event is synthetic test data
// (FP-1 section 3.4), never a product value or decision. No cancellation
// threshold, refund entitlement, no-show treatment, complaint vocabulary or
// moderation rule is configured anywhere: the probes show that none is
// assumed. The production database uses owner-walked authority versions with
// a synthetic verified reference, or development rows planted with triggers
// bypassed for the negative probes; its Consultation fixtures are planted by
// the owner with triggers bypassed (the production gate, not the fixture, is
// what the probes examine).
//
// The providers are simulated: the probes play the worker (claim a job as
// the owner, read its context and record each provider call as service_role,
// report the job) and the webhook routes (payment_record_provider_event and
// media_record_provider_event as service_role). No provider, Supabase
// project, network service or pre-existing cluster is contacted, and nothing
// persists after the run. Some probes shift a Consultation's recorded
// creation, start or Booking into the past as the owner with triggers
// bypassed (the proof cannot wait for a permitted window to end), or plant a
// state no command produces at commit; each says so.
//
// Request sessions are modelled as PostgREST sets them from a verified JWT:
// request.jwt.claim.sub and the JSON request.jwt.claims (clients at aal1,
// attorneys and staff at aal2 unless a probe says otherwise); anonymous
// requests run as anon without a subject.
//
// The probes cover the MVP-001 Packet S11 acceptance for the database parts
// of pass 1: the completion types with their Payment Matrix distinctions
// (PM rows 11 to 22), the five MBS section 16 failure tests (labelled
// MBS16-1 to MBS16-5), the reviews relation and the server-qualified review
// flow, the complaint foundation (PM row 47), Legal Holds and their coverage
// (PM row 48), the review exception families, the S11 notification events,
// privileges, audit minimization, production-class behaviour, and the race
// list under real concurrency with two or more persistent sessions, with the
// exact observed outcomes. The JSON report goes to stdout; exit 0 means
// PASS, 1 FAIL, 2 cleanup failure.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54347;
const DB = "rosuno_s11_proof";
const PROD_DB = "rosuno_s11_proof_production";
const PRODUCTION_REF = "syntheticelevenprodr";
const REPOSITORY_ROOT = path.resolve(
  path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
  "../../..",
);
const MIGRATIONS = path.join(REPOSITORY_ROOT, "supabase/migrations");
const S10_LAST = "20261126050000_mvp_001_s10_document_versioning.sql";
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
// follow (applied by this proof as later registered migrations; registered
// and checked by the S11 operations proof).
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
// MVP-001 S11 PS-A6: the break-glass, data request and complaint
// configuration migrations follow the review corrections (registered and
// checked by the S11 PS-A6 proof).
const S11_PS_A6_MIGRATIONS = Object.freeze([
  "20261127190000_mvp_001_s11_break_glass.sql",
  "20261127200000_mvp_001_s11_data_requests.sql",
  "20261127210000_mvp_001_s11_complaint_configuration.sql",
]);
// The one migration that inserts catalog rows (the five capability codes) and
// the one that creates a relation (the PS section 21.1 reviews relation).
const S11_INTEGRITY = "20261127010000_mvp_001_s11_completion_integrity.sql";
const S11_REVIEWS = "20261127040000_mvp_001_s11_reviews.sql";

const report = {
  proof: "MVP-001 S11 disposable local PostgreSQL proof",
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
    path.join(os.tmpdir(), "rosuno-mvp-001-s11-db-proof-"),
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
    if (S11_MIGRATIONS.includes(file)) {
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
  // S11 follows S10, contiguous and in order, and every S11 migration is
  // registered unreviewed (sequences 55 to 61, each depending on the one
  // before it) and applied nowhere.
  const s10 = files.indexOf(S10_LAST);
  assert.ok(s10 >= 0, "the last S10 migration is present");
  assert.deepEqual(files.slice(s10 + 1), [
    ...S11_MIGRATIONS,
    ...S11_OPERATIONS_MIGRATIONS,
    ...S11_SURFACES_MIGRATIONS,
    ...S11_CORRECTIONS_MIGRATIONS,
    ...S11_PS_A6_MIGRATIONS,
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
  S11_MIGRATIONS.forEach((file, index) => {
    const id = file.replace(/\.sql$/, "");
    const row = registered.find(
      (migration) => migration.artifact_path === `supabase/migrations/${file}`,
    );
    assert.ok(row, `${file} is registered`);
    assert.equal(row.migration_id, id);
    assert.equal(row.sequence, 55 + index);
    assert.equal(row.reviewed, false);
    assert.equal(row.applied_environment, "none");
    assert.deepEqual(row.depends_on, [
      (index === 0 ? S10_LAST : S11_MIGRATIONS[index - 1]).replace(
        /\.sql$/,
        "",
      ),
    ]);
    assert.ok(
      typeof row.rollback_plan === "string" && row.rollback_plan !== "",
    );
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
  report.migrations.s11 = [...S11_MIGRATIONS];
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
    const mark = `__S11_${this.label}_${this.n}__`;
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

// Waits until one backend is blocked by a specific other backend.
async function blockedBy(pid, blocker) {
  for (let i = 0; i < 400; i += 1) {
    if (sql(`select ${blocker} = any (pg_blocking_pids(${pid}));`) === "t") {
      return true;
    }
    await sleep(25);
  }
  throw new Error(`backend ${pid} never waited for backend ${blocker}`);
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
    process.stderr.write(`[s11-proof] PASS ${name}\n`);
  } catch (error) {
    failed = true;
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
    process.stderr.write(
      `[s11-proof] FAIL ${name}\n${error?.stack ?? error}\n`,
    );
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
      `insert into public.licenses (id, attorney_id, jurisdiction_id, license_number, reported_status) values ('${licence}', '${profile}', '${jurisdiction}', 'SYN-S11-LIC-${String(licenceNumber).padStart(4, "0")}', 'synthetic-active');
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
    `update public.operational_jobs set state = 'running', locked_at = now(), locked_by = 's11-proof', attempt_count = attempt_count + 1, available_at = now() + interval '60 seconds' where id = '${jobId}';`,
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
    `select public.job_complete('${jobId}', 's11-proof');`,
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
// S8 to S11 configuration, seed and call helpers
// ---------------------------------------------------------------------------

// The engagement parameters (G-5, G-1) with, where given, the S10
// post-consultation message window (synthetic test values).
const ENGAGEMENT = (creation, effective, window) => ({
  consultation_creation: creation,
  engagement_effective: effective,
  ...(window === undefined
    ? {}
    : { post_consultation_message_window_seconds: window }),
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

// The synthetic configuration of each jurisdiction (test values only; G-1 to
// G-5, the S9 timing keys and every threshold stay configuration).
const STANDARD_FLOW = FLOW_ALL(BEFORE, "at_consultation_start");
const STANDARD_SCHEDULING = SCHEDULING({ ...TIMING(600, 300), ...NEAR });
const STANDARD_ENGAGEMENT = ENGAGEMENT(
  "attorney_acceptance",
  "at_consultation_start",
  3600,
);
const JURISDICTIONS = Object.freeze({
  // Capture at the consultation start (the S9 and S10 proofs' flow): an
  // accepted Consultation that has not started holds an authorization.
  S: {
    flow: STANDARD_FLOW,
    engagement: STANDARD_ENGAGEMENT,
    scheduling: STANDARD_SCHEDULING,
  },
  // Capture at the consultation's completion: a live Consultation still
  // holds an authorization (PM rows 20 and 21).
  C: {
    flow: FLOW_ALL(BEFORE, "at_consultation_completion"),
    engagement: STANDARD_ENGAGEMENT,
    scheduling: STANDARD_SCHEDULING,
  },
  // Capture at the attorney's acceptance: the funds are captured before the
  // Consultation starts.
  A: {
    flow: FLOW_ALL(BEFORE, "at_attorney_acceptance"),
    engagement: STANDARD_ENGAGEMENT,
    scheduling: STANDARD_SCHEDULING,
  },
  // A scheduled Request is authorized only after the acceptance: an accepted
  // scheduled Consultation exists without any payment attempt.
  P: {
    flow: FLOW(BEFORE, AT_ACCEPTANCE, "at_consultation_start"),
    engagement: STANDARD_ENGAGEMENT,
    scheduling: STANDARD_SCHEDULING,
  },
  // No S9 timing keys: the permitted window cannot be computed, so staff
  // outcome recording uses the fail-safe window rule.
  F: {
    flow: STANDARD_FLOW,
    engagement: STANDARD_ENGAGEMENT,
    scheduling: SCHEDULING(NEAR),
  },
});

function seed() {
  world.mode = newRegulatoryMode("SYN_S11_MARKETPLACE");
  world.J = {};
  world.policies = {};
  world.policies.bookability = policy("bookability", null, {
    presence_window_seconds: 600,
  });
  world.platform = policy("fee", null, PLATFORM);
  for (const [key, config] of Object.entries(JURISDICTIONS)) {
    const id = newJurisdiction(`SYN_S11_${key}`);
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
  seedStaff();
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
  const id = newJurisdiction(`SYN_S11_PROD_${key}`, PROD_DB, "ready");
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

// ---------------------------------------------------------------------------
// S10 helpers
// ---------------------------------------------------------------------------

let addresses = 0;
// A synthetic address on the reserved .invalid domain for an account's
// identity-provider row (never reported).
function withAddress(account, db = DB) {
  addresses += 1;
  sql(
    `update auth.users set email = ${lit(`recipient-${addresses}-${account.auth.slice(0, 8)}@synthetic.invalid`)} where id = '${account.auth}';`,
    db,
  );
  return account;
}

const addressOf = (account) =>
  sql(`select email from auth.users where id = '${account.auth}';`);

// A ready instant Consultation (S6 to S8), live through the attorney's start
// (S9), and completed through the attorney's end (S9).
function readyConsultation(key) {
  const who = lawyer(key);
  const s = acceptedConsultation({ key, who });
  assert.ok(s.consultation, "a ready Consultation");
  return s;
}

function liveConsultation(key) {
  const s = readyConsultation(key);
  const started = start(s);
  assert.equal(started.outcome, "started", JSON.stringify(started));
  return s;
}

function completedConsultation(key) {
  const s = liveConsultation(key);
  const ended = end(s);
  assert.equal(ended.outcome, "completed", JSON.stringify(ended));
  return s;
}

// Fixture changes as the owner with triggers bypassed (each probe says why):
// a completed Consultation's recorded creation, start and end move into the
// past together (the proof cannot wait for a window to close).
function shiftEnded(consultation, seconds) {
  sql(
    `begin;
     set local session_replication_role = replica;
     update public.consultations set created_at = created_at - interval '${seconds} seconds', started_at = started_at - interval '${seconds} seconds', ended_at = ended_at - interval '${seconds} seconds' where id = '${consultation}';
     commit;`,
  );
}

function plantState(consultation, state) {
  sql(
    `begin;
     set local session_replication_role = replica;
     update public.consultations set state = '${state}', ended_at = coalesce(ended_at, now()) where id = '${consultation}';
     commit;`,
  );
}

function plantEngagement(consultation, version) {
  sql(
    `begin;
     set local session_replication_role = replica;
     update public.consultations set engagement_policy_version_id = ${version === null ? "null" : `'${version}'`} where id = '${consultation}';
     commit;`,
  );
}

const SEND_SQL = (c, body) =>
  `select outcome || '|' || coalesce(message_id::text, '') from public.message_send(${lit(c)}, ${lit(body)});`;

function sendAs(account, consultation, body, options = {}) {
  const line = as(
    "authenticated",
    account.auth,
    SEND_SQL(consultation, body),
    options,
  );
  if (line.startsWith("ERROR")) {
    return { outcome: line, message: null };
  }
  const [outcome, message] = line.split("|");
  return { outcome, message: message || null };
}

const clientSend = (s, body) =>
  sendAs(s.client, s.consultation, body, { aal: "aal1" });
const attorneySend = (s, body, options = {}) =>
  sendAs(s.lawyer, s.consultation, body, options);

function rowsJson(account, statement, options = {}) {
  return rowsAs("authenticated", account.auth, statement, options).map((r) =>
    JSON.parse(r),
  );
}

const messagesAs = (account, c, options = {}) =>
  rowsJson(
    account,
    `select row_to_json(x)::text from public.consultation_messages(${lit(c)}) x;`,
    options,
  );

const messagingAs = (account, c, options = {}) =>
  oneRowAs(
    account,
    `select row_to_json(x)::text from public.consultation_messaging(${lit(c)}) x;`,
    options,
  );

const digestValue = () => `sha256:${sha256(uid())}`;

function beginDocument(
  account,
  consultation,
  options = {},
  { mime = "application/pdf", size = 2048, digest = digestValue() } = {},
) {
  const line = as(
    "authenticated",
    account.auth,
    `select outcome || '|' || coalesce(resource_id::text, '') from public.document_begin_upload(${lit(consultation)}, ${lit(mime)}, ${size === null ? "null" : size}, ${lit(digest)});`,
    options,
  );
  if (line.startsWith("ERROR")) {
    return { outcome: line, resource: null };
  }
  const [outcome, resource] = line.split("|");
  return { outcome, resource: resource || null };
}

const finalizeAs = (account, resource, options = {}) =>
  as(
    "authenticated",
    account.auth,
    `select public.resource_finalize_upload(${lit(resource)});`,
    options,
  );

const abandonAs = (account, resource, options = {}) =>
  as(
    "authenticated",
    account.auth,
    `select public.resource_abandon_upload(${lit(resource)});`,
    options,
  );

// A document uploaded through the real pipeline (begin, then completion; this
// plain PostgreSQL has no storage schema, so no object is checked).
function uploadDocument(account, consultation, options = {}) {
  const begun = beginDocument(account, consultation, options);
  assert.equal(begun.outcome, "created", JSON.stringify(begun));
  assert.equal(finalizeAs(account, begun.resource, options), "available");
  return begun.resource;
}

const clientOptions = Object.freeze({ aal: "aal1" });

// PS-A5 versioning (the replacement flow and the history read).
const documentIdOf = (resource) =>
  sql(`select id from public.documents where resource_id = '${resource}';`);

// The Consultation a Document or resource belongs to (the replacement calls
// name it; a probe may name another one).
const consultationOfDocument = (document) =>
  sql(
    `select r.consultation_id from public.documents d join public.resources r on r.id = d.resource_id where d.id = ${lit(document)};`,
  ) || uid();
const consultationOfResource = (resource) =>
  sql(
    `select consultation_id from public.resources where id = ${lit(resource)};`,
  ) || uid();

function beginReplacement(
  account,
  document,
  options = {},
  {
    mime = "application/pdf",
    size = 3072,
    digest = digestValue(),
    consultation = consultationOfDocument(document),
  } = {},
) {
  const line = as(
    "authenticated",
    account.auth,
    `select outcome || '|' || coalesce(resource_id::text, '') from public.document_begin_replacement(${lit(consultation)}, ${lit(document)}, ${lit(mime)}, ${size === null ? "null" : size}, ${lit(digest)});`,
    options,
  );
  if (line.startsWith("ERROR")) {
    return { outcome: line, resource: null };
  }
  const [outcome, resource] = line.split("|");
  return { outcome, resource: resource || null };
}

const FINALIZE_REPLACEMENT_SQL = (
  resource,
  document,
  consultation = consultationOfResource(resource),
) =>
  `select public.document_finalize_replacement(${lit(consultation)}, ${lit(resource)}, ${lit(document)});`;

const finalizeReplacementAs = (
  account,
  resource,
  document,
  options = {},
  consultation = consultationOfResource(resource),
) =>
  as(
    "authenticated",
    account.auth,
    FINALIZE_REPLACEMENT_SQL(resource, document, consultation),
    options,
  );

// A new version through the real replacement flow: begin, then completion.
// Answers the new resource and Document ids.
function replaceDocument(account, document, options = {}) {
  const begun = beginReplacement(account, document, options);
  assert.equal(begun.outcome, "created", JSON.stringify(begun));
  assert.equal(
    finalizeReplacementAs(account, begun.resource, document, options),
    "available",
  );
  return { resource: begun.resource, document: documentIdOf(begun.resource) };
}

const versionsAs = (account, consultation, document, options = {}) =>
  rowsJson(
    account,
    `select row_to_json(x)::text from public.document_versions(${lit(consultation)}, ${lit(document)}) x;`,
    options,
  );

const documentRow = (document) => rowOf("documents", `id = '${document}'`);

function authorizeAs(account, resource, options = {}, kind = "document") {
  return as(
    account === null ? "authenticated" : "authenticated",
    account === null ? null : account.auth,
    `select outcome || '|' || coalesce(object_path, '') from public.resource_authorize_access(${lit(resource)}, ${lit(kind)});`,
    options,
  );
}

const revokeAs = (account, resource, options = {}) =>
  as(
    "authenticated",
    account.auth,
    `select public.document_revoke_sharing(${lit(resource)});`,
    options,
  );

const documentsAs = (account, c, options = {}) =>
  rowsJson(
    account,
    `select row_to_json(x)::text from public.consultation_documents(${lit(c)}) x;`,
    options,
  );

const objectPath = (resource) => `resources/${resource}/original`;

function notificationsOf(user, where = "true") {
  return jsonOf(
    `select coalesce(json_agg(json_build_object('id', id, 'type', notification_type, 'source_event_type', source_event_type, 'source_event_id', source_event_id, 'channel', channel, 'state', state, 'critical', critical, 'ack_required', ack_required, 'sent', sent_at is not null, 'delivered', delivered_at is not null, 'failed', failed_at is not null) order by created_at, channel desc, id), '[]'::json)::text from public.notifications where recipient_user_id = '${user}' and ${where};`,
  );
}

function emailNotification(user, type, source) {
  return rowOf(
    "notifications",
    `recipient_user_id = '${user}' and channel = 'email' and notification_type = ${lit(type)} and source_event_id = '${source}'`,
  );
}

function inAppNotification(user, type, source) {
  return rowOf(
    "notifications",
    `recipient_user_id = '${user}' and channel = 'in_app' and notification_type = ${lit(type)} and source_event_id = '${source}'`,
  );
}

const deliveryJob = (notification) =>
  openJob("notification.deliver", "notification", notification);

function jobRow(jobId) {
  return rowOf("operational_jobs", `id = '${jobId}'`);
}

function notificationContext(jobId) {
  return JSON.parse(
    as(
      "service_role",
      null,
      `select row_to_json(c)::text from public.notification_job_context('${jobId}') c;`,
    ),
  );
}

function recordAttempt(jobId, result, reference = null, failure = null) {
  return as(
    "service_role",
    null,
    `select public.notification_record_attempt('${jobId}', 'synthetic_mail', ${lit(result)}, ${lit(reference)}, ${lit(failure)});`,
  );
}

const failJob = (jobId) =>
  as(
    "service_role",
    null,
    `select public.job_fail('${jobId}', 's11-proof', 'handler_failed', 'The job handler reported a failure.');`,
  );

// The due time of a pending job moves to now (the only change a pending job
// admits), so the probe need not wait for the S2 backoff.
const dueNow = (jobId) =>
  sql(
    `update public.operational_jobs set available_at = now() where id = '${jobId}' and state = 'pending';`,
  );

const providerReference = () => uid();

let notificationEvents = 0;
const NOTIFICATION_EVENT_SQL = (eventId, eventType, observation) =>
  `select outcome || '|' || coalesce(processing_state, '') from public.notification_record_provider_event('synthetic_mail', ${lit(eventId)}, ${lit(eventType)}, now(), ${lit(`sha256:${sha256(eventId)}`)}, ${lit(observation)}::jsonb);`;

// The probe plays the webhook route: one authenticated provider event.
function notificationEvent(eventType, observation, eventId = null) {
  notificationEvents += 1;
  const id =
    eventId ?? `msg_${sha256(`${notificationEvents}-${uid()}`).slice(0, 27)}`;
  const line = as(
    "service_role",
    null,
    NOTIFICATION_EVENT_SQL(id, eventType, observation),
  );
  const [outcome, processing] = line.split("|");
  return { id, outcome, processing, line };
}

// The probe plays the webhook route with an explicit provider event time (a
// SQL expression), so events can arrive out of their provider order.
function notificationEventAt(eventType, observation, occurredAtSql) {
  notificationEvents += 1;
  const id = `msg_${sha256(`${notificationEvents}-${uid()}`).slice(0, 27)}`;
  const line = as(
    "service_role",
    null,
    `select outcome || '|' || coalesce(processing_state, '') from public.notification_record_provider_event('synthetic_mail', ${lit(id)}, ${lit(eventType)}, ${occurredAtSql}, ${lit(`sha256:${sha256(id)}`)}, ${lit(observation)}::jsonb);`,
  );
  const [outcome, processing] = line.split("|");
  return { id, outcome, processing, line };
}

// An approved engagement version (owner-walked to approved, never active, so
// never selected) whose window is written as raw JSON text: jsonb keeps a
// number's own text (3600.0 stays 3600.0). Synthetic test configuration.
function approvedEngagement(windowText) {
  const id = uid();
  const raw = `{"consultation_creation": "attorney_acceptance", "engagement_effective": "at_consultation_start", "post_consultation_message_window_seconds": ${windowText}}`;
  sql(
    `insert into public.policy_versions (id, policy_type_code, jurisdiction_id, regulatory_mode_id, version_label, parameters, status, effective_from, development_only)
     values ('${id}', 'engagement', ${lit(world.J.W)}, ${lit(world.mode)}, ${lit(`synthetic-approved-engagement-${id.slice(0, 8)}`)}, ${lit(raw)}::jsonb, 'draft', now() - interval '1 day', false);
     insert into public.policy_authority_references (policy_version_id, authority_type, citation_text, source_title, retrieved_at, verified_by_user_id, verification_status)
       values ('${id}', 'synthetic', 'synthetic citation', 'synthetic source', now(), '${world.grantor.user}', 'verified');
     update public.policy_versions set status = 'internal_review' where id = '${id}';
     update public.policy_versions set status = 'counsel_review' where id = '${id}';
     update public.policy_versions set status = 'approved', approved_at = now() - interval '2 days', approved_by_user_id = '${world.grantor.user}' where id = '${id}';`,
  );
  return id;
}

// One email Notification delivered through the worker protocol: claimed,
// its context read, the provider's acceptance recorded, the job completed.
function deliverAccepted(notification) {
  const job = deliveryJob(notification);
  assert.ok(job, "an open delivery job");
  claimJob(job);
  const context = notificationContext(job);
  assert.equal(context.outcome, "act", JSON.stringify(context));
  const reference = providerReference();
  assert.equal(recordAttempt(job, "accepted", reference), "sent");
  assert.equal(completeJob(job), "completed");
  return { job, reference };
}

const attemptsOf = (notification) =>
  jsonOf(
    `select coalesce(json_agg(json_build_object('provider_code', provider_code, 'reference', provider_reference is not null, 'result', result, 'failure_code', failure_code) order by attempted_at, id), '[]'::json)::text from public.notification_attempts where notification_id = '${notification}';`,
  );

const notificationAudits = (notification) =>
  jsonOf(
    `select coalesce(json_agg(json_build_object('action', action_code, 'actor_type', actor_type, 'reason', reason_code, 'after', after_snapshot) order by occurred_at, id), '[]'::json)::text from public.audit_events where resource_type = 'notification' and resource_id = '${notification}';`,
  );

const exceptionsFor = (notification) =>
  jsonOf(
    `select coalesce(json_agg(json_build_object('exception_type', exception_type, 'severity', severity, 'status', status, 'source_type', source_type, 'evidence', evidence_reference) order by detected_at, id), '[]'::json)::text from public.reconciliation_exceptions where source_type = 'notification' and source_id = '${notification}';`,
  );

const centerAs = (account, options = {}) =>
  rowsJson(
    account,
    "select row_to_json(x)::text from public.notification_center() x;",
    options,
  );

const acknowledgeAs = (account, notification, options = {}) =>
  as(
    "authenticated",
    account.auth,
    `select public.notification_acknowledge(${lit(notification)});`,
    options,
  );

// The development notification configuration of a probe (Packet rule 9):
// created by the owner, and closed (its one permitted change) when the probe
// ends so later probes see none.
function notificationPolicy(parameters) {
  return policy("notification", null, parameters);
}

function closePolicy(version) {
  sql(
    `update public.policy_versions set effective_until = now() where id = '${version}';`,
  );
}

const deltaOf = (before, after) =>
  Object.fromEntries(
    Object.keys(before)
      .map((key) => [key, after[key] - before[key]])
      .filter(([, value]) => value !== 0),
  );

const auditsFor = (resourceType, resourceId) =>
  jsonOf(
    `select coalesce(json_agg(json_build_object('action', action_code, 'actor_type', actor_type, 'actor_user_id', actor_user_id, 'after', after_snapshot, 'before', before_snapshot, 'policy_references', policy_references) order by occurred_at, id), '[]'::json)::text from public.audit_events where resource_type = ${lit(resourceType)} and resource_id = '${resourceId}';`,
  );

// ---------------------------------------------------------------------------
// S11 helpers
// ---------------------------------------------------------------------------

// A staff member (an active Staff Profile) holding the given capability
// grants: [capability, jurisdiction id or null for a global grant].
function staffWith(...grants) {
  const account = newAccount();
  sql(
    [
      `insert into public.staff_profiles (user_id, staff_state) values ('${account.user}', 'active');`,
      ...grants.map(
        ([capability, jurisdiction]) =>
          `insert into public.capability_grants (user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at) values ('${account.user}', '${capability}', '${world.grantor.user}', ${lit(jurisdiction)}, now() - interval '1 day');`,
      ),
    ].join("\n"),
  );
  return account;
}

function seedStaff() {
  world.ops = staffWith(["manage_consultation_operations", null]);
  world.opsS = staffWith(["manage_consultation_operations", world.J.S]);
  world.moderator = staffWith(["moderate_reviews", null]);
  world.moderatorS = staffWith(["moderate_reviews", world.J.S]);
  world.complaints = staffWith(["manage_complaints", null]);
  world.complaintsS = staffWith(["manage_complaints", world.J.S]);
  world.holds = staffWith(["manage_legal_holds", null]);
  world.holdsS = staffWith(["manage_legal_holds", world.J.S]);
  world.finance = staffWith(["manage_financial_operations", null]);
  world.compliance = staffWith(["manage_compliance_reviews", null]);
  world.plainStaff = staffWith();
}

const AAL1 = Object.freeze({ aal: "aal1" });

const CANCEL_SQL = (c) =>
  `select row_to_json(x)::text from public.consultation_cancel(${lit(c)}) x;`;
const EARLY_SQL = (c) =>
  `select row_to_json(x)::text from public.consultation_end_early(${lit(c)}) x;`;
const OUTCOME_SQL = (c, code, acknowledge = false) =>
  `select row_to_json(x)::text from public.staff_record_consultation_outcome(${lit(c)}, ${lit(code)}, ${acknowledge ? "true" : "false"}) x;`;
const REVIEW_SQL = (c, rating, text) =>
  `select outcome || '|' || coalesce(review_id::text, '') from public.review_submit(${lit(c)}, ${rating === null ? "null" : rating}, ${text === null ? "null::text" : lit(text)});`;
const MODERATE_SQL = (review, decision) =>
  `select public.staff_moderate_review(${lit(review)}, ${lit(decision)});`;
const COMPLAINT_SQL = (consultation, referral) =>
  `select outcome || '|' || coalesce(complaint_case_id::text, '') from public.complaint_open(${consultation === null ? "null::uuid" : lit(consultation)}, ${referral === null ? "null::uuid" : lit(referral)});`;
const COMPLAINT_UPDATE_SQL = (id, action) =>
  `select public.staff_update_complaint(${lit(id)}, ${lit(action)});`;
const PLACE_HOLD_SQL = (type, id, reason) =>
  `select outcome || '|' || coalesce(legal_hold_id::text, '') from public.staff_place_legal_hold(${lit(type)}, ${lit(id)}, ${lit(reason)});`;
const RELEASE_HOLD_SQL = (id) =>
  `select public.staff_release_legal_hold(${lit(id)});`;

const clientCancel = (s) => jsonAs(s.client, CANCEL_SQL(s.consultation), AAL1);
const attorneyCancel = (s, options = {}) =>
  jsonAs(s.lawyer, CANCEL_SQL(s.consultation), options);
const endEarly = (s, options = {}) =>
  jsonAs(s.lawyer, EARLY_SQL(s.consultation), options);
const recordOutcome = (
  staff,
  consultation,
  code,
  acknowledge = false,
  options = {},
) => jsonAs(staff, OUTCOME_SQL(consultation, code, acknowledge), options);
const asStaff = (staff, statement, options = {}) =>
  as("authenticated", staff.auth, statement, options);

function submitReview(account, consultation, rating, text, options = AAL1) {
  const [outcome, review] = as(
    "authenticated",
    account.auth,
    REVIEW_SQL(consultation, rating, text),
    options,
  ).split("|");
  return { outcome, review: review || null };
}

function openComplaint(
  account,
  { consultation = null, referral = null } = {},
  options = {},
) {
  const line = as(
    "authenticated",
    account.auth,
    COMPLAINT_SQL(consultation, referral),
    options,
  );
  const [outcome, id] = line.split("|");
  return { outcome, id: id || null };
}

function placeHold(staff, type, id, reason = "Synthetic hold reason") {
  const [outcome, hold] = asStaff(
    staff,
    PLACE_HOLD_SQL(type, id, reason),
  ).split("|");
  return { outcome, hold: hold || null };
}

const releaseHold = (staff, hold, options = {}) =>
  asStaff(staff, RELEASE_HOLD_SQL(hold), options);

// A scheduled Consultation accepted through the real S6 to S8 paths (state
// scheduled, with its confirmed Booking and, where the flow authorizes
// before the decision, its authorized payment).
function scheduledConsultation(key, { slot = null, who = null } = {}) {
  const s = acceptedConsultation({
    key,
    requestPath: "scheduled",
    who: who ?? lawyer(key),
    slot,
  });
  assert.ok(s.consultation, "a scheduled Consultation");
  return s;
}

// A scheduled Consultation without any payment attempt (jurisdiction P: the
// authorization only follows the acceptance and the client has not started
// it).
function unpaidScheduledConsultation() {
  const who = lawyer("P");
  const s = makeRequest({
    jurisdiction: world.J.P,
    requestPath: "scheduled",
    lawyer: who,
  });
  const decision = accept(who, s.request);
  assert.equal(decision.outcome, "accepted", JSON.stringify(decision));
  assert.equal(livePaymentOf(s.request), null);
  return { ...s, lawyer: who, consultation: decision.consultation };
}

// A live Consultation whose capture at the start (jurisdictions S, P and F)
// has been confirmed by the provider.
function liveCaptured(key) {
  const s = liveConsultation(key);
  if (livePaymentOf(s.request).state === "capture_pending") {
    confirmCapture(s);
  }
  return s;
}

// Fixture time shift (owner, triggers bypassed): a scheduled Consultation's
// Booking moves into the past with its creation and start, because the proof
// cannot wait for a booked slot to pass.
function shiftScheduled(consultation, minutes) {
  sql(
    `begin;
     set local session_replication_role = replica;
     update public.bookings set starts_at = starts_at - interval '${minutes} minutes', ends_at = ends_at - interval '${minutes} minutes', created_at = created_at - interval '${minutes} minutes' where consultation_id = '${consultation}';
     update public.consultations set created_at = created_at - interval '${minutes} minutes', started_at = started_at - interval '${minutes} minutes' where id = '${consultation}';
     commit;`,
  );
}

// An instant Consultation whose permitted window (30 minutes plus the
// 300-second overrun of the synthetic timing keys) has ended: its recorded
// creation and start move 36 minutes into the past.
const PAST_WINDOW_MINUTES = 36;

function staleReady(key) {
  const s = readyConsultation(key);
  shiftConsultation(s.consultation, PAST_WINDOW_MINUTES);
  return s;
}

function staleLive(key, { captured = true } = {}) {
  const s = captured ? liveCaptured(key) : liveConsultation(key);
  shiftConsultation(s.consultation, PAST_WINDOW_MINUTES);
  return s;
}

// The probe plays the media webhook: one provider session of the
// Consultation's room and the given participants' joins (and departures).
function observeParticipants(s, roles, { left = [] } = {}) {
  const room = roomOf(s.consultation);
  const started = mediaEvent("meeting.started", {
    kind: "meeting_started",
    room_name: roomName(room.id),
    session_reference: sessionRef(),
    started_at: isoAgo(8),
  });
  assert.equal(started.processing, "applied", started.line);
  for (const role of roles) {
    const reference = participantRef();
    const user = role === "client" ? s.client.user : s.lawyer.user;
    const joined = mediaEvent("participant.joined", {
      kind: "participant_joined",
      room_name: roomName(room.id),
      participant_reference: reference,
      user_id: user,
      joined_at: isoAgo(6),
    });
    assert.equal(joined.processing, "applied", joined.line);
    if (left.includes(role)) {
      const gone = mediaEvent("participant.left", {
        kind: "participant_left",
        room_name: roomName(room.id),
        participant_reference: reference,
        user_id: user,
        joined_at: isoAgo(6),
        left_at: isoAgo(2),
      });
      assert.equal(gone.processing, "applied", gone.line);
    }
  }
}

const exceptionRows = (where) =>
  jsonOf(
    `select coalesce(json_agg(json_build_object('id', id, 'exception_type', exception_type, 'severity', severity, 'status', status, 'source_type', source_type, 'source_id', source_id, 'canonical_type', canonical_type, 'canonical_id', canonical_id, 'evidence', evidence_reference, 'assigned', assigned_to_user_id) order by detected_at, id), '[]'::json)::text from public.reconciliation_exceptions where ${where};`,
  );

const consultationExceptions = (consultation, type) =>
  exceptionRows(
    `source_type = 'consultation' and source_id = '${consultation}' and exception_type = ${lit(type)}`,
  );

const reviewRow = (id) => rowOf("reviews", `id = '${id}'`);
const complaintRow = (id) => rowOf("complaint_cases", `id = '${id}'`);
const holdRow = (id) => rowOf("legal_holds", `id = '${id}'`);

const notificationPairs = (user, source) =>
  notificationsOf(user, `source_event_id = '${source}'`).map((n) => [
    n.type,
    n.channel,
  ]);

// Everything PM row 47 says a complaint must leave unchanged, and that a
// Legal Hold must leave unchanged (a hold changes no business state).
function matterSnapshot(s) {
  return JSON.stringify({
    consultation: consultationRow(s.consultation),
    request: requestOf(s.request),
    bookings: bookingsOf(s.consultation),
    engagements: engagementsOf(s.consultation),
    payment: livePaymentOf(s.request),
    room: roomOf(s.consultation),
    counts: sql(
      `select concat_ws(',',
         (select count(*) from public.ledger_entries),
         (select count(*) from public.messages where consultation_id = '${s.consultation}'),
         (select count(*) from public.resources where consultation_id = '${s.consultation}'),
         (select count(*) from public.session_participation_records),
         (select count(*) from public.media_sessions),
         (select count(*) from public.reconciliation_exceptions),
         (select count(*) from public.operational_jobs where job_type not like 'notification.%'),
         (select count(*) from public.reviews));`,
    ),
  });
}

const S11_COUNT_TABLES = Object.freeze([
  "consultations",
  "bookings",
  "engagements",
  "payment_transactions",
  "ledger_entries",
  "reconciliation_exceptions",
  "reviews",
  "complaint_cases",
  "legal_holds",
  "notifications",
  "operational_jobs",
  "audit_events",
]);
const s11Counts = () =>
  Object.fromEntries(
    S11_COUNT_TABLES.map((t) => [
      t,
      Number(sql(`select count(*) from public.${t};`)),
    ]),
  );

// A new scheduled Request of another client for the same attorney and slot:
// created only when the slot is free.
function slotRequestOutcome(s, slot) {
  const owner = newClient();
  const referral = ownerReferral({
    client: owner,
    lawyer: s.lawyer,
    jurisdiction: s.jurisdiction,
    requestPath: "scheduled",
  });
  return asClient(
    owner,
    `select outcome || '|' || coalesce(problem, '') from public.request_create(${lit(referral)}, 'scheduled', 'synthetic_video', 30, ${lit(slot)}::timestamptz, null::text);`,
  );
}

// Every page of the stale queue (25 rows a page, plus one that says another
// page follows).
function staleQueueAs(staff, options = {}) {
  const rows = [];
  for (let offset = 0; offset < 2000; offset += 25) {
    const page = rowsJson(
      staff,
      `select row_to_json(x)::text from public.staff_stale_consultations(${offset}) x;`,
      options,
    );
    rows.push(...page.slice(0, 25));
    if (page.length < 26) {
      break;
    }
  }
  return rows;
}
const staffConsultationAs = (staff, consultation, options = {}) =>
  rowsJson(
    staff,
    `select row_to_json(x)::text from public.staff_consultation(${lit(consultation)}) x;`,
    options,
  );
const familyAs = (staff, family, status = "open", options = {}) =>
  rowsJson(
    staff,
    `select row_to_json(x)::text from public.staff_review_exceptions(${lit(family)}, ${lit(status)}, 0) x;`,
    options,
  );
const financeExceptionsAs = (staff, status = "open", options = {}) =>
  rowsJson(
    staff,
    `select row_to_json(x)::text from public.staff_finance_exceptions(${lit(status)}, 0) x;`,
    options,
  );

const keysOf = (row) => Object.keys(row).sort().join(",");

// ---------------------------------------------------------------------------
// MIG and PRIV: migrations, catalog and privileges
// ---------------------------------------------------------------------------

const S11_AUTHENTICATED_API = Object.freeze([
  // S9 (20261125020000), replaced forward: it also completes the Booking.
  "consultation_end(uuid)",
  "consultation_end_early(uuid)",
  "consultation_cancel(uuid)",
  "staff_record_consultation_outcome(uuid, text, boolean)",
  "staff_request_release(uuid, text)",
  "client_consultations()",
  "staff_stale_consultations(integer)",
  "staff_consultation(uuid)",
  "staff_finance_exceptions(text, integer)",
  "staff_review_exceptions(text, text, integer)",
  "staff_assign_reconciliation_exception(uuid, boolean)",
  "staff_resolve_reconciliation_exception(uuid, text)",
  "review_submit(uuid, integer, text)",
  "staff_moderate_review(uuid, text)",
  "client_reviews()",
  "attorney_reviews()",
  "staff_review_queue(text, integer)",
  "staff_place_legal_hold(text, uuid, text)",
  "staff_release_legal_hold(uuid)",
  "staff_legal_holds(text, integer)",
  // MVP-001 S11 PS-A6 section 5: complaint_open takes the optional
  // statement last (20261127210000).
  "complaint_open(uuid, uuid, text)",
  "complaint_cases_mine()",
  "staff_complaint_queue(text, integer)",
  "staff_complaint_case(uuid)",
  "staff_update_complaint(uuid, text)",
  "staff_classify_complaint(uuid, text)",
  "staff_resolve_complaint(uuid, text)",
]);

const S11_PUBLIC_API = Object.freeze(["public_attorney_reviews(uuid)"]);

const S11_INTERNAL = Object.freeze([
  "consultation_outcome_codes(text)",
  "consultation_outcome_needs_start(text)",
  "consultation_outcome_integrity()",
  "consultation_nominal_end(uuid)",
  "consultation_outcome_window(uuid, timestamp with time zone)",
  "consultation_lock_live_payment(uuid)",
  "consultation_lock_booking(uuid)",
  "consultation_complete_booking(uuid)",
  // S9 (20261125020000), replaced forward: its slot is the confirmed Booking,
  // else the completed one.
  "consultation_context(uuid)",
  "payment_request_release(uuid, text)",
  "consultation_unwind_policy_references(public.payment_transactions)",
  "consultation_apply_completion(public.consultations, public.payment_transactions, text, uuid, text, text, text, uuid, jsonb)",
  "exception_family(text)",
  "exception_family_capability(text)",
  "exception_lock_staff(uuid)",
  "review_record_guard()",
  "legal_hold_record_guard()",
  "resource_under_legal_hold(uuid)",
  "legal_hold_scope_exists(text, uuid)",
  "complaint_linkage_jurisdiction(uuid, uuid)",
  "complaint_complainant_role(uuid, uuid, uuid)",
  "complaint_vocabulary(uuid, timestamp with time zone)",
  "complaint_case_guard()",
  "complaint_caller(uuid, uuid)",
  "complaint_lock_staff(uuid)",
  "notification_types()",
  "notification_type_list_valid(jsonb)",
  "notification_consultation_of(public.notifications)",
  "notification_recipient_role(public.notifications)",
  "notification_link_path(public.notifications)",
  "notification_consultation_outcome_events()",
]);

const executors = (signature) =>
  sql(
    `select coalesce(string_agg(r.rolname, ',' order by r.rolname), '') from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') and has_function_privilege(r.rolname, 'public.${signature}', 'execute');`,
  );

// The triggers of the relations S11 touches: the earlier ones plus exactly the
// S11 outcome check and outbox trigger of consultations and the guards of
// reviews, legal_holds and complaint_cases.
const EXPECTED_TRIGGERS = [
  "complaint_cases.complaint_cases_guard",
  "complaint_cases.complaint_cases_no_truncate",
  "complaint_cases.complaint_cases_set_updated_at",
  "consultations.consultations_change_guard",
  "consultations.consultations_media_lifecycle",
  "consultations.consultations_no_truncate",
  "consultations.consultations_notification_events",
  "consultations.consultations_outcome_notification_events",
  "consultations.consultations_outcome_vocabulary",
  "consultations.consultations_payment_consistency",
  "consultations.consultations_relationship_consistency",
  "consultations.consultations_set_updated_at",
  "legal_holds.legal_holds_integrity",
  "legal_holds.legal_holds_no_truncate",
  "legal_holds.legal_holds_record_guard",
  "reviews.reviews_no_truncate",
  "reviews.reviews_record_guard",
].join(",");

const S11_TABLES = Object.freeze(["reviews", "complaint_cases", "legal_holds"]);

// The SELECT privilege each API role holds on each relation after S11.
const SELECT_MATRIX = Object.freeze({
  reviews: { anon: "f", authenticated: "t", service_role: "f" },
  complaint_cases: { anon: "f", authenticated: "f", service_role: "f" },
  legal_holds: { anon: "f", authenticated: "f", service_role: "f" },
});

const columnsOf = (table) =>
  sql(
    `select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = '${table}';`,
  );

async function migrationChecks() {
  await check(
    "MIG-1 the seven S11 migrations follow S10 in order, are registered unreviewed (sequences 55 to 61, each depending on the one before it, each with a rollback plan) and applied nowhere, are Program migration refs, and apply on plain PostgreSQL to a development and a production-class database without notices",
    () => {
      assert.deepEqual(report.migrations.s11, [...S11_MIGRATIONS]);
      assert.deepEqual(
        report.migrations.notices,
        Object.fromEntries(S11_MIGRATIONS.map((file) => [file, []])),
      );
      return report.migrations.notices;
    },
  );

  await check(
    "MIG-2 the schema additions are exactly the reviews relation with exactly the PS section 21.1 columns, its named constraints, indexes, guard triggers and one SELECT row policy: the S11 texts create no other relation, add no column, type, view, sequence or non-SELECT policy and insert into no catalog table except the five capability codes of the integrity migration (no grant, no policy type, no policy version); complaint_cases and legal_holds keep exactly their P1 columns; the policy type catalog is unchanged; the new constraints and indexes on the existing relations are exactly the named ones",
    () => {
      const admittedTable = "create table public.reviews (";
      const admittedPolicy = "create policy reviews_select_own_client";
      const admittedCatalog =
        "insert into public.capability_definitions (capability_code)";
      for (const file of S11_MIGRATIONS) {
        const raw = fs
          .readFileSync(path.join(MIGRATIONS, file), "utf8")
          .replace(/--[^\n]*/g, "");
        let text = raw;
        if (file === S11_REVIEWS) {
          assert.equal(raw.split(admittedTable).length, 2, file);
          assert.equal(raw.split(admittedPolicy).length, 2, file);
          text = text.replace(admittedTable, "").replace(admittedPolicy, "");
        }
        if (file === S11_INTEGRITY) {
          assert.equal(raw.split(admittedCatalog).length, 2, file);
          text = text.replace(admittedCatalog, "");
        }
        assert.doesNotMatch(
          text,
          /create\s+table|add\s+column|create\s+type|create\s+policy|create\s+view|create\s+sequence|insert\s+into\s+public\.(policy_types|policy_versions|capability_definitions|capability_grants|deployment_environment|jurisdictions|practice_areas|regulatory_modes)/i,
          file,
        );
      }
      const columns = Object.fromEntries(
        S11_TABLES.map((t) => [t, columnsOf(t)]),
      );
      assert.deepEqual(columns, {
        reviews:
          "id:uuid:NO,consultation_id:uuid:NO,client_id:uuid:NO,rating:smallint:NO,review_text:text:YES,state:text:NO,submitted_at:timestamp with time zone:YES,published_at:timestamp with time zone:YES,moderated_at:timestamp with time zone:YES,created_at:timestamp with time zone:NO",
        // MVP-001 S11 PS-A6 section 5 re-pin: and exactly the statement
        // column of the later registered complaint configuration migration
        // (20261127210000; checked by the S11 PS-A6 proof).
        complaint_cases:
          "id:uuid:NO,complainant_user_id:uuid:NO,consultation_id:uuid:YES,referral_id:uuid:YES,jurisdiction_id:uuid:YES,state:text:NO,category_code:text:YES,opened_at:timestamp with time zone:NO,resolved_at:timestamp with time zone:YES,assigned_to_user_id:uuid:YES,resolution_code:text:YES,created_at:timestamp with time zone:NO,updated_at:timestamp with time zone:NO,statement:text:YES",
        legal_holds:
          "id:uuid:NO,scope_type:text:NO,scope_id:uuid:NO,status:text:NO,reason:text:NO,started_at:timestamp with time zone:NO,released_at:timestamp with time zone:YES,created_by_user_id:uuid:NO,released_by_user_id:uuid:YES,created_at:timestamp with time zone:NO",
      });
      assert.equal(
        sql(
          "select string_agg(code, ',' order by code) from public.policy_types;",
        ),
        // MVP-001 S11 PS-A6 adds exactly one policy type, complaint
        // (registered and checked by the S11 PS-A6 proof).
        "automated_referral_quality,bookability,cancellation,complaint,eligibility,engagement,fee,governance,notification,payment,payment_flow,referral,refund,reporting,retention,scheduling",
      );
      const policies = sql(
        "select string_agg(tablename || '.' || policyname || ':' || cmd || ':' || array_to_string(roles, '+'), ',' order by tablename, policyname) from pg_policies where schemaname = 'public' and tablename in ('reviews', 'complaint_cases', 'legal_holds');",
      );
      assert.equal(
        policies,
        "reviews.reviews_select_own_client:SELECT:authenticated",
      );
      assert.equal(
        sql(
          "select count(*) from pg_policies where schemaname = 'public' and cmd <> 'SELECT';",
        ),
        "0",
      );
      const constraints = sql(
        "select string_agg(conrelid::regclass::text || '.' || conname, ',' order by conrelid::regclass::text, conname) from pg_constraint where connamespace = 'public'::regnamespace and (conrelid = 'public.reviews'::regclass or conname in ('legal_holds_reason_v1_check', 'legal_holds_status_v1_check', 'notifications_type_v1_check', 'notifications_type_v2_check') or (conrelid = 'public.complaint_cases'::regclass and conname like '%_v1_check'));",
      );
      assert.equal(
        constraints,
        [
          "complaint_cases.complaint_cases_assignment_v1_check",
          "complaint_cases.complaint_cases_codes_v1_check",
          "complaint_cases.complaint_cases_resolution_v1_check",
          "complaint_cases.complaint_cases_state_v1_check",
          // MVP-001 S11 PS-A6 section 5 re-pin: and exactly the statement
          // check of the later registered complaint configuration migration
          // (20261127210000).
          "complaint_cases.complaint_cases_statement_v1_check",
          "legal_holds.legal_holds_reason_v1_check",
          "legal_holds.legal_holds_status_v1_check",
          "notifications.notifications_type_v2_check",
          "reviews.reviews_client_id_fkey",
          "reviews.reviews_consultation_id_fkey",
          "reviews.reviews_consultation_id_key",
          "reviews.reviews_facts_v1_check",
          "reviews.reviews_pkey",
          "reviews.reviews_rating_v1_check",
          "reviews.reviews_state_v1_check",
          "reviews.reviews_text_v1_check",
        ].join(","),
      );
      const indexes = sql(
        "select string_agg(indexname, ',' order by indexname) from pg_indexes where schemaname = 'public' and tablename in ('reviews', 'complaint_cases', 'legal_holds');",
      );
      assert.equal(
        indexes,
        "complaint_cases_consultation_idx,complaint_cases_one_open_idx,complaint_cases_pkey,complaint_cases_state_opened_idx,legal_holds_pkey,legal_holds_scope_idx,legal_holds_unreleased_started_idx,reviews_client_submitted_idx,reviews_consultation_id_key,reviews_pkey,reviews_state_submitted_idx",
      );
      assert.equal(
        sql(
          "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'complaint_cases_one_open_idx';",
        ),
        "CREATE UNIQUE INDEX complaint_cases_one_open_idx ON public.complaint_cases USING btree (complainant_user_id, COALESCE(consultation_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(referral_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE (state <> 'resolved'::text)",
      );
      const triggers = sql(
        "select string_agg(c.relname || '.' || t.tgname, ',' order by c.relname, t.tgname) from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relnamespace = 'public'::regnamespace and c.relname in ('consultations', 'reviews', 'complaint_cases', 'legal_holds');",
      );
      assert.equal(triggers, EXPECTED_TRIGGERS);
      return { columns, policies, constraints, indexes, triggers };
    },
  );

  await check(
    "CAP-1 (PS section 5.1) the capability catalog gains exactly the five S11 codes (manage_consultation_operations, manage_compliance_reviews, moderate_reviews, manage_complaints, manage_legal_holds); the migrations insert no grant row and no business row: both freshly migrated databases hold no capability grant, review, complaint case or legal hold of the migrations' making",
    () => {
      const catalog = sql(
        "select string_agg(capability_code, ',' order by capability_code) from public.capability_definitions;",
        PROD_DB,
      );
      assert.equal(
        catalog,
        // MVP-001 S11 pass 2 re-pin: and exactly the four codes of the later
        // registered S11 operations-integrity migration (20261127080000):
        // manage_client_accounts, view_audit_events, view_operations and
        // view_referral_operations. MVP-001 S11 PS-A6 re-pin: and exactly the
        // two codes of the later registered PS-A6 migrations
        // (approve_break_glass, 20261127190000; manage_data_requests,
        // 20261127200000).
        "approve_break_glass,authorize_jurisdiction_launch,manage_attorney_verification,manage_client_accounts,manage_complaints,manage_compliance_reviews,manage_consultation_operations,manage_data_requests,manage_financial_operations,manage_intake_configuration,manage_jurisdiction_configuration,manage_legal_holds,manage_operational_jobs,manage_policy_configuration,manage_staff_capabilities,moderate_reviews,view_audit_events,view_operations,view_referral_operations",
      );
      assert.equal(
        sql(
          "select concat_ws(',', (select count(*) from public.capability_grants), (select count(*) from public.reviews), (select count(*) from public.complaint_cases), (select count(*) from public.legal_holds));",
          PROD_DB,
        ),
        "0,0,0,0",
      );
      return { catalog };
    },
  );

  await check(
    "PRIV-1 reviews, complaint_cases and legal_holds are function-only and row level security is enabled on each: no API role holds INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER (table or column) on any of them; SELECT: reviews for authenticated only (under the one row policy), complaint_cases and legal_holds for no API role (restricted records, read only through the S11 functions); direct writes are refused for authenticated and service_role, direct reads of the restricted records too",
    () => {
      for (const table of S11_TABLES) {
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
                `select has_table_privilege('${role}', 'public.${table}', '${privilege}');`,
              ),
              "f",
              `${role} ${privilege} ${table}`,
            );
          }
          assert.equal(
            sql(
              `select has_any_column_privilege('${role}', 'public.${table}', 'UPDATE') or has_any_column_privilege('${role}', 'public.${table}', 'INSERT');`,
            ),
            "f",
            `${role} column writes ${table}`,
          );
          assert.equal(
            sql(
              `select has_table_privilege('${role}', 'public.${table}', 'SELECT');`,
            ),
            SELECT_MATRIX[table][role],
            `${role} SELECT ${table}`,
          );
        }
        assert.equal(
          sql(
            `select relrowsecurity from pg_class where oid = 'public.${table}'::regclass;`,
          ),
          "t",
        );
      }
      const statements = [
        "insert into public.reviews (consultation_id, client_id, rating, state, submitted_at) values (gen_random_uuid(), gen_random_uuid(), 5, 'submitted', now());",
        "update public.reviews set state = 'published';",
        "delete from public.reviews;",
        "insert into public.complaint_cases (complainant_user_id, state, opened_at) values (gen_random_uuid(), 'opened', now());",
        "update public.complaint_cases set state = 'resolved';",
        "select count(*) from public.complaint_cases;",
        "insert into public.legal_holds (scope_type, scope_id, status, reason, started_at, created_by_user_id) values ('user', gen_random_uuid(), 'active', 'x', now(), gen_random_uuid());",
        "update public.legal_holds set released_at = now();",
        "select count(*) from public.legal_holds;",
        "update public.consultations set state = 'cancelled', outcome_code = 'client_cancelled', ended_at = now();",
        "update public.bookings set status = 'cancelled', cancelled_at = now();",
      ];
      const codes = {};
      for (const role of ["authenticated", "service_role"]) {
        const sub = role === "service_role" ? null : world.ann.auth;
        codes[role] = statements.map((statement) => as(role, sub, statement));
      }
      for (const list of Object.values(codes)) {
        for (const code of list) {
          assert.equal(code, "ERROR 42501");
        }
      }
      assert.equal(
        as("anon", null, "select count(*) from public.reviews;"),
        "ERROR 42501",
      );
      return codes;
    },
  );

  await check(
    "PRIV-2 function privileges: every S11 command and read is security definer, pins its search_path and is executable by authenticated only (the volatile commands also bound their lock waits), except the one public read, executable by anon and authenticated; every internal, guard and trigger function is executable by no API role; anon executes nothing else S11 adds; service_role executes nothing S11 adds",
    () => {
      const detail = {};
      for (const signature of S11_AUTHENTICATED_API) {
        assert.equal(executors(signature), "authenticated", signature);
      }
      for (const signature of S11_PUBLIC_API) {
        assert.equal(executors(signature), "anon,authenticated", signature);
      }
      for (const signature of S11_INTERNAL) {
        assert.equal(executors(signature), "", signature);
      }
      for (const signature of [...S11_AUTHENTICATED_API, ...S11_PUBLIC_API]) {
        const [definer, config, volatility] = sql(
          `select prosecdef::text || '|' || coalesce(array_to_string(proconfig, ';'), '') || '|' || provolatile::text from pg_proc where oid = 'public.${signature}'::regprocedure;`,
        ).split("|");
        assert.equal(definer, "true", signature);
        assert.match(config, /search_path=pg_catalog, pg_temp/, signature);
        if (volatility === "v") {
          assert.match(config, /lock_timeout=3s/, signature);
        }
        detail[signature] = `${volatility}:${config}`;
      }
      // Every function the seven migrations create or replace is in exactly
      // one of the three lists.
      const created = new Set();
      for (const file of S11_MIGRATIONS) {
        const text = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
        for (const match of text.matchAll(
          /^create (?:or replace )?function public\.([a-z_0-9]+)\(/gm,
        )) {
          created.add(match[1]);
        }
      }
      const listed = new Set(
        [...S11_AUTHENTICATED_API, ...S11_PUBLIC_API, ...S11_INTERNAL].map(
          (signature) => signature.slice(0, signature.indexOf("(")),
        ),
      );
      assert.deepEqual([...created].sort(), [...listed].sort());
      return detail;
    },
  );
}

// ---------------------------------------------------------------------------
// OUT: the outcome vocabulary
// ---------------------------------------------------------------------------

const TERMINAL_SET = (state, code, { start = false, end = true } = {}) =>
  `state = '${state}', outcome_code = ${code === null ? "null" : `'${code}'`}${end ? ", ended_at = now()" : ""}${start ? ", started_at = coalesce(started_at, now())" : ""}`;

async function outcomeChecks() {
  await check(
    "OUT-1 (DM section 2.4; PM rows 11 to 22) the outcome vocabulary holds at commit for every role, the database owner included: a Consultation commits in a terminal state only with one of that state's codes (completed normal | early_by_agreement | manual_resolution; cancelled client_cancelled | attorney_cancelled; no_show client_no_show | attorney_no_show | both_no_show; technical_failure neither_connected | mid_consultation_failure), with its end instant, and with a start exactly for the outcomes a started Consultation reaches; a missing code, another state's code, an unknown code, a missing end and a start that does not agree are refused (23514); every pair of the vocabulary is accepted; no API role can write the relation at all",
    () => {
      const ready = readyConsultation("S").consultation;
      const live = liveConsultation("S").consultation;
      const update = (c, set) =>
        `update public.consultations set ${set} where id = '${c}';`;
      const codes = {
        no_code: refused(update(ready, TERMINAL_SET("cancelled", null))),
        other_state_code: refused(
          update(ready, TERMINAL_SET("cancelled", "client_no_show")),
        ),
        unknown_code: refused(
          update(ready, TERMINAL_SET("no_show", "synthetic")),
        ),
        no_end: refused(
          update(
            ready,
            TERMINAL_SET("cancelled", "client_cancelled", { end: false }),
          ),
        ),
        completed_without_start: refused(
          update(ready, TERMINAL_SET("completed", "normal")),
        ),
        failure_mid_without_start: refused(
          update(
            ready,
            TERMINAL_SET("technical_failure", "mid_consultation_failure"),
          ),
        ),
        no_show_after_start: refused(
          update(live, TERMINAL_SET("no_show", "client_no_show")),
        ),
        cancelled_after_start: refused(
          update(live, TERMINAL_SET("cancelled", "attorney_cancelled")),
        ),
        neither_connected_after_start: refused(
          update(live, TERMINAL_SET("technical_failure", "neither_connected")),
        ),
        live_completed_without_code: refused(
          update(live, TERMINAL_SET("completed", null)),
        ),
      };
      for (const [name, code] of Object.entries(codes)) {
        assert.equal(code, "23514", name);
      }
      // Every pair of the vocabulary passes the check (fired before the
      // rollback by making the deferred checks immediate).
      const accepted = [];
      for (const [c, state, code] of [
        [ready, "cancelled", "client_cancelled"],
        [ready, "cancelled", "attorney_cancelled"],
        [ready, "no_show", "client_no_show"],
        [ready, "no_show", "attorney_no_show"],
        [ready, "no_show", "both_no_show"],
        [ready, "technical_failure", "neither_connected"],
        [live, "completed", "normal"],
        [live, "completed", "early_by_agreement"],
        [live, "completed", "manual_resolution"],
        [live, "technical_failure", "mid_consultation_failure"],
      ]) {
        acceptedThenRolledBack(
          `${update(c, TERMINAL_SET(state, code))}\nset constraints all immediate;`,
        );
        accepted.push(`${state}/${code}`);
      }
      // The S8 lifecycle guard is unchanged: a terminal Consultation never
      // changes, whatever the role.
      assert.equal(
        refused(
          `${update(ready, TERMINAL_SET("cancelled", "client_cancelled"))}\n${update(ready, "outcome_code = 'attorney_cancelled'")}`,
        ),
        "55000",
      );
      for (const role of ["authenticated", "service_role"]) {
        assert.equal(
          as(
            role,
            role === "service_role" ? null : world.ann.auth,
            update(ready, TERMINAL_SET("cancelled", "client_cancelled")),
          ),
          "ERROR 42501",
        );
      }
      assert.deepEqual(
        [consultationRow(ready).state, consultationRow(live).state],
        ["ready", "live"],
      );
      return { refused: codes, accepted };
    },
  );
}

// ---------------------------------------------------------------------------
// EARLY: early completion by agreement (PM row 21)
// ---------------------------------------------------------------------------

async function earlyChecks() {
  await check(
    "EARLY-1 (PM row 21: completed + reason; payment as row 20; no refund) only the Consultation's own attorney at aal2 ends a live Consultation early, before its nominal end: the client, an attorney at aal1 and another attorney are refused alike, a ready Consultation answers not_started; the end records completed / early_by_agreement with its end instant; with capture at_consultation_completion the capture is requested in the same transaction (and nothing else moves: no refund, no ledger entry, no exception); the audit event carries the attorney, the reason and the payment_flow version; the client is told the recorded outcome and that a review is available, the attorney nothing; a second end answers ended",
    () => {
      const s = liveConsultation("C");
      const refusals = {
        client: jsonAs(s.client, EARLY_SQL(s.consultation), AAL1).outcome,
        aal1: endEarly(s, AAL1).outcome,
        other_attorney: jsonAs(lawyer("C"), EARLY_SQL(s.consultation)).outcome,
        unknown: jsonAs(s.lawyer, EARLY_SQL(uid())).outcome,
        ready: endEarly(readyConsultation("C")),
      };
      assert.deepEqual(refusals, {
        client: "denied",
        aal1: "denied",
        other_attorney: "not_found",
        unknown: "not_found",
        ready: { outcome: "not_started", problem: "ready", ended_at: null },
      });
      assert.equal(livePaymentOf(s.request).state, "authorized");
      const before = s11Counts();
      const ended = endEarly(s);
      assert.equal(ended.outcome, "completed", JSON.stringify(ended));
      const row = consultationRow(s.consultation);
      assert.deepEqual(
        [row.state, row.outcome_code, row.ended_at !== null],
        ["completed", "early_by_agreement", true],
      );
      assert.equal(ms(row.ended_at), ms(ended.ended_at));
      const payment = livePaymentOf(s.request);
      assert.deepEqual(
        [payment.state, payment.amount_refunded_minor],
        ["capture_pending", 0],
      );
      assert.ok(
        openJob("payment.capture", "payment_transaction", s.payment),
        "the capture job",
      );
      const delta = deltaOf(before, s11Counts());
      assert.deepEqual(
        [delta.ledger_entries, delta.reconciliation_exceptions],
        [undefined, undefined],
      );
      const audit = auditsOf(s.consultation, "consultation.completed");
      assert.equal(audit.length, 1);
      assert.deepEqual(
        [
          audit[0].actor_type,
          audit[0].actor_user_id,
          audit[0].reason_code,
          audit[0].before.state,
          audit[0].after.outcome_code,
          audit[0].after.capture_timing,
          audit[0].after.capture_requested,
          audit[0].after.nominal_end_at !== undefined,
        ],
        [
          "attorney",
          s.lawyer.user,
          "attorney_completed_early",
          "live",
          "early_by_agreement",
          "at_consultation_completion",
          true,
          true,
        ],
      );
      assert.deepEqual(audit[0].policy_references, [
        {
          policy_type_code: "payment_flow",
          policy_version_id: world.policies.C.payment_flow,
        },
      ]);
      const clientNotes = notificationPairs(
        s.client.user,
        s.consultation,
      ).filter(([type]) => type !== "consultation_ready");
      assert.deepEqual(clientNotes, [
        ["consultation_outcome_recorded", "in_app"],
        ["consultation_outcome_recorded", "email"],
        ["review_available", "in_app"],
        ["review_available", "email"],
      ]);
      assert.deepEqual(
        notificationPairs(s.lawyer.user, s.consultation).filter(
          ([type]) => type !== "consultation_ready",
        ),
        [],
      );
      assert.deepEqual(endEarly(s), {
        outcome: "ended",
        problem: "completed",
        ended_at: null,
      });
      return { refusals, client_notifications: clientNotes };
    },
  );

  await check(
    "EARLY-2 (PM row 21) early means before the nominal end, decided by the server: an instant Consultation whose start plus requested duration has passed answers not_early and stays live (the attorney's normal end then completes it as normal, PM row 20); a scheduled Consultation's nominal end is its Booking's end; with capture at the start nothing is captured at the early end and the captured payment is left as it is (no refund is made)",
    async () => {
      const late = liveCaptured("S");
      // Fixture: the start moves 31 minutes into the past, so the 30 requested
      // minutes are over.
      shiftConsultation(late.consultation, 31);
      const notEarly = endEarly(late);
      assert.deepEqual(notEarly, {
        outcome: "not_early",
        problem: null,
        ended_at: null,
      });
      assert.equal(consultationRow(late.consultation).state, "live");
      assert.equal(end(late).outcome, "completed");
      assert.equal(consultationRow(late.consultation).outcome_code, "normal");

      const captured = liveCaptured("S");
      const paymentBefore = JSON.stringify(livePaymentOf(captured.request));
      const before = s11Counts();
      assert.equal(endEarly(captured).outcome, "completed");
      assert.equal(
        JSON.stringify(livePaymentOf(captured.request)),
        paymentBefore,
      );
      const delta = deltaOf(before, s11Counts());
      assert.deepEqual(
        [
          delta.ledger_entries,
          delta.reconciliation_exceptions,
          delta.payment_transactions,
        ],
        [undefined, undefined, undefined],
      );
      assert.equal(
        auditsOf(captured.consultation, "consultation.completed")[0].after
          .capture_requested,
        false,
      );

      // A scheduled Consultation, started inside its join window before the
      // slot begins: its nominal end is the Booking's end.
      const who = lawyer("S");
      const scheduled = scheduledConsultation("S", {
        who,
        slot: nearSlot(120),
      });
      const started = start(scheduled);
      assert.equal(started.outcome, "started", JSON.stringify(started));
      const booking = bookingsOf(scheduled.consultation)[0];
      const early = endEarly(scheduled);
      assert.equal(early.outcome, "completed");
      const audit = auditsOf(scheduled.consultation, "consultation.completed");
      assert.equal(ms(audit[0].after.nominal_end_at), ms(booking.ends_at));
      return {
        not_early: notEarly.outcome,
        scheduled_nominal_end_is_booking_end: true,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// BOOK: the Booking ends with its Consultation (DM section 2.7)
// ---------------------------------------------------------------------------

async function bookingStatusChecks() {
  await check(
    "BOOK-1 (DM section 2.7: Booking completion is a fact separate from Consultation completion; confirmed -> superseded | cancelled | completed) in the same transaction as each terminal transition the confirmed Booking ends: the cancellation cancels it; the attorney's normal end, the early end by agreement, the staff manual resolution, mid-consultation failure, no-show and neither-connected outcomes complete it (no timestamp; never deleted, never superseded); an ended Booking no longer blocks its slot: another client's Request for the slot, refused while it was confirmed, is created with a new Hold after the normal end and after the early end; the decided Consultation keeps its slot in the S9 facts; an ended Booking is immutable for the owner (S4 guard); an instant Consultation has no Booking to end",
    () => {
      const bookingCount = () => Number(sql("select count(*) from public.bookings;"));
      const before = bookingCount();
      const statusOf = (s) =>
        bookingsOf(s.consultation).map((b) => [
          b.status,
          b.cancelled_at,
          b.superseded_at,
        ]);
      const activeHolds = (s, slot) =>
        Number(
          sql(
            `select count(*) from public.slot_holds where attorney_id = (select attorney_id from public.consultations where id = '${s.consultation}') and slot_start_at = ${lit(slot)}::timestamptz and released_at is null;`,
          ),
        );
      const contextSlot = (s) =>
        sql(
          `select coalesce(slot_start_at::text, 'none') from public.consultation_context('${s.consultation}');`,
        );
      const paths = {};
      // The attorney's normal end and the early end of a live scheduled
      // Consultation started inside its join window before the slot begins.
      for (const [name, finish] of [
        ["normal_end", (s) => end(s)],
        ["end_early", (s) => endEarly(s)],
      ]) {
        const s = scheduledConsultation("S", {
          who: lawyer("S"),
          slot: nearSlot(180),
        });
        const occupied = slotRequestOutcome(s, s.slot);
        assert.ok(!occupied.startsWith("created"), occupied);
        assert.equal(start(s).outcome, "started");
        const slotBefore = contextSlot(s);
        const answer = finish(s);
        assert.equal(answer.outcome, "completed", JSON.stringify(answer));
        assert.deepEqual(statusOf(s), [["completed", null, null]]);
        assert.equal(contextSlot(s), slotBefore);
        assert.notEqual(slotBefore, "none");
        const holdsBefore = activeHolds(s, s.slot);
        const freed = slotRequestOutcome(s, s.slot);
        assert.ok(freed.startsWith("created"), freed);
        assert.equal(activeHolds(s, s.slot), holdsBefore + 1);
        const audit = auditsOf(s.consultation, "consultation.completed");
        assert.equal(audit.length, 1);
        if (name === "end_early") {
          assert.equal(
            audit[0].after.booking_id,
            bookingsOf(s.consultation)[0].id,
          );
        }
        paths[name] = { booking: "completed", occupied, freed };
      }
      // The staff outcomes: two never-started scheduled Consultations whose
      // Booking moved four days into the past (fixture) and two live ones.
      for (const code of ["both_no_show", "neither_connected"]) {
        const s = scheduledConsultation("S");
        shiftScheduled(s.consultation, 4 * 1440);
        const answer = recordOutcome(world.ops, s.consultation, code, true);
        assert.equal(answer.outcome, "recorded", JSON.stringify(answer));
        assert.deepEqual(statusOf(s), [["completed", null, null]]);
        const audit = auditsOf(s.consultation, "consultation.outcome_recorded");
        assert.equal(
          audit[0].after.booking_id,
          bookingsOf(s.consultation)[0].id,
        );
        paths[code] = "completed";
      }
      for (const code of ["manual_resolution", "mid_consultation_failure"]) {
        const s = scheduledConsultation("S", {
          who: lawyer("S"),
          slot: nearSlot(180),
        });
        assert.equal(start(s).outcome, "started");
        shiftScheduled(s.consultation, 4 * 1440);
        const answer = recordOutcome(world.ops, s.consultation, code, true);
        assert.equal(answer.outcome, "recorded", JSON.stringify(answer));
        assert.deepEqual(statusOf(s), [["completed", null, null]]);
        paths[code] = "completed";
      }
      // The cancellation (CAN-1 proves the slot is free again).
      const cancelled = scheduledConsultation("S");
      assert.equal(clientCancel(cancelled).outcome, "cancelled");
      const [cancelledStatus, cancelledAt] = statusOf(cancelled)[0];
      assert.equal(cancelledStatus, "cancelled");
      assert.notEqual(cancelledAt, null);
      paths.cancellation = "cancelled";
      // An ended Booking is immutable, even for the owner.
      const ended = bookingsOf(cancelled.consultation)[0];
      assert.equal(
        refused(
          `update public.bookings set status = 'confirmed', cancelled_at = null where id = '${ended.id}';`,
        ),
        "55000",
      );
      // An instant Consultation has no Booking.
      const instant = completedConsultation("S");
      assert.deepEqual(bookingsOf(instant.consultation), []);
      // Never deleted, never superseded.
      assert.equal(bookingCount(), before + 7);
      assert.equal(
        Number(
          sql(
            "select count(*) from public.bookings where status = 'superseded';",
          ),
        ),
        0,
      );
      return paths;
    },
  );
}

// ---------------------------------------------------------------------------
// CAN: cancellation by a participant (PM rows 11 to 13)
// ---------------------------------------------------------------------------

async function cancellationChecks() {
  await check(
    "CAN-1 (PM rows 11 and 12; TA section 61) the client cancels their own scheduled Consultation (aal1): it becomes cancelled / client_cancelled with its end instant; in the same transaction its confirmed Booking is cancelled and the slot is free again (another client's Request for that attorney and slot, refused before, is created after); the payment is not moved (the authorized attempt is unchanged, byte for byte; no release, capture, refund or ledger entry) and exactly one high cancellation_payment_review exception is opened with PM rows 11 and 12, who cancelled, the state before, the whole seconds before the scheduled start, the payment state and the cancellation and refund policy versions the payment recorded, and no late or early classification; the attorney is notified, the client is not; the audit event carries the client, the reason and both policy versions; messaging is closed",
    () => {
      const s = scheduledConsultation("S");
      const occupied = slotRequestOutcome(s, s.slot);
      assert.ok(!occupied.startsWith("created"), occupied);
      const paymentBefore = JSON.stringify(livePaymentOf(s.request));
      assert.equal(livePaymentOf(s.request).state, "authorized");
      const before = s11Counts();
      const answer = clientCancel(s);
      assert.equal(answer.outcome, "cancelled", JSON.stringify(answer));
      const row = consultationRow(s.consultation);
      assert.deepEqual(
        [row.state, row.outcome_code, row.started_at, ms(row.ended_at)],
        ["cancelled", "client_cancelled", null, ms(answer.cancelled_at)],
      );
      const bookings = bookingsOf(s.consultation);
      assert.deepEqual(
        bookings.map((b) => [b.status, ms(b.cancelled_at)]),
        [["cancelled", ms(row.ended_at)]],
      );
      const freed = slotRequestOutcome(s, s.slot);
      assert.ok(freed.startsWith("created"), freed);
      assert.equal(JSON.stringify(livePaymentOf(s.request)), paymentBefore);
      const items = exceptionRows(`canonical_id = '${s.payment}'`);
      assert.equal(items.length, 1);
      const item = items[0];
      assert.deepEqual(
        [
          item.exception_type,
          item.severity,
          item.status,
          item.source_type,
          item.source_id,
          item.canonical_type,
        ],
        [
          "cancellation_payment_review",
          "high",
          "open",
          "consultation",
          s.consultation,
          "payment_transaction",
        ],
      );
      assert.equal(
        keysOf(item.evidence),
        "cancellation_policy_version_id,cancelled_by,consultation_state_before,outcome_code,payment_matrix_rows,payment_state,refund_policy_version_id,request_path,seconds_before_scheduled_start",
      );
      assert.deepEqual(
        [
          item.evidence.payment_matrix_rows,
          item.evidence.cancelled_by,
          item.evidence.consultation_state_before,
          item.evidence.request_path,
          item.evidence.payment_state,
          item.evidence.cancellation_policy_version_id,
          item.evidence.refund_policy_version_id,
        ],
        [
          [11, 12],
          "client",
          "scheduled",
          "scheduled",
          "authorized",
          world.policies.S.cancellation,
          world.policies.S.refund,
        ],
      );
      const seconds = item.evidence.seconds_before_scheduled_start;
      assert.ok(Number.isSafeInteger(seconds) && seconds > 86400, seconds);
      assert.doesNotMatch(JSON.stringify(item.evidence), /late|early|thresh/i);
      // The only new rows besides the freed slot's Request: the exception,
      // its audit event, the cancellation's audit event and the attorney's
      // Notifications with their delivery job.
      assert.equal(
        Number(
          sql(
            `select count(*) from public.operational_jobs where subject_type = 'payment_transaction' and subject_id = '${s.payment}' and job_type in ('payment.release', 'payment.capture', 'payment.refund') and created_at > '${row.ended_at}'::timestamptz - interval '1 second';`,
          ),
        ),
        0,
      );
      assert.equal(
        Number(
          sql(
            `select count(*) from public.ledger_entries where payment_transaction_id = '${s.payment}';`,
          ),
        ),
        0,
      );
      const audit = auditsOf(s.consultation, "consultation.cancelled");
      assert.equal(audit.length, 1);
      assert.deepEqual(
        [
          audit[0].actor_type,
          audit[0].actor_user_id,
          audit[0].reason_code,
          audit[0].before,
          audit[0].after.state,
          audit[0].after.booking_id,
          audit[0].after.payment_state,
          audit[0].after.reconciliation_exception_id,
          audit[0].policy_references,
        ],
        [
          "client",
          s.client.user,
          "client_cancelled",
          { state: "scheduled" },
          "cancelled",
          bookings[0].id,
          "authorized",
          item.id,
          [
            {
              policy_type_code: "cancellation",
              policy_version_id: world.policies.S.cancellation,
            },
            {
              policy_type_code: "refund",
              policy_version_id: world.policies.S.refund,
            },
          ],
        ],
      );
      assert.deepEqual(notificationPairs(s.lawyer.user, s.consultation), [
        ["consultation_cancelled", "in_app"],
        ["consultation_cancelled", "email"],
      ]);
      assert.deepEqual(notificationPairs(s.client.user, s.consultation), []);
      assert.equal(clientSend(s, "After the cancellation.").outcome, "closed");
      const delta = deltaOf(before, s11Counts());
      assert.deepEqual(
        [
          delta.reconciliation_exceptions,
          delta.payment_transactions,
          delta.ledger_entries,
          delta.bookings,
        ],
        [1, undefined, undefined, undefined],
      );
      return {
        occupied_before: occupied,
        freed_after: freed,
        evidence: item.evidence,
      };
    },
  );

  await check(
    "CAN-2 (PM row 13; TA section 62) the attorney cancels their own ready instant Consultation at aal2 whose payment was captured at the acceptance: cancelled / attorney_cancelled; the Media Room moves to closing with its provider deletion job (S9 lifecycle); the captured payment is left exactly as it is (no refund is requested) and one high cancellation_payment_review exception cites PM row 13 with the payment state captured and no seconds before a scheduled start (instant path); the client is notified; an attorney at aal1, another attorney, another client and an unknown id answer not_found alike, a null id invalid, and an attorney whose profile is no longer approved denied, each changing nothing",
    () => {
      const s = readyConsultation("A");
      assert.equal(livePaymentOf(s.request).state, "captured");
      const snapshot = matterSnapshot(s);
      const stranger = newClient();
      const refusals = {
        aal1: attorneyCancel(s, AAL1).outcome,
        other_attorney: jsonAs(lawyer("A"), CANCEL_SQL(s.consultation)).outcome,
        other_client: jsonAs(stranger, CANCEL_SQL(s.consultation), AAL1)
          .outcome,
        unknown: jsonAs(s.client, CANCEL_SQL(uid()), AAL1).outcome,
        null_id: jsonAs(
          s.client,
          "select row_to_json(x)::text from public.consultation_cancel(null) x;",
          AAL1,
        ).outcome,
        anon: as("anon", null, CANCEL_SQL(s.consultation)),
      };
      // Fixture (owner, triggers bypassed): the attorney's profile is no
      // longer approved, then approved again.
      const plantProfile = (state) =>
        sql(
          `begin;
           set local session_replication_role = replica;
           update public.attorney_profiles set profile_state = '${state}' where id = '${s.lawyer.profile}';
           commit;`,
        );
      plantProfile("suspended");
      refusals.suspended = attorneyCancel(s).outcome;
      plantProfile("approved");
      assert.deepEqual(refusals, {
        aal1: "not_found",
        other_attorney: "not_found",
        other_client: "not_found",
        unknown: "not_found",
        null_id: "invalid",
        anon: "ERROR 42501",
        suspended: "denied",
      });
      assert.equal(matterSnapshot(s), snapshot);
      const paymentBefore = JSON.stringify(livePaymentOf(s.request));
      const room = roomOf(s.consultation);
      const answer = attorneyCancel(s);
      assert.equal(answer.outcome, "cancelled", JSON.stringify(answer));
      const row = consultationRow(s.consultation);
      assert.deepEqual(
        [row.state, row.outcome_code],
        ["cancelled", "attorney_cancelled"],
      );
      assert.equal(roomOf(s.consultation).state, "closing");
      assert.ok(openJob("media.room_delete", "media_room", room.id));
      assert.equal(JSON.stringify(livePaymentOf(s.request)), paymentBefore);
      const items = consultationExceptions(
        s.consultation,
        "cancellation_payment_review",
      );
      assert.equal(items.length, 1);
      assert.deepEqual(
        [
          items[0].severity,
          items[0].evidence.payment_matrix_rows,
          items[0].evidence.cancelled_by,
          items[0].evidence.consultation_state_before,
          items[0].evidence.payment_state,
          items[0].evidence.seconds_before_scheduled_start,
        ],
        ["high", [13], "attorney", "ready", "captured", null],
      );
      assert.deepEqual(
        notificationPairs(s.client.user, s.consultation).filter(
          ([type]) => type !== "consultation_ready",
        ),
        [
          ["consultation_cancelled", "in_app"],
          ["consultation_cancelled", "email"],
        ],
      );
      assert.deepEqual(
        notificationPairs(s.lawyer.user, s.consultation).filter(
          ([type]) => type !== "consultation_ready",
        ),
        [],
      );
      const audit = auditsOf(s.consultation, "consultation.cancelled");
      assert.deepEqual(
        [audit[0].actor_type, audit[0].actor_user_id, audit[0].reason_code],
        ["attorney", s.lawyer.user, "attorney_cancelled"],
      );
      assert.equal(clientAccess(s).outcome, "ended");
      return { refusals, evidence: items[0].evidence };
    },
  );

  await check(
    "CAN-3 (DM section 2.4) a Consultation is cancelled only while created, scheduled or ready: each of those states is cancelled; a live Consultation answers in_progress, a completed one ended, a cancelled one already_cancelled with who cancelled, each changing nothing; without any payment attempt the cancellation opens no exception and is recorded by its audit event alone (no policy version is invented)",
    () => {
      const answers = {};
      // Fixture (owner, triggers bypassed): the state created, which no
      // command leaves at commit, planted on a scheduled Consultation.
      const created = scheduledConsultation("S");
      sql(
        `begin;
         set local session_replication_role = replica;
         update public.consultations set state = 'created' where id = '${created.consultation}';
         commit;`,
      );
      answers.created = clientCancel(created).outcome;
      const scheduled = scheduledConsultation("S");
      answers.scheduled = attorneyCancel(scheduled).outcome;
      const ready = readyConsultation("S");
      answers.ready = clientCancel(ready).outcome;
      const live = liveConsultation("S");
      const liveSnapshot = matterSnapshot(live);
      answers.live = [clientCancel(live).outcome, attorneyCancel(live).outcome];
      assert.equal(matterSnapshot(live), liveSnapshot);
      const completed = completedConsultation("S");
      const completedSnapshot = matterSnapshot(completed);
      answers.completed = clientCancel(completed);
      assert.equal(matterSnapshot(completed), completedSnapshot);
      const cancelledSnapshot = matterSnapshot(ready);
      answers.cancelled_again = attorneyCancel(ready);
      assert.equal(matterSnapshot(ready), cancelledSnapshot);
      assert.deepEqual(answers, {
        created: "cancelled",
        scheduled: "cancelled",
        ready: "cancelled",
        live: ["in_progress", "in_progress"],
        completed: {
          outcome: "ended",
          problem: "completed",
          cancelled_at: null,
        },
        cancelled_again: {
          outcome: "already_cancelled",
          problem: "client_cancelled",
          cancelled_at: null,
        },
      });
      const unpaid = unpaidScheduledConsultation();
      const before = s11Counts();
      assert.equal(clientCancel(unpaid).outcome, "cancelled");
      const delta = deltaOf(before, s11Counts());
      assert.deepEqual(
        [delta.reconciliation_exceptions, delta.payment_transactions],
        [undefined, undefined],
      );
      const audit = auditsOf(unpaid.consultation, "consultation.cancelled");
      assert.deepEqual(
        [
          audit.length,
          audit[0].policy_references,
          audit[0].after.payment_transaction_id,
          audit[0].after.reconciliation_exception_id,
        ],
        [1, null, null, null],
      );
      assert.equal(bookingsOf(unpaid.consultation)[0].status, "cancelled");
      return answers;
    },
  );
}

// ---------------------------------------------------------------------------
// STAFF: staff outcome recording (PM rows 14 to 18)
// ---------------------------------------------------------------------------

async function staffOutcomeChecks() {
  await check(
    "STAFF-1 (PS section 30.4; TA sections 18 and 41) recording an outcome needs manage_consultation_operations for the Consultation's jurisdiction at aal2: a grant scoped to that jurisdiction or a global one records; a grant scoped to another jurisdiction, a staff member without the capability, the capability holder at aal1, the Consultation's own client and attorney and anon are denied; for an unknown id a global holder answers not_found and a scoped holder denied (no existence oracle); a malformed call is invalid; every refusal changes nothing",
    () => {
      const inS = staleReady("S");
      const inC = staleReady("C");
      const snapshots = [matterSnapshot(inS), matterSnapshot(inC)];
      const refusals = {
        scoped_other_jurisdiction: recordOutcome(
          world.opsS,
          inC.consultation,
          "client_no_show",
        ).outcome,
        plain_staff: recordOutcome(
          world.plainStaff,
          inS.consultation,
          "client_no_show",
        ).outcome,
        other_capability: recordOutcome(
          world.finance,
          inS.consultation,
          "client_no_show",
        ).outcome,
        aal1: recordOutcome(
          world.ops,
          inS.consultation,
          "client_no_show",
          false,
          AAL1,
        ).outcome,
        client: jsonAs(
          inS.client,
          OUTCOME_SQL(inS.consultation, "attorney_no_show"),
          AAL1,
        ).outcome,
        attorney: jsonAs(
          inS.lawyer,
          OUTCOME_SQL(inS.consultation, "client_no_show"),
        ).outcome,
        anon: as("anon", null, OUTCOME_SQL(inS.consultation, "client_no_show")),
        unknown_global: recordOutcome(world.ops, uid(), "client_no_show")
          .outcome,
        unknown_scoped: recordOutcome(world.opsS, uid(), "client_no_show")
          .outcome,
        unknown_code: recordOutcome(world.ops, inS.consultation, "normal")
          .outcome,
        null_acknowledgement: jsonAs(
          world.ops,
          `select row_to_json(x)::text from public.staff_record_consultation_outcome('${inS.consultation}', 'client_no_show', null) x;`,
        ).outcome,
      };
      assert.deepEqual(refusals, {
        scoped_other_jurisdiction: "denied",
        plain_staff: "denied",
        other_capability: "denied",
        aal1: "denied",
        client: "denied",
        attorney: "denied",
        anon: "ERROR 42501",
        unknown_global: "not_found",
        unknown_scoped: "denied",
        unknown_code: "invalid",
        null_acknowledgement: "invalid",
      });
      assert.deepEqual([matterSnapshot(inS), matterSnapshot(inC)], snapshots);
      const recorded = {
        scoped_own_jurisdiction: recordOutcome(
          world.opsS,
          inS.consultation,
          "client_no_show",
        ).outcome,
        global: recordOutcome(world.ops, inC.consultation, "attorney_no_show")
          .outcome,
      };
      assert.deepEqual(recorded, {
        scoped_own_jurisdiction: "recorded",
        global: "recorded",
      });
      const audit = auditsOf(inS.consultation, "consultation.outcome_recorded");
      assert.deepEqual(
        [audit.length, audit[0].actor_type, audit[0].actor_user_id],
        [1, "staff", world.opsS.user],
      );
      return { refusals, recorded };
    },
  );

  await check(
    "STAFF-2 (never while the participants could still proceed) the window rule: inside the permitted window the outcome is refused window_open with the instant from which it may be recorded and its basis; it is accepted from the end of the window the governing scheduling version gives (configured: creation plus the requested duration plus the configured overrun for an instant Consultation; the Booking's end plus the overrun for a scheduled one that never became ready); without the timing keys the fail-safe rule applies (the nominal end plus 86400 seconds, the overrun key's own upper bound) and is audited as such; without a nominal end the outcome is refused window_unavailable; the attorney can still start a ready Consultation while its window is open",
    () => {
      const fresh = readyConsultation("S");
      const open = recordOutcome(
        world.ops,
        fresh.consultation,
        "client_no_show",
      );
      const created = ms(consultationRow(fresh.consultation).created_at);
      assert.deepEqual(
        [
          open.outcome,
          open.problem,
          open.recorded_at,
          ms(open.closes_at) - created,
        ],
        ["window_open", "configured", null, (30 * 60 + 300) * 1000],
      );
      assert.equal(consultationRow(fresh.consultation).state, "ready");
      // The participants can still proceed: the attorney starts it.
      assert.equal(start(fresh).outcome, "started");
      // One second short of the window's end is still refused.
      const almost = readyConsultation("S");
      sql(
        `begin;
         set local session_replication_role = replica;
         update public.consultations set created_at = now() - interval '2090 seconds' where id = '${almost.consultation}';
         commit;`,
      );
      assert.equal(
        recordOutcome(world.ops, almost.consultation, "client_no_show").outcome,
        "window_open",
      );
      const configured = staleReady("S");
      const recorded = recordOutcome(
        world.ops,
        configured.consultation,
        "client_no_show",
      );
      assert.equal(recorded.outcome, "recorded", JSON.stringify(recorded));
      const configuredAudit = auditsOf(
        configured.consultation,
        "consultation.outcome_recorded",
      )[0];
      assert.equal(configuredAudit.after.window_basis, "configured");
      assert.ok(
        configuredAudit.policy_references.some(
          (r) =>
            r.policy_type_code === "scheduling" &&
            r.policy_version_id === world.policies.S.scheduling,
        ),
      );

      // A scheduled Consultation that never became ready: its Booking moved 4
      // days into the past (fixture).
      const scheduled = scheduledConsultation("S");
      assert.equal(
        recordOutcome(world.ops, scheduled.consultation, "both_no_show")
          .outcome,
        "window_open",
      );
      shiftScheduled(scheduled.consultation, 4 * 1440);
      assert.equal(consultationRow(scheduled.consultation).state, "scheduled");
      assert.equal(
        recordOutcome(world.ops, scheduled.consultation, "both_no_show")
          .outcome,
        "recorded",
      );
      assert.deepEqual(
        [
          consultationRow(scheduled.consultation).state,
          consultationRow(scheduled.consultation).outcome_code,
          roomOf(scheduled.consultation),
        ],
        ["no_show", "both_no_show", null],
      );

      // No timing keys (jurisdiction F): the fail-safe rule.
      const failSafe = readyConsultation("F");
      const failSafeOpen = recordOutcome(
        world.ops,
        failSafe.consultation,
        "neither_connected",
      );
      assert.deepEqual(
        [
          failSafeOpen.outcome,
          failSafeOpen.problem,
          ms(failSafeOpen.closes_at) -
            ms(consultationRow(failSafe.consultation).created_at),
        ],
        ["window_open", "fail_safe", (30 * 60 + 86400) * 1000],
      );
      shiftConsultation(failSafe.consultation, 30 + 1440 - 1);
      assert.equal(
        recordOutcome(world.ops, failSafe.consultation, "neither_connected")
          .outcome,
        "window_open",
      );
      shiftConsultation(failSafe.consultation, 2);
      assert.equal(
        recordOutcome(world.ops, failSafe.consultation, "neither_connected")
          .outcome,
        "recorded",
      );
      const failSafeAudit = auditsOf(
        failSafe.consultation,
        "consultation.outcome_recorded",
      )[0];
      assert.equal(failSafeAudit.after.window_basis, "fail_safe");
      assert.ok(
        !failSafeAudit.policy_references.some(
          (r) => r.policy_type_code === "scheduling",
        ),
      );

      // Fixture (owner, triggers bypassed): no requested duration, so no
      // nominal end exists.
      const unknown = readyConsultation("F");
      sql(
        `begin;
         set local session_replication_role = replica;
         update public.consultation_requests set requested_duration_minutes = null where id = '${unknown.request}';
         update public.consultations set created_at = created_at - interval '10 days' where id = '${unknown.consultation}';
         commit;`,
      );
      const unavailable = recordOutcome(
        world.ops,
        unknown.consultation,
        "neither_connected",
      );
      assert.deepEqual(
        [unavailable.outcome, consultationRow(unknown.consultation).state],
        ["window_unavailable", "ready"],
      );
      return {
        window_open: open,
        fail_safe_open: failSafeOpen,
        unavailable: unavailable.outcome,
      };
    },
  );

  await check(
    "STAFF-3 (DM section 2.4; PM rows 14 to 18) each staff outcome and its state: a Consultation that never started becomes no_show (client_no_show | attorney_no_show | both_no_show) or technical_failure (neither_connected); a live one becomes completed (manual_resolution) or technical_failure (mid_consultation_failure); an outcome of the other kind answers not_applicable with the state, a decided Consultation already_decided with its state, each changing nothing; a recorded outcome carries its end instant, never a start it did not have, and closes the Media Room",
    () => {
      const table = {};
      for (const code of [
        "client_no_show",
        "attorney_no_show",
        "both_no_show",
        "neither_connected",
      ]) {
        const s = staleReady("S");
        const live = recordOutcome(world.ops, s.consultation, code);
        assert.equal(
          live.outcome,
          "recorded",
          `${code} ${JSON.stringify(live)}`,
        );
        const row = consultationRow(s.consultation);
        assert.equal(ms(row.ended_at), ms(live.recorded_at));
        assert.equal(roomOf(s.consultation).state, "closing");
        table[code] =
          `${row.state}/${row.outcome_code}/${row.started_at === null ? "never_started" : "started"}`;
      }
      for (const code of ["manual_resolution", "mid_consultation_failure"]) {
        const s = staleLive("S");
        const done = recordOutcome(world.ops, s.consultation, code, true);
        assert.equal(
          done.outcome,
          "recorded",
          `${code} ${JSON.stringify(done)}`,
        );
        const row = consultationRow(s.consultation);
        assert.equal(roomOf(s.consultation).state, "closing");
        table[code] =
          `${row.state}/${row.outcome_code}/${row.started_at === null ? "never_started" : "started"}`;
      }
      assert.deepEqual(table, {
        client_no_show: "no_show/client_no_show/never_started",
        attorney_no_show: "no_show/attorney_no_show/never_started",
        both_no_show: "no_show/both_no_show/never_started",
        neither_connected: "technical_failure/neither_connected/never_started",
        manual_resolution: "completed/manual_resolution/started",
        mid_consultation_failure:
          "technical_failure/mid_consultation_failure/started",
      });
      const ready = staleReady("S");
      const live = staleLive("S");
      const snapshots = [matterSnapshot(ready), matterSnapshot(live)];
      const refusals = {
        ready_manual_resolution: recordOutcome(
          world.ops,
          ready.consultation,
          "manual_resolution",
          true,
        ),
        ready_mid_failure: recordOutcome(
          world.ops,
          ready.consultation,
          "mid_consultation_failure",
          true,
        ).outcome,
        live_no_show: recordOutcome(
          world.ops,
          live.consultation,
          "attorney_no_show",
          true,
        ),
        live_neither_connected: recordOutcome(
          world.ops,
          live.consultation,
          "neither_connected",
          true,
        ).outcome,
      };
      assert.deepEqual(refusals, {
        ready_manual_resolution: {
          outcome: "not_applicable",
          problem: "ready",
          recorded_at: null,
          closes_at: null,
        },
        ready_mid_failure: "not_applicable",
        live_no_show: {
          outcome: "not_applicable",
          problem: "live",
          recorded_at: null,
          closes_at: null,
        },
        live_neither_connected: "not_applicable",
      });
      assert.deepEqual(
        [matterSnapshot(ready), matterSnapshot(live)],
        snapshots,
      );
      assert.equal(
        recordOutcome(world.ops, ready.consultation, "client_no_show").outcome,
        "recorded",
      );
      const decided = matterSnapshot(ready);
      assert.deepEqual(
        recordOutcome(world.ops, ready.consultation, "attorney_no_show"),
        {
          outcome: "already_decided",
          problem: "no_show",
          recorded_at: null,
          closes_at: null,
        },
      );
      assert.equal(matterSnapshot(ready), decided);
      return table;
    },
  );

  await check(
    "STAFF-4 (MBS section 16; PS section 18) the decision snapshots the S9 participation evidence into its audit event (attorney joined, client joined, both present, either left, provider sessions, interruptions) and a decision the evidence contradicts needs the explicit acknowledgement: with the client observed joining, client_no_show, both_no_show and neither_connected answer evidence_conflict and change nothing until acknowledged, then are recorded as an acknowledged evidence conflict, while attorney_no_show is recorded without one; with both observed present together a manual resolution is recorded without a conflict; with nobody observed, mid_consultation_failure needs the acknowledgement; absence of evidence contradicts no no-show",
    () => {
      const withClient = () => {
        const s = readyConsultation("S");
        openRoom(roomOf(s.consultation).id);
        observeParticipants(s, ["client"], { left: ["client"] });
        shiftConsultation(s.consultation, PAST_WINDOW_MINUTES);
        return s;
      };
      const conflicts = {};
      for (const code of [
        "client_no_show",
        "both_no_show",
        "neither_connected",
      ]) {
        const s = withClient();
        const snapshot = matterSnapshot(s);
        const refused = recordOutcome(world.ops, s.consultation, code);
        assert.equal(matterSnapshot(s), snapshot, code);
        const acknowledged = recordOutcome(
          world.ops,
          s.consultation,
          code,
          true,
        );
        const audit = auditsOf(
          s.consultation,
          "consultation.outcome_recorded",
        )[0];
        conflicts[code] = [
          refused.outcome,
          acknowledged.outcome,
          audit.after.evidence_conflict,
          audit.after.evidence_conflict_acknowledged,
        ];
        assert.deepEqual(audit.after.evidence, {
          attorney_joined: false,
          client_joined: true,
          both_present: false,
          either_left: true,
          provider_sessions: 1,
          interruptions: 0,
        });
      }
      for (const row of Object.values(conflicts)) {
        assert.deepEqual(row, ["evidence_conflict", "recorded", true, true]);
      }
      const consistent = withClient();
      assert.equal(
        recordOutcome(world.ops, consistent.consultation, "attorney_no_show")
          .outcome,
        "recorded",
      );
      const consistentAudit = auditsOf(
        consistent.consultation,
        "consultation.outcome_recorded",
      )[0];
      assert.deepEqual(
        [
          consistentAudit.after.evidence_conflict,
          consistentAudit.after.evidence_conflict_acknowledged,
          consistentAudit.after.evidence.client_joined,
        ],
        [false, false, true],
      );

      // Both observed present together in a live Consultation.
      const together = readyConsultation("S");
      openRoom(roomOf(together.consultation).id);
      assert.equal(start(together).outcome, "started");
      observeParticipants(together, ["client", "attorney"]);
      shiftConsultation(together.consultation, PAST_WINDOW_MINUTES);
      assert.equal(
        recordOutcome(world.ops, together.consultation, "manual_resolution")
          .outcome,
        "recorded",
      );
      const togetherAudit = auditsOf(
        together.consultation,
        "consultation.outcome_recorded",
      )[0];
      assert.deepEqual(
        [
          togetherAudit.after.evidence.both_present,
          togetherAudit.after.evidence.attorney_joined,
          togetherAudit.after.evidence_conflict,
        ],
        [true, true, false],
      );

      // Nobody observed in a live Consultation.
      const nobody = staleLive("S");
      const nobodySnapshot = matterSnapshot(nobody);
      const unacknowledged = recordOutcome(
        world.ops,
        nobody.consultation,
        "mid_consultation_failure",
      );
      assert.equal(unacknowledged.outcome, "evidence_conflict");
      assert.equal(matterSnapshot(nobody), nobodySnapshot);

      // Absence of evidence contradicts no no-show: recorded as the staff
      // member's decision, with the empty evidence on record.
      const silent = staleReady("S");
      assert.equal(
        recordOutcome(world.ops, silent.consultation, "attorney_no_show")
          .outcome,
        "recorded",
      );
      const silentAudit = auditsOf(
        silent.consultation,
        "consultation.outcome_recorded",
      )[0];
      assert.deepEqual(silentAudit.after.evidence, {
        attorney_joined: false,
        client_joined: false,
        both_present: false,
        either_left: false,
        provider_sessions: 0,
        interruptions: 0,
      });
      assert.equal(silentAudit.after.evidence_conflict, false);
      return { conflicts, nobody_observed: unacknowledged.outcome };
    },
  );

  await check(
    "STAFF-5 (PM row 17, settled: release the authorization if uncaptured, refund if captured; the client is not charged) neither_connected with an authorized attempt requests its release through the S7 release path in the same transaction (release_pending, one system audit event, one payment.release job) and the provider's confirmation ends it authorization_released with no ledger entry and no exception; with funds captured at the acceptance nothing is refunded automatically: the payment stays captured and one critical funds_retained_after_technical_failure exception cites PM row 17 with the amounts and the refund policy version for a human refund",
    () => {
      const authorized = staleReady("S");
      assert.equal(livePaymentOf(authorized.request).state, "authorized");
      assert.equal(
        recordOutcome(world.ops, authorized.consultation, "neither_connected")
          .outcome,
        "recorded",
      );
      assert.equal(paymentOf(authorized.payment).state, "release_pending");
      const releaseAudit = auditsOf(
        authorized.payment,
        "payment.release_requested",
      );
      assert.deepEqual(
        [
          releaseAudit.length,
          releaseAudit[0].actor_type,
          releaseAudit[0].reason_code,
        ],
        [1, "system", "consultation_neither_connected"],
      );
      const released = runJob(
        "payment.release",
        "payment_transaction",
        authorized.payment,
        (context) => {
          assert.equal(context.outcome, "act");
          return obs("authorization_released", {
            payment_reference: authorized.reference,
          });
        },
      );
      assert.equal(released.outcome, "applied");
      assert.equal(
        paymentOf(authorized.payment).state,
        "authorization_released",
      );
      assert.deepEqual(exceptionsOf(authorized.payment), []);
      assert.deepEqual(ledgerOf(authorized.payment), []);
      const recordedAudit = auditsOf(
        authorized.consultation,
        "consultation.outcome_recorded",
      )[0];
      assert.deepEqual(
        [
          recordedAudit.after.payment_matrix_row,
          recordedAudit.after.payment_consequence,
          recordedAudit.after.payment_state,
        ],
        [17, "release_requested", "release_pending"],
      );

      const captured = staleReady("A");
      const paymentBefore = JSON.stringify(livePaymentOf(captured.request));
      assert.equal(livePaymentOf(captured.request).state, "captured");
      const refundJobs = () =>
        Number(
          sql(
            "select count(*) from public.operational_jobs where job_type = 'payment.refund';",
          ),
        );
      const refundJobsBefore = refundJobs();
      assert.equal(
        recordOutcome(world.ops, captured.consultation, "neither_connected")
          .outcome,
        "recorded",
      );
      assert.equal(
        JSON.stringify(livePaymentOf(captured.request)),
        paymentBefore,
      );
      const items = exceptionRows(`canonical_id = '${captured.payment}'`);
      assert.equal(items.length, 1);
      assert.deepEqual(
        [
          items[0].exception_type,
          items[0].severity,
          items[0].status,
          items[0].evidence.payment_matrix_rows,
          items[0].evidence.payment_state,
          items[0].evidence.amount_captured_minor,
          items[0].evidence.amount_refunded_minor,
          items[0].evidence.refund_policy_version_id,
        ],
        [
          "funds_retained_after_technical_failure",
          "critical",
          "open",
          [17],
          "captured",
          captured.total,
          0,
          world.policies.A.refund,
        ],
      );
      assert.equal(refundJobs(), refundJobsBefore);
      assert.equal(
        auditsOf(captured.consultation, "consultation.outcome_recorded")[0]
          .after.payment_consequence,
        "refund_review",
      );
      return {
        authorized: "authorization_released",
        captured: items[0].evidence,
      };
    },
  );

  await check(
    "STAFF-6 (PM rows 14, 15, 16 and 18: policy-gated) every other staff outcome with a live payment attempt moves nothing and opens exactly one high outcome_payment_review exception citing its own PM row, the outcome, the payment state, the evidence snapshot and the cancellation and refund policy versions the payment recorded; without any payment attempt it opens none",
    () => {
      const rows = {};
      for (const [code, row, build, acknowledge] of [
        ["client_no_show", 14, () => staleReady("S"), false],
        ["attorney_no_show", 15, () => staleReady("S"), false],
        ["both_no_show", 16, () => staleReady("S"), false],
        ["mid_consultation_failure", 18, () => staleLive("S"), true],
      ]) {
        const s = build();
        const paymentBefore = JSON.stringify(livePaymentOf(s.request));
        assert.equal(
          recordOutcome(world.ops, s.consultation, code, acknowledge).outcome,
          "recorded",
          code,
        );
        assert.equal(
          JSON.stringify(livePaymentOf(s.request)),
          paymentBefore,
          code,
        );
        const items = exceptionRows(
          `canonical_id = '${s.payment}' and exception_type = 'outcome_payment_review'`,
        );
        assert.equal(items.length, 1, code);
        assert.equal(
          keysOf(items[0].evidence),
          "cancellation_policy_version_id,evidence,outcome_code,payment_matrix_rows,payment_state,refund_policy_version_id",
        );
        rows[code] = [
          items[0].severity,
          items[0].evidence.payment_matrix_rows,
          items[0].evidence.outcome_code,
          items[0].evidence.payment_state,
        ];
        assert.equal(
          items[0].evidence.refund_policy_version_id,
          world.policies.S.refund,
        );
      }
      assert.deepEqual(rows, {
        client_no_show: ["high", [14], "client_no_show", "authorized"],
        attorney_no_show: ["high", [15], "attorney_no_show", "authorized"],
        both_no_show: ["high", [16], "both_no_show", "authorized"],
        mid_consultation_failure: [
          "high",
          [18],
          "mid_consultation_failure",
          "captured",
        ],
      });
      const unpaid = unpaidScheduledConsultation();
      shiftScheduled(unpaid.consultation, 4 * 1440);
      const before = s11Counts();
      assert.equal(
        recordOutcome(world.ops, unpaid.consultation, "client_no_show").outcome,
        "recorded",
      );
      assert.equal(
        deltaOf(before, s11Counts()).reconciliation_exceptions,
        undefined,
      );
      assert.equal(
        auditsOf(unpaid.consultation, "consultation.outcome_recorded")[0].after
          .payment_consequence,
        "none",
      );
      return rows;
    },
  );

  await check(
    "STAFF-7 (PM row 20 through a manual resolution) completed / manual_resolution follows the S9 completion rule: with capture at_consultation_completion the authorized attempt's capture is requested in the same transaction; with capture at the start the captured payment is left as it is; the staff audit event carries the payment_flow version, the capture facts and the evidence snapshot; both participants are told the recorded outcome and the client that a review is available",
    () => {
      const atCompletion = staleLive("C", { captured: false });
      assert.equal(livePaymentOf(atCompletion.request).state, "authorized");
      const done = recordOutcome(
        world.ops,
        atCompletion.consultation,
        "manual_resolution",
        true,
      );
      assert.equal(done.outcome, "recorded", JSON.stringify(done));
      assert.equal(paymentOf(atCompletion.payment).state, "capture_pending");
      const audit = auditsOf(
        atCompletion.consultation,
        "consultation.outcome_recorded",
      );
      assert.equal(audit.length, 1);
      assert.deepEqual(
        [
          audit[0].actor_type,
          audit[0].actor_user_id,
          audit[0].reason_code,
          audit[0].after.state,
          audit[0].after.outcome_code,
          audit[0].after.capture_timing,
          audit[0].after.capture_requested,
          audit[0].after.evidence_conflict,
          audit[0].after.window_basis,
          audit[0].policy_references,
        ],
        [
          "staff",
          world.ops.user,
          "manual_resolution",
          "completed",
          "manual_resolution",
          "at_consultation_completion",
          true,
          true,
          "configured",
          [
            {
              policy_type_code: "payment_flow",
              policy_version_id: world.policies.C.payment_flow,
            },
          ],
        ],
      );
      const outcomeOnly = (pairs) =>
        pairs.filter(([type]) => type !== "consultation_ready");
      assert.deepEqual(
        outcomeOnly(
          notificationPairs(
            atCompletion.client.user,
            atCompletion.consultation,
          ),
        ),
        [
          ["consultation_outcome_recorded", "in_app"],
          ["consultation_outcome_recorded", "email"],
          ["review_available", "in_app"],
          ["review_available", "email"],
        ],
      );
      assert.deepEqual(
        outcomeOnly(
          notificationPairs(
            atCompletion.lawyer.user,
            atCompletion.consultation,
          ),
        ),
        [
          ["consultation_outcome_recorded", "in_app"],
          ["consultation_outcome_recorded", "email"],
        ],
      );
      const atStart = staleLive("S");
      const paymentBefore = JSON.stringify(livePaymentOf(atStart.request));
      assert.equal(
        recordOutcome(
          world.ops,
          atStart.consultation,
          "manual_resolution",
          true,
        ).outcome,
        "recorded",
      );
      assert.equal(
        JSON.stringify(livePaymentOf(atStart.request)),
        paymentBefore,
      );
      assert.equal(
        auditsOf(atStart.consultation, "consultation.outcome_recorded")[0].after
          .capture_requested,
        false,
      );
      // A no-show notifies both participants and offers no review.
      const noShow = staleReady("S");
      assert.equal(
        recordOutcome(world.ops, noShow.consultation, "both_no_show").outcome,
        "recorded",
      );
      for (const user of [noShow.client.user, noShow.lawyer.user]) {
        assert.deepEqual(
          outcomeOnly(notificationPairs(user, noShow.consultation)),
          [
            ["consultation_outcome_recorded", "in_app"],
            ["consultation_outcome_recorded", "email"],
          ],
        );
      }
      return { capture_requested_at_completion: true };
    },
  );

  await check(
    "STAFF-8 (TA section 41: minimum necessary information) the operations reads: staff_stale_consultations lists exactly the undecided Consultations whose outcome may now be recorded, oldest first, in the jurisdictions the caller holds the capability for (a scoped holder sees only its jurisdiction; no capability, aal1 or another capability sees nothing), with identifiers, states, times, three participation facts and the latest payment state and nothing else; staff_consultation answers one Consultation with the evidence summary and whether its outcome may be recorded now, never a participant's identity; once the outcome is recorded the Consultation leaves the queue",
    () => {
      const inS = staleReady("S");
      const inC = staleLive("C", { captured: false });
      const fresh = readyConsultation("S");
      const global = staleQueueAs(world.ops);
      const scoped = staleQueueAs(world.opsS);
      const ids = (rows) => rows.map((r) => r.consultation_id);
      assert.ok(ids(global).includes(inS.consultation));
      assert.ok(ids(global).includes(inC.consultation));
      assert.ok(!ids(global).includes(fresh.consultation));
      assert.ok(ids(scoped).includes(inS.consultation));
      assert.ok(!ids(scoped).includes(inC.consultation));
      assert.ok(scoped.every((r) => r.jurisdiction_id === world.J.S));
      assert.deepEqual(
        [
          staleQueueAs(world.plainStaff).length,
          staleQueueAs(world.finance).length,
          staleQueueAs(world.ops, AAL1).length,
          rowsJson(
            inS.lawyer,
            "select row_to_json(x)::text from public.staff_stale_consultations(0) x;",
          ).length,
        ],
        [0, 0, 0, 0],
      );
      const closes = global.map((r) => ms(r.closes_at));
      assert.deepEqual(
        closes,
        [...closes].sort((a, b) => a - b),
      );
      assert.equal(
        keysOf(global[0]),
        "attorney_joined,booking_ends_at,booking_starts_at,both_present,client_joined,closes_at,consultation_id,jurisdiction_id,payment_state,request_path,started_at,state,window_basis",
      );
      const one = staffConsultationAs(world.opsS, inS.consultation);
      assert.equal(one.length, 1);
      assert.equal(
        keysOf(one[0]),
        "attorney_joined,booking_ends_at,booking_starts_at,both_present,client_joined,closes_at,consultation_id,duration_minutes,either_left,ended_at,interruptions,jurisdiction_id,open_exceptions,outcome_code,payment_state,provider_sessions,recordable,request_path,started_at,state,window_basis",
      );
      assert.deepEqual(
        [
          one[0].state,
          one[0].recordable,
          one[0].window_basis,
          one[0].payment_state,
          one[0].attorney_joined,
          one[0].provider_sessions,
          one[0].open_exceptions,
        ],
        ["ready", true, "configured", "authorized", false, 0, 0],
      );
      assert.deepEqual(
        [
          staffConsultationAs(world.opsS, inC.consultation).length,
          staffConsultationAs(world.plainStaff, inS.consultation).length,
          staffConsultationAs(world.ops, inS.consultation, AAL1).length,
          staffConsultationAs(world.ops, uid()).length,
          staffConsultationAs(world.ops, fresh.consultation)[0].recordable,
        ],
        [0, 0, 0, 0, false],
      );
      assert.equal(
        recordOutcome(world.ops, inS.consultation, "client_no_show").outcome,
        "recorded",
      );
      assert.ok(!ids(staleQueueAs(world.ops)).includes(inS.consultation));
      const after = staffConsultationAs(world.ops, inS.consultation)[0];
      assert.deepEqual(
        [
          after.state,
          after.outcome_code,
          after.recordable,
          after.open_exceptions,
        ],
        ["no_show", "client_no_show", false, 1],
      );
      return { queue_columns: keysOf(global[0]) };
    },
  );
}

// ---------------------------------------------------------------------------
// MBS section 16 failure tests 1 and 2 (the others are with their subjects)
// ---------------------------------------------------------------------------

async function completionFailureTests() {
  await check(
    "MBS16-1 (MBS section 16 failure test: a completed Consultation plus conflicting provider evidence creates reconciliation rather than a silent rewrite; PM INV-13) provider evidence that arrives after a recorded outcome (a normal completion, a cancellation and a staff-recorded no-show) changes nothing canonical: the Consultation, its outcome, its payment, its Booking and its Engagement are unchanged, and each late observation opens the S9 high media_activity_outside_consultation exception for the operations family",
    () => {
      const cases = {};
      const lateEvent = (s) => {
        const room = roomOf(s.consultation);
        return mediaEvent("participant.joined", {
          kind: "participant_joined",
          room_name: roomName(room.id),
          participant_reference: participantRef(),
          user_id: s.lawyer.user,
          joined_at: isoIn(180),
        });
      };
      const completed = completedConsultation("S");
      const cancelled = readyConsultation("S");
      assert.equal(clientCancel(cancelled).outcome, "cancelled");
      const noShow = staleReady("S");
      assert.equal(
        recordOutcome(world.ops, noShow.consultation, "attorney_no_show")
          .outcome,
        "recorded",
      );
      for (const [name, s] of Object.entries({
        completed,
        cancelled,
        noShow,
      })) {
        const canonical = () =>
          JSON.stringify([
            consultationRow(s.consultation),
            livePaymentOf(s.request),
            bookingsOf(s.consultation),
            engagementsOf(s.consultation),
          ]);
        const before = canonical();
        const late = lateEvent(s);
        assert.equal(late.processing, "contradiction", `${name} ${late.line}`);
        assert.equal(canonical(), before, name);
        const items = itemsOf(
          "media_activity_outside_consultation",
          s.consultation,
        );
        assert.equal(items.length, 1, name);
        cases[name] = [
          consultationRow(s.consultation).state,
          consultationRow(s.consultation).outcome_code,
          items[0].severity,
          items[0].status,
        ];
      }
      assert.deepEqual(cases, {
        completed: ["completed", "normal", "high", "open"],
        cancelled: ["cancelled", "client_cancelled", "high", "open"],
        noShow: ["no_show", "attorney_no_show", "high", "open"],
      });
      const operations = familyAs(world.ops, "operations").filter(
        (e) => e.canonical_id === noShow.consultation,
      );
      assert.equal(operations.length, 1);
      return cases;
    },
  );

  await check(
    "MBS16-2 (MBS section 16 failure test: an attorney no-show is not inferred from a missing Daily callback alone) a ready Consultation with no provider observation at all, whose permitted window has ended, stays exactly as it is through every sweep (the S9 media sweep, the S6 expiry sweep) and through provider events of its room: nothing sets no_show, cancelled or technical_failure, nothing touches its payment and no exception about a no-show is opened; the participants still read it as ready; only a staff member's explicit decision records the no-show, with the empty evidence on record",
    () => {
      const s = readyConsultation("S");
      // While its window is open the provider reports a session of the room
      // that started and ended without anyone joining.
      const room = roomOf(s.consultation);
      openRoom(room.id);
      const reference = sessionRef();
      mediaEvent("meeting.started", {
        kind: "meeting_started",
        room_name: roomName(room.id),
        session_reference: reference,
        started_at: isoAgo(30),
      });
      mediaEvent("meeting.ended", {
        kind: "meeting_ended",
        room_name: roomName(room.id),
        session_reference: reference,
        started_at: isoAgo(30),
        ended_at: isoAgo(10),
      });
      // Fixture: the permitted window has ended.
      shiftConsultation(s.consultation, PAST_WINDOW_MINUTES);
      const snapshot = () =>
        JSON.stringify([
          consultationRow(s.consultation),
          livePaymentOf(s.request),
          engagementsOf(s.consultation),
        ]);
      const before = snapshot();
      const sweeps = [sweep(), sweep()];
      sql("select public.request_expiry_sweep();");
      assert.equal(snapshot(), before);
      assert.equal(
        Number(
          sql(
            `select count(*) from public.reconciliation_exceptions where source_id = '${s.consultation}' or canonical_id = '${s.consultation}';`,
          ),
        ),
        0,
      );
      assert.deepEqual(
        [
          clientView(s).state,
          attorneyView(s).state,
          clientView(s).outcome_code,
        ],
        ["ready", "ready", null],
      );
      // No function of the database takes a no-show without a caller: every
      // function that can record one requires a staff decision.
      const writers = sql(
        "select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc like '%''attorney_no_show''%' and p.prosrc like '%update public.consultations%';",
      );
      assert.equal(writers, "staff_record_consultation_outcome");
      assert.equal(
        recordOutcome(world.ops, s.consultation, "attorney_no_show").outcome,
        "recorded",
      );
      const audit = auditsOf(
        s.consultation,
        "consultation.outcome_recorded",
      )[0];
      assert.deepEqual(
        [
          audit.actor_type,
          audit.after.evidence.attorney_joined,
          audit.after.evidence.client_joined,
          audit.after.evidence_conflict,
        ],
        ["staff", false, false, false],
      );
      return { sweeps, only_writer: writers };
    },
  );
}

// ---------------------------------------------------------------------------
// REV: reviews
// ---------------------------------------------------------------------------

// A Consultation of a given attorney completed through the real commands.
function completedWith(who, key) {
  const s = acceptedConsultation({ key, who });
  assert.equal(start(s).outcome, "started");
  assert.equal(end(s).outcome, "completed");
  return s;
}

const publicReviewsOf = (attorney, role = "anon", sub = null) =>
  rowsAs(
    role,
    sub,
    `select row_to_json(x)::text from public.public_attorney_reviews(${lit(attorney)}) x;`,
  ).map((line) => JSON.parse(line));

const reviewQueueAs = (staff, state, options = {}) =>
  rowsJson(
    staff,
    `select row_to_json(x)::text from public.staff_review_queue(${lit(state)}, 0) x;`,
    options,
  );

const moderate = (staff, review, decision, options = {}) =>
  asStaff(staff, MODERATE_SQL(review, decision), options);

async function reviewChecks() {
  await check(
    "MBS16-3 (MBS section 16 failure test: invalid review attempts fail server-side; TA section 49) the server establishes every fact of a review: only the Consultation's own client, only a completed Consultation; another client, the Consultation's attorney, an unknown id and the client's own ready, cancelled, no-show and technical-failure Consultations answer not_eligible alike (no existence oracle) and anon cannot call at all; a rating outside 1 to 5, a missing rating, a text over 20,000 characters and a missing id are invalid; nothing is written by any refusal; the attorney is never an input (the function takes the Consultation, the rating and the text, and the relation has no attorney column); a valid submission is recorded submitted, trimmed, not public, audited without its text or rating; a whitespace-only text is stored as no text; every completion reason qualifies (normal, early by agreement, manual resolution)",
    () => {
      const s = completedConsultation("S");
      const stranger = newClient();
      const ready = readyConsultation("S");
      const cancelled = readyConsultation("S");
      assert.equal(clientCancel(cancelled).outcome, "cancelled");
      const noShow = staleReady("S");
      assert.equal(
        recordOutcome(world.ops, noShow.consultation, "attorney_no_show")
          .outcome,
        "recorded",
      );
      const failure = staleReady("S");
      assert.equal(
        recordOutcome(world.ops, failure.consultation, "neither_connected")
          .outcome,
        "recorded",
      );
      const before = count("reviews");
      const attempts = {
        other_client: submitReview(stranger, s.consultation, 5, "Synthetic.")
          .outcome,
        attorney: submitReview(s.lawyer, s.consultation, 5, "Synthetic.", {})
          .outcome,
        anon: as("anon", null, REVIEW_SQL(s.consultation, 5, "Synthetic.")),
        unknown: submitReview(s.client, uid(), 5, null).outcome,
        own_ready: submitReview(ready.client, ready.consultation, 5, null)
          .outcome,
        own_cancelled: submitReview(
          cancelled.client,
          cancelled.consultation,
          5,
          null,
        ).outcome,
        own_no_show: submitReview(noShow.client, noShow.consultation, 5, null)
          .outcome,
        own_technical_failure: submitReview(
          failure.client,
          failure.consultation,
          5,
          null,
        ).outcome,
        rating_zero: submitReview(s.client, s.consultation, 0, null).outcome,
        rating_six: submitReview(s.client, s.consultation, 6, null).outcome,
        rating_missing: submitReview(s.client, s.consultation, null, null)
          .outcome,
        text_too_long: submitReview(
          s.client,
          s.consultation,
          5,
          "x".repeat(20001),
        ).outcome,
        missing_id: as(
          "authenticated",
          s.client.auth,
          "select outcome from public.review_submit(null, 5, null);",
          AAL1,
        ),
      };
      assert.deepEqual(attempts, {
        other_client: "not_eligible",
        attorney: "not_eligible",
        anon: "ERROR 42501",
        unknown: "not_eligible",
        own_ready: "not_eligible",
        own_cancelled: "not_eligible",
        own_no_show: "not_eligible",
        own_technical_failure: "not_eligible",
        rating_zero: "invalid",
        rating_six: "invalid",
        rating_missing: "invalid",
        text_too_long: "invalid",
        missing_id: "invalid",
      });
      assert.equal(count("reviews"), before);
      assert.equal(
        sql(
          "select pg_get_function_identity_arguments('public.review_submit(uuid, integer, text)'::regprocedure);",
        ),
        "p_consultation_id uuid, p_rating integer, p_review_text text",
      );
      assert.equal(
        sql(
          "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'reviews' and column_name like '%attorney%';",
        ),
        "0",
      );
      const submitted = submitReview(
        s.client,
        s.consultation,
        4,
        "  Synthetic review text.\n",
      );
      assert.equal(submitted.outcome, "submitted");
      const row = reviewRow(submitted.review);
      assert.deepEqual(
        [
          row.consultation_id,
          row.client_id,
          row.rating,
          row.review_text,
          row.state,
          row.submitted_at !== null,
          row.published_at,
          row.moderated_at,
        ],
        [
          s.consultation,
          s.client.client,
          4,
          "Synthetic review text.",
          "submitted",
          true,
          null,
          null,
        ],
      );
      const audit = auditsFor("review", submitted.review);
      assert.deepEqual(
        audit.map((a) => [
          a.action,
          a.actor_type,
          a.actor_user_id,
          keysOf(a.after),
        ]),
        [
          [
            "review.submitted",
            "client",
            s.client.user,
            "consultation_id,state",
          ],
        ],
      );
      assert.doesNotMatch(JSON.stringify(audit), /Synthetic review text/);
      assert.deepEqual(publicReviewsOf(s.lawyer.profile), []);
      // Every completion reason qualifies.
      const early = liveConsultation("C");
      assert.equal(endEarly(early).outcome, "completed");
      const blank = submitReview(early.client, early.consultation, 5, "  \n ");
      assert.equal(blank.outcome, "submitted");
      assert.equal(reviewRow(blank.review).review_text, null);
      const manual = staleLive("S");
      assert.equal(
        recordOutcome(world.ops, manual.consultation, "manual_resolution", true)
          .outcome,
        "recorded",
      );
      const longest = submitReview(
        manual.client,
        manual.consultation,
        1,
        "y".repeat(20000),
      );
      assert.equal(longest.outcome, "submitted");
      assert.equal(reviewRow(longest.review).review_text.length, 20000);
      return attempts;
    },
  );

  await check(
    "MBS16-4 (MBS section 16 failure test: duplicate reviews are prevented; PS section 21.1 unique key) one review per Consultation: the client's second submission answers already_reviewed and writes nothing, whatever its rating or text; another client asking about the same Consultation still answers not_eligible (no oracle about the review); the owner role cannot insert a second review either (23505)",
    () => {
      const s = completedConsultation("S");
      const first = submitReview(s.client, s.consultation, 5, "First.");
      assert.equal(first.outcome, "submitted");
      const snapshot = JSON.stringify(reviewRow(first.review));
      const before = s11Counts();
      const answers = {
        again: submitReview(s.client, s.consultation, 1, "Second.").outcome,
        again_same: submitReview(s.client, s.consultation, 5, "First.").outcome,
        other_client: submitReview(newClient(), s.consultation, 5, null)
          .outcome,
        owner_insert: refused(
          `insert into public.reviews (consultation_id, client_id, rating, state, submitted_at) values ('${s.consultation}', '${s.client.client}', 3, 'submitted', now());`,
        ),
      };
      assert.deepEqual(answers, {
        again: "already_reviewed",
        again_same: "already_reviewed",
        other_client: "not_eligible",
        owner_insert: "23505",
      });
      assert.equal(JSON.stringify(reviewRow(first.review)), snapshot);
      assert.deepEqual(deltaOf(before, s11Counts()), {});
      assert.equal(
        count("reviews", `consultation_id = '${s.consultation}'`),
        1,
      );
      return answers;
    },
  );

  await check(
    "REV-1 (PS section 21.1; PS section 32) the review guard holds for every role, the owner included: a review is recorded only submitted, for a completed Consultation and that Consultation's client, with a rating from 1 to 5 and a text that is not blank; its Consultation, client, rating, text and submission never change; it moves only submitted -> published | rejected and published -> rejected, each with its moderation instant, never back; the publication instant is recorded once, at the first publication; a rejected review is final; a review is never deleted or truncated",
    () => {
      const s = completedConsultation("S");
      const ready = readyConsultation("S");
      const other = newClient();
      const insert = (consultation, client, extra = {}) => {
        const row = {
          consultation_id: `'${consultation}'`,
          client_id: `'${client}'`,
          rating: "5",
          review_text: "null",
          state: "'submitted'",
          submitted_at: "now()",
          ...extra,
        };
        return `insert into public.reviews (${Object.keys(row).join(", ")}) values (${Object.values(row).join(", ")});`;
      };
      const inserts = {
        not_completed: refused(insert(ready.consultation, ready.client.client)),
        other_client: refused(insert(s.consultation, other.client)),
        published_at_insert: refused(
          insert(s.consultation, s.client.client, {
            state: "'published'",
            published_at: "now()",
            moderated_at: "now()",
          }),
        ),
        rating_six: refused(
          insert(s.consultation, s.client.client, { rating: "6" }),
        ),
        rating_zero: refused(
          insert(s.consultation, s.client.client, { rating: "0" }),
        ),
        blank_text: refused(
          insert(s.consultation, s.client.client, { review_text: "'  '" }),
        ),
        unknown_state: refused(
          insert(s.consultation, s.client.client, { state: "'draft'" }),
        ),
        no_submission: refused(
          insert(s.consultation, s.client.client, { submitted_at: "null" }),
        ),
      };
      for (const [name, code] of Object.entries(inserts)) {
        assert.equal(code, "23514", name);
      }
      const review = submitReview(s.client, s.consultation, 4, "Kept.").review;
      const set = (assignments) =>
        `update public.reviews set ${assignments} where id = '${review}';`;
      const publish =
        "state = 'published', published_at = now(), moderated_at = now()";
      const changes = {
        rating: refused(set("rating = 1")),
        text: refused(set("review_text = 'Changed.'")),
        submitted_at: refused(set("submitted_at = now()")),
        client: refused(set(`client_id = '${other.client}'`)),
        consultation: refused(set(`consultation_id = '${ready.consultation}'`)),
        publish_without_instant: refused(set("state = 'published'")),
        reject_with_publication: refused(
          set("state = 'rejected', published_at = now(), moderated_at = now()"),
        ),
        moderated_without_decision: refused(set("moderated_at = now()")),
        back_to_submitted: refused(
          `${set(publish)}\n${set("state = 'submitted', moderated_at = null")}`,
        ),
        republish_after_rejection: refused(
          `${set("state = 'rejected', moderated_at = now()")}\n${set(publish)}`,
        ),
        publication_rewritten: refused(
          `${set(publish)}\n${set("published_at = now() + interval '1 hour'")}`,
        ),
        publication_cleared_at_takedown: refused(
          `${set(publish)}\n${set("state = 'rejected', published_at = null, moderated_at = now()")}`,
        ),
        delete: refused(`delete from public.reviews where id = '${review}';`),
        truncate: refused("truncate public.reviews;"),
      };
      for (const [name, code] of Object.entries(changes)) {
        assert.equal(code, "55000", name);
      }
      // The permitted walk passes every rule (rolled back).
      acceptedThenRolledBack(
        `${set(publish)}\n${set("state = 'rejected', moderated_at = now()")}`,
      );
      assert.equal(reviewRow(review).state, "submitted");
      return { inserts, changes };
    },
  );

  await check(
    "REV-2 (MBS section 16 post-consultation publication workflow; PS section 30.4) moderation needs moderate_reviews for the Consultation's jurisdiction at aal2: a scoped holder moderates its jurisdiction's reviews and is denied another's; a staff member without the capability, the holder at aal1, the client and the attorney are denied; an unknown id answers not_found to a global holder and denied to a scoped one; publish makes a submitted review published with its publication and moderation instants; a second publish and an unknown decision are refused; reject takes a published review down (its first publication instant is kept) or rejects a submitted one; a rejected review cannot be published; each decision is audited with identifiers and states only, never the text; nothing is published without a staff decision",
    () => {
      const inS = completedConsultation("S");
      const inC = liveConsultation("C");
      assert.equal(end(inC).outcome, "completed");
      const reviewS = submitReview(
        inS.client,
        inS.consultation,
        5,
        "Moderated synthetic text.",
      ).review;
      const reviewC = submitReview(
        inC.client,
        inC.consultation,
        3,
        null,
      ).review;
      const refusals = {
        scoped_other_jurisdiction: moderate(
          world.moderatorS,
          reviewC,
          "publish",
        ),
        plain_staff: moderate(world.plainStaff, reviewS, "publish"),
        other_capability: moderate(world.ops, reviewS, "publish"),
        aal1: moderate(world.moderator, reviewS, "publish", AAL1),
        client: as(
          "authenticated",
          inS.client.auth,
          MODERATE_SQL(reviewS, "publish"),
          AAL1,
        ),
        attorney: asAttorney(inS.lawyer, MODERATE_SQL(reviewS, "publish")),
        unknown_global: moderate(world.moderator, uid(), "publish"),
        unknown_scoped: moderate(world.moderatorS, uid(), "publish"),
        unknown_decision: moderate(world.moderator, reviewS, "approve"),
      };
      assert.deepEqual(refusals, {
        scoped_other_jurisdiction: "denied",
        plain_staff: "denied",
        other_capability: "denied",
        aal1: "denied",
        client: "denied",
        attorney: "denied",
        unknown_global: "not_found",
        unknown_scoped: "denied",
        unknown_decision: "invalid",
      });
      assert.equal(reviewRow(reviewS).state, "submitted");
      assert.deepEqual(publicReviewsOf(inS.lawyer.profile), []);
      const walk = {
        publish: moderate(world.moderatorS, reviewS, "publish"),
        publish_again: moderate(world.moderator, reviewS, "publish"),
      };
      const published = reviewRow(reviewS);
      assert.deepEqual(
        [
          published.state,
          published.published_at !== null,
          ms(published.published_at) === ms(published.moderated_at),
        ],
        ["published", true, true],
      );
      walk.take_down = moderate(world.moderator, reviewS, "reject");
      const takenDown = reviewRow(reviewS);
      assert.deepEqual(
        [
          takenDown.state,
          ms(takenDown.published_at),
          ms(takenDown.moderated_at) >= ms(published.moderated_at),
        ],
        ["rejected", ms(published.published_at), true],
      );
      walk.publish_after_rejection = moderate(
        world.moderator,
        reviewS,
        "publish",
      );
      walk.reject_again = moderate(world.moderator, reviewS, "reject");
      walk.reject_submitted = moderate(world.moderator, reviewC, "reject");
      assert.deepEqual(walk, {
        publish: "applied",
        publish_again: "invalid_transition",
        take_down: "applied",
        publish_after_rejection: "invalid_transition",
        reject_again: "invalid_transition",
        reject_submitted: "applied",
      });
      const audits = auditsFor("review", reviewS).map((a) => [
        a.action,
        a.actor_type,
        a.actor_user_id,
        a.before,
        keysOf(a.after ?? {}),
      ]);
      assert.deepEqual(audits, [
        [
          "review.submitted",
          "client",
          inS.client.user,
          null,
          "consultation_id,state",
        ],
        [
          "review.published",
          "staff",
          world.moderatorS.user,
          { state: "submitted" },
          "consultation_id,state",
        ],
        [
          "review.taken_down",
          "staff",
          world.moderator.user,
          { state: "published" },
          "consultation_id,state",
        ],
      ]);
      assert.equal(auditsFor("review", reviewC)[1].action, "review.rejected");
      assert.equal(
        sql(
          "select count(*) from public.audit_events where resource_type = 'review' and (before_snapshot::text like '%Moderated synthetic%' or after_snapshot::text like '%Moderated synthetic%');",
        ),
        "0",
      );
      return { refusals, walk };
    },
  );

  await check(
    "REV-3 (PS P3: never store an aggregate rating; the S5 public profile's visibility rules; MBS section 10) the public read answers only an attorney's published reviews, each with exactly the rating, the text, the publication instant and the count and average of all the attorney's published reviews computed at read time: two published reviews answer count 2 and their average, a takedown changes both at once and a submitted or rejected review never appears; a text carrying a banned recommendation claim is withheld (the rating still counts); never a client identity, a Consultation id or a review id; an unlisted attorney (profile no longer approved), an unknown id and a null id answer no row, exactly as the public profile does; anon and authenticated may read and nothing is persisted; the attorney reads their own published reviews only at aal2; the client reads their completed Consultations with their own reviews; the moderation queue is scoped by jurisdiction",
    () => {
      const who = lawyer("S");
      const first = completedWith(who, "S");
      const second = completedWith(who, "S");
      const third = completedWith(who, "S");
      const fourth = completedWith(who, "S");
      const reviews = {
        first: submitReview(
          first.client,
          first.consultation,
          5,
          "Clear advice.",
        ).review,
        second: submitReview(
          second.client,
          second.consultation,
          2,
          "The best attorney, Rosuno recommends!",
        ).review,
        third: submitReview(third.client, third.consultation, 1, "Unpublished.")
          .review,
        fourth: submitReview(fourth.client, fourth.consultation, 4, null)
          .review,
      };
      assert.deepEqual(publicReviewsOf(who.profile), []);
      assert.equal(
        moderate(world.moderator, reviews.first, "publish"),
        "applied",
      );
      assert.equal(
        moderate(world.moderator, reviews.second, "publish"),
        "applied",
      );
      assert.equal(
        moderate(world.moderator, reviews.fourth, "reject"),
        "applied",
      );
      const beforeReads = s11Counts();
      const listed = publicReviewsOf(who.profile);
      assert.equal(listed.length, 2);
      for (const row of listed) {
        assert.equal(
          keysOf(row),
          "average_rating,published_at,rating,review_count,review_text",
        );
        assert.deepEqual([row.review_count, row.average_rating], [2, 3.5]);
      }
      assert.deepEqual(
        listed.map((row) => [row.rating, row.review_text]).sort(),
        [
          [2, null],
          [5, "Clear advice."],
        ],
      );
      const text = JSON.stringify(listed);
      for (const secret of [
        first.consultation,
        second.consultation,
        first.client.user,
        first.client.client,
        reviews.first,
        reviews.second,
      ]) {
        assert.ok(!text.includes(secret), secret);
      }
      assert.deepEqual(
        publicReviewsOf(who.profile, "authenticated", first.client.auth).map(
          (row) => row.review_count,
        ),
        [2, 2],
      );
      // A public read persists nothing.
      assert.deepEqual(deltaOf(beforeReads, s11Counts()), {});
      // The aggregate is derived at each read: a takedown changes it at once.
      assert.equal(
        moderate(world.moderator, reviews.second, "reject"),
        "applied",
      );
      const afterTakedown = publicReviewsOf(who.profile);
      assert.deepEqual(
        afterTakedown.map((row) => [
          row.rating,
          row.review_text,
          row.review_count,
          row.average_rating,
        ]),
        [[5, "Clear advice.", 1, 5]],
      );
      assert.equal(
        sql(
          "select count(*) from information_schema.columns where table_schema = 'public' and (column_name like '%average%' or column_name like '%rating_count%' or column_name like '%review_count%');",
        ),
        "0",
      );
      // Visibility: exactly the public profile's rule.
      const plantProfile = (state) =>
        sql(
          `begin;
           set local session_replication_role = replica;
           update public.attorney_profiles set profile_state = '${state}' where id = '${who.profile}';
           commit;`,
        );
      plantProfile("suspended");
      const unlisted = {
        reviews: publicReviewsOf(who.profile).length,
        profile: rowsAs(
          "anon",
          null,
          `select attorney_id from public.public_attorney_profile('${who.profile}', null);`,
        ).length,
      };
      plantProfile("approved");
      assert.deepEqual(unlisted, { reviews: 0, profile: 0 });
      assert.deepEqual(
        [
          publicReviewsOf(uid()).length,
          rowsAs(
            "anon",
            null,
            "select row_to_json(x)::text from public.public_attorney_reviews(null) x;",
          ).length,
          publicReviewsOf(who.profile).length,
        ],
        [0, 0, 1],
      );
      // The attorney's own read (aal2 only) and the client's own read.
      const own = rowsJson(
        who,
        "select row_to_json(x)::text from public.attorney_reviews() x;",
      );
      assert.deepEqual(
        own.map((row) => [keysOf(row), row.rating, row.review_text]),
        [["published_at,rating,review_text", 5, "Clear advice."]],
      );
      assert.deepEqual(
        [
          rowsJson(
            who,
            "select row_to_json(x)::text from public.attorney_reviews() x;",
            AAL1,
          ).length,
          rowsJson(
            lawyer("S"),
            "select row_to_json(x)::text from public.attorney_reviews() x;",
          ).length,
        ],
        [0, 0],
      );
      const mine = rowsJson(
        second.client,
        "select row_to_json(x)::text from public.client_reviews() x;",
        AAL1,
      );
      assert.deepEqual(
        mine.map((row) => [
          keysOf(row),
          row.consultation_id,
          row.review_id,
          row.rating,
          row.state,
        ]),
        [
          [
            "consultation_ended_at,consultation_id,moderated_at,published_at,rating,review_id,review_text,state,submitted_at",
            second.consultation,
            reviews.second,
            2,
            "rejected",
          ],
        ],
      );
      const reviewable = completedWith(who, "S");
      assert.deepEqual(
        rowsJson(
          reviewable.client,
          "select row_to_json(x)::text from public.client_reviews() x;",
          AAL1,
        ).map((row) => [row.consultation_id, row.review_id, row.state]),
        [[reviewable.consultation, null, null]],
      );
      // Direct reads under the row policy: a client's own review only.
      assert.deepEqual(
        [
          as(
            "authenticated",
            first.client.auth,
            "select count(*) from public.reviews;",
            AAL1,
          ),
          as("authenticated", who.auth, "select count(*) from public.reviews;"),
          as(
            "authenticated",
            world.moderator.auth,
            "select count(*) from public.reviews;",
          ),
        ],
        ["1", "0", "0"],
      );
      // The moderation queue: by state and by the caller's jurisdictions.
      const queue = reviewQueueAs(world.moderator, "submitted");
      assert.ok(queue.some((row) => row.review_id === reviews.third));
      assert.equal(
        keysOf(queue[0]),
        "jurisdiction_id,moderated_at,published_at,rating,review_id,review_text,state,submitted_at",
      );
      assert.ok(
        reviewQueueAs(world.moderatorS, "submitted").every(
          (row) => row.jurisdiction_id === world.J.S,
        ),
      );
      assert.deepEqual(
        [
          reviewQueueAs(world.plainStaff, "submitted").length,
          reviewQueueAs(world.moderator, "submitted", AAL1).length,
          reviewQueueAs(world.moderator, "synthetic").length,
          reviewQueueAs(world.moderator, "published").some(
            (row) => row.review_id === reviews.first,
          ),
        ],
        [0, 0, 0, true],
      );
      return { listed, after_takedown: afterTakedown };
    },
  );
}

// ---------------------------------------------------------------------------
// CMP: the complaint foundation
// ---------------------------------------------------------------------------

const myComplaints = (account, options = {}) =>
  rowsJson(
    account,
    "select row_to_json(x)::text from public.complaint_cases_mine() x;",
    options,
  );
const complaintQueueAs = (staff, state, options = {}) =>
  rowsJson(
    staff,
    `select row_to_json(x)::text from public.staff_complaint_queue(${lit(state)}, 0) x;`,
    options,
  );
const complaintCaseAs = (staff, id, options = {}) =>
  rowsJson(
    staff,
    `select row_to_json(x)::text from public.staff_complaint_case(${lit(id)}) x;`,
    options,
  );
const updateComplaint = (staff, id, action, options = {}) =>
  asStaff(staff, COMPLAINT_UPDATE_SQL(id, action), options);

async function complaintChecks() {
  await check(
    "CMP-1 (MBS section 16 complaint intake and Consultation/Referral linkage; MB sections 120 to 122) a client (aal1) or an attorney (aal2) opens a Complaint Case; the complainant is always the caller and the jurisdiction is derived from the linkage: about a Consultation they participate in, about a Referral of their own, or about nothing in particular; another party's Consultation or Referral and an unknown id answer not_found alike, an attorney at aal1 not_found (a named matter) or denied (no linkage), a user with neither profile denied, a Consultation and a Referral named together invalid, anon cannot call; a second submission for the same complainant and linkage answers already_open and writes nothing (each participant may still have their own case about the same Consultation); the complainant receives one complaint_received Notification linking to their own complaints page; the audit event carries identifiers and the role only",
    () => {
      const s = completedConsultation("S");
      const stranger = newClient();
      const otherLawyer = lawyer("S");
      const before = s11Counts();
      const refusals = {
        other_client: openComplaint(
          stranger,
          { consultation: s.consultation },
          AAL1,
        ).outcome,
        other_attorney: openComplaint(otherLawyer, {
          consultation: s.consultation,
        }).outcome,
        unknown_consultation: openComplaint(
          s.client,
          { consultation: uid() },
          AAL1,
        ).outcome,
        attorney_aal1: openComplaint(
          s.lawyer,
          { consultation: s.consultation },
          AAL1,
        ).outcome,
        attorney_aal1_general: openComplaint(s.lawyer, {}, AAL1).outcome,
        other_referral: openComplaint(stranger, { referral: s.referral }, AAL1)
          .outcome,
        other_attorney_referral: openComplaint(otherLawyer, {
          referral: s.referral,
        }).outcome,
        unknown_referral: openComplaint(s.client, { referral: uid() }, AAL1)
          .outcome,
        both: openComplaint(
          s.client,
          { consultation: s.consultation, referral: s.referral },
          AAL1,
        ).outcome,
        staff_only: openComplaint(world.plainStaff, {}).outcome,
        anon: as("anon", null, COMPLAINT_SQL(s.consultation, null)),
      };
      assert.deepEqual(refusals, {
        other_client: "not_found",
        other_attorney: "not_found",
        unknown_consultation: "not_found",
        attorney_aal1: "not_found",
        attorney_aal1_general: "denied",
        other_referral: "not_found",
        other_attorney_referral: "not_found",
        unknown_referral: "not_found",
        both: "invalid",
        staff_only: "denied",
        anon: "ERROR 42501",
      });
      assert.deepEqual(deltaOf(before, s11Counts()), {});
      const opened = {
        client_consultation: openComplaint(
          s.client,
          { consultation: s.consultation },
          AAL1,
        ),
        attorney_consultation: openComplaint(s.lawyer, {
          consultation: s.consultation,
        }),
        client_referral: openComplaint(
          s.client,
          { referral: s.referral },
          AAL1,
        ),
        attorney_referral: openComplaint(s.lawyer, { referral: s.referral }),
        client_general: openComplaint(s.client, {}, AAL1),
        attorney_general: openComplaint(s.lawyer, {}),
      };
      for (const [name, answer] of Object.entries(opened)) {
        assert.equal(answer.outcome, "opened", name);
      }
      const rows = Object.fromEntries(
        Object.entries(opened).map(([name, answer]) => [
          name,
          complaintRow(answer.id),
        ]),
      );
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(rows).map(([name, row]) => [
            name,
            [
              row.complainant_user_id,
              row.consultation_id,
              row.referral_id,
              row.jurisdiction_id,
              row.state,
              row.category_code,
              row.assigned_to_user_id,
              row.resolved_at,
              row.resolution_code,
            ],
          ]),
        ),
        {
          client_consultation: [
            s.client.user,
            s.consultation,
            null,
            world.J.S,
            "opened",
            null,
            null,
            null,
            null,
          ],
          attorney_consultation: [
            s.lawyer.user,
            s.consultation,
            null,
            world.J.S,
            "opened",
            null,
            null,
            null,
            null,
          ],
          client_referral: [
            s.client.user,
            null,
            s.referral,
            world.J.S,
            "opened",
            null,
            null,
            null,
            null,
          ],
          attorney_referral: [
            s.lawyer.user,
            null,
            s.referral,
            world.J.S,
            "opened",
            null,
            null,
            null,
            null,
          ],
          client_general: [
            s.client.user,
            null,
            null,
            null,
            "opened",
            null,
            null,
            null,
            null,
          ],
          attorney_general: [
            s.lawyer.user,
            null,
            null,
            null,
            "opened",
            null,
            null,
            null,
            null,
          ],
        },
      );
      const again = s11Counts();
      const duplicates = {
        client_consultation: openComplaint(
          s.client,
          { consultation: s.consultation },
          AAL1,
        ).outcome,
        attorney_referral: openComplaint(s.lawyer, { referral: s.referral })
          .outcome,
        client_general: openComplaint(s.client, {}, AAL1).outcome,
      };
      assert.deepEqual(duplicates, {
        client_consultation: "already_open",
        attorney_referral: "already_open",
        client_general: "already_open",
      });
      assert.deepEqual(deltaOf(again, s11Counts()), {});
      assert.deepEqual(
        notificationsOf(
          s.client.user,
          `notification_type = 'complaint_received'`,
        ).map((n) => [n.source_event_type, n.source_event_id, n.channel]),
        [
          opened.client_consultation.id,
          opened.client_referral.id,
          opened.client_general.id,
        ].flatMap((id) => [
          ["complaint_case.opened", id, "in_app"],
          ["complaint_case.opened", id, "email"],
        ]),
      );
      const links = (account, options) =>
        centerAs(account, options)
          .filter((n) => n.notification_type === "complaint_received")
          .map((n) => n.link_path);
      assert.deepEqual(
        [links(s.client, AAL1), links(s.lawyer, {})],
        [
          ["/client/complaints", "/client/complaints", "/client/complaints"],
          [
            "/attorney/complaints",
            "/attorney/complaints",
            "/attorney/complaints",
          ],
        ],
      );
      const audit = auditsFor(
        "complaint_case",
        opened.attorney_consultation.id,
      );
      assert.deepEqual(
        audit.map((a) => [a.action, a.actor_type, a.actor_user_id, a.after]),
        [
          [
            "complaint_case.opened",
            "attorney",
            s.lawyer.user,
            {
              state: "opened",
              complainant_role: "attorney",
              consultation_id: s.consultation,
              referral_id: null,
            },
          ],
        ],
      );
      return { refusals, duplicates };
    },
  );

  await check(
    "MBS16-5 (MBS section 16 failure test: complaints preserve evidence and respect access controls; PM row 47, settled: Consultation and payment state unchanged, Complaint Case opened, evidence preserved, Legal Hold available) opening a complaint about a completed Consultation with messages, a shared document and participation evidence changes nothing of the matter: the Consultation, its Request, Booking, Engagement, payment, Media Room, ledger, messages, resources, participation records and exceptions are identical before and after; the evidence stays undeletable and unchangeable for every role; the other participant cannot see the case; a Legal Hold placed from the case stops every deletion of the Consultation's document and every new access to it, and changes no business state either",
    () => {
      const s = readyConsultation("S");
      openRoom(roomOf(s.consultation).id);
      assert.equal(start(s).outcome, "started");
      observeParticipants(s, ["client", "attorney"]);
      assert.equal(
        clientSend(s, "Synthetic evidence message.").outcome,
        "sent",
      );
      const doc = uploadDocument(s.client, s.consultation, clientOptions);
      assert.equal(end(s).outcome, "completed");
      const before = matterSnapshot(s);
      const opened = openComplaint(
        s.client,
        { consultation: s.consultation },
        AAL1,
      );
      assert.equal(opened.outcome, "opened");
      assert.equal(matterSnapshot(s), before);
      // Evidence preservation, every role.
      const evidence = {
        message_update: refused(
          `update public.messages set body = 'Changed.' where consultation_id = '${s.consultation}';`,
        ),
        message_delete: refused(
          `delete from public.messages where consultation_id = '${s.consultation}';`,
        ),
        participation_delete: refused(
          "delete from public.session_participation_records;",
        ),
        audit_delete: refused(
          `delete from public.audit_events where resource_id = '${s.consultation}';`,
        ),
        consultation_delete: refused(
          `delete from public.consultations where id = '${s.consultation}';`,
        ),
        complaint_delete: refused(
          `delete from public.complaint_cases where id = '${opened.id}';`,
        ),
      };
      for (const [name, code] of Object.entries(evidence)) {
        assert.ok(
          ["55000", "23514", "23503"].includes(code),
          `${name} ${code}`,
        );
      }
      // Access control: the complainant alone, among the participants.
      assert.deepEqual(
        [
          myComplaints(s.client, AAL1).map((row) => row.complaint_case_id),
          myComplaints(s.lawyer).length,
          as(
            "authenticated",
            s.lawyer.auth,
            "select count(*) from public.complaint_cases;",
          ),
          as(
            "authenticated",
            s.client.auth,
            "select count(*) from public.complaint_cases;",
            AAL1,
          ),
        ],
        [[opened.id], 0, "ERROR 42501", "ERROR 42501"],
      );
      // Legal Hold available: placed from the case, it covers the
      // Consultation's document and changes nothing else.
      assert.equal(authorizeAs(s.lawyer, doc), `authorized|${objectPath(doc)}`);
      const hold = placeHold(world.holds, "complaint_case", opened.id);
      assert.equal(hold.outcome, "placed");
      assert.equal(matterSnapshot(s), before);
      const held = {
        uploader: authorizeAs(s.client, doc, clientOptions),
        recipient: authorizeAs(s.lawyer, doc),
        delete_document: refused(
          `delete from public.documents where resource_id = '${doc}';`,
        ),
        delete_resource: refused(
          `delete from public.resources where id = '${doc}';`,
        ),
      };
      assert.deepEqual(held, {
        uploader: "held|",
        recipient: "held|",
        delete_document: "55000",
        delete_resource: "55000",
      });
      assert.equal(
        complaintCaseAs(world.complaints, opened.id)[0].active_legal_holds,
        1,
      );
      assert.equal(releaseHold(world.holds, hold.hold), "released");
      assert.equal(authorizeAs(s.lawyer, doc), `authorized|${objectPath(doc)}`);
      assert.equal(matterSnapshot(s), before);
      return { evidence, held };
    },
  );

  await check(
    "CMP-2 (PS section 27.1: complaint records are restricted; TA section 41 minimum necessary) the complainant reads only their own cases with the state, the linkage and the instants (never the assignee, the category or the resolution); staff read the queue and one case only with manage_complaints for the case's jurisdiction at aal2: a scoped holder sees its jurisdiction's cases and not a case without a jurisdiction or another jurisdiction's, a global holder every case, a staff member without the capability, the holder at aal1 and another capability's holder nothing; one case answers exactly the minimum metadata (the complainant's role, the linked Consultation's and Referral's ids and states, four participation facts, the latest payment state, the number of unreleased Legal Holds) and never a name, a User id or any content",
    () => {
      const s = readyConsultation("S");
      openRoom(roomOf(s.consultation).id);
      assert.equal(start(s).outcome, "started");
      observeParticipants(s, ["client", "attorney"], { left: ["client"] });
      assert.equal(end(s).outcome, "completed");
      const inC = completedConsultation("C");
      const linked = openComplaint(
        s.client,
        { consultation: s.consultation },
        AAL1,
      ).id;
      const general = openComplaint(s.lawyer, {}).id;
      const referral = openComplaint(s.lawyer, { referral: s.referral }).id;
      const other = openComplaint(
        inC.client,
        { consultation: inC.consultation },
        AAL1,
      ).id;
      const mine = myComplaints(s.client, AAL1);
      assert.deepEqual(
        mine.map((row) => [
          keysOf(row),
          row.complaint_case_id,
          row.state,
          row.consultation_id,
          row.referral_id,
          row.resolved_at,
        ]),
        [
          [
            // MVP-001 S11 PS-A6 section 5 re-pin: and the complainant's own
            // statement (none here).
            "complaint_case_id,consultation_id,opened_at,referral_id,resolved_at,state,statement",
            linked,
            "opened",
            s.consultation,
            null,
            null,
          ],
        ],
      );
      assert.deepEqual(
        myComplaints(s.lawyer)
          .map((row) => row.complaint_case_id)
          .sort(),
        [general, referral].sort(),
      );
      assert.equal(myComplaints(s.lawyer, AAL1).length, 0);
      const ids = (rows) => rows.map((row) => row.complaint_case_id);
      const global = ids(complaintQueueAs(world.complaints, "opened"));
      const scoped = ids(complaintQueueAs(world.complaintsS, "opened"));
      for (const id of [linked, general, referral, other]) {
        assert.ok(global.includes(id), id);
      }
      assert.deepEqual(
        [linked, referral, general, other].map((id) => scoped.includes(id)),
        [true, true, false, false],
      );
      assert.deepEqual(
        [
          complaintQueueAs(world.plainStaff, "opened").length,
          complaintQueueAs(world.ops, "opened").length,
          complaintQueueAs(world.complaints, "opened", AAL1).length,
          complaintQueueAs(world.complaints, "synthetic").length,
          complaintCaseAs(world.complaintsS, general).length,
          complaintCaseAs(world.complaintsS, other).length,
          complaintCaseAs(world.plainStaff, linked).length,
          complaintCaseAs(world.complaints, linked, AAL1).length,
          complaintCaseAs(world.complaints, uid()).length,
        ],
        [0, 0, 0, 0, 0, 0, 0, 0, 0],
      );
      assert.equal(
        keysOf(complaintQueueAs(world.complaints, "opened")[0]),
        "assigned_to_me,complaint_case_id,consultation_id,jurisdiction_id,opened_at,referral_id,resolved_at,state",
      );
      const one = complaintCaseAs(world.complaintsS, linked);
      assert.equal(one.length, 1);
      assert.equal(
        keysOf(one[0]),
        // MVP-001 S11 PS-A6 sections 4 and 5 re-pin: and the statement and the
        // codes of the vocabulary that governs the case now.
        "active_legal_holds,assigned_to_me,attorney_joined,both_present,category_code,category_codes,client_joined,complainant_role,complaint_case_id,consultation_id,consultation_outcome_code,consultation_state,either_left,jurisdiction_id,opened_at,payment_state,referral_id,referral_outcome_code,resolution_code,resolution_codes,resolved_at,state,statement",
      );
      assert.deepEqual(
        [
          one[0].state,
          one[0].complainant_role,
          one[0].consultation_id,
          one[0].consultation_state,
          one[0].consultation_outcome_code,
          one[0].attorney_joined,
          one[0].client_joined,
          one[0].both_present,
          one[0].either_left,
          one[0].payment_state,
          one[0].active_legal_holds,
          one[0].assigned_to_me,
          one[0].category_code,
          one[0].resolution_code,
        ],
        [
          "opened",
          "client",
          s.consultation,
          "completed",
          "normal",
          true,
          true,
          true,
          true,
          "capture_pending",
          0,
          false,
          null,
          null,
        ],
      );
      const text = JSON.stringify(one);
      for (const secret of [
        s.client.user,
        s.lawyer.user,
        s.client.client,
        s.lawyer.profile,
        s.lawyer.name,
      ]) {
        assert.ok(!text.includes(secret), secret);
      }
      const viaReferral = complaintCaseAs(world.complaints, referral)[0];
      assert.deepEqual(
        [
          viaReferral.complainant_role,
          viaReferral.referral_id,
          viaReferral.consultation_id,
          viaReferral.attorney_joined,
          viaReferral.payment_state,
        ],
        ["attorney", s.referral, null, null, null],
      );
      assert.equal(
        complaintCaseAs(world.complaints, general)[0].complainant_role,
        "attorney",
      );
      return { queue_global: global.length, queue_scoped: scoped.length };
    },
  );

  await check(
    "CMP-3 (MBS section 16 authorized assignment / status handling; TA section 40) staff handling under manage_complaints for the case's jurisdiction at aal2, every step audited with states only: assign takes an opened case into review for the caller (no User id is an input) and lets another holder take an assigned case over; unassign returns a case in review to opened; escalate and return_to_review move between in_review and escalated; every other step is an invalid_transition and changes nothing; a scoped holder is denied another jurisdiction's case and a case without a jurisdiction; an unknown id answers not_found to a global holder; the complainant sees only the state",
    () => {
      const s = completedConsultation("S");
      const id = openComplaint(
        s.client,
        { consultation: s.consultation },
        AAL1,
      ).id;
      const general = openComplaint(s.client, {}, AAL1).id;
      const refusals = {
        plain_staff: updateComplaint(world.plainStaff, id, "assign"),
        aal1: updateComplaint(world.complaints, id, "assign", AAL1),
        other_capability: updateComplaint(world.holds, id, "assign"),
        complainant: as(
          "authenticated",
          s.client.auth,
          COMPLAINT_UPDATE_SQL(id, "assign"),
          AAL1,
        ),
        scoped_no_jurisdiction: updateComplaint(
          world.complaintsS,
          general,
          "assign",
        ),
        unknown_global: updateComplaint(world.complaints, uid(), "assign"),
        unknown_scoped: updateComplaint(world.complaintsS, uid(), "assign"),
        unknown_action: updateComplaint(world.complaints, id, "close"),
        unassign_opened: updateComplaint(world.complaints, id, "unassign"),
        escalate_opened: updateComplaint(world.complaints, id, "escalate"),
        return_opened: updateComplaint(
          world.complaints,
          id,
          "return_to_review",
        ),
      };
      assert.deepEqual(refusals, {
        plain_staff: "denied",
        aal1: "denied",
        other_capability: "denied",
        complainant: "denied",
        scoped_no_jurisdiction: "denied",
        unknown_global: "not_found",
        unknown_scoped: "denied",
        unknown_action: "invalid",
        unassign_opened: "invalid_transition",
        escalate_opened: "invalid_transition",
        return_opened: "invalid_transition",
      });
      assert.deepEqual(
        [complaintRow(id).state, complaintRow(id).assigned_to_user_id],
        ["opened", null],
      );
      const stateOf = () => {
        const row = complaintRow(id);
        return `${row.state}:${row.assigned_to_user_id === null ? "nobody" : row.assigned_to_user_id === world.complaintsS.user ? "scoped" : "global"}`;
      };
      const walk = [];
      for (const [staff, action] of [
        [world.complaintsS, "assign"],
        [world.complaintsS, "unassign"],
        [world.complaintsS, "assign"],
        [world.complaints, "assign"],
        [world.complaints, "escalate"],
        [world.complaints, "unassign"],
        [world.complaints, "escalate"],
        [world.complaintsS, "assign"],
        [world.complaintsS, "return_to_review"],
        [world.complaintsS, "return_to_review"],
      ]) {
        walk.push(
          `${action}=${updateComplaint(staff, id, action)}>${stateOf()}`,
        );
      }
      assert.deepEqual(walk, [
        "assign=applied>in_review:scoped",
        "unassign=applied>opened:nobody",
        "assign=applied>in_review:scoped",
        "assign=applied>in_review:global",
        "escalate=applied>escalated:global",
        "unassign=invalid_transition>escalated:global",
        "escalate=invalid_transition>escalated:global",
        "assign=applied>escalated:scoped",
        "return_to_review=applied>in_review:scoped",
        "return_to_review=invalid_transition>in_review:scoped",
      ]);
      const audits = auditsFor("complaint_case", id).map((a) => [
        a.action,
        a.actor_type,
        a.before,
        a.after,
      ]);
      assert.deepEqual(audits.slice(1, 4), [
        [
          "complaint_case.assigned",
          "staff",
          { state: "opened", assigned: false },
          { state: "in_review", assigned: true },
        ],
        [
          "complaint_case.unassigned",
          "staff",
          { state: "in_review", assigned: true },
          { state: "opened", assigned: false },
        ],
        [
          "complaint_case.assigned",
          "staff",
          { state: "opened", assigned: false },
          { state: "in_review", assigned: true },
        ],
      ]);
      assert.deepEqual(
        audits.map((a) => a[0]),
        [
          "complaint_case.opened",
          "complaint_case.assigned",
          "complaint_case.unassigned",
          "complaint_case.assigned",
          "complaint_case.assigned",
          "complaint_case.escalated",
          "complaint_case.assigned",
          "complaint_case.returned_to_review",
        ],
      );
      assert.equal(
        complaintCaseAs(world.complaintsS, id)[0].assigned_to_me,
        true,
      );
      assert.equal(
        complaintCaseAs(world.complaints, id)[0].assigned_to_me,
        false,
      );
      assert.deepEqual(
        myComplaints(s.client, AAL1)
          .filter((row) => row.complaint_case_id === id)
          .map((row) => row.state),
        ["in_review"],
      );
      return { refusals, walk };
    },
  );

  await check(
    "CMP-4 (Packet section 3 gate: complaint vocabularies are configuration; fail closed) classification and resolution exist and are authorized and validated like every staff step, but no complaint vocabulary can be selected, so both answer configuration_unavailable and change nothing: the case row is byte for byte the same and nothing is audited; a malformed code is invalid, a staff member without the capability denied, an opened case cannot be resolved (invalid_transition); the commands are wired behind the one seam: with the vocabulary function replaced inside one rolled-back owner transaction, a listed category code and a listed resolution code are recorded (the resolution with its instant and the resolved state) and an unlisted code is refused; after the rollback nothing of it remains",
    () => {
      const s = completedConsultation("S");
      const id = openComplaint(
        s.client,
        { consultation: s.consultation },
        AAL1,
      ).id;
      const classify = (staff, code, options = {}) =>
        asStaff(
          staff,
          `select public.staff_classify_complaint('${id}', ${lit(code)});`,
          options,
        );
      const resolve = (staff, code, options = {}) =>
        asStaff(
          staff,
          `select public.staff_resolve_complaint('${id}', ${lit(code)});`,
          options,
        );
      const opened = {
        classify_opened: classify(world.complaints, "synthetic_category"),
        resolve_opened: resolve(world.complaints, "synthetic_resolution"),
      };
      assert.equal(updateComplaint(world.complaints, id, "assign"), "applied");
      const snapshot = JSON.stringify(complaintRow(id));
      const audits = auditsFor("complaint_case", id).length;
      const answers = {
        ...opened,
        classify: classify(world.complaints, "synthetic_category"),
        resolve: resolve(world.complaints, "synthetic_resolution"),
        classify_scoped: classify(world.complaintsS, "synthetic_category"),
        classify_malformed: classify(world.complaints, "Not A Code"),
        resolve_malformed: resolve(world.complaints, ""),
        classify_plain: classify(world.plainStaff, "synthetic_category"),
        resolve_aal1: resolve(world.complaints, "synthetic_resolution", AAL1),
        resolve_complainant: as(
          "authenticated",
          s.client.auth,
          `select public.staff_resolve_complaint('${id}', 'synthetic_resolution');`,
          AAL1,
        ),
      };
      assert.deepEqual(answers, {
        classify_opened: "configuration_unavailable",
        resolve_opened: "invalid_transition",
        classify: "configuration_unavailable",
        resolve: "configuration_unavailable",
        classify_scoped: "configuration_unavailable",
        classify_malformed: "invalid",
        resolve_malformed: "invalid",
        classify_plain: "denied",
        resolve_aal1: "denied",
        resolve_complainant: "denied",
      });
      assert.equal(JSON.stringify(complaintRow(id)), snapshot);
      assert.equal(auditsFor("complaint_case", id).length, audits);
      assert.equal(
        sql(
          "select outcome || '|' || cardinality(category_codes) || '|' || cardinality(resolution_codes) from public.complaint_vocabulary(null, now());",
        ),
        "configuration_unavailable|0|0",
      );
      // The seam: a synthetic vocabulary inside one rolled-back transaction.
      const definition = sql(
        "select pg_get_functiondef('public.complaint_vocabulary(uuid, timestamp with time zone)'::regprocedure);",
      );
      const wired = psql(
        [
          "begin;",
          `create or replace function public.complaint_vocabulary(p_jurisdiction uuid, p_as_of timestamptz)
             returns table (outcome text, policy_version_id uuid, category_codes text[], resolution_codes text[])
             language sql stable security invoker set search_path = pg_catalog, pg_temp
             as $f$ select 'selected'::text, null::uuid, array['synthetic_category']::text[], array['synthetic_resolution']::text[]; $f$;`,
          ...sessionLines("authenticated", world.complaints.auth),
          `select public.staff_classify_complaint('${id}', 'unlisted_category');`,
          `select public.staff_classify_complaint('${id}', 'synthetic_category');`,
          `select public.staff_resolve_complaint('${id}', 'unlisted_resolution');`,
          `select public.staff_resolve_complaint('${id}', 'synthetic_resolution');`,
          `select public.staff_resolve_complaint('${id}', 'synthetic_resolution');`,
          "reset role;",
          `select concat_ws('|', state, category_code, resolution_code, resolved_at is not null) from public.complaint_cases where id = '${id}';`,
          `select string_agg(action_code, ',' order by occurred_at, id) from public.audit_events where resource_id = '${id}' and action_code in ('complaint_case.classified', 'complaint_case.resolved');`,
          "rollback;",
          "",
        ].join("\n"),
      );
      assert.equal(wired.status, 0, wired.stderr);
      const lines = wired.stdout
        .trim()
        .split("\n")
        .filter((line) => line !== "" && line !== "t");
      assert.deepEqual(lines, [
        "invalid_code",
        "applied",
        "invalid_code",
        "applied",
        "invalid_transition",
        "resolved|synthetic_category|synthetic_resolution|t",
        "complaint_case.classified,complaint_case.resolved",
      ]);
      assert.equal(JSON.stringify(complaintRow(id)), snapshot);
      assert.equal(
        sql(
          "select pg_get_functiondef('public.complaint_vocabulary(uuid, timestamp with time zone)'::regprocedure);",
        ),
        definition,
      );
      return { answers, wired: lines };
    },
  );

  await check(
    "CMP-5 (PS section 27.1; PS section 32) the complaint guard holds for every role, the owner included: a case is recorded only opened, unassigned and unclassified, with its linkage's jurisdiction, by a participant of the linked matter; its complainant, linkage, jurisdiction and opening never change; it moves only opened -> in_review, in_review -> opened | escalated | resolved and escalated -> in_review | resolved; it is assigned exactly while not opened and resolved exactly with its instant and code; a resolved case never changes; a case is never deleted or truncated; a second case that is not resolved for the same complainant and linkage is refused",
    () => {
      const s = completedConsultation("S");
      const stranger = newAccount();
      const insert = (extra = {}) => {
        const row = {
          complainant_user_id: `'${s.client.user}'`,
          consultation_id: `'${s.consultation}'`,
          jurisdiction_id: `'${world.J.S}'`,
          state: "'opened'",
          opened_at: "now()",
          ...extra,
        };
        return `insert into public.complaint_cases (${Object.keys(row).join(", ")}) values (${Object.values(row).join(", ")});`;
      };
      const inserts = {
        in_review_at_insert: refused(
          insert({
            state: "'in_review'",
            assigned_to_user_id: `'${world.complaints.user}'`,
          }),
        ),
        classified_at_insert: refused(insert({ category_code: "'synthetic'" })),
        wrong_jurisdiction: refused(
          insert({ jurisdiction_id: `'${world.J.C}'` }),
        ),
        missing_jurisdiction: refused(insert({ jurisdiction_id: "null" })),
        not_a_participant: refused(
          insert({ complainant_user_id: `'${stranger.user}'` }),
        ),
        unrelated_referral: refused(
          insert({
            referral_id: `'${completedConsultation("S").referral}'`,
          }),
        ),
      };
      for (const [name, code] of Object.entries(inserts)) {
        assert.equal(code, "23514", name);
      }
      const id = openComplaint(
        s.client,
        { consultation: s.consultation },
        AAL1,
      ).id;
      assert.equal(refused(insert()), "23505");
      const set = (assignments) =>
        `update public.complaint_cases set ${assignments} where id = '${id}';`;
      const review = `state = 'in_review', assigned_to_user_id = '${world.complaints.user}'`;
      const resolved =
        "state = 'resolved', resolved_at = now(), resolution_code = 'synthetic_resolution'";
      const changes = {
        complainant: refused(set(`complainant_user_id = '${s.lawyer.user}'`)),
        consultation: refused(set("consultation_id = null")),
        jurisdiction: refused(set(`jurisdiction_id = '${world.J.C}'`)),
        opened_at: refused(set("opened_at = now()")),
        opened_to_escalated: refused(
          set(
            `state = 'escalated', assigned_to_user_id = '${world.complaints.user}'`,
          ),
        ),
        opened_to_resolved: refused(
          set(`${resolved}, assigned_to_user_id = '${world.complaints.user}'`),
        ),
        unknown_state: refused(set("state = 'closed'")),
        resolved_then_changed: refused(
          `${set(review)}\n${set(resolved)}\n${set("category_code = 'synthetic_category'")}`,
        ),
        resolved_then_reopened: refused(
          `${set(review)}\n${set(resolved)}\n${set("state = 'in_review', resolved_at = null, resolution_code = null")}`,
        ),
        delete: refused(
          `delete from public.complaint_cases where id = '${id}';`,
        ),
        truncate: refused("truncate public.complaint_cases;"),
      };
      for (const [name, code] of Object.entries(changes)) {
        assert.equal(code, "55000", name);
      }
      const checks = {
        in_review_unassigned: refused(set("state = 'in_review'")),
        resolved_without_code: refused(
          `${set(review)}\n${set("state = 'resolved', resolved_at = now()")}`,
        ),
        resolved_without_instant: refused(
          `${set(review)}\n${set("state = 'resolved', resolution_code = 'synthetic_resolution'")}`,
        ),
        malformed_code: refused(
          `${set(review)}\n${set("category_code = 'Not A Code'")}`,
        ),
      };
      for (const [name, code] of Object.entries(checks)) {
        assert.equal(code, "23514", name);
      }
      acceptedThenRolledBack(
        `${set(review)}\n${set("state = 'escalated'")}\n${set("state = 'in_review'")}\n${set(resolved)}`,
      );
      assert.equal(complaintRow(id).state, "opened");
      return { inserts, changes, checks };
    },
  );
}

// ---------------------------------------------------------------------------
// HOLD: Legal Holds
// ---------------------------------------------------------------------------

const holdsAs = (staff, status, options = {}) =>
  rowsJson(
    staff,
    `select row_to_json(x)::text from public.staff_legal_holds(${lit(status)}, 0) x;`,
    options,
  );

const heldNow = (resource) =>
  sql(`select public.resource_under_legal_hold('${resource}');`);

async function holdChecks() {
  await check(
    "HOLD-1 (PS section 26.2; TA section 40; ROS section 16.3) placing and releasing a Legal Hold needs manage_legal_holds as a global grant at aal2: a jurisdiction-scoped grant, another capability, a staff member without one, the holder at aal1 and a participant are denied; the scope type is one of consultation, intake, resource, complaint_case and user and the scope row must exist (an unknown scope type, a blank or over-long reason and a missing id are invalid, an unknown row not_found); a hold is placed active with its reason stored on the hold only (the audit events carry the scope and the status, never the reason); it is released once (a second release answers already_released) with who released it; the staff list answers the unreleased and the released holds with their scope, status and reason; a hold changes no business state",
    () => {
      const s = completedConsultation("S");
      const before = matterSnapshot(s);
      const reason = "Synthetic hold reason for the HOLD-1 probe";
      const place = (staff, type, id, text = reason, options = {}) =>
        asStaff(staff, PLACE_HOLD_SQL(type, id, text), options).split("|")[0];
      const refusals = {
        scoped_grant: place(world.holdsS, "consultation", s.consultation),
        other_capability: place(
          world.complaints,
          "consultation",
          s.consultation,
        ),
        plain_staff: place(world.plainStaff, "consultation", s.consultation),
        aal1: place(world.holds, "consultation", s.consultation, reason, AAL1),
        client: as(
          "authenticated",
          s.client.auth,
          PLACE_HOLD_SQL("consultation", s.consultation, reason),
          AAL1,
        ).split("|")[0],
        unknown_scope_type: place(world.holds, "synthetic", s.consultation),
        payment_scope_type: place(
          world.holds,
          "payment_transaction",
          s.payment,
        ),
        blank_reason: place(world.holds, "consultation", s.consultation, " "),
        long_reason: place(
          world.holds,
          "consultation",
          s.consultation,
          "r".repeat(2001),
        ),
        missing_id: asStaff(
          world.holds,
          "select outcome from public.staff_place_legal_hold('consultation', null, 'Synthetic');",
        ),
        unknown_row: place(world.holds, "consultation", uid()),
        wrong_type_for_row: place(world.holds, "intake", s.consultation),
      };
      assert.deepEqual(refusals, {
        scoped_grant: "denied",
        other_capability: "denied",
        plain_staff: "denied",
        aal1: "denied",
        client: "denied",
        unknown_scope_type: "invalid",
        payment_scope_type: "invalid",
        blank_reason: "invalid",
        long_reason: "invalid",
        missing_id: "invalid",
        unknown_row: "not_found",
        wrong_type_for_row: "not_found",
      });
      const counted = count("legal_holds");
      const placed = {};
      for (const [type, id] of [
        ["consultation", s.consultation],
        ["intake", s.client.intake],
        ["user", s.client.user],
      ]) {
        const answer = placeHold(world.holds, type, id, reason);
        assert.equal(answer.outcome, "placed", type);
        placed[type] = answer.hold;
      }
      const longest = placeHold(
        world.holds,
        "user",
        s.lawyer.user,
        "m".repeat(2000),
      );
      assert.equal(longest.outcome, "placed");
      assert.equal(count("legal_holds"), counted + 4);
      const row = holdRow(placed.consultation);
      assert.deepEqual(
        [
          row.scope_type,
          row.scope_id,
          row.status,
          row.reason,
          row.released_at,
          row.created_by_user_id,
          row.released_by_user_id,
        ],
        [
          "consultation",
          s.consultation,
          "active",
          reason,
          null,
          world.holds.user,
          null,
        ],
      );
      assert.equal(matterSnapshot(s), before);
      const active = holdsAs(world.holds, "active");
      assert.equal(
        keysOf(active[0]),
        "legal_hold_id,placed_by_me,reason,released_at,scope_id,scope_type,started_at,status",
      );
      const listed = active.find(
        (h) => h.legal_hold_id === placed.consultation,
      );
      assert.deepEqual(
        [
          listed.scope_type,
          listed.scope_id,
          listed.status,
          listed.reason,
          listed.placed_by_me,
        ],
        ["consultation", s.consultation, "active", reason, true],
      );
      assert.deepEqual(
        [
          holdsAs(world.holdsS, "active").length,
          holdsAs(world.plainStaff, "active").length,
          holdsAs(world.holds, "active", AAL1).length,
          holdsAs(world.holds, "synthetic").length,
        ],
        [0, 0, 0, 0],
      );
      const releases = {
        scoped_grant: releaseHold(world.holdsS, placed.consultation),
        plain_staff: releaseHold(world.plainStaff, placed.consultation),
        aal1: releaseHold(world.holds, placed.consultation, AAL1),
        unknown: releaseHold(world.holds, uid()),
        release: releaseHold(world.holds, placed.consultation),
        again: releaseHold(world.holds, placed.consultation),
      };
      assert.deepEqual(releases, {
        scoped_grant: "denied",
        plain_staff: "denied",
        aal1: "denied",
        unknown: "not_found",
        release: "released",
        again: "already_released",
      });
      const released = holdRow(placed.consultation);
      assert.deepEqual(
        [
          released.status,
          released.released_at !== null,
          released.released_by_user_id,
          released.reason,
        ],
        ["released", true, world.holds.user, reason],
      );
      assert.ok(
        holdsAs(world.holds, "released").some(
          (h) =>
            h.legal_hold_id === placed.consultation && h.status === "released",
        ),
      );
      assert.ok(
        !holdsAs(world.holds, "active").some(
          (h) => h.legal_hold_id === placed.consultation,
        ),
      );
      const audits = auditsFor("legal_hold", placed.consultation);
      assert.deepEqual(
        audits.map((a) => [a.action, a.actor_type, a.actor_user_id, a.after]),
        [
          [
            "legal_hold.placed",
            "staff",
            world.holds.user,
            {
              scope_type: "consultation",
              scope_id: s.consultation,
              status: "active",
            },
          ],
          [
            "legal_hold.released",
            "staff",
            world.holds.user,
            {
              scope_type: "consultation",
              scope_id: s.consultation,
              status: "released",
            },
          ],
        ],
      );
      assert.equal(
        sql(
          `select count(*) from public.audit_events where resource_type = 'legal_hold' and (coalesce(before_snapshot::text, '') || coalesce(after_snapshot::text, '') || coalesce(reason_code, '')) like '%Synthetic hold reason%';`,
        ),
        "0",
      );
      for (const hold of [placed.intake, placed.user, longest.hold]) {
        assert.equal(releaseHold(world.holds, hold), "released");
      }
      assert.equal(matterSnapshot(s), before);
      return { refusals, releases };
    },
  );

  await check(
    "HOLD-2 (PS section 26.2 \"physical deletion must check active Legal Holds\"; TA section 51; PM row 48) coverage of every scope, with the S3 and S10 behaviour unchanged (deletion refused for every role; new access authorization refused; both restored by the release): a consultation hold and a resource hold cover the Consultation's document; an intake hold covers the Intake's resource and not the Consultation's document; a complaint_case hold covers the document of the case's linked Consultation and nothing of an unlinked case; a user hold covers what belongs to that person's matters (the client's: their Intake's resource and their Consultation's document; the attorney's: the Consultation's document only); a hold on an unrelated user covers nothing; two holds on one scope keep it covered until the last is released; a planted hold of an unknown scope vocabulary still binds by its scope id (S3: fail closed)",
    () => {
      const s = liveConsultation("S");
      const doc = uploadDocument(s.client, s.consultation, clientOptions);
      // Fixture: an Intake resource of the same client, planted by the owner
      // (the S3 voice-memo pipeline is not what this probe examines).
      const memo = uid();
      sql(
        `insert into public.resources (id, resource_kind, owner_user_id, intake_id, storage_bucket, storage_object_path, mime_type, byte_size, content_digest, visibility_state, retention_state)
           values ('${memo}', 'voice_memo', '${s.client.user}', '${s.client.intake}', 'rosuno-private-resources', 'resources/${memo}/original', 'audio/webm', 1024, 'sha256:${sha256(memo)}', 'available', 'active');`,
      );
      const linkedCase = openComplaint(
        s.client,
        { consultation: s.consultation },
        AAL1,
      ).id;
      const generalCase = openComplaint(s.client, {}, AAL1).id;
      const unrelated = newClient();
      const access = () => [
        authorizeAs(s.client, doc, clientOptions).split("|")[0],
        authorizeAs(s.lawyer, doc).split("|")[0],
      ];
      const deletions = () => [
        psql(
          `begin; delete from public.documents where resource_id = '${doc}'; rollback;`,
        ).status === 0
          ? "allowed"
          : "refused",
        psql(
          `begin; delete from public.resources where id = '${memo}'; rollback;`,
        ).status === 0
          ? "allowed"
          : "refused",
      ];
      const free = {
        held: [heldNow(doc), heldNow(memo)],
        access: access(),
        deletions: deletions(),
      };
      assert.deepEqual(free, {
        held: ["f", "f"],
        access: ["authorized", "authorized"],
        deletions: ["allowed", "allowed"],
      });
      const matrix = {};
      for (const [name, type, id] of [
        ["consultation", "consultation", s.consultation],
        ["resource", "resource", doc],
        ["intake", "intake", s.client.intake],
        ["complaint_case_linked", "complaint_case", linkedCase],
        ["complaint_case_unlinked", "complaint_case", generalCase],
        ["user_client", "user", s.client.user],
        ["user_attorney", "user", s.lawyer.user],
        ["user_unrelated", "user", unrelated.user],
      ]) {
        const hold = placeHold(world.holds, type, id);
        assert.equal(hold.outcome, "placed", name);
        matrix[name] = {
          held: [heldNow(doc), heldNow(memo)],
          access: access(),
          deletions: deletions(),
        };
        assert.equal(releaseHold(world.holds, hold.hold), "released", name);
        assert.deepEqual(
          { held: [heldNow(doc), heldNow(memo)], access: access() },
          { held: ["f", "f"], access: ["authorized", "authorized"] },
          `${name} released`,
        );
      }
      const docOnly = {
        held: ["t", "f"],
        access: ["held", "held"],
        deletions: ["refused", "allowed"],
      };
      const memoOnly = {
        held: ["f", "t"],
        access: ["authorized", "authorized"],
        deletions: ["allowed", "refused"],
      };
      const both = {
        held: ["t", "t"],
        access: ["held", "held"],
        deletions: ["refused", "refused"],
      };
      assert.deepEqual(matrix, {
        consultation: docOnly,
        resource: docOnly,
        intake: memoOnly,
        complaint_case_linked: docOnly,
        complaint_case_unlinked: free,
        user_client: both,
        user_attorney: docOnly,
        user_unrelated: free,
      });
      // Two holds on one scope: covered until the last is released.
      const one = placeHold(world.holds, "consultation", s.consultation).hold;
      const two = placeHold(world.holds, "consultation", s.consultation).hold;
      assert.equal(releaseHold(world.holds, one), "released");
      assert.equal(heldNow(doc), "t");
      assert.equal(releaseHold(world.holds, two), "released");
      assert.equal(heldNow(doc), "f");
      // S3, unchanged: a hold of an unknown scope and status vocabulary binds
      // by its scope id while unreleased (planted by the owner; no API role
      // can write the relation).
      const legacy = uid();
      sql(
        `insert into public.legal_holds (id, scope_type, scope_id, status, reason, started_at, created_by_user_id) values ('${legacy}', 'synthetic_scope', '${s.consultation}', 'synthetic_status', 'Synthetic legacy hold', now() - interval '1 minute', '${world.holds.user}');`,
      );
      assert.deepEqual([heldNow(doc), access()], ["t", ["held", "held"]]);
      assert.ok(
        holdsAs(world.holds, "active").some((h) => h.legal_hold_id === legacy),
      );
      assert.equal(releaseHold(world.holds, legacy), "released");
      assert.deepEqual(
        [heldNow(doc), access()],
        ["f", ["authorized", "authorized"]],
      );
      return matrix;
    },
  );

  await check(
    "HOLD-3 (PS section 26.2; PS section 32) the Legal Hold guard holds for every role, the owner included: a hold is never deleted or truncated; its scope, reason, start and creator never change (P1); it changes only by its release, once, with who released it, and a released hold never changes; a hold of an S11 scope type is placed unreleased with status active, is released exactly with status released, and its reason holds at most 2,000 characters",
    () => {
      const s = completedConsultation("S");
      const hold = placeHold(world.holds, "consultation", s.consultation).hold;
      const set = (assignments) =>
        `update public.legal_holds set ${assignments} where id = '${hold}';`;
      const release = `status = 'released', released_at = now(), released_by_user_id = '${world.holds.user}'`;
      const insert = (extra = {}) => {
        const row = {
          scope_type: "'consultation'",
          scope_id: `'${s.consultation}'`,
          status: "'active'",
          reason: "'Synthetic guard probe'",
          started_at: "now()",
          created_by_user_id: `'${world.holds.user}'`,
          ...extra,
        };
        return `insert into public.legal_holds (${Object.keys(row).join(", ")}) values (${Object.values(row).join(", ")});`;
      };
      const immutable = {
        scope_type: refused(set("scope_type = 'user'")),
        scope_id: refused(set(`scope_id = '${uid()}'`)),
        reason: refused(set("reason = 'Changed'")),
        started_at: refused(set("started_at = now()")),
        creator: refused(set(`created_by_user_id = '${world.ops.user}'`)),
        release_without_releaser: refused(
          set("status = 'released', released_at = now()"),
        ),
        release_keeping_active: refused(
          set(
            `released_at = now(), released_by_user_id = '${world.holds.user}'`,
          ),
        ),
        insert_released: refused(
          insert({
            status: "'released'",
            released_at: "now()",
            released_by_user_id: `'${world.holds.user}'`,
          }),
        ),
        insert_unknown_status: refused(insert({ status: "'synthetic'" })),
        insert_long_reason: refused(
          insert({ reason: `'${"r".repeat(2001)}'` }),
        ),
        insert_blank_reason: refused(insert({ reason: "' '" })),
      };
      for (const [name, code] of Object.entries(immutable)) {
        assert.equal(code, "23514", name);
      }
      const final = {
        delete: refused(`delete from public.legal_holds where id = '${hold}';`),
        truncate: refused("truncate public.legal_holds;"),
        status_only: refused(set("status = 'active '")),
        released_status_without_release: refused(set("status = 'released'")),
        released_then_rereleased: refused(
          `${set(release)}\n${set("released_at = now() + interval '1 hour'")}`,
        ),
        released_then_reactivated: refused(
          `${set(release)}\n${set("status = 'active', released_at = null, released_by_user_id = null")}`,
        ),
      };
      // An unreleased hold whose status alone changes is refused by the
      // status check (23514) or the guard (55000), never accepted.
      assert.ok(["23514", "55000"].includes(final.status_only));
      for (const name of [
        "delete",
        "truncate",
        "released_status_without_release",
        "released_then_rereleased",
        "released_then_reactivated",
      ]) {
        assert.equal(final[name], "55000", name);
      }
      acceptedThenRolledBack(set(release));
      assert.equal(holdRow(hold).status, "active");
      assert.equal(releaseHold(world.holds, hold), "released");
      return { immutable, final };
    },
  );
}

// ---------------------------------------------------------------------------
// FAM: review exception families; REL: the finance release
// ---------------------------------------------------------------------------

async function familyChecks() {
  await check(
    "FAM-1 (PS section 30.4: staff access is not one universal staff policy; TA section 41) every exception type belongs to one family and each family to one capability: financial (every S7 type, capture_unavailable_at_completion and the S11 cancellation, outcome and retained-funds reviews, and any type no family lists) manage_financial_operations; compliance (eligibility_change_review, jurisdiction_change_review) manage_compliance_reviews; operations (the five S9 media types and notification_delivery_failed) manage_consultation_operations; each holder lists only its own family (the finance list no longer shows a compliance or operations item) and assigns and resolves only its own family's items: another family's item answers not_found exactly as an unknown id does, a staff member holding no family denied; the holder's own family is applied and audited as before",
    () => {
      const mapping = JSON.parse(
        sql(
          `select json_object_agg(t, public.exception_family(t))::text from unnest(array[
             'ledger_allocation_invalid', 'funds_retained_after_request_end', 'provider_operation_exhausted',
             'amount_mismatch', 'provider_reference_mismatch', 'reconciliation_mismatch', 'checkout_after_terminal',
             'authorization_after_terminal', 'provider_state_contradiction', 'unexpected_provider_capture',
             'capture_failed', 'unexpected_provider_refund', 'refund_failed', 'dispute_opened', 'dispute_updated',
             'dispute_closed', 'unknown_payment_reference', 'capture_unavailable_at_completion',
             'cancellation_payment_review', 'outcome_payment_review', 'funds_retained_after_technical_failure',
             'eligibility_change_review', 'jurisdiction_change_review',
             'media_session_mismatch', 'media_activity_outside_consultation', 'media_unrecognized_participant',
             'media_room_missing', 'media_unknown_room', 'notification_delivery_failed',
             'synthetic_unknown_type'
           ]) as t;`,
        ),
      );
      const families = {};
      for (const [type, family] of Object.entries(mapping)) {
        (families[family] ??= []).push(type);
      }
      assert.deepEqual(Object.keys(families).sort(), [
        "compliance",
        "financial",
        "operations",
      ]);
      assert.deepEqual(families.compliance.sort(), [
        "eligibility_change_review",
        "jurisdiction_change_review",
      ]);
      assert.deepEqual(families.operations.sort(), [
        "media_activity_outside_consultation",
        "media_room_missing",
        "media_session_mismatch",
        "media_unknown_room",
        "media_unrecognized_participant",
        "notification_delivery_failed",
      ]);
      assert.equal(families.financial.length, 22);
      assert.ok(families.financial.includes("synthetic_unknown_type"));
      assert.deepEqual(
        JSON.parse(
          sql(
            "select json_object_agg(f, public.exception_family_capability(f))::text from unnest(array['financial', 'compliance', 'operations']) as f;",
          ),
        ),
        {
          financial: "manage_financial_operations",
          compliance: "manage_compliance_reviews",
          operations: "manage_consultation_operations",
        },
      );
      // One open item of each family about one Consultation (the compliance
      // and operations ones opened through the S8 review opener, as the S8 to
      // S10 detectors open them; an unknown type the same way).
      const s = scheduledConsultation("S");
      assert.equal(clientCancel(s).outcome, "cancelled");
      const open = (type) =>
        sql(
          `select public.decision_open_review('${type}', 'consultation', '${s.consultation}', 'high', '${world.J.S}', '{"synthetic": true}'::jsonb);`,
        );
      const item = {
        financial: consultationExceptions(
          s.consultation,
          "cancellation_payment_review",
        )[0].id,
        compliance: open("eligibility_change_review"),
        operations: open("media_room_missing"),
        unknown: open("synthetic_unknown_type"),
      };
      const sees = (rows) =>
        Object.fromEntries(
          Object.entries(item).map(([family, id]) => [
            family,
            rows.some((row) => row.exception_id === id),
          ]),
        );
      const lists = {
        finance_list: sees(financeExceptionsAs(world.finance)),
        finance_financial: sees(familyAs(world.finance, "financial")),
        finance_compliance: familyAs(world.finance, "compliance").length,
        finance_operations: familyAs(world.finance, "operations").length,
        compliance_compliance: sees(familyAs(world.compliance, "compliance")),
        compliance_financial: familyAs(world.compliance, "financial").length,
        compliance_finance_list: financeExceptionsAs(world.compliance).length,
        operations_operations: sees(familyAs(world.ops, "operations")),
        operations_compliance: familyAs(world.ops, "compliance").length,
        scoped_operations: familyAs(world.opsS, "operations").length,
        plain: familyAs(world.plainStaff, "operations").length,
        aal1: familyAs(world.ops, "operations", "open", AAL1).length,
        unknown_family: familyAs(world.finance, "synthetic").length,
      };
      const only = (...families) => ({
        financial: families.includes("financial"),
        compliance: families.includes("compliance"),
        operations: families.includes("operations"),
        unknown: families.includes("unknown"),
      });
      assert.deepEqual(lists, {
        finance_list: only("financial", "unknown"),
        finance_financial: only("financial", "unknown"),
        finance_compliance: 0,
        finance_operations: 0,
        compliance_compliance: only("compliance"),
        compliance_financial: 0,
        compliance_finance_list: 0,
        operations_operations: only("operations"),
        operations_compliance: 0,
        scoped_operations: 0,
        plain: 0,
        aal1: 0,
        unknown_family: 0,
      });
      assert.equal(
        keysOf(familyAs(world.ops, "operations")[0]),
        "assigned,assigned_to_me,canonical_id,canonical_type,detected_at,evidence_reference,exception_id,exception_type,resolution_notes,resolved_at,severity,source_id,source_type,status",
      );
      const assign = (staff, id, options = {}) =>
        asStaff(
          staff,
          `select public.staff_assign_reconciliation_exception('${id}', true);`,
          options,
        );
      const resolve = (staff, id) =>
        asStaff(
          staff,
          `select public.staff_resolve_reconciliation_exception('${id}', 'Synthetic resolution notes');`,
        );
      const acts = {
        finance_on_compliance: [
          assign(world.finance, item.compliance),
          resolve(world.finance, item.compliance),
        ],
        finance_on_operations: [
          assign(world.finance, item.operations),
          resolve(world.finance, item.operations),
        ],
        compliance_on_financial: [
          assign(world.compliance, item.financial),
          resolve(world.compliance, item.financial),
        ],
        operations_on_financial: [
          assign(world.ops, item.financial),
          resolve(world.ops, item.financial),
        ],
        operations_on_compliance: [
          assign(world.ops, item.compliance),
          resolve(world.ops, item.compliance),
        ],
        scoped_operations: [
          assign(world.opsS, item.operations),
          resolve(world.opsS, item.operations),
        ],
        plain: [
          assign(world.plainStaff, item.operations),
          resolve(world.plainStaff, item.financial),
        ],
        moderator: [assign(world.moderator, item.compliance)],
        aal1: [assign(world.ops, item.operations, AAL1)],
        unknown_holder: [assign(world.compliance, uid())],
        unknown_plain: [assign(world.plainStaff, uid())],
      };
      assert.deepEqual(acts, {
        finance_on_compliance: ["not_found", "not_found"],
        finance_on_operations: ["not_found", "not_found"],
        compliance_on_financial: ["not_found", "not_found"],
        operations_on_financial: ["not_found", "not_found"],
        operations_on_compliance: ["not_found", "not_found"],
        scoped_operations: ["denied", "denied"],
        plain: ["denied", "denied"],
        moderator: ["denied"],
        aal1: ["denied"],
        unknown_holder: ["not_found"],
        unknown_plain: ["denied"],
      });
      for (const id of Object.values(item)) {
        const row = exceptionRows(`id = '${id}'`)[0];
        assert.deepEqual([row.status, row.assigned], ["open", null]);
      }
      const own = {
        compliance: [
          assign(world.compliance, item.compliance),
          resolve(world.compliance, item.compliance),
        ],
        operations: [
          assign(world.ops, item.operations),
          resolve(world.ops, item.operations),
        ],
        financial: [
          assign(world.finance, item.financial),
          resolve(world.finance, item.financial),
        ],
        unknown_stays_financial: [
          assign(world.finance, item.unknown),
          resolve(world.finance, item.unknown),
        ],
      };
      for (const answers of Object.values(own)) {
        assert.deepEqual(answers, ["applied", "applied"]);
      }
      assert.deepEqual(
        auditsFor("reconciliation_exception", item.operations).map((a) => [
          a.action,
          a.actor_type,
          a.actor_user_id,
        ]),
        [
          ["reconciliation_exception.opened", "system", null],
          ["reconciliation_exception.assigned", "staff", world.ops.user],
          ["reconciliation_exception.resolved", "staff", world.ops.user],
        ],
      );
      assert.ok(
        familyAs(world.compliance, "compliance", "resolved").some(
          (row) =>
            row.exception_id === item.compliance &&
            row.resolution_notes === "Synthetic resolution notes" &&
            row.assigned_to_me === true,
        ),
      );
      return { families, lists, acts };
    },
  );

  await check(
    "REL-1 (PM INV-11: human resolution; IMP section 27 exit: operations without direct database edits) finance staff resolve an uncaptured authorization left by a cancellation without a database edit: staff_request_release needs manage_financial_operations (global, aal2), a reason, and a Consultation that has reached a terminal state; it moves the authorized attempt to release_pending through the S7 release path (one staff audit event with the reason and the cancellation and refund policy versions, one payment.release job), the provider's confirmation ends it authorization_released with no ledger entry, and the review exception is then resolved with notes; an attempt of a Consultation still undecided answers matter_open, a captured one not_releasable, an unknown one not_found, a blank reason invalid, and operations staff are denied; each refusal changes nothing",
    () => {
      const s = scheduledConsultation("S");
      const open = scheduledConsultation("S");
      const captured = readyConsultation("A");
      assert.equal(attorneyCancel(captured).outcome, "cancelled");
      const release = (staff, payment, reason, options = {}) =>
        asStaff(
          staff,
          `select public.staff_request_release(${lit(payment)}, ${lit(reason)});`,
          options,
        );
      const reason = "Synthetic release reason";
      const before = JSON.stringify([
        paymentOf(s.payment),
        paymentOf(open.payment),
        paymentOf(captured.payment),
      ]);
      const refusals = {
        matter_open: release(world.finance, open.payment, reason),
        not_releasable: release(world.finance, captured.payment, reason),
        unknown: release(world.finance, uid(), reason),
        blank_reason: release(world.finance, s.payment, " "),
        operations_staff: release(world.ops, s.payment, reason),
        plain_staff: release(world.plainStaff, s.payment, reason),
        aal1: release(world.finance, s.payment, reason, AAL1),
        client: as(
          "authenticated",
          s.client.auth,
          `select public.staff_request_release('${s.payment}', 'Synthetic');`,
          AAL1,
        ),
        before_cancellation: release(world.finance, s.payment, reason),
      };
      assert.deepEqual(refusals, {
        matter_open: "matter_open",
        not_releasable: "not_releasable",
        unknown: "not_found",
        blank_reason: "invalid",
        operations_staff: "denied",
        plain_staff: "denied",
        aal1: "denied",
        client: "denied",
        before_cancellation: "matter_open",
      });
      assert.equal(
        JSON.stringify([
          paymentOf(s.payment),
          paymentOf(open.payment),
          paymentOf(captured.payment),
        ]),
        before,
      );
      assert.equal(clientCancel(s).outcome, "cancelled");
      assert.equal(release(world.finance, s.payment, reason), "requested");
      assert.equal(paymentOf(s.payment).state, "release_pending");
      const audit = auditsOf(s.payment, "payment.release_requested");
      assert.deepEqual(
        [
          audit.length,
          audit[0].actor_type,
          audit[0].actor_user_id,
          audit[0].reason_code,
          audit[0].after.reason,
          audit[0].after.consultation_state,
          audit[0].policy_references,
        ],
        [
          1,
          "staff",
          world.finance.user,
          "staff_release",
          reason,
          "cancelled",
          [
            {
              policy_type_code: "cancellation",
              policy_version_id: world.policies.S.cancellation,
            },
            {
              policy_type_code: "refund",
              policy_version_id: world.policies.S.refund,
            },
          ],
        ],
      );
      assert.equal(release(world.finance, s.payment, reason), "not_releasable");
      const run = runJob(
        "payment.release",
        "payment_transaction",
        s.payment,
        () => obs("authorization_released", { payment_reference: s.reference }),
      );
      assert.equal(run.outcome, "applied");
      assert.equal(paymentOf(s.payment).state, "authorization_released");
      assert.deepEqual(ledgerOf(s.payment), []);
      const item = consultationExceptions(
        s.consultation,
        "cancellation_payment_review",
      )[0];
      assert.equal(
        asStaff(
          world.finance,
          `select public.staff_resolve_reconciliation_exception('${item.id}', 'Authorization released after the client cancelled.');`,
        ),
        "applied",
      );
      assert.equal(exceptionRows(`id = '${item.id}'`)[0].status, "resolved");
      return refusals;
    },
  );
}

// ---------------------------------------------------------------------------
// NOT: the S11 notification events
// ---------------------------------------------------------------------------

async function notificationChecks() {
  await check(
    "NOT-1 (TA section 27; MB section 98 \"review available\") the four S11 events use the S10 outbox unchanged: each creates one in-app (delivered) and one email (pending, one notification.deliver job) Notification per recipient, once; the vocabulary pairs each type with its one source event and refuses any other pair for every role; the center links a Consultation event to the recipient's own Consultation page and complaint_received to the recipient's own complaints page; the delivery job's context names the type and the recipient's notification center, never the outcome; a notification policy may name the new types as critical and still refuses an unknown one",
    () => {
      const cancelled = scheduledConsultation("S");
      assert.equal(clientCancel(cancelled).outcome, "cancelled");
      const completed = completedConsultation("S");
      const recorded = staleReady("S");
      assert.equal(
        recordOutcome(world.ops, recorded.consultation, "both_no_show").outcome,
        "recorded",
      );
      withAddress(completed.client);
      const complaint = openComplaint(
        completed.client,
        { consultation: completed.consultation },
        AAL1,
      ).id;
      const rows = (user, source) =>
        notificationsOf(user, `source_event_id = '${source}'`)
          .filter((n) => n.type !== "consultation_ready")
          .map((n) => [n.type, n.source_event_type, n.channel, n.state]);
      const observed = {
        cancelled_attorney: rows(cancelled.lawyer.user, cancelled.consultation),
        cancelled_client: rows(cancelled.client.user, cancelled.consultation),
        completed_client: rows(completed.client.user, completed.consultation),
        completed_attorney: rows(completed.lawyer.user, completed.consultation),
        recorded_client: rows(recorded.client.user, recorded.consultation),
        recorded_attorney: rows(recorded.lawyer.user, recorded.consultation),
        complaint: rows(completed.client.user, complaint),
      };
      const pair = (type, source) => [
        [type, source, "in_app", "delivered"],
        [type, source, "email", "pending"],
      ];
      assert.deepEqual(observed, {
        cancelled_attorney: pair(
          "consultation_cancelled",
          "consultation.cancelled",
        ),
        cancelled_client: [],
        completed_client: pair("review_available", "consultation.completed"),
        completed_attorney: [],
        recorded_client: pair(
          "consultation_outcome_recorded",
          "consultation.outcome_recorded",
        ),
        recorded_attorney: pair(
          "consultation_outcome_recorded",
          "consultation.outcome_recorded",
        ),
        complaint: pair("complaint_received", "complaint_case.opened"),
      });
      const linkOf = (account, type, options) =>
        centerAs(account, options)
          .filter((n) => n.notification_type === type)
          .map((n) => [n.link_path, n.email_state]);
      assert.deepEqual(
        [
          linkOf(cancelled.lawyer, "consultation_cancelled", {}),
          linkOf(completed.client, "review_available", AAL1),
          linkOf(recorded.client, "consultation_outcome_recorded", AAL1),
          linkOf(recorded.lawyer, "consultation_outcome_recorded", {}),
          linkOf(completed.client, "complaint_received", AAL1),
        ],
        [
          [[`/attorney/consultations/${cancelled.consultation}`, "pending"]],
          [[`/client/consultations/${completed.consultation}`, "pending"]],
          [[`/client/consultations/${recorded.consultation}`, "pending"]],
          [[`/attorney/consultations/${recorded.consultation}`, "pending"]],
          [["/client/complaints", "pending"]],
        ],
      );
      const email = emailNotification(
        completed.client.user,
        "complaint_received",
        complaint,
      );
      const job = deliveryJob(email.id);
      assert.ok(job, "one delivery job");
      claimJob(job);
      const context = notificationContext(job);
      assert.deepEqual(
        [
          context.outcome,
          context.notification_type,
          context.center_path,
          context.recipient_address === addressOf(completed.client),
        ],
        ["act", "complaint_received", "/client/notifications", true],
      );
      const insert = (type, source) =>
        `insert into public.notifications (recipient_user_id, notification_type, source_event_type, source_event_id, channel, state, critical, ack_required, sent_at, delivered_at, created_at) values ('${completed.client.user}', '${type}', '${source}', '${uid()}', 'in_app', 'delivered', false, false, now(), now(), now());`;
      const vocabulary = {
        wrong_source: refused(insert("review_available", "consultation.ready")),
        unknown_type: refused(
          insert("synthetic_type", "consultation.completed"),
        ),
        s10_pair_with_s11_source: refused(
          insert("consultation_ready", "consultation.cancelled"),
        ),
      };
      for (const code of Object.values(vocabulary)) {
        assert.equal(code, "23514");
      }
      const approvable = (parameters) =>
        sql(
          `select public.policy_parameters_approvable('notification', null, ${lit(parameters)}::jsonb);`,
        );
      assert.deepEqual(
        [
          approvable({
            critical_notification_types: [
              "consultation_cancelled",
              "consultation_outcome_recorded",
              "review_available",
              "complaint_received",
              "request_accepted",
            ],
          }),
          approvable({ critical_notification_types: ["synthetic_type"] }),
          approvable({
            acknowledgement_required_types: [
              "complaint_received",
              "complaint_received",
            ],
          }),
          sql("select cardinality(public.notification_types());"),
        ],
        ["t", "f", "f", "11"],
      );
      return observed;
    },
  );

  await check(
    "NOT-2 (PM INV-10; MBS section 15: a failed notification never rolls back a business event) with every notification insert refused (a temporary owner constraint, rolled back), a cancellation, a staff-recorded outcome, a completion and a complaint all still commit their business facts in full, and each missing Notification is audited as notification.not_created with what operations need to emit it again",
    () => {
      const cancel = scheduledConsultation("S");
      const stale = staleReady("S");
      const live = liveConsultation("S");
      const done = completedConsultation("S");
      const result = psql(
        [
          "begin;",
          "alter table public.notifications add constraint s11_proof_refuse_all check (false) not valid;",
          ...sessionLines("authenticated", cancel.client.auth, AAL1),
          `select outcome from public.consultation_cancel('${cancel.consultation}');`,
          "reset role;",
          ...sessionLines("authenticated", world.ops.auth),
          `select outcome from public.staff_record_consultation_outcome('${stale.consultation}', 'attorney_no_show', false);`,
          "reset role;",
          ...sessionLines("authenticated", live.lawyer.auth),
          `select outcome from public.consultation_end('${live.consultation}');`,
          "reset role;",
          ...sessionLines("authenticated", done.client.auth, AAL1),
          `select outcome from public.complaint_open('${done.consultation}', null);`,
          "reset role;",
          `select string_agg(state || '/' || outcome_code, ',' order by state) from public.consultations where id in ('${cancel.consultation}', '${stale.consultation}', '${live.consultation}');`,
          `select status from public.bookings where consultation_id = '${cancel.consultation}';`,
          `select count(*) from public.complaint_cases where consultation_id = '${done.consultation}';`,
          `select count(*) from public.notifications where source_event_id in ('${cancel.consultation}', '${stale.consultation}', '${live.consultation}') and notification_type in ('consultation_cancelled', 'consultation_outcome_recorded', 'review_available');`,
          `select string_agg(after_snapshot ->> 'notification_type', ',' order by after_snapshot ->> 'notification_type', after_snapshot ->> 'recipient_user_id') from public.audit_events where action_code = 'notification.not_created' and after_snapshot ->> 'source_event_id' in ('${cancel.consultation}', '${stale.consultation}', '${live.consultation}');`,
          `select count(*) from public.audit_events where action_code = 'notification.not_created' and after_snapshot ->> 'source_event_type' = 'complaint_case.opened' and after_snapshot ->> 'recipient_user_id' = '${done.client.user}' and after_snapshot ->> 'sqlstate' = '23514';`,
          "rollback;",
          "",
        ].join("\n"),
      );
      assert.equal(result.status, 0, result.stderr);
      const lines = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line !== "" && line !== "t");
      assert.deepEqual(lines, [
        "cancelled",
        "recorded",
        "completed",
        "opened",
        "cancelled/client_cancelled,completed/normal,no_show/attorney_no_show",
        "cancelled",
        "1",
        "0",
        "consultation_cancelled,consultation_outcome_recorded,consultation_outcome_recorded,review_available",
        "1",
      ]);
      // Rolled back: nothing of it remains.
      assert.deepEqual(
        [
          consultationRow(cancel.consultation).state,
          consultationRow(stale.consultation).state,
          consultationRow(live.consultation).state,
        ],
        ["scheduled", "ready", "live"],
      );
      return lines;
    },
  );
}

// ---------------------------------------------------------------------------
// PROD: production-class behaviour
// ---------------------------------------------------------------------------

async function productionChecks() {
  await check(
    "PROD-1 (Packet rule 7; MBS section 19) production-class behaviour of the functions that use policy selection: the outcome window is the configured one only under a selectable (approved, active, verified) scheduling version, and a development scheduling version is never selected in a production-class database, so the fail-safe rule applies there; an early completion and a manual resolution whose governing flow captures at_consultation_completion need the four-way gate for the payment_flow version and are refused configuration_unavailable production_gate_closed with nothing changed when it is closed, while one whose funds were captured earlier completes; an outcome that requests no capture (a failure to connect in a jurisdiction that is not live) is recorded without the gate",
    () => {
      prod.mode = prod.mode ?? newRegulatoryMode("SYN_S11_PROD_MODE", PROD_DB);
      const planted = prodJurisdiction("WINDOW_PLANTED", "live", "planted");
      const active = prodJurisdiction("WINDOW_ACTIVE", "live", "active");
      const notLive = prodJurisdiction("GATE_CLOSED", "restricted", "active");
      const ops = newAccount("active", PROD_DB);
      prodSql(
        `insert into public.staff_profiles (user_id, staff_state) values ('${ops.user}', 'active');
         insert into public.capability_grants (user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at)
           values ('${ops.user}', 'manage_consultation_operations', '${prod.grantor.user}', null, now() - interval '1 day');`,
      );
      const windowOf = (c) =>
        prodSql(
          `select basis || '|' || (policy_version_id is not null)::text from public.consultation_outcome_window('${c.consultation}', now());`,
        );
      const shift = (c, minutes) =>
        prodSql(
          `begin;
           set local session_replication_role = replica;
           update public.consultations set created_at = created_at - interval '${minutes} minutes', started_at = started_at - interval '${minutes} minutes' where id = '${c.consultation}';
           commit;`,
        );
      const stateOf = (c) =>
        prodSql(
          `select c.state || '|' || coalesce(c.outcome_code, '') || '|' || coalesce((select string_agg(p.state, ',') from public.payment_transactions p where p.consultation_id = c.id), 'none') || '|' || (select count(*) from public.audit_events a where a.resource_id = c.id) from public.consultations c where c.id = '${c.consultation}';`,
        );
      const earlyAs = (c) =>
        asIn(
          PROD_DB,
          "authenticated",
          c.attorney.auth,
          `select outcome || '|' || coalesce(problem, '') from public.consultation_end_early('${c.consultation}');`,
        );
      const outcomeAs = (c, code, acknowledge = false) =>
        asIn(
          PROD_DB,
          "authenticated",
          ops.auth,
          `select outcome || '|' || coalesce(problem, '') from public.staff_record_consultation_outcome('${c.consultation}', '${code}', ${acknowledge});`,
        );
      const windows = {
        development_version: windowOf(prodReadyConsultation(planted)),
        active_version: windowOf(prodReadyConsultation(active)),
      };
      assert.deepEqual(windows, {
        development_version: "fail_safe|false",
        active_version: "configured|true",
      });

      const earlyClosed = prodReadyConsultation(notLive, "live");
      prodLivePayment(
        earlyClosed,
        notLive,
        "at_consultation_completion",
        "authorized",
      );
      const earlyCaptured = prodReadyConsultation(notLive, "live");
      prodLivePayment(
        earlyCaptured,
        notLive,
        "at_attorney_acceptance",
        "captured",
      );
      const manualClosed = prodReadyConsultation(notLive, "live");
      prodLivePayment(
        manualClosed,
        notLive,
        "at_consultation_completion",
        "authorized",
      );
      shift(manualClosed, 36);
      const neither = prodReadyConsultation(notLive, "ready");
      shift(neither, 36);
      const failSafe = prodReadyConsultation(planted, "ready");
      shift(failSafe, 36);
      const before = [stateOf(earlyClosed), stateOf(manualClosed)];
      const answers = {
        early_gate_closed: earlyAs(earlyClosed),
        early_captured_earlier: earlyAs(earlyCaptured),
        manual_gate_closed: outcomeAs(manualClosed, "manual_resolution", true),
        neither_connected: outcomeAs(neither, "neither_connected"),
        fail_safe_after_36_minutes: outcomeAs(failSafe, "client_no_show"),
      };
      shift(failSafe, 1440);
      answers.fail_safe_after_a_day = outcomeAs(failSafe, "client_no_show");
      assert.deepEqual(answers, {
        early_gate_closed: "configuration_unavailable|production_gate_closed",
        early_captured_earlier: "completed|",
        manual_gate_closed: "configuration_unavailable|production_gate_closed",
        neither_connected: "recorded|",
        fail_safe_after_36_minutes: "window_open|fail_safe",
        fail_safe_after_a_day: "recorded|",
      });
      assert.deepEqual([stateOf(earlyClosed), stateOf(manualClosed)], before);
      assert.ok(before[0].startsWith("live||authorized|"), before[0]);
      assert.ok(
        stateOf(earlyCaptured).startsWith(
          "completed|early_by_agreement|captured|",
        ),
        stateOf(earlyCaptured),
      );
      assert.ok(
        stateOf(neither).startsWith(
          "technical_failure|neither_connected|none|",
        ),
        stateOf(neither),
      );
      return { windows, answers };
    },
  );
}

// ---------------------------------------------------------------------------
// MVP-001 S11 review corrections (20261127180000): CORR checks of the
// completion, payment and complaint corrections (R1, R2, R5, R6)
// ---------------------------------------------------------------------------

// A further synthetic jurisdiction of this disposable database, set up as the
// seed sets up its own (development configuration, test values only).
function correctionJurisdiction(key, flow, engagement = STANDARD_ENGAGEMENT) {
  if (world.J[key] !== undefined) {
    return world.J[key];
  }
  const id = newJurisdiction(`SYN_S11_CORR_${key}`);
  world.J[key] = id;
  policy("eligibility", id, ELIGIBILITY);
  policy("scheduling", id, STANDARD_SCHEDULING);
  policy("referral", id, { outcome_codes: ["synthetic_closed"] });
  policy("fee", id, FEE());
  mapMode(id, world.mode);
  policy("payment_flow", id, flow, world.mode);
  for (const type of ["payment", "cancellation", "refund"]) {
    policy(type, id, {}, world.mode);
  }
  policy("engagement", id, engagement, world.mode);
  return id;
}

// Q: a scheduled Request is authorized after the acceptance and captured at
// the acceptance (a late authorization after the acceptance is captured on
// its confirmation). E: every Request is authorized before the decision,
// captured at the acceptance, and its Engagement is effective at the
// capture.
const CORRECTION_FLOWS = Object.freeze({
  Q: () =>
    correctionJurisdiction("Q", FLOW(BEFORE, AT_ACCEPTANCE, AT_ACCEPTANCE)),
  E: () =>
    correctionJurisdiction(
      "E",
      FLOW_ALL(BEFORE, AT_ACCEPTANCE),
      ENGAGEMENT("attorney_acceptance", "at_payment_capture", 3600),
    ),
});

// An accepted scheduled Request of jurisdiction key without any payment
// attempt (the authorization follows the acceptance).
function unpaidIn(key) {
  const who = lawyer(key);
  const s = makeRequest({
    jurisdiction: world.J[key],
    requestPath: "scheduled",
    lawyer: who,
  });
  const decision = accept(who, s.request);
  assert.equal(decision.outcome, "accepted", JSON.stringify(decision));
  assert.equal(livePaymentOf(s.request), null);
  return { ...s, lawyer: who, consultation: decision.consultation };
}

const PAYMENT_STEP_SQL = (request) =>
  `select row_to_json(x)::text from public.client_request_payment(${lit(request)}) x;`;
const stepOf = (s) => {
  const row = oneRowAs(s.client, PAYMENT_STEP_SQL(s.request), AAL1);
  return `${row.payment_step}|${row.payable}`;
};
const paymentCount = (s) =>
  count("payment_transactions", `consultation_request_id = '${s.request}'`);

// The client's authorization, played through the hosted checkout job: a
// pending_authorization attempt.
function pendingAttempt(s) {
  const created = authorize(s.client, s.request);
  assert.equal(created.outcome, "created", created.line);
  runJob("payment.checkout", "payment_transaction", created.payment, () =>
    obs("checkout_open", { checkout_reference: checkoutRef() }),
  );
  return created.payment;
}

// The provider's confirmation of an authorization of exactly the quoted
// total (the webhook route, played as service_role).
function confirmAuthorization(s, payment) {
  const total = Number(
    sql(
      `select total_client_amount_minor from public.fee_calculations where consultation_request_id = '${s.request}';`,
    ),
  );
  const event = providerEvent(
    "payment_intent.amount_capturable_updated",
    obs("authorization_confirmed", {
      payment_transaction_id: payment,
      payment_reference: paymentRef(),
      amount_minor: total,
      currency_code: "XTS",
    }),
  );
  assert.equal(event.processing, "applied", event.line);
  return event;
}

const captureJob = (payment) =>
  openJob("payment.capture", "payment_transaction", payment);
const openItems = (consultation, type) =>
  consultationExceptions(consultation, type).filter((e) => e.status === "open")
    .length;

// An owner fixture (triggers bypassed): a Consultation planted in a terminal
// state with its outcome code, where no command reaches that state with the
// fixture's payment (each probe says why).
function plantTerminal(consultation, state, code) {
  sql(
    `begin;
     set local session_replication_role = replica;
     update public.consultations set state = '${state}', outcome_code = '${code}', ended_at = coalesce(ended_at, now()) where id = '${consultation}';
     commit;`,
  );
}

async function correctionChecks() {
  CORRECTION_FLOWS.Q();
  CORRECTION_FLOWS.E();

  await check(
    "CORR-R1a (MVP-001 S11 review correction R1; PM section 1 INV-11) a Request whose Consultation has ended is not payable: for an accepted Request whose flow authorizes after the acceptance, the client's payment step answers authorization_after_acceptance and payable while its Consultation is scheduled (and the authorization is created), but once the Consultation is cancelled by the client or by the attorney, recorded no_show or technical_failure by staff, or completed (an owner-planted completion: no command completes a Consultation the client never paid in this flow), the step answers not_applicable and not payable and client_authorize_payment answers not_payable with problem consultation_ended and creates no payment attempt",
    () => {
      const control = unpaidIn("Q");
      const controlStep = stepOf(control);
      const created = authorize(control.client, control.request);
      const answers = { scheduled: [controlStep, created.outcome] };
      assert.deepEqual(answers.scheduled, [
        "authorization_after_acceptance|true",
        "created",
      ]);
      const ends = {
        client_cancelled: (s) => clientCancel(s).outcome,
        attorney_cancelled: (s) => attorneyCancel(s).outcome,
        no_show: (s) => {
          shiftScheduled(s.consultation, 4 * 1440);
          return recordOutcome(world.ops, s.consultation, "client_no_show")
            .outcome;
        },
        technical_failure: (s) => {
          shiftScheduled(s.consultation, 4 * 1440);
          return recordOutcome(world.ops, s.consultation, "neither_connected")
            .outcome;
        },
        completed: (s) => {
          plantTerminal(s.consultation, "completed", "normal");
          return "planted";
        },
      };
      for (const [name, finish] of Object.entries(ends)) {
        const s = unpaidIn("Q");
        const ended = finish(s);
        const refused = authorize(s.client, s.request);
        answers[name] = [
          ended,
          consultationRow(s.consultation).state,
          stepOf(s),
          `${refused.outcome}|${refused.problem}`,
          paymentCount(s),
        ];
      }
      assert.deepEqual(answers, {
        scheduled: ["authorization_after_acceptance|true", "created"],
        client_cancelled: [
          "cancelled",
          "cancelled",
          "not_applicable|false",
          "not_payable|consultation_ended",
          0,
        ],
        attorney_cancelled: [
          "cancelled",
          "cancelled",
          "not_applicable|false",
          "not_payable|consultation_ended",
          0,
        ],
        no_show: [
          "recorded",
          "no_show",
          "not_applicable|false",
          "not_payable|consultation_ended",
          0,
        ],
        technical_failure: [
          "recorded",
          "technical_failure",
          "not_applicable|false",
          "not_payable|consultation_ended",
          0,
        ],
        completed: [
          "planted",
          "completed",
          "not_applicable|false",
          "not_payable|consultation_ended",
          0,
        ],
      });
      return answers;
    },
  );

  await check(
    "CORR-R1b (MVP-001 S11 review correction R1; PM INV-11; scenario B) an authorization confirmed after the Consultation ended requests no capture: in a flow that captures at the acceptance, a pending_authorization attempt whose authorization is confirmed while the Consultation is scheduled is captured as before (capture_pending, one capture job); one pending at a cancellation by the client or by the attorney, at a staff no_show, or at a technical failure (an owner-planted state: the staff outcome releases a pending attempt) becomes authorized with no capture job, and exactly one open review item of the Consultation exists afterwards (the cancellation's cancellation_payment_review or the outcome's outcome_payment_review, reused; the planted technical failure's opened), the first item's evidence unchanged",
    () => {
      const control = unpaidIn("Q");
      const controlPayment = pendingAttempt(control);
      confirmAuthorization(control, controlPayment);
      const outcome = {
        scheduled: [
          paymentOf(controlPayment).state,
          captureJob(controlPayment) !== null,
        ],
      };
      assert.deepEqual(outcome.scheduled, ["capture_pending", true]);
      const ends = {
        client_cancelled: [
          (s) => clientCancel(s).outcome,
          "cancellation_payment_review",
        ],
        attorney_cancelled: [
          (s) => attorneyCancel(s).outcome,
          "cancellation_payment_review",
        ],
        no_show: [
          (s) => {
            shiftScheduled(s.consultation, 4 * 1440);
            return recordOutcome(world.ops, s.consultation, "client_no_show")
              .outcome;
          },
          "outcome_payment_review",
        ],
        technical_failure: [
          (s) => {
            plantTerminal(
              s.consultation,
              "technical_failure",
              "mid_consultation_failure",
            );
            return "planted";
          },
          "outcome_payment_review",
        ],
      };
      for (const [name, [finish, type]] of Object.entries(ends)) {
        const s = unpaidIn("Q");
        const payment = pendingAttempt(s);
        const ended = finish(s);
        const before = consultationExceptions(s.consultation, type);
        confirmAuthorization(s, payment);
        const after = consultationExceptions(s.consultation, type);
        outcome[name] = [
          ended,
          paymentOf(payment).state,
          captureJob(payment) !== null,
          openItems(s.consultation, type),
        ];
        if (before.length === 1) {
          assert.deepEqual(after[0].evidence, before[0].evidence, name);
        } else {
          assert.equal(after[0].evidence.event, "authorization_confirmed_after_end");
        }
        assert.equal(after[0].canonical_id, payment, name);
      }
      assert.deepEqual(outcome, {
        scheduled: ["capture_pending", true],
        client_cancelled: ["cancelled", "authorized", false, 1],
        attorney_cancelled: ["cancelled", "authorized", false, 1],
        no_show: ["recorded", "authorized", false, 1],
        technical_failure: ["planted", "authorized", false, 1],
      });
      return outcome;
    },
  );

  await check(
    "CORR-R1c (MVP-001 S11 review correction R1) a capture confirmed after the Consultation was cancelled or ended unperformed records no Engagement: in a flow that captures at the acceptance with the Engagement effective at the capture, a capture confirmed while the Consultation is scheduled records one effective Engagement as before; one confirmed after a cancellation by the client, a staff no_show or a staff failure to connect records none, and exactly one open review item of the Consultation exists (the cancellation_payment_review or outcome_payment_review reused, or for the failure to connect the critical funds_retained_after_technical_failure item reused), the payment captured",
    () => {
      const scheduled = (who) =>
        acceptedConsultation({
          key: "E",
          requestPath: "scheduled",
          who,
          capture: false,
        });
      const control = scheduled(lawyer("E"));
      assert.equal(paymentOf(control.payment).state, "capture_pending");
      confirmCapture(control);
      const outcome = {
        scheduled: [
          paymentOf(control.payment).state,
          engagementsOf(control.consultation).length,
        ],
      };
      assert.deepEqual(outcome.scheduled, ["captured", 1]);
      const ends = {
        client_cancelled: [
          (s) => clientCancel(s).outcome,
          "cancellation_payment_review",
        ],
        no_show: [
          (s) => {
            shiftScheduled(s.consultation, 4 * 1440);
            return recordOutcome(world.ops, s.consultation, "client_no_show")
              .outcome;
          },
          "outcome_payment_review",
        ],
        neither_connected: [
          (s) => {
            shiftScheduled(s.consultation, 4 * 1440);
            return recordOutcome(world.ops, s.consultation, "neither_connected")
              .outcome;
          },
          "funds_retained_after_technical_failure",
        ],
      };
      for (const [name, [finish, type]] of Object.entries(ends)) {
        const s = scheduled(lawyer("E"));
        assert.equal(paymentOf(s.payment).state, "capture_pending", name);
        const ended = finish(s);
        confirmCapture(s);
        outcome[name] = [
          ended,
          paymentOf(s.payment).state,
          engagementsOf(s.consultation).length,
          openItems(s.consultation, type),
        ];
      }
      assert.deepEqual(outcome, {
        scheduled: ["captured", 1],
        client_cancelled: ["cancelled", "captured", 0, 1],
        no_show: ["recorded", "captured", 0, 1],
        neither_connected: ["recorded", "captured", 0, 1],
      });
      return outcome;
    },
  );

  await check(
    "CORR-R2 (MVP-001 S11 review correction R2; fail-closed; PM rows 11 to 16) a Consultation cannot be cancelled at or after its nominal end: a scheduled Consultation whose booked slot has ended answers time_passed to its client and to its attorney and nothing changes (still scheduled, the Booking confirmed, no review item, no cancellation audit event, no notification), after which staff record the no-show it was; an instant ready Consultation past its creation plus its duration answers time_passed alike; a scheduled Consultation whose slot has begun but not ended is still cancelled (whether that should also be refused is an owner question)",
    () => {
      const s = scheduledConsultation("S");
      shiftScheduled(s.consultation, 4 * 1440);
      const audits = () =>
        count(
          "audit_events",
          `resource_id = '${s.consultation}' and action_code = 'consultation.cancelled'`,
        );
      const before = {
        state: consultationRow(s.consultation).state,
        booking: bookingsOf(s.consultation)[0].status,
        items: consultationExceptions(s.consultation, "cancellation_payment_review")
          .length,
        audits: audits(),
        notifications: count(
          "notifications",
          `source_event_id = '${s.consultation}' and notification_type = 'consultation_cancelled'`,
        ),
      };
      const answers = {
        client: clientCancel(s).outcome,
        attorney: attorneyCancel(s).outcome,
      };
      const after = {
        state: consultationRow(s.consultation).state,
        booking: bookingsOf(s.consultation)[0].status,
        items: consultationExceptions(s.consultation, "cancellation_payment_review")
          .length,
        audits: audits(),
        notifications: count(
          "notifications",
          `source_event_id = '${s.consultation}' and notification_type = 'consultation_cancelled'`,
        ),
      };
      assert.deepEqual(after, before);
      assert.deepEqual(before, {
        state: "scheduled",
        booking: "confirmed",
        items: 0,
        audits: 0,
        notifications: 0,
      });
      answers.staff = recordOutcome(world.ops, s.consultation, "client_no_show")
        .outcome;
      answers.recorded = consultationRow(s.consultation).outcome_code;
      const instant = staleReady("S");
      answers.instant = clientCancel(instant).outcome;
      answers.instant_state = consultationRow(instant.consultation).state;
      const begun = scheduledConsultation("S", {
        who: lawyer("S"),
        slot: nearSlot(120),
      });
      shiftScheduled(begun.consultation, 10);
      answers.begun_not_ended = clientCancel(begun).outcome;
      assert.deepEqual(answers, {
        client: "time_passed",
        attorney: "time_passed",
        staff: "recorded",
        recorded: "client_no_show",
        instant: "time_passed",
        instant_state: "ready",
        begun_not_ended: "cancelled",
      });
      return answers;
    },
  );

  await check(
    "CORR-R5 (MVP-001 S11 review correction R5; MBS section 19; production-class database) a completion that will request the capture at completion keeps the refusal of S9 PROD-2 and S11 PROD-1 and widens its condition to the four-way gate over every version the payment recorded: in a live, launch-authorized jurisdiction whose payment_flow version passes the gate, the attorney's normal end, an early completion by agreement and a staff manual resolution are each refused configuration_unavailable with nothing changed (the Consultation live with no outcome and its Media Room open, the payment authorized, no capture job, no review item, no completion audit event) when another recorded version fails it: a development-only engagement version (development_policy) or a cancellation version no longer selectable because it was suspended (production_gate_closed); with every recorded version passing, each completes (completed or recorded) and requests the capture (capture_pending, one capture job, no review item)",
    () => {
      const ops = newAccount("active", PROD_DB);
      prodSql(
        `insert into public.staff_profiles (user_id, staff_state) values ('${ops.user}', 'active');
         insert into public.capability_grants (user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at)
           values ('${ops.user}', 'manage_consultation_operations', '${prod.grantor.user}', null, now() - interval '1 day');`,
      );
      // A live, launch-authorized jurisdiction (with its active scheduling
      // version) whose seven payment version types each have an active,
      // approved, verified, non-development version under its regulatory
      // mode (the four-way gate holds for every type).
      const flow = FLOW_ALL(BEFORE, "at_consultation_completion");
      const openJurisdiction = (key) => {
        const jurisdiction = prodJurisdiction(key, "live", "active");
        const mode = newRegulatoryMode(
          `SYN_S11_R5_${uid().slice(0, 6).toUpperCase()}`,
          PROD_DB,
        );
        mapMode(jurisdiction.id, mode, PROD_DB);
        return {
          jurisdiction,
          mode,
          versions: {
            referral: prodActivePolicy("referral", jurisdiction.id, {
              outcome_codes: ["synthetic_closed"],
            }),
            fee: prodActivePolicy("fee", jurisdiction.id, FEE()),
            payment_flow: prodActivePolicy(
              "payment_flow",
              jurisdiction.id,
              flow,
              mode,
            ),
            payment: prodActivePolicy("payment", jurisdiction.id, {}, mode),
            engagement: prodActivePolicy(
              "engagement",
              jurisdiction.id,
              STANDARD_ENGAGEMENT,
              mode,
            ),
            cancellation: prodActivePolicy(
              "cancellation",
              jurisdiction.id,
              {},
              mode,
            ),
            refund: prodActivePolicy("refund", jurisdiction.id, {}, mode),
          },
        };
      };
      // A live planted Consultation with an authorized payment recording the
      // given versions, its Fee Calculation and its Request's and
      // Consultation's referral version consistent with them (owner, triggers
      // bypassed, as prodLivePayment).
      const livePaid = (world, versions) => {
        const c = prodReadyConsultation(world.jurisdiction, "live");
        const payment = uid();
        const fee = uid();
        prodSql(
          `begin;
           set local session_replication_role = replica;
           update public.consultation_requests set referral_policy_version_id = '${versions.referral}' where id = '${c.request}';
           update public.consultations set referral_policy_version_id = '${versions.referral}' where id = '${c.consultation}';
           insert into public.fee_calculations (id, consultation_request_id, fee_policy_version_id, attorney_listed_price_minor, platform_fee_minor, client_fee_minor, tax_or_other_required_fee_minor, total_client_amount_minor, currency_code, quote_valid_until, calculated_at, calculation_snapshot)
             values ('${fee}', '${c.request}', '${versions.fee}', 5000, 0, 0, 0, 5000, 'XTS', now() + interval '1 hour', now(), '{}'::jsonb);
           insert into public.payment_transactions (id, fee_calculation_id, consultation_request_id, consultation_id, jurisdiction_id, regulatory_mode_id, referral_policy_version_id, payment_policy_version_id, fee_policy_version_id, payment_flow_policy_version_id, engagement_policy_version_id, cancellation_policy_version_id, refund_policy_version_id, state, amount_authorized_minor, amount_captured_minor, currency_code, provider_code, provider_payment_reference, authorized_at, captured_at)
             values ('${payment}', '${fee}', '${c.request}', '${c.consultation}', '${world.jurisdiction.id}', '${world.mode}', '${versions.referral}', '${versions.payment}', '${versions.fee}', '${versions.payment_flow}', '${versions.engagement}', '${versions.cancellation}', '${versions.refund}', 'authorized', 5000, null, 'XTS', 'stripe', 'pi_synthetic_${payment.slice(0, 8)}', now() - interval '1 hour', null);
           commit;`,
        );
        return { ...c, payment };
      };
      const shift = (c, minutes) =>
        prodSql(
          `begin;
           set local session_replication_role = replica;
           update public.consultations set created_at = created_at - interval '${minutes} minutes', started_at = started_at - interval '${minutes} minutes' where id = '${c.consultation}';
           commit;`,
        );
      const finishes = {
        normal: (c) =>
          asIn(
            PROD_DB,
            "authenticated",
            c.attorney.auth,
            `select outcome || '|' || coalesce(problem, '') from public.consultation_end('${c.consultation}');`,
          ),
        early_by_agreement: (c) =>
          asIn(
            PROD_DB,
            "authenticated",
            c.attorney.auth,
            `select outcome || '|' || coalesce(problem, '') from public.consultation_end_early('${c.consultation}');`,
          ),
        manual_resolution: (c) => {
          shift(c, 36);
          return asIn(
            PROD_DB,
            "authenticated",
            ops.auth,
            `select outcome || '|' || coalesce(problem, '') from public.staff_record_consultation_outcome('${c.consultation}', 'manual_resolution', true);`,
          );
        },
      };
      // Everything a completion would change, as one text.
      const snapshot = (c) =>
        prodSql(
          `select concat_ws('|',
             (select state || ':' || coalesce(outcome_code, '-') || ':' || (ended_at is null)::text from public.consultations where id = '${c.consultation}'),
             (select state from public.media_rooms where consultation_id = '${c.consultation}'),
             (select state from public.payment_transactions where id = '${c.payment}'),
             (select count(*) from public.operational_jobs where job_type = 'payment.capture' and subject_id = '${c.payment}'),
             (select count(*) from public.reconciliation_exceptions where canonical_id = '${c.payment}' or source_id in ('${c.payment}', '${c.consultation}')),
             (select count(*) from public.audit_events where resource_id = '${c.consultation}' and action_code in ('consultation.completed', 'consultation.outcome_recorded')));`,
        );
      // The payment_flow version alone passes the gate in every case (the
      // earlier check, which these refusals now go beyond).
      const flowOnly = (world, versions) =>
        prodSql(
          `select coalesce(public.media_production_problem('${world.jurisdiction.id}', jsonb_build_array(jsonb_build_object('policy_type_code', 'payment_flow', 'policy_version_id', '${versions.payment_flow}', 'regulatory_mode_id', '${world.mode}')), now()), 'open');`,
        );
      const out = {};
      for (const [code, finish] of Object.entries(finishes)) {
        const key = code.slice(0, 3).toUpperCase();
        // Open: every recorded version passes; the completion captures.
        const open = openJurisdiction(`R5O${key}`);
        const paid = livePaid(open, open.versions);
        const openBefore = snapshot(paid);
        const openAnswer = finish(paid);
        const openAfter = snapshot(paid);
        // A development-only engagement version recorded.
        const developmentEngagement = prodPlantedDevelopment(
          "engagement",
          open.jurisdiction.id,
          STANDARD_ENGAGEMENT,
          open.mode,
        );
        const dev = livePaid(open, {
          ...open.versions,
          engagement: developmentEngagement,
        });
        const devBefore = snapshot(dev);
        const devAnswer = finish(dev);
        const devAfter = snapshot(dev);
        // The recorded cancellation version suspended: the cancellation type
        // is no longer selectable in the jurisdiction.
        const suspended = openJurisdiction(`R5S${key}`);
        const gated = livePaid(suspended, suspended.versions);
        prodSql(
          `update public.policy_versions set status = 'suspended' where id = '${suspended.versions.cancellation}';`,
        );
        const gateBefore = snapshot(gated);
        const gateAnswer = finish(gated);
        const gateAfter = snapshot(gated);
        out[code] = {
          flow_only: [
            flowOnly(open, open.versions),
            flowOnly(suspended, suspended.versions),
          ],
          open: [openAnswer, openBefore, openAfter],
          development_engagement: [devAnswer, devBefore === devAfter, devAfter],
          suspended_cancellation: [
            gateAnswer,
            gateBefore === gateAfter,
            gateAfter,
          ],
        };
        const answer = code === "manual_resolution" ? "recorded|" : "completed|";
        assert.deepEqual(out[code].flow_only, ["open", "open"], code);
        assert.equal(openBefore, "live:-:true|open|authorized|0|0|0", code);
        assert.equal(openAnswer, answer, code);
        assert.equal(
          openAfter,
          `completed:${code}:false|closing|capture_pending|1|0|1`,
          code,
        );
        assert.deepEqual(
          out[code].development_engagement,
          [
            "configuration_unavailable|development_policy",
            true,
            "live:-:true|open|authorized|0|0|0",
          ],
          code,
        );
        assert.deepEqual(
          out[code].suspended_cancellation,
          [
            "configuration_unavailable|production_gate_closed",
            true,
            "live:-:true|open|authorized|0|0|0",
          ],
          code,
        );
      }
      return out;
    },
  );

  await check(
    "CORR-R6 (MVP-001 S11 review correction R6) assigning a complaint case already assigned to the caller is a no-op: the first assignment moves the opened case to in_review assigned to the caller and is audited once; a repeated assignment answers applied and changes no column (updated_at included) and writes no audit event, in review and once escalated alike; an assignment by another holder still reassigns the case and is audited",
    () => {
      const s = scheduledConsultation("S");
      const opened = openComplaint(s.client, { consultation: s.consultation }, AAL1);
      assert.equal(opened.outcome, "opened");
      const audits = () =>
        count(
          "audit_events",
          `resource_id = '${opened.id}' and action_code = 'complaint_case.assigned'`,
        );
      const update = (staff, action) =>
        asStaff(staff, COMPLAINT_UPDATE_SQL(opened.id, action));
      const answers = { first: update(world.complaints, "assign") };
      const row = complaintRow(opened.id);
      const firstAudits = audits();
      answers.repeat = update(world.complaints, "assign");
      const repeatRow = complaintRow(opened.id);
      const repeatAudits = audits();
      answers.escalate = update(world.complaints, "escalate");
      const escalatedRow = complaintRow(opened.id);
      answers.repeat_escalated = update(world.complaints, "assign");
      const escalatedRepeatRow = complaintRow(opened.id);
      const escalatedAudits = audits();
      answers.other = update(world.complaintsS, "assign");
      const reassigned = complaintRow(opened.id);
      assert.deepEqual(answers, {
        first: "applied",
        repeat: "applied",
        escalate: "applied",
        repeat_escalated: "applied",
        other: "applied",
      });
      assert.equal(row.state, "in_review");
      assert.equal(row.assigned_to_user_id, world.complaints.user);
      assert.equal(firstAudits, 1);
      assert.deepEqual(repeatRow, row);
      assert.equal(repeatAudits, 1);
      assert.equal(escalatedRow.state, "escalated");
      assert.deepEqual(escalatedRepeatRow, escalatedRow);
      assert.equal(escalatedAudits, 1);
      assert.equal(reassigned.assigned_to_user_id, world.complaintsS.user);
      assert.equal(audits(), 2);
      return answers;
    },
  );
}

// ---------------------------------------------------------------------------
// EXIT: the M13 operations of this pass, through the functions only
// ---------------------------------------------------------------------------

async function exitCheck() {
  await check(
    "EXIT-1 (IMP section 27 exit: operations without direct database edits) through the functions alone: a client cancels a scheduled Consultation and finance staff release its authorization and resolve the review item; a Consultation is held and ended, its client reviews it, a moderator publishes the review and the public sees it with its count and average; the client reports a problem, complaint staff take the case and a Legal Hold is placed from it and later released; staff record the outcome of a Consultation nobody decided and the operations family shows nothing left open for it",
    () => {
      const journey = {};
      // 1. Cancellation and its human financial resolution.
      const cancelled = scheduledConsultation("S");
      journey.cancel = clientCancel(cancelled).outcome;
      journey.release = asStaff(
        world.finance,
        `select public.staff_request_release('${cancelled.payment}', 'Released after the client cancelled.');`,
      );
      journey.release_confirmed = runJob(
        "payment.release",
        "payment_transaction",
        cancelled.payment,
        () =>
          obs("authorization_released", {
            payment_reference: cancelled.reference,
          }),
      ).outcome;
      const review = consultationExceptions(
        cancelled.consultation,
        "cancellation_payment_review",
      )[0];
      journey.review_item = [
        asStaff(
          world.finance,
          `select public.staff_assign_reconciliation_exception('${review.id}', true);`,
        ),
        asStaff(
          world.finance,
          `select public.staff_resolve_reconciliation_exception('${review.id}', 'Authorization released.');`,
        ),
      ];
      // 2. Completion, review, publication, public read.
      const who = lawyer("S");
      const held = acceptedConsultation({ key: "S", who });
      journey.start = start(held).outcome;
      journey.end = end(held).outcome;
      const submitted = submitReview(
        held.client,
        held.consultation,
        5,
        "Synthetic exit review.",
      );
      journey.review = submitted.outcome;
      journey.publish = moderate(world.moderator, submitted.review, "publish");
      journey.public = publicReviewsOf(who.profile).map((row) => [
        row.rating,
        row.review_text,
        row.review_count,
        row.average_rating,
      ]);
      // 3. Complaint, assignment, Legal Hold.
      const complaint = openComplaint(
        held.client,
        { consultation: held.consultation },
        AAL1,
      );
      journey.complaint = complaint.outcome;
      journey.assign = updateComplaint(
        world.complaints,
        complaint.id,
        "assign",
      );
      const hold = placeHold(world.holds, "complaint_case", complaint.id);
      journey.hold = hold.outcome;
      journey.case_holds = complaintCaseAs(
        world.complaints,
        complaint.id,
      )[0].active_legal_holds;
      journey.release_hold = releaseHold(world.holds, hold.hold);
      // 4. A Consultation nobody decided.
      const stale = staleReady("S");
      journey.queued = staleQueueAs(world.ops).some(
        (row) => row.consultation_id === stale.consultation,
      );
      journey.outcome = recordOutcome(
        world.ops,
        stale.consultation,
        "neither_connected",
      ).outcome;
      journey.stale_payment = paymentOf(stale.payment).state;
      journey.operations_items = familyAs(world.ops, "operations").filter(
        (row) => row.canonical_id === stale.consultation,
      ).length;
      assert.deepEqual(journey, {
        cancel: "cancelled",
        release: "requested",
        release_confirmed: "applied",
        review_item: ["applied", "applied"],
        start: "started",
        end: "completed",
        review: "submitted",
        publish: "applied",
        public: [[5, "Synthetic exit review.", 1, 5]],
        complaint: "opened",
        assign: "applied",
        hold: "placed",
        case_holds: 1,
        release_hold: "released",
        queued: true,
        outcome: "recorded",
        stale_payment: "release_pending",
        operations_items: 0,
      });
      return journey;
    },
  );
}

// ---------------------------------------------------------------------------
// CONC: real concurrency (two or more persistent sessions)
// ---------------------------------------------------------------------------

const staffSession = (label, staff) => attorneySession(label, staff);

// One statement in its own transaction on a persistent session, as one
// request: the statement's SQLSTATE, the commit's (or rollback's) and rows.
async function requestOn(s, role, account, aal, statement) {
  await s.ok("begin;");
  if (role === "owner") {
    // The database-only sweeps run as the owner.
  } else if (role === "service_role") {
    await s.ok("set local role service_role;");
  } else {
    for (const line of sessionLines("authenticated", account.auth, { aal })) {
      await s.ok(line);
    }
  }
  const result = await s.send(statement);
  const finished = await s.send(
    result.sqlstate === "00000" ? "commit;" : "rollback;",
  );
  return {
    sqlstate: result.sqlstate,
    committed: finished.sqlstate,
    answer: result.rows[result.rows.length - 1] ?? null,
  };
}

const outcomeOf = (rows) => JSON.parse(lastLine(rows));

async function concurrencyChecks() {
  await check(
    "CONC-1 cancel racing start, both orders: the attorney's start holds the attorney's scheduling lock, the client's cancellation waits for it and then answers in_progress, changing nothing (the Consultation stays live with its Booking and no review item); a cancellation in progress makes the start wait, which then answers ended: the Consultation is cancelled, never started, and no capture was requested",
    async () => {
      const first = readyConsultation("S");
      const starter = await attorneySession("start-first", first.lawyer);
      assert.equal(
        outcomeOf(await starter.ok(START_SQL(first.consultation))).outcome,
        "started",
      );
      const canceller = await clientSession("cancel-second", first.client);
      const pendingCancel = canceller.send(CANCEL_SQL(first.consultation));
      await blockedBy(canceller.pid, starter.pid);
      await starter.ok("commit;");
      const cancelAnswer = outcomeOf((await pendingCancel).rows);
      await canceller.ok("commit;");
      starter.close();
      canceller.close();

      const second = readyConsultation("S");
      const canceller2 = await clientSession("cancel-first", second.client);
      assert.equal(
        outcomeOf(await canceller2.ok(CANCEL_SQL(second.consultation))).outcome,
        "cancelled",
      );
      const starter2 = await attorneySession("start-second", second.lawyer);
      const pendingStart = starter2.send(START_SQL(second.consultation));
      await blockedBy(starter2.pid, canceller2.pid);
      await canceller2.ok("commit;");
      const startAnswer = outcomeOf((await pendingStart).rows);
      await starter2.ok("commit;");
      canceller2.close();
      starter2.close();
      const outcome = {
        start_first: [
          cancelAnswer.outcome,
          consultationRow(first.consultation).state,
          consultationExceptions(
            first.consultation,
            "cancellation_payment_review",
          ).length,
        ],
        cancel_first: [
          startAnswer.outcome,
          startAnswer.problem,
          consultationRow(second.consultation).state,
          consultationRow(second.consultation).started_at,
          livePaymentOf(second.request).state,
        ],
      };
      assert.deepEqual(outcome, {
        start_first: ["in_progress", "live", 0],
        cancel_first: ["ended", "cancelled", "cancelled", null, "authorized"],
      });
      report.concurrency.cancel_racing_start = outcome;
      return outcome;
    },
  );

  await check(
    "CONC-2 cancel racing cancel (the client against the attorney, both orders): the first to hold the attorney's scheduling lock wins and the other waits, then answers already_cancelled with who cancelled; exactly one cancellation exists: one outcome code, one cancelled Booking, one review item, one audit event and the other participant's Notifications once",
    async () => {
      const results = {};
      for (const winner of ["client", "attorney"]) {
        const s = scheduledConsultation("S");
        const open = (role, label) =>
          role === "client"
            ? clientSession(label, s.client)
            : attorneySession(label, s.lawyer);
        const loser = winner === "client" ? "attorney" : "client";
        const w = await open(winner, `cancel-win-${winner}`);
        const won = outcomeOf(await w.ok(CANCEL_SQL(s.consultation)));
        const l = await open(loser, `cancel-lose-${loser}`);
        const pending = l.send(CANCEL_SQL(s.consultation));
        await blockedBy(l.pid, w.pid);
        await w.ok("commit;");
        const lost = outcomeOf((await pending).rows);
        await l.ok("commit;");
        w.close();
        l.close();
        const notified = winner === "client" ? s.lawyer : s.client;
        results[winner] = [
          won.outcome,
          lost.outcome,
          lost.problem,
          consultationRow(s.consultation).outcome_code,
          bookingsOf(s.consultation).map((b) => b.status),
          consultationExceptions(s.consultation, "cancellation_payment_review")
            .length,
          auditsOf(s.consultation, "consultation.cancelled").length,
          notificationPairs(notified.user, s.consultation).length,
        ];
      }
      assert.deepEqual(results, {
        client: [
          "cancelled",
          "already_cancelled",
          "client_cancelled",
          "client_cancelled",
          ["cancelled"],
          1,
          1,
          2,
        ],
        attorney: [
          "cancelled",
          "already_cancelled",
          "attorney_cancelled",
          "attorney_cancelled",
          ["cancelled"],
          1,
          1,
          2,
        ],
      });
      report.concurrency.cancel_racing_cancel = results;
      return results;
    },
  );

  await check(
    "CONC-3 cancel racing the staff outcome, both orders, on a Consultation whose window has ended: a staff outcome in progress makes the client's cancellation wait, which then answers ended (the no-show stands, one outcome_payment_review item, no cancellation item); a cancellation attempt in progress (refused time_passed: MVP-001 S11 review correction R2 refuses a cancellation at or after the nominal end, which the window's end follows) makes the staff outcome wait, which then records the no-show (one outcome item, no cancellation item)",
    async () => {
      const first = staleReady("S");
      const staff = await staffSession("outcome-first", world.ops);
      assert.equal(
        outcomeOf(
          await staff.ok(OUTCOME_SQL(first.consultation, "attorney_no_show")),
        ).outcome,
        "recorded",
      );
      const canceller = await clientSession("cancel-after", first.client);
      const pendingCancel = canceller.send(CANCEL_SQL(first.consultation));
      await blockedBy(canceller.pid, staff.pid);
      await staff.ok("commit;");
      const cancelAnswer = outcomeOf((await pendingCancel).rows);
      await canceller.ok("commit;");
      staff.close();
      canceller.close();

      const second = staleReady("S");
      const canceller2 = await clientSession("cancel-before", second.client);
      assert.equal(
        outcomeOf(await canceller2.ok(CANCEL_SQL(second.consultation))).outcome,
        "time_passed",
      );
      const staff2 = await staffSession("outcome-after", world.ops);
      const pendingOutcome = staff2.send(
        OUTCOME_SQL(second.consultation, "client_no_show"),
      );
      await blockedBy(staff2.pid, canceller2.pid);
      await canceller2.ok("commit;");
      const outcomeAnswer = outcomeOf((await pendingOutcome).rows);
      await staff2.ok("commit;");
      canceller2.close();
      staff2.close();
      const itemsOfType = (s, type) =>
        consultationExceptions(s.consultation, type).length;
      const outcome = {
        outcome_first: [
          cancelAnswer.outcome,
          cancelAnswer.problem,
          consultationRow(first.consultation).outcome_code,
          itemsOfType(first, "outcome_payment_review"),
          itemsOfType(first, "cancellation_payment_review"),
        ],
        cancel_first: [
          outcomeAnswer.outcome,
          outcomeAnswer.problem,
          consultationRow(second.consultation).outcome_code,
          itemsOfType(second, "outcome_payment_review"),
          itemsOfType(second, "cancellation_payment_review"),
        ],
      };
      assert.deepEqual(outcome, {
        outcome_first: ["ended", "no_show", "attorney_no_show", 1, 0],
        cancel_first: ["recorded", null, "client_no_show", 1, 0],
      });
      report.concurrency.cancel_racing_staff_outcome = outcome;
      return outcome;
    },
  );

  await check(
    "CONC-4 end racing end-early (two sessions of the same attorney, both orders) with capture at completion: the first to hold the scheduling lock completes the Consultation with its own completion reason and requests the one capture; the other waits and answers ended; exactly one completion audit event and one capture request exist",
    async () => {
      const results = {};
      for (const [winner, first, second] of [
        ["end", END_SQL, EARLY_SQL],
        ["end_early", EARLY_SQL, END_SQL],
      ]) {
        const s = liveConsultation("C");
        const a = await attorneySession(`complete-first-${winner}`, s.lawyer);
        const won = outcomeOf(await a.ok(first(s.consultation)));
        const b = await attorneySession(`complete-second-${winner}`, s.lawyer);
        const pending = b.send(second(s.consultation));
        await blockedBy(b.pid, a.pid);
        await a.ok("commit;");
        const lost = outcomeOf((await pending).rows);
        await b.ok("commit;");
        a.close();
        b.close();
        results[winner] = [
          won.outcome,
          lost.outcome,
          lost.problem,
          consultationRow(s.consultation).outcome_code,
          auditsOf(s.consultation, "consultation.completed").length,
          auditsOf(s.payment, "payment.capture_requested").length,
          paymentOf(s.payment).state,
        ];
      }
      assert.deepEqual(results, {
        end: [
          "completed",
          "ended",
          "completed",
          "normal",
          1,
          1,
          "capture_pending",
        ],
        end_early: [
          "completed",
          "ended",
          "completed",
          "early_by_agreement",
          1,
          1,
          "capture_pending",
        ],
      });
      report.concurrency.end_racing_end_early = results;
      return results;
    },
  );

  await check(
    "CONC-5 two review submissions for one Consultation at once (two sessions of its client): the second waits for the first and answers already_reviewed; exactly one review exists, with the first submission's rating and text",
    async () => {
      const s = completedConsultation("S");
      const a = await clientSession("review-first", s.client);
      const first = lastLine(
        await a.ok(REVIEW_SQL(s.consultation, 5, "First submission.")),
      );
      const b = await clientSession("review-second", s.client);
      const pending = b.send(
        REVIEW_SQL(s.consultation, 1, "Second submission."),
      );
      await blockedBy(b.pid, a.pid);
      await a.ok("commit;");
      const second = lastLine((await pending).rows);
      await b.ok("commit;");
      a.close();
      b.close();
      const rows = jsonOf(
        `select coalesce(json_agg(json_build_object('rating', rating, 'text', review_text, 'state', state)), '[]'::json)::text from public.reviews where consultation_id = '${s.consultation}';`,
      );
      const outcome = {
        first: first.split("|")[0],
        second: second.split("|")[0],
        reviews: rows,
      };
      assert.deepEqual(outcome, {
        first: "submitted",
        second: "already_reviewed",
        reviews: [{ rating: 5, text: "First submission.", state: "submitted" }],
      });
      report.concurrency.two_review_submissions = outcome;
      return outcome;
    },
  );

  await check(
    "CONC-6 moderation racing a takedown, both orders (two moderators on one review): a publication in progress makes the rejection wait, which then takes the published review down (rejected, its first publication instant kept); a rejection in progress makes the publication wait, which then answers invalid_transition (the review is rejected and was never published); each decision is audited once",
    async () => {
      const prepare = () => {
        const s = completedConsultation("S");
        return submitReview(s.client, s.consultation, 4, "Raced.").review;
      };
      const publishFirst = prepare();
      const a = await staffSession("publish-first", world.moderator);
      const published = lastLine(
        await a.ok(MODERATE_SQL(publishFirst, "publish")),
      );
      const b = await staffSession("reject-second", world.moderatorS);
      const pendingReject = b.send(MODERATE_SQL(publishFirst, "reject"));
      await blockedBy(b.pid, a.pid);
      await a.ok("commit;");
      const rejected = lastLine((await pendingReject).rows);
      await b.ok("commit;");
      a.close();
      b.close();

      const rejectFirst = prepare();
      const c = await staffSession("reject-first", world.moderatorS);
      const rejectedFirst = lastLine(
        await c.ok(MODERATE_SQL(rejectFirst, "reject")),
      );
      const d = await staffSession("publish-second", world.moderator);
      const pendingPublish = d.send(MODERATE_SQL(rejectFirst, "publish"));
      await blockedBy(d.pid, c.pid);
      await c.ok("commit;");
      const publishedSecond = lastLine((await pendingPublish).rows);
      await d.ok("commit;");
      c.close();
      d.close();
      const facts = (review) => {
        const row = reviewRow(review);
        return [
          row.state,
          row.published_at !== null,
          auditsFor("review", review)
            .map((x) => x.action)
            .join(","),
        ];
      };
      const outcome = {
        publish_first: [published, rejected, ...facts(publishFirst)],
        reject_first: [rejectedFirst, publishedSecond, ...facts(rejectFirst)],
      };
      assert.deepEqual(outcome, {
        publish_first: [
          "applied",
          "applied",
          "rejected",
          true,
          "review.submitted,review.published,review.taken_down",
        ],
        reject_first: [
          "applied",
          "invalid_transition",
          "rejected",
          false,
          "review.submitted,review.rejected",
        ],
      });
      report.concurrency.moderation_racing_takedown = outcome;
      return outcome;
    },
  );

  await check(
    "CONC-7 a complaint opened twice at once about one Consultation: two sessions of the attorney (whose own rows are only share-locked, so the unique key itself decides) and two sessions of the client (serialized on the client's own profile row): in both pairs the second waits and answers already_open; each complainant has exactly one case, one Notification pair and one audit event",
    async () => {
      const s = completedConsultation("S");
      const results = {};
      for (const [role, open, account] of [
        ["attorney", (label) => attorneySession(label, s.lawyer), s.lawyer],
        ["client", (label) => clientSession(label, s.client), s.client],
      ]) {
        const a = await open(`complaint-first-${role}`);
        const first = lastLine(await a.ok(COMPLAINT_SQL(s.consultation, null)));
        const b = await open(`complaint-second-${role}`);
        const pending = b.send(COMPLAINT_SQL(s.consultation, null));
        await blockedBy(b.pid, a.pid);
        await a.ok("commit;");
        const second = lastLine((await pending).rows);
        await b.ok("commit;");
        a.close();
        b.close();
        const cases = jsonOf(
          `select coalesce(json_agg(id), '[]'::json)::text from public.complaint_cases where complainant_user_id = '${account.user}' and consultation_id = '${s.consultation}';`,
        );
        results[role] = [
          first.split("|")[0],
          second.split("|")[0],
          cases.length,
          notificationsOf(
            account.user,
            `notification_type = 'complaint_received' and source_event_id = '${cases[0]}'`,
          ).length,
          auditsFor("complaint_case", cases[0]).length,
        ];
      }
      assert.deepEqual(results, {
        attorney: ["opened", "already_open", 1, 2, 1],
        client: ["opened", "already_open", 1, 2, 1],
      });
      report.concurrency.complaint_opened_twice = results;
      return results;
    },
  );

  await check(
    "CONC-8 a hold release racing a second release (two staff sessions): the second waits on the hold and answers already_released; the hold is released once, by the first, with one release audit event, and its scope is covered until that commit",
    async () => {
      const s = liveConsultation("S");
      const doc = uploadDocument(s.client, s.consultation, clientOptions);
      const hold = placeHold(world.holds, "consultation", s.consultation).hold;
      const other = staffWith(["manage_legal_holds", null]);
      const a = await staffSession("release-first", world.holds);
      const first = lastLine(await a.ok(RELEASE_HOLD_SQL(hold)));
      const b = await staffSession("release-second", other);
      const pending = b.send(RELEASE_HOLD_SQL(hold));
      await blockedBy(b.pid, a.pid);
      const coveredBeforeCommit = heldNow(doc);
      await a.ok("commit;");
      const second = lastLine((await pending).rows);
      await b.ok("commit;");
      a.close();
      b.close();
      const row = holdRow(hold);
      const outcome = {
        first,
        second,
        covered_before_commit: coveredBeforeCommit,
        covered_after: heldNow(doc),
        released_by_first: row.released_by_user_id === world.holds.user,
        release_events: auditsFor("legal_hold", hold).filter(
          (x) => x.action === "legal_hold.released",
        ).length,
      };
      assert.deepEqual(outcome, {
        first: "released",
        second: "already_released",
        covered_before_commit: "t",
        covered_after: "f",
        released_by_first: true,
        release_events: 1,
      });
      report.concurrency.hold_release_racing_release = outcome;
      return outcome;
    },
  );

  await check(
    "CONC-9 mixed load with zero deadlocks: twelve sessions at once, each request in its own transaction as the application sends it, cancel, start, end, end early, record staff outcomes, read the stale queue and one Consultation, submit and moderate reviews, open complaints, place and release holds, authorize media access, send a message and run the database sweeps over shared Consultations of two attorneys; every statement completes without a deadlock (40P01) or a lock timeout (55P03) and commits; afterwards every Consultation has at most one outcome with one deciding audit event, one review exists, each complainant has one case, the hold was released once and no exception type is open twice for one source",
    async () => {
      const who = lawyer("S", "C");
      const ready = acceptedConsultation({ key: "S", who });
      const live = acceptedConsultation({ key: "C", who: lawyer("C") });
      assert.equal(start(live).outcome, "started");
      const stale = staleReady("S");
      const scheduled = scheduledConsultation("S", { who });
      const done = completedConsultation("S");
      const reviewed = completedConsultation("S");
      const review = submitReview(
        reviewed.client,
        reviewed.consultation,
        3,
        "Mixed load.",
      ).review;
      const hold = placeHold(
        world.holds,
        "consultation",
        done.consultation,
      ).hold;
      const otherOps = staffWith(["manage_consultation_operations", null]);
      const otherHolds = staffWith(["manage_legal_holds", null]);
      const STALE_SQL =
        "select count(*) from public.staff_stale_consultations(0);";
      const plans = [
        [
          "client-ready",
          [
            [
              "authenticated",
              ready.client,
              "aal1",
              ACCESS_SQL(ready.consultation),
            ],
            [
              "authenticated",
              ready.client,
              "aal1",
              CANCEL_SQL(ready.consultation),
            ],
            [
              "authenticated",
              ready.client,
              "aal1",
              COMPLAINT_SQL(ready.consultation, null),
            ],
            [
              "authenticated",
              ready.client,
              "aal1",
              "select count(*) from public.client_consultations();",
            ],
          ],
        ],
        [
          "attorney-ready",
          [
            ["authenticated", who, "aal2", START_SQL(ready.consultation)],
            ["authenticated", who, "aal2", CANCEL_SQL(ready.consultation)],
            ["authenticated", who, "aal2", CANCEL_SQL(scheduled.consultation)],
            ["authenticated", who, "aal2", END_SQL(ready.consultation)],
          ],
        ],
        [
          "client-scheduled",
          [
            [
              "authenticated",
              scheduled.client,
              "aal1",
              CANCEL_SQL(scheduled.consultation),
            ],
            [
              "authenticated",
              scheduled.client,
              "aal1",
              COMPLAINT_SQL(scheduled.consultation, null),
            ],
            [
              "authenticated",
              scheduled.client,
              "aal1",
              COMPLAINT_SQL(scheduled.consultation, null),
            ],
          ],
        ],
        [
          "attorney-live",
          [
            [
              "authenticated",
              live.lawyer,
              "aal2",
              EARLY_SQL(live.consultation),
            ],
            ["authenticated", live.lawyer, "aal2", END_SQL(live.consultation)],
            [
              "authenticated",
              live.lawyer,
              "aal2",
              COMPLAINT_SQL(live.consultation, null),
            ],
          ],
        ],
        [
          "attorney-live-2",
          [
            ["authenticated", live.lawyer, "aal2", END_SQL(live.consultation)],
            [
              "authenticated",
              live.lawyer,
              "aal2",
              EARLY_SQL(live.consultation),
            ],
            [
              "authenticated",
              live.lawyer,
              "aal2",
              "select count(*) from public.attorney_reviews();",
            ],
          ],
        ],
        [
          "client-live",
          [
            [
              "authenticated",
              live.client,
              "aal1",
              SEND_SQL(live.consultation, "Mixed load."),
            ],
            [
              "authenticated",
              live.client,
              "aal1",
              CANCEL_SQL(live.consultation),
            ],
            [
              "authenticated",
              live.client,
              "aal1",
              REVIEW_SQL(live.consultation, 4, "After the end."),
            ],
          ],
        ],
        [
          "ops-1",
          [
            [
              "authenticated",
              world.ops,
              "aal2",
              OUTCOME_SQL(stale.consultation, "client_no_show"),
            ],
            ["authenticated", world.ops, "aal2", STALE_SQL],
            [
              "authenticated",
              world.ops,
              "aal2",
              OUTCOME_SQL(live.consultation, "manual_resolution", true),
            ],
            [
              "authenticated",
              world.ops,
              "aal2",
              `select count(*) from public.staff_consultation('${ready.consultation}');`,
            ],
          ],
        ],
        [
          "ops-2",
          [
            [
              "authenticated",
              otherOps,
              "aal2",
              OUTCOME_SQL(stale.consultation, "attorney_no_show"),
            ],
            [
              "authenticated",
              otherOps,
              "aal2",
              OUTCOME_SQL(ready.consultation, "both_no_show"),
            ],
            ["authenticated", otherOps, "aal2", STALE_SQL],
          ],
        ],
        [
          "client-stale",
          [
            [
              "authenticated",
              stale.client,
              "aal1",
              CANCEL_SQL(stale.consultation),
            ],
            [
              "authenticated",
              stale.client,
              "aal1",
              COMPLAINT_SQL(stale.consultation, null),
            ],
          ],
        ],
        [
          "reviews",
          [
            [
              "authenticated",
              done.client,
              "aal1",
              REVIEW_SQL(done.consultation, 5, "Mixed load."),
            ],
            [
              "authenticated",
              world.moderator,
              "aal2",
              MODERATE_SQL(review, "publish"),
            ],
            [
              "authenticated",
              done.client,
              "aal1",
              REVIEW_SQL(done.consultation, 2, "Again."),
            ],
            [
              "authenticated",
              world.moderatorS,
              "aal2",
              MODERATE_SQL(review, "reject"),
            ],
          ],
        ],
        [
          "holds",
          [
            ["authenticated", world.holds, "aal2", RELEASE_HOLD_SQL(hold)],
            ["authenticated", otherHolds, "aal2", RELEASE_HOLD_SQL(hold)],
            [
              "authenticated",
              world.holds,
              "aal2",
              PLACE_HOLD_SQL(
                "consultation",
                ready.consultation,
                "Mixed load hold",
              ),
            ],
            [
              "authenticated",
              otherHolds,
              "aal2",
              PLACE_HOLD_SQL("user", ready.client.user, "Mixed load hold"),
            ],
          ],
        ],
        [
          "sweeps",
          [
            ["owner", null, null, SWEEP_SQL],
            ["owner", null, null, "select public.request_expiry_sweep();"],
            ["owner", null, null, SWEEP_SQL],
          ],
        ],
      ];
      const sessions = [];
      for (const [label] of plans) {
        sessions.push(await session(`mix-${label}`));
      }
      const states = [];
      const answers = {};
      await Promise.all(
        sessions.map(async (s, index) => {
          const [label, requests] = plans[index];
          answers[label] = [];
          for (const [role, account, aal, statement] of requests) {
            const result = await requestOn(s, role, account, aal, statement);
            states.push([label, result.sqlstate, result.committed]);
            answers[label].push(result.answer);
          }
        }),
      );
      for (const s of sessions) {
        s.close();
      }
      const failures = states.filter(
        ([, sqlstate, committed]) =>
          sqlstate !== "00000" || committed !== "00000",
      );
      assert.deepEqual(failures, []);
      // Invariants after the load.
      const deciding = (c) =>
        Number(
          sql(
            `select count(*) from public.audit_events where resource_id = '${c}' and action_code in ('consultation.cancelled', 'consultation.completed', 'consultation.outcome_recorded');`,
          ),
        );
      const terminal = [
        "completed",
        "cancelled",
        "no_show",
        "technical_failure",
      ];
      const facts = {};
      for (const [name, s] of Object.entries({
        ready,
        live,
        stale,
        scheduled,
      })) {
        const row = consultationRow(s.consultation);
        const decided = terminal.includes(row.state);
        assert.equal(deciding(s.consultation), decided ? 1 : 0, name);
        assert.equal(decided, row.outcome_code !== null, name);
        facts[name] = `${row.state}/${row.outcome_code ?? ""}`;
      }
      assert.ok(
        ["completed/normal", "completed/early_by_agreement"].includes(
          facts.live,
        ),
        facts.live,
      );
      assert.ok(
        [
          "no_show/client_no_show",
          "no_show/attorney_no_show",
          "cancelled/client_cancelled",
        ].includes(facts.stale),
        facts.stale,
      );
      assert.ok(
        ["cancelled/client_cancelled", "cancelled/attorney_cancelled"].includes(
          facts.scheduled,
        ),
        facts.scheduled,
      );
      assert.equal(
        count("reviews", `consultation_id = '${done.consultation}'`),
        1,
      );
      assert.equal(
        Number(
          sql(
            "select count(*) from (select complainant_user_id, consultation_id from public.complaint_cases where state <> 'resolved' and consultation_id is not null group by 1, 2 having count(*) > 1) as d;",
          ),
        ),
        0,
      );
      assert.equal(
        auditsFor("legal_hold", hold).filter(
          (x) => x.action === "legal_hold.released",
        ).length,
        1,
      );
      assert.equal(
        Number(
          sql(
            "select count(*) from (select exception_type, source_type, source_id from public.reconciliation_exceptions where status = 'open' and source_id is not null group by 1, 2, 3 having count(*) > 1) as d;",
          ),
        ),
        0,
      );
      assert.equal(
        Number(
          sql(
            "select count(*) from public.consultations where state in ('completed', 'cancelled', 'no_show', 'technical_failure') and (outcome_code is null or ended_at is null);",
          ),
        ),
        0,
      );
      report.concurrency.mixed_load = {
        sessions: sessions.length,
        statements: states.length,
        deadlocks: 0,
        lock_timeouts: 0,
        outcomes: facts,
        review_state: reviewRow(review).state,
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
    prod.grantor = newAccount("active", PROD_DB);
    prodSql(
      `insert into public.staff_profiles (user_id, staff_state) values ('${prod.grantor.user}', 'active');`,
    );
    await migrationChecks();
    await outcomeChecks();
    await earlyChecks();
    await cancellationChecks();
    await staffOutcomeChecks();
    await bookingStatusChecks();
    await completionFailureTests();
    await reviewChecks();
    await complaintChecks();
    await holdChecks();
    await familyChecks();
    await notificationChecks();
    await productionChecks();
    await correctionChecks();
    await exitCheck();
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
