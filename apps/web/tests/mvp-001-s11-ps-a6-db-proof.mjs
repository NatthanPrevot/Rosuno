// MVP-001 S11 PS-A6 disposable PostgreSQL proof (break-glass access, data
// requests, complaint vocabularies as policy configuration and the
// complaint statement; PS-A6 sections 2 to 5 and 8). Explicitly invoked only:
//
//   node apps/web/tests/mvp-001-s11-ps-a6-db-proof.mjs
//
// Deliberately not a *.test.mjs file, so no application test run, p0:test,
// or CI job starts it. It uses Node built-ins and the system-installed
// PostgreSQL 16 initdb, pg_ctl, and psql binaries.
//
// It creates a new mode-0700 temporary directory, initializes a new cluster
// owned by an unprivileged account (never root), and starts it with TCP
// disabled and a private Unix-domain socket (port 54351, so it can run next
// to the other S11 proofs). The roles anon, authenticated, and service_role
// (BYPASSRLS), the synthetic auth schema (auth.users and an auth.uid() that
// reads request.jwt.claim.sub), the hosted platform's default privileges, and
// a no-op public.rls_auto_enable() are synthetic objects of this cluster
// only. Every migration is applied unmodified, in order, each in one
// transaction, to three databases: the main database records its environment
// as development; a second one records production (a synthetic 20-letter
// project reference) for the production-class vocabulary probe; a third one
// stops after the S11 review corrections, so the catalog the three PS-A6
// migrations leave can be compared with the catalog before them, and then
// receives the three PS-A6 migrations over an existing Complaint Case. The
// three PS-A6 migrations must follow the review corrections and be
// registered.
//
// Configuration: every policy version of the development database is
// development configuration created by the owner role inside this disposable
// cluster (Packet rule 9), as in the other S11 proofs; the complaint
// vocabularies of the probes are synthetic codes (synthetic_*), created
// either as development configuration or through the staff policy commands
// with a synthetic verified authority reference. Every account, reason,
// description, statement, Request, payment and provider event is synthetic
// test data (FP-1 section 3.4), never a product value or decision. No
// provider, Supabase project, network service or pre-existing cluster is
// contacted, and nothing persists after the run.
//
// Request sessions are modelled as PostgREST sets them from a verified JWT:
// request.jwt.claim.sub and the JSON request.jwt.claims (clients at aal1,
// attorneys and staff at aal2 unless a probe says otherwise); anonymous
// requests run as anon without a subject.
//
// The probes cover PS-A6 as implemented: the migration order and
// registration; the DDL inventory (exactly two relations, one column, one
// policy type row and two capability rows; RLS on; no API-role privilege on
// the relations); every constraint and guard for every role, the owner
// included; the privilege and scope matrix of every function; the
// break-glass lifecycle with its derived states across time, the 24-hour
// bound, the audited access path and its refusals, and that no other path
// honours a grant or writes through one; the data request lifecycle,
// withdrawal, idempotency, the Legal Hold rule for each covered scope type
// and that a decision changes no data; the complaint vocabulary selection and
// validation both ways, classification and resolution with configured codes;
// the statement's constraints, immutability and restriction; and real
// concurrency with two or more persistent sessions (two approvals, approval
// racing revocation, access racing revocation, two decisions, withdrawal
// racing decision, double submission, a hold racing a deletion decision and
// mixed load), with the exact observed outcomes. The JSON report goes to
// stdout; exit 0 means PASS, 1 FAIL, 2 cleanup failure.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54351;
const DB = "rosuno_s11_ps_a6_proof";
const PROD_DB = "rosuno_s11_ps_a6_proof_production";
const BASE_DB = "rosuno_s11_ps_a6_proof_base";
const PRODUCTION_REF = "syntheticpsasixproof";
const REPOSITORY_ROOT = path.resolve(
  path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
  "../../..",
);
const MIGRATIONS = path.join(REPOSITORY_ROOT, "supabase/migrations");
// The last S11 migration before PS-A6.
const S11_CORRECTIONS_LAST = "20261127180000_mvp_001_s11_review_corrections.sql";
// MVP-001 S11 PS-A6: the three migrations (registered as sequences 73 to 75).
const PS_A6_MIGRATIONS = Object.freeze([
  "20261127190000_mvp_001_s11_break_glass.sql",
  "20261127200000_mvp_001_s11_data_requests.sql",
  "20261127210000_mvp_001_s11_complaint_configuration.sql",
]);
const BREAK_GLASS_MIGRATION = PS_A6_MIGRATIONS[0];
const DATA_REQUEST_MIGRATION = PS_A6_MIGRATIONS[1];
const COMPLAINT_MIGRATION = PS_A6_MIGRATIONS[2];

const report = {
  proof: "MVP-001 S11 PS-A6 disposable local PostgreSQL proof",
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
    path.join(os.tmpdir(), "rosuno-mvp-001-s11-ps-a6-db-proof-"),
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
    if (PS_A6_MIGRATIONS.includes(file)) {
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
  // PS-A6 follows the S11 review corrections, contiguous and in order, and
  // every PS-A6 migration is registered unreviewed (sequences 73 to 75, each
  // depending on the one before it, citing PS-A6 and its adoption decision),
  // applied nowhere and a Program migration ref.
  const last = files.indexOf(S11_CORRECTIONS_LAST);
  assert.ok(last >= 0, "the S11 review corrections migration is present");
  assert.deepEqual(files.slice(last + 1), [...PS_A6_MIGRATIONS]);
  const workItems = JSON.parse(
    fs.readFileSync(
      path.join(REPOSITORY_ROOT, "governance/work-items/index.json"),
      "utf8",
    ),
  ).work_items;
  const program = workItems.find(
    (item) => item.work_item_id === "WI-P2-MVP-001-TECHNICAL-COMPLETION",
  );
  const registration = PS_A6_MIGRATIONS.map((file, index) => {
    const id = file.replace(/\.sql$/, "");
    const row = registered.find(
      (migration) => migration.artifact_path === `supabase/migrations/${file}`,
    );
    assert.ok(row, `${file} is registered`);
    assert.equal(row.migration_id, id);
    assert.equal(row.sequence, 73 + index);
    assert.equal(row.reviewed, false);
    assert.equal(row.applied_environment, "none");
    assert.deepEqual(row.depends_on, [
      (index === 0 ? S11_CORRECTIONS_LAST : PS_A6_MIGRATIONS[index - 1]).replace(
        /\.sql$/,
        "",
      ),
    ]);
    assert.ok(
      row.authority_refs.includes("PHYSICAL-SPECIFICATION-AMENDMENT-PS-A6-LOCKED"),
    );
    assert.ok(
      row.decision_refs.includes(
        "DEC-20261122-PS-A6-BREAK-GLASS-DATA-REQUESTS-COMPLAINTS",
      ),
    );
    assert.ok(
      typeof row.rollback_plan === "string" && row.rollback_plan !== "",
    );
    assert.ok(program.migration_refs.includes(id), `${id} is a Program ref`);
    return { id, sequence: row.sequence };
  });
  sql(ROLES, "postgres");
  sql(fixtureFor(DB), "postgres");
  sql(fixtureFor(PROD_DB), "postgres");
  sql(fixtureFor(BASE_DB), "postgres");
  report.migrations.notices = applyMigrationsTo(DB, files);
  applyMigrationsTo(PROD_DB, files);
  applyMigrationsTo(BASE_DB, files.slice(0, last + 1));
  report.migrations.applied = files.length;
  report.migrations.ps_a6 = [...PS_A6_MIGRATIONS];
  report.migrations.registration = registration;
  report.migrations.sha256 = Object.fromEntries(
    PS_A6_MIGRATIONS.map((file) => {
      const bytes = fs.readFileSync(path.join(MIGRATIONS, file));
      return [file, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }];
    }),
  );
}

// ---------------------------------------------------------------------------
// Persistent sessions (real concurrency)
// ---------------------------------------------------------------------------

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
    const mark = `__PSA6_${this.label}_${this.n}__`;
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
    process.stderr.write(`[s11-ps-a6-proof] PASS ${name}\n`);
  } catch (error) {
    failed = true;
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
    process.stderr.write(
      `[s11-ps-a6-proof] FAIL ${name}\n${error?.stack ?? error}\n`,
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

const CANCEL_SQL = (c) =>
  `select row_to_json(x)::text from public.consultation_cancel(${lit(c)}) x;`;

// ---------------------------------------------------------------------------
// The PS-A6 seed: two synthetic jurisdictions with the standard synthetic
// configuration, and the staff the probes act as.
// ---------------------------------------------------------------------------

function seed() {
  world.mode = newRegulatoryMode("SYN_PSA6_MARKETPLACE");
  world.J = {};
  world.policies = {};
  world.policies.bookability = policy("bookability", null, {
    presence_window_seconds: 600,
  });
  world.platform = policy("fee", null, PLATFORM);
  for (const key of ["S", "T"]) {
    const config = JURISDICTIONS.S;
    const id = newJurisdiction(`SYN_PSA6_${key}`);
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
  seedStaff();
}

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
  world.approver = staffWith(["approve_break_glass", null]);
  world.approver2 = staffWith(["approve_break_glass", null]);
  world.approverS = staffWith(["approve_break_glass", world.J.S]);
  world.approverT = staffWith(["approve_break_glass", world.J.T]);
  world.requester = staffWith();
  world.requester2 = staffWith();
  world.dataStaff = staffWith(["manage_data_requests", null]);
  world.dataStaff2 = staffWith(["manage_data_requests", null]);
  world.dataStaffS = staffWith(["manage_data_requests", world.J.S]);
  world.complaints = staffWith(["manage_complaints", null]);
  world.complaintsS = staffWith(["manage_complaints", world.J.S]);
  world.complaintsT = staffWith(["manage_complaints", world.J.T]);
  world.holds = staffWith(["manage_legal_holds", null]);
  world.policyAdmin = staffWith(["manage_policy_configuration", null]);
  world.plainStaff = staffWith();
  world.deactivated = staffWith(["approve_break_glass", null]);
  sql(
    `update public.staff_profiles set staff_state = 'deactivated' where user_id = '${world.deactivated.user}';`,
  );
}

const AAL1 = Object.freeze({ aal: "aal1" });
const NO_CLAIMS = Object.freeze({ aal: null });
const asStaff = (staff, statement, options = {}) =>
  as("authenticated", staff.auth, statement, options);
const keysOf = (row) => Object.keys(row).sort().join(",");

// ---------------------------------------------------------------------------
// Break-glass calls
// ---------------------------------------------------------------------------

const REASON = "Synthetic break-glass reason for a probe";

function requestBG(staff, consultation, reason = REASON, options = {}) {
  const line = asStaff(
    staff,
    `select outcome || '|' || coalesce(break_glass_grant_id::text, '') from public.staff_request_break_glass(${consultation === null ? "null::uuid" : lit(consultation)}, ${reason === null ? "null::text" : lit(reason)});`,
    options,
  );
  if (line.startsWith("ERROR")) {
    return { outcome: line, grant: null };
  }
  const [outcome, grant] = line.split("|");
  return { outcome, grant: grant || null };
}
const approveBG = (staff, grant, seconds, options = {}) =>
  asStaff(
    staff,
    `select public.staff_approve_break_glass(${lit(grant)}::uuid, ${seconds === null ? "null::integer" : seconds});`,
    options,
  );
const revokeBG = (staff, grant, options = {}) =>
  asStaff(
    staff,
    `select public.staff_revoke_break_glass(${lit(grant)}::uuid);`,
    options,
  );
const accessBG = (staff, grant, options = {}) =>
  rowsJson(
    staff,
    `select row_to_json(x)::text from public.staff_break_glass_consultation(${lit(grant)}::uuid) x;`,
    options,
  );
const mineBG = (staff, options = {}) =>
  rowsJson(
    staff,
    "select row_to_json(x)::text from public.staff_break_glass_grants_mine() x;",
    options,
  );
const queueBG = (staff, grantState, offset = 0, options = {}) =>
  rowsJson(
    staff,
    `select row_to_json(x)::text from public.staff_break_glass_queue(${lit(grantState)}, ${offset}) x;`,
    options,
  );
const grantBG = (staff, grant, options = {}) =>
  rowsJson(
    staff,
    `select row_to_json(x)::text from public.staff_break_glass_grant(${lit(grant)}::uuid) x;`,
    options,
  );
const grantRow = (id) => rowOf("break_glass_grants", `id = '${id}'`);
const accessAudits = (grant) =>
  Number(
    sql(
      `select count(*) from public.audit_events where action_code = 'break_glass.accessed' and resource_type = 'break_glass_grant' and resource_id = '${grant}';`,
    ),
  );
// A grant requested by one staff member and approved by a global holder.
function activeGrant(consultation, seconds = 3600, staff = null) {
  const requester = staff ?? staffWith();
  const requested = requestBG(requester, consultation);
  assert.equal(requested.outcome, "requested", JSON.stringify(requested));
  assert.equal(approveBG(world.approver, requested.grant, seconds), "approved");
  return { requester, grant: requested.grant };
}

// ---------------------------------------------------------------------------
// Data request calls
// ---------------------------------------------------------------------------

function submitDR(client, type, details = null, options = AAL1) {
  const line = as(
    "authenticated",
    client.auth,
    `select outcome || '|' || coalesce(data_request_id::text, '') from public.client_submit_data_request(${type === null ? "null::text" : lit(type)}, ${details === null ? "null::text" : lit(details)});`,
    options,
  );
  if (line.startsWith("ERROR")) {
    return { outcome: line, id: null };
  }
  const [outcome, id] = line.split("|");
  return { outcome, id: id || null };
}
const withdrawDR = (client, id, options = AAL1) =>
  as(
    "authenticated",
    client.auth,
    `select public.client_withdraw_data_request(${lit(id)}::uuid);`,
    options,
  );
const myDR = (client, options = AAL1) =>
  rowsJson(
    client,
    "select row_to_json(x)::text from public.client_data_requests() x;",
    options,
  );
const queueDR = (staff, requestState, offset = 0, options = {}) =>
  rowsJson(
    staff,
    `select row_to_json(x)::text from public.staff_data_request_queue(${lit(requestState)}, ${offset}) x;`,
    options,
  );
const oneDR = (staff, id, options = {}) =>
  rowsJson(
    staff,
    `select row_to_json(x)::text from public.staff_data_request(${lit(id)}::uuid) x;`,
    options,
  );
const assignDR = (staff, id, options = {}) =>
  asStaff(
    staff,
    `select public.staff_assign_data_request(${lit(id)}::uuid);`,
    options,
  );
const decideDR = (staff, id, outcome, options = {}) =>
  asStaff(
    staff,
    `select public.staff_decide_data_request(${lit(id)}::uuid, ${outcome === null ? "null::text" : lit(outcome)});`,
    options,
  );
const drRow = (id) => rowOf("data_requests", `id = '${id}'`);
// A data request of a client taken into review by a data request holder.
function inReview(client, type, staff = world.dataStaff) {
  const submitted = submitDR(client, type);
  assert.equal(submitted.outcome, "submitted", JSON.stringify(submitted));
  assert.equal(assignDR(staff, submitted.id), "applied");
  return submitted.id;
}

// ---------------------------------------------------------------------------
// Complaint calls
// ---------------------------------------------------------------------------

function openComplaint(
  account,
  { consultation = null, referral = null, statement } = {},
  options = {},
) {
  const args = [
    consultation === null ? "null::uuid" : lit(consultation),
    referral === null ? "null::uuid" : lit(referral),
    ...(statement === undefined
      ? []
      : [statement === null ? "null::text" : lit(statement)]),
  ];
  const line = as(
    "authenticated",
    account.auth,
    `select outcome || '|' || coalesce(complaint_case_id::text, '') from public.complaint_open(${args.join(", ")});`,
    options,
  );
  if (line.startsWith("ERROR")) {
    return { outcome: line, id: null };
  }
  const [outcome, id] = line.split("|");
  return { outcome, id: id || null };
}
const myComplaints = (account, options = {}) =>
  rowsJson(
    account,
    "select row_to_json(x)::text from public.complaint_cases_mine() x;",
    options,
  );
const complaintCaseAs = (staff, id, options = {}) =>
  rowsJson(
    staff,
    `select row_to_json(x)::text from public.staff_complaint_case(${lit(id)}::uuid) x;`,
    options,
  );
const complaintQueueAs = (staff, complaintState, options = {}) =>
  rowsJson(
    staff,
    `select row_to_json(x)::text from public.staff_complaint_queue(${lit(complaintState)}, 0) x;`,
    options,
  );
const updateComplaint = (staff, id, action, options = {}) =>
  asStaff(
    staff,
    `select public.staff_update_complaint(${lit(id)}::uuid, ${lit(action)});`,
    options,
  );
const classifyComplaint = (staff, id, code, options = {}) =>
  asStaff(
    staff,
    `select public.staff_classify_complaint(${lit(id)}::uuid, ${lit(code)});`,
    options,
  );
const resolveComplaint = (staff, id, code, options = {}) =>
  asStaff(
    staff,
    `select public.staff_resolve_complaint(${lit(id)}::uuid, ${lit(code)});`,
    options,
  );
const complaintRow = (id) => rowOf("complaint_cases", `id = '${id}'`);
const vocabularyOf = (jurisdiction, db = DB) =>
  sql(
    `select outcome || '|' || coalesce(policy_version_id::text, '') || '|' || array_to_string(category_codes, ',') || '|' || array_to_string(resolution_codes, ',') from public.complaint_vocabulary(${jurisdiction === null ? "null::uuid" : lit(jurisdiction)}, now());`,
    db,
  );
// A development complaint version (owner fixture, Packet rule 9), closed
// again by the probe that planted it.
function complaintVersion(jurisdiction, parameters) {
  return policy("complaint", jurisdiction, parameters);
}
function closeVersion(version) {
  sql(
    `update public.policy_versions set effective_until = now() where id = '${version}';`,
  );
}
const COMPLAINT_CODES = Object.freeze({
  category_codes: ["synthetic_billing", "synthetic_conduct"],
  resolution_codes: ["synthetic_upheld", "synthetic_not_upheld"],
});

function placeHold(staff, type, id, reason = "Synthetic hold reason") {
  const line = asStaff(
    staff,
    `select outcome || '|' || coalesce(legal_hold_id::text, '') from public.staff_place_legal_hold(${lit(type)}, ${lit(id)}::uuid, ${lit(reason)});`,
  );
  const [outcome, hold] = line.split("|");
  return { outcome, hold: hold || null };
}
const releaseHold = (staff, hold) =>
  asStaff(staff, `select public.staff_release_legal_hold(${lit(hold)}::uuid);`);

// Row counts of the business relations a refusal or a decision must leave
// unchanged.
const BUSINESS_TABLES = Object.freeze([
  "users",
  "client_profiles",
  "attorney_profiles",
  "staff_profiles",
  "capability_grants",
  "intakes",
  "referrals",
  "consultation_requests",
  "consultations",
  "bookings",
  "engagements",
  "payment_transactions",
  "messages",
  "resources",
  "documents",
  "resource_sharing_grants",
  "ledger_entries",
  "reviews",
  "policy_versions",
  "complaint_cases",
  "legal_holds",
  "notifications",
  "operational_jobs",
  "break_glass_grants",
  "data_requests",
  "audit_events",
]);
const businessDigest = () =>
  Object.fromEntries(
    BUSINESS_TABLES.map((t) => [
      t,
      sql(
        `select count(*) || ':' || coalesce(md5(string_agg(to_jsonb(x)::text, ',' order by to_jsonb(x)::text)), '') from public.${t} x;`,
      ),
    ]),
  );
const changedTables = (before, after) =>
  Object.keys(before).filter((t) => before[t] !== after[t]);

// ---------------------------------------------------------------------------
// MIG: migrations and the DDL inventory
// ---------------------------------------------------------------------------

// One catalog listing, one entry per line, for the before/after comparison.
const LISTINGS = Object.freeze({
  relations:
    "select coalesce(string_agg(relkind::text || ':' || relname, E'\\n' order by relname), '') from pg_class where relnamespace = 'public'::regnamespace;",
  columns:
    "select coalesce(string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), E'\\n' order by table_name, column_name), '') from information_schema.columns where table_schema = 'public';",
  constraints:
    "select coalesce(string_agg(conrelid::regclass::text || '.' || conname, E'\\n' order by conrelid::regclass::text, conname), '') from pg_constraint where connamespace = 'public'::regnamespace;",
  indexes:
    "select coalesce(string_agg(indexname, E'\\n' order by indexname), '') from pg_indexes where schemaname = 'public';",
  policies:
    "select coalesce(string_agg(tablename || '.' || policyname, E'\\n' order by tablename, policyname), '') from pg_policies where schemaname = 'public';",
  types:
    "select coalesce(string_agg(typname, E'\\n' order by typname), '') from pg_type where typnamespace = 'public'::regnamespace;",
  triggers:
    "select coalesce(string_agg(c.relname || '.' || t.tgname, E'\\n' order by c.relname, t.tgname), '') from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relnamespace = 'public'::regnamespace;",
  functions:
    "select coalesce(string_agg(proname || '(' || pg_get_function_identity_arguments(oid) || ')', E'\\n' order by proname, pg_get_function_identity_arguments(oid)), '') from pg_proc where pronamespace = 'public'::regnamespace;",
  policy_types:
    "select coalesce(string_agg(code, E'\\n' order by code), '') from public.policy_types;",
  capabilities:
    "select coalesce(string_agg(capability_code, E'\\n' order by capability_code), '') from public.capability_definitions;",
});

const linesOf = (text) => (text === "" ? [] : text.split("\n"));
function listingDelta(name, beforeDb, afterDb) {
  const before = new Set(linesOf(sql(LISTINGS[name], beforeDb)));
  const after = new Set(linesOf(sql(LISTINGS[name], afterDb)));
  return {
    added: [...after].filter((x) => !before.has(x)).sort(),
    removed: [...before].filter((x) => !after.has(x)).sort(),
  };
}

const BG_COLUMNS = Object.freeze([
  "id:uuid:NO",
  "requested_by_user_id:uuid:NO",
  "resource_type:text:NO",
  "resource_id:uuid:NO",
  "reason:text:NO",
  "requested_at:timestamp with time zone:NO",
  "approved_by_user_id:uuid:YES",
  "approved_at:timestamp with time zone:YES",
  "expires_at:timestamp with time zone:YES",
  "revoked_by_user_id:uuid:YES",
  "revoked_at:timestamp with time zone:YES",
  "created_at:timestamp with time zone:NO",
]);
const DR_COLUMNS = Object.freeze([
  "id:uuid:NO",
  "requester_user_id:uuid:NO",
  "request_type:text:NO",
  "state:text:NO",
  "details:text:YES",
  "submitted_at:timestamp with time zone:NO",
  "assigned_to_user_id:uuid:YES",
  "decided_by_user_id:uuid:YES",
  "decided_at:timestamp with time zone:YES",
  "outcome_code:text:YES",
  "created_at:timestamp with time zone:NO",
  "updated_at:timestamp with time zone:NO",
]);
const columnsOf = (table, db = DB) =>
  linesOf(
    sql(
      `select coalesce(string_agg(column_name || ':' || data_type || ':' || is_nullable, E'\\n' order by ordinal_position), '') from information_schema.columns where table_schema = 'public' and table_name = '${table}';`,
      db,
    ),
  );

const PS_A6_API = Object.freeze({
  "staff_request_break_glass(uuid, text)": "v",
  "staff_approve_break_glass(uuid, integer)": "v",
  "staff_revoke_break_glass(uuid)": "v",
  "staff_break_glass_grants_mine()": "s",
  "staff_break_glass_queue(text, integer)": "s",
  "staff_break_glass_grant(uuid)": "s",
  "staff_break_glass_consultation(uuid)": "v",
  "client_submit_data_request(text, text)": "v",
  "client_withdraw_data_request(uuid)": "v",
  "client_data_requests()": "s",
  "staff_data_request_queue(text, integer)": "s",
  "staff_data_request(uuid)": "s",
  "staff_assign_data_request(uuid)": "v",
  "staff_decide_data_request(uuid, text)": "v",
  "complaint_open(uuid, uuid, text)": "v",
  "complaint_cases_mine()": "s",
  "staff_complaint_case(uuid)": "s",
});
const PS_A6_INTERNAL = Object.freeze([
  "break_glass_state(timestamp with time zone, timestamp with time zone, timestamp with time zone, timestamp with time zone)",
  "break_glass_resource_jurisdiction(text, uuid)",
  "break_glass_grant_guard()",
  "break_glass_lock_requester()",
  "break_glass_lock_approver(uuid)",
  "break_glass_reader()",
  "data_request_legal_hold_applies(uuid)",
  "data_request_guard()",
  "complaint_parameters_valid(jsonb)",
  // Replaced forward (executable by no API role before and after).
  "policy_parameters_approvable(text, uuid, jsonb)",
  "complaint_vocabulary(uuid, timestamp with time zone)",
  "complaint_case_guard()",
]);
const executorsOf = (signature, db = DB) =>
  sql(
    `select coalesce(string_agg(r.rolname, ',' order by r.rolname), '') from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') and has_function_privilege(r.rolname, 'public.${signature}', 'execute');`,
    db,
  );
const procOf = (signature, db = DB) =>
  sql(
    `select prosecdef::text || '|' || provolatile::text || '|' || coalesce(array_to_string(proconfig, ';'), '') || '|' || pg_get_userbyid(proowner) from pg_proc where oid = 'public.${signature}'::regprocedure;`,
    db,
  );

async function migrationChecks() {
  await check(
    "MIG-1 the three PS-A6 migrations follow the S11 review corrections in order, are registered unreviewed (sequences 73 to 75, each depending on the one before it, citing PS-A6 and its adoption decision, each with a rollback plan) and applied nowhere, are Program migration refs, and apply on plain PostgreSQL to a development and a production-class database without notices",
    () => {
      assert.deepEqual(report.migrations.ps_a6, [...PS_A6_MIGRATIONS]);
      assert.deepEqual(
        report.migrations.notices,
        Object.fromEntries(PS_A6_MIGRATIONS.map((file) => [file, []])),
      );
      return {
        registration: report.migrations.registration,
        sha256: report.migrations.sha256,
      };
    },
  );

  await check(
    "MIG-2 (PS-A6 sections 6 and 8) the DDL inventory is exactly PS-A6: two relations (break_glass_grants and data_requests with exactly the PS-A6 columns, their named constraints, indexes, row types and guard triggers), one column (complaint_cases.statement with its one check), one policy type row (complaint) and two capability rows (approve_break_glass, manage_data_requests); no row policy; the functions added are exactly the PS-A6 commands, reads and internal helpers, with complaint_open taking the statement in place of its two-argument form",
    () => {
      const deltas = Object.fromEntries(
        Object.keys(LISTINGS).map((name) => [
          name,
          listingDelta(name, BASE_DB, DB),
        ]),
      );
      assert.deepEqual(deltas.relations, {
        added: [
          "i:break_glass_grants_pkey",
          "i:break_glass_grants_requested_at_idx",
          "i:break_glass_grants_requester_idx",
          "i:break_glass_grants_resource_idx",
          "i:data_requests_one_open_idx",
          "i:data_requests_pkey",
          "i:data_requests_requester_idx",
          "i:data_requests_state_submitted_idx",
          "r:break_glass_grants",
          "r:data_requests",
        ],
        removed: [],
      });
      assert.deepEqual(columnsOf("break_glass_grants"), [...BG_COLUMNS]);
      assert.deepEqual(columnsOf("data_requests"), [...DR_COLUMNS]);
      assert.deepEqual(
        deltas.columns.added.filter(
          (c) =>
            !c.startsWith("break_glass_grants.") &&
            !c.startsWith("data_requests."),
        ),
        ["complaint_cases.statement:text:YES:"],
      );
      assert.equal(
        deltas.columns.added.length,
        BG_COLUMNS.length + DR_COLUMNS.length + 1,
      );
      assert.deepEqual(deltas.columns.removed, []);
      assert.deepEqual(deltas.constraints, {
        added: [
          "break_glass_grants.break_glass_grants_approval_v1_check",
          "break_glass_grants.break_glass_grants_approved_by_user_id_fkey",
          "break_glass_grants.break_glass_grants_pkey",
          "break_glass_grants.break_glass_grants_reason_v1_check",
          "break_glass_grants.break_glass_grants_requested_by_user_id_fkey",
          "break_glass_grants.break_glass_grants_resource_type_v1_check",
          "break_glass_grants.break_glass_grants_revocation_v1_check",
          "break_glass_grants.break_glass_grants_revoked_by_user_id_fkey",
          "complaint_cases.complaint_cases_statement_v1_check",
          "data_requests.data_requests_assigned_to_user_id_fkey",
          "data_requests.data_requests_decided_by_user_id_fkey",
          "data_requests.data_requests_decision_v1_check",
          "data_requests.data_requests_details_v1_check",
          "data_requests.data_requests_outcome_v1_check",
          "data_requests.data_requests_pkey",
          "data_requests.data_requests_request_type_v1_check",
          "data_requests.data_requests_requester_user_id_fkey",
          "data_requests.data_requests_state_v1_check",
        ],
        removed: [],
      });
      // Every foreign key is on update restrict, on delete restrict.
      assert.equal(
        sql(
          "select count(*) from pg_constraint where contype = 'f' and conrelid in ('public.break_glass_grants'::regclass, 'public.data_requests'::regclass) and (confupdtype <> 'r' or confdeltype <> 'r' or confrelid <> 'public.users'::regclass);",
        ),
        "0",
      );
      assert.deepEqual(deltas.indexes, {
        added: [
          "break_glass_grants_pkey",
          "break_glass_grants_requested_at_idx",
          "break_glass_grants_requester_idx",
          "break_glass_grants_resource_idx",
          "data_requests_one_open_idx",
          "data_requests_pkey",
          "data_requests_requester_idx",
          "data_requests_state_submitted_idx",
        ],
        removed: [],
      });
      assert.deepEqual(deltas.policies, { added: [], removed: [] });
      assert.deepEqual(deltas.types, {
        added: [
          "_break_glass_grants",
          "_data_requests",
          "break_glass_grants",
          "data_requests",
        ],
        removed: [],
      });
      assert.deepEqual(deltas.triggers, {
        added: [
          "break_glass_grants.break_glass_grants_guard",
          "break_glass_grants.break_glass_grants_no_truncate",
          "data_requests.data_requests_guard",
          "data_requests.data_requests_no_truncate",
          "data_requests.data_requests_set_updated_at",
        ],
        removed: [],
      });
      assert.deepEqual(deltas.policy_types, {
        added: ["complaint"],
        removed: [],
      });
      assert.equal(
        sql("select name from public.policy_types where code = 'complaint';"),
        "Complaint",
      );
      assert.deepEqual(deltas.capabilities, {
        added: ["approve_break_glass", "manage_data_requests"],
        removed: [],
      });
      const created = Object.keys(PS_A6_API)
        .concat(PS_A6_INTERNAL)
        .filter(
          (signature) =>
            ![
              "complaint_cases_mine()",
              "staff_complaint_case(uuid)",
              "policy_parameters_approvable(text, uuid, jsonb)",
              "complaint_vocabulary(uuid, timestamp with time zone)",
              "complaint_case_guard()",
            ].includes(signature),
        );
      const named = (list) =>
        list.map((entry) => entry.replace(/\(.*\)$/, "")).sort();
      assert.deepEqual(named(deltas.functions.added), named(created));
      assert.deepEqual(named(deltas.functions.removed), ["complaint_open"]);
      return {
        relations: deltas.relations.added,
        constraints: deltas.constraints.added.length,
        functions_added: deltas.functions.added.length,
      };
    },
  );

  await check(
    "MIG-3 (PS-A6 sections 2 and 3: restricted, function-only writes) row level security is enabled on both relations; anon, authenticated and service_role hold no privilege on either (no SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER), and a direct read or write is refused for each of them",
    () => {
      const privileges = [];
      for (const table of ["break_glass_grants", "data_requests"]) {
        assert.equal(
          sql(
            `select relrowsecurity::text || relforcerowsecurity::text from pg_class where oid = 'public.${table}'::regclass;`,
          ),
          "truefalse",
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
            if (
              sql(
                `select has_table_privilege('${role}', 'public.${table}', '${privilege}');`,
              ) !== "f"
            ) {
              privileges.push(`${role}:${table}:${privilege}`);
            }
          }
          assert.equal(
            as(role, null, `select count(*) from public.${table};`),
            "ERROR 42501",
          );
          assert.equal(
            as(role, null, `delete from public.${table};`),
            "ERROR 42501",
          );
        }
      }
      assert.deepEqual(privileges, []);
      return { roles: 3, privileges_checked: 42 };
    },
  );

  await check(
    "MIG-4 (PS-A6 section 8: the migrations write no business row; an existing case's statement stays null) applied over a database holding a Complaint Case, the three migrations change no row of any existing relation except the two capability rows and the one policy type row they add; the existing case keeps every value and has a null statement; the fresh databases hold no grant, request or version of the migrations' making",
    () => {
      const client = newAccount("active", BASE_DB);
      const profile = uid();
      const kase = uid();
      sql(
        `insert into public.client_profiles (id, user_id) values ('${profile}', '${client.user}');
         insert into public.complaint_cases (id, complainant_user_id, consultation_id, referral_id, jurisdiction_id, state, opened_at) values ('${kase}', '${client.user}', null, null, null, 'opened', now());`,
        BASE_DB,
      );
      const tables = linesOf(
        sql(
          "select string_agg(relname, E'\\n' order by relname) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r';",
          BASE_DB,
        ),
      );
      const digest = (table) =>
        sql(
          `select count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x) - 'statement')::text, ',' order by (to_jsonb(x) - 'statement')::text)), '') from public.${table} x;`,
          BASE_DB,
        );
      const before = Object.fromEntries(tables.map((t) => [t, digest(t)]));
      const notices = applyMigrationsTo(BASE_DB, PS_A6_MIGRATIONS);
      assert.deepEqual(
        notices,
        Object.fromEntries(PS_A6_MIGRATIONS.map((file) => [file, []])),
      );
      const after = Object.fromEntries(tables.map((t) => [t, digest(t)]));
      assert.deepEqual(changedTables(before, after).sort(), [
        "capability_definitions",
        "policy_types",
      ]);
      assert.equal(
        sql(
          `select concat_ws('|', state, statement is null, complainant_user_id = '${client.user}') from public.complaint_cases where id = '${kase}';`,
          BASE_DB,
        ),
        "opened|t|t",
      );
      for (const db of [DB, PROD_DB]) {
        assert.equal(
          sql(
            "select concat_ws(',', (select count(*) from public.break_glass_grants), (select count(*) from public.data_requests), (select count(*) from public.capability_grants), (select count(*) from public.policy_versions where policy_type_code = 'complaint'), (select count(*) from public.complaint_cases where statement is not null));",
            db,
          ),
          "0,0,0,0,0",
        );
      }
      return { tables_compared: tables.length };
    },
  );

  await check(
    "PRIV-1 every PS-A6 command and read is security definer with search_path pg_catalog, pg_temp, owned by postgres and executable by authenticated only (the volatile ones also bound their lock waits to 3s); every internal, guard and trigger function is executable by no API role; anon and service_role are refused alike",
    () => {
      const seen = {};
      for (const [signature, volatility] of Object.entries(PS_A6_API)) {
        const [definer, vol, config, owner] = procOf(signature).split("|");
        assert.equal(definer, "true", signature);
        assert.equal(vol, volatility, signature);
        assert.equal(owner, "postgres", signature);
        assert.ok(
          config.split(";").includes("search_path=pg_catalog, pg_temp"),
          `${signature}: ${config}`,
        );
        assert.equal(
          config.split(";").includes("lock_timeout=3s"),
          volatility === "v",
          `${signature}: ${config}`,
        );
        assert.equal(executorsOf(signature), "authenticated", signature);
        seen[signature] = executorsOf(signature);
      }
      for (const signature of PS_A6_INTERNAL) {
        assert.equal(executorsOf(signature), "", signature);
        assert.ok(
          procOf(signature).split("|")[2].includes("search_path=pg_catalog"),
          signature,
        );
        seen[signature] = "";
      }
      for (const role of ["anon", "service_role"]) {
        for (const statement of [
          `select * from public.staff_request_break_glass('${uid()}', 'x');`,
          "select * from public.staff_break_glass_grants_mine();",
          `select * from public.staff_break_glass_consultation('${uid()}');`,
          "select * from public.client_submit_data_request('access', null);",
          "select * from public.client_data_requests();",
          `select * from public.staff_decide_data_request('${uid()}', 'denied');`,
          "select * from public.complaint_open(null, null, 'x');",
          "select public.complaint_parameters_valid('{}'::jsonb);",
          `select public.data_request_legal_hold_applies('${uid()}');`,
        ]) {
          assert.equal(as(role, null, statement), "ERROR 42501", statement);
        }
      }
      assert.equal(
        executorsOf("complaint_open(uuid, uuid, text)"),
        "authenticated",
      );
      assert.equal(
        sql(
          "select count(*) from pg_proc where proname = 'complaint_open' and pronamespace = 'public'::regnamespace;",
        ),
        "1",
      );
      return seen;
    },
  );
}

// ---------------------------------------------------------------------------
// BG: break-glass grants (PS-A6 section 2)
// ---------------------------------------------------------------------------

async function breakGlassChecks() {
  // One Consultation of each jurisdiction, with Messages and documents.
  const c = readyConsultation("S");
  assert.equal(clientSend(c, "Synthetic client message one").outcome, "sent");
  assert.equal(attorneySend(c, "Synthetic attorney reply").outcome, "sent");
  const clientDoc = uploadDocument(c.client, c.consultation, AAL1);
  const attorneyDoc = uploadDocument(c.lawyer, c.consultation);
  const t = readyConsultation("T");
  world.bg = { c, t, clientDoc, attorneyDoc };

  await check(
    "BG-1 (PS-A6 section 2 rules 1, 5 and 8) an active staff member at aal2 requests access to one existing Consultation with a reason (trimmed; not blank, at most 2,000 characters, no control characters); the grant is recorded as a request with no approval or revocation; a repeated request while one is requested or active answers that grant (existing) and records nothing; a malformed request is invalid; an unknown Consultation is not found; a client, an attorney, a staff member at aal1 or without claims, a deactivated Staff Profile and a suspended User are denied alike; the request is audited once without the reason",
    () => {
      const requester = staffWith();
      const audits = Number(sql("select count(*) from public.audit_events;"));
      const first = requestBG(requester, c.consultation, `  ${REASON}  `);
      assert.equal(first.outcome, "requested");
      const row = grantRow(first.grant);
      assert.equal(row.reason, REASON);
      assert.equal(row.resource_type, "consultation");
      assert.equal(row.resource_id, c.consultation);
      assert.equal(row.requested_by_user_id, requester.user);
      for (const key of [
        "approved_by_user_id",
        "approved_at",
        "expires_at",
        "revoked_by_user_id",
        "revoked_at",
      ]) {
        assert.equal(row[key], null, key);
      }
      const again = requestBG(requester, c.consultation, "Another reason");
      assert.deepEqual(again, { outcome: "existing", grant: first.grant });
      assert.equal(
        Number(sql("select count(*) from public.audit_events;")),
        audits + 1,
      );
      const audit = auditsFor("break_glass_grant", first.grant);
      assert.deepEqual(audit, [
        {
          action: "break_glass_grant.requested",
          actor_type: "staff",
          actor_user_id: requester.user,
          after: {
            resource_type: "consultation",
            resource_id: c.consultation,
            state: "requested",
          },
          before: null,
          policy_references: null,
        },
      ]);
      assert.equal(
        sql(
          `select count(*) from public.audit_events where after_snapshot::text like '%${REASON}%' or before_snapshot::text like '%${REASON}%';`,
        ),
        "0",
      );
      const suspended = staffWith();
      sql(
        `update public.users set account_state = 'suspended' where id = '${suspended.user}';`,
      );
      const outcomes = {
        blank: requestBG(requester, t.consultation, "   ").outcome,
        long: requestBG(requester, t.consultation, "x".repeat(2001)).outcome,
        max: requestBG(staffWith(), t.consultation, "x".repeat(2000)).outcome,
        control: requestBG(requester, t.consultation, "a\u0001b").outcome,
        no_reason: requestBG(requester, t.consultation, null).outcome,
        no_consultation: requestBG(requester, null).outcome,
        unknown: requestBG(requester, uid()).outcome,
        client: requestBG(c.client, c.consultation, REASON, AAL1).outcome,
        attorney: requestBG(c.lawyer, c.consultation).outcome,
        aal1: requestBG(requester, t.consultation, REASON, AAL1).outcome,
        no_claims: requestBG(requester, t.consultation, REASON, NO_CLAIMS)
          .outcome,
        deactivated: requestBG(world.deactivated, c.consultation).outcome,
        suspended: requestBG(suspended, c.consultation).outcome,
        anon: as(
          "anon",
          null,
          `select outcome from public.staff_request_break_glass('${c.consultation}', 'x');`,
        ),
      };
      assert.deepEqual(outcomes, {
        blank: "invalid",
        long: "invalid",
        max: "requested",
        control: "invalid",
        no_reason: "invalid",
        no_consultation: "invalid",
        unknown: "not_found",
        client: "denied",
        attorney: "denied",
        aal1: "denied",
        no_claims: "denied",
        deactivated: "denied",
        suspended: "denied",
        anon: "ERROR 42501",
      });
      return outcomes;
    },
  );

  await check(
    "BG-2 (PS-A6 section 2 rules 3 and 8; has_staff_capability scope) a holder of approve_break_glass for the Consultation's jurisdiction (or a global holder) approves a requested grant for 1 to 86,400 seconds with no default: the access is active at once and expires exactly that long after the approval; the requester never approves their own request, even holding the capability; another jurisdiction's holder, a staff member without the capability, a holder at aal1, a deactivated holder and the requester are refused; an unknown grant is not found for a global holder and denied for a scoped one; a second approval answers already_active and changes nothing; each approval is audited once",
    () => {
      const requester = staffWith();
      const g = requestBG(requester, c.consultation).grant;
      const before = JSON.stringify(grantRow(g));
      const refusals = {
        zero: approveBG(world.approverS, g, 0),
        over: approveBG(world.approverS, g, 86401),
        none: approveBG(world.approverS, g, null),
        other_jurisdiction: approveBG(world.approverT, g, 600),
        plain: approveBG(world.plainStaff, g, 600),
        requester: approveBG(requester, g, 600),
        aal1: approveBG(world.approverS, g, 600, AAL1),
        deactivated: approveBG(world.deactivated, g, 600),
        unknown_global: approveBG(world.approver, uid(), 600),
        unknown_scoped: approveBG(world.approverS, uid(), 600),
      };
      assert.deepEqual(refusals, {
        zero: "invalid",
        over: "invalid",
        none: "invalid",
        other_jurisdiction: "denied",
        plain: "denied",
        requester: "denied",
        aal1: "denied",
        deactivated: "denied",
        unknown_global: "not_found",
        unknown_scoped: "denied",
      });
      assert.equal(JSON.stringify(grantRow(g)), before);
      // A holder who requested access cannot approve their own request.
      const own = requestBG(world.approver2, t.consultation).grant;
      assert.equal(approveBG(world.approver2, own, 600), "own_request");
      assert.equal(grantRow(own).approved_at, null);
      assert.equal(approveBG(world.approverS, g, 86400), "approved");
      const row = grantRow(g);
      assert.equal(row.approved_by_user_id, world.approverS.user);
      assert.equal(ms(row.expires_at) - ms(row.approved_at), 86400 * 1000);
      assert.equal(approveBG(world.approver, g, 600), "already_active");
      assert.equal(JSON.stringify(grantRow(g)), JSON.stringify(row));
      assert.deepEqual(
        auditsFor("break_glass_grant", g).map((a) => [
          a.action,
          a.actor_user_id,
          a.before,
          a.after.state,
          a.after.duration_seconds,
        ]),
        [
          ["break_glass_grant.requested", requester.user, null, "requested", undefined],
          [
            "break_glass_grant.approved",
            world.approverS.user,
            { state: "requested" },
            "active",
            86400,
          ],
        ],
      );
      // The requester's own grant is active for them and for nobody else.
      assert.deepEqual(
        mineBG(requester).map((r) => [r.break_glass_grant_id, r.state]),
        [[g, "active"]],
      );
      return { refusals, duration_ms: ms(row.expires_at) - ms(row.approved_at) };
    },
  );

  await check(
    "BG-3 (PS-A6 section 2 rules 2 and 4) revocation by a holder in scope refuses a request that was never approved (state revoked) and ends an active grant at once; an already revoked or expired grant answers its state and changes nothing; a later approval of a refused request answers already_revoked; another jurisdiction's holder and a staff member without the capability are refused; each revocation is audited once",
    async () => {
      const requested = requestBG(staffWith(), c.consultation).grant;
      const active = activeGrant(c.consultation).grant;
      const expiring = activeGrant(c.consultation, 1).grant;
      const outcomes = {
        other_jurisdiction: revokeBG(world.approverT, requested),
        plain: revokeBG(world.plainStaff, requested),
        refuse: revokeBG(world.approverS, requested),
        refuse_again: revokeBG(world.approverS, requested),
        approve_refused: approveBG(world.approver, requested, 600),
        end: revokeBG(world.approver, active),
        end_again: revokeBG(world.approver, active),
      };
      await untilPast(grantRow(expiring).expires_at);
      const expiredBefore = JSON.stringify(grantRow(expiring));
      outcomes.expired = revokeBG(world.approver, expiring);
      assert.equal(JSON.stringify(grantRow(expiring)), expiredBefore);
      assert.deepEqual(outcomes, {
        other_jurisdiction: "denied",
        plain: "denied",
        refuse: "refused",
        refuse_again: "already_revoked",
        approve_refused: "already_revoked",
        end: "ended",
        end_again: "already_revoked",
        expired: "already_expired",
      });
      assert.equal(grantRow(requested).approved_at, null);
      assert.equal(grantRow(requested).revoked_by_user_id, world.approverS.user);
      assert.ok(grantRow(active).revoked_at !== null);
      assert.deepEqual(
        auditsFor("break_glass_grant", requested).map((a) => a.action),
        ["break_glass_grant.requested", "break_glass_grant.refused"],
      );
      assert.deepEqual(
        auditsFor("break_glass_grant", active).map((a) => [
          a.action,
          a.before?.state ?? null,
        ]),
        [
          ["break_glass_grant.requested", null],
          ["break_glass_grant.approved", "requested"],
          ["break_glass_grant.revoked", "active"],
        ],
      );
      return outcomes;
    },
  );

  await check(
    "BG-4 (PS-A6 section 2 rule 2; PS P3) the state is derived from the recorded facts at read time and no state column or job exists: one grant reads requested, then active after its approval, then expired once its expiry passes, with no write in between; a revoked grant reads revoked; the requester's list, the holders' queue by state and the one-grant read agree; a scoped holder's queue holds its jurisdiction's grants only; nobody else reads a grant",
    async () => {
      const requester = staffWith();
      const g = requestBG(requester, t.consultation).grant;
      const stateNow = () => grantBG(requester, g)[0].state;
      assert.equal(stateNow(), "requested");
      assert.equal(approveBG(world.approverT, g, 2), "approved");
      assert.equal(stateNow(), "active");
      const rowActive = JSON.stringify(grantRow(g));
      assert.ok(queueBG(world.approverT, "active").some((r) => r.break_glass_grant_id === g));
      await untilPast(grantRow(g).expires_at);
      assert.equal(stateNow(), "expired");
      assert.equal(JSON.stringify(grantRow(g)), rowActive);
      assert.ok(queueBG(world.approver, "expired").some((r) => r.break_glass_grant_id === g));
      assert.ok(!queueBG(world.approver, "active").some((r) => r.break_glass_grant_id === g));
      assert.deepEqual(
        mineBG(requester).map((r) => r.state),
        ["expired"],
      );
      assert.equal(
        sql(
          "select count(*) from information_schema.columns where table_name = 'break_glass_grants' and column_name in ('state', 'status');",
        ),
        "0",
      );
      // Scope: the S holder never reads the T grant; the T holder does.
      assert.equal(grantBG(world.approverS, g).length, 0);
      assert.equal(grantBG(world.approverT, g).length, 1);
      assert.ok(
        !queueBG(world.approverS, "expired").some(
          (r) => r.break_glass_grant_id === g,
        ),
      );
      const others = {
        plain: grantBG(world.plainStaff, g).length,
        aal1: grantBG(requester, g, AAL1).length,
        client: rowsJson(c.client, `select row_to_json(x)::text from public.staff_break_glass_grant('${g}') x;`, AAL1).length,
        plain_mine: mineBG(world.plainStaff).length,
        plain_queue: queueBG(world.plainStaff, "expired").length,
        approver_aal1_queue: queueBG(world.approver, "expired", 0, AAL1).length,
        bad_state: queueBG(world.approver, "approved").length,
      };
      assert.deepEqual(others, {
        plain: 0,
        aal1: 0,
        client: 0,
        plain_mine: 0,
        plain_queue: 0,
        approver_aal1_queue: 0,
        bad_state: 0,
      });
      const keys = keysOf(grantBG(world.approverT, g)[0]);
      assert.equal(
        keys,
        "approved_at,break_glass_grant_id,expires_at,jurisdiction_id,may_decide,reason,requested_at,requested_by_me,resource_id,resource_type,revoked_at,state",
      );
      return { states: ["requested", "active", "expired"], others };
    },
  );

  await check(
    "BG-5 (PS-A6 section 2 rule 7) the one break-glass access path answers only the caller's own grant that is active now, for exactly the Consultation it names: its record (state, scheduled times, outcome), its visible Messages (equal to the participants' thread) and its documents' current versions (metadata only), and writes exactly one audit event with the grant's id per access and nothing else; a grant that is requested, expired or revoked, another staff member's grant, an unknown id, the requester at aal1 or without claims, a client and a holder of the approval capability get no row and no audit",
    async () => {
      const { requester, grant } = activeGrant(c.consultation);
      const digest = businessDigest();
      const rows = accessBG(requester, grant);
      assert.equal(rows.length, 1);
      const view = rows[0];
      assert.equal(
        keysOf(view),
        "break_glass_grant_id,consultation_id,consultation_state,documents,duration_minutes,ended_at,expires_at,messages,modality,older_documents_not_shown,older_messages_not_shown,outcome_code,request_path,scheduled_end_at,scheduled_start_at,started_at",
      );
      assert.equal(view.break_glass_grant_id, grant);
      assert.equal(view.consultation_id, c.consultation);
      assert.equal(view.consultation_state, consultationRow(c.consultation).state);
      const thread = messagesAs(c.client, c.consultation, AAL1);
      assert.deepEqual(
        view.messages.map((m) => [m.message_id, m.sender_role, m.body]),
        thread.map((m) => [m.message_id, m.sender_role, m.body]),
      );
      assert.deepEqual(
        view.documents.map((d) => [d.resource_id, d.uploaded_by]).sort(),
        [
          [clientDoc, "client"],
          [attorneyDoc, "attorney"],
        ].sort(),
      );
      assert.ok(
        view.documents.every(
          (d) =>
            keysOf(d) ===
            "byte_size,created_at,document_id,mime_type,resource_id,sharing,uploaded_by,version_label",
        ),
      );
      assert.equal(accessAudits(grant), 1);
      const after = businessDigest();
      assert.deepEqual(changedTables(digest, after), ["audit_events"]);
      assert.equal(accessBG(requester, grant).length, 1);
      assert.equal(accessAudits(grant), 2);
      assert.deepEqual(
        auditsFor("break_glass_grant", grant)
          .filter((a) => a.action === "break_glass.accessed")
          .map((a) => [a.actor_user_id, a.after]),
        [
          [requester.user, { resource_type: "consultation", resource_id: c.consultation }],
          [requester.user, { resource_type: "consultation", resource_id: c.consultation }],
        ],
      );
      const requested = requestBG(staffWith(), c.consultation);
      const revoked = activeGrant(c.consultation);
      assert.equal(revokeBG(world.approver, revoked.grant), "ended");
      const expiring = activeGrant(c.consultation, 1);
      await untilPast(grantRow(expiring.grant).expires_at);
      const audits = Number(sql("select count(*) from public.audit_events;"));
      const refused = {
        requested: accessBG(staffWith(), requested.grant).length,
        requested_own: accessBG(
          { auth: sql(`select u.auth_user_id from public.users u where u.id = '${grantRow(requested.grant).requested_by_user_id}';`) },
          requested.grant,
        ).length,
        revoked: accessBG(revoked.requester, revoked.grant).length,
        expired: accessBG(expiring.requester, expiring.grant).length,
        other_staff: accessBG(world.requester2, grant).length,
        approver: accessBG(world.approver, grant).length,
        unknown: accessBG(requester, uid()).length,
        aal1: accessBG(requester, grant, AAL1).length,
        no_claims: accessBG(requester, grant, NO_CLAIMS).length,
        client: accessBG(c.client, grant, AAL1).length,
        anon: as("anon", null, `select count(*) from public.staff_break_glass_consultation('${grant}');`),
      };
      assert.deepEqual(refused, {
        requested: 0,
        requested_own: 0,
        revoked: 0,
        expired: 0,
        other_staff: 0,
        approver: 0,
        unknown: 0,
        aal1: 0,
        no_claims: 0,
        client: 0,
        anon: "ERROR 42501",
      });
      assert.equal(
        Number(sql("select count(*) from public.audit_events;")),
        audits,
      );
      return { accesses: 2, refused };
    },
  );

  await check(
    "BG-6 (PS-A6 sections 2 rule 7 and 6) no other path honours a grant and no grant authorizes a write: with an active grant for a Consultation, the requester still reads nothing through the participants' reads, the resource metadata predicate, the staff consultation read or the document access authorization, cannot send a Message, upload a document or cancel the Consultation, and holds no capability; the grant names exactly one Consultation, so another Consultation answers nothing either",
    () => {
      const { requester, grant } = activeGrant(c.consultation);
      assert.equal(accessBG(requester, grant).length, 1);
      const digest = businessDigest();
      const probes = {
        messages: messagesAs(requester, c.consultation).length,
        documents: rowsJson(requester, `select row_to_json(x)::text from public.consultation_documents('${c.consultation}') x;`).length,
        metadata: asStaff(requester, `select public.has_resource_metadata_access('${clientDoc}');`),
        staff_consultation: rowsJson(requester, `select row_to_json(x)::text from public.staff_consultation('${c.consultation}') x;`).length,
        capability: asStaff(requester, "select public.has_staff_capability('manage_consultation_operations', null, true);"),
        send: sendAs(requester, c.consultation, "Synthetic break-glass write").outcome,
        upload: beginDocument(requester, c.consultation).outcome,
        authorize: asStaff(requester, `select outcome from public.resource_authorize_access('${clientDoc}', 'document');`),
        cancel: jsonAs(requester, CANCEL_SQL(c.consultation)).outcome ?? null,
        other_consultation_messages: messagesAs(requester, t.consultation).length,
      };
      assert.deepEqual(probes, {
        messages: 0,
        documents: 0,
        metadata: "f",
        staff_consultation: 0,
        capability: "f",
        send: "not_found",
        upload: "not_found",
        authorize: probes.authorize,
        cancel: probes.cancel,
        other_consultation_messages: 0,
      });
      assert.notEqual(probes.authorize, "authorized");
      assert.notEqual(probes.cancel, "cancelled");
      assert.deepEqual(changedTables(digest, businessDigest()), []);
      return probes;
    },
  );

  await check(
    "BG-7 (PS-A6 section 2 rules 1 to 6) the guard and constraints hold for every role, the database owner included: a grant is never deleted or truncated; it is recorded as a request (no approval or revocation at insert) naming one existing Consultation with resource_type consultation and a reason that is not blank and holds at most 2,000 characters; the approval triple is set together, once, by someone other than the requester, with an expiry after the approval and at most 24 hours after it; the revocation pair is set together, once, at or after the request; the requester, resource, reason, request instant, identifier and creation instant never change",
    () => {
      const requester = staffWith();
      const g = requestBG(requester, c.consultation).grant;
      const ins = (extra = {}) => {
        const row = {
          requested_by_user_id: `'${requester.user}'`,
          resource_type: "'consultation'",
          resource_id: `'${c.consultation}'`,
          reason: "'Synthetic owner reason'",
          requested_at: "now()",
          ...extra,
        };
        return `insert into public.break_glass_grants (${Object.keys(row).join(", ")}) values (${Object.values(row).join(", ")});`;
      };
      const upd = (set) =>
        `update public.break_glass_grants set ${set} where id = '${g}';`;
      const outcomes = {
        delete: refused(`delete from public.break_glass_grants where id = '${g}';`),
        truncate: refused("truncate public.break_glass_grants;"),
        insert_approved: refused(ins({ approved_by_user_id: `'${world.approver.user}'`, approved_at: "now()", expires_at: "now() + interval '1 hour'" })),
        insert_revoked: refused(ins({ revoked_by_user_id: `'${world.approver.user}'`, revoked_at: "now()" })),
        unknown_consultation: refused(ins({ resource_id: `'${uid()}'` })),
        other_type: refused(ins({ resource_type: "'intake'" })),
        blank_reason: refused(ins({ reason: "'   '" })),
        long_reason: refused(ins({ reason: `'${"x".repeat(2001)}'` })),
        partial_approval: refused(upd(`approved_by_user_id = '${world.approver.user}', approved_at = now()`)),
        self_approval: refused(upd(`approved_by_user_id = '${requester.user}', approved_at = now(), expires_at = now() + interval '1 hour'`)),
        over_24h: refused(upd(`approved_by_user_id = '${world.approver.user}', approved_at = now(), expires_at = now() + interval '24 hours 1 second'`)),
        not_after: refused(upd(`approved_by_user_id = '${world.approver.user}', approved_at = now(), expires_at = now()`)),
        partial_revocation: refused(upd(`revoked_at = now()`)),
        revoked_before_request: refused(upd(`revoked_by_user_id = '${world.approver.user}', revoked_at = requested_at - interval '1 second'`)),
        reason_change: refused(upd("reason = 'Changed reason'")),
        resource_change: refused(upd(`resource_id = '${t.consultation}'`)),
        requester_change: refused(upd(`requested_by_user_id = '${world.approver.user}'`)),
        requested_at_change: refused(upd("requested_at = requested_at - interval '1 second'")),
        created_at_change: refused(upd("created_at = created_at - interval '1 second'")),
      };
      // The owner may record an approval once (exactly 24 hours is the bound)
      // and a revocation once; neither changes again.
      acceptedThenRolledBack(ins());
      acceptedThenRolledBack(upd(`approved_by_user_id = '${world.approver.user}', approved_at = now(), expires_at = now() + interval '24 hours'`));
      sql(upd(`approved_by_user_id = '${world.approver.user}', approved_at = now(), expires_at = now() + interval '1 hour'`));
      outcomes.approve_twice = refused(upd("expires_at = expires_at + interval '1 minute'"));
      outcomes.unapprove = refused(upd("approved_by_user_id = null, approved_at = null, expires_at = null"));
      sql(upd(`revoked_by_user_id = '${world.approver.user}', revoked_at = now()`));
      outcomes.revoke_twice = refused(upd("revoked_at = revoked_at + interval '1 second'"));
      outcomes.unrevoke = refused(upd("revoked_by_user_id = null, revoked_at = null"));
      assert.deepEqual(outcomes, {
        delete: "55000",
        truncate: "55000",
        insert_approved: "23514",
        insert_revoked: "23514",
        unknown_consultation: "23503",
        other_type: "23514",
        blank_reason: "23514",
        long_reason: "23514",
        partial_approval: "23514",
        self_approval: "23514",
        over_24h: "23514",
        not_after: "23514",
        partial_revocation: "23514",
        revoked_before_request: "23514",
        reason_change: "55000",
        resource_change: "55000",
        requester_change: "55000",
        requested_at_change: "55000",
        created_at_change: "55000",
        approve_twice: "55000",
        unapprove: "55000",
        revoke_twice: "55000",
        unrevoke: "55000",
      });
      return outcomes;
    },
  );
}

// ---------------------------------------------------------------------------
// DR: data requests (PS-A6 section 3)
// ---------------------------------------------------------------------------

async function dataRequestChecks() {
  await check(
    "DR-1 (PS-A6 section 3 rules 1, 6 and 8) an active client (any aal) submits a request of one of the five types with optional details (trimmed; an empty one is none; at most 20,000 characters): it is recorded submitted with its details and nothing else; one open request per type answers already_open and records nothing (another type is accepted); after a withdrawal the type can be requested again; a malformed type or overlong details are invalid; an attorney without a Client Profile, a staff member, a suspended client and a caller without a User are denied; anon is refused; the submission is audited once with codes only, never the details",
    () => {
      const client = newClient();
      const details = "Synthetic details: please correct the synthetic record.";
      const audits = Number(sql("select count(*) from public.audit_events;"));
      const first = submitDR(client, "correction", `  ${details}  `);
      assert.equal(first.outcome, "submitted");
      const row = drRow(first.id);
      assert.deepEqual(
        [row.requester_user_id, row.request_type, row.state, row.details, row.assigned_to_user_id, row.decided_by_user_id, row.decided_at, row.outcome_code],
        [client.user, "correction", "submitted", details, null, null, null, null],
      );
      assert.deepEqual(submitDR(client, "correction", "again"), {
        outcome: "already_open",
        id: null,
      });
      assert.equal(
        Number(sql("select count(*) from public.audit_events;")),
        audits + 1,
      );
      assert.deepEqual(auditsFor("data_request", first.id), [
        {
          action: "data_request.submitted",
          actor_type: "client",
          actor_user_id: client.user,
          after: { request_type: "correction", state: "submitted" },
          before: null,
          policy_references: null,
        },
      ]);
      assert.equal(
        sql(
          "select count(*) from public.audit_events where after_snapshot::text like '%Synthetic details%' or before_snapshot::text like '%Synthetic details%';",
        ),
        "0",
      );
      const empty = submitDR(client, "access", "   ");
      assert.equal(empty.outcome, "submitted");
      assert.equal(drRow(empty.id).details, null);
      assert.equal(withdrawDR(client, empty.id), "withdrawn");
      assert.equal(submitDR(client, "access").outcome, "submitted");
      const suspended = newClient();
      sql(`update public.users set account_state = 'suspended' where id = '${suspended.user}';`);
      const lawyerOnly = lawyer("S");
      const outcomes = {
        max: submitDR(newClient(), "export", "x".repeat(20000)).outcome,
        long: submitDR(client, "export", "x".repeat(20001)).outcome,
        bad_type: submitDR(client, "erasure").outcome,
        no_type: submitDR(client, null).outcome,
        attorney: submitDR(lawyerOnly, "access", null, {}).outcome,
        staff: submitDR(world.dataStaff, "access", null, {}).outcome,
        suspended: submitDR(suspended, "access").outcome,
        no_user: as("authenticated", uid(), "select outcome from public.client_submit_data_request('access', null);", AAL1),
        anon: as("anon", null, "select outcome from public.client_submit_data_request('access', null);"),
      };
      assert.deepEqual(outcomes, {
        max: "submitted",
        long: "invalid",
        bad_type: "invalid",
        no_type: "invalid",
        attorney: "denied",
        staff: "denied",
        suspended: "denied",
        no_user: "denied",
        anon: "ERROR 42501",
      });
      return outcomes;
    },
  );

  await check(
    "DR-2 (PS-A6 section 3 rule 2) the requester withdraws their own request while it is submitted or in review; a decided or withdrawn request answers its state and changes nothing; another client's request and an unknown id answer not_found alike; a caller who is not an active client is denied; each withdrawal is audited once; the client's own list holds exactly their requests with their details, state, outcome and instants, and nobody else's",
    () => {
      const client = newClient();
      const other = newClient();
      const submitted = submitDR(client, "access").id;
      const reviewed = inReview(client, "export");
      const decided = inReview(client, "restriction");
      assert.equal(decideDR(world.dataStaff, decided, "deferred"), "applied");
      const otherRequest = submitDR(other, "access").id;
      const outcomes = {
        other_client: withdrawDR(client, otherRequest),
        unknown: withdrawDR(client, uid()),
        staff: withdrawDR(world.dataStaff, submitted, {}),
        submitted: withdrawDR(client, submitted),
        again: withdrawDR(client, submitted),
        in_review: withdrawDR(client, reviewed),
        decided: withdrawDR(client, decided),
      };
      assert.deepEqual(outcomes, {
        other_client: "not_found",
        unknown: "not_found",
        staff: "denied",
        submitted: "withdrawn",
        again: "already_withdrawn",
        in_review: "withdrawn",
        decided: "already_decided",
      });
      assert.equal(drRow(otherRequest).state, "submitted");
      assert.equal(drRow(decided).state, "decided");
      assert.deepEqual(
        auditsFor("data_request", submitted).map((a) => [a.action, a.before, a.after]),
        [
          ["data_request.submitted", null, { request_type: "access", state: "submitted" }],
          ["data_request.withdrawn", { state: "submitted" }, { request_type: "access", state: "withdrawn" }],
        ],
      );
      const mine = myDR(client);
      assert.deepEqual(
        mine.map((r) => [r.data_request_id, r.state, r.outcome_code]).sort(),
        [
          [submitted, "withdrawn", null],
          [reviewed, "withdrawn", null],
          [decided, "decided", "deferred"],
        ].sort(),
      );
      assert.equal(
        keysOf(mine[0]),
        "data_request_id,decided_at,details,outcome_code,request_type,state,submitted_at,updated_at",
      );
      assert.deepEqual(myDR(other).map((r) => r.data_request_id), [otherRequest]);
      assert.equal(myDR(world.dataStaff, {}).length, 0);
      return outcomes;
    },
  );

  await check(
    "DR-3 (PS-A6 section 3 rule 8; global grant: a request carries no jurisdiction) staff holding the global manage_data_requests grant at aal2 read the queue by state (never the details) and one request (type, state, details, instants, assignment, the requester's User id and account state, whether a Legal Hold applies); a jurisdiction-scoped holder, a staff member without the grant, the holder at aal1 and a client read nothing",
    () => {
      const client = newClient();
      const id = submitDR(client, "deletion", "Synthetic deletion details").id;
      const queue = queueDR(world.dataStaff, "submitted");
      assert.ok(queue.some((r) => r.data_request_id === id));
      assert.equal(
        keysOf(queue[0]),
        "assigned_to_me,data_request_id,decided_at,outcome_code,request_type,state,submitted_at",
      );
      const one = oneDR(world.dataStaff, id);
      assert.equal(one.length, 1);
      assert.equal(
        keysOf(one[0]),
        "assigned,assigned_to_me,data_request_id,decided_at,details,legal_hold_applies,outcome_code,request_type,requester_account_state,requester_user_id,state,submitted_at,updated_at",
      );
      assert.deepEqual(
        [one[0].details, one[0].requester_user_id, one[0].requester_account_state, one[0].legal_hold_applies, one[0].assigned],
        ["Synthetic deletion details", client.user, "active", false, false],
      );
      const nothing = {
        scoped_queue: queueDR(world.dataStaffS, "submitted").length,
        scoped_one: oneDR(world.dataStaffS, id).length,
        plain: oneDR(world.plainStaff, id).length,
        aal1: oneDR(world.dataStaff, id, AAL1).length,
        client: oneDR(client, id, AAL1).length,
        client_queue: queueDR(client, "submitted", 0, AAL1).length,
        bad_state: queueDR(world.dataStaff, "pending").length,
        unknown: oneDR(world.dataStaff, uid()).length,
      };
      assert.deepEqual(nothing, {
        scoped_queue: 0,
        scoped_one: 0,
        plain: 0,
        aal1: 0,
        client: 0,
        client_queue: 0,
        bad_state: 0,
        unknown: 0,
      });
      return nothing;
    },
  );

  await check(
    "DR-4 (PS-A6 section 3 rules 2, 3 and 4) assignment takes a submitted request into review for the caller or takes over one in review (a repeated assignment to the caller changes and audits nothing); a decision moves a request in review to decided with its outcome, decider and instant, once; a submitted, decided or withdrawn request cannot be decided; a malformed outcome is invalid; a scoped holder and a staff member without the grant are denied; recording a decision changes no other data at all (only the request and one audit event)",
    () => {
      const client = newClient();
      const id = submitDR(client, "export").id;
      const outcomes = {
        decide_submitted: decideDR(world.dataStaff, id, "allowed"),
        scoped_assign: assignDR(world.dataStaffS, id),
        plain_assign: assignDR(world.plainStaff, id),
        aal1_assign: assignDR(world.dataStaff, id, AAL1),
        unknown_assign: assignDR(world.dataStaff, uid()),
        assign: assignDR(world.dataStaff, id),
      };
      const audits = auditsFor("data_request", id).length;
      outcomes.assign_again = assignDR(world.dataStaff, id);
      assert.equal(auditsFor("data_request", id).length, audits);
      outcomes.take_over = assignDR(world.dataStaff2, id);
      assert.equal(drRow(id).assigned_to_user_id, world.dataStaff2.user);
      outcomes.bad_outcome = decideDR(world.dataStaff, id, "approved");
      outcomes.scoped_decide = decideDR(world.dataStaffS, id, "denied");
      const digest = businessDigest();
      outcomes.decide = decideDR(world.dataStaff, id, "allowed");
      const changed = changedTables(digest, businessDigest());
      outcomes.decide_again = decideDR(world.dataStaff2, id, "denied");
      outcomes.assign_decided = assignDR(world.dataStaff, id);
      assert.deepEqual(outcomes, {
        decide_submitted: "invalid_transition",
        scoped_assign: "denied",
        plain_assign: "denied",
        aal1_assign: "denied",
        unknown_assign: "not_found",
        assign: "applied",
        assign_again: "applied",
        take_over: "applied",
        bad_outcome: "invalid",
        scoped_decide: "denied",
        decide: "applied",
        decide_again: "invalid_transition",
        assign_decided: "invalid_transition",
      });
      assert.deepEqual(changed.sort(), ["audit_events", "data_requests"]);
      const row = drRow(id);
      assert.deepEqual(
        [row.state, row.outcome_code, row.decided_by_user_id, row.decided_at !== null],
        ["decided", "allowed", world.dataStaff.user, true],
      );
      assert.equal(sql(`select account_state from public.users where id = '${client.user}';`), "active");
      assert.deepEqual(
        auditsFor("data_request", id).map((a) => [a.action, a.actor_user_id, a.after]),
        [
          ["data_request.submitted", client.user, { request_type: "export", state: "submitted" }],
          ["data_request.assigned", world.dataStaff.user, { request_type: "export", state: "in_review", assigned: true }],
          ["data_request.assigned", world.dataStaff2.user, { request_type: "export", state: "in_review", assigned: true }],
          ["data_request.decided", world.dataStaff.user, { request_type: "export", state: "decided", outcome_code: "allowed" }],
        ],
      );
      return outcomes;
    },
  );

  await check(
    "DR-5 (PS-A6 section 3 rule 5; PM row 48) with an unreleased Legal Hold on the requester's User, Intake, Consultation, owned resource or Complaint Case (the five S11 scope types: user, intake, consultation, resource, complaint_case), recording a deletion request as allowed answers legal_hold and nothing changes; another outcome is recorded; another type may be allowed under the hold; once the hold is released the deletion can be allowed; the guard refuses the same update by the database owner",
    () => {
      const results = {};
      for (const scope of ["user", "intake", "consultation", "resource", "complaint_case"]) {
        const s = readyConsultation("S");
        const doc = uploadDocument(s.client, s.consultation, AAL1);
        const kase = openComplaint(s.client, { consultation: s.consultation }, AAL1).id;
        const scopeId = {
          user: s.client.user,
          intake: s.client.intake,
          consultation: s.consultation,
          resource: doc,
          complaint_case: kase,
        }[scope];
        const { outcome, hold } = placeHold(world.holds, scope, scopeId);
        assert.equal(outcome, "placed", scope);
        const deletion = inReview(s.client, "deletion");
        const access = inReview(s.client, "access");
        assert.equal(oneDR(world.dataStaff, deletion)[0].legal_hold_applies, true, scope);
        const before = JSON.stringify(drRow(deletion));
        const refusedDecision = decideDR(world.dataStaff, deletion, "allowed");
        assert.equal(JSON.stringify(drRow(deletion)), before);
        const owner = refused(
          `update public.data_requests set state = 'decided', decided_by_user_id = '${world.dataStaff.user}', decided_at = now(), outcome_code = 'allowed' where id = '${deletion}';`,
        );
        const accessAllowed = decideDR(world.dataStaff, access, "allowed");
        assert.equal(releaseHold(world.holds, hold), "released");
        assert.equal(oneDR(world.dataStaff, deletion)[0].legal_hold_applies, false, scope);
        const afterRelease = decideDR(world.dataStaff, deletion, "allowed");
        results[scope] = { refusedDecision, owner, accessAllowed, afterRelease };
      }
      // Another outcome is recorded under a hold.
      const s = newClient();
      const { hold } = placeHold(world.holds, "user", s.user);
      const denied = inReview(s, "deletion");
      results.denied_under_hold = decideDR(world.dataStaff, denied, "denied");
      releaseHold(world.holds, hold);
      // An attorney's Consultation counts for a requester who is the
      // attorney (a dual-role account holding a Client Profile).
      const d = readyConsultation("S");
      sql(
        `insert into public.client_profiles (id, user_id) values ('${uid()}', '${d.lawyer.user}');`,
      );
      const h2 = placeHold(world.holds, "consultation", d.consultation).hold;
      const attorneyDeletion = inReview(d.lawyer, "deletion");
      results.attorney_consultation = decideDR(world.dataStaff, attorneyDeletion, "allowed");
      releaseHold(world.holds, h2);
      const expected = {
        refusedDecision: "legal_hold",
        owner: "55000",
        accessAllowed: "applied",
        afterRelease: "applied",
      };
      assert.deepEqual(results, {
        user: expected,
        intake: expected,
        consultation: expected,
        resource: expected,
        complaint_case: expected,
        denied_under_hold: "applied",
        attorney_consultation: "legal_hold",
      });
      return results;
    },
  );

  await check(
    "DR-6 (PS-A6 section 3 rules 1 to 3, 6 and 7) the guard and constraints hold for every role, the database owner included: a request is never deleted or truncated; it is recorded submitted with one of the five types; the state is one of four and moves only submitted -> in_review | withdrawn and in_review -> decided | withdrawn, decided and withdrawn being final; the decision triple is set together exactly when decided, with one of the four outcomes; details are not blank and hold at most 20,000 characters; the requester, type, details, submission, identifier and creation never change; one open request per requester and type; updated_at follows each change",
    () => {
      const client = newClient();
      const id = submitDR(client, "access", "Synthetic owner probe").id;
      const ins = (extra = {}) => {
        const row = {
          requester_user_id: `'${client.user}'`,
          request_type: "'export'",
          state: "'submitted'",
          submitted_at: "now()",
          ...extra,
        };
        return `insert into public.data_requests (${Object.keys(row).join(", ")}) values (${Object.values(row).join(", ")});`;
      };
      const upd = (set, target = id) =>
        `update public.data_requests set ${set} where id = '${target}';`;
      const decided = inReview(client, "restriction");
      decideDR(world.dataStaff, decided, "restricted");
      const withdrawn = submitDR(client, "correction").id;
      withdrawDR(client, withdrawn);
      const reviewing = inReview(client, "deletion");
      const outcomes = {
        delete: refused(`delete from public.data_requests where id = '${id}';`),
        truncate: refused("truncate public.data_requests;"),
        insert_in_review: refused(ins({ state: "'in_review'" })),
        bad_type: refused(ins({ request_type: "'erasure'" })),
        // The state check itself, with the guard bypassed.
        bad_state: refused(
          `set local session_replication_role = replica; ${ins({ state: "'pending'" })}`,
        ),
        blank_details: refused(ins({ details: "'   '" })),
        long_details: refused(ins({ details: `'${"x".repeat(20001)}'` })),
        second_open: refused(ins({ request_type: "'access'" })),
        submitted_to_decided: refused(upd(`state = 'decided', decided_by_user_id = '${world.dataStaff.user}', decided_at = now(), outcome_code = 'denied'`)),
        partial_decision: refused(upd(`decided_at = now()`)),
        bad_outcome: refused(upd(`state = 'decided', decided_by_user_id = '${world.dataStaff.user}', decided_at = now(), outcome_code = 'approved'`, reviewing)),
        decided_change: refused(upd("outcome_code = 'denied'", decided)),
        decided_reopen: refused(upd("state = 'in_review', decided_by_user_id = null, decided_at = null, outcome_code = null", decided)),
        withdrawn_reopen: refused(upd("state = 'in_review'", withdrawn)),
        details_change: refused(upd("details = 'Changed'")),
        type_change: refused(upd("request_type = 'export'")),
        requester_change: refused(upd(`requester_user_id = '${world.dataStaff.user}'`)),
        submitted_change: refused(upd("submitted_at = submitted_at - interval '1 second'")),
        created_change: refused(upd("created_at = created_at - interval '1 second'")),
      };
      assert.deepEqual(outcomes, {
        delete: "55000",
        truncate: "55000",
        insert_in_review: "23514",
        bad_type: "23514",
        bad_state: "23514",
        blank_details: "23514",
        long_details: "23514",
        second_open: "23505",
        submitted_to_decided: "55000",
        partial_decision: "23514",
        bad_outcome: "23514",
        decided_change: "55000",
        decided_reopen: "55000",
        withdrawn_reopen: "55000",
        details_change: "55000",
        type_change: "55000",
        requester_change: "55000",
        submitted_change: "55000",
        created_change: "55000",
      });
      acceptedThenRolledBack(ins({ details: `'${"x".repeat(20000)}'` }));
      const before = drRow(id).updated_at;
      sql(upd(`state = 'in_review', assigned_to_user_id = '${world.dataStaff.user}'`));
      assert.ok(ms(drRow(id).updated_at) > ms(before));
      return outcomes;
    },
  );
}

// ---------------------------------------------------------------------------
// CV: complaint vocabularies as configuration and the case statement (PS-A6 sections
// 4 and 5)
// ---------------------------------------------------------------------------

// The staff policy commands (manage_policy_configuration, aal2) as the
// policy surfaces call them.
function staffCreateVersion(jurisdiction, label, parameters, effectiveFrom = "now() - interval '1 minute'") {
  const line = asStaff(
    world.policyAdmin,
    `select outcome || '|' || coalesce(policy_version_id::text, '') from public.staff_create_policy_version('complaint', ${jurisdiction === null ? "null::uuid" : lit(jurisdiction)}, null::uuid, ${lit(label)}, ${lit(parameters)}::jsonb, ${effectiveFrom}, null::timestamptz, null::uuid, false);`,
  );
  const [outcome, id] = line.split("|");
  return { outcome, id: id || null };
}
const versionUpdatedAt = (id) =>
  sql(`select updated_at from public.policy_versions where id = '${id}';`);
const transition = (id, target) =>
  asStaff(
    world.policyAdmin,
    `select public.staff_transition_policy_version('${id}', '${versionUpdatedAt(id)}'::timestamptz, '${target}');`,
  );
function verifiedReference(id) {
  const [outcome, reference] = asStaff(
    world.policyAdmin,
    `select outcome || '|' || coalesce(reference_id::text, '') from public.staff_add_policy_authority_reference('${id}', 'synthetic', 'Synthetic citation', null, 'Synthetic source', now());`,
  ).split("|");
  assert.equal(outcome, "created");
  assert.equal(
    asStaff(
      world.policyAdmin,
      `select public.staff_decide_policy_authority_reference('${reference}', 'verified');`,
    ),
    "applied",
  );
}
// Walks a staff-created complaint version to approval and, when asked, to
// active, answering each step's outcome.
function walk(id, activate = true) {
  verifiedReference(id);
  const steps = [
    transition(id, "internal_review"),
    transition(id, "counsel_review"),
    transition(id, "approved"),
  ];
  if (activate && steps[2] === "applied") {
    steps.push(transition(id, "active"));
  }
  return steps;
}

async function complaintChecks() {
  await check(
    "CV-1 (PS-A6 section 4; PS section 8.4) approval validation: complaint parameters hold only category_codes and resolution_codes, each an array of one or more unique lower-snake codes of 2 to 64 characters; every malformed form is refused before approval; every other policy type keeps its earlier branch",
    () => {
      const ok = (p) =>
        sql(
          `select public.policy_parameters_approvable('complaint', null, ${lit(p)}::jsonb)::text || public.policy_parameters_approvable('complaint', '${world.J.S}', ${lit(p)}::jsonb)::text;`,
        );
      const cases = {
        valid: ok(COMPLAINT_CODES),
        one_each: ok({ category_codes: ["ab"], resolution_codes: ["cd"] }),
        empty_category: ok({ category_codes: [], resolution_codes: ["cd"] }),
        empty_resolution: ok({ category_codes: ["ab"], resolution_codes: [] }),
        missing_category: ok({ resolution_codes: ["cd"] }),
        missing_resolution: ok({ category_codes: ["ab"] }),
        duplicate: ok({ category_codes: ["ab", "ab"], resolution_codes: ["cd"] }),
        upper: ok({ category_codes: ["Ab"], resolution_codes: ["cd"] }),
        short: ok({ category_codes: ["a"], resolution_codes: ["cd"] }),
        long: ok({ category_codes: ["a".repeat(65)], resolution_codes: ["cd"] }),
        longest: ok({ category_codes: ["a".repeat(64)], resolution_codes: ["cd"] }),
        number: ok({ category_codes: [1], resolution_codes: ["cd"] }),
        not_list: ok({ category_codes: "ab", resolution_codes: ["cd"] }),
        extra_key: ok({ ...COMPLAINT_CODES, default_code: "ab" }),
        empty: ok({}),
      };
      assert.deepEqual(cases, {
        valid: "truetrue",
        one_each: "truetrue",
        empty_category: "falsefalse",
        empty_resolution: "falsefalse",
        missing_category: "falsefalse",
        missing_resolution: "falsefalse",
        duplicate: "falsefalse",
        upper: "falsefalse",
        short: "falsefalse",
        long: "falsefalse",
        longest: "truetrue",
        number: "falsefalse",
        not_list: "falsefalse",
        extra_key: "falsefalse",
        empty: "falsefalse",
      });
      const others = sql(
        `select concat_ws(',', public.policy_parameters_approvable('retention', null, '{}'::jsonb), public.policy_parameters_approvable('bookability', null, '{}'::jsonb), public.policy_parameters_approvable('bookability', null, '{"presence_window_seconds": 600}'::jsonb), public.policy_parameters_approvable('referral', '${world.J.S}', '{"outcome_codes": ["synthetic_closed"]}'::jsonb), public.policy_parameters_approvable('fee', null, '{}'::jsonb));`,
      );
      assert.equal(others, "t,f,t,t,f");
      return cases;
    },
  );

  await check(
    "CV-2 (PS-A6 section 4; the staff policy surfaces) staff holding manage_policy_configuration create a complaint version, verify its authority reference and walk it through review: a version with malformed parameters is refused at approval (parameters_invalid) and changes nothing; a valid one is approved and activated; complaint is not Regulatory-Mode-scoped (the version has none); the active platform version is then the one the resolver selects for a case without a jurisdiction, and closing it leaves no vocabulary",
    () => {
      const bad = staffCreateVersion(null, "synthetic-complaint-bad", {
        category_codes: ["synthetic_billing", "synthetic_billing"],
        resolution_codes: ["synthetic_upheld"],
      });
      assert.equal(bad.outcome, "created");
      const badSteps = walk(bad.id);
      const good = staffCreateVersion(null, "synthetic-complaint-good", COMPLAINT_CODES);
      assert.equal(good.outcome, "created");
      const goodSteps = walk(good.id);
      assert.deepEqual(badSteps, ["applied", "applied", "parameters_invalid"]);
      assert.equal(
        sql(`select status from public.policy_versions where id = '${bad.id}';`),
        "counsel_review",
      );
      assert.deepEqual(goodSteps, ["applied", "applied", "applied", "applied"]);
      assert.equal(
        sql(`select concat_ws('|', status, regulatory_mode_id is null, development_only) from public.policy_versions where id = '${good.id}';`),
        "active|t|f",
      );
      assert.equal(
        vocabularyOf(null),
        `selected|${good.id}|synthetic_billing,synthetic_conduct|synthetic_upheld,synthetic_not_upheld`,
      );
      // A jurisdiction's case never falls back to the platform version.
      assert.equal(vocabularyOf(world.J.T), "configuration_unavailable|||");
      assert.equal(transition(good.id, "retired"), "applied");
      assert.equal(vocabularyOf(null), "configuration_unavailable|||");
      return { badSteps, goodSteps };
    },
  );

  await check(
    "CV-3 (PS-A6 section 4; PS-A2 section 5) the vocabulary of a case is the version the environment-anchored resolver selects for the case's jurisdiction, or at platform scope when it names none: a jurisdiction version for that jurisdiction only; a platform version for unlinked cases only; two selectable versions (a conflict), none, or parameters that do not validate answer configuration_unavailable; a development version is selected in a development database and never in a production-class one; nothing is seeded",
    () => {
      assert.equal(vocabularyOf(null), "configuration_unavailable|||");
      assert.equal(vocabularyOf(world.J.S), "configuration_unavailable|||");
      const jurisdictionVersion = complaintVersion(world.J.S, COMPLAINT_CODES);
      const results = {
        jurisdiction: vocabularyOf(world.J.S),
        other_jurisdiction: vocabularyOf(world.J.T),
        platform_without: vocabularyOf(null),
      };
      const platformVersion = complaintVersion(null, {
        category_codes: ["synthetic_platform_category"],
        resolution_codes: ["synthetic_platform_resolution"],
      });
      results.platform = vocabularyOf(null);
      results.jurisdiction_still = vocabularyOf(world.J.S);
      const conflict = complaintVersion(world.J.S, COMPLAINT_CODES);
      results.conflict = vocabularyOf(world.J.S);
      closeVersion(conflict);
      const malformed = complaintVersion(world.J.T, { category_codes: [], resolution_codes: ["synthetic_upheld"] });
      results.malformed = vocabularyOf(world.J.T);
      closeVersion(malformed);
      // A development version planted in the production-class database (the
      // owner with triggers bypassed; the resolver, not the fixture, is
      // examined) is never selected there.
      const prodJurisdiction = newJurisdiction("SYN_PSA6_PROD", PROD_DB);
      sql(
        `begin;
         set local session_replication_role = replica;
         insert into public.policy_versions (policy_type_code, jurisdiction_id, version_label, parameters, status, effective_from, development_only)
           values ('complaint', '${prodJurisdiction}', 'synthetic-planted-complaint', ${lit(COMPLAINT_CODES)}::jsonb, 'draft', now() - interval '1 day', true),
                  ('complaint', null, 'synthetic-planted-platform-complaint', ${lit(COMPLAINT_CODES)}::jsonb, 'draft', now() - interval '1 day', true);
         commit;`,
        PROD_DB,
      );
      results.production_jurisdiction = vocabularyOf(prodJurisdiction, PROD_DB);
      results.production_platform = vocabularyOf(null, PROD_DB);
      assert.deepEqual(results, {
        jurisdiction: `selected|${jurisdictionVersion}|synthetic_billing,synthetic_conduct|synthetic_upheld,synthetic_not_upheld`,
        other_jurisdiction: "configuration_unavailable|||",
        platform_without: "configuration_unavailable|||",
        platform: `selected|${platformVersion}|synthetic_platform_category|synthetic_platform_resolution`,
        jurisdiction_still: `selected|${jurisdictionVersion}|synthetic_billing,synthetic_conduct|synthetic_upheld,synthetic_not_upheld`,
        conflict: "configuration_unavailable|||",
        malformed: "configuration_unavailable|||",
        production_jurisdiction: "configuration_unavailable|||",
        production_platform: "configuration_unavailable|||",
      });
      world.complaintVersions = { jurisdictionVersion, platformVersion };
      return results;
    },
  );

  await check(
    "CV-4 (PS-A6 section 4) classification and resolution record exactly the configured codes of the case's vocabulary: an unlisted code answers invalid_code and changes nothing; a listed code is recorded and audited with the selected version's id; staff in scope see the configured codes on the case (a case without a jurisdiction sees the platform codes); without a selectable vocabulary both answer configuration_unavailable and change nothing",
    () => {
      const { jurisdictionVersion, platformVersion } = world.complaintVersions;
      const s = readyConsultation("S");
      const linked = openComplaint(s.client, { consultation: s.consultation }, AAL1).id;
      const unlinked = openComplaint(newClient(), {}, AAL1).id;
      const tCase = readyConsultation("T");
      const tLinked = openComplaint(tCase.client, { consultation: tCase.consultation }, AAL1).id;
      const seen = complaintCaseAs(world.complaintsS, linked)[0];
      assert.deepEqual(
        [seen.category_codes, seen.resolution_codes],
        [COMPLAINT_CODES.category_codes, COMPLAINT_CODES.resolution_codes],
      );
      assert.deepEqual(
        complaintCaseAs(world.complaints, unlinked)[0].category_codes,
        ["synthetic_platform_category"],
      );
      assert.deepEqual(
        [complaintCaseAs(world.complaintsT, tLinked)[0].category_codes, complaintCaseAs(world.complaintsT, tLinked)[0].resolution_codes],
        [[], []],
      );
      const t0 = JSON.stringify(complaintRow(tLinked));
      const outcomes = {
        t_classify: classifyComplaint(world.complaintsT, tLinked, "synthetic_billing"),
        unlisted: classifyComplaint(world.complaintsS, linked, "synthetic_platform_category"),
        classify: classifyComplaint(world.complaintsS, linked, "synthetic_conduct"),
        resolve_opened: resolveComplaint(world.complaintsS, linked, "synthetic_upheld"),
        assign: updateComplaint(world.complaintsS, linked, "assign"),
        resolve_unlisted: resolveComplaint(world.complaintsS, linked, "synthetic_conduct"),
        resolve: resolveComplaint(world.complaintsS, linked, "synthetic_not_upheld"),
        platform_classify: classifyComplaint(world.complaints, unlinked, "synthetic_platform_category"),
      };
      assert.equal(JSON.stringify(complaintRow(tLinked)), t0);
      assert.deepEqual(outcomes, {
        t_classify: "configuration_unavailable",
        unlisted: "invalid_code",
        classify: "applied",
        resolve_opened: "invalid_transition",
        assign: "applied",
        resolve_unlisted: "invalid_code",
        resolve: "applied",
        platform_classify: "applied",
      });
      const row = complaintRow(linked);
      assert.deepEqual(
        [row.state, row.category_code, row.resolution_code, row.resolved_at !== null],
        ["resolved", "synthetic_conduct", "synthetic_not_upheld", true],
      );
      const audits = auditsFor("complaint_case", linked).filter((a) =>
        ["complaint_case.classified", "complaint_case.resolved"].includes(a.action),
      );
      assert.deepEqual(
        audits.map((a) => [a.action, a.after.vocabulary_policy_version_id]),
        [
          ["complaint_case.classified", jurisdictionVersion],
          ["complaint_case.resolved", jurisdictionVersion],
        ],
      );
      assert.equal(
        auditsFor("complaint_case", unlinked).find((a) => a.action === "complaint_case.classified").after.vocabulary_policy_version_id,
        platformVersion,
      );
      return outcomes;
    },
  );

  await check(
    "CV-5 (PS-A6 section 5) the statement is the complainant's own description, written when the case is opened: trimmed, an empty one is none, at most 20,000 characters (longer answers invalid and opens nothing); the two-argument call still opens a case without one; the guard refuses any change of it for every role, the owner included, and the constraint refuses a blank or overlong one; existing behaviour (one open case per linkage) is unchanged",
    () => {
      const s = readyConsultation("S");
      const statement = "Synthetic statement: what the synthetic client reports.";
      const outcomes = {
        long: openComplaint(s.client, { consultation: s.consultation, statement: "x".repeat(20001) }, AAL1).outcome,
      };
      const opened = openComplaint(s.client, { consultation: s.consultation, statement: `  ${statement}  ` }, AAL1);
      outcomes.opened = opened.outcome;
      outcomes.again = openComplaint(s.client, { consultation: s.consultation, statement: "Another" }, AAL1).outcome;
      assert.equal(complaintRow(opened.id).statement, statement);
      const blank = openComplaint(newClient(), { statement: "   " }, AAL1);
      outcomes.blank = blank.outcome;
      assert.equal(complaintRow(blank.id).statement, null);
      const two = openComplaint(newClient(), {}, AAL1);
      outcomes.two_arguments = two.outcome;
      assert.equal(complaintRow(two.id).statement, null);
      const max = openComplaint(newClient(), { statement: "y".repeat(20000) }, AAL1);
      outcomes.max = max.outcome;
      outcomes.change = refused(`update public.complaint_cases set statement = 'Changed' where id = '${opened.id}';`);
      outcomes.clear = refused(`update public.complaint_cases set statement = null where id = '${opened.id}';`);
      outcomes.set_later = refused(`update public.complaint_cases set statement = 'Later' where id = '${two.id}';`);
      const insert = (value) =>
        `insert into public.complaint_cases (complainant_user_id, state, opened_at, statement) values ('${newClient().user}', 'opened', now(), ${value});`;
      outcomes.insert_blank = refused(insert("'   '"));
      outcomes.insert_long = refused(insert(`'${"z".repeat(20001)}'`));
      acceptedThenRolledBack(insert("'Synthetic owner statement'"));
      assert.deepEqual(outcomes, {
        long: "invalid",
        opened: "opened",
        again: "already_open",
        blank: "opened",
        two_arguments: "opened",
        max: "opened",
        change: "55000",
        clear: "55000",
        set_later: "55000",
        insert_blank: "23514",
        insert_long: "23514",
      });
      world.statementCase = { s, id: opened.id, statement };
      return outcomes;
    },
  );

  await check(
    "CV-6 (PS-A6 section 5: restricted exactly as the case is) the statement is answered to the complainant by their own list and to holders of manage_complaints in scope by the one-case read; never to the other participant, to another jurisdiction's holder or a staff member without the capability, never in the staff queue, and never in an audit event, a Notification or a delivery job",
    () => {
      const { s, id, statement } = world.statementCase;
      const own = myComplaints(s.client, AAL1).find((r) => r.complaint_case_id === id);
      assert.equal(own.statement, statement);
      const shown = {
        complainant: own.statement,
        holder_scoped: complaintCaseAs(world.complaintsS, id)[0].statement,
        holder_global: complaintCaseAs(world.complaints, id)[0].statement,
        counterparty_list: myComplaints(s.lawyer).filter((r) => r.complaint_case_id === id).length,
        other_jurisdiction: complaintCaseAs(world.complaintsT, id).length,
        plain_staff: complaintCaseAs(world.plainStaff, id).length,
        holder_aal1: complaintCaseAs(world.complaints, id, AAL1).length,
        counterparty_case: complaintCaseAs(s.lawyer, id).length,
      };
      assert.deepEqual(shown, {
        complainant: statement,
        holder_scoped: statement,
        holder_global: statement,
        counterparty_list: 0,
        other_jurisdiction: 0,
        plain_staff: 0,
        holder_aal1: 0,
        counterparty_case: 0,
      });
      const queued = complaintQueueAs(world.complaints, "opened");
      assert.ok(queued.some((r) => r.complaint_case_id === id));
      assert.ok(queued.every((r) => !("statement" in r)));
      const marker = "Synthetic statement:";
      assert.equal(
        sql(
          `select concat_ws(',', (select count(*) from public.audit_events a where a::text like '%${marker}%'), (select count(*) from public.notifications n where n::text like '%${marker}%'), (select count(*) from public.operational_jobs j where j::text like '%${marker}%'));`,
        ),
        "0,0,0",
      );
      return shown;
    },
  );
}

// ---------------------------------------------------------------------------
// CC: real concurrency (persistent sessions)
// ---------------------------------------------------------------------------

// A session holding an open transaction as one request (role, subject and
// claims as PostgREST sets them).
async function requestSession(label, account, aal = "aal2") {
  const s = await session(label);
  await s.ok("begin;");
  await s.ok("set local role authenticated;");
  await s.ok(
    `select set_config('request.jwt.claim.sub', ${lit(account.auth)}, true) is not null;`,
  );
  await s.ok(
    `select set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: account.auth, role: "authenticated", aal }))}, true) is not null;`,
  );
  return s;
}
const answerOf = (result) => {
  const rows = result.rows.filter((row) => row !== "t");
  return rows[rows.length - 1];
};
const errorOf = (stderr) => /ERROR:\s+([0-9A-Z]{5})/.exec(stderr ?? "")?.[1] ?? null;

// Runs a first statement in session a (left open), a second in session b
// that must wait for a, then commits a and b: the two answers.
async function race(a, first, b, second) {
  const one = answerOf({ rows: await a.ok(first) });
  const pending = b.send(second);
  await blockedBy(b.pid, a.pid);
  await a.ok("commit;");
  const result = await pending;
  assert.equal(result.sqlstate, "00000", result.stderr);
  await b.ok("commit;");
  a.close();
  b.close();
  return [one, answerOf(result)];
}

const APPROVE_SQL = (g, seconds = 3600) =>
  `select public.staff_approve_break_glass('${g}', ${seconds});`;
const REVOKE_SQL = (g) => `select public.staff_revoke_break_glass('${g}');`;
const ACCESS_SQL_BG = (g) =>
  `select count(*) from public.staff_break_glass_consultation('${g}');`;
const DECIDE_SQL = (id, outcome) =>
  `select public.staff_decide_data_request('${id}', '${outcome}');`;
const WITHDRAW_SQL_DR = (id) =>
  `select public.client_withdraw_data_request('${id}');`;
const SUBMIT_SQL_DR = (type) =>
  `select outcome from public.client_submit_data_request('${type}', null);`;
const REQUEST_SQL_BG = (c) =>
  `select outcome || '|' || break_glass_grant_id from public.staff_request_break_glass('${c}', 'Synthetic concurrent reason');`;
const PLACE_SQL = (type, id) =>
  `select outcome from public.staff_place_legal_hold('${type}', '${id}', 'Synthetic concurrent hold');`;

async function concurrencyChecks() {
  const c = world.bg.c;

  await check(
    "CC-1 two approvals of one request by two holders: the first approves, the second waits on the grant's row lock and then answers already_active; exactly one approval is recorded",
    async () => {
      const g = requestBG(staffWith(), c.consultation).grant;
      const outcome = await race(
        await requestSession("approve-1", world.approver),
        APPROVE_SQL(g),
        await requestSession("approve-2", world.approver2),
        APPROVE_SQL(g, 60),
      );
      assert.deepEqual(outcome, ["approved", "already_active"]);
      assert.equal(ms(grantRow(g).expires_at) - ms(grantRow(g).approved_at), 3600000);
      assert.equal(
        auditsFor("break_glass_grant", g).filter((a) => a.action === "break_glass_grant.approved").length,
        1,
      );
      report.concurrency.two_approvals = outcome;
      return outcome;
    },
  );

  await check(
    "CC-2 approval racing revocation, both orders: an approval holding the lock is followed by a revocation that ends the access; a refusal holding the lock is followed by an approval that answers already_revoked",
    async () => {
      const g1 = requestBG(staffWith(), c.consultation).grant;
      const first = await race(
        await requestSession("approve", world.approver),
        APPROVE_SQL(g1),
        await requestSession("revoke", world.approver2),
        REVOKE_SQL(g1),
      );
      const g2 = requestBG(staffWith(), c.consultation).grant;
      const second = await race(
        await requestSession("revoke", world.approver2),
        REVOKE_SQL(g2),
        await requestSession("approve", world.approver),
        APPROVE_SQL(g2),
      );
      assert.deepEqual(first, ["approved", "ended"]);
      assert.deepEqual(second, ["refused", "already_revoked"]);
      assert.equal(grantRow(g2).approved_at, null);
      report.concurrency.approval_racing_revocation = { first, second };
      return { first, second };
    },
  );

  await check(
    "CC-3 access racing revocation, both orders: an access holding the grant FOR SHARE answers the view and the revocation waits, then ends the access, after which an access answers nothing; a revocation holding the lock makes a waiting access answer nothing once it commits; each answered access is audited once and a refused one not at all",
    async () => {
      const a1 = activeGrant(c.consultation);
      const first = await race(
        await requestSession("access", a1.requester),
        ACCESS_SQL_BG(a1.grant),
        await requestSession("revoke", world.approver),
        REVOKE_SQL(a1.grant),
      );
      const after = accessBG(a1.requester, a1.grant).length;
      const a2 = activeGrant(c.consultation);
      const second = await race(
        await requestSession("revoke", world.approver),
        REVOKE_SQL(a2.grant),
        await requestSession("access", a2.requester),
        ACCESS_SQL_BG(a2.grant),
      );
      assert.deepEqual(first, ["1", "ended"]);
      assert.equal(after, 0);
      assert.deepEqual(second, ["ended", "0"]);
      assert.equal(accessAudits(a1.grant), 1);
      assert.equal(accessAudits(a2.grant), 0);
      report.concurrency.access_racing_revocation = { first, second, after };
      return { first, second };
    },
  );

  await check(
    "CC-4 two decisions of one request by two holders: the first decides, the second waits and answers invalid_transition; withdrawal racing decision, both orders: a withdrawal holding the lock leaves the decision invalid_transition, and a decision holding the lock leaves the withdrawal already_decided",
    async () => {
      const client = newClient();
      const id = inReview(client, "access");
      const decisions = await race(
        await requestSession("decide-1", world.dataStaff),
        DECIDE_SQL(id, "allowed"),
        await requestSession("decide-2", world.dataStaff2),
        DECIDE_SQL(id, "denied"),
      );
      const w1 = inReview(client, "export");
      const withdrawFirst = await race(
        await requestSession("withdraw", client, "aal1"),
        WITHDRAW_SQL_DR(w1),
        await requestSession("decide", world.dataStaff),
        DECIDE_SQL(w1, "allowed"),
      );
      const w2 = inReview(client, "correction");
      const decideFirst = await race(
        await requestSession("decide", world.dataStaff),
        DECIDE_SQL(w2, "deferred"),
        await requestSession("withdraw", client, "aal1"),
        WITHDRAW_SQL_DR(w2),
      );
      assert.deepEqual(decisions, ["applied", "invalid_transition"]);
      assert.equal(drRow(id).outcome_code, "allowed");
      assert.deepEqual(withdrawFirst, ["withdrawn", "invalid_transition"]);
      assert.deepEqual(decideFirst, ["applied", "already_decided"]);
      assert.equal(drRow(w2).state, "decided");
      report.concurrency.two_decisions = decisions;
      report.concurrency.withdrawal_racing_decision = { withdrawFirst, decideFirst };
      return { decisions, withdrawFirst, decideFirst };
    },
  );

  await check(
    "CC-5 double submissions: two submissions of one type by one client serialize on the client's own row and the second answers already_open (one request recorded); two break-glass requests of one staff member for one Consultation serialize on the Staff Profile and the second answers existing with the first grant's id",
    async () => {
      const client = newClient();
      const submissions = await race(
        await requestSession("submit-1", client, "aal1"),
        SUBMIT_SQL_DR("deletion"),
        await requestSession("submit-2", client, "aal1"),
        SUBMIT_SQL_DR("deletion"),
      );
      assert.deepEqual(submissions, ["submitted", "already_open"]);
      assert.equal(
        sql(`select count(*) from public.data_requests where requester_user_id = '${client.user}';`),
        "1",
      );
      const staff = staffWith();
      const requests = await race(
        await requestSession("request-1", staff),
        REQUEST_SQL_BG(c.consultation),
        await requestSession("request-2", staff),
        REQUEST_SQL_BG(c.consultation),
      );
      const [o1, g1] = requests[0].split("|");
      const [o2, g2] = requests[1].split("|");
      assert.deepEqual([o1, o2], ["requested", "existing"]);
      assert.equal(g1, g2);
      assert.equal(
        sql(`select count(*) from public.break_glass_grants where requested_by_user_id = '${staff.user}';`),
        "1",
      );
      report.concurrency.double_submission = submissions;
      report.concurrency.double_break_glass_request = [o1, o2];
      return { submissions, requests: [o1, o2] };
    },
  );

  await check(
    "CC-6 a Legal Hold racing a deletion decision (PS-A6 section 3 rule 5), both orders: a hold placed in an open transaction makes the decision wait on its SHARE lock of legal_holds and then answer legal_hold; a decision holding that lock makes the hold wait, and the hold is placed after the decision",
    async () => {
      const client = newClient();
      const id = inReview(client, "deletion");
      const holdFirst = await race(
        await requestSession("hold", world.holds),
        PLACE_SQL("user", client.user),
        await requestSession("decide", world.dataStaff),
        DECIDE_SQL(id, "allowed"),
      );
      assert.equal(drRow(id).state, "in_review");
      const other = newClient();
      const id2 = inReview(other, "deletion");
      const decideFirst = await race(
        await requestSession("decide", world.dataStaff),
        DECIDE_SQL(id2, "allowed"),
        await requestSession("hold", world.holds),
        PLACE_SQL("user", other.user),
      );
      assert.deepEqual(holdFirst, ["placed", "legal_hold"]);
      assert.deepEqual(decideFirst, ["applied", "placed"]);
      assert.equal(drRow(id2).outcome_code, "allowed");
      report.concurrency.hold_racing_deletion = { holdFirst, decideFirst };
      return { holdFirst, decideFirst };
    },
  );

  await check(
    "CC-7 mixed load: twelve persistent sessions run break-glass requests, approvals, accesses and revocations and data request submissions, assignments, decisions and withdrawals at once, in their own transactions, three rounds; every statement answers a fixed outcome, with zero deadlocks, zero lock timeouts and zero errors",
    async () => {
      const clients = Array.from({ length: 4 }, () => newClient());
      const requesters = Array.from({ length: 4 }, () => staffWith());
      const sessions = [];
      const errors = [];
      const outcomes = {};
      for (let i = 0; i < 12; i += 1) {
        sessions.push(await session(`mixed-${i}`));
      }
      const tx = async (s, account, aal, statement) => {
        const result = await s.send(
          [
            "begin;",
            "set local role authenticated;",
            `select set_config('request.jwt.claim.sub', ${lit(account.auth)}, true) is not null;`,
            `select set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: account.auth, role: "authenticated", aal }))}, true) is not null;`,
            statement,
            "commit;",
          ].join("\n"),
        );
        const error = errorOf(result.stderr);
        if (error !== null) {
          errors.push(error);
        }
        const answer = answerOf(result);
        outcomes[answer] = (outcomes[answer] ?? 0) + 1;
        return answer;
      };
      for (let round = 0; round < 3; round += 1) {
        const grants = requesters.map(
          (r) => requestBG(r, c.consultation).grant,
        );
        const requests = clients.map((client) => submitDR(client, "access").id);
        await Promise.all([
          ...grants.map((g, i) =>
            tx(sessions[i], i % 2 === 0 ? world.approver : world.approver2, "aal2", APPROVE_SQL(g)),
          ),
          ...grants.map((g, i) =>
            tx(sessions[4 + i], requesters[i], "aal2", ACCESS_SQL_BG(g)),
          ),
          ...requests.map((id, i) =>
            tx(sessions[8 + i], i % 2 === 0 ? world.dataStaff : world.dataStaff2, "aal2", `select public.staff_assign_data_request('${id}');`),
          ),
        ]);
        await Promise.all([
          ...grants.map((g, i) =>
            tx(sessions[i], i % 2 === 0 ? world.approver2 : world.approver, "aal2", REVOKE_SQL(g)),
          ),
          ...grants.map((g, i) =>
            tx(sessions[4 + i], requesters[i], "aal2", ACCESS_SQL_BG(g)),
          ),
          ...requests.map((id, i) =>
            i % 2 === 0
              ? tx(sessions[8 + i], world.dataStaff, "aal2", DECIDE_SQL(id, "denied"))
              : tx(sessions[8 + i], clients[i], "aal1", WITHDRAW_SQL_DR(id)),
          ),
        ]);
      }
      for (const s of sessions) {
        s.close();
      }
      assert.deepEqual(errors, []);
      const deadlocks = Number(
        sql("select deadlocks from pg_stat_database where datname = current_database();"),
      );
      assert.equal(deadlocks, 0);
      for (const answer of Object.keys(outcomes)) {
        assert.ok(
          [
            "approved",
            "already_active",
            "already_revoked",
            "ended",
            "refused",
            "applied",
            "invalid_transition",
            "withdrawn",
            "already_decided",
            "0",
            "1",
          ].includes(answer),
          answer,
        );
      }
      report.concurrency.mixed_load = { outcomes, deadlocks, errors: errors.length };
      return { outcomes, deadlocks };
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
    await migrationChecks();
    seed();
    await breakGlassChecks();
    await dataRequestChecks();
    await complaintChecks();
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
