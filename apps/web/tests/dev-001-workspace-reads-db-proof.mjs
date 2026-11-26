// DEV-001 disposable PostgreSQL proof: the four workspace reads of the
// product integration (client_requests, client_consultation_parties,
// attorney_activity_counts, staff_payment_dispute_events). Explicitly invoked
// only:
//
//   node apps/web/tests/dev-001-workspace-reads-db-proof.mjs
//
// Deliberately not a *.test.mjs file, so no application test run, p0:test,
// or CI job starts it. It uses Node built-ins and the system-installed
// PostgreSQL 16 initdb, pg_ctl, and psql binaries; no network.
//
// It creates a new mode-0700 temporary directory, initializes a new cluster
// owned by an unprivileged account (never root), and starts it with TCP
// disabled and a private Unix-domain socket (port 54393). The roles anon,
// authenticated, and service_role (BYPASSRLS), the synthetic auth schema
// (auth.users and an auth.uid() that reads request.jwt.claim.sub), the hosted
// platform's default privileges, and a no-op public.rls_auto_enable() are
// synthetic objects of this cluster only. Every migration is applied
// unmodified, in order, each in one transaction, to two databases: the main
// one (every migration; its environment is recorded as development) and a
// base one that stops before the DEV-001 workspace reads migration, so the
// catalog the migration leaves can be compared with the catalog before it.
// The DEV-001 migration is pinned by SHA-256.
//
// Preparation mode (before the migration is committed): set
// DEV_001_WORKSPACE_READS_REPOSITORY_ROOT to a directory whose
// supabase/migrations holds every committed migration plus the draft; the
// draft must then be the newest file, directly after P2-924, and its register
// row is not checked (the register is checked when the proof runs in the
// repository, where the variable is not set).
//
// Configuration: every policy version is development configuration created by
// the owner role inside this disposable cluster (synthetic payment flows,
// timing keys, engagement parameters, the XTS test currency, the synthetic
// modality and a SYN_* Regulatory Mode), as in the S11 proofs. Every account,
// Intake, revision, practice area, Request, payment, provider event and
// planted review item is synthetic test data, never a product value. Where a
// probe says so, a fixture is planted by the owner with triggers bypassed
// (terminal Consultation states and their end instants, a Request recorded
// without a duration, review items of other families): the reads, not the
// fixtures, are what is examined.
//
// Request sessions are modelled as PostgREST sets them from a verified JWT:
// request.jwt.claim.sub and the JSON request.jwt.claims (clients at aal1,
// attorneys and staff at aal2 unless a probe says otherwise); anonymous and
// service_role requests run without a subject. The providers are simulated
// exactly as in the S11 proofs (the probes play the worker and the webhook
// route as service_role).
//
// The JSON report goes to stdout; exit 0 means PASS, 1 FAIL, 2 cleanup
// failure.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRegisteredLifecycle,
  assertTailThenRegistered,
} from "./migration-lifecycle.mjs";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54393;
const DB = "rosuno_dev001_workspace_reads_proof";
const BASE_DB = "rosuno_dev001_workspace_reads_proof_base";
// DEV-001: website & appearance studio re-pin: the catalog comparison (MIG-2)
// compares BASE_DB with a database migrated exactly through this proof's own
// migration, so a later registered migration's own objects never enter this
// migration's inventory (each later migration's own proof inventories it);
// every behavioural check still runs on DB, which holds every migration.
const INVENTORY_DB = "rosuno_dev001_workspace_reads_proof_inventory";
const PREPARATION = process.env.DEV_001_WORKSPACE_READS_REPOSITORY_ROOT;
const REPOSITORY_ROOT =
  PREPARATION ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATIONS = path.join(REPOSITORY_ROOT, "supabase/migrations");
const P2_924_MIGRATION =
  "20261128010000_p2_924_development_regulatory_mode_and_staff_bootstrap.sql";
const DEV_001_MIGRATION = "20261129010000_dev_001_workspace_reads.sql";
const DEV_001_SHA256 =
  "6269701c7c500d30a88b06e70f80aa00c82a5e57f26af6f7755ede4d7d3cd84e";
const PROGRAM_WORK_ITEM = "WI-P2-DEV-001-ENGINEERING-PROGRAM";
const PROGRAM_DECISION = "DEC-20261125-DEV-001-ENGINEERING-PROGRAM";

// The four reads, their identity arguments and result columns.
const READS = Object.freeze({
  "client_requests(text, integer)": {
    args: "p_segment text, p_offset integer",
    result:
      "TABLE(request_id uuid, intake_id uuid, state text, expired_due boolean, request_path text, attorney_display_name text, requested_modality text, duration_minutes integer, slot_start_at timestamp with time zone, slot_end_at timestamp with time zone, response_deadline_at timestamp with time zone, created_at timestamp with time zone, consultation_id uuid)",
  },
  "client_consultation_parties()": {
    args: "",
    result:
      "TABLE(consultation_id uuid, consultation_request_id uuid, intake_id uuid, attorney_display_name text, practice_area_name text)",
  },
  "attorney_activity_counts(timestamp with time zone, timestamp with time zone)":
    {
      args: "p_from timestamp with time zone, p_until timestamp with time zone",
      result: "TABLE(metric text, dimension text, value bigint)",
    },
  "staff_payment_dispute_events(uuid)": {
    args: "p_payment_id uuid",
    result:
      "TABLE(exception_id uuid, exception_type text, severity text, status text, detected_at timestamp with time zone, evidence_reference jsonb, resolved_at timestamp with time zone, resolution_notes text)",
  },
});
const READ_NAMES = Object.freeze(
  Object.keys(READS).map((s) => s.slice(0, s.indexOf("("))),
);

const report = {
  proof: "DEV-001 workspace reads (E1 to E4) disposable local PostgreSQL proof",
  mode: PREPARATION ? "preparation" : "repository",
  migrations: {},
  checks: [],
  cluster: {},
};
let state = null;
const started = Date.now();

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

// The session lines of one request: a role, an optional JWT subject, and the
// JWT claims. With a subject, the claims default to an aal2 session; aal
// "aal1" models a session before MFA step-up and aal null a request without
// claims.
function sessionLines(role, sub, { aal = "aal2" } = {}) {
  const lines = [`set local role ${role};`];
  if (sub !== null) {
    lines.push(
      `select set_config('request.jwt.claim.sub', ${lit(sub)}, true) is not null;`,
    );
    if (aal !== null) {
      lines.push(
        `select set_config('request.jwt.claims', ${lit(JSON.stringify({ sub, role, aal }))}, true) is not null;`,
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

function rowsJson(account, statement, options = {}) {
  return rowsAs("authenticated", account.auth, statement, options).map((r) =>
    JSON.parse(r),
  );
}

const uid = () => randomUUID();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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

function startCluster() {
  const identity = unprivilegedIdentity();
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "rosuno-dev-001-workspace-reads-db-proof-"),
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
      "max_connections = 40",
      "",
    ].join("\n"),
  );
  const start = run("pg_ctl", [
    "-D",
    dataDir,
    "-w",
    "-t",
    "60",
    "-s",
    "-l",
    path.join(tmp, "postgres.log"),
    "start",
  ]);
  assert.equal(start.status, 0, start.stderr);
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

// Applies the files in order, each in one transaction; answers the notices of
// the DEV-001 migration.
function applyMigrationsTo(db, files) {
  let notices = null;
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
    if (file === DEV_001_MIGRATION) {
      notices = [...result.stderr.matchAll(/NOTICE:\s+(.*)/g)].map(
        (match) => match[1],
      );
    }
  }
  return notices;
}

// The migration set, its order and (in the repository) its registration.
function applyMigrations() {
  const files = migrationFiles();
  const own = files.indexOf(DEV_001_MIGRATION);
  assert.ok(own > 0, `${DEV_001_MIGRATION} is present`);
  assert.equal(
    files[own - 1],
    P2_924_MIGRATION,
    "the DEV-001 workspace reads migration directly follows P2-924",
  );
  report.migrations.sha256 = sha256(
    fs.readFileSync(path.join(MIGRATIONS, DEV_001_MIGRATION)),
  );
  if (PREPARATION) {
    assert.equal(own, files.length - 1, "the draft is the newest migration");
    report.migrations.registration =
      "not checked in preparation mode (DEV_001_WORKSPACE_READS_REPOSITORY_ROOT is set); the register row, the Program reference and every later migration are checked when the proof runs in the repository";
  } else {
    const registered = JSON.parse(
      fs.readFileSync(
        path.join(
          REPOSITORY_ROOT,
          "governance/migrations/reviewed-migrations.json",
        ),
        "utf8",
      ),
    ).migrations;
    const id = DEV_001_MIGRATION.replace(/\.sql$/, "");
    const previous = P2_924_MIGRATION.replace(/\.sql$/, "");
    const row = registered.find(
      (migration) =>
        migration.artifact_path === `supabase/migrations/${DEV_001_MIGRATION}`,
    );
    const before = registered.find(
      (migration) => migration.migration_id === previous,
    );
    assert.ok(row, `${DEV_001_MIGRATION} is registered`);
    assert.equal(row.migration_id, id);
    assert.equal(row.sequence, before.sequence + 1);
    assert.deepEqual(row.depends_on, [previous]);
    assert.ok(row.work_item_refs.includes(PROGRAM_WORK_ITEM));
    assert.ok(row.decision_refs.includes(PROGRAM_DECISION));
    assert.ok(
      typeof row.rollback_plan === "string" && row.rollback_plan !== "",
    );
    const lifecycle = assertRegisteredLifecycle(row);
    const program = JSON.parse(
      fs.readFileSync(
        path.join(REPOSITORY_ROOT, "governance/work-items/index.json"),
        "utf8",
      ),
    ).work_items.find((item) => item.work_item_id === PROGRAM_WORK_ITEM);
    assert.ok(program.migration_refs.includes(id), `${id} is a Program ref`);
    // A later migration needs its register entry, not an edit of this proof.
    assertTailThenRegistered(files.slice(own + 1), [], DEV_001_MIGRATION);
    report.migrations.registration = {
      sequence: row.sequence,
      lifecycle,
      later: files.slice(own + 1),
    };
  }
  sql(ROLES, "postgres");
  sql(fixtureFor(DB), "postgres");
  sql(fixtureFor(BASE_DB), "postgres");
  sql(fixtureFor(INVENTORY_DB), "postgres");
  report.migrations.notices = applyMigrationsTo(DB, files);
  applyMigrationsTo(BASE_DB, files.slice(0, own));
  applyMigrationsTo(INVENTORY_DB, files.slice(0, own + 1));
  report.migrations.applied = files.length;
  report.migrations.base_applied = own;
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
    process.stderr.write(`[dev-001-reads-proof] PASS ${name}\n`);
  } catch (error) {
    failed = true;
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
    process.stderr.write(
      `[dev-001-reads-proof] FAIL ${name}\n${error?.stack ?? error}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Synthetic seed and call helpers (the S11 proofs' own fixtures)
// ---------------------------------------------------------------------------

const world = { ordinals: new Map(), slot: 0, events: 0, lawyers: 0 };

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
    `insert into public.jurisdictions (id, code, name, region_type, lifecycle_state) values ('${id}', '${code}', 'Synthetic ${code}', 'synthetic', 'unsupported');`,
  );
  return id;
}

function newRegulatoryMode(code) {
  const id = uid();
  sql(
    `insert into public.regulatory_modes (id, code, name, status) values ('${id}', '${code}', 'Synthetic ${code}', 'synthetic');`,
  );
  return id;
}

function mapMode(jurisdiction, mode) {
  sql(
    `insert into public.jurisdiction_regulatory_modes (jurisdiction_id, regulatory_mode_id, active_from, approval_status) values ('${jurisdiction}', '${mode}', now() - interval '1 day', 'synthetic');`,
  );
}

// Development configuration created by the owner role in this disposable
// database only: test values, never product values.
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
// 4217 testing code).
const FEE = () => ({
  currency_code: "XTS",
  quote_validity_seconds: 900,
  listed_price_minimum_minor: 1000,
  listed_price_maximum_minor: 100000,
  rounding: "half_up",
  platform_fee: COMPONENT(1000),
  client_fee: COMPONENT(250, 50, 100, 2000),
  other_required_fee: COMPONENT(100),
});

const PLATFORM = Object.freeze({
  permitted_durations_minutes: [30, 60],
  permitted_modalities: ["synthetic_video"],
});

// The synthetic payment_flow and engagement parameters (test configuration
// only; G-1 to G-5 stay configuration).
const FLOW_ALL = (authorization, capture) => ({
  instant: { authorization, capture },
  scheduled: { authorization, capture },
});
const BEFORE = "before_attorney_decision";
const AT_ACCEPTANCE = "at_attorney_acceptance";
const ENGAGEMENT = Object.freeze({
  consultation_creation: "attorney_acceptance",
  engagement_effective: "at_consultation_start",
  post_consultation_message_window_seconds: 3600,
});
const TIMING = Object.freeze({
  consultation_join_window_seconds: 600,
  consultation_overrun_seconds: 300,
});
// Near-term scheduled slots are allowed in these synthetic jurisdictions.
const NEAR = Object.freeze({
  minimum_notice_seconds: 0,
  hold_pre_slot_interval_seconds: 0,
});

// The synthetic jurisdictions (test values only).
const JURISDICTIONS = Object.freeze({
  // Authorization before the decision, capture at the consultation start (the
  // S11 proofs' standard flow): accepted Consultations with their payments.
  S: {
    flow: FLOW_ALL(BEFORE, "at_consultation_start"),
    scheduling: SCHEDULING({ ...TIMING, ...NEAR }),
  },
  // Authorization before the decision, capture at the acceptance: captured
  // payments for the dispute events.
  A: {
    flow: FLOW_ALL(BEFORE, "at_attorney_acceptance"),
    scheduling: SCHEDULING({ ...TIMING, ...NEAR }),
  },
  // Authorization at the acceptance: a Request awaits the attorney as soon as
  // it is created (decisions, withdrawals and could_not_proceed).
  D: {
    flow: FLOW_ALL(AT_ACCEPTANCE, "at_attorney_acceptance"),
    scheduling: SCHEDULING({ ...TIMING, ...NEAR }),
  },
  // As D, with a 2-second scheduled response window (expiry).
  E: {
    flow: FLOW_ALL(AT_ACCEPTANCE, "at_attorney_acceptance"),
    scheduling: SCHEDULING({
      ...TIMING,
      ...NEAR,
      scheduled_request_response_window_seconds: 2,
    }),
  },
});

let licenceNumber = 0;

function attorney({ name, jurisdictions = [], profileState = "approved" }) {
  const account = newAccount();
  const profile = uid();
  sql(
    `insert into public.attorney_profiles (id, user_id, profile_state, display_name, years_experience) values ('${profile}', '${account.user}', ${lit(profileState)}, ${lit(name)}, 7);`,
  );
  for (const jurisdiction of jurisdictions) {
    licenceNumber += 1;
    const licence = uid();
    const evidence = uid();
    sql(
      `insert into public.licenses (id, attorney_id, jurisdiction_id, license_number, reported_status) values ('${licence}', '${profile}', '${jurisdiction}', 'SYN-DEV001-LIC-${String(licenceNumber).padStart(4, "0")}', 'synthetic-active');
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

// A new approved attorney licensed in the given jurisdictions (by key).
function lawyer(name, ...keys) {
  world.lawyers += 1;
  return attorney({
    name: name ?? `Synthetic Attorney ${world.lawyers}`,
    jurisdictions: keys.map((key) => world.J[key]),
  });
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

// Another submitted Intake of the same client.
function withIntake(client) {
  const intake = uid();
  sql(
    `insert into public.intakes (id, client_id, state) values ('${intake}', '${client.client}', 'submitted');`,
  );
  return { ...client, intake };
}

function ownerReferral({ client, lawyer: who, jurisdiction, requestPath }) {
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
     insert into public.referrals (id, intake_id, attorney_id, jurisdiction_id, attempt_ordinal, allocation_method) values ('${referral}', '${client.intake}', '${who.profile}', '${jurisdiction}', ${ordinal}, 'client_selected');
     insert into public.eligibility_evaluations (id, attorney_id, jurisdiction_id, context_type, context_id, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${evaluation}', '${who.profile}', '${jurisdiction}', 'jurisdiction', null, now(), '[]'::jsonb, 'eligible', '[]'::jsonb, '{}'::jsonb, now());
     insert into public.referral_eligible_pool_entries (referral_id, attorney_id, eligibility_evaluation_id, eligible_as_of) values ('${referral}', '${who.profile}', '${evaluation}', now());
     insert into public.referral_presentations (referral_id, attorney_id, display_position, client_filter_context, narrowing_actor, shown_at) values ('${referral}', '${who.profile}', 1, null, 'platform', now());
     insert into public.bookability_evaluations (attorney_id, eligibility_evaluation_id, context_type, context_id, evaluated_at, as_of, modality, presence_observed, availability_basis, constraint_results, result) values ('${who.profile}', '${evaluation}', 'referral', '${referral}', now(), now(), 'unselected', ${presence}, ${basis}, '[]'::jsonb, 'bookable');
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

const AAL1 = Object.freeze({ aal: "aal1" });
const asClient = (client, statement) =>
  as("authenticated", client.auth, statement, AAL1);
const asAttorney = (who, statement, options = {}) =>
  as("authenticated", who.auth, statement, options);
const asStaff = asAttorney;

// A real Request through request_create, for a given or new client, from a
// new owner-fixture Referral.
function makeRequest({
  key,
  requestPath = "scheduled",
  lawyer: who = world.ann,
  client = null,
}) {
  const owner = client ?? newClient();
  const jurisdiction = world.J[key];
  const referral = ownerReferral({
    client: owner,
    lawyer: who,
    jurisdiction,
    requestPath,
  });
  const slot = requestPath === "scheduled" ? nextSlot() : null;
  const line = asClient(
    owner,
    `select outcome || '|' || coalesce(request_id::text, '') || '|' || coalesce(problem, '') from public.request_create(${lit(referral)}, ${lit(requestPath)}, 'synthetic_video', 30, ${slot === null ? "null" : `${lit(slot)}::timestamptz`}, null::text);`,
  );
  const [outcome, request, problem] = line.split("|");
  assert.equal(outcome, "created", `request_create: ${line}`);
  return {
    client: owner,
    referral,
    request,
    problem,
    requestPath,
    lawyer: who,
  };
}

function authorize(client, request) {
  const line = asClient(
    client,
    `select outcome || '|' || coalesce(payment_transaction_id::text, '') || '|' || coalesce(problem, '') from public.client_authorize_payment(${lit(request)});`,
  );
  const [outcome, payment, problem] = line.split("|");
  return { outcome, payment: payment || null, problem: problem || null, line };
}

function jsonOf(statement) {
  return JSON.parse(sql(statement) || "null");
}

const rowOf = (table, where) =>
  jsonOf(
    `select row_to_json(t)::text from public.${table} t where ${where} limit 1;`,
  );
const requestOf = (id) => rowOf("consultation_requests", `id = '${id}'`);
const consultationOf = (request) =>
  rowOf("consultations", `consultation_request_id = '${request}'`);
const livePaymentOf = (request) =>
  rowOf(
    "payment_transactions",
    `consultation_request_id = '${request}' order by created_at desc`,
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
function runJob(type, subjectType, subjectId, resultOf) {
  const job = openJob(type, subjectType, subjectId);
  assert.ok(job, `an open ${type} job for ${subjectId}`);
  sql(
    `update public.operational_jobs set state = 'running', locked_at = now(), locked_by = 'dev001-proof', attempt_count = attempt_count + 1, available_at = now() + interval '60 seconds' where id = '${job}';`,
  );
  const context = JSON.parse(
    as(
      "service_role",
      null,
      `select row_to_json(c)::text from public.payment_job_context('${job}') c;`,
    ),
  );
  const observation = resultOf(context);
  const outcome =
    observation === null
      ? null
      : as(
          "service_role",
          null,
          `select public.payment_record_operation('${job}', ${lit(observation)}::jsonb);`,
        );
  assert.equal(
    as(
      "service_role",
      null,
      `select public.job_complete('${job}', 'dev001-proof');`,
    ),
    "completed",
  );
  return { job, context, outcome };
}

const obs = (kind, fields = {}) => ({ kind, ...fields });

// The probe plays the webhook route: one authenticated provider event.
function providerEvent(eventType, observation) {
  world.events += 1;
  const id = `evt_synthetic_${world.events}_${uid().slice(0, 8)}`;
  const line = as(
    "service_role",
    null,
    `select outcome || '|' || coalesce(processing_state, '') from public.payment_record_provider_event('stripe', ${lit(id)}, ${lit(eventType)}, now(), ${lit(`sha256:${sha256(id)}`)}, ${lit(observation)}::jsonb);`,
  );
  const [outcome, processing] = line.split("|");
  return { id, outcome, processing, line };
}

const checkoutRef = () =>
  `cs_test_syn${uid().replaceAll("-", "").slice(0, 20)}`;
const paymentRef = () => `pi_syn${uid().replaceAll("-", "").slice(0, 20)}`;

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

// A payment taken to captured through the real paths.
function capturedPayment(options) {
  const p = authorizedRequest(options);
  assert.equal(
    sql(`select public.payment_request_capture('${p.payment}');`),
    "capture_requested",
  );
  const done = runJob("payment.capture", "payment_transaction", p.payment, () =>
    obs("capture_confirmed", {
      payment_reference: p.reference,
      amount_minor: p.total,
      currency_code: "XTS",
    }),
  );
  assert.equal(done.outcome, "applied");
  return p;
}

const ACCEPT_SQL = (request) =>
  `select outcome || '|' || coalesce(consultation_id::text, '') || '|' || coalesce(problem, '') from public.attorney_accept_request(${lit(request)});`;

function accept(who, request, options = {}) {
  const [outcome, consultation, problem] = (
    asAttorney(who, ACCEPT_SQL(request), options) ?? ""
  ).split("|");
  return {
    outcome,
    consultation: consultation || null,
    problem: problem || null,
  };
}
const decline = (who, request) =>
  asAttorney(
    who,
    `select outcome from public.attorney_decline_request(${lit(request)});`,
  );
const withdraw = (client, request) =>
  asClient(
    client,
    `select outcome from public.request_withdraw(${lit(request)});`,
  );

// A Consultation accepted through the real S6, S7 and S8 paths.
function acceptedConsultation({
  key = "S",
  requestPath = "scheduled",
  who,
  client = null,
}) {
  const s = authorizedRequest({ key, requestPath, lawyer: who, client });
  const decision = accept(who, s.request);
  assert.equal(decision.outcome, "accepted", JSON.stringify(decision));
  const consultation = consultationOf(s.request);
  assert.ok(consultation, "the acceptance created the Consultation");
  return { ...s, consultation: consultation.id };
}

const clientCancel = (s) =>
  JSON.parse(
    asClient(
      s.client,
      `select row_to_json(x)::text from public.consultation_cancel(${lit(s.consultation)}) x;`,
    ),
  );

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

// Owner fixture with triggers bypassed (the probe says where it is used).
function planted(statement) {
  sql(
    `begin;
     set local session_replication_role = replica;
     ${statement}
     commit;`,
  );
}

const keysOf = (row) => Object.keys(row).sort().join(",");
const API = Object.freeze(["anon", "service_role"]);
// The SQLSTATE of a direct call by anon and by service_role.
const apiRefusals = (statement) =>
  Object.fromEntries(API.map((role) => [role, as(role, null, statement)]));
const clock = () => sql("select clock_timestamp()::text;");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function untilPast(timestamp) {
  const target = new Date(timestamp).getTime() + 300;
  while (Date.now() < target) {
    await sleep(100);
  }
}

function seed() {
  world.staff = newAccount();
  world.mode = newRegulatoryMode("SYN_DEV001_READS");
  world.J = {};
  policy("bookability", null, { presence_window_seconds: 600 });
  policy("fee", null, PLATFORM);
  for (const [key, config] of Object.entries(JURISDICTIONS)) {
    const id = newJurisdiction(`SYN_DEV001_${key}`);
    world.J[key] = id;
    policy("eligibility", id, ELIGIBILITY);
    policy("scheduling", id, config.scheduling);
    policy("referral", id, { outcome_codes: ["synthetic_closed"] });
    policy("fee", id, FEE());
    mapMode(id, world.mode);
    policy("payment_flow", id, config.flow, world.mode);
    for (const type of ["payment", "cancellation", "refund"]) {
      policy(type, id, {}, world.mode);
    }
    policy("engagement", id, ENGAGEMENT, world.mode);
  }
  world.ann = lawyer("Ann Synthetic", "S", "A", "D", "E");
  // A display name discovery_presentable_text refuses (a banned claim).
  world.boast = lawyer("Best Attorney Synthetic", "S", "D");
  world.grantor = newAccount();
  sql(
    `insert into public.staff_profiles (user_id, staff_state) values ('${world.grantor.user}', 'active');`,
  );
  world.finance = staffWith(["manage_financial_operations", null]);
  world.financeS = staffWith(["manage_financial_operations", world.J.S]);
  world.ops = staffWith(["manage_consultation_operations", null]);
  world.compliance = staffWith(["manage_compliance_reviews", null]);
  world.plainStaff = staffWith();
  world.questionSet = uid();
  sql(
    `insert into public.intake_question_sets (id, version_key, definition, published_at) values ('${world.questionSet}', 'synthetic-dev001-v1', '{"schema": "synthetic"}'::jsonb, now() - interval '2 days');`,
  );
}

// ---------------------------------------------------------------------------
// MIG: the migration, the unchanged catalog, privileges
// ---------------------------------------------------------------------------

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
  triggers:
    "select coalesce(string_agg(tgrelid::regclass::text || '.' || tgname || ':' || pg_get_triggerdef(oid), ',' order by tgrelid::regclass::text, tgname), '') from pg_trigger where not tgisinternal;",
  policies:
    "select coalesce(string_agg(tablename || '.' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ',' order by tablename, policyname), '') from pg_policies where schemaname = 'public';",
  types:
    "select coalesce(string_agg(typname, ',' order by typname), '') from pg_type where typnamespace = 'public'::regnamespace;",
  policy_types:
    "select coalesce(string_agg(code, ',' order by code), '') from public.policy_types;",
  capability_codes:
    "select coalesce(string_agg(capability_code, ',' order by capability_code), '') from public.capability_definitions;",
  table_grants:
    "select coalesce(string_agg(table_name || ':' || grantee || ':' || privilege_type, ',' order by table_name, grantee, privilege_type), '') from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role');",
  default_privileges:
    "select coalesce(string_agg(defaclrole::regrole::text || ':' || defaclobjtype::text || ':' || array_to_string(defaclacl, ';'), ',' order by defaclrole::regrole::text, defaclobjtype), '') from pg_default_acl;",
  // Every function the migration did not create: its definition, privileges
  // and comment are unchanged.
  existing_functions: `select coalesce(string_agg(p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(array_to_string(p.proacl, ';'), '') || ':' || md5(coalesce(obj_description(p.oid, 'pg_proc'), '')), ',' order by p.oid::regprocedure::text), '') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p') and p.proname not in (${READ_NAMES.map((n) => `'${n}'`).join(", ")});`,
  functions:
    "select coalesce(string_agg(p.oid::regprocedure::text, '|' order by p.oid::regprocedure::text), '') from pg_proc p where p.pronamespace = 'public'::regnamespace;",
});

const executors = (signature) =>
  sql(
    `select coalesce(string_agg(r.rolname, ',' order by r.rolname), '') from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') and has_function_privilege(r.rolname, 'public.${signature}', 'execute');`,
  );

async function migrationChecks() {
  await check(
    "MIG-1 the DEV-001 workspace reads migration directly follows P2-924, its bytes are the pinned bytes, it applies without notices and its text creates functions only (no relation, column, type, policy, view, sequence, index, trigger, seed or default; no replace, alter or drop; no grant other than execute)",
    () => {
      assert.equal(report.migrations.sha256, DEV_001_SHA256);
      assert.deepEqual(report.migrations.notices, []);
      const raw = fs.readFileSync(
        path.join(MIGRATIONS, DEV_001_MIGRATION),
        "utf8",
      );
      // The statements only: without comments and string literals.
      const text = raw
        .replace(/--[^\n]*/g, "")
        .replace(/'(?:[^']|'')*'/g, "''");
      assert.doesNotMatch(
        text,
        /create\s+table|add\s+column|create\s+type|create\s+policy|create\s+view|create\s+sequence|create\s+(unique\s+)?index|alter\s+table|create\s+trigger|insert\s+into|update\s+public\.|delete\s+from|truncate|create\s+or\s+replace|alter\s+function|drop\s|alter\s+default|security\s+invoker|grant\s+(?!execute)/i,
      );
      const created = [
        ...raw.matchAll(/^create function public\.([a-z_0-9]+)\(/gm),
      ].map((match) => match[1]);
      assert.deepEqual([...created].sort(), [...READ_NAMES].sort());
      return {
        sha256: report.migrations.sha256,
        registration: report.migrations.registration,
      };
    },
  );

  await check(
    "MIG-2 the migration adds exactly the four functions and changes nothing else: every catalog listing (relations, columns with defaults, constraints, indexes, triggers, row policies, types, policy types, capability codes, table grants, default privileges, and every existing function's definition, privileges and comment) equals the catalog before it",
    () => {
      const differences = {};
      for (const [name, query] of Object.entries(CATALOG_QUERIES)) {
        if (name === "functions") {
          continue;
        }
        // DEV-001: website & appearance studio re-pin: through this
        // migration only (INVENTORY_DB; see above).
        if (sql(query, BASE_DB) !== sql(query, INVENTORY_DB)) {
          differences[name] = true;
        }
      }
      assert.deepEqual(differences, {});
      const before = new Set(
        sql(CATALOG_QUERIES.functions, BASE_DB).split("|"),
      );
      const added = sql(CATALOG_QUERIES.functions, INVENTORY_DB)
        .split("|")
        .filter((signature) => !before.has(signature));
      assert.deepEqual(
        added.sort(),
        Object.keys(READS)
          .map((signature) => signature.replaceAll(", ", ","))
          .sort(),
      );
      return { added };
    },
  );

  await check(
    "MIG-3 each read is language sql, stable, security definer with search_path exactly pg_catalog, pg_temp, has exactly its argument list and result columns, is executable by authenticated only (not anon, service_role or public) and carries a DEV-001 comment; the participant reads take no argument naming a record",
    () => {
      const detail = {};
      for (const [signature, shape] of Object.entries(READS)) {
        const [
          definer,
          config,
          volatility,
          language,
          args,
          result,
          publicGrant,
          comment,
        ] = sql(
          `select p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ';'), '') || '|' || p.provolatile::text || '|' || l.lanname || '|' || pg_get_function_identity_arguments(p.oid) || '|' || pg_get_function_result(p.oid) || '|' || exists (select 1 from aclexplode(p.proacl) as a where a.grantee = 0)::text || '|' || coalesce(obj_description(p.oid, 'pg_proc'), '') from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = 'public.${signature}'::regprocedure;`,
        ).split("|");
        assert.equal(definer, "true", signature);
        assert.equal(config, "search_path=pg_catalog, pg_temp", signature);
        assert.equal(volatility, "s", signature);
        assert.equal(language, "sql", signature);
        assert.equal(args, shape.args, signature);
        assert.equal(result, shape.result, signature);
        assert.equal(publicGrant, "false", signature);
        assert.match(comment, /^DEV-001 /, signature);
        assert.equal(executors(signature), "authenticated", signature);
        if (!signature.startsWith("staff_")) {
          assert.doesNotMatch(args, /uuid/, signature);
        }
        detail[signature] = args === "" ? "no arguments" : args;
      }
      return detail;
    },
  );
}

// ---------------------------------------------------------------------------
// E1: client_requests
// ---------------------------------------------------------------------------

const UNDECIDED = Object.freeze([
  "created",
  "payment_authorized",
  "slot_held",
  "awaiting_attorney",
]);
const E1_SQL = (segment, offset) =>
  `select row_to_json(x)::text from public.client_requests(${segment === null ? "null::text" : lit(segment)}, ${offset === null ? "null::integer" : offset}) x;`;
const CLIENT_REQUEST_SQL = (id) =>
  `select row_to_json(x)::text from public.client_request(${lit(id)}) x;`;
const CLIENT_DECISION_SQL = (id) =>
  `select row_to_json(x)::text from public.client_request_decision(${lit(id)}) x;`;
const E1_COLUMNS =
  "attorney_display_name,consultation_id,created_at,duration_minutes,expired_due,intake_id,request_id,request_path,requested_modality,response_deadline_at,slot_end_at,slot_start_at,state";
const SHARED_WITH_CLIENT_REQUEST = Object.freeze([
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
]);

const ownRequestIds = (client, where = "true") =>
  sql(
    `select coalesce(string_agg(id::text, ',' order by created_at desc, id desc), '') from public.consultation_requests where client_id = '${client.client}' and ${where};`,
  )
    .split(",")
    .filter((id) => id !== "");

// Each row equals client_request and client_request_decision for its Request.
function assertEqualsPerItemReads(client, rows) {
  for (const row of rows) {
    const [single] = rowsJson(client, CLIENT_REQUEST_SQL(row.request_id), AAL1);
    const [decision] = rowsJson(
      client,
      CLIENT_DECISION_SQL(row.request_id),
      AAL1,
    );
    for (const column of SHARED_WITH_CLIENT_REQUEST) {
      assert.deepEqual(
        row[column],
        single[column],
        `${row.request_id} ${column}`,
      );
    }
    assert.equal(row.intake_id, decision.intake_id, row.request_id);
    assert.equal(row.consultation_id, decision.consultation_id, row.request_id);
  }
}

async function e1Checks() {
  await check(
    "E1-1 client_requests answers exactly the caller's own Requests across their Intakes, newest first, with exactly its thirteen columns, each equal to client_request (state, expired_due, path, presentable attorney name, modality, duration with client_request's snapshot fallback, slot, response deadline, creation) and client_request_decision (Intake, Consultation) for the same Request; 'open' answers exactly the undecided ones (an expired_due one included, flagged), 'all' every state; a refused attorney name answers null; no amount, quote or message",
    async () => {
      const c1 = newClient();
      const c1b = withIntake(c1);
      const s = world.e1;
      s.client = c1;
      const created = makeRequest({ key: "S", client: c1 });
      const awaitingInstant = authorizedRequest({
        key: "S",
        requestPath: "instant",
        client: c1,
      });
      const accepted = acceptedConsultation({
        key: "S",
        who: world.ann,
        client: c1,
      });
      const declined = makeRequest({ key: "D", client: c1 });
      assert.equal(decline(world.ann, declined.request), "declined");
      const withdrawn = makeRequest({ key: "D", client: c1b });
      assert.equal(withdraw(c1, withdrawn.request), "withdrawn");
      const refusedName = makeRequest({
        key: "D",
        client: c1b,
        lawyer: world.boast,
      });
      const expiring = makeRequest({ key: "E", client: c1 });
      const due = makeRequest({ key: "E", client: c1b });
      // Planted (triggers bypassed): a Request recorded without a duration,
      // as before S6, so client_request's snapshot fallback is examined.
      planted(
        `update public.consultation_requests set requested_duration_minutes = null where id = '${declined.request}';`,
      );
      await untilPast(requestOf(due.request).response_deadline_at);
      await untilPast(requestOf(expiring.request).response_deadline_at);
      assert.equal(
        sql(
          `select public.request_expire_if_due('${expiring.request}', false);`,
        ),
        "expired",
      );
      const all = rowsJson(c1, E1_SQL("all", 0), AAL1);
      assert.equal(keysOf(all[0]), E1_COLUMNS);
      assert.deepEqual(
        all.map((r) => r.request_id),
        ownRequestIds(c1),
      );
      assert.equal(all.length, 8);
      assert.deepEqual(
        new Set(all.map((r) => r.intake_id)),
        new Set([c1.intake, c1b.intake]),
      );
      assertEqualsPerItemReads(c1, all);
      const byId = new Map(all.map((r) => [r.request_id, r]));
      assert.ok(UNDECIDED.includes(byId.get(created.request).state));
      assert.equal(
        byId.get(awaitingInstant.request).state,
        "awaiting_attorney",
      );
      assert.equal(byId.get(awaitingInstant.request).request_path, "instant");
      assert.equal(byId.get(awaitingInstant.request).slot_start_at, null);
      assert.equal(byId.get(accepted.request).state, "accepted");
      assert.equal(
        byId.get(accepted.request).consultation_id,
        accepted.consultation,
      );
      assert.equal(byId.get(declined.request).state, "declined");
      assert.equal(
        byId.get(declined.request).duration_minutes,
        30,
        "the snapshot fallback",
      );
      assert.equal(
        requestOf(declined.request).requested_duration_minutes,
        null,
      );
      assert.equal(byId.get(withdrawn.request).state, "cancelled");
      assert.equal(byId.get(expiring.request).state, "expired");
      assert.equal(byId.get(due.request).state, "awaiting_attorney");
      assert.equal(byId.get(due.request).expired_due, true);
      assert.equal(byId.get(refusedName.request).attorney_display_name, null);
      assert.notEqual(
        sql(
          `select display_name from public.attorney_profiles where id = '${world.boast.profile}';`,
        ),
        "",
      );
      assert.equal(
        byId.get(created.request).attorney_display_name,
        "Ann Synthetic",
      );
      for (const row of all) {
        assert.equal(
          row.consultation_id !== null,
          row.state === "accepted",
          row.request_id,
        );
      }
      const open = rowsJson(c1, E1_SQL("open", 0), AAL1);
      assert.deepEqual(
        open.map((r) => r.request_id),
        ownRequestIds(
          c1,
          `state in (${UNDECIDED.map((x) => `'${x}'`).join(", ")})`,
        ),
      );
      assert.deepEqual(
        open,
        all.filter((r) => UNDECIDED.includes(r.state)),
      );
      assert.ok(open.some((r) => r.expired_due === true));
      // The same answer at aal2 (a client read needs no step-up).
      assert.deepEqual(rowsJson(c1, E1_SQL("all", 0)), all);
      s.all = all;
      return {
        all: all.length,
        open: open.length,
        states: [...new Set(all.map((r) => r.state))].sort(),
      };
    },
  );

  await check(
    "E1-2 client_requests pages by 25 rows plus one, newest first: 27 Requests answer 26 rows at offset 0 and the last 2 at offset 25, together exactly the 27 in order; offset 1 shifts by one; an offset outside 0 to 100000, a missing offset, and a segment other than 'open' or 'all' (case, empty, missing, unknown) answer nothing",
    () => {
      const many = newClient();
      for (let i = 0; i < 27; i += 1) {
        makeRequest({ key: "D", client: many });
      }
      const ids = ownRequestIds(many);
      assert.equal(ids.length, 27);
      const first = rowsJson(many, E1_SQL("all", 0), AAL1);
      const second = rowsJson(many, E1_SQL("all", 25), AAL1);
      assert.equal(first.length, 26);
      assert.equal(second.length, 2);
      assert.deepEqual(
        [...first.slice(0, 25), ...second].map((r) => r.request_id),
        ids,
      );
      assert.deepEqual(rowsJson(many, E1_SQL("open", 0), AAL1).length, 26);
      assert.deepEqual(
        rowsJson(many, E1_SQL("all", 1), AAL1).map((r) => r.request_id),
        ids.slice(1, 27),
      );
      assert.match(
        sql(
          "select pg_get_functiondef('public.client_requests(text, integer)'::regprocedure);",
        ),
        /limit 26;/,
      );
      for (const offset of [-1, 100001, null, 100000, 27]) {
        assert.deepEqual(
          rowsJson(many, E1_SQL("all", offset), AAL1),
          [],
          String(offset),
        );
      }
      for (const segment of ["OPEN", "All", "", "closed", "decided", null]) {
        assert.deepEqual(
          rowsJson(many, E1_SQL(segment, 0), AAL1),
          [],
          String(segment),
        );
      }
      return { pages: [first.length, second.length] };
    },
  );

  await check(
    "E1-3 client_requests answers nothing of the client to anyone else: another client answers only their own Requests; the attorney of those Requests, finance and plain staff, a suspended client, a caller without a User and a request without claims or subject answer nothing of them; anon and service_role cannot execute it (42501)",
    () => {
      const owner = world.e1.client;
      const ownIds = new Set(world.e1.all.map((r) => r.request_id));
      const other = makeRequest({ key: "D" }).client;
      const otherRows = rowsJson(other, E1_SQL("all", 0), AAL1);
      assert.equal(otherRows.length, 1);
      assert.ok(!otherRows.some((r) => ownIds.has(r.request_id)));
      const suspended = makeRequest({ key: "D" }).client;
      sql(
        `update public.users set account_state = 'suspended' where id = '${suspended.user}';`,
      );
      for (const account of [
        world.ann,
        world.boast,
        world.finance,
        world.plainStaff,
        suspended,
        newAccount(),
      ]) {
        assert.deepEqual(rowsJson(account, E1_SQL("all", 0), AAL1), []);
        assert.deepEqual(rowsJson(account, E1_SQL("all", 0)), []);
      }
      assert.deepEqual(
        rowsAs("authenticated", uid(), E1_SQL("all", 0), AAL1),
        [],
      );
      assert.deepEqual(rowsAs("authenticated", null, E1_SQL("all", 0)), []);
      assert.equal(
        rowsJson(owner, E1_SQL("all", 0), { aal: null }).length,
        ownIds.size,
      );
      assert.deepEqual(apiRefusals(E1_SQL("all", 0)), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
    },
  );
}

// ---------------------------------------------------------------------------
// E2: client_consultation_parties
// ---------------------------------------------------------------------------

const E2_SQL =
  "select row_to_json(x)::text from public.client_consultation_parties() x;";
const CLIENT_LIST_SQL =
  "select row_to_json(x)::text from public.client_consultations() x;";
const AREAS_SQL =
  "select row_to_json(x)::text from public.client_intake_practice_areas() x;";

function practiceArea(name, active = true) {
  const id = uid();
  sql(
    `insert into public.practice_areas (id, code, name, active) values ('${id}', 'SYN_DEV001_${id.slice(0, 8).toUpperCase()}', ${lit(name)}, ${active});`,
  );
  return id;
}

function revision(intake, number, area) {
  sql(
    `insert into public.intake_revisions (intake_id, revision_number, question_set_id, practice_area_id, description, structured_answers)
       values ('${intake}', ${number}, '${world.questionSet}', ${lit(area)}, 'Synthetic description ${number}', '{}'::jsonb);`,
  );
}

async function e2Checks() {
  await check(
    "E2-1 client_consultation_parties answers, for exactly the Consultations client_consultations lists the caller and in the same order, exactly the Consultation, Request and Intake ids, the attorney name (client_request's rule: equal to client_request for the Request, null for a refused name) and the practice area name of the caller's latest revision of that Intake (equal to client_intake_practice_areas' name; an inactive area the caller chose included; null when the revision names none); nothing else",
    () => {
      const k = newClient();
      const k2 = withIntake(k);
      const k3 = withIntake(k);
      const older = practiceArea("Synthetic area older");
      const latest = practiceArea("Synthetic area latest");
      const inactive = practiceArea("Synthetic area inactive", false);
      revision(k.intake, 1, older);
      revision(k.intake, 2, latest);
      revision(k2.intake, 1, null);
      revision(k3.intake, 1, inactive);
      const first = acceptedConsultation({
        key: "S",
        who: world.ann,
        client: k,
      });
      const second = acceptedConsultation({
        key: "S",
        who: world.boast,
        client: k2,
      });
      const third = acceptedConsultation({
        key: "S",
        who: world.ann,
        client: k3,
      });
      assert.equal(clientCancel(second).outcome, "cancelled");
      const rows = rowsJson(k, E2_SQL, AAL1);
      assert.equal(
        keysOf(rows[0]),
        "attorney_display_name,consultation_id,consultation_request_id,intake_id,practice_area_name",
      );
      const list = rowsJson(k, CLIENT_LIST_SQL, AAL1).map(
        (r) => r.consultation_id,
      );
      assert.deepEqual(
        rows.map((r) => r.consultation_id),
        list,
      );
      assert.deepEqual(
        new Set(list),
        new Set([first.consultation, second.consultation, third.consultation]),
      );
      assert.equal(
        rows.at(-1).consultation_id,
        second.consultation,
        "the decided one is listed last",
      );
      const areas = new Map(
        rowsJson(k, AREAS_SQL, AAL1).map((a) => [a.id, a.name]),
      );
      const expected = new Map([
        [
          first.consultation,
          {
            s: first,
            intake: k.intake,
            name: "Ann Synthetic",
            area: areas.get(latest),
          },
        ],
        [
          second.consultation,
          { s: second, intake: k2.intake, name: null, area: null },
        ],
        [
          third.consultation,
          {
            s: third,
            intake: k3.intake,
            name: "Ann Synthetic",
            area: areas.get(inactive),
          },
        ],
      ]);
      assert.equal(areas.get(latest), "Synthetic area latest");
      assert.equal(areas.get(inactive), "Synthetic area inactive");
      for (const row of rows) {
        const e = expected.get(row.consultation_id);
        assert.equal(row.consultation_request_id, e.s.request);
        assert.equal(
          row.consultation_request_id,
          consultationOf(e.s.request).consultation_request_id,
        );
        assert.equal(row.intake_id, e.intake);
        const [decision] = rowsJson(k, CLIENT_DECISION_SQL(e.s.request), AAL1);
        assert.equal(row.intake_id, decision.intake_id);
        assert.equal(decision.consultation_id, row.consultation_id);
        const [single] = rowsJson(k, CLIENT_REQUEST_SQL(e.s.request), AAL1);
        assert.equal(row.attorney_display_name, single.attorney_display_name);
        assert.equal(row.attorney_display_name, e.name);
        assert.equal(row.practice_area_name, e.area);
      }
      assert.deepEqual(rowsJson(k, E2_SQL), rows, "the same answer at aal2");
      // Beyond 200 Consultations the two reads still list the same ones: the
      // order and the bound are client_consultations' own, word for word.
      const orderOf = (signature) => {
        const body = sql(
          `select prosrc from pg_proc where oid = 'public.${signature}'::regprocedure;`,
        )
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n");
        const at = body.search(/order by\s+case/);
        assert.ok(at > 0, signature);
        return body
          .slice(at, body.indexOf("limit 200;", at) + 10)
          .replace(/\s+/g, " ");
      };
      assert.equal(
        orderOf("client_consultation_parties()"),
        orderOf("client_consultations()"),
      );
      world.e2 = { client: k, rows };
      return {
        rows: rows.length,
        names: rows.map((r) => r.attorney_display_name),
        areas: rows.map((r) => r.practice_area_name),
      };
    },
  );

  await check(
    "E2-2 client_consultation_parties answers nothing of the client to anyone else: another client answers only their own; the attorneys of those Consultations, operations and plain staff, a suspended client, a caller without a User and a request without a subject answer nothing; anon and service_role cannot execute it (42501)",
    () => {
      const own = new Set(world.e2.rows.map((r) => r.consultation_id));
      const other = acceptedConsultation({ key: "S", who: world.ann });
      const otherRows = rowsJson(other.client, E2_SQL, AAL1);
      assert.deepEqual(
        otherRows.map((r) => r.consultation_id),
        [other.consultation],
      );
      assert.equal(
        otherRows[0].practice_area_name,
        null,
        "an Intake without a revision names no area",
      );
      assert.ok(!otherRows.some((r) => own.has(r.consultation_id)));
      const suspended = acceptedConsultation({
        key: "S",
        who: world.ann,
      }).client;
      sql(
        `update public.users set account_state = 'suspended' where id = '${suspended.user}';`,
      );
      for (const account of [
        world.ann,
        world.boast,
        world.ops,
        world.plainStaff,
        suspended,
        newAccount(),
      ]) {
        assert.deepEqual(rowsJson(account, E2_SQL, AAL1), []);
        assert.deepEqual(rowsJson(account, E2_SQL), []);
      }
      assert.deepEqual(rowsAs("authenticated", null, E2_SQL), []);
      assert.deepEqual(apiRefusals(E2_SQL), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
    },
  );
}

// ---------------------------------------------------------------------------
// E3: attorney_activity_counts
// ---------------------------------------------------------------------------

const E3_SQL = (from, until) =>
  `select row_to_json(x)::text from public.attorney_activity_counts(${from === null ? "null" : `${lit(from)}::timestamptz`}, ${until === null ? "null" : `${lit(until)}::timestamptz`}) x;`;
const ATTORNEY_REQUEST_SQL = (id) =>
  `select row_to_json(x)::text from public.attorney_request(${lit(id)}) x;`;
const HISTORY_SQL =
  "select row_to_json(x)::text from public.attorney_consultation_history() x;";
const DIMENSIONS = Object.freeze([
  ["requests", "accepted"],
  ["requests", "declined"],
  ["requests", "expired"],
  ["requests", "withdrawn"],
  ["requests", "could_not_proceed"],
  ["consultations", "completed"],
  ["consultations", "cancelled"],
  ["consultations", "no_show"],
  ["consultations", "technical_failure"],
]);
const countsOf = (rows) =>
  Object.fromEntries(rows.map((r) => [`${r.metric}.${r.dimension}`, r.value]));
const inPeriod = (instant, from, until) => {
  const t = new Date(instant).getTime();
  return t >= new Date(from).getTime() && t < new Date(until).getTime();
};

// The counts the existing per-item reads imply for an attorney and a period:
// attorney_request for every Request selected for them (a row only when
// offered), attorney_consultation_history for their ended Consultations.
function expectedCounts(who, from, until) {
  const counts = Object.fromEntries(
    DIMENSIONS.map(([m, d]) => [`${m}.${d}`, 0]),
  );
  const ids = sql(
    `select coalesce(string_agg(id::text, ','), '') from public.consultation_requests where selected_attorney_id = '${who.profile}';`,
  )
    .split(",")
    .filter((id) => id !== "");
  for (const id of ids) {
    const rows = rowsJson(who, ATTORNEY_REQUEST_SQL(id));
    if (rows.length === 0 || !inPeriod(rows[0].created_at, from, until)) {
      continue;
    }
    const outcome =
      rows[0].state === "accepted" ? "accepted" : rows[0].ended_reason;
    if (outcome !== null) {
      counts[`requests.${outcome}`] += 1;
    }
  }
  for (const row of rowsJson(who, HISTORY_SQL)) {
    if (inPeriod(row.ended_at, from, until)) {
      counts[`consultations.${row.state}`] += 1;
    }
  }
  return counts;
}

async function e3Checks() {
  await check(
    "E3-1 attorney_activity_counts answers the nine dimensions in their fixed order for the caller's approved profile at aal2, each equal to what attorney_request (Requests offered to the caller, by outcome, by creation instant) and attorney_consultation_history (ended Consultations by state, by end instant) answer for the period: accepted, declined (two), expired, withdrawn, could_not_proceed; completed, cancelled, no_show, technical_failure; a Request never offered (withdrawn while awaiting its payment step), a Request created before the period and a Consultation ended before it are not counted",
    async () => {
      const cal = lawyer("Cal Synthetic", "S", "D", "E");
      world.cal = cal;
      // Before the period: five accepted Consultations (ended later) and one
      // declined Request.
      const consultations = [];
      for (let i = 0; i < 5; i += 1) {
        consultations.push(acceptedConsultation({ key: "S", who: cal }));
      }
      const old = makeRequest({ key: "D", lawyer: cal });
      assert.equal(decline(cal, old.request), "declined");
      const from = clock();
      // could_not_proceed (PM row 38): the licence stops qualifying before
      // the decision, then qualifies again.
      const blocked = makeRequest({ key: "D", lawyer: cal });
      sql(
        `update public.licenses set reported_status = 'synthetic-suspended' where attorney_id = '${cal.profile}' and jurisdiction_id = '${world.J.D}';`,
      );
      assert.equal(accept(cal, blocked.request).outcome, "not_eligible");
      sql(
        `update public.licenses set reported_status = 'synthetic-active' where attorney_id = '${cal.profile}' and jurisdiction_id = '${world.J.D}';`,
      );
      const accepted = makeRequest({ key: "D", lawyer: cal });
      assert.equal(accept(cal, accepted.request).outcome, "accepted");
      for (let i = 0; i < 2; i += 1) {
        const d = makeRequest({ key: "D", lawyer: cal });
        assert.equal(decline(cal, d.request), "declined");
      }
      const withdrawn = makeRequest({ key: "D", lawyer: cal });
      assert.equal(withdraw(withdrawn.client, withdrawn.request), "withdrawn");
      const unoffered = makeRequest({ key: "S", lawyer: cal });
      assert.ok(UNDECIDED.includes(requestOf(unoffered.request).state));
      assert.notEqual(requestOf(unoffered.request).state, "awaiting_attorney");
      assert.equal(withdraw(unoffered.client, unoffered.request), "withdrawn");
      assert.deepEqual(
        rowsJson(cal, ATTORNEY_REQUEST_SQL(unoffered.request)),
        [],
      );
      const expiring = makeRequest({ key: "E", lawyer: cal });
      await untilPast(requestOf(expiring.request).response_deadline_at);
      assert.equal(
        sql(
          `select public.request_expire_if_due('${expiring.request}', false);`,
        ),
        "expired",
      );
      // The Consultations end in the period: a real cancellation; completed,
      // no_show and technical_failure planted (triggers bypassed) with their
      // outcome codes; one completed planted before the period.
      assert.equal(clientCancel(consultations[0]).outcome, "cancelled");
      const plant = (s, stateValue, code, startedAt, endedAt) =>
        planted(
          `update public.consultations set state = '${stateValue}', outcome_code = '${code}', started_at = ${startedAt}, ended_at = ${endedAt} where id = '${s.consultation}';`,
        );
      plant(
        consultations[1],
        "completed",
        "normal",
        "clock_timestamp() - interval '30 minutes'",
        "clock_timestamp()",
      );
      plant(
        consultations[2],
        "no_show",
        "client_no_show",
        "null",
        "clock_timestamp()",
      );
      plant(
        consultations[3],
        "technical_failure",
        "neither_connected",
        "null",
        "clock_timestamp()",
      );
      plant(
        consultations[4],
        "completed",
        "normal",
        `${lit(from)}::timestamptz - interval '90 minutes'`,
        `${lit(from)}::timestamptz - interval '1 hour'`,
      );
      const until = sql(
        "select (clock_timestamp() + interval '1 hour')::text;",
      );
      const rows = rowsJson(cal, E3_SQL(from, until));
      assert.deepEqual(
        rows.map((r) => [r.metric, r.dimension]),
        DIMENSIONS,
      );
      assert.equal(keysOf(rows[0]), "dimension,metric,value");
      const counts = countsOf(rows);
      assert.deepEqual(counts, expectedCounts(cal, from, until));
      assert.deepEqual(counts, {
        "requests.accepted": 1,
        "requests.declined": 2,
        "requests.expired": 1,
        "requests.withdrawn": 1,
        "requests.could_not_proceed": 1,
        "consultations.completed": 1,
        "consultations.cancelled": 1,
        "consultations.no_show": 1,
        "consultations.technical_failure": 1,
      });
      // The Request created before the period and the Consultation ended
      // before it count in a period that covers them.
      const wide = countsOf(
        rowsJson(
          cal,
          E3_SQL(
            sql(`select (${lit(from)}::timestamptz - interval '1 day')::text;`),
            until,
          ),
        ),
      );
      assert.equal(wide["requests.declined"], 3);
      assert.equal(wide["consultations.completed"], 2);
      assert.equal(
        wide["requests.accepted"],
        6,
        "the five earlier acceptances",
      );
      world.e3 = { from, until };
      return counts;
    },
  );

  await check(
    "E3-2 attorney_activity_counts answers every dimension even when zero (an approved attorney without activity answers the nine zeros) and another attorney answers only their own counts (equal to their own per-item reads)",
    () => {
      const { from, until } = world.e3;
      const zed = lawyer("Zed Synthetic", "D");
      const zero = rowsJson(zed, E3_SQL(from, until));
      assert.deepEqual(
        zero.map((r) => [r.metric, r.dimension, r.value]),
        DIMENSIONS.map(([m, d]) => [m, d, 0]),
      );
      // A period covering all of the other attorney's earlier activity.
      const wideFrom = sql(
        `select (${lit(from)}::timestamptz - interval '1 day')::text;`,
      );
      const ann = countsOf(rowsJson(world.ann, E3_SQL(wideFrom, until)));
      assert.deepEqual(ann, expectedCounts(world.ann, wideFrom, until));
      assert.ok(ann["requests.accepted"] >= 1 && ann["requests.declined"] >= 1);
      assert.ok(ann["requests.withdrawn"] >= 1 && ann["requests.expired"] >= 1);
      const boast = countsOf(rowsJson(world.boast, E3_SQL(wideFrom, until)));
      assert.deepEqual(boast, expectedCounts(world.boast, wideFrom, until));
      assert.equal(
        boast["consultations.cancelled"],
        1,
        "the Consultation E2 cancelled",
      );
      const calWide = countsOf(rowsJson(world.cal, E3_SQL(wideFrom, until)));
      assert.deepEqual(calWide, expectedCounts(world.cal, wideFrom, until));
      return { ann, boast, cal: calWide };
    },
  );

  await check(
    "E3-3 attorney_activity_counts takes a period [from, until) of at most 366 days of 86400 seconds: exactly 366 days answers, one second more, an empty or reversed period, a missing bound and an infinite bound answer nothing (never an error)",
    () => {
      const cal = world.cal;
      assert.equal(
        rowsJson(cal, E3_SQL("2026-01-01T00:00:00Z", "2027-01-02T00:00:00Z"))
          .length,
        9,
      );
      for (const [from, until] of [
        ["2026-01-01T00:00:00Z", "2027-01-02T00:00:01Z"],
        ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        ["2026-02-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        [null, "2026-01-01T00:00:00Z"],
        ["2026-01-01T00:00:00Z", null],
        [null, null],
        ["2026-01-01T00:00:00Z", "infinity"],
        ["-infinity", "2026-01-01T00:00:00Z"],
        ["-infinity", "infinity"],
      ]) {
        assert.deepEqual(
          rowsJson(cal, E3_SQL(from, until)),
          [],
          `${from} ${until}`,
        );
      }
    },
  );

  await check(
    "E3-4 attorney_activity_counts answers nothing to a caller it does not serve: the attorney at aal1 or without claims, an attorney whose profile is not approved, a suspended attorney account, the clients of the attorney's Requests, finance and plain staff and a caller without a User; anon and service_role cannot execute it (42501)",
    () => {
      const { from, until } = world.e3;
      const cal = world.cal;
      assert.deepEqual(rowsJson(cal, E3_SQL(from, until), AAL1), []);
      assert.deepEqual(rowsJson(cal, E3_SQL(from, until), { aal: null }), []);
      const reviewing = attorney({
        name: "Rae Synthetic",
        jurisdictions: [world.J.D],
        profileState: "under_review",
      });
      const suspended = lawyer("Sue Synthetic", "D");
      sql(
        `update public.users set account_state = 'suspended' where id = '${suspended.user}';`,
      );
      const someClient = sql(
        `select u.auth_user_id from public.consultation_requests r join public.client_profiles cp on cp.id = r.client_id join public.users u on u.id = cp.user_id where r.selected_attorney_id = '${cal.profile}' limit 1;`,
      );
      for (const account of [
        reviewing,
        suspended,
        { auth: someClient },
        world.finance,
        world.plainStaff,
        newAccount(),
      ]) {
        assert.deepEqual(rowsJson(account, E3_SQL(from, until)), []);
        assert.deepEqual(rowsJson(account, E3_SQL(from, until), AAL1), []);
      }
      assert.deepEqual(rowsAs("authenticated", uid(), E3_SQL(from, until)), []);
      assert.deepEqual(apiRefusals(E3_SQL(from, until)), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
    },
  );
}

// ---------------------------------------------------------------------------
// E4: staff_payment_dispute_events
// ---------------------------------------------------------------------------

const E4_SQL = (payment) =>
  `select row_to_json(x)::text from public.staff_payment_dispute_events(${payment === null ? "null::uuid" : `${lit(payment)}::uuid`}) x;`;
const FINANCE_EXCEPTIONS_SQL = (status, offset) =>
  `select row_to_json(x)::text from public.staff_finance_exceptions(${lit(status)}, ${offset}) x;`;
const E4_COLUMNS = Object.freeze([
  "exception_id",
  "exception_type",
  "severity",
  "status",
  "detected_at",
  "evidence_reference",
  "resolved_at",
  "resolution_notes",
]);

// One planted review item (owner; synthetic data only).
function plantException(type, canonicalType, canonicalId, severity = "medium") {
  const id = uid();
  sql(
    `insert into public.reconciliation_exceptions (id, source_type, source_id, canonical_type, canonical_id, exception_type, severity, detected_at, status, evidence_reference)
       values ('${id}', 'synthetic_probe', '${uid()}', ${lit(canonicalType)}, '${canonicalId}', ${lit(type)}, ${lit(severity)}, clock_timestamp(), 'open', '{"synthetic": true}'::jsonb);`,
  );
  return id;
}

// Every row staff_finance_exceptions answers the caller, both statuses.
function financeExceptions(staff) {
  const rows = [];
  for (const status of ["open", "resolved"]) {
    for (let offset = 0; ; offset += 25) {
      const page = rowsJson(staff, FINANCE_EXCEPTIONS_SQL(status, offset));
      rows.push(...page.slice(0, 25));
      if (page.length <= 25) {
        break;
      }
    }
  }
  return new Map(rows.map((r) => [r.exception_id, r]));
}

async function e4Checks() {
  await check(
    "E4-1 staff_payment_dispute_events answers a global finance holder at aal2 exactly one payment's provider dispute items (dispute_opened, dispute_updated, dispute_closed), oldest first, with exactly its eight columns, each equal to staff_finance_exceptions' row for the same item (a resolved one with its resolution); another payment's disputes, the payment's other financial items, items of the operations and compliance families attached to it and a dispute type about another canonical record are not answered; an unknown or missing payment answers nothing",
    () => {
      const p1 = capturedPayment({ key: "A", requestPath: "instant" });
      const p2 = capturedPayment({ key: "A", requestPath: "instant" });
      const opened = providerEvent(
        "charge.dispute.created",
        obs("dispute_opened", {
          payment_reference: p1.reference,
          dispute_reference: "dp_synthetic_dev001_one",
          amount_minor: p1.total,
          currency_code: "XTS",
          provider_status: "needs_response",
        }),
      );
      assert.equal(opened.processing, "applied", opened.line);
      const updated = providerEvent(
        "charge.dispute.updated",
        obs("dispute_updated", {
          payment_reference: p1.reference,
          dispute_reference: "dp_synthetic_dev001_one",
          provider_status: "under_review",
        }),
      );
      assert.equal(updated.processing, "no_effect", updated.line);
      const closed = providerEvent(
        "charge.dispute.closed",
        obs("dispute_closed", {
          payment_reference: p1.reference,
          dispute_reference: "dp_synthetic_dev001_one",
          provider_status: "won",
        }),
      );
      assert.equal(closed.processing, "no_effect", closed.line);
      const otherDispute = providerEvent(
        "charge.dispute.created",
        obs("dispute_opened", {
          payment_reference: p2.reference,
          dispute_reference: "dp_synthetic_dev001_two",
          amount_minor: p2.total,
          currency_code: "XTS",
          provider_status: "needs_response",
        }),
      );
      assert.equal(otherDispute.processing, "applied", otherDispute.line);
      const excluded = [
        plantException(
          "amount_mismatch",
          "payment_transaction",
          p1.payment,
          "critical",
        ),
        plantException(
          "notification_delivery_failed",
          "payment_transaction",
          p1.payment,
        ),
        plantException(
          "eligibility_change_review",
          "payment_transaction",
          p1.payment,
        ),
        plantException("dispute_updated", "consultation", p1.payment),
      ];
      const disputeIds = sql(
        `select string_agg(id::text, ',' order by detected_at, id) from public.reconciliation_exceptions where canonical_type = 'payment_transaction' and canonical_id = '${p1.payment}' and exception_type in ('dispute_opened', 'dispute_updated', 'dispute_closed');`,
      ).split(",");
      assert.equal(disputeIds.length, 3);
      const resolvedId = disputeIds[2];
      assert.equal(
        asStaff(
          world.finance,
          `select public.staff_resolve_reconciliation_exception('${resolvedId}', 'Synthetic resolution note');`,
        ),
        "applied",
      );
      const rows = rowsJson(world.finance, E4_SQL(p1.payment));
      assert.equal(keysOf(rows[0]), [...E4_COLUMNS].sort().join(","));
      assert.deepEqual(
        rows.map((r) => r.exception_id),
        disputeIds,
      );
      assert.deepEqual(
        rows.map((r) => [r.exception_type, r.severity, r.status]),
        [
          ["dispute_opened", "high", "open"],
          ["dispute_updated", "medium", "open"],
          ["dispute_closed", "medium", "resolved"],
        ],
      );
      assert.equal(rows[2].resolution_notes, "Synthetic resolution note");
      assert.notEqual(rows[2].resolved_at, null);
      assert.equal(
        rows[0].evidence_reference.observation.dispute_reference,
        "dp_synthetic_dev001_one",
      );
      const listed = financeExceptions(world.finance);
      for (const row of rows) {
        const same = listed.get(row.exception_id);
        assert.ok(same, `${row.exception_id} is in staff_finance_exceptions`);
        for (const column of E4_COLUMNS) {
          assert.deepEqual(
            row[column],
            same[column],
            `${row.exception_id} ${column}`,
          );
        }
        assert.equal(same.canonical_type, "payment_transaction");
        assert.equal(same.canonical_id, p1.payment);
      }
      for (const id of excluded) {
        assert.ok(!rows.some((r) => r.exception_id === id), id);
      }
      // The excluded financial item is one staff_finance_exceptions lists:
      // the dispute read is narrower, never wider.
      assert.ok(listed.has(excluded[0]));
      assert.ok(!listed.has(excluded[1]) && !listed.has(excluded[2]));
      const other = rowsJson(world.finance, E4_SQL(p2.payment));
      assert.deepEqual(
        other.map((r) => r.exception_type),
        ["dispute_opened"],
      );
      assert.ok(!other.some((r) => disputeIds.includes(r.exception_id)));
      assert.deepEqual(rowsJson(world.finance, E4_SQL(uid())), []);
      assert.deepEqual(rowsJson(world.finance, E4_SQL(null)), []);
      world.e4 = { p1, rows };
      return { events: rows.map((r) => r.exception_type), other: other.length };
    },
  );

  await check(
    "E4-2 staff_payment_dispute_events answers nothing to a caller staff_finance_exceptions does not serve: the finance holder at aal1 or without claims, a jurisdiction-scoped finance grant, the operations and compliance family holders, plain staff, a finance holder whose staff profile is deactivated, whose grant is revoked or expired, or whose account is suspended, the payment's client and attorney, and a caller without a User; anon and service_role cannot execute it (42501)",
    () => {
      const { p1 } = world.e4;
      const statement = E4_SQL(p1.payment);
      assert.deepEqual(rowsJson(world.finance, statement, AAL1), []);
      assert.deepEqual(rowsJson(world.finance, statement, { aal: null }), []);
      const deactivated = staffWith(["manage_financial_operations", null]);
      sql(
        `update public.staff_profiles set staff_state = 'deactivated' where user_id = '${deactivated.user}';`,
      );
      const revoked = staffWith(["manage_financial_operations", null]);
      sql(
        `update public.capability_grants set revoked_at = clock_timestamp() where user_id = '${revoked.user}';`,
      );
      const expired = newAccount();
      sql(
        `insert into public.staff_profiles (user_id, staff_state) values ('${expired.user}', 'active');
         insert into public.capability_grants (user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at, expires_at) values ('${expired.user}', 'manage_financial_operations', '${world.grantor.user}', null, now() - interval '2 days', now() - interval '1 day');`,
      );
      const suspended = staffWith(["manage_financial_operations", null]);
      sql(
        `update public.users set account_state = 'suspended' where id = '${suspended.user}';`,
      );
      // Each of these was a working finance holder until its change.
      for (const account of [
        world.financeS,
        world.ops,
        world.compliance,
        world.plainStaff,
        deactivated,
        revoked,
        expired,
        suspended,
        p1.client,
        world.ann,
        newAccount(),
      ]) {
        assert.deepEqual(rowsJson(account, statement), []);
      }
      assert.deepEqual(rowsAs("authenticated", uid(), statement), []);
      assert.deepEqual(apiRefusals(statement), {
        anon: "ERROR 42501",
        service_role: "ERROR 42501",
      });
      assert.equal(
        rowsJson(world.finance, statement).length,
        3,
        "the holder still reads them",
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
    sql("select public.record_deployment_environment('development', null);");
    report.environment = sql(
      "select environment_class from public.deployment_environment;",
    );
    seed();
    world.e1 = {};
    await migrationChecks();
    await e1Checks();
    await e2Checks();
    await e3Checks();
    await e4Checks();
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
  report.duration_ms = Date.now() - started;
  report.result = failed ? "FAIL" : cleaned ? "PASS" : "CLEANUP-FAILED";
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = failed ? 1 : cleaned ? 0 : 2;
}

await main();
