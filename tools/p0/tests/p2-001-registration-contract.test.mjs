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
  assert.equal(decision.status, "accepted");
  assert.deepEqual(decision.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });
  assert.equal(decision.created_at, "2026-09-25T03:23:31Z");
  assert.match(decision.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(
    Date.parse(decision.updated_at) > Date.parse("2026-09-25T03:50:30Z"),
  );

  for (const evidence of [
    "GitHub PR #41 reviewed exact head 20783253c6e1e4d2e95887a43850eb2924cf3514",
    "Rosuno review PRR_kwDOUHT1sc8AAAABPK7DKA APPROVED at 2026-09-25T03:46:57Z",
    "GitHub PR #41 merged as b99c9e198bff1a3f917fbd02d884917e5e76982b at 2026-09-25T03:50:30Z",
    "GitHub Actions P0 control foundation run #83 (36091994647) succeeded on b99c9e198bff1a3f917fbd02d884917e5e76982b",
  ]) {
    assert.ok(
      decision.evidence.includes(evidence),
      "missing protected lifecycle evidence: " + evidence,
    );
  }

  assert.deepEqual(decision.work_item_refs, ["WI-P2-001-APPLICATION-SHELL"]);

  const matches = workItems.work_items.filter(
    (entry) => entry.work_item_id === "WI-P2-001-APPLICATION-SHELL",
  );
  assert.equal(matches.length, 1);

  const item = matches[0];

  assert.equal(item.priority, "P2");
  assert.equal(item.status, "approved");
  assert.equal(item.environment, "development");
  assert.deepEqual(item.release_refs, []);
  assert.deepEqual(item.migration_refs, []);
  assert.deepEqual(item.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });
  assert.equal(item.created_at, "2026-09-25T03:23:31Z");
  assert.equal(item.updated_at, decision.updated_at);

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
