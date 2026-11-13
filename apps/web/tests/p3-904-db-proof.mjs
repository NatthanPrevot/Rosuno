// P3-904 disposable PostgreSQL security proof. Explicitly invoked only:
//
//   node apps/web/tests/p3-904-db-proof.mjs
//
// Deliberately not a *.test.mjs file, so no application test run, p0:test,
// or CI job starts it. It uses Node built-ins, the system-installed
// PostgreSQL 16 initdb, pg_ctl, and psql binaries, and the application's own
// TypeScript modules (loaded by Node's type stripping).
//
// It creates a new mode-0700 temporary directory, initializes a new cluster
// in it owned by an unprivileged account (never root), and starts it with TCP
// disabled and a private Unix-domain socket. Every child process gets a fixed
// minimal environment. The roles anon, authenticated, and service_role
// (BYPASSRLS), the synthetic auth schema (auth.users and an auth.uid() that
// reads request.jwt.claim.sub, as PostgREST sets it from the verified JWT),
// the hosted platform's default privileges (every new public table and
// function granted to anon, authenticated, and service_role), and a no-op
// public.rls_auto_enable() are synthetic objects of this cluster only. The
// fourteen historical migrations are checked byte-for-byte against the
// canonical inventory and applied unmodified, in order, each in one
// transaction, followed by the single P3-904 migration.
//
// The probes cover: function and table privileges (R1 bypass prevention);
// the corrected scope predicate and its row policies (R2); the write-boundary
// authorization matrix and deterministic interleavings of separately
// controlled PostgreSQL sessions, observed through pg_stat_activity and
// pg_locks, for revocation, expiry, re-scoping, deactivation, suspension,
// record and lifecycle conflicts, lock timeout, and deadlock (R1); atomic
// domain change and audit, including injected audit, link, and status
// failures, replays, and ambiguous answers (R3); and P3-001, P3-002, and
// P3-003 regressions driven through the application's own modules and real
// adapters, whose Supabase client is replaced by one that executes the same
// PostgREST-shaped calls in this database as the request's own role. No
// Supabase project, network service, or pre-existing cluster is contacted,
// nothing persists after the run, and every value is synthetic test data.
// The JSON report goes to stdout; exit 0 means PASS, 1 FAIL, 2 cleanup
// failure, 3 refused to start.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  changePracticeAreaRequest,
  requestPracticeArea,
  resolveProfessionalSetup,
  saveInsuranceClaim,
  saveLicenseClaim,
  saveProfileDetails,
  submitApplicationForReview,
} from "../src/application/attorney-professional.ts";
import { startAttorneyApplication } from "../src/application/attorney-application.ts";
import { writeResultOf } from "../src/application/professional-audit.ts";
import {
  changeProfileStage,
  decidePracticeArea,
  recordDisciplineFinding,
  recordEligibilityDetermination,
  recordSourceUnavailable,
  recordVerificationFinding,
  resolveStaffReview,
} from "../src/application/staff-verification.ts";
import { createBoundedApplicantProvisioning } from "../src/infrastructure/identity/attorney-application-provisioning.ts";
import {
  createAttorneyApplicantProvisioning,
  createAttorneyProfessionalProvisioning,
  createStaffVerificationProvisioning,
} from "../src/infrastructure/identity/registration-provisioning.ts";
import {
  createAttorneyProfessionalReads,
  createAttorneyProfessionalWrites,
  createBoundedProfessionalProvisioning,
} from "../src/infrastructure/professional/attorney-professional-adapter.ts";
import { writeAnswerOf } from "../src/infrastructure/professional/professional-request-client.ts";
import {
  createBoundedStaffProvisioning,
  createStaffReads,
  createStaffWrites,
} from "../src/infrastructure/staff/staff-verification-adapter.ts";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54334;
const DB = "rosuno_p3_904_proof";
const REPOSITORY_ROOT = path.resolve(
  path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
  "../../..",
);
const MIGRATIONS = path.join(REPOSITORY_ROOT, "supabase/migrations");

// The canonical inventory of the fourteen historical migrations.
const HISTORICAL = Object.freeze([
  [
    "20260828192126_p0_restrict_rls_auto_enable_execution.sql",
    "2ba591b2767c43a32731c8b74b5ffaa07c47a41d096eee6fb3672aad9278c49d",
  ],
  [
    "20260829000015_p1_platform_foundation.sql",
    "67dfd44b2bd7525a588e6eb59c33a0056f3a5c67eec5f45dd93e6aab37f7afc8",
  ],
  [
    "20260829171701_p1_authorization_foundation.sql",
    "6471ac68949234e29ae1cc492eaa2f77dc15ca010998f72898284b8c9a855fec",
  ],
  [
    "20260830023823_p1_jurisdiction_policy_launch_foundation.sql",
    "94e9b746cf303154790bc51e8160f9184b2e9765e82ec2702e03030f7a79b7ee",
  ],
  [
    "20260901012518_p1_authorization_scope_correction.sql",
    "bf0cdabed8ffa41a65e793b9041c00dc7d2ca47eeef40c2750770e195b47d6c5",
  ],
  [
    "20260910075939_p1_attorney_verification_eligibility_foundation.sql",
    "09107387d2bd699189a7cdf970c1de18f89ca5cde5074d596274d63361d59231",
  ],
  [
    "20260911062917_p1_client_intake_ai_foundation.sql",
    "13be2baeaa808d38a5e209071c94a9c9565fbd1280aeae0395abc50502e2b375",
  ],
  [
    "20260914000658_p1_marketplace_referral_foundation.sql",
    "9035b76466c5b201e54667ee537eb4f9342c191ce5aa35d9e13d44f0def3e094",
  ],
  [
    "20260914231532_p1_scheduling_request_booking_bookability_foundation.sql",
    "4865a0643ffab7d8afcd9d26aeecc180e9fe51d6f261cc83717cfb1ab3bf370f",
  ],
  [
    "20260917045031_p1_consultation_engagement_media_foundation.sql",
    "aa33c207eacf407165809f893a622b3407708280527991ff772320d2b29dea60",
  ],
  [
    "20260918060600_p1_resources_communications_foundation.sql",
    "82db84c3e2fe5d20b5cf0a66c0b05d3cd481d68270d6ef50735dbaf8b7437487",
  ],
  [
    "20260919000112_p1_financial_foundation.sql",
    "c36f75cd5539d5961981c25a4a284e3af589ba770ff7cb3934d3cd307cc310d5",
  ],
  [
    "20260921051204_p1_compliance_foundation.sql",
    "d23dc72d6c36f544b8b50bbf053a96f9ecc9b2add7f02d87ce3ed4bc586880e4",
  ],
  [
    "20261020070000_p2_registration_abuse_control.sql",
    "32649648b0d75763ba1003957d24febffc2050951ca49b962687c2427a5f4db5",
  ],
]);
const P3_904_MIGRATION =
  "20261106090000_p3_904_professional_write_boundary.sql";

const M4_TABLES = Object.freeze([
  "attorney_profiles",
  "licenses",
  "insurance_records",
  "discipline_records",
  "practice_area_authorisations",
  "verification_evidence",
  "verification_evidence_subjects",
  "eligibility_evaluations",
]);

// The API functions with their exact identity signatures.
const API_FUNCTIONS = Object.freeze([
  "attorney_start_application()",
  "attorney_save_profile_details(text, text, text, text, integer)",
  "attorney_save_license_claim(uuid, timestamp with time zone, uuid, text, text, date, date)",
  "attorney_save_insurance_claim(uuid, timestamp with time zone, uuid, text, text, text, bigint, bigint, text, date, date)",
  "attorney_request_practice_area(uuid, uuid, uuid)",
  "attorney_change_practice_area_request(uuid, text, timestamp with time zone)",
  "attorney_submit_application()",
  "staff_record_verification_finding(uuid, text, uuid, timestamp with time zone, text, text, text, timestamp with time zone, text, text, text, boolean, text, text, date)",
  "staff_record_source_unavailable(text, uuid, text)",
  "staff_record_discipline_finding(uuid, uuid, uuid, uuid, text, text, date, date, text, text, text, text, timestamp with time zone, text, text, text, boolean)",
  "staff_decide_practice_area(uuid, timestamp with time zone, text, timestamp with time zone, timestamp with time zone, text)",
  "staff_change_profile_stage(uuid, text, text, text)",
  "staff_record_eligibility_evaluation(uuid, uuid, uuid, text, uuid, timestamp with time zone, text, jsonb, jsonb, jsonb)",
]);
const HELPER_FUNCTIONS = Object.freeze([
  "professional_text_within(text, integer)",
  "lock_current_active_user()",
  "lock_current_verification_staff(uuid)",
  "lock_current_attorney_profile(boolean)",
  "professional_record_of(text, uuid, text)",
  "verification_evidence_input_valid(text, text, text, timestamp with time zone, text, text, text, boolean)",
  // P3-904 revision 3 §4.2a: the eligibility derivation helpers.
  "eligibility_js_blank(text)",
  "eligibility_epoch_ms(timestamp with time zone)",
  "eligibility_safe_integer(jsonb, numeric)",
  "eligibility_status_list(jsonb)",
  "eligibility_exact_object(jsonb, text[])",
  "eligibility_selected_policy(uuid, timestamp with time zone)",
  "eligibility_assessment(uuid, uuid, uuid, timestamp with time zone)",
  "eligibility_normalized_factors(jsonb)",
]);

const report = {
  proof: "P3-904 disposable local PostgreSQL security proof",
  migrations: {},
  checks: [],
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

function sql(script, db) {
  const result = psql(script, db);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function sqlstateOf(text) {
  return /ERROR:\s+([0-9A-Z]{5}):/.exec(text ?? "")?.[1] ?? null;
}

// An SQL literal for a synthetic value.
function lit(value) {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value));
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `'${text.replaceAll("'", "''")}'`;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

function ident(name) {
  assert.match(name, IDENT);
  return name;
}

const JWT_SUB = (sub) =>
  sub === null
    ? ""
    : `select set_config('request.jwt.claim.sub', ${lit(sub)}, true) is not null;`;

// One statement as a role (and JWT subject), in its own committed (or
// rolled-back) transaction: { ok, value } or { ok: false, sqlstate }.
function as(role, sub, statement, { commit = true } = {}) {
  const result = psql(
    [
      "begin;",
      `set local role ${role};`,
      JWT_SUB(sub),
      statement,
      commit ? "commit;" : "rollback;",
      "",
    ].join("\n"),
  );
  if (result.status === 0) {
    const lines = result.stdout.trim().split("\n");
    return { ok: true, value: lines[lines.length - 1] };
  }
  return {
    ok: false,
    sqlstate: sqlstateOf(result.stderr),
    stderr: result.stderr,
  };
}

function namedArgs(args) {
  return Object.entries(args)
    .map(([name, value]) => `${ident(name)} => ${lit(value)}`)
    .join(", ");
}

let returnsSet = new Map();

function callExpression(name, args) {
  ident(name);
  return returnsSet.get(name) === true
    ? `(select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from public.${name}(${namedArgs(args)}) as r)`
    : `public.${name}(${namedArgs(args)})`;
}

// A write function called as a principal (authenticated role, JWT subject).
function fnAs(sub, name, args = {}) {
  const result = as(
    "authenticated",
    sub,
    `select ${callExpression(name, args)};`,
  );
  return result.ok ? result.value : `ERROR ${result.sqlstate}`;
}

function count(table, where = "true") {
  return Number(
    sql(`select count(*) from public.${ident(table)} where ${where};`),
  );
}

function one(statement) {
  return sql(statement);
}

// The determination the database itself derives (P3-904 revision 3 §4.2a),
// read as the disposable cluster's superuser, in the argument shape of
// staff_record_eligibility_evaluation. A test uses it to submit a truthful
// determination; the separate parity checks compare it with the application.
function derivedEvaluationArgs(attorneyId, jurisdictionId, practiceAreaId, asOf) {
  const area = practiceAreaId === null ? "null" : `'${practiceAreaId}'`;
  const derived = JSON.parse(
    one(
      `select public.eligibility_assessment('${attorneyId}', '${jurisdictionId}', ${area}, '${asOf}')::text;`,
    ),
  );
  assert.equal(derived.verifiable, true, "derivation is verifiable");
  return {
    p_evaluation_id: uid(),
    p_attorney_id: attorneyId,
    p_jurisdiction_id: jurisdictionId,
    p_context_type: practiceAreaId === null ? "jurisdiction" : "practice_area",
    p_context_id: practiceAreaId,
    p_as_of: asOf,
    p_result: derived.result,
    p_factor_results: derived.factor_results,
    p_policy_references: derived.policy_references,
    p_evidence_references: derived.evidence_references,
  };
}

const FIXTURE = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
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

function startCluster() {
  const identity = unprivilegedIdentity();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rosuno-p3-904-db-proof-"));
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
      "",
    ].join("\n"),
  );
  const start = run("pg_ctl", [
    "-D",
    dataDir,
    "-l",
    path.join(tmp, "postgres.log"),
    "-w",
    "-t",
    "60",
    "-s",
    "start",
  ]);
  assert.equal(start.status, 0, start.stderr);
  state.started = true;
  const settings = JSON.parse(
    sql(
      "select json_build_object('version', current_setting('server_version'), 'listen_addresses', current_setting('listen_addresses'), 'tcp', inet_server_addr() is not null, 'default_transaction_isolation', current_setting('default_transaction_isolation'), 'deadlock_timeout', current_setting('deadlock_timeout'))::text;",
      "postgres",
    ),
  );
  assert.equal(settings.listen_addresses, "");
  assert.equal(settings.tcp, false);
  report.cluster = {
    ...settings,
    postmaster_uid: identity.uid,
    temporary_directory_mode: "0700",
  };
}

function teardown() {
  if (state === null) {
    return true;
  }
  for (const session of openSessions) {
    try {
      session.child.kill("SIGKILL");
    } catch {
      // already gone
    }
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

function inventory() {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => [
      file,
      createHash("sha256")
        .update(fs.readFileSync(path.join(MIGRATIONS, file)))
        .digest("hex"),
    ]);
}

function applyMigrations() {
  const files = inventory();
  assert.equal(
    files.length,
    15,
    "exactly fourteen historical and one new migration",
  );
  assert.deepEqual(
    files.slice(0, 14),
    HISTORICAL.map((entry) => [...entry]),
  );
  assert.equal(files[14][0], P3_904_MIGRATION);
  report.migrations.historical_verified_before = files.slice(0, 14).length;
  report.migrations.p3_904 = { file: files[14][0], sha256: files[14][1] };
  sql(FIXTURE, "postgres");
  for (const [file] of files) {
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
  }
  report.migrations.applied = files.map(([file]) => file);
  returnsSet = new Map(
    sql(
      "select proname || '|' || case when proretset then 't' else 'f' end from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'attorney\\_%' or proname like 'staff\\_%' or proname = 'has_manage_attorney_verification_scope');",
    )
      .split("\n")
      .map((line) => {
        const [name, set] = line.split("|");
        return [name, set === "t"];
      }),
  );
}

// ---------------------------------------------------------------------------
// Persistent sessions for deterministic interleavings
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

  // Sends one statement; resolves when it has finished (or failed).
  send(statement) {
    this.n += 1;
    const mark = `__P3904_${this.label}_${this.n}__`;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${this.label}: no answer to ${statement}`)),
        20000,
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

  // Acts as one principal: the authenticated role with that JWT subject.
  async as(sub) {
    await this.ok("set role authenticated;");
    await this.ok(
      `select set_config('request.jwt.claim.sub', ${lit(sub)}, false) is not null;`,
    );
    return this;
  }

  close() {
    this.child.stdin.end();
    openSessions.delete(this);
  }
}

async function session(label, sub = null, settings = []) {
  const s = await new Session(label).open();
  for (const setting of settings) {
    await s.ok(setting);
  }
  if (sub !== null) {
    await s.as(sub);
  }
  return s;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits until a session's backend is blocked on a lock, and reports the
// lock it waits for and the backend holding it.
async function blockedOn(pid) {
  for (let i = 0; i < 400; i += 1) {
    const row = sql(
      `select coalesce(a.wait_event_type, '') || '|' || coalesce((select string_agg(l.locktype || ':' || l.mode || coalesce(':' || l.relation::regclass::text, ''), ',') from pg_locks l where l.pid = a.pid and not l.granted), '') || '|' || coalesce(array_to_string(pg_blocking_pids(a.pid), ','), '') from pg_stat_activity a where a.pid = ${pid};`,
    );
    const [waitType, waiting, blockers] = row.split("|");
    if (waitType === "Lock") {
      return {
        waiting,
        blockers: blockers.split(",").filter(Boolean).map(Number),
      };
    }
    await sleep(25);
  }
  throw new Error(`backend ${pid} never blocked on a lock`);
}

// ---------------------------------------------------------------------------
// Synthetic fixtures (test-only data in the disposable database)
// ---------------------------------------------------------------------------

let sequence = 1000;
const uid = () =>
  `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
const J_A = uid();
const J_B = uid();
const AREA = uid();
const AREA_OFF = uid();
let GRANTOR = null;
const POLICY_A = uid();

function newAccount(accountState = "active") {
  const auth = uid();
  const user = uid();
  sql(`insert into auth.users (id) values ('${auth}');
       insert into public.users (id, auth_user_id, account_state) values ('${user}', '${auth}', '${accountState}');`);
  return { auth, user };
}

function newAttorney(profileState = "applicant", account = newAccount()) {
  const profile = uid();
  sql(
    `insert into public.attorney_profiles (id, user_id, profile_state) values ('${profile}', '${account.user}', '${profileState}');`,
  );
  return { ...account, profile };
}

function newStaff({
  staffState = "active",
  accountState = "active",
  grants = [{}],
  account,
} = {}) {
  const ids = account ?? newAccount(accountState);
  sql(
    `insert into public.staff_profiles (user_id, staff_state) values ('${ids.user}', '${staffState}');`,
  );
  const grantIds = grants.map((g) => {
    const id = uid();
    const columns = {
      id: lit(id),
      user_id: lit(ids.user),
      capability_code: lit(g.capability ?? "manage_attorney_verification"),
      granted_by_user_id: lit(GRANTOR ?? ids.user),
      jurisdiction_id: lit(g.jurisdiction ?? null),
      resource_scope:
        g.resourceScope === undefined
          ? "null"
          : `${lit(g.resourceScope)}::jsonb`,
      granted_at: g.grantedAt ?? "now() - interval '1 day'",
      expires_at: g.expiresAt ?? "null",
      revoked_at: g.revokedAt ?? "null",
    };
    sql(
      `insert into public.capability_grants (${Object.keys(columns).join(", ")}) values (${Object.values(columns).join(", ")});`,
    );
    return id;
  });
  return { ...ids, grants: grantIds };
}

function newLicense(attorney, jurisdiction = J_A, extra = {}) {
  const id = uid();
  sql(
    `insert into public.licenses (id, attorney_id, jurisdiction_id, license_number, reported_status) values ('${id}', '${attorney.profile}', '${jurisdiction}', ${lit(`SYN-${id.slice(-6)}`)}, ${lit(extra.reportedStatus ?? null)});`,
  );
  return id;
}

function newAuthorisation(attorney, jurisdiction = J_A, status = "requested") {
  const id = uid();
  const area = uid();
  sql(`insert into public.practice_areas (id, code, name, active) values ('${area}', ${lit(`SYN_${area.slice(-6)}`)}, 'Synthetic area', true);
       insert into public.practice_area_authorisations (id, attorney_id, jurisdiction_id, practice_area_id, status, requested_at) values ('${id}', '${attorney.profile}', '${jurisdiction}', '${area}', '${status}', now() - interval '1 hour');`);
  return id;
}

const updatedAt = (table, id) =>
  sql(
    `select to_json(updated_at) #>> '{}' from public.${ident(table)} where id = '${id}';`,
  );

const auditCount = (where = "true") => count("audit_events", where);

function seed() {
  sql(`insert into public.jurisdictions (id, code, name, region_type) values ('${J_A}', 'SYN_A', 'Synthetic A', 'synthetic'), ('${J_B}', 'SYN_B', 'Synthetic B', 'synthetic');
       insert into public.practice_areas (id, code, name, active) values ('${AREA}', 'SYN_AREA', 'Synthetic area', true), ('${AREA_OFF}', 'SYN_OFF', 'Synthetic inactive area', false);`);
  const grantor = newAccount();
  sql(
    `insert into public.staff_profiles (user_id, staff_state) values ('${grantor.user}', 'active');`,
  );
  GRANTOR = grantor.user;
  // Synthetic, test-only eligibility policy with verified synthetic provenance.
  const parameters = {
    schema: "rosuno.attorney_eligibility.v1",
    license: {
      qualifying_reported_statuses: ["synthetic-active"],
      evidence_max_age_days: 30,
    },
    insurance: {
      required: false,
      evidence_max_age_days: 30,
      minimum_per_occurrence_minor: null,
      minimum_aggregate_minor: null,
      currency_code: null,
    },
    discipline: {
      disqualifying_statuses: ["synthetic-revoked"],
      cleared_statuses: [],
    },
    practice_area: { authorisation_required: false },
  };
  sql(`insert into public.policy_types (code, name) values ('attorney_eligibility', 'Synthetic test fixture');
       insert into public.policy_versions (id, policy_type_code, jurisdiction_id, version_label, parameters) values ('${POLICY_A}', 'attorney_eligibility', '${J_A}', 'synthetic-v1', $j$${JSON.stringify(parameters)}$j$::jsonb);
       insert into public.policy_authority_references (policy_version_id, authority_type, citation_text, source_title, retrieved_at, verified_by_user_id, verification_status)
         values ('${POLICY_A}', 'synthetic', 'synthetic citation', 'synthetic source', now(), '${GRANTOR}', 'verified');
       update public.policy_versions set status = 'active', approved_at = now() - interval '2 days', approved_by_user_id = '${GRANTOR}', effective_from = now() - interval '1 day' where id = '${POLICY_A}';`);
}

const EVIDENCE = (overrides = {}) => ({
  p_source_type: "synthetic register",
  p_source_uri: null,
  p_source_reference: "synthetic entry",
  p_retrieved_at: new Date(Date.now() - 3600000).toISOString(),
  p_verification_method: "synthetic lookup",
  p_evidence_summary: "synthetic summary",
  p_evidence_digest: null,
  p_discrepancy_flag: false,
  ...overrides,
});

function findingArgs(kind, subjectId, table, extra = {}) {
  return {
    p_evidence_id: uid(),
    p_subject_kind: kind,
    p_subject_id: subjectId,
    p_expected_updated_at: updatedAt(table, subjectId),
    ...EVIDENCE(),
    p_observed_status: null,
    p_discipline_status: null,
    p_resolved_at: null,
    ...extra,
  };
}

function decisionArgs(authorisationId, extra = {}) {
  return {
    p_authorisation_id: authorisationId,
    p_expected_updated_at: updatedAt(
      "practice_area_authorisations",
      authorisationId,
    ),
    p_decision: "authorised",
    p_effective_from: new Date().toISOString(),
    p_effective_until: null,
    p_note: "synthetic basis",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// A Supabase client stand-in that executes PostgREST-shaped calls in this
// database as one role (and JWT subject), for the application's own adapters.
// ---------------------------------------------------------------------------

function selectRows(role, sub, table, query) {
  const where =
    query.where.length === 0 ? "" : ` where ${query.where.join(" and ")}`;
  const order = query.order === null ? "" : ` order by ${query.order}`;
  const limit = query.limit === null ? "" : ` limit ${Number(query.limit)}`;
  const result = as(
    role,
    sub,
    // json_agg separates elements with a raw newline, which JSON text can
    // never otherwise contain; one line keeps the answer whole.
    `select translate(coalesce(json_agg(t), '[]'::json)::text, E'\\n', ' ') from (select ${query.columns} from public.${ident(table)}${where}${order}${limit}) t;`,
  );
  return result.ok
    ? { data: JSON.parse(result.value), error: null, status: 200 }
    : {
        data: null,
        error: { code: result.sqlstate, message: "synthetic" },
        status: 400,
      };
}

function dbClient(role, sub = null, { loseAnswers = false } = {}) {
  const thenable = (work) => ({
    then: (resolve, reject) =>
      Promise.resolve().then(work).then(resolve, reject),
  });
  return {
    from(table) {
      const query = { columns: "*", where: [], order: null, limit: null };
      const builder = {
        select(columns) {
          assert.match(columns, /^[a-z_]+(, [a-z_]+)*$/);
          query.columns = columns;
          return builder;
        },
        eq(column, value) {
          query.where.push(`${ident(column)} = ${lit(value)}`);
          return builder;
        },
        in(column, values) {
          query.where.push(
            `${ident(column)} in (${values.map(lit).join(", ")})`,
          );
          return builder;
        },
        is(column, value) {
          assert.equal(value, null);
          query.where.push(`${ident(column)} is null`);
          return builder;
        },
        order(column, options) {
          query.order = `${ident(column)} ${options?.ascending === false ? "desc" : "asc"}`;
          return builder;
        },
        limit(n) {
          query.limit = n;
          return builder;
        },
        then(resolve, reject) {
          return Promise.resolve()
            .then(() => selectRows(role, sub, table, query))
            .then(resolve, reject);
        },
      };
      return builder;
    },
    rpc(name, args = {}) {
      return thenable(() => {
        // PostgREST answers a scalar function with its JSON value and a set
        // returning function with a JSON array of rows.
        const expression = callExpression(name, args);
        const result = as(
          role,
          sub,
          returnsSet.get(name) === true
            ? `select ${expression};`
            : `select to_jsonb(${expression});`,
        );
        if (loseAnswers) {
          // The call ran (and committed, when it succeeded), but its answer
          // never arrives: a transport failure after the fact.
          return {
            data: null,
            error: {
              message: "TypeError: fetch failed",
              details: "",
              hint: "",
              code: "",
            },
            status: 0,
          };
        }
        return result.ok
          ? { data: JSON.parse(result.value), error: null, status: 200 }
          : {
              data: null,
              error: { code: result.sqlstate, message: "synthetic" },
              status: 400,
            };
      });
    },
  };
}

const ENVIRONMENT = Object.freeze({
  NEXT_PUBLIC_SUPABASE_URL: "https://syntheticprojectrefa.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic7f3a",
  ROSUNO_SUPABASE_ADMIN_KEY: "sb_secret_synthetic7f3a",
  ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: "syntheticprojectrefa",
});
const DEADLINE = 30000;
const privilegedFactory = () => dbClient("service_role");

const identityOf = (auth) => ({
  session: { currentSubject: async () => auth },
  account: {
    currentAccount: async () => ({
      kind: "user",
      id: auth,
      emailConfirmedAt: "2026-10-01T00:00:00Z",
    }),
  },
});

function attorneySources(auth, { loseAnswers = false } = {}) {
  const client = dbClient("authenticated", auth);
  const writer = dbClient("authenticated", auth, { loseAnswers });
  return {
    ...identityOf(auth),
    reads: createAttorneyProfessionalReads(async () => client, DEADLINE),
    provisioning: createBoundedProfessionalProvisioning(
      () =>
        createAttorneyProfessionalProvisioning(ENVIRONMENT, privilegedFactory),
      DEADLINE,
    ),
    writes: createAttorneyProfessionalWrites(async () => writer, DEADLINE),
    clock: () => Date.now(),
    newId: () => randomUUID(),
  };
}

function staffSources(auth, { loseAnswers = false } = {}) {
  const client = dbClient("authenticated", auth);
  const writer = dbClient("authenticated", auth, { loseAnswers });
  return {
    ...identityOf(auth),
    reads: createStaffReads(async () => client, DEADLINE),
    provisioning: createBoundedStaffProvisioning(
      () => createStaffVerificationProvisioning(ENVIRONMENT, privilegedFactory),
      DEADLINE,
    ),
    writes: createStaffWrites(async () => writer, DEADLINE),
    clock: () => Date.now(),
    newId: () => randomUUID(),
  };
}

function applicantSources(auth) {
  return {
    ...identityOf(auth),
    provisioning: createBoundedApplicantProvisioning(
      () => createAttorneyApplicantProvisioning(ENVIRONMENT, privilegedFactory),
      DEADLINE,
      async () => dbClient("authenticated", auth),
    ),
  };
}

function form(fields) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.append(name, value);
  }
  return data;
}

const minute = (ms) => new Date(ms).toISOString().slice(0, 16);

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function check(name, body) {
  try {
    const detail = await body();
    report.checks.push({
      name,
      result: "PASS",
      ...(detail === undefined ? {} : { detail }),
    });
  } catch (error) {
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.stack ?? error),
    });
  }
}

const aclOf = (signature) =>
  one(
    `select coalesce(array_to_string(proacl, ','), 'DEFAULT') from pg_proc where oid = 'public.${signature}'::regprocedure;`,
  );

async function privilegeChecks() {
  await check(
    "PRIV-1 every P3-904 function: exact signature, owner postgres, fixed search_path, and EXECUTE for authenticated only (helpers for no API role)",
    () => {
      const rows = {};
      for (const signature of API_FUNCTIONS) {
        const [owner, definer, config, volatile] = one(
          `select pg_get_userbyid(proowner) || '|' || prosecdef || '|' || array_to_string(proconfig, ';') || '|' || provolatile::text from pg_proc where oid = 'public.${signature}'::regprocedure;`,
        ).split("|");
        assert.equal(owner, "postgres", signature);
        assert.equal(definer, "true", signature);
        assert.equal(
          config,
          "search_path=pg_catalog, pg_temp;lock_timeout=3s",
          signature,
        );
        assert.equal(volatile, "v", signature);
        assert.equal(
          aclOf(signature),
          "postgres=X/postgres,authenticated=X/postgres",
          signature,
        );
        for (const role of ["public", "anon", "service_role"]) {
          assert.equal(
            one(
              `select has_function_privilege('${role}', 'public.${signature}', 'EXECUTE');`,
            ),
            "f",
            `${role} ${signature}`,
          );
        }
        rows[signature] =
          "owner postgres; SECURITY DEFINER; EXECUTE authenticated";
      }
      for (const signature of HELPER_FUNCTIONS) {
        assert.equal(aclOf(signature), "postgres=X/postgres", signature);
        assert.equal(
          one(
            `select prosecdef from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          "f",
        );
        for (const role of [
          "public",
          "anon",
          "authenticated",
          "service_role",
        ]) {
          assert.equal(
            one(
              `select has_function_privilege('${role}', 'public.${signature}', 'EXECUTE');`,
            ),
            "f",
          );
        }
      }
      // No API function takes an actor, User, reviewer, staff, or grant id as
      // an input argument.
      const names = one(
        `select string_agg(pg_get_function_identity_arguments(oid), ', ') from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'attorney\\_%' or proname like 'staff\\_%');`,
      );
      const forbidden = new Set([
        "actor",
        "user",
        "reviewer",
        "staff",
        "grant",
      ]);
      for (const argument of names.split(", ").filter(Boolean)) {
        const name = argument.split(" ")[0];
        assert.equal(
          name.split("_").some((token) => forbidden.has(token)),
          false,
          argument,
        );
        assert.equal(name.includes("retrieved_by"), false, argument);
      }
      // No other function in public is executable by anon or authenticated
      // except the pre-existing read predicates and the trigger-free baseline.
      const exposed = one(
        `select coalesce(string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text), '') from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'EXECUTE');`,
      );
      return {
        api_functions: rows,
        helper_functions: HELPER_FUNCTIONS.length,
        authenticated_executable: exposed,
      };
    },
  );

  await check(
    "PRIV-2 effective table and column grants: the eight M4 relations are SELECT-only for service_role and authenticated and closed to anon; no column-level write grant remains; audit_events and unrelated tables unchanged",
    () => {
      const table = {};
      for (const name of M4_TABLES) {
        const privileges = {};
        for (const role of ["anon", "authenticated", "service_role"]) {
          privileges[role] = [
            "SELECT",
            "INSERT",
            "UPDATE",
            "DELETE",
            "TRUNCATE",
            "REFERENCES",
            "TRIGGER",
          ]
            .filter(
              (p) =>
                one(
                  `select has_table_privilege('${role}', 'public.${name}', '${p}');`,
                ) === "t",
            )
            .join(",");
        }
        assert.equal(privileges.anon, "", name);
        assert.equal(privileges.authenticated, "SELECT", name);
        assert.equal(privileges.service_role, "SELECT", name);
        assert.equal(
          one(
            `select count(*) from information_schema.column_privileges where table_schema = 'public' and table_name = '${name}' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC') and privilege_type <> 'SELECT';`,
          ),
          "0",
          name,
        );
        table[name] = privileges;
      }
      assert.equal(
        one(
          "select has_table_privilege('service_role', 'public.audit_events', 'INSERT') and has_table_privilege('service_role', 'public.audit_events', 'SELECT') and not has_table_privilege('service_role', 'public.audit_events', 'UPDATE') and not has_table_privilege('authenticated', 'public.audit_events', 'INSERT');",
        ),
        "t",
      );
      assert.equal(
        one(
          "select has_table_privilege('service_role', 'public.users', 'INSERT') and has_table_privilege('service_role', 'public.client_profiles', 'INSERT') and has_table_privilege('service_role', 'public.practice_areas', 'UPDATE') and has_table_privilege('service_role', 'public.capability_grants', 'UPDATE');",
        ),
        "t",
      );
      return table;
    },
  );

  await check(
    "PRIV-3 role inheritance and row-security bypass: anon and authenticated are NOINHERIT, NOBYPASSRLS, and members of nothing; service_role keeps BYPASSRLS but no M4 write privilege; function owner is the table owner",
    () => {
      const roles = JSON.parse(
        one(
          "select json_agg(json_build_object('role', rolname, 'super', rolsuper, 'inherit', rolinherit, 'bypassrls', rolbypassrls, 'member_of', (select coalesce(json_agg(b.rolname), '[]') from pg_auth_members m join pg_roles b on b.oid = m.roleid where m.member = r.oid)) order by rolname) from pg_roles r where rolname in ('anon', 'authenticated', 'service_role');",
        ),
      );
      for (const role of roles) {
        assert.equal(role.super, false);
        assert.equal(role.inherit, false);
        assert.deepEqual(role.member_of, []);
        assert.equal(role.bypassrls, role.role === "service_role");
      }
      const owners = one(
        `select string_agg(distinct pg_get_userbyid(relowner), ',') from pg_class where oid in (${M4_TABLES.map((t) => `'public.${t}'::regclass`).join(", ")}, 'public.audit_events'::regclass);`,
      );
      assert.equal(owners, "postgres");
      return roles;
    },
  );

  await check(
    "PRIV-4 retired direct-write paths are rejected: service_role and authenticated DML on every M4 relation, service_role and anon calls of every write function, and API calls of the helpers",
    () => {
      const attorney = newAttorney("applicant");
      const license = newLicense(attorney);
      const statements = {
        "insert attorney_profiles": `insert into public.attorney_profiles (user_id, profile_state) values ('${newAccount().user}', 'approved');`,
        "update attorney_profiles": `update public.attorney_profiles set profile_state = 'approved' where id = '${attorney.profile}';`,
        "insert licenses": `insert into public.licenses (attorney_id, jurisdiction_id, license_number) values ('${attorney.profile}', '${J_A}', 'SYN-DIRECT');`,
        "update licenses": `update public.licenses set reported_status = 'verified' where id = '${license}';`,
        "delete licenses": `delete from public.licenses where id = '${license}';`,
        "insert insurance_records": `insert into public.insurance_records (attorney_id) values ('${attorney.profile}');`,
        "insert discipline_records": `insert into public.discipline_records (attorney_id, jurisdiction_id) values ('${attorney.profile}', '${J_A}');`,
        "insert practice_area_authorisations": `insert into public.practice_area_authorisations (attorney_id, jurisdiction_id, practice_area_id, status, requested_at) values ('${attorney.profile}', '${J_A}', '${AREA}', 'authorised', now());`,
        "insert verification_evidence": `insert into public.verification_evidence (retrieved_at) values (now());`,
        "insert verification_evidence_subjects": `insert into public.verification_evidence_subjects (verification_evidence_id, license_id) values (gen_random_uuid(), '${license}');`,
        "update verification_evidence_subjects column": `update public.verification_evidence_subjects set license_id = '${license}';`,
        "delete verification_evidence_subjects": `delete from public.verification_evidence_subjects;`,
        "insert eligibility_evaluations": `insert into public.eligibility_evaluations (attorney_id, jurisdiction_id, context_type, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${attorney.profile}', '${J_A}', 'jurisdiction', now(), '[]', 'eligible', '[]', '{}', now());`,
      };
      const outcomes = {};
      for (const [label, statement] of Object.entries(statements)) {
        const service = as("service_role", null, statement);
        const user = as("authenticated", attorney.auth, statement);
        assert.equal(service.sqlstate, "42501", `service_role ${label}`);
        assert.equal(user.sqlstate, "42501", `authenticated ${label}`);
        outcomes[label] = "42501/42501";
      }
      // Calls by the previously privileged role and by anon are refused
      // before the function body runs.
      const calls = {
        attorney_submit_application:
          "select public.attorney_submit_application();",
        attorney_start_application:
          "select * from public.attorney_start_application();",
        staff_change_profile_stage: `select public.staff_change_profile_stage('${attorney.profile}', 'approve', null, null);`,
        staff_record_source_unavailable: `select public.staff_record_source_unavailable('license', '${license}', 'synthetic');`,
      };
      for (const [name, statement] of Object.entries(calls)) {
        for (const role of ["service_role", "anon"]) {
          assert.equal(
            as(role, null, statement).sqlstate,
            "42501",
            `${role} ${name}`,
          );
          outcomes[`${role} calls ${name}`] = "42501";
        }
      }
      for (const helper of [
        "lock_current_active_user()",
        "lock_current_verification_staff(null)",
        "lock_current_attorney_profile(true)",
        "eligibility_assessment(null, null, null, now())",
        "eligibility_selected_policy(null, now())",
      ]) {
        assert.equal(
          as("authenticated", attorney.auth, `select public.${helper};`)
            .sqlstate,
          "42501",
          helper,
        );
      }
      assert.equal(
        one(
          `select profile_state from public.attorney_profiles where id = '${attorney.profile}';`,
        ),
        "applicant",
      );
      return outcomes;
    },
  );

  await check(
    "PRIV-5 legitimate unrelated operations are preserved: service_role registration writes, quota decisions, practice-area catalog writes, audit appends, and every M4 read",
    () => {
      const auth = uid();
      sql(`insert into auth.users (id) values ('${auth}');`);
      const user = as(
        "service_role",
        null,
        `insert into public.users (auth_user_id, account_state) values ('${auth}', 'pending_verification') returning id;`,
      );
      assert.equal(user.ok, true, user.stderr);
      assert.equal(
        as(
          "service_role",
          null,
          `insert into public.client_profiles (user_id) values ('${user.value}') returning 1;`,
        ).ok,
        true,
      );
      assert.equal(
        as(
          "service_role",
          null,
          `update public.users set account_state = 'active' where id = '${user.value}' returning 1;`,
        ).ok,
        true,
      );
      const digest = (c) => c.repeat(64);
      assert.equal(
        as(
          "service_role",
          null,
          `select public.registration_quota_decide('${digest("a")}', '${digest("b")}', '${digest("c")}', 5, 5, 100);`,
        ).value,
        "allow",
      );
      assert.equal(
        as(
          "service_role",
          null,
          `insert into public.practice_areas (code, name, active) values ('SYN_CATALOG', 'Synthetic catalog', true) returning 1;`,
        ).ok,
        true,
      );
      assert.equal(
        as(
          "service_role",
          null,
          `insert into public.audit_events (actor_type, action_code, resource_type, occurred_at) values ('system', 'synthetic_unrelated_event', 'synthetic', now()) returning 1;`,
        ).ok,
        true,
      );
      for (const name of M4_TABLES) {
        assert.equal(
          as("service_role", null, `select count(*) from public.${name};`).ok,
          true,
          name,
        );
      }
      return {
        registration: "insert/activate",
        quota: "allow",
        catalog: "insert",
        audit_append: "insert",
        m4_reads: M4_TABLES.length,
      };
    },
  );
}

async function predicateChecks() {
  await check(
    "R2-1 the scope predicate keeps its signature, return type, definer, and fixed search_path, and requires an authenticated caller with an active User, an active Staff Profile, and a current grant in scope",
    () => {
      assert.equal(
        one(
          "select pg_get_function_identity_arguments('public.has_manage_attorney_verification_scope(uuid, boolean)'::regprocedure) || '|' || pg_get_function_result('public.has_manage_attorney_verification_scope(uuid, boolean)'::regprocedure) || '|' || prosecdef || '|' || provolatile::text || '|' || array_to_string(proconfig, ';') || '|' || pg_get_userbyid(proowner) from pg_proc where oid = 'public.has_manage_attorney_verification_scope(uuid, boolean)'::regprocedure;",
        ),
        "required_jurisdiction uuid, allow_any_jurisdiction boolean|boolean|true|s|search_path=pg_catalog|postgres",
      );
      assert.equal(
        aclOf("has_manage_attorney_verification_scope(uuid, boolean)"),
        "postgres=X/postgres,authenticated=X/postgres",
      );
      const principals = {
        global: newStaff(),
        jurisdictionA: newStaff({ grants: [{ jurisdiction: J_A }] }),
        suspendedUser: newStaff({ accountState: "suspended" }),
        pendingUser: newStaff({ accountState: "pending_verification" }),
        deactivatedStaff: newStaff({ staffState: "deactivated" }),
        invitedStaff: newStaff({ staffState: "invited" }),
        removedStaff: newStaff({ staffState: "removed" }),
        revoked: newStaff({ grants: [{ revokedAt: "now()" }] }),
        expired: newStaff({
          grants: [
            {
              grantedAt: "now() - interval '2 days'",
              expiresAt: "now() - interval '1 day'",
            },
          ],
        }),
        future: newStaff({
          grants: [{ grantedAt: "now() + interval '1 day'" }],
        }),
        resourceScoped: newStaff({
          grants: [{ resourceScope: { synthetic: true } }],
        }),
        noGrant: newStaff({ grants: [] }),
        attorney: newAttorney("approved"),
        client: newAccount(),
      };
      const table = {};
      for (const [label, principal] of Object.entries(principals)) {
        table[label] = [null, J_A, J_B]
          .map(
            (j) =>
              as(
                "authenticated",
                principal.auth,
                `select public.has_manage_attorney_verification_scope(${lit(j)}, false);`,
                { commit: false },
              ).value,
          )
          .join("");
      }
      assert.equal(table.global, "ttt");
      assert.equal(table.jurisdictionA, "ftf");
      for (const label of Object.keys(principals).filter(
        (l) => !["global", "jurisdictionA"].includes(l),
      )) {
        assert.equal(table[label], "fff", label);
      }
      // Unauthenticated (no subject) and an unknown subject.
      assert.equal(
        as(
          "authenticated",
          null,
          "select public.has_manage_attorney_verification_scope(null, true);",
        ).value,
        "f",
      );
      assert.equal(
        as(
          "authenticated",
          uid(),
          "select public.has_manage_attorney_verification_scope(null, true);",
        ).value,
        "f",
      );
      return table;
    },
  );

  await check(
    "R2-2 every dependent row policy enforces the corrected predicate: deactivated, invited, or suspended staff holding a valid grant read no evidence, evaluations, other attorneys' records, or inactive practice areas",
    () => {
      const attorney = newAttorney("under_review");
      const license = newLicense(attorney, J_A);
      const evidence = uid();
      sql(`insert into public.verification_evidence (id, jurisdiction_id, retrieved_at, evidence_summary) values ('${evidence}', '${J_A}', now(), 'synthetic');
         insert into public.verification_evidence_subjects (verification_evidence_id, license_id) values ('${evidence}', '${license}');
         insert into public.eligibility_evaluations (attorney_id, jurisdiction_id, context_type, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${attorney.profile}', '${J_A}', 'jurisdiction', now(), '[]', 'undetermined', '[]', '{}', now());`);
      const reads = (auth) =>
        [
          "attorney_profiles",
          "licenses",
          "verification_evidence",
          "verification_evidence_subjects",
          "eligibility_evaluations",
        ]
          .map(
            (t) =>
              as(
                "authenticated",
                auth,
                `select count(*) from public.${t} where ${t === "attorney_profiles" ? `id = '${attorney.profile}'` : t === "licenses" ? `id = '${license}'` : t === "verification_evidence" ? `id = '${evidence}'` : t === "verification_evidence_subjects" ? `verification_evidence_id = '${evidence}'` : `attorney_id = '${attorney.profile}'`};`,
              ).value,
          )
          .join("") +
        as(
          "authenticated",
          auth,
          `select count(*) from public.practice_areas where id = '${AREA_OFF}';`,
        ).value;
      const active = newStaff();
      const deactivated = newStaff({ staffState: "deactivated" });
      const invited = newStaff({ staffState: "invited" });
      const suspended = newStaff({ accountState: "suspended" });
      const table = {
        active: reads(active.auth),
        deactivated: reads(deactivated.auth),
        invited: reads(invited.auth),
        suspended: reads(suspended.auth),
        own_attorney: reads(attorney.auth),
      };
      assert.equal(table.active, "111111");
      assert.equal(table.deactivated, "000000");
      assert.equal(table.invited, "000000");
      assert.equal(table.suspended, "000000");
      // The attorney's own-row access (P3-001/P3-003) is unchanged.
      assert.equal(table.own_attorney, "110000");
      // Live deactivation of an active reviewer removes access at once.
      sql(
        `update public.staff_profiles set staff_state = 'deactivated' where user_id = '${active.user}';`,
      );
      table.after_deactivation = reads(active.auth);
      assert.equal(table.after_deactivation, "000000");
      return table;
    },
  );
}

async function authorizationMatrix() {
  await check(
    "R1-1 staff write boundary: only an authenticated, active User with an active Staff Profile and a current grant for the record's jurisdiction is applied; every other principal is denied and nothing is written",
    () => {
      const attorney = newAttorney("under_review");
      const principals = {
        global: newStaff(),
        jurisdictionA: newStaff({ grants: [{ jurisdiction: J_A }] }),
        wrongJurisdiction: newStaff({ grants: [{ jurisdiction: J_B }] }),
        suspendedUser: newStaff({ accountState: "suspended" }),
        closedUser: newStaff({ accountState: "closed" }),
        deactivatedStaff: newStaff({ staffState: "deactivated" }),
        invitedStaff: newStaff({ staffState: "invited" }),
        revoked: newStaff({ grants: [{ revokedAt: "now()" }] }),
        expired: newStaff({
          grants: [
            {
              grantedAt: "now() - interval '2 days'",
              expiresAt: "now() - interval '1 second'",
            },
          ],
        }),
        future: newStaff({
          grants: [{ grantedAt: "now() + interval '1 hour'" }],
        }),
        resourceScoped: newStaff({
          grants: [{ resourceScope: { attorney_id: attorney.profile } }],
        }),
        noGrant: newStaff({ grants: [] }),
        attorneyItself: attorney,
        otherAttorney: newAttorney("applicant"),
        client: newAccount(),
        unknownSubject: { auth: uid() },
        unauthenticated: { auth: null },
      };
      const table = {};
      for (const [label, principal] of Object.entries(principals)) {
        const license = newLicense(attorney, J_A);
        const evidenceBefore = count("verification_evidence");
        const auditBefore = auditCount();
        const args = findingArgs("license", license, "licenses", {
          p_observed_status: "synthetic-active",
        });
        const outcome = fnAs(
          principal.auth,
          "staff_record_verification_finding",
          args,
        );
        table[label] = outcome;
        const expectedApplied = label === "global" || label === "jurisdictionA";
        assert.equal(outcome, expectedApplied ? "applied" : "denied", label);
        assert.equal(
          count("verification_evidence") - evidenceBefore,
          expectedApplied ? 1 : 0,
          label,
        );
        assert.equal(
          auditCount() - auditBefore,
          expectedApplied ? 1 : 0,
          label,
        );
        assert.equal(
          one(
            `select coalesce(reported_status, '') from public.licenses where id = '${license}';`,
          ),
          expectedApplied ? "synthetic-active" : "",
          label,
        );
        if (expectedApplied) {
          // The actor is the caller: evidence reviewer and audit actor both.
          assert.equal(
            one(
              `select retrieved_by_user_id from public.verification_evidence where id = '${args.p_evidence_id}';`,
            ),
            principal.user,
          );
          assert.equal(
            one(
              `select actor_user_id || '|' || actor_type from public.audit_events where resource_id = '${args.p_evidence_id}';`,
            ),
            `${principal.user}|staff`,
          );
        }
      }
      // Profile review needs the global scope; a jurisdiction grant is denied.
      const reviewed = newAttorney("under_review");
      table.stage_change_jurisdictionA = fnAs(
        principals.jurisdictionA.auth,
        "staff_change_profile_stage",
        {
          p_attorney_id: reviewed.profile,
          p_intent: "approve",
          p_message: null,
          p_note: null,
        },
      );
      assert.equal(table.stage_change_jurisdictionA, "denied");
      table.stage_change_global = fnAs(
        principals.global.auth,
        "staff_change_profile_stage",
        {
          p_attorney_id: reviewed.profile,
          p_intent: "approve",
          p_message: null,
          p_note: null,
        },
      );
      assert.equal(table.stage_change_global, "applied");
      // A reviewer never acts on their own attorney profile.
      const dual = newAttorney("under_review");
      newStaff({ account: dual });
      table.own_profile = fnAs(dual.auth, "staff_change_profile_stage", {
        p_attorney_id: dual.profile,
        p_intent: "approve",
        p_message: null,
        p_note: null,
      });
      assert.equal(table.own_profile, "denied");
      table.own_record = fnAs(
        dual.auth,
        "staff_record_verification_finding",
        findingArgs("license", newLicense(dual), "licenses"),
      );
      assert.equal(table.own_record, "denied");
      return table;
    },
  );

  await check(
    "R1-2 every staff operation enforces scope, lifecycle stage, record version, and the reviewer's own identity at the write",
    () => {
      const global = newStaff();
      const scopedB = newStaff({ grants: [{ jurisdiction: J_B }] });
      const out = {};
      const applicant = newAttorney("applicant");
      out.finding_on_applicant_stage = fnAs(
        global.auth,
        "staff_record_verification_finding",
        findingArgs("license", newLicense(applicant), "licenses"),
      );
      assert.equal(out.finding_on_applicant_stage, "locked");
      const reviewed = newAttorney("under_review");
      const licenseA = newLicense(reviewed, J_A);
      const stale = findingArgs("license", licenseA, "licenses");
      sql(
        `update public.licenses set license_type = 'synthetic change' where id = '${licenseA}';`,
      );
      out.finding_on_stale_version = fnAs(
        global.auth,
        "staff_record_verification_finding",
        stale,
      );
      assert.equal(out.finding_on_stale_version, "conflict");
      out.unavailable_wrong_scope = fnAs(
        scopedB.auth,
        "staff_record_source_unavailable",
        {
          p_subject_kind: "license",
          p_subject_id: licenseA,
          p_note: "synthetic outage",
        },
      );
      assert.equal(out.unavailable_wrong_scope, "denied");
      out.unavailable_applied = fnAs(
        global.auth,
        "staff_record_source_unavailable",
        {
          p_subject_kind: "license",
          p_subject_id: licenseA,
          p_note: "synthetic outage",
        },
      );
      assert.equal(out.unavailable_applied, "applied");
      out.discipline_wrong_scope = fnAs(
        scopedB.auth,
        "staff_record_discipline_finding",
        {
          p_discipline_id: uid(),
          p_evidence_id: uid(),
          p_attorney_id: reviewed.profile,
          p_jurisdiction_id: J_A,
          p_external_reference: null,
          p_finding_type: null,
          p_opened_at: null,
          p_resolved_at: null,
          p_status: "synthetic-open",
          ...EVIDENCE(),
        },
      );
      assert.equal(out.discipline_wrong_scope, "denied");
      const authorisation = newAuthorisation(reviewed, J_A);
      out.decision_wrong_scope = fnAs(
        scopedB.auth,
        "staff_decide_practice_area",
        decisionArgs(authorisation),
      );
      assert.equal(out.decision_wrong_scope, "denied");
      out.decision_applied = fnAs(
        global.auth,
        "staff_decide_practice_area",
        decisionArgs(authorisation),
      );
      assert.equal(out.decision_applied, "applied");
      out.decision_repeated = fnAs(
        global.auth,
        "staff_decide_practice_area",
        decisionArgs(authorisation),
      );
      assert.equal(out.decision_repeated, "locked");
      const suspendedTarget = newAttorney("suspended");
      out.decision_on_suspended = fnAs(
        global.auth,
        "staff_decide_practice_area",
        decisionArgs(newAuthorisation(suspendedTarget, J_A)),
      );
      assert.equal(out.decision_on_suspended, "locked");
      out.transition_from_wrong_stage = fnAs(
        global.auth,
        "staff_change_profile_stage",
        {
          p_attorney_id: applicant.profile,
          p_intent: "approve",
          p_message: null,
          p_note: null,
        },
      );
      assert.equal(out.transition_from_wrong_stage, "locked");
      out.evaluation_wrong_scope = fnAs(
        scopedB.auth,
        "staff_record_eligibility_evaluation",
        {
          p_evaluation_id: uid(),
          p_attorney_id: reviewed.profile,
          p_jurisdiction_id: J_A,
          p_context_type: "jurisdiction",
          p_context_id: null,
          p_as_of: new Date().toISOString(),
          p_result: "undetermined",
          p_factor_results: [],
          p_policy_references: [],
          p_evidence_references: {
            evidence_ids: [],
            license_ids: [],
            insurance_record_ids: [],
            discipline_record_ids: [],
            practice_area_authorisation_ids: [],
          },
        },
      );
      assert.equal(out.evaluation_wrong_scope, "denied");
      return out;
    },
  );

  await check(
    "R1-3 attorney write boundary: only the caller's own active User and own profile, in the stage each action allows; other attorneys' records, suspended accounts or profiles, clients, and unauthenticated callers are refused",
    () => {
      const out = {};
      const owner = newAttorney("applicant");
      const other = newAttorney("applicant");
      const othersLicense = newLicense(other);
      const claim = (id, version, extra = {}) => ({
        p_license_id: id,
        p_expected_updated_at: version,
        p_jurisdiction_id: J_A,
        p_license_number: `SYN-${id.slice(-6)}`,
        p_license_type: null,
        p_effective_from: null,
        p_effective_until: null,
        ...extra,
      });
      out.own_insert = fnAs(
        owner.auth,
        "attorney_save_license_claim",
        claim(uid(), null),
      );
      assert.equal(out.own_insert, "applied");
      out.idor_revision = fnAs(
        owner.auth,
        "attorney_save_license_claim",
        claim(othersLicense, updatedAt("licenses", othersLicense)),
      );
      assert.equal(out.idor_revision, "denied");
      out.idor_withdraw = fnAs(
        owner.auth,
        "attorney_change_practice_area_request",
        {
          p_authorisation_id: newAuthorisation(other),
          p_intent: "withdraw",
          p_expected_updated_at: new Date().toISOString(),
        },
      );
      assert.equal(out.idor_withdraw, "denied");
      const suspendedUser = newAttorney("applicant", newAccount("suspended"));
      out.suspended_user = fnAs(
        suspendedUser.auth,
        "attorney_save_license_claim",
        claim(uid(), null),
      );
      assert.equal(out.suspended_user, "denied");
      const suspendedProfile = newAttorney("suspended");
      out.suspended_profile = fnAs(
        suspendedProfile.auth,
        "attorney_save_profile_details",
        {
          p_expected_state: "applicant",
          p_display_name: "Synthetic",
          p_headline: null,
          p_bio: null,
          p_years_experience: null,
        },
      );
      assert.equal(out.suspended_profile, "denied");
      const underReview = newAttorney("under_review");
      out.under_review_claim = fnAs(
        underReview.auth,
        "attorney_save_license_claim",
        claim(uid(), null),
      );
      assert.equal(out.under_review_claim, "locked");
      out.under_review_submit = fnAs(
        underReview.auth,
        "attorney_submit_application",
      );
      assert.equal(out.under_review_submit, "locked");
      const client = newAccount();
      out.client = fnAs(
        client.auth,
        "attorney_save_license_claim",
        claim(uid(), null),
      );
      assert.equal(out.client, "denied");
      out.unauthenticated = fnAs(null, "attorney_submit_application");
      assert.equal(out.unauthenticated, "denied");
      // A reviewed claim (observed status or evidence) is locked.
      const observed = newLicense(owner, J_A, {
        reportedStatus: "synthetic-active",
      });
      out.observed_claim = fnAs(
        owner.auth,
        "attorney_save_license_claim",
        claim(observed, updatedAt("licenses", observed)),
      );
      assert.equal(out.observed_claim, "locked");
      // Years of experience cannot change after approval; presentation can.
      const approved = newAttorney("approved");
      sql(
        `update public.attorney_profiles set years_experience = 7 where id = '${approved.profile}';`,
      );
      out.approved_years_change = fnAs(
        approved.auth,
        "attorney_save_profile_details",
        {
          p_expected_state: "approved",
          p_display_name: "Synthetic",
          p_headline: null,
          p_bio: null,
          p_years_experience: 9,
        },
      );
      assert.equal(out.approved_years_change, "invalid");
      out.approved_presentation = fnAs(
        approved.auth,
        "attorney_save_profile_details",
        {
          p_expected_state: "approved",
          p_display_name: "Synthetic",
          p_headline: "Synthetic headline",
          p_bio: null,
          p_years_experience: 7,
        },
      );
      assert.equal(out.approved_presentation, "applied");
      // Every audit row of these calls names the caller as an attorney actor.
      assert.equal(
        auditCount(
          `actor_user_id = '${owner.user}' and actor_type = 'attorney'`,
        ),
        1,
      );
      assert.equal(auditCount(`actor_user_id = '${other.user}'`), 0);
      return out;
    },
  );

  await check(
    "R1-4 unsupported payloads are refused before any write: unknown kinds and intents, overlong or control-character text, malformed currency, reversed dates, and forged evaluation references",
    () => {
      const attorney = newAttorney("applicant");
      const staff = newStaff();
      const reviewed = newAttorney("under_review");
      const license = newLicense(reviewed, J_A);
      const before = {
        audit: auditCount(),
        licenses: count("licenses"),
        evidence: count("verification_evidence"),
        evaluations: count("eligibility_evaluations"),
      };
      const out = {
        overlong_name: fnAs(attorney.auth, "attorney_save_profile_details", {
          p_expected_state: "applicant",
          p_display_name: "x".repeat(121),
          p_headline: null,
          p_bio: null,
          p_years_experience: null,
        }),
        control_character: fnAs(
          attorney.auth,
          "attorney_save_profile_details",
          {
            p_expected_state: "applicant",
            p_display_name: "bad\u0007name",
            p_headline: null,
            p_bio: null,
            p_years_experience: null,
          },
        ),
        years_out_of_range: fnAs(
          attorney.auth,
          "attorney_save_profile_details",
          {
            p_expected_state: "applicant",
            p_display_name: null,
            p_headline: null,
            p_bio: null,
            p_years_experience: 81,
          },
        ),
        bad_currency: fnAs(attorney.auth, "attorney_save_insurance_claim", {
          p_record_id: uid(),
          p_expected_updated_at: null,
          p_jurisdiction_id: J_A,
          p_carrier_name: "Synthetic",
          p_policy_reference: null,
          p_coverage_type: null,
          p_per_occurrence_limit_minor: 100,
          p_aggregate_limit_minor: null,
          p_currency_code: "usd",
          p_coverage_from: null,
          p_coverage_until: null,
        }),
        reversed_dates: fnAs(attorney.auth, "attorney_save_license_claim", {
          p_license_id: uid(),
          p_expected_updated_at: null,
          p_jurisdiction_id: J_A,
          p_license_number: "SYN-REV",
          p_license_type: null,
          p_effective_from: "2026-02-01",
          p_effective_until: "2026-01-01",
        }),
        inactive_area: fnAs(attorney.auth, "attorney_request_practice_area", {
          p_authorisation_id: uid(),
          p_jurisdiction_id: J_A,
          p_practice_area_id: AREA_OFF,
        }),
        unknown_intent: fnAs(
          attorney.auth,
          "attorney_change_practice_area_request",
          {
            p_authorisation_id: uid(),
            p_intent: "approve",
            p_expected_updated_at: new Date().toISOString(),
          },
        ),
        unknown_kind: fnAs(staff.auth, "staff_record_verification_finding", {
          ...findingArgs("license", license, "licenses"),
          p_subject_kind: "client_profile",
        }),
        observed_on_insurance: fnAs(
          staff.auth,
          "staff_record_verification_finding",
          {
            ...findingArgs("license", license, "licenses"),
            p_subject_kind: "insurance",
            p_observed_status: "x",
          },
        ),
        non_https_source: fnAs(
          staff.auth,
          "staff_record_verification_finding",
          findingArgs("license", license, "licenses", {
            p_source_uri: "http://example.invalid",
          }),
        ),
        future_retrieval: fnAs(
          staff.auth,
          "staff_record_verification_finding",
          findingArgs("license", license, "licenses", {
            p_retrieved_at: new Date(Date.now() + 86400000).toISOString(),
          }),
        ),
        forged_evidence_reference: fnAs(
          staff.auth,
          "staff_record_eligibility_evaluation",
          {
            p_evaluation_id: uid(),
            p_attorney_id: reviewed.profile,
            p_jurisdiction_id: J_A,
            p_context_type: "jurisdiction",
            p_context_id: null,
            p_as_of: new Date().toISOString(),
            p_result: "eligible",
            p_factor_results: [],
            p_policy_references: [],
            p_evidence_references: {
              evidence_ids: [uid()],
              license_ids: [],
              insurance_record_ids: [],
              discipline_record_ids: [],
              practice_area_authorisation_ids: [],
            },
          },
        ),
        other_attorneys_license_reference: fnAs(
          staff.auth,
          "staff_record_eligibility_evaluation",
          {
            p_evaluation_id: uid(),
            p_attorney_id: reviewed.profile,
            p_jurisdiction_id: J_A,
            p_context_type: "jurisdiction",
            p_context_id: null,
            p_as_of: new Date().toISOString(),
            p_result: "eligible",
            p_factor_results: [],
            p_policy_references: [],
            p_evidence_references: {
              evidence_ids: [],
              license_ids: [newLicense(attorney)],
              insurance_record_ids: [],
              discipline_record_ids: [],
              practice_area_authorisation_ids: [],
            },
          },
        ),
        forged_policy_reference: fnAs(
          staff.auth,
          "staff_record_eligibility_evaluation",
          {
            p_evaluation_id: uid(),
            p_attorney_id: reviewed.profile,
            p_jurisdiction_id: J_A,
            p_context_type: "jurisdiction",
            p_context_id: null,
            p_as_of: new Date().toISOString(),
            p_result: "eligible",
            p_factor_results: [],
            p_policy_references: [
              {
                policy_version_id: uid(),
                version_label: "x",
                policy_type_code: "attorney_eligibility",
              },
            ],
            p_evidence_references: {
              evidence_ids: [],
              license_ids: [],
              insurance_record_ids: [],
              discipline_record_ids: [],
              practice_area_authorisation_ids: [],
            },
          },
        ),
        back_dated_evaluation: fnAs(
          staff.auth,
          "staff_record_eligibility_evaluation",
          {
            p_evaluation_id: uid(),
            p_attorney_id: reviewed.profile,
            p_jurisdiction_id: J_A,
            p_context_type: "jurisdiction",
            p_context_id: null,
            p_as_of: new Date(Date.now() - 3600000).toISOString(),
            p_result: "eligible",
            p_factor_results: [],
            p_policy_references: [],
            p_evidence_references: {
              evidence_ids: [],
              license_ids: [],
              insurance_record_ids: [],
              discipline_record_ids: [],
              practice_area_authorisation_ids: [],
            },
          },
        ),
        extra_reference_key: fnAs(
          staff.auth,
          "staff_record_eligibility_evaluation",
          {
            p_evaluation_id: uid(),
            p_attorney_id: reviewed.profile,
            p_jurisdiction_id: J_A,
            p_context_type: "jurisdiction",
            p_context_id: null,
            p_as_of: new Date().toISOString(),
            p_result: "eligible",
            p_factor_results: [],
            p_policy_references: [],
            p_evidence_references: {
              evidence_ids: [],
              license_ids: [],
              insurance_record_ids: [],
              discipline_record_ids: [],
              practice_area_authorisation_ids: [],
              actor: "x",
            },
          },
        ),
      };
      for (const [label, outcome] of Object.entries(out)) {
        assert.equal(outcome, "invalid", label);
      }
      // One license was created as fixture data above; nothing else changed.
      assert.equal(auditCount(), before.audit);
      assert.equal(count("licenses"), before.licenses + 1);
      assert.equal(count("verification_evidence"), before.evidence);
      assert.equal(count("eligibility_evaluations"), before.evaluations);
      return out;
    },
  );
}

async function concurrencyChecks() {
  await check(
    "C-1 revocation committed before the decisive check denies (separate sessions, autocommit revocation)",
    async () => {
      const staff = newStaff();
      const authorisation = newAuthorisation(newAttorney("under_review"));
      const admin = await session("admin");
      const reviewer = await session("reviewer", staff.auth);
      await admin.ok(
        `update public.capability_grants set revoked_at = clock_timestamp() where id = '${staff.grants[0]}';`,
      );
      const result = await reviewer.ok(
        `select ${callExpression("staff_decide_practice_area", decisionArgs(authorisation))};`,
      );
      admin.close();
      reviewer.close();
      assert.deepEqual(result, ["denied"]);
      assert.equal(
        one(
          `select status from public.practice_area_authorisations where id = '${authorisation}';`,
        ),
        "requested",
      );
      assert.equal(auditCount(`resource_id = '${authorisation}'`), 0);
      return {
        order: ["admin: revoke + commit", "reviewer: decide -> denied"],
        decided: false,
        audit_rows: 0,
      };
    },
  );

  await check(
    "C-2 a revocation in flight before the decisive check: the write blocks on the grant row lock, then denies on the committed revocation (or applies if it rolls back)",
    async () => {
      const results = {};
      for (const ending of ["commit", "rollback"]) {
        const staff = newStaff();
        const authorisation = newAuthorisation(newAttorney("under_review"));
        const args = decisionArgs(authorisation);
        const admin = await session("admin");
        const reviewer = await session("reviewer", staff.auth);
        await admin.ok("begin;");
        await admin.ok(
          `update public.capability_grants set revoked_at = clock_timestamp() where id = '${staff.grants[0]}';`,
        );
        const pending = reviewer.send(
          `select ${callExpression("staff_decide_practice_area", args)};`,
        );
        const blocked = await blockedOn(reviewer.pid);
        assert.deepEqual(blocked.blockers, [admin.pid]);
        await admin.ok(`${ending};`);
        const answer = await pending;
        admin.close();
        reviewer.close();
        assert.equal(answer.sqlstate, "00000", answer.stderr);
        const expected = ending === "commit" ? "denied" : "applied";
        assert.deepEqual(answer.rows, [expected]);
        assert.equal(
          one(
            `select status from public.practice_area_authorisations where id = '${authorisation}';`,
          ),
          ending === "commit" ? "requested" : "authorised",
        );
        assert.equal(
          auditCount(`resource_id = '${authorisation}'`),
          ending === "commit" ? 0 : 1,
        );
        results[`revocation_${ending}`] = {
          reviewer_waited_on: blocked.waiting,
          blocked_by_admin: true,
          outcome: expected,
        };
      }
      return results;
    },
  );

  await check(
    "C-3 a write that already holds its authorization locks completes; a later revocation waits for it to commit and only then takes effect",
    async () => {
      const staff = newStaff();
      const authorisation = newAuthorisation(newAttorney("under_review"));
      const admin = await session("admin");
      const reviewer = await session("reviewer", staff.auth);
      await reviewer.ok("begin;");
      const applied = await reviewer.ok(
        `select ${callExpression("staff_decide_practice_area", decisionArgs(authorisation))};`,
      );
      assert.deepEqual(applied, ["applied"]);
      const locks = one(
        `select string_agg(c.relname || ':' || l.mode, ',' order by c.relname, l.mode) from pg_locks l join pg_class c on c.oid = l.relation where l.pid = ${reviewer.pid} and l.locktype = 'relation' and c.relname in ('users', 'staff_profiles', 'capability_grants', 'attorney_profiles', 'practice_area_authorisations', 'audit_events');`,
      );
      assert.match(locks, /capability_grants:RowShareLock/);
      assert.match(locks, /staff_profiles:RowShareLock/);
      assert.match(locks, /users:RowShareLock/);
      const revoke = admin.send(
        `update public.capability_grants set revoked_at = clock_timestamp() where id = '${staff.grants[0]}' returning revoked_at;`,
      );
      const blocked = await blockedOn(admin.pid);
      assert.deepEqual(blocked.blockers, [reviewer.pid]);
      await reviewer.ok("commit;");
      const revoked = await revoke;
      admin.close();
      reviewer.close();
      assert.equal(revoked.sqlstate, "00000", revoked.stderr);
      assert.equal(
        one(
          `select status from public.practice_area_authorisations where id = '${authorisation}';`,
        ),
        "authorised",
      );
      assert.equal(
        auditCount(
          `resource_id = '${authorisation}' and actor_user_id = '${staff.user}'`,
        ),
        1,
      );
      // The audit time precedes the revocation, which waited for the commit.
      assert.equal(
        one(
          `select (select occurred_at from public.audit_events where resource_id = '${authorisation}') < (select revoked_at from public.capability_grants where id = '${staff.grants[0]}');`,
        ),
        "t",
      );
      // After the revocation the same reviewer is denied.
      assert.equal(
        fnAs(
          staff.auth,
          "staff_decide_practice_area",
          decisionArgs(newAuthorisation(newAttorney("under_review"))),
        ),
        "denied",
      );
      return {
        reviewer_relation_locks: locks,
        revocation_waited_on: blocked.waiting,
        order: [
          "reviewer: decide -> applied (locks held)",
          "admin: revoke -> blocked",
          "reviewer: commit",
          "admin: revoke completes",
        ],
      };
    },
  );

  await check(
    "C-4 Staff Profile deactivation: in flight before the check it blocks the write and then denies; attempted after the write locked it, it waits for the commit",
    async () => {
      const out = {};
      {
        const staff = newStaff();
        const reviewed = newAttorney("under_review");
        const license = newLicense(reviewed);
        const admin = await session("admin");
        const reviewer = await session("reviewer", staff.auth);
        await admin.ok("begin;");
        await admin.ok(
          `update public.staff_profiles set staff_state = 'deactivated' where user_id = '${staff.user}';`,
        );
        const pending = reviewer.send(
          `select ${callExpression("staff_record_verification_finding", findingArgs("license", license, "licenses"))};`,
        );
        const blocked = await blockedOn(reviewer.pid);
        await admin.ok("commit;");
        const answer = await pending;
        admin.close();
        reviewer.close();
        assert.deepEqual(answer.rows, ["denied"]);
        assert.equal(
          count("verification_evidence_subjects", `license_id = '${license}'`),
          0,
        );
        out.deactivation_first = {
          reviewer_waited_on: blocked.waiting,
          outcome: "denied",
        };
      }
      {
        const staff = newStaff();
        const license = newLicense(newAttorney("under_review"));
        const admin = await session("admin");
        const reviewer = await session("reviewer", staff.auth);
        await reviewer.ok("begin;");
        assert.deepEqual(
          await reviewer.ok(
            `select ${callExpression("staff_record_verification_finding", findingArgs("license", license, "licenses"))};`,
          ),
          ["applied"],
        );
        const deactivate = admin.send(
          `update public.staff_profiles set staff_state = 'deactivated' where user_id = '${staff.user}';`,
        );
        const blocked = await blockedOn(admin.pid);
        await reviewer.ok("commit;");
        assert.equal((await deactivate).sqlstate, "00000");
        admin.close();
        reviewer.close();
        assert.equal(
          count("verification_evidence_subjects", `license_id = '${license}'`),
          1,
        );
        out.write_first = {
          deactivation_waited_on: blocked.waiting,
          outcome: "applied, then deactivated",
        };
      }
      return out;
    },
  );

  await check(
    "C-5 User suspension: an attorney's and a reviewer's writes block on their own User row and then deny; a suspension attempted after the lock waits",
    async () => {
      const out = {};
      {
        const attorney = newAttorney("applicant");
        const admin = await session("admin");
        const caller = await session("attorney", attorney.auth);
        await admin.ok("begin;");
        await admin.ok(
          `update public.users set account_state = 'suspended' where id = '${attorney.user}';`,
        );
        const pending = caller.send(
          `select ${callExpression("attorney_submit_application", {})};`,
        );
        const blocked = await blockedOn(caller.pid);
        await admin.ok("commit;");
        const answer = await pending;
        admin.close();
        caller.close();
        assert.deepEqual(answer.rows, ["denied"]);
        assert.equal(
          one(
            `select profile_state from public.attorney_profiles where id = '${attorney.profile}';`,
          ),
          "applicant",
        );
        out.attorney_suspended_first = {
          waited_on: blocked.waiting,
          outcome: "denied",
        };
      }
      {
        const staff = newStaff();
        const authorisation = newAuthorisation(newAttorney("under_review"));
        const admin = await session("admin");
        const reviewer = await session("reviewer", staff.auth);
        await admin.ok("begin;");
        await admin.ok(
          `update public.users set account_state = 'suspended' where id = '${staff.user}';`,
        );
        const pending = reviewer.send(
          `select ${callExpression("staff_decide_practice_area", decisionArgs(authorisation))};`,
        );
        const blocked = await blockedOn(reviewer.pid);
        await admin.ok("commit;");
        const answer = await pending;
        admin.close();
        reviewer.close();
        assert.deepEqual(answer.rows, ["denied"]);
        out.reviewer_suspended_first = {
          waited_on: blocked.waiting,
          outcome: "denied",
        };
      }
      {
        const attorney = newAttorney("applicant");
        const admin = await session("admin");
        const caller = await session("attorney", attorney.auth);
        await caller.ok("begin;");
        assert.deepEqual(
          await caller.ok(
            `select ${callExpression("attorney_submit_application", {})};`,
          ),
          ["applied"],
        );
        const suspend = admin.send(
          `update public.users set account_state = 'suspended' where id = '${attorney.user}';`,
        );
        const blocked = await blockedOn(admin.pid);
        await caller.ok("commit;");
        assert.equal((await suspend).sqlstate, "00000");
        admin.close();
        caller.close();
        assert.equal(
          one(
            `select profile_state from public.attorney_profiles where id = '${attorney.profile}';`,
          ),
          "under_review",
        );
        out.write_first = {
          suspension_waited_on: blocked.waiting,
          outcome: "applied, then suspended",
        };
      }
      return out;
    },
  );

  await check(
    "C-6 concurrent grant re-scoping or expiry shortening cannot be bypassed: the write rechecks the locked grant row after the change commits and denies",
    async () => {
      const out = {};
      for (const change of [
        `jurisdiction_id = '${J_B}'`,
        "expires_at = clock_timestamp()",
      ]) {
        const staff = newStaff({ grants: [{ jurisdiction: J_A }] });
        const license = newLicense(newAttorney("under_review"), J_A);
        const admin = await session("admin");
        const reviewer = await session("reviewer", staff.auth);
        await admin.ok("begin;");
        await admin.ok(
          `update public.capability_grants set ${change} where id = '${staff.grants[0]}';`,
        );
        const pending = reviewer.send(
          `select ${callExpression("staff_record_verification_finding", findingArgs("license", license, "licenses"))};`,
        );
        const blocked = await blockedOn(reviewer.pid);
        await admin.ok("commit;");
        const answer = await pending;
        admin.close();
        reviewer.close();
        assert.deepEqual(answer.rows, ["denied"], change);
        assert.equal(
          count("verification_evidence_subjects", `license_id = '${license}'`),
          0,
        );
        out[change.split(" ")[0]] = {
          waited_on: blocked.waiting,
          outcome: "denied",
        };
      }
      return out;
    },
  );

  await check(
    "C-7 conflicting target-record changes fail safely: two reviewers deciding one request serialize on its row and exactly one decision and one audit row commit",
    async () => {
      const first = newStaff();
      const second = newStaff();
      const authorisation = newAuthorisation(newAttorney("under_review"));
      const argsFirst = decisionArgs(authorisation);
      const argsSecond = decisionArgs(authorisation, {
        p_decision: "refused",
        p_effective_from: null,
      });
      const one1 = await session("first", first.auth);
      const two = await session("second", second.auth);
      await one1.ok("begin;");
      assert.deepEqual(
        await one1.ok(
          `select ${callExpression("staff_decide_practice_area", argsFirst)};`,
        ),
        ["applied"],
      );
      const pending = two.send(
        `select ${callExpression("staff_decide_practice_area", argsSecond)};`,
      );
      const blocked = await blockedOn(two.pid);
      await one1.ok("commit;");
      const answer = await pending;
      one1.close();
      two.close();
      assert.deepEqual(answer.rows, ["locked"]);
      assert.equal(
        one(
          `select status from public.practice_area_authorisations where id = '${authorisation}';`,
        ),
        "authorised",
      );
      assert.equal(auditCount(`resource_id = '${authorisation}'`), 1);
      return { second_waited_on: blocked.waiting, second_outcome: "locked" };
    },
  );

  await check(
    "C-8 lifecycle conflicts serialize on the Attorney Profile row: a presentation edit waits for a suspension and is then denied; a suspension waits for an edit and then applies",
    async () => {
      const out = {};
      {
        const attorney = newAttorney("approved");
        const staff = newStaff();
        const reviewer = await session("reviewer", staff.auth);
        const caller = await session("attorney", attorney.auth);
        await reviewer.ok("begin;");
        assert.deepEqual(
          await reviewer.ok(
            `select ${callExpression("staff_change_profile_stage", { p_attorney_id: attorney.profile, p_intent: "suspend", p_message: null, p_note: null })};`,
          ),
          ["applied"],
        );
        const pending = caller.send(
          `select ${callExpression("attorney_save_profile_details", { p_expected_state: "approved", p_display_name: "Synthetic", p_headline: null, p_bio: null, p_years_experience: null })};`,
        );
        const blocked = await blockedOn(caller.pid);
        await reviewer.ok("commit;");
        const answer = await pending;
        reviewer.close();
        caller.close();
        assert.deepEqual(answer.rows, ["denied"]);
        assert.equal(
          one(
            `select coalesce(display_name, '') from public.attorney_profiles where id = '${attorney.profile}';`,
          ),
          "",
        );
        out.suspension_first = {
          edit_waited_on: blocked.waiting,
          edit_outcome: "denied",
        };
      }
      {
        const attorney = newAttorney("approved");
        const staff = newStaff();
        const reviewer = await session("reviewer", staff.auth);
        const caller = await session("attorney", attorney.auth);
        await caller.ok("begin;");
        assert.deepEqual(
          await caller.ok(
            `select ${callExpression("attorney_save_profile_details", { p_expected_state: "approved", p_display_name: "Synthetic", p_headline: null, p_bio: null, p_years_experience: null })};`,
          ),
          ["applied"],
        );
        const pending = reviewer.send(
          `select ${callExpression("staff_change_profile_stage", { p_attorney_id: attorney.profile, p_intent: "suspend", p_message: null, p_note: null })};`,
        );
        const blocked = await blockedOn(reviewer.pid);
        await caller.ok("commit;");
        const answer = await pending;
        reviewer.close();
        caller.close();
        assert.deepEqual(answer.rows, ["applied"]);
        assert.equal(
          one(
            `select profile_state || '|' || display_name from public.attorney_profiles where id = '${attorney.profile}';`,
          ),
          "suspended|Synthetic",
        );
        out.edit_first = {
          suspension_waited_on: blocked.waiting,
          suspension_outcome: "applied",
        };
      }
      return out;
    },
  );

  await check(
    "C-9 a lock timeout aborts the whole call with 55P03 and leaves no partial write",
    async () => {
      const staff = newStaff();
      const license = newLicense(newAttorney("under_review"));
      const admin = await session("admin");
      const reviewer = await session("reviewer", staff.auth);
      const before = {
        evidence: count("verification_evidence"),
        audit: auditCount(),
      };
      await admin.ok("begin;");
      await admin.ok(
        `update public.staff_profiles set staff_state = staff_state where user_id = '${staff.user}';`,
      );
      const started = Date.now();
      const answer = await reviewer.send(
        `select ${callExpression("staff_record_verification_finding", findingArgs("license", license, "licenses"))};`,
      );
      const waitedMs = Date.now() - started;
      await admin.ok("rollback;");
      admin.close();
      reviewer.close();
      assert.equal(answer.sqlstate, "55P03", answer.stderr);
      assert.ok(waitedMs >= 2900, String(waitedMs));
      assert.equal(count("verification_evidence"), before.evidence);
      assert.equal(auditCount(), before.audit);
      assert.equal(
        count("verification_evidence_subjects", `license_id = '${license}'`),
        0,
      );
      return {
        sqlstate: answer.sqlstate,
        waited_ms: waitedMs,
        evidence_written: 0,
        audit_written: 0,
      };
    },
  );

  await check(
    "C-10 a deadlock between a protected write and an administrative change aborts the write with 40P01 and leaves no partial write; the administrative change then completes",
    async () => {
      const staff = newStaff();
      const authorisation = newAuthorisation(newAttorney("under_review"));
      const admin = await session("admin", null, [
        "set deadlock_timeout = '10s';",
      ]);
      const reviewer = await session("reviewer", staff.auth, [
        "set deadlock_timeout = '100ms';",
      ]);
      const before = auditCount();
      await admin.ok("begin;");
      await admin.ok(
        `update public.capability_grants set expires_at = expires_at where id = '${staff.grants[0]}';`,
      );
      const pending = reviewer.send(
        `select ${callExpression("staff_decide_practice_area", decisionArgs(authorisation))};`,
      );
      const blocked = await blockedOn(reviewer.pid);
      const adminSecond = admin.send(
        `update public.staff_profiles set staff_state = staff_state where user_id = '${staff.user}';`,
      );
      const answer = await pending;
      assert.equal((await adminSecond).sqlstate, "00000");
      await admin.ok("commit;");
      admin.close();
      reviewer.close();
      assert.equal(answer.sqlstate, "40P01", answer.stderr);
      assert.equal(
        one(
          `select status from public.practice_area_authorisations where id = '${authorisation}';`,
        ),
        "requested",
      );
      assert.equal(auditCount(), before);
      return {
        reviewer_waited_on: blocked.waiting,
        reviewer_sqlstate: answer.sqlstate,
        partial_writes: 0,
      };
    },
  );
}

// Runs body (sync or async) while a test-only trigger makes every write of
// one kind to one table fail, then removes the trigger.
function injectFailure(table, timing) {
  sql(`create function public.p3904_synthetic_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic injected failure' using errcode = 'P0001'; end $$;
       create trigger p3904_synthetic_failure ${timing} on public.${ident(table)} for each row execute function public.p3904_synthetic_failure();`);
  return () =>
    sql(
      `drop trigger p3904_synthetic_failure on public.${ident(table)}; drop function public.p3904_synthetic_failure();`,
    );
}

function withFailure(table, timing, body) {
  const remove = injectFailure(table, timing);
  try {
    return body();
  } finally {
    remove();
  }
}

async function withFailureAsync(table, timing, body) {
  const remove = injectFailure(table, timing);
  try {
    return await body();
  } finally {
    remove();
  }
}

async function atomicityChecks() {
  await check(
    "R3-1 a failed mandatory audit insertion rolls back every domain change (attorney submission, claim, staff finding with status, decision, transition, evaluation)",
    () => {
      const out = {};
      const attorney = newAttorney("applicant");
      const staff = newStaff();
      const reviewed = newAttorney("under_review");
      const license = newLicense(reviewed);
      const authorisation = newAuthorisation(reviewed);
      withFailure("audit_events", "before insert", () => {
        out.submit = fnAs(attorney.auth, "attorney_submit_application");
        out.claim = fnAs(attorney.auth, "attorney_save_license_claim", {
          p_license_id: uid(),
          p_expected_updated_at: null,
          p_jurisdiction_id: J_A,
          p_license_number: "SYN-AUDITFAIL",
          p_license_type: null,
          p_effective_from: null,
          p_effective_until: null,
        });
        out.finding = fnAs(
          staff.auth,
          "staff_record_verification_finding",
          findingArgs("license", license, "licenses", {
            p_observed_status: "synthetic-active",
          }),
        );
        out.decision = fnAs(
          staff.auth,
          "staff_decide_practice_area",
          decisionArgs(authorisation),
        );
        out.transition = fnAs(staff.auth, "staff_change_profile_stage", {
          p_attorney_id: reviewed.profile,
          p_intent: "approve",
          p_message: null,
          p_note: null,
        });
        // A truthful determination (§4.2a), so the call reaches its audit.
        out.evaluation = fnAs(
          staff.auth,
          "staff_record_eligibility_evaluation",
          derivedEvaluationArgs(
            reviewed.profile,
            J_A,
            null,
            new Date().toISOString(),
          ),
        );
      });
      for (const [label, outcome] of Object.entries(out)) {
        assert.equal(outcome, "ERROR P0001", label);
      }
      assert.equal(
        one(
          `select profile_state from public.attorney_profiles where id = '${attorney.profile}';`,
        ),
        "applicant",
      );
      assert.equal(count("licenses", "license_number = 'SYN-AUDITFAIL'"), 0);
      assert.equal(
        one(
          `select coalesce(reported_status, '') from public.licenses where id = '${license}';`,
        ),
        "",
      );
      assert.equal(
        count("verification_evidence_subjects", `license_id = '${license}'`),
        0,
      );
      assert.equal(
        one(
          `select status from public.practice_area_authorisations where id = '${authorisation}';`,
        ),
        "requested",
      );
      assert.equal(
        one(
          `select profile_state from public.attorney_profiles where id = '${reviewed.profile}';`,
        ),
        "under_review",
      );
      assert.equal(
        count("eligibility_evaluations", `attorney_id = '${reviewed.profile}'`),
        0,
      );
      // With auditing restored the same calls apply, each with one audit row.
      assert.equal(
        fnAs(attorney.auth, "attorney_submit_application"),
        "applied",
      );
      assert.equal(auditCount(`resource_id = '${attorney.profile}'`), 1);
      return out;
    },
  );

  await check(
    "R3-2 a failed domain mutation never leaves a success audit: injected failures and unique conflicts write no audit row",
    () => {
      const attorney = newAttorney("applicant");
      const license = newLicense(attorney);
      const before = auditCount();
      const failed = withFailure("licenses", "before update", () =>
        fnAs(attorney.auth, "attorney_save_license_claim", {
          p_license_id: license,
          p_expected_updated_at: updatedAt("licenses", license),
          p_jurisdiction_id: J_A,
          p_license_number: "SYN-CHANGED",
          p_license_type: null,
          p_effective_from: null,
          p_effective_until: null,
        }),
      );
      assert.equal(failed, "ERROR P0001");
      const taken = one(
        `select license_number from public.licenses where id = '${license}';`,
      );
      const duplicate = fnAs(
        newAttorney("applicant").auth,
        "attorney_save_license_claim",
        {
          p_license_id: uid(),
          p_expected_updated_at: null,
          p_jurisdiction_id: J_A,
          p_license_number: taken,
          p_license_type: null,
          p_effective_from: null,
          p_effective_until: null,
        },
      );
      assert.equal(duplicate, "conflict");
      assert.equal(auditCount(), before);
      assert.equal(
        one(
          `select license_number from public.licenses where id = '${license}';`,
        ),
        taken,
      );
      return {
        injected_update_failure: failed,
        duplicate_number: duplicate,
        audit_rows_added: 0,
      };
    },
  );

  await check(
    "R3-3 a failed evidence-subject link rolls back the evidence; a failed status change rolls back the evidence and its link; a discipline finding is all or nothing",
    () => {
      const staff = newStaff();
      const reviewed = newAttorney("under_review");
      const license = newLicense(reviewed);
      const before = {
        evidence: count("verification_evidence"),
        audit: auditCount(),
        discipline: count("discipline_records"),
      };
      const linkFailure = withFailure(
        "verification_evidence_subjects",
        "before insert",
        () =>
          fnAs(
            staff.auth,
            "staff_record_verification_finding",
            findingArgs("license", license, "licenses"),
          ),
      );
      const statusFailure = withFailure("licenses", "before update", () =>
        fnAs(
          staff.auth,
          "staff_record_verification_finding",
          findingArgs("license", license, "licenses", {
            p_observed_status: "synthetic-active",
          }),
        ),
      );
      const disciplineFailure = withFailure(
        "verification_evidence_subjects",
        "before insert",
        () =>
          fnAs(staff.auth, "staff_record_discipline_finding", {
            p_discipline_id: uid(),
            p_evidence_id: uid(),
            p_attorney_id: reviewed.profile,
            p_jurisdiction_id: J_A,
            p_external_reference: "SYN-REF",
            p_finding_type: null,
            p_opened_at: null,
            p_resolved_at: null,
            p_status: "synthetic-open",
            ...EVIDENCE(),
          }),
      );
      assert.equal(linkFailure, "ERROR P0001");
      assert.equal(statusFailure, "ERROR P0001");
      assert.equal(disciplineFailure, "ERROR P0001");
      assert.equal(count("verification_evidence"), before.evidence);
      assert.equal(count("discipline_records"), before.discipline);
      assert.equal(auditCount(), before.audit);
      assert.equal(
        one(
          `select coalesce(reported_status, '') from public.licenses where id = '${license}';`,
        ),
        "",
      );
      // Without failures the discipline finding commits all three rows.
      const args = {
        p_discipline_id: uid(),
        p_evidence_id: uid(),
        p_attorney_id: reviewed.profile,
        p_jurisdiction_id: J_A,
        p_external_reference: "SYN-REF",
        p_finding_type: null,
        p_opened_at: null,
        p_resolved_at: null,
        p_status: "synthetic-open",
        ...EVIDENCE(),
      };
      assert.equal(
        fnAs(staff.auth, "staff_record_discipline_finding", args),
        "applied",
      );
      assert.equal(
        count("discipline_records", `id = '${args.p_discipline_id}'`),
        1,
      );
      assert.equal(
        count(
          "verification_evidence_subjects",
          `verification_evidence_id = '${args.p_evidence_id}' and discipline_record_id = '${args.p_discipline_id}'`,
        ),
        1,
      );
      assert.equal(auditCount(`resource_id = '${args.p_discipline_id}'`), 1);
      return {
        link_failure: linkFailure,
        status_failure: statusFailure,
        discipline_link_failure: disciplineFailure,
        partial_rows: 0,
      };
    },
  );

  await check(
    "R3-4 replayed requests never duplicate consequential records or audit rows",
    () => {
      const attorney = newAttorney("applicant");
      const staff = newStaff();
      const reviewed = newAttorney("under_review");
      const license = newLicense(reviewed);
      const claim = {
        p_license_id: uid(),
        p_expected_updated_at: null,
        p_jurisdiction_id: J_A,
        p_license_number: "SYN-REPLAY",
        p_license_type: null,
        p_effective_from: null,
        p_effective_until: null,
      };
      const finding = findingArgs("license", license, "licenses");
      const area = {
        p_authorisation_id: uid(),
        p_jurisdiction_id: J_A,
        p_practice_area_id: AREA,
      };
      const results = {
        claim: [
          fnAs(attorney.auth, "attorney_save_license_claim", claim),
          fnAs(attorney.auth, "attorney_save_license_claim", claim),
        ],
        practice_area: [
          fnAs(attorney.auth, "attorney_request_practice_area", area),
          fnAs(attorney.auth, "attorney_request_practice_area", area),
        ],
        finding: [
          fnAs(staff.auth, "staff_record_verification_finding", finding),
          fnAs(staff.auth, "staff_record_verification_finding", finding),
        ],
      };
      const version = updatedAt("licenses", claim.p_license_id);
      const revision = {
        ...claim,
        p_expected_updated_at: version,
        p_license_type: "synthetic",
      };
      results.revision = [
        fnAs(attorney.auth, "attorney_save_license_claim", revision),
        fnAs(attorney.auth, "attorney_save_license_claim", revision),
      ];
      assert.deepEqual(results.claim, ["applied", "conflict"]);
      assert.deepEqual(results.practice_area, ["applied", "conflict"]);
      assert.deepEqual(results.finding, ["applied", "conflict"]);
      assert.deepEqual(results.revision, ["applied", "conflict"]);
      assert.equal(count("licenses", "license_number = 'SYN-REPLAY'"), 1);
      assert.equal(auditCount(`resource_id = '${claim.p_license_id}'`), 2);
      assert.equal(
        count("verification_evidence", `id = '${finding.p_evidence_id}'`),
        1,
      );
      assert.equal(auditCount(`resource_id = '${finding.p_evidence_id}'`), 1);
      assert.equal(auditCount(`resource_id = '${area.p_authorisation_id}'`), 1);
      return results;
    },
  );

  await check(
    "R3-5 ambiguous persistence is never reported as success: a lost answer after commit is unconfirmed (the change and its one audit row exist), and a database error is not-saved with nothing written",
    async () => {
      const attorney = newAttorney("applicant");
      const lost = await saveLicenseClaim(
        attorneySources(attorney.auth, { loseAnswers: true }),
        form({ jurisdiction_id: J_A, license_number: "SYN-LOST" }),
      );
      assert.deepEqual(lost, { status: "unconfirmed" });
      assert.equal(count("licenses", "license_number = 'SYN-LOST'"), 1);
      const lostId = one(
        "select id from public.licenses where license_number = 'SYN-LOST';",
      );
      assert.equal(auditCount(`resource_id = '${lostId}'`), 1);
      const failed = await withFailureAsync(
        "audit_events",
        "before insert",
        () =>
          saveLicenseClaim(
            attorneySources(attorney.auth),
            form({ jurisdiction_id: J_A, license_number: "SYN-FAILED" }),
          ),
      );
      assert.deepEqual(failed, { status: "not-saved" });
      assert.equal(count("licenses", "license_number = 'SYN-FAILED'"), 0);
      // The adapter's strict reading of answers.
      const classify = {
        applied: writeResultOf(
          writeAnswerOf({ data: "applied", error: null, status: 200 }),
        ),
        sqlstate_error: writeResultOf(
          writeAnswerOf({ data: null, error: { code: "55P03" }, status: 500 }),
        ),
        connection_error: writeResultOf(
          writeAnswerOf({ data: null, error: { code: "08006" }, status: 503 }),
        ),
        transport_failure: writeResultOf(
          writeAnswerOf({
            data: null,
            error: { code: "EPIPE", message: "fetch failed" },
            status: 0,
          }),
        ),
        gateway_timeout: writeResultOf(
          writeAnswerOf({ data: null, error: { code: "" }, status: 504 }),
        ),
        unexpected_body: writeResultOf(
          writeAnswerOf({ data: "saved", error: null, status: 200 }),
        ),
      };
      assert.deepEqual(classify, {
        applied: "applied",
        sqlstate_error: "rejected",
        connection_error: "unknown",
        transport_failure: "unknown",
        gateway_timeout: "unknown",
        unexpected_body: "unknown",
      });
      return {
        lost_answer: lost.status,
        database_error: "not-saved",
        classify,
      };
    },
  );
}

async function regressionChecks() {
  await check(
    "REG-1 P3-002 applicant creation through the application and its real adapters: one applicant profile for the caller's own active User, repeated and concurrent starts keep one, and no Client Profile or other User is touched",
    async () => {
      const account = newAccount();
      sql(
        `insert into public.client_profiles (user_id) values ('${account.user}');`,
      );
      const start = form({ intent: "start-attorney-application" });
      const created = await startAttorneyApplication(
        applicantSources(account.auth),
        start,
      );
      const again = await startAttorneyApplication(
        applicantSources(account.auth),
        start,
      );
      assert.deepEqual(created, { status: "created" });
      assert.deepEqual(again, { status: "on-record" });
      assert.equal(
        one(
          `select profile_state from public.attorney_profiles where user_id = '${account.user}';`,
        ),
        "applicant",
      );
      assert.equal(count("client_profiles", `user_id = '${account.user}'`), 1);
      const inactive = newAccount("suspended");
      assert.equal(fnAs(inactive.auth, "attorney_start_application"), "[]");
      assert.equal(fnAs(null, "attorney_start_application"), "[]");
      assert.equal(
        count("attorney_profiles", `user_id = '${inactive.user}'`),
        0,
      );
      // Concurrent starts in two sessions: one profile.
      const racer = newAccount();
      const a = await session("start-a", racer.auth);
      const b = await session("start-b", racer.auth);
      await a.ok("begin;");
      const first = await a.ok(
        `select ${callExpression("attorney_start_application", {})};`,
      );
      const pending = b.send(
        `select ${callExpression("attorney_start_application", {})};`,
      );
      await blockedOn(b.pid);
      await a.ok("commit;");
      const second = await pending;
      a.close();
      b.close();
      assert.equal(JSON.parse(first[0]).length, 1);
      assert.equal(second.rows[0], "[]");
      assert.equal(count("attorney_profiles", `user_id = '${racer.user}'`), 1);
      // The application never claims creation for a row of another User.
      return {
        created: created.status,
        repeated: again.status,
        inactive_rows: 0,
        concurrent_profiles: 1,
      };
    },
  );

  await check(
    "REG-2 P3-001 own-row attorney access is unchanged: an attorney reads exactly its own profile and claims and nobody else's",
    () => {
      const a = newAttorney("approved");
      const b = newAttorney("approved");
      newLicense(a);
      newLicense(b);
      const own = as(
        "authenticated",
        a.auth,
        `select (select count(*) from public.attorney_profiles) || '|' || (select count(*) from public.attorney_profiles where id = '${a.profile}') || '|' || (select count(*) from public.licenses where attorney_id = '${b.profile}');`,
      ).value;
      assert.equal(own, "1|1|0");
      return { own_profiles_visible: 1, others_visible: 0 };
    },
  );

  await check(
    "REG-3 P3-003 attorney actions through the application and its real adapters: details, claims, revisions, practice-area request, withdrawal, renewal, and submission save with one audit row each, attributed to the attorney",
    async () => {
      const account = newAccount();
      const created = await startAttorneyApplication(
        applicantSources(account.auth),
        form({ intent: "start-attorney-application" }),
      );
      assert.deepEqual(created, { status: "created" });
      const profile = one(
        `select id from public.attorney_profiles where user_id = '${account.user}';`,
      );
      const sources = attorneySources(account.auth);
      const results = {};
      results.view = (await resolveProfessionalSetup(sources)).status;
      assert.equal(results.view, "ready");
      results.details = (
        await saveProfileDetails(
          sources,
          form({
            display_name: "Synthetic Attorney",
            headline: "Synthetic",
            bio: "Synthetic bio",
            years_experience: "6",
          }),
        )
      ).status;
      results.license = (
        await saveLicenseClaim(
          sources,
          form({
            jurisdiction_id: J_A,
            license_number: "SYN-E2E-1",
            license_type: "synthetic",
            effective_from: "2020-01-01",
          }),
        )
      ).status;
      const licenseId = one(
        `select id from public.licenses where attorney_id = '${profile}' and license_number = 'SYN-E2E-1';`,
      );
      results.license_revision = (
        await saveLicenseClaim(
          sources,
          form({
            record: licenseId,
            jurisdiction_id: J_A,
            license_number: "SYN-E2E-1B",
          }),
        )
      ).status;
      results.insurance = (
        await saveInsuranceClaim(
          sources,
          form({
            jurisdiction_id: J_A,
            carrier_name: "Synthetic carrier",
            per_occurrence_limit_minor: "250000",
            currency_code: "XTS",
          }),
        )
      ).status;
      results.practice_area = (
        await requestPracticeArea(
          sources,
          form({ jurisdiction_id: J_A, practice_area_id: AREA }),
        )
      ).status;
      results.practice_area_duplicate = (
        await requestPracticeArea(
          sources,
          form({ jurisdiction_id: J_A, practice_area_id: AREA }),
        )
      ).status;
      const requestId = one(
        `select id from public.practice_area_authorisations where attorney_id = '${profile}';`,
      );
      results.withdraw = (
        await changePracticeAreaRequest(
          sources,
          form({ intent: "withdraw", record: requestId }),
        )
      ).status;
      results.renew = (
        await changePracticeAreaRequest(
          sources,
          form({ intent: "renew", record: requestId }),
        )
      ).status;
      results.submit = (
        await submitApplicationForReview(
          sources,
          form({ intent: "submit-application-for-review" }),
        )
      ).status;
      results.after_submit_claim = (
        await saveLicenseClaim(
          sources,
          form({ jurisdiction_id: J_A, license_number: "SYN-E2E-2" }),
        )
      ).status;
      assert.deepEqual(results, {
        view: "ready",
        details: "saved",
        license: "saved",
        license_revision: "saved",
        insurance: "saved",
        practice_area: "saved",
        practice_area_duplicate: "invalid",
        withdraw: "saved",
        renew: "saved",
        submit: "saved",
        after_submit_claim: "locked",
      });
      const audit = JSON.parse(
        one(
          `select json_agg(action_code order by occurred_at) from public.audit_events where actor_user_id = '${account.user}';`,
        ),
      );
      assert.deepEqual(audit, [
        "attorney_profile_details_revised",
        "attorney_claim_recorded",
        "attorney_claim_revised",
        "attorney_claim_recorded",
        "practice_area_request_changed",
        "practice_area_request_changed",
        "practice_area_request_changed",
        "attorney_application_submitted",
      ]);
      assert.equal(
        auditCount(
          `actor_user_id = '${account.user}' and actor_type <> 'attorney'`,
        ),
        0,
      );
      return { results, audit };
    },
  );

  await check(
    "REG-4 P3-003 staff actions through the application and its real adapters: finding with observed status, unavailable source, discipline finding, decision, information request shown to the applicant, approval, and immutable T1 -> adverse fact -> T2 evaluations",
    async () => {
      const attorneyAccount = newAccount();
      await startAttorneyApplication(
        applicantSources(attorneyAccount.auth),
        form({ intent: "start-attorney-application" }),
      );
      const profile = one(
        `select id from public.attorney_profiles where user_id = '${attorneyAccount.user}';`,
      );
      const attorney = attorneySources(attorneyAccount.auth);
      assert.equal(
        (
          await saveLicenseClaim(
            attorney,
            form({ jurisdiction_id: J_A, license_number: "SYN-E2E-S1" }),
          )
        ).status,
        "saved",
      );
      assert.equal(
        (
          await requestPracticeArea(
            attorney,
            form({ jurisdiction_id: J_A, practice_area_id: AREA }),
          )
        ).status,
        "saved",
      );
      assert.equal(
        (
          await submitApplicationForReview(
            attorney,
            form({ intent: "submit-application-for-review" }),
          )
        ).status,
        "saved",
      );
      const staffAccount = newStaff();
      const staff = staffSources(staffAccount.auth);
      const licenseId = one(
        `select id from public.licenses where attorney_id = '${profile}';`,
      );
      const requestId = one(
        `select id from public.practice_area_authorisations where attorney_id = '${profile}';`,
      );
      const results = {};
      results.review = (await resolveStaffReview(staff, profile)).status;
      const evidenceForm = (fields) =>
        form({
          source_type: "synthetic register",
          source_reference: "synthetic entry",
          retrieved_at: minute(Date.now() - 3600000),
          verification_method: "synthetic lookup",
          evidence_summary: "synthetic summary",
          outcome: "consistent",
          ...fields,
        });
      results.finding = (
        await recordVerificationFinding(
          staff,
          evidenceForm({
            subject_kind: "license",
            record: licenseId,
            observed_status: "synthetic-active",
          }),
        )
      ).status;
      results.unavailable = (
        await recordSourceUnavailable(
          staff,
          form({
            subject_kind: "license",
            record: licenseId,
            note: "synthetic outage",
          }),
        )
      ).status;
      results.decision = (
        await decidePracticeArea(
          staff,
          form({
            record: requestId,
            decision: "authorised",
            note: "synthetic basis",
            effective_from: minute(Date.now()),
          }),
        )
      ).status;
      results.request_information = (
        await changeProfileStage(
          staff,
          form({
            attorney: profile,
            intent: "request_information",
            message: "Synthetic request for more detail",
          }),
        )
      ).status;
      const view = await resolveProfessionalSetup(attorney);
      results.applicant_sees_message =
        view.status === "ready" &&
        view.informationRequests.length === 1 &&
        view.informationRequests[0].message ===
          "Synthetic request for more detail";
      results.applicant_claim_locked = (
        await saveLicenseClaim(
          attorney,
          form({
            record: licenseId,
            jurisdiction_id: J_A,
            license_number: "SYN-E2E-S1X",
          }),
        )
      ).status;
      assert.equal(
        (
          await submitApplicationForReview(
            attorney,
            form({ intent: "submit-application-for-review" }),
          )
        ).status,
        "saved",
      );
      results.approve = (
        await changeProfileStage(
          staff,
          form({ attorney: profile, intent: "approve" }),
        )
      ).status;
      results.t1 = (
        await recordEligibilityDetermination(
          staff,
          form({
            attorney: profile,
            jurisdiction_id: J_A,
            practice_area_id: "",
          }),
        )
      ).status;
      const t1 = JSON.parse(
        one(
          `select row_to_json(e) from public.eligibility_evaluations e where attorney_id = '${profile}';`,
        ),
      );
      results.discipline = (
        await recordDisciplineFinding(
          staff,
          evidenceForm({
            attorney: profile,
            jurisdiction_id: J_A,
            discipline_status: "synthetic-revoked",
            external_reference: "SYN-ADVERSE",
            outcome: "discrepancy",
          }),
        )
      ).status;
      results.t2 = (
        await recordEligibilityDetermination(
          staff,
          form({
            attorney: profile,
            jurisdiction_id: J_A,
            practice_area_id: "",
          }),
        )
      ).status;
      assert.deepEqual(results, {
        review: "ready",
        finding: "recorded",
        unavailable: "recorded",
        decision: "recorded",
        request_information: "recorded",
        applicant_sees_message: true,
        applicant_claim_locked: "locked",
        approve: "recorded",
        t1: "recorded",
        discipline: "recorded",
        t2: "recorded",
      });
      const evaluations = JSON.parse(
        one(
          `select json_agg(json_build_object('id', id, 'result', result) order by evaluated_at) from public.eligibility_evaluations where attorney_id = '${profile}';`,
        ),
      );
      assert.equal(evaluations.length, 2);
      assert.equal(evaluations[0].id, t1.id);
      assert.equal(evaluations[1].result, "not_eligible");
      assert.deepEqual(
        JSON.parse(
          one(
            `select row_to_json(e) from public.eligibility_evaluations e where id = '${t1.id}';`,
          ),
        ),
        t1,
      );
      assert.equal(
        as(
          "service_role",
          null,
          `update public.eligibility_evaluations set result = 'eligible' where id = '${t1.id}';`,
        ).sqlstate,
        "42501",
      );
      assert.equal(
        as(
          "authenticated",
          staffAccount.auth,
          `update public.eligibility_evaluations set result = 'eligible' where id = '${t1.id}';`,
        ).sqlstate,
        "42501",
      );
      assert.equal(
        one(
          `select reported_status from public.licenses where id = '${licenseId}';`,
        ),
        "synthetic-active",
      );
      assert.equal(
        one(
          `select string_agg(distinct retrieved_by_user_id::text, ',') from public.verification_evidence e join public.verification_evidence_subjects s on s.verification_evidence_id = e.id left join public.licenses l on l.id = s.license_id left join public.discipline_records d on d.id = s.discipline_record_id where coalesce(l.attorney_id, d.attorney_id) = '${profile}';`,
        ),
        staffAccount.user,
      );
      const staffAudit = JSON.parse(
        one(
          `select json_agg(action_code order by occurred_at) from public.audit_events where actor_user_id = '${staffAccount.user}' and actor_type = 'staff';`,
        ),
      );
      assert.deepEqual(staffAudit, [
        "verification_evidence_recorded",
        "verification_source_unavailable",
        "practice_area_authorisation_decided",
        "attorney_information_requested",
        "attorney_profile_state_changed",
        "eligibility_evaluation_recorded",
        "discipline_record_recorded",
        "eligibility_evaluation_recorded",
      ]);
      return {
        results,
        evaluations: evaluations.map((e) => e.result),
        staff_audit: staffAudit,
      };
    },
  );

  await check(
    "REG-5 the historical migration inventory is byte-for-byte unchanged after the run",
    () => {
      const files = inventory();
      assert.deepEqual(
        files.slice(0, 14),
        HISTORICAL.map((entry) => [...entry]),
      );
      assert.equal(files.length, 15);
      report.migrations.historical_verified_after = 14;
      return { historical: 14, p3_904: files[14] };
    },
  );
}

async function main() {
  try {
    startCluster();
  } catch (error) {
    report.refused = String(error?.message ?? error);
    teardown();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(3);
  }
  let failed = false;
  try {
    applyMigrations();
    seed();
    await privilegeChecks();
    await predicateChecks();
    await authorizationMatrix();
    await concurrencyChecks();
    await atomicityChecks();
    await regressionChecks();
  } catch (error) {
    report.error = String(error?.stack ?? error);
    failed = true;
  }
  const cleaned = teardown();
  report.cleanup = cleaned ? "removed" : "FAILED";
  failed ||= report.checks.some((c) => c.result !== "PASS");
  report.summary = {
    checks: report.checks.length,
    passed: report.checks.filter((c) => c.result === "PASS").length,
    failed: report.checks.filter((c) => c.result !== "PASS").length,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(!cleaned ? 2 : failed ? 1 : 0);
}

await main();
