// Server-only client intake adapter (P5-001).
//
// Builds the client intake ports for one request. Every read goes through
// the request-scoped, unprivileged server client under the database's
// own-row policies, keyed only by the verified account, User, Client
// Profile, and Intake ids the application boundary derives; the two catalog
// reads are the client catalog functions. Every change is one client database
// function called through that same client, so the database decides the actor
// from the request's own authenticated session. No privileged credential or
// client is used or seen here. Every call is bounded in time; anything that
// fails, throws, or is too slow is reported as unreadable, and a write's
// answer is read strictly against that function's own outcomes. Each such
// failure also writes one log line naming the call and how it failed, with
// the error code and HTTP status the database or API reported, and nothing
// the call carried or answered (MVP-001 D-8). The workspace list is read one
// page at a time, and each shown Intake's latest revision summary is read on
// its own, so no shown Intake can be silently dropped (MVP-001 D-3).
// MVP-001 S3 part 2: it also reads the Intake's presented AI suggestions
// under their own-row policy, and makes the client's decision on one
// (client_confirm_ai_suggestion or client_reject_ai_suggestion) and the
// post-submission change request (client_request_intake_change), each one
// literal call through the same request-scoped client. Nothing a
// suggestion holds is logged.

import {
  ASSESSMENT_COLUMNS,
  CHANGE_OUTCOMES,
  CLIENT_PROFILE_COLUMNS,
  CLOSE_OUTCOMES,
  CONFIRM_SUGGESTION_OUTCOMES,
  CREATE_OUTCOMES,
  INTAKE_CHANGES,
  INTAKE_COLUMNS,
  QUESTION_SET_COLUMNS,
  REJECT_SUGGESTION_OUTCOMES,
  REVISION_COLUMNS,
  REVISION_SUMMARY_COLUMNS,
  SAVE_OUTCOMES,
  SUBMIT_OUTCOMES,
  SUGGESTION_COLUMNS,
  type CallAnswer,
  type ClientIntakeReads,
  type ClientIntakeSources,
  type ClientIntakeWrites,
  type IntakeChange,
  type RevisionInput,
} from "../../application/client-intake.ts";
import {
  rowsResultOf,
  UNREADABLE_ROWS,
  USER_COLUMNS,
  withinDeadline,
  type RowsResult,
} from "../../application/professional-identity.ts";
import { CLIENT_PRINCIPAL_SOURCE } from "../identity/client-principal-source.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../identity/server-session-source.ts";
import { errorFieldsOf, type LogFields } from "../observability/log.ts";
import { logRequestEvent } from "../observability/request-log.ts";
import {
  boundedPort,
  CALL_DEADLINE_MS,
  checkDeadline,
  createDefaultRequestClient,
  createRequestAccountSource,
  type RequestClient,
  type RequestClientSource,
} from "../professional/professional-request-client.ts";

const MAX_VERSIONS = 200;
const MAX_ASSESSMENTS = 100;
// The suggestions one Intake can hold (the database's own abuse bound).
const MAX_SUGGESTIONS = 50;

const REJECTED: CallAnswer = Object.freeze({ kind: "rejected" });
const UNREADABLE: CallAnswer = Object.freeze({ kind: "unreadable" });

const CALL_FAILED = "client_intake.call_failed";
const EXPIRED = Symbol("expired");

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
// connection-class errors and operator interventions, which can end a
// session around its commit.
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
    !(value === null || typeof value === "string" || typeof value === "number")
  ) {
    return UNREADABLE;
  }
  return Object.freeze({ kind: "answer", outcome, value });
}

// The error code and HTTP status a call's answer reported, and nothing else.
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

// Runs one call within the deadline. It answers what the call answered, or
// the fallback when the call threw or was still running at the deadline. A
// call that threw, answered with a failure, or ran out of time writes one
// log line; the outcome is never changed by it.
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

function isPageBound(offset: unknown, count: unknown): boolean {
  return (
    Number.isSafeInteger(offset) &&
    (offset as number) >= 0 &&
    Number.isSafeInteger(count) &&
    (count as number) >= 1
  );
}

export function createClientIntakeReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<ClientIntakeReads | null> {
  checkDeadline(deadlineMs);
  return async () => {
    const client = await withinDeadline(clientSource, null, deadlineMs);
    if (client === null) {
      return null;
    }
    return boundedPort(
      {
        usersOf: (accountId: string) =>
          observedRead("usersOf", deadlineMs, () =>
            client
              .from("users")
              .select(USER_COLUMNS)
              .eq("auth_user_id", accountId)
              .limit(2),
          ),
        clientProfilesOf: (userId: string) =>
          observedRead("clientProfilesOf", deadlineMs, () =>
            client
              .from("client_profiles")
              .select(CLIENT_PROFILE_COLUMNS)
              .eq("user_id", userId)
              .limit(2),
          ),
        intakesOf: async (clientId: string, offset: number, count: number) => {
          if (!isPageBound(offset, count)) {
            return UNREADABLE_ROWS;
          }
          return observedRead("intakesOf", deadlineMs, () => {
            const newestFirst = client
              .from("intakes")
              .select(INTAKE_COLUMNS)
              .eq("client_id", clientId)
              .order("created_at", { ascending: false })
              .order("id", { ascending: false });
            // The first page skips nothing, so it needs no offset.
            return offset === 0
              ? newestFirst.limit(count)
              : newestFirst.range(offset, offset + count - 1);
          });
        },
        intakeOf: (clientId: string, intakeId: string) =>
          observedRead("intakeOf", deadlineMs, () =>
            client
              .from("intakes")
              .select(INTAKE_COLUMNS)
              .eq("id", intakeId)
              .eq("client_id", clientId)
              .limit(2),
          ),
        latestRevisionSummaryOf: (intakeId: string) =>
          observedRead("latestRevisionSummaryOf", deadlineMs, () =>
            client
              .from("intake_revisions")
              .select(REVISION_SUMMARY_COLUMNS)
              .eq("intake_id", intakeId)
              .order("revision_number", { ascending: false })
              .limit(1),
          ),
        latestRevisionOf: (intakeId: string) =>
          observedRead("latestRevisionOf", deadlineMs, () =>
            client
              .from("intake_revisions")
              .select(REVISION_COLUMNS)
              .eq("intake_id", intakeId)
              .order("revision_number", { ascending: false })
              .limit(1),
          ),
        questionSets: () =>
          observedRead("questionSets", deadlineMs, () =>
            client
              .from("intake_question_sets")
              .select(QUESTION_SET_COLUMNS)
              .order("published_at", { ascending: false })
              .limit(MAX_VERSIONS),
          ),
        assessmentsOf: (intakeId: string) =>
          observedRead("assessmentsOf", deadlineMs, () =>
            client
              .from("jurisdiction_assessments")
              .select(ASSESSMENT_COLUMNS)
              .eq("intake_id", intakeId)
              .order("created_at", { ascending: true })
              .limit(MAX_ASSESSMENTS),
          ),
        practiceAreas: () =>
          observedRead("practiceAreas", deadlineMs, () =>
            client.rpc("client_intake_practice_areas"),
          ),
        jurisdictions: () =>
          observedRead("jurisdictions", deadlineMs, () =>
            client.rpc("client_intake_jurisdictions"),
          ),
        suggestionsOf: (intakeId: string) =>
          observedRead("suggestionsOf", deadlineMs, () =>
            client
              .from("ai_suggestions")
              .select(SUGGESTION_COLUMNS)
              .eq("context_type", "intake")
              .eq("context_id", intakeId)
              .order("presented_at", { ascending: false })
              .order("id", { ascending: false })
              .limit(MAX_SUGGESTIONS),
          ),
      },
      deadlineMs,
    );
  };
}

export function createClientIntakeWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<ClientIntakeWrites | null> {
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
      createIntake: () =>
        observedWrite(
          "client_create_intake",
          deadlineMs,
          () => client.rpc("client_create_intake"),
          (result) => rowAnswerOf(result, CREATE_OUTCOMES, "intake_id"),
        ),
      saveRevision: (input: RevisionInput) =>
        observedWrite(
          "client_save_intake_revision",
          deadlineMs,
          () =>
            client.rpc("client_save_intake_revision", {
              p_intake_id: input.intakeId,
              p_expected_revision: input.expectedRevision,
              p_question_set_id: input.questionSetId,
              p_practice_area_id: input.practiceAreaId,
              p_description: input.description,
              p_answers: input.answers,
            }),
          (result) => rowAnswerOf(result, SAVE_OUTCOMES, "revision_number"),
        ),
      submitIntake: (intakeId: string, expectedRevision: number | null) =>
        observedWrite(
          "client_submit_intake",
          deadlineMs,
          () =>
            client.rpc("client_submit_intake", {
              p_intake_id: intakeId,
              p_expected_revision: expectedRevision,
            }),
          (result) => textAnswerOf(result, SUBMIT_OUTCOMES),
        ),
      closeIntake: (intakeId: string) =>
        observedWrite(
          "client_close_intake",
          deadlineMs,
          () =>
            client.rpc("client_close_intake", {
              p_intake_id: intakeId,
            }),
          (result) => textAnswerOf(result, CLOSE_OUTCOMES),
        ),
      decideSuggestion: async (
        suggestionId: string,
        decision: "confirm" | "reject",
      ) => {
        if (decision === "confirm") {
          return observedWrite(
            "client_confirm_ai_suggestion",
            deadlineMs,
            () =>
              client.rpc("client_confirm_ai_suggestion", {
                p_suggestion_id: suggestionId,
              }),
            (result) => textAnswerOf(result, CONFIRM_SUGGESTION_OUTCOMES),
          );
        }
        if (decision === "reject") {
          return observedWrite(
            "client_reject_ai_suggestion",
            deadlineMs,
            () =>
              client.rpc("client_reject_ai_suggestion", {
                p_suggestion_id: suggestionId,
              }),
            (result) => textAnswerOf(result, REJECT_SUGGESTION_OUTCOMES),
          );
        }
        return UNREADABLE;
      },
      requestChange: async (intakeId: string, change: IntakeChange) =>
        INTAKE_CHANGES.includes(change)
          ? observedWrite(
              "client_request_intake_change",
              deadlineMs,
              () =>
                client.rpc("client_request_intake_change", {
                  p_intake_id: intakeId,
                  p_change: change,
                }),
              (result) => textAnswerOf(result, CHANGE_OUTCOMES),
            )
          : UNREADABLE,
    } satisfies ClientIntakeWrites);
  };
}

// The production sources: the trusted server session, the trusted client
// principal source for the Security Shell, a fresh Auth read, and the
// request-scoped ports above.
export const CLIENT_INTAKE_SOURCES: ClientIntakeSources = Object.freeze({
  session: SUPABASE_SERVER_SESSION_SOURCE,
  contexts: CLIENT_PRINCIPAL_SOURCE,
  account: createRequestAccountSource(),
  reads: createClientIntakeReads(),
  writes: createClientIntakeWrites(),
});
