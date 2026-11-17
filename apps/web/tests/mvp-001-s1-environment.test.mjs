// MVP-001 S1 application tests (fixture-only): PS-A2 environment binding,
// the server-side environment configuration, the staff gating of persisted
// eligibility determinations on the bound environment, and the review-page
// visibility rule on discipline findings and determinations (D-6).
//
// Runs against the synthetic M4 world in m4-fixtures.mjs. No provider,
// network, or database is contacted; every value is synthetic.

import assert from "node:assert/strict";
import { test } from "node:test";

import { bindEnvironment } from "../src/application/environment-binding.ts";
import {
  recordDisciplineFinding,
  recordEligibilityDetermination,
  resolveStaffReview,
} from "../src/application/staff-verification.ts";
import { readEnvironmentConfiguration } from "../src/infrastructure/environment/environment-configuration.ts";
import {
  addAttorney,
  addEvidence,
  addGrant,
  addInsurance,
  addJurisdiction,
  addLicense,
  addPolicy,
  addStaff,
  createWorld,
  form,
  staffSources,
} from "./m4-fixtures.mjs";

const REF = "abcdefghijklmnopqrst";
const OTHER_REF = "tsrqponmlkjihgfedcba";

const row = (environment_class, project_ref) => ({
  environment_class,
  project_ref,
});
const config = (configuredClass, expectedProjectRef) => ({
  configuredClass,
  expectedProjectRef,
});

test("S1-ENV-1. the binding accepts only an exact match between the recorded identity and the configuration", () => {
  // Accepted.
  assert.equal(
    bindEnvironment([row("development", null)], config("development", null)),
    "development",
  );
  assert.equal(
    bindEnvironment([row("staging", REF)], config("staging", REF)),
    "staging",
  );
  assert.equal(
    bindEnvironment([row("production", REF)], config("production", REF)),
    "production",
  );
  // An unrecorded database is reported as such, whatever is configured.
  for (const configured of [
    config("development", null),
    config("production", REF),
    config(undefined, null),
  ]) {
    assert.equal(
      bindEnvironment([row("unrecorded", null)], configured),
      "unrecorded",
    );
  }
  // Every difference, omission, or malformed answer is a mismatch.
  const mismatches = [
    [null, config("development", null)],
    [[], config("development", null)],
    [
      [row("development", null), row("development", null)],
      config("development", null),
    ],
    [[row("staging", REF)], config("production", REF)],
    [[row("production", REF)], config("staging", REF)],
    [[row("production", REF)], config("production", OTHER_REF)],
    [[row("production", REF)], config("production", null)],
    [[row("staging", null)], config("staging", null)],
    [[row("development", null)], config("development", REF)],
    [[row("development", REF)], config("development", REF)],
    [[row("development", null)], config(undefined, null)],
    [[row("development", null)], config("", null)],
    [[row("development", null)], config("Development", null)],
    [
      [row("production", "ABCDEFGHIJKLMNOPQRST")],
      config("production", "ABCDEFGHIJKLMNOPQRST"),
    ],
    [[row("production", "short")], config("production", "short")],
    [[row("unrecorded", REF)], config("production", REF)],
    [[row("test", null)], config("test", null)],
    [[{ environment_class: "development" }], config("development", null)],
    [[{ ...row("development", null), extra: 1 }], config("development", null)],
    [["development"], config("development", null)],
  ];
  for (const [rows, configured] of mismatches) {
    assert.equal(
      bindEnvironment(rows, configured),
      "mismatch",
      JSON.stringify([rows, configured]),
    );
  }
});

test("S1-ENV-2. the configuration derives the project reference only from a hosted project origin and never defaults the class", () => {
  assert.deepEqual(
    readEnvironmentConfiguration({
      ROSUNO_ENVIRONMENT_CLASS: "staging",
      NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`,
    }),
    { configuredClass: "staging", expectedProjectRef: REF },
  );
  assert.equal(
    readEnvironmentConfiguration({
      ROSUNO_ENVIRONMENT_CLASS: "staging",
      NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co/`,
    }).expectedProjectRef,
    REF,
  );
  for (const url of [
    "http://127.0.0.1:54321",
    `http://${REF}.supabase.co`,
    `https://${REF}.supabase.co/rest/v1`,
    `https://${REF}.supabase.co.example.test`,
    `https://${REF}x.supabase.co`,
    "https://ABCDEFGHIJKLMNOPQRST.supabase.co",
    "",
    undefined,
  ]) {
    assert.equal(
      readEnvironmentConfiguration({
        ROSUNO_ENVIRONMENT_CLASS: "development",
        NEXT_PUBLIC_SUPABASE_URL: url,
      }).expectedProjectRef,
      null,
      String(url),
    );
  }
  const missing = readEnvironmentConfiguration({});
  assert.equal(missing.configuredClass, undefined);
  assert.ok(Object.isFrozen(missing));
});

function eligibleSetup() {
  const world = createWorld();
  const a = addJurisdiction(world, 1, "SYN_A");
  const b = addJurisdiction(world, 2, "SYN_B");
  const applicant = addAttorney(world, 10, "approved", {
    display_name: "Synthetic Applicant",
  });
  const license = addLicense(world, applicant.attorneyId, a, {
    reported_status: "synthetic-active",
  });
  addEvidence(world, "license", license);
  const insurance = addInsurance(world, applicant.attorneyId, a, {
    per_occurrence_limit_minor: 200000,
    currency_code: "XTS",
    coverage_from: "2026-01-01",
    coverage_until: "2026-12-31",
  });
  addEvidence(world, "insurance", insurance);
  addPolicy(world, a);
  const global = addStaff(world, 30);
  addGrant(world, global.userId);
  const scopedB = addStaff(world, 32);
  addGrant(world, scopedB.userId, { jurisdiction_id: b });
  return { world, a, b, applicant, global, scopedB };
}

const DETERMINATION = (s) =>
  form({
    attorney: s.applicant.attorneyId,
    jurisdiction_id: s.a,
    practice_area_id: "",
  });

test("S1-ENV-3. an unrecorded or mismatched environment shows assessments but never persists a determination", async () => {
  const cases = [
    [
      "unrecorded database",
      (s) => {
        s.world.deployment_environment = {
          environment_class: "unrecorded",
          project_ref: null,
        };
      },
      {},
    ],
    [
      "no identity row",
      (s) => {
        s.world.deployment_environment = null;
      },
      {},
    ],
    [
      "configured class differs",
      () => {},
      {
        environment: () => ({
          configuredClass: "production",
          expectedProjectRef: null,
        }),
      },
    ],
    [
      "class not configured",
      () => {},
      {
        environment: () => ({
          configuredClass: undefined,
          expectedProjectRef: null,
        }),
      },
    ],
    [
      "hosted URL for a development database",
      () => {},
      {
        environment: () => ({
          configuredClass: "development",
          expectedProjectRef: REF,
        }),
      },
    ],
  ];
  for (const [name, arrange, overrides] of cases) {
    const s = eligibleSetup();
    arrange(s);
    const sources = staffSources(s.world, s.global.authId, overrides);
    const view = await resolveStaffReview(sources, s.applicant.attorneyId);
    const entry = view.assessments.find((x) => x.jurisdictionId === s.a);
    assert.equal(entry.canRecord, false, name);
    assert.equal(entry.assessment.result, "undetermined", name);
    assert.deepEqual(
      await recordEligibilityDetermination(sources, DETERMINATION(s)),
      { status: "unavailable" },
      name,
    );
    assert.equal(s.world.eligibility_evaluations.length, 0, name);
    assert.equal(s.world.audit_events.length, 0, name);
  }
  // The matching development binding persists exactly one determination.
  const s = eligibleSetup();
  const sources = staffSources(s.world, s.global.authId);
  const view = await resolveStaffReview(sources, s.applicant.attorneyId);
  const entry = view.assessments.find((x) => x.jurisdictionId === s.a);
  assert.equal(entry.canRecord, true);
  assert.equal(entry.assessment.result, "eligible");
  assert.deepEqual(
    await recordEligibilityDetermination(sources, DETERMINATION(s)),
    { status: "recorded" },
  );
  assert.equal(s.world.eligibility_evaluations.length, 1);
});

test("S1-D6. discipline findings and determinations follow the review-page rule: an attorney the reviewer cannot review is denied, and nothing is written", async () => {
  const s = eligibleSetup();
  // The B-scoped reviewer sees no record of this attorney in B.
  const sources = staffSources(s.world, s.scopedB.authId);
  assert.deepEqual(await resolveStaffReview(sources, s.applicant.attorneyId), {
    status: "denied",
  });
  assert.deepEqual(
    await recordDisciplineFinding(
      sources,
      form({
        attorney: s.applicant.attorneyId,
        jurisdiction_id: s.b,
        external_reference: "SYN-REG-1",
        finding_type: "",
        opened_at: "",
        resolved_at: "",
        discipline_status: "synthetic-revoked",
        source_type: "synthetic register",
        source_reference: "synthetic entry",
        source_uri: "",
        retrieved_at: "2026-11-04T11:00",
        verification_method: "synthetic lookup",
        evidence_summary: "synthetic",
        evidence_digest: "",
        outcome: "consistent",
      }),
    ),
    { status: "denied" },
  );
  assert.deepEqual(
    await recordEligibilityDetermination(
      sources,
      form({
        attorney: s.applicant.attorneyId,
        jurisdiction_id: s.b,
        practice_area_id: "",
      }),
    ),
    { status: "denied" },
  );
  assert.equal(s.world.discipline_records.length, 0);
  assert.equal(s.world.eligibility_evaluations.length, 0);
  assert.equal(s.world.audit_events.length, 0);
  // Once the attorney has a record in B, the same reviewer may record both.
  addLicense(s.world, s.applicant.attorneyId, s.b);
  const view = await resolveStaffReview(sources, s.applicant.attorneyId);
  assert.notEqual(view.status, "denied");
});
