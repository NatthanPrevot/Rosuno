import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(new URL("../../../" + relativePath, import.meta.url), "utf8"),
  );
}

const WORK_ITEM_ID = "WI-P0-NEXTJS-TRANSITIVE-DEPENDENCY-SECURITY-CORRECTION";
const DECISION_ID =
  "DEC-20261010-P0-NEXTJS-TRANSITIVE-DEPENDENCY-SECURITY-CORRECTION";

const PRIOR_WORK_ITEM_ID = "WI-P0-NEXTJS-SEPTEMBER-2026-SECURITY-PATCH";
const PRIOR_DECISION_IDS = [
  "DEC-20261003-P0-NEXTJS-SEPTEMBER-2026-SECURITY-PATCH-CONTRACT",
  "DEC-20261004-P0-NEXTJS-SEPTEMBER-2026-SECURITY-PATCH-CLOSURE",
];

const WRITABLE_ENVELOPE = [
  "governance/decision-log.json",
  "governance/work-items/index.json",
  "tools/p0/tests/p0-nextjs-transitive-dependency-security-correction-registration-contract.test.mjs",
  "pnpm-lock.yaml",
];

const AUTHORITY_REFS = [
  "TECHNICAL-ARCHITECTURE-V0.2-LOCKED",
  "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED",
];

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function loadRecords() {
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

  return {
    decisions,
    workItems,
    decision: decisionMatches[0],
    item: itemMatches[0],
  };
}

test("Next.js transitive dependency security correction registration remains bounded", () => {
  const { decision, item } = loadRecords();
  const envelope = WRITABLE_ENVELOPE.join("; ");

  assert.equal(decision.status, "accepted");
  assert.equal(decision.owner, "Rosuno Primary Thinker");
  assert.deepEqual(decision.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });
  assert.deepEqual(decision.supersedes, []);
  assert.equal(decision.expiry, null);
  assert.deepEqual(decision.authority_refs, AUTHORITY_REFS);
  assert.deepEqual(decision.work_item_refs, [WORK_ITEM_ID]);

  assert.equal(item.priority, "P0");
  assert.equal(item.environment, "development");
  assert.deepEqual(item.reviewer, { identity: "Rosuno", status: "approved" });
  assert.deepEqual(item.authority_refs, AUTHORITY_REFS);
  assert.ok(item.decision_refs.includes(DECISION_ID));
  assert.deepEqual(item.dependencies, []);
  assert.deepEqual(item.release_refs, []);
  assert.deepEqual(item.migration_refs, []);

  assert.match(decision.created_at, TIMESTAMP);
  assert.equal(decision.created_at, decision.updated_at);
  assert.match(item.created_at, TIMESTAMP);
  assert.match(item.updated_at, TIMESTAMP);

  assert.equal(WRITABLE_ENVELOPE.length, 4);
  assert.ok(decision.decision.includes("exactly four paths"));
  assert.ok(decision.decision.includes(envelope + "."));
  assert.ok(
    decision.evidence.includes(
      "Candidate surface is exactly 4 authorized paths: " + envelope,
    ),
  );
  assert.ok(
    item.in_scope.some(
      (entry) =>
        entry.startsWith("Candidate surface limited to exactly four") &&
        entry.endsWith(envelope),
    ),
  );
  assert.ok(
    item.acceptance_criteria.some(
      (entry) =>
        entry.startsWith("The candidate changes exactly four authorized") &&
        entry.endsWith(envelope),
    ),
  );

  // Intentionally no assertion freezes:
  // - rolling work-item status;
  // - future decision_refs;
  // - pnpm-lock.yaml or package.json bytes (this test never reads them);
  // - unrelated future governance evolution.
});

test("Next.js transitive dependency security correction preserves exact security targets and boundaries", () => {
  const { decision, item } = loadRecords();

  assert.ok(
    decision.decision.includes("source-map-js 1.2.1 to 1.2.2") &&
      decision.decision.includes("sharp 0.35.4 to 0.35.5"),
  );
  assert.ok(
    item.objective.includes("source-map-js 1.2.1 to 1.2.2") &&
      item.objective.includes("sharp 0.35.4 to 0.35.5"),
  );
  assert.ok(
    item.acceptance_criteria.some((entry) =>
      entry.includes(
        "resolves source-map-js to 1.2.2 and sharp to 0.35.5, replacing 1.2.1 and 0.35.4",
      ),
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
    "GHSA-68fv-2mgg-jv7q",
    "GHSA-wq5f-xc86-pv6w",
    "source-map-js",
    "sharp",
    "pnpm-lock.yaml",
    "transitive",
    "forward-only",
    "not a repeat of completed " + PRIOR_WORK_ITEM_ID,
    "human-only",
    "separately authorized",
    "the Builder executes no shell, test, or dependency command",
    "strictly required lockfile bookkeeping",
    "no unrelated lockfile churn",
    "pnpm 10.26.1",
    "preinstall",
    "STOP",
    "No database rollback applies",
  ]) {
    assert.ok(contract.includes(phrase), `missing contract phrase: ${phrase}`);
  }

  for (const phrase of [
    "apps/web/package.json",
    "Next.js",
    "PostCSS",
    "React",
    "migrations",
    "credentials",
    "database",
    "Staging",
    "Production",
    "OLD",
    "G-1 through G-5",
    "F-01/F-02/F-03",
  ]) {
    assert.ok(
      contract.includes(phrase),
      `missing exclusion/boundary: ${phrase}`,
    );
  }

  assert.ok(
    item.out_of_scope.some((entry) =>
      entry.startsWith("Any modification of apps/web/package.json"),
    ),
  );
  assert.ok(decision.impact.includes("does not itself modify pnpm-lock.yaml"));

  for (const command of [
    "node --test tools/p0/tests/p0-nextjs-transitive-dependency-security-correction-registration-contract.test.mjs",
    "pnpm run format:check",
    "pnpm run typecheck",
    "pnpm run build",
    "pnpm run p0:validate",
    "pnpm run p0:test",
    "pnpm run secrets:check",
    "pnpm run dependency:check",
    "git diff --check",
  ]) {
    assert.ok(
      item.validation_commands.includes(command),
      `missing validation command: ${command}`,
    );
  }
});

test("Next.js transitive dependency security correction preserves historical governance", () => {
  const { decisions, workItems } = loadRecords();

  const decisionIds = decisions.decisions.map((entry) => entry.decision_id);
  const workItemIds = workItems.work_items.map((entry) => entry.work_item_id);

  assert.equal(new Set(decisionIds).size, decisionIds.length);
  assert.equal(new Set(workItemIds).size, workItemIds.length);

  for (const priorId of PRIOR_DECISION_IDS) {
    const prior = decisions.decisions.find(
      (entry) => entry.decision_id === priorId,
    );

    assert.ok(prior, `missing historical decision: ${priorId}`);
    assert.equal(prior.status, "accepted");
  }

  const priorItem = workItems.work_items.find(
    (entry) => entry.work_item_id === PRIOR_WORK_ITEM_ID,
  );

  assert.ok(priorItem);
  assert.equal(priorItem.status, "completed");
  assert.ok(
    PRIOR_DECISION_IDS.every((id) => priorItem.decision_refs.includes(id)),
  );
  assert.ok(!priorItem.decision_refs.includes(DECISION_ID));

  // Historical Next.js security-patch evidence is preserved above without
  // pinning its bytes, and this test does not read apps/web/package.json or
  // pnpm-lock.yaml, so it never freezes future authorized package state.
});
