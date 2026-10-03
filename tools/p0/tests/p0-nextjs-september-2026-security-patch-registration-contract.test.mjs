import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(new URL("../../../" + relativePath, import.meta.url), "utf8"),
  );
}

const WORK_ITEM_ID = "WI-P0-NEXTJS-SEPTEMBER-2026-SECURITY-PATCH";
const DECISION_ID =
  "DEC-20261003-P0-NEXTJS-SEPTEMBER-2026-SECURITY-PATCH-CONTRACT";

const REGISTRATION_ENVELOPE = [
  "governance/decision-log.json",
  "governance/work-items/index.json",
  "tools/p0/tests/p0-nextjs-september-2026-security-patch-registration-contract.test.mjs",
];

const IMPLEMENTATION_ENVELOPE = ["apps/web/package.json", "pnpm-lock.yaml"];

const AUTHORITY_REFS = [
  "P0-001-LOCKED",
  "TECHNICAL-ARCHITECTURE-V0.2-LOCKED",
  "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED",
];

test("Next.js September 2026 security patch registration remains bounded and transition-safe", () => {
  const decisions = readJson("governance/decision-log.json");
  const workItems = readJson("governance/work-items/index.json");

  const decisionMatches = decisions.decisions.filter(
    (entry) => entry.decision_id === DECISION_ID,
  );
  const itemMatches = workItems.work_items.filter(
    (entry) => entry.work_item_id === WORK_ITEM_ID,
  );

  assert.equal(decisionMatches.length, 1);
  assert.equal(itemMatches.length, 1);

  const decision = decisionMatches[0];
  const item = itemMatches[0];

  assert.equal(decision.status, "accepted");
  assert.equal(item.priority, "P0");
  assert.equal(item.environment, "development");

  assert.deepEqual(decision.authority_refs, AUTHORITY_REFS);
  assert.deepEqual(item.authority_refs, AUTHORITY_REFS);
  assert.deepEqual(decision.work_item_refs, [WORK_ITEM_ID]);

  assert.ok(item.decision_refs.includes(DECISION_ID));
  assert.ok(item.dependencies.includes("WI-P2-001-APPLICATION-SHELL"));

  assert.deepEqual(item.release_refs, []);
  assert.deepEqual(item.migration_refs, []);

  assert.equal(decision.created_at, decision.updated_at);
  assert.match(decision.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(item.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(item.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  assert.ok(
    item.in_scope.some((entry) =>
      REGISTRATION_ENVELOPE.every((path) => entry.includes(path)),
    ),
  );

  assert.ok(
    item.in_scope.some((entry) =>
      IMPLEMENTATION_ENVELOPE.every((path) => entry.includes(path)),
    ),
  );

  const contract = [
    decision.scope,
    decision.decision,
    decision.rationale,
    decision.impact,
    ...decision.evidence,
    item.objective,
    ...item.in_scope,
    ...item.out_of_scope,
    ...item.acceptance_criteria,
    item.rollback_reference,
  ].join(" ");

  for (const phrase of [
    "^16.3.6",
    "^16.3.8",
    "16.3.8",
    "apps/web/package.json",
    "pnpm-lock.yaml",
    "React",
    "React DOM",
    "unrelated",
    "transitive",
    "WI-P2-001-APPLICATION-SHELL",
    "P2-004",
    "separate",
    "No database rollback applies",
  ]) {
    assert.ok(contract.includes(phrase), `missing contract phrase: ${phrase}`);
  }

  for (const phrase of [
    "Supabase",
    "authentication",
    "provider",
    "database",
    "Staging",
    "Production",
    "OLD",
    "P1-012",
    "F-01",
    "F-02",
    "F-03",
    "Founding Attorney",
    "Arizona",
    "launch",
    "Replit Agent",
    "Replit AI",
  ]) {
    assert.ok(
      contract.includes(phrase),
      `missing exclusion/boundary: ${phrase}`,
    );
  }

  const prerequisite = workItems.work_items.find(
    (entry) => entry.work_item_id === "WI-P2-001-APPLICATION-SHELL",
  );

  assert.ok(prerequisite);
  assert.equal(prerequisite.status, "completed");

  assert.ok(
    item.validation_commands.includes(
      "node --test tools/p0/tests/p0-nextjs-september-2026-security-patch-registration-contract.test.mjs",
    ),
  );
  assert.ok(
    item.validation_commands.includes("pnpm run p2:application-shell:test"),
  );
  assert.ok(item.validation_commands.includes("pnpm run p0:test"));
  assert.ok(item.validation_commands.includes("pnpm run secrets:check"));
  assert.ok(item.validation_commands.includes("pnpm run dependency:check"));

  // Intentionally no assertion freezes:
  // - rolling work-item status;
  // - future decision_refs;
  // - later authorized package.json or lockfile state;
  // - unrelated future governance evolution.
});
