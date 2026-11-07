// P3-003 staff verification tests (fixture-only).
//
// The staff verification boundary runs against the synthetic M4 world in
// m4-fixtures.mjs, whose read port applies the committed read policies and
// evaluates the manage_attorney_verification scope predicate exactly as the
// migration defines it, and whose privileged port applies the same guarded
// writes the real port sends. No provider, network, or database is
// contacted; every staff member, grant, attorney, and value is synthetic.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  changeProfileStage,
  decidePracticeArea,
  recordDisciplineFinding,
  recordEligibilityDetermination,
  recordSourceUnavailable,
  recordVerificationFinding,
  resolveStaffQueue,
  resolveStaffReview,
} from "../src/application/staff-verification.ts";
import {
  addAccount,
  addAttorney,
  addAuthorisation,
  addEvidence,
  addGrant,
  addInsurance,
  addJurisdiction,
  addLicense,
  addPolicy,
  addPracticeArea,
  addStaff,
  auditsOf,
  createWorld,
  form,
  idOf,
  staffSources,
  stamp,
} from "./m4-fixtures.mjs";

const DAY = 86_400_000;

function setup() {
  const world = createWorld();
  const a = addJurisdiction(world, 1, "SYN_A");
  const b = addJurisdiction(world, 2, "SYN_B");
  const area = addPracticeArea(world, 1);
  const applicant = addAttorney(world, 10, "under_review", {
    display_name: "Synthetic Applicant",
  });
  const licenseA = addLicense(world, applicant.attorneyId, a);
  const licenseB = addLicense(world, applicant.attorneyId, b);
  const request = addAuthorisation(world, applicant.attorneyId, a, area);
  const global = addStaff(world, 30);
  addGrant(world, global.userId);
  const scopedA = addStaff(world, 31);
  addGrant(world, scopedA.userId, { jurisdiction_id: a });
  return {
    world,
    a,
    b,
    area,
    applicant,
    licenseA,
    licenseB,
    request,
    global,
    scopedA,
  };
}

function finding(kind, record, extra = {}) {
  return form({
    subject_kind: kind,
    record,
    source_type: "synthetic register",
    source_reference: "synthetic entry 1",
    source_uri: "",
    retrieved_at: "2026-11-04T11:00",
    verification_method: "synthetic lookup",
    evidence_summary: "The synthetic register lists the claimed number.",
    evidence_digest: "",
    outcome: "consistent",
    ...extra,
  });
}

test("M4-S1. staff identity and grants: anonymous, unconfirmed, attorney-only, client-only, non-active staff, and absent, expired, revoked, future, resource-scoped, or other-capability grants are denied", async () => {
  const s = setup();
  const principals = { anonymous: [null, "sign-in-required"] };
  const unconfirmed = addAccount(s.world, 40, { confirmed: false });
  addStaff(s.world, 40, { account: unconfirmed });
  addGrant(s.world, unconfirmed.userId);
  principals.unconfirmed = [unconfirmed.authId, "denied"];
  principals["attorney only"] = [s.applicant.authId, "denied"];
  principals["client only"] = [addAccount(s.world, 41).authId, "denied"];
  for (const [n, state] of [
    [42, "invited"],
    [43, "deactivated"],
    [44, "removed"],
  ]) {
    const staff = addStaff(s.world, n, { state });
    addGrant(s.world, staff.userId);
    principals[`${state} staff`] = [staff.authId, "denied"];
  }
  const inactiveUser = addStaff(s.world, 45);
  addGrant(s.world, inactiveUser.userId);
  s.world.users.find((u) => u.id === inactiveUser.userId).account_state =
    "suspended";
  principals["suspended User"] = [inactiveUser.authId, "denied"];
  principals["staff without grant"] = [addStaff(s.world, 46).authId, "denied"];
  const grants = {
    expired: { expires_at: s.world.now - 1 },
    revoked: { revoked_at: s.world.now - 1 },
    "not yet granted": { granted_at: s.world.now + DAY },
    "resource-scoped": { resource_scope: { synthetic: true } },
    "other capability": { capability_code: "synthetic_other" },
  };
  let n = 50;
  for (const [name, overrides] of Object.entries(grants)) {
    const staff = addStaff(s.world, n++);
    addGrant(s.world, staff.userId, overrides);
    principals[`${name} grant`] = [staff.authId, "denied"];
  }
  for (const [name, [authId, expected]] of Object.entries(principals)) {
    const sources = staffSources(s.world, authId);
    assert.equal((await resolveStaffQueue(sources)).status, expected, name);
    assert.equal(
      (await resolveStaffReview(sources, s.applicant.attorneyId)).status,
      expected,
      name,
    );
    const before = s.world.verification_evidence.length;
    assert.equal(
      (
        await recordVerificationFinding(
          sources,
          finding("license", s.licenseA.id),
        )
      ).status,
      expected,
      name,
    );
    assert.equal(s.world.verification_evidence.length, before, name);
  }
  // A grant that expires between requests stops working on the next one.
  const expiring = addStaff(s.world, 60);
  addGrant(s.world, expiring.userId, { expires_at: s.world.now + 500 });
  assert.equal(
    (await resolveStaffQueue(staffSources(s.world, expiring.authId))).status,
    "ready",
  );
  s.world.now += 1000;
  assert.equal(
    (await resolveStaffQueue(staffSources(s.world, expiring.authId))).status,
    "denied",
  );
});

test("M4-S2. scope: global staff see profiles; jurisdiction-scoped staff see only their jurisdiction's records, never profiles, and are denied elsewhere", async () => {
  const s = setup();
  const globalQueue = await resolveStaffQueue(
    staffSources(s.world, s.global.authId),
  );
  assert.equal(globalQueue.status, "ready");
  assert.deepEqual(
    globalQueue.entries.map((e) => [
      e.attorneyId,
      e.stage,
      e.licenseClaims,
      e.pendingRequests,
    ]),
    [[s.applicant.attorneyId, "under_review", 2, 1]],
  );
  const scopedQueue = await resolveStaffQueue(
    staffSources(s.world, s.scopedA.authId),
  );
  assert.deepEqual(
    scopedQueue.entries.map((e) => [
      e.attorneyId,
      e.stage,
      e.licenseClaims,
      e.pendingRequests,
    ]),
    [[s.applicant.attorneyId, null, 1, 1]],
  );
  assert.deepEqual(scopedQueue.scope, ["Synthetic SYN_A (SYN_A)"]);
  const scopedView = await resolveStaffReview(
    staffSources(s.world, s.scopedA.authId),
    s.applicant.attorneyId,
  );
  assert.equal(scopedView.profile, null);
  assert.deepEqual(
    scopedView.records.map((r) => r.id).sort(),
    [s.licenseA.id, s.request.id].sort(),
  );
  assert.deepEqual(scopedView.history, []);
  // Out-of-scope record: denied, nothing written.
  assert.deepEqual(
    await recordVerificationFinding(
      staffSources(s.world, s.scopedA.authId),
      finding("license", s.licenseB.id),
    ),
    { status: "denied" },
  );
  // Profile-level review needs the global scope.
  assert.deepEqual(
    await changeProfileStage(
      staffSources(s.world, s.scopedA.authId),
      form({ attorney: s.applicant.attorneyId, intent: "approve" }),
    ),
    { status: "denied" },
  );
  // An unknown or malformed attorney id looks exactly like no access.
  for (const id of [idOf(3, 999), "not-an-id"]) {
    assert.deepEqual(
      await resolveStaffReview(staffSources(s.world, s.global.authId), id),
      { status: "denied" },
    );
  }
  const b = addStaff(s.world, 32);
  addGrant(s.world, b.userId, { jurisdiction_id: s.b });
  const bOnly = await resolveStaffReview(
    staffSources(s.world, b.authId),
    s.applicant.attorneyId,
  );
  assert.deepEqual(
    bOnly.records.map((r) => r.id),
    [s.licenseB.id],
  );
});

test("M4-S3. staff never review their own attorney profile", async () => {
  const s = setup();
  const both = addAttorney(s.world, 70, "under_review");
  s.world.staff_profiles.push({
    id: idOf(4, 70),
    user_id: both.userId,
    staff_state: "active",
  });
  addGrant(s.world, both.userId);
  const own = addLicense(s.world, both.attorneyId, s.a);
  const sources = staffSources(s.world, both.authId);
  const queue = await resolveStaffQueue(sources);
  assert.ok(!queue.entries.some((e) => e.attorneyId === both.attorneyId));
  assert.deepEqual(await resolveStaffReview(sources, both.attorneyId), {
    status: "denied",
  });
  assert.deepEqual(
    await recordVerificationFinding(sources, finding("license", own.id)),
    { status: "denied" },
  );
  assert.deepEqual(
    await changeProfileStage(
      sources,
      form({ attorney: both.attorneyId, intent: "approve" }),
    ),
    { status: "denied" },
  );
  assert.deepEqual(
    await recordEligibilityDetermination(
      sources,
      form({
        attorney: both.attorneyId,
        jurisdiction_id: s.a,
        practice_area_id: "",
      }),
    ),
    { status: "denied" },
  );
});

test("M4-S4. a source-grounded finding writes immutable evidence linked to exactly one record together with any observed status, attributed to the reviewer and audited in the same change", async () => {
  const s = setup();
  const sources = staffSources(s.world, s.scopedA.authId);
  let sent = null;
  s.world.hooks.set("writes.recordFinding", (write) => {
    sent = write;
  });
  const outcome = await recordVerificationFinding(
    sources,
    finding("license", s.licenseA.id, {
      observed_status: "synthetic-active",
      evidence_digest: "synthetic-digest",
      reported_status: "ignored",
    }),
  );
  assert.deepEqual(outcome, { status: "recorded" });
  const evidence = s.world.verification_evidence.at(-1);
  assert.deepEqual(
    [
      evidence.jurisdiction_id,
      evidence.retrieved_by_user_id,
      evidence.discrepancy_flag,
      evidence.retrieved_at,
      evidence.evidence_digest,
    ],
    [
      s.a,
      s.scopedA.userId,
      false,
      "2026-11-04T11:00:00.000Z",
      "synthetic-digest",
    ],
  );
  const link = s.world.verification_evidence_subjects.at(-1);
  assert.deepEqual(
    [
      link.verification_evidence_id,
      link.license_id,
      link.insurance_record_id,
      link.discipline_record_id,
      link.practice_area_authorisation_id,
    ],
    [evidence.id, s.licenseA.id, null, null, null],
  );
  assert.equal(s.licenseA.reported_status, "synthetic-active");
  assert.ok(
    Date.parse(evidence.created_at) <= Date.parse(s.licenseA.updated_at),
  );
  // One write call carried the evidence, the record and its version, and
  // the observed status; no reviewer, User, account, or scope was sent.
  assert.deepEqual(Object.keys(sent).sort(), [
    "disciplineStatus",
    "evidence",
    "evidenceId",
    "expectedUpdatedAt",
    "observedStatus",
    "resolvedAt",
    "subjectId",
    "subjectKind",
  ]);
  for (const identity of [s.scopedA.userId, s.scopedA.authId]) {
    assert.equal(JSON.stringify(sent).includes(identity), false);
  }
  const [audit] = auditsOf(s.world, "verification_evidence_recorded");
  assert.equal(s.world.audit_events.length, 1);
  assert.deepEqual(
    [
      audit.actor_type,
      audit.actor_user_id,
      audit.action_code,
      audit.resource_type,
      audit.resource_id,
    ],
    [
      "staff",
      s.scopedA.userId,
      "verification_evidence_recorded",
      "verification_evidence",
      evidence.id,
    ],
  );
  // A discrepancy is recorded truthfully, and earlier evidence is unchanged.
  const earlier = JSON.stringify(evidence);
  assert.deepEqual(
    await recordVerificationFinding(
      sources,
      finding("license", s.licenseA.id, { outcome: "discrepancy" }),
    ),
    { status: "recorded" },
  );
  assert.equal(s.world.verification_evidence.at(-1).discrepancy_flag, true);
  assert.equal(JSON.stringify(evidence), earlier);
  // Required provenance, real times, https addresses, and an outcome.
  const invalid = await recordVerificationFinding(
    sources,
    finding("license", s.licenseA.id, {
      source_type: "",
      retrieved_at: "2026-11-05T11:00",
      source_uri: "http://synthetic.invalid",
      outcome: "",
    }),
  );
  assert.deepEqual(Object.keys(invalid.fieldErrors).sort(), [
    "outcome",
    "retrieved_at",
    "source_type",
    "source_uri",
  ]);
  // Findings wait while the applicant is editing.
  s.world.attorney_profiles[0].profile_state = "applicant";
  assert.deepEqual(
    await recordVerificationFinding(sources, finding("license", s.licenseA.id)),
    { status: "locked" },
  );
});

test("M4-S5. an unavailable source is an audit event only, never evidence or verification; a finding is never left partial", async () => {
  const s = setup();
  const sources = staffSources(s.world, s.scopedA.authId);
  const before = s.world.verification_evidence.length;
  assert.deepEqual(
    await recordSourceUnavailable(
      sources,
      form({
        subject_kind: "license",
        record: s.licenseA.id,
        note: "Synthetic register offline.",
      }),
    ),
    { status: "recorded" },
  );
  assert.equal(s.world.verification_evidence.length, before);
  assert.equal(s.licenseA.reported_status, null);
  assert.equal(
    s.world.audit_events.at(-1).action_code,
    "verification_source_unavailable",
  );
  // When the audit row cannot be written the database refuses the whole
  // finding: no evidence, no link, no observed status, no audit row.
  const evidenceBefore = s.world.verification_evidence.length;
  const linksBefore = s.world.verification_evidence_subjects.length;
  const auditBefore = s.world.audit_events.length;
  s.world.failures.add("writes.audit");
  assert.deepEqual(
    await recordVerificationFinding(
      sources,
      finding("license", s.licenseA.id, {
        observed_status: "synthetic-active",
      }),
    ),
    { status: "not-saved" },
  );
  assert.equal(s.world.verification_evidence.length, evidenceBefore);
  assert.equal(s.world.verification_evidence_subjects.length, linksBefore);
  assert.equal(s.world.audit_events.length, auditBefore);
  assert.equal(s.licenseA.reported_status, null);
  s.world.failures.clear();
  // An unknown answer is unconfirmed, never recorded.
  s.world.failures.add("writes.recordFinding");
  assert.deepEqual(
    await recordVerificationFinding(sources, finding("license", s.licenseA.id)),
    { status: "unconfirmed" },
  );
  assert.equal(s.world.verification_evidence.length, evidenceBefore);
  s.world.failures.clear();
  // A record changed since it was read is a conflict, and nothing is written.
  s.world.hooks.set("writes.recordFinding", () => {
    s.licenseA.updated_at = stamp(s.world.tick());
  });
  assert.deepEqual(
    await recordVerificationFinding(sources, finding("license", s.licenseA.id)),
    { status: "not-saved" },
  );
  assert.equal(s.world.verification_evidence.length, evidenceBefore);
});

test("M4-S6. discipline findings and practice-area decisions are scoped, guarded, and audited", async () => {
  const s = setup();
  const sources = staffSources(s.world, s.scopedA.authId);
  const discipline = await recordDisciplineFinding(
    sources,
    finding("discipline", "", {
      attorney: s.applicant.attorneyId,
      jurisdiction_id: s.a,
      external_reference: "SYN-REG-1",
      finding_type: "synthetic finding",
      opened_at: "2026-10-01",
      resolved_at: "",
      discipline_status: "synthetic-revoked",
    }),
  );
  assert.deepEqual(discipline, { status: "recorded" });
  const record = s.world.discipline_records.at(-1);
  assert.deepEqual(
    [record.attorney_id, record.jurisdiction_id, record.status],
    [s.applicant.attorneyId, s.a, "synthetic-revoked"],
  );
  assert.equal(
    s.world.verification_evidence_subjects.at(-1).discipline_record_id,
    record.id,
  );
  // Not in the reviewer's jurisdiction.
  assert.deepEqual(
    await recordDisciplineFinding(
      sources,
      finding("discipline", "", {
        attorney: s.applicant.attorneyId,
        jurisdiction_id: s.b,
        discipline_status: "x",
      }),
    ),
    { status: "denied" },
  );
  // Practice-area decision: authorisation needs an effective start.
  const missingStart = await decidePracticeArea(
    sources,
    form({
      record: s.request.id,
      decision: "authorised",
      effective_from: "",
      effective_until: "",
      note: "Synthetic basis",
    }),
  );
  assert.deepEqual(Object.keys(missingStart.fieldErrors), ["effective_from"]);
  assert.deepEqual(
    await decidePracticeArea(
      sources,
      form({
        record: s.request.id,
        decision: "authorised",
        effective_from: "2026-11-04T00:00",
        effective_until: "",
        note: "Synthetic basis",
      }),
    ),
    { status: "recorded" },
  );
  assert.deepEqual(
    [s.request.status, s.request.effective_from],
    ["authorised", "2026-11-04T00:00:00.000Z"],
  );
  const [decided] = auditsOf(s.world, "practice_area_authorisation_decided");
  assert.equal(decided.after_snapshot.note, "Synthetic basis");
  assert.equal(decided.actor_user_id, s.scopedA.userId);
  // A decided request is never decided again.
  assert.deepEqual(
    await decidePracticeArea(
      sources,
      form({ record: s.request.id, decision: "refused", note: "Again" }),
    ),
    { status: "locked" },
  );
  assert.deepEqual(
    await decidePracticeArea(
      sources,
      form({ record: s.request.id, decision: "approve-all", note: "x" }),
    ),
    { status: "unavailable" },
  );
});

test("M4-S7. profile transitions: only the three supported transitions, from their exact stages, with an applicant-visible message for information requests", async () => {
  const s = setup();
  const sources = staffSources(s.world, s.global.authId);
  const profile = s.world.attorney_profiles[0];
  assert.deepEqual(
    await changeProfileStage(
      sources,
      form({ attorney: s.applicant.attorneyId, intent: "suspend" }),
    ),
    { status: "locked" },
  );
  const noMessage = await changeProfileStage(
    sources,
    form({
      attorney: s.applicant.attorneyId,
      intent: "request_information",
      message: "",
    }),
  );
  assert.deepEqual(Object.keys(noMessage.fieldErrors), ["message"]);
  assert.deepEqual(
    await changeProfileStage(
      sources,
      form({
        attorney: s.applicant.attorneyId,
        intent: "request_information",
        message: "Please add your synthetic insurance.",
      }),
    ),
    { status: "recorded" },
  );
  assert.equal(profile.profile_state, "applicant");
  const [request] = auditsOf(s.world, "attorney_information_requested");
  assert.deepEqual(request.after_snapshot, {
    profile_state: "applicant",
    message_to_applicant: "Please add your synthetic insurance.",
  });
  assert.equal(request.actor_user_id, s.global.userId);
  profile.profile_state = "under_review";
  assert.deepEqual(
    await changeProfileStage(
      sources,
      form({
        attorney: s.applicant.attorneyId,
        intent: "approve",
        note: "Synthetic note",
      }),
    ),
    { status: "recorded" },
  );
  assert.equal(profile.profile_state, "approved");
  assert.deepEqual(
    await changeProfileStage(
      sources,
      form({ attorney: s.applicant.attorneyId, intent: "suspend" }),
    ),
    { status: "recorded" },
  );
  assert.equal(profile.profile_state, "suspended");
  // No reinstatement, removal, or invented stage exists here.
  for (const intent of ["reinstate", "remove", "verify", "approved"]) {
    assert.deepEqual(
      await changeProfileStage(
        sources,
        form({ attorney: s.applicant.attorneyId, intent }),
      ),
      { status: "unavailable" },
      intent,
    );
  }
  assert.equal(profile.profile_state, "suspended");
  // Approval created no eligibility evaluation.
  assert.equal(s.world.eligibility_evaluations.length, 0);
});

test("M4-S8. viewing computes assessments without persisting; an explicit determination persists T1, and a later adverse fact yields T2 while T1 is unchanged", async () => {
  const s = setup();
  const sources = staffSources(s.world, s.global.authId);
  const profile = s.world.attorney_profiles[0];
  profile.profile_state = "approved";
  Object.assign(s.licenseA, { reported_status: "synthetic-active" });
  addEvidence(s.world, "license", s.licenseA);
  const insurance = addInsurance(s.world, s.applicant.attorneyId, s.a, {
    per_occurrence_limit_minor: 200000,
    currency_code: "XTS",
    coverage_from: "2026-01-01",
    coverage_until: "2026-12-31",
  });
  addEvidence(s.world, "insurance", insurance);
  // Without an applicable policy, the view holds, and nothing is persisted.
  let view = await resolveStaffReview(sources, s.applicant.attorneyId);
  assert.equal(
    view.assessments.find((x) => x.jurisdictionId === s.a).assessment.result,
    "undetermined",
  );
  assert.equal(s.world.eligibility_evaluations.length, 0);
  assert.equal(s.world.audit_events.length, 0);
  addPolicy(s.world, s.a);
  view = await resolveStaffReview(sources, s.applicant.attorneyId);
  assert.equal(
    view.assessments.find((x) => x.jurisdictionId === s.a).assessment.result,
    "eligible",
  );
  assert.equal(s.world.eligibility_evaluations.length, 0);
  // T1.
  assert.deepEqual(
    await recordEligibilityDetermination(
      sources,
      form({
        attorney: s.applicant.attorneyId,
        jurisdiction_id: s.a,
        practice_area_id: "",
      }),
    ),
    { status: "recorded" },
  );
  const t1 = s.world.eligibility_evaluations[0];
  const t1Snapshot = JSON.stringify(t1);
  assert.deepEqual(
    [t1.result, t1.context_type, t1.jurisdiction_id],
    ["eligible", "jurisdiction", s.a],
  );
  assert.ok(t1.evidence_references.evidence_ids.length >= 2);
  assert.equal(
    t1.policy_references[0].policy_type_code,
    "attorney_eligibility",
  );
  const [recorded] = auditsOf(s.world, "eligibility_evaluation_recorded");
  assert.equal(recorded.resource_id, t1.id);
  assert.equal(recorded.actor_user_id, s.global.userId);
  assert.deepEqual(recorded.policy_references, t1.policy_references);
  // Adverse fact, then T2.
  s.world.now += DAY;
  assert.deepEqual(
    await recordDisciplineFinding(
      sources,
      finding("discipline", "", {
        attorney: s.applicant.attorneyId,
        jurisdiction_id: s.a,
        discipline_status: "synthetic-revoked",
        retrieved_at: "2026-11-05T11:00",
      }),
    ),
    { status: "recorded" },
  );
  assert.deepEqual(
    await recordEligibilityDetermination(
      sources,
      form({
        attorney: s.applicant.attorneyId,
        jurisdiction_id: s.a,
        practice_area_id: "",
      }),
    ),
    { status: "recorded" },
  );
  const t2 = s.world.eligibility_evaluations[1];
  assert.equal(t2.result, "not_eligible");
  assert.equal(JSON.stringify(s.world.eligibility_evaluations[0]), t1Snapshot);
  // Out-of-scope and malformed determinations are refused.
  assert.deepEqual(
    await recordEligibilityDetermination(
      staffSources(s.world, s.scopedA.authId),
      form({
        attorney: s.applicant.attorneyId,
        jurisdiction_id: s.b,
        practice_area_id: "",
      }),
    ),
    { status: "denied" },
  );
  assert.deepEqual(
    await recordEligibilityDetermination(
      sources,
      form({
        attorney: s.applicant.attorneyId,
        jurisdiction_id: s.a,
        practice_area_id: idOf(6, 99),
      }),
    ),
    {
      status: "invalid",
      fieldErrors: { practice_area_id: ["Choose a practice area or none."] },
    },
  );
  // The scoped reviewer sees the recorded evaluations in its jurisdiction.
  const scopedView = await resolveStaffReview(
    staffSources(s.world, s.scopedA.authId),
    s.applicant.attorneyId,
  );
  assert.deepEqual(
    scopedView.evaluations.map((e) => e.result),
    ["not_eligible", "eligible"],
  );
  assert.ok(stamp(s.world.now));
});

test("M4-S9. a failed scope read, an unreadable port, or a missing write boundary is unavailable, never access", async () => {
  const s = setup();
  s.world.failures.add("reads.scope");
  assert.deepEqual(
    await resolveStaffQueue(staffSources(s.world, s.global.authId)),
    { status: "unavailable" },
  );
  assert.deepEqual(
    await recordVerificationFinding(
      staffSources(s.world, s.global.authId),
      finding("license", s.licenseA.id),
    ),
    { status: "unavailable" },
  );
  s.world.failures.clear();
  assert.deepEqual(
    await resolveStaffQueue(
      staffSources(s.world, s.global.authId, {
        provisioning: async () => null,
      }),
    ),
    { status: "unavailable" },
  );
  assert.deepEqual(
    await resolveStaffQueue(
      staffSources(s.world, s.global.authId, {
        reads: async () => {
          throw new Error("synthetic");
        },
      }),
    ),
    { status: "unavailable" },
  );
  assert.deepEqual(
    await recordVerificationFinding(
      staffSources(s.world, s.global.authId),
      form({ subject_kind: "profile", record: s.licenseA.id }),
    ),
    { status: "unavailable" },
  );
  // Without the write boundary neither the review nor any change is offered.
  const noWrites = staffSources(s.world, s.global.authId, {
    writes: async () => null,
  });
  assert.deepEqual(await resolveStaffReview(noWrites, s.applicant.attorneyId), {
    status: "unavailable",
  });
  assert.deepEqual(
    await recordVerificationFinding(
      noWrites,
      finding("license", s.licenseA.id),
    ),
    { status: "unavailable" },
  );
});
