import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export const CANONICAL_ORIGIN = "https://github.com/NatthanPrevot/Rosuno.git";

export const IMMUTABLE_BOOTSTRAP_PATHS = [
  ".replit",
  ".github/workflows/p0-controls.yml",
];

// Scope-controlled paths are still compared with the work-item base, so a
// committed change cannot bypass the boundary; they may differ only when the
// exact path is authorized in allowedPaths.
export const SCOPE_CONTROLLED_BOOTSTRAP_PATHS = ["pnpm-lock.yaml"];

function gitText(args, cwd = ROOT) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function gitBuffer(args, cwd = ROOT) {
  return execFileSync("git", args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function resolveGitPath(value, root) {
  const candidate = path.isAbsolute(value) ? value : path.resolve(root, value);
  return realpathSync(candidate);
}

export function parseStatusPorcelain(output) {
  const text = String(output).replace(/\r\n/g, "\n").replace(/\n+$/, "");

  if (!text) {
    return {
      changedPaths: [],
      stagedPaths: [],
    };
  }

  const changedPaths = [];
  const stagedPaths = [];

  for (const line of text.split("\n")) {
    if (line.length < 4) {
      throw new Error("unparseable Git status entry");
    }

    const code = line.slice(0, 2);
    let file = line.slice(3);

    if (file.includes(" -> ")) {
      file = file.slice(file.lastIndexOf(" -> ") + 4);
    }

    changedPaths.push(file);

    if (code[0] !== " " && code[0] !== "?") {
      stagedPaths.push(file);
    }
  }

  return {
    changedPaths: [...new Set(changedPaths)].sort(),
    stagedPaths: [...new Set(stagedPaths)].sort(),
  };
}

function statusObservation(root) {
  const output = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  return parseStatusPorcelain(output);
}

function worktreeObservation(root) {
  const output = gitText(["worktree", "list", "--porcelain"], root);

  if (!output) {
    throw new Error("Git worktree topology is empty");
  }

  return output.split(/\n\n+/).map((block) => {
    const lines = block.split("\n");
    const worktreeLine = lines.find((line) => line.startsWith("worktree "));

    if (!worktreeLine) {
      throw new Error("Git worktree topology is malformed");
    }

    return {
      path: path.resolve(worktreeLine.slice("worktree ".length)),
      prunable: lines.some((line) => line.startsWith("prunable ")),
    };
  });
}

function baseFileMatches(root, expectedBase, relativePath) {
  let current;

  try {
    current = readFileSync(path.join(root, relativePath));
  } catch {
    return false;
  }

  let accepted;

  try {
    accepted = gitBuffer(["show", `${expectedBase}:${relativePath}`], root);
  } catch {
    return false;
  }

  return current.equals(accepted);
}

export function collectPreflightObservation({
  root = ROOT,
  expectedBase,
  expectedHead,
  expectedOrigin = CANONICAL_ORIGIN,
} = {}) {
  if (!/^[a-f0-9]{40}$/i.test(expectedBase ?? "")) {
    throw new Error("expected base must be a full immutable Git SHA");
  }

  if (!/^[a-f0-9]{40}$/i.test(expectedHead ?? "")) {
    throw new Error("expected head must be a full immutable Git SHA");
  }

  const repositoryRoot = realpathSync(
    gitText(["rev-parse", "--show-toplevel"], root),
  );

  const gitDir = resolveGitPath(
    gitText(["rev-parse", "--git-dir"], root),
    root,
  );

  const commonDir = resolveGitPath(
    gitText(["rev-parse", "--git-common-dir"], root),
    root,
  );

  gitText(["cat-file", "-e", `${expectedBase}^{commit}`], root);
  gitText(["cat-file", "-e", `${expectedHead}^{commit}`], root);

  const head = gitText(["rev-parse", "HEAD"], root);
  const baseTree = gitText(["rev-parse", `${expectedBase}^{tree}`], root);
  const headTree = gitText(["rev-parse", "HEAD^{tree}"], root);

  let baseIsAncestorOfHead = false;

  try {
    execFileSync("git", ["merge-base", "--is-ancestor", expectedBase, head], {
      cwd: root,
      stdio: "ignore",
    });

    baseIsAncestorOfHead = true;
  } catch {
    baseIsAncestorOfHead = false;
  }
  const branch = gitText(["branch", "--show-current"], root);
  const origin = gitText(["remote", "get-url", "origin"], root);

  const remoteLine = gitText(
    ["ls-remote", "--heads", "origin", "refs/heads/main"],
    root,
  );

  const remoteMain = remoteLine ? remoteLine.split(/\s+/)[0] : "";

  const migrationListing = gitText(
    ["ls-tree", "-r", "--name-only", expectedBase, "--", "supabase/migrations"],
    root,
  );

  const historicalMigrationPaths = migrationListing
    ? migrationListing
        .split("\n")
        .filter((file) => file.endsWith(".sql"))
        .sort()
    : [];

  const historicalMigrations = historicalMigrationPaths.map((file) => ({
    path: file,
    matches: baseFileMatches(root, expectedBase, file),
  }));

  const protectedFiles = Object.fromEntries(
    [...IMMUTABLE_BOOTSTRAP_PATHS, ...SCOPE_CONTROLLED_BOOTSTRAP_PATHS].map(
      (file) => [file, baseFileMatches(root, expectedBase, file)],
    ),
  );

  const status = statusObservation(root);

  return {
    root: repositoryRoot,
    gitDir,
    commonDir,
    worktrees: worktreeObservation(root),
    branch,
    head,
    baseTree,
    headTree,
    baseIsAncestorOfHead,
    origin,
    expectedOrigin,
    remoteMain,
    changedPaths: status.changedPaths,
    stagedPaths: status.stagedPaths,
    protectedFiles,
    historicalMigrations,
  };
}

export function validatePreflightObservation(
  observation,
  {
    expectedRoot = ROOT,
    expectedBase,
    expectedHead,
    expectedBranch,
    allowedPaths = [],
    expectedOrigin = CANONICAL_ORIGIN,
  } = {},
) {
  const fail = (message) => {
    throw new Error(message);
  };

  if (!/^[a-f0-9]{40}$/i.test(expectedBase ?? "")) {
    fail("expected base must be a full immutable Git SHA");
  }

  if (!/^[a-f0-9]{40}$/i.test(expectedHead ?? "")) {
    fail("expected head must be a full immutable Git SHA");
  }

  if (typeof expectedBranch !== "string" || expectedBranch.length === 0) {
    fail("expected branch is required");
  }

  const canonicalRoot = path.resolve(expectedRoot);
  const expectedGitDir = path.join(canonicalRoot, ".git");

  if (observation.root !== canonicalRoot) {
    fail("repository root changed");
  }

  if (observation.gitDir !== expectedGitDir) {
    fail("Git directory changed");
  }

  if (observation.commonDir !== expectedGitDir) {
    fail("Git common directory changed");
  }

  if (
    !Array.isArray(observation.worktrees) ||
    observation.worktrees.length !== 1
  ) {
    fail("unexpected additional Git worktree detected");
  }

  if (observation.worktrees[0].path !== canonicalRoot) {
    fail("canonical Git worktree path changed");
  }

  if (observation.worktrees[0].prunable) {
    fail("unexpected prunable Git worktree state detected");
  }

  if (observation.branch !== expectedBranch) {
    fail("current branch differs from expected branch");
  }

  if (observation.head !== expectedHead) {
    fail("HEAD differs from expected local head");
  }

  if (observation.baseIsAncestorOfHead !== true) {
    fail("local HEAD is not equal to or descended from the work-item base");
  }

  if (observation.origin !== expectedOrigin) {
    fail("origin changed");
  }

  if (observation.remoteMain !== expectedBase) {
    fail("canonical remote main moved");
  }

  if (observation.stagedPaths.length > 0) {
    fail("index contains staged changes");
  }

  const allowed = new Set(allowedPaths);

  const unexpected = observation.changedPaths.filter(
    (file) => !allowed.has(file),
  );

  if (unexpected.length > 0) {
    fail(`unexpected changed path: ${unexpected.join(", ")}`);
  }

  for (const [file, matches] of Object.entries(observation.protectedFiles)) {
    if (matches) {
      continue;
    }

    if (!SCOPE_CONTROLLED_BOOTSTRAP_PATHS.includes(file)) {
      fail(`protected source bytes changed: ${file}`);
    }

    if (!allowed.has(file)) {
      fail(
        `scope-controlled source bytes changed outside allowed paths: ${file}`,
      );
    }
  }

  for (const migration of observation.historicalMigrations) {
    if (!migration.matches) {
      fail(`historical migration bytes changed: ${migration.path}`);
    }
  }

  return {
    status: "passed",
    root: observation.root,
    git_dir: observation.gitDir,
    common_dir: observation.commonDir,
    worktree_count: observation.worktrees.length,
    branch: observation.branch,
    work_item_base: expectedBase,
    head: observation.head,
    base_tree: observation.baseTree,
    head_tree: observation.headTree,
    remote_main: observation.remoteMain,
    changed_paths: observation.changedPaths,
    staged_paths: observation.stagedPaths,
    historical_migration_count: observation.historicalMigrations.length,
  };
}

export function runPreflight(options) {
  const observation = collectPreflightObservation(options);
  return validatePreflightObservation(observation, options);
}

function runStep(command, args, { root, capture }) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}`,
    );
  }

  return {
    command: [command, ...args].join(" "),
    exit_code: result.status,
  };
}

export function runCanonicalCheck({
  root = ROOT,
  expectedBase,
  expectedHead,
  expectedBranch,
  allowedPaths = [],
  expectedOrigin = CANONICAL_ORIGIN,
  capture = false,
} = {}) {
  const preflightOptions = {
    root,
    expectedRoot: root,
    expectedBase,
    expectedHead,
    expectedBranch,
    allowedPaths,
    expectedOrigin,
  };

  const before = runPreflight(preflightOptions);

  const steps = [
    ["pnpm", ["run", "format:check"]],
    ["pnpm", ["run", "typecheck"]],
    ["pnpm", ["run", "build"]],
    ["pnpm", ["run", "p0:validate"]],
    ["pnpm", ["run", "p0:test"]],
    ["pnpm", ["run", "secrets:check"]],
    ["pnpm", ["run", "dependency:check"]],
    ["git", ["diff", "--check"]],
  ];

  const commands = steps.map(([command, args]) =>
    runStep(command, args, { root, capture }),
  );

  const after = runPreflight(preflightOptions);

  return {
    status: "passed",
    preflight_before: before,
    commands,
    preflight_after: after,
  };
}
