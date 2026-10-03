import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(new URL("../../../" + relativePath, import.meta.url), "utf8"),
  );
}

const WORK_ITEM_ID = "WI-P2-004-AUTHENTICATION-SESSION-FOUNDATION";
const DECISION_ID =
  "DEC-20261003-P2-004-AUTHENTICATION-SESSION-FOUNDATION-CONTRACT";

const REGISTRATION_ENVELOPE = [
  "governance/decision-log.json",
  "governance/work-items/index.json",
  "tools/p0/tests/p2-004-authentication-session-foundation-registration-contract.test.mjs",
];

const IMPLEMENTATION_ENVELOPE = [
  "apps/web/package.json",
  "pnpm-lock.yaml",
  "apps/web/src/infrastructure/identity/supabase-server.ts",
  "apps/web/src/infrastructure/identity/server-session-source.ts",
  "apps/web/tests/authentication-session.test.mjs",
];

const AUTHORITY_REFS = [
  "DOMAIN-MODEL-V1.4-LOCKED",
  "RELATIONAL-OBJECT-SPEC-V1.0-LOCKED",
  "PHYSICAL-SUPABASE-POSTGRES-V1.0-LOCKED",
  "TECHNICAL-ARCHITECTURE-V0.2-LOCKED",
  "IMPLEMENTATION-MASTER-PLAN-V1.0-LOCKED",
];

const REQUIRED_DEPENDENCIES = [
  "WI-P0-P3-IDENTITY-CONTROL-ALIGNMENT",
  "WI-P2-003-SECURITY-SHELL",
];

const NEUTRALITY_STATES = [
  "Founding Attorney status",
  "regular-attorney status",
  "private-beta status",
  "launch cohort",
  "public visibility",
  "Live Now eligibility",
  "client/attorney/staff business context",
  "marketplace eligibility",
];

test("P2-004 Authentication Session Foundation registration remains bounded and transition-safe", () => {
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
  assert.equal(item.priority, "P2");
  assert.equal(item.environment, "development");

  assert.deepEqual(decision.authority_refs, AUTHORITY_REFS);
  assert.deepEqual(item.authority_refs, AUTHORITY_REFS);
  assert.deepEqual(decision.work_item_refs, [WORK_ITEM_ID]);

  assert.ok(item.decision_refs.includes(DECISION_ID));

  for (const dependency of REQUIRED_DEPENDENCIES) {
    assert.ok(
      item.dependencies.includes(dependency),
      `missing required dependency: ${dependency}`,
    );
  }

  assert.deepEqual(item.release_refs, []);
  assert.deepEqual(item.migration_refs, []);

  assert.equal(decision.created_at, decision.updated_at);
  assert.match(decision.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(item.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(item.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(Date.parse(item.updated_at) >= Date.parse(item.created_at));

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

  for (const packageName of ["@supabase/supabase-js", "@supabase/ssr"]) {
    assert.ok(
      contract.includes(packageName),
      `missing dependency boundary: ${packageName}`,
    );
  }

  for (const phrase of [
    "fresh read-only",
    "official provider/package",
    "ServerSessionSource",
    "opaque trusted",
    "fail",
    "cross-request",
    "No database rollback applies",
  ]) {
    assert.ok(contract.includes(phrase), `missing contract phrase: ${phrase}`);
  }

  for (const state of NEUTRALITY_STATES) {
    assert.ok(
      contract.includes(state),
      `missing authentication/session neutrality boundary: ${state}`,
    );
  }

  for (const phrase of [
    "provider authentication roles",
    "browser claims",
    "session authority",
    "authentication-derived authorization shortcuts",
    "draft Arizona launch strategy",
    "noncanonical",
    "unlocked",
    "Founding Attorney",
    "private-beta",
    "survey",
    "Arizona",
    "onboarding",
    "verification",
    "pricing",
    "availability",
    "Live Now",
    "marketplace",
    "launch",
    "P1-012",
    "F-01",
    "F-02",
    "F-03",
    "Production",
    "OLD",
    "Replit Agent",
    "Replit AI",
  ]) {
    assert.ok(
      contract.includes(phrase),
      `missing exclusion/boundary: ${phrase}`,
    );
  }

  for (const id of [
    "WI-P0-P3-IDENTITY-CONTROL-ALIGNMENT",
    "WI-P2-003-SECURITY-SHELL",
  ]) {
    const existing = workItems.work_items.find(
      (entry) => entry.work_item_id === id,
    );
    assert.ok(existing, `missing prerequisite: ${id}`);
    assert.equal(existing.status, "completed", id);
  }

  assert.ok(
    item.validation_commands.includes(
      "node --test tools/p0/tests/p2-004-authentication-session-foundation-registration-contract.test.mjs",
    ),
  );
  assert.ok(item.validation_commands.includes("pnpm run p0:test"));
  assert.ok(item.validation_commands.includes("pnpm run secrets:check"));
  assert.ok(item.validation_commands.includes("pnpm run dependency:check"));

  // Intentionally no assertion freezes:
  // - P2-004 rolling status;
  // - exact future decision_refs;
  // - exact future dependency array shape beyond required prerequisites;
  // - global governance priority/schema evolution;
  // - future authorized apps/web package or source state.
});
