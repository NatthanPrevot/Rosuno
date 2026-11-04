// P3-003 audit integrity and authorization race tests (fixture-only).
//
// Runs the attorney and staff boundaries against the synthetic M4 world in
// m4-fixtures.mjs, instrumented so a test can make an audit append fail,
// lose a write's answer after it was applied, or change a grant, account,
// profile, or record at an exact point of an operation. No provider,
// network, or database is contacted; every value is synthetic.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  changePracticeAreaRequest,
  requestPracticeArea,
  resolveProfessionalSetup,
  saveInsuranceClaim,
  saveLicenseClaim,
  saveProfileDetails,
  submitApplicationForReview,
  SUBMIT_APPLICATION_INTENT,
} from "../src/application/attorney-professional.ts";
import { runAuditedChange } from "../src/application/professional-audit.ts";
import {
  changeProfileStage,
  decidePracticeArea,
  recordDisciplineFinding,
  recordEligibilityDetermination,
  recordVerificationFinding,
} from "../src/application/staff-verification.ts";
import {
  addAttorney,
  addAuthorisation,
  addEvidence,
  addGrant,
  addJurisdiction,
  addLicense,
  addPolicy,
  addPracticeArea,
  addStaff,
  attorneySources,
  auditPair,
  createWorld,
  form,
  staffSources,
} from "./m4-fixtures.mjs";

const DAY = 86_400_000;

function world() {
  const w = createWorld();
  const a = addJurisdiction(w, 1, "SYN_A");
  const b = addJurisdiction(w, 2, "SYN_B");
  const area = addPracticeArea(w, 1);
  const applicant = addAttorney(w, 10, "applicant");
  const reviewed = addAttorney(w, 11, "under_review");
  const licenseA = addLicense(w, reviewed.attorneyId, a);
  const request = addAuthorisation(w, reviewed.attorneyId, a, area);
  const staff = addStaff(w, 30);
  addGrant(w, staff.userId);
  const scoped = addStaff(w, 31);
  addGrant(w, scoped.userId, { jurisdiction_id: a });
  addPolicy(w, a);
  return {
    w,
    a,
    b,
    area,
    applicant,
    reviewed,
    licenseA,
    request,
    staff,
    scoped,
  };
}

const LICENSE = (s, extra = {}) =>
  form({
    record: "",
    jurisdiction_id: s.a,
    license_number: "SYN-NEW",
    license_type: "",
    effective_from: "",
    effective_until: "",
    ...extra,
  });

const FINDING = (record, extra = {}) =>
  form({
    subject_kind: "license",
    record,
    source_type: "synthetic register",
    source_reference: "synthetic entry",
    source_uri: "",
    retrieved_at: "2026-11-04T11:00",
    verification_method: "synthetic lookup",
    evidence_summary: "synthetic",
    evidence_digest: "",
    outcome: "consistent",
    observed_status: "synthetic-active",
    ...extra,
  });

const DISCIPLINE = (s) =>
  form({
    attorney: s.reviewed.attorneyId,
    jurisdiction_id: s.a,
    external_reference: "",
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
  });

// Every consequential operation, with how to see whether it changed the
// domain, for the table-driven audit checks.
function operations(s) {
  const attorney = () => attorneySources(s.w, s.applicant.authId);
  const reviewer = () => staffSources(s.w, s.staff.authId);
  const domain = () =>
    JSON.stringify([
      s.w.attorney_profiles,
      s.w.licenses,
      s.w.insurance_records,
      s.w.practice_area_authorisations,
      s.w.discipline_records,
      s.w.verification_evidence,
      s.w.verification_evidence_subjects,
      s.w.eligibility_evaluations,
    ]);
  return {
    domain,
    list: [
      [
        "profile details",
        () =>
          saveProfileDetails(attorney(), form({ display_name: "Synthetic" })),
      ],
      ["license claim", () => saveLicenseClaim(attorney(), LICENSE(s))],
      [
        "insurance claim",
        () =>
          saveInsuranceClaim(
            attorney(),
            form({
              record: "",
              jurisdiction_id: s.a,
              carrier_name: "Synthetic",
            }),
          ),
      ],
      [
        "practice-area request",
        () =>
          requestPracticeArea(
            attorney(),
            form({ jurisdiction_id: s.a, practice_area_id: s.area }),
          ),
      ],
      [
        "submission",
        async () => {
          addLicense(s.w, s.applicant.attorneyId, s.b);
          return submitApplicationForReview(
            attorney(),
            form({
              [SUBMIT_APPLICATION_INTENT.field]:
                SUBMIT_APPLICATION_INTENT.value,
            }),
          );
        },
      ],
      [
        "verification finding",
        () => recordVerificationFinding(reviewer(), FINDING(s.licenseA.id)),
      ],
      [
        "discipline finding",
        () => recordDisciplineFinding(reviewer(), DISCIPLINE(s)),
      ],
      [
        "practice-area decision",
        () =>
          decidePracticeArea(
            reviewer(),
            form({
              record: s.request.id,
              decision: "refused",
              note: "Synthetic basis",
            }),
          ),
      ],
      [
        "profile transition",
        () =>
          changeProfileStage(
            reviewer(),
            form({ attorney: s.reviewed.attorneyId, intent: "approve" }),
          ),
      ],
      [
        "eligibility determination",
        () =>
          recordEligibilityDetermination(
            reviewer(),
            form({
              attorney: s.reviewed.attorneyId,
              jurisdiction_id: s.a,
              practice_area_id: "",
            }),
          ),
      ],
    ],
  };
}

test("M4-AU1. no consequential operation writes anything when its attempt audit row cannot be appended", async () => {
  for (const index of operations(world()).list.keys()) {
    const s = world();
    const { domain, list } = operations(s);
    const [name, run] = list[index];
    // The submission case seeds its own license claim first.
    if (name === "submission") {
      addLicense(s.w, s.applicant.attorneyId, s.b);
    }
    const before = domain();
    s.w.failures.add("prov.audit.attempt");
    const result = await run();
    if (name === "submission") {
      // The seeding call inside run added one more claim; remove it again.
      s.w.licenses.pop();
    }
    assert.equal(result.status, "unavailable", name);
    assert.equal(domain(), before, name);
    assert.equal(s.w.audit_events.length, 0, name);
  }
});

test("M4-AU2. every applied change has its attempt row before it and an applied outcome after it; a missing outcome row is never reported as fully recorded", async () => {
  for (const index of operations(world()).list.keys()) {
    const s = world();
    const [name, run] = operations(s).list[index];
    const result = await run();
    assert.ok(
      result.status === "saved" || result.status === "recorded",
      `${name}: ${result.status}`,
    );
    const attempts = s.w.audit_events.filter(
      (e) => e.after_snapshot?.audit_phase === "attempt",
    );
    const outcomes = s.w.audit_events.filter(
      (e) => e.after_snapshot?.audit_phase === "outcome",
    );
    assert.equal(attempts.length, 1, name);
    assert.deepEqual(
      outcomes.map((e) => [
        e.after_snapshot.attempt_event_id,
        e.after_snapshot.outcome,
        e.after_snapshot.authority,
      ]),
      [[attempts[0].id, "applied", "held"]],
      name,
    );
    assert.ok(
      s.w.audit_events.indexOf(attempts[0]) <
        s.w.audit_events.indexOf(outcomes[0]),
      name,
    );
  }
  // Outcome append fails: the change persisted with its attempt row, and
  // the state says it could not be fully confirmed.
  for (const index of operations(world()).list.keys()) {
    const s = world();
    const { domain, list } = operations(s);
    const [name, run] = list[index];
    const before = domain();
    s.w.failures.add("prov.audit.outcome");
    const result = await run();
    assert.equal(result.status, "unconfirmed", name);
    assert.notEqual(domain(), before, name);
    assert.equal(
      s.w.audit_events.filter(
        (e) => e.after_snapshot?.audit_phase === "attempt",
      ).length,
      1,
      name,
    );
  }
});

test("M4-AU3. failed writes record a not-applied outcome; lost answers are resolved by reading the generated id; retries never duplicate", async () => {
  const s = world();
  const sources = attorneySources(s.w, s.applicant.authId);
  // Refused insert: nothing persists, and the audit says so.
  s.w.failures.add("prov.insertLicense");
  assert.deepEqual(await saveLicenseClaim(sources, LICENSE(s)), {
    status: "not-saved",
  });
  assert.equal(
    s.w.licenses.filter((l) => l.attorney_id === s.applicant.attorneyId).length,
    0,
  );
  assert.equal(
    auditPair(s.w, "attorney_claim_recorded").outcome.after_snapshot.outcome,
    "not_applied",
  );
  s.w.failures.clear();
  // Applied insert whose answer is lost: the id-keyed read shows it applied.
  s.w.lost.add("prov.insertLicense");
  assert.deepEqual(await saveLicenseClaim(sources, LICENSE(s)), {
    status: "saved",
  });
  assert.equal(
    auditPair(s.w, "attorney_claim_recorded").outcome.after_snapshot.outcome,
    "applied",
  );
  s.w.lost.clear();
  // A retry of the same claim is refused by the unique license number.
  assert.deepEqual(await saveLicenseClaim(sources, LICENSE(s)), {
    status: "not-saved",
  });
  assert.equal(
    s.w.licenses.filter((l) => l.license_number === "SYN-NEW").length,
    1,
  );
  // A retry after a failed attempt append succeeds exactly once.
  s.w.failures.add("prov.audit.attempt");
  assert.deepEqual(
    await saveLicenseClaim(
      sources,
      LICENSE(s, { license_number: "SYN-RETRY" }),
    ),
    { status: "unavailable" },
  );
  s.w.failures.clear();
  assert.deepEqual(
    await saveLicenseClaim(
      sources,
      LICENSE(s, { license_number: "SYN-RETRY" }),
    ),
    { status: "saved" },
  );
  assert.equal(
    s.w.licenses.filter((l) => l.license_number === "SYN-RETRY").length,
    1,
  );
  // Staff: a lost evidence answer stops the link and the status, and the
  // outcome truthfully records only part of the change.
  const reviewer = staffSources(s.w, s.staff.authId);
  s.w.lost.add("prov.insertEvidence");
  assert.deepEqual(
    await recordVerificationFinding(reviewer, FINDING(s.licenseA.id)),
    { status: "unconfirmed" },
  );
  assert.equal(s.licenseA.reported_status, null);
  assert.equal(
    auditPair(s.w, "verification_evidence_recorded").outcome.after_snapshot
      .outcome,
    "partially_applied",
  );
  s.w.lost.clear();
  // Unreadable verification is recorded as unknown, never as applied.
  s.w.failures.add("prov.evaluationById");
  assert.deepEqual(
    await recordEligibilityDetermination(
      reviewer,
      form({
        attorney: s.reviewed.attorneyId,
        jurisdiction_id: s.a,
        practice_area_id: "",
      }),
    ),
    { status: "unconfirmed" },
  );
  assert.equal(
    auditPair(s.w, "eligibility_evaluation_recorded").outcome.after_snapshot
      .outcome,
    "unknown",
  );
});

test("M4-AU4. the applicant sees a staff message only once its return to the applicant stage is confirmed or actually in effect", async () => {
  const s = world();
  const reviewer = staffSources(s.w, s.staff.authId);
  const ask = (message) =>
    changeProfileStage(
      reviewer,
      form({
        attorney: s.reviewed.attorneyId,
        intent: "request_information",
        message,
      }),
    );
  const messages = async () => {
    const view = await resolveProfessionalSetup(
      attorneySources(s.w, s.reviewed.authId),
    );
    return view.informationRequests.map((r) => r.message);
  };
  // A request whose transition does not apply is never shown.
  s.w.failures.add("prov.transitionProfile");
  assert.deepEqual(await ask("Synthetic not applied"), { status: "not-saved" });
  s.w.failures.clear();
  assert.deepEqual(await messages(), []);
  // Applied with its outcome row: shown.
  assert.deepEqual(await ask("Synthetic applied"), { status: "recorded" });
  assert.deepEqual(await messages(), ["Synthetic applied"]);
  // Applied but its outcome row failed: still shown, because the profile
  // really is back in the applicant stage, and the staff state was honest.
  s.w.attorney_profiles.find(
    (p) => p.id === s.reviewed.attorneyId,
  ).profile_state = "under_review";
  s.w.now += 1000;
  s.w.failures.add("prov.audit.outcome");
  assert.deepEqual(await ask("Synthetic outcome missing"), {
    status: "unconfirmed",
  });
  s.w.failures.clear();
  assert.deepEqual(await messages(), [
    "Synthetic outcome missing",
    "Synthetic applied",
  ]);
});

test("M4-AZ1. a grant revoked, expired, or re-scoped, a deactivated Staff Profile, or a suspended User after the check stops every remaining write", async () => {
  const changes = {
    revoked: (s) =>
      (s.w.capability_grants.find(
        (g) => g.user_id === s.staff.userId,
      ).revoked_at = s.w.now - 1),
    expired: (s) =>
      (s.w.capability_grants.find(
        (g) => g.user_id === s.staff.userId,
      ).expires_at = s.w.now - 1),
    "re-scoped": (s) =>
      (s.w.capability_grants.find(
        (g) => g.user_id === s.staff.userId,
      ).jurisdiction_id = s.b),
    "resource-scoped": (s) =>
      (s.w.capability_grants.find(
        (g) => g.user_id === s.staff.userId,
      ).resource_scope = { synthetic: true }),
    "staff deactivated": (s) =>
      (s.w.staff_profiles.find(
        (p) => p.user_id === s.staff.userId,
      ).staff_state = "deactivated"),
    "user suspended": (s) =>
      (s.w.users.find((u) => u.id === s.staff.userId).account_state =
        "suspended"),
  };
  for (const [name, change] of Object.entries(changes)) {
    // Between the attempt row and the first write: nothing is written.
    let s = world();
    s.w.hooks.set("prov.insertAuditEvent", () => change(s));
    assert.deepEqual(
      await recordVerificationFinding(
        staffSources(s.w, s.staff.authId),
        FINDING(s.licenseA.id),
      ),
      { status: "denied" },
      name,
    );
    assert.equal(s.w.verification_evidence.length, 0, name);
    assert.equal(s.licenseA.reported_status, null, name);
    let pair = auditPair(s.w, "verification_evidence_recorded");
    assert.deepEqual(
      [
        pair.outcome.after_snapshot.outcome,
        pair.outcome.after_snapshot.authority,
        pair.outcome.after_snapshot.authority_checked,
      ],
      ["not_applied", "lapsed", "before_write"],
      name,
    );
    // Between the evidence write and the link: the link and the status are
    // never written, and the outcome records the partial change.
    s = world();
    s.w.hooks.set("prov.insertEvidence", () => change(s));
    assert.deepEqual(
      await recordVerificationFinding(
        staffSources(s.w, s.staff.authId),
        FINDING(s.licenseA.id),
      ),
      { status: "unconfirmed" },
      name,
    );
    assert.equal(s.w.verification_evidence.length, 1, name);
    assert.equal(
      s.w.verification_evidence_subjects.filter(
        (l) => l.license_id === s.licenseA.id,
      ).length,
      0,
      name,
    );
    assert.equal(s.licenseA.reported_status, null, name);
    pair = auditPair(s.w, "verification_evidence_recorded");
    assert.deepEqual(
      [
        pair.outcome.after_snapshot.outcome,
        pair.outcome.after_snapshot.authority,
      ],
      ["partially_applied", "lapsed"],
      name,
    );
    // Profile transitions and determinations stop the same way.
    s = world();
    s.w.hooks.set("prov.insertAuditEvent", () => change(s));
    assert.deepEqual(
      await changeProfileStage(
        staffSources(s.w, s.staff.authId),
        form({ attorney: s.reviewed.attorneyId, intent: "approve" }),
      ),
      { status: "denied" },
      name,
    );
    assert.equal(
      s.w.attorney_profiles.find((p) => p.id === s.reviewed.attorneyId)
        .profile_state,
      "under_review",
      name,
    );
    s = world();
    s.w.hooks.set("prov.insertAuditEvent", () => change(s));
    assert.deepEqual(
      await recordEligibilityDetermination(
        staffSources(s.w, s.staff.authId),
        form({
          attorney: s.reviewed.attorneyId,
          jurisdiction_id: s.a,
          practice_area_id: "",
        }),
      ),
      { status: "denied" },
      name,
    );
    assert.equal(s.w.eligibility_evaluations.length, 0, name);
  }
});

test("M4-AZ2. a change of authority inside the final write's own window is detected at completion and never reported as recorded", async () => {
  const s = world();
  // The hook runs after the last re-check and just before the write itself:
  // the one window the application cannot close without a database-side
  // check in the same statement.
  s.w.hooks.set("prov.transitionProfile", () => {
    s.w.capability_grants.find((g) => g.user_id === s.staff.userId).revoked_at =
      s.w.now - 1;
  });
  assert.deepEqual(
    await changeProfileStage(
      staffSources(s.w, s.staff.authId),
      form({ attorney: s.reviewed.attorneyId, intent: "approve" }),
    ),
    { status: "unconfirmed" },
  );
  assert.equal(
    s.w.attorney_profiles.find((p) => p.id === s.reviewed.attorneyId)
      .profile_state,
    "approved",
  );
  const pair = auditPair(s.w, "attorney_profile_state_changed");
  assert.deepEqual(
    [
      pair.outcome.after_snapshot.outcome,
      pair.outcome.after_snapshot.authority,
      pair.outcome.after_snapshot.authority_checked,
    ],
    ["applied", "lapsed", "at_completion"],
  );
});

test("M4-AZ3. concurrent stage and record changes stop or fail the remaining writes instead of overwriting them", async () => {
  // The applicant is returned to editing mid-finding: the remaining writes
  // stop as a stage that no longer allows them.
  let s = world();
  s.w.hooks.set("prov.insertEvidence", () => {
    s.w.attorney_profiles.find(
      (p) => p.id === s.reviewed.attorneyId,
    ).profile_state = "applicant";
  });
  assert.deepEqual(
    await recordVerificationFinding(
      staffSources(s.w, s.staff.authId),
      FINDING(s.licenseA.id),
    ),
    { status: "unconfirmed" },
  );
  assert.equal(
    s.w.verification_evidence_subjects.filter(
      (l) => l.license_id === s.licenseA.id,
    ).length,
    0,
  );
  s = world();
  s.w.hooks.set("prov.insertAuditEvent", () => {
    s.w.attorney_profiles.find(
      (p) => p.id === s.reviewed.attorneyId,
    ).profile_state = "applicant";
  });
  assert.deepEqual(
    await recordVerificationFinding(
      staffSources(s.w, s.staff.authId),
      FINDING(s.licenseA.id),
    ),
    { status: "locked" },
  );
  assert.equal(s.w.verification_evidence.length, 0);
  // The license changes between the read and the status write: the guarded
  // update writes nothing and the status is never overwritten.
  s = world();
  s.w.hooks.set("prov.recordLicenseObservation", () => {
    s.licenseA.updated_at = "2026-11-04T12:30:00.000000+00:00";
  });
  assert.deepEqual(
    await recordVerificationFinding(
      staffSources(s.w, s.staff.authId),
      FINDING(s.licenseA.id),
    ),
    { status: "unconfirmed" },
  );
  assert.equal(s.licenseA.reported_status, null);
  assert.equal(
    auditPair(s.w, "verification_evidence_recorded").outcome.after_snapshot
      .outcome,
    "partially_applied",
  );
  // A competing decision wins: this one is not applied and says so.
  s = world();
  s.w.hooks.set("prov.decideAuthorisation", () => {
    Object.assign(s.request, {
      status: "authorised",
      updated_at: "2026-11-04T12:30:00.000000+00:00",
    });
  });
  assert.deepEqual(
    await decidePracticeArea(
      staffSources(s.w, s.staff.authId),
      form({ record: s.request.id, decision: "refused", note: "Synthetic" }),
    ),
    { status: "not-saved" },
  );
  assert.equal(s.request.status, "authorised");
});

test("M4-AZ4. an attorney's own authority and preconditions are re-checked before the write: submission, suspension, or new evidence stop it", async () => {
  const cases = {
    "submitted elsewhere": (s) =>
      (s.w.attorney_profiles.find(
        (p) => p.id === s.applicant.attorneyId,
      ).profile_state = "under_review"),
    "profile suspended": (s) =>
      (s.w.attorney_profiles.find(
        (p) => p.id === s.applicant.attorneyId,
      ).profile_state = "suspended"),
    "user suspended": (s) =>
      (s.w.users.find((u) => u.id === s.applicant.userId).account_state =
        "suspended"),
  };
  for (const [name, change] of Object.entries(cases)) {
    const s = world();
    s.w.hooks.set("prov.insertAuditEvent", () => change(s));
    assert.deepEqual(
      await saveLicenseClaim(
        attorneySources(s.w, s.applicant.authId),
        LICENSE(s),
      ),
      { status: "locked" },
      name,
    );
    assert.equal(
      s.w.licenses.filter((l) => l.attorney_id === s.applicant.attorneyId)
        .length,
      0,
      name,
    );
    assert.equal(
      auditPair(s.w, "attorney_claim_recorded").outcome.after_snapshot.outcome,
      "not_applied",
      name,
    );
  }
  // Evidence linked to a claim between the edit's check and its write.
  const s = world();
  const own = addLicense(s.w, s.applicant.attorneyId, s.a, {
    license_number: "SYN-OWN",
  });
  s.w.hooks.set("prov.insertAuditEvent", () =>
    addEvidence(s.w, "license", own),
  );
  assert.deepEqual(
    await saveLicenseClaim(
      attorneySources(s.w, s.applicant.authId),
      LICENSE(s, { record: own.id, license_number: "SYN-CHANGED" }),
    ),
    { status: "locked" },
  );
  assert.equal(own.license_number, "SYN-OWN");
  // A withdrawal raced by a staff decision is not applied.
  const t = world();
  const pending = addAuthorisation(t.w, t.applicant.attorneyId, t.a, t.area);
  t.w.hooks.set("prov.updateAuthorisationRequest", () => {
    Object.assign(pending, {
      status: "authorised",
      decided_at: "2026-11-04T12:00:00.000000+00:00",
    });
  });
  assert.deepEqual(
    await changePracticeAreaRequest(
      attorneySources(t.w, t.applicant.authId),
      form({ record: pending.id, intent: "withdraw" }),
    ),
    { status: "not-saved" },
  );
  assert.equal(pending.status, "authorised");
  void DAY;
});

test("M4-AU5. the protocol runner itself: unreadable authority stops writes, a thrown step stops the rest, and malformed append answers count as unrecorded", async () => {
  const appended = [];
  const port = {
    insertAuditEvent: async (event) => {
      appended.push(event);
      return {
        kind: "rows",
        rows: [
          {
            id: `00000000-0000-4000-8000-${String(appended.length).padStart(12, "0")}`,
          },
        ],
      };
    },
  };
  const attempt = {
    actorUserId: "00000000-0000-4000-8000-000000000001",
    actorType: "staff",
    action: "attorney_profile_state_changed",
    resourceType: "attorney_profile",
    resourceId: "00000000-0000-4000-8000-000000000002",
    occurredAtMs: 0,
  };
  const ran = [];
  let result = await runAuditedChange(
    {
      port,
      attempt,
      authorizedForWrite: async () => null,
      authorizedAtCompletion: async () => true,
      steps: [async () => ran.push(1) > 0],
      verify: async () => "applied",
    },
    () => 0,
  );
  assert.deepEqual(
    [result.status, result.authority, result.outcome, ran.length],
    ["stopped", "unreadable", "not_applied", 0],
  );
  result = await runAuditedChange(
    {
      port,
      attempt,
      authorizedForWrite: async () => true,
      authorizedAtCompletion: async () => true,
      steps: [
        async () => {
          throw new Error("synthetic");
        },
        async () => ran.push(2) > 0,
      ],
      verify: async () => "not_applied",
    },
    () => 0,
  );
  assert.deepEqual(
    [result.status, result.outcome, ran.length],
    ["completed", "not_applied", 0],
  );
  for (const answer of [
    { kind: "rows", rows: [] },
    { kind: "rows", rows: [{ id: "x" }] },
    { kind: "unreadable" },
    null,
  ]) {
    const r = await runAuditedChange(
      {
        port: { insertAuditEvent: async () => answer },
        attempt,
        authorizedForWrite: async () => true,
        authorizedAtCompletion: async () => true,
        steps: [async () => ran.push(3) > 0],
        verify: async () => "applied",
      },
      () => 0,
    );
    assert.equal(r.status, "unrecorded");
  }
  assert.equal(ran.length, 0);
});
