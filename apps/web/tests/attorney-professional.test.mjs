// P3-003 attorney professional setup tests (fixture-only).
//
// The attorney professional setup boundary runs against the synthetic M4
// world in m4-fixtures.mjs, whose read port applies the committed own-row
// read policies and whose privileged port applies the same guarded writes
// the real port sends. No provider, network, or database is contacted, and
// every account, id, and value is synthetic test data.

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
  addAccount,
  addAttorney,
  addAuthorisation,
  addEvidence,
  addJurisdiction,
  addLicense,
  addPracticeArea,
  attorneySources,
  createWorld,
  auditPair,
  form,
  idOf,
  UNREADABLE,
} from "./m4-fixtures.mjs";

function setup(state = "applicant") {
  const world = createWorld();
  const a = addJurisdiction(world, 1, "SYN_A");
  const b = addJurisdiction(world, 2, "SYN_B");
  const area = addPracticeArea(world, 1);
  const inactiveArea = addPracticeArea(world, 2, false);
  const me = addAttorney(world, 10, state);
  const other = addAttorney(world, 11, "applicant");
  return { world, a, b, area, inactiveArea, me, other };
}

const LICENSE = (jurisdiction, extra = {}) =>
  form({
    record: "",
    jurisdiction_id: jurisdiction,
    license_number: "SYN-100",
    license_type: "",
    effective_from: "2020-01-01",
    effective_until: "",
    ...extra,
  });

test("M4-A1. identity: anonymous, unconfirmed, mismatched, missing, inactive, and suspended or removed principals are refused before anything is read or written", async () => {
  const s = setup();
  const cases = [];
  cases.push(["anonymous", attorneySources(s.world, null), "sign-in-required"]);
  const unconfirmed = addAccount(s.world, 20, { confirmed: false });
  cases.push([
    "unconfirmed",
    attorneySources(s.world, unconfirmed.authId),
    "denied",
  ]);
  cases.push([
    "Auth read names another account",
    {
      ...attorneySources(s.world, s.me.authId),
      account: {
        currentAccount: async () => ({
          kind: "user",
          id: s.other.authId,
          emailConfirmedAt: "2026-10-01T00:00:00Z",
        }),
      },
    },
    "denied",
  ]);
  cases.push([
    "Auth read unreadable",
    {
      ...attorneySources(s.world, s.me.authId),
      account: { currentAccount: async () => ({ kind: "unreadable" }) },
    },
    "unavailable",
  ]);
  const noUser = addAccount(s.world, 21);
  s.world.users = s.world.users.filter((u) => u.id !== noUser.userId);
  cases.push([
    "no Rosuno User",
    attorneySources(s.world, noUser.authId),
    "denied",
  ]);
  const suspendedUser = addAttorney(s.world, 22, "applicant");
  s.world.users.find((u) => u.id === suspendedUser.userId).account_state =
    "suspended";
  cases.push([
    "suspended User",
    attorneySources(s.world, suspendedUser.authId),
    "denied",
  ]);
  const clientOnly = addAccount(s.world, 23);
  cases.push([
    "User without attorney profile",
    attorneySources(s.world, clientOnly.authId),
    "no-application",
  ]);
  for (const state of ["suspended", "removed"]) {
    const profile = addAttorney(
      s.world,
      state === "suspended" ? 24 : 25,
      state,
    );
    cases.push([
      `${state} profile`,
      attorneySources(s.world, profile.authId),
      "denied",
    ]);
  }
  for (const [name, sources, expected] of cases) {
    const before = JSON.stringify([
      s.world.licenses,
      s.world.audit_events,
      s.world.attorney_profiles,
    ]);
    assert.equal(
      (await resolveProfessionalSetup(sources)).status,
      expected,
      name,
    );
    const outcome = await saveLicenseClaim(sources, LICENSE(s.a));
    assert.equal(
      outcome.status,
      expected === "no-application" ? "denied" : expected,
      name,
    );
    assert.equal(
      JSON.stringify([
        s.world.licenses,
        s.world.audit_events,
        s.world.attorney_profiles,
      ]),
      before,
      name,
    );
  }
});

test("M4-A2. the setup view keeps account, stage, evidence status, recorded eligibility, and marketplace readiness apart, and offers no form without the trusted write boundary", async () => {
  const s = setup("under_review");
  const license = addLicense(s.world, s.me.attorneyId, s.a, {
    reported_status: "synthetic-active",
  });
  addEvidence(s.world, "license", license);
  const pending = addLicense(s.world, s.me.attorneyId, s.b);
  addLicense(s.world, s.other.attorneyId, s.a);
  s.world.eligibility_evaluations.push({
    id: s.world.nextId(),
    attorney_id: s.me.attorneyId,
    jurisdiction_id: s.a,
    context_type: "jurisdiction",
    context_id: null,
    evaluated_at: "2026-11-03T10:00:00.000000+00:00",
    result: "undetermined",
  });
  const view = await resolveProfessionalSetup(
    attorneySources(s.world, s.me.authId),
  );
  assert.equal(view.status, "ready");
  assert.equal(view.stage, "under_review");
  assert.equal(view.editable, false);
  assert.equal(view.canSubmit, false);
  // Only this attorney's own claims, each with its own evidence status.
  assert.deepEqual(
    view.licenses.map((l) => [
      l.id,
      l.verification,
      l.observedStatus,
      l.editable,
    ]),
    [
      [license.id, "source_checked", "synthetic-active", false],
      [pending.id, "awaiting_review", null, false],
    ],
  );
  assert.deepEqual(view.eligibility, [
    {
      jurisdiction: "Synthetic SYN_A (SYN_A)",
      context: "Jurisdiction",
      result: "undetermined",
      evaluatedAt: "2026-11-03T10:00:00.000000+00:00",
    },
  ]);
  // Inactive practice areas are not offered.
  assert.deepEqual(
    view.practiceAreas.map((o) => o.value),
    [s.area],
  );
  assert.ok(Object.isFrozen(view) && Object.isFrozen(view.licenses[0]));
  // Viewing persists nothing.
  assert.equal(s.world.audit_events.length, 0);
  // Without the trusted write boundary, nothing is offered at all.
  const noPort = await resolveProfessionalSetup(
    attorneySources(s.world, s.me.authId, { provisioning: async () => null }),
  );
  assert.equal(noPort.status, "unavailable");
  const throwing = await resolveProfessionalSetup(
    attorneySources(s.world, s.me.authId, {
      provisioning: async () => {
        throw new Error("synthetic");
      },
    }),
  );
  assert.equal(throwing.status, "unavailable");
});

test("M4-A3. license claims: added and revised only as claims, never with an observed status, and audited with the verified attorney as actor", async () => {
  const s = setup();
  const sources = attorneySources(s.world, s.me.authId);
  // Spoofed fields (observed status, attorney, stage) are never read.
  const added = await saveLicenseClaim(
    sources,
    LICENSE(s.a, {
      reported_status: "verified",
      attorney_id: s.other.attorneyId,
      profile_state: "approved",
    }),
  );
  assert.deepEqual(added, { status: "saved" });
  const row = s.world.licenses.at(-1);
  assert.equal(row.attorney_id, s.me.attorneyId);
  assert.equal(row.reported_status, null);
  assert.equal(
    s.world.attorney_profiles.find((p) => p.id === s.me.attorneyId)
      .profile_state,
    "applicant",
  );
  // The attempt row was appended before the insert and names the exact
  // record; its outcome row confirms the insert was applied.
  const { attempt: audit, outcome } = auditPair(
    s.world,
    "attorney_claim_recorded",
  );
  assert.ok(
    s.world.audit_events.indexOf(audit) < s.world.audit_events.indexOf(outcome),
  );
  assert.deepEqual(
    [
      outcome.after_snapshot.outcome,
      outcome.after_snapshot.authority,
      outcome.resource_id,
      outcome.actor_user_id,
    ],
    ["applied", "held", row.id, s.me.userId],
  );
  assert.deepEqual(
    [
      audit.actor_user_id,
      audit.actor_type,
      audit.action_code,
      audit.resource_type,
      audit.resource_id,
      audit.jurisdiction_id,
    ],
    [
      s.me.userId,
      "attorney",
      "attorney_claim_recorded",
      "license",
      row.id,
      s.a,
    ],
  );
  // Revision of the attorney's own unreviewed claim.
  const revised = await saveLicenseClaim(
    sources,
    LICENSE(s.b, { record: row.id, license_number: "SYN-101" }),
  );
  assert.deepEqual(revised, { status: "saved" });
  assert.deepEqual([row.jurisdiction_id, row.license_number], [s.b, "SYN-101"]);
  const revision = auditPair(s.world, "attorney_claim_revised");
  assert.equal(revision.attempt.before_snapshot.license_number, "SYN-100");
  assert.equal(revision.attempt.after_snapshot.license_number, "SYN-101");
  assert.equal(revision.outcome.after_snapshot.outcome, "applied");
  // Validation: bad jurisdiction, empty number, impossible or inverted dates.
  const invalid = await saveLicenseClaim(
    sources,
    LICENSE(idOf(5, 99), {
      license_number: " ",
      effective_from: "2026-02-30",
      effective_until: "",
    }),
  );
  assert.equal(invalid.status, "invalid");
  assert.deepEqual(Object.keys(invalid.fieldErrors).sort(), [
    "effective_from",
    "jurisdiction_id",
    "license_number",
  ]);
  const inverted = await saveLicenseClaim(
    sources,
    LICENSE(s.a, {
      license_number: "SYN-102",
      effective_from: "2026-01-02",
      effective_until: "2026-01-01",
    }),
  );
  assert.deepEqual(Object.keys(inverted.fieldErrors), ["effective_until"]);
  // A duplicate number in the same jurisdiction changes nothing.
  addLicense(s.world, s.other.attorneyId, s.a, { license_number: "SYN-DUP" });
  const count = s.world.licenses.length;
  assert.deepEqual(
    await saveLicenseClaim(
      sources,
      LICENSE(s.a, { license_number: "SYN-DUP" }),
    ),
    { status: "not-saved" },
  );
  assert.equal(s.world.licenses.length, count);
});

test("M4-A4. IDOR and locks: another attorney's record, a record with evidence or an observed status, and a non-applicant stage cannot be changed", async () => {
  const s = setup();
  const sources = attorneySources(s.world, s.me.authId);
  const theirs = addLicense(s.world, s.other.attorneyId, s.a);
  const before = JSON.stringify(theirs);
  assert.deepEqual(
    await saveLicenseClaim(
      sources,
      LICENSE(s.a, { record: theirs.id, license_number: "SYN-STOLEN" }),
    ),
    { status: "denied" },
  );
  assert.equal(JSON.stringify(theirs), before);
  const reviewed = addLicense(s.world, s.me.attorneyId, s.a);
  addEvidence(s.world, "license", reviewed);
  assert.deepEqual(
    await saveLicenseClaim(
      sources,
      LICENSE(s.a, { record: reviewed.id, license_number: "SYN-X" }),
    ),
    { status: "locked" },
  );
  const observed = addLicense(s.world, s.me.attorneyId, s.b, {
    reported_status: "synthetic-suspended",
  });
  assert.deepEqual(
    await saveLicenseClaim(
      sources,
      LICENSE(s.b, { record: observed.id, license_number: "SYN-Y" }),
    ),
    { status: "locked" },
  );
  assert.equal(observed.reported_status, "synthetic-suspended");
  // A malformed record id is refused before any read.
  assert.deepEqual(
    await saveLicenseClaim(sources, LICENSE(s.a, { record: "not-an-id" })),
    { status: "unavailable" },
  );
  // Once submitted, nothing can be changed here.
  s.world.attorney_profiles.find(
    (p) => p.id === s.me.attorneyId,
  ).profile_state = "under_review";
  for (const [name, call] of [
    [
      "license",
      () =>
        saveLicenseClaim(sources, LICENSE(s.a, { license_number: "SYN-Z" })),
    ],
    [
      "details",
      () => saveProfileDetails(sources, form({ display_name: "Synthetic" })),
    ],
    [
      "area",
      () =>
        requestPracticeArea(
          sources,
          form({ jurisdiction_id: s.a, practice_area_id: s.area }),
        ),
    ],
  ]) {
    assert.deepEqual(await call(), { status: "locked" }, name);
  }
});

test("M4-A5. insurance claims and profile details: own fields only, validated, and confirmed by a fresh read", async () => {
  const s = setup();
  const sources = attorneySources(s.world, s.me.authId);
  const saved = await saveInsuranceClaim(
    sources,
    form({
      record: "",
      jurisdiction_id: s.a,
      carrier_name: "Synthetic carrier",
      policy_reference: "",
      coverage_type: "",
      per_occurrence_limit_minor: "250000",
      aggregate_limit_minor: "",
      currency_code: "xts",
      coverage_from: "2026-01-01",
      coverage_until: "2026-12-31",
    }),
  );
  assert.deepEqual(saved, { status: "saved" });
  const record = s.world.insurance_records.at(-1);
  assert.deepEqual(
    [
      record.attorney_id,
      record.currency_code,
      record.per_occurrence_limit_minor,
    ],
    [s.me.attorneyId, "XTS", 250000],
  );
  const missingCurrency = await saveInsuranceClaim(
    sources,
    form({
      record: "",
      jurisdiction_id: s.a,
      carrier_name: "Synthetic",
      per_occurrence_limit_minor: "1",
      currency_code: "",
    }),
  );
  assert.deepEqual(Object.keys(missingCurrency.fieldErrors), ["currency_code"]);
  addEvidence(s.world, "insurance", record);
  assert.deepEqual(
    await saveInsuranceClaim(
      sources,
      form({
        record: record.id,
        jurisdiction_id: s.a,
        carrier_name: "Changed",
      }),
    ),
    { status: "locked" },
  );
  const details = await saveProfileDetails(
    sources,
    form({
      display_name: " Synthetic Name ",
      headline: "",
      bio: "Synthetic bio",
      years_experience: "7",
      profile_state: "approved",
    }),
  );
  assert.deepEqual(details, { status: "saved" });
  const profile = s.world.attorney_profiles.find(
    (p) => p.id === s.me.attorneyId,
  );
  assert.deepEqual(
    [
      profile.display_name,
      profile.headline,
      profile.years_experience,
      profile.profile_state,
    ],
    ["Synthetic Name", null, 7, "applicant"],
  );
  const tooMany = await saveProfileDetails(
    sources,
    form({ years_experience: "81" }),
  );
  assert.deepEqual(Object.keys(tooMany.fieldErrors), ["years_experience"]);
  const repeated = await saveProfileDetails(
    sources,
    form({ display_name: ["one", "two"] }),
  );
  assert.equal(repeated.status, "invalid");
});

test("M4-A6. practice-area requests: request, duplicate, inactive area, withdraw, renew, and no change to a staff decision", async () => {
  const s = setup();
  const sources = attorneySources(s.world, s.me.authId);
  assert.deepEqual(
    await requestPracticeArea(
      sources,
      form({ jurisdiction_id: s.a, practice_area_id: s.area }),
    ),
    { status: "saved" },
  );
  const entry = s.world.practice_area_authorisations.at(-1);
  assert.deepEqual(
    [entry.attorney_id, entry.status, entry.decided_at],
    [s.me.attorneyId, "requested", null],
  );
  const duplicate = await requestPracticeArea(
    sources,
    form({ jurisdiction_id: s.a, practice_area_id: s.area }),
  );
  assert.deepEqual(Object.keys(duplicate.fieldErrors), ["practice_area_id"]);
  const inactive = await requestPracticeArea(
    sources,
    form({ jurisdiction_id: s.a, practice_area_id: s.inactiveArea }),
  );
  assert.deepEqual(Object.keys(inactive.fieldErrors), ["practice_area_id"]);
  assert.deepEqual(
    await changePracticeAreaRequest(
      sources,
      form({ record: entry.id, intent: "withdraw" }),
    ),
    { status: "saved" },
  );
  assert.equal(entry.status, "withdrawn");
  assert.deepEqual(
    await changePracticeAreaRequest(
      sources,
      form({ record: entry.id, intent: "renew" }),
    ),
    { status: "saved" },
  );
  assert.equal(entry.status, "requested");
  // Unknown intents and other attorneys' requests are refused.
  assert.deepEqual(
    await changePracticeAreaRequest(
      sources,
      form({ record: entry.id, intent: "authorise" }),
    ),
    { status: "unavailable" },
  );
  const theirs = addAuthorisation(s.world, s.other.attorneyId, s.a, s.area);
  assert.deepEqual(
    await changePracticeAreaRequest(
      sources,
      form({ record: theirs.id, intent: "withdraw" }),
    ),
    { status: "denied" },
  );
  // A staff decision is never withdrawn or renewed by the attorney.
  const decided = addAuthorisation(s.world, s.me.attorneyId, s.b, s.area, {
    status: "authorised",
    decided_at: "2026-11-01T00:00:00.000000+00:00",
  });
  assert.deepEqual(
    await changePracticeAreaRequest(
      sources,
      form({ record: decided.id, intent: "withdraw" }),
    ),
    { status: "locked" },
  );
  assert.equal(decided.status, "authorised");
});

test("M4-A7. submission asks for review only: it needs the exact intent, imposes no completeness rule, and approves nothing", async () => {
  const s = setup();
  const sources = attorneySources(s.world, s.me.authId);
  const intent = {
    [SUBMIT_APPLICATION_INTENT.field]: SUBMIT_APPLICATION_INTENT.value,
  };
  // An application without any license claim may still be submitted; review
  // staff can return it for more information. (Another attorney is used so
  // the main flow below still starts from the applicant stage.)
  const bare = addAttorney(s.world, 12, "applicant");
  assert.deepEqual(
    await submitApplicationForReview(
      attorneySources(s.world, bare.authId),
      form(intent),
    ),
    { status: "saved" },
  );
  assert.equal(
    s.world.attorney_profiles.find((p) => p.id === bare.attorneyId)
      .profile_state,
    "under_review",
  );
  addLicense(s.world, s.me.attorneyId, s.a);
  assert.deepEqual(
    await submitApplicationForReview(sources, form({ intent: "approve" })),
    { status: "unavailable" },
  );
  assert.deepEqual(
    await submitApplicationForReview(
      sources,
      form({ ...intent, profile_state: "approved" }),
    ),
    { status: "saved" },
  );
  assert.equal(
    s.world.attorney_profiles.find((p) => p.id === s.me.attorneyId)
      .profile_state,
    "under_review",
  );
  const submitted = auditPair(s.world, "attorney_application_submitted");
  assert.deepEqual(submitted.attempt.after_snapshot, {
    profile_state: "under_review",
    audit_phase: "attempt",
  });
  assert.equal(submitted.outcome.after_snapshot.outcome, "applied");
  // A second submission changes nothing.
  assert.deepEqual(await submitApplicationForReview(sources, form(intent)), {
    status: "locked",
  });
  // The other attorney is untouched.
  assert.equal(
    s.world.attorney_profiles.find((p) => p.id === s.other.attorneyId)
      .profile_state,
    "applicant",
  );
});

test("M4-A8. failure semantics: unreadable reads, failed writes, and a missing audit row never report success", async () => {
  const s = setup();
  addLicense(s.world, s.me.attorneyId, s.a);
  const sources = attorneySources(s.world, s.me.authId);
  // Write-ahead audit: when the attempt row cannot be appended, nothing is
  // written at all, so no change can persist without its audit evidence.
  const licensesBefore = s.world.licenses.length;
  s.world.failures.add("prov.audit");
  assert.deepEqual(
    await saveLicenseClaim(sources, LICENSE(s.b, { license_number: "SYN-A8" })),
    { status: "unavailable" },
  );
  assert.equal(s.world.licenses.length, licensesBefore);
  assert.equal(s.world.audit_events.length, 0);
  s.world.failures.clear();
  s.world.failures.add("prov.insertLicense");
  assert.deepEqual(
    await saveLicenseClaim(
      sources,
      LICENSE(s.b, { license_number: "SYN-A8B" }),
    ),
    { status: "not-saved" },
  );
  s.world.failures.clear();
  s.world.failures.add("prov.jurisdictions");
  assert.deepEqual(
    await saveLicenseClaim(
      sources,
      LICENSE(s.b, { license_number: "SYN-A8C" }),
    ),
    { status: "unavailable" },
  );
  assert.equal((await resolveProfessionalSetup(sources)).status, "unavailable");
  s.world.failures.clear();
  s.world.failures.add("reads.licenses");
  assert.equal((await resolveProfessionalSetup(sources)).status, "unavailable");
  s.world.failures.clear();
  // A port that throws or answers malformed data is unreadable.
  const malformed = attorneySources(s.world, s.me.authId, {
    reads: async () => ({
      ...(await attorneySources(s.world, s.me.authId).reads()),
      licensesOf: async () => ({ kind: "rows", rows: [{ id: "x" }] }),
    }),
  });
  assert.equal(
    (await resolveProfessionalSetup(malformed)).status,
    "unavailable",
  );
  assert.equal(
    (await saveLicenseClaim(sources, "not form data")).status,
    "unavailable",
  );
  assert.equal(UNREADABLE.kind, "unreadable");
});

test("M4-A9. an approved attorney may revise presentation fields only; years of experience stays as reviewed, and nothing changes under review", async () => {
  const s = setup("approved");
  const profile = s.world.attorney_profiles.find(
    (p) => p.id === s.me.attorneyId,
  );
  profile.years_experience = 7;
  const sources = attorneySources(s.world, s.me.authId);
  const view = await resolveProfessionalSetup(sources);
  assert.deepEqual(
    [view.editable, view.detailsEditable, view.yearsEditable, view.canSubmit],
    [false, true, false, false],
  );
  assert.deepEqual(
    await saveProfileDetails(
      sources,
      form({
        display_name: "Synthetic Approved",
        headline: "Synthetic headline",
        bio: "Synthetic bio",
      }),
    ),
    { status: "saved" },
  );
  assert.deepEqual(
    [
      profile.display_name,
      profile.headline,
      profile.bio,
      profile.years_experience,
      profile.profile_state,
    ],
    [
      "Synthetic Approved",
      "Synthetic headline",
      "Synthetic bio",
      7,
      "approved",
    ],
  );
  const pair = auditPair(s.world, "attorney_profile_details_revised");
  assert.deepEqual(
    [pair.attempt.reason_code, pair.outcome.after_snapshot.outcome],
    ["presentation_only", "applied"],
  );
  // A changed years value is refused; the same value is accepted.
  const refused = await saveProfileDetails(
    sources,
    form({ display_name: "X", years_experience: "9" }),
  );
  assert.deepEqual(Object.keys(refused.fieldErrors), ["years_experience"]);
  assert.equal(profile.years_experience, 7);
  assert.deepEqual(
    await saveProfileDetails(
      sources,
      form({ display_name: "Y", years_experience: "7" }),
    ),
    { status: "saved" },
  );
  // Claims stay locked once approved.
  assert.deepEqual(await saveLicenseClaim(sources, LICENSE(s.a)), {
    status: "locked",
  });
  // Under review and suspended profiles change nothing.
  profile.profile_state = "under_review";
  assert.deepEqual(
    await saveProfileDetails(sources, form({ display_name: "Z" })),
    { status: "locked" },
  );
  profile.profile_state = "suspended";
  assert.deepEqual(
    await saveProfileDetails(sources, form({ display_name: "Z" })),
    { status: "denied" },
  );
  assert.equal(profile.display_name, "Y");
  // Approval ending between the check and the write stops the write.
  profile.profile_state = "approved";
  s.world.hooks.set("prov.insertAuditEvent", () => {
    profile.profile_state = "suspended";
  });
  assert.deepEqual(
    await saveProfileDetails(sources, form({ display_name: "Raced" })),
    { status: "locked" },
  );
  assert.equal(profile.display_name, "Y");
});
