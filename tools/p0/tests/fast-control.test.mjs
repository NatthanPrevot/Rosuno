import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  CANONICAL_ORIGIN,
  IMMUTABLE_BOOTSTRAP_PATHS,
  ROOT,
  SCOPE_CONTROLLED_BOOTSTRAP_PATHS,
  parseStatusPorcelain,
  validatePreflightObservation,
} from "../lib/fast-control.mjs";

const base = "1".repeat(40);
const candidateHead = "2".repeat(40);

function acceptedObservation() {
  return {
    root: "/repo",
    gitDir: "/repo/.git",
    commonDir: "/repo/.git",
    worktrees: [{ path: "/repo", prunable: false }],
    branch: "candidate",
    head: candidateHead,
    baseTree: "3".repeat(40),
    headTree: "4".repeat(40),
    baseIsAncestorOfHead: true,
    origin: CANONICAL_ORIGIN,
    expectedOrigin: CANONICAL_ORIGIN,
    remoteMain: base,
    changedPaths: ["package.json"],
    stagedPaths: [],
    protectedFiles: {
      ".replit": true,
      ".github/workflows/p0-controls.yml": true,
      "pnpm-lock.yaml": true,
    },
    historicalMigrations: [
      {
        path: "supabase/migrations/20260828192126_p0_restrict_rls_auto_enable_execution.sql",
        matches: true,
      },
    ],
  };
}

const expectation = {
  expectedRoot: "/repo",
  expectedBase: base,
  expectedHead: candidateHead,
  expectedBranch: "candidate",
  allowedPaths: ["package.json"],
  expectedOrigin: CANONICAL_ORIGIN,
};

test("Fast-Control preflight accepts only the exact bounded observation", () => {
  assert.doesNotThrow(() =>
    validatePreflightObservation(acceptedObservation(), expectation),
  );
});

const failureCases = {
  "wrong repository root": (value) => {
    value.root = "/other";
  },
  "wrong Git directory": (value) => {
    value.gitDir = "/other/.git";
  },
  "changed common directory": (value) => {
    value.commonDir = "/repo/.git/worktrees/other";
  },
  "additional worktree": (value) => {
    value.worktrees.push({ path: "/repo-other", prunable: false });
  },
  "prunable worktree": (value) => {
    value.worktrees[0].prunable = true;
  },
  "wrong branch": (value) => {
    value.branch = "other";
  },
  "wrong local HEAD": (value) => {
    value.head = "5".repeat(40);
  },
  "non-descendant local HEAD": (value) => {
    value.baseIsAncestorOfHead = false;
  },
  "moved remote main": (value) => {
    value.remoteMain = "4".repeat(40);
  },
  "unexpected changed file": (value) => {
    value.changedPaths.push("unexpected.txt");
  },
  "staged change": (value) => {
    value.stagedPaths.push("package.json");
  },
  ".replit drift": (value) => {
    value.protectedFiles[".replit"] = false;
  },
  "CI drift": (value) => {
    value.protectedFiles[".github/workflows/p0-controls.yml"] = false;
  },
  "lockfile drift": (value) => {
    value.protectedFiles["pnpm-lock.yaml"] = false;
  },
  "historical migration drift": (value) => {
    value.historicalMigrations[0].matches = false;
  },
};

for (const [name, mutate] of Object.entries(failureCases)) {
  test(`Fast-Control preflight fails closed on ${name}`, () => {
    const observation = acceptedObservation();
    mutate(observation);

    assert.throws(() => validatePreflightObservation(observation, expectation));
  });
}

test("Fast-Control preflight distinguishes work-item base from candidate HEAD", () => {
  const observation = acceptedObservation();

  assert.notEqual(observation.head, expectation.expectedBase);
  assert.equal(observation.head, expectation.expectedHead);
  assert.equal(observation.remoteMain, expectation.expectedBase);

  assert.doesNotThrow(() =>
    validatePreflightObservation(observation, expectation),
  );
});

test("Fast-Control preflight accepts pre-commit HEAD equal to work-item base", () => {
  const observation = acceptedObservation();

  observation.head = base;
  observation.headTree = observation.baseTree;

  assert.doesNotThrow(() =>
    validatePreflightObservation(observation, {
      ...expectation,
      expectedHead: base,
    }),
  );
});

test("Fast-Control preflight rejects an unexpected expected local HEAD", () => {
  assert.throws(() =>
    validatePreflightObservation(acceptedObservation(), {
      ...expectation,
      expectedHead: "6".repeat(40),
    }),
  );
});

test("Fast-Control preflight fails closed when expected base is wrong", () => {
  assert.throws(() =>
    validatePreflightObservation(acceptedObservation(), {
      ...expectation,
      expectedBase: "5".repeat(40),
    }),
  );
});

test("Fast-Control reusable and executable modules are import-inert", () => {
  const imports = [
    "tools/p0/lib/fast-control.mjs",
    "tools/p0/lib/p1-004-contract-data.mjs",
    "tools/p0/p1-004-rollback.mjs",
    "tools/p0/fast-control.mjs",
  ].map((relative) => pathToFileURL(path.join(ROOT, relative)).href);

  const script = imports
    .map((specifier) => `await import(${JSON.stringify(specifier)});`)
    .join("\n");

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("Fast-Control machine-readable implementation contains no repository writer", () => {
  for (const relative of [
    "tools/p0/lib/fast-control.mjs",
    "tools/p0/fast-control.mjs",
  ]) {
    const source = readFileSync(path.join(ROOT, relative), "utf8");

    assert.doesNotMatch(
      source,
      /\b(?:writeFile|appendFile|mkdir|rename|unlink|rmSync|rmdir|copyFile|createWriteStream)\b/,
    );
  }
});

test("Fast-Control porcelain parser preserves leading unstaged status", () => {
  const parsed = parseStatusPorcelain(
    " M package.json\n M tools/p0/lib/controls.mjs\n?? tools/p0/fast-control.mjs\n",
  );

  assert.deepEqual(parsed.stagedPaths, []);
  assert.deepEqual(parsed.changedPaths, [
    "package.json",
    "tools/p0/fast-control.mjs",
    "tools/p0/lib/controls.mjs",
  ]);
});

test("Fast-Control porcelain parser still detects truly staged status", () => {
  const parsed = parseStatusPorcelain(
    "M  package.json\n M tools/p0/lib/controls.mjs\n",
  );

  assert.deepEqual(parsed.stagedPaths, ["package.json"]);
});

// P0 -> P2 application-surface control extension: pnpm-lock.yaml is
// scope-controlled, while .replit, the CI workflow, and historical migrations
// remain hard-protected regardless of allowedPaths.
const lockfileAuthorized = {
  ...expectation,
  allowedPaths: ["package.json", "pnpm-lock.yaml"],
};

test("Fast-Control hard-protects only .replit and the CI workflow as immutable bootstrap bytes", () => {
  assert.deepEqual(IMMUTABLE_BOOTSTRAP_PATHS, [
    ".replit",
    ".github/workflows/p0-controls.yml",
  ]);
  assert.deepEqual(SCOPE_CONTROLLED_BOOTSTRAP_PATHS, ["pnpm-lock.yaml"]);
});

const lockfileChanges = {
  "uncommitted lockfile change": {
    mutate: (value) => {
      value.changedPaths.push("pnpm-lock.yaml");
      value.protectedFiles["pnpm-lock.yaml"] = false;
    },
    rejection: /unexpected changed path: pnpm-lock\.yaml/,
  },
  "lockfile change already committed on the candidate HEAD": {
    mutate: (value) => {
      value.protectedFiles["pnpm-lock.yaml"] = false;
    },
    rejection:
      /scope-controlled source bytes changed outside allowed paths: pnpm-lock\.yaml/,
  },
  "deleted lockfile": {
    mutate: (value) => {
      value.changedPaths.push(
        ...parseStatusPorcelain(" D pnpm-lock.yaml\n").changedPaths,
      );
      value.protectedFiles["pnpm-lock.yaml"] = false;
    },
    rejection: /unexpected changed path: pnpm-lock\.yaml/,
  },
};

for (const [name, { mutate, rejection }] of Object.entries(lockfileChanges)) {
  test(`Fast-Control rejects a ${name} outside allowedPaths`, () => {
    const observation = acceptedObservation();
    mutate(observation);

    assert.throws(
      () => validatePreflightObservation(observation, expectation),
      rejection,
    );
  });

  test(`Fast-Control accepts a ${name} explicitly inside allowedPaths`, () => {
    const observation = acceptedObservation();
    mutate(observation);

    assert.doesNotThrow(() =>
      validatePreflightObservation(observation, lockfileAuthorized),
    );
  });
}

for (const nearMiss of [
  "./pnpm-lock.yaml",
  "*",
  "pnpm-lock.yml",
  "PNPM-LOCK.YAML",
  "pnpm-lock.yaml/",
]) {
  test(`Fast-Control does not treat ${JSON.stringify(nearMiss)} as authorizing the lockfile`, () => {
    const observation = acceptedObservation();
    observation.protectedFiles["pnpm-lock.yaml"] = false;

    assert.throws(
      () =>
        validatePreflightObservation(observation, {
          ...expectation,
          allowedPaths: ["package.json", nearMiss],
        }),
      /scope-controlled source bytes changed outside allowed paths: pnpm-lock\.yaml/,
    );
  });
}

for (const file of [".replit", ".github/workflows/p0-controls.yml"]) {
  for (const committed of [false, true]) {
    test(`Fast-Control rejects ${committed ? "committed" : "uncommitted"} ${file} drift even when the path is allowed`, () => {
      const observation = acceptedObservation();
      observation.protectedFiles[file] = false;

      if (!committed) {
        observation.changedPaths.push(file);
      }

      assert.throws(
        () =>
          validatePreflightObservation(observation, {
            ...lockfileAuthorized,
            allowedPaths: [...lockfileAuthorized.allowedPaths, file],
          }),
        new RegExp(
          `protected source bytes changed: ${file.replaceAll(".", "\\.")}`,
        ),
      );
    });
  }
}

test("Fast-Control cannot authorize an unknown protected path through allowedPaths", () => {
  const observation = acceptedObservation();
  observation.protectedFiles["tsconfig.json"] = false;

  assert.throws(
    () =>
      validatePreflightObservation(observation, {
        ...lockfileAuthorized,
        allowedPaths: [...lockfileAuthorized.allowedPaths, "tsconfig.json"],
      }),
    /protected source bytes changed: tsconfig\.json/,
  );
});

test("Fast-Control rejects historical migration drift even when the migration path is allowed", () => {
  const observation = acceptedObservation();
  const migration = observation.historicalMigrations[0];
  migration.matches = false;
  observation.changedPaths.push(migration.path);

  assert.throws(
    () =>
      validatePreflightObservation(observation, {
        ...lockfileAuthorized,
        allowedPaths: [...lockfileAuthorized.allowedPaths, migration.path],
      }),
    /historical migration bytes changed/,
  );
});

for (const unrelated of [
  "pnpm-workspace.yaml",
  ".npmrc",
  "apps/web/app/page.tsx",
]) {
  test(`Fast-Control lockfile authorization does not admit ${unrelated}`, () => {
    const observation = acceptedObservation();
    observation.changedPaths.push("pnpm-lock.yaml", unrelated);
    observation.protectedFiles["pnpm-lock.yaml"] = false;

    assert.throws(
      () => validatePreflightObservation(observation, lockfileAuthorized),
      new RegExp(
        `unexpected changed path: ${unrelated.replaceAll(".", "\\.")}`,
      ),
    );
  });
}
