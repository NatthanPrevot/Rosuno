// Server-only Consultation Request adapter (MVP-001 S6).
//
// Builds the request ports for one request. Every call goes through the
// request-scoped, unprivileged server client (the publishable key and the
// request's own cookie session): the client's request review, options, slot
// starts and quote preview reads, the client's own Request and Intake
// requests reads, the PS-A2 environment accessor, and the two request
// functions (creation and withdrawal); MVP-001 S8: also the client's own
// decision read (the attorney's outcome, the Consultation's state and the
// Booking's times). Each function is called by its literal
// name, exactly once in this module. No privileged credential or client is
// used or seen here, and nothing reads a table directly. Every call is
// bounded in time; anything that fails, throws, or is too slow is reported as
// unreadable, and each write function's answer is read strictly against its
// own fixed outcomes; a malformed input is refused before anything is sent.
// Each such failure writes one log line naming the call and how it failed
// (the error code and HTTP status only, MVP-001 D-8), and nothing the call
// carried or answered.
//
// MVP-001 S6 PS-A3: request_create also receives the client's optional
// message (null for none), checked here only for its form (plain text, not
// blank, at most the 20,000-character ceiling); the maximum is the database's
// to decide.

import {
  CREATE_OUTCOMES,
  MESSAGE_CEILING,
  messageLength,
  REQUEST_PATHS,
  WITHDRAW_OUTCOMES,
  type CreateAnswer,
  type QuoteInput,
  type RequestInput,
  type RequestReads,
  type RequestSources,
  type RequestWrites,
  type WithdrawAnswer,
} from "../../application/consultation-request.ts";
import {
  rowsResultOf,
  UNREADABLE_ROWS,
  withinDeadline,
  type RowsResult,
} from "../../application/professional-identity.ts";
import { CLIENT_INTAKE_SOURCES } from "../client/client-intake-adapter.ts";
import { readEnvironmentConfiguration } from "../environment/environment-configuration.ts";
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

const CALL_FAILED = "consultation_request.call_failed";
const EXPIRED = Symbol("expired");

// A PostgreSQL error code (SQLSTATE): five digits or capital letters.
const SQLSTATE = /^[0-9A-Z]{5}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODALITY = /^[a-z][a-z0-9_]{1,31}$/;
const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

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

// The one row of a write function with exactly these columns, or null.
function singleRow(result: unknown, columns: readonly string[]): unknown {
  const data = ownField(result, "data");
  if (!Array.isArray(data) || data.length !== 1) {
    return null;
  }
  const row = data[0];
  if (
    row === null ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).length !== columns.length ||
    columns.some((column) => !Object.hasOwn(row, column))
  ) {
    return null;
  }
  return row;
}

const REJECTED_CREATE: CreateAnswer = Object.freeze({ kind: "rejected" });
const UNREADABLE_CREATE: CreateAnswer = Object.freeze({ kind: "unreadable" });
const REJECTED_WITHDRAW: WithdrawAnswer = Object.freeze({ kind: "rejected" });
const UNREADABLE_WITHDRAW: WithdrawAnswer = Object.freeze({
  kind: "unreadable",
});

// request_create's one row, { outcome, request_id, problem }.
export function createAnswerOf(result: unknown): CreateAnswer {
  if (ownField(result, "error") !== null) {
    return rejectedCall(result) ? REJECTED_CREATE : UNREADABLE_CREATE;
  }
  const row = singleRow(result, ["outcome", "request_id", "problem"]);
  const outcome = ownField(row, "outcome");
  const requestId = ownField(row, "request_id");
  const problem = ownField(row, "problem");
  if (
    row === null ||
    typeof outcome !== "string" ||
    !CREATE_OUTCOMES.some((entry) => entry === outcome) ||
    !(requestId === null || typeof requestId === "string") ||
    !(problem === null || typeof problem === "string")
  ) {
    return UNREADABLE_CREATE;
  }
  return Object.freeze({ kind: "answer", outcome, requestId, problem });
}

// request_withdraw's one row, { outcome }.
export function withdrawAnswerOf(result: unknown): WithdrawAnswer {
  if (ownField(result, "error") !== null) {
    return rejectedCall(result) ? REJECTED_WITHDRAW : UNREADABLE_WITHDRAW;
  }
  const row = singleRow(result, ["outcome"]);
  const outcome = ownField(row, "outcome");
  if (
    row === null ||
    typeof outcome !== "string" ||
    !WITHDRAW_OUTCOMES.some((entry) => entry === outcome)
  ) {
    return UNREADABLE_WITHDRAW;
  }
  return Object.freeze({ kind: "answer", outcome });
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

function observedWrite<T extends { readonly kind: string }>(
  operation: string,
  deadlineMs: number,
  fallback: T,
  read: (result: unknown) => T,
  call: () => PromiseLike<unknown>,
): Promise<T> {
  return observed(operation, deadlineMs, fallback, async () => {
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

const isId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
const isModality = (value: unknown): value is string =>
  typeof value === "string" && MODALITY.test(value);
const isDuration = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 1 &&
  (value as number) <= 1440;
const isQuoteInput = (input: QuoteInput): boolean =>
  isId(input.referralId) &&
  REQUEST_PATHS.includes(input.path) &&
  isModality(input.modality) &&
  isDuration(input.durationMinutes) &&
  (input.path === "scheduled"
    ? typeof input.slotStart === "string" && TIMESTAMP.test(input.slotStart)
    : input.slotStart === null);
const isRequestInput = (input: RequestInput): boolean =>
  isQuoteInput(input) &&
  (input.message === null ||
    (typeof input.message === "string" &&
      input.message.trim() !== "" &&
      messageLength(input.message) <= MESSAGE_CEILING));

export function createRequestReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<RequestReads | null> {
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
        review: async (referralId: string) =>
          isId(referralId)
            ? observedRead("client_request_review", deadlineMs, () =>
                client.rpc("client_request_review", {
                  p_referral_id: referralId,
                }),
              )
            : UNREADABLE_ROWS,
        options: async (referralId: string) =>
          isId(referralId)
            ? observedRead("request_options", deadlineMs, () =>
                client.rpc("request_options", { p_referral_id: referralId }),
              )
            : UNREADABLE_ROWS,
        slotStarts: async (
          referralId: string,
          modality: string,
          durationMinutes: number,
        ) =>
          isId(referralId) &&
          isModality(modality) &&
          isDuration(durationMinutes)
            ? observedRead("request_slot_starts", deadlineMs, () =>
                client.rpc("request_slot_starts", {
                  p_referral_id: referralId,
                  p_modality: modality,
                  p_duration_minutes: durationMinutes,
                }),
              )
            : UNREADABLE_ROWS,
        preview: async (input: QuoteInput) =>
          isQuoteInput(input)
            ? observedRead("request_quote_preview", deadlineMs, () =>
                client.rpc("request_quote_preview", {
                  p_referral_id: input.referralId,
                  p_path: input.path,
                  p_modality: input.modality,
                  p_duration_minutes: input.durationMinutes,
                  p_slot_start: input.slotStart,
                }),
              )
            : UNREADABLE_ROWS,
        request: async (requestId: string) =>
          isId(requestId)
            ? observedRead("client_request", deadlineMs, () =>
                client.rpc("client_request", { p_request_id: requestId }),
              )
            : UNREADABLE_ROWS,
        intakeRequests: async (intakeId: string) =>
          isId(intakeId)
            ? observedRead("client_intake_requests", deadlineMs, () =>
                client.rpc("client_intake_requests", { p_intake_id: intakeId }),
              )
            : UNREADABLE_ROWS,
        environmentIdentity: () =>
          observedRead("deployment_environment_identity", deadlineMs, () =>
            client.rpc("deployment_environment_identity"),
          ),
        decision: async (requestId: string) =>
          isId(requestId)
            ? observedRead("client_request_decision", deadlineMs, () =>
                client.rpc("client_request_decision", {
                  p_request_id: requestId,
                }),
              )
            : UNREADABLE_ROWS,
      },
      deadlineMs,
    );
  };
}

export function createRequestWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<RequestWrites | null> {
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
      createRequest: async (input: RequestInput) =>
        isRequestInput(input)
          ? observedWrite(
              "request_create",
              deadlineMs,
              UNREADABLE_CREATE,
              createAnswerOf,
              () =>
                client.rpc("request_create", {
                  p_referral_id: input.referralId,
                  p_path: input.path,
                  p_modality: input.modality,
                  p_duration_minutes: input.durationMinutes,
                  p_slot_start: input.slotStart,
                  p_client_message: input.message,
                }),
            )
          : REJECTED_CREATE,
      withdrawRequest: async (requestId: string) =>
        isId(requestId)
          ? observedWrite(
              "request_withdraw",
              deadlineMs,
              UNREADABLE_WITHDRAW,
              withdrawAnswerOf,
              () => client.rpc("request_withdraw", { p_request_id: requestId }),
            )
          : REJECTED_WITHDRAW,
    } satisfies RequestWrites);
  };
}

// The production sources: the trusted server session, the client intake
// sources (which decide the verified client and its Intakes), the
// request-scoped ports above, and the server-side environment setting.
export const REQUEST_SOURCES: RequestSources = Object.freeze({
  session: SUPABASE_SERVER_SESSION_SOURCE,
  clientIntake: CLIENT_INTAKE_SOURCES,
  reads: createRequestReads(),
  writes: createRequestWrites(),
  environment: () => readEnvironmentConfiguration(),
});
