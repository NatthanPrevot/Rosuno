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
const CLOSURE_ID =
  "DEC-20261001-P0-P2-003-TRANSITION-CONTROL-ALIGNMENT-CLOSURE";
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

test("P0 P2-003 transition-control alignment lifecycle is durably closed", () => {
  const decisions = readJson("governance/decision-log.json");
  const workItems = readJson("governance/work-items/index.json");

  const closureMatches = decisions.decisions.filter(
    (entry) => entry.decision_id === CLOSURE_ID,
  );

  assert.equal(closureMatches.length, 1);

  const closure = closureMatches[0];

  assert.equal(closure.status, "accepted");
  assert.deepEqual(closure.work_item_refs, [PREREQ_ID]);
  assert.deepEqual(closure.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });
  assert.deepEqual(closure.authority_refs, [
    "P0-001-LOCKED",
    "DOMAIN-MODEL-V1.4-LOCKED",
    "TECHNICAL-ARCHITECTURE-V0.2-LOCKED",
    "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED",
  ]);
  assert.equal(closure.created_at, closure.updated_at);
  assert.ok(
    Date.parse(closure.created_at) > Date.parse("2026-10-01T20:13:04Z"),
  );

  for (const evidence of [
    "P2-003 transition-control alignment candidate c9fd41f08cb0ff1eec718a78d41f78b63fa87f01 has sole parent 7630ba388ed766d0f964c7810cd0cf24df7b40d0 and tree 644f150b7358469e3afbbce6cecc5c0ed8422a7c",
    "Implementation scope was exactly 2 authorized paths: apps/web/tests/design-system.test.mjs; tools/p0/tests/p2-003-registration-contract.test.mjs",
    "GitHub PR #52 reviewed exact head c9fd41f08cb0ff1eec718a78d41f78b63fa87f01 against base 7630ba388ed766d0f964c7810cd0cf24df7b40d0",
    "Rosuno review 5384906058 (PRR_kwDOUHT1sc8AAAABQPclSg) APPROVED at 2026-10-01T20:09:55Z on exact head c9fd41f08cb0ff1eec718a78d41f78b63fa87f01",
    "GitHub Actions P0 control foundation run #104 (36915891645) succeeded on c9fd41f08cb0ff1eec718a78d41f78b63fa87f01",
    "GitHub PR #52 merged as 097b0b00f551e30b366407e95f181b901b44bca1 at 2026-10-01T20:12:11Z",
    "Merge 097b0b00f551e30b366407e95f181b901b44bca1 has ordered parents 7630ba388ed766d0f964c7810cd0cf24df7b40d0 then c9fd41f08cb0ff1eec718a78d41f78b63fa87f01 and tree 644f150b7358469e3afbbce6cecc5c0ed8422a7c",
    "GitHub Actions P0 control foundation run #105 (36919848204) succeeded on 097b0b00f551e30b366407e95f181b901b44bca1",
    "Gate 5 N/A — repository-only transition-control prerequisite; no migration or database candidate exists",
    "Gate 6 N/A — no persistent Staging application exists for the transition-control prerequisite",
    "WI-P2-003-SECURITY-SHELL remains approved and unimplemented; its existing dependencies and decision references are unchanged",
  ]) {
    assert.ok(
      closure.evidence.includes(evidence),
      "missing closure evidence: " + evidence,
    );
  }

  const prereqMatches = workItems.work_items.filter(
    (entry) => entry.work_item_id === PREREQ_ID,
  );

  assert.equal(prereqMatches.length, 1);

  const prereq = prereqMatches[0];

  assert.equal(prereq.status, "completed");
  assert.equal(prereq.environment, "none");
  assert.equal(prereq.created_at, "2026-10-01T09:31:23Z");
  assert.equal(prereq.updated_at, closure.updated_at);
  assert.deepEqual(prereq.decision_refs, [DECISION_ID, CLOSURE_ID]);
  assert.deepEqual(prereq.dependencies, ["WI-P2-002-DESIGN-SYSTEM"]);
  assert.deepEqual(prereq.release_refs, []);
  assert.deepEqual(prereq.migration_refs, []);

  for (const phrase of [
    "Gate 5 is N/A",
    "Gate 6 is N/A",
    "WI-P2-003-SECURITY-SHELL remains approved and unimplemented",
  ]) {
    assert.ok(
      prereq.acceptance_criteria.some((entry) => entry.includes(phrase)),
    );
  }

  assert.match(
    prereq.rollback_reference,
    /Repository-only Gate 7 lifecycle closure/,
  );
  assert.match(prereq.rollback_reference, /No database rollback applies/);

  const target = workItems.work_items.find(
    (entry) => entry.work_item_id === TARGET_ID,
  );

  assert.ok(target);
  assert.equal(target.status, "approved");
  assert.equal(target.created_at, "2026-09-29T04:03:58Z");
  assert.equal(target.updated_at, "2026-10-01T09:31:23Z");

  assert.deepEqual(target.decision_refs, [
    "DEC-20260926-P2-001-APPLICATION-SHELL-CLOSURE",
    "DEC-20260927-P2-002-DESIGN-SYSTEM-CLOSURE",
    TARGET_CONTRACT_ID,
    DECISION_ID,
  ]);

  assert.deepEqual(target.dependencies, [
    "WI-P2-001-APPLICATION-SHELL",
    "WI-P2-002-DESIGN-SYSTEM",
    PREREQ_ID,
  ]);

  assert.equal(target.decision_refs.includes(CLOSURE_ID), false);

  const p1012 = workItems.work_items.find(
    (entry) => entry.work_item_id === "WI-P1-012-PHYSICAL-1L",
  );

  assert.ok(p1012);
  assert.equal(p1012.status, "blocked");

  const boundary = [
    closure.scope,
    closure.decision,
    closure.rationale,
    closure.impact,
    prereq.rollback_reference,
  ].join(" ");

  for (const phrase of [
    "WI-P2-003-SECURITY-SHELL",
    "P2-003 application implementation",
    "P3",
    "P1-012",
    "F-01",
    "F-02",
    "F-03",
    "Staging",
    "Production",
    "OLD",
    "No database rollback applies",
  ]) {
    assert.ok(boundary.includes(phrase), "missing closure boundary: " + phrase);
  }
});
