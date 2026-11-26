// DEV-001 disposable PostgreSQL proof: the storage of the website and
// appearance studio (migration 20261130010000_dev_001_site_appearance: the
// appearance versions, the image library, the active theme, the capability
// catalogue code manage_site_appearance pending owner confirmation A53, and
// the public and staff functions). Explicitly invoked only:
//
//   node apps/web/tests/dev-001-site-appearance-db-proof.mjs
//
// Deliberately not a *.test.mjs file, so no application test run, p0:test,
// or CI job starts it. It uses Node built-ins and the system-installed
// PostgreSQL 16 initdb, pg_ctl, and psql binaries; no network.
//
// It creates a new mode-0700 temporary directory, initializes a new cluster
// owned by an unprivileged account (never root), and starts it with TCP
// disabled and a private Unix-domain socket (port 54394). The roles anon,
// authenticated, and service_role (BYPASSRLS), the synthetic auth schema
// (auth.users and an auth.uid() that reads request.jwt.claim.sub), the hosted
// platform's default privileges, and a no-op public.rls_auto_enable() are
// synthetic objects of this cluster only. Every migration is applied
// unmodified, in order, each in one transaction, to two databases: the main
// one (every migration; its environment is recorded as development) and a
// base one that stops before the site appearance migration, so the catalog
// the migration leaves can be compared with the catalog before it. The
// migration is pinned by SHA-256.
//
// Preparation mode (before the migration is committed): set
// DEV_001_SITE_APPEARANCE_REPOSITORY_ROOT to a directory whose
// supabase/migrations holds every committed migration plus the draft; the
// draft must then be the newest file, directly after the DEV-001 workspace
// reads, and its register row is not checked (the register is checked when
// the proof runs in the repository, where the variable is not set).
//
// Every account, grant, configuration, page text and image is synthetic test
// data, never a product value: the images are 16x16 PNG, JPEG and WebP byte
// strings built here, and the grants are planted by the owner role (as the
// other DEV-001 proofs plant them), except where a probe uses the audited
// staff_grant_capability flow itself. Where a probe says so, the owner plants
// library rows directly (the library bound).
//
// Request sessions are modelled as PostgREST sets them from a verified JWT:
// request.jwt.claim.sub and the JSON request.jwt.claims (staff at aal2 unless a
// probe says otherwise; the client at aal1); anonymous and service_role
// requests run without a subject.
//
// The JSON report goes to stdout; exit 0 means PASS, 1 FAIL, 2 cleanup
// failure.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import {
  assertRegisteredLifecycle,
  assertTailThenRegistered,
} from "./migration-lifecycle.mjs";

const BIN = "/usr/lib/postgresql/16/bin";
const PORT = 54394;
const DB = "rosuno_dev001_site_appearance_proof";
const BASE_DB = "rosuno_dev001_site_appearance_proof_base";
const PREPARATION = process.env.DEV_001_SITE_APPEARANCE_REPOSITORY_ROOT;
const REPOSITORY_ROOT =
  PREPARATION ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATIONS = path.join(REPOSITORY_ROOT, "supabase/migrations");
const PREVIOUS_MIGRATION = "20261129010000_dev_001_workspace_reads.sql";
const OWN_MIGRATION = "20261130010000_dev_001_site_appearance.sql";
const OWN_SHA256 =
  "62161bb40c9e2161ba00cb4a4821a7ea44ea984fdf821327bd37e7ca777839bb";
const PROGRAM_WORK_ITEM = "WI-P2-DEV-001-ENGINEERING-PROGRAM";
const PROGRAM_DECISION = "DEC-20261125-DEV-001-ENGINEERING-PROGRAM";
const CAPABILITY = "manage_site_appearance";
const THEME = "rosuno";

const TABLES = Object.freeze([
  "site_appearance_activation",
  "site_appearance_assets",
  "site_appearance_versions",
]);

// The eighteen functions: identity arguments, result, volatility, language,
// security definer, configuration and executors.
const DEFINER_CONFIG = "search_path=pg_catalog, pg_temp";
const COMMAND_CONFIG = "search_path=pg_catalog, pg_temp;lock_timeout=3s";
const FUNCTIONS = Object.freeze({
  "site_appearance_text_allowed(text)": {
    args: "p_text text",
    result: "boolean",
    volatility: "i",
    language: "sql",
    definer: false,
    config: DEFINER_CONFIG,
    executors: "",
  },
  "site_appearance_shape_valid(jsonb)": {
    args: "p jsonb",
    result: "boolean",
    volatility: "i",
    language: "plpgsql",
    definer: false,
    config: DEFINER_CONFIG,
    executors: "",
  },
  "site_appearance_versions_guard()": {
    args: "",
    result: "trigger",
    volatility: "v",
    language: "plpgsql",
    definer: false,
    config: DEFINER_CONFIG,
    executors: "",
  },
  "site_appearance_assets_guard()": {
    args: "",
    result: "trigger",
    volatility: "v",
    language: "plpgsql",
    definer: false,
    config: DEFINER_CONFIG,
    executors: "",
  },
  "public_site_appearance()": {
    args: "",
    result:
      "TABLE(version_id uuid, version_number integer, theme_key text, configuration jsonb, configuration_sha256 text, published_at timestamp with time zone)",
    volatility: "s",
    language: "sql",
    definer: true,
    config: DEFINER_CONFIG,
    executors: "anon,authenticated",
  },
  "public_site_appearance_asset(text)": {
    args: "p_sha256 text",
    result: "TABLE(media_type text, content_base64 text, byte_size integer)",
    volatility: "s",
    language: "sql",
    definer: true,
    config: DEFINER_CONFIG,
    executors: "anon,authenticated",
  },
  "staff_site_appearance_overview(text)": {
    args: "p_theme_key text",
    result:
      "TABLE(draft_id uuid, draft_revision integer, draft_configuration jsonb, draft_based_on_version_id uuid, draft_updated_at timestamp with time zone, published_id uuid, published_version_number integer, published_configuration jsonb, published_at timestamp with time zone, active_theme_key text)",
    volatility: "s",
    language: "sql",
    definer: true,
    config: DEFINER_CONFIG,
    executors: "authenticated",
  },
  "staff_site_appearance_versions(text, integer)": {
    args: "p_theme_key text, p_offset integer",
    result:
      "TABLE(version_id uuid, version_number integer, state text, label text, configuration_sha256 text, based_on_version_id uuid, created_at timestamp with time zone, updated_at timestamp with time zone, published_at timestamp with time zone, published_by_user_id uuid, superseded_at timestamp with time zone, discarded_at timestamp with time zone)",
    volatility: "s",
    language: "sql",
    definer: true,
    config: DEFINER_CONFIG,
    executors: "authenticated",
  },
  "staff_site_appearance_version(uuid)": {
    args: "p_version_id uuid",
    result:
      "TABLE(version_id uuid, theme_key text, state text, version_number integer, configuration jsonb, configuration_sha256 text, label text, published_at timestamp with time zone)",
    volatility: "s",
    language: "sql",
    definer: true,
    config: DEFINER_CONFIG,
    executors: "authenticated",
  },
  "staff_site_appearance_preview(text)": {
    args: "p_theme_key text",
    result: "TABLE(version_id uuid, revision integer, configuration jsonb)",
    volatility: "s",
    language: "sql",
    definer: true,
    config: DEFINER_CONFIG,
    executors: "authenticated",
  },
  "staff_site_appearance_assets(integer)": {
    args: "p_offset integer",
    result:
      "TABLE(asset_id uuid, sha256 text, media_type text, byte_size integer, width integer, height integer, created_at timestamp with time zone)",
    volatility: "s",
    language: "sql",
    definer: true,
    config: DEFINER_CONFIG,
    executors: "authenticated",
  },
  "staff_site_appearance_asset(text)": {
    args: "p_sha256 text",
    result: "TABLE(media_type text, content_base64 text, byte_size integer)",
    volatility: "s",
    language: "sql",
    definer: true,
    config: DEFINER_CONFIG,
    executors: "authenticated",
  },
  "staff_save_site_appearance_draft(text, integer, jsonb)": {
    args: "p_theme_key text, p_expected_revision integer, p_configuration jsonb",
    result: "TABLE(outcome text, version_id uuid, revision integer)",
    volatility: "v",
    language: "plpgsql",
    definer: true,
    config: COMMAND_CONFIG,
    executors: "authenticated",
  },
  "staff_publish_site_appearance(text, uuid, integer, text)": {
    args: "p_theme_key text, p_draft_id uuid, p_expected_revision integer, p_label text",
    result: "TABLE(outcome text, version_id uuid, version_number integer)",
    volatility: "v",
    language: "plpgsql",
    definer: true,
    config: COMMAND_CONFIG,
    executors: "authenticated",
  },
  "staff_restore_site_appearance(uuid, integer)": {
    args: "p_version_id uuid, p_expected_revision integer",
    result: "TABLE(outcome text, version_id uuid, revision integer)",
    volatility: "v",
    language: "plpgsql",
    definer: true,
    config: COMMAND_CONFIG,
    executors: "authenticated",
  },
  "staff_reset_site_appearance(text, integer)": {
    args: "p_theme_key text, p_expected_revision integer",
    result: "TABLE(outcome text, version_id uuid, revision integer)",
    volatility: "v",
    language: "plpgsql",
    definer: true,
    config: COMMAND_CONFIG,
    executors: "authenticated",
  },
  "staff_discard_site_appearance_draft(uuid, integer)": {
    args: "p_draft_id uuid, p_expected_revision integer",
    result: "text",
    volatility: "v",
    language: "plpgsql",
    definer: true,
    config: COMMAND_CONFIG,
    executors: "authenticated",
  },
  "staff_upload_site_appearance_asset(text, integer, integer, text)": {
    args: "p_media_type text, p_width integer, p_height integer, p_content_base64 text",
    result: "TABLE(outcome text, asset_id uuid, sha256 text)",
    volatility: "v",
    language: "plpgsql",
    definer: true,
    config: COMMAND_CONFIG,
    executors: "authenticated",
  },
});
const FUNCTION_NAMES = Object.freeze(
  Object.keys(FUNCTIONS).map((s) => s.slice(0, s.indexOf("("))),
);

const report = {
  proof:
    "DEV-001 website and appearance studio storage disposable local PostgreSQL proof",
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

function requestScript(role, sub, statement, options) {
  return [
    "begin;",
    ...sessionLines(role, sub, options),
    statement,
    "commit;",
    "",
  ].join("\n");
}

// One statement as a request, in its own committed transaction: the last
// output line, or "ERROR <sqlstate>".
function as(role, sub, statement, options = {}) {
  const result = psql(requestScript(role, sub, statement, options));
  if (result.status === 0) {
    const lines = result.stdout.trim().split("\n");
    return lines[lines.length - 1];
  }
  return `ERROR ${sqlstateOf(result.stderr)}`;
}

// All output lines of one request statement (for row-returning reads).
function rowsAs(role, sub, statement, options = {}) {
  const result = psql(requestScript(role, sub, statement, options));
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .trim()
    .split("\n")
    .filter((line) => line !== "" && line !== "t");
}

// A request run in the background (for the concurrency probes).
function background(script) {
  return new Promise((resolve) => {
    const child = spawn(path.join(BIN, "psql"), psqlArgs(DB), {
      env: childEnvironment(),
      cwd: state.tmp,
      ...state.identity.spawn,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) =>
      resolve({
        code,
        err,
        lines: out
          .trim()
          .split("\n")
          .filter((line) => line !== "" && line !== "t"),
      }),
    );
    child.stdin.end(script);
  });
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    path.join(os.tmpdir(), "rosuno-dev-001-site-appearance-db-proof-"),
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
// the site appearance migration.
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
    if (file === OWN_MIGRATION) {
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
  const own = files.indexOf(OWN_MIGRATION);
  assert.ok(own > 0, `${OWN_MIGRATION} is present`);
  assert.equal(
    files[own - 1],
    PREVIOUS_MIGRATION,
    "the site appearance migration directly follows the DEV-001 workspace reads",
  );
  report.migrations.sha256 = sha256(
    fs.readFileSync(path.join(MIGRATIONS, OWN_MIGRATION)),
  );
  if (PREPARATION) {
    assert.equal(own, files.length - 1, "the draft is the newest migration");
    report.migrations.registration =
      "not checked in preparation mode (DEV_001_SITE_APPEARANCE_REPOSITORY_ROOT is set); the register row, the Program reference and every later migration are checked when the proof runs in the repository";
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
    const id = OWN_MIGRATION.replace(/\.sql$/, "");
    const previous = PREVIOUS_MIGRATION.replace(/\.sql$/, "");
    const row = registered.find(
      (migration) =>
        migration.artifact_path === `supabase/migrations/${OWN_MIGRATION}`,
    );
    const before = registered.find(
      (migration) => migration.migration_id === previous,
    );
    assert.ok(row, `${OWN_MIGRATION} is registered`);
    assert.equal(row.migration_id, id);
    assert.equal(row.migration_kind, "product");
    assert.equal(row.sequence, before.sequence + 1);
    assert.equal(row.sequence, 79);
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
    assertTailThenRegistered(files.slice(own + 1), [], OWN_MIGRATION);
    report.migrations.registration = {
      sequence: row.sequence,
      lifecycle,
      later: files.slice(own + 1),
    };
  }
  sql(ROLES, "postgres");
  sql(fixtureFor(DB), "postgres");
  sql(fixtureFor(BASE_DB), "postgres");
  report.migrations.notices = applyMigrationsTo(DB, files);
  applyMigrationsTo(BASE_DB, files.slice(0, own));
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
    process.stderr.write(`[dev-001-appearance-proof] PASS ${name}\n`);
  } catch (error) {
    failed = true;
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
    process.stderr.write(
      `[dev-001-appearance-proof] FAIL ${name}\n${error?.stack ?? error}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Synthetic images (16x16; test data only)
// ---------------------------------------------------------------------------

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

// A 16x16 RGB PNG of one synthetic colour.
function png16(seed = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16, 0);
  header.writeUInt32BE(16, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [];
  for (let y = 0; y < 16; y += 1) {
    rows.push(Buffer.from([0]));
    for (let x = 0; x < 16; x += 1) {
      rows.push(Buffer.from([seed & 255, (seed >> 8) & 255, 128]));
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// A 16x16 baseline greyscale JPEG (one Huffman code per table; four flat
// blocks).
function jpeg16(seed = 1) {
  const segment = (marker, body) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(body.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), length, body]);
  };
  const counts = Buffer.alloc(16);
  counts[0] = 1;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(
      0xe0,
      Buffer.from([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ),
    segment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, seed)])),
    segment(0xc0, Buffer.from([8, 0, 16, 0, 16, 1, 1, 0x11, 0])),
    segment(
      0xc4,
      Buffer.concat([Buffer.from([0x00]), counts, Buffer.from([0])]),
    ),
    segment(
      0xc4,
      Buffer.concat([Buffer.from([0x10]), counts, Buffer.from([0])]),
    ),
    segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x00, 0xff, 0xd9]),
  ]);
}

// A 16x16 lossless WebP container (VP8L header).
function webp16() {
  const bits = Buffer.alloc(4);
  bits.writeUInt32LE(15 | (15 << 14));
  const payload = Buffer.concat([Buffer.from([0x2f]), bits, Buffer.alloc(4)]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length);
  const chunk = Buffer.concat([
    Buffer.from("VP8L", "latin1"),
    size,
    payload,
    Buffer.alloc(payload.length % 2),
  ]);
  const riff = Buffer.alloc(4);
  riff.writeUInt32LE(4 + chunk.length);
  return Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    riff,
    Buffer.from("WEBP", "latin1"),
    chunk,
  ]);
}

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><script>alert(1)</script></svg>',
);

// ---------------------------------------------------------------------------
// Synthetic accounts and call helpers
// ---------------------------------------------------------------------------

const world = { audits: [], successes: 0 };

function newAccount(accountState = "active") {
  const auth = uid();
  const user = uid();
  sql(
    `insert into auth.users (id) values ('${auth}');
     insert into public.users (id, auth_user_id, account_state) values ('${user}', '${auth}', '${accountState}');`,
  );
  return { auth, user };
}

// A staff member (Staff Profile in the given state) holding the given grants:
// { jurisdiction, expires, revoked } describe each grant of the capability.
function staffWith(grants, staffState = "active") {
  const account = newAccount();
  sql(
    [
      `insert into public.staff_profiles (user_id, staff_state) values ('${account.user}', '${staffState}');`,
      ...grants.map(
        ({
          capability = CAPABILITY,
          jurisdiction = null,
          expires = null,
          revoked = null,
        }) =>
          `insert into public.capability_grants (user_id, capability_code, granted_by_user_id, jurisdiction_id, granted_at, expires_at, revoked_at) values ('${account.user}', '${capability}', '${world.grantor.user}', ${lit(jurisdiction)}, now() - interval '2 days', ${expires ?? "null"}, ${revoked ?? "null"});`,
      ),
    ].join("\n"),
  );
  return account;
}

const AAL1 = Object.freeze({ aal: "aal1" });

function seed() {
  world.grantor = newAccount();
  sql(
    `insert into public.staff_profiles (user_id, staff_state) values ('${world.grantor.user}', 'active');`,
  );
  world.jurisdiction = uid();
  sql(
    `insert into public.jurisdictions (id, code, name, region_type, lifecycle_state) values ('${world.jurisdiction}', 'SYN_DEV001_APPEARANCE', 'Synthetic appearance', 'synthetic', 'unsupported');`,
  );
  // A: holder (global grant). B: holder used at aal1. C: a grant scoped to a
  // jurisdiction. D: an expired grant. E: a revoked grant. F: a holder whose
  // Staff Profile is deactivated. G: active staff without the grant. H: a
  // client.
  world.A = staffWith([{}]);
  world.A2 = staffWith([{}]);
  world.B = staffWith([{}]);
  world.C = staffWith([{ jurisdiction: world.jurisdiction }]);
  world.D = staffWith([{ expires: "now() - interval '1 day'" }]);
  world.E = staffWith([{ revoked: "now() - interval '1 hour'" }]);
  world.F = staffWith([{}], "deactivated");
  world.G = staffWith([]);
  world.H = newAccount();
  sql(
    `insert into public.client_profiles (id, user_id) values ('${uid()}', '${world.H.user}');`,
  );
  world.admin = staffWith([{ capability: "manage_staff_capabilities" }]);
  world.K = staffWith([]);
}

const config = (extra = {}) => ({ schema: 1, ...extra });
const jsonLit = (value) =>
  value === null ? "null::jsonb" : `${lit(JSON.stringify(value))}::jsonb`;
const intLit = (value) => (value === null ? "null::integer" : String(value));

const SAVE_SQL = (theme, expected, configuration) =>
  `select row_to_json(x)::text from public.staff_save_site_appearance_draft(${lit(theme)}, ${intLit(expected)}, ${typeof configuration === "string" ? configuration : jsonLit(configuration)}) x;`;
const PUBLISH_SQL = (theme, draft, expected, label = null) =>
  `select row_to_json(x)::text from public.staff_publish_site_appearance(${lit(theme)}, ${draft === null ? "null::uuid" : `${lit(draft)}::uuid`}, ${intLit(expected)}, ${label === null ? "null::text" : lit(label)}) x;`;
const RESTORE_SQL = (version, expected) =>
  `select row_to_json(x)::text from public.staff_restore_site_appearance(${version === null ? "null::uuid" : `${lit(version)}::uuid`}, ${intLit(expected)}) x;`;
const RESET_SQL = (theme, expected) =>
  `select row_to_json(x)::text from public.staff_reset_site_appearance(${lit(theme)}, ${intLit(expected)}) x;`;
const DISCARD_SQL = (draft, expected) =>
  `select public.staff_discard_site_appearance_draft(${draft === null ? "null::uuid" : `${lit(draft)}::uuid`}, ${intLit(expected)});`;
const UPLOAD_SQL = (type, width, height, base64) =>
  `select row_to_json(x)::text from public.staff_upload_site_appearance_asset(${lit(type)}, ${intLit(width)}, ${intLit(height)}, ${base64 === null ? "null::text" : lit(base64)}) x;`;

const OVERVIEW_SQL = (theme = THEME) =>
  `select row_to_json(x)::text from public.staff_site_appearance_overview(${lit(theme)}) x;`;
const VERSIONS_SQL = (offset, theme = THEME) =>
  `select row_to_json(x)::text from public.staff_site_appearance_versions(${lit(theme)}, ${intLit(offset)}) x;`;
const VERSION_SQL = (id) =>
  `select row_to_json(x)::text from public.staff_site_appearance_version(${lit(id)}::uuid) x;`;
const PREVIEW_SQL = (theme = THEME) =>
  `select row_to_json(x)::text from public.staff_site_appearance_preview(${lit(theme)}) x;`;
const ASSETS_SQL = (offset) =>
  `select row_to_json(x)::text from public.staff_site_appearance_assets(${intLit(offset)}) x;`;
const ASSET_SQL = (sha) =>
  `select row_to_json(x)::text from public.staff_site_appearance_asset(${lit(sha)}) x;`;
const PUBLIC_SQL =
  "select row_to_json(x)::text from public.public_site_appearance() x;";
const PUBLIC_ASSET_SQL = (sha) =>
  `select row_to_json(x)::text from public.public_site_appearance_asset(${lit(sha)}) x;`;

// The audit expected of each successful command (section 4.6 of the studio spec):
// action, resource type, resource id, before keys (null: no snapshot), after
// keys, actor.
const AUDIT_SHAPES = Object.freeze({
  created: [
    "site_appearance.draft_created",
    null,
    "based_on_version_id,configuration_sha256,revision,theme_key",
  ],
  saved: [
    "site_appearance.draft_saved",
    "configuration_sha256,revision",
    "configuration_sha256,revision",
  ],
  published: [
    "site_appearance.published",
    "superseded_version_id",
    "configuration_sha256,label_present,theme_key,version_number",
  ],
  restored: [
    "site_appearance.restored",
    "configuration_sha256,revision",
    "configuration_sha256,from_version_id,revision",
  ],
  restored_new: [
    "site_appearance.restored",
    null,
    "configuration_sha256,from_version_id,revision",
  ],
  reset: [
    "site_appearance.reset",
    "configuration_sha256,revision",
    "configuration_sha256,revision",
  ],
  reset_new: ["site_appearance.reset", null, "configuration_sha256,revision"],
  discarded: ["site_appearance.draft_discarded", "revision", "state"],
  stored: [
    "site_appearance.asset_uploaded",
    null,
    "byte_size,height,media_type,sha256,width",
  ],
});

function expectAudit(kind, resourceId, actor) {
  const [action, before, after] = AUDIT_SHAPES[kind];
  world.audits.push(
    [
      action,
      kind === "stored" ? "site_appearance_asset" : "site_appearance_version",
      resourceId,
      before ?? "-",
      after,
      actor.user,
    ].join("|"),
  );
}

// One command as the given account; the parsed row (or text outcome). A
// successful outcome records the audit it must leave.
function command(account, statement, options = {}) {
  const line = as("authenticated", account.auth, statement, options);
  assert.doesNotMatch(line, /^ERROR/, `${statement}: ${line}`);
  return line.startsWith("{") ? JSON.parse(line) : line;
}

function save(account, expected, configuration, theme = THEME) {
  const row = command(account, SAVE_SQL(theme, expected, configuration));
  if (row.outcome === "created" || row.outcome === "saved") {
    expectAudit(row.outcome, row.version_id, account);
  }
  return row;
}
function publish(account, draft, expected, label = null, theme = THEME) {
  const row = command(account, PUBLISH_SQL(theme, draft, expected, label));
  if (row.outcome === "published") {
    expectAudit("published", row.version_id, account);
  }
  return row;
}
function restore(account, version, expected) {
  const row = command(account, RESTORE_SQL(version, expected));
  if (row.outcome === "restored") {
    expectAudit(
      expected === null ? "restored_new" : "restored",
      row.version_id,
      account,
    );
  }
  return row;
}
function reset(account, expected, theme = THEME) {
  const row = command(account, RESET_SQL(theme, expected));
  if (row.outcome === "reset") {
    expectAudit(
      expected === null ? "reset_new" : "reset",
      row.version_id,
      account,
    );
  }
  return row;
}
function discard(account, draft, expected) {
  const outcome = command(account, DISCARD_SQL(draft, expected));
  if (outcome === "discarded") {
    expectAudit("discarded", draft, account);
  }
  return outcome;
}
function upload(account, type, width, height, bytes) {
  const row = command(
    account,
    UPLOAD_SQL(
      type,
      width,
      height,
      Buffer.isBuffer(bytes) ? bytes.toString("base64") : bytes,
    ),
  );
  if (row.outcome === "stored") {
    expectAudit("stored", row.asset_id, account);
  }
  return row;
}

const read = (account, statement, options = {}) =>
  rowsAs("authenticated", account.auth, statement, options).map((r) =>
    JSON.parse(r),
  );
const readAnon = (statement) =>
  rowsAs("anon", null, statement).map((r) => JSON.parse(r));
const overviewOf = (account = world.A) => {
  const rows = read(account, OVERVIEW_SQL());
  assert.equal(rows.length, 1);
  return rows[0];
};

const rowOf = (statement) => JSON.parse(sql(statement) || "null");
const versionRow = (id) =>
  rowOf(
    `select row_to_json(v)::text from public.site_appearance_versions v where id = '${id}';`,
  );
const activation = () =>
  rowOf(
    "select row_to_json(a)::text from public.site_appearance_activation a;",
  );
const counts = () =>
  sql(
    "select (select count(*) from public.site_appearance_versions) || '|' || (select count(*) from public.site_appearance_assets) || '|' || (select count(*) from public.site_appearance_activation) || '|' || (select count(*) from public.audit_events) || '|' || (select coalesce(max(revision), 0) || ':' || coalesce(string_agg(configuration_sha256, ',' order by id), '') from public.site_appearance_versions);",
  );
const configurationDigest = (configuration) =>
  sql(
    `select encode(sha256(convert_to(${jsonLit(configuration)}::text, 'UTF8')), 'hex');`,
  );

// ---------------------------------------------------------------------------
// MIG: the migration, the catalog it leaves, privileges
// ---------------------------------------------------------------------------

const CATALOG_QUERIES = Object.freeze({
  relations:
    "select coalesce(string_agg(relkind::text || ':' || relname || ':' || relrowsecurity::text || ':' || relforcerowsecurity::text, '|' order by relname), '') from pg_class where relnamespace = 'public'::regnamespace;",
  columns:
    "select coalesce(string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), '|' order by table_name, ordinal_position), '') from information_schema.columns where table_schema = 'public';",
  constraints:
    "select coalesce(string_agg(conrelid::regclass::text || '.' || conname || ':' || contype::text, '|' order by conrelid::regclass::text, conname), '') from pg_constraint where connamespace = 'public'::regnamespace;",
  constraint_definitions:
    "select coalesce(string_agg(conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid), '|' order by conrelid::regclass::text, conname), '') from pg_constraint where connamespace = 'public'::regnamespace;",
  indexes:
    "select coalesce(string_agg(indexdef, '|' order by indexname), '') from pg_indexes where schemaname = 'public';",
  triggers:
    "select coalesce(string_agg(tgrelid::regclass::text || '.' || tgname || ':' || pg_get_triggerdef(oid), '|' order by tgrelid::regclass::text, tgname), '') from pg_trigger where not tgisinternal;",
  policies:
    "select coalesce(string_agg(tablename || '.' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), '|' order by tablename, policyname), '') from pg_policies where schemaname = 'public';",
  types:
    "select coalesce(string_agg(typname, '|' order by typname), '') from pg_type where typnamespace = 'public'::regnamespace;",
  views:
    "select coalesce(string_agg(viewname, '|' order by viewname), '') from pg_views where schemaname = 'public';",
  sequences:
    "select coalesce(string_agg(sequencename, '|' order by sequencename), '') from pg_sequences where schemaname = 'public';",
  policy_types:
    "select coalesce(string_agg(code, '|' order by code), '') from public.policy_types;",
  capability_codes:
    "select coalesce(string_agg(capability_code, '|' order by capability_code), '') from public.capability_definitions;",
  table_grants:
    "select coalesce(string_agg(table_name || ':' || grantee || ':' || privilege_type, '|' order by table_name, grantee, privilege_type), '') from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC');",
  default_privileges:
    "select coalesce(string_agg(defaclrole::regrole::text || ':' || defaclobjtype::text || ':' || array_to_string(defaclacl, ';'), '|' order by defaclrole::regrole::text, defaclobjtype), '') from pg_default_acl;",
  // Every function the migration did not create: its definition, privileges
  // and comment are unchanged.
  existing_functions: `select coalesce(string_agg(p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(array_to_string(p.proacl, ';'), '') || ':' || md5(coalesce(obj_description(p.oid, 'pg_proc'), '')), '|' order by p.oid::regprocedure::text), '') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p') and p.proname not in (${FUNCTION_NAMES.map((n) => `'${n}'`).join(", ")});`,
  functions:
    "select coalesce(string_agg(p.oid::regprocedure::text, '|' order by p.oid::regprocedure::text), '') from pg_proc p where p.pronamespace = 'public'::regnamespace;",
});

// What one listing gained and lost from the base database to the main one.
function listingDelta(name) {
  const before = sql(CATALOG_QUERIES[name], BASE_DB).split("|").filter(Boolean);
  const after = sql(CATALOG_QUERIES[name]).split("|").filter(Boolean);
  const had = new Set(before);
  const has = new Set(after);
  return {
    added: after.filter((entry) => !had.has(entry)).sort(),
    removed: before.filter((entry) => !has.has(entry)).sort(),
  };
}

const EXPECTED_RELATIONS = Object.freeze(
  [
    "i:site_appearance_activation_pkey:false:false",
    "i:site_appearance_assets_list_idx:false:false",
    "i:site_appearance_assets_pkey:false:false",
    "i:site_appearance_assets_sha256_key:false:false",
    "i:site_appearance_versions_list_idx:false:false",
    "i:site_appearance_versions_number_idx:false:false",
    "i:site_appearance_versions_one_draft_idx:false:false",
    "i:site_appearance_versions_one_published_idx:false:false",
    "i:site_appearance_versions_pkey:false:false",
    "r:site_appearance_activation:true:false",
    "r:site_appearance_assets:true:false",
    "r:site_appearance_versions:true:false",
  ].sort(),
);

const EXPECTED_COLUMNS = Object.freeze(
  [
    "site_appearance_activation.singleton:boolean:NO:",
    "site_appearance_activation.theme_key:text:NO:",
    "site_appearance_activation.activated_by_user_id:uuid:NO:",
    "site_appearance_activation.activated_at:timestamp with time zone:NO:",
    "site_appearance_assets.id:uuid:NO:gen_random_uuid()",
    "site_appearance_assets.sha256:text:NO:",
    "site_appearance_assets.media_type:text:NO:",
    "site_appearance_assets.byte_size:integer:NO:",
    "site_appearance_assets.width:integer:NO:",
    "site_appearance_assets.height:integer:NO:",
    "site_appearance_assets.content:bytea:NO:",
    "site_appearance_assets.created_by_user_id:uuid:NO:",
    "site_appearance_assets.created_at:timestamp with time zone:NO:",
    "site_appearance_versions.id:uuid:NO:gen_random_uuid()",
    "site_appearance_versions.theme_key:text:NO:",
    "site_appearance_versions.state:text:NO:",
    "site_appearance_versions.version_number:integer:YES:",
    "site_appearance_versions.configuration:jsonb:NO:",
    "site_appearance_versions.configuration_sha256:text:NO:",
    "site_appearance_versions.schema_version:integer:NO:",
    "site_appearance_versions.revision:integer:NO:",
    "site_appearance_versions.based_on_version_id:uuid:YES:",
    "site_appearance_versions.label:text:YES:",
    "site_appearance_versions.created_by_user_id:uuid:NO:",
    "site_appearance_versions.created_at:timestamp with time zone:NO:",
    "site_appearance_versions.updated_by_user_id:uuid:NO:",
    "site_appearance_versions.updated_at:timestamp with time zone:NO:",
    "site_appearance_versions.published_by_user_id:uuid:YES:",
    "site_appearance_versions.published_at:timestamp with time zone:YES:",
    "site_appearance_versions.superseded_at:timestamp with time zone:YES:",
    "site_appearance_versions.discarded_at:timestamp with time zone:YES:",
  ].sort(),
);

const EXPECTED_CONSTRAINTS = Object.freeze(
  [
    "site_appearance_activation.site_appearance_activation_activated_by_user_id_fkey:f",
    "site_appearance_activation.site_appearance_activation_pkey:p",
    "site_appearance_activation.site_appearance_activation_singleton_check:c",
    "site_appearance_activation.site_appearance_activation_theme_check:c",
    "site_appearance_assets.site_appearance_assets_created_by_user_id_fkey:f",
    "site_appearance_assets.site_appearance_assets_digest_check:c",
    "site_appearance_assets.site_appearance_assets_dimensions_check:c",
    "site_appearance_assets.site_appearance_assets_pkey:p",
    "site_appearance_assets.site_appearance_assets_sha256_key:u",
    "site_appearance_assets.site_appearance_assets_sha_check:c",
    "site_appearance_assets.site_appearance_assets_signature_check:c",
    "site_appearance_assets.site_appearance_assets_size_check:c",
    "site_appearance_assets.site_appearance_assets_type_check:c",
    "site_appearance_versions.site_appearance_versions_based_on_version_id_fkey:f",
    "site_appearance_versions.site_appearance_versions_created_by_user_id_fkey:f",
    "site_appearance_versions.site_appearance_versions_digest_check:c",
    "site_appearance_versions.site_appearance_versions_label_check:c",
    "site_appearance_versions.site_appearance_versions_lifecycle_check:c",
    "site_appearance_versions.site_appearance_versions_number_check:c",
    "site_appearance_versions.site_appearance_versions_pkey:p",
    "site_appearance_versions.site_appearance_versions_published_by_user_id_fkey:f",
    "site_appearance_versions.site_appearance_versions_revision_check:c",
    "site_appearance_versions.site_appearance_versions_schema_check:c",
    "site_appearance_versions.site_appearance_versions_sha_check:c",
    "site_appearance_versions.site_appearance_versions_shape_check:c",
    "site_appearance_versions.site_appearance_versions_state_check:c",
    "site_appearance_versions.site_appearance_versions_theme_key_check:c",
    "site_appearance_versions.site_appearance_versions_updated_by_user_id_fkey:f",
  ].sort(),
);

const EXPECTED_INDEXES = Object.freeze(
  [
    "CREATE INDEX site_appearance_assets_list_idx ON public.site_appearance_assets USING btree (created_at DESC, id)",
    "CREATE INDEX site_appearance_versions_list_idx ON public.site_appearance_versions USING btree (theme_key, created_at DESC, id)",
    "CREATE UNIQUE INDEX site_appearance_activation_pkey ON public.site_appearance_activation USING btree (singleton)",
    "CREATE UNIQUE INDEX site_appearance_assets_pkey ON public.site_appearance_assets USING btree (id)",
    "CREATE UNIQUE INDEX site_appearance_assets_sha256_key ON public.site_appearance_assets USING btree (sha256)",
    "CREATE UNIQUE INDEX site_appearance_versions_number_idx ON public.site_appearance_versions USING btree (theme_key, version_number) WHERE (version_number IS NOT NULL)",
    "CREATE UNIQUE INDEX site_appearance_versions_one_draft_idx ON public.site_appearance_versions USING btree (theme_key) WHERE (state = 'draft'::text)",
    "CREATE UNIQUE INDEX site_appearance_versions_one_published_idx ON public.site_appearance_versions USING btree (theme_key) WHERE (state = 'published'::text)",
    "CREATE UNIQUE INDEX site_appearance_versions_pkey ON public.site_appearance_versions USING btree (id)",
  ].sort(),
);

const EXPECTED_TRIGGERS = Object.freeze(
  [
    "site_appearance_assets.site_appearance_assets_guard:CREATE TRIGGER site_appearance_assets_guard BEFORE DELETE OR UPDATE ON public.site_appearance_assets FOR EACH ROW EXECUTE FUNCTION site_appearance_assets_guard()",
    "site_appearance_assets.site_appearance_assets_no_truncate:CREATE TRIGGER site_appearance_assets_no_truncate BEFORE TRUNCATE ON public.site_appearance_assets FOR EACH STATEMENT EXECUTE FUNCTION site_appearance_assets_guard()",
    "site_appearance_versions.site_appearance_versions_guard:CREATE TRIGGER site_appearance_versions_guard BEFORE INSERT OR DELETE OR UPDATE ON public.site_appearance_versions FOR EACH ROW EXECUTE FUNCTION site_appearance_versions_guard()",
    "site_appearance_versions.site_appearance_versions_no_truncate:CREATE TRIGGER site_appearance_versions_no_truncate BEFORE TRUNCATE ON public.site_appearance_versions FOR EACH STATEMENT EXECUTE FUNCTION site_appearance_versions_guard()",
  ].sort(),
);

const executors = (signature) =>
  sql(
    `select coalesce(string_agg(r.rolname, ',' order by r.rolname), '') from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') and has_function_privilege(r.rolname, 'public.${signature}', 'execute');`,
  );

async function migrationChecks() {
  await check(
    "MIG-1 the site appearance migration directly follows the DEV-001 workspace reads, its bytes are the pinned bytes, it is registered as sequence 79 (depends on the workspace reads, the Program work item and decision, a valid lifecycle) with every later migration registered, it applies without notices, and outside its function bodies it holds only the creation of its three relations, their row level security, indexes and triggers, the eighteen functions, revocations, the privileges block, one capability catalogue insert and comments (no replace, alter of an existing object, drop, policy, view, sequence, type or default)",
    () => {
      assert.equal(report.migrations.sha256, OWN_SHA256);
      assert.deepEqual(report.migrations.notices, []);
      const raw = fs.readFileSync(path.join(MIGRATIONS, OWN_MIGRATION), "utf8");
      const outside = raw
        .replace(/\$function\$[\s\S]*?\$function\$/g, "BODY")
        .replace(/\$privileges\$[\s\S]*?\$privileges\$/g, "BODY")
        .replace(/--[^\n]*/g, "")
        .replace(/'(?:[^']|'')*'/g, "''");
      const statements = outside
        .split(";")
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const allowed = [
        /^create function public\.[a-z_]+\(/,
        /^create table public\.site_appearance_(versions|assets|activation) \(/,
        /^alter table public\.site_appearance_(versions|assets|activation) enable row level security$/,
        /^create (unique )?index site_appearance_[a-z_]+ on public\.site_appearance_(versions|assets) /,
        /^create trigger site_appearance_[a-z_]+ before [a-z ]+ on public\.site_appearance_(versions|assets) for each (row|statement) execute function public\.site_appearance_(versions|assets)_guard\(\)$/,
        /^revoke all on table public\.site_appearance_(versions|assets|activation) from public, anon, authenticated, service_role$/,
        /^insert into public\.capability_definitions \(capability_code\) values \(''\)$/,
        /^do BODY$/,
        /^comment on (table|column|function) public\.site_appearance_|^comment on function public\.(public|staff)_[a-z_]+\(/,
      ];
      const stray = statements.filter(
        (s) => !allowed.some((pattern) => pattern.test(s)),
      );
      assert.deepEqual(stray, []);
      assert.match(
        raw,
        /^insert into public\.capability_definitions \(capability_code\)\nvalues \('manage_site_appearance'\);$/m,
      );
      assert.equal(
        raw.match(/insert into public\.capability_definitions/g).length,
        1,
      );
      assert.doesNotMatch(
        outside,
        /create\s+or\s+replace|alter\s+function|drop\s|alter\s+default|create\s+policy|create\s+view|create\s+sequence|create\s+type/i,
      );
      const created = [
        ...raw.matchAll(/^create function public\.([a-z_0-9]+)\(/gm),
      ].map((match) => match[1]);
      assert.deepEqual([...created].sort(), [...FUNCTION_NAMES].sort());
      // A53: the catalogue code is stated as pending owner confirmation.
      assert.match(raw, /Pending owner confirmation \(decision register A53\)/);
      return {
        sha256: report.migrations.sha256,
        registration: report.migrations.registration,
      };
    },
  );

  await check(
    "MIG-2 the catalog the migration leaves differs from the catalog before it by exactly the three relations (row level security on, not forced) with their named columns, types, nullability and defaults, their named constraints and indexes, the four guard triggers, their row types, one capability code and the eighteen functions; no row policy, view, sequence, policy type, table grant to an API role or default privilege is added, nothing is removed, and every existing function's definition, privileges and comment is unchanged",
    () => {
      const deltas = Object.fromEntries(
        Object.keys(CATALOG_QUERIES)
          .filter((name) => name !== "constraint_definitions")
          .map((name) => [name, listingDelta(name)]),
      );
      const none = { added: [], removed: [] };
      assert.deepEqual(deltas.relations, {
        added: [...EXPECTED_RELATIONS],
        removed: [],
      });
      assert.deepEqual(deltas.columns, {
        added: [...EXPECTED_COLUMNS].sort(),
        removed: [],
      });
      assert.deepEqual(deltas.constraints, {
        added: [...EXPECTED_CONSTRAINTS],
        removed: [],
      });
      assert.deepEqual(deltas.indexes, {
        added: [...EXPECTED_INDEXES],
        removed: [],
      });
      assert.deepEqual(deltas.triggers, {
        added: [...EXPECTED_TRIGGERS],
        removed: [],
      });
      assert.deepEqual(deltas.types, {
        added: TABLES.flatMap((t) => [t, `_${t}`]).sort(),
        removed: [],
      });
      assert.deepEqual(deltas.capability_codes, {
        added: [CAPABILITY],
        removed: [],
      });
      for (const name of [
        "policies",
        "views",
        "sequences",
        "policy_types",
        "table_grants",
        "default_privileges",
        "existing_functions",
      ]) {
        assert.deepEqual(deltas[name], none, name);
      }
      assert.deepEqual(deltas.functions, {
        added: Object.keys(FUNCTIONS)
          .map((signature) => signature.replaceAll(", ", ","))
          .sort(),
        removed: [],
      });
      // The constraint definitions that carry the storage rules.
      const definitions = listingDelta("constraint_definitions").added.join(
        "\n",
      );
      for (const fragment of [
        "site_appearance_versions_shape_check:CHECK (site_appearance_shape_valid(configuration))",
        "site_appearance_versions_digest_check:CHECK ((configuration_sha256 = encode(sha256(convert_to((configuration)::text, 'UTF8'::name)), 'hex'::text)))",
        "site_appearance_assets_digest_check:CHECK ((encode(sha256(content), 'hex'::text) = sha256))",
        "site_appearance_assets_type_check:CHECK ((media_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text])))",
        "site_appearance_assets_size_check:CHECK ((((byte_size >= 1) AND (byte_size <= 900000)) AND (octet_length(content) = byte_size)))",
        "site_appearance_assets_dimensions_check:CHECK ((((width >= 16) AND (width <= 4096)) AND ((height >= 16) AND (height <= 4096))))",
        "site_appearance_activation_singleton_check:CHECK (singleton)",
      ]) {
        assert.ok(definitions.includes(fragment), fragment);
      }
      return {
        functions: deltas.functions.added.length,
        relations: TABLES,
      };
    },
  );

  await check(
    "MIG-3 each of the eighteen functions has exactly its argument list, result, volatility, language, security mode and pinned configuration (search_path pg_catalog, pg_temp; commands also lock_timeout 3s) and a DEV-001 comment; the four internal functions are executable by no API role, the two public reads by anon and authenticated only, the twelve staff functions by authenticated only; public holds nothing",
    () => {
      const detail = {};
      for (const [signature, shape] of Object.entries(FUNCTIONS)) {
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
        assert.equal(definer, String(shape.definer), signature);
        assert.equal(config, shape.config, signature);
        assert.equal(volatility, shape.volatility, signature);
        assert.equal(language, shape.language, signature);
        assert.equal(args, shape.args, signature);
        assert.equal(result, shape.result, signature);
        assert.equal(publicGrant, "false", signature);
        assert.match(
          comment,
          /^DEV-001 website and appearance studio/,
          signature,
        );
        assert.equal(executors(signature), shape.executors, signature);
        detail[signature] = shape.executors || "no API role";
      }
      return detail;
    },
  );

  await check(
    "MIG-4 a freshly migrated database holds no appearance version, asset, activation or manage_site_appearance grant; no API role holds any privilege on the three relations and direct reads and writes by anon, authenticated and service_role are refused",
    () => {
      assert.equal(world.fresh, "0|0|0|0");
      for (const table of TABLES) {
        for (const role of ["anon", "authenticated", "service_role"]) {
          assert.equal(
            sql(
              `select has_table_privilege('${role}', 'public.${table}', 'select') or has_table_privilege('${role}', 'public.${table}', 'insert') or has_table_privilege('${role}', 'public.${table}', 'update') or has_table_privilege('${role}', 'public.${table}', 'delete') or has_table_privilege('${role}', 'public.${table}', 'truncate') or has_table_privilege('${role}', 'public.${table}', 'references') or has_table_privilege('${role}', 'public.${table}', 'trigger');`,
            ),
            "f",
            `${role} ${table}`,
          );
          assert.equal(
            as(
              role,
              role === "authenticated" ? world.A.auth : null,
              `select count(*) from public.${table};`,
            ),
            "ERROR 42501",
            `${role} reads ${table}`,
          );
        }
      }
      assert.equal(
        as(
          "authenticated",
          world.A.auth,
          `insert into public.site_appearance_activation (singleton, theme_key, activated_by_user_id, activated_at) values (true, 'rosuno', '${world.A.user}', now());`,
        ),
        "ERROR 42501",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// GRANT: the catalogue code works with the existing audited grant flow
// ---------------------------------------------------------------------------

async function grantChecks() {
  await check(
    "GRANT-1 (A53) manage_site_appearance is granted only through the existing audited staff_grant_capability: a holder of manage_staff_capabilities grants it to another active staff member (audited), never to themselves; the grantee then reads the studio overview, which answered nothing before",
    () => {
      assert.equal(read(world.K, OVERVIEW_SQL()).length, 0);
      const self = as(
        "authenticated",
        world.admin.auth,
        `select outcome from public.staff_grant_capability('${world.admin.user}', 'manage_site_appearance', null, null);`,
      );
      assert.equal(self, "self_grant_refused");
      const granted = JSON.parse(
        as(
          "authenticated",
          world.admin.auth,
          `select row_to_json(x)::text from public.staff_grant_capability('${world.K.user}', 'manage_site_appearance', null, null) x;`,
        ),
      );
      assert.equal(granted.outcome, "created");
      assert.equal(
        sql(
          `select count(*) from public.audit_events where action_code = 'capability_grant.granted' and resource_id = '${granted.grant_id}' and after_snapshot ->> 'capability_code' = 'manage_site_appearance';`,
        ),
        "1",
      );
      const overview = read(world.K, OVERVIEW_SQL());
      assert.equal(overview.length, 1);
      assert.equal(overview[0].draft_id, null);
      assert.equal(overview[0].published_id, null);
      assert.equal(overview[0].active_theme_key, null);
      return { grant: granted.outcome };
    },
  );
}

// ---------------------------------------------------------------------------
// LIFE: the version lifecycle
// ---------------------------------------------------------------------------

const FIRST = config({
  tokens: { site: { ink: "#1c1917", accent: "#0f5f5a", radius: 10 } },
  type: { "type.display": { size: { desktop: 72, tablet: 56 } } },
  roles: {
    "role.button.primary": {
      border: { radius: 999 },
      typography: { weight: 600 },
    },
  },
  components: {
    "home.ways": {
      background: { type: "color", color: "#f6f5f2" },
      spacing: { padding: { desktop: { top: 96, bottom: 96 } } },
    },
  },
  slots: { "home.ways.title": "Talk now, or plan ahead." },
  sections: {
    "home.sections": {
      order: [
        "home.available",
        "home.how",
        "home.ways",
        "home.issues",
        "home.attorneys",
      ],
      hidden: ["home.attorneys"],
    },
  },
});
const SECOND = config({ tokens: { site: { accent: "#2f3a9e", radius: 12 } } });

async function lifecycleChecks() {
  await check(
    "LIFE-1 a holder creates the draft (no expected revision; revision 1, based on nothing), saves it at revision 1 (revision 2), is refused a stale save (conflict) and an unexpected creation (conflict), and publishes revision 2 as version 1: the activation names the theme, the overview shows no draft, and the public read (anon and authenticated) answers exactly version 1 and its configuration",
    () => {
      assert.equal(
        readAnon(PUBLIC_SQL).length,
        0,
        "nothing before publication",
      );
      const created = save(world.A, null, config());
      assert.equal(created.outcome, "created");
      assert.equal(created.revision, 1);
      const draft = created.version_id;
      assert.equal(versionRow(draft).based_on_version_id, null);
      assert.equal(
        versionRow(draft).configuration_sha256,
        configurationDigest(config()),
      );
      assert.deepEqual(save(world.A, null, FIRST), {
        outcome: "conflict",
        version_id: null,
        revision: null,
      });
      const saved = save(world.A, 1, FIRST);
      assert.deepEqual(saved, {
        outcome: "saved",
        version_id: draft,
        revision: 2,
      });
      assert.deepEqual(save(world.A, 1, FIRST).outcome, "conflict");
      assert.deepEqual(save(world.A, 3, FIRST).outcome, "conflict");
      const preview = read(world.A, PREVIEW_SQL());
      assert.deepEqual(preview, [
        { version_id: draft, revision: 2, configuration: FIRST },
      ]);
      assert.equal(readAnon(PUBLIC_SQL).length, 0, "a draft is never public");
      const published = publish(world.A, draft, 2, "Synthetic first version");
      assert.deepEqual(published, {
        outcome: "published",
        version_id: draft,
        version_number: 1,
      });
      const row = versionRow(draft);
      assert.equal(row.state, "published");
      assert.equal(row.published_by_user_id, world.A.user);
      assert.equal(row.label, "Synthetic first version");
      assert.equal(row.revision, 2);
      assert.equal(activation().theme_key, THEME);
      assert.equal(activation().activated_by_user_id, world.A.user);
      const overview = overviewOf();
      assert.equal(overview.draft_id, null);
      assert.equal(overview.published_id, draft);
      assert.equal(overview.published_version_number, 1);
      assert.deepEqual(overview.published_configuration, FIRST);
      assert.equal(overview.active_theme_key, THEME);
      for (const rows of [
        readAnon(PUBLIC_SQL),
        read(world.H, PUBLIC_SQL, AAL1),
        read(world.G, PUBLIC_SQL),
      ]) {
        assert.equal(rows.length, 1);
        assert.equal(rows[0].version_id, draft);
        assert.equal(rows[0].version_number, 1);
        assert.equal(rows[0].theme_key, THEME);
        assert.deepEqual(rows[0].configuration, FIRST);
        assert.equal(rows[0].configuration_sha256, configurationDigest(FIRST));
      }
      assert.deepEqual(read(world.A, PREVIEW_SQL()), [
        { version_id: draft, revision: null, configuration: FIRST },
      ]);
      world.v1 = draft;
    },
  );

  await check(
    "LIFE-2 a second draft is based on version 1 and publishes as version 2 (version 1 superseded, still readable to holders, the public read answers version 2 only); restoring version 1 creates the draft from it (revision 1, based on version 1) and again overwrites it at revision 1; reset makes the draft the empty configuration; discard ends it (not_found afterwards) and a new draft may follow; restores of a draft, a discarded version or an unknown id and publications of another theme's or an unknown draft, a stale revision or a malformed label are refused with their outcomes and change nothing",
    () => {
      const created = save(world.A2, null, SECOND);
      assert.equal(created.outcome, "created");
      const draft = created.version_id;
      assert.equal(versionRow(draft).based_on_version_id, world.v1);
      assert.equal(publish(world.A2, draft, 2).outcome, "conflict");
      assert.equal(publish(world.A2, uid(), 1).outcome, "not_found");
      assert.equal(
        publish(world.A2, draft, 1, null, "other-theme").outcome,
        "not_found",
      );
      assert.equal(
        publish(world.A2, draft, 1, "x".repeat(81)).outcome,
        "invalid",
      );
      assert.equal(
        publish(world.A2, draft, 1, "bad\u0007label").outcome,
        "invalid",
      );
      assert.equal(publish(world.A2, draft, null).outcome, "invalid");
      assert.equal(publish(world.A2, null, 1).outcome, "invalid");
      const published = publish(world.A2, draft, 1);
      assert.deepEqual(published, {
        outcome: "published",
        version_id: draft,
        version_number: 2,
      });
      const old = versionRow(world.v1);
      assert.equal(old.state, "superseded");
      assert.ok(old.superseded_at !== null);
      assert.equal(old.version_number, 1);
      assert.equal(versionRow(draft).label, null);
      const pub = readAnon(PUBLIC_SQL);
      assert.equal(pub.length, 1);
      assert.equal(pub[0].version_id, draft);
      assert.equal(pub[0].version_number, 2);
      assert.deepEqual(
        read(world.A, VERSION_SQL(world.v1))[0].configuration,
        FIRST,
      );
      world.v2 = draft;

      // Restore version 1: created (no draft), then overwritten at revision 1.
      assert.equal(restore(world.A, world.v1, 1).outcome, "conflict");
      const restored = restore(world.A, world.v1, null);
      assert.equal(restored.outcome, "restored");
      assert.equal(restored.revision, 1);
      const r = versionRow(restored.version_id);
      assert.deepEqual(r.configuration, FIRST);
      assert.equal(r.based_on_version_id, world.v1);
      assert.equal(r.state, "draft");
      assert.equal(restore(world.A, world.v2, null).outcome, "conflict");
      const again = restore(world.A, world.v2, 1);
      assert.deepEqual(again, {
        outcome: "restored",
        version_id: restored.version_id,
        revision: 2,
      });
      assert.deepEqual(versionRow(restored.version_id).configuration, SECOND);
      assert.equal(
        versionRow(restored.version_id).based_on_version_id,
        world.v2,
      );
      assert.equal(restore(world.A, restored.version_id, 2).outcome, "invalid");
      assert.equal(restore(world.A, uid(), 2).outcome, "not_found");
      assert.equal(restore(world.A, null, 2).outcome, "invalid");

      // Reset, then discard.
      assert.equal(reset(world.A, 1).outcome, "conflict");
      const wasReset = reset(world.A, 2);
      assert.deepEqual(wasReset, {
        outcome: "reset",
        version_id: restored.version_id,
        revision: 3,
      });
      assert.deepEqual(versionRow(restored.version_id).configuration, {
        schema: 1,
      });
      assert.equal(reset(world.A, 3, "Not-a-theme").outcome, "invalid");
      assert.equal(discard(world.A, restored.version_id, 2), "conflict");
      assert.equal(discard(world.A, restored.version_id, null), "invalid");
      assert.equal(discard(world.A, restored.version_id, 3), "discarded");
      assert.equal(versionRow(restored.version_id).state, "discarded");
      assert.equal(discard(world.A, restored.version_id, 3), "not_found");
      assert.equal(
        restore(world.A, restored.version_id, null).outcome,
        "invalid",
      );
      assert.equal(
        publish(world.A, restored.version_id, 3).outcome,
        "not_found",
      );
      const overview = overviewOf();
      assert.equal(overview.draft_id, null);
      assert.equal(overview.published_id, world.v2);

      // A reset with no draft creates one; a new draft after discard is allowed.
      const fresh = reset(world.A, null);
      assert.equal(fresh.outcome, "reset");
      assert.equal(fresh.revision, 1);
      assert.equal(versionRow(fresh.version_id).based_on_version_id, world.v2);
      assert.equal(discard(world.A, fresh.version_id, 1), "discarded");
      const next = save(world.A, null, FIRST);
      assert.equal(next.outcome, "created");
      world.draft = next;
      return {
        versions: sql("select count(*) from public.site_appearance_versions;"),
      };
    },
  );

  await check(
    "LIFE-3 the version list pages 25 rows plus one, newest first, without configurations, offsets 0 to 100000 (outside answers nothing); one version reads with its configuration; another theme's versions stay apart",
    () => {
      // Twenty-six more published versions of a second synthetic theme.
      let latest = null;
      for (let i = 0; i < 26; i += 1) {
        const draft = save(
          world.A,
          null,
          config({ tokens: { site: { radius: 6 + (i % 17) } } }),
          "synthetic-two",
        );
        latest = publish(world.A, draft.version_id, 1, null, "synthetic-two");
        assert.equal(latest.outcome, "published");
      }
      assert.equal(latest.version_number, 26);
      assert.equal(activation().theme_key, "synthetic-two");
      const first = read(world.A, VERSIONS_SQL(0, "synthetic-two"));
      assert.equal(first.length, 26);
      assert.equal(first[0].version_id, latest.version_id);
      assert.equal(first[0].state, "published");
      assert.ok(first.slice(1).every((row) => row.state === "superseded"));
      assert.ok(first.every((row) => !("configuration" in row)));
      for (let i = 1; i < first.length; i += 1) {
        assert.ok(first[i - 1].created_at >= first[i].created_at);
      }
      assert.equal(read(world.A, VERSIONS_SQL(25, "synthetic-two")).length, 1);
      assert.equal(read(world.A, VERSIONS_SQL(-1, "synthetic-two")).length, 0);
      assert.equal(
        read(world.A, VERSIONS_SQL(100001, "synthetic-two")).length,
        0,
      );
      assert.equal(
        read(world.A, VERSIONS_SQL(null, "synthetic-two")).length,
        0,
      );
      const own = read(world.A, VERSIONS_SQL(0));
      assert.ok(own.every((row) => row.version_id !== latest.version_id));
      // The rosuno theme becomes active again with its next publication.
      const back = publish(world.A, world.draft.version_id, 1);
      assert.equal(back.outcome, "published");
      assert.equal(back.version_number, 3);
      assert.equal(activation().theme_key, THEME);
      assert.equal(readAnon(PUBLIC_SQL)[0].version_id, world.draft.version_id);
      world.v3 = world.draft.version_id;
      return { rosuno: own.length, second: first.length };
    },
  );
}

// ---------------------------------------------------------------------------
// AUTH: everyone else reads nothing and changes nothing
// ---------------------------------------------------------------------------

async function authorizationChecks() {
  await check(
    "AUTH-1 a holder at aal1 or without claims, a jurisdiction-scoped, expired or revoked grant, a deactivated Staff Profile, active staff without the grant and a client get no row from every staff read and denied from every command (valid arguments), writing nothing, while the public read answers them the published version only; anon and service_role may execute no staff function; anon reads the published version and service_role may not execute the public reads",
    () => {
      const draft = save(world.A, null, SECOND);
      assert.equal(draft.outcome, "created");
      const sha = upload(world.A, "image/png", 16, 16, png16(7)).sha256;
      const before = counts();
      const reads = [
        OVERVIEW_SQL(),
        VERSIONS_SQL(0),
        VERSION_SQL(world.v1),
        PREVIEW_SQL(),
        ASSETS_SQL(0),
        ASSET_SQL(sha),
      ];
      const commands = [
        SAVE_SQL(THEME, 1, FIRST),
        SAVE_SQL("refused-theme", null, FIRST),
        PUBLISH_SQL(THEME, draft.version_id, 1),
        RESTORE_SQL(world.v1, 1),
        RESET_SQL(THEME, 1),
        DISCARD_SQL(draft.version_id, 1),
        UPLOAD_SQL("image/png", 16, 16, png16(8).toString("base64")),
      ];
      const refused = [
        ["B", world.B, AAL1],
        ["A at aal1", world.A, AAL1],
        ["A without claims", world.A, { aal: null }],
        ["C", world.C, {}],
        ["D", world.D, {}],
        ["E", world.E, {}],
        ["F", world.F, {}],
        ["G", world.G, {}],
        ["H", world.H, AAL1],
      ];
      for (const [label, account, options] of refused) {
        for (const statement of reads) {
          assert.deepEqual(
            read(account, statement, options),
            [],
            `${label}: ${statement}`,
          );
        }
        for (const statement of commands) {
          const answer = as("authenticated", account.auth, statement, options);
          const outcome = answer.startsWith("{")
            ? JSON.parse(answer).outcome
            : answer;
          assert.equal(outcome, "denied", `${label}: ${statement}`);
        }
        assert.equal(
          read(account, PUBLIC_SQL, options)[0].version_id,
          world.v3,
        );
      }
      for (const role of ["anon", "service_role"]) {
        for (const statement of [...reads, ...commands]) {
          assert.equal(
            as(role, null, statement),
            "ERROR 42501",
            `${role}: ${statement}`,
          );
        }
      }
      assert.equal(readAnon(PUBLIC_SQL)[0].version_id, world.v3);
      assert.equal(as("service_role", null, PUBLIC_SQL), "ERROR 42501");
      assert.equal(counts(), before, "nothing was written");
      // The holder at aal2 still reads it all.
      assert.equal(read(world.A, ASSET_SQL(sha)).length, 1);
      assert.equal(discard(world.A, draft.version_id, 1), "discarded");
      return {
        refused: refused.length,
        reads: reads.length,
        commands: commands.length,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// IMM: immutability for every role, the owner included
// ---------------------------------------------------------------------------

async function immutabilityChecks() {
  await check(
    "IMM-1 for every role, the database owner included: a published version's configuration, a return to draft, any change of a superseded or discarded version, a save that skips a revision, a change of theme or creation, deletion and truncation of versions, an insert that is not a new draft, and any update, deletion or truncation of an asset are refused; a stored configuration must keep its digest and its shape",
    () => {
      const superseded = world.v1;
      const published = world.v3;
      const discarded = sql(
        "select id from public.site_appearance_versions where state = 'discarded' limit 1;",
      );
      const draft = save(world.A, null, SECOND);
      const asset = sql(
        "select id from public.site_appearance_assets limit 1;",
      );
      const refusals = {
        published_configuration: `update public.site_appearance_versions set configuration = '{"schema": 1}'::jsonb, configuration_sha256 = '${configurationDigest(config())}' where id = '${published}';`,
        published_to_draft: `update public.site_appearance_versions set state = 'draft', version_number = null, published_at = null, published_by_user_id = null where id = '${published}';`,
        published_label: `update public.site_appearance_versions set label = 'changed' where id = '${published}';`,
        superseded_change: `update public.site_appearance_versions set superseded_at = now() where id = '${superseded}';`,
        superseded_republish: `update public.site_appearance_versions set state = 'published', superseded_at = null where id = '${superseded}';`,
        discarded_change: `update public.site_appearance_versions set state = 'draft', discarded_at = null where id = '${discarded}';`,
        draft_skips_revision: `update public.site_appearance_versions set revision = revision + 2 where id = '${draft.version_id}';`,
        draft_theme: `update public.site_appearance_versions set theme_key = 'other-theme', revision = revision + 1 where id = '${draft.version_id}';`,
        draft_creation: `update public.site_appearance_versions set created_at = now(), revision = revision + 1 where id = '${draft.version_id}';`,
        draft_publish_changes_configuration: `update public.site_appearance_versions set state = 'published', version_number = 99, published_at = now(), published_by_user_id = '${world.A.user}', configuration = '{"schema": 1}'::jsonb, configuration_sha256 = '${configurationDigest(config())}' where id = '${draft.version_id}';`,
        delete_version: `delete from public.site_appearance_versions where id = '${superseded}';`,
        truncate_versions: "truncate public.site_appearance_versions cascade;",
        update_asset: `update public.site_appearance_assets set width = 32 where id = '${asset}';`,
        delete_asset: `delete from public.site_appearance_assets where id = '${asset}';`,
        truncate_assets: "truncate public.site_appearance_assets;",
      };
      const results = {};
      for (const [name, statement] of Object.entries(refusals)) {
        results[name] = sqlstateOf(psql(statement).stderr);
        assert.equal(results[name], "55000", name);
      }
      const inserted = (state, configuration, digest) =>
        sqlstateOf(
          psql(
            `insert into public.site_appearance_versions (theme_key, state, configuration, configuration_sha256, schema_version, revision, created_by_user_id, created_at, updated_by_user_id, updated_at${state === "published" ? ", version_number, published_at, published_by_user_id" : ""}) values ('imm-theme', '${state}', ${jsonLit(configuration)}, '${digest}', 1, 1, '${world.A.user}', now(), '${world.A.user}', now()${state === "published" ? `, 1, now(), '${world.A.user}'` : ""});`,
          ).stderr,
        );
      assert.equal(
        inserted("published", config(), configurationDigest(config())),
        "23514",
      );
      assert.equal(inserted("draft", config(), "0".repeat(64)), "23514");
      assert.equal(
        inserted(
          "draft",
          { schema: 1, tokens: { site: { ink: "#fff;}body{" } } },
          "0".repeat(64),
        ),
        "23514",
      );
      assert.equal(
        sqlstateOf(
          psql(
            `update public.site_appearance_versions set configuration = '{"schema": 1, "x": 1}'::jsonb, configuration_sha256 = encode(sha256(convert_to('{"schema": 1, "x": 1}', 'UTF8')), 'hex'), revision = revision + 1 where id = '${draft.version_id}';`,
          ).stderr,
        ),
        "23514",
      );
      assert.equal(discard(world.A, draft.version_id, 1), "discarded");
      return results;
    },
  );
}

// ---------------------------------------------------------------------------
// SHAPE: what a configuration may hold
// ---------------------------------------------------------------------------

async function shapeChecks() {
  await check(
    "SHAPE-1 a save is refused invalid, writing and auditing nothing, for a configuration over 65,536 octets, an unknown top-level key, another schema, a non-object, a null or boolean anywhere, a CSS payload or url() in a value, a key with a quote, uppercase hex, and page texts with markup, regulated phrases (best attorney, Licensed in, guaranteed, free, top-rated, ranKed with a Kelvin sign), a link, an email address, a control or bidirectional character, surrounding spaces or more than 300 characters, a slot key outside the id grammar, more than 20 or malformed asset references; and for a malformed theme or revision",
    () => {
      const before = counts();
      const slot = (text) => config({ slots: { "home.ways.title": text } });
      const asset = (format, hex = "a".repeat(64)) => ({ sha256: hex, format });
      const bigSlots = Object.fromEntries(
        Array.from({ length: 300 }, (_, i) => [
          `home.big${i}`,
          "a".repeat(250),
        ]),
      );
      const refused = {
        too_large: config({ slots: bigSlots }),
        unknown_top_key: config({ extra: {} }),
        schema_2: { schema: 2 },
        array: "'[]'::jsonb",
        number: "'1'::jsonb",
        null_value: config({ tokens: { site: { ink: null } } }),
        boolean_value: config({
          components: { "home.ways": { visible: false } },
        }),
        css_payload: config({
          tokens: { site: { ink: "#fff;}body{display:none" } },
        }),
        url_payload: config({
          components: {
            "home.hero.figure": { background: { type: "url(javascript:x)" } },
          },
        }),
        quote_key: config({ tokens: { 'si"te': { ink: "#ffffff" } } }),
        uppercase_hex: config({ tokens: { site: { ink: "#ABCDEF" } } }),
        expression: config({
          components: { "home.ways": { x: "expression(alert(1))" } },
        }),
        markup_slot: slot("<b>Talk now</b>"),
        brace_slot: slot("Talk {now}"),
        backslash_slot: slot("Talk \\now"),
        best_attorney: slot("best attorney"),
        licensed: slot("Licensed in"),
        guaranteed: slot("guaranteed"),
        free: slot("Free consultations"),
        top_rated: slot("Top-rated lawyers"),
        kelvin: slot("ran\u212Aed lawyers"),
        link: slot("See https://example.test"),
        www: slot("See www.example.test"),
        email: slot("Write to someone@example.test"),
        control: slot("Talk\u0007now"),
        bidi: slot("Talk\u202Enow"),
        leading_space: slot(" Talk now"),
        trailing_newline: slot("Talk now\n"),
        long_slot: slot("a".repeat(301)),
        empty_slot: slot(""),
        number_slot: config({ slots: { "home.ways.title": 1 } }),
        slot_key: config({ slots: { "Home.Ways": "Talk now" } }),
        slots_array: config({ slots: ["Talk now"] }),
        assets_21: config({
          assets: Array.from({ length: 21 }, (_, i) =>
            asset("png", i.toString(16).padStart(64, "0")),
          ),
        }),
        asset_gif: config({ assets: [asset("gif")] }),
        asset_extra_key: config({ assets: [{ ...asset("png"), size: 1 }] }),
        asset_short_hex: config({ assets: [asset("png", "abc")] }),
        assets_object: config({ assets: { a: asset("png") } }),
        number_range: config({ components: { "home.ways": { x: 100001 } } }),
      };
      const results = {};
      for (const [name, configuration] of Object.entries(refused)) {
        const row = command(world.A, SAVE_SQL(THEME, null, configuration));
        results[name] = row.outcome;
        assert.equal(row.outcome, "invalid", name);
      }
      assert.ok(JSON.stringify(refused.too_large).length > 65536);
      for (const [theme, expected] of [
        ["Rosuno", null],
        ["r", null],
        ["rosuno;drop", null],
        [THEME, 0],
        [THEME, 1000001],
      ]) {
        assert.equal(
          command(world.A, SAVE_SQL(theme, expected, config())).outcome,
          "invalid",
        );
      }
      assert.equal(
        command(world.A, SAVE_SQL(THEME, null, "null::jsonb")).outcome,
        "invalid",
      );
      assert.equal(counts(), before, "nothing was written or audited");
      // The defaults and an allowed text pass.
      const ok = save(world.A, null, slot("Talk to a lawyer\nin minutes."));
      assert.equal(ok.outcome, "created");
      assert.equal(discard(world.A, ok.version_id, 1), "discarded");
      return results;
    },
  );
}

// ---------------------------------------------------------------------------
// ASSET: the image library
// ---------------------------------------------------------------------------

async function assetChecks() {
  await check(
    "ASSET-1 PNG, JPEG and WebP images are stored with their digest, size and dimensions; the same bytes with the same media type and dimensions answer exists (same id, nothing recorded); SVG (as image/png or as image/svg+xml), GIF, PNG bytes declared as JPEG, JPEG bytes declared as WebP, stored bytes declared with another media type or other dimensions, 900,001 bytes, 15 or 4097 pixels, base64 that does not decode, no bytes and a missing argument are refused invalid, writing nothing",
    () => {
      const images = { png: png16(1), jpeg: jpeg16(), webp: webp16() };
      world.assets = {};
      for (const [format, bytes] of Object.entries(images)) {
        const stored = upload(world.A, `image/${format}`, 16, 16, bytes);
        assert.equal(stored.outcome, "stored", format);
        assert.equal(stored.sha256, sha256(bytes));
        const row = rowOf(
          `select row_to_json(x)::text from (select media_type, byte_size, width, height, encode(content, 'hex') as hex, created_by_user_id from public.site_appearance_assets where id = '${stored.asset_id}') x;`,
        );
        assert.deepEqual(row, {
          media_type: `image/${format}`,
          byte_size: bytes.length,
          width: 16,
          height: 16,
          hex: bytes.toString("hex"),
          created_by_user_id: world.A.user,
        });
        world.assets[format] = stored;
      }
      const before = counts();
      const again = upload(world.A2, "image/png", 16, 16, images.png);
      assert.deepEqual(again, { ...world.assets.png, outcome: "exists" });
      const big = Buffer.concat([
        png16(2),
        Buffer.alloc(900001 - png16(2).length),
      ]);
      const refusals = {
        svg_as_png: ["image/png", 16, 16, SVG],
        svg_type: ["image/svg+xml", 16, 16, SVG],
        png_as_jpeg: ["image/jpeg", 16, 16, png16(3)],
        jpeg_as_webp: ["image/webp", 16, 16, jpeg16(2)],
        stored_png_as_jpeg: ["image/jpeg", 16, 16, images.png],
        stored_png_other_size: ["image/png", 32, 16, images.png],
        gif: [
          "image/gif",
          16,
          16,
          Buffer.from("GIF89a\u0010\u0000\u0010\u0000"),
        ],
        oversize: ["image/png", 16, 16, big],
        width_15: ["image/png", 15, 16, png16(4)],
        height_4097: ["image/png", 16, 4097, png16(5)],
        bad_base64: ["image/png", 16, 16, "@@not base64@@"],
        empty: ["image/png", 16, 16, ""],
        missing: ["image/png", null, 16, png16(6)],
      };
      const results = {};
      for (const [name, [type, width, height, bytes]] of Object.entries(
        refusals,
      )) {
        results[name] = upload(world.A, type, width, height, bytes).outcome;
        assert.equal(results[name], "invalid", name);
      }
      assert.equal(counts(), before, "nothing was written or audited");
      return results;
    },
  );

  await check(
    "ASSET-2 the public asset read answers only an image the published configuration references (a draft-only reference answers nothing to anon and the image to a holder; an unreferenced or malformed digest nothing); publishing a reference to an image missing from the library, or with another format than the stored one, is refused invalid",
    () => {
      const { png, jpeg } = world.assets;
      const logo = {
        asset: { sha256: png.sha256, format: "png" },
        width: 120,
        height: 32,
        wordmark: "shown",
      };
      const withLogo = config({
        brand: { logo },
        assets: [{ sha256: png.sha256, format: "png" }],
      });
      const draft = save(world.A, null, withLogo);
      assert.equal(draft.outcome, "created");
      assert.equal(readAnon(PUBLIC_ASSET_SQL(png.sha256)).length, 0);
      const staff = read(world.A, ASSET_SQL(png.sha256));
      assert.equal(staff.length, 1);
      assert.equal(staff[0].media_type, "image/png");
      assert.deepEqual(
        Buffer.from(staff[0].content_base64, "base64"),
        png16(1),
      );
      assert.doesNotMatch(staff[0].content_base64, /\s/);
      // A missing image, then a format mismatch, refuse publication.
      const missing = config({
        assets: [{ sha256: "f".repeat(64), format: "png" }],
      });
      assert.equal(save(world.A, 1, missing).outcome, "saved");
      assert.equal(publish(world.A, draft.version_id, 2).outcome, "invalid");
      const mismatch = config({
        assets: [{ sha256: png.sha256, format: "jpeg" }],
      });
      assert.equal(save(world.A, 2, mismatch).outcome, "saved");
      assert.equal(publish(world.A, draft.version_id, 3).outcome, "invalid");
      assert.equal(save(world.A, 3, withLogo).outcome, "saved");
      assert.equal(publish(world.A, draft.version_id, 4).outcome, "published");
      const pub = readAnon(PUBLIC_ASSET_SQL(png.sha256));
      assert.equal(pub.length, 1);
      assert.equal(pub[0].media_type, "image/png");
      assert.equal(pub[0].byte_size, png16(1).length);
      assert.deepEqual(Buffer.from(pub[0].content_base64, "base64"), png16(1));
      assert.equal(read(world.H, PUBLIC_ASSET_SQL(png.sha256), AAL1).length, 1);
      assert.equal(readAnon(PUBLIC_ASSET_SQL(jpeg.sha256)).length, 0);
      assert.equal(
        readAnon(PUBLIC_ASSET_SQL(png.sha256.toUpperCase())).length,
        0,
      );
      assert.equal(
        readAnon(PUBLIC_ASSET_SQL(`${png.sha256}' or true --`)).length,
        0,
      );
      assert.equal(readAnon(PUBLIC_ASSET_SQL("")).length, 0);
      world.v4 = draft.version_id;
    },
  );

  await check(
    "ASSET-3 the library pages 50 rows plus one, newest first, without bytes; with 100 images (the owner plants the rest) a new image answers limit_reached and the same bytes still answer exists, writing nothing",
    () => {
      const present = Number(
        sql("select count(*) from public.site_appearance_assets;"),
      );
      sql(
        `insert into public.site_appearance_assets (sha256, media_type, byte_size, width, height, content, created_by_user_id, created_at)
         select encode(sha256(c), 'hex'), 'image/png', octet_length(c), 16, 16, c, '${world.A.user}', now() - make_interval(secs => g)
         from (select g, '\\x89504e470d0a1a0a'::bytea || int4send(g) as c from generate_series(1, ${100 - present}) as g) as x;`,
      );
      assert.equal(
        sql("select count(*) from public.site_appearance_assets;"),
        "100",
      );
      const before = counts();
      assert.equal(
        upload(world.A, "image/png", 16, 16, png16(99)).outcome,
        "limit_reached",
      );
      assert.equal(
        upload(world.A, "image/png", 16, 16, png16(1)).outcome,
        "exists",
      );
      assert.equal(counts(), before);
      const page = read(world.A, ASSETS_SQL(0));
      assert.equal(page.length, 51);
      assert.ok(
        page.every((row) => !("content" in row) && !("content_base64" in row)),
      );
      for (let i = 1; i < page.length; i += 1) {
        assert.ok(page[i - 1].created_at >= page[i].created_at);
      }
      assert.equal(read(world.A, ASSETS_SQL(50)).length, 50);
      assert.equal(read(world.A, ASSETS_SQL(-1)).length, 0);
      assert.equal(read(world.A, ASSETS_SQL(100001)).length, 0);
    },
  );
}

// ---------------------------------------------------------------------------
// CONC: concurrent saves and creations
// ---------------------------------------------------------------------------

async function raceOf(first, second) {
  const holder = background(
    `begin;\n${sessionLines("authenticated", world.A.auth).join("\n")}\n${first}\nselect pg_sleep(1.5);\ncommit;\n`,
  );
  await delay(400);
  const contender = background(
    `begin;\n${sessionLines("authenticated", world.A2.auth).join("\n")}\n${second}\ncommit;\n`,
  );
  const [a, b] = await Promise.all([holder, contender]);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  const rowOfLines = (lines) =>
    JSON.parse(lines.find((l) => l.startsWith("{")));
  return [rowOfLines(a.lines), rowOfLines(b.lines)];
}

async function concurrencyChecks() {
  await check(
    "CONC-1 two holders creating the draft at once: one created, the other conflict; two holders saving the same revision at once: one saved, the other conflict (it waits for the first and sees the new revision); one audit event each",
    async () => {
      const [made, refusedMade] = await raceOf(
        SAVE_SQL(THEME, null, FIRST),
        SAVE_SQL(THEME, null, SECOND),
      );
      assert.equal(made.outcome, "created");
      assert.deepEqual(refusedMade, {
        outcome: "conflict",
        version_id: null,
        revision: null,
      });
      expectAudit("created", made.version_id, world.A);
      const [saved, refusedSaved] = await raceOf(
        SAVE_SQL(THEME, 1, SECOND),
        SAVE_SQL(THEME, 1, FIRST),
      );
      assert.deepEqual(saved, {
        outcome: "saved",
        version_id: made.version_id,
        revision: 2,
      });
      assert.deepEqual(refusedSaved, {
        outcome: "conflict",
        version_id: null,
        revision: null,
      });
      expectAudit("saved", made.version_id, world.A);
      assert.deepEqual(versionRow(made.version_id).configuration, SECOND);
      assert.equal(discard(world.A, made.version_id, 2), "discarded");
    },
  );
}

// ---------------------------------------------------------------------------
// AUD: one audit event per successful command, identifiers and digests only
// ---------------------------------------------------------------------------

async function auditChecks() {
  await check(
    "AUD-1 every successful command left exactly one audit event (actor the caller, actor type staff, no reason, no jurisdiction, its action code, resource and snapshot keys) and no refusal left any; no snapshot holds a configuration, a page text or image bytes",
    () => {
      const rows = sql(
        "select coalesce(string_agg(action_code || '|' || resource_type || '|' || resource_id || '|' || coalesce((select string_agg(k, ',' order by k) from jsonb_object_keys(before_snapshot) k), '-') || '|' || coalesce((select string_agg(k, ',' order by k) from jsonb_object_keys(after_snapshot) k), '-') || '|' || actor_user_id || '|' || actor_type || '|' || coalesce(reason_code, '-') || '|' || coalesce(jurisdiction_id::text, '-'), E'\\n' order by occurred_at, id), '') from public.audit_events where action_code like 'site_appearance.%';",
      )
        .split("\n")
        .filter(Boolean);
      for (const row of rows) {
        assert.match(row, /\|staff\|-\|-$/, row);
      }
      const seen = rows
        .map((row) => row.split("|").slice(0, 6).join("|"))
        .sort();
      assert.deepEqual(seen, [...world.audits].sort());
      const snapshots = sql(
        "select coalesce(string_agg(coalesce(before_snapshot::text, '') || ' ' || coalesce(after_snapshot::text, ''), E'\\n'), '') from public.audit_events where action_code like 'site_appearance.%';",
      );
      for (const fragment of [
        'configuration"',
        "Talk now",
        "home.ways",
        "#1c1917",
        png16(1).toString("base64").slice(0, 24),
        jpeg16().toString("base64").slice(0, 24),
        "content",
      ]) {
        assert.ok(!snapshots.includes(fragment), fragment);
      }
      const byAction = Object.fromEntries(
        sql(
          "select string_agg(action_code || ':' || n, ',' order by action_code) from (select action_code, count(*) as n from public.audit_events where action_code like 'site_appearance.%' group by action_code) x;",
        )
          .split(",")
          .map((entry) => entry.split(":")),
      );
      return byAction;
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
    // MIG-4: the state of the freshly migrated database, before any fixture.
    world.fresh = sql(
      "select (select count(*) from public.site_appearance_versions) || '|' || (select count(*) from public.site_appearance_assets) || '|' || (select count(*) from public.site_appearance_activation) || '|' || (select count(*) from public.capability_grants where capability_code = 'manage_site_appearance');",
    );
    seed();
    await migrationChecks();
    await grantChecks();
    await lifecycleChecks();
    await authorizationChecks();
    await immutabilityChecks();
    await shapeChecks();
    await assetChecks();
    await concurrencyChecks();
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
  report.duration_ms = Date.now() - started;
  report.result = failed ? "FAIL" : cleaned ? "PASS" : "CLEANUP-FAILED";
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = failed ? 1 : cleaned ? 0 : 2;
}

await main();
