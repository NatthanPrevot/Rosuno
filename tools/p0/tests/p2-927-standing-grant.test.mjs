// P2-927 S1: the standing-grant route of rosuno-guard v5 and its trusted
// workflow (owner-adopted PROCESS Program Packet P2-927; the Governance
// Modernization package v1.1 is registered by digest only).
//
// Scenario labels:
// - CHANGED: one owner grant authorizes ordinary engineering (UI, API, additive
//   and restructured schema, dependency updates, feature removal, independent
//   branches, integration merges, a related post-merge correction) without a
//   Packet, file inventory or record per change.
// - REFUSED: an unauthorized case fails closed on the grant route.
// - PRESERVED: a protection that holds on both routes, or the Packet route
//   itself, which must stay byte-identical to guard v4 (owner main 5a9423e).
//
// Fixtures are synthetic (FixtureOwner/FixtureBuilder identities, a synthetic
// package digest). Disposable repositories are built with Git plumbing only,
// with no user/global Git configuration and only the file transport. Nothing
// contacts a remote, reads a real secret or alters a real repository.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import {
  PRE_APPLICATION_STATE,
  ROOT_SCRIPT_PROFILES,
  WEB_APPLICATION_STATE,
  scanSecretLikeText,
  validateNeutralPaths,
} from "../lib/controls.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const GUARD = path.join(ROOT, ".github/scripts/rosuno-guard.sh");
const TRUST = path.join(ROOT, ".github/scripts/rosuno-guard-trust.sh");
const WORKFLOW = path.join(ROOT, ".github/workflows/rosuno-guard.yml");

// Guard v4 as merged on owner main 5a9423e2f3c558b925e9d3d8c29ffed9418e0239
// (P2-920) and the unchanged trust binding.
const V4_GUARD_BLOB = "b1bf60fdc01d4210b954a6a2ff910ecf00e4f9a0";
const TRUST_BLOB = "d6a16c8db64a95f47916323f90ef06f294190457";
// Owner main 5a9423e registry blobs: 18 authority references, 58 decisions.
const MAIN_AUTHORITY_BLOB = "f37c90db294a69caca4017c07a79af9f3d93dd06";
const MAIN_DECISION_LOG_BLOB = "1c6eec5dc770684eb65e26cf1124f8b3cdee8796";
const ADOPTED_DIGEST =
  "6cd443caf7ad3a343a80530dff51b9396cdff40c440cba4065319151fed8333b";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const gitBlobId = (bytes) =>
  createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");

const SANDBOX = mkdtempSync(path.join(tmpdir(), "rosuno-p2-927-"));
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

// Reads a pinned blob from this repository's full history, fails closed when it
// is missing, verifies its identity and returns its bytes.
function pinnedBlob(oid, name) {
  const result = spawnSync("git", ["cat-file", "blob", oid], {
    cwd: ROOT,
    env: {
      ...process.env,
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `pinned blob ${oid} (${name}) is missing; a full-history checkout is required`,
    );
  }
  assert.equal(gitBlobId(result.stdout), oid, `${name} blob identity`);
  return result.stdout;
}

const V4_GUARD = path.join(SANDBOX, "rosuno-guard-v4.sh");
writeFileSync(V4_GUARD, pinnedBlob(V4_GUARD_BLOB, "rosuno-guard.sh v4"));

function fixtureEnv() {
  return {
    PATH: process.env.PATH ?? "",
    HOME: SANDBOX,
    TMPDIR: SANDBOX,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
  };
}

let repositories = 0;
let clock = 1_795_996_800; // 2026-11-29T00:00:00Z

function createRepo() {
  repositories += 1;
  const dir = path.join(SANDBOX, `repo-${repositories}`);
  const index = path.join(SANDBOX, `repo-${repositories}.index`);
  mkdirSync(dir);
  const env = fixtureEnv();
  const tracked = new Map();
  const git = (args, input) =>
    execFileSync("git", args, {
      cwd: dir,
      env,
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    }).trimEnd();
  git(["init", "-q", "-b", "main"]);
  return {
    dir,
    env,
    git,
    // Commits the first parent's files plus `changes` (path -> text, null to
    // delete, { mode, content } or { mode, oid }) through Git plumbing only.
    child(parents, changes, message = "fixture") {
      const files = new Map(parents.length ? tracked.get(parents[0]) : []);
      for (const [file, change] of Object.entries(changes)) {
        if (change === null) {
          files.delete(file);
          continue;
        }
        const {
          mode = "100644",
          content,
          oid,
        } = typeof change === "string" ? { content: change } : change;
        files.set(file, {
          mode,
          oid: oid ?? git(["hash-object", "-w", "--stdin"], content),
        });
      }
      rmSync(index, { force: true });
      execFileSync("git", ["update-index", "--index-info"], {
        cwd: dir,
        env: { ...env, GIT_INDEX_FILE: index },
        input: [...files]
          .map(([file, { mode, oid }]) => {
            const type = mode === "160000" ? "commit" : "blob";
            return `${mode} ${type} ${oid}\t${file}\n`;
          })
          .join(""),
      });
      const tree = execFileSync("git", ["write-tree"], {
        cwd: dir,
        env: { ...env, GIT_INDEX_FILE: index },
        encoding: "utf8",
      }).trim();
      clock += 60;
      const ident = `P2-927 Fixture <fixture@example.invalid> ${clock} +0000`;
      const commit = git(
        ["hash-object", "-t", "commit", "-w", "--stdin"],
        [
          `tree ${tree}`,
          ...parents.map((parent) => `parent ${parent}`),
          `author ${ident}`,
          `committer ${ident}`,
          "",
          message,
          "",
        ].join("\n"),
      );
      tracked.set(commit, files);
      return commit;
    },
    ref: (name, oid) => git(["update-ref", name, oid]),
  };
}

function runScript(repo, script, args, env = {}) {
  const result = spawnSync("bash", [script, ...args], {
    cwd: repo.dir,
    env: { ...repo.env, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}${result.stderr}`,
  };
}

function assertRejected(result, ...expected) {
  const context = `exit ${result.status}\n${result.output}`;
  assert.equal(result.status, 1, context);
  assert.doesNotMatch(result.output, /ROSUNO-GUARD PASS/, context);
  assert.match(result.output, /::error::/, context);
  for (const item of expected) {
    if (item instanceof RegExp) assert.match(result.output, item, context);
    else
      assert.ok(result.output.includes(item), `missing: ${item}\n${context}`);
  }
}

// ---------------------------------------------------------------------------
// Grant-route fixture
// ---------------------------------------------------------------------------

const OWNER = "FixtureOwner";
const BUILDER = "FixtureBuilder";
const REPO = "FixtureOwner/Rosuno";
const FORK = "FixtureBuilder/Rosuno";
const NOW = "2026-12-01T00:00:00Z";
const DIGEST = sha256("synthetic P2-927 fixture package");
const GRANT_ID = "UX-001";
const BRANCH = `grant/${GRANT_ID}/client-dashboard`;
const GRANT_DIR = ".github/rosuno-grants";
const ACTIVATION_PATH = `${GRANT_DIR}/activation.json`;
const GRANT_PATH = `${GRANT_DIR}/${GRANT_ID}.json`;
const REG = "governance/migrations/reviewed-migrations.json";
const HISTORICAL_MIGRATION =
  "supabase/migrations/20260101000000_historical_fixture.sql";
const UNAPPLIED_MIGRATION =
  "supabase/migrations/20260102000000_unapplied_fixture.sql";
const NEW_MIGRATION = "supabase/migrations/20261201000000_add_items.sql";
const NEXT_MIGRATION =
  "supabase/migrations/20261201000100_restructure_items.sql";

const GRANT_ENV = {
  EXPECTED_REPO: REPO,
  EXPECTED_BASE: "main",
  BUILDER_FORK: FORK,
  OWNER_LOGIN: OWNER,
  ROSUNO_PR_AUTHOR: OWNER,
  ROSUNO_HEAD_REPO: FORK,
  ROSUNO_NOW: NOW,
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const row = (artifactPath, applied = false) => ({
  migration_id: artifactPath.slice("supabase/migrations/".length, -4),
  artifact_path: artifactPath,
  reviewed: applied,
  applied_environment: applied ? "staging" : "none",
  release_refs: applied ? ["REL-FIXTURE-1"] : [],
});
const BASE_ROWS = [row(HISTORICAL_MIGRATION, true), row(UNAPPLIED_MIGRATION)];
const register = (rows) => json({ migrations: rows });

const WEB_MANIFEST = {
  name: "@rosuno/web",
  private: true,
  scripts: { build: "next build", "test:application-shell": "node --test" },
  dependencies: { next: "16.4.6", react: "^19.3.0" },
  devDependencies: { typescript: "~5.9.3" },
};
const ROOT_MANIFEST = {
  name: "rosuno",
  private: true,
  scripts: { "p0:validate": "node tools/p0/validate.mjs" },
  devDependencies: { prettier: "^3.9.6" },
};

const AUTHORITY = (digest = DIGEST) =>
  json({
    references: [
      {
        authority_id: "P0-001-LOCKED",
        integrity: "not_available",
        status: "external_reference_pending",
      },
      {
        authority_id: "GOVERNANCE-MODERNIZATION-V1.1",
        integrity: `sha256:${digest}`,
        status: "conditionally_adopted",
      },
    ],
  });

const BASE_FILES = {
  "README.md": "Disposable P2-927 guard fixture.\n",
  "CLAUDE.md": "# fixture instructions\n",
  ".claude/settings.json": '{ "permissions": { "deny": [] } }\n',
  ".github/CODEOWNERS": "* @FixtureOwner\n",
  ".github/scripts/rosuno-guard.sh": "# guard stand-in\n",
  ".github/workflows/p0-controls.yml": "name: fixture\n",
  ".gitignore": "node_modules\n",
  "apps/web/src/page.ts": "export const page = 1;\n",
  "apps/web/src/legacy.ts": "export const legacy = 1;\n",
  "apps/web/app/api/health/route.ts": "export const GET = () => 1;\n",
  "apps/web/tests/page.test.mjs": "// ordinary test\n",
  "apps/web/package.json": json(WEB_MANIFEST),
  "package.json": json(ROOT_MANIFEST),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "governance/authority-references.json": AUTHORITY(),
  "governance/control-fields.json": "{}\n",
  "governance/decision-log.json": '{ "decisions": [] }\n',
  "governance/work-items/index.json": '{ "work_items": [] }\n',
  [REG]: register(BASE_ROWS),
  "governance/evidence/historical.json": '{ "evidence": 1 }\n',
  "governance/releases/traceability.json": '{ "releases": [] }\n',
  "governance/schema-drift/baseline.json": "{}\n",
  "governance/readiness/outstanding-items.md": "# Outstanding\n",
  [HISTORICAL_MIGRATION]: "select 1;\n",
  [UNAPPLIED_MIGRATION]: "select 2;\n",
  "supabase/config.toml": "[db]\n",
  "tools/p0/validate.mjs": "// validator stand-in\n",
  "docs/work-items/P9-001/PACKET.md": "WORK_ITEM: P9-001\n",
  "docs/process/p2-905-enablement-contract.md": "# non-operative\n",
};

// Builds a record from defaults; an override of `undefined` removes the key.
function record(defaults, overrides) {
  const value = { ...defaults };
  for (const [key, entry] of Object.entries(overrides)) {
    if (entry === undefined) delete value[key];
    else value[key] = entry;
  }
  return json(value);
}

const activationText = (controlCommit, overrides = {}) =>
  record(
    {
      schema: "rosuno-activation/v1",
      repository: REPO,
      owner_login: OWNER,
      adopted_package_sha256: DIGEST,
      control_commit: controlCommit,
      decision_ref: "Fixture owner activation instruction",
      capabilities: ["E"],
      status: "active",
      activated_at: "2026-11-30T00:00:00Z",
    },
    overrides,
  );

const grantText = (id, overrides = {}) =>
  record(
    {
      schema: "rosuno-grant/v1",
      grant_id: id,
      profile: "DEV",
      status: "active",
      repository: REPO,
      base: "main",
      source_repository: FORK,
      owner_login: OWNER,
      pr_authors: [OWNER],
      purpose: "Fixture: improve the client and attorney experience",
      decision_ref: "Fixture owner grant instruction",
      effects: ["code", "schema", "dependencies"],
      exclusions: [],
      issued_at: "2026-11-30T00:00:00Z",
      expires_at: "2027-03-01T00:00:00Z",
    },
    overrides,
  );

function fixture({ baseFiles = BASE_FILES } = {}) {
  const repo = createRepo();
  const base = repo.child([], baseFiles, "owner main");
  const later = repo.child([base], { "README.md": "later main\n" }, "main 2");
  let owners = 0;
  const f = {
    repo,
    base,
    later,
    merge:
      (other = later) =>
      (tip) =>
        repo.child([tip, other], { "README.md": "later main\n" }, "merge main"),
    // The owner grant-record branch: an orphan commit holding the activation
    // and grant records (null omits one); `raw` adds exact entries.
    owner({ activation = {}, grants = { [GRANT_ID]: {} }, raw = {} } = {}) {
      const files = {};
      if (activation !== null)
        files[ACTIVATION_PATH] = activationText(base, activation);
      for (const [id, overrides] of Object.entries(grants)) {
        files[`${GRANT_DIR}/${id}.json`] = grantText(id, overrides);
      }
      for (const [file, entry] of Object.entries(raw)) {
        if (entry === null) delete files[file];
        else files[file] = entry;
      }
      owners += 1;
      const name = `refs/fixture/grants-${owners}`;
      repo.ref(name, repo.child([], files, "owner grant records"));
      return name;
    },
    tip(steps = [], from = base) {
      let tip = from;
      for (const step of steps) {
        tip =
          typeof step === "function"
            ? step(tip)
            : repo.child([tip], step, "change");
      }
      return tip;
    },
    run({
      steps = [],
      from = base,
      head,
      branch = BRANCH,
      guardBase = base,
      owner,
      env = {},
      script = GUARD,
    } = {}) {
      const tip = head ?? f.tip(steps, from);
      const ownerRef = owner ?? f.owner();
      const result = runScript(
        repo,
        script,
        [guardBase, tip, branch, ownerRef],
        {
          ...GRANT_ENV,
          ...env,
        },
      );
      return { ...result, head: tip, guardBase, ownerRef };
    },
  };
  return f;
}

function assertGrantPass(f, result) {
  assert.equal(result.status, 0, result.output);
  const owner = f.repo.git(["rev-parse", result.ownerRef]);
  const blobSha = (file) =>
    sha256(f.repo.git(["cat-file", "blob", `${owner}:${file}`]) + "\n");
  const passes = result.stdout
    .split("\n")
    .filter((line) => line.includes("ROSUNO-GUARD PASS"));
  assert.deepEqual(passes, [
    `ROSUNO-GUARD PASS route=grant grant=${GRANT_ID} profile=DEV grant_sha256=${blobSha(GRANT_PATH)} activation_sha256=${blobSha(ACTIVATION_PATH)} base=${result.guardBase} head=${result.head} owner_ref=${owner}`,
  ]);
  assert.doesNotMatch(result.output, /::error::/);
}

const UI = {
  "apps/web/src/components/card.tsx": "export const Card = () => null;\n",
  "apps/web/src/styles/card.css": ".card { display: grid; }\n",
  "apps/web/src/page.ts": "export const page = 2;\n",
  "apps/web/tests/card.test.mjs": "// card test\n",
};
const API = {
  "apps/web/app/api/items/route.ts": "export const GET = () => [];\n",
  "apps/web/src/application/items.ts": "export const items = [];\n",
};
const REMOVAL = {
  "apps/web/src/legacy.ts": null,
  "apps/web/app/api/health/route.ts": null,
};
const SCHEMA = {
  [NEW_MIGRATION]: "create table items (id bigint primary key);\n",
  [REG]: register([...BASE_ROWS, row(NEW_MIGRATION)]),
  "governance/work-items/index.json":
    '{ "work_items": [{ "work_item_id": "WI-P2-UX-001" }] }\n',
  "governance/decision-log.json":
    '{ "decisions": [{ "decision_id": "DEC-UX-001" }] }\n',
};
const RESTRUCTURE = {
  [NEXT_MIGRATION]: "alter table items rename column id to item_id;\n",
  [REG]: register([...BASE_ROWS, row(NEW_MIGRATION), row(NEXT_MIGRATION)]),
};
const DEPENDENCY = {
  "apps/web/package.json": json({
    ...WEB_MANIFEST,
    dependencies: { next: "16.4.7", react: "^19.3.1", zod: "^4.1.0" },
    devDependencies: { typescript: "~5.9.4" },
  }),
  "package.json": json({
    ...ROOT_MANIFEST,
    devDependencies: { prettier: "^3.9.7" },
  }),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n# updated\n",
};
const RECORDS = {
  "governance/readiness/outstanding-items.md": "# Outstanding\n- item\n",
  "governance/evidence/ux-001-proof.json": '{ "evidence": 2 }\n',
};

describe("P2-927 grant route: ordinary engineering under one owner grant", () => {
  test("CHANGED: UI, API, feature removal, records and tests pass without a Packet", () => {
    const f = fixture();
    assertGrantPass(f, f.run({ steps: [UI] }));
    assertGrantPass(f, f.run({ steps: [API] }));
    assertGrantPass(f, f.run({ steps: [REMOVAL] }));
    assertGrantPass(f, f.run({ steps: [RECORDS] }));
    assertGrantPass(f, f.run({ steps: [] }));
  });

  test("CHANGED: additive and restructured non-sensitive schema needs only effect schema", () => {
    const f = fixture();
    assertGrantPass(f, f.run({ steps: [SCHEMA] }));
    assertGrantPass(f, f.run({ steps: [SCHEMA, RESTRUCTURE] }));
  });

  test("CHANGED: a routine dependency change (manifests' dependency fields and lockfile) passes", () => {
    const f = fixture();
    assertGrantPass(f, f.run({ steps: [DEPENDENCY] }));
  });

  test("CHANGED: one PR may combine every ordinary effect", () => {
    const f = fixture();
    assertGrantPass(
      f,
      f.run({ steps: [UI, API, SCHEMA, DEPENDENCY, REMOVAL, RECORDS] }),
    );
  });

  test("CHANGED: independent branches share one grant; integration merges of main pass", () => {
    const f = fixture();
    const owner = f.owner();
    const a = f.tip([UI]);
    const b = f.tip([API]);
    for (const [head, branch] of [
      [a, `grant/${GRANT_ID}/client-dashboard`],
      [b, `grant/${GRANT_ID}/attorney-api`],
    ]) {
      assertGrantPass(f, f.run({ head, branch, owner }));
    }
    assertGrantPass(
      f,
      f.run({
        head: f.tip([f.merge()], a),
        guardBase: f.later,
        owner,
      }),
    );
  });

  test("CHANGED: a related post-merge correction runs under the same grant", () => {
    const f = fixture();
    const owner = f.owner();
    const branch = f.tip([UI], f.later);
    const merged = f.repo.child([f.later, branch], UI, "owner merge of PR");
    assertGrantPass(
      f,
      f.run({
        steps: [
          {
            "apps/web/src/components/card.tsx":
              "export const Card = () => 1;\n",
          },
        ],
        from: merged,
        guardBase: merged,
        branch: `grant/${GRANT_ID}/card-fix`,
        owner,
      }),
    );
  });

  test("CHANGED: delegated PR authorship needs capability P and a grant PR author", () => {
    const f = fixture();
    const delegated = f.owner({
      activation: { capabilities: ["E", "P"] },
      grants: { [GRANT_ID]: { pr_authors: [OWNER, BUILDER] } },
    });
    assertGrantPass(
      f,
      f.run({
        steps: [UI],
        owner: delegated,
        env: { ROSUNO_PR_AUTHOR: BUILDER },
      }),
    );
  });

  test("CHANGED: guard v4 refused every grant/ branch; v5 reads only the owner records", () => {
    const f = fixture();
    assertRejected(
      f.run({ steps: [UI], script: V4_GUARD }),
      `branch '${BRANCH}' is not wi/<ID>[-slug]`,
    );
  });
});

describe("P2-927 grant route: activation (owner-controlled, default inactive)", () => {
  const cases = [
    [
      "missing activation record",
      { activation: null },
      `activation: expected exactly one owner record ${ACTIVATION_PATH} on the owner grant branch, found 0`,
    ],
    [
      "revoked",
      { activation: { status: "revoked" } },
      "the owner revoked the activation",
    ],
    [
      "unknown status",
      { activation: { status: "paused" } },
      "status must be active or revoked",
    ],
    [
      "capability E absent",
      { activation: { capabilities: ["P"] } },
      "capability E (ordinary engineering) is not active",
    ],
    [
      "unsupported capability",
      { activation: { capabilities: ["E", "M"] } },
      "capabilities must be a non-empty set of E and P",
    ],
    [
      "empty capabilities",
      { activation: { capabilities: [] } },
      "capabilities must be a non-empty set of E and P",
    ],
    [
      "wrong package digest",
      { activation: { adopted_package_sha256: sha256("other package") } },
      "adopted_package_sha256 does not equal the GOVERNANCE-MODERNIZATION-V1.1 digest registered on main",
    ],
    [
      "not yet effective",
      { activation: { activated_at: "2026-12-02T00:00:00Z" } },
      "not yet effective (activated_at 2026-12-02T00:00:00Z)",
    ],
    [
      "invalid timestamp",
      { activation: { activated_at: "2026-11-30T00:00:00+00:00" } },
      "activated_at must be YYYY-MM-DDTHH:MM:SSZ",
    ],
    [
      "wrong repository",
      { activation: { repository: "Someone/Rosuno" } },
      'is for repository "Someone/Rosuno"',
    ],
    [
      "wrong owner",
      { activation: { owner_login: BUILDER } },
      `owner_login "${BUILDER}" is not the owner ${OWNER}`,
    ],
    [
      "unknown field",
      { activation: { scope: "everything" } },
      "unknown: scope",
    ],
    [
      "missing field",
      { activation: { decision_ref: undefined } },
      "missing: decision_ref",
    ],
    [
      "unsupported schema",
      { activation: { schema: "rosuno-activation/v2" } },
      'unsupported schema "rosuno-activation/v2"',
    ],
  ];
  for (const [name, owner, message] of cases) {
    test(`REFUSED: ${name}`, () => {
      const f = fixture();
      assertRejected(f.run({ steps: [UI], owner: f.owner(owner) }), message);
    });
  }

  test("REFUSED: a control commit that is not on main, or does not exist", () => {
    const f = fixture();
    const side = f.repo.child([f.base], { "README.md": "side\n" }, "side");
    for (const commit of [side, "0".repeat(40)]) {
      assertRejected(
        f.run({
          steps: [UI],
          owner: f.owner({ activation: { control_commit: commit } }),
        }),
        `activation: control commit ${commit} is not on main`,
      );
    }
  });

  test("REFUSED: main without the registered package digest cannot activate the route", () => {
    const missing = fixture({
      baseFiles: {
        ...BASE_FILES,
        "governance/authority-references.json": '{ "references": [] }\n',
      },
    });
    assertRejected(
      missing.run({ steps: [UI] }),
      "main registers no single GOVERNANCE-MODERNIZATION-V1.1 digest",
    );
    const doubled = fixture({
      baseFiles: {
        ...BASE_FILES,
        "governance/authority-references.json": json({
          references: [
            {
              authority_id: "GOVERNANCE-MODERNIZATION-V1.1",
              integrity: `sha256:${DIGEST}`,
            },
            {
              authority_id: "GOVERNANCE-MODERNIZATION-V1.1",
              integrity: `sha256:${DIGEST}`,
            },
          ],
        }),
      },
    });
    assertRejected(doubled.run({ steps: [UI] }), "main registers no single");
  });

  test("REFUSED: malformed, duplicated-key, multi-object, symlinked or case-aliased activation records", () => {
    const f = fixture();
    const valid = activationText(f.base);
    const forged = valid.replace(
      '"status": "active"',
      '"status": "revoked",\n  "status": "active"',
    );
    assert.notEqual(forged, valid);
    const link = f.repo.git(["hash-object", "-w", "--stdin"], "../x.json");
    for (const [raw, message] of [
      [{ [ACTIVATION_PATH]: "{ not json" }, "is not exactly one JSON object"],
      [
        { [ACTIVATION_PATH]: `${valid}${valid}` },
        "is not exactly one JSON object",
      ],
      [{ [ACTIVATION_PATH]: "[]\n" }, "is not exactly one JSON object"],
      [
        { [ACTIVATION_PATH]: forged },
        'contains duplicate JSON keys (["status"])',
      ],
      [
        { [ACTIVATION_PATH]: { mode: "120000", oid: link } },
        `owner record ${ACTIVATION_PATH} is missing or not a regular file`,
      ],
      [{ [`${GRANT_DIR}/Activation.json`]: valid }, "found 2"],
      [
        { [ACTIVATION_PATH]: `${" ".repeat(65537)}{}` },
        "is larger than 64 KiB",
      ],
    ]) {
      assertRejected(f.run({ steps: [UI], owner: f.owner({ raw }) }), message);
    }
  });

  test("REFUSED: a missing owner grant-record branch", () => {
    const f = fixture();
    assertRejected(
      f.run({ steps: [UI], owner: "refs/fixture/absent" }),
      `owner approval branch for ${BRANCH} not found`,
    );
  });
});

describe("P2-927 grant route: grant validity, target and actor", () => {
  const cases = [
    [
      "missing grant",
      { grants: {} },
      `grant ${GRANT_ID}: expected exactly one owner record ${GRANT_PATH} on the owner grant branch, found 0`,
    ],
    ["grant for another program only", { grants: { "UX-002": {} } }, "found 0"],
    [
      "revoked",
      { grants: { [GRANT_ID]: { status: "revoked" } } },
      "the owner revoked this grant",
    ],
    [
      "expired",
      { grants: { [GRANT_ID]: { expires_at: "2026-12-01T00:00:00Z" } } },
      "expired at 2026-12-01T00:00:00Z",
    ],
    [
      "not yet effective",
      { grants: { [GRANT_ID]: { issued_at: "2026-12-01T00:00:01Z" } } },
      "not yet effective (issued_at 2026-12-01T00:00:01Z)",
    ],
    [
      "expiry before issue",
      {
        grants: {
          [GRANT_ID]: {
            issued_at: "2026-11-30T00:00:00Z",
            expires_at: "2026-11-29T00:00:00Z",
          },
        },
      },
      "expires_at must follow issued_at",
    ],
    [
      "wrong target repository",
      { grants: { [GRANT_ID]: { repository: "FixtureOwner/Other" } } },
      'is for repository "FixtureOwner/Other"',
    ],
    [
      "wrong base",
      { grants: { [GRANT_ID]: { base: "release" } } },
      'is for base "release"',
    ],
    [
      "wrong source repository",
      { grants: { [GRANT_ID]: { source_repository: "Other/Rosuno" } } },
      'source_repository "Other/Rosuno" is not the Builder fork',
    ],
    [
      "wrong owner",
      { grants: { [GRANT_ID]: { owner_login: BUILDER } } },
      `owner_login "${BUILDER}" is not the owner`,
    ],
    [
      "CONTROL profile",
      { grants: { [GRANT_ID]: { profile: "CONTROL" } } },
      'profile "CONTROL" is not supported by the grant route (DEV only',
    ],
    [
      "STG profile",
      { grants: { [GRANT_ID]: { profile: "STG" } } },
      'profile "STG" is not supported',
    ],
    [
      "unsupported schema",
      { grants: { [GRANT_ID]: { schema: "rosuno-grant/v0" } } },
      'unsupported schema "rosuno-grant/v0"',
    ],
    [
      "grant_id differs from the record name",
      { grants: { [GRANT_ID]: { grant_id: "UX-009" } } },
      'grant_id "UX-009" does not match the record name UX-001',
    ],
    [
      "unrecognized field",
      { grants: { [GRANT_ID]: { files: ["apps/web/*"] } } },
      "unknown: files",
    ],
    [
      "unsupported effect",
      { grants: { [GRANT_ID]: { effects: ["code", "control"] } } },
      "effects must be a non-empty set of code, schema and dependencies",
    ],
    [
      "no PR authors",
      { grants: { [GRANT_ID]: { pr_authors: [] } } },
      "pr_authors must be 1-20 distinct GitHub logins",
    ],
    [
      "case-duplicated PR authors",
      { grants: { [GRANT_ID]: { pr_authors: [OWNER, OWNER.toLowerCase()] } } },
      "pr_authors must be 1-20 distinct GitHub logins",
    ],
    [
      "control characters in purpose",
      { grants: { [GRANT_ID]: { purpose: "line one\nline two" } } },
      "purpose must be 1-500 characters without control characters",
    ],
    [
      "offset timestamps",
      { grants: { [GRANT_ID]: { expires_at: "2027-03-01T00:00:00+01:00" } } },
      "issued_at and expires_at must be YYYY-MM-DDTHH:MM:SSZ",
    ],
  ];
  for (const [name, owner, message] of cases) {
    test(`REFUSED: ${name}`, () => {
      const f = fixture();
      assertRejected(f.run({ steps: [UI], owner: f.owner(owner) }), message);
    });
  }

  test("REFUSED: forged or case-aliased grant records", () => {
    const f = fixture();
    const valid = grantText(GRANT_ID);
    const forged = valid.replace(
      '"profile": "DEV"',
      '"profile": "CONTROL",\n  "profile": "DEV"',
    );
    assert.notEqual(forged, valid);
    for (const [raw, message] of [
      [{ [GRANT_PATH]: forged }, 'contains duplicate JSON keys (["profile"])'],
      [{ [`${GRANT_DIR}/ux-001.json`]: valid }, "found 2"],
      [{ [GRANT_PATH]: "null\n" }, "is not exactly one JSON object"],
    ]) {
      assertRejected(f.run({ steps: [UI], owner: f.owner({ raw }) }), message);
    }
  });

  test("REFUSED: a grant carried in the PR itself authorizes nothing", () => {
    const f = fixture();
    const result = f.run({
      steps: [
        { ...UI, [GRANT_PATH]: grantText(GRANT_ID), [ACTIVATION_PATH]: "{}\n" },
      ],
      owner: f.owner({ grants: {} }),
    });
    assertRejected(
      result,
      `grant ${GRANT_ID}: expected exactly one owner record`,
    );
    // With a valid owner grant, the same PR is still refused for writing
    // grant records: a PR cannot grant or widen its own scope.
    assertRejected(
      f.run({ steps: [{ ...UI, [GRANT_PATH]: grantText(GRANT_ID) }] }),
      `${GRANT_PATH} (A) is a control path; a standing grant never changes it`,
    );
  });

  test("REFUSED: unauthorized actor, delegation without capability P, wrong source or missing runner values", () => {
    const f = fixture();
    assertRejected(
      f.run({ steps: [UI], env: { ROSUNO_PR_AUTHOR: "Stranger" } }),
      "PR author Stranger is not one of the grant PR authors",
    );
    assertRejected(
      f.run({
        steps: [UI],
        owner: f.owner({
          grants: { [GRANT_ID]: { pr_authors: [OWNER, BUILDER] } },
        }),
        env: { ROSUNO_PR_AUTHOR: BUILDER },
      }),
      `PR author ${BUILDER} is not the owner, and delegated PR authorship (capability P) is not active`,
    );
    assertRejected(
      f.run({ steps: [UI], env: { ROSUNO_HEAD_REPO: "Other/Rosuno" } }),
      "PR head repository 'Other/Rosuno' is not the authorized Builder fork",
    );
    assertRejected(
      f.run({ steps: [UI], env: { ROSUNO_PR_AUTHOR: "bad login!" } }),
      "is not a valid login",
    );
    for (const name of Object.keys(GRANT_ENV).filter(
      (key) => key !== "ROSUNO_NOW",
    )) {
      assertRejected(
        f.run({ steps: [UI], env: { [name]: "" } }),
        `grant route needs ${name} from the trusted runner`,
      );
    }
    assertRejected(
      f.run({ steps: [UI], env: { ROSUNO_NOW: "2026-12-01" } }),
      "ROSUNO_NOW '2026-12-01' is not YYYY-MM-DDTHH:MM:SSZ",
    );
  });

  test("REFUSED: malformed grant branch names", () => {
    const f = fixture();
    for (const branch of [
      "grant/ux-001/client",
      `grant/${GRANT_ID}`,
      `grant/${GRANT_ID}/a/b`,
      `grant/${GRANT_ID}/Upper`,
      `grant/${GRANT_ID}/-dash`,
    ]) {
      assertRejected(
        f.run({ steps: [UI], branch }),
        `branch '${branch}' is not grant/<ID>/<slug>`,
      );
    }
  });
});

describe("P2-927 grant route: effects and protected paths", () => {
  const CONTROL_PATHS = [
    ".github/workflows/spoof-rosuno-guard-status.yml",
    ".github/scripts/rosuno-guard.sh",
    ".github/CODEOWNERS",
    ".github/dependabot.yml",
    ".GitHub/workflows/case-alias.yml",
    "CLAUDE.md",
    "apps/web/CLAUDE.md",
    "CLAUDE.local.md",
    ".claude/settings.json",
    "apps/web/.claude/settings.json",
    ".mcp.json",
    "apps/web/.mcp.json",
    "AGENTS.md",
    "apps/web/AGENTS.md",
    "docs/process/new-procedure.md",
    "docs/process/p2-905-enablement-contract.md",
    `docs/work-items/${GRANT_ID}/PACKET.md`,
    "docs/work-items/P9-001/PACKET.md",
    ".gitattributes",
    "apps/web/.gitattributes",
    ".npmrc",
    "apps/web/.npmrc",
    "pnpm-workspace.yaml",
    "apps/web/pnpm-workspace.yaml",
    ".pnpmfile.cjs",
    "apps/web/.pnpmfile.cjs",
    "packages/ui/package.json",
    "apps/web/pnpm-lock.yaml",
    ".replit",
    ".replitignore",
    "tools/p0/validate.mjs",
    "tools/p0/lib/controls.mjs",
    "tools/p0/tests/weakened.test.mjs",
    "supabase/config.toml",
    "supabase/seed.sql",
    "supabase/seeds/fixture.sql",
  ];

  test("REFUSED: every control path, added or changed, under a grant with every effect", () => {
    const f = fixture();
    for (const file of CONTROL_PATHS) {
      const status = file in BASE_FILES ? "M" : "A";
      assertRejected(
        f.run({ steps: [{ ...UI, [file]: "# changed\n" }] }),
        `${file} (${status}) is a control path; a standing grant never changes it`,
      );
    }
    assertRejected(
      f.run({
        steps: [{ "docs/process/p2-905-enablement-contract.md": null }],
      }),
      "docs/process/p2-905-enablement-contract.md (D) is a control path",
    );
  });

  test("REFUSED: governance authority and persistent-application records; existing evidence is immutable", () => {
    const f = fixture();
    for (const file of [
      "governance/authority-references.json",
      "governance/control-fields.json",
      "governance/environments/staging.example.json",
      "governance/README.md",
      "governance/releases/traceability.json",
      "governance/schema-drift/baseline.json",
    ]) {
      const status = file in BASE_FILES ? "M" : "A";
      assertRejected(
        f.run({ steps: [{ [file]: "{}\n\n" }] }),
        `${file} (${status}) is a governance control or persistent-application record`,
      );
    }
    assertRejected(
      f.run({
        steps: [
          { "governance/evidence/historical.json": '{ "evidence": 9 }\n' },
        ],
      }),
      "governance/evidence/historical.json (M): existing evidence is immutable",
    );
    assertRejected(
      f.run({ steps: [{ "governance/evidence/historical.json": null }] }),
      "governance/evidence/historical.json (D): existing evidence is immutable",
    );
  });

  test("REFUSED: package manifests may change only their dependency fields", () => {
    const f = fixture();
    for (const [file, manifest] of [
      [
        "package.json",
        { ...ROOT_MANIFEST, scripts: { "p0:validate": "true" } },
      ],
      [
        "apps/web/package.json",
        { ...WEB_MANIFEST, scripts: { build: "true" } },
      ],
      [
        "apps/web/package.json",
        { ...WEB_MANIFEST, pnpm: { overrides: { next: "1" } } },
      ],
      ["package.json", { ...ROOT_MANIFEST, packageManager: "pnpm@10.0.0" }],
    ]) {
      assertRejected(
        f.run({ steps: [{ [file]: json(manifest) }] }),
        `${file}: a standing grant may change only dependencies and devDependencies`,
      );
    }
    const duplicate = json(WEB_MANIFEST).replace(
      '"scripts": {',
      '"scripts": { "build": "true" },\n  "scripts": {',
    );
    assertRejected(
      f.run({ steps: [{ "apps/web/package.json": duplicate }] }),
      "apps/web/package.json at head is not one JSON object with string-valued dependencies and no duplicate keys",
    );
    assertRejected(
      f.run({
        steps: [
          {
            "apps/web/package.json": json({
              ...WEB_MANIFEST,
              dependencies: { next: 16 },
            }),
          },
        ],
      }),
      "string-valued dependencies",
    );
    assertRejected(
      f.run({ steps: [{ "package.json": null }] }),
      "package.json (D): a standing grant may only modify an existing package manifest",
    );
  });

  test("REFUSED: dependency, schema and code changes outside the grant's effects", () => {
    const f = fixture();
    const codeOnly = f.owner({ grants: { [GRANT_ID]: { effects: ["code"] } } });
    assertRejected(
      f.run({ steps: [DEPENDENCY], owner: codeOnly }),
      "apps/web/package.json (M) is a package manifest; grant UX-001 does not include effect dependencies",
      "pnpm-lock.yaml (M) is the lockfile; grant UX-001 does not include effect dependencies",
    );
    assertRejected(
      f.run({ steps: [SCHEMA], owner: codeOnly }),
      `new migration ${NEW_MIGRATION} but grant UX-001 does not include effect schema`,
    );
    const schemaOnly = f.owner({
      grants: { [GRANT_ID]: { effects: ["schema"] } },
    });
    assertRejected(
      f.run({ steps: [UI], owner: schemaOnly }),
      "apps/web/src/page.ts (M) needs effect code, which grant UX-001 does not include",
    );
  });

  test("REFUSED: owner exclusions win over effects", () => {
    const f = fixture();
    const excluded = f.owner({
      grants: {
        [GRANT_ID]: { exclusions: ["supabase/*", "apps/web/app/admin/*"] },
      },
    });
    assertRejected(
      f.run({ steps: [SCHEMA], owner: excluded }),
      `${NEW_MIGRATION} (A) is excluded by grant UX-001`,
    );
    assertRejected(
      f.run({
        steps: [{ "apps/web/app/Admin/page.tsx": "export default 1;\n" }],
        owner: excluded,
      }),
      "apps/web/app/Admin/page.tsx (A) is excluded by grant UX-001",
    );
    assertGrantPass(f, f.run({ steps: [UI], owner: excluded }));
  });
});

describe("P2-927 grant route: migrations, history and repository hazards", () => {
  test("PRESERVED: historical migrations are immutable (change, delete, rename)", () => {
    const f = fixture();
    for (const step of [
      { [HISTORICAL_MIGRATION]: "select 99;\n" },
      { [HISTORICAL_MIGRATION]: null },
      {
        [HISTORICAL_MIGRATION]: null,
        "supabase/migrations/20261202000000_historical_fixture.sql":
          "select 1;\n",
      },
      { [UNAPPLIED_MIGRATION]: "select 3;\n" },
    ]) {
      assertRejected(f.run({ steps: [step] }), /is on main and immutable/);
    }
  });

  test("PRESERVED: new migrations are canonical, ordered and canonical-case", () => {
    const f = fixture();
    assertRejected(
      f.run({
        steps: [{ "supabase/migrations/20261201000000_Add-Items.sql": "x\n" }],
      }),
      "must be named supabase/migrations/<14-digit UTC>_<lower_snake>.sql",
    );
    assertRejected(
      f.run({
        steps: [{ "supabase/migrations/20251231000000_old.sql": "x\n" }],
      }),
      "must sort after the newest migration on main (20260102000000)",
    );
    assertRejected(
      f.run({
        steps: [{ "supabase/Migrations/20261201000000_items.sql": "x\n" }],
      }),
      "migrations path with non-canonical case",
    );
  });

  test("REFUSED: false applied registration of a new or existing migration", () => {
    const f = fixture();
    assertRejected(
      f.run({
        steps: [
          {
            [NEW_MIGRATION]: "create table items ();\n",
            [REG]: register([...BASE_ROWS, row(NEW_MIGRATION, true)]),
          },
        ],
      }),
      `migration ${NEW_MIGRATION} is registered as applied before merge`,
      `may register ${NEW_MIGRATION} only as unapplied and unreviewed`,
    );
    const flipped = [BASE_ROWS[0], row(UNAPPLIED_MIGRATION, true)];
    assertRejected(
      f.run({ steps: [{ [REG]: register(flipped) }] }),
      `a standing grant may not record or change a persistent application of ${UNAPPLIED_MIGRATION}`,
    );
    const released = [
      BASE_ROWS[0],
      { ...row(UNAPPLIED_MIGRATION), release_refs: ["REL-FORGED"] },
    ];
    assertRejected(
      f.run({ steps: [{ [REG]: register(released) }] }),
      `may not record or change a persistent application of ${UNAPPLIED_MIGRATION}`,
    );
    assertRejected(
      f.run({ steps: [{ [REG]: register([BASE_ROWS[0]]) }] }),
      `a standing grant may not remove the registered migration ${UNAPPLIED_MIGRATION}`,
    );
    assertRejected(
      f.run({ steps: [{ [REG]: "{ not json\n" }] }),
      `${REG} at head is not valid JSON`,
    );
  });

  test("PRESERVED: stale main is refused; the fix is an integration merge", () => {
    const f = fixture();
    assertRejected(
      f.run({ steps: [UI], guardBase: f.later }),
      `head does not contain current main ${f.later}`,
    );
  });

  test("PRESERVED: secrets, private authority, special objects and case aliases are refused", () => {
    const f = fixture();
    const blob = f.repo.git(["hash-object", "-w", "--stdin"], "x");
    for (const [step, message] of [
      [{ ".env": "TOKEN=x\n" }, ".env looks like a secret or credential file"],
      [
        { "apps/web/.env.local": "x\n" },
        "apps/web/.env.local looks like a secret",
      ],
      [{ "certs/server.pem": "x\n" }, "certs/server.pem looks like a secret"],
      [
        { "rosuno-authority/charter.md": "x\n" },
        "private authority documents never enter the repository",
      ],
      [{ ".gitmodules": "x\n" }, ".gitmodules: submodules are not allowed"],
      [
        { "apps/web/src/link.ts": { mode: "120000", oid: blob } },
        "has git mode 120000",
      ],
      [
        { "apps/web/vendor": { mode: "160000", oid: f.base } },
        "has git mode 160000",
      ],
      [{ "apps/web/src/Page.ts": "x\n" }, "case-insensitive path collision"],
      [
        { "apps/web/src/legacy.ts": null, "apps/web/src/Legacy.ts": "x\n" },
        "case-only change of an existing main path",
      ],
    ]) {
      assertRejected(f.run({ steps: [step] }), message);
    }
  });

  test("PRESERVED: a secret, authority path or symlink is refused even when a later commit removes it", () => {
    const f = fixture();
    const blob = f.repo.git(["hash-object", "-w", "--stdin"], "x");
    for (const [add, message] of [
      [
        { ".env": "TOKEN=x\n" },
        /commit [0-9a-f]{12} contains credential-like path \.env/,
      ],
      [
        { "rosuno-authority/x.md": "x\n" },
        /contains private authority path rosuno-authority\/x\.md/,
      ],
      [
        { "apps/web/src/l.ts": { mode: "120000", oid: blob } },
        /\[commit [0-9a-f]{12}\] apps\/web\/src\/l\.ts has git mode 120000/,
      ],
    ]) {
      const removed = Object.fromEntries(
        Object.keys(add).map((key) => [key, null]),
      );
      assertRejected(f.run({ steps: [add, removed, UI] }), message);
    }
  });
});

// ---------------------------------------------------------------------------
// Packet route: byte-identical to guard v4
// ---------------------------------------------------------------------------

const PACKET_ID = "P9-927";
const PACKET_BRANCH = "wi/P9-927-fixture";
const PK = `docs/work-items/${PACKET_ID}/PACKET.md`;

function packetText(
  base,
  {
    id = PACKET_ID,
    branch = PACKET_BRANCH,
    type = "FEATURE",
    migrations = "none",
    allowed = ["apps/web/src/*", "apps/web/tests/*"],
    forbidden = ["apps/web/src/vendor/*", ".env", ".env.*"],
  } = {},
) {
  return [
    `WORK_ITEM: ${id}`,
    `TYPE: ${type}`,
    `BRANCH: ${branch}`,
    `BASE_SHA: ${base}`,
    `MIGRATIONS: ${migrations}`,
    "ALLOWED_SCOPE:",
    ...allowed.map((entry) => `- ${entry}`),
    "FORBIDDEN_SCOPE:",
    ...forbidden.map((entry) => `- ${entry}`),
    "",
    `# ${id} synthetic fixture Packet`,
    "",
  ].join("\n");
}

function packetFixture() {
  const repo = createRepo();
  const base = repo.child([], BASE_FILES, "owner main");
  const later = repo.child([base], { "README.md": "later main\n" }, "main 2");
  let approvals = 0;
  return {
    repo,
    base,
    later,
    merge: (tip) =>
      repo.child([tip, later], { "README.md": "later main\n" }, "merge"),
    // Builds the head and the owner approval branch once, so both guards judge
    // exactly the same objects.
    build({
      packet = packetText(base),
      approval = packet,
      before = [],
      steps = [],
      branch = PACKET_BRANCH,
      guardBase = base,
      withPacket = true,
    } = {}) {
      const apply = (tip, step) =>
        typeof step === "function"
          ? step(tip)
          : repo.child([tip], step, "implementation");
      let tip = base;
      for (const step of before) tip = apply(tip, step);
      if (withPacket) tip = repo.child([tip], { [PK]: packet }, "Packet");
      for (const step of steps) tip = apply(tip, step);
      approvals += 1;
      const approvedRef = `refs/fixture/approved-${approvals}`;
      if (approval !== "missing") {
        repo.ref(
          approvedRef,
          approval === null
            ? base
            : repo.child([base], { [PK]: approval }, "owner approval"),
        );
      }
      return [guardBase, tip, branch, approvedRef];
    },
  };
}

const IMPLEMENTATION = {
  "apps/web/src/feature.ts": "export const feature = 1;\n",
  "apps/web/src/app.env.example": "PLACEHOLDER=\n",
  "apps/web/tests/feature.test.ts": "// ordinary test\n",
};

function packetScenarios(f) {
  const process = packetText(f.base, {
    type: "PROCESS",
    allowed: [".github/scripts/rosuno-guard.sh", "CLAUDE.md", "package.json"],
  });
  const migrations = packetText(f.base, {
    migrations: "new allowed",
    allowed: ["supabase/migrations/*", REG],
  });
  const carried = "docs/work-items/P9-918/PACKET.md";
  const blob = f.repo.git(["hash-object", "-w", "--stdin"], "x");
  return [
    ["compliant", { steps: [IMPLEMENTATION] }],
    ["Packet only", {}],
    ["Packet not first", { before: [{ "apps/web/src/early.ts": "x\n" }] }],
    [
      "PROCESS Packet edits control paths",
      {
        packet: process,
        steps: [
          { "CLAUDE.md": "# x\n", ".github/scripts/rosuno-guard.sh": "# x\n" },
        ],
      },
    ],
    ["outside ALLOWED_SCOPE", { steps: [{ "apps/web/app/page.tsx": "x\n" }] }],
    [
      "inside FORBIDDEN_SCOPE",
      { steps: [{ "apps/web/src/vendor/x.ts": "x\n" }] },
    ],
    [
      "control path without PROCESS",
      {
        packet: packetText(f.base, {
          allowed: ["apps/web/src/*", "CLAUDE.md"],
        }),
        steps: [{ "CLAUDE.md": "# x\n" }],
      },
    ],
    [
      "new migration with MIGRATIONS: none",
      {
        packet: packetText(f.base, { allowed: ["supabase/migrations/*"] }),
        steps: [{ [NEW_MIGRATION]: "x\n" }],
      },
    ],
    [
      "new migration allowed",
      { packet: migrations, steps: [{ [NEW_MIGRATION]: "x\n" }] },
    ],
    [
      "new migration registered applied",
      {
        packet: migrations,
        steps: [
          {
            [NEW_MIGRATION]: "x\n",
            [REG]: register([...BASE_ROWS, row(NEW_MIGRATION, true)]),
          },
        ],
      },
    ],
    [
      "existing migration flipped to applied (Packet route judges scope only)",
      {
        packet: migrations,
        steps: [
          { [REG]: register([BASE_ROWS[0], row(UNAPPLIED_MIGRATION, true)]) },
        ],
      },
    ],
    [
      "historical migration changed",
      { packet: migrations, steps: [{ [HISTORICAL_MIGRATION]: "x\n" }] },
    ],
    [
      "migration out of order",
      {
        packet: migrations,
        steps: [{ "supabase/migrations/20250101000000_x.sql": "x\n" }],
      },
    ],
    ["credential file", { steps: [{ "apps/web/src/.env": "x\n" }] }],
    [
      "symlink",
      { steps: [{ "apps/web/src/l.ts": { mode: "120000", oid: blob } }] },
    ],
    [
      "history-only secret",
      {
        steps: [
          { "apps/web/src/.env.local": "x\n" },
          { "apps/web/src/.env.local": null },
        ],
      },
    ],
    ["private authority", { steps: [{ "rosuno-authority/x.md": "x\n" }] }],
    ["case alias", { steps: [{ "apps/web/src/Page.ts": "x\n" }] }],
    ["stale base", { steps: [IMPLEMENTATION], guardBase: f.later }],
    [
      "integration merge",
      {
        packet: packetText(f.later),
        steps: [IMPLEMENTATION, f.merge],
        guardBase: f.later,
      },
    ],
    [
      "Packet differs from approval",
      { approval: packetText(f.base, { type: "PROCESS" }) },
    ],
    ["approval branch missing", { approval: "missing" }],
    ["approval branch without Packet", { approval: null }],
    ["Packet missing at head", { withPacket: false, steps: [IMPLEMENTATION] }],
    ["branch is not wi/<ID>", { branch: "feature/x" }],
    ["branch with lowercase ID", { branch: "wi/p9-927-fixture" }],
    ["Packet with CR", { packet: packetText(f.base).replace("\n", "\r\n") }],
    ["duplicate header", { packet: `${packetText(f.base)}TYPE: PROCESS\n` }],
    [
      "carried literal Packet",
      {
        packet: packetText(f.base, { allowed: ["apps/web/src/*", carried] }),
        steps: [{ [carried]: "WORK_ITEM: P9-918\n" }],
      },
    ],
    [
      "carried Packet not listed",
      { steps: [{ [carried]: "WORK_ITEM: P9-918\n" }] },
    ],
    [
      "merged Packet edited",
      { steps: [{ "docs/work-items/P9-001/PACKET.md": "edited\n" }] },
    ],
    ["grant record path under a Packet", { steps: [{ [GRANT_PATH]: "{}\n" }] }],
  ];
}

describe("P2-927 Packet route: preserved byte for byte", () => {
  test("PRESERVED: v5 gives exactly v4's exit status, output and errors on every Packet-route scenario", () => {
    const f = packetFixture();
    const outcomes = new Set();
    for (const [name, options] of packetScenarios(f)) {
      const args = f.build(options);
      // The grant-route runner values must not influence the Packet route.
      for (const env of [{}, GRANT_ENV]) {
        const v4 = runScript(f.repo, V4_GUARD, args, env);
        const v5 = runScript(f.repo, GUARD, args, env);
        assert.deepEqual(
          { status: v5.status, stdout: v5.stdout, stderr: v5.stderr },
          { status: v4.status, stdout: v4.stdout, stderr: v4.stderr },
          name,
        );
        outcomes.add(v4.status);
      }
    }
    assert.deepEqual([...outcomes].sort(), [0, 1]);
  });

  test("PRESERVED: a compliant work item passes with the unchanged v4 PASS line", () => {
    const f = packetFixture();
    const args = f.build({ steps: [IMPLEMENTATION] });
    const result = runScript(f.repo, GUARD, args);
    assert.equal(result.status, 0, result.output);
    const approved = f.repo.git(["rev-parse", args[3]]);
    assert.deepEqual(
      result.stdout
        .split("\n")
        .filter((line) => line.includes("ROSUNO-GUARD PASS")),
      [
        `ROSUNO-GUARD PASS work_item=${PACKET_ID} type=FEATURE packet_sha256=${sha256(packetText(f.base))} base=${f.base} head=${args[1]} approved=${approved}`,
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// Trust binding, workflow, registry and neutral-path contracts
// ---------------------------------------------------------------------------

describe("P2-927 trust binding: a grant branch gains nothing", () => {
  const HEAD_SHA = "a".repeat(40);
  const TRUST_ENV = {
    EXPECTED_REPO: REPO,
    EXPECTED_BASE: "main",
    BUILDER_FORK: FORK,
    OWNER_LOGIN: OWNER,
  };
  function trust({
    author = OWNER,
    headRepo = FORK,
    fork = true,
    open = [`7 ${HEAD_SHA}`],
    base = "main",
  } = {}) {
    const dir = mkdtempSync(path.join(SANDBOX, "trust-"));
    const event = path.join(dir, "event.json");
    const prs = path.join(dir, "open-prs.txt");
    writeFileSync(
      event,
      JSON.stringify({
        pull_request: {
          number: 7,
          state: "open",
          user: { login: author },
          head: {
            sha: HEAD_SHA,
            ref: BRANCH,
            repo: { full_name: headRepo, fork },
          },
          base: { ref: base, repo: { full_name: REPO } },
        },
        repository: { full_name: REPO, default_branch: "main" },
      }),
    );
    writeFileSync(prs, `${open.join("\n")}\n`);
    const result = spawnSync("bash", [TRUST, event, prs], {
      env: { ...fixtureEnv(), ...TRUST_ENV },
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
    };
  }

  test("PRESERVED: the unchanged trust binding admits only the owner-created Builder-fork PR, once per head", () => {
    assert.equal(gitBlobId(readFileSync(TRUST)), TRUST_BLOB);
    const ok = trust();
    assert.equal(ok.status, 0, ok.output);
    assert.equal(ok.output.trim(), "MODE=builder");
    for (const [options, message] of [
      [{ author: BUILDER }, `PR was created by '${BUILDER}', not the owner`],
      [{ headRepo: "Other/Rosuno" }, "is not the authorized Builder fork"],
      [{ fork: false }, "is not a fork"],
      [
        { open: [`7 ${HEAD_SHA}`, `8 ${HEAD_SHA}`] },
        `2 open PRs carry head ${HEAD_SHA}`,
      ],
      [{ open: [`8 ${HEAD_SHA}`] }, "is not #7"],
      [{ base: "release" }, "PR base branch is 'release', not 'main'"],
    ]) {
      const result = trust(options);
      assert.equal(result.status, 1, result.output);
      assert.ok(
        result.output.includes(message),
        `${message}\n${result.output}`,
      );
    }
  });
});

describe("P2-927 trusted workflow contract", () => {
  const text = readFileSync(WORKFLOW, "utf8");
  const code = text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  test("selects the owner ref by branch shape and fetches it as data into the approved ref", () => {
    assert.ok(code.includes("      ROSUNO_GRANTS_BRANCH: rosuno-grants\n"));
    assert.ok(
      code.includes(
        'if [[ "$HEAD_REF" =~ ^wi/[A-Z][A-Z0-9]*-[0-9]{3}(-[a-z0-9-]+)?$ ]]; then\n            OWNER_BRANCH="$HEAD_REF";',
      ),
    );
    assert.ok(
      code.includes(
        'elif [[ "$HEAD_REF" =~ ^grant/[A-Z][A-Z0-9]*-[0-9]{3}/[a-z0-9][a-z0-9-]{0,62}$ ]]; then\n            OWNER_BRANCH="$ROSUNO_GRANTS_BRANCH";',
      ),
    );
    assert.ok(
      code.includes(
        'echo "::error::head branch is neither wi/<ID>[-slug] nor grant/<ID>/<slug>"; exit 1',
      ),
    );
    assert.ok(
      code.includes(
        'git fetch --no-tags https://github.com/"$REPO".git "+refs/heads/${OWNER_BRANCH}:refs/rosuno/approved"',
      ),
    );
    assert.equal((code.match(/refs\/rosuno\/approved/g) ?? []).length, 2);
  });

  test("passes the PR author and head repository to the unchanged guard invocation, from trusted step outputs", () => {
    assert.ok(
      code.includes(
        '          ROSUNO_PR_AUTHOR: ${{ steps.pr.outputs.PR_AUTHOR }}\n          ROSUNO_HEAD_REPO: ${{ steps.pr.outputs.HEAD_REPO }}\n        run: bash .github/scripts/rosuno-guard.sh "$BASE" "$HEAD_SHA" "$HEAD_REF" refs/rosuno/approved',
      ),
    );
    assert.ok(
      code.includes(
        'HEAD_REPO="$(jq -r \'.head.repo.full_name // ""\' "$RUNNER_TEMP/pr.json")"',
      ),
    );
    assert.ok(
      code.includes('echo "HEAD_REPO=$HEAD_REPO"; } >> "$GITHUB_OUTPUT"'),
    );
    assert.doesNotMatch(code, /ROSUNO_NOW/);
  });

  test("PRESERVED: one checkout of main, App-only status, no new secret, no PR execution", () => {
    assert.equal((code.match(/actions\/checkout@/g) ?? []).length, 1);
    assert.doesNotMatch(code, /pull_request_target|git (checkout|switch)/);
    assert.equal(
      (code.match(/gh api "repos\/\$REPO\/statuses\//g) ?? []).length,
      2,
    );
    assert.deepEqual(
      [...new Set(code.match(/secrets\.[A-Z_]+/g))],
      ["secrets.ROSUNO_GUARD_APP_PRIVATE_KEY"],
    );
    assert.deepEqual(scanSecretLikeText(text, "rosuno-guard.yml"), []);
  });
});

function gitShowJson(oid) {
  return JSON.parse(pinnedBlob(oid, oid).toString("utf8"));
}

describe("P2-927 records: adoption registered once, by digest, nothing activated", () => {
  const authority = JSON.parse(
    readFileSync(
      path.join(ROOT, "governance/authority-references.json"),
      "utf8",
    ),
  ).references;
  const decisions = JSON.parse(
    readFileSync(path.join(ROOT, "governance/decision-log.json"), "utf8"),
  ).decisions;
  const workItems = JSON.parse(
    readFileSync(path.join(ROOT, "governance/work-items/index.json"), "utf8"),
  ).work_items;

  test("the adopted package is registered by exact digest only, reference-only, with only capability E recorded as active", () => {
    const entries = authority.filter(
      (entry) => entry.authority_id === "GOVERNANCE-MODERNIZATION-V1.1",
    );
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.integrity, `sha256:${ADOPTED_DIGEST}`);
    assert.equal(entry.locked, true);
    assert.equal(entry.content_copied, false);
    assert.equal(entry.reinterpreted, false);
    assert.equal(entry.usage, "reference-only");
    // The owner activated capability E only (owner record e18b6c7, 2026-11-25);
    // a later activation or revocation is a records change on the PROCESS route.
    assert.equal(entry.status, "conditionally_adopted_capability_E_active");
  });

  test("PRESERVED: prior references and all 58 prior decisions are unchanged; P0-001 stays external", () => {
    const mainAuthority = gitShowJson(MAIN_AUTHORITY_BLOB).references;
    const mainDecisions = gitShowJson(MAIN_DECISION_LOG_BLOB).decisions;
    assert.equal(mainAuthority.length, 18);
    assert.equal(mainDecisions.length, 58);
    assert.deepEqual(authority.slice(0, mainAuthority.length), mainAuthority);
    assert.deepEqual(decisions.slice(0, mainDecisions.length), mainDecisions);
    const p0 = authority.find(
      (entry) => entry.authority_id === "P0-001-LOCKED",
    );
    assert.equal(p0.status, "external_reference_pending");
    assert.equal(p0.integrity, "not_available");
  });

  test("one decision and one work item record the conditional adoption and the CONTROL program", () => {
    const decision = decisions.filter((entry) =>
      entry.decision_id.includes("P2-927"),
    );
    assert.equal(decision.length, 1);
    assert.equal(
      decision[0].decision_id,
      "DEC-20261124-P2-927-GOVERNANCE-MODERNIZATION-CONDITIONAL-ADOPTION",
    );
    assert.equal(decision[0].status, "accepted");
    assert.deepEqual(decision[0].authority_refs, [
      "GOVERNANCE-MODERNIZATION-V1.1",
    ]);
    assert.deepEqual(decision[0].work_item_refs, [
      "WI-P2-927-GOVERNANCE-MODERNIZATION-CONTROL",
    ]);
    assert.deepEqual(decision[0].supersedes, []);
    assert.ok(
      decision[0].evidence.some((item) => item.includes(ADOPTED_DIGEST)),
    );
    const item = workItems.filter((entry) =>
      entry.work_item_id.includes("P2-927"),
    );
    assert.equal(item.length, 1);
    assert.equal(
      item[0].work_item_id,
      "WI-P2-927-GOVERNANCE-MODERNIZATION-CONTROL",
    );
    assert.deepEqual(item[0].migration_refs, []);
    assert.equal(item[0].environment, "none");
  });
});

describe("P2-927 neutral-path admission", () => {
  const PROCESS_DOC = "docs/process/p2-927-standing-grant-route.md";
  const packages = [PRE_APPLICATION_STATE, WEB_APPLICATION_STATE].map(
    (state) => [
      state,
      {
        name: "rosuno",
        version: "0.0.0",
        license: "MIT",
        scripts: { ...ROOT_SCRIPT_PROFILES[state] },
        private: true,
        devDependencies: { prettier: "^3.9.6", typescript: "~5.9.3" },
      },
    ],
  );

  test("the procedure is admitted as one exact path; near-misses stay refused", () => {
    for (const [state, packageJson] of packages) {
      assert.doesNotThrow(() =>
        validateNeutralPaths([PROCESS_DOC], packageJson, state),
      );
      for (const file of [
        "docs/process/p2-927-standing-grant-route.md.bak",
        "docs/process/P2-927-standing-grant-route.md",
        "docs/process/p2-927-standing-grant-route-v2.md",
        "docs/process/p2-927/standing-grant-route.md",
        "docs/process/p2-928-standing-grant-route.md",
        ".github/rosuno-grants/activation.json",
        ".github/rosuno-grants/UX-001.json",
      ]) {
        assert.throws(
          () => validateNeutralPaths([PROCESS_DOC, file], packageJson, state),
          { message: `product implementation paths are present: ${file}` },
          `${state}: ${file}`,
        );
      }
    }
    assert.ok(readFileSync(path.join(ROOT, PROCESS_DOC), "utf8").length > 0);
  });
});
