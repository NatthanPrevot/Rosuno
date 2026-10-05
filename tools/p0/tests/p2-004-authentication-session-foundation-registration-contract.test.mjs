import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

const CORRECTION_DECISION_ID =
  "DEC-20261004-P2-004-AUTHENTICATION-SESSION-FOUNDATION-CONTRACT-CORRECTION";
const SECURITY_PATCH_WORK_ITEM_ID =
  "WI-P0-NEXTJS-SEPTEMBER-2026-SECURITY-PATCH";
const ORIGINAL_DECISION_JSON_SHA256 =
  "91eab52b4a0728af0bd5a63a9f2b5455b230b5458ada0556129531c75d76b41e";

const CORRECTED_IMPLEMENTATION_ENVELOPE = [
  "apps/web/package.json",
  "pnpm-lock.yaml",
  "apps/web/proxy.ts",
  "apps/web/src/infrastructure/identity/supabase-server.ts",
  "apps/web/src/infrastructure/identity/server-session-source.ts",
  "apps/web/tests/authentication-session.test.mjs",
];

test("P2-004 forward-only provider contract correction preserves history and enforces the corrected boundary", () => {
  const decisions = readJson("governance/decision-log.json");
  const workItems = readJson("governance/work-items/index.json");

  const originalDecision = decisions.decisions.find(
    (entry) => entry.decision_id === DECISION_ID,
  );

  const correctionMatches = decisions.decisions.filter(
    (entry) => entry.decision_id === CORRECTION_DECISION_ID,
  );

  const item = workItems.work_items.find(
    (entry) => entry.work_item_id === WORK_ITEM_ID,
  );

  const securityPatch = workItems.work_items.find(
    (entry) => entry.work_item_id === SECURITY_PATCH_WORK_ITEM_ID,
  );

  assert.ok(originalDecision);
  assert.equal(correctionMatches.length, 1);
  assert.ok(item);
  assert.ok(securityPatch);

  const originalDecisionHash = createHash("sha256")
    .update(JSON.stringify(originalDecision))
    .digest("hex");

  assert.equal(originalDecisionHash, ORIGINAL_DECISION_JSON_SHA256);
  assert.equal(originalDecision.status, "accepted");
  assert.ok(!originalDecision.decision.includes("apps/web/proxy.ts"));

  const correction = correctionMatches[0];

  assert.equal(correction.status, "accepted");
  assert.deepEqual(correction.supersedes, []);
  assert.deepEqual(correction.work_item_refs, [WORK_ITEM_ID]);
  assert.deepEqual(correction.authority_refs, AUTHORITY_REFS);

  assert.ok(item.decision_refs.includes(DECISION_ID));
  assert.ok(item.decision_refs.includes(CORRECTION_DECISION_ID));
  assert.ok(item.dependencies.includes(SECURITY_PATCH_WORK_ITEM_ID));
  assert.equal(securityPatch.status, "completed");

  const envelopePrefix =
    "Corrected later application implementation surface limited to exactly: ";

  const envelopeEntries = item.in_scope.filter((entry) =>
    entry.startsWith(envelopePrefix),
  );

  assert.equal(envelopeEntries.length, 1);

  assert.deepEqual(
    envelopeEntries[0].slice(envelopePrefix.length).split("; "),
    CORRECTED_IMPLEMENTATION_ENVELOPE,
  );

  assert.ok(
    !item.acceptance_criteria.some((entry) =>
      entry.includes("implementation envelope is exactly five paths"),
    ),
  );

  const correctedContract = [
    correction.scope,
    correction.decision,
    correction.rationale,
    correction.impact,
    ...correction.evidence,
    item.objective,
    ...item.in_scope,
    ...item.out_of_scope,
    ...item.acceptance_criteria,
    item.rollback_reference,
  ].join(" ");

  for (const phrase of [
    "@supabase/supabase-js ^2.117.2",
    "@supabase/ssr ^0.12.7",
    "createServerClient",
    "getAll/setAll",
    "getClaims()",
    "claims.sub",
    "getSession() must not establish trusted identity",
    "request-cookie propagation",
    "response-cookie propagation",
    "cache-control",
    "expires",
    "pragma",
    "P2-003 Security Shell remains the owner of authorization",
    "opaque",
    "fail",
    "cross-request",
    "zero-live-network",
    "business-state",
    "Gate 5 N/A",
    "Gate 6 N/A",
  ]) {
    assert.ok(
      correctedContract.includes(phrase),
      "missing corrected contract phrase: " + phrase,
    );
  }

  for (const prohibitedProxyUse of [
    "redirects",
    "route authorization",
    "capability authorization",
    "Rosuno business authorization",
  ]) {
    assert.ok(
      correctedContract.includes(prohibitedProxyUse),
      "missing Proxy prohibition: " + prohibitedProxyUse,
    );
  }

  assert.ok(
    item.out_of_scope.some((entry) =>
      entry.includes("any second Proxy/helper file"),
    ),
  );

  assert.ok(
    item.validation_commands.includes(
      "node --test tools/p0/tests/p0-nextjs-september-2026-security-patch-registration-contract.test.mjs",
    ),
  );

  assert.deepEqual(item.release_refs, []);
  assert.deepEqual(item.migration_refs, []);

  // Intentionally does not freeze:
  // - future rolling P2-004 status;
  // - future additive decision references;
  // - future additive prerequisites;
  // - future package versions after separately authorized reconciliation;
  // - future governance schema evolution.
});

const CLOSURE_ID =
  "DEC-20261005-P2-004-AUTHENTICATION-SESSION-FOUNDATION-CLOSURE";
const CORRECTION_DECISION_JSON_SHA256_AT_CLOSURE =
  "06d4b8b1eb8818edf7dfe9a58d8aac0ff916dbb238644f90f187d95a2a177b7b";

test("P2-004 implementation lifecycle is durably closed", () => {
  const decisions = readJson("governance/decision-log.json");
  const workItems = readJson("governance/work-items/index.json");

  const original = decisions.decisions.find(
    (entry) => entry.decision_id === DECISION_ID,
  );

  const correction = decisions.decisions.find(
    (entry) => entry.decision_id === CORRECTION_DECISION_ID,
  );

  const closureMatches = decisions.decisions.filter(
    (entry) => entry.decision_id === CLOSURE_ID,
  );

  assert.ok(original);
  assert.ok(correction);
  assert.equal(closureMatches.length, 1);

  assert.equal(original.status, "accepted");
  assert.equal(correction.status, "accepted");

  const originalHash = createHash("sha256")
    .update(JSON.stringify(original))
    .digest("hex");

  const correctionHash = createHash("sha256")
    .update(JSON.stringify(correction))
    .digest("hex");

  assert.equal(originalHash, ORIGINAL_DECISION_JSON_SHA256);

  assert.equal(correctionHash, CORRECTION_DECISION_JSON_SHA256_AT_CLOSURE);

  const closure = closureMatches[0];

  assert.equal(closure.status, "accepted");
  assert.deepEqual(closure.work_item_refs, [WORK_ITEM_ID]);

  assert.deepEqual(closure.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });

  assert.deepEqual(closure.authority_refs, AUTHORITY_REFS);

  assert.deepEqual(closure.supersedes, []);

  assert.equal(closure.created_at, closure.updated_at);

  assert.match(closure.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  assert.ok(
    Date.parse(closure.created_at) > Date.parse("2026-10-05T05:44:29Z"),
  );

  for (const evidence of [
    "Retrospective governance closure record for WI-P2-004-AUTHENTICATION-SESSION-FOUNDATION; canonical closure is created only after the corrected application implementation completed its protected repository lifecycle",
    "Original accepted DEC-20261003-P2-004-AUTHENTICATION-SESSION-FOUNDATION-CONTRACT remains preserved as historical evidence",
    "Forward-only accepted DEC-20261004-P2-004-AUTHENTICATION-SESSION-FOUNDATION-CONTRACT-CORRECTION remains preserved as historical evidence",
    "P2-004 implementation candidate 3501144892bdbae966f2651cfeedcd8301ce848b has sole parent 6da8d5ef5d8a3527e97c2819dda56279b481f80f and tree 3d972965945a378948344bf5273769460f17e79d",
    "Implementation scope was exactly 6 authorized paths: apps/web/package.json; pnpm-lock.yaml; apps/web/proxy.ts; apps/web/src/infrastructure/identity/supabase-server.ts; apps/web/src/infrastructure/identity/server-session-source.ts; apps/web/tests/authentication-session.test.mjs",
    "GitHub PR #65 reviewed exact head 3501144892bdbae966f2651cfeedcd8301ce848b against base 6da8d5ef5d8a3527e97c2819dda56279b481f80f",
    "Rosuno review 5410215796 (PRR_kwDOUHT1sc8AAAABQnlXdA) APPROVED at 2026-10-05T05:12:30Z on exact head 3501144892bdbae966f2651cfeedcd8301ce848b",
    "GitHub Actions P0 control foundation run #130 (37266082114) succeeded on 3501144892bdbae966f2651cfeedcd8301ce848b",
    "GitHub PR #65 merged as 54e03938d15e14f3b4c45f46d874d9fd12c21ef0 at 2026-10-05T05:44:29Z",
    "Merge 54e03938d15e14f3b4c45f46d874d9fd12c21ef0 has ordered parents 6da8d5ef5d8a3527e97c2819dda56279b481f80f then 3501144892bdbae966f2651cfeedcd8301ce848b and tree 3d972965945a378948344bf5273769460f17e79d",
    "GitHub Actions P0 control foundation post-merge run #131 (37269121649) succeeded on canonical main 54e03938d15e14f3b4c45f46d874d9fd12c21ef0",
    "Gate 5 N/A — repository-only P2-004 Authentication Session Foundation work; no migration or database candidate exists",
    "Gate 6 N/A — no persistent Staging application exists for P2-004",
    "Gate 7 closure candidate surface is exactly 3 authorized paths: governance/decision-log.json; governance/work-items/index.json; tools/p0/tests/p2-004-authentication-session-foundation-registration-contract.test.mjs",
    "No application/package/provider/database/environment/Arizona-launch changes are authorized by this closure; later authentication/account/profile/capability/business-state work remains separate",
  ]) {
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

  assert.equal(item.updated_at, closure.updated_at);

  assert.deepEqual(item.decision_refs, [
    DECISION_ID,
    CORRECTION_DECISION_ID,
    CLOSURE_ID,
  ]);

  assert.deepEqual(item.authority_refs, closure.authority_refs);

  assert.deepEqual(item.dependencies, [
    "WI-P0-P3-IDENTITY-CONTROL-ALIGNMENT",
    "WI-P2-003-SECURITY-SHELL",
    "WI-P0-NEXTJS-SEPTEMBER-2026-SECURITY-PATCH",
  ]);

  const correctedEnvelopePrefix =
    "Corrected later application implementation surface limited to exactly: ";

  const correctedEnvelopeEntries = item.in_scope.filter((entry) =>
    entry.startsWith(correctedEnvelopePrefix),
  );

  assert.equal(correctedEnvelopeEntries.length, 1);

  assert.deepEqual(
    correctedEnvelopeEntries[0]
      .slice(correctedEnvelopePrefix.length)
      .split("; "),
    CORRECTED_IMPLEMENTATION_ENVELOPE,
  );

  for (const criterion of [
    "P2-004 implementation candidate 3501144892bdbae966f2651cfeedcd8301ce848b has sole parent 6da8d5ef5d8a3527e97c2819dda56279b481f80f and tree 3d972965945a378948344bf5273769460f17e79d",
    "Implementation scope was exactly 6 authorized paths: apps/web/package.json; pnpm-lock.yaml; apps/web/proxy.ts; apps/web/src/infrastructure/identity/supabase-server.ts; apps/web/src/infrastructure/identity/server-session-source.ts; apps/web/tests/authentication-session.test.mjs",
    "GitHub PR #65 received designated Rosuno approval review 5410215796 (PRR_kwDOUHT1sc8AAAABQnlXdA) at 2026-10-05T05:12:30Z on exact candidate head 3501144892bdbae966f2651cfeedcd8301ce848b",
    "P0 control foundation run #130 (37266082114) succeeded on exact candidate head 3501144892bdbae966f2651cfeedcd8301ce848b",
    "PR #65 merged through merge commit 54e03938d15e14f3b4c45f46d874d9fd12c21ef0 at 2026-10-05T05:44:29Z",
    "Merge 54e03938d15e14f3b4c45f46d874d9fd12c21ef0 has ordered parents 6da8d5ef5d8a3527e97c2819dda56279b481f80f then 3501144892bdbae966f2651cfeedcd8301ce848b and tree 3d972965945a378948344bf5273769460f17e79d",
    "Post-merge P0 control foundation run #131 (37269121649) succeeded on canonical main 54e03938d15e14f3b4c45f46d874d9fd12c21ef0",
    "Gate 5 is N/A because P2-004 contains no migration or database candidate",
    "Gate 6 is N/A because P2-004 contains no persistent Staging application",
    "Gate 7 closure candidate surface is exactly 3 authorized paths: governance/decision-log.json; governance/work-items/index.json; tools/p0/tests/p2-004-authentication-session-foundation-registration-contract.test.mjs",
    "DEC-20261003-P2-004-AUTHENTICATION-SESSION-FOUNDATION-CONTRACT and DEC-20261004-P2-004-AUTHENTICATION-SESSION-FOUNDATION-CONTRACT-CORRECTION remain accepted and preserved as historical evidence",
    "No application/package/provider/database/environment/Arizona-launch mutation occurs through this Gate 7 closure; later authentication/account/profile/capability/business-state work remains separate",
  ]) {
    assert.ok(
      item.acceptance_criteria.includes(criterion),
      "missing work-item closure criterion: " + criterion,
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
    "Gate 1",
    "Gate 2A",
    "Gate 2B",
    "Gate 3",
    "Gate 4",
    "Gate 5",
    "Gate 6",
    "application",
    "package",
    "provider",
    "database",
    "environment",
    "Arizona",
    "Staging",
    "Production",
    "OLD",
    "P1-012",
    "F-01",
    "F-02",
    "F-03",
    "No database rollback applies",
  ]) {
    assert.ok(boundary.includes(phrase), "missing closure boundary: " + phrase);
  }
});
