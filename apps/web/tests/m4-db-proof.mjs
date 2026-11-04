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
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assessEligibility,
  evaluationRowOf,
} from "../src/application/eligibility-assessment.ts";
import { auditEventOf } from "../src/application/professional-audit.ts";
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

// One statement as a role with a JWT subject, inside a transaction that is
// always rolled back, so probes never change state.
function as(role, subject, statement) {
  return psql(
    [
      "begin;",
      `set local role ${role};`,
      subject === null
        ? ""
        : `select set_config('request.jwt.claim.sub', '${subject}', true) is not null;`,
      statement,
      "rollback;",
      "",
    ].join("\n"),
  );
}

function valueAs(role, subject, statement) {
  const result = as(role, subject, statement);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  return lines[lines.length - 1];
}

function sqlstateOf(result) {
  return /ERROR:\s+([0-9A-Z]{5}):/.exec(result.stderr ?? "")?.[1] ?? null;
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
  assert.equal(files.length, 14);
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

const SCOPE = (subject, jurisdiction) =>
  valueAs(
    "authenticated",
    subject,
    `select public.has_manage_attorney_verification_scope(${jurisdiction === null ? "null" : `'${jurisdiction}'`}, false);`,
  );
const COUNT = (subject, table, where = "true") =>
  Number(
    valueAs(
      "authenticated",
      subject,
      `select count(*) from public.${table} where ${where};`,
    ),
  );

function probes() {
  // Synthetic professional records: A in SYN_A with evidence; B in SYN_B.
  sql(`
    insert into public.licenses (id, attorney_id, jurisdiction_id, license_number) values
      ('${U(601)}', '${PROFILE_A}', '${J_A}', 'SYN-A-1'),
      ('${U(602)}', '${PROFILE_B}', '${J_B}', 'SYN-B-1');
    insert into public.verification_evidence (id, jurisdiction_id, source_type, source_reference, retrieved_at, retrieved_by_user_id, evidence_summary, verification_method, discrepancy_flag)
      values ('${U(701)}', '${J_A}', 'synthetic register', 'synthetic entry', now() - interval '1 hour', '${USER.staffA}', 'synthetic', 'synthetic lookup', false),
             ('${U(702)}', '${J_B}', 'synthetic register', 'synthetic entry', now() - interval '1 hour', '${USER.staffGlobal}', 'synthetic', 'synthetic lookup', false);
    insert into public.verification_evidence_subjects (verification_evidence_id, license_id) values ('${U(701)}', '${U(601)}'), ('${U(702)}', '${U(602)}');
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
    "RLS-2 the scope predicate and reads for global, jurisdiction-scoped, expired, revoked, resource-scoped, future, and absent grants",
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
    "RLS-3 ordinary sessions cannot write professional, evidence, evaluation, grant, or audit rows; capability grants and policy are unreadable",
    () => {
      const writes = [
        `insert into public.licenses (attorney_id, jurisdiction_id, license_number) values ('${PROFILE_A}', '${J_A}', 'SYN-SELF');`,
        `update public.licenses set reported_status = 'verified' where id = '${U(601)}';`,
        `update public.attorney_profiles set profile_state = 'approved' where id = '${PROFILE_A}';`,
        `insert into public.verification_evidence (retrieved_at) values (now());`,
        `insert into public.eligibility_evaluations (attorney_id, jurisdiction_id, context_type, evaluated_at, policy_references, result, factor_results, evidence_references, as_of) values ('${PROFILE_A}', '${J_A}', 'jurisdiction', now(), '[]', 'eligible', '[]', '{}', now());`,
        `insert into public.audit_events (actor_type, action_code, resource_type, occurred_at) values ('attorney', 'x', 'y', now());`,
        `select count(*) from public.capability_grants;`,
        `select count(*) from public.policy_versions;`,
        `select count(*) from public.jurisdictions;`,
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
    },
  );

  check(
    "CON-1 constraints: one subject per evidence link, unique license numbers, valid dates and lifecycle states, staff-only grants, unique practice-area requests",
    () => {
      const service = (statement) =>
        sqlstateOf(as("service_role", null, statement));
      // Two subjects, or none, violate the one-subject check; a repeated link
      // violates the per-subject unique index.
      assert.equal(
        service(
          `insert into public.verification_evidence_subjects (verification_evidence_id, license_id, insurance_record_id) values ('${U(702)}', '${U(601)}', '${U(601)}');`,
        ),
        "23514",
      );
      assert.equal(
        service(
          `insert into public.verification_evidence_subjects (verification_evidence_id) values ('${U(702)}');`,
        ),
        "23514",
      );
      assert.equal(
        service(
          `insert into public.verification_evidence_subjects (verification_evidence_id, license_id) values ('${U(701)}', '${U(601)}');`,
        ),
        "23505",
      );
      assert.equal(
        service(
          `insert into public.licenses (attorney_id, jurisdiction_id, license_number) values ('${PROFILE_B}', '${J_A}', 'SYN-A-1');`,
        ),
        "23505",
      );
      assert.equal(
        service(
          `insert into public.licenses (attorney_id, jurisdiction_id, license_number, effective_from, effective_until) values ('${PROFILE_A}', '${J_B}', 'SYN-D', '2026-02-01', '2026-01-01');`,
        ),
        "23514",
      );
      assert.equal(
        service(
          `update public.attorney_profiles set profile_state = 'verified' where id = '${PROFILE_A}';`,
        ),
        "23514",
      );
      assert.equal(
        service(
          `insert into public.capability_grants (user_id, capability_code, granted_by_user_id) values ('${USER.client}', 'manage_attorney_verification', '${USER.grantor}');`,
        ),
        "23503",
      );
      assert.equal(
        service(
          `insert into public.practice_area_authorisations (attorney_id, jurisdiction_id, practice_area_id, status, requested_at) values ('${PROFILE_A}', '${J_A}', '${AREA}', 'requested', now()), ('${PROFILE_A}', '${J_A}', '${AREA}', 'requested', now());`,
        ),
        "23505",
      );
      assert.equal(
        service(
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
    "APP-1 guarded claim and review writes behave as the ports require: exact updated_at matches once, stale or wrong-stage writes change nothing",
    () => {
      const stampOf = () =>
        sql(
          `select to_json(updated_at)#>>'{}' from public.licenses where id = '${U(601)}';`,
        );
      const first = stampOf();
      const update = (stamp) =>
        sql(
          `set role service_role; with u as (update public.licenses set license_type = 'synthetic' where id = '${U(601)}' and attorney_id = '${PROFILE_A}' and updated_at = '${stamp}' and reported_status is null returning 1) select count(*) from u;`,
        );
      assert.equal(update(first), "1");
      assert.equal(update(first), "0");
      const transition = (from, to) =>
        sql(
          `set role service_role; with u as (update public.attorney_profiles set profile_state = '${to}' where id = '${PROFILE_B}' and profile_state = '${from}' returning 1) select count(*) from u;`,
        );
      assert.equal(transition("under_review", "approved"), "1");
      assert.equal(transition("under_review", "approved"), "0");
      assert.equal(transition("approved", "suspended"), "1");
      assert.equal(
        sql(
          `select profile_state from public.attorney_profiles where id = '${PROFILE_B}';`,
        ),
        "suspended",
      );
      return { first_stamp_format: first };
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
      sql(`
      insert into public.policy_types (code, name) values ('attorney_eligibility', 'Synthetic test fixture');
      insert into public.policy_versions (id, policy_type_code, jurisdiction_id, version_label, parameters) values ('${U(801)}', 'attorney_eligibility', '${J_A}', 'synthetic-v1', $j$${JSON.stringify(parameters)}$j$::jsonb);
      insert into public.policy_authority_references (policy_version_id, authority_type, citation_text, source_title, retrieved_at, verified_by_user_id, verification_status)
        values ('${U(801)}', 'synthetic', 'synthetic citation', 'synthetic source', now(), '${USER.grantor}', 'verified');
      update public.policy_versions set status = 'active', approved_at = now() - interval '2 days', approved_by_user_id = '${USER.grantor}', effective_from = now() - interval '1 day' where id = '${U(801)}';
      update public.attorney_profiles set profile_state = 'approved' where id = '${PROFILE_A}';
      update public.licenses set reported_status = 'synthetic-active' where id = '${U(601)}';
      insert into public.insurance_records (id, attorney_id, jurisdiction_id, carrier_name, per_occurrence_limit_minor, currency_code, coverage_from, coverage_until)
        values ('${U(901)}', '${PROFILE_A}', '${J_A}', 'Synthetic carrier', 250000, 'XTS', current_date - 30, current_date + 30);
      insert into public.verification_evidence (id, jurisdiction_id, source_type, source_reference, retrieved_at, retrieved_by_user_id, evidence_summary, verification_method, discrepancy_flag)
        values ('${U(703)}', '${J_A}', 'synthetic insurer', 'synthetic certificate', now() - interval '1 hour', '${USER.staffA}', 'synthetic', 'synthetic document', false);
      insert into public.verification_evidence_subjects (verification_evidence_id, insurance_record_id) values ('${U(703)}', '${U(901)}');
    `);
      // A draft policy is never applied: the trigger refuses an active
      // version without verified provenance.
      const unverified = as(
        "service_role",
        null,
        `insert into public.policy_versions (policy_type_code, jurisdiction_id, version_label, parameters, status, approved_at, approved_by_user_id, effective_from) values ('attorney_eligibility', '${J_B}', 'synthetic-unverified', '{}'::jsonb, 'active', now(), '${USER.grantor}', now());`,
      );
      assert.equal(sqlstateOf(unverified), "23514");
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
          `public.policy_versions where policy_type_code = 'attorney_eligibility' and jurisdiction_id = '${J_A}'`,
        ),
        authorityReferences: jsonRows(
          AUTHORITY_REFERENCE_COLUMNS,
          `public.policy_authority_references where policy_version_id = '${U(801)}'`,
        ),
      });
      const t1Facts = facts();
      assert.equal(
        selectEligibilityPolicy(
          J_A,
          nowMs,
          t1Facts.policyVersions,
          t1Facts.authorityReferences,
        ).status,
        "selected",
      );
      for (const row of t1Facts.insurance) {
        assert.notEqual(readInsurance(row), null);
      }
      const t1 = assessEligibility(t1Facts, nowMs);
      assert.equal(t1.result, "eligible", JSON.stringify(t1.factors));
      const insertEvaluation = (assessment) => {
        const row = evaluationRowOf(assessment, nowMs);
        const json = JSON.stringify(row);
        return sql(
          `set role service_role; insert into public.eligibility_evaluations select * from jsonb_populate_record(null::public.eligibility_evaluations, $e$${json}$e$::jsonb || jsonb_build_object('id', gen_random_uuid(), 'created_at', now())) returning id;`,
        );
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
    "AUD-1 application audit rows insert as the service role and are immutable",
    () => {
      const event = auditEventOf({
        actorUserId: USER.staffA,
        actorType: "staff",
        action: "verification_evidence_recorded",
        resourceType: "verification_evidence",
        resourceId: U(701),
        after: { subject_kind: "license", discrepancy: false },
        jurisdictionId: J_A,
        occurredAtMs: Date.now(),
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
    "SEC-1 no existing database object can enforce staff authorization or audit coupling at the privileged write: only read-only definer predicates, only SELECT policies, no ordinary write grants, and a row-security-bypassing service role",
    () => {
      const definers = sql(
        "select coalesce(string_agg(p.proname || ':' || p.provolatile::text, ',' order by p.proname), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef;",
      );
      assert.equal(
        definers,
        "has_manage_attorney_verification_scope:s,has_resource_metadata_access:s",
      );
      assert.equal(
        sql(
          "select count(*) from pg_policies where schemaname = 'public' and cmd <> 'SELECT';",
        ),
        "0",
      );
      const m4 =
        "'attorney_profiles','licenses','insurance_records','discipline_records','practice_area_authorisations','verification_evidence','verification_evidence_subjects','eligibility_evaluations','audit_events'";
      assert.equal(
        sql(
          `select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name in (${m4}) and grantee in ('authenticated', 'anon') and privilege_type <> 'SELECT';`,
        ),
        "0",
      );
      assert.equal(
        sql(
          `select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname in (${m4}) and not t.tgisinternal and t.tgname not like '%set_updated_at' and t.tgname <> 'audit_events_immutable';`,
        ),
        "0",
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
      };
    },
  );

  check(
    "SEC-2 the final check-to-write window is open at the database: after a grant is revoked, the service role's guarded writes still succeed, because nothing in the write path consults the grant",
    () => {
      sql(
        `update public.capability_grants set revoked_at = now() where user_id = '${USER.staffA}';`,
      );
      const predicate = SCOPE(AUTH.staffA, J_A);
      const written = sql(
        `set role service_role; with e as (insert into public.verification_evidence (jurisdiction_id, retrieved_at, retrieved_by_user_id, evidence_summary) values ('${J_A}', now(), '${USER.staffA}', 'synthetic after revocation') returning 1) select count(*) from e;`,
      );
      assert.equal(predicate, "f");
      assert.equal(written, "1");
      return {
        predicate_after_revocation: predicate,
        service_role_write_rows: written,
      };
    },
  );

  check(
    "SEC-3 the scope predicate ignores staff and account state: a deactivated Staff Profile and suspended User holding an unrevoked grant still pass it and still read evidence under the row policies",
    () => {
      sql(
        `update public.staff_profiles set staff_state = 'deactivated' where user_id = '${USER.staffGlobal}';`,
      );
      sql(
        `update public.users set account_state = 'suspended' where id = '${USER.staffGlobal}';`,
      );
      const predicate = SCOPE(AUTH.staffGlobal, J_A);
      const evidence = COUNT(AUTH.staffGlobal, "verification_evidence");
      const profiles = COUNT(AUTH.staffGlobal, "attorney_profiles");
      assert.equal(predicate, "t");
      assert.ok(evidence > 0 && profiles > 0);
      return {
        predicate: predicate,
        evidence_rows_readable: evidence,
        profile_rows_readable: profiles,
      };
    },
  );

  check(
    "APP-4 server-generated ids and write-ahead attempt/outcome audit rows are accepted by the real schema, and a generated id cannot be inserted twice",
    () => {
      const licenseId = U(611);
      sql(
        `set role service_role; insert into public.licenses (id, attorney_id, jurisdiction_id, license_number) values ('${licenseId}', '${PROFILE_A}', '${J_B}', 'SYN-GEN-1');`,
      );
      assert.equal(
        sql(`select count(*) from public.licenses where id = '${licenseId}';`),
        "1",
      );
      assert.equal(
        sqlstateOf(
          as(
            "service_role",
            null,
            `insert into public.licenses (id, attorney_id, jurisdiction_id, license_number) values ('${licenseId}', '${PROFILE_A}', '${J_B}', 'SYN-GEN-2');`,
          ),
        ),
        "23505",
      );
      const append = (event) =>
        sql(
          `set role service_role; insert into public.audit_events select * from jsonb_populate_record(null::public.audit_events, $a$${JSON.stringify(event)}$a$::jsonb || jsonb_build_object('id', gen_random_uuid(), 'created_at', now())) returning id;`,
        );
      const attemptId = append(
        auditEventOf({
          actorUserId: USER.staffA,
          actorType: "staff",
          action: "attorney_profile_state_changed",
          resourceType: "attorney_profile",
          resourceId: PROFILE_B,
          before: { profile_state: "under_review" },
          after: { profile_state: "approved", audit_phase: "attempt" },
          occurredAtMs: Date.now(),
        }),
      );
      const outcomeId = append(
        auditEventOf({
          actorUserId: USER.staffA,
          actorType: "staff",
          action: "audited_change_outcome",
          resourceType: "attorney_profile",
          resourceId: PROFILE_B,
          after: {
            audit_phase: "outcome",
            attempt_event_id: attemptId,
            outcome: "applied",
            authority: "held",
            authority_checked: "at_completion",
          },
          occurredAtMs: Date.now(),
        }),
      );
      assert.equal(
        sql(
          `select after_snapshot->>'attempt_event_id' from public.audit_events where id = '${outcomeId}';`,
        ),
        attemptId,
      );
      return { attempt: attemptId, outcome: outcomeId };
    },
  );
}

function main() {
  try {
    startCluster();
    sql(FIXTURE, "postgres");
    applyMigrations();
    sql(seedSql());
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
