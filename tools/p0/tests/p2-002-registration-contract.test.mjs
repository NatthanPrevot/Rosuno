import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(new URL("../../../" + relativePath, import.meta.url), "utf8"),
  );
}

const WORK_ITEM_ID = "WI-P2-002-DESIGN-SYSTEM";
const DECISION_ID = "DEC-20260926-P2-002-DESIGN-SYSTEM-CONTRACT";
const CLOSURE_ID = "DEC-20260927-P2-002-DESIGN-SYSTEM-CLOSURE";

const DESIGN_BRIEF_SHA256 =
  "7f05ca3eec15532dd3cb8af36e1fcc006ed1d370c4e8e09d933b816832210d5c";

test("P2-002 registration preserves the human-approved Design System contract", () => {
  const decisions = readJson("governance/decision-log.json");
  const workItems = readJson("governance/work-items/index.json");

  const decisionMatches = decisions.decisions.filter(
    (entry) => entry.decision_id === DECISION_ID,
  );
  assert.equal(decisionMatches.length, 1);

  const itemMatches = workItems.work_items.filter(
    (entry) => entry.work_item_id === WORK_ITEM_ID,
  );
  assert.equal(itemMatches.length, 1);

  const decision = decisionMatches[0];
  const item = itemMatches[0];

  assert.equal(decision.status, "accepted");
  assert.equal(item.status, "completed");
  assert.equal(item.priority, "P2");
  assert.equal(item.environment, "development");

  assert.deepEqual(item.release_refs, []);
  assert.deepEqual(item.migration_refs, []);

  assert.deepEqual(decision.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });

  assert.deepEqual(item.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });

  assert.deepEqual(decision.authority_refs, [
    "DOMAIN-MODEL-V1.4-LOCKED",
    "TECHNICAL-ARCHITECTURE-V0.2-LOCKED",
    "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED",
  ]);

  assert.deepEqual(item.authority_refs, decision.authority_refs);

  assert.deepEqual(decision.work_item_refs, [WORK_ITEM_ID]);

  assert.deepEqual(item.decision_refs, [
    "DEC-20260926-P0-P2-APPLICATION-SURFACE-CONTROL-EXTENSION-CLOSURE",
    "DEC-20260926-P2-001-APPLICATION-SHELL-CLOSURE",
    DECISION_ID,
    CLOSURE_ID,
  ]);

  assert.deepEqual(item.dependencies, [
    "WI-P2-001-APPLICATION-SHELL",
    "WI-P0-P2-APPLICATION-SURFACE-CONTROL-EXTENSION",
  ]);

  assert.ok(Date.parse(item.updated_at) > Date.parse(item.created_at));
  assert.equal(decision.created_at, decision.updated_at);
  assert.equal(item.created_at, decision.created_at);

  assert.match(item.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  assert.ok(Date.parse(item.created_at) > Date.parse("2026-09-26T20:12:40Z"));

  const fullContract = [
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
    "typography",
    "spacing",
    "buttons",
    "forms",
    "tables",
    "status indicators",
    "dialogs",
    "notifications",
    "responsive",
    "system-serif",
    "system-sans",
    "cream/warm-white",
    "cocoa/chocolate",
    "premium gold",
    "public/client/attorney/admin",
    "Surface / Panel",
    "prefers-reduced-motion",
    "inline SVG",
    "currentColor",
    "photography",
    "visual-language evidence only",
    "dependency-free React",
    "ordinary CSS",
    "No database rollback applies",
  ]) {
    assert.ok(
      fullContract.includes(phrase),
      `missing P2-002 approved design phrase: ${phrase}`,
    );
  }

  assert.ok(
    decision.evidence.some(
      (entry) =>
        entry.includes(DESIGN_BRIEF_SHA256) &&
        entry.includes("human-approved visual implementation direction"),
    ),
    "missing exact human-approved design brief fingerprint",
  );

  for (const phrase of [
    "Tailwind",
    "shadcn",
    "Radix",
    "icon package",
    "motion library",
    "CSS preprocessor",
    "external font",
  ]) {
    assert.ok(
      fullContract.includes(phrase),
      `missing prohibited dependency boundary: ${phrase}`,
    );
  }

  for (const phrase of [
    "names",
    "prices",
    "practice areas",
    "metrics",
    "charts",
    "navigation labels",
    "workflow steps",
    "status values",
    "dashboard data",
    "copy",
    "business logic",
    "feature requirements",
  ]) {
    assert.ok(
      fullContract.includes(phrase),
      `missing mockup-content exclusion: ${phrase}`,
    );
  }

  const pathEnvelope =
    "apps/web/app/globals.css; apps/web/app/layout.tsx; apps/web/app/page.tsx; apps/web/src/presentation/design-system.tsx; apps/web/tests/design-system.test.mjs; apps/web/tests/application-shell.test.mjs only if required to preserve the original application-layer import-isolation intent while allowing the new presentation layer";

  assert.ok(
    item.in_scope.some(
      (entry) =>
        entry.includes("Later implementation surface limited to:") &&
        entry.includes(pathEnvelope),
    ),
  );

  assert.ok(
    item.out_of_scope.some((entry) =>
      entry.includes(
        "Repository addition of the human-approved Design Direction Brief",
      ),
    ),
  );

  // Historical P2-002 registration and closure evidence owns the dependency
  // state accepted for that work item. This historical contract test must not
  // freeze the rolling application manifest for later controlled phases.

  const p2001 = workItems.work_items.find(
    (entry) => entry.work_item_id === "WI-P2-001-APPLICATION-SHELL",
  );

  assert.ok(p2001);
  assert.equal(p2001.status, "completed");

  const p0 = workItems.work_items.find(
    (entry) =>
      entry.work_item_id === "WI-P0-P2-APPLICATION-SURFACE-CONTROL-EXTENSION",
  );

  assert.ok(p0);
  assert.equal(p0.status, "completed");

  assert.match(
    decision.impact,
    /does not turn the visual-reference mockups into feature requirements/,
  );

  assert.match(
    decision.rationale,
    /no prerequisite P0 control mutation or dependency expansion is required/,
  );

  assert.ok(
    decision.evidence.includes(
      "No P2-002 application implementation has started under this registration candidate",
    ),
  );
});

test("P2-002 implementation lifecycle is durably closed", () => {
  const decisions = readJson("governance/decision-log.json");
  const workItems = readJson("governance/work-items/index.json");

  const closureMatches = decisions.decisions.filter(
    (entry) => entry.decision_id === CLOSURE_ID,
  );
  assert.equal(closureMatches.length, 1);

  const closure = closureMatches[0];

  assert.equal(closure.status, "accepted");
  assert.deepEqual(closure.work_item_refs, [WORK_ITEM_ID]);
  assert.deepEqual(closure.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });
  assert.equal(closure.created_at, closure.updated_at);
  assert.ok(
    Date.parse(closure.created_at) > Date.parse("2026-09-27T04:30:59Z"),
  );

  for (const evidence of [
    "P2-002 candidate commit 1d8a166ffc36e7a47a7be808dc82f5f99759b3ff has sole parent 7fcea42f501956fd25a402804ddc924e535edffb and tree 6aa22b86b0ec05ece98e9d51ea40d0609d24c43b",
    "GitHub PR #48 reviewed exact head 1d8a166ffc36e7a47a7be808dc82f5f99759b3ff against base 7fcea42f501956fd25a402804ddc924e535edffb",
    "Rosuno review PRR_kwDOUHT1sc8AAAABPZ8dUA APPROVED at 2026-09-27T04:25:13Z on exact head 1d8a166ffc36e7a47a7be808dc82f5f99759b3ff",
    "GitHub Actions P0 control foundation run #96 (36294113519) succeeded on 1d8a166ffc36e7a47a7be808dc82f5f99759b3ff",
    "GitHub PR #48 merged as ba3698467d3ef36fcf301036de0fdba39d89efa0 at 2026-09-27T04:30:10Z",
    "Merge ba3698467d3ef36fcf301036de0fdba39d89efa0 has ordered parents 7fcea42f501956fd25a402804ddc924e535edffb then 1d8a166ffc36e7a47a7be808dc82f5f99759b3ff and tree 6aa22b86b0ec05ece98e9d51ea40d0609d24c43b",
    "GitHub Actions P0 control foundation run #97 (36294491949) succeeded on ba3698467d3ef36fcf301036de0fdba39d89efa0",
    "Gate 5 N/A — repository-only P2-002 Design System work; no migration or database candidate exists",
    "Gate 6 N/A — no persistent Staging application exists for P2-002",
  ]) {
    assert.ok(closure.evidence.includes(evidence));
  }

  assert.ok(
    closure.evidence.some((entry) =>
      entry.startsWith("Implementation scope was exactly 6 authorized paths:"),
    ),
  );

  const item = workItems.work_items.find(
    (entry) => entry.work_item_id === WORK_ITEM_ID,
  );

  assert.ok(item);
  assert.equal(item.status, "completed");
  assert.equal(item.environment, "development");
  assert.deepEqual(item.release_refs, []);
  assert.deepEqual(item.migration_refs, []);
  assert.equal(item.updated_at, closure.updated_at);
  assert.ok(item.decision_refs.includes(CLOSURE_ID));

  for (const phrase of [
    "Gate 5 is N/A",
    "Gate 6 is N/A",
    "P1-012 remains conditional/deferred and blocked",
  ]) {
    assert.ok(item.acceptance_criteria.some((entry) => entry.includes(phrase)));
  }

  const boundary = [
    closure.scope,
    closure.decision,
    closure.rationale,
    closure.impact,
    item.rollback_reference,
  ].join(" ");

  for (const phrase of [
    "P1-012",
    "F-01",
    "F-02",
    "F-03",
    "P2-003",
    "P3",
    "Staging",
    "Production",
    "OLD",
    "No database rollback applies",
  ]) {
    assert.ok(boundary.includes(phrase));
  }
});
