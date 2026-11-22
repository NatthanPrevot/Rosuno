// MVP-001 S11 L1/L3 tests: the completion workspaces (cancellation, early
// completion by agreement, the client's Consultation list, staff consultation
// operations and the operations and compliance review items, Verified Client
// Reviews, the Complaint foundation and Legal Holds), their adapter's strict
// answer reading, their labels and their routes.
//
// Every source is a synthetic fake; nothing here reaches a network or a
// database. The database decides everything again (proven by the S11 DB
// proof); these tests prove that the application only refuses early, reads
// strictly and passes the database's own fixed outcomes on.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
  cancelAttorneyConsultation,
  cancelClientConsultation,
  CLIENT_LIST_COLUMNS,
  earlyEndOffered,
  endConsultationEarly,
  nominalEndOf,
  OUTCOME_CODES,
  OUTCOME_CODES_OF,
  recordableCodesOf,
  recordConsultationOutcome,
  resolveClientConsultations,
  resolveFamilyExceptions,
  resolveStaffConsultation,
  STAFF_CONSULTATION_COLUMNS,
  assignFamilyException,
} from "../src/application/consultation-outcomes.ts";
import {
  classifyComplaintCase,
  openClientComplaint,
  resolveClientComplaints,
  updateComplaintCase,
} from "../src/application/complaints.ts";
import {
  placeLegalHold,
  releaseLegalHold,
  resolveLegalHolds,
} from "../src/application/legal-holds.ts";
import {
  moderateReview,
  resolveClientReviews,
  resolvePublicReviews,
  submitClientReview,
} from "../src/application/reviews.ts";
import {
  rowAnswerOf,
  textAnswerOf,
  createLegalHoldWrites,
  createParticipantOutcomeWrites,
} from "../src/infrastructure/consultations/completion-adapter.ts";
import * as labels from "../src/presentation/completion-labels.ts";
import {
  addStaff,
  configurationSources,
  createWorld,
  grant,
} from "./configuration-fixtures.mjs";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, appRoot), "utf8");
const codeOf = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
function filesIn(directory) {
  return readdirSync(new URL(directory, appRoot), { recursive: true })
    .map((file) => `${directory}${file.replaceAll("\\", "/")}`)
    .filter((file) => statSync(new URL(file, appRoot)).isFile())
    .sort();
}

const SUBJECT = "6f1c2d3e-4a5b-4c6d-8e7f-901234567890";
const USER = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const CONSULTATION = "99999999-9999-4999-8999-999999999999";
const OTHER = "99999999-9999-4999-8999-999999999998";
const JURISDICTION = "77777777-7777-4777-8777-777777777777";
const ITEM = "88888888-8888-4888-8888-888888888888";
const REVIEW = "55555555-5555-4555-8555-555555555555";
const CASE = "44444444-4444-4444-8444-444444444444";
const HOLD = "33333333-3333-4333-8333-333333333333";
const T = "2026-11-20T10:00:00+00:00";
const LATER = "2026-11-20T10:30:00+00:00";

const rows = (list) => ({ kind: "rows", rows: list });
const answer = (outcome) => ({ kind: "answer", outcome });
const DEV = rows([{ environment_class: "development", project_ref: null }]);

function form(fields) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      data.append(key, entry);
    }
  }
  return data;
}

// The verified client and the attorney principal, as the earlier slices'
// tests build them.
function participants(state) {
  const clientIntake = {
    session: { currentSubject: async () => state.subject },
    contexts: { contextsOf: async () => ["client"] },
    account: {
      currentAccount: async () => ({
        kind: "user",
        id: state.subject,
        emailConfirmedAt: "2026-11-01T00:00:00Z",
      }),
    },
    reads: async () => ({
      usersOf: async (a) =>
        rows(
          a === SUBJECT
            ? [{ id: USER, auth_user_id: SUBJECT, account_state: "active" }]
            : [],
        ),
      clientProfilesOf: async (u) =>
        rows(u === USER ? [{ id: CLIENT, user_id: USER }] : []),
    }),
    writes: async () => ({}),
  };
  const attorney = {
    session: { currentSubject: async () => state.subject },
    attorney: {
      contextsOf: async () => (state.stage === null ? [] : ["attorney"]),
      principalOf: async () =>
        state.stage === null
          ? { contexts: [], stage: null }
          : { contexts: ["attorney"], stage: state.stage },
    },
  };
  return { clientIntake, attorney };
}

const entryRow = (overrides = {}) => ({
  consultation_id: CONSULTATION,
  state: "scheduled",
  ready_due: false,
  request_path: "scheduled",
  modality: "synthetic_video",
  duration_minutes: 30,
  booking_starts_at: T,
  booking_ends_at: LATER,
  opens_at: T,
  closes_at: LATER,
  started_at: null,
  ended_at: null,
  outcome_code: null,
  ...overrides,
});

function outcomeWorld(options = {}) {
  const calls = [];
  const state = {
    subject: SUBJECT,
    stage: "approved",
    list: rows([entryRow()]),
    environment: DEV,
    configuredClass: "development",
    cancel: answer("cancelled"),
    endEarly: answer("completed"),
    ...options,
  };
  const { clientIntake, attorney } = participants(state);
  const shared = {
    reads: async () => ({
      clientList: async () => {
        calls.push(["clientList"]);
        return state.list;
      },
      environmentIdentity: async () => state.environment,
    }),
    writes: async () => ({
      cancel: async (id) => {
        calls.push(["cancel", id]);
        return state.cancel;
      },
      endEarly: async (id) => {
        calls.push(["endEarly", id]);
        return state.endEarly;
      },
    }),
    environment: () => ({
      configuredClass: state.configuredClass,
      expectedProjectRef: null,
    }),
    drain: async () => {
      calls.push(["drain"]);
    },
  };
  return {
    client: { ...shared, clientIntake },
    attorney: { ...shared, ...attorney },
    calls,
    state,
  };
}

// ---------------------------------------------------------------------------
// The outcome vocabulary and the participant commands
// ---------------------------------------------------------------------------

test("S11-1. the outcome vocabulary is exactly the database's: completed normal | early_by_agreement | manual_resolution; cancelled client_cancelled | attorney_cancelled; no_show client_no_show | attorney_no_show | both_no_show; technical_failure neither_connected | mid_consultation_failure; staff may record only the four never-started codes for an undecided Consultation and the two live codes for a live one, none once decided; every code has a fixed label", () => {
  assert.deepEqual(OUTCOME_CODES_OF, {
    completed: ["normal", "early_by_agreement", "manual_resolution"],
    cancelled: ["client_cancelled", "attorney_cancelled"],
    no_show: ["client_no_show", "attorney_no_show", "both_no_show"],
    technical_failure: ["neither_connected", "mid_consultation_failure"],
  });
  assert.deepEqual(recordableCodesOf("scheduled"), [
    "client_no_show",
    "attorney_no_show",
    "both_no_show",
    "neither_connected",
  ]);
  assert.deepEqual(recordableCodesOf("ready"), recordableCodesOf("created"));
  assert.deepEqual(recordableCodesOf("live"), [
    "manual_resolution",
    "mid_consultation_failure",
  ]);
  for (const state of ["completed", "cancelled", "no_show", "technical_failure"]) {
    assert.deepEqual(recordableCodesOf(state), [], state);
  }
  for (const code of OUTCOME_CODES) {
    assert.equal(typeof labels.OUTCOME_LABELS[code], "string", code);
    assert.equal(labels.outcomeLabelOf(code), labels.OUTCOME_LABELS[code]);
  }
  assert.equal(labels.outcomeLabelOf("unknown_code"), null);
  assert.equal(labels.outcomeLabelOf(null), null);
});

test("S11-2. the client's list is read strictly: every column exactly, a terminal state only with its own outcome and end, an undecided one with neither; an unexpected column, an outcome of another state or a repeated id makes the whole list unavailable; a refused client reads nothing", async () => {
  const w = outcomeWorld({
    list: rows([
      entryRow(),
      entryRow({
        consultation_id: OTHER,
        state: "cancelled",
        ended_at: LATER,
        outcome_code: "client_cancelled",
      }),
    ]),
  });
  const view = await resolveClientConsultations(w.client);
  assert.equal(view.status, "ready");
  assert.deepEqual(
    view.entries.map((e) => [e.state, e.outcomeCode]),
    [
      ["scheduled", null],
      ["cancelled", "client_cancelled"],
    ],
  );
  assert.deepEqual(Object.keys(entryRow()), [...CLIENT_LIST_COLUMNS]);
  for (const bad of [
    [entryRow({ extra: 1 })],
    [entryRow({ state: "cancelled", ended_at: LATER, outcome_code: "normal" })],
    [entryRow({ state: "completed", ended_at: null, outcome_code: "normal" })],
    [entryRow({ outcome_code: "normal" })],
    [entryRow(), entryRow()],
    [entryRow({ ready_due: true, state: "live", started_at: T })],
  ]) {
    const refused = await resolveClientConsultations(
      outcomeWorld({ list: rows(bad) }).client,
    );
    assert.equal(refused.status, "unavailable", JSON.stringify(bad));
  }
  const anonymous = outcomeWorld({ subject: null });
  assert.equal(
    (await resolveClientConsultations(anonymous.client)).status,
    "sign-in-required",
  );
  assert.deepEqual(anonymous.calls, []);
});

test("S11-3. cancellation and early completion map every database outcome to a fixed state; a malformed form sends nothing and answers not found; denied refuses; an unknown answer is unconfirmed; a rejected call is unavailable; an unbound environment or a refused participant sends nothing; one bounded worker run follows only a success", async () => {
  const cases = [
    ["cancelled", "consultation_cancelled"],
    ["already_cancelled", "already_cancelled"],
    ["ended", "ended"],
    ["in_progress", "in_progress"],
    ["not_found", "not_found"],
    ["configuration_unavailable", "configuration_unavailable"],
    // MVP-001 S11 correction pass (R2): refused at or after the nominal end.
    ["time_passed", "time_passed"],
  ];
  for (const [outcome, mapped] of cases) {
    const w = outcomeWorld({ cancel: answer(outcome) });
    const state = await cancelClientConsultation(
      w.client,
      form({ consultation: CONSULTATION }),
    );
    assert.deepEqual(state, { status: "outcome", outcome: mapped });
    assert.equal(
      w.calls.some(([c]) => c === "drain"),
      outcome === "cancelled",
      outcome,
    );
  }
  assert.equal(
    (
      await cancelClientConsultation(
        outcomeWorld({ cancel: answer("denied") }).client,
        form({ consultation: CONSULTATION }),
      )
    ).status,
    "denied",
  );
  assert.equal(
    (
      await cancelClientConsultation(
        outcomeWorld({ cancel: answer("something_else") }).client,
        form({ consultation: CONSULTATION }),
      )
    ).status,
    "unconfirmed",
  );
  assert.equal(
    (
      await cancelClientConsultation(
        outcomeWorld({ cancel: { kind: "rejected" } }).client,
        form({ consultation: CONSULTATION }),
      )
    ).status,
    "unavailable",
  );
  for (const bad of [
    form({}),
    form({ consultation: "not-an-id" }),
    form({ consultation: [CONSULTATION, OTHER] }),
  ]) {
    const w = outcomeWorld();
    assert.deepEqual(await cancelClientConsultation(w.client, bad), {
      status: "outcome",
      outcome: "not_found",
    });
    assert.deepEqual(w.calls, []);
  }
  const unbound = outcomeWorld({ configuredClass: "production" });
  assert.equal(
    (
      await cancelClientConsultation(
        unbound.client,
        form({ consultation: CONSULTATION }),
      )
    ).status,
    "unavailable",
  );
  assert.deepEqual(unbound.calls, []);
  const noAttorney = outcomeWorld({ stage: null });
  assert.equal(
    (
      await cancelAttorneyConsultation(
        noAttorney.attorney,
        form({ consultation: CONSULTATION }),
      )
    ).status,
    "denied",
  );
  assert.deepEqual(noAttorney.calls, []);
  for (const [outcome, mapped] of [
    ["completed", "consultation_completed_early"],
    ["not_early", "not_early"],
    ["not_started", "not_started"],
    ["ended", "ended"],
    ["conflict", "conflict"],
  ]) {
    const w = outcomeWorld({ endEarly: answer(outcome) });
    assert.deepEqual(
      await endConsultationEarly(
        w.attorney,
        form({ consultation: CONSULTATION }),
      ),
      { status: "outcome", outcome: mapped },
    );
  }
});

test("S11-4. early completion is offered only for a live Consultation before its nominal end: the Booking's end on the scheduled path, the start plus the requested duration on the instant path; nothing derivable offers nothing", () => {
  const now = Date.parse("2026-11-20T10:10:00Z");
  const scheduled = {
    state: "live",
    path: "scheduled",
    bookingEnd: LATER,
    startedAt: T,
    durationMinutes: 30,
  };
  assert.equal(nominalEndOf(scheduled), Date.parse(LATER));
  assert.equal(earlyEndOffered(scheduled, now), true);
  assert.equal(earlyEndOffered(scheduled, Date.parse(LATER)), false);
  assert.equal(earlyEndOffered({ ...scheduled, state: "ready" }, now), false);
  const instant = {
    state: "live",
    path: "instant",
    bookingEnd: null,
    startedAt: T,
    durationMinutes: 15,
  };
  assert.equal(nominalEndOf(instant), Date.parse(T) + 15 * 60_000);
  assert.equal(earlyEndOffered(instant, now), true);
  assert.equal(
    earlyEndOffered(instant, Date.parse("2026-11-20T10:16:00Z")),
    false,
  );
  assert.equal(
    earlyEndOffered({ ...instant, durationMinutes: null }, now),
    false,
  );
  assert.equal(earlyEndOffered({ ...scheduled, bookingEnd: null }, now), false);
});

// ---------------------------------------------------------------------------
// Staff operations and review item families
// ---------------------------------------------------------------------------

const staffRow = (overrides = {}) => ({
  consultation_id: CONSULTATION,
  jurisdiction_id: JURISDICTION,
  state: "scheduled",
  outcome_code: null,
  request_path: "scheduled",
  duration_minutes: 30,
  booking_starts_at: T,
  booking_ends_at: LATER,
  started_at: null,
  ended_at: null,
  closes_at: LATER,
  window_basis: "configured",
  recordable: true,
  attorney_joined: false,
  client_joined: true,
  both_present: false,
  either_left: false,
  provider_sessions: 1,
  interruptions: 0,
  payment_state: "authorized",
  open_exceptions: 0,
  ...overrides,
});

function operationsWorld({ capabilities = [], answers = {} } = {}) {
  const world = createWorld();
  const staff = addStaff(world, 7);
  for (const [capability, jurisdiction] of capabilities) {
    grant(world, staff.userId, capability, {
      jurisdiction_id: jurisdiction ?? null,
    });
  }
  const calls = [];
  const sources = {
    staff: configurationSources(world, staff.authId),
    reads: async () => ({
      stale: async (offset) => {
        calls.push(["stale", offset]);
        return rows(answers.stale ?? []);
      },
      consultation: async (id) => {
        calls.push(["consultation", id]);
        return rows(answers.consultation ?? [staffRow()]);
      },
      exceptions: async (family, status, offset) => {
        calls.push(["exceptions", family, status, offset]);
        return rows(answers.exceptions ?? []);
      },
      environmentIdentity: async () => DEV,
    }),
    writes: async () => ({
      recordOutcome: async (id, code, acknowledge) => {
        calls.push(["record", id, code, acknowledge]);
        return answers.record ?? answer("recorded");
      },
    }),
    exceptionWrites: async () => ({
      assignException: async (id, assign) => {
        calls.push(["assign", id, assign]);
        return answer("applied");
      },
      resolveException: async (id, notes) => {
        calls.push(["resolve", id, notes]);
        return answer("applied");
      },
    }),
    environment: () => ({
      configuredClass: "development",
      expectedProjectRef: null,
    }),
    drain: async () => {
      calls.push(["drain"]);
    },
  };
  return { sources, calls };
}

test("S11-5. staff outcome recording needs manage_consultation_operations in some scope (the database checks the Consultation's own jurisdiction); the form names one offered code and at most the acknowledgement 'yes'; every database outcome maps to its fixed state; a malformed form sends nothing", async () => {
  const none = operationsWorld();
  assert.equal(
    (
      await recordConsultationOutcome(
        none.sources,
        form({ consultation: CONSULTATION, outcome: "client_no_show" }),
      )
    ).status,
    "denied",
  );
  assert.deepEqual(none.calls, []);
  const scoped = operationsWorld({
    capabilities: [["manage_consultation_operations", JURISDICTION]],
  });
  assert.deepEqual(
    await recordConsultationOutcome(
      scoped.sources,
      form({
        consultation: CONSULTATION,
        outcome: "client_no_show",
        acknowledge: "yes",
      }),
    ),
    { status: "outcome", outcome: "outcome_recorded" },
  );
  assert.deepEqual(scoped.calls, [
    ["record", CONSULTATION, "client_no_show", true],
    ["drain"],
  ]);
  for (const bad of [
    { consultation: CONSULTATION, outcome: "normal" },
    { consultation: CONSULTATION, outcome: "client_cancelled" },
    { consultation: "x", outcome: "client_no_show" },
    { consultation: CONSULTATION, outcome: "both_no_show", acknowledge: "on" },
    { consultation: CONSULTATION },
  ]) {
    const w = operationsWorld({
      capabilities: [["manage_consultation_operations"]],
    });
    assert.equal(
      (await recordConsultationOutcome(w.sources, form(bad))).status,
      "invalid",
      JSON.stringify(bad),
    );
    assert.deepEqual(w.calls, []);
  }
  for (const outcome of [
    "already_decided",
    "not_applicable",
    "window_open",
    "window_unavailable",
    "evidence_conflict",
    "configuration_unavailable",
    "conflict",
  ]) {
    const w = operationsWorld({
      capabilities: [["manage_consultation_operations"]],
      answers: { record: answer(outcome) },
    });
    assert.deepEqual(
      await recordConsultationOutcome(
        w.sources,
        form({ consultation: CONSULTATION, outcome: "both_no_show" }),
      ),
      { status: "outcome", outcome },
    );
    assert.ok(!w.calls.some(([c]) => c === "drain"), outcome);
  }
});

test("S11-6. one Consultation for staff is read strictly (the evidence summary, the window basis and whether the database reports it recordable now); the offered codes follow the state only while recordable; a malformed id calls nothing and answers not found like an unknown one", async () => {
  const w = operationsWorld({
    capabilities: [["manage_consultation_operations", JURISDICTION]],
  });
  const view = await resolveStaffConsultation(w.sources, CONSULTATION);
  assert.equal(view.status, "ready");
  assert.deepEqual(view.offeredCodes, recordableCodesOf("scheduled"));
  assert.equal(view.reviewItems, false);
  assert.deepEqual(Object.keys(staffRow()), [...STAFF_CONSULTATION_COLUMNS]);
  const notNow = operationsWorld({
    capabilities: [["manage_consultation_operations"]],
    answers: { consultation: [staffRow({ recordable: false })] },
  });
  const later = await resolveStaffConsultation(notNow.sources, CONSULTATION);
  assert.deepEqual(later.offeredCodes, []);
  assert.equal(later.reviewItems, true);
  for (const bad of [
    staffRow({ window_basis: "unavailable" }),
    staffRow({ recordable: true, state: "completed", ended_at: LATER, outcome_code: "normal" }),
    staffRow({ both_present: "yes" }),
    staffRow({ extra: true }),
  ]) {
    const x = operationsWorld({
      capabilities: [["manage_consultation_operations"]],
      answers: { consultation: [bad] },
    });
    assert.equal(
      (await resolveStaffConsultation(x.sources, CONSULTATION)).status,
      "unavailable",
      JSON.stringify(bad),
    );
  }
  const unknown = operationsWorld({
    capabilities: [["manage_consultation_operations"]],
    answers: { consultation: [] },
  });
  assert.equal(
    (await resolveStaffConsultation(unknown.sources, CONSULTATION)).status,
    "not-found",
  );
  const malformed = operationsWorld({
    capabilities: [["manage_consultation_operations"]],
  });
  assert.equal(
    (await resolveStaffConsultation(malformed.sources, "nope")).status,
    "not-found",
  );
  assert.deepEqual(malformed.calls, []);
});

test("S11-7. review item families: the operations items need the global manage_consultation_operations grant and the compliance items the global manage_compliance_reviews grant; a jurisdiction-scoped grant or the other family's capability is denied and reads nothing; the family is passed to the database, which decides by the item's own family", async () => {
  const scoped = operationsWorld({
    capabilities: [["manage_consultation_operations", JURISDICTION]],
  });
  assert.equal(
    (await resolveFamilyExceptions(scoped.sources, "operations", "open", "1"))
      .status,
    "denied",
  );
  assert.deepEqual(scoped.calls, []);
  const operations = operationsWorld({
    capabilities: [["manage_consultation_operations"]],
  });
  const view = await resolveFamilyExceptions(
    operations.sources,
    "operations",
    "resolved",
    "2",
  );
  assert.equal(view.status, "ready");
  assert.deepEqual(operations.calls, [["exceptions", "operations", "resolved", 25]]);
  assert.equal(
    (await resolveFamilyExceptions(operations.sources, "compliance", "open", "1"))
      .status,
    "denied",
  );
  const compliance = operationsWorld({
    capabilities: [["manage_compliance_reviews"]],
  });
  assert.equal(
    (
      await assignFamilyException(
        compliance.sources,
        "compliance",
        form({ exception: ITEM, assign: "me" }),
      )
    ).status,
    "outcome",
  );
  assert.deepEqual(compliance.calls, [["assign", ITEM, true]]);
  assert.equal(
    (
      await assignFamilyException(
        compliance.sources,
        "operations",
        form({ exception: ITEM, assign: "me" }),
      )
    ).status,
    "denied",
  );
});

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

function reviewWorld(options = {}) {
  const calls = [];
  const state = {
    subject: SUBJECT,
    stage: "approved",
    clientReviews: rows([]),
    submit: answer("submitted"),
    moderate: answer("applied"),
    publicRows: rows([]),
    ...options,
  };
  const { clientIntake, attorney } = participants(state);
  const shared = {
    reads: async () => ({
      clientReviews: async () => state.clientReviews,
      attorneyReviews: async () => rows([]),
      queue: async (s, offset) => {
        calls.push(["queue", s, offset]);
        return rows([]);
      },
      environmentIdentity: async () => DEV,
    }),
    writes: async () => ({
      submit: async (id, rating, text) => {
        calls.push(["submit", id, rating, text]);
        return state.submit;
      },
      moderate: async (id, decision) => {
        calls.push(["moderate", id, decision]);
        return state.moderate;
      },
    }),
    environment: () => ({
      configuredClass: "development",
      expectedProjectRef: null,
    }),
  };
  return {
    client: { ...shared, clientIntake },
    attorney: { ...shared, ...attorney },
    publicSources: {
      reads: async () => ({
        attorneyReviews: async (id) => {
          calls.push(["public", id]);
          return state.publicRows;
        },
      }),
    },
    calls,
  };
}

test("S11-8. a review submission names only the Consultation, a rating 1 to 5 and optional text (blank becomes none, at most 20,000 characters); the attorney is never sent; every database outcome maps to a fixed state and not_eligible covers everyone else alike", async () => {
  const w = reviewWorld();
  assert.deepEqual(
    await submitClientReview(
      w.client,
      form({ consultation: CONSULTATION, rating: "4", text: "  " }),
    ),
    { status: "outcome", outcome: "review_submitted" },
  );
  assert.deepEqual(w.calls, [["submit", CONSULTATION, 4, null]]);
  const withText = reviewWorld();
  await submitClientReview(
    withText.client,
    form({ consultation: CONSULTATION, rating: "5", text: " Helpful. " }),
  );
  assert.deepEqual(withText.calls, [["submit", CONSULTATION, 5, "Helpful."]]);
  for (const bad of [
    { consultation: CONSULTATION, rating: "0" },
    { consultation: CONSULTATION, rating: "6" },
    { consultation: CONSULTATION, rating: "4.5" },
    { consultation: CONSULTATION, rating: "4", text: "x".repeat(20001) },
    { consultation: "x", rating: "4" },
    { consultation: CONSULTATION, rating: ["4", "5"] },
  ]) {
    const x = reviewWorld();
    assert.equal(
      (await submitClientReview(x.client, form(bad))).status,
      "invalid",
    );
    assert.deepEqual(x.calls, []);
  }
  for (const [outcome, mapped] of [
    ["not_eligible", "not_eligible"],
    ["already_reviewed", "already_reviewed"],
  ]) {
    const x = reviewWorld({ submit: answer(outcome) });
    assert.deepEqual(
      await submitClientReview(
        x.client,
        form({ consultation: CONSULTATION, rating: "3" }),
      ),
      { status: "outcome", outcome: mapped },
    );
  }
  const source = codeOf(read("app/client/reviews/forms.tsx"));
  assert.doesNotMatch(source, /attorney/i);
});

test("S11-9. the client's reviewable Consultations are read strictly: a completed Consultation with no review carries no review fields at all; a review carries its rating, text and state consistently; anything else is unavailable", async () => {
  const none = {
    consultation_id: CONSULTATION,
    consultation_ended_at: T,
    review_id: null,
    rating: null,
    review_text: null,
    state: null,
    submitted_at: null,
    published_at: null,
    moderated_at: null,
  };
  const reviewed = {
    ...none,
    consultation_id: OTHER,
    review_id: REVIEW,
    rating: 5,
    review_text: "Synthetic.",
    state: "published",
    submitted_at: T,
    published_at: LATER,
    moderated_at: LATER,
  };
  const view = await resolveClientReviews(
    reviewWorld({ clientReviews: rows([none, reviewed]) }).client,
  );
  assert.equal(view.status, "ready");
  assert.equal(view.consultations[0].review, null);
  assert.equal(view.consultations[1].review.state, "published");
  for (const bad of [
    { ...none, rating: 3 },
    { ...reviewed, rating: 6 },
    { ...reviewed, state: "published", published_at: null },
    { ...reviewed, review_text: "   " },
    { ...reviewed, extra: 1 },
  ]) {
    assert.equal(
      (await resolveClientReviews(reviewWorld({ clientReviews: rows([bad]) }).client))
        .status,
      "unavailable",
    );
  }
});

test("S11-10. moderation needs moderate_reviews in some scope and names only the review and publish or reject; the public read shows only published rating, text and date with the count and average the database computed, none for a malformed id, and nothing when the answer is inconsistent", async () => {
  const world = createWorld();
  const staff = addStaff(world, 7);
  const w = reviewWorld();
  const moderation = { ...w.client, staff: configurationSources(world, staff.authId) };
  assert.equal(
    (await moderateReview(moderation, form({ review: REVIEW, decision: "publish" })))
      .status,
    "denied",
  );
  grant(world, staff.userId, "moderate_reviews", { jurisdiction_id: JURISDICTION });
  assert.deepEqual(
    await moderateReview(moderation, form({ review: REVIEW, decision: "reject" })),
    { status: "outcome", outcome: "applied" },
  );
  assert.equal(
    (await moderateReview(moderation, form({ review: REVIEW, decision: "take_down" })))
      .status,
    "invalid",
  );
  const publicRow = (overrides = {}) => ({
    rating: 4,
    review_text: "Synthetic.",
    published_at: T,
    review_count: 2,
    average_rating: "4.50",
    ...overrides,
  });
  const ok = reviewWorld({
    publicRows: rows([publicRow(), publicRow({ rating: 5, review_text: null })]),
  });
  const reviews = await resolvePublicReviews(ok.publicSources, CONSULTATION);
  assert.equal(reviews.count, 2);
  assert.equal(reviews.average, 4.5);
  assert.deepEqual(
    reviews.reviews.map((r) => [r.rating, r.text]),
    [
      [4, "Synthetic."],
      [5, null],
    ],
  );
  assert.deepEqual(
    await resolvePublicReviews(ok.publicSources, "not-an-id"),
    { reviews: [], count: 0, average: null },
  );
  for (const bad of [
    [publicRow(), publicRow({ review_count: 3 })],
    [publicRow({ review_count: 0 })],
    [publicRow({ average_rating: "9" })],
    [publicRow({ client: "x" })],
  ]) {
    assert.equal(
      await resolvePublicReviews(reviewWorld({ publicRows: rows(bad) }).publicSources, CONSULTATION),
      null,
    );
  }
});

// ---------------------------------------------------------------------------
// Complaints and Legal Holds
// ---------------------------------------------------------------------------

function complaintWorld(options = {}) {
  const calls = [];
  const state = {
    subject: SUBJECT,
    stage: "approved",
    mine: rows([]),
    open: answer("opened"),
    update: answer("applied"),
    classify: answer("configuration_unavailable"),
    ...options,
  };
  const { clientIntake } = participants(state);
  const world = createWorld();
  const staff = addStaff(world, 7);
  const shared = {
    reads: async () => ({
      mine: async () => state.mine,
      queue: async () => rows([]),
      complaintCase: async () => rows([]),
      environmentIdentity: async () => DEV,
    }),
    writes: async () => ({
      // MVP-001 S11 PS-A6 section 5: and the optional statement, recorded
      // when the form carries one.
      open: async (c, r, statement) => {
        calls.push(
          statement === null || statement === undefined
            ? ["open", c, r]
            : ["open", c, r, statement],
        );
        return state.open;
      },
      update: async (id, action) => {
        calls.push(["update", id, action]);
        return state.update;
      },
      classify: async (id, code) => {
        calls.push(["classify", id, code]);
        return state.classify;
      },
      resolve: async (id, code) => {
        calls.push(["resolve", id, code]);
        return state.classify;
      },
    }),
    environment: () => ({
      configuredClass: "development",
      expectedProjectRef: null,
    }),
  };
  return {
    client: { ...shared, clientIntake },
    staff: { ...shared, staff: configurationSources(world, staff.authId) },
    grantStaff: (capability, overrides) =>
      grant(world, staff.userId, capability, overrides),
    calls,
  };
}

test("S11-11. a client reports a problem about none or one of their own Consultations (the complainant is always the caller and no Referral is sent from this form); outcomes are fixed; the complainant's list is read strictly", async () => {
  const w = complaintWorld();
  assert.deepEqual(await openClientComplaint(w.client, form({ consultation: "" })), {
    status: "outcome",
    outcome: "complaint_opened",
  });
  assert.deepEqual(
    await openClientComplaint(w.client, form({ consultation: CONSULTATION })),
    { status: "outcome", outcome: "complaint_opened" },
  );
  assert.deepEqual(w.calls, [
    ["open", null, null],
    ["open", CONSULTATION, null],
  ]);
  assert.deepEqual(
    await openClientComplaint(
      complaintWorld({ open: answer("already_open") }).client,
      form({}),
    ),
    { status: "outcome", outcome: "already_open" },
  );
  const bad = complaintWorld();
  assert.equal(
    (await openClientComplaint(bad.client, form({ consultation: "x" }))).status,
    "invalid",
  );
  assert.deepEqual(bad.calls, []);
  // MVP-001 S11 PS-A6 section 5: the optional statement is trimmed and sent
  // (an empty one is none); one longer than 20,000 characters or carrying a
  // control character is invalid and nothing is sent.
  const stated = complaintWorld();
  assert.deepEqual(
    await openClientComplaint(
      stated.client,
      form({ consultation: "", statement: "  Synthetic statement  " }),
    ),
    { status: "outcome", outcome: "complaint_opened" },
  );
  await openClientComplaint(stated.client, form({ statement: "   " }));
  assert.deepEqual(stated.calls, [
    ["open", null, null, "Synthetic statement"],
    ["open", null, null],
  ]);
  for (const statement of ["x".repeat(20001), "a\u0001b"]) {
    const refused = complaintWorld();
    assert.equal(
      (await openClientComplaint(refused.client, form({ statement }))).status,
      "invalid",
    );
    assert.deepEqual(refused.calls, []);
  }
  // MVP-001 S11 PS-A6 section 5 re-pin: the complainant's own row carries
  // their statement (none here).
  const own = {
    complaint_case_id: CASE,
    state: "opened",
    consultation_id: CONSULTATION,
    referral_id: null,
    opened_at: T,
    resolved_at: null,
    statement: null,
  };
  assert.equal(
    (await resolveClientComplaints(complaintWorld({ mine: rows([own]) }).client))
      .status,
    "ready",
  );
  assert.equal(
    (
      await resolveClientComplaints(
        complaintWorld({ mine: rows([{ ...own, statement: "Synthetic" }]) })
          .client,
      )
    ).status,
    "ready",
  );
  for (const row of [
    { ...own, state: "resolved" },
    { ...own, assigned_to_user_id: USER },
    { ...own, state: "closed" },
    // MVP-001 S11 PS-A6: a blank or missing statement is not a statement.
    { ...own, statement: "  " },
    (({ statement, ...rest }) => rest)(own),
  ]) {
    assert.equal(
      (await resolveClientComplaints(complaintWorld({ mine: rows([row]) }).client))
        .status,
      "unavailable",
    );
  }
});

test("S11-12. complaint staff steps need manage_complaints; the step is one of assign, unassign, escalate or return_to_review; classification and resolution pass the database's configuration_unavailable on unchanged (the vocabularies are not adopted)", async () => {
  const w = complaintWorld();
  assert.equal(
    (await updateComplaintCase(w.staff, form({ case: CASE, action: "assign" })))
      .status,
    "denied",
  );
  w.grantStaff("manage_complaints", { jurisdiction_id: JURISDICTION });
  assert.deepEqual(
    await updateComplaintCase(w.staff, form({ case: CASE, action: "escalate" })),
    { status: "outcome", outcome: "applied" },
  );
  assert.equal(
    (await updateComplaintCase(w.staff, form({ case: CASE, action: "resolve" })))
      .status,
    "invalid",
  );
  assert.deepEqual(
    await classifyComplaintCase(w.staff, form({ case: CASE, code: "billing" })),
    { status: "outcome", outcome: "configuration_unavailable" },
  );
  assert.equal(
    (await classifyComplaintCase(w.staff, form({ case: CASE, code: "Not A Code" })))
      .status,
    "invalid",
  );
  assert.deepEqual(w.calls, [
    ["update", CASE, "escalate"],
    ["classify", CASE, "billing"],
  ]);
});

test("S11-13. Legal Holds need the global manage_legal_holds grant (a jurisdiction-scoped grant is denied); placing names one of the five scopes, an identifier and a reason of 1 to 2,000 characters; releasing names one hold; the list is read strictly", async () => {
  const world = createWorld();
  const staff = addStaff(world, 7);
  const calls = [];
  const holdRow = {
    legal_hold_id: HOLD,
    scope_type: "complaint_case",
    scope_id: CASE,
    status: "active",
    reason: "Synthetic reason.",
    started_at: T,
    released_at: null,
    placed_by_me: true,
  };
  const sources = {
    staff: configurationSources(world, staff.authId),
    reads: async () => ({
      list: async (status, offset) => {
        calls.push(["list", status, offset]);
        return rows([holdRow]);
      },
      environmentIdentity: async () => DEV,
    }),
    writes: async () => ({
      place: async (scope, id, reason) => {
        calls.push(["place", scope, id, reason]);
        return answer("placed");
      },
      release: async (id) => {
        calls.push(["release", id]);
        return answer("already_released");
      },
    }),
    environment: () => ({
      configuredClass: "development",
      expectedProjectRef: null,
    }),
  };
  grant(world, staff.userId, "manage_legal_holds", { jurisdiction_id: JURISDICTION });
  assert.equal(
    (await resolveLegalHolds(sources, "active", "1")).status,
    "denied",
  );
  assert.deepEqual(calls, []);
  grant(world, staff.userId, "manage_legal_holds");
  assert.equal((await resolveLegalHolds(sources, "active", "1")).status, "ready");
  assert.deepEqual(
    await placeLegalHold(
      sources,
      form({ scope: "complaint_case", scope_id: CASE, reason: " Synthetic. " }),
    ),
    { status: "outcome", outcome: "hold_placed" },
  );
  assert.deepEqual(
    await releaseLegalHold(sources, form({ hold: HOLD })),
    { status: "outcome", outcome: "already_released" },
  );
  for (const bad of [
    { scope: "payment", scope_id: CASE, reason: "x" },
    { scope: "user", scope_id: "x", reason: "x" },
    { scope: "user", scope_id: CASE, reason: " " },
    { scope: "user", scope_id: CASE, reason: "x".repeat(2001) },
  ]) {
    assert.equal(
      (await placeLegalHold(sources, form(bad))).status,
      "invalid",
      JSON.stringify(bad),
    );
  }
  assert.deepEqual(
    calls.filter(([c]) => c !== "list"),
    [
      ["place", "complaint_case", CASE, "Synthetic."],
      ["release", HOLD],
    ],
  );
});

// ---------------------------------------------------------------------------
// The adapter's answers
// ---------------------------------------------------------------------------

test("S11-14. the adapter reads each command's answer strictly: exactly its row's keys, a known outcome, the success's identifier or instant exactly with the success, plain values only; a database rejection is rejected, anything else unreadable; malformed identifiers are refused before anything is sent", async () => {
  const ok = { data: [{ outcome: "cancelled", problem: null, cancelled_at: T }], error: null };
  assert.deepEqual(
    rowAnswerOf(ok, ["problem", "cancelled_at"], ["cancelled", "ended"], "cancelled", "cancelled_at"),
    { kind: "answer", outcome: "cancelled" },
  );
  for (const result of [
    { data: [{ outcome: "cancelled", problem: null, cancelled_at: null }], error: null },
    { data: [{ outcome: "ended", problem: "live", cancelled_at: T }], error: null },
    { data: [{ outcome: "unknown", problem: null, cancelled_at: null }], error: null },
    { data: [{ outcome: "ended", problem: "Has Spaces", cancelled_at: null }], error: null },
    { data: [{ outcome: "ended", problem: null, cancelled_at: null, extra: 1 }], error: null },
    { data: [], error: null },
  ]) {
    assert.equal(
      rowAnswerOf(result, ["problem", "cancelled_at"], ["cancelled", "ended"], "cancelled", "cancelled_at").kind,
      "unreadable",
      JSON.stringify(result),
    );
  }
  assert.deepEqual(
    rowAnswerOf(
      { data: null, error: { code: "23514" }, status: 400 },
      ["problem", "cancelled_at"],
      ["cancelled"],
      "cancelled",
      "cancelled_at",
    ),
    { kind: "rejected" },
  );
  assert.deepEqual(textAnswerOf({ data: "applied", error: null }, ["applied"]), {
    kind: "answer",
    outcome: "applied",
  });
  assert.equal(textAnswerOf({ data: "other", error: null }, ["applied"]).kind, "unreadable");
  let sent = 0;
  const client = {
    rpc: async () => {
      sent += 1;
      return { data: null, error: null };
    },
  };
  const writes = await createParticipantOutcomeWrites(async () => client, 1000)();
  assert.equal((await writes.cancel("not-an-id")).kind, "rejected");
  const holds = await createLegalHoldWrites(async () => client, 1000)();
  assert.equal((await holds.place("payment", CASE, "x")).kind, "rejected");
  assert.equal((await holds.place("user", CASE, " ")).kind, "rejected");
  assert.equal(sent, 0);
});

// ---------------------------------------------------------------------------
// Labels and routes
// ---------------------------------------------------------------------------

test("S11-15. every action outcome has a fixed message; nothing promises a refund or a charge, names the room provider, recommends anyone or claims a regulatory status", () => {
  const tables = [
    labels.CANCEL_MESSAGES,
    labels.END_EARLY_MESSAGES,
    labels.RECORD_MESSAGES,
    labels.REVIEW_ITEM_MESSAGES,
    labels.SUBMIT_MESSAGES,
    labels.MODERATE_MESSAGES,
    labels.OPEN_MESSAGES,
    labels.CASE_MESSAGES,
    labels.HOLD_MESSAGES,
  ];
  const text = JSON.stringify([
    ...tables,
    labels.OUTCOME_LABELS,
    labels.STAFF_OUTCOME_LABELS,
    labels.CANCEL_NOTE,
    labels.END_EARLY_NOTE,
    labels.REVIEW_NOTE,
    labels.COMPLAINT_NOTE,
    labels.HOLD_NOTE,
    labels.PUBLIC_REVIEWS_NOTE,
  ]);
  assert.doesNotMatch(
    text,
    /will be refunded|you will be charged|refund is due|daily|recommend|best attorney|approved by|licensed by|regulator/i,
  );
  for (const table of tables) {
    for (const message of Object.values(table)) {
      assert.ok(message.title.length > 0 && message.body.length > 0);
      assert.ok(["success", "warning", "error", "information", "neutral"].includes(message.tone));
    }
  }
  assert.equal(labels.messageOf({ status: "idle" }, labels.CANCEL_MESSAGES), null);
  assert.equal(
    labels.messageOf({ status: "step-up-required" }, labels.CANCEL_MESSAGES).title,
    "Confirm your sign-in",
  );
  // MVP-001 S11 correction pass (R2 and A7): the refusal after the scheduled
  // time has its own fixed message, and the confirmation step's wording is
  // fixed and neutral.
  assert.deepEqual(
    labels.messageOf({ status: "outcome", outcome: "time_passed" }, labels.CANCEL_MESSAGES),
    {
      tone: "warning",
      title: "The scheduled time has passed",
      body: "This consultation can no longer be cancelled. Rosuno staff record what happened. Nothing was changed.",
    },
  );
  assert.deepEqual(
    [labels.CANCEL_LABEL, labels.CANCEL_CONFIRM_PROMPT, labels.CANCEL_CONFIRM_LABEL, labels.CANCEL_KEEP_LABEL],
    [
      "Cancel the consultation",
      "Please confirm that you want to cancel this consultation.",
      "Confirm the cancellation",
      "Keep the consultation",
    ],
  );
});

test("S11-16. the new participant pages are server pages rendered per request and unindexed; the attorney pages ask the step-up gate first; the forms are client modules that post only through their own actions; no page reads a cookie, a header or the environment; the RPC calls live only in the completion adapter", () => {
  const pages = [
    "app/client/consultations/page.tsx",
    "app/client/reviews/page.tsx",
    "app/client/complaints/page.tsx",
    "app/attorney/reviews/page.tsx",
    "app/attorney/complaints/page.tsx",
  ];
  for (const file of pages) {
    const source = read(file);
    const code = codeOf(source);
    assert.doesNotMatch(source, /["']use (?:client|server)["']/, file);
    assert.match(code, /robots: \{ index: false, follow: false \},/, file);
    assert.ok(code.indexOf("await connection();") > 0, file);
    assert.doesNotMatch(code, /headers\(|cookies\(|process\.env|\.rpc\(|dangerouslySetInnerHTML/, file);
  }
  for (const file of [
    "app/client/reviews/forms.tsx",
    "app/client/complaints/forms.tsx",
    "app/attorney/complaints/forms.tsx",
  ]) {
    assert.match(read(file), /^"use client";\n/, file);
    assert.doesNotMatch(codeOf(read(file)), /infrastructure|\.rpc\(/, file);
  }
  const rpcFiles = [...filesIn("app/"), ...filesIn("src/")].filter((f) =>
    /client\.rpc\("(?:consultation_cancel|review_submit|complaint_open|staff_place_legal_hold)"/.test(
      read(f),
    ),
  );
  assert.deepEqual(rpcFiles, [
    "src/infrastructure/consultations/completion-adapter.ts",
  ]);
  // The client's and the attorney's consultation pages offer the new
  // controls; the public profile reads the published reviews through the
  // public sources only.
  assert.match(read("app/client/consultations/[consultation]/page.tsx"), /<CancelPanel\s+consultationId=\{record\.id\}\s+cancellable=\{cancellable\(record\.state\)\}\s+\/>/);
  assert.match(read("app/attorney/consultations/[consultation]/page.tsx"), /<CompletionPanel/);
  assert.match(
    read("app/attorneys/[attorney]/page.tsx"),
    /resolvePublicReviews\(PUBLIC_REVIEW_SOURCES, attorney\)/,
  );
});
