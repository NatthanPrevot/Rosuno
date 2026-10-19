// P2-903: complete-chain regression coverage for separately authorized,
// forward-only migrations appended after the accepted thirteen P0/P1
// migrations. Every fixture is synthetic, disposable test input written to a
// temporary copy of the repository reset to the canonical thirteen-migration
// state; passing it proves repository consistency only, never owner approval,
// adoption or live Staging state.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import {
  PRE_APPLICATION_STATE,
  ROOT,
  ROOT_SCRIPT_PROFILES,
  WEB_APPLICATION_STATE,
  validateDriftReport,
  validateNeutralPaths,
  validateRepository,
} from "../lib/controls.mjs";

// Pinned once from canonical base cddb59e19a6cc69d1f9c4ee590698509bbadbe98,
// independently of any register under test. Prefix digests are SHA-256 over
// the JSON of the original thirteen records with object keys sorted
// recursively and array order kept (see prefixSha256).
const BASE_COMMIT = "cddb59e19a6cc69d1f9c4ee590698509bbadbe98";
const MIGRATION_REGISTER_SHA256 =
  "fdc9733cef8c7a573c3113cd56ba0fe10fa3a8b621b45cad3a099a61d81addde";
const RELEASE_REGISTER_SHA256 =
  "f3707b75fb027d26172cb7cb404428fa6e4e7d9980f04db1ea7ffbd7d8fd2691";
const BASELINE_SHA256 =
  "196caee4de2c870652ce5b716a9b02c484c97181b1d9c59e5abbc5c2966b2d65";
const MIGRATION_PREFIX_SHA256 =
  "d6b2ffadbda9b5a63c5b09b7ef1b022f60c8ca607b495858e185c71f26cbe18c";
const RELEASE_PREFIX_SHA256 =
  "4af80ee97c3eb5449cea03e95f3ebd9d5ddb305ffde2a89a973f929eedbc12ae";

const REGISTER = "governance/migrations/reviewed-migrations.json";
const RELEASES = "governance/releases/traceability.json";
const WORK_ITEMS = "governance/work-items/index.json";
const DECISIONS = "governance/decision-log.json";
const BASELINE = "governance/schema-drift/baseline.json";
const HISTORICAL_REGISTERS = [
  REGISTER,
  RELEASES,
  WORK_ITEMS,
  DECISIONS,
  BASELINE,
];
const P1011_MIGRATION_ID = "20260921051204_p1_compliance_foundation";

// Synthetic identities used only inside the disposable copy.
const MIGRATION_ID = "20261018000000_p2_903_synthetic_fixture";
const SQL_PATH = `supabase/migrations/${MIGRATION_ID}.sql`;
const SQL = "-- Synthetic P2-903 test fixture; never applied.\nselect 1;\n";
const WORK_ITEM_ID = "WI-P2-903-SYNTHETIC-APPENDED-MIGRATION";
const DECISION_ID = "DEC-20261018-P2-903-SYNTHETIC-APPENDED-MIGRATION";
const RELEASE_ID = "REL-20261018-P2-903-SYNTHETIC-STAGING-APPLICATION";
const EVIDENCE_PATH =
  "governance/evidence/p2-903-synthetic-appended-baseline.json";
// Synthetic records never name a real owner or carry an approval.
const SYNTHETIC_OWNER = "SYNTHETIC P2-903 TEST FIXTURE (no Rosuno owner)";
const UNRESOLVED_REVIEWER = {
  identity: null,
  status: "unresolved_external_dependency",
};

// The five p0-controls.test.mjs tests whose register assertions P2-903 changed.
const HISTORICAL_TESTS =
  "^(?:P1-00[678]|P1-010) accepted closure remains valid under the current P1-011 baseline$" +
  "|^P1-011 accepted Compliance closure requires exact lifecycle evidence and thirteen-migration baseline$";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortedKeys(value[key])]),
    );
  }
  return value;
}

function prefixSha256(records) {
  return sha256(JSON.stringify(sortedKeys(records.slice(0, 13))));
}

function liveJson(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
}

// A register as it was at canonical base, from the disposable fixture.
function historicalJson(relativePath) {
  return JSON.parse(fixture.historical[relativePath]);
}

function baseGit(args, encoding = null) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function listFiles(root) {
  return execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean);
}

// A disposable copy of the working tree with its own empty Git repository. Its
// alternates file gives read-only access to the real object store so the
// historical release commits resolve; nothing is written back. The copy is
// reset to the canonical thirteen-migration state: the governance registers and
// the exact governance/migrations and supabase inventory are read from
// canonical base BASE_COMMIT, so scenarios never build on whatever the live
// repository may have appended.
async function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "rosuno-p2-903-forward-"));
  for (const file of listFiles(ROOT)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  execFileSync("git", ["init", "-q", root]);
  const commonDirectory = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: ROOT, encoding: "utf8" },
  ).trim();
  writeFileSync(
    path.join(root, ".git/objects/info/alternates"),
    `${path.join(commonDirectory, "objects")}\n`,
  );
  const inventory = baseGit(
    [
      "ls-tree",
      "-r",
      "--name-only",
      BASE_COMMIT,
      "--",
      "governance/migrations",
      "supabase",
    ],
    "utf8",
  )
    .split("\n")
    .filter(Boolean);
  for (const file of listFiles(root)) {
    if (
      (file.startsWith("governance/migrations/") ||
        file.startsWith("supabase/")) &&
      !inventory.includes(file)
    ) {
      rmSync(path.join(root, file), { force: true });
    }
  }
  const historical = {};
  for (const file of new Set([...inventory, ...HISTORICAL_REGISTERS])) {
    historical[file] = baseGit(["show", `${BASE_COMMIT}:${file}`]);
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), historical[file]);
  }
  const controls = await import(
    pathToFileURL(path.join(root, "tools/p0/lib/controls.mjs")).href
  );
  return { root, controls, historical };
}

let fixture;

before(async () => {
  fixture = await createFixture();
});

after(() => {
  if (fixture) rmSync(fixture.root, { recursive: true, force: true });
});

// Applies file changes (string or Buffer content, { symlinkTo } or null to
// delete) to the disposable copy, runs `run`, then restores every file.
async function inScenario(changes, run) {
  const saved = new Map();
  for (const [file, content] of Object.entries(changes)) {
    const target = path.join(fixture.root, file);
    let original = null;
    try {
      lstatSync(target);
      original = readFileSync(target);
    } catch {
      // Absent before the scenario; removed again afterwards.
    }
    saved.set(target, original);
    rmSync(target, { force: true });
    if (content === null) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    if (content.symlinkTo) symlinkSync(content.symlinkTo, target);
    else writeFileSync(target, content);
  }
  try {
    return await run();
  } finally {
    for (const [target, original] of saved) {
      rmSync(target, { force: true });
      if (original !== null) writeFileSync(target, original);
    }
  }
}

function candidateMigration(authorityRefs) {
  return {
    migration_id: MIGRATION_ID,
    migration_kind: "product",
    sequence: 14,
    artifact_path: SQL_PATH,
    authority_refs: authorityRefs,
    work_item_refs: [WORK_ITEM_ID],
    decision_refs: [DECISION_ID],
    release_refs: [],
    reviewed: false,
    reviewed_by: "pending designated human PR review",
    reviewed_at: null,
    applied_environment: "none",
    non_production_validation: true,
    drift_check: "clean",
    rollback_plan:
      "Synthetic fixture: rollback-only validation restores the accepted thirteen-migration baseline; any defect is corrected by a separately reviewed forward-only migration.",
    depends_on: [P1011_MIGRATION_ID],
  };
}

function ownerWorkItem(authorityRefs, migrationRefs) {
  return {
    work_item_id: WORK_ITEM_ID,
    title: "SYNTHETIC P2-903 test fixture work item",
    objective:
      "Disposable test input proving appended migration validation; never live governance.",
    in_scope: ["synthetic appended migration validation"],
    out_of_scope: ["live governance, Staging or Production state"],
    status: "proposed",
    owner: SYNTHETIC_OWNER,
    reviewer: UNRESOLVED_REVIEWER,
    priority: "P2",
    authority_refs: authorityRefs,
    decision_refs: [DECISION_ID],
    dependencies: [],
    acceptance_criteria: ["validators accept only the registered candidate"],
    validation_commands: ["pnpm run p0:validate"],
    environment: "none",
    release_refs: [],
    migration_refs: migrationRefs,
    rollback_reference: "Remove the disposable fixture.",
    created_at: "2026-10-18T00:00:00Z",
    updated_at: "2026-10-18T00:00:00Z",
  };
}

function ownerDecision(authorityRefs) {
  return {
    decision_id: DECISION_ID,
    title: "SYNTHETIC P2-903 test fixture record (not an owner decision)",
    status: "proposed",
    scope: "Disposable P2-903 validator test input only.",
    decision: "Synthetic test input only; it records no owner decision.",
    rationale: "Exercises the appended migration validation chain.",
    authority_refs: authorityRefs,
    work_item_refs: [WORK_ITEM_ID],
    owner: SYNTHETIC_OWNER,
    reviewer: UNRESOLVED_REVIEWER,
    created_at: "2026-10-18T00:00:00Z",
    updated_at: "2026-10-18T00:00:00Z",
    supersedes: [],
    impact: "None outside the disposable fixture.",
    evidence: ["Synthetic P2-903 disposable fixture record"],
    expiry: null,
  };
}

function syntheticRelease(migrationRefs) {
  return {
    release_id: RELEASE_ID,
    commit_sha: BASE_COMMIT,
    work_item_refs: [WORK_ITEM_ID],
    decision_refs: [DECISION_ID],
    migration_refs: migrationRefs,
    validation_evidence: [
      "Synthetic P2-903 disposable fixture; not a real release",
    ],
    artifact_digest: `sha256:${sha256(SQL)}`,
    environment: "staging",
    reviewer: UNRESOLVED_REVIEWER,
    rollback_reference: "Disposable fixture; nothing to roll back.",
    created_at: "2026-10-18T01:00:00Z",
  };
}

// Canonical thirteen-migration governance with synthetic owner records,
// optionally plus the synthetic unapplied fourteenth migration and its SQL file.
function ownerState({ migration = true } = {}) {
  const register = historicalJson(REGISTER);
  const authorityRefs = [...register.migrations[12].authority_refs];
  const workItems = historicalJson(WORK_ITEMS);
  workItems.work_items.push(
    ownerWorkItem(authorityRefs, migration ? [MIGRATION_ID] : []),
  );
  const decisions = historicalJson(DECISIONS);
  decisions.decisions.push(ownerDecision(authorityRefs));
  const state = { workItems, decisions, files: {} };
  if (migration) {
    register.migrations.push(candidateMigration(authorityRefs));
    state.register = register;
    state.files[SQL_PATH] = SQL;
  }
  return state;
}

function candidateState() {
  return ownerState();
}

// The unapplied candidate plus a synthetic release suffix that carries no
// migration.
function mixedState() {
  const state = candidateState();
  state.releases = historicalJson(RELEASES);
  state.releases.releases.push(syntheticRelease([]));
  state.workItems.work_items.at(-1).release_refs = [RELEASE_ID];
  return state;
}

function withDigest(baseline) {
  const manifest = {
    baseline_id: baseline.baseline_id,
    checked_environment: baseline.checked_environment,
    project: baseline.project,
    migration_inventory: baseline.migration_inventory,
    accepted_evidence: baseline.accepted_evidence,
    catalog_fingerprint: baseline.catalog_fingerprint,
  };
  baseline.baseline_digest = `sha256:${sha256(JSON.stringify(manifest))}`;
  return baseline;
}

// The synthetic fourteenth migration persistently applied to Staging, with a
// bidirectional release and a later adopted baseline that extends the
// accepted P1-011 inventory and evidence.
function appliedState() {
  const state = candidateState();
  Object.assign(state.register.migrations[13], {
    release_refs: [RELEASE_ID],
    reviewed: true,
    reviewed_by: "SYNTHETIC P2-903 TEST FIXTURE (not a real review)",
    reviewed_at: "2026-10-18T01:00:00Z",
    applied_environment: "staging",
  });
  Object.assign(state.workItems.work_items.at(-1), {
    environment: "staging",
    release_refs: [RELEASE_ID],
  });
  state.releases = historicalJson(RELEASES);
  state.releases.releases.push(syntheticRelease([MIGRATION_ID]));
  const evidence = json({ fixture: "P2-903 synthetic appended baseline" });
  state.files[EVIDENCE_PATH] = evidence;
  const baseline = historicalJson(BASELINE);
  baseline.baseline_id = "rosuno-staging-p2-903-synthetic-20261018-v1";
  baseline.checked_at = "2026-10-18T02:00:00Z";
  baseline.migration_inventory.push({
    sequence: 14,
    migration_id: MIGRATION_ID,
    artifact_path: SQL_PATH,
    sha256: sha256(SQL),
  });
  baseline.accepted_evidence.push({
    path: EVIDENCE_PATH,
    sha256: sha256(evidence),
  });
  baseline.evidence.push(EVIDENCE_PATH);
  baseline.catalog_fingerprint = {
    ...baseline.catalog_fingerprint,
    sha256: "a".repeat(64),
    canonical_byte_length: 1,
    row_count: 1,
  };
  state.baseline = withDigest(baseline);
  return state;
}

function writes(state) {
  const changes = { ...state.files };
  for (const [key, file] of [
    ["register", REGISTER],
    ["workItems", WORK_ITEMS],
    ["decisions", DECISIONS],
    ["releases", RELEASES],
    ["baseline", BASELINE],
  ]) {
    if (state[key]) changes[file] = json(state[key]);
  }
  return changes;
}

function fixtureSurface(register) {
  const read = (file) => readFileSync(path.join(fixture.root, file), "utf8");
  return {
    files: listFiles(fixture.root),
    packageJson: JSON.parse(read("package.json")),
    workspace: read("pnpm-workspace.yaml"),
    webPackageJson: JSON.parse(read("apps/web/package.json")),
    npmrc: read(".npmrc"),
    migrationRegister: register,
  };
}

function rejectsChain(state, expected) {
  return inScenario(writes(state), () => {
    assert.throws(() => fixture.controls.validateRepository(), expected);
  });
}

// Runs historical test files inside the disposable copy, so they read that
// copy's registers and validators.
function runTests(files, namePattern = null) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      ...(namePattern ? [`--test-name-pattern=${namePattern}`] : []),
      ...[files].flat(),
    ],
    { cwd: fixture.root, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 },
  );
  return { status: result.status, output: result.stdout + result.stderr };
}

function failureSummary(run) {
  return run.output
    .split("\n")
    .filter((line) => /^\s*not ok |^# (?:tests|pass|fail) /.test(line))
    .join("\n");
}

function transitionContract() {
  return runTests("tools/p0/tests/p1-p2-transition-contract.test.mjs");
}

function historicalChecks() {
  return runTests("tools/p0/tests/p0-controls.test.mjs", HISTORICAL_TESTS);
}

function assertPassed(run, count) {
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, new RegExp(`^# pass ${count}$`, "m"), run.output);
  assert.match(run.output, /^# fail 0$/m, run.output);
}

function assertFailedOn(run, digest) {
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.output, /^# fail 1$/m, run.output);
  if (digest) assert.ok(run.output.includes(digest), run.output);
}

test("the disposable historical fixture is the pinned thirteen-migration state", () => {
  const register = historicalJson(REGISTER);
  const releases = historicalJson(RELEASES);

  assert.equal(sha256(fixture.historical[REGISTER]), MIGRATION_REGISTER_SHA256);
  assert.equal(sha256(fixture.historical[RELEASES]), RELEASE_REGISTER_SHA256);
  assert.equal(sha256(fixture.historical[BASELINE]), BASELINE_SHA256);
  assert.equal(register.migrations.length, 13);
  assert.equal(releases.releases.length, 13);
  assert.equal(prefixSha256(register.migrations), MIGRATION_PREFIX_SHA256);
  assert.equal(prefixSha256(releases.releases), RELEASE_PREFIX_SHA256);
  assert.deepEqual(
    listFiles(fixture.root)
      .filter((file) => file.startsWith("supabase/"))
      .sort(),
    register.migrations
      .map((migration) => `supabase/migrations/${migration.migration_id}.sql`)
      .sort(),
  );
  assert.equal(fixture.controls.validateRepository().status, "passed");
});

test("live registers keep their pinned historical prefixes and pass", () => {
  const register = liveJson(REGISTER);
  const releases = liveJson(RELEASES);

  assert.ok(register.migrations.length >= 13);
  assert.ok(releases.releases.length >= 13);
  assert.equal(register.migrations[12].migration_id, P1011_MIGRATION_ID);
  assert.equal(prefixSha256(register.migrations), MIGRATION_PREFIX_SHA256);
  assert.equal(prefixSha256(releases.releases), RELEASE_PREFIX_SHA256);
  // A live register without an appended suffix must stay byte-identical.
  if (register.migrations.length <= 13) {
    assert.equal(
      sha256(readFileSync(path.join(ROOT, REGISTER))),
      MIGRATION_REGISTER_SHA256,
    );
  }
  if (releases.releases.length <= 13) {
    assert.equal(
      sha256(readFileSync(path.join(ROOT, RELEASES))),
      RELEASE_REGISTER_SHA256,
    );
  }
  assert.doesNotThrow(() => validateDriftReport(liveJson(BASELINE), register));
  assert.doesNotThrow(() => validateRepository());
});

test("validator import stays inert", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "rosuno-p2-903-import-"));
  try {
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(
          pathToFileURL(path.join(ROOT, "tools/p0/lib/controls.mjs")).href,
        )});`,
      ],
      { cwd: temp, encoding: "utf8" },
    );
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout, "");
    assert.equal(probe.stderr, "");
    assert.deepEqual(readdirSync(temp), []);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("neutral-path gate without an explicit register keeps rejecting SQL", () => {
  const { files, packageJson } = fixtureSurface(null);
  const register = candidateState().register;

  assert.doesNotThrow(() =>
    validateNeutralPaths(files, packageJson, WEB_APPLICATION_STATE),
  );
  for (const file of [
    SQL_PATH,
    "supabase/migrations/20261018000000_P2_903_synthetic_fixture.sql",
    "supabase/migrations/20261018000000_p2_903_synthetic_fixture.SQL",
    "supabase/seed.sql",
    "db/migrations/20261018000000_p2_903_synthetic_fixture.sql",
    "src/product-server.mjs",
  ]) {
    for (const migrationRegister of [
      undefined,
      null,
      {},
      { migrations: "not an array" },
      historicalJson(REGISTER),
    ]) {
      assert.throws(
        () =>
          validateNeutralPaths(
            [...files, file],
            packageJson,
            WEB_APPLICATION_STATE,
            migrationRegister,
          ),
        { message: `product implementation paths are present: ${file}` },
      );
    }
  }

  // The registered candidate path is admitted only in the web-application
  // state; a pre-application repository rejects every future SQL file.
  assert.doesNotThrow(() =>
    validateNeutralPaths(
      [...files, SQL_PATH],
      packageJson,
      WEB_APPLICATION_STATE,
      register,
    ),
  );
  const preApplicationPackage = {
    ...packageJson,
    scripts: ROOT_SCRIPT_PROFILES[PRE_APPLICATION_STATE],
  };
  const preApplicationFiles = files.filter(
    (file) =>
      !file.startsWith("apps/web/") && !file.startsWith("docs/work-items/"),
  );
  assert.doesNotThrow(() =>
    validateNeutralPaths(preApplicationFiles, preApplicationPackage),
  );
  assert.throws(
    () =>
      validateNeutralPaths(
        [...preApplicationFiles, SQL_PATH],
        preApplicationPackage,
        PRE_APPLICATION_STATE,
        register,
      ),
    { message: `product implementation paths are present: ${SQL_PATH}` },
  );
});

test("registered unapplied fourteenth migration passes the complete ordered chain as repository consistency only", async () => {
  const state = candidateState();
  // The synthetic owner records carry no approval: passing the chain below is
  // repository consistency, not owner authorization or a Staging application.
  assert.equal(state.decisions.decisions.at(-1).status, "proposed");
  assert.deepEqual(
    state.decisions.decisions.at(-1).reviewer,
    UNRESOLVED_REVIEWER,
  );
  assert.equal(state.register.migrations[13].reviewed, false);
  assert.equal(state.register.migrations[13].applied_environment, "none");
  await inScenario(writes(state), () => {
    const { controls } = fixture;
    const surface = fixtureSurface(state.register);

    // Gate 1: the neutral-path filter admits the path only with the register.
    assert.throws(
      () =>
        controls.validateApplicationSurface({
          ...surface,
          migrationRegister: null,
        }),
      /product implementation paths are present/,
    );
    assert.equal(
      controls.validateApplicationSurface(surface),
      WEB_APPLICATION_STATE,
    );
    // Gates 2 and 3: register/artifact and drift checks in validateRepository
    // order, then the complete entry point itself.
    assert.doesNotThrow(() =>
      controls.validateMigrationRegister(state.register, {}, surface.files),
    );
    assert.doesNotThrow(() =>
      controls.validateDriftReport(historicalJson(BASELINE), state.register),
    );
    assert.equal(controls.validateRepository().status, "passed");
  });
});

test("appended SQL that is unregistered, malformed or insufficiently evidenced fails the complete chain", async (t) => {
  const pathGate = /product implementation paths are present/;
  const secretLike = `-- ${["pass", "word"].join("")} = ${"q".repeat(16)}\n`;
  const rename = (
    state,
    id,
    artifactPath = `supabase/migrations/${id}.sql`,
  ) => {
    const migration = state.register.migrations[13];
    migration.migration_id = id;
    migration.artifact_path = artifactPath;
    state.workItems.work_items.at(-1).migration_refs = [id];
    delete state.files[SQL_PATH];
    state.files[artifactPath] = SQL;
  };
  const cases = [
    [
      "unregistered orphan SQL",
      (state) => {
        delete state.register;
        state.workItems.work_items.at(-1).migration_refs = [];
      },
      pathGate,
    ],
    [
      "filename-pattern-only SQL beside a registered candidate",
      (state) => {
        state.files["supabase/migrations/20261019000000_p2_903_unlisted.sql"] =
          SQL;
      },
      pathGate,
    ],
    [
      "case-alias SQL beside a registered candidate",
      (state) => {
        state.files[
          "supabase/migrations/20261018000000_P2_903_synthetic_fixture.sql"
        ] = SQL;
      },
      pathGate,
    ],
    [
      "uppercase registered migration",
      (state) => rename(state, "20261018000000_P2_903_synthetic_fixture"),
      pathGate,
    ],
    [
      "traversal artifact path",
      (state) => {
        state.register.migrations[13].artifact_path = `supabase/migrations/../migrations/${MIGRATION_ID}.sql`;
      },
      pathGate,
    ],
    [
      "malformed timestamp",
      (state) => rename(state, "20261340000000_p2_903_synthetic_fixture"),
      pathGate,
    ],
    [
      "malformed slug",
      (state) => rename(state, "20261018000000_p2-903-synthetic-fixture"),
      pathGate,
    ],
    [
      "slug beyond the bounded grammar",
      (state) => rename(state, `20261018000000_p2_${"x".repeat(100)}`),
      pathGate,
    ],
    [
      "non-SQL extension",
      (state) =>
        rename(
          state,
          MIGRATION_ID,
          `supabase/migrations/${MIGRATION_ID}.sql.txt`,
        ),
      pathGate,
    ],
    [
      "nested migration root",
      (state) =>
        rename(
          state,
          MIGRATION_ID,
          `supabase/migrations/p2/${MIGRATION_ID}.sql`,
        ),
      pathGate,
    ],
    [
      "alternate migration root",
      (state) =>
        rename(state, MIGRATION_ID, `db/migrations/${MIGRATION_ID}.sql`),
      pathGate,
    ],
    [
      "registered SQL file missing",
      (state) => {
        delete state.files[SQL_PATH];
      },
      /must be a regular UTF-8 SQL file/,
    ],
    [
      "registered SQL path is a symlink",
      (state) => {
        state.files[SQL_PATH] = {
          symlinkTo: "20260921051204_p1_compliance_foundation.sql",
        };
      },
      /must be a regular UTF-8 SQL file/,
    ],
    [
      "registered SQL is not UTF-8 text",
      (state) => {
        state.files[SQL_PATH] = Buffer.from([0xff, 0xfe, 0x00]);
      },
      /must be a regular UTF-8 SQL file/,
    ],
    [
      "registered SQL is empty",
      (state) => {
        state.files[SQL_PATH] = "\n";
      },
      /SQL is empty/,
    ],
    [
      "registered SQL carries a secret-like value",
      (state) => {
        state.files[SQL_PATH] = secretLike;
      },
      /SQL contains a secret-like value/,
    ],
    [
      "duplicate migration ID",
      (state) => {
        state.register.migrations.push({
          ...structuredClone(state.register.migrations[13]),
          sequence: 15,
        });
      },
      pathGate,
    ],
    [
      "duplicate artifact path",
      (state) => {
        state.register.migrations.push({
          ...structuredClone(state.register.migrations[13]),
          migration_id: "20261019000000_p2_903_second_fixture",
          sequence: 15,
        });
      },
      pathGate,
    ],
    [
      "duplicate version",
      (state) => {
        const id = "20261018000000_p2_903_second_fixture";
        state.register.migrations.push({
          ...structuredClone(state.register.migrations[13]),
          migration_id: id,
          sequence: 15,
          artifact_path: `supabase/migrations/${id}.sql`,
        });
        state.workItems.work_items.at(-1).migration_refs.push(id);
        state.files[`supabase/migrations/${id}.sql`] = SQL;
      },
      /version must ascend/,
    ],
    [
      "out-of-order sequence",
      (state) => {
        state.register.migrations[13].sequence = 15;
      },
      pathGate,
    ],
    [
      "timestamp before the historical prefix",
      (state) => rename(state, "20260920000000_p2_903_synthetic_fixture"),
      /version must ascend after 20260921051204_p1_compliance_foundation/,
    ],
    [
      "edited historical prefix record",
      (state) => {
        state.register.migrations[1].rollback_plan += " Edited.";
      },
      pathGate,
    ],
    [
      "candidate inserted inside the historical prefix",
      (state) => {
        const candidate = state.register.migrations.pop();
        state.register.migrations.splice(12, 0, candidate);
        state.register.migrations.forEach((migration, index) => {
          migration.sequence = index + 1;
        });
      },
      pathGate,
    ],
    [
      "alias of a historical migration name",
      (state) => rename(state, "20261018000000_p1_compliance_foundation"),
      /aliases a historical migration name/,
    ],
    [
      "security-control kind",
      (state) => {
        state.register.migrations[13].migration_kind = "security_control";
      },
      pathGate,
    ],
    [
      "unknown authority reference",
      (state) => {
        state.register.migrations[13].authority_refs = ["UNKNOWN-AUTHORITY"];
      },
      /authority_refs contains unknown reference UNKNOWN-AUTHORITY/,
    ],
    [
      "missing owner work-item reference",
      (state) => {
        state.register.migrations[13].work_item_refs = [];
      },
      /work_item_refs must be an array with at least 1/,
    ],
    [
      "unknown owner work-item reference",
      (state) => {
        state.register.migrations[13].work_item_refs = ["WI-P2-903-UNKNOWN"];
      },
      /work_item_refs contains unknown reference WI-P2-903-UNKNOWN/,
    ],
    [
      "unknown decision reference",
      (state) => {
        state.register.migrations[13].decision_refs = [
          "DEC-20261018-P2-903-UNKNOWN",
        ];
      },
      /decision_refs contains unknown reference DEC-20261018-P2-903-UNKNOWN/,
    ],
    [
      "missing migration dependency",
      (state) => {
        state.register.migrations[13].depends_on = [];
      },
      /depends_on must be an array with at least 1/,
    ],
    [
      "dependency on an unregistered migration",
      (state) => {
        state.register.migrations[13].depends_on = [
          "20261231000000_p2_903_unregistered",
        ];
      },
      /depends_on must name earlier registered migrations/,
    ],
    [
      "candidate claiming a reviewer before review",
      (state) => {
        state.register.migrations[13].reviewed_by = "Rosuno";
      },
      /proposed product migration gate is invalid/,
    ],
    [
      "candidate carrying a release reference",
      (state) => {
        state.register.migrations[13].release_refs = [
          "REL-20260923-P1-011-STAGING-APPLICATION",
        ];
      },
      /unapplied candidate or a reviewed persistent Staging application/,
    ],
    [
      "candidate claiming persistent application",
      (state) => {
        state.register.migrations[13].applied_environment = "staging";
      },
      /unapplied candidate or a reviewed persistent Staging application/,
    ],
    [
      "candidate claiming a development application",
      (state) => {
        state.register.migrations[13].applied_environment = "development";
      },
      /unapplied candidate or a reviewed persistent Staging application/,
    ],
    [
      "reviewed but unapplied migration",
      (state) => {
        Object.assign(state.register.migrations[13], {
          reviewed: true,
          reviewed_by: "Rosuno",
          reviewed_at: "2026-10-18T01:00:00Z",
        });
      },
      /unapplied candidate or a reviewed persistent Staging application/,
    ],
    [
      "candidate without non-production rollback validation",
      (state) => {
        state.register.migrations[13].non_production_validation = false;
      },
      /lacks non-production rollback validation/,
    ],
    [
      "candidate without a clean drift check",
      (state) => {
        state.register.migrations[13].drift_check = "pending";
      },
      /lacks a clean drift check/,
    ],
    [
      "placeholder rollback plan",
      (state) => {
        state.register.migrations[13].rollback_plan = "TBD";
      },
      /actual bounded rollback plan/,
    ],
    [
      "owner work item that does not list the migration",
      (state) => {
        state.workItems.work_items.at(-1).migration_refs = [];
      },
      /migration 14 must be listed by each referenced owner work item/,
    ],
    [
      "decision that does not name the owner work item",
      (state) => {
        state.decisions.decisions.at(-1).work_item_refs = [];
      },
      /decision DEC-20261018-P2-903-SYNTHETIC-APPENDED-MIGRATION must name an owner work item/,
    ],
    [
      "missing decision reference",
      (state) => {
        state.register.migrations[13].decision_refs = [];
      },
      /decision_refs must be an array with at least 1/,
    ],
    [
      "closed P1-011 work item retargeted as the owner",
      (state) => {
        const p1011 = state.register.migrations[12];
        Object.assign(state.register.migrations[13], {
          work_item_refs: [...p1011.work_item_refs],
          decision_refs: [...p1011.decision_refs],
        });
        state.workItems.work_items.pop();
        state.decisions.decisions.pop();
        state.workItems.work_items
          .find((item) => item.work_item_id === p1011.work_item_refs[0])
          .migration_refs.push(MIGRATION_ID);
      },
      /P1-011 closed traceability record mismatch/,
    ],
  ];
  for (const [label, mutate, expected] of cases) {
    await t.test(label, async () => {
      const state = candidateState();
      mutate(state);
      await rejectsChain(state, expected);
    });
  }
});

test("a forged register row can pass only the preliminary path screen", async () => {
  // Valid shape and existing references, but borrowed from the closed P1-011
  // work item and decision instead of an owner that lists the migration.
  const register = historicalJson(REGISTER);
  const p1011 = register.migrations[12];
  register.migrations.push({
    ...candidateMigration([...p1011.authority_refs]),
    work_item_refs: [...p1011.work_item_refs],
    decision_refs: [...p1011.decision_refs],
  });
  await inScenario({ [REGISTER]: json(register), [SQL_PATH]: SQL }, () => {
    const { controls } = fixture;
    const surface = fixtureSurface(register);
    assert.equal(
      controls.validateApplicationSurface(surface),
      WEB_APPLICATION_STATE,
    );
    assert.throws(
      () => controls.validateRepository(),
      /migration 14 must be listed by each referenced owner work item/,
    );
  });
});

test("drift baseline keeps the accepted P1-011 state and binds later baselines to reviewed evidence", async (t) => {
  const accepted = () => historicalJson(BASELINE);

  await t.test(
    "accepted P1-011 baseline stays valid beside an unapplied candidate",
    () =>
      inScenario(writes(candidateState()), () => {
        const register = candidateState().register;
        assert.doesNotThrow(() =>
          fixture.controls.validateDriftReport(accepted(), register),
        );
        const tamperedPrefix = accepted();
        tamperedPrefix.migration_inventory[3].sha256 = "0".repeat(64);
        assert.throws(
          () => fixture.controls.validateDriftReport(tamperedPrefix, register),
          /inventory contradicts/,
        );
        const tamperedDigest = accepted();
        tamperedDigest.baseline_digest = `sha256:${"0".repeat(64)}`;
        assert.throws(
          () => fixture.controls.validateDriftReport(tamperedDigest, register),
          /identity\/digest/,
        );
        const editedPrefix = structuredClone(register);
        editedPrefix.migrations[4].drift_check += " Edited.";
        assert.throws(
          () => fixture.controls.validateDriftReport(accepted(), editedPrefix),
          /unchanged accepted thirteen-migration prefix/,
        );
      }),
  );

  await t.test(
    "an applied fourteenth migration cannot rest on the thirteen-migration baseline",
    async () => {
      const state = appliedState();
      delete state.baseline;
      await rejectsChain(
        state,
        /schema drift baseline cannot prove applied or reviewed migration 14/,
      );
    },
  );

  await t.test(
    "a later adopted baseline passes only when tied to the reviewed application",
    async (st) => {
      const state = appliedState();
      await inScenario(writes(state), () => {
        assert.equal(fixture.controls.validateRepository().status, "passed");
      });

      const mutations = [
        [
          "register entry still unapplied",
          (x) => {
            x.register = candidateState().register;
            x.releases.releases.at(-1).migration_refs = [];
          },
          /not tied to a reviewed Staging application/,
        ],
        [
          "register shorter than the baseline inventory",
          (x) => {
            delete x.register;
            x.workItems.work_items.at(-1).migration_refs = [];
            x.releases.releases.at(-1).migration_refs = [];
            delete x.files[SQL_PATH];
          },
          /exceeds the reviewed register/,
        ],
        [
          "relabeled P1-011 catalog fingerprint",
          (x) => {
            x.baseline.catalog_fingerprint = accepted().catalog_fingerprint;
            withDigest(x.baseline);
          },
          /appended catalog fingerprint is invalid/,
        ],
        [
          "appended inventory digest mismatch",
          (x) => {
            x.baseline.migration_inventory[13].sha256 = "0".repeat(64);
            withDigest(x.baseline);
          },
          /migration digest is invalid/,
        ],
        [
          "historical inventory prefix tampered",
          (x) => {
            x.baseline.migration_inventory[2].sha256 = "0".repeat(64);
            withDigest(x.baseline);
          },
          /inventory contradicts/,
        ],
        [
          "no appended accepted evidence",
          (x) => {
            x.baseline.accepted_evidence.pop();
            x.baseline.evidence.pop();
            withDigest(x.baseline);
          },
          /requires appended accepted evidence/,
        ],
        [
          "appended evidence digest mismatch",
          (x) => {
            x.baseline.accepted_evidence.at(-1).sha256 = "0".repeat(64);
            withDigest(x.baseline);
          },
          /evidence digest is invalid/,
        ],
        [
          "checked before the accepted P1-011 baseline",
          (x) => {
            x.baseline.checked_at = "2026-09-01T00:00:00Z";
            withDigest(x.baseline);
          },
          /Staging baseline identity is invalid/,
        ],
        [
          "baseline digest not recomputed",
          (x) => {
            x.baseline.baseline_digest = accepted().baseline_digest;
          },
          /identity\/digest/,
        ],
      ];
      for (const [label, mutate, expected] of mutations) {
        await st.test(label, async () => {
          const altered = appliedState();
          mutate(altered);
          await rejectsChain(altered, expected);
        });
      }
    },
  );
});

test("historical register integrity holds in no-suffix, suffix and mixed states", async (t) => {
  // Same parsed content, different bytes.
  const reformatted = (file) =>
    `${JSON.stringify(historicalJson(file), null, 4)}\n`;
  const candidate = () => writes(candidateState());
  const releaseSuffix = () => {
    const state = ownerState({ migration: false });
    state.releases = historicalJson(RELEASES);
    state.releases.releases.push(syntheticRelease([]));
    state.workItems.work_items.at(-1).release_refs = [RELEASE_ID];
    return state;
  };
  // Prefix mutations keep a suffix present so the prefix digests must execute.
  const migrationPrefix = (mutate) => {
    const state = candidateState();
    state.register.migrations.push({
      ...structuredClone(state.register.migrations[13]),
      migration_id: "20261019000000_p2_903_second_fixture",
    });
    mutate(state.register.migrations, "rollback_plan");
    return writes(state);
  };
  const releasePrefix = (mutate) => {
    const state = releaseSuffix();
    state.releases.releases.push({
      ...structuredClone(state.releases.releases[13]),
      release_id: "REL-20261019-P2-903-SECOND-FIXTURE",
    });
    mutate(state.releases.releases, "rollback_reference");
    return writes(state);
  };
  const recordMutations = [
    [
      "modified",
      (records, field) => {
        records[3][field] += " Edited.";
      },
    ],
    ["deleted", (records) => records.splice(4, 1)],
    ["reordered", (records) => records.splice(1, 2, records[2], records[1])],
    [
      "inserted",
      (records) => records.splice(6, 0, structuredClone(records.at(-1))),
    ],
  ];

  await t.test("no suffix: canonical registers pass both suites", () =>
    inScenario({}, () => {
      assertPassed(transitionContract(), 1);
      assertPassed(historicalChecks(), 5);
    }),
  );

  for (const [label, file, digest] of [
    ["migration register byte drift", REGISTER, MIGRATION_REGISTER_SHA256],
    ["release register byte drift", RELEASES, RELEASE_REGISTER_SHA256],
    ["accepted baseline byte drift", BASELINE, BASELINE_SHA256],
  ]) {
    await t.test(`no suffix: ${label} fails its whole-file hash`, () =>
      inScenario({ [file]: reformatted(file) }, () => {
        assertFailedOn(transitionContract(), digest);
      }),
    );
  }

  await t.test("migration suffix only: both suites pass", () =>
    inScenario(candidate(), () => {
      assertPassed(transitionContract(), 1);
      assertPassed(historicalChecks(), 5);
    }),
  );

  await t.test(
    "migration suffix only: unsuffixed release register keeps its whole-file hash",
    () =>
      inScenario({ ...candidate(), [RELEASES]: reformatted(RELEASES) }, () => {
        assertFailedOn(transitionContract(), RELEASE_REGISTER_SHA256);
      }),
  );

  await t.test("migration suffix: accepted baseline byte drift fails", () =>
    inScenario({ ...candidate(), [BASELINE]: reformatted(BASELINE) }, () => {
      assertFailedOn(transitionContract(), BASELINE_SHA256);
    }),
  );

  await t.test("release suffix only: transition contract passes", () =>
    inScenario(writes(releaseSuffix()), () => {
      assertPassed(transitionContract(), 1);
    }),
  );

  await t.test(
    "release suffix only: unsuffixed migration register keeps its whole-file hash",
    () =>
      inScenario(
        { ...writes(releaseSuffix()), [REGISTER]: reformatted(REGISTER) },
        () => {
          assertFailedOn(transitionContract(), MIGRATION_REGISTER_SHA256);
        },
      ),
  );

  await t.test("both suffixes: transition contract passes", () =>
    inScenario(writes(mixedState()), () => {
      assertPassed(transitionContract(), 1);
    }),
  );

  for (const [label, mutate] of recordMutations) {
    await t.test(`suffix: ${label} historical migration record fails`, () =>
      inScenario(migrationPrefix(mutate), () => {
        const run = transitionContract();
        assertFailedOn(run, MIGRATION_PREFIX_SHA256);
        assert.ok(!run.output.includes(RELEASE_PREFIX_SHA256), run.output);
      }),
    );
    await t.test(`suffix: ${label} historical release record fails`, () =>
      inScenario(releasePrefix(mutate), () => {
        const run = transitionContract();
        assertFailedOn(run, RELEASE_PREFIX_SHA256);
        assert.ok(!run.output.includes(MIGRATION_PREFIX_SHA256), run.output);
      }),
    );
  }

  await t.test(
    "suffix: edited historical prefix fails the five historical checks",
    () =>
      inScenario(
        migrationPrefix((records) =>
          records.splice(1, 2, records[2], records[1]),
        ),
        () => {
          const run = historicalChecks();
          assert.notEqual(run.status, 0, run.output);
          assert.match(run.output, /^# fail 5$/m, run.output);
        },
      ),
  );

  await t.test("fabricated P1-012 release fails", () => {
    const state = releaseSuffix();
    state.releases.releases.at(-1).work_item_refs = ["WI-P1-012-PHYSICAL-1L"];
    return inScenario(writes(state), () => {
      assertFailedOn(transitionContract());
    });
  });

  await t.test("suffix: changed legacy migration bytes fail", () =>
    inScenario(
      {
        ...candidate(),
        [`supabase/migrations/${P1011_MIGRATION_ID}.sql`]:
          fixture.historical[
            `supabase/migrations/${P1011_MIGRATION_ID}.sql`
          ].toString("utf8") + "\n-- drift\n",
      },
      () => {
        assertFailedOn(transitionContract());
      },
    ),
  );

  await t.test("suffix: unapproved fourteenth migration fails", () => {
    const state = candidateState();
    state.workItems.work_items.at(-1).migration_refs = [];
    return inScenario(writes(state), () => {
      assertFailedOn(transitionContract());
    });
  });
});

// The original suite (the test files at canonical base) must pass unchanged in
// a disposable repository carrying a registered, unapplied synthetic
// fourteenth migration, alone and with a release suffix; no focused name
// pattern is used.
test("the entire original test suite passes beside a registered unapplied fourteenth migration", async (t) => {
  const original = baseGit(
    ["ls-tree", "--name-only", BASE_COMMIT, "tools/p0/tests/"],
    "utf8",
  )
    .split("\n")
    .filter(Boolean);
  assert.ok(original.length > 0);
  assert.ok(
    !original.includes("tools/p0/tests/forward-migration-validation.test.mjs"),
  );
  for (const [label, state] of [
    ["migration suffix", candidateState],
    ["migration and release suffixes", mixedState],
  ]) {
    await t.test(label, () =>
      inScenario(writes(state()), () => {
        const run = runTests(original);
        assert.equal(run.status, 0, failureSummary(run));
        assert.match(run.output, /^# fail 0$/m, failureSummary(run));
      }),
    );
  }
});
