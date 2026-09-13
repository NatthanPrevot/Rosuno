#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  CANONICAL_ORIGIN,
  ROOT,
  runCanonicalCheck,
  runPreflight,
} from "./lib/fast-control.mjs";

function parse(argv) {
  const command = argv[0];

  const result = {
    command,
    base: null,
    head: null,
    branch: null,
    allowedPaths: [],
    json: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--json") {
      result.json = true;
      continue;
    }

    if (["--base", "--head", "--branch", "--allow"].includes(argument)) {
      const value = argv[index + 1];

      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }

      index += 1;

      if (argument === "--base") result.base = value;
      if (argument === "--head") result.head = value;
      if (argument === "--branch") result.branch = value;
      if (argument === "--allow") result.allowedPaths.push(value);

      continue;
    }

    throw new Error(`unsupported Fast-Control argument: ${argument}`);
  }

  if (!["preflight", "check"].includes(command)) {
    throw new Error("Fast-Control command must be preflight or check");
  }

  if (!result.base) {
    throw new Error("--base is required");
  }

  if (!result.head) {
    throw new Error("--head is required");
  }

  if (!result.branch) {
    throw new Error("--branch is required");
  }

  return result;
}

function humanPreflight(result) {
  process.stdout.write(
    [
      "=== ROSUNO FAST-CONTROL PREFLIGHT PASS ===",
      `ROOT=${result.root}`,
      `GIT_DIR=${result.git_dir}`,
      `COMMON_DIR=${result.common_dir}`,
      `WORKTREE_COUNT=${result.worktree_count}`,
      `BRANCH=${result.branch}`,
      `WORK_ITEM_BASE=${result.work_item_base}`,
      `HEAD=${result.head}`,
      `BASE_TREE=${result.base_tree}`,
      `HEAD_TREE=${result.head_tree}`,
      `REMOTE_MAIN=${result.remote_main}`,
      `CHANGED_PATHS=${result.changed_paths.length}`,
      `STAGED_PATHS=${result.staged_paths.length}`,
      `HISTORICAL_MIGRATIONS=${result.historical_migration_count}`,
      "STATE_ARTIFACTS=NONE",
      "",
    ].join("\n"),
  );
}

function humanCheck(result) {
  process.stdout.write(
    [
      "=== ROSUNO FAST-CONTROL CHECK PASS ===",
      `COMMANDS=${result.commands.length}`,
      `BRANCH=${result.preflight_after.branch}`,
      `WORK_ITEM_BASE=${result.preflight_after.work_item_base}`,
      `HEAD=${result.preflight_after.head}`,
      `REMOTE_MAIN=${result.preflight_after.remote_main}`,
      `CHANGED_PATHS=${result.preflight_after.changed_paths.length}`,
      `STAGED_PATHS=${result.preflight_after.staged_paths.length}`,
      `HISTORICAL_MIGRATIONS=${result.preflight_after.historical_migration_count}`,
      "STATE_ARTIFACTS=NONE",
      "",
    ].join("\n"),
  );
}

export function main(argv = process.argv.slice(2)) {
  let options;

  try {
    options = parse(argv);

    const shared = {
      root: ROOT,
      expectedRoot: ROOT,
      expectedBase: options.base,
      expectedHead: options.head,
      expectedBranch: options.branch,
      allowedPaths: options.allowedPaths,
      expectedOrigin: CANONICAL_ORIGIN,
    };

    const result =
      options.command === "preflight"
        ? runPreflight(shared)
        : runCanonicalCheck({
            ...shared,
            capture: options.json,
          });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (options.command === "preflight") {
      humanPreflight(result);
    } else {
      humanCheck(result);
    }

    return 0;
  } catch (error) {
    const json = options?.json === true;
    const message = error instanceof Error ? error.message : String(error);

    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          status: "failed",
          command: options?.command ?? null,
          error: message,
        })}\n`,
      );
    } else {
      process.stderr.write(`ROSUNO STOP: ${message}\n`);
    }

    return 1;
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = main();
}
