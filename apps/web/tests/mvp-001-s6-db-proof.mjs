// MVP-001 S6 disposable PostgreSQL proof (M8 Consultation Request / Pricing).
// Explicitly invoked only:
//
//   node apps/web/tests/mvp-001-s6-db-proof.mjs
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
// one transaction; the three S6 migrations must follow S5 and be registered.
// The database records its environment as development, and every policy
// version used here (eligibility, scheduling, bookability, referral and fee)
// is development configuration created by the owner role inside this
// disposable cluster (Packet rule 9): the values, the XTS test currency code
// and the synthetic_* modality codes are test values, never product values.
// Every attorney, client, Intake, licence, evidence item, price and outcome
// code is synthetic test data.
//
// TEST-ONLY PRICE SOURCE. The shipped price-source seam
// (pricing_attorney_offers and pricing_attorney_offer) answers no row until
// PS-A3 is adopted, and the first checks prove that every preview and Request
// creation then answers price_unavailable and writes nothing. To exercise the
// rest of the pipeline, this proof then replaces the two seam bodies, inside
// this disposable cluster only, with synthetic test bodies reading a
// proof-only table (proof_s6.offers, outside the public schema). Nothing of
// that is a migration, and nothing persists after the run.
//
// Request sessions are modelled as PostgREST sets them from a verified JWT:
// request.jwt.claim.sub and the JSON request.jwt.claims; anonymous requests
// run as anon without a subject.
//
// The probes cover the MVP-001 Packet S6 acceptance list for the database:
// migration order and registration; no relation, column, type, policy type,
// capability or seed added; privileges (anon executes nothing new; the client
// functions are authenticated-only security definer functions; the request
// and fee relations are function-only with service_role narrowed to SELECT;
// every internal function is executable by no API role; the P1 deferred
// Request/Hold and Request/payment checks are now security definer and still
// refuse violations); the shipped seam (MB section 152: a missing price makes
// the attorney not bookable, never a zero or fallback price); the Fee Policy
// validator and the quote engine (every refusal and the arithmetic); instant
// and scheduled Request creation with complete same-transaction evidence
// (fresh eligibility and Bookability distinct from the Referral's, the Fee
// Calculation with its snapshot and quote validity, the Hold, one audit
// event); every refusal leaving nothing; the MBS section 11 failure tests
// (quote expiry expires the Request and releases the Hold; an expired quote
// cannot be revived; a failed creation leaves no orphan Hold; a later price
// change does not alter the Fee Calculation); integrity for every role;
// withdrawal; expiry with and without the sweep; real concurrency with two
// persistent sessions (one Referral, one slot, withdrawal against expiry, the
// hold cap); authorization (another client's Referral and Request answer like
// unknown ones); and audit minimization. No Supabase project, network service,
// or pre-existing cluster is contacted, nothing persists after the run. The
// JSON report goes to stdout; exit 0 means PASS, 1 FAIL, 2 cleanup failure.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54341;
const DB = "rosuno_s6_proof";
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

const report = {
  proof: "MVP-001 S6 disposable local PostgreSQL proof",
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
    path.join(os.tmpdir(), "rosuno-mvp-001-s6-db-proof-"),
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
  // S6 follows S5, contiguous and in order, last, and every S6 migration is
  // registered unreviewed and applied nowhere.
  const s5 = files.indexOf(S5_LAST);
  assert.ok(s5 >= 0, "the last S5 migration is present");
  assert.deepEqual(files.slice(s5 + 1), [...S6_MIGRATIONS]);
  const workItems = JSON.parse(
    fs.readFileSync(
      path.join(REPOSITORY_ROOT, "governance/work-items/index.json"),
      "utf8",
    ),
  ).work_items;
  const program = workItems.find(
    (item) => item.work_item_id === "WI-P2-MVP-001-TECHNICAL-COMPLETION",
  );
  for (const file of S6_MIGRATIONS) {
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
    if (S6_MIGRATIONS.includes(file)) {
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
    const mark = `__S6_${this.label}_${this.n}__`;
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
    process.stderr.write(`[s6-proof] PASS ${name}\n`);
  } catch (error) {
    failed = true;
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
    process.stderr.write(`[s6-proof] FAIL ${name}\n${error?.stack ?? error}\n`);
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

// A synthetic Fee Policy (test values; XTS is the ISO 4217 testing code).
const FEE = (overrides = {}) => ({
  currency_code: "XTS",
  quote_validity_seconds: 900,
  permitted_durations_minutes: [30, 60],
  permitted_modalities: ["synthetic_video", "synthetic_audio"],
  listed_price_minimum_minor: 1000,
  listed_price_maximum_minor: 100000,
  rounding: "half_up",
  platform_fee: COMPONENT(1000),
  client_fee: COMPONENT(250, 50, 100, 2000),
  other_required_fee: COMPONENT(0),
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
} = {}) {
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

const CREATE = ({
  referral,
  path: requestPath,
  modality = "synthetic_video",
  duration = 30,
  slot = null,
}) =>
  `select outcome || '|' || coalesce(request_id::text, '') || '|' || coalesce(problem, '') from public.request_create(${lit(referral)}, ${lit(requestPath)}, ${lit(modality)}, ${duration === null ? "null" : duration}, ${ts(slot)});`;

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
}) {
  const end = slot === null ? null : plusMinutes(slot, 30);
  const holdEnd = holdSlot === null ? null : plusMinutes(holdSlot, 30);
  const lines = [
    `insert into public.consultation_requests (id, intake_id, client_id, selected_attorney_id, referral_id, request_path, referral_policy_version_id, requested_modality, state, response_deadline_at)
       values ('${request}', '${client.intake}', '${client.client}', '${lawyer.profile}', '${referral}', '${requestPath}', '${world.policies.referral[jurisdiction]}', ${lit(modality)}, '${requestState}', ${deadline});`,
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

// The test-only price source (see the header): the two seam bodies replaced,
// in this disposable cluster only, by synthetic bodies reading
// proof_s6.offers.
function installTestPriceSource() {
  sql(`
create schema proof_s6;
create table proof_s6.offers (
  attorney_id uuid not null,
  modality text,
  duration_minutes integer,
  listed_price_minor bigint,
  currency_code text,
  offer_reference jsonb
);
create or replace function public.pricing_attorney_offers(p_attorney uuid)
returns table (modality text, duration_minutes integer, listed_price_minor bigint, currency_code text, offer_reference jsonb)
language sql stable security invoker set search_path = pg_catalog, pg_temp
as $$
  select o.modality, o.duration_minutes, o.listed_price_minor, o.currency_code, o.offer_reference
  from proof_s6.offers as o where o.attorney_id = p_attorney
  order by o.modality, o.duration_minutes;
$$;
create or replace function public.pricing_attorney_offer(p_attorney uuid, p_modality text, p_duration_minutes integer)
returns table (modality text, duration_minutes integer, listed_price_minor bigint, currency_code text, offer_reference jsonb)
language sql stable security invoker set search_path = pg_catalog, pg_temp
as $$
  select o.modality, o.duration_minutes, o.listed_price_minor, o.currency_code, o.offer_reference
  from proof_s6.offers as o
  where o.attorney_id = p_attorney and o.modality = p_modality and o.duration_minutes = p_duration_minutes;
$$;
`);
}

function offer(lawyer, modality, duration, price, currency = "XTS", reference) {
  const ref = lit(
    JSON.stringify(
      reference === undefined
        ? { synthetic_offer: `${modality}-${duration}` }
        : reference,
    ),
  );
  sql(
    `insert into proof_s6.offers (attorney_id, modality, duration_minutes, listed_price_minor, currency_code, offer_reference) values ('${lawyer.profile}', ${lit(modality)}, ${duration}, ${price}, ${lit(currency)}, ${ref}::jsonb);`,
  );
}

function seed() {
  world.J = {
    A: newJurisdiction("SYN_S6_A"),
    Q: newJurisdiction("SYN_S6_Q"),
    D: newJurisdiction("SYN_S6_D"),
    H: newJurisdiction("SYN_S6_H"),
    C: newJurisdiction("SYN_S6_C"),
    F: newJurisdiction("SYN_S6_F"),
    G: newJurisdiction("SYN_S6_G"),
    R: newJurisdiction("SYN_S6_R"),
    W: newJurisdiction("SYN_S6_W"),
  };
  world.PA = { one: newPracticeArea("SYN_S6_ONE") };
  const J = world.J;
  world.policies = { eligibility: {}, scheduling: {}, referral: {}, fee: {} };
  for (const id of Object.values(J)) {
    world.policies.eligibility[id] = policy("eligibility", id, ELIGIBILITY);
  }
  // Scheduling (test values). Q: long holds, quotes expire in 60 s (fee).
  // D: three-second response deadlines. H: two-second Holds. C: a cap of one
  // Hold and a long pre-slot interval. W: no response window keys.
  const scheduling = {
    [J.A]: SCHEDULING(),
    [J.Q]: SCHEDULING({
      hold_pre_slot_interval_seconds: 0,
      minimum_notice_seconds: 0,
      instant_request_response_window_seconds: 3600,
    }),
    [J.D]: SCHEDULING({
      hold_pre_slot_interval_seconds: 0,
      minimum_notice_seconds: 0,
      instant_request_response_window_seconds: 3,
      scheduled_request_response_window_seconds: 3,
    }),
    [J.H]: SCHEDULING({
      hold_response_window_seconds: 2,
      hold_pre_slot_interval_seconds: 0,
      minimum_notice_seconds: 0,
      instant_request_response_window_seconds: 3600,
    }),
    [J.C]: SCHEDULING({
      hold_pre_slot_interval_seconds: 600,
      pending_hold_cap: 1,
      minimum_notice_seconds: 60,
    }),
    [J.F]: SCHEDULING(),
    [J.G]: SCHEDULING(),
    [J.R]: SCHEDULING(),
    [J.W]: (({
      instant_request_response_window_seconds: _i,
      scheduled_request_response_window_seconds: _s,
      ...rest
    }) => rest)(SCHEDULING()),
  };
  for (const [id, parameters] of Object.entries(scheduling)) {
    world.policies.scheduling[id] = policy("scheduling", id, parameters);
  }
  world.policies.bookability = policy("bookability", null, {
    presence_window_seconds: 600,
  });
  // Referral policies everywhere except R (synthetic outcome code only).
  for (const id of Object.values(J).filter((j) => j !== J.R)) {
    world.policies.referral[id] = policy("referral", id, {
      outcome_codes: ["synthetic_closed"],
    });
  }
  // Fee policies (test values): none in F; a malformed one in G.
  const fees = {
    [J.A]: FEE(),
    [J.Q]: FEE({ quote_validity_seconds: 60 }),
    [J.D]: FEE({ quote_validity_seconds: 600 }),
    [J.H]: FEE(),
    [J.C]: FEE(),
    [J.G]: FEE({ rounding: "nearest" }),
    [J.R]: FEE(),
    [J.W]: FEE(),
  };
  for (const [id, parameters] of Object.entries(fees)) {
    world.policies.fee[id] = policy("fee", id, parameters);
  }
  world.ada = attorney({
    name: "Ada Synthetic",
    jurisdictions: Object.values(J),
    areas: [world.PA.one],
  });
  instant(world.ada);
  world.bea = attorney({ name: "Bea Synthetic", jurisdictions: [J.A] });
  world.ben = attorney({ name: "Ben Synthetic", jurisdictions: [J.A] });
  world.una = attorney({
    name: "Una Synthetic",
    jurisdictions: [J.A],
    available: false,
  });
  world.cat = attorney({ name: "Cat Synthetic", jurisdictions: [J.A] });
  world.dot = attorney({
    name: "Dot Synthetic",
    jurisdictions: [J.A, J.C, J.D],
  });
  instant(world.dot);
  world.cy = attorney({ name: "Cy Synthetic", jurisdictions: [J.C] });
  world.stranger = newClient(["submitted"]);
}

function seedOffers() {
  for (const lawyer of [world.ada, world.dot]) {
    offer(lawyer, "synthetic_video", 30, 5000);
    offer(lawyer, "synthetic_video", 60, 9000);
    offer(lawyer, "synthetic_audio", 30, 4000);
    // Offered, but not permitted by the policy (duration, modality), and
    // offered in another currency.
    offer(lawyer, "synthetic_video", 90, 12000);
    offer(lawyer, "synthetic_text", 30, 3000);
    offer(lawyer, "synthetic_audio", 60, 7000, "XXX");
  }
  // Prices outside the policy bounds, and invalid prices.
  offer(world.bea, "synthetic_video", 30, 500);
  offer(world.bea, "synthetic_video", 60, 200000);
  offer(world.bea, "synthetic_audio", 30, 0);
  offer(world.bea, "synthetic_audio", 60, -100);
  // Ambiguous or malformed offers.
  offer(world.una, "synthetic_audio", 30, 4000);
  offer(world.una, "synthetic_audio", 30, 4100);
  offer(world.una, "synthetic_video", 30, 4000, "xts");
  offer(world.una, "synthetic_video", 60, 4000, "XTS", "not-an-object");
  offer(world.cat, "synthetic_video", 30, 5000);
  offer(world.cy, "synthetic_video", 30, 5000);
}

// ---------------------------------------------------------------------------
// Inventory and privileges
// ---------------------------------------------------------------------------

const P1_COLUMNS = Object.freeze({
  consultation_requests:
    "id,intake_id,client_id,selected_attorney_id,referral_id,request_path,referral_policy_version_id,engagement_policy_version_id,requested_modality,state,response_deadline_at,created_at,accepted_at,declined_at,expired_at,cancelled_at",
  fee_calculations:
    "id,consultation_request_id,fee_policy_version_id,attorney_listed_price_minor,platform_fee_minor,client_fee_minor,tax_or_other_required_fee_minor,total_client_amount_minor,currency_code,quote_valid_until,calculated_at,supersedes_fee_calculation_id,calculation_snapshot,created_at",
  slot_holds:
    "id,consultation_request_id,attorney_id,slot_start_at,slot_end_at,held_at,expires_at,released_at,release_reason,created_at",
  bookability_evaluations:
    "id,attorney_id,eligibility_evaluation_id,context_type,context_id,evaluated_at,as_of,modality,presence_observed,presence_trust_method,instant_intent_observed,slot_start_at,slot_end_at,availability_basis,constraint_results,result,created_at",
});

const REQUEST_RELATIONS = Object.freeze([
  "consultation_requests",
  "fee_calculations",
]);

// Client functions: authenticated only, security definer.
const CLIENT_FUNCTIONS = Object.freeze({
  "client_request_review(uuid)":
    "s|search_path=pg_catalog, pg_temp|TABLE(referral_id uuid, attorney_display_name text, request_path text, request_id uuid, requestable boolean)",
  "request_options(uuid)":
    "s|search_path=pg_catalog, pg_temp|TABLE(modality text, duration_minutes integer)",
  "request_slot_starts(uuid, text, integer)":
    "s|search_path=pg_catalog, pg_temp|TABLE(slot_start timestamp with time zone, slot_end timestamp with time zone)",
  "request_quote_preview(uuid, text, text, integer, timestamptz)":
    "s|search_path=pg_catalog, pg_temp|TABLE(outcome text, attorney_listed_price_minor bigint, client_fee_minor bigint, tax_or_other_required_fee_minor bigint, total_client_amount_minor bigint, currency_code text, quote_validity_seconds integer)",
  "request_create(uuid, text, text, integer, timestamptz)":
    "v|search_path=pg_catalog, pg_temp;lock_timeout=3s|TABLE(outcome text, request_id uuid, problem text)",
  "request_withdraw(uuid)":
    "v|search_path=pg_catalog, pg_temp;lock_timeout=3s|TABLE(outcome text)",
  "client_request(uuid)":
    "s|search_path=pg_catalog, pg_temp|TABLE(request_id uuid, state text, expired_due boolean, request_path text, attorney_display_name text, requested_modality text, duration_minutes integer, slot_start_at timestamp with time zone, slot_end_at timestamp with time zone, response_deadline_at timestamp with time zone, created_at timestamp with time zone, attorney_listed_price_minor bigint, client_fee_minor bigint, tax_or_other_required_fee_minor bigint, total_client_amount_minor bigint, currency_code text, quote_valid_until timestamp with time zone)",
  "client_intake_requests(uuid)":
    "s|search_path=pg_catalog, pg_temp|TABLE(attempt_ordinal integer, referral_id uuid, request_id uuid, state text, expired_due boolean, requestable boolean)",
});

// Internal building blocks and guards: executable by no API role. The two
// deferred evidence checks are security definer (they run at commit under
// whatever role the transaction has); every other one is security invoker.
const INTERNAL_FUNCTIONS = Object.freeze({
  "consultation_request_integrity()": false,
  "request_point_in_time_evidence()": true,
  "fee_calculation_with_request()": true,
  "fee_calculation_no_truncate()": false,
  "pricing_attorney_offers(uuid)": false,
  "pricing_attorney_offer(uuid, text, integer)": false,
  "pricing_integer_within(jsonb, numeric, numeric)": false,
  "pricing_optional_integer_within(jsonb, numeric, numeric)": false,
  "pricing_component_valid(jsonb)": false,
  "pricing_fee_parameters_valid(jsonb)": false,
  "pricing_fee_policy(uuid, timestamptz)": false,
  "pricing_component_minor(bigint, jsonb, text)": false,
  "pricing_quote(uuid, uuid, text, integer, timestamptz)": false,
  "request_referral_path(uuid)": false,
  "request_client_referral(uuid)": false,
  "request_response_window(uuid, text, timestamptz)": false,
  "request_expired_due(uuid)": false,
  "request_expire_if_due(uuid, boolean)": false,
  "request_expiry_sweep()": false,
});

// The P1 deferred consistency checks S6 makes security definer, and the S4
// function S6 replaces (still security invoker).
const P1_DEFERRED = Object.freeze([
  "enforce_request_hold_consistency()",
  "enforce_payment_request_consistency()",
]);

async function unrecordedChecks() {
  await check(
    "ENV-1 in an unrecorded environment no Fee Policy is selectable: the reader answers environment_unrecorded and the quote engine policy_unavailable",
    () => {
      assert.equal(
        sql(
          `select outcome from public.pricing_fee_policy('${uid()}', now());`,
        ),
        "environment_unrecorded",
      );
      assert.equal(
        sql(
          `select outcome from public.pricing_quote('${uid()}', '${uid()}', 'synthetic_video', 30, now());`,
        ),
        "policy_unavailable",
      );
    },
  );
}

async function inventoryChecks() {
  await check(
    "MIG-1 the three S6 migrations follow S5 last and in order, are registered unreviewed and applied nowhere, are Program migration refs, and apply on plain PostgreSQL with the pg_cron step skipped",
    () => {
      assert.deepEqual(report.migrations.notices[S6_MIGRATIONS[0]], []);
      assert.deepEqual(report.migrations.notices[S6_MIGRATIONS[1]], []);
      assert.deepEqual(report.migrations.notices[S6_MIGRATIONS[2]], [
        "pg_cron is not available: no schedule registered (commands and reads still evaluate request expiry)",
      ]);
      return { applied: report.migrations.applied };
    },
  );
  await check(
    "MIG-2 no relation, column, enum type, policy type, capability, row policy or seed row is added: the P1 columns of the request, fee, Hold and Bookability relations are unchanged and the S6 migration texts create none",
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
      for (const file of S6_MIGRATIONS) {
        const text = fs
          .readFileSync(path.join(MIGRATIONS, file), "utf8")
          .replace(/--[^\n]*/g, "");
        assert.doesNotMatch(
          text,
          /create\s+table|add\s+column|create\s+type|create\s+policy|insert\s+into\s+public\.(policy_types|policy_versions|capability_definitions|capability_grants|deployment_environment|jurisdictions|practice_areas)/i,
          file,
        );
      }
      assert.equal(count("policy_types"), 15);
      assert.equal(
        sql(
          "select string_agg(tablename || '.' || policyname, ',' order by tablename, policyname) from pg_policies where schemaname = 'public' and tablename in ('consultation_requests', 'fee_calculations', 'slot_holds');",
        ),
        "consultation_requests.consultation_requests_select_own_client",
      );
    },
  );
  await check(
    "PRIV-1 the request and fee relations are function-only: anon holds nothing, authenticated only the P1 SELECT on its own Requests (nothing on Fee Calculations), service_role only SELECT (no column-level write either); RLS stays enabled",
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
      for (const table of REQUEST_RELATIONS) {
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
      assert.deepEqual(observed, {
        "anon:consultation_requests": "",
        "authenticated:consultation_requests": "SELECT",
        "service_role:consultation_requests": "SELECT",
        "anon:fee_calculations": "",
        "authenticated:fee_calculations": "",
        "service_role:fee_calculations": "SELECT",
      });
      for (const table of REQUEST_RELATIONS) {
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
    "PRIV-2 anon executes nothing new: exactly the three S5 public reads remain executable by anon, and anon holds no privilege on any table, view or sequence of the public schema",
    () => {
      const executable = sql(
        "select string_agg(p.oid::regprocedure::text, ';' order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE');",
      ).split(";");
      assert.deepEqual(executable, [
        "public_attorney_directory(uuid,uuid,text,integer)",
        "public_attorney_profile(uuid,uuid)",
        "public_discovery_filters()",
      ]);
      assert.equal(
        sql(
          `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as pr(p)
           where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p', 'f') and has_table_privilege('anon', c.oid, pr.p);`,
        ),
        "0",
      );
      return { anon_executable: executable };
    },
  );
  await check(
    "PRIV-3 function inventory: the eight client functions are security definer, owned by the owner role, search_path pinned (lock_timeout on the two writes), executable by authenticated only, with exactly their result columns; every internal building block and guard is executable by no API role nor a PUBLIC-only role, search_path pinned, security invoker except the two deferred evidence checks; the two P1 deferred consistency checks are now security definer with search_path pinned and executable by no API role; the replaced S4 hold function stays security invoker and internal; every function S6 comments as its own is listed",
    () => {
      sql("create role s6_probe nologin;");
      for (const [signature, settings] of Object.entries(CLIENT_FUNCTIONS)) {
        const [volatility, config, result] = settings.split("|");
        assert.equal(
          sql(
            `select prosecdef::text || '|' || provolatile::text || '|' || array_to_string(proconfig, ';') || '|' || pg_get_userbyid(proowner) || '|' || pg_get_function_result(oid) from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          `true|${volatility}|${config}|postgres|${result}`,
          signature,
        );
        for (const [role, allowed] of [
          ["anon", "f"],
          ["authenticated", "t"],
          ["service_role", "f"],
          ["s6_probe", "f"],
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
      const internal = {
        ...INTERNAL_FUNCTIONS,
        "scheduling_acquire_hold(uuid, timestamptz, timestamptz)": false,
      };
      for (const [signature, definer] of Object.entries(internal)) {
        assert.equal(
          sql(
            `select prosecdef::text || '|' || array_to_string(proconfig, ';') || '|' || pg_get_userbyid(proowner) from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          signature === "request_expiry_sweep()"
            ? "false|search_path=pg_catalog, pg_temp;lock_timeout=3s|postgres"
            : `${definer}|search_path=pg_catalog, pg_temp|postgres`,
          signature,
        );
        for (const role of [
          "anon",
          "authenticated",
          "service_role",
          "s6_probe",
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
      for (const signature of P1_DEFERRED) {
        assert.equal(
          sql(
            `select prosecdef::text || '|' || array_to_string(proconfig, ';') || '|' || pg_get_userbyid(proowner) from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          "true|search_path=pg_catalog, pg_temp|postgres",
          signature,
        );
        for (const role of [
          "anon",
          "authenticated",
          "service_role",
          "s6_probe",
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
      const commented = sql(
        "select string_agg(p.oid::regprocedure::text, ';' order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and obj_description(p.oid, 'pg_proc') like 'MVP-001 S6%';",
      ).split(";");
      const listed = [
        ...Object.keys(CLIENT_FUNCTIONS),
        ...Object.keys(INTERNAL_FUNCTIONS),
      ].map((signature) =>
        sql(`select 'public.${signature}'::regprocedure::text;`),
      );
      assert.deepEqual([...commented].sort(), [...listed].sort());
      // The triggers S6 adds, with their timing and functions.
      assert.equal(
        sql(
          "select string_agg(c.relname || ':' || t.tgname || ':' || p.proname || ':' || t.tgdeferrable::text, ',' order by c.relname, t.tgname) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid where not t.tgisinternal and p.proname in ('consultation_request_integrity', 'request_point_in_time_evidence', 'fee_calculation_with_request', 'fee_calculation_no_truncate');",
        ),
        "consultation_requests:consultation_requests_change_guard:consultation_request_integrity:false,consultation_requests:consultation_requests_no_truncate:consultation_request_integrity:false,consultation_requests:consultation_requests_point_in_time_evidence:request_point_in_time_evidence:true,fee_calculations:fee_calculations_no_truncate:fee_calculation_no_truncate:false,fee_calculations:fee_calculations_with_request:fee_calculation_with_request:true",
      );
      sql("drop role s6_probe;");
      return {
        client_functions: Object.keys(CLIENT_FUNCTIONS).length,
        internal_functions: Object.keys(INTERNAL_FUNCTIONS).length,
      };
    },
  );
  await check(
    "PRIV-4 anon cannot call any S6 function, the internal building blocks refuse every API role, and direct DML by authenticated or service_role on the request and fee relations is refused (42501); authenticated cannot read Fee Calculations directly",
    () => {
      const scenarioCase = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "instant",
      });
      for (const statement of [
        CREATE({ referral: scenarioCase.referral, path: "instant" }),
        PREVIEW({ referral: scenarioCase.referral, path: "instant" }),
        `select * from public.client_request_review('${scenarioCase.referral}');`,
        `select * from public.request_options('${scenarioCase.referral}');`,
        `select * from public.request_slot_starts('${scenarioCase.referral}', 'synthetic_video', 30);`,
        WITHDRAW(uid()),
        `select * from public.client_request('${uid()}');`,
        `select * from public.client_intake_requests('${scenarioCase.client.intake}');`,
        `select * from public.pricing_quote('${world.ada.profile}', '${world.J.A}', 'synthetic_video', 30, now());`,
      ]) {
        assert.equal(as("anon", null, statement), "ERROR 42501", statement);
      }
      for (const role of ["authenticated", "service_role"]) {
        const sub = role === "authenticated" ? scenarioCase.client.auth : null;
        for (const statement of [
          `insert into public.consultation_requests (intake_id, client_id, selected_attorney_id, referral_id, request_path, referral_policy_version_id, requested_modality, state) values ('${scenarioCase.client.intake}', '${scenarioCase.client.client}', '${world.ada.profile}', '${scenarioCase.referral}', 'instant', '${world.policies.referral[world.J.A]}', 'synthetic_video', 'created');`,
          "update public.consultation_requests set state = 'cancelled', cancelled_at = now();",
          "delete from public.consultation_requests;",
          "truncate public.consultation_requests cascade;",
          "insert into public.fee_calculations (consultation_request_id) values (gen_random_uuid());",
          "update public.fee_calculations set attorney_listed_price_minor = 1;",
          "delete from public.fee_calculations;",
          "truncate public.fee_calculations cascade;",
          `select * from public.request_expire_if_due('${uid()}', false);`,
          "select public.request_expiry_sweep();",
          `select * from public.pricing_attorney_offers('${world.ada.profile}');`,
          `select * from public.pricing_fee_policy('${world.J.A}', now());`,
          `select * from public.scheduling_acquire_hold('${uid()}', now(), now() + interval '30 minutes');`,
        ]) {
          assert.equal(
            as(role, sub, statement, { aal: "aal1" }),
            "ERROR 42501",
            `${role}: ${statement}`,
          );
        }
      }
      assert.equal(
        asClient(
          scenarioCase.client,
          "select count(*) from public.fee_calculations;",
        ),
        "ERROR 42501",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// The shipped price-source seam
// ---------------------------------------------------------------------------

async function shippedSeamChecks() {
  await check(
    "SEAM-1 the shipped price-source seam answers no offer, so with complete configuration every preview and every instant or scheduled Request creation answers price_unavailable and writes nothing (no Request, evaluation, Fee Calculation, Hold or audit event), no option or slot start is offered, and no price is ever zero or a fallback (MB section 152: a missing price makes the attorney not bookable)",
    () => {
      assert.equal(
        sql(
          `select count(*) from public.pricing_attorney_offers('${world.ada.profile}');`,
        ),
        "0",
      );
      assert.equal(
        sql(
          `select count(*) from public.pricing_attorney_offer('${world.ada.profile}', 'synthetic_video', 30);`,
        ),
        "0",
      );
      const instantCase = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "instant",
      });
      const scheduledCase = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "scheduled",
      });
      const slot = at(2, 10);
      const before = evidenceCounts();
      for (const [modality, duration] of [
        ["synthetic_video", 30],
        ["synthetic_video", 60],
        ["synthetic_audio", 30],
      ]) {
        assert.equal(
          sql(
            `select outcome from public.pricing_quote('${world.ada.profile}', '${world.J.A}', '${modality}', ${duration}, now());`,
          ),
          "price_unavailable",
        );
        assert.equal(
          preview(instantCase.client, {
            referral: instantCase.referral,
            path: "instant",
            modality,
            duration,
          }).outcome,
          "price_unavailable",
        );
        assert.equal(
          preview(scheduledCase.client, {
            referral: scheduledCase.referral,
            path: "scheduled",
            modality,
            duration,
            slot,
          }).outcome,
          "price_unavailable",
        );
        assert.deepEqual(
          create(instantCase.client, {
            referral: instantCase.referral,
            path: "instant",
            modality,
            duration,
          }).line,
          "price_unavailable||",
        );
        assert.deepEqual(
          create(scheduledCase.client, {
            referral: scheduledCase.referral,
            path: "scheduled",
            modality,
            duration,
            slot,
          }).line,
          "price_unavailable||",
        );
      }
      assert.deepEqual(evidenceCounts(), before);
      assert.deepEqual(
        readOptions(scheduledCase.client, scheduledCase.referral),
        [],
      );
      assert.deepEqual(
        readStarts(
          scheduledCase.client,
          scheduledCase.referral,
          "synthetic_video",
          30,
        ),
        [],
      );
      assert.deepEqual(
        readReview(scheduledCase.client, scheduledCase.referral),
        [
          {
            referral_id: scheduledCase.referral,
            attorney_display_name: "Ada Synthetic",
            request_path: "scheduled",
            request_id: null,
            requestable: true,
          },
        ],
      );
      assert.equal(
        count(
          "fee_calculations",
          "attorney_listed_price_minor <= 0 or total_client_amount_minor <= 0",
        ),
        0,
      );
      return { refused_attempts: 12, written: 0 };
    },
  );
}

// ---------------------------------------------------------------------------
// The Fee Policy and the quote engine
// ---------------------------------------------------------------------------

const QUOTE = (lawyer, jurisdiction, modality, duration) =>
  `select row_to_json(q)::text from public.pricing_quote('${lawyer.profile}', '${jurisdiction}', ${lit(modality)}, ${duration === null ? "null" : duration}, now()) q;`;

const quoteOf = (lawyer, jurisdiction, modality, duration) =>
  jsonOf(QUOTE(lawyer, jurisdiction, modality, duration));

async function pricingChecks() {
  await check(
    "POL-1 the Fee Policy reader requires every parameter explicitly: the complete synthetic policy is valid (null bounds allowed), and a missing, extra, mistyped or out-of-range key, a duplicate duration or modality, an unknown rounding, a minimum above its maximum or a malformed component makes it policy_incomplete; no policy is no_applicable_policy",
    () => {
      const valid = (parameters) =>
        sql(
          `select public.pricing_fee_parameters_valid(${lit(parameters)}::jsonb);`,
        );
      assert.equal(valid(FEE()), "t");
      assert.equal(
        valid(
          FEE({
            listed_price_minimum_minor: null,
            listed_price_maximum_minor: null,
            rounding: "half_even",
          }),
        ),
        "t",
      );
      const without = (key) => {
        const copy = FEE();
        delete copy[key];
        return copy;
      };
      const malformed = [
        ...Object.keys(FEE()).map((key) => without(key)),
        { ...FEE(), extra_key: 1 },
        FEE({ currency_code: "xts" }),
        FEE({ currency_code: "XT" }),
        FEE({ currency_code: 978 }),
        FEE({ quote_validity_seconds: 59 }),
        FEE({ quote_validity_seconds: 604801 }),
        FEE({ quote_validity_seconds: 90.5 }),
        FEE({ quote_validity_seconds: "900" }),
        FEE({ permitted_durations_minutes: [] }),
        FEE({ permitted_durations_minutes: [30, 30] }),
        FEE({ permitted_durations_minutes: [0] }),
        FEE({ permitted_durations_minutes: [1441] }),
        FEE({ permitted_durations_minutes: [30.5] }),
        FEE({ permitted_durations_minutes: "30" }),
        FEE({ permitted_modalities: [] }),
        FEE({ permitted_modalities: ["Synthetic Video"] }),
        FEE({ permitted_modalities: ["synthetic_video", "synthetic_video"] }),
        FEE({ permitted_modalities: [1] }),
        FEE({ permitted_modalities: "synthetic_video" }),
        FEE({ listed_price_minimum_minor: 0 }),
        FEE({ listed_price_minimum_minor: 1.5 }),
        FEE({
          listed_price_minimum_minor: 5000,
          listed_price_maximum_minor: 1000,
        }),
        FEE({ rounding: "nearest" }),
        FEE({ rounding: null }),
        FEE({ platform_fee: COMPONENT(10001) }),
        FEE({ platform_fee: COMPONENT(-1) }),
        FEE({ platform_fee: COMPONENT(100, -1) }),
        FEE({ platform_fee: COMPONENT(100, 0, 500, 100) }),
        FEE({ platform_fee: { ...COMPONENT(100), extra: 1 } }),
        FEE({ platform_fee: { basis_points: 100, fixed_minor: 0 } }),
        FEE({ platform_fee: null }),
        FEE({ client_fee: { ...COMPONENT(100), minimum_minor: "100" } }),
        FEE({ other_required_fee: [0, 0, null, null] }),
        [FEE()],
      ];
      for (const parameters of malformed) {
        assert.equal(valid(parameters), "f", JSON.stringify(parameters));
      }
      assert.equal(
        sql(
          `select outcome || '|' || (policy_version_id = '${world.policies.fee[world.J.A]}')::text from public.pricing_fee_policy('${world.J.A}', now());`,
        ),
        "selected|true",
      );
      assert.equal(
        sql(
          `select outcome || '|' || coalesce(policy_version_id::text, '') from public.pricing_fee_policy('${world.J.F}', now());`,
        ),
        "no_applicable_policy|",
      );
      assert.equal(
        sql(
          `select outcome || '|' || (policy_version_id = '${world.policies.fee[world.J.G]}')::text || '|' || coalesce(parameters::text, 'null') from public.pricing_fee_policy('${world.J.G}', now());`,
        ),
        "policy_incomplete|true|null",
      );
      return { malformed_refused: malformed.length };
    },
  );
  await check(
    "QUOTE-1 the quote engine prices only a single valid offer that the Fee Policy permits: the components follow clamp(round(price x basis_points / 10000) + fixed, minimum, maximum) under each rounding mode, the client total is price + client fee + other fee (the platform fee is attorney-side), and the refusals are, in order, invalid, policy_unavailable, price_unavailable (no, ambiguous, zero, negative or malformed offer), modality_not_permitted, duration_not_permitted and price_not_permitted (below the minimum, above the maximum, another currency); the snapshot records inputs, every component's pricing source, the formula and the quote validity",
    () => {
      const component = (price, rule, rounding) =>
        Number(
          sql(
            `select public.pricing_component_minor(${price}, ${lit(rule)}::jsonb, ${lit(rounding)});`,
          ),
        );
      const quarter = COMPONENT(250);
      const table = {
        1010: { half_up: 25, half_even: 25, down: 25, up: 26 },
        1020: { half_up: 26, half_even: 26, down: 25, up: 26 },
        1060: { half_up: 27, half_even: 26, down: 26, up: 27 },
      };
      for (const [price, modes] of Object.entries(table)) {
        for (const [rounding, expected] of Object.entries(modes)) {
          assert.equal(
            component(price, quarter, rounding),
            expected,
            `${price} ${rounding}`,
          );
        }
      }
      assert.equal(component(1000, COMPONENT(250, 50, 100, 2000), "up"), 100);
      assert.equal(
        component(100000, COMPONENT(250, 50, 100, 2000), "up"),
        2000,
      );
      assert.equal(component(5000, COMPONENT(0, 300), "down"), 300);
      const priced = quoteOf(world.ada, world.J.A, "synthetic_video", 30);
      assert.deepEqual(
        { ...priced, calculation_snapshot: undefined },
        {
          outcome: "priced",
          fee_policy_version_id: world.policies.fee[world.J.A],
          attorney_listed_price_minor: 5000,
          platform_fee_minor: 500,
          client_fee_minor: 175,
          tax_or_other_required_fee_minor: 0,
          total_client_amount_minor: 5175,
          currency_code: "XTS",
          quote_validity_seconds: 900,
          calculation_snapshot: undefined,
        },
      );
      const snapshot = priced.calculation_snapshot;
      assert.deepEqual(Object.keys(snapshot).sort(), [
        "components",
        "formula",
        "inputs",
        "quote_validity_seconds",
        "schema",
      ]);
      assert.equal(snapshot.schema, "rosuno.fee_calculation_snapshot.v1");
      assert.deepEqual(
        { ...snapshot.inputs, as_of: undefined },
        {
          attorney_id: world.ada.profile,
          jurisdiction_id: world.J.A,
          modality: "synthetic_video",
          duration_minutes: 30,
          as_of: undefined,
          attorney_listed_price_minor: 5000,
          attorney_price_currency_code: "XTS",
          fee_policy_version_id: world.policies.fee[world.J.A],
          fee_policy_parameters: FEE(),
        },
      );
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(snapshot.components).map(([k, v]) => [
            k,
            [v.amount_minor, v.pricing_source, v.party ?? null],
          ]),
        ),
        {
          attorney_listed_price: [5000, "attorney_offer", null],
          platform_fee: [500, "fee_policy", "attorney"],
          client_fee: [175, "fee_policy", "client"],
          tax_or_other_required_fee: [0, "fee_policy", "client"],
        },
      );
      assert.deepEqual(
        snapshot.components.attorney_listed_price.offer_reference,
        {
          synthetic_offer: "synthetic_video-30",
        },
      );
      assert.deepEqual(
        snapshot.components.client_fee.rule,
        COMPONENT(250, 50, 100, 2000),
      );
      assert.equal(snapshot.quote_validity_seconds, 900);
      const sixty = quoteOf(world.ada, world.J.A, "synthetic_video", 60);
      assert.deepEqual(
        [
          sixty.attorney_listed_price_minor,
          sixty.platform_fee_minor,
          sixty.client_fee_minor,
          sixty.total_client_amount_minor,
        ],
        [9000, 900, 275, 9275],
      );
      const outcomes = [
        [world.ada, world.J.A, "synthetic_audio", 30, "priced"],
        [world.ada, world.J.A, "synthetic_video", 90, "duration_not_permitted"],
        [world.ada, world.J.A, "synthetic_text", 30, "modality_not_permitted"],
        [world.ada, world.J.A, "synthetic_audio", 60, "price_not_permitted"],
        [world.bea, world.J.A, "synthetic_video", 30, "price_not_permitted"],
        [world.bea, world.J.A, "synthetic_video", 60, "price_not_permitted"],
        [world.bea, world.J.A, "synthetic_audio", 30, "price_unavailable"],
        [world.bea, world.J.A, "synthetic_audio", 60, "price_unavailable"],
        [world.ben, world.J.A, "synthetic_video", 30, "price_unavailable"],
        [world.una, world.J.A, "synthetic_audio", 30, "price_unavailable"],
        [world.una, world.J.A, "synthetic_video", 30, "price_unavailable"],
        [world.una, world.J.A, "synthetic_video", 60, "price_unavailable"],
        [world.ada, world.J.F, "synthetic_video", 30, "policy_unavailable"],
        [world.ada, world.J.G, "synthetic_video", 30, "policy_unavailable"],
        [world.ada, world.J.A, "Synthetic Video", 30, "invalid"],
        [world.ada, world.J.A, "synthetic_video", 0, "invalid"],
        [world.ada, world.J.A, "synthetic_video", null, "invalid"],
      ];
      for (const [
        lawyer,
        jurisdiction,
        modality,
        duration,
        expected,
      ] of outcomes) {
        const answer = quoteOf(lawyer, jurisdiction, modality, duration);
        assert.equal(
          answer.outcome,
          expected,
          `${lawyer.name} ${modality} ${duration}`,
        );
        if (expected !== "priced") {
          assert.deepEqual(
            Object.entries(answer).filter(
              ([k, v]) => k !== "outcome" && v !== null,
            ),
            [],
          );
        }
      }
      return { outcomes: outcomes.length };
    },
  );
  await check(
    "QUOTE-2 the client's preview answers the derived quote for their own Referral with only the client-facing amounts (never the platform fee, policy or snapshot), the same refusals, invalid for a malformed call or a path other than the Referral's, already_requested once a Request exists, and not_found for another client's or an unknown Referral; options are exactly the priced offers and slot starts lie on the half-hour grid inside offered windows; nothing is persisted",
    () => {
      const scheduledCase = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "scheduled",
      });
      const instantCase = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "instant",
      });
      const priceless = scenario({
        jurisdiction: world.J.A,
        lawyer: world.bea,
        path: "scheduled",
      });
      const slot = at(2, 14);
      const before = evidenceCounts();
      const answer = preview(scheduledCase.client, {
        referral: scheduledCase.referral,
        path: "scheduled",
        slot,
      });
      assert.deepEqual(answer, {
        outcome: "priced",
        attorney_listed_price_minor: 5000,
        client_fee_minor: 175,
        tax_or_other_required_fee_minor: 0,
        total_client_amount_minor: 5175,
        currency_code: "XTS",
        quote_validity_seconds: 900,
      });
      for (const [options, expected] of [
        [
          { modality: "synthetic_video", duration: 90 },
          "duration_not_permitted",
        ],
        [
          { modality: "synthetic_text", duration: 30 },
          "modality_not_permitted",
        ],
        [{ modality: "synthetic_audio", duration: 60 }, "price_not_permitted"],
        [{ modality: "Synthetic", duration: 30 }, "invalid"],
        [{ duration: 0 }, "invalid"],
        [{ slot: null }, "invalid"],
        [{ path: "instant" }, "invalid"],
        [{ path: "instant", slot: null }, "invalid"],
        [{ path: "soon" }, "invalid"],
      ]) {
        assert.equal(
          preview(scheduledCase.client, {
            referral: scheduledCase.referral,
            path: "scheduled",
            slot,
            ...options,
          }).outcome,
          expected,
          JSON.stringify(options),
        );
      }
      assert.equal(
        preview(instantCase.client, {
          referral: instantCase.referral,
          path: "instant",
          slot: slot,
        }).outcome,
        "invalid",
      );
      assert.equal(
        preview(instantCase.client, {
          referral: instantCase.referral,
          path: "instant",
        }).outcome,
        "priced",
      );
      for (const referral of [scheduledCase.referral, uid()]) {
        assert.equal(
          preview(world.stranger, { referral, path: "scheduled", slot })
            .outcome,
          "not_found",
        );
      }
      assert.deepEqual(
        readOptions(scheduledCase.client, scheduledCase.referral),
        [
          { modality: "synthetic_audio", duration_minutes: 30 },
          { modality: "synthetic_video", duration_minutes: 30 },
          { modality: "synthetic_video", duration_minutes: 60 },
        ],
      );
      assert.deepEqual(readOptions(priceless.client, priceless.referral), []);
      assert.deepEqual(readOptions(world.stranger, scheduledCase.referral), []);
      const starts = readStarts(
        scheduledCase.client,
        scheduledCase.referral,
        "synthetic_video",
        60,
      );
      assert.equal(starts.length, 20);
      const notice = Date.now() + 3600 * 1000 - 5000;
      for (const [index, entry] of starts.entries()) {
        const start = Date.parse(entry.slot_start);
        assert.equal(start % (30 * 60000), 0, entry.slot_start);
        assert.equal(Date.parse(entry.slot_end) - start, 60 * 60000);
        assert.ok(start >= notice, entry.slot_start);
        if (index > 0) {
          assert.ok(start > Date.parse(starts[index - 1].slot_start));
        }
      }
      assert.deepEqual(
        readStarts(
          scheduledCase.client,
          scheduledCase.referral,
          "synthetic_video",
          90,
        ),
        [],
      );
      assert.deepEqual(
        readStarts(
          instantCase.client,
          instantCase.referral,
          "synthetic_video",
          30,
        ),
        [],
      );
      assert.deepEqual(
        readStarts(
          world.stranger,
          scheduledCase.referral,
          "synthetic_video",
          60,
        ),
        [],
      );
      assert.deepEqual(evidenceCounts(), before);
      return { first_start: starts[0].slot_start, starts: starts.length };
    },
  );
}

// ---------------------------------------------------------------------------
// Request creation
// ---------------------------------------------------------------------------

const REFERRAL_CREATE = ({
  intake,
  lawyer,
  jurisdiction,
  area = null,
  path: requestPath,
}) =>
  `select outcome || '|' || coalesce(referral_id::text, '') from public.referral_create(${lit(intake)}, ${lit(lawyer.profile)}, ${lit(jurisdiction)}, ${lit(area)}, ${lit(requestPath)}, 'any', 1);`;

function referralCreate(client, options) {
  const [outcome, referral] = asClient(client, REFERRAL_CREATE(options)).split(
    "|",
  );
  assert.equal(outcome, "created", `referral_create: ${outcome}`);
  return referral;
}

// The evidence of one Request written by its own transaction.
function evidenceOf(request) {
  return jsonOf(`
    with q as (select r.*, r.xmin as row_xmin from public.consultation_requests r where r.id = '${request}')
    select json_build_object(
      'request', (select row_to_json(x) from (select id, intake_id, client_id, selected_attorney_id, referral_id, request_path, referral_policy_version_id, engagement_policy_version_id, requested_modality, state, extract(epoch from response_deadline_at - created_at)::integer as window_seconds from q) x),
      'eligibility', (select json_agg(json_build_object('id', e.id, 'context', e.context_type, 'context_id', e.context_id, 'result', e.result) order by e.context_type) from public.eligibility_evaluations e, q where e.xmin = q.row_xmin and e.attorney_id = q.selected_attorney_id),
      'bookability', (select json_agg(json_build_object('result', b.result, 'modality', b.modality, 'slot_start', b.slot_start_at, 'slot_end', b.slot_end_at, 'eligibility_evaluation_id', b.eligibility_evaluation_id, 'same_transaction', b.xmin = q.row_xmin, 'factors', (select json_agg(f ->> 'factor') from jsonb_array_elements(b.constraint_results) f))) from public.bookability_evaluations b, q where b.context_type = 'consultation_request' and b.context_id = q.id),
      'fee', (select json_agg(json_build_object('id', c.id, 'policy', c.fee_policy_version_id, 'price', c.attorney_listed_price_minor, 'platform', c.platform_fee_minor, 'client', c.client_fee_minor, 'other', c.tax_or_other_required_fee_minor, 'total', c.total_client_amount_minor, 'currency', c.currency_code, 'validity', extract(epoch from c.quote_valid_until - c.calculated_at)::integer, 'quote_valid_until', c.quote_valid_until, 'root', c.supersedes_fee_calculation_id is null, 'same_transaction', c.xmin = q.row_xmin, 'duration', c.calculation_snapshot -> 'inputs' -> 'duration_minutes', 'modality', c.calculation_snapshot -> 'inputs' ->> 'modality')) from public.fee_calculations c, q where c.consultation_request_id = q.id),
      'hold', (select json_agg(json_build_object('id', h.id, 'slot_start', h.slot_start_at, 'slot_end', h.slot_end_at, 'expires_at', h.expires_at, 'released_at', h.released_at, 'release_reason', h.release_reason)) from public.slot_holds h, q where h.consultation_request_id = q.id),
      'audit', (select json_agg(json_build_object('action', a.action_code, 'actor', a.actor_type, 'reason', a.reason_code) order by a.occurred_at) from public.audit_events a, q where a.resource_id = q.id)
    )::text;`);
}

async function requestChecks() {
  await check(
    "REQ-1 an instant Request from a Referral the client made through referral_create: created in state created with the referral policy and the instant response deadline, a fresh jurisdiction-context Eligibility Evaluation and a fresh bookable consultation_request Bookability Evaluation from its own transaction (distinct from the Referral's), one root Fee Calculation with the policy amounts, its snapshot and the quote validity, no Hold and one audit event; the client reads it back with exactly the allowlisted fields; a second attempt is already_requested",
    () => {
      const client = newClient(["submitted"]);
      const referral = referralCreate(client, {
        intake: client.intake,
        lawyer: world.ada,
        jurisdiction: world.J.A,
        path: "instant",
      });
      const referralEvaluations = jsonOf(
        `select json_agg(b.eligibility_evaluation_id) from public.bookability_evaluations b where b.context_type = 'referral' and b.context_id = '${referral}';`,
      );
      const before = evidenceCounts();
      const made = create(client, { referral, path: "instant" });
      assert.equal(made.outcome, "created", made.line);
      world.req1 = { client, referral, request: made.request };
      const evidence = evidenceOf(made.request);
      assert.deepEqual(evidence.request, {
        id: made.request,
        intake_id: client.intake,
        client_id: client.client,
        selected_attorney_id: world.ada.profile,
        referral_id: referral,
        request_path: "instant",
        referral_policy_version_id: world.policies.referral[world.J.A],
        engagement_policy_version_id: null,
        requested_modality: "synthetic_video",
        state: "created",
        window_seconds: 900,
      });
      assert.equal(evidence.eligibility.length, 1);
      assert.equal(evidence.eligibility[0].context, "jurisdiction");
      assert.equal(evidence.eligibility[0].result, "eligible");
      assert.ok(!referralEvaluations.includes(evidence.eligibility[0].id));
      assert.deepEqual(evidence.bookability, [
        {
          result: "bookable",
          modality: "synthetic_video",
          slot_start: null,
          slot_end: null,
          eligibility_evaluation_id: evidence.eligibility[0].id,
          same_transaction: true,
          factors: [
            "eligibility",
            "instant_intent",
            "presence",
            "consultation",
          ],
        },
      ]);
      assert.equal(evidence.fee.length, 1);
      const fee = evidence.fee[0];
      assert.deepEqual(
        { ...fee, id: undefined, quote_valid_until: undefined },
        {
          id: undefined,
          policy: world.policies.fee[world.J.A],
          price: 5000,
          platform: 500,
          client: 175,
          other: 0,
          total: 5175,
          currency: "XTS",
          validity: 900,
          quote_valid_until: undefined,
          root: true,
          same_transaction: true,
          duration: 30,
          modality: "synthetic_video",
        },
      );
      assert.equal(evidence.hold, null);
      assert.deepEqual(evidence.audit, [
        {
          action: "consultation_request.created",
          actor: "client",
          reason: null,
        },
      ]);
      const after = evidenceCounts();
      assert.deepEqual(
        Object.fromEntries(
          EVIDENCE_TABLES.map((t) => [t, after[t] - before[t]]),
        ),
        {
          consultation_requests: 1,
          fee_calculations: 1,
          slot_holds: 0,
          eligibility_evaluations: 1,
          bookability_evaluations: 1,
          audit_events: 1,
        },
      );
      const [read] = readRequest(client, made.request);
      assert.deepEqual(Object.keys(read), [
        "request_id",
        "state",
        "expired_due",
        "request_path",
        "attorney_display_name",
        "requested_modality",
        "duration_minutes",
        "slot_start_at",
        "slot_end_at",
        "response_deadline_at",
        "created_at",
        "attorney_listed_price_minor",
        "client_fee_minor",
        "tax_or_other_required_fee_minor",
        "total_client_amount_minor",
        "currency_code",
        "quote_valid_until",
      ]);
      assert.deepEqual(
        {
          ...read,
          response_deadline_at: undefined,
          created_at: undefined,
          quote_valid_until: undefined,
        },
        {
          request_id: made.request,
          state: "created",
          expired_due: false,
          request_path: "instant",
          attorney_display_name: "Ada Synthetic",
          requested_modality: "synthetic_video",
          duration_minutes: 30,
          slot_start_at: null,
          slot_end_at: null,
          response_deadline_at: undefined,
          created_at: undefined,
          attorney_listed_price_minor: 5000,
          client_fee_minor: 175,
          tax_or_other_required_fee_minor: 0,
          total_client_amount_minor: 5175,
          currency_code: "XTS",
          quote_valid_until: undefined,
        },
      );
      assert.equal(
        Date.parse(read.quote_valid_until),
        Date.parse(fee.quote_valid_until),
      );
      assert.deepEqual(readIntake(client, client.intake), [
        {
          attempt_ordinal: 1,
          referral_id: referral,
          request_id: made.request,
          state: "created",
          expired_due: false,
          requestable: false,
        },
      ]);
      assert.deepEqual(readReview(client, referral), [
        {
          referral_id: referral,
          attorney_display_name: "Ada Synthetic",
          request_path: "instant",
          request_id: made.request,
          requestable: false,
        },
      ]);
      assert.equal(
        preview(client, { referral, path: "instant" }).outcome,
        "already_requested",
      );
      const again = evidenceCounts();
      assert.equal(
        create(client, { referral, path: "instant" }).line,
        "already_requested||",
      );
      assert.deepEqual(evidenceCounts(), again);
      return { request: made.request, total_client_amount_minor: 5175 };
    },
  );
  await check(
    "REQ-2 a scheduled Request from a practice-area-filtered Referral (made through referral_create): fresh eligibility in the jurisdiction and the filtered practice-area contexts, a bookable evaluation for the chosen slot (start plus the chosen 60 minutes) based on the practice-area evaluation, the Fee Calculation for the 60-minute offer, the Hold for exactly that slot whose expiry never passes the quote validity or the response deadline, state slot_held, and one audit event; the slot comes from the offered starts",
    () => {
      const client = newClient(["submitted"]);
      const referral = referralCreate(client, {
        intake: client.intake,
        lawyer: world.ada,
        jurisdiction: world.J.A,
        area: world.PA.one,
        path: "scheduled",
      });
      const [first] = readStarts(client, referral, "synthetic_video", 60);
      const made = create(client, {
        referral,
        path: "scheduled",
        duration: 60,
        slot: first.slot_start,
      });
      assert.equal(made.outcome, "created", made.line);
      world.req2 = { client, referral, request: made.request, slot: first };
      const evidence = evidenceOf(made.request);
      assert.equal(evidence.request.state, "slot_held");
      assert.equal(evidence.request.window_seconds, 3600);
      assert.deepEqual(
        evidence.eligibility.map((e) => [e.context, e.context_id, e.result]),
        [
          ["jurisdiction", null, "eligible"],
          ["practice_area", world.PA.one, "eligible"],
        ],
      );
      const areaEvaluation = evidence.eligibility.find(
        (e) => e.context === "practice_area",
      ).id;
      assert.equal(evidence.bookability.length, 1);
      const bookability = evidence.bookability[0];
      assert.equal(bookability.result, "bookable");
      assert.equal(bookability.eligibility_evaluation_id, areaEvaluation);
      assert.deepEqual(bookability.factors, ["eligibility", "slot"]);
      assert.equal(
        Date.parse(bookability.slot_start),
        Date.parse(first.slot_start),
      );
      assert.equal(
        Date.parse(bookability.slot_end),
        Date.parse(first.slot_end),
      );
      const fee = evidence.fee[0];
      assert.deepEqual(
        [
          fee.price,
          fee.platform,
          fee.client,
          fee.other,
          fee.total,
          fee.duration,
        ],
        [9000, 900, 275, 0, 9275, 60],
      );
      assert.equal(evidence.hold.length, 1);
      const hold = evidence.hold[0];
      assert.equal(Date.parse(hold.slot_start), Date.parse(first.slot_start));
      assert.equal(Date.parse(hold.slot_end), Date.parse(first.slot_end));
      assert.equal(hold.released_at, null);
      // The quote ends first here, so the Hold ends exactly with it.
      assert.equal(
        Date.parse(hold.expires_at),
        Date.parse(fee.quote_valid_until),
      );
      const deadline = sql(
        `select (response_deadline_at >= (select expires_at from public.slot_holds where consultation_request_id = '${made.request}'))::text from public.consultation_requests where id = '${made.request}';`,
      );
      assert.equal(deadline, "true");
      assert.deepEqual(evidence.audit, [
        {
          action: "consultation_request.created",
          actor: "client",
          reason: null,
        },
      ]);
      const [read] = readRequest(client, made.request);
      assert.equal(read.state, "slot_held");
      assert.equal(read.duration_minutes, 60);
      assert.equal(
        Date.parse(read.slot_start_at),
        Date.parse(first.slot_start),
      );
      assert.equal(Date.parse(read.slot_end_at), Date.parse(first.slot_end));
      assert.equal(read.total_client_amount_minor, 9275);
      return { slot: first.slot_start, hold_expires_at: hold.expires_at };
    },
  );
  await check(
    "REQ-3 every refusal leaves nothing (no Request, evaluation, Fee Calculation, Hold or audit event): invalid (malformed arguments, a path other than the Referral's), not_found (an unknown Referral, another client's, a caller without a Client Profile), intake_not_ready, not_available (a recorded Referral outcome, an attorney no longer eligible, a slot within the notice, in a Blackout or outside availability, Instant mode off), price_unavailable, price_not_permitted, duration_not_permitted, modality_not_permitted, and policy_unavailable (no referral policy, no response window, no Fee Policy, a malformed Fee Policy); a failed scheduled creation leaves no orphan Hold",
    () => {
      const A = world.J.A;
      const slot = at(3, 10);
      const make = (jurisdiction, lawyer, requestPath, extra = {}) =>
        scenario({ jurisdiction, lawyer, path: requestPath, ...extra });
      const outcomeCase = make(A, world.ada, "scheduled");
      assert.equal(
        sql(
          `select outcome from public.referral_record_outcome('${outcomeCase.referral}', 'synthetic_closed');`,
        ),
        "recorded",
      );
      const ineligible = make(A, world.cat, "scheduled");
      sql(
        `update public.users set account_state = 'suspended' where id = '${world.cat.user}';`,
      );
      sql(
        `insert into public.blackouts (attorney_id, starts_at, ends_at, reason_code) values ('${world.ada.profile}', '${at(5, 10)}', '${at(5, 12)}', 'synthetic_leave');`,
      );
      const closedClient = newClient(["closed"]);
      const closed = ownerReferral({
        client: closedClient,
        attorney: world.ada,
        jurisdiction: A,
      });
      const scheduledA = make(A, world.ada, "scheduled");
      const instantA = make(A, world.ada, "instant");
      const cases = [
        [scheduledA, { path: "soon", slot }, "invalid||"],
        [
          scheduledA,
          { path: "scheduled", modality: "Synthetic Video", slot },
          "invalid||",
        ],
        [scheduledA, { path: "scheduled", duration: 0, slot }, "invalid||"],
        [scheduledA, { path: "scheduled", duration: 1441, slot }, "invalid||"],
        [scheduledA, { path: "scheduled" }, "invalid||"],
        [instantA, { path: "instant", slot }, "invalid||"],
        [
          { ...scheduledA, referral: null },
          { path: "scheduled", slot },
          "invalid||",
        ],
        [instantA, { path: "scheduled", slot }, "invalid||"],
        [
          { ...scheduledA, referral: uid() },
          { path: "scheduled", slot },
          "not_found||",
        ],
        [
          { ...scheduledA, client: world.stranger },
          { path: "scheduled", slot },
          "not_found||",
        ],
        [
          { ...scheduledA, client: world.ada },
          { path: "scheduled", slot },
          "not_found||",
        ],
        [
          { client: closedClient, referral: closed },
          { path: "scheduled", slot },
          "intake_not_ready||",
        ],
        [
          outcomeCase,
          { path: "scheduled", slot },
          "not_available||referral_ended",
        ],
        [
          ineligible,
          { path: "scheduled", slot },
          "not_available||not_eligible",
        ],
        [
          scheduledA,
          {
            path: "scheduled",
            slot: new Date(
              Math.ceil((Date.now() + 15 * 60000) / 60000) * 60000,
            ).toISOString(),
          },
          "not_available||notice",
        ],
        [
          scheduledA,
          { path: "scheduled", slot: at(5, 10, 30) },
          "not_available||blackout",
        ],
        [
          make(A, world.una, "scheduled"),
          { path: "scheduled", slot },
          "not_available||outside_availability",
        ],
        [
          make(A, world.ben, "instant"),
          { path: "instant" },
          "not_available||intent_off",
        ],
        [
          make(A, world.ben, "scheduled"),
          { path: "scheduled", slot },
          "price_unavailable||",
        ],
        [
          make(A, world.bea, "scheduled"),
          { path: "scheduled", slot },
          "price_not_permitted||",
        ],
        [
          make(A, world.bea, "scheduled"),
          { path: "scheduled", modality: "synthetic_audio", slot },
          "price_unavailable||",
        ],
        [
          scheduledA,
          {
            path: "scheduled",
            modality: "synthetic_audio",
            duration: 60,
            slot,
          },
          "price_not_permitted||",
        ],
        [
          scheduledA,
          { path: "scheduled", duration: 90, slot },
          "duration_not_permitted||",
        ],
        [
          scheduledA,
          { path: "scheduled", modality: "synthetic_text", slot },
          "modality_not_permitted||",
        ],
        [
          make(world.J.R, world.ada, "instant"),
          { path: "instant" },
          "policy_unavailable||",
        ],
        [
          make(world.J.W, world.ada, "instant"),
          { path: "instant" },
          "policy_unavailable||",
        ],
        [
          make(world.J.F, world.ada, "instant"),
          { path: "instant" },
          "policy_unavailable||",
        ],
        [
          make(world.J.G, world.ada, "scheduled"),
          { path: "scheduled", slot },
          "policy_unavailable||",
        ],
      ];
      const before = evidenceCounts();
      for (const [entry, options, expected] of cases) {
        const answer = create(entry.client, {
          referral: entry.referral,
          ...options,
        });
        assert.equal(
          answer.line,
          expected,
          `${JSON.stringify(options)} ${expected}`,
        );
      }
      assert.deepEqual(evidenceCounts(), before);
      // The intake that refused stays unchanged and every refused Referral
      // still has no Request.
      assert.equal(
        count(
          "consultation_requests",
          `referral_id in (${cases
            .filter(([e]) => e.referral)
            .map(([e]) => lit(e.referral))
            .join(", ")})`,
        ),
        0,
      );
      return { refusals: cases.length };
    },
  );
  await check(
    "REQ-4 the Hold stage refuses atomically: too_late (the Hold would expire at once: the slot is within the pre-slot interval) and cap_reached (the attorney's pending Hold cap) leave no Request, evaluation, Fee Calculation, Hold or audit event, and a Hold within the cap is acquired",
    () => {
      const C = world.J.C;
      const lateCase = scenario({
        jurisdiction: C,
        lawyer: world.cy,
        path: "scheduled",
      });
      const firstCase = scenario({
        jurisdiction: C,
        lawyer: world.cy,
        path: "scheduled",
      });
      const secondCase = scenario({
        jurisdiction: C,
        lawyer: world.cy,
        path: "scheduled",
      });
      const before = evidenceCounts();
      const late = new Date(
        Math.ceil((Date.now() + 5 * 60000) / 60000) * 60000,
      ).toISOString();
      assert.equal(
        create(lateCase.client, {
          referral: lateCase.referral,
          path: "scheduled",
          slot: late,
        }).line,
        "too_late||",
      );
      assert.deepEqual(evidenceCounts(), before);
      const first = create(firstCase.client, {
        referral: firstCase.referral,
        path: "scheduled",
        slot: at(4, 10),
      });
      assert.equal(first.outcome, "created", first.line);
      const middle = evidenceCounts();
      assert.equal(
        create(secondCase.client, {
          referral: secondCase.referral,
          path: "scheduled",
          slot: at(4, 14),
        }).line,
        "cap_reached||",
      );
      assert.deepEqual(evidenceCounts(), middle);
      // Withdrawing frees the cap again for the concurrency probe.
      assert.equal(
        asClient(firstCase.client, WITHDRAW(first.request)),
        "withdrawn",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Fee Calculation immutability and integrity for every role
// ---------------------------------------------------------------------------

async function financialChecks() {
  await check(
    "FIN-1 a Fee Calculation is immutable for every role and never truncated; a later attorney price change alters neither it nor the client's quote, while a new Request records the new price in a new Fee Calculation; a second root or one written outside its Request's own (sub)transaction is refused; a zero price is refused; only a same-Request supersession may follow, and then it is the current quote",
    () => {
      const first = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "instant",
      });
      const made = create(first.client, {
        referral: first.referral,
        path: "instant",
        modality: "synthetic_audio",
      });
      assert.equal(made.outcome, "created", made.line);
      const fee = jsonOf(
        `select row_to_json(c)::text from public.fee_calculations c where consultation_request_id = '${made.request}';`,
      );
      assert.equal(fee.attorney_listed_price_minor, 4000);
      sql(
        `update proof_s6.offers set listed_price_minor = 4500 where attorney_id = '${world.ada.profile}' and modality = 'synthetic_audio' and duration_minutes = 30;`,
      );
      assert.deepEqual(
        jsonOf(
          `select row_to_json(c)::text from public.fee_calculations c where consultation_request_id = '${made.request}';`,
        ),
        fee,
      );
      assert.equal(
        readRequest(first.client, made.request)[0].attorney_listed_price_minor,
        4000,
      );
      const second = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "instant",
      });
      const remade = create(second.client, {
        referral: second.referral,
        path: "instant",
        modality: "synthetic_audio",
      });
      assert.equal(remade.outcome, "created", remade.line);
      const newFee = jsonOf(
        `select row_to_json(c)::text from public.fee_calculations c where consultation_request_id = '${remade.request}';`,
      );
      assert.equal(newFee.attorney_listed_price_minor, 4500);
      assert.notEqual(newFee.id, fee.id);
      assert.equal(
        readRequest(first.client, made.request)[0].attorney_listed_price_minor,
        4000,
      );
      for (const [statement, code] of [
        [
          `update public.fee_calculations set attorney_listed_price_minor = 1 where id = '${fee.id}';`,
          "23514",
        ],
        [
          `update public.fee_calculations set quote_valid_until = quote_valid_until + interval '1 day' where id = '${fee.id}';`,
          "23514",
        ],
        [
          `delete from public.fee_calculations where id = '${fee.id}';`,
          "23514",
        ],
        ["truncate public.fee_calculations cascade;", "55000"],
      ]) {
        assert.equal(refused(statement), code, statement);
      }
      const columns =
        "consultation_request_id, fee_policy_version_id, attorney_listed_price_minor, platform_fee_minor, client_fee_minor, tax_or_other_required_fee_minor, total_client_amount_minor, currency_code, quote_valid_until, calculated_at, supersedes_fee_calculation_id, calculation_snapshot";
      const values = (request, price, supersedes = null) =>
        `'${request}', '${world.policies.fee[world.J.A]}', ${price}, 0, 0, 0, ${price}, 'XTS', now() + interval '10 minutes', now(), ${lit(supersedes)}, '{}'::jsonb`;
      assert.equal(
        refused(
          `insert into public.fee_calculations (${columns}) values (${values(made.request, 4000)});`,
        ),
        "23505",
      );
      // A root written in another subtransaction than its Request.
      const throwaway = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "instant",
      });
      const request = uid();
      assert.equal(
        refused(
          `${ownerRequestSql({ request, referral: throwaway.referral, client: throwaway.client, attorney: world.ada, jurisdiction: world.J.A, omit: ["fee"] })}
           savepoint late_fee;
           insert into public.fee_calculations (${columns}) values (${values(request, 4000)});
           release savepoint late_fee;`,
        ),
        "23514",
      );
      // A zero price is refused, even by the owner.
      assert.equal(
        refused(
          `${ownerRequestSql({ request: uid(), referral: throwaway.referral, client: throwaway.client, attorney: world.ada, jurisdiction: world.J.A, omit: ["fee"] })}
           insert into public.fee_calculations (${columns}) select id, '${world.policies.fee[world.J.A]}', 0, 0, 0, 0, 0, 'XTS', null, now(), null, '{}'::jsonb from public.consultation_requests where referral_id = '${throwaway.referral}';`,
        ),
        "23514",
      );
      // A same-Request supersession may follow; it is then the current quote.
      sql(
        `insert into public.fee_calculations (${columns}) values (${values(remade.request, 4400, newFee.id)});`,
      );
      assert.equal(
        readRequest(second.client, remade.request)[0]
          .attorney_listed_price_minor,
        4400,
      );
      assert.equal(
        refused(
          `insert into public.fee_calculations (${columns}) values (${values(remade.request, 4300, newFee.id)});`,
        ),
        "23505",
      );
      assert.equal(
        refused(
          `insert into public.fee_calculations (${columns}) values (${values(made.request, 4300, newFee.id)});`,
        ),
        "23514",
      );
      return { original: 4000, later_price: 4500 };
    },
  );
  await check(
    "INT-1 point-in-time evidence for every role: even the owner cannot commit a Request alone, without its eligibility, Bookability or Fee Calculation, with evidence from an earlier transaction, with a not-eligible or foreign-jurisdiction evaluation, with Bookability for another modality, or (scheduled) without its Hold or with a Bookability slot other than the Hold's; complete same-transaction evidence commits",
    () => {
      const base = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "instant",
      });
      const fixture = (options) =>
        ownerRequestSql({
          referral: base.referral,
          client: base.client,
          attorney: world.ada,
          jurisdiction: world.J.A,
          ...options,
        });
      for (const [label, statement] of [
        ["alone", fixture({ omit: ["eligibility", "bookability", "fee"] })],
        ["no bookability", fixture({ omit: ["bookability"] })],
        ["no fee", fixture({ omit: ["fee"] })],
        ["other modality", fixture({ bookabilityModality: "synthetic_audio" })],
      ]) {
        assert.equal(refused(statement), "23514", label);
      }
      // Not eligible, and eligible elsewhere.
      const evaluation = uid();
      for (const [result, jurisdiction] of [
        ["not_eligible", world.J.A],
        ["eligible", world.J.Q],
      ]) {
        const request = uid();
        assert.equal(
          refused(
            `insert into public.consultation_requests (id, intake_id, client_id, selected_attorney_id, referral_id, request_path, referral_policy_version_id, requested_modality, state, response_deadline_at) values ('${request}', '${base.client.intake}', '${base.client.client}', '${world.ada.profile}', '${base.referral}', 'instant', '${world.policies.referral[world.J.A]}', 'synthetic_video', 'created', now() + interval '1 hour');
             insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, context_id, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${evaluation}', '${world.ada.profile}', '${jurisdiction}', 'jurisdiction', null, now(), '[]'::jsonb, '${result}', '[]'::jsonb, '{}'::jsonb, now());
             insert into public.bookability_evaluations (attorney_id, eligibility_evaluation_id, context_type, context_id, evaluated_at, as_of, modality, constraint_results, result) values ('${world.ada.profile}', '${evaluation}', 'consultation_request', '${request}', now(), now(), 'synthetic_video', '[]'::jsonb, 'bookable');
             insert into public.fee_calculations (consultation_request_id, fee_policy_version_id, attorney_listed_price_minor, platform_fee_minor, client_fee_minor, tax_or_other_required_fee_minor, total_client_amount_minor, currency_code, calculated_at, calculation_snapshot) values ('${request}', '${world.policies.fee[world.J.A]}', 5000, 0, 0, 0, 5000, 'XTS', now(), '{}'::jsonb);`,
          ),
          "23514",
          `${result} ${jurisdiction}`,
        );
      }
      // Evidence written by an earlier transaction for a future Request id.
      const stale = uid();
      const staleEvaluation = uid();
      sql(
        `insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, context_id, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${staleEvaluation}', '${world.ada.profile}', '${world.J.A}', 'jurisdiction', null, now(), '[]'::jsonb, 'eligible', '[]'::jsonb, '{}'::jsonb, now());
         insert into public.bookability_evaluations (attorney_id, eligibility_evaluation_id, context_type, context_id, evaluated_at, as_of, modality, constraint_results, result) values ('${world.ada.profile}', '${staleEvaluation}', 'consultation_request', '${stale}', now(), now(), 'synthetic_video', '[]'::jsonb, 'bookable');`,
      );
      assert.equal(
        refused(
          fixture({ request: stale, omit: ["eligibility", "bookability"] }),
        ),
        "23514",
      );
      // Scheduled: no Hold (the P1 check), and a Bookability slot other than
      // the Hold's (the S6 check).
      const scheduled = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "scheduled",
      });
      const scheduledFixture = (options) =>
        ownerRequestSql({
          referral: scheduled.referral,
          client: scheduled.client,
          attorney: world.ada,
          jurisdiction: world.J.A,
          path: "scheduled",
          slot: at(7, 10),
          ...options,
        });
      assert.equal(refused(scheduledFixture({ omit: ["hold"] })), "23514");
      assert.equal(refused(scheduledFixture({ holdSlot: at(7, 12) })), "23514");
      // Complete same-transaction evidence commits, instant and scheduled.
      sql(["begin;", fixture({}), "commit;"].join("\n"));
      sql(["begin;", scheduledFixture({}), "commit;"].join("\n"));
      world.ownerRequests += 2;
      world.ownerInstant = sql(
        `select id from public.consultation_requests where referral_id = '${base.referral}';`,
      );
      world.ownerScheduled = sql(
        `select id from public.consultation_requests where referral_id = '${scheduled.referral}';`,
      );
      assert.equal(
        sql(
          `select state from public.consultation_requests where id = '${world.ownerScheduled}';`,
        ),
        "slot_held",
      );
    },
  );
  await check(
    "INT-2 the Request lifecycle guard holds for every role: created only, a lower-snake modality and the DM section 9 state vocabulary; identity and creation facts, the response deadline once set and the engagement policy once set never change; transitions only along the two paths (an instant Request is never slot_held, a scheduled one never payment_authorized, decisions only from awaiting_attorney); nothing leaves a terminal state, so an expired Request is never revived; never deleted or truncated",
    () => {
      const base = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "instant",
      });
      for (const [label, options] of [
        ["slot_held insert", { state: "slot_held" }],
        ["pending insert", { state: "pending" }],
        [
          "spaced modality",
          {
            modality: "Synthetic Video",
            bookabilityModality: "Synthetic Video",
          },
        ],
      ]) {
        assert.equal(
          refused(
            ownerRequestSql({
              referral: base.referral,
              client: base.client,
              attorney: world.ada,
              jurisdiction: world.J.A,
              ...options,
            }),
          ),
          "23514",
          label,
        );
      }
      const instantId = world.ownerInstant;
      const scheduledId = world.ownerScheduled;
      const other = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "instant",
      });
      for (const statement of [
        `update public.consultation_requests set referral_id = '${other.referral}' where id = '${instantId}';`,
        `update public.consultation_requests set request_path = 'scheduled' where id = '${instantId}';`,
        `update public.consultation_requests set requested_modality = 'synthetic_audio' where id = '${instantId}';`,
        `update public.consultation_requests set created_at = created_at - interval '1 minute' where id = '${instantId}';`,
        `update public.consultation_requests set referral_policy_version_id = '${world.policies.referral[world.J.Q]}' where id = '${instantId}';`,
        `update public.consultation_requests set selected_attorney_id = '${world.bea.profile}' where id = '${instantId}';`,
        `update public.consultation_requests set response_deadline_at = response_deadline_at + interval '1 hour' where id = '${instantId}';`,
        `update public.consultation_requests set engagement_policy_version_id = '${world.policies.referral[world.J.A]}' where id = '${instantId}';
         update public.consultation_requests set engagement_policy_version_id = '${world.policies.referral[world.J.Q]}' where id = '${instantId}';`,
        `update public.consultation_requests set state = 'slot_held' where id = '${instantId}';`,
        `update public.consultation_requests set state = 'awaiting_attorney' where id = '${instantId}';`,
        `update public.consultation_requests set state = 'accepted', accepted_at = now() where id = '${instantId}';`,
        `update public.consultation_requests set state = 'declined', declined_at = now() where id = '${instantId}';`,
        `update public.consultation_requests set state = 'payment_authorized' where id = '${scheduledId}';`,
        `update public.consultation_requests set state = 'declined', declined_at = now() where id = '${scheduledId}';`,
        `delete from public.consultation_requests where id = '${instantId}';`,
        "truncate public.consultation_requests cascade;",
      ]) {
        assert.equal(refused(statement), "55000", statement);
      }
      // The permitted walks (rolled back; the deferred checks are not the
      // subject here).
      acceptedThenRolledBack(
        `update public.consultation_requests set state = 'payment_authorized' where id = '${instantId}';
         update public.consultation_requests set state = 'awaiting_attorney' where id = '${instantId}';
         update public.consultation_requests set state = 'declined', declined_at = now() where id = '${instantId}';`,
      );
      acceptedThenRolledBack(
        `update public.consultation_requests set state = 'awaiting_attorney' where id = '${scheduledId}';
         update public.consultation_requests set state = 'accepted', accepted_at = now() where id = '${scheduledId}';`,
      );
      acceptedThenRolledBack(
        `update public.consultation_requests set engagement_policy_version_id = '${world.policies.referral[world.J.A]}' where id = '${instantId}';`,
      );
      // A terminal Request never changes again.
      sql(
        `update public.consultation_requests set state = 'cancelled', cancelled_at = now() where id = '${instantId}';`,
      );
      for (const statement of [
        `update public.consultation_requests set state = 'created', cancelled_at = null where id = '${instantId}';`,
        `update public.consultation_requests set state = 'expired', expired_at = now(), cancelled_at = null where id = '${instantId}';`,
        `update public.consultation_requests set cancelled_at = cancelled_at + interval '1 second' where id = '${instantId}';`,
      ]) {
        assert.equal(refused(statement), "55000", statement);
      }
    },
  );
  await check(
    "INT-3 the P1 deferred Request/Hold checks, now security definer, still refuse violations for every role: a cancelled scheduled Request cannot keep its active Hold, and an instant Request cannot have a Hold; Requests created and withdrawn through authenticated calls commit with them in force",
    () => {
      const scheduledId = world.ownerScheduled;
      assert.equal(
        refused(
          `update public.consultation_requests set state = 'cancelled', cancelled_at = now() where id = '${scheduledId}';`,
        ),
        "23514",
      );
      const instantCase = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "instant",
      });
      const request = uid();
      assert.equal(
        refused(
          `${ownerRequestSql({ request, referral: instantCase.referral, client: instantCase.client, attorney: world.ada, jurisdiction: world.J.A })}
           insert into public.slot_holds (consultation_request_id, attorney_id, slot_start_at, slot_end_at, held_at, expires_at) values ('${request}', '${world.ada.profile}', '${at(8, 10)}', '${at(8, 11)}', now(), now() + interval '5 minutes');`,
        ),
        "23514",
      );
      // REQ-1, REQ-2 and REQ-4 committed through authenticated calls; the
      // checks are definer, owned by the owner role.
      assert.equal(
        sql(
          "select string_agg(proname || ':' || prosecdef::text, ',' order by proname) from pg_proc where proname in ('enforce_request_hold_consistency', 'enforce_payment_request_consistency');",
        ),
        "enforce_payment_request_consistency:true,enforce_request_hold_consistency:true",
      );
      // The scheduled owner Request is withdrawn properly: state first, then
      // its Hold, in one transaction.
      sql(
        `begin;
         update public.consultation_requests set state = 'cancelled', cancelled_at = now() where id = '${scheduledId}';
         update public.slot_holds set released_at = now(), release_reason = 'released' where consultation_request_id = '${scheduledId}';
         commit;`,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Withdrawal and expiry
// ---------------------------------------------------------------------------

async function withdrawalChecks() {
  await check(
    "WD-1 the client withdraws their own undecided Request: it is cancelled and its Hold released after the state change, with one client audit event; the slot is free again; a second withdrawal is not_withdrawable; another client's and an unknown Request answer not_found alike; an instant Request withdraws without a Hold",
    () => {
      const slot = at(9, 10);
      const held = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "scheduled",
      });
      const made = create(held.client, {
        referral: held.referral,
        path: "scheduled",
        slot,
      });
      assert.equal(made.outcome, "created", made.line);
      assert.equal(
        asClient(world.stranger, WITHDRAW(made.request)),
        "not_found",
      );
      assert.equal(asClient(held.client, WITHDRAW(uid())), "not_found");
      assert.equal(asClient(held.client, WITHDRAW(null)), "invalid");
      assert.equal(asClient(held.client, WITHDRAW(made.request)), "withdrawn");
      const evidence = evidenceOf(made.request);
      assert.equal(evidence.request.state, "cancelled");
      assert.equal(evidence.hold[0].release_reason, "released");
      assert.deepEqual(evidence.audit, [
        {
          action: "consultation_request.created",
          actor: "client",
          reason: null,
        },
        {
          action: "consultation_request.withdrawn",
          actor: "client",
          reason: "client_withdrawal",
        },
      ]);
      assert.equal(
        asClient(held.client, WITHDRAW(made.request)),
        "not_withdrawable",
      );
      assert.equal(
        readRequest(held.client, made.request)[0].state,
        "cancelled",
      );
      const next = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "scheduled",
      });
      assert.equal(
        create(next.client, {
          referral: next.referral,
          path: "scheduled",
          slot,
        }).outcome,
        "created",
      );
      const instantCase = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "instant",
      });
      const instantMade = create(instantCase.client, {
        referral: instantCase.referral,
        path: "instant",
      });
      assert.equal(
        asClient(instantCase.client, WITHDRAW(instantMade.request)),
        "withdrawn",
      );
      assert.equal(evidenceOf(instantMade.request).hold, null);
    },
  );
}

async function waitUntil(isoInstant, extraMs = 500) {
  const delay = Date.parse(isoInstant) + extraMs - Date.now();
  if (delay > 0) {
    await sleep(delay);
  }
}

function expirySetup() {
  // Q: quotes valid 60 seconds, long Holds and deadlines.
  const scheduledCase = scenario({
    jurisdiction: world.J.Q,
    lawyer: world.ada,
    path: "scheduled",
  });
  const instantCase = scenario({
    jurisdiction: world.J.Q,
    lawyer: world.ada,
    path: "instant",
  });
  const scheduled = create(scheduledCase.client, {
    referral: scheduledCase.referral,
    path: "scheduled",
    slot: at(1, 12),
  });
  const instantMade = create(instantCase.client, {
    referral: instantCase.referral,
    path: "instant",
  });
  assert.equal(scheduled.outcome, "created", scheduled.line);
  assert.equal(instantMade.outcome, "created", instantMade.line);
  world.quoteExpiry = {
    scheduled: { ...scheduledCase, request: scheduled.request },
    instant: { ...instantCase, request: instantMade.request },
  };
}

async function expiryChecks() {
  await check(
    "EXP-0 a short-quote jurisdiction: the quote is valid exactly the policy's 60 seconds and a scheduled Request's Hold ends exactly when the quote ends (DM section 8: hold expiry at the earliest of the response window, the pre-slot interval and quote expiry)",
    () => {
      const { scheduled, instant: instantCase } = world.quoteExpiry;
      const evidence = evidenceOf(scheduled.request);
      assert.equal(evidence.fee[0].validity, 60);
      assert.equal(
        Date.parse(evidence.hold[0].expires_at),
        Date.parse(evidence.fee[0].quote_valid_until),
      );
      assert.equal(evidenceOf(instantCase.request).fee[0].validity, 60);
      return { quote_valid_until: evidence.fee[0].quote_valid_until };
    },
  );
  await check(
    "EXP-1 the response deadline is a stored server instant: once an instant Request's deadline passes, the client's read reports expired_due before anything runs, and the next evaluation expires it with one system audit event (reason response_deadline_reached); the read then reports it expired",
    async () => {
      const deadlineCase = scenario({
        jurisdiction: world.J.D,
        lawyer: world.dot,
        path: "instant",
      });
      const made = create(deadlineCase.client, {
        referral: deadlineCase.referral,
        path: "instant",
      });
      assert.equal(made.outcome, "created", made.line);
      const [fresh] = readRequest(deadlineCase.client, made.request);
      assert.equal(fresh.expired_due, false);
      await waitUntil(fresh.response_deadline_at);
      const [due] = readRequest(deadlineCase.client, made.request);
      assert.deepEqual([due.state, due.expired_due], ["created", true]);
      assert.equal(
        sql(`select public.request_expire_if_due('${made.request}');`),
        "expired",
      );
      assert.equal(
        sql(`select public.request_expire_if_due('${made.request}');`),
        "expired",
      );
      const [expired] = readRequest(deadlineCase.client, made.request);
      assert.deepEqual(
        [expired.state, expired.expired_due],
        ["expired", false],
      );
      assert.deepEqual(evidenceOf(made.request).audit, [
        {
          action: "consultation_request.created",
          actor: "client",
          reason: null,
        },
        {
          action: "consultation_request.expired",
          actor: "system",
          reason: "response_deadline_reached",
        },
      ]);
    },
  );
  await check(
    "EXP-2 a Hold that reaches its own deadline expires its Request: the client's withdrawal evaluates expiry first and answers expired; the Hold ends expired (S4) and the Request's audit reason is hold_expired",
    async () => {
      const holdCase = scenario({
        jurisdiction: world.J.H,
        lawyer: world.ada,
        path: "scheduled",
      });
      const made = create(holdCase.client, {
        referral: holdCase.referral,
        path: "scheduled",
        slot: at(1, 16),
      });
      assert.equal(made.outcome, "created", made.line);
      const hold = evidenceOf(made.request).hold[0];
      await waitUntil(hold.expires_at);
      assert.equal(
        asClient(holdCase.client, WITHDRAW(made.request)),
        "expired",
      );
      const evidence = evidenceOf(made.request);
      assert.equal(evidence.request.state, "expired");
      assert.equal(evidence.hold[0].release_reason, "expired");
      assert.deepEqual(
        evidence.audit.map((a) => [a.action, a.reason]),
        [
          ["consultation_request.created", null],
          ["consultation_request.expired", "hold_expired"],
        ],
      );
      assert.equal(
        count(
          "audit_events",
          `action_code = 'slot_hold.expired' and resource_id = '${hold.id}'`,
        ),
        1,
      );
    },
  );
  await check(
    "EXP-3 MBS section 11: quote expiry expires the Request and releases its Hold: after the 60-second quote both short-quote Requests read expired_due, the bounded sweep expires them (reason quote_expired) and the scheduled one's Hold has ended at the quote's end, so it never outlived the Request it served (PM INV-6)",
    async () => {
      const { scheduled, instant: instantCase } = world.quoteExpiry;
      const fee = evidenceOf(scheduled.request).fee[0];
      await waitUntil(fee.quote_valid_until, 1000);
      for (const entry of [scheduled, instantCase]) {
        const [due] = readRequest(entry.client, entry.request);
        assert.equal(due.expired_due, true);
      }
      const swept = jsonOf("select public.request_expiry_sweep()::text;");
      assert.ok(swept.expired >= 2, JSON.stringify(swept));
      for (const entry of [scheduled, instantCase]) {
        const evidence = evidenceOf(entry.request);
        assert.equal(evidence.request.state, "expired");
        assert.deepEqual(evidence.audit.at(-1), {
          action: "consultation_request.expired",
          actor: "system",
          reason: "quote_expired",
        });
      }
      const hold = evidenceOf(scheduled.request).hold[0];
      assert.equal(hold.release_reason, "expired");
      assert.ok(Date.parse(hold.released_at) >= Date.parse(hold.expires_at));
      assert.equal(
        Date.parse(hold.expires_at),
        Date.parse(fee.quote_valid_until),
      );
      report.concurrency.quote_expiry = { swept };
      return swept;
    },
  );
  await check(
    "EXP-4 an expired quote cannot be revived: no role can move the expired Request back, the same Referral answers already_requested to a new Request and a preview, the withdrawal answers expired, and only a new Referral gets a new Request with a new Fee Calculation",
    () => {
      const { scheduled } = world.quoteExpiry;
      for (const statement of [
        `update public.consultation_requests set state = 'created', expired_at = null where id = '${scheduled.request}';`,
        `update public.consultation_requests set state = 'slot_held', expired_at = null where id = '${scheduled.request}';`,
      ]) {
        assert.equal(refused(statement), "55000", statement);
      }
      assert.equal(
        create(scheduled.client, {
          referral: scheduled.referral,
          path: "scheduled",
          slot: at(1, 18),
        }).line,
        "already_requested||",
      );
      assert.equal(
        preview(scheduled.client, {
          referral: scheduled.referral,
          path: "scheduled",
          slot: at(1, 18),
        }).outcome,
        "already_requested",
      );
      assert.equal(
        asClient(scheduled.client, WITHDRAW(scheduled.request)),
        "expired",
      );
      assert.equal(
        readReview(scheduled.client, scheduled.referral)[0].requestable,
        false,
      );
      const oldFee = evidenceOf(scheduled.request).fee[0].id;
      const fresh = ownerReferral({
        client: scheduled.client,
        attorney: world.ada,
        jurisdiction: world.J.Q,
      });
      const made = create(scheduled.client, {
        referral: fresh,
        path: "scheduled",
        slot: at(1, 12),
      });
      assert.equal(made.outcome, "created", made.line);
      assert.notEqual(evidenceOf(made.request).fee[0].id, oldFee);
      assert.deepEqual(
        readIntake(scheduled.client, scheduled.client.intake).map((r) => [
          r.attempt_ordinal,
          r.state,
        ]),
        [
          [1, "expired"],
          [2, "slot_held"],
        ],
      );
    },
  );
  await check(
    "EXP-5 the sweep is bounded and never waits: while another transaction holds the attorney's scheduling lock the due Request is skipped (busy) and stays open; the next run expires it",
    async () => {
      const busyCase = scenario({
        jurisdiction: world.J.D,
        lawyer: world.dot,
        path: "instant",
      });
      const made = create(busyCase.client, {
        referral: busyCase.referral,
        path: "instant",
      });
      assert.equal(made.outcome, "created", made.line);
      await waitUntil(
        readRequest(busyCase.client, made.request)[0].response_deadline_at,
      );
      const holder = await session("holder");
      await holder.ok("begin;");
      await holder.ok(
        `select public.scheduling_lock_attorney('${world.dot.profile}');`,
      );
      const skipped = jsonOf("select public.request_expiry_sweep()::text;");
      assert.ok(skipped.busy >= 1, JSON.stringify(skipped));
      assert.equal(
        sql(
          `select state from public.consultation_requests where id = '${made.request}';`,
        ),
        "created",
      );
      await holder.ok("rollback;");
      holder.close();
      const swept = jsonOf("select public.request_expiry_sweep()::text;");
      assert.ok(swept.expired >= 1, JSON.stringify(swept));
      assert.equal(
        sql(
          `select state from public.consultation_requests where id = '${made.request}';`,
        ),
        "expired",
      );
      return { skipped, swept };
    },
  );
}

// ---------------------------------------------------------------------------
// Concurrency (two persistent sessions, real concurrency)
// ---------------------------------------------------------------------------

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

async function concurrencyChecks() {
  await check(
    "CC-1 two Requests for one Referral at once (two sessions of the same client): the second waits on the first's locks, then answers already_requested; exactly one Request, one Fee Calculation, one set of evidence and one audit event exist",
    async () => {
      const target = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "instant",
      });
      const before = evidenceCounts();
      const first = await clientSession("first", target.client);
      const second = await clientSession("second", target.client);
      const one = await first.ok(
        CREATE({ referral: target.referral, path: "instant" }),
      );
      const pending = second.send(
        CREATE({ referral: target.referral, path: "instant" }),
      );
      await blockedOnLock(second.pid);
      await first.ok("commit;");
      const two = await pending;
      assert.equal(two.sqlstate, "00000", two.stderr);
      await second.ok("commit;");
      first.close();
      second.close();
      assert.equal(lastLine(one).split("|")[0], "created");
      assert.equal(lastLine(two.rows), "already_requested||");
      const after = evidenceCounts();
      assert.deepEqual(
        Object.fromEntries(
          EVIDENCE_TABLES.map((t) => [t, after[t] - before[t]]),
        ),
        {
          consultation_requests: 1,
          fee_calculations: 1,
          slot_holds: 0,
          eligibility_evaluations: 1,
          bookability_evaluations: 1,
          audit_events: 1,
        },
      );
      report.concurrency.one_referral = {
        waited_on_lock: true,
        outcomes: ["created", "already_requested"],
      };
      return report.concurrency.one_referral;
    },
  );
  await check(
    "CC-2 two clients request the same attorney slot at once: the second waits on the attorney's scheduling lock, then its fresh Bookability sees the first's Hold and it answers not_available (hold_conflict); exactly one Request and one Hold exist, and the loser left no Request, Fee Calculation, Hold, evaluation or audit event",
    async () => {
      const slot = at(6, 10);
      const a = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "scheduled",
      });
      const b = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "scheduled",
      });
      const before = evidenceCounts();
      const first = await clientSession("slot-a", a.client);
      const second = await clientSession("slot-b", b.client);
      const one = await first.ok(
        CREATE({ referral: a.referral, path: "scheduled", slot }),
      );
      const pending = second.send(
        CREATE({ referral: b.referral, path: "scheduled", slot }),
      );
      await blockedOnLock(second.pid);
      await first.ok("commit;");
      const two = await pending;
      assert.equal(two.sqlstate, "00000", two.stderr);
      await second.ok("commit;");
      first.close();
      second.close();
      assert.equal(lastLine(one).split("|")[0], "created");
      assert.equal(lastLine(two.rows), "not_available||hold_conflict");
      const after = evidenceCounts();
      assert.deepEqual(
        Object.fromEntries(
          EVIDENCE_TABLES.map((t) => [t, after[t] - before[t]]),
        ),
        {
          consultation_requests: 1,
          fee_calculations: 1,
          slot_holds: 1,
          eligibility_evaluations: 1,
          bookability_evaluations: 1,
          audit_events: 1,
        },
      );
      assert.equal(
        count("consultation_requests", `referral_id = '${b.referral}'`),
        0,
      );
      report.concurrency.one_slot = {
        waited_on_lock: true,
        outcomes: ["created", "not_available|hold_conflict"],
      };
      return report.concurrency.one_slot;
    },
  );
  await check(
    "CC-3 withdrawal against expiry: (a) a withdrawal holding the attorney's lock makes the due expiry wait, which then finds the Request cancelled and does nothing; (b) an expiry holding the lock makes the withdrawal wait, which then answers expired; each Request reaches exactly one terminal state, its Hold ends once and one audit event records the outcome",
    async () => {
      const raceA = scenario({
        jurisdiction: world.J.D,
        lawyer: world.dot,
        path: "scheduled",
      });
      const raceB = scenario({
        jurisdiction: world.J.D,
        lawyer: world.dot,
        path: "scheduled",
      });
      const withdrawer = await clientSession("withdrawer", raceA.client);
      const expirer = await session("expirer");
      await expirer.ok("begin;");
      const made = create(raceA.client, {
        referral: raceA.referral,
        path: "scheduled",
        slot: at(2, 8),
      });
      assert.equal(made.outcome, "created", made.line);
      const answer = await withdrawer.ok(WITHDRAW(made.request));
      assert.equal(lastLine(answer), "withdrawn");
      await waitUntil(
        readRequest(raceA.client, made.request)[0].response_deadline_at,
      );
      const pending = expirer.send(
        `select public.request_expire_if_due('${made.request}');`,
      );
      await blockedOnLock(expirer.pid);
      await withdrawer.ok("commit;");
      const expiry = await pending;
      assert.equal(expiry.sqlstate, "00000", expiry.stderr);
      assert.equal(lastLine(expiry.rows), "cancelled");
      await expirer.ok("commit;");
      withdrawer.close();
      expirer.close();
      const a = evidenceOf(made.request);
      assert.equal(a.request.state, "cancelled");
      assert.equal(a.hold[0].release_reason, "released");
      assert.deepEqual(
        a.audit.map((e) => e.action),
        ["consultation_request.created", "consultation_request.withdrawn"],
      );
      // (b) The expiry first.
      const madeB = create(raceB.client, {
        referral: raceB.referral,
        path: "scheduled",
        slot: at(2, 12),
      });
      assert.equal(madeB.outcome, "created", madeB.line);
      await waitUntil(
        readRequest(raceB.client, madeB.request)[0].response_deadline_at,
      );
      const expirerB = await session("expirer-b");
      await expirerB.ok("begin;");
      const expired = await expirerB.ok(
        `select public.request_expire_if_due('${madeB.request}');`,
      );
      assert.equal(lastLine(expired), "expired");
      const withdrawerB = await clientSession("withdrawer-b", raceB.client);
      const pendingB = withdrawerB.send(WITHDRAW(madeB.request));
      await blockedOnLock(withdrawerB.pid);
      await expirerB.ok("commit;");
      const late = await pendingB;
      assert.equal(late.sqlstate, "00000", late.stderr);
      assert.equal(lastLine(late.rows), "expired");
      await withdrawerB.ok("commit;");
      expirerB.close();
      withdrawerB.close();
      const b = evidenceOf(madeB.request);
      assert.equal(b.request.state, "expired");
      assert.equal(b.hold.length, 1);
      assert.notEqual(b.hold[0].released_at, null);
      assert.deepEqual(
        b.audit.map((e) => [e.action, e.reason]),
        [
          ["consultation_request.created", null],
          ["consultation_request.expired", "response_deadline_reached"],
        ],
      );
      report.concurrency.withdraw_against_expiry = {
        withdrawal_first: "cancelled (expiry waited, then no-op)",
        expiry_first: "expired (withdrawal waited, then answered expired)",
        hold_release_reasons: [
          a.hold[0].release_reason,
          b.hold[0].release_reason,
        ],
      };
      return report.concurrency.withdraw_against_expiry;
    },
  );
  await check(
    "CC-4 Request creation against the attorney's pending Hold cap (one): two clients request different slots at once; the second waits on the attorney's lock and answers cap_reached; one Request and one Hold exist and the loser left nothing",
    async () => {
      const a = scenario({
        jurisdiction: world.J.C,
        lawyer: world.cy,
        path: "scheduled",
      });
      const b = scenario({
        jurisdiction: world.J.C,
        lawyer: world.cy,
        path: "scheduled",
      });
      const before = evidenceCounts();
      const first = await clientSession("cap-a", a.client);
      const second = await clientSession("cap-b", b.client);
      const one = await first.ok(
        CREATE({ referral: a.referral, path: "scheduled", slot: at(5, 10) }),
      );
      const pending = second.send(
        CREATE({ referral: b.referral, path: "scheduled", slot: at(5, 14) }),
      );
      await blockedOnLock(second.pid);
      await first.ok("commit;");
      const two = await pending;
      assert.equal(two.sqlstate, "00000", two.stderr);
      await second.ok("commit;");
      first.close();
      second.close();
      assert.equal(lastLine(one).split("|")[0], "created");
      assert.equal(lastLine(two.rows), "cap_reached||");
      const after = evidenceCounts();
      assert.equal(
        after.consultation_requests - before.consultation_requests,
        1,
      );
      assert.equal(after.slot_holds - before.slot_holds, 1);
      assert.equal(after.fee_calculations - before.fee_calculations, 1);
      assert.equal(after.audit_events - before.audit_events, 1);
      report.concurrency.hold_cap = {
        waited_on_lock: true,
        outcomes: ["created", "cap_reached"],
      };
      return report.concurrency.hold_cap;
    },
  );
}

// ---------------------------------------------------------------------------
// Authorization and audit
// ---------------------------------------------------------------------------

async function authorizationChecks() {
  await check(
    "AUTH-1 another client's Referral, Request or Intake answers exactly like an unknown one (no row, not_found), an attorney account and a suspended client see nothing and can make nothing, and the P1 row policy shows a client only their own Requests directly (attorneys none)",
    () => {
      const { client, referral, request } = world.req1;
      const stranger = world.stranger;
      for (const id of [request, uid()]) {
        assert.deepEqual(readRequest(stranger, id), []);
        assert.equal(asClient(stranger, WITHDRAW(id)), "not_found");
      }
      for (const id of [referral, uid()]) {
        assert.deepEqual(readReview(stranger, id), []);
        assert.deepEqual(readOptions(stranger, id), []);
        assert.equal(
          preview(stranger, { referral: id, path: "instant" }).outcome,
          "not_found",
        );
      }
      for (const id of [client.intake, uid()]) {
        assert.deepEqual(readIntake(stranger, id), []);
      }
      // An attorney account (no Client Profile).
      assert.deepEqual(readRequest(world.ada, request), []);
      assert.equal(asClient(world.ada, WITHDRAW(request)), "not_found");
      assert.equal(
        preview(world.ada, { referral, path: "instant" }).outcome,
        "not_found",
      );
      // A suspended client.
      const suspended = scenario({
        jurisdiction: world.J.A,
        lawyer: world.ada,
        path: "instant",
      });
      const made = create(suspended.client, {
        referral: suspended.referral,
        path: "instant",
      });
      assert.equal(made.outcome, "created", made.line);
      sql(
        `update public.users set account_state = 'suspended' where id = '${suspended.client.user}';`,
      );
      assert.deepEqual(readRequest(suspended.client, made.request), []);
      assert.equal(
        asClient(suspended.client, WITHDRAW(made.request)),
        "not_found",
      );
      // Direct reads under the P1 row policy.
      assert.equal(
        asClient(
          client,
          `select count(*) from public.consultation_requests where id = '${request}';`,
        ),
        "1",
      );
      assert.equal(
        asClient(
          stranger,
          `select count(*) from public.consultation_requests where id = '${request}';`,
        ),
        "0",
      );
      assert.equal(
        asClient(
          world.ada,
          "select count(*) from public.consultation_requests;",
        ),
        "0",
      );
    },
  );
}

async function auditChecks() {
  await check(
    "AUD-1 audit minimization: each Request creation records exactly one client-actor event with fixed identifier, path, modality, duration, amount and currency keys, its jurisdiction and the eligibility, referral, fee and scheduling policy references; withdrawals and expiries record one event each with fixed keys and a fixed reason; no free text and no other request action exists",
    () => {
      assert.equal(
        sql(
          "select string_agg(distinct (select string_agg(k, ',' order by k) from jsonb_object_keys(after_snapshot) k), ';') from public.audit_events where action_code = 'consultation_request.created';",
        ),
        "attorney_id,attorney_listed_price_minor,bookability_evaluation_id,client_fee_minor,currency_code,duration_minutes,eligibility_evaluation_id,fee_calculation_id,hold_id,intake_id,platform_fee_minor,quote_valid_until,referral_id,request_path,requested_modality,state,tax_or_other_required_fee_minor,total_client_amount_minor",
      );
      assert.equal(
        count(
          "audit_events",
          "action_code = 'consultation_request.created' and (actor_type <> 'client' or actor_user_id is null or before_snapshot is not null or reason_code is not null or jurisdiction_id is null or resource_type <> 'consultation_request')",
        ),
        0,
      );
      assert.equal(
        count(
          "audit_events a",
          "a.action_code = 'consultation_request.created' and not exists (select 1 from jsonb_array_elements(a.policy_references) p where p ->> 'policy_type_code' = 'eligibility') or a.action_code = 'consultation_request.created' and (select string_agg(p ->> 'policy_type_code', ',' order by p ->> 'policy_type_code') from jsonb_array_elements(a.policy_references) p where p ->> 'policy_type_code' <> 'eligibility') <> 'fee,referral,scheduling'",
        ),
        0,
      );
      assert.equal(
        count("audit_events", "action_code = 'consultation_request.created'"),
        count("consultation_requests") - world.ownerRequests,
      );
      assert.equal(
        sql(
          "select string_agg(distinct action_code || ':' || actor_type || ':' || coalesce(reason_code, '') || ':' || (select string_agg(k, ',' order by k) from jsonb_object_keys(after_snapshot) k) || ':' || (select string_agg(k, ',' order by k) from jsonb_object_keys(before_snapshot) k), ';' order by action_code || ':' || actor_type || ':' || coalesce(reason_code, '') || ':' || (select string_agg(k, ',' order by k) from jsonb_object_keys(after_snapshot) k) || ':' || (select string_agg(k, ',' order by k) from jsonb_object_keys(before_snapshot) k)) from public.audit_events where action_code in ('consultation_request.withdrawn', 'consultation_request.expired');",
        ),
        [
          "consultation_request.expired:system:hold_expired:hold_ended,hold_id,state:state",
          "consultation_request.expired:system:quote_expired:hold_ended,hold_id,state:state",
          "consultation_request.expired:system:response_deadline_reached:hold_ended,hold_id,state:state",
          "consultation_request.withdrawn:client:client_withdrawal:hold_ended,hold_id,state:state",
        ].join(";"),
      );
      assert.equal(
        count(
          "audit_events",
          "action_code = 'consultation_request.expired' and actor_user_id is not null",
        ),
        0,
      );
      assert.equal(
        count(
          "audit_events",
          "action_code like 'consultation_request%' and action_code not in ('consultation_request.created', 'consultation_request.withdrawn', 'consultation_request.expired')",
        ),
        0,
      );
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
    await unrecordedChecks();
    sql("select public.record_deployment_environment('development', null);");
    report.environment = sql(
      "select environment_class from public.deployment_environment;",
    );
    seed();
    await inventoryChecks();
    await shippedSeamChecks();
    installTestPriceSource();
    seedOffers();
    expirySetup();
    await pricingChecks();
    await requestChecks();
    await financialChecks();
    await withdrawalChecks();
    await concurrencyChecks();
    await authorizationChecks();
    await expiryChecks();
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
