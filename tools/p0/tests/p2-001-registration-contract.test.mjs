import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(new URL("../../../" + relativePath, import.meta.url), "utf8"),
  );
}

test("P2-001 registration preserves the bounded Application Shell contract", () => {
  const decisions = readJson("governance/decision-log.json");
  const workItems = readJson("governance/work-items/index.json");
  const schema = readJson("governance/work-items/schema.json");

  const decisionMatches = decisions.decisions.filter(
    (entry) =>
      entry.decision_id === "DEC-20260925-P2-001-APPLICATION-SHELL-CONTRACT",
  );
  assert.equal(decisionMatches.length, 1);

  const decision = decisionMatches[0];
  assert.equal(decision.status, "accepted");
  assert.deepEqual(decision.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });
  assert.equal(decision.created_at, "2026-09-25T03:23:31Z");
  assert.match(decision.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(
    Date.parse(decision.updated_at) > Date.parse("2026-09-25T03:50:30Z"),
  );

  for (const evidence of [
    "GitHub PR #41 reviewed exact head 20783253c6e1e4d2e95887a43850eb2924cf3514",
    "Rosuno review PRR_kwDOUHT1sc8AAAABPK7DKA APPROVED at 2026-09-25T03:46:57Z",
    "GitHub PR #41 merged as b99c9e198bff1a3f917fbd02d884917e5e76982b at 2026-09-25T03:50:30Z",
    "GitHub Actions P0 control foundation run #83 (36091994647) succeeded on b99c9e198bff1a3f917fbd02d884917e5e76982b",
  ]) {
    assert.ok(
      decision.evidence.includes(evidence),
      "missing protected lifecycle evidence: " + evidence,
    );
  }

  assert.deepEqual(decision.work_item_refs, ["WI-P2-001-APPLICATION-SHELL"]);

  const matches = workItems.work_items.filter(
    (entry) => entry.work_item_id === "WI-P2-001-APPLICATION-SHELL",
  );
  assert.equal(matches.length, 1);

  const item = matches[0];

  assert.equal(item.priority, "P2");
  assert.equal(item.status, "approved");
  assert.equal(item.environment, "development");
  assert.deepEqual(item.release_refs, []);
  assert.deepEqual(item.migration_refs, []);
  assert.deepEqual(item.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });
  assert.equal(item.created_at, "2026-09-25T03:23:31Z");
  assert.match(item.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(Date.parse(item.updated_at) > Date.parse(decision.updated_at));

  assert.deepEqual(item.decision_refs, [
    "DEC-20260924-P1-CLOSURE-P2-TRANSITION",
    "DEC-20260925-P2-001-APPLICATION-SHELL-CONTRACT",
    "DEC-20260926-P0-P2-APPLICATION-SURFACE-CONTROL-EXTENSION-CLOSURE",
  ]);

  assert.deepEqual(item.dependencies, [
    "WI-P1-011-COMPLIANCE-FOUNDATION",
    "WI-P0-P2-APPLICATION-SURFACE-CONTROL-EXTENSION",
  ]);

  const contract = [
    decision.scope,
    decision.decision,
    decision.rationale,
    decision.impact,
    item.objective,
    ...item.in_scope,
    ...item.out_of_scope,
    ...item.acceptance_criteria,
    item.rollback_reference,
  ].join(" ");

  for (const phrase of [
    "Next.js + React + TypeScript",
    "apps/web",
    "routing",
    "layout",
    "error",
    "loading",
    "form",
    "server-owned session",
    "API/service",
    "P2-002",
    "P2-003",
    "P3",
    "No database rollback applies",
  ]) {
    assert.ok(
      contract.includes(phrase),
      "missing P2-001 contract phrase: " + phrase,
    );
  }

  assert.match(
    decision.rationale,
    /implementation choice, not locked Rosuno authority/,
  );

  const p1012 = workItems.work_items.find(
    (entry) => entry.work_item_id === "WI-P1-012-PHYSICAL-1L",
  );
  assert.ok(p1012);
  assert.equal(p1012.status, "blocked");

  assert.deepEqual(schema.properties.priority.enum, ["P0", "P1", "P2"]);
  assert.ok(
    new RegExp(schema.properties.work_item_id.pattern).test(
      "WI-P2-001-APPLICATION-SHELL",
    ),
  );
  assert.equal(
    new RegExp(schema.properties.work_item_id.pattern).test(
      "WI-P3-001-UNAUTHORIZED",
    ),
    false,
  );
});

test("P0 P2 application-surface control prerequisite is durably closed", () => {
  const decisions = readJson("governance/decision-log.json");
  const workItems = readJson("governance/work-items/index.json");

  const closureId =
    "DEC-20260926-P0-P2-APPLICATION-SURFACE-CONTROL-EXTENSION-CLOSURE";
  const p0Id = "WI-P0-P2-APPLICATION-SURFACE-CONTROL-EXTENSION";

  const closureMatches = decisions.decisions.filter(
    (entry) => entry.decision_id === closureId,
  );
  assert.equal(closureMatches.length, 1);

  const closure = closureMatches[0];
  assert.equal(closure.status, "accepted");
  assert.deepEqual(closure.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });
  assert.match(closure.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(closure.updated_at, closure.created_at);
  assert.ok(
    Date.parse(closure.created_at) > Date.parse("2026-09-26T03:33:04Z"),
  );
  assert.deepEqual(closure.work_item_refs, [
    p0Id,
    "WI-P2-001-APPLICATION-SHELL",
  ]);

  for (const evidence of [
    "GitHub PR #43 reviewed exact head 0893ba05b8817b0dc0832746e7d14ddb18182e47 against base 766d7a8c1b230c62b4e4f58e7107c2267fce14ab",
    "Rosuno review 5324240135 (PRR_kwDOUHT1sc8AAAABPVl1Bw) APPROVED at 2026-09-26T02:39:19Z on exact head 0893ba05b8817b0dc0832746e7d14ddb18182e47",
    "GitHub Actions P0 control foundation run 36212219480 succeeded on 0893ba05b8817b0dc0832746e7d14ddb18182e47",
    "GitHub PR #43 merged as ecf5f500105e74f646108815db65c6844a29bc04 at 2026-09-26T03:33:04Z",
    "Merge ecf5f500105e74f646108815db65c6844a29bc04 has ordered parents 766d7a8c1b230c62b4e4f58e7107c2267fce14ab then 0893ba05b8817b0dc0832746e7d14ddb18182e47 and tree 8468166431d2cc013307cabe7ce3500552ae638a",
    "GitHub Actions P0 control foundation run 36215153054 succeeded on ecf5f500105e74f646108815db65c6844a29bc04",
    "Gate 5 N/A — repository-only P0 control work; no migration or database candidate exists",
    "Gate 6 N/A — no persistent Staging application exists for this repository-only P0 control work",
    "P2-001 implementation remains not started; F-01/F-02/F-03 remain separate",
  ]) {
    assert.ok(
      closure.evidence.includes(evidence),
      "missing P0 closure evidence: " + evidence,
    );
  }

  const p0Matches = workItems.work_items.filter(
    (entry) => entry.work_item_id === p0Id,
  );
  assert.equal(p0Matches.length, 1);

  const p0 = p0Matches[0];
  assert.equal(p0.priority, "P0");
  assert.equal(p0.status, "completed");
  assert.equal(p0.environment, "none");
  assert.deepEqual(p0.reviewer, {
    identity: "Rosuno",
    status: "approved",
  });
  assert.deepEqual(p0.decision_refs, [closureId]);
  assert.deepEqual(p0.dependencies, []);
  assert.deepEqual(p0.release_refs, []);
  assert.deepEqual(p0.migration_refs, []);
  assert.equal(p0.created_at, closure.created_at);
  assert.equal(p0.updated_at, closure.updated_at);

  const p2 = workItems.work_items.find(
    (entry) => entry.work_item_id === "WI-P2-001-APPLICATION-SHELL",
  );
  assert.ok(p2);
  assert.equal(p2.status, "approved");
  assert.deepEqual(p2.decision_refs, [
    "DEC-20260924-P1-CLOSURE-P2-TRANSITION",
    "DEC-20260925-P2-001-APPLICATION-SHELL-CONTRACT",
    closureId,
  ]);
  assert.deepEqual(p2.dependencies, ["WI-P1-011-COMPLIANCE-FOUNDATION", p0Id]);
  assert.equal(p2.updated_at, closure.updated_at);
});
