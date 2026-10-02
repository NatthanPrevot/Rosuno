import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(new URL("../../../" + relativePath, import.meta.url), "utf8"),
  );
}

const WORK_ITEM_ID = "WI-P2-003-SECURITY-SHELL";
const DECISION_ID = "DEC-20260928-P2-003-SECURITY-SHELL-CONTRACT";
const CLOSURE_ID = "DEC-20261002-P2-003-SECURITY-SHELL-CLOSURE";

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
  assert.equal(item.status, "completed");
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
    CLOSURE_ID,
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

test("P2-003 implementation lifecycle is durably closed", () => {
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
  assert.match(closure.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(
    Date.parse(closure.created_at) > Date.parse("2026-10-02T20:01:50Z"),
  );

  assert.deepEqual(closure.authority_refs, [
    "DOMAIN-MODEL-V1.4-LOCKED",
    "RELATIONAL-OBJECT-SPEC-V1.0-LOCKED",
    "TECHNICAL-ARCHITECTURE-V0.2-LOCKED",
    "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED",
  ]);

  for (const evidence of [
    "P2-003 candidate commit 2f2ef016975f6b5914f616e6a7bbe09c2c8f6d17 has sole parent a6018bfe0e04827a98c4a0824c99a9ffdf297341 and tree 0061ef9f6030741871e91026246f98b7a49d2228",
    "Implementation scope was exactly 3 authorized paths: apps/web/src/application/security.ts; apps/web/tests/security-shell.test.mjs; apps/web/tests/application-shell.test.mjs",
    "GitHub PR #54 reviewed exact head 2f2ef016975f6b5914f616e6a7bbe09c2c8f6d17 against base a6018bfe0e04827a98c4a0824c99a9ffdf297341",
    "Rosuno review 5396173281 (PRR_kwDOUHT1sc8AAAABQaMR4Q) APPROVED at 2026-10-02T19:53:59Z on exact head 2f2ef016975f6b5914f616e6a7bbe09c2c8f6d17",
    "GitHub Actions P0 control foundation run #108 (37056535437) succeeded on 2f2ef016975f6b5914f616e6a7bbe09c2c8f6d17",
    "GitHub PR #54 merged as 3a408b3e12e2bcd5e511eea148ea3ee447e37996 at 2026-10-02T20:01:50Z",
    "Merge 3a408b3e12e2bcd5e511eea148ea3ee447e37996 has ordered parents a6018bfe0e04827a98c4a0824c99a9ffdf297341 then 2f2ef016975f6b5914f616e6a7bbe09c2c8f6d17 and tree 0061ef9f6030741871e91026246f98b7a49d2228",
    "GitHub Actions P0 control foundation run #109 (37057937500) succeeded on 3a408b3e12e2bcd5e511eea148ea3ee447e37996",
    "Gate 5 N/A — repository-only P2-003 Security Shell work; no migration or database candidate exists",
    "Gate 6 N/A — no persistent Staging application exists for P2-003",
  ]) {
    assert.ok(closure.evidence.includes(evidence));
  }

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

  assert.deepEqual(item.dependencies, [
    "WI-P2-001-APPLICATION-SHELL",
    "WI-P2-002-DESIGN-SYSTEM",
    "WI-P0-P2-003-TRANSITION-CONTROL-ALIGNMENT",
  ]);

  assert.deepEqual(item.authority_refs, closure.authority_refs);

  for (const phrase of [
    "Gate 5 is N/A",
    "Gate 6 is N/A",
    "P1-012 remains conditional/deferred and blocked",
  ]) {
    assert.ok(item.acceptance_criteria.some((entry) => entry.includes(phrase)));
  }

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
    item.rollback_reference,
  ].join(" ");

  for (const phrase of [
    "P1-012",
    "F-01",
    "F-02",
    "F-03",
    "P3",
    "Staging",
    "Production",
    "OLD",
    "No database rollback applies",
  ]) {
    assert.ok(boundary.includes(phrase));
  }
});
