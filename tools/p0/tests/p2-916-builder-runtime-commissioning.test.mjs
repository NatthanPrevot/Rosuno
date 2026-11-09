// P2-916 V2: regression coverage for the Builder-runtime local engineering
// contract (adopted P2-916 V2 Packet §2-§4).
//
// What this file proves, and what it does not:
// - It checks the committed `.claude/settings.json` and `CLAUDE.md` as an
//   authorization contract: the retained and added denies, the absence of any
//   permission elevation, and the local-autonomy / publication-gate wording.
//   Command-string denies are AUTHORIZATION LIMITS, not a Shell containment
//   boundary: a general-purpose interpreter used by approved tests can perform
//   arbitrary local operations. Nothing here claims otherwise (Packet §2, §4).
// - It runs the genuine, unchanged rosuno-guard against synthetic disposable Git
//   histories to show that per-commit scope, Packet binding, linear history and
//   migration rules are enforced at the merge boundary as guard outcomes.
// - Effective runtime behaviour (tool-level denials, credential boundary) is
//   evidenced separately in the Gate 2 report, not by these static tests.
//
// Fixtures are synthetic. Disposable repositories are built with Git plumbing
// only (no working-tree files, so filename case on the host filesystem cannot
// matter), with no user/global Git configuration and only the file transport.
// Nothing contacts a remote, reads a real secret or alters a real repository.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const SETTINGS = path.join(ROOT, ".claude/settings.json");
const INSTRUCTIONS = path.join(ROOT, "CLAUDE.md");
const PACKET = path.join(ROOT, "docs/work-items/P2-916/PACKET.md");
const GUARD = path.join(ROOT, ".github/scripts/rosuno-guard.sh");
const TRUST = path.join(ROOT, ".github/scripts/rosuno-guard-trust.sh");
const WORKFLOW = path.join(ROOT, ".github/workflows/rosuno-guard.yml");

const BRANCH = "wi/P2-916-builder-runtime-commissioning-v2";
const PACKET_PATH = "docs/work-items/P2-916/PACKET.md";
const TEST_PATH =
  "tools/p0/tests/p2-916-builder-runtime-commissioning.test.mjs";
const OWNER_MAIN = "b003c23475b8fd22c2ad7496df51923c5d3fa6e3";
// Protected controls that P2-916 must leave byte-identical to Owner main.
const OWNER_MAIN_GUARD_BLOB = "2dad1d6e866684d1d6f3422f413779b061594559";
const OWNER_MAIN_TRUST_BLOB = "d6a16c8db64a95f47916323f90ef06f294190457";
const OWNER_MAIN_WORKFLOW_BLOB = "6c64a49d270f3ab81b2272b0a30ff163e32703ec";

// Every deny present at the P2-916 base, in order. P2-916 may add limits but
// must retain each of these exactly.
const BASE_DENIES = [
  "Edit(/docs/work-items/**)",
  "Edit(/rosuno-authority/**)",
  "Edit(/.github/**)",
  "Edit(/.claude/**)",
  "Edit(/CLAUDE.md)",
  "Edit(/docs/process/**)",
  "Edit(/.gitmodules)",
  "Edit(/supabase/config.toml)",
  "Edit(/supabase/seed.sql)",
  "Edit(/supabase/seeds/**)",
  "Read(./.env)",
  "Read(./.env.*)",
  "Read(./**/.env)",
  "Read(./**/.env.*)",
  "Bash(git push --force*)",
  "Bash(git push -f*)",
  "Bash(git push --delete*)",
  "Bash(git commit --amend*)",
  "Bash(git rebase *)",
  "Bash(git push --mirror*)",
  "Bash(git push --all*)",
  "Bash(git reset --hard*)",
  "Bash(git filter-*)",
  "Bash(git submodule *)",
  "Bash(supabase login*)",
  "Bash(supabase link*)",
  "Bash(supabase db push*)",
  "Bash(supabase secrets*)",
  "Bash(supabase projects*)",
  "Bash(supabase functions deploy*)",
  "Bash(npx supabase login*)",
  "Bash(npx supabase link*)",
  "Bash(npx supabase db push*)",
  "Bash(npx supabase secrets*)",
  "Bash(npx supabase projects*)",
  "Bash(npx supabase functions deploy*)",
  "Bash(gh *)",
  "Bash(git merge *)",
  "Bash(git pull *)",
];
// Authorization limits added by P2-916 for gaps observed in the original
// Gate 2 probes: plain push was not denied, and another worktree is a route
// around path-anchored Edit denies.
const ADDED_DENIES = ["Bash(git push*)", "Bash(git worktree add*)"];

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const gitBlobId = (bytes) =>
  createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
const normalized = (text) => text.replace(/\s+/g, " ");

describe("P2-916 settings contract (authorization limits, not containment)", () => {
  const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));

  test("retains every base deny exactly and adds only the reviewed limits", () => {
    const deny = settings.permissions.deny;
    assert.deepEqual(deny.slice(0, BASE_DENIES.length), BASE_DENIES);
    assert.deepEqual(deny.slice(BASE_DENIES.length), ADDED_DENIES);
    assert.equal(new Set(deny).size, deny.length, "no duplicate rules");
  });

  test("grants no elevation: no allow/ask lists, mode, hooks, env, MCP or sandbox changes", () => {
    assert.deepEqual(Object.keys(settings).sort(), [
      "allowedMcpServers",
      "enableAllProjectMcpServers",
      "permissions",
    ]);
    assert.deepEqual(Object.keys(settings.permissions), ["deny"]);
    assert.equal(settings.enableAllProjectMcpServers, false);
    assert.deepEqual(settings.allowedMcpServers, []);
    const raw = readFileSync(SETTINGS, "utf8");
    assert.doesNotMatch(
      raw,
      /bypassPermissions|dangerously|defaultMode|"allow"|"ask"|"hooks"|"env"|"sandbox"|additionalDirectories|mcpServers"\s*:\s*\{|apiKeyHelper/,
    );
  });

  test("keeps protected instruction and policy files Edit-denied (no self-rewrite)", () => {
    const deny = settings.permissions.deny;
    for (const rule of [
      "Edit(/CLAUDE.md)",
      "Edit(/.claude/**)",
      "Edit(/.github/**)",
      "Edit(/docs/work-items/**)",
      "Edit(/rosuno-authority/**)",
    ]) {
      assert.ok(deny.includes(rule), rule);
    }
  });

  test("keeps remote, history, secret and database operations as authorization limits", () => {
    const deny = new Set(settings.permissions.deny);
    for (const rule of [
      "Bash(git push*)",
      "Bash(git commit --amend*)",
      "Bash(git rebase *)",
      "Bash(git reset --hard*)",
      "Bash(git filter-*)",
      "Bash(git merge *)",
      "Bash(git pull *)",
      "Bash(gh *)",
      "Read(./**/.env)",
      "Read(./**/.env.*)",
      "Bash(supabase db push*)",
      "Bash(npx supabase link*)",
      "Bash(supabase functions deploy*)",
    ]) {
      assert.ok(deny.has(rule), rule);
    }
    // Ordinary local engineering stays available: nothing denies local
    // staging, ordinary commits, status/diff/log or the package scripts.
    const bash = [...deny].filter((rule) => rule.startsWith("Bash("));
    for (const command of [
      "git add -- CLAUDE.md",
      "git commit -m x",
      "git status --porcelain",
      "git diff --check",
      "pnpm run p0:test",
      "node --test",
    ]) {
      const blocked = bash.some((rule) => {
        const pattern = rule.slice(5, -1);
        const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
        return command.startsWith(prefix);
      });
      assert.equal(blocked, false, command);
    }
  });
});

describe("P2-916 CLAUDE.md local engineering contract", () => {
  const text = normalized(readFileSync(INSTRUCTIONS, "utf8"));

  test("grants bounded local engineering autonomy under UOM §15.7 / C1.ENG-1", () => {
    for (const phrase of [
      "## Local engineering autonomy (UOM v1.7.9 §15.7 / C1 rev5.10 §C1.ENG-1)",
      "make ordinary forward-only **local** commits across that Packet's whole in-scope area, without per-edit or per-command owner approval",
      "Correct your own in-scope mistakes and re-test within scope on your own",
      "the verified immutable Packet blob, the `BRANCH`/`BASE_SHA` binding, `ALLOWED_SCOPE` minus `FORBIDDEN_SCOPE` (FORBIDDEN wins)",
    ]) {
      assert.ok(text.includes(phrase), phrase);
    }
  });

  test("separates publication, PR and merge from implementation", () => {
    for (const phrase of [
      "It is **not** authority to publish, push, open or merge a PR, change CI, protection or workflows, or touch any remote or database system.",
      "Pushing those commits to `origin` is a distinct, separately owner-authorized publication gate: do not push on your own at the end of implementation",
      "Running this self-check is part of finishing implementation; it is not permission to publish.",
      "Never create, edit, mark ready, review, approve or merge a pull request",
    ]) {
      assert.ok(text.includes(phrase), phrase);
    }
    // Obsolete standing push-on-completion instructions are gone.
    for (const obsolete of [
      "Push only to `origin` (the Builder fork), only your work-item branch. Then report the branch URL and head SHA.",
      "implement, test, fix and publish one approved work item",
      "## Self-check before every push",
      "fix it, re-test, push a new commit",
    ]) {
      assert.ok(!text.includes(obsolete), obsolete);
    }
  });

  test("treats effective denies as authorization limits with no concealed route", () => {
    for (const phrase of [
      "The grant never overrides an effective tool deny.",
      "do not reach the denied result through Shell redirection, an alternate interpreter, another worktree, a different tool or another identity",
      "**Effective deny rules prevail.**",
      "Never take a concealed alternative route.",
    ]) {
      assert.ok(text.includes(phrase), phrase);
    }
  });

  test("preserves Packet, migration, secret, guard and failure-class safeguards", () => {
    for (const phrase of [
      "Order: locked Rosuno authority → the Packet for this branch → code.",
      "Every commit is checked on its own, not just the final result",
      "Never modify, delete or rename an existing migration.",
      "Never print any variable's value.",
      "`bash .github/scripts/rosuno-guard.sh <BASE_SHA from the Packet> HEAD <branch> refs/rosuno/approved`",
      "Never weaken a test, RLS policy, constraint or check to make something pass.",
      "(no amend, rebase, squash, merge commits or force push)",
    ]) {
      assert.ok(text.includes(phrase), phrase);
    }
  });
});

describe("P2-916 unchanged protected controls", () => {
  test("guard, trust binding and workflow are byte-identical to Owner main", () => {
    assert.equal(gitBlobId(readFileSync(GUARD)), OWNER_MAIN_GUARD_BLOB);
    assert.equal(gitBlobId(readFileSync(TRUST)), OWNER_MAIN_TRUST_BLOB);
    assert.equal(gitBlobId(readFileSync(WORKFLOW)), OWNER_MAIN_WORKFLOW_BLOB);
  });

  test("the adopted Packet allows exactly the three P2-916 paths", () => {
    const packet = readFileSync(PACKET, "utf8");
    const header = packet.slice(0, packet.indexOf("\n# "));
    assert.match(header, /^TYPE: PROCESS$/m);
    assert.match(header, /^MIGRATIONS: none$/m);
    assert.match(header, new RegExp(`^BRANCH: ${BRANCH}$`, "m"));
    assert.match(header, new RegExp(`^BASE_SHA: ${OWNER_MAIN}$`, "m"));
    const allowed = header
      .slice(
        header.indexOf("ALLOWED_SCOPE:\n") + 15,
        header.indexOf("FORBIDDEN_SCOPE:"),
      )
      .trim()
      .split("\n");
    assert.deepEqual(allowed, [
      "- CLAUDE.md",
      "- .claude/settings.json",
      `- ${TEST_PATH}`,
    ]);
    for (const forbidden of [
      ".github/*",
      "supabase/*",
      "tools/p0/lib/*",
      "tools/p0/tests/p0-controls.test.mjs",
      "governance/*",
    ]) {
      assert.ok(header.includes(`\n- ${forbidden}\n`), forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// Genuine guard outcomes on synthetic disposable histories.

const SANDBOX = mkdtempSync(path.join(tmpdir(), "rosuno-p2-916-"));
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
let clock = 1_794_268_800; // 2026-11-09T00:00:00Z

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
    // delete, or { mode, content }) entirely through Git plumbing.
    child(parents, changes, message = "fixture") {
      const files = new Map(parents.length ? tracked.get(parents[0]) : []);
      for (const [file, change] of Object.entries(changes)) {
        if (change === null) {
          files.delete(file);
          continue;
        }
        const { mode = "100644", content } =
          typeof change === "string" ? { content: change } : change;
        files.set(file, {
          mode,
          oid: git(["hash-object", "-w", "--stdin"], content),
        });
      }
      rmSync(index, { force: true });
      execFileSync("git", ["update-index", "--index-info"], {
        cwd: dir,
        env: { ...env, GIT_INDEX_FILE: index },
        input: [...files]
          .map(([file, { mode, oid }]) => `${mode} ${oid}\t${file}\n`)
          .join(""),
      });
      const tree = execFileSync("git", ["write-tree"], {
        cwd: dir,
        env: { ...env, GIT_INDEX_FILE: index },
        encoding: "utf8",
      }).trim();
      clock += 60;
      const ident = `P2-916 Fixture <fixture@example.invalid> ${clock} +0000`;
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

const HISTORICAL_MIGRATION =
  "supabase/migrations/20260101000000_historical_fixture.sql";
const BASE_FILES = {
  "README.md": "Disposable P2-916 guard fixture.\n",
  "CLAUDE.md": "# fixture instructions\n",
  ".claude/settings.json": '{ "permissions": { "deny": [] } }\n',
  ".github/scripts/rosuno-guard.sh": "# guard stand-in\n",
  ".github/workflows/rosuno-guard.yml": "name: stand-in\n",
  "apps/web/src/page.ts": "export const page = 1;\n",
  "governance/decision-log.json": '{ "decisions": [] }\n',
  "tools/p0/lib/controls.mjs": "export const controls = 1;\n",
  "tools/p0/tests/p0-controls.test.mjs": "// stand-in\n",
  [HISTORICAL_MIGRATION]: "select 1;\n",
};
const ADOPTED = readFileSync(PACKET, "utf8");

// The adopted P2-916 V2 Packet header rebased onto a disposable owner main.
function fixture() {
  const repo = createRepo();
  const base = repo.child([], BASE_FILES, "owner main");
  const packetFor = (overrides = {}) => {
    let text = ADOPTED.replace(
      new RegExp(`^BASE_SHA: ${OWNER_MAIN}$`, "m"),
      `BASE_SHA: ${overrides.base ?? base}`,
    );
    if (overrides.type) {
      text = text.replace(/^TYPE: PROCESS$/m, `TYPE: ${overrides.type}`);
    }
    return text;
  };
  let approvals = 0;
  return {
    repo,
    base,
    run({
      steps = [],
      packet = packetFor(),
      approval = packet,
      packetExtra = {},
      branch = BRANCH,
      from = base,
      guardBase = base,
      withPacket = true,
    } = {}) {
      let tip = from;
      if (withPacket) {
        tip = repo.child(
          [tip],
          { [PACKET_PATH]: packet, ...packetExtra },
          "Packet",
        );
      }
      for (const step of steps) {
        tip =
          typeof step === "function"
            ? step(tip)
            : repo.child([tip], step, "implementation");
      }
      approvals += 1;
      const approvedRef = `refs/fixture/approved-${approvals}`;
      repo.ref(
        approvedRef,
        approval === null
          ? base
          : repo.child([base], { [PACKET_PATH]: approval }, "owner approval"),
      );
      const result = spawnSync(
        "bash",
        [GUARD, guardBase, tip, branch, approvedRef],
        { cwd: repo.dir, env: repo.env, encoding: "utf8", timeout: 60_000 },
      );
      if (result.error) throw result.error;
      return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
        stdout: result.stdout,
        packet,
      };
    },
    packetFor,
  };
}

function assertPass(result) {
  assert.equal(result.status, 0, result.output);
  assert.match(
    result.stdout,
    new RegExp(
      `^ROSUNO-GUARD PASS work_item=P2-916 packet_sha256=${sha256(result.packet)} `,
      "m",
    ),
  );
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

const THREE_FILES = {
  "CLAUDE.md": "# updated fixture instructions\n",
  ".claude/settings.json":
    '{ "permissions": { "deny": ["Bash(git push*)"] } }\n',
  [TEST_PATH]: "// fixture regression test\n",
};

describe("P2-916 genuine guard outcomes on synthetic histories", () => {
  test("the exact three-path change passes, in one or several linear commits", () => {
    const f = fixture();
    assertPass(f.run({ steps: [THREE_FILES] }));
    assertPass(
      f.run({
        steps: [
          { "CLAUDE.md": THREE_FILES["CLAUDE.md"] },
          { ".claude/settings.json": THREE_FILES[".claude/settings.json"] },
          { [TEST_PATH]: THREE_FILES[TEST_PATH] },
        ],
      }),
    );
    assertPass(f.run({ steps: [] }));
  });

  test("missing, altered or unapproved Packet provenance fails", () => {
    const f = fixture();
    assertRejected(
      f.run({ withPacket: false, steps: [THREE_FILES] }),
      `Packet ${PACKET_PATH} missing at head or not a regular file`,
    );
    assertRejected(
      f.run({ approval: `${f.packetFor()}altered\n`, steps: [THREE_FILES] }),
      `Packet differs from the owner-approved Packet on owner branch ${BRANCH}`,
    );
    assertRejected(
      f.run({ approval: null, steps: [THREE_FILES] }),
      `owner branch ${BRANCH} has no ${PACKET_PATH}`,
    );
    assertRejected(
      f.run({
        steps: [THREE_FILES, { [PACKET_PATH]: `${f.packetFor()}edited\n` }],
      }),
      "Packet changed after it was added (re-audit required)",
    );
  });

  test("wrong branch or base fails", () => {
    const f = fixture();
    assertRejected(
      f.run({
        branch: "wi/P2-916-builder-runtime-commissioning",
        steps: [THREE_FILES],
      }),
      "does not match the PR head branch",
    );
    const later = f.repo.child([f.base], { "README.md": "later\n" }, "main 2");
    assertRejected(
      f.run({ packet: f.packetFor({ base: later }), steps: [THREE_FILES] }),
      `Packet BASE_SHA ${later} is not the parent of the Packet commit`,
    );
  });

  test("out-of-scope and forbidden paths fail", () => {
    const f = fixture();
    const reject = (changes, ...expected) =>
      assertRejected(f.run({ steps: [THREE_FILES, changes] }), ...expected);
    reject(
      { "apps/web/src/page.ts": "export const page = 2;\n" },
      "apps/web/src/page.ts (M) is inside FORBIDDEN_SCOPE",
      "apps/web/src/page.ts (M) is outside ALLOWED_SCOPE",
    );
    reject(
      { ".github/workflows/rosuno-guard.yml": "name: changed\n" },
      ".github/workflows/rosuno-guard.yml (M) is inside FORBIDDEN_SCOPE",
    );
    reject(
      { ".github/scripts/rosuno-guard.sh": "# changed\n" },
      ".github/scripts/rosuno-guard.sh (M) is inside FORBIDDEN_SCOPE",
    );
    reject(
      { "tools/p0/lib/controls.mjs": "export const controls = 2;\n" },
      "tools/p0/lib/controls.mjs (M) is inside FORBIDDEN_SCOPE",
    );
    reject(
      { "tools/p0/tests/p0-controls.test.mjs": "// changed\n" },
      "tools/p0/tests/p0-controls.test.mjs (M) is inside FORBIDDEN_SCOPE",
    );
    reject(
      { "governance/decision-log.json": "{}\n" },
      "governance/decision-log.json (M) is inside FORBIDDEN_SCOPE",
    );
    reject(
      { ".claude/settings.local.json": "{}\n" },
      ".claude/settings.local.json (A) is outside ALLOWED_SCOPE",
    );
    reject(
      { "tools/p0/tests/other.test.mjs": "// other\n" },
      "tools/p0/tests/other.test.mjs (A) is outside ALLOWED_SCOPE",
    );
  });

  test("case aliases, symlinks and secret-like files fail", () => {
    const f = fixture();
    const reject = (changes, ...expected) =>
      assertRejected(f.run({ steps: [THREE_FILES, changes] }), ...expected);
    reject(
      { "Claude.md": "# alias\n" },
      "case-insensitive path collision: claude.md",
    );
    reject(
      { "CLAUDE.md": null, "claude.md": "# replaced\n" },
      "case-only change of an existing base path: CLAUDE.md -> claude.md",
    );
    reject(
      { [TEST_PATH]: { mode: "120000", content: "../../../CLAUDE.md" } },
      `${TEST_PATH} has git mode 120000`,
    );
    reject(
      { ".claude/settings.json": { mode: "120000", content: "../.env" } },
      ".claude/settings.json has git mode 120000",
    );
    reject(
      { ".env": "FIXTURE=placeholder\n" },
      ".env looks like a secret/credential file",
    );
  });

  test("historical and new migrations fail", () => {
    const f = fixture();
    assertRejected(
      f.run({
        steps: [THREE_FILES, { [HISTORICAL_MIGRATION]: "select 2;\n" }],
      }),
      `existing migration ${HISTORICAL_MIGRATION} changed or aliased (status M; forward-only)`,
    );
    assertRejected(
      f.run({ steps: [THREE_FILES, { [HISTORICAL_MIGRATION]: null }] }),
      `existing migration ${HISTORICAL_MIGRATION} changed or aliased (status D; forward-only)`,
    );
    const added = "supabase/migrations/20261109000000_p2_916.sql";
    assertRejected(
      f.run({ steps: [THREE_FILES, { [added]: "select 1;\n" }] }),
      `new migration ${added} but Packet says MIGRATIONS: none`,
      `${added} (A) is inside FORBIDDEN_SCOPE`,
    );
  });

  test("a forbidden change later reverted still fails per commit", () => {
    const f = fixture();
    const result = f.run({
      steps: [
        { "apps/web/src/page.ts": "export const page = 2;\n" },
        { "apps/web/src/page.ts": "export const page = 1;\n" },
        THREE_FILES,
      ],
    });
    assertRejected(
      result,
      /\[commit [0-9a-f]{12}\] apps\/web\/src\/page\.ts \(M\) is outside ALLOWED_SCOPE/,
    );
    assert.doesNotMatch(result.output, /\[final diff\]/);
  });

  test("non-linear history fails (no merge commits on the branch)", () => {
    const f = fixture();
    const merge = (tip) => {
      const side = f.repo.child([tip], THREE_FILES, "side");
      return f.repo.child([tip, side], THREE_FILES, "merge");
    };
    assertRejected(
      f.run({ steps: [merge] }),
      /merge commit [0-9a-f]{40} on the branch \(linear history required\)/,
    );
  });

  test("a non-PROCESS Packet cannot rewrite CLAUDE.md or Claude settings", () => {
    const f = fixture();
    const feature = f.packetFor({ type: "FEATURE" });
    assertRejected(
      f.run({
        packet: feature,
        steps: [{ "CLAUDE.md": "# self-rewrite\n" }],
      }),
      "CLAUDE.md is process/kit scope; requires a TYPE: PROCESS work item",
    );
    assertRejected(
      f.run({
        packet: feature,
        steps: [{ ".claude/settings.json": '{ "permissions": {} }\n' }],
      }),
      ".claude/settings.json is process/kit scope; requires a TYPE: PROCESS work item",
    );
  });
});
