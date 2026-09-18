import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  P1009_GATE5_CATEGORIES,
  P1009_GATE5_PRINCIPALS,
  P1009_GATE5_TARGET_FUNCTIONS,
  P1009_GATE5_TARGET_TABLES,
  buildP1009Gate5PrestateSql,
  readP1009Gate5PrestateSql,
  validateP1009Gate5ScopeRows,
  verifyP1009Gate5SqlArtifact,
} from "../p1-009-gate5-fingerprint.mjs";
import { ROOT, validateP1009Gate5PrestateContract } from "../lib/controls.mjs";

const functionIdentity = (fn) => `${fn.schema}.${fn.name}(${fn.identity_args})`;

function scopeFixture() {
  const functionIdentities = P1009_GATE5_TARGET_FUNCTIONS.map(functionIdentity);

  return [
    ...P1009_GATE5_TARGET_TABLES.map((table) => ({
      category: "table",
      identity: `public.${table}`,
    })),
    ...functionIdentities.map((identity) => ({
      category: "function",
      identity,
    })),
    ...P1009_GATE5_TARGET_TABLES.flatMap((table) =>
      P1009_GATE5_PRINCIPALS.map((principal) => ({
        category: "table_privilege",
        identity: `public.${table}.${principal}`,
      })),
    ),
    ...functionIdentities.flatMap((fn) =>
      P1009_GATE5_PRINCIPALS.map((principal) => ({
        category: "function_privilege",
        identity: `${fn}.${principal}`,
      })),
    ),
  ];
}

test("Gate 5A SQL is exactly the deterministic retained artifact", () => {
  const actual = readP1009Gate5PrestateSql();
  const expected = buildP1009Gate5PrestateSql();

  assert.equal(actual, expected);

  const proof = verifyP1009Gate5SqlArtifact(actual);

  assert.match(proof.sha256, /^[a-f0-9]{64}$/);
  assert.equal(proof.bytes, Buffer.byteLength(actual, "utf8"));

  assert.match(
    actual,
    /^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;/,
  );
  assert.match(actual, /\nROLLBACK;\n$/);

  assert.equal(
    /^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT|REVOKE|COMMIT)\b/im.test(
      actual,
    ),
    false,
  );

  assert.match(
    actual,
    /f\.identity_args=pg_get_function_identity_arguments\(p\.oid\)/,
  );
});

test("Gate 5A static scope is exact and fail closed", () => {
  assert.equal(P1009_GATE5_TARGET_TABLES.length, 43);
  assert.equal(P1009_GATE5_TARGET_FUNCTIONS.length, 12);
  assert.deepEqual(P1009_GATE5_PRINCIPALS, [
    "PUBLIC",
    "anon",
    "authenticated",
    "service_role",
    "owner",
  ]);
  assert.equal(P1009_GATE5_CATEGORIES.length, 11);

  const fixture = scopeFixture();

  assert.equal(validateP1009Gate5ScopeRows(fixture), true);

  assert.throws(() => validateP1009Gate5ScopeRows(fixture.slice(1)));

  const extra = structuredClone(fixture);
  extra.push({
    category: "table",
    identity: "public.resources",
  });

  assert.throws(() => validateP1009Gate5ScopeRows(extra));
});

test("Gate 5A runner import is inert and performs no database work", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'await import("./tools/p0/p1-009-gate5-fingerprint.mjs");',
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "/definitely-not-a-database-client-path",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("Gate 5A evidence preserves historical P1-008 as qualified history", () => {
  const evidence = JSON.parse(
    readFileSync(
      path.join(
        ROOT,
        "governance/evidence/p1-009-gate5-prestate-contract.json",
      ),
      "utf8",
    ),
  );

  assert.equal(
    evidence.historical_p1_008.sha256,
    "1926821eee5d37194358f5a0a0e30f2577f7bb08c9be5478ab21dd300e32ba04",
  );
  assert.equal(evidence.historical_p1_008.preserved_immutable, true);
  assert.equal(evidence.historical_p1_008.reproduction_claimed, false);
  assert.equal(evidence.historical_p1_008.replaced_or_repaired, false);
  assert.equal(evidence.execution_policy.database_execution_authorized, false);

  assert.equal(validateP1009Gate5PrestateContract(evidence), true);
});
