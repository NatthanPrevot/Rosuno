// MVP-001 S9 application tests: the client's and the attorney's Consultation
// workspaces (MBS section 14; IMP section 25; TA sections 46 and 48; DM
// section 2.4; Packet section 2 rules 7 and 13).
//
// The use cases run over synthetic, in-memory ports (no database, provider
// or network): the strict read models, the refusals (sign-in, denied,
// unavailable, not found alike for a malformed id), the server-derived
// display state and offered actions, the join flow (media configured, the
// environment bound, the database's media access, one bounded worker run
// and one more ask while the room is prepared, the meeting token asked with
// exactly the database's room, role, User id and times, and the frame
// address returned only in the action's answer), the start and end outcome
// tables, the adapter's strict answer readers, the presentation labels for
// every outcome, and the source contracts of the new routes (server pages
// that opt out of prerendering, the attorney pages and actions behind the
// step-up gate, the frame only in the client form modules, with the fixed
// permissions, and no token, key or provider name in any page).

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
  ACCESS_OUTCOMES,
  COMMAND_OUTCOMES,
  END_OUTCOMES,
  endConsultation,
  JOIN_OUTCOMES,
  joinAttorneyConsultation,
  joinClientConsultation,
  resolveAttorneyConsultation,
  resolveAttorneyConsultations,
  resolveClientConsultation,
  START_OUTCOMES,
  startConsultation,
  VIEW_COLUMNS,
} from "../src/application/consultations.ts";
import {
  accessAnswerOf,
  endAnswerOf,
  startAnswerOf,
} from "../src/infrastructure/consultations/consultation-adapter.ts";
import * as labels from "../src/presentation/consultation-labels.ts";

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
const ACCOUNT = SUBJECT;
const USER = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const CONSULTATION = "99999999-9999-4999-8999-999999999999";
const ROOM = `r${"ab".repeat(16)}`;
const NOW = Date.parse("2026-11-20T10:05:00Z");
const OPENS = "2026-11-20T10:00:00+00:00";
const CLOSES = "2026-11-20T10:35:00+00:00";

const rows = (list) => ({ kind: "rows", rows: list });
const UNREADABLE = Object.freeze({ kind: "unreadable" });

function viewRow(overrides = {}) {
  return {
    consultation_id: CONSULTATION,
    state: "ready",
    ready_due: false,
    request_path: "instant",
    modality: "synthetic_video",
    duration_minutes: 30,
    booking_starts_at: null,
    booking_ends_at: null,
    opens_at: OPENS,
    closes_at: CLOSES,
    started_at: null,
    ended_at: null,
    outcome_code: null,
    media_state: "open",
    attorney_joined_at: null,
    attorney_left_at: null,
    client_joined_at: null,
    client_left_at: null,
    both_present: false,
    either_left: false,
    provider_sessions: 0,
    reconnections: 0,
    ...overrides,
  };
}

const listRow = (overrides = {}) => {
  const full = viewRow(overrides);
  return Object.fromEntries(
    [
      "consultation_id",
      "state",
      "ready_due",
      "request_path",
      "modality",
      "duration_minutes",
      "booking_starts_at",
      "booking_ends_at",
      "opens_at",
      "closes_at",
      "started_at",
    ].map((key) => [key, full[key]]),
  );
};

const grant = (role, overrides = {}) => ({
  kind: "answer",
  outcome: "granted",
  grant: {
    roomName: ROOM,
    role,
    userId: USER,
    notBefore: OPENS,
    expiresAt: "2026-11-20T10:15:00+00:00",
  },
  opensAt: OPENS,
  ...overrides,
});
const refusal = (outcome) => ({
  kind: "answer",
  outcome,
  grant: null,
  opensAt: null,
});

function world(options = {}) {
  const calls = [];
  const state = {
    subject: SUBJECT,
    stage: "approved",
    view: rows([viewRow()]),
    list: rows([listRow()]),
    environment: rows([
      { environment_class: "development", project_ref: null },
    ]),
    configuredClass: "development",
    access: [grant("client")],
    startAnswer: { kind: "answer", outcome: "started" },
    endAnswer: { kind: "answer", outcome: "completed" },
    media: true,
    tokenAnswer: { kind: "ok", value: "synthetic.token.value-1234567890" },
    ...options,
  };
  const reads = async () => ({
    client: async (id) => {
      calls.push(["client", id]);
      return state.view;
    },
    attorney: async (id) => {
      calls.push(["attorney", id]);
      return state.view;
    },
    attorneyList: async () => {
      calls.push(["list"]);
      return state.list;
    },
    environmentIdentity: async () => state.environment,
  });
  const writes = async () => ({
    access: async (id) => {
      calls.push(["access", id]);
      return state.access.length > 1 ? state.access.shift() : state.access[0];
    },
    start: async (id) => {
      calls.push(["start", id]);
      return state.startAnswer;
    },
    end: async (id) => {
      calls.push(["end", id]);
      return state.endAnswer;
    },
  });
  const shared = {
    reads,
    writes,
    environment: () => ({
      configuredClass: state.configuredClass,
      expectedProjectRef: null,
    }),
    media: async () =>
      state.media
        ? {
            provider: {
              createMeetingToken: async (input) => {
                calls.push(["token", input]);
                return state.tokenAnswer;
              },
            },
            frameUrl: (room, token) =>
              `https://rosuno-l1.daily.co/${room}?t=${token}`,
          }
        : null,
    drain: async () => {
      calls.push(["drain"]);
    },
    clock: () => NOW,
  };
  const client = Object.freeze({
    ...shared,
    clientIntake: {
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
            a === ACCOUNT
              ? [{ id: USER, auth_user_id: ACCOUNT, account_state: "active" }]
              : [],
          ),
        clientProfilesOf: async (u) =>
          rows(u === USER ? [{ id: CLIENT, user_id: USER }] : []),
      }),
      writes: async () => ({}),
    },
  });
  const attorney = Object.freeze({
    ...shared,
    session: { currentSubject: async () => state.subject },
    attorney: {
      contextsOf: async () => (state.stage === null ? [] : ["attorney"]),
      principalOf: async () =>
        state.stage === null
          ? { contexts: [], stage: null }
          : { contexts: ["attorney"], stage: state.stage },
    },
  });
  return { client, attorney, calls, state };
}

const form = (fields) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.append(key, value);
  }
  return data;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test("S9-1. the client's consultation is read strictly through the verified client: the server state, ready as soon as the server reports the window open (ready_due), the window, the room state and the attendance; joining is offered only once the consultation is live inside the server-reported window on an open room, and the waiting room while it is ready (correction F4); another client's, an unknown and a malformed id answer not found alike", async () => {
  const w = world();
  const view = await resolveClientConsultation(w.client, CONSULTATION);
  assert.equal(view.status, "ready");
  // Correction F4: ready means the waiting room, never the room itself.
  assert.deepEqual(
    [
      view.displayState,
      view.joinable,
      view.waiting,
      view.startable,
      view.endable,
    ],
    ["ready", false, true, false, false],
  );
  assert.deepEqual(w.calls, [["client", CONSULTATION]]);
  const due = await resolveClientConsultation(
    world({ view: rows([viewRow({ state: "scheduled", ready_due: true })]) })
      .client,
    CONSULTATION,
  );
  assert.deepEqual(
    [due.displayState, due.consultation.state],
    ["ready", "scheduled"],
  );
  const live = { state: "live", started_at: OPENS };
  for (const [overrides, joinable, waiting] of [
    [{}, false, true],
    [{ state: "scheduled", ready_due: true }, false, true],
    [{ ...live }, true, false],
    [{ ...live, opens_at: "2026-11-20T10:06:00+00:00" }, false, false],
    [{ ...live, closes_at: "2026-11-20T10:05:00+00:00" }, false, false],
    [{ ...live, media_state: "closing" }, false, false],
    [{ ...live, media_state: "pending" }, true, false],
    [{ ...live, opens_at: null, closes_at: null }, false, false],
    [{ opens_at: "2026-11-20T10:06:00+00:00" }, false, false],
    [{ closes_at: "2026-11-20T10:05:00+00:00" }, false, false],
    [{ state: "scheduled" }, false, false],
  ]) {
    const v = await resolveClientConsultation(
      world({ view: rows([viewRow(overrides)]) }).client,
      CONSULTATION,
    );
    assert.equal(v.joinable, joinable, JSON.stringify(overrides));
    assert.equal(v.waiting, waiting, JSON.stringify(overrides));
    assert.equal(
      v.windowPassed,
      overrides.closes_at === "2026-11-20T10:05:00+00:00",
      JSON.stringify(overrides),
    );
  }
  assert.deepEqual(
    await resolveClientConsultation(
      world({ view: rows([]) }).client,
      CONSULTATION,
    ),
    { status: "not-found" },
  );
  const malformed = world();
  assert.deepEqual(
    await resolveClientConsultation(malformed.client, "not-an-id"),
    { status: "not-found" },
  );
  assert.deepEqual(malformed.calls, []);
  for (const bad of [
    rows([{ ...viewRow(), extra: 1 }]),
    rows([viewRow({ state: "unknown" })]),
    rows([viewRow({ ready_due: true })]),
    rows([viewRow({ opens_at: null })]),
    rows([viewRow({ state: "live", started_at: null })]),
    rows([viewRow({ outcome_code: "normal" })]),
    rows([viewRow({ media_state: "gone" })]),
    rows([viewRow({ reconnections: -1 })]),
    rows([viewRow(), viewRow()]),
    UNREADABLE,
  ]) {
    assert.deepEqual(
      await resolveClientConsultation(
        world({ view: bad }).client,
        CONSULTATION,
      ),
      { status: "unavailable" },
    );
  }
  assert.deepEqual(
    await resolveClientConsultation(
      world({ subject: null }).client,
      CONSULTATION,
    ),
    { status: "sign-in-required" },
  );
  assert.deepEqual(Object.keys(viewRow()), [...VIEW_COLUMNS]);
});

test("S9-2. the attorney's consultation and list are read through the Security Shell: start offered while ready inside the window, end while live; the list holds only scheduled, ready and live entries; refusals are fixed", async () => {
  const w = world();
  const view = await resolveAttorneyConsultation(w.attorney, CONSULTATION);
  // Correction F4: while ready, the start (no join before the start).
  assert.deepEqual(
    [view.status, view.joinable, view.waiting, view.startable, view.endable],
    ["ready", false, true, true, false],
  );
  const live = await resolveAttorneyConsultation(
    world({
      view: rows([viewRow({ state: "live", started_at: OPENS })]),
    }).attorney,
    CONSULTATION,
  );
  assert.deepEqual(
    [live.joinable, live.waiting, live.startable, live.endable],
    [true, false, false, true],
  );
  const ended = await resolveAttorneyConsultation(
    world({
      view: rows([
        viewRow({
          state: "completed",
          started_at: OPENS,
          ended_at: "2026-11-20T10:04:00+00:00",
          outcome_code: "normal",
          media_state: "closed",
        }),
      ]),
    }).attorney,
    CONSULTATION,
  );
  assert.deepEqual(
    [ended.joinable, ended.startable, ended.endable],
    [false, false, false],
  );
  const list = await resolveAttorneyConsultations(world().attorney);
  assert.deepEqual(
    [list.status, list.entries.length, list.entries[0].id],
    ["ready", 1, CONSULTATION],
  );
  assert.deepEqual(
    await resolveAttorneyConsultations(
      world({ list: rows([listRow({ state: "completed" })]) }).attorney,
    ),
    { status: "unavailable" },
  );
  assert.deepEqual(
    await resolveAttorneyConsultations(world({ stage: null }).attorney),
    { status: "denied" },
  );
  assert.deepEqual(
    await resolveAttorneyConsultation(
      world({ subject: null }).attorney,
      CONSULTATION,
    ),
    { status: "sign-in-required" },
  );
});

// ---------------------------------------------------------------------------
// Joining (TA section 46)
// ---------------------------------------------------------------------------

test("S9-3. joining: the database's media access first; on a grant, exactly one meeting token for the database's room, role, User id and times (epoch seconds); the frame address comes back only in the action's answer; a room still being prepared gets one bounded worker run and one more ask; every refusal is a fixed outcome and asks for no token", async () => {
  const w = world();
  const state = await joinClientConsultation(
    w.client,
    form({ consultation: CONSULTATION }),
  );
  assert.deepEqual(state, {
    status: "granted",
    frameUrl: `https://rosuno-l1.daily.co/${ROOM}?t=synthetic.token.value-1234567890`,
    expiresAt: "2026-11-20T10:15:00+00:00",
  });
  assert.deepEqual(w.calls, [
    ["access", CONSULTATION],
    [
      "token",
      {
        roomName: ROOM,
        userId: USER,
        role: "client",
        notBefore: Date.parse(OPENS) / 1000,
        expiresAt: Date.parse("2026-11-20T10:15:00+00:00") / 1000,
      },
    ],
  ]);
  const preparing = world({ access: [refusal("preparing"), grant("client")] });
  assert.equal(
    (
      await joinClientConsultation(
        preparing.client,
        form({ consultation: CONSULTATION }),
      )
    ).status,
    "granted",
  );
  assert.deepEqual(
    preparing.calls.map((c) => c[0]),
    ["access", "drain", "access", "token"],
  );
  const still = world({ access: [refusal("preparing")] });
  assert.deepEqual(
    await joinClientConsultation(
      still.client,
      form({ consultation: CONSULTATION }),
    ),
    { status: "outcome", outcome: "preparing" },
  );
  assert.deepEqual(
    still.calls.map((c) => c[0]),
    ["access", "drain", "access"],
  );
  // Correction F4: waiting (ready, before the start) issues no token and asks
  // the database once (no drain).
  for (const outcome of [
    "waiting",
    "not_open_yet",
    "ended",
    "configuration_unavailable",
    "not_found",
  ]) {
    const r = world({ access: [refusal(outcome)] });
    assert.deepEqual(
      await joinClientConsultation(
        r.client,
        form({ consultation: CONSULTATION }),
      ),
      { status: "outcome", outcome },
    );
    assert.equal(
      r.calls.some((c) => c[0] === "token"),
      false,
    );
    assert.deepEqual(
      r.calls.map((c) => c[0]),
      ["access"],
    );
  }
  assert.deepEqual(
    await joinClientConsultation(
      world({ access: [refusal("denied")] }).client,
      form({ consultation: CONSULTATION }),
    ),
    { status: "denied" },
  );
  // A grant for the other role, an unknown answer, a rejected call.
  assert.deepEqual(
    await joinClientConsultation(
      world({ access: [grant("attorney")] }).client,
      form({ consultation: CONSULTATION }),
    ),
    { status: "unconfirmed" },
  );
  assert.deepEqual(
    await joinClientConsultation(
      world({ access: [UNREADABLE] }).client,
      form({ consultation: CONSULTATION }),
    ),
    { status: "unconfirmed" },
  );
  assert.deepEqual(
    await joinClientConsultation(
      world({ access: [{ kind: "rejected" }] }).client,
      form({ consultation: CONSULTATION }),
    ),
    { status: "unavailable" },
  );
  // Media not configured: nothing is asked of the database.
  const noMedia = world({ media: false });
  assert.deepEqual(
    await joinClientConsultation(
      noMedia.client,
      form({ consultation: CONSULTATION }),
    ),
    { status: "outcome", outcome: "media_unavailable" },
  );
  assert.deepEqual(noMedia.calls, []);
  // The provider refuses the token.
  assert.deepEqual(
    await joinClientConsultation(
      world({ tokenAnswer: { kind: "transient" } }).client,
      form({ consultation: CONSULTATION }),
    ),
    { status: "outcome", outcome: "media_unavailable" },
  );
  // An unbound environment refuses before anything is sent.
  const mismatch = world({ configuredClass: "production" });
  assert.deepEqual(
    await joinClientConsultation(
      mismatch.client,
      form({ consultation: CONSULTATION }),
    ),
    { status: "unavailable" },
  );
  assert.deepEqual(mismatch.calls, []);
  // Exactly one consultation id.
  const twice = form({ consultation: CONSULTATION });
  twice.append("consultation", CONSULTATION);
  for (const data of [form({}), form({ consultation: "x" }), twice]) {
    assert.deepEqual(await joinClientConsultation(world().client, data), {
      status: "outcome",
      outcome: "not_found",
    });
  }
  const attorneySide = world({ access: [grant("attorney")] });
  assert.equal(
    (
      await joinAttorneyConsultation(
        attorneySide.attorney,
        form({ consultation: CONSULTATION }),
      )
    ).status,
    "granted",
  );
  assert.equal(attorneySide.calls[1][1].role, "attorney");
});

// ---------------------------------------------------------------------------
// Start and end
// ---------------------------------------------------------------------------

test("S9-4. the attorney's start and end map every database outcome to its fixed state; denied refuses; an unknown answer is unconfirmed; an unbound environment or a refused attorney sends nothing", async () => {
  const startTable = {
    started: "consultation_started",
    not_found: "not_found",
    ended: "ended",
    already_started: "already_started",
    not_ready: "not_ready",
    configuration_unavailable: "configuration_unavailable",
    not_open_yet: "not_open_yet",
    window_passed: "window_passed",
    attorney_in_consultation: "attorney_in_consultation",
    payment_not_ready: "payment_not_ready",
    not_eligible: "not_eligible",
    eligibility_unavailable: "eligibility_unavailable",
    conflict: "conflict",
  };
  for (const [outcome, expected] of Object.entries(startTable)) {
    assert.deepEqual(
      await startConsultation(
        world({ startAnswer: { kind: "answer", outcome } }).attorney,
        form({ consultation: CONSULTATION }),
      ),
      { status: "outcome", outcome: expected },
      outcome,
    );
  }
  const endTable = {
    completed: "consultation_completed",
    not_found: "not_found",
    not_started: "not_started",
    ended: "ended",
    configuration_unavailable: "configuration_unavailable",
    conflict: "conflict",
  };
  for (const [outcome, expected] of Object.entries(endTable)) {
    assert.deepEqual(
      await endConsultation(
        world({ endAnswer: { kind: "answer", outcome } }).attorney,
        form({ consultation: CONSULTATION }),
      ),
      { status: "outcome", outcome: expected },
      outcome,
    );
  }
  assert.deepEqual(
    await startConsultation(
      world({ startAnswer: { kind: "answer", outcome: "denied" } }).attorney,
      form({ consultation: CONSULTATION }),
    ),
    { status: "denied" },
  );
  assert.deepEqual(
    await startConsultation(
      world({ startAnswer: { kind: "answer", outcome: "invalid" } }).attorney,
      form({ consultation: CONSULTATION }),
    ),
    { status: "invalid" },
  );
  assert.deepEqual(
    await endConsultation(
      world({ endAnswer: UNREADABLE }).attorney,
      form({ consultation: CONSULTATION }),
    ),
    { status: "unconfirmed" },
  );
  // One bounded worker run follows a start or an end, and nothing else.
  const started = world();
  await startConsultation(
    started.attorney,
    form({ consultation: CONSULTATION }),
  );
  assert.deepEqual(
    started.calls.map((c) => c[0]),
    ["start", "drain"],
  );
  const refused = world({
    startAnswer: { kind: "answer", outcome: "not_ready" },
  });
  await startConsultation(
    refused.attorney,
    form({ consultation: CONSULTATION }),
  );
  assert.deepEqual(
    refused.calls.map((c) => c[0]),
    ["start"],
  );
  const ended = world();
  await endConsultation(ended.attorney, form({ consultation: CONSULTATION }));
  assert.deepEqual(
    ended.calls.map((c) => c[0]),
    ["end", "drain"],
  );
  for (const options of [{ configuredClass: "staging" }, { stage: null }]) {
    const w = world(options);
    await startConsultation(w.attorney, form({ consultation: CONSULTATION }));
    assert.equal(
      w.calls.some((c) => c[0] === "start"),
      false,
    );
  }
  // Every database outcome has a table entry or a fixed refusal.
  for (const outcome of START_OUTCOMES) {
    assert.ok(
      Object.hasOwn(startTable, outcome) ||
        ["invalid", "denied"].includes(outcome),
      outcome,
    );
  }
  for (const outcome of END_OUTCOMES) {
    assert.ok(
      Object.hasOwn(endTable, outcome) ||
        ["invalid", "denied"].includes(outcome),
      outcome,
    );
  }
});

// ---------------------------------------------------------------------------
// The adapter's strict answer readers
// ---------------------------------------------------------------------------

test("S9-5. the adapter reads media access strictly: granted carries exactly the Rosuno room name, a role, the User id and both times (expiry after not-before); every other outcome carries none of them; a database rejection is rejected, anything else unreadable", () => {
  const row = (overrides = {}) => ({
    outcome: "granted",
    room_name: ROOM,
    participant_role: "client",
    participant_user_id: USER,
    not_before: OPENS,
    expires_at: "2026-11-20T10:15:00+00:00",
    opens_at: OPENS,
    ...overrides,
  });
  const result = (data, error = null, status = 200) => ({
    data,
    error,
    status,
  });
  assert.equal(accessAnswerOf(result([row()])).outcome, "granted");
  assert.deepEqual(accessAnswerOf(result([row()])).grant.roomName, ROOM);
  const none = {
    room_name: null,
    participant_role: null,
    participant_user_id: null,
    not_before: null,
    expires_at: null,
  };
  for (const outcome of ACCESS_OUTCOMES.filter((o) => o !== "granted")) {
    assert.deepEqual(
      accessAnswerOf(result([row({ outcome, ...none, opens_at: null })])),
      { kind: "answer", outcome, grant: null, opensAt: null },
      outcome,
    );
  }
  for (const bad of [
    [row({ room_name: "lobby" })],
    [row({ participant_role: "staff" })],
    [row({ participant_user_id: "x" })],
    [row({ expires_at: OPENS })],
    [row({ outcome: "ended" })],
    [row({ outcome: "maybe" })],
    [{ ...row(), extra: 1 }],
    [row(), row()],
    [],
    null,
  ]) {
    assert.deepEqual(accessAnswerOf(result(bad)), { kind: "unreadable" });
  }
  assert.deepEqual(accessAnswerOf(result(null, { code: "42501" }, 403)), {
    kind: "rejected",
  });
  assert.deepEqual(accessAnswerOf(result(null, { code: "08006" }, 503)), {
    kind: "unreadable",
  });
  const command = (outcome, problem, time) => [
    { outcome, problem, started_at: time },
  ];
  assert.deepEqual(startAnswerOf(result(command("started", null, OPENS))), {
    kind: "answer",
    outcome: "started",
  });
  assert.equal(
    startAnswerOf(result(command("already_started", null, OPENS))).outcome,
    "already_started",
  );
  assert.deepEqual(startAnswerOf(result(command("started", null, null))), {
    kind: "unreadable",
  });
  assert.deepEqual(
    startAnswerOf(result(command("not_ready", "scheduled", OPENS))),
    {
      kind: "unreadable",
    },
  );
  assert.equal(
    startAnswerOf(result(command("payment_not_ready", "capture_pending", null)))
      .outcome,
    "payment_not_ready",
  );
  assert.deepEqual(
    endAnswerOf(
      result([{ outcome: "completed", problem: null, ended_at: CLOSES }]),
    ),
    { kind: "answer", outcome: "completed" },
  );
  assert.deepEqual(
    endAnswerOf(
      result([{ outcome: "completed", problem: null, started_at: CLOSES }]),
    ),
    { kind: "unreadable" },
  );
});

// ---------------------------------------------------------------------------
// Presentation and source contracts
// ---------------------------------------------------------------------------

test("S9-6. every outcome has a fixed message, the provider is never named, and nothing claims recording, approval or a recommendation", () => {
  for (const outcome of JOIN_OUTCOMES) {
    assert.ok(labels.JOIN_OUTCOME_MESSAGES[outcome], outcome);
  }
  for (const outcome of COMMAND_OUTCOMES) {
    assert.ok(labels.COMMAND_OUTCOME_MESSAGES[outcome], outcome);
  }
  for (const status of [
    "unconfirmed",
    "sign-in-required",
    "denied",
    "unavailable",
    "step-up-required",
  ]) {
    assert.ok(labels.joinMessage({ status }), status);
    assert.ok(labels.commandMessage({ status }), status);
  }
  assert.equal(labels.joinMessage({ status: "idle" }), null);
  assert.equal(
    labels.joinMessage({ status: "granted", frameUrl: "x", expiresAt: OPENS }),
    null,
  );
  const text = codeOf(read("src/presentation/consultation-labels.ts"));
  assert.doesNotMatch(
    text,
    /daily|recorded by|recording is on|approved|recommend|best attorney|guarantee/i,
  );
  assert.equal(
    labels.FRAME_ALLOW,
    "camera; microphone; autoplay; display-capture",
  );
});

test("S9-7. the routes: server pages that opt out of prerendering (the attorney pages behind the step-up gate first), the frame only in the two client form modules with the fixed title and permissions, the token only in the action answer (never in a page, URL or log), and the pages read only the route segment (MVP-001 S10 PS-A5: and a Consultation page exactly one more value, which document's version history to show)", () => {
  // MVP-001 S11 pass 2B: plus exactly the attorney's past consultations, a
  // read-only server page behind the step-up gate (no form, no action).
  assert.deepEqual(filesIn("app/attorney/consultations/"), [
    "app/attorney/consultations/[consultation]/forms.tsx",
    "app/attorney/consultations/[consultation]/page.tsx",
    "app/attorney/consultations/actions.ts",
    "app/attorney/consultations/history/page.tsx",
    "app/attorney/consultations/page.tsx",
  ]);
  for (const page of [
    "app/client/consultations/[consultation]/page.tsx",
    "app/attorney/consultations/[consultation]/page.tsx",
    "app/attorney/consultations/page.tsx",
  ]) {
    const code = codeOf(read(page));
    assert.match(code, /await connection\(\);/, page);
    assert.doesNotMatch(read(page), /["']use (?:client|server)["']/, page);
    // MVP-001 S10 (PS-A5): a Consultation page reads one more request value,
    // which document's version history to show, exactly so and nothing else;
    // the rest of the page is scanned as before.
    const HISTORY_READ = [
      "  searchParams,\n",
      "  readonly searchParams: Promise<{\n    readonly history?: string | readonly string[];\n  }>;\n",
      "  const { history } = await searchParams;\n",
    ];
    let scanned = code;
    if (page.endsWith("/[consultation]/page.tsx")) {
      for (const snippet of HISTORY_READ) {
        assert.equal(scanned.split(snippet).length, 2, `${page}: ${snippet}`);
        scanned = scanned.replace(snippet, "");
      }
    }
    assert.doesNotMatch(
      scanned,
      /<iframe\b|token|frameUrl|searchParams|cookies|headers\(/,
      page,
    );
    assert.equal(
      page.startsWith("app/attorney/"),
      code.includes('await requireSteppedUp("attorney");'),
      page,
    );
  }
  const frames = [...filesIn("app/"), ...filesIn("src/")].filter((file) =>
    /<iframe\b/.test(read(file)),
  );
  assert.deepEqual(frames, [
    "app/attorney/consultations/[consultation]/forms.tsx",
    "app/client/consultations/[consultation]/forms.tsx",
  ]);
  for (const file of frames) {
    const code = read(file);
    assert.match(code, /^"use client";\n/, file);
    assert.equal(code.match(/<iframe\b/g).length, 1, file);
    assert.match(
      code,
      /<iframe\n\s+src=\{state\.frameUrl\}\n\s+title=\{FRAME_TITLE\}\n\s+allow=\{FRAME_ALLOW\}\n\s+\/>/,
      file,
    );
    assert.doesNotMatch(
      code,
      /sandbox|srcDoc|dangerouslySetInnerHTML|console\./,
      file,
    );
  }
  // MVP-001 S11 correction pass (A7), by exact admission: the client's
  // cancellation action logs a cancellation not completed with its fixed
  // outcome only (the observability test checks the line); nothing else in
  // these modules logs, and the join action (whose answer carries the token)
  // still logs nothing.
  const CANCEL_LOG_IMPORT =
    'import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";\n';
  const CANCEL_LOG =
    '  if (state.status === "unavailable" || state.status === "unconfirmed") {\n    await logRequestEvent("warn", "consultation.action_not_completed", {\n      operation: "cancelConsultation",\n      outcome: state.status,\n    });\n  }\n';
  for (const actions of [
    "app/client/consultations/actions.ts",
    "app/attorney/consultations/actions.ts",
  ]) {
    let code = codeOf(read(actions));
    assert.match(read(actions), /^"use server";\n/, actions);
    if (actions === "app/client/consultations/actions.ts") {
      assert.equal(code.split(CANCEL_LOG_IMPORT).length, 2, actions);
      assert.equal(code.split(CANCEL_LOG).length, 2, actions);
      const cancel = code.slice(
        code.indexOf("export async function cancelConsultationAction("),
      );
      assert.ok(cancel.includes(CANCEL_LOG), actions);
      assert.doesNotMatch(cancel.slice(1), /\nexport /, actions);
      code = code.replace(CANCEL_LOG_IMPORT, "").replace(CANCEL_LOG, "");
    }
    assert.doesNotMatch(
      code,
      /logRequestEvent|console\.|redirect\(|cookies|headers\(/,
      actions,
    );
  }
  // No module other than the Daily adapter knows the provider's API origin,
  // and no page or presentation module names the provider at all.
  for (const file of [...filesIn("app/"), ...filesIn("src/")]) {
    const code = codeOf(read(file));
    assert.equal(
      code.includes("api.daily.co"),
      file === "src/infrastructure/media/daily-provider.ts",
      file,
    );
    if (file.startsWith("app/") && file !== "app/api/media/daily/route.ts") {
      assert.doesNotMatch(code, /daily/i, file);
    }
  }
});
