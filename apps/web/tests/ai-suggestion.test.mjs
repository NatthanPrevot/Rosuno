// MVP-001 S3 part 2: AI suggestions, the routing category, the suggestion
// decision and the post-submission change seam, driven through fake ports.
// Every id and value is synthetic test data; nothing here contacts a
// provider, network, or database.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  INITIAL_SUGGESTION_STATE,
  isRecordInput,
  PROVIDER_UNAVAILABLE,
  recordAnswerOf,
  requestIntakeSuggestions,
} from "../src/application/ai-suggestion.ts";
import {
  decideSuggestion,
  requestIntakeChange,
  resolveIntake,
  saveIntakeRevision,
  submitIntake,
} from "../src/application/client-intake.ts";
import { INTAKE_SUGGESTION_PROVIDER } from "../src/infrastructure/ai/intake-suggestion-provider.ts";
import { createAiSuggestionRecorder } from "../src/infrastructure/identity/registration-provisioning.ts";
import {
  boundedProvider,
  boundedRecorder,
} from "../src/infrastructure/client/intake-suggestion-adapter.ts";

const V1 = JSON.parse(
  readFileSync(
    new URL("./fixtures/intake-questions-v1.canonical.txt", import.meta.url),
    "utf8",
  ),
);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ACCOUNT = id(101);
const USER = id(201);
const CLIENT = id(301);
const INTAKE = id(401);
const SUBMITTED = id(402);
const EXPIRED = id(403);
const V1_ID = id(501);
const AREA = id(601);
const AREA_OTHER = id(602);
const AREA_OFF = id(603);
const J_A = id(701);
const J_B = id(702);
const S1 = id(801);
const S2 = id(802);
const S3 = id(803);
const T = (minute) =>
  `2026-11-17T10:${String(minute).padStart(2, "0")}:00+00:00`;
const NOW = Date.parse("2026-11-17T10:30:00Z");

const rows = (list) => ({ kind: "rows", rows: list });
const answer = (outcome, value = null) => ({ kind: "answer", outcome, value });

function revision(intake, n, fields = {}) {
  return {
    intake_id: intake,
    revision_number: n,
    question_set_id: V1_ID,
    practice_area_id: null,
    description: "Synthetic words of the client.",
    structured_answers: {
      practice_area: "not_sure",
      jurisdictions: "not_sure",
      court_case: "no",
      assistance_type: "understand_options",
    },
    created_at: T(10 + n),
    ...fields,
  };
}

function suggestion(n, type, value, fields = {}) {
  return {
    id: n,
    suggestion_type: type,
    suggestion_value: value,
    model_reference: "synthetic-model:1",
    generated_at: T(20),
    presented_at: T(20),
    confirmed_at: null,
    rejected_at: null,
    ...fields,
  };
}

function harness(overrides = {}) {
  const calls = [];
  const state = {
    contexts: ["client"],
    intakes: [
      { id: INTAKE, client_id: CLIENT, state: "draft", created_at: T(1), closed_at: null },
      { id: SUBMITTED, client_id: CLIENT, state: "submitted", created_at: T(2), closed_at: null },
      { id: EXPIRED, client_id: CLIENT, state: "expired", created_at: T(3), closed_at: null },
    ],
    revisions: [revision(INTAKE, 1), revision(SUBMITTED, 1), revision(EXPIRED, 1)],
    areas: [
      { id: AREA, code: "SYN_FAMILY", name: "Synthetic Family", active: true },
      { id: AREA_OTHER, code: "SYN_HOUSING", name: "Synthetic Housing", active: true },
      { id: AREA_OFF, code: "SYN_RETIRED", name: "Synthetic Retired", active: false },
    ],
    jurisdictions: [
      { id: J_A, code: "SYN_A", name: "Synthetic State A" },
      { id: J_B, code: "SYN_B", name: "Synthetic State B" },
    ],
    assessments: [],
    suggestions: [],
    provider: { suggest: async () => PROVIDER_UNAVAILABLE },
    providerAvailable: true,
    recorderAvailable: true,
    record: (input) => ({ kind: "recorded", suggestionId: id(900 + calls.length) }),
    answers: {
      save: answer("saved", 2),
      submit: answer("submitted"),
      decide: answer("confirmed"),
      change: answer("not_configured"),
    },
    ...overrides,
  };
  const sources = {
    session: { currentSubject: async () => ACCOUNT },
    contexts: { contextsOf: async () => state.contexts },
    account: {
      currentAccount: async () => ({
        kind: "user",
        id: ACCOUNT,
        emailConfirmedAt: "2026-11-01T00:00:00Z",
      }),
    },
    reads: async () => ({
      usersOf: async (a) =>
        rows(a === ACCOUNT ? [{ id: USER, auth_user_id: ACCOUNT, account_state: "active" }] : []),
      clientProfilesOf: async (u) => rows(u === USER ? [{ id: CLIENT, user_id: USER }] : []),
      intakesOf: async () => rows(state.intakes),
      intakeOf: async (c, intake) =>
        rows(state.intakes.filter((i) => i.client_id === c && i.id === intake)),
      latestRevisionSummaryOf: async () => rows([]),
      latestRevisionOf: async (intake) =>
        rows(
          state.revisions
            .filter((r) => r.intake_id === intake)
            .sort((a, b) => b.revision_number - a.revision_number)
            .slice(0, 1),
        ),
      questionSets: async () =>
        rows([{ id: V1_ID, version_key: "intake-questions-v1", definition: V1, published_at: T(0) }]),
      assessmentsOf: async () => rows(state.assessments),
      practiceAreas: async () => rows(state.areas),
      jurisdictions: async () => rows(state.jurisdictions),
      suggestionsOf: async () => rows(state.suggestions),
    }),
    writes: async () => ({
      createIntake: async () => answer("created", id(499)),
      saveRevision: async (input) => {
        calls.push(["save", input]);
        return state.answers.save;
      },
      submitIntake: async (intake, expected) => {
        calls.push(["submit", intake, expected]);
        return state.answers.submit;
      },
      closeIntake: async () => answer("closed"),
      decideSuggestion: async (suggestionId, decision) => {
        calls.push(["decide", suggestionId, decision]);
        return state.answers.decide;
      },
      requestChange: async (intake, change) => {
        calls.push(["change", intake, change]);
        return state.answers.change;
      },
    }),
    provider: () => {
      calls.push(["provider"]);
      return state.providerAvailable ? state.provider : null;
    },
    recorder: async () => {
      calls.push(["recorder"]);
      return state.recorderAvailable
        ? {
            record: async (input) => {
              calls.push(["record", input]);
              return state.record(input);
            },
          }
        : null;
    },
    clock: () => NOW,
  };
  return { sources, calls, state };
}

function form(fields) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      data.append(name, entry);
    }
  }
  return data;
}

const ASK = { intake: INTAKE, expected_revision: "1" };

function suggesting(items, modelReference = "synthetic-model:1") {
  const requests = [];
  return {
    requests,
    provider: {
      suggest: async (request) => {
        requests.push(request);
        return { kind: "suggestions", modelReference, items };
      },
    },
  };
}

test("AI-1. with the production provider unavailable, a request presents nothing and records nothing, and the intake workflow stays fully usable", async () => {
  const h = harness({ provider: INTAKE_SUGGESTION_PROVIDER });
  assert.deepEqual(INITIAL_SUGGESTION_STATE, { status: "idle" });
  assert.deepEqual(
    await requestIntakeSuggestions(h.sources, form(ASK)),
    { status: "ai-unavailable" },
  );
  assert.deepEqual(
    h.calls.filter(([name]) => name !== "provider"),
    [],
  );
  // No provider configured at all, or a provider that throws or answers
  // malformed content: the same, and the recorder is never built.
  for (const state of [
    { providerAvailable: false },
    { provider: { suggest: async () => { throw new Error("synthetic"); } } },
    { provider: { suggest: async () => ({ kind: "suggestions", modelReference: "bad ref", items: [] }) } },
    { provider: { suggest: async () => ({ kind: "suggestions", modelReference: "m:1", items: "x" }) } },
    { provider: { suggest: async () => null } },
  ]) {
    const other = harness(state);
    assert.deepEqual(
      await requestIntakeSuggestions(other.sources, form(ASK)),
      { status: "ai-unavailable" },
    );
    assert.equal(other.calls.some(([name]) => name === "recorder" || name === "record"), false);
  }
  // The client saves and submits exactly as without AI.
  const save = await saveIntakeRevision(
    h.sources,
    form({
      intake: INTAKE,
      expected_revision: "1",
      version: "governing",
      "q:practice_area": AREA,
      "q:jurisdictions": [J_A],
      "q:court_case": "no",
      "q:assistance_type": "understand_options",
    }),
  );
  assert.deepEqual(save, { status: "saved", revision: 2 });
  assert.deepEqual(
    await submitIntake(h.sources, form({ intake: INTAKE, expected_revision: "1" })),
    { status: "submitted" },
  );
  // The production provider reads no configuration and makes no call.
  const source = readFileSync(
    new URL("../src/infrastructure/ai/intake-suggestion-provider.ts", import.meta.url),
    "utf8",
  ).replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(source, /\bfetch\b|process\.env|https?:|createHash|require\(|import\(|key|token/i);
  assert.deepEqual(await INTAKE_SUGGESTION_PROVIDER.suggest({}), { kind: "unavailable" });
});

test("AI-2. presented-only persistence: only permitted, catalog-valid items reach the recording port, each once, with the server's time and the model reference; everything else is discarded and never stored", async () => {
  const { provider, requests } = suggesting([
    { type: "practice_category", practiceAreaId: AREA },
    { type: "potentially_relevant_jurisdictions", jurisdictionIds: [J_A, J_B] },
    // Discarded: a second item of a class, an unknown class, and malformed
    // items.
    { type: "practice_category", practiceAreaId: AREA_OTHER },
    { type: "best_attorney", attorneyId: id(1) },
    { type: "practice_category", practiceAreaId: AREA, rank: 1 },
  ]);
  const h = harness({ provider });
  const state = await requestIntakeSuggestions(h.sources, form(ASK));
  assert.deepEqual(state, { status: "suggested", count: 2 });
  const records = h.calls.filter(([name]) => name === "record").map(([, input]) => input);
  assert.deepEqual(records, [
    {
      userId: USER,
      intakeId: INTAKE,
      revisionNumber: 1,
      type: "practice_category",
      value: { practice_area_id: AREA },
      modelReference: "synthetic-model:1",
      generatedAt: new Date(NOW).toISOString(),
    },
    {
      userId: USER,
      intakeId: INTAKE,
      revisionNumber: 1,
      type: "potentially_relevant_jurisdictions",
      value: { jurisdiction_ids: [J_A, J_B] },
      modelReference: "synthetic-model:1",
      generatedAt: new Date(NOW).toISOString(),
    },
  ]);
  for (const input of records) {
    assert.ok(isRecordInput(input));
  }
  // The provider receives the client's own statements and the catalogs it
  // may name: no account, User, client, or Intake identity, and only active
  // practice areas.
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.deepEqual(Object.keys(request).sort(), [
    "answers",
    "classes",
    "description",
    "jurisdictions",
    "practiceAreas",
  ]);
  assert.deepEqual(request.classes, [
    "practice_category",
    "potentially_relevant_jurisdictions",
  ]);
  assert.equal(request.description, "Synthetic words of the client.");
  assert.deepEqual(
    request.practiceAreas.map((a) => a.id),
    [AREA, AREA_OTHER],
  );
  const serialized = JSON.stringify(request);
  for (const identity of [ACCOUNT, USER, CLIENT, INTAKE]) {
    assert.equal(serialized.includes(identity), false, identity);
  }
  // Items naming an inactive or unknown entry, or too many places, are
  // discarded: nothing is recorded.
  for (const items of [
    [{ type: "practice_category", practiceAreaId: AREA_OFF }],
    [{ type: "practice_category", practiceAreaId: id(9) }],
    [{ type: "potentially_relevant_jurisdictions", jurisdictionIds: [id(9)] }],
    [{ type: "potentially_relevant_jurisdictions", jurisdictionIds: [J_A, J_A] }],
    [{ type: "potentially_relevant_jurisdictions", jurisdictionIds: [] }],
    [{ type: "potentially_relevant_jurisdictions", jurisdictionIds: Array.from({ length: 11 }, (_, n) => id(1000 + n)) }],
    [],
  ]) {
    const other = harness({ provider: suggesting(items).provider });
    assert.deepEqual(
      await requestIntakeSuggestions(other.sources, form(ASK)),
      { status: "no-suggestion" },
    );
    assert.equal(other.calls.some(([name]) => name === "record"), false);
  }
});

test("AI-3. nothing is presented that the database did not record: no recording port, a refusal, or an unknown answer is reported as such", async () => {
  const items = [{ type: "practice_category", practiceAreaId: AREA }];
  const cases = [
    [{ recorderAvailable: false }, { status: "ai-unavailable" }],
    [{ record: () => ({ kind: "refused", outcome: "stale" }) }, { status: "conflict" }],
    [{ record: () => ({ kind: "refused", outcome: "not_editable" }) }, { status: "not-editable" }],
    [{ record: () => ({ kind: "refused", outcome: "rate_limited" }) }, { status: "rate-limited" }],
    [{ record: () => ({ kind: "refused", outcome: "not_found" }) }, { status: "not-found" }],
    [{ record: () => ({ kind: "refused", outcome: "invalid" }) }, { status: "no-suggestion" }],
    [{ record: () => ({ kind: "unknown" }) }, { status: "outcome-unknown" }],
    [{ record: () => ({ kind: "recorded", suggestionId: "not-an-id" }) }, { status: "outcome-unknown" }],
    [{ record: () => { throw new Error("synthetic"); } }, { status: "outcome-unknown" }],
  ];
  for (const [overrides, expected] of cases) {
    const h = harness({ provider: suggesting(items).provider, ...overrides });
    assert.deepEqual(await requestIntakeSuggestions(h.sources, form(ASK)), expected);
  }
  // The strict reader of the recording function's one row.
  assert.deepEqual(recordAnswerOf([{ outcome: "recorded", suggestion_id: S1 }]), {
    kind: "recorded",
    suggestionId: S1,
  });
  assert.deepEqual(recordAnswerOf([{ outcome: "stale", suggestion_id: null }]), {
    kind: "refused",
    outcome: "stale",
  });
  for (const data of [
    [],
    [{ outcome: "recorded", suggestion_id: null }],
    [{ outcome: "stale", suggestion_id: S1 }],
    [{ outcome: "presented", suggestion_id: null }],
    [{ outcome: "recorded", suggestion_id: S1, extra: 1 }],
    [{ outcome: "recorded", suggestion_id: S1 }, { outcome: "recorded", suggestion_id: S2 }],
    null,
    "recorded",
  ]) {
    assert.deepEqual(recordAnswerOf(data), { kind: "unknown" }, JSON.stringify(data));
  }
  // The privileged call's arguments are checked against the database's own
  // bounds before anything can be sent.
  const valid = {
    userId: USER,
    intakeId: INTAKE,
    revisionNumber: 1,
    type: "practice_category",
    value: { practice_area_id: AREA },
    modelReference: "synthetic-model:1",
    generatedAt: new Date(NOW).toISOString(),
  };
  assert.ok(isRecordInput(valid));
  for (const change of [
    { userId: "x" },
    { revisionNumber: 0 },
    { type: "best_match" },
    { value: { practice_area_id: AREA, rank: 1 } },
    { value: { jurisdiction_ids: [J_A] } },
    { type: "potentially_relevant_jurisdictions", value: { jurisdiction_ids: [J_A, J_A] } },
    { modelReference: "a b" },
    { generatedAt: "yesterday" },
    { extra: true },
  ]) {
    assert.equal(isRecordInput({ ...valid, ...change }), false, JSON.stringify(change));
  }
});

test("AI-4. a request is refused before any provider call when the Intake is not the client's own draft at the revision the page showed, or the caller is not a signed-in client", async () => {
  const items = [{ type: "practice_category", practiceAreaId: AREA }];
  const cases = [
    [{ intake: SUBMITTED, expected_revision: "1" }, {}, { status: "not-editable" }],
    [{ intake: EXPIRED, expected_revision: "1" }, {}, { status: "not-editable" }],
    [{ intake: id(499), expected_revision: "1" }, {}, { status: "not-found" }],
    [{ intake: "nope", expected_revision: "1" }, {}, { status: "not-found" }],
    [{ intake: INTAKE, expected_revision: "2" }, {}, { status: "conflict" }],
    [{ intake: INTAKE, expected_revision: "" }, {}, { status: "conflict" }],
    [{ intake: INTAKE, expected_revision: "1" }, { revisions: [] }, { status: "conflict" }],
    [{ intake: INTAKE, expected_revision: "1" }, { contexts: [] }, { status: "denied" }],
  ];
  for (const [fields, overrides, expected] of cases) {
    const h = harness({ provider: suggesting(items).provider, ...overrides });
    assert.deepEqual(
      await requestIntakeSuggestions(h.sources, form(fields)),
      expected,
      JSON.stringify(fields),
    );
    assert.equal(h.calls.some(([name]) => name === "provider" || name === "record"), false);
  }
  assert.deepEqual(await requestIntakeSuggestions(harness().sources, "x"), {
    status: "unavailable",
  });
});

test("AI-5. the provider and the recording port are bounded in time: a late or failing provider is unavailable and a late recording is unknown", async () => {
  const slow = boundedProvider({ suggest: () => new Promise(() => {}) }, 20);
  assert.deepEqual(await slow.suggest({}), { kind: "unavailable" });
  const failing = boundedProvider({ suggest: async () => { throw new Error("synthetic"); } }, 20);
  assert.deepEqual(await failing.suggest({}), { kind: "unavailable" });
  const late = boundedRecorder({ record: () => new Promise(() => {}) }, 20);
  assert.deepEqual(await late.record({}), { kind: "unknown" });
  const fine = boundedRecorder(
    { record: async () => ({ kind: "recorded", suggestionId: S1 }) },
    20,
  );
  assert.deepEqual(await fine.record({}), { kind: "recorded", suggestionId: S1 });
});

test("AI-6. the Intake view shows each presented suggestion as a suggestion with its decision, and fills in the form only from a confirmed suggestion of the saved revision; the saved content and the submitted view never change", async () => {
  const h = harness({
    suggestions: [
      suggestion(S1, "practice_category", { practice_area_id: AREA, revision_number: 1 }, {
        confirmed_at: T(21),
      }),
      suggestion(S2, "potentially_relevant_jurisdictions", {
        jurisdiction_ids: [J_A, J_B],
        revision_number: 1,
      }, { confirmed_at: T(22) }),
      suggestion(S3, "practice_category", { practice_area_id: AREA_OTHER, revision_number: 1 }),
    ],
  });
  const view = await resolveIntake(h.sources, INTAKE, false);
  assert.equal(view.status, "ready");
  assert.deepEqual(
    view.suggestions.map((s) => [s.id, s.type, s.names, s.status, s.current, s.decidable]),
    [
      [S1, "practice_category", ["Synthetic Family"], "confirmed", true, false],
      [S2, "potentially_relevant_jurisdictions", ["Synthetic State A", "Synthetic State B"], "confirmed", true, false],
      [S3, "practice_category", ["Synthetic Housing"], "pending", true, true],
    ],
  );
  assert.deepEqual(view.prefilled, ["practice_area", "jurisdictions"]);
  const area = view.questions.find((q) => q.kind === "practice_area");
  const places = view.questions.find((q) => q.kind === "jurisdictions");
  assert.equal(area.value, AREA);
  assert.deepEqual(places.values, [J_A, J_B]);
  // The saved statement and the routing category stay the client's own.
  assert.equal(view.practiceArea, "not_sure");
  assert.deepEqual(view.jurisdiction, { kind: "not_sure" });
  assert.deepEqual(view.routing, { kind: "not_sure" });
  assert.equal(view.canRequestSuggestions, true);
  assert.deepEqual(view.changes, []);
  // A suggestion made from an earlier revision, a rejected or pending one,
  // or a category no longer offered fills in nothing.
  for (const suggestions of [
    [suggestion(S1, "practice_category", { practice_area_id: AREA, revision_number: 2 }, { confirmed_at: T(21) })],
    [suggestion(S1, "practice_category", { practice_area_id: AREA, revision_number: 1 }, { rejected_at: T(21) })],
    [suggestion(S1, "practice_category", { practice_area_id: AREA, revision_number: 1 })],
    [suggestion(S1, "practice_category", { practice_area_id: AREA_OFF, revision_number: 1 }, { confirmed_at: T(21) })],
  ]) {
    const other = await resolveIntake(harness({ suggestions }).sources, INTAKE, false);
    assert.deepEqual(other.prefilled, []);
    assert.equal(other.questions.find((q) => q.kind === "practice_area").value, "not_sure");
  }
  // A malformed suggestion row makes the view unavailable rather than shown.
  for (const bad of [
    suggestion(S1, "best_attorney", { practice_area_id: AREA, revision_number: 1 }),
    suggestion(S1, "practice_category", { practice_area_id: AREA }),
    suggestion(S1, "practice_category", { practice_area_id: AREA, revision_number: 1 }, { confirmed_at: T(21), rejected_at: T(22) }),
    { ...suggestion(S1, "practice_category", { practice_area_id: AREA, revision_number: 1 }), extra: 1 },
  ]) {
    assert.deepEqual(
      await resolveIntake(harness({ suggestions: [bad] }).sources, INTAKE, false),
      { status: "unavailable" },
    );
  }
  // A submitted Intake: no prefill, no decision, and the post-submission
  // changes are offered; recorded assessments of either source are shown
  // once each.
  const submitted = harness({
    suggestions: [suggestion(S3, "practice_category", { practice_area_id: AREA, revision_number: 1 })],
    assessments: [
      { jurisdiction_id: J_A, source_type: "client_statement", review_status: "unreviewed", created_at: T(25) },
      { jurisdiction_id: J_A, source_type: "ai_suggestion", review_status: "unreviewed", created_at: T(25) },
      { jurisdiction_id: J_B, source_type: "ai_suggestion", review_status: "confirmed", created_at: T(25) },
    ],
  });
  const done = await resolveIntake(submitted.sources, SUBMITTED, false);
  assert.equal(done.editable, false);
  assert.deepEqual(done.prefilled, []);
  assert.equal(done.suggestions[0].decidable, false);
  assert.equal(done.canRequestSuggestions, false);
  assert.deepEqual(done.changes, ["revise", "replace"]);
  assert.deepEqual(done.suggestedJurisdictions, ["Synthetic State A", "Synthetic State B"]);
  const expired = await resolveIntake(harness().sources, EXPIRED, false);
  assert.deepEqual(expired.changes, ["resume"]);
});

test("AI-7. the routing category is the client's saved practice area, shown as theirs; not sure and unanswered stay unresolved and nothing is chosen", async () => {
  const cases = [
    [{ practice_area_id: AREA, structured_answers: { jurisdictions: [J_A], court_case: "no", assistance_type: "understand_options" } }, { kind: "category", name: "Synthetic Family" }],
    [{}, { kind: "not_sure" }],
    [{ structured_answers: { court_case: "no" } }, { kind: "unanswered" }],
  ];
  for (const [fields, expected] of cases) {
    const h = harness({ revisions: [revision(INTAKE, 1, fields)] });
    const view = await resolveIntake(h.sources, INTAKE, false);
    assert.deepEqual(view.routing, expected);
  }
  const fresh = harness({ revisions: [] });
  const empty = await resolveIntake(fresh.sources, INTAKE, false);
  assert.deepEqual(empty.routing, { kind: "unanswered" });
  assert.equal(empty.canRequestSuggestions, false);
});

test("AI-8. a decision confirms or rejects only a suggestion the page's own draft shows, once, through one call; it never saves Intake content", async () => {
  const shown = [suggestion(S1, "practice_category", { practice_area_id: AREA, revision_number: 1 })];
  const decide = (fields, overrides = {}) => {
    const h = harness({ suggestions: shown, ...overrides });
    return decideSuggestion(h.sources, form(fields)).then((state) => ({ state, calls: h.calls }));
  };
  const confirmed = await decide({ intake: INTAKE, suggestion: S1, decision: "confirm" });
  assert.deepEqual(confirmed.state, { status: "suggestion-confirmed" });
  assert.deepEqual(confirmed.calls, [["decide", S1, "confirm"]]);
  const rejected = await decide(
    { intake: INTAKE, suggestion: S1, decision: "reject" },
    { answers: { decide: answer("rejected") } },
  );
  assert.deepEqual(rejected.state, { status: "suggestion-rejected" });
  assert.deepEqual(rejected.calls, [["decide", S1, "reject"]]);
  for (const [outcome, status] of [
    ["already_confirmed", "already-decided"],
    ["already_rejected", "already-decided"],
    ["not_editable", "not-editable"],
    ["not_found", "not-found"],
  ]) {
    const { state } = await decide(
      { intake: INTAKE, suggestion: S1, decision: "confirm" },
      { answers: { decide: answer(outcome) } },
    );
    assert.deepEqual(state, { status }, outcome);
  }
  // An unknown answer, a refused call, or a malformed answer is never
  // reported as a decision.
  for (const [value, status] of [
    [answer("approved"), "outcome-unknown"],
    [{ kind: "rejected" }, "unavailable"],
    [{ kind: "unreadable" }, "outcome-unknown"],
  ]) {
    const { state } = await decide(
      { intake: INTAKE, suggestion: S1, decision: "confirm" },
      { answers: { decide: value } },
    );
    assert.deepEqual(state, { status });
  }
  // Refused before any write: a suggestion the Intake does not show, a
  // submitted Intake, another Intake, a malformed decision or id.
  for (const [fields, status] of [
    [{ intake: INTAKE, suggestion: S2, decision: "confirm" }, "not-found"],
    [{ intake: SUBMITTED, suggestion: S1, decision: "confirm" }, "not-editable"],
    [{ intake: id(499), suggestion: S1, decision: "confirm" }, "not-found"],
    [{ intake: INTAKE, suggestion: S1, decision: "apply" }, "not-found"],
    [{ intake: INTAKE, suggestion: "x", decision: "confirm" }, "not-found"],
    [{ intake: INTAKE, suggestion: [S1, S1], decision: "confirm" }, "not-found"],
  ]) {
    const { state, calls } = await decide(fields);
    assert.deepEqual(state, { status }, JSON.stringify(fields));
    assert.deepEqual(calls, []);
  }
});

test("AI-9. post-submission changes go to the database's change seam, which answers that they are not yet available while gate D-3 is open; nothing else is sent", async () => {
  const ask = async (fields, overrides = {}) => {
    const h = harness(overrides);
    return { state: await requestIntakeChange(h.sources, form(fields)), calls: h.calls };
  };
  for (const change of ["revise", "replace", "resume"]) {
    const { state, calls } = await ask({ intake: SUBMITTED, change });
    assert.deepEqual(state, { status: "change-not-configured" });
    assert.deepEqual(calls, [["change", SUBMITTED, change]]);
  }
  for (const [outcome, status] of [
    ["not_applicable", "change-not-applicable"],
    ["expired", "expired"],
    ["not_found", "not-found"],
    ["invalid", "unavailable"],
    ["applied", "outcome-unknown"],
  ]) {
    const { state } = await ask(
      { intake: SUBMITTED, change: "revise" },
      { answers: { change: answer(outcome) } },
    );
    assert.deepEqual(state, { status }, outcome);
  }
  for (const fields of [
    { intake: SUBMITTED, change: "supersede" },
    { intake: SUBMITTED, change: ["revise", "replace"] },
    { intake: "x", change: "revise" },
  ]) {
    const { state, calls } = await ask(fields);
    assert.deepEqual(state, { status: "not-found" });
    assert.deepEqual(calls, []);
  }
});

test("AI-10. the privileged recording port is built only from a verified binding, sends nothing for an argument outside the database's bounds, makes exactly the one literal call with exactly its named arguments, and reads its answer strictly", async () => {
  const LOCAL = "http://127.0.0.1:54321";
  const environment = (overrides = {}) => ({
    NEXT_PUBLIC_SUPABASE_URL: LOCAL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic7f3a",
    ROSUNO_SUPABASE_ADMIN_KEY: "sb_secret_synthetic7f3a",
    ROSUNO_SUPABASE_EXPECTED_PROJECT_REF: undefined,
    ROSUNO_ENVIRONMENT_CLASS: "development",
    ...overrides,
  });
  const factory = (answerOf) => {
    const made = [];
    const calls = [];
    const create = (...args) => {
      made.push(args);
      return {
        rpc: (name, params) => ({
          abortSignal: async (signal) => {
            calls.push([name, params, signal instanceof AbortSignal]);
            return answerOf(name, params);
          },
        }),
      };
    };
    return { create, made, calls };
  };
  for (const unbound of [
    environment({ ROSUNO_SUPABASE_ADMIN_KEY: undefined }),
    environment({ NEXT_PUBLIC_SUPABASE_URL: "https://example.test" }),
    environment({ ROSUNO_ENVIRONMENT_CLASS: undefined }),
  ]) {
    const f = factory(() => ({ data: null, error: null }));
    assert.equal(await createAiSuggestionRecorder(unbound, f.create), null);
    assert.deepEqual(f.made, []);
  }
  const f = factory(() => ({
    data: [{ outcome: "recorded", suggestion_id: S1 }],
    error: null,
  }));
  const recorder = await createAiSuggestionRecorder(environment(), f.create);
  assert.deepEqual(Object.keys(recorder), ["record"]);
  assert.equal(f.made.length, 1);
  assert.equal(f.made[0][1], "sb_secret_synthetic7f3a");
  const input = {
    userId: USER,
    intakeId: INTAKE,
    revisionNumber: 1,
    type: "potentially_relevant_jurisdictions",
    value: { jurisdiction_ids: [J_A, J_B] },
    modelReference: "synthetic-model:1",
    generatedAt: new Date(NOW).toISOString(),
  };
  assert.deepEqual(await recorder.record(input), {
    kind: "recorded",
    suggestionId: S1,
  });
  assert.deepEqual(f.calls, [
    [
      "ai_record_intake_suggestion",
      {
        p_user_id: USER,
        p_intake_id: INTAKE,
        p_revision_number: 1,
        p_suggestion_type: "potentially_relevant_jurisdictions",
        p_suggestion_value: { jurisdiction_ids: [J_A, J_B] },
        p_model_reference: "synthetic-model:1",
        p_generated_at: new Date(NOW).toISOString(),
      },
      true,
    ],
  ]);
  f.calls.length = 0;
  for (const bad of [
    { ...input, value: { jurisdiction_ids: [J_A], rank: 1 } },
    { ...input, type: "best_attorney" },
    { ...input, userId: "x" },
    { ...input, extra: 1 },
  ]) {
    assert.deepEqual(await recorder.record(bad), { kind: "unknown" });
  }
  assert.deepEqual(f.calls, []);
  for (const result of [
    { data: null, error: { code: "42501" } },
    { data: [{ outcome: "recorded" }], error: null },
    { data: "recorded", error: null },
  ]) {
    const g = factory(() => result);
    const r = await createAiSuggestionRecorder(environment(), g.create);
    assert.deepEqual(await r.record(input), { kind: "unknown" });
  }
  const thrown = factory(() => {
    throw new Error("synthetic");
  });
  const t = await createAiSuggestionRecorder(environment(), thrown.create);
  assert.deepEqual(await t.record(input), { kind: "unknown" });
});
