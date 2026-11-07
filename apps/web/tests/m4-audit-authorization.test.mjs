// P3-003 audit integrity and authorization race tests (fixture-only),
// corrected by P3-904.
//
// Runs the attorney and staff boundaries against the synthetic M4 world in
// m4-fixtures.mjs, whose write ports answer as the P3-904 database write
// functions do: each decides the caller's authority, the target's stage, and
// the record's version itself, and writes the change and its one audit row
// together, or nothing. The world is instrumented so a test can make the
// audit append fail, lose a write's answer after it was applied, or change a
// grant, account, profile, or record just before the write call, after the
// application's own checks passed. These tests pin the application's side of
// the contract; the database's own enforcement, including separately
// controlled concurrent sessions, is proven against real PostgreSQL in
// p3-904-db-proof.mjs. No provider, network, or database is contacted; every
// value is synthetic.

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
import {
  writeOnce,
  writeResultOf,
} from "../src/application/professional-audit.ts";
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
    // [name, run, write method, success status, actor]
    list: [
      [
        "profile details",
        () =>
          saveProfileDetails(attorney(), form({ display_name: "Synthetic" })),
        "saveProfileDetails",
      ],
      [
        "license claim",
        () => saveLicenseClaim(attorney(), LICENSE(s)),
        "saveLicense",
      ],
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
        "saveInsurance",
      ],
      [
        "practice-area request",
        () =>
          requestPracticeArea(
            attorney(),
            form({ jurisdiction_id: s.a, practice_area_id: s.area }),
          ),
        "requestPracticeArea",
      ],
      [
        "submission",
        () =>
          submitApplicationForReview(
            attorney(),
            form({
              [SUBMIT_APPLICATION_INTENT.field]:
                SUBMIT_APPLICATION_INTENT.value,
            }),
          ),
        "submitApplication",
      ],
      [
        "verification finding",
        () => recordVerificationFinding(reviewer(), FINDING(s.licenseA.id)),
        "recordFinding",
      ],
      [
        "discipline finding",
        () => recordDisciplineFinding(reviewer(), DISCIPLINE(s)),
        "recordDisciplineFinding",
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
        "decidePracticeArea",
      ],
      [
        "profile transition",
        () =>
          changeProfileStage(
            reviewer(),
            form({ attorney: s.reviewed.attorneyId, intent: "approve" }),
          ),
        "changeProfileStage",
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
        "recordEvaluation",
      ],
    ],
  };
}

const ATTORNEY_WRITES = [
  "saveProfileDetails",
  "saveLicense",
  "saveInsurance",
  "requestPracticeArea",
  "submitApplication",
];

function expectedFor(s, method) {
  return ATTORNEY_WRITES.includes(method)
    ? { status: "saved", actor: s.applicant.userId, type: "attorney" }
    : { status: "recorded", actor: s.staff.userId, type: "staff" };
}

test("M4-AU1. no consequential operation leaves a domain change when its mandatory audit row cannot be written: the database refuses the whole call", async () => {
  for (const index of operations(world()).list.keys()) {
    const s = world();
    const { domain, list } = operations(s);
    const [name, run] = list[index];
    const before = domain();
    s.w.failures.add("writes.audit");
    const result = await run();
    assert.equal(result.status, "not-saved", name);
    assert.equal(domain(), before, name);
    assert.equal(s.w.audit_events.length, 0, name);
  }
});

test("M4-AU2. every applied change commits with exactly one audit row naming the verified caller; nothing else is appended", async () => {
  for (const index of operations(world()).list.keys()) {
    const s = world();
    const { domain, list } = operations(s);
    const [name, run, method] = list[index];
    const expected = expectedFor(s, method);
    const before = domain();
    const result = await run();
    assert.equal(result.status, expected.status, name);
    assert.notEqual(domain(), before, name);
    assert.equal(s.w.audit_events.length, 1, name);
    const [row] = s.w.audit_events;
    assert.deepEqual(
      [row.actor_user_id, row.actor_type],
      [expected.actor, expected.type],
      name,
    );
    assert.equal(
      Object.hasOwn(row.after_snapshot ?? {}, "audit_phase"),
      false,
      name,
    );
  }
});

test("M4-AU3. an unknown or lost answer is never reported as success: a lost call changed nothing, and a lost answer left exactly one change and one audit row", async () => {
  for (const index of operations(world()).list.keys()) {
    let s = world();
    let ops = operations(s);
    const [name, , method] = ops.list[index];
    // The answer never arrives and the call did not run.
    let before = ops.domain();
    s.w.failures.add(`writes.${method}`);
    assert.equal((await ops.list[index][1]()).status, "unconfirmed", name);
    assert.equal(ops.domain(), before, name);
    assert.equal(s.w.audit_events.length, 0, name);
    // The call ran and committed, but its answer was lost.
    s = world();
    ops = operations(s);
    before = ops.domain();
    s.w.lost.add(`writes.${method}`);
    assert.equal((await ops.list[index][1]()).status, "unconfirmed", name);
    assert.notEqual(ops.domain(), before, name);
    assert.equal(s.w.audit_events.length, 1, name);
  }
});

test("M4-AU4. a replayed write with the same server-generated id never duplicates a record or an audit row", async () => {
  const s = world();
  const fixedId = "00000000-0000-4000-8000-000099990001";
  const attorney = attorneySources(s.w, s.applicant.authId, {
    newId: () => fixedId,
  });
  assert.deepEqual(await saveLicenseClaim(attorney, LICENSE(s)), {
    status: "saved",
  });
  assert.deepEqual(
    await saveLicenseClaim(attorney, LICENSE(s, { license_number: "SYN-2" })),
    { status: "not-saved" },
  );
  assert.equal(s.w.licenses.filter((l) => l.id === fixedId).length, 1);
  const evidenceId = "00000000-0000-4000-8000-000099990002";
  const reviewer = staffSources(s.w, s.staff.authId, {
    newId: () => evidenceId,
  });
  assert.deepEqual(
    await recordVerificationFinding(
      reviewer,
      FINDING(s.licenseA.id, { observed_status: "" }),
    ),
    { status: "recorded" },
  );
  assert.deepEqual(
    await recordVerificationFinding(
      reviewer,
      FINDING(s.licenseA.id, { observed_status: "" }),
    ),
    { status: "not-saved" },
  );
  assert.equal(
    s.w.verification_evidence.filter((e) => e.id === evidenceId).length,
    1,
  );
  assert.equal(
    s.w.audit_events.filter((e) =>
      [fixedId, evidenceId].includes(e.resource_id),
    ).length,
    2,
  );
});

test("M4-AU5. the applicant sees every committed request for more information, newest first, and only the message written for the applicant", async () => {
  const s = world();
  const reviewer = staffSources(s.w, s.staff.authId);
  const attorney = attorneySources(s.w, s.reviewed.authId);
  for (const message of [
    "Synthetic first request",
    "Synthetic second request",
  ]) {
    s.w.now += DAY;
    assert.deepEqual(
      await changeProfileStage(
        reviewer,
        form({
          attorney: s.reviewed.attorneyId,
          intent: "request_information",
          message,
        }),
      ),
      { status: "recorded" },
    );
    s.w.attorney_profiles.find(
      (p) => p.id === s.reviewed.attorneyId,
    ).profile_state = "under_review";
  }
  s.w.attorney_profiles.find(
    (p) => p.id === s.reviewed.attorneyId,
  ).profile_state = "applicant";
  const view = await resolveProfessionalSetup(attorney);
  assert.deepEqual(
    view.informationRequests.map((r) => r.message),
    ["Synthetic second request", "Synthetic first request"],
  );
  // A refused request leaves nothing to show.
  s.w.attorney_profiles.find(
    (p) => p.id === s.reviewed.attorneyId,
  ).profile_state = "approved";
  assert.deepEqual(
    await changeProfileStage(
      reviewer,
      form({
        attorney: s.reviewed.attorneyId,
        intent: "request_information",
        message: "Synthetic refused request",
      }),
    ),
    { status: "locked" },
  );
  assert.equal(
    s.w.audit_events.filter(
      (e) =>
        e.after_snapshot?.message_to_applicant === "Synthetic refused request",
    ).length,
    0,
  );
});

test("M4-AZ1. a grant revoked, expired, re-scoped, or resource-scoped, a deactivated Staff Profile, or a suspended User landing after the application's check is decided by the write itself: denied, nothing written", async () => {
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
  const staffOps = [
    "recordFinding",
    "recordDisciplineFinding",
    "decidePracticeArea",
    "changeProfileStage",
    "recordEvaluation",
  ];
  for (const [change, apply] of Object.entries(changes)) {
    for (const method of staffOps) {
      const s = world();
      const ops = operations(s);
      const [, run] = ops.list.find((entry) => entry[2] === method);
      const before = ops.domain();
      s.w.hooks.set(`writes.${method}`, () => apply(s));
      assert.deepEqual(
        await run(),
        { status: "denied" },
        `${change} ${method}`,
      );
      assert.equal(ops.domain(), before, `${change} ${method}`);
      assert.equal(s.w.audit_events.length, 0, `${change} ${method}`);
    }
  }
});

test("M4-AZ2. no write call sends an actor, User, account, reviewer, or grant: the database derives the caller from the session", async () => {
  for (const index of operations(world()).list.keys()) {
    const s = world();
    const [name, run, method] = operations(s).list[index];
    let sent = null;
    s.w.hooks.set(`writes.${method}`, (...args) => {
      sent = args;
    });
    await run();
    assert.notEqual(sent, null, name);
    const text = JSON.stringify(sent);
    for (const identity of [
      s.applicant.userId,
      s.applicant.authId,
      s.staff.userId,
      s.staff.authId,
    ]) {
      assert.equal(text.includes(identity), false, name);
    }
    // No argument key names an actor, User, reviewer, or grant.
    assert.doesNotMatch(
      text,
      /"(actor[a-z_]*|[a-z_]*user_id|retrieved_by[a-z_]*|reviewer[a-z_]*|grant[a-z_]*)":/,
      name,
    );
  }
});

test("M4-AZ3. a stage or record change landing after the application's check makes the write refuse: a changed record is a conflict and a changed stage is locked", async () => {
  // Record version changed: the reviewer's decision is not saved.
  let s = world();
  s.w.hooks.set("writes.decidePracticeArea", () => {
    s.request.updated_at = "2026-11-04T12:30:00.000000+00:00";
  });
  assert.deepEqual(
    await decidePracticeArea(
      staffSources(s.w, s.staff.authId),
      form({ record: s.request.id, decision: "refused", note: "Synthetic" }),
    ),
    { status: "not-saved" },
  );
  assert.equal(s.request.status, "requested");
  assert.equal(s.w.audit_events.length, 0);
  // Another reviewer decided first: locked.
  s = world();
  s.w.hooks.set("writes.decidePracticeArea", () => {
    s.request.status = "authorised";
  });
  assert.deepEqual(
    await decidePracticeArea(
      staffSources(s.w, s.staff.authId),
      form({ record: s.request.id, decision: "refused", note: "Synthetic" }),
    ),
    { status: "locked" },
  );
  assert.equal(s.w.audit_events.length, 0);
  // The profile returned to the applicant: findings are locked.
  s = world();
  s.w.hooks.set("writes.recordFinding", () => {
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
  assert.equal(s.licenseA.reported_status, null);
});

test("M4-AZ4. an attorney's own submission, suspension, or newly linked evidence landing after the application's check makes the write refuse", async () => {
  const cases = [
    [
      "submitted meanwhile",
      (s) =>
        (s.w.attorney_profiles.find(
          (p) => p.id === s.applicant.attorneyId,
        ).profile_state = "under_review"),
      "locked",
    ],
    [
      "profile suspended meanwhile",
      (s) =>
        (s.w.attorney_profiles.find(
          (p) => p.id === s.applicant.attorneyId,
        ).profile_state = "suspended"),
      "denied",
    ],
    [
      "user suspended meanwhile",
      (s) =>
        (s.w.users.find((u) => u.id === s.applicant.userId).account_state =
          "suspended"),
      "denied",
    ],
  ];
  for (const [name, apply, expected] of cases) {
    const s = world();
    s.w.hooks.set("writes.saveLicense", () => apply(s));
    assert.deepEqual(
      await saveLicenseClaim(
        attorneySources(s.w, s.applicant.authId),
        LICENSE(s),
      ),
      { status: expected },
      name,
    );
    assert.equal(s.w.licenses.length, 1, name);
    assert.equal(s.w.audit_events.length, 0, name);
  }
  // Evidence linked to the claim meanwhile: the revision is locked.
  const s = world();
  const own = addLicense(s.w, s.applicant.attorneyId, s.a);
  s.w.hooks.set("writes.saveLicense", () => addEvidence(s.w, "license", own));
  assert.deepEqual(
    await saveLicenseClaim(
      attorneySources(s.w, s.applicant.authId),
      LICENSE(s, { record: own.id, license_number: "SYN-CHANGED" }),
    ),
    { status: "locked" },
  );
  assert.equal(own.license_number === "SYN-CHANGED", false);
  // Withdrawal of a request decided meanwhile is locked too.
  const request = addAuthorisation(s.w, s.applicant.attorneyId, s.b, s.area);
  s.w.hooks.set("writes.changePracticeAreaRequest", () => {
    request.status = "refused";
    request.decided_at = "2026-11-04T12:00:00.000000+00:00";
  });
  assert.deepEqual(
    await changePracticeAreaRequest(
      attorneySources(s.w, s.applicant.authId),
      form({ record: request.id, intent: "withdraw" }),
    ),
    { status: "locked" },
  );
  assert.equal(request.status, "refused");
});

test("M4-AU6. the outcome reader is strict: only the five fixed outcomes or a database refusal count, and anything thrown or malformed is unknown", async () => {
  const answers = [
    [{ kind: "outcome", outcome: "applied" }, "applied"],
    [{ kind: "outcome", outcome: "denied" }, "denied"],
    [{ kind: "outcome", outcome: "locked" }, "locked"],
    [{ kind: "outcome", outcome: "conflict" }, "conflict"],
    [{ kind: "outcome", outcome: "invalid" }, "invalid"],
    [{ kind: "rejected" }, "rejected"],
    [{ kind: "unreadable" }, "unknown"],
    [{ kind: "outcome", outcome: "saved" }, "unknown"],
    [{ kind: "outcome", outcome: "applied", detail: "x" }, "unknown"],
    [{ kind: "rejected", code: "42501" }, "unknown"],
    [{ kind: "rows", rows: [] }, "unknown"],
    [Object.create({ kind: "outcome", outcome: "applied" }), "unknown"],
    ["applied", "unknown"],
    [null, "unknown"],
    [undefined, "unknown"],
  ];
  for (const [answer, expected] of answers) {
    assert.equal(writeResultOf(answer), expected, JSON.stringify(answer));
  }
  const accessor = {};
  Object.defineProperty(accessor, "kind", {
    get: () => "outcome",
    enumerable: true,
  });
  Object.defineProperty(accessor, "outcome", {
    get: () => "applied",
    enumerable: true,
  });
  assert.equal(writeResultOf(accessor), "unknown");
  assert.equal(
    await writeOnce(async () => {
      throw new Error("synthetic");
    }),
    "unknown",
  );
  assert.equal(
    await writeOnce(async () => ({ kind: "outcome", outcome: "applied" })),
    "applied",
  );
});
