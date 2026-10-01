import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(new URL("../../../" + relativePath, import.meta.url), "utf8"),
  );
}

const WORK_ITEM_ID = "WI-P2-003-SECURITY-SHELL";
const DECISION_ID = "DEC-20260928-P2-003-SECURITY-SHELL-CONTRACT";

const IMPLEMENTATION_ENVELOPE = [
  "apps/web/src/application/security.ts",
  "apps/web/tests/security-shell.test.mjs",
  "apps/web/tests/application-shell.test.mjs",
];

test("P2-003 registration preserves the bounded Security Shell contract", () => {
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
  assert.equal(item.status, "approved");
  assert.equal(item.priority, "P2");
  assert.equal(item.environment, "development");

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
    "RELATIONAL-OBJECT-SPEC-V1.0-LOCKED",
    "TECHNICAL-ARCHITECTURE-V0.2-LOCKED",
    "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED",
  ]);
  assert.deepEqual(item.authority_refs, decision.authority_refs);

  assert.deepEqual(decision.work_item_refs, [WORK_ITEM_ID]);

  assert.deepEqual(item.decision_refs, [
    "DEC-20260926-P2-001-APPLICATION-SHELL-CLOSURE",
    "DEC-20260927-P2-002-DESIGN-SYSTEM-CLOSURE",
    DECISION_ID,
    "DEC-20261001-P0-P2-003-TRANSITION-CONTROL-ALIGNMENT-CONTRACT",
  ]);

  assert.deepEqual(item.dependencies, [
    "WI-P2-001-APPLICATION-SHELL",
    "WI-P2-002-DESIGN-SYSTEM",
    "WI-P0-P2-003-TRANSITION-CONTROL-ALIGNMENT",
  ]);

  assert.deepEqual(item.release_refs, []);
  assert.deepEqual(item.migration_refs, []);

  assert.equal(item.created_at, "2026-09-29T04:03:58Z");
  assert.match(item.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(Date.parse(item.updated_at) > Date.parse(item.created_at));
  assert.equal(decision.created_at, decision.updated_at);
  assert.equal(item.created_at, decision.created_at);
  assert.match(item.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  const p2001 = workItems.work_items.find(
    (entry) => entry.work_item_id === "WI-P2-001-APPLICATION-SHELL",
  );
  const p2002 = workItems.work_items.find(
    (entry) => entry.work_item_id === "WI-P2-002-DESIGN-SYSTEM",
  );
  const p1012 = workItems.work_items.find(
    (entry) => entry.work_item_id === "WI-P1-012-PHYSICAL-1L",
  );

  assert.equal(p2001.status, "completed");
  assert.equal(p2002.status, "completed");
  assert.equal(p1012.status, "blocked");

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
    "authenticated-route",
    "principal",
    "capability",
    "scope",
    "server-side",
    "mutation",
    "error redaction",
    "fail-closed",
    "browser",
    "P3",
    "No database rollback applies",
  ]) {
    assert.ok(contract.includes(phrase), `missing contract phrase: ${phrase}`);
  }

  for (const phrase of [
    "superuser",
    "wildcard",
    "everything capability",
    "role-only",
    "Supabase Auth",
    "rate limiting",
    "Staging",
    "Production",
    "OLD",
    "F-01",
    "F-02",
    "F-03",
    "Arizona",
  ]) {
    assert.ok(contract.includes(phrase), `missing exclusion: ${phrase}`);
  }

  const envelopeText = IMPLEMENTATION_ENVELOPE.join("; ");

  assert.ok(
    item.in_scope.some(
      (entry) =>
        entry.includes("Later P2-003 implementation surface limited to:") &&
        entry.includes(envelopeText),
    ),
  );

  assert.equal(
    existsSync(
      new URL("../../../apps/web/src/application/security.ts", import.meta.url),
    ),
    false,
  );

  assert.equal(
    existsSync(
      new URL(
        "../../../apps/web/tests/security-shell.test.mjs",
        import.meta.url,
      ),
    ),
    false,
  );

  const sessionSource = readFileSync(
    new URL("../../../apps/web/src/application/session.ts", import.meta.url),
    "utf8",
  );

  const sessionCommentText = sessionSource.replace(/^\s*\/\/\s?/gm, " ");

  assert.match(
    sessionCommentText,
    /Nothing\s+the browser sends[\s\S]*is\s+accepted here as identity\./,
  );

  assert.match(sessionSource, /No identity provider exists before P3/);

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
});
