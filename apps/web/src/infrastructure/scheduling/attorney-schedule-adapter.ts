// Server-only attorney schedule adapter (MVP-001 S4).
//
// Builds the schedule ports for one request. Every read goes through the
// request-scoped, unprivileged server client: the attorney's own active
// availability rules and Blackouts under their own-row policies, and the
// attorney's own calendar and Instant status through the database's own
// read functions. Every change is one database function called through that
// same client, so the database decides the actor, the aal2 session and the
// attorney's own profile from the request's own authenticated session. Each
// function is called by its literal name, exactly once in this module. No
// privileged credential or client is used or seen here. Every call is
// bounded in time; anything that fails, throws, or is too slow is reported as
// unreadable, and a function's answer is read strictly against its own fixed
// outcomes. Each such failure writes one log line naming the call and how it
// failed (the error code and HTTP status only, MVP-001 D-8), and nothing the
// call carried or answered.
//
// Sign-out's server side, scheduling_end_session, is offered as one
// best-effort step for the sign-out action: it ends this request's
// application session and its Instant intent before the provider ends the
// Auth session, never blocks or fails sign-out, and logs only its fixed
// outcome.

import {
  BLACKOUT_COLUMNS,
  CREATE_BLACKOUT_OUTCOMES,
  CREATE_RULE_OUTCOMES,
  DEACTIVATE_RULE_OUTCOMES,
  END_SESSION_OUTCOMES,
  INSTANT_OUTCOMES,
  MAX_BLACKOUTS,
  MAX_RULES,
  REMOVE_BLACKOUT_OUTCOMES,
  RULE_COLUMNS,
  TOUCH_OUTCOMES,
  type AttorneyScheduleReads,
  type AttorneyScheduleSources,
  type AttorneyScheduleWrites,
  type BlackoutInput,
  type CallAnswer,
  type RuleInput,
} from "../../application/attorney-schedule.ts";
import {
  rowsResultOf,
  UNREADABLE_ROWS,
  withinDeadline,
  type RowsResult,
} from "../../application/professional-identity.ts";
import { ATTORNEY_PRINCIPAL_SOURCE } from "../identity/attorney-principal-source.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../identity/server-session-source.ts";
import { errorFieldsOf, type LogFields } from "../observability/log.ts";
import { logRequestEvent } from "../observability/request-log.ts";
import {
  boundedPort,
  CALL_DEADLINE_MS,
  checkDeadline,
  createDefaultRequestClient,
  type RequestClient,
  type RequestClientSource,
} from "../professional/professional-request-client.ts";

const CALL_FAILED = "scheduling.call_failed";
const EXPIRED = Symbol("expired");
// Sign-out waits at most this long for its server-side step.
const END_SESSION_DEADLINE_MS = 3000;

const REJECTED: CallAnswer = Object.freeze({ kind: "rejected" });
const UNREADABLE: CallAnswer = Object.freeze({ kind: "unreadable" });

// A PostgreSQL error code (SQLSTATE): five digits or capital letters.
const SQLSTATE = /^[0-9A-Z]{5}$/;

function ownField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

// A database error inside the call (its transaction rolled back), excluding
// connection-class errors and operator interventions.
function rejectedCall(result: unknown): boolean {
  const code = ownField(ownField(result, "error"), "code");
  const status = ownField(result, "status");
  return (
    typeof code === "string" &&
    SQLSTATE.test(code) &&
    !code.startsWith("08") &&
    !code.startsWith("57P") &&
    typeof status === "number" &&
    status >= 400 &&
    status <= 599
  );
}

// A scalar text function's answer.
export function textAnswerOf(
  result: unknown,
  outcomes: readonly string[],
): CallAnswer {
  if (ownField(result, "error") !== null) {
    return rejectedCall(result) ? REJECTED : UNREADABLE;
  }
  const data = ownField(result, "data");
  return typeof data === "string" && outcomes.includes(data)
    ? Object.freeze({ kind: "answer", outcome: data, value: null })
    : UNREADABLE;
}

// A set-returning function's one row, { outcome, <valueColumn> }.
export function rowAnswerOf(
  result: unknown,
  outcomes: readonly string[],
  valueColumn: string,
): CallAnswer {
  if (ownField(result, "error") !== null) {
    return rejectedCall(result) ? REJECTED : UNREADABLE;
  }
  const data = ownField(result, "data");
  if (!Array.isArray(data) || data.length !== 1) {
    return UNREADABLE;
  }
  const row = data[0];
  if (
    row === null ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).length !== 2
  ) {
    return UNREADABLE;
  }
  const outcome = ownField(row, "outcome");
  const value = ownField(row, valueColumn);
  if (
    typeof outcome !== "string" ||
    !outcomes.includes(outcome) ||
    !(value === null || typeof value === "string")
  ) {
    return UNREADABLE;
  }
  return Object.freeze({ kind: "answer", outcome, value });
}

function failureOf(result: unknown): LogFields {
  const status = ownField(result, "status");
  return {
    ...errorFieldsOf(ownField(result, "error")),
    ...(typeof status === "number" ? { status } : {}),
  };
}

type Observation<T> = {
  readonly answer: T;
  readonly failure: LogFields | null;
};

// Runs one call within the deadline; a call that threw, failed, or ran out
// of time answers the fallback and writes one log line.
async function observed<T>(
  operation: string,
  deadlineMs: number,
  fallback: T,
  call: () => Promise<Observation<T>>,
): Promise<T> {
  const settled = await withinDeadline<Observation<T> | typeof EXPIRED>(
    async () => {
      try {
        return await call();
      } catch (error) {
        return {
          answer: fallback,
          failure: { outcome: "threw", ...errorFieldsOf(error) },
        };
      }
    },
    EXPIRED,
    deadlineMs,
  );
  if (settled === EXPIRED) {
    await logRequestEvent("warn", CALL_FAILED, {
      operation,
      outcome: "deadline",
    });
    return fallback;
  }
  if (settled.failure !== null) {
    await logRequestEvent("warn", CALL_FAILED, {
      operation,
      ...settled.failure,
    });
  }
  return settled.answer;
}

type QueryAnswer = { readonly data: unknown; readonly error: unknown };

function observedRead(
  operation: string,
  deadlineMs: number,
  query: () => PromiseLike<QueryAnswer>,
): Promise<RowsResult> {
  return observed(operation, deadlineMs, UNREADABLE_ROWS, async () => {
    const result = await query();
    const rows = rowsResultOf(result);
    return {
      answer: rows,
      failure:
        rows.kind === "rows"
          ? null
          : {
              outcome: result.error === null ? "malformed" : "error",
              ...failureOf(result),
            },
    };
  });
}

function observedWrite(
  operation: string,
  deadlineMs: number,
  call: () => PromiseLike<unknown>,
  read: (result: unknown) => CallAnswer,
): Promise<CallAnswer> {
  return observed(operation, deadlineMs, UNREADABLE, async () => {
    const result = await call();
    const answer = read(result);
    return {
      answer,
      failure:
        answer.kind === "answer"
          ? null
          : { outcome: answer.kind, ...failureOf(result) },
    };
  });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createAttorneyScheduleReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<AttorneyScheduleReads | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client: RequestClient | null = await withinDeadline(
      clientSource,
      null,
      deadlineMs,
    );
    if (client === null) {
      return null;
    }
    return boundedPort(
      {
        calendar: async (fromDate: string, dayCount: number) =>
          ISO_DATE.test(fromDate) &&
          Number.isSafeInteger(dayCount) &&
          dayCount >= 1 &&
          dayCount <= 31
            ? observedRead("attorney_schedule_calendar", deadlineMs, () =>
                client.rpc("attorney_schedule_calendar", {
                  p_from_date: fromDate,
                  p_day_count: dayCount,
                }),
              )
            : UNREADABLE_ROWS,
        activeRules: () =>
          observedRead("activeRules", deadlineMs, () =>
            client
              .from("availability_rules")
              .select(RULE_COLUMNS)
              .eq("active", true)
              .order("created_at", { ascending: true })
              .order("id", { ascending: true })
              .limit(MAX_RULES + 1),
          ),
        blackoutsEndingAfter: (instant: string) =>
          observedRead("blackoutsEndingAfter", deadlineMs, () =>
            client
              .from("blackouts")
              .select(BLACKOUT_COLUMNS)
              .gt("ends_at", instant)
              .order("starts_at", { ascending: true })
              .order("id", { ascending: true })
              .limit(MAX_BLACKOUTS + 1),
          ),
        instantStatus: () =>
          observedRead("attorney_instant_status", deadlineMs, () =>
            client.rpc("attorney_instant_status"),
          ),
      },
      deadlineMs,
    );
  };
}

export function createAttorneyScheduleWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<AttorneyScheduleWrites | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client: RequestClient | null = await withinDeadline(
      clientSource,
      null,
      deadlineMs,
    );
    if (client === null) {
      return null;
    }
    return Object.freeze({
      createRule: (input: RuleInput) =>
        observedWrite(
          "attorney_create_availability_rule",
          deadlineMs,
          () =>
            client.rpc("attorney_create_availability_rule", {
              p_rule_kind: input.kind,
              p_timezone_name: input.timezone,
              p_weekday: input.weekday,
              p_specific_date: input.date,
              p_local_start_time: input.startTime,
              p_local_end_time: input.endTime,
              p_effective_from: input.effectiveFrom,
              p_effective_until: input.effectiveUntil,
            }),
          (result) => rowAnswerOf(result, CREATE_RULE_OUTCOMES, "rule_id"),
        ),
      deactivateRule: (ruleId: string) =>
        observedWrite(
          "attorney_deactivate_availability_rule",
          deadlineMs,
          () =>
            client.rpc("attorney_deactivate_availability_rule", {
              p_rule_id: ruleId,
            }),
          (result) => textAnswerOf(result, DEACTIVATE_RULE_OUTCOMES),
        ),
      createBlackout: (input: BlackoutInput) =>
        observedWrite(
          "attorney_create_blackout",
          deadlineMs,
          () =>
            client.rpc("attorney_create_blackout", {
              p_starts_at: input.startsAt,
              p_ends_at: input.endsAt,
              p_reason_code: null,
            }),
          (result) =>
            rowAnswerOf(result, CREATE_BLACKOUT_OUTCOMES, "blackout_id"),
        ),
      removeBlackout: (blackoutId: string) =>
        observedWrite(
          "attorney_remove_blackout",
          deadlineMs,
          () =>
            client.rpc("attorney_remove_blackout", {
              p_blackout_id: blackoutId,
            }),
          (result) => textAnswerOf(result, REMOVE_BLACKOUT_OUTCOMES),
        ),
      setInstant: (enabled: boolean) =>
        observedWrite(
          "attorney_set_instant_intent",
          deadlineMs,
          () =>
            client.rpc("attorney_set_instant_intent", {
              p_enabled: enabled,
            }),
          (result) => textAnswerOf(result, INSTANT_OUTCOMES),
        ),
      touchSession: () =>
        observedWrite(
          "scheduling_touch_session",
          deadlineMs,
          () => client.rpc("scheduling_touch_session"),
          (result) => textAnswerOf(result, TOUCH_OUTCOMES),
        ),
    } satisfies AttorneyScheduleWrites);
  };
}

// Sign-out's best-effort server step on the sign-out action's own
// request-scoped client. It never throws and never waits longer than its
// deadline; it logs only its fixed outcome.
export async function endSchedulingSession(
  client: RequestClient,
): Promise<void> {
  try {
    const answer = await observedWrite(
      "scheduling_end_session",
      END_SESSION_DEADLINE_MS,
      () => client.rpc("scheduling_end_session"),
      (result) => textAnswerOf(result, END_SESSION_OUTCOMES),
    );
    await logRequestEvent("info", "scheduling.session_end", {
      outcome: answer.kind === "answer" ? answer.outcome : answer.kind,
    });
  } catch {
    // Sign-out goes on whatever happened here.
  }
}

// The production sources: the trusted server session, the trusted attorney
// principal source for the Security Shell, the request-scoped ports above,
// and the server clock.
export const ATTORNEY_SCHEDULE_SOURCES: AttorneyScheduleSources = Object.freeze(
  {
    session: SUPABASE_SERVER_SESSION_SOURCE,
    attorney: ATTORNEY_PRINCIPAL_SOURCE,
    reads: createAttorneyScheduleReads(),
    writes: createAttorneyScheduleWrites(),
    clock: () => Date.now(),
  },
);
