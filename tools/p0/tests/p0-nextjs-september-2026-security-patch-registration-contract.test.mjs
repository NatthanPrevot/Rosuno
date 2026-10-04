import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(new URL("../../../" + relativePath, import.meta.url), "utf8"),
  );
}

const WORK_ITEM_ID = "WI-P0-NEXTJS-SEPTEMBER-2026-SECURITY-PATCH";
const DECISION_ID =
  "DEC-20261003-P0-NEXTJS-SEPTEMBER-2026-SECURITY-PATCH-CONTRACT";

const REGISTRATION_ENVELOPE = [
  "governance/decision-log.json",
  "governance/work-items/index.json",
  "tools/p0/tests/p0-nextjs-september-2026-security-patch-registration-contract.test.mjs",
];

const IMPLEMENTATION_ENVELOPE = ["apps/web/package.json", "pnpm-lock.yaml"];

const AUTHORITY_REFS = [
  "P0-001-LOCKED",
  "TECHNICAL-ARCHITECTURE-V0.2-LOCKED",
  "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED",
];

test("Next.js September 2026 security patch registration remains bounded and transition-safe", () => {
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
  assert.equal(item.priority, "P0");
  assert.equal(item.environment, "development");

  assert.deepEqual(decision.authority_refs, AUTHORITY_REFS);
  assert.deepEqual(item.authority_refs, AUTHORITY_REFS);
  assert.deepEqual(decision.work_item_refs, [WORK_ITEM_ID]);

  assert.ok(item.decision_refs.includes(DECISION_ID));
  assert.ok(item.dependencies.includes("WI-P2-001-APPLICATION-SHELL"));

  assert.deepEqual(item.release_refs, []);
  assert.deepEqual(item.migration_refs, []);

  assert.equal(decision.created_at, decision.updated_at);
  assert.match(decision.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(item.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(item.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  assert.ok(
    item.in_scope.some((entry) =>
      REGISTRATION_ENVELOPE.every((path) => entry.includes(path)),
    ),
  );

  assert.ok(
    item.in_scope.some((entry) =>
      IMPLEMENTATION_ENVELOPE.every((path) => entry.includes(path)),
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
    "^16.3.6",
    "^16.3.8",
    "16.3.8",
    "apps/web/package.json",
    "pnpm-lock.yaml",
    "React",
    "React DOM",
    "unrelated",
    "transitive",
    "WI-P2-001-APPLICATION-SHELL",
    "P2-004",
    "separate",
    "No database rollback applies",
  ]) {
    assert.ok(contract.includes(phrase), `missing contract phrase: ${phrase}`);
  }

  for (const phrase of [
    "Supabase",
    "authentication",
    "provider",
    "database",
    "Staging",
    "Production",
    "OLD",
    "P1-012",
    "F-01",
    "F-02",
    "F-03",
    "Founding Attorney",
    "Arizona",
    "launch",
    "Replit Agent",
    "Replit AI",
  ]) {
    assert.ok(
      contract.includes(phrase),
      `missing exclusion/boundary: ${phrase}`,
    );
  }

  const prerequisite = workItems.work_items.find(
    (entry) => entry.work_item_id === "WI-P2-001-APPLICATION-SHELL",
  );

  assert.ok(prerequisite);
  assert.equal(prerequisite.status, "completed");

  assert.ok(
    item.validation_commands.includes(
      "node --test tools/p0/tests/p0-nextjs-september-2026-security-patch-registration-contract.test.mjs",
    ),
  );
  assert.ok(
    item.validation_commands.includes("pnpm run p2:application-shell:test"),
  );
  assert.ok(item.validation_commands.includes("pnpm run p0:test"));
  assert.ok(item.validation_commands.includes("pnpm run secrets:check"));
  assert.ok(item.validation_commands.includes("pnpm run dependency:check"));

  // Intentionally no assertion freezes:
  // - rolling work-item status;
  // - future decision_refs;
  // - later authorized package.json or lockfile state;
  // - unrelated future governance evolution.
});

test("Next.js September 2026 security patch lifecycle is durably closed", () => {
  const decisions = readJson("governance/decision-log.json");
  const workItems = readJson("governance/work-items/index.json");

  const closureId =
    "DEC-20261004-P0-NEXTJS-SEPTEMBER-2026-SECURITY-PATCH-CLOSURE";

  const closureMatches = decisions.decisions.filter(
    (entry) => entry.decision_id === closureId,
  );

  assert.equal(closureMatches.length, 1);

  const closure = closureMatches[0];

  assert.equal(closure.status, "accepted");
  assert.deepEqual(closure.work_item_refs, [WORK_ITEM_ID]);
  assert.deepEqual(closure.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });
  assert.deepEqual(closure.authority_refs, AUTHORITY_REFS);

  assert.equal(closure.created_at, closure.updated_at);
  assert.match(closure.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(
    Date.parse(closure.created_at) > Date.parse("2026-10-04T02:25:51Z"),
  );

  const lifecycleEvidence = [
    "Retrospective governance closure record for WI-P0-NEXTJS-SEPTEMBER-2026-SECURITY-PATCH; canonical closure is created only after registration and implementation completed their protected repository lifecycles",
    "Registration candidate ebb2972b15a632760cb5dcacddb7a342ae303b7c has sole parent c3ac36033c4713ce318462ba2989ca60e2d32548 and tree 255e6206891991678f79d461a64863667db8ea69",
    "Registration scope was exactly 3 authorized paths: governance/decision-log.json; governance/work-items/index.json; tools/p0/tests/p0-nextjs-september-2026-security-patch-registration-contract.test.mjs",
    "GitHub PR #61 reviewed exact registration head ebb2972b15a632760cb5dcacddb7a342ae303b7c against base c3ac36033c4713ce318462ba2989ca60e2d32548",
    "Rosuno registration review PRR_kwDOUHT1sc8AAAABQhZknA APPROVED at 2026-10-04T01:18:32Z on exact head ebb2972b15a632760cb5dcacddb7a342ae303b7c",
    "GitHub Actions P0 control foundation run #122 (37163083294) succeeded on registration candidate ebb2972b15a632760cb5dcacddb7a342ae303b7c",
    "GitHub PR #61 merged through merge commit 346543eaf946d3583906b5f5d657e45fe961548a at 2026-10-04T01:33:38Z",
    "Registration merge 346543eaf946d3583906b5f5d657e45fe961548a has ordered parents c3ac36033c4713ce318462ba2989ca60e2d32548 then ebb2972b15a632760cb5dcacddb7a342ae303b7c and tree 255e6206891991678f79d461a64863667db8ea69",
    "GitHub Actions P0 control foundation post-registration run #123 (37168386712) succeeded on canonical main 346543eaf946d3583906b5f5d657e45fe961548a",
    "Implementation candidate 73f5512970829956c20d5274a6deb94918153332 has sole parent 346543eaf946d3583906b5f5d657e45fe961548a and tree 3466f56af8dfade939740c993b5287289966909b",
    "Implementation scope was exactly 2 authorized paths: apps/web/package.json; pnpm-lock.yaml",
    "GitHub PR #62 reviewed exact implementation head 73f5512970829956c20d5274a6deb94918153332 against base 346543eaf946d3583906b5f5d657e45fe961548a",
    "Rosuno implementation review PRR_kwDOUHT1sc8AAAABQhkCKw APPROVED at 2026-10-04T02:20:48Z on exact head 73f5512970829956c20d5274a6deb94918153332",
    "GitHub Actions P0 control foundation run #124 (37170346163) succeeded on implementation candidate 73f5512970829956c20d5274a6deb94918153332",
    "GitHub PR #62 merged through merge commit 541b079ff3905175dcd3d03d526dc40f66e95ada at 2026-10-04T02:24:55Z",
    "Implementation merge 541b079ff3905175dcd3d03d526dc40f66e95ada has ordered parents 346543eaf946d3583906b5f5d657e45fe961548a then 73f5512970829956c20d5274a6deb94918153332 and tree 3466f56af8dfade939740c993b5287289966909b",
    "GitHub Actions P0 control foundation post-implementation run #125 (37170979178) succeeded on canonical main 541b079ff3905175dcd3d03d526dc40f66e95ada",
    "At Gate 7 closure preflight, canonical apps/web/package.json declares next ^16.3.8, react ^19.3.0, and react-dom ^19.3.0; pnpm-lock.yaml resolves Next.js 16.3.8 with the validated implementation bytes",
    "Gate 5 N/A — repository-only Next.js security-patch work item; no migration or database candidate exists",
    "Gate 6 N/A — no persistent Staging application exists for the Next.js security-patch work item",
    "P2-004 remains separate and unchanged; this closure does not authorize P2-004 correction or implementation, additional dependency changes, application/configuration changes, provider/database/environment work, Staging, Production, OLD, P1-012, G-1 through G-5, F-01/F-02/F-03, or draft Arizona launch-strategy functionality",
  ];

  for (const evidence of lifecycleEvidence) {
    assert.ok(
      closure.evidence.includes(evidence),
      "missing closure lifecycle evidence: " + evidence,
    );
  }

  const item = workItems.work_items.find(
    (entry) => entry.work_item_id === WORK_ITEM_ID,
  );

  assert.ok(item);
  assert.equal(item.status, "completed");
  assert.equal(item.environment, "development");
  assert.deepEqual(item.release_refs, []);
  assert.deepEqual(item.migration_refs, []);
  assert.deepEqual(item.dependencies, ["WI-P2-001-APPLICATION-SHELL"]);
  assert.deepEqual(item.authority_refs, AUTHORITY_REFS);

  assert.ok(item.decision_refs.includes(DECISION_ID));
  assert.ok(item.decision_refs.includes(closureId));

  assert.match(item.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(Date.parse(item.updated_at) >= Date.parse(closure.updated_at));

  for (const evidence of lifecycleEvidence) {
    assert.ok(
      item.acceptance_criteria.includes(evidence),
      "missing work-item closure evidence: " + evidence,
    );
  }

  const boundary = [
    closure.scope,
    closure.decision,
    closure.rationale,
    closure.impact,
    ...closure.evidence,
    item.rollback_reference,
  ].join(" ");

  for (const phrase of [
    "P2-004",
    "provider/database/environment",
    "Staging",
    "Production",
    "OLD",
    "P1-012",
    "G-1 through G-5",
    "F-01/F-02/F-03",
    "Arizona launch-strategy",
    "No database rollback applies",
  ]) {
    assert.ok(boundary.includes(phrase), "missing closure boundary: " + phrase);
  }

  // Historical closure evidence is deliberately pinned above.
  // This test intentionally does not read apps/web/package.json or
  // pnpm-lock.yaml and therefore does not freeze future authorized
  // Next.js, React, React DOM, or other package state.
});
