// MVP-001 S11 disposable PostgreSQL proof (M13 Operations and administration,
// pass 2). Explicitly invoked only:
//
//   node apps/web/tests/mvp-001-s11-operations-db-proof.mjs
//
// Deliberately not a *.test.mjs file, so no application test run, p0:test,
// or CI job starts it. It uses Node built-ins and the system-installed
// PostgreSQL 16 initdb, pg_ctl, and psql binaries.
//
// It creates a new mode-0700 temporary directory, initializes a new cluster
// owned by an unprivileged account (never root), and starts it with TCP
// disabled and a private Unix-domain socket (port 54348, so it can run next
// to the S11 pass 1 proof). The roles anon, authenticated, and service_role
// (BYPASSRLS), the synthetic auth schema (auth.users with the identity
// provider's email column, and an auth.uid() that reads
// request.jwt.claim.sub), the hosted platform's default privileges, and a
// no-op public.rls_auto_enable() are synthetic objects of this cluster only.
// Every migration is applied unmodified, in order, each in one transaction,
// to three databases: the main database records its environment as
// development; a second one records production (a synthetic 20-letter
// project reference) for the production gate probes; a third one stops after
// the seven S11 pass 1 migrations, so the catalog the nine pass 2 migrations
// leave can be compared with the catalog before them. The nine pass 2
// migrations must follow pass 1 and be registered.
//
// Configuration: every policy version of the development database is
// development configuration created by the owner role inside this disposable
// cluster (Packet rule 9), as in the pass 1 proof (the same seed): synthetic
// payment flows, timing keys, engagement parameters, the XTS test currency,
// the synthetic modality and the SYN_* Regulatory Modes. Every account,
// licence number, note, audit event planted for the audit reads, Request,
// payment and provider event is synthetic test data (FP-1 section 3.4), never
// a product value or decision. No threshold is configured anywhere for the
// compliance sections: the probes show that none is assumed. The production
// database uses owner-walked authority versions with a synthetic verified
// reference, and fixtures planted by the owner with triggers bypassed where a
// probe says so (the production gate, not the fixture, is what is examined).
//
// The providers are simulated exactly as in the pass 1 proof (the probes play
// the worker and the webhook routes as service_role). No provider, Supabase
// project, network service or pre-existing cluster is contacted, and nothing
// persists after the run.
//
// Request sessions are modelled as PostgREST sets them from a verified JWT:
// request.jwt.claim.sub and the JSON request.jwt.claims (clients at aal1,
// attorneys and staff at aal2 unless a probe says otherwise); anonymous
// requests run as anon without a subject.
//
// The probes cover the MVP-001 Packet S11 acceptance for the database parts
// of pass 2: the migrations and the unchanged physical model, the capability
// catalog, privileges and the capability and scope matrix of every new
// function, the audit workspace (scope, filters, minimization and its own
// audit), the operations summary against planted states, the compliance
// sections per capability, attorney reinstatement and removal with the S8
// review routing, the waitlist (staff read, no visibility, no Referral),
// rejoin detection, client administration with PM row 46, the referral and
// financial reads, the corrections D2, D3, D5, D7 and D8, the four-way gate
// matrix and the per-operation negative probes, and the race list under real
// concurrency with two or more persistent sessions, with the exact observed
// outcomes.
//
// MVP-001 S11 pass 2B: the workspace reads migration follows pass 2A
// (registered as sequence 71 and checked here). The SURF checks prove its
// six reads of the participants' own records (MBS sections 18.2, 18.3 and
// 18.6): functions only (the catalog still equals the catalog after pass 1),
// security definer, stable, executable by authenticated only and taking no
// identifier; the client's payment history and account overview, the
// participants' Message threads, the attorney's ended Consultations,
// documents and compliance records, each own-data only with exactly its
// minimum columns, equal to owner queries and to the earlier reads whose rule
// it reuses, and answering nothing to another participant, staff, a caller
// without a User, an attorney at aal1 or without claims, anon or
// service_role. SURF-8 (correction D14) runs the application's own center and
// job-context readers on the S11 notification types as the database
// serializes them. The JSON report goes to stdout; exit 0 means PASS, 1 FAIL,
// 2 cleanup failure.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// MVP-001 S11 pass 2B (correction D14): the application's own strict readers
// of the notification center and the delivery job context, run on rows the
// database itself serializes (as PostgREST does).
import { resolveClientNotifications } from "../src/application/notification-center.ts";
import { notificationJobContextOf } from "../src/application/notifications.ts";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54348;
const DB = "rosuno_s11_operations_proof";
const PROD_DB = "rosuno_s11_operations_proof_production";
const BASE_DB = "rosuno_s11_operations_proof_base";
const PRODUCTION_REF = "syntheticelevenopsrz";
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
// MVP-001 S11 pass 2B: the participants' workspace reads follow pass 2A
// (registered and checked here, by the SURF checks).
const S11_SURFACES_MIGRATIONS = Object.freeze([
  "20261127170000_mvp_001_s11_workspace_reads.sql",
]);
// MVP-001 S11 review corrections follow pass 2B (registered and checked
// here, by the CORR checks).
const S11_CORRECTIONS_MIGRATIONS = Object.freeze([
  "20261127180000_mvp_001_s11_review_corrections.sql",
]);
// The one migration that inserts catalog rows (the five capability codes) and
// the one that creates a relation (the PS section 21.1 reviews relation).
const S11_INTEGRITY = "20261127010000_mvp_001_s11_completion_integrity.sql";
const S11_REVIEWS = "20261127040000_mvp_001_s11_reviews.sql";

const report = {
  proof:
    "MVP-001 S11 operations and administration disposable local PostgreSQL proof",
  migrations: {},
  checks: [],
  concurrency: {},
  cluster: {},
};
let state = null;
// MVP-001 S11 pass 2B: the notices of the workspace reads migration (kept
// apart from the pass 2A notices, which MIG-1 compares exactly).
const surfaceNotices = {};
// MVP-001 S11 review corrections: the notices of the correction migration.
const correctionNotices = {};

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
    path.join(os.tmpdir(), "rosuno-mvp-001-s11-operations-db-proof-"),
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
    if (S11_OPERATIONS_MIGRATIONS.includes(file)) {
      notices[file] = [...result.stderr.matchAll(/NOTICE:\s+(.*)/g)].map(
        (match) => match[1],
      );
    }
    if (S11_CORRECTIONS_MIGRATIONS.includes(file)) {
      correctionNotices[file] = [
        ...result.stderr.matchAll(/NOTICE:\s+(.*)/g),
      ].map((match) => match[1]);
    }
    if (S11_SURFACES_MIGRATIONS.includes(file)) {
      surfaceNotices[file] = [...result.stderr.matchAll(/NOTICE:\s+(.*)/g)].map(
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
  // The nine pass 2 migrations follow pass 1 and are registered unreviewed
  // (sequences 62 to 70, each depending on the one before it) and applied
  // nowhere.
  S11_OPERATIONS_MIGRATIONS.forEach((file, index) => {
    const id = file.replace(/\.sql$/, "");
    const row = registered.find(
      (migration) => migration.artifact_path === `supabase/migrations/${file}`,
    );
    assert.ok(row, `${file} is registered`);
    assert.equal(row.migration_id, id);
    assert.equal(row.sequence, 62 + index);
    assert.equal(row.reviewed, false);
    assert.equal(row.applied_environment, "none");
    assert.deepEqual(row.depends_on, [
      (index === 0
        ? S11_MIGRATIONS[S11_MIGRATIONS.length - 1]
        : S11_OPERATIONS_MIGRATIONS[index - 1]
      ).replace(/\.sql$/, ""),
    ]);
    assert.ok(
      typeof row.rollback_plan === "string" && row.rollback_plan !== "",
    );
    assert.ok(program.migration_refs.includes(id), `${id} is a Program ref`);
  });
  // MVP-001 S11 pass 2B: the workspace reads follow pass 2A and are
  // registered unreviewed (sequence 71, depending on the last pass 2A
  // migration) and applied nowhere.
  S11_SURFACES_MIGRATIONS.forEach((file, index) => {
    const id = file.replace(/\.sql$/, "");
    const row = registered.find(
      (migration) => migration.artifact_path === `supabase/migrations/${file}`,
    );
    assert.ok(row, `${file} is registered`);
    assert.equal(row.migration_id, id);
    assert.equal(row.sequence, 71 + index);
    assert.equal(row.reviewed, false);
    assert.equal(row.applied_environment, "none");
    assert.deepEqual(row.depends_on, [
      (index === 0
        ? S11_OPERATIONS_MIGRATIONS[S11_OPERATIONS_MIGRATIONS.length - 1]
        : S11_SURFACES_MIGRATIONS[index - 1]
      ).replace(/\.sql$/, ""),
    ]);
    assert.ok(
      typeof row.rollback_plan === "string" && row.rollback_plan !== "",
    );
    assert.ok(program.migration_refs.includes(id), `${id} is a Program ref`);
  });
  // MVP-001 S11 review corrections: the correction migration follows pass 2B
  // and is registered unreviewed (sequence 72, depending on the pass 2B
  // migration) and applied nowhere.
  S11_CORRECTIONS_MIGRATIONS.forEach((file, index) => {
    const id = file.replace(/\.sql$/, "");
    const row = registered.find(
      (migration) => migration.artifact_path === `supabase/migrations/${file}`,
    );
    assert.ok(row, `${file} is registered`);
    assert.equal(row.migration_id, id);
    assert.equal(row.sequence, 72 + index);
    assert.equal(row.reviewed, false);
    assert.equal(row.applied_environment, "none");
    assert.deepEqual(row.depends_on, [
      (index === 0
        ? S11_SURFACES_MIGRATIONS[S11_SURFACES_MIGRATIONS.length - 1]
        : S11_CORRECTIONS_MIGRATIONS[index - 1]
      ).replace(/\.sql$/, ""),
    ]);
    assert.ok(
      typeof row.rollback_plan === "string" && row.rollback_plan !== "",
    );
    assert.ok(program.migration_refs.includes(id), `${id} is a Program ref`);
  });
  sql(ROLES, "postgres");
  sql(fixtureFor(DB), "postgres");
  sql(fixtureFor(PROD_DB), "postgres");
  sql(fixtureFor(BASE_DB), "postgres");
  assert.equal(
    sql("select count(*) from pg_available_extensions where name = 'pg_cron';"),
    "0",
    "this disposable cluster has no pg_cron",
  );
  report.migrations.notices = applyMigrationsTo(DB, files);
  applyMigrationsTo(PROD_DB, files);
  applyMigrationsTo(
    BASE_DB,
    files.slice(
      0,
      files.indexOf(S11_MIGRATIONS[S11_MIGRATIONS.length - 1]) + 1,
    ),
  );
  report.migrations.applied = files.length;
  report.migrations.s11 = [...S11_MIGRATIONS];
  report.migrations.s11_operations = [...S11_OPERATIONS_MIGRATIONS];
  report.migrations.s11_surfaces = [...S11_SURFACES_MIGRATIONS];
  report.migrations.surface_notices = surfaceNotices;
  report.migrations.s11_corrections = [...S11_CORRECTIONS_MIGRATIONS];
  report.migrations.correction_notices = correctionNotices;
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
    process.stderr.write(`[s11-ops-proof] PASS ${name}\n`);
  } catch (error) {
    failed = true;
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
    process.stderr.write(
      `[s11-ops-proof] FAIL ${name}\n${error?.stack ?? error}\n`,
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
// S11 pass 2 helpers
// ---------------------------------------------------------------------------

const OPS_INTEGRITY = "20261127080000_mvp_001_s11_operations_integrity.sql";
const OPS_ATTORNEY = "20261127110000_mvp_001_s11_attorney_operations.sql";

function seedOperations() {
  world.auditor = staffWith(["view_audit_events", null]);
  world.auditorS = staffWith(["view_audit_events", world.J.S]);
  world.operator = staffWith(["view_operations", null]);
  world.operatorS = staffWith(["view_operations", world.J.S]);
  world.referralViewer = staffWith(["view_referral_operations", null]);
  world.referralViewerS = staffWith(["view_referral_operations", world.J.S]);
  world.clientAdmin = staffWith(["manage_client_accounts", null]);
  world.clientAdminB = staffWith(["manage_client_accounts", null]);
  world.clientAdminS = staffWith(["manage_client_accounts", world.J.S]);
  world.verifier = staffWith(["manage_attorney_verification", null]);
  world.verifierB = staffWith(["manage_attorney_verification", null]);
  world.verifierS = staffWith(["manage_attorney_verification", world.J.S]);
  world.complianceB = staffWith(["manage_compliance_reviews", null]);
  world.policyS = staffWith(["manage_policy_configuration", world.J.S]);
  world.financeS = staffWith(["manage_financial_operations", world.J.S]);
  world.everything = staffWith(
    ["manage_attorney_verification", null],
    ["manage_compliance_reviews", null],
    ["manage_complaints", null],
    ["manage_legal_holds", null],
    ["manage_policy_configuration", null],
  );
}

const API = Object.freeze({ anon: null, service_role: null });

// The SQLSTATE of a direct call by anon and by service_role.
const apiRefusals = (statement) =>
  Object.fromEntries(
    Object.keys(API).map((role) => [role, as(role, null, statement)]),
  );

const AUDIT_SQL = (f = {}, offset = 0) =>
  `select row_to_json(x)::text from public.staff_audit_events(${f.from ? `${lit(f.from)}::timestamptz` : "null"}, ${f.until ? `${lit(f.until)}::timestamptz` : "null"}, ${lit(f.action ?? null)}::text, ${lit(f.resourceType ?? null)}::text, ${f.resourceId ? `${lit(f.resourceId)}::uuid` : "null"}, ${lit(f.performerType ?? null)}::text, ${f.performerId ? `${lit(f.performerId)}::uuid` : "null"}, ${f.security ? "true" : "false"}, ${offset}) x;`;
const AUDIT_ONE_SQL = (id) =>
  `select row_to_json(x)::text from public.staff_audit_event(${lit(id)}::uuid) x;`;
const auditList = (staff, filters, offset = 0, options = {}) =>
  rowsJson(staff, AUDIT_SQL(filters, offset), options);

// One planted audit event (owner; synthetic data only).
function plantAudit({
  action = "synthetic.audit_probe",
  resourceType = "synthetic_probe",
  resourceId = uid(),
  jurisdiction = null,
  actorType = "system",
  actor = null,
  ago = 60,
  before = null,
  after = null,
} = {}) {
  const id = uid();
  sql(
    `insert into public.audit_events (id, actor_user_id, actor_type, action_code, resource_type, resource_id, before_snapshot, after_snapshot, reason_code, policy_references, jurisdiction_id, occurred_at)
     values ('${id}', ${lit(actor)}, ${lit(actorType)}, ${lit(action)}, ${lit(resourceType)}, ${lit(resourceId)}, ${before === null ? "null" : `${lit(before)}::jsonb`}, ${after === null ? "null" : `${lit(after)}::jsonb`}, null, null, ${lit(jurisdiction)}, now() - interval '${ago} seconds');`,
  );
  return id;
}

const viewedCount = (staff, action = "audit_events.viewed") =>
  count(
    "audit_events",
    `action_code = '${action}' and actor_user_id = '${staff.user}'`,
  );

const OPS_SQL =
  "select row_to_json(x)::text from public.staff_operations_summary() x;";
const opsRows = (staff, options = {}) => rowsJson(staff, OPS_SQL, options);

const COMPLIANCE_SUMMARY_SQL =
  "select row_to_json(x)::text from public.staff_compliance_summary() x;";
const RECORDS_SQL = (section, offset = 0) =>
  `select row_to_json(x)::text from public.staff_compliance_records(${lit(section)}, ${offset}) x;`;
const POLICY_CHANGES_SQL = (offset = 0) =>
  `select row_to_json(x)::text from public.staff_policy_changes(${offset}) x;`;

const LIFE_SQL = (attorneyId, intent, note) =>
  `select public.staff_change_attorney_lifecycle(${lit(attorneyId)}::uuid, ${lit(intent)}::text, ${lit(note)}::text);`;
const STAGE_SQL = (attorneyId, intent, note = null, message = null) =>
  `select public.staff_change_profile_stage(${lit(attorneyId)}::uuid, ${lit(intent)}::text, ${lit(message)}::text, ${lit(note)}::text);`;
const PROFILE_SQL = (attorneyId) =>
  `select row_to_json(x)::text from public.staff_attorney_profile(${lit(attorneyId)}::uuid) x;`;

const lifecycle = (
  staff,
  attorneyId,
  intent,
  note = "Synthetic staff note",
  options = {},
) => asStaff(staff, LIFE_SQL(attorneyId, intent, note), options);
const stage = (staff, attorneyId, intent, note = null, options = {}) =>
  asStaff(staff, STAGE_SQL(attorneyId, intent, note), options);
const profileState = (attorneyId) =>
  sql(
    `select profile_state from public.attorney_profiles where id = '${attorneyId}';`,
  );

const CLIENTS_SQL = (state = null, offset = 0) =>
  `select row_to_json(x)::text from public.staff_clients(${lit(state)}::text, ${offset}) x;`;
const CLIENT_SQL = (id) =>
  `select row_to_json(x)::text from public.staff_client(${lit(id)}::uuid) x;`;
const ACCOUNT_SQL = (id, intent, note) =>
  `select public.staff_change_client_account(${lit(id)}::uuid, ${lit(intent)}::text, ${lit(note)}::text);`;
const changeAccount = (
  staff,
  userId,
  intent,
  note = "Synthetic staff note",
  options = {},
) => asStaff(staff, ACCOUNT_SQL(userId, intent, note), options);
const accountState = (userId) =>
  sql(`select account_state from public.users where id = '${userId}';`);

const REFERRALS_SQL = (offset = 0) =>
  `select row_to_json(x)::text from public.staff_referrals(${offset}) x;`;
const REFERRAL_COUNTS_SQL =
  "select row_to_json(x)::text from public.staff_referral_counts() x;";
const FINANCE_SQL = (from, until, jurisdiction = null) =>
  `select row_to_json(x)::text from public.staff_finance_summary(${from === null ? "null" : `${lit(from)}::timestamptz`}, ${until === null ? "null" : `${lit(until)}::timestamptz`}, ${lit(jurisdiction)}::uuid) x;`;
const MODES_SQL = (jurisdiction) =>
  `select row_to_json(x)::text from public.staff_jurisdiction_regulatory_modes(${lit(jurisdiction)}::uuid) x;`;
const NAMES_SQL =
  "select row_to_json(x)::text from public.staff_jurisdiction_names() x;";

// An attorney profile at a given stage with one licence (owner fixture).
function profileWith({ stage: state = "approved", licences = [] } = {}) {
  const account = newAccount();
  const profile = uid();
  sql(
    `insert into public.attorney_profiles (id, user_id, profile_state, display_name) values ('${profile}', '${account.user}', '${state}', 'Synthetic Profile ${profile.slice(0, 6)}');`,
  );
  const ids = [];
  for (const [jurisdiction, number, until = null] of licences) {
    const licence = uid();
    sql(
      `insert into public.licenses (id, attorney_id, jurisdiction_id, license_number, effective_until) values ('${licence}', '${profile}', '${jurisdiction}', ${lit(number)}, ${lit(until)}::date);`,
    );
    ids.push(licence);
  }
  return { ...account, profile, licences: ids };
}

const SAVE_LICENSE_SQL = (jurisdiction, number) =>
  `select public.attorney_save_license_claim(null, null, ${lit(jurisdiction)}::uuid, ${lit(number)}, null, null, null);`;
const SUBMIT_SQL = "select public.attorney_submit_application();";

const rejoinItems = (profile) =>
  jsonOf(
    `select coalesce(json_agg(json_build_object('id', id, 'status', status, 'severity', severity, 'source_type', source_type, 'canonical_type', canonical_type, 'evidence', evidence_reference) order by detected_at, id), '[]'::json)::text from public.reconciliation_exceptions where exception_type = 'rejoin_review' and source_id = '${profile}';`,
  );

const RESOLVE_SQL = (id, notes = "Synthetic resolution notes") =>
  `select public.staff_resolve_reconciliation_exception(${lit(id)}::uuid, ${lit(notes)});`;

// Every row of a family's open review items for a holder (all pages).
function familyItemIds(staff, family, status = "open") {
  const ids = [];
  for (let offset = 0; offset < 2000; offset += 25) {
    const rows = rowsJson(
      staff,
      `select row_to_json(x)::text from public.staff_review_exceptions(${lit(family)}, ${lit(status)}, ${offset}) x;`,
    );
    ids.push(...rows.slice(0, 25).map((r) => r.exception_id));
    if (rows.length <= 25) {
      break;
    }
  }
  return ids;
}

// The rows of one table of a matter, for "nothing else changed".
const tableRows = (table, where) =>
  jsonOf(
    `select coalesce(json_agg(row_to_json(t) order by t.id), '[]'::json)::text from public.${table} t where ${where};`,
  );

// ---------------------------------------------------------------------------
// MIG and PRIV: migrations, the unchanged physical model and privileges
// ---------------------------------------------------------------------------

const OPS_AUTHENTICATED_API = Object.freeze([
  "staff_audit_events(timestamp with time zone, timestamp with time zone, text, text, uuid, text, uuid, boolean, integer)",
  "staff_audit_event(uuid)",
  "staff_operations_summary()",
  "staff_change_attorney_lifecycle(uuid, text, text)",
  "staff_compliance_summary()",
  "staff_compliance_records(text, integer)",
  "staff_attorney_profile(uuid)",
  "staff_policy_changes(integer)",
  "staff_clients(text, integer)",
  "staff_client(uuid)",
  "staff_change_client_account(uuid, text, text)",
  "staff_referrals(integer)",
  "staff_referral_counts()",
  "staff_finance_summary(timestamp with time zone, timestamp with time zone, uuid)",
  "staff_jurisdiction_names()",
  "staff_jurisdiction_regulatory_modes(uuid)",
]);

// Earlier API functions replaced forward: their executors are unchanged.
const OPS_REPLACED_API = Object.freeze({
  "staff_change_profile_stage(uuid, text, text, text)": "authenticated",
  "attorney_consultation_offer_options()": "authenticated",
  "public_attorney_profile(uuid, uuid)": "anon,authenticated",
});

const OPS_INTERNAL = Object.freeze([
  "exception_family(text)",
  "audit_view_scope()",
  "audit_security_action_codes()",
  "audit_filter_code_valid(text, boolean)",
  "license_number_normalized(text)",
  "attorney_rejoin_detect(uuid)",
  "attorney_rejoin_review_open(uuid)",
  "attorney_rejoin_license_saved()",
  "attorney_rejoin_application_submitted()",
  "compliance_profile_visible(uuid)",
  "client_account_rows(uuid, text, integer, integer)",
  "eligibility_parameters_valid(jsonb)",
  "policy_optional_whole_within(jsonb, text, numeric, numeric)",
  "policy_parameters_approvable(text, uuid, jsonb)",
  "pricing_quote(uuid, uuid, text, integer, timestamp with time zone)",
  "request_response_window(uuid, text, timestamp with time zone)",
  "request_message_limit(uuid)",
  "consultation_timing_policy(uuid, timestamp with time zone)",
  "payment_capture_gate_problem(payment_transactions)",
  "payment_confirm_authorization(payment_transactions, text, bigint, text, text, uuid, text)",
  "discovery_presented_set(uuid, uuid, text, uuid)",
  "discovery_jurisdiction_listed(uuid)",
]);

const D8_FUNCTIONS = Object.freeze([
  "client_create_intake()",
  "client_intake_practice_areas()",
  "client_intake_jurisdictions()",
  "staff_publish_intake_question_set(text, jsonb)",
  "rosuno_environment_class()",
  "rosuno_environment_status()",
  "deployment_environment_identity()",
  "policy_select_version(text, uuid, uuid, timestamp with time zone)",
  "capability_admin_may_read_user(uuid)",
  "production_financial_gate(uuid, text, uuid, timestamp with time zone)",
  "has_manage_attorney_verification_scope(uuid, boolean)",
  "has_staff_capability(text, uuid, boolean)",
  "client_save_intake_revision(uuid, integer, uuid, uuid, text, jsonb)",
  "client_submit_intake(uuid, integer)",
  "client_close_intake(uuid)",
]);

const opsExecutors = (signature, db = DB) =>
  sql(
    `select coalesce(string_agg(r.rolname, ',' order by r.rolname), '') from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') and has_function_privilege(r.rolname, 'public.${signature}', 'execute');`,
    db,
  );

// One catalog listing, for the before/after comparison.
const CATALOG_QUERIES = Object.freeze({
  relations:
    "select coalesce(string_agg(relkind::text || ':' || relname, ',' order by relname), '') from pg_class where relnamespace = 'public'::regnamespace;",
  columns:
    "select coalesce(string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' order by table_name, ordinal_position), '') from information_schema.columns where table_schema = 'public';",
  constraints:
    "select coalesce(string_agg(conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid), ',' order by conrelid::regclass::text, conname), '') from pg_constraint where connamespace = 'public'::regnamespace;",
  indexes:
    "select coalesce(string_agg(indexdef, ',' order by indexname), '') from pg_indexes where schemaname = 'public';",
  policies:
    "select coalesce(string_agg(tablename || '.' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ',' order by tablename, policyname), '') from pg_policies where schemaname = 'public';",
  types:
    "select coalesce(string_agg(typname, ',' order by typname), '') from pg_type where typnamespace = 'public'::regnamespace;",
  policy_types:
    "select coalesce(string_agg(code, ',' order by code), '') from public.policy_types;",
  table_grants:
    "select coalesce(string_agg(table_name || ':' || grantee || ':' || privilege_type, ',' order by table_name, grantee, privilege_type), '') from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role');",
});

const triggersOf = (db) =>
  sql(
    "select coalesce(string_agg(c.relname || '.' || t.tgname, ',' order by c.relname, t.tgname), '') from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relnamespace = 'public'::regnamespace;",
    db,
  ).split(",");

async function opsMigrationChecks() {
  await check(
    "MIG-1 the nine S11 pass 2 migrations follow the seven pass 1 migrations in order, are registered unreviewed (sequences 62 to 70, each depending on the one before it, each with a rollback plan) and applied nowhere, are Program migration refs, and apply on plain PostgreSQL to a development and a production-class database without notices",
    () => {
      assert.deepEqual(report.migrations.s11_operations, [
        ...S11_OPERATIONS_MIGRATIONS,
      ]);
      assert.deepEqual(
        report.migrations.notices,
        Object.fromEntries(S11_OPERATIONS_MIGRATIONS.map((file) => [file, []])),
      );
      return report.migrations.notices;
    },
  );

  await check(
    "MIG-2 (Packet rules 8 and 16) no relation, column, type, constraint, index, row policy, policy type or table grant is added: the catalog after the nine migrations equals the catalog after pass 1 in every one of those listings; the triggers are exactly the earlier ones plus the two rejoin detection triggers; the texts create no table, column, type, policy, view, sequence or index and insert into no catalog table except the four capability codes of the operations-integrity migration",
    () => {
      const differences = {};
      for (const [name, query] of Object.entries(CATALOG_QUERIES)) {
        const before = sql(query, BASE_DB);
        const after = sql(query);
        if (before !== after) {
          differences[name] = true;
        }
      }
      assert.deepEqual(differences, {});
      const before = new Set(triggersOf(BASE_DB));
      const added = triggersOf(DB).filter((t) => !before.has(t));
      assert.deepEqual(added, [
        "attorney_profiles.attorney_profiles_rejoin_detection",
        "licenses.licenses_rejoin_detection",
      ]);
      assert.equal(triggersOf(DB).length, before.size + 2);
      const admittedCatalog =
        "insert into public.capability_definitions (capability_code)";
      for (const file of S11_OPERATIONS_MIGRATIONS) {
        const raw = fs
          .readFileSync(path.join(MIGRATIONS, file), "utf8")
          .replace(/--[^\n]*/g, "");
        let text = raw;
        if (file === OPS_INTEGRITY) {
          assert.equal(raw.split(admittedCatalog).length, 2, file);
          text = text.replace(admittedCatalog, "");
        }
        assert.doesNotMatch(
          text,
          /create\s+table|add\s+column|create\s+type|create\s+policy|create\s+view|create\s+sequence|create\s+(unique\s+)?index|alter\s+table|insert\s+into\s+public\.(policy_types|policy_versions|capability_definitions|capability_grants|deployment_environment|jurisdictions|practice_areas|regulatory_modes)/i,
          file,
        );
      }
      return {
        listings_compared: Object.keys(CATALOG_QUERIES),
        triggers_added: added,
      };
    },
  );

  await check(
    "CAP-1 (PS section 5.1) the capability catalog gains exactly view_audit_events, view_operations, view_referral_operations and manage_client_accounts; the migrations insert no grant and no business row (the production-class database holds no grant)",
    () => {
      const catalog = (db) =>
        sql(
          "select string_agg(capability_code, ',' order by capability_code) from public.capability_definitions;",
          db,
        ).split(",");
      const before = new Set(catalog(BASE_DB));
      assert.deepEqual(
        catalog(PROD_DB).filter((c) => !before.has(c)),
        [
          "manage_client_accounts",
          "view_audit_events",
          "view_operations",
          "view_referral_operations",
        ],
      );
      assert.equal(
        sql("select count(*) from public.capability_grants;", PROD_DB),
        "0",
      );
      return { added: 4 };
    },
  );

  await check(
    "PRIV-1 function privileges: every new staff read and command is security definer, pins search_path pg_catalog, pg_temp and is executable by authenticated only (the volatile ones also bound their lock waits at 3s); the replaced earlier API functions keep exactly their executors; every internal, guard, trigger and replaced internal function is executable by no API role; the functions the nine migrations create or replace are exactly these lists",
    () => {
      const detail = {};
      for (const signature of OPS_AUTHENTICATED_API) {
        assert.equal(opsExecutors(signature), "authenticated", signature);
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
      for (const [signature, roles] of Object.entries(OPS_REPLACED_API)) {
        assert.equal(opsExecutors(signature), roles, signature);
      }
      for (const signature of OPS_INTERNAL) {
        assert.equal(opsExecutors(signature), "", signature);
      }
      const created = new Set();
      for (const file of S11_OPERATIONS_MIGRATIONS) {
        const text = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
        for (const match of text.matchAll(
          /^create (?:or replace )?function public\.([a-z_0-9]+)\(/gm,
        )) {
          created.add(match[1]);
        }
      }
      const listed = new Set(
        [
          ...OPS_AUTHENTICATED_API,
          ...Object.keys(OPS_REPLACED_API),
          ...OPS_INTERNAL,
        ].map((signature) => signature.slice(0, signature.indexOf("("))),
      );
      assert.deepEqual([...created].sort(), [...listed].sort());
      return detail;
    },
  );

  await check(
    "PRIV-2 (PS section 25: audit events are never client-writable) anon and authenticated hold no privilege on audit_events and a direct insert, update or delete by either is refused (42501); service_role keeps the P1 INSERT and SELECT grant, which the m4 AUD-1 and P3-904 PRIV-2 proofs pin (recorded, not revoked), and still cannot update or delete an audit row (42501); every application audit row of pass 2 is written inside a security definer function",
    () => {
      const privileges = {};
      for (const role of ["anon", "authenticated", "service_role"]) {
        privileges[role] = [
          "SELECT",
          "INSERT",
          "UPDATE",
          "DELETE",
          "TRUNCATE",
        ].filter(
          (p) =>
            sql(
              `select has_table_privilege('${role}', 'public.audit_events', '${p}');`,
            ) === "t",
        );
      }
      assert.deepEqual(privileges, {
        anon: [],
        authenticated: [],
        service_role: ["SELECT", "INSERT"],
      });
      const insert =
        "insert into public.audit_events (actor_type, action_code, resource_type, occurred_at) values ('client', 'synthetic.direct', 'synthetic', now());";
      const codes = {
        anon_insert: as("anon", null, insert),
        authenticated_insert: as("authenticated", world.ann.auth, insert),
        authenticated_update: as(
          "authenticated",
          world.ann.auth,
          "update public.audit_events set action_code = 'x';",
        ),
        authenticated_delete: as(
          "authenticated",
          world.ann.auth,
          "delete from public.audit_events;",
        ),
        service_role_update: as(
          "service_role",
          null,
          "update public.audit_events set action_code = 'x';",
        ),
        service_role_delete: as(
          "service_role",
          null,
          "delete from public.audit_events;",
        ),
      };
      for (const code of Object.values(codes)) {
        assert.equal(code, "ERROR 42501");
      }
      return { privileges, codes };
    },
  );

  await check(
    "D8 (correction: PS section 30.5) the fifteen security definer functions that set search_path pg_catalog alone now set pg_catalog, pg_temp, with their bodies, owners and privileges otherwise unchanged; no security definer function in the public schema has a search_path without pg_temp",
    () => {
      for (const signature of D8_FUNCTIONS) {
        assert.equal(
          sql(
            `select prosecdef::text || '|' || array_to_string(proconfig, ';') || '|' || pg_get_userbyid(proowner) from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          "true|search_path=pg_catalog, pg_temp|postgres",
          signature,
        );
        assert.equal(
          sql(
            `select md5(prosrc) || '|' || coalesce(proacl::text, '') from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          sql(
            `select md5(prosrc) || '|' || coalesce(proacl::text, '') from pg_proc where oid = 'public.${signature}'::regprocedure;`,
            BASE_DB,
          ),
          signature,
        );
      }
      assert.equal(
        sql(
          "select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) c where c like 'search_path=%pg_temp%');",
        ),
        "0",
      );
      return { functions: D8_FUNCTIONS.length };
    },
  );
}

// ---------------------------------------------------------------------------
// AUD: the audit workspace
// ---------------------------------------------------------------------------

async function auditChecks() {
  const probe = {};
  await check(
    "AUD-1 (TA section 41; PS section 30.4) scope: a global view_audit_events grant reads the events of every jurisdiction and those without one; a grant scoped to one jurisdiction reads only that jurisdiction's events (none without a jurisdiction); aal1, a staff member without the capability and a holder of another capability read nothing; anon and service_role cannot execute the reads (42501)",
    () => {
      const resourceType = `synthetic_scope_${uid().slice(0, 6)}`;
      probe.s = plantAudit({ resourceType, jurisdiction: world.J.S, ago: 30 });
      probe.c = plantAudit({ resourceType, jurisdiction: world.J.C, ago: 20 });
      probe.none = plantAudit({
        resourceType,
        ago: 10,
        before: { synthetic_state: "before" },
        after: { synthetic_state: "after", nested: { list: [1, 2.5] } },
      });
      const ids = (rows) => rows.map((r) => r.audit_event_id);
      const global = auditList(world.auditor, { resourceType });
      assert.deepEqual(ids(global), [probe.none, probe.c, probe.s]);
      assert.deepEqual(ids(auditList(world.auditorS, { resourceType })), [
        probe.s,
      ]);
      assert.deepEqual(auditList(world.auditor, { resourceType }, 0, AAL1), []);
      assert.deepEqual(auditList(world.plainStaff, { resourceType }), []);
      assert.deepEqual(auditList(world.operator, { resourceType }), []);
      assert.deepEqual(apiRefusals(AUDIT_SQL({ resourceType })), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      assert.deepEqual(apiRefusals(AUDIT_ONE_SQL(probe.s)), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      // The list carries identifiers, codes and times only.
      assert.equal(
        keysOf(global[0]),
        "action_code,actor_type,actor_user_id,audit_event_id,jurisdiction_id,occurred_at,reason_code,resource_id,resource_type",
      );
      return { global: global.length, scoped: 1 };
    },
  );

  await check(
    "AUD-2 one event with its recorded snapshots exactly as stored, for a holder covering it; a scoped holder reading another jurisdiction's event or one without a jurisdiction, an unknown identifier and a staff member without the capability all read nothing (no existence oracle)",
    () => {
      const one = rowsJson(world.auditor, AUDIT_ONE_SQL(probe.none));
      assert.equal(one.length, 1);
      assert.deepEqual(one[0].before_snapshot, { synthetic_state: "before" });
      assert.deepEqual(one[0].after_snapshot, {
        synthetic_state: "after",
        nested: { list: [1, 2.5] },
      });
      assert.equal(
        keysOf(one[0]),
        "action_code,actor_type,actor_user_id,after_snapshot,audit_event_id,before_snapshot,created_at,jurisdiction_id,occurred_at,policy_references,reason_code,resource_id,resource_type",
      );
      assert.equal(rowsJson(world.auditorS, AUDIT_ONE_SQL(probe.s)).length, 1);
      for (const id of [probe.c, probe.none, uid()]) {
        assert.deepEqual(rowsJson(world.auditorS, AUDIT_ONE_SQL(id)), []);
      }
      assert.deepEqual(rowsJson(world.auditor, AUDIT_ONE_SQL(uid())), []);
      assert.deepEqual(rowsJson(world.plainStaff, AUDIT_ONE_SQL(probe.s)), []);
      return { snapshot_keys: Object.keys(one[0].after_snapshot) };
    },
  );

  await check(
    "AUD-3 filters and paging: newest first by occurrence; the time range [from, until), the action code, the resource type and identifier, the performer type and User each narrow the page exactly; pages hold 25 rows plus one that says another page follows; a malformed filter (an end not after the start, a malformed code) answers nothing",
    () => {
      const resourceType = `synthetic_paging_${uid().slice(0, 6)}`;
      const planted = [];
      for (let i = 0; i < 30; i += 1) {
        planted.push(
          plantAudit({
            resourceType,
            ago: 600 + i * 10,
            actorType: i % 2 === 0 ? "staff" : "system",
            actor: i % 2 === 0 ? world.verifier.user : null,
            action: i < 5 ? "synthetic.audit_special" : "synthetic.audit_probe",
          }),
        );
      }
      const page1 = auditList(world.auditor, { resourceType }, 0);
      const page2 = auditList(world.auditor, { resourceType }, 25);
      assert.equal(page1.length, 26);
      assert.equal(page2.length, 5);
      assert.deepEqual(
        [...page1.slice(0, 25), ...page2].map((r) => r.audit_event_id),
        planted,
      );
      const times = page1.map((r) => ms(r.occurred_at));
      assert.deepEqual(
        times,
        [...times].sort((a, b) => b - a),
      );
      const isoAgoText = (s) => new Date(Date.now() - s * 1000).toISOString();
      const ranged = auditList(world.auditor, {
        resourceType,
        from: isoAgoText(700),
        until: isoAgoText(640),
      });
      assert.ok(
        ranged.length >= 5 && ranged.length <= 7,
        String(ranged.length),
      );
      assert.ok(
        ranged.every(
          (r) =>
            ms(r.occurred_at) >= Date.now() - 700000 - 5000 &&
            ms(r.occurred_at) < Date.now() - 640000 + 5000,
        ),
      );
      assert.equal(
        auditList(world.auditor, {
          resourceType,
          action: "synthetic.audit_special",
        }).length,
        5,
      );
      assert.equal(
        auditList(world.auditor, { resourceType, performerType: "staff" })
          .length,
        15,
      );
      assert.equal(
        auditList(world.auditor, {
          resourceType,
          performerId: world.verifier.user,
        }).length,
        15,
      );
      const target = sql(
        `select resource_id from public.audit_events where id = '${planted[3]}';`,
      );
      assert.deepEqual(
        auditList(world.auditor, { resourceType, resourceId: target }).map(
          (r) => r.audit_event_id,
        ),
        [planted[3]],
      );
      const before = viewedCount(world.auditor);
      for (const filters of [
        { from: isoAgoText(10), until: isoAgoText(20) },
        { action: "Bad Code" },
        { resourceType: "bad-type" },
        { performerType: "x y" },
      ]) {
        assert.deepEqual(auditList(world.auditor, filters), []);
      }
      assert.equal(viewedCount(world.auditor), before);
      return {
        page1: page1.length,
        page2: page2.length,
        ranged: ranged.length,
      };
    },
  );

  await check(
    "AUD-4 (TA section 40) every read by a holder is itself audited once: audit_events.viewed with the filter facts, the offset, the number of rows and the scope kind, and audit_event.viewed with the requested identifier; never a snapshot or any content of the events read; reads refused for lack of capability or aal2 write nothing",
    () => {
      const before = viewedCount(world.auditor);
      auditList(world.auditor, {
        resourceType: "synthetic_probe",
        security: false,
      });
      assert.equal(viewedCount(world.auditor), before + 1);
      const row = jsonOf(
        `select json_build_object('resource_type', resource_type, 'resource_id', resource_id, 'jurisdiction_id', jurisdiction_id, 'after', after_snapshot, 'before', before_snapshot)::text from public.audit_events where action_code = 'audit_events.viewed' and actor_user_id = '${world.auditor.user}' order by occurred_at desc, id desc limit 1;`,
      );
      assert.equal(row.resource_type, "audit_events");
      assert.equal(row.resource_id, null);
      assert.equal(row.jurisdiction_id, null);
      assert.equal(row.before, null);
      assert.deepEqual(Object.keys(row.after).sort(), [
        "filters",
        "offset",
        "rows",
        "scope",
      ]);
      assert.deepEqual(row.after.filters, {
        resource_type: "synthetic_probe",
        security_only: false,
      });
      assert.equal(row.after.scope, "global");
      const detailBefore = viewedCount(world.auditorS, "audit_event.viewed");
      rowsJson(world.auditorS, AUDIT_ONE_SQL(probe.c));
      assert.equal(
        viewedCount(world.auditorS, "audit_event.viewed"),
        detailBefore + 1,
      );
      const detail = jsonOf(
        `select json_build_object('resource_id', resource_id, 'after', after_snapshot)::text from public.audit_events where action_code = 'audit_event.viewed' and actor_user_id = '${world.auditorS.user}' order by occurred_at desc, id desc limit 1;`,
      );
      assert.deepEqual(detail, {
        resource_id: probe.c,
        after: { rows: 0, scope: "jurisdiction" },
      });
      const total = count("audit_events");
      auditList(world.plainStaff, {});
      auditList(world.auditor, {}, 0, AAL1);
      rowsJson(world.plainStaff, AUDIT_ONE_SQL(probe.s));
      assert.equal(count("audit_events"), total);
      return { list_event: row.after, detail_event: detail.after };
    },
  );

  await check(
    "AUD-5 the security group is a fixed filter over existing action codes: only the sign-in abuse control events (security.rate_limited, security.suspicious_login, security.protection_unavailable) and the capability grant changes (capability_grant.granted, capability_grant.revoked) are answered; nothing new is stored",
    () => {
      const since = new Date(Date.now() - 120000).toISOString();
      const security = [
        plantAudit({
          action: "security.rate_limited",
          resourceType: "authentication_abuse_counter",
          resourceId: null,
          ago: 5,
        }),
        plantAudit({
          action: "capability_grant.granted",
          resourceType: "capability_grant",
          ago: 4,
        }),
      ];
      plantAudit({ action: "synthetic.not_security", ago: 3 });
      const rows = auditList(world.auditor, { from: since, security: true });
      const codes = new Set(rows.map((r) => r.action_code));
      for (const code of codes) {
        assert.ok(
          [
            "security.rate_limited",
            "security.suspicious_login",
            "security.protection_unavailable",
            "capability_grant.granted",
            "capability_grant.revoked",
          ].includes(code),
          code,
        );
      }
      for (const id of security) {
        assert.ok(rows.some((r) => r.audit_event_id === id));
      }
      return { codes: [...codes].sort() };
    },
  );
}

// ---------------------------------------------------------------------------
// OPS: the operations dashboard
// ---------------------------------------------------------------------------

async function operationsChecks() {
  await check(
    "OPS-1 (TA section 41) the counts-only summary needs the global view_operations grant at aal2: a jurisdiction-scoped grant, aal1, a staff member without it and a holder of another capability read no row; anon and service_role cannot execute it (42501); each row is exactly (metric, dimension, value, oldest_at) and no metric names a person",
    () => {
      const rows = opsRows(world.operator);
      assert.equal(rows.length, 46);
      for (const row of rows) {
        assert.equal(keysOf(row), "dimension,metric,oldest_at,value");
      }
      assert.deepEqual(opsRows(world.operatorS), []);
      assert.deepEqual(opsRows(world.operator, AAL1), []);
      assert.deepEqual(opsRows(world.plainStaff), []);
      assert.deepEqual(opsRows(world.auditor), []);
      assert.deepEqual(apiRefusals(OPS_SQL), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      return { rows: rows.length };
    },
  );

  await check(
    "OPS-2 every count equals the planted state as an independent owner query reads it: jobs by state with the earliest due pending job, retrying and permanently failed email notifications, open review items by family and severity, ready, live and stale Consultations (a stale one planted), Requests awaiting a decision, payments in transitional states, profiles under review and jurisdictions by lifecycle state; the recorded environment is development and ok; this cluster has no scheduler, so pg_cron and every sweep answer 0",
    () => {
      staleReady("S");
      sql(
        `insert into public.operational_jobs (job_type, subject_type, subject_id, state, available_at, attempt_count, max_attempts) values ('synthetic.ops_probe', 'synthetic', '${uid()}', 'pending', now() - interval '5 minutes', 0, 3);`,
      );
      profileWith({ stage: "under_review", licences: [] });
      const rows = opsRows(world.operator);
      const value = (metric, dimension) =>
        rows.find((r) => r.metric === metric && r.dimension === dimension);
      const direct = (query) => Number(sql(query));
      for (const state of [
        "pending",
        "running",
        "completed",
        "escalated",
        "cancelled",
      ]) {
        assert.equal(
          value("jobs", state).value,
          direct(
            `select count(*) from public.operational_jobs where state = '${state}';`,
          ),
          state,
        );
      }
      assert.equal(
        value("jobs", "pending").oldest_at === null
          ? null
          : ms(value("jobs", "pending").oldest_at),
        ms(
          sql(
            "select to_json(min(available_at))#>>'{}' from public.operational_jobs where state = 'pending' and available_at <= now();",
          ),
        ),
      );
      for (const state of ["retrying", "permanently_failed"]) {
        assert.equal(
          value("notifications", state).value,
          direct(
            `select count(*) from public.notifications where channel = 'email' and state = '${state}';`,
          ),
        );
      }
      for (const family of ["financial", "compliance", "operations"]) {
        for (const severity of ["critical", "high", "medium", "low"]) {
          assert.equal(
            value("review_exceptions", `${family}.${severity}`).value,
            direct(
              `select count(*) from public.reconciliation_exceptions where status = 'open' and severity = '${severity}' and public.exception_family(exception_type) = '${family}';`,
            ),
            `${family}.${severity}`,
          );
        }
      }
      for (const state of ["ready", "live"]) {
        assert.equal(
          value("consultations", state).value,
          direct(
            `select count(*) from public.consultations where state = '${state}';`,
          ),
        );
      }
      const stale = direct(
        "select count(*) from public.consultations c join public.consultation_requests r on r.id = c.consultation_request_id left join public.bookings k on k.consultation_id = c.id and k.status = 'confirmed' cross join lateral public.consultation_outcome_window(c.id, clock_timestamp()) w where c.state in ('created', 'scheduled', 'ready', 'live') and case c.request_path when 'scheduled' then k.ends_at else coalesce(c.started_at, c.created_at) + make_interval(mins => r.requested_duration_minutes) end <= clock_timestamp() and w.closes_at <= clock_timestamp();",
      );
      assert.ok(stale >= 1);
      assert.equal(value("consultations", "stale").value, stale);
      for (const state of [
        "created",
        "payment_authorized",
        "slot_held",
        "awaiting_attorney",
      ]) {
        assert.equal(
          value("requests", state).value,
          direct(
            `select count(*) from public.consultation_requests where state = '${state}';`,
          ),
        );
      }
      for (const state of [
        "pending_authorization",
        "release_pending",
        "capture_pending",
        "refund_pending",
      ]) {
        assert.equal(
          value("payments", state).value,
          direct(
            `select count(*) from public.payment_transactions where state = '${state}';`,
          ),
        );
      }
      assert.equal(
        value("attorney_profiles", "under_review").value,
        direct(
          "select count(*) from public.attorney_profiles where profile_state = 'under_review';",
        ),
      );
      for (const state of [
        "unsupported",
        "waitlist",
        "staged",
        "ready",
        "live",
        "restricted",
        "suspended",
      ]) {
        assert.equal(
          value("jurisdictions", state).value,
          direct(
            `select count(*) from public.jurisdictions where lifecycle_state = '${state}';`,
          ),
        );
      }
      assert.equal(value("environment_class", "development").value, 1);
      assert.equal(value("environment_status", "ok").value, 1);
      assert.deepEqual(
        rows
          .filter((r) => r.metric === "scheduler")
          .map((r) => [r.dimension, r.value]),
        [
          ["pg_cron", 0],
          ["rosuno_operational_jobs_sweep", 0],
          ["rosuno_intake_expiry_sweep", 0],
          ["rosuno_scheduling_expiry_sweep", 0],
          ["rosuno_request_expiry_sweep", 0],
          ["rosuno_consultation_media_sweep", 0],
        ],
      );
      return {
        stale,
        under_review: value("attorney_profiles", "under_review").value,
        pending_jobs: value("jobs", "pending").value,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// CMPL: the compliance workspace
// ---------------------------------------------------------------------------

async function complianceChecks() {
  await check(
    "CMPL-1 each summary group only for holders of its own capability: attorney profiles by stage and waitlist members (manage_attorney_verification, by scope), open compliance review items by type (manage_compliance_reviews, global), Complaint Cases by state (manage_complaints), Legal Holds in force (manage_legal_holds, global); a staff member holding none reads nothing; a scoped verifier counts only the profiles holding a licence in its jurisdiction; counts equal owner queries",
    () => {
      const groupsOf = (staff) => [
        ...new Set(
          rowsJson(staff, COMPLIANCE_SUMMARY_SQL).map((r) => r.metric),
        ),
      ];
      assert.deepEqual(groupsOf(world.verifier), [
        "attorney_profiles",
        "waitlist",
      ]);
      assert.deepEqual(groupsOf(world.verifierS), [
        "attorney_profiles",
        "waitlist",
      ]);
      assert.deepEqual(groupsOf(world.compliance), ["compliance_reviews"]);
      assert.deepEqual(groupsOf(world.complaints), ["complaints"]);
      assert.deepEqual(groupsOf(world.holds), ["legal_holds"]);
      assert.deepEqual(groupsOf(world.plainStaff), []);
      assert.deepEqual(groupsOf(world.everything), [
        "attorney_profiles",
        "waitlist",
        "compliance_reviews",
        "complaints",
        "legal_holds",
      ]);
      assert.deepEqual(
        rowsJson(world.verifier, COMPLIANCE_SUMMARY_SQL, AAL1),
        [],
      );
      const rows = rowsJson(world.everything, COMPLIANCE_SUMMARY_SQL);
      const of = (metric, dimension) =>
        rows.find((r) => r.metric === metric && r.dimension === dimension)
          .value;
      for (const state of [
        "applicant",
        "under_review",
        "approved",
        "suspended",
        "removed",
      ]) {
        assert.equal(
          of("attorney_profiles", state),
          Number(
            sql(
              `select count(*) from public.attorney_profiles where profile_state = '${state}';`,
            ),
          ),
        );
      }
      const scoped = rowsJson(world.verifierS, COMPLIANCE_SUMMARY_SQL);
      assert.equal(
        scoped.find((r) => r.dimension === "approved").value,
        Number(
          sql(
            `select count(*) from public.attorney_profiles a where a.profile_state = 'approved' and exists (select 1 from public.licenses l where l.attorney_id = a.id and l.jurisdiction_id = '${world.J.S}');`,
          ),
        ),
      );
      assert.equal(
        of("legal_holds", "active"),
        Number(
          sql(
            "select count(*) from public.legal_holds where released_at is null;",
          ),
        ),
      );
      assert.equal(
        of("compliance_reviews", "eligibility_change_review"),
        Number(
          sql(
            "select count(*) from public.reconciliation_exceptions where exception_type = 'eligibility_change_review' and status = 'open';",
          ),
        ),
      );
      assert.deepEqual(apiRefusals(COMPLIANCE_SUMMARY_SQL), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      return { groups: rows.length };
    },
  );

  await check(
    "CMPL-2 attorney record sections (manage_attorney_verification by jurisdiction; no threshold applied): licence and insurance end dates soonest first, past dates included; evidence age against the eligibility policy in force (latest evidence and the date its maximum age is reached); profiles by stage; discipline records; a scoped verifier sees only its jurisdiction's records; an unknown section, aal1 and other staff read nothing",
    () => {
      const a = profileWith({
        stage: "approved",
        licences: [
          [world.J.S, `SYN-EXP-S-${uid().slice(0, 6)}`, "2027-03-01"],
          [world.J.C, `SYN-EXP-C-${uid().slice(0, 6)}`, "2026-01-01"],
        ],
      });
      const expiry = rowsJson(world.verifier, RECORDS_SQL("license_expiry"));
      const mine = expiry.filter((r) => r.attorney_id === a.profile);
      assert.deepEqual(
        mine.map((r) => [r.record_id, r.lapses_on]),
        [
          [a.licences[1], "2026-01-01"],
          [a.licences[0], "2027-03-01"],
        ],
      );
      const dates = expiry.map((r) => r.lapses_on);
      assert.deepEqual(dates, [...dates].sort());
      assert.equal(
        keysOf(expiry[0]),
        "attorney_id,display_name,jurisdiction_id,lapses_on,profile_state,record_id,record_type,recorded_at,status_code",
      );
      const scoped = rowsJson(world.verifierS, RECORDS_SQL("license_expiry"));
      assert.ok(scoped.length > 0);
      assert.ok(scoped.every((r) => r.jurisdiction_id === world.J.S));
      assert.ok(scoped.some((r) => r.record_id === a.licences[0]));
      assert.ok(!scoped.some((r) => r.record_id === a.licences[1]));
      // Evidence age: world.ann's licences carry evidence retrieved an hour
      // ago and every seed jurisdiction's development eligibility policy has
      // a 30-day maximum (synthetic test value).
      const evidence = rowsJson(world.verifier, RECORDS_SQL("evidence_age"));
      const annS = evidence.find(
        (r) =>
          r.attorney_id === world.ann.profile &&
          r.jurisdiction_id === world.J.S,
      );
      assert.ok(annS);
      const retrieved = new Date(annS.recorded_at);
      const expected = new Date(
        Date.UTC(
          retrieved.getUTCFullYear(),
          retrieved.getUTCMonth(),
          retrieved.getUTCDate(),
        ) +
          30 * DAY_MS,
      )
        .toISOString()
        .slice(0, 10);
      assert.equal(annS.lapses_on, expected);
      const noEvidence = evidence.filter((r) => r.recorded_at === null);
      assert.ok(noEvidence.some((r) => r.attorney_id === a.profile));
      assert.equal(evidence[0].recorded_at, null);
      const under = profileWith({
        stage: "under_review",
        licences: [[world.J.S, `SYN-UR-${uid().slice(0, 6)}`]],
      });
      const section = rowsJson(world.verifier, RECORDS_SQL("under_review"));
      assert.ok(
        section.some(
          (r) =>
            r.attorney_id === under.profile &&
            r.record_type === "attorney_profile" &&
            r.jurisdiction_id === null,
        ),
      );
      assert.ok(section.every((r) => r.profile_state === "under_review"));
      assert.ok(
        rowsJson(world.verifierS, RECORDS_SQL("under_review")).some(
          (r) => r.attorney_id === under.profile,
        ),
      );
      const discipline = uid();
      sql(
        `insert into public.discipline_records (id, attorney_id, jurisdiction_id, external_reference, finding_type, opened_at, status) values ('${discipline}', '${a.profile}', '${world.J.C}', 'synthetic-ref', 'synthetic_finding', '2026-06-01', 'synthetic_open');`,
      );
      const findings = rowsJson(world.verifier, RECORDS_SQL("discipline"));
      assert.ok(
        findings.some(
          (r) =>
            r.record_id === discipline && r.status_code === "synthetic_open",
        ),
      );
      assert.ok(
        !rowsJson(world.verifierS, RECORDS_SQL("discipline")).some(
          (r) => r.record_id === discipline,
        ),
      );
      for (const [staff, section2, options] of [
        [world.verifier, "synthetic_section", {}],
        [world.verifier, "license_expiry", AAL1],
        [world.compliance, "license_expiry", {}],
        [world.plainStaff, "waitlist", {}],
      ]) {
        assert.deepEqual(rowsJson(staff, RECORDS_SQL(section2), options), []);
      }
      assert.deepEqual(apiRefusals(RECORDS_SQL("waitlist")), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      return {
        expiry: expiry.length,
        evidence: evidence.length,
        scoped: scoped.length,
      };
    },
  );

  await check(
    "CMPL-3 recent policy status changes (manage_policy_configuration covering the version's scope): a staff transition appears with its type, scope and the stage before and after, newest first; a holder scoped to one jurisdiction does not see another scope's change; other staff read nothing",
    () => {
      const created = JSON.parse(
        asStaff(
          world.policyAdmin,
          `select row_to_json(x)::text from public.staff_create_policy_version('payment', '${world.J.C}', '${world.mode}', ${lit(`cmpl-${uid().slice(0, 8)}`)}, '{"synthetic": true}'::jsonb, null, null, null, false) x;`,
        ),
      );
      assert.equal(created.outcome, "created");
      const updated = sql(
        `select updated_at from public.policy_versions where id = '${created.policy_version_id}';`,
      );
      assert.equal(
        asStaff(
          world.policyAdmin,
          `select public.staff_transition_policy_version('${created.policy_version_id}', ${lit(updated)}::timestamptz, 'internal_review');`,
        ),
        "applied",
      );
      const changes = rowsJson(world.policyAdmin, POLICY_CHANGES_SQL());
      assert.deepEqual(
        [
          changes[0].policy_version_id,
          changes[0].policy_type_code,
          changes[0].jurisdiction_id,
          changes[0].from_status,
          changes[0].to_status,
        ],
        [
          created.policy_version_id,
          "payment",
          world.J.C,
          "draft",
          "internal_review",
        ],
      );
      assert.ok(
        !rowsJson(world.policyS, POLICY_CHANGES_SQL()).some(
          (r) => r.policy_version_id === created.policy_version_id,
        ),
      );
      assert.deepEqual(rowsJson(world.plainStaff, POLICY_CHANGES_SQL()), []);
      assert.deepEqual(rowsJson(world.verifier, POLICY_CHANGES_SQL()), []);
      assert.deepEqual(
        rowsJson(world.policyAdmin, POLICY_CHANGES_SQL(), AAL1),
        [],
      );
      assert.deepEqual(apiRefusals(POLICY_CHANGES_SQL()), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      return { newest: changes[0].to_status };
    },
  );
}

// ---------------------------------------------------------------------------
// LIFE: attorney reinstatement and removal
// ---------------------------------------------------------------------------

async function lifecycleChecks() {
  await check(
    "LIFE-1 (DM section 5; TA section 18) under the rule of the existing suspend intent (the global manage_attorney_verification grant at aal2): remove takes an approved or a suspended profile to removed and reinstate a suspended one to approved, each with a required note audited as attorney_profile_state_changed (staff_review_remove, staff_review_reinstate; the stage before and after and the note); removal is final (reinstate, suspend, approve and remove all answer locked afterwards)",
    () => {
      const a = lawyer("S");
      assert.equal(
        lifecycle(
          world.verifier,
          a.profile,
          "remove",
          "Synthetic removal note",
        ),
        "applied",
      );
      assert.equal(profileState(a.profile), "removed");
      const audit = auditsFor("attorney_profile", a.profile).at(-1);
      assert.deepEqual(audit, {
        action: "attorney_profile_state_changed",
        actor_type: "staff",
        actor_user_id: world.verifier.user,
        after: {
          profile_state: "removed",
          staff_note: "Synthetic removal note",
        },
        before: { profile_state: "approved" },
        policy_references: null,
      });
      assert.equal(
        sql(
          `select reason_code from public.audit_events where resource_id = '${a.profile}' and action_code = 'attorney_profile_state_changed' order by occurred_at desc limit 1;`,
        ),
        "staff_review_remove",
      );
      for (const [statement] of [
        [LIFE_SQL(a.profile, "reinstate", "note")],
        [LIFE_SQL(a.profile, "remove", "note")],
        [STAGE_SQL(a.profile, "suspend")],
        [STAGE_SQL(a.profile, "approve")],
      ]) {
        assert.equal(asStaff(world.verifier, statement), "locked", statement);
      }
      assert.equal(profileState(a.profile), "removed");
      const b = lawyer("S");
      assert.equal(stage(world.verifier, b.profile, "suspend"), "applied");
      assert.equal(
        lifecycle(
          world.verifierB,
          b.profile,
          "reinstate",
          "Synthetic reinstatement",
        ),
        "applied",
      );
      assert.equal(profileState(b.profile), "approved");
      assert.equal(
        sql(
          `select reason_code from public.audit_events where resource_id = '${b.profile}' and action_code = 'attorney_profile_state_changed' order by occurred_at desc limit 1;`,
        ),
        "staff_review_reinstate",
      );
      assert.equal(lifecycle(world.verifier, b.profile, "reinstate"), "locked");
      assert.equal(stage(world.verifier, b.profile, "suspend"), "applied");
      assert.equal(lifecycle(world.verifier, b.profile, "remove"), "applied");
      assert.equal(profileState(b.profile), "removed");
      return { removed: [a.profile, b.profile] };
    },
  );

  await check(
    "LIFE-2 guards: a missing, blank or over-long note and an unknown intent are invalid; a jurisdiction-scoped verification grant, aal1, a staff member without the capability, an unknown profile and the caller's own profile are denied, with nothing changed; anon and service_role cannot execute the command or the profile read (42501); the profile read answers only the global holder",
    () => {
      const a = lawyer("S");
      for (const [intent, note] of [
        ["remove", null],
        ["remove", "   "],
        ["remove", "x".repeat(501)],
        ["withdraw", "note"],
      ]) {
        assert.equal(
          asStaff(world.verifier, LIFE_SQL(a.profile, intent, note)),
          "invalid",
          `${intent} ${note}`,
        );
      }
      assert.equal(lifecycle(world.verifierS, a.profile, "remove"), "denied");
      assert.equal(
        lifecycle(world.verifier, a.profile, "remove", "note", AAL1),
        "denied",
      );
      assert.equal(lifecycle(world.plainStaff, a.profile, "remove"), "denied");
      assert.equal(lifecycle(world.verifier, uid(), "remove"), "denied");
      // A verifier who is also an attorney never acts on their own profile.
      const dual = lawyer("S");
      sql(
        `insert into public.staff_profiles (user_id, staff_state) values ('${dual.user}', 'active');
         insert into public.capability_grants (user_id, capability_code, granted_by_user_id, granted_at) values ('${dual.user}', 'manage_attorney_verification', '${world.grantor.user}', now() - interval '1 day');`,
      );
      assert.equal(lifecycle(dual, dual.profile, "remove"), "denied");
      assert.equal(profileState(a.profile), "approved");
      assert.equal(profileState(dual.profile), "approved");
      assert.deepEqual(apiRefusals(LIFE_SQL(a.profile, "remove", "note")), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      assert.deepEqual(apiRefusals(PROFILE_SQL(a.profile)), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      const read = rowsJson(world.verifier, PROFILE_SQL(a.profile));
      assert.equal(read.length, 1);
      assert.equal(
        keysOf(read[0]),
        "attorney_id,display_name,profile_state,rejoin_review_open,updated_at",
      );
      assert.equal(read[0].rejoin_review_open, false);
      for (const [staff, options] of [
        [world.verifierS, {}],
        [world.verifier, AAL1],
        [world.plainStaff, {}],
      ]) {
        assert.deepEqual(rowsJson(staff, PROFILE_SQL(a.profile), options), []);
      }
      assert.deepEqual(rowsJson(world.verifier, PROFILE_SQL(uid())), []);
      return { profile: a.profile };
    },
  );

  await check(
    "LIFE-3 (PM rows 37 to 41; S8 routing proven for both intents) removal leaves every historical record intact and the S8 trigger routes the attorney's open matter: removing an attorney with an awaiting Request opens one eligibility_change_review item for it (medium, cause attorney_profiles) at commit, and changes nothing else (the Request, its payment, the licences and their evidence links are unchanged); a reinstated attorney whose open matter is eligible again is routed and opens nothing new (the item opened by the suspension stays open for a person)",
    () => {
      const who = lawyer("S");
      const s = authorizedRequest({
        jurisdiction: world.J.S,
        requestPath: "scheduled",
        lawyer: who,
      });
      assert.equal(requestStateOf(s.request), "awaiting_attorney");
      const snapshot = () => ({
        request: tableRows("consultation_requests", `id = '${s.request}'`),
        payments: tableRows(
          "payment_transactions",
          `consultation_request_id = '${s.request}'`,
        ),
        licences: tableRows("licenses", `attorney_id = '${who.profile}'`),
        evidence: tableRows(
          "verification_evidence_subjects",
          `license_id in (select id from public.licenses where attorney_id = '${who.profile}')`,
        ),
      });
      const before = snapshot();
      assert.equal(lifecycle(world.verifier, who.profile, "remove"), "applied");
      assert.deepEqual(snapshot(), before);
      const items = itemsOf("eligibility_change_review", s.request);
      assert.equal(items.length, 1);
      assert.equal(items[0].severity, "medium");
      assert.equal(items[0].evidence.cause, "attorney_profiles");
      const back = lawyer("S");
      const r = authorizedRequest({
        jurisdiction: world.J.S,
        requestPath: "scheduled",
        lawyer: back,
      });
      assert.equal(stage(world.verifier, back.profile, "suspend"), "applied");
      assert.equal(itemsOf("eligibility_change_review", r.request).length, 1);
      const total = count(
        "reconciliation_exceptions",
        "exception_type = 'eligibility_change_review'",
      );
      assert.equal(
        lifecycle(world.verifier, back.profile, "reinstate"),
        "applied",
      );
      assert.equal(
        count(
          "reconciliation_exceptions",
          "exception_type = 'eligibility_change_review'",
        ),
        total,
      );
      assert.equal(
        JSON.parse(
          sql(
            `select public.eligibility_assessment('${back.profile}', '${world.J.S}', null, now())::text;`,
          ),
        ).result,
        "eligible",
      );
      return { removal_item: items[0].severity, reinstate_new_items: 0 };
    },
  );
}

// ---------------------------------------------------------------------------
// WAIT: the attorney waitlist (MB section 22)
// ---------------------------------------------------------------------------

async function waitlistChecks() {
  const w = {};
  await check(
    "WAIT-1 the staff read of the waitlist (manage_attorney_verification by jurisdiction): every licence claim in a jurisdiction whose lifecycle_state is waitlist, with the attorney, the stage and the claim time, earliest first; a verifier scoped elsewhere does not see it; the summary counts the members",
    () => {
      w.jurisdiction = newJurisdiction(
        `SYN_S11_WAIT_${uid().slice(0, 4).toUpperCase()}`,
        DB,
        "waitlist",
      );
      w.attorney = attorney({
        name: "Synthetic Waitlist Attorney",
        jurisdictions: [w.jurisdiction],
      });
      const rows = rowsJson(world.verifier, RECORDS_SQL("waitlist")).filter(
        (r) => r.jurisdiction_id === w.jurisdiction,
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].attorney_id, w.attorney.profile);
      assert.equal(rows[0].profile_state, "approved");
      assert.equal(rows[0].record_type, "license");
      assert.ok(
        !rowsJson(world.verifierS, RECORDS_SQL("waitlist")).some(
          (r) => r.jurisdiction_id === w.jurisdiction,
        ),
      );
      const members = rowsJson(world.verifier, COMPLIANCE_SUMMARY_SQL).find(
        (r) => r.metric === "waitlist",
      ).value;
      assert.equal(
        members,
        Number(
          sql(
            "select count(*) from public.licenses l join public.jurisdictions j on j.id = l.jurisdiction_id where j.lifecycle_state = 'waitlist';",
          ),
        ),
      );
      return { members };
    },
  );

  await check(
    "WAIT-2 (MB section 22) an attorney whose only licence is in a waitlist jurisdiction has no marketplace visibility and cannot be selected or referred even when that jurisdiction carries complete development configuration and the attorney complete evidence: the discovery filters do not list the jurisdiction, the directory and the public profile answer nothing, referral_create refuses, no eligibility evaluation is recorded and so no Request can be made; the same attorney becomes listed only when the jurisdiction leaves the waitlist (so the waitlist state, not the configuration, decides); attorneys whose only licence is in an unsupported, staged or ready jurisdiction without an applicable eligibility policy are likewise never listed, never eligible and never referred",
    () => {
      const config = (jurisdiction) => {
        policy("eligibility", jurisdiction, ELIGIBILITY);
        policy("scheduling", jurisdiction, STANDARD_SCHEDULING);
        policy("referral", jurisdiction, {
          outcome_codes: ["synthetic_closed"],
        });
        policy("fee", jurisdiction, FEE());
      };
      config(w.jurisdiction);
      const client = newClient();
      const directory = (jurisdiction) =>
        rowsAs(
          "anon",
          null,
          `select row_to_json(d)::text from public.public_attorney_directory(${lit(jurisdiction)}::uuid, null::uuid, 'any', 1) d;`,
        );
      const profile = (attorneyId, jurisdiction) =>
        rowsAs(
          "anon",
          null,
          `select row_to_json(p)::text from public.public_attorney_profile(${lit(attorneyId)}::uuid, ${lit(jurisdiction)}::uuid) p;`,
        );
      const filters = () =>
        rowsAs(
          "anon",
          null,
          "select row_to_json(f)::text from public.public_discovery_filters() f;",
        ).map((r) => JSON.parse(r));
      const listed = (jurisdiction) =>
        filters().some(
          (f) => f.filter_kind === "jurisdiction" && f.id === jurisdiction,
        );
      const refer = (attorneyId, jurisdiction) =>
        asClient(
          client,
          `select outcome || '|' || coalesce(referral_id::text, '') from public.referral_create(${lit(client.intake)}::uuid, ${lit(attorneyId)}::uuid, ${lit(jurisdiction)}::uuid, null::uuid, 'scheduled', 'any', 1);`,
        );
      const evaluations = (attorneyId) =>
        count("eligibility_evaluations", `attorney_id = '${attorneyId}'`);
      // The engine alone would call the attorney eligible: the waitlist, not
      // the configuration, is what keeps the attorney out.
      assert.equal(
        JSON.parse(
          sql(
            `select public.eligibility_assessment('${w.attorney.profile}', '${w.jurisdiction}', null, now())::text;`,
          ),
        ).result,
        "eligible",
      );
      const referralsBefore = count("referrals");
      const waitlisted = {
        listed: listed(w.jurisdiction),
        directory: directory(w.jurisdiction).length,
        profile: profile(w.attorney.profile, w.jurisdiction).length,
        profile_any: profile(w.attorney.profile, null).length,
        referral: refer(w.attorney.profile, w.jurisdiction).split("|")[0],
        evaluations: evaluations(w.attorney.profile),
        referrals_created: count("referrals") - referralsBefore,
      };
      assert.equal(waitlisted.listed, false);
      assert.equal(waitlisted.directory, 0);
      assert.equal(waitlisted.profile, 0);
      assert.equal(waitlisted.profile_any, 0);
      assert.notEqual(waitlisted.referral, "created");
      assert.equal(waitlisted.evaluations, 0);
      assert.equal(waitlisted.referrals_created, 0);
      // The control: the same jurisdiction out of the waitlist lists the
      // attorney (the S5 rules unchanged).
      sql(
        `update public.jurisdictions set lifecycle_state = 'unsupported' where id = '${w.jurisdiction}';`,
      );
      const control = {
        listed: listed(w.jurisdiction),
        directory: directory(w.jurisdiction).length,
        profile: profile(w.attorney.profile, w.jurisdiction).length,
      };
      assert.deepEqual(control, { listed: true, directory: 1, profile: 1 });
      sql(
        `update public.jurisdictions set lifecycle_state = 'waitlist' where id = '${w.jurisdiction}';`,
      );
      assert.equal(directory(w.jurisdiction).length, 0);
      const others = {};
      for (const lifecycleState of ["unsupported", "staged", "ready"]) {
        const jurisdiction = newJurisdiction(
          `SYN_S11_${lifecycleState.toUpperCase()}_${uid().slice(0, 4).toUpperCase()}`,
          DB,
          lifecycleState,
        );
        const only = attorney({
          name: `Synthetic ${lifecycleState} attorney`,
          jurisdictions: [jurisdiction],
        });
        others[lifecycleState] = {
          listed: listed(jurisdiction),
          directory: directory(jurisdiction).length,
          profile: profile(only.profile, jurisdiction).length,
          eligibility: JSON.parse(
            sql(
              `select public.eligibility_assessment('${only.profile}', '${jurisdiction}', null, now())::text;`,
            ),
          ).result,
          referral: refer(only.profile, jurisdiction).split("|")[0],
          evaluations: evaluations(only.profile),
        };
        assert.equal(others[lifecycleState].listed, false);
        assert.equal(others[lifecycleState].directory, 0);
        assert.equal(others[lifecycleState].profile, 0);
        assert.notEqual(others[lifecycleState].eligibility, "eligible");
        assert.notEqual(others[lifecycleState].referral, "created");
      }
      return { waitlisted, control, others };
    },
  );
}

// ---------------------------------------------------------------------------
// REJ: rejoin prevention (MB section 19)
// ---------------------------------------------------------------------------

async function rejoinChecks() {
  const r = {};
  // A removed attorney with one licence in J.S.
  const removedWith = (number) => {
    const q = profileWith({
      stage: "approved",
      licences: [[world.J.S, number]],
    });
    assert.equal(lifecycle(world.verifier, q.profile, "remove"), "applied");
    return q;
  };
  const applicant = () => profileWith({ stage: "applicant" });
  const saveLicence = (who, jurisdiction, number) =>
    asStaff(who, SAVE_LICENSE_SQL(jurisdiction, number));

  await check(
    "REJ-1 (MB section 19) a licence claim whose jurisdiction and normalized number (upper-case letters and digits only) equal a licence of a different, removed profile opens exactly one high rejoin_review compliance item about the applying profile, with evidence holding only the two profile and two licence identifiers, audited once; the claim itself is saved (detection never rejects or changes the application); another number, another jurisdiction and a profile that is not removed open nothing; an exact duplicate is already refused by the P1 unique key (conflict) and opens nothing",
    () => {
      const suffix = uid().slice(0, 6).toUpperCase();
      r.q = removedWith(`SYN-REJ-${suffix}-1001`);
      r.p = applicant();
      const auditBefore = count(
        "audit_events",
        "action_code = 'reconciliation_exception.opened'",
      );
      assert.equal(
        saveLicence(r.p, world.J.S, `syn rej ${suffix.toLowerCase()} 1001`),
        "applied",
      );
      const items = rejoinItems(r.p.profile);
      assert.equal(items.length, 1);
      assert.deepEqual(
        [
          items[0].status,
          items[0].severity,
          items[0].source_type,
          items[0].canonical_type,
        ],
        ["open", "high", "attorney_profile", "attorney_profile"],
      );
      const saved = sql(
        `select id from public.licenses where attorney_id = '${r.p.profile}';`,
      );
      assert.deepEqual(items[0].evidence, {
        attorney_profile_id: r.p.profile,
        license_id: saved,
        removed_attorney_profile_id: r.q.profile,
        removed_license_id: r.q.licences[0],
      });
      assert.equal(
        count(
          "audit_events",
          "action_code = 'reconciliation_exception.opened'",
        ),
        auditBefore + 1,
      );
      assert.equal(profileState(r.p.profile), "applicant");
      const other = applicant();
      assert.equal(
        saveLicence(other, world.J.S, `SYN-REJ-${suffix}-1002`),
        "applied",
      );
      assert.equal(
        saveLicence(other, world.J.C, `syn-rej-${suffix}-1001`),
        "applied",
      );
      assert.deepEqual(rejoinItems(other.profile), []);
      const live = profileWith({
        stage: "approved",
        licences: [[world.J.S, `SYN-LIVE-${suffix}-7`]],
      });
      const third = applicant();
      assert.equal(
        saveLicence(third, world.J.S, `syn live ${suffix} 7`),
        "applied",
      );
      assert.deepEqual(rejoinItems(third.profile), []);
      assert.equal(profileState(live.profile), "approved");
      const dup = applicant();
      assert.equal(
        saveLicence(dup, world.J.S, `SYN-REJ-${suffix}-1001`),
        "conflict",
      );
      assert.deepEqual(rejoinItems(dup.profile), []);
      assert.equal(
        sql(`select public.license_number_normalized(' ab-12/c 3 ')`),
        "AB12C3",
      );
      return {
        item: items[0].severity,
        evidence: Object.keys(items[0].evidence),
      };
    },
  );

  await check(
    "REJ-2 approval waits for a human: after the applicant submits, the approval answers review_required and changes nothing while the rejoin item is open (no second item); a holder of manage_compliance_reviews sees it in the compliance family (a finance holder does not) and resolves it with notes through the existing command; then the approval follows the normal rules (applied); a request for information and a resubmission open nothing new for the same resolved match; the profile read reports whether a rejoin review is open",
    () => {
      assert.equal(asStaff(r.p, SUBMIT_SQL), "applied");
      assert.equal(profileState(r.p.profile), "under_review");
      assert.equal(rejoinItems(r.p.profile).length, 1);
      assert.equal(
        stage(world.verifier, r.p.profile, "approve"),
        "review_required",
      );
      assert.equal(profileState(r.p.profile), "under_review");
      assert.equal(rejoinItems(r.p.profile).length, 1);
      assert.equal(
        rowsJson(world.verifier, PROFILE_SQL(r.p.profile))[0]
          .rejoin_review_open,
        true,
      );
      const item = rejoinItems(r.p.profile)[0].id;
      assert.ok(familyItemIds(world.compliance, "compliance").includes(item));
      assert.ok(!familyItemIds(world.finance, "financial").includes(item));
      assert.equal(asStaff(world.finance, RESOLVE_SQL(item)), "not_found");
      assert.equal(asStaff(world.compliance, RESOLVE_SQL(item)), "applied");
      assert.equal(rejoinItems(r.p.profile)[0].status, "resolved");
      assert.equal(
        rowsJson(world.verifier, PROFILE_SQL(r.p.profile))[0]
          .rejoin_review_open,
        false,
      );
      // A request for information and a resubmission: the same resolved match
      // opens nothing new.
      assert.equal(
        asStaff(
          world.verifier,
          STAGE_SQL(
            r.p.profile,
            "request_information",
            null,
            "Synthetic message",
          ),
        ),
        "applied",
      );
      assert.equal(asStaff(r.p, SUBMIT_SQL), "applied");
      assert.equal(rejoinItems(r.p.profile).length, 1);
      assert.equal(stage(world.verifier, r.p.profile, "approve"), "applied");
      assert.equal(profileState(r.p.profile), "approved");
      return { item };
    },
  );

  await check(
    "REJ-3 detection also runs when an application is submitted and at approval: a match that appears only because the other profile is removed after the claim was saved opens the item when the application is submitted; one that appears after the submission opens it at the approval, which then answers review_required; a removed profile's own later state is never examined (a removed profile opens nothing)",
    () => {
      const suffix = uid().slice(0, 6).toUpperCase();
      const q1 = profileWith({
        stage: "approved",
        licences: [[world.J.S, `SYN-SUB-${suffix}`]],
      });
      const p1 = applicant();
      assert.equal(saveLicence(p1, world.J.S, `syn sub ${suffix}`), "applied");
      assert.deepEqual(rejoinItems(p1.profile), []);
      assert.equal(lifecycle(world.verifier, q1.profile, "remove"), "applied");
      assert.deepEqual(rejoinItems(p1.profile), []);
      assert.equal(asStaff(p1, SUBMIT_SQL), "applied");
      assert.equal(rejoinItems(p1.profile).length, 1);
      const q2 = profileWith({
        stage: "approved",
        licences: [[world.J.S, `SYN-APR-${suffix}`]],
      });
      const p2 = applicant();
      assert.equal(saveLicence(p2, world.J.S, `SYN apr ${suffix}`), "applied");
      assert.equal(asStaff(p2, SUBMIT_SQL), "applied");
      assert.deepEqual(rejoinItems(p2.profile), []);
      assert.equal(lifecycle(world.verifier, q2.profile, "remove"), "applied");
      assert.equal(
        stage(world.verifier, p2.profile, "approve"),
        "review_required",
      );
      assert.equal(rejoinItems(p2.profile).length, 1);
      assert.equal(profileState(p2.profile), "under_review");
      assert.equal(
        sql(
          `select coalesce(public.attorney_rejoin_detect('${q2.profile}')::text, 'none');`,
        ),
        "none",
      );
      return { submission: 1, approval: 1 };
    },
  );
}

// ---------------------------------------------------------------------------
// CLI: client administration (DM section 3; PM row 46)
// ---------------------------------------------------------------------------

const CLIENT_KEYS =
  "account_state,consultations,created_at,display_name,intakes,open_complaints,open_consultations,open_requests,requests,user_id";

async function clientChecks() {
  await check(
    "CLI-1 (TA section 41: minimum necessary) the client reads need the global manage_client_accounts grant at aal2 and answer account metadata and counts only (exactly the User id, display name, account state, creation instant and counts); a staff account, an unknown or guessed identifier, a scoped grant, aal1 and other staff read nothing; anon and service_role cannot execute them (42501); the list pages 25 rows plus one, newest first, and filters by account state",
    () => {
      const c = newClient();
      const one = rowsJson(world.clientAdmin, CLIENT_SQL(c.user));
      assert.equal(one.length, 1);
      assert.equal(keysOf(one[0]), CLIENT_KEYS);
      assert.deepEqual(
        [
          one[0].user_id,
          one[0].account_state,
          one[0].intakes,
          one[0].requests,
          one[0].consultations,
          one[0].open_complaints,
        ],
        [c.user, "active", 1, 0, 0, 0],
      );
      // A staff account that also holds a Client Profile is not administered here.
      const staffClient = staffWith();
      sql(
        `insert into public.client_profiles (user_id) values ('${staffClient.user}');`,
      );
      for (const [staff, id, options] of [
        [world.clientAdmin, staffClient.user, {}],
        [world.clientAdmin, uid(), {}],
        [world.clientAdmin, world.ann.user, {}],
        [world.clientAdminS, c.user, {}],
        [world.clientAdmin, c.user, AAL1],
        [world.plainStaff, c.user, {}],
        [world.auditor, c.user, {}],
      ]) {
        assert.deepEqual(rowsJson(staff, CLIENT_SQL(id), options), []);
      }
      assert.deepEqual(apiRefusals(CLIENT_SQL(c.user)), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      assert.deepEqual(apiRefusals(CLIENTS_SQL()), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      // At least 26 client accounts exist, so the first page says another
      // follows.
      while (
        Number(
          sql(
            "select count(*) from public.client_profiles c where not exists (select 1 from public.staff_profiles s where s.user_id = c.user_id);",
          ),
        ) < 27
      ) {
        newClient();
      }
      const page = rowsJson(world.clientAdmin, CLIENTS_SQL());
      assert.equal(page.length, 26);
      assert.ok(!page.some((row) => row.user_id === staffClient.user));
      const created = page.map((row) => ms(row.created_at));
      assert.deepEqual(
        created,
        [...created].sort((a, b) => b - a),
      );
      assert.deepEqual(rowsJson(world.clientAdminS, CLIENTS_SQL()), []);
      assert.deepEqual(rowsJson(world.clientAdmin, CLIENTS_SQL("bogus")), []);
      const suspended = newClient();
      sql(
        `update public.users set account_state = 'suspended' where id = '${suspended.user}';`,
      );
      const filtered = rowsJson(world.clientAdmin, CLIENTS_SQL("suspended"));
      assert.ok(filtered.some((row) => row.user_id === suspended.user));
      assert.ok(filtered.every((row) => row.account_state === "suspended"));
      return { first_page: page.length };
    },
  );

  await check(
    "CLI-2 suspend (active -> suspended) and reactivate (suspended -> active) with a required note, audited as user.account_state_changed (staff_client_suspend, staff_client_reactivate; the state before and after and the note); a repeated intent is locked; a missing note or unknown intent is invalid; an unknown User and a staff account are not_found; the caller's own account, a scoped grant and aal1 are denied; a client without open matters opens no review item",
    () => {
      const c = newClient();
      const items = () =>
        count(
          "reconciliation_exceptions",
          `exception_type = 'client_account_review' and source_id = '${c.user}'`,
        );
      assert.equal(
        changeAccount(
          world.clientAdmin,
          c.user,
          "suspend",
          "Synthetic suspension note",
        ),
        "applied",
      );
      assert.equal(accountState(c.user), "suspended");
      assert.equal(items(), 0);
      assert.deepEqual(auditsFor("user", c.user).at(-1), {
        action: "user.account_state_changed",
        actor_type: "staff",
        actor_user_id: world.clientAdmin.user,
        after: {
          account_state: "suspended",
          staff_note: "Synthetic suspension note",
        },
        before: { account_state: "active" },
        policy_references: null,
      });
      assert.equal(
        changeAccount(world.clientAdmin, c.user, "suspend"),
        "locked",
      );
      assert.equal(
        changeAccount(world.clientAdminB, c.user, "reactivate"),
        "applied",
      );
      assert.equal(accountState(c.user), "active");
      assert.equal(
        sql(
          `select reason_code from public.audit_events where resource_id = '${c.user}' order by occurred_at desc limit 1;`,
        ),
        "staff_client_reactivate",
      );
      assert.equal(
        changeAccount(world.clientAdmin, c.user, "reactivate"),
        "locked",
      );
      for (const [intent, note] of [
        ["suspend", null],
        ["suspend", " "],
        ["close", "note"],
      ]) {
        assert.equal(
          asStaff(world.clientAdmin, ACCOUNT_SQL(c.user, intent, note)),
          "invalid",
        );
      }
      assert.equal(
        changeAccount(world.clientAdmin, uid(), "suspend"),
        "not_found",
      );
      const staffClient = staffWith();
      sql(
        `insert into public.client_profiles (user_id) values ('${staffClient.user}');`,
      );
      assert.equal(
        changeAccount(world.clientAdmin, staffClient.user, "suspend"),
        "not_found",
      );
      const selfAdmin = staffWith(["manage_client_accounts", null]);
      sql(
        `insert into public.client_profiles (user_id) values ('${selfAdmin.user}');`,
      );
      assert.equal(
        changeAccount(selfAdmin, selfAdmin.user, "suspend"),
        "denied",
      );
      assert.equal(
        changeAccount(world.clientAdminS, c.user, "suspend"),
        "denied",
      );
      assert.equal(
        changeAccount(world.clientAdmin, c.user, "suspend", "note", AAL1),
        "denied",
      );
      assert.equal(
        changeAccount(world.plainStaff, c.user, "suspend"),
        "denied",
      );
      assert.equal(accountState(c.user), "active");
      assert.deepEqual(apiRefusals(ACCOUNT_SQL(c.user, "suspend", "note")), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      return { states: ["suspended", "active"] };
    },
  );

  await check(
    "CLI-3 (PM row 46; DM section 3) suspending a client with an open matter opens exactly one high client_account_review compliance item (evidence: the User and Client Profile ids, row 46 and the open Request and Consultation ids) and changes nothing else: the Request, its payment, Holds, Bookings and Consultations are unchanged; a second suspension after reactivation opens no second item while the first is open; the suspended client's next Request is refused; suspending the account of a User who also holds an Attorney Profile (MVP-001 S11 review correction R3) answers not_found and changes neither the account state nor the profile's stage",
    () => {
      const s = authorizedRequest({
        jurisdiction: world.J.S,
        requestPath: "scheduled",
      });
      const where = `client_id = '${s.client.client}'`;
      const matter = () => ({
        requests: tableRows("consultation_requests", where),
        payments: tableRows(
          "payment_transactions",
          `consultation_request_id in (select id from public.consultation_requests where ${where})`,
        ),
        holds: tableRows(
          "slot_holds",
          `consultation_request_id in (select id from public.consultation_requests where ${where})`,
        ),
        bookings: tableRows("bookings", where),
        consultations: tableRows("consultations", where),
        notifications: count(
          "notifications",
          `recipient_user_id = '${s.client.user}'`,
        ),
      });
      const before = matter();
      assert.equal(
        changeAccount(world.clientAdmin, s.client.user, "suspend"),
        "applied",
      );
      assert.deepEqual(matter(), before);
      const items = jsonOf(
        `select coalesce(json_agg(json_build_object('severity', severity, 'status', status, 'source_type', source_type, 'evidence', evidence_reference, 'family', public.exception_family(exception_type))), '[]'::json)::text from public.reconciliation_exceptions where exception_type = 'client_account_review' and source_id = '${s.client.user}';`,
      );
      assert.equal(items.length, 1);
      assert.deepEqual(
        [
          items[0].severity,
          items[0].status,
          items[0].source_type,
          items[0].family,
        ],
        ["high", "open", "user", "compliance"],
      );
      assert.deepEqual(items[0].evidence, {
        user_id: s.client.user,
        client_profile_id: s.client.client,
        payment_matrix_row: 46,
        open_request_ids: [s.request],
        open_consultation_ids: [],
      });
      assert.equal(
        changeAccount(world.clientAdmin, s.client.user, "reactivate"),
        "applied",
      );
      assert.equal(
        changeAccount(world.clientAdmin, s.client.user, "suspend"),
        "applied",
      );
      assert.equal(
        count(
          "reconciliation_exceptions",
          `exception_type = 'client_account_review' and source_id = '${s.client.user}'`,
        ),
        1,
      );
      const referral = ownerReferral({
        client: s.client,
        lawyer: world.ann,
        jurisdiction: world.J.S,
        requestPath: "scheduled",
      });
      const refused = asClient(
        s.client,
        `select outcome from public.request_create(${lit(referral)}, 'scheduled', 'synthetic_video', 30, ${lit(nextSlot())}::timestamptz, null::text);`,
      );
      assert.notEqual(refused, "created");
      // DM section 3: the account, not a profile. MVP-001 S11 review
      // correction R3 (fail-closed): a User holding an Attorney Profile is
      // not administered here; it answers as unknown and nothing changes.
      const dual = lawyer("S");
      sql(
        `insert into public.client_profiles (user_id) values ('${dual.user}');`,
      );
      assert.equal(
        changeAccount(world.clientAdmin, dual.user, "suspend"),
        "not_found",
      );
      assert.equal(accountState(dual.user), "active");
      assert.equal(profileState(dual.profile), "approved");
      return {
        item: items[0].evidence.payment_matrix_row,
        refused_request: refused,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// REF: referral operations; FIN: the financial activity summary
// ---------------------------------------------------------------------------

async function readChecks() {
  await check(
    "REF-1 referral operations are read-only and minimal (exactly the Referral, its jurisdiction, ordinal, allocation, times, outcome and the linked Request and Consultation ids and states): a global grant reads every Referral, a scoped one only its jurisdiction's; the counts equal owner queries over the same scope; aal1 and other staff read nothing; anon and service_role cannot execute them (42501)",
    () => {
      const all = rowsJson(world.referralViewer, REFERRALS_SQL());
      assert.ok(all.length > 0);
      assert.equal(
        keysOf(all[0]),
        "allocation_method,attempt_ordinal,consultation_id,consultation_request_id,consultation_state,created_at,jurisdiction_id,outcome_code,outcome_recorded_at,referral_id,request_state",
      );
      const scoped = rowsJson(world.referralViewerS, REFERRALS_SQL());
      assert.ok(scoped.length > 0);
      assert.ok(scoped.every((r) => r.jurisdiction_id === world.J.S));
      const counts = (staff) =>
        Object.fromEntries(
          rowsJson(staff, REFERRAL_COUNTS_SQL).map((r) => [r.metric, r.value]),
        );
      const direct = (scope) => {
        const filter =
          scope === null ? "true" : `f.jurisdiction_id = '${scope}'`;
        const q = (cond) =>
          Number(
            sql(
              `select count(*) from public.referrals f left join public.consultation_requests r on r.referral_id = f.id where ${filter} and ${cond};`,
            ),
          );
        return {
          open: q("f.outcome_code is null"),
          ended_without_request: q(
            "f.outcome_code is not null and r.id is null",
          ),
          request_expired: q("r.state = 'expired'"),
          request_declined: q("r.state = 'declined'"),
        };
      };
      assert.deepEqual(counts(world.referralViewer), direct(null));
      assert.deepEqual(counts(world.referralViewerS), direct(world.J.S));
      assert.deepEqual(
        rowsJson(world.referralViewer, REFERRALS_SQL(), AAL1),
        [],
      );
      assert.deepEqual(rowsJson(world.plainStaff, REFERRAL_COUNTS_SQL), []);
      assert.deepEqual(rowsJson(world.auditor, REFERRALS_SQL()), []);
      assert.deepEqual(apiRefusals(REFERRALS_SQL()), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      assert.deepEqual(apiRefusals(REFERRAL_COUNTS_SQL), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      return {
        global: counts(world.referralViewer),
        scoped: counts(world.referralViewerS),
      };
    },
  );

  await check(
    "FIN-1 the financial activity summary equals the append-only ledger: for a period and optionally one jurisdiction, the totals by entry type, direction and currency equal owner sums of ledger_entries, the payments created in the period by state equal owner counts (all thirteen states answered), refunds and disputes equal owner counts; an invalid period (an end not after the start, more than 366 days, a missing bound) answers nothing; only the global manage_financial_operations grant at aal2 reads it",
    () => {
      capturedPayment({ jurisdiction: world.J.A });
      const from = new Date(Date.now() - DAY_MS).toISOString();
      const until = new Date(Date.now() + DAY_MS).toISOString();
      const check1 = (jurisdiction) => {
        const rows = rowsJson(
          world.finance,
          FINANCE_SQL(from, until, jurisdiction),
        );
        const filter =
          jurisdiction === null
            ? "true"
            : `pt.jurisdiction_id = '${jurisdiction}'`;
        const ledger = jsonOf(
          `select coalesce(json_agg(json_build_object('dimension', l.entry_type || '.' || l.direction, 'currency_code', l.currency_code::text, 'value', s) order by l.entry_type, l.direction, l.currency_code), '[]'::json)::text from (select l.entry_type, l.direction, l.currency_code, sum(l.amount_minor) as s from public.ledger_entries l join public.payment_transactions pt on pt.id = l.payment_transaction_id where l.effective_at >= '${from}' and l.effective_at < '${until}' and ${filter} group by l.entry_type, l.direction, l.currency_code) l;`,
        );
        assert.deepEqual(
          rows
            .filter((r) => r.metric === "ledger")
            .map((r) => ({
              dimension: r.dimension,
              currency_code: r.currency_code,
              value: r.value,
            })),
          ledger,
        );
        const payments = rows.filter((r) => r.metric === "payments");
        assert.equal(payments.length, 13);
        for (const p of payments) {
          assert.equal(
            p.value,
            Number(
              sql(
                `select count(*) from public.payment_transactions pt where pt.state = '${p.dimension}' and pt.created_at >= '${from}' and pt.created_at < '${until}' and ${filter};`,
              ),
            ),
            p.dimension,
          );
        }
        assert.equal(
          rows.find((r) => r.metric === "refunds").value,
          Number(
            sql(
              `select count(distinct l.source_reference) from public.ledger_entries l join public.payment_transactions pt on pt.id = l.payment_transaction_id where l.reason_code = 'payment_refunded' and l.effective_at >= '${from}' and l.effective_at < '${until}' and ${filter};`,
            ),
          ),
        );
        assert.equal(
          rows.find((r) => r.metric === "disputes").value,
          Number(
            sql(
              `select count(*) from public.reconciliation_exceptions e join public.payment_transactions pt on pt.id = e.canonical_id where e.exception_type = 'dispute_opened' and e.detected_at >= '${from}' and e.detected_at < '${until}' and ${filter};`,
            ),
          ),
        );
        return { ledger: ledger.length, rows: rows.length };
      };
      const all = check1(null);
      const a = check1(world.J.A);
      assert.ok(a.ledger > 0);
      for (const [f, u] of [
        [until, from],
        [new Date(Date.now() - 400 * DAY_MS).toISOString(), until],
        [null, until],
      ]) {
        assert.deepEqual(rowsJson(world.finance, FINANCE_SQL(f, u)), []);
      }
      for (const [staff, options] of [
        [world.financeS, {}],
        [world.finance, AAL1],
        [world.compliance, {}],
        [world.plainStaff, {}],
      ]) {
        assert.deepEqual(
          rowsJson(staff, FINANCE_SQL(from, until), options),
          [],
        );
      }
      assert.deepEqual(apiRefusals(FINANCE_SQL(from, until)), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      return { all, jurisdiction: a };
    },
  );

  await check(
    "NAMES-1 jurisdiction names (id, code, name; reference data) for any staff member holding a current grant at aal2; a staff member without a grant, aal1, a client and an attorney read nothing; anon and service_role cannot execute it (42501)",
    () => {
      const names = rowsJson(world.auditor, NAMES_SQL);
      assert.ok(names.some((r) => r.jurisdiction_id === world.J.S));
      assert.equal(keysOf(names[0]), "code,jurisdiction_id,name");
      for (const [account, options] of [
        [world.plainStaff, {}],
        [world.auditor, AAL1],
        [world.ann, {}],
      ]) {
        assert.deepEqual(rowsJson(account, NAMES_SQL, options), []);
      }
      assert.deepEqual(apiRefusals(NAMES_SQL), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      return { names: names.length };
    },
  );
}

// ---------------------------------------------------------------------------
// D2, D5, D7: policy configuration corrections
// ---------------------------------------------------------------------------

async function policyCorrectionChecks() {
  await check(
    "D2 (correction; IMP section 27 exit) staff read the Regulatory Modes mapped to a jurisdiction they hold manage_policy_configuration for (a scoped holder only for its own jurisdiction), and create a mode-scoped payment_flow version through the existing command and walk it through review, verified authority, approval and activation to selection, with no SQL; other staff, aal1 and an unmapped or unknown jurisdiction read no mode",
    () => {
      const modes = rowsJson(world.policyAdmin, MODES_SQL(world.J.S));
      assert.equal(modes.length, 1);
      assert.equal(modes[0].regulatory_mode_id, world.mode);
      assert.equal(
        keysOf(modes[0]),
        "active_from,active_until,approval_status,code,name,regulatory_mode_id,status",
      );
      assert.equal(rowsJson(world.policyS, MODES_SQL(world.J.S)).length, 1);
      assert.deepEqual(rowsJson(world.policyS, MODES_SQL(world.J.C)), []);
      assert.deepEqual(rowsJson(world.plainStaff, MODES_SQL(world.J.S)), []);
      assert.deepEqual(
        rowsJson(world.policyAdmin, MODES_SQL(world.J.S), AAL1),
        [],
      );
      assert.deepEqual(rowsJson(world.policyAdmin, MODES_SQL(uid())), []);
      assert.deepEqual(apiRefusals(MODES_SQL(world.J.S)), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      // A fresh jurisdiction with one mapped mode and no other payment_flow.
      const jurisdiction = newJurisdiction(
        `SYN_S11_D2_${uid().slice(0, 4).toUpperCase()}`,
      );
      const mode = newRegulatoryMode(
        `SYN_S11_D2_MODE_${uid().slice(0, 4).toUpperCase()}`,
      );
      mapMode(jurisdiction, mode);
      assert.equal(
        rowsJson(world.policyAdmin, MODES_SQL(jurisdiction))[0]
          .regulatory_mode_id,
        mode,
      );
      const created = JSON.parse(
        asStaff(
          world.policyAdmin,
          `select row_to_json(x)::text from public.staff_create_policy_version('payment_flow', '${jurisdiction}', '${mode}', 'd2-flow', ${lit(STANDARD_FLOW)}::jsonb, now() - interval '1 hour', null, null, false) x;`,
        ),
      );
      assert.equal(created.outcome, "created");
      const id = created.policy_version_id;
      const at = () =>
        sql(
          `select updated_at from public.policy_versions where id = '${id}';`,
        );
      const step = (target) =>
        asStaff(
          world.policyAdmin,
          `select public.staff_transition_policy_version('${id}', ${lit(at())}::timestamptz, '${target}');`,
        );
      assert.equal(step("internal_review"), "applied");
      assert.equal(step("counsel_review"), "applied");
      const reference = JSON.parse(
        asStaff(
          world.policyAdmin,
          `select row_to_json(x)::text from public.staff_add_policy_authority_reference('${id}', 'synthetic', 'synthetic citation', 'https://example.test/synthetic', 'synthetic source', now()) x;`,
        ),
      );
      assert.equal(reference.outcome, "created");
      assert.equal(
        asStaff(
          world.policyAdmin,
          `select public.staff_decide_policy_authority_reference('${reference.reference_id}', 'verified');`,
        ),
        "applied",
      );
      assert.equal(step("approved"), "applied");
      assert.equal(step("active"), "applied");
      const selected = JSON.parse(
        sql(
          `select row_to_json(s)::text from public.policy_select_version('payment_flow', '${jurisdiction}', '${mode}', now()) s;`,
        ),
      );
      assert.equal(selected.outcome, "selected");
      assert.equal(selected.policy_version_id, id);
      assert.equal(
        sql(
          `select regulatory_mode_id || '|' || status from public.policy_versions where id = '${id}';`,
        ),
        `${mode}|active`,
      );
      return { version: "active", mode_selected: true };
    },
  );

  await check(
    "D5 (correction; PS section 8.4) approval validation checks what the readers read, both ways: eligibility (the checks eligibility_selected_policy applies), bookability (presence_window_seconds 1 to 86400), the remaining scheduling keys when present (the S4 and S6 bounds, whole numbers), referral outcome_codes when present (1 to 100 distinct lower-snake codes); every earlier branch unchanged; end to end, staff approval of a malformed eligibility version answers parameters_invalid and leaves it in counsel_review",
    () => {
      const approvable = (type, parameters, jurisdiction = world.J.S) =>
        sql(
          `select public.policy_parameters_approvable(${lit(type)}, ${lit(jurisdiction)}::uuid, ${typeof parameters === "string" ? lit(parameters) : lit(parameters)}::jsonb);`,
        );
      const table = [
        ["eligibility", ELIGIBILITY, "t"],
        [
          "eligibility",
          { ...ELIGIBILITY, schema: "rosuno.attorney_eligibility.v2" },
          "f",
        ],
        ["eligibility", { ...ELIGIBILITY, extra: true }, "f"],
        [
          "eligibility",
          {
            ...ELIGIBILITY,
            license: { ...ELIGIBILITY.license, evidence_max_age_days: 0 },
          },
          "f",
        ],
        [
          "eligibility",
          {
            ...ELIGIBILITY,
            license: {
              ...ELIGIBILITY.license,
              qualifying_reported_statuses: [],
            },
          },
          "f",
        ],
        [
          "eligibility",
          {
            ...ELIGIBILITY,
            discipline: {
              disqualifying_statuses: ["a"],
              cleared_statuses: ["a"],
            },
          },
          "f",
        ],
        [
          "eligibility",
          {
            ...ELIGIBILITY,
            insurance: {
              ...ELIGIBILITY.insurance,
              minimum_per_occurrence_minor: 100,
            },
          },
          "f",
        ],
        [
          "eligibility",
          {
            ...ELIGIBILITY,
            insurance: {
              ...ELIGIBILITY.insurance,
              minimum_per_occurrence_minor: 100,
              currency_code: "XTS",
            },
          },
          "t",
        ],
        ["eligibility", {}, "f"],
        ["bookability", { presence_window_seconds: 600 }, "t"],
        ["bookability", '{"presence_window_seconds": 600.0}', "t"],
        ["bookability", {}, "f"],
        ["bookability", { presence_window_seconds: 0 }, "f"],
        ["bookability", { presence_window_seconds: 86401 }, "f"],
        ["bookability", { presence_window_seconds: 600.5 }, "f"],
        ["scheduling", SCHEDULING(), "t"],
        ["scheduling", SCHEDULING(TIMING(600, 300)), "t"],
        ["scheduling", {}, "t"],
        ["scheduling", SCHEDULING({ pending_hold_cap: 0 }), "f"],
        [
          "scheduling",
          SCHEDULING({ hold_response_window_seconds: 2592001 }),
          "f",
        ],
        ["scheduling", SCHEDULING({ hold_pre_slot_interval_seconds: -1 }), "f"],
        ["scheduling", SCHEDULING({ minimum_notice_seconds: 31536001 }), "f"],
        [
          "scheduling",
          SCHEDULING({ instant_request_response_window_seconds: "900" }),
          "f",
        ],
        [
          "scheduling",
          SCHEDULING({ scheduled_request_response_window_seconds: 0 }),
          "f",
        ],
        ["scheduling", SCHEDULING({ consultation_overrun_seconds: 1.5 }), "f"],
        ["referral", { outcome_codes: ["synthetic_closed"] }, "t"],
        [
          "referral",
          {
            outcome_codes: ["a_b", "c_d"],
            request_message_maximum_characters: 2000,
          },
          "t",
        ],
        ["referral", { request_message_maximum_characters: 20000 }, "t"],
        ["referral", { outcome_codes: [] }, "f"],
        ["referral", { outcome_codes: ["a_b", "a_b"] }, "f"],
        ["referral", { outcome_codes: ["Upper"] }, "f"],
        ["referral", { outcome_codes: [1] }, "f"],
        ["referral", { outcome_codes: "a_b" }, "f"],
        ["referral", { request_message_maximum_characters: 0 }, "f"],
        ["fee", FEE(), "t"],
        ["payment_flow", STANDARD_FLOW, "t"],
        ["payment", { synthetic: true }, "t"],
      ];
      const results = table.map(([type, parameters, expected]) => {
        const actual = approvable(type, parameters);
        assert.equal(actual, expected, `${type} ${JSON.stringify(parameters)}`);
        return `${type}:${actual}`;
      });
      // End to end through the staff approval.
      const id = uid();
      sql(
        `insert into public.policy_versions (id, policy_type_code, jurisdiction_id, version_label, parameters, status, effective_from, development_only)
         values ('${id}', 'eligibility', '${world.J.C}', ${lit(`d5-${id.slice(0, 8)}`)}, ${lit({ ...ELIGIBILITY, schema: "x" })}::jsonb, 'draft', now() + interval '30 days', false);
         insert into public.policy_authority_references (policy_version_id, authority_type, citation_text, source_title, retrieved_at, verified_by_user_id, verification_status)
           values ('${id}', 'synthetic', 'synthetic citation', 'synthetic source', now(), '${world.grantor.user}', 'verified');
         update public.policy_versions set status = 'internal_review' where id = '${id}';
         update public.policy_versions set status = 'counsel_review' where id = '${id}';`,
      );
      const updated = sql(
        `select updated_at from public.policy_versions where id = '${id}';`,
      );
      assert.equal(
        asStaff(
          world.policyAdmin,
          `select public.staff_transition_policy_version('${id}', ${lit(updated)}::timestamptz, 'approved');`,
        ),
        "parameters_invalid",
      );
      assert.equal(
        sql(`select status from public.policy_versions where id = '${id}';`),
        "counsel_review",
      );
      return { cases: results.length };
    },
  );

  await check(
    "D7 (correction) a whole JSON number written with a fraction (for example 900.0, which every validator accepts as whole) no longer raises in the five readers: pricing_quote reads quote_validity_seconds, request_response_window the response window, request_message_limit the message maximum, attorney_consultation_offer_options the permitted durations and consultation_timing_policy the two timing keys, each as the whole number (the parameter variants are planted in a rolled-back owner transaction)",
    () => {
      // Each probe edits a seed version's parameters in place (owner, triggers
      // bypassed) inside a transaction that is rolled back, then reads.
      const within = (versionId, parameters, statement, lines = []) => {
        const result = psql(
          [
            "begin;",
            "set local session_replication_role = replica;",
            `update public.policy_versions set parameters = ${lit(parameters)}::jsonb where id = '${versionId}';`,
            "set local session_replication_role = origin;",
            ...lines,
            statement,
            "rollback;",
          ].join("\n"),
        );
        assert.equal(result.status, 0, result.stderr);
        const out = result.stdout
          .trim()
          .split("\n")
          .filter((l) => l !== "" && l !== "t");
        return out[out.length - 1];
      };
      // The JSON text of an object with one whole number written as N.0.
      const fractional = (object, ...keys) =>
        keys.reduce(
          (text, key) =>
            text.replace(
              `"${key}":${object[key]}`,
              `"${key}":${object[key]}.0`,
            ),
          JSON.stringify(object),
        );
      const fee = FEE();
      const quote = JSON.parse(
        within(
          world.policies.S.fee,
          fractional(fee, "quote_validity_seconds"),
          `select row_to_json(q)::text from public.pricing_quote('${world.ann.profile}', '${world.J.S}', 'synthetic_video', 30, now()) q;`,
        ),
      );
      assert.equal(quote.outcome, "priced");
      assert.equal(quote.quote_validity_seconds, 900);
      const scheduling = STANDARD_SCHEDULING;
      const window = JSON.parse(
        within(
          world.policies.S.scheduling,
          fractional(scheduling, "instant_request_response_window_seconds"),
          `select row_to_json(w)::text from public.request_response_window('${world.J.S}', 'instant', now()) w;`,
        ),
      );
      assert.deepEqual(
        [window.outcome, window.window_seconds],
        ["selected", 900],
      );
      const limit = JSON.parse(
        within(
          world.policies.S.referral,
          '{"outcome_codes": ["synthetic_closed"], "request_message_maximum_characters": 2000.0}',
          `select row_to_json(m)::text from public.request_message_limit('${world.policies.S.referral}') m;`,
        ),
      );
      assert.deepEqual(
        [limit.outcome, limit.maximum_characters],
        ["set", 2000],
      );
      const claims = JSON.stringify({
        sub: world.ann.auth,
        role: "authenticated",
        aal: "aal2",
      });
      const options = JSON.parse(
        within(
          world.platform,
          '{"permitted_durations_minutes": [30.0, 60], "permitted_modalities": ["synthetic_video"]}',
          "select row_to_json(o)::text from public.attorney_consultation_offer_options() o;",
          [
            "set local role authenticated;",
            `select set_config('request.jwt.claim.sub', ${lit(world.ann.auth)}, true) is not null;`,
            `select set_config('request.jwt.claims', ${lit(claims)}, true) is not null;`,
          ],
        ),
      );
      assert.deepEqual(options.permitted_durations_minutes, [30, 60]);
      const timing = JSON.parse(
        within(
          world.policies.S.scheduling,
          fractional(
            scheduling,
            "consultation_join_window_seconds",
            "consultation_overrun_seconds",
          ),
          `select row_to_json(t)::text from public.consultation_timing_policy('${world.J.S}', now()) t;`,
        ),
      );
      assert.deepEqual(
        [timing.outcome, timing.join_window_seconds, timing.overrun_seconds],
        ["selected", 600, 300],
      );
      return {
        pricing_quote: quote.quote_validity_seconds,
        request_response_window: window.window_seconds,
        request_message_limit: limit.maximum_characters,
        attorney_consultation_offer_options:
          options.permitted_durations_minutes,
        consultation_timing_policy: [
          timing.join_window_seconds,
          timing.overrun_seconds,
        ],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// GATE: the four-way production gate (MBS section 19; IMP section 29)
// ---------------------------------------------------------------------------

// An approved, active, non-development version with a verified authority
// reference (owner-walked), in either database.
function walkedPolicy(
  db,
  grantor,
  type,
  jurisdiction,
  parameters,
  mode = null,
) {
  const id = uid();
  sql(
    `insert into public.policy_versions (id, policy_type_code, jurisdiction_id, regulatory_mode_id, version_label, parameters, status, effective_from, development_only)
     values ('${id}', ${lit(type)}, ${lit(jurisdiction)}, ${lit(mode)}, ${lit(`synthetic-walked-${type}-${id.slice(0, 8)}`)}, ${lit(parameters)}::jsonb, 'draft', now() - interval '1 day', false);
     insert into public.policy_authority_references (policy_version_id, authority_type, citation_text, source_title, retrieved_at, verified_by_user_id, verification_status)
       values ('${id}', 'synthetic', 'synthetic citation', 'synthetic source', now(), '${grantor}', 'verified');
     update public.policy_versions set status = 'internal_review' where id = '${id}';
     update public.policy_versions set status = 'counsel_review' where id = '${id}';
     update public.policy_versions set status = 'approved', approved_at = now() - interval '2 days', approved_by_user_id = '${grantor}' where id = '${id}';
     update public.policy_versions set status = 'active' where id = '${id}';`,
    db,
  );
  return id;
}

// A jurisdiction for one gate combination (the owner plants the
// combinations the P1 launch boundary would otherwise refuse).
function gateJurisdiction(
  db,
  grantor,
  { live, authorized, policy: withPolicy },
) {
  const id = newJurisdiction(
    `SYN_S11_GATE_${uid().slice(0, 6).toUpperCase()}`,
    db,
    "ready",
  );
  sql(
    [
      "begin;",
      "set local session_replication_role = replica;",
      authorized
        ? `insert into public.launch_authorizations (jurisdiction_id, authorized_at, authorized_by_user_id, reason) values ('${id}', now() - interval '1 day', '${grantor}', 'synthetic launch authorization');`
        : "",
      live
        ? `update public.jurisdictions set lifecycle_state = 'live' where id = '${id}';`
        : "",
      "commit;",
    ].join("\n"),
    db,
  );
  if (withPolicy) {
    walkedPolicy(db, grantor, "refund", id, {});
  }
  return id;
}

const gateOf = (db, jurisdiction, type = "refund", mode = null) =>
  sql(
    `select permitted::text || '|' || reason from public.production_financial_gate('${jurisdiction}', ${lit(type)}, ${lit(mode)}::uuid, now());`,
    db,
  );

// A planted pending payment (owner, triggers bypassed) of a planted instant
// Request whose seven recorded versions are the given ones, in the
// production-class database.
function prodPendingPayment(
  jurisdiction,
  versions,
  { requestState = "created", requestPath = "instant" } = {},
) {
  const client = newAccount("active", PROD_DB);
  const attorneyAccount = newAccount("active", PROD_DB);
  const ids = {
    clientProfile: uid(),
    attorneyProfile: uid(),
    intake: uid(),
    referral: uid(),
    request: uid(),
    fee: uid(),
    payment: uid(),
  };
  prodSql(
    `begin;
     set local session_replication_role = replica;
     insert into public.client_profiles (id, user_id) values ('${ids.clientProfile}', '${client.user}');
     insert into public.attorney_profiles (id, user_id, profile_state, display_name, years_experience) values ('${ids.attorneyProfile}', '${attorneyAccount.user}', 'approved', 'Synthetic Gate Attorney', 5);
     insert into public.intakes (id, client_id, state) values ('${ids.intake}', '${ids.clientProfile}', 'submitted');
     insert into public.referrals (id, intake_id, attorney_id, jurisdiction_id, attempt_ordinal, allocation_method) values ('${ids.referral}', '${ids.intake}', '${ids.attorneyProfile}', '${jurisdiction}', 1, 'client_selected');
     insert into public.consultation_requests (id, intake_id, client_id, selected_attorney_id, referral_id, request_path, referral_policy_version_id, engagement_policy_version_id, requested_modality, requested_duration_minutes, state, response_deadline_at, accepted_at)
       values ('${ids.request}', '${ids.intake}', '${ids.clientProfile}', '${ids.attorneyProfile}', '${ids.referral}', '${requestPath}', '${versions.referral}', '${versions.engagement}', 'synthetic_video', 30, '${requestState}', now() + interval '1 hour', ${requestState === "accepted" ? "now()" : "null"});
     insert into public.fee_calculations (id, consultation_request_id, fee_policy_version_id, attorney_listed_price_minor, platform_fee_minor, client_fee_minor, tax_or_other_required_fee_minor, total_client_amount_minor, currency_code, quote_valid_until, calculated_at, calculation_snapshot)
       values ('${ids.fee}', '${ids.request}', '${versions.fee}', 5000, 500, 175, 50, 5225, 'XTS', now() + interval '1 hour', now(), '{}'::jsonb);
     insert into public.payment_transactions (id, fee_calculation_id, consultation_request_id, jurisdiction_id, regulatory_mode_id, referral_policy_version_id, payment_policy_version_id, fee_policy_version_id, payment_flow_policy_version_id, engagement_policy_version_id, cancellation_policy_version_id, refund_policy_version_id, state, amount_refunded_minor, currency_code, provider_code, provider_payment_reference)
       values ('${ids.payment}', '${ids.fee}', '${ids.request}', '${jurisdiction}', '${versions.mode}', '${versions.referral}', '${versions.payment}', '${versions.fee}', '${versions.payment_flow}', '${versions.engagement}', '${versions.cancellation}', '${versions.refund}', 'pending_authorization', 0, 'XTS', 'stripe', 'cs_test_syn${ids.payment.replaceAll("-", "").slice(0, 20)}');
     commit;`,
  );
  return ids;
}

// The seven walked versions of a production-class jurisdiction, the payment
// flow capturing at the given moment.
function prodVersions(jurisdiction, flow) {
  const mode = newRegulatoryMode(
    `SYN_S11_GM_${uid().slice(0, 6).toUpperCase()}`,
    PROD_DB,
  );
  mapMode(jurisdiction, mode, PROD_DB);
  const g = prod.grantor.user;
  return {
    mode,
    referral: walkedPolicy(PROD_DB, g, "referral", jurisdiction, {
      outcome_codes: ["synthetic_closed"],
    }),
    fee: walkedPolicy(PROD_DB, g, "fee", jurisdiction, FEE()),
    payment_flow: walkedPolicy(
      PROD_DB,
      g,
      "payment_flow",
      jurisdiction,
      flow,
      mode,
    ),
    payment: walkedPolicy(PROD_DB, g, "payment", jurisdiction, {}, mode),
    engagement: walkedPolicy(
      PROD_DB,
      g,
      "engagement",
      jurisdiction,
      STANDARD_ENGAGEMENT,
      mode,
    ),
    cancellation: walkedPolicy(
      PROD_DB,
      g,
      "cancellation",
      jurisdiction,
      {},
      mode,
    ),
    refund: walkedPolicy(PROD_DB, g, "refund", jurisdiction, {}, mode),
  };
}

const authorizationEvent = (ids) =>
  providerEvent(
    "payment_intent.amount_capturable_updated",
    obs("authorization_confirmed", {
      payment_transaction_id: ids.payment,
      payment_reference: paymentRef(),
      amount_minor: 5225,
      currency_code: "XTS",
    }),
    null,
    PROD_DB,
  );

const prodPayment = (id) =>
  JSON.parse(
    prodSql(
      `select json_build_object('state', state, 'authorized', authorized_at is not null)::text from public.payment_transactions where id = '${id}';`,
    ),
  );
const prodJobs = (id) =>
  Number(
    prodSql(
      `select count(*) from public.operational_jobs where subject_id = '${id}' and job_type = 'payment.capture';`,
    ),
  );
const prodGateItems = (id) =>
  JSON.parse(
    prodSql(
      `select coalesce(json_agg(json_build_object('severity', severity, 'status', status, 'evidence', evidence_reference, 'family', public.exception_family(exception_type))), '[]'::json)::text from public.reconciliation_exceptions where exception_type = 'capture_gate_closed' and canonical_id = '${id}';`,
    ),
  );

async function gateChecks() {
  await check(
    "GATE-1 (MBS section 19; IMP section 29) the four-way gate itself under all sixteen combinations of (recorded environment production or not, jurisdiction live or not, an approved active non-development policy selectable or not, an unrevoked launch authorization or not) permits exactly the one all-true combination; every other answers its first failing condition (three of four is not enough)",
    () => {
      const matrix = {};
      for (const production of [true, false]) {
        const db = production ? PROD_DB : DB;
        const grantor = production ? prod.grantor.user : world.grantor.user;
        for (const live of [true, false]) {
          for (const withPolicy of [true, false]) {
            for (const authorized of [true, false]) {
              const jurisdiction = gateJurisdiction(db, grantor, {
                live,
                authorized,
                policy: withPolicy,
              });
              const key = `env=${production ? "production" : "development"} live=${live} policy=${withPolicy} launch=${authorized}`;
              matrix[key] = gateOf(db, jurisdiction);
            }
          }
        }
      }
      const permitted = Object.entries(matrix).filter(([, v]) =>
        v.startsWith("true"),
      );
      assert.deepEqual(permitted, [
        ["env=production live=true policy=true launch=true", "true|permitted"],
      ]);
      for (const [key, value] of Object.entries(matrix)) {
        if (key.startsWith("env=development")) {
          assert.equal(value, "false|environment_not_production", key);
        } else if (key.includes("live=false")) {
          assert.equal(value, "false|jurisdiction_not_live", key);
        } else if (key.includes("policy=false")) {
          assert.equal(value, "false|policy_not_approved", key);
        } else if (key.includes("launch=false")) {
          assert.equal(value, "false|launch_authorization_missing", key);
        }
      }
      return matrix;
    },
  );

  await check(
    "GATE-2 (correction D3) in a production-class database a confirmed authorization whose flow captures at_authorization requests the capture only while the four-way gate holds for every recorded version: with all four conditions the capture is requested (capture_pending, one capture job); in a jurisdiction that is not live the payment stays authorized, no capture is requested, no capture job is created and one critical capture_gate_closed item (financial family) records the problem, the capture moment and the states; nothing is released",
    () => {
      const flow = FLOW_ALL(BEFORE, "at_authorization");
      const open = prodJurisdiction(
        `GO${uid().slice(0, 4).toUpperCase()}`,
        "live",
        "active",
      );
      const openVersions = prodVersions(open.id, flow);
      const openPayment = prodPendingPayment(open.id, openVersions);
      const openEvent = authorizationEvent(openPayment);
      assert.equal(openEvent.processing, "applied", openEvent.line);
      assert.equal(prodPayment(openPayment.payment).state, "capture_pending");
      assert.equal(prodJobs(openPayment.payment), 1);
      assert.deepEqual(prodGateItems(openPayment.payment), []);
      const closed = prodJurisdiction(
        `GC${uid().slice(0, 4).toUpperCase()}`,
        "ready",
        "active",
      );
      const closedVersions = prodVersions(closed.id, flow);
      const closedPayment = prodPendingPayment(closed.id, closedVersions);
      const closedEvent = authorizationEvent(closedPayment);
      assert.equal(closedEvent.processing, "applied", closedEvent.line);
      assert.deepEqual(prodPayment(closedPayment.payment), {
        state: "authorized",
        authorized: true,
      });
      assert.equal(prodJobs(closedPayment.payment), 0);
      const items = prodGateItems(closedPayment.payment);
      assert.equal(items.length, 1);
      assert.deepEqual(
        [items[0].severity, items[0].status, items[0].family],
        ["critical", "open", "financial"],
      );
      assert.deepEqual(items[0].evidence, {
        problem: "production_gate_closed",
        capture: "at_authorization",
        request_state: "awaiting_attorney",
        payment_state: "authorized",
      });
      assert.equal(
        Number(
          prodSql(
            `select count(*) from public.operational_jobs where subject_id = '${closedPayment.payment}' and job_type = 'payment.release';`,
          ),
        ),
        0,
      );
      return { open: "capture_pending", closed: items[0].evidence };
    },
  );

  await check(
    "GATE-3 (correction D3, the second branch) in a production-class database a late authorization of an accepted Request whose flow captures at_attorney_acceptance requests no capture while the gate is closed (a development payment version recorded): the payment stays authorized, no capture job, one critical capture_gate_closed item (development_policy)",
    () => {
      const flow = FLOW_ALL(AT_ACCEPTANCE, "at_attorney_acceptance");
      const live = prodJurisdiction(
        `GL${uid().slice(0, 4).toUpperCase()}`,
        "live",
        "active",
      );
      const versions = prodVersions(live.id, flow);
      versions.payment = prodPlantedDevelopment(
        "payment",
        live.id,
        {},
        versions.mode,
      );
      const ids = prodPendingPayment(live.id, versions, {
        requestState: "accepted",
      });
      const event = authorizationEvent(ids);
      assert.equal(event.processing, "applied", event.line);
      assert.deepEqual(prodPayment(ids.payment), {
        state: "authorized",
        authorized: true,
      });
      assert.equal(prodJobs(ids.payment), 0);
      const items = prodGateItems(ids.payment);
      assert.equal(items.length, 1);
      assert.equal(items[0].evidence.problem, "development_policy");
      assert.equal(items[0].evidence.capture, "at_attorney_acceptance");
      assert.equal(items[0].evidence.request_state, "accepted");
      return items[0].evidence;
    },
  );

  await check(
    "GATE-4 (per-operation negative probe added: the scheduled -> ready transition) in a production-class database a scheduled Consultation whose join window is open does not become ready while the four-way gate for its scheduling version is closed (a jurisdiction that is not live): consultation_ready_if_due answers scheduled and nothing changes; the same Consultation in a live, launch-authorized jurisdiction becomes ready (so the gate, not a blanket refusal, decides)",
    () => {
      // A scheduled Consultation with its confirmed Booking starting in two
      // minutes (the join window is open), planted by the owner with
      // triggers bypassed.
      const plant = (jurisdiction) => {
        const client = newAccount("active", PROD_DB);
        const attorneyAccount = newAccount("active", PROD_DB);
        const c = {
          clientProfile: uid(),
          attorneyProfile: uid(),
          intake: uid(),
          referral: uid(),
          request: uid(),
          consultation: uid(),
          referralPolicy: uid(),
        };
        prodSql(
          `begin;
           set local session_replication_role = replica;
           insert into public.client_profiles (id, user_id) values ('${c.clientProfile}', '${client.user}');
           insert into public.attorney_profiles (id, user_id, profile_state, display_name, years_experience) values ('${c.attorneyProfile}', '${attorneyAccount.user}', 'approved', 'Synthetic Prod Attorney', 5);
           insert into public.intakes (id, client_id, state) values ('${c.intake}', '${c.clientProfile}', 'submitted');
           insert into public.policy_versions (id, policy_type_code, jurisdiction_id, version_label, parameters, status, effective_from, development_only) values ('${c.referralPolicy}', 'referral', '${jurisdiction.id}', 'synthetic-planted-referral-${c.referralPolicy.slice(0, 8)}', '{}'::jsonb, 'draft', now() - interval '1 day', false);
           insert into public.referrals (id, intake_id, attorney_id, jurisdiction_id, attempt_ordinal, allocation_method) values ('${c.referral}', '${c.intake}', '${c.attorneyProfile}', '${jurisdiction.id}', 1, 'client_selected');
           insert into public.consultation_requests (id, intake_id, client_id, selected_attorney_id, referral_id, request_path, referral_policy_version_id, requested_modality, requested_duration_minutes, state, response_deadline_at, accepted_at)
             values ('${c.request}', '${c.intake}', '${c.clientProfile}', '${c.attorneyProfile}', '${c.referral}', 'scheduled', '${c.referralPolicy}', 'synthetic_video', 30, 'accepted', now() + interval '1 hour', now());
           insert into public.consultations (id, consultation_request_id, client_id, attorney_id, request_path, referral_policy_version_id, modality, state)
             values ('${c.consultation}', '${c.request}', '${c.clientProfile}', '${c.attorneyProfile}', 'scheduled', '${c.referralPolicy}', 'synthetic_video', 'scheduled');
           insert into public.bookings (consultation_id, attorney_id, client_id, starts_at, ends_at, status)
             values ('${c.consultation}', '${c.attorneyProfile}', '${c.clientProfile}', date_trunc('second', now()) + interval '120 seconds', date_trunc('second', now()) + interval '1920 seconds', 'confirmed');
           commit;`,
        );
        return c;
      };
      const closed = prodJurisdiction(
        `RC${uid().slice(0, 4).toUpperCase()}`,
        "ready",
        "active",
      );
      const c1 = plant(closed);
      const audits = () =>
        Number(
          prodSql(
            `select count(*) from public.audit_events where resource_id = '${c1.consultation}';`,
          ),
        );
      const before = audits();
      assert.equal(
        prodSql(
          `select public.consultation_ready_if_due('${c1.consultation}');`,
        ),
        "scheduled",
      );
      assert.equal(
        prodSql(
          `select state from public.consultations where id = '${c1.consultation}';`,
        ),
        "scheduled",
      );
      assert.equal(audits(), before);
      const open = prodJurisdiction(
        `RO${uid().slice(0, 4).toUpperCase()}`,
        "live",
        "active",
      );
      const c2 = plant(open);
      assert.equal(
        prodSql(
          `select public.consultation_ready_if_due('${c2.consultation}');`,
        ),
        "ready",
      );
      return { closed: "scheduled", open: "ready" };
    },
  );

  await check(
    "GATE-5 inventory of the production-gated operations and their closed-gate negative probes: existing (S7 PROD-1 payment authorization; S8 PROD-1 and PROD-2 acceptance; S9 PROD-1 media access, start and the room creation job; S9 PROD-2 end; S10 MSG-7 the communication window; S10 NOT-10 critical notification configuration; S11 pass 1 PROD-1 early completion and manual resolution) and added here (GATE-2 and GATE-3 the capture on a confirmed authorization, GATE-4 the scheduled -> ready transition); every gated function in the migrations is in the inventory",
    () => {
      const gated = new Set();
      for (const file of migrationFiles()) {
        const text = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
        const functions = [
          ...text.matchAll(
            /^create (?:or replace )?function public\.([a-z_0-9]+)\(/gm,
          ),
        ];
        for (let i = 0; i < functions.length; i += 1) {
          // The function's own text: from its header to its closing body
          // delimiter.
          const start = functions[i].index;
          const body = text.slice(
            start,
            text.indexOf(
              "\n$function$;",
              text.indexOf("$function$", start) + 10,
            ),
          );
          if (
            /production_financial_gate\(|media_production_problem\(|payment_capture_gate_problem\(/.test(
              body.replace(/--[^\n]*/g, ""),
            )
          ) {
            gated.add(functions[i][1]);
          }
        }
      }
      const inventory = {
        client_authorize_payment: "S7 PROD-1 (existing)",
        attorney_accept_request: "S8 PROD-1, PROD-2 (existing)",
        consultation_media_access: "S9 PROD-1 (existing)",
        consultation_start: "S9 PROD-1 (existing)",
        media_job_context: "S9 PROD-1 room creation job (existing)",
        consultation_end: "S9 PROD-2; S11 PROD-1 (existing)",
        communication_window: "S10 MSG-7 (existing)",
        consultation_apply_completion:
          "S11 PROD-1 early completion and manual resolution (existing)",
        consultation_ready_if_due: "GATE-4 (added)",
        payment_confirm_authorization: "GATE-2, GATE-3 (added)",
        // The gate's own building blocks.
        production_financial_gate: "GATE-1 (added)",
        media_production_problem:
          "helper of the media and completion operations",
        payment_capture_gate_problem: "helper of payment_confirm_authorization",
      };
      for (const name of gated) {
        assert.ok(Object.hasOwn(inventory, name), name);
      }
      return {
        gated: [...gated].sort(),
        inventory,
        notification_configuration:
          "S10 NOT-10 (existing; policy selection, not the financial gate)",
      };
    },
  );
}

// ---------------------------------------------------------------------------
// CONC: real concurrency (two or more persistent sessions)
// ---------------------------------------------------------------------------

// A persistent session whose role and claims hold for the whole session, so
// each statement is its own transaction (the mixed load).
async function persistentAs(label, account, aal = "aal2") {
  const s = await session(label);
  const claims = JSON.stringify({
    sub: account.auth,
    role: "authenticated",
    aal,
  });
  await s.ok("set role authenticated;");
  await s.ok(
    `select set_config('request.jwt.claim.sub', ${lit(account.auth)}, false) is not null;`,
  );
  await s.ok(
    `select set_config('request.jwt.claims', ${lit(claims)}, false) is not null;`,
  );
  return s;
}

async function opsConcurrencyChecks() {
  await check(
    "CONC-1 two staff members removing one profile at the same time: the second waits on the profile row the first holds, and once the first commits it answers locked; the profile is removed once and audited once",
    async () => {
      const x = lawyer("S");
      const a = await attorneySession("c1a", world.verifier);
      const b = await attorneySession("c1b", world.verifierB);
      const first = await a.ok(
        LIFE_SQL(x.profile, "remove", "First synthetic note"),
      );
      const pending = b.send(
        LIFE_SQL(x.profile, "remove", "Second synthetic note"),
      );
      await blockedBy(b.pid, a.pid);
      await a.ok("commit;");
      const second = await pending;
      await b.ok("commit;");
      a.close();
      b.close();
      assert.deepEqual(
        [lastLine(first), second.rows.at(-1)],
        ["applied", "locked"],
      );
      assert.equal(profileState(x.profile), "removed");
      assert.equal(
        count(
          "audit_events",
          `resource_id = '${x.profile}' and action_code = 'attorney_profile_state_changed'`,
        ),
        1,
      );
      report.concurrency.two_removals = {
        first: "applied",
        second: "locked",
        waited: true,
      };
      return report.concurrency.two_removals;
    },
  );

  await check(
    "CONC-2 (PM row 46) a suspension racing a client's Request creation, in both orders: a Request committed first is waited for and then counted (the suspension applies and its review item names the Request); a suspension committed first makes the client's waiting Request creation refused (no Request is created)",
    async () => {
      // Order 1: the client's Request holds its User row first.
      const c1 = newClient();
      const r1 = ownerReferral({
        client: c1,
        lawyer: world.ann,
        jurisdiction: world.J.S,
        requestPath: "instant",
      });
      const client1 = await clientSession("c2client", c1);
      const created = await client1.ok(
        `select outcome || '|' || coalesce(request_id::text, '') from public.request_create(${lit(r1)}, 'instant', 'synthetic_video', 30, null, null::text);`,
      );
      const [outcome1, request1] = lastLine(created).split("|");
      assert.equal(outcome1, "created");
      const staff1 = await attorneySession("c2staff", world.clientAdmin);
      const suspension = staff1.send(
        ACCOUNT_SQL(c1.user, "suspend", "Synthetic note"),
      );
      await blockedBy(staff1.pid, client1.pid);
      await client1.ok("commit;");
      const suspended = await suspension;
      await staff1.ok("commit;");
      client1.close();
      staff1.close();
      assert.equal(suspended.rows.at(-1), "applied");
      const evidence = jsonOf(
        `select evidence_reference::text from public.reconciliation_exceptions where exception_type = 'client_account_review' and source_id = '${c1.user}';`,
      );
      assert.deepEqual(evidence.open_request_ids, [request1]);
      // Order 2: the suspension holds the User row first.
      const c2 = newClient();
      const r2 = ownerReferral({
        client: c2,
        lawyer: world.ann,
        jurisdiction: world.J.S,
        requestPath: "instant",
      });
      const staff2 = await attorneySession("c2staff2", world.clientAdmin);
      assert.equal(
        lastLine(
          await staff2.ok(ACCOUNT_SQL(c2.user, "suspend", "Synthetic note")),
        ),
        "applied",
      );
      const client2 = await clientSession("c2client2", c2);
      const attempt = client2.send(
        `select outcome || '|' || coalesce(request_id::text, '') from public.request_create(${lit(r2)}, 'instant', 'synthetic_video', 30, null, null::text);`,
      );
      await blockedBy(client2.pid, staff2.pid);
      await staff2.ok("commit;");
      const refused = await attempt;
      await client2.ok("commit;");
      staff2.close();
      client2.close();
      const [outcome2] = (refused.rows.at(-1) ?? "").split("|");
      assert.notEqual(outcome2, "created");
      assert.equal(
        count("consultation_requests", `client_id = '${c2.client}'`),
        0,
      );
      assert.equal(
        count(
          "reconciliation_exceptions",
          `exception_type = 'client_account_review' and source_id = '${c2.user}'`,
        ),
        0,
      );
      report.concurrency.suspension_race = {
        request_first: {
          request: "created",
          suspension: "applied",
          review_item: "names the Request",
        },
        suspension_first: { suspension: "applied", request: outcome2 },
      };
      return report.concurrency.suspension_race;
    },
  );

  await check(
    "CONC-3 (MB section 19) an approval racing the rejoin detection of the application's submission: the approval waits on the profile row the submission holds and, once the submission commits with its rejoin item, answers review_required; the profile stays under review and exactly one item exists",
    async () => {
      const suffix = uid().slice(0, 6).toUpperCase();
      const q = profileWith({
        stage: "approved",
        licences: [[world.J.S, `SYN-RACE-${suffix}`]],
      });
      const p = profileWith({ stage: "applicant" });
      assert.equal(
        asStaff(p, SAVE_LICENSE_SQL(world.J.S, `syn race ${suffix}`)),
        "applied",
      );
      assert.equal(lifecycle(world.verifier, q.profile, "remove"), "applied");
      const attorneyS = await attorneySession("c3attorney", p);
      assert.equal(lastLine(await attorneyS.ok(SUBMIT_SQL)), "applied");
      const staffS = await attorneySession("c3staff", world.verifierB);
      const approval = staffS.send(STAGE_SQL(p.profile, "approve"));
      await blockedBy(staffS.pid, attorneyS.pid);
      await attorneyS.ok("commit;");
      const answer = await approval;
      await staffS.ok("commit;");
      attorneyS.close();
      staffS.close();
      assert.equal(answer.rows.at(-1), "review_required");
      assert.equal(profileState(p.profile), "under_review");
      assert.equal(rejoinItems(p.profile).length, 1);
      report.concurrency.approval_rejoin = {
        submission: "applied",
        approval: "review_required",
        items: 1,
      };
      return report.concurrency.approval_rejoin;
    },
  );

  await check(
    "CONC-4 two resolutions of one compliance review item at the same time: the second waits on the item the first holds and, once the first commits, answers invalid_transition; the item is resolved once with the first notes",
    async () => {
      const suffix = uid().slice(0, 6).toUpperCase();
      profileWith({
        stage: "approved",
        licences: [[world.J.S, `SYN-RES-${suffix}`]],
      });
      const q = sql(
        `select attorney_id from public.licenses where license_number = 'SYN-RES-${suffix}';`,
      );
      assert.equal(lifecycle(world.verifier, q, "remove"), "applied");
      const p = profileWith({ stage: "applicant" });
      assert.equal(
        asStaff(p, SAVE_LICENSE_SQL(world.J.S, `syn-res-${suffix}`)),
        "applied",
      );
      const item = rejoinItems(p.profile)[0].id;
      const a = await attorneySession("c4a", world.compliance);
      const b = await attorneySession("c4b", world.complianceB);
      assert.equal(
        lastLine(await a.ok(RESOLVE_SQL(item, "First synthetic notes"))),
        "applied",
      );
      const pending = b.send(RESOLVE_SQL(item, "Second synthetic notes"));
      await blockedBy(b.pid, a.pid);
      await a.ok("commit;");
      const second = await pending;
      await b.ok("commit;");
      a.close();
      b.close();
      assert.equal(second.rows.at(-1), "invalid_transition");
      assert.equal(
        sql(
          `select status || '|' || resolution_notes from public.reconciliation_exceptions where id = '${item}';`,
        ),
        "resolved|First synthetic notes",
      );
      report.concurrency.two_resolutions = {
        first: "applied",
        second: "invalid_transition",
      };
      return report.concurrency.two_resolutions;
    },
  );

  await check(
    "CONC-5 mixed load: eight persistent sessions run audit reads, the operations summary, compliance reads, referral and finance reads, client suspensions and reactivations of distinct clients and attorney removals of distinct profiles at the same time; every statement completes with zero deadlocks and zero lock timeouts",
    async () => {
      const clients = Array.from({ length: 6 }, () => newClient());
      const attorneys = Array.from({ length: 6 }, () => lawyer("S"));
      const sessions = {
        auditor: await persistentAs("m-auditor", world.auditor),
        operator: await persistentAs("m-operator", world.operator),
        verifier: await persistentAs("m-verifier", world.verifier),
        verifierB: await persistentAs("m-verifierB", world.verifierB),
        clientAdmin: await persistentAs("m-clients", world.clientAdmin),
        clientAdminB: await persistentAs("m-clientsB", world.clientAdminB),
        referrals: await persistentAs("m-referrals", world.referralViewer),
        finance: await persistentAs("m-finance", world.finance),
      };
      const from = new Date(Date.now() - DAY_MS).toISOString();
      const until = new Date(Date.now() + DAY_MS).toISOString();
      const plans = {
        auditor: Array.from({ length: 6 }, () =>
          AUDIT_SQL({ resourceType: "synthetic_probe" }),
        ),
        operator: Array.from({ length: 6 }, () => OPS_SQL),
        verifier: attorneys
          .slice(0, 3)
          .flatMap((x) => [
            LIFE_SQL(x.profile, "remove", "Synthetic load note"),
            RECORDS_SQL("removed"),
          ]),
        verifierB: attorneys
          .slice(3)
          .flatMap((x) => [
            LIFE_SQL(x.profile, "remove", "Synthetic load note"),
            COMPLIANCE_SUMMARY_SQL,
          ]),
        clientAdmin: clients
          .slice(0, 3)
          .flatMap((c) => [
            ACCOUNT_SQL(c.user, "suspend", "Load note"),
            ACCOUNT_SQL(c.user, "reactivate", "Load note"),
          ]),
        clientAdminB: clients
          .slice(3)
          .flatMap((c) => [
            ACCOUNT_SQL(c.user, "suspend", "Load note"),
            CLIENTS_SQL(),
          ]),
        referrals: Array.from({ length: 6 }, (_, i) =>
          i % 2 === 0 ? REFERRALS_SQL() : REFERRAL_COUNTS_SQL,
        ),
        finance: Array.from({ length: 6 }, () => FINANCE_SQL(from, until)),
      };
      const states = [];
      await Promise.all(
        Object.entries(plans).map(async ([name, statements]) => {
          for (const statement of statements) {
            const result = await sessions[name].send(statement);
            states.push(result.sqlstate);
          }
        }),
      );
      for (const s of Object.values(sessions)) {
        s.close();
      }
      const deadlocks = states.filter((s) => s === "40P01").length;
      const timeouts = states.filter((s) => s === "55P03").length;
      assert.equal(deadlocks, 0);
      assert.equal(timeouts, 0);
      assert.ok(
        states.every((s) => s === "00000"),
        JSON.stringify(states),
      );
      assert.ok(attorneys.every((x) => profileState(x.profile) === "removed"));
      assert.deepEqual(
        clients.map((c) => accountState(c.user)),
        ["active", "active", "active", "suspended", "suspended", "suspended"],
      );
      report.concurrency.mixed_load = {
        sessions: Object.keys(sessions).length,
        statements: states.length,
        deadlocks,
        lock_timeouts: timeouts,
      };
      return report.concurrency.mixed_load;
    },
  );
}

// ---------------------------------------------------------------------------
// MVP-001 S11 pass 2B: the participants' workspace reads (MBS sections 18.2,
// 18.3 and 18.6)
// ---------------------------------------------------------------------------

// The six reads of the workspace reads migration and their volatility.
const SURFACE_API = Object.freeze({
  "client_payments(integer)": "s",
  "client_account_overview()": "s",
  "consultation_threads(text)": "s",
  "attorney_consultation_history()": "s",
  "attorney_documents()": "s",
  "attorney_compliance_records()": "s",
});
const CLIENT_PAYMENTS_SQL = (offset = 0) =>
  `select row_to_json(x)::text from public.client_payments(${offset === null ? "null" : offset}) x;`;
const OVERVIEW_SQL =
  "select row_to_json(x)::text from public.client_account_overview() x;";
const THREADS_SQL = (role) =>
  `select row_to_json(x)::text from public.consultation_threads(${role === null ? "null::text" : lit(role)}) x;`;
const HISTORY_SQL =
  "select row_to_json(x)::text from public.attorney_consultation_history() x;";
const DOCUMENTS_SQL =
  "select row_to_json(x)::text from public.attorney_documents() x;";
const OWN_COMPLIANCE_SQL =
  "select row_to_json(x)::text from public.attorney_compliance_records() x;";
const EVERY_SURFACE_READ = Object.freeze([
  CLIENT_PAYMENTS_SQL(0),
  OVERVIEW_SQL,
  THREADS_SQL("client"),
  THREADS_SQL("attorney"),
  HISTORY_SQL,
  DOCUMENTS_SQL,
  OWN_COMPLIANCE_SQL,
]);

// A caller every read answers nothing: no answer row for any of the six.
function answersNothing(account, options = {}) {
  return EVERY_SURFACE_READ.every(
    (statement) => rowsJson(account, statement, options).length === 0,
  );
}

const ownPaymentIds = (client) =>
  sql(
    `select coalesce(string_agg(pt.id::text, ',' order by pt.created_at desc, pt.id desc), '') from public.payment_transactions pt join public.consultation_requests r on r.id = pt.consultation_request_id where r.client_id = '${client.client}';`,
  )
    .split(",")
    .filter((id) => id !== "");

async function surfacesChecks() {
  await check(
    "SURF-0 (Packet rules 8 and 16) the pass 2B migration follows pass 2A, is registered unreviewed (sequence 71, depending on the last pass 2A migration, with a rollback plan) and applied nowhere, is a Program migration ref, applies to a development and a production-class database without notices, creates exactly the six workspace reads and nothing else (no relation, column, type, constraint, index, row policy, policy type or table grant: the catalog equals the catalog after pass 1 in every listing; no insert, update or delete), and every read is stable security definer with search_path pg_catalog, pg_temp, executable by authenticated only and takes no identifier argument",
    () => {
      assert.deepEqual(report.migrations.s11_surfaces, [
        ...S11_SURFACES_MIGRATIONS,
      ]);
      assert.deepEqual(
        report.migrations.surface_notices,
        Object.fromEntries(S11_SURFACES_MIGRATIONS.map((file) => [file, []])),
      );
      const differences = {};
      for (const [name, query] of Object.entries(CATALOG_QUERIES)) {
        if (sql(query, BASE_DB) !== sql(query)) {
          differences[name] = true;
        }
      }
      assert.deepEqual(differences, {});
      const created = new Set();
      for (const file of S11_SURFACES_MIGRATIONS) {
        const raw = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
        const text = raw.replace(/--[^\n]*/g, "");
        assert.doesNotMatch(
          text,
          /create\s+table|add\s+column|create\s+type|create\s+policy|create\s+view|create\s+sequence|create\s+(unique\s+)?index|alter\s+table|create\s+trigger|insert\s+into|update\s+public\.|delete\s+from|grant\s+(?!execute)/i,
          file,
        );
        for (const match of raw.matchAll(
          /^create (?:or replace )?function public\.([a-z_0-9]+)\(/gm,
        )) {
          created.add(match[1]);
        }
      }
      assert.deepEqual(
        [...created].sort(),
        Object.keys(SURFACE_API)
          .map((signature) => signature.slice(0, signature.indexOf("(")))
          .sort(),
      );
      const detail = {};
      for (const [signature, volatility] of Object.entries(SURFACE_API)) {
        assert.equal(opsExecutors(signature), "authenticated", signature);
        assert.equal(opsExecutors(signature, PROD_DB), "authenticated");
        const [definer, config, kind, args] = sql(
          `select prosecdef::text || '|' || coalesce(array_to_string(proconfig, ';'), '') || '|' || provolatile::text || '|' || pg_get_function_identity_arguments(oid) from pg_proc where oid = 'public.${signature}'::regprocedure;`,
        ).split("|");
        assert.equal(definer, "true", signature);
        assert.equal(config, "search_path=pg_catalog, pg_temp", signature);
        assert.equal(kind, volatility, signature);
        assert.doesNotMatch(args, /uuid/, signature);
        detail[signature] = args === "" ? "no arguments" : args;
      }
      return detail;
    },
  );

  await check(
    "SURF-1 (MBS section 18.2 payments) client_payments answers exactly the caller's own payment attempts, newest first, with exactly the attempt and Request ids, state, client total, currency, authorized, captured and refunded amounts and creation (each equal to the recorded attempt and its Fee Calculation); an offset pages them and one outside 0 to 100000 (or none) answers nothing; another client, an attorney, staff, a suspended client and a caller without a User answer nothing of them; anon and service_role cannot execute it (42501)",
    () => {
      const first = authorizedRequest({
        jurisdiction: world.J.S,
        requestPath: "instant",
      });
      const client = first.client;
      const second = capturedPayment({ jurisdiction: world.J.A });
      const third = authorizedRequest({
        jurisdiction: world.J.C,
        requestPath: "instant",
        client,
      });
      const rows = rowsJson(client, CLIENT_PAYMENTS_SQL(0), AAL1);
      assert.equal(
        keysOf(rows[0]),
        "amount_authorized_minor,amount_captured_minor,amount_refunded_minor,consultation_request_id,created_at,currency_code,payment_state,payment_transaction_id,total_client_amount_minor",
      );
      assert.deepEqual(
        rows.map((r) => r.payment_transaction_id),
        ownPaymentIds(client),
      );
      assert.deepEqual(
        new Set(rows.map((r) => r.payment_transaction_id)),
        new Set([first.payment, third.payment]),
      );
      for (const row of rows) {
        const recorded = paymentOf(row.payment_transaction_id);
        assert.equal(row.payment_state, recorded.state);
        assert.equal(
          row.consultation_request_id,
          recorded.consultation_request_id,
        );
        assert.equal(row.currency_code, recorded.currency_code);
        assert.equal(
          row.amount_authorized_minor,
          recorded.amount_authorized_minor,
        );
        assert.equal(row.amount_captured_minor, recorded.amount_captured_minor);
        assert.equal(row.amount_refunded_minor, recorded.amount_refunded_minor);
        assert.equal(
          row.total_client_amount_minor,
          Number(
            sql(
              `select total_client_amount_minor from public.fee_calculations where id = '${recorded.fee_calculation_id}';`,
            ),
          ),
        );
      }
      assert.deepEqual(
        rowsJson(client, CLIENT_PAYMENTS_SQL(1), AAL1),
        rows.slice(1),
      );
      for (const offset of [25, -1, 100001, null]) {
        assert.deepEqual(
          rowsJson(client, CLIENT_PAYMENTS_SQL(offset), AAL1),
          [],
          String(offset),
        );
      }
      assert.match(
        sql(
          "select pg_get_functiondef('public.client_payments(integer)'::regprocedure);",
        ),
        /limit 26;/,
      );
      const otherRows = rowsJson(second.client, CLIENT_PAYMENTS_SQL(0), AAL1);
      assert.deepEqual(
        otherRows.map((r) => r.payment_transaction_id),
        [second.payment],
      );
      assert.equal(otherRows[0].payment_state, "captured");
      const suspended = authorizedRequest({
        jurisdiction: world.J.S,
        requestPath: "instant",
      }).client;
      sql(
        `update public.users set account_state = 'suspended' where id = '${suspended.user}';`,
      );
      for (const account of [
        world.ann,
        world.finance,
        suspended,
        newAccount(),
      ]) {
        assert.deepEqual(rowsJson(account, CLIENT_PAYMENTS_SQL(0), AAL1), []);
        assert.deepEqual(rowsJson(account, CLIENT_PAYMENTS_SQL(0)), []);
      }
      assert.deepEqual(
        rowsAs("authenticated", uid(), CLIENT_PAYMENTS_SQL(0), AAL1),
        [],
      );
      assert.deepEqual(apiRefusals(CLIENT_PAYMENTS_SQL(0)), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      world.surfaceClient = { client, first, third };
      return {
        own: rows.length,
        states: rows.map((r) => r.payment_state),
        other: otherRows.length,
      };
    },
  );

  await check(
    "SURF-2 (MBS section 18.2 privacy and data controls) client_account_overview answers one row of the caller's own account (display name, state, creation) and exactly the counts of its Intakes, Requests, Consultations, stored uploaded documents, visible sent Messages, payment attempts and Complaint Cases (each equal to an owner count; another participant's records are not counted); counts only, no identifier or content; an attorney, staff, a suspended client and a caller without a User answer nothing; anon and service_role cannot execute it (42501)",
    () => {
      const s = acceptedConsultation({
        key: "S",
        who: world.ann,
        requestPath: "instant",
      });
      assert.equal(clientSend(s, "Synthetic client message").outcome, "sent");
      assert.equal(attorneySend(s, "Synthetic attorney reply").outcome, "sent");
      uploadDocument(s.client, s.consultation, AAL1);
      uploadDocument(s.lawyer, s.consultation);
      assert.equal(
        asClient(s.client, COMPLAINT_SQL(s.consultation, null)).split("|")[0],
        "opened",
      );
      const row = oneRowAs(s.client, OVERVIEW_SQL, AAL1);
      assert.equal(
        keysOf(row),
        "account_state,complaints,consultations,created_at,display_name,documents,intakes,messages,payments,requests",
      );
      const owner = (query) => Number(sql(query));
      const expected = {
        intakes: owner(
          `select count(*) from public.intakes where client_id = '${s.client.client}';`,
        ),
        requests: owner(
          `select count(*) from public.consultation_requests where client_id = '${s.client.client}';`,
        ),
        consultations: owner(
          `select count(*) from public.consultations where client_id = '${s.client.client}';`,
        ),
        documents: owner(
          `select count(*) from public.resources where owner_user_id = '${s.client.user}' and resource_kind = 'document' and visibility_state = 'available';`,
        ),
        messages: owner(
          `select count(*) from public.messages where sender_user_id = '${s.client.user}' and visibility_state = 'visible';`,
        ),
        payments: owner(
          `select count(*) from public.payment_transactions pt join public.consultation_requests r on r.id = pt.consultation_request_id where r.client_id = '${s.client.client}';`,
        ),
        complaints: owner(
          `select count(*) from public.complaint_cases where complainant_user_id = '${s.client.user}';`,
        ),
      };
      const counts = Object.fromEntries(
        Object.keys(expected).map((key) => [key, row[key]]),
      );
      assert.deepEqual(counts, expected);
      assert.deepEqual(counts, {
        intakes: 1,
        requests: 1,
        consultations: 1,
        documents: 1,
        messages: 1,
        payments: 1,
        complaints: 1,
      });
      assert.equal(row.account_state, "active");
      assert.equal(row.display_name, null);
      const suspended = newClient();
      sql(
        `update public.users set account_state = 'suspended' where id = '${suspended.user}';`,
      );
      for (const account of [
        world.ann,
        world.finance,
        suspended,
        newAccount(),
      ]) {
        assert.equal(oneRowAs(account, OVERVIEW_SQL, AAL1), null);
      }
      assert.deepEqual(apiRefusals(OVERVIEW_SQL), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      world.surfaceThread = s;
      return counts;
    },
  );

  await check(
    "SURF-3 (MBS sections 18.2 and 18.3 messages) consultation_threads answers the caller's own Consultation threads for the role named: for 'client' the client's Consultations, for 'attorney' the approved attorney's at aal2; each row exactly the Consultation id and state, the messaging status the communication window reports (equal to consultation_messaging), the visible Message count, the latest Message instant and whether the caller sent it (no body, nothing of the counterpart); an attorney at aal1, a role the caller does not hold, an unknown or missing role, another client and a caller without a User answer nothing of them; anon and service_role cannot execute it (42501)",
    () => {
      const s = world.surfaceThread;
      const clientRows = rowsJson(s.client, THREADS_SQL("client"), AAL1);
      assert.equal(
        keysOf(clientRows[0]),
        "consultation_id,consultation_state,last_message_at,last_message_mine,message_count,messaging_status",
      );
      assert.deepEqual(
        clientRows.map((r) => r.consultation_id),
        [s.consultation],
      );
      const last = sql(
        `select to_json(max(sent_at))::text from public.messages where consultation_id = '${s.consultation}' and visibility_state = 'visible';`,
      );
      const clientRow = clientRows[0];
      assert.equal(clientRow.message_count, 2);
      assert.equal(clientRow.last_message_mine, false);
      assert.equal(
        new Date(clientRow.last_message_at).getTime(),
        new Date(JSON.parse(last)).getTime(),
      );
      assert.equal(
        clientRow.consultation_state,
        consultationRow(s.consultation).state,
      );
      assert.equal(
        clientRow.messaging_status,
        messagingAs(s.client, s.consultation, AAL1).status,
      );
      const attorneyRows = rowsJson(s.lawyer, THREADS_SQL("attorney"));
      const attorneyRow = attorneyRows.find(
        (r) => r.consultation_id === s.consultation,
      );
      assert.ok(attorneyRow);
      assert.equal(attorneyRow.last_message_mine, true);
      assert.equal(attorneyRow.message_count, 2);
      assert.equal(
        attorneyRow.messaging_status,
        messagingAs(s.lawyer, s.consultation).status,
      );
      const attorneyOwn = sql(
        `select coalesce(string_agg(id::text, ',' order by id), '') from public.consultations where attorney_id = '${world.ann.profile}';`,
      ).split(",");
      assert.deepEqual(
        attorneyRows.map((r) => r.consultation_id).sort(),
        attorneyOwn.slice(0, 200).sort(),
      );
      const times = attorneyRows
        .map((r) => r.last_message_at)
        .filter((t) => t !== null)
        .map((t) => new Date(t).getTime());
      assert.deepEqual(
        times,
        [...times].sort((a, b) => b - a),
      );
      assert.deepEqual(rowsJson(s.lawyer, THREADS_SQL("attorney"), AAL1), []);
      assert.deepEqual(rowsJson(s.client, THREADS_SQL("attorney"), AAL1), []);
      assert.deepEqual(rowsJson(s.client, THREADS_SQL("attorney")), []);
      assert.deepEqual(rowsJson(s.lawyer, THREADS_SQL("client")), []);
      for (const role of ["staff", "Client", "", null]) {
        assert.deepEqual(
          rowsJson(s.client, THREADS_SQL(role), AAL1),
          [],
          String(role),
        );
      }
      const other = newClient();
      assert.deepEqual(rowsJson(other, THREADS_SQL("client"), AAL1), []);
      assert.deepEqual(rowsJson(newAccount(), THREADS_SQL("client"), AAL1), []);
      assert.deepEqual(rowsJson(world.finance, THREADS_SQL("attorney")), []);
      assert.deepEqual(apiRefusals(THREADS_SQL("client")), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      return {
        client: clientRow.messaging_status,
        attorney_threads: attorneyRows.length,
      };
    },
  );

  await check(
    "SURF-4 (MBS section 18.3 consultations) attorney_consultation_history answers exactly the caller's own ended Consultations (completed, cancelled, no_show, technical_failure), most recent first, with exactly the columns of client_consultations and the same values the client's list answers for the same Consultation; Consultations not ended stay in attorney_consultations and out of the history; an attorney at aal1, another attorney, the client, staff and a caller without a User answer nothing of them; anon and service_role cannot execute it (42501)",
    () => {
      const who = lawyer("S");
      const ended = acceptedConsultation({
        key: "S",
        who,
        requestPath: "scheduled",
      });
      const open = acceptedConsultation({
        key: "S",
        who,
        requestPath: "scheduled",
      });
      clientCancel(ended);
      assert.equal(consultationRow(ended.consultation).state, "cancelled");
      const history = rowsJson(who, HISTORY_SQL);
      assert.deepEqual(
        history.map((r) => r.consultation_id),
        [ended.consultation],
      );
      const clientRow = rowsJson(
        ended.client,
        "select row_to_json(x)::text from public.client_consultations() x;",
        AAL1,
      ).find((r) => r.consultation_id === ended.consultation);
      assert.deepEqual(history[0], clientRow);
      assert.equal(history[0].state, "cancelled");
      assert.notEqual(history[0].ended_at, null);
      // The ended Consultation's thread reads as closed, exactly as
      // consultation_messaging reports it.
      const endedThread = rowsJson(
        ended.client,
        THREADS_SQL("client"),
        AAL1,
      ).find((r) => r.consultation_id === ended.consultation);
      assert.equal(endedThread.messaging_status, "closed");
      assert.equal(
        endedThread.messaging_status,
        messagingAs(ended.client, ended.consultation, AAL1).status,
      );
      const current = rowsJson(
        who,
        "select row_to_json(x)::text from public.attorney_consultations() x;",
      ).map((r) => r.consultation_id);
      assert.deepEqual(current, [open.consultation]);
      const terminal = sql(
        `select coalesce(string_agg(id::text, ',' order by id), '') from public.consultations where attorney_id = '${world.ann.profile}' and state in ('completed', 'cancelled', 'no_show', 'technical_failure');`,
      )
        .split(",")
        .filter((id) => id !== "");
      const annHistory = rowsJson(world.ann, HISTORY_SQL);
      assert.deepEqual(
        annHistory.map((r) => r.consultation_id).sort(),
        terminal.slice(0, 200).sort(),
      );
      assert.ok(
        !annHistory.some((r) => r.consultation_id === ended.consultation),
      );
      const order = annHistory.map((r) =>
        new Date(r.ended_at ?? r.booking_starts_at).getTime(),
      );
      assert.deepEqual(
        order,
        [...order].sort((a, b) => b - a),
      );
      assert.deepEqual(rowsJson(who, HISTORY_SQL, AAL1), []);
      for (const account of [ended.client, world.ops, newAccount()]) {
        assert.deepEqual(rowsJson(account, HISTORY_SQL), []);
      }
      assert.deepEqual(apiRefusals(HISTORY_SQL), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      world.surfaceLawyer = who;
      return { ended: history.length, ann: annHistory.length };
    },
  );

  await check(
    "SURF-5 (MBS section 18.3 documents) attorney_documents answers the current document versions the caller may see across their own Consultations, exactly as consultation_documents answers them per Consultation (the attorney's uploads and the client's uploads shared with the attorney), newest first, with exactly the Consultation and Document ids, version label, type, size, creation, uploader, whether the attorney uploaded it, sharing state and whether it opens now (no storage path, no content); an attorney at aal1, another attorney, the client, staff and a caller without a User answer nothing of them; anon and service_role cannot execute it (42501)",
    () => {
      const who = world.surfaceLawyer;
      const d = acceptedConsultation({
        key: "S",
        who,
        requestPath: "instant",
      });
      const mineResource = uploadDocument(d.lawyer, d.consultation);
      const theirsResource = uploadDocument(d.client, d.consultation, AAL1);
      const rows = rowsJson(who, DOCUMENTS_SQL);
      assert.equal(
        keysOf(rows[0]),
        "accessible,byte_size,consultation_id,created_at,document_id,mime_type,mine,sharing,uploaded_by,version_label",
      );
      const consultations = sql(
        `select coalesce(string_agg(id::text, ','), '') from public.consultations where attorney_id = '${who.profile}';`,
      ).split(",");
      const expected = consultations.flatMap((c) =>
        rowsJson(
          who,
          `select row_to_json(x)::text from public.consultation_documents(${lit(c)}) x;`,
        ).map((r) => ({
          accessible: r.accessible,
          byte_size: r.byte_size,
          consultation_id: c,
          created_at: r.created_at,
          document_id: r.document_id,
          mime_type: r.mime_type,
          mine: r.mine,
          sharing: r.sharing,
          uploaded_by: r.uploaded_by,
          version_label: r.version_label,
        })),
      );
      const byId = (list) =>
        [...list].sort((a, b) => a.document_id.localeCompare(b.document_id));
      assert.deepEqual(byId(rows), byId(expected));
      const times = rows.map((r) => new Date(r.created_at).getTime());
      assert.deepEqual(
        times,
        [...times].sort((a, b) => b - a),
      );
      const mine = rows.find(
        (r) => r.document_id === documentIdOf(mineResource),
      );
      const theirs = rows.find(
        (r) => r.document_id === documentIdOf(theirsResource),
      );
      assert.equal(mine.mine, true);
      assert.equal(mine.uploaded_by, "attorney");
      assert.equal(theirs.mine, false);
      assert.equal(theirs.uploaded_by, "client");
      assert.equal(theirs.sharing, "active");
      assert.equal(theirs.accessible, true);
      assert.deepEqual(rowsJson(who, DOCUMENTS_SQL, AAL1), []);
      const ann = rowsJson(world.ann, DOCUMENTS_SQL).map((r) => r.document_id);
      assert.ok(!ann.includes(mine.document_id));
      assert.ok(!ann.includes(theirs.document_id));
      for (const account of [d.client, world.ops, newAccount()]) {
        assert.deepEqual(rowsJson(account, DOCUMENTS_SQL), []);
        assert.deepEqual(rowsJson(account, DOCUMENTS_SQL, AAL1), []);
      }
      assert.deepEqual(apiRefusals(DOCUMENTS_SQL), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      return { documents: rows.length };
    },
  );

  await check(
    "SURF-6 (MBS section 18.3 compliance) attorney_compliance_records answers exactly the caller's own licences and insurance records (validity dates; the date the latest evidence reaches the in-force Eligibility policy's stated age, equal to the staff evidence_age section and to the retrieval date plus the configured days, null without evidence) and the discipline findings recorded about the caller (a lower-snake status or null, opened and resolved dates), with no number, carrier, reference or evidence content; the applicant, under_review and approved stages are answered and a suspended or removed profile, an attorney at aal1, another attorney, a client, staff and a caller without a User answer nothing of them; anon and service_role cannot execute it (42501)",
    () => {
      const who = lawyer("S", "C");
      const insurance = uid();
      const finding = uid();
      const unnamed = uid();
      sql(
        `insert into public.insurance_records (id, attorney_id, jurisdiction_id, carrier_name, coverage_from, coverage_until) values ('${insurance}', '${who.profile}', '${world.J.S}', 'Synthetic Carrier', '2026-01-01', '2027-01-01');
         insert into public.discipline_records (id, attorney_id, jurisdiction_id, external_reference, finding_type, opened_at, resolved_at, status) values ('${finding}', '${who.profile}', '${world.J.S}', 'synthetic-ref', 'synthetic_finding', '2026-03-01', '2026-04-01', 'synthetic_cleared');
         insert into public.discipline_records (id, attorney_id, jurisdiction_id, opened_at, status) values ('${unnamed}', '${who.profile}', '${world.J.C}', '2026-05-01', 'Synthetic Free Text');`,
      );
      const rows = rowsJson(who, OWN_COMPLIANCE_SQL);
      assert.equal(
        keysOf(rows[0]),
        "ends_on,evidence_lapses_on,jurisdiction_id,record_id,record_kind,recorded_at,starts_on,status_code",
      );
      const licences = sql(
        `select coalesce(string_agg(id::text, ',' order by id), '') from public.licenses where attorney_id = '${who.profile}';`,
      ).split(",");
      assert.deepEqual(
        rows.map((r) => r.record_id).sort(),
        [...licences, insurance, finding, unnamed].sort(),
      );
      assert.deepEqual(
        rows.map((r) => r.record_kind),
        ["license", "license", "insurance", "discipline", "discipline"],
      );
      // Every page of the staff evidence_age section (records without
      // evidence come first).
      const staffAge = [];
      for (let offset = 0; offset < 5000; offset += 25) {
        const page = rowsJson(
          world.verifier,
          RECORDS_SQL("evidence_age", offset),
        );
        staffAge.push(...page.slice(0, 25));
        if (page.length <= 25) {
          break;
        }
      }
      for (const row of rows.filter((r) => r.record_kind === "license")) {
        const staffRow = staffAge.find((r) => r.record_id === row.record_id);
        assert.ok(staffRow, row.record_id);
        assert.equal(row.evidence_lapses_on, staffRow.lapses_on);
        assert.notEqual(row.evidence_lapses_on, null);
        const retrieved = new Date(staffRow.recorded_at);
        const expected = new Date(
          Date.UTC(
            retrieved.getUTCFullYear(),
            retrieved.getUTCMonth(),
            retrieved.getUTCDate(),
          ) +
            30 * DAY_MS,
        )
          .toISOString()
          .slice(0, 10);
        assert.equal(row.evidence_lapses_on, expected);
        assert.equal(row.status_code, null);
      }
      const insuranceRow = rows.find((r) => r.record_id === insurance);
      assert.deepEqual(
        [
          insuranceRow.starts_on,
          insuranceRow.ends_on,
          insuranceRow.evidence_lapses_on,
          insuranceRow.status_code,
        ],
        ["2026-01-01", "2027-01-01", null, null],
      );
      const findingRow = rows.find((r) => r.record_id === finding);
      assert.deepEqual(
        [
          findingRow.status_code,
          findingRow.starts_on,
          findingRow.ends_on,
          findingRow.evidence_lapses_on,
        ],
        ["synthetic_cleared", "2026-03-01", "2026-04-01", null],
      );
      assert.equal(rows.find((r) => r.record_id === unnamed).status_code, null);
      const text = JSON.stringify(rows);
      assert.doesNotMatch(
        text,
        /SYN-S11-LIC|Synthetic Carrier|synthetic-ref|synthetic_finding|Synthetic Free Text/,
      );
      const applicant = profileWith({
        stage: "applicant",
        licences: [[world.J.S, `SYN-AP-${uid().slice(0, 6)}`, "2027-06-30"]],
      });
      const applicantRows = rowsJson(applicant, OWN_COMPLIANCE_SQL);
      assert.deepEqual(
        applicantRows.map((r) => [
          r.record_id,
          r.ends_on,
          r.evidence_lapses_on,
        ]),
        [[applicant.licences[0], "2027-06-30", null]],
      );
      for (const stage of ["suspended", "removed"]) {
        const held = profileWith({
          stage,
          licences: [[world.J.S, `SYN-HD-${uid().slice(0, 6)}`]],
        });
        assert.deepEqual(rowsJson(held, OWN_COMPLIANCE_SQL), [], stage);
      }
      assert.deepEqual(rowsJson(who, OWN_COMPLIANCE_SQL, AAL1), []);
      const ann = rowsJson(world.ann, OWN_COMPLIANCE_SQL).map(
        (r) => r.record_id,
      );
      assert.ok(
        !ann.some((id) =>
          [...licences, insurance, finding, unnamed].includes(id),
        ),
      );
      for (const account of [newClient(), world.verifier, newAccount()]) {
        assert.deepEqual(rowsJson(account, OWN_COMPLIANCE_SQL), []);
      }
      assert.deepEqual(apiRefusals(OWN_COMPLIANCE_SQL), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      return {
        kinds: rows.map((r) => r.record_kind),
        evidence_lapses_on: rows
          .filter((r) => r.record_kind === "license")
          .map((r) => r.evidence_lapses_on),
      };
    },
  );

  await check(
    "SURF-7 (MBS section 18.6 guessed identifiers and manipulated client state) none of the six reads takes an identifier, so no guessed id can name another person's record; every one answers nothing to a request subject that names no User, to a User holding no client or attorney profile, to a staff member holding every capability, and, for the attorney reads, to the same attorney at aal1 or with no claims; the client reads answer the client at aal1 and aal2 alike (the session's assurance is not client-controlled state the reads trust beyond the database's own rule)",
    () => {
      assert.ok(
        Object.keys(SURFACE_API).every((signature) => !/uuid/.test(signature)),
      );
      const ghost = { auth: uid() };
      assert.ok(answersNothing(ghost));
      assert.ok(answersNothing(ghost, AAL1));
      assert.ok(answersNothing(newAccount()));
      assert.ok(answersNothing(world.everything));
      const who = world.surfaceLawyer;
      for (const statement of [
        THREADS_SQL("attorney"),
        HISTORY_SQL,
        DOCUMENTS_SQL,
        OWN_COMPLIANCE_SQL,
      ]) {
        assert.deepEqual(rowsJson(who, statement, AAL1), [], statement);
        assert.deepEqual(
          rowsJson(who, statement, { aal: null }),
          [],
          statement,
        );
        assert.ok(rowsJson(who, statement).length > 0, statement);
      }
      const { client } = world.surfaceClient;
      assert.deepEqual(
        rowsJson(client, CLIENT_PAYMENTS_SQL(0), AAL1),
        rowsJson(client, CLIENT_PAYMENTS_SQL(0)),
      );
      return { identifier_arguments: 0 };
    },
  );

  await check(
    "SURF-8 (correction D14; MB section 98) a Consultation completed through the attorney's end emits review_available to its client, and the client's notification center as the database serializes it (with a reported problem's complaint_received linking to the client's reported problems page) is read by the application's own strict center reader as ready, review_available linking to the client's Consultation page; the delivery job of the review_available email answers act with the client's notification center, and the application's own job-context reader accepts it",
    async () => {
      const s = completedConsultation("S");
      withAddress(s.client);
      assert.equal(
        asClient(s.client, COMPLAINT_SQL(s.consultation, null)).split("|")[0],
        "opened",
      );
      const centerRows = rowsJson(
        s.client,
        "select row_to_json(x)::text from public.notification_center() x;",
        AAL1,
      );
      const clientIntake = {
        session: { currentSubject: async () => s.client.auth },
        contexts: { contextsOf: async () => ["client"] },
        account: {
          currentAccount: async () => ({
            kind: "user",
            id: s.client.auth,
            emailConfirmedAt: "2026-11-01T00:00:00Z",
          }),
        },
        reads: async () => ({
          usersOf: async () => ({
            kind: "rows",
            rows: [
              {
                id: s.client.user,
                auth_user_id: s.client.auth,
                account_state: "active",
              },
            ],
          }),
          clientProfilesOf: async () => ({
            kind: "rows",
            rows: [{ id: s.client.client, user_id: s.client.user }],
          }),
        }),
        writes: async () => ({}),
      };
      const view = await resolveClientNotifications({
        clientIntake,
        reads: async () => ({
          center: async () => ({ kind: "rows", rows: centerRows }),
        }),
        writes: async () => ({}),
      });
      assert.equal(view.status, "ready");
      const shown = view.entries.map((e) => [e.type, e.linkPath]);
      assert.ok(
        shown.some(
          ([type, link]) =>
            type === "review_available" &&
            link === `/client/consultations/${s.consultation}`,
        ),
        JSON.stringify(shown),
      );
      assert.ok(
        shown.some(
          ([type, link]) =>
            type === "complaint_received" && link === "/client/complaints",
        ),
        JSON.stringify(shown),
      );
      const email = emailNotification(
        s.client.user,
        "review_available",
        s.consultation,
      );
      const job = deliveryJob(email.id);
      assert.ok(job, "one delivery job");
      claimJob(job);
      const context = notificationJobContextOf([notificationContext(job)]);
      assert.deepEqual(
        [context.outcome, context.type, context.centerPath],
        ["act", "review_available", "/client/notifications"],
      );
      return { center: shown.map(([type]) => type), context: context.outcome };
    },
  );
}

// ---------------------------------------------------------------------------
// MVP-001 S11 review corrections (20261127180000): CORR checks of the
// operations, administration and audit corrections (R3, R4)
// ---------------------------------------------------------------------------

// The functions the correction migration replaces (with their executors,
// kept) and the one internal function it adds.
const CORRECTED_FUNCTIONS = Object.freeze({
  "client_request_payment(uuid)": "authenticated",
  "client_authorize_payment(uuid)": "authenticated",
  "payment_confirm_authorization(public.payment_transactions, text, bigint, text, text, uuid, text)":
    "",
  "decision_payment_captured()": "",
  "consultation_cancel(uuid)": "authenticated",
  "client_account_rows(uuid, text, integer, integer)": "",
  "staff_change_client_account(uuid, text, text)": "authenticated",
  "staff_audit_event(uuid)": "authenticated",
  "consultation_apply_completion(public.consultations, public.payment_transactions, text, uuid, text, text, text, uuid, jsonb)":
    "",
  "consultation_end(uuid)": "authenticated",
  "staff_update_complaint(uuid, text)": "authenticated",
  "audit_snapshot_redacted(text, jsonb)": "",
});

async function correctionChecks() {
  await check(
    "CORR-0 (Packet rules 8 and 16) the review corrections migration follows pass 2B, is registered unreviewed (sequence 72, depending on the pass 2B migration, with a rollback plan) and applied nowhere, is a Program migration ref, applies to a development and a production-class database without notices, adds no relation, column, type, constraint, index, row policy, policy type, table grant or trigger (the catalog listings still equal those after pass 1), creates exactly the eleven replaced functions and the one internal redaction function, keeps each replaced function's executors, security mode and pinned search_path (the volatile commands their 3s lock bound), and makes the new function executable by no API role",
    () => {
      assert.deepEqual(report.migrations.s11_corrections, [
        ...S11_CORRECTIONS_MIGRATIONS,
      ]);
      assert.deepEqual(
        report.migrations.correction_notices,
        Object.fromEntries(
          S11_CORRECTIONS_MIGRATIONS.map((file) => [file, []]),
        ),
      );
      const differences = {};
      for (const [name, query] of Object.entries(CATALOG_QUERIES)) {
        if (sql(query, BASE_DB) !== sql(query)) {
          differences[name] = true;
        }
      }
      assert.deepEqual(differences, {});
      const created = new Set();
      for (const file of S11_CORRECTIONS_MIGRATIONS) {
        const raw = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
        const text = raw.replace(/--[^\n]*/g, "");
        assert.doesNotMatch(
          text,
          /create\s+table|add\s+column|create\s+type|create\s+policy|create\s+view|create\s+sequence|create\s+(unique\s+)?index|alter\s+table|create\s+trigger|^\s*grant\s/im,
          file,
        );
        for (const match of raw.matchAll(
          /^create (?:or replace )?function public\.([a-z_0-9]+)\(/gm,
        )) {
          created.add(match[1]);
        }
      }
      assert.deepEqual(
        [...created].sort(),
        Object.keys(CORRECTED_FUNCTIONS)
          .map((signature) => signature.slice(0, signature.indexOf("(")))
          .sort(),
      );
      const detail = {};
      for (const [signature, executors] of Object.entries(
        CORRECTED_FUNCTIONS,
      )) {
        assert.equal(opsExecutors(signature), executors, signature);
        assert.equal(opsExecutors(signature, PROD_DB), executors, signature);
        const [definer, config, volatility] = sql(
          `select prosecdef::text || '|' || coalesce(array_to_string(proconfig, ';'), '') || '|' || provolatile::text from pg_proc where oid = 'public.${signature}'::regprocedure;`,
        ).split("|");
        assert.match(config, /search_path=pg_catalog, pg_temp/, signature);
        if (executors === "authenticated") {
          assert.equal(definer, "true", signature);
          if (volatility === "v") {
            assert.match(config, /lock_timeout=3s/, signature);
          }
        }
        detail[signature.slice(0, signature.indexOf("("))] =
          `${definer === "true" ? "definer" : "invoker"}:${volatility}`;
      }
      return detail;
    },
  );

  await check(
    "CORR-R3 (MVP-001 S11 review correction R3; fail-closed) client administration excludes a User holding an Attorney Profile exactly as it excludes staff: staff_client answers nothing for such a User (an approved, a suspended and an applicant profile alike), staff_clients never lists one, and staff_change_client_account answers not_found for both intents and changes neither the account state nor the profile stage nor writes an audit event; a client without an Attorney Profile is still listed, read and suspended",
    () => {
      const plain = newClient();
      const dual = {};
      for (const stage of ["approved", "suspended", "applicant"]) {
        const p = profileWith({ stage });
        sql(
          `insert into public.client_profiles (user_id) values ('${p.user}');`,
        );
        dual[stage] = p;
      }
      const listed = [];
      for (let offset = 0; offset < 5000; offset += 25) {
        const page = rowsJson(world.clientAdmin, CLIENTS_SQL(null, offset));
        listed.push(...page.slice(0, 25).map((r) => r.user_id));
        if (page.length <= 25) {
          break;
        }
      }
      assert.ok(listed.includes(plain.user));
      const outcome = {};
      for (const [stage, p] of Object.entries(dual)) {
        assert.ok(!listed.includes(p.user), stage);
        assert.deepEqual(rowsJson(world.clientAdmin, CLIENT_SQL(p.user)), []);
        const audits = count("audit_events", `resource_id = '${p.user}'`);
        outcome[stage] = [
          changeAccount(world.clientAdmin, p.user, "suspend"),
          changeAccount(world.clientAdmin, p.user, "reactivate"),
        ];
        assert.deepEqual(outcome[stage], ["not_found", "not_found"], stage);
        assert.equal(accountState(p.user), "active", stage);
        assert.equal(profileState(p.profile), stage, stage);
        assert.equal(
          count("audit_events", `resource_id = '${p.user}'`),
          audits,
          stage,
        );
      }
      assert.equal(
        rowsJson(world.clientAdmin, CLIENT_SQL(plain.user)).length,
        1,
      );
      assert.equal(
        changeAccount(world.clientAdmin, plain.user, "suspend"),
        "applied",
      );
      assert.equal(accountState(plain.user), "suspended");
      return outcome;
    },
  );

  await check(
    "CORR-R4 (MVP-001 S11 review correction R4) the audit workspace redacts free text: one event's snapshots come back with every free-text value an earlier migration writes (staff_note, message_to_applicant, note, display_name, headline, bio, license_number, license_type, carrier_name, policy_reference, coverage_type, finding_type, external_reference, and a free-text reason) replaced by {\"redacted\": true}, nested values included, while codes, identifiers, numbers, booleans, a code-valued reason and the structure come back as stored; a reason under payment.release_requested, payment.refund_requested and launch_authorization.revoked is redacted even when it reads like a code; the client account command's real staff note is redacted for a jurisdiction-scoped and a global auditor alike; the stored audit rows are unchanged; the list read returns no snapshot",
    () => {
      const free = {
        staff_note: "Synthetic staff note text",
        message_to_applicant: "Synthetic message to the applicant",
        note: "Synthetic note",
        display_name: "Synthetic Display",
        headline: "Synthetic headline",
        bio: "Synthetic biography text",
        license_number: "SYN-LIC-0001",
        license_type: "Synthetic licence type",
        carrier_name: "Synthetic Carrier",
        policy_reference: "SYN-POL-1",
        coverage_type: "Synthetic coverage",
        finding_type: "Synthetic finding",
        external_reference: "SYN-EXT-1",
      };
      const after = {
        ...free,
        reason: "Synthetic free text reason.",
        state: "suspended",
        attorney_id: uid(),
        amount_minor: 1500,
        discrepancy: false,
        nested: {
          note: "Nested synthetic note",
          reason: "code_like_value",
          list: [{ bio: "x" }, 2],
        },
        empty: null,
      };
      const before = { reason: "account_active", staff_note: "Before note" };
      const planted = plantAudit({
        action: "synthetic.redaction_probe",
        jurisdiction: world.J.S,
        before,
        after,
      });
      const stored = jsonOf(
        `select json_build_object('before', before_snapshot, 'after', after_snapshot)::text from public.audit_events where id = '${planted}';`,
      );
      const R = { redacted: true };
      const expectedAfter = {
        ...Object.fromEntries(Object.keys(free).map((k) => [k, R])),
        reason: R,
        state: "suspended",
        attorney_id: after.attorney_id,
        amount_minor: 1500,
        discrepancy: false,
        nested: { note: R, reason: "code_like_value", list: [{ bio: R }, 2] },
        empty: null,
      };
      for (const auditor of [world.auditor, world.auditorS]) {
        const one = rowsJson(auditor, AUDIT_ONE_SQL(planted));
        assert.equal(one.length, 1);
        assert.deepEqual(one[0].after_snapshot, expectedAfter);
        assert.deepEqual(one[0].before_snapshot, {
          reason: "account_active",
          staff_note: R,
        });
      }
      // A reason that reads like a code is still redacted under the three
      // free-text action codes.
      const actions = {};
      for (const action of [
        "payment.release_requested",
        "payment.refund_requested",
        "launch_authorization.revoked",
      ]) {
        const id = plantAudit({
          action,
          after: { reason: "looks_like_code", payment_state: "authorized" },
        });
        actions[action] = rowsJson(
          world.auditor,
          AUDIT_ONE_SQL(id),
        )[0].after_snapshot;
        assert.deepEqual(actions[action], {
          reason: R,
          payment_state: "authorized",
        });
      }
      // The real client account command's staff note.
      const c = newClient();
      assert.equal(
        changeAccount(
          world.clientAdmin,
          c.user,
          "suspend",
          "A real synthetic note",
        ),
        "applied",
      );
      const event = sql(
        `select id from public.audit_events where action_code = 'user.account_state_changed' and resource_id = '${c.user}';`,
      );
      const shown = rowsJson(world.auditor, AUDIT_ONE_SQL(event))[0];
      assert.deepEqual(shown.after_snapshot, {
        account_state: "suspended",
        staff_note: R,
      });
      assert.equal(
        sql(
          `select after_snapshot ->> 'staff_note' from public.audit_events where id = '${event}';`,
        ),
        "A real synthetic note",
      );
      // The stored planted row is unchanged.
      assert.deepEqual(
        jsonOf(
          `select json_build_object('before', before_snapshot, 'after', after_snapshot)::text from public.audit_events where id = '${planted}';`,
        ),
        stored,
      );
      const listRow = auditList(world.auditor, {
        resourceType: "synthetic_probe",
      })[0];
      assert.ok(
        !("after_snapshot" in listRow) && !("before_snapshot" in listRow),
      );
      return {
        redacted_keys: Object.keys(free).length + 1,
        actions: Object.keys(actions),
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
    seedOperations();
    prod.grantor = newAccount("active", PROD_DB);
    prodSql(
      `insert into public.staff_profiles (user_id, staff_state) values ('${prod.grantor.user}', 'active');`,
    );
    prod.mode = newRegulatoryMode("SYN_S11_OPS_PROD_MODE", PROD_DB);
    await opsMigrationChecks();
    await auditChecks();
    await operationsChecks();
    await complianceChecks();
    await lifecycleChecks();
    await waitlistChecks();
    await rejoinChecks();
    await clientChecks();
    await readChecks();
    await policyCorrectionChecks();
    await gateChecks();
    await surfacesChecks();
    await correctionChecks();
    await opsConcurrencyChecks();
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
