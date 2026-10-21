// P2-007 disposable PostgreSQL proof (D-05). Explicitly invoked only:
//
//   node apps/web/tests/registration-abuse-db-proof.mjs
//   node apps/web/tests/registration-abuse-db-proof.mjs --check-prerequisites
//
// This is deliberately not a *.test.mjs file, so no application test run,
// p0:test, or CI job ever starts it. It uses Node built-ins only and the
// system-installed PostgreSQL 16 initdb, pg_ctl, postgres, and psql binaries.
//
// The full run creates a new mode-0700 temporary directory, initializes a new
// cluster in it owned by an unprivileged account (never root), and starts it
// with TCP disabled and a private Unix-domain socket in that directory. Every
// child process gets a fixed minimal environment, so no caller PG*, database
// URL, or credential variable can redirect it, and the run refuses to start
// when such variables are present. The fixture roles anon, authenticated, and
// service_role (BYPASSRLS) and Supabase-like default privileges are synthetic
// database objects of this cluster only; they are not evidence of any remote
// project's grants. No Supabase project, network service, or pre-existing
// cluster is contacted, and no real account, credential, or data is used.
//
// Procedure: (A) attest binaries, cluster, directory, socket, and a fixture
// catalog fingerprint; (B) apply the unmodified migration inside BEGIN on one
// connection, verify it, ROLLBACK, and require the exact fixture fingerprint
// again; (C) apply the identical bytes committed in a sibling database,
// reconcile the exact catalog delta against the approved object allowlist,
// and run ACL/RLS, role, quota, policy-marker, aggregate, concurrency,
// timeout, window, and cleanup probes; (D) stop the cluster, remove the
// directory, and verify that no process, socket, or file remains. Window
// edges are proven only with real calls over rows seeded from the database's
// own clock, deterministic SQL over synthetic timestamps, and arithmetic: no
// real hour or day rollover is waited for, and the migration has no
// caller-supplied clock. The JSON report goes to stdout; exit 0 means PASS,
// 1 FAIL, 2 cleanup failure, 3 refused to start.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = "/usr/lib/postgresql/16/bin";
const TOOLS = ["initdb", "pg_ctl", "postgres", "psql"];
const VERSION = /^(initdb|pg_ctl|postgres|psql) \(PostgreSQL\) (16\.\d+)\b/;
const MIGRATION =
  "supabase/migrations/20261020070000_p2_registration_abuse_control.sql";
const REPOSITORY_ROOT = path.resolve(
  path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)),
  "../../..",
);
const PORT = 54329;
const SUPERUSER = "postgres";
const FIXTURE_DB = "rosuno_fixture";
const ROLLBACK_DB = "rosuno_rollback_proof";
const PROBE_DB = "rosuno_committed_probe";
const DECISION_LOCK = 2026102007000000n;
const INT_MAX = 2147483647;
const HOUR = 3600;
const DAY = 86400;
const MAX = [10, 10, 120];
const marker = ([ip, identity, global]) =>
  `v1:ip=${ip}:identity=${identity}:global=${global}:windows=3600,86400,3600`;
const M = marker(MAX);
const UNAVAILABLE_MESSAGE = "registration quota unavailable";

const report = {
  work_item: "P2-007",
  harness: "apps/web/tests/registration-abuse-db-proof.mjs",
  status: "NOT RUN",
  started_at: new Date().toISOString(),
  environment: {},
  migration: {},
  cluster: {},
  fingerprints: {},
  catalog_delta: {},
  checks: [],
  concurrency: [],
  timing: {},
  not_tested: [],
  commands: [],
  psql: { invocations: 0, expected_errors: 0 },
  cleanup: {},
};

function progress(message) {
  process.stderr.write(`[db-proof] ${message}\n`);
}

// ---------------------------------------------------------------------------
// Isolation preconditions
// ---------------------------------------------------------------------------

// Names only, never values.
function refusedEnvironmentNames() {
  return Object.keys(process.env)
    .filter(
      (name) =>
        /^PG/.test(name) || /DATABASE_URL|SUPABASE|POSTGRES/i.test(name),
    )
    .sort();
}

function unprivilegedIdentity() {
  const uid = process.getuid();
  if (uid !== 0) {
    return { uid, gid: process.getgid(), account: "invoking user", spawn: {} };
  }
  const entry = fs
    .readFileSync("/etc/passwd", "utf8")
    .split("\n")
    .find((line) => line.startsWith("nobody:"));
  const fields = entry?.split(":") ?? [];
  if (fields[2] !== "65534" || fields[3] !== "65534") {
    throw new Error("no unprivileged nobody:65534 account to run PostgreSQL");
  }
  return {
    uid: 65534,
    gid: 65534,
    account: "nobody",
    spawn: { uid: 65534, gid: 65534 },
  };
}

// The fixed environment of every child process: nothing is inherited.
function childEnvironment(home) {
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    HOME: home,
  };
}

function verifyBinaries(identity) {
  const versions = {};
  for (const tool of TOOLS) {
    const file = path.join(BIN, tool);
    const real = fs.realpathSync(file);
    const stat = fs.statSync(real);
    if (
      real !== file ||
      !stat.isFile() ||
      stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0 ||
      (stat.mode & 0o111) === 0
    ) {
      throw new Error(`unexpected PostgreSQL binary ${file}`);
    }
    const result = spawnSync(file, ["--version"], {
      env: childEnvironment("/"),
      encoding: "utf8",
      timeout: 10000,
      ...identity.spawn,
    });
    const match = VERSION.exec(result.stdout ?? "");
    if (result.status !== 0 || match === null || match[1] !== tool) {
      throw new Error(`unexpected ${tool} version`);
    }
    versions[tool] = result.stdout.trim();
  }
  return versions;
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

let state = null;

function run(tool, args, { input, timeout = 120000, record = true } = {}) {
  const result = spawnSync(path.join(BIN, tool), args, {
    env: childEnvironment(state.tmp),
    cwd: state.tmp,
    encoding: "utf8",
    input,
    timeout,
    ...state.identity.spawn,
  });
  if (record) {
    report.commands.push({
      argv: [path.join(BIN, tool), ...args],
      exit: result.status,
    });
  }
  return result;
}

function psqlArgs(db) {
  return [
    "-X",
    "-q",
    "-A",
    "-t",
    "-v",
    "ON_ERROR_STOP=1",
    "-v",
    "VERBOSITY=verbose",
    "-h",
    state.socketDir,
    "-p",
    String(PORT),
    "-U",
    SUPERUSER,
    "-d",
    db,
    "-f",
    "-",
  ];
}

function psql(db, script) {
  report.psql.invocations += 1;
  return run("psql", psqlArgs(db), { input: script, record: false });
}

function sql(db, script) {
  const result = psql(db, script);
  if (result.status !== 0) {
    throw new Error(`psql failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function sqlValue(db, query) {
  return sql(db, query).trim();
}

function sqlstateOf(stderr) {
  return /ERROR:\s+([0-9A-Z]{5}):/.exec(stderr)?.[1] ?? null;
}

function sqlError(db, script) {
  const result = psql(db, script);
  assert.equal(result.status, 3, `expected an error: ${result.stdout}`);
  report.psql.expected_errors += 1;
  return { code: sqlstateOf(result.stderr), stderr: result.stderr };
}

function spawnPsql(db, input) {
  report.psql.invocations += 1;
  const child = spawn(path.join(BIN, "psql"), psqlArgs(db), {
    env: childEnvironment(state.tmp),
    cwd: state.tmp,
    stdio: ["pipe", "pipe", "pipe"],
    ...state.identity.spawn,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
  const killer = setTimeout(() => child.kill("SIGKILL"), 120000);
  const done = new Promise((resolve) => {
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
  });
  if (input !== undefined) {
    child.stdin.end(input);
  }
  return { child, done };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, limitMs = 60000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > limitMs) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(25);
  }
}

// ---------------------------------------------------------------------------
// Catalog fingerprint
// ---------------------------------------------------------------------------

const USER_NAMESPACES = `n.nspname not in ('pg_catalog', 'information_schema')
  and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'`;

// With only pg_catalog on the search path, every object name below is
// schema-qualified.
const FINGERPRINT_QUERY = `
set search_path = pg_catalog;
select coalesce(string_agg(line, E'\\n' order by line), '') from (
  select 'namespace|' || n.nspname || '|' || pg_get_userbyid(n.nspowner)
    || '|' || coalesce(n.nspacl::text, '') as line
  from pg_namespace n where ${USER_NAMESPACES}
  union all
  select 'class|' || n.nspname || '.' || c.relname || '|' || c.relkind::text
    || '|' || pg_get_userbyid(c.relowner) || '|' || coalesce(c.relacl::text, '')
    || '|rls=' || c.relrowsecurity || '|force=' || c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where ${USER_NAMESPACES}
  union all
  select 'attribute|' || n.nspname || '.' || c.relname || '|' || a.attnum
    || '|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod)
    || '|notnull=' || a.attnotnull || '|default='
    || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || '|'
    || coalesce(a.attacl::text, '')
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attnum > 0 and not a.attisdropped and ${USER_NAMESPACES}
  union all
  select 'constraint|' || n.nspname || '.' || coalesce(c.relname, '') || '|'
    || k.conname || '|' || pg_get_constraintdef(k.oid)
  from pg_constraint k
  join pg_namespace n on n.oid = k.connamespace
  left join pg_class c on c.oid = k.conrelid
  where ${USER_NAMESPACES}
  union all
  select 'index|' || n.nspname || '.' || c.relname || '|'
    || pg_get_indexdef(i.indexrelid)
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
  where ${USER_NAMESPACES}
  union all
  select 'function|' || n.nspname || '.' || p.proname || '('
    || pg_get_function_identity_arguments(p.oid) || ')|'
    || pg_get_function_result(p.oid) || '|' || l.lanname
    || '|secdef=' || p.prosecdef || '|vol=' || p.provolatile::text
    || '|config=' || coalesce(array_to_string(p.proconfig, ','), '')
    || '|' || pg_get_userbyid(p.proowner) || '|' || coalesce(p.proacl::text, '')
    || '|src=' || md5(p.prosrc)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where ${USER_NAMESPACES}
  union all
  select 'type|' || n.nspname || '.' || t.typname || '|' || t.typtype::text
  from pg_type t join pg_namespace n on n.oid = t.typnamespace
  where ${USER_NAMESPACES}
  union all
  select 'policy|' || pol.polrelid::regclass::text || '|' || pol.polname
  from pg_policy pol
  union all
  select 'trigger|' || t.tgrelid::regclass::text || '|' || t.tgname
  from pg_trigger t where not t.tgisinternal
  union all
  select 'default_acl|' || coalesce(n.nspname, '') || '|'
    || pg_get_userbyid(d.defaclrole) || '|' || d.defaclobjtype::text || '|'
    || d.defaclacl::text
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
  union all
  select 'description|' || pg_describe_object(d.classoid, d.objoid, d.objsubid)
    || '|' || md5(d.description)
  from pg_description d where d.objoid >= 16384
  union all
  select 'extension|' || e.extname || '|' || e.extversion from pg_extension e
  union all
  select 'role|' || r.rolname || '|super=' || r.rolsuper || '|login='
    || r.rolcanlogin || '|bypassrls=' || r.rolbypassrls || '|inherit='
    || r.rolinherit || '|createrole=' || r.rolcreaterole || '|createdb='
    || r.rolcreatedb
  from pg_roles r where r.rolname !~ '^pg_'
) lines;`;

function catalogLines(db, prefix = "") {
  return sql(db, `${prefix}${FINGERPRINT_QUERY}`)
    .replace(/\n$/, "")
    .split("\n")
    .filter((line) => line !== "");
}

function fingerprintOf(lines) {
  const text = lines.join("\n");
  return {
    sha256: createHash("sha256").update(text).digest("hex"),
    lines: lines.length,
    bytes: Buffer.byteLength(text),
  };
}

// ---------------------------------------------------------------------------
// Quota helpers
// ---------------------------------------------------------------------------

const digest = (label) =>
  createHash("sha256").update(`p2-007-db-proof/${label}`).digest("hex");

function quoted(value) {
  assert.match(value, /^[0-9a-f]{64}$/);
  return `'${value}'`;
}

function callOf({ ip, identity, global, max = MAX }) {
  return `public.registration_quota_decide(${quoted(ip)}, ${quoted(identity)}, ${quoted(global)}, ${max[0]}, ${max[1]}, ${max[2]})`;
}

function decisionStatement(call) {
  return `select 'DECISION=' || ${callOf(call)};`;
}

function decisionsIn(stdout) {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("DECISION="))
    .map((line) => line.slice("DECISION=".length));
}

// Runs the calls in order on one service_role session; every call must
// answer.
function decide(db, calls, prefix = "") {
  const out = sql(
    db,
    `${prefix}set role service_role;\n${calls.map(decisionStatement).join("\n")}\n`,
  );
  const decisions = decisionsIn(out);
  assert.equal(decisions.length, calls.length);
  return decisions;
}

// One call that may fail: its answer or "error:<SQLSTATE>".
function decideOne(db, call, { role = "service_role", prefix = "" } = {}) {
  const result = psql(
    db,
    `${prefix}set role ${role};\n${decisionStatement(call)}\n`,
  );
  if (result.status === 0) {
    const [decision] = decisionsIn(result.stdout);
    return decision;
  }
  report.psql.expected_errors += 1;
  return `error:${sqlstateOf(result.stderr)}`;
}

function rowsWhere(db, where) {
  return JSON.parse(
    sqlValue(
      db,
      `select coalesce(json_agg(json_build_object(
         'dimension', dimension, 'digest', digest,
         'start', extract(epoch from window_start)::bigint,
         'end', extract(epoch from window_end)::bigint,
         'expires', extract(epoch from expires_at)::bigint,
         'accepted', accepted_count, 'throttled', throttled_count,
         'marker', policy_marker)
         order by dimension, digest, window_start), '[]'::json)
       from public.registration_quota_counters where ${where};`,
    ),
  );
}

const rowsFor = (db, digests) =>
  rowsWhere(db, `digest in (${digests.map(quoted).join(", ")})`);

function tableHash(db) {
  return sqlValue(
    db,
    `select md5(coalesce(string_agg(t::text, ';' order by t.dimension, t.digest, t.window_start), '')) || ':' || count(*)
     from public.registration_quota_counters t;`,
  );
}

function row(rows, dimension, digestValue, start) {
  const found = rows.filter(
    (item) =>
      item.dimension === dimension &&
      item.digest === digestValue &&
      (start === undefined || item.start === start),
  );
  assert.ok(found.length <= 1);
  return found[0];
}

// Inserts synthetic rows directly, as the cluster superuser, with windows
// computed from the database's own clock.
function seed(db, items) {
  const values = items.map((item) => {
    const width = item.dimension === "identity" ? DAY : HOUR;
    return `(${[
      `'${item.dimension}'`,
      quoted(item.digest),
      `to_timestamp(${item.start})`,
      `to_timestamp(${item.start + width})`,
      `to_timestamp(${item.start + width + DAY})`,
      item.accepted,
      item.throttled ?? 0,
      `'${item.marker ?? M}'`,
    ].join(", ")})`;
  });
  sql(
    db,
    `insert into public.registration_quota_counters
       (dimension, digest, window_start, window_end, expires_at,
        accepted_count, throttled_count, policy_marker)
     values ${values.join(",\n")};`,
  );
}

function clock(db) {
  const [now, hour, day] = sqlValue(
    db,
    `select extract(epoch from clock_timestamp())::text || '|'
       || extract(epoch from date_trunc('hour', clock_timestamp(), 'UTC'))::bigint
       || '|' || extract(epoch from date_trunc('day', clock_timestamp(), 'UTC'))::bigint;`,
  ).split("|");
  return { now: Number(now), hour: Number(hour), day: Number(day) };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function check(name, body) {
  try {
    const detail = await body();
    report.checks.push({ name, result: "PASS", ...(detail ? { detail } : {}) });
    progress(`PASS ${name}`);
  } catch (error) {
    report.checks.push({
      name,
      result: "FAIL",
      error: String(error?.message ?? error),
    });
    progress(`FAIL ${name}: ${error?.message ?? error}`);
  }
}

// N service_role sessions released together through a shared gate lock, so
// that their decisions really contend for the function's lock.
let gateKey = 7000;
async function concurrent(db, label, calls) {
  gateKey += 1;
  const key = gateKey;
  const dbOid = sqlValue(
    db,
    `select oid from pg_database where datname = '${db}';`,
  );
  const gateCount = (granted) =>
    Number(
      sqlValue(
        db,
        `select count(*) from pg_locks where locktype = 'advisory'
           and database = ${dbOid} and classid = 0 and objid = ${key}
           and objsubid = 1 and granted = ${granted};`,
      ),
    );
  const gate = spawnPsql(db);
  gate.child.stdin.write(`select pg_advisory_lock(${key});\n`);
  await waitFor(() => gateCount(true) === 1, "gate lock");
  const workers = calls.map((call) =>
    spawnPsql(
      db,
      `select pg_advisory_lock_shared(${key});\nselect pg_advisory_unlock_shared(${key});\nset role service_role;\n${decisionStatement(call)}\n`,
    ),
  );
  await waitFor(() => gateCount(false) === calls.length, "workers at gate");
  const released = Date.now();
  gate.child.stdin.end(`select pg_advisory_unlock(${key});\n`);
  const results = await Promise.all(workers.map((worker) => worker.done));
  const elapsedMs = Date.now() - released;
  await gate.done;
  const outcomes = results.map((result) =>
    result.status === 0
      ? (decisionsIn(result.stdout)[0] ?? "missing")
      : `error:${sqlstateOf(result.stderr)}`,
  );
  const tally = {};
  for (const outcome of outcomes) {
    tally[outcome] = (tally[outcome] ?? 0) + 1;
  }
  report.concurrency.push({ label, workers: calls.length, elapsedMs, tally });
  return outcomes;
}

const count = (list, value) => list.filter((item) => item === value).length;

// ---------------------------------------------------------------------------
// Main procedure
// ---------------------------------------------------------------------------

function attestPrerequisites() {
  const refused = refusedEnvironmentNames();
  report.environment.refused_variable_names = refused;
  if (refused.length > 0) {
    throw new Error(
      `refusing to run with caller variables: ${refused.join(", ")}`,
    );
  }
  const identity = unprivilegedIdentity();
  report.environment.harness_uid = process.getuid();
  report.environment.postgres_account = identity.account;
  report.environment.postgres_uid = identity.uid;
  report.environment.node = process.version;
  report.environment.binaries = verifyBinaries(identity);
  report.environment.temporary_root = os.tmpdir();
  return identity;
}

// The directory is registered for teardown the moment it exists, so a later
// failure still removes it.
function createPrivateDirectory(identity) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rosuno-p2-007-db-proof-"));
  const socketDir = path.join(tmp, "socket");
  state = { identity, tmp, socketDir, started: false };
  report.cluster.temporary_directory = tmp;
  assert.deepEqual(fs.readdirSync(tmp), []);
  fs.chmodSync(tmp, 0o700);
  fs.chownSync(tmp, identity.uid, identity.gid);
  fs.mkdirSync(socketDir, { mode: 0o700 });
  fs.chmodSync(socketDir, 0o700);
  fs.chownSync(socketDir, identity.uid, identity.gid);
  for (const directory of [tmp, socketDir]) {
    const stat = fs.lstatSync(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal(stat.mode & 0o777, 0o700);
    assert.equal(stat.uid, identity.uid);
  }
  assert.deepEqual(fs.readdirSync(tmp), ["socket"]);
  assert.deepEqual(fs.readdirSync(socketDir), []);
}

function startCluster() {
  const dataDir = path.join(state.tmp, "data");
  const logFile = path.join(state.tmp, "postgres.log");
  state.dataDir = dataDir;
  const init = run("initdb", [
    "-D",
    dataDir,
    "-U",
    SUPERUSER,
    "--auth=trust",
    "--encoding=UTF8",
    "--locale=C",
    "--no-instructions",
    "--no-sync",
  ]);
  assert.equal(init.status, 0, init.stderr);
  // Only local socket connections exist at all; there is no host line.
  fs.writeFileSync(path.join(dataDir, "pg_hba.conf"), "local all all trust\n");
  fs.appendFileSync(
    path.join(dataDir, "postgresql.conf"),
    [
      "",
      "# P2-007 disposable proof cluster",
      "listen_addresses = ''",
      `port = ${PORT}`,
      `unix_socket_directories = '${state.socketDir}'`,
      "unix_socket_permissions = 0700",
      "max_connections = 100",
      "shared_buffers = 32MB",
      "fsync = off",
      "synchronous_commit = off",
      "full_page_writes = off",
      "timezone = 'UTC'",
      "log_timezone = 'UTC'",
      "",
    ].join("\n"),
  );
  const start = run("pg_ctl", [
    "-D",
    dataDir,
    "-l",
    logFile,
    "-w",
    "-t",
    "60",
    "-s",
    "start",
  ]);
  assert.equal(start.status, 0, start.stderr);
  state.started = true;
  const pidLines = fs
    .readFileSync(path.join(dataDir, "postmaster.pid"), "utf8")
    .split("\n");
  const pid = Number(pidLines[0]);
  const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  const uid = /^Uid:\s+(\d+)/m.exec(status)[1];
  assert.equal(Number(uid), state.identity.uid);
  assert.notEqual(Number(uid), 0);
  state.postmasterPid = pid;
  // No TCP listener on the cluster's port, in either family.
  const portHex = PORT.toString(16).toUpperCase().padStart(4, "0");
  const listening = ["/proc/net/tcp", "/proc/net/tcp6"]
    .filter((file) => fs.existsSync(file))
    .flatMap((file) => fs.readFileSync(file, "utf8").split("\n").slice(1))
    .filter((line) => {
      const fields = line.trim().split(/\s+/);
      return (
        fields.length > 3 &&
        fields[1].endsWith(`:${portHex}`) &&
        fields[3] === "0A"
      );
    });
  assert.deepEqual(listening, []);
  const settings = sqlValue(
    "postgres",
    `select json_build_object(
       'version', version(),
       'server_version', current_setting('server_version'),
       'listen_addresses', current_setting('listen_addresses'),
       'port', current_setting('port'),
       'unix_socket_directories', current_setting('unix_socket_directories'),
       'unix_socket_permissions', current_setting('unix_socket_permissions'),
       'data_directory', current_setting('data_directory'),
       'system_identifier', (select system_identifier::text from pg_control_system()),
       'tcp_connection', inet_server_addr() is not null,
       'databases', (select json_agg(datname order by datname) from pg_database))::text;`,
  );
  const cluster = JSON.parse(settings);
  assert.equal(cluster.listen_addresses, "");
  assert.equal(cluster.tcp_connection, false);
  assert.equal(cluster.data_directory, dataDir);
  assert.equal(cluster.unix_socket_directories, state.socketDir);
  assert.deepEqual(cluster.databases, ["postgres", "template0", "template1"]);
  assert.ok(fs.existsSync(path.join(state.socketDir, `.s.PGSQL.${PORT}`)));
  report.cluster = {
    ...report.cluster,
    ...cluster,
    postmaster_uid: Number(uid),
    postmaster_pid_file_listen_line: pidLines[5],
    tcp_listeners_on_port: listening.length,
    temporary_directory_mode: "0700",
    socket_directory_mode: "0700",
  };
}

const FIXTURE_SQL = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role proof_public_probe nologin noinherit;
create database ${FIXTURE_DB} template template0 encoding 'UTF8' locale 'C';
\\connect ${FIXTURE_DB}
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role ${SUPERUSER} in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role ${SUPERUSER} in schema public
  grant all on functions to anon, authenticated, service_role;
alter default privileges for role ${SUPERUSER} in schema public
  grant all on sequences to anon, authenticated, service_role;
\\connect postgres
create database ${ROLLBACK_DB} template ${FIXTURE_DB};
create database ${PROBE_DB} template ${FIXTURE_DB};
`;

const EXPECTED_DELTA = {
  class: 3,
  attribute: 15,
  constraint: 9,
  index: 2,
  function: 1,
  type: 2,
  description: 2,
};

const OBJECTS = [
  "public.registration_quota_counters|",
  "public.registration_quota_counters_pkey|",
  "public.registration_quota_counters_expiry_idx|",
  "public._registration_quota_counters|",
  "public.registration_quota_decide(ip_digest text, identity_digest text, global_digest text, ip_max integer, identity_max integer, global_max integer)|",
  "table public.registration_quota_counters|",
  "function public.registration_quota_decide(text,text,text,integer,integer,integer)|",
];

async function proof() {
  const migrationBytes = fs.readFileSync(path.join(REPOSITORY_ROOT, MIGRATION));
  const migrationSql = migrationBytes.toString("utf8");
  report.migration = {
    path: MIGRATION,
    sha256: createHash("sha256").update(migrationBytes).digest("hex"),
    bytes: migrationBytes.length,
  };
  // The proof requires purely transactional SQL with no transaction control.
  assert.doesNotMatch(
    migrationSql
      .replace(/\$function\$[\s\S]*?\$function\$/g, "")
      .replace(/--.*$/gm, ""),
    /^\s*(?:begin|commit|rollback|end|start transaction|savepoint)\b|concurrently|\bvacuum\b|create database|alter system/im,
  );

  startCluster();
  sql("postgres", FIXTURE_SQL);

  // (A) Fixture-only catalog fingerprints.
  const fixtureLines = catalogLines(ROLLBACK_DB);
  report.fingerprints.fixture_before = fingerprintOf(fixtureLines);
  const probeBefore = catalogLines(PROBE_DB);
  report.fingerprints.probe_before = fingerprintOf(probeBefore);

  // (B) Rollback-only application on one connection.
  await check(
    "B1 rollback-only migration restores the exact fixture catalog",
    () => {
      const marker = "-- P2-007 rollback-only proof\n";
      const script = [
        marker,
        "begin;",
        "select 'TXID=' || txid_current();",
        migrationSql,
        "select 'OBJECTS=' || (to_regclass('public.registration_quota_counters') is not null)",
        "  || ',' || (to_regprocedure('public.registration_quota_decide(text,text,text,integer,integer,integer)') is not null);",
        FINGERPRINT_QUERY,
        "rollback;",
        "select 'AFTER=' || (to_regclass('public.registration_quota_counters') is null);",
        "",
      ].join("\n");
      const out = sql(ROLLBACK_DB, script);
      assert.match(out, /^OBJECTS=true,true$/m);
      assert.match(out, /^AFTER=true$/m);
      const inside = out.split("\n").filter((line) => /^[a-z_]+\|/.test(line));
      report.fingerprints.rollback_in_transaction = fingerprintOf(inside);
      const after = catalogLines(ROLLBACK_DB);
      report.fingerprints.rollback_after = fingerprintOf(after);
      assert.equal(
        report.fingerprints.rollback_after.sha256,
        report.fingerprints.fixture_before.sha256,
      );
      assert.deepEqual(after, fixtureLines);
      assert.notEqual(
        report.fingerprints.rollback_in_transaction.sha256,
        report.fingerprints.fixture_before.sha256,
      );
      return { equal_after_rollback: true };
    },
  );

  // (C) Committed disposable application in the sibling database.
  await check(
    "C1 committed application and exact catalog delta against the object allowlist",
    () => {
      assert.deepEqual(probeBefore, fixtureLines);
      const applied = run(
        "psql",
        [...psqlArgs(PROBE_DB).slice(0, -2), "-1", "-f", "-"],
        {
          input: migrationSql,
        },
      );
      report.psql.invocations += 1;
      assert.equal(applied.status, 0, applied.stderr);
      const after = catalogLines(PROBE_DB);
      report.fingerprints.probe_after = fingerprintOf(after);
      assert.equal(
        report.fingerprints.probe_after.sha256,
        report.fingerprints.rollback_in_transaction.sha256,
      );
      const before = new Set(probeBefore);
      const now = new Set(after);
      const removed = probeBefore.filter((line) => !now.has(line));
      const added = after.filter((line) => !before.has(line));
      assert.deepEqual(removed, []);
      const kinds = {};
      for (const line of added) {
        const kind = line.slice(0, line.indexOf("|"));
        kinds[kind] = (kinds[kind] ?? 0) + 1;
        const rest = line.slice(kind.length + 1);
        assert.ok(
          OBJECTS.some((object) => rest.startsWith(object)),
          `unexpected catalog change: ${line}`,
        );
      }
      assert.deepEqual(kinds, EXPECTED_DELTA);
      report.catalog_delta = {
        removed: removed.length,
        added: added.length,
        by_kind: kinds,
        lines: added,
        meaning:
          "Exact disposable candidate catalog/scope diff against the approved object allowlist only; not a Staging drift comparison.",
      };
      return { added: added.length, removed: 0 };
    },
  );

  await runProbes();
}

async function runProbes() {
  const db = PROBE_DB;
  const table = "public.registration_quota_counters";
  const fn =
    "public.registration_quota_decide(text,text,text,integer,integer,integer)";

  await check(
    "C2 RLS, ownership, exact ACLs, SECURITY INVOKER, search path, and lock timeout",
    () => {
      const facts = JSON.parse(
        sqlValue(
          db,
          `select json_build_object(
           'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity,
           'owner', pg_get_userbyid(c.relowner), 'relacl', c.relacl::text,
           'policies', (select count(*) from pg_policy where polrelid = c.oid),
           'column_acls', (select json_object_agg(attname, attacl::text)
              from pg_attribute where attrelid = c.oid and attnum > 0 and attacl is not null),
           'secdef', p.prosecdef, 'volatility', p.provolatile,
           'config', p.proconfig, 'proacl', p.proacl::text,
           'fn_owner', pg_get_userbyid(p.proowner),
           'service_role_bypassrls', (select rolbypassrls from pg_roles where rolname = 'service_role'),
           'public_schema_usage', json_build_object(
              'anon', has_schema_privilege('anon', 'public', 'USAGE'),
              'authenticated', has_schema_privilege('authenticated', 'public', 'USAGE'),
              'service_role', has_schema_privilege('service_role', 'public', 'USAGE')))::text
         from pg_class c, pg_proc p
         where c.oid = '${table}'::regclass and p.oid = '${fn}'::regprocedure;`,
        ),
      );
      assert.equal(facts.rls, true);
      assert.equal(facts.force_rls, false);
      assert.equal(facts.policies, 0);
      assert.equal(facts.owner, SUPERUSER);
      assert.equal(
        facts.relacl,
        `{${SUPERUSER}=arwdDxt/${SUPERUSER},service_role=ard/${SUPERUSER}}`,
      );
      assert.deepEqual(facts.column_acls, {
        accepted_count: `{service_role=w/${SUPERUSER}}`,
        throttled_count: `{service_role=w/${SUPERUSER}}`,
      });
      assert.equal(facts.secdef, false);
      assert.equal(facts.volatility, "v");
      assert.deepEqual(facts.config, [
        "search_path=pg_catalog",
        "lock_timeout=250ms",
      ]);
      assert.equal(
        facts.proacl,
        `{${SUPERUSER}=X/${SUPERUSER},service_role=X/${SUPERUSER}}`,
      );
      assert.equal(facts.service_role_bypassrls, true);
      const privileges = JSON.parse(
        sqlValue(
          db,
          `select json_object_agg(r, json_build_object(
           'select', has_table_privilege(r, '${table}', 'SELECT'),
           'insert', has_table_privilege(r, '${table}', 'INSERT'),
           'update', has_table_privilege(r, '${table}', 'UPDATE'),
           'delete', has_table_privilege(r, '${table}', 'DELETE'),
           'truncate', has_table_privilege(r, '${table}', 'TRUNCATE'),
           'references', has_table_privilege(r, '${table}', 'REFERENCES'),
           'trigger', has_table_privilege(r, '${table}', 'TRIGGER'),
           'update_accepted', has_column_privilege(r, '${table}', 'accepted_count', 'UPDATE'),
           'update_throttled', has_column_privilege(r, '${table}', 'throttled_count', 'UPDATE'),
           'update_window_end', has_column_privilege(r, '${table}', 'window_end', 'UPDATE'),
           'update_policy_marker', has_column_privilege(r, '${table}', 'policy_marker', 'UPDATE'),
           'execute', has_function_privilege(r, '${fn}', 'EXECUTE')))::text
         from unnest(array['anon', 'authenticated', 'proof_public_probe', 'service_role']) r;`,
        ),
      );
      for (const role of ["anon", "authenticated", "proof_public_probe"]) {
        assert.ok(
          Object.values(privileges[role]).every((value) => value === false),
          role,
        );
      }
      assert.deepEqual(privileges.service_role, {
        select: true,
        insert: true,
        update: false,
        delete: true,
        truncate: false,
        references: false,
        trigger: false,
        update_accepted: true,
        update_throttled: true,
        update_window_end: false,
        update_policy_marker: false,
        execute: true,
      });
      return { facts, privileges };
    },
  );

  const probeCall = {
    ip: digest("role-probe-ip"),
    identity: digest("role-probe-identity"),
    global: digest("role-probe-global"),
  };

  await check(
    "C3 anon, authenticated, and PUBLIC cannot read, write, or execute",
    () => {
      const before = tableHash(db);
      const results = {};
      for (const role of ["anon", "authenticated", "proof_public_probe"]) {
        results[role] = {
          execute: decideOne(db, probeCall, { role }),
          select: sqlError(
            db,
            `set role ${role};\nselect count(*) from ${table};`,
          ).code,
          insert: sqlError(
            db,
            `set role ${role};\ninsert into ${table} values ('ip', ${quoted(probeCall.ip)}, date_trunc('hour', now(), 'UTC'), date_trunc('hour', now(), 'UTC') + interval '1 hour', date_trunc('hour', now(), 'UTC') + interval '25 hours', 1, 0, '${M}');`,
          ).code,
          update: sqlError(
            db,
            `set role ${role};\nupdate ${table} set accepted_count = 1;`,
          ).code,
          delete: sqlError(db, `set role ${role};\ndelete from ${table};`).code,
          truncate: sqlError(db, `set role ${role};\ntruncate ${table};`).code,
        };
        assert.deepEqual(results[role], {
          execute: "error:42501",
          select: "42501",
          insert: "42501",
          update: "42501",
          delete: "42501",
          truncate: "42501",
        });
      }
      assert.equal(tableHash(db), before);
      return results;
    },
  );

  await check(
    "C4 service_role succeeds at the RPC and at the exact direct DML the invoker needs (BYPASSRLS disclosed)",
    () => {
      assert.equal(decideOne(db, probeCall), "allow");
      const counts = sql(
        db,
        `begin;
       set local role service_role;
       select 'SELECT=' || count(*) from ${table} where digest = ${quoted(probeCall.ip)};
       insert into ${table} select 'ip', ${quoted(digest("dml-ip"))}, window_start, window_end, expires_at, 1, 0, policy_marker from ${table} where dimension = 'ip' and digest = ${quoted(probeCall.ip)};
       update ${table} set accepted_count = accepted_count + 1 where digest = ${quoted(digest("dml-ip"))};
       select 'UPDATED=' || accepted_count from ${table} where digest = ${quoted(digest("dml-ip"))};
       delete from ${table} where digest = ${quoted(digest("dml-ip"))};
       select 'DELETED=' || count(*) from ${table} where digest = ${quoted(digest("dml-ip"))};
       rollback;`,
      );
      assert.match(counts, /^SELECT=1$/m);
      assert.match(counts, /^UPDATED=2$/m);
      assert.match(counts, /^DELETED=0$/m);
      assert.equal(
        sqlError(
          db,
          `set role service_role;\nupdate ${table} set window_end = window_end;`,
        ).code,
        "42501",
      );
      assert.equal(
        sqlError(db, `set role service_role;\ntruncate ${table};`).code,
        "42501",
      );
      // RLS is enabled with no policy, yet service_role reads every row: it
      // bypasses RLS, so the credential, not RLS, is the boundary.
      const visible = sqlValue(
        db,
        `set role service_role;\nselect count(*) from ${table};`,
      );
      assert.ok(Number(visible) >= 3);
      return {
        rpc: "allow",
        direct_select_insert_update_delete: true,
        rows_visible_to_service_role: Number(visible),
      };
    },
  );

  // Keep every exact-count scenario inside one UTC hour of the database clock.
  let current = clock(db);
  const toNextHour = HOUR - (current.now - current.hour);
  report.timing.seconds_to_next_hour_at_start = Math.round(toNextHour);
  if (toNextHour < 420) {
    const waitMs = Math.ceil(toNextHour + 3) * 1000;
    report.timing.waited_for_hour_boundary_ms = waitMs;
    progress(`waiting ${waitMs} ms to start clear of an hour boundary`);
    await sleep(waitMs);
    current = clock(db);
  }
  const { hour, day } = current;
  report.timing.functional_hour_start = new Date(hour * 1000).toISOString();

  await check(
    "C5 exact IP/hour boundary: 10 allowed, the 11th throttled with no reservation",
    () => {
      const ip = digest("s1-ip");
      const global = digest("s1-global");
      const identities = Array.from({ length: 11 }, (_, i) =>
        digest(`s1-identity-${i}`),
      );
      const decisions = decide(
        db,
        identities.map((identity) => ({ ip, identity, global })),
      );
      assert.deepEqual(decisions, [...Array(10).fill("allow"), "throttle"]);
      const rows = rowsFor(db, [ip, global, ...identities]);
      assert.deepEqual(
        [
          row(rows, "ip", ip).accepted,
          row(rows, "global", global).accepted,
          row(rows, "global", global).throttled,
        ],
        [10, 10, 1],
      );
      assert.equal(row(rows, "identity", identities[10]), undefined);
      for (const identity of identities.slice(0, 10)) {
        assert.equal(row(rows, "identity", identity).accepted, 1);
      }
      for (const item of rows) {
        assert.equal(item.marker, M);
        assert.equal(item.start, item.dimension === "identity" ? day : hour);
        assert.equal(
          item.end - item.start,
          item.dimension === "identity" ? DAY : HOUR,
        );
        assert.equal(item.expires - item.end, DAY);
        assert.equal(
          item.throttled,
          item.dimension === "global" ? item.throttled : 0,
        );
      }
      return { decisions: "10 allow, 1 throttle", rows: rows.length };
    },
  );

  await check(
    "C6 exact identity/day boundary: 10 allowed, the 11th throttled with no reservation",
    () => {
      const identity = digest("s2-identity");
      const global = digest("s2-global");
      const ips = Array.from({ length: 11 }, (_, i) => digest(`s2-ip-${i}`));
      const decisions = decide(
        db,
        ips.map((ip) => ({ ip, identity, global })),
      );
      assert.deepEqual(decisions, [...Array(10).fill("allow"), "throttle"]);
      const rows = rowsFor(db, [identity, global, ...ips]);
      assert.equal(row(rows, "identity", identity).accepted, 10);
      assert.equal(row(rows, "ip", ips[10]), undefined);
      assert.deepEqual(
        [
          row(rows, "global", global).accepted,
          row(rows, "global", global).throttled,
        ],
        [10, 1],
      );
    },
  );

  await check(
    "C7 exact global/hour boundary: 120 allowed, the 121st throttled with no reservation",
    () => {
      const global = digest("s3-global");
      const calls = Array.from({ length: 121 }, (_, i) => ({
        ip: digest(`s3-ip-${i}`),
        identity: digest(`s3-identity-${i}`),
        global,
      }));
      const decisions = decide(db, calls);
      assert.deepEqual(decisions, [...Array(120).fill("allow"), "throttle"]);
      const rows = rowsFor(db, [global, calls[120].ip, calls[120].identity]);
      assert.deepEqual(
        rows.map((item) => [item.dimension, item.accepted, item.throttled]),
        [["global", 120, 1]],
      );
    },
  );

  await check(
    "C8 SQL-enforced envelopes: bounds 1..100, 1..100, 1..1200 accepted exactly; outside refused with no change",
    () => {
      const fresh = (label, max) => ({
        ip: digest(`${label}-ip`),
        identity: digest(`${label}-identity`),
        global: digest(`${label}-global`),
        max,
      });
      assert.deepEqual(decide(db, [fresh("s4-low", [1, 1, 1])]), ["allow"]);
      assert.deepEqual(
        decide(db, [
          { ...fresh("s4-low-2", [1, 1, 1]), global: digest("s4-low-global") },
        ]),
        ["throttle"],
      );
      assert.deepEqual(decide(db, [fresh("s4-high", [100, 100, 1200])]), [
        "allow",
      ]);
      const before = tableHash(db);
      const refused = {};
      for (const max of [
        [0, 10, 120],
        [101, 10, 120],
        [-1, 10, 120],
        [10, 0, 120],
        [10, 101, 120],
        [10, 10, 0],
        [10, 10, 1201],
        [2147483647, 10, 120],
      ]) {
        refused[max.join("/")] = decideOne(
          db,
          fresh(`s4-out-${max.join("-")}`, max),
        );
      }
      const base = fresh("s4-null", MAX);
      const variants = {
        "null ip_max": callOf(base).replace(
          ", 10, 10, 120)",
          ", null, 10, 120)",
        ),
        "null identity_max": callOf(base).replace(
          ", 10, 10, 120)",
          ", 10, null, 120)",
        ),
        "null global_max": callOf(base).replace(
          ", 10, 10, 120)",
          ", 10, 10, null)",
        ),
        "null digest": callOf(base).replace(quoted(base.ip), "null"),
        "upper-case digest": callOf(base).replace(
          quoted(base.ip),
          `'${base.ip.toUpperCase()}'`,
        ),
        "short digest": callOf(base).replace(
          quoted(base.ip),
          `'${base.ip.slice(1)}'`,
        ),
        "long digest": callOf(base).replace(quoted(base.ip), `'${base.ip}0'`),
        "non-hex digest": callOf(base).replace(
          quoted(base.ip),
          `'${"g".repeat(64)}'`,
        ),
        "ip equals identity": callOf(base).replace(
          quoted(base.identity),
          quoted(base.ip),
        ),
        "ip equals global": callOf(base).replace(
          quoted(base.global),
          quoted(base.ip),
        ),
        "identity equals global": callOf(base).replace(
          quoted(base.global),
          quoted(base.identity),
        ),
      };
      for (const [name, call] of Object.entries(variants)) {
        const result = psql(db, `set role service_role;\nselect ${call};`);
        assert.equal(result.status, 3, name);
        report.psql.expected_errors += 1;
        refused[name] = `error:${sqlstateOf(result.stderr)}`;
        assert.match(
          result.stderr,
          new RegExp(`ERROR:  22023: ${UNAVAILABLE_MESSAGE}\\n`),
          name,
        );
        assert.doesNotMatch(result.stderr, /DETAIL:|HINT:/, name);
        assert.equal(result.stderr.includes(base.identity), false, name);
      }
      for (const [name, outcome] of Object.entries(refused)) {
        assert.equal(outcome, "error:22023", name);
      }
      assert.equal(tableHash(db), before);
      return refused;
    },
  );

  await check(
    "C9 unknown or extra parameters and wrong argument types match no function",
    () => {
      const base = {
        ip: digest("s6-ip"),
        identity: digest("s6-identity"),
        global: digest("s6-global"),
      };
      const call = callOf(base);
      const before = tableHash(db);
      const attempts = {
        "seven arguments": call.replace(", 120)", ", 120, 1)"),
        "five arguments": call.replace(", 10, 120)", ", 10)"),
        "unknown named argument": `public.registration_quota_decide(ip_digest => ${quoted(base.ip)}, identity_digest => ${quoted(base.identity)}, global_digest => ${quoted(base.global)}, ip_max => 10, identity_max => 10, global_max => 120, override => true)`,
        "integer digest": call.replace(quoted(base.ip), "7"),
        "numeric maximum": call.replace(", 10, 10, 120)", ", 10.5, 10, 120)"),
        "timestamp argument": call.replace(", 120)", ", 120, now())"),
      };
      const results = {};
      for (const [name, text] of Object.entries(attempts)) {
        results[name] = sqlError(
          db,
          `set role service_role;\nselect ${text};`,
        ).code;
        assert.equal(results[name], "42883", name);
      }
      assert.equal(tableHash(db), before);
      return results;
    },
  );

  await check(
    "C10 policy-marker mismatch with any existing current row is unavailable; changed settings never extend a spent budget",
    () => {
      const s1Ip = digest("s1-ip");
      const s1Global = digest("s1-global");
      const s1Identity = digest("s1-identity-0");
      const before = tableHash(db);
      const outcomes = {
        "ip row, ip max raised": decideOne(db, {
          ip: s1Ip,
          identity: digest("s7-a-identity"),
          global: digest("s7-a-global"),
          max: [20, 10, 120],
        }),
        "global row, ip max changed": decideOne(db, {
          ip: digest("s7-b-ip"),
          identity: digest("s7-b-identity"),
          global: s1Global,
          max: [11, 10, 120],
        }),
        "identity row, identity max changed": decideOne(db, {
          ip: digest("s7-c-ip"),
          identity: s1Identity,
          global: digest("s7-c-global"),
          max: [10, 11, 120],
        }),
        "global row, global max changed": decideOne(db, {
          ip: digest("s7-d-ip"),
          identity: digest("s7-d-identity"),
          global: s1Global,
          max: [10, 10, 121],
        }),
      };
      for (const [name, outcome] of Object.entries(outcomes)) {
        assert.equal(outcome, "error:55000", name);
      }
      assert.equal(tableHash(db), before);
      // With no applicable state at all, a differently configured first
      // decision is accepted: the marker cannot attest uniformity by itself.
      const stateFree = decide(db, [
        {
          ip: digest("s7-e-ip"),
          identity: digest("s7-e-identity"),
          global: digest("s7-e-global"),
          max: [12, 10, 120],
        },
      ]);
      assert.deepEqual(stateFree, ["allow"]);
      assert.equal(
        rowsFor(db, [digest("s7-e-global")])[0].marker,
        marker([12, 10, 120]),
      );
      return {
        ...outcomes,
        "state-free differing first decision": stateFree[0],
      };
    },
  );

  await check(
    "C11 required edge: an identity-capped request in an hour with no global row creates exactly one aggregate-only global row",
    () => {
      const identity = digest("s9-identity");
      const global = digest("s9-global");
      const priorIp = digest("s9-prior-ip");
      seed(db, [
        { dimension: "identity", digest: identity, start: day, accepted: 10 },
        { dimension: "ip", digest: priorIp, start: hour - HOUR, accepted: 10 },
        {
          dimension: "global",
          digest: global,
          start: hour - HOUR,
          accepted: 10,
        },
      ]);
      const freshIp = digest("s9-fresh-ip");
      const priorRows = rowsFor(db, [priorIp, global]);
      assert.equal(
        rowsWhere(
          db,
          `digest = ${quoted(global)} and window_start = to_timestamp(${hour})`,
        ).length,
        0,
      );
      assert.deepEqual(decide(db, [{ ip: freshIp, identity, global }]), [
        "throttle",
      ]);
      let rows = rowsFor(db, [identity, global, freshIp, priorIp]);
      assert.deepEqual(row(rows, "global", global, hour), {
        dimension: "global",
        digest: global,
        start: hour,
        end: hour + HOUR,
        expires: hour + HOUR + DAY,
        accepted: 0,
        throttled: 1,
        marker: M,
      });
      assert.equal(row(rows, "ip", freshIp), undefined);
      assert.equal(row(rows, "identity", identity).accepted, 10);
      assert.deepEqual(
        row(rows, "global", global, hour - HOUR),
        row(priorRows, "global", global, hour - HOUR),
      );
      assert.deepEqual(row(rows, "ip", priorIp), row(priorRows, "ip", priorIp));
      // A repeat throttle advances only the tally of the same single row.
      assert.deepEqual(
        decide(db, [{ ip: digest("s9-fresh-ip-2"), identity, global }]),
        ["throttle"],
      );
      rows = rowsFor(db, [global]);
      assert.equal(rows.filter((item) => item.start === hour).length, 1);
      assert.deepEqual(
        [
          row(rows, "global", global, hour).accepted,
          row(rows, "global", global, hour).throttled,
        ],
        [0, 2],
      );
      // A mismatched policy on that path changes nothing.
      const before = tableHash(db);
      assert.equal(
        decideOne(db, {
          ip: digest("s9-fresh-ip-3"),
          identity,
          global,
          max: [11, 10, 120],
        }),
        "error:55000",
      );
      assert.equal(tableHash(db), before);
      // A later allowed request reserves its accepted unit in that row.
      assert.deepEqual(
        decide(db, [
          {
            ip: digest("s9-other-ip"),
            identity: digest("s9-other-identity"),
            global,
          },
        ]),
        ["allow"],
      );
      rows = rowsFor(db, [global]);
      assert.deepEqual(
        [
          row(rows, "global", global, hour).accepted,
          row(rows, "global", global, hour).throttled,
        ],
        [1, 2],
      );
      return { first_throttle_row: { accepted: 0, throttled: 1, marker: M } };
    },
  );

  await check(
    "C12 the throttle tally saturates at 2147483647 without error or overflow",
    () => {
      const identity = digest("s10-identity");
      const global = digest("s10-global");
      seed(db, [
        { dimension: "identity", digest: identity, start: day, accepted: 10 },
        {
          dimension: "global",
          digest: global,
          start: hour,
          accepted: 0,
          throttled: INT_MAX - 1,
        },
      ]);
      const decisions = decide(db, [
        { ip: digest("s10-ip-1"), identity, global },
        { ip: digest("s10-ip-2"), identity, global },
        { ip: digest("s10-ip-3"), identity, global },
      ]);
      assert.deepEqual(decisions, ["throttle", "throttle", "throttle"]);
      const rows = rowsFor(db, [global]);
      assert.equal(row(rows, "global", global, hour).throttled, INT_MAX);
      assert.equal(row(rows, "global", global, hour).accepted, 0);
    },
  );

  await check(
    "C13 a failing decision is all-or-none: no partial reservation",
    () => {
      const ip = digest("s11-ip");
      seed(db, [
        {
          dimension: "ip",
          digest: ip,
          start: hour,
          accepted: 1,
          marker: marker([11, 10, 120]),
        },
      ]);
      const identity = digest("s11-identity");
      const global = digest("s11-global");
      const before = tableHash(db);
      assert.equal(decideOne(db, { ip, identity, global }), "error:55000");
      assert.equal(tableHash(db), before);
      assert.deepEqual(rowsFor(db, [identity, global]), []);
    },
  );

  await check(
    "C14 reservations are transactional: a rolled-back or aborted caller transaction keeps nothing",
    () => {
      const first = {
        ip: digest("s12-ip"),
        identity: digest("s12-identity"),
        global: digest("s12-global"),
      };
      const out = sql(
        db,
        `begin;\nset local role service_role;\n${decisionStatement(first)}\nrollback;\n`,
      );
      assert.deepEqual(decisionsIn(out), ["allow"]);
      assert.deepEqual(
        rowsFor(db, [first.ip, first.identity, first.global]),
        [],
      );
      const result = psql(
        db,
        `begin;\nset local role service_role;\n${decisionStatement(first)}\nselect ${callOf({ ...first, max: [0, 10, 120] })};\ncommit;\n`,
      );
      assert.equal(result.status, 3);
      report.psql.expected_errors += 1;
      assert.equal(sqlstateOf(result.stderr), "22023");
      assert.deepEqual(
        rowsFor(db, [first.ip, first.identity, first.global]),
        [],
      );
    },
  );

  await check(
    "C15 a decision past the 1,500 ms statement deadline is rolled back and refused",
    () => {
      const late = {
        ip: digest("s13-ip"),
        identity: digest("s13-identity"),
        global: digest("s13-global"),
      };
      const started = Date.now();
      const result = psql(
        db,
        `set role service_role;\nwith s as materialized (select pg_sleep(1.6))\nselect 'DECISION=' || ${callOf(late)} from s;\n`,
      );
      const elapsedMs = Date.now() - started;
      assert.equal(result.status, 3);
      report.psql.expected_errors += 1;
      assert.equal(sqlstateOf(result.stderr), "57014");
      assert.deepEqual(rowsFor(db, [late.ip, late.identity, late.global]), []);
      const prompt = {
        ip: digest("s13-ip-b"),
        identity: digest("s13-identity-b"),
        global: digest("s13-global-b"),
      };
      const ok = sql(
        db,
        `set role service_role;\nwith s as materialized (select pg_sleep(0.2))\nselect 'DECISION=' || ${callOf(prompt)} from s;\n`,
      );
      assert.deepEqual(decisionsIn(ok), ["allow"]);
      report.timing.deadline_refusal_elapsed_ms = elapsedMs;
      return { refused_after_ms: elapsedMs };
    },
  );

  await check(
    "C16 the decision lock waits at most lock_timeout (250 ms) and then refuses with nothing reserved",
    async () => {
      const dbOid = sqlValue(
        db,
        `select oid from pg_database where datname = '${db}';`,
      );
      const classid = Number(DECISION_LOCK >> 32n);
      const objid = Number(DECISION_LOCK & 0xffffffffn);
      const holder = spawnPsql(db);
      holder.child.stdin.write(
        `begin;\nselect pg_advisory_xact_lock(${DECISION_LOCK});\n`,
      );
      await waitFor(
        () =>
          sqlValue(
            db,
            `select count(*) from pg_locks where locktype = 'advisory' and database = ${dbOid}
             and classid = ${classid} and objid = ${objid} and objsubid = 1 and granted;`,
          ) === "1",
        "decision lock holder",
      );
      const blocked = {
        ip: digest("s14-ip"),
        identity: digest("s14-identity"),
        global: digest("s14-global"),
      };
      const started = Date.now();
      const outcome = decideOne(db, blocked);
      const elapsedMs = Date.now() - started;
      holder.child.stdin.end("rollback;\n");
      await holder.done;
      assert.equal(outcome, "error:55P03");
      assert.ok(elapsedMs >= 250, `${elapsedMs}`);
      assert.ok(elapsedMs < 1500, `${elapsedMs}`);
      assert.deepEqual(
        rowsFor(db, [blocked.ip, blocked.identity, blocked.global]),
        [],
      );
      assert.equal(decideOne(db, blocked), "allow");
      report.timing.lock_timeout_refusal_elapsed_ms = elapsedMs;
      return { outcome, elapsed_ms_including_psql_start: elapsedMs };
    },
  );

  await check(
    "C17 prior windows never count: real calls over prior-hour/day rows seeded from the database clock, and the nominal 20 / 20 / 240 two-window bursts",
    () => {
      const ip = digest("s8-ip");
      const identity = digest("s8-identity");
      const global = digest("s8-global");
      seed(db, [
        { dimension: "ip", digest: ip, start: hour - HOUR, accepted: 10 },
        {
          dimension: "identity",
          digest: identity,
          start: day - DAY,
          accepted: 10,
        },
        {
          dimension: "global",
          digest: global,
          start: hour - HOUR,
          accepted: 120,
        },
      ]);
      const ipDecisions = decide(
        db,
        Array.from({ length: 11 }, (_, i) => ({
          ip,
          identity: digest(`s8-ip-identity-${i}`),
          global: digest("s8-ip-global"),
        })),
      );
      assert.deepEqual(ipDecisions, [...Array(10).fill("allow"), "throttle"]);
      const identityDecisions = decide(
        db,
        Array.from({ length: 11 }, (_, i) => ({
          ip: digest(`s8-identity-ip-${i}`),
          identity,
          global: digest("s8-identity-global"),
        })),
      );
      assert.deepEqual(identityDecisions, [
        ...Array(10).fill("allow"),
        "throttle",
      ]);
      const globalDecisions = decide(
        db,
        Array.from({ length: 121 }, (_, i) => ({
          ip: digest(`s8-global-ip-${i}`),
          identity: digest(`s8-global-identity-${i}`),
          global,
        })),
      );
      assert.deepEqual(globalDecisions, [
        ...Array(120).fill("allow"),
        "throttle",
      ]);
      const rows = rowsFor(db, [ip, identity, global]);
      const sum = (dimension, value) =>
        rows
          .filter(
            (item) => item.dimension === dimension && item.digest === value,
          )
          .reduce((total, item) => total + item.accepted, 0);
      assert.deepEqual(
        [
          row(rows, "ip", ip, hour - HOUR).accepted,
          row(rows, "ip", ip, hour).accepted,
          sum("ip", ip),
        ],
        [10, 10, 20],
      );
      assert.deepEqual(
        [
          row(rows, "identity", identity, day - DAY).accepted,
          row(rows, "identity", identity, day).accepted,
          sum("identity", identity),
        ],
        [10, 10, 20],
      );
      assert.deepEqual(
        [
          row(rows, "global", global, hour - HOUR).accepted,
          row(rows, "global", global, hour).accepted,
          sum("global", global),
        ],
        [120, 120, 240],
      );
      return {
        method:
          "seeded prior-window rows from the database clock; not a real clock rollover",
        two_window_totals: { ip: 20, identity: 20, global: 240 },
      };
    },
  );

  await check(
    "C18 windows are UTC-aligned regardless of the session time zone",
    () => {
      const results = {};
      for (const zone of [
        "Pacific/Chatham",
        "Asia/Kolkata",
        "America/St_Johns",
      ]) {
        const call = {
          ip: digest(`s16-${zone}-ip`),
          identity: digest(`s16-${zone}-identity`),
          global: digest(`s16-${zone}-global`),
        };
        assert.deepEqual(decide(db, [call], `set timezone = '${zone}';\n`), [
          "allow",
        ]);
        const rows = rowsFor(db, [call.ip, call.identity, call.global]);
        for (const item of rows) {
          assert.equal(
            item.start % (item.dimension === "identity" ? DAY : HOUR),
            0,
            zone,
          );
          assert.equal(
            item.start,
            item.dimension === "identity" ? day : hour,
            zone,
          );
        }
        results[zone] = rows.length;
      }
      return results;
    },
  );

  await check(
    "C19 deterministic UTC hour/day edges over synthetic timestamps and the window CHECK constraint",
    () => {
      const edges = sql(
        db,
        `set timezone = 'America/New_York';
       select json_agg(json_build_object('t', t,
         'hour', extract(epoch from date_trunc('hour', ts, 'UTC'))::bigint,
         'day', extract(epoch from date_trunc('day', ts, 'UTC'))::bigint) order by t)
       from (values
         ('2026-10-20 23:59:59.999999+00'), ('2026-10-21 00:00:00+00'),
         ('2026-10-21 00:59:59.999999+00'), ('2026-10-21 01:00:00+00'),
         ('2026-11-01 05:59:59.999999+00'), ('2026-11-01 06:00:00+00'),
         ('2026-12-31 23:59:59.999999+00'), ('2027-01-01 00:00:00+00')
       ) v(t), lateral (select t::timestamptz as ts) x;`,
      ).trim();
      const expected = {
        "2026-10-20 23:59:59.999999+00": [
          "2026-10-20T23:00:00Z",
          "2026-10-20T00:00:00Z",
        ],
        "2026-10-21 00:00:00+00": [
          "2026-10-21T00:00:00Z",
          "2026-10-21T00:00:00Z",
        ],
        "2026-10-21 00:59:59.999999+00": [
          "2026-10-21T00:00:00Z",
          "2026-10-21T00:00:00Z",
        ],
        "2026-10-21 01:00:00+00": [
          "2026-10-21T01:00:00Z",
          "2026-10-21T00:00:00Z",
        ],
        "2026-11-01 05:59:59.999999+00": [
          "2026-11-01T05:00:00Z",
          "2026-11-01T00:00:00Z",
        ],
        "2026-11-01 06:00:00+00": [
          "2026-11-01T06:00:00Z",
          "2026-11-01T00:00:00Z",
        ],
        "2026-12-31 23:59:59.999999+00": [
          "2026-12-31T23:00:00Z",
          "2026-12-31T00:00:00Z",
        ],
        "2027-01-01 00:00:00+00": [
          "2027-01-01T00:00:00Z",
          "2027-01-01T00:00:00Z",
        ],
      };
      const epoch = (iso) => Date.parse(iso) / 1000;
      for (const item of JSON.parse(edges)) {
        assert.deepEqual(
          [item.hour, item.day],
          expected[item.t].map(epoch),
          item.t,
        );
      }
      // The table refuses misaligned or inconsistent windows outright.
      const insert = (values) =>
        sqlError(
          db,
          `begin;\ninsert into ${table} values (${values});\nrollback;`,
        ).code;
      const d = quoted(digest("s17-row"));
      const refused = {
        "ip half hour": insert(
          `'ip', ${d}, '2026-10-21 10:30:00+00', '2026-10-21 11:30:00+00', '2026-10-22 11:30:00+00', 1, 0, '${M}'`,
        ),
        "identity hour start": insert(
          `'identity', ${d}, '2026-10-21 10:00:00+00', '2026-10-22 10:00:00+00', '2026-10-23 10:00:00+00', 1, 0, '${M}'`,
        ),
        "ip day width": insert(
          `'ip', ${d}, '2026-10-21 10:00:00+00', '2026-10-22 10:00:00+00', '2026-10-23 10:00:00+00', 1, 0, '${M}'`,
        ),
        "expiry not end plus 24h": insert(
          `'ip', ${d}, '2026-10-21 10:00:00+00', '2026-10-21 11:00:00+00', '2026-10-21 12:00:00+00', 1, 0, '${M}'`,
        ),
      };
      for (const [name, code] of Object.entries(refused)) {
        assert.equal(code, "23514", name);
      }
      return { edges: Object.keys(expected).length, refused };
    },
  );

  await check(
    "C20 row constraints: no zero IP/identity reservation, no empty global row, bounded counts, canonical marker and digest",
    () => {
      const start = `to_timestamp(${hour})`;
      const end = `to_timestamp(${hour + HOUR})`;
      const expires = `to_timestamp(${hour + HOUR + DAY})`;
      const d = quoted(digest("s18-row"));
      const insert = (
        dimension,
        accepted,
        throttled,
        value = M,
        digestText = d,
      ) =>
        sqlError(
          db,
          `begin;\ninsert into ${table} values ('${dimension}', ${digestText}, ${start}, ${end}, ${expires}, ${accepted}, ${throttled}, '${value}');\nrollback;`,
        ).code;
      const refused = {
        "ip accepted 0": insert("ip", 0, 0),
        "ip throttled 1": insert("ip", 1, 1),
        "ip accepted 101": insert("ip", 101, 0),
        "global empty": insert("global", 0, 0),
        "global accepted 1201": insert("global", 1201, 0),
        "global negative throttled": insert("global", 1, -1),
        "marker out of envelope": insert("ip", 1, 0, marker([101, 10, 120])),
        "marker other windows": insert(
          "ip",
          1,
          0,
          M.replace("3600,86400,3600", "60,86400,3600"),
        ),
        "upper-case digest": insert(
          "ip",
          1,
          0,
          M,
          `'${digest("s18-row").toUpperCase()}'`,
        ),
        "unknown dimension": insert("email", 1, 0),
      };
      for (const [name, code] of Object.entries(refused)) {
        assert.equal(code, "23514", name);
      }
      const duplicate = sqlError(
        db,
        `begin;\ninsert into ${table} values ('ip', ${d}, ${start}, ${end}, ${expires}, 1, 0, '${M}');\ninsert into ${table} values ('ip', ${d}, ${start}, ${end}, ${expires}, 1, 0, '${M}');\nrollback;`,
      ).code;
      assert.equal(duplicate, "23505");
      return { refused, duplicate };
    },
  );

  await check(
    "C21 bounded pruning: at most 100 expired rows per decision, in deterministic order; current and unexpired rows stay; a failed decision prunes nothing",
    () => {
      assert.deepEqual(rowsWhere(db, "expires_at <= clock_timestamp()"), []);
      const seeded = [];
      for (let i = 0; i < 150; i += 1) {
        const dimension = ["global", "identity", "ip"][i % 3];
        const start =
          dimension === "identity"
            ? day - (2 + (i % 7)) * DAY
            : hour - (26 + (i % 40)) * HOUR;
        seeded.push({
          dimension,
          digest: digest(`s15-${i}`),
          start,
          accepted: 1,
        });
      }
      seed(db, seeded);
      const order = seeded
        .map((item) => ({
          ...item,
          expires:
            item.start + (item.dimension === "identity" ? DAY : HOUR) + DAY,
        }))
        .sort((a, b) =>
          a.expires !== b.expires
            ? a.expires - b.expires
            : a.dimension !== b.dimension
              ? a.dimension < b.dimension
                ? -1
                : 1
              : a.digest !== b.digest
                ? a.digest < b.digest
                  ? -1
                  : 1
                : a.start - b.start,
        );
      const unexpiredBefore = rowsWhere(
        db,
        "expires_at > clock_timestamp()",
      ).length;
      const failing = {
        ip: digest("s15-fail-ip"),
        identity: digest("s15-fail-identity"),
        global: digest("s15-fail-global"),
        max: [0, 10, 120],
      };
      assert.equal(decideOne(db, failing), "error:22023");
      assert.equal(
        rowsWhere(db, "expires_at <= clock_timestamp()").length,
        150,
      );
      assert.deepEqual(
        decide(db, [
          {
            ip: digest("s15-ip"),
            identity: digest("s15-identity"),
            global: digest("s15-global"),
          },
        ]),
        ["allow"],
      );
      const remaining = rowsWhere(db, "expires_at <= clock_timestamp()").map(
        (item) => `${item.dimension}|${item.digest}|${item.start}`,
      );
      assert.deepEqual(
        remaining.sort(),
        order
          .slice(100)
          .map((item) => `${item.dimension}|${item.digest}|${item.start}`)
          .sort(),
      );
      // A conclusive throttle also prunes, up to the same bound.
      assert.deepEqual(
        decide(db, [
          {
            ip: digest("s15-ip-2"),
            identity: digest("s10-identity"),
            global: digest("s10-global"),
          },
        ]),
        ["throttle"],
      );
      assert.deepEqual(rowsWhere(db, "expires_at <= clock_timestamp()"), []);
      assert.equal(
        rowsWhere(db, "expires_at > clock_timestamp()").length,
        unexpiredBefore + 3,
      );
      return { pruned_first: 100, pruned_second: 50 };
    },
  );

  await check(
    "C22 true concurrency: same address and many emails never overspends",
    async () => {
      const ip = digest("c1-ip");
      const global = digest("c1-global");
      const calls = Array.from({ length: 40 }, (_, i) => ({
        ip,
        identity: digest(`c1-identity-${i}`),
        global,
      }));
      const outcomes = await concurrent(db, "same address, 40 emails", calls);
      assert.equal(count(outcomes, "allow"), 10);
      assert.equal(count(outcomes, "throttle"), 30);
      const rows = rowsFor(db, [
        ip,
        global,
        ...calls.map((call) => call.identity),
      ]);
      assert.equal(row(rows, "ip", ip).accepted, 10);
      assert.deepEqual(
        [
          row(rows, "global", global).accepted,
          row(rows, "global", global).throttled,
        ],
        [10, 30],
      );
      assert.equal(
        rows.filter((item) => item.dimension === "identity").length,
        10,
      );
    },
  );

  await check(
    "C23 true concurrency: same email and many addresses never overspends",
    async () => {
      const identity = digest("c2-identity");
      const global = digest("c2-global");
      const calls = Array.from({ length: 40 }, (_, i) => ({
        ip: digest(`c2-ip-${i}`),
        identity,
        global,
      }));
      const outcomes = await concurrent(db, "same email, 40 addresses", calls);
      assert.equal(count(outcomes, "allow"), 10);
      assert.equal(count(outcomes, "throttle"), 30);
      const rows = rowsFor(db, [
        identity,
        global,
        ...calls.map((call) => call.ip),
      ]);
      assert.equal(row(rows, "identity", identity).accepted, 10);
      assert.equal(rows.filter((item) => item.dimension === "ip").length, 10);
    },
  );

  await check(
    "C24 true concurrency: global saturation in three waves of 50 reserves exactly 120",
    async () => {
      const global = digest("c3-global");
      const all = [];
      for (let wave = 0; wave < 3; wave += 1) {
        const calls = Array.from({ length: 50 }, (_, i) => ({
          ip: digest(`c3-ip-${wave}-${i}`),
          identity: digest(`c3-identity-${wave}-${i}`),
          global,
        }));
        all.push(
          ...(await concurrent(
            db,
            `global saturation wave ${wave + 1} of 3, 50 workers`,
            calls,
          )),
        );
      }
      assert.equal(count(all, "allow"), 120);
      assert.equal(count(all, "throttle"), 30);
      const rows = rowsFor(db, [global]);
      assert.deepEqual([rows[0].accepted, rows[0].throttled], [120, 30]);
    },
  );

  await check(
    "C25 true concurrency: simultaneous first throttles create exactly one aggregate-only global row",
    async () => {
      const identity = digest("c6-identity");
      const global = digest("c6-global");
      seed(db, [
        { dimension: "identity", digest: identity, start: day, accepted: 10 },
      ]);
      const calls = Array.from({ length: 30 }, (_, i) => ({
        ip: digest(`c6-ip-${i}`),
        identity,
        global,
      }));
      const outcomes = await concurrent(
        db,
        "30 simultaneous first throttles",
        calls,
      );
      assert.equal(count(outcomes, "throttle"), 30);
      const rows = rowsFor(db, [
        identity,
        global,
        ...calls.map((call) => call.ip),
      ]);
      assert.deepEqual(
        rows.map((item) => [
          item.dimension,
          item.accepted,
          item.throttled,
          item.marker,
        ]),
        [
          ["global", 0, 30, M],
          ["identity", 10, 0, M],
        ],
      );
    },
  );

  await check(
    "C26 true concurrency: mixed instance settings never both reserve; one policy wins and the other is unavailable",
    async () => {
      const global = digest("c4-global");
      const other = [11, 10, 120];
      const calls = Array.from({ length: 40 }, (_, i) => ({
        ip: digest(`c4-ip-${i}`),
        identity: digest(`c4-identity-${i}`),
        global,
        max: i % 2 === 0 ? MAX : other,
      }));
      const outcomes = await concurrent(
        db,
        "mixed settings, 20 + 20 workers",
        calls,
      );
      const byPolicy = (max) => outcomes.filter((_, i) => calls[i].max === max);
      const first = byPolicy(MAX);
      const second = byPolicy(other);
      const winner = count(first, "allow") > 0 ? MAX : other;
      const [won, lost] = winner === MAX ? [first, second] : [second, first];
      assert.equal(count(won, "allow"), 20);
      assert.equal(count(lost, "error:55000"), 20);
      const rows = rowsFor(db, [
        global,
        ...calls.map((call) => call.ip),
        ...calls.map((call) => call.identity),
      ]);
      assert.deepEqual(
        [...new Set(rows.map((item) => item.marker))],
        [marker(winner)],
      );
      assert.equal(
        rows.find((item) => item.dimension === "global").accepted,
        20,
      );
      return { winning_policy: marker(winner) };
    },
  );

  await check(
    "C27 true concurrency: overlapping scopes in crossing orders never deadlock and respect every cap",
    async () => {
      const global = digest("c7-global");
      const ips = [digest("c7-ip-a"), digest("c7-ip-b")];
      const identities = [digest("c7-identity-x"), digest("c7-identity-y")];
      const calls = [];
      for (let i = 0; i < 48; i += 1) {
        calls.push({
          ip: ips[i % 2],
          identity: identities[Math.floor(i / 2) % 2],
          global,
        });
      }
      const outcomes = await concurrent(
        db,
        "crossing scopes, 48 workers",
        calls,
      );
      assert.equal(
        outcomes.filter((outcome) => outcome.startsWith("error")).length,
        0,
      );
      const rows = rowsFor(db, [global, ...ips, ...identities]);
      for (const item of rows) {
        assert.ok(item.accepted <= (item.dimension === "global" ? 120 : 10));
      }
      const ipTotal = rows
        .filter((item) => item.dimension === "ip")
        .reduce((t, item) => t + item.accepted, 0);
      const identityTotal = rows
        .filter((item) => item.dimension === "identity")
        .reduce((t, item) => t + item.accepted, 0);
      assert.equal(ipTotal, count(outcomes, "allow"));
      assert.equal(identityTotal, count(outcomes, "allow"));
      assert.equal(
        row(rows, "global", global).accepted,
        count(outcomes, "allow"),
      );
      assert.equal(
        row(rows, "global", global).throttled,
        count(outcomes, "throttle"),
      );
      assert.equal(count(outcomes, "allow"), 20);
    },
  );

  await check("C28 storage stays bounded and identifier-free", () => {
    const summary = JSON.parse(
      sqlValue(
        db,
        `select json_build_object(
           'rows', count(*),
           'duplicate_keys', count(*) - count(distinct (dimension, digest, window_start)),
           'ip_identity_without_reservation', count(*) filter (where dimension <> 'global' and (accepted_count < 1 or throttled_count <> 0)),
           'empty_global', count(*) filter (where dimension = 'global' and accepted_count = 0 and throttled_count = 0),
           'global_rows_per_digest_hour', (select max(n) from (select count(*) n from public.registration_quota_counters where dimension = 'global' group by digest, window_start) g),
           'columns', (select json_agg(attname order by attnum) from pg_attribute where attrelid = '${table}'::regclass and attnum > 0 and not attisdropped))::text
         from public.registration_quota_counters;`,
      ),
    );
    assert.equal(summary.duplicate_keys, 0);
    assert.equal(summary.ip_identity_without_reservation, 0);
    assert.equal(summary.empty_global, 0);
    assert.equal(summary.global_rows_per_digest_hour, 1);
    assert.deepEqual(summary.columns, [
      "dimension",
      "digest",
      "window_start",
      "window_end",
      "expires_at",
      "accepted_count",
      "throttled_count",
      "policy_marker",
    ]);
    return summary;
  });

  const end = clock(db);
  report.timing.functional_hour_end = new Date(end.hour * 1000).toISOString();
  await check(
    "C29 every exact-count scenario ran inside one UTC hour of the database clock",
    () => {
      assert.equal(end.hour, hour);
    },
  );

  report.not_tested.push(
    "A real wall-clock rollover across an hour or UTC-day boundary: windows were proven with seeded prior-window rows from the database clock, deterministic SQL over synthetic timestamps, and arithmetic only.",
    "Idle retention: with no traffic, expired rows remain indefinitely; no deletion deadline exists or is claimed.",
    "Remote Supabase/PostgREST roles, grants, statement_timeout, and the deployed service_role topology: the roles here are synthetic fixtures.",
    "A server-preemptive statement_timeout for the RPC: PostgreSQL cannot arm one from inside the running statement; the function enforces lock_timeout and refuses (rolls back) any decision past 1,500 ms from statement start.",
  );
  report.math = {
    statement:
      "With fixed aligned windows of width W and maximum N, any interval shorter than W meets at most two windows, so at most 2N reservations can fall in it, and 2N is attainable arbitrarily close to a boundary.",
    initial: { ip: 2 * 10, identity: 2 * 10, global: 2 * 120 },
    ceilings: { ip: 2 * 100, identity: 2 * 100, global: 2 * 1200 },
  };
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

// A process that has exited but awaits reaping (state Z) is not running.
function isAlive(pid) {
  try {
    return !/^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
  } catch {
    return false;
  }
}

function processesUsing(directory) {
  const found = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) {
      continue;
    }
    try {
      const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
      let cwd = "";
      try {
        cwd = fs.readlinkSync(`/proc/${entry}/cwd`);
      } catch {
        cwd = "";
      }
      if (
        cmdline.includes(directory) ||
        cwd === directory ||
        cwd.startsWith(`${directory}/`)
      ) {
        found.push(Number(entry));
      }
    } catch {
      // The process ended while it was being read.
    }
  }
  return found;
}

async function teardown() {
  if (state === null) {
    return true;
  }
  const cleanup = report.cleanup;
  if (state.started) {
    const stop = run("pg_ctl", [
      "-D",
      state.dataDir,
      "-m",
      "fast",
      "-w",
      "-t",
      "60",
      "-s",
      "stop",
    ]);
    cleanup.pg_ctl_stop_exit = stop.status;
    if (stop.status !== 0 && state.postmasterPid) {
      try {
        process.kill(state.postmasterPid, "SIGQUIT");
      } catch {
        // Already gone.
      }
      await sleep(2000);
    }
  }
  cleanup.processes_after_stop = processesUsing(state.tmp);
  cleanup.socket_present_after_stop = fs.existsSync(
    path.join(state.socketDir, `.s.PGSQL.${PORT}`),
  );
  cleanup.postmaster_pid_file_present = state.dataDir
    ? fs.existsSync(path.join(state.dataDir, "postmaster.pid"))
    : false;
  if (state.postmasterPid) {
    for (let turn = 0; turn < 100 && isAlive(state.postmasterPid); turn += 1) {
      await sleep(50);
    }
    cleanup.postmaster_alive = isAlive(state.postmasterPid);
  }
  fs.rmSync(state.tmp, { recursive: true, force: true });
  cleanup.temporary_directory_removed = !fs.existsSync(state.tmp);
  cleanup.processes_after_removal = processesUsing(state.tmp);
  cleanup.leftover_proof_directories = fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith("rosuno-p2-007-db-proof-"));
  const clean =
    cleanup.processes_after_stop.length === 0 &&
    !cleanup.socket_present_after_stop &&
    !cleanup.postmaster_pid_file_present &&
    cleanup.postmaster_alive !== true &&
    cleanup.temporary_directory_removed &&
    cleanup.processes_after_removal.length === 0 &&
    cleanup.leftover_proof_directories.length === 0;
  cleanup.result = clean ? "CLEAN" : "INCOMPLETE";
  state = null;
  return clean;
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length > 1 ||
    (args.length === 1 && args[0] !== "--check-prerequisites")
  ) {
    process.stderr.write(
      "usage: registration-abuse-db-proof.mjs [--check-prerequisites]\n",
    );
    return 3;
  }
  let identity;
  try {
    identity = attestPrerequisites();
  } catch (error) {
    report.status = "NOT RUN";
    report.error = String(error.message);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 3;
  }
  if (args[0] === "--check-prerequisites") {
    report.status = "PREREQUISITES OK";
    report.mode = "check-prerequisites (no cluster, no connection)";
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  let exitCode = 1;
  const onSignal = async (signal) => {
    report.status = "FAIL";
    report.error = `interrupted by ${signal}`;
    const clean = await teardown();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(clean ? 1 : 2);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    createPrivateDirectory(identity);
    await proof();
    const failed = report.checks.filter((item) => item.result !== "PASS");
    report.status =
      failed.length === 0 && report.checks.length > 0 ? "PASS" : "FAIL";
    exitCode = report.status === "PASS" ? 0 : 1;
  } catch (error) {
    report.status = "FAIL";
    report.error = String(error?.stack ?? error);
    exitCode = 1;
  } finally {
    let clean = false;
    try {
      clean = await teardown();
    } catch (error) {
      report.cleanup.error = String(error?.message ?? error);
    }
    if (!clean) {
      report.status = "FAIL";
      report.cleanup.result = "INCOMPLETE";
      exitCode = 2;
    }
    report.finished_at = new Date().toISOString();
    report.summary = {
      checks: report.checks.length,
      passed: report.checks.filter((item) => item.result === "PASS").length,
      failed: report.checks
        .filter((item) => item.result !== "PASS")
        .map((item) => item.name),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  return exitCode;
}

process.exitCode = await main();
