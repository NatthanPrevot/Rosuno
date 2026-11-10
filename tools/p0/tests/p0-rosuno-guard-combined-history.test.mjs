// P2-914 and P2-915: regression coverage for the trusted rosuno-guard's one-time
// combined P3-003/P3-904 history (adopted P2-914 Packet §3, §4, §6) and for the
// narrowly bounded P3-904 recovery accommodation (adopted P2-915 REV4 Packet
// §3-§6): the single permitted edit of the one P3-904 migration, the final
// three-path administrative registration commit, P2-915 protected-merge
// provenance and the separately GitHub-authenticated owner approval comment.
//
// Every scenario runs the real .github/scripts/rosuno-guard.sh in a disposable
// local Git repository. The guard pins immutable P3-003 and P3-904 objects by
// SHA. Those objects are not part of every checkout (owner approval commits
// live only in the owner repository), so disposable repositories supply fixture
// stand-ins under the exact pinned names through Git replace refs
// (refs/replace/<pinned-sha>). The guard then resolves every pinned identity
// exactly as written. Replace refs exist only inside these disposable
// repositories; the trusted workflow's fetches name explicit refspecs, none
// under refs/replace/ (asserted below). A separate test runs the guard against
// the genuine pinned history when those objects are locally available.
//
// GitHub API responses are SIMULATED by a disposable fake `gh` placed first on
// PATH; it serves fixture JSON for exactly the guard's read-only endpoints and
// refuses anything else, so no fixture can reach GitHub. Simulated responses
// prove only the guard's local decision logic. They do not prove that the
// protected workflow token can read issue comments, that GitHub pagination or
// comment metadata behave as simulated, or that an owner-triggered same-head
// rerun evaluates a new approval; those require the separately authorized
// genuine protected-workflow integration gate (P2-915 Packet §5, §6).
//
// A structural guard PASS proves Git history, Packet, scope and approval-binding
// boundaries only. It is never P3-904 security acceptance, CI success,
// Independent Backup review, designated human approval, Gate 4 approval
// validity or merge authorization; those remain separate, mandatory gates.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, test } from "node:test";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const GUARD = path.join(ROOT, ".github/scripts/rosuno-guard.sh");
const TRUST = path.join(ROOT, ".github/scripts/rosuno-guard-trust.sh");
const WORKFLOW = path.join(ROOT, ".github/workflows/rosuno-guard.yml");
const PACKET = path.join(ROOT, "docs/work-items/P2-914/PACKET.md");
const P2915_PACKET = path.join(ROOT, "docs/work-items/P2-915/PACKET.md");

// Exact immutable P3-003 identities from the adopted P2-914 Packet §2.
const ORIGINAL_BASE = "8449593d0baccac377f4884ede522d00fa1cc997";
const OWNER_PACKET_COMMIT = "ae9c644967c702972f8c14a964d78e4bb4c2a83b";
const BUILDER_PACKET_COMMIT = "405956f9f4a14432a12fc7eacb10e33c0278e39d";
const ORIGINAL_PACKET_BLOB = "c394078a7440d5e48bce81c33d7a581d951d1c74";
const ORIGINAL_TREE = "c9823d197923c17c146bdc10b0ec47a1cc8564c0";
const ORIGINAL_COMMITS = [
  "77b29508b1ed9c5a8e79c352be04016d956e30d4",
  "ac9c5feba15a4f2453ebbca907ecdac372a55f32",
  "4e548818d38f86f18fadcc3072293be58493d679",
  "9cedce919b05288800574d0c96049415c892926d",
  "4425c5f5f3be59bdb08b14c20eb4afa5f6701893",
  "ba6fc7888ea842b89d70e44cee62203af68c52fd",
  "4d22a2b2c8916e01da24227e7f5b1235b3de1ebe",
  "b3fda55231625d440f3aa536e36c30e1dbb5b94a",
];
const ORIGINAL_HEAD = ORIGINAL_COMMITS[7];
const ORIGINAL_BRANCH = "wi/P3-003-attorney-trust-professional-setup";
const CORRECTION_BRANCH = "wi/P3-904-p3-003-security-correction";
const ORIGINAL_APPROVAL_REF = "refs/rosuno/p3-003-approved";
const P3_003_PACKET_PATH = "docs/work-items/P3-003/PACKET.md";
const P3_904_PACKET_PATH = "docs/work-items/P3-904/PACKET.md";
const HISTORICAL_MIGRATION =
  "supabase/migrations/20260101000000_historical_baseline.sql";
const HISTORICAL_MIGRATION_ID = "20260101000000_historical_baseline";

// Exact P2-915 identities from the adopted P2-915 REV4 Packet §2, §4 and §5.
const P3904_PACKET_COMMIT = "b90c1ca17daaaae10b63c70acc31842efc673d87";
const P3904_PACKET_BLOB = "b4b6fc9f080f28b3a385ad09f3431c9a8c3f2bba";
const P3904_PACKET_SHA256 =
  "ba9783cd7a4125993f7107373ba7264259a02be51fe437fcbcdc35cd43dcbcbd";
const P3904_COMMITS = [
  "2cfd62900f3d4281fb813f9e1ceac4cafc6d226e",
  "90ef51fcaac6d5737ed41cd4465dc99bcb7c9898",
  "1c4acec9df60fa0c59f8bd61e8053d744ed36478",
];
const P3904_HEAD = P3904_COMMITS[2];
const P3904_PINNED = [P3904_PACKET_COMMIT, ...P3904_COMMITS];
const P3904_TREE = "c585ff8046e69278c4c8b0cce868c1a469019f28";
const P3904_MIGRATION =
  "supabase/migrations/20261106090000_p3_904_professional_write_boundary.sql";
const P3904_MIGRATION_ID = "20261106090000_p3_904_professional_write_boundary";
const P3904_MIGRATION_BLOB = "d54a86e20f57bde5c09f38bdc2d95ecc8b28391c";
const P3904_MIGRATION_SHA256 =
  "16c57427fb59fb66c789f1a2e8036ddc3d8063ff8e8c694c8adea202b42f6b77";
const P2915_PACKET_COMMIT = "4daf4fa10924dee60567f8403e0356e2f16b186f";
const P2915_PACKET_PATH = "docs/work-items/P2-915/PACKET.md";
const P2915_PACKET_BLOB = "c02a8740944c2dbf418609e55d99301c87270331";
const P2915_PACKET_SHA256 =
  "894e17a636dfe3c21b68cf132ba3146a9d941e8e963c1b122b2111cf7dfc3d77";
const P2915_BRANCH = "wi/P2-915-p3-904-correction-integration";
const GOVERNANCE = {
  register: "governance/migrations/reviewed-migrations.json",
  workItems: "governance/work-items/index.json",
  decisions: "governance/decision-log.json",
};
const OWNER_REPOSITORY = "NatthanPrevot/Rosuno";
const OWNER_LOGIN = "NatthanPrevot";
const BUILDER_REPOSITORY = "RosunoBackup/Rosuno";
const APPROVAL_MARKER = "ROSUNO-P2-915-P3-904-GOVERNANCE-APPROVAL-V1";
const REVOCATION_MARKER = "ROSUNO-P2-915-P3-904-GOVERNANCE-REVOCATION-V1";
const APPROVAL_SCOPE =
  "pending-unapplied-unreleased-registration-of-exactly-these-three-governance-paths";
// Synthetic fixture identities only. The owner's real numeric GitHub user ID is
// not pinned; the guard resolves it from the GitHub API at run time.
const FIXTURE_OWNER_ID = 900000001;
const PR = 7;

// Protected Owner main at P2-915 Packet preparation (P2-915 Packet §2) and the
// exact trusted files it carries.
const OWNER_MAIN = "b003c23475b8fd22c2ad7496df51923c5d3fa6e3";
const OWNER_MAIN_GUARD_BLOB = "2dad1d6e866684d1d6f3422f413779b061594559";
const OWNER_MAIN_GUARD_SHA256 =
  "36ba290f243de9bf8f87217ae45644f92d45bc3aaad1608b678f4ddcfb8900dc";
const OWNER_MAIN_WORKFLOW_BLOB = "6c64a49d270f3ab81b2272b0a30ff163e32703ec";
const OWNER_MAIN_TRUST_BLOB = "d6a16c8db64a95f47916323f90ef06f294190457";
// SHA-256 of the Owner-main guard text before its P2-914 combined section: the
// header and the complete ordinary normal_guard, which P2-915 must not change.
const NORMAL_GUARD_PREFIX_SHA256 =
  "b6939e550997598175c732440306b85ca00422b3a899996d4d0696715ee403b9";
const COMBINED_SECTION_START = "# P2-914: immutable, one-time combined";

const ORDINARY_BRANCH = "wi/P9-914-guard-ordinary";
const ORDINARY_PACKET_PATH = "docs/work-items/P9-914/PACKET.md";

const SANDBOX = mkdtempSync(path.join(tmpdir(), "rosuno-p2-915-guard-"));
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

const MERGE_SIDE = Symbol("merge a side branch");
const MERGE_MAIN = Symbol("merge owner main");
const mergeSide = (changes) => ({ [MERGE_SIDE]: changes });
const mergeMain = () => ({ [MERGE_MAIN]: true });
const commitLabel = (sha) => `[commit ${sha.slice(0, 12)}]`;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const gitBlobId = (bytes) =>
  createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");

// Disposable fake GitHub CLI: answers only exact read-only `gh api` requests
// from a per-run fixture file and logs every invocation. Anything else, or a
// missing fixture, fails like an unavailable API.
const FAKE_BIN = path.join(SANDBOX, "fake-bin");
mkdirSync(FAKE_BIN);
writeFileSync(
  path.join(FAKE_BIN, "gh"),
  `#!${process.execPath}
"use strict";
const fs = require("fs");
const args = process.argv.slice(2);
const fixturePath = process.env.FAKE_GH_FIXTURE;
if (!fixturePath) {
  process.stderr.write("fake gh: no fixture (API unavailable)\\n");
  process.exit(1);
}
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
fs.appendFileSync(
  fixture.log,
  JSON.stringify({ args, hasToken: Boolean(process.env.GH_TOKEN) }) + "\\n",
);
const paginate = args.includes("--paginate");
const rest = args.filter((arg) => arg !== "--paginate");
if (rest.length !== 2 || rest[0] !== "api" || rest[1].startsWith("-")) {
  process.stderr.write("fake gh: refused non-read-only invocation\\n");
  process.exit(2);
}
const route = fixture.routes[rest[1]];
if (!route) {
  process.stderr.write("HTTP 404: Not Found (fixture)\\n");
  process.exit(1);
}
if (route.paginate !== paginate) {
  process.stderr.write("fake gh: unexpected pagination mode\\n");
  process.exit(2);
}
let out = "";
for (const [index, page] of route.pages.entries()) {
  if (route.failAtPage === index) {
    process.stdout.write(out);
    process.stderr.write("HTTP " + (route.status || 502) + ": fixture failure\\n");
    process.exit(1);
  }
  out += (typeof page === "string" ? page : JSON.stringify(page)) + (route.separator || "");
}
process.stdout.write(out);
`,
  { mode: 0o755 },
);

// Git sees no user, global or system configuration, never prompts, and may
// only use local file transport, so no fixture can reach a hosted system. The
// fake gh shadows any real GitHub CLI for every guard run.
function fixtureEnv() {
  return {
    PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH ?? ""}`,
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

let repositoryCount = 0;
let clock = 1_793_836_800; // 2026-11-05T00:00:00Z; every commit advances it.

function createRepo(label, { bare = false } = {}) {
  repositoryCount += 1;
  const name = `${String(repositoryCount).padStart(3, "0")}-${label}`;
  const dir = path.join(SANDBOX, name);
  const index = path.join(SANDBOX, `${name}.index`);
  mkdirSync(dir);
  const env = fixtureEnv();
  const tracked = new Map();
  const git = (args, { input, extraEnv } = {}) =>
    execFileSync("git", args, {
      cwd: dir,
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      input,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).trimEnd();
  git(["init", "-q", ...(bare ? ["--bare"] : []), "-b", "main"]);

  const repo = {
    dir,
    env,
    git,
    blob: (content) =>
      git(["hash-object", "-w", "--stdin"], { input: content }),
    tree(entries) {
      rmSync(index, { force: true });
      const extraEnv = { GIT_INDEX_FILE: index };
      const lines = [...entries]
        .map(([file, { mode, oid }]) => `${mode} ${oid}\t${file}\n`)
        .join("");
      git(["update-index", "--index-info"], { input: lines, extraEnv });
      return git(["write-tree", "--missing-ok"], { extraEnv });
    },
    // Writes the commit object directly so its tree and parents may be
    // pinned names that resolve only through replace refs.
    commit(tree, parents, message) {
      clock += 60;
      const ident = `Rosuno Fixture <fixture@example.invalid> ${clock} +0000`;
      const body = [
        `tree ${tree}`,
        ...parents.map((parent) => `parent ${parent}`),
        `author ${ident}`,
        `committer ${ident}`,
        "",
        message,
        "",
      ].join("\n");
      return git(["hash-object", "-t", "commit", "-w", "--stdin"], {
        input: body,
      });
    },
    pin: (pinned, oid) => git(["update-ref", `refs/replace/${pinned}`, oid]),
    ref: (ref, oid) => git(["update-ref", ref, oid]),
    filesOf(commit) {
      assert.ok(tracked.has(commit), `untracked fixture commit ${commit}`);
      return tracked.get(commit);
    },
    // Tracks an existing (for example genuine) commit's files for children.
    adopt(commit) {
      const files = new Map();
      for (const entry of git(["ls-tree", "-r", "-z", commit])
        .split("\0")
        .filter(Boolean)) {
        const tab = entry.indexOf("\t");
        const [mode, , oid] = entry.slice(0, tab).split(" ");
        files.set(entry.slice(tab + 1), { mode, oid });
      }
      tracked.set(commit, files);
      return commit;
    },
    // Commits the first parent's tree plus `changes` (path -> text, null to
    // delete, or { mode, content | oid }). With pinAs the commit is published
    // under that pinned name; with treeAs its tree is.
    child(parents, changes, message, { pinAs, treeAs } = {}) {
      const files = new Map(parents.length ? repo.filesOf(parents[0]) : []);
      for (const [file, change] of Object.entries(changes)) {
        if (change === null) {
          assert.ok(files.delete(file), `fixture deletes absent ${file}`);
        } else if (typeof change === "string") {
          files.set(file, { mode: "100644", oid: repo.blob(change) });
        } else {
          files.set(file, {
            mode: change.mode ?? "100644",
            oid: change.oid ?? repo.blob(change.content),
          });
        }
      }
      let tree = repo.tree(files);
      if (treeAs) {
        repo.pin(treeAs, tree);
        tree = treeAs;
      }
      let commit = repo.commit(tree, parents, message);
      if (pinAs) {
        repo.pin(pinAs, commit);
        commit = pinAs;
      }
      tracked.set(commit, files);
      return commit;
    },
    root: (files, message, options) => repo.child([], files, message, options),
  };
  return repo;
}

function runGuard(repo, args, extraEnv = {}, guard = GUARD) {
  const env = { ...repo.env, ...extraEnv };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  const result = spawnSync("bash", [guard, ...args], {
    cwd: repo.dir,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}${result.stderr}`,
    calls: [],
  };
}

const passLines = (output) =>
  output.split("\n").filter((line) => /ROSUNO-GUARD (?:PASS|AUDIT)/.test(line));

// Fail closed: exit 1, at least one diagnostic, every expected diagnostic, and
// no PASS or AUDIT line of any kind.
function assertRejected(result, ...expected) {
  const context = `exit ${result.status}\n${result.output}`;
  assert.equal(result.status, 1, context);
  assert.deepEqual(passLines(result.output), [], context);
  assert.match(result.output, /::error::/, context);
  for (const item of expected) {
    if (item instanceof RegExp) assert.match(result.output, item, context);
    else
      assert.ok(result.output.includes(item), `missing: ${item}\n${context}`);
  }
}

function packetText({
  id,
  type,
  branch,
  base,
  migrations,
  allowed,
  forbidden,
}) {
  return [
    `WORK_ITEM: ${id}`,
    `TYPE: ${type}`,
    `BRANCH: ${branch}`,
    `BASE_SHA: ${base}`,
    `MIGRATIONS: ${migrations}`,
    "ALLOWED_SCOPE:",
    ...allowed.map((glob) => `- ${glob}`),
    "FORBIDDEN_SCOPE:",
    ...forbidden.map((glob) => `- ${glob}`),
    "",
    `# ${id} disposable guard fixture Packet`,
    "",
  ].join("\n");
}

// Stand-in content for the pinned original Packet blob. Its boundary mirrors
// the original P3-003 Packet: application paths only, MIGRATIONS: none.
const P3_003_FIXTURE_PACKET = packetText({
  id: "P3-003",
  type: "FEATURE",
  branch: ORIGINAL_BRANCH,
  base: ORIGINAL_BASE,
  migrations: "none",
  allowed: [
    "apps/web/app/attorney/*",
    "apps/web/app/staff/*",
    "apps/web/src/application/attorney-*",
    "apps/web/src/application/professional-*",
    "apps/web/src/application/verification-*",
    "apps/web/src/infrastructure/attorney/*",
    "apps/web/src/presentation/*",
    "apps/web/tests/*",
  ],
  forbidden: [
    "rosuno-authority/*",
    "docs/work-items/*",
    "docs/process/*",
    "governance/*",
    "supabase/*",
    ".github/*",
    ".claude/*",
    "CLAUDE.md",
    "tools/*",
    "package.json",
    ".env",
    ".env.*",
    ".gitmodules",
  ],
});

// Stand-in content for the pinned P3-904 Packet blob; the adopted P3-904
// Packet, not this fixture, determines the real correction scope.
function p3904Packet(overrides = {}) {
  return packetText({
    id: "P3-904",
    type: "FIX",
    branch: CORRECTION_BRANCH,
    base: ORIGINAL_HEAD,
    migrations: "new allowed",
    allowed: [
      "apps/web/src/application/attorney-*",
      "apps/web/src/infrastructure/attorney/*",
      "apps/web/tests/*",
      "supabase/migrations/*",
    ],
    forbidden: [
      "rosuno-authority/*",
      "docs/work-items/*",
      "docs/process/*",
      "governance/*",
      ".github/*",
      ".claude/*",
      "CLAUDE.md",
      "apps/web/app/*",
      "supabase/config.toml",
      "supabase/seed.sql",
      "package.json",
      ".env",
      ".env.*",
      ".gitmodules",
    ],
    ...overrides,
  });
}

// Governance register stand-ins with the canonical shape: one top-level array
// of records, two-space JSON, appended records inserted before the final "]".
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const BASE_REGISTER = {
  version: 1,
  product_migrations_present: true,
  migrations: [
    {
      migration_id: HISTORICAL_MIGRATION_ID,
      migration_kind: "product",
      sequence: 1,
      artifact_path: HISTORICAL_MIGRATION,
      authority_refs: ["FIXTURE-AUTHORITY"],
      work_item_refs: ["WI-P0-001-FIXTURE"],
      decision_refs: ["DEC-20260101-FIXTURE"],
      release_refs: ["REL-20260101-FIXTURE"],
      reviewed: true,
      reviewed_by: "Fixture Reviewer",
      reviewed_at: "2026-01-01T00:00:00Z",
      applied_environment: "staging",
      non_production_validation: true,
      drift_check: "clean",
      rollback_plan: "Fixture rollback plan.",
      depends_on: [],
    },
  ],
};
const BASE_WORK_ITEMS = {
  version: 1,
  work_items: [
    {
      work_item_id: "WI-P0-001-FIXTURE",
      title: "Historical fixture work item",
      decision_refs: ["DEC-20260101-FIXTURE"],
      migration_refs: [HISTORICAL_MIGRATION_ID],
      release_refs: ["REL-20260101-FIXTURE"],
    },
  ],
};
const BASE_DECISIONS = {
  version: 1,
  decisions: [
    {
      decision_id: "DEC-20260101-FIXTURE",
      title: "Historical fixture decision",
      work_item_refs: ["WI-P0-001-FIXTURE"],
    },
  ],
};
const BASE_GOVERNANCE = {
  register: json(BASE_REGISTER),
  workItems: json(BASE_WORK_ITEMS),
  decisions: json(BASE_DECISIONS),
};
const ADMIN_WORK_ITEM_ID = "WI-P2-999-P3-904-FIXTURE-REGISTRATION";
const ADMIN_DECISION_ID = "DEC-20261108-P3-904-FIXTURE-REGISTRATION";

// Appends one record textually, preserving every existing byte except the
// comma after the previous last record (the canonical append-only change).
function appendRecord(text, record) {
  const closing = "\n  ]\n}\n";
  assert.ok(text.endsWith(closing), "register fixture ends with its array");
  const body = JSON.stringify(record, null, 2)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return `${text.slice(0, -closing.length)},\n${body}${closing}`;
}

const candidateMigration = (overrides = {}) => ({
  migration_id: P3904_MIGRATION_ID,
  migration_kind: "product",
  sequence: 2,
  artifact_path: P3904_MIGRATION,
  authority_refs: ["FIXTURE-AUTHORITY"],
  work_item_refs: [ADMIN_WORK_ITEM_ID],
  decision_refs: [ADMIN_DECISION_ID],
  release_refs: [],
  reviewed: false,
  reviewed_by: "pending designated human PR review",
  reviewed_at: null,
  applied_environment: "none",
  non_production_validation: true,
  drift_check: "pending",
  rollback_plan: "Fixture forward-only rollback plan.",
  depends_on: [HISTORICAL_MIGRATION_ID],
  ...overrides,
});
const candidateWorkItem = (overrides = {}) => ({
  work_item_id: ADMIN_WORK_ITEM_ID,
  title: "Fixture administrative registration of the P3-904 correction",
  decision_refs: [ADMIN_DECISION_ID],
  migration_refs: [P3904_MIGRATION_ID],
  release_refs: [],
  ...overrides,
});
const candidateDecision = (overrides = {}) => ({
  decision_id: ADMIN_DECISION_ID,
  title: "Fixture decision for the P3-904 registration",
  work_item_refs: [ADMIN_WORK_ITEM_ID],
  ...overrides,
});

// The three administrative registration files (one appended record each).
function registration({
  migration = {},
  workItem = {},
  decision = {},
  base = BASE_GOVERNANCE,
} = {}) {
  return {
    [GOVERNANCE.register]: appendRecord(
      base.register,
      candidateMigration(migration),
    ),
    [GOVERNANCE.workItems]: appendRecord(
      base.workItems,
      candidateWorkItem(workItem),
    ),
    [GOVERNANCE.decisions]: appendRecord(
      base.decisions,
      candidateDecision(decision),
    ),
  };
}

const BASE_FILES = {
  "README.md": "Disposable stand-in for the original P3-003 base tree.\n",
  "apps/web/app/page.tsx": "export default function Home() { return null; }\n",
  "apps/web/src/application/attorney-access.ts": "export const access = 1;\n",
  "apps/web/tests/Fixtures/legacy.txt": "legacy fixture\n",
  "apps/web/tests/m4-db-proof.mjs": "// fixture: existing DB proof\n",
  [HISTORICAL_MIGRATION]: "-- historical migration fixture\nselect 1;\n",
  [GOVERNANCE.register]: BASE_GOVERNANCE.register,
  [GOVERNANCE.workItems]: BASE_GOVERNANCE.workItems,
  [GOVERNANCE.decisions]: BASE_GOVERNANCE.decisions,
};

const ORIGINAL_CHANGES = [
  { "apps/web/app/attorney/setup/page.tsx": "export const setup = 1;\n" },
  { "apps/web/src/application/attorney-trust.ts": "export const trust = 0;\n" },
  {
    "apps/web/src/application/professional-profile.ts": "export const p = 1;\n",
  },
  {
    "apps/web/src/infrastructure/attorney/trust-store.ts":
      "export const s = 1;\n",
  },
  { "apps/web/app/staff/verification/page.tsx": "export const staff = 1;\n" },
  {
    "apps/web/src/application/verification-review.ts": "export const r = 1;\n",
  },
  {
    "apps/web/src/presentation/attorney-setup-view.tsx":
      "export const v = 1;\n",
  },
  { "apps/web/tests/attorney-trust.test.ts": "// original fixture test\n" },
];

// Stand-ins for the immutable P3-904 Packet and implementation commits.
const ORIGINAL_MIGRATION_TEXT =
  "-- disposable stand-in for the original P3-904 migration\nselect 1;\n";
const P3904_CHANGES = [
  { [P3_904_PACKET_PATH]: { oid: P3904_PACKET_BLOB } },
  {
    [P3904_MIGRATION]: { oid: P3904_MIGRATION_BLOB },
    "apps/web/tests/m4-db-proof.mjs": "// fixture: updated existing DB proof\n",
  },
  {
    "apps/web/src/application/attorney-professional.ts":
      "export const writes = 'database interface';\n",
  },
  { "apps/web/tests/p3-904-db-proof.mjs": "// fixture: P3-904 DB proof\n" },
];
const FIXTURE_CORRECTION_SQL = `${ORIGINAL_MIGRATION_TEXT}-- disposable fixture edit; not the P3-904 SQL correction\n`;
const DEFAULT_SECURITY = {
  [P3904_MIGRATION]: FIXTURE_CORRECTION_SQL,
  "apps/web/src/application/attorney-trust.ts": "export const trust = 2;\n",
  "apps/web/tests/attorney-trust-correction.test.ts": "// P3-904 fixture\n",
};

// Simulated GitHub API: the five fixed read-only endpoints the guard uses.
const API = {
  user: `users/${OWNER_LOGIN}`,
  pull: `repos/${OWNER_REPOSITORY}/pulls/${PR}`,
  reviews: `repos/${OWNER_REPOSITORY}/pulls/${PR}/reviews?per_page=100`,
  reviewComments: `repos/${OWNER_REPOSITORY}/pulls/${PR}/comments?per_page=100`,
  comments: `repos/${OWNER_REPOSITORY}/issues/${PR}/comments?per_page=100`,
};
const EXPECTED_CALLS = [
  ["api", API.user],
  ["api", API.pull],
  ["api", "--paginate", API.reviews],
  ["api", "--paginate", API.reviewComments],
  ["api", "--paginate", API.comments],
];

let commentId = 4100;
function comment(
  body,
  {
    login = OWNER_LOGIN,
    id = FIXTURE_OWNER_ID,
    createdAt = "2026-11-08T10:00:00Z",
    updatedAt,
  } = {},
) {
  commentId += 1;
  return {
    id: commentId,
    user: { login, id, type: "User" },
    created_at: createdAt,
    updated_at: updatedAt ?? createdAt,
    author_association: "OWNER",
    body,
  };
}

function apiRoutes({ head, base, comments }) {
  return {
    [API.user]: {
      paginate: false,
      pages: [{ login: OWNER_LOGIN, id: FIXTURE_OWNER_ID, type: "User" }],
    },
    [API.pull]: {
      paginate: false,
      pages: [
        {
          number: PR,
          state: "open",
          title: "P3-904 security correction",
          body: "Fixture pull request description.",
          user: { login: OWNER_LOGIN, id: FIXTURE_OWNER_ID },
          head: {
            sha: head,
            ref: CORRECTION_BRANCH,
            repo: { full_name: BUILDER_REPOSITORY },
          },
          base: {
            sha: base,
            ref: "main",
            repo: { full_name: OWNER_REPOSITORY },
          },
        },
      ],
    },
    [API.reviews]: { paginate: true, pages: [[]] },
    [API.reviewComments]: { paginate: true, pages: [[]] },
    [API.comments]: { paginate: true, pages: [comments] },
  };
}

// The approval body format, written independently of the guard.
function approvalBody({
  marker = APPROVAL_MARKER,
  repository = OWNER_REPOSITORY,
  pr = PR,
  branch = CORRECTION_BRANCH,
  security,
  admin,
  head = admin,
  base,
  blobs,
  scope = APPROVAL_SCOPE,
}) {
  return [
    marker,
    `repository=${repository}`,
    `pull_request=${pr}`,
    `branch=${branch}`,
    `security_commit=${security}`,
    `administrative_commit=${admin}`,
    `head=${head}`,
    `base=${base}`,
    `${GOVERNANCE.register}=${blobs.register}`,
    `${GOVERNANCE.workItems}=${blobs.workItems}`,
    `${GOVERNANCE.decisions}=${blobs.decisions}`,
    `approval=${scope}`,
  ].join("\n");
}

let apiRuns = 0;
// Runs the guard as the trusted workflow would, with simulated API responses.
function runApproved(
  repo,
  { base, head, branch, approvedRef, comments, routes, env = {} },
) {
  apiRuns += 1;
  const baseCommit = repo.git(["rev-parse", `${base}^{commit}`]);
  const fixtureFile = path.join(SANDBOX, `gh-${apiRuns}.json`);
  const log = path.join(SANDBOX, `gh-${apiRuns}.log`);
  let api = apiRoutes({ head, base: baseCommit, comments });
  if (routes) api = routes(api) ?? api;
  writeFileSync(fixtureFile, JSON.stringify({ routes: api, log }));
  const result = runGuard(repo, [base, head, branch, approvedRef], {
    GH_TOKEN: "placeholder",
    REPO: OWNER_REPOSITORY,
    PR_NUMBER: String(PR),
    HEAD_SHA: head,
    BASE_SHA: baseCommit,
    FAKE_GH_FIXTURE: fixtureFile,
    ...env,
  });
  result.calls = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return result;
}

// Exactly one AUDIT and one combined PASS line and nothing else.
function assertRecoveryPass(result, recovery, approval) {
  const context = `exit ${result.status}\n${result.output}`;
  assert.equal(result.status, 0, context);
  assert.equal(result.stderr, "", context);
  const base = recovery.baseCommit;
  assert.deepEqual(
    result.stdout.split("\n").filter(Boolean),
    [
      [
        "ROSUNO-GUARD AUDIT p2915_owner_approval",
        `repository=${OWNER_REPOSITORY}`,
        `pr=${PR}`,
        `comment_id=${approval.id}`,
        `author=${OWNER_LOGIN}`,
        `author_id=${FIXTURE_OWNER_ID}`,
        `created_at=${approval.created_at}`,
        `updated_at=${approval.updated_at}`,
        `body_sha256=${sha256(approval.body)}`,
        `head=${recovery.head}`,
        `base=${base}`,
        `security=${recovery.security}`,
        `administrative=${recovery.admin}`,
        `reviewed_migrations=${recovery.blobs.register}`,
        `work_items=${recovery.blobs.workItems}`,
        `decision_log=${recovery.blobs.decisions}`,
      ].join(" "),
      [
        "ROSUNO-GUARD PASS combined=P3-003+P3-904 recovery=P2-915",
        `head=${recovery.head}`,
        `base=${ORIGINAL_BASE}`,
        `original=${ORIGINAL_HEAD}`,
        `p3904_original=${P3904_HEAD}`,
        `security=${recovery.security}`,
        `administrative=${recovery.admin}`,
        `pr_base=${base}`,
        `approval_comment=${approval.id}`,
      ].join(" "),
    ],
    context,
  );
  assert.deepEqual(
    result.calls,
    EXPECTED_CALLS.map((args) => ({ args, hasToken: true })),
    context,
  );
}

// Builds the pinned original P3-003 history (Builder Packet commit, eight
// originals, final tree, owner approval), the pinned P3-904 Packet and three
// immutable implementation commits, and an owner main that already holds
// P2-914 and the protected-merged P2-915 PROCESS Packet. `spec` substitutes
// individual pinned objects to model forged, missing, reordered or
// out-of-scope history and missing or altered P2-915 provenance.
function buildCombinedRepo(spec = {}) {
  const repo = createRepo(spec.label ?? "combined");
  const built = new Set();
  const helpers = { extra };

  function ensure(commit) {
    const index = ORIGINAL_COMMITS.indexOf(commit);
    if (index >= 0) buildOriginal(index);
    const p3904 = P3904_PINNED.indexOf(commit);
    if (p3904 >= 0) buildP3904(p3904);
  }
  function extra(parent, changes, message = "unapproved extra commit") {
    ensure(parent);
    return repo.child([parent], changes, message);
  }
  function buildOriginal(index) {
    const pinned = ORIGINAL_COMMITS[index];
    if (built.has(pinned)) return;
    built.add(pinned);
    const defaults = [
      index === 0 ? BUILDER_PACKET_COMMIT : ORIGINAL_COMMITS[index - 1],
    ];
    const parents =
      spec.originalParents?.(index, defaults, helpers) ?? defaults;
    parents.forEach(ensure);
    repo.child(
      parents,
      { ...ORIGINAL_CHANGES[index], ...spec.originalExtra?.[index] },
      `P3-003 original ${index + 1}`,
      {
        pinAs: pinned,
        treeAs:
          index === 7 && !spec.unpinnedOriginalTree ? ORIGINAL_TREE : null,
      },
    );
  }
  function buildP3904(index) {
    const pinned = P3904_PINNED[index];
    if (built.has(pinned)) return;
    built.add(pinned);
    const defaults = [index === 0 ? ORIGINAL_HEAD : P3904_PINNED[index - 1]];
    const parents = spec.p3904Parents?.(index, defaults, helpers) ?? defaults;
    parents.forEach(ensure);
    repo.child(
      parents,
      spec.p3904Replace?.[index] ?? {
        ...P3904_CHANGES[index],
        ...spec.p3904Extra?.[index],
      },
      `P3-904 immutable ${index}`,
      {
        pinAs: pinned,
        treeAs: index === 3 && !spec.unpinnedP3904Tree ? P3904_TREE : null,
      },
    );
  }

  repo.root(BASE_FILES, "stand-in for the original base", {
    pinAs: ORIGINAL_BASE,
  });
  repo.pin(ORIGINAL_PACKET_BLOB, repo.blob(P3_003_FIXTURE_PACKET));
  repo.pin(P3904_PACKET_BLOB, repo.blob(spec.p3904PacketText ?? p3904Packet()));
  repo.pin(P3904_MIGRATION_BLOB, repo.blob(ORIGINAL_MIGRATION_TEXT));
  repo.pin(P2915_PACKET_BLOB, repo.blob("P2-915 adopted Packet stand-in\n"));
  const packetEntry = (oid) => ({
    [P3_003_PACKET_PATH]: { oid: oid ?? ORIGINAL_PACKET_BLOB },
  });

  repo.child(
    [spec.builderPacketParent?.(helpers) ?? ORIGINAL_BASE],
    {
      ...packetEntry(spec.builderPacketBlob?.(repo)),
      ...spec.builderPacketExtra,
    },
    "P3-003 Builder Packet",
    { pinAs: BUILDER_PACKET_COMMIT },
  );
  if (spec.ownerApproval !== "missing") {
    repo.child(
      [spec.ownerPacketParent?.(helpers) ?? ORIGINAL_BASE],
      packetEntry(spec.ownerPacketBlob?.(repo)),
      "P3-003 owner Packet",
      { pinAs: OWNER_PACKET_COMMIT },
    );
    const approval =
      spec.ownerApproval === "moved"
        ? repo.child([ORIGINAL_BASE], packetEntry(), "unpinned owner copy")
        : OWNER_PACKET_COMMIT;
    repo.ref(ORIGINAL_APPROVAL_REF, approval);
  }
  ORIGINAL_COMMITS.forEach((_, index) => buildOriginal(index));
  P3904_PINNED.forEach((_, index) => buildP3904(index));
  for (const index of spec.withoutOriginalObjects ?? []) {
    repo.git(["update-ref", "-d", `refs/replace/${ORIGINAL_COMMITS[index]}`]);
  }

  // Owner main: P2-914 merged, then (by default) the P2-915 PROCESS Packet
  // commit under its pinned name and the P2-915 implementation merged.
  const p2914Changes = {
    "docs/work-items/P2-914/PACKET.md": "P2-914 stand-in\n",
    ".github/scripts/rosuno-guard.sh": "# P2-914 accommodation stand-in\n",
  };
  const p2914 = repo.child([ORIGINAL_BASE], p2914Changes, "P2-914 stand-in");
  const mainP2914 = repo.child(
    [ORIGINAL_BASE, p2914],
    p2914Changes,
    "owner main (P2-914 merged)",
  );
  let main = mainP2914;
  if (spec.p2915 !== "absent") {
    const p2915Packet = repo.child(
      [mainP2914],
      { [P2915_PACKET_PATH]: { oid: P2915_PACKET_BLOB } },
      "P2-915 Packet",
      { pinAs: spec.p2915 === "unpinned" ? null : P2915_PACKET_COMMIT },
    );
    const implementation = {
      ".github/scripts/rosuno-guard.sh": "# P2-915 accommodation stand-in\n",
      "tools/p0/tests/p0-rosuno-guard-combined-history.test.mjs": "// t\n",
    };
    const p2915 = repo.child([p2915Packet], implementation, "P2-915 impl");
    main = repo.child(
      [mainP2914, p2915],
      { [P2915_PACKET_PATH]: { oid: P2915_PACKET_BLOB }, ...implementation },
      "owner main (P2-915 merged)",
    );
  }
  if (spec.mainAfter) main = spec.mainAfter(main, repo);
  repo.ref("refs/heads/main", main);

  let approvals = 0;
  function step(tip, changes, message) {
    if (changes[MERGE_SIDE]) {
      const side = repo.child([tip], changes[MERGE_SIDE], "side branch");
      return repo.child([tip, side], changes[MERGE_SIDE], "merge side branch");
    }
    if (changes[MERGE_MAIN]) {
      return repo.child([tip, main], {}, "merge owner main");
    }
    return repo.child([tip], changes, message);
  }
  return {
    repo,
    main,
    mainP2914,
    helpers,
    // Adds a P3-904 recovery continuation on the immutable chain plus the
    // owner's P3-904 Packet approval (from owner main, per Packet §5).
    recovery({
      parent = P3904_HEAD,
      before = [],
      security = DEFAULT_SECURITY,
      securityParents,
      admin = registration(),
      adminParents,
      adminMessage = "P3-904 administrative registration",
      after = [],
      approval = "same",
      approvalPacketText,
    } = {}) {
      let tip = typeof parent === "function" ? parent(helpers) : parent;
      for (const changes of before) tip = step(tip, changes, "extra commit");
      let securityCommit = null;
      let adminCommit = null;
      if (security) {
        tip = securityParents
          ? repo.child(securityParents, security, "P3-904 security correction")
          : step(tip, security, "P3-904 security correction");
        securityCommit = tip;
      }
      if (admin) {
        tip = adminParents
          ? repo.child(adminParents, admin, adminMessage)
          : step(tip, admin, adminMessage);
        adminCommit = tip;
      }
      for (const changes of after) tip = step(tip, changes, "later commit");
      approvals += 1;
      const approvedRef = `refs/fixture/p3-904-approved-${approvals}`;
      if (approval === "same") {
        const blob =
          approvalPacketText === undefined
            ? P3904_PACKET_BLOB
            : repo.blob(approvalPacketText);
        repo.ref(
          approvedRef,
          repo.child(
            [main],
            { [P3_904_PACKET_PATH]: { oid: blob } },
            "owner P3-904 approval",
          ),
        );
      } else if (approval === "no-packet") {
        repo.ref(approvedRef, main);
      }
      const blobOf = (file) => {
        if (!adminCommit) return undefined;
        const found = spawnSync(
          "git",
          ["rev-parse", "-q", "--verify", `${adminCommit}:${file}`],
          { cwd: repo.dir, env: repo.env, encoding: "utf8" },
        );
        return found.status === 0 ? found.stdout.trim() : undefined;
      };
      const recovery = {
        head: tip,
        security: securityCommit,
        admin: adminCommit,
        approvedRef,
        baseCommit: main,
        blobs: {
          register: blobOf(GOVERNANCE.register),
          workItems: blobOf(GOVERNANCE.workItems),
          decisions: blobOf(GOVERNANCE.decisions),
        },
        body: (overrides = {}) =>
          approvalBody({
            security: securityCommit,
            admin: adminCommit,
            head: tip,
            base: main,
            blobs: recovery.blobs,
            ...overrides,
          }),
        run({
          comments,
          routes,
          env,
          base = main,
          head = tip,
          branch = CORRECTION_BRANCH,
          approvedRef: ref = approvedRef,
        } = {}) {
          return runApproved(repo, {
            base,
            head,
            branch,
            approvedRef: ref,
            comments:
              comments ?? (adminCommit ? [comment(recovery.body())] : []),
            routes,
            env,
          });
        },
      };
      return recovery;
    },
  };
}

let sharedCombined;
const combined = () =>
  (sharedCombined ??= buildCombinedRepo({ label: "shared" }));

const combinedResult = (options = {}) => combined().recovery(options).run();

// Builds a separate repository whose pinned history or owner main is altered
// by `spec`, adds the default compliant recovery, and runs the guard.
const variantResult = (spec, options = {}) =>
  buildCombinedRepo(spec).recovery(options).run();

describe("P2-914/P2-915 pinned identities and fail-closed selection", () => {
  const guard = readFileSync(GUARD, "utf8");
  const local = (name) => {
    const match = guard.match(new RegExp(`^ *local ${name}='([^']*)'$`, "m"));
    assert.ok(match, `guard constant ${name}`);
    return match[1];
  };
  const localArray = (name) => {
    const match = guard.match(
      new RegExp(`^ *local ${name}=\\(\\n([\\s\\S]*?)\\n *\\)$`, "m"),
    );
    assert.ok(match, `guard array ${name}`);
    return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  };

  test("guard pins exactly the adopted P2-914 Packet §2 identities", () => {
    assert.equal(local("ORIGINAL_BASE"), ORIGINAL_BASE);
    assert.equal(local("OWNER_PACKET_COMMIT"), OWNER_PACKET_COMMIT);
    assert.equal(local("BUILDER_PACKET_COMMIT"), BUILDER_PACKET_COMMIT);
    assert.equal(local("ORIGINAL_PACKET_BLOB"), ORIGINAL_PACKET_BLOB);
    assert.equal(local("ORIGINAL_TREE"), ORIGINAL_TREE);
    assert.equal(local("ORIGINAL_BRANCH"), ORIGINAL_BRANCH);
    assert.equal(local("CORRECTION_BRANCH"), CORRECTION_BRANCH);
    assert.equal(local("ORIGINAL_APPROVAL"), ORIGINAL_APPROVAL_REF);
    assert.equal(local("ORIGINAL_PACKET_PATH"), P3_003_PACKET_PATH);
    assert.equal(local("CORRECTION_PACKET_PATH"), P3_904_PACKET_PATH);
    assert.deepEqual(localArray("ORIGINAL_COMMITS"), ORIGINAL_COMMITS);

    const packet = readFileSync(PACKET, "utf8");
    for (const line of [
      `Original base: \`${ORIGINAL_BASE}\``,
      `Owner P3-003 Packet-only commit: \`${OWNER_PACKET_COMMIT}\``,
      `Builder P3-003 Packet-only commit: \`${BUILDER_PACKET_COMMIT}\``,
      `Original Packet blob: \`${ORIGINAL_PACKET_BLOB}\``,
      `Final original tree: \`${ORIGINAL_TREE}\``,
      `Select the exceptional path only for head branch \`${CORRECTION_BRANCH}\``,
    ]) {
      assert.ok(packet.includes(line), `Packet line: ${line}`);
    }
    assert.deepEqual(
      [...packet.matchAll(/^(\d)\. `([0-9a-f]{40})`$/gm)].map((m) => m[2]),
      ORIGINAL_COMMITS,
    );
  });

  test("guard pins exactly the adopted P2-915 Packet §2, §4 and §5 identities", () => {
    assert.equal(local("P3904_PACKET_COMMIT"), P3904_PACKET_COMMIT);
    assert.equal(local("P3904_PACKET_BLOB"), P3904_PACKET_BLOB);
    assert.deepEqual(localArray("P3904_COMMITS"), P3904_COMMITS);
    assert.equal(local("P3904_TREE"), P3904_TREE);
    assert.equal(local("P3904_MIGRATION"), P3904_MIGRATION);
    assert.equal(local("P3904_MIGRATION_ID"), P3904_MIGRATION_ID);
    assert.equal(local("P3904_MIGRATION_BLOB"), P3904_MIGRATION_BLOB);
    assert.equal(local("P2915_PACKET_COMMIT"), P2915_PACKET_COMMIT);
    assert.equal(local("P2915_PACKET_PATH"), P2915_PACKET_PATH);
    assert.equal(local("P2915_PACKET_BLOB"), P2915_PACKET_BLOB);
    assert.deepEqual(localArray("GOVERNANCE_PATHS"), [
      GOVERNANCE.register,
      GOVERNANCE.workItems,
      GOVERNANCE.decisions,
    ]);
    assert.equal(local("OWNER_REPOSITORY"), OWNER_REPOSITORY);
    assert.equal(local("OWNER_LOGIN"), OWNER_LOGIN);
    assert.equal(local("BUILDER_REPOSITORY"), BUILDER_REPOSITORY);
    assert.equal(local("APPROVAL_MARKER"), APPROVAL_MARKER);
    assert.equal(local("REVOCATION_MARKER"), REVOCATION_MARKER);
    assert.equal(local("APPROVAL_SCOPE"), APPROVAL_SCOPE);
    assert.equal(
      P3904_MIGRATION,
      `supabase/migrations/${P3904_MIGRATION_ID}.sql`,
    );

    const packet = readFileSync(P2915_PACKET, "utf8");
    for (const line of [
      `Owner repository \`${OWNER_REPOSITORY}\`; Builder fork \`${BUILDER_REPOSITORY}\``,
      `Owner \`main\` verified at preparation: \`${OWNER_MAIN}\``,
      `Existing Builder P3-904 Packet-only commit \`${P3904_PACKET_COMMIT}\` (parent original P3-003 HEAD \`${ORIGINAL_HEAD}\`)`,
      `Adopted P3-904 Packet SHA-256 \`${P3904_PACKET_SHA256}\`, Git blob \`${P3904_PACKET_BLOB}\``,
      `1. \`${P3904_COMMITS[0]}\` (parent \`${P3904_PACKET_COMMIT}\`)`,
      `2. \`${P3904_COMMITS[1]}\` (parent \`${P3904_COMMITS[0]}\`)`,
      `3. \`${P3904_COMMITS[2]}\` (parent \`${P3904_COMMITS[1]}\`, tree \`${P3904_TREE}\`)`,
      `**Sole migration exception path:** \`${P3904_MIGRATION}\``,
      `**Required original introducing commit:** \`${P3904_COMMITS[0]}\``,
      `**Original migration Git blob:** \`${P3904_MIGRATION_BLOB}\`; SHA-256 \`${P3904_MIGRATION_SHA256}\``,
      `- \`${GOVERNANCE.register}\``,
      `- \`${GOVERNANCE.workItems}\``,
      `- \`${GOVERNANCE.decisions}\``,
      `GitHub user login \`${OWNER_LOGIN}\``,
      `\`${APPROVAL_MARKER}\``,
      '`reviewed: false`, `reviewed_by: "pending designated human PR review"`, `reviewed_at: null`, `applied_environment: "none"`, `release_refs: []`',
    ]) {
      assert.ok(packet.includes(line), `P2-915 Packet text: ${line}`);
    }
  });

  test("the adopted P2-915 Packet bytes are the pinned provenance blob", () => {
    const bytes = readFileSync(P2915_PACKET);
    assert.equal(sha256(bytes), P2915_PACKET_SHA256);
    assert.equal(gitBlobId(bytes), P2915_PACKET_BLOB);
    const pinned = spawnSync(
      "git",
      [
        "-C",
        ROOT,
        "rev-parse",
        "-q",
        "--verify",
        `${P2915_PACKET_COMMIT}:${P2915_PACKET_PATH}`,
      ],
      { encoding: "utf8" },
    );
    // The pinned Packet commit is present in full clones of either repository.
    if (pinned.status === 0)
      assert.equal(pinned.stdout.trim(), P2915_PACKET_BLOB);
  });

  test("dispatcher and ordinary normal_guard are byte-identical to protected Owner main", () => {
    const dispatch = guard.slice(guard.lastIndexOf("\nif "));
    assert.equal(
      dispatch,
      [
        "",
        `if [ "\${3:-}" = '${CORRECTION_BRANCH}' ]; then`,
        '  combined_guard "$@"',
        "else",
        '  normal_guard "$@"',
        "fi",
        "",
      ].join("\n"),
    );
    const start = guard.indexOf(COMBINED_SECTION_START);
    assert.ok(start > 0, "combined section marker");
    assert.equal(sha256(guard.slice(0, start)), NORMAL_GUARD_PREFIX_SHA256);
    // The branch literal appears only as the pinned constant and in the
    // dispatcher; no prefix, Packet text or environment switch selects it.
    assert.equal(guard.split(`'${CORRECTION_BRANCH}'`).length - 1, 2);
    assert.doesNotMatch(guard, /\$\{?(?:GITHUB_|ROSUNO_|CI\b|HEAD_REF\b)/);
    // Only the workflow-supplied event inputs are read from the environment,
    // and only to locate and cross-check the PR; none selects the path.
    assert.deepEqual(
      [
        ...new Set(
          [...guard.matchAll(/\$\{([A-Z][A-Z0-9_]*):-\}/g)].map((m) => m[1]),
        ),
      ].sort(),
      ["BASE_SHA", "GH_TOKEN", "HEAD_SHA", "PR_NUMBER", "REPO"],
    );
    // No new success shortcut: one ordinary and one combined PASS statement,
    // one audit record, and the combined path reuses the unchanged ordinary
    // guard per segment.
    assert.equal(guard.split('echo "ROSUNO-GUARD PASS').length - 1, 2);
    assert.equal(guard.split('echo "ROSUNO-GUARD AUDIT').length - 1, 1);
    assert.doesNotMatch(guard, /\bexit 0\b/);
    assert.deepEqual(
      [...guard.matchAll(/^ *normal_guard (.+?)(?: \\)?$/gm)].map((m) => m[1]),
      [
        '"$ORIGINAL_BASE" "$ORIGINAL_HEAD" "$ORIGINAL_BRANCH" "$ORIGINAL_APPROVAL"',
        '"$ORIGINAL_HEAD" "$SECURITY" "$CORRECTION_BRANCH" "$APPROVED"',
        '"$@"',
      ],
    );
  });

  test("the guard reads GitHub only through fixed, read-only owner-repository endpoints", () => {
    assert.equal(guard.split("gh api").length - 1, 1);
    assert.match(
      guard,
      /^ {4}gh api "\$@" >"\$T\/\$out" 2>"\$T\/gh\.err" \\$/m,
    );
    assert.deepEqual(
      [...guard.matchAll(/^ *gh_get (.+)$/gm)].map((m) => m[1]),
      [
        'owner.json "users/$OWNER_LOGIN"',
        'pull.json "repos/$OWNER_REPOSITORY/pulls/$PR_NUMBER"',
        'reviews.json --paginate "repos/$OWNER_REPOSITORY/pulls/$PR_NUMBER/reviews?per_page=100"',
        'review-comments.json --paginate "repos/$OWNER_REPOSITORY/pulls/$PR_NUMBER/comments?per_page=100"',
        'comments.json --paginate "repos/$OWNER_REPOSITORY/issues/$PR_NUMBER/comments?per_page=100"',
      ],
    );
    const combinedSection = guard.slice(guard.indexOf(COMBINED_SECTION_START));
    assert.doesNotMatch(
      combinedSection,
      /--method|\s-X\s|\s-[fF]\s|--input|--field|--raw-field/,
    );
  });
});

describe("P2-915 completed P3-904 recovery (positive, Packet §6)", () => {
  test("passes with exactly one AUDIT and one combined PASS line", () => {
    const recovery = combined().recovery();
    const approval = comment(recovery.body());
    assertRecoveryPass(
      recovery.run({ comments: [approval] }),
      recovery,
      approval,
    );
  });

  test("passes for a later owner main that still carries P2-915 and unchanged registers", () => {
    const fixture = buildCombinedRepo({
      label: "later-main",
      mainAfter: (main, repo) =>
        repo.child([main], { "README.md": "later owner main\n" }, "later main"),
    });
    const recovery = fixture.recovery();
    const approval = comment(recovery.body());
    assertRecoveryPass(
      recovery.run({ comments: [approval] }),
      recovery,
      approval,
    );
  });

  test("finds the approval on a later page among unrelated comments (pagination)", () => {
    const recovery = combined().recovery();
    const approval = comment(recovery.body());
    const result = recovery.run({
      routes: (api) => {
        api[API.comments].pages = [
          [comment("Thanks!", { login: "someone-else", id: 77 })],
          [comment("Looks fine.", { login: "Rosuno", id: 78 })],
          [approval],
        ];
      },
    });
    assertRecoveryPass(result, recovery, approval);
    const separated = recovery.run({
      routes: (api) => {
        api[API.comments].pages = [[comment("unrelated")], [approval]];
        api[API.comments].separator = "\n";
      },
    });
    assertRecoveryPass(separated, recovery, approval);
  });

  test("accepts CRLF line endings and a trailing newline in the exact body", () => {
    const recovery = combined().recovery();
    const approval = comment(`${recovery.body().replace(/\n/g, "\r\n")}\r\n`);
    assertRecoveryPass(
      recovery.run({ comments: [approval] }),
      recovery,
      approval,
    );
  });

  test("security-defective candidate passes structurally but claims nothing more", () => {
    // Deliberately insecure correction: history, scope, registration and
    // approval binding are valid, so the structural guard passes. That PASS
    // must not read as security acceptance or merge eligibility; independent
    // security PASS remains a separate mandatory condition (Packet §6).
    const fixture = combined();
    const defective = fixture.recovery({
      security: {
        [P3904_MIGRATION]:
          "-- deliberately defective fixture: broad grant, no RLS\n" +
          "grant all on table public.attorney_trust_profiles to anon;\n",
        "apps/web/src/application/attorney-trust.ts":
          "// deliberately defective fixture: any caller may verify trust\n" +
          "export const canVerifyTrust = () => true;\n",
      },
    });
    const approval = comment(defective.body());
    const result = defective.run({ comments: [approval] });
    assertRecoveryPass(result, defective, approval);
    // Beyond key=value identities the output carries only fixed labels.
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const words = line.split(" ").filter((word) => !word.includes("="));
      assert.ok(
        [
          "ROSUNO-GUARD AUDIT p2915_owner_approval",
          "ROSUNO-GUARD PASS",
        ].includes(words.join(" ")),
        line,
      );
    }
  });
});

describe("P2-914 combined history rejections retained under P2-915", () => {
  test("(1)/(19) uncorrected, Packet-only and incomplete P3-904 histories fail", () => {
    const fixture = combined();
    const recovery = fixture.recovery();
    assertRejected(
      recovery.run({ head: ORIGINAL_HEAD }),
      "P3-904 immutable commit 0 differs or is missing (exact pinned P3-904 history required)",
    );
    assertRejected(
      recovery.run({ head: P3904_PACKET_COMMIT }),
      "P3-904 immutable commit 1 differs or is missing",
    );
    assertRejected(
      recovery.run({ head: P3904_HEAD }),
      "P3-904 security correction commit missing (only a completed recovery is accepted)",
    );
    assertRejected(
      recovery.run({ head: recovery.security }),
      "P3-904 administrative registration commit missing",
    );
  });

  test("(2) missing P3-904 Packet commit is rejected", () => {
    assertRejected(
      variantResult({
        label: "p3904-no-packet",
        p3904Parents: (index, defaults) =>
          index === 1 ? [ORIGINAL_HEAD] : defaults,
      }),
      "P3-904 immutable commit 0 differs or is missing",
    );
  });

  test("(3) wrong correction Packet parent or base is rejected", () => {
    assertRejected(
      variantResult({
        label: "p3904-parent",
        p3904Parents: (index, defaults) =>
          index === 0 ? [ORIGINAL_COMMITS[6]] : defaults,
      }),
      "P3-003 original HEAD not an ancestor of P3-904",
    );
    assertRejected(
      combinedResult({ parent: combined().main }),
      "P3-904 combined merge-base mismatch",
    );
    assertRejected(
      variantResult({
        label: "p3904-packet-base",
        p3904PacketText: p3904Packet({ base: ORIGINAL_COMMITS[6] }),
      }),
      `Packet BASE_SHA ${ORIGINAL_COMMITS[6]} is not the parent of the Packet commit`,
    );
  });

  test("(4) mismatched or missing correction owner approval is rejected", () => {
    assertRejected(
      combinedResult({
        approvalPacketText: p3904Packet({ migrations: "new allowed, edited" }),
      }),
      `Packet differs from the owner-approved Packet on owner branch ${CORRECTION_BRANCH}`,
    );
    assertRejected(
      combinedResult({ approval: "missing" }),
      "P3-904 owner approval unavailable",
    );
    assertRejected(
      combinedResult({ approval: "no-packet" }),
      `owner branch ${CORRECTION_BRANCH} has no ${P3_904_PACKET_PATH}`,
    );
  });

  test("(5) missing or moved original owner approval is rejected", () => {
    assertRejected(
      variantResult({ label: "owner-missing", ownerApproval: "missing" }),
      "P3-003 owner approval ref absent or moved",
    );
    assertRejected(
      variantResult({ label: "owner-moved", ownerApproval: "moved" }),
      "P3-003 owner approval ref absent or moved",
    );
  });

  test("(6) wrong original Packet blob or approval parent is rejected", () => {
    const otherBlob = (repo) => repo.blob(`${P3_003_FIXTURE_PACKET}altered\n`);
    assertRejected(
      variantResult({ label: "owner-blob", ownerPacketBlob: otherBlob }),
      "P3-003 owner Packet blob mismatch",
    );
    assertRejected(
      variantResult({ label: "builder-blob", builderPacketBlob: otherBlob }),
      "P3-003 Builder Packet blob mismatch",
    );
    assertRejected(
      variantResult({
        label: "owner-parent",
        ownerPacketParent: ({ extra }) =>
          extra(ORIGINAL_BASE, { "README.md": "other base\n" }),
      }),
      "P3-003 owner Packet parent mismatch",
    );
  });

  test("original Builder Packet boundary (P2-914 Packet §3.2) is enforced", () => {
    assertRejected(
      variantResult({
        label: "builder-parent",
        builderPacketParent: ({ extra }) =>
          extra(ORIGINAL_BASE, { "README.md": "other base\n" }),
      }),
      "P3-003 Builder Packet parent mismatch",
    );
    assertRejected(
      variantResult({
        label: "builder-not-packet-only",
        builderPacketExtra: { "apps/web/app/attorney/early.tsx": "early\n" },
      }),
      "P3-003 Packet commit is not Packet-only",
    );
  });

  test("(7) modified original commits or trees are rejected", () => {
    // Amending original 5 rewrites originals 5-8 under new SHAs.
    const rewritten = ({ extra }) => {
      let tip = extra(
        ORIGINAL_COMMITS[3],
        { "apps/web/app/staff/verification/page.tsx": "// amended 5\n" },
        "amended copy of original 5",
      );
      for (let index = 5; index < 8; index += 1) {
        tip = extra(tip, ORIGINAL_CHANGES[index], `rewritten ${index + 1}`);
      }
      return tip;
    };
    assertRejected(
      combinedResult({ parent: rewritten }),
      "P3-003 original HEAD not an ancestor of P3-904",
    );
    // Stand-in where the object under pinned original 4 has a modified parent.
    assertRejected(
      variantResult({
        label: "modified-original",
        originalParents: (index, defaults, { extra }) =>
          index === 3
            ? [extra(ORIGINAL_COMMITS[1], { "apps/web/tests/m.txt": "m\n" })]
            : defaults,
      }),
      "P3-003 original commit 3 differs",
    );
    assertRejected(
      variantResult({ label: "original-tree", unpinnedOriginalTree: true }),
      "P3-003 original tree mismatch",
    );
    assertRejected(
      variantResult({ label: "p3904-tree", unpinnedP3904Tree: true }),
      "P3-904 immutable original tree mismatch",
    );
    // Stand-in where pinned P3-904 commit 2 has a modified parent.
    assertRejected(
      variantResult({
        label: "p3904-modified",
        p3904Parents: (index, defaults, { extra }) =>
          index === 2
            ? [extra(P3904_COMMITS[0], { "apps/web/tests/m.txt": "m\n" })]
            : defaults,
      }),
      "P3-904 immutable commit 2 differs or is missing",
    );
  });

  test("(8) missing original commit is rejected", () => {
    assertRejected(
      variantResult({
        label: "skipped-original",
        originalParents: (index, defaults) =>
          index === 3 ? [ORIGINAL_COMMITS[1]] : defaults,
      }),
      "P3-003 original commit count mismatch",
    );
    assertRejected(
      variantResult({ label: "absent-original", withoutOriginalObjects: [2] }),
      "P3-904 combined merge-base mismatch",
    );
    assertRejected(
      variantResult({
        label: "skipped-p3904",
        p3904Parents: (index, defaults) =>
          index === 2 ? [P3904_PACKET_COMMIT] : defaults,
      }),
      "P3-904 immutable commit 1 differs or is missing",
    );
  });

  test("(9) reordered original commits are rejected", () => {
    const swapped = { 3: 4, 4: 2, 5: 3 }; // originals 4 and 5 exchanged
    assertRejected(
      variantResult({
        label: "reordered",
        originalParents: (index, defaults) =>
          index in swapped ? [ORIGINAL_COMMITS[swapped[index]]] : defaults,
      }),
      "P3-003 original commit 4 differs",
    );
    const p3904Swapped = { 1: 2, 2: 0, 3: 1 }; // P3-904 commits 1 and 2 exchanged
    assertRejected(
      variantResult({
        label: "p3904-reordered",
        p3904Parents: (index, defaults) =>
          index in p3904Swapped
            ? [P3904_PINNED[p3904Swapped[index]]]
            : defaults,
      }),
      "P3-904 immutable commit 1 differs or is missing",
    );
  });

  test("(10) duplicate or cherry-picked original commits are rejected", () => {
    const cherryPicked = ({ extra }) =>
      ORIGINAL_CHANGES.reduce(
        (tip, changes, index) => extra(tip, changes, `copy ${index + 1}`),
        BUILDER_PACKET_COMMIT,
      );
    assertRejected(
      combinedResult({ parent: cherryPicked }),
      "P3-003 original HEAD not an ancestor of P3-904",
    );
    // Cherry-picked copies of the P3-904 chain on the original HEAD.
    const p3904Copies = ({ extra }) =>
      P3904_CHANGES.reduce(
        (tip, changes, index) => extra(tip, changes, `P3-904 copy ${index}`),
        ORIGINAL_HEAD,
      );
    assertRejected(
      combinedResult({ parent: p3904Copies }),
      "P3-904 immutable commit 0 differs or is missing",
    );
    assertRejected(
      variantResult({
        label: "duplicated-original",
        originalParents: (index, defaults, { extra }) =>
          index === 5
            ? [extra(ORIGINAL_COMMITS[4], ORIGINAL_CHANGES[4], "duplicate 5")]
            : defaults,
      }),
      "P3-003 original commit count mismatch",
    );
    // Replaying an original-only change inside the correction segment is
    // judged by the correction Packet, which does not authorize it.
    assertRejected(
      combinedResult({
        security: {
          ...DEFAULT_SECURITY,
          "apps/web/app/staff/verification/page.tsx": "// replayed\n",
        },
      }),
      "apps/web/app/staff/verification/page.tsx (M) is inside FORBIDDEN_SCOPE",
      "apps/web/app/staff/verification/page.tsx (M) is outside ALLOWED_SCOPE",
    );
  });

  test("(11) unauthorized P3-003 migration is rejected", () => {
    const migration = "supabase/migrations/20261101000000_p3_003.sql";
    assertRejected(
      variantResult({
        label: "p3-003-migration",
        originalExtra: { 4: { [migration]: "select 1;\n" } },
      }),
      `${commitLabel(ORIGINAL_COMMITS[4])} new migration ${migration} but Packet says MIGRATIONS: none`,
      `${commitLabel(ORIGINAL_COMMITS[4])} ${migration} (A) is inside FORBIDDEN_SCOPE`,
    );
  });

  test("(12) P3-003 out-of-scope edit is rejected", () => {
    assertRejected(
      variantResult({
        label: "p3-003-scope",
        originalExtra: { 2: { "governance/work-items/extra.json": "{}\n" } },
      }),
      `${commitLabel(ORIGINAL_COMMITS[2])} governance/work-items/extra.json (A) is inside FORBIDDEN_SCOPE`,
      `${commitLabel(ORIGINAL_COMMITS[2])} governance/work-items/extra.json (A) is outside ALLOWED_SCOPE`,
    );
  });

  test("(14) historical migration edits are rejected in either segment", () => {
    const withSecurity = (changes) =>
      combinedResult({ security: { ...DEFAULT_SECURITY, ...changes } });
    assertRejected(
      withSecurity({ [HISTORICAL_MIGRATION]: "select 9;\n" }),
      `existing migration ${HISTORICAL_MIGRATION} changed or aliased (status M; forward-only)`,
    );
    assertRejected(
      withSecurity({ [HISTORICAL_MIGRATION]: null }),
      `existing migration ${HISTORICAL_MIGRATION} changed or aliased (status D; forward-only)`,
    );
    const alias = HISTORICAL_MIGRATION.replace("historical", "HISTORICAL");
    assertRejected(
      withSecurity({ [alias]: "select 1;\n" }),
      `existing migration ${alias} changed or aliased (status A; forward-only)`,
    );
    assertRejected(
      variantResult({
        label: "p3-003-historical-migration",
        originalExtra: { 5: { [HISTORICAL_MIGRATION]: "select 9;\n" } },
      }),
      `${commitLabel(ORIGINAL_COMMITS[5])} existing migration ${HISTORICAL_MIGRATION} changed or aliased (status M; forward-only)`,
    );
    assertRejected(
      variantResult({
        label: "p3904-historical-migration",
        p3904Extra: { 2: { [HISTORICAL_MIGRATION]: "select 9;\n" } },
      }),
      `${commitLabel(P3904_COMMITS[1])} existing migration ${HISTORICAL_MIGRATION} changed or aliased (status M; forward-only)`,
    );
  });

  test("(15) P3-904 out-of-scope edits are rejected", () => {
    const rejectStep = (changes, ...expected) =>
      assertRejected(
        combinedResult({ security: { ...DEFAULT_SECURITY, ...changes } }),
        ...expected,
      );
    rejectStep(
      { "apps/web/app/page.tsx": "export const replaced = 1;\n" },
      "apps/web/app/page.tsx (M) is inside FORBIDDEN_SCOPE",
      "apps/web/app/page.tsx (M) is outside ALLOWED_SCOPE",
    );
    rejectStep(
      { ".github/scripts/rosuno-guard.sh": "exit 0\n" },
      ".github/scripts/rosuno-guard.sh (A) is inside FORBIDDEN_SCOPE",
      ".github/scripts/rosuno-guard.sh is process/kit scope; requires a TYPE: PROCESS work item",
    );
    rejectStep(
      { "supabase/config.toml": "[auth]\n" },
      "supabase/config.toml (A) is inside FORBIDDEN_SCOPE",
      "supabase/config.toml (database config/seed) requires a TYPE: PROCESS work item",
    );
    rejectStep(
      { "apps/web/tests/.env.local": "PLACEHOLDER=1\n" },
      "apps/web/tests/.env.local looks like a secret/credential file",
    );
    rejectStep(
      { "apps/web/tests/link.ts": { mode: "120000", content: "../../x" } },
      "apps/web/tests/link.ts has git mode 120000",
    );
    rejectStep(
      { "apps/web/tests/Attorney-trust.test.ts": "// case alias\n" },
      "case-insensitive path collision: apps/web/tests/attorney-trust.test.ts",
    );
  });

  test("cross-segment case-only alias (P2-914 Packet §3.4) is rejected", () => {
    const fixture = buildCombinedRepo({
      label: "cross-segment-alias",
      originalExtra: { 7: { "apps/web/tests/Fixtures/legacy.txt": null } },
    });
    assertRejected(
      fixture
        .recovery({
          security: {
            ...DEFAULT_SECURITY,
            "apps/web/tests/fixtures/legacy.txt": "re-added in other case\n",
          },
        })
        .run(),
      "cross-segment case-only path alias: apps/web/tests/Fixtures -> apps/web/tests/fixtures",
    );
  });

  test("(16) modification of either Packet after creation is rejected", () => {
    assertRejected(
      combinedResult({
        security: {
          ...DEFAULT_SECURITY,
          [P3_904_PACKET_PATH]: `${p3904Packet()}edited\n`,
        },
      }),
      "Packet changed after it was added (re-audit required)",
    );
    // Edited in one immutable stand-in and restored in the next: every
    // commit is still checked on its own.
    assertRejected(
      variantResult({
        label: "p3904-packet-reverted",
        p3904Extra: {
          2: { [P3_904_PACKET_PATH]: `${p3904Packet()}edited\n` },
          3: { [P3_904_PACKET_PATH]: { oid: P3904_PACKET_BLOB } },
        },
      }),
      `Packet path ${P3_904_PACKET_PATH} changed after the Packet commit (even if later reverted; re-audit required)`,
    );
    assertRejected(
      combinedResult({
        security: { ...DEFAULT_SECURITY, [P3_003_PACKET_PATH]: "rewritten\n" },
      }),
      `${P3_003_PACKET_PATH} is outside this work item's writable area`,
    );
    assertRejected(
      combinedResult({
        security: { ...DEFAULT_SECURITY, [P3_003_PACKET_PATH]: null },
      }),
      `${P3_003_PACKET_PATH} is outside this work item's writable area`,
    );
    assertRejected(
      variantResult({
        label: "original-packet-edit",
        originalExtra: { 6: { [P3_003_PACKET_PATH]: "rewritten\n" } },
      }),
      "Packet changed after it was added (re-audit required)",
    );
    assertRejected(
      variantResult({
        label: "p3904-packet-not-pinned",
        p3904Extra: { 0: { "apps/web/tests/early.ts": "early\n" } },
      }),
      "P3-904 Packet commit is not the pinned Packet-only commit",
    );
  });

  test("(17) intermediate unapproved commits are rejected", () => {
    assertRejected(
      variantResult({
        label: "p3904-early",
        p3904Parents: (index, defaults, { extra }) =>
          index === 0
            ? [extra(ORIGINAL_HEAD, { "apps/web/tests/early.ts": "early\n" })]
            : defaults,
      }),
      "P3-904 immutable commit 0 differs or is missing",
    );
    assertRejected(
      variantResult({
        label: "inserted-original",
        originalParents: (index, defaults, { extra }) =>
          index === 2
            ? [extra(ORIGINAL_COMMITS[1], { "apps/web/tests/x.txt": "x\n" })]
            : defaults,
      }),
      "P3-003 original commit count mismatch",
    );
    assertRejected(
      combinedResult({
        before: [{ "apps/web/tests/between.test.ts": "// extra\n" }],
      }),
      "P3-904 recovery must be exactly one security and one administrative commit after the immutable chain (found 3)",
    );
    // An out-of-scope edit in one immutable stand-in, reverted in the next,
    // still fails the per-commit check; the final diff is clean.
    const result = variantResult({
      label: "p3904-reverted-scope",
      p3904Extra: {
        2: { "apps/web/app/page.tsx": "export const replaced = 1;\n" },
        3: {
          "apps/web/app/page.tsx":
            "export default function Home() { return null; }\n",
        },
      },
    });
    assertRejected(
      result,
      `${commitLabel(P3904_COMMITS[1])} apps/web/app/page.tsx (M) is outside ALLOWED_SCOPE`,
    );
    assert.doesNotMatch(result.output, /\[final diff\]/);
  });

  test("(18) nonlinear or merge history is rejected", () => {
    assertRejected(
      combinedResult({
        security: mergeSide(DEFAULT_SECURITY),
      }),
      "P3-904 recovery must be exactly one security and one administrative commit after the immutable chain (found 3)",
    );
    // A merge whose second parent adds no commit is still not linear.
    assertRejected(
      combinedResult({ securityParents: [P3904_HEAD, ORIGINAL_HEAD] }),
      "P3-904 security correction commit must have the immutable original HEAD as its only parent",
    );
    assertRejected(
      combinedResult({ before: [mergeMain()] }),
      "P3-904 combined merge-base mismatch",
    );
    assertRejected(
      variantResult({
        label: "merged-original",
        originalParents: (index, defaults, { extra }) =>
          index === 5
            ? [
                ORIGINAL_COMMITS[4],
                extra(ORIGINAL_COMMITS[4], { "apps/web/tests/s.txt": "s\n" }),
              ]
            : defaults,
      }),
      "P3-003 original commit count mismatch",
    );
  });

  test("(20) the exception cannot be claimed by another branch or history", () => {
    const fixture = combined();
    const recovery = fixture.recovery();
    assertRejected(
      recovery.run({ branch: `${CORRECTION_BRANCH}-v2` }),
      `Packet commit is not the first commit on the branch (earlier commit: ${BUILDER_PACKET_COMMIT})`,
    );
    assertRejected(
      recovery.run({
        approvedRef: ORIGINAL_APPROVAL_REF,
        branch: ORIGINAL_BRANCH,
      }),
      `${P3_904_PACKET_PATH} is outside this work item's writable area`,
      `new migration ${P3904_MIGRATION} but Packet says MIGRATIONS: none`,
      `${GOVERNANCE.register} (M) is inside FORBIDDEN_SCOPE`,
    );
    assertRejected(
      recovery.run({ branch: "wi/P3-905-p3-003-security-correction" }),
      "Packet docs/work-items/P3-905/PACKET.md missing at head",
    );
    for (const branch of [
      "wi/P3-904-P3-003-SECURITY-CORRECTION",
      `refs/heads/${CORRECTION_BRANCH}`,
      `${CORRECTION_BRANCH} `,
    ]) {
      assertRejected(
        recovery.run({ branch }),
        `branch '${branch}' is not wi/<ID>[-slug]`,
      );
    }
    // A compliant, unrelated single-Packet history named like the exception.
    const ordinary = ordinaryRepo();
    const item = ordinary.workItem();
    assertRejected(
      runGuard(ordinary.repo, [
        ordinary.base,
        item.head,
        CORRECTION_BRANCH,
        item.approvedRef,
      ]),
      "P3-904 combined merge-base mismatch",
    );
  });

  test("an uncorrected P3-003 already in the PR base disables the exception", () => {
    const fixture = combined();
    const recovery = fixture.recovery();
    const poisoned = fixture.repo.child(
      [fixture.main, ORIGINAL_HEAD],
      {},
      "main with uncorrected P3-003 merged",
    );
    assertRejected(
      recovery.run({ base: poisoned }),
      "P3-904 combined merge-base mismatch",
    );
  });
});

describe("P2-915 single migration-correction exception (Packet §4, §6)", () => {
  const withSecurity = (changes, options = {}) =>
    combinedResult({ security: changes, ...options });
  const RENAMED = P3904_MIGRATION.replace(".sql", "_v2.sql");
  const CASE_ALIAS = P3904_MIGRATION.replace("_p3_904_", "_P3_904_");

  test("an unrelated or second new migration fails (exactly one filename)", () => {
    const second = "supabase/migrations/20261107000000_p3_904_second.sql";
    assertRejected(
      withSecurity({ ...DEFAULT_SECURITY, [second]: "select 2;\n" }),
      `P3-904 additional migration not permitted: ${second}`,
    );
    const misplaced = "supabase/migrations/20261106000000_p3_904_extra.txt";
    assertRejected(
      withSecurity({ ...DEFAULT_SECURITY, [misplaced]: "select 2;\n" }),
      `P3-904 additional migration not permitted: ${misplaced}`,
    );
  });

  test("an edit of the sole migration before the pinned original HEAD fails", () => {
    assertRejected(
      variantResult({
        label: "migration-edited-early",
        p3904Extra: { 2: { [P3904_MIGRATION]: "-- early edit\n" } },
      }),
      `P3-904 migration change before the pinned original HEAD: ${P3904_MIGRATION} (M)`,
    );
    assertRejected(
      variantResult({
        label: "migration-wrong-original",
        p3904Extra: { 1: { [P3904_MIGRATION]: "-- other original bytes\n" } },
      }),
      "P3-904 migration not introduced by the pinned commit with the pinned blob",
    );
    // Introduced by the second immutable commit instead of the pinned first.
    assertRejected(
      variantResult({
        label: "migration-introduced-late",
        p3904Replace: {
          1: {
            "apps/web/tests/m4-db-proof.mjs": "// fixture: updated proof\n",
          },
          2: {
            ...P3904_CHANGES[2],
            [P3904_MIGRATION]: { oid: P3904_MIGRATION_BLOB },
          },
        },
      }),
      `P3-904 migration change before the pinned original HEAD: ${P3904_MIGRATION} (A)`,
    );
  });

  test("a second modification fails", () => {
    assertRejected(
      combinedResult({
        admin: {
          ...registration(),
          [P3904_MIGRATION]: `${FIXTURE_CORRECTION_SQL}-- second edit\n`,
        },
      }),
      `P3-904 migration change outside the single permitted correction commit: ${P3904_MIGRATION} (M)`,
    );
    assertRejected(
      combinedResult({
        before: [{ [P3904_MIGRATION]: "-- first edit\n" }],
      }),
      "P3-904 recovery must be exactly one security and one administrative commit after the immutable chain (found 3)",
    );
  });

  test("delete, rename, re-add and case alias fail", () => {
    assertRejected(
      withSecurity({ ...DEFAULT_SECURITY, [P3904_MIGRATION]: null }),
      `P3-904 migration deleted: ${P3904_MIGRATION}`,
    );
    assertRejected(
      withSecurity({
        ...DEFAULT_SECURITY,
        [P3904_MIGRATION]: null,
        [RENAMED]: FIXTURE_CORRECTION_SQL,
      }),
      `P3-904 migration deleted: ${P3904_MIGRATION}`,
    );
    assertRejected(
      variantResult({
        label: "migration-readded",
        p3904Extra: {
          2: { [P3904_MIGRATION]: null },
          3: { [P3904_MIGRATION]: { oid: P3904_MIGRATION_BLOB } },
        },
      }),
      `P3-904 migration change before the pinned original HEAD: ${P3904_MIGRATION} (D)`,
    );
    assertRejected(
      combinedResult({
        security: { ...DEFAULT_SECURITY, [P3904_MIGRATION]: null },
        admin: {
          ...registration(),
          [P3904_MIGRATION]: FIXTURE_CORRECTION_SQL,
        },
      }),
      `P3-904 migration deleted: ${P3904_MIGRATION}`,
    );
    assertRejected(
      withSecurity({
        ...DEFAULT_SECURITY,
        [P3904_MIGRATION]: null,
        [CASE_ALIAS]: FIXTURE_CORRECTION_SQL,
      }),
      `P3-904 migration case alias: ${CASE_ALIAS} (A)`,
    );
    assertRejected(
      withSecurity({ ...DEFAULT_SECURITY, [CASE_ALIAS]: "select 1;\n" }),
      `case-insensitive path collision: ${P3904_MIGRATION.toLowerCase()}`,
    );
  });

  test("revert and mode change fail", () => {
    const { [P3904_MIGRATION]: _omitted, ...withoutMigration } =
      DEFAULT_SECURITY;
    assertRejected(
      withSecurity(withoutMigration),
      "P3-904 requires exactly one correction of the original migration (found 0)",
    );
    assertRejected(
      combinedResult({
        admin: {
          ...registration(),
          [P3904_MIGRATION]: { oid: P3904_MIGRATION_BLOB },
        },
      }),
      `P3-904 migration change outside the single permitted correction commit: ${P3904_MIGRATION} (M)`,
    );
    assertRejected(
      withSecurity({
        ...DEFAULT_SECURITY,
        [P3904_MIGRATION]: { mode: "100755", content: FIXTURE_CORRECTION_SQL },
      }),
      "P3-904 migration mode change: 100644 -> 100755",
    );
    assertRejected(
      withSecurity({
        ...withoutMigration,
        [P3904_MIGRATION]: { mode: "100755", oid: P3904_MIGRATION_BLOB },
      }),
      "P3-904 migration mode change: 100644 -> 100755",
    );
  });

  test("a non-canonical migration directory fails", () => {
    const upper = P3904_MIGRATION.replace("supabase/", "Supabase/");
    assertRejected(
      withSecurity({ ...DEFAULT_SECURITY, [upper]: "select 1;\n" }),
      `${upper}: migrations path with non-canonical case`,
    );
  });

  test("the single edit passes only with protected P2-915 provenance and owner approval", () => {
    assertRejected(
      variantResult({ label: "no-p2915", p2915: "absent" }),
      "P2-915 PROCESS Packet commit is not integrated into the PR base (protected Owner main)",
    );
    const recovery = combined().recovery();
    const missing = recovery.run({ comments: [] });
    assertRejected(
      missing,
      "P2-915 approval: no owner approval comment on this pull request",
    );
    const approval = comment(recovery.body());
    assertRecoveryPass(
      recovery.run({ comments: [approval] }),
      recovery,
      approval,
    );
  });
});

describe("P2-915 PROCESS provenance (Packet §4, §5)", () => {
  test("P2-915 must be protected-merged into the PR base, never supplied by the PR", () => {
    assertRejected(
      variantResult({ label: "p2915-absent", p2915: "absent" }),
      "P2-915 PROCESS Packet commit is not integrated into the PR base (protected Owner main)",
    );
    // An identical Packet on main under any other commit is not the adopted one.
    assertRejected(
      variantResult({ label: "p2915-unpinned", p2915: "unpinned" }),
      "P2-915 PROCESS Packet commit is not integrated into the PR base (protected Owner main)",
    );
    // A PR-supplied copy of the PROCESS Packet does not substitute for it.
    assertRejected(
      variantResult(
        { label: "p2915-in-pr", p2915: "absent" },
        {
          security: {
            ...DEFAULT_SECURITY,
            [P2915_PACKET_PATH]: { oid: P2915_PACKET_BLOB },
          },
        },
      ),
      "P2-915 PROCESS Packet commit is not integrated into the PR base (protected Owner main)",
    );
    // The original base itself predates P2-915.
    const recovery = combined().recovery();
    assertRejected(
      recovery.run({ base: ORIGINAL_BASE }),
      "P2-915 PROCESS Packet commit is not integrated into the PR base (protected Owner main)",
    );
  });

  test("an altered P2-915 Packet on owner main is rejected", () => {
    assertRejected(
      variantResult({
        label: "p2915-altered",
        mainAfter: (main, repo) =>
          repo.child(
            [main],
            { [P2915_PACKET_PATH]: "P2-915 Packet altered on main\n" },
            "altered PROCESS Packet",
          ),
      }),
      "P2-915 PROCESS Packet blob on the PR base differs from the adopted Packet",
    );
  });

  test("caller-controlled environment cannot substitute for provenance or approval", () => {
    const spoof = {
      ROSUNO_P2915_APPROVED: "1",
      P2915_PACKET_COMMIT: "1".repeat(40),
      P2915_PACKET_BLOB: P2915_PACKET_BLOB,
      APPROVAL: "OK",
      OWNER_ID: String(FIXTURE_OWNER_ID),
    };
    assertRejected(
      buildCombinedRepo({ label: "p2915-env", p2915: "absent" })
        .recovery()
        .run({ env: spoof }),
      "P2-915 PROCESS Packet commit is not integrated into the PR base (protected Owner main)",
    );
    assertRejected(
      combined().recovery().run({ comments: [], env: spoof }),
      "P2-915 approval: no owner approval comment on this pull request",
    );
  });
});

describe("P2-915 administrative registration commit (Packet §5 items 1-4)", () => {
  const withAdmin = (admin, options = {}) =>
    combinedResult({ admin, ...options });
  const reg = (options) => registration(options);

  test("governance edits outside the final administrative commit fail", () => {
    assertRejected(
      combinedResult({
        security: { ...DEFAULT_SECURITY, ...reg() },
        admin: { "apps/web/tests/after.test.ts": "// after\n" },
      }),
      `${GOVERNANCE.register} (M) is inside FORBIDDEN_SCOPE`,
    );
  });

  test("the administrative commit changes exactly the three governance paths", () => {
    assertRejected(
      withAdmin({ ...reg(), "apps/web/tests/fourth.test.ts": "// fourth\n" }),
      "P2-915 administrative commit must change exactly the three governance paths",
    );
    assertRejected(
      withAdmin({ ...reg(), "governance/README.md": "fourth path\n" }),
      "P2-915 administrative commit must change exactly the three governance paths",
    );
    const { [GOVERNANCE.decisions]: _omitted, ...twoPaths } = reg();
    assertRejected(
      withAdmin(twoPaths),
      "P2-915 administrative commit must change exactly the three governance paths",
    );
    assertRejected(
      withAdmin({
        ...reg(),
        [GOVERNANCE.decisions]: {
          mode: "100755",
          content: reg()[GOVERNANCE.decisions],
        },
      }),
      `P2-915 administrative commit must modify ${GOVERNANCE.decisions} in place as a regular file (M 100644 -> 100755)`,
    );
    assertRejected(
      withAdmin({ ...reg(), [GOVERNANCE.decisions]: null }),
      `P2-915 administrative commit must modify ${GOVERNANCE.decisions} in place as a regular file (D 100644 -> 000000)`,
    );
  });

  test("a missing, split, extra or misplaced administrative commit fails", () => {
    assertRejected(
      withAdmin(null),
      "P3-904 administrative registration commit missing",
    );
    const all = reg();
    assertRejected(
      withAdmin(
        {
          [GOVERNANCE.register]: all[GOVERNANCE.register],
          [GOVERNANCE.workItems]: all[GOVERNANCE.workItems],
        },
        { after: [{ [GOVERNANCE.decisions]: all[GOVERNANCE.decisions] }] },
      ),
      "P3-904 recovery must be exactly one security and one administrative commit after the immutable chain (found 3)",
    );
    assertRejected(
      withAdmin(reg(), {
        after: [{ "apps/web/tests/late.test.ts": "// l\n" }],
      }),
      "P3-904 recovery must be exactly one security and one administrative commit after the immutable chain (found 3)",
    );
    // Administrative commit whose parent is not the security commit.
    assertRejected(
      combinedResult({ security: null }),
      "P3-904 administrative registration commit missing",
    );
    assertRejected(
      combinedResult({
        adminParents: [P3904_HEAD],
        security: DEFAULT_SECURITY,
      }),
      /P3-904 (?:recovery must be exactly|administrative registration commit missing|requires exactly one correction)/,
    );
  });

  test("the register entry must be the exact pending, unapplied, unreleased candidate", () => {
    const reject = (migration, message) =>
      assertRejected(
        withAdmin(reg({ migration })),
        `P2-915 registration: ${message}`,
      );
    const state =
      "appended migration is not in the pending, unapplied, unreleased reviewed-candidate state";
    reject({ reviewed: true }, state);
    reject({ reviewed_by: "Rosuno" }, state);
    reject({ reviewed_at: "2026-11-08T00:00:00Z" }, state);
    reject({ applied_environment: "staging" }, state);
    reject({ release_refs: ["REL-20261108-FABRICATED"] }, state);
    const fields =
      "appended migration must have exactly the reviewed-register fields";
    reject({ unexpected_field: true }, fields);
    reject({ drift_check: undefined }, fields);
    const identity = "appended migration is not the single P3-904 migration";
    reject({ migration_id: "20261106090000_p3_904_other" }, identity);
    reject({ artifact_path: "supabase/migrations/other.sql" }, identity);
    reject({ migration_kind: "baseline" }, identity);
    reject(
      { sequence: 3 },
      "appended migration sequence is not its register position",
    );
  });

  test("malformed or non-reciprocal register references fail", () => {
    const reject = (options, message) =>
      assertRejected(
        withAdmin(reg(options)),
        `P2-915 registration: ${message}`,
      );
    reject(
      { migration: { work_item_refs: ["WI-P0-001-FIXTURE"] } },
      "migration work_item_refs must name exactly the appended work item",
    );
    reject(
      {
        migration: {
          work_item_refs: [ADMIN_WORK_ITEM_ID, "WI-P0-001-FIXTURE"],
        },
      },
      "migration work_item_refs must name exactly the appended work item",
    );
    reject(
      { migration: { decision_refs: ["DEC-20260101-FIXTURE"] } },
      "migration decision_refs must name exactly the appended decision",
    );
    reject(
      { workItem: { migration_refs: [] } },
      "appended work item migration_refs must name exactly the P3-904 migration",
    );
    reject(
      { workItem: { release_refs: ["REL-20261108-FABRICATED"] } },
      "appended work item must not claim a release",
    );
    reject(
      { workItem: { decision_refs: [] } },
      "appended work item does not reference the appended decision",
    );
    reject(
      { decision: { work_item_refs: ["WI-P0-001-FIXTURE"] } },
      "appended decision does not reference the appended work item",
    );
    reject(
      {
        workItem: { work_item_id: "WI-P0-001-FIXTURE" },
        migration: { work_item_refs: ["WI-P0-001-FIXTURE"] },
        decision: { work_item_refs: ["WI-P0-001-FIXTURE"] },
      },
      "appended work item id collides",
    );
    reject(
      {
        decision: { decision_id: "DEC-20260101-FIXTURE" },
        migration: { decision_refs: ["DEC-20260101-FIXTURE"] },
        workItem: { decision_refs: ["DEC-20260101-FIXTURE"] },
      },
      "appended decision id collides",
    );
    reject(
      { workItem: { work_item_id: undefined } },
      "appended work item lacks a work_item_id",
    );
  });

  test("registers are append-only: exactly one appended record, no rewrites", () => {
    const all = reg();
    const twice = appendRecord(all[GOVERNANCE.workItems], {
      ...candidateWorkItem(),
      work_item_id: "WI-P2-999-SECOND",
    });
    assertRejected(
      withAdmin({ ...all, [GOVERNANCE.workItems]: twice }),
      "P2-915 registration: work-items/index.json must append exactly one record (delta 2)",
    );
    const rewrites = (file) =>
      `P2-915 administrative commit rewrites existing bytes of ${file} (append-only: one record after the last existing record)`;
    // Rewriting an existing record (here: a historical review outcome).
    const rewritten = all[GOVERNANCE.register].replace(
      '"reviewed_by": "Fixture Reviewer"',
      '"reviewed_by": "Someone Else"',
    );
    assertRejected(
      withAdmin({ ...all, [GOVERNANCE.register]: rewritten }),
      rewrites(GOVERNANCE.register),
    );
    // Reformatting the whole file is a byte rewrite even if semantically equal.
    const minified = `${JSON.stringify(JSON.parse(all[GOVERNANCE.decisions]))}\n`;
    assertRejected(
      withAdmin({ ...all, [GOVERNANCE.decisions]: minified }),
      rewrites(GOVERNANCE.decisions),
    );
    // A whitespace-only change of one existing line is still a rewrite.
    const indented = all[GOVERNANCE.workItems].replace(
      '      "title": "Historical fixture work item"',
      '       "title": "Historical fixture work item"',
    );
    assertRejected(
      withAdmin({ ...all, [GOVERNANCE.workItems]: indented }),
      rewrites(GOVERNANCE.workItems),
    );
    // A non-record field changed, with or without an appended record.
    const version = BASE_GOVERNANCE.decisions.replace(
      '"version": 1',
      '"version": 2',
    );
    assertRejected(
      withAdmin({ ...all, [GOVERNANCE.decisions]: version }),
      rewrites(GOVERNANCE.decisions),
    );
    const keyed = all[GOVERNANCE.workItems].replace(
      "{\n",
      '{\n  "added": true,\n',
    );
    assertRejected(
      withAdmin({ ...all, [GOVERNANCE.workItems]: keyed }),
      rewrites(GOVERNANCE.workItems),
    );
    // A new top-level key smuggled in after the array keeps the byte prefix
    // but is still rejected semantically.
    const closing = "\n  ]\n}\n";
    const trailing = `${all[GOVERNANCE.workItems].slice(0, -closing.length)}\n  ],\n  "added": [\n  ]\n}\n`;
    assertRejected(
      withAdmin({ ...all, [GOVERNANCE.workItems]: trailing }),
      "P2-915 registration: work-items/index.json top-level keys changed",
    );
  });

  test("invalid JSON fails", () => {
    const all = reg();
    const closing = "\n  ]\n}\n";
    const broken = `${BASE_GOVERNANCE.decisions.slice(0, -closing.length)},\n    { "decision_id": }${closing}`;
    assertRejected(
      withAdmin({ ...all, [GOVERNANCE.decisions]: broken }),
      "P2-915 governance registers are not valid JSON",
    );
    assertRejected(
      withAdmin({
        ...all,
        [GOVERNANCE.decisions]: `${all[GOVERNANCE.decisions]}{}\n`,
      }),
      `P2-915 administrative commit rewrites existing bytes of ${GOVERNANCE.decisions}`,
    );
  });

  test("a registration cannot be pre-staged in the security commit", () => {
    const preregistered = {
      ...BASE_GOVERNANCE,
      register: appendRecord(BASE_GOVERNANCE.register, candidateMigration()),
    };
    assertRejected(
      combinedResult({
        security: {
          ...DEFAULT_SECURITY,
          [GOVERNANCE.register]: preregistered.register,
        },
        admin: registration({
          base: preregistered,
          migration: { sequence: 3 },
        }),
      }),
      `${GOVERNANCE.register} (M) is inside FORBIDDEN_SCOPE`,
    );
  });

  test("registers on the PR base must equal the pre-registration state (no drift)", () => {
    assertRejected(
      variantResult({
        label: "governance-drift",
        mainAfter: (main, repo) =>
          repo.child(
            [main],
            {
              [GOVERNANCE.decisions]: appendRecord(BASE_GOVERNANCE.decisions, {
                decision_id: "DEC-20261109-OTHER",
                title: "Other owner-main decision",
                work_item_refs: ["WI-P0-001-FIXTURE"],
              }),
            },
            "other governance registration on main",
          ),
      }),
      `P2-915 registration base drift: ${GOVERNANCE.decisions} on the PR base differs from the pre-registration P3-904 state`,
    );
  });

  test("structural registration failures never query the GitHub API", () => {
    const result = withAdmin(reg({ migration: { reviewed: true } }));
    assertRejected(result, "P2-915 registration:");
    assert.deepEqual(result.calls, []);
  });
});

describe("P2-915 separately authenticated owner approval (Packet §5, §6)", () => {
  const fresh = () => combined().recovery();

  test("no comment, or only the adopted PROCESS Packet, fails", () => {
    const recovery = fresh();
    assertRejected(
      recovery.run({ comments: [] }),
      "P2-915 approval: no owner approval comment on this pull request",
    );
    assertRejected(
      recovery.run({
        comments: [comment("Approved P2-915; please proceed with P3-904.")],
      }),
      "P2-915 approval: no owner approval comment on this pull request",
    );
  });

  test("non-owner, forged-login and wrong numeric ID approvals fail", () => {
    const recovery = fresh();
    const body = recovery.body();
    assertRejected(
      recovery.run({
        comments: [comment(body, { login: "someone-else", id: 77 })],
      }),
      "is not authored by the verified owner account (someone-else, id 77); ambiguous",
    );
    assertRejected(
      recovery.run({ comments: [comment(body, { id: 77 })] }),
      `is not authored by the verified owner account (${OWNER_LOGIN}, id 77); ambiguous`,
    );
    assertRejected(
      recovery.run({
        comments: [comment(body, { login: "NatthanPrevot-old" })],
      }),
      `is not authored by the verified owner account (NatthanPrevot-old, id ${FIXTURE_OWNER_ID})`,
    );
    // A valid owner approval plus a third-party marker comment is ambiguous.
    assertRejected(
      recovery.run({
        comments: [
          comment(body),
          comment(body, { login: "someone-else", id: 77 }),
        ],
      }),
      "is not authored by the verified owner account (someone-else, id 77)",
    );
    // Forged identity inside PR-controlled content never authenticates.
    assertRejected(
      recovery.run({
        comments: [],
        routes: (api) => {
          api[API.pull].pages[0].body = `user.login: ${OWNER_LOGIN}\n${body}`;
        },
      }),
      "P2-915 approval: governance marker in the pull request title or description",
    );
    const inCommit = combined().recovery({
      adminMessage: `registration\n\n${body}`,
    });
    assertRejected(
      inCommit.run({ comments: [] }),
      "P2-915 approval: no owner approval comment on this pull request",
    );
  });

  test("the owner account and PR author are verified by numeric ID", () => {
    const recovery = fresh();
    for (const user of [
      { login: OWNER_LOGIN, id: FIXTURE_OWNER_ID, type: "Organization" },
      { login: "someone-else", id: FIXTURE_OWNER_ID, type: "User" },
      { login: OWNER_LOGIN, id: String(FIXTURE_OWNER_ID), type: "User" },
      { login: OWNER_LOGIN, type: "User" },
    ]) {
      assertRejected(
        recovery.run({
          routes: (api) => {
            api[API.user].pages = [user];
          },
        }),
        "P2-915 approval: owner account identity could not be verified",
      );
    }
    assertRejected(
      recovery.run({
        routes: (api) => {
          api[API.pull].pages[0].user = { login: OWNER_LOGIN, id: 77 };
        },
      }),
      "P2-915 approval: pull request author is not the verified owner account",
    );
  });

  test("duplicate, edited, ambiguous or revoked approvals fail", () => {
    const recovery = fresh();
    const body = recovery.body();
    assertRejected(
      recovery.run({ comments: [comment(body), comment(body)] }),
      "P2-915 approval: 2 owner approval comments (duplicate or conflicting)",
    );
    const edited = comment(body, { updatedAt: "2026-11-08T10:05:00Z" });
    assertRejected(
      recovery.run({ comments: [edited] }),
      `P2-915 approval: approval comment ${edited.id} was edited after creation`,
    );
    for (const text of [
      APPROVAL_MARKER.toLowerCase(),
      APPROVAL_MARKER.replace("-V1", "-V2"),
      "ROSUNO-P2-915-P3-904-GOVERNANCE-HOLD",
    ]) {
      const other = comment(`${text}\nsee above`);
      assertRejected(
        recovery.run({ comments: [comment(body), other] }),
        `P2-915 approval: unrecognized or conflicting owner governance marker in comment ${other.id}`,
      );
    }
    assertRejected(
      recovery.run({ comments: [comment(body), comment(REVOCATION_MARKER)] }),
      "P2-915 approval: current owner revocation comment present",
    );
    assertRejected(
      recovery.run({
        comments: [comment(`${body}\n${REVOCATION_MARKER.toLowerCase()}`)],
      }),
      "P2-915 approval: current owner revocation comment present",
    );
    assertRejected(
      recovery.run({
        routes: (api) => {
          api[API.reviews].pages = [[{ id: 55, body: REVOCATION_MARKER }]];
        },
      }),
      "P2-915 approval: governance marker in pull request review 55; approval and revocation are owner issue comments only (ambiguous)",
    );
    assertRejected(
      recovery.run({
        routes: (api) => {
          api[API.reviewComments].pages = [[], [{ id: 56, body }]];
        },
      }),
      "P2-915 approval: governance marker in pull request review comment 56",
    );
  });

  test("deletion or edit withdraws an approval; every run re-evaluates current comments", () => {
    // The guard keeps no state: each run reads the current comments. Whether
    // an earlier `success` status remains visible is a workflow and Gate 4
    // concern (Packet §5), which this local test cannot and does not prove.
    const recovery = fresh();
    const first = comment(recovery.body());
    assertRecoveryPass(recovery.run({ comments: [first] }), recovery, first);
    assertRejected(
      recovery.run({ comments: [] }),
      "P2-915 approval: no owner approval comment on this pull request",
    );
    assertRejected(
      recovery.run({
        comments: [{ ...first, updated_at: "2026-11-08T11:00:00Z" }],
      }),
      `P2-915 approval: approval comment ${first.id} was edited after creation`,
    );
    const renewed = comment(recovery.body(), {
      createdAt: "2026-11-08T12:00:00Z",
    });
    const result = recovery.run({ comments: [renewed] });
    assertRecoveryPass(result, recovery, renewed);
    assert.ok(result.stdout.includes(`comment_id=${renewed.id} `));
    assert.ok(!result.stdout.includes(`comment_id=${first.id} `));
  });

  test("abbreviated, generic, stale or wrong bound values fail", () => {
    const recovery = fresh();
    const other = combined().recovery({
      security: {
        ...DEFAULT_SECURITY,
        "apps/web/tests/other.test.ts": "// o\n",
      },
    });
    const mismatch = (overrides, line, key, transform = (body) => body) =>
      assertRejected(
        recovery.run({
          comments: [comment(transform(recovery.body(overrides)))],
        }),
        `does not bind the exact current values (first mismatch at line ${line}: expected ${key})`,
      );
    mismatch({ repository: "RosunoBackup/Rosuno" }, 2, "repository");
    mismatch({ pr: PR + 1 }, 3, "pull_request");
    mismatch({ branch: `${CORRECTION_BRANCH}-v2` }, 4, "branch");
    mismatch(
      { security: recovery.security.slice(0, 12) },
      5,
      "security_commit",
    );
    mismatch({ security: other.security }, 5, "security_commit");
    mismatch({ admin: recovery.admin.slice(0, 7) }, 6, "administrative_commit");
    mismatch({ head: other.head }, 7, "head");
    mismatch({ base: combined().mainP2914 }, 8, "base");
    mismatch(
      { blobs: { ...recovery.blobs, register: other.blobs.workItems } },
      9,
      GOVERNANCE.register,
    );
    mismatch(
      {
        blobs: {
          ...recovery.blobs,
          workItems: recovery.blobs.workItems.slice(0, 10),
        },
      },
      10,
      GOVERNANCE.workItems,
    );
    mismatch(
      { blobs: { ...recovery.blobs, decisions: "" } },
      11,
      GOVERNANCE.decisions,
    );
    mismatch({ scope: "approved" }, 12, "approval");
    mismatch(
      {},
      13,
      "<end of body>",
      (body) => `${body}\nAlso approve the rest.`,
    );
    mismatch({}, 2, "repository", () => `${APPROVAL_MARKER}\nLGTM`);
    mismatch({}, 1, APPROVAL_MARKER, (body) => ` ${body}`);
    mismatch({}, 1, APPROVAL_MARKER, (body) => `\`\`\`\n${body}\n\`\`\``);
  });

  test("stale or moved event and API identities fail", () => {
    const recovery = fresh();
    const other = combined().recovery();
    assertRejected(
      recovery.run({ env: { HEAD_SHA: other.head } }),
      "P2-915 approval: trusted event head differs from the checked head",
    );
    assertRejected(
      recovery.run({ env: { BASE_SHA: combined().mainP2914 } }),
      "P2-915 approval: trusted event base differs from the checked base",
    );
    const pull = (mutate, message) =>
      assertRejected(
        recovery.run({ routes: (api) => void mutate(api[API.pull].pages[0]) }),
        `P2-915 approval: ${message}`,
      );
    pull(
      (p) => (p.head.sha = other.head),
      "pull request head is not the checked head (stale or moved)",
    );
    pull(
      (p) => (p.base.sha = combined().mainP2914),
      "pull request base is not the checked base (stale or moved)",
    );
    pull((p) => (p.state = "closed"), "pull request is not open");
    pull((p) => (p.number = PR + 1), "pull request number mismatch");
    pull(
      (p) => (p.head.repo.full_name = "other/Rosuno"),
      "pull request head source mismatch",
    );
    pull(
      (p) => (p.head.ref = `${CORRECTION_BRANCH}-v2`),
      "pull request head source mismatch",
    );
    pull(
      (p) => (p.base.ref = "release"),
      "pull request base is not owner main",
    );
    pull(
      (p) => (p.base.repo.full_name = BUILDER_REPOSITORY),
      "pull request base is not owner main",
    );
  });

  test("trusted workflow inputs are required and never queried without them", () => {
    const recovery = fresh();
    const tokenVariable = "GH_TOKEN";
    const cases = [
      [
        { [tokenVariable]: undefined },
        "trusted workflow token unavailable (fail closed)",
      ],
      [
        { [tokenVariable]: "" },
        "trusted workflow token unavailable (fail closed)",
      ],
      [
        { REPO: BUILDER_REPOSITORY },
        "trusted workflow repository is not the owner repository",
      ],
      [
        { REPO: undefined },
        "trusted workflow repository is not the owner repository",
      ],
      [{ PR_NUMBER: undefined }, "trusted workflow PR number unavailable"],
      [{ PR_NUMBER: "7 " }, "trusted workflow PR number unavailable"],
      [{ PR_NUMBER: "07" }, "trusted workflow PR number unavailable"],
      [
        { HEAD_SHA: undefined },
        "trusted event head differs from the checked head",
      ],
      [
        { BASE_SHA: undefined },
        "trusted event base differs from the checked base",
      ],
    ];
    for (const [env, message] of cases) {
      const result = recovery.run({ env });
      assertRejected(result, `P2-915 approval: ${message}`);
      assert.deepEqual(result.calls, [], message);
    }
  });

  test("unavailable, paginated and error API responses fail closed", () => {
    const recovery = fresh();
    const approval = comment(recovery.body());
    const run = (routes, env) =>
      recovery.run({ comments: [approval], routes, env });
    assertRejected(
      run(undefined, { FAKE_GH_FIXTURE: undefined }),
      `P2-915 approval: GitHub API request failed for ${API.user} (fail closed): fake gh: no fixture (API unavailable)`,
    );
    assertRejected(
      run((api) => void delete api[API.user]),
      `P2-915 approval: GitHub API request failed for ${API.user} (fail closed): HTTP 404`,
    );
    assertRejected(
      run((api) => void (api[API.pull].failAtPage = 0)),
      `P2-915 approval: GitHub API request failed for ${API.pull} (fail closed): HTTP 502`,
    );
    assertRejected(
      run((api) => void (api[API.reviews].failAtPage = 0)),
      `P2-915 approval: GitHub API request failed for ${API.reviews} (fail closed)`,
    );
    // Error on page 2 after page 1 (holding the approval) was written.
    assertRejected(
      run((api) => {
        api[API.comments].pages = [[approval], [comment("later")]];
        api[API.comments].failAtPage = 1;
        api[API.comments].status = 403;
      }),
      `P2-915 approval: GitHub API request failed for ${API.comments} (fail closed): HTTP 403`,
    );
    // A revocation on the last page is still seen.
    assertRejected(
      run((api) => {
        api[API.comments].pages = [
          [approval],
          [],
          [comment(REVOCATION_MARKER)],
        ];
      }),
      "P2-915 approval: current owner revocation comment present",
    );
    assertRejected(
      run(
        (api) => void (api[API.comments].pages = ["<html>rate limited</html>"]),
      ),
      "P2-915 approval: comment response is not valid JSON (fail closed)",
    );
    assertRejected(
      run((api) => void (api[API.comments].pages = [{ message: "Not Found" }])),
      "P2-915 approval: comment page is not a JSON array",
    );
    assertRejected(
      run(
        (api) =>
          void (api[API.comments].pages = [[{ ...approval, user: null }]]),
      ),
      "P2-915 approval: malformed comment record",
    );
    assertRejected(
      run((api) => void (api[API.comments].pages = [[approval], [approval]])),
      "P2-915 approval: duplicate comment ids in the paginated response",
    );
    assertRejected(
      run((api) => void (api[API.user].pages = ["not json"])),
      "P2-915 approval: owner account response unreadable",
    );
    assertRejected(
      run((api) => void (api[API.user].pages = [])),
      "P2-915 approval: owner account identity could not be verified",
    );
    assertRejected(
      run((api) => void (api[API.pull].pages = ["{"])),
      "P2-915 approval: pull request response unreadable",
    );
    assertRejected(
      run((api) => void (api[API.reviews].pages = [{ message: "Forbidden" }])),
      "P2-915 approval: pull request review response is not valid (fail closed)",
    );
  });
});

// Ordinary single-work-item fixture: the unchanged normal guard path.
function ordinaryPacket(base, overrides = {}) {
  return packetText({
    id: "P9-914",
    type: "FEATURE",
    branch: ORDINARY_BRANCH,
    base,
    migrations: "none",
    allowed: ["apps/web/src/*", "apps/web/tests/*"],
    forbidden: [
      "apps/web/src/vendor/*",
      ".github/*",
      "docs/work-items/*",
      "supabase/*",
      ".env",
      ".env.*",
    ],
    ...overrides,
  });
}

let sharedOrdinary;
function ordinaryRepo() {
  if (sharedOrdinary) return sharedOrdinary;
  const repo = createRepo("ordinary");
  const base = repo.root(
    {
      "README.md": "Disposable ordinary guard fixture.\n",
      "apps/web/src/legacy.ts": "export const legacy = 1;\n",
      [HISTORICAL_MIGRATION]: "-- historical migration fixture\nselect 1;\n",
    },
    "ordinary base",
  );
  repo.ref("refs/heads/main", base);
  const later = repo.child([base], { "README.md": "later main\n" }, "main 2");
  let approvals = 0;
  sharedOrdinary = {
    repo,
    base,
    later,
    workItem({
      from = base,
      packetText: text = ordinaryPacket(from),
      packet = true,
      before = [],
      packetExtra = {},
      steps = [{ "apps/web/src/feature.ts": "export const feature = 1;\n" }],
      approval = "same",
      approvalPacketText,
    } = {}) {
      let tip = from;
      for (const changes of before) tip = repo.child([tip], changes, "early");
      const blob = repo.blob(text);
      if (packet) {
        tip = repo.child(
          [tip],
          { [ORDINARY_PACKET_PATH]: { oid: blob }, ...packetExtra },
          "Packet",
        );
      }
      for (const step of steps) {
        if (step[MERGE_SIDE]) {
          const side = repo.child([tip], step[MERGE_SIDE], "side");
          tip = repo.child([tip, side], step[MERGE_SIDE], "merge side");
        } else {
          tip = repo.child([tip], step, "implementation");
        }
      }
      approvals += 1;
      const approvedRef = `refs/fixture/approved-${approvals}`;
      let approvedOid = null;
      if (approval === "same") {
        const approvalBlob =
          approvalPacketText === undefined
            ? blob
            : repo.blob(approvalPacketText);
        approvedOid = repo.child(
          [base],
          { [ORDINARY_PACKET_PATH]: { oid: approvalBlob } },
          "owner approval",
        );
        repo.ref(approvedRef, approvedOid);
      } else if (approval === "no-packet") {
        repo.ref(approvedRef, base);
      }
      return {
        head: tip,
        approvedRef,
        approvedOid,
        packetText: text,
        run: ({ guardBase = base, branch = ORDINARY_BRANCH, env } = {}) =>
          runGuard(repo, [guardBase, tip, branch, approvedRef], env),
      };
    },
  };
  return sharedOrdinary;
}

describe("P2-914 ordinary single-work-item guard path is preserved", () => {
  test("a compliant ordinary work item still passes with one ordinary PASS", () => {
    const ordinary = ordinaryRepo();
    const item = ordinary.workItem({
      steps: [
        { "apps/web/src/feature.ts": "export const feature = 1;\n" },
        { "apps/web/src/app.env.example": "PLACEHOLDER=\n" },
        { "apps/web/tests/feature.test.ts": "// ordinary test\n" },
      ],
    });
    const result = item.run();
    assert.equal(result.status, 0, result.output);
    assert.equal(result.stderr, "", result.output);
    assert.deepEqual(result.stdout.split("\n").filter(Boolean), [
      `ROSUNO-GUARD PASS work_item=P9-914 packet_sha256=${sha256(item.packetText)} base=${ordinary.base} head=${item.head} approved=${item.approvedOid}`,
    ]);
    // Caller-controlled environment cannot select the combined path.
    const switched = item.run({
      env: {
        HEAD_REF: CORRECTION_BRANCH,
        BRANCH: CORRECTION_BRANCH,
        ROSUNO_COMBINED: "1",
        REPO: OWNER_REPOSITORY,
        PR_NUMBER: String(PR),
      },
    });
    assert.equal(switched.stdout, result.stdout, switched.output);
  });

  test("ordinary Packet-only and migration-allowed work items still pass", () => {
    const ordinary = ordinaryRepo();
    const packetOnly = ordinary.workItem({ steps: [] }).run();
    assert.equal(packetOnly.status, 0, packetOnly.output);
    assert.match(packetOnly.stdout, /^ROSUNO-GUARD PASS work_item=P9-914 /m);
    const migration = ordinary.workItem({
      packetText: ordinaryPacket(ordinary.base, {
        migrations: "new allowed",
        allowed: ["apps/web/src/*", "supabase/migrations/*"],
        forbidden: ["supabase/config.toml", ".env", ".env.*"],
      }),
      steps: [{ "supabase/migrations/20261106000000_new.sql": "select 1;\n" }],
    });
    const result = migration.run();
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /^ROSUNO-GUARD PASS work_item=P9-914 /m);
  });

  test("ordinary negative regressions still fail closed", () => {
    const ordinary = ordinaryRepo();
    const reject = (options, ...expected) =>
      assertRejected(ordinary.workItem(options).run(), ...expected);
    const step = (changes) => ({ steps: [changes] });

    // Missing, late or impure Packet.
    reject(
      { packet: false },
      `Packet ${ORDINARY_PACKET_PATH} missing at head or not a regular file`,
    );
    reject(
      { before: [{ "apps/web/src/early.ts": "early\n" }] },
      "Packet commit is not the first commit on the branch",
    );
    reject(
      { packetExtra: { "apps/web/src/extra.ts": "extra\n" } },
      "Packet commit must add only the Packet (it also changes other paths)",
    );
    // Wrong base.
    reject(
      { packetText: ordinaryPacket(ordinary.later) },
      `Packet BASE_SHA ${ordinary.later} is not the parent of the Packet commit`,
    );
    // Guard run against an older base than the Packet's own BASE_SHA.
    assertRejected(
      ordinary
        .workItem({ from: ordinary.later })
        .run({ guardBase: ordinary.base }),
      `Packet commit is not the first commit on the branch (earlier commit: ${ordinary.later})`,
    );
    // Wrong or missing owner approval.
    reject(
      {
        approvalPacketText: ordinaryPacket(ordinary.base, { migrations: "x" }),
      },
      `Packet differs from the owner-approved Packet on owner branch ${ORDINARY_BRANCH}`,
    );
    reject(
      { approval: "missing" },
      "approved Packet branch not found on the owner repository",
    );
    reject(
      { approval: "no-packet" },
      `owner branch ${ORDINARY_BRANCH} has no ${ORDINARY_PACKET_PATH}`,
    );
    // Forbidden, disallowed, process/kit and other work-item paths.
    reject(
      step({ "apps/web/src/vendor/lib.ts": "vendored\n" }),
      "[final diff] apps/web/src/vendor/lib.ts (A) is inside FORBIDDEN_SCOPE",
    );
    reject(
      step({ "apps/web/next.config.ts": "export default {};\n" }),
      "[final diff] apps/web/next.config.ts (A) is outside ALLOWED_SCOPE",
    );
    reject(
      {
        packetText: ordinaryPacket(ordinary.base, {
          allowed: ["apps/web/src/*", ".claude/*"],
        }),
        steps: [{ ".claude/settings.json": "{}\n" }],
      },
      ".claude/settings.json is process/kit scope; requires a TYPE: PROCESS work item",
    );
    reject(
      step({ "docs/work-items/P9-915/PACKET.md": "other\n" }),
      "docs/work-items/P9-915/PACKET.md is outside this work item's writable area",
    );
    reject(
      step({ ".gitmodules": "" }),
      ".gitmodules change (submodules not allowed)",
    );
    // Credential-like files.
    for (const file of [
      "apps/web/src/.env.local",
      "apps/web/src/deploy.pem",
      "apps/web/src/keys/id_ed25519",
    ]) {
      reject(
        step({ [file]: "PLACEHOLDER\n" }),
        `${file} looks like a secret/credential file`,
      );
    }
    // Symlink and gitlink modes.
    reject(
      step({ "apps/web/src/link.ts": { mode: "120000", content: "../x" } }),
      "apps/web/src/link.ts has git mode 120000",
    );
    reject(
      step({ "apps/web/src/sub": { mode: "160000", oid: ordinary.base } }),
      "apps/web/src/sub has git mode 160000",
    );
    // Case collisions.
    reject(
      step({
        "apps/web/src/feature.ts": "a\n",
        "apps/web/src/Feature.ts": "b\n",
      }),
      "case-insensitive path collision: apps/web/src/feature.ts",
    );
    reject(
      step({ "apps/web/src/legacy.ts": null, "apps/web/src/Legacy.ts": "x\n" }),
      "case-only change of an existing base path: apps/web/src/legacy.ts -> apps/web/src/Legacy.ts",
    );
    // Migrations.
    reject(
      step({ [HISTORICAL_MIGRATION]: "select 9;\n" }),
      `existing migration ${HISTORICAL_MIGRATION} changed or aliased (status M; forward-only)`,
    );
    reject(
      step({ "supabase/migrations/20261106000000_new.sql": "select 1;\n" }),
      "new migration supabase/migrations/20261106000000_new.sql but Packet says MIGRATIONS: none",
    );
    // Packet edits, history shape and reverted violations.
    reject(
      step({ [ORDINARY_PACKET_PATH]: "edited\n" }),
      "Packet changed after it was added (re-audit required)",
    );
    reject(
      { steps: [mergeSide({ "apps/web/src/side.ts": "side\n" })] },
      /merge commit [0-9a-f]{40} on the branch \(linear history required\)/,
    );
    const reverted = ordinary.workItem({
      steps: [
        { "apps/web/next.config.ts": "export default {};\n" },
        { "apps/web/next.config.ts": null },
      ],
    });
    const revertedResult = reverted.run();
    assertRejected(
      revertedResult,
      /\[commit [0-9a-f]{12}\] apps\/web\/next\.config\.ts \(A\) is outside ALLOWED_SCOPE/,
    );
    assert.doesNotMatch(revertedResult.output, /\[final diff\]/);
    // Invalid branch identifiers.
    const valid = ordinary.workItem();
    for (const branch of [
      "wi/p9-914-lower",
      "feature/P9-914",
      "wi/P9-91-short",
    ]) {
      assertRejected(
        valid.run({ branch }),
        `branch '${branch}' is not wi/<ID>[-slug]`,
      );
    }
  });
});

// The protected Owner-main guard exactly as it was before P2-915. It is present
// in full clones (CI checks out with fetch-depth 0). If it is unavailable, the
// test reports that and uses the current guard, whose dispatcher and complete
// normal_guard are separately asserted byte-identical to Owner main above.
function ownerMainGuard() {
  const blob = spawnSync(
    "git",
    ["-C", ROOT, "cat-file", "blob", OWNER_MAIN_GUARD_BLOB],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (blob.status !== 0) return null;
  assert.equal(sha256(blob.stdout), OWNER_MAIN_GUARD_SHA256);
  assert.equal(
    sha256(blob.stdout.slice(0, blob.stdout.indexOf(COMBINED_SECTION_START))),
    NORMAL_GUARD_PREFIX_SHA256,
  );
  const file = path.join(SANDBOX, "owner-main-rosuno-guard.sh");
  writeFileSync(file, blob.stdout);
  return file;
}

describe("P2-915 initial-PR enforcement by the unmodified Owner-main guard (Packet §3, §6)", () => {
  // The adopted P2-915 Packet header, rebased onto a disposable owner main.
  function p2915Fixture() {
    const repo = createRepo("p2-915-initial");
    const base = repo.root(
      {
        "README.md": "Disposable owner main for the P2-915 PR.\n",
        ".github/scripts/rosuno-guard.sh": "# owner guard stand-in\n",
        ".github/scripts/rosuno-guard-trust.sh": "# trust stand-in\n",
        ".github/workflows/rosuno-guard.yml": "name: rosuno-guard\n",
        "tools/p0/tests/p0-rosuno-guard-combined-history.test.mjs": "// t\n",
        [HISTORICAL_MIGRATION]: "select 1;\n",
        [GOVERNANCE.register]: BASE_GOVERNANCE.register,
        [GOVERNANCE.workItems]: BASE_GOVERNANCE.workItems,
        [GOVERNANCE.decisions]: BASE_GOVERNANCE.decisions,
      },
      "owner main",
    );
    const adopted = readFileSync(P2915_PACKET, "utf8");
    assert.match(adopted, new RegExp(`^BASE_SHA: ${OWNER_MAIN}$`, "m"));
    const text = adopted.replace(
      new RegExp(`^BASE_SHA: ${OWNER_MAIN}$`, "m"),
      `BASE_SHA: ${base}`,
    );
    let count = 0;
    return {
      run(steps, { packetExtra = {}, guard } = {}) {
        let tip = repo.child(
          [base],
          { [P2915_PACKET_PATH]: text, ...packetExtra },
          "P2-915 Packet",
        );
        for (const changes of steps) tip = repo.child([tip], changes, "P2-915");
        count += 1;
        const approvedRef = `refs/fixture/p2-915-approved-${count}`;
        repo.ref(
          approvedRef,
          repo.child([base], { [P2915_PACKET_PATH]: text }, "owner approval"),
        );
        return runGuard(
          repo,
          [base, tip, P2915_BRANCH, approvedRef],
          {},
          guard,
        );
      },
    };
  }
  const GUARD_EDIT = { ".github/scripts/rosuno-guard.sh": "# candidate\n" };
  const TEST_EDIT = {
    "tools/p0/tests/p0-rosuno-guard-combined-history.test.mjs": "// tests\n",
  };

  test("the adopted P2-915 Packet has exactly the two ALLOWED_SCOPE entries", () => {
    const adopted = readFileSync(P2915_PACKET, "utf8");
    const header = adopted.slice(0, adopted.indexOf("\n# "));
    const allowed = header
      .slice(
        header.indexOf("ALLOWED_SCOPE:\n") + 15,
        header.indexOf("FORBIDDEN_SCOPE:"),
      )
      .trim()
      .split("\n");
    assert.deepEqual(allowed, [
      "- .github/scripts/rosuno-guard.sh",
      "- tools/p0/tests/p0-rosuno-guard-combined-history.test.mjs",
    ]);
    assert.match(header, /^TYPE: PROCESS$/m);
    assert.match(header, /^MIGRATIONS: none$/m);
    assert.match(header, /^BRANCH: wi\/P2-915-p3-904-correction-integration$/m);
    for (const forbidden of [
      ".github/workflows/*",
      ".github/scripts/rosuno-guard-trust.sh",
      "supabase/*",
      "docs/work-items/*",
    ]) {
      assert.ok(header.includes(`\n- ${forbidden}\n`), forbidden);
    }
    assert.doesNotMatch(header, /governance/);
  });

  test("the Owner-main guard admits the two files and rejects every governance edit", (t) => {
    const ownerGuard = ownerMainGuard();
    if (!ownerGuard) {
      t.diagnostic(
        "Owner-main guard blob unavailable in this clone; ran the current guard, whose dispatcher and normal_guard are pinned byte-identical to Owner main",
      );
    }
    const fixture = p2915Fixture();
    // The unmodified Owner-main guard first, then the replacement guard: the
    // replacement adds no P2-915 branch allowance of any kind.
    for (const guard of [ownerGuard ?? GUARD, GUARD]) {
      const run = (steps, options = {}) =>
        fixture.run(steps, { ...options, guard });
      const compliant = run([GUARD_EDIT, TEST_EDIT]);
      assert.equal(compliant.status, 0, compliant.output);
      assert.equal(compliant.stderr, "", compliant.output);
      assert.match(compliant.stdout, /^ROSUNO-GUARD PASS work_item=P2-915 /m);
      assert.equal(run([]).status, 0, "Packet-only first commit");
      for (const file of Object.values(GOVERNANCE)) {
        assertRejected(
          run([GUARD_EDIT, { [file]: "{}\n" }]),
          `[final diff] ${file} (M) is outside ALLOWED_SCOPE`,
        );
      }
      assertRejected(
        run([registration(), GUARD_EDIT]),
        `[final diff] ${GOVERNANCE.register} (M) is outside ALLOWED_SCOPE`,
        `[final diff] ${GOVERNANCE.workItems} (M) is outside ALLOWED_SCOPE`,
        `[final diff] ${GOVERNANCE.decisions} (M) is outside ALLOWED_SCOPE`,
      );
      // Edited, then reverted: every commit is still checked on its own.
      const reverted = run([
        { [GOVERNANCE.workItems]: "{}\n" },
        { [GOVERNANCE.workItems]: BASE_GOVERNANCE.workItems },
        GUARD_EDIT,
      ]);
      assertRejected(
        reverted,
        /\[commit [0-9a-f]{12}\] governance\/work-items\/index\.json \(M\) is outside ALLOWED_SCOPE/,
      );
      assert.doesNotMatch(reverted.output, /\[final diff\]/);
      assertRejected(
        run([GUARD_EDIT], { packetExtra: { [GOVERNANCE.decisions]: "{}\n" } }),
        "Packet commit must add only the Packet (it also changes other paths)",
      );
      assertRejected(
        run([{ ".github/workflows/rosuno-guard.yml": "name: changed\n" }]),
        ".github/workflows/rosuno-guard.yml (M) is inside FORBIDDEN_SCOPE",
        ".github/workflows/rosuno-guard.yml (M) is outside ALLOWED_SCOPE",
      );
      assertRejected(
        run([{ ".github/scripts/rosuno-guard-trust.sh": "# changed\n" }]),
        ".github/scripts/rosuno-guard-trust.sh (M) is inside FORBIDDEN_SCOPE",
      );
      assertRejected(
        run([{ [P3904_MIGRATION]: "select 1;\n" }]),
        `${P3904_MIGRATION} (A) is inside FORBIDDEN_SCOPE`,
        `new migration ${P3904_MIGRATION} but Packet says MIGRATIONS: none`,
      );
      assertRejected(
        run([{ [P2915_PACKET_PATH]: "edited\n" }]),
        "Packet changed after it was added (re-audit required)",
      );
    }
    assert.doesNotMatch(
      readFileSync(GUARD, "utf8"),
      /P2-915-p3-904|wi\/P2-915/,
    );
  });
});

const workflowText = () => readFileSync(WORKFLOW, "utf8");
const workflowEnv = (name) => {
  const match = workflowText().match(new RegExp(`^ +${name}: (\\S+)$`, "m"));
  assert.ok(match, `workflow env ${name}`);
  return match[1];
};

// Extracts one step's `run: |` block exactly as GitHub Actions would run it.
function workflowRunBlock(stepName) {
  const lines = workflowText().split("\n");
  const start = lines.findIndex(
    (line) => line.trim() === `- name: ${stepName}`,
  );
  assert.ok(start >= 0, `workflow step ${stepName}`);
  const indentOf = (line) => line.search(/\S/);
  const stepIndent = indentOf(lines[start]);
  let run = start + 1;
  while (lines[run].trim() !== "run: |") {
    assert.ok(indentOf(lines[run]) === -1 || indentOf(lines[run]) > stepIndent);
    run += 1;
  }
  const body = [];
  for (let index = run + 1; index < lines.length; index += 1) {
    const indent = indentOf(lines[index]);
    if (indent !== -1 && indent <= indentOf(lines[run])) break;
    body.push(lines[index]);
  }
  while (body.at(-1)?.trim() === "") body.pop();
  const block = Math.min(...body.filter((l) => l.trim()).map(indentOf));
  return `${body.map((line) => line.slice(block)).join("\n")}\n`;
}

const FETCH_STEP = "Fetch PR head and the owner-approved Packet branch as data";

// Runs the trusted fetch step against a disposable bare "owner" repository.
// https://github.com/<owner repo>.git is rewritten to that local repository
// and GIT_ALLOW_PROTOCOL=file refuses every other transport.
function runFetchStep({ headRef, ownerRefs, prHead, base }) {
  const source = workflowFixture();
  const owner = createRepo("owner", { bare: true });
  for (const [ref, oid] of Object.entries(ownerRefs)) {
    source.repo.git(["push", "-q", owner.dir, `${oid}:${ref}`]);
  }
  const runner = createRepo("runner");
  runner.git([
    "fetch",
    "-q",
    "--no-tags",
    owner.dir,
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
  const script = path.join(SANDBOX, `${path.basename(runner.dir)}-step.sh`);
  writeFileSync(script, workflowRunBlock(FETCH_STEP));
  const repoName = workflowEnv("EXPECTED_REPO");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", script], {
    cwd: runner.dir,
    env: {
      ...runner.env,
      REPO: repoName,
      PR_NUMBER: "7",
      BASE_SHA: base,
      HEAD_SHA: prHead,
      HEAD_REF: headRef,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(owner.dir).href}.insteadOf`,
      GIT_CONFIG_VALUE_0: `https://github.com/${repoName}.git`,
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  const hasRef = (ref) =>
    spawnSync("git", ["rev-parse", "--verify", "-q", ref], {
      cwd: runner.dir,
      env: runner.env,
    }).status === 0;
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    hasRef,
  };
}

let sharedWorkflowFixture;
function workflowFixture() {
  if (sharedWorkflowFixture) return sharedWorkflowFixture;
  const repo = createRepo("workflow-source");
  const base = repo.root({ "README.md": "owner main\n" }, "owner main");
  const head = repo.child([base], { "apps/web/src/x.ts": "x\n" }, "PR head");
  const approval = repo.child([base], { "docs/a.txt": "a\n" }, "approval");
  const unpinned = repo.child([base], { "docs/b.txt": "b\n" }, "not ae9c644");
  sharedWorkflowFixture = { repo, base, head, approval, unpinned };
  return sharedWorkflowFixture;
}

function runTrust(event, openPrs) {
  const dir = path.join(SANDBOX, `trust-${(repositoryCount += 1)}`);
  mkdirSync(dir);
  writeFileSync(path.join(dir, "event.json"), JSON.stringify(event));
  writeFileSync(path.join(dir, "open-prs.txt"), `${openPrs.join("\n")}\n`);
  const result = spawnSync(
    "bash",
    [TRUST, path.join(dir, "event.json"), path.join(dir, "open-prs.txt")],
    {
      cwd: dir,
      env: {
        ...fixtureEnv(),
        EXPECTED_REPO: workflowEnv("EXPECTED_REPO"),
        EXPECTED_BASE: workflowEnv("EXPECTED_BASE"),
        BUILDER_FORK: workflowEnv("BUILDER_FORK"),
        OWNER_LOGIN: workflowEnv("OWNER_LOGIN"),
      },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("trusted workflow dependency (P2-914 Packet §4, P2-915 Packet §3, §6)", () => {
  test("workflow and trust binding are byte-identical to protected Owner main", () => {
    // P2-915 must not change either file; the guard consumes only inputs the
    // existing workflow already supplies.
    assert.equal(gitBlobId(readFileSync(WORKFLOW)), OWNER_MAIN_WORKFLOW_BLOB);
    assert.equal(gitBlobId(readFileSync(TRUST)), OWNER_MAIN_TRUST_BLOB);
  });

  test("the workflow supplies the token, owner repository, PR number and exact head/base", () => {
    const text = workflowText();
    const env = text.slice(
      text.indexOf("    env:\n"),
      text.indexOf("    steps:\n"),
    );
    for (const line of [
      "      GH_TOKEN: ${{ github.token }}",
      "      REPO: ${{ github.repository }}",
      "      PR_NUMBER: ${{ github.event.pull_request.number }}",
      "      BASE_SHA: ${{ github.event.pull_request.base.sha }}",
      "      HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
      `      EXPECTED_REPO: ${OWNER_REPOSITORY}`,
      `      OWNER_LOGIN: ${OWNER_LOGIN}`,
      `      BUILDER_FORK: ${BUILDER_REPOSITORY}`,
    ]) {
      assert.ok(env.includes(`${line}\n`), line);
    }
    assert.match(
      text,
      /^permissions:\n {2}contents: read\n {2}pull-requests: read\n {2}statuses: write\n/m,
    );
    assert.ok(
      text.includes(
        'run: bash .github/scripts/rosuno-guard.sh "$BASE_SHA" "$HEAD_SHA" "$HEAD_REF" refs/rosuno/approved\n',
      ),
    );
    // The default-branch checkout carries full history, so the P2-915
    // provenance commit in the PR base is available to the guard. Real
    // issue-comment read access with this token is NOT provable here.
    assert.ok(
      text.includes(
        "          fetch-depth: 0\n          persist-credentials: false\n",
      ),
    );
  });

  test("triggers, permissions, checkout, trust binding and status are unchanged", () => {
    const text = workflowText();
    const code = text
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    assert.match(
      text,
      /^on:\n {2}pull_request_target:\n {4}branches: \[main\]\n {4}types: \[opened, synchronize, reopened, ready_for_review, edited\]\npermissions:\n {2}contents: read\n {2}pull-requests: read\n {2}statuses: write\n/m,
    );
    assert.doesNotMatch(code, /^\s*(pull_request|workflow_dispatch|push):/m);
    assert.doesNotMatch(
      code,
      /allow-unsafe-pr-checkout|secrets\.|refs\/replace/,
    );
    // The only action is the default-branch checkout, without a PR ref.
    assert.deepEqual(code.match(/^ *- uses: .*$/gm), [
      "      - uses: actions/checkout@v4",
    ]);
    assert.match(
      code,
      / {6}- uses: actions\/checkout@v4\n {8}with:\n {10}fetch-depth: 0\n {10}persist-credentials: false\n {6}- name: Trust binding/,
    );
    assert.ok(
      code.includes(
        'bash .github/scripts/rosuno-guard-trust.sh "$GITHUB_EVENT_PATH" "$RUNNER_TEMP/open-prs.txt"',
      ),
    );
    const gate =
      "if: steps.trust.outputs.MODE == 'builder' || steps.trust.outputs.MODE == 'owner'";
    assert.equal(code.split(gate).length - 1, 3);
    assert.ok(
      code.includes(
        `${gate}\n        run: bash .github/scripts/rosuno-guard.sh "$BASE_SHA" "$HEAD_SHA" "$HEAD_REF" refs/rosuno/approved\n`,
      ),
    );
    assert.equal(code.split("context=rosuno-guard").length - 1, 2);
    assert.equal(code.split("S=success;").length - 1, 2);
    assert.ok(
      code.includes(
        'if [ "$TRUST" = success ] && [ "$MODE" = builder ] && [ "$OUTCOME" = success ]; then\n            S=success; D="PASS builder PR #$PR_NUMBER base $B"\n',
      ),
    );
    assert.ok(
      code.includes(
        'elif [ "$TRUST" = success ] && [ "$MODE" = owner ] && [ "$OUTCOME" = success ] && [ "$OWNER_OUTCOME" = success ] && [ "$OWNER_KIND" = nonprocess ]; then\n',
      ),
    );
    assert.ok(code.includes('ROSUNO_PROCESS_COMMISSIONED: "false"'));
  });

  test("the extra owner approval fetch is conditional, read-only and pinned", () => {
    const step = workflowRunBlock(FETCH_STEP);
    const lines = step.split("\n");
    const open = lines.indexOf(
      `if [ "$HEAD_REF" = '${CORRECTION_BRANCH}' ]; then`,
    );
    assert.ok(open > 0, step);
    const close = lines.indexOf("fi", open);
    assert.ok(close > open, step);
    // The ordinary fetches and base check come first and are unconditional.
    assert.deepEqual(lines.slice(0, open - 2), [
      'git fetch --no-tags https://github.com/"$REPO".git "+refs/pull/${PR_NUMBER}/head:refs/rosuno/pr-head"',
      'test "$(git rev-parse refs/rosuno/pr-head)" = "$HEAD_SHA"',
      'git fetch --no-tags https://github.com/"$REPO".git "+refs/heads/${HEAD_REF}:refs/rosuno/approved" \\',
      '  || { echo "::error::owner repository has no branch $HEAD_REF (Packet not published by the owner)"; exit 1; }',
      'git cat-file -e "$BASE_SHA^{commit}"',
    ]);
    assert.equal(
      close,
      lines.length - 2,
      "nothing follows the exception block",
    );
    const block = lines.slice(open + 1, close).join("\n");
    assert.equal(
      block,
      [
        '  git fetch --no-tags https://github.com/"$REPO".git \\',
        `    '+refs/heads/${ORIGINAL_BRANCH}:${ORIGINAL_APPROVAL_REF}' \\`,
        "    || { echo '::error::P3-003 owner approval branch unavailable'; exit 1; }",
        `  test "$(git rev-parse ${ORIGINAL_APPROVAL_REF})" = \\`,
        `    '${OWNER_PACKET_COMMIT}' \\`,
        "    || { echo '::error::P3-003 owner approval commit changed'; exit 1; }",
        `  test "$(git rev-parse ${ORIGINAL_APPROVAL_REF}:${P3_003_PACKET_PATH})" = \\`,
        `    '${ORIGINAL_PACKET_BLOB}' \\`,
        "    || { echo '::error::P3-003 approved Packet blob changed'; exit 1; }",
      ].join("\n"),
    );
    assert.equal(workflowText().split(CORRECTION_BRANCH).length - 1, 1);
    assert.equal(workflowText().split(ORIGINAL_BRANCH).length - 1, 1);
  });

  test("ordinary heads never fetch the P3-003 approval", () => {
    const { base, head, approval, unpinned } = workflowFixture();
    const result = runFetchStep({
      headRef: ORDINARY_BRANCH,
      prHead: head,
      base,
      ownerRefs: {
        "refs/heads/main": base,
        "refs/pull/7/head": head,
        [`refs/heads/${ORDINARY_BRANCH}`]: approval,
        [`refs/heads/${ORIGINAL_BRANCH}`]: unpinned,
      },
    });
    assert.equal(result.status, 0, result.output);
    assert.ok(result.hasRef("refs/rosuno/pr-head"));
    assert.ok(result.hasRef("refs/rosuno/approved"));
    assert.equal(result.hasRef(ORIGINAL_APPROVAL_REF), false);
  });

  test("the P3-904 head fails closed on a missing or moved P3-003 approval", () => {
    const { base, head, approval, unpinned } = workflowFixture();
    const common = {
      "refs/heads/main": base,
      "refs/pull/7/head": head,
      [`refs/heads/${CORRECTION_BRANCH}`]: approval,
    };
    const missing = runFetchStep({
      headRef: CORRECTION_BRANCH,
      prHead: head,
      base,
      ownerRefs: common,
    });
    assert.equal(missing.status, 1, missing.output);
    assert.match(
      missing.output,
      /::error::P3-003 owner approval branch unavailable/,
    );
    assert.equal(missing.hasRef(ORIGINAL_APPROVAL_REF), false);

    const moved = runFetchStep({
      headRef: CORRECTION_BRANCH,
      prHead: head,
      base,
      ownerRefs: { ...common, [`refs/heads/${ORIGINAL_BRANCH}`]: unpinned },
    });
    assert.equal(moved.status, 1, moved.output);
    assert.match(moved.output, /::error::P3-003 owner approval commit changed/);

    // The ordinary owner approval check still runs first for the P3-904 head.
    const unpublished = runFetchStep({
      headRef: CORRECTION_BRANCH,
      prHead: head,
      base,
      ownerRefs: {
        "refs/heads/main": base,
        "refs/pull/7/head": head,
        [`refs/heads/${ORIGINAL_BRANCH}`]: unpinned,
      },
    });
    assert.equal(unpublished.status, 1, unpublished.output);
    assert.match(
      unpublished.output,
      /::error::owner repository has no branch wi\/P3-904-p3-003-security-correction/,
    );
    assert.equal(unpublished.hasRef(ORIGINAL_APPROVAL_REF), false);
  });

  test("the unchanged trust binding grants the P3-904 head no exemption", () => {
    const trust = readFileSync(TRUST, "utf8");
    assert.doesNotMatch(trust, /P3-904|P3-003|P2-915|security-correction/);
    const sha = "1".repeat(40);
    const event = (overrides = {}) => ({
      repository: {
        full_name: workflowEnv("EXPECTED_REPO"),
        default_branch: "main",
      },
      pull_request: {
        number: 7,
        state: "open",
        user: { login: overrides.author ?? workflowEnv("OWNER_LOGIN") },
        base: {
          ref: "main",
          repo: { full_name: workflowEnv("EXPECTED_REPO") },
        },
        head: {
          sha,
          ref: CORRECTION_BRANCH,
          repo: {
            full_name: overrides.headRepo ?? workflowEnv("BUILDER_FORK"),
            fork: true,
          },
        },
      },
    });
    const accepted = runTrust(event(), [`7 ${sha}`]);
    assert.equal(accepted.status, 0, accepted.output);
    assert.equal(accepted.output, "MODE=builder\n");
    const notOwner = runTrust(event({ author: "someone-else" }), [`7 ${sha}`]);
    assert.equal(notOwner.status, 1, notOwner.output);
    assert.match(
      notOwner.output,
      /PR was created by 'someone-else', not the owner/,
    );
    const otherFork = runTrust(event({ headRepo: "other/Rosuno" }), [
      `7 ${sha}`,
    ]);
    assert.equal(otherFork.status, 1, otherFork.output);
    assert.match(otherFork.output, /is not the authorized Builder fork/);
    const shared = runTrust(event(), [`7 ${sha}`, `8 ${sha}`]);
    assert.equal(shared.status, 1, shared.output);
    assert.match(shared.output, /2 open PRs carry head/);
  });
});

// Genuine pinned history: runs when this clone holds the original P3-003,
// P3-904 and P2-915 objects (for example the Builder fork with the P3-904
// branch). Owner-only objects (the P3-003 owner approval commit) and the P3-904
// recovery continuation are disposable stand-ins, and the GitHub API is
// simulated; this proves the guard's pins against genuine objects, not any
// real P3-904 correction, registration, approval or workflow behavior.
describe("P2-915 genuine original history (Packet §6)", () => {
  const REQUIRED = [
    ORIGINAL_BASE,
    BUILDER_PACKET_COMMIT,
    ...ORIGINAL_COMMITS,
    ...P3904_PINNED,
    P2915_PACKET_COMMIT,
    OWNER_MAIN,
  ];
  const rootGit = (args) =>
    spawnSync("git", ["-C", ROOT, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  const available = () =>
    REQUIRED.every(
      (sha) => rootGit(["cat-file", "-e", `${sha}^{commit}`]).status === 0,
    );

  test("the guard rejects the genuine uncorrected P3-904 head and accepts only a bound recovery", (t) => {
    if (!available()) {
      t.skip(
        "genuine pinned P3-003/P3-904/P2-915 objects are not in this clone",
      );
      return;
    }
    const commonDir = path.resolve(
      ROOT,
      rootGit(["rev-parse", "--git-common-dir"]).stdout.trim(),
    );
    // Read-only access to the genuine objects; nothing is written to ROOT.
    const repo = createRepo("genuine");
    writeFileSync(
      path.join(repo.dir, ".git/objects/info/alternates"),
      `${path.join(commonDir, "objects")}\n`,
    );
    if (existsSync(path.join(commonDir, "shallow"))) {
      writeFileSync(
        path.join(repo.dir, ".git/shallow"),
        readFileSync(path.join(commonDir, "shallow")),
      );
    }
    const show = (spec) => repo.git(["rev-parse", spec]);
    const bytes = (spec) =>
      execFileSync("git", ["cat-file", "blob", spec], {
        cwd: repo.dir,
        env: repo.env,
        maxBuffer: 64 * 1024 * 1024,
      });

    // Genuine identities exactly as pinned by the guard.
    assert.equal(show(`${P3904_PACKET_COMMIT}^`), ORIGINAL_HEAD);
    assert.equal(show(`${P3904_COMMITS[0]}^`), P3904_PACKET_COMMIT);
    assert.equal(show(`${P3904_COMMITS[1]}^`), P3904_COMMITS[0]);
    assert.equal(show(`${P3904_COMMITS[2]}^`), P3904_COMMITS[1]);
    assert.equal(show(`${P3904_HEAD}^{tree}`), P3904_TREE);
    assert.equal(show(`${ORIGINAL_HEAD}^{tree}`), ORIGINAL_TREE);
    assert.equal(show(`${P2915_PACKET_COMMIT}^`), OWNER_MAIN);
    assert.equal(
      show(`${P3904_PACKET_COMMIT}:${P3_904_PACKET_PATH}`),
      P3904_PACKET_BLOB,
    );
    assert.equal(sha256(bytes(P3904_PACKET_BLOB)), P3904_PACKET_SHA256);
    assert.equal(
      show(`${P3904_COMMITS[0]}:${P3904_MIGRATION}`),
      P3904_MIGRATION_BLOB,
    );
    assert.equal(sha256(bytes(P3904_MIGRATION_BLOB)), P3904_MIGRATION_SHA256);
    assert.equal(
      show(`${P2915_PACKET_COMMIT}:${P2915_PACKET_PATH}`),
      P2915_PACKET_BLOB,
    );
    const migrations = (commit) =>
      repo
        .git(["ls-tree", "-r", commit, "--", "supabase/migrations"])
        .split("\n");
    assert.equal(migrations(ORIGINAL_BASE).length, 14);
    assert.deepEqual(
      migrations(P3904_HEAD).filter((line) => !line.endsWith(P3904_MIGRATION)),
      migrations(ORIGINAL_BASE),
    );
    for (const file of Object.values(GOVERNANCE)) {
      assert.equal(
        show(`${P3904_HEAD}:${file}`),
        show(`${OWNER_MAIN}:${file}`),
      );
    }

    // Owner-only P3-003 approval commit: genuine if present, else a stand-in
    // carrying the genuine approved Packet blob under the pinned name.
    if (rootGit(["cat-file", "-e", `${OWNER_PACKET_COMMIT}^{commit}`]).status) {
      repo.adopt(ORIGINAL_BASE);
      repo.child(
        [ORIGINAL_BASE],
        { [P3_003_PACKET_PATH]: { oid: ORIGINAL_PACKET_BLOB } },
        "stand-in: owner P3-003 approval (owner repository only)",
        { pinAs: OWNER_PACKET_COMMIT },
      );
    }
    repo.ref(ORIGINAL_APPROVAL_REF, OWNER_PACKET_COMMIT);
    // Owner main after a protected P2-915 merge (merge of genuine commits).
    repo.adopt(OWNER_MAIN);
    repo.adopt(P2915_PACKET_COMMIT);
    const implementation = {
      ".github/scripts/rosuno-guard.sh": readFileSync(GUARD, "utf8"),
    };
    const p2915 = repo.child(
      [P2915_PACKET_COMMIT],
      implementation,
      "stand-in: P2-915 implementation",
    );
    const main = repo.child(
      [OWNER_MAIN, p2915],
      { [P2915_PACKET_PATH]: { oid: P2915_PACKET_BLOB }, ...implementation },
      "stand-in: owner main with P2-915 merged",
    );
    const approvedRef = "refs/fixture/genuine-p3-904-approved";
    repo.ref(
      approvedRef,
      repo.child(
        [main],
        { [P3_904_PACKET_PATH]: { oid: P3904_PACKET_BLOB } },
        "stand-in: owner P3-904 Packet approval",
      ),
    );
    const run = (head, comments) =>
      runApproved(repo, {
        base: main,
        head,
        branch: CORRECTION_BRANCH,
        approvedRef,
        comments,
      });

    // The genuine, uncorrected P3-904 implementation is never accepted.
    const uncorrected = run(P3904_HEAD, []);
    assertRejected(
      uncorrected,
      "P3-904 security correction commit missing (only a completed recovery is accepted)",
    );
    assert.deepEqual(uncorrected.calls, []);

    // Disposable recovery stand-in on the genuine immutable chain.
    repo.adopt(P3904_HEAD);
    const security = repo.child(
      [P3904_HEAD],
      {
        [P3904_MIGRATION]: `${bytes(P3904_MIGRATION_BLOB)}-- P2-915 disposable regression fixture; not the P3-904 SQL correction\n`,
      },
      "stand-in: P3-904 security correction",
    );
    const text = (file) => bytes(`${P3904_HEAD}:${file}`).toString("utf8");
    const register = JSON.parse(text(GOVERNANCE.register));
    const admin = repo.child(
      [security],
      {
        [GOVERNANCE.register]: appendRecord(
          text(GOVERNANCE.register),
          candidateMigration({
            sequence: register.migrations.length + 1,
            depends_on: [register.migrations.at(-1).migration_id],
          }),
        ),
        [GOVERNANCE.workItems]: appendRecord(
          text(GOVERNANCE.workItems),
          candidateWorkItem(),
        ),
        [GOVERNANCE.decisions]: appendRecord(
          text(GOVERNANCE.decisions),
          candidateDecision(),
        ),
      },
      "stand-in: administrative registration",
    );
    const blobs = {
      register: show(`${admin}:${GOVERNANCE.register}`),
      workItems: show(`${admin}:${GOVERNANCE.workItems}`),
      decisions: show(`${admin}:${GOVERNANCE.decisions}`),
    };
    const recovery = { head: admin, security, admin, baseCommit: main, blobs };
    assertRejected(
      run(admin, []),
      "P2-915 approval: no owner approval comment on this pull request",
    );
    const approval = comment(
      approvalBody({ security, admin, head: admin, base: main, blobs }),
    );
    assertRecoveryPass(run(admin, [approval]), recovery, approval);
  });
});
