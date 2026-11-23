// Attorney schedule: availability, Blackouts, calendar and Instant mode
// (MVP-001 S4).
//
// Provider-neutral and injectable: each request hands in its own ports.
// Access is decided afresh on the server for every read and every change by
// the unchanged Security Shell over the trusted session and the trusted
// attorney principal source (the existing attorney workspace access); a
// request without an admitted attorney principal sees no schedule data and
// sends nothing. Every change is one database function called through the
// request's own authenticated session, so the database decides again, on
// locked rows, at aal2 and for the session's own identity, whether the change
// happens, and audits it in the same transaction. Only the database's own
// fixed outcomes are reported.
//
// Server authority (MVP-001 Packet rule 13; TA sections 10, 11 and 24): every
// deadline shown here is a server timestamp read from the database. The
// browser's heartbeat only asks the server to observe the session; it never
// declares availability, and Instant mode can be on only while the server's
// own lease, renewed by those observations, has not passed.
//
// Time zones (PS sections 2.3 and 34): a rule keeps its IANA time zone and
// local times, and the database expands it into UTC instants. A Blackout is
// entered as local times in a chosen time zone and sent as one UTC instant
// each; a local time that does not exist on that date, or occurs twice, in
// that time zone (a daylight-saving change) is refused rather than guessed.
// Nothing here holds a policy value: Instant mode and holds are configured in
// the database, and an unset configuration is reported as not configured.

import {
  resolveAttorneyWorkspaceAccess,
  type AttorneyPrincipalSource,
  type AttorneyWorkspaceStage,
} from "./attorney-access.ts";
import { readFormFields, type FieldErrors } from "./form-operation.ts";
import {
  attempt,
  portFrom,
  rowsOf,
  textField,
  type RowsResult,
} from "./professional-identity.ts";
import {
  isDate,
  isOneOf,
  isTimestamp,
  isUuid,
  readExact,
} from "./professional-records.ts";
import type { StepUpRequired } from "./session-assurance.ts";
import type { ServerSessionSource } from "./session.ts";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export const CALENDAR_COLUMNS = Object.freeze([
  "entry_kind",
  "entry_id",
  "starts_at",
  "ends_at",
  "timezone_name",
  "local_date",
  "entry_state",
  "reason_code",
]);
export const RULE_COLUMNS =
  "id, rule_kind, timezone_name, weekday, specific_date, local_start_time, local_end_time, effective_from, effective_until, created_at";
export const BLACKOUT_COLUMNS = "id, starts_at, ends_at, reason_code";
export const INSTANT_STATUS_COLUMNS = Object.freeze([
  "instant_on",
  "intent_expires_at",
  "session_active",
  "session_expires_at",
  "presence_configured",
  "other_sessions_on",
]);

// The calendar span shown (local days from today) and the list bounds (the
// database's own abuse bounds).
export const CALENDAR_DAYS = 14;
export const MAX_RULES = 200;
export const MAX_BLACKOUTS = 500;

// Request-scoped, unprivileged reads under the database's own-row policies
// and the attorney's own calendar and status functions.
export type AttorneyScheduleReads = {
  readonly calendar: (
    fromDate: string,
    dayCount: number,
  ) => Promise<RowsResult>;
  readonly activeRules: () => Promise<RowsResult>;
  readonly blackoutsEndingAfter: (instant: string) => Promise<RowsResult>;
  readonly instantStatus: () => Promise<RowsResult>;
};

// One database function's answer as the API reported it: one of its fixed
// outcomes (with the created id where it has one), a database refusal inside
// the call (nothing committed), or unknown.
export type CallAnswer =
  | {
      readonly kind: "answer";
      readonly outcome: string;
      readonly value: string | null;
    }
  | { readonly kind: "rejected" }
  | { readonly kind: "unreadable" };

export type RuleInput = {
  readonly kind: "recurring" | "one_time";
  readonly timezone: string;
  readonly weekday: number | null;
  readonly date: string | null;
  readonly startTime: string;
  readonly endTime: string;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
};

export type BlackoutInput = {
  readonly startsAt: string;
  readonly endsAt: string;
};

export const CREATE_RULE_OUTCOMES = Object.freeze([
  "created",
  "invalid",
  "denied",
  "rate_limited",
]);
export const DEACTIVATE_RULE_OUTCOMES = Object.freeze([
  "deactivated",
  "already_inactive",
  "not_found",
  "denied",
]);
export const CREATE_BLACKOUT_OUTCOMES = Object.freeze([
  "created",
  "invalid",
  "denied",
  "rate_limited",
]);
export const REMOVE_BLACKOUT_OUTCOMES = Object.freeze([
  "removed",
  "not_removable",
  "not_found",
  "denied",
]);
export const INSTANT_OUTCOMES = Object.freeze([
  "enabled",
  "disabled",
  "unchanged",
  "no_session",
  "denied",
  "unavailable",
  "invalid",
]);
export const TOUCH_OUTCOMES = Object.freeze([
  "observed",
  "no_session",
  "denied",
]);
export const END_SESSION_OUTCOMES = Object.freeze(["ended", "no_session"]);

// Request-scoped write port: each call is one database function run for the
// request's own authenticated session. None takes an actor, User or profile.
export type AttorneyScheduleWrites = {
  readonly createRule: (input: RuleInput) => Promise<CallAnswer>;
  readonly deactivateRule: (ruleId: string) => Promise<CallAnswer>;
  readonly createBlackout: (input: BlackoutInput) => Promise<CallAnswer>;
  readonly removeBlackout: (blackoutId: string) => Promise<CallAnswer>;
  readonly setInstant: (enabled: boolean) => Promise<CallAnswer>;
  readonly touchSession: () => Promise<CallAnswer>;
};

export type AttorneyScheduleSources = {
  readonly session: ServerSessionSource;
  readonly attorney: AttorneyPrincipalSource;
  readonly reads: () => Promise<AttorneyScheduleReads | null>;
  readonly writes: () => Promise<AttorneyScheduleWrites | null>;
  readonly clock: () => number;
};

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;
const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

// The IANA time zones this runtime knows, for the time zone choice. The
// database validates every submitted zone again on its own.
export function knownTimeZones(): readonly string[] {
  try {
    const zones = Intl.supportedValuesOf("timeZone");
    return Object.freeze(
      zones.includes("UTC") ? [...zones] : ["UTC", ...zones],
    );
  } catch {
    return Object.freeze(["UTC"]);
  }
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64 || !ZONE.test(value)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// The local wall-clock time of an instant in a zone, as epoch milliseconds
// read as if the wall clock were UTC; null when the zone is unusable.
function wallClockOf(instant: number, zone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(instant));
    const part = (type: string) =>
      Number(parts.find((entry) => entry.type === type)?.value);
    const value = Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      part("hour"),
      part("minute"),
      part("second"),
    );
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

// The one UTC instant (ISO 8601) at which a local date and HH:MM time occur
// in an IANA zone, or null when that local time does not occur there (a
// daylight-saving gap) or occurs twice (an overlap), or the input is
// malformed. The offsets in force a day before and a day after are the
// candidates, as the database's own expansion does.
export function zonedInstant(
  date: string,
  time: string,
  zone: string,
): string | null {
  if (!isDate(date) || !isLocalTime(time) || !isTimeZone(zone)) {
    return null;
  }
  const [hours, minutes] = time.split(":").map(Number);
  const local =
    Date.parse(`${date}T00:00:00Z`) + (hours * 60 + minutes) * 60000;
  const before = wallClockOf(local - DAY_MS, zone);
  const after = wallClockOf(local + DAY_MS, zone);
  if (before === null || after === null) {
    return null;
  }
  const candidates = [
    local - (before - (local - DAY_MS)),
    local - (after - (local + DAY_MS)),
  ].filter((candidate) => wallClockOf(candidate, zone) === local);
  const distinct = [...new Set(candidates)];
  return distinct.length === 1 ? new Date(distinct[0]).toISOString() : null;
}

const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function isLocalTime(value: unknown): value is string {
  return typeof value === "string" && LOCAL_TIME.test(value);
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

export const ENTRY_KINDS = Object.freeze([
  "window",
  "blackout",
  "hold",
  "booking",
] as const);
export type EntryKind = (typeof ENTRY_KINDS)[number];

export type CalendarEntry = {
  readonly kind: EntryKind;
  readonly id: string;
  readonly startsAt: string;
  readonly endsAt: string;
  // The rule's time zone (availability windows only).
  readonly timezone: string | null;
  readonly localDate: string | null;
  readonly state: string;
};

export type RuleView = {
  readonly id: string;
  readonly kind: "recurring" | "one_time";
  readonly timezone: string;
  readonly weekday: number | null;
  readonly date: string | null;
  readonly startTime: string;
  readonly endTime: string;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
};

export type BlackoutView = {
  readonly id: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly removable: boolean;
};

export type InstantView = {
  readonly on: boolean;
  // The server's own deadline for Instant mode, when it is on.
  readonly expiresAt: string | null;
  readonly sessionActive: boolean;
  readonly configured: boolean;
  readonly otherSessionsOn: number;
};

export type ScheduleView =
  | {
      readonly status: "ready";
      readonly stage: AttorneyWorkspaceStage;
      readonly today: string;
      readonly displayZone: string;
      readonly calendar: readonly CalendarEntry[];
      readonly rules: readonly RuleView[];
      readonly blackouts: readonly BlackoutView[];
      // Null when the database reports no Instant status for this session.
      readonly instant: InstantView | null;
    }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" };

const SIGN_IN_REQUIRED = Object.freeze({ status: "sign-in-required" } as const);
const DENIED = Object.freeze({ status: "denied" } as const);
const UNAVAILABLE = Object.freeze({ status: "unavailable" } as const);

// One calendar row read strictly (MVP-001 S11 pass 2B: also read by the
// attorney's week view).
export function readCalendarEntry(row: unknown): CalendarEntry | null {
  const fields = readExact(row, CALENDAR_COLUMNS);
  if (fields === null) {
    return null;
  }
  const kind = fields.get("entry_kind");
  const id = fields.get("entry_id");
  const startsAt = fields.get("starts_at");
  const endsAt = fields.get("ends_at");
  const timezone = fields.get("timezone_name");
  const localDate = fields.get("local_date");
  const state = fields.get("entry_state");
  if (
    !isOneOf(ENTRY_KINDS, kind) ||
    !isUuid(id) ||
    !isTimestamp(startsAt) ||
    !isTimestamp(endsAt) ||
    Date.parse(startsAt) >= Date.parse(endsAt) ||
    typeof state !== "string" ||
    (kind === "window") !== isTimeZone(timezone) ||
    (kind === "window") !== isDate(localDate)
  ) {
    return null;
  }
  return Object.freeze({
    kind,
    id,
    startsAt,
    endsAt,
    timezone: kind === "window" ? (timezone as string) : null,
    localDate: kind === "window" ? (localDate as string) : null,
    state,
  });
}

// "09:00:00" (PostgreSQL time) as "09:00"; "24:00:00" stays "24:00".
function hoursMinutes(value: unknown): string | null {
  return typeof value === "string" &&
    /^(?:[01]\d|2[0-4]):[0-5]\d:00$/.test(value)
    ? value.slice(0, 5)
    : null;
}

function readRule(row: unknown): RuleView | null {
  const fields = readExact(row, RULE_COLUMNS.split(", "));
  if (fields === null) {
    return null;
  }
  const id = fields.get("id");
  const kind = fields.get("rule_kind");
  const timezone = fields.get("timezone_name");
  const weekday = fields.get("weekday");
  const date = fields.get("specific_date");
  const startTime = hoursMinutes(fields.get("local_start_time"));
  const endTime = hoursMinutes(fields.get("local_end_time"));
  const from = fields.get("effective_from");
  const until = fields.get("effective_until");
  if (
    !isUuid(id) ||
    !isOneOf(["recurring", "one_time"] as const, kind) ||
    !isTimeZone(timezone) ||
    startTime === null ||
    endTime === null
  ) {
    return null;
  }
  if (kind === "recurring") {
    if (
      !Number.isSafeInteger(weekday) ||
      (weekday as number) < 1 ||
      (weekday as number) > 7 ||
      date !== null ||
      !isDate(from) ||
      !(until === null || isDate(until))
    ) {
      return null;
    }
  } else if (
    weekday !== null ||
    !isDate(date) ||
    from !== null ||
    until !== null
  ) {
    return null;
  }
  return Object.freeze({
    id,
    kind,
    timezone,
    weekday: kind === "recurring" ? (weekday as number) : null,
    date: kind === "one_time" ? (date as string) : null,
    startTime,
    endTime,
    effectiveFrom: kind === "recurring" ? (from as string) : null,
    effectiveUntil: kind === "recurring" ? (until as string | null) : null,
  });
}

function readBlackout(row: unknown, now: number): BlackoutView | null {
  const fields = readExact(row, BLACKOUT_COLUMNS.split(", "));
  const id = fields?.get("id");
  const startsAt = fields?.get("starts_at");
  const endsAt = fields?.get("ends_at");
  if (
    fields === null ||
    !isUuid(id) ||
    !isTimestamp(startsAt) ||
    !isTimestamp(endsAt) ||
    Date.parse(startsAt) >= Date.parse(endsAt)
  ) {
    return null;
  }
  return Object.freeze({
    id,
    startsAt,
    endsAt,
    removable: Date.parse(startsAt) > now,
  });
}

function readInstant(rows: readonly unknown[]): InstantView | null | undefined {
  if (rows.length === 0) {
    return null;
  }
  if (rows.length !== 1) {
    return undefined;
  }
  const fields = readExact(rows[0], INSTANT_STATUS_COLUMNS);
  if (fields === null) {
    return undefined;
  }
  const on = fields.get("instant_on");
  const expiresAt = fields.get("intent_expires_at");
  const sessionActive = fields.get("session_active");
  const sessionExpires = fields.get("session_expires_at");
  const configured = fields.get("presence_configured");
  const others = fields.get("other_sessions_on");
  if (
    typeof on !== "boolean" ||
    typeof sessionActive !== "boolean" ||
    typeof configured !== "boolean" ||
    !Number.isSafeInteger(others) ||
    (others as number) < 0 ||
    (on ? !isTimestamp(expiresAt) : expiresAt !== null) ||
    (sessionActive ? !isTimestamp(sessionExpires) : sessionExpires !== null) ||
    (on && !sessionActive)
  ) {
    return undefined;
  }
  return Object.freeze({
    on,
    expiresAt: on ? (expiresAt as string) : null,
    sessionActive,
    configured,
    otherSessionsOn: others as number,
  });
}

// Reads the attorney's own schedule for the current request. It never
// throws: anything that fails, cannot be read, or does not add up is
// unavailable, and nothing is shown without the attorney principal.
export async function resolveAttorneySchedule(
  sources: AttorneyScheduleSources,
): Promise<ScheduleView> {
  try {
    const access = await resolveAttorneyWorkspaceAccess({
      session: sources.session,
      attorney: sources.attorney,
    });
    if (access.status === "sign-in-required") {
      return SIGN_IN_REQUIRED;
    }
    if (access.status === "denied") {
      return DENIED;
    }
    if (access.status !== "granted") {
      return UNAVAILABLE;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const now = sources.clock();
    if (!Number.isFinite(now)) {
      return UNAVAILABLE;
    }
    const today = new Date(now).toISOString().slice(0, 10);
    const [calendarRows, ruleRows, blackoutRows, instantRows] = (
      await Promise.all([
        attempt(() => reads.calendar(today, CALENDAR_DAYS)),
        attempt(() => reads.activeRules()),
        attempt(() => reads.blackoutsEndingAfter(new Date(now).toISOString())),
        attempt(() => reads.instantStatus()),
      ])
    ).map(rowsOf);
    if (
      calendarRows === null ||
      ruleRows === null ||
      blackoutRows === null ||
      instantRows === null ||
      ruleRows.length > MAX_RULES ||
      blackoutRows.length > MAX_BLACKOUTS
    ) {
      return UNAVAILABLE;
    }
    const calendar = calendarRows.map(readCalendarEntry);
    const rules = ruleRows.map(readRule);
    const blackouts = blackoutRows.map((row) => readBlackout(row, now));
    const instant = readInstant(instantRows);
    if (
      calendar.includes(null) ||
      rules.includes(null) ||
      blackouts.includes(null) ||
      instant === undefined
    ) {
      return UNAVAILABLE;
    }
    const ruleViews = rules as RuleView[];
    return Object.freeze({
      status: "ready",
      stage: access.stage,
      today,
      displayZone: ruleViews[0]?.timezone ?? "UTC",
      calendar: Object.freeze(calendar as CalendarEntry[]),
      rules: Object.freeze(ruleViews),
      blackouts: Object.freeze(blackouts as BlackoutView[]),
      instant,
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

// The database outcomes a change can report to the attorney ("not_configured"
// is the Instant switch's answer when its configuration is unset).
export const SCHEDULE_OUTCOMES = Object.freeze([
  "rule_created",
  "rule_deactivated",
  "rule_already_inactive",
  "blackout_created",
  "blackout_removed",
  "blackout_not_removable",
  "not_found",
  "rate_limited",
  "instant_enabled",
  "instant_disabled",
  "instant_unchanged",
  "no_session",
  "not_configured",
] as const);
export type ScheduleOutcome = (typeof SCHEDULE_OUTCOMES)[number];

export type ScheduleActionState =
  | { readonly status: "idle" }
  | { readonly status: "invalid"; readonly fieldErrors: FieldErrors }
  | { readonly status: "outcome"; readonly outcome: ScheduleOutcome }
  | { readonly status: "unconfirmed" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" }
  | StepUpRequired;

export const INITIAL_SCHEDULE_STATE: ScheduleActionState = Object.freeze({
  status: "idle",
});

const UNCONFIRMED = Object.freeze({ status: "unconfirmed" } as const);

function invalid(fieldErrors: Record<string, readonly string[]>) {
  return Object.freeze({
    status: "invalid",
    fieldErrors: Object.freeze(fieldErrors),
  } as const);
}

function outcomeState(outcome: ScheduleOutcome): ScheduleActionState {
  return Object.freeze({ status: "outcome", outcome });
}

const REJECTED_BY_DATABASE = invalid({
  submit: [
    "The schedule could not accept this change. Check it and try again.",
  ],
});

// Admits the request's attorney principal, then hands the write port to the
// change. Nothing is sent without the principal.
async function withWrites(
  sources: AttorneyScheduleSources,
  change: (writes: AttorneyScheduleWrites) => Promise<ScheduleActionState>,
): Promise<ScheduleActionState> {
  try {
    const access = await resolveAttorneyWorkspaceAccess({
      session: sources.session,
      attorney: sources.attorney,
    });
    if (access.status === "sign-in-required") {
      return SIGN_IN_REQUIRED;
    }
    if (access.status === "denied") {
      return DENIED;
    }
    if (access.status !== "granted") {
      return UNAVAILABLE;
    }
    const writes = await portFrom(sources.writes);
    return writes === null ? UNAVAILABLE : await change(writes);
  } catch {
    return UNAVAILABLE;
  }
}

// Maps one answer through the change's own table of outcomes. "denied" is
// always a refusal; a database rejection inside the call committed nothing;
// anything unknown is unconfirmed.
function settle(
  answer: unknown,
  table: Readonly<Record<string, ScheduleActionState>>,
): ScheduleActionState {
  const fields = readExact(answer, ["kind", "outcome", "value"]);
  if (fields?.get("kind") === "answer") {
    const outcome = fields.get("outcome");
    if (outcome === "denied") {
      return DENIED;
    }
    if (typeof outcome === "string" && Object.hasOwn(table, outcome)) {
      return table[outcome];
    }
    return UNCONFIRMED;
  }
  return readExact(answer, ["kind"])?.get("kind") === "rejected"
    ? REJECTED_BY_DATABASE
    : UNCONFIRMED;
}

function field(
  fields: ReadonlyMap<string, string>,
  name: string,
): string | null {
  return textField(fields.get(name), 64);
}

// A recurring or one-time availability rule from the submitted form.
export function readRuleForm(
  formData: FormData,
  today: string,
):
  | { readonly ok: true; readonly input: RuleInput }
  | ReturnType<typeof invalid> {
  const fields = readFormFields(formData);
  const errors: Record<string, string[]> = {};
  const kind = field(fields, "kind");
  const timezone = field(fields, "timezone");
  const startTime = field(fields, "start_time");
  const endTime = field(fields, "end_time");
  if (kind !== "recurring" && kind !== "one_time") {
    errors.kind = ["Choose a weekly or a single-date rule."];
  }
  if (!isTimeZone(timezone) || !knownTimeZones().includes(timezone)) {
    errors.timezone = ["Choose a time zone from the list."];
  }
  const endOk = isLocalTime(endTime) || endTime === "24:00";
  if (!isLocalTime(startTime)) {
    errors.start_time = ["Enter a start time as HH:MM."];
  }
  if (!endOk) {
    errors.end_time = ["Enter an end time as HH:MM."];
  } else if (isLocalTime(startTime) && (endTime as string) <= startTime) {
    errors.end_time = ["The end time must be after the start time."];
  }
  let weekday: number | null = null;
  let date: string | null = null;
  let effectiveFrom: string | null = null;
  let effectiveUntil: string | null = null;
  if (kind === "recurring") {
    const day = field(fields, "weekday");
    weekday = day !== null && /^[1-7]$/.test(day) ? Number(day) : null;
    if (weekday === null) {
      errors.weekday = ["Choose a day of the week."];
    }
    const from = field(fields, "effective_from");
    effectiveFrom = from === "" ? today : from;
    if (!isDate(effectiveFrom)) {
      errors.effective_from = ["Enter the first date as YYYY-MM-DD."];
    }
    const until = field(fields, "effective_until");
    effectiveUntil = until === "" ? null : until;
    if (
      effectiveUntil !== null &&
      (!isDate(effectiveUntil) ||
        (isDate(effectiveFrom) && effectiveUntil < effectiveFrom))
    ) {
      errors.effective_until = [
        "Enter a last date on or after the first date, or leave it empty.",
      ];
    }
  } else if (kind === "one_time") {
    date = field(fields, "date");
    if (!isDate(date)) {
      errors.date = ["Enter the date as YYYY-MM-DD."];
    }
  }
  if (Object.keys(errors).length > 0) {
    return invalid(errors);
  }
  return Object.freeze({
    ok: true,
    input: Object.freeze({
      kind: kind as RuleInput["kind"],
      timezone: timezone as string,
      weekday,
      date,
      startTime: startTime as string,
      endTime: endTime as string,
      effectiveFrom: kind === "recurring" ? effectiveFrom : null,
      effectiveUntil: kind === "recurring" ? effectiveUntil : null,
    }),
  });
}

const DST_MESSAGE =
  "This time does not exist, or occurs twice, on that date in this time zone (a daylight-saving change). Choose another time.";

// A Blackout from local dates and times in a chosen time zone.
export function readBlackoutForm(
  formData: FormData,
  now: number,
):
  | { readonly ok: true; readonly input: BlackoutInput }
  | ReturnType<typeof invalid> {
  const fields = readFormFields(formData);
  const errors: Record<string, string[]> = {};
  const timezone = field(fields, "timezone");
  if (!isTimeZone(timezone) || !knownTimeZones().includes(timezone)) {
    errors.timezone = ["Choose a time zone from the list."];
    return invalid(errors);
  }
  const instantOf = (prefix: "start" | "end") => {
    const date = field(fields, `${prefix}_date`);
    const time = field(fields, `${prefix}_time`);
    if (!isDate(date)) {
      errors[`${prefix}_date`] = ["Enter the date as YYYY-MM-DD."];
      return null;
    }
    if (!isLocalTime(time)) {
      errors[`${prefix}_time`] = ["Enter the time as HH:MM."];
      return null;
    }
    const instant = zonedInstant(date, time, timezone);
    if (instant === null) {
      errors[`${prefix}_time`] = [DST_MESSAGE];
    }
    return instant;
  };
  const startsAt = instantOf("start");
  const endsAt = instantOf("end");
  if (startsAt !== null && endsAt !== null) {
    if (Date.parse(endsAt) <= Date.parse(startsAt)) {
      errors.end_time = ["The end must be after the start."];
    } else if (Date.parse(endsAt) <= now) {
      errors.end_time = ["The end must be in the future."];
    }
  }
  if (Object.keys(errors).length > 0 || startsAt === null || endsAt === null) {
    return invalid(errors);
  }
  return Object.freeze({
    ok: true,
    input: Object.freeze({ startsAt, endsAt }),
  });
}

export async function createAvailabilityRule(
  sources: AttorneyScheduleSources,
  formData: FormData,
): Promise<ScheduleActionState> {
  const read = readRuleForm(
    formData,
    new Date(sources.clock()).toISOString().slice(0, 10),
  );
  if (!("ok" in read)) {
    return read;
  }
  return withWrites(sources, async (writes) =>
    settle(await attempt(() => writes.createRule(read.input)), {
      created: outcomeState("rule_created"),
      rate_limited: outcomeState("rate_limited"),
      invalid: REJECTED_BY_DATABASE,
    }),
  );
}

function idFrom(formData: FormData, name: string): string | null {
  const value = readFormFields(formData).get(name);
  return isUuid(value) ? value : null;
}

export async function deactivateAvailabilityRule(
  sources: AttorneyScheduleSources,
  formData: FormData,
): Promise<ScheduleActionState> {
  const ruleId = idFrom(formData, "rule");
  if (ruleId === null) {
    return outcomeState("not_found");
  }
  return withWrites(sources, async (writes) =>
    settle(await attempt(() => writes.deactivateRule(ruleId)), {
      deactivated: outcomeState("rule_deactivated"),
      already_inactive: outcomeState("rule_already_inactive"),
      not_found: outcomeState("not_found"),
    }),
  );
}

export async function createBlackout(
  sources: AttorneyScheduleSources,
  formData: FormData,
): Promise<ScheduleActionState> {
  const read = readBlackoutForm(formData, sources.clock());
  if (!("ok" in read)) {
    return read;
  }
  return withWrites(sources, async (writes) =>
    settle(await attempt(() => writes.createBlackout(read.input)), {
      created: outcomeState("blackout_created"),
      rate_limited: outcomeState("rate_limited"),
      invalid: REJECTED_BY_DATABASE,
    }),
  );
}

export async function removeBlackout(
  sources: AttorneyScheduleSources,
  formData: FormData,
): Promise<ScheduleActionState> {
  const blackoutId = idFrom(formData, "blackout");
  if (blackoutId === null) {
    return outcomeState("not_found");
  }
  return withWrites(sources, async (writes) =>
    settle(await attempt(() => writes.removeBlackout(blackoutId)), {
      removed: outcomeState("blackout_removed"),
      not_removable: outcomeState("blackout_not_removable"),
      not_found: outcomeState("not_found"),
    }),
  );
}

export async function switchInstantMode(
  sources: AttorneyScheduleSources,
  formData: FormData,
): Promise<ScheduleActionState> {
  const intent = readFormFields(formData).get("instant");
  if (intent !== "on" && intent !== "off") {
    return invalid({ submit: ["Choose to turn Instant mode on or off."] });
  }
  return withWrites(sources, async (writes) =>
    settle(await attempt(() => writes.setInstant(intent === "on")), {
      enabled: outcomeState("instant_enabled"),
      disabled: outcomeState("instant_disabled"),
      unchanged: outcomeState("instant_unchanged"),
      no_session: outcomeState("no_session"),
      unavailable: outcomeState("not_configured"),
      invalid: REJECTED_BY_DATABASE,
    }),
  );
}

// ---------------------------------------------------------------------------
// The heartbeat
// ---------------------------------------------------------------------------

export type HeartbeatState =
  | { readonly status: "observed"; readonly instant: InstantView | null }
  | { readonly status: "no-session" }
  | { readonly status: "refused" }
  | { readonly status: "unavailable" }
  | StepUpRequired;

const HEARTBEAT_NO_SESSION = Object.freeze({ status: "no-session" } as const);
const HEARTBEAT_REFUSED = Object.freeze({ status: "refused" } as const);
const HEARTBEAT_UNAVAILABLE = Object.freeze({ status: "unavailable" } as const);

// Asks the server to observe this session (renewing Instant mode's server
// lease when it is on), then reads the server's own status. The browser sends
// nothing but the request itself.
export async function observeScheduleSession(
  sources: AttorneyScheduleSources,
): Promise<HeartbeatState> {
  try {
    const access = await resolveAttorneyWorkspaceAccess({
      session: sources.session,
      attorney: sources.attorney,
    });
    if (access.status === "sign-in-required" || access.status === "denied") {
      return HEARTBEAT_REFUSED;
    }
    if (access.status !== "granted") {
      return HEARTBEAT_UNAVAILABLE;
    }
    const writes = await portFrom(sources.writes);
    const reads = await portFrom(sources.reads);
    if (writes === null || reads === null) {
      return HEARTBEAT_UNAVAILABLE;
    }
    const answer = readExact(await attempt(() => writes.touchSession()), [
      "kind",
      "outcome",
      "value",
    ]);
    if (answer?.get("kind") !== "answer") {
      return HEARTBEAT_UNAVAILABLE;
    }
    switch (answer.get("outcome")) {
      case "observed": {
        const rows = rowsOf(await attempt(() => reads.instantStatus()));
        const instant = rows === null ? undefined : readInstant(rows);
        return instant === undefined
          ? HEARTBEAT_UNAVAILABLE
          : Object.freeze({ status: "observed", instant });
      }
      case "no_session":
        return HEARTBEAT_NO_SESSION;
      case "denied":
        return HEARTBEAT_REFUSED;
      default:
        return HEARTBEAT_UNAVAILABLE;
    }
  } catch {
    return HEARTBEAT_UNAVAILABLE;
  }
}
