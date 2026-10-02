import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(new URL("../../../" + relativePath, import.meta.url), "utf8"),
  );
}

const PREREQ_ID = "WI-P0-P3-IDENTITY-CONTROL-ALIGNMENT";
const DECISION_ID = "DEC-20261002-P0-P3-IDENTITY-CONTROL-ALIGNMENT-CONTRACT";

const REGISTRATION_ENVELOPE = [
  "governance/decision-log.json",
  "governance/work-items/index.json",
  "tools/p0/tests/p0-p3-identity-control-alignment-registration-contract.test.mjs",
];

const ALIGNMENT_ENVELOPE = [
  "tools/p0/lib/controls.mjs",
  "tools/p0/tests/p0-controls.test.mjs",
  "tools/p0/tests/p2-002-registration-contract.test.mjs",
  "tools/p0/tests/p2-003-registration-contract.test.mjs",
  "apps/web/tests/design-system.test.mjs",
  "apps/web/tests/application-shell.test.mjs",
];

const AUTHORITY_REFS = [
  "P0-001-LOCKED",
  "DOMAIN-MODEL-V1.4-LOCKED",
  "PHYSICAL-SUPABASE-POSTGRES-V1.0-LOCKED",
  "TECHNICAL-ARCHITECTURE-V0.2-LOCKED",
  "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED",
];

test("P0/P3 Identity Control Alignment registration is bounded", () => {
  const decisions = readJson("governance/decision-log.json");
  const workItems = readJson("governance/work-items/index.json");
  const schema = readJson("governance/work-items/schema.json");

  const decisionMatches = decisions.decisions.filter(
    (entry) => entry.decision_id === DECISION_ID,
  );

  const itemMatches = workItems.work_items.filter(
    (entry) => entry.work_item_id === PREREQ_ID,
  );

  assert.equal(decisionMatches.length, 1);
  assert.equal(itemMatches.length, 1);

  const decision = decisionMatches[0];
  const item = itemMatches[0];

  assert.equal(decision.status, "accepted");
  assert.equal(item.status, "approved");
  assert.equal(item.priority, "P0");
  assert.equal(item.environment, "none");

  assert.deepEqual(decision.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });

  assert.deepEqual(item.reviewer, decision.reviewer);

  assert.deepEqual(decision.authority_refs, AUTHORITY_REFS);
  assert.deepEqual(item.authority_refs, AUTHORITY_REFS);
  assert.deepEqual(decision.work_item_refs, [PREREQ_ID]);
  assert.deepEqual(item.decision_refs, [DECISION_ID]);
  assert.deepEqual(item.dependencies, ["WI-P2-003-SECURITY-SHELL"]);

  assert.deepEqual(item.release_refs, []);
  assert.deepEqual(item.migration_refs, []);

  assert.equal(decision.created_at, decision.updated_at);
  assert.equal(item.created_at, item.updated_at);
  assert.equal(item.created_at, decision.created_at);

  assert.match(item.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  assert.deepEqual(schema.properties.priority.enum, ["P0", "P1", "P2"]);

  const idPattern = new RegExp(schema.properties.work_item_id.pattern);

  assert.equal(idPattern.test(PREREQ_ID), true);
  assert.equal(idPattern.test("WI-P3-001-UNAUTHORIZED"), false);

  assert.equal(
    workItems.work_items.some((entry) => /^WI-P3-/.test(entry.work_item_id)),
    false,
  );

  assert.ok(
    item.in_scope.some((entry) =>
      REGISTRATION_ENVELOPE.every((path) => entry.includes(path)),
    ),
  );

  assert.ok(
    item.in_scope.some((entry) =>
      ALIGNMENT_ENVELOPE.every((path) => entry.includes(path)),
    ),
  );

  for (const packageName of ["@supabase/supabase-js", "@supabase/ssr"]) {
    assert.ok(
      item.in_scope.some((entry) => entry.includes(packageName)),
      `missing bounded future dependency: ${packageName}`,
    );
  }

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
    "forward-only",
    "historical P2",
    "registry-semver",
    "fail-closed",
    "Security Shell",
    "design system",
    "application shell",
    "P0/P1/P2",
    "No database rollback applies",
  ]) {
    assert.ok(contract.includes(phrase), `missing contract phrase: ${phrase}`);
  }

  for (const phrase of [
    "package installation",
    "P3 application implementation",
    "Supabase Auth",
    "P1-012",
    "F-01",
    "F-02",
    "F-03",
    "Staging",
    "Production",
    "OLD",
    "Replit Agent",
    "Replit AI",
    "pull request",
    "merge",
  ]) {
    assert.ok(contract.includes(phrase), `missing exclusion: ${phrase}`);
  }

  for (const [id, status] of [
    ["WI-P2-001-APPLICATION-SHELL", "completed"],
    ["WI-P2-002-DESIGN-SYSTEM", "completed"],
    ["WI-P2-003-SECURITY-SHELL", "completed"],
    ["WI-P1-012-PHYSICAL-1L", "blocked"],
  ]) {
    const existing = workItems.work_items.find(
      (entry) => entry.work_item_id === id,
    );

    assert.ok(existing, `missing existing work item: ${id}`);
    assert.equal(existing.status, status, id);
  }

  assert.ok(
    item.validation_commands.includes(
      "node --test tools/p0/tests/p0-p3-identity-control-alignment-registration-contract.test.mjs",
    ),
  );

  assert.ok(item.validation_commands.includes("pnpm run p0:test"));
  assert.ok(item.validation_commands.includes("pnpm run secrets:check"));
  assert.ok(item.validation_commands.includes("pnpm run dependency:check"));
});
