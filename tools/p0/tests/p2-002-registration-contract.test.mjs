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
  assert.equal(item.status, "approved");
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
  ]);

  assert.deepEqual(item.dependencies, [
    "WI-P2-001-APPLICATION-SHELL",
    "WI-P0-P2-APPLICATION-SURFACE-CONTROL-EXTENSION",
  ]);

  assert.equal(item.created_at, item.updated_at);
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

  const appPackage = readJson("apps/web/package.json");

  assert.deepEqual(Object.keys(appPackage.dependencies ?? {}).sort(), [
    "next",
    "react",
    "react-dom",
  ]);

  assert.deepEqual(Object.keys(appPackage.devDependencies ?? {}).sort(), [
    "@types/node",
    "@types/react",
    "@types/react-dom",
    "typescript",
  ]);

  const rootPackage = readJson("package.json");

  assert.deepEqual(rootPackage.dependencies ?? {}, {});

  assert.deepEqual(Object.keys(rootPackage.devDependencies ?? {}).sort(), [
    "prettier",
    "typescript",
  ]);

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

  const p1012 = workItems.work_items.find(
    (entry) => entry.work_item_id === "WI-P1-012-PHYSICAL-1L",
  );

  assert.ok(p1012);
  assert.equal(p1012.status, "blocked");

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
