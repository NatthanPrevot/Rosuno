// MVP-001 S5 disposable PostgreSQL proof (M7 Discovery / Referral).
// Explicitly invoked only:
//
//   node apps/web/tests/mvp-001-s5-db-proof.mjs
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
// one transaction; the three S5 migrations must follow S4 and be registered.
// The database records its environment as development, and every policy
// version used here (eligibility, scheduling, bookability and referral) is
// development configuration created by the owner role inside this disposable
// cluster (Packet rule 9): the values are test values, never product values.
// Every attorney, client, Intake, licence, evidence item and outcome code is
// synthetic test data.
//
// Request sessions are modelled as PostgREST sets them from a verified JWT:
// request.jwt.claim.sub and the JSON request.jwt.claims; anonymous requests
// run as anon without a subject.
//
// The probes cover the MVP-001 Packet S5 acceptance list for the database:
// migration order and registration; no relation, column, type, policy type,
// capability or seed added; privileges (anon may execute exactly the three
// public read functions and holds no table privilege; the referral relations
// are function-only with service_role narrowed to SELECT; every internal
// function is executable by no API role); the public reads expose exactly
// their allowlisted columns and nothing for a non-approved, ineligible,
// suspended, unknown or banned-name attorney, with identical answers for
// unknown and unlisted ids; banned claims are withheld; directory renders
// persist nothing; objective filters, the neutral order and paging; the
// decision-point recorder; the MBS section 10 failure tests (an ineligible
// attorney is never presented as eligible; an unbookable attorney is never
// represented as bookable for the path; no Referral without point-in-time
// evidence, even by the owner role; a decline preserves the Intake; Rosuno
// never silently replaces the client's choice); the Referral evidence
// reconstructs who was eligible, presented and selected, the filters and
// order, and the evaluations; attempt ordinals under real concurrency (two
// persistent sessions for one Intake); outcomes recorded once and only from
// configured codes; immutability for every role; guessed identifiers; and
// audit minimization. No Supabase project, network service, or pre-existing
// cluster is contacted, nothing persists after the run. The JSON report goes
// to stdout; exit 0 means PASS, 1 FAIL, 2 cleanup failure.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertRegisteredLifecycle,
  assertTailThenRegistered,
} from "./migration-lifecycle.mjs";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54340;
const DB = "rosuno_s5_proof";
const REPOSITORY_ROOT = path.resolve(
  path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
  "../../..",
);
const MIGRATIONS = path.join(REPOSITORY_ROOT, "supabase/migrations");
const S4_LAST = "20261120030000_mvp_001_s4_holds_bookability.sql";
const S5_MIGRATIONS = Object.freeze([
  "20261121010000_mvp_001_s5_referral_integrity.sql",
  "20261121020000_mvp_001_s5_discovery.sql",
  "20261121030000_mvp_001_s5_referral.sql",
]);

const report = {
  proof: "MVP-001 S5 disposable local PostgreSQL proof",
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
    path.join(os.tmpdir(), "rosuno-mvp-001-s5-db-proof-"),
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
  // S5 follows S4, contiguous and in order, and every S5 migration is
  // registered in a consistent lifecycle state. MVP-001 S6: then exactly the
  // three S6 migrations, contiguous and in order; MVP-001 S6 PS-A3: then
  // exactly the PS-A3 migration; MVP-001 S7: then exactly the two S7
  // migrations; MVP-001 S8: then exactly the three S8 migrations; MVP-001 S9:
  // then exactly the three S9 migrations; MVP-001 S10: then exactly the five
  // S10 migrations.
  const s4 = files.indexOf(S4_LAST);
  assert.ok(s4 >= 0, "the last S4 migration is present");
  assert.deepEqual(files.slice(s4 + 1, s4 + 1 + S5_MIGRATIONS.length), [
    ...S5_MIGRATIONS,
  ]);
  assertTailThenRegistered(files.slice(s4 + 1 + S5_MIGRATIONS.length), [
    "20261122010000_mvp_001_s6_request_integrity.sql",
    "20261122020000_mvp_001_s6_pricing.sql",
    "20261122030000_mvp_001_s6_requests.sql",
    "20261122040000_mvp_001_s6_consultation_offers.sql",
    "20261123010000_mvp_001_s7_payment_integrity.sql",
    "20261123020000_mvp_001_s7_payment_engine.sql",
    "20261124010000_mvp_001_s8_decision_integrity.sql",
    "20261124020000_mvp_001_s8_attorney_decision.sql",
    "20261124030000_mvp_001_s8_change_review.sql",
    "20261125010000_mvp_001_s9_media_integrity.sql",
    "20261125020000_mvp_001_s9_consultation_media.sql",
    "20261125030000_mvp_001_s9_media_evidence.sql",
    "20261126010000_mvp_001_s10_communication_integrity.sql",
    "20261126020000_mvp_001_s10_notifications.sql",
    "20261126030000_mvp_001_s10_messages.sql",
    "20261126040000_mvp_001_s10_documents.sql",
    // MVP-001 S10 (PS-A5): the document version lineage.
    "20261126050000_mvp_001_s10_document_versioning.sql",
    // MVP-001 S11: the seven S11 migrations (registered and checked by the
    // S11 proof).
    "20261127010000_mvp_001_s11_completion_integrity.sql",
    "20261127020000_mvp_001_s11_completion.sql",
    "20261127030000_mvp_001_s11_exception_families.sql",
    "20261127040000_mvp_001_s11_reviews.sql",
    "20261127050000_mvp_001_s11_legal_holds.sql",
    "20261127060000_mvp_001_s11_complaints.sql",
    "20261127070000_mvp_001_s11_notification_events.sql",
    // MVP-001 S11 pass 2: the nine operations and administration
    // migrations (registered and checked by the S11 operations proof).
    "20261127080000_mvp_001_s11_operations_integrity.sql",
    "20261127090000_mvp_001_s11_audit_workspace.sql",
    "20261127100000_mvp_001_s11_operations_dashboard.sql",
    "20261127110000_mvp_001_s11_attorney_operations.sql",
    "20261127120000_mvp_001_s11_client_administration.sql",
    "20261127130000_mvp_001_s11_referral_finance_reads.sql",
    "20261127140000_mvp_001_s11_policy_corrections.sql",
    "20261127150000_mvp_001_s11_capture_gate.sql",
    "20261127160000_mvp_001_s11_definer_search_path.sql",
    // MVP-001 S11 pass 2B: the participants' workspace reads (registered
    // and checked by the S11 operations proof).
    "20261127170000_mvp_001_s11_workspace_reads.sql",
    // MVP-001 S11 review corrections (registered and checked by the S11
    // operations proof).
    "20261127180000_mvp_001_s11_review_corrections.sql",
    // MVP-001 S11 PS-A6: break-glass, data requests and the complaint
    // configuration (registered and checked by the S11 PS-A6 proof).
    "20261127190000_mvp_001_s11_break_glass.sql",
    "20261127200000_mvp_001_s11_data_requests.sql",
    "20261127210000_mvp_001_s11_complaint_configuration.sql",
    // MVP-001 S11: the offered-start correction (registered and checked by
    // the S6 proof).
    "20261127220000_mvp_001_s11_offered_start_containment.sql",
  ], S5_MIGRATIONS.at(-1));
  const workItems = JSON.parse(
    fs.readFileSync(
      path.join(REPOSITORY_ROOT, "governance/work-items/index.json"),
      "utf8",
    ),
  ).work_items;
  const program = workItems.find(
    (item) => item.work_item_id === "WI-P2-MVP-001-TECHNICAL-COMPLETION",
  );
  for (const file of S5_MIGRATIONS) {
    const id = file.replace(/\.sql$/, "");
    const row = registered.find(
      (migration) => migration.artifact_path === `supabase/migrations/${file}`,
    );
    assert.ok(row, `${file} is registered`);
    assert.equal(row.migration_id, id);
    assertRegisteredLifecycle(row);
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
    if (S5_MIGRATIONS.includes(file)) {
      notices[file] = [...result.stderr.matchAll(/NOTICE:\s+(.*)/g)].map(
        (match) => match[1],
      );
    }
  }
  report.migrations.applied = files.length;
  report.migrations.s5 = [...S5_MIGRATIONS];
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
    const mark = `__S5_${this.label}_${this.n}__`;
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
    process.stderr.write(`[s5-proof] PASS ${name}\n`);
  } catch (error) {
    failed = true;
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
    process.stderr.write(`[s5-proof] FAIL ${name}\n${error?.stack ?? error}\n`);
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

function newPracticeArea(code, active = true) {
  const id = uid();
  sql(
    `insert into public.practice_areas (id, code, name, active) values ('${id}', '${code}', 'Synthetic area ${code}', ${active});`,
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

const SCHEDULING = Object.freeze({
  hold_response_window_seconds: 900,
  hold_pre_slot_interval_seconds: 300,
  pending_hold_cap: 50,
  minimum_notice_seconds: 3600,
});

let licenceNumber = 0;

// One synthetic attorney: User, Attorney Profile, optional licence with
// verification evidence in each given jurisdiction, optional practice-area
// authorisations, and optional all-day availability (UTC, every weekday).
function attorney({
  name,
  headline = null,
  bio = null,
  years = 7,
  profileState = "approved",
  accountState = "active",
  jurisdictions = [],
  evidenceAgeHours = 1,
  areas = [],
  available = true,
} = {}) {
  const account = newAccount(accountState);
  const profile = uid();
  sql(
    `insert into public.attorney_profiles (id, user_id, profile_state, display_name, headline, bio, years_experience) values ('${profile}', '${account.user}', '${profileState}', ${lit(name)}, ${lit(headline)}, ${lit(bio)}, ${years === null ? "null" : years});`,
  );
  const licences = [];
  for (const jurisdiction of jurisdictions) {
    licenceNumber += 1;
    const licence = uid();
    const evidence = uid();
    const number = `SYN-S5-LIC-${String(licenceNumber).padStart(4, "0")}`;
    sql(
      `insert into public.licenses (id, attorney_id, jurisdiction_id, license_number, reported_status) values ('${licence}', '${profile}', '${jurisdiction}', '${number}', 'synthetic-active');
       insert into public.verification_evidence (id, jurisdiction_id, source_type, source_reference, retrieved_at, retrieved_by_user_id, evidence_summary, verification_method, discrepancy_flag)
         values ('${evidence}', '${jurisdiction}', 'synthetic register', 'synthetic entry', now() - interval '${evidenceAgeHours} hours', '${world.staff.user}', 'synthetic evidence', 'synthetic lookup', false);
       insert into public.verification_evidence_subjects (verification_evidence_id, license_id) values ('${evidence}', '${licence}');`,
    );
    licences.push({ licence, number, evidence });
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
  return { ...account, profile, name, licences };
}

// A live application session and an Instant intent for the attorney, as the
// S4 functions would have recorded them (owner fixture). expired: the intent's
// server lease has already passed.
function instant(lawyer, { expired = false } = {}) {
  const session = uid();
  sql(
    `insert into public.application_sessions (id, user_id, auth_session_reference, started_at, expires_at) values ('${session}', '${lawyer.user}', '${sha256(session)}', now() - interval '1 hour', now() + interval '2 hours');
     insert into public.instant_availability_intents (attorney_id, application_session_id, enabled_at, expires_at)
       values ('${lawyer.profile}', '${session}', ${expired ? "now() - interval '30 minutes'" : "now()"}, ${expired ? "now() - interval '20 minutes'" : "now() + interval '1 hour'"});`,
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
  for (const state of states) {
    const intake = uid();
    sql(
      `insert into public.intakes (id, client_id, state, closed_at) values ('${intake}', '${client}', '${state}', ${state === "closed" ? "now()" : "null"});`,
    );
    intakes[state] = intake;
  }
  return { ...account, client, intakes, intake: intakes[states[0]] };
}

const asClient = (client, statement) =>
  as("authenticated", client.auth, statement, { aal: "aal1" });

const CREATE = ({
  intake,
  attorney: lawyer,
  jurisdiction,
  area = null,
  path: requestPath = "scheduled",
  availability = "any",
  page = 1,
}) =>
  `select outcome || '|' || coalesce(referral_id::text, '') from public.referral_create(${lit(intake)}, ${lit(lawyer)}, ${lit(jurisdiction)}, ${lit(area)}, ${lit(requestPath)}, ${lit(availability)}, ${page === null ? "null" : page});`;

function create(client, options) {
  const line = asClient(client, CREATE(options));
  const [outcome, referral] = line.split("|");
  return { outcome, referral: referral || null, line };
}

function directory(jurisdiction, area, availability, page, role = "anon") {
  return rowsAs(
    role,
    role === "anon" ? null : world.client1.auth,
    `select row_to_json(d)::text from public.public_attorney_directory(${lit(jurisdiction)}, ${lit(area)}, ${lit(availability)}, ${page === null ? "null" : page}) d;`,
  ).map((line) => JSON.parse(line));
}

function profileOf(attorneyId, jurisdiction, role = "anon") {
  return rowsAs(
    role,
    role === "anon" ? null : world.client1.auth,
    `select row_to_json(p)::text from public.public_attorney_profile(${lit(attorneyId)}, ${lit(jurisdiction)}) p;`,
  ).map((line) => JSON.parse(line));
}

function filters(role = "anon") {
  return rowsAs(
    role,
    role === "anon" ? null : world.client1.auth,
    "select row_to_json(f)::text from public.public_discovery_filters() f;",
  ).map((line) => JSON.parse(line));
}

const EVIDENCE_TABLES = Object.freeze([
  "referrals",
  "referral_eligible_pool_entries",
  "referral_presentations",
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

// A Referral with complete point-in-time evidence written directly by the
// owner role (fixture for owner-path probes): one eligible evaluation, a pool
// entry, a presentation and a bookable Bookability Evaluation, each in the
// same transaction as the Referral. omit drops pieces for failure probes.
function ownerReferralSql({
  referral,
  intake,
  attorney: lawyer,
  jurisdiction,
  ordinal,
  omit = [],
  bookability = "bookable",
  evaluation = null,
}) {
  const evaluationId = evaluation ?? uid();
  const lines = [
    `insert into public.referrals (id, intake_id, attorney_id, jurisdiction_id, attempt_ordinal, allocation_method) values ('${referral}', '${intake}', '${lawyer}', '${jurisdiction}', ${ordinal}, 'client_selected');`,
  ];
  if (evaluation === null) {
    lines.push(
      `insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, context_id, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${evaluationId}', '${lawyer}', '${jurisdiction}', 'jurisdiction', null, now(), '[]'::jsonb, 'eligible', '[]'::jsonb, '{}'::jsonb, now());`,
    );
  }
  if (!omit.includes("pool")) {
    lines.push(
      `insert into public.referral_eligible_pool_entries (referral_id, attorney_id, eligibility_evaluation_id, eligible_as_of) values ('${referral}', '${lawyer}', '${evaluationId}', (select as_of from public.eligibility_evaluations where id = '${evaluationId}'));`,
    );
  }
  if (!omit.includes("presentation")) {
    lines.push(
      `insert into public.referral_presentations (referral_id, attorney_id, display_position, narrowing_actor, shown_at) values ('${referral}', '${lawyer}', 1, 'platform', now());`,
    );
  }
  if (!omit.includes("bookability")) {
    lines.push(
      `insert into public.bookability_evaluations (attorney_id, eligibility_evaluation_id, context_type, context_id, evaluated_at, as_of, modality, constraint_results, result) values ('${lawyer}', '${evaluationId}', 'referral', '${referral}', now(), now(), 'synthetic', '[]'::jsonb, '${bookability}');`,
    );
  }
  return lines.join("\n");
}

function seed() {
  world.ownerReferrals = 0;
  world.J = {
    A: newJurisdiction("SYN_S5_A"),
    B: newJurisdiction("SYN_S5_B"),
    C: newJurisdiction("SYN_S5_C"),
    D: newJurisdiction("SYN_S5_D"),
    M: newJurisdiction("SYN_S5_M"),
  };
  world.PA = {
    one: newPracticeArea("SYN_S5_ONE"),
    two: newPracticeArea("SYN_S5_TWO"),
    off: newPracticeArea("SYN_S5_OFF", false),
  };
  // Eligibility policies in A, B, D and M; C deliberately has none (nobody is
  // eligible there, so nobody is listed). Scheduling only in A and D.
  world.policies = {
    eligibilityA: policy("eligibility", world.J.A, ELIGIBILITY),
    eligibilityB: policy("eligibility", world.J.B, ELIGIBILITY),
    eligibilityD: policy("eligibility", world.J.D, ELIGIBILITY),
    eligibilityM: policy("eligibility", world.J.M, ELIGIBILITY),
    schedulingA: policy("scheduling", world.J.A, SCHEDULING),
    schedulingD: policy("scheduling", world.J.D, SCHEDULING),
    bookability: policy("bookability", null, { presence_window_seconds: 600 }),
    // The referral outcome taxonomy is regulatory-gated configuration:
    // synthetic test codes only, in A; B has no referral policy; M has a
    // malformed one.
    referralA: policy("referral", world.J.A, {
      outcome_codes: ["synthetic_declined", "synthetic_withdrawn"],
    }),
    referralM: policy("referral", world.J.M, {
      outcome_codes: "synthetic_declined",
    }),
  };
  const A = [world.J.A];
  world.adam = attorney({
    name: "adam Synthetic",
    headline: "Synthetic headline",
    bio: "Synthetic biography text.",
    jurisdictions: A,
    areas: [world.PA.one],
  });
  world.zed = attorney({
    name: "Zed Synthetic",
    headline: "The Right Lawyer for You!",
    bio: "Our AI-selected attorney for you.",
    jurisdictions: A,
    areas: [world.PA.one, world.PA.two],
  });
  world.mia = attorney({
    name: "Mia Synthetic",
    jurisdictions: A,
    areas: [],
  });
  world.instantAtty = attorney({
    name: "Ivy Synthetic",
    jurisdictions: A,
    areas: [world.PA.one],
  });
  instant(world.instantAtty);
  world.lapsed = attorney({
    name: "Lee Synthetic",
    jurisdictions: A,
    areas: [world.PA.one],
  });
  instant(world.lapsed, { expired: true });
  world.busy = attorney({
    name: "Bea Synthetic",
    jurisdictions: A,
  });
  sql(
    `insert into public.blackouts (attorney_id, starts_at, ends_at, reason_code) values ('${world.busy.profile}', now() - interval '1 hour', now() + interval '20 days', 'synthetic_leave');`,
  );
  world.unavailable = attorney({
    name: "Uma Synthetic",
    jurisdictions: A,
    available: false,
  });
  // Eligible but never listed: a banned display name and no display name.
  world.banned = attorney({
    name: "Best Attorney Synthetic",
    jurisdictions: A,
  });
  world.nameless = attorney({ name: null, jurisdictions: A });
  // Never eligible: stale evidence (undetermined), an applicant, a suspended
  // profile, a removed profile, a suspended account, no licence in A.
  world.stale = attorney({
    name: "Sal Synthetic",
    jurisdictions: A,
    evidenceAgeHours: 24 * 40,
  });
  world.applicant = attorney({
    name: "App Synthetic",
    profileState: "applicant",
    jurisdictions: A,
  });
  world.suspendedProfile = attorney({
    name: "Sus Synthetic",
    profileState: "suspended",
    jurisdictions: A,
  });
  world.removedProfile = attorney({
    name: "Rem Synthetic",
    profileState: "removed",
    jurisdictions: A,
  });
  world.suspendedAccount = attorney({
    name: "Acc Synthetic",
    accountState: "suspended",
    jurisdictions: A,
  });
  world.elsewhere = attorney({ name: "Eli Synthetic", jurisdictions: [] });
  // B: listed, Instant on, no scheduling policy there.
  world.bob = attorney({ name: "Bob Synthetic", jurisdictions: [world.J.B] });
  instant(world.bob);
  // C: licensed, but C has no eligibility policy.
  world.cal = attorney({ name: "Cal Synthetic", jurisdictions: [world.J.C] });
  // D: 23 listed attorneys for paging.
  world.paged = [];
  for (let i = 1; i <= 23; i += 1) {
    world.paged.push(
      attorney({
        name: `Page Synthetic ${String(i).padStart(2, "0")}`,
        jurisdictions: [world.J.D],
        available: false,
      }),
    );
  }
  // M: two attorneys for owner-path probes.
  world.max = attorney({ name: "Max Synthetic", jurisdictions: [world.J.M] });
  world.tia = attorney({ name: "Tia Synthetic", jurisdictions: [world.J.M] });
  world.client1 = newClient(["submitted", "active", "draft", "closed"]);
  world.client2 = newClient(["submitted"]);
  world.client3 = newClient(["active"]);
  world.client4 = newClient(["submitted"]);
  world.attorneyCaller = world.adam;
}

// ---------------------------------------------------------------------------
// Inventory and privileges
// ---------------------------------------------------------------------------

const P1_COLUMNS = Object.freeze({
  referrals:
    "id,intake_id,attorney_id,jurisdiction_id,attempt_ordinal,allocation_method,outcome_code,created_at,outcome_recorded_at",
  referral_eligible_pool_entries:
    "id,referral_id,attorney_id,eligibility_evaluation_id,eligible_as_of,pool_reason,created_at",
  referral_presentations:
    "id,referral_id,attorney_id,display_position,client_filter_context,platform_presentation_filter_context,narrowing_actor,shown_at,created_at",
  eligibility_evaluations:
    "id,attorney_id,jurisdiction_id,context_type,context_id,evaluated_at,policy_references,result,factor_results,evidence_references,as_of,created_at",
  attorney_profiles:
    "id,user_id,display_name,bio,headline,years_experience,response_expectation_seconds,profile_state,created_at,updated_at",
});

const REFERRAL_RELATIONS = Object.freeze([
  "referrals",
  "referral_eligible_pool_entries",
  "referral_presentations",
]);

// Public reads: anon and authenticated, security definer, stable, exact
// result columns (the allowlist).
const PUBLIC_FUNCTIONS = Object.freeze({
  "public_discovery_filters()":
    "TABLE(filter_kind text, id uuid, code text, name text)",
  "public_attorney_directory(uuid, uuid, text, integer)":
    "TABLE(display_position integer, attorney_id uuid, display_name text, headline text, years_experience smallint, practice_areas text[], available_now boolean, has_scheduled_availability boolean, more_after boolean)",
  "public_attorney_profile(uuid, uuid)":
    "TABLE(attorney_id uuid, display_name text, headline text, bio text, years_experience smallint, jurisdictions jsonb, practice_areas text[], available_now boolean, upcoming_windows jsonb)",
});

// Client functions: authenticated only, security definer.
const CLIENT_FUNCTIONS = Object.freeze({
  "referral_create(uuid, uuid, uuid, uuid, text, text, integer)":
    "v|search_path=pg_catalog, pg_temp;lock_timeout=3s|TABLE(outcome text, referral_id uuid)",
  "client_referrals(uuid)":
    "s|search_path=pg_catalog, pg_temp|TABLE(attempt_ordinal integer, created_at timestamp with time zone, attorney_display_name text, request_path text, outcome_code text)",
});

// Internal building blocks and guards: executable by no API role. The two
// deferred evidence checks are security definer (they run at commit under
// whatever role the transaction has); every other one is security invoker.
const INTERNAL_FUNCTIONS = Object.freeze({
  "eligibility_record_decision_point(uuid, uuid, uuid, timestamptz)": false,
  "discovery_presentable_text(text)": false,
  "discovery_available_now(uuid)": false,
  "scheduling_offered_windows(uuid, uuid, integer)": false,
  "discovery_presented_set(uuid, uuid, text, uuid)": false,
  "discovery_practice_area_names(uuid, uuid)": false,
  "discovery_jurisdiction_listed(uuid)": false,
  "scheduling_evaluate_scheduled_availability(uuid, uuid, text, uuid, text)": false,
  "referral_record_outcome(uuid, text)": false,
  "referral_integrity()": false,
  "referral_evidence_append_only()": false,
  "referral_pool_entry_consistency()": false,
  "referral_presentation_consistency()": false,
  "referral_evidence_with_referral()": true,
  "referral_point_in_time_evidence()": true,
  "eligibility_evaluation_append_only()": false,
});

async function unrecordedChecks() {
  await check(
    "ENV-1 in an unrecorded environment no eligibility policy is selectable (the engine reports environment_unrecorded), so nothing is listed and the public reads answer no row",
    () => {
      const j = newJurisdiction("SYN_S5_U");
      const lawyer = attorney({ name: "Una Synthetic", jurisdictions: [j] });
      assert.equal(
        sql(
          `select public.eligibility_assessment('${lawyer.profile}', '${j}', null, now()) -> 'factor_results' -> 2 ->> 'reason';`,
        ),
        "environment_unrecorded",
      );
      assert.deepEqual(directory(j, null, "any", 1), []);
      assert.deepEqual(profileOf(lawyer.profile, null), []);
      assert.deepEqual(
        filters().filter((f) => f.filter_kind === "jurisdiction"),
        [],
      );
    },
  );
}

async function inventoryChecks() {
  await check(
    "MIG-1 the three S5 migrations follow S4 in order (MVP-001 S6: then only the three S6 migrations and, MVP-001 S6 PS-A3, the PS-A3 migration), are registered in a consistent lifecycle state, are Program migration refs, and apply on plain PostgreSQL",
    () => {
      for (const file of S5_MIGRATIONS) {
        assert.deepEqual(report.migrations.notices[file], [], file);
      }
      return { applied: report.migrations.applied };
    },
  );
  await check(
    "MIG-2 no relation, column, enum type, policy type, capability or seed row is added: the P1 columns of the referral relations, eligibility evaluations and attorney profiles are unchanged and the S5 migration texts create none",
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
      for (const file of S5_MIGRATIONS) {
        const text = fs
          .readFileSync(path.join(MIGRATIONS, file), "utf8")
          .replace(/--[^\n]*/g, "");
        assert.doesNotMatch(
          text,
          /create\s+table|add\s+column|create\s+type|create\s+policy|insert\s+into\s+public\.(policy_types|policy_versions|capability_definitions|capability_grants|deployment_environment|jurisdictions|practice_areas)/i,
          file,
        );
      }
      // MVP-001 S11 PS-A6 adds exactly one policy type, complaint (registered
      // and checked by the S11 PS-A6 proof).
      assert.equal(count("policy_types"), 16);
      assert.equal(count("policy_types", "code = 'complaint'"), 1);
      assert.equal(
        sql(
          "select count(*) from pg_policies where schemaname = 'public' and tablename in ('referrals', 'referral_eligible_pool_entries', 'referral_presentations');",
        ),
        "0",
      );
    },
  );
  await check(
    "PRIV-1 the referral relations are function-only: anon and authenticated hold no privilege, service_role only SELECT (no column-level write either), RLS stays enabled with no policy; eligibility evaluations keep SELECT only",
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
      for (const table of [...REFERRAL_RELATIONS, "eligibility_evaluations"]) {
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
      for (const table of REFERRAL_RELATIONS) {
        expected[`anon:${table}`] = "";
        expected[`authenticated:${table}`] = "";
        expected[`service_role:${table}`] = "SELECT";
      }
      expected["anon:eligibility_evaluations"] = "";
      expected["authenticated:eligibility_evaluations"] = "SELECT";
      expected["service_role:eligibility_evaluations"] = "SELECT";
      assert.deepEqual(observed, expected);
      for (const table of REFERRAL_RELATIONS) {
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
    "PRIV-2 anon may execute exactly the three public read functions (MVP-001 S6 PS-A3: and the PS-A3 public offer read, public_attorney_offers) and holds no privilege on any table, view or sequence of the public schema",
    () => {
      const executable = sql(
        "select string_agg(p.oid::regprocedure::text, ';' order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE');",
      ).split(";");
      // MVP-001 S6 PS-A3 (20261122040000): the public offer read is the one
      // further anon function (inventoried by the S6 proofs).
      // MVP-001 S11 (20261127040000): and exactly the public read of an
      // attorney's published reviews (inventoried by the S11 proof).
      // DEV-001: website & appearance studio (20261130010000): and exactly the
      // two public reads of the published appearance (inventoried by the
      // DEV-001 site appearance proof).
      const expected = [
        ...Object.keys(PUBLIC_FUNCTIONS),
        "public_attorney_offers(uuid, uuid)",
        "public_attorney_reviews(uuid)",
        "public_site_appearance()",
        "public_site_appearance_asset(text)",
      ]
        .map((signature) =>
          sql(`select 'public.${signature}'::regprocedure::text;`),
        )
        .sort();
      assert.deepEqual(executable, expected);
      assert.equal(
        sql(
          `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as pr(p)
           where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p', 'f') and has_table_privilege('anon', c.oid, pr.p);`,
        ),
        "0",
      );
      assert.equal(
        sql(
          "select count(*) from (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'S' offset 0) as s where has_sequence_privilege('anon', s.oid, 'USAGE');",
        ),
        "0",
      );
      return { anon_executable: executable };
    },
  );
  await check(
    "PRIV-3 function inventory: the three public reads are stable security definer functions with search_path pinned, executable by anon and authenticated only, with exactly their allowlisted result columns; referral_create and client_referrals are security definer, executable by authenticated only (lock_timeout on the write); every internal building block and guard is executable by no API role nor a PUBLIC-only role, with search_path pinned; every function S5 comments as its own is listed",
    () => {
      sql("create role s5_probe nologin;");
      for (const [signature, result] of Object.entries(PUBLIC_FUNCTIONS)) {
        assert.equal(
          sql(
            `select prosecdef::text || '|' || provolatile::text || '|' || array_to_string(proconfig, ';') || '|' || pg_get_userbyid(proowner) || '|' || pg_get_function_result(oid) from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          `true|s|search_path=pg_catalog, pg_temp|postgres|${result}`,
          signature,
        );
        for (const [role, allowed] of [
          ["anon", "t"],
          ["authenticated", "t"],
          ["service_role", "f"],
          ["s5_probe", "f"],
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
          ["s5_probe", "f"],
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
      for (const [signature, definer] of Object.entries(INTERNAL_FUNCTIONS)) {
        assert.equal(
          sql(
            `select prosecdef::text || '|' || array_to_string(proconfig, ';') from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          `${definer}|search_path=pg_catalog, pg_temp`,
          signature,
        );
        for (const role of [
          "anon",
          "authenticated",
          "service_role",
          "s5_probe",
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
        "select string_agg(p.oid::regprocedure::text, ';' order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and obj_description(p.oid, 'pg_proc') like 'MVP-001 S5%';",
      ).split(";");
      const listed = [
        ...Object.keys(PUBLIC_FUNCTIONS),
        ...Object.keys(CLIENT_FUNCTIONS),
        ...Object.keys(INTERNAL_FUNCTIONS),
      ].map((signature) =>
        sql(`select 'public.${signature}'::regprocedure::text;`),
      );
      assert.deepEqual([...commented].sort(), [...listed].sort());
      sql("drop role s5_probe;");
      return {
        public_functions: Object.keys(PUBLIC_FUNCTIONS).length,
        client_functions: Object.keys(CLIENT_FUNCTIONS).length,
        internal_functions: Object.keys(INTERNAL_FUNCTIONS).length,
      };
    },
  );
  await check(
    "PRIV-4 anon cannot call any client or internal S5 function, and direct DML by authenticated or service_role on every referral relation is refused (42501)",
    () => {
      for (const statement of [
        CREATE({
          intake: world.client1.intake,
          attorney: world.adam.profile,
          jurisdiction: world.J.A,
        }),
        `select * from public.client_referrals('${world.client1.intake}');`,
        `select * from public.referral_record_outcome('${uid()}', 'synthetic_declined');`,
        `select * from public.eligibility_record_decision_point('${world.adam.profile}', '${world.J.A}', null, now());`,
        `select * from public.discovery_presented_set('${world.J.A}', null, 'any', null);`,
      ]) {
        assert.equal(as("anon", null, statement), "ERROR 42501", statement);
      }
      for (const role of ["authenticated", "service_role"]) {
        const sub = role === "authenticated" ? world.client1.auth : null;
        for (const statement of [
          `insert into public.referrals (intake_id, attorney_id, jurisdiction_id, attempt_ordinal, allocation_method) values ('${world.client1.intake}', '${world.adam.profile}', '${world.J.A}', 99, 'client_selected');`,
          "update public.referrals set outcome_code = 'synthetic_declined', outcome_recorded_at = now();",
          "delete from public.referral_presentations;",
          "delete from public.referral_eligible_pool_entries;",
          "truncate public.referrals;",
          `select * from public.eligibility_record_decision_point('${world.adam.profile}', '${world.J.A}', null, now());`,
        ]) {
          assert.equal(
            as(role, sub, statement),
            "ERROR 42501",
            `${role}: ${statement}`,
          );
        }
      }
      assert.equal(
        as(
          "authenticated",
          world.client1.auth,
          "select count(*) from public.referrals;",
        ),
        "ERROR 42501",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Public discovery
// ---------------------------------------------------------------------------

const LISTED_A = () =>
  [
    world.adam,
    world.busy,
    world.instantAtty,
    world.lapsed,
    world.mia,
    world.unavailable,
    world.zed,
  ].sort((x, y) =>
    x.name.toLowerCase() < y.name.toLowerCase()
      ? -1
      : x.name.toLowerCase() > y.name.toLowerCase()
        ? 1
        : 0,
  );

const NEVER_LISTED = () => [
  world.banned,
  world.nameless,
  world.stale,
  world.applicant,
  world.suspendedProfile,
  world.removedProfile,
  world.suspendedAccount,
  world.elsewhere,
];

async function discoveryChecks() {
  await check(
    "PUB-1 the filter catalog lists exactly the jurisdictions where an attorney is listed now (A, B, D, M; not C, which has no eligibility policy) and the active practice areas (not the inactive one), with id, code and name only",
    () => {
      const rows = filters();
      for (const row of rows) {
        assert.deepEqual(Object.keys(row), [
          "filter_kind",
          "id",
          "code",
          "name",
        ]);
      }
      assert.deepEqual(
        rows.filter((r) => r.filter_kind === "jurisdiction").map((r) => r.code),
        ["SYN_S5_A", "SYN_S5_B", "SYN_S5_D", "SYN_S5_M"],
      );
      assert.deepEqual(
        rows
          .filter((r) => r.filter_kind === "practice_area")
          .map((r) => r.code),
        ["SYN_S5_ONE", "SYN_S5_TWO"],
      );
      assert.deepEqual(filters("authenticated"), rows);
    },
  );
  await check(
    "PUB-2 the directory lists exactly the approved, active, eligible attorneys with a presentable name, in the neutral order display_name_then_id (case-folded), with the allowlisted fields only; banned headlines are withheld (null), never rewritten; practice areas are the authorised, eligible ones",
    () => {
      const rows = directory(world.J.A, null, "any", 1);
      const expected = LISTED_A();
      assert.deepEqual(
        rows.map((r) => r.attorney_id),
        expected.map((a) => a.profile),
      );
      assert.deepEqual(
        rows.map((r) => r.display_position),
        expected.map((_a, i) => i + 1),
      );
      for (const row of rows) {
        assert.deepEqual(Object.keys(row), [
          "display_position",
          "attorney_id",
          "display_name",
          "headline",
          "years_experience",
          "practice_areas",
          "available_now",
          "has_scheduled_availability",
          "more_after",
        ]);
        assert.equal(row.more_after, false);
      }
      const byId = Object.fromEntries(rows.map((r) => [r.attorney_id, r]));
      assert.equal(byId[world.adam.profile].headline, "Synthetic headline");
      assert.equal(byId[world.zed.profile].headline, null);
      assert.equal(byId[world.zed.profile].display_name, "Zed Synthetic");
      assert.deepEqual(byId[world.zed.profile].practice_areas, [
        "Synthetic area SYN_S5_ONE",
        "Synthetic area SYN_S5_TWO",
      ]);
      assert.deepEqual(byId[world.mia.profile].practice_areas, []);
      for (const never of NEVER_LISTED()) {
        assert.equal(byId[never.profile], undefined, never.name);
      }
      assert.deepEqual(directory(world.J.A, null, "any", 2), []);
      assert.deepEqual(directory(world.J.C, null, "any", 1), []);
      assert.deepEqual(directory(uid(), null, "any", 1), []);
      for (const [availability, page] of [
        ["any", 0],
        ["any", 26],
        ["any", null],
        ["anything", 1],
        [null, 1],
      ]) {
        assert.deepEqual(
          directory(world.J.A, null, availability, page),
          [],
          `${availability} ${page}`,
        );
      }
      assert.deepEqual(directory(world.J.A, world.PA.off, "any", 1), []);
      assert.deepEqual(directory(world.J.A, uid(), "any", 1), []);
      assert.deepEqual(
        directory(world.J.A, null, "any", 1, "authenticated"),
        rows,
      );
      return { listed: rows.map((r) => r.display_name) };
    },
  );
  await check(
    "PUB-3 objective filters only: a practice area keeps exactly the attorneys eligible in that practice-area context (an authorisation is required by this test policy), instant keeps exactly those Available Now (a live Instant intent with Presence; a lapsed lease is not), scheduled keeps exactly those with an offered window (not the fully blacked-out attorney, not the one without availability rules, nobody in B without a scheduling policy)",
    () => {
      const ids = (rows) => rows.map((r) => r.attorney_id);
      assert.deepEqual(
        ids(directory(world.J.A, world.PA.one, "any", 1)),
        LISTED_A()
          .filter((a) =>
            [world.adam, world.instantAtty, world.lapsed, world.zed].includes(
              a,
            ),
          )
          .map((a) => a.profile),
      );
      assert.deepEqual(ids(directory(world.J.A, world.PA.two, "any", 1)), [
        world.zed.profile,
      ]);
      assert.deepEqual(ids(directory(world.J.A, null, "instant", 1)), [
        world.instantAtty.profile,
      ]);
      const all = directory(world.J.A, null, "any", 1);
      for (const row of all) {
        assert.equal(
          row.available_now,
          row.attorney_id === world.instantAtty.profile,
          row.display_name,
        );
        assert.equal(
          row.has_scheduled_availability,
          ![world.busy.profile, world.unavailable.profile].includes(
            row.attorney_id,
          ),
          row.display_name,
        );
      }
      assert.deepEqual(
        ids(directory(world.J.A, null, "scheduled", 1)),
        all
          .filter((r) => r.has_scheduled_availability)
          .map((r) => r.attorney_id),
      );
      const b = directory(world.J.B, null, "any", 1);
      assert.deepEqual(ids(b), [world.bob.profile]);
      assert.equal(b[0].has_scheduled_availability, false);
      assert.equal(b[0].available_now, true);
      assert.deepEqual(directory(world.J.B, null, "scheduled", 1), []);
    },
  );
  await check(
    "PUB-4 paging: 20 per page in order, contiguous positions, more_after only while a further page exists, and an empty page beyond",
    () => {
      const first = directory(world.J.D, null, "any", 1);
      const second = directory(world.J.D, null, "any", 2);
      assert.equal(first.length, 20);
      assert.equal(second.length, 3);
      assert.ok(first.every((r) => r.more_after === true));
      assert.ok(second.every((r) => r.more_after === false));
      assert.deepEqual(
        [...first, ...second].map((r) => r.display_position),
        Array.from({ length: 23 }, (_v, i) => i + 1),
      );
      assert.deepEqual(
        [...first, ...second].map((r) => r.display_name),
        world.paged.map((a) => a.name),
      );
      assert.deepEqual(directory(world.J.D, null, "any", 3), []);
    },
  );
  await check(
    "PUB-5 a public profile shows exactly the allowlisted fields, the listed jurisdictions (id, code, name), the practice areas, Available Now and up to five offered windows (UTC, in the 14-day horizon, after the minimum notice, never overlapping a Blackout); banned headline or bio text is withheld",
    () => {
      const [adam] = profileOf(world.adam.profile, world.J.A);
      assert.deepEqual(Object.keys(adam), [
        "attorney_id",
        "display_name",
        "headline",
        "bio",
        "years_experience",
        "jurisdictions",
        "practice_areas",
        "available_now",
        "upcoming_windows",
      ]);
      assert.equal(adam.attorney_id, world.adam.profile);
      assert.equal(adam.bio, "Synthetic biography text.");
      assert.deepEqual(adam.jurisdictions, [
        { id: world.J.A, code: "SYN_S5_A", name: "Synthetic SYN_S5_A" },
      ]);
      assert.deepEqual(Object.keys(adam.jurisdictions[0]).sort(), [
        "code",
        "id",
        "name",
      ]);
      assert.deepEqual(adam.practice_areas, ["Synthetic area SYN_S5_ONE"]);
      assert.equal(adam.available_now, false);
      assert.ok(adam.upcoming_windows.length >= 1);
      assert.ok(adam.upcoming_windows.length <= 5);
      const now = Date.now();
      for (const window of adam.upcoming_windows) {
        assert.deepEqual(Object.keys(window).sort(), ["ends_at", "starts_at"]);
        assert.ok(Date.parse(window.starts_at) >= now + 3600 * 1000 - 5000);
        assert.ok(Date.parse(window.ends_at) <= now + 14 * 86400000 + 5000);
        assert.ok(Date.parse(window.starts_at) < Date.parse(window.ends_at));
      }
      const [zed] = profileOf(world.zed.profile, world.J.A);
      assert.equal(zed.headline, null);
      assert.equal(zed.bio, null);
      const [busy] = profileOf(world.busy.profile, world.J.A);
      assert.deepEqual(busy.upcoming_windows, []);
      const [ivy] = profileOf(world.instantAtty.profile, null);
      assert.equal(ivy.available_now, true);
      assert.deepEqual(ivy.upcoming_windows, []);
      assert.deepEqual(ivy.practice_areas, ["Synthetic area SYN_S5_ONE"]);
    },
  );
  await check(
    "PUB-6 guessed and unlisted identifiers answer identically: an unknown id, every never-listed attorney, a listed attorney asked for a jurisdiction where it is not listed, and a malformed call all answer no row",
    () => {
      const answers = [
        profileOf(uid(), null),
        profileOf(uid(), world.J.A),
        profileOf(null, world.J.A),
        profileOf(world.adam.profile, world.J.B),
        profileOf(world.adam.profile, uid()),
        profileOf(world.cal.profile, world.J.C),
        ...NEVER_LISTED().map((a) => profileOf(a.profile, world.J.A)),
        ...NEVER_LISTED().map((a) => profileOf(a.profile, null)),
      ];
      for (const answer of answers) {
        assert.deepEqual(answer, []);
      }
    },
  );
  await check(
    "PUB-7 no protected data on public reads: no licence number, verification evidence, User or Auth id, policy or evaluation detail, referral, client or Intake identifier appears in any public answer",
    () => {
      const text = JSON.stringify([
        filters(),
        directory(world.J.A, null, "any", 1),
        directory(world.J.D, null, "any", 1),
        ...LISTED_A().map((a) => profileOf(a.profile, world.J.A)),
        ...LISTED_A().map((a) => profileOf(a.profile, null)),
      ]);
      const forbidden = [];
      for (const lawyer of [...LISTED_A(), ...NEVER_LISTED(), ...world.paged]) {
        forbidden.push(lawyer.user, lawyer.auth);
        for (const licence of lawyer.licences) {
          forbidden.push(licence.licence, licence.number, licence.evidence);
        }
      }
      for (const client of [world.client1, world.client2]) {
        forbidden.push(client.user, client.auth, client.client, client.intake);
      }
      forbidden.push(...Object.values(world.policies), world.staff.user);
      for (const value of forbidden) {
        assert.equal(text.includes(value), false, value);
      }
      assert.doesNotMatch(
        text,
        /synthetic-active|synthetic register|synthetic evidence|eligibility_|factor|policy_version|SYN-S5-LIC|@/,
      );
    },
  );
  await check(
    "PUB-8 directory renders persist nothing (TA section 55): the public reads are stable, and no evaluation, Referral, presentation or audit row is written by any of them",
    () => {
      const before = evidenceCounts();
      filters();
      directory(world.J.A, world.PA.one, "instant", 1);
      directory(world.J.A, null, "scheduled", 1);
      profileOf(world.adam.profile, world.J.A);
      profileOf(world.adam.profile, null);
      assert.deepEqual(evidenceCounts(), before);
      for (const signature of Object.keys(PUBLIC_FUNCTIONS)) {
        assert.equal(
          sql(
            `select provolatile from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          "s",
        );
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Decision-point eligibility
// ---------------------------------------------------------------------------

async function recorderChecks() {
  await check(
    "REC-1 the decision-point recorder appends exactly one Eligibility Evaluation equal to the adopted engine's derivation (jurisdiction and practice-area contexts), and refuses a malformed call or an unverifiable attorney without writing",
    () => {
      const outputs = acceptedThenRolledBack(
        `select row_to_json(d)::text from public.eligibility_record_decision_point('${world.adam.profile}', '${world.J.A}', null, now()) d;
         select row_to_json(d)::text from public.eligibility_record_decision_point('${world.adam.profile}', '${world.J.A}', '${world.PA.two}', now()) d;
         select row_to_json(d)::text from public.eligibility_record_decision_point('${world.stale.profile}', '${world.J.A}', null, now()) d;
         select json_agg(json_build_object('context_type', context_type, 'context_id', context_id, 'result', result, 'policy', policy_references, 'evidence', evidence_references) order by result, context_type)::text from public.eligibility_evaluations where xmin = pg_current_xact_id()::xid;
         select (public.eligibility_assessment('${world.adam.profile}', '${world.J.A}', null, now()) -> 'evidence_references')::text;`,
      ).split("\n");
      const [jurisdiction, practice, stale, rows, evidence] = outputs.map((l) =>
        JSON.parse(l),
      );
      assert.equal(jurisdiction.result, "eligible");
      assert.equal(practice.result, "not_eligible");
      assert.equal(stale.result, "undetermined");
      assert.equal(rows.length, 3);
      assert.deepEqual(
        rows.map((r) => [r.context_type, r.result]),
        [
          ["jurisdiction", "eligible"],
          ["practice_area", "not_eligible"],
          ["jurisdiction", "undetermined"],
        ],
      );
      assert.deepEqual(rows[0].evidence, evidence);
      assert.equal(rows[1].context_id, world.PA.two);
      assert.equal(
        rows[0].policy[0].policy_version_id,
        world.policies.eligibilityA,
      );
      const before = count("eligibility_evaluations");
      for (const [args, answer] of [
        [
          `'${world.adam.profile}', '${world.J.A}', null, now() - interval '1 hour'`,
          "invalid",
        ],
        [
          `'${world.adam.profile}', '${world.J.A}', null, now() + interval '1 hour'`,
          "invalid",
        ],
        [
          `'${world.adam.profile}', '${world.J.A}', '${uid()}', now()`,
          "invalid",
        ],
        [`'${world.adam.profile}', '${uid()}', null, now()`, "invalid"],
        [`null, '${world.J.A}', null, now()`, "invalid"],
        [`'${uid()}', '${world.J.A}', null, now()`, "unverifiable"],
      ]) {
        assert.equal(
          sql(
            `select coalesce(evaluation_id::text, '-') || '|' || result from public.eligibility_record_decision_point(${args});`,
          ),
          `-|${answer}`,
          args,
        );
      }
      assert.equal(count("eligibility_evaluations"), before);
    },
  );
}

// ---------------------------------------------------------------------------
// Referral creation
// ---------------------------------------------------------------------------

async function referralChecks() {
  await check(
    "REF-1 a client's selection creates one client_selected Referral (ordinal 1) whose evidence reconstructs who was eligible (the pool: every candidate evaluated afresh, the eligible ones only, eligible_as_of their evaluation's instant), who was presented (the re-derived page in the neutral order with the client and platform filter contexts and per-filter attribution), who was selected, and the fresh eligibility and Bookability for the chosen path (modality 'unselected'); the Intake state is unchanged; one minimal audit event",
    () => {
      const before = evidenceCounts();
      const intakeBefore = sql(
        `select row_to_json(i)::text from public.intakes i where id = '${world.client1.intake}';`,
      );
      const made = create(world.client1, {
        intake: world.client1.intake,
        attorney: world.adam.profile,
        jurisdiction: world.J.A,
        path: "scheduled",
      });
      assert.equal(made.outcome, "created", made.line);
      world.ref1 = made.referral;
      const referral = jsonOf(
        `select row_to_json(r)::text from public.referrals r where id = '${made.referral}';`,
      );
      assert.equal(referral.intake_id, world.client1.intake);
      assert.equal(referral.attorney_id, world.adam.profile);
      assert.equal(referral.jurisdiction_id, world.J.A);
      assert.equal(referral.attempt_ordinal, 1);
      assert.equal(referral.allocation_method, "client_selected");
      assert.equal(referral.outcome_code, null);
      // Who was eligible: every licensed approved candidate in A was
      // evaluated afresh; the pool holds exactly the eligible ones.
      const pool = jsonOf(
        `select json_agg(json_build_object('attorney', p.attorney_id, 'result', e.result, 'as_of_match', p.eligible_as_of = e.as_of, 'context', e.context_type, 'reason', p.pool_reason) order by p.attorney_id)::text
         from public.referral_eligible_pool_entries p join public.eligibility_evaluations e on e.id = p.eligibility_evaluation_id where p.referral_id = '${made.referral}';`,
      );
      const eligible = [...LISTED_A(), world.banned, world.nameless]
        .map((a) => a.profile)
        .sort();
      assert.deepEqual(
        pool.map((p) => p.attorney),
        eligible,
      );
      assert.ok(pool.every((p) => p.result === "eligible" && p.as_of_match));
      assert.ok(pool.every((p) => p.context === "jurisdiction"));
      // The candidates evaluated: approved profiles of active users with a
      // licence in A (the stale one included, evaluated undetermined).
      const evaluated = Number(
        sql(
          `select count(*) from public.eligibility_evaluations e where e.jurisdiction_id = '${world.J.A}' and e.as_of = (select eligible_as_of from public.referral_eligible_pool_entries where referral_id = '${made.referral}' limit 1);`,
        ),
      );
      assert.equal(evaluated, eligible.length + 1);
      // Who was presented: the page re-derived in order, with its contexts.
      const presented = jsonOf(
        `select json_agg(json_build_object('attorney', attorney_id, 'position', display_position, 'actor', narrowing_actor, 'client', client_filter_context, 'platform', platform_presentation_filter_context) order by display_position)::text
         from public.referral_presentations where referral_id = '${made.referral}';`,
      );
      assert.deepEqual(
        presented.map((p) => p.attorney),
        LISTED_A().map((a) => a.profile),
      );
      assert.deepEqual(
        presented.map((p) => p.position),
        LISTED_A().map((_a, i) => i + 1),
      );
      assert.ok(presented.every((p) => p.actor === "platform"));
      assert.deepEqual(presented[0].client, {
        jurisdiction_id: world.J.A,
        practice_area_id: null,
        availability: "any",
        remaining_after: { practice_area: 7, availability: 7 },
      });
      assert.deepEqual(presented[0].platform, {
        derivation: "rederived_at_selection",
        eligibility: "pool_eligible_at_selection",
        profile_state: "approved",
        account_state: "active",
        display_name: "presentable",
        order: "display_name_then_id",
        page: 1,
        page_size: 20,
        candidate_bound: 500,
        evaluated: eligible.length + 1,
        pool_size: eligible.length,
        presentable: 7,
        listed: 7,
      });
      // Fresh Bookability for the scheduled path, based on the selected
      // attorney's pool evaluation.
      const bookability = jsonOf(
        `select json_agg(json_build_object('result', b.result, 'modality', b.modality, 'slot', b.slot_start_at, 'presence', b.presence_observed, 'basis', b.availability_basis ->> 'request_path', 'window', b.availability_basis ? 'window_start', 'factors', (select json_agg(f ->> 'factor') from jsonb_array_elements(b.constraint_results) f), 'pooled', b.eligibility_evaluation_id = (select eligibility_evaluation_id from public.referral_eligible_pool_entries where referral_id = r.id and attorney_id = r.attorney_id)))::text
         from public.referrals r join public.bookability_evaluations b on b.context_type = 'referral' and b.context_id = r.id where r.id = '${made.referral}';`,
      );
      assert.deepEqual(bookability, [
        {
          result: "bookable",
          modality: "unselected",
          slot: null,
          presence: null,
          basis: "scheduled",
          window: true,
          factors: ["eligibility", "scheduling_policy", "offered_window"],
          pooled: true,
        },
      ]);
      const after = evidenceCounts();
      assert.equal(after.referrals, before.referrals + 1);
      assert.equal(
        after.referral_eligible_pool_entries -
          before.referral_eligible_pool_entries,
        eligible.length,
      );
      assert.equal(
        after.referral_presentations - before.referral_presentations,
        7,
      );
      assert.equal(
        after.eligibility_evaluations - before.eligibility_evaluations,
        eligible.length + 1,
      );
      assert.equal(
        after.bookability_evaluations - before.bookability_evaluations,
        1,
      );
      assert.equal(after.audit_events - before.audit_events, 1);
      assert.equal(
        sql(
          `select row_to_json(i)::text from public.intakes i where id = '${world.client1.intake}';`,
        ),
        intakeBefore,
      );
      return { pool: eligible.length, presented: presented.length };
    },
  );
  await check(
    "REF-2 the instant path needs a live Instant intent with Presence and not being in a Consultation; a practice-area filter records a fresh practice-area-context evaluation for the selected attorney; a client filter beyond the jurisdiction makes the client the narrowing actor",
    () => {
      const made = create(world.client3, {
        intake: world.client3.intake,
        attorney: world.instantAtty.profile,
        jurisdiction: world.J.A,
        area: world.PA.one,
        path: "instant",
        availability: "instant",
      });
      assert.equal(made.outcome, "created", made.line);
      world.ref3 = made.referral;
      const row = jsonOf(
        `select json_build_object('result', b.result, 'presence', b.presence_observed, 'intent', b.instant_intent_observed, 'context', e.context_type, 'context_id', e.context_id, 'eligible', e.result, 'factors', (select json_agg(f ->> 'factor') from jsonb_array_elements(b.constraint_results) f))::text
         from public.bookability_evaluations b join public.eligibility_evaluations e on e.id = b.eligibility_evaluation_id where b.context_type = 'referral' and b.context_id = '${made.referral}';`,
      );
      assert.deepEqual(row, {
        result: "bookable",
        presence: true,
        intent: true,
        context: "practice_area",
        context_id: world.PA.one,
        eligible: "eligible",
        factors: ["eligibility", "instant_intent", "presence", "consultation"],
      });
      const presented = jsonOf(
        `select json_agg(json_build_object('attorney', attorney_id, 'actor', narrowing_actor, 'client', client_filter_context) order by display_position)::text from public.referral_presentations where referral_id = '${made.referral}';`,
      );
      assert.deepEqual(
        presented.map((p) => p.attorney),
        [world.instantAtty.profile],
      );
      assert.equal(presented[0].actor, "client");
      assert.deepEqual(presented[0].client, {
        jurisdiction_id: world.J.A,
        practice_area_id: world.PA.one,
        availability: "instant",
        remaining_after: { practice_area: 4, availability: 1 },
      });
    },
  );
  await check(
    "REF-3 outcomes: invalid (malformed arguments), not_found (no Client Profile, another client's Intake, an unknown Intake: answered alike), intake_not_ready (draft, closed, expired) and not_available (an unknown, ineligible, unlisted, unpresented or self attorney, an inactive or unknown practice area, an unknown jurisdiction, a page that does not present the attorney, a filter that excludes it, an unbookable path); none of them writes anything",
    () => {
      const base = {
        intake: world.client1.intakes.active,
        attorney: world.adam.profile,
        jurisdiction: world.J.A,
      };
      const before = evidenceCounts();
      const cases = [
        [world.client1, { ...base, path: "later" }, "invalid"],
        [world.client1, { ...base, availability: "best" }, "invalid"],
        [world.client1, { ...base, page: 0 }, "invalid"],
        [world.client1, { ...base, page: 26 }, "invalid"],
        [world.client1, { ...base, page: null }, "invalid"],
        [world.client1, { ...base, intake: null }, "invalid"],
        [world.client1, { ...base, attorney: null }, "invalid"],
        [world.client1, { ...base, jurisdiction: null }, "invalid"],
        [world.attorneyCaller, base, "not_found"],
        [world.client2, base, "not_found"],
        [world.client1, { ...base, intake: world.client2.intake }, "not_found"],
        [world.client1, { ...base, intake: uid() }, "not_found"],
        [
          world.client1,
          { ...base, intake: world.client1.intakes.draft },
          "intake_not_ready",
        ],
        [
          world.client1,
          { ...base, intake: world.client1.intakes.closed },
          "intake_not_ready",
        ],
        [world.client1, { ...base, attorney: uid() }, "not_available"],
        [
          world.client1,
          { ...base, attorney: world.stale.profile },
          "not_available",
        ],
        [
          world.client1,
          { ...base, attorney: world.applicant.profile },
          "not_available",
        ],
        [
          world.client1,
          { ...base, attorney: world.suspendedAccount.profile },
          "not_available",
        ],
        [
          world.client1,
          { ...base, attorney: world.banned.profile },
          "not_available",
        ],
        [
          world.client1,
          { ...base, attorney: world.nameless.profile },
          "not_available",
        ],
        [
          world.client1,
          { ...base, attorney: world.elsewhere.profile },
          "not_available",
        ],
        [
          world.client1,
          { ...base, attorney: world.cal.profile, jurisdiction: world.J.C },
          "not_available",
        ],
        [world.client1, { ...base, jurisdiction: uid() }, "not_available"],
        [world.client1, { ...base, area: world.PA.off }, "not_available"],
        [world.client1, { ...base, area: uid() }, "not_available"],
        [world.client1, { ...base, area: world.PA.two }, "not_available"],
        [world.client1, { ...base, availability: "instant" }, "not_available"],
        [world.client1, { ...base, page: 2 }, "not_available"],
        [world.client1, { ...base, path: "instant" }, "not_available"],
        [
          world.client1,
          { ...base, attorney: world.busy.profile },
          "not_available",
        ],
        [
          world.client1,
          { ...base, attorney: world.unavailable.profile },
          "not_available",
        ],
        [
          world.client1,
          { ...base, attorney: world.lapsed.profile, path: "instant" },
          "not_available",
        ],
        [
          world.client1,
          { ...base, attorney: world.bob.profile, jurisdiction: world.J.B },
          "not_available",
        ],
      ];
      for (const [caller, options, outcome] of cases) {
        const made = create(caller, options);
        assert.equal(
          made.outcome,
          outcome,
          `${JSON.stringify(options)} -> ${made.line}`,
        );
        assert.equal(made.referral, null);
      }
      assert.deepEqual(evidenceCounts(), before);
      // A self-selection (the caller's own Attorney Profile) is refused too.
      const dual = newClient(["submitted"]);
      const self = uid();
      sql(
        `insert into public.attorney_profiles (id, user_id, profile_state, display_name) values ('${self}', '${dual.user}', 'approved', 'Self Synthetic');`,
      );
      assert.equal(
        create(dual, { ...base, intake: dual.intake, attorney: self }).outcome,
        "not_available",
      );
      // An expired Intake: its expiry is evaluated first and it is refused;
      // the expiry itself is the system's, audited as before.
      const expiring = newClient(["active"]);
      sql(
        `update public.intakes set expires_at = now() - interval '1 second' where id = '${expiring.intake}';`,
      );
      assert.equal(
        create(expiring, { ...base, intake: expiring.intake }).outcome,
        "intake_not_ready",
      );
      assert.equal(
        sql(
          `select state from public.intakes where id = '${expiring.intake}';`,
        ),
        "expired",
      );
      assert.equal(count("referrals", `intake_id = '${expiring.intake}'`), 0);
    },
  );
  await check(
    "REF-4 MBS section 10 failure test: an ineligible attorney can never be presented as eligible, even by the owner role (a pool entry needs an eligible evaluation of that attorney in the Referral's jurisdiction recorded with it; a presentation needs a pool entry)",
    () => {
      const referral = uid();
      const ineligible = uid();
      const prefix = `insert into public.referrals (id, intake_id, attorney_id, jurisdiction_id, attempt_ordinal, allocation_method) values ('${referral}', '${world.client4.intake}', '${world.stale.profile}', '${world.J.A}', 1, 'client_selected');
        insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${ineligible}', '${world.stale.profile}', '${world.J.A}', 'jurisdiction', now(), '[]', 'undetermined', '[]', '{}', now());`;
      assert.equal(
        refused(
          `${prefix} insert into public.referral_eligible_pool_entries (referral_id, attorney_id, eligibility_evaluation_id, eligible_as_of) values ('${referral}', '${world.stale.profile}', '${ineligible}', now());`,
        ),
        "23514",
      );
      assert.equal(
        refused(
          `${prefix} insert into public.referral_presentations (referral_id, attorney_id, display_position, narrowing_actor, shown_at) values ('${referral}', '${world.stale.profile}', 1, 'platform', now());`,
        ),
        "23514",
      );
      // Another attorney's or another jurisdiction's eligible evaluation, a
      // mismatched instant, or an evaluation from an earlier transaction.
      const other = uid();
      const elsewhere = uid();
      sql(
        `insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values
          ('${other}', '${world.adam.profile}', '${world.J.A}', 'jurisdiction', now(), '[]', 'eligible', '[]', '{}', now()),
          ('${elsewhere}', '${world.stale.profile}', '${world.J.B}', 'jurisdiction', now(), '[]', 'eligible', '[]', '{}', now());`,
      );
      const plain = `insert into public.referrals (id, intake_id, attorney_id, jurisdiction_id, attempt_ordinal, allocation_method) values ('${referral}', '${world.client4.intake}', '${world.adam.profile}', '${world.J.A}', 1, 'client_selected');`;
      for (const [evaluation, lawyer] of [
        [other, world.stale.profile],
        [elsewhere, world.stale.profile],
        [other, world.adam.profile],
      ]) {
        assert.equal(
          refused(
            `${plain} insert into public.referral_eligible_pool_entries (referral_id, attorney_id, eligibility_evaluation_id, eligible_as_of) values ('${referral}', '${lawyer}', '${evaluation}', (select as_of from public.eligibility_evaluations where id = '${evaluation}'));`,
          ),
          "23514",
          `${evaluation} ${lawyer}`,
        );
      }
      const fresh = uid();
      assert.equal(
        refused(
          `${plain} insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${fresh}', '${world.adam.profile}', '${world.J.A}', 'jurisdiction', now(), '[]', 'eligible', '[]', '{}', now() - interval '1 minute');
           insert into public.referral_eligible_pool_entries (referral_id, attorney_id, eligibility_evaluation_id, eligible_as_of) values ('${referral}', '${world.adam.profile}', '${fresh}', now());`,
        ),
        "23514",
      );
      // And the referral command never presents one.
      for (const lawyer of [
        world.stale,
        world.applicant,
        world.suspendedProfile,
      ]) {
        assert.equal(
          count("referral_presentations", `attorney_id = '${lawyer.profile}'`),
          0,
        );
        assert.equal(
          count(
            "referral_eligible_pool_entries",
            `attorney_id = '${lawyer.profile}'`,
          ),
          0,
        );
      }
    },
  );
  await check(
    "REF-5 MBS section 10 failure test: an unbookable attorney is never represented as currently bookable for the selected path: a lapsed Instant lease shows not Available Now and the instant path is refused; a fully blacked-out attorney shows no scheduled availability and the scheduled path is refused; when the lease lapses after the page was shown, the selection is refused on fresh evaluation",
    () => {
      const row = (lawyer, jurisdiction = world.J.A) =>
        directory(jurisdiction, null, "any", 1).find(
          (r) => r.attorney_id === lawyer.profile,
        );
      assert.equal(row(world.lapsed).available_now, false);
      assert.equal(row(world.busy).has_scheduled_availability, false);
      const before = evidenceCounts();
      const client = newClient(["submitted"]);
      // The page shows Lia (in B) Available Now; then her lease is revoked
      // (as the S4 sign-out would do) before the client confirms.
      const late = attorney({
        name: "Lia Synthetic",
        jurisdictions: [world.J.B],
      });
      const session = instant(late);
      assert.equal(row(late, world.J.B).available_now, true);
      sql(
        `update public.instant_availability_intents set revoked_at = now() where application_session_id = '${session}';`,
      );
      assert.equal(
        create(client, {
          intake: client.intake,
          attorney: late.profile,
          jurisdiction: world.J.B,
          path: "instant",
          availability: "instant",
        }).outcome,
        "not_available",
      );
      for (const [lawyer, requestPath] of [
        [world.lapsed, "instant"],
        [world.busy, "scheduled"],
      ]) {
        assert.equal(
          create(client, {
            intake: client.intake,
            attorney: lawyer.profile,
            jurisdiction: world.J.A,
            path: requestPath,
          }).outcome,
          "not_available",
        );
      }
      const after = evidenceCounts();
      assert.equal(row(late, world.J.B).available_now, false);
      assert.equal(after.referrals, before.referrals);
      assert.equal(
        after.bookability_evaluations,
        before.bookability_evaluations,
      );
      assert.equal(
        count(
          "bookability_evaluations",
          `context_type = 'referral' and result = 'bookable' and attorney_id in ('${world.lapsed.profile}', '${world.busy.profile}', '${late.profile}')`,
        ),
        0,
      );
    },
  );
  await check(
    "REF-6 MBS section 10 failure test: a Referral cannot be created without point-in-time evaluation evidence, even by the owner role: alone, without a pool entry, without a Bookability Evaluation, with a not_bookable one, with one from another transaction, client_selected without the presentation, without an attorney or an allocation method; and nothing can be added to a Referral afterwards",
    () => {
      const base = {
        intake: world.client4.intake,
        attorney: world.max.profile,
        jurisdiction: world.J.M,
        ordinal: 1,
      };
      const failing = [
        [{ omit: ["pool", "presentation", "bookability"] }, "alone"],
        [{ omit: ["pool", "presentation"] }, "no pool"],
        [{ omit: ["bookability"] }, "no bookability"],
        [{ bookability: "not_bookable" }, "not bookable"],
        [{ omit: ["presentation"] }, "no presentation"],
      ];
      for (const [variant, label] of failing) {
        const sqlText = ownerReferralSql({
          referral: uid(),
          ...base,
          ...variant,
        });
        assert.equal(refused(sqlText), "23514", label);
      }
      // The presentation needs its pool entry first (immediate check).
      assert.equal(
        refused(ownerReferralSql({ referral: uid(), ...base, omit: ["pool"] })),
        "23514",
      );
      assert.equal(
        refused(
          `insert into public.referrals (intake_id, attorney_id, jurisdiction_id, attempt_ordinal, allocation_method) values ('${world.client4.intake}', null, '${world.J.M}', 1, 'client_selected');`,
        ),
        "23514",
      );
      assert.equal(
        refused(
          `insert into public.referrals (intake_id, attorney_id, jurisdiction_id, attempt_ordinal) values ('${world.client4.intake}', '${world.max.profile}', '${world.J.M}', 1);`,
        ),
        "23514",
      );
      // A Bookability Evaluation recorded by an earlier transaction for a
      // guessed Referral id does not count.
      const referral = uid();
      const early = uid();
      sql(
        `insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${early}', '${world.max.profile}', '${world.J.M}', 'jurisdiction', now(), '[]', 'eligible', '[]', '{}', now());
         insert into public.bookability_evaluations (attorney_id, eligibility_evaluation_id, context_type, context_id, evaluated_at, as_of, modality, constraint_results, result) values ('${world.max.profile}', '${early}', 'referral', '${referral}', now(), now(), 'synthetic', '[]', 'bookable');`,
      );
      assert.equal(
        refused(ownerReferralSql({ referral, ...base, omit: ["bookability"] })),
        "23514",
      );
      // With complete evidence the owner fixture commits (Tia is in its pool
      // but not presented).
      world.refM = uid();
      const tiaEvaluation = uid();
      sql(
        [
          "begin;",
          ownerReferralSql({ referral: world.refM, ...base }),
          `insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${tiaEvaluation}', '${world.tia.profile}', '${world.J.M}', 'jurisdiction', now(), '[]', 'eligible', '[]', '{}', now());
           insert into public.referral_eligible_pool_entries (referral_id, attorney_id, eligibility_evaluation_id, eligible_as_of) values ('${world.refM}', '${world.tia.profile}', '${tiaEvaluation}', now());`,
          "commit;",
        ].join("\n"),
      );
      world.ownerReferrals += 1;
      // Nothing is added afterwards: a presentation of a pool attorney is
      // refused at commit, and a pool entry with a later evaluation at once.
      assert.equal(
        refused(
          `insert into public.referral_presentations (referral_id, attorney_id, display_position, narrowing_actor, shown_at) values ('${world.refM}', '${world.tia.profile}', 2, 'platform', now());`,
        ),
        "23514",
      );
      const later = uid();
      const third = attorney({
        name: "Teo Synthetic",
        jurisdictions: [world.J.M],
      });
      assert.equal(
        refused(
          `insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${later}', '${third.profile}', '${world.J.M}', 'jurisdiction', now(), '[]', 'eligible', '[]', '{}', now());
           insert into public.referral_eligible_pool_entries (referral_id, attorney_id, eligibility_evaluation_id, eligible_as_of) values ('${world.refM}', '${third.profile}', '${later}', now());`,
        ),
        "23514",
      );
      // Even recorded in the same transaction as an outcome, evidence for an
      // existing Referral is refused.
      assert.equal(
        refused(
          `update public.referrals set outcome_code = 'synthetic_declined', outcome_recorded_at = now() where id = '${world.refM}';
           insert into public.referral_presentations (referral_id, attorney_id, display_position, narrowing_actor, shown_at) values ('${world.refM}', '${world.tia.profile}', 2, 'platform', now());`,
        ),
        "23514",
      );
    },
  );
  await check(
    "REF-7 MBS section 10 failure tests: a decline preserves the Intake (an outcome recorded on attempt 1 changes neither the Intake nor attempt 1's evidence, and the client's next selection is attempt 2) and Rosuno never silently selects a replacement (a refused selection creates no Referral for anyone; every Referral names exactly the attorney the client chose)",
    () => {
      const intakeBefore = sql(
        `select row_to_json(i)::text from public.intakes i where id = '${world.client1.intake}';`,
      );
      const evidenceBefore = sql(
        `select json_build_object('pool', (select json_agg(row_to_json(p) order by p.id) from public.referral_eligible_pool_entries p where p.referral_id = '${world.ref1}'), 'presented', (select json_agg(row_to_json(p) order by p.id) from public.referral_presentations p where p.referral_id = '${world.ref1}'))::text;`,
      );
      assert.equal(
        sql(
          `select outcome from public.referral_record_outcome('${world.ref1}', 'synthetic_declined');`,
        ),
        "recorded",
      );
      assert.equal(
        sql(
          `select row_to_json(i)::text from public.intakes i where id = '${world.client1.intake}';`,
        ),
        intakeBefore,
      );
      assert.equal(
        sql(
          `select json_build_object('pool', (select json_agg(row_to_json(p) order by p.id) from public.referral_eligible_pool_entries p where p.referral_id = '${world.ref1}'), 'presented', (select json_agg(row_to_json(p) order by p.id) from public.referral_presentations p where p.referral_id = '${world.ref1}'))::text;`,
        ),
        evidenceBefore,
      );
      const before = count("referrals");
      // The client's next choice is unavailable: nothing is created and no
      // other attorney is chosen in its place.
      assert.equal(
        create(world.client1, {
          intake: world.client1.intake,
          attorney: world.busy.profile,
          jurisdiction: world.J.A,
        }).outcome,
        "not_available",
      );
      assert.equal(count("referrals"), before);
      const second = create(world.client1, {
        intake: world.client1.intake,
        attorney: world.zed.profile,
        jurisdiction: world.J.A,
        area: world.PA.two,
        availability: "scheduled",
      });
      assert.equal(second.outcome, "created", second.line);
      world.ref2 = second.referral;
      assert.equal(
        sql(
          `select attempt_ordinal || '|' || attorney_id from public.referrals where id = '${second.referral}';`,
        ),
        `2|${world.zed.profile}`,
      );
      assert.equal(
        count(
          "referrals r",
          `not exists (select 1 from public.audit_events a where a.resource_id = r.id and a.action_code = 'referral.created' and a.after_snapshot ->> 'attorney_id' = r.attorney_id::text) and r.id <> '${world.refM}'`,
        ),
        0,
      );
      // The attempt list shows both attempts, the first with its outcome.
      assert.deepEqual(
        rowsAs(
          "authenticated",
          world.client1.auth,
          `select attempt_ordinal || '|' || coalesce(attorney_display_name, '-') || '|' || coalesce(request_path, '-') || '|' || coalesce(outcome_code, '-') from public.client_referrals('${world.client1.intake}');`,
        ),
        [
          "1|adam Synthetic|scheduled|synthetic_declined",
          "2|Zed Synthetic|scheduled|-",
        ],
      );
    },
  );
  await check(
    "REF-8 the client's attempt list returns exactly the caller's own Intake's attempts with the five fixed columns; another client's, an unknown or a null Intake answer no row; attorneys see nothing of Referrals",
    () => {
      assert.deepEqual(
        rowsAs(
          "authenticated",
          world.client3.auth,
          `select row_to_json(r)::text from public.client_referrals('${world.client3.intake}') r;`,
        ).map((l) => Object.keys(JSON.parse(l))),
        [
          [
            "attempt_ordinal",
            "created_at",
            "attorney_display_name",
            "request_path",
            "outcome_code",
          ],
        ],
      );
      assert.deepEqual(
        rowsAs(
          "authenticated",
          world.client3.auth,
          `select request_path from public.client_referrals('${world.client3.intake}');`,
        ),
        ["instant"],
      );
      for (const [caller, intake] of [
        [world.client2, world.client1.intake],
        [world.client1, world.client3.intake],
        [world.client1, uid()],
        [world.client1, null],
        [world.adam, world.client1.intake],
      ]) {
        assert.deepEqual(
          rowsAs(
            "authenticated",
            caller.auth,
            `select attempt_ordinal from public.client_referrals(${lit(intake)});`,
          ),
          [],
        );
      }
      for (const table of REFERRAL_RELATIONS) {
        assert.equal(
          as(
            "authenticated",
            world.adam.auth,
            `select count(*) from public.${table};`,
          ),
          "ERROR 42501",
        );
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

async function concurrencyChecks() {
  await check(
    "CC-1 attempt ordinals under real concurrency: two sessions select attorneys for one Intake at once; the second waits on the first's locks, then both commit as consecutive ordinals with no duplicate and each with its own complete evidence",
    async () => {
      const client = newClient(["submitted"]);
      const claims = JSON.stringify({
        sub: client.auth,
        role: "authenticated",
        aal: "aal1",
      });
      const open = async (label) => {
        const s = await session(label);
        await s.ok("begin;");
        await s.ok("set local role authenticated;");
        await s.ok(
          `select set_config('request.jwt.claim.sub', ${lit(client.auth)}, true) is not null;`,
        );
        await s.ok(
          `select set_config('request.jwt.claims', ${lit(claims)}, true) is not null;`,
        );
        return s;
      };
      const first = await open("first");
      const second = await open("second");
      const one = await first.ok(
        CREATE({
          intake: client.intake,
          attorney: world.adam.profile,
          jurisdiction: world.J.A,
        }),
      );
      const pending = second.send(
        CREATE({
          intake: client.intake,
          attorney: world.mia.profile,
          jurisdiction: world.J.A,
        }),
      );
      await blockedOnLock(second.pid);
      await first.ok("commit;");
      const two = await pending;
      assert.equal(two.sqlstate, "00000", two.stderr);
      await second.ok("commit;");
      first.close();
      second.close();
      const outcomes = [one[one.length - 1], two.rows[two.rows.length - 1]].map(
        (line) => line.split("|")[0],
      );
      assert.deepEqual(outcomes, ["created", "created"]);
      const rows = jsonOf(
        `select json_agg(json_build_object('ordinal', r.attempt_ordinal, 'attorney', r.attorney_id, 'pool', (select count(*) from public.referral_eligible_pool_entries p where p.referral_id = r.id), 'presented', (select count(*) from public.referral_presentations p where p.referral_id = r.id), 'bookable', (select count(*) from public.bookability_evaluations b where b.context_type = 'referral' and b.context_id = r.id and b.result = 'bookable')) order by r.attempt_ordinal)::text from public.referrals r where r.intake_id = '${client.intake}';`,
      );
      assert.deepEqual(
        rows.map((r) => [r.ordinal, r.attorney]),
        [
          [1, world.adam.profile],
          [2, world.mia.profile],
        ],
      );
      for (const row of rows) {
        assert.ok(
          row.pool >= 7 && row.presented === 7 && row.bookable === 1,
          JSON.stringify(row),
        );
      }
      report.concurrency.ordinals = {
        waited_on_lock: true,
        ordinals: rows.map((r) => r.ordinal),
        evidence: rows.map((r) => ({
          pool: r.pool,
          presented: r.presented,
          bookable: r.bookable,
        })),
      };
      return report.concurrency.ordinals;
    },
  );
  await check(
    "CC-2 the attempt cap: at most 50 attempts per Intake (a fixed abuse bound), then rate_limited without writing",
    () => {
      const client = newClient(["submitted"]);
      for (let ordinal = 1; ordinal <= 50; ordinal += 1) {
        sql(
          [
            "begin;",
            ownerReferralSql({
              referral: uid(),
              intake: client.intake,
              attorney: world.max.profile,
              jurisdiction: world.J.M,
              ordinal,
            }),
            "commit;",
          ].join("\n"),
        );
        world.ownerReferrals += 1;
      }
      const before = evidenceCounts();
      assert.equal(
        create(client, {
          intake: client.intake,
          attorney: world.adam.profile,
          jurisdiction: world.J.A,
        }).outcome,
        "rate_limited",
      );
      assert.deepEqual(evidenceCounts(), before);
    },
  );
}

// ---------------------------------------------------------------------------
// Outcomes and immutability
// ---------------------------------------------------------------------------

async function outcomeChecks() {
  await check(
    "OUT-1 an outcome is recorded once and only from the configured taxonomy: a code the jurisdiction's referral policy lists is recorded (with that policy version), an unlisted or malformed code is invalid, no referral policy (B) or a malformed one (M) is not_configured, an unknown Referral is not_found, a second recording is already_recorded",
    () => {
      const outcome = (referral, code) =>
        sql(
          `select outcome || '|' || coalesce(policy_version_id::text, '') from public.referral_record_outcome(${lit(referral)}, ${lit(code)});`,
        );
      // A Referral in B (Instant path for Bob).
      const client = newClient(["submitted"]);
      const inB = create(client, {
        intake: client.intake,
        attorney: world.bob.profile,
        jurisdiction: world.J.B,
        path: "instant",
      });
      assert.equal(inB.outcome, "created", inB.line);
      assert.equal(
        outcome(inB.referral, "synthetic_declined"),
        "not_configured|",
      );
      assert.equal(
        outcome(world.refM, "synthetic_declined"),
        "not_configured|",
      );
      assert.equal(outcome(world.ref2, "synthetic_unlisted"), "invalid|");
      assert.equal(outcome(world.ref2, "Synthetic Declined"), "invalid|");
      assert.equal(outcome(world.ref2, null), "invalid|");
      assert.equal(outcome(uid(), "synthetic_declined"), "not_found|");
      assert.equal(
        outcome(world.ref2, "synthetic_withdrawn"),
        `recorded|${world.policies.referralA}`,
      );
      assert.equal(
        outcome(world.ref2, "synthetic_declined"),
        "already_recorded|",
      );
      const recorded = jsonOf(
        `select json_build_object('code', outcome_code, 'at', outcome_recorded_at is not null)::text from public.referrals where id = '${world.ref2}';`,
      );
      assert.deepEqual(recorded, { code: "synthetic_withdrawn", at: true });
    },
  );
  await check(
    "IMM-1 Referrals, pool entries, presentations and Eligibility Evaluations are immutable for every role, the owner included: no delete or truncate; a Referral changes only by recording its outcome once, code and time together",
    () => {
      const r = world.ref3;
      for (const [statement, state] of [
        [
          `update public.referrals set attorney_id = '${world.zed.profile}' where id = '${r}';`,
          "55000",
        ],
        [
          `update public.referrals set attempt_ordinal = 9 where id = '${r}';`,
          "55000",
        ],
        [
          `update public.referrals set jurisdiction_id = '${world.J.B}' where id = '${r}';`,
          "55000",
        ],
        [
          `update public.referrals set allocation_method = 'allocated' where id = '${r}';`,
          "55000",
        ],
        [
          `update public.referrals set created_at = now() where id = '${r}';`,
          "55000",
        ],
        [
          `update public.referrals set outcome_code = 'synthetic_declined' where id = '${r}';`,
          "55000",
        ],
        [
          `update public.referrals set outcome_code = 'synthetic_declined', outcome_recorded_at = now() where id = '${world.ref1}';`,
          "55000",
        ],
        [
          `update public.referrals set outcome_code = 'Not Snake', outcome_recorded_at = now() where id = '${r}';`,
          "23514",
        ],
        [`delete from public.referrals where id = '${r}';`, "55000"],
        ["truncate public.referrals cascade;", "55000"],
        [
          `update public.referral_eligible_pool_entries set eligible_as_of = now() where referral_id = '${r}';`,
          "55000",
        ],
        [
          `delete from public.referral_eligible_pool_entries where referral_id = '${r}';`,
          "55000",
        ],
        ["truncate public.referral_eligible_pool_entries;", "55000"],
        [
          `update public.referral_presentations set display_position = 9 where referral_id = '${r}';`,
          "55000",
        ],
        [
          `delete from public.referral_presentations where referral_id = '${r}';`,
          "55000",
        ],
        ["truncate public.referral_presentations;", "55000"],
        [
          "update public.eligibility_evaluations set result = 'eligible';",
          "55000",
        ],
        ["delete from public.eligibility_evaluations;", "55000"],
        ["truncate public.eligibility_evaluations cascade;", "55000"],
        [
          `update public.referral_presentations set narrowing_actor = 'someone' where referral_id = '${r}';`,
          "55000",
        ],
      ]) {
        assert.equal(refused(statement), state, statement);
      }
      // Constraint checks on new rows.
      const referral = uid();
      for (const [variant, state] of [
        [`, 0, 'client_selected'`, "23514"],
        [`, 1, 'chosen'`, "23514"],
      ]) {
        assert.equal(
          refused(
            `insert into public.referrals (id, intake_id, attorney_id, jurisdiction_id, attempt_ordinal, allocation_method) values ('${referral}', '${world.client4.intake}', '${world.max.profile}', '${world.J.M}'${variant});`,
          ),
          state,
          variant,
        );
      }
      for (const [column, state] of [
        ["0, 'platform'", "23514"],
        ["1, 'someone'", "23514"],
      ]) {
        assert.equal(
          refused(
            `${ownerReferralSql({ referral, intake: world.client4.intake, attorney: world.max.profile, jurisdiction: world.J.M, ordinal: 2, omit: ["presentation"] })}
             insert into public.referral_presentations (referral_id, attorney_id, display_position, narrowing_actor, shown_at) values ('${referral}', '${world.max.profile}', ${column}, now());`,
          ),
          state,
          column,
        );
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Audit minimization
// ---------------------------------------------------------------------------

async function auditChecks() {
  await check(
    "AUD-1 Referral creation audits exactly one client-actor event per Referral with fixed identifier and count keys, its jurisdiction and the eligibility policy reference; no Intake content, filter text, presence detail or free text; nothing else is audited by the S5 functions",
    () => {
      const shapes = sql(
        `select string_agg(distinct (select string_agg(k, ',' order by k) from jsonb_object_keys(after_snapshot) k), ';') from public.audit_events where action_code = 'referral.created';`,
      );
      assert.equal(
        shapes,
        "allocation_method,attempt_ordinal,attorney_id,bookability_evaluation_id,eligibility_evaluation_id,intake_id,pool_size,presented,request_path",
      );
      assert.equal(
        count(
          "audit_events",
          "action_code = 'referral.created' and (actor_type <> 'client' or actor_user_id is null or before_snapshot is not null or reason_code is not null or jurisdiction_id is null or resource_type <> 'referral')",
        ),
        0,
      );
      assert.equal(
        count(
          "audit_events a",
          "a.action_code = 'referral.created' and not exists (select 1 from public.referrals r where r.id = a.resource_id)",
        ),
        0,
      );
      // One event per Referral the command created (owner fixtures excepted).
      assert.equal(
        count("audit_events", "action_code = 'referral.created'"),
        count("referrals") - world.ownerReferrals,
      );
      assert.equal(
        count(
          "audit_events",
          "action_code = 'referral.created' and policy_references -> 0 ->> 'policy_type_code' is distinct from 'eligibility'",
        ),
        0,
      );
      assert.equal(
        count(
          "audit_events",
          "action_code like 'referral%' and action_code <> 'referral.created'",
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
    await discoveryChecks();
    await recorderChecks();
    await referralChecks();
    await concurrencyChecks();
    await outcomeChecks();
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
