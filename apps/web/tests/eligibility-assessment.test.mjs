// P3-003 eligibility and policy-selection tests (fixture-only).
//
// The pure policy selector and eligibility composer run against synthetic,
// in-memory records shaped exactly like the selected database rows. No
// provider, network, or database is contacted, and every value is synthetic
// test data; the synthetic policy below is a test fixture, not a policy.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assessEligibility,
  evaluationRowOf,
} from "../src/application/eligibility-assessment.ts";
import {
  ELIGIBILITY_POLICY_TYPE,
  selectEligibilityPolicy,
} from "../src/application/policy-selection.ts";
import {
  DISCIPLINE_COLUMNS,
  EVIDENCE_COLUMNS,
  EVIDENCE_SUBJECT_COLUMNS,
  INSURANCE_COLUMNS,
  LICENSE_COLUMNS,
  PRACTICE_AUTHORISATION_COLUMNS,
  PROFILE_COLUMNS,
} from "../src/application/professional-records.ts";
import {
  AUTHORITY_REFERENCE_COLUMNS,
  POLICY_VERSION_COLUMNS,
} from "../src/application/policy-selection.ts";
import {
  addAttorney,
  addAuthorisation,
  addEvidence,
  addInsurance,
  addJurisdiction,
  addLicense,
  addPolicy,
  addPracticeArea,
  createWorld,
  idOf,
  pick,
  stamp,
} from "./m4-fixtures.mjs";

const DAY = 86_400_000;

// A synthetic world with one approved attorney who meets every factor of the
// synthetic policy in jurisdiction A.
function eligibleWorld() {
  const world = createWorld();
  const a = addJurisdiction(world, 1, "SYN_A");
  const b = addJurisdiction(world, 2, "SYN_B");
  const area = addPracticeArea(world, 1);
  const attorney = addAttorney(world, 10, "approved");
  const license = addLicense(world, attorney.attorneyId, a, {
    reported_status: "synthetic-active",
    effective_from: "2020-01-01",
  });
  addEvidence(world, "license", license);
  const insurance = addInsurance(world, attorney.attorneyId, a, {
    per_occurrence_limit_minor: 200000,
    currency_code: "XTS",
    coverage_from: "2026-01-01",
    coverage_until: "2026-12-31",
  });
  addEvidence(world, "insurance", insurance);
  const authorisation = addAuthorisation(world, attorney.attorneyId, a, area, {
    status: "authorised",
    decided_at: stamp(world.now - 2 * DAY),
    effective_from: stamp(world.now - DAY),
  });
  const policy = addPolicy(world, a);
  return {
    world,
    a,
    b,
    area,
    attorney,
    license,
    insurance,
    authorisation,
    policy,
  };
}

// The facts a trusted read would hand in for one attorney and jurisdiction.
function factsOf(world, attorneyId, jurisdictionId, practiceAreaId = null) {
  const profile = world.attorney_profiles.find((p) => p.id === attorneyId);
  const user = world.users.find((u) => u.id === profile.user_id);
  const mine = (table, columns) =>
    world[table]
      .filter(
        (r) =>
          r.attorney_id === attorneyId && r.jurisdiction_id === jurisdictionId,
      )
      .map((r) => pick(r, columns));
  const licenses = mine("licenses", LICENSE_COLUMNS);
  const insurance = mine("insurance_records", INSURANCE_COLUMNS);
  const discipline = mine("discipline_records", DISCIPLINE_COLUMNS);
  const authorisations = mine(
    "practice_area_authorisations",
    PRACTICE_AUTHORISATION_COLUMNS,
  );
  const ids = new Set(
    [...licenses, ...insurance, ...discipline, ...authorisations].map(
      (r) => r.id,
    ),
  );
  const subjects = world.verification_evidence_subjects
    .filter(
      (s) =>
        ids.has(s.license_id) ||
        ids.has(s.insurance_record_id) ||
        ids.has(s.discipline_record_id) ||
        ids.has(s.practice_area_authorisation_id),
    )
    .map((s) => pick(s, EVIDENCE_SUBJECT_COLUMNS));
  const evidenceIds = new Set(subjects.map((s) => s.verification_evidence_id));
  const versions = world.policy_versions
    .filter(
      (v) =>
        v.policy_type_code === ELIGIBILITY_POLICY_TYPE &&
        v.jurisdiction_id === jurisdictionId,
    )
    .map((v) => pick(v, POLICY_VERSION_COLUMNS));
  const versionIds = new Set(versions.map((v) => v.id));
  return {
    attorneyId,
    jurisdictionId,
    practiceAreaId,
    accountState: user.account_state,
    profile: pick(profile, PROFILE_COLUMNS),
    licenses,
    insurance,
    discipline,
    authorisations,
    evidence: world.verification_evidence
      .filter((e) => evidenceIds.has(e.id))
      .map((e) => pick(e, EVIDENCE_COLUMNS)),
    subjects,
    policyVersions: versions,
    authorityReferences: world.policy_authority_references
      .filter((r) => versionIds.has(r.policy_version_id))
      .map((r) => pick(r, AUTHORITY_REFERENCE_COLUMNS)),
  };
}

function factor(assessment, name) {
  return assessment.factors.find((entry) => entry.factor === name);
}

test("M4-E1. a fully supported synthetic attorney is eligible only under a selected approved policy, with explainable references", () => {
  const s = eligibleWorld();
  const result = assessEligibility(
    factsOf(s.world, s.attorney.attorneyId, s.a),
    s.world.now,
  );
  assert.equal(result.result, "eligible");
  assert.deepEqual(
    result.factors.map((f) => [f.factor, f.outcome]),
    [
      ["account", "pass"],
      ["profile", "pass"],
      ["policy", "pass"],
      ["license", "pass"],
      ["insurance", "pass"],
      ["discipline", "pass"],
      ["practice_area", "not_applicable"],
    ],
  );
  assert.equal(
    factor(result, "discipline").reason,
    "no_disqualifying_record_on_file",
  );
  assert.deepEqual(result.policyReferences, [
    {
      policy_version_id: s.policy,
      version_label: "synthetic-v1",
      policy_type_code: "attorney_eligibility",
    },
  ]);
  assert.equal(result.references.evidence_ids.length, 2);
  assert.deepEqual(result.references.license_ids, [s.license.id]);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.factors));
  // The practice-area context needs a current authorisation.
  const area = assessEligibility(
    factsOf(s.world, s.attorney.attorneyId, s.a, s.area),
    s.world.now,
  );
  assert.equal(area.result, "eligible");
  assert.equal(factor(area, "practice_area").reason, "authorisation_current");
});

test("M4-E2. no applicable policy, or any policy that is not exactly one approved, active, effective, verified, mode-neutral version, holds the result undetermined", () => {
  const cases = {
    "no policy at all": (w) => w.policy_versions.splice(0),
    draft: (w) =>
      Object.assign(w.policy_versions[0], {
        status: "draft",
        approved_at: null,
        approved_by_user_id: null,
      }),
    "counsel review": (w) =>
      Object.assign(w.policy_versions[0], {
        status: "counsel_review",
        approved_at: null,
        approved_by_user_id: null,
      }),
    "approved but not active": (w) =>
      Object.assign(w.policy_versions[0], { status: "approved" }),
    scheduled: (w) =>
      Object.assign(w.policy_versions[0], { status: "scheduled" }),
    suspended: (w) =>
      Object.assign(w.policy_versions[0], { status: "suspended" }),
    retired: (w) => Object.assign(w.policy_versions[0], { status: "retired" }),
    "not yet effective": (w) =>
      Object.assign(w.policy_versions[0], {
        effective_from: stamp(w.now + DAY),
      }),
    expired: (w) =>
      Object.assign(w.policy_versions[0], {
        effective_until: stamp(w.now - DAY),
      }),
    "no verified authority": (w) =>
      Object.assign(w.policy_authority_references[0], {
        verification_status: "pending",
        verified_by_user_id: null,
      }),
    "malformed parameters": (w) =>
      Object.assign(w.policy_versions[0], { parameters: { schema: "other" } }),
    "extra parameter": (w) =>
      Object.assign(w.policy_versions[0], {
        parameters: { ...w.policy_versions[0].parameters, extra: true },
      }),
    "missing parameter": (w) => {
      const { insurance, ...rest } = w.policy_versions[0].parameters;
      void insurance;
      w.policy_versions[0].parameters = rest;
    },
  };
  const expected = {
    "no policy at all": "no_applicable_policy",
    draft: "no_applicable_policy",
    "counsel review": "no_applicable_policy",
    "approved but not active": "no_applicable_policy",
    scheduled: "no_applicable_policy",
    suspended: "no_applicable_policy",
    retired: "no_applicable_policy",
    "not yet effective": "no_applicable_policy",
    expired: "no_applicable_policy",
    "no verified authority": "authority_unverified",
    "malformed parameters": "policy_parameters_unreadable",
    "extra parameter": "policy_parameters_unreadable",
    "missing parameter": "policy_parameters_unreadable",
  };
  for (const [name, change] of Object.entries(cases)) {
    const s = eligibleWorld();
    change(s.world);
    const result = assessEligibility(
      factsOf(s.world, s.attorney.attorneyId, s.a),
      s.world.now,
    );
    assert.equal(result.result, "undetermined", name);
    assert.deepEqual(
      [factor(result, "policy").outcome, factor(result, "policy").reason],
      ["undetermined", expected[name]],
      name,
    );
    for (const name2 of ["license", "insurance", "discipline"]) {
      assert.equal(
        factor(result, name2).reason,
        "policy_undetermined",
        `${name}/${name2}`,
      );
    }
    assert.deepEqual(result.policyReferences, [], name);
  }
});

test("M4-E3. conflicting versions, mode-specific versions, another jurisdiction's policy, and unreadable policy reads never select a policy", () => {
  const conflict = eligibleWorld();
  addPolicy(conflict.world, conflict.a, { version_label: "synthetic-v2" });
  assert.equal(
    factor(
      assessEligibility(
        factsOf(conflict.world, conflict.attorney.attorneyId, conflict.a),
        conflict.world.now,
      ),
      "policy",
    ).reason,
    "conflicting_policies",
  );
  const mode = eligibleWorld();
  mode.world.policy_versions[0].regulatory_mode_id = idOf(7, 1);
  assert.equal(
    factor(
      assessEligibility(
        factsOf(mode.world, mode.attorney.attorneyId, mode.a),
        mode.world.now,
      ),
      "policy",
    ).reason,
    "regulatory_mode_undetermined",
  );
  // A policy for jurisdiction A never applies in B, and no hard-coded rule
  // or other jurisdiction fills the gap.
  const other = eligibleWorld();
  addLicense(other.world, other.attorney.attorneyId, other.b, {
    reported_status: "synthetic-active",
  });
  const inB = assessEligibility(
    factsOf(other.world, other.attorney.attorneyId, other.b),
    other.world.now,
  );
  assert.equal(inB.result, "undetermined");
  assert.equal(factor(inB, "policy").reason, "no_applicable_policy");
  // A row of another type or jurisdiction handed in is unreadable input.
  const s = eligibleWorld();
  const facts = factsOf(s.world, s.attorney.attorneyId, s.a);
  const foreign = { ...facts.policyVersions[0], jurisdiction_id: s.b };
  assert.equal(
    selectEligibilityPolicy(
      s.a,
      s.world.now,
      [foreign],
      facts.authorityReferences,
    ).reason,
    "policy_records_unreadable",
  );
  assert.equal(
    selectEligibilityPolicy(s.a, s.world.now, null, []).reason,
    "policy_records_unreadable",
  );
  assert.equal(
    selectEligibilityPolicy(s.a, s.world.now, [], null).reason,
    "policy_records_unreadable",
  );
});

test("M4-E4. account and profile constraints: approved profile alone is never eligibility, and inactive or unapproved states are not eligible", () => {
  for (const [state, reason] of [
    ["applicant", "profile_not_approved"],
    ["under_review", "profile_not_approved"],
    ["suspended", "profile_suspended_or_removed"],
    ["removed", "profile_suspended_or_removed"],
  ]) {
    const s = eligibleWorld();
    s.world.attorney_profiles[0].profile_state = state;
    const result = assessEligibility(
      factsOf(s.world, s.attorney.attorneyId, s.a),
      s.world.now,
    );
    assert.equal(result.result, "not_eligible", state);
    assert.equal(factor(result, "profile").reason, reason, state);
  }
  for (const state of ["suspended", "closed", "pending_verification"]) {
    const s = eligibleWorld();
    s.world.users[0].account_state = state;
    const result = assessEligibility(
      factsOf(s.world, s.attorney.attorneyId, s.a),
      s.world.now,
    );
    assert.equal(result.result, "not_eligible", state);
    assert.equal(factor(result, "account").reason, "account_not_active", state);
  }
  // No phantom eligibility: an approved profile with no evidence, no
  // policy, and no records is undetermined, never eligible.
  const bare = createWorld();
  const j = addJurisdiction(bare, 1, "SYN_A");
  const attorney = addAttorney(bare, 10, "approved");
  const result = assessEligibility(
    factsOf(bare, attorney.attorneyId, j),
    bare.now,
  );
  assert.equal(result.result, "undetermined");
  assert.equal(factor(result, "policy").reason, "no_applicable_policy");
});

test("M4-E5. license facts: missing jurisdiction, no evidence, stale or future evidence, discrepancy, unobserved or non-qualifying status, and expiry", () => {
  const variants = {
    "no license in jurisdiction": [
      (s) => s.world.licenses.splice(0),
      "fail",
      "no_license_in_jurisdiction",
    ],
    "no evidence": [
      (s) => s.world.verification_evidence_subjects.splice(0, 1),
      "undetermined",
      "no_evidence",
    ],
    "stale evidence": [
      (s) =>
        Object.assign(s.world.verification_evidence[0], {
          retrieved_at: stamp(s.world.now - 400 * DAY),
        }),
      "undetermined",
      "evidence_stale",
    ],
    "future evidence": [
      (s) =>
        Object.assign(s.world.verification_evidence[0], {
          retrieved_at: stamp(s.world.now + DAY),
        }),
      "undetermined",
      "evidence_after_assessment",
    ],
    discrepancy: [
      (s) =>
        Object.assign(s.world.verification_evidence[0], {
          discrepancy_flag: true,
        }),
      "undetermined",
      "evidence_discrepancy_unresolved",
    ],
    "no source observation": [
      (s) => Object.assign(s.license, { reported_status: null }),
      "undetermined",
      "no_source_observation",
    ],
    "non-qualifying observation": [
      (s) =>
        Object.assign(s.license, { reported_status: "synthetic-suspended" }),
      "fail",
      "reported_status_not_qualifying",
    ],
    "non-qualifying observation flagged as discrepancy": [
      (s) => {
        Object.assign(s.license, { reported_status: "synthetic-suspended" });
        Object.assign(s.world.verification_evidence[0], {
          discrepancy_flag: true,
        });
      },
      "fail",
      "reported_status_not_qualifying",
    ],
    expired: [
      (s) => Object.assign(s.license, { effective_until: "2026-01-01" }),
      "fail",
      "license_expired",
    ],
    "not yet effective": [
      (s) => Object.assign(s.license, { effective_from: "2027-01-01" }),
      "fail",
      "license_not_yet_effective",
    ],
    "evidence from another jurisdiction": [
      (s) =>
        Object.assign(s.world.verification_evidence[0], {
          jurisdiction_id: s.b,
        }),
      "undetermined",
      "no_evidence",
    ],
  };
  for (const [name, [change, outcome, reason]] of Object.entries(variants)) {
    const s = eligibleWorld();
    change(s);
    const result = assessEligibility(
      factsOf(s.world, s.attorney.attorneyId, s.a),
      s.world.now,
    );
    const license = factor(result, "license");
    assert.equal(license.outcome, outcome, name);
    const recordReason =
      license.records.length === 0 ? license.reason : license.records[0].reason;
    assert.equal(recordReason, reason, name);
    assert.equal(
      result.result,
      outcome === "fail" ? "not_eligible" : "undetermined",
      name,
    );
  }
  // A newer evidence row without discrepancy resolves an older discrepancy.
  const resolved = eligibleWorld();
  resolved.world.verification_evidence[0].discrepancy_flag = true;
  addEvidence(resolved.world, "license", resolved.license, {
    retrieved_at: stamp(resolved.world.now - 60_000),
  });
  assert.equal(
    assessEligibility(
      factsOf(resolved.world, resolved.attorney.attorneyId, resolved.a),
      resolved.world.now,
    ).result,
    "eligible",
  );
  // Multiple jurisdictions: a qualifying license in A says nothing about B.
  const multi = eligibleWorld();
  addPolicy(multi.world, multi.b);
  const inB = assessEligibility(
    factsOf(multi.world, multi.attorney.attorneyId, multi.b),
    multi.world.now,
  );
  assert.equal(factor(inB, "license").reason, "no_license_in_jurisdiction");
});

test("M4-E6. insurance facts: required and missing, rejected by evidence, expired, below minimum, wrong currency, or not required", () => {
  const variants = {
    missing: [
      (s) => s.world.insurance_records.splice(0),
      "fail",
      "no_insurance_in_jurisdiction",
    ],
    "discrepancy evidence": [
      (s) =>
        Object.assign(s.world.verification_evidence[1], {
          discrepancy_flag: true,
        }),
      "undetermined",
      "evidence_discrepancy_unresolved",
    ],
    expired: [
      (s) => Object.assign(s.insurance, { coverage_until: "2026-06-30" }),
      "fail",
      "coverage_not_current",
    ],
    "no coverage dates": [
      (s) => Object.assign(s.insurance, { coverage_from: null }),
      "undetermined",
      "coverage_period_missing",
    ],
    "below minimum": [
      (s) => Object.assign(s.insurance, { per_occurrence_limit_minor: 99999 }),
      "fail",
      "limit_below_minimum",
    ],
    "limit missing": [
      (s) => Object.assign(s.insurance, { per_occurrence_limit_minor: null }),
      "undetermined",
      "limit_missing",
    ],
    "wrong currency": [
      (s) => Object.assign(s.insurance, { currency_code: "XXX" }),
      "undetermined",
      "currency_mismatch",
    ],
  };
  for (const [name, [change, outcome, reason]] of Object.entries(variants)) {
    const s = eligibleWorld();
    change(s);
    const insurance = factor(
      assessEligibility(
        factsOf(s.world, s.attorney.attorneyId, s.a),
        s.world.now,
      ),
      "insurance",
    );
    assert.equal(insurance.outcome, outcome, name);
    assert.equal(
      insurance.records.length === 0
        ? insurance.reason
        : insurance.records[0].reason,
      reason,
      name,
    );
  }
  const optional = eligibleWorld();
  optional.world.policy_versions[0].parameters.insurance.required = false;
  optional.world.insurance_records.splice(0);
  const result = assessEligibility(
    factsOf(optional.world, optional.attorney.attorneyId, optional.a),
    optional.world.now,
  );
  assert.deepEqual(
    [factor(result, "insurance").outcome, result.result],
    ["not_required", "eligible"],
  );
});

test("M4-E7. discipline: an adverse record is not eligible, an unclassified one is undetermined, a cleared one passes", () => {
  for (const [status, outcome, result] of [
    ["synthetic-revoked", "fail", "not_eligible"],
    ["synthetic-pending", "undetermined", "undetermined"],
    [null, "undetermined", "undetermined"],
    ["synthetic-dismissed", "pass", "eligible"],
  ]) {
    const s = eligibleWorld();
    s.world.discipline_records.push({
      id: s.world.nextId(),
      attorney_id: s.attorney.attorneyId,
      jurisdiction_id: s.a,
      external_reference: "SYN-D",
      finding_type: null,
      opened_at: null,
      resolved_at: null,
      status,
      created_at: stamp(s.world.now),
      updated_at: stamp(s.world.now),
    });
    const assessed = assessEligibility(
      factsOf(s.world, s.attorney.attorneyId, s.a),
      s.world.now,
    );
    assert.equal(
      factor(assessed, "discipline").outcome,
      outcome,
      String(status),
    );
    assert.equal(assessed.result, result, String(status));
  }
});

test("M4-E8. practice areas: permitted, pending, refused, withdrawn, absent, not yet effective, and not required", () => {
  const cases = [
    [
      { status: "requested", decided_at: null, effective_from: null },
      "undetermined",
      "authorisation_pending",
    ],
    [{ status: "refused" }, "fail", "authorisation_refused"],
    [
      { status: "withdrawn", decided_at: null },
      "fail",
      "authorisation_withdrawn",
    ],
    [
      { status: "authorised", effective_from: null },
      "fail",
      "authorisation_not_current",
    ],
    [
      { status: "authorised", effective_until: stamp(T()) },
      "fail",
      "authorisation_not_current",
    ],
    [{ status: "something-else" }, "undetermined", "status_not_classified"],
  ];
  function T() {
    return Date.parse("2026-11-04T12:00:00Z");
  }
  for (const [change, outcome, reason] of cases) {
    const s = eligibleWorld();
    Object.assign(s.authorisation, change);
    const area = factor(
      assessEligibility(
        factsOf(s.world, s.attorney.attorneyId, s.a, s.area),
        s.world.now,
      ),
      "practice_area",
    );
    assert.deepEqual(
      [area.outcome, area.reason],
      [outcome, reason],
      JSON.stringify(change),
    );
  }
  const none = eligibleWorld();
  none.world.practice_area_authorisations.splice(0);
  assert.equal(
    factor(
      assessEligibility(
        factsOf(none.world, none.attorney.attorneyId, none.a, none.area),
        none.world.now,
      ),
      "practice_area",
    ).reason,
    "no_authorisation",
  );
  const notRequired = eligibleWorld();
  notRequired.world.policy_versions[0].parameters.practice_area.authorisation_required = false;
  notRequired.world.practice_area_authorisations.splice(0);
  assert.equal(
    factor(
      assessEligibility(
        factsOf(
          notRequired.world,
          notRequired.attorney.attorneyId,
          notRequired.a,
          notRequired.area,
        ),
        notRequired.world.now,
      ),
      "practice_area",
    ).outcome,
    "not_required",
  );
});

test("M4-E9. unreadable, foreign, or dangling facts fail closed as undetermined", () => {
  const s = eligibleWorld();
  const base = factsOf(s.world, s.attorney.attorneyId, s.a);
  const broken = {
    "unreadable licenses": { ...base, licenses: null },
    "unreadable evidence": { ...base, evidence: null },
    "another attorney's license": {
      ...base,
      licenses: [{ ...base.licenses[0], attorney_id: idOf(3, 77) }],
    },
    "another jurisdiction's license": {
      ...base,
      licenses: [{ ...base.licenses[0], jurisdiction_id: s.b }],
    },
    "extra column": { ...base, licenses: [{ ...base.licenses[0], extra: 1 }] },
    "dangling evidence link": { ...base, evidence: [] },
    "link to an unknown record": {
      ...base,
      subjects: [{ ...base.subjects[0], license_id: idOf(9, 1) }],
    },
    "invalid date": {
      ...base,
      licenses: [{ ...base.licenses[0], effective_from: "2026-02-30" }],
    },
    "non-uuid attorney": { ...base, attorneyId: "not-an-id" },
  };
  for (const [name, facts] of Object.entries(broken)) {
    const result = assessEligibility(facts, s.world.now);
    assert.equal(result.result, "undetermined", name);
    assert.equal(factor(result, "account").reason, "facts_unreadable", name);
  }
  assert.equal(assessEligibility(base, Number.NaN).result, "undetermined");
});

test("M4-E10. T1 -> adverse fact -> T2: a later evaluation reflects the new fact and the earlier row is never rewritten", () => {
  const s = eligibleWorld();
  const t1 = assessEligibility(
    factsOf(s.world, s.attorney.attorneyId, s.a),
    s.world.now,
  );
  const row1 = evaluationRowOf(t1, s.world.now);
  const snapshot = JSON.stringify(row1);
  assert.equal(row1.result, "eligible");
  assert.deepEqual(Object.keys(row1).sort(), [
    "as_of",
    "attorney_id",
    "context_id",
    "context_type",
    "evaluated_at",
    "evidence_references",
    "factor_results",
    "jurisdiction_id",
    "policy_references",
    "result",
  ]);
  assert.equal(row1.context_type, "jurisdiction");
  assert.equal(row1.context_id, null);
  assert.ok(Object.isFrozen(row1));
  // An adverse discipline record appears later.
  s.world.now += DAY;
  s.world.discipline_records.push({
    id: s.world.nextId(),
    attorney_id: s.attorney.attorneyId,
    jurisdiction_id: s.a,
    external_reference: "SYN-ADVERSE",
    finding_type: null,
    opened_at: "2026-11-04",
    resolved_at: null,
    status: "synthetic-revoked",
    created_at: stamp(s.world.now),
    updated_at: stamp(s.world.now),
  });
  const t2 = assessEligibility(
    factsOf(s.world, s.attorney.attorneyId, s.a),
    s.world.now,
  );
  const row2 = evaluationRowOf(t2, s.world.now);
  assert.equal(row2.result, "not_eligible");
  assert.notEqual(row2.as_of, row1.as_of);
  assert.equal(JSON.stringify(row1), snapshot);
  assert.equal(row2.evidence_references.discipline_record_ids.length, 1);
  // A practice-area determination carries its context.
  const area = evaluationRowOf(
    assessEligibility(
      factsOf(s.world, s.attorney.attorneyId, s.a, s.area),
      s.world.now,
    ),
    s.world.now,
  );
  assert.deepEqual(
    [area.context_type, area.context_id],
    ["practice_area", s.area],
  );
  // An unreadable assessment cannot become a persisted row.
  assert.equal(evaluationRowOf({ ...t2, asOf: "" }, s.world.now), null);
});
