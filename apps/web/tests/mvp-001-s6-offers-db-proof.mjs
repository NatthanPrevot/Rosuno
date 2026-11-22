// MVP-001 S6 PS-A3 disposable PostgreSQL proof (consultation offers, the
// request duration and message, platform-scope consultation options, the
// approval validation and the public offer fields; Physical Specification
// amendment PS-A3 sections 2 to 8). Explicitly invoked only:
//
//   node apps/web/tests/mvp-001-s6-offers-db-proof.mjs
//
// Deliberately not a *.test.mjs file, so no application test run, p0:test,
// or CI job starts it. It uses Node built-ins and the system-installed
// PostgreSQL 16 initdb, pg_ctl, and psql binaries.
//
// It creates a new mode-0700 temporary directory, initializes a new cluster
// owned by an unprivileged account (never root), and starts it with TCP
// disabled and a private Unix-domain socket (port 54342, so it can run next
// to the MVP-001 S6 proof). The roles anon, authenticated, and service_role
// (BYPASSRLS), the synthetic auth schema (auth.users and an auth.uid() that
// reads request.jwt.claim.sub), the hosted platform's default privileges,
// and a no-op public.rls_auto_enable() are synthetic objects of this cluster
// only. Every migration is applied unmodified, in order, each in one
// transaction; the three S6 migrations and then the PS-A3 migration must
// follow S5 and be registered. The database records its environment as
// development, and every policy version used here is development
// configuration created by the owner role inside this disposable cluster
// (Packet rule 9), except the versions the approval probes take through the
// staff lifecycle (approved, never activated, so never selected). The
// platform-scope option lists (30, 60 and 90 minutes; a 15-minute duration
// enabled and removed again by configuration), the XTS and XXX test currency
// codes, the synthetic_* modality codes, the price bounds, fees and message
// maximums are test values, never product values. Every attorney, client,
// Intake, licence, evidence item, offer, price and message is synthetic test
// data.
//
// Request sessions are modelled as PostgREST sets them from a verified JWT:
// request.jwt.claim.sub and the JSON request.jwt.claims (attorneys and staff
// at aal2 unless a probe says otherwise; clients at aal1); anonymous
// requests run as anon without a subject.
//
// The probes cover PS-A3: the offer relation's invariants for every role
// (OFF-1) and its privileges (OFF-2); the attorney's offer functions (aal2,
// an approved profile, own offers only, permitted pairs and allowed
// currencies only, atomic replacement keeping history, withdrawal, audit
// minimization, the options read and the abuse bound; OFF-3 to OFF-6); the
// configuration model (no or two platform-scope versions: nothing offered or
// priced; a new version hides and unprices offers no longer permitted and
// keeps them stored while history is unchanged; a 15-minute duration enabled
// purely by configuration; CFG-1 to CFG-3); currency-specific offer
// selection across jurisdictions with different currencies (CUR-1); the
// approval validation (APR-1); the request duration and message (MSG-1 to
// MSG-4); the public offers (PUB-1); and real concurrency with two
// persistent sessions (CC-1 two price replacements of one pair; CC-2 a price
// replacement racing a Request creation, in both orders). No Supabase
// project, network service, or pre-existing cluster is contacted, nothing
// persists after the run. The JSON report goes to stdout; exit 0 means PASS,
// 1 FAIL, 2 cleanup failure.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54342;
const DB = "rosuno_s6_offers_proof";
const REPOSITORY_ROOT = path.resolve(
  path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
  "../../..",
);
const MIGRATIONS = path.join(REPOSITORY_ROOT, "supabase/migrations");
const S5_LAST = "20261121030000_mvp_001_s5_referral.sql";
const S6_MIGRATIONS = Object.freeze([
  "20261122010000_mvp_001_s6_request_integrity.sql",
  "20261122020000_mvp_001_s6_pricing.sql",
  "20261122030000_mvp_001_s6_requests.sql",
]);
// MVP-001 S6 PS-A3: the one PS-A3 migration follows the three S6 migrations.
const PS_A3_MIGRATION = "20261122040000_mvp_001_s6_consultation_offers.sql";
// MVP-001 S7: the two S7 migrations follow the PS-A3 migration (applied by
// this proof as later registered migrations; they change no S6 outcome).
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
// MVP-001 S11 PS-A6: the break-glass, data request and complaint
// configuration migrations follow the review corrections (registered and
// checked by the S11 PS-A6 proof).
const S11_PS_A6_MIGRATIONS = Object.freeze([
  "20261127190000_mvp_001_s11_break_glass.sql",
  "20261127200000_mvp_001_s11_data_requests.sql",
  "20261127210000_mvp_001_s11_complaint_configuration.sql",
]);

const report = {
  proof: "MVP-001 S6 PS-A3 disposable local PostgreSQL proof",
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
    path.join(os.tmpdir(), "rosuno-mvp-001-s6-offers-db-proof-"),
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
  // S6 follows S5, contiguous and in order, and every S6 migration is
  // registered unreviewed and applied nowhere. MVP-001 S6 PS-A3: then exactly
  // the PS-A3 migration, registered the same way. MVP-001 S7: then exactly the
  // two S7 migrations (registered and checked by the S7 proof). MVP-001 S8:
  // then exactly the three S8 migrations (registered and checked by the S8
  // proof). MVP-001 S9: then exactly the three S9 migrations (registered and
  // checked by the S9 proof). MVP-001 S10: then exactly the five S10
  // migrations (registered and checked by the S10 proof).
  const s5 = files.indexOf(S5_LAST);
  assert.ok(s5 >= 0, "the last S5 migration is present");
  assert.deepEqual(files.slice(s5 + 1), [
    ...S6_MIGRATIONS,
    PS_A3_MIGRATION,
    ...S7_MIGRATIONS,
    ...S8_MIGRATIONS,
    ...S9_MIGRATIONS,
    ...S10_MIGRATIONS,
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
  for (const file of [...S6_MIGRATIONS, PS_A3_MIGRATION]) {
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
    if (S6_MIGRATIONS.includes(file) || file === PS_A3_MIGRATION) {
      notices[file] = [...result.stderr.matchAll(/NOTICE:\s+(.*)/g)].map(
        (match) => match[1],
      );
    }
  }
  report.migrations.applied = files.length;
  report.migrations.s6 = [...S6_MIGRATIONS];
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
    const mark = `__S6O_${this.label}_${this.n}__`;
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
    process.stderr.write(`[s6-offers-proof] PASS ${name}\n`);
  } catch (error) {
    failed = true;
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
    process.stderr.write(
      `[s6-offers-proof] FAIL ${name}\n${error?.stack ?? error}\n`,
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

const world = { ordinals: new Map(), ownerRequests: 0 };

function newAccount(accountState = "active") {
  const auth = uid();
  const user = uid();
  sql(
    `insert into auth.users (id) values ('${auth}');
     insert into public.users (id, auth_user_id, account_state) values ('${user}', '${auth}', '${accountState}');`,
  );
  return { auth, user };
}

function newJurisdiction(code) {
  const id = uid();
  sql(
    `insert into public.jurisdictions (id, code, name, region_type) values ('${id}', '${code}', 'Synthetic ${code}', 'synthetic');`,
  );
  return id;
}

function newPracticeArea(code) {
  const id = uid();
  sql(
    `insert into public.practice_areas (id, code, name, active) values ('${id}', '${code}', 'Synthetic area ${code}', true);`,
  );
  return id;
}

// Development configuration created by the owner role in this disposable
// database only (Packet rule 9): test values, never product values.
function policy(type, jurisdiction, parameters) {
  const id = uid();
  sql(
    `insert into public.policy_versions (id, policy_type_code, jurisdiction_id, version_label, parameters, status, effective_from, development_only)
     values ('${id}', ${lit(type)}, ${lit(jurisdiction)}, ${lit(`synthetic-${type}-${id.slice(0, 8)}`)}, ${lit(parameters)}::jsonb, 'draft', now() - interval '1 hour', true);`,
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
  pending_hold_cap: 50,
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
// 4217 testing code). MVP-001 S6 PS-A3: the economics only; the duration and
// modality lists moved to the platform scope (PLATFORM below).
const FEE = (overrides = {}) => ({
  currency_code: "XTS",
  quote_validity_seconds: 900,
  listed_price_minimum_minor: 1000,
  listed_price_maximum_minor: 100000,
  rounding: "half_up",
  platform_fee: COMPONENT(1000),
  client_fee: COMPONENT(250, 50, 100, 2000),
  other_required_fee: COMPONENT(0),
  ...overrides,
});

// MVP-001 S6 PS-A3: the synthetic platform-scope Fee Policy (no
// jurisdiction): exactly the permitted durations and modalities (test values
// only; the same options the first S6 run carried in each Fee Policy).
const PLATFORM = (overrides = {}) => ({
  permitted_durations_minutes: [30, 60],
  permitted_modalities: ["synthetic_video", "synthetic_audio"],
  ...overrides,
});

let licenceNumber = 0;

// One synthetic attorney: User, Attorney Profile, a licence with fresh
// verification evidence in each given jurisdiction, practice-area
// authorisations, and optional all-day availability (UTC, every weekday).
function attorney({
  name,
  jurisdictions = [],
  areas = [],
  available = true,
  state = "approved",
} = {}) {
  const account = newAccount();
  const profile = uid();
  sql(
    `insert into public.attorney_profiles (id, user_id, profile_state, display_name, years_experience) values ('${profile}', '${account.user}', ${lit(state)}, ${lit(name)}, 7);`,
  );
  for (const jurisdiction of jurisdictions) {
    licenceNumber += 1;
    const licence = uid();
    const evidence = uid();
    sql(
      `insert into public.licenses (id, attorney_id, jurisdiction_id, license_number, reported_status) values ('${licence}', '${profile}', '${jurisdiction}', 'SYN-S6-LIC-${String(licenceNumber).padStart(4, "0")}', 'synthetic-active');
       insert into public.verification_evidence (id, jurisdiction_id, source_type, source_reference, retrieved_at, retrieved_by_user_id, evidence_summary, verification_method, discrepancy_flag)
         values ('${evidence}', '${jurisdiction}', 'synthetic register', 'synthetic entry', now() - interval '1 hour', '${world.staff.user}', 'synthetic evidence', 'synthetic lookup', false);
       insert into public.verification_evidence_subjects (verification_evidence_id, license_id) values ('${evidence}', '${licence}');`,
    );
    for (const area of areas) {
      sql(
        `insert into public.practice_area_authorisations (attorney_id, jurisdiction_id, practice_area_id, status, requested_at, decided_at, effective_from) values ('${profile}', '${jurisdiction}', '${area}', 'authorised', now() - interval '2 days', now() - interval '1 day', now() - interval '1 day');`,
      );
    }
  }
  if (available) {
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      sql(
        `insert into public.availability_rules (attorney_id, rule_kind, timezone_name, weekday, local_start_time, local_end_time, effective_from, active)
         values ('${profile}', 'recurring', 'UTC', ${weekday}, '00:00', '24:00', current_date - 7, true);`,
      );
    }
  }
  return { ...account, profile, name };
}

// A live application session and an Instant intent for the attorney, as the
// S4 functions would have recorded them (owner fixture).
function instant(lawyer) {
  const session = uid();
  sql(
    `insert into public.application_sessions (id, user_id, auth_session_reference, started_at, expires_at) values ('${session}', '${lawyer.user}', '${sha256(session)}', now() - interval '1 hour', now() + interval '3 hours');
     insert into public.instant_availability_intents (attorney_id, application_session_id, enabled_at, expires_at)
       values ('${lawyer.profile}', '${session}', now(), now() + interval '2 hours');`,
  );
  return session;
}

function newClient(states = ["submitted"]) {
  const account = newAccount();
  const client = uid();
  sql(
    `insert into public.client_profiles (id, user_id) values ('${client}', '${account.user}');`,
  );
  const intakes = {};
  for (const intakeState of states) {
    const intake = uid();
    sql(
      `insert into public.intakes (id, client_id, state, closed_at) values ('${intake}', '${client}', '${intakeState}', ${intakeState === "closed" ? "now()" : "null"});`,
    );
    intakes[intakeState] = intake;
  }
  return { ...account, client, intakes, intake: intakes[states[0]] };
}

// A Referral with complete S5 point-in-time evidence written directly by the
// owner role (fixture): an eligible evaluation, a pool entry, a presentation
// (recording the client's practice-area filter when given) and a bookable
// referral Bookability Evaluation recording the path, all in one transaction.
function ownerReferral({
  client,
  intake = client.intake,
  attorney: lawyer,
  jurisdiction,
  path: requestPath = "scheduled",
  area = null,
}) {
  const referral = uid();
  const evaluation = uid();
  const ordinal = (world.ordinals.get(intake) ?? 0) + 1;
  world.ordinals.set(intake, ordinal);
  const basis =
    requestPath === "scheduled"
      ? `'{"request_path": "scheduled"}'::jsonb`
      : "null";
  const presence = requestPath === "instant" ? "true" : "null";
  const context =
    area === null
      ? "null"
      : `${lit({ jurisdiction_id: jurisdiction, practice_area_id: area, availability: "any" })}::jsonb`;
  sql(
    `begin;
     insert into public.referrals (id, intake_id, attorney_id, jurisdiction_id, attempt_ordinal, allocation_method) values ('${referral}', '${intake}', '${lawyer.profile}', '${jurisdiction}', ${ordinal}, 'client_selected');
     insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, context_id, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${evaluation}', '${lawyer.profile}', '${jurisdiction}', 'jurisdiction', null, now(), '[]'::jsonb, 'eligible', '[]'::jsonb, '{}'::jsonb, now());
     insert into public.referral_eligible_pool_entries (referral_id, attorney_id, eligibility_evaluation_id, eligible_as_of) values ('${referral}', '${lawyer.profile}', '${evaluation}', now());
     insert into public.referral_presentations (referral_id, attorney_id, display_position, client_filter_context, narrowing_actor, shown_at) values ('${referral}', '${lawyer.profile}', 1, ${context}, ${area === null ? "'platform'" : "'client'"}, now());
     insert into public.bookability_evaluations (attorney_id, eligibility_evaluation_id, context_type, context_id, evaluated_at, as_of, modality, presence_observed, availability_basis, constraint_results, result) values ('${lawyer.profile}', '${evaluation}', 'referral', '${referral}', now(), now(), 'unselected', ${presence}, ${basis}, '[]'::jsonb, 'bookable');
     commit;`,
  );
  return referral;
}

// A client with one submitted Intake and one owner-fixture Referral.
function scenario({
  jurisdiction,
  lawyer,
  path: requestPath = "scheduled",
  area = null,
  states = ["submitted"],
}) {
  const client = newClient(states);
  const referral = ownerReferral({
    client,
    attorney: lawyer,
    jurisdiction,
    path: requestPath,
    area,
  });
  return { client, referral };
}

const asClient = (client, statement) =>
  as("authenticated", client.auth, statement, { aal: "aal1" });

const ts = (value) => (value === null ? "null" : `${lit(value)}::timestamptz`);

// MVP-001 S6 PS-A3: request_create takes the optional client message last.
const CREATE = ({
  referral,
  path: requestPath,
  modality = "synthetic_video",
  duration = 30,
  slot = null,
  message = null,
}) =>
  `select outcome || '|' || coalesce(request_id::text, '') || '|' || coalesce(problem, '') from public.request_create(${lit(referral)}, ${lit(requestPath)}, ${lit(modality)}, ${duration === null ? "null" : duration}, ${ts(slot)}, ${message === null ? "null::text" : lit(message)});`;

function create(client, options) {
  const line = asClient(client, CREATE(options));
  const [outcome, request, problem] = line.split("|");
  return { outcome, request: request || null, problem: problem || null, line };
}

const PREVIEW = ({
  referral,
  path: requestPath,
  modality = "synthetic_video",
  duration = 30,
  slot = null,
}) =>
  `select row_to_json(p)::text from public.request_quote_preview(${lit(referral)}, ${lit(requestPath)}, ${lit(modality)}, ${duration === null ? "null" : duration}, ${ts(slot)}) p;`;

function preview(client, options) {
  return JSON.parse(asClient(client, PREVIEW(options)));
}

const WITHDRAW = (request) =>
  `select outcome from public.request_withdraw(${lit(request)});`;

function readRequest(client, request) {
  return rowsAs(
    "authenticated",
    client.auth,
    `select row_to_json(r)::text from public.client_request(${lit(request)}) r;`,
    { aal: "aal1" },
  ).map((line) => JSON.parse(line));
}

function readIntake(client, intake) {
  return rowsAs(
    "authenticated",
    client.auth,
    `select row_to_json(r)::text from public.client_intake_requests(${lit(intake)}) r;`,
    { aal: "aal1" },
  ).map((line) => JSON.parse(line));
}

function readReview(client, referral) {
  return rowsAs(
    "authenticated",
    client.auth,
    `select row_to_json(r)::text from public.client_request_review(${lit(referral)}) r;`,
    { aal: "aal1" },
  ).map((line) => JSON.parse(line));
}

function readOptions(client, referral) {
  return rowsAs(
    "authenticated",
    client.auth,
    `select row_to_json(r)::text from public.request_options(${lit(referral)}) r;`,
    { aal: "aal1" },
  ).map((line) => JSON.parse(line));
}

function readStarts(client, referral, modality, duration) {
  return rowsAs(
    "authenticated",
    client.auth,
    `select row_to_json(r)::text from public.request_slot_starts(${lit(referral)}, ${lit(modality)}, ${duration}) r;`,
    { aal: "aal1" },
  ).map((line) => JSON.parse(line));
}

const EVIDENCE_TABLES = Object.freeze([
  "consultation_requests",
  "fee_calculations",
  "slot_holds",
  "eligibility_evaluations",
  "bookability_evaluations",
  "audit_events",
]);

function evidenceCounts() {
  return Object.fromEntries(EVIDENCE_TABLES.map((t) => [t, count(t)]));
}

function jsonOf(statement) {
  return JSON.parse(sql(statement) || "null");
}

const DAY_MS = 86400000;
// An ISO instant: the UTC midnight offsetDays from today, plus hours:minutes.
function at(offsetDays, hours, minutes = 0) {
  const midnight = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  return new Date(
    midnight + offsetDays * DAY_MS + (hours * 60 + minutes) * 60000,
  ).toISOString();
}

const plusMinutes = (iso, minutes) =>
  new Date(Date.parse(iso) + minutes * 60000).toISOString();

// An owner-written Request with the evidence S6 requires, in one transaction
// (fixture for owner-path probes). omit drops pieces for failure probes;
// stale writes the eligibility and bookability evidence in an earlier
// transaction; quoteUntil sets the Fee Calculation's quote validity (an SQL
// expression); slot makes it scheduled, with a Hold for that slot unless
// omitted; holdSlot gives the Hold a different slot.
function ownerRequestSql({
  request = uid(),
  referral,
  client,
  attorney: lawyer,
  jurisdiction,
  path: requestPath = "instant",
  modality = "synthetic_video",
  bookabilityModality = modality,
  slot = null,
  holdSlot = slot,
  omit = [],
  quoteUntil = "null",
  deadline = "now() + interval '1 hour'",
  evaluation = uid(),
  state: requestState = "created",
  duration = 30,
}) {
  const end = slot === null ? null : plusMinutes(slot, 30);
  const holdEnd = holdSlot === null ? null : plusMinutes(holdSlot, 30);
  const lines = [
    // MVP-001 S6 PS-A3: the Request records its duration (30 minutes, the
    // length of the fixture's Hold).
    `insert into public.consultation_requests (id, intake_id, client_id, selected_attorney_id, referral_id, request_path, referral_policy_version_id, requested_modality, requested_duration_minutes, state, response_deadline_at)
       values ('${request}', '${client.intake}', '${client.client}', '${lawyer.profile}', '${referral}', '${requestPath}', '${world.policies.referral[jurisdiction]}', ${lit(modality)}, ${duration === null ? "null" : duration}, '${requestState}', ${deadline});`,
  ];
  if (!omit.includes("eligibility")) {
    lines.push(
      `insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, context_id, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${evaluation}', '${lawyer.profile}', '${jurisdiction}', 'jurisdiction', null, now(), '[]'::jsonb, 'eligible', '[]'::jsonb, '{}'::jsonb, now());`,
    );
  }
  if (!omit.includes("bookability")) {
    lines.push(
      `insert into public.bookability_evaluations (attorney_id, eligibility_evaluation_id, context_type, context_id, evaluated_at, as_of, modality, slot_start_at, slot_end_at, constraint_results, result) values ('${lawyer.profile}', '${evaluation}', 'consultation_request', '${request}', now(), now(), ${lit(bookabilityModality)}, ${ts(slot)}, ${ts(end)}, '[]'::jsonb, 'bookable');`,
    );
  }
  if (!omit.includes("fee")) {
    lines.push(
      `insert into public.fee_calculations (consultation_request_id, fee_policy_version_id, attorney_listed_price_minor, platform_fee_minor, client_fee_minor, tax_or_other_required_fee_minor, total_client_amount_minor, currency_code, quote_valid_until, calculated_at, calculation_snapshot)
         values ('${request}', '${world.policies.fee[world.J.A]}', 5000, 500, 175, 0, 5175, 'XTS', ${quoteUntil}, now() - interval '1 minute', '{"schema": "synthetic-owner-fixture", "inputs": {"duration_minutes": 30}}'::jsonb);`,
    );
  }
  if (holdSlot !== null && !omit.includes("hold")) {
    lines.push(
      `insert into public.slot_holds (consultation_request_id, attorney_id, slot_start_at, slot_end_at, held_at, expires_at) values ('${request}', '${lawyer.profile}', ${ts(holdSlot)}, ${ts(holdEnd)}, now(), now() + interval '10 minutes');`,
    );
    if (requestState === "created") {
      lines.push(
        `update public.consultation_requests set state = 'slot_held' where id = '${request}';`,
      );
    }
  }
  return lines.join("\n");
}

// MVP-001 S6 PS-A3: one current offer written by the owner role into the
// real relation (synthetic test price); answers its id.
function offer(lawyer, modality, duration, price, currency = "XTS") {
  return sql(
    `insert into public.attorney_consultation_offers (attorney_id, modality, duration_minutes, listed_price_minor, currency_code) values ('${lawyer.profile}', ${lit(modality)}, ${duration}, ${price}, ${lit(currency)}) returning id;`,
  );
}

// The same insert as a statement, for refusal probes.
const OFFER_INSERT = (lawyer, modality, duration, price, currency = "XTS") =>
  `insert into public.attorney_consultation_offers (attorney_id, modality, duration_minutes, listed_price_minor, currency_code) values ('${lawyer.profile}', ${lit(modality)}, ${duration}, ${price}, ${lit(currency)});`;

// ---------------------------------------------------------------------------
// PS-A3 helpers
// ---------------------------------------------------------------------------

// The development platform-scope option lists of this proof (test values).
const OPTIONS_30_60_90 = Object.freeze({
  permitted_durations_minutes: [30, 60, 90],
  permitted_modalities: ["synthetic_video", "synthetic_audio"],
});

// A development platform-scope Fee Policy version (no jurisdiction).
const platformVersion = (parameters) => policy("fee", null, parameters);

// Ends a development version now (effective_until is set once).
function endPolicy(id) {
  sql(
    `update public.policy_versions set effective_until = clock_timestamp() where id = '${id}';`,
  );
}

// Replaces the selected platform-scope version by a new one (configuration,
// never a migration).
function reconfigure(parameters) {
  endPolicy(world.platform);
  world.platform = platformVersion(parameters);
  return world.platform;
}

const asAttorney = (lawyer, statement, options = {}) =>
  as("authenticated", lawyer.auth, statement, options);

const SET = (modality, duration, price, currency = "XTS") =>
  `select outcome || '|' || coalesce(offer_id::text, '') from public.attorney_set_consultation_offer(${lit(modality)}, ${duration === null ? "null" : duration}, ${price === null ? "null" : price}, ${lit(currency)});`;

function setOffer(
  lawyer,
  modality,
  duration,
  price,
  currency = "XTS",
  options,
) {
  const line = asAttorney(
    lawyer,
    SET(modality, duration, price, currency),
    options,
  );
  const [outcome, id] = line.split("|");
  return { outcome, id: id || null, line };
}

const WITHDRAW_OFFER = (id) =>
  `select public.attorney_withdraw_consultation_offer(${id === null ? "null::uuid" : `${lit(id)}::uuid`});`;

function listOffers(lawyer, options = {}) {
  return rowsAs(
    "authenticated",
    lawyer.auth,
    "select row_to_json(o)::text from public.attorney_consultation_offers() o;",
    options,
  ).map((line) => JSON.parse(line));
}

function offerOptions(lawyer, options = {}) {
  return rowsAs(
    "authenticated",
    lawyer.auth,
    "select row_to_json(o)::text from public.attorney_consultation_offer_options() o;",
    options,
  ).map((line) => JSON.parse(line));
}

function publicOffers(attorneyId, jurisdiction, role = "anon") {
  return rowsAs(
    role,
    role === "anon" ? null : world.reader.auth,
    `select row_to_json(o)::text from public.public_attorney_offers(${lit(attorneyId)}, ${jurisdiction === null ? "null" : lit(jurisdiction)}) o;`,
    { aal: "aal1" },
  ).map((line) => JSON.parse(line));
}

const QUOTE = (lawyer, jurisdiction, modality, duration) =>
  jsonOf(
    `select row_to_json(q)::text from public.pricing_quote('${lawyer.profile}', '${jurisdiction}', ${lit(modality)}, ${duration}, now()) q;`,
  );

const offerRows = (where) =>
  jsonOf(
    `select coalesce(json_agg(row_to_json(o) order by o.created_at, o.id), '[]'::json)::text from public.attorney_consultation_offers o where ${where};`,
  );

const auditCount = (where = "true") =>
  count(
    "audit_events",
    `action_code like 'consultation_offer.%' and (${where})`,
  );

function feeOf(request) {
  return jsonOf(
    `select row_to_json(c)::text from public.fee_calculations c where consultation_request_id = '${request}';`,
  );
}

const OFFER_TABLES = Object.freeze([
  "attorney_consultation_offers",
  "consultation_requests",
  "fee_calculations",
  "slot_holds",
  "eligibility_evaluations",
  "bookability_evaluations",
  "audit_events",
]);

const allCounts = () =>
  Object.fromEntries(OFFER_TABLES.map((t) => [t, count(t)]));

function seed() {
  world.J = {
    A: newJurisdiction("SYN_S6O_A"),
    B: newJurisdiction("SYN_S6O_B"),
    N: newJurisdiction("SYN_S6O_N"),
    M: newJurisdiction("SYN_S6O_M"),
    X: newJurisdiction("SYN_S6O_X"),
  };
  const J = world.J;
  world.policies = { eligibility: {}, scheduling: {}, referral: {}, fee: {} };
  for (const id of Object.values(J)) {
    world.policies.eligibility[id] = policy("eligibility", id, ELIGIBILITY);
    world.policies.scheduling[id] = policy("scheduling", id, SCHEDULING());
  }
  world.policies.bookability = policy("bookability", null, {
    presence_window_seconds: 600,
  });
  // Referral policies (test values): A sets a message maximum of 100
  // characters; B sets none; X carries a malformed maximum (development
  // configuration is never approved, so only a reader can meet it).
  world.policies.referral[J.A] = policy("referral", J.A, {
    outcome_codes: ["synthetic_closed"],
    request_message_maximum_characters: 100,
  });
  for (const id of [J.B, J.N, J.M]) {
    world.policies.referral[id] = policy("referral", id, {
      outcome_codes: ["synthetic_closed"],
    });
  }
  world.policies.referral[J.X] = policy("referral", J.X, {
    outcome_codes: ["synthetic_closed"],
    request_message_maximum_characters: "100",
  });
  // Jurisdiction-scope Fee Policies (economics only): A and X in XTS, B in
  // XXX with its own bounds, M malformed, N none.
  world.policies.fee[J.A] = policy("fee", J.A, FEE());
  world.policies.fee[J.X] = policy("fee", J.X, FEE());
  world.policies.fee[J.B] = policy(
    "fee",
    J.B,
    FEE({
      currency_code: "XXX",
      listed_price_minimum_minor: 500,
      listed_price_maximum_minor: 50000,
    }),
  );
  world.policies.fee[J.M] = policy("fee", J.M, FEE({ rounding: "nearest" }));
  // The platform-scope options (development test configuration only).
  world.platform = platformVersion(OPTIONS_30_60_90);
  world.ann = attorney({
    name: "Ann Synthetic",
    jurisdictions: [J.A, J.B, J.X],
  });
  instant(world.ann);
  world.bob = attorney({ name: "Bob Synthetic", jurisdictions: [J.A] });
  world.pen = attorney({
    name: "Pen Synthetic",
    jurisdictions: [J.A],
    state: "under_review",
  });
  world.sus = attorney({
    name: "Sus Synthetic",
    jurisdictions: [J.A],
    state: "suspended",
  });
  world.lone = attorney({ name: "Lone Synthetic", jurisdictions: [J.N, J.M] });
  world.rat = attorney({ name: "Rat Synthetic", jurisdictions: [J.A] });
  world.reader = newClient(["submitted"]);
  world.stranger = newClient(["submitted"]);
  // Staff for the approval probes: a global manage_policy_configuration
  // grant (the platform scope needs one), granted by another staff User.
  const grantor = newAccount();
  sql(
    `insert into public.staff_profiles (user_id, staff_state) values ('${grantor.user}', 'active');`,
  );
  world.admin = newAccount();
  sql(
    `insert into public.staff_profiles (user_id, staff_state) values ('${world.admin.user}', 'active');
     insert into public.capability_grants (user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at)
       values ('${world.admin.user}', 'manage_policy_configuration', '${grantor.user}', null, now() - interval '1 day');`,
  );
}

async function attorneySession(label, lawyer) {
  const s = await session(label);
  const claims = JSON.stringify({
    sub: lawyer.auth,
    role: "authenticated",
    aal: "aal2",
  });
  await s.ok("begin;");
  await s.ok("set local role authenticated;");
  await s.ok(
    `select set_config('request.jwt.claim.sub', ${lit(lawyer.auth)}, true) is not null;`,
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

const lastLine = (rows) => rows[rows.length - 1];

// ---------------------------------------------------------------------------
// OFF: the relation and the attorney's offer functions
// ---------------------------------------------------------------------------

async function offerChecks() {
  await check(
    "OFF-1 the offer invariants hold for every role, the owner included: a price above zero, a duration 1..1440, a lower-snake modality, an ISO 4217 code, a row created current, withdrawn_at not before created_at and recorded once, nothing else ever changes, never deleted or truncated, and at most one current offer per attorney, modality, duration and currency (another currency is a separate current offer; after a withdrawal a new current offer keeps the old one as history)",
    () => {
      const bob = world.bob;
      const id = offer(bob, "synthetic_video", 30, 5000);
      const refusals = [
        [OFFER_INSERT(bob, "synthetic_video", 60, 0), "23514"],
        [OFFER_INSERT(bob, "synthetic_video", 60, -1), "23514"],
        [OFFER_INSERT(bob, "synthetic_video", 0, 5000), "23514"],
        [OFFER_INSERT(bob, "synthetic_video", 1441, 5000), "23514"],
        [OFFER_INSERT(bob, "Synthetic Video", 60, 5000), "23514"],
        [OFFER_INSERT(bob, "v", 60, 5000), "23514"],
        [OFFER_INSERT(bob, "synthetic_video", 60, 5000, "xts"), "23514"],
        [OFFER_INSERT(bob, "synthetic_video", 60, 5000, "XT"), "23514"],
        [OFFER_INSERT(bob, "synthetic_video", 60, 5000, "X1S"), "23514"],
        [OFFER_INSERT(bob, "synthetic_video", 60, 5000, "XTSS"), "22001"],
        [
          `insert into public.attorney_consultation_offers (attorney_id, modality, duration_minutes, listed_price_minor, currency_code, withdrawn_at) values ('${bob.profile}', 'synthetic_video', 60, 5000, 'XTS', now());`,
          "23514",
        ],
        [OFFER_INSERT(bob, "synthetic_video", 30, 6000), "23505"],
        [
          `update public.attorney_consultation_offers set withdrawn_at = created_at - interval '1 second' where id = '${id}';`,
          "23514",
        ],
        [
          `update public.attorney_consultation_offers set listed_price_minor = 6000 where id = '${id}';`,
          "55000",
        ],
        [
          `update public.attorney_consultation_offers set modality = 'synthetic_audio' where id = '${id}';`,
          "55000",
        ],
        [
          `update public.attorney_consultation_offers set duration_minutes = 60 where id = '${id}';`,
          "55000",
        ],
        [
          `update public.attorney_consultation_offers set currency_code = 'XXX' where id = '${id}';`,
          "55000",
        ],
        [
          `update public.attorney_consultation_offers set attorney_id = '${world.ann.profile}' where id = '${id}';`,
          "55000",
        ],
        [
          `update public.attorney_consultation_offers set created_at = created_at - interval '1 day' where id = '${id}';`,
          "55000",
        ],
        [
          `update public.attorney_consultation_offers set withdrawn_at = now(), listed_price_minor = 1 where id = '${id}';`,
          "55000",
        ],
        [
          `delete from public.attorney_consultation_offers where id = '${id}';`,
          "55000",
        ],
        ["truncate public.attorney_consultation_offers;", "55000"],
        ["truncate public.attorney_consultation_offers cascade;", "55000"],
      ];
      for (const [statement, code] of refusals) {
        assert.equal(refused(statement), code, statement);
      }
      // Another currency is its own current offer.
      acceptedThenRolledBack(
        OFFER_INSERT(bob, "synthetic_video", 30, 3000, "XXX"),
      );
      // Withdrawn once (the owner role, directly); never again, never back.
      sql(
        `update public.attorney_consultation_offers set withdrawn_at = clock_timestamp() where id = '${id}';`,
      );
      for (const statement of [
        `update public.attorney_consultation_offers set withdrawn_at = clock_timestamp() where id = '${id}';`,
        `update public.attorney_consultation_offers set withdrawn_at = null where id = '${id}';`,
      ]) {
        assert.equal(refused(statement), "55000", statement);
      }
      const next = offer(bob, "synthetic_video", 30, 6000);
      const rows = offerRows(
        `attorney_id = '${bob.profile}' and modality = 'synthetic_video' and duration_minutes = 30`,
      );
      assert.deepEqual(
        rows.map((r) => [r.id, r.listed_price_minor, r.withdrawn_at === null]),
        [
          [id, 5000, false],
          [next, 6000, true],
        ],
      );
      return { refusals: refusals.length };
    },
  );
  await check(
    "OFF-2 the relation is function-only: row level security is enabled with no policy, anon, authenticated and service_role hold no table or column privilege, and every direct read or write by those roles is refused (42501), as is every internal PS-A3 building block",
    () => {
      assert.equal(
        sql(
          "select relrowsecurity::text || '|' || (select count(*) from pg_policies where schemaname = 'public' and tablename = 'attorney_consultation_offers')::text from pg_class where oid = 'public.attorney_consultation_offers'::regclass;",
        ),
        "true|0",
      );
      for (const role of ["anon", "authenticated", "service_role"]) {
        for (const privilege of [
          "SELECT",
          "INSERT",
          "UPDATE",
          "DELETE",
          "TRUNCATE",
          "REFERENCES",
          "TRIGGER",
        ]) {
          assert.equal(
            sql(
              `select has_table_privilege('${role}', 'public.attorney_consultation_offers', '${privilege}');`,
            ),
            "f",
            `${role} ${privilege}`,
          );
        }
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
          assert.equal(
            sql(
              `select has_any_column_privilege('${role}', 'public.attorney_consultation_offers', '${privilege}');`,
            ),
            "f",
            `${role} column ${privilege}`,
          );
        }
      }
      const statements = [
        "select count(*) from public.attorney_consultation_offers;",
        OFFER_INSERT(world.bob, "synthetic_audio", 30, 5000),
        "update public.attorney_consultation_offers set withdrawn_at = now();",
        "delete from public.attorney_consultation_offers;",
        "truncate public.attorney_consultation_offers;",
        "select * from public.pricing_platform_policy(now());",
        "select public.pricing_platform_parameters_valid('{}'::jsonb);",
        "select public.policy_parameters_approvable('fee', null, '{}'::jsonb);",
        `select * from public.request_message_limit('${world.policies.referral[world.J.A]}');`,
        `select public.attorney_offer_allowed_currencies('${world.ann.profile}', now());`,
        `select * from public.pricing_attorney_offers('${world.ann.profile}');`,
      ];
      for (const statement of statements) {
        assert.equal(as("anon", null, statement), "ERROR 42501", statement);
        assert.equal(
          as("authenticated", world.bob.auth, statement),
          "ERROR 42501",
          statement,
        );
        assert.equal(
          as("service_role", null, statement),
          "ERROR 42501",
          statement,
        );
      }
    },
  );
  await check(
    "OFF-3 the attorney's offer functions require an aal2 session, an active User and an approved Attorney Profile: at aal1, without claims, for an applicant, under-review or suspended profile and for a client account every write answers denied and every read no row, anon cannot call them, and nothing is written",
    () => {
      const before = allCounts();
      const callers = [
        [world.bob, { aal: "aal1" }],
        [world.bob, { aal: null }],
        [world.pen, {}],
        [world.sus, {}],
        [world.reader, {}],
      ];
      for (const [who, options] of callers) {
        const label = `${who.name ?? "client"} ${JSON.stringify(options)}`;
        assert.equal(
          setOffer(who, "synthetic_video", 30, 5000, "XTS", options).line,
          "denied|",
          label,
        );
        assert.equal(
          asAttorney(who, WITHDRAW_OFFER(uid()), options),
          "denied",
          label,
        );
        assert.deepEqual(listOffers(who, options), [], label);
        assert.deepEqual(offerOptions(who, options), [], label);
      }
      for (const statement of [
        SET("synthetic_video", 30, 5000),
        WITHDRAW_OFFER(uid()),
        "select * from public.attorney_consultation_offers();",
        "select * from public.attorney_consultation_offer_options();",
      ]) {
        assert.equal(as("anon", null, statement), "ERROR 42501", statement);
        assert.equal(
          as("service_role", null, statement),
          "ERROR 42501",
          statement,
        );
      }
      assert.deepEqual(allCounts(), before);
    },
  );
  await check(
    "OFF-4 an attorney creates offers only for a pair the platform-scope version permits and a currency allowed for them (the selected, complete jurisdiction Fee Policy currency of a licensed jurisdiction); the same price again changes nothing; a new price withdraws the current offer and creates the new one in the same transaction (one current offer, the old one kept as history, one audit event each); malformed arguments are invalid",
    () => {
      const ann = world.ann;
      const before = allCounts();
      for (const [args, expected] of [
        [["Synthetic Video", 30, 5000, "XTS"], "invalid|"],
        [[null, 30, 5000, "XTS"], "invalid|"],
        [["synthetic_video", 0, 5000, "XTS"], "invalid|"],
        [["synthetic_video", 1441, 5000, "XTS"], "invalid|"],
        [["synthetic_video", 30, 0, "XTS"], "invalid|"],
        [["synthetic_video", 30, -5, "XTS"], "invalid|"],
        [["synthetic_video", 30, 1000000000001, "XTS"], "invalid|"],
        [["synthetic_video", 30, null, "XTS"], "invalid|"],
        [["synthetic_video", 30, 5000, "xts"], "invalid|"],
        [["synthetic_text", 30, 5000, "XTS"], "not_permitted|"],
        [["synthetic_video", 45, 5000, "XTS"], "not_permitted|"],
        [["synthetic_video", 30, 5000, "XAG"], "currency_not_allowed|"],
      ]) {
        assert.equal(
          setOffer(ann, ...args).line,
          expected,
          JSON.stringify(args),
        );
      }
      // Bob holds a licence in A (XTS) only; Lone only where no complete Fee
      // Policy is selected (N none, M malformed).
      assert.equal(
        setOffer(world.bob, "synthetic_video", 30, 3000, "XXX").line,
        "currency_not_allowed|",
      );
      assert.equal(
        setOffer(world.lone, "synthetic_video", 30, 3000, "XTS").line,
        "currency_not_allowed|",
      );
      assert.deepEqual(allCounts(), before);
      const first = setOffer(ann, "synthetic_video", 30, 5000, "XTS");
      assert.equal(first.outcome, "created", first.line);
      const other = setOffer(ann, "synthetic_video", 30, 3000, "XXX");
      assert.equal(other.outcome, "created", other.line);
      const again = setOffer(ann, "synthetic_video", 30, 5000, "XTS");
      assert.equal(again.line, `unchanged|${first.id}`);
      const audits = auditCount();
      const replaced = setOffer(ann, "synthetic_video", 30, 5500, "XTS");
      assert.equal(replaced.outcome, "replaced", replaced.line);
      assert.equal(auditCount(), audits + 1);
      const rows = offerRows(
        `attorney_id = '${ann.profile}' and modality = 'synthetic_video' and duration_minutes = 30 and currency_code = 'XTS'`,
      );
      assert.deepEqual(
        rows.map((r) => [r.id, r.listed_price_minor, r.withdrawn_at !== null]),
        [
          [first.id, 5000, true],
          [replaced.id, 5500, false],
        ],
      );
      // The withdrawal and the new offer are one instant of one transaction.
      assert.equal(
        sql(
          `select (a.withdrawn_at = b.created_at and a.xmin = b.xmin)::text from public.attorney_consultation_offers a, public.attorney_consultation_offers b where a.id = '${first.id}' and b.id = '${replaced.id}';`,
        ),
        "true",
      );
      assert.equal(
        count(
          "attorney_consultation_offers",
          `attorney_id = '${ann.profile}' and withdrawn_at is null and modality = 'synthetic_video' and duration_minutes = 30`,
        ),
        2,
      );
      const after = allCounts();
      assert.equal(
        after.attorney_consultation_offers -
          before.attorney_consultation_offers,
        3,
      );
      assert.equal(after.audit_events - before.audit_events, 3);
      world.annVideo30 = { xts: replaced.id, xxx: other.id, old: first.id };
      assert.deepEqual(
        listOffers(ann).map((o) => [
          o.offer_id,
          o.listed_price_minor,
          o.currency_code,
          o.withdrawn_at === null,
          o.permitted,
        ]),
        [
          [replaced.id, 5500, "XTS", true, true],
          [other.id, 3000, "XXX", true, true],
          [first.id, 5000, "XTS", false, true],
        ],
      );
      return { replaced: replaced.id };
    },
  );
  await check(
    "OFF-5 an attorney acts on their own offers only: another attorney's offer and an unknown or missing id answer not_found, an attorney's list holds only their own offers; withdrawal records withdrawn_at once (already_withdrawn after); every change writes exactly one minimized attorney audit event (identifiers, modality, duration, amount and currency only) and no other offer action exists",
    () => {
      const ann = world.ann;
      const before = allCounts();
      for (const id of [world.annVideo30.xxx, uid(), null]) {
        assert.equal(asAttorney(world.bob, WITHDRAW_OFFER(id)), "not_found");
      }
      assert.deepEqual(allCounts(), before);
      assert.ok(
        listOffers(world.bob).every(
          (o) =>
            count(
              "attorney_consultation_offers",
              `id = '${o.offer_id}' and attorney_id = '${world.bob.profile}'`,
            ) === 1,
        ),
      );
      assert.equal(
        asAttorney(ann, WITHDRAW_OFFER(world.annVideo30.xxx)),
        "withdrawn",
      );
      assert.equal(
        asAttorney(ann, WITHDRAW_OFFER(world.annVideo30.xxx)),
        "already_withdrawn",
      );
      assert.notEqual(
        offerRows(`id = '${world.annVideo30.xxx}'`)[0].withdrawn_at,
        null,
      );
      assert.equal(allCounts().audit_events - before.audit_events, 1);
      const shapes = sql(
        "select string_agg(s, ';' order by s) from (select distinct action_code || ':' || actor_type || ':' || resource_type || ':' || coalesce((select string_agg(k, ',' order by k) from jsonb_object_keys(before_snapshot) k), '-') || ':' || (select string_agg(k, ',' order by k) from jsonb_object_keys(after_snapshot) k) || ':' || coalesce(jsonb_array_length(policy_references)::text, '-') || ':' || coalesce(reason_code, '-') || ':' || coalesce(jurisdiction_id::text, '-') as s from public.audit_events where action_code like 'consultation_offer.%') as x;",
      );
      assert.equal(
        shapes,
        [
          "consultation_offer.created:attorney:attorney_consultation_offer:-:attorney_id,currency_code,duration_minutes,listed_price_minor,modality:1:-:-",
          "consultation_offer.replaced:attorney:attorney_consultation_offer:listed_price_minor,offer_id:attorney_id,currency_code,duration_minutes,listed_price_minor,modality:1:-:-",
          "consultation_offer.withdrawn:attorney:attorney_consultation_offer:withdrawn_at:attorney_id,currency_code,duration_minutes,listed_price_minor,modality,withdrawn_at:-:-:-",
        ].join(";"),
      );
      assert.equal(
        auditCount(
          `actor_user_id is distinct from (select user_id from public.attorney_profiles p where p.id::text = after_snapshot ->> 'attorney_id')`,
        ),
        0,
      );
      assert.equal(
        auditCount(
          `action_code <> 'consultation_offer.withdrawn' and not (policy_references @> jsonb_build_array(jsonb_build_object('policy_type_code', 'fee', 'policy_version_id', '${world.platform}')))`,
        ),
        0,
      );
    },
  );
  await check(
    "OFF-6 the options read answers the platform-scope permitted durations and modalities and the attorney's allowed currencies (each licensed jurisdiction's selected, complete Fee Policy currency); and the fixed abuse bound refuses a further current offer at 200 (rate_limited, nothing written)",
    () => {
      assert.deepEqual(offerOptions(world.ann), [
        {
          options_configured: true,
          permitted_durations_minutes: [30, 60, 90],
          permitted_modalities: ["synthetic_audio", "synthetic_video"],
          allowed_currencies: ["XTS", "XXX"],
        },
      ]);
      assert.deepEqual(offerOptions(world.bob)[0].allowed_currencies, ["XTS"]);
      assert.deepEqual(offerOptions(world.lone)[0].allowed_currencies, []);
      sql(
        `insert into public.attorney_consultation_offers (attorney_id, modality, duration_minutes, listed_price_minor, currency_code)
         select '${world.rat.profile}', 'synthetic_text', d, 1000, 'XTS' from generate_series(1, 200) as d;`,
      );
      const before = allCounts();
      assert.equal(
        setOffer(world.rat, "synthetic_video", 30, 5000).line,
        "rate_limited|",
      );
      assert.deepEqual(allCounts(), before);
    },
  );
}

// ---------------------------------------------------------------------------
// CFG: configuration (PS-A3 section 3)
// ---------------------------------------------------------------------------

async function configurationChecks() {
  await check(
    "CFG-1 with no selectable platform-scope version, or two (a conflict), no offer can be created or priced: setting answers options_unavailable, the options read reports it unconfigured, every offer is marked not permitted, quotes and previews answer policy_unavailable, a Request is refused with nothing written, and nothing is public; one selectable version restores it",
    () => {
      const ann = world.ann;
      const instantCase = scenario({
        jurisdiction: world.J.A,
        lawyer: ann,
        path: "instant",
      });
      const refusedEverywhere = (outcome) => {
        assert.equal(
          sql("select outcome from public.pricing_platform_policy(now());"),
          outcome,
        );
        assert.equal(
          setOffer(ann, "synthetic_video", 60, 9000).line,
          "options_unavailable|",
        );
        assert.deepEqual(offerOptions(ann), [
          {
            options_configured: false,
            permitted_durations_minutes: [],
            permitted_modalities: [],
            allowed_currencies: ["XTS", "XXX"],
          },
        ]);
        assert.ok(listOffers(ann).every((o) => o.permitted === false));
        assert.equal(
          QUOTE(ann, world.J.A, "synthetic_video", 30).outcome,
          "policy_unavailable",
        );
        assert.equal(
          preview(instantCase.client, {
            referral: instantCase.referral,
            path: "instant",
          }).outcome,
          "policy_unavailable",
        );
        assert.deepEqual(
          readOptions(instantCase.client, instantCase.referral),
          [],
        );
        const before = allCounts();
        assert.equal(
          create(instantCase.client, {
            referral: instantCase.referral,
            path: "instant",
          }).line,
          "policy_unavailable||",
        );
        assert.deepEqual(allCounts(), before);
        assert.deepEqual(publicOffers(ann.profile, null), []);
        assert.deepEqual(publicOffers(ann.profile, world.J.A), []);
      };
      endPolicy(world.platform);
      refusedEverywhere("no_applicable_policy");
      const second = platformVersion(OPTIONS_30_60_90);
      const third = platformVersion(OPTIONS_30_60_90);
      refusedEverywhere("policy_conflict");
      endPolicy(third);
      world.platform = second;
      assert.equal(
        QUOTE(ann, world.J.A, "synthetic_video", 30).outcome,
        "priced",
      );
      assert.equal(offerOptions(ann)[0].options_configured, true);
      assert.ok(
        listOffers(ann)
          .filter((o) => o.withdrawn_at === null)
          .every((o) => o.permitted === true),
      );
    },
  );
  await check(
    "CFG-2 a new platform-scope version (configuration, no migration) that no longer permits a duration or a modality hides and unprices the offers concerned and keeps them stored: they are marked not permitted, are not public, quote as duration_not_permitted or modality_not_permitted and cannot be created; offers, Requests and Fee Calculations made before are unchanged; restoring the options makes the same offers permitted again",
    () => {
      const ann = world.ann;
      const video90 = setOffer(ann, "synthetic_video", 90, 12000);
      const audio30 = setOffer(ann, "synthetic_audio", 30, 4000);
      assert.equal(video90.outcome, "created", video90.line);
      assert.equal(audio30.outcome, "created", audio30.line);
      const earlier = scenario({
        jurisdiction: world.J.A,
        lawyer: ann,
        path: "instant",
      });
      const made = create(earlier.client, {
        referral: earlier.referral,
        path: "instant",
        duration: 90,
      });
      assert.equal(made.outcome, "created", made.line);
      const fee = feeOf(made.request);
      assert.equal(fee.attorney_listed_price_minor, 12000);
      const offersBefore = offerRows(`attorney_id = '${ann.profile}'`);
      const requestBefore = jsonOf(
        `select row_to_json(r)::text from public.consultation_requests r where id = '${made.request}';`,
      );
      reconfigure({
        permitted_durations_minutes: [30, 60],
        permitted_modalities: ["synthetic_video"],
      });
      const listed = Object.fromEntries(
        listOffers(ann)
          .filter((o) => o.withdrawn_at === null)
          .map((o) => [
            `${o.modality}-${o.duration_minutes}-${o.currency_code}`,
            o.permitted,
          ]),
      );
      assert.equal(listed["synthetic_video-90-XTS"], false);
      assert.equal(listed["synthetic_audio-30-XTS"], false);
      assert.equal(listed["synthetic_video-30-XTS"], true);
      const shown = publicOffers(ann.profile, null).map(
        (o) => `${o.modality}-${o.duration_minutes}`,
      );
      assert.ok(!shown.includes("synthetic_video-90"), shown.join());
      assert.ok(!shown.includes("synthetic_audio-30"), shown.join());
      assert.ok(shown.includes("synthetic_video-30"), shown.join());
      assert.equal(
        QUOTE(ann, world.J.A, "synthetic_video", 90).outcome,
        "duration_not_permitted",
      );
      assert.equal(
        QUOTE(ann, world.J.A, "synthetic_audio", 30).outcome,
        "modality_not_permitted",
      );
      assert.equal(
        setOffer(ann, "synthetic_video", 90, 13000).line,
        "not_permitted|",
      );
      assert.equal(
        setOffer(ann, "synthetic_audio", 30, 4500).line,
        "not_permitted|",
      );
      // History unchanged: every offer row, the Request and its Fee
      // Calculation.
      assert.deepEqual(
        offerRows(`attorney_id = '${ann.profile}'`),
        offersBefore,
      );
      assert.deepEqual(feeOf(made.request), fee);
      assert.deepEqual(
        jsonOf(
          `select row_to_json(r)::text from public.consultation_requests r where id = '${made.request}';`,
        ),
        requestBefore,
      );
      assert.equal(
        readRequest(earlier.client, made.request)[0].duration_minutes,
        90,
      );
      reconfigure(OPTIONS_30_60_90);
      assert.equal(
        QUOTE(ann, world.J.A, "synthetic_video", 90).outcome,
        "priced",
      );
      assert.ok(
        listOffers(ann)
          .filter((o) => o.withdrawn_at === null)
          .every((o) => o.permitted),
      );
      return { kept: [video90.id, audio30.id] };
    },
  );
  await check(
    "CFG-3 a 15-minute duration becomes offerable purely by configuration (a new platform-scope version; test values): the attorney sets it, it is priced and public; removing it again keeps the offer stored and not permitted",
    () => {
      const ann = world.ann;
      assert.equal(
        setOffer(ann, "synthetic_video", 15, 2500).line,
        "not_permitted|",
      );
      reconfigure({
        permitted_durations_minutes: [15, 30, 60, 90],
        permitted_modalities: ["synthetic_video", "synthetic_audio"],
      });
      const fifteen = setOffer(ann, "synthetic_video", 15, 2500);
      assert.equal(fifteen.outcome, "created", fifteen.line);
      const quote = QUOTE(ann, world.J.A, "synthetic_video", 15);
      assert.deepEqual(
        [quote.outcome, quote.attorney_listed_price_minor, quote.currency_code],
        ["priced", 2500, "XTS"],
      );
      assert.ok(
        publicOffers(ann.profile, world.J.A).some(
          (o) => o.duration_minutes === 15 && o.listed_price_minor === 2500,
        ),
      );
      reconfigure(OPTIONS_30_60_90);
      assert.equal(
        QUOTE(ann, world.J.A, "synthetic_video", 15).outcome,
        "duration_not_permitted",
      );
      assert.equal(
        listOffers(ann).find((o) => o.offer_id === fifteen.id).permitted,
        false,
      );
      assert.equal(offerRows(`id = '${fifteen.id}'`)[0].withdrawn_at, null);
    },
  );
}

// ---------------------------------------------------------------------------
// CUR: currency-specific offer selection (PS-A3 section 5)
// ---------------------------------------------------------------------------

async function currencyChecks() {
  await check(
    "CUR-1 an attorney licensed in two jurisdictions whose Fee Policies use different currencies holds an offer in each currency for the same pair: each jurisdiction's quote, preview and Request (Fee Calculation, snapshot offer and audit) pick exactly the offer in that jurisdiction's currency; the public offers per jurisdiction show only that jurisdiction's priced offer; with only one currency offered the other jurisdiction answers price_unavailable and writes nothing",
    () => {
      const ann = world.ann;
      const xxx = setOffer(ann, "synthetic_video", 30, 3000, "XXX");
      assert.equal(xxx.outcome, "created", xxx.line);
      const xts = world.annVideo30.xts;
      const quoteA = QUOTE(ann, world.J.A, "synthetic_video", 30);
      const quoteB = QUOTE(ann, world.J.B, "synthetic_video", 30);
      assert.deepEqual(
        [
          quoteA.outcome,
          quoteA.currency_code,
          quoteA.attorney_listed_price_minor,
          quoteA.calculation_snapshot.inputs.offer.id,
        ],
        ["priced", "XTS", 5500, xts],
      );
      assert.deepEqual(
        [
          quoteB.outcome,
          quoteB.currency_code,
          quoteB.attorney_listed_price_minor,
          quoteB.calculation_snapshot.inputs.offer.id,
        ],
        ["priced", "XXX", 3000, xxx.id],
      );
      const inA = scenario({
        jurisdiction: world.J.A,
        lawyer: ann,
        path: "instant",
      });
      const inB = scenario({
        jurisdiction: world.J.B,
        lawyer: ann,
        path: "instant",
      });
      assert.equal(
        preview(inB.client, { referral: inB.referral, path: "instant" })
          .currency_code,
        "XXX",
      );
      const madeA = create(inA.client, {
        referral: inA.referral,
        path: "instant",
      });
      const madeB = create(inB.client, {
        referral: inB.referral,
        path: "instant",
      });
      assert.equal(madeA.outcome, "created", madeA.line);
      assert.equal(madeB.outcome, "created", madeB.line);
      for (const [made, currency, price, offerId, jurisdiction] of [
        [madeA, "XTS", 5500, xts, world.J.A],
        [madeB, "XXX", 3000, xxx.id, world.J.B],
      ]) {
        const fee = feeOf(made.request);
        assert.deepEqual(
          [
            fee.currency_code,
            fee.attorney_listed_price_minor,
            fee.fee_policy_version_id,
            fee.calculation_snapshot.inputs.offer.id,
            fee.calculation_snapshot.inputs.platform_fee_policy_version_id,
          ],
          [
            currency,
            price,
            world.policies.fee[jurisdiction],
            offerId,
            world.platform,
          ],
        );
        assert.equal(
          sql(
            `select after_snapshot ->> 'offer_id' from public.audit_events where action_code = 'consultation_request.created' and resource_id = '${made.request}';`,
          ),
          offerId,
        );
      }
      const pick = (rows) =>
        rows
          .filter(
            (o) =>
              o.modality === "synthetic_video" && o.duration_minutes === 30,
          )
          .map((o) => [o.currency_code, o.listed_price_minor]);
      assert.deepEqual(pick(publicOffers(ann.profile, world.J.A)), [
        ["XTS", 5500],
      ]);
      assert.deepEqual(pick(publicOffers(ann.profile, world.J.B)), [
        ["XXX", 3000],
      ]);
      assert.deepEqual(pick(publicOffers(ann.profile, null)).sort(), [
        ["XTS", 5500],
        ["XXX", 3000],
      ]);
      // Only one currency left.
      assert.equal(asAttorney(ann, WITHDRAW_OFFER(xxx.id)), "withdrawn");
      assert.equal(
        QUOTE(ann, world.J.B, "synthetic_video", 30).outcome,
        "price_unavailable",
      );
      assert.equal(
        QUOTE(ann, world.J.A, "synthetic_video", 30).outcome,
        "priced",
      );
      const laterB = scenario({
        jurisdiction: world.J.B,
        lawyer: ann,
        path: "instant",
      });
      assert.equal(
        preview(laterB.client, { referral: laterB.referral, path: "instant" })
          .outcome,
        "price_unavailable",
      );
      const before = allCounts();
      assert.equal(
        create(laterB.client, { referral: laterB.referral, path: "instant" })
          .line,
        "price_unavailable||",
      );
      assert.deepEqual(allCounts(), before);
      assert.deepEqual(pick(publicOffers(ann.profile, world.J.B)), []);
      // The recorded Fee Calculations never change.
      assert.equal(feeOf(madeB.request).attorney_listed_price_minor, 3000);
      report.currency = {
        jurisdiction_a: { currency: "XTS", offer: xts, price: 5500 },
        jurisdiction_b: { currency: "XXX", offer: xxx.id, price: 3000 },
        after_withdrawal_b: "price_unavailable",
      };
      return report.currency;
    },
  );
}

// ---------------------------------------------------------------------------
// APR: approval validation (PS-A3 section 3.4)
// ---------------------------------------------------------------------------

function staffRow(call) {
  const value = as(
    "authenticated",
    world.admin.auth,
    `select to_jsonb(r) from ${call} as r;`,
  );
  assert.ok(!value.startsWith("ERROR"), `${call}: ${value}`);
  return JSON.parse(value);
}

const staffText = (call) =>
  as("authenticated", world.admin.auth, `select ${call};`);

// A non-development version taken through review to the approval step;
// answers the approval outcome and the version id.
function approval(
  type,
  jurisdiction,
  parameters,
  { verify = true, effective = true } = {},
) {
  const created = staffRow(
    `public.staff_create_policy_version(${lit(type)}, ${jurisdiction === null ? "null" : lit(jurisdiction)}::uuid, null, ${lit(`apr-${uid().slice(0, 8)}`)}, ${lit(parameters)}::jsonb, ${effective ? "now() - interval '1 hour'" : "null"}, null, null, false)`,
  );
  assert.equal(created.outcome, "created", JSON.stringify(created));
  const id = created.policy_version_id;
  const step = (target) =>
    staffText(
      `public.staff_transition_policy_version('${id}', '${sql(`select updated_at from public.policy_versions where id = '${id}';`)}', '${target}')`,
    );
  assert.equal(step("internal_review"), "applied");
  assert.equal(step("counsel_review"), "applied");
  if (verify) {
    const reference = staffRow(
      `public.staff_add_policy_authority_reference('${id}', 'synthetic', 'synthetic citation', 'https://example.test/synthetic', 'synthetic source', now())`,
    );
    assert.equal(reference.outcome, "created");
    assert.equal(
      staffText(
        `public.staff_decide_policy_authority_reference('${reference.reference_id}', 'verified')`,
      ),
      "applied",
    );
  }
  return { outcome: step("approved"), id, step };
}

async function approvalChecks() {
  await check(
    "APR-1 staff approval validates the parameters (PS section 8.4): a platform-scope fee version must be exactly the two option lists, a jurisdiction-scope one exactly the economics, and a referral version's request_message_maximum_characters an integer 1..20000 when present; invalid ones answer parameters_invalid and stay unapproved with nothing audited, valid ones are approved; every other refusal (invalid_transition, authority_unverified, effective_period_required) comes first and unchanged, other policy types are not concerned, and an approved version that is not active is never selected",
    () => {
      const A = world.J.A;
      const cases = [
        ["fee", null, OPTIONS_30_60_90, "applied"],
        ["fee", null, FEE(), "parameters_invalid"],
        [
          "fee",
          null,
          {
            permitted_durations_minutes: [30],
            permitted_modalities: ["Video"],
          },
          "parameters_invalid",
        ],
        [
          "fee",
          null,
          { ...OPTIONS_30_60_90, currency_code: "XTS" },
          "parameters_invalid",
        ],
        ["fee", A, FEE(), "applied"],
        ["fee", A, { ...FEE(), ...OPTIONS_30_60_90 }, "parameters_invalid"],
        ["fee", A, FEE({ rounding: "nearest" }), "parameters_invalid"],
        ["fee", A, OPTIONS_30_60_90, "parameters_invalid"],
        [
          "referral",
          A,
          {
            outcome_codes: ["synthetic_closed"],
            request_message_maximum_characters: 2000,
          },
          "applied",
        ],
        ["referral", A, { outcome_codes: ["synthetic_closed"] }, "applied"],
        [
          "referral",
          A,
          { request_message_maximum_characters: 20000 },
          "applied",
        ],
        [
          "referral",
          A,
          { request_message_maximum_characters: 0 },
          "parameters_invalid",
        ],
        [
          "referral",
          A,
          { request_message_maximum_characters: 20001 },
          "parameters_invalid",
        ],
        [
          "referral",
          A,
          { request_message_maximum_characters: "100" },
          "parameters_invalid",
        ],
        [
          "referral",
          A,
          { request_message_maximum_characters: 10.5 },
          "parameters_invalid",
        ],
        [
          "referral",
          A,
          { request_message_maximum_characters: null },
          "parameters_invalid",
        ],
        ["payment", A, { synthetic: true }, "applied"],
      ];
      const outcomes = [];
      for (const [type, jurisdiction, parameters, expected] of cases) {
        const result = approval(type, jurisdiction, parameters);
        assert.equal(
          result.outcome,
          expected,
          `${type} ${jurisdiction} ${JSON.stringify(parameters)}`,
        );
        const row = jsonOf(
          `select json_build_object('status', status, 'approved_at', approved_at, 'transitions', (select count(*) from public.audit_events a where a.resource_id = v.id and a.action_code = 'policy_version.transitioned'))::text from public.policy_versions v where id = '${result.id}';`,
        );
        if (expected === "applied") {
          assert.equal(row.status, "approved");
          assert.equal(row.transitions, 3);
        } else {
          assert.deepEqual(row, {
            status: "counsel_review",
            approved_at: null,
            transitions: 2,
          });
        }
        outcomes.push(result.outcome);
      }
      // The other refusals come first and are unchanged.
      const unverified = approval("fee", null, FEE(), { verify: false });
      assert.equal(unverified.outcome, "authority_unverified");
      const noStart = approval(
        "referral",
        A,
        { request_message_maximum_characters: 0 },
        { effective: false },
      );
      assert.equal(noStart.outcome, "effective_period_required");
      const created = staffRow(
        `public.staff_create_policy_version('fee', null, null, 'apr-draft', ${lit(FEE())}::jsonb, now() - interval '1 hour', null, null, false)`,
      );
      const updatedAt = (id) =>
        sql(
          `select updated_at from public.policy_versions where id = '${id}';`,
        );
      assert.equal(
        staffText(
          `public.staff_transition_policy_version('${created.policy_version_id}', '${updatedAt(created.policy_version_id)}', 'approved')`,
        ),
        "invalid_transition",
      );
      // A development version stays locked whatever its parameters.
      assert.equal(
        staffText(
          `public.staff_transition_policy_version('${world.platform}', '${updatedAt(world.platform)}', 'internal_review')`,
        ),
        "locked",
      );
      // Approved but never activated: the development platform version is
      // still the one selected.
      assert.equal(
        sql(
          `select (policy_version_id = '${world.platform}')::text from public.pricing_platform_policy(now());`,
        ),
        "true",
      );
      return { cases: cases.length, outcomes };
    },
  );
}

// ---------------------------------------------------------------------------
// MSG: the request duration and message (PS-A3 sections 3.3 and 5)
// ---------------------------------------------------------------------------

const MESSAGE_100 =
  `  <b>Synthetic</b> & "message"\n` +
  "x".repeat(100 - `  <b>Synthetic</b> & "message"\n`.length);

async function messageChecks() {
  await check(
    "MSG-1 a Request records the priced offer's duration (scheduled: also its Hold's length) and the optional message exactly as given when it fits the recorded referral policy's maximum; a longer message, a blank one, one over 20,000 characters, a message where the policy sets no maximum or sets a malformed one are refused with nothing written (a Request without a message is then still accepted); the column checks refuse a blank, over-long message and an out-of-range duration for every role; the review answers the maximum (null: none)",
    () => {
      const ann = world.ann;
      const video60 = setOffer(ann, "synthetic_video", 60, 9000);
      assert.ok(
        ["created", "unchanged"].includes(video60.outcome),
        video60.line,
      );
      const instantCase = scenario({
        jurisdiction: world.J.A,
        lawyer: ann,
        path: "instant",
      });
      assert.equal(
        readReview(instantCase.client, instantCase.referral)[0]
          .message_maximum_characters,
        100,
      );
      assert.equal(MESSAGE_100.length, 100);
      const made = create(instantCase.client, {
        referral: instantCase.referral,
        path: "instant",
        message: MESSAGE_100,
      });
      assert.equal(made.outcome, "created", made.line);
      const stored = jsonOf(
        `select json_build_object('message', client_message, 'duration', requested_duration_minutes, 'policy', referral_policy_version_id)::text from public.consultation_requests where id = '${made.request}';`,
      );
      assert.deepEqual(stored, {
        message: MESSAGE_100,
        duration: 30,
        policy: world.policies.referral[world.J.A],
      });
      const [read] = readRequest(instantCase.client, made.request);
      assert.equal(read.client_message, MESSAGE_100);
      assert.equal(read.duration_minutes, 30);
      world.messageRequest = { ...instantCase, request: made.request };
      // Scheduled, 60 minutes: the Hold lasts exactly the duration.
      const scheduledCase = scenario({
        jurisdiction: world.J.A,
        lawyer: ann,
        path: "scheduled",
      });
      const slot = at(2, 10);
      const held = create(scheduledCase.client, {
        referral: scheduledCase.referral,
        path: "scheduled",
        duration: 60,
        slot,
        message: "Synthetic scheduled message",
      });
      assert.equal(held.outcome, "created", held.line);
      assert.equal(
        sql(
          `select r.requested_duration_minutes || '|' || extract(epoch from h.slot_end_at - h.slot_start_at)::integer / 60 || '|' || (c.calculation_snapshot -> 'inputs' -> 'offer' ->> 'duration_minutes') from public.consultation_requests r join public.slot_holds h on h.consultation_request_id = r.id join public.fee_calculations c on c.consultation_request_id = r.id where r.id = '${held.request}';`,
        ),
        "60|60|60",
      );
      // Refusals write nothing.
      setOffer(ann, "synthetic_video", 30, 3000, "XXX");
      const before = allCounts();
      const refusalCase = scenario({
        jurisdiction: world.J.A,
        lawyer: ann,
        path: "instant",
      });
      for (const [message, expected] of [
        [`${MESSAGE_100}y`, "message_too_long||"],
        ["   ", "invalid||"],
        ["", "invalid||"],
        ["z".repeat(20001), "message_too_long||"],
      ]) {
        assert.equal(
          create(refusalCase.client, {
            referral: refusalCase.referral,
            path: "instant",
            message,
          }).line,
          expected,
          `${message.length}`,
        );
      }
      const inB = scenario({
        jurisdiction: world.J.B,
        lawyer: ann,
        path: "instant",
      });
      assert.equal(
        readReview(inB.client, inB.referral)[0].message_maximum_characters,
        null,
      );
      assert.equal(
        create(inB.client, {
          referral: inB.referral,
          path: "instant",
          message: "hello",
        }).line,
        "message_not_permitted||",
      );
      const inX = scenario({
        jurisdiction: world.J.X,
        lawyer: ann,
        path: "instant",
      });
      assert.equal(
        readReview(inX.client, inX.referral)[0].message_maximum_characters,
        null,
      );
      assert.equal(
        create(inX.client, {
          referral: inX.referral,
          path: "instant",
          message: "hello",
        }).line,
        "policy_unavailable||",
      );
      // Only the refusal scenarios' own fixtures were written meanwhile.
      const after = allCounts();
      for (const table of [
        "consultation_requests",
        "fee_calculations",
        "slot_holds",
        "audit_events",
      ]) {
        assert.equal(after[table], before[table], table);
      }
      // Without a message both are accepted.
      assert.equal(
        create(inB.client, { referral: inB.referral, path: "instant" }).outcome,
        "created",
      );
      assert.equal(
        create(inX.client, { referral: inX.referral, path: "instant" }).outcome,
        "created",
      );
      // The column checks, for every role (the owner here).
      const column = (field, value) =>
        refused(
          `insert into public.consultation_requests (intake_id, client_id, selected_attorney_id, referral_id, request_path, referral_policy_version_id, requested_modality, requested_duration_minutes, client_message, state)
           values ('${refusalCase.client.intake}', '${refusalCase.client.client}', '${ann.profile}', '${refusalCase.referral}', 'instant', '${world.policies.referral[world.J.A]}', 'synthetic_video', ${field === "duration" ? value : 30}, ${field === "message" ? lit(value) : "null"}, 'created');`,
        );
      assert.equal(column("message", "w".repeat(20001)), "23514");
      assert.equal(column("message", "  \n "), "23514");
      assert.equal(column("message", ""), "23514");
      assert.equal(column("duration", 0), "23514");
      assert.equal(column("duration", 1441), "23514");
      return { stored_length: MESSAGE_100.length };
    },
  );
  await check(
    "MSG-2 lowering the maximum (a new referral version) leaves stored messages unchanged and the maximum that applied stays readable from the version the Request records; new Requests are held to the new maximum; neither the message nor the duration of a Request ever changes",
    () => {
      const { client, request } = world.messageRequest;
      endPolicy(world.policies.referral[world.J.A]);
      const old = world.policies.referral[world.J.A];
      world.policies.referral[world.J.A] = policy("referral", world.J.A, {
        outcome_codes: ["synthetic_closed"],
        request_message_maximum_characters: 10,
      });
      assert.equal(readRequest(client, request)[0].client_message, MESSAGE_100);
      assert.equal(
        sql(
          `select l.outcome || '|' || l.maximum_characters from public.consultation_requests r cross join lateral public.request_message_limit(r.referral_policy_version_id) l where r.id = '${request}';`,
        ),
        "set|100",
      );
      assert.equal(
        sql(
          `select referral_policy_version_id from public.consultation_requests where id = '${request}';`,
        ),
        old,
      );
      const next = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ann,
        path: "instant",
      });
      assert.equal(
        readReview(next.client, next.referral)[0].message_maximum_characters,
        10,
      );
      assert.equal(
        create(next.client, {
          referral: next.referral,
          path: "instant",
          message: "x".repeat(11),
        }).line,
        "message_too_long||",
      );
      const fits = create(next.client, {
        referral: next.referral,
        path: "instant",
        message: "x".repeat(10),
      });
      assert.equal(fits.outcome, "created", fits.line);
      for (const statement of [
        `update public.consultation_requests set client_message = 'changed' where id = '${request}';`,
        `update public.consultation_requests set client_message = null where id = '${request}';`,
        `update public.consultation_requests set requested_duration_minutes = 60 where id = '${request}';`,
      ]) {
        assert.equal(refused(statement), "55000", statement);
      }
      assert.equal(readRequest(client, request)[0].client_message, MESSAGE_100);
    },
  );
  await check(
    "MSG-3 only the client reads the message: the client through their own Request read and the P1 own-row policy; another client, an attorney (the Request's own included) and anon read nothing of it; service_role reads every other column but not the message; no audit event carries it",
    () => {
      const { client, request } = world.messageRequest;
      assert.equal(
        asClient(
          client,
          `select client_message from public.consultation_requests where id = '${request}';`,
        ),
        MESSAGE_100.split("\n").at(-1),
      );
      assert.deepEqual(readRequest(world.stranger, request), []);
      assert.equal(
        asClient(
          world.stranger,
          `select count(*) from public.consultation_requests where id = '${request}';`,
        ),
        "0",
      );
      for (const lawyer of [world.ann, world.bob]) {
        assert.equal(
          asAttorney(
            lawyer,
            `select count(*) from public.consultation_requests where id = '${request}';`,
          ),
          "0",
        );
        assert.deepEqual(
          rowsAs(
            "authenticated",
            lawyer.auth,
            `select row_to_json(r)::text from public.client_request('${request}') r;`,
          ),
          [],
        );
      }
      for (const statement of [
        `select client_message from public.consultation_requests where id = '${request}';`,
        `select * from public.client_request('${request}');`,
      ]) {
        assert.equal(as("anon", null, statement), "ERROR 42501", statement);
      }
      assert.equal(
        as(
          "service_role",
          null,
          `select client_message from public.consultation_requests where id = '${request}';`,
        ),
        "ERROR 42501",
      );
      assert.equal(
        as(
          "service_role",
          null,
          `select requested_duration_minutes from public.consultation_requests where id = '${request}';`,
        ),
        "30",
      );
      assert.equal(
        count(
          "audit_events",
          "coalesce(after_snapshot::text, '') like '%Synthetic</b>%' or coalesce(before_snapshot::text, '') like '%Synthetic</b>%' or coalesce(after_snapshot::text, '') like '%xxxxxxxxxx%'",
        ),
        0,
      );
    },
  );
  await check(
    "MSG-4 the deferred evidence check makes the duration mandatory for every role: even the owner cannot commit a Request without its duration, or a scheduled one whose Hold does not last exactly its duration; complete evidence with the duration commits",
    () => {
      const instantCase = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ann,
        path: "instant",
      });
      const scheduledCase = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ann,
        path: "scheduled",
      });
      const base = (entry, options) =>
        ownerRequestSql({
          referral: entry.referral,
          client: entry.client,
          attorney: world.ann,
          jurisdiction: world.J.A,
          ...options,
        });
      assert.equal(refused(base(instantCase, { duration: null })), "23514");
      assert.equal(
        refused(
          base(scheduledCase, {
            path: "scheduled",
            slot: at(9, 10),
            duration: 60,
          }),
        ),
        "23514",
      );
      sql(["begin;", base(instantCase, {}), "commit;"].join("\n"));
      sql(
        [
          "begin;",
          base(scheduledCase, { path: "scheduled", slot: at(9, 10) }),
          "commit;",
        ].join("\n"),
      );
      assert.equal(
        count(
          "consultation_requests",
          `referral_id in ('${instantCase.referral}', '${scheduledCase.referral}') and requested_duration_minutes = 30`,
        ),
        2,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// PUB: public offers (PS-A3 section 6)
// ---------------------------------------------------------------------------

async function publicChecks() {
  await check(
    "PUB-1 the public offers read answers exactly modality, duration, listed price and currency, only for a publicly listed attorney (an unknown, applicant, under-review or suspended attorney and a jurisdiction where the attorney is not listed answer no row), only current offers whose pair is permitted, and with a jurisdiction only the offers priced there (in its currency and bounds); it persists nothing and anon may execute exactly the three S5 reads and it",
    () => {
      const ann = world.ann;
      const outOfBounds = setOffer(ann, "synthetic_audio", 60, 200000);
      assert.equal(outOfBounds.outcome, "created", outOfBounds.line);
      const before = allCounts();
      const all = publicOffers(ann.profile, null);
      assert.ok(all.length > 0);
      for (const row of all) {
        assert.deepEqual(Object.keys(row), [
          "modality",
          "duration_minutes",
          "listed_price_minor",
          "currency_code",
        ]);
      }
      const current = offerRows(
        `attorney_id = '${ann.profile}' and withdrawn_at is null`,
      );
      const permitted = current.filter(
        (o) =>
          OPTIONS_30_60_90.permitted_modalities.includes(o.modality) &&
          OPTIONS_30_60_90.permitted_durations_minutes.includes(
            o.duration_minutes,
          ),
      );
      const key = (o) =>
        `${o.modality}|${o.duration_minutes}|${o.currency_code}|${o.listed_price_minor}`;
      assert.deepEqual(all.map(key).sort(), permitted.map(key).sort());
      const inA = publicOffers(ann.profile, world.J.A);
      assert.ok(inA.every((o) => o.currency_code === "XTS"));
      assert.ok(!inA.some((o) => o.listed_price_minor === 200000));
      assert.ok(all.some((o) => o.listed_price_minor === 200000));
      for (const o of inA) {
        assert.equal(
          QUOTE(ann, world.J.A, o.modality, o.duration_minutes).outcome,
          "priced",
        );
      }
      assert.ok(
        publicOffers(ann.profile, world.J.B).every(
          (o) => o.currency_code === "XXX",
        ),
      );
      // Withdrawn offers are never public.
      const withdrawn = offerRows(
        `attorney_id = '${ann.profile}' and withdrawn_at is not null`,
      );
      assert.ok(withdrawn.length > 0);
      for (const o of withdrawn) {
        assert.ok(
          !all.some(
            (row) =>
              key(row) === key(o) && !current.some((c) => key(c) === key(o)),
          ),
        );
      }
      // Unlisted and unknown attorneys, and a jurisdiction where Ann is not
      // listed, answer no row (owner-written offers make them otherwise
      // visible if the listing were not checked).
      for (const lawyer of [world.pen, world.sus]) {
        offer(lawyer, "synthetic_video", 30, 5000);
        assert.deepEqual(publicOffers(lawyer.profile, null), []);
        assert.deepEqual(publicOffers(lawyer.profile, world.J.A), []);
      }
      assert.deepEqual(publicOffers(uid(), null), []);
      assert.deepEqual(publicOffers(ann.profile, world.J.N), []);
      // Lone is listed in N and M, where no complete Fee Policy prices.
      offer(world.lone, "synthetic_video", 30, 5000);
      assert.equal(publicOffers(world.lone.profile, null).length, 1);
      assert.deepEqual(publicOffers(world.lone.profile, world.J.N), []);
      assert.deepEqual(publicOffers(world.lone.profile, world.J.M), []);
      // Authenticated callers read the same.
      assert.deepEqual(
        publicOffers(ann.profile, world.J.A, "authenticated"),
        inA,
      );
      assert.deepEqual(
        sql(
          "select string_agg(p.oid::regprocedure::text, ';' order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE');",
        ).split(";"),
        // MVP-001 S11 re-pin: and exactly the public read of an attorney's
        // published reviews of the later registered S11 reviews migration
        // (20261127040000).
        [
          "public_attorney_directory(uuid,uuid,text,integer)",
          "public_attorney_offers(uuid,uuid)",
          "public_attorney_profile(uuid,uuid)",
          "public_attorney_reviews(uuid)",
          "public_discovery_filters()",
        ],
      );
      const after = allCounts();
      assert.equal(
        after.attorney_consultation_offers -
          before.attorney_consultation_offers,
        3,
      );
      for (const table of OFFER_TABLES.filter(
        (t) => t !== "attorney_consultation_offers",
      )) {
        assert.equal(after[table], before[table], table);
      }
      return { public_all: all.length, public_a: inA.length };
    },
  );
}

// ---------------------------------------------------------------------------
// CC: concurrency (two persistent sessions, real concurrency)
// ---------------------------------------------------------------------------

async function concurrencyChecks() {
  await check(
    "CC-1 two concurrent price replacements of the same pair (two sessions of the attorney at aal2): the second waits on the first's profile lock, then replaces the first's new offer; exactly one current offer remains and the history is complete and chained (each withdrawal is the next offer's creation instant), with one audit event per replacement",
    async () => {
      const ann = world.ann;
      const where = `attorney_id = '${ann.profile}' and modality = 'synthetic_video' and duration_minutes = 60 and currency_code = 'XTS'`;
      const start = offerRows(where);
      const audits = auditCount();
      const first = await attorneySession("price-a", ann);
      const second = await attorneySession("price-b", ann);
      const one = await first.ok(SET("synthetic_video", 60, 9100));
      const pending = second.send(SET("synthetic_video", 60, 9200));
      await blockedOnLock(second.pid);
      await first.ok("commit;");
      const two = await pending;
      assert.equal(two.sqlstate, "00000", two.stderr);
      await second.ok("commit;");
      first.close();
      second.close();
      assert.equal(lastLine(one).split("|")[0], "replaced");
      assert.equal(lastLine(two.rows).split("|")[0], "replaced");
      const rows = offerRows(where);
      assert.equal(rows.length, start.length + 2);
      assert.deepEqual(
        rows
          .filter((r) => r.withdrawn_at === null)
          .map((r) => r.listed_price_minor),
        [9200],
      );
      for (let i = 0; i < rows.length - 1; i += 1) {
        assert.equal(
          Date.parse(rows[i].withdrawn_at),
          Date.parse(rows[i + 1].created_at),
          `${i}`,
        );
      }
      assert.deepEqual(
        rows.slice(-3).map((r) => r.listed_price_minor),
        [start.at(-1).listed_price_minor, 9100, 9200],
      );
      assert.equal(auditCount(), audits + 2);
      report.concurrency.price_replacements = {
        waited_on_lock: true,
        outcomes: ["replaced", "replaced"],
        current: 9200,
        history: rows.map((r) => r.listed_price_minor),
      };
      return report.concurrency.price_replacements;
    },
  );
  await check(
    "CC-2 a price replacement racing a Request creation: (a) with the replacement first, the creation waits on the attorney's profile lock and its Fee Calculation is the new offer; (b) with the creation first, the replacement waits and the Fee Calculation is the offer current at creation; each Fee Calculation equals exactly one of the two offers and never changes afterwards",
    async () => {
      const ann = world.ann;
      const priceOf = (made) => feeOf(made).attorney_listed_price_minor;
      // (a) The replacement holds the profile lock first.
      const caseA = scenario({
        jurisdiction: world.J.A,
        lawyer: ann,
        path: "instant",
      });
      const attorneyA = await attorneySession("race-att-a", ann);
      const clientA = await clientSession("race-cli-a", caseA.client);
      const setA = await attorneyA.ok(SET("synthetic_video", 30, 6100));
      const pendingA = clientA.send(
        CREATE({ referral: caseA.referral, path: "instant" }),
      );
      await blockedOnLock(clientA.pid);
      await attorneyA.ok("commit;");
      const madeA = await pendingA;
      assert.equal(madeA.sqlstate, "00000", madeA.stderr);
      await clientA.ok("commit;");
      attorneyA.close();
      clientA.close();
      const [outcomeA, requestA] = lastLine(madeA.rows).split("|");
      assert.equal(outcomeA, "created");
      const newOffer = lastLine(setA).split("|")[1];
      assert.equal(priceOf(requestA), 6100);
      assert.equal(
        feeOf(requestA).calculation_snapshot.inputs.offer.id,
        newOffer,
      );
      // (b) The creation holds the profile (FOR SHARE) first.
      const caseB = scenario({
        jurisdiction: world.J.A,
        lawyer: ann,
        path: "instant",
      });
      const clientB = await clientSession("race-cli-b", caseB.client);
      const attorneyB = await attorneySession("race-att-b", ann);
      const madeB = await clientB.ok(
        CREATE({ referral: caseB.referral, path: "instant" }),
      );
      const pendingB = attorneyB.send(SET("synthetic_video", 30, 6200));
      await blockedOnLock(attorneyB.pid);
      await clientB.ok("commit;");
      const setB = await pendingB;
      assert.equal(setB.sqlstate, "00000", setB.stderr);
      await attorneyB.ok("commit;");
      attorneyB.close();
      clientB.close();
      const [outcomeB, requestB] = lastLine(madeB).split("|");
      assert.equal(outcomeB, "created");
      assert.equal(lastLine(setB.rows).split("|")[0], "replaced");
      const feeB = feeOf(requestB);
      assert.equal(feeB.attorney_listed_price_minor, 6100);
      assert.equal(feeB.calculation_snapshot.inputs.offer.id, newOffer);
      // Never changes afterwards, while new quotes use the new price.
      assert.equal(
        QUOTE(ann, world.J.A, "synthetic_video", 30)
          .attorney_listed_price_minor,
        6200,
      );
      assert.deepEqual(feeOf(requestB), feeB);
      assert.equal(priceOf(requestA), 6100);
      report.concurrency.price_against_request = {
        replacement_first: { waited_on_lock: true, fee_price: 6100 },
        creation_first: {
          waited_on_lock: true,
          fee_price: 6100,
          later_price: 6200,
        },
      };
      return report.concurrency.price_against_request;
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
    await offerChecks();
    await configurationChecks();
    await currencyChecks();
    await approvalChecks();
    await messageChecks();
    await publicChecks();
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
