// MVP-001 S3 disposable PostgreSQL proof (protected Storage, voice memos,
// verification artifacts). Explicitly invoked only:
//
//   node apps/web/tests/mvp-001-s3-db-proof.mjs
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
// one transaction; the three S3 migrations must follow S2 and be registered.
//
// Two databases are built. The main one has no storage schema, as on plain
// PostgreSQL: the bucket step must be skipped cleanly and every function must
// still work. A second one carries a minimal synthetic stand-in of the two
// Supabase storage relations the migration and the completion function read
// (storage.buckets, storage.objects), to show the private bucket row and the
// stored-object check; the real Storage service is verified separately on a
// local Supabase stack.
//
// Request sessions are modelled as PostgREST sets them from a verified JWT:
// request.jwt.claim.sub and the JSON request.jwt.claims ("aal": "aal2" after
// a Supabase Auth MFA step-up, "aal1" before it).
//
// The probes cover the MVP-001 Packet S3 acceptance list for the database:
// the resource lifecycle and its constraints, Legal Hold before deletion,
// function-only writes, the voice memo start and completion (outcomes,
// audit, attempt bound, one available memo per Intake), the Intake left
// exactly as it was by every refused, failed or abandoned upload, the access
// authorization matrix (owner client, other client, attorney, staff with and
// without scope, Sharing Grants active, expired, future and revoked, Legal
// Hold, pending and rejected resources), object-path guessing, metadata row
// policies, verification artifacts (start, the evidence reference check, one
// finding per artifact, scoped access only), and the audit trail. S3 part 2
// adds the three migrations that follow (20261119040000-060000) and their
// probes: the Intake lifecycle guard (no deletion, legal transitions only),
// expiry keyed on expires_at (set here by the owner role, as no application
// path sets it) and evaluated by every command with no scheduler present,
// the bounded sweep, the post-submission change seam answering
// not_configured, AI suggestions recorded only as presented through the
// service_role function (outcomes, bounds, abuse limit), the client's
// one-time confirmation or rejection, proof by full-relation digests that AI
// functions change only ai_suggestions, jurisdiction_assessments and
// audit_events, the jurisdiction assessment constraints and integrity,
// ambiguity surfaced without a choice, the staff review authorization matrix
// (aal2, capability, jurisdiction scope, clients and attorneys refused), the
// read functions' minimal disclosure, the counsel gate for attorneys, and the
// privilege and definer inventory of every function involved. No Supabase
// project, network service, or pre-existing cluster is contacted, nothing
// persists after the run, and every value is synthetic test data. The JSON
// report goes to stdout; exit 0 means PASS, 1 FAIL, 2 cleanup failure.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54338;
const DB = "rosuno_s3_proof";
const STORAGE_DB = "rosuno_s3_storage_proof";
const REPOSITORY_ROOT = path.resolve(
  path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
  "../../..",
);
const MIGRATIONS = path.join(REPOSITORY_ROOT, "supabase/migrations");
const S2_LAST = "20261118040000_mvp_001_s2_authentication_abuse_control.sql";
const S3_MIGRATIONS = Object.freeze([
  "20261119010000_mvp_001_s3_protected_storage.sql",
  "20261119020000_mvp_001_s3_voice_memo_intake.sql",
  "20261119030000_mvp_001_s3_verification_artifacts.sql",
]);
const BUCKET = "rosuno-private-resources";
const V1 = JSON.parse(
  fs.readFileSync(
    path.join(
      REPOSITORY_ROOT,
      "apps/web/tests/fixtures/intake-questions-v1.canonical.txt",
    ),
    "utf8",
  ),
);

const report = {
  proof: "MVP-001 S3 disposable local PostgreSQL proof",
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
    options.db ?? DB,
  );
  if (result.status === 0) {
    const lines = result.stdout.trim().split("\n");
    return lines[lines.length - 1];
  }
  return `ERROR ${sqlstateOf(result.stderr)}`;
}

const uid = () => randomUUID();
const digest = () => `sha256:${randomBytes(32).toString("hex")}`;

function count(table, where = "true", db = DB) {
  return Number(
    sql(`select count(*) from public.${table} where ${where};`, db),
  );
}

const FIXTURE = (db) => `
create database ${db} template template0 encoding 'UTF8' locale 'C';
\\connect ${db}
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

// A minimal synthetic stand-in of the two Supabase storage relations the
// migration and resource_finalize_upload read; no Storage service exists.
const STORAGE_STAND_IN = `
\\connect ${STORAGE_DB}
create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now()
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null,
  metadata jsonb,
  created_at timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
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
    path.join(os.tmpdir(), "rosuno-mvp-001-s3-db-proof-"),
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

function applyAll(db) {
  const notices = {};
  for (const file of migrationFiles()) {
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
    if (S3_MIGRATIONS.includes(file)) {
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
  // S3 follows S2, contiguous and in order, and every S3 migration is
  // registered unreviewed and applied nowhere.
  const s2 = files.indexOf(S2_LAST);
  assert.ok(s2 >= 0, "S2 migrations are present");
  assert.deepEqual(files.slice(s2 + 1, s2 + 1 + S3_MIGRATIONS.length), [
    ...S3_MIGRATIONS,
  ]);
  for (const file of S3_MIGRATIONS) {
    const row = registered.find(
      (migration) => migration.artifact_path === `supabase/migrations/${file}`,
    );
    assert.ok(row, `${file} is registered`);
    assert.equal(row.reviewed, false);
    assert.equal(row.applied_environment, "none");
  }
  sql(ROLES, "postgres");
  sql(FIXTURE(DB), "postgres");
  sql(FIXTURE(STORAGE_DB), "postgres");
  sql(STORAGE_STAND_IN, "postgres");
  report.migrations.notices = applyAll(DB);
  report.migrations.storage_stand_in_notices = applyAll(STORAGE_DB);
  report.migrations.applied = files.length;
  report.migrations.s3 = [...S3_MIGRATIONS];
}

// ---------------------------------------------------------------------------
// Synthetic seed
// ---------------------------------------------------------------------------

const world = {};

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

function newStaff(grants, db = DB) {
  const ids = newAccount("active", db);
  sql(
    `insert into public.staff_profiles (user_id, staff_state) values ('${ids.user}', 'active');`,
    db,
  );
  const grantIds = grants.map((g) => {
    const id = uid();
    sql(
      `insert into public.capability_grants (id, user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at, expires_at, revoked_at)
       values ('${id}', '${ids.user}', ${lit(g.capability)}, '${(db === DB ? world : world.storage).grantor.user}', ${lit(g.jurisdiction ?? null)},
               now() - interval '1 day', null, null);`,
      db,
    );
    return id;
  });
  return { ...ids, grants: grantIds };
}

function newClient(db = DB) {
  const ids = newAccount("active", db);
  const client = uid();
  sql(
    `insert into public.client_profiles (id, user_id) values ('${client}', '${ids.user}');`,
    db,
  );
  return { ...ids, client };
}

// A closed Intake carries its closing time (S3 part 2: closed_at is set
// exactly when the state is closed, intakes_closed_at_lifecycle_check).
function newIntake(client, stateName = "draft", db = DB) {
  const id = uid();
  sql(
    `insert into public.intakes (id, client_id, state, closed_at) values ('${id}', '${client.client}', '${stateName}', ${stateName === "closed" ? "now()" : "null"});`,
    db,
  );
  return id;
}

function seedWorld(target, db) {
  target.jurisdiction = uid();
  target.otherJurisdiction = uid();
  sql(
    `insert into public.jurisdictions (id, code, name, region_type) values
       ('${target.jurisdiction}', 'SYN_S3_${db === DB ? "A" : "SA"}', 'Synthetic S3 A', 'synthetic'),
       ('${target.otherJurisdiction}', 'SYN_S3_${db === DB ? "B" : "SB"}', 'Synthetic S3 B', 'synthetic');`,
    db,
  );
  target.grantor = newAccount("active", db);
  sql(
    `insert into public.staff_profiles (user_id, staff_state) values ('${target.grantor.user}', 'active');`,
    db,
  );
  target.questionSet = uid();
  sql(
    `insert into public.intake_question_sets (id, version_key, definition, published_at)
       values ('${target.questionSet}', 'intake-questions-v1', ${lit(V1)}::jsonb, now() - interval '2 days');`,
    db,
  );
}

function seed() {
  seedWorld(world, DB);
  // Clients, each with their own draft Intake holding one revision.
  world.owner = newClient();
  world.otherClient = newClient();
  world.recipient = newClient();
  world.ownerIntake = newIntake(world.owner);
  sql(
    `insert into public.intake_revisions (intake_id, revision_number, question_set_id, description, structured_answers)
       values ('${world.ownerIntake}', 1, '${world.questionSet}', 'Synthetic description one', '{}'::jsonb);`,
  );
  world.otherIntake = newIntake(world.otherClient);
  world.submittedIntake = newIntake(world.owner, "submitted");
  world.closedIntake = newIntake(world.owner, "closed");
  // Staff: global verification scope, scoped to A, scoped to B, and other
  // capability only.
  world.verifier = newStaff([{ capability: "manage_attorney_verification" }]);
  world.scopedA = newStaff([
    {
      capability: "manage_attorney_verification",
      jurisdiction: world.jurisdiction,
    },
  ]);
  world.scopedB = newStaff([
    {
      capability: "manage_attorney_verification",
      jurisdiction: world.otherJurisdiction,
    },
  ]);
  world.intakeAdmin = newStaff([{ capability: "manage_intake_configuration" }]);
  // Attorneys: one under review with a license in A, one applicant with a
  // license in A, and one approved attorney who is also verification staff.
  world.attorney = newAccount();
  world.attorneyProfile = uid();
  world.applicant = newAccount();
  world.applicantProfile = uid();
  world.license = uid();
  world.applicantLicense = uid();
  world.selfStaff = newStaff([{ capability: "manage_attorney_verification" }]);
  world.selfProfile = uid();
  world.selfLicense = uid();
  sql(
    `insert into public.attorney_profiles (id, user_id, profile_state) values
       ('${world.attorneyProfile}', '${world.attorney.user}', 'under_review'),
       ('${world.applicantProfile}', '${world.applicant.user}', 'applicant'),
       ('${world.selfProfile}', '${world.selfStaff.user}', 'under_review');
     insert into public.licenses (id, attorney_id, jurisdiction_id, license_number, reported_status) values
       ('${world.license}', '${world.attorneyProfile}', '${world.jurisdiction}', 'SYN-S3-LIC-1', 'synthetic-active'),
       ('${world.applicantLicense}', '${world.applicantProfile}', '${world.jurisdiction}', 'SYN-S3-LIC-2', 'synthetic-active'),
       ('${world.selfLicense}', '${world.selfProfile}', '${world.jurisdiction}', 'SYN-S3-LIC-3', 'synthetic-active');`,
  );
  world.storage = {};
  seedWorld(world.storage, STORAGE_DB);
  world.storage.owner = newClient(STORAGE_DB);
  world.storage.ownerIntake = newIntake(
    world.storage.owner,
    "draft",
    STORAGE_DB,
  );
}

// ---------------------------------------------------------------------------
// Call helpers
// ---------------------------------------------------------------------------

function beginVoiceMemo(principal, intake, overrides = {}, options = {}) {
  const v = {
    mime: "audio/webm",
    size: 4096,
    digest: digest(),
    duration: 12,
    ...overrides,
  };
  const answer = as(
    "authenticated",
    principal.auth,
    `select outcome || '|' || coalesce(resource_id::text, '') from public.resource_begin_voice_memo(${lit(intake)}::uuid, ${lit(v.mime)}, ${lit(v.size)}::bigint, ${lit(v.digest)}, ${lit(v.duration)}::integer);`,
    options,
  );
  const [outcome, id] = answer.split("|");
  return { outcome, id: id === "" ? null : id, answer };
}

function finalize(principal, id, options = {}) {
  return as(
    "authenticated",
    principal.auth,
    `select public.resource_finalize_upload(${lit(id)}::uuid);`,
    options,
  );
}

function abandon(principal, id, options = {}) {
  return as(
    "authenticated",
    principal.auth,
    `select public.resource_abandon_upload(${lit(id)}::uuid);`,
    options,
  );
}

function authorize(principal, id, kind = "voice_memo", options = {}) {
  return as(
    "authenticated",
    principal === null ? null : principal.auth,
    `select outcome || '|' || coalesce(object_path, '') from public.resource_authorize_access(${lit(id)}::uuid, ${lit(kind)});`,
    options,
  );
}

function beginArtifact(principal, subject, overrides = {}, options = {}) {
  const v = {
    kind: "license",
    mime: "application/pdf",
    size: 2048,
    digest: digest(),
    ...overrides,
  };
  const answer = as(
    "authenticated",
    principal.auth,
    `select outcome || '|' || coalesce(resource_id::text, '') from public.resource_begin_verification_artifact(${lit(v.kind)}, ${lit(subject)}::uuid, ${lit(v.mime)}, ${lit(v.size)}::bigint, ${lit(v.digest)});`,
    options,
  );
  const [outcome, id] = answer.split("|");
  return { outcome, id: id === "" ? null : id, answer };
}

function licenseUpdatedAt(license) {
  return sql(`select updated_at from public.licenses where id = '${license}';`);
}

function finding(
  principal,
  license,
  sourceType,
  sourceReference,
  options = {},
) {
  return as(
    "authenticated",
    principal.auth,
    `select public.staff_record_verification_finding(null, 'license', ${lit(license)}::uuid, ${lit(licenseUpdatedAt(license))}::timestamptz, ${lit(sourceType)}, null, ${lit(sourceReference)}, now() - interval '1 hour', 'synthetic register lookup', 'Synthetic summary of the source', null, false, null, null, null);`,
    options,
  );
}

// A voice memo already available for a fresh draft Intake of the client.
function availableVoiceMemo(client) {
  const intake = newIntake(client);
  const started = beginVoiceMemo(client, intake);
  assert.equal(started.outcome, "created", started.answer);
  assert.equal(finalize(client, started.id), "available");
  return { intake, id: started.id };
}

// An artifact uploaded and attached to a finding on the license.
function attachedArtifact(staff, license) {
  const started = beginArtifact(staff, license);
  assert.equal(started.outcome, "created", started.answer);
  assert.equal(finalize(staff, started.id), "available");
  assert.equal(
    finding(staff, license, "uploaded_artifact", started.id),
    "applied",
  );
  return started.id;
}

function intakeSnapshot(intake, db = DB) {
  return sql(
    `select jsonb_build_object(
       'intake', (select to_jsonb(i) from public.intakes as i where i.id = '${intake}'),
       'revisions', (select coalesce(jsonb_agg(to_jsonb(r) order by r.revision_number), '[]'::jsonb) from public.intake_revisions as r where r.intake_id = '${intake}'),
       'xmin', (select xmin::text from public.intakes where id = '${intake}')
     )::text;`,
    db,
  );
}

function auditOf(id) {
  return JSON.parse(
    sql(
      `select coalesce(jsonb_agg(jsonb_build_object('actor_user_id', actor_user_id, 'actor_type', actor_type, 'action_code', action_code, 'jurisdiction_id', jurisdiction_id, 'before', before_snapshot, 'after', after_snapshot) order by occurred_at, id), '[]'::jsonb) from public.audit_events where resource_type = 'resource' and resource_id = '${id}';`,
    ),
  );
}

function hold(scopeId, released = false) {
  const id = uid();
  sql(
    `insert into public.legal_holds (id, scope_type, scope_id, status, reason, started_at, released_at, created_by_user_id, released_by_user_id)
       values ('${id}', 'synthetic_scope', '${scopeId}', 'synthetic_status', 'Synthetic hold reason', now() - interval '1 hour',
               ${released ? "now() - interval '1 minute'" : "null"}, '${world.grantor.user}', ${released ? `'${world.grantor.user}'` : "null"});`,
  );
  return id;
}

function releaseHold(id) {
  sql(
    `update public.legal_holds set status = 'synthetic_released', released_at = now(), released_by_user_id = '${world.grantor.user}' where id = '${id}';`,
  );
}

function grant(
  resource,
  recipient,
  {
    expires = null,
    revoked = null,
    granted = "now() - interval '1 hour'",
  } = {},
) {
  const id = uid();
  sql(
    `insert into public.resource_sharing_grants (id, resource_id, recipient_user_id, context_type, context_id, purpose_code, granted_at, expires_at, revoked_at, granted_by_user_id)
       values ('${id}', '${resource}', '${recipient.user}', 'synthetic_context', '${uid()}', 'synthetic_purpose', ${granted}, ${expires ?? "null"}, ${revoked ?? "null"}, '${world.grantor.user}');`,
  );
  return id;
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
    process.stderr.write(`[s3-proof] PASS ${name}\n`);
  } catch (error) {
    failed = true;
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
    process.stderr.write(`[s3-proof] FAIL ${name}\n${error?.stack ?? error}\n`);
  }
}

// The P1 columns of every relation S3 relies on (Packet rule 16: no column
// is added).
const P1_COLUMNS = Object.freeze({
  resources:
    "id,resource_kind,owner_user_id,intake_id,consultation_id,storage_bucket,storage_object_path,mime_type,byte_size,content_digest,visibility_state,retention_state,created_at,updated_at",
  documents: "id,resource_id,document_type,version_label,created_at",
  voice_memos: "id,resource_id,intake_id,duration_seconds,created_at",
  resource_sharing_grants:
    "id,resource_id,recipient_user_id,context_type,context_id,purpose_code,granted_at,expires_at,revoked_at,granted_by_user_id",
  legal_holds:
    "id,scope_type,scope_id,status,reason,started_at,released_at,created_by_user_id,released_by_user_id,created_at",
  verification_evidence:
    "id,jurisdiction_id,source_type,source_uri,source_reference,retrieved_at,retrieved_by_user_id,evidence_summary,evidence_digest,verification_method,discrepancy_flag,retention_class,created_at",
});

async function migrationChecks() {
  await check(
    "MIG-1 the three S3 migrations apply after S2, in order, registered unreviewed and applied nowhere; without a storage schema the bucket step is skipped cleanly; no relation and no column is added to any relation S3 uses",
    () => {
      assert.deepEqual(report.migrations.notices[S3_MIGRATIONS[0]], [
        "MVP-001 S3: no storage schema in this database; the private bucket is not created",
      ]);
      assert.equal(
        sql("select count(*) from pg_namespace where nspname = 'storage';"),
        "0",
      );
      for (const [table, columns] of Object.entries(P1_COLUMNS)) {
        assert.equal(
          sql(
            `select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = '${table}';`,
          ),
          columns,
          table,
        );
      }
      return { storage_schema: "absent; bucket step skipped" };
    },
  );
}

async function constraintChecks() {
  await check(
    "CON-1 resource constraints: only the two V1 kinds, the private bucket and exactly resources/<id>/original, pending/available/rejected, retention active, server-measured metadata within the type allowlist and the byte ceiling, and the kind's own context",
    () => {
      const valid = (overrides = {}) => {
        const id = overrides.id ?? uid();
        const v = {
          kind: "voice_memo",
          owner: world.owner.user,
          intake: world.ownerIntake,
          consultation: null,
          bucket: BUCKET,
          path: `resources/${id}/original`,
          mime: "audio/webm",
          size: 100,
          digest: digest(),
          visibility: "pending",
          retention: "active",
          ...overrides,
        };
        return `insert into public.resources (id, resource_kind, owner_user_id, intake_id, consultation_id, storage_bucket, storage_object_path, mime_type, byte_size, content_digest, visibility_state, retention_state)
          values ('${id}', ${lit(v.kind)}, ${lit(v.owner)}, ${lit(v.intake)}, ${lit(v.consultation)}, ${lit(v.bucket)}, ${lit(v.path)}, ${lit(v.mime)}, ${lit(v.size)}, ${lit(v.digest)}, ${lit(v.visibility)}, ${lit(v.retention)});`;
      };
      acceptedThenRolledBack(valid());
      acceptedThenRolledBack(
        valid({
          kind: "verification_artifact",
          intake: null,
          mime: "image/png",
          owner: world.verifier.user,
        }),
      );
      const id = uid();
      const refusals = {
        unknown_kind: valid({ kind: "document" }),
        other_bucket: valid({ bucket: "public-bucket" }),
        guessable_path: valid({ id, path: `resources/${id}/client-name.webm` }),
        other_resource_path: valid({ path: `resources/${uid()}/original` }),
        unknown_visibility: valid({ visibility: "public" }),
        retention_not_active: valid({ retention: "disposed" }),
        missing_mime: valid({ mime: null }),
        zero_bytes: valid({ size: 0 }),
        over_ceiling: valid({ size: 1000001 }),
        malformed_digest: valid({ digest: "md5:abc" }),
        voice_memo_pdf: valid({ mime: "application/pdf" }),
        voice_memo_without_intake: valid({ intake: null }),
        artifact_audio: valid({
          kind: "verification_artifact",
          intake: null,
          mime: "audio/webm",
        }),
        artifact_with_intake: valid({
          kind: "verification_artifact",
          mime: "application/pdf",
        }),
      };
      const codes = {};
      for (const [name, statement] of Object.entries(refusals)) {
        codes[name] = refused(statement);
        assert.equal(codes[name], "23514", name);
      }
      return codes;
    },
  );

  await check(
    "CON-2 lifecycle and immutability: pending moves only to available or rejected, nothing else about a resource changes, voice memo and document rows never change, and no relation can be truncated",
    () => {
      const memo = availableVoiceMemo(world.owner);
      const pending = beginVoiceMemo(world.owner, newIntake(world.owner));
      assert.equal(pending.outcome, "created");
      acceptedThenRolledBack(
        `update public.resources set visibility_state = 'rejected' where id = '${pending.id}';`,
      );
      const codes = {
        available_to_pending: refused(
          `update public.resources set visibility_state = 'pending' where id = '${memo.id}';`,
        ),
        available_to_rejected: refused(
          `update public.resources set visibility_state = 'rejected' where id = '${memo.id}';`,
        ),
        path_change: refused(
          `update public.resources set storage_object_path = 'resources/' || id::text || '/original', mime_type = 'audio/mp4' where id = '${memo.id}';`,
        ),
        owner_change: refused(
          `update public.resources set owner_user_id = '${world.otherClient.user}' where id = '${pending.id}';`,
        ),
        retention_change: refused(
          `update public.resources set retention_state = 'active', byte_size = byte_size + 1 where id = '${pending.id}';`,
        ),
        voice_memo_update: refused(
          `update public.voice_memos set duration_seconds = 1 where resource_id = '${memo.id}';`,
        ),
        truncate_resources: refused("truncate public.resources cascade;"),
        truncate_voice_memos: refused("truncate public.voice_memos;"),
        truncate_documents: refused("truncate public.documents;"),
      };
      assert.deepEqual(codes, {
        available_to_pending: "23514",
        available_to_rejected: "23514",
        path_change: "23514",
        owner_change: "23514",
        retention_change: "23514",
        voice_memo_update: "55000",
        truncate_resources: "55000",
        truncate_voice_memos: "55000",
        truncate_documents: "55000",
      });
      return codes;
    },
  );

  await check(
    "HOLD-1 an active Legal Hold on the resource, its Intake or the finding that references it blocks deletion of the resource and of its voice memo or document record, for every role including the owner; a released hold no longer blocks",
    () => {
      const memo = availableVoiceMemo(world.owner);
      const resourceHold = hold(memo.id);
      const codes = {
        delete_resource: refused(
          `delete from public.voice_memos where resource_id = '${memo.id}'; delete from public.resources where id = '${memo.id}';`,
        ),
        delete_voice_memo: refused(
          `delete from public.voice_memos where resource_id = '${memo.id}';`,
        ),
      };
      releaseHold(resourceHold);
      acceptedThenRolledBack(
        `delete from public.voice_memos where resource_id = '${memo.id}'; delete from public.resources where id = '${memo.id}';`,
      );
      // A hold on the Intake.
      const intakeHold = hold(memo.intake);
      codes.delete_under_intake_hold = refused(
        `delete from public.voice_memos where resource_id = '${memo.id}';`,
      );
      releaseHold(intakeHold);
      // A hold on the finding that references an artifact, and on a
      // document record of a resource.
      const artifact = attachedArtifact(world.scopedA, world.license);
      const evidence = sql(
        `select id from public.verification_evidence where source_type = 'uploaded_artifact' and source_reference = '${artifact}';`,
      );
      const evidenceHold = hold(evidence);
      codes.delete_under_finding_hold = refused(
        `delete from public.resources where id = '${artifact}';`,
      );
      sql(
        `insert into public.documents (resource_id, document_type) values ('${artifact}', 'synthetic');`,
      );
      codes.delete_document_under_hold = refused(
        `delete from public.documents where resource_id = '${artifact}';`,
      );
      releaseHold(evidenceHold);
      acceptedThenRolledBack(
        `delete from public.documents where resource_id = '${artifact}';`,
      );
      for (const code of Object.values(codes)) {
        assert.equal(code, "55000");
      }
      // An already released hold never blocks.
      const other = availableVoiceMemo(world.owner);
      hold(other.id, true);
      acceptedThenRolledBack(
        `delete from public.voice_memos where resource_id = '${other.id}';`,
      );
      return codes;
    },
  );
}

const FUNCTIONS = Object.freeze({
  "resource_begin_voice_memo(uuid, text, bigint, text, integer)": [
    "authenticated",
  ],
  "resource_begin_verification_artifact(text, uuid, text, bigint, text)": [
    "authenticated",
  ],
  "resource_finalize_upload(uuid)": ["authenticated"],
  "resource_abandon_upload(uuid)": ["authenticated"],
  "resource_authorize_access(uuid, text)": ["authenticated"],
  "has_resource_metadata_access(uuid)": ["authenticated"],
  "resource_under_legal_hold(uuid)": [],
  "resource_record_guard()": [],
  "verification_evidence_artifact_guard()": [],
});

async function privilegeChecks() {
  await check(
    "PRIV-1 writes are function-only: no API role holds INSERT, UPDATE, DELETE or TRUNCATE on resources, voice_memos or documents (table or column); service_role reads none of them; authenticated reads metadata columns only, never the bucket or path; row security stays on with read policies only",
    () => {
      for (const table of ["resources", "voice_memos", "documents"]) {
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
              sql(
                `select has_table_privilege('${role}', 'public.${table}', '${privilege}');`,
              ),
              "f",
              `${role} ${privilege} ${table}`,
            );
          }
        }
        assert.equal(
          sql(
            `select count(*) from information_schema.column_privileges where table_schema = 'public' and table_name = '${table}' and grantee in ('anon', 'service_role', 'PUBLIC');`,
          ),
          "0",
          table,
        );
        assert.equal(
          sql(
            `select count(*) from information_schema.column_privileges where table_schema = 'public' and table_name = '${table}' and grantee = 'authenticated' and privilege_type <> 'SELECT';`,
          ),
          "0",
          table,
        );
        assert.equal(
          sql(
            `select relrowsecurity from pg_class where oid = 'public.${table}'::regclass;`,
          ),
          "t",
        );
        assert.equal(
          sql(
            `select count(*) from pg_policies where schemaname = 'public' and tablename = '${table}' and cmd <> 'SELECT';`,
          ),
          "0",
        );
      }
      assert.equal(
        sql(
          "select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges where table_schema = 'public' and table_name = 'resources' and grantee = 'authenticated';",
        ),
        "byte_size,consultation_id,content_digest,created_at,id,intake_id,mime_type,owner_user_id,resource_kind,retention_state,updated_at,visibility_state",
      );
      const memo = availableVoiceMemo(world.owner);
      const direct = {
        authenticated_insert: as(
          "authenticated",
          world.owner.auth,
          `insert into public.resources (resource_kind, owner_user_id, intake_id, storage_bucket, storage_object_path, mime_type, byte_size, content_digest, visibility_state, retention_state) values ('voice_memo', '${world.owner.user}', '${world.ownerIntake}', '${BUCKET}', 'x', 'audio/webm', 1, '${digest()}', 'available', 'active');`,
        ),
        authenticated_update: as(
          "authenticated",
          world.owner.auth,
          `update public.resources set visibility_state = 'available' where id = '${memo.id}';`,
        ),
        authenticated_path_read: as(
          "authenticated",
          world.owner.auth,
          `select storage_object_path from public.resources where id = '${memo.id}';`,
        ),
        service_role_insert: as(
          "service_role",
          null,
          `insert into public.voice_memos (resource_id, intake_id, duration_seconds) values ('${memo.id}', '${world.ownerIntake}', 1);`,
        ),
        service_role_read: as(
          "service_role",
          null,
          "select count(*) from public.resources;",
        ),
        service_role_update: as(
          "service_role",
          null,
          `update public.resources set visibility_state = 'rejected' where id = '${memo.id}';`,
        ),
        anon_read: as("anon", null, "select count(*) from public.resources;"),
      };
      for (const [name, answer] of Object.entries(direct)) {
        assert.equal(answer, "ERROR 42501", name);
      }
      return direct;
    },
  );

  await check(
    "PRIV-2 function privileges and settings: only authenticated executes the five resource functions and the metadata predicate; no API role executes the Legal Hold predicate or the guards; every resource function is SECURITY DEFINER with search_path pg_catalog, pg_temp and a lock timeout; the predicates and guards are fixed",
    () => {
      const settings = {};
      for (const [signature, allowed] of Object.entries(FUNCTIONS)) {
        for (const role of ["anon", "authenticated", "service_role"]) {
          assert.equal(
            sql(
              `select has_function_privilege('${role}', 'public.${signature}', 'EXECUTE');`,
            ),
            allowed.includes(role) ? "t" : "f",
            `${role} ${signature}`,
          );
        }
        assert.equal(
          sql(
            `select count(*) from (select (aclexplode(proacl)).* from pg_proc where oid = 'public.${signature}'::regprocedure) as a where a.grantee = 0;`,
          ),
          "0",
          `PUBLIC ${signature}`,
        );
        settings[signature] = sql(
          `select prosecdef::text || '|' || coalesce(array_to_string(proconfig, ';'), '') || '|' || pg_get_userbyid(proowner) from pg_proc where oid = 'public.${signature}'::regprocedure;`,
        );
      }
      for (const signature of [
        "resource_begin_voice_memo(uuid, text, bigint, text, integer)",
        "resource_begin_verification_artifact(text, uuid, text, bigint, text)",
        "resource_finalize_upload(uuid)",
        "resource_abandon_upload(uuid)",
        "resource_authorize_access(uuid, text)",
      ]) {
        assert.equal(
          settings[signature],
          "true|search_path=pg_catalog, pg_temp;lock_timeout=3s|postgres",
          signature,
        );
      }
      // MVP-001 S10 (20261126040000) replaces the metadata predicate forward
      // with the house search_path (pg_catalog, pg_temp: pg_temp searched
      // last, never first), the only admitted change.
      assert.equal(
        settings["has_resource_metadata_access(uuid)"],
        "true|search_path=pg_catalog, pg_temp|postgres",
      );
      for (const signature of [
        "resource_under_legal_hold(uuid)",
        "resource_record_guard()",
        "verification_evidence_artifact_guard()",
      ]) {
        assert.equal(
          settings[signature],
          "false|search_path=pg_catalog|postgres",
          signature,
        );
      }
      return settings;
    },
  );
}

async function voiceMemoChecks() {
  await check(
    "VM-1 a voice memo upload starts only for the caller's own draft Intake, from complete server-measured metadata: invalid arguments, a caller without an active Client Profile, another client's Intake, and a submitted or closed Intake are refused with nothing written",
    () => {
      const before = count("resources");
      const auditBefore = count("audit_events", "resource_type = 'resource'");
      const outcomes = {
        bad_type: beginVoiceMemo(world.owner, world.ownerIntake, {
          mime: "audio/ogg",
        }).outcome,
        zero_bytes: beginVoiceMemo(world.owner, world.ownerIntake, { size: 0 })
          .outcome,
        over_ceiling: beginVoiceMemo(world.owner, world.ownerIntake, {
          size: 1000001,
        }).outcome,
        bad_digest: beginVoiceMemo(world.owner, world.ownerIntake, {
          digest: "sha256:xyz",
        }).outcome,
        zero_duration: beginVoiceMemo(world.owner, world.ownerIntake, {
          duration: 0,
        }).outcome,
        over_physical_ceiling: beginVoiceMemo(world.owner, world.ownerIntake, {
          duration: 61,
        }).outcome,
        staff_caller: beginVoiceMemo(world.verifier, world.ownerIntake).outcome,
        attorney_caller: beginVoiceMemo(world.attorney, world.ownerIntake)
          .outcome,
        other_client: beginVoiceMemo(world.otherClient, world.ownerIntake)
          .outcome,
        unknown_intake: beginVoiceMemo(world.owner, uid()).outcome,
        submitted: beginVoiceMemo(world.owner, world.submittedIntake).outcome,
        closed: beginVoiceMemo(world.owner, world.closedIntake).outcome,
      };
      assert.deepEqual(outcomes, {
        bad_type: "invalid",
        zero_bytes: "invalid",
        over_ceiling: "invalid",
        bad_digest: "invalid",
        zero_duration: "invalid",
        over_physical_ceiling: "invalid",
        staff_caller: "not_found",
        attorney_caller: "not_found",
        other_client: "not_found",
        unknown_intake: "not_found",
        submitted: "not_editable",
        closed: "not_editable",
      });
      assert.equal(
        as(
          "anon",
          null,
          `select * from public.resource_begin_voice_memo('${world.ownerIntake}', 'audio/webm', 1, '${digest()}', 1);`,
        ),
        "ERROR 42501",
      );
      assert.equal(count("resources"), before);
      assert.equal(
        count("audit_events", "resource_type = 'resource'"),
        auditBefore,
      );
      return outcomes;
    },
  );

  await check(
    "VM-2 start and completion: a pending resource at exactly resources/<id>/original in the private bucket with its voice memo record and audit event; only its owner completes it, once; one available memo per Intake; a failed upload is abandoned to rejected and never becomes available; at most ten attempts per Intake",
    () => {
      const intake = newIntake(world.owner);
      const d = digest();
      const started = beginVoiceMemo(world.owner, intake, {
        mime: "audio/mp4",
        size: 777,
        digest: d,
        duration: 9,
      });
      assert.equal(started.outcome, "created");
      assert.deepEqual(
        JSON.parse(
          sql(
            `select jsonb_build_object('kind', resource_kind, 'owner', owner_user_id, 'intake', intake_id, 'bucket', storage_bucket, 'path', storage_object_path, 'mime', mime_type, 'size', byte_size, 'digest', content_digest, 'visibility', visibility_state, 'retention', retention_state) from public.resources where id = '${started.id}';`,
          ),
        ),
        {
          kind: "voice_memo",
          owner: world.owner.user,
          intake,
          bucket: BUCKET,
          path: `resources/${started.id}/original`,
          mime: "audio/mp4",
          size: 777,
          digest: d,
          visibility: "pending",
          retention: "active",
        },
      );
      assert.equal(
        sql(
          `select intake_id || '|' || duration_seconds from public.voice_memos where resource_id = '${started.id}';`,
        ),
        `${intake}|9`,
      );
      const outcomes = {
        other_client_finalize: finalize(world.otherClient, started.id),
        staff_finalize: finalize(world.verifier, started.id),
        owner_finalize: finalize(world.owner, started.id),
        second_finalize: finalize(world.owner, started.id),
        abandon_available: abandon(world.owner, started.id),
        second_memo: beginVoiceMemo(world.owner, intake).outcome,
      };
      assert.deepEqual(outcomes, {
        other_client_finalize: "not_found",
        staff_finalize: "not_found",
        owner_finalize: "available",
        second_finalize: "not_pending",
        abandon_available: "not_pending",
        second_memo: "already_exists",
      });
      // Two attempts pending at once: only one can become available.
      const raceIntake = newIntake(world.owner);
      const first = beginVoiceMemo(world.owner, raceIntake);
      const second = beginVoiceMemo(world.owner, raceIntake);
      assert.equal(finalize(world.owner, first.id), "available");
      assert.equal(finalize(world.owner, second.id), "already_exists");
      assert.equal(abandon(world.owner, second.id), "rejected");
      assert.equal(finalize(world.owner, second.id), "not_pending");
      assert.equal(abandon(world.otherClient, first.id), "not_found");
      // The attempt bound.
      const busy = newIntake(world.owner);
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const pending = beginVoiceMemo(world.owner, busy);
        assert.equal(pending.outcome, "created", `attempt ${attempt}`);
        assert.equal(abandon(world.owner, pending.id), "rejected");
      }
      const eleventh = beginVoiceMemo(world.owner, busy).outcome;
      assert.equal(eleventh, "rate_limited");
      assert.deepEqual(
        auditOf(started.id).map((a) => [
          a.action_code,
          a.actor_type,
          a.actor_user_id,
        ]),
        [
          ["resource_upload_started", "client", world.owner.user],
          ["resource_upload_completed", "client", world.owner.user],
        ],
      );
      assert.deepEqual(
        auditOf(second.id).map((a) => a.action_code),
        ["resource_upload_started", "resource_upload_abandoned"],
      );
      return { ...outcomes, eleventh_attempt: eleventh };
    },
  );

  await check(
    "VM-3 the Intake survives decline and retry: a refused start, an abandoned upload, a completion refused because the Intake was submitted meanwhile, and a retried upload leave the Intake row and its revisions exactly as they were (no new row version)",
    () => {
      const intake = world.ownerIntake;
      const before = intakeSnapshot(intake);
      const refusedStart = beginVoiceMemo(world.owner, intake, {
        mime: "video/webm",
      }).outcome;
      const abandoned = beginVoiceMemo(world.owner, intake);
      assert.equal(abandon(world.owner, abandoned.id), "rejected");
      const retried = beginVoiceMemo(world.owner, intake);
      assert.equal(retried.outcome, "created");
      assert.equal(finalize(world.owner, retried.id), "available");
      const after = intakeSnapshot(intake);
      assert.equal(after, before);
      // A completion after the Intake left the draft state is refused, and
      // the resource is abandoned; the Intake keeps its state.
      const late = newIntake(world.owner);
      const pending = beginVoiceMemo(world.owner, late);
      sql(
        `update public.intakes set state = 'submitted' where id = '${late}';`,
      );
      const lateSnapshot = intakeSnapshot(late);
      const lateFinalize = finalize(world.owner, pending.id);
      assert.equal(lateFinalize, "not_editable");
      assert.equal(abandon(world.owner, pending.id), "rejected");
      assert.equal(intakeSnapshot(late), lateSnapshot);
      return {
        refused_start: refusedStart,
        abandoned: "rejected",
        retried: "available",
        late_completion: lateFinalize,
        intake_unchanged: true,
      };
    },
  );
}

async function authorizationChecks() {
  await check(
    "AUTH-1 voice memo access matrix: the owning client is authorized with the exact opaque path; another client, attorneys (even with an active grant), staff with any scope, anon, unknown ids and the wrong kind are refused alike; a non-attorney grant recipient is authorized only while the grant is active (not expired, revoked or future)",
    () => {
      const memo = availableVoiceMemo(world.owner);
      const path = `resources/${memo.id}/original`;
      const expiredRecipient = newClient();
      const revokedRecipient = newClient();
      const futureRecipient = newClient();
      grant(memo.id, world.recipient);
      grant(memo.id, world.attorney);
      grant(memo.id, expiredRecipient, {
        granted: "now() - interval '2 hours'",
        expires: "now() - interval '1 hour'",
      });
      grant(memo.id, revokedRecipient, {
        granted: "now() - interval '2 hours'",
        revoked: "now() - interval '1 minute'",
      });
      grant(memo.id, futureRecipient, {
        granted: "now() + interval '1 hour'",
      });
      const matrix = {
        owner: authorize(world.owner, memo.id),
        owner_aal1: authorize(world.owner, memo.id, "voice_memo", {
          aal: "aal1",
        }),
        other_client: authorize(world.otherClient, memo.id),
        attorney_with_grant: authorize(world.attorney, memo.id),
        attorney_applicant: authorize(world.applicant, memo.id),
        staff_global_scope: authorize(world.verifier, memo.id),
        staff_other_capability: authorize(world.intakeAdmin, memo.id),
        recipient_active_grant: authorize(world.recipient, memo.id),
        recipient_expired_grant: authorize(expiredRecipient, memo.id),
        recipient_revoked_grant: authorize(revokedRecipient, memo.id),
        recipient_future_grant: authorize(futureRecipient, memo.id),
        owner_wrong_kind: authorize(
          world.owner,
          memo.id,
          "verification_artifact",
        ),
        owner_unknown_kind: authorize(world.owner, memo.id, "document"),
        owner_unknown_id: authorize(world.owner, uid()),
        no_subject: authorize(null, memo.id),
        anon: as(
          "anon",
          null,
          `select outcome from public.resource_authorize_access('${memo.id}', 'voice_memo');`,
        ),
      };
      assert.deepEqual(matrix, {
        owner: `authorized|${path}`,
        owner_aal1: `authorized|${path}`,
        other_client: "refused|",
        attorney_with_grant: "refused|",
        attorney_applicant: "refused|",
        staff_global_scope: "refused|",
        staff_other_capability: "refused|",
        recipient_active_grant: `authorized|${path}`,
        recipient_expired_grant: "refused|",
        recipient_revoked_grant: "refused|",
        recipient_future_grant: "refused|",
        owner_wrong_kind: "refused|",
        owner_unknown_kind: "refused|",
        owner_unknown_id: "refused|",
        no_subject: "refused|",
        anon: "ERROR 42501",
      });
      // Revoking the active grant stops new authorizations at once.
      sql(
        `update public.resource_sharing_grants set revoked_at = now() where resource_id = '${memo.id}' and recipient_user_id = '${world.recipient.user}';`,
      );
      assert.equal(authorize(world.recipient, memo.id), "refused|");
      // Exactly one audit event per authorization, never for a refusal.
      const accesses = auditOf(memo.id).filter(
        (a) => a.action_code === "resource_access_authorized",
      );
      assert.deepEqual(
        accesses.map((a) => [a.actor_user_id, a.actor_type, a.after]),
        [
          [
            world.owner.user,
            "client",
            { resource_kind: "voice_memo", access: "signed_url" },
          ],
          [
            world.owner.user,
            "client",
            { resource_kind: "voice_memo", access: "signed_url" },
          ],
          [
            world.recipient.user,
            "client",
            { resource_kind: "voice_memo", access: "signed_url" },
          ],
        ],
      );
      return matrix;
    },
  );

  await check(
    "AUTH-2 visibility, retention and Legal Hold: a pending or rejected resource is not available even to its owner; an active hold on the resource or its Intake blocks every new authorization (failing closed); a released hold does not",
    () => {
      const pending = beginVoiceMemo(world.owner, newIntake(world.owner));
      const rejected = beginVoiceMemo(world.owner, newIntake(world.owner));
      assert.equal(abandon(world.owner, rejected.id), "rejected");
      const memo = availableVoiceMemo(world.owner);
      const results = {
        pending_owner: authorize(world.owner, pending.id),
        pending_other: authorize(world.otherClient, pending.id),
        rejected_owner: authorize(world.owner, rejected.id),
      };
      const resourceHold = hold(memo.id);
      results.held_owner = authorize(world.owner, memo.id);
      results.held_other = authorize(world.otherClient, memo.id);
      releaseHold(resourceHold);
      results.released_owner = authorize(world.owner, memo.id);
      const intakeHold = hold(memo.intake);
      results.intake_held_owner = authorize(world.owner, memo.id);
      releaseHold(intakeHold);
      assert.deepEqual(results, {
        pending_owner: "not_available|",
        pending_other: "refused|",
        rejected_owner: "not_available|",
        held_owner: "held|",
        held_other: "refused|",
        released_owner: `authorized|resources/${memo.id}/original`,
        intake_held_owner: "held|",
      });
      return results;
    },
  );

  await check(
    "AUTH-3 object-path guessing fails: authorization takes only a resource id and decides on the relational record and the caller's identity; knowing another client's id and exact path gives nothing; random and well-formed but unknown ids look the same as unauthorized ones; no API role can read the path column or any storage object through the database",
    () => {
      const memo = availableVoiceMemo(world.owner);
      const path = `resources/${memo.id}/original`;
      const answers = {
        other_client_with_id: authorize(world.otherClient, memo.id),
        other_client_random_id: authorize(world.otherClient, uid()),
        other_client_path_as_id: as(
          "authenticated",
          world.otherClient.auth,
          `select outcome from public.resource_authorize_access(${lit(path)}::uuid, 'voice_memo');`,
        ),
        other_client_metadata_rows: as(
          "authenticated",
          world.otherClient.auth,
          `select count(*) from public.resources where id = '${memo.id}';`,
        ),
        other_client_path_column: as(
          "authenticated",
          world.otherClient.auth,
          `select count(*) from public.resources where storage_object_path = ${lit(path)};`,
        ),
      };
      assert.deepEqual(answers, {
        other_client_with_id: "refused|",
        other_client_random_id: "refused|",
        other_client_path_as_id: "ERROR 22P02",
        other_client_metadata_rows: "0",
        other_client_path_column: "ERROR 42501",
      });
      // The function signature takes no path, bucket or caller identity.
      assert.equal(
        sql(
          "select pg_get_function_arguments('public.resource_authorize_access(uuid, text)'::regprocedure);",
        ),
        "p_resource_id uuid, p_resource_kind text",
      );
      return answers;
    },
  );

  await check(
    "META-1 metadata row policies: the owning client sees its own resource and voice memo rows; another client, an attorney holding an active grant on an Intake resource, and any grant recipient of a verification artifact see none; a non-attorney recipient of an active grant sees the shared row",
    () => {
      const memo = availableVoiceMemo(world.owner);
      grant(memo.id, world.attorney);
      const sharedRecipient = newClient();
      grant(memo.id, sharedRecipient);
      const artifact = attachedArtifact(world.scopedA, world.license);
      grant(artifact, world.recipient);
      const rows = (principal, table, column, id) =>
        as(
          "authenticated",
          principal.auth,
          `select count(*) from public.${table} where ${column} = '${id}';`,
        );
      const results = {
        owner_resource: rows(world.owner, "resources", "id", memo.id),
        owner_voice_memo: rows(
          world.owner,
          "voice_memos",
          "resource_id",
          memo.id,
        ),
        other_client: rows(world.otherClient, "resources", "id", memo.id),
        attorney_with_grant: rows(world.attorney, "resources", "id", memo.id),
        attorney_voice_memo: rows(
          world.attorney,
          "voice_memos",
          "resource_id",
          memo.id,
        ),
        recipient_with_grant: rows(sharedRecipient, "resources", "id", memo.id),
        artifact_grant_recipient: rows(
          world.recipient,
          "resources",
          "id",
          artifact,
        ),
        artifact_uploader: rows(world.scopedA, "resources", "id", artifact),
      };
      assert.deepEqual(results, {
        owner_resource: "1",
        owner_voice_memo: "1",
        other_client: "0",
        attorney_with_grant: "0",
        attorney_voice_memo: "0",
        recipient_with_grant: "1",
        artifact_grant_recipient: "0",
        artifact_uploader: "1",
      });
      return results;
    },
  );
}

async function artifactChecks() {
  await check(
    "ART-1 a verification artifact upload starts only for a stepped-up staff member holding the verification scope for the record's jurisdiction, who is not its attorney, while the profile is in a finding stage, from allowed server-checked metadata",
    () => {
      const outcomes = {
        global_scope: beginArtifact(world.verifier, world.license).outcome,
        scoped_same: beginArtifact(world.scopedA, world.license).outcome,
        scoped_other: beginArtifact(world.scopedB, world.license).outcome,
        other_capability: beginArtifact(world.intakeAdmin, world.license)
          .outcome,
        aal1: beginArtifact(world.verifier, world.license, {}, { aal: "aal1" })
          .outcome,
        claim_less: beginArtifact(
          world.verifier,
          world.license,
          {},
          {
            aal: null,
          },
        ).outcome,
        client: beginArtifact(world.owner, world.license).outcome,
        own_attorney_record: beginArtifact(world.selfStaff, world.selfLicense)
          .outcome,
        applicant_stage: beginArtifact(world.verifier, world.applicantLicense)
          .outcome,
        unknown_record: beginArtifact(world.verifier, uid()).outcome,
        audio_type: beginArtifact(world.verifier, world.license, {
          mime: "audio/webm",
        }).outcome,
        svg_type: beginArtifact(world.verifier, world.license, {
          mime: "image/svg+xml",
        }).outcome,
        over_ceiling: beginArtifact(world.verifier, world.license, {
          size: 1000001,
        }).outcome,
        unknown_kind: beginArtifact(world.verifier, world.license, {
          kind: "profile",
        }).outcome,
      };
      assert.deepEqual(outcomes, {
        global_scope: "created",
        scoped_same: "created",
        scoped_other: "denied",
        other_capability: "denied",
        aal1: "denied",
        claim_less: "denied",
        client: "denied",
        own_attorney_record: "denied",
        applicant_stage: "locked",
        unknown_record: "denied",
        audio_type: "invalid",
        svg_type: "invalid",
        over_ceiling: "invalid",
        unknown_kind: "invalid",
      });
      const started = beginArtifact(world.scopedA, world.license, {
        mime: "image/jpeg",
      });
      assert.deepEqual(
        auditOf(started.id).map((a) => [
          a.action_code,
          a.actor_type,
          a.actor_user_id,
          a.jurisdiction_id,
          a.after.subject_id,
        ]),
        [
          [
            "resource_upload_started",
            "staff",
            world.scopedA.user,
            world.jurisdiction,
            world.license,
          ],
        ],
      );
      return outcomes;
    },
  );

  await check(
    "ART-2 the evidence reference is validated by the database: a pending, foreign, voice memo, unknown or malformed reference is invalid; an available artifact of the recording reviewer attaches once; a second finding referring to it is a conflict; a reviewer who lost scope can no longer complete or attach",
    () => {
      const pending = beginArtifact(world.scopedA, world.license);
      const foreign = beginArtifact(world.verifier, world.license);
      assert.equal(finalize(world.verifier, foreign.id), "available");
      const memo = availableVoiceMemo(world.owner);
      const outcomes = {
        pending_reference: finding(
          world.scopedA,
          world.license,
          "uploaded_artifact",
          pending.id,
        ),
        foreign_reference: finding(
          world.scopedA,
          world.license,
          "uploaded_artifact",
          foreign.id,
        ),
        voice_memo_reference: finding(
          world.scopedA,
          world.license,
          "uploaded_artifact",
          memo.id,
        ),
        unknown_reference: finding(
          world.scopedA,
          world.license,
          "uploaded_artifact",
          uid(),
        ),
        malformed_reference: finding(
          world.scopedA,
          world.license,
          "uploaded_artifact",
          "resources/x/original",
        ),
      };
      assert.equal(finalize(world.scopedA, pending.id), "available");
      outcomes.available_reference = finding(
        world.scopedA,
        world.license,
        "uploaded_artifact",
        pending.id,
      );
      outcomes.second_reference = finding(
        world.scopedA,
        world.license,
        "uploaded_artifact",
        pending.id,
      );
      outcomes.ordinary_source = finding(
        world.scopedA,
        world.license,
        "licensing register",
        "SYN-S3-LIC-1 entry",
      );
      // A reviewer whose grant is revoked between upload and completion.
      const revocable = newStaff([
        {
          capability: "manage_attorney_verification",
          jurisdiction: world.jurisdiction,
        },
      ]);
      const late = beginArtifact(revocable, world.license);
      sql(
        `update public.capability_grants set revoked_at = now() where user_id = '${revocable.user}';`,
      );
      outcomes.finalize_after_revocation = finalize(revocable, late.id);
      outcomes.abandon_after_revocation = abandon(revocable, late.id);
      assert.deepEqual(outcomes, {
        pending_reference: "invalid",
        foreign_reference: "invalid",
        voice_memo_reference: "invalid",
        unknown_reference: "invalid",
        malformed_reference: "invalid",
        available_reference: "applied",
        second_reference: "conflict",
        ordinary_source: "applied",
        finalize_after_revocation: "denied",
        abandon_after_revocation: "rejected",
      });
      assert.equal(
        count(
          "verification_evidence",
          `source_type = 'uploaded_artifact' and source_reference = '${pending.id}'`,
        ),
        1,
      );
      // The reference cannot be rewritten even by the owner.
      assert.equal(
        refused(
          `update public.verification_evidence set source_reference = '${foreign.id}' where source_type = 'uploaded_artifact' and source_reference = '${pending.id}';`,
        ),
        "23514",
      );
      return outcomes;
    },
  );

  await check(
    "ART-3 verification artifact access: only stepped-up staff holding the verification scope for the referencing finding's jurisdiction; staff scoped elsewhere, without the capability, at aal1, the uploader after losing scope, the attorney concerned, clients and grant recipients are refused; an unattached artifact is disclosed to no one",
    () => {
      const uploader = newStaff([
        {
          capability: "manage_attorney_verification",
          jurisdiction: world.jurisdiction,
        },
      ]);
      const artifact = attachedArtifact(uploader, world.license);
      grant(artifact, world.recipient);
      grant(artifact, world.otherClient);
      const unattached = beginArtifact(world.verifier, world.license);
      assert.equal(finalize(world.verifier, unattached.id), "available");
      const kind = "verification_artifact";
      const path = `resources/${artifact}/original`;
      const matrix = {
        global_scope: authorize(world.verifier, artifact, kind),
        scoped_same: authorize(world.scopedA, artifact, kind),
        uploader: authorize(uploader, artifact, kind),
        scoped_other: authorize(world.scopedB, artifact, kind),
        other_capability: authorize(world.intakeAdmin, artifact, kind),
        global_scope_aal1: authorize(world.verifier, artifact, kind, {
          aal: "aal1",
        }),
        attorney_concerned: authorize(world.attorney, artifact, kind),
        client_grant_recipient: authorize(world.recipient, artifact, kind),
        client: authorize(world.owner, artifact, kind),
        wrong_kind: authorize(world.verifier, artifact, "voice_memo"),
        unattached_uploader: authorize(world.verifier, unattached.id, kind),
      };
      sql(
        `update public.capability_grants set revoked_at = now() where user_id = '${uploader.user}';`,
      );
      matrix.uploader_after_revocation = authorize(uploader, artifact, kind);
      assert.deepEqual(matrix, {
        global_scope: `authorized|${path}`,
        scoped_same: `authorized|${path}`,
        uploader: `authorized|${path}`,
        scoped_other: "refused|",
        other_capability: "refused|",
        global_scope_aal1: "refused|",
        attorney_concerned: "refused|",
        client_grant_recipient: "refused|",
        client: "refused|",
        wrong_kind: "refused|",
        unattached_uploader: "refused|",
        uploader_after_revocation: "refused|",
      });
      // A verification staff member who is also the attorney concerned.
      const selfArtifact = attachedArtifact(world.verifier, world.selfLicense);
      matrix.self_attorney_staff = authorize(
        world.selfStaff,
        selfArtifact,
        kind,
      );
      assert.equal(matrix.self_attorney_staff, "refused|");
      // Accesses are audited with the finding's jurisdiction.
      assert.deepEqual(
        auditOf(artifact)
          .filter((a) => a.action_code === "resource_access_authorized")
          .map((a) => [a.actor_type, a.jurisdiction_id]),
        [
          ["staff", world.jurisdiction],
          ["staff", world.jurisdiction],
          ["staff", world.jurisdiction],
        ],
      );
      return matrix;
    },
  );
}

async function storageChecks() {
  await check(
    "STO-1 with the storage relations present (synthetic stand-in): the private bucket is created not public, with the byte ceiling and the five content types only, and no storage policy; completion requires the object at the resource's exact path with its recorded size and type",
    () => {
      const db = STORAGE_DB;
      assert.deepEqual(
        report.migrations.storage_stand_in_notices[S3_MIGRATIONS[0]],
        [],
      );
      assert.equal(
        sql(
          "select id || '|' || name || '|' || public::text || '|' || file_size_limit || '|' || array_to_string(allowed_mime_types, ',') from storage.buckets;",
          db,
        ),
        `${BUCKET}|${BUCKET}|false|1000000|audio/webm,audio/mp4,application/pdf,image/png,image/jpeg`,
      );
      assert.equal(
        sql(
          "select count(*) from pg_policies where schemaname = 'storage';",
          db,
        ),
        "0",
      );
      const owner = world.storage.owner;
      const intake = world.storage.ownerIntake;
      const started = beginVoiceMemo(
        owner,
        intake,
        { size: 1234, mime: "audio/webm" },
        { db },
      );
      assert.equal(started.outcome, "created", started.answer);
      const path = `resources/${started.id}/original`;
      const outcomes = { missing_object: finalize(owner, started.id, { db }) };
      sql(
        `insert into storage.objects (bucket_id, name, metadata) values ('${BUCKET}', 'resources/${started.id}/other', '{"size": 1234, "mimetype": "audio/webm"}');`,
        db,
      );
      outcomes.object_at_other_path = finalize(owner, started.id, { db });
      sql(
        `insert into storage.objects (bucket_id, name, metadata) values ('${BUCKET}', '${path}', '{"size": 1233, "mimetype": "audio/webm"}');`,
        db,
      );
      outcomes.object_with_other_size = finalize(owner, started.id, { db });
      sql(
        `update storage.objects set metadata = '{"size": 1234, "mimetype": "audio/mp4"}' where name = '${path}';`,
        db,
      );
      outcomes.object_with_other_type = finalize(owner, started.id, { db });
      sql(
        `update storage.objects set metadata = '{"size": 1234, "mimetype": "audio/webm"}' where name = '${path}';`,
        db,
      );
      outcomes.exact_object = finalize(owner, started.id, { db });
      assert.deepEqual(outcomes, {
        missing_object: "not_stored",
        object_at_other_path: "not_stored",
        object_with_other_size: "not_stored",
        object_with_other_type: "not_stored",
        exact_object: "available",
      });
      assert.equal(
        as(
          "authenticated",
          owner.auth,
          "select count(*) from storage.objects;",
          { db },
        ),
        "ERROR 42501",
      );
      return outcomes;
    },
  );
}

async function auditChecks() {
  await check(
    "AUD-1 the audit trail is data-minimized and append-only: every resource event names the actor, kind and state, never an object path, bucket, digest or signed URL; resource audit events cannot be changed or removed",
    () => {
      const rows = JSON.parse(
        sql(
          "select coalesce(jsonb_agg(jsonb_build_object('action', action_code, 'before', before_snapshot, 'after', after_snapshot)), '[]'::jsonb) from public.audit_events where resource_type = 'resource';",
        ),
      );
      assert.ok(rows.length > 20);
      const actions = [...new Set(rows.map((r) => r.action))].sort();
      assert.deepEqual(actions, [
        "resource_access_authorized",
        "resource_upload_abandoned",
        "resource_upload_completed",
        "resource_upload_started",
      ]);
      for (const row of rows) {
        const text = JSON.stringify(row);
        assert.doesNotMatch(
          text,
          /resources\/|rosuno-private-resources|sha256:|token[=]|\/sign\//,
        );
      }
      assert.equal(
        refused(
          "update public.audit_events set action_code = 'x' where resource_type = 'resource';",
        ),
        "23514",
      );
      assert.equal(
        refused(
          "delete from public.audit_events where resource_type = 'resource';",
        ),
        "23514",
      );
      return { events: rows.length, actions };
    },
  );
}

// ---------------------------------------------------------------------------
// S3 part 2: Intake lifecycle, AI Suggestions, jurisdiction assessment review
// ---------------------------------------------------------------------------

const V2_MIGRATIONS = Object.freeze([
  "20261119040000_mvp_001_s3_intake_lifecycle.sql",
  "20261119050000_mvp_001_s3_ai_suggestions.sql",
  "20261119060000_mvp_001_s3_jurisdiction_assessment_review.sql",
  "20261119070000_mvp_001_s3_intake_lifecycle_correction.sql",
]);

// The P1 columns of every relation S3 part 2 relies on (Packet rule 16).
const V2_P1_COLUMNS = Object.freeze({
  intakes:
    "id,client_id,matter_reference,state,created_at,updated_at,expires_at,closed_at",
  ai_suggestions:
    "id,context_type,context_id,suggestion_type,suggestion_value,generated_at,model_reference,presented_at,confirmed_at,confirmed_by_user_id,rejected_at,created_at",
  jurisdiction_assessments:
    "id,intake_id,jurisdiction_id,assessment_basis,source_type,ai_suggestion_id,review_status,created_at,reviewed_at,reviewed_by_user_id",
  intake_revisions:
    "id,intake_id,revision_number,question_set_id,practice_area_id,description,structured_answers,created_at",
  intake_question_sets: "id,version_key,definition,published_at",
});

// Every S3 part 2 function: its EXECUTE role (null: no API role) and whether
// it is SECURITY DEFINER with search_path pg_catalog, pg_temp and a lock
// timeout ("definer"), a definer read with that search_path ("reader"), an
// internal invoker helper with that search_path ("helper"), or a replaced
// earlier function keeping its earlier settings exactly ("kept:<config>").
const V2_FUNCTIONS = Object.freeze([
  ["intake_lifecycle_guard()", null, "helper"],
  ["intake_expire_if_due(uuid)", null, "helper"],
  ["intake_expiry_sweep()", null, "helper-timeout"],
  ["client_request_intake_change(uuid, text)", "authenticated", "definer"],
  [
    "client_save_intake_revision(uuid, integer, uuid, uuid, text, jsonb)",
    "authenticated",
    "kept:search_path=pg_catalog",
  ],
  [
    "client_submit_intake(uuid, integer)",
    "authenticated",
    "kept:search_path=pg_catalog",
  ],
  ["client_close_intake(uuid)", "authenticated", "kept:search_path=pg_catalog"],
  [
    "resource_begin_voice_memo(uuid, text, bigint, text, integer)",
    "authenticated",
    "definer",
  ],
  ["resource_finalize_upload(uuid)", "authenticated", "definer"],
  ["ai_suggestion_value_problem(text, jsonb)", null, "helper"],
  ["ai_suggestion_integrity()", null, "helper"],
  [
    "ai_record_intake_suggestion(uuid, uuid, integer, text, jsonb, text, timestamp with time zone)",
    "service_role",
    "definer",
  ],
  ["client_confirm_ai_suggestion(uuid)", "authenticated", "definer"],
  ["client_reject_ai_suggestion(uuid)", "authenticated", "definer"],
  ["jurisdiction_assessment_integrity()", null, "helper"],
  [
    "staff_jurisdiction_review_intakes(text, integer, integer)",
    "authenticated",
    "reader",
  ],
  ["staff_jurisdiction_review_assessments(uuid)", "authenticated", "reader"],
  [
    "staff_review_jurisdiction_assessment(uuid, text)",
    "authenticated",
    "definer",
  ],
]);

const MODEL = "synthetic-model:1";
const v2 = {};

function seedV2() {
  v2.area = uid();
  v2.otherArea = uid();
  v2.inactiveArea = uid();
  sql(
    `insert into public.practice_areas (id, code, name, active) values
       ('${v2.area}', 'syn_s3v2_family', 'Synthetic family', true),
       ('${v2.otherArea}', 'syn_s3v2_housing', 'Synthetic housing', true),
       ('${v2.inactiveArea}', 'syn_s3v2_retired', 'Synthetic retired', false);`,
  );
  v2.globalReviewer = newStaff([{ capability: "manage_intake_configuration" }]);
  v2.scopedReviewerA = newStaff([
    {
      capability: "manage_intake_configuration",
      jurisdiction: world.jurisdiction,
    },
  ]);
  v2.otherStaff = newStaff([{ capability: "manage_policy_configuration" }]);
}

const ANSWERED = (jurisdictions, area) => ({
  court_case: "no",
  assistance_type: "understand_options",
  jurisdictions,
  ...(area === "not_sure" ? { practice_area: "not_sure" } : {}),
});

function createIntake(client) {
  const created = as(
    "authenticated",
    client.auth,
    "select outcome || '|' || coalesce(intake_id::text, '') from public.client_create_intake();",
  );
  const [outcome, intake] = created.split("|");
  assert.equal(outcome, "created", created);
  return intake;
}

function saveRevision(client, intake, expected, content, options = {}) {
  const area = content.area === "not_sure" ? null : (content.area ?? null);
  return as(
    "authenticated",
    client.auth,
    `select outcome || '|' || coalesce(revision_number::text, '') from public.client_save_intake_revision(${lit(intake)}::uuid, ${expected === null ? "null" : expected}::integer, '${world.questionSet}'::uuid, ${lit(area)}::uuid, ${lit(content.description ?? null)}, ${lit(content.answers)}::jsonb);`,
    options,
  );
}

// A new client with a draft Intake holding one complete revision, created
// through the client functions.
function draftThroughFunctions({
  jurisdictions = [world.jurisdiction],
  area = v2.area,
} = {}) {
  const client = newClient();
  const intake = createIntake(client);
  assert.equal(
    saveRevision(client, intake, null, {
      area,
      description: "Synthetic words of the client",
      answers: ANSWERED(jurisdictions, area),
    }),
    "saved|1",
  );
  return { client, intake };
}

function submitThroughFunctions(client, intake, expected = 1) {
  return as(
    "authenticated",
    client.auth,
    `select public.client_submit_intake(${lit(intake)}::uuid, ${expected}::integer);`,
  );
}

function closeThroughFunctions(client, intake) {
  return as(
    "authenticated",
    client.auth,
    `select public.client_close_intake(${lit(intake)}::uuid);`,
  );
}

function requestChange(principal, intake, change, options = {}) {
  return as(
    "authenticated",
    principal === null ? null : principal.auth,
    `select public.client_request_intake_change(${lit(intake)}::uuid, ${lit(change)});`,
    options,
  );
}

function intakeState(intake) {
  return sql(`select state from public.intakes where id = '${intake}';`);
}

// The owner role moves a submitted Intake to active, the only state that
// carries an expiry time (Domain Model lifecycle; 20261119070000). No
// application path does this yet.
function activate(intake) {
  sql(`update public.intakes set state = 'active' where id = '${intake}';`);
}

function expireNow(intake) {
  sql(
    `update public.intakes set expires_at = now() - interval '1 second' where id = '${intake}';`,
  );
}

function recordSuggestion(
  {
    user,
    intake,
    revision = 1,
    type = "practice_category",
    value,
    model = MODEL,
    generated = "now() - interval '2 seconds'",
  },
  role = "service_role",
) {
  return as(
    role,
    null,
    `select outcome || '|' || coalesce(suggestion_id::text, '') from public.ai_record_intake_suggestion(${lit(user)}::uuid, ${lit(intake)}::uuid, ${revision === null ? "null" : revision}::integer, ${lit(type)}, ${value === null ? "null" : lit(value)}::jsonb, ${lit(model)}, ${generated});`,
  );
}

function recorded(answer) {
  const [outcome, id] = answer.split("|");
  assert.equal(outcome, "recorded", answer);
  return id;
}

function decide(principal, kind, id, options = {}) {
  return as(
    "authenticated",
    principal === null ? null : principal.auth,
    `select public.client_${kind}_ai_suggestion(${lit(id)}::uuid);`,
    options,
  );
}

function review(principal, assessment, decision, options = {}) {
  return as(
    "authenticated",
    principal === null ? null : principal.auth,
    `select public.staff_review_jurisdiction_assessment(${lit(assessment)}::uuid, ${lit(decision)});`,
    options,
  );
}

function reviewQueue(principal, group, options = {}, bounds = [0, 101]) {
  const answer = as(
    "authenticated",
    principal === null ? null : principal.auth,
    `select coalesce(json_agg(json_build_object('intake', q.intake_id, 'state', q.intake_state, 'candidates', q.candidate_count, 'unreviewed', q.unreviewed_count) order by q.intake_created_at, q.intake_id), '[]')::text from public.staff_jurisdiction_review_intakes(${lit(group)}, ${bounds[0]}, ${bounds[1]}) as q;`,
    options,
  );
  return answer.startsWith("ERROR") ? answer : JSON.parse(answer);
}

function reviewAssessments(principal, intake, options = {}) {
  const answer = as(
    "authenticated",
    principal === null ? null : principal.auth,
    `select coalesce(json_agg(row_to_json(a) order by a.created_at, a.assessment_id), '[]')::text from public.staff_jurisdiction_review_assessments(${lit(intake)}::uuid) as a;`,
    options,
  );
  return answer.startsWith("ERROR") ? answer : JSON.parse(answer);
}

// The assessments of an Intake, in the order of the jurisdiction list of
// the world (several written by one statement share their creation time).
function assessmentsOf(intake) {
  return JSON.parse(
    sql(
      `select coalesce(json_agg(json_build_object('id', id, 'j', jurisdiction_id, 'source', source_type, 'ai', ai_suggestion_id, 'review', review_status, 'basis', assessment_basis, 'reviewed_at', reviewed_at, 'reviewed_by', reviewed_by_user_id) order by (jurisdiction_id = '${world.jurisdiction}') desc, created_at, id), '[]')::text from public.jurisdiction_assessments where intake_id = '${intake}';`,
    ),
  );
}

function suggestionOf(id) {
  return JSON.parse(
    sql(
      `select row_to_json(s)::text from public.ai_suggestions as s where s.id = '${id}';`,
    ),
  );
}

// An md5 of every row of every public relation, by relation name.
function relationDigests() {
  return JSON.parse(
    sql(
      `select json_object_agg(c.relname, (xpath('/row/d/text()', query_to_xml(format('select md5(coalesce(string_agg(to_jsonb(x)::text, ''|'' order by to_jsonb(x)::text), '''')) as d from public.%I as x', c.relname), false, true, '')))[1]::text)::text
       from pg_class as c
       where c.relnamespace = 'public'::regnamespace and c.relkind = 'r';`,
    ),
  );
}

function changedRelations(before, after) {
  return Object.keys(after)
    .filter((name) => before[name] !== after[name])
    .sort();
}

async function v2MigrationChecks() {
  await check(
    "V2-MIG-1 the four S3 part 2 migrations follow the S3 part 1 migrations, in order, registered unreviewed (sequences 28 to 31) and applied nowhere; they add no relation, column, row policy, type, capability or policy type, and the columns of every relation they use are the P1 columns",
    () => {
      const files = migrationFiles();
      const at = files.indexOf(S3_MIGRATIONS[S3_MIGRATIONS.length - 1]);
      assert.deepEqual(files.slice(at + 1, at + 1 + V2_MIGRATIONS.length), [
        ...V2_MIGRATIONS,
      ]);
      const registered = JSON.parse(
        fs.readFileSync(
          path.join(
            REPOSITORY_ROOT,
            "governance/migrations/reviewed-migrations.json",
          ),
          "utf8",
        ),
      ).migrations;
      V2_MIGRATIONS.forEach((file, index) => {
        const row = registered.find(
          (m) => m.artifact_path === `supabase/migrations/${file}`,
        );
        assert.ok(row, file);
        assert.equal(row.sequence, 28 + index);
        assert.equal(row.reviewed, false);
        assert.equal(row.applied_environment, "none");
      });
      for (const file of V2_MIGRATIONS) {
        const text = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
        assert.doesNotMatch(
          text,
          /\bcreate\s+(table|type|policy|view|materialized|sequence|schema)\b|\badd\s+column\b|\binsert\s+into\s+public\.(capability_definitions|policy_types|policy_versions|intake_question_sets|practice_areas|jurisdictions|capability_grants)\b/i,
          file,
        );
      }
      for (const [table, columns] of Object.entries(V2_P1_COLUMNS)) {
        assert.equal(
          sql(
            `select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = '${table}';`,
          ),
          columns,
          table,
        );
      }
      assert.equal(
        sql(
          "select to_regnamespace('cron') is null and not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron');",
        ),
        "t",
      );
      return { migrations: [...V2_MIGRATIONS], scheduler: "absent" };
    },
  );

  await check(
    "V2-PRIV-1 function inventory: each S3 part 2 function is executable only by its one API role (service_role for the AI recording function, authenticated for the client and staff functions, none for helpers and guards); definers use search_path pg_catalog, pg_temp and a lock timeout, reads that search_path, and replaced functions keep their earlier settings exactly",
    () => {
      const settings = {};
      for (const [signature, role, kind] of V2_FUNCTIONS) {
        for (const api of ["anon", "authenticated", "service_role"]) {
          assert.equal(
            sql(
              `select has_function_privilege('${api}', 'public.${signature}', 'EXECUTE');`,
            ),
            api === role ? "t" : "f",
            `${api} ${signature}`,
          );
        }
        const actual = sql(
          `select prosecdef::text || '|' || coalesce(array_to_string(proconfig, ';'), '') || '|' || pg_get_userbyid(proowner) from pg_proc where oid = 'public.${signature}'::regprocedure;`,
        );
        const expected =
          {
            definer: "true|search_path=pg_catalog, pg_temp;lock_timeout=3s",
            reader: "true|search_path=pg_catalog, pg_temp",
            helper: "false|search_path=pg_catalog, pg_temp",
            "helper-timeout":
              "false|search_path=pg_catalog, pg_temp;lock_timeout=3s",
          }[kind] ?? `true|${kind.slice("kept:".length)}`;
        assert.equal(actual, `${expected}|postgres`, signature);
        settings[signature] = actual;
      }
      return settings;
    },
  );

  await check(
    "V2-PRIV-2 table privileges: service_role holds no privilege at all on ai_suggestions (the P1 SELECT, INSERT and column UPDATE grants are gone) and no write on intakes or jurisdiction_assessments; authenticated keeps only SELECT under the own-row policies; anon holds nothing; direct writes fail with 42501",
    () => {
      for (const table of [
        "ai_suggestions",
        "intakes",
        "jurisdiction_assessments",
      ]) {
        for (const role of ["anon", "authenticated", "service_role"]) {
          for (const privilege of [
            "INSERT",
            "UPDATE",
            "DELETE",
            "TRUNCATE",
            "REFERENCES",
            "TRIGGER",
          ]) {
            const columnLevel = ["INSERT", "UPDATE", "REFERENCES"].includes(
              privilege,
            )
              ? ` or has_any_column_privilege('${role}', 'public.${table}', '${privilege}')`
              : "";
            assert.equal(
              sql(
                `select has_table_privilege('${role}', 'public.${table}', '${privilege}')${columnLevel};`,
              ),
              "f",
              `${role} ${privilege} ${table}`,
            );
          }
        }
        assert.equal(
          sql(
            `select has_table_privilege('anon', 'public.${table}', 'SELECT');`,
          ),
          "f",
        );
        assert.equal(
          sql(
            `select has_table_privilege('authenticated', 'public.${table}', 'SELECT');`,
          ),
          "t",
        );
      }
      assert.equal(
        sql(
          "select has_table_privilege('service_role', 'public.ai_suggestions', 'SELECT') or has_any_column_privilege('service_role', 'public.ai_suggestions', 'SELECT');",
        ),
        "f",
      );
      const intake = newIntake(world.owner);
      const statements = {
        service_insert: `insert into public.ai_suggestions (context_type, context_id, suggestion_type, suggestion_value, generated_at, model_reference, presented_at) values ('intake', '${intake}', 'practice_category', '{}', now(), 'x', now());`,
        service_read: "select count(*) from public.ai_suggestions;",
        service_update_intake: `update public.intakes set expires_at = now() where id = '${intake}';`,
      };
      const outcomes = {};
      for (const [name, statement] of Object.entries(statements)) {
        outcomes[name] = as("service_role", null, statement);
        assert.equal(outcomes[name], "ERROR 42501", name);
      }
      outcomes.authenticated_update_suggestion = as(
        "authenticated",
        world.owner.auth,
        "update public.ai_suggestions set rejected_at = now();",
      );
      assert.equal(outcomes.authenticated_update_suggestion, "ERROR 42501");
      return outcomes;
    },
  );
}

async function v2LifecycleChecks() {
  await check(
    "V2-LC-1 lifecycle integrity for every role including the owner: an Intake is never deleted or truncated, keeps its identity, client and creation time, moves only along the locked Domain Model lifecycle draft -> submitted | closed, submitted -> active | closed, active -> closed | expired | superseded (a draft or submitted Intake never expires and is never superseded), never leaves expired, superseded or closed, carries closed_at exactly when closed, carries an expiry time only once active, and fixes expires_at once ended",
    () => {
      const draft = newIntake(world.owner);
      const submitted = newIntake(world.owner, "submitted");
      const active = newIntake(world.owner, "active");
      const closed = newIntake(world.owner, "closed");
      const expired = newIntake(world.owner, "expired");
      const superseded = newIntake(world.owner, "superseded");
      const refusedOutcomes = {
        delete: refused(`delete from public.intakes where id = '${draft}';`),
        truncate: refused("truncate public.intakes cascade;"),
        client_change: refused(
          `update public.intakes set client_id = '${world.otherClient.client}' where id = '${draft}';`,
        ),
        created_at_change: refused(
          `update public.intakes set created_at = now() - interval '1 day' where id = '${draft}';`,
        ),
        draft_to_active: refused(
          `update public.intakes set state = 'active' where id = '${draft}';`,
        ),
        draft_to_superseded: refused(
          `update public.intakes set state = 'superseded' where id = '${draft}';`,
        ),
        draft_to_expired: refused(
          `update public.intakes set state = 'expired' where id = '${draft}';`,
        ),
        submitted_to_expired: refused(
          `update public.intakes set state = 'expired' where id = '${submitted}';`,
        ),
        submitted_to_superseded: refused(
          `update public.intakes set state = 'superseded' where id = '${submitted}';`,
        ),
        expiry_on_draft: refused(
          `update public.intakes set expires_at = now() + interval '1 day' where id = '${draft}';`,
        ),
        expiry_on_submitted: refused(
          `update public.intakes set expires_at = now() + interval '1 day' where id = '${submitted}';`,
        ),
        submitted_to_draft: refused(
          `update public.intakes set state = 'draft' where id = '${submitted}';`,
        ),
        active_to_submitted: refused(
          `update public.intakes set state = 'submitted' where id = '${active}';`,
        ),
        closed_to_draft: refused(
          `update public.intakes set state = 'draft', closed_at = null where id = '${closed}';`,
        ),
        expired_to_active: refused(
          `update public.intakes set state = 'active' where id = '${expired}';`,
        ),
        superseded_to_active: refused(
          `update public.intakes set state = 'active' where id = '${superseded}';`,
        ),
        closed_without_time: refused(
          `update public.intakes set state = 'closed' where id = '${draft}';`,
        ),
        time_without_closed: refused(
          `update public.intakes set closed_at = now() where id = '${draft}';`,
        ),
        closing_time_change: refused(
          `update public.intakes set closed_at = now() - interval '1 day' where id = '${closed}';`,
        ),
        expiry_after_end: refused(
          `update public.intakes set expires_at = now() where id = '${closed}';`,
        ),
      };
      for (const [name, code] of Object.entries(refusedOutcomes)) {
        assert.ok(["55000", "23514"].includes(code), `${name}: ${code}`);
      }
      assert.equal(refusedOutcomes.delete, "55000");
      assert.equal(refusedOutcomes.truncate, "55000");
      assert.equal(refusedOutcomes.closed_without_time, "23514");
      for (const name of [
        "draft_to_expired",
        "submitted_to_expired",
        "submitted_to_superseded",
      ]) {
        assert.equal(refusedOutcomes[name], "55000", name);
      }
      assert.equal(refusedOutcomes.expiry_on_draft, "23514");
      assert.equal(refusedOutcomes.expiry_on_submitted, "23514");
      for (const statement of [
        `update public.intakes set state = 'submitted' where id = '${draft}';`,
        `update public.intakes set state = 'closed', closed_at = now() where id = '${draft}';`,
        `update public.intakes set state = 'active' where id = '${submitted}';`,
        `update public.intakes set state = 'closed', closed_at = now() where id = '${submitted}';`,
        `update public.intakes set state = 'expired' where id = '${active}';`,
        `update public.intakes set state = 'superseded' where id = '${active}';`,
        `update public.intakes set state = 'closed', closed_at = now() where id = '${active}';`,
        `update public.intakes set expires_at = now() + interval '1 day' where id = '${active}';`,
      ]) {
        acceptedThenRolledBack(statement);
      }
      return refusedOutcomes;
    },
  );

  await check(
    "V2-LC-2 expiry is keyed on expires_at alone and evaluated by every command itself, with no scheduler in this database: only an active Intake carries an expiry time (20261119070000); with its expires_at set in the past by the owner role, the save, submit, close, voice memo and change commands move the active Intake to expired once (one system audit event), answer exactly as for an Intake already expired, and leave every revision as it was; expires_at in the future changes nothing",
    () => {
      const outcomes = {};
      const run = (name, command) => {
        const { client, intake } = draftThroughFunctions();
        assert.equal(submitThroughFunctions(client, intake), "submitted");
        activate(intake);
        const revisions = sql(
          `select string_agg(to_jsonb(r)::text, '|' order by r.revision_number) from public.intake_revisions as r where r.intake_id = '${intake}';`,
        );
        expireNow(intake);
        outcomes[name] = command(client, intake);
        assert.equal(intakeState(intake), "expired", name);
        assert.equal(
          sql(
            `select string_agg(to_jsonb(r)::text, '|' order by r.revision_number) from public.intake_revisions as r where r.intake_id = '${intake}';`,
          ),
          revisions,
          name,
        );
        assert.equal(
          sql(
            `select string_agg(actor_type || ':' || coalesce(actor_user_id::text, '') || ':' || action_code || ':' || (before_snapshot ->> 'state') || ':' || (after_snapshot ->> 'state') || ':' || reason_code, ',') from public.audit_events where resource_type = 'intake' and resource_id = '${intake}' and action_code = 'intake_expired';`,
          ),
          "system::intake_expired:active:expired:expires_at_reached",
          name,
        );
        // A second command finds it expired and writes nothing more.
        outcomes[`${name}_again`] = command(client, intake);
        assert.equal(
          count(
            "audit_events",
            `resource_id = '${intake}' and action_code = 'intake_expired'`,
          ),
          1,
        );
        return { client, intake };
      };
      run("save", (client, intake) =>
        saveRevision(client, intake, 1, {
          area: v2.area,
          answers: ANSWERED([world.otherJurisdiction]),
        }),
      );
      run("submit", (client, intake) => submitThroughFunctions(client, intake));
      run("close", (client, intake) => closeThroughFunctions(client, intake));
      run(
        "voice_memo",
        (client, intake) => beginVoiceMemo(client, intake).outcome,
      );
      run("change_revise", (client, intake) =>
        requestChange(client, intake, "revise"),
      );
      assert.deepEqual(outcomes, {
        save: "not_editable|",
        save_again: "not_editable|",
        submit: "not_editable",
        submit_again: "not_editable",
        close: "unavailable",
        close_again: "unavailable",
        voice_memo: "not_editable",
        voice_memo_again: "not_editable",
        change_revise: "expired",
        change_revise_again: "expired",
      });
      // A returning client's confirmation of an Intake that has just expired.
      const { client, intake } = draftThroughFunctions();
      assert.equal(submitThroughFunctions(client, intake), "submitted");
      activate(intake);
      expireNow(intake);
      outcomes.active_resume = requestChange(client, intake, "resume");
      assert.equal(outcomes.active_resume, "not_configured");
      assert.equal(intakeState(intake), "expired");
      // A future expiry changes nothing.
      const future = draftThroughFunctions();
      assert.equal(
        submitThroughFunctions(future.client, future.intake),
        "submitted",
      );
      activate(future.intake);
      sql(
        `update public.intakes set expires_at = now() + interval '1 day' where id = '${future.intake}';`,
      );
      outcomes.future_revise = requestChange(
        future.client,
        future.intake,
        "revise",
      );
      assert.equal(outcomes.future_revise, "not_configured");
      assert.equal(intakeState(future.intake), "active");
      assert.equal(
        count(
          "audit_events",
          `resource_id = '${future.intake}' and action_code = 'intake_expired'`,
        ),
        0,
      );
      return outcomes;
    },
  );

  await check(
    "V2-LC-3 the database-only sweep expires every due active Intake once (skip-locked, bounded), leaves not-due, unset, draft, submitted and ended Intakes as they are, and is idempotent; no API role may run it",
    () => {
      const due = [
        newIntake(world.owner, "active"),
        newIntake(world.owner, "active"),
      ];
      const notDue = newIntake(world.owner, "active");
      const unset = newIntake(world.owner);
      const unsetSubmitted = newIntake(world.owner, "submitted");
      const unsetActive = newIntake(world.owner, "active");
      for (const intake of due) {
        expireNow(intake);
      }
      sql(
        `update public.intakes set expires_at = now() + interval '1 hour' where id = '${notDue}';`,
      );
      const first = JSON.parse(
        sql("select public.intake_expiry_sweep()::text;"),
      );
      assert.ok(first.expired >= 2);
      for (const intake of due) {
        assert.equal(intakeState(intake), "expired");
      }
      assert.equal(intakeState(notDue), "active");
      assert.equal(intakeState(unset), "draft");
      assert.equal(intakeState(unsetSubmitted), "submitted");
      assert.equal(intakeState(unsetActive), "active");
      const second = JSON.parse(
        sql("select public.intake_expiry_sweep()::text;"),
      );
      assert.equal(second.expired, 0);
      const api = {};
      for (const role of ["anon", "authenticated", "service_role"]) {
        api[role] = as(role, null, "select public.intake_expiry_sweep();");
        assert.equal(api[role], "ERROR 42501");
      }
      return { first, second, api };
    },
  );

  await check(
    "V2-LC-4 post-submission changes are refused with the fixed outcome not_configured until gate D-3 is configured: a revision or replacement of a submitted or active Intake, and a returning client's confirmation of an expired one; other states are not applicable; other principals see not_found; nothing is written; no application path sets expires_at",
    () => {
      const { client, intake } = draftThroughFunctions();
      const draftOutcomes = {
        draft_revise: requestChange(client, intake, "revise"),
        draft_replace: requestChange(client, intake, "replace"),
        draft_resume: requestChange(client, intake, "resume"),
      };
      assert.equal(submitThroughFunctions(client, intake), "submitted");
      const before = intakeSnapshot(intake);
      const outcomes = {
        ...draftOutcomes,
        submitted_revise: requestChange(client, intake, "revise"),
        submitted_replace: requestChange(client, intake, "replace"),
        submitted_resume: requestChange(client, intake, "resume"),
        invalid_change: requestChange(client, intake, "supersede"),
        null_change: requestChange(client, intake, null),
        other_client: requestChange(world.otherClient, intake, "revise"),
        staff: requestChange(v2.globalReviewer, intake, "revise"),
        attorney: requestChange(world.attorney, intake, "revise"),
        no_subject: requestChange(null, intake, "revise"),
        unknown_intake: requestChange(client, uid(), "revise"),
        anon: as(
          "anon",
          null,
          `select public.client_request_intake_change('${intake}'::uuid, 'revise');`,
        ),
      };
      assert.equal(intakeSnapshot(intake), before);
      const active = newIntake(client, "active");
      outcomes.active_revise = requestChange(client, active, "revise");
      const closed = newIntake(client, "closed");
      outcomes.closed_revise = requestChange(client, closed, "revise");
      outcomes.closed_resume = requestChange(client, closed, "resume");
      const expired = newIntake(client, "expired");
      outcomes.expired_resume = requestChange(client, expired, "resume");
      outcomes.expired_replace = requestChange(client, expired, "replace");
      assert.deepEqual(outcomes, {
        draft_revise: "not_applicable",
        draft_replace: "not_applicable",
        draft_resume: "not_applicable",
        submitted_revise: "not_configured",
        submitted_replace: "not_configured",
        submitted_resume: "not_applicable",
        invalid_change: "invalid",
        null_change: "invalid",
        other_client: "not_found",
        staff: "not_found",
        attorney: "not_found",
        no_subject: "not_found",
        unknown_intake: "not_found",
        anon: "ERROR 42501",
        active_revise: "not_configured",
        closed_revise: "not_applicable",
        closed_resume: "not_applicable",
        expired_resume: "not_configured",
        expired_replace: "expired",
      });
      assert.equal(intakeState(intake), "submitted");
      // The ordinary save still refuses a submitted Intake, as before.
      assert.equal(
        saveRevision(client, intake, 1, {
          area: v2.area,
          answers: ANSWERED([world.jurisdiction]),
        }),
        "not_editable|",
      );
      // No function sets expires_at: every Intake the client functions
      // created and moved through its lifecycle has none.
      const lived = draftThroughFunctions();
      assert.equal(
        submitThroughFunctions(lived.client, lived.intake),
        "submitted",
      );
      assert.equal(closeThroughFunctions(lived.client, lived.intake), "closed");
      assert.equal(
        sql(
          `select expires_at is null and closed_at is not null from public.intakes where id = '${lived.intake}';`,
        ),
        "t",
      );
      assert.equal(
        sql(
          "select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosrc ~* 'expires_at\\s*(:=|=\\s*(now|statement_timestamp|clock_timestamp|current_timestamp|\\(|''|[0-9]))' and prosrc ~* 'intakes';",
        ),
        "0",
      );
      return outcomes;
    },
  );
}

async function v2AiChecks() {
  await check(
    "V2-AI-1 presented-only persistence through the service_role function: a valid suggestion for the verified client's own current draft is recorded with generated_at, presented_at (not before generated_at), its model reference and the revision it came from, with one system audit event naming the model and requester and never the suggested value; nothing is stored for any refused call",
    () => {
      const { client, intake } = draftThroughFunctions();
      const before = count("ai_suggestions");
      const id = recorded(
        recordSuggestion({
          user: client.user,
          intake,
          value: { practice_area_id: v2.area },
        }),
      );
      const row = suggestionOf(id);
      assert.equal(row.context_type, "intake");
      assert.equal(row.context_id, intake);
      assert.equal(row.suggestion_type, "practice_category");
      assert.deepEqual(row.suggestion_value, {
        practice_area_id: v2.area,
        revision_number: 1,
      });
      assert.equal(row.model_reference, MODEL);
      assert.ok(row.generated_at !== null && row.presented_at !== null);
      assert.ok(Date.parse(row.presented_at) >= Date.parse(row.generated_at));
      assert.equal(row.confirmed_at, null);
      assert.equal(row.rejected_at, null);
      assert.equal(count("ai_suggestions"), before + 1);
      const audit = JSON.parse(
        sql(
          `select json_agg(json_build_object('actor', actor_user_id, 'type', actor_type, 'action', action_code, 'after', after_snapshot))::text from public.audit_events where resource_type = 'ai_suggestion' and resource_id = '${id}';`,
        ),
      );
      assert.equal(audit.length, 1);
      assert.equal(audit[0].actor, null);
      assert.equal(audit[0].type, "system");
      assert.equal(audit[0].action, "ai_suggestion_presented");
      assert.equal(audit[0].after.model_reference, MODEL);
      assert.equal(audit[0].after.requested_by_user_id, client.user);
      assert.equal(audit[0].after.revision_number, 1);
      assert.match(audit[0].after.value_sha256, /^[0-9a-f]{64}$/);
      assert.doesNotMatch(JSON.stringify(audit), new RegExp(v2.area));
      // A jurisdictions suggestion of two distinct known jurisdictions.
      const jurisdictions = recorded(
        recordSuggestion({
          user: client.user,
          intake,
          type: "potentially_relevant_jurisdictions",
          value: {
            jurisdiction_ids: [world.jurisdiction, world.otherJurisdiction],
          },
        }),
      );
      // Refused calls, each storing nothing.
      const submitted = draftThroughFunctions();
      assert.equal(
        submitThroughFunctions(submitted.client, submitted.intake),
        "submitted",
      );
      // Only an active Intake carries an expiry time (20261119070000): this one
      // was submitted, activated and is past its expires_at.
      const expiring = draftThroughFunctions();
      assert.equal(
        submitThroughFunctions(expiring.client, expiring.intake),
        "submitted",
      );
      activate(expiring.intake);
      expireNow(expiring.intake);
      const suspended = draftThroughFunctions();
      sql(
        `update public.users set account_state = 'suspended' where id = '${suspended.client.user}';`,
      );
      const profileLess = newAccount();
      const base = {
        user: client.user,
        intake,
        value: { practice_area_id: v2.area },
      };
      const stored = count("ai_suggestions");
      const outcomes = {
        unknown_type: recordSuggestion({ ...base, type: "best_attorney" }),
        value_with_extra_key: recordSuggestion({
          ...base,
          value: { practice_area_id: v2.area, rank: 1 },
        }),
        value_with_revision: recordSuggestion({
          ...base,
          value: { practice_area_id: v2.area, revision_number: 1 },
        }),
        malformed_id: recordSuggestion({
          ...base,
          value: { practice_area_id: "family" },
        }),
        inactive_area: recordSuggestion({
          ...base,
          value: { practice_area_id: v2.inactiveArea },
        }),
        unknown_area: recordSuggestion({
          ...base,
          value: { practice_area_id: uid() },
        }),
        unknown_jurisdiction: recordSuggestion({
          ...base,
          type: "potentially_relevant_jurisdictions",
          value: { jurisdiction_ids: [uid()] },
        }),
        duplicate_jurisdictions: recordSuggestion({
          ...base,
          type: "potentially_relevant_jurisdictions",
          value: { jurisdiction_ids: [world.jurisdiction, world.jurisdiction] },
        }),
        eleven_jurisdictions: recordSuggestion({
          ...base,
          type: "potentially_relevant_jurisdictions",
          value: { jurisdiction_ids: Array.from({ length: 11 }, () => uid()) },
        }),
        empty_jurisdictions: recordSuggestion({
          ...base,
          type: "potentially_relevant_jurisdictions",
          value: { jurisdiction_ids: [] },
        }),
        null_value: recordSuggestion({ ...base, value: null }),
        bad_model: recordSuggestion({ ...base, model: "not a model ref" }),
        null_model: recordSuggestion({ ...base, model: null }),
        future_generation: recordSuggestion({
          ...base,
          generated: "now() + interval '2 minutes'",
        }),
        stale_generation: recordSuggestion({
          ...base,
          generated: "now() - interval '11 minutes'",
        }),
        null_revision: recordSuggestion({ ...base, revision: null }),
        other_client_intake: recordSuggestion({
          ...base,
          user: world.otherClient.user,
        }),
        unknown_intake: recordSuggestion({ ...base, intake: uid() }),
        unknown_user: recordSuggestion({ ...base, user: uid() }),
        suspended_user: recordSuggestion({
          ...base,
          user: suspended.client.user,
          intake: suspended.intake,
        }),
        user_without_client_profile: recordSuggestion({
          ...base,
          user: profileLess.user,
        }),
        submitted_intake: recordSuggestion({
          ...base,
          user: submitted.client.user,
          intake: submitted.intake,
        }),
        expired_by_time: recordSuggestion({
          ...base,
          user: expiring.client.user,
          intake: expiring.intake,
        }),
        stale_revision: recordSuggestion({ ...base, revision: 2 }),
        authenticated_caller: recordSuggestion(base, "authenticated"),
        anon_caller: recordSuggestion(base, "anon"),
      };
      assert.deepEqual(outcomes, {
        unknown_type: "invalid|",
        value_with_extra_key: "invalid|",
        value_with_revision: "invalid|",
        malformed_id: "invalid|",
        inactive_area: "invalid|",
        unknown_area: "invalid|",
        unknown_jurisdiction: "invalid|",
        duplicate_jurisdictions: "invalid|",
        eleven_jurisdictions: "invalid|",
        empty_jurisdictions: "invalid|",
        null_value: "invalid|",
        bad_model: "invalid|",
        null_model: "invalid|",
        future_generation: "invalid|",
        stale_generation: "invalid|",
        null_revision: "invalid|",
        other_client_intake: "not_found|",
        unknown_intake: "not_found|",
        unknown_user: "not_found|",
        suspended_user: "not_found|",
        user_without_client_profile: "not_found|",
        submitted_intake: "not_editable|",
        expired_by_time: "not_editable|",
        stale_revision: "stale|",
        authenticated_caller: "ERROR 42501",
        anon_caller: "ERROR 42501",
      });
      assert.equal(count("ai_suggestions"), stored);
      // The AI function never writes the Intake, even when it is past its
      // expiry: the Intake is still active.
      assert.equal(intakeState(expiring.intake), "active");
      // A suggestion that was not presented cannot be stored at all, even by
      // the owner role; nor can any other context.
      outcomes.owner_unpresented = refused(
        `insert into public.ai_suggestions (context_type, context_id, suggestion_type, suggestion_value, generated_at, model_reference) values ('intake', '${intake}', 'practice_category', '{"practice_area_id": "${v2.area}", "revision_number": 1}', now(), '${MODEL}');`,
      );
      outcomes.owner_other_context = refused(
        `insert into public.ai_suggestions (context_type, context_id, suggestion_type, suggestion_value, generated_at, model_reference, presented_at) values ('jurisdiction_assessment', '${uid()}', 'practice_category', '{"practice_area_id": "${v2.area}", "revision_number": 1}', now(), '${MODEL}', now());`,
      );
      outcomes.owner_without_model = refused(
        `insert into public.ai_suggestions (context_type, context_id, suggestion_type, suggestion_value, generated_at, presented_at) values ('intake', '${intake}', 'practice_category', '{"practice_area_id": "${v2.area}", "revision_number": 1}', now(), now());`,
      );
      for (const name of [
        "owner_unpresented",
        "owner_other_context",
        "owner_without_model",
      ]) {
        assert.equal(outcomes[name], "23514", name);
      }
      // The fixed abuse bound: at most 50 suggestions per Intake.
      const bounded = draftThroughFunctions();
      for (let index = 0; index < 50; index += 1) {
        recorded(
          recordSuggestion({
            user: bounded.client.user,
            intake: bounded.intake,
            value: { practice_area_id: v2.area },
          }),
        );
      }
      outcomes.fifty_first = recordSuggestion({
        user: bounded.client.user,
        intake: bounded.intake,
        value: { practice_area_id: v2.area },
      });
      assert.equal(outcomes.fifty_first, "rate_limited|");
      v2.presented = { client, intake, practice: id, jurisdictions };
      return outcomes;
    },
  );

  await check(
    "V2-AI-2 the client confirms or rejects a presented suggestion once, on their own draft: confirmation and rejection are mutually exclusive and final, other principals see not_found, and a confirmation writes no canonical Intake state (the Intake row, its row version and every revision are unchanged); a confirmed jurisdiction suggestion records one unreviewed ai_suggestion-sourced assessment per suggested jurisdiction, linked to it",
    () => {
      const { client, intake, practice, jurisdictions } = v2.presented;
      const snapshot = intakeSnapshot(intake);
      const outcomes = {
        other_client: decide(world.otherClient, "confirm", practice),
        attorney: decide(world.attorney, "confirm", practice),
        staff: decide(v2.globalReviewer, "confirm", practice),
        no_subject: decide(null, "confirm", practice),
        unknown: decide(client, "confirm", uid()),
        anon: as(
          "anon",
          null,
          `select public.client_confirm_ai_suggestion('${practice}'::uuid);`,
        ),
        confirm: decide(client, "confirm", practice),
        confirm_again: decide(client, "confirm", practice),
        reject_confirmed: decide(client, "reject", practice),
      };
      const confirmed = suggestionOf(practice);
      assert.equal(confirmed.confirmed_by_user_id, client.user);
      assert.ok(confirmed.confirmed_at !== null);
      assert.equal(confirmed.rejected_at, null);
      // The practice area is applied only through the ordinary save: the
      // revision keeps the client's own statement.
      assert.equal(intakeSnapshot(intake), snapshot);
      assert.equal(assessmentsOf(intake).length, 0);
      outcomes.confirm_jurisdictions = decide(client, "confirm", jurisdictions);
      assert.equal(intakeSnapshot(intake), snapshot);
      const recordedAssessments = assessmentsOf(intake);
      assert.deepEqual(
        recordedAssessments.map((a) => [
          a.j,
          a.source,
          a.ai,
          a.review,
          a.basis,
        ]),
        [world.jurisdiction, world.otherJurisdiction].map((j) => [
          j,
          "ai_suggestion",
          jurisdictions,
          "unreviewed",
          "ai_suggestion:confirmed_by_client:intake_revision:1",
        ]),
      );
      // A rejection.
      const rejectable = recorded(
        recordSuggestion({
          user: client.user,
          intake,
          value: { practice_area_id: v2.otherArea },
        }),
      );
      outcomes.reject = decide(client, "reject", rejectable);
      outcomes.reject_again = decide(client, "reject", rejectable);
      outcomes.confirm_rejected = decide(client, "confirm", rejectable);
      const rejected = suggestionOf(rejectable);
      assert.ok(rejected.rejected_at !== null);
      assert.equal(rejected.confirmed_at, null);
      assert.equal(rejected.confirmed_by_user_id, null);
      // A pending suggestion cannot be decided once the Intake is submitted
      // or past its expires_at.
      const pending = recorded(
        recordSuggestion({
          user: client.user,
          intake,
          value: { practice_area_id: v2.area },
        }),
      );
      const expiring = draftThroughFunctions();
      const expiringSuggestion = recorded(
        recordSuggestion({
          user: expiring.client.user,
          intake: expiring.intake,
          value: { practice_area_id: v2.area },
        }),
      );
      // Only an active Intake carries an expiry time (20261119070000): the
      // draft is submitted, activated and then passes its expires_at.
      assert.equal(
        submitThroughFunctions(expiring.client, expiring.intake),
        "submitted",
      );
      activate(expiring.intake);
      expireNow(expiring.intake);
      outcomes.expired_by_time = decide(
        expiring.client,
        "confirm",
        expiringSuggestion,
      );
      assert.equal(intakeState(expiring.intake), "active");
      assert.equal(submitThroughFunctions(client, intake), "submitted");
      outcomes.after_submission = decide(client, "confirm", pending);
      outcomes.reject_after_submission = decide(client, "reject", pending);
      assert.deepEqual(outcomes, {
        other_client: "not_found",
        attorney: "not_found",
        staff: "not_found",
        no_subject: "not_found",
        unknown: "not_found",
        anon: "ERROR 42501",
        confirm: "confirmed",
        confirm_again: "already_confirmed",
        reject_confirmed: "already_confirmed",
        confirm_jurisdictions: "confirmed",
        reject: "rejected",
        reject_again: "already_rejected",
        confirm_rejected: "already_rejected",
        expired_by_time: "not_editable",
        after_submission: "not_editable",
        reject_after_submission: "not_editable",
      });
      const decisions = sql(
        `select string_agg(actor_type || ':' || (actor_user_id = '${client.user}')::text || ':' || action_code, ',' order by occurred_at, action_code) from public.audit_events where resource_type = 'ai_suggestion' and resource_id in ('${practice}', '${jurisdictions}', '${rejectable}') and action_code <> 'ai_suggestion_presented';`,
      );
      assert.equal(
        decisions,
        "client:true:ai_suggestion_confirmed,client:true:ai_suggestion_confirmed,client:true:ai_suggestion_rejected",
      );
      v2.aiSourcedIntake = intake;
      return outcomes;
    },
  );

  await check(
    "V2-AI-3 AI output cannot alter protected state: across recording, confirming and rejecting suggestions (and every refusal), the only relations whose rows change are ai_suggestions, jurisdiction_assessments and audit_events; the AI functions name no other relation in a write; a stored suggestion is never deleted or truncated and changes only by one decision",
    () => {
      const { client, intake } = draftThroughFunctions({
        jurisdictions: "not_sure",
        area: "not_sure",
      });
      const before = relationDigests();
      const practice = recorded(
        recordSuggestion({
          user: client.user,
          intake,
          value: { practice_area_id: v2.area },
        }),
      );
      const jurisdictions = recorded(
        recordSuggestion({
          user: client.user,
          intake,
          type: "potentially_relevant_jurisdictions",
          value: { jurisdiction_ids: [world.jurisdiction] },
        }),
      );
      const other = recorded(
        recordSuggestion({
          user: client.user,
          intake,
          value: { practice_area_id: v2.otherArea },
        }),
      );
      assert.equal(decide(client, "confirm", practice), "confirmed");
      assert.equal(decide(client, "confirm", jurisdictions), "confirmed");
      assert.equal(decide(client, "reject", other), "rejected");
      assert.equal(
        recordSuggestion({
          user: client.user,
          intake,
          revision: 9,
          value: { practice_area_id: v2.area },
        }),
        "stale|",
      );
      assert.equal(decide(world.otherClient, "confirm", practice), "not_found");
      const after = relationDigests();
      const changed = changedRelations(before, after);
      assert.deepEqual(changed, [
        "ai_suggestions",
        "audit_events",
        "jurisdiction_assessments",
      ]);
      // The client's own statements stay "not sure": no category and no
      // jurisdiction was written for them.
      assert.equal(
        sql(
          `select practice_area_id is null and structured_answers ->> 'practice_area' = 'not_sure' and structured_answers ->> 'jurisdictions' = 'not_sure' from public.intake_revisions where intake_id = '${intake}';`,
        ),
        "t",
      );
      const writes = JSON.parse(
        sql(
          `select json_agg(distinct m[1] order by m[1])::text from pg_proc as p, regexp_matches(p.prosrc, '(?:insert\\s+into|update|delete\\s+from)\\s+public\\.([a-z_]+)', 'gi') as m where p.oid in ('public.ai_record_intake_suggestion(uuid, uuid, integer, text, jsonb, text, timestamptz)'::regprocedure, 'public.client_confirm_ai_suggestion(uuid)'::regprocedure, 'public.client_reject_ai_suggestion(uuid)'::regprocedure);`,
        ),
      );
      assert.deepEqual(writes, [
        "ai_suggestions",
        "audit_events",
        "jurisdiction_assessments",
      ]);
      const integrity = {
        delete: refused(
          `delete from public.ai_suggestions where id = '${practice}';`,
        ),
        truncate: refused("truncate public.ai_suggestions cascade;"),
        value_change: refused(
          `update public.ai_suggestions set suggestion_value = suggestion_value || '{"rank": 1}' where id = '${other}';`,
        ),
        second_decision: refused(
          `update public.ai_suggestions set rejected_at = now() where id = '${practice}';`,
        ),
        undecide: refused(
          `update public.ai_suggestions set confirmed_at = null, confirmed_by_user_id = null where id = '${practice}';`,
        ),
      };
      for (const [name, code] of Object.entries(integrity)) {
        assert.ok(["55000", "23514"].includes(code), `${name}: ${code}`);
      }
      assert.equal(integrity.delete, "55000");
      assert.equal(integrity.truncate, "55000");
      return { changed, writes, integrity };
    },
  );

  await check(
    "V2-AI-4 suggestions are visible only to the Intake's own client: another client, an attorney, staff holding the intake configuration capability, and a caller without a subject see no row; anon has no access",
    () => {
      const { client, intake } = v2.presented;
      const where = `context_type = 'intake' and context_id = '${intake}'`;
      const seen = (principal, options = {}) =>
        as(
          "authenticated",
          principal === null ? null : principal.auth,
          `select count(*) from public.ai_suggestions where ${where};`,
          options,
        );
      const outcomes = {
        owner: seen(client),
        other_client: seen(world.otherClient),
        attorney: seen(world.attorney),
        staff_global: seen(v2.globalReviewer),
        no_subject: seen(null),
        anon: as("anon", null, `select count(*) from public.ai_suggestions;`),
      };
      assert.ok(Number(outcomes.owner) >= 3);
      assert.deepEqual(
        { ...outcomes, owner: "n" },
        {
          owner: "n",
          other_client: "0",
          attorney: "0",
          staff_global: "0",
          no_subject: "0",
          anon: "ERROR 42501",
        },
      );
      return outcomes;
    },
  );
}

async function v2ReviewChecks() {
  await check(
    "V2-JR-1 assessment constraints and integrity: the source is a client statement without an AI link or an AI suggestion with one; the review status is unreviewed without a review time or confirmed / not_confirmed with one; a basis is recorded; an assessment is never deleted or truncated and changes only by one review",
    () => {
      const intake = newIntake(world.owner, "submitted");
      const insert = (columns, values) =>
        refused(
          `insert into public.jurisdiction_assessments (intake_id, jurisdiction_id, ${columns}) values ('${intake}', '${world.jurisdiction}', ${values});`,
        );
      const suggestion = v2.presented.jurisdictions;
      const outcomes = {
        ai_without_link: insert(
          "assessment_basis, source_type, review_status",
          "'b', 'ai_suggestion', 'unreviewed'",
        ),
        statement_with_link: insert(
          "assessment_basis, source_type, ai_suggestion_id, review_status",
          `'b', 'client_statement', '${suggestion}', 'unreviewed'`,
        ),
        unknown_source: insert(
          "assessment_basis, source_type, review_status",
          "'b', 'staff_choice', 'unreviewed'",
        ),
        unknown_review: insert(
          "assessment_basis, source_type, review_status",
          "'b', 'client_statement', 'governing_law'",
        ),
        confirmed_without_time: insert(
          "assessment_basis, source_type, review_status",
          "'b', 'client_statement', 'confirmed'",
        ),
        missing_basis: insert(
          "source_type, review_status",
          "'client_statement', 'unreviewed'",
        ),
      };
      for (const [name, code] of Object.entries(outcomes)) {
        assert.equal(code, "23514", name);
      }
      const id = uid();
      sql(
        `insert into public.jurisdiction_assessments (id, intake_id, jurisdiction_id, assessment_basis, source_type, review_status) values ('${id}', '${intake}', '${world.jurisdiction}', 'synthetic basis', 'client_statement', 'unreviewed');`,
      );
      outcomes.jurisdiction_change = refused(
        `update public.jurisdiction_assessments set jurisdiction_id = '${world.otherJurisdiction}' where id = '${id}';`,
      );
      outcomes.delete = refused(
        `delete from public.jurisdiction_assessments where id = '${id}';`,
      );
      outcomes.truncate = refused(
        "truncate public.jurisdiction_assessments cascade;",
      );
      sql(
        `update public.jurisdiction_assessments set review_status = 'confirmed', reviewed_at = now(), reviewed_by_user_id = '${v2.globalReviewer.user}' where id = '${id}';`,
      );
      outcomes.second_review = refused(
        `update public.jurisdiction_assessments set review_status = 'not_confirmed' where id = '${id}';`,
      );
      for (const name of [
        "jurisdiction_change",
        "delete",
        "truncate",
        "second_review",
      ]) {
        assert.equal(outcomes[name], "55000", name);
      }
      return outcomes;
    },
  );

  await check(
    "V2-JR-2 ambiguous jurisdiction is surfaced rather than guessed: a submission naming several jurisdictions records each as its own unreviewed client-statement assessment (none chosen) and the review queue shows the candidate count; a submission naming none ('not sure') records no assessment and is listed only to global reviewers in the unnamed group, with nothing to choose",
    () => {
      const several = draftThroughFunctions({
        jurisdictions: [world.jurisdiction, world.otherJurisdiction],
      });
      assert.equal(
        submitThroughFunctions(several.client, several.intake),
        "submitted",
      );
      const none = draftThroughFunctions({ jurisdictions: "not_sure" });
      assert.equal(
        submitThroughFunctions(none.client, none.intake),
        "submitted",
      );
      const one = draftThroughFunctions({
        jurisdictions: [world.jurisdiction],
      });
      assert.equal(submitThroughFunctions(one.client, one.intake), "submitted");
      const recordedSeveral = assessmentsOf(several.intake);
      assert.deepEqual(
        recordedSeveral.map((a) => [a.j, a.source, a.ai, a.review]),
        [world.jurisdiction, world.otherJurisdiction].map((j) => [
          j,
          "client_statement",
          null,
          "unreviewed",
        ]),
      );
      assert.equal(assessmentsOf(none.intake).length, 0);
      const pick = (queue, intake) => queue.find((q) => q.intake === intake);
      const globalUnreviewed = reviewQueue(v2.globalReviewer, "unreviewed");
      const globalUnnamed = reviewQueue(v2.globalReviewer, "unnamed");
      const scopedUnreviewed = reviewQueue(v2.scopedReviewerA, "unreviewed");
      const scopedUnnamed = reviewQueue(v2.scopedReviewerA, "unnamed");
      assert.deepEqual(pick(globalUnreviewed, several.intake), {
        intake: several.intake,
        state: "submitted",
        candidates: 2,
        unreviewed: 2,
      });
      assert.deepEqual(pick(scopedUnreviewed, several.intake), {
        intake: several.intake,
        state: "submitted",
        candidates: 2,
        unreviewed: 1,
      });
      assert.deepEqual(pick(globalUnreviewed, one.intake)?.candidates, 1);
      assert.equal(pick(globalUnreviewed, none.intake), undefined);
      assert.deepEqual(pick(globalUnnamed, none.intake), {
        intake: none.intake,
        state: "submitted",
        candidates: 0,
        unreviewed: 0,
      });
      assert.equal(pick(globalUnnamed, several.intake), undefined);
      assert.deepEqual(scopedUnnamed, []);
      // The scoped reviewer sees only its jurisdiction's assessment.
      assert.deepEqual(
        reviewAssessments(v2.scopedReviewerA, several.intake).map(
          (a) => a.jurisdiction_id,
        ),
        [world.jurisdiction],
      );
      v2.several = several;
      v2.none = none;
      return {
        several: recordedSeveral.length,
        none: 0,
        global_unnamed_includes_none: true,
        scoped_unnamed: scopedUnnamed.length,
      };
    },
  );

  await check(
    "V2-JR-3 the staff review needs manage_intake_configuration at aal2 for the assessment's jurisdiction: global and in-scope reviewers record confirmed or not_confirmed once (audited, the Intake and the client's statements untouched); aal1, staff without the capability, clients, attorneys and a caller without a subject are denied; an out-of-scope assessment looks unknown; drafts and ended or expired Intakes are not reviewable",
    () => {
      const several = v2.several;
      const [inA, inB] = assessmentsOf(several.intake);
      const snapshot = intakeSnapshot(several.intake);
      const outcomes = {
        aal1: review(v2.globalReviewer, inA.id, "confirmed", { aal: "aal1" }),
        no_claims: review(v2.globalReviewer, inA.id, "confirmed", {
          aal: null,
        }),
        other_capability: review(v2.otherStaff, inA.id, "confirmed"),
        verification_staff: review(world.verifier, inA.id, "confirmed"),
        client: review(several.client, inA.id, "confirmed"),
        attorney: review(world.attorney, inA.id, "confirmed"),
        no_subject: review(null, inA.id, "confirmed"),
        anon: as(
          "anon",
          null,
          `select public.staff_review_jurisdiction_assessment('${inA.id}'::uuid, 'confirmed');`,
        ),
        scoped_out_of_scope: review(v2.scopedReviewerA, inB.id, "confirmed"),
        invalid_decision: review(v2.globalReviewer, inA.id, "governing_law"),
        null_decision: review(v2.globalReviewer, inA.id, null),
        unknown: review(v2.globalReviewer, uid(), "confirmed"),
        scoped_in_scope: review(v2.scopedReviewerA, inA.id, "confirmed"),
        again: review(v2.globalReviewer, inA.id, "not_confirmed"),
        global: review(v2.globalReviewer, inB.id, "not_confirmed"),
      };
      const reviewed = assessmentsOf(several.intake);
      assert.deepEqual(
        reviewed.map((a) => [a.review, a.reviewed_by, a.reviewed_at !== null]),
        [
          ["confirmed", v2.scopedReviewerA.user, true],
          ["not_confirmed", v2.globalReviewer.user, true],
        ],
      );
      assert.equal(intakeSnapshot(several.intake), snapshot);
      const audit = sql(
        `select string_agg(actor_type || ':' || action_code || ':' || (jurisdiction_id = '${world.jurisdiction}')::text || ':' || (after_snapshot ->> 'review_status'), ',' order by occurred_at) from public.audit_events where resource_type = 'jurisdiction_assessment' and resource_id in ('${inA.id}', '${inB.id}');`,
      );
      assert.equal(
        audit,
        "staff:jurisdiction_assessment.reviewed:true:confirmed,staff:jurisdiction_assessment.reviewed:false:not_confirmed",
      );
      // Not reviewable: an AI-sourced assessment of a draft, a closed Intake,
      // and an Intake past its expires_at (which the review never writes).
      const draft = draftThroughFunctions({ jurisdictions: "not_sure" });
      const suggestion = recorded(
        recordSuggestion({
          user: draft.client.user,
          intake: draft.intake,
          type: "potentially_relevant_jurisdictions",
          value: { jurisdiction_ids: [world.jurisdiction] },
        }),
      );
      assert.equal(decide(draft.client, "confirm", suggestion), "confirmed");
      const [draftAssessment] = assessmentsOf(draft.intake);
      outcomes.draft = review(
        v2.globalReviewer,
        draftAssessment.id,
        "confirmed",
      );
      assert.deepEqual(reviewAssessments(v2.globalReviewer, draft.intake), []);
      assert.equal(
        reviewQueue(v2.globalReviewer, "unreviewed").some(
          (q) => q.intake === draft.intake,
        ),
        false,
      );
      const closing = draftThroughFunctions();
      assert.equal(
        submitThroughFunctions(closing.client, closing.intake),
        "submitted",
      );
      assert.equal(
        closeThroughFunctions(closing.client, closing.intake),
        "closed",
      );
      outcomes.closed = review(
        v2.globalReviewer,
        assessmentsOf(closing.intake)[0].id,
        "confirmed",
      );
      const expiring = draftThroughFunctions();
      assert.equal(
        submitThroughFunctions(expiring.client, expiring.intake),
        "submitted",
      );
      // Only an active Intake carries an expiry time (20261119070000).
      activate(expiring.intake);
      expireNow(expiring.intake);
      outcomes.expired_by_time = review(
        v2.globalReviewer,
        assessmentsOf(expiring.intake)[0].id,
        "confirmed",
      );
      assert.equal(intakeState(expiring.intake), "active");
      // Once the draft is submitted, its AI-sourced assessment is reviewable.
      assert.equal(
        submitThroughFunctions(draft.client, draft.intake),
        "submitted",
      );
      outcomes.after_submission = review(
        v2.globalReviewer,
        draftAssessment.id,
        "confirmed",
      );
      assert.deepEqual(outcomes, {
        aal1: "denied",
        no_claims: "denied",
        other_capability: "denied",
        verification_staff: "denied",
        client: "denied",
        attorney: "denied",
        no_subject: "denied",
        anon: "ERROR 42501",
        scoped_out_of_scope: "not_found",
        invalid_decision: "invalid",
        null_decision: "invalid",
        unknown: "not_found",
        scoped_in_scope: "applied",
        again: "already_reviewed",
        global: "applied",
        draft: "not_reviewable",
        closed: "not_reviewable",
        expired_by_time: "not_reviewable",
        after_submission: "applied",
      });
      return outcomes;
    },
  );

  await check(
    "V2-JR-4 the staff review reads disclose only what review needs (Intake id, state, creation time, counts; jurisdiction, source, basis and status) and nothing to anyone else: aal1, staff without the capability, clients, attorneys and a caller without a subject read nothing, anon has no access, and out-of-range pages answer nothing",
    () => {
      assert.equal(
        sql(
          "select pg_get_function_result('public.staff_jurisdiction_review_intakes(text, integer, integer)'::regprocedure);",
        ),
        "TABLE(intake_id uuid, intake_state text, intake_created_at timestamp with time zone, candidate_count integer, unreviewed_count integer)",
      );
      assert.equal(
        sql(
          "select pg_get_function_result('public.staff_jurisdiction_review_assessments(uuid)'::regprocedure);",
        ),
        "TABLE(assessment_id uuid, jurisdiction_id uuid, jurisdiction_code text, jurisdiction_name text, source_type text, assessment_basis text, review_status text, created_at timestamp with time zone, reviewed_at timestamp with time zone, reviewed_by_user_id uuid)",
      );
      const intake = v2.several.intake;
      const nothing = {
        aal1_queue: reviewQueue(v2.globalReviewer, "unreviewed", {
          aal: "aal1",
        }),
        aal1_unnamed: reviewQueue(v2.globalReviewer, "unnamed", {
          aal: "aal1",
        }),
        aal1_assessments: reviewAssessments(v2.globalReviewer, intake, {
          aal: "aal1",
        }),
        other_capability: reviewQueue(v2.otherStaff, "unreviewed"),
        other_capability_assessments: reviewAssessments(v2.otherStaff, intake),
        client: reviewQueue(v2.several.client, "unreviewed"),
        client_assessments: reviewAssessments(v2.several.client, intake),
        attorney: reviewQueue(world.attorney, "unnamed"),
        attorney_assessments: reviewAssessments(world.attorney, intake),
        no_subject: reviewQueue(null, "unreviewed"),
        unknown_group: reviewQueue(v2.globalReviewer, "everything"),
        zero_count: reviewQueue(v2.globalReviewer, "unnamed", {}, [0, 0]),
        over_count: reviewQueue(v2.globalReviewer, "unnamed", {}, [0, 102]),
        negative_offset: reviewQueue(
          v2.globalReviewer,
          "unnamed",
          {},
          [-1, 10],
        ),
      };
      for (const [name, value] of Object.entries(nothing)) {
        assert.deepEqual(value, [], name);
      }
      const anon = as(
        "anon",
        null,
        "select count(*) from public.staff_jurisdiction_review_intakes('unnamed', 0, 10);",
      );
      assert.equal(anon, "ERROR 42501");
      const rows = reviewAssessments(v2.globalReviewer, intake);
      assert.equal(rows.length, 2);
      assert.deepEqual(Object.keys(rows[0]).sort(), [
        "assessment_basis",
        "assessment_id",
        "created_at",
        "jurisdiction_code",
        "jurisdiction_id",
        "jurisdiction_name",
        "review_status",
        "reviewed_at",
        "reviewed_by_user_id",
        "source_type",
      ]);
      return { anon, global_rows: rows.length };
    },
  );

  await check(
    "V2-JR-5 attorneys see nothing of any Intake before acceptance (counsel gate): no Intake, revision, assessment or suggestion row, no review queue entry, and every client function answers not_found",
    () => {
      const intake = v2.several.intake;
      const reads = {};
      for (const [table, where] of [
        ["intakes", `id = '${intake}'`],
        ["intake_revisions", `intake_id = '${intake}'`],
        ["jurisdiction_assessments", `intake_id = '${intake}'`],
        ["ai_suggestions", `context_id = '${v2.presented.intake}'`],
      ]) {
        reads[table] = as(
          "authenticated",
          world.attorney.auth,
          `select count(*) from public.${table} where ${where};`,
        );
        assert.equal(reads[table], "0", table);
      }
      reads.queue = reviewQueue(world.attorney, "unreviewed");
      assert.deepEqual(reads.queue, []);
      reads.change = requestChange(world.attorney, intake, "revise");
      assert.equal(reads.change, "not_found");
      return reads;
    },
  );

  await check(
    "V2-AUD-1 the S3 part 2 audit trail is data-minimized: expiry, suggestion and review events carry states, decisions, types, model references, digests and identifiers only, never a description, an answer, a practice area or jurisdiction suggested, or any intake content",
    () => {
      const rows = JSON.parse(
        sql(
          "select coalesce(json_agg(json_build_object('action', action_code, 'before', before_snapshot, 'after', after_snapshot)), '[]')::text from public.audit_events where action_code in ('intake_expired', 'ai_suggestion_presented', 'ai_suggestion_confirmed', 'ai_suggestion_rejected', 'jurisdiction_assessment.reviewed');",
        ),
      );
      const actions = [...new Set(rows.map((r) => r.action))].sort();
      assert.deepEqual(actions, [
        "ai_suggestion_confirmed",
        "ai_suggestion_presented",
        "ai_suggestion_rejected",
        "intake_expired",
        "jurisdiction_assessment.reviewed",
      ]);
      for (const row of rows) {
        const text = JSON.stringify(row);
        assert.doesNotMatch(
          text,
          new RegExp(
            `Synthetic words|court_case|assistance_type|${v2.area}|${v2.otherArea}|practice_area_id|jurisdiction_ids`,
          ),
        );
        if (row.action === "ai_suggestion_presented") {
          assert.deepEqual(Object.keys(row.after).sort(), [
            "context_id",
            "context_type",
            "model_reference",
            "requested_by_user_id",
            "revision_number",
            "suggestion_type",
            "value_sha256",
          ]);
        }
      }
      return { events: rows.length, actions };
    },
  );
}

async function main() {
  try {
    startCluster();
    applyMigrations();
    seed();
    seedV2();
    await migrationChecks();
    await constraintChecks();
    await privilegeChecks();
    await voiceMemoChecks();
    await authorizationChecks();
    await artifactChecks();
    await storageChecks();
    await auditChecks();
    // S3 part 2.
    await v2MigrationChecks();
    await v2LifecycleChecks();
    await v2AiChecks();
    await v2ReviewChecks();
  } catch (error) {
    report.error = String(error?.stack ?? error);
    failed = true;
  }
  const cleaned = teardown();
  report.cleanup = cleaned;
  report.result = failed ? "FAIL" : cleaned ? "PASS" : "CLEANUP-FAILED";
  report.summary = {
    passed: report.checks.filter((c) => c.result === "PASS").length,
    total: report.checks.length,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = failed ? 1 : cleaned ? 0 : 2;
}

await main();
