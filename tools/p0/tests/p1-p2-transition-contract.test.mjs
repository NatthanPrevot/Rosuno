import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(new URL("../../../" + relativePath, import.meta.url), "utf8"),
  );
}

function sha256(relativePath) {
  return createHash("sha256")
    .update(readFileSync(new URL("../../../" + relativePath, import.meta.url)))
    .digest("hex");
}

test("P1 closure preserves deferred Physical 1L and the accepted database baseline", () => {
  const decisions = readJson("governance/decision-log.json");
  const workItems = readJson("governance/work-items/index.json");
  const migrations = readJson("governance/migrations/reviewed-migrations.json");
  const releases = readJson("governance/releases/traceability.json");
  const baseline = readJson("governance/schema-drift/baseline.json");

  const primaryP1 = [
    "WI-P1-001-PLATFORM-FOUNDATION",
    "WI-P1-002-AUTHORIZATION-FOUNDATION",
    "WI-P1-003-JURISDICTION-POLICY-LAUNCH-FOUNDATION",
    "WI-P1-004-ATTORNEY-VERIFICATION-ELIGIBILITY-FOUNDATION",
    "WI-P1-005-CLIENT-INTAKE-AI-FOUNDATION",
    "WI-P1-006-MARKETPLACE-REFERRAL-FOUNDATION",
    "WI-P1-007-SCHEDULING-REQUEST-BOOKING-BOOKABILITY-FOUNDATION",
    "WI-P1-008-CONSULTATION-ENGAGEMENT-MEDIA-FOUNDATION",
    "WI-P1-009-RESOURCES-COMMUNICATIONS-FOUNDATION",
    "WI-P1-010-FINANCIAL-FOUNDATION",
    "WI-P1-011-COMPLIANCE-FOUNDATION",
  ];

  for (const id of primaryP1) {
    const item = workItems.work_items.find(
      (entry) => entry.work_item_id === id,
    );
    assert.ok(item, "missing closed P1 item: " + id);
    assert.equal(item.status, "completed", id + " must remain completed");
  }

  const decisionMatches = decisions.decisions.filter(
    (entry) => entry.decision_id === "DEC-20260924-P1-CLOSURE-P2-TRANSITION",
  );
  assert.equal(decisionMatches.length, 1);
  const decision = decisionMatches[0];
  assert.equal(decision.status, "proposed");
  assert.deepEqual(decision.reviewer, {
    identity: "pending designated human PR review",
    status: "pending",
  });
  assert.deepEqual(decision.work_item_refs, [
    "WI-P1-011-COMPLIANCE-FOUNDATION",
    "WI-P1-012-PHYSICAL-1L",
  ]);

  const p1012Matches = workItems.work_items.filter(
    (entry) => entry.work_item_id === "WI-P1-012-PHYSICAL-1L",
  );
  assert.equal(p1012Matches.length, 1);
  const p1012 = p1012Matches[0];
  assert.equal(p1012.status, "blocked");
  assert.equal(p1012.environment, "none");
  assert.deepEqual(p1012.release_refs, []);
  assert.deepEqual(p1012.migration_refs, []);
  assert.deepEqual(p1012.decision_refs, [
    "DEC-20260924-P1-CLOSURE-P2-TRANSITION",
  ]);

  const contract = [
    decision.scope,
    decision.decision,
    decision.rationale,
    decision.impact,
    p1012.objective,
    ...p1012.in_scope,
    ...p1012.out_of_scope,
    ...p1012.acceptance_criteria,
  ].join(" ");

  for (const phrase of [
    "P1-001 through P1-011",
    "CONDITIONAL / DEFERRED at Gate 0 STOP",
    "intended first-launch jurisdiction",
    "regulatory mode remains unresolved",
    "jurisdiction-neutral P1 Database/RLS Foundation",
    "P2 / Application Foundation Gate 0 is the next eligible controlled work",
  ]) {
    assert.ok(
      contract.includes(phrase),
      "missing transition phrase: " + phrase,
    );
  }

  assert.match(
    decision.decision,
    /Arizona is not READY, LIVE, approved for launch, ABS, non-ABS, LRS, non-LRS, or otherwise legally classified/,
  );

  assert.equal(migrations.migrations.length, 13);
  assert.equal(
    migrations.migrations.at(-1).migration_id,
    "20260921051204_p1_compliance_foundation",
  );
  assert.equal(baseline.baseline_id, "rosuno-staging-p1-011-20260923-v1");
  assert.equal(baseline.migration_inventory.length, 13);
  assert.equal(
    baseline.catalog_fingerprint.sha256,
    "edffaba2b7e081c3c8c78c158ce33a444a448671bf338188356d1118f0a9960a",
  );
  assert.equal(
    releases.releases.some(
      (entry) =>
        entry.work_item_refs?.includes("WI-P1-012-PHYSICAL-1L") ||
        entry.decision_refs?.includes("DEC-20260924-P1-CLOSURE-P2-TRANSITION"),
    ),
    false,
  );

  assert.equal(
    sha256("governance/migrations/reviewed-migrations.json"),
    "fdc9733cef8c7a573c3113cd56ba0fe10fa3a8b621b45cad3a099a61d81addde",
  );
  assert.equal(
    sha256("governance/releases/traceability.json"),
    "f3707b75fb027d26172cb7cb404428fa6e4e7d9980f04db1ea7ffbd7d8fd2691",
  );
  assert.equal(
    sha256("governance/schema-drift/baseline.json"),
    "196caee4de2c870652ce5b716a9b02c484c97181b1d9c59e5abbc5c2966b2d65",
  );
});
