import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(new URL("../../../" + relativePath, import.meta.url), "utf8"),
  );
}

const PREREQ_ID = "WI-P0-P2-003-TRANSITION-CONTROL-ALIGNMENT";
const DECISION_ID =
  "DEC-20261001-P0-P2-003-TRANSITION-CONTROL-ALIGNMENT-CONTRACT";
const TARGET_ID = "WI-P2-003-SECURITY-SHELL";
const TARGET_CONTRACT_ID = "DEC-20260928-P2-003-SECURITY-SHELL-CONTRACT";

const REGISTRATION_ENVELOPE = [
  "governance/decision-log.json",
  "governance/work-items/index.json",
  "tools/p0/tests/p0-p2-003-transition-control-alignment-registration-contract.test.mjs",
  "tools/p0/tests/p2-003-registration-contract.test.mjs",
];

const ALIGNMENT_ENVELOPE = [
  "tools/p0/tests/p2-003-registration-contract.test.mjs",
  "apps/web/tests/design-system.test.mjs",
];

const TARGET_ENVELOPE = [
  "apps/web/src/application/security.ts",
  "apps/web/tests/security-shell.test.mjs",
  "apps/web/tests/application-shell.test.mjs",
];

test("P0 P2-003 transition-control alignment registration is bounded", () => {
  const decisions = readJson("governance/decision-log.json");
  const workItems = readJson("governance/work-items/index.json");

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
  assert.ok(["approved", "completed"].includes(item.status));
  assert.equal(item.priority, "P0");
  assert.equal(item.environment, "none");

  assert.deepEqual(decision.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });

  assert.deepEqual(item.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });

  assert.deepEqual(decision.authority_refs, [
    "P0-001-LOCKED",
    "DOMAIN-MODEL-V1.4-LOCKED",
    "TECHNICAL-ARCHITECTURE-V0.2-LOCKED",
    "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED",
  ]);

  assert.deepEqual(item.authority_refs, decision.authority_refs);
  assert.deepEqual(decision.work_item_refs, [PREREQ_ID, TARGET_ID]);
  assert.ok(item.decision_refs.includes(DECISION_ID));
  assert.deepEqual(item.dependencies, ["WI-P2-002-DESIGN-SYSTEM"]);
  assert.equal(item.dependencies.includes(TARGET_ID), false);

  assert.deepEqual(item.release_refs, []);
  assert.deepEqual(item.migration_refs, []);

  assert.match(item.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(item.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(decision.created_at, decision.updated_at);
  assert.equal(item.created_at, decision.created_at);
  assert.ok(Date.parse(item.updated_at) >= Date.parse(item.created_at));

  const registrationText = REGISTRATION_ENVELOPE.join("; ");

  assert.ok(
    item.in_scope.some(
      (entry) =>
        entry.includes(
          "Governance registration candidate surface limited to:",
        ) && entry.includes(registrationText),
    ),
  );

  const alignmentText = ALIGNMENT_ENVELOPE.join("; ");

  assert.ok(
    item.in_scope.some(
      (entry) =>
        entry.includes(
          "Later transition-control implementation surface limited to:",
        ) && entry.includes(alignmentText),
    ),
  );

  const target = workItems.work_items.find(
    (entry) => entry.work_item_id === TARGET_ID,
  );

  assert.ok(target);
  assert.ok(["approved", "completed"].includes(target.status));

  assert.equal(target.created_at, "2026-09-29T04:03:58Z");
  assert.match(target.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(Date.parse(target.updated_at) > Date.parse(target.created_at));
  assert.ok(Date.parse(target.updated_at) >= Date.parse(item.created_at));

  for (const dependency of [
    "WI-P2-001-APPLICATION-SHELL",
    "WI-P2-002-DESIGN-SYSTEM",
    PREREQ_ID,
  ]) {
    assert.ok(target.dependencies.includes(dependency));
  }

  for (const decisionRef of [
    "DEC-20260926-P2-001-APPLICATION-SHELL-CLOSURE",
    "DEC-20260927-P2-002-DESIGN-SYSTEM-CLOSURE",
    TARGET_CONTRACT_ID,
    DECISION_ID,
  ]) {
    assert.ok(target.decision_refs.includes(decisionRef));
  }

  const targetText = TARGET_ENVELOPE.join("; ");

  assert.ok(
    target.in_scope.some(
      (entry) =>
        entry.includes("Later P2-003 implementation surface limited to:") &&
        entry.includes(targetText),
    ),
  );

  const originalDecision = decisions.decisions.find(
    (entry) => entry.decision_id === TARGET_CONTRACT_ID,
  );

  assert.ok(originalDecision);
  assert.equal(originalDecision.status, "accepted");
  assert.equal(originalDecision.created_at, "2026-09-29T04:03:58Z");
  assert.equal(originalDecision.updated_at, "2026-09-29T04:03:58Z");

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
    "rolling-filesystem absence",
    "exact optional later files",
    "historical",
    "without widening",
    "No database rollback applies",
  ]) {
    assert.ok(contract.includes(phrase), "missing contract phrase: " + phrase);
  }

  for (const phrase of [
    "P2-003 Security Shell application implementation",
    "P3",
    "database",
    "P1-012",
    "F-01",
    "F-02",
    "F-03",
    "Staging",
    "Production",
    "OLD",
    "Replit Agent",
    "Replit AI",
  ]) {
    assert.ok(contract.includes(phrase), "missing exclusion: " + phrase);
  }

  const p2002 = workItems.work_items.find(
    (entry) => entry.work_item_id === "WI-P2-002-DESIGN-SYSTEM",
  );

  const p1012 = workItems.work_items.find(
    (entry) => entry.work_item_id === "WI-P1-012-PHYSICAL-1L",
  );

  assert.equal(p2002.status, "completed");
  assert.equal(p1012.status, "blocked");
});
