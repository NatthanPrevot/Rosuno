// MVP-001 S8: the attorney's request queue, one request and the decision on
// it, and the client's view of the decision, driven through fake ports. The
// session, principal, read and write ports answer exactly as the trusted
// sources and the database's own functions do; every call is recorded. The
// adapter's strict answer readers, the wording and the route contracts are
// checked over the sources. Every attorney, Request, Consultation, option
// code, currency (XTS is the ISO 4217 testing code), amount and instant is
// synthetic test data.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
  ACCEPT_OUTCOMES,
  acceptAttorneyRequest,
  DECISION_OUTCOMES,
  DECLINE_OUTCOMES,
  declineAttorneyRequest,
  DETAIL_COLUMNS,
  INITIAL_DECISION_STATE,
  MAX_QUEUE,
  QUEUE_COLUMNS,
  resolveAttorneyQueue,
  resolveAttorneyRequest,
} from "../src/application/attorney-requests.ts";
import {
  DECISION_COLUMNS,
  resolveRequestDecision,
} from "../src/application/consultation-request.ts";
import {
  acceptAnswerOf,
  createAttorneyRequestReads,
  createAttorneyRequestWrites,
  declineAnswerOf,
} from "../src/infrastructure/requests/attorney-request-adapter.ts";
import {
  DECISION_OUTCOME_MESSAGES,
  decisionMessage,
} from "../src/presentation/attorney-request-labels.ts";
import * as decisionLabels from "../src/presentation/attorney-request-labels.ts";
import * as requestLabels from "../src/presentation/request-labels.ts";

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

const SUBJECT = "6f1c2d3e-4a5b-4c6d-8e7f-901234567890";
const REQUEST = "77777777-7777-4777-8777-777777777777";
const OTHER = "88888888-8888-4888-8888-888888888888";
const CONSULTATION = "99999999-9999-4999-8999-999999999999";
const INTAKE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T0 = "2026-11-20T10:00:00+00:00";
const T1 = "2026-11-20T10:30:00+00:00";
const NOW = "2026-11-18T10:00:00+00:00";

const rows = (list) => ({ kind: "rows", rows: list });
const UNREADABLE = Object.freeze({ kind: "unreadable" });
const answer = (outcome, value = null) => ({ kind: "answer", outcome, value });

function queueRow(overrides = {}) {
  return {
    request_id: REQUEST,
    request_path: "scheduled",
    requested_modality: "synthetic_video",
    duration_minutes: 30,
    slot_start_at: T0,
    slot_end_at: T1,
    attorney_listed_price_minor: 5000,
    platform_fee_minor: 500,
    currency_code: "XTS",
    response_deadline_at: "2026-11-18T11:00:00+00:00",
    decide_by: "2026-11-18T10:15:00+00:00",
    expired_due: false,
    created_at: NOW,
    ...overrides,
  };
}

function detailRow(overrides = {}) {
  const { request_id, ...rest } = queueRow();
  return {
    request_id,
    state: "awaiting_attorney",
    ...rest,
    decided_at: null,
    ended_reason: null,
    consultation_id: null,
    consultation_state: null,
    booking_starts_at: null,
    booking_ends_at: null,
    ...overrides,
  };
}

const ACCEPTED = () =>
  detailRow({
    state: "accepted",
    decide_by: null,
    decided_at: "2026-11-18T10:05:00+00:00",
    consultation_id: CONSULTATION,
    consultation_state: "scheduled",
    booking_starts_at: T0,
    booking_ends_at: T1,
  });

function world(options = {}) {
  const calls = [];
  const state = {
    subject: SUBJECT,
    stage: "approved",
    queue: rows([queueRow()]),
    request: rows([detailRow()]),
    environment: rows([
      { environment_class: "development", project_ref: null },
    ]),
    configuredClass: "development",
    acceptAnswer: answer("accepted", CONSULTATION),
    declineAnswer: answer("declined"),
    ...options,
  };
  const sources = Object.freeze({
    session: { currentSubject: async () => state.subject },
    attorney: {
      contextsOf: async () => (state.stage === null ? [] : ["attorney"]),
      principalOf: async (subject) => {
        calls.push(["principal", subject]);
        return state.stage === null
          ? { contexts: [], stage: null }
          : { contexts: ["attorney"], stage: state.stage };
      },
    },
    reads: async () => ({
      queue: async () => {
        calls.push(["queue"]);
        return state.queue;
      },
      request: async (id) => {
        calls.push(["request", id]);
        return state.request;
      },
      environmentIdentity: async () => {
        calls.push(["environmentIdentity"]);
        return state.environment;
      },
    }),
    writes: async () => ({
      accept: async (id) => {
        calls.push(["accept", id]);
        return state.acceptAnswer;
      },
      decline: async (id) => {
        calls.push(["decline", id]);
        return state.declineAnswer;
      },
    }),
    environment: () => ({
      configuredClass: state.configuredClass,
      expectedProjectRef: null,
    }),
  });
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

test("S8-APP-1. the queue shows exactly the database's own Requests awaiting the attorney, read strictly; nothing is read without an admitted attorney principal; an unexpected column (the client, the message, the Intake) or value makes the whole queue unavailable", async () => {
  const { sources, calls } = world();
  const view = await resolveAttorneyQueue(sources);
  assert.equal(view.status, "ready");
  assert.deepEqual(
    view.entries.map((e) => [
      e.id,
      e.path,
      e.durationMinutes,
      e.listedPriceMinor,
      e.platformFeeMinor,
      e.currency,
      e.decideBy,
      e.expiredDue,
    ]),
    [
      [
        REQUEST,
        "scheduled",
        30,
        5000,
        500,
        "XTS",
        "2026-11-18T10:15:00+00:00",
        false,
      ],
    ],
  );
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["principal", "queue"],
  );
  const anonymous = world({ subject: null });
  assert.deepEqual(await resolveAttorneyQueue(anonymous.sources), {
    status: "sign-in-required",
  });
  assert.deepEqual(anonymous.calls, []);
  const client = world({ stage: null });
  assert.deepEqual(await resolveAttorneyQueue(client.sources), {
    status: "denied",
  });
  assert.equal(
    client.calls.some((c) => c[0] === "queue"),
    false,
  );
  assert.deepEqual(
    await resolveAttorneyQueue(world({ queue: rows([]) }).sources),
    { status: "ready", entries: [] },
  );
  const instant = await resolveAttorneyQueue(
    world({
      queue: rows([
        queueRow({
          request_path: "instant",
          slot_start_at: null,
          slot_end_at: null,
        }),
      ]),
    }).sources,
  );
  assert.equal(instant.entries[0].slotStart, null);
  for (const queue of [
    UNREADABLE,
    rows([{ ...queueRow(), client_message: "x" }]),
    rows([{ ...queueRow(), intake_id: INTAKE }]),
    rows([{ ...queueRow(), client_id: INTAKE }]),
    rows([queueRow({ request_path: "later" })]),
    rows([queueRow({ requested_modality: "Video" })]),
    rows([queueRow({ duration_minutes: 0 })]),
    rows([queueRow({ attorney_listed_price_minor: 0 })]),
    rows([queueRow({ platform_fee_minor: -1 })]),
    rows([queueRow({ currency_code: "xts" })]),
    rows([queueRow({ slot_start_at: null })]),
    rows([queueRow({ request_path: "instant" })]),
    rows([queueRow({ expired_due: "no" })]),
    rows([queueRow({ decide_by: "soon" })]),
    rows([queueRow(), queueRow()]),
    rows(
      Array.from({ length: MAX_QUEUE + 1 }, (_, i) =>
        queueRow({
          request_id: `77777777-7777-4777-8777-${String(i).padStart(12, "0")}`,
        }),
      ),
    ),
  ]) {
    assert.deepEqual(await resolveAttorneyQueue(world({ queue }).sources), {
      status: "unavailable",
    });
  }
  assert.deepEqual(QUEUE_COLUMNS.includes("client_message"), false);
});

test("S8-APP-2. one Request: a malformed id is not found before anything is read, no row is not found (another attorney's, unknown or never offered alike), the server's expiry flag shows expired and offers no decision, a Request that could not go ahead is shown so, and an accepted one carries its Consultation and Booking", async () => {
  const malformed = world();
  assert.deepEqual(await resolveAttorneyRequest(malformed.sources, "x"), {
    status: "not-found",
  });
  assert.deepEqual(malformed.calls, []);
  assert.deepEqual(
    await resolveAttorneyRequest(world({ request: rows([]) }).sources, REQUEST),
    { status: "not-found" },
  );
  const open = await resolveAttorneyRequest(world().sources, REQUEST);
  assert.deepEqual(
    [open.status, open.displayState, open.decidable],
    ["ready", "awaiting_attorney", true],
  );
  const due = await resolveAttorneyRequest(
    world({ request: rows([detailRow({ expired_due: true })]) }).sources,
    REQUEST,
  );
  assert.deepEqual([due.displayState, due.decidable], ["expired", false]);
  const ended = await resolveAttorneyRequest(
    world({
      request: rows([
        detailRow({
          state: "cancelled",
          decide_by: null,
          ended_reason: "could_not_proceed",
        }),
      ]),
    }).sources,
    REQUEST,
  );
  assert.deepEqual(
    [ended.displayState, ended.decidable],
    ["could_not_proceed", false],
  );
  const accepted = await resolveAttorneyRequest(
    world({ request: rows([ACCEPTED()]) }).sources,
    REQUEST,
  );
  assert.deepEqual(
    [
      accepted.displayState,
      accepted.decidable,
      accepted.request.consultationState,
      accepted.request.bookingStart,
    ],
    ["accepted", false, "scheduled", T0],
  );
  const deferred = await resolveAttorneyRequest(
    world({
      request: rows([
        detailRow({
          state: "accepted",
          decide_by: null,
          decided_at: NOW,
        }),
      ]),
    }).sources,
    REQUEST,
  );
  assert.equal(deferred.request.consultationId, null);
  for (const request of [
    UNREADABLE,
    rows([detailRow(), detailRow()]),
    rows([{ ...detailRow(), client_message: "x" }]),
    rows([detailRow({ request_id: OTHER })]),
    rows([detailRow({ state: "slot_held" })]),
    rows([detailRow({ state: "accepted" })]),
    rows([detailRow({ decided_at: NOW })]),
    rows([detailRow({ ended_reason: "declined" })]),
    rows([detailRow({ state: "declined", decided_at: NOW })]),
    rows([
      detailRow({
        consultation_id: CONSULTATION,
        consultation_state: "scheduled",
      }),
    ]),
    rows([{ ...ACCEPTED(), consultation_state: "booked" }]),
    rows([{ ...ACCEPTED(), consultation_id: null }]),
    rows([{ ...ACCEPTED(), booking_ends_at: null }]),
    rows([
      detailRow({
        state: "declined",
        decided_at: NOW,
        ended_reason: "declined",
        expired_due: true,
      }),
    ]),
  ]) {
    assert.deepEqual(
      await resolveAttorneyRequest(world({ request }).sources, REQUEST),
      { status: "unavailable" },
      JSON.stringify(request).slice(0, 120),
    );
  }
  assert.deepEqual(
    await resolveAttorneyRequest(world({ subject: null }).sources, REQUEST),
    { status: "sign-in-required" },
  );
  assert.equal(DETAIL_COLUMNS.includes("client_message"), false);
});

test("S8-APP-3. a decision checks its one request id, the attorney principal and the environment binding, sends exactly that id, and reports only the database's fixed outcome; a refusal, a rejected call and an unknown answer never read as success", async () => {
  const accepted = world();
  assert.deepEqual(
    await acceptAttorneyRequest(accepted.sources, form({ request: REQUEST })),
    { status: "outcome", outcome: "request_accepted" },
  );
  assert.deepEqual(
    accepted.calls.map((c) => c[0]),
    ["principal", "environmentIdentity", "accept"],
  );
  assert.deepEqual(accepted.calls[2], ["accept", REQUEST]);
  const declined = world();
  assert.deepEqual(
    await declineAttorneyRequest(declined.sources, form({ request: REQUEST })),
    { status: "outcome", outcome: "request_declined" },
  );
  assert.deepEqual(declined.calls[2], ["decline", REQUEST]);
  for (const [outcome, expected] of [
    ["not_found", "not_found"],
    ["expired", "expired"],
    ["withdrawn", "withdrawn"],
    ["already_decided", "already_decided"],
    ["configuration_unavailable", "configuration_unavailable"],
    ["payment_not_ready", "payment_not_ready"],
    ["not_eligible", "not_eligible"],
    ["eligibility_unavailable", "eligibility_unavailable"],
    ["not_bookable", "not_bookable"],
    ["conflict", "conflict"],
  ]) {
    assert.deepEqual(
      await acceptAttorneyRequest(
        world({ acceptAnswer: answer(outcome) }).sources,
        form({ request: REQUEST }),
      ),
      { status: "outcome", outcome: expected },
      outcome,
    );
  }
  assert.deepEqual(
    await acceptAttorneyRequest(
      world({ acceptAnswer: answer("denied") }).sources,
      form({ request: REQUEST }),
    ),
    { status: "denied" },
  );
  assert.deepEqual(
    await acceptAttorneyRequest(
      world({ acceptAnswer: answer("invalid") }).sources,
      form({ request: REQUEST }),
    ),
    { status: "invalid" },
  );
  assert.deepEqual(
    await acceptAttorneyRequest(
      world({ acceptAnswer: answer("made_up") }).sources,
      form({ request: REQUEST }),
    ),
    { status: "unconfirmed" },
  );
  assert.deepEqual(
    await acceptAttorneyRequest(
      world({ acceptAnswer: { kind: "rejected" } }).sources,
      form({ request: REQUEST }),
    ),
    { status: "unavailable" },
  );
  assert.deepEqual(
    await declineAttorneyRequest(
      world({ declineAnswer: answer("accepted") }).sources,
      form({ request: REQUEST }),
    ),
    { status: "unconfirmed" },
  );
  // Nothing is sent for a malformed or repeated id, without the principal,
  // or with a mismatched or unrecorded environment.
  for (const fields of [{}, { request: "x" }, { request: [REQUEST, OTHER] }]) {
    const w = world();
    assert.deepEqual(await acceptAttorneyRequest(w.sources, form(fields)), {
      status: "outcome",
      outcome: "not_found",
    });
    assert.deepEqual(w.calls, []);
  }
  for (const [options, expected] of [
    [{ subject: null }, { status: "sign-in-required" }],
    [{ stage: null }, { status: "denied" }],
    [{ configuredClass: "staging" }, { status: "unavailable" }],
    [{ environment: rows([]) }, { status: "unavailable" }],
  ]) {
    const w = world(options);
    assert.deepEqual(
      await acceptAttorneyRequest(w.sources, form({ request: REQUEST })),
      expected,
    );
    assert.equal(
      w.calls.some((c) => c[0] === "accept"),
      false,
    );
  }
  assert.deepEqual(INITIAL_DECISION_STATE, { status: "idle" });
});

test("S8-APP-4. the adapter reads each decision answer strictly and sends exactly the named argument; a malformed id is refused before anything is sent", async () => {
  assert.deepEqual(
    acceptAnswerOf({
      data: [
        { outcome: "accepted", consultation_id: CONSULTATION, problem: null },
      ],
      error: null,
      status: 200,
    }),
    answer("accepted", CONSULTATION),
  );
  assert.deepEqual(
    acceptAnswerOf({
      data: [{ outcome: "accepted", consultation_id: null, problem: null }],
      error: null,
      status: 200,
    }),
    answer("accepted"),
  );
  assert.deepEqual(
    acceptAnswerOf({
      data: [
        { outcome: "not_bookable", consultation_id: null, problem: "blackout" },
      ],
      error: null,
      status: 200,
    }),
    answer("not_bookable"),
  );
  for (const result of [
    {
      data: [{ outcome: "won", consultation_id: null, problem: null }],
      error: null,
    },
    {
      data: [
        { outcome: "expired", consultation_id: CONSULTATION, problem: null },
      ],
      error: null,
    },
    {
      data: [{ outcome: "accepted", consultation_id: "x", problem: null }],
      error: null,
    },
    {
      data: [
        { outcome: "accepted", consultation_id: null, problem: "Not Snake" },
      ],
      error: null,
    },
    { data: [{ outcome: "accepted", consultation_id: null }], error: null },
    {
      data: [
        { outcome: "accepted", consultation_id: null, problem: null, extra: 1 },
      ],
      error: null,
    },
    { data: [], error: null },
    { data: null, error: null },
  ]) {
    assert.deepEqual(acceptAnswerOf(result), { kind: "unreadable" });
  }
  assert.deepEqual(
    acceptAnswerOf({ data: null, error: { code: "55P03" }, status: 500 }),
    { kind: "rejected" },
  );
  assert.deepEqual(
    acceptAnswerOf({ data: null, error: { code: "08006" }, status: 503 }),
    { kind: "unreadable" },
  );
  assert.deepEqual(
    declineAnswerOf({
      data: [{ outcome: "declined" }],
      error: null,
      status: 200,
    }),
    answer("declined"),
  );
  for (const result of [
    { data: [{ outcome: "accepted" }], error: null },
    { data: "declined", error: null },
    { data: [{ outcome: "declined", extra: 1 }], error: null },
  ]) {
    assert.deepEqual(declineAnswerOf(result), { kind: "unreadable" });
  }
  assert.deepEqual([...ACCEPT_OUTCOMES].sort(), [
    "accepted",
    "already_decided",
    "configuration_unavailable",
    "conflict",
    "denied",
    "eligibility_unavailable",
    "expired",
    "invalid",
    "not_bookable",
    "not_eligible",
    "not_found",
    "payment_not_ready",
    "withdrawn",
  ]);
  assert.deepEqual([...DECLINE_OUTCOMES].sort(), [
    "already_decided",
    "declined",
    "denied",
    "expired",
    "invalid",
    "not_found",
    "withdrawn",
  ]);
  const calls = [];
  const client = {
    rpc: async (name, args) => {
      calls.push([name, args]);
      if (name === "attorney_accept_request") {
        return {
          data: [{ outcome: "accepted", consultation_id: null, problem: null }],
          error: null,
        };
      }
      if (name === "attorney_decline_request") {
        return { data: [{ outcome: "declined" }], error: null };
      }
      return { data: [], error: null };
    },
  };
  const writes = await createAttorneyRequestWrites(async () => client, 1000)();
  await writes.accept(REQUEST);
  await writes.decline(REQUEST);
  assert.deepEqual(await writes.accept("x"), { kind: "rejected" });
  assert.deepEqual(await writes.decline("x"), { kind: "rejected" });
  const reads = await createAttorneyRequestReads(async () => client, 1000)();
  await reads.queue();
  await reads.request(REQUEST);
  assert.deepEqual(await reads.request("x"), { kind: "unreadable" });
  await reads.environmentIdentity();
  assert.deepEqual(calls, [
    ["attorney_accept_request", { p_request_id: REQUEST }],
    ["attorney_decline_request", { p_request_id: REQUEST }],
    ["attorney_requests", undefined],
    ["attorney_request", { p_request_id: REQUEST }],
    ["deployment_environment_identity", undefined],
  ]);
});

test("S8-APP-5. the client's decision read is strict and answers only fixed facts: the decision instant, how the Request ended, the Consultation's state, the Booking's times and the client's own Intake; nothing of the attorney's contact details; another client's or an unknown Request is not found", async () => {
  const ACCOUNT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const CLIENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const decisionRow = (overrides = {}) => ({
    request_id: REQUEST,
    state: "accepted",
    decided_at: NOW,
    ended_reason: null,
    consultation_id: CONSULTATION,
    consultation_state: "scheduled",
    booking_starts_at: T0,
    booking_ends_at: T1,
    intake_id: INTAKE,
    ...overrides,
  });
  const calls = [];
  const sourcesWith = (answerRows, subject = ACCOUNT) => ({
    session: { currentSubject: async () => subject },
    clientIntake: {
      session: { currentSubject: async () => subject },
      contexts: { contextsOf: async () => ["client"] },
      account: {
        currentAccount: async () => ({
          kind: "user",
          id: subject,
          emailConfirmedAt: "2026-11-01T00:00:00Z",
        }),
      },
      reads: async () => ({
        usersOf: async (a) =>
          rows(
            a === ACCOUNT
              ? [{ id: USER, auth_user_id: ACCOUNT, account_state: "active" }]
              : [],
          ),
        clientProfilesOf: async (u) =>
          rows(u === USER ? [{ id: CLIENT, user_id: USER }] : []),
      }),
      writes: async () => ({}),
    },
    reads: async () => ({
      decision: async (id) => {
        calls.push(["decision", id]);
        return answerRows;
      },
    }),
  });
  const read = (answerRows) =>
    resolveRequestDecision(sourcesWith(answerRows), REQUEST);
  assert.equal(DECISION_COLUMNS.includes("attorney_email"), false);
  assert.deepEqual(await resolveRequestDecision(sourcesWith(rows([])), "x"), {
    status: "not-found",
  });
  assert.deepEqual(calls, []);
  const accepted = await read(rows([decisionRow()]));
  assert.equal(accepted.status, "ready");
  assert.deepEqual(
    [
      accepted.decision.state,
      accepted.decision.consultationState,
      accepted.decision.bookingStart,
      accepted.decision.intakeId,
    ],
    ["accepted", "scheduled", T0, INTAKE],
  );
  assert.deepEqual(calls, [["decision", REQUEST]]);
  const declined = await read(
    rows([
      decisionRow({
        state: "declined",
        ended_reason: "declined",
        consultation_id: null,
        consultation_state: null,
        booking_starts_at: null,
        booking_ends_at: null,
      }),
    ]),
  );
  assert.equal(declined.decision.endedReason, "declined");
  const ended = await read(
    rows([
      decisionRow({
        state: "cancelled",
        decided_at: null,
        ended_reason: "could_not_proceed",
        consultation_id: null,
        consultation_state: null,
        booking_starts_at: null,
        booking_ends_at: null,
      }),
    ]),
  );
  assert.equal(ended.decision.endedReason, "could_not_proceed");
  assert.deepEqual(await read(rows([])), { status: "not-found" });
  for (const bad of [
    UNREADABLE,
    rows([decisionRow(), decisionRow()]),
    rows([{ ...decisionRow(), attorney_email: "x" }]),
    rows([decisionRow({ state: "declined" })]),
    rows([decisionRow({ ended_reason: "declined" })]),
    rows([decisionRow({ consultation_state: null })]),
    rows([decisionRow({ consultation_state: "booked" })]),
    rows([decisionRow({ booking_ends_at: null })]),
    rows([decisionRow({ intake_id: "x" })]),
    rows([decisionRow({ request_id: OTHER })]),
  ]) {
    assert.deepEqual(await read(bad), { status: "unavailable" });
  }
  // Without a signed-in, verified client nothing is read.
  const before = calls.length;
  assert.deepEqual(
    await resolveRequestDecision(
      sourcesWith(rows([decisionRow()]), null),
      REQUEST,
    ),
    { status: "unavailable" },
  );
  assert.equal(calls.length, before);
});

test("S8-APP-6. wording: every decision outcome has its own fixed message; nothing recommends, ranks or names another attorney, claims a regulatory status, writes legal or engagement terms, or describes the client", () => {
  for (const outcome of DECISION_OUTCOMES) {
    assert.ok(DECISION_OUTCOME_MESSAGES[outcome], outcome);
  }
  assert.equal(
    new Set(Object.values(DECISION_OUTCOME_MESSAGES).map((m) => m.title)).size,
    DECISION_OUTCOMES.length,
  );
  for (const status of [
    "invalid",
    "unconfirmed",
    "sign-in-required",
    "denied",
    "unavailable",
    "step-up-required",
  ]) {
    assert.ok(decisionMessage({ status }) !== null, status);
  }
  assert.equal(decisionMessage({ status: "idle" }), null);
  const texts = [
    ...Object.values(DECISION_OUTCOME_MESSAGES).flatMap((m) => [
      m.title,
      m.body,
    ]),
    ...Object.values(decisionLabels).filter((v) => typeof v === "string"),
    requestLabels.DECISION_ACCEPTED,
    requestLabels.DECISION_CONSULTATION_PENDING,
    requestLabels.DECISION_DECLINED,
    requestLabels.DECISION_COULD_NOT_PROCEED,
    codeOf(read("app/attorney/requests/page.tsx")),
    codeOf(read("app/attorney/requests/[request]/page.tsx")),
    codeOf(read("app/attorney/requests/[request]/forms.tsx")),
  ];
  for (const text of texts) {
    assert.doesNotMatch(
      text,
      /best match|recommended|recommend|top rated|top-rated|cheapest|perfect attorney|right lawyer|approved by the|licensed by the|live in your state|guarantee|law applies|attorney-client|engagement letter|retainer|terms of engagement|legal advice|eligible|verified|client name|client email|phone/i,
      text.slice(0, 80),
    );
  }
});

test("S8-APP-7. the attorney request routes are exactly the gated queue, the gated request page, its forms and its gated actions; the pages read nothing of their own from the request beyond the request id segment, never the client's message or Intake, and reach the database only through the attorney request use cases and production sources, without a privileged client; the workspace links to the queue", () => {
  assert.deepEqual(filesIn("app/attorney/requests/"), [
    "app/attorney/requests/[request]/forms.tsx",
    "app/attorney/requests/[request]/page.tsx",
    "app/attorney/requests/actions.ts",
    "app/attorney/requests/page.tsx",
  ]);
  const queue = codeOf(read("app/attorney/requests/page.tsx"));
  assert.ok(
    queue.includes(
      '  await connection();\n  await requireSteppedUp("attorney");\n  const view = await resolveAttorneyQueue(ATTORNEY_REQUEST_SOURCES);\n',
    ),
  );
  assert.doesNotMatch(
    queue,
    /searchParams|\bparams\b|headers\(|cookies\(|<form|\baction=/,
  );
  const detail = codeOf(read("app/attorney/requests/[request]/page.tsx"));
  assert.ok(
    detail.includes(
      '  await connection();\n  await requireSteppedUp("attorney");\n  const { request } = await params;\n  const view = await resolveAttorneyRequest(ATTORNEY_REQUEST_SOURCES, request);\n',
    ),
  );
  assert.doesNotMatch(detail, /searchParams|headers\(|cookies\(|<form/);
  for (const page of [queue, detail]) {
    assert.match(page, /robots: \{ index: false, follow: false \},/);
    assert.doesNotMatch(page, /message|intake|clientId|client_id|voice/i);
  }
  const actions = read("app/attorney/requests/actions.ts");
  assert.match(actions, /^"use server";\n/);
  for (const call of [
    "return gated(() => acceptAttorneyRequest(ATTORNEY_REQUEST_SOURCES, formData));",
    'revalidatePath("/attorney/requests");',
  ]) {
    assert.ok(codeOf(actions).includes(call), call);
  }
  const forms = read("app/attorney/requests/[request]/forms.tsx");
  assert.match(forms, /^"use client";\n/);
  assert.deepEqual(
    [...codeOf(forms).matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]),
    ["request", "request"],
  );
  for (const file of [
    "app/attorney/requests/page.tsx",
    "app/attorney/requests/[request]/page.tsx",
    "app/attorney/requests/[request]/forms.tsx",
    "app/attorney/requests/actions.ts",
    "src/application/attorney-requests.ts",
    "src/presentation/attorney-request-labels.ts",
    "src/infrastructure/requests/attorney-request-adapter.ts",
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
  for (const specifier of importsOf(
    read("src/application/attorney-requests.ts"),
  )) {
    assert.match(specifier, /^\.\/[a-z-]+\.ts$/, specifier);
  }
  assert.equal(
    codeOf(read("app/attorney/page.tsx")).match(/href="\/attorney\/requests"/g)
      .length,
    1,
  );
});

test("S8-APP-8. the client's request page shows the decision the database reports: the Consultation's state and time after an acceptance, and after a decline or a Request that could not go ahead only a link back to the client's own Intake (Rosuno names no other attorney); the decision read failing never hides the Request", () => {
  const page = codeOf(read("app/client/requests/[request]/page.tsx"));
  assert.ok(
    page.includes(
      "const decisionView = await resolveRequestDecision(REQUEST_SOURCES, record.id);",
    ),
  );
  assert.ok(page.includes("href={`/client/intakes/${decision.intakeId}`}"));
  assert.doesNotMatch(page, /href=\{`\/attorneys\//);
  assert.doesNotMatch(page, /attorney_email|attorneyEmail|phone/i);
  assert.ok(page.includes('decision.endedReason === "declined"'));
  assert.ok(page.includes('decision.endedReason === "could_not_proceed"'));
});
