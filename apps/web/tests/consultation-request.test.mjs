// MVP-001 S6: the consultation request review, creation, withdrawal and the
// client's request reads, driven through fake ports that answer exactly as
// the trusted sources and the database's own functions do; the adapter's
// strict answer readers; and the fixed-wording, banned-claims and route
// checks over every S6 string and page. Every attorney, client, Intake,
// Referral, option code, currency and amount is synthetic test data (XTS is
// the ISO 4217 testing code).

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
  createConsultationRequest,
  INITIAL_REQUEST_STATE,
  INITIAL_WITHDRAW_STATE,
  INTAKE_REQUEST_COLUMNS,
  optionValueOf,
  PREVIEW_COLUMNS,
  REQUEST_COLUMNS,
  REQUEST_STATES,
  requestPathFor,
  requestReviewPathFor,
  requestReviewQueryOf,
  resolveConsultationRequest,
  resolveIntakeRequests,
  resolveRequestReview,
  REVIEW_COLUMNS,
  messageLength,
  MESSAGE_CEILING,
  submittedMessage,
  withdrawConsultationRequest,
} from "../src/application/consultation-request.ts";
import {
  createAnswerOf,
  createRequestWrites,
  withdrawAnswerOf,
} from "../src/infrastructure/requests/consultation-request-adapter.ts";
import * as labels from "../src/presentation/request-labels.ts";

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
const importsOf = (source) =>
  [
    ...source.matchAll(
      /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
    ),
  ].map((m) => m[1]);

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ACCOUNT = id(101);
const USER = id(201);
const CLIENT = id(301);
const INTAKE = id(401);
const REFERRAL = id(801);
const OTHER_REFERRAL = id(802);
const REQUEST = id(901);
const T = (hour, minute = 0) =>
  `2026-11-20T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+00:00`;

const rows = (list) => ({ kind: "rows", rows: list });
const UNREADABLE = Object.freeze({ kind: "unreadable" });

const BANNED =
  /best match|recommended attorney|perfect attorney|ai-selected|ai selected|right lawyer for you|best attorney|rosuno recommends|top rated|top-rated|(?<!which )law (definitely )?applies|is the governing law|approved by the|licensed by the|live in your state|guarantee/i;

function reviewRow(overrides = {}) {
  return {
    referral_id: REFERRAL,
    attorney_display_name: "Synthetic Attorney",
    request_path: "scheduled",
    request_id: null,
    requestable: true,
    // MVP-001 S6 PS-A3: the message maximum (none by default).
    message_maximum_characters: null,
    ...overrides,
  };
}

const OPTIONS = [
  { modality: "synthetic_audio", duration_minutes: 30 },
  { modality: "synthetic_video", duration_minutes: 30 },
  { modality: "synthetic_video", duration_minutes: 60 },
];

const STARTS = [
  { slot_start: T(10), slot_end: T(10, 30) },
  { slot_start: T(10, 30), slot_end: T(11) },
];

function previewRow(overrides = {}) {
  return {
    outcome: "priced",
    attorney_listed_price_minor: 5000,
    client_fee_minor: 175,
    tax_or_other_required_fee_minor: 0,
    total_client_amount_minor: 5175,
    currency_code: "XTS",
    quote_validity_seconds: 900,
    ...overrides,
  };
}

const REFUSED_PREVIEW = (outcome) =>
  previewRow({
    outcome,
    attorney_listed_price_minor: null,
    client_fee_minor: null,
    tax_or_other_required_fee_minor: null,
    total_client_amount_minor: null,
    currency_code: null,
    quote_validity_seconds: null,
  });

function requestRow(overrides = {}) {
  return {
    request_id: REQUEST,
    state: "slot_held",
    expired_due: false,
    request_path: "scheduled",
    attorney_display_name: "Synthetic Attorney",
    requested_modality: "synthetic_video",
    duration_minutes: 30,
    slot_start_at: T(10),
    slot_end_at: T(10, 30),
    response_deadline_at: T(9),
    created_at: T(8),
    attorney_listed_price_minor: 5000,
    client_fee_minor: 175,
    tax_or_other_required_fee_minor: 0,
    total_client_amount_minor: 5175,
    currency_code: "XTS",
    quote_valid_until: T(8, 15),
    // MVP-001 S6 PS-A3: the client's own message (none by default).
    client_message: null,
    ...overrides,
  };
}

function harness(overrides = {}) {
  const calls = [];
  const state = {
    subject: ACCOUNT,
    contexts: ["client"],
    users: [{ id: USER, auth_user_id: ACCOUNT, account_state: "active" }],
    profiles: [{ id: CLIENT, user_id: USER }],
    intakes: [
      {
        id: INTAKE,
        client_id: CLIENT,
        state: "submitted",
        created_at: T(5),
        closed_at: null,
      },
    ],
    review: [reviewRow()],
    options: OPTIONS,
    starts: STARTS,
    preview: [previewRow()],
    request: [requestRow()],
    intakeRequests: [],
    environment: [{ environment_class: "development", project_ref: null }],
    configuredClass: "development",
    createAnswer: {
      kind: "answer",
      outcome: "created",
      requestId: REQUEST,
      problem: null,
    },
    withdrawAnswer: { kind: "answer", outcome: "withdrawn" },
    ...overrides,
  };
  const clientIntake = {
    session: { currentSubject: async () => state.subject },
    contexts: { contextsOf: async () => state.contexts },
    account: {
      currentAccount: async () => ({
        kind: "user",
        id: state.subject,
        emailConfirmedAt: "2026-11-01T00:00:00Z",
      }),
    },
    reads: async () => ({
      usersOf: async (a) =>
        rows(state.users.filter((u) => u.auth_user_id === a)),
      clientProfilesOf: async (u) =>
        rows(state.profiles.filter((p) => p.user_id === u)),
      intakesOf: async () => rows(state.intakes),
      intakeOf: async (c, intake) =>
        rows(state.intakes.filter((i) => i.client_id === c && i.id === intake)),
      latestRevisionSummaryOf: async () => rows([]),
      latestRevisionOf: async () => rows([]),
      questionSets: async () => rows([]),
      assessmentsOf: async () => rows([]),
      practiceAreas: async () => rows([]),
      jurisdictions: async () => rows([]),
      suggestionsOf: async () => rows([]),
    }),
    writes: async () => ({}),
  };
  const sources = {
    session: { currentSubject: async () => state.subject },
    clientIntake,
    reads: async () => ({
      review: async (referral) => {
        calls.push(["review", referral]);
        return state.review === null ? UNREADABLE : rows(state.review);
      },
      options: async (referral) => {
        calls.push(["options", referral]);
        return rows(state.options);
      },
      slotStarts: async (referral, modality, duration) => {
        calls.push(["slotStarts", referral, modality, duration]);
        return rows(state.starts);
      },
      preview: async (input) => {
        calls.push(["preview", input]);
        return rows(state.preview);
      },
      request: async (request) => {
        calls.push(["request", request]);
        return rows(state.request);
      },
      intakeRequests: async (intake) => {
        calls.push(["intakeRequests", intake]);
        return rows(state.intakeRequests);
      },
      environmentIdentity: async () => {
        calls.push(["environmentIdentity"]);
        return rows(state.environment);
      },
    }),
    writes: async () => ({
      createRequest: async (input) => {
        calls.push(["createRequest", input]);
        return state.createAnswer;
      },
      withdrawRequest: async (request) => {
        calls.push(["withdrawRequest", request]);
        return state.withdrawAnswer;
      },
    }),
    environment: () => ({
      configuredClass: state.configuredClass,
      expectedProjectRef: null,
    }),
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

const query = (values) => requestReviewQueryOf(values);

// ---------------------------------------------------------------------------
// The review page
// ---------------------------------------------------------------------------

test("S6-1. the review query reads only its three values: the Referral is required, and a present but malformed option or start time is reported as invalid, never broadened", () => {
  assert.deepEqual(query({ referral: REFERRAL }), {
    referralId: REFERRAL,
    option: null,
    slotStart: null,
  });
  assert.deepEqual(
    query({ referral: REFERRAL, option: "synthetic_video-30", slot: T(10) }),
    {
      referralId: REFERRAL,
      option: { modality: "synthetic_video", durationMinutes: 30 },
      slotStart: T(10),
    },
  );
  for (const referral of [
    undefined,
    "x",
    [REFERRAL, REFERRAL],
    "ABCDEF01-2345-4678-9ABC-DEF012345678",
  ]) {
    assert.equal(query({ referral }).referralId, null, String(referral));
  }
  for (const option of [
    "synthetic video-30",
    "Synthetic_video-30",
    "synthetic_video-0",
    "synthetic_video-1441",
    "synthetic_video-30.5",
    "synthetic_video",
    "-30",
    ["synthetic_video-30", "synthetic_video-60"],
  ]) {
    assert.equal(
      query({ referral: REFERRAL, option }).option,
      "invalid",
      String(option),
    );
  }
  for (const slot of ["tomorrow", "2026-11-20 10:00", [T(10), T(11)]]) {
    assert.equal(
      query({ referral: REFERRAL, slot }).slotStart,
      "invalid",
      String(slot),
    );
  }
  assert.equal(
    optionValueOf({ modality: "synthetic_audio", durationMinutes: 60 }),
    "synthetic_audio-60",
  );
  assert.equal(
    requestReviewPathFor(REFERRAL),
    `/client/requests/new?referral=${REFERRAL}`,
  );
  assert.equal(requestPathFor(REQUEST), `/client/requests/${REQUEST}`);
});

test("S6-2. the review answers not-found for a malformed, unknown or foreign Referral (the database answers no row alike), sign-in for an anonymous visitor, denied for a non-client, the existing Request when one was made, not-requestable when the database says so, and unavailable for any unexpected row", async () => {
  assert.deepEqual(
    await resolveRequestReview(harness().sources, query({ referral: "x" })),
    { status: "not-found" },
  );
  const unknown = harness({ review: [] });
  assert.deepEqual(
    await resolveRequestReview(
      unknown.sources,
      query({ referral: OTHER_REFERRAL }),
    ),
    { status: "not-found" },
  );
  assert.deepEqual(unknown.calls, [["review", OTHER_REFERRAL]]);
  assert.deepEqual(
    await resolveRequestReview(
      harness({ subject: null }).sources,
      query({ referral: REFERRAL }),
    ),
    { status: "sign-in-required" },
  );
  assert.deepEqual(
    await resolveRequestReview(
      harness({ contexts: ["attorney"] }).sources,
      query({ referral: REFERRAL }),
    ),
    { status: "denied" },
  );
  assert.deepEqual(
    await resolveRequestReview(
      harness({
        review: [reviewRow({ request_id: REQUEST, requestable: false })],
      }).sources,
      query({ referral: REFERRAL }),
    ),
    { status: "requested", requestHref: `/client/requests/${REQUEST}` },
  );
  assert.deepEqual(
    await resolveRequestReview(
      harness({ review: [reviewRow({ requestable: false })] }).sources,
      query({ referral: REFERRAL }),
    ),
    { status: "not-requestable" },
  );
  for (const review of [
    null,
    [reviewRow(), reviewRow()],
    [{ ...reviewRow(), extra: 1 }],
    [reviewRow({ referral_id: OTHER_REFERRAL })],
    [reviewRow({ request_path: "soon" })],
    [reviewRow({ requestable: "yes" })],
    [reviewRow({ request_id: REQUEST, requestable: true })],
    [reviewRow({ request_path: null, requestable: true })],
    // MVP-001 S6 PS-A3: a message maximum is null or an integer 1..20000.
    [reviewRow({ message_maximum_characters: 0 })],
    [reviewRow({ message_maximum_characters: 20001 })],
    [reviewRow({ message_maximum_characters: "100" })],
    [reviewRow({ message_maximum_characters: 10.5 })],
    [(({ message_maximum_characters: _m, ...rest }) => rest)(reviewRow())],
  ]) {
    assert.deepEqual(
      await resolveRequestReview(
        harness({ review }).sources,
        query({ referral: REFERRAL }),
      ),
      { status: "unavailable" },
      JSON.stringify(review),
    );
  }
  assert.deepEqual(REVIEW_COLUMNS, [
    "referral_id",
    "attorney_display_name",
    "request_path",
    "request_id",
    "requestable",
    "message_maximum_characters",
  ]);
});

test("S6-3. with no priced option (the shipped price-source seam) the review is ready with no options and asks for nothing else; options are read strictly", async () => {
  const { sources, calls } = harness({ options: [] });
  const view = await resolveRequestReview(
    sources,
    query({ referral: REFERRAL }),
  );
  assert.equal(view.status, "ready");
  assert.deepEqual(view.options, []);
  assert.equal(view.choice, "none");
  assert.equal(view.quote, null);
  assert.deepEqual(calls, [
    ["review", REFERRAL],
    ["options", REFERRAL],
  ]);
  for (const options of [
    [{ modality: "Synthetic", duration_minutes: 30 }],
    [{ modality: "synthetic_video", duration_minutes: 0 }],
    [{ modality: "synthetic_video", duration_minutes: "30" }],
    [{ ...OPTIONS[0], price: 1 }],
  ]) {
    assert.deepEqual(
      await resolveRequestReview(
        harness({ options }).sources,
        query({ referral: REFERRAL }),
      ),
      { status: "unavailable" },
      JSON.stringify(options),
    );
  }
});

test("S6-4. a choice must be one of the options offered (and, scheduled, one of the start times offered); only a complete choice asks for the database's quote, with exactly the checked values; the quote's refusals become fixed views and a malformed quote is unavailable", async () => {
  // Scheduled: option, then time, then the quote.
  const offered = harness();
  const optionOnly = await resolveRequestReview(
    offered.sources,
    query({ referral: REFERRAL, option: "synthetic_video-30" }),
  );
  assert.equal(optionOnly.choice, "option");
  assert.deepEqual(optionOnly.slotStarts, [
    { start: T(10), end: T(10, 30) },
    { start: T(10, 30), end: T(11) },
  ]);
  assert.equal(optionOnly.quote, null);
  assert.deepEqual(offered.calls.at(-1), [
    "slotStarts",
    REFERRAL,
    "synthetic_video",
    30,
  ]);
  const complete = harness();
  const view = await resolveRequestReview(
    complete.sources,
    query({
      referral: REFERRAL,
      option: "synthetic_video-30",
      slot: T(10, 30),
    }),
  );
  assert.equal(view.choice, "complete");
  assert.equal(view.slotStart, T(10, 30));
  assert.deepEqual(view.quote, {
    status: "priced",
    validitySeconds: 900,
    listedPriceMinor: 5000,
    clientFeeMinor: 175,
    otherFeeMinor: 0,
    totalMinor: 5175,
    currency: "XTS",
  });
  assert.deepEqual(complete.calls.at(-1), [
    "preview",
    {
      referralId: REFERRAL,
      path: "scheduled",
      modality: "synthetic_video",
      durationMinutes: 30,
      slotStart: T(10, 30),
    },
  ]);
  // Not offered: the option, or the start time; no quote is asked for.
  for (const values of [
    { option: "synthetic_video-90" },
    { option: "synthetic_text-30" },
    { option: "bad option" },
    { option: "synthetic_video-30", slot: T(12) },
    { option: "synthetic_video-30", slot: "noon" },
    { slot: T(10) },
  ]) {
    const refused = harness();
    const answer = await resolveRequestReview(
      refused.sources,
      query({ referral: REFERRAL, ...values }),
    );
    assert.equal(answer.choice, "invalid", JSON.stringify(values));
    assert.equal(answer.quote, null);
    assert.equal(
      refused.calls.some((c) => c[0] === "preview"),
      false,
    );
  }
  // Instant: no start time is read; a start time is invalid.
  const instantHarness = harness({
    review: [reviewRow({ request_path: "instant" })],
  });
  const instantView = await resolveRequestReview(
    instantHarness.sources,
    query({ referral: REFERRAL, option: "synthetic_audio-30" }),
  );
  assert.equal(instantView.choice, "complete");
  assert.equal(
    instantHarness.calls.some((c) => c[0] === "slotStarts"),
    false,
  );
  assert.equal(instantHarness.calls.at(-1)[1].slotStart, null);
  assert.equal(
    (
      await resolveRequestReview(
        harness({ review: [reviewRow({ request_path: "instant" })] }).sources,
        query({
          referral: REFERRAL,
          option: "synthetic_audio-30",
          slot: T(10),
        }),
      )
    ).choice,
    "invalid",
  );
  // Refusals and malformed quotes.
  for (const [outcome, status] of [
    ["price_unavailable", "pricing-unavailable"],
    ["price_not_permitted", "option-unavailable"],
    ["duration_not_permitted", "option-unavailable"],
    ["modality_not_permitted", "option-unavailable"],
    ["policy_unavailable", "configuration-unavailable"],
    ["not_available", "not-available"],
    ["invalid", "unavailable"],
    ["not_found", "unavailable"],
    ["already_requested", "unavailable"],
  ]) {
    const answer = await resolveRequestReview(
      harness({
        review: [reviewRow({ request_path: "instant" })],
        preview: [REFUSED_PREVIEW(outcome)],
      }).sources,
      query({ referral: REFERRAL, option: "synthetic_audio-30" }),
    );
    assert.deepEqual(answer.quote, { status }, outcome);
  }
  for (const preview of [
    [],
    [previewRow(), previewRow()],
    [previewRow({ outcome: "quoted" })],
    [previewRow({ attorney_listed_price_minor: 0 })],
    [previewRow({ attorney_listed_price_minor: -5 })],
    [previewRow({ total_client_amount_minor: 10 })],
    [previewRow({ currency_code: "xts" })],
    [previewRow({ quote_validity_seconds: 30 })],
    [{ ...previewRow(), platform_fee_minor: 500 }],
    [{ ...REFUSED_PREVIEW("price_unavailable"), currency_code: "XTS" }],
  ]) {
    const answer = await resolveRequestReview(
      harness({ review: [reviewRow({ request_path: "instant" })], preview })
        .sources,
      query({ referral: REFERRAL, option: "synthetic_audio-30" }),
    );
    assert.deepEqual(
      answer.quote,
      { status: "unavailable" },
      JSON.stringify(preview),
    );
  }
  assert.deepEqual(PREVIEW_COLUMNS, [
    "outcome",
    "attorney_listed_price_minor",
    "client_fee_minor",
    "tax_or_other_required_fee_minor",
    "total_client_amount_minor",
    "currency_code",
    "quote_validity_seconds",
  ]);
});

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

test("S6-5. confirming a request checks every field once, the verified client and the environment binding, sends exactly the checked values, and reports only the database's fixed outcome", async () => {
  const valid = {
    referral: REFERRAL,
    path: "scheduled",
    modality: "synthetic_video",
    duration: "30",
    slot: T(10),
  };
  const { sources, calls } = harness();
  assert.deepEqual(await createConsultationRequest(sources, form(valid)), {
    status: "created",
    requestId: REQUEST,
  });
  assert.deepEqual(calls.at(-1), [
    "createRequest",
    {
      referralId: REFERRAL,
      path: "scheduled",
      modality: "synthetic_video",
      durationMinutes: 30,
      slotStart: T(10),
      // MVP-001 S6 PS-A3: no message was given.
      message: null,
    },
  ]);
  const answer = (outcome, problem = null) => ({
    kind: "answer",
    outcome,
    requestId: null,
    problem,
  });
  for (const [createAnswer, status] of [
    [answer("invalid"), "invalid"],
    [answer("not_found"), "not-found"],
    [answer("intake_not_ready"), "intake-not-ready"],
    [answer("already_requested"), "already-requested"],
    [answer("not_available", "hold_conflict"), "slot-unavailable"],
    [answer("not_available", "notice"), "slot-unavailable"],
    [answer("not_available", "blackout"), "slot-unavailable"],
    [answer("not_available", "intent_off"), "not-available"],
    [answer("not_available", "not_eligible"), "not-available"],
    [answer("not_available"), "not-available"],
    [answer("too_late"), "slot-unavailable"],
    [answer("price_unavailable"), "pricing-unavailable"],
    [answer("price_not_permitted"), "option-unavailable"],
    [answer("duration_not_permitted"), "option-unavailable"],
    [answer("modality_not_permitted"), "option-unavailable"],
    [answer("policy_unavailable"), "configuration-unavailable"],
    [answer("cap_reached"), "cap-reached"],
    [answer("created"), "outcome-unknown"],
    [{ ...answer("created"), requestId: "x" }, "outcome-unknown"],
    [answer("priced"), "outcome-unknown"],
    [UNREADABLE, "outcome-unknown"],
    [{ kind: "rejected" }, "unavailable"],
  ]) {
    assert.deepEqual(
      await createConsultationRequest(
        harness({ createAnswer }).sources,
        form(valid),
      ),
      { status },
      JSON.stringify(createAnswer),
    );
  }
  // Malformed or repeated fields are refused before anything is read.
  for (const fields of [
    { ...valid, path: "soon" },
    { ...valid, modality: "Synthetic Video" },
    { ...valid, duration: "0" },
    { ...valid, duration: "1441" },
    { ...valid, duration: "30.5" },
    { ...valid, duration: "030" },
    { ...valid, slot: "noon" },
    { ...valid, referral: "x" },
    { ...valid, referral: [REFERRAL, OTHER_REFERRAL] },
    (({ slot: _s, ...rest }) => rest)(valid),
    { ...valid, path: "instant" },
    (({ modality: _m, ...rest }) => rest)(valid),
  ]) {
    const fresh = harness();
    assert.deepEqual(
      await createConsultationRequest(fresh.sources, form(fields)),
      {
        status: "invalid",
      },
    );
    assert.deepEqual(fresh.calls, []);
  }
  // Instant: no start time is sent.
  const instant = harness();
  assert.equal(
    (
      await createConsultationRequest(
        instant.sources,
        form(
          (({ slot: _s, ...rest }) => ({ ...rest, path: "instant" }))(valid),
        ),
      )
    ).status,
    "created",
  );
  assert.equal(instant.calls.at(-1)[1].slotStart, null);
  // An unrecorded or mismatched environment refuses before the write.
  for (const overrides of [
    { environment: [{ environment_class: "unrecorded", project_ref: null }] },
    { configuredClass: "staging" },
    { environment: [] },
  ]) {
    const refused = harness(overrides);
    assert.deepEqual(
      await createConsultationRequest(refused.sources, form(valid)),
      {
        status: "unavailable",
      },
    );
    assert.equal(
      refused.calls.some((c) => c[0] === "createRequest"),
      false,
    );
  }
  assert.deepEqual(
    await createConsultationRequest(
      harness({ subject: null }).sources,
      form(valid),
    ),
    { status: "sign-in-required" },
  );
  assert.deepEqual(
    await createConsultationRequest(
      harness({ contexts: ["attorney"] }).sources,
      form(valid),
    ),
    { status: "denied" },
  );
  assert.deepEqual(await createConsultationRequest(sources, null), {
    status: "unavailable",
  });
  assert.deepEqual(INITIAL_REQUEST_STATE, { status: "idle" });
});

// ---------------------------------------------------------------------------
// One Request and withdrawal
// ---------------------------------------------------------------------------

test("S6-6. a Request shows exactly the database's fields; an undecided Request past its server deadline is shown expired from the database's own flag and is not withdrawable; another client's or an unknown Request is not found; an unexpected row is unavailable", async () => {
  const { sources, calls } = harness();
  const view = await resolveConsultationRequest(sources, REQUEST);
  assert.equal(view.status, "ready");
  assert.equal(view.displayState, "slot_held");
  assert.equal(view.withdrawable, true);
  assert.deepEqual(view.request.amounts, {
    listedPriceMinor: 5000,
    clientFeeMinor: 175,
    otherFeeMinor: 0,
    totalMinor: 5175,
    currency: "XTS",
  });
  assert.equal(view.request.durationMinutes, 30);
  assert.deepEqual(calls, [["request", REQUEST]]);
  const due = await resolveConsultationRequest(
    harness({ request: [requestRow({ expired_due: true })] }).sources,
    REQUEST,
  );
  assert.deepEqual([due.displayState, due.withdrawable], ["expired", false]);
  for (const state of ["accepted", "declined", "expired", "cancelled"]) {
    const ended = await resolveConsultationRequest(
      harness({ request: [requestRow({ state })] }).sources,
      REQUEST,
    );
    assert.deepEqual([ended.displayState, ended.withdrawable], [state, false]);
  }
  const instant = await resolveConsultationRequest(
    harness({
      request: [
        requestRow({
          state: "created",
          request_path: "instant",
          slot_start_at: null,
          slot_end_at: null,
        }),
      ],
    }).sources,
    REQUEST,
  );
  assert.equal(instant.withdrawable, true);
  const notFound = harness({ request: [] });
  assert.deepEqual(
    await resolveConsultationRequest(notFound.sources, id(999)),
    {
      status: "not-found",
    },
  );
  const malformedId = harness();
  assert.deepEqual(await resolveConsultationRequest(malformedId.sources, "x"), {
    status: "not-found",
  });
  assert.deepEqual(malformedId.calls, []);
  for (const request of [
    [requestRow(), requestRow()],
    [{ ...requestRow(), platform_fee_minor: 500 }],
    [requestRow({ request_id: id(998) })],
    [requestRow({ state: "pending" })],
    [requestRow({ state: "accepted", expired_due: true })],
    [requestRow({ request_path: "instant" })],
    [requestRow({ slot_end_at: null })],
    [requestRow({ requested_modality: "Video Call" })],
    [requestRow({ currency_code: null })],
    [requestRow({ attorney_listed_price_minor: 0 })],
    [requestRow({ response_deadline_at: "soon" })],
    // MVP-001 S6 PS-A3: a message is null or non-blank text within the
    // ceiling.
    [requestRow({ client_message: "   " })],
    [requestRow({ client_message: "" })],
    [requestRow({ client_message: 42 })],
    [requestRow({ client_message: "m".repeat(20001) })],
    [(({ client_message: _m, ...rest }) => rest)(requestRow())],
  ]) {
    assert.deepEqual(
      await resolveConsultationRequest(harness({ request }).sources, REQUEST),
      { status: "unavailable" },
      JSON.stringify(request),
    );
  }
  assert.deepEqual(
    await resolveConsultationRequest(
      harness({ subject: null }).sources,
      REQUEST,
    ),
    { status: "sign-in-required" },
  );
  // MVP-001 S6 PS-A3: and the client's own message, last.
  assert.deepEqual(REQUEST_COLUMNS.length, 18);
  assert.equal(REQUEST_COLUMNS.at(-1), "client_message");
  assert.deepEqual(REQUEST_STATES, [
    "created",
    "payment_authorized",
    "slot_held",
    "awaiting_attorney",
    "accepted",
    "declined",
    "expired",
    "cancelled",
  ]);
});

test("S6-7. withdrawal checks its one field, the verified client and the environment binding, sends exactly the Request id, and reports only the database's fixed outcome", async () => {
  const { sources, calls } = harness();
  assert.deepEqual(
    await withdrawConsultationRequest(sources, form({ request: REQUEST })),
    { status: "withdrawn" },
  );
  assert.deepEqual(calls.at(-1), ["withdrawRequest", REQUEST]);
  for (const [withdrawAnswer, status] of [
    [{ kind: "answer", outcome: "expired" }, "expired"],
    [{ kind: "answer", outcome: "not_withdrawable" }, "not-withdrawable"],
    [{ kind: "answer", outcome: "not_found" }, "not-found"],
    [{ kind: "answer", outcome: "invalid" }, "invalid"],
    [{ kind: "answer", outcome: "cancelled" }, "outcome-unknown"],
    [UNREADABLE, "outcome-unknown"],
    [{ kind: "rejected" }, "unavailable"],
  ]) {
    assert.deepEqual(
      await withdrawConsultationRequest(
        harness({ withdrawAnswer }).sources,
        form({ request: REQUEST }),
      ),
      { status },
    );
  }
  for (const fields of [
    {},
    { request: "x" },
    { request: [REQUEST, REQUEST] },
  ]) {
    const fresh = harness();
    assert.deepEqual(
      await withdrawConsultationRequest(fresh.sources, form(fields)),
      {
        status: "invalid",
      },
    );
    assert.deepEqual(fresh.calls, []);
  }
  const mismatch = harness({ configuredClass: "staging" });
  assert.deepEqual(
    await withdrawConsultationRequest(
      mismatch.sources,
      form({ request: REQUEST }),
    ),
    { status: "unavailable" },
  );
  assert.equal(
    mismatch.calls.some((c) => c[0] === "withdrawRequest"),
    false,
  );
  assert.deepEqual(
    await withdrawConsultationRequest(
      harness({ contexts: ["attorney"] }).sources,
      form({ request: REQUEST }),
    ),
    { status: "denied" },
  );
  assert.deepEqual(INITIAL_WITHDRAW_STATE, { status: "idle" });
});

test("S6-8. the Intake's attempts carry each Request's state (expired when the database reports it due), its link, or whether a Request can still be made; the list is read strictly and in order", async () => {
  const attempt = (n, overrides = {}) => ({
    attempt_ordinal: n,
    referral_id: id(800 + n),
    request_id: null,
    state: null,
    expired_due: null,
    requestable: false,
    ...overrides,
  });
  const { sources, calls } = harness({
    intakeRequests: [
      attempt(1, {
        request_id: id(901),
        state: "slot_held",
        expired_due: true,
      }),
      attempt(2, {
        request_id: id(902),
        state: "cancelled",
        expired_due: false,
      }),
      attempt(3, { requestable: true }),
      attempt(4),
    ],
  });
  const view = await resolveIntakeRequests(sources, INTAKE);
  assert.deepEqual(view, {
    status: "ready",
    attempts: [
      {
        ordinal: 1,
        referralId: id(801),
        requestId: id(901),
        displayState: "expired",
        requestable: false,
      },
      {
        ordinal: 2,
        referralId: id(802),
        requestId: id(902),
        displayState: "cancelled",
        requestable: false,
      },
      {
        ordinal: 3,
        referralId: id(803),
        requestId: null,
        displayState: null,
        requestable: true,
      },
      {
        ordinal: 4,
        referralId: id(804),
        requestId: null,
        displayState: null,
        requestable: false,
      },
    ],
  });
  assert.deepEqual(calls, [["intakeRequests", INTAKE]]);
  assert.deepEqual(await resolveIntakeRequests(harness().sources, id(499)), {
    status: "not-found",
  });
  for (const intakeRequests of [
    [attempt(2)],
    [attempt(1), attempt(1)],
    [attempt(1, { state: "created" })],
    [attempt(1, { request_id: id(901), state: "pending", expired_due: false })],
    [
      attempt(1, {
        request_id: id(901),
        state: "created",
        expired_due: false,
        requestable: true,
      }),
    ],
    [{ ...attempt(1), outcome_code: null }],
  ]) {
    assert.deepEqual(
      await resolveIntakeRequests(harness({ intakeRequests }).sources, INTAKE),
      { status: "unavailable" },
      JSON.stringify(intakeRequests),
    );
  }
  assert.deepEqual(INTAKE_REQUEST_COLUMNS, [
    "attempt_ordinal",
    "referral_id",
    "request_id",
    "state",
    "expired_due",
    "requestable",
  ]);
});

test("S6-9. the adapter reads each write answer strictly: exactly one row of the function's own columns with a known outcome; a database error is rejected, anything else unreadable", () => {
  assert.deepEqual(
    createAnswerOf({
      data: [{ outcome: "created", request_id: REQUEST, problem: null }],
      error: null,
    }),
    { kind: "answer", outcome: "created", requestId: REQUEST, problem: null },
  );
  assert.deepEqual(
    createAnswerOf({
      data: [
        {
          outcome: "not_available",
          request_id: null,
          problem: "hold_conflict",
        },
      ],
      error: null,
    }),
    {
      kind: "answer",
      outcome: "not_available",
      requestId: null,
      problem: "hold_conflict",
    },
  );
  for (const result of [
    { data: [], error: null },
    { data: [{ outcome: "created", request_id: REQUEST }], error: null },
    {
      data: [{ outcome: "created", request_id: REQUEST, problem: null, x: 1 }],
      error: null,
    },
    {
      data: [{ outcome: "booked", request_id: null, problem: null }],
      error: null,
    },
    {
      data: [{ outcome: "created", request_id: 1, problem: null }],
      error: null,
    },
    { data: null, error: null },
    { data: null, error: { code: "08006" }, status: 503 },
    { data: null, error: { message: "x" }, status: 500 },
  ]) {
    assert.deepEqual(createAnswerOf(result), { kind: "unreadable" });
  }
  assert.deepEqual(
    createAnswerOf({ data: null, error: { code: "42501" }, status: 403 }),
    { kind: "rejected" },
  );
  assert.deepEqual(
    withdrawAnswerOf({ data: [{ outcome: "withdrawn" }], error: null }),
    { kind: "answer", outcome: "withdrawn" },
  );
  for (const result of [
    { data: [{ outcome: "cancelled" }], error: null },
    { data: [{ outcome: "withdrawn", extra: 1 }], error: null },
    { data: [], error: null },
  ]) {
    assert.deepEqual(withdrawAnswerOf(result), { kind: "unreadable" });
  }
  assert.deepEqual(
    withdrawAnswerOf({ data: null, error: { code: "55P03" }, status: 500 }),
    { kind: "rejected" },
  );
});

// ---------------------------------------------------------------------------
// Wording and routes
// ---------------------------------------------------------------------------

test("S6-10. wording: no S6 label, message or page text recommends, ranks or matches an attorney, claims a live or approved status, writes legal text or describes a payment step; the shipped seam's sentence is fixed; modality codes are shown as words, never through a fixed list; amounts carry their currency code", () => {
  const texts = [];
  for (const value of Object.values(labels)) {
    if (typeof value === "string") {
      texts.push(value);
    } else if (typeof value === "object" && value !== null) {
      for (const entry of Object.values(value)) {
        texts.push(typeof entry === "string" ? entry : entry.label);
      }
    }
  }
  for (const status of [
    "created",
    "invalid",
    "not-found",
    "intake-not-ready",
    "already-requested",
    "slot-unavailable",
    "not-available",
    "option-unavailable",
    "pricing-unavailable",
    "configuration-unavailable",
    "cap-reached",
    "outcome-unknown",
    "sign-in-required",
    "denied",
    "unavailable",
  ]) {
    const message = labels.requestMessage(
      status === "created" ? { status, requestId: REQUEST } : { status },
    );
    assert.ok(message !== null, status);
    texts.push(message.title, message.body);
  }
  for (const status of [
    "withdrawn",
    "expired",
    "not-withdrawable",
    "not-found",
    "invalid",
    "outcome-unknown",
    "sign-in-required",
    "denied",
    "unavailable",
  ]) {
    const message = labels.withdrawMessage({ status });
    assert.ok(message !== null, status);
    texts.push(message.title, message.body);
  }
  for (const status of [
    "pricing-unavailable",
    "option-unavailable",
    "configuration-unavailable",
    "not-available",
    "unavailable",
  ]) {
    texts.push(labels.quoteStatusText(status));
  }
  assert.equal(labels.requestMessage({ status: "idle" }), null);
  assert.equal(labels.withdrawMessage({ status: "idle" }), null);
  const pageFiles = [
    "app/client/requests/new/page.tsx",
    "app/client/requests/new/forms.tsx",
    "app/client/requests/[request]/page.tsx",
    "app/client/requests/[request]/forms.tsx",
    "src/presentation/request-labels.ts",
    "src/application/consultation-request.ts",
  ];
  for (const file of pageFiles) {
    texts.push(codeOf(read(file)));
  }
  for (const text of texts) {
    assert.doesNotMatch(text, BANNED, text.slice(0, 120));
    assert.doesNotMatch(
      text,
      /legal advice|disclaim|liabilit|warrant|terms of (?:use|service)|privacy policy|cookie policy|refund|charged|card|payment authori[sz]ed|pay now/i,
      text.slice(0, 120),
    );
  }
  assert.equal(
    labels.PRICING_NOT_AVAILABLE,
    "This attorney's consultation pricing is not yet available, so a request cannot be made.",
  );
  assert.equal(
    labels.modalityText("synthetic_video_call"),
    "Synthetic video call",
  );
  assert.equal(labels.durationText(90), "90 minutes");
  assert.match(labels.moneyText(5175, "XTS"), /^XTS\s?51\.75$/);
  assert.match(labels.moneyText(5175, "JPY"), /^JPY\s?5,175$/);
  assert.equal(labels.utcText(T(10, 30)), "2026-11-20 10:30 UTC");
  assert.equal(labels.validityText(900), "15 minutes");
  assert.equal(labels.validityText(7200), "2 hours");
  // Modalities and durations are configuration: no S6 module fixes a
  // modality vocabulary, a duration list, a price or a currency.
  for (const file of [
    ...pageFiles,
    "src/infrastructure/requests/consultation-request-adapter.ts",
    "app/client/requests/actions.ts",
  ]) {
    const code = codeOf(read(file));
    assert.doesNotMatch(
      code,
      /["'](?:video|audio|phone|in_person|telephone)["']/i,
      file,
    );
    assert.doesNotMatch(code, /["'](?:USD|EUR|GBP|XTS)["']/, file);
    assert.doesNotMatch(code, /california|\$\d/i, file);
  }
});

test("S6-11. the request routes are exactly the review page, the request page, their forms and the request actions; each reads only its own request values, decides on the server for every request, and reaches the database only through the consultation request use cases and production sources", () => {
  assert.deepEqual(filesIn("app/client/requests/"), [
    "app/client/requests/[request]/forms.tsx",
    "app/client/requests/[request]/page.tsx",
    "app/client/requests/actions.ts",
    "app/client/requests/new/forms.tsx",
    "app/client/requests/new/page.tsx",
  ]);
  const review = codeOf(read("app/client/requests/new/page.tsx"));
  assert.match(review, /await connection\(\);/);
  assert.match(
    review,
    /const view = await resolveRequestReview\(\n {4}REQUEST_SOURCES,\n {4}requestReviewQueryOf\(await searchParams\),\n {2}\);\n {2}if \(view\.status === "not-found"\) \{\n {4}notFound\(\);\n {2}\}/,
  );
  // The choice forms are plain first-party GETs of this page, carrying only
  // the Referral, the option and the start time.
  assert.deepEqual(review.match(/<form\b[^>]*>/g), [
    '<form action="/client/requests/new" method="get">',
    '<form action="/client/requests/new" method="get">',
  ]);
  assert.deepEqual(
    [...review.matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]),
    ["referral", "option", "referral", "option", "slot"],
  );
  assert.ok(review.includes("{PRICING_NOT_AVAILABLE}"));
  const detail = codeOf(read("app/client/requests/[request]/page.tsx"));
  assert.match(detail, /await connection\(\);/);
  assert.match(
    detail,
    /const \{ request \} = await params;\n {2}const view = await resolveConsultationRequest\(REQUEST_SOURCES, request\);\n {2}if \(view\.status === "not-found"\) \{\n {4}notFound\(\);\n {2}\}/,
  );
  assert.ok(detail.includes("{view.withdrawable ? <WithdrawRequestForm"));
  const actions = read("app/client/requests/actions.ts");
  assert.match(actions, /^"use server";\n/);
  // MVP-001 S7: exactly one more action, the payment authorization, which
  // reaches the database only through the client payment use case and its
  // production sources and redirects only to the address that use case
  // answers (the provider's hosted page the server read itself).
  assert.equal(codeOf(actions).match(/export async function \w+\(/g).length, 3);
  for (const call of [
    "const state = await createConsultationRequest(REQUEST_SOURCES, formData);",
    "const state = await withdrawConsultationRequest(REQUEST_SOURCES, formData);",
    "redirect(requestPathFor(state.requestId));",
    "const state = await authorizeRequestPayment(CLIENT_PAYMENT_SOURCES, formData);",
    'if (state.status === "redirect") {\n    redirect(state.url);\n  }',
  ]) {
    assert.ok(codeOf(actions).includes(call), call);
  }
  assert.equal(codeOf(actions).match(/\bredirect\(/g).length, 2);
  const confirm = read("app/client/requests/new/forms.tsx");
  assert.match(confirm, /^"use client";\n/);
  // MVP-001 S6 PS-A3: and the optional message.
  assert.deepEqual(
    [...codeOf(confirm).matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]),
    ["referral", "path", "modality", "duration", "slot", "message"],
  );
  const withdraw = read("app/client/requests/[request]/forms.tsx");
  assert.match(withdraw, /^"use client";\n/);
  // MVP-001 S7: the payment authorization form posts exactly the Request id
  // too, and nothing else.
  assert.deepEqual(
    [...codeOf(withdraw).matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]),
    ["request", "request"],
  );
  for (const file of [
    "app/client/requests/new/page.tsx",
    "app/client/requests/new/forms.tsx",
    "app/client/requests/[request]/page.tsx",
    "app/client/requests/[request]/forms.tsx",
    "app/client/requests/actions.ts",
    "src/application/consultation-request.ts",
    "src/presentation/request-labels.ts",
    "src/infrastructure/requests/consultation-request-adapter.ts",
  ]) {
    const code = codeOf(read(file));
    assert.doesNotMatch(
      code,
      /createClient\b|ADMIN_KEY|service_role|SERVICE_ROLE|sb_secret|registration-provisioning|\.from\(|cookies\(|headers\(|dangerouslySetInnerHTML|process\.env|setTimeout|setInterval|Date\.now\(/,
      file,
    );
    for (const specifier of importsOf(read(file))) {
      assert.doesNotMatch(
        specifier,
        /supabase-js$|@supabase\/ssr/,
        `${file}: ${specifier}`,
      );
    }
  }
  // The Intake page lists each attempt's Request through the use case.
  const intake = codeOf(read("app/client/intakes/[intake]/page.tsx"));
  assert.ok(
    intake.includes(
      "const requests = await resolveIntakeRequests(REQUEST_SOURCES, intake);",
    ),
  );
});

// ---------------------------------------------------------------------------
// MVP-001 S6 PS-A3: the request duration and the optional message
// ---------------------------------------------------------------------------

test("S6-12. PS-A3: an optional message is read as the client typed it (CRLF as LF, blank as none), counted in code points, checked by the server action against the maximum the database reports before anything is written (none: not permitted; over: too long; over the 20,000 ceiling: too long before anything is read), sent as given, and the database's own message refusals are reported", async () => {
  const valid = {
    referral: REFERRAL,
    path: "instant",
    modality: "synthetic_video",
    duration: "30",
  };
  // A blank entry is no message: no review read, nothing sent as a message.
  const blank = harness();
  assert.equal(
    (
      await createConsultationRequest(
        blank.sources,
        form({ ...valid, message: "  \r\n " }),
      )
    ).status,
    "created",
  );
  assert.equal(
    blank.calls.some((c) => c[0] === "review"),
    false,
  );
  assert.equal(blank.calls.at(-1)[1].message, null);
  // Within the maximum: the review is read first, then the binding, then the
  // write with the message as typed.
  const fits = harness({
    review: [reviewRow({ message_maximum_characters: 12 })],
  });
  assert.deepEqual(
    await createConsultationRequest(
      fits.sources,
      form({ ...valid, message: "Hello\r\nthere" }),
    ),
    { status: "created", requestId: REQUEST },
  );
  assert.deepEqual(
    fits.calls.map((c) => c[0]),
    ["review", "environmentIdentity", "createRequest"],
  );
  assert.equal(fits.calls.at(-1)[1].message, "Hello\nthere");
  // Code points, as the database counts characters.
  assert.equal(messageLength("\u{1F600}".repeat(12)), 12);
  for (const [message, expected] of [
    ["\u{1F600}".repeat(12), "created"],
    ["\u{1F600}".repeat(13), "message-too-long"],
    ["x".repeat(13), "message-too-long"],
  ]) {
    const fresh = harness({
      review: [reviewRow({ message_maximum_characters: 12 })],
    });
    assert.equal(
      (
        await createConsultationRequest(
          fresh.sources,
          form({ ...valid, message }),
        )
      ).status,
      expected,
    );
    assert.equal(
      fresh.calls.some((c) => c[0] === "createRequest"),
      expected === "created",
    );
  }
  // No maximum: a message cannot be added; nothing is written.
  const none = harness();
  assert.deepEqual(
    await createConsultationRequest(
      none.sources,
      form({ ...valid, message: "Hi" }),
    ),
    { status: "message-not-permitted" },
  );
  assert.equal(
    none.calls.some((c) => c[0] === "createRequest"),
    false,
  );
  // Over the ceiling: refused before anything is read.
  const huge = harness({
    review: [reviewRow({ message_maximum_characters: MESSAGE_CEILING })],
  });
  assert.deepEqual(
    await createConsultationRequest(
      huge.sources,
      form({ ...valid, message: "m".repeat(MESSAGE_CEILING + 1) }),
    ),
    { status: "message-too-long" },
  );
  assert.deepEqual(huge.calls, []);
  // The review gone or unreadable; a repeated message field.
  assert.deepEqual(
    await createConsultationRequest(
      harness({ review: [] }).sources,
      form({ ...valid, message: "Hi" }),
    ),
    { status: "not-found" },
  );
  assert.deepEqual(
    await createConsultationRequest(
      harness({ review: null }).sources,
      form({ ...valid, message: "Hi" }),
    ),
    { status: "unavailable" },
  );
  const repeated = harness();
  assert.deepEqual(
    await createConsultationRequest(
      repeated.sources,
      form({ ...valid, message: ["a", "b"] }),
    ),
    { status: "invalid" },
  );
  assert.deepEqual(repeated.calls, []);
  // The database decides again.
  for (const [outcome, status] of [
    ["message_not_permitted", "message-not-permitted"],
    ["message_too_long", "message-too-long"],
  ]) {
    assert.deepEqual(
      await createConsultationRequest(
        harness({
          review: [reviewRow({ message_maximum_characters: 100 })],
          createAnswer: {
            kind: "answer",
            outcome,
            requestId: null,
            problem: null,
          },
        }).sources,
        form({ ...valid, message: "Hi" }),
      ),
      { status },
    );
  }
  assert.equal(submittedMessage(undefined), null);
  assert.equal(submittedMessage(" a\r\nb "), " a\nb ");
});

test("S6-13. PS-A3: the review carries the database's message maximum, a Request carries its recorded duration and the client's own message exactly, and the pages show the maximum with a live count (over the maximum the form cannot be sent), a fixed sentence when none is set, and the message as plain text", async () => {
  const limited = await resolveRequestReview(
    harness({ review: [reviewRow({ message_maximum_characters: 500 })] })
      .sources,
    query({ referral: REFERRAL }),
  );
  assert.equal(limited.messageMaximum, 500);
  const unlimited = await resolveRequestReview(
    harness().sources,
    query({ referral: REFERRAL }),
  );
  assert.equal(unlimited.messageMaximum, null);
  const message = "Line one\n<b>two</b> & 'three'";
  const view = await resolveConsultationRequest(
    harness({
      request: [requestRow({ client_message: message, duration_minutes: 60 })],
    }).sources,
    REQUEST,
  );
  assert.equal(view.request.message, message);
  assert.equal(view.request.durationMinutes, 60);
  assert.equal(labels.messageCount(3, 10), "3 of 10 characters");
  assert.equal(
    labels.messageOverBy(1),
    "Your message is 1 character too long. Shorten it to continue.",
  );
  assert.equal(labels.NO_MESSAGE, "A message cannot be added to this request.");
  for (const status of ["message-not-permitted", "message-too-long"]) {
    const shown = labels.requestMessage({ status });
    assert.equal(shown.tone, "warning");
    assert.match(shown.body, /Nothing was requested/);
  }
  const confirm = codeOf(read("app/client/requests/new/forms.tsx"));
  for (const fragment of [
    "const used = messageLength(draft);",
    "disabled={pending || over > 0}",
    '{messageMaximum === null ? (\n            <Text tone="muted">{NO_MESSAGE}</Text>',
    "{messageCount(used, messageMaximum)}",
    "errors={over > 0 ? messageOverBy(over) : undefined}",
  ]) {
    assert.ok(confirm.includes(fragment), fragment);
  }
  const review = codeOf(read("app/client/requests/new/page.tsx"));
  assert.ok(review.includes("messageMaximum={view.messageMaximum}"));
  const detail = codeOf(read("app/client/requests/[request]/page.tsx"));
  assert.ok(
    detail.includes('{record.message.split("\\n").map((line, index) => ('),
  );
  assert.doesNotMatch(detail, /dangerouslySetInnerHTML|innerHTML/);
});

test("S6-14. PS-A3: the adapter sends the message as p_client_message and refuses a blank or over-ceiling message before anything is sent", async () => {
  const calls = [];
  const client = {
    rpc: async (name, args) => {
      calls.push([name, args]);
      return {
        data: [{ outcome: "created", request_id: REQUEST, problem: null }],
        error: null,
        status: 200,
      };
    },
  };
  const writes = await createRequestWrites(async () => client, 1000)();
  const input = {
    referralId: REFERRAL,
    path: "instant",
    modality: "synthetic_video",
    durationMinutes: 30,
    slotStart: null,
  };
  assert.deepEqual(
    await writes.createRequest({ ...input, message: "Hi\nthere" }),
    {
      kind: "answer",
      outcome: "created",
      requestId: REQUEST,
      problem: null,
    },
  );
  assert.deepEqual(calls, [
    [
      "request_create",
      {
        p_referral_id: REFERRAL,
        p_path: "instant",
        p_modality: "synthetic_video",
        p_duration_minutes: 30,
        p_slot_start: null,
        p_client_message: "Hi\nthere",
      },
    ],
  ]);
  await writes.createRequest({ ...input, message: null });
  assert.equal(calls.at(-1)[1].p_client_message, null);
  for (const message of ["   ", "", "m".repeat(MESSAGE_CEILING + 1), 7]) {
    const before = calls.length;
    assert.deepEqual(await writes.createRequest({ ...input, message }), {
      kind: "rejected",
    });
    assert.equal(calls.length, before);
  }
});
