// P5-001 disposable PostgreSQL security and integrity proof. Explicitly
// invoked only:
//
//   node apps/web/tests/p5-001-db-proof.mjs
//
// Deliberately not a *.test.mjs file, so no application test run, p0:test,
// or CI job starts it. It uses Node built-ins, the system-installed
// PostgreSQL 16 initdb, pg_ctl, and psql binaries, and the application's own
// TypeScript modules (loaded by Node's type stripping).
//
// It creates a new mode-0700 temporary directory, initializes a new cluster
// in it owned by an unprivileged account (never root), and starts it with TCP
// disabled and a private Unix-domain socket. The roles anon, authenticated,
// and service_role (BYPASSRLS), the synthetic auth schema (auth.users and an
// auth.uid() that reads request.jwt.claim.sub, as PostgREST sets it from the
// verified JWT), the hosted platform's default privileges, and a no-op
// public.rls_auto_enable() are synthetic objects of this cluster only. The
// fifteen accepted migrations are checked byte-for-byte against the canonical
// inventory and applied unmodified, in order, each in one transaction,
// followed by the single P5-001 migration.
//
// The probes cover the P5-001 Packet section 11 failure tests: table and
// function privileges; own-client isolation; principal states; immutability;
// configuration publication authority, validation, digest and audit;
// version selection and draft continuation; every answer and description
// rule, including the practice-area "Not sure" contract; rate limits;
// deterministic interleavings of separately controlled PostgreSQL sessions,
// observed through pg_stat_activity and pg_locks; atomic audit under injected
// failure; historical meaning after later publications; rollback-only
// application and catalog reconciliation on representative state; and the
// application's own modules and real adapters driven against this database.
// No Supabase project, network service, or pre-existing cluster is
// contacted, nothing persists after the run, and every value is synthetic
// test data. The JSON report goes to stdout; exit 0 means PASS, 1 FAIL,
// 2 cleanup failure, 3 refused to start.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  closeIntake as closeIntakeAction,
  resolveClientWorkspace,
  resolveIntake,
  saveIntakeRevision,
  startIntake,
  submitIntake as submitIntakeAction,
} from "../src/application/client-intake.ts";
import {
  createClientIntakeReads,
  createClientIntakeWrites,
} from "../src/infrastructure/client/client-intake-adapter.ts";
import { createClientPrincipalSource } from "../src/infrastructure/identity/client-principal-source.ts";
import { createRequestAccountSource } from "../src/infrastructure/professional/professional-request-client.ts";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54335;
const DB = "rosuno_p5_001_proof";
const REPOSITORY_ROOT = path.resolve(
  path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
  "../../..",
);
const MIGRATIONS = path.join(REPOSITORY_ROOT, "supabase/migrations");

// The canonical inventory of the fifteen accepted migrations.
const ACCEPTED = Object.freeze([
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
  [
    "20261106090000_p3_904_professional_write_boundary.sql",
    "7f05e4066a245471a8e33d5cfb27a539373eb75b270a17990afced441e4ebbe1",
  ],
]);
const P5_001_MIGRATION = "20261115140653_p5_001_client_intake_foundation.sql";
// MVP-001 S1 re-pin: the merged P5-001 migration bytes (owner main).
const P5_001_SHA256 =
  "104b76bb3933369619c8dbc7112277ec449648bbf7839280900194bf8b20c17b";

// The adopted initial configuration version (P5-001 Packet section 4): its
// exact canonical PostgreSQL jsonb text and SHA-256.
const V1_KEY = "intake-questions-v1";
const V1_SHA256 =
  "31a3245be9ecb6135f93e5141bd9d2314c7f30fb8cfd3389d5e8645fbfbdf395";
const V1_TEXT = fs.readFileSync(
  path.join(
    REPOSITORY_ROOT,
    "apps/web/tests/fixtures/intake-questions-v1.canonical.txt",
  ),
  "utf8",
);
const V1 = JSON.parse(V1_TEXT);

const CLIENT_FUNCTIONS = Object.freeze([
  "client_create_intake()",
  "client_save_intake_revision(uuid, integer, uuid, uuid, text, jsonb)",
  "client_submit_intake(uuid, integer)",
  "client_close_intake(uuid)",
  "client_intake_practice_areas()",
  "client_intake_jurisdictions()",
  "staff_publish_intake_question_set(text, jsonb)",
]);
const HELPER_FUNCTIONS = Object.freeze([
  "intake_reject_mutation()",
  "intake_label_ok(jsonb, integer)",
  "intake_json_int_within(jsonb, numeric, numeric)",
  "intake_json_keys(jsonb)",
  "intake_json_keys_within(jsonb, text[], text[])",
  "intake_json_array_length(jsonb)",
  "intake_definition_problem(jsonb)",
  "intake_answers_problem(jsonb, jsonb, uuid, boolean)",
  "lock_current_client()",
  "lock_current_intake_configuration_staff()",
  "intake_rate_exceeded(uuid, text, jsonb)",
]);
const INTAKE_RELATIONS = Object.freeze([
  "intakes",
  "jurisdiction_assessments",
  "intake_revisions",
  "intake_question_sets",
]);

const report = {
  proof: "P5-001 disposable local PostgreSQL security and integrity proof",
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
function as(role, sub, statement, { commit = true, setup = "" } = {}) {
  const result = psql(
    [
      "begin;",
      setup,
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

// Typed literals for the named function arguments.
const ARG_TYPES = Object.freeze({
  p_intake_id: "uuid",
  p_expected_revision: "integer",
  p_question_set_id: "uuid",
  p_practice_area_id: "uuid",
  p_description: "text",
  p_answers: "jsonb",
  p_version_key: "text",
  p_definition: "jsonb",
});

function argLiteral(name, value) {
  const type = ARG_TYPES[name];
  assert.ok(type, `unknown argument ${name}`);
  if (value === null || value === undefined) {
    return `null::${type}`;
  }
  if (type === "jsonb") {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return `${lit(text)}::jsonb`;
  }
  return `${lit(value)}::${type}`;
}

function namedArgs(args) {
  return Object.entries(args)
    .map(([name, value]) => `${ident(name)} => ${argLiteral(name, value)}`)
    .join(", ");
}

const RETURNS_SET = new Set([
  "client_create_intake",
  "client_save_intake_revision",
  "client_intake_practice_areas",
  "client_intake_jurisdictions",
  "staff_publish_intake_question_set",
]);

function callExpression(name, args) {
  ident(name);
  return RETURNS_SET.has(name)
    ? `(select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from public.${name}(${namedArgs(args)}) as r)`
    : `public.${name}(${namedArgs(args)})`;
}

// A function called as a principal (authenticated role, JWT subject): its
// value, or "ERROR <sqlstate>".
function fnAs(sub, name, args = {}, options = {}) {
  const result = as(
    options.role ?? "authenticated",
    sub,
    `select ${callExpression(name, args)};`,
    options,
  );
  return result.ok ? result.value : `ERROR ${result.sqlstate}`;
}

// The single row a set-returning function answered, or { error }.
function rowAs(sub, name, args = {}, options = {}) {
  const value = fnAs(sub, name, args, options);
  if (value.startsWith("ERROR")) {
    return { error: value };
  }
  const rows = JSON.parse(value);
  assert.equal(rows.length, 1, `${name}: exactly one answer row`);
  return rows[0];
}

function rowsAs(sub, name, args = {}) {
  const value = fnAs(sub, name, args);
  assert.ok(!value.startsWith("ERROR"), value);
  return JSON.parse(value);
}

function count(table, where = "true") {
  return Number(
    sql(`select count(*) from public.${ident(table)} where ${where};`),
  );
}

function one(statement) {
  return sql(statement);
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rosuno-p5-001-db-proof-"));
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
      "select json_build_object('version', current_setting('server_version'), 'listen_addresses', current_setting('listen_addresses'), 'tcp', inet_server_addr() is not null, 'default_transaction_isolation', current_setting('default_transaction_isolation'))::text;",
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

function applyFile(db, file, singleTransaction = true) {
  const args = psqlArgs(db);
  const result = run(
    "psql",
    singleTransaction ? [...args, "-1"] : args,
    fs.readFileSync(path.join(MIGRATIONS, file), "utf8"),
  );
  assert.equal(result.status, 0, `${file}: ${result.stderr}`);
}

function applyMigrations() {
  const files = inventory();
  // MVP-001 S1 re-pin: the fifteen accepted migrations and P5-001 stay an
  // exact, byte-checked prefix; only later migrations registered in the
  // migration register may follow, and they are applied after it.
  assert.ok(files.length >= 16, "fifteen accepted and one P5-001 migration");
  assert.deepEqual(
    files.slice(0, 15),
    ACCEPTED.map((entry) => [...entry]),
  );
  assert.equal(files[15][0], P5_001_MIGRATION);
  assert.equal(files[15][1], P5_001_SHA256, "P5-001 bytes are unchanged");
  const registered = new Set(
    JSON.parse(
      fs.readFileSync(
        path.join(
          REPOSITORY_ROOT,
          "governance/migrations/reviewed-migrations.json",
        ),
        "utf8",
      ),
    ).migrations.map((migration) => migration.artifact_path),
  );
  for (const [file] of files.slice(16)) {
    assert.ok(
      registered.has(`supabase/migrations/${file}`),
      `${file} is not a registered later migration`,
    );
  }
  report.migrations.accepted_verified_before = 15;
  report.migrations.p5_001 = { file: files[15][0], sha256: files[15][1] };
  report.migrations.later_registered = files.slice(16).map(([file]) => file);
  sql(FIXTURE, "postgres");
  for (const [file] of files) {
    applyFile(DB, file);
  }
  report.migrations.applied = files.map(([file]) => file);
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
    const mark = `__P5001_${this.label}_${this.n}__`;
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

async function session(label, sub = null) {
  const s = await new Session(label).open();
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

let sequence = 5000;
const uid = () =>
  `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
const J_A = uid();
const J_B = uid();
const J_C = uid();
const J_HEX = "abcdef00-0000-4000-8000-00000000abcd";
const AREA_1 = uid();
const AREA_2 = uid();
const AREA_OFF = uid();
let GRANTOR = null;

function newAccount(accountState = "active") {
  const auth = uid();
  const user = uid();
  sql(`insert into auth.users (id) values ('${auth}');
       insert into public.users (id, auth_user_id, account_state) values ('${user}', '${auth}', '${accountState}');`);
  return { auth, user };
}

function newClient(accountState = "active") {
  const account = newAccount(accountState);
  const client = uid();
  sql(
    `insert into public.client_profiles (id, user_id) values ('${client}', '${account.user}');`,
  );
  return { ...account, client };
}

function newStaff({
  staffState = "active",
  accountState = "active",
  grants = [{}],
} = {}) {
  const ids = newAccount(accountState);
  sql(
    `insert into public.staff_profiles (user_id, staff_state) values ('${ids.user}', '${staffState}');`,
  );
  for (const g of grants) {
    const columns = {
      id: lit(uid()),
      user_id: lit(ids.user),
      capability_code: lit(g.capability ?? "manage_intake_configuration"),
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
  }
  return ids;
}

function seed() {
  sql(`insert into public.jurisdictions (id, code, name, region_type, lifecycle_state) values
         ('${J_A}', 'SYN_A', 'Synthetic State A', 'state', 'ready'),
         ('${J_B}', 'SYN_B', 'Synthetic State B', 'state', 'unsupported'),
         ('${J_C}', 'SYN_C', 'Synthetic State C', 'state', 'suspended'),
         ('${J_HEX}', 'SYN_HEX', 'Synthetic State Hex', 'state', 'staged');
       insert into public.practice_areas (id, code, name, active) values
         ('${AREA_1}', 'SYN_FAMILY', 'Synthetic Family', true),
         ('${AREA_2}', 'SYN_HOUSING', 'Synthetic Housing', true),
         ('${AREA_OFF}', 'SYN_RETIRED', 'Synthetic Retired', false);`);
  const grantor = newAccount();
  sql(
    `insert into public.staff_profiles (user_id, staff_state) values ('${grantor.user}', 'active');`,
  );
  GRANTOR = grantor.user;
}

// ---------------------------------------------------------------------------
// Operation helpers
// ---------------------------------------------------------------------------

function createIntake(principal) {
  return rowAs(principal.auth, "client_create_intake");
}

function save(principal, intake, fields) {
  return rowAs(principal.auth, "client_save_intake_revision", {
    p_intake_id: intake,
    p_expected_revision: fields.expected ?? null,
    p_question_set_id: fields.questionSet,
    p_practice_area_id: fields.practiceArea ?? null,
    p_description: fields.description ?? null,
    p_answers: fields.answers === undefined ? {} : fields.answers,
  });
}

function submit(principal, intake, expected) {
  return fnAs(principal.auth, "client_submit_intake", {
    p_intake_id: intake,
    p_expected_revision: expected,
  });
}

function closeIntake(principal, intake) {
  return fnAs(principal.auth, "client_close_intake", { p_intake_id: intake });
}

function publish(principal, key, definition) {
  return rowAs(principal.auth, "staff_publish_intake_question_set", {
    p_version_key: key,
    p_definition: definition,
  });
}

function questionSetId(key) {
  return one(
    `select id from public.intake_question_sets where version_key = ${lit(key)};`,
  );
}

function currentQuestionSetId() {
  return one(
    "select id from public.intake_question_sets order by published_at desc limit 1;",
  );
}

// Complete v1 answers (practice area selected in the column).
function v1Answers(overrides = {}) {
  return {
    jurisdictions: [J_A],
    court_case: "no",
    assistance_type: "understand_options",
    ...overrides,
  };
}

function revisionsOf(intake) {
  return JSON.parse(
    one(
      `select coalesce(json_agg(r order by r.revision_number), '[]'::json)::text from (select revision_number, question_set_id, practice_area_id, description, structured_answers, created_at from public.intake_revisions where intake_id = '${intake}') r;`,
    ),
  );
}

function intakeState(intake) {
  return one(`select state from public.intakes where id = '${intake}';`);
}

// A draft owned by a fresh client, with one saved v1 revision.
function draftWithRevision(principal = newClient(), fields = {}) {
  const created = createIntake(principal);
  assert.equal(created.outcome, "created");
  const saved = save(principal, created.intake_id, {
    questionSet: fields.questionSet ?? currentQuestionSetId(),
    practiceArea:
      fields.practiceArea === undefined ? AREA_1 : fields.practiceArea,
    description: fields.description ?? "Synthetic description.",
    answers: fields.answers ?? v1Answers(),
  });
  assert.equal(saved.outcome, "saved", JSON.stringify(saved));
  return { principal, intake: created.intake_id };
}

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

const tablePrivilege = (role, table, privilege) =>
  one(
    `select has_table_privilege('${role}', 'public.${table}', '${privilege}');`,
  ) === "t";

const functionExecutable = (role, signature) =>
  one(
    `select has_function_privilege('${role}', 'public.${signature}', 'execute');`,
  ) === "t";

async function privilegeChecks() {
  await check(
    "PRIV-1 no API role can insert, update, delete, truncate, reference or trigger the four intake relations; authenticated keeps SELECT; service_role has no access to the two new relations",
    () => {
      for (const table of INTAKE_RELATIONS) {
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
              tablePrivilege(role, table, privilege),
              false,
              `${role} ${privilege} ${table}`,
            );
          }
        }
        assert.equal(tablePrivilege("authenticated", table, "SELECT"), true);
        assert.equal(tablePrivilege("anon", table, "SELECT"), false);
      }
      for (const table of ["intake_revisions", "intake_question_sets"]) {
        assert.equal(tablePrivilege("service_role", table, "SELECT"), false);
      }
      return { relations: INTAKE_RELATIONS };
    },
  );

  await check(
    "PRIV-2 client and publication functions are SECURITY DEFINER with search_path pg_catalog and executable by authenticated only; every helper is executable by no API role",
    () => {
      for (const signature of CLIENT_FUNCTIONS) {
        assert.equal(functionExecutable("authenticated", signature), true);
        assert.equal(functionExecutable("anon", signature), false);
        assert.equal(functionExecutable("service_role", signature), false);
        assert.equal(
          one(
            `select prosecdef::text || '|' || array_to_string(proconfig, ',') from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          "true|search_path=pg_catalog",
          signature,
        );
      }
      for (const signature of HELPER_FUNCTIONS) {
        for (const role of ["anon", "authenticated", "service_role"]) {
          assert.equal(
            functionExecutable(role, signature),
            false,
            `${role} ${signature}`,
          );
        }
        assert.equal(
          one(
            `select prosecdef::text || '|' || array_to_string(proconfig, ',') from pg_proc where oid = 'public.${signature}'::regprocedure;`,
          ),
          "false|search_path=pg_catalog",
          signature,
        );
      }
      return {
        definer_functions: CLIENT_FUNCTIONS.length,
        helpers: HELPER_FUNCTIONS.length,
      };
    },
  );

  await check(
    "PRIV-3 RLS is enabled on both new relations, and the migration inserted exactly one capability code and no question set, grant, catalog or business row",
    () => {
      for (const table of ["intake_revisions", "intake_question_sets"]) {
        assert.equal(
          one(
            `select relrowsecurity from pg_class where oid = 'public.${table}'::regclass;`,
          ),
          "t",
        );
      }
      assert.equal(
        one(
          "select string_agg(capability_code, ',' order by capability_code) from public.capability_definitions;",
        ),
        // MVP-001 S1 re-pin: exactly the four capability codes of the later
        // registered S1 configuration-administration migration follow.
        [
          "authorize_jurisdiction_launch",
          "manage_attorney_verification",
          "manage_intake_configuration",
          "manage_jurisdiction_configuration",
          "manage_policy_configuration",
          "manage_staff_capabilities",
        ].join(","),
      );
      for (const table of [
        "intake_question_sets",
        "intake_revisions",
        "capability_grants",
        "intakes",
        "jurisdictions",
        "practice_areas",
        "audit_events",
      ]) {
        assert.equal(count(table), 0, `${table} is empty after migration`);
      }
      return { capability_codes: 6 };
    },
  );

  await check(
    "PRIV-4 anon cannot execute any intake function or read any intake relation",
    () => {
      for (const name of [
        "client_create_intake",
        "client_intake_jurisdictions",
        "client_intake_practice_areas",
      ]) {
        assert.equal(
          fnAs(null, name, {}, { role: "anon" }),
          "ERROR 42501",
          name,
        );
      }
      for (const table of INTAKE_RELATIONS) {
        const result = as(
          "anon",
          null,
          `select count(*) from public.${table};`,
        );
        assert.equal(result.sqlstate, "42501", table);
      }
    },
  );
}

const ROWS_BEFORE_PUBLICATION = {};

async function publicationChecks() {
  const client = newClient();
  const authorized = newStaff();

  await check(
    "PUB-1 with no published version, creating an Intake is unavailable and stores nothing",
    () => {
      assert.deepEqual(createIntake(client), {
        outcome: "unavailable",
        intake_id: null,
      });
      assert.equal(count("intakes"), 0);
      assert.equal(count("audit_events"), 0);
    },
  );

  await check(
    "PUB-2 publication is forbidden without a valid global grant: client, no grant, other capability, expired, revoked, not yet granted, jurisdiction-scoped, resource-scoped, deactivated staff, suspended User; nothing is stored",
    () => {
      const cases = {
        client,
        no_grant: newStaff({ grants: [] }),
        other_capability: newStaff({
          grants: [{ capability: "manage_attorney_verification" }],
        }),
        expired: newStaff({
          grants: [
            {
              grantedAt: "now() - interval '2 days'",
              expiresAt: "now() - interval '1 day'",
            },
          ],
        }),
        revoked: newStaff({
          grants: [{ revokedAt: "now() - interval '1 hour'" }],
        }),
        future: newStaff({
          grants: [
            {
              grantedAt: "now() + interval '1 day'",
              expiresAt: "now() + interval '2 days'",
            },
          ],
        }),
        jurisdiction_scoped: newStaff({ grants: [{ jurisdiction: J_A }] }),
        resource_scoped: newStaff({
          grants: [{ resourceScope: { scope: "synthetic" } }],
        }),
        deactivated_staff: newStaff({ staffState: "deactivated" }),
        suspended_user: newStaff({ accountState: "suspended" }),
      };
      for (const [label, principal] of Object.entries(cases)) {
        assert.deepEqual(
          publish(principal, V1_KEY, V1_TEXT),
          { outcome: "forbidden", question_set_id: null },
          label,
        );
      }
      assert.equal(count("intake_question_sets"), 0);
      assert.equal(count("audit_events"), 0);
      return { refused: Object.keys(cases) };
    },
  );

  await check(
    "PUB-3 the authorized staff User publishes intake-questions-v1; the stored definition::text is byte-identical to the adopted fixture, its SHA-256 equals the Packet value, and exactly one audit event records the version key and digest without content",
    () => {
      assert.equal(
        createHash("sha256").update(V1_TEXT, "utf8").digest("hex"),
        V1_SHA256,
        "fixture bytes",
      );
      const published = publish(authorized, V1_KEY, V1_TEXT);
      assert.equal(published.outcome, "published");
      const stored = one(
        `select definition::text from public.intake_question_sets where id = '${published.question_set_id}';`,
      );
      assert.equal(stored, V1_TEXT);
      assert.equal(
        one(
          `select encode(sha256(convert_to(definition::text, 'UTF8')), 'hex') from public.intake_question_sets where id = '${published.question_set_id}';`,
        ),
        V1_SHA256,
      );
      const audit = JSON.parse(
        one(
          "select json_agg(json_build_object('actor', actor_user_id, 'actor_type', actor_type, 'action', action_code, 'resource_type', resource_type, 'resource', resource_id, 'before', before_snapshot, 'after', after_snapshot))::text from public.audit_events;",
        ),
      );
      assert.deepEqual(audit, [
        {
          actor: authorized.user,
          actor_type: "staff",
          action: "intake_question_set_published",
          resource_type: "intake_question_set",
          resource: published.question_set_id,
          before: null,
          after: { version_key: V1_KEY, definition_sha256: V1_SHA256 },
        },
      ]);
      return {
        version_key: V1_KEY,
        definition_sha256: V1_SHA256,
        bytes: Buffer.byteLength(stored, "utf8"),
      };
    },
  );

  await check(
    "PUB-4 a duplicate version key is duplicate_version and a malformed key is invalid; nothing is stored",
    () => {
      assert.equal(
        publish(authorized, V1_KEY, V1_TEXT).outcome,
        "duplicate_version",
      );
      for (const key of [null, "", "V1", "-x", "a b", "x".repeat(65), "ab"]) {
        assert.equal(
          publish(authorized, key, V1_TEXT).outcome,
          "invalid",
          String(key),
        );
      }
      assert.equal(count("intake_question_sets"), 1);
    },
  );

  await check(
    "PUB-5 every format-1 rule rejects a definition that breaks it, as invalid and never as an error, and stores nothing",
    () => {
      const clone = () => structuredClone(V1);
      const variants = {
        not_object: [],
        missing_top_key: (() => {
          const d = clone();
          delete d.limits;
          return d;
        })(),
        extra_top_key: { ...clone(), extra: 1 },
        format_2: { ...clone(), format: 2 },
        format_string: { ...clone(), format: "1" },
        no_questions: { ...clone(), questions: [] },
        questions_object: { ...clone(), questions: {} },
        too_many_questions: {
          ...clone(),
          questions: Array.from({ length: 21 }, (_, i) => ({
            id: `q_${i}`,
            kind: "single_choice",
            prompt: "Synthetic?",
            required: false,
            choices: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          })),
        },
        bad_question_id: (() => {
          const d = clone();
          d.questions[2].id = "Court";
          return d;
        })(),
        duplicate_question_id: (() => {
          const d = clone();
          d.questions[3].id = "court_case";
          return d;
        })(),
        unknown_kind: (() => {
          const d = clone();
          d.questions[2].kind = "free_text";
          return d;
        })(),
        question_extra_key: (() => {
          const d = clone();
          d.questions[2].order = 1;
          return d;
        })(),
        prompt_too_long: (() => {
          const d = clone();
          d.questions[2].prompt = "x".repeat(201);
          return d;
        })(),
        prompt_control: (() => {
          const d = clone();
          d.questions[2].prompt = "Line\nbreak";
          return d;
        })(),
        prompt_leading_space: (() => {
          const d = clone();
          d.questions[2].prompt = " Leading";
          return d;
        })(),
        required_string: (() => {
          const d = clone();
          d.questions[2].required = "true";
          return d;
        })(),
        one_choice: (() => {
          const d = clone();
          d.questions[2].choices = [{ id: "yes", label: "Yes" }];
          return d;
        })(),
        duplicate_choice: (() => {
          const d = clone();
          d.questions[2].choices[1].id = "yes";
          return d;
        })(),
        choice_extra_key: (() => {
          const d = clone();
          d.questions[2].choices[0].hint = "x";
          return d;
        })(),
        choice_on_catalog: (() => {
          const d = clone();
          d.questions[0].choices = [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ];
          return d;
        })(),
        not_sure_on_choice: (() => {
          const d = clone();
          d.questions[2].not_sure_label = "Not sure";
          return d;
        })(),
        missing_not_sure_label: (() => {
          const d = clone();
          delete d.questions[1].not_sure_label;
          return d;
        })(),
        two_practice_area_questions: (() => {
          const d = clone();
          d.questions.push({ ...d.questions[0], id: "practice_area_two" });
          return d;
        })(),
        description_missing_prompt: (() => {
          const d = clone();
          delete d.description.prompt;
          return d;
        })(),
        description_required_string: (() => {
          const d = clone();
          d.description.required = "no";
          return d;
        })(),
        description_limit_over_ceiling: (() => {
          const d = clone();
          d.limits.description_max_characters = 20001;
          return d;
        })(),
        answers_limit_under_floor: (() => {
          const d = clone();
          d.limits.structured_answers_max_bytes = 255;
          return d;
        })(),
        limit_fraction: (() => {
          const d = clone();
          d.limits.description_max_characters = 1.5;
          return d;
        })(),
        limit_string: (() => {
          const d = clone();
          d.limits.description_max_characters = "4000";
          return d;
        })(),
        rate_window_too_short: (() => {
          const d = clone();
          d.limits.revision_saves_per_client.window_seconds = 59;
          return d;
        })(),
        rate_extra_key: (() => {
          const d = clone();
          d.limits.intake_starts_per_client.burst = 2;
          return d;
        })(),
        reused_id_other_kind: {
          ...clone(),
          questions: [
            {
              id: "court_case",
              kind: "jurisdictions",
              prompt: "Synthetic?",
              required: true,
              not_sure_label: "Not sure",
            },
          ],
        },
      };
      let n = 0;
      for (const [label, definition] of Object.entries(variants)) {
        n += 1;
        const answer = publish(
          authorized,
          `synthetic-invalid-${n}`,
          definition,
        );
        assert.deepEqual(
          answer,
          { outcome: "invalid", question_set_id: null },
          label,
        );
      }
      assert.equal(count("intake_question_sets"), 1);
      assert.equal(count("audit_events"), 1);
      return { rejected_variants: Object.keys(variants).length };
    },
  );

  await check(
    "PUB-6 published versions are immutable: UPDATE, DELETE and TRUNCATE fail for the owner (trigger, 55000) and for every API role (42501)",
    () => {
      for (const statement of [
        "update public.intake_question_sets set version_key = 'changed-v1';",
        "delete from public.intake_question_sets;",
        "truncate public.intake_question_sets cascade;",
      ]) {
        const owner = psql(statement);
        assert.notEqual(owner.status, 0, statement);
        assert.equal(sqlstateOf(owner.stderr), "55000", statement);
        for (const role of ["authenticated", "service_role"]) {
          const result = as(role, authorized.auth, statement);
          assert.equal(result.sqlstate, "42501", `${role}: ${statement}`);
        }
      }
      assert.equal(
        one("select definition::text from public.intake_question_sets;"),
        V1_TEXT,
      );
    },
  );

  ROWS_BEFORE_PUBLICATION.authorized = authorized;
}

async function clientFlowChecks() {
  const v1 = questionSetId(V1_KEY);

  await check(
    "FLOW-1 a client creates a draft, saves several revisions, submits and closes it; every revision is preserved, stated jurisdictions become unreviewed client-statement assessments, and the lifecycle audit carries no intake content",
    () => {
      const client = newClient();
      const created = createIntake(client);
      assert.equal(created.outcome, "created");
      const intake = created.intake_id;
      assert.equal(intakeState(intake), "draft");
      const first = save(client, intake, {
        questionSet: v1,
        practiceArea: AREA_1,
        answers: { court_case: "yes" },
      });
      assert.deepEqual(first, { outcome: "saved", revision_number: 1 });
      const second = save(client, intake, {
        expected: 1,
        questionSet: v1,
        practiceArea: AREA_1,
        description: "Synthetic words\nacross two lines.",
        answers: v1Answers({ jurisdictions: [J_B, J_A] }),
      });
      assert.deepEqual(second, { outcome: "saved", revision_number: 2 });
      assert.equal(submit(client, intake, 2), "submitted");
      assert.equal(intakeState(intake), "submitted");
      const revisions = revisionsOf(intake);
      assert.equal(revisions.length, 2);
      assert.deepEqual(revisions[0].structured_answers, { court_case: "yes" });
      assert.equal(
        revisions[1].description,
        "Synthetic words\nacross two lines.",
      );
      const assessments = JSON.parse(
        one(
          `select json_agg(json_build_object('j', jurisdiction_id, 'basis', assessment_basis, 'source', source_type, 'review', review_status, 'ai', ai_suggestion_id, 'reviewed_at', reviewed_at) order by created_at, jurisdiction_id)::text from public.jurisdiction_assessments where intake_id = '${intake}';`,
        ),
      );
      assert.deepEqual(assessments.map((a) => a.j).sort(), [J_A, J_B].sort());
      for (const a of assessments) {
        assert.equal(
          a.basis,
          "client_statement:intake_revision:2:question_set:intake-questions-v1",
        );
        assert.equal(a.source, "client_statement");
        assert.equal(a.review, "unreviewed");
        assert.equal(a.ai, null);
        assert.equal(a.reviewed_at, null);
      }
      assert.equal(closeIntake(client, intake), "closed");
      assert.equal(intakeState(intake), "closed");
      assert.equal(
        one(
          `select closed_at is not null from public.intakes where id = '${intake}';`,
        ),
        "t",
      );
      assert.equal(revisionsOf(intake).length, 2, "closure preserves content");
      const audit = JSON.parse(
        one(
          `select json_agg(json_build_object('action', action_code, 'actor', actor_user_id, 'actor_type', actor_type, 'before', before_snapshot, 'after', after_snapshot) order by occurred_at, action_code)::text from public.audit_events where resource_id = '${intake}';`,
        ),
      );
      assert.deepEqual(
        audit.map((a) => a.action),
        [
          "client_intake_created",
          "client_intake_submitted",
          "client_intake_closed",
        ],
      );
      for (const a of audit) {
        assert.equal(a.actor, client.user);
        assert.equal(a.actor_type, "client");
      }
      assert.deepEqual(audit[1].after, {
        state: "submitted",
        revision_number: 2,
        question_set: V1_KEY,
      });
      const auditText = JSON.stringify(audit);
      for (const fragment of ["Synthetic words", "court_case", AREA_1, J_A]) {
        assert.ok(!auditText.includes(fragment), `audit excludes ${fragment}`);
      }
      return { revisions: 2, assessments: assessments.length };
    },
  );

  await check(
    "FLOW-2 replays and lifecycle guards: submit replay is already_submitted, a replay naming another revision is conflict, close replay is already_closed, and no save or submit follows submission or closure",
    () => {
      const { principal, intake } = draftWithRevision();
      assert.equal(submit(principal, intake, 1), "submitted");
      assert.equal(submit(principal, intake, 1), "already_submitted");
      assert.equal(submit(principal, intake, 2), "conflict");
      assert.equal(
        save(principal, intake, {
          expected: 1,
          questionSet: v1,
          practiceArea: AREA_2,
          answers: v1Answers(),
        }).outcome,
        "not_editable",
      );
      assert.equal(closeIntake(principal, intake), "closed");
      assert.equal(closeIntake(principal, intake), "already_closed");
      assert.equal(submit(principal, intake, 1), "not_editable");
      assert.equal(
        save(principal, intake, {
          expected: 1,
          questionSet: v1,
          practiceArea: AREA_2,
          answers: v1Answers(),
        }).outcome,
        "not_editable",
      );
      assert.equal(revisionsOf(intake).length, 1);
      assert.equal(
        count("jurisdiction_assessments", `intake_id = '${intake}'`),
        1,
        "replays add no assessment",
      );
      const draft = draftWithRevision();
      assert.equal(closeIntake(draft.principal, draft.intake), "closed");
      assert.equal(revisionsOf(draft.intake).length, 1);
    },
  );

  await check(
    "FLOW-3 stale writes never displace content: a save naming a stale or missing expected revision is conflict, a submit naming a stale revision is conflict, a submit with no revision is incomplete, and an unchanged save is refused; nothing is stored",
    () => {
      const { principal, intake } = draftWithRevision();
      const base = {
        questionSet: v1,
        practiceArea: AREA_2,
        answers: v1Answers(),
      };
      assert.equal(
        save(principal, intake, { ...base, expected: null }).outcome,
        "conflict",
      );
      assert.equal(
        save(principal, intake, { ...base, expected: 2 }).outcome,
        "conflict",
      );
      assert.equal(submit(principal, intake, 2), "conflict");
      assert.equal(submit(principal, intake, null), "conflict");
      assert.deepEqual(
        save(principal, intake, {
          expected: 1,
          questionSet: v1,
          practiceArea: AREA_1,
          description: "Synthetic description.",
          answers: v1Answers(),
        }),
        { outcome: "unchanged", revision_number: null },
      );
      assert.equal(revisionsOf(intake).length, 1);
      const empty = newClient();
      const created = createIntake(empty);
      assert.equal(submit(empty, created.intake_id, null), "incomplete");
      assert.equal(intakeState(created.intake_id), "draft");
    },
  );
}

async function practiceAreaChecks() {
  const v1 = questionSetId(V1_KEY);

  await check(
    "PA-1 (Packet section 11) a required practice-area question answered Not sure submits; the revision keeps a null practice area with the not_sure answer, and no AI suggestion or category-derived record is created beyond the stated-jurisdiction assessments",
    () => {
      const client = newClient();
      const intake = createIntake(client).intake_id;
      const answers = v1Answers({
        practice_area: "not_sure",
        assistance_type: "not_sure",
      });
      assert.equal(
        save(client, intake, { questionSet: v1, practiceArea: null, answers })
          .outcome,
        "saved",
      );
      const suggestionsBefore = count("ai_suggestions");
      assert.equal(submit(client, intake, 1), "submitted");
      const [revision] = revisionsOf(intake);
      assert.equal(revision.practice_area_id, null);
      assert.deepEqual(revision.structured_answers, answers);
      assert.equal(count("ai_suggestions"), suggestionsBefore);
      assert.equal(
        count("jurisdiction_assessments", `intake_id = '${intake}'`),
        1,
      );
      assert.equal(
        one(
          `select jurisdiction_id from public.jurisdiction_assessments where intake_id = '${intake}';`,
        ),
        J_A,
      );
    },
  );

  await check(
    "PA-2 a required practice-area question left unanswered (no practice area and no not_sure answer) is incomplete at submission",
    () => {
      const client = newClient();
      const intake = createIntake(client).intake_id;
      assert.equal(
        save(client, intake, {
          questionSet: v1,
          practiceArea: null,
          answers: v1Answers(),
        }).outcome,
        "saved",
      );
      assert.equal(submit(client, intake, 1), "incomplete");
      assert.equal(intakeState(intake), "draft");
      assert.equal(
        count("jurisdiction_assessments", `intake_id = '${intake}'`),
        0,
      );
    },
  );

  await check(
    "PA-3 a save with both a selected practice area and the not_sure answer is invalid, and nothing is stored",
    () => {
      const client = newClient();
      const intake = createIntake(client).intake_id;
      assert.equal(
        save(client, intake, {
          questionSet: v1,
          practiceArea: AREA_1,
          answers: v1Answers({ practice_area: "not_sure" }),
        }).outcome,
        "invalid",
      );
      assert.equal(revisionsOf(intake).length, 0);
    },
  );
}

// Test-only versions, published by the authorized staff User during the run.
function definitionWith(mutate) {
  const definition = structuredClone(V1);
  mutate(definition);
  return definition;
}

async function versionChecks() {
  const v1 = questionSetId(V1_KEY);
  const authorized = ROWS_BEFORE_PUBLICATION.authorized;
  const pinnedV1 = draftWithRevision();
  const pinnedV1Revisions = revisionsOf(pinnedV1.intake);
  const preserved = draftWithRevision();

  await check(
    "VER-1 a new version with changed wording publishes without code change and becomes current; drafts pinned to v1 are unchanged and may continue under v1",
    () => {
      const v2Definition = definitionWith((d) => {
        d.questions[2].prompt = "Has a court case already started?";
      });
      const v2 = publish(
        authorized,
        "intake-questions-v2-synthetic",
        v2Definition,
      );
      assert.equal(v2.outcome, "published");
      assert.equal(currentQuestionSetId(), v2.question_set_id);
      assert.deepEqual(revisionsOf(pinnedV1.intake), pinnedV1Revisions);
      assert.deepEqual(
        save(pinnedV1.principal, pinnedV1.intake, {
          expected: 1,
          questionSet: v1,
          practiceArea: AREA_2,
          answers: v1Answers(),
        }),
        { outcome: "saved", revision_number: 2 },
        "continue under governing v1",
      );
      return { current: "intake-questions-v2-synthetic" };
    },
  );

  await check(
    "VER-2 a save may cite only the governing or the current version: an older non-governing, unknown or null version is version_not_allowed, a first save must cite the current version, and an explicit switch moves the draft forward without touching earlier revisions",
    () => {
      const v2 = questionSetId("intake-questions-v2-synthetic");
      const fresh = newClient();
      const intake = createIntake(fresh).intake_id;
      assert.equal(
        save(fresh, intake, {
          questionSet: v1,
          practiceArea: AREA_1,
          answers: v1Answers(),
        }).outcome,
        "version_not_allowed",
        "first save must cite current",
      );
      for (const questionSet of [uid(), null]) {
        assert.equal(
          save(fresh, intake, {
            questionSet,
            practiceArea: AREA_1,
            answers: v1Answers(),
          }).outcome,
          "version_not_allowed",
        );
      }
      assert.equal(revisionsOf(intake).length, 0);
      const before = revisionsOf(pinnedV1.intake);
      assert.deepEqual(
        save(pinnedV1.principal, pinnedV1.intake, {
          expected: 2,
          questionSet: v2,
          practiceArea: AREA_2,
          answers: v1Answers({ court_case: "yes" }),
        }),
        { outcome: "saved", revision_number: 3 },
        "explicit switch to current",
      );
      assert.deepEqual(revisionsOf(pinnedV1.intake).slice(0, 2), before);
      assert.equal(
        save(pinnedV1.principal, pinnedV1.intake, {
          expected: 3,
          questionSet: v1,
          practiceArea: AREA_2,
          answers: v1Answers(),
        }).outcome,
        "version_not_allowed",
        "after switching, v1 is neither governing nor current",
      );
      const v3 = publish(
        authorized,
        "intake-questions-v3-synthetic",
        definitionWith((d) => {
          d.questions[3].prompt = "What help are you looking for?";
        }),
      );
      assert.equal(v3.outcome, "published");
      assert.equal(
        save(preserved.principal, preserved.intake, {
          expected: 1,
          questionSet: v2,
          practiceArea: AREA_1,
          answers: v1Answers(),
        }).outcome,
        "version_not_allowed",
        "v2 is neither governing (v1) nor current (v3)",
      );
    },
  );

  await check(
    "VER-3 a draft pinned to a superseded version is submitted under it, and every stored revision still validates against its own governing version",
    () => {
      assert.equal(
        submit(preserved.principal, preserved.intake, 1),
        "submitted",
      );
      assert.equal(
        one(
          "select count(*) from public.intake_revisions as r join public.intake_question_sets as s on s.id = r.question_set_id where public.intake_answers_problem(s.definition, r.structured_answers, r.practice_area_id, false) is not null;",
        ),
        "0",
      );
      return {
        revisions: count("intake_revisions"),
        versions: count("intake_question_sets"),
      };
    },
  );

  await check(
    "PA-4 (Packet section 11) under a test version whose practice-area question is optional, leaving it unanswered submits",
    () => {
      const optional = publish(
        authorized,
        "synthetic-optional-practice-area",
        definitionWith((d) => {
          d.questions[0].required = false;
        }),
      );
      assert.equal(optional.outcome, "published");
      const client = newClient();
      const intake = createIntake(client).intake_id;
      assert.equal(
        save(client, intake, {
          questionSet: optional.question_set_id,
          practiceArea: null,
          answers: v1Answers(),
        }).outcome,
        "saved",
      );
      assert.equal(submit(client, intake, 1), "submitted");
    },
  );

  await check(
    "PA-5 (Packet section 11) under a test version without a practice-area question, a save with a practice area or a not_sure answer is invalid, and submission succeeds without either",
    () => {
      const none = publish(
        authorized,
        "synthetic-no-practice-area",
        definitionWith((d) => {
          d.questions.splice(0, 1);
        }),
      );
      assert.equal(none.outcome, "published");
      const client = newClient();
      const intake = createIntake(client).intake_id;
      for (const fields of [
        { practiceArea: AREA_1, answers: v1Answers() },
        {
          practiceArea: null,
          answers: v1Answers({ practice_area: "not_sure" }),
        },
      ]) {
        assert.equal(
          save(client, intake, { questionSet: none.question_set_id, ...fields })
            .outcome,
          "invalid",
        );
      }
      assert.equal(revisionsOf(intake).length, 0);
      assert.equal(
        save(client, intake, {
          questionSet: none.question_set_id,
          practiceArea: null,
          answers: v1Answers(),
        }).outcome,
        "saved",
      );
      assert.equal(submit(client, intake, 1), "submitted");
    },
  );

  await check(
    "PA-6 (Packet section 11) a selected practice area deactivated after saving returns needs_update at submit; a new revision answering Not sure then submits, and the earlier revision is unchanged",
    () => {
      const current = currentQuestionSetId();
      const area = uid();
      sql(
        `insert into public.practice_areas (id, code, name, active) values ('${area}', 'SYN_TEMP', 'Synthetic Temporary', true);`,
      );
      const client = newClient();
      const intake = createIntake(client).intake_id;
      // The current version has no practice-area question; publish one that
      // has, then save under it.
      const withArea = publish(
        authorized,
        "synthetic-practice-area-again",
        structuredClone(V1),
      );
      assert.equal(withArea.outcome, "published");
      assert.notEqual(withArea.question_set_id, current);
      assert.equal(
        save(client, intake, {
          questionSet: withArea.question_set_id,
          practiceArea: area,
          answers: v1Answers(),
        }).outcome,
        "saved",
      );
      sql(
        `update public.practice_areas set active = false where id = '${area}';`,
      );
      assert.equal(submit(client, intake, 1), "needs_update");
      assert.equal(intakeState(intake), "draft");
      const first = revisionsOf(intake)[0];
      assert.equal(
        save(client, intake, {
          expected: 1,
          questionSet: withArea.question_set_id,
          practiceArea: area,
          answers: v1Answers({ court_case: "yes" }),
        }).outcome,
        "invalid",
        "an inactive practice area cannot be newly saved",
      );
      assert.equal(
        save(client, intake, {
          expected: 1,
          questionSet: withArea.question_set_id,
          practiceArea: null,
          answers: v1Answers({ practice_area: "not_sure" }),
        }).outcome,
        "saved",
      );
      assert.equal(submit(client, intake, 2), "submitted");
      assert.deepEqual(revisionsOf(intake)[0], first);
      assert.equal(first.practice_area_id, area);
    },
  );
}

async function isolationChecks() {
  await check(
    "ISO-1 another client cannot save, submit or close a foreign Intake; a foreign and a non-existent Intake give the same not_found outcome; nothing changes",
    () => {
      const owner = draftWithRevision();
      const other = newClient();
      const current = currentQuestionSetId();
      for (const target of [owner.intake, uid()]) {
        assert.equal(
          save(other, target, {
            questionSet: current,
            practiceArea: AREA_1,
            answers: v1Answers(),
          }).outcome,
          "not_found",
        );
        assert.equal(submit(other, target, 1), "not_found");
        assert.equal(closeIntake(other, target), "not_found");
      }
      assert.equal(intakeState(owner.intake), "draft");
      assert.equal(revisionsOf(owner.intake).length, 1);
    },
  );

  await check(
    "ISO-2 row policies show each client only their own Intakes, revisions and assessments",
    () => {
      const owner = draftWithRevision();
      assert.equal(submit(owner.principal, owner.intake, 1), "submitted");
      const other = newClient();
      const where = `intake_id = '${owner.intake}'`;
      const seen = (principal, table, condition) =>
        as(
          "authenticated",
          principal.auth,
          `select count(*) from public.${table} where ${condition};`,
        ).value;
      assert.equal(
        seen(owner.principal, "intakes", `id = '${owner.intake}'`),
        "1",
      );
      assert.equal(seen(owner.principal, "intake_revisions", where), "1");
      assert.equal(
        seen(owner.principal, "jurisdiction_assessments", where),
        "1",
      );
      assert.equal(seen(other, "intakes", `id = '${owner.intake}'`), "0");
      assert.equal(seen(other, "intake_revisions", where), "0");
      assert.equal(seen(other, "jurisdiction_assessments", where), "0");
      assert.equal(seen(other, "intake_revisions", "true"), "0");
    },
  );

  await check(
    "ISO-3 attorney-only and staff-only principals hold no client context: create is refused as unavailable, every Intake operation is not_found, and the catalog reads return nothing",
    () => {
      const owner = draftWithRevision();
      const attorneyOnly = newAccount();
      sql(
        `insert into public.attorney_profiles (user_id, profile_state) values ('${attorneyOnly.user}', 'applicant');`,
      );
      const staffOnly = newStaff();
      for (const principal of [attorneyOnly, staffOnly]) {
        assert.deepEqual(createIntake(principal), {
          outcome: "unavailable",
          intake_id: null,
        });
        assert.equal(
          save(principal, owner.intake, {
            questionSet: currentQuestionSetId(),
            practiceArea: AREA_1,
            answers: v1Answers(),
          }).outcome,
          "not_found",
        );
        assert.equal(submit(principal, owner.intake, 1), "not_found");
        assert.equal(closeIntake(principal, owner.intake), "not_found");
        assert.deepEqual(
          rowsAs(principal.auth, "client_intake_practice_areas"),
          [],
        );
        assert.deepEqual(
          rowsAs(principal.auth, "client_intake_jurisdictions"),
          [],
        );
      }
      assert.equal(intakeState(owner.intake), "draft");
    },
  );

  await check(
    "ISO-4 principal state: a pending, suspended or closed User, a User without a Client Profile, and a missing subject are refused; a client whose User is later suspended can no longer act on an existing Intake",
    () => {
      for (const accountState of [
        "pending_verification",
        "suspended",
        "closed",
      ]) {
        const principal = newClient(accountState);
        assert.equal(
          createIntake(principal).outcome,
          "unavailable",
          accountState,
        );
      }
      const noProfile = newAccount();
      assert.equal(createIntake(noProfile).outcome, "unavailable");
      assert.deepEqual(
        rowAs(null, "client_create_intake"),
        { outcome: "unavailable", intake_id: null },
        "no subject",
      );
      const owner = draftWithRevision();
      sql(
        `update public.users set account_state = 'suspended' where id = '${owner.principal.user}';`,
      );
      assert.equal(submit(owner.principal, owner.intake, 1), "not_found");
      assert.equal(closeIntake(owner.principal, owner.intake), "not_found");
      assert.equal(intakeState(owner.intake), "draft");
    },
  );

  await check(
    "ISO-5 neither service_role nor authenticated can write the four intake relations directly",
    () => {
      const owner = draftWithRevision();
      const statements = [
        `insert into public.intakes (client_id, state) values ('${owner.principal.client}', 'draft');`,
        `update public.intakes set state = 'closed' where id = '${owner.intake}';`,
        `delete from public.intakes where id = '${owner.intake}';`,
        `insert into public.jurisdiction_assessments (intake_id, jurisdiction_id) values ('${owner.intake}', '${J_A}');`,
        `update public.intake_revisions set description = 'x';`,
        `delete from public.intake_revisions;`,
        `insert into public.intake_revisions (intake_id, revision_number, question_set_id, structured_answers) values ('${owner.intake}', 9, '${currentQuestionSetId()}', '{"court_case":"no"}');`,
        `insert into public.intake_question_sets (version_key, definition, published_at) values ('synthetic-direct', '{}', now());`,
      ];
      for (const role of ["service_role", "authenticated"]) {
        for (const statement of statements) {
          const result = as(role, owner.principal.auth, statement);
          assert.equal(result.sqlstate, "42501", `${role}: ${statement}`);
        }
      }
      assert.equal(intakeState(owner.intake), "draft");
      assert.equal(revisionsOf(owner.intake).length, 1);
    },
  );

  await check(
    "IMM-1 revisions are immutable: UPDATE, DELETE and TRUNCATE fail for the owner through the trigger (55000)",
    () => {
      const owner = draftWithRevision();
      const before = revisionsOf(owner.intake);
      for (const statement of [
        `update public.intake_revisions set description = 'changed' where intake_id = '${owner.intake}';`,
        `delete from public.intake_revisions where intake_id = '${owner.intake}';`,
        "truncate public.intake_revisions;",
      ]) {
        const result = psql(statement);
        assert.notEqual(result.status, 0, statement);
        assert.equal(sqlstateOf(result.stderr), "55000", statement);
      }
      assert.deepEqual(revisionsOf(owner.intake), before);
    },
  );
}

async function validationChecks() {
  await check(
    "VAL-1 every answer and description rule refuses invalid input as invalid, never as an error, and stores nothing",
    () => {
      const current = currentQuestionSetId();
      assert.equal(
        one(
          `select definition ? 'questions' and definition -> 'questions' -> 0 ->> 'kind' = 'practice_area' from public.intake_question_sets where id = '${current}';`,
        ),
        "t",
        "the current version has the v1 question shape",
      );
      const client = newClient();
      const intake = createIntake(client).intake_id;
      const base = {
        questionSet: current,
        practiceArea: AREA_1,
        answers: v1Answers(),
      };
      const cases = {
        unknown_question: { answers: v1Answers({ extra: "x" }) },
        unknown_choice: { answers: v1Answers({ court_case: "maybe" }) },
        choice_not_string: { answers: v1Answers({ court_case: true }) },
        jurisdictions_empty: { answers: v1Answers({ jurisdictions: [] }) },
        jurisdictions_duplicate: {
          answers: v1Answers({ jurisdictions: [J_A, J_A] }),
        },
        jurisdictions_uppercase: {
          answers: v1Answers({ jurisdictions: [J_HEX.toUpperCase()] }),
        },
        jurisdictions_not_uuid: {
          answers: v1Answers({ jurisdictions: ["SYN_A"] }),
        },
        jurisdictions_unknown: {
          answers: v1Answers({ jurisdictions: [uid()] }),
        },
        jurisdictions_object: {
          answers: v1Answers({ jurisdictions: { a: 1 } }),
        },
        jurisdictions_number: { answers: v1Answers({ jurisdictions: [1] }) },
        jurisdictions_too_many: {
          answers: v1Answers({
            jurisdictions: Array.from({ length: 51 }, () => uid()),
          }),
        },
        practice_area_answer_other: {
          practiceArea: null,
          answers: v1Answers({ practice_area: "unsure" }),
        },
        answers_array: { answers: [] },
        answers_null: { answers: null },
        answers_too_large: { answers: { court_case: "x".repeat(5000) } },
        description_blank: { description: "   " },
        description_too_long: { description: "x".repeat(4001) },
        description_control: { description: "bell\u0007" },
        practice_area_inactive: { practiceArea: AREA_OFF },
        practice_area_unknown: { practiceArea: uid() },
        empty_content: { practiceArea: null, answers: {} },
      };
      for (const [label, fields] of Object.entries(cases)) {
        const answer = save(client, intake, { ...base, ...fields });
        assert.deepEqual(
          answer,
          { outcome: "invalid", revision_number: null },
          label,
        );
      }
      assert.equal(revisionsOf(intake).length, 0);
      assert.equal(
        save(client, intake, { ...base, description: "x".repeat(4000) })
          .outcome,
        "saved",
        "a description at the configured limit is accepted",
      );
      return { rejected: Object.keys(cases).length };
    },
  );

  await check(
    "CAT-1 renaming a practice area leaves stored revisions unchanged; the caller's own revisions keep a deactivated practice area visible to that caller only, flagged inactive",
    () => {
      const area = uid();
      sql(
        `insert into public.practice_areas (id, code, name, active) values ('${area}', 'SYN_RENAME', 'Synthetic Before', true);`,
      );
      const owner = draftWithRevision(newClient(), {
        questionSet: currentQuestionSetId(),
        practiceArea: area,
      });
      const before = revisionsOf(owner.intake);
      sql(
        `update public.practice_areas set name = 'Synthetic After', active = false where id = '${area}';`,
      );
      assert.deepEqual(revisionsOf(owner.intake), before);
      const ownView = rowsAs(
        owner.principal.auth,
        "client_intake_practice_areas",
      );
      assert.deepEqual(
        ownView.find((row) => row.id === area),
        {
          id: area,
          code: "SYN_RENAME",
          name: "Synthetic After",
          active: false,
        },
      );
      const otherView = rowsAs(
        newClient().auth,
        "client_intake_practice_areas",
      );
      assert.equal(
        otherView.find((row) => row.id === area),
        undefined,
      );
      assert.equal(
        otherView.find((row) => row.id === AREA_OFF),
        undefined,
      );
      assert.ok(otherView.every((row) => row.active === true));
      const jurisdictions = rowsAs(
        owner.principal.auth,
        "client_intake_jurisdictions",
      );
      assert.deepEqual(
        jurisdictions.map((row) => row.id).sort(),
        [J_A, J_B, J_C, J_HEX].sort(),
      );
    },
  );
}

async function concurrencyChecks() {
  await check(
    "CON-1 two concurrent saves naming the same expected revision: the second waits on the first client's row lock and then answers conflict; exactly one revision is added",
    async () => {
      const owner = draftWithRevision();
      const current = currentQuestionSetId();
      const args = (description) =>
        callExpression("client_save_intake_revision", {
          p_intake_id: owner.intake,
          p_expected_revision: 1,
          p_question_set_id: current,
          p_practice_area_id: AREA_2,
          p_description: description,
          p_answers: v1Answers(),
        });
      const a = await session("a", owner.principal.auth);
      const b = await session("b", owner.principal.auth);
      try {
        await a.ok("begin;");
        assert.match(
          (await a.ok(`select ${args("First writer.")};`))[0],
          /"saved"/,
        );
        const pending = b.send(`select ${args("Second writer.")};`);
        const blocked = await blockedOn(b.pid);
        assert.ok(blocked.blockers.includes(a.pid));
        assert.match(blocked.waiting, /tuple|transactionid/);
        await a.ok("commit;");
        const answer = await pending;
        assert.equal(answer.sqlstate, "00000", answer.stderr);
        assert.match(answer.rows[0], /"conflict"/);
      } finally {
        a.close();
        b.close();
      }
      const revisions = revisionsOf(owner.intake);
      assert.equal(revisions.length, 2);
      assert.equal(revisions[1].description, "First writer.");
    },
  );

  await check(
    "CON-2 a save racing a submit, and a save racing a close, are serialized on the Intake: the save waits, then answers not_editable; no revision follows the transition",
    async () => {
      for (const transition of ["submit", "close"]) {
        const owner = draftWithRevision();
        const a = await session(`t_${transition}`, owner.principal.auth);
        const b = await session(`s_${transition}`, owner.principal.auth);
        try {
          await a.ok("begin;");
          const call =
            transition === "submit"
              ? callExpression("client_submit_intake", {
                  p_intake_id: owner.intake,
                  p_expected_revision: 1,
                })
              : callExpression("client_close_intake", {
                  p_intake_id: owner.intake,
                });
          await a.ok(`select ${call};`);
          const pending = b.send(
            `select ${callExpression("client_save_intake_revision", {
              p_intake_id: owner.intake,
              p_expected_revision: 1,
              p_question_set_id: currentQuestionSetId(),
              p_practice_area_id: AREA_2,
              p_description: null,
              p_answers: v1Answers(),
            })};`,
          );
          const blocked = await blockedOn(b.pid);
          assert.ok(blocked.blockers.includes(a.pid), transition);
          await a.ok("commit;");
          const answer = await pending;
          assert.match(answer.rows[0], /"not_editable"/, transition);
        } finally {
          a.close();
          b.close();
        }
        assert.equal(revisionsOf(owner.intake).length, 1, transition);
      }
    },
  );

  await check(
    "CON-3 two concurrent publications are serialized on the table lock and receive distinct, ordered published_at values",
    async () => {
      const authorized = ROWS_BEFORE_PUBLICATION.authorized;
      const a = await session("pub_a", authorized.auth);
      const b = await session("pub_b", authorized.auth);
      const call = (key) =>
        `select ${callExpression("staff_publish_intake_question_set", {
          p_version_key: key,
          p_definition: V1,
        })};`;
      try {
        await a.ok("begin;");
        assert.match(
          (await a.ok(call("synthetic-concurrent-a")))[0],
          /"published"/,
        );
        const pending = b.send(call("synthetic-concurrent-b"));
        const blocked = await blockedOn(b.pid);
        assert.ok(blocked.blockers.includes(a.pid));
        assert.match(blocked.waiting, /relation:ShareRowExclusiveLock/);
        await a.ok("commit;");
        const answer = await pending;
        assert.match(answer.rows[0], /"published"/);
      } finally {
        a.close();
        b.close();
      }
      assert.equal(
        one(
          "select (select published_at from public.intake_question_sets where version_key = 'synthetic-concurrent-a') < (select published_at from public.intake_question_sets where version_key = 'synthetic-concurrent-b');",
        ),
        "t",
      );
      assert.equal(
        currentQuestionSetId(),
        questionSetId("synthetic-concurrent-b"),
      );
    },
  );
}

async function rateLimitChecks() {
  const authorized = ROWS_BEFORE_PUBLICATION.authorized;

  await check(
    "RL-1 rolling per-client limits from the current version: the third Intake start and the fourth save within the window are rate_limited, store nothing and leave earlier content intact; other clients are unaffected",
    () => {
      const limited = publish(
        authorized,
        "synthetic-rate-limits",
        definitionWith((d) => {
          d.limits.intake_starts_per_client = { max: 2, window_seconds: 3600 };
          d.limits.revision_saves_per_client = { max: 3, window_seconds: 3600 };
        }),
      );
      assert.equal(limited.outcome, "published");
      const client = newClient();
      const first = createIntake(client);
      const second = createIntake(client);
      assert.equal(first.outcome, "created");
      assert.equal(second.outcome, "created");
      assert.deepEqual(createIntake(client), {
        outcome: "rate_limited",
        intake_id: null,
      });
      assert.equal(count("intakes", `client_id = '${client.client}'`), 2);
      const fields = (n) => ({
        expected: n === 0 ? null : n,
        questionSet: limited.question_set_id,
        practiceArea: AREA_1,
        description: `Synthetic revision ${n + 1}.`,
        answers: v1Answers(),
      });
      for (let n = 0; n < 3; n += 1) {
        assert.equal(save(client, first.intake_id, fields(n)).outcome, "saved");
      }
      assert.deepEqual(save(client, second.intake_id, fields(0)), {
        outcome: "rate_limited",
        revision_number: null,
      });
      assert.equal(revisionsOf(first.intake_id).length, 3);
      assert.equal(revisionsOf(second.intake_id).length, 0);
      const other = newClient();
      assert.equal(createIntake(other).outcome, "created");
    },
  );

  await check(
    "CON-4 the save limit is exact under concurrency: with two saves already in the window, two concurrent saves on different Intakes of one client yield exactly one saved and one rate_limited",
    async () => {
      const client = newClient();
      const current = currentQuestionSetId();
      const intakes = [
        createIntake(client).intake_id,
        createIntake(client).intake_id,
      ];
      assert.equal(
        save(client, intakes[0], {
          questionSet: current,
          practiceArea: AREA_1,
          answers: v1Answers(),
        }).outcome,
        "saved",
      );
      assert.equal(
        save(client, intakes[0], {
          expected: 1,
          questionSet: current,
          practiceArea: AREA_2,
          answers: v1Answers(),
        }).outcome,
        "saved",
      );
      const call = (intake, expected) =>
        `select ${callExpression("client_save_intake_revision", {
          p_intake_id: intake,
          p_expected_revision: expected,
          p_question_set_id: current,
          p_practice_area_id: AREA_1,
          p_description: "Concurrent.",
          p_answers: v1Answers(),
        })};`;
      const a = await session("rl_a", client.auth);
      const b = await session("rl_b", client.auth);
      try {
        await a.ok("begin;");
        assert.match((await a.ok(call(intakes[0], 2)))[0], /"saved"/);
        const pending = b.send(call(intakes[1], null));
        const blocked = await blockedOn(b.pid);
        assert.ok(blocked.blockers.includes(a.pid));
        await a.ok("commit;");
        const answer = await pending;
        assert.match(answer.rows[0], /"rate_limited"/);
      } finally {
        a.close();
        b.close();
      }
      assert.equal(
        count(
          "intake_revisions",
          `intake_id in ('${intakes[0]}', '${intakes[1]}')`,
        ),
        3,
      );
    },
  );

  await check(
    "RL-2 publishing an unlimited-enough version restores ordinary limits for later checks",
    () => {
      const restored = publish(
        authorized,
        "synthetic-ordinary-limits",
        structuredClone(V1),
      );
      assert.equal(restored.outcome, "published");
    },
  );
}

async function atomicityChecks() {
  await check(
    "AT-1 an injected audit failure rolls back create, submit, close and publication entirely",
    () => {
      sql(`create function public.synthetic_fail_audit() returns trigger language plpgsql as $$
           begin
             if new.action_code = current_setting('synthetic.fail_action', true) then
               raise exception 'synthetic audit failure' using errcode = 'P0001';
             end if;
             return new;
           end $$;
           create trigger synthetic_fail_audit before insert on public.audit_events
             for each row execute function public.synthetic_fail_audit();`);
      try {
        const fail = (action) =>
          `select set_config('synthetic.fail_action', '${action}', true) is not null;`;
        const client = newClient();
        const intakesBefore = count("intakes");
        const created = as(
          "authenticated",
          client.auth,
          `select ${callExpression("client_create_intake", {})};`,
          { setup: fail("client_intake_created") },
        );
        assert.equal(created.sqlstate, "P0001");
        assert.equal(count("intakes"), intakesBefore);

        const owner = draftWithRevision();
        const assessmentsBefore = count("jurisdiction_assessments");
        const submitted = as(
          "authenticated",
          owner.principal.auth,
          `select ${callExpression("client_submit_intake", { p_intake_id: owner.intake, p_expected_revision: 1 })};`,
          { setup: fail("client_intake_submitted") },
        );
        assert.equal(submitted.sqlstate, "P0001");
        assert.equal(intakeState(owner.intake), "draft");
        assert.equal(count("jurisdiction_assessments"), assessmentsBefore);

        const closed = as(
          "authenticated",
          owner.principal.auth,
          `select ${callExpression("client_close_intake", { p_intake_id: owner.intake })};`,
          { setup: fail("client_intake_closed") },
        );
        assert.equal(closed.sqlstate, "P0001");
        assert.equal(intakeState(owner.intake), "draft");

        const versionsBefore = count("intake_question_sets");
        const published = as(
          "authenticated",
          ROWS_BEFORE_PUBLICATION.authorized.auth,
          `select ${callExpression("staff_publish_intake_question_set", { p_version_key: "synthetic-atomic", p_definition: V1 })};`,
          { setup: fail("intake_question_set_published") },
        );
        assert.equal(published.sqlstate, "P0001");
        assert.equal(count("intake_question_sets"), versionsBefore);
      } finally {
        sql(`drop trigger synthetic_fail_audit on public.audit_events;
             drop function public.synthetic_fail_audit();`);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Rollback-only application and catalog reconciliation on representative
// state (the accepted fifteen migrations with existing intake rows).
// ---------------------------------------------------------------------------

const CATALOG = `
select json_build_object(
  'functions', (select json_object_agg(p.oid::regprocedure::text, json_build_object(
      'src', md5(p.prosrc), 'definer', p.prosecdef, 'config', p.proconfig,
      'volatility', p.provolatile, 'acl', p.proacl::text,
      'owner', pg_get_userbyid(p.proowner), 'result', pg_get_function_result(p.oid),
      'comment', obj_description(p.oid, 'pg_proc')))
    from pg_proc as p where p.pronamespace = 'public'::regnamespace),
  'relations', (select json_object_agg(c.relname, json_build_object(
      'kind', c.relkind, 'acl', c.relacl::text, 'rls', c.relrowsecurity,
      'force_rls', c.relforcerowsecurity, 'comment', obj_description(c.oid, 'pg_class')))
    from pg_class as c where c.relnamespace = 'public'::regnamespace),
  'columns', (select json_object_agg(c.relname || '.' || a.attname, json_build_object(
      'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull,
      'default', pg_get_expr(d.adbin, d.adrelid), 'acl', a.attacl::text,
      'comment', col_description(c.oid, a.attnum)))
    from pg_attribute as a
    join pg_class as c on c.oid = a.attrelid
    left join pg_attrdef as d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped),
  'policies', (select json_object_agg(pol.polrelid::regclass::text || '.' || pol.polname, json_build_object(
      'command', pol.polcmd, 'permissive', pol.polpermissive, 'roles', pol.polroles::regrole[]::text,
      'using', pg_get_expr(pol.polqual, pol.polrelid), 'check', pg_get_expr(pol.polwithcheck, pol.polrelid)))
    from pg_policy as pol join pg_class as c on c.oid = pol.polrelid
    where c.relnamespace = 'public'::regnamespace),
  'constraints', (select json_object_agg(con.conrelid::regclass::text || '.' || con.conname, pg_get_constraintdef(con.oid))
    from pg_constraint as con where con.connamespace = 'public'::regnamespace),
  'triggers', (select json_object_agg(t.tgrelid::regclass::text || '.' || t.tgname, pg_get_triggerdef(t.oid))
    from pg_trigger as t join pg_class as c on c.oid = t.tgrelid
    where c.relnamespace = 'public'::regnamespace and not t.tgisinternal),
  'indexes', (select json_object_agg(i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid))
    from pg_index as i join pg_class as c on c.oid = i.indrelid
    where c.relnamespace = 'public'::regnamespace),
  'types', (select json_object_agg(t.typname, t.typtype)
    from pg_type as t where t.typnamespace = 'public'::regnamespace),
  'capabilities', (select json_agg(capability_code order by capability_code) from public.capability_definitions),
  'schema_acl', (select n.nspacl::text from pg_namespace as n where n.nspname = 'public'),
  'default_acl', (select json_agg(d.defaclacl::text order by d.defaclobjtype) from pg_default_acl as d),
  'roles', (select json_agg(r.rolname || ':' || r.rolinherit || ':' || r.rolbypassrls order by r.rolname)
    from pg_roles as r where r.rolname in ('anon', 'authenticated', 'service_role'))
)::text;`;

// Every object or attribute that differs between two catalogs.
function catalogDiff(before, after) {
  const changes = [];
  for (const category of Object.keys(after)) {
    const a = before[category];
    const b = after[category];
    if (
      a !== null &&
      b !== null &&
      typeof a === "object" &&
      !Array.isArray(a) &&
      typeof b === "object" &&
      !Array.isArray(b)
    ) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!(key in a)) {
          changes.push(`${category} added: ${key}`);
        } else if (!(key in b)) {
          changes.push(`${category} removed: ${key}`);
        } else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
          const attributes =
            typeof a[key] === "object" && a[key] !== null
              ? Object.keys(b[key]).filter(
                  (k) =>
                    JSON.stringify(a[key][k]) !== JSON.stringify(b[key][k]),
                )
              : ["definition"];
          changes.push(
            `${category} changed: ${key} [${attributes.join(", ")}]`,
          );
        }
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push(`${category} changed`);
    }
  }
  return changes.sort();
}

const NEW_FUNCTIONS = [...CLIENT_FUNCTIONS, ...HELPER_FUNCTIONS];

// The explicit allowlist of catalog changes the P5-001 migration may make.
const EXPECTED_CATALOG_DIFF = Object.freeze(
  [
    ...NEW_FUNCTIONS.map(
      (signature) => `functions added: ${signature.replaceAll(", ", ",")}`,
    ),
    "relations added: intake_question_sets",
    "relations added: intake_revisions",
    "relations added: intake_question_sets_pkey",
    "relations added: intake_question_sets_version_key_key",
    "relations added: intake_question_sets_published_at_key",
    "relations added: intake_revisions_pkey",
    "relations added: intake_revisions_intake_revision_key",
    "relations changed: intakes [acl]",
    "relations changed: jurisdiction_assessments [acl]",
    ...["id", "version_key", "definition", "published_at"].map(
      (column) => `columns added: intake_question_sets.${column}`,
    ),
    ...[
      "id",
      "intake_id",
      "revision_number",
      "question_set_id",
      "practice_area_id",
      "description",
      "structured_answers",
      "created_at",
    ].map((column) => `columns added: intake_revisions.${column}`),
    "columns added: intake_question_sets_pkey.id",
    "columns added: intake_question_sets_version_key_key.version_key",
    "columns added: intake_question_sets_published_at_key.published_at",
    "columns added: intake_revisions_pkey.id",
    "columns added: intake_revisions_intake_revision_key.intake_id",
    "columns added: intake_revisions_intake_revision_key.revision_number",
    // The table-level revocation also removes the earlier column-level
    // UPDATE grants to service_role on the assessment review columns.
    ...["review_status", "reviewed_at", "reviewed_by_user_id"].map(
      (column) => `columns changed: jurisdiction_assessments.${column} [acl]`,
    ),
    "policies added: intake_question_sets.intake_question_sets_select_published",
    "policies added: intake_revisions.intake_revisions_select_own",
    ...[
      "intake_question_sets_pkey",
      "intake_question_sets_version_key_key",
      "intake_question_sets_published_at_key",
      "intake_question_sets_version_key_check",
      "intake_question_sets_definition_check",
    ].map((name) => `constraints added: intake_question_sets.${name}`),
    ...[
      "intake_revisions_pkey",
      "intake_revisions_intake_revision_key",
      "intake_revisions_intake_id_fkey",
      "intake_revisions_question_set_id_fkey",
      "intake_revisions_practice_area_id_fkey",
      "intake_revisions_revision_number_check",
      "intake_revisions_description_check",
      "intake_revisions_structured_answers_check",
      "intake_revisions_content_check",
    ].map((name) => `constraints added: intake_revisions.${name}`),
    "triggers added: intake_question_sets.intake_question_sets_immutable",
    "triggers added: intake_question_sets.intake_question_sets_no_truncate",
    "triggers added: intake_revisions.intake_revisions_immutable",
    "triggers added: intake_revisions.intake_revisions_no_truncate",
    "indexes added: intake_question_sets_pkey",
    "indexes added: intake_question_sets_version_key_key",
    "indexes added: intake_question_sets_published_at_key",
    "indexes added: intake_revisions_pkey",
    "indexes added: intake_revisions_intake_revision_key",
    "types added: intake_question_sets",
    "types added: _intake_question_sets",
    "types added: intake_revisions",
    "types added: _intake_revisions",
    "capabilities changed",
  ].sort(),
);

async function reconciliationChecks() {
  await check(
    "RB-1 on representative state (the fifteen accepted migrations with an existing client and draft Intake), rollback-only application leaves the catalog exactly as it was; the committed catalog diff reconciles exactly with the explicit allowlist; and the existing Intake stays intact and usable",
    () => {
      const db = `${DB}_recon`;
      const fixture = FIXTURE.split("\n")
        .filter((line) => !line.startsWith("create role"))
        .join("\n")
        .replaceAll(DB, db);
      sql(fixture, "postgres");
      const files = inventory();
      for (const [file] of files.slice(0, 15)) {
        applyFile(db, file);
      }
      const auth = uid();
      const user = uid();
      const client = uid();
      const intake = uid();
      sql(
        `insert into auth.users (id) values ('${auth}');
         insert into public.users (id, auth_user_id, account_state) values ('${user}', '${auth}', 'active');
         insert into public.client_profiles (id, user_id) values ('${client}', '${user}');
         insert into public.intakes (id, client_id, state) values ('${intake}', '${client}', 'draft');`,
        db,
      );
      const before = JSON.parse(sql(CATALOG, db));
      const migration = fs.readFileSync(
        path.join(MIGRATIONS, P5_001_MIGRATION),
        "utf8",
      );
      const rollback = run(
        "psql",
        psqlArgs(db),
        `begin;\n${migration}\nrollback;\n`,
      );
      assert.equal(rollback.status, 0, rollback.stderr);
      assert.deepEqual(
        catalogDiff(before, JSON.parse(sql(CATALOG, db))),
        [],
        "rollback leaves no catalog change",
      );
      applyFile(db, P5_001_MIGRATION);
      const diff = catalogDiff(before, JSON.parse(sql(CATALOG, db)));
      const expected = new Set(EXPECTED_CATALOG_DIFF);
      const unexpected = diff.filter((d) => !expected.has(d));
      const missing = [...expected].filter((d) => !diff.includes(d));
      assert.deepEqual(
        { unexpected, missing },
        { unexpected: [], missing: [] },
        JSON.stringify(diff, null, 1),
      );
      assert.equal(
        sql(`select state from public.intakes where id = '${intake}';`, db),
        "draft",
      );
      sql(`drop database ${db};`, "postgres");
      return {
        rollback_only: "catalog identical before and after",
        committed_changes: diff.length,
        reconciled_with_allowlist: true,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// A Supabase client stand-in that executes PostgREST-shaped calls in this
// database as one role (and JWT subject), for the application's own adapters
// and principal source.
// ---------------------------------------------------------------------------

function selectRows(role, sub, table, query) {
  const where =
    query.where.length === 0 ? "" : ` where ${query.where.join(" and ")}`;
  const order = query.order === null ? "" : ` order by ${query.order}`;
  const limit = query.limit === null ? "" : ` limit ${Number(query.limit)}`;
  const result = as(
    role,
    sub,
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
    auth: {
      getUser: async () => ({
        data: {
          user: { id: sub, email_confirmed_at: "2026-10-01T00:00:00Z" },
        },
        error: null,
      }),
    },
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
          RETURNS_SET.has(name)
            ? `select ${expression};`
            : `select to_jsonb(${expression});`,
        );
        if (loseAnswers) {
          return {
            data: null,
            error: { message: "TypeError: fetch failed", code: "" },
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

const DEADLINE = 30000;

// The production composition of the client intake sources, with the
// request-scoped client replaced by the stand-in for one principal.
function clientSources(principal, { loseAnswers = false } = {}) {
  const client = dbClient("authenticated", principal.auth);
  const writer = dbClient("authenticated", principal.auth, { loseAnswers });
  return {
    session: { currentSubject: async () => principal.auth },
    contexts: createClientPrincipalSource(async () => client),
    account: createRequestAccountSource(async () => client, DEADLINE),
    reads: createClientIntakeReads(async () => client, DEADLINE),
    writes: createClientIntakeWrites(async () => writer, DEADLINE),
  };
}

function formOf(fields) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      data.append(name, entry);
    }
  }
  return data;
}

async function applicationChecks() {
  await check(
    "APP-1 (acceptance 1-2) through the application's own use cases, real adapters, client principal source and Security Shell: a client starts an Intake, saves revisions (practice area Not sure, several jurisdictions), a stale page is refused, the Intake is submitted with unreviewed suggestions shown, then closed; another client sees and changes nothing",
    async () => {
      const client = newClient();
      const sources = clientSources(client);
      const started = await startIntake(sources);
      assert.equal(started.status, "created");
      const intake = started.intakeId;
      const first = await resolveIntake(sources, intake, false);
      assert.equal(first.status, "ready");
      assert.equal(first.latestRevision, null);
      assert.deepEqual(
        first.questions.map((q) => q.field),
        [
          "q:practice_area",
          "q:jurisdictions",
          "q:court_case",
          "q:assistance_type",
        ],
      );
      const fields = {
        intake,
        expected_revision: "",
        version: "governing",
        "q:practice_area": "not_sure",
        "q:jurisdictions": [J_A, J_B],
        "q:court_case": "yes",
        "q:assistance_type": "not_sure",
        description: "Synthetic application-level words.",
      };
      assert.deepEqual(await saveIntakeRevision(sources, formOf(fields)), {
        status: "saved",
        revision: 1,
      });
      assert.deepEqual(
        await saveIntakeRevision(
          sources,
          formOf({ ...fields, expected_revision: "1", "q:court_case": "no" }),
        ),
        { status: "saved", revision: 2 },
      );
      assert.equal(
        (
          await saveIntakeRevision(
            sources,
            formOf({
              ...fields,
              expected_revision: "1",
              "q:court_case": "yes",
            }),
          )
        ).status,
        "conflict",
        "a stale page cannot displace the newer revision",
      );
      const draft = await resolveIntake(sources, intake, false);
      assert.equal(draft.latestRevision, 2);
      assert.equal(draft.practiceArea, "not_sure");
      assert.deepEqual(draft.questions[1].values, [J_A, J_B]);
      assert.equal(
        (
          await submitIntakeAction(
            sources,
            formOf({ intake, expected_revision: "2" }),
          )
        ).status,
        "submitted",
      );
      const submitted = await resolveIntake(sources, intake, false);
      assert.equal(submitted.editable, false);
      assert.deepEqual([...submitted.suggestedJurisdictions].sort(), [
        "Synthetic State A",
        "Synthetic State B",
      ]);
      const other = newClient();
      const otherSources = clientSources(other);
      assert.equal(
        (await resolveIntake(otherSources, intake, false)).status,
        "not-found",
      );
      assert.equal(
        (await closeIntakeAction(otherSources, formOf({ intake }))).status,
        "not-found",
      );
      assert.equal(
        (await closeIntakeAction(sources, formOf({ intake }))).status,
        "closed",
      );
      const workspace = await resolveClientWorkspace(sources);
      assert.equal(workspace.status, "ready");
      assert.deepEqual(
        workspace.intakes.map((i) => [i.id, i.state, i.revisions]),
        [[intake, "closed", 2]],
      );
      assert.equal(revisionsOf(intake).length, 2);
    },
  );

  await check(
    "APP-2 a write whose answer is lost is reported as outcome-unknown, never as saved, while the database alone decides what committed",
    async () => {
      const client = newClient();
      const intake = (await startIntake(clientSources(client))).intakeId;
      const lossy = clientSources(client, { loseAnswers: true });
      const state = await saveIntakeRevision(
        lossy,
        formOf({
          intake,
          expected_revision: "",
          version: "governing",
          "q:practice_area": AREA_1,
          "q:jurisdictions": [J_A],
          "q:court_case": "no",
          "q:assistance_type": "representation",
        }),
      );
      assert.equal(state.status, "outcome-unknown");
      assert.equal(revisionsOf(intake).length, 1);
    },
  );

  await check(
    "APP-3 (acceptance 3) publishing a new version changes the questions for new drafts with no code change; an existing draft keeps its version until the client explicitly moves to the current one, and earlier revisions are untouched",
    async () => {
      const client = newClient();
      const sources = clientSources(client);
      const intake = (await startIntake(sources)).intakeId;
      const answers = {
        intake,
        expected_revision: "",
        version: "governing",
        "q:practice_area": AREA_1,
        "q:jurisdictions": [J_A],
        "q:court_case": "no",
        "q:assistance_type": "representation",
      };
      assert.equal(
        (await saveIntakeRevision(sources, formOf(answers))).status,
        "saved",
      );
      const published = publish(
        ROWS_BEFORE_PUBLICATION.authorized,
        "synthetic-application-wording",
        definitionWith((d) => {
          d.questions[3].prompt = "Which kind of help would suit you?";
          d.questions[3].choices = d.questions[3].choices.filter(
            (c) => c.id !== "representation",
          );
        }),
      );
      assert.equal(published.outcome, "published");
      const kept = await resolveIntake(sources, intake, false);
      assert.equal(kept.updateAvailable, true);
      assert.equal(kept.version, "governing");
      assert.equal(
        kept.questions[3].prompt,
        "What kind of help are you looking for?",
      );
      const moved = await resolveIntake(sources, intake, true);
      assert.equal(moved.version, "current");
      assert.equal(moved.versionKey, "synthetic-application-wording");
      assert.equal(
        moved.questions[3].prompt,
        "Which kind of help would suit you?",
      );
      assert.equal(
        moved.questions[3].value,
        "",
        "the removed choice is not carried over",
      );
      assert.equal(moved.questions[2].value, "no");
      const before = revisionsOf(intake);
      assert.deepEqual(
        await saveIntakeRevision(
          sources,
          formOf({
            ...answers,
            expected_revision: "1",
            version: "current",
            "q:assistance_type": "document_help",
          }),
        ),
        { status: "saved", revision: 2 },
      );
      const after = revisionsOf(intake);
      assert.deepEqual(after[0], before[0]);
      assert.equal(after[1].question_set_id, published.question_set_id);
      const fresh = clientSources(newClient());
      const newIntake = (await startIntake(fresh)).intakeId;
      const newView = await resolveIntake(fresh, newIntake, false);
      assert.equal(newView.versionKey, "synthetic-application-wording");
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
    await privilegeChecks();
    seed();
    await publicationChecks();
    await clientFlowChecks();
    await practiceAreaChecks();
    await versionChecks();
    await isolationChecks();
    await validationChecks();
    await concurrencyChecks();
    await rateLimitChecks();
    await atomicityChecks();
    await applicationChecks();
    await reconciliationChecks();
    report.migrations.accepted_verified_after = inventory()
      .slice(0, 15)
      .filter(
        ([file, hash], index) =>
          ACCEPTED[index][0] === file && ACCEPTED[index][1] === hash,
      ).length;
    assert.equal(report.migrations.accepted_verified_after, 15);
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
