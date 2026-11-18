// Server-only attorney request adapter (MVP-001 S8).
//
// Builds the attorney request ports for one request. Every call goes through
// the request-scoped, unprivileged server client (the publishable key and the
// request's own cookie session): the attorney's queue and one Request, the
// PS-A2 environment accessor, and the two decision functions (accepting and
// declining), so the database decides the actor, the aal2 session and the
// attorney's own approved profile from the request's own authenticated
// session. Each function is called by its literal name, exactly once in this
// module. No privileged credential or client is used or seen here, and
// nothing reads a table directly. Every call is bounded in time; anything
// that fails, throws, or is too slow is reported as unreadable, a malformed
// identifier is refused before anything is sent, and each decision's answer
// is read strictly against its own fixed outcomes. Each such failure writes
// one log line naming the call and how it failed (the error code and HTTP
// status only, MVP-001 D-8), and nothing the call carried or answered.

import {
  ACCEPT_OUTCOMES,
  DECLINE_OUTCOMES,
  type AttorneyRequestReads,
  type AttorneyRequestSources,
  type AttorneyRequestWrites,
  type CallAnswer,
} from "../../application/attorney-requests.ts";
import {
  rowsResultOf,
  UNREADABLE_ROWS,
  withinDeadline,
  type RowsResult,
} from "../../application/professional-identity.ts";
import { readEnvironmentConfiguration } from "../environment/environment-configuration.ts";
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

const CALL_FAILED = "attorney_decision.call_failed";
const EXPIRED = Symbol("expired");

const REJECTED: CallAnswer = Object.freeze({ kind: "rejected" });
const UNREADABLE: CallAnswer = Object.freeze({ kind: "unreadable" });

// A PostgreSQL error code (SQLSTATE): five digits or capital letters.
const SQLSTATE = /^[0-9A-Z]{5}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROBLEM = /^[a-z][a-z0-9_]{1,63}$/;

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

// The one row of a table-returning call with exactly these keys, or null.
function oneRow(result: unknown, keys: readonly string[]): object | null {
  const data = ownField(result, "data");
  if (!Array.isArray(data) || data.length !== 1) {
    return null;
  }
  const row: unknown = data[0];
  if (
    row === null ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(row, key))
  ) {
    return null;
  }
  return row;
}

// attorney_accept_request's one row, { outcome, consultation_id, problem }.
// The value carried on is the Consultation id (null while its creation waits
// for the capture, and on every refusal but already_decided).
export function acceptAnswerOf(result: unknown): CallAnswer {
  if (ownField(result, "error") !== null) {
    return rejectedCall(result) ? REJECTED : UNREADABLE;
  }
  const row = oneRow(result, ["outcome", "consultation_id", "problem"]);
  if (row === null) {
    return UNREADABLE;
  }
  const outcome = ownField(row, "outcome");
  const value = ownField(row, "consultation_id");
  const problem = ownField(row, "problem");
  if (
    typeof outcome !== "string" ||
    !ACCEPT_OUTCOMES.includes(outcome) ||
    !(value === null || (typeof value === "string" && UUID.test(value))) ||
    (value !== null && !["accepted", "already_decided"].includes(outcome)) ||
    !(
      problem === null ||
      (typeof problem === "string" && PROBLEM.test(problem))
    )
  ) {
    return UNREADABLE;
  }
  return Object.freeze({ kind: "answer", outcome, value });
}

// attorney_decline_request's one row, { outcome }.
export function declineAnswerOf(result: unknown): CallAnswer {
  if (ownField(result, "error") !== null) {
    return rejectedCall(result) ? REJECTED : UNREADABLE;
  }
  const row = oneRow(result, ["outcome"]);
  const outcome = row === null ? undefined : ownField(row, "outcome");
  return typeof outcome === "string" && DECLINE_OUTCOMES.includes(outcome)
    ? Object.freeze({ kind: "answer", outcome, value: null })
    : UNREADABLE;
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

const isRequestId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

export function createAttorneyRequestReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<AttorneyRequestReads | null> {
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
        queue: () =>
          observedRead("attorney_requests", deadlineMs, () =>
            client.rpc("attorney_requests"),
          ),
        request: (requestId: string) =>
          isRequestId(requestId)
            ? observedRead("attorney_request", deadlineMs, () =>
                client.rpc("attorney_request", { p_request_id: requestId }),
              )
            : Promise.resolve(UNREADABLE_ROWS),
        environmentIdentity: () =>
          observedRead("deployment_environment_identity", deadlineMs, () =>
            client.rpc("deployment_environment_identity"),
          ),
      },
      deadlineMs,
    );
  };
}

export function createAttorneyRequestWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<AttorneyRequestWrites | null> {
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
      accept: async (requestId: string) =>
        isRequestId(requestId)
          ? observedWrite(
              "attorney_accept_request",
              deadlineMs,
              () =>
                client.rpc("attorney_accept_request", {
                  p_request_id: requestId,
                }),
              acceptAnswerOf,
            )
          : REJECTED,
      decline: async (requestId: string) =>
        isRequestId(requestId)
          ? observedWrite(
              "attorney_decline_request",
              deadlineMs,
              () =>
                client.rpc("attorney_decline_request", {
                  p_request_id: requestId,
                }),
              declineAnswerOf,
            )
          : REJECTED,
    } satisfies AttorneyRequestWrites);
  };
}

// The production sources: the trusted server session, the trusted attorney
// principal source for the Security Shell, the request-scoped ports above,
// and the server-side environment setting.
export const ATTORNEY_REQUEST_SOURCES: AttorneyRequestSources = Object.freeze({
  session: SUPABASE_SERVER_SESSION_SOURCE,
  attorney: ATTORNEY_PRINCIPAL_SOURCE,
  reads: createAttorneyRequestReads(),
  writes: createAttorneyRequestWrites(),
  environment: () => readEnvironmentConfiguration(),
});
