import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(new URL("../../../" + relativePath, import.meta.url), "utf8"),
  );
}

const PREREQ_ID = "WI-P0-P3-IDENTITY-CONTROL-ALIGNMENT";
const DECISION_ID = "DEC-20261002-P0-P3-IDENTITY-CONTROL-ALIGNMENT-CONTRACT";
const CLOSURE_ID = "DEC-20261003-P0-P3-IDENTITY-CONTROL-ALIGNMENT-CLOSURE";

const REGISTRATION_ENVELOPE = [
  "governance/decision-log.json",
  "governance/work-items/index.json",
  "tools/p0/tests/p0-p3-identity-control-alignment-registration-contract.test.mjs",
];

const ALIGNMENT_ENVELOPE = [
  "tools/p0/lib/controls.mjs",
  "tools/p0/tests/p0-controls.test.mjs",
  "tools/p0/tests/p2-002-registration-contract.test.mjs",
  "tools/p0/tests/p2-003-registration-contract.test.mjs",
  "apps/web/tests/design-system.test.mjs",
  "apps/web/tests/application-shell.test.mjs",
];

const AUTHORITY_REFS = [
  "P0-001-LOCKED",
  "DOMAIN-MODEL-V1.4-LOCKED",
  "PHYSICAL-SUPABASE-POSTGRES-V1.0-LOCKED",
  "TECHNICAL-ARCHITECTURE-V0.2-LOCKED",
  "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED",
];

test("P0/P3 Identity Control Alignment registration is bounded", () => {
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
  assert.equal(item.priority, "P0");
  assert.equal(item.environment, "none");

  assert.deepEqual(decision.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });

  assert.deepEqual(item.reviewer, decision.reviewer);

  assert.deepEqual(decision.authority_refs, AUTHORITY_REFS);
  assert.deepEqual(item.authority_refs, AUTHORITY_REFS);
  assert.deepEqual(decision.work_item_refs, [PREREQ_ID]);
  assert.ok(item.decision_refs.includes(DECISION_ID));
  assert.deepEqual(item.dependencies, ["WI-P2-003-SECURITY-SHELL"]);

  assert.deepEqual(item.release_refs, []);
  assert.deepEqual(item.migration_refs, []);

  assert.equal(decision.created_at, decision.updated_at);
  assert.equal(item.created_at, decision.created_at);

  assert.match(item.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  const registrationFacts = [...decision.evidence, ...item.acceptance_criteria];

  for (const phrase of [
    "Current governance schema permits only P0/P1/P2 priorities",
    "Canonical governance contains no WI-P3-* work item at registration preflight",
    "governance/work-items/schema.json remains unchanged with P0/P1/P2 priorities only; no WI-P3-* application work item is created through registration",
    "Historical P2-001/P2-002/P2-003 closure evidence remains unchanged and all three work items remain completed",
    "P1-012 remains conditional/deferred and blocked",
  ]) {
    assert.ok(
      registrationFacts.some((entry) => entry.includes(phrase)),
      `missing historical registration fact: ${phrase}`,
    );
  }

  assert.ok(
    item.in_scope.some((entry) =>
      REGISTRATION_ENVELOPE.every((path) => entry.includes(path)),
    ),
  );

  assert.ok(
    item.in_scope.some((entry) =>
      ALIGNMENT_ENVELOPE.every((path) => entry.includes(path)),
    ),
  );

  for (const packageName of ["@supabase/supabase-js", "@supabase/ssr"]) {
    assert.ok(
      item.in_scope.some((entry) => entry.includes(packageName)),
      `missing bounded future dependency: ${packageName}`,
    );
  }

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
    "historical P2",
    "registry-semver",
    "fail-closed",
    "Security Shell",
    "design system",
    "application shell",
    "P0/P1/P2",
    "No database rollback applies",
  ]) {
    assert.ok(contract.includes(phrase), `missing contract phrase: ${phrase}`);
  }

  for (const phrase of [
    "package installation",
    "P3 application implementation",
    "Supabase Auth",
    "P1-012",
    "F-01",
    "F-02",
    "F-03",
    "Staging",
    "Production",
    "OLD",
    "Replit Agent",
    "Replit AI",
    "pull request",
    "merge",
  ]) {
    assert.ok(contract.includes(phrase), `missing exclusion: ${phrase}`);
  }

  assert.ok(
    item.validation_commands.includes(
      "node --test tools/p0/tests/p0-p3-identity-control-alignment-registration-contract.test.mjs",
    ),
  );

  assert.ok(item.validation_commands.includes("pnpm run p0:test"));
  assert.ok(item.validation_commands.includes("pnpm run secrets:check"));
  assert.ok(item.validation_commands.includes("pnpm run dependency:check"));
});

test("P0/P3 Identity Control Alignment lifecycle is durably closed", () => {
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

  assert.deepEqual(closure.authority_refs, AUTHORITY_REFS);

  assert.equal(closure.created_at, closure.updated_at);
  assert.match(closure.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(
    Date.parse(closure.created_at) > Date.parse("2026-10-03T07:15:13Z"),
  );

  for (const evidence of [
    "P0/P3 Identity Control Alignment candidate commit f04242b42683a08bad01d7e05810264fba0e113e has sole parent 50bf11103e1b5fcc0fb29d7f9a3da9361a20599a and tree 1268b59adf88a9f5d08a7dca58ccdb5a0f761b67",
    "Implementation scope was exactly 6 authorized paths: tools/p0/lib/controls.mjs; tools/p0/tests/p0-controls.test.mjs; tools/p0/tests/p2-002-registration-contract.test.mjs; tools/p0/tests/p2-003-registration-contract.test.mjs; apps/web/tests/design-system.test.mjs; apps/web/tests/application-shell.test.mjs",
    "GitHub PR #58 reviewed exact head f04242b42683a08bad01d7e05810264fba0e113e against base 50bf11103e1b5fcc0fb29d7f9a3da9361a20599a",
    "Rosuno review PRR_kwDOUHT1sc8AAAABQdW4Vg APPROVED at 2026-10-03T07:11:39Z on exact head f04242b42683a08bad01d7e05810264fba0e113e",
    "GitHub Actions P0 control foundation run #116 (37105144759) succeeded on f04242b42683a08bad01d7e05810264fba0e113e",
    "GitHub PR #58 merged as f2f22d716c46733cb5f9a18d60be2bd2eb3b3407 at 2026-10-03T07:14:27Z",
    "Merge f2f22d716c46733cb5f9a18d60be2bd2eb3b3407 has ordered parents 50bf11103e1b5fcc0fb29d7f9a3da9361a20599a then f04242b42683a08bad01d7e05810264fba0e113e and tree 1268b59adf88a9f5d08a7dca58ccdb5a0f761b67",
    "GitHub Actions P0 control foundation run #117 (37105691654) succeeded on canonical main f2f22d716c46733cb5f9a18d60be2bd2eb3b3407",
    "Gate 5 N/A — repository-only P0/P3 Identity Control Alignment prerequisite; no migration or database candidate exists",
    "Gate 6 N/A — no persistent Staging application exists for the P0/P3 Identity Control Alignment prerequisite",
  ]) {
    assert.ok(
      closure.evidence.includes(evidence),
      `missing closure evidence: ${evidence}`,
    );
  }

  const item = workItems.work_items.find(
    (entry) => entry.work_item_id === PREREQ_ID,
  );

  assert.ok(item);
  assert.equal(item.status, "completed");
  assert.equal(item.environment, "none");
  assert.deepEqual(item.release_refs, []);
  assert.deepEqual(item.migration_refs, []);

  assert.match(item.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(
    Date.parse(item.updated_at) >= Date.parse(closure.updated_at),
    "work-item updated_at must not predate the historical closure",
  );

  assert.ok(
    item.decision_refs.includes(DECISION_ID),
    "original contract decision reference must remain present",
  );
  assert.ok(
    item.decision_refs.includes(CLOSURE_ID),
    "closure decision reference must remain present",
  );

  assert.deepEqual(item.dependencies, ["WI-P2-003-SECURITY-SHELL"]);
  assert.deepEqual(item.authority_refs, AUTHORITY_REFS);

  for (const evidence of [
    "P0/P3 Identity Control Alignment candidate commit f04242b42683a08bad01d7e05810264fba0e113e has sole parent 50bf11103e1b5fcc0fb29d7f9a3da9361a20599a and tree 1268b59adf88a9f5d08a7dca58ccdb5a0f761b67",
    "Implementation scope was exactly 6 authorized paths: tools/p0/lib/controls.mjs; tools/p0/tests/p0-controls.test.mjs; tools/p0/tests/p2-002-registration-contract.test.mjs; tools/p0/tests/p2-003-registration-contract.test.mjs; apps/web/tests/design-system.test.mjs; apps/web/tests/application-shell.test.mjs",
    "PR #58 received designated Rosuno approval PRR_kwDOUHT1sc8AAAABQdW4Vg at 2026-10-03T07:11:39Z on exact candidate head f04242b42683a08bad01d7e05810264fba0e113e",
    "P0 control foundation run #116 (37105144759) succeeded on exact candidate head f04242b42683a08bad01d7e05810264fba0e113e",
    "PR #58 merged through merge commit f2f22d716c46733cb5f9a18d60be2bd2eb3b3407 at 2026-10-03T07:14:27Z",
    "Post-merge P0 control foundation run #117 (37105691654) succeeded on canonical main f2f22d716c46733cb5f9a18d60be2bd2eb3b3407",
    "Gate 5 is N/A because this repository-only prerequisite contains no migration or database candidate",
    "Gate 6 is N/A because this prerequisite contains no persistent Staging application",
  ]) {
    assert.ok(
      item.acceptance_criteria.includes(evidence),
      `missing work-item closure evidence: ${evidence}`,
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
    "P3 Identity & Authorization application implementation",
    "package installation",
    "credentials/secrets",
    "P1-012",
    "G-1 through G-5",
    "F-01/F-02/F-03",
    "database/provider/environment",
    "Staging",
    "Production",
    "OLD",
    "No database rollback applies",
  ]) {
    assert.ok(boundary.includes(phrase), `missing closure boundary: ${phrase}`);
  }
});
