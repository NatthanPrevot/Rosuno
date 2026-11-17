// MVP-001 S4: the attorney schedule (availability, Blackouts, calendar and
// Instant mode), driven through fake ports. The session, principal, read and
// write ports answer exactly as the trusted sources and the database's own
// functions do; every call is recorded. Every attorney, rule, Blackout,
// instant and value is synthetic test data.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CALENDAR_DAYS,
  createAvailabilityRule,
  createBlackout,
  deactivateAvailabilityRule,
  INITIAL_SCHEDULE_STATE,
  knownTimeZones,
  observeScheduleSession,
  readRuleForm,
  removeBlackout,
  resolveAttorneySchedule,
  SCHEDULE_OUTCOMES,
  switchInstantMode,
  zonedInstant,
} from "../src/application/attorney-schedule.ts";
import {
  createAttorneyScheduleWrites,
  endSchedulingSession,
} from "../src/infrastructure/scheduling/attorney-schedule-adapter.ts";
import {
  OUTCOME_MESSAGES,
  formatInZone,
  formatUtc,
} from "../src/presentation/schedule-labels.ts";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, appRoot), "utf8");

const SUBJECT = "6f1c2d3e-4a5b-4c6d-8e7f-901234567890";
const NOW = Date.parse("2026-11-17T12:00:00Z");
const RULE = "11111111-1111-4111-8111-111111111111";
const BLACKOUT = "22222222-2222-4222-8222-222222222222";
const FUTURE_BLACKOUT = "33333333-3333-4333-8333-333333333333";

const rows = (list) => ({ kind: "rows", rows: list });
const UNREADABLE = Object.freeze({ kind: "unreadable" });
const answer = (outcome, value = null) => ({ kind: "answer", outcome, value });

function calendarRow(overrides = {}) {
  return {
    entry_kind: "window",
    entry_id: RULE,
    starts_at: "2026-11-18T14:00:00+00:00",
    ends_at: "2026-11-18T22:00:00+00:00",
    timezone_name: "America/New_York",
    local_date: "2026-11-18",
    entry_state: "available",
    reason_code: null,
    ...overrides,
  };
}

function ruleRow(overrides = {}) {
  return {
    id: RULE,
    rule_kind: "recurring",
    timezone_name: "America/New_York",
    weekday: 3,
    specific_date: null,
    local_start_time: "09:00:00",
    local_end_time: "17:00:00",
    effective_from: "2026-11-17",
    effective_until: null,
    created_at: "2026-11-17T10:00:00+00:00",
    ...overrides,
  };
}

const blackoutRows = () => [
  {
    id: BLACKOUT,
    starts_at: "2026-11-17T11:00:00+00:00",
    ends_at: "2026-11-17T13:00:00+00:00",
    reason_code: null,
  },
  {
    id: FUTURE_BLACKOUT,
    starts_at: "2026-11-20T09:00:00+00:00",
    ends_at: "2026-11-20T17:00:00+00:00",
    reason_code: null,
  },
];

function statusRow(overrides = {}) {
  return {
    instant_on: true,
    intent_expires_at: "2026-11-17T12:30:00+00:00",
    session_active: true,
    session_expires_at: "2026-11-17T13:00:00+00:00",
    presence_configured: true,
    other_sessions_on: 0,
    ...overrides,
  };
}

// The fake world: who is signed in, what principal the trusted source
// reports, what each read and write answers, and every call made.
function world(options = {}) {
  const calls = [];
  const state = {
    subject: SUBJECT,
    stage: "approved",
    calendar: rows([calendarRow()]),
    rules: rows([ruleRow()]),
    blackouts: rows(blackoutRows()),
    status: rows([statusRow()]),
    answers: {},
    readsAvailable: true,
    writesAvailable: true,
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
    reads: async () =>
      state.readsAvailable
        ? {
            calendar: async (from, days) => {
              calls.push(["calendar", from, days]);
              return state.calendar;
            },
            activeRules: async () => {
              calls.push(["activeRules"]);
              return state.rules;
            },
            blackoutsEndingAfter: async (instant) => {
              calls.push(["blackoutsEndingAfter", instant]);
              return state.blackouts;
            },
            instantStatus: async () => {
              calls.push(["instantStatus"]);
              return state.status;
            },
          }
        : null,
    writes: async () =>
      state.writesAvailable
        ? Object.fromEntries(
            [
              "createRule",
              "deactivateRule",
              "createBlackout",
              "removeBlackout",
              "setInstant",
              "touchSession",
            ].map((name) => [
              name,
              async (...args) => {
                calls.push([name, ...args]);
                const configured = state.answers[name];
                if (configured instanceof Error) {
                  throw configured;
                }
                return configured ?? UNREADABLE;
              },
            ]),
          )
        : null,
    clock: () => NOW,
  });
  return { sources, calls, state };
}

function form(entries) {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    data.set(key, value);
  }
  return data;
}

const writesOf = (calls) =>
  calls.filter(([name]) => name !== "principal" && name !== "instantStatus");

test("S4-A1. an admitted attorney sees the calendar for the next days, the active rules, the Blackouts not yet ended and the server's Instant status, all read from the database", async () => {
  const { sources, calls } = world();
  const view = await resolveAttorneySchedule(sources);
  assert.equal(view.status, "ready");
  assert.equal(view.stage, "approved");
  assert.equal(view.today, "2026-11-17");
  assert.equal(view.displayZone, "America/New_York");
  assert.deepEqual(view.calendar, [
    {
      kind: "window",
      id: RULE,
      startsAt: "2026-11-18T14:00:00+00:00",
      endsAt: "2026-11-18T22:00:00+00:00",
      timezone: "America/New_York",
      localDate: "2026-11-18",
      state: "available",
    },
  ]);
  assert.deepEqual(view.rules[0], {
    id: RULE,
    kind: "recurring",
    timezone: "America/New_York",
    weekday: 3,
    date: null,
    startTime: "09:00",
    endTime: "17:00",
    effectiveFrom: "2026-11-17",
    effectiveUntil: null,
  });
  assert.deepEqual(
    view.blackouts.map((b) => [b.id, b.removable]),
    [
      [BLACKOUT, false],
      [FUTURE_BLACKOUT, true],
    ],
  );
  assert.deepEqual(view.instant, {
    on: true,
    expiresAt: "2026-11-17T12:30:00+00:00",
    sessionActive: true,
    configured: true,
    otherSessionsOn: 0,
  });
  assert.deepEqual(calls, [
    ["principal", SUBJECT],
    ["calendar", "2026-11-17", CALENDAR_DAYS],
    ["activeRules"],
    ["blackoutsEndingAfter", "2026-11-17T12:00:00.000Z"],
    ["instantStatus"],
  ]);
});

test("S4-A2. nothing is read without the attorney principal, and anything unreadable or malformed is unavailable rather than guessed", async () => {
  const anonymous = world({ subject: null });
  assert.deepEqual(await resolveAttorneySchedule(anonymous.sources), {
    status: "sign-in-required",
  });
  assert.deepEqual(anonymous.calls, []);
  const noAttorney = world({ stage: null });
  assert.deepEqual(await resolveAttorneySchedule(noAttorney.sources), {
    status: "denied",
  });
  assert.deepEqual(noAttorney.calls, [["principal", SUBJECT]]);
  const malformed = {
    "reads unavailable": { readsAvailable: false },
    "calendar unreadable": { calendar: UNREADABLE },
    "extra calendar column": {
      calendar: rows([{ ...calendarRow(), client_id: SUBJECT }]),
    },
    "window without a time zone": {
      calendar: rows([calendarRow({ timezone_name: null })]),
    },
    "inverted entry": {
      calendar: rows([calendarRow({ ends_at: "2026-11-18T13:00:00+00:00" })]),
    },
    "unknown entry kind": {
      calendar: rows([calendarRow({ entry_kind: "request" })]),
    },
    "rule with an unknown zone": {
      rules: rows([ruleRow({ timezone_name: "Mars/Phobos" })]),
    },
    "recurring rule without a weekday": {
      rules: rows([ruleRow({ weekday: null })]),
    },
    "Instant on without a deadline": {
      status: rows([statusRow({ intent_expires_at: null })]),
    },
    "Instant on without a live session": {
      status: rows([
        statusRow({ session_active: false, session_expires_at: null }),
      ]),
    },
    "two status rows": { status: rows([statusRow(), statusRow()]) },
  };
  for (const [label, options] of Object.entries(malformed)) {
    assert.deepEqual(
      await resolveAttorneySchedule(world(options).sources),
      { status: "unavailable" },
      label,
    );
  }
  // No status row (for example a session not stepped up) is shown as such.
  const noStatus = await resolveAttorneySchedule(
    world({ status: rows([]) }).sources,
  );
  assert.equal(noStatus.status, "ready");
  assert.equal(noStatus.instant, null);
});

test("S4-A3. a local time in an IANA zone becomes one UTC instant, and a daylight-saving gap or overlap is refused rather than guessed", () => {
  for (const [date, time, zone, instant] of [
    ["2027-07-01", "09:00", "America/New_York", "2027-07-01T13:00:00.000Z"],
    ["2027-01-15", "09:00", "America/New_York", "2027-01-15T14:00:00.000Z"],
    ["2027-03-14", "03:30", "America/New_York", "2027-03-14T07:30:00.000Z"],
    ["2027-03-14", "02:30", "America/New_York", null],
    ["2027-11-07", "01:30", "America/New_York", null],
    ["2027-11-07", "02:30", "America/New_York", "2027-11-07T07:30:00.000Z"],
    ["2027-03-28", "02:15", "Europe/Paris", null],
    ["2027-04-04", "01:45", "Australia/Lord_Howe", null],
    ["2027-07-01", "09:00", "Asia/Kolkata", "2027-07-01T03:30:00.000Z"],
    ["2027-07-01", "09:00", "UTC", "2027-07-01T09:00:00.000Z"],
    ["2027-02-30", "09:00", "UTC", null],
    ["2027-07-01", "25:00", "UTC", null],
    ["2027-07-01", "09:00", "Mars/Phobos", null],
  ]) {
    assert.equal(
      zonedInstant(date, time, zone),
      instant,
      `${zone} ${date} ${time}`,
    );
  }
  const zones = knownTimeZones();
  assert.ok(zones.includes("UTC"));
  assert.ok(zones.includes("America/New_York"));
});

test("S4-A4. a rule is checked before anything is sent: kind, a listed time zone, an ordered local window, a weekday or a date, and effective dates", () => {
  const good = {
    kind: "recurring",
    timezone: "America/New_York",
    weekday: "3",
    start_time: "09:00",
    end_time: "17:00",
    effective_from: "",
    effective_until: "",
  };
  const ok = readRuleForm(form(good), "2026-11-17");
  assert.deepEqual(ok, {
    ok: true,
    input: {
      kind: "recurring",
      timezone: "America/New_York",
      weekday: 3,
      date: null,
      startTime: "09:00",
      endTime: "17:00",
      effectiveFrom: "2026-11-17",
      effectiveUntil: null,
    },
  });
  assert.equal(
    readRuleForm(form({ ...good, end_time: "24:00" }), "2026-11-17").input
      .endTime,
    "24:00",
  );
  const oneTime = readRuleForm(
    form({ ...good, kind: "one_time", date: "2026-11-20" }),
    "2026-11-17",
  );
  assert.deepEqual(oneTime.input, {
    kind: "one_time",
    timezone: "America/New_York",
    weekday: null,
    date: "2026-11-20",
    startTime: "09:00",
    endTime: "17:00",
    effectiveFrom: null,
    effectiveUntil: null,
  });
  for (const [label, change, field] of [
    ["kind", { kind: "weekly" }, "kind"],
    ["zone", { timezone: "Mars/Phobos" }, "timezone"],
    ["zone case", { timezone: "america/new_york" }, "timezone"],
    ["order", { start_time: "17:00", end_time: "09:00" }, "end_time"],
    ["start format", { start_time: "9am" }, "start_time"],
    ["weekday", { weekday: "8" }, "weekday"],
    [
      "until before from",
      { effective_from: "2026-12-01", effective_until: "2026-11-30" },
      "effective_until",
    ],
    ["date", { kind: "one_time", date: "2026-02-30" }, "date"],
  ]) {
    const result = readRuleForm(form({ ...good, ...change }), "2026-11-17");
    assert.equal(result.status, "invalid", label);
    assert.ok(result.fieldErrors[field], label);
  }
});

test("S4-A5. a rule change is one database call with exactly the checked input, and only the database's fixed outcomes are reported", async () => {
  const good = form({
    kind: "recurring",
    timezone: "Europe/Paris",
    weekday: "1",
    start_time: "08:00",
    end_time: "12:00",
    effective_from: "2026-11-23",
    effective_until: "",
  });
  for (const [configured, expected] of [
    [answer("created", RULE), { status: "outcome", outcome: "rule_created" }],
    [answer("rate_limited"), { status: "outcome", outcome: "rate_limited" }],
    [answer("denied"), { status: "denied" }],
    [answer("invalid"), "invalid"],
    [{ kind: "rejected" }, "invalid"],
    [UNREADABLE, { status: "unconfirmed" }],
    [answer("deactivated"), { status: "unconfirmed" }],
    [new Error("synthetic"), { status: "unconfirmed" }],
  ]) {
    const { sources, calls } = world({ answers: { createRule: configured } });
    const state = await createAvailabilityRule(sources, good);
    if (expected === "invalid") {
      assert.equal(state.status, "invalid");
    } else {
      assert.deepEqual(state, expected);
    }
    assert.deepEqual(writesOf(calls), [
      [
        "createRule",
        {
          kind: "recurring",
          timezone: "Europe/Paris",
          weekday: 1,
          date: null,
          startTime: "08:00",
          endTime: "12:00",
          effectiveFrom: "2026-11-23",
          effectiveUntil: null,
        },
      ],
    ]);
  }
  // Nothing is sent for an invalid form or without the attorney principal.
  const invalidForm = world();
  assert.equal(
    (await createAvailabilityRule(invalidForm.sources, form({ kind: "x" })))
      .status,
    "invalid",
  );
  assert.deepEqual(invalidForm.calls, []);
  const anonymous = world({
    subject: null,
    answers: { createRule: answer("created") },
  });
  assert.deepEqual(await createAvailabilityRule(anonymous.sources, good), {
    status: "sign-in-required",
  });
  assert.deepEqual(writesOf(anonymous.calls), []);
  const unavailable = world({ writesAvailable: false });
  assert.deepEqual(await createAvailabilityRule(unavailable.sources, good), {
    status: "unavailable",
  });
});

test("S4-A6. a Blackout is entered in local time and sent as UTC instants; a daylight-saving gap, an inverted range or a past end is refused before anything is sent", async () => {
  const { sources, calls } = world({
    answers: { createBlackout: answer("created", BLACKOUT) },
  });
  const state = await createBlackout(
    sources,
    form({
      timezone: "America/New_York",
      start_date: "2026-11-20",
      start_time: "09:00",
      end_date: "2026-11-20",
      end_time: "17:30",
    }),
  );
  assert.deepEqual(state, { status: "outcome", outcome: "blackout_created" });
  assert.deepEqual(writesOf(calls), [
    [
      "createBlackout",
      {
        startsAt: "2026-11-20T14:00:00.000Z",
        endsAt: "2026-11-20T22:30:00.000Z",
      },
    ],
  ]);
  for (const [label, entries, field] of [
    [
      "gap",
      {
        start_date: "2027-03-14",
        start_time: "02:30",
        end_date: "2027-03-14",
        end_time: "05:00",
      },
      "start_time",
    ],
    [
      "overlap",
      {
        start_date: "2027-11-07",
        start_time: "00:00",
        end_date: "2027-11-07",
        end_time: "01:30",
      },
      "end_time",
    ],
    [
      "inverted",
      {
        start_date: "2026-11-20",
        start_time: "10:00",
        end_date: "2026-11-20",
        end_time: "09:00",
      },
      "end_time",
    ],
    [
      "past",
      {
        start_date: "2026-11-01",
        start_time: "10:00",
        end_date: "2026-11-02",
        end_time: "09:00",
      },
      "end_time",
    ],
  ]) {
    const refused = world();
    const result = await createBlackout(
      refused.sources,
      form({ timezone: "America/New_York", ...entries }),
    );
    assert.equal(result.status, "invalid", label);
    assert.ok(result.fieldErrors[field], label);
    assert.deepEqual(refused.calls, [], label);
  }
});

test("S4-A7. deactivating a rule and removing a Blackout name only the attorney's own record by id; a malformed id sends nothing", async () => {
  for (const [configured, outcome] of [
    ["deactivated", "rule_deactivated"],
    ["already_inactive", "rule_already_inactive"],
    ["not_found", "not_found"],
  ]) {
    const { sources, calls } = world({
      answers: { deactivateRule: answer(configured) },
    });
    assert.deepEqual(
      await deactivateAvailabilityRule(sources, form({ rule: RULE })),
      { status: "outcome", outcome },
    );
    assert.deepEqual(writesOf(calls), [["deactivateRule", RULE]]);
  }
  for (const [configured, outcome] of [
    ["removed", "blackout_removed"],
    ["not_removable", "blackout_not_removable"],
    ["not_found", "not_found"],
  ]) {
    const { sources, calls } = world({
      answers: { removeBlackout: answer(configured) },
    });
    assert.deepEqual(
      await removeBlackout(sources, form({ blackout: FUTURE_BLACKOUT })),
      { status: "outcome", outcome },
    );
    assert.deepEqual(writesOf(calls), [["removeBlackout", FUTURE_BLACKOUT]]);
  }
  const malformed = world();
  assert.deepEqual(
    await deactivateAvailabilityRule(malformed.sources, form({ rule: "x" })),
    { status: "outcome", outcome: "not_found" },
  );
  assert.deepEqual(
    await removeBlackout(malformed.sources, form({ blackout: "../x" })),
    { status: "outcome", outcome: "not_found" },
  );
  assert.deepEqual(malformed.calls, []);
});

test("S4-A8. the Instant switch sends only on or off; an unset configuration is reported as not configured, an unrecognised session as such", async () => {
  for (const [intent, configured, outcome] of [
    ["on", "enabled", "instant_enabled"],
    ["off", "disabled", "instant_disabled"],
    ["on", "unchanged", "instant_unchanged"],
    ["on", "unavailable", "not_configured"],
    ["on", "no_session", "no_session"],
  ]) {
    const { sources, calls } = world({
      answers: { setInstant: answer(configured) },
    });
    assert.deepEqual(
      await switchInstantMode(sources, form({ instant: intent })),
      { status: "outcome", outcome },
    );
    assert.deepEqual(writesOf(calls), [["setInstant", intent === "on"]]);
  }
  const denied = world({ answers: { setInstant: answer("denied") } });
  assert.deepEqual(
    await switchInstantMode(denied.sources, form({ instant: "on" })),
    {
      status: "denied",
    },
  );
  const bad = world();
  assert.equal(
    (await switchInstantMode(bad.sources, form({ instant: "true" }))).status,
    "invalid",
  );
  assert.deepEqual(bad.calls, []);
  // Every reportable outcome has a fixed message.
  for (const outcome of SCHEDULE_OUTCOMES) {
    assert.ok(OUTCOME_MESSAGES[outcome].title, outcome);
  }
  assert.deepEqual(INITIAL_SCHEDULE_STATE, { status: "idle" });
});

test("S4-A9. the heartbeat only asks the server to observe the session and then reads the server's own status; it sends nothing of the browser's", async () => {
  const observed = world({ answers: { touchSession: answer("observed") } });
  assert.deepEqual(await observeScheduleSession(observed.sources), {
    status: "observed",
    instant: {
      on: true,
      expiresAt: "2026-11-17T12:30:00+00:00",
      sessionActive: true,
      configured: true,
      otherSessionsOn: 0,
    },
  });
  assert.deepEqual(observed.calls, [
    ["principal", SUBJECT],
    ["touchSession"],
    ["instantStatus"],
  ]);
  for (const [configured, status] of [
    [answer("no_session"), "no-session"],
    [answer("denied"), "refused"],
    [UNREADABLE, "unavailable"],
    [new Error("synthetic"), "unavailable"],
  ]) {
    const { sources } = world({ answers: { touchSession: configured } });
    assert.deepEqual(await observeScheduleSession(sources), { status }, status);
  }
  const anonymous = world({ subject: null });
  assert.deepEqual(await observeScheduleSession(anonymous.sources), {
    status: "refused",
  });
  assert.deepEqual(anonymous.calls, []);
  // The client component asks only while visible, about every 30 seconds,
  // and calls the server action with no argument.
  const heartbeat = read("app/attorney/schedule/heartbeat.tsx");
  assert.match(heartbeat, /^"use client";\n/);
  assert.match(heartbeat, /const INTERVAL_MS = 30000;/);
  assert.match(heartbeat, /document\.visibilityState !== "visible"/);
  assert.equal(heartbeat.match(/observeSession\(\)/g).length, 1);
  assert.doesNotMatch(
    heartbeat,
    /localStorage|sessionStorage|fetch\(|Date\.now|setTimeout/,
  );
});

test("S4-A10. the schedule writes go through the request's own client by their literal names, and the sign-out step never throws or blocks sign-out", async () => {
  const sent = [];
  const client = {
    rpc: async (name, args) => {
      sent.push([name, args]);
      return {
        data: [{ outcome: "created", rule_id: RULE }],
        error: null,
        status: 200,
      };
    },
  };
  const writes = await createAttorneyScheduleWrites(async () => client)();
  const result = await writes.createRule({
    kind: "one_time",
    timezone: "UTC",
    weekday: null,
    date: "2026-11-20",
    startTime: "09:00",
    endTime: "10:00",
    effectiveFrom: null,
    effectiveUntil: null,
  });
  assert.deepEqual(result, { kind: "answer", outcome: "created", value: RULE });
  assert.deepEqual(sent, [
    [
      "attorney_create_availability_rule",
      {
        p_rule_kind: "one_time",
        p_timezone_name: "UTC",
        p_weekday: null,
        p_specific_date: "2026-11-20",
        p_local_start_time: "09:00",
        p_local_end_time: "10:00",
        p_effective_from: null,
        p_effective_until: null,
      },
    ],
  ]);
  // A malformed answer is never read as an outcome.
  const odd = await createAttorneyScheduleWrites(async () => ({
    rpc: async () => ({
      data: [{ outcome: "created", rule_id: RULE, extra: 1 }],
      error: null,
    }),
  }))();
  assert.equal((await odd.deactivateRule(RULE)).kind, "unreadable");
  // The sign-out step: one call, and it swallows every failure.
  const ended = [];
  await endSchedulingSession({
    rpc: async (name) => {
      ended.push(name);
      return { data: "ended", error: null, status: 200 };
    },
  });
  assert.deepEqual(ended, ["scheduling_end_session"]);
  await endSchedulingSession({
    rpc: async () => {
      throw new Error("synthetic");
    },
  });
  await endSchedulingSession({
    rpc: async () => ({ data: null, error: { code: "42501" }, status: 403 }),
  });
});

test("S4-A11. the page is server-rendered per request behind the step-up gate, never indexed, and shows server instants in their own time zones", () => {
  const page = read("app/attorney/schedule/page.tsx");
  assert.doesNotMatch(page, /["']use (?:client|server)["']/);
  assert.match(page, /robots: \{ index: false, follow: false \},/);
  assert.ok(
    page.includes(
      'await connection();\n  await requireSteppedUp("attorney");\n',
    ),
  );
  const pageCode = page.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(
    pageCode,
    /searchParams|\bparams\b|headers\(|cookies\(|client_id|intake/i,
  );
  assert.equal(
    formatInZone("2026-11-18T14:00:00+00:00", "America/New_York"),
    "Wed, 18 Nov 2026, 09:00 (America/New_York)",
  );
  assert.equal(
    formatUtc("2026-11-18T14:00:05+00:00"),
    "2026-11-18 14:00:05 UTC",
  );
  const home = read("app/attorney/page.tsx");
  assert.equal(home.match(/href="\/attorney\/schedule"/g).length, 1);
});
