// MVP-001 S10 disposable PostgreSQL proof (M12 Communications / Resources /
// Notifications).
// Explicitly invoked only:
//
//   node apps/web/tests/mvp-001-s10-db-proof.mjs
//
// Deliberately not a *.test.mjs file, so no application test run, p0:test,
// or CI job starts it. It uses Node built-ins and the system-installed
// PostgreSQL 16 initdb, pg_ctl, and psql binaries.
//
// It creates a new mode-0700 temporary directory, initializes a new cluster
// owned by an unprivileged account (never root), and starts it with TCP
// disabled and a private Unix-domain socket (port 54346, so it can run next
// to the MVP-001 S9 proof). The roles anon, authenticated, and service_role
// (BYPASSRLS), the synthetic auth schema (auth.users with the identity
// provider's email column, and an auth.uid() that reads
// request.jwt.claim.sub), the hosted platform's default privileges, and a
// no-op public.rls_auto_enable() are synthetic objects of this cluster only.
// Every migration is applied unmodified, in order, each in one transaction,
// to two databases: the main database records its environment as
// development; a second one records production (a synthetic 20-letter
// project reference) for the production gate probes. The five S10
// migrations (the fifth adds the PS-A5 document version lineage) must follow
// S9 and be registered.
//
// Configuration: every policy version of the development database is
// development configuration created by the owner role inside this disposable
// cluster (Packet rule 9). The post-consultation message window
// (post_consultation_message_window_seconds of the engagement policy type)
// and the critical and acknowledgement-required notification types (the
// notification policy type) differ per probe so every configured path is
// exercised both ways; they, the S9 timing keys, the engagement and
// payment_flow parameters, the XTS test currency, the synthetic modality,
// the SYN_* Regulatory Modes and every Request, payment, Message, document,
// address (on the reserved .invalid domain), provider reference and event is
// synthetic test data (FP-1 section 3.4), never a product value or decision.
// The production database uses owner-walked authority versions with a
// synthetic verified reference, or development rows planted with triggers
// bypassed for the negative probes; its Consultation fixtures are planted by
// the owner with triggers bypassed (the production gate, not the fixture, is
// what the probes examine).
//
// The providers are simulated: the probes play the worker (claim a job as
// the owner, read notification_job_context and record each provider call
// through notification_record_attempt as service_role, report the job with
// job_complete or job_fail), the job protocol's own claim (job_claim) and
// sweeper, and the webhook route (notification_record_provider_event as
// service_role). No provider, Supabase project, network service or
// pre-existing cluster is contacted, and nothing persists after the run.
// Some probes shift a completed Consultation's recorded end into the past as
// the owner with triggers bypassed (the proof cannot wait an hour for a
// window to close), or plant a terminal state the S11 completion types will
// own; each says so.
//
// Request sessions are modelled as PostgREST sets them from a verified JWT:
// request.jwt.claim.sub and the JSON request.jwt.claims (clients at aal1,
// attorneys at aal2 unless a probe says otherwise); anonymous requests run as
// anon without a subject.
//
// The probes cover the MVP-001 Packet S10 acceptance for the database: the
// MBS section 15 failure tests for 12A (participants only, no pre-booking
// messaging, the configured window both ways, read-only after it), 12B
// (storage-object guessing fails, a revoked grant prevents new access, an
// unauthorized attorney cannot read another attorney's shared resource, an
// active Legal Hold prevents deletion, versioning is gated) and 12C
// (duplicate delivery events never duplicate canonical state, retries are
// bounded and durable, a restart does not lose a pending critical job,
// permanent failure is observable and escalated where configured), that a
// failed notification never rolls back a business event, privileges, audit
// minimization, and the race list under real concurrency with two or more
// persistent sessions, with the exact observed outcomes. The JSON report
// goes to stdout; exit 0 means PASS, 1 FAIL, 2 cleanup failure.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertRegisteredLifecycle } from "./migration-lifecycle.mjs";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54346;
const DB = "rosuno_s10_proof";
const PROD_DB = "rosuno_s10_proof_production";
const PRODUCTION_REF = "synthetictenprodrefs";
const REPOSITORY_ROOT = path.resolve(
  path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
  "../../..",
);
const MIGRATIONS = path.join(REPOSITORY_ROOT, "supabase/migrations");
const S9_LAST = "20261125030000_mvp_001_s9_media_evidence.sql";
const S10_MIGRATIONS = Object.freeze([
  "20261126010000_mvp_001_s10_communication_integrity.sql",
  "20261126020000_mvp_001_s10_notifications.sql",
  "20261126030000_mvp_001_s10_messages.sql",
  "20261126040000_mvp_001_s10_documents.sql",
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
// MVP-001 S11 PS-A6: the break-glass, data request and complaint
// configuration migrations follow the review corrections (registered and
// checked by the S11 PS-A6 proof).
const S11_PS_A6_MIGRATIONS = Object.freeze([
  "20261127190000_mvp_001_s11_break_glass.sql",
  "20261127200000_mvp_001_s11_data_requests.sql",
  "20261127210000_mvp_001_s11_complaint_configuration.sql",
]);
// MVP-001 S11: the offered-start correction follows PS-A6 (registered and
// checked by the S6 proof).
const S11_OFFERED_START_MIGRATIONS = Object.freeze([
  "20261127220000_mvp_001_s11_offered_start_containment.sql",
]);
// The one migration that adds the PS-A5 column (its constraints and index).
const S10_VERSIONING = "20261126050000_mvp_001_s10_document_versioning.sql";

const report = {
  proof: "MVP-001 S10 disposable local PostgreSQL proof",
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
    path.join(os.tmpdir(), "rosuno-mvp-001-s10-db-proof-"),
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
    if (S10_MIGRATIONS.includes(file)) {
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
  // S10 follows S9, contiguous and in order, and every S10 migration is
  // registered (sequences 50 to 54) in a consistent lifecycle state.
  const s9 = files.indexOf(S9_LAST);
  assert.ok(s9 >= 0, "the last S9 migration is present");
  assert.deepEqual(files.slice(s9 + 1), [
    ...S10_MIGRATIONS,
    ...S11_MIGRATIONS,
    ...S11_OPERATIONS_MIGRATIONS,
    ...S11_SURFACES_MIGRATIONS,
    ...S11_CORRECTIONS_MIGRATIONS,
    ...S11_PS_A6_MIGRATIONS,
    ...S11_OFFERED_START_MIGRATIONS,
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
  S10_MIGRATIONS.forEach((file, index) => {
    const id = file.replace(/\.sql$/, "");
    const row = registered.find(
      (migration) => migration.artifact_path === `supabase/migrations/${file}`,
    );
    assert.ok(row, `${file} is registered`);
    assert.equal(row.migration_id, id);
    assert.equal(row.sequence, 50 + index);
    assertRegisteredLifecycle(row);
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
  report.migrations.s10 = [...S10_MIGRATIONS];
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
    const mark = `__S10_${this.label}_${this.n}__`;
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
    process.stderr.write(`[s10-proof] PASS ${name}\n`);
  } catch (error) {
    failed = true;
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
    process.stderr.write(
      `[s10-proof] FAIL ${name}\n${error?.stack ?? error}\n`,
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
      `insert into public.licenses (id, attorney_id, jurisdiction_id, license_number, reported_status) values ('${licence}', '${profile}', '${jurisdiction}', 'SYN-S10-LIC-${String(licenceNumber).padStart(4, "0")}', 'synthetic-active');
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
    `update public.operational_jobs set state = 'running', locked_at = now(), locked_by = 's10-proof', attempt_count = attempt_count + 1, available_at = now() + interval '60 seconds' where id = '${jobId}';`,
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
    `select public.job_complete('${jobId}', 's10-proof');`,
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
// S10 configuration, seed and call helpers
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

// The synthetic configuration of each jurisdiction (test values only; G-1,
// G-2, G-3, G-5, the S9 timing keys and the S10 window stay configuration).
// Every flow captures at the consultation start, so a Consultation reaches
// live and completed through the real S8 and S9 commands.
const STANDARD_FLOW = FLOW_ALL(BEFORE, "at_consultation_start");
const STANDARD_SCHEDULING = SCHEDULING({ ...TIMING(600, 300), ...NEAR });
const JURISDICTIONS = Object.freeze({
  // A one-hour post-consultation window.
  W: {
    flow: STANDARD_FLOW,
    engagement: ENGAGEMENT(
      "attorney_acceptance",
      "at_consultation_start",
      3600,
    ),
    scheduling: STANDARD_SCHEDULING,
  },
  // A zero window: read-only as soon as the Consultation is completed.
  Z: {
    flow: STANDARD_FLOW,
    engagement: ENGAGEMENT("attorney_acceptance", "at_consultation_start", 0),
    scheduling: STANDARD_SCHEDULING,
  },
  // No window key (the S8 shape): after completion the window is
  // unavailable and nothing is assumed.
  N: {
    flow: STANDARD_FLOW,
    engagement: ENGAGEMENT("attorney_acceptance", "at_consultation_start"),
    scheduling: STANDARD_SCHEDULING,
  },
});

function seed() {
  world.mode = newRegulatoryMode("SYN_S10_MARKETPLACE");
  world.J = {};
  world.policies = {};
  world.policies.bookability = policy("bookability", null, {
    presence_window_seconds: 600,
  });
  world.platform = policy("fee", null, PLATFORM);
  for (const [key, config] of Object.entries(JURISDICTIONS)) {
    const id = newJurisdiction(`SYN_S10_${key}`);
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
  const id = newJurisdiction(`SYN_S10_PROD_${key}`, PROD_DB, "ready");
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

// The triggers of the relations S10 touches: the earlier ones plus exactly the
// S10 guards, the two outbox triggers and the delivery escalation trigger.
const EXPECTED_TRIGGERS = [
  "consultation_requests.consultation_requests_acceptance_evidence",
  "consultation_requests.consultation_requests_change_guard",
  "consultation_requests.consultation_requests_hold_consistency",
  "consultation_requests.consultation_requests_no_truncate",
  "consultation_requests.consultation_requests_notification_events",
  "consultation_requests.consultation_requests_payment_consistency",
  "consultation_requests.consultation_requests_payment_release",
  "consultation_requests.consultation_requests_point_in_time_evidence",
  "consultation_requests.consultation_requests_relationship_consistency",
  "consultations.consultations_change_guard",
  "consultations.consultations_media_lifecycle",
  "consultations.consultations_no_truncate",
  "consultations.consultations_notification_events",
  // MVP-001 S11 re-pin: exactly the outcome notification trigger
  // (20261127070000) and the deferred outcome vocabulary check
  // (20261127010000) of the later registered S11 migrations.
  "consultations.consultations_outcome_notification_events",
  "consultations.consultations_outcome_vocabulary",
  "consultations.consultations_payment_consistency",
  "consultations.consultations_relationship_consistency",
  "consultations.consultations_set_updated_at",
  "messages.messages_no_truncate",
  "messages.messages_record_guard",
  "messages.messages_relationship_consistency",
  "notification_attempts.notification_attempts_append_only",
  "notification_attempts.notification_attempts_no_truncate",
  "notifications.notifications_lifecycle",
  "notifications.notifications_no_truncate",
  "operational_jobs.operational_jobs_lifecycle",
  "operational_jobs.operational_jobs_no_truncate",
  "operational_jobs.operational_jobs_notification_escalation",
  "operational_jobs.operational_jobs_payment_escalation",
  "resource_sharing_grants.resource_sharing_grants_guard",
  "resource_sharing_grants.resource_sharing_grants_integrity",
  "resource_sharing_grants.resource_sharing_grants_no_truncate",
].join(",");

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
    `select public.job_fail('${jobId}', 's10-proof', 'handler_failed', 'The job handler reported a failure.');`,
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

const S10_TABLES = Object.freeze([
  "messages",
  "notifications",
  "notification_attempts",
  "resources",
  "documents",
  "resource_sharing_grants",
  "operational_jobs",
  "audit_events",
  "external_event_receipts",
  "reconciliation_exceptions",
]);
const s10Counts = () =>
  Object.fromEntries(
    S10_TABLES.map((t) => [
      t,
      Number(sql(`select count(*) from public.${t};`)),
    ]),
  );
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
// MIG and PRIV: migrations, catalog and privileges
// ---------------------------------------------------------------------------

const S10_AUTHENTICATED_API = Object.freeze([
  "message_send(uuid, text)",
  "consultation_messages(uuid)",
  "consultation_messaging(uuid)",
  "document_begin_upload(uuid, text, bigint, text)",
  "document_revoke_sharing(uuid)",
  "consultation_documents(uuid)",
  "notification_center()",
  "notification_acknowledge(uuid)",
  "resource_finalize_upload(uuid)",
  "resource_abandon_upload(uuid)",
  "resource_authorize_access(uuid, text)",
  // PS-A5 (20261126050000): the replacement flow and the version history.
  "document_begin_replacement(uuid, uuid, text, bigint, text)",
  "document_finalize_replacement(uuid, uuid, uuid)",
  "document_versions(uuid, uuid)",
]);

const S10_SERVICE_API = Object.freeze([
  "notification_job_context(uuid)",
  "notification_record_attempt(uuid, text, text, text, text)",
  "notification_record_provider_event(text, text, text, timestamp with time zone, text, jsonb)",
]);

const S10_INTERNAL = Object.freeze([
  "message_record_guard()",
  "notification_lifecycle()",
  "notification_attempt_append_only()",
  "resource_sharing_grant_guard()",
  "notification_types()",
  "notification_type_list_valid(jsonb)",
  "notification_parameters_valid(jsonb)",
  "notification_configured_types(timestamp with time zone)",
  "policy_parameters_approvable(text, uuid, jsonb)",
  "notification_emit(uuid, text, text, uuid)",
  "notification_request_events()",
  "notification_consultation_events()",
  "notification_consultation_of(public.notifications)",
  "notification_recipient_role(public.notifications)",
  "notification_link_path(public.notifications)",
  "notification_audit(uuid, text, text, uuid, jsonb, jsonb, text)",
  "notification_fail_permanently(public.notifications, text, text)",
  "notification_job_escalated()",
  "notification_observation_valid(jsonb)",
  "notification_apply_observation(public.notifications, text)",
  "notification_replay_unmatched_events(uuid, text, text)",
  "notification_caller()",
  "engagement_parameters_valid(jsonb)",
  "communication_window(uuid, timestamp with time zone)",
  "communication_participant(uuid)",
  "communication_reader(uuid)",
  "document_finalize_upload(uuid, uuid)",
  // PS-A5 (20261126050000): the lineage guard and the per-version sharing.
  "document_version_guard()",
  "document_share_version(uuid, uuid, uuid, text, uuid)",
]);

const executors = (signature) =>
  sql(
    `select coalesce(string_agg(r.rolname, ',' order by r.rolname), '') from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') and has_function_privilege(r.rolname, 'public.${signature}', 'execute');`,
  );

const COMMUNICATION_TABLES = Object.freeze([
  "messages",
  "notifications",
  "notification_attempts",
  "resource_sharing_grants",
  "documents",
  "resources",
]);

// The SELECT privilege each API role holds on each relation after S10.
const SELECT_MATRIX = Object.freeze({
  messages: { anon: "f", authenticated: "f", service_role: "t" },
  notifications: { anon: "f", authenticated: "t", service_role: "t" },
  notification_attempts: { anon: "f", authenticated: "f", service_role: "t" },
  resource_sharing_grants: { anon: "f", authenticated: "t", service_role: "t" },
  documents: { anon: "f", authenticated: "t", service_role: "f" },
  resources: { anon: "f", authenticated: "f", service_role: "f" },
});

async function migrationChecks() {
  await check(
    "MIG-1 the five S10 migrations follow S9 in order, are registered (sequences 50 to 54) in a consistent lifecycle state, are Program migration refs, and apply on plain PostgreSQL to a development and a production-class database without notices",
    () => {
      assert.deepEqual(report.migrations.s10, [...S10_MIGRATIONS]);
      assert.deepEqual(
        report.migrations.notices,
        Object.fromEntries(S10_MIGRATIONS.map((file) => [file, []])),
      );
      return report.migrations.notices;
    },
  );

  await check(
    "MIG-2 no relation, column, type, row policy, view, sequence, policy type, capability or seed row is added (Packet rules 8, 10 and 16): the S10 texts create none and insert into no catalog table, except exactly the one PS-A5 column documents.supersedes_document_id (its foreign key, self-reference check and one-successor index) in the versioning migration; the six communication relations keep their P1 columns plus that one; the policy type catalog is unchanged; the only new indexes are the notification source-event uniqueness, the notification center, the attempt reference lookup, the Consultation document list, the partial lookup of unmatched provider receipts by provider reference and the PS-A5 one-successor index",
    () => {
      for (const file of S10_MIGRATIONS) {
        const raw = fs
          .readFileSync(path.join(MIGRATIONS, file), "utf8")
          .replace(/--[^\n]*/g, "");
        // The versioning migration's one admitted column, removed exactly
        // once before the same refusal applies to the rest of its text.
        const admitted =
          "alter table public.documents\n  add column supersedes_document_id uuid null;";
        if (file === S10_VERSIONING) {
          assert.equal(raw.split(admitted).length, 2, file);
        }
        const text = file === S10_VERSIONING ? raw.replace(admitted, "") : raw;
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
      assert.deepEqual(
        Object.fromEntries(COMMUNICATION_TABLES.map((t) => [t, columns(t)])),
        {
          messages:
            "id,consultation_id,sender_user_id,recipient_user_id,body,sent_at,visibility_state,created_at",
          notifications:
            "id,recipient_user_id,notification_type,source_event_type,source_event_id,channel,state,critical,ack_required,sent_at,delivered_at,failed_at,created_at",
          notification_attempts:
            "id,notification_id,provider_code,provider_reference,attempted_at,result,failure_code,created_at",
          resource_sharing_grants:
            "id,resource_id,recipient_user_id,context_type,context_id,purpose_code,granted_at,expires_at,revoked_at,granted_by_user_id",
          documents:
            "id,resource_id,document_type,version_label,created_at,supersedes_document_id",
          resources:
            "id,resource_kind,owner_user_id,intake_id,consultation_id,storage_bucket,storage_object_path,mime_type,byte_size,content_digest,visibility_state,retention_state,created_at,updated_at",
        },
      );
      assert.equal(
        sql(
          "select string_agg(code, ',' order by code) from public.policy_types;",
        ),
        // MVP-001 S11 PS-A6 adds exactly one policy type, complaint
        // (registered and checked by the S11 PS-A6 proof).
        "automated_referral_quality,bookability,cancellation,complaint,eligibility,engagement,fee,governance,notification,payment,payment_flow,referral,refund,reporting,retention,scheduling",
      );
      assert.equal(
        sql(
          "select count(*) from pg_policies where schemaname = 'public' and cmd <> 'SELECT';",
        ),
        "0",
      );
      const indexes = sql(
        "select string_agg(indexname, ',' order by indexname) from pg_indexes where schemaname = 'public' and tablename in ('messages', 'notifications', 'notification_attempts', 'resources', 'documents', 'resource_sharing_grants');",
      );
      assert.equal(
        indexes,
        "documents_one_successor_idx,documents_pkey,documents_resource_id_key,messages_consultation_created_at_idx,messages_pkey,notification_attempts_notification_id_idx,notification_attempts_pkey,notification_attempts_provider_reference_idx,notifications_in_app_recipient_idx,notifications_pkey,notifications_recipient_state_created_at_idx,notifications_source_event_unique,resource_sharing_grants_authorization_lookup_idx,resource_sharing_grants_pkey,resources_consultation_documents_idx,resources_pkey,resources_storage_identity_key",
      );
      const receiptIndexes = sql(
        "select string_agg(indexname || ':' || indexdef, ';' order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'external_event_receipts';",
      );
      assert.equal(
        receiptIndexes,
        [
          "external_event_receipts_correlation_idx:CREATE INDEX external_event_receipts_correlation_idx ON public.external_event_receipts USING btree (correlation_reference, received_at DESC) WHERE (correlation_reference IS NOT NULL)",
          "external_event_receipts_pkey:CREATE UNIQUE INDEX external_event_receipts_pkey ON public.external_event_receipts USING btree (id)",
          "external_event_receipts_provider_event_key:CREATE UNIQUE INDEX external_event_receipts_provider_event_key ON public.external_event_receipts USING btree (provider_code, provider_event_reference)",
          "external_event_receipts_unmatched_reference_idx:CREATE INDEX external_event_receipts_unmatched_reference_idx ON public.external_event_receipts USING btree (provider_code, ((minimal_payload ->> 'provider_reference'::text))) WHERE (processing_state = 'unmatched'::text)",
        ].join(";"),
      );
      // The PS-A5 column's constraints and index, exactly.
      const lineage = sql(
        "select string_agg(conname || ':' || pg_get_constraintdef(oid), ';' order by conname) from pg_constraint where conrelid = 'public.documents'::regclass and conname like 'documents_supersedes%';",
      );
      assert.equal(
        lineage,
        [
          "documents_supersedes_document_id_fkey:FOREIGN KEY (supersedes_document_id) REFERENCES documents(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
          "documents_supersedes_not_self_check:CHECK (((supersedes_document_id IS NULL) OR (supersedes_document_id <> id)))",
        ].join(";"),
      );
      assert.equal(
        sql(
          "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'documents_one_successor_idx';",
        ),
        "CREATE UNIQUE INDEX documents_one_successor_idx ON public.documents USING btree (supersedes_document_id) WHERE (supersedes_document_id IS NOT NULL)",
      );
      return { indexes, receiptIndexes, lineage };
    },
  );

  await check(
    "PRIV-1 the communication relations are function-only: no API role holds INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER (table or column) on messages, notifications, notification_attempts, resource_sharing_grants, documents or resources; SELECT: messages and notification_attempts for service_role only (authenticated reads Messages only through the S10 functions), notifications and grants for authenticated under the P1 row policies and service_role; anon none; direct writes are refused for authenticated and service_role",
    () => {
      for (const table of COMMUNICATION_TABLES) {
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
        "insert into public.messages (consultation_id, sender_user_id, recipient_user_id, body, sent_at, visibility_state) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x', now(), 'visible');",
        "update public.notifications set state = 'delivered';",
        "insert into public.notification_attempts (notification_id, provider_code, attempted_at, result, failure_code) values (gen_random_uuid(), 'synthetic_mail', now(), 'failed_transient', 'network');",
        "update public.resource_sharing_grants set revoked_at = now();",
        "delete from public.notifications;",
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
      return codes;
    },
  );

  await check(
    "PRIV-2 function privileges: the participant and center functions are security definer, pin their search_path and are executable by authenticated only (the volatile commands also bound their lock waits); the worker and webhook functions by service_role only; every internal and trigger function by no API role; anon executes nothing S10 adds; the trigger inventory of the affected relations is exactly the earlier one plus the S10 guards and the two outbox triggers and the escalation trigger",
    () => {
      for (const signature of S10_AUTHENTICATED_API) {
        assert.equal(executors(signature), "authenticated", signature);
        assert.equal(
          sql(
            `select prosecdef::text || '|' || exists (select 1 from unnest(proconfig) c where c = 'search_path=pg_catalog, pg_temp')::text from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          "true|true",
          signature,
        );
      }
      assert.equal(
        executors("has_resource_metadata_access(uuid)"),
        "authenticated",
      );
      // The replaced metadata predicate pins the house search_path.
      assert.equal(
        sql(
          "select prosecdef::text || '|' || provolatile::text || '|' || array_to_string(proconfig, ';') from pg_proc where oid = 'public.has_resource_metadata_access(uuid)'::regprocedure;",
        ),
        "true|s|search_path=pg_catalog, pg_temp",
      );
      // The re-application of unmatched provider events is an internal
      // security invoker helper with the house search_path.
      assert.equal(
        sql(
          "select prosecdef::text || '|' || array_to_string(proconfig, ';') from pg_proc where oid = 'public.notification_replay_unmatched_events(uuid, text, text)'::regprocedure;",
        ),
        "false|search_path=pg_catalog, pg_temp",
      );
      for (const signature of S10_SERVICE_API) {
        assert.equal(executors(signature), "service_role", signature);
        assert.equal(
          sql(
            `select prosecdef::text from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          "true",
          signature,
        );
      }
      for (const signature of S10_INTERNAL) {
        assert.equal(executors(signature), "", signature);
      }
      assert.equal(
        sql(
          "select string_agg(p.proname || ':' || array_to_string(p.proconfig, ';'), ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('message_send', 'document_begin_upload', 'document_begin_replacement', 'document_finalize_replacement', 'document_revoke_sharing', 'notification_acknowledge', 'notification_record_attempt', 'notification_record_provider_event', 'resource_finalize_upload', 'resource_abandon_upload', 'resource_authorize_access');",
        ),
        "document_begin_replacement:search_path=pg_catalog, pg_temp;lock_timeout=3s,document_begin_upload:search_path=pg_catalog, pg_temp;lock_timeout=3s,document_finalize_replacement:search_path=pg_catalog, pg_temp;lock_timeout=3s,document_revoke_sharing:search_path=pg_catalog, pg_temp;lock_timeout=3s,message_send:search_path=pg_catalog, pg_temp;lock_timeout=3s,notification_acknowledge:search_path=pg_catalog, pg_temp;lock_timeout=3s,notification_record_attempt:search_path=pg_catalog, pg_temp;lock_timeout=3s,notification_record_provider_event:search_path=pg_catalog, pg_temp;lock_timeout=3s,resource_abandon_upload:search_path=pg_catalog, pg_temp;lock_timeout=3s,resource_authorize_access:search_path=pg_catalog, pg_temp;lock_timeout=3s,resource_finalize_upload:search_path=pg_catalog, pg_temp;lock_timeout=3s",
      );
      // The outbox and escalation triggers run inside the S6 to S9 security
      // definer transactions and the S2 worker: as their owner, with a fixed
      // search_path.
      assert.equal(
        sql(
          "select string_agg(proname || ':' || prosecdef::text || ':' || array_to_string(proconfig, ';'), ',' order by proname) from pg_proc where oid in ('public.notification_request_events()'::regprocedure, 'public.notification_consultation_events()'::regprocedure, 'public.notification_job_escalated()'::regprocedure);",
        ),
        "notification_consultation_events:true:search_path=pg_catalog, pg_temp,notification_job_escalated:true:search_path=pg_catalog, pg_temp,notification_request_events:true:search_path=pg_catalog, pg_temp",
      );
      for (const role of ["anon", "service_role"]) {
        for (const statement of [
          "select * from public.message_send(gen_random_uuid(), 'x');",
          "select * from public.notification_center();",
          "select * from public.document_begin_upload(gen_random_uuid(), 'application/pdf', 1, 'sha256:00');",
        ]) {
          assert.equal(
            as(role, null, statement),
            "ERROR 42501",
            `${role} ${statement}`,
          );
        }
      }
      for (const role of ["anon", "authenticated"]) {
        for (const statement of [
          "select * from public.notification_job_context(gen_random_uuid());",
          "select public.notification_record_attempt(gen_random_uuid(), 'synthetic_mail', 'accepted', 'r', null);",
          "select * from public.notification_record_provider_event('synthetic_mail', 'msg_x', 'email.sent', now(), 'sha256:00', '{}'::jsonb);",
        ]) {
          assert.equal(
            as(
              role,
              role === "authenticated" ? world.ann.auth : null,
              statement,
            ),
            "ERROR 42501",
            `${role} ${statement}`,
          );
        }
      }
      const triggers = sql(
        "select string_agg(c.relname || '.' || t.tgname, ',' order by c.relname, t.tgname) from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relname in ('messages', 'notifications', 'notification_attempts', 'resource_sharing_grants', 'consultation_requests', 'consultations', 'operational_jobs');",
      );
      assert.equal(triggers, EXPECTED_TRIGGERS);
      return { triggers };
    },
  );

  await check(
    "PRIV-3 reads: a Notification is readable directly only by its recipient (the P1 row policy); a participant's direct read of messages is refused (no table privilege: Messages are read only through consultation_messages, which requires aal2 of the attorney); grants stay visible to their uploader and recipient only",
    () => {
      const s = liveConsultation("W");
      assert.equal(clientSend(s, "Synthetic question one.").outcome, "sent");
      const other = newClient();
      const visible = (account, options) =>
        as(
          "authenticated",
          account.auth,
          "select count(*) from public.notifications;",
          options,
        );
      const answers = {
        recipient_attorney: visible(s.lawyer, {}),
        sender_client: visible(s.client, clientOptions),
        other_client: visible(other, clientOptions),
        client_direct_messages: as(
          "authenticated",
          s.client.auth,
          "select count(*) from public.messages;",
          clientOptions,
        ),
        anon_notifications: as(
          "anon",
          null,
          "select count(*) from public.notifications;",
        ),
      };
      const own = Number(
        sql(
          `select count(*) from public.notifications where recipient_user_id = '${s.lawyer.user}';`,
        ),
      );
      assert.equal(Number(answers.recipient_attorney), own);
      assert.equal(
        Number(answers.sender_client),
        Number(
          sql(
            `select count(*) from public.notifications where recipient_user_id = '${s.client.user}';`,
          ),
        ),
      );
      assert.equal(answers.other_client, "0");
      assert.equal(answers.client_direct_messages, "ERROR 42501");
      assert.equal(answers.anon_notifications, "ERROR 42501");
      return answers;
    },
  );
}

// ---------------------------------------------------------------------------
// CFG: configuration seams and their approval validation
// ---------------------------------------------------------------------------

async function configurationChecks() {
  await check(
    "CFG-1 (MB-A1 section 1; Packet rules 6 and 8) the window key is optional in the existing engagement schema: every S8 two-key version stays valid and approvable, a window within 0..31536000 is valid, a malformed window (negative, too large, fractional, text) or any unknown key makes the version invalid as a whole; the notification keys are optional arrays of distinct S10 types; approval refuses a malformed notification version; nothing is defaulted",
    () => {
      const valid = (parameters) =>
        sql(
          `select public.engagement_parameters_valid(${lit(parameters)}::jsonb)::text || '|' || public.policy_parameters_approvable('engagement', null, ${lit(parameters)}::jsonb)::text;`,
        );
      const base = ENGAGEMENT("attorney_acceptance", "at_consultation_start");
      const engagement = {
        s8_shape: valid(base),
        window_zero: valid({
          ...base,
          post_consultation_message_window_seconds: 0,
        }),
        window_hour: valid({
          ...base,
          post_consultation_message_window_seconds: 3600,
        }),
        window_max: valid({
          ...base,
          post_consultation_message_window_seconds: 31536000,
        }),
        window_negative: valid({
          ...base,
          post_consultation_message_window_seconds: -1,
        }),
        window_too_large: valid({
          ...base,
          post_consultation_message_window_seconds: 31536001,
        }),
        window_fraction: valid({
          ...base,
          post_consultation_message_window_seconds: 1.5,
        }),
        window_text: valid({
          ...base,
          post_consultation_message_window_seconds: "3600",
        }),
        unknown_key: valid({ ...base, message_window: 3600 }),
        missing_creation: valid({
          engagement_effective: "at_consultation_start",
          post_consultation_message_window_seconds: 60,
        }),
      };
      assert.deepEqual(engagement, {
        s8_shape: "true|true",
        window_zero: "true|true",
        window_hour: "true|true",
        window_max: "true|true",
        window_negative: "false|false",
        window_too_large: "false|false",
        window_fraction: "false|false",
        window_text: "false|false",
        unknown_key: "false|false",
        missing_creation: "false|false",
      });
      const approvable = (parameters) =>
        sql(
          `select public.policy_parameters_approvable('notification', null, ${lit(parameters)}::jsonb)::text;`,
        );
      const notification = {
        empty: approvable({}),
        other_keys: approvable({ synthetic_other: true }),
        critical: approvable({
          critical_notification_types: ["request_accepted", "document_shared"],
        }),
        acknowledgement: approvable({
          acknowledgement_required_types: ["consultation_ready"],
        }),
        unknown_type: approvable({
          critical_notification_types: ["synthetic_type"],
        }),
        duplicate: approvable({
          critical_notification_types: ["request_accepted", "request_accepted"],
        }),
        not_array: approvable({
          critical_notification_types: "request_accepted",
        }),
        not_strings: approvable({ acknowledgement_required_types: [1] }),
        scheduling_unchanged: sql(
          `select public.policy_parameters_approvable('scheduling', null, ${lit(TIMING(600, 300))}::jsonb)::text || '|' || public.policy_parameters_approvable('scheduling', null, ${lit(TIMING(90000, 300))}::jsonb)::text;`,
        ),
      };
      assert.deepEqual(notification, {
        empty: "true",
        other_keys: "true",
        critical: "true",
        acknowledgement: "true",
        unknown_type: "false",
        duplicate: "false",
        not_array: "false",
        not_strings: "false",
        scheduling_unchanged: "true|false",
      });
      return { engagement, notification };
    },
  );

  await check(
    "CFG-2 the configured critical and acknowledgement types come only from one selectable, well-formed notification version: none -> none; a development version (development database) -> its arrays; a malformed one -> none; two applicable versions (a conflict) -> none",
    () => {
      const read = (setup) =>
        acceptedThenRolledBack(
          `${setup} select array_to_string(critical_types, ',') || '|' || array_to_string(acknowledgement_types, ',') from public.notification_configured_types(now());`,
        );
      const version = (parameters, label) =>
        `insert into public.policy_versions (policy_type_code, jurisdiction_id, regulatory_mode_id, version_label, parameters, status, effective_from, development_only) values ('notification', null, null, ${lit(label)}, ${lit(parameters)}::jsonb, 'draft', now() - interval '1 hour', true);`;
      const answers = {
        none: read(""),
        development: read(
          version(
            {
              critical_notification_types: [
                "request_accepted",
                "document_shared",
              ],
              acknowledgement_required_types: ["consultation_ready"],
            },
            "synthetic-cfg2-a",
          ),
        ),
        malformed: read(
          version(
            { critical_notification_types: ["synthetic_type"] },
            "synthetic-cfg2-b",
          ),
        ),
        conflict: read(
          version(
            { critical_notification_types: ["request_accepted"] },
            "synthetic-cfg2-c",
          ) +
            version(
              { critical_notification_types: ["request_declined"] },
              "synthetic-cfg2-d",
            ),
        ),
      };
      assert.deepEqual(answers, {
        none: "|",
        development: "document_shared,request_accepted|consultation_ready",
        malformed: "|",
        conflict: "|",
      });
      return answers;
    },
  );
}

// ---------------------------------------------------------------------------
// 12A: consultation-scoped Messages
// ---------------------------------------------------------------------------

async function messageChecks() {
  await check(
    "MSG-1 (MBS section 15 12A) only the Consultation's participants send, the recipient is always the other participant: the client (aal1) and the attorney (aal2) send; the attorney at aal1, another client, another attorney licensed in the same jurisdiction, a staff member and an unknown id answer alike not_found and nothing is written; anon and service_role cannot execute; the body is trimmed, never empty and at most 20 000 characters; each Message is stored once with its derived recipient, visible, and audited without its body",
    () => {
      const s = liveConsultation("W");
      const outsider = lawyer("W");
      const otherClient = newClient();
      const before = s10Counts();
      const refusals = {
        attorney_aal1: attorneySend(s, "Hello.", { aal: "aal1" }).outcome,
        other_client: sendAs(
          otherClient,
          s.consultation,
          "Hello.",
          clientOptions,
        ).outcome,
        other_attorney: sendAs(outsider, s.consultation, "Hello.").outcome,
        staff: sendAs(world.policyAdmin, s.consultation, "Hello.").outcome,
        unknown: sendAs(s.client, uid(), "Hello.", clientOptions).outcome,
        empty: clientSend(s, "").outcome,
        blank: clientSend(s, "  \n\t  ").outcome,
        too_long: clientSend(s, "x".repeat(20001)).outcome,
        anon: as("anon", null, SEND_SQL(s.consultation, "Hello.")),
        service_role: as(
          "service_role",
          null,
          SEND_SQL(s.consultation, "Hello."),
        ),
      };
      assert.deepEqual(refusals, {
        attorney_aal1: "not_found",
        other_client: "not_found",
        other_attorney: "not_found",
        staff: "not_found",
        unknown: "not_found",
        empty: "invalid",
        blank: "invalid",
        too_long: "invalid",
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      assert.deepEqual(deltaOf(before, s10Counts()), {});
      const fromClient = clientSend(s, "  A synthetic client question.  ");
      const fromAttorney = attorneySend(s, "A synthetic attorney answer.");
      const longest = clientSend(s, "y".repeat(20000));
      assert.equal(fromClient.outcome, "sent");
      assert.equal(fromAttorney.outcome, "sent");
      assert.equal(longest.outcome, "sent");
      const stored = jsonOf(
        `select json_agg(json_build_object('sender', sender_user_id, 'recipient', recipient_user_id, 'body', body, 'visibility', visibility_state) order by sent_at, id)::text from public.messages where id in ('${fromClient.message}', '${fromAttorney.message}');`,
      );
      assert.deepEqual(stored, [
        {
          sender: s.client.user,
          recipient: s.lawyer.user,
          body: "A synthetic client question.",
          visibility: "visible",
        },
        {
          sender: s.lawyer.user,
          recipient: s.client.user,
          body: "A synthetic attorney answer.",
          visibility: "visible",
        },
      ]);
      const audit = auditsFor("message", fromClient.message);
      assert.deepEqual(audit, [
        {
          action: "message.sent",
          actor_type: "client",
          actor_user_id: s.client.user,
          after: { consultation_id: s.consultation, sender_role: "client" },
          before: null,
          policy_references: null,
        },
      ]);
      assert.equal(
        JSON.stringify(audit).includes("synthetic client question"),
        false,
      );
      return { refusals, audit: audit[0].after };
    },
  );

  await check(
    "MSG-2 (MBS section 15 12A; MB sections 51-53) there is no pre-booking or open inbox: before a Consultation exists nothing is a message thread: a Request awaiting the attorney, its Intake or its Referral named as the Consultation answers not_found for the client and the attorney, and messages has no row without a Consultation (the P1 foreign key and the participant trigger stand)",
    () => {
      const who = lawyer("W");
      const pending = authorizedRequest({
        jurisdiction: world.J.W,
        requestPath: "instant",
        lawyer: who,
      });
      assert.equal(requestStateOf(pending.request), "awaiting_attorney");
      const answers = {
        client_request: sendAs(
          pending.client,
          pending.request,
          "Hi.",
          clientOptions,
        ).outcome,
        client_intake: sendAs(
          pending.client,
          pending.client.intake,
          "Hi.",
          clientOptions,
        ).outcome,
        attorney_request: sendAs(who, pending.request, "Hi.").outcome,
        attorney_referral: sendAs(who, pending.referral, "Hi.").outcome,
        orphan_insert: refused(
          `insert into public.messages (consultation_id, sender_user_id, recipient_user_id, body, sent_at, visibility_state) values ('${pending.request}', '${pending.client.user}', '${who.user}', 'x', now(), 'visible');`,
        ),
      };
      assert.deepEqual(answers, {
        client_request: "not_found",
        client_intake: "not_found",
        attorney_request: "not_found",
        attorney_referral: "not_found",
        orphan_insert: "23503",
      });
      return answers;
    },
  );

  await check(
    "MSG-3 the thread is read by both participants (client aal1, attorney aal2) oldest first with the sender's role and whether the reader sent it, and by nobody else (attorney aal1, another client, another attorney: no row); consultation_messaging reports open without an end while the Consultation is live",
    () => {
      const s = liveConsultation("W");
      const first = clientSend(s, "First synthetic message.");
      const second = attorneySend(s, "Second synthetic message.");
      const clientRead = messagesAs(s.client, s.consultation, clientOptions);
      const attorneyRead = messagesAs(s.lawyer, s.consultation);
      assert.deepEqual(
        clientRead.map((m) => [m.message_id, m.sender_role, m.mine, m.body]),
        [
          [first.message, "client", true, "First synthetic message."],
          [second.message, "attorney", false, "Second synthetic message."],
        ],
      );
      assert.deepEqual(
        attorneyRead.map((m) => [m.message_id, m.sender_role, m.mine]),
        [
          [first.message, "client", false],
          [second.message, "attorney", true],
        ],
      );
      // Each row also says whether older Messages exist that are not shown.
      assert.deepEqual(Object.keys(clientRead[0]), [
        "message_id",
        "sender_role",
        "mine",
        "body",
        "sent_at",
        "older_not_shown",
      ]);
      assert.deepEqual(
        [...clientRead, ...attorneyRead].map((m) => m.older_not_shown),
        [false, false, false, false],
      );
      const nobody = {
        attorney_aal1: messagesAs(s.lawyer, s.consultation, { aal: "aal1" })
          .length,
        other_client: messagesAs(newClient(), s.consultation, clientOptions)
          .length,
        other_attorney: messagesAs(lawyer("W"), s.consultation).length,
        messaging_other: messagingAs(
          newClient(),
          s.consultation,
          clientOptions,
        ),
      };
      assert.deepEqual(nobody, {
        attorney_aal1: 0,
        other_client: 0,
        other_attorney: 0,
        messaging_other: null,
      });
      assert.deepEqual(messagingAs(s.client, s.consultation, clientOptions), {
        status: "open",
        closes_at: null,
      });
      return nobody;
    },
  );

  await check(
    "MSG-4 (DM: Message content immutable once sent) a sent Message never changes and is never deleted or truncated, even by the owner role; a hidden visibility, an untrimmed or an over-long body cannot be stored",
    () => {
      const s = liveConsultation("W");
      const sent = clientSend(s, "An immutable synthetic message.");
      const codes = {
        update_body: refused(
          `update public.messages set body = 'changed' where id = '${sent.message}';`,
        ),
        update_visibility: refused(
          `update public.messages set visibility_state = 'hidden' where id = '${sent.message}';`,
        ),
        delete: refused(
          `delete from public.messages where id = '${sent.message}';`,
        ),
        truncate: refused("truncate public.messages cascade;"),
        hidden_insert: refused(
          `insert into public.messages (consultation_id, sender_user_id, recipient_user_id, body, sent_at, visibility_state) values ('${s.consultation}', '${s.client.user}', '${s.lawyer.user}', 'x', now(), 'hidden');`,
        ),
        untrimmed_insert: refused(
          `insert into public.messages (consultation_id, sender_user_id, recipient_user_id, body, sent_at, visibility_state) values ('${s.consultation}', '${s.client.user}', '${s.lawyer.user}', ' x', now(), 'visible');`,
        ),
        long_insert: refused(
          `insert into public.messages (consultation_id, sender_user_id, recipient_user_id, body, sent_at, visibility_state) values ('${s.consultation}', '${s.client.user}', '${s.lawyer.user}', repeat('z', 20001), now(), 'visible');`,
        ),
      };
      assert.deepEqual(codes, {
        update_body: "55000",
        update_visibility: "55000",
        delete: "55000",
        truncate: "55000",
        hidden_insert: "23514",
        untrimmed_insert: "23514",
        long_insert: "23514",
      });
      assert.equal(
        sql(`select body from public.messages where id = '${sent.message}';`),
        "An immutable synthetic message.",
      );
      return codes;
    },
  );

  await check(
    "MSG-5 (MB-A1 section 1; MB section 53) the post-consultation window both ways, from the Consultation's recorded engagement version: a one-hour window is open after completion until ended_at plus 3600 seconds and closed after it (the end shifted two hours back, owner fixture); a zero window is closed at once; no window key, a malformed window (owner-planted version) -> window_unavailable and nothing is sent (never assumed); an unrecorded engagement version falls back to the selected one; cancelled, no-show and technical failure (owner-planted, S11 owns them) are closed; reading stays open in every case",
    () => {
      const open = completedConsultation("W");
      const ended = consultationRow(open.consultation).ended_at;
      const status = messagingAs(open.client, open.consultation, clientOptions);
      assert.equal(status.status, "open");
      assert.equal(ms(status.closes_at) - ms(ended), 3600000);
      const answers = {
        window_open_client: clientSend(open, "Thanks, a follow-up.").outcome,
        window_open_attorney: attorneySend(open, "You are welcome.").outcome,
      };
      shiftEnded(open.consultation, 7200);
      answers.window_passed_client = clientSend(
        open,
        "One more question.",
      ).outcome;
      answers.window_passed_attorney = attorneySend(
        open,
        "One more answer.",
      ).outcome;
      answers.window_passed_status = messagingAs(
        open.lawyer,
        open.consultation,
      ).status;
      const zero = completedConsultation("Z");
      answers.zero_window = clientSend(zero, "After the end.").outcome;
      answers.zero_status = messagingAs(
        zero.client,
        zero.consultation,
        clientOptions,
      ).status;
      const none = completedConsultation("N");
      answers.no_key = clientSend(none, "After the end.").outcome;
      answers.no_key_attorney = attorneySend(none, "After the end.").outcome;
      answers.no_key_status = JSON.stringify(
        messagingAs(none.client, none.consultation, clientOptions),
      );
      const malformed = completedConsultation("W");
      const broken = policy(
        "engagement",
        world.J.W,
        {
          ...ENGAGEMENT("attorney_acceptance", "at_consultation_start"),
          post_consultation_message_window_seconds: -60,
        },
        world.mode,
      );
      // The broken version is closed at once so it never competes with W's
      // selected version; the planted Consultation keeps referring to it.
      closePolicy(broken);
      plantEngagement(malformed.consultation, broken);
      answers.malformed = clientSend(malformed, "After the end.").outcome;
      const fallback = completedConsultation("W");
      plantEngagement(fallback.consultation, null);
      answers.unrecorded_falls_back = clientSend(
        fallback,
        "After the end.",
      ).outcome;
      for (const state of ["cancelled", "no_show", "technical_failure"]) {
        const ending = readyConsultation("W");
        plantState(ending.consultation, state);
        answers[state] = clientSend(ending, "After the end.").outcome;
      }
      answers.reads_after_close = messagesAs(
        open.client,
        open.consultation,
        clientOptions,
      ).length;
      answers.reads_unavailable = messagesAs(
        none.lawyer,
        none.consultation,
      ).length;
      assert.deepEqual(answers, {
        window_open_client: "sent",
        window_open_attorney: "sent",
        window_passed_client: "closed",
        window_passed_attorney: "closed",
        window_passed_status: "closed",
        zero_window: "closed",
        zero_status: "closed",
        no_key: "window_unavailable",
        no_key_attorney: "window_unavailable",
        no_key_status: '{"status":"window_unavailable","closes_at":null}',
        malformed: "window_unavailable",
        unrecorded_falls_back: "sent",
        cancelled: "closed",
        no_show: "closed",
        technical_failure: "closed",
        reads_after_close: 2,
        reads_unavailable: 0,
      });
      return answers;
    },
  );

  await check(
    "MSG-6 each Message creates its recipient's two Notifications in the same transaction (one in-app delivered, one email pending with exactly one delivery job), never the sender's; the Message and its Notifications stay separate truths (the Notification references the Message, no body is copied); a Notification that cannot be created never rolls the Message back: with every notification insert refused (a temporary owner constraint, rolled back) the Message is sent and the failure is audited with its SQLSTATE only",
    () => {
      const s = liveConsultation("W");
      const sent = clientSend(s, "A synthetic message with notifications.");
      const recipient = notificationsOf(
        s.lawyer.user,
        `source_event_id = '${sent.message}'`,
      );
      assert.deepEqual(
        recipient.map((n) => [
          n.type,
          n.source_event_type,
          n.channel,
          n.state,
          n.sent,
          n.delivered,
        ]),
        [
          [
            "message_received",
            "message.sent",
            "in_app",
            "delivered",
            true,
            true,
          ],
          [
            "message_received",
            "message.sent",
            "email",
            "pending",
            false,
            false,
          ],
        ],
      );
      assert.deepEqual(
        notificationsOf(s.client.user, `source_event_id = '${sent.message}'`),
        [],
      );
      const email = recipient.find((n) => n.channel === "email");
      assert.ok(deliveryJob(email.id));
      assert.equal(
        sql(
          `select count(*) from public.operational_jobs where job_type = 'notification.deliver' and subject_id = '${email.id}';`,
        ),
        "1",
      );
      const sabotaged = psql(
        [
          "begin;",
          "alter table public.notifications add constraint s10_proof_refuse_all check (false) not valid;",
          ...sessionLines("authenticated", s.client.auth, { aal: "aal1" }),
          SEND_SQL(s.consultation, "Sent while notifications fail."),
          "reset role;",
          "select count(*) from public.notifications where source_event_type = 'message.sent' and source_event_id = (select id from public.messages where body = 'Sent while notifications fail.');",
          "select after_snapshot ->> 'sqlstate' from public.audit_events where action_code = 'notification.not_created' order by occurred_at desc limit 1;",
          "rollback;",
          "",
        ].join("\n"),
      );
      assert.equal(sabotaged.status, 0, sabotaged.stderr);
      const lines = sabotaged.stdout
        .trim()
        .split("\n")
        .filter((line) => line !== "" && line !== "t");
      assert.ok(lines[0].startsWith("sent|"), lines[0]);
      assert.deepEqual(lines.slice(1), ["0", "23514"]);
      return { failure: lines.slice(1) };
    },
  );

  await check(
    "MSG-7 (MBS section 19; PS-A2) in a production-class database the window never uses development configuration and needs the four-way gate for the engagement policy type: a completed Consultation recording a development engagement version (planted) and one whose jurisdiction is not live answer window_unavailable and nothing is written; with all four conditions the window is open; a live Consultation sends regardless (no policy is needed before completion)",
    () => {
      prod.mode = prod.mode ?? newRegulatoryMode("SYN_S10_PROD_MODE", PROD_DB);
      const window = ENGAGEMENT(
        "attorney_acceptance",
        "at_consultation_start",
        3600,
      );
      const planted = prodJurisdiction("MSG_PLANTED", "live", "active");
      const notLive = prodJurisdiction(
        "MSG_RESTRICTED",
        "restricted",
        "active",
      );
      const live = prodJurisdiction("MSG_LIVE", "live", "active");
      for (const j of [planted, notLive, live]) {
        prodSql(
          `insert into public.jurisdiction_regulatory_modes (jurisdiction_id, regulatory_mode_id, active_from, approval_status) values ('${j.id}', '${prod.mode}', now() - interval '1 day', 'synthetic');`,
        );
      }
      const versions = {
        planted: prodPlantedDevelopment(
          "engagement",
          planted.id,
          window,
          prod.mode,
        ),
        notLive: prodActivePolicy("engagement", notLive.id, window, prod.mode),
        live: prodActivePolicy("engagement", live.id, window, prod.mode),
      };
      const completedIn = (jurisdiction, version) => {
        const c = prodReadyConsultation(jurisdiction, "completed");
        prodSql(
          `begin;
           set local session_replication_role = replica;
           update public.consultations set ended_at = now(), engagement_policy_version_id = '${version}' where id = '${c.consultation}';
           commit;`,
        );
        return c;
      };
      const sendIn = (c) =>
        asIn(
          PROD_DB,
          "authenticated",
          c.client.auth,
          `select outcome from public.message_send('${c.consultation}', 'A synthetic production message.');`,
          { aal: "aal1" },
        );
      const count = () => prodSql("select count(*) from public.messages;");
      const before = count();
      const answers = {
        development_version: sendIn(completedIn(planted, versions.planted)),
        jurisdiction_not_live: sendIn(completedIn(notLive, versions.notLive)),
      };
      assert.equal(count(), before);
      answers.all_four_conditions = sendIn(completedIn(live, versions.live));
      answers.live_consultation = sendIn(
        prodReadyConsultation(notLive, "live"),
      );
      assert.deepEqual(answers, {
        development_version: "window_unavailable",
        jurisdiction_not_live: "window_unavailable",
        all_four_conditions: "sent",
        live_consultation: "sent",
      });
      return answers;
    },
  );

  await check(
    "MSG-8 (a recorded window never fails on its JSON form) a window written as any whole JSON number the validator admits (3600, 3600.0, 3600.000) in an approved engagement version behaves alike: approval accepts each and keeps its JSON text; every reader answers instead of failing on a cast: consultation_messaging, message_send, document_begin_upload and the document completion are open inside the window (ended_at plus exactly 3600 seconds) and closed after it",
    () => {
      const results = {};
      for (const windowText of ["3600", "3600.0", "3600.000"]) {
        const version = approvedEngagement(windowText);
        const stored = sql(
          `select status || '|' || (parameters ->> 'post_consultation_message_window_seconds') from public.policy_versions where id = '${version}';`,
        );
        const s = completedConsultation("W");
        plantEngagement(s.consultation, version);
        const ended = consultationRow(s.consultation).ended_at;
        const inside = messagingAs(s.client, s.consultation, clientOptions);
        const begun = beginDocument(s.lawyer, s.consultation);
        const pendingUpload = beginDocument(
          s.client,
          s.consultation,
          clientOptions,
        );
        const answer = {
          stored,
          inside_status: inside.status,
          inside_window_ms: ms(inside.closes_at) - ms(ended),
          inside_send: clientSend(s, "Inside the window.").outcome,
          inside_begin: begun.outcome,
          inside_finalize: finalizeAs(s.lawyer, begun.resource),
          inside_pending_begin: pendingUpload.outcome,
        };
        shiftEnded(s.consultation, 7200);
        answer.after_status = messagingAs(s.lawyer, s.consultation).status;
        answer.after_send = attorneySend(s, "After the window.").outcome;
        answer.after_begin = beginDocument(
          s.client,
          s.consultation,
          clientOptions,
        ).outcome;
        answer.after_finalize = finalizeAs(
          s.client,
          pendingUpload.resource,
          clientOptions,
        );
        results[windowText] = answer;
      }
      for (const [windowText, answer] of Object.entries(results)) {
        assert.deepEqual(
          answer,
          {
            stored: `approved|${windowText}`,
            inside_status: "open",
            inside_window_ms: 3600000,
            inside_send: "sent",
            inside_begin: "created",
            inside_finalize: "available",
            inside_pending_begin: "created",
            after_status: "closed",
            after_send: "closed",
            after_begin: "closed",
            after_finalize: "not_editable",
          },
          windowText,
        );
      }
      return results;
    },
  );

  await check(
    "MSG-9 (the thread is never silently truncated) consultation_messages answers the newest 500 Messages oldest first and every row says whether older Messages exist that are not shown: with exactly 500 Messages every row says false; after one more, 500 rows, every row says true, the newest Message is the last row and one older Message is no longer shown; both participants read alike",
    () => {
      const s = liveConsultation("W");
      const sent = as(
        "authenticated",
        s.client.auth,
        `select count(*) filter (where m.outcome = 'sent') from generate_series(1, 500) as g cross join lateral public.message_send(${lit(s.consultation)}, 'Synthetic thread message ' || g) as m;`,
        clientOptions,
      );
      assert.equal(sent, "500");
      const at500 = messagesAs(s.client, s.consultation, clientOptions);
      const at500Attorney = messagesAs(s.lawyer, s.consultation);
      assert.equal(
        clientSend(s, "The newest synthetic message.").outcome,
        "sent",
      );
      const at501 = messagesAs(s.client, s.consultation, clientOptions);
      const at501Attorney = messagesAs(s.lawyer, s.consultation);
      const flags = (rows) => [...new Set(rows.map((m) => m.older_not_shown))];
      const answers = {
        stored: count("messages", `consultation_id = '${s.consultation}'`),
        at_500: [at500.length, flags(at500)],
        at_500_attorney: [at500Attorney.length, flags(at500Attorney)],
        at_501: [at501.length, flags(at501)],
        at_501_attorney: [at501Attorney.length, flags(at501Attorney)],
        newest_last: at501[at501.length - 1].body,
        one_older_hidden: at500.filter(
          (m) => !at501.some((n) => n.message_id === m.message_id),
        ).length,
      };
      assert.deepEqual(answers, {
        stored: 501,
        at_500: [500, [false]],
        at_500_attorney: [500, [false]],
        at_501: [500, [true]],
        at_501_attorney: [500, [true]],
        newest_last: "The newest synthetic message.",
        one_older_hidden: 1,
      });
      return answers;
    },
  );
}

// ---------------------------------------------------------------------------
// 12B: documents, sharing grants and secure access
// ---------------------------------------------------------------------------

async function documentChecks() {
  await check(
    "DOC-1 (TA section 57; MB section 54) the upload pipeline for documents: a participant starts an upload from server-measured metadata (PDF, PNG or JPEG within the S3 ceiling), a pending resource of kind document at its own opaque path with its document record (v1); completion makes it available and, in the same transaction, creates exactly one grant to the other participant (consultation context, purpose consultation_document_exchange, granted by the uploader, no expiry) and that participant's Notifications; both directions (client and attorney); invalid metadata, the attorney at aal1, another attorney, another client and an unknown Consultation are refused with nothing written; an abandoned upload is rejected with the uploader's role; no upload count limit exists (an undecided product limit is never implemented: the participant's further uploads all start)",
    () => {
      const s = liveConsultation("W");
      const refusals = {};
      const before = s10Counts();
      refusals.audio = beginDocument(s.client, s.consultation, clientOptions, {
        mime: "audio/webm",
      }).outcome;
      refusals.empty = beginDocument(s.client, s.consultation, clientOptions, {
        size: 0,
      }).outcome;
      refusals.over_ceiling = beginDocument(
        s.client,
        s.consultation,
        clientOptions,
        { size: 1000001 },
      ).outcome;
      refusals.bad_digest = beginDocument(
        s.client,
        s.consultation,
        clientOptions,
        { digest: "md5:00" },
      ).outcome;
      refusals.attorney_aal1 = beginDocument(s.lawyer, s.consultation, {
        aal: "aal1",
      }).outcome;
      refusals.other_attorney = beginDocument(
        lawyer("W"),
        s.consultation,
      ).outcome;
      refusals.other_client = beginDocument(
        newClient(),
        s.consultation,
        clientOptions,
      ).outcome;
      refusals.unknown = beginDocument(s.client, uid(), clientOptions).outcome;
      assert.deepEqual(refusals, {
        audio: "invalid",
        empty: "invalid",
        over_ceiling: "invalid",
        bad_digest: "invalid",
        attorney_aal1: "not_found",
        other_attorney: "not_found",
        other_client: "not_found",
        unknown: "not_found",
      });
      assert.deepEqual(deltaOf(before, s10Counts()), {});
      const begun = beginDocument(s.client, s.consultation, clientOptions, {
        mime: "image/png",
        size: 4096,
      });
      assert.equal(begun.outcome, "created");
      const pending = rowOf("resources", `id = '${begun.resource}'`);
      assert.deepEqual(
        [
          pending.resource_kind,
          pending.owner_user_id,
          pending.consultation_id,
          pending.intake_id,
          pending.storage_bucket,
          pending.storage_object_path,
          pending.mime_type,
          pending.byte_size,
          pending.visibility_state,
          pending.retention_state,
        ],
        [
          "document",
          s.client.user,
          s.consultation,
          null,
          "rosuno-private-resources",
          objectPath(begun.resource),
          "image/png",
          4096,
          "pending",
          "active",
        ],
      );
      const record = rowOf("documents", `resource_id = '${begun.resource}'`);
      assert.deepEqual(
        [record.document_type, record.version_label],
        [null, "v1"],
      );
      assert.equal(
        count("resource_sharing_grants", `resource_id = '${begun.resource}'`),
        0,
      );
      assert.equal(
        finalizeAs(s.client, begun.resource, clientOptions),
        "available",
      );
      assert.equal(
        finalizeAs(s.client, begun.resource, clientOptions),
        "not_pending",
      );
      const grant = rowOf(
        "resource_sharing_grants",
        `resource_id = '${begun.resource}'`,
      );
      assert.deepEqual(
        [
          grant.recipient_user_id,
          grant.context_type,
          grant.context_id,
          grant.purpose_code,
          grant.expires_at,
          grant.revoked_at,
          grant.granted_by_user_id,
        ],
        [
          s.lawyer.user,
          "consultation",
          s.consultation,
          "consultation_document_exchange",
          null,
          null,
          s.client.user,
        ],
      );
      assert.deepEqual(
        notificationsOf(s.lawyer.user, `source_event_id = '${grant.id}'`).map(
          (n) => [n.type, n.channel, n.state],
        ),
        [
          ["document_shared", "in_app", "delivered"],
          ["document_shared", "email", "pending"],
        ],
      );
      const audits = jsonOf(
        `select json_agg(json_build_object('action', action_code, 'actor_type', actor_type) order by occurred_at, id)::text from public.audit_events where resource_id in ('${begun.resource}', '${grant.id}');`,
      );
      assert.deepEqual(audits, [
        { action: "resource_upload_started", actor_type: "client" },
        { action: "resource_upload_completed", actor_type: "client" },
        { action: "resource_sharing_grant.created", actor_type: "client" },
      ]);
      const fromAttorney = uploadDocument(s.lawyer, s.consultation);
      const attorneyGrant = rowOf(
        "resource_sharing_grants",
        `resource_id = '${fromAttorney}'`,
      );
      assert.deepEqual(
        [attorneyGrant.recipient_user_id, attorneyGrant.granted_by_user_id],
        [s.client.user, s.lawyer.user],
      );
      const abandoned = beginDocument(s.lawyer, s.consultation);
      assert.equal(abandonAs(s.lawyer, abandoned.resource), "rejected");
      assert.deepEqual(
        auditsFor("resource", abandoned.resource).map((a) => [
          a.action,
          a.actor_type,
        ]),
        [
          ["resource_upload_started", "attorney"],
          ["resource_upload_abandoned", "attorney"],
        ],
      );
      // No upload count limit: well beyond any former bound, every further
      // upload by the client (one so far) starts.
      const outcomes = [];
      for (let i = 0; i < 25; i += 1) {
        outcomes.push(
          beginDocument(s.client, s.consultation, clientOptions).outcome,
        );
      }
      assert.deepEqual(outcomes, Array(25).fill("created"));
      return { refusals, audits, further_uploads: outcomes.length };
    },
  );

  await check(
    "DOC-2 (MBS section 15 12B; PS section 29) secure access: a document is authorized to its uploader and to the recipient of its active grant, each a participant (the attorney at aal2), with its own opaque path for a short-lived signed URL and one audit event per authorization; the attorney at aal1, another attorney (even licensed in the same jurisdiction), another client, the wrong kind, an unknown id and a request without a subject are refused alike and audit nothing; a pending document is not_available; anon cannot execute; a document's metadata is readable directly by the attorney only at aal2",
    () => {
      const s = liveConsultation("W");
      const doc = uploadDocument(s.client, s.consultation, clientOptions);
      const pending = beginDocument(
        s.client,
        s.consultation,
        clientOptions,
      ).resource;
      const outsider = lawyer("W");
      const path = objectPath(doc);
      const matrix = {
        uploader_client: authorizeAs(s.client, doc, clientOptions),
        recipient_attorney: authorizeAs(s.lawyer, doc),
        attorney_aal1: authorizeAs(s.lawyer, doc, { aal: "aal1" }),
        other_attorney: authorizeAs(outsider, doc),
        other_client: authorizeAs(newClient(), doc, clientOptions),
        wrong_kind: authorizeAs(s.client, doc, clientOptions, "voice_memo"),
        unknown: authorizeAs(s.client, uid(), clientOptions),
        pending_owner: authorizeAs(s.client, pending, clientOptions),
        no_subject: as(
          "authenticated",
          null,
          `select outcome || '|' || coalesce(object_path, '') from public.resource_authorize_access('${doc}', 'document');`,
        ),
        anon: as(
          "anon",
          null,
          `select outcome from public.resource_authorize_access('${doc}', 'document');`,
        ),
      };
      assert.deepEqual(matrix, {
        uploader_client: `authorized|${path}`,
        recipient_attorney: `authorized|${path}`,
        attorney_aal1: "refused|",
        other_attorney: "refused|",
        other_client: "refused|",
        wrong_kind: "refused|",
        unknown: "refused|",
        pending_owner: "not_available|",
        no_subject: "refused|",
        anon: "ERROR 42501",
      });
      const accesses = auditsFor("resource", doc).filter(
        (a) => a.action === "resource_access_authorized",
      );
      assert.deepEqual(
        accesses.map((a) => [a.actor_user_id, a.actor_type, a.after]),
        [
          [
            s.client.user,
            "client",
            { resource_kind: "document", access: "signed_url" },
          ],
          [
            s.lawyer.user,
            "attorney",
            { resource_kind: "document", access: "signed_url" },
          ],
        ],
      );
      const metadata = (options) =>
        as(
          "authenticated",
          s.lawyer.auth,
          `select count(*) from public.resources where id = '${doc}';`,
          options,
        );
      const reads = { aal2: metadata({}), aal1: metadata({ aal: "aal1" }) };
      assert.deepEqual(reads, { aal2: "1", aal1: "0" });
      return { matrix, reads };
    },
  );

  await check(
    "DOC-3 (MBS section 15 12B; ROS section 12.4) the uploader revokes the grant: no new access is authorized for the recipient (the uploader keeps it), the list shows the grant revoked and the document no longer accessible to the recipient, a second revocation answers already_revoked, the recipient cannot revoke, and the grant's history stays (revoked_at set once; it can neither be cleared nor deleted); revocation is audited",
    () => {
      const s = liveConsultation("W");
      const doc = uploadDocument(s.client, s.consultation, clientOptions);
      assert.equal(authorizeAs(s.lawyer, doc), `authorized|${objectPath(doc)}`);
      const answers = {
        recipient_revokes: revokeAs(s.lawyer, doc),
        uploader_revokes: revokeAs(s.client, doc, clientOptions),
        again: revokeAs(s.client, doc, clientOptions),
        recipient_access: authorizeAs(s.lawyer, doc),
        uploader_access: authorizeAs(s.client, doc, clientOptions),
      };
      assert.deepEqual(answers, {
        recipient_revokes: "not_found",
        uploader_revokes: "revoked",
        again: "already_revoked",
        recipient_access: "refused|",
        uploader_access: `authorized|${objectPath(doc)}`,
      });
      const list = documentsAs(s.lawyer, s.consultation);
      assert.deepEqual(
        list.map((d) => [
          d.resource_id,
          d.uploaded_by,
          d.mine,
          d.sharing,
          d.accessible,
        ]),
        [[doc, "client", false, "revoked", false]],
      );
      assert.deepEqual(
        documentsAs(s.client, s.consultation, clientOptions).map((d) => [
          d.mine,
          d.sharing,
          d.accessible,
        ]),
        [[true, "revoked", true]],
      );
      const grant = rowOf("resource_sharing_grants", `resource_id = '${doc}'`);
      assert.ok(grant.revoked_at);
      const codes = {
        clear: refused(
          `update public.resource_sharing_grants set revoked_at = null where id = '${grant.id}';`,
        ),
        rewrite: refused(
          `update public.resource_sharing_grants set revoked_at = now() + interval '1 day' where id = '${grant.id}';`,
        ),
        delete: refused(
          `delete from public.resource_sharing_grants where id = '${grant.id}';`,
        ),
        truncate: refused("truncate public.resource_sharing_grants;"),
      };
      assert.deepEqual(codes, {
        clear: "23514",
        rewrite: "23514",
        delete: "55000",
        truncate: "55000",
      });
      assert.deepEqual(
        auditsFor("resource_sharing_grant", grant.id).map((a) => [
          a.action,
          a.actor_type,
          a.after.state,
        ]),
        [
          ["resource_sharing_grant.created", "client", "active"],
          ["resource_sharing_grant.revoked", "client", "revoked"],
        ],
      );
      return { answers, codes };
    },
  );

  await check(
    "DOC-4 (MBS section 15 12B: storage-object guessing fails; an unauthorized attorney cannot read another attorney's shared resource) path knowledge is never authorization: authenticated holds no privilege on the bucket or path columns and no function takes a path; another Consultation's participants are refused a document even knowing its id and path; a document can be shared only by its uploader with its own Consultation's other participant in the consultation context (any other grant, even by the owner role, is refused), so another attorney can never be given one",
    () => {
      const a = liveConsultation("W");
      const b = liveConsultation("W");
      const docA = uploadDocument(a.lawyer, a.consultation);
      const guessed = {
        b_client: authorizeAs(b.client, docA, clientOptions),
        b_attorney: authorizeAs(b.lawyer, docA),
      };
      assert.deepEqual(guessed, {
        b_client: "refused|",
        b_attorney: "refused|",
      });
      assert.equal(
        sql(
          "select count(*) from information_schema.column_privileges where table_schema = 'public' and table_name = 'resources' and grantee = 'authenticated' and column_name in ('storage_bucket', 'storage_object_path');",
        ),
        "0",
      );
      assert.equal(
        sql(
          "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute') and exists (select 1 from unnest(p.proargnames[1:p.pronargs]) a where a ~ '(object_path|storage)');",
        ),
        "0",
      );
      const grantSql = (
        resource,
        recipient,
        context,
        contextType = "consultation",
        purpose = "consultation_document_exchange",
        by = null,
      ) =>
        `insert into public.resource_sharing_grants (resource_id, recipient_user_id, context_type, context_id, purpose_code, granted_at, granted_by_user_id) values ('${resource}', '${recipient}', '${contextType}', '${context}', '${purpose}', now(), '${by ?? a.lawyer.user}');`;
      const codes = {
        to_other_attorney: refused(
          grantSql(docA, b.lawyer.user, a.consultation),
        ),
        to_other_client: refused(grantSql(docA, b.client.user, a.consultation)),
        other_context: refused(grantSql(docA, a.client.user, b.consultation)),
        other_context_type: refused(
          grantSql(docA, a.client.user, a.consultation, "synthetic_context"),
        ),
        other_purpose: refused(
          grantSql(
            docA,
            a.client.user,
            a.consultation,
            "consultation",
            "synthetic_purpose",
          ),
        ),
        not_by_uploader: refused(
          grantSql(
            docA,
            a.client.user,
            a.consultation,
            "consultation",
            "consultation_document_exchange",
            a.client.user,
          ),
        ),
      };
      for (const code of Object.values(codes)) {
        assert.equal(code, "23514");
      }
      return { guessed, codes };
    },
  );

  await check(
    "DOC-5 (MBS section 15 12B; PS section 26.2) an active Legal Hold on the document's Consultation (or the resource) stops access for both participants (held) and every deletion of the resource or its document record, for every role; once released, access is authorized again; nothing provides deletion (DOC-DEL unresolved)",
    () => {
      const s = liveConsultation("W");
      const doc = uploadDocument(s.client, s.consultation, clientOptions);
      const holdId = uid();
      sql(
        `insert into public.legal_holds (id, scope_type, scope_id, status, reason, started_at, created_by_user_id) values ('${holdId}', 'synthetic', '${s.consultation}', 'active', 'synthetic hold', now() - interval '1 minute', '${world.policyAdmin.user}');`,
      );
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
      sql(
        `update public.legal_holds set released_at = now(), released_by_user_id = '${world.policyAdmin.user}' where id = '${holdId}';`,
      );
      const resourceHold = uid();
      sql(
        `insert into public.legal_holds (id, scope_type, scope_id, status, reason, started_at, created_by_user_id) values ('${resourceHold}', 'synthetic', '${doc}', 'active', 'synthetic hold', now() - interval '1 minute', '${world.policyAdmin.user}');`,
      );
      held.resource_scope = authorizeAs(s.lawyer, doc);
      sql(
        `update public.legal_holds set released_at = now(), released_by_user_id = '${world.policyAdmin.user}' where id = '${resourceHold}';`,
      );
      held.released = authorizeAs(s.lawyer, doc);
      assert.deepEqual(held, {
        uploader: "held|",
        recipient: "held|",
        delete_document: "55000",
        delete_resource: "55000",
        resource_scope: "held|",
        released: `authorized|${objectPath(doc)}`,
      });
      assert.equal(
        sql(
          "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like '%delete%document%' or p.proname like 'document%delete%' or p.proname like '%resource%delete%' or p.proname like '%erase%');",
        ),
        "0",
      );
      return held;
    },
  );

  await check(
    "DOC-6 (MBS section 15 12B: replacing a document creates a new version rather than destroying historical truth; PS-A5) the uploader replaces a shared document twice through the real pipeline: v1 -> v2 -> v3, labels assigned by the server, each version superseding the previous one in the same Consultation; the earlier Documents, their resources and their grants are unchanged row for row and stay readable to those authorized (the uploader, and the recipient under each version's own grant); each new version gets its own grant to the other participant and that participant's Notifications; the current-documents list shows the lineage once, as v3 with its label and the lineage's first Document as its stable identity; a plain new upload stays a separate v1 beside it; no Document row ever changes",
    () => {
      const s = liveConsultation("W");
      const v1Resource = uploadDocument(
        s.client,
        s.consultation,
        clientOptions,
      );
      const v1 = documentIdOf(v1Resource);
      const snapshot = (resource, document) =>
        JSON.stringify([
          rowOf("resources", `id = '${resource}'`),
          documentRow(document),
          rowOf("resource_sharing_grants", `resource_id = '${resource}'`),
        ]);
      const before1 = snapshot(v1Resource, v1);
      const v2 = replaceDocument(s.client, v1, clientOptions);
      const before2 = snapshot(v2.resource, v2.document);
      const v3 = replaceDocument(s.client, v2.document, clientOptions);
      const plain = uploadDocument(s.client, s.consultation, clientOptions);
      const resources = [v1Resource, v2.resource, v3.resource];
      const grants = resources.map((resource) =>
        rowOf("resource_sharing_grants", `resource_id = '${resource}'`),
      );
      const answers = {
        chain: [v1, v2.document, v3.document].map((document) => {
          const row = documentRow(document);
          return [row.version_label, row.supersedes_document_id];
        }),
        same_consultation: resources.map(
          (resource) =>
            rowOf("resources", `id = '${resource}'`).consultation_id ===
            s.consultation,
        ),
        unchanged: [
          snapshot(v1Resource, v1) === before1,
          snapshot(v2.resource, v2.document) === before2,
        ],
        uploader_access: resources.map((resource) =>
          authorizeAs(s.client, resource, clientOptions),
        ),
        recipient_access: resources.map((resource) =>
          authorizeAs(s.lawyer, resource),
        ),
        grants: grants.map((grant) => [
          grant.recipient_user_id === s.lawyer.user,
          grant.granted_by_user_id === s.client.user,
          grant.purpose_code,
          grant.revoked_at,
        ]),
        notifications: grants.map((grant) =>
          count(
            "notifications",
            `recipient_user_id = '${s.lawyer.user}' and notification_type = 'document_shared' and source_event_id = '${grant.id}'`,
          ),
        ),
        list: documentsAs(s.lawyer, s.consultation).map((d) => [
          d.resource_id,
          d.document_id,
          d.lineage_id,
          d.version_label,
          d.earlier_versions_shared,
        ]),
        plain_label: documentRow(documentIdOf(plain)).version_label,
        update_refused: refused(
          `update public.documents set version_label = 'v9' where id = '${v1}';`,
        ),
        audits: auditsFor("resource", v2.resource).map((a) => [
          a.action,
          a.after.replaces_document_id ??
            a.after.supersedes_document_id ??
            null,
          a.after.version_label ?? null,
        ]),
      };
      assert.deepEqual(answers, {
        chain: [
          ["v1", null],
          ["v2", v1],
          ["v3", v2.document],
        ],
        same_consultation: [true, true, true],
        unchanged: [true, true],
        uploader_access: resources.map(
          (resource) => `authorized|${objectPath(resource)}`,
        ),
        recipient_access: resources.map(
          (resource) => `authorized|${objectPath(resource)}`,
        ),
        grants: [
          [true, true, "consultation_document_exchange", null],
          [true, true, "consultation_document_exchange", null],
          [true, true, "consultation_document_exchange", null],
        ],
        notifications: [2, 2, 2],
        list: [
          [v3.resource, v3.document, v1, "v3", true],
          [plain, documentIdOf(plain), documentIdOf(plain), "v1", false],
        ],
        plain_label: "v1",
        update_refused: "55000",
        audits: [
          ["resource_upload_started", v1, null],
          ["resource_upload_completed", v1, "v2"],
          ["resource_access_authorized", null, null],
          ["resource_access_authorized", null, null],
        ],
      });
      return answers;
    },
  );

  await check(
    "DOC-10 (PS-A5 rules in the database for every role, the owner included) linear history: a second Document superseding the same version is refused (one successor) and a Document never supersedes itself; same document, same context: a superseding Document in another Consultation or with another document type is refused (the same type is accepted); only consultation documents have versions (a voice memo never becomes one); a superseding Document needs its own available resource and an available predecessor (a pending one never takes the slot); the label is assigned by the server: any supplied label is refused, a legacy unlabelled Document counts as v1 and a legacy free-form label cannot be superseded; set once and history never destroyed: no update of the lineage (S3 guard) and no deletion of a superseded Document or its resource (restrict); API roles write no Document",
    () => {
      const s = liveConsultation("W");
      const other = liveConsultation("W");
      const v1Resource = uploadDocument(
        s.client,
        s.consultation,
        clientOptions,
      );
      const v1 = documentIdOf(v1Resource);
      const v2 = replaceDocument(s.client, v1, clientOptions);
      const plantResource = (consultation, owner, visibility = "available") => {
        const id = uid();
        sql(
          `insert into public.resources (id, resource_kind, owner_user_id, intake_id, consultation_id, storage_bucket, storage_object_path, mime_type, byte_size, content_digest, visibility_state, retention_state) values ('${id}', 'document', '${owner}', null, '${consultation}', 'rosuno-private-resources', 'resources/${id}/original', 'application/pdf', 100, '${digestValue()}', '${visibility}', 'active');`,
        );
        return id;
      };
      const insertDocument = (
        resource,
        { supersedes = null, type = null, id = null, label = null } = {},
      ) =>
        `insert into public.documents (${id === null ? "" : "id, "}resource_id, document_type, version_label, supersedes_document_id) values (${id === null ? "" : `'${id}', `}'${resource}', ${lit(type)}, ${lit(label)}, ${lit(supersedes)})`;
      const intake = sql(
        `select intake_id from public.consultation_requests where id = '${s.request}';`,
      );
      const voiceMemo = uid();
      sql(
        `insert into public.resources (id, resource_kind, owner_user_id, intake_id, consultation_id, storage_bucket, storage_object_path, mime_type, byte_size, content_digest, visibility_state, retention_state) values ('${voiceMemo}', 'voice_memo', '${s.client.user}', '${intake}', null, 'rosuno-private-resources', 'resources/${voiceMemo}/original', 'audio/webm', 100, '${digestValue()}', 'available', 'active');`,
      );
      const typedRoot = plantResource(s.consultation, s.client.user);
      sql(`${insertDocument(typedRoot, { type: "synthetic" })};`);
      const typedRootDocument = documentIdOf(typedRoot);
      const pendingPredecessor = plantResource(
        s.consultation,
        s.client.user,
        "pending",
      );
      sql(`${insertDocument(pendingPredecessor)};`);
      // Legacy rows (planted with triggers bypassed): an unlabelled Document
      // and one with a free-form label.
      const legacyNull = plantResource(s.consultation, s.client.user);
      const legacyFree = plantResource(s.consultation, s.client.user);
      sql(
        `begin;
         set local session_replication_role = replica;
         insert into public.documents (resource_id) values ('${legacyNull}');
         insert into public.documents (resource_id, version_label) values ('${legacyFree}', 'draft');
         commit;`,
      );
      const selfId = uid();
      const codes = {
        second_successor: refused(
          `${insertDocument(plantResource(s.consultation, s.client.user), { supersedes: v1 })};`,
        ),
        self_reference: refused(
          `${insertDocument(plantResource(s.consultation, s.client.user), { id: selfId, supersedes: selfId })};`,
        ),
        other_consultation: refused(
          `${insertDocument(plantResource(other.consultation, other.client.user), { supersedes: v2.document })};`,
        ),
        other_type: refused(
          `${insertDocument(plantResource(s.consultation, s.client.user), { supersedes: typedRootDocument })};`,
        ),
        voice_memo: refused(
          `${insertDocument(voiceMemo, { supersedes: v2.document })};`,
        ),
        pending_successor: refused(
          `${insertDocument(plantResource(s.consultation, s.client.user, "pending"), { supersedes: v2.document })};`,
        ),
        pending_predecessor: refused(
          `${insertDocument(plantResource(s.consultation, s.client.user), { supersedes: documentIdOf(pendingPredecessor) })};`,
        ),
        supplied_label: refused(
          `${insertDocument(plantResource(s.consultation, s.client.user), { label: "v1" })};`,
        ),
        supplied_successor_label: refused(
          `${insertDocument(plantResource(s.consultation, s.client.user), { supersedes: v2.document, label: "v3" })};`,
        ),
        legacy_free_label: refused(
          `${insertDocument(plantResource(s.consultation, s.client.user), { supersedes: documentIdOf(legacyFree) })};`,
        ),
        update_lineage: refused(
          `update public.documents set supersedes_document_id = null where id = '${v2.document}';`,
        ),
        update_set: refused(
          `update public.documents set supersedes_document_id = '${v1}' where id = '${typedRootDocument}';`,
        ),
        delete_superseded: refused(
          `delete from public.documents where id = '${v1}';`,
        ),
        delete_superseded_resource: refused(
          `delete from public.resources where id = '${v1Resource}';`,
        ),
      };
      const accepted = {
        same_type: acceptedThenRolledBack(
          `${insertDocument(plantResource(s.consultation, s.client.user), { type: "synthetic", supersedes: typedRootDocument })} returning version_label;`,
        ),
        legacy_unlabelled: acceptedThenRolledBack(
          `${insertDocument(plantResource(s.consultation, s.client.user), { supersedes: documentIdOf(legacyNull) })} returning version_label;`,
        ),
        plain_v1: acceptedThenRolledBack(
          `${insertDocument(plantResource(s.consultation, s.client.user))} returning version_label;`,
        ),
      };
      const roles = {};
      for (const role of ["authenticated", "service_role"]) {
        roles[role] = as(
          role,
          role === "service_role" ? null : s.client.auth,
          `${insertDocument(plantResource(s.consultation, s.client.user), { supersedes: v2.document })};`,
          role === "service_role" ? {} : clientOptions,
        );
      }
      assert.deepEqual(codes, {
        second_successor: "23505",
        self_reference: "23514",
        other_consultation: "23514",
        other_type: "23514",
        voice_memo: "23514",
        pending_successor: "23514",
        pending_predecessor: "23514",
        supplied_label: "23514",
        supplied_successor_label: "23514",
        legacy_free_label: "23514",
        update_lineage: "55000",
        update_set: "55000",
        delete_superseded: "23503",
        delete_superseded_resource: "23503",
      });
      assert.deepEqual(accepted, {
        same_type: "v2",
        legacy_unlabelled: "v2",
        plain_v1: "v1",
      });
      assert.deepEqual(roles, {
        authenticated: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      // The lineage is unchanged by every refusal.
      assert.equal(count("documents", `supersedes_document_id = '${v1}'`), 1);
      assert.equal(
        sql(
          "select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = 'public.documents'::regclass and not tgisinternal;",
        ),
        "documents_no_truncate,documents_record_guard,documents_version_guard",
      );
      return { codes, accepted, roles };
    },
  );

  await check(
    "DOC-11 (the replacement flow) only the uploader of the current, available version replaces it, inside the communication window, from server-measured metadata: the recipient, another client, another attorney, the attorney at aal1, an unknown id and a document named with another Consultation are not_found alike (nothing written); invalid metadata is invalid; an earlier version is not_current; a replacement completes only through the replacement completion (the plain completion answers not_found), only in its own Consultation, and only when bound to its start: the immutable start event of the same flow, recorded for the caller, naming this Document (one recorded for another actor never binds); an abandoned replacement ends rejected and never takes the successor slot (a later replacement still becomes v2); of two replacements of one version completed one after the other the second answers already_superseded and its upload ends rejected (audited); after completion with no window the replacement in progress is not_editable and a new one closed, the lineage unchanged",
    () => {
      const s = liveConsultation("W");
      const v1Resource = uploadDocument(s.lawyer, s.consultation);
      const v1 = documentIdOf(v1Resource);
      const otherResource = uploadDocument(s.lawyer, s.consultation);
      const otherDocument = documentIdOf(otherResource);
      const refusals = {
        recipient: beginReplacement(s.client, v1, clientOptions).outcome,
        other_client: beginReplacement(newClient(), v1, clientOptions).outcome,
        other_attorney: beginReplacement(lawyer("W"), v1).outcome,
        attorney_aal1: beginReplacement(s.lawyer, v1, { aal: "aal1" }).outcome,
        unknown: beginReplacement(s.lawyer, uid()).outcome,
        audio: beginReplacement(s.lawyer, v1, {}, { mime: "audio/webm" })
          .outcome,
        empty: beginReplacement(s.lawyer, v1, {}, { size: 0 }).outcome,
        too_large: beginReplacement(s.lawyer, v1, {}, { size: 1000001 })
          .outcome,
      };
      // The named Consultation must be the document's own (V3): another one
      // answers not_found and nothing is written.
      const elsewhere = liveConsultation("W");
      const resourcesBefore = count("resources");
      refusals.other_consultation = beginReplacement(
        s.lawyer,
        v1,
        {},
        { consultation: elsewhere.consultation },
      ).outcome;
      refusals.other_consultation_writes = count("resources") - resourcesBefore;
      const abandoned = beginReplacement(s.lawyer, v1);
      const flow = {
        abandoned_begin: abandoned.outcome,
        abandoned: abandonAs(s.lawyer, abandoned.resource),
        abandoned_completion: finalizeReplacementAs(
          s.lawyer,
          abandoned.resource,
          v1,
        ),
        abandoned_has_document: count(
          "documents",
          `resource_id = '${abandoned.resource}'`,
        ),
      };
      const replacement = beginReplacement(s.lawyer, v1);
      flow.plain_completion = finalizeAs(s.lawyer, replacement.resource);
      flow.other_consultation_completion = finalizeReplacementAs(
        s.lawyer,
        replacement.resource,
        v1,
        {},
        elsewhere.consultation,
      );
      flow.other_consultation_state = rowOf(
        "resources",
        `id = '${replacement.resource}'`,
      ).visibility_state;
      // The binding (V4): a start event naming the Document but recorded for
      // another actor never binds; the same event recorded for the caller does.
      const planted = uid();
      sql(
        `insert into public.resources (id, resource_kind, owner_user_id, intake_id, consultation_id, storage_bucket, storage_object_path, mime_type, byte_size, content_digest, visibility_state, retention_state) values ('${planted}', 'document', '${s.lawyer.user}', null, '${s.consultation}', 'rosuno-private-resources', 'resources/${planted}/original', 'application/pdf', 100, '${digestValue()}', 'pending', 'active');`,
      );
      const plantStart = (actor, actorType) =>
        sql(
          `insert into public.audit_events (actor_user_id, actor_type, action_code, resource_type, resource_id, before_snapshot, after_snapshot, reason_code, policy_references, jurisdiction_id, occurred_at) values ('${actor}', '${actorType}', 'resource_upload_started', 'resource', '${planted}', null, jsonb_build_object('resource_kind', 'document', 'visibility_state', 'pending', 'consultation_id', '${s.consultation}', 'replaces_document_id', '${otherDocument}'), null, null, null, clock_timestamp());`,
        );
      plantStart(s.client.user, "client");
      flow.foreign_actor_binding = finalizeReplacementAs(
        s.lawyer,
        planted,
        otherDocument,
      );
      flow.foreign_actor_state = rowOf(
        "resources",
        `id = '${planted}'`,
      ).visibility_state;
      flow.foreign_actor_successors = count(
        "documents",
        `supersedes_document_id = '${otherDocument}'`,
      );
      plantStart(s.lawyer.user, "attorney");
      flow.own_actor_binding = finalizeReplacementAs(
        s.lawyer,
        planted,
        otherDocument,
      );
      flow.wrong_document = finalizeReplacementAs(
        s.lawyer,
        replacement.resource,
        otherDocument,
      );
      flow.recipient_completion = finalizeReplacementAs(
        s.client,
        replacement.resource,
        v1,
        clientOptions,
      );
      flow.completion = finalizeReplacementAs(
        s.lawyer,
        replacement.resource,
        v1,
      );
      const v2 = documentIdOf(replacement.resource);
      flow.label = documentRow(v2).version_label;
      flow.earlier = beginReplacement(s.lawyer, v1).outcome;
      const first = beginReplacement(s.lawyer, v2);
      const second = beginReplacement(s.lawyer, v2);
      flow.first = finalizeReplacementAs(s.lawyer, first.resource, v2);
      flow.second = finalizeReplacementAs(s.lawyer, second.resource, v2);
      flow.second_state = rowOf(
        "resources",
        `id = '${second.resource}'`,
      ).visibility_state;
      flow.second_audit = auditsFor("resource", second.resource).map((a) => [
        a.action,
        a.after.visibility_state,
      ]);
      flow.successors = count("documents", `supersedes_document_id = '${v2}'`);
      flow.second_abandon = abandonAs(s.lawyer, second.resource);
      // A consultation without a configured window: replacement after the end.
      const z = liveConsultation("N");
      const zResource = uploadDocument(z.client, z.consultation, clientOptions);
      const zDocument = documentIdOf(zResource);
      const inProgress = beginReplacement(z.client, zDocument, clientOptions);
      assert.equal(end(z).outcome, "completed");
      flow.after_end_completion = finalizeReplacementAs(
        z.client,
        inProgress.resource,
        zDocument,
        clientOptions,
      );
      flow.after_end_abandon = abandonAs(
        z.client,
        inProgress.resource,
        clientOptions,
      );
      flow.after_end_begin = beginReplacement(
        z.client,
        zDocument,
        clientOptions,
      ).outcome;
      flow.after_end_lineage = count(
        "documents",
        `supersedes_document_id = '${zDocument}'`,
      );
      assert.deepEqual(refusals, {
        recipient: "not_found",
        other_client: "not_found",
        other_attorney: "not_found",
        attorney_aal1: "not_found",
        unknown: "not_found",
        audio: "invalid",
        empty: "invalid",
        too_large: "invalid",
        other_consultation: "not_found",
        other_consultation_writes: 0,
      });
      assert.deepEqual(flow, {
        abandoned_begin: "created",
        abandoned: "rejected",
        abandoned_completion: "not_pending",
        abandoned_has_document: 0,
        plain_completion: "not_found",
        other_consultation_completion: "not_found",
        other_consultation_state: "pending",
        foreign_actor_binding: "not_found",
        foreign_actor_state: "pending",
        foreign_actor_successors: 0,
        own_actor_binding: "available",
        wrong_document: "not_found",
        recipient_completion: "not_found",
        completion: "available",
        label: "v2",
        earlier: "not_current",
        first: "available",
        second: "already_superseded",
        second_state: "rejected",
        second_audit: [
          ["resource_upload_started", "pending"],
          ["resource_upload_abandoned", "rejected"],
        ],
        successors: 1,
        second_abandon: "not_pending",
        after_end_completion: "not_editable",
        after_end_abandon: "rejected",
        after_end_begin: "window_unavailable",
        after_end_lineage: 0,
      });
      return { refusals, flow };
    },
  );

  await check(
    "DOC-12 (PS-A5 sharing rule; PS sections 26.2 and 29) grants stay recipient-specific per version: revoking v1's grant refuses the recipient v1 only (v2 and v3 still authorized), revoking v2's leaves v1's revocation and v3's grant as they were; the current version's row says whether an earlier version is still shared (after v1's revocation yes, v2 still is; after v2's no), for the uploader and the recipient; another attorney (licensed in the same jurisdiction), another client and the attorney at aal1 are refused for every version; a Legal Hold on the Consultation stops access to every version the caller may open (held) and every deletion of any version's Document or resource, for every role; once released, access returns as before",
    () => {
      const s = liveConsultation("W");
      const v1Resource = uploadDocument(
        s.client,
        s.consultation,
        clientOptions,
      );
      const v1 = documentIdOf(v1Resource);
      const v2 = replaceDocument(s.client, v1, clientOptions);
      const v3 = replaceDocument(s.client, v2.document, clientOptions);
      const resources = [v1Resource, v2.resource, v3.resource];
      const lawyerAccess = () =>
        resources.map((resource) => authorizeAs(s.lawyer, resource));
      const answers = {
        revoke_v1: revokeAs(s.client, v1Resource, clientOptions),
      };
      answers.after_v1 = lawyerAccess();
      // The current version's row says whether an earlier one is still shared.
      const earlierShared = () => [
        documentsAs(s.client, s.consultation, clientOptions)[0]
          .earlier_versions_shared,
        documentsAs(s.lawyer, s.consultation)[0].earlier_versions_shared,
      ];
      answers.earlier_after_v1 = earlierShared();
      const v1Revoked = rowOf(
        "resource_sharing_grants",
        `resource_id = '${v1Resource}'`,
      ).revoked_at;
      answers.revoke_v2 = revokeAs(s.client, v2.resource, clientOptions);
      answers.after_v2 = lawyerAccess();
      answers.earlier_after_v2 = earlierShared();
      answers.v1_revocation_unchanged =
        rowOf("resource_sharing_grants", `resource_id = '${v1Resource}'`)
          .revoked_at === v1Revoked;
      answers.v3_grant_active =
        rowOf("resource_sharing_grants", `resource_id = '${v3.resource}'`)
          .revoked_at === null;
      const outsider = lawyer("W");
      const stranger = newClient();
      answers.other_attorney = resources.map((resource) =>
        authorizeAs(outsider, resource),
      );
      answers.other_client = resources.map((resource) =>
        authorizeAs(stranger, resource, clientOptions),
      );
      answers.attorney_aal1 = resources.map((resource) =>
        authorizeAs(s.lawyer, resource, { aal: "aal1" }),
      );
      const holdId = uid();
      sql(
        `insert into public.legal_holds (id, scope_type, scope_id, status, reason, started_at, created_by_user_id) values ('${holdId}', 'synthetic', '${s.consultation}', 'active', 'synthetic hold', now() - interval '1 minute', '${world.policyAdmin.user}');`,
      );
      answers.held_uploader = resources.map((resource) =>
        authorizeAs(s.client, resource, clientOptions),
      );
      answers.held_recipient = lawyerAccess();
      answers.held_deletions = [
        refused(`delete from public.documents where id = '${v3.document}';`),
        refused(`delete from public.resources where id = '${v3.resource}';`),
        refused(`delete from public.documents where id = '${v1}';`),
        refused(`delete from public.resources where id = '${v1Resource}';`),
      ];
      sql(
        `update public.legal_holds set released_at = now(), released_by_user_id = '${world.policyAdmin.user}' where id = '${holdId}';`,
      );
      answers.released_recipient = lawyerAccess();
      const authorized = (resource) => `authorized|${objectPath(resource)}`;
      assert.deepEqual(answers, {
        revoke_v1: "revoked",
        after_v1: [
          "refused|",
          authorized(v2.resource),
          authorized(v3.resource),
        ],
        earlier_after_v1: [true, true],
        revoke_v2: "revoked",
        after_v2: ["refused|", "refused|", authorized(v3.resource)],
        earlier_after_v2: [false, false],
        v1_revocation_unchanged: true,
        v3_grant_active: true,
        other_attorney: ["refused|", "refused|", "refused|"],
        other_client: ["refused|", "refused|", "refused|"],
        attorney_aal1: ["refused|", "refused|", "refused|"],
        held_uploader: ["held|", "held|", "held|"],
        held_recipient: ["refused|", "refused|", "held|"],
        held_deletions: ["55000", "55000", "55000", "55000"],
        released_recipient: ["refused|", "refused|", authorized(v3.resource)],
      });
      return answers;
    },
  );

  await check(
    "DOC-13 (PS-A5 history) document_versions answers one document's lineage in version order for its participants: the uploader the whole lineage (v1, v2, v3; the current flag on v3 only; each version's grant state; every version openable), the recipient the versions they hold or held a grant for (a revoked one marked revoked and not openable); any version's id answers the same lineage; unknown ids, a Document of another Consultation, another client, another attorney and the attorney at aal1 answer alike: no row",
    () => {
      const s = liveConsultation("W");
      const elsewhere = liveConsultation("W");
      const foreign = documentIdOf(
        uploadDocument(elsewhere.client, elsewhere.consultation, clientOptions),
      );
      const v1Resource = uploadDocument(
        s.client,
        s.consultation,
        clientOptions,
      );
      const v1 = documentIdOf(v1Resource);
      const v2 = replaceDocument(s.client, v1, clientOptions);
      const v3 = replaceDocument(s.client, v2.document, clientOptions);
      assert.equal(revokeAs(s.client, v1Resource, clientOptions), "revoked");
      const shape = (rows) =>
        rows.map((v) => [
          v.version_label,
          v.is_current,
          v.mine,
          v.uploaded_by,
          v.sharing,
          v.accessible,
          v.older_versions_not_shown,
        ]);
      const uploader = versionsAs(
        s.client,
        s.consultation,
        v2.document,
        clientOptions,
      );
      const answers = {
        columns: Object.keys(uploader[0]),
        uploader: shape(uploader),
        ids: uploader.map((v) => [v.document_id, v.resource_id]),
        uploader_from_v1: shape(
          versionsAs(s.client, s.consultation, v1, clientOptions),
        ),
        recipient: shape(versionsAs(s.lawyer, s.consultation, v3.document)),
        unknown: versionsAs(s.client, s.consultation, uid(), clientOptions)
          .length,
        foreign: versionsAs(s.client, s.consultation, foreign, clientOptions)
          .length,
        foreign_own: versionsAs(
          elsewhere.client,
          s.consultation,
          foreign,
          clientOptions,
        ).length,
        other_client: versionsAs(newClient(), s.consultation, v1, clientOptions)
          .length,
        other_attorney: versionsAs(lawyer("W"), s.consultation, v1).length,
        attorney_aal1: versionsAs(s.lawyer, s.consultation, v1, {
          aal: "aal1",
        }).length,
      };
      assert.deepEqual(answers, {
        columns: [
          "document_id",
          "resource_id",
          "version_label",
          "mime_type",
          "byte_size",
          "created_at",
          "uploaded_by",
          "mine",
          "is_current",
          "sharing",
          "accessible",
          "older_versions_not_shown",
        ],
        uploader: [
          ["v1", false, true, "client", "revoked", true, false],
          ["v2", false, true, "client", "active", true, false],
          ["v3", true, true, "client", "active", true, false],
        ],
        ids: [
          [v1, v1Resource],
          [v2.document, v2.resource],
          [v3.document, v3.resource],
        ],
        uploader_from_v1: [
          ["v1", false, true, "client", "revoked", true, false],
          ["v2", false, true, "client", "active", true, false],
          ["v3", true, true, "client", "active", true, false],
        ],
        recipient: [
          ["v1", false, false, "client", "revoked", false, false],
          ["v2", false, false, "client", "active", true, false],
          ["v3", true, false, "client", "active", true, false],
        ],
        unknown: 0,
        foreign: 0,
        foreign_own: 0,
        other_client: 0,
        other_attorney: 0,
        attorney_aal1: 0,
      });
      return answers;
    },
  );

  await check(
    "DOC-7 documents follow the communication window: after the window closes (or when it is unavailable) no upload starts or completes, while listing and access stay available (read-only); a pending upload whose window closed is refused not_editable at completion",
    () => {
      const s = completedConsultation("W");
      const before = uploadDocument(s.client, s.consultation, clientOptions);
      const pending = beginDocument(s.lawyer, s.consultation);
      assert.equal(pending.outcome, "created");
      shiftEnded(s.consultation, 7200);
      const none = completedConsultation("N");
      const answers = {
        begin_closed: beginDocument(s.client, s.consultation, clientOptions)
          .outcome,
        finalize_closed: finalizeAs(s.lawyer, pending.resource),
        begin_unavailable: beginDocument(
          none.client,
          none.consultation,
          clientOptions,
        ).outcome,
        list_after_close: documentsAs(s.lawyer, s.consultation).length,
        access_after_close: authorizeAs(s.lawyer, before),
        revoke_after_close: revokeAs(s.client, before, clientOptions),
      };
      assert.deepEqual(answers, {
        begin_closed: "closed",
        finalize_closed: "not_editable",
        begin_unavailable: "window_unavailable",
        list_after_close: 1,
        access_after_close: `authorized|${objectPath(before)}`,
        revoke_after_close: "revoked",
      });
      return answers;
    },
  );

  await check(
    "DOC-8 (S3 rule unchanged; counsel gate) no grant discloses an Intake voice memo to an attorney: the Consultation's own attorney holding a grant to the client's voice memo is refused, while the client is authorized",
    () => {
      const s = liveConsultation("W");
      const memo = uid();
      sql(
        `begin;
         insert into public.resources (id, resource_kind, owner_user_id, intake_id, consultation_id, storage_bucket, storage_object_path, mime_type, byte_size, content_digest, visibility_state, retention_state) values ('${memo}', 'voice_memo', '${s.client.user}', '${s.client.intake}', null, 'rosuno-private-resources', 'resources/${memo}/original', 'audio/webm', 1000, '${digestValue()}', 'available', 'active');
         insert into public.voice_memos (resource_id, intake_id, duration_seconds) values ('${memo}', '${s.client.intake}', 10);
         insert into public.resource_sharing_grants (resource_id, recipient_user_id, context_type, context_id, purpose_code, granted_at, granted_by_user_id) values ('${memo}', '${s.lawyer.user}', 'synthetic_context', '${s.consultation}', 'synthetic_purpose', now() - interval '1 minute', '${s.client.user}');
         commit;`,
      );
      const answers = {
        attorney_with_grant: authorizeAs(s.lawyer, memo, {}, "voice_memo"),
        client: authorizeAs(s.client, memo, clientOptions, "voice_memo"),
      };
      assert.deepEqual(answers, {
        attorney_with_grant: "refused|",
        client: `authorized|${objectPath(memo)}`,
      });
      return answers;
    },
  );

  await check(
    "DOC-9 (no upload count limit; the list is never silently truncated) one participant shares 201 documents in one Consultation through the real pipeline (begin and completion; no count limit refuses any); consultation_documents answers the newest 200 a reader may see, oldest first, and every row says whether older documents exist that are not shown: with exactly 200 every row says false; after one more, 200 rows, every row says true and the newest is the last row; uploader and recipient read alike",
    () => {
      const s = liveConsultation("W");
      const shareMany = (first, last) => {
        const result = psql(
          [
            "begin;",
            ...sessionLines("authenticated", s.client.auth, clientOptions),
            `do $proof$
             declare
               v_begun record;
               v_finalized text;
             begin
               for i in ${first}..${last} loop
                 select b.* into v_begun
                 from public.document_begin_upload(
                   '${s.consultation}', 'application/pdf', 100 + i,
                   'sha256:' || encode(sha256(convert_to('synthetic-document-' || i, 'UTF8')), 'hex')
                 ) as b;
                 if v_begun.outcome is distinct from 'created' then
                   raise exception 'begin %', v_begun.outcome;
                 end if;
                 v_finalized := public.resource_finalize_upload(v_begun.resource_id);
                 if v_finalized is distinct from 'available' then
                   raise exception 'completion %', v_finalized;
                 end if;
               end loop;
             end
             $proof$;`,
            "commit;",
            "",
          ].join("\n"),
        );
        assert.equal(result.status, 0, result.stderr);
      };
      const flags = (rows) => [...new Set(rows.map((d) => d.older_not_shown))];
      shareMany(1, 200);
      const at200 = documentsAs(s.client, s.consultation, clientOptions);
      const at200Attorney = documentsAs(s.lawyer, s.consultation);
      // The exact columns the application's strict reader expects.
      assert.deepEqual(Object.keys(at200[0]), [
        "resource_id",
        "document_id",
        "lineage_id",
        "version_label",
        "mime_type",
        "byte_size",
        "created_at",
        "uploaded_by",
        "mine",
        "sharing",
        "accessible",
        "earlier_versions_shared",
        "older_not_shown",
      ]);
      shareMany(201, 201);
      const newest = sql(
        `select id from public.resources where consultation_id = '${s.consultation}' and resource_kind = 'document' order by created_at desc, id desc limit 1;`,
      );
      const at201 = documentsAs(s.client, s.consultation, clientOptions);
      const at201Attorney = documentsAs(s.lawyer, s.consultation);
      const answers = {
        available: count(
          "resources",
          `consultation_id = '${s.consultation}' and resource_kind = 'document' and visibility_state = 'available'`,
        ),
        at_200: [at200.length, flags(at200)],
        at_200_attorney: [at200Attorney.length, flags(at200Attorney)],
        at_201: [at201.length, flags(at201)],
        at_201_attorney: [at201Attorney.length, flags(at201Attorney)],
        newest_last: at201[at201.length - 1].resource_id === newest,
        oldest_first: at201.every(
          (d, i) => i === 0 || ms(at201[i - 1].created_at) <= ms(d.created_at),
        ),
      };
      assert.deepEqual(answers, {
        available: 201,
        at_200: [200, [false]],
        at_200_attorney: [200, [false]],
        at_201: [200, [true]],
        at_201_attorney: [200, [true]],
        newest_last: true,
        oldest_first: true,
      });
      return answers;
    },
  );

  await check(
    "DOC-14 (long histories are never silently truncated; no depth bound) a lineage deeper than any former bound (10 050 versions; built by the owner role through the guard, each version superseding the previous one, labels v2 to v10050 assigned by the guard) keeps its current version in both participants' lists (its lineage id the first version; an earlier version still shared; nothing older_not_shown); its history answers the newest 500 versions in version order (v9551 to v10050) with the flag on every row, asked by the current or the first version; the recipient, holding grants on the first and the current version only, sees exactly those two without the flag; at the bound a 500-version lineage answers all 500 without the flag, and one more version through the real replacement flow answers v2 to v501 with the flag",
    () => {
      // Owner-role chain fixture: each new version supersedes the previous one
      // through the guard (available resources of the client's own in the
      // Consultation). Synthetic test data.
      const extend = (s, document, versions) => {
        sql(
          `do $proof$
           declare
             v_previous uuid := '${document}';
             v_resource uuid;
           begin
             for i in 1..${versions} loop
               v_resource := gen_random_uuid();
               insert into public.resources (id, resource_kind, owner_user_id, intake_id, consultation_id, storage_bucket, storage_object_path, mime_type, byte_size, content_digest, visibility_state, retention_state)
               values (v_resource, 'document', '${s.client.user}', null, '${s.consultation}', 'rosuno-private-resources', 'resources/' || v_resource::text || '/original', 'application/pdf', 100, 'sha256:' || encode(sha256(convert_to(v_resource::text, 'UTF8')), 'hex'), 'available', 'active');
               insert into public.documents (resource_id, supersedes_document_id) values (v_resource, v_previous) returning id into v_previous;
             end loop;
           end
           $proof$;`,
        );
        return sql(
          `select d.id from public.documents d join public.resources r on r.id = d.resource_id where r.consultation_id = '${s.consultation}' and not exists (select 1 from public.documents x where x.supersedes_document_id = d.id);`,
        );
      };
      const labelsOf = (rows) => rows.map((v) => v.version_label);
      const flagsOf = (rows) => [
        ...new Set(rows.map((v) => v.older_versions_not_shown)),
      ];
      const expectedLabels = (from, to) =>
        Array.from({ length: to - from + 1 }, (_, i) => `v${from + i}`);
      // The deep lineage.
      const s = liveConsultation("W");
      const rootResource = uploadDocument(
        s.client,
        s.consultation,
        clientOptions,
      );
      const root = documentIdOf(rootResource);
      const current = extend(s, root, 10049);
      const currentResource = sql(
        `select resource_id from public.documents where id = '${current}';`,
      );
      sql(
        `insert into public.resource_sharing_grants (resource_id, recipient_user_id, context_type, context_id, purpose_code, granted_at, expires_at, revoked_at, granted_by_user_id) values ('${currentResource}', '${s.lawyer.user}', 'consultation', '${s.consultation}', 'consultation_document_exchange', now(), null, null, '${s.client.user}');`,
      );
      const listRow = (rows) =>
        rows.map((d) => [
          d.document_id === current,
          d.lineage_id === root,
          d.version_label,
          d.earlier_versions_shared,
          d.older_not_shown,
        ]);
      const fromCurrent = versionsAs(
        s.client,
        s.consultation,
        current,
        clientOptions,
      );
      const fromRoot = versionsAs(
        s.client,
        s.consultation,
        root,
        clientOptions,
      );
      const recipient = versionsAs(s.lawyer, s.consultation, current);
      const answers = {
        current_label: documentRow(current).version_label,
        client_list: listRow(
          documentsAs(s.client, s.consultation, clientOptions),
        ),
        lawyer_list: listRow(documentsAs(s.lawyer, s.consultation)),
        from_current: [
          fromCurrent.length,
          labelsOf(fromCurrent).join(",") ===
            expectedLabels(9551, 10050).join(","),
          flagsOf(fromCurrent),
          fromCurrent.filter((v) => v.is_current).map((v) => v.version_label),
        ],
        from_root: [
          fromRoot.length,
          labelsOf(fromRoot).join(",") === labelsOf(fromCurrent).join(","),
          flagsOf(fromRoot),
        ],
        recipient: recipient.map((v) => [
          v.version_label,
          v.is_current,
          v.older_versions_not_shown,
        ]),
        recipient_from_root: versionsAs(s.lawyer, s.consultation, root).length,
      };
      // At the bound.
      const t = liveConsultation("W");
      const tRoot = documentIdOf(
        uploadDocument(t.client, t.consultation, clientOptions),
      );
      const tCurrent = extend(t, tRoot, 499);
      const at500 = versionsAs(
        t.client,
        t.consultation,
        tCurrent,
        clientOptions,
      );
      const next = replaceDocument(t.client, tCurrent, clientOptions);
      const at501 = versionsAs(
        t.client,
        t.consultation,
        next.document,
        clientOptions,
      );
      answers.at_500 = [
        at500.length,
        labelsOf(at500).join(",") === expectedLabels(1, 500).join(","),
        flagsOf(at500),
      ];
      answers.at_501 = [
        at501.length,
        labelsOf(at501).join(",") === expectedLabels(2, 501).join(","),
        flagsOf(at501),
        at501[at501.length - 1].is_current,
      ];
      assert.deepEqual(answers, {
        current_label: "v10050",
        client_list: [[true, true, "v10050", true, false]],
        lawyer_list: [[true, true, "v10050", true, false]],
        from_current: [500, true, [true], ["v10050"]],
        from_root: [500, true, [true]],
        recipient: [
          ["v1", false, false],
          ["v10050", true, false],
        ],
        recipient_from_root: 2,
        at_500: [500, true, [false]],
        at_501: [500, true, [true], true],
      });
      return answers;
    },
  );
}

// ---------------------------------------------------------------------------
// 12C: Notifications, delivery and observations
// ---------------------------------------------------------------------------

async function notificationChecks() {
  await check(
    "NOT-1 (TA section 27; ROS section 15; MB section 98) canonical business events create Notifications in their own transactions, whichever path: a Request entering awaiting_attorney (the attorney), its acceptance (the client) with the instant Consultation's readiness (both), a decline and an expiry (the client); each event creates exactly one in-app (delivered) and one email (pending, one notification.deliver job with 8 attempts, the fixed technical bound) Notification per recipient, flags from configuration (none here), and emitting the same event again creates nothing",
    () => {
      const who = lawyer("W");
      const accepted = authorizedRequest({
        jurisdiction: world.J.W,
        requestPath: "instant",
        lawyer: who,
      });
      const awaiting = notificationsOf(
        who.user,
        `source_event_id = '${accepted.request}'`,
      );
      assert.deepEqual(
        awaiting.map((n) => [
          n.type,
          n.source_event_type,
          n.channel,
          n.state,
          n.critical,
          n.ack_required,
        ]),
        [
          [
            "request_awaiting_decision",
            "consultation_request.awaiting_attorney",
            "in_app",
            "delivered",
            false,
            false,
          ],
          [
            "request_awaiting_decision",
            "consultation_request.awaiting_attorney",
            "email",
            "pending",
            false,
            false,
          ],
        ],
      );
      const job = jobRow(deliveryJob(awaiting[1].id));
      assert.deepEqual(
        [job.job_type, job.subject_type, job.state, job.max_attempts],
        ["notification.deliver", "notification", "pending", 8],
      );
      const decision = accept(who, accepted.request);
      assert.equal(decision.outcome, "accepted");
      assert.deepEqual(
        notificationsOf(accepted.client.user).map((n) => [n.type, n.channel]),
        [
          ["request_accepted", "in_app"],
          ["request_accepted", "email"],
          ["consultation_ready", "in_app"],
          ["consultation_ready", "email"],
        ],
      );
      assert.deepEqual(
        notificationsOf(
          who.user,
          `notification_type = 'consultation_ready'`,
        ).map((n) => [n.source_event_id, n.channel]),
        [
          [decision.consultation, "in_app"],
          [decision.consultation, "email"],
        ],
      );
      const declined = authorizedRequest({
        jurisdiction: world.J.W,
        requestPath: "instant",
        lawyer: who,
      });
      assert.equal(decline(who, declined.request), "declined");
      assert.deepEqual(
        notificationsOf(
          declined.client.user,
          `notification_type = 'request_declined'`,
        ).map((n) => n.channel),
        ["in_app", "email"],
      );
      const expiring = authorizedRequest({
        jurisdiction: world.J.W,
        requestPath: "instant",
        lawyer: lawyer("W"),
      });
      sql(
        `begin;
         set local session_replication_role = replica;
         update public.consultation_requests set created_at = now() - interval '2 hours', response_deadline_at = now() - interval '1 second' where id = '${expiring.request}';
         commit;`,
      );
      assert.equal(
        sql(
          `select public.request_expire_if_due('${expiring.request}', false);`,
        ),
        "expired",
      );
      assert.deepEqual(
        notificationsOf(
          expiring.client.user,
          `notification_type = 'request_expired'`,
        ).map((n) => n.channel),
        ["in_app", "email"],
      );
      const before = s10Counts();
      sql(
        `select public.notification_emit('${expiring.client.user}', 'request_expired', 'consultation_request.expired', '${expiring.request}');`,
      );
      assert.deepEqual(deltaOf(before, s10Counts()), {});
      return {
        events: [
          "awaiting_attorney",
          "accepted",
          "ready",
          "declined",
          "expired",
        ],
      };
    },
  );

  await check(
    "NOT-2 (MBS section 15 12C; ROS section 15) delivery through the job protocol: the worker's context answers act with the type, the recipient's notification center path and the address read at send time (never stored); an accepted call records one attempt (provider code and reference only) and sends the Notification once (audited); a repeated acceptance (a retried call) adds evidence and changes nothing; once sent the context answers nothing_to_do; the business records are untouched",
    () => {
      const who = withAddress(lawyer("W"));
      const s = authorizedRequest({
        jurisdiction: world.J.W,
        requestPath: "instant",
        lawyer: who,
      });
      const email = emailNotification(
        who.user,
        "request_awaiting_decision",
        s.request,
      );
      const job = deliveryJob(email.id);
      claimJob(job);
      const context = notificationContext(job);
      assert.deepEqual(
        [
          context.outcome,
          context.notification_id,
          context.notification_type,
          context.center_path,
          context.recipient_address === addressOf(who),
        ],
        [
          "act",
          email.id,
          "request_awaiting_decision",
          "/attorney/notifications",
          true,
        ],
      );
      const requestBefore = requestOf(s.request);
      const reference = providerReference();
      const outcomes = {
        accepted: recordAttempt(job, "accepted", reference),
        repeated: recordAttempt(job, "accepted", reference),
        complete: completeJob(job),
      };
      assert.deepEqual(outcomes, {
        accepted: "sent",
        repeated: "no_effect",
        complete: "completed",
      });
      const sent = rowOf("notifications", `id = '${email.id}'`);
      assert.equal(sent.state, "sent");
      assert.ok(sent.sent_at);
      assert.deepEqual(attemptsOf(email.id), [
        {
          provider_code: "synthetic_mail",
          reference: true,
          result: "accepted",
          failure_code: null,
        },
        {
          provider_code: "synthetic_mail",
          reference: true,
          result: "accepted",
          failure_code: null,
        },
      ]);
      assert.deepEqual(notificationAudits(email.id), [
        {
          action: "notification.sent",
          actor_type: "system",
          reason: "provider_accepted",
          after: {
            state: "sent",
            channel: "email",
            notification_type: "request_awaiting_decision",
            provider_code: "synthetic_mail",
            attempt: 1,
          },
        },
      ]);
      // A new job for a sent Notification has nothing to do.
      sql(
        `select public.job_enqueue('notification.deliver', 'notification', '${email.id}', now(), 8);`,
      );
      const again = deliveryJob(email.id);
      claimJob(again);
      assert.equal(notificationContext(again).outcome, "nothing_to_do");
      assert.equal(completeJob(again), "completed");
      assert.deepEqual(requestOf(s.request), requestBefore);
      const stored = JSON.stringify(
        jsonOf(
          `select json_agg(n)::text from public.notifications n where id = '${email.id}';`,
        ),
      );
      assert.equal(stored.includes("@synthetic.invalid"), false);
      return outcomes;
    },
  );

  await check(
    "NOT-3 (MBS section 15 12C: retries are bounded and durable) an unconfigured provider: each attempt records not_sent (provider_unconfigured: Rosuno stopped before any provider call) and the job is reported failed, the S2 protocol schedules the retry (pending again, backed off 30, 60, 120, 240, 480, 960 and 1920 seconds: the eighth attempt comes no earlier than 3810 seconds after the first, so an outage of about an hour is survived) and the Notification is retrying; on the eighth and last attempt (the fixed technical bound of every delivery job) it becomes permanently_failed (observable, failed_at, audited) and the job completes; a permanent refusal ends it at once; neither touches the business event; a recipient without an active account or address is no_recipient and is recorded not_sent recipient_unavailable, final; not_sent admits only its fixed codes",
    () => {
      const who = withAddress(lawyer("W"));
      const s = authorizedRequest({
        jurisdiction: world.J.W,
        requestPath: "instant",
        lawyer: who,
      });
      const email = emailNotification(
        who.user,
        "request_awaiting_decision",
        s.request,
      );
      const job = deliveryJob(email.id);
      assert.equal(jobRow(job).max_attempts, 8);
      const requestBefore = requestOf(s.request);
      const steps = [];
      const delays = [];
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        claimJob(job);
        assert.equal(notificationContext(job).outcome, "act");
        const recorded = recordAttempt(
          job,
          "not_sent",
          null,
          "provider_unconfigured",
        );
        const state = rowOf("notifications", `id = '${email.id}'`).state;
        let report = null;
        if (recorded === "retrying") {
          report = failJob(job);
          delays.push(
            Number(
              sql(
                `select round(extract(epoch from available_at - clock_timestamp()) / 10) * 10 from public.operational_jobs where id = '${job}';`,
              ),
            ),
          );
          const row = jobRow(job);
          assert.equal(row.state, "pending");
          assert.ok(ms(row.available_at) > Date.now(), "backed off");
          dueNow(job);
        } else {
          report = completeJob(job);
        }
        steps.push([attempt, recorded, state, report]);
      }
      assert.deepEqual(steps, [
        [1, "retrying", "retrying", "retry_scheduled"],
        [2, "retrying", "retrying", "retry_scheduled"],
        [3, "retrying", "retrying", "retry_scheduled"],
        [4, "retrying", "retrying", "retry_scheduled"],
        [5, "retrying", "retrying", "retry_scheduled"],
        [6, "retrying", "retrying", "retry_scheduled"],
        [7, "retrying", "retrying", "retry_scheduled"],
        [8, "permanently_failed", "permanently_failed", "completed"],
      ]);
      // The S2 backoff before attempts 2 to 8 (rounded to ten seconds): at
      // least about an hour in all before the last attempt.
      assert.deepEqual(delays, [30, 60, 120, 240, 480, 960, 1920]);
      assert.ok(delays.reduce((a, b) => a + b, 0) >= 3600);
      const failed = rowOf("notifications", `id = '${email.id}'`);
      assert.ok(failed.failed_at);
      assert.equal(failed.sent_at, null);
      assert.equal(attemptsOf(email.id).length, 8);
      assert.deepEqual(
        [
          ...new Set(
            attemptsOf(email.id).map(
              (a) => `${a.result}:${a.failure_code}:${a.reference}`,
            ),
          ),
        ],
        ["not_sent:provider_unconfigured:false"],
      );
      assert.deepEqual(
        notificationAudits(email.id).map((a) => [
          a.action,
          a.reason,
          a.after.state,
        ]),
        [
          ["notification.retrying", "delivery_failed_transient", "retrying"],
          [
            "notification.permanently_failed",
            "attempts_exhausted",
            "permanently_failed",
          ],
        ],
      );
      assert.deepEqual(exceptionsFor(email.id), []);
      assert.deepEqual(requestOf(s.request), requestBefore);
      // A permanent refusal at the first attempt.
      const refusedRequest = authorizedRequest({
        jurisdiction: world.J.W,
        requestPath: "instant",
        lawyer: withAddress(lawyer("W")),
      });
      const refusedEmail = emailNotification(
        refusedRequest.lawyer.user,
        "request_awaiting_decision",
        refusedRequest.request,
      );
      const refusedJob = deliveryJob(refusedEmail.id);
      claimJob(refusedJob);
      assert.equal(
        recordAttempt(refusedJob, "failed_permanent", null, "invalid_request"),
        "permanently_failed",
      );
      assert.equal(completeJob(refusedJob), "completed");
      // No active account, or no address: no_recipient.
      const suspended = withAddress(lawyer("W"));
      const noAccount = authorizedRequest({
        jurisdiction: world.J.W,
        requestPath: "instant",
        lawyer: suspended,
      });
      sql(
        `update public.users set account_state = 'suspended' where id = '${suspended.user}';`,
      );
      const noAccountJob = deliveryJob(
        emailNotification(
          suspended.user,
          "request_awaiting_decision",
          noAccount.request,
        ).id,
      );
      claimJob(noAccountJob);
      const noAddressWho = lawyer("W");
      const noAddress = authorizedRequest({
        jurisdiction: world.J.W,
        requestPath: "instant",
        lawyer: noAddressWho,
      });
      const noAddressEmail = emailNotification(
        noAddressWho.user,
        "request_awaiting_decision",
        noAddress.request,
      );
      const noAddressJob = deliveryJob(noAddressEmail.id);
      claimJob(noAddressJob);
      // not_sent admits only its fixed codes (and never a reference).
      const notSentRefusals = [
        recordAttempt(noAddressJob, "not_sent", null, "network"),
        recordAttempt(noAddressJob, "not_sent", null, "provider_error"),
        recordAttempt(
          noAddressJob,
          "not_sent",
          "ref_x",
          "recipient_unavailable",
        ),
        recordAttempt(noAddressJob, "not_sent", null, null),
      ];
      assert.deepEqual(notSentRefusals, Array(4).fill("invalid"));
      assert.equal(attemptsOf(noAddressEmail.id).length, 0);
      const recipients = {
        suspended: notificationContext(noAccountJob).outcome,
        no_address: notificationContext(noAddressJob).outcome,
        not_sent: recordAttempt(
          noAddressJob,
          "not_sent",
          null,
          "recipient_unavailable",
        ),
      };
      assert.equal(completeJob(noAddressJob), "completed");
      assert.equal(completeJob(noAccountJob), "completed");
      assert.deepEqual(recipients, {
        suspended: "no_recipient",
        no_address: "no_recipient",
        not_sent: "permanently_failed",
      });
      assert.deepEqual(attemptsOf(noAddressEmail.id), [
        {
          provider_code: "synthetic_mail",
          reference: false,
          result: "not_sent",
          failure_code: "recipient_unavailable",
        },
      ]);
      assert.deepEqual(
        notificationAudits(noAddressEmail.id).map((a) => [
          a.action,
          a.reason,
          a.after.failure_code,
        ]),
        [
          [
            "notification.permanently_failed",
            "delivery_not_sendable",
            "recipient_unavailable",
          ],
        ],
      );
      return { steps, delays, recipients };
    },
  );

  await check(
    "NOT-4 (MB section 99: critical notifications are escalated; acknowledgement) with a development notification version naming request_accepted critical and consultation_ready acknowledgement-required: new Notifications carry the flags (fixed at creation); a critical Notification that fails permanently opens one high notification_delivery_failed Reconciliation Exception (minimized evidence), a non-critical one none; the recipient acknowledges an acknowledgement-required in-app Notification once (audited), a second time already_acknowledged, one that needs none not_required, another user's or an unknown id not_found, the attorney at aal1 not_found",
    () => {
      const version = notificationPolicy({
        critical_notification_types: ["request_accepted"],
        acknowledgement_required_types: ["consultation_ready"],
      });
      try {
        const who = lawyer("W");
        const s = authorizedRequest({
          jurisdiction: world.J.W,
          requestPath: "instant",
          lawyer: who,
        });
        withAddress(s.client);
        const decision = accept(who, s.request);
        assert.equal(decision.outcome, "accepted");
        const flags = notificationsOf(s.client.user).map((n) => [
          n.type,
          n.channel,
          n.critical,
          n.ack_required,
        ]);
        assert.deepEqual(flags, [
          ["request_accepted", "in_app", true, false],
          ["request_accepted", "email", true, false],
          ["consultation_ready", "in_app", false, true],
          ["consultation_ready", "email", false, false],
        ]);
        const critical = emailNotification(
          s.client.user,
          "request_accepted",
          s.request,
        );
        const criticalJob = deliveryJob(critical.id);
        claimJob(criticalJob);
        assert.equal(
          recordAttempt(
            criticalJob,
            "failed_permanent",
            null,
            "invalid_request",
          ),
          "permanently_failed",
        );
        assert.equal(completeJob(criticalJob), "completed");
        assert.deepEqual(exceptionsFor(critical.id), [
          {
            exception_type: "notification_delivery_failed",
            severity: "high",
            status: "open",
            source_type: "notification",
            evidence: {
              notification_type: "request_accepted",
              channel: "email",
              failure_code: "invalid_request",
            },
          },
        ]);
        const plain = emailNotification(
          s.client.user,
          "consultation_ready",
          decision.consultation,
        );
        const plainJob = deliveryJob(plain.id);
        claimJob(plainJob);
        assert.equal(
          recordAttempt(plainJob, "failed_permanent", null, "invalid_request"),
          "permanently_failed",
        );
        assert.equal(completeJob(plainJob), "completed");
        assert.deepEqual(exceptionsFor(plain.id), []);
        const ackTarget = inAppNotification(
          s.client.user,
          "consultation_ready",
          decision.consultation,
        );
        const noAck = inAppNotification(
          s.client.user,
          "request_accepted",
          s.request,
        );
        const attorneyReady = inAppNotification(
          who.user,
          "consultation_ready",
          decision.consultation,
        );
        const answers = {
          other_user: acknowledgeAs(newClient(), ackTarget.id, clientOptions),
          unknown: acknowledgeAs(s.client, uid(), clientOptions),
          attorney_aal1: acknowledgeAs(who, attorneyReady.id, { aal: "aal1" }),
          not_required: acknowledgeAs(s.client, noAck.id, clientOptions),
          acknowledged: acknowledgeAs(s.client, ackTarget.id, clientOptions),
          again: acknowledgeAs(s.client, ackTarget.id, clientOptions),
          attorney_aal2: acknowledgeAs(who, attorneyReady.id),
        };
        assert.deepEqual(answers, {
          other_user: "not_found",
          unknown: "not_found",
          attorney_aal1: "not_found",
          not_required: "not_required",
          acknowledged: "acknowledged",
          again: "already_acknowledged",
          attorney_aal2: "acknowledged",
        });
        assert.equal(
          rowOf("notifications", `id = '${ackTarget.id}'`).state,
          "acknowledged",
        );
        assert.deepEqual(
          notificationAudits(ackTarget.id).map((a) => [
            a.action,
            a.actor_type,
            a.after.state,
          ]),
          [["notification.acknowledged", "client", "acknowledged"]],
        );
        return { flags, answers };
      } finally {
        closePolicy(version);
      }
    },
  );

  await check(
    "NOT-5 (MBS section 15 12C: permanent failure becomes observable and escalatable) a delivery job that escalates without a recorded result (its lease expired on the last attempt: the sweeper escalates it, audited as system) moves its still retrying critical Notification to permanently_failed and opens the exception; a staff retry of the escalated job then finds nothing to do",
    () => {
      const version = notificationPolicy({
        critical_notification_types: ["request_awaiting_decision"],
      });
      try {
        const who = withAddress(lawyer("W"));
        const s = authorizedRequest({
          jurisdiction: world.J.W,
          requestPath: "instant",
          lawyer: who,
        });
        const email = emailNotification(
          who.user,
          "request_awaiting_decision",
          s.request,
        );
        assert.equal(email.critical, true);
        const job = deliveryJob(email.id);
        // Seven reported transient failures (attempts 1 to 7 of 8).
        for (let attempt = 1; attempt <= 7; attempt += 1) {
          claimJob(job);
          assert.equal(
            recordAttempt(job, "failed_transient", null, "network"),
            "retrying",
          );
          assert.equal(failJob(job), "retry_scheduled");
          dueNow(job);
        }
        // The worker claims the last attempt and dies: its lease has run out
        // unreported (the claim is modelled with an already expired lease).
        sql(
          `update public.operational_jobs set state = 'running', locked_at = now() - interval '2 minutes', locked_by = 's10-proof', attempt_count = attempt_count + 1, available_at = now() - interval '1 second' where id = '${job}';`,
        );
        const sweep = JSON.parse(
          sql("select public.operational_jobs_sweep()::text;"),
        );
        assert.ok(sweep.escalated >= 1, JSON.stringify(sweep));
        const row = jobRow(job);
        assert.equal(row.state, "escalated");
        const failed = rowOf("notifications", `id = '${email.id}'`);
        assert.equal(failed.state, "permanently_failed");
        assert.deepEqual(
          notificationAudits(email.id).map((a) => [
            a.action,
            a.reason,
            a.after.failure_code ?? null,
          ]),
          [
            ["notification.retrying", "delivery_failed_transient", "network"],
            [
              "notification.permanently_failed",
              "delivery_job_escalated",
              "lease_expired",
            ],
          ],
        );
        assert.equal(exceptionsFor(email.id).length, 1);
        // A staff retry runs the job again; the Notification is terminal.
        const staff = newAccount();
        sql(
          `insert into public.staff_profiles (user_id, staff_state) values ('${staff.user}', 'active');
           insert into public.capability_grants (user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at) values ('${staff.user}', 'manage_operational_jobs', '${world.grantor.user}', null, now() - interval '1 day');`,
        );
        assert.equal(
          as(
            "authenticated",
            staff.auth,
            `select public.staff_retry_job('${job}');`,
          ),
          "applied",
        );
        claimJob(job);
        assert.equal(notificationContext(job).outcome, "nothing_to_do");
        assert.equal(completeJob(job), "completed");
        return { sweep };
      } finally {
        closePolicy(version);
      }
    },
  );

  await check(
    "NOT-6 (MBS section 15 12C: a process restart does not lose a pending critical notification job) a critical Notification's job claimed by one worker session that then dies (no report) survives in the database and is reclaimed by a new session once its lease expires (one more attempt, lease_expired), and delivered",
    async () => {
      const version = notificationPolicy({
        critical_notification_types: ["request_awaiting_decision"],
      });
      try {
        const who = withAddress(lawyer("W"));
        const s = authorizedRequest({
          jurisdiction: world.J.W,
          requestPath: "instant",
          lawyer: who,
        });
        const email = emailNotification(
          who.user,
          "request_awaiting_decision",
          s.request,
        );
        assert.equal(email.critical, true);
        const job = deliveryJob(email.id);
        // Only this job is due for the claims below (every other pending job
        // moves its due time ahead: the only change a pending job admits).
        sql(
          `update public.operational_jobs set available_at = now() + interval '1 day' where state = 'pending' and id <> '${job}';
           update public.operational_jobs set available_at = now() - interval '1 day' where id = '${job}';`,
        );
        const first = await serviceSession("worker-1");
        const claimed = await first.ok(
          "select job_id || '|' || attempt from public.job_claim('s10-worker-1', 5, 1);",
        );
        assert.deepEqual(claimed, [`${job}|1`]);
        await first.ok("commit;");
        first.child.kill("SIGKILL");
        await sleep(200);
        assert.equal(jobRow(job).state, "running");
        const second = await serviceSession("worker-2");
        const early = await second.ok(
          "select count(*) from public.job_claim('s10-worker-2', 5, 1);",
        );
        assert.deepEqual(early, ["0"]);
        await untilPast(jobRow(job).available_at);
        const reclaimed = await second.ok(
          "select job_id || '|' || attempt from public.job_claim('s10-worker-2', 5, 1);",
        );
        assert.deepEqual(reclaimed, [`${job}|2`]);
        await second.ok("commit;");
        second.close();
        assert.equal(jobRow(job).last_error_code, "lease_expired");
        assert.equal(notificationContext(job).outcome, "act");
        assert.equal(
          recordAttempt(job, "accepted", providerReference()),
          "sent",
        );
        assert.equal(
          as(
            "service_role",
            null,
            `select public.job_complete('${job}', 's10-worker-2');`,
          ),
          "completed",
        );
        return { attempts: jobRow(job).attempt_count };
      } finally {
        closePolicy(version);
      }
    },
  );

  await check(
    "NOT-7 (MBS section 15 12C: duplicate delivery events do not duplicate canonical state; PS section 23.1) provider observations: the receipt is recorded once per event (a replay answers duplicate with the first outcome); delivered moves sent -> delivered once (a second delivered event is no_effect, a stale accepted or delayed changes nothing, a bounce after delivery is stale); a bounce moves sent -> permanently_failed and a later delivered is stale; failed moves sent -> failed; complained changes nothing; an unknown reference is unmatched, an ignored event ignored, a malformed one invalid with no receipt; each receipt holds only the observation and digest, correlated to its Notification",
    () => {
      const deliver = () => {
        const who = withAddress(lawyer("W"));
        const s = authorizedRequest({
          jurisdiction: world.J.W,
          requestPath: "instant",
          lawyer: who,
        });
        const email = emailNotification(
          who.user,
          "request_awaiting_decision",
          s.request,
        );
        const { reference } = deliverAccepted(email.id);
        return { email, reference };
      };
      const a = deliver();
      const first = notificationEvent("email.delivered", {
        kind: "delivered",
        provider_reference: a.reference,
      });
      const outcomes = {
        delivered: first.line,
        replay: notificationEvent(
          "email.delivered",
          { kind: "delivered", provider_reference: a.reference },
          first.id,
        ).line,
        delivered_again: notificationEvent("email.delivered", {
          kind: "delivered",
          provider_reference: a.reference,
        }).line,
        stale_accepted: notificationEvent("email.sent", {
          kind: "accepted",
          provider_reference: a.reference,
        }).line,
        stale_delayed: notificationEvent("email.delivery_delayed", {
          kind: "delivery_delayed",
          provider_reference: a.reference,
        }).line,
        bounce_after_delivery: notificationEvent("email.bounced", {
          kind: "bounced",
          provider_reference: a.reference,
        }).line,
        complained: notificationEvent("email.complained", {
          kind: "complained",
          provider_reference: a.reference,
        }).line,
      };
      const delivered = rowOf("notifications", `id = '${a.email.id}'`);
      assert.equal(delivered.state, "delivered");
      assert.ok(delivered.delivered_at);
      const b = deliver();
      outcomes.bounced = notificationEvent("email.bounced", {
        kind: "bounced",
        provider_reference: b.reference,
      }).line;
      outcomes.delivered_after_bounce = notificationEvent("email.delivered", {
        kind: "delivered",
        provider_reference: b.reference,
      }).line;
      assert.equal(
        rowOf("notifications", `id = '${b.email.id}'`).state,
        "permanently_failed",
      );
      const c = deliver();
      outcomes.failed = notificationEvent("email.failed", {
        kind: "failed",
        provider_reference: c.reference,
      }).line;
      assert.equal(
        rowOf("notifications", `id = '${c.email.id}'`).state,
        "failed",
      );
      outcomes.unknown_reference = notificationEvent("email.delivered", {
        kind: "delivered",
        provider_reference: uid(),
      }).line;
      outcomes.ignored = notificationEvent("email.opened", {
        kind: "ignored",
        provider_reference: null,
      }).line;
      const receiptsBefore = count("external_event_receipts");
      outcomes.malformed = notificationEvent("email.delivered", {
        kind: "delivered",
        provider_reference: a.reference,
        to: "x",
      }).line;
      assert.equal(count("external_event_receipts"), receiptsBefore);
      assert.deepEqual(outcomes, {
        delivered: "recorded|applied",
        replay: "duplicate|applied",
        delivered_again: "recorded|no_effect",
        stale_accepted: "recorded|no_effect",
        stale_delayed: "recorded|no_effect",
        bounce_after_delivery: "recorded|stale",
        complained: "recorded|no_effect",
        bounced: "recorded|applied",
        delivered_after_bounce: "recorded|stale",
        failed: "recorded|applied",
        unknown_reference: "recorded|unmatched",
        ignored: "recorded|ignored",
        malformed: "invalid|",
      });
      assert.equal(
        count(
          "external_event_receipts",
          `provider_event_reference = '${first.id}'`,
        ),
        1,
      );
      const receipt = rowOf(
        "external_event_receipts",
        `provider_event_reference = '${first.id}'`,
      );
      assert.deepEqual(
        [
          receipt.provider_code,
          receipt.event_type,
          receipt.processing_state,
          receipt.correlation_reference,
          Object.keys(receipt.minimal_payload).sort(),
        ],
        [
          "synthetic_mail",
          "email.delivered",
          "applied",
          a.email.id,
          ["kind", "provider_created_at", "provider_reference"],
        ],
      );
      assert.deepEqual(
        notificationAudits(a.email.id).map((x) => x.action),
        ["notification.sent", "notification.delivered"],
      );
      return outcomes;
    },
  );

  await check(
    "NOT-8 (MBS section 15 12C; TA section 47) the notification center: the client (aal1) reads only their own in-app Notifications, newest first, each with its link path (their own Request or Consultation page) and the delivery state of its email twin; the attorney reads theirs only at aal2 (aal1: nothing); another user reads only their own; anon cannot execute",
    () => {
      const who = lawyer("W");
      const s = authorizedRequest({
        jurisdiction: world.J.W,
        requestPath: "instant",
        lawyer: who,
      });
      const decision = accept(who, s.request);
      assert.equal(decision.outcome, "accepted");
      const center = centerAs(s.client, clientOptions);
      assert.deepEqual(
        center.map((n) => [
          n.notification_type,
          n.state,
          n.link_path,
          n.email_state,
        ]),
        [
          [
            "consultation_ready",
            "delivered",
            `/client/consultations/${decision.consultation}`,
            "pending",
          ],
          [
            "request_accepted",
            "delivered",
            `/client/requests/${s.request}`,
            "pending",
          ],
        ],
      );
      const attorneyCenter = centerAs(who);
      assert.deepEqual(
        attorneyCenter.map((n) => [n.notification_type, n.link_path]),
        [
          [
            "consultation_ready",
            `/attorney/consultations/${decision.consultation}`,
          ],
          ["request_awaiting_decision", `/attorney/requests/${s.request}`],
        ],
      );
      const answers = {
        attorney_aal1: centerAs(who, { aal: "aal1" }).length,
        other_client: centerAs(newClient(), clientOptions).length,
        anon: as(
          "anon",
          null,
          "select count(*) from public.notification_center();",
        ),
      };
      assert.deepEqual(answers, {
        attorney_aal1: 0,
        other_client: 0,
        anon: "ERROR 42501",
      });
      return answers;
    },
  );

  await check(
    "NOT-9 (MBS section 15 12C; a failed notification never rolls back a business event) a Request decided while every notification insert is refused (a temporary owner constraint, rolled back) is still declined, with notification.not_created audited carrying exactly what operations need to emit it again (the recipient User id, the notification type, the failing channel, the source event type and id, the SQLSTATE; identifiers and codes only); a Notification's lifecycle never regresses or changes identity, even for the owner role, and is never deleted",
    () => {
      const who = lawyer("W");
      const s = authorizedRequest({
        jurisdiction: world.J.W,
        requestPath: "instant",
        lawyer: who,
      });
      const result = psql(
        [
          "begin;",
          "alter table public.notifications add constraint s10_proof_refuse_all check (false) not valid;",
          ...sessionLines("authenticated", who.auth),
          DECLINE_SQL(s.request),
          "reset role;",
          `select state from public.consultation_requests where id = '${s.request}';`,
          `select count(*) from public.notifications where source_event_id = '${s.request}' and notification_type = 'request_declined';`,
          `select count(*) from public.audit_events where action_code = 'notification.not_created' and after_snapshot ->> 'source_event_id' = '${s.request}';`,
          `select concat_ws('|', actor_type, resource_id::text, after_snapshot ->> 'recipient_user_id', after_snapshot ->> 'notification_type', after_snapshot ->> 'channel', after_snapshot ->> 'source_event_type', after_snapshot ->> 'source_event_id', after_snapshot ->> 'sqlstate', (select string_agg(k, ',' order by k) from jsonb_object_keys(after_snapshot) k)) from public.audit_events where action_code = 'notification.not_created' and after_snapshot ->> 'source_event_id' = '${s.request}';`,
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
        "declined",
        "declined",
        "0",
        "1",
        [
          "system",
          s.client.user,
          "request_declined",
          "in_app",
          "consultation_request.declined",
          s.request,
          "23514",
          "channel,notification_type,recipient_user_id,source_event_id,source_event_type,sqlstate",
        ].join("|"),
      ]);
      const email = emailNotification(
        who.user,
        "request_awaiting_decision",
        s.request,
      );
      const inApp = inAppNotification(
        who.user,
        "request_awaiting_decision",
        s.request,
      );
      const codes = {
        pending_to_delivered: refused(
          `update public.notifications set state = 'delivered', sent_at = now(), delivered_at = now() where id = '${email.id}';`,
        ),
        in_app_unacknowledgeable: refused(
          `update public.notifications set state = 'acknowledged' where id = '${inApp.id}';`,
        ),
        identity: refused(
          `update public.notifications set recipient_user_id = '${s.client.user}' where id = '${inApp.id}';`,
        ),
        delete: refused(
          `delete from public.notifications where id = '${inApp.id}';`,
        ),
        truncate: refused("truncate public.notifications cascade;"),
        attempt_update: refused(
          "update public.notification_attempts set failure_code = 'x';",
        ),
        email_created_sent: refused(
          `insert into public.notifications (recipient_user_id, notification_type, source_event_type, source_event_id, channel, state, sent_at) values ('${who.user}', 'request_accepted', 'consultation_request.accepted', '${uid()}', 'email', 'sent', now());`,
        ),
      };
      assert.deepEqual(codes, {
        pending_to_delivered: "23514",
        in_app_unacknowledgeable: "23514",
        identity: "55000",
        delete: "55000",
        truncate: "55000",
        attempt_update: "55000",
        email_created_sent: "23514",
      });
      return codes;
    },
  );

  await check(
    "NOT-10 (MBS section 19; PS-A2) in a production-class database a development notification version (planted) never makes a Notification critical; an approved, active one does",
    () => {
      prod.grantor = prod.grantor ?? newAccount("active", PROD_DB);
      const emitIn = (recipient) => {
        const source = uid();
        prodSql(
          `select public.notification_emit('${recipient}', 'request_accepted', 'consultation_request.accepted', '${source}');`,
        );
        return prodSql(
          `select string_agg(critical::text, ',' order by channel) from public.notifications where source_event_id = '${source}';`,
        );
      };
      const recipient = newAccount("active", PROD_DB);
      const planted = prodPlantedDevelopment("notification", null, {
        critical_notification_types: ["request_accepted"],
      });
      const answers = { development: emitIn(recipient.user) };
      prodSql(
        `begin; set local session_replication_role = replica; update public.policy_versions set effective_until = now() where id = '${planted}'; commit;`,
      );
      prodActivePolicy("notification", null, {
        critical_notification_types: ["request_accepted"],
      });
      answers.active = emitIn(recipient.user);
      assert.deepEqual(answers, {
        development: "false,false",
        active: "true,true",
      });
      return answers;
    },
  );

  await check(
    "NOT-11 (a cancelled delivery job never strands its Notification) a notification.deliver job cancelled by staff (S2 staff_cancel_job, pending or running) or by its subject's end (job_cancel_for_subject) moves its still pending or retrying email Notification to permanently_failed with the fixed failure code delivery_cancelled (state, failed_at, one system audit event) and, for a critical Notification only, opens the high notification_delivery_failed exception; a worker's late answer for the cancelled job is not_running and records nothing; a Notification already sent stays sent",
    () => {
      const staff = newAccount();
      sql(
        `insert into public.staff_profiles (user_id, staff_state) values ('${staff.user}', 'active');
         insert into public.capability_grants (user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at) values ('${staff.user}', 'manage_operational_jobs', '${world.grantor.user}', null, now() - interval '1 day');`,
      );
      const cancelAs = (job) =>
        as(
          "authenticated",
          staff.auth,
          `select public.staff_cancel_job('${job}');`,
        );
      const make = () => {
        const who = withAddress(lawyer("W"));
        const s = authorizedRequest({
          jurisdiction: world.J.W,
          requestPath: "instant",
          lawyer: who,
        });
        return emailNotification(
          who.user,
          "request_awaiting_decision",
          s.request,
        );
      };
      const answers = {};
      const version = notificationPolicy({
        critical_notification_types: ["request_awaiting_decision"],
      });
      let pending = null;
      let running = null;
      try {
        pending = make();
        assert.equal(pending.critical, true);
        answers.pending_cancel = cancelAs(deliveryJob(pending.id));
        running = make();
        const runningJob = deliveryJob(running.id);
        claimJob(runningJob);
        assert.equal(
          recordAttempt(runningJob, "failed_transient", null, "network"),
          "retrying",
        );
        assert.equal(failJob(runningJob), "retry_scheduled");
        dueNow(runningJob);
        claimJob(runningJob);
        answers.running_cancel = cancelAs(runningJob);
        answers.late_record = recordAttempt(
          runningJob,
          "accepted",
          providerReference(),
        );
        answers.late_complete = completeJob(runningJob);
      } finally {
        closePolicy(version);
      }
      const plain = make();
      assert.equal(plain.critical, false);
      answers.subject_cancel = sql(
        `select public.job_cancel_for_subject('notification', '${plain.id}');`,
      );
      const sent = make();
      deliverAccepted(sent.id);
      sql(
        `select public.job_enqueue('notification.deliver', 'notification', '${sent.id}', now(), 8);`,
      );
      answers.sent_cancel = cancelAs(deliveryJob(sent.id));
      const stateOf = (n) => rowOf("notifications", `id = '${n.id}'`);
      answers.states = [pending, running, plain, sent].map((n) => [
        stateOf(n).state,
        stateOf(n).failed_at !== null,
      ]);
      const cancelAudit = (n) =>
        notificationAudits(n.id)
          .filter((a) => a.action === "notification.permanently_failed")
          .map((a) => [a.reason, a.after.failure_code, a.after.critical]);
      answers.audits = {
        pending: cancelAudit(pending),
        running: cancelAudit(running),
        plain: cancelAudit(plain),
        sent: cancelAudit(sent),
      };
      answers.exceptions = [pending, running, plain, sent].map((n) =>
        exceptionsFor(n.id).map((e) => [
          e.exception_type,
          e.severity,
          e.evidence.failure_code,
        ]),
      );
      answers.running_attempts = attemptsOf(running.id).map((a) => a.result);
      assert.deepEqual(answers, {
        pending_cancel: "applied",
        running_cancel: "applied",
        late_record: "not_running",
        late_complete: "not_running",
        subject_cancel: "1",
        sent_cancel: "applied",
        states: [
          ["permanently_failed", true],
          ["permanently_failed", true],
          ["permanently_failed", true],
          ["sent", false],
        ],
        audits: {
          pending: [["delivery_job_cancelled", "delivery_cancelled", true]],
          running: [["delivery_job_cancelled", "delivery_cancelled", true]],
          plain: [["delivery_job_cancelled", "delivery_cancelled", false]],
          sent: [],
        },
        exceptions: [
          [["notification_delivery_failed", "high", "delivery_cancelled"]],
          [["notification_delivery_failed", "high", "delivery_cancelled"]],
          [],
          [],
        ],
        running_attempts: ["failed_transient"],
      });
      return answers;
    },
  );

  await check(
    "NOT-12 (an early provider event is never lost) events that arrive before their accepted attempt is recorded (the recording failed transiently and the job is backing off) are recorded unmatched and keep that outcome; when the first accepted attempt with that provider reference is recorded they are re-applied in provider event time order through the same monotonic path (the accepted event no_effect, the delivered event applied, a duplicate delivered event no_effect), each audited with its receipt; a later event matches directly; a repeated acceptance re-applies nothing; an early bounce of a critical Notification ends it permanently_failed with the exception once its acceptance is recorded",
    () => {
      const make = () => {
        const who = withAddress(lawyer("W"));
        const s = authorizedRequest({
          jurisdiction: world.J.W,
          requestPath: "instant",
          lawyer: who,
        });
        return emailNotification(
          who.user,
          "request_awaiting_decision",
          s.request,
        );
      };
      const email = make();
      const job = deliveryJob(email.id);
      claimJob(job);
      const reference = providerReference();
      const observation = (kind) => ({ kind, provider_reference: reference });
      // Out of provider order: delivered (t-10 s), then sent (t-20 s), then a
      // second delivered event (t-5 s).
      const delivered = notificationEventAt(
        "email.delivered",
        observation("delivered"),
        "now() - interval '10 seconds'",
      );
      const accepted = notificationEventAt(
        "email.sent",
        observation("accepted"),
        "now() - interval '20 seconds'",
      );
      const duplicate = notificationEventAt(
        "email.delivered",
        observation("delivered"),
        "now() - interval '5 seconds'",
      );
      const answers = {
        early: [delivered.line, accepted.line, duplicate.line],
        before_attempt: rowOf("notifications", `id = '${email.id}'`).state,
        attempt: recordAttempt(job, "accepted", reference),
      };
      answers.after_attempt = rowOf(
        "notifications",
        `id = '${email.id}'`,
      ).state;
      answers.receipts = [delivered, accepted, duplicate].map(
        (event) =>
          rowOf(
            "external_event_receipts",
            `provider_event_reference = '${event.id}'`,
          ).processing_state,
      );
      answers.audits = notificationAudits(email.id).map((a) => [
        a.action,
        a.after.observation ?? null,
        a.after.outcome ?? null,
        a.after.receipt_id ?? null,
      ]);
      answers.later = notificationEvent(
        "email.delivered",
        observation("delivered"),
      ).line;
      answers.repeated = recordAttempt(job, "accepted", reference);
      answers.replayed_after_repeat = notificationAudits(email.id).filter(
        (a) => a.action === "notification.observation_replayed",
      ).length;
      assert.equal(completeJob(job), "completed");
      const receiptId = (event) =>
        rowOf(
          "external_event_receipts",
          `provider_event_reference = '${event.id}'`,
        ).id;
      assert.deepEqual(answers, {
        early: [
          "recorded|unmatched",
          "recorded|unmatched",
          "recorded|unmatched",
        ],
        before_attempt: "pending",
        attempt: "sent",
        after_attempt: "delivered",
        receipts: ["unmatched", "unmatched", "unmatched"],
        audits: [
          ["notification.sent", null, null, null],
          [
            "notification.observation_replayed",
            "accepted",
            "no_effect",
            receiptId(accepted),
          ],
          ["notification.delivered", null, null, null],
          [
            "notification.observation_replayed",
            "delivered",
            "applied",
            receiptId(delivered),
          ],
          [
            "notification.observation_replayed",
            "delivered",
            "no_effect",
            receiptId(duplicate),
          ],
        ],
        later: "recorded|no_effect",
        repeated: "no_effect",
        replayed_after_repeat: 3,
      });
      // An early bounce of a critical Notification.
      const version = notificationPolicy({
        critical_notification_types: ["request_awaiting_decision"],
      });
      try {
        const critical = make();
        assert.equal(critical.critical, true);
        const criticalJob = deliveryJob(critical.id);
        claimJob(criticalJob);
        const bounceReference = providerReference();
        const bounce = notificationEventAt(
          "email.bounced",
          { kind: "bounced", provider_reference: bounceReference },
          "now() - interval '1 second'",
        );
        answers.critical = {
          bounce: bounce.line,
          attempt: recordAttempt(criticalJob, "accepted", bounceReference),
          state: rowOf("notifications", `id = '${critical.id}'`).state,
          exceptions: exceptionsFor(critical.id).map((e) => [
            e.exception_type,
            e.severity,
            e.evidence.failure_code,
          ]),
        };
        assert.equal(completeJob(criticalJob), "completed");
        assert.deepEqual(answers.critical, {
          bounce: "recorded|unmatched",
          attempt: "sent",
          state: "permanently_failed",
          exceptions: [["notification_delivery_failed", "high", "bounced"]],
        });
      } finally {
        closePolicy(version);
      }
      return answers;
    },
  );

  await check(
    "NOT-13 (one fixed address rule, shared with the application and the email adapter) the worker's context answers act for every address the rule admits, apostrophes included (RFC 5322 atext and dots in the local part, letters, digits and inner hyphens in each host label), and no_recipient for any other (a comma, a quote, an angle bracket, a bad host label, an over-long local part), never a retry loop; a not_sent attempt for an address the application refuses (recipient_address_unsupported) or a message the adapter refuses (invalid_request) is final: permanently_failed, audited delivery_not_sendable with its code, no provider reference",
    () => {
      const probe = (address) => {
        const who = lawyer("W");
        sql(
          `update auth.users set email = ${lit(address)} where id = '${who.auth}';`,
        );
        const s = authorizedRequest({
          jurisdiction: world.J.W,
          requestPath: "instant",
          lawyer: who,
        });
        const email = emailNotification(
          who.user,
          "request_awaiting_decision",
          s.request,
        );
        const job = deliveryJob(email.id);
        claimJob(job);
        return { email, job, context: notificationContext(job) };
      };
      const admitted = [
        "o'brien@synthetic.invalid",
        "d'angelo.o'neil+tag@sub.synthetic.invalid",
        "a!#$%&'*+/=?^_`{|}~-z@synthetic.invalid",
      ];
      const refusedAddresses = [
        "first,second@synthetic.invalid",
        'quoted"local@synthetic.invalid',
        "angle<bracket@synthetic.invalid",
        "local@-host.synthetic.invalid",
        "local@under_score.synthetic.invalid",
        `${"l".repeat(65)}@synthetic.invalid`,
      ];
      const answers = { admitted: [], refused: [] };
      for (const address of admitted) {
        const p = probe(address);
        answers.admitted.push([
          p.context.outcome,
          p.context.recipient_address === address,
          recordAttempt(p.job, "accepted", providerReference()),
        ]);
        assert.equal(completeJob(p.job), "completed");
      }
      const codes = [
        "recipient_address_unsupported",
        "invalid_request",
        "recipient_unavailable",
        "recipient_unavailable",
        "recipient_unavailable",
        "recipient_unavailable",
      ];
      refusedAddresses.forEach((address, index) => {
        const p = probe(address);
        const recorded = recordAttempt(p.job, "not_sent", null, codes[index]);
        assert.equal(completeJob(p.job), "completed");
        answers.refused.push([
          p.context.outcome,
          p.context.recipient_address,
          recorded,
          rowOf("notifications", `id = '${p.email.id}'`).state,
          attemptsOf(p.email.id).map((a) => [
            a.result,
            a.failure_code,
            a.reference,
          ]),
          notificationAudits(p.email.id).map((a) => [
            a.reason,
            a.after.failure_code,
          ]),
        ]);
      });
      assert.deepEqual(answers.admitted, [
        ["act", true, "sent"],
        ["act", true, "sent"],
        ["act", true, "sent"],
      ]);
      assert.deepEqual(
        answers.refused,
        codes.map((code) => [
          "no_recipient",
          null,
          "permanently_failed",
          "permanently_failed",
          [["not_sent", code, false]],
          [["delivery_not_sendable", code]],
        ]),
      );
      return { admitted: answers.admitted.length, refused: codes };
    },
  );
}

// ---------------------------------------------------------------------------
// CONC: real concurrency
// ---------------------------------------------------------------------------

async function concurrencyChecks() {
  await check(
    "CONC-1 duplicate webhook deliveries race: two service sessions record the same event at once; one records it (applied), the other answers duplicate after the first commits; one receipt and one transition",
    async () => {
      const who = withAddress(lawyer("W"));
      const s = authorizedRequest({
        jurisdiction: world.J.W,
        requestPath: "instant",
        lawyer: who,
      });
      const email = emailNotification(
        who.user,
        "request_awaiting_decision",
        s.request,
      );
      const { reference } = deliverAccepted(email.id);
      const eventId = `msg_${sha256(uid()).slice(0, 27)}`;
      const statement = NOTIFICATION_EVENT_SQL(eventId, "email.delivered", {
        kind: "delivered",
        provider_reference: reference,
      });
      const a = await serviceSession("hook-a");
      const b = await serviceSession("hook-b");
      const first = await a.ok(statement);
      const pendingB = b.send(statement);
      await blockedOnLock(b.pid);
      await a.ok("commit;");
      const second = await pendingB;
      await b.ok("commit;");
      a.close();
      b.close();
      const outcome = { first: lastLine(first), second: lastLine(second.rows) };
      assert.deepEqual(outcome, {
        first: "recorded|applied",
        second: "duplicate|applied",
      });
      assert.equal(
        count(
          "external_event_receipts",
          `provider_event_reference = '${eventId}'`,
        ),
        1,
      );
      assert.deepEqual(
        notificationAudits(email.id).map((x) => x.action),
        ["notification.sent", "notification.delivered"],
      );
      report.concurrency.duplicate_webhook = outcome;
      return outcome;
    },
  );

  await check(
    "CONC-2 concurrent sends: the client and the attorney send in the same Consultation at the same time from two sessions; both are sent, two Messages and four Notifications, no deadlock",
    async () => {
      const s = liveConsultation("W");
      const c = await clientSession("send-client", s.client);
      const t = await attorneySession("send-attorney", s.lawyer);
      const [x, y] = await Promise.all([
        c.send(SEND_SQL(s.consultation, "Concurrent client message.")),
        t.send(SEND_SQL(s.consultation, "Concurrent attorney message.")),
      ]);
      await Promise.all([c.ok("commit;"), t.ok("commit;")]);
      c.close();
      t.close();
      const outcome = [
        x.sqlstate,
        y.sqlstate,
        lastLine(x.rows).split("|")[0],
        lastLine(y.rows).split("|")[0],
      ];
      assert.deepEqual(outcome, ["00000", "00000", "sent", "sent"]);
      assert.equal(
        count("messages", `consultation_id = '${s.consultation}'`),
        2,
      );
      assert.equal(
        count(
          "notifications",
          `source_event_type = 'message.sent' and source_event_id in (select id from public.messages where consultation_id = '${s.consultation}')`,
        ),
        4,
      );
      report.concurrency.concurrent_sends = outcome;
      return outcome;
    },
  );

  await check(
    "CONC-3 a send racing the Consultation's end: the attorney's end holds the Consultation; the client's send waits on its lock and decides on the committed completion: sent inside a configured window, window_unavailable without one (never a send decided on stale state)",
    async () => {
      const results = {};
      for (const key of ["W", "N"]) {
        const s = liveConsultation(key);
        const t = await attorneySession(`end-${key}`, s.lawyer);
        const ended = await t.ok(END_SQL(s.consultation));
        assert.equal(JSON.parse(lastLine(ended)).outcome, "completed");
        const c = await clientSession(`race-${key}`, s.client);
        const pendingSend = c.send(SEND_SQL(s.consultation, "Racing the end."));
        await blockedOnLock(c.pid);
        await t.ok("commit;");
        const sent = await pendingSend;
        await c.ok("commit;");
        t.close();
        c.close();
        results[key] = lastLine(sent.rows).split("|")[0];
      }
      assert.deepEqual(results, { W: "sent", N: "window_unavailable" });
      report.concurrency.send_racing_end = results;
      return results;
    },
  );

  await check(
    "CONC-4 revocation racing access, both orders: a revocation in progress makes a concurrent access wait for it and then refuses it; an access in progress makes the revocation wait, the access is authorized, the revocation then commits and every later access is refused",
    async () => {
      const s = liveConsultation("W");
      const doc = uploadDocument(s.client, s.consultation, clientOptions);
      const access = `select outcome from public.resource_authorize_access('${doc}', 'document');`;
      const revoke = `select public.document_revoke_sharing('${doc}');`;
      const owner = await clientSession("revoke-first", s.client);
      assert.deepEqual(await owner.ok(revoke), ["revoked"]);
      const reader = await attorneySession("access-second", s.lawyer);
      const pendingAccess = reader.send(access);
      await blockedOnLock(reader.pid);
      await owner.ok("commit;");
      const first = await pendingAccess;
      await reader.ok("commit;");
      owner.close();
      reader.close();
      const s2 = liveConsultation("W");
      const doc2 = uploadDocument(s2.client, s2.consultation, clientOptions);
      const reader2 = await attorneySession("access-first", s2.lawyer);
      const granted = await reader2.ok(
        `select outcome from public.resource_authorize_access('${doc2}', 'document');`,
      );
      const owner2 = await clientSession("revoke-second", s2.client);
      const pendingRevoke = owner2.send(
        `select public.document_revoke_sharing('${doc2}');`,
      );
      await blockedOnLock(owner2.pid);
      await reader2.ok("commit;");
      const revoked = await pendingRevoke;
      await owner2.ok("commit;");
      reader2.close();
      owner2.close();
      const outcome = {
        revoke_first_access: lastLine(first.rows),
        access_first: lastLine(granted),
        revoke_after_access: lastLine(revoked.rows),
        later_access: authorizeAs(s2.lawyer, doc2),
      };
      assert.deepEqual(outcome, {
        revoke_first_access: "refused",
        access_first: "authorized",
        revoke_after_access: "revoked",
        later_access: "refused|",
      });
      report.concurrency.revocation_racing_access = outcome;
      return outcome;
    },
  );

  await check(
    "CONC-5 two workers record the same delivery job's result at once (a retried call racing its first answer): the Notification row lock serializes them; the first sends it, the second adds evidence with no_effect; one sent transition",
    async () => {
      const who = withAddress(lawyer("W"));
      const s = authorizedRequest({
        jurisdiction: world.J.W,
        requestPath: "instant",
        lawyer: who,
      });
      const email = emailNotification(
        who.user,
        "request_awaiting_decision",
        s.request,
      );
      const job = deliveryJob(email.id);
      claimJob(job);
      const reference = providerReference();
      const statement = `select public.notification_record_attempt('${job}', 'synthetic_mail', 'accepted', '${reference}', null);`;
      const a = await serviceSession("record-a");
      const b = await serviceSession("record-b");
      const first = await a.ok(statement);
      const pendingB = b.send(statement);
      await blockedOnLock(b.pid);
      await a.ok("commit;");
      const second = await pendingB;
      await b.ok("commit;");
      a.close();
      b.close();
      assert.equal(completeJob(job), "completed");
      const outcome = { first: lastLine(first), second: lastLine(second.rows) };
      assert.deepEqual(outcome, { first: "sent", second: "no_effect" });
      assert.equal(
        notificationAudits(email.id).filter(
          (x) => x.action === "notification.sent",
        ).length,
        1,
      );
      report.concurrency.duplicate_record = outcome;
      return outcome;
    },
  );

  await check(
    "CONC-6 mixed load with zero deadlocks: ten sessions at once send Messages in both directions, upload, replace (two replacements of one version racing, PS-A5) and share documents, read version histories, authorize and revoke access, record delivery results and provider events and acknowledge Notifications across shared Consultations; every statement completes without a deadlock (40P01) or lock timeout, and the racing replacements leave exactly one successor",
    async () => {
      const a = liveConsultation("W");
      const b = liveConsultation("W");
      const docA = uploadDocument(a.client, a.consultation, clientOptions);
      const docB = uploadDocument(b.lawyer, b.consultation);
      // PS-A5: a version of a's client document replaced twice at once, and a
      // replacement of b's attorney document, all started before the load.
      const versionA = replaceDocument(
        a.client,
        documentIdOf(docA),
        clientOptions,
      );
      const raceA1 = beginReplacement(
        a.client,
        versionA.document,
        clientOptions,
      );
      const raceA2 = beginReplacement(
        a.client,
        versionA.document,
        clientOptions,
      );
      const docBDocument = documentIdOf(docB);
      const replaceB = beginReplacement(b.lawyer, docBDocument);
      const who = withAddress(lawyer("W"));
      const r = authorizedRequest({
        jurisdiction: world.J.W,
        requestPath: "instant",
        lawyer: who,
      });
      const email = emailNotification(
        who.user,
        "request_awaiting_decision",
        r.request,
      );
      const delivered = deliverAccepted(email.id);
      const digest = digestValue();
      const plans = [
        [
          "c-a",
          () => clientSession("mix-c-a", a.client),
          [
            SEND_SQL(a.consultation, "Mixed 1."),
            `select outcome from public.document_begin_upload('${a.consultation}', 'application/pdf', 10, '${digest}');`,
            `select public.document_revoke_sharing('${docA}');`,
            FINALIZE_REPLACEMENT_SQL(raceA1.resource, versionA.document),
          ],
        ],
        [
          "t-a",
          () => attorneySession("mix-t-a", a.lawyer),
          [
            SEND_SQL(a.consultation, "Mixed 2."),
            `select outcome from public.resource_authorize_access('${docA}', 'document');`,
            "select count(*) from public.notification_center();",
          ],
        ],
        [
          "c-b",
          () => clientSession("mix-c-b", b.client),
          [
            SEND_SQL(b.consultation, "Mixed 3."),
            `select outcome from public.resource_authorize_access('${docB}', 'document');`,
          ],
        ],
        [
          "t-b",
          () => attorneySession("mix-t-b", b.lawyer),
          [
            SEND_SQL(b.consultation, "Mixed 4."),
            `select public.document_revoke_sharing('${docB}');`,
            FINALIZE_REPLACEMENT_SQL(replaceB.resource, docBDocument),
          ],
        ],
        [
          "hook-1",
          () => serviceSession("mix-hook-1"),
          [
            NOTIFICATION_EVENT_SQL(
              `msg_${sha256(uid()).slice(0, 27)}`,
              "email.delivered",
              { kind: "delivered", provider_reference: delivered.reference },
            ),
          ],
        ],
        [
          "hook-2",
          () => serviceSession("mix-hook-2"),
          [
            NOTIFICATION_EVENT_SQL(
              `msg_${sha256(uid()).slice(0, 27)}`,
              "email.complained",
              { kind: "complained", provider_reference: delivered.reference },
            ),
          ],
        ],
        [
          "c-a2",
          () => clientSession("mix-c-a2", a.client),
          [
            `select count(*) from public.consultation_messages('${a.consultation}');`,
            SEND_SQL(a.consultation, "Mixed 5."),
          ],
        ],
        [
          "t-a2",
          () => attorneySession("mix-t-a2", a.lawyer),
          [
            SEND_SQL(a.consultation, "Mixed 6."),
            `select count(*) from public.consultation_documents('${a.consultation}');`,
            `select count(*) from public.document_versions('${a.consultation}', '${versionA.document}');`,
          ],
        ],
        [
          "c-a3",
          () => clientSession("mix-c-a3", a.client),
          [
            FINALIZE_REPLACEMENT_SQL(raceA2.resource, versionA.document),
            `select count(*) from public.document_versions('${a.consultation}', '${versionA.document}');`,
          ],
        ],
        [
          "t-a3",
          () => attorneySession("mix-t-a3", a.lawyer),
          [
            `select outcome from public.resource_authorize_access('${versionA.resource}', 'document');`,
            `select count(*) from public.document_versions('${a.consultation}', '${versionA.document}');`,
          ],
        ],
      ];
      const sessions = [];
      for (const [label, open] of plans) {
        sessions.push([label, await open()]);
      }
      const states = [];
      await Promise.all(
        sessions.map(async ([label, s], index) => {
          for (const statement of plans[index][2]) {
            const result = await s.send(statement);
            states.push([label, result.sqlstate]);
          }
          const committed = await s.send("commit;");
          states.push([label, committed.sqlstate]);
        }),
      );
      for (const [, s] of sessions) {
        s.close();
      }
      const failures = states.filter(([, code]) => code !== "00000");
      assert.deepEqual(failures, []);
      // The racing replacements: one successor, the other upload rejected.
      assert.equal(
        count("documents", `supersedes_document_id = '${versionA.document}'`),
        1,
      );
      assert.deepEqual(
        [raceA1.resource, raceA2.resource]
          .map((r) => rowOf("resources", `id = '${r}'`).visibility_state)
          .sort(),
        ["available", "rejected"],
      );
      assert.equal(
        documentRow(documentIdOf(replaceB.resource)).version_label,
        "v2",
      );
      report.concurrency.mixed_load = {
        statements: states.length,
        deadlocks: 0,
        racing_replacements: "one available, one rejected",
      };
      return report.concurrency.mixed_load;
    },
  );

  await check(
    "CONC-7 an attempt recording racing a provider event of the same reference, both orders, serialize on the reference's advisory lock, so neither misses the other: an accepted attempt in progress makes the event wait, which then matches it (applied); an event in progress (recorded unmatched) makes the attempt wait, which then re-applies it; both Notifications end delivered",
    async () => {
      const prepare = () => {
        const who = withAddress(lawyer("W"));
        const s = authorizedRequest({
          jurisdiction: world.J.W,
          requestPath: "instant",
          lawyer: who,
        });
        const email = emailNotification(
          who.user,
          "request_awaiting_decision",
          s.request,
        );
        const job = deliveryJob(email.id);
        claimJob(job);
        return { email, job, reference: providerReference() };
      };
      const attemptSql = (job, reference) =>
        `select public.notification_record_attempt('${job}', 'synthetic_mail', 'accepted', ${lit(reference)}, null);`;
      const eventSql = (reference) =>
        NOTIFICATION_EVENT_SQL(
          `msg_${sha256(uid()).slice(0, 27)}`,
          "email.delivered",
          { kind: "delivered", provider_reference: reference },
        );
      // The attempt first.
      const a = prepare();
      const worker = await serviceSession("attempt-first");
      const recorded = await worker.ok(attemptSql(a.job, a.reference));
      const hook = await serviceSession("event-second");
      const pendingEvent = hook.send(eventSql(a.reference));
      await blockedBy(hook.pid, worker.pid);
      await worker.ok("commit;");
      const event = await pendingEvent;
      await hook.ok("commit;");
      worker.close();
      hook.close();
      assert.equal(completeJob(a.job), "completed");
      // The event first.
      const b = prepare();
      const hook2 = await serviceSession("event-first");
      const early = await hook2.ok(eventSql(b.reference));
      const worker2 = await serviceSession("attempt-second");
      const pendingAttempt = worker2.send(attemptSql(b.job, b.reference));
      await blockedBy(worker2.pid, hook2.pid);
      await hook2.ok("commit;");
      const late = await pendingAttempt;
      await worker2.ok("commit;");
      hook2.close();
      worker2.close();
      assert.equal(completeJob(b.job), "completed");
      const outcome = {
        attempt_first: lastLine(recorded),
        event_after_attempt: lastLine(event.rows),
        event_first: lastLine(early),
        attempt_after_event: lastLine(late.rows),
        states: [a, b].map(
          (x) => rowOf("notifications", `id = '${x.email.id}'`).state,
        ),
        replayed: [a, b].map(
          (x) =>
            notificationAudits(x.email.id).filter(
              (y) => y.action === "notification.observation_replayed",
            ).length,
        ),
      };
      assert.deepEqual(outcome, {
        attempt_first: "sent",
        event_after_attempt: "recorded|applied",
        event_first: "recorded|unmatched",
        attempt_after_event: "sent",
        states: ["delivered", "delivered"],
        replayed: [0, 1],
      });
      report.concurrency.attempt_racing_event = outcome;
      return outcome;
    },
  );

  await check(
    "CONC-8 an access whose statement began before a revocation and then waited for the revocation's grant lock is refused once the revocation commits (the grant is read again at clock time after the lock): the access starts while a third session holds the recipient's own user row, the uploader revokes meanwhile (holding the grant), the third session releases, the access waits on the grant, the revocation commits, and the access is refused with nothing audited; a later access is refused too",
    async () => {
      const s = liveConsultation("W");
      const doc = uploadDocument(s.client, s.consultation, clientOptions);
      const holder = await ownerSession("hold-recipient");
      await holder.ok(
        `select 1 from public.users where id = '${s.lawyer.user}' for update;`,
      );
      const reader = await attorneySession("access-early", s.lawyer);
      const pendingAccess = reader.send(
        `select outcome from public.resource_authorize_access('${doc}', 'document');`,
      );
      await blockedBy(reader.pid, holder.pid);
      const accessStarted = sql(
        `select query_start from pg_stat_activity where pid = ${reader.pid};`,
      );
      const owner = await clientSession("revoke-meanwhile", s.client);
      const revoked = await owner.ok(
        `select public.document_revoke_sharing('${doc}');`,
      );
      await holder.ok("commit;");
      await blockedBy(reader.pid, owner.pid);
      await owner.ok("commit;");
      const access = await pendingAccess;
      await reader.ok("commit;");
      holder.close();
      reader.close();
      owner.close();
      const grant = rowOf("resource_sharing_grants", `resource_id = '${doc}'`);
      const outcome = {
        revoke: lastLine(revoked),
        access: lastLine(access.rows),
        access_began_before_revocation:
          ms(accessStarted) < ms(grant.revoked_at),
        attorney_access_audits: count(
          "audit_events",
          `action_code = 'resource_access_authorized' and resource_id = '${doc}' and actor_user_id = '${s.lawyer.user}'`,
        ),
        later_access: authorizeAs(s.lawyer, doc),
      };
      assert.deepEqual(outcome, {
        revoke: "revoked",
        access: "refused",
        access_began_before_revocation: true,
        attorney_access_audits: 0,
        later_access: "refused|",
      });
      report.concurrency.access_waiting_on_revocation = outcome;
      return outcome;
    },
  );

  await check(
    "CONC-9 (PS-A5 linear history under concurrency) two replacements of one version completed at once from two sessions: the first holds the superseded Document's lock, the second waits for it and then answers already_superseded with its own upload rejected in the same call; exactly one successor (v2) exists and its own grant only",
    async () => {
      const s = liveConsultation("W");
      const v1 = documentIdOf(
        uploadDocument(s.client, s.consultation, clientOptions),
      );
      const first = beginReplacement(s.client, v1, clientOptions);
      const second = beginReplacement(s.client, v1, clientOptions);
      // An attorney's two sessions share no own-row lock (the profile is
      // locked FOR SHARE), so their wait is on the superseded Document itself.
      const t = liveConsultation("W");
      const w1 = documentIdOf(uploadDocument(t.lawyer, t.consultation));
      const firstT = beginReplacement(t.lawyer, w1);
      const secondT = beginReplacement(t.lawyer, w1);
      const one = await attorneySession("replace-first", t.lawyer);
      const won = await one.ok(FINALIZE_REPLACEMENT_SQL(firstT.resource, w1));
      const two = await attorneySession("replace-second", t.lawyer);
      const pending = two.send(FINALIZE_REPLACEMENT_SQL(secondT.resource, w1));
      await blockedBy(two.pid, one.pid);
      await one.ok("commit;");
      const lost = await pending;
      await two.ok("commit;");
      one.close();
      two.close();
      // The client's pair: serialized at the client's own row first.
      const c1 = await clientSession("client-replace-first", s.client);
      const clientWon = await c1.ok(
        FINALIZE_REPLACEMENT_SQL(first.resource, v1),
      );
      const c2 = await clientSession("client-replace-second", s.client);
      const clientPending = c2.send(
        FINALIZE_REPLACEMENT_SQL(second.resource, v1),
      );
      await blockedBy(c2.pid, c1.pid);
      await c1.ok("commit;");
      const clientLost = await clientPending;
      await c2.ok("commit;");
      c1.close();
      c2.close();
      const outcome = {
        attorney: [lastLine(won), lastLine(lost.rows)],
        attorney_states: [firstT.resource, secondT.resource].map(
          (r) => rowOf("resources", `id = '${r}'`).visibility_state,
        ),
        attorney_successors: count(
          "documents",
          `supersedes_document_id = '${w1}'`,
        ),
        attorney_label: documentRow(documentIdOf(firstT.resource))
          .version_label,
        attorney_grants: [firstT.resource, secondT.resource].map((r) =>
          count("resource_sharing_grants", `resource_id = '${r}'`),
        ),
        client: [lastLine(clientWon), lastLine(clientLost.rows)],
        client_successors: count(
          "documents",
          `supersedes_document_id = '${v1}'`,
        ),
      };
      assert.deepEqual(outcome, {
        attorney: ["available", "already_superseded"],
        attorney_states: ["available", "rejected"],
        attorney_successors: 1,
        attorney_label: "v2",
        attorney_grants: [1, 0],
        client: ["available", "already_superseded"],
        client_successors: 1,
      });
      report.concurrency.concurrent_replacements = outcome;
      return outcome;
    },
  );

  await check(
    "CONC-10 (PS-A5 per-version grants under concurrency) a replacement racing a revocation of the predecessor's grant, both orders (the attorney as uploader, two sessions): neither waits for the other (they touch different rows) and both commit; the new version is shared by its own active grant, the predecessor's grant is revoked, and the recipient is refused the predecessor and authorized the new version",
    async () => {
      const run = async (revokeFirst) => {
        const s = liveConsultation("W");
        const v1Resource = uploadDocument(s.lawyer, s.consultation);
        const v1 = documentIdOf(v1Resource);
        const begun = beginReplacement(s.lawyer, v1);
        const replacer = await attorneySession("race-replace", s.lawyer);
        const revoker = await attorneySession("race-revoke", s.lawyer);
        const [firstSession, firstSql, secondSession, secondSql] = revokeFirst
          ? [
              revoker,
              `select public.document_revoke_sharing('${v1Resource}');`,
              replacer,
              FINALIZE_REPLACEMENT_SQL(begun.resource, v1),
            ]
          : [
              replacer,
              FINALIZE_REPLACEMENT_SQL(begun.resource, v1),
              revoker,
              `select public.document_revoke_sharing('${v1Resource}');`,
            ];
        const firstRows = await firstSession.ok(firstSql);
        const secondRows = await secondSession.ok(secondSql);
        await firstSession.ok("commit;");
        await secondSession.ok("commit;");
        replacer.close();
        revoker.close();
        const replaced = lastLine(revokeFirst ? secondRows : firstRows);
        const revoked = lastLine(revokeFirst ? firstRows : secondRows);
        return {
          replaced,
          revoked,
          predecessor_access: authorizeAs(s.client, v1Resource, clientOptions),
          new_access:
            authorizeAs(s.client, begun.resource, clientOptions) ===
            `authorized|${objectPath(begun.resource)}`,
          new_grant_active:
            rowOf(
              "resource_sharing_grants",
              `resource_id = '${begun.resource}'`,
            ).revoked_at === null,
        };
      };
      const outcome = {
        replacement_first: await run(false),
        revocation_first: await run(true),
      };
      const expected = {
        replaced: "available",
        revoked: "revoked",
        predecessor_access: "refused|",
        new_access: true,
        new_grant_active: true,
      };
      assert.deepEqual(outcome, {
        replacement_first: expected,
        revocation_first: expected,
      });
      report.concurrency.replacement_racing_revocation = outcome;
      return outcome;
    },
  );

  await check(
    "CONC-11 (PS-A5 replacement under the communication window) a replacement completion racing the Consultation's end: the attorney's end holds the Consultation; the client's completion waits on its lock and decides on the committed completion: inside a configured window the new version is available (v2), without one it is not_editable, its upload is then abandoned (rejected) and the predecessor stays the current version",
    async () => {
      const run = async (key) => {
        const s = liveConsultation(key);
        const v1 = documentIdOf(
          uploadDocument(s.client, s.consultation, clientOptions),
        );
        const begun = beginReplacement(s.client, v1, clientOptions);
        const ender = await attorneySession(`end-${key}`, s.lawyer);
        const ended = await ender.ok(
          `select outcome from public.consultation_end('${s.consultation}');`,
        );
        const completer = await clientSession(`complete-${key}`, s.client);
        const pending = completer.send(
          FINALIZE_REPLACEMENT_SQL(begun.resource, v1),
        );
        await blockedBy(completer.pid, ender.pid);
        await ender.ok("commit;");
        const completed = await pending;
        await completer.ok("commit;");
        ender.close();
        completer.close();
        const result = lastLine(completed.rows);
        const abandoned =
          result === "available"
            ? null
            : abandonAs(s.client, begun.resource, clientOptions);
        return {
          ended: lastLine(ended),
          completion: result,
          abandoned,
          successors: count("documents", `supersedes_document_id = '${v1}'`),
          current: documentsAs(s.client, s.consultation, clientOptions).map(
            (d) => d.version_label,
          ),
        };
      };
      const outcome = { window: await run("W"), no_window: await run("N") };
      assert.deepEqual(outcome, {
        window: {
          ended: "completed",
          completion: "available",
          abandoned: null,
          successors: 1,
          current: ["v2"],
        },
        no_window: {
          ended: "completed",
          completion: "not_editable",
          abandoned: "rejected",
          successors: 0,
          current: ["v1"],
        },
      });
      report.concurrency.replacement_racing_end = outcome;
      return outcome;
    },
  );
}

// ---------------------------------------------------------------------------
// EXIT: one consultation's communication end to end through the functions
// ---------------------------------------------------------------------------

async function exitCheck() {
  await check(
    "EXIT-1 (IMP section 26 exit) a client and an attorney communicate in a Consultation without direct database intervention: messages both ways while live and inside the configured window after completion, a client document shared with and opened by the attorney, the grant revoked, the Notifications delivered by the worker and observed by the provider, both centers showing them, and the thread read-only once the window closes",
    () => {
      const s = liveConsultation("W");
      withAddress(s.client);
      withAddress(s.lawyer);
      assert.equal(clientSend(s, "Synthetic exit question.").outcome, "sent");
      assert.equal(attorneySend(s, "Synthetic exit answer.").outcome, "sent");
      const doc = uploadDocument(s.client, s.consultation, clientOptions);
      assert.equal(authorizeAs(s.lawyer, doc), `authorized|${objectPath(doc)}`);
      assert.equal(end(s).outcome, "completed");
      assert.equal(clientSend(s, "Synthetic follow-up.").outcome, "sent");
      assert.equal(revokeAs(s.client, doc, clientOptions), "revoked");
      assert.equal(authorizeAs(s.lawyer, doc), "refused|");
      const attorneyEmails = notificationsOf(
        s.lawyer.user,
        "channel = 'email' and notification_type in ('message_received', 'document_shared')",
      );
      for (const n of attorneyEmails) {
        const { reference } = deliverAccepted(n.id);
        assert.equal(
          notificationEvent("email.delivered", {
            kind: "delivered",
            provider_reference: reference,
          }).processing,
          "applied",
        );
      }
      const center = centerAs(s.lawyer);
      assert.ok(
        center
          .filter((n) => n.notification_type === "message_received")
          .every((n) => n.email_state === "delivered"),
      );
      assert.ok(
        center.some(
          (n) =>
            n.notification_type === "document_shared" &&
            n.email_state === "delivered",
        ),
      );
      shiftEnded(s.consultation, 7200);
      assert.equal(attorneySend(s, "Too late.").outcome, "closed");
      assert.equal(
        messagesAs(s.client, s.consultation, clientOptions).length,
        3,
      );
      return {
        messages: 3,
        attorney_emails_delivered: attorneyEmails.length,
        center_entries: center.length,
      };
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
    await configurationChecks();
    await messageChecks();
    await documentChecks();
    await notificationChecks();
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
