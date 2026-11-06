// P2-914: regression coverage for the one-time combined P3-003/P3-904 history
// accommodation in the trusted rosuno-guard (adopted P2-914 Packet §3, §4, §6).
//
// Every scenario runs the real, unmodified .github/scripts/rosuno-guard.sh in a
// disposable local Git repository. The guard pins the immutable original
// P3-003 objects and the owner P3-003 approval commit by SHA. Those objects are
// not part of every checkout (the owner approval commit lives only in the owner
// repository), so each disposable repository supplies fixture stand-ins under
// the exact pinned names through Git replace refs (refs/replace/<pinned-sha>).
// The guard then resolves every pinned identity exactly as written. Replace
// refs exist only inside these disposable repositories; the trusted workflow's
// fetches name explicit refspecs, none under refs/replace/ (asserted below).
//
// A structural guard PASS proves Git history, Packet and scope boundaries only.
// It is never P3-904 security acceptance, CI success, Independent Backup review,
// designated human approval or merge authorization; those remain separate,
// mandatory gates (Packet §3.5).
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
const CORRECTION_MIGRATION =
  "supabase/migrations/20261106000000_p3_904_trust_correction.sql";

const ORDINARY_BRANCH = "wi/P9-914-guard-ordinary";
const ORDINARY_PACKET_PATH = "docs/work-items/P9-914/PACKET.md";

const SANDBOX = mkdtempSync(path.join(tmpdir(), "rosuno-p2-914-guard-"));
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

const MERGE_SIDE = Symbol("merge a side branch");
const MERGE_MAIN = Symbol("merge owner main");
const mergeSide = (changes) => ({ [MERGE_SIDE]: changes });
const mergeMain = () => ({ [MERGE_MAIN]: true });
const commitLabel = (sha) => `[commit ${sha.slice(0, 12)}]`;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// Git sees no user, global or system configuration, never prompts, and may
// only use local file transport, so no fixture can reach a hosted system.
function fixtureEnv() {
  return {
    PATH: process.env.PATH ?? "",
    HOME: SANDBOX,
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

function runGuard(repo, args, extraEnv = {}) {
  const result = spawnSync("bash", [GUARD, ...args], {
    cwd: repo.dir,
    env: { ...repo.env, ...extraEnv },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}${result.stderr}`,
  };
}

const passLines = (output) =>
  output.split("\n").filter((line) => line.includes("ROSUNO-GUARD PASS"));

// Fail closed: exit 1, at least one diagnostic, every expected diagnostic, and
// no PASS line of any kind.
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

// Exactly one combined PASS line and nothing else: no intermediate segment
// PASS, no diagnostic.
function assertCombinedPass(result, head) {
  const context = `exit ${result.status}\n${result.output}`;
  assert.equal(result.status, 0, context);
  assert.equal(result.stderr, "", context);
  assert.deepEqual(
    result.stdout.split("\n").filter(Boolean),
    [
      `ROSUNO-GUARD PASS combined=P3-003+P3-904 head=${head} base=${ORIGINAL_BASE} original=${ORIGINAL_HEAD}`,
    ],
    context,
  );
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

// Illustrative correction Packet; the adopted P3-904 Packet, not this fixture,
// determines the real correction scope.
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

const BASE_FILES = {
  "README.md": "Disposable stand-in for the original P3-003 base tree.\n",
  "apps/web/app/page.tsx": "export default function Home() { return null; }\n",
  "apps/web/src/application/attorney-access.ts": "export const access = 1;\n",
  "apps/web/tests/Fixtures/legacy.txt": "legacy fixture\n",
  [HISTORICAL_MIGRATION]: "-- historical migration fixture\nselect 1;\n",
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

const DEFAULT_CORRECTION = [
  { "apps/web/src/application/attorney-trust.ts": "export const trust = 2;\n" },
  { [CORRECTION_MIGRATION]: "-- P3-904 fixture correction\nselect 1;\n" },
  { "apps/web/tests/attorney-trust-correction.test.ts": "// P3-904 fixture\n" },
];

// Builds the pinned original P3-003 history (Builder Packet commit, eight
// originals, final tree, owner approval) plus an owner main that already holds
// a P2-914 stand-in merge. `spec` substitutes individual pinned objects to
// model forged, missing, reordered or out-of-scope original history.
function buildCombinedRepo(spec = {}) {
  const repo = createRepo(spec.label ?? "combined");
  const built = new Set();
  const helpers = { extra };

  function ensure(commit) {
    const index = ORIGINAL_COMMITS.indexOf(commit);
    if (index >= 0) buildOriginal(index);
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

  repo.root(BASE_FILES, "stand-in for the original base", {
    pinAs: ORIGINAL_BASE,
  });
  repo.pin(ORIGINAL_PACKET_BLOB, repo.blob(P3_003_FIXTURE_PACKET));
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
  for (const index of spec.withoutOriginalObjects ?? []) {
    repo.git(["update-ref", "-d", `refs/replace/${ORIGINAL_COMMITS[index]}`]);
  }

  const p2914Changes = {
    "docs/work-items/P2-914/PACKET.md": "P2-914 stand-in\n",
    ".github/scripts/rosuno-guard.sh": "# accommodation stand-in\n",
  };
  const p2914 = repo.child([ORIGINAL_BASE], p2914Changes, "P2-914 stand-in");
  const main = repo.child([ORIGINAL_BASE, p2914], p2914Changes, "owner main");
  repo.ref("refs/heads/main", main);

  let approvals = 0;
  return {
    repo,
    main,
    helpers,
    // Adds a P3-904 continuation and its owner approval (which, as Packet §5
    // permits, originates from owner main, not from the original history).
    correction({
      parent = ORIGINAL_HEAD,
      before = [],
      packet = true,
      packetText: correctionPacket = p3904Packet(),
      steps = DEFAULT_CORRECTION,
      approval = "same",
      approvalPacketText,
    } = {}) {
      let tip = typeof parent === "function" ? parent(helpers) : parent;
      for (const changes of before) tip = extra(tip, changes);
      const packetBlob = repo.blob(correctionPacket);
      let packetCommit = null;
      if (packet) {
        tip = repo.child(
          [tip],
          { [P3_904_PACKET_PATH]: { oid: packetBlob } },
          "P3-904 Packet",
        );
        packetCommit = tip;
      }
      for (const step of steps) {
        if (step[MERGE_SIDE]) {
          const side = repo.child([tip], step[MERGE_SIDE], "side branch");
          tip = repo.child([tip, side], step[MERGE_SIDE], "merge side branch");
        } else if (step[MERGE_MAIN]) {
          tip = repo.child([tip, main], {}, "merge owner main");
        } else {
          tip = repo.child([tip], step, "P3-904 correction");
        }
      }
      approvals += 1;
      const approvedRef = `refs/fixture/p3-904-approved-${approvals}`;
      if (approval === "same") {
        const blob =
          approvalPacketText === undefined
            ? packetBlob
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
      return { head: tip, packetCommit, approvedRef };
    },
    run({ base = main, head, branch = CORRECTION_BRANCH, approvedRef }) {
      return runGuard(repo, [base, head, branch, approvedRef]);
    },
  };
}

let sharedCombined;
const combined = () =>
  (sharedCombined ??= buildCombinedRepo({ label: "shared" }));

function combinedResult(options = {}) {
  const fixture = combined();
  const { head, approvedRef } = fixture.correction(options);
  return fixture.run({ head, approvedRef });
}

// Builds a separate repository whose pinned history is altered by `spec`, adds
// the default compliant P3-904 continuation, and runs the guard.
function variantResult(spec, options = {}) {
  const fixture = buildCombinedRepo(spec);
  const { head, approvedRef } = fixture.correction(options);
  return fixture.run({ head, approvedRef });
}

describe("P2-914 pinned identities and fail-closed selection", () => {
  const guard = readFileSync(GUARD, "utf8");

  test("guard pins exactly the adopted Packet §2 identities", () => {
    const local = (name) => {
      const match = guard.match(new RegExp(`^ *local ${name}='([^']*)'$`, "m"));
      assert.ok(match, `guard constant ${name}`);
      return match[1];
    };
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
    const array = guard.match(
      /^ *local ORIGINAL_COMMITS=\(\n([\s\S]*?)\n *\)$/m,
    );
    assert.ok(array, "guard ORIGINAL_COMMITS array");
    assert.deepEqual(array[1].match(/[0-9a-f]{40}/g), ORIGINAL_COMMITS);

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

  test("only the exact P3-904 head branch argument selects the combined path", () => {
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
    // The branch literal appears only as the pinned constant and in the
    // dispatcher; no prefix, Packet text or environment switch selects it.
    assert.equal(guard.split(`'${CORRECTION_BRANCH}'`).length - 1, 2);
    assert.doesNotMatch(guard, /\$\{?(?:GITHUB_|ROSUNO_|CI\b|HEAD_REF\b)/);
    // No new success shortcut: one ordinary and one combined PASS statement,
    // and the combined path reuses the unchanged ordinary guard per segment.
    assert.equal(guard.split('echo "ROSUNO-GUARD PASS').length - 1, 2);
    assert.doesNotMatch(guard, /\bexit 0\b/);
    assert.deepEqual(
      [...guard.matchAll(/^ *normal_guard (.+?)(?: \\)?$/gm)].map((m) => m[1]),
      [
        '"$ORIGINAL_BASE" "$ORIGINAL_HEAD" "$ORIGINAL_BRANCH" "$ORIGINAL_APPROVAL"',
        '"$ORIGINAL_HEAD" "$HEAD" "$CORRECTION_BRANCH" "$APPROVED"',
        '"$@"',
      ],
    );
  });
});

describe("P2-914 combined history: approved illustrative continuation", () => {
  test("passes with exactly one combined PASS and no intermediate PASS", () => {
    const fixture = combined();
    const { head, approvedRef } = fixture.correction();
    assertCombinedPass(fixture.run({ head, approvedRef }), head);
  });

  test("passes when the PR base is the original base itself", () => {
    const fixture = combined();
    const { head, approvedRef } = fixture.correction();
    assertCombinedPass(
      fixture.run({ base: ORIGINAL_BASE, head, approvedRef }),
      head,
    );
  });

  test("security-defective fixture passes structurally but claims no acceptance", () => {
    // Deliberately insecure correction: Git history and scope are valid, so
    // the structural guard passes. That PASS must not read as security
    // acceptance or merge eligibility; R1, R2, atomic audit integrity and
    // Independent Backup PASS remain separate mandatory conditions.
    const fixture = combined();
    const clean = fixture.correction();
    const defective = fixture.correction({
      steps: [
        {
          "apps/web/src/application/attorney-trust.ts":
            "// deliberately defective fixture: any caller may verify trust\n" +
            "export const canVerifyTrust = () => true;\n",
        },
        {
          [CORRECTION_MIGRATION]:
            "-- deliberately defective fixture: broad grant, no RLS\n" +
            "grant all on table public.attorney_trust_profiles to anon;\n",
        },
      ],
    });
    const cleanResult = fixture.run(clean);
    const defectiveResult = fixture.run(defective);
    assertCombinedPass(defectiveResult, defective.head);
    assert.doesNotMatch(
      defectiveResult.output,
      /secur|accept|eligib|merge|approv|review/i,
    );
    // The guard cannot tell the defective correction from the clean one.
    assert.equal(
      defectiveResult.stdout.replace(defective.head, "<head>"),
      cleanResult.stdout.replace(clean.head, "<head>"),
    );
  });
});

describe("P2-914 combined history rejections (Packet §6 items 1-20)", () => {
  test("(1) uncorrected P3-003 HEAD fails the special path", () => {
    const fixture = combined();
    const { approvedRef } = fixture.correction();
    assertRejected(
      fixture.run({ head: ORIGINAL_HEAD, approvedRef }),
      `Packet ${P3_904_PACKET_PATH} missing at head or not a regular file`,
    );
  });

  test("(2) missing P3-904 Packet is rejected", () => {
    assertRejected(
      combinedResult({ packet: false }),
      `Packet ${P3_904_PACKET_PATH} missing at head or not a regular file`,
    );
  });

  test("(3) wrong correction Packet parent is rejected", () => {
    assertRejected(
      combinedResult({ parent: ORIGINAL_COMMITS[6] }),
      "P3-003 original HEAD not an ancestor of P3-904",
    );
    assertRejected(
      combinedResult({ parent: combined().main }),
      "P3-904 combined merge-base mismatch",
    );
    assertRejected(
      combinedResult({
        packetText: p3904Packet({ base: ORIGINAL_COMMITS[6] }),
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

  test("original Builder Packet boundary (Packet §3.2) is enforced", () => {
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

  test("(7) modified original commits or tree are rejected", () => {
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
        steps: [
          ...DEFAULT_CORRECTION,
          { "apps/web/app/staff/verification/page.tsx": "// replayed\n" },
        ],
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
        originalExtra: { 2: { "governance/work-items/index.json": "{}\n" } },
      }),
      `${commitLabel(ORIGINAL_COMMITS[2])} governance/work-items/index.json (A) is inside FORBIDDEN_SCOPE`,
      `${commitLabel(ORIGINAL_COMMITS[2])} governance/work-items/index.json (A) is outside ALLOWED_SCOPE`,
    );
  });

  test("(13) unauthorized P3-904 migrations are rejected", () => {
    const second = "supabase/migrations/20261107000000_p3_904_second.sql";
    assertRejected(
      combinedResult({
        steps: [...DEFAULT_CORRECTION, { [second]: "select 2;\n" }],
      }),
      "P3-904 requires exactly one new migration (found 2)",
    );
    assertRejected(
      combinedResult({
        steps: DEFAULT_CORRECTION.filter((step) => !step[CORRECTION_MIGRATION]),
      }),
      "P3-904 requires exactly one new migration (found 0)",
    );
    assertRejected(
      combinedResult({
        steps: [
          DEFAULT_CORRECTION[0],
          { "supabase/migrations/20261106000000_p3_904.txt": "select 1;\n" },
        ],
      }),
      "P3-904 migration is not SQL: supabase/migrations/20261106000000_p3_904.txt",
    );
    assertRejected(
      combinedResult({
        steps: [
          ...DEFAULT_CORRECTION,
          { [CORRECTION_MIGRATION]: "select 3;\n" },
        ],
      }),
      `P3-904 migration altered after creation: ${CORRECTION_MIGRATION}`,
    );
    assertRejected(
      combinedResult({
        steps: [
          ...DEFAULT_CORRECTION,
          { [CORRECTION_MIGRATION]: null, [second]: "select 2;\n" },
        ],
      }),
      `P3-904 migration altered after creation: ${CORRECTION_MIGRATION}`,
    );
    assertRejected(
      combinedResult({ packetText: p3904Packet({ migrations: "none" }) }),
      `new migration ${CORRECTION_MIGRATION} but Packet says MIGRATIONS: none`,
    );
  });

  test("(14) historical migration edits are rejected in either segment", () => {
    assertRejected(
      combinedResult({
        steps: [
          ...DEFAULT_CORRECTION,
          { [HISTORICAL_MIGRATION]: "select 9;\n" },
        ],
      }),
      `existing migration ${HISTORICAL_MIGRATION} changed or aliased (status M; forward-only)`,
    );
    assertRejected(
      combinedResult({
        steps: [...DEFAULT_CORRECTION, { [HISTORICAL_MIGRATION]: null }],
      }),
      `existing migration ${HISTORICAL_MIGRATION} changed or aliased (status D; forward-only)`,
    );
    const alias = HISTORICAL_MIGRATION.replace("historical", "HISTORICAL");
    assertRejected(
      combinedResult({
        steps: [...DEFAULT_CORRECTION, { [alias]: "select 1;\n" }],
      }),
      `existing migration ${alias} changed or aliased (status A; forward-only)`,
    );
    assertRejected(
      variantResult({
        label: "p3-003-historical-migration",
        originalExtra: { 5: { [HISTORICAL_MIGRATION]: "select 9;\n" } },
      }),
      `${commitLabel(ORIGINAL_COMMITS[5])} existing migration ${HISTORICAL_MIGRATION} changed or aliased (status M; forward-only)`,
    );
  });

  test("(15) P3-904 out-of-scope edits are rejected", () => {
    const rejectStep = (step, ...expected) =>
      assertRejected(
        combinedResult({ steps: [...DEFAULT_CORRECTION, step] }),
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

  test("cross-segment case-only alias (Packet §3.4) is rejected", () => {
    const fixture = buildCombinedRepo({
      label: "cross-segment-alias",
      originalExtra: { 7: { "apps/web/tests/Fixtures/legacy.txt": null } },
    });
    const { head, approvedRef } = fixture.correction({
      steps: [
        ...DEFAULT_CORRECTION,
        { "apps/web/tests/fixtures/legacy.txt": "re-added in other case\n" },
      ],
    });
    assertRejected(
      fixture.run({ head, approvedRef }),
      "cross-segment case-only path alias: apps/web/tests/Fixtures -> apps/web/tests/fixtures",
    );
  });

  test("(16) modification of either Packet after creation is rejected", () => {
    assertRejected(
      combinedResult({
        steps: [
          ...DEFAULT_CORRECTION,
          { [P3_904_PACKET_PATH]: `${p3904Packet()}edited\n` },
        ],
      }),
      "Packet changed after it was added (re-audit required)",
    );
    const fixture = combined();
    const reverted = fixture.correction({
      steps: [
        { [P3_904_PACKET_PATH]: `${p3904Packet()}edited\n` },
        { [P3_904_PACKET_PATH]: p3904Packet() },
        ...DEFAULT_CORRECTION,
      ],
    });
    assertRejected(
      fixture.run(reverted),
      `Packet path ${P3_904_PACKET_PATH} changed after the Packet commit (even if later reverted; re-audit required)`,
    );
    assertRejected(
      combinedResult({
        steps: [...DEFAULT_CORRECTION, { [P3_003_PACKET_PATH]: "rewritten\n" }],
      }),
      `${P3_003_PACKET_PATH} is outside this work item's writable area`,
    );
    assertRejected(
      combinedResult({
        steps: [...DEFAULT_CORRECTION, { [P3_003_PACKET_PATH]: null }],
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
  });

  test("(17) intermediate unapproved commits are rejected", () => {
    const fixture = combined();
    const early = fixture.correction({
      before: [{ "apps/web/src/application/attorney-trust.ts": "// early\n" }],
    });
    const earlyCommit = fixture.repo.git([
      "rev-parse",
      `${early.packetCommit}^`,
    ]);
    assertRejected(
      fixture.run(early),
      `Packet commit is not the first commit on the branch (earlier commit: ${earlyCommit})`,
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
    const reverted = fixture.correction({
      steps: [
        { "apps/web/app/page.tsx": "export const replaced = 1;\n" },
        {
          "apps/web/app/page.tsx":
            "export default function Home() { return null; }\n",
        },
        ...DEFAULT_CORRECTION,
      ],
    });
    const result = fixture.run(reverted);
    assertRejected(
      result,
      /\[commit [0-9a-f]{12}\] apps\/web\/app\/page\.tsx \(M\) is outside ALLOWED_SCOPE/,
    );
    assert.doesNotMatch(result.output, /\[final diff\]/);
  });

  test("(18) nonlinear or merge history is rejected", () => {
    assertRejected(
      combinedResult({
        steps: [
          ...DEFAULT_CORRECTION,
          mergeSide({ "apps/web/tests/side.test.ts": "// side\n" }),
        ],
      }),
      /merge commit [0-9a-f]{40} on the branch \(linear history required\)/,
    );
    assertRejected(
      combinedResult({ steps: [...DEFAULT_CORRECTION, mergeMain()] }),
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

  test("(19) Packet-only correction is rejected", () => {
    assertRejected(
      combinedResult({ steps: [] }),
      "P3-904 implementation missing",
    );
  });

  test("(20) the exception cannot be claimed by another branch or history", () => {
    const fixture = combined();
    const { head, approvedRef } = fixture.correction();
    assertRejected(
      fixture.run({ head, approvedRef, branch: `${CORRECTION_BRANCH}-v2` }),
      `Packet commit is not the first commit on the branch (earlier commit: ${BUILDER_PACKET_COMMIT})`,
    );
    assertRejected(
      fixture.run({
        head,
        approvedRef: ORIGINAL_APPROVAL_REF,
        branch: ORIGINAL_BRANCH,
      }),
      `${P3_904_PACKET_PATH} is outside this work item's writable area`,
      `new migration ${CORRECTION_MIGRATION} but Packet says MIGRATIONS: none`,
    );
    assertRejected(
      fixture.run({
        head,
        approvedRef,
        branch: "wi/P3-905-p3-003-security-correction",
      }),
      "Packet docs/work-items/P3-905/PACKET.md missing at head",
    );
    for (const branch of [
      "wi/P3-904-P3-003-SECURITY-CORRECTION",
      `refs/heads/${CORRECTION_BRANCH}`,
      `${CORRECTION_BRANCH} `,
    ]) {
      assertRejected(
        fixture.run({ head, approvedRef, branch }),
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
    const { head, approvedRef } = fixture.correction();
    const poisoned = fixture.repo.child(
      [fixture.main, ORIGINAL_HEAD],
      {},
      "main with uncorrected P3-003 merged",
    );
    assertRejected(
      fixture.run({ base: poisoned, head, approvedRef }),
      "P3-904 combined merge-base mismatch",
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

describe("P2-914 trusted workflow dependency (Packet §4)", () => {
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
    assert.doesNotMatch(trust, /P3-904|P3-003|security-correction/);
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
