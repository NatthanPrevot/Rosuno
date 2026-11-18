// P3-003 disposable PostgreSQL proof. Explicitly invoked only:
//
//   node apps/web/tests/m4-db-proof.mjs
//
// This is deliberately not a *.test.mjs file, so no application test run,
// p0:test, or CI job starts it. It uses Node built-ins, the system-installed
// PostgreSQL 16 initdb, pg_ctl, and psql binaries, and the application's own
// TypeScript modules (loaded by Node's type stripping).
//
// It creates a new mode-0700 temporary directory, initializes a new cluster
// in it owned by an unprivileged account (never root), and starts it with TCP
// disabled and a private Unix-domain socket in that directory. Every child
// process gets a fixed minimal environment. The fixture roles anon,
// authenticated, and service_role (BYPASSRLS), the synthetic auth schema
// (auth.users and an auth.uid() that reads request.jwt.claim.sub), and a
// no-op stand-in for the platform function public.rls_auto_enable() are
// synthetic objects of this cluster only: they model the hosted platform and
// are not evidence of any remote project's grants. All fourteen committed
// migrations are then applied unmodified, in order, each in one transaction.
//
// P3-904 update: the run now applies the single P3-904 migration after the
// fourteen historical ones. The checks that documented the P3-003 defects
// (SEC-1, SEC-2, SEC-3) assert the corrected behaviour instead, and the
// checks that wrote through the retired service-role grants (APP-1, APP-3,
// APP-4) write through the operation-specific database functions. The full
// P3-904 proof is p3-904-db-proof.mjs.
//
// MVP-001 S1 update: the four S1 migrations follow. The database records its
// environment once, as the owner, before the policy-driven checks (PS-A2;
// ENV-1 first proves the unrecorded refusal); policy fixtures are created as
// drafts by the owner and walked through the lifecycle (the service role no
// longer writes policy or configuration relations); the eligibility policy
// type is 'eligibility' (SCH-4); create paths take a NULL id and the database
// generates the key (SCH-1, APP-4); and RLS-3 and SEC-1 follow the staff read
// policies and definer functions S1 adds, as exact assertions.
//
// MVP-001 S2 update: the three S2 migrations follow. Staff authority and
// attorney professional writes need an aal2 session (20261118030000), so
// every request with a JWT subject now also carries request.jwt.claims with
// "aal": "aal2", as PostgREST sets it from a verified, MFA-stepped-up JWT;
// RLS-2 adds the aal1 and claim-less refusals. SEC-1 lists the S2 definer
// functions (the worker and staff job functions), as exact assertions.
//
// MVP-001 S4 update: the three S4 migrations follow. SEC-1 lists exactly the
// nine S4 definer functions (the attorney schedule and Instant mode
// functions and the session observation and sign-out), as exact assertions;
// none writes an M4 relation.
//
// MVP-001 S5 update: the three S5 migrations follow. SEC-1 lists exactly the
// seven S5 definer functions, as exact assertions: the three public
// discovery reads and the client's attempt list (stable, writing nothing),
// the two deferred referral evidence checks (read only), and referral_create,
// the one S5 write path to an M4 relation: it appends decision-point
// eligibility_evaluations rows (never an update or delete; S5 makes that
// relation append-only for every role) together with its Referral.
//
// MVP-001 S6 update: the three S6 migrations follow. SEC-1 lists exactly the
// twelve further definer functions, as exact assertions: the client's
// request review, options, slot starts, quote preview, Request detail and
// Intake attempt reads (stable, writing nothing); the two deferred request
// and Fee Calculation evidence checks and the two P1 deferred Request/Hold
// and Request/payment consistency checks S6 makes security definer (trigger
// functions, executable by no API role, read only); request_withdraw, which
// writes no M4 relation; and request_create, the one S6 write path to an M4
// relation: it appends decision-point eligibility_evaluations rows (never an
// update or delete) together with its Request.
//
// MVP-001 S6 PS-A3 update: the PS-A3 migration follows. SEC-1 lists exactly
// the five further definer functions, as exact assertions: the attorney's
// own offer list and offer options reads and the public offer read (stable,
// writing nothing), and the attorney's offer set and withdrawal functions,
// which write only attorney_consultation_offers and audit events; no M4
// relation. request_create, client_request and client_request_review are
// replaced under their own names (already listed).
//
// MVP-001 S7 update: the two S7 migrations follow. SEC-1 lists exactly the
// nineteen further definer functions, as exact assertions: the client's
// payment authorization, payment step, checkout link and receipt; the
// attorney's earnings read; the finance workspace's five reads and four
// writes; the payment worker and webhook recording functions; and the two
// payment trigger functions. None writes an M4 relation; request_create is
// replaced under its own name (already listed).
//
// The probes exercise the real row policies, grants, constraints, triggers,
// and the manage_attorney_verification scope predicate for synthetic
// attorneys, staff, and grants (current, jurisdiction-scoped, expired,
// revoked, resource-scoped, not yet valid, and absent), and check that rows
// the database itself serializes as JSON (as PostgREST does) are accepted by
// the application's strict readers, that the policy selector and assessment
// run on them, and that the evaluation and audit rows the application builds
// insert as the service role, with earlier evaluations immutable. No
// Supabase project, network service, or pre-existing cluster is contacted,
// nothing persists after the run, and every value is synthetic test data.
// The JSON report goes to stdout; exit 0 means PASS, 1 FAIL, 2 cleanup
// failure, 3 refused to start.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assessEligibility,
  evaluationRowOf,
} from "../src/application/eligibility-assessment.ts";
import {
  AUTHORITY_REFERENCE_COLUMNS,
  POLICY_VERSION_COLUMNS,
  selectEligibilityPolicy,
} from "../src/application/policy-selection.ts";
import {
  DISCIPLINE_COLUMNS,
  EVALUATION_COLUMNS,
  EVIDENCE_COLUMNS,
  EVIDENCE_SUBJECT_COLUMNS,
  INSURANCE_COLUMNS,
  LICENSE_COLUMNS,
  PRACTICE_AUTHORISATION_COLUMNS,
  PROFILE_COLUMNS,
  readEvaluation,
  readEvidence,
  readEvidenceSubject,
  readInsurance,
  readLicense,
  readPracticeAuthorisation,
  readProfile,
} from "../src/application/professional-records.ts";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54333;
const DB = "rosuno_m4_proof";
const REPOSITORY_ROOT = path.resolve(
  path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
  "../../..",
);
const MIGRATIONS = path.join(REPOSITORY_ROOT, "supabase/migrations");

const report = {
  proof: "P3-003 disposable local PostgreSQL M4 proof",
  migrations: [],
  checks: [],
  cluster: {},
};
let state = null;

// Synthetic ids: attorneys A and B, staff with different grants, a client,
// and the grantor. None is a real account.
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AUTH = {
  attorneyA: U(101),
  attorneyB: U(102),
  staffGlobal: U(103),
  staffA: U(104),
  staffExpired: U(105),
  staffRevoked: U(106),
  staffResource: U(107),
  staffNoGrant: U(108),
  staffFuture: U(109),
  client: U(110),
  grantor: U(111),
};
const USER = Object.fromEntries(
  Object.entries(AUTH).map(([k, v]) => [k, v.replace(/1(\d\d)$/, "2$1")]),
);
const J_A = U(301);
const J_B = U(302);
const PROFILE_A = U(401);
const PROFILE_B = U(402);
const AREA = U(501);

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
  const result = spawnSync(path.join(BIN, tool), args, {
    env: childEnvironment(),
    encoding: "utf8",
    input,
    timeout: 120000,
    cwd: state.tmp,
    ...state.identity.spawn,
  });
  return result;
}

// Runs a script as the superuser; ON_ERROR_STOP, verbose errors with codes.
function psql(script, db = DB) {
  return run(
    "psql",
    [
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
    ],
    script,
  );
}

function sql(script, db) {
  const result = psql(script, db);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// The JWT claims of a request with a subject (MVP-001 S2): "aal": "aal2"
// after MFA step-up, "aal1" before it; aal null sends no claims.
function claimsLine(subject, aal) {
  return subject === null || aal === null
    ? ""
    : `select set_config('request.jwt.claims', '${JSON.stringify({ sub: subject, role: "authenticated", aal })}', true) is not null;`;
}

// One statement as a role with a JWT subject, inside a transaction that is
// always rolled back, so probes never change state.
function as(role, subject, statement, { aal = "aal2" } = {}) {
  return psql(
    [
      "begin;",
      `set local role ${role};`,
      subject === null
        ? ""
        : `select set_config('request.jwt.claim.sub', '${subject}', true) is not null;`,
      claimsLine(subject, aal),
      statement,
      "rollback;",
      "",
    ].join("\n"),
  );
}

function valueAs(role, subject, statement, options = {}) {
  const result = as(role, subject, statement, options);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  return lines[lines.length - 1];
}

function sqlstateOf(result) {
  return /ERROR:\s+([0-9A-Z]{5}):/.exec(result.stderr ?? "")?.[1] ?? null;
}

// A synthetic audit row of the audit_events shape (test data only).
function syntheticAuditRow(fields) {
  return {
    actor_user_id: fields.actor,
    actor_type: fields.actorType,
    action_code: fields.action,
    resource_type: fields.resourceType,
    resource_id: fields.resourceId,
    before_snapshot: fields.before ?? null,
    after_snapshot: fields.after ?? null,
    reason_code: null,
    policy_references: null,
    jurisdiction_id: fields.jurisdictionId ?? null,
    occurred_at: new Date().toISOString(),
  };
}

const lit = (value) =>
  value === null ? "null" : `'${String(value).replaceAll("'", "''")}'`;

// One P3-904 write function called as a principal, committed.
function callAs(subject, name, args) {
  const named = Object.entries(args)
    .map(
      ([key, value]) =>
        `${key} => ${typeof value === "object" && value !== null ? `${lit(JSON.stringify(value))}` : lit(value)}`,
    )
    .join(", ");
  const result = psql(
    [
      "begin;",
      "set local role authenticated;",
      `select set_config('request.jwt.claim.sub', '${subject}', true) is not null;`,
      claimsLine(subject, "aal2"),
      `select public.${name}(${named});`,
      "commit;",
      "",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  return lines[lines.length - 1];
}

// Rows exactly as the database serializes them to JSON for a column list.
function jsonRows(columns, from) {
  return JSON.parse(
    sql(
      `select coalesce(json_agg(t), '[]'::json) from (select ${columns} from ${from}) t;`,
    ),
  );
}

function check(name, body) {
  try {
    const detail = body();
    report.checks.push({
      name,
      result: "PASS",
      ...(detail === undefined ? {} : { detail }),
    });
  } catch (error) {
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
  }
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

function seedSql() {
  const lines = [];
  for (const [key, authId] of Object.entries(AUTH)) {
    lines.push(`insert into auth.users (id) values ('${authId}');`);
    lines.push(
      `insert into public.users (id, auth_user_id, account_state) values ('${USER[key]}', '${authId}', 'active');`,
    );
  }
  lines.push(
    `insert into public.jurisdictions (id, code, name, region_type) values ('${J_A}', 'SYN_A', 'Synthetic A', 'synthetic'), ('${J_B}', 'SYN_B', 'Synthetic B', 'synthetic');`,
  );
  lines.push(
    `insert into public.practice_areas (id, code, name, active) values ('${AREA}', 'SYN_AREA', 'Synthetic area', true);`,
  );
  lines.push(
    `insert into public.attorney_profiles (id, user_id, profile_state) values ('${PROFILE_A}', '${USER.attorneyA}', 'applicant'), ('${PROFILE_B}', '${USER.attorneyB}', 'under_review');`,
  );
  for (const key of [
    "staffGlobal",
    "staffA",
    "staffExpired",
    "staffRevoked",
    "staffResource",
    "staffNoGrant",
    "staffFuture",
    "grantor",
  ]) {
    lines.push(
      `insert into public.staff_profiles (user_id, staff_state) values ('${USER[key]}', 'active');`,
    );
  }
  const grant = (key, extra) =>
    `insert into public.capability_grants (user_id, capability_code, granted_by_user_id, ${Object.keys(extra).join(", ")}) values ('${USER[key]}', 'manage_attorney_verification', '${USER.grantor}', ${Object.values(extra).join(", ")});`;
  lines.push(grant("staffGlobal", { granted_at: "now() - interval '1 day'" }));
  lines.push(
    grant("staffA", {
      granted_at: "now() - interval '1 day'",
      jurisdiction_id: `'${J_A}'`,
    }),
  );
  lines.push(
    grant("staffExpired", {
      granted_at: "now() - interval '2 days'",
      expires_at: "now() - interval '1 day'",
    }),
  );
  lines.push(
    grant("staffRevoked", {
      granted_at: "now() - interval '2 days'",
      revoked_at: "now() - interval '1 day'",
    }),
  );
  lines.push(
    grant("staffResource", {
      granted_at: "now() - interval '1 day'",
      resource_scope: `'{"synthetic": true}'::jsonb`,
    }),
  );
  lines.push(grant("staffFuture", { granted_at: "now() + interval '1 day'" }));
  return lines.join("\n");
}

function startCluster() {
  const identity = unprivilegedIdentity();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rosuno-p3-003-db-proof-"));
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
      "select json_build_object('version', current_setting('server_version'), 'listen_addresses', current_setting('listen_addresses'), 'tcp', inet_server_addr() is not null)::text;",
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

function applyMigrations() {
  const files = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  // The fourteen historical migrations and the single P3-904 correction,
  // followed only by later migrations registered in the migration register
  // (P5-001 re-pin: the accepted fifteen-migration prefix stays exact).
  assert.ok(files.length >= 15);
  assert.equal(
    files[14],
    "20261106090000_p3_904_professional_write_boundary.sql",
  );
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
  for (const file of files.slice(15)) {
    assert.ok(
      registered.has(`supabase/migrations/${file}`),
      `${file} is not a registered later migration`,
    );
  }
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(MIGRATIONS, file));
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
      bytes.toString("utf8"),
    );
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    report.migrations.push({
      file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
}

const SCOPE = (subject, jurisdiction, options = {}) =>
  valueAs(
    "authenticated",
    subject,
    `select public.has_manage_attorney_verification_scope(${jurisdiction === null ? "null" : `'${jurisdiction}'`}, false);`,
    options,
  );
const COUNT = (subject, table, where = "true", options = {}) =>
  Number(
    valueAs(
      "authenticated",
      subject,
      `select count(*) from public.${table} where ${where};`,
      options,
    ),
  );

// MVP-001 S1: a synthetic test-only policy version, created as a draft by the
// table owner (the service role no longer writes policy relations), with one
// synthetic authority reference, then walked through the lifecycle the
// policy_version_integrity trigger allows. Approval, its actor, and the
// effective start are set in the same update; nothing changes afterwards.
function policySeedSql(
  id,
  jurisdiction,
  label,
  parameters,
  { activate = true, verified = true } = {},
) {
  const lines = [
    `insert into public.policy_versions (id, policy_type_code, jurisdiction_id, version_label, parameters) values ('${id}', 'eligibility', '${jurisdiction}', '${label}', $j$${JSON.stringify(parameters)}$j$::jsonb);`,
    `insert into public.policy_authority_references (policy_version_id, authority_type, citation_text, source_title, retrieved_at, verified_by_user_id, verification_status) values ('${id}', 'synthetic', 'synthetic citation', 'synthetic source', now(), ${verified ? `'${USER.grantor}'` : "null"}, '${verified ? "verified" : "unverified"}');`,
  ];
  if (activate) {
    lines.push(
      `update public.policy_versions set status = 'internal_review' where id = '${id}';`,
      `update public.policy_versions set status = 'counsel_review' where id = '${id}';`,
      `update public.policy_versions set status = 'approved', approved_at = now() - interval '2 days', approved_by_user_id = '${USER.grantor}', effective_from = now() - interval '1 day' where id = '${id}';`,
      `update public.policy_versions set status = 'active' where id = '${id}';`,
    );
  }
  return lines.join("\n");
}

// PS-A2: nothing is selectable before the database records its environment;
// the owner records it once, as development, and the record is immutable.
function environmentChecks() {
  check(
    "ENV-1 (MVP-001 S1, PS-A2) an unrecorded database refuses eligibility selection; the owner records the environment once, API roles cannot, and the record is immutable",
    () => {
      const identity = () =>
        valueAs(
          "authenticated",
          AUTH.attorneyA,
          "select environment_class || '|' || coalesce(project_ref, '') from public.deployment_environment_identity();",
        );
      assert.equal(identity(), "unrecorded|");
      assert.deepEqual(
        JSON.parse(
          sql(
            `select public.eligibility_selected_policy('${J_A}', now())::text;`,
          ),
        ),
        { status: "undetermined", reason: "environment_unrecorded" },
      );
      assert.equal(
        selectEligibilityPolicy(J_A, Date.now(), [], [], "unrecorded").reason,
        "environment_unrecorded",
      );
      for (const role of ["authenticated", "service_role", "anon"]) {
        assert.equal(
          sqlstateOf(
            as(
              role,
              null,
              "select public.record_deployment_environment('development', null);",
            ),
          ),
          "42501",
          role,
        );
      }
      assert.match(
        sql(
          "select public.record_deployment_environment('development', null);",
        ),
        /^[0-9a-f-]{36}$/,
      );
      assert.equal(
        sqlstateOf(
          psql(
            "select public.record_deployment_environment('development', null);",
          ),
        ),
        "55000",
      );
      assert.equal(
        sqlstateOf(
          psql(
            "begin; update public.deployment_environment set environment_class = 'production', project_ref = 'syntheticprojectrefa'; rollback;",
          ),
        ),
        "55000",
      );
      assert.equal(
        sqlstateOf(
          psql("begin; delete from public.deployment_environment; rollback;"),
        ),
        "55000",
      );
      assert.equal(identity(), "development|");
      return { before: "environment_unrecorded", recorded: "development" };
    },
  );
}

function ensureEnvironmentRecorded() {
  sql(
    "select public.record_deployment_environment('development', null) where not exists (select 1 from public.deployment_environment);",
  );
}

function probes() {
  // Synthetic professional records: A in SYN_A with evidence; B in SYN_B.
  // MVP-001 S1: plus an inert synthetic draft policy version (never
  // selectable) so RLS-3 probes non-empty policy relations.
  sql(`
    insert into public.licenses (id, attorney_id, jurisdiction_id, license_number) values
      ('${U(601)}', '${PROFILE_A}', '${J_A}', 'SYN-A-1'),
      ('${U(602)}', '${PROFILE_B}', '${J_B}', 'SYN-B-1');
    insert into public.verification_evidence (id, jurisdiction_id, source_type, source_reference, retrieved_at, retrieved_by_user_id, evidence_summary, verification_method, discrepancy_flag)
      values ('${U(701)}', '${J_A}', 'synthetic register', 'synthetic entry', now() - interval '1 hour', '${USER.staffA}', 'synthetic', 'synthetic lookup', false),
             ('${U(702)}', '${J_B}', 'synthetic register', 'synthetic entry', now() - interval '1 hour', '${USER.staffGlobal}', 'synthetic', 'synthetic lookup', false);
    insert into public.verification_evidence_subjects (verification_evidence_id, license_id) values ('${U(701)}', '${U(601)}'), ('${U(702)}', '${U(602)}');
    ${policySeedSql(U(802), J_B, "synthetic-draft-b", {}, { activate: false, verified: false })}
  `);

  check(
    "RLS-1 an attorney reads its own profile and claims only, and no evidence or evaluation",
    () => {
      const a = AUTH.attorneyA;
      assert.equal(COUNT(a, "attorney_profiles"), 1);
      assert.equal(COUNT(a, "licenses"), 1);
      assert.equal(COUNT(a, "licenses", `attorney_id = '${PROFILE_B}'`), 0);
      assert.equal(COUNT(a, "verification_evidence"), 0);
      assert.equal(COUNT(a, "verification_evidence_subjects"), 0);
      assert.equal(COUNT(a, "eligibility_evaluations"), 0);
      assert.equal(COUNT(a, "users"), 1);
      assert.equal(COUNT(a, "staff_profiles"), 0);
      return { own_licenses: 1, other_licenses: 0 };
    },
  );

  check(
    "RLS-2 the scope predicate and reads for global, jurisdiction-scoped, expired, revoked, resource-scoped, future, and absent grants; (MVP-001 S2) a global grant holder in an aal1 or claim-less session fails it and reads nothing, while own-row attorney reads need no step-up",
    () => {
      const table = {};
      for (const key of [
        "staffGlobal",
        "staffA",
        "staffExpired",
        "staffRevoked",
        "staffResource",
        "staffFuture",
        "staffNoGrant",
        "client",
        "attorneyA",
      ]) {
        table[key] = [
          SCOPE(AUTH[key], null),
          SCOPE(AUTH[key], J_A),
          SCOPE(AUTH[key], J_B),
          COUNT(AUTH[key], "licenses"),
          COUNT(AUTH[key], "verification_evidence"),
          COUNT(AUTH[key], "attorney_profiles"),
        ];
      }
      assert.deepEqual(table.staffGlobal, ["t", "t", "t", 2, 2, 2]);
      assert.deepEqual(table.staffA, ["f", "t", "f", 1, 1, 0]);
      for (const key of [
        "staffExpired",
        "staffRevoked",
        "staffResource",
        "staffFuture",
        "staffNoGrant",
        "client",
      ]) {
        assert.deepEqual(table[key], ["f", "f", "f", 0, 0, 0], key);
      }
      assert.deepEqual(table.attorneyA, ["f", "f", "f", 1, 0, 1]);
      // MVP-001 S2: the same global grant holder in an aal1 session (before
      // MFA step-up) or without claims fails the predicate and reads nothing
      // of other attorneys; the attorney's own reads need no step-up.
      for (const aal of ["aal1", null]) {
        assert.deepEqual(
          [
            SCOPE(AUTH.staffGlobal, null, { aal }),
            SCOPE(AUTH.staffGlobal, J_A, { aal }),
            COUNT(AUTH.staffGlobal, "licenses", "true", { aal }),
            COUNT(AUTH.staffGlobal, "verification_evidence", "true", { aal }),
            COUNT(AUTH.staffGlobal, "attorney_profiles", "true", { aal }),
          ],
          ["f", "f", 0, 0, 0],
          String(aal),
        );
        assert.deepEqual(
          [
            COUNT(AUTH.attorneyA, "licenses", "true", { aal }),
            COUNT(AUTH.attorneyA, "attorney_profiles", "true", { aal }),
          ],
          [1, 1],
          String(aal),
        );
      }
      // Anonymous callers and the anon role get nothing.
      assert.equal(SCOPE(null, J_A), "f");
      assert.equal(
        sqlstateOf(as("anon", null, "select count(*) from public.licenses;")),
        "42501",
      );
      assert.equal(
        sqlstateOf(
          as(
            "anon",
            null,
            `select public.has_manage_attorney_verification_scope('${J_A}', false);`,
          ),
        ),
        "42501",
      );
      return table;
    },
  );

  check(
    "RLS-3 ordinary sessions cannot write professional, evidence, evaluation, grant, policy, jurisdiction, or audit rows; capability grants, policy, and jurisdictions are invisible to them (MVP-001 S1: SELECT is granted under staff-capability row policies, so the read answers zero rows instead of 42501)",
    () => {
      const writes = [
        `insert into public.licenses (attorney_id, jurisdiction_id, license_number) values ('${PROFILE_A}', '${J_A}', 'SYN-SELF');`,
        `update public.licenses set reported_status = 'verified' where id = '${U(601)}';`,
        `update public.attorney_profiles set profile_state = 'approved' where id = '${PROFILE_A}';`,
        `insert into public.verification_evidence (retrieved_at) values (now());`,
        `insert into public.eligibility_evaluations (attorney_id, jurisdiction_id, context_type, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${PROFILE_A}', '${J_A}', 'jurisdiction', now(), '[]', 'eligible', '[]', '{}', now());`,
        `insert into public.audit_events (actor_type, action_code, resource_type, occurred_at) values ('attorney', 'x', 'y', now());`,
        // MVP-001 S1: the relations that became readable under staff row
        // policies stay closed to every write by an API session.
        `insert into public.capability_grants (user_id, capability_code, granted_by_user_id) values ('${USER.staffGlobal}', 'manage_attorney_verification', '${USER.staffGlobal}');`,
        `update public.capability_grants set revoked_at = now();`,
        `delete from public.capability_grants;`,
        `insert into public.policy_versions (policy_type_code, jurisdiction_id, version_label, parameters) values ('eligibility', '${J_A}', 'synthetic-self', '{}');`,
        `update public.policy_versions set status = 'internal_review';`,
        `delete from public.policy_versions;`,
        `insert into public.jurisdictions (code, name, region_type) values ('SYN_SELF', 'Synthetic', 'synthetic');`,
        `update public.jurisdictions set lifecycle_state = 'live';`,
        `delete from public.jurisdictions;`,
      ];
      for (const subject of [AUTH.attorneyA, AUTH.staffGlobal]) {
        for (const statement of writes) {
          assert.equal(
            sqlstateOf(as("authenticated", subject, statement)),
            "42501",
            statement,
          );
        }
      }
      // Rows exist in every probed relation, and neither an attorney nor a
      // verification reviewer (no configuration capability) sees any of them.
      const hidden = [
        "capability_grants",
        "policy_versions",
        "policy_authority_references",
        "policy_types",
        "jurisdictions",
        "capability_definitions",
      ];
      const visible = {};
      for (const table of hidden) {
        assert.ok(
          Number(sql(`select count(*) from public.${table};`)) > 0,
          `${table} has rows`,
        );
        for (const subject of [AUTH.attorneyA, AUTH.staffGlobal]) {
          assert.equal(COUNT(subject, table), 0, `${table} ${subject}`);
        }
        visible[table] = 0;
      }
      return {
        api_writes: "42501",
        rows_visible_to_ordinary_sessions: visible,
      };
    },
  );

  check(
    "CON-1 constraints: one subject per evidence link, unique license numbers, valid dates and lifecycle states, staff-only grants, unique practice-area requests",
    () => {
      const service = (statement) =>
        sqlstateOf(as("service_role", null, statement));
      // P3-904 removed the service role's DML on these relations, so the
      // table constraints themselves are probed as the table owner, in a
      // transaction that is always rolled back.
      const owner = (statement) =>
        sqlstateOf(psql(["begin;", statement, "rollback;", ""].join("\n")));
      // Two subjects, or none, violate the one-subject check; a repeated link
      // violates the per-subject unique index.
      assert.equal(
        owner(
          `insert into public.verification_evidence_subjects (verification_evidence_id, license_id, insurance_record_id) values ('${U(702)}', '${U(601)}', '${U(601)}');`,
        ),
        "23514",
      );
      assert.equal(
        owner(
          `insert into public.verification_evidence_subjects (verification_evidence_id) values ('${U(702)}');`,
        ),
        "23514",
      );
      assert.equal(
        owner(
          `insert into public.verification_evidence_subjects (verification_evidence_id, license_id) values ('${U(701)}', '${U(601)}');`,
        ),
        "23505",
      );
      assert.equal(
        owner(
          `insert into public.licenses (attorney_id, jurisdiction_id, license_number) values ('${PROFILE_B}', '${J_A}', 'SYN-A-1');`,
        ),
        "23505",
      );
      assert.equal(
        owner(
          `insert into public.licenses (attorney_id, jurisdiction_id, license_number, effective_from, effective_until) values ('${PROFILE_A}', '${J_B}', 'SYN-D', '2026-02-01', '2026-01-01');`,
        ),
        "23514",
      );
      assert.equal(
        owner(
          `update public.attorney_profiles set profile_state = 'verified' where id = '${PROFILE_A}';`,
        ),
        "23514",
      );
      assert.equal(
        owner(
          `insert into public.capability_grants (user_id, capability_code, granted_by_user_id) values ('${USER.client}', 'manage_attorney_verification', '${USER.grantor}');`,
        ),
        "23503",
      );
      assert.equal(
        owner(
          `insert into public.practice_area_authorisations (attorney_id, jurisdiction_id, practice_area_id, status, requested_at) values ('${PROFILE_A}', '${J_A}', '${AREA}', 'requested', now()), ('${PROFILE_A}', '${J_A}', '${AREA}', 'requested', now());`,
        ),
        "23505",
      );
      assert.equal(
        owner(
          `insert into public.practice_area_authorisations (attorney_id, jurisdiction_id, practice_area_id, status, requested_at) values ('${PROFILE_A}', '${J_A}', '${AREA}', '', now());`,
        ),
        "23514",
      );
      // Evidence, evaluations, and audit rows are append-only for the service role.
      assert.equal(
        service(
          `update public.verification_evidence set discrepancy_flag = true where id = '${U(701)}';`,
        ),
        "42501",
      );
      assert.equal(
        service(
          `delete from public.verification_evidence where id = '${U(701)}';`,
        ),
        "42501",
      );
      assert.equal(
        service(`delete from public.licenses where id = '${U(601)}';`),
        "42501",
      );
    },
  );

  check(
    "APP-1 guarded claim and review writes behave as the ports require, now through the P3-904 write functions: an exact updated_at applies once, stale or wrong-stage writes change nothing, and the retired service-role writes are refused",
    () => {
      const license = U(612);
      sql(
        `insert into public.licenses (id, attorney_id, jurisdiction_id, license_number) values ('${license}', '${PROFILE_A}', '${J_B}', 'SYN-APP-1');`,
      );
      const stampOf = () =>
        sql(
          `select to_json(updated_at)#>>'{}' from public.licenses where id = '${license}';`,
        );
      const first = stampOf();
      const revise = (stamp) =>
        callAs(AUTH.attorneyA, "attorney_save_license_claim", {
          p_license_id: license,
          p_expected_updated_at: stamp,
          p_jurisdiction_id: J_B,
          p_license_number: "SYN-APP-1",
          p_license_type: "synthetic",
          p_effective_from: null,
          p_effective_until: null,
        });
      assert.equal(revise(first), "applied");
      assert.equal(revise(first), "conflict");
      const transition = (intent) =>
        callAs(AUTH.staffGlobal, "staff_change_profile_stage", {
          p_attorney_id: PROFILE_B,
          p_intent: intent,
          p_message: null,
          p_note: null,
        });
      assert.equal(transition("approve"), "applied");
      assert.equal(transition("approve"), "locked");
      assert.equal(transition("suspend"), "applied");
      assert.equal(
        sql(
          `select profile_state from public.attorney_profiles where id = '${PROFILE_B}';`,
        ),
        "suspended",
      );
      // The retired privileged writes are refused outright.
      assert.equal(
        sqlstateOf(
          as(
            "service_role",
            null,
            `update public.licenses set license_type = 'x' where id = '${license}';`,
          ),
        ),
        "42501",
      );
      assert.equal(
        sqlstateOf(
          as(
            "service_role",
            null,
            `update public.attorney_profiles set profile_state = 'approved' where id = '${PROFILE_B}';`,
          ),
        ),
        "42501",
      );
      return {
        license_first: "applied",
        license_stale: "conflict",
        transitions: ["applied", "locked", "applied"],
        service_role_direct_writes: "42501",
      };
    },
  );

  check(
    "APP-2 rows serialized by the database are accepted by the application's strict readers",
    () => {
      const readers = [
        [PROFILE_COLUMNS, "public.attorney_profiles", readProfile],
        [LICENSE_COLUMNS, "public.licenses", readLicense],
        [EVIDENCE_COLUMNS, "public.verification_evidence", readEvidence],
        [
          EVIDENCE_SUBJECT_COLUMNS,
          "public.verification_evidence_subjects",
          readEvidenceSubject,
        ],
      ];
      const counts = {};
      for (const [columns, table, reader] of readers) {
        const rows = jsonRows(columns, table);
        assert.ok(rows.length > 0, table);
        for (const row of rows) {
          assert.notEqual(
            reader(row),
            null,
            `${table}: ${JSON.stringify(row)}`,
          );
        }
        counts[table] = rows.length;
      }
      return counts;
    },
  );

  check(
    "APP-3 policy selection, assessment, and immutable T1 -> adverse fact -> T2 evaluations on real rows",
    () => {
      // Synthetic test-only policy with verified synthetic provenance; the
      // provenance trigger itself requires the verified reference.
      const parameters = {
        schema: "rosuno.attorney_eligibility.v1",
        license: {
          qualifying_reported_statuses: ["synthetic-active"],
          evidence_max_age_days: 30,
        },
        insurance: {
          required: true,
          evidence_max_age_days: 30,
          minimum_per_occurrence_minor: 100000,
          minimum_aggregate_minor: null,
          currency_code: "XTS",
        },
        discipline: {
          disqualifying_statuses: ["synthetic-revoked"],
          cleared_statuses: [],
        },
        practice_area: { authorisation_required: true },
      };
      // MVP-001 S1: the 'eligibility' type is seeded by the S1 migration
      // (SCH-4); the version is created as a draft by the table owner and
      // walked through the lifecycle (policySeedSql).
      sql(`
      ${policySeedSql(U(801), J_A, "synthetic-v1", parameters)}
      update public.attorney_profiles set profile_state = 'approved' where id = '${PROFILE_A}';
      update public.licenses set reported_status = 'synthetic-active' where id = '${U(601)}';
      insert into public.insurance_records (id, attorney_id, jurisdiction_id, carrier_name, per_occurrence_limit_minor, currency_code, coverage_from, coverage_until)
        values ('${U(901)}', '${PROFILE_A}', '${J_A}', 'Synthetic carrier', 250000, 'XTS', current_date - 30, current_date + 30);
      insert into public.verification_evidence (id, jurisdiction_id, source_type, source_reference, retrieved_at, retrieved_by_user_id, evidence_summary, verification_method, discrepancy_flag)
        values ('${U(703)}', '${J_A}', 'synthetic insurer', 'synthetic certificate', now() - interval '1 hour', '${USER.staffA}', 'synthetic', 'synthetic document', false);
      insert into public.verification_evidence_subjects (verification_evidence_id, insurance_record_id) values ('${U(703)}', '${U(901)}');
    `);
      // A draft policy is never applied: the trigger refuses an active
      // version without verified provenance. MVP-001 S1: the service role can
      // no longer write policy versions at all (42501); as the table owner a
      // version can only be created as a draft (23514), and walking an
      // unverified draft to approval is still refused by the provenance
      // trigger (23514). Both owner attempts are rolled back.
      const activeInsert = `insert into public.policy_versions (policy_type_code, jurisdiction_id, version_label, parameters, status, approved_at, approved_by_user_id, effective_from) values ('eligibility', '${J_B}', 'synthetic-unverified', '{}'::jsonb, 'active', now(), '${USER.grantor}', now());`;
      const unverified = as("service_role", null, activeInsert);
      assert.equal(sqlstateOf(unverified), "42501");
      const ownerActive = psql(
        ["begin;", activeInsert, "rollback;", ""].join("\n"),
      );
      assert.equal(sqlstateOf(ownerActive), "23514");
      assert.match(
        ownerActive.stderr,
        /a policy version is created as a draft/,
      );
      const ownerApproval = psql(
        [
          "begin;",
          policySeedSql(
            U(803),
            J_B,
            "synthetic-unverified",
            {},
            { verified: false },
          ),
          "rollback;",
          "",
        ].join("\n"),
      );
      assert.equal(sqlstateOf(ownerApproval), "23514");
      assert.match(
        ownerApproval.stderr,
        /approved policy version requires verified authority provenance/,
      );
      assert.equal(
        sql(
          `select count(*) from public.policy_versions where version_label = 'synthetic-unverified';`,
        ),
        "0",
      );
      // The database's own selection agrees now the environment is recorded.
      assert.equal(
        JSON.parse(
          sql(
            `select public.eligibility_selected_policy('${J_A}', now())::text;`,
          ),
        ).policy_version_id,
        U(801),
      );
      const nowMs = Number(
        sql("select (extract(epoch from now()) * 1000)::bigint;"),
      );
      const facts = () => ({
        attorneyId: PROFILE_A,
        jurisdictionId: J_A,
        practiceAreaId: null,
        accountState: sql(
          `select account_state from public.users where id = '${USER.attorneyA}';`,
        ),
        profile: jsonRows(
          PROFILE_COLUMNS,
          `public.attorney_profiles where id = '${PROFILE_A}'`,
        )[0],
        licenses: jsonRows(
          LICENSE_COLUMNS,
          `public.licenses where attorney_id = '${PROFILE_A}' and jurisdiction_id = '${J_A}'`,
        ),
        insurance: jsonRows(
          INSURANCE_COLUMNS,
          `public.insurance_records where attorney_id = '${PROFILE_A}' and jurisdiction_id = '${J_A}'`,
        ),
        discipline: jsonRows(
          DISCIPLINE_COLUMNS,
          `public.discipline_records where attorney_id = '${PROFILE_A}' and jurisdiction_id = '${J_A}'`,
        ),
        authorisations: jsonRows(
          PRACTICE_AUTHORISATION_COLUMNS,
          `public.practice_area_authorisations where attorney_id = '${PROFILE_A}' and jurisdiction_id = '${J_A}'`,
        ),
        evidence: jsonRows(
          EVIDENCE_COLUMNS,
          `public.verification_evidence where id in ('${U(701)}', '${U(703)}')`,
        ),
        subjects: jsonRows(
          EVIDENCE_SUBJECT_COLUMNS,
          `public.verification_evidence_subjects where license_id = '${U(601)}' or insurance_record_id = '${U(901)}'`,
        ),
        policyVersions: jsonRows(
          POLICY_VERSION_COLUMNS,
          `public.policy_versions where policy_type_code = 'eligibility' and jurisdiction_id = '${J_A}'`,
        ),
        authorityReferences: jsonRows(
          AUTHORITY_REFERENCE_COLUMNS,
          `public.policy_authority_references where policy_version_id = '${U(801)}'`,
        ),
        // MVP-001 S1 (PS-A2): the recorded environment class.
        environment: "development",
      });
      const t1Facts = facts();
      assert.equal(
        selectEligibilityPolicy(
          J_A,
          nowMs,
          t1Facts.policyVersions,
          t1Facts.authorityReferences,
          "development",
        ).status,
        "selected",
      );
      // The same rows select nothing for an unrecorded or misbound
      // environment (PS-A2).
      assert.equal(
        selectEligibilityPolicy(
          J_A,
          nowMs,
          t1Facts.policyVersions,
          t1Facts.authorityReferences,
          "unrecorded",
        ).reason,
        "environment_unrecorded",
      );
      assert.equal(
        selectEligibilityPolicy(
          J_A,
          nowMs,
          t1Facts.policyVersions,
          t1Facts.authorityReferences,
          "mismatch",
        ).reason,
        "environment_mismatch",
      );
      for (const row of t1Facts.insurance) {
        assert.notEqual(readInsurance(row), null);
      }
      const t1 = assessEligibility(t1Facts, nowMs);
      assert.equal(t1.result, "eligible", JSON.stringify(t1.factors));
      // Persisted through the P3-904 staff write function as the
      // jurisdiction-scoped reviewer, never by the service role.
      // MVP-001 S1 (SCH-1): a caller-chosen evaluation id is refused with
      // nothing written; with a NULL id the database generates the key, and
      // the one new row is found by diffing the attorney's evaluation ids.
      const insertEvaluation = (assessment) => {
        const row = evaluationRowOf(assessment, nowMs);
        const args = (id) => ({
          p_evaluation_id: id,
          p_attorney_id: row.attorney_id,
          p_jurisdiction_id: row.jurisdiction_id,
          p_context_type: row.context_type,
          p_context_id: row.context_id,
          p_as_of: row.as_of,
          p_result: row.result,
          p_factor_results: row.factor_results,
          p_policy_references: row.policy_references,
          p_evidence_references: row.evidence_references,
        });
        const idsBefore = new Set(
          jsonRows(
            "id",
            `public.eligibility_evaluations where attorney_id = '${PROFILE_A}'`,
          ).map((r) => r.id),
        );
        const auditBefore = sql("select count(*) from public.audit_events;");
        const callerId = randomUUID();
        assert.equal(
          callAs(
            AUTH.staffA,
            "staff_record_eligibility_evaluation",
            args(callerId),
          ),
          "invalid",
        );
        assert.equal(
          sql(
            `select count(*) from public.eligibility_evaluations where id = '${callerId}';`,
          ),
          "0",
        );
        assert.equal(
          sql("select count(*) from public.audit_events;"),
          auditBefore,
        );
        assert.equal(
          callAs(
            AUTH.staffA,
            "staff_record_eligibility_evaluation",
            args(null),
          ),
          "applied",
        );
        const created = jsonRows(
          "id",
          `public.eligibility_evaluations where attorney_id = '${PROFILE_A}'`,
        )
          .map((r) => r.id)
          .filter((id) => !idsBefore.has(id));
        assert.equal(created.length, 1);
        assert.equal(
          sql(
            `select count(*) || '|' || min(actor_user_id::text) from public.audit_events where resource_id = '${created[0]}' and action_code = 'eligibility_evaluation_recorded';`,
          ),
          `1|${USER.staffA}`,
        );
        return created[0];
      };
      const t1Id = insertEvaluation(t1);
      const t1Before = jsonRows(
        EVALUATION_COLUMNS,
        `public.eligibility_evaluations where id = '${t1Id}'`,
      )[0];
      assert.notEqual(readEvaluation(t1Before), null);
      // The jurisdiction-scoped reviewer can read it; the attorney cannot.
      assert.equal(
        COUNT(AUTH.staffA, "eligibility_evaluations", `id = '${t1Id}'`),
        1,
      );
      assert.equal(COUNT(AUTH.attorneyA, "eligibility_evaluations"), 0);
      assert.equal(COUNT(AUTH.staffExpired, "eligibility_evaluations"), 0);
      // An adverse discipline record arrives; T2 is not eligible.
      sql(
        `insert into public.discipline_records (attorney_id, jurisdiction_id, external_reference, status) values ('${PROFILE_A}', '${J_A}', 'SYN-ADVERSE', 'synthetic-revoked');`,
      );
      const t2 = assessEligibility(facts(), nowMs);
      assert.equal(t2.result, "not_eligible");
      const t2Id = insertEvaluation(t2);
      assert.notEqual(t2Id, t1Id);
      const t1After = jsonRows(
        EVALUATION_COLUMNS,
        `public.eligibility_evaluations where id = '${t1Id}'`,
      )[0];
      assert.deepEqual(t1After, t1Before);
      assert.equal(
        sqlstateOf(
          as(
            "service_role",
            null,
            `update public.eligibility_evaluations set result = 'eligible' where id = '${t2Id}';`,
          ),
        ),
        "42501",
      );
      assert.equal(
        sqlstateOf(
          as(
            "service_role",
            null,
            `delete from public.eligibility_evaluations where id = '${t1Id}';`,
          ),
        ),
        "42501",
      );
      // A practice-area authorisation decision round-trips through the reader.
      sql(
        `insert into public.practice_area_authorisations (attorney_id, jurisdiction_id, practice_area_id, status, requested_at, decided_at, effective_from) values ('${PROFILE_A}', '${J_A}', '${AREA}', 'authorised', now() - interval '2 hours', now() - interval '1 hour', now() - interval '1 hour');`,
      );
      const paa = jsonRows(
        PRACTICE_AUTHORISATION_COLUMNS,
        `public.practice_area_authorisations where attorney_id = '${PROFILE_A}'`,
      );
      assert.notEqual(readPracticeAuthorisation(paa[0]), null);
      const withArea = assessEligibility(
        { ...facts(), practiceAreaId: AREA },
        nowMs,
      );
      assert.equal(
        withArea.factors.find((f) => f.factor === "practice_area").outcome,
        "pass",
      );
      return { t1: t1.result, t2: t2.result, t1_unchanged: true };
    },
  );

  check(
    "AUD-1 audit rows of the audit_events shape still insert as the service role (its grant is unchanged by P3-904) and are immutable",
    () => {
      const event = syntheticAuditRow({
        actor: USER.staffA,
        actorType: "staff",
        action: "verification_evidence_recorded",
        resourceType: "verification_evidence",
        resourceId: U(701),
        after: { subject_kind: "license", discrepancy: false },
        jurisdictionId: J_A,
      });
      const id = sql(
        `set role service_role; insert into public.audit_events select * from jsonb_populate_record(null::public.audit_events, $a$${JSON.stringify(event)}$a$::jsonb || jsonb_build_object('id', gen_random_uuid(), 'created_at', now())) returning id;`,
      );
      assert.match(id, /^[0-9a-f-]{36}$/);
      // The service role has no update or delete privilege at all, and even the
      // table owner is stopped by the append-only trigger.
      assert.equal(
        sqlstateOf(
          as(
            "service_role",
            null,
            `update public.audit_events set action_code = 'changed' where id = '${id}';`,
          ),
        ),
        "42501",
      );
      assert.equal(
        sqlstateOf(
          as(
            "service_role",
            null,
            `delete from public.audit_events where id = '${id}';`,
          ),
        ),
        "42501",
      );
      assert.equal(
        sqlstateOf(
          psql(
            `begin; update public.audit_events set action_code = 'changed' where id = '${id}'; rollback;`,
          ),
        ),
        "23514",
      );
      assert.equal(
        sqlstateOf(
          as(
            "authenticated",
            AUTH.staffGlobal,
            "select count(*) from public.audit_events;",
          ),
        ),
        "42501",
      );
    },
  );

  check(
    "SEC-1 (corrected by P3-904) the only write path to the M4 relations is the operation-specific definer functions executable by authenticated: no write policies, no API-role DML grant on any M4 relation, and the service role's row-security bypass grants no write",
    () => {
      const definers = sql(
        "select coalesce(string_agg(p.proname || ':' || p.provolatile::text, ',' order by p.proname), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef;",
      );
      assert.equal(
        definers,
        [
          // MVP-001 S3 part 2 re-pin (20261119050000): the AI suggestion
          // recording function (service_role only), which writes only
          // ai_suggestions and audit events; no M4 relation.
          "ai_record_intake_suggestion:v",
          "attorney_change_practice_area_request:v",
          // MVP-001 S6 PS-A3 re-pin (20261122040000): the attorney's own offer
          // options and offer list reads (authenticated, aal2), which write
          // nothing.
          "attorney_consultation_offer_options:s",
          "attorney_consultation_offers:s",
          // MVP-001 S4 re-pin (20261120020000): the attorney's own schedule
          // functions (authenticated, aal2), which write only availability
          // rules, Blackouts, application sessions, Instant intents and
          // audit events; no M4 relation.
          "attorney_create_availability_rule:v",
          "attorney_create_blackout:v",
          "attorney_deactivate_availability_rule:v",
          "attorney_instant_status:s",
          // MVP-001 S7 re-pin (20261123020000): the attorney's own ledger-derived
          // earnings read (authenticated, aal2), which writes nothing.
          "attorney_payment_earnings:s",
          "attorney_remove_blackout:v",
          "attorney_request_practice_area:v",
          "attorney_save_insurance_claim:v",
          "attorney_save_license_claim:v",
          "attorney_save_profile_details:v",
          // MVP-001 S4 re-pin (20261120020000): read and switch, as above.
          "attorney_schedule_calendar:s",
          // MVP-001 S6 PS-A3 re-pin (20261122040000): the attorney's offer
          // price function (authenticated, aal2), which writes only
          // attorney_consultation_offers and audit events; no M4 relation.
          "attorney_set_consultation_offer:v",
          "attorney_set_instant_intent:v",
          "attorney_start_application:v",
          "attorney_submit_application:v",
          // MVP-001 S6 PS-A3 re-pin (20261122040000): the attorney's offer
          // withdrawal (authenticated, aal2), which writes only the offer's
          // withdrawal and an audit event; no M4 relation.
          "attorney_withdraw_consultation_offer:v",
          // MVP-001 S2 re-pin (20261118040000, PS-A4): the authentication-
          // abuse decision functions (service_role only), which write only
          // their own counters and security audit events, no M4 relation.
          "authentication_abuse_record_failure:v",
          "authentication_abuse_record_success:v",
          "authentication_abuse_report_unavailable:v",
          "authentication_abuse_reserve:v",
          // MVP-001 S1 re-pin (20261117030000): the staff read predicates for
          // the configuration row policies, which write nothing.
          "capability_admin_may_read_user:s",
          // MVP-001 S7 re-pin (20261123020000): the client's payment
          // authorization (authenticated only), which writes only the payment
          // attempt, an operational job and audit events; no M4 relation.
          "client_authorize_payment:v",
          // P5-001 re-pin: the client intake and configuration-publication
          // functions, which write no M4 relation.
          "client_close_intake:v",
          // MVP-001 S3 part 2 re-pin (20261119050000): the client's AI
          // suggestion decision, which writes only ai_suggestions,
          // unreviewed jurisdiction assessments and audit events.
          "client_confirm_ai_suggestion:v",
          "client_create_intake:v",
          "client_intake_jurisdictions:s",
          "client_intake_practice_areas:s",
          // MVP-001 S6 re-pin (20261122030000): the client's own Intake
          // attempts with their Requests (authenticated only), which write
          // nothing.
          "client_intake_requests:s",
          // MVP-001 S7 re-pin (20261123020000): the client's own checkout link
          // and receipt reads (authenticated only), which write nothing.
          "client_payment_checkout:s",
          "client_payment_receipt:s",
          // MVP-001 S5 re-pin (20261121030000): the client's own attempt
          // list (authenticated only), which writes nothing.
          "client_referrals:s",
          // MVP-001 S3 part 2 re-pin (20261119050000, 20261119040000): the
          // rejection, and the post-submission change seam, which writes
          // nothing but an expiry transition; no M4 relation.
          "client_reject_ai_suggestion:v",
          // MVP-001 S6 re-pin (20261122030000): the client's own Request
          // (authenticated only), which writes nothing.
          "client_request:s",
          "client_request_intake_change:v",
          // MVP-001 S7 re-pin (20261123020000): the client's own payment step
          // read (authenticated only), which writes nothing.
          "client_request_payment:s",
          // MVP-001 S6 re-pin (20261122020000): the client's request review
          // read (authenticated only), which writes nothing.
          "client_request_review:s",
          "client_save_intake_revision:v",
          "client_submit_intake:v",
          // MVP-001 S1 re-pin (20261117010000): the environment identity
          // accessors and the environment-anchored policy resolver.
          "deployment_environment_identity:s",
          // MVP-001 S6 re-pin (20261122010000): the two P1 deferred
          // Request/payment and Request/Hold consistency checks, now security
          // definer (trigger functions, executable by no API role), which
          // only read.
          "enforce_payment_request_consistency:v",
          "enforce_request_hold_consistency:v",
          // MVP-001 S6 re-pin (20261122010000): the deferred Fee Calculation
          // evidence check (a trigger function, executable by no API role),
          // which only reads.
          "fee_calculation_with_request:v",
          "has_manage_attorney_verification_scope:s",
          "has_resource_metadata_access:s",
          // MVP-001 S1 re-pin (20261117030000).
          "has_staff_capability:s",
          // MVP-001 S2 re-pin (20261118010000): the worker functions
          // (service_role only), which write no M4 relation.
          "job_claim:v",
          "job_complete:v",
          "job_fail:v",
          // MVP-001 S7 re-pin (20261123020000): the payment worker and webhook
          // recording functions (service_role only) and the two payment
          // trigger functions (executable by no API role), which write only
          // payment attempts, ledger entries, reconciliation exceptions,
          // event receipts, Request states, operational jobs and audit
          // events; no M4 relation.
          "payment_job_context:s",
          "payment_job_escalated:v",
          "payment_record_operation:v",
          "payment_record_provider_event:v",
          "payment_request_terminated:v",
          // MVP-001 S1 re-pin (20261117010000, 20261117030000): read-only
          // definers executable by no API role.
          "policy_select_version:s",
          "production_financial_gate:s",
          // MVP-001 S5 re-pin (20261121020000): the three public discovery
          // reads (anon and authenticated), stable, which write nothing.
          "public_attorney_directory:s",
          // MVP-001 S6 PS-A3 re-pin (20261122040000): the public offer read
          // (anon and authenticated), stable, which writes nothing.
          "public_attorney_offers:s",
          "public_attorney_profile:s",
          "public_discovery_filters:s",
          // MVP-001 S5 re-pin (20261121030000): the client's selection
          // (authenticated only), which writes Referral evidence, audit
          // events and, of the M4 relations, only appends decision-point
          // eligibility_evaluations rows (append-only for every role since
          // 20261121010000).
          "referral_create:v",
          // MVP-001 S5 re-pin (20261121010000): the two deferred referral
          // evidence checks (trigger functions, executable by no API role),
          // which only read.
          "referral_evidence_with_referral:v",
          "referral_point_in_time_evidence:v",
          // MVP-001 S6 re-pin (20261122030000): the client's Request creation
          // (authenticated only), which writes the Request, its evidence, Fee
          // Calculation, Hold and audit event and, of the M4 relations, only
          // appends decision-point eligibility_evaluations rows (append-only
          // for every role since 20261121010000). MVP-001 S7 re-pin
          // (20261123020000): replaced under its own name (the payment flow
          // policy joins its evidence); the same writes.
          "request_create:v",
          // MVP-001 S6 re-pin (20261122020000): the request options read
          // (authenticated only), which writes nothing.
          "request_options:s",
          // MVP-001 S6 re-pin (20261122010000): the deferred request evidence
          // check (a trigger function, executable by no API role), which only
          // reads.
          "request_point_in_time_evidence:v",
          // MVP-001 S6 re-pin (20261122020000): the quote preview and slot
          // start reads (authenticated only), which write nothing.
          "request_quote_preview:s",
          "request_slot_starts:s",
          // MVP-001 S6 re-pin (20261122030000): the client's withdrawal
          // (authenticated only), which writes the Request's state, its Hold's
          // end and an audit event; no M4 relation.
          "request_withdraw:v",
          // MVP-001 S3 re-pin (20261119010000-030000): the protected resource
          // functions (authenticated only), which write only resources, voice
          // memos and audit events; no M4 relation (an evidence row refers to
          // an artifact only through the M4 finding functions).
          "resource_abandon_upload:v",
          "resource_authorize_access:v",
          "resource_begin_verification_artifact:v",
          "resource_begin_voice_memo:v",
          "resource_finalize_upload:v",
          "rosuno_environment_class:s",
          "rosuno_environment_status:s",
          // MVP-001 S4 re-pin (20261120020000): the application session
          // observation and sign-out, which write only application
          // sessions, Instant intents and audit events; no M4 relation.
          "scheduling_end_session:v",
          "scheduling_touch_session:v",
          // MVP-001 S1 re-pin (20261117030000): the configuration
          // administration functions, which write no M4 relation.
          "staff_add_policy_authority_reference:v",
          // MVP-001 S7 re-pin (20261123020000): the finance workspace functions
          // (authenticated, aal2, manage_financial_operations): the reads
          // write nothing; the refund, reconciliation and exception functions
          // write only payment attempts, reconciliation exceptions,
          // operational jobs and audit events; no M4 relation.
          "staff_assign_reconciliation_exception:v",
          // MVP-001 S2 re-pin (20261118010000): the staff job functions,
          // which write no M4 relation.
          "staff_cancel_job:v",
          "staff_change_jurisdiction_lifecycle:v",
          "staff_change_profile_stage:v",
          "staff_create_jurisdiction:v",
          "staff_create_policy_version:v",
          "staff_create_practice_area:v",
          "staff_create_service_area:v",
          "staff_decide_policy_authority_reference:v",
          "staff_decide_practice_area:v",
          "staff_define_launch_gate:v",
          "staff_end_policy_version:v",
          // MVP-001 S7 re-pin (20261123020000): finance reads, as above.
          "staff_finance_exceptions:s",
          "staff_finance_ledger:s",
          "staff_finance_payment:s",
          "staff_finance_payments:s",
          "staff_finance_receipts:s",
          "staff_grant_capability:v",
          "staff_grant_launch_authorization:v",
          // MVP-001 S3 part 2 re-pin (20261119060000): the jurisdiction
          // assessment review reads, which write nothing.
          "staff_jurisdiction_review_assessments:s",
          "staff_jurisdiction_review_intakes:s",
          "staff_publish_intake_question_set:v",
          "staff_record_discipline_finding:v",
          "staff_record_eligibility_evaluation:v",
          "staff_record_launch_gate_evaluation:v",
          "staff_record_source_unavailable:v",
          "staff_record_verification_finding:v",
          // MVP-001 S7 re-pin (20261123020000): finance writes, as above.
          "staff_request_reconciliation:v",
          "staff_request_refund:v",
          "staff_resolve_reconciliation_exception:v",
          "staff_retry_job:v",
          // MVP-001 S3 part 2 re-pin (20261119060000): the review, which
          // writes only a jurisdiction assessment's review and its audit
          // event; no M4 relation.
          "staff_review_jurisdiction_assessment:v",
          "staff_revise_policy_draft:v",
          "staff_revoke_capability:v",
          "staff_revoke_launch_authorization:v",
          "staff_set_practice_area_active:v",
          "staff_transition_policy_version:v",
        ].join(","),
      );
      assert.equal(
        sql(
          "select count(*) from pg_policies where schemaname = 'public' and cmd <> 'SELECT';",
        ),
        "0",
      );
      const m4 =
        "'attorney_profiles','licenses','insurance_records','discipline_records','practice_area_authorisations','verification_evidence','verification_evidence_subjects','eligibility_evaluations'";
      assert.equal(
        sql(
          `select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name in (${m4}) and grantee in ('authenticated', 'anon', 'service_role', 'PUBLIC') and privilege_type <> 'SELECT';`,
        ),
        "0",
      );
      assert.equal(
        sql(
          `select count(*) from information_schema.column_privileges where table_schema = 'public' and table_name in (${m4}) and grantee in ('authenticated', 'anon', 'service_role', 'PUBLIC') and privilege_type <> 'SELECT';`,
        ),
        "0",
      );
      assert.equal(
        sql(
          `select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'audit_events' and grantee in ('authenticated', 'anon') and privilege_type <> 'SELECT';`,
        ),
        "0",
      );
      // MVP-001 S3 admits exactly one more trigger on an M4 relation: the
      // check of an evidence row's reference to an uploaded artifact, which
      // only refuses (it writes nothing), on verification_evidence only.
      // MVP-001 S5 admits exactly two more, on eligibility_evaluations: the
      // append-only guard for every role (row update or delete, and
      // truncate), which only refuses. The list is now read in a fixed order.
      assert.equal(
        sql(
          `select coalesce(string_agg(c.relname || ':' || t.tgname, ',' order by c.relname, t.tgname), '') from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname in (${m4}, 'audit_events') and not t.tgisinternal and t.tgname not like '%set_updated_at' and t.tgname <> 'audit_events_immutable';`,
        ),
        "eligibility_evaluations:eligibility_evaluations_append_only,eligibility_evaluations:eligibility_evaluations_no_truncate,verification_evidence:verification_evidence_artifact_guard",
      );
      assert.equal(
        sql(
          "select p.prosecdef::text || '|' || p.provolatile::text from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgname = 'verification_evidence_artifact_guard';",
        ),
        "false|v",
      );
      assert.equal(
        sql(
          "select string_agg(t.tgname || '|' || p.proname || '|' || p.prosecdef::text || '|' || t.tgtype::text, ',' order by t.tgname) from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgname in ('eligibility_evaluations_append_only', 'eligibility_evaluations_no_truncate');",
        ),
        "eligibility_evaluations_append_only|eligibility_evaluation_append_only|false|27,eligibility_evaluations_no_truncate|eligibility_evaluation_append_only|false|34",
      );
      assert.equal(
        sql(
          "select rolbypassrls from pg_roles where rolname = 'service_role';",
        ),
        "t",
      );
      return {
        security_definer_functions: definers.split(","),
        write_policies: 0,
        m4_api_role_write_grants: 0,
      };
    },
  );

  check(
    "SEC-2 (corrected by P3-904) the check-to-write window is closed at the database: after a grant is revoked, the reviewer's write function denies and the service role cannot write directly at all",
    () => {
      sql(
        `update public.capability_grants set revoked_at = now() where user_id = '${USER.staffA}';`,
      );
      const predicate = SCOPE(AUTH.staffA, J_A);
      const direct = sqlstateOf(
        as(
          "service_role",
          null,
          `insert into public.verification_evidence (jurisdiction_id, retrieved_at, retrieved_by_user_id, evidence_summary) values ('${J_A}', now(), '${USER.staffA}', 'synthetic after revocation');`,
        ),
      );
      const before = sql("select count(*) from public.verification_evidence;");
      const outcome = callAs(AUTH.staffA, "staff_record_source_unavailable", {
        p_subject_kind: "license",
        p_subject_id: U(601),
        p_note: "synthetic after revocation",
      });
      assert.equal(predicate, "f");
      assert.equal(direct, "42501");
      assert.equal(outcome, "denied");
      assert.equal(
        sql("select count(*) from public.verification_evidence;"),
        before,
      );
      return {
        predicate_after_revocation: predicate,
        service_role_direct_write: direct,
        write_function_after_revocation: outcome,
      };
    },
  );

  check(
    "SEC-3 (corrected by P3-904) the scope predicate requires an active User and an active Staff Profile: a deactivated Staff Profile and a suspended User holding an unrevoked grant fail it and read no evidence or other attorneys' profiles",
    () => {
      sql(
        `update public.staff_profiles set staff_state = 'deactivated' where user_id = '${USER.staffGlobal}';`,
      );
      const deactivated = [
        SCOPE(AUTH.staffGlobal, J_A),
        COUNT(AUTH.staffGlobal, "verification_evidence"),
        COUNT(AUTH.staffGlobal, "attorney_profiles"),
      ];
      sql(
        `update public.staff_profiles set staff_state = 'active' where user_id = '${USER.staffGlobal}';`,
      );
      assert.equal(SCOPE(AUTH.staffGlobal, J_A), "t");
      sql(
        `update public.users set account_state = 'suspended' where id = '${USER.staffGlobal}';`,
      );
      const suspended = [
        SCOPE(AUTH.staffGlobal, J_A),
        COUNT(AUTH.staffGlobal, "verification_evidence"),
        COUNT(AUTH.staffGlobal, "attorney_profiles"),
      ];
      assert.deepEqual(deactivated, ["f", 0, 0]);
      assert.deepEqual(suspended, ["f", 0, 0]);
      return { deactivated_staff: deactivated, suspended_user: suspended };
    },
  );

  check(
    "APP-4 (P3-904; MVP-001 S1 SCH-1) a caller-chosen id is refused with nothing written; a create with a NULL id writes exactly one license with a server-generated key and exactly one audit row naming the attorney; neither a replay of the create (natural-key conflict) nor a create naming the server key writes anything more, and no write-ahead attempt or outcome row exists",
    () => {
      const auth = U(121);
      const user = U(221);
      const profile = U(403);
      sql(`insert into auth.users (id) values ('${auth}');
        insert into public.users (id, auth_user_id, account_state) values ('${user}', '${auth}', 'active');
        insert into public.attorney_profiles (id, user_id, profile_state) values ('${profile}', '${user}', 'applicant');`);
      const callerId = U(611);
      const claim = (id, number) => ({
        p_license_id: id,
        p_expected_updated_at: null,
        p_jurisdiction_id: J_B,
        p_license_number: number,
        p_license_type: null,
        p_effective_from: null,
        p_effective_until: null,
      });
      const ownLicenses = () =>
        jsonRows(
          "id, license_number",
          `public.licenses where attorney_id = '${profile}'`,
        );
      const ownAudit = () =>
        sql(
          `select count(*) from public.audit_events where actor_user_id = '${user}';`,
        );
      // A caller-chosen id on create is refused before anything is written.
      assert.equal(
        callAs(
          auth,
          "attorney_save_license_claim",
          claim(callerId, "SYN-GEN-0"),
        ),
        "invalid",
      );
      assert.equal(
        sql(
          `select count(*) from public.licenses where id = '${callerId}' or license_number = 'SYN-GEN-0';`,
        ),
        "0",
      );
      assert.equal(ownAudit(), "0");
      // The create with a NULL id writes one row with a server key.
      assert.equal(
        callAs(auth, "attorney_save_license_claim", claim(null, "SYN-GEN-1")),
        "applied",
      );
      const created = ownLicenses();
      assert.equal(created.length, 1);
      const licenseId = created[0].id;
      assert.equal(created[0].license_number, "SYN-GEN-1");
      assert.notEqual(licenseId, callerId);
      assert.match(
        licenseId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      // A replay of the same create cannot duplicate the license.
      assert.equal(
        callAs(auth, "attorney_save_license_claim", claim(null, "SYN-GEN-1")),
        "conflict",
      );
      // The server key cannot be written again as a new claim either.
      assert.equal(
        callAs(
          auth,
          "attorney_save_license_claim",
          claim(licenseId, "SYN-GEN-2"),
        ),
        "invalid",
      );
      assert.deepEqual(ownLicenses(), created);
      assert.equal(
        sql(
          `select count(*) from public.licenses where license_number in ('SYN-GEN-1', 'SYN-GEN-2');`,
        ),
        "1",
      );
      assert.equal(
        sql(
          `select count(*) || '|' || min(actor_user_id::text) || '|' || min(actor_type) from public.audit_events where resource_id = '${licenseId}';`,
        ),
        `1|${user}|attorney`,
      );
      assert.equal(ownAudit(), "1");
      assert.equal(
        sql(
          "select count(*) from public.audit_events where action_code = 'audited_change_outcome' or after_snapshot ? 'audit_phase';",
        ),
        "0",
      );
      return {
        caller_id: "invalid",
        first: "applied",
        replay: "conflict",
        server_key_rewrite: "invalid",
        audit_rows: 1,
      };
    },
  );
}

function main() {
  try {
    startCluster();
    sql(FIXTURE, "postgres");
    applyMigrations();
    sql(seedSql());
    // MVP-001 S1 (PS-A2): record the environment as the owner, once, after
    // ENV-1 has proved the unrecorded refusal.
    environmentChecks();
    ensureEnvironmentRecorded();
    probes();
  } catch (error) {
    report.checks.push({
      name: "setup",
      result: "FAIL",
      error: String(error?.message ?? error),
    });
  }
  const cleaned = teardown();
  report.cleanup = cleaned ? "removed" : "FAILED";
  const failed = report.checks.filter((c) => c.result !== "PASS");
  report.result = failed.length === 0 && cleaned ? "PASS" : "FAIL";
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = !cleaned ? 2 : failed.length === 0 ? 0 : 1;
}

main();
