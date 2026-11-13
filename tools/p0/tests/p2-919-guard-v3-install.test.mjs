// P2-919: live regression coverage for the installed rosuno-guard v3, its
// workflow_run trusted runner, the reconciled Builder settings and CLAUDE.md
// (adopted P2-919 Packet).
//
// Each guard scenario is labelled:
// - PRESERVED: a protection of the adopted P2-905, P2-914 or P2-916 controls
//   that stays in force. The historical P2-914 and P2-916 test files keep
//   proving the superseded guard against its pinned blobs; this file proves the
//   same protection against the live guard.
// - CHANGED: an intended v3 behaviour adopted by the P2-919 Owner decision.
//   Each is asserted explicitly so that it can never change silently.
//
// Command-string rules are AUTHORIZATION LIMITS, not a Shell containment
// boundary (P2-916 Packet §2, §4). The matching model below is a static model
// of the reviewed contract; effective runtime behaviour is separate evidence.
//
// Fixtures are synthetic. Disposable repositories are built with Git plumbing
// only, with no user/global Git configuration and only the file transport.
// Nothing contacts a remote, reads a real secret or alters a real repository.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { scanSecretLikeText } from "../lib/controls.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const GUARD = path.join(ROOT, ".github/scripts/rosuno-guard.sh");
const TRUST = path.join(ROOT, ".github/scripts/rosuno-guard-trust.sh");
const WORKFLOW = path.join(ROOT, ".github/workflows/rosuno-guard.yml");
const SETTINGS = path.join(ROOT, ".claude/settings.json");
const INSTRUCTIONS = path.join(ROOT, "CLAUDE.md");

// The trust binding is not changed by P2-919 (same blob as at Owner main
// ed95b006 and in the T0-verified Candidate A).
const TRUST_BLOB = "d6a16c8db64a95f47916323f90ef06f294190457";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const gitBlobId = (bytes) =>
  createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
const normalized = (text) => text.replace(/\s+/g, " ");

const SANDBOX = mkdtempSync(path.join(tmpdir(), "rosuno-p2-919-"));
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

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
let clock = 1_794_528_000; // 2026-11-12T00:00:00Z

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
  const repo = {
    dir,
    env,
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
      const ident = `P2-919 Fixture <fixture@example.invalid> ${clock} +0000`;
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
  return repo;
}

const ID = "P9-919";
const BRANCH = "wi/P9-919-fixture";
const PK = `docs/work-items/${ID}/PACKET.md`;
const HISTORICAL_MIGRATION =
  "supabase/migrations/20260101000000_historical_fixture.sql";
const MERGED_PACKET = "docs/work-items/P9-001/PACKET.md";
const BASE_FILES = {
  "README.md": "Disposable P2-919 guard fixture.\n",
  "CLAUDE.md": "# fixture instructions\n",
  ".claude/settings.json": '{ "permissions": { "deny": [] } }\n',
  ".github/scripts/rosuno-guard.sh": "# guard stand-in\n",
  "apps/web/src/page.ts": "export const page = 1;\n",
  "apps/web/src/legacy.ts": "export const legacy = 1;\n",
  "governance/decision-log.json": '{ "decisions": [] }\n',
  [HISTORICAL_MIGRATION]: "select 1;\n",
  [MERGED_PACKET]: "WORK_ITEM: P9-001\n",
};

function packetText(
  base,
  {
    id = ID,
    branch = BRANCH,
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

function fixture() {
  const repo = createRepo();
  const base = repo.child([], BASE_FILES, "owner main");
  const later = repo.child([base], { "README.md": "later main\n" }, "main 2");
  let approvals = 0;
  const merge =
    (changes = {}, other = later) =>
    (tip) =>
      repo.child(
        [tip, other],
        { "README.md": "later main\n", ...changes },
        "merge",
      );
  return {
    repo,
    base,
    later,
    merge,
    run({
      packet = packetText(base),
      approval = packet,
      before = [],
      steps = [],
      from = base,
      branch = BRANCH,
      guardBase = base,
      withPacket = true,
    } = {}) {
      const apply = (tip, step) =>
        typeof step === "function"
          ? step(tip)
          : repo.child([tip], step, "implementation");
      let tip = from;
      for (const step of before) tip = apply(tip, step);
      if (withPacket) tip = repo.child([tip], { [PK]: packet }, "Packet");
      for (const step of steps) tip = apply(tip, step);
      approvals += 1;
      const approvedRef = `refs/fixture/approved-${approvals}`;
      let approvedOid = null;
      if (approval !== "missing") {
        approvedOid =
          approval === null
            ? base
            : repo.child([base], { [PK]: approval }, "owner approval");
        repo.ref(approvedRef, approvedOid);
      }
      const result = spawnSync(
        "bash",
        [GUARD, guardBase, tip, branch, approvedRef],
        { cwd: repo.dir, env: repo.env, encoding: "utf8", timeout: 60_000 },
      );
      if (result.error) throw result.error;
      return {
        status: result.status,
        stdout: result.stdout,
        output: `${result.stdout}${result.stderr}`,
        packet,
        head: tip,
        guardBase,
        approvedOid,
      };
    },
  };
}

function assertPass(result, type = "FEATURE") {
  assert.equal(result.status, 0, result.output);
  const passes = result.stdout
    .split("\n")
    .filter((line) => line.includes("ROSUNO-GUARD PASS"));
  assert.deepEqual(passes, [
    `ROSUNO-GUARD PASS work_item=${ID} type=${type} packet_sha256=${sha256(result.packet)} base=${result.guardBase} head=${result.head} approved=${result.approvedOid}`,
  ]);
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

const IMPLEMENTATION = {
  "apps/web/src/feature.ts": "export const feature = 1;\n",
  "apps/web/src/app.env.example": "PLACEHOLDER=\n",
  "apps/web/tests/feature.test.ts": "// ordinary test\n",
};

describe("P2-919 live guard: preserved protections", () => {
  test("PRESERVED: a compliant work item passes with exactly one PASS line", () => {
    const f = fixture();
    assertPass(f.run({ steps: [IMPLEMENTATION] }));
    assertPass(f.run({ steps: [] }));
    const process = packetText(f.base, {
      type: "PROCESS",
      allowed: [".github/scripts/rosuno-guard.sh", "CLAUDE.md"],
      forbidden: [".env"],
    });
    assertPass(
      f.run({
        packet: process,
        steps: [{ ".github/scripts/rosuno-guard.sh": "# changed\n" }],
      }),
      "PROCESS",
    );
  });

  test("PRESERVED: missing, altered, unapproved or edited Packets fail", () => {
    const f = fixture();
    assertRejected(
      f.run({ withPacket: false, steps: [IMPLEMENTATION] }),
      `Packet ${PK} missing at head or not a regular file`,
    );
    assertRejected(
      f.run({ approval: `${packetText(f.base)}altered\n` }),
      `Packet differs from the owner-approved Packet on owner branch ${BRANCH}`,
    );
    assertRejected(
      f.run({ approval: null }),
      `owner branch ${BRANCH} has no ${PK}`,
    );
    assertRejected(
      f.run({ approval: "missing" }),
      `owner approval branch for ${BRANCH} not found`,
    );
    assertRejected(
      f.run({ steps: [IMPLEMENTATION, { [PK]: "edited\n" }] }),
      `Packet differs from the owner-approved Packet on owner branch ${BRANCH}`,
    );
    const crlf = packetText(f.base).replace("\n", "\r\n");
    assertRejected(
      f.run({ packet: crlf }),
      "Packet contains a carriage return",
    );
  });

  test("PRESERVED: branch identifiers and Packet identity bind fail closed", () => {
    const f = fixture();
    for (const branch of ["wi/p9-919-lower", "feature/P9-919", "wi/P9-91-x"]) {
      assertRejected(
        f.run({ branch }),
        `branch '${branch}' is not wi/<ID>[-slug]`,
      );
    }
    assertRejected(
      f.run({ packet: packetText(f.base, { id: "P9-918" }) }),
      `Packet WORK_ITEM 'P9-918' does not match branch work item '${ID}'`,
    );
    assertRejected(
      f.run({ packet: packetText(f.base, { branch: "wi/P9-919-other" }) }),
      "does not match the PR head branch",
    );
    assertRejected(
      f.run({ packet: `${packetText(f.base)}TYPE: FEATURE\n` }),
      "Packet must contain exactly one TYPE line",
    );
  });

  test("PRESERVED: scope, FORBIDDEN precedence, control paths and records", () => {
    const f = fixture();
    const reject = (changes, ...expected) =>
      assertRejected(f.run({ steps: [IMPLEMENTATION, changes] }), ...expected);
    reject(
      { "apps/web/src/vendor/lib.ts": "vendored\n" },
      "apps/web/src/vendor/lib.ts (A) is inside FORBIDDEN_SCOPE",
    );
    reject(
      { "apps/web/next.config.ts": "export default {};\n" },
      "apps/web/next.config.ts (A) is outside ALLOWED_SCOPE",
    );
    reject(
      { "governance/decision-log.json": "{}\n" },
      "governance/decision-log.json (M) is outside ALLOWED_SCOPE",
    );
    reject(
      { "docs/work-items/P9-915/PACKET.md": "other\n" },
      "docs/work-items/P9-915/PACKET.md (A) is another work item's record",
    );
    reject({ ".gitmodules": "" }, ".gitmodules: submodules are not allowed");
    reject(
      { "rosuno-authority/original.md": "private\n" },
      "rosuno-authority/original.md: private authority documents never enter the repository",
    );
    const feature = packetText(f.base, {
      allowed: ["apps/web/src/*", ".claude/*", "CLAUDE.md"],
    });
    assertRejected(
      f.run({
        packet: feature,
        steps: [{ ".claude/settings.json": "{}\n" }],
      }),
      ".claude/settings.json is a control path; it requires a TYPE: PROCESS Packet",
    );
    assertRejected(
      f.run({ packet: feature, steps: [{ "CLAUDE.md": "# self-rewrite\n" }] }),
      "CLAUDE.md is a control path; it requires a TYPE: PROCESS Packet",
    );
  });

  test("PRESERVED: credential-like and private-authority paths fail in any commit", () => {
    const f = fixture();
    for (const file of [
      "apps/web/src/.env.local",
      "apps/web/src/deploy.pem",
      "apps/web/src/keys/id_ed25519",
    ]) {
      assertRejected(
        f.run({ steps: [{ [file]: "PLACEHOLDER\n" }] }),
        `${file} looks like a secret or credential file`,
      );
      // Public history is permanent: removing it later does not help.
      assertRejected(
        f.run({ steps: [{ [file]: "PLACEHOLDER\n" }, { [file]: null }] }),
        new RegExp(
          `commit [0-9a-f]{12} contains credential-like path ${file.replace(/[.]/g, "\\.")}`,
        ),
      );
    }
    assertRejected(
      f.run({
        steps: [
          { "rosuno-authority/original.md": "private\n" },
          { "rosuno-authority/original.md": null },
        ],
      }),
      /commit [0-9a-f]{12} contains private authority path rosuno-authority\/original\.md/,
    );
  });

  test("PRESERVED (P2-905): symlinks and gitlinks fail, even if replaced later", () => {
    const f = fixture();
    assertRejected(
      f.run({
        steps: [
          { "apps/web/src/link.ts": { mode: "120000", content: "../x" } },
        ],
      }),
      "[final diff] apps/web/src/link.ts has git mode 120000 (symlink/submodule/special objects are not allowed)",
    );
    assertRejected(
      f.run({
        steps: [{ "apps/web/src/sub": { mode: "160000", oid: f.base } }],
      }),
      "[final diff] apps/web/src/sub has git mode 160000",
    );
    const replaced = f.run({
      steps: [
        { "apps/web/src/link.ts": { mode: "120000", content: "../x" } },
        { "apps/web/src/link.ts": "export const link = 1;\n" },
      ],
    });
    assertRejected(
      replaced,
      /\[commit [0-9a-f]{12}\] apps\/web\/src\/link\.ts has git mode 120000/,
    );
    assert.doesNotMatch(replaced.output, /\[final diff\]/);
  });

  test("PRESERVED: case collisions and case-only aliases fail", () => {
    const f = fixture();
    assertRejected(
      f.run({
        steps: [
          {
            "apps/web/src/feature.ts": "a\n",
            "apps/web/src/Feature.ts": "b\n",
          },
        ],
      }),
      "case-insensitive path collision: apps/web/src/feature.ts",
    );
    assertRejected(
      f.run({
        steps: [
          { "apps/web/src/legacy.ts": null, "apps/web/src/Legacy.ts": "x\n" },
        ],
      }),
      "case-only change of an existing main path: apps/web/src/legacy.ts -> apps/web/src/Legacy.ts",
    );
  });

  test("PRESERVED: migrations are forward-only, declared, named and unapplied", () => {
    const f = fixture();
    const allowed = ["apps/web/src/*", "supabase/migrations/*"];
    const reviewed = "governance/migrations/reviewed-migrations.json";
    const withMigrations = packetText(f.base, {
      migrations: "new allowed",
      allowed: [...allowed, reviewed],
    });
    const run = (packet, changes) => f.run({ packet, steps: [changes] });
    assertRejected(
      run(withMigrations, { [HISTORICAL_MIGRATION]: "select 2;\n" }),
      `migration ${HISTORICAL_MIGRATION} is on main and immutable (status M)`,
    );
    assertRejected(
      run(withMigrations, { [HISTORICAL_MIGRATION]: null }),
      `migration ${HISTORICAL_MIGRATION} is on main and immutable (status D)`,
    );
    const added = "supabase/migrations/20261112000000_p9_919.sql";
    assertRejected(
      run(packetText(f.base, { allowed }), { [added]: "select 1;\n" }),
      `new migration ${added} but the Packet says MIGRATIONS: none`,
    );
    assertRejected(
      run(withMigrations, {
        "supabase/migrations/20261112000000_Bad-Name.sql": "select 1;\n",
      }),
      "must be named supabase/migrations/<14-digit UTC>_<lower_snake>.sql",
    );
    assertRejected(
      run(withMigrations, {
        "supabase/migrations/20251231000000_too_old.sql": "select 1;\n",
      }),
      "must sort after the newest migration on main (20260101000000)",
    );
    assertRejected(
      run(withMigrations, {
        [added]: "select 1;\n",
        [reviewed]: `${JSON.stringify({
          migrations: [
            { artifact_path: added, applied_environment: "staging" },
          ],
        })}\n`,
      }),
      `migration ${added} is registered as applied before merge`,
    );
    assertPass(run(withMigrations, { [added]: "select 1;\n" }));
  });

  test("PRESERVED: a merged work item's Packet cannot be reused", () => {
    const f = fixture();
    const reuse = f.run({
      packet: packetText(f.base, { id: "P9-001", branch: "wi/P9-001-again" }),
      branch: "wi/P9-001-again",
    });
    assertRejected(reuse, `Packet ${MERGED_PACKET} already exists on main`);
  });
});

describe("P2-919 live guard: intended v3 changes (Owner decision)", () => {
  test("CHANGED: the head must contain current Owner main (replaces the base binding)", () => {
    const f = fixture();
    assertRejected(
      f.run({ steps: [IMPLEMENTATION], guardBase: f.later }),
      `head does not contain current main ${f.later}; merge main into the branch (never rebase)`,
    );
  });

  test("CHANGED: an integration merge of current main passes; the net diff still decides", () => {
    const f = fixture();
    assertPass(
      f.run({ steps: [IMPLEMENTATION, f.merge()], guardBase: f.later }),
    );
    // A merge cannot smuggle an out-of-scope change past the net diff.
    assertRejected(
      f.run({
        steps: [
          IMPLEMENTATION,
          f.merge({ "apps/web/next.config.ts": "export default {};\n" }),
        ],
        guardBase: f.later,
      }),
      "apps/web/next.config.ts (A) is outside ALLOWED_SCOPE",
    );
  });

  test("CHANGED: Packet BASE_SHA is provenance only", () => {
    const f = fixture();
    assertPass(
      f.run({
        packet: packetText(f.later),
        steps: [IMPLEMENTATION, f.merge()],
        guardBase: f.later,
      }),
    );
  });

  test("CHANGED: an ordinary out-of-scope change reverted inside the branch passes on the net diff", () => {
    const f = fixture();
    assertPass(
      f.run({
        steps: [
          { "apps/web/next.config.ts": "export default {};\n" },
          { "apps/web/next.config.ts": null },
          IMPLEMENTATION,
        ],
      }),
    );
  });

  test("CHANGED: the Packet need not be the first commit", () => {
    const f = fixture();
    assertPass(f.run({ before: [{ "apps/web/src/early.ts": "early\n" }] }));
  });

  test("CHANGED: an earlier Packet may be carried only literally, new and unchanged", () => {
    const f = fixture();
    const carried = "docs/work-items/P9-918/PACKET.md";
    const literal = packetText(f.base, {
      allowed: ["apps/web/src/*", "apps/web/tests/*", carried],
    });
    assertPass(
      f.run({
        packet: literal,
        steps: [{ [carried]: "WORK_ITEM: P9-918\n" }, IMPLEMENTATION],
      }),
    );
    assertRejected(
      f.run({ steps: [{ [carried]: "WORK_ITEM: P9-918\n" }] }),
      `${carried} (A) is another work item's record`,
    );
    const mergedLiteral = packetText(f.base, {
      allowed: ["apps/web/src/*", MERGED_PACKET],
    });
    assertRejected(
      f.run({
        packet: mergedLiteral,
        steps: [{ [MERGED_PACKET]: "WORK_ITEM: P9-001\nedited\n" }],
      }),
      `${MERGED_PACKET} (M) is another work item's record`,
    );
  });
});

describe("P2-919 trusted workflow contract", () => {
  const text = readFileSync(WORKFLOW, "utf8");
  const code = text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  test("runs only on completed P0 runs or an owner dispatch, never pull_request_target", () => {
    assert.ok(
      text.includes(
        'on:\n  workflow_run:\n    workflows: ["P0 control foundation"]\n    types: [completed]\n  workflow_dispatch:\n',
      ),
    );
    assert.doesNotMatch(code, /pull_request_target/);
    assert.doesNotMatch(code, /^\s{2}(pull_request|push):/m);
    assert.ok(
      code.includes(
        "if: github.event_name == 'workflow_dispatch' || github.event.workflow_run.event == 'pull_request'",
      ),
    );
  });

  test("keeps a read-only token and the canonical trust values", () => {
    assert.ok(
      text.includes(
        "permissions:\n  contents: read\n  pull-requests: read\nconcurrency:",
      ),
    );
    assert.doesNotMatch(code, /^\s*statuses:\s*write/m);
    for (const line of [
      "EXPECTED_REPO: NatthanPrevot/Rosuno",
      "EXPECTED_BASE: main",
      "BUILDER_FORK: RosunoBackup/Rosuno",
      "OWNER_LOGIN: NatthanPrevot",
    ]) {
      assert.ok(code.includes(line), line);
    }
  });

  test("publishes the status only with the dedicated App token, passed through step env", () => {
    assert.ok(
      code.includes(
        "uses: actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510",
      ),
    );
    assert.ok(code.includes("permission-statuses: write"));
    assert.ok(code.includes("environment:\n      name: rosuno-guard-status"));
    const posts = code.match(/gh api "repos\/\$REPO\/statuses\//g) ?? [];
    const appEnv =
      code.match(/^\s+GH_TOKEN: \$\{\{ steps\.app\.outputs\.token \}\}$/gm) ??
      [];
    assert.equal(posts.length, 2);
    assert.equal(appEnv.length, 2);
    assert.doesNotMatch(code, /GH_TOKEN="/);
    assert.deepEqual(
      [...new Set(code.match(/secrets\.[A-Z_]+/g))],
      ["secrets.ROSUNO_GUARD_APP_PRIVATE_KEY"],
    );
    assert.deepEqual(scanSecretLikeText(text, "rosuno-guard.yml"), []);
  });

  test("never checks out or executes the PR head; trust binding and guard run from main", () => {
    assert.equal((code.match(/actions\/checkout@/g) ?? []).length, 1);
    assert.ok(
      code.includes(
        "with:\n          ref: ${{ github.event.repository.default_branch }}\n          fetch-depth: 0\n          persist-credentials: false",
      ),
    );
    assert.doesNotMatch(code, /allow-unsafe-pr-checkout|git (checkout|switch)/);
    assert.ok(code.includes('"+refs/pull/${PR}/head:refs/rosuno/pr-head"'));
    assert.ok(
      code.includes(
        'bash .github/scripts/rosuno-guard-trust.sh "$RUNNER_TEMP/event.json" "$RUNNER_TEMP/open-prs.txt"',
      ),
    );
    assert.ok(code.includes("grep -qx 'MODE=builder'"));
    assert.ok(
      code.includes(
        'run: bash .github/scripts/rosuno-guard.sh "$BASE" "$HEAD_SHA" "$HEAD_REF" refs/rosuno/approved',
      ),
    );
    assert.equal(gitBlobId(readFileSync(TRUST)), TRUST_BLOB);
  });
});

// Every limit in the Builder settings adopted by P2-916, with its P2-919
// disposition (UOM v1.7.10 §§15.3, 58, 60; C1 rev5.11 §C1.3):
// - "deny": still denied (an invariant);
// - "ask": prompt-gated, so an Access Profile can grant it per operation;
// - "open": no longer restricted locally; the trusted guard, PROCESS typing
//   and review enforce it, and the deny blocked legitimate engineering;
// - "gh": read-only gh is open, every gh write family and gh api ask.
const P2_916_SETTINGS_BLOB = "518ee2ef47db1531b4a001d21c72dc6fee25def9";
const P2_916_DISPOSITION = {
  "Edit(/docs/work-items/**)": "open",
  "Edit(/rosuno-authority/**)": "deny",
  "Edit(/.github/**)": "open",
  "Edit(/.claude/**)": "deny",
  "Edit(/CLAUDE.md)": "ask",
  "Edit(/docs/process/**)": "open",
  "Edit(/.gitmodules)": "open",
  "Edit(/supabase/config.toml)": "open",
  "Edit(/supabase/seed.sql)": "open",
  "Edit(/supabase/seeds/**)": "open",
  "Read(./.env)": "deny",
  "Read(./.env.*)": "deny",
  "Read(./**/.env)": "deny",
  "Read(./**/.env.*)": "deny",
  "Bash(git push --force*)": "deny",
  "Bash(git push -f*)": "deny",
  "Bash(git push --delete*)": "deny",
  "Bash(git commit --amend*)": "deny",
  "Bash(git rebase *)": "deny",
  "Bash(git push --mirror*)": "deny",
  "Bash(git push --all*)": "deny",
  "Bash(git reset --hard*)": "deny",
  "Bash(git filter-*)": "deny",
  "Bash(git submodule *)": "deny",
  "Bash(supabase login*)": "ask",
  "Bash(supabase link*)": "ask",
  "Bash(supabase db push*)": "ask",
  "Bash(supabase secrets*)": "ask",
  "Bash(supabase projects*)": "ask",
  "Bash(supabase functions deploy*)": "ask",
  "Bash(npx supabase login*)": "ask",
  "Bash(npx supabase link*)": "ask",
  "Bash(npx supabase db push*)": "ask",
  "Bash(npx supabase secrets*)": "ask",
  "Bash(npx supabase projects*)": "ask",
  "Bash(npx supabase functions deploy*)": "ask",
  "Bash(gh *)": "gh",
  "Bash(git merge *)": "open",
  "Bash(git pull *)": "deny",
  "Bash(git push*)": "ask",
  "Bash(git worktree add*)": "deny",
};
// A representative command for each P2-916 Bash rule.
const PROBE = {
  "Bash(git push --force*)": "git push --force origin wi/P9-919-fixture",
  "Bash(git push -f*)": "git push -f origin wi/P9-919-fixture",
  "Bash(git push --delete*)": "git push --delete origin wi/P9-919-fixture",
  "Bash(git commit --amend*)": "git commit --amend --no-edit",
  "Bash(git rebase *)": "git rebase main",
  "Bash(git push --mirror*)": "git push --mirror origin",
  "Bash(git push --all*)": "git push --all origin",
  "Bash(git reset --hard*)": "git reset --hard HEAD~1",
  "Bash(git filter-*)": "git filter-repo --path x",
  "Bash(git submodule *)": "git submodule add ../x x",
  "Bash(supabase login*)": "supabase login",
  "Bash(supabase link*)": "supabase link --project-ref x",
  "Bash(supabase db push*)": "supabase db push",
  "Bash(supabase secrets*)": "supabase secrets list",
  "Bash(supabase projects*)": "supabase projects list",
  "Bash(supabase functions deploy*)": "supabase functions deploy x",
  "Bash(npx supabase login*)": "npx supabase login",
  "Bash(npx supabase link*)": "npx supabase link --project-ref x",
  "Bash(npx supabase db push*)": "npx supabase db push",
  "Bash(npx supabase secrets*)": "npx supabase secrets list",
  "Bash(npx supabase projects*)": "npx supabase projects list",
  "Bash(npx supabase functions deploy*)": "npx supabase functions deploy x",
  "Bash(git merge *)": "git merge refs/rosuno/main",
  "Bash(git pull *)": "git pull origin main",
  "Bash(git push*)": "git push origin wi/P9-919-fixture",
  "Bash(git worktree add*)": "git worktree add ../other",
};
// The only kinds of operation the ask list may gate.
const ASK_FAMILIES = [
  /^Bash\(git push\*\)$/,
  /^Bash\(git (-C|-c|--git-dir|--work-tree)\*?\s?\*?\)$/,
  /^Edit\((\/|\*\*\/)(CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md)\)$/,
  /^Bash\(gh [a-z-]+( [a-z-]+)?\*\)$/,
  /^Bash\((npx )?supabase [^)]*\*\)$/,
  /^mcp__\*$/,
];

// Static model: a rule matches when its whole pattern, with `*` as a wildcard,
// matches the whole command; a deny wins over an ask.
const ruleMatches = (rule, command) => {
  const pattern = rule.slice("Bash(".length, -1);
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(command);
};

function adoptedP2916Denies() {
  const result = spawnSync("git", ["cat-file", "blob", P2_916_SETTINGS_BLOB], {
    cwd: ROOT,
    env: {
      ...process.env,
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `pinned P2-916 settings blob ${P2_916_SETTINGS_BLOB} is missing; a full-history checkout is required`,
  );
  return JSON.parse(result.stdout).permissions.deny;
}

describe("P2-919 Builder settings contract (authorization limits)", () => {
  const raw = readFileSync(SETTINGS, "utf8");
  const settings = JSON.parse(raw);
  const deny = settings.permissions.deny;
  const ask = settings.permissions.ask;
  const decide = (command) => {
    const bash = (rules) => rules.filter((rule) => rule.startsWith("Bash("));
    if (bash(deny).some((rule) => ruleMatches(rule, command))) return "deny";
    if (bash(ask).some((rule) => ruleMatches(rule, command))) return "ask";
    return "none";
  };

  test("every P2-916 limit has an explicit P2-919 disposition, and it holds", () => {
    assert.deepEqual(Object.keys(P2_916_DISPOSITION), adoptedP2916Denies());
    for (const [rule, disposition] of Object.entries(P2_916_DISPOSITION)) {
      if (rule.startsWith("Bash(") && disposition !== "gh") {
        const expected = { deny: "deny", ask: "ask", open: "none" }[
          disposition
        ];
        assert.equal(decide(PROBE[rule]), expected, `${rule}: ${PROBE[rule]}`);
      } else if (rule.startsWith("Edit(") || rule.startsWith("Read(")) {
        assert.equal(deny.includes(rule), disposition === "deny", rule);
        assert.equal(ask.includes(rule), disposition === "ask", rule);
      }
    }
    assert.equal(new Set(deny).size, deny.length, "no duplicate deny rules");
    assert.equal(new Set(ask).size, ask.length, "no duplicate ask rules");
  });

  test("the ask list gates only owner operations; no allow list or other elevation", () => {
    for (const rule of ask) {
      assert.ok(
        ASK_FAMILIES.some((family) => family.test(rule)),
        `unexpected ask rule ${rule}`,
      );
    }
    assert.deepEqual(Object.keys(settings).sort(), [
      "allowedMcpServers",
      "enableAllProjectMcpServers",
      "permissions",
    ]);
    assert.deepEqual(Object.keys(settings.permissions), ["deny", "ask"]);
    assert.equal(settings.enableAllProjectMcpServers, false);
    assert.deepEqual(settings.allowedMcpServers, []);
    assert.doesNotMatch(
      raw,
      /bypassPermissions|dangerously|defaultMode|"allow"|"hooks"|"env"|"sandbox"|additionalDirectories|mcpServers"\s*:\s*\{|apiKeyHelper/,
    );
  });

  test("PRESERVED: self-configuration, secrets and private authority stay denied; instructions prompt", () => {
    for (const rule of [
      "Edit(/.claude/**)",
      "Edit(**/.claude/**)",
      "Edit(/.mcp.json)",
      "Edit(**/.mcp.json)",
      "Edit(/rosuno-authority/**)",
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./**/.env)",
      "Read(./**/.env.*)",
      "mcp__remote-devices__*",
      "mcp__claude-in-chrome__*",
      "mcp__Claude_Browser__*",
      "enable__mcp__*",
    ]) {
      assert.ok(deny.includes(rule), rule);
    }
    for (const rule of [
      "Edit(/CLAUDE.md)",
      "Edit(**/CLAUDE.md)",
      "Edit(/CLAUDE.local.md)",
      "Edit(**/CLAUDE.local.md)",
      "Edit(/AGENTS.md)",
      "Edit(**/AGENTS.md)",
      "mcp__*",
    ]) {
      assert.ok(ask.includes(rule), rule);
    }
  });

  test("PRESERVED: publication is prompt-gated; every rewriting or destructive push is denied", () => {
    for (const command of [
      "git push --force origin wi/P9-919-fixture",
      "git push --force-with-lease origin wi/P9-919-fixture",
      "git push -f origin wi/P9-919-fixture",
      "git push origin wi/P9-919-fixture --force",
      "git push origin +wi/P9-919-fixture",
      "git push origin :wi/P9-919-fixture",
      "git push --delete origin wi/P9-919-fixture",
      "git push -d origin wi/P9-919-fixture",
      "git push origin -d wi/P9-919-fixture",
      "git push --mirror origin",
      "git push --all origin",
      "git push --tags origin",
    ]) {
      assert.equal(decide(command), "deny", command);
    }
    for (const command of [
      "git push origin wi/P9-919-fixture",
      "git push",
      "git -C . push origin wi/P9-919-fixture",
      "git -c core.hooksPath=/dev/null push origin wi/P9-919-fixture",
      "git --git-dir=.git push origin wi/P9-919-fixture",
    ]) {
      assert.equal(decide(command), "ask", command);
    }
  });

  test("PRESERVED: history rewriting stays denied; remote mutations prompt", () => {
    for (const command of [
      "git commit --amend",
      "git rebase -i HEAD~2",
      "git reset --hard HEAD~1",
      "git filter-branch --tree-filter x",
      "git pull",
      "git pull --rebase origin main",
      "git worktree add ../other",
      "git submodule update --init",
    ]) {
      assert.equal(decide(command), "deny", command);
    }
    for (const command of [
      "gh pr create --base main",
      "gh pr merge 91 --merge",
      "gh pr review 91 --approve",
      "gh pr comment 91 --body x",
      "gh api repos/NatthanPrevot/Rosuno/pulls",
      "gh api -X DELETE repos/RosunoBackup/Rosuno/git/refs/heads/x",
      "gh repo delete RosunoBackup/Rosuno --yes",
      "gh repo sync RosunoBackup/Rosuno",
      "gh release create v1",
      "gh workflow run p0-controls.yml",
      "gh secret set X",
      "gh auth login",
      "supabase db push",
      "supabase db reset --linked",
      "supabase migration up --db-url postgres://example.invalid/x",
      "npx supabase link --project-ref x",
      "npx supabase functions deploy x",
    ]) {
      assert.equal(decide(command), "ask", command);
    }
  });

  test("CHANGED: routine engineering, integration merges and read-only inspection are unprompted", () => {
    for (const command of [
      "git add -- apps/web/src/feature.ts",
      "git commit -m x",
      "git status --porcelain",
      "git diff --check",
      "git log --oneline",
      "git fetch origin",
      "git fetch --unshallow origin",
      "git switch -c wi/P9-919-fixture",
      "git update-ref refs/rosuno/approved FETCH_HEAD",
      "git merge refs/rosuno/main",
      "git merge --no-ff refs/rosuno/main",
      "git merge-base refs/rosuno/main HEAD",
      "gh pr view 91 --repo NatthanPrevot/Rosuno",
      "gh pr checks 91 --repo NatthanPrevot/Rosuno",
      "gh pr diff 91 --repo NatthanPrevot/Rosuno",
      "gh run view 123 --log --repo NatthanPrevot/Rosuno",
      "gh run list --repo NatthanPrevot/Rosuno",
      "gh repo view NatthanPrevot/Rosuno",
      "pnpm run p0:test",
      "node --test",
      "npx supabase start",
      "npx supabase db reset --local",
      "npx supabase stop",
    ]) {
      assert.equal(decide(command), "none", command);
    }
  });
});

describe("P2-919 CLAUDE.md contract", () => {
  const text = normalized(readFileSync(INSTRUCTIONS, "utf8"));

  test("PRESERVED: authority, publication, deny, secret, migration and safety rules", () => {
    for (const phrase of [
      "The locked authority is private and is NOT in this repository.",
      "Never write authority text or prompt-only context into any file.",
      "G-1…G-5 and the CA-* items stay configuration, never defaults or seeds.",
      "Pushing commits to `origin` is a distinct, separately owner-authorized publication gate: do not push on your own at the end of implementation.",
      "Never create, edit, mark ready, review, approve or merge a pull request, by any tool or API",
      "The grant never overrides an effective tool deny.",
      "do not reach the denied result through Shell redirection, an alternate interpreter, another worktree, a different tool or another identity",
      "Never take a concealed alternative route.",
      "Never modify, delete or rename an existing migration.",
      "Never print any variable's value.",
      "Never fabricate demo or seed business records; test data lives only in tests.",
      "Running this self-check is part of finishing implementation; it is not permission to publish.",
      "Never weaken a test, RLS policy, constraint or check to make something pass.",
      "never Full to work around a restriction",
    ]) {
      assert.ok(text.includes(phrase), phrase);
    }
  });

  test("CHANGED: autonomous engineering, FIX path, integration merge and prompt-gated publication", () => {
    for (const phrase of [
      "investigate any part of Rosuno (any phase, any age, merged or open)",
      "With one owner-adopted Packet and the owner's grant (UOM §15.1 / C1 rev5.11 §C1.2)",
      "merge current owner `main` into the work-item branch when needed; correct your own unmerged migrations",
      "A defect in merged work needs a FIX Packet (you draft it); never rewrite merged history or a historical migration.",
      "run exactly `git push origin <branch>` once: the permission prompt is the owner's approval, and a denied prompt ends the attempt",
      "Configuration integrity: every `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude/**` and `.mcp.json` path equals owner `main` or the blobs the Packet names.",
      "The guard judges scope on the net diff against current owner `main`, and checks every commit on its own for credential-like or private-authority paths and for symlinks, submodules or other special objects",
      "Integration merges of current owner `main` (fetched from the owner repository) are normal and need no approval; never rebase, and never merge any other branch into yours.",
      "`bash .github/scripts/rosuno-guard.sh <current owner main SHA> HEAD <branch> refs/rosuno/approved`",
      "Read-only `gh` inspection (PR, run and repository views) needs no approval",
    ]) {
      assert.ok(text.includes(phrase), phrase);
    }
    for (const obsolete of [
      "History must stay linear",
      "a forbidden or out-of-scope change that you later revert still fails the guard",
      "<BASE_SHA from the Packet>",
      "Never access any repository other than `origin`.",
      "authored by independent ChatGPT outside Claude",
    ]) {
      assert.ok(!text.includes(obsolete), obsolete);
    }
  });
});
