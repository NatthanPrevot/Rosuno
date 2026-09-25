import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(new URL("../../../" + relativePath, import.meta.url), "utf8"),
  );
}

test("P2-001 registration preserves the bounded Application Shell contract", () => {
  const decisions = readJson("governance/decision-log.json");
  const workItems = readJson("governance/work-items/index.json");
  const schema = readJson("governance/work-items/schema.json");

  const decisionMatches = decisions.decisions.filter(
    (entry) =>
      entry.decision_id === "DEC-20260925-P2-001-APPLICATION-SHELL-CONTRACT",
  );
  assert.equal(decisionMatches.length, 1);

  const decision = decisionMatches[0];
  assert.equal(decision.status, "proposed");
  assert.deepEqual(decision.reviewer, {
    identity: "pending designated human PR review",
    status: "pending",
  });
  assert.deepEqual(decision.work_item_refs, ["WI-P2-001-APPLICATION-SHELL"]);

  const matches = workItems.work_items.filter(
    (entry) => entry.work_item_id === "WI-P2-001-APPLICATION-SHELL",
  );
  assert.equal(matches.length, 1);

  const item = matches[0];

  assert.equal(item.priority, "P2");
  assert.equal(item.status, "proposed");
  assert.equal(item.environment, "development");
  assert.deepEqual(item.release_refs, []);
  assert.deepEqual(item.migration_refs, []);
  assert.deepEqual(item.reviewer, {
    identity: "pending designated human PR review",
    status: "pending",
  });

  assert.deepEqual(item.decision_refs, [
    "DEC-20260924-P1-CLOSURE-P2-TRANSITION",
    "DEC-20260925-P2-001-APPLICATION-SHELL-CONTRACT",
  ]);

  assert.deepEqual(item.dependencies, ["WI-P1-011-COMPLIANCE-FOUNDATION"]);

  const contract = [
    decision.scope,
    decision.decision,
    decision.rationale,
    decision.impact,
    item.objective,
    ...item.in_scope,
    ...item.out_of_scope,
    ...item.acceptance_criteria,
    item.rollback_reference,
  ].join(" ");

  for (const phrase of [
    "Next.js + React + TypeScript",
    "apps/web",
    "routing",
    "layout",
    "error",
    "loading",
    "form",
    "server-owned session",
    "API/service",
    "P2-002",
    "P2-003",
    "P3",
    "No database rollback applies",
  ]) {
    assert.ok(
      contract.includes(phrase),
      "missing P2-001 contract phrase: " + phrase,
    );
  }

  assert.match(
    decision.rationale,
    /implementation choice, not locked Rosuno authority/,
  );

  const p1012 = workItems.work_items.find(
    (entry) => entry.work_item_id === "WI-P1-012-PHYSICAL-1L",
  );
  assert.ok(p1012);
  assert.equal(p1012.status, "blocked");

  assert.deepEqual(schema.properties.priority.enum, ["P0", "P1", "P2"]);
  assert.ok(
    new RegExp(schema.properties.work_item_id.pattern).test(
      "WI-P2-001-APPLICATION-SHELL",
    ),
  );
  assert.equal(
    new RegExp(schema.properties.work_item_id.pattern).test(
      "WI-P3-001-UNAUTHORIZED",
    ),
    false,
  );
});
