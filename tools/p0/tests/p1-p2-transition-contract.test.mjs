import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateRepository } from "../lib/controls.mjs";

// P2-903: the original thirteen migration and thirteen release records.
const HISTORICAL_MIGRATION_COUNT = 13;
const HISTORICAL_RELEASE_COUNT = 13;

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

function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortedKeys(value[key])]),
    );
  }
  return value;
}

// SHA-256 over the JSON of the first `count` records with object keys sorted
// recursively and array order kept.
function prefixSha256(records, count) {
  return createHash("sha256")
    .update(JSON.stringify(sortedKeys(records.slice(0, count))))
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
  assert.equal(decision.status, "accepted");
  assert.deepEqual(decision.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });
  assert.equal(decision.created_at, "2026-09-24T23:29:21Z");
  assert.match(decision.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(
    Date.parse(decision.updated_at) > Date.parse("2026-09-25T01:28:08Z"),
  );

  for (const evidence of [
    "GitHub PR #38 reviewed exact head 28a705f516b6cdf716dbdacb2198d2c969bd7ae1",
    "Rosuno review PRR_kwDOUHT1sc8AAAABPKIYcg APPROVED at 2026-09-25T01:25:15Z",
    "GitHub PR #38 merged as d827170dc4851b6a42419f8ecaafdd131b33ac45 at 2026-09-25T01:27:36Z",
    "GitHub Actions P0 control foundation run #77 (36082104358) succeeded on d827170dc4851b6a42419f8ecaafdd131b33ac45",
  ]) {
    assert.ok(
      decision.evidence.includes(evidence),
      "missing protected lifecycle evidence: " + evidence,
    );
  }
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
  assert.deepEqual(p1012.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });
  assert.equal(p1012.created_at, "2026-09-24T23:29:21Z");
  assert.equal(p1012.updated_at, decision.updated_at);
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

  // P2-903: historical-prefix proof without a fixed whole-register length. The
  // first thirteen records must match the digest computed once from canonical
  // base cddb59e19a6cc69d1f9c4ee590698509bbadbe98 with prefixSha256, and a
  // separately authorized appended migration never displaces the original
  // final historical record at index 12.
  assert.ok(migrations.migrations.length >= HISTORICAL_MIGRATION_COUNT);
  assert.equal(
    prefixSha256(migrations.migrations, HISTORICAL_MIGRATION_COUNT),
    "d6b2ffadbda9b5a63c5b09b7ef1b022f60c8ca607b495858e185c71f26cbe18c",
  );
  assert.equal(
    migrations.migrations[12].migration_id,
    "20260921051204_p1_compliance_foundation",
  );
  // Preserve the exact historical baseline check when no appended migration
  // exists; otherwise require the single independently accepted P2-007 suffix.
  if (baseline.migration_inventory.length === HISTORICAL_MIGRATION_COUNT) {
    assert.equal(baseline.baseline_id, "rosuno-staging-p1-011-20260923-v1");
    assert.equal(
      baseline.catalog_fingerprint.sha256,
      "edffaba2b7e081c3c8c78c158ce33a444a448671bf338188356d1118f0a9960a",
    );
    assert.equal(
      sha256("governance/schema-drift/baseline.json"),
      "196caee4de2c870652ce5b716a9b02c484c97181b1d9c59e5abbc5c2966b2d65",
    );
  } else {
    assert.equal(baseline.baseline_id, "rosuno-staging-p2-007-20261022-v1");
    assert.equal(baseline.migration_inventory.length, 14);
    assert.equal(
      sha256("governance/evidence/p1-011-governance-lifecycle-closure.json"),
      "7a95c0350f5be2836671513431f4c9c8982d60eb362d7561c12f3bc758e8ae73",
    );
    const p1011 = readJson(
      "governance/evidence/p1-011-governance-lifecycle-closure.json",
    );
    assert.deepEqual(
      baseline.migration_inventory
        .slice(0, HISTORICAL_MIGRATION_COUNT)
        .map((item) => item.migration_id),
      p1011.migration.history,
    );
    const originalManifest = {
      baseline_id: "rosuno-staging-p1-011-20260923-v1",
      checked_environment: "staging",
      project: { name: "Rosuno Staging", project_ref: "mxjlvmowmodzdtdfgqpb" },
      migration_inventory: baseline.migration_inventory.slice(
        0,
        HISTORICAL_MIGRATION_COUNT,
      ),
      accepted_evidence: baseline.accepted_evidence.slice(0, 11),
      catalog_fingerprint: {
        format: "rosuno-p1-catalog-v1",
        sha256:
          "edffaba2b7e081c3c8c78c158ce33a444a448671bf338188356d1118f0a9960a",
        canonical_byte_length: 640365,
        row_count: 1938,
      },
    };
    assert.equal(
      "sha256:" +
        createHash("sha256")
          .update(JSON.stringify(originalManifest))
          .digest("hex"),
      "sha256:c7fccca383d38712c74946c7beb4cf4beb1fec8889343ba45e8d7eb97db35677",
    );
    assert.equal(
      baseline.accepted_evidence[10].sha256,
      "7a95c0350f5be2836671513431f4c9c8982d60eb362d7561c12f3bc758e8ae73",
    );
    assert.equal(
      baseline.migration_inventory[13].migration_id,
      "20261020070000_p2_registration_abuse_control",
    );
    assert.equal(
      baseline.migration_inventory[13].sha256,
      "32649648b0d75763ba1003957d24febffc2050951ca49b962687c2427a5f4db5",
    );
    assert.equal(
      baseline.catalog_fingerprint.sha256,
      "0f823b1ce633d925183e1f1404f962f5b524744cf09b52acbadf0b1744032e9d",
    );
    assert.equal(baseline.catalog_fingerprint.canonical_byte_length, 658601);
    assert.equal(baseline.catalog_fingerprint.row_count, 1970);
  }
  assert.equal(
    releases.releases.some(
      (entry) =>
        entry.work_item_refs?.includes("WI-P1-012-PHYSICAL-1L") ||
        entry.decision_refs?.includes("DEC-20260924-P1-CLOSURE-P2-TRANSITION"),
    ),
    false,
  );

  // P2-903: a register with no appended suffix must still match its original
  // whole-file SHA-256. When either register has a suffix, both historical
  // record prefixes must match their pinned digests (the migration prefix is
  // asserted above in every state), and the suffix is tolerated only if the
  // full repository validation accepts it: a syntactically valid JSON append
  // is not approval.
  const migrationSuffix =
    migrations.migrations.length > HISTORICAL_MIGRATION_COUNT;
  const releaseSuffix = releases.releases.length > HISTORICAL_RELEASE_COUNT;
  if (!migrationSuffix) {
    assert.equal(
      sha256("governance/migrations/reviewed-migrations.json"),
      "fdc9733cef8c7a573c3113cd56ba0fe10fa3a8b621b45cad3a099a61d81addde",
    );
  }
  if (!releaseSuffix) {
    assert.equal(
      sha256("governance/releases/traceability.json"),
      "f3707b75fb027d26172cb7cb404428fa6e4e7d9980f04db1ea7ffbd7d8fd2691",
    );
  }
  if (migrationSuffix || releaseSuffix) {
    assert.equal(
      prefixSha256(releases.releases, HISTORICAL_RELEASE_COUNT),
      "4af80ee97c3eb5449cea03e95f3ebd9d5ddb305ffde2a89a973f929eedbc12ae",
    );
    assert.doesNotThrow(() => validateRepository());
  }
});
