// Server-only privacy and security actions adapter (MVP-001 S11; PS-A6
// sections 2 and 3).
//
// Builds the ports of break-glass access (request, approval, revocation, the
// lists and the audited access path) and of data requests (the client's
// submission, withdrawal and list; the staff queue, one request, assignment
// and decision) for one request. Every database call goes through the
// request-scoped, unprivileged server client (the publishable key and the
// request's own cookie session), so the database decides the actor, the aal2
// session, the Staff or Client Profile, the capability and its scope from the
// request's own authenticated session. Each function is called by its
// literal name, exactly once in this module. No privileged credential or
// client is used or seen here, and nothing reads a table directly. Every call
// is bounded in time; anything that fails, throws, or is too slow is reported
// as unreadable, a malformed argument is refused before anything is sent,
// and each command answer is read strictly against its own fixed outcomes.
// Each failure writes one log line naming the call and how it failed (the
// error code and HTTP status only), and nothing the call carried or answered
// (never a reason or a description).

import {
  APPROVE_OUTCOMES,
  GRANT_STATES,
  MAX_REASON,
  REQUEST_OUTCOMES,
  REVOKE_OUTCOMES,
  type BreakGlassReads,
  type BreakGlassSources,
  type BreakGlassWrites,
  type GrantState,
} from "../../application/break-glass.ts";
import {
  ASSIGN_OUTCOMES,
  DECIDE_OUTCOMES,
  MAX_DETAILS,
  OUTCOME_CODES,
  REQUEST_STATES,
  REQUEST_TYPES,
  SUBMIT_OUTCOMES,
  WITHDRAW_OUTCOMES,
  type ClientDataRequestSources,
  type DataRequestReads,
  type DataRequestWrites,
  type OutcomeCode,
  type RequestState,
  type RequestType,
  type StaffDataRequestSources,
} from "../../application/data-requests.ts";
import {
  rowsResultOf,
  UNREADABLE_ROWS,
  withinDeadline,
  type RowsResult,
} from "../../application/professional-identity.ts";
import type { CommandAnswer } from "../../application/workspace-support.ts";
import { CLIENT_INTAKE_SOURCES } from "../client/client-intake-adapter.ts";
import {
  rowAnswerOf,
  textAnswerOf,
} from "../consultations/completion-adapter.ts";
import { readEnvironmentConfiguration } from "../environment/environment-configuration.ts";
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
import { STAFF_CONFIGURATION_SOURCES } from "../staff/staff-configuration-adapter.ts";

const CALL_FAILED = "privacy.call_failed";
const EXPIRED = Symbol("expired");
const REJECTED = Object.freeze({ kind: "rejected" } as const);
const UNREADABLE = Object.freeze({ kind: "unreadable" } as const);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The staff list offsets the database pages by (25 rows a page).
const MAX_OFFSET = 100000;
// PS-A6 section 2 rule 3: 1 second to 24 hours.
const MAX_DURATION_SECONDS = 86400;

function ownField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
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
  read: (result: unknown) => CommandAnswer,
): Promise<CommandAnswer> {
  return observed<CommandAnswer>(
    operation,
    deadlineMs,
    UNREADABLE,
    async () => {
      const result = await call();
      const answer = read(result);
      return {
        answer,
        failure:
          answer.kind === "answer"
            ? null
            : { outcome: answer.kind, ...failureOf(result) },
      };
    },
  );
}

const isId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
const isOffset = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= MAX_OFFSET &&
  (value as number) % 25 === 0;
const isListed = <T extends string>(
  list: readonly T[],
  value: unknown,
): value is T => list.some((entry) => entry === value);
const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= max;

const refusedRead = () => Promise.resolve(UNREADABLE_ROWS);
const refusedWrite = () => Promise.resolve<CommandAnswer>(REJECTED);

// The request's one row: requested with the new grant's identifier, or
// existing with the identifier of the caller's open grant; every other
// outcome without one.
export const requestAnswerOf = (result: unknown): CommandAnswer => {
  const answer = rowAnswerOf(
    result,
    ["break_glass_grant_id"],
    REQUEST_OUTCOMES.filter((outcome) => outcome !== "existing"),
    "requested",
    "break_glass_grant_id",
  );
  if (answer.kind === "answer") {
    return answer;
  }
  const existing = rowAnswerOf(
    result,
    ["break_glass_grant_id"],
    ["existing"],
    "existing",
    "break_glass_grant_id",
  );
  return existing.kind === "answer" ? existing : answer;
};
export const submitAnswerOf = (result: unknown): CommandAnswer =>
  rowAnswerOf(
    result,
    ["data_request_id"],
    SUBMIT_OUTCOMES,
    "submitted",
    "data_request_id",
  );

// Every call of this module, bound to one request client. Each database
// function is named exactly once, here.
function callsOf(client: RequestClient, deadlineMs: number) {
  return Object.freeze({
    environmentIdentity: () =>
      observedRead("deployment_environment_identity", deadlineMs, () =>
        client.rpc("deployment_environment_identity"),
      ),
    // Break-glass access (PS-A6 section 2).
    grantsMine: () =>
      observedRead("staff_break_glass_grants_mine", deadlineMs, () =>
        client.rpc("staff_break_glass_grants_mine"),
      ),
    grantQueue: (state: GrantState, offset: number) =>
      isListed(GRANT_STATES, state) && isOffset(offset)
        ? observedRead("staff_break_glass_queue", deadlineMs, () =>
            client.rpc("staff_break_glass_queue", {
              p_state: state,
              p_offset: offset,
            }),
          )
        : refusedRead(),
    access: (grantId: string) =>
      isId(grantId)
        ? observedRead("staff_break_glass_consultation", deadlineMs, () =>
            client.rpc("staff_break_glass_consultation", {
              p_break_glass_id: grantId,
            }),
          )
        : refusedRead(),
    request: (consultationId: string, reason: string) =>
      isId(consultationId) && isText(reason, MAX_REASON)
        ? observedWrite(
            "staff_request_break_glass",
            deadlineMs,
            () =>
              client.rpc("staff_request_break_glass", {
                p_consultation_id: consultationId,
                p_reason: reason,
              }),
            requestAnswerOf,
          )
        : refusedWrite(),
    approve: (grantId: string, durationSeconds: number) =>
      isId(grantId) &&
      Number.isSafeInteger(durationSeconds) &&
      durationSeconds >= 1 &&
      durationSeconds <= MAX_DURATION_SECONDS
        ? observedWrite(
            "staff_approve_break_glass",
            deadlineMs,
            () =>
              client.rpc("staff_approve_break_glass", {
                p_break_glass_id: grantId,
                p_duration_seconds: durationSeconds,
              }),
            (result) => textAnswerOf(result, APPROVE_OUTCOMES),
          )
        : refusedWrite(),
    revoke: (grantId: string) =>
      isId(grantId)
        ? observedWrite(
            "staff_revoke_break_glass",
            deadlineMs,
            () =>
              client.rpc("staff_revoke_break_glass", {
                p_break_glass_id: grantId,
              }),
            (result) => textAnswerOf(result, REVOKE_OUTCOMES),
          )
        : refusedWrite(),
    // Data requests (PS-A6 section 3).
    requestsMine: () =>
      observedRead("client_data_requests", deadlineMs, () =>
        client.rpc("client_data_requests"),
      ),
    requestQueue: (state: RequestState, offset: number) =>
      isListed(REQUEST_STATES, state) && isOffset(offset)
        ? observedRead("staff_data_request_queue", deadlineMs, () =>
            client.rpc("staff_data_request_queue", {
              p_state: state,
              p_offset: offset,
            }),
          )
        : refusedRead(),
    dataRequest: (requestId: string) =>
      isId(requestId)
        ? observedRead("staff_data_request", deadlineMs, () =>
            client.rpc("staff_data_request", {
              p_data_request_id: requestId,
            }),
          )
        : refusedRead(),
    submit: (type: RequestType, details: string | null) =>
      isListed(REQUEST_TYPES, type) &&
      (details === null || isText(details, MAX_DETAILS))
        ? observedWrite(
            "client_submit_data_request",
            deadlineMs,
            () =>
              client.rpc("client_submit_data_request", {
                p_request_type: type,
                p_details: details,
              }),
            submitAnswerOf,
          )
        : refusedWrite(),
    withdraw: (requestId: string) =>
      isId(requestId)
        ? observedWrite(
            "client_withdraw_data_request",
            deadlineMs,
            () =>
              client.rpc("client_withdraw_data_request", {
                p_data_request_id: requestId,
              }),
            (result) => textAnswerOf(result, WITHDRAW_OUTCOMES),
          )
        : refusedWrite(),
    assign: (requestId: string) =>
      isId(requestId)
        ? observedWrite(
            "staff_assign_data_request",
            deadlineMs,
            () =>
              client.rpc("staff_assign_data_request", {
                p_data_request_id: requestId,
              }),
            (result) => textAnswerOf(result, ASSIGN_OUTCOMES),
          )
        : refusedWrite(),
    decide: (requestId: string, outcome: OutcomeCode) =>
      isId(requestId) && isListed(OUTCOME_CODES, outcome)
        ? observedWrite(
            "staff_decide_data_request",
            deadlineMs,
            () =>
              client.rpc("staff_decide_data_request", {
                p_data_request_id: requestId,
                p_outcome_code: outcome,
              }),
            (result) => textAnswerOf(result, DECIDE_OUTCOMES),
          )
        : refusedWrite(),
  });
}

type Calls = ReturnType<typeof callsOf>;

// One port source: a fresh request client per port, every call bounded.
function portSource<Port extends object>(
  pick: (calls: Calls) => Port,
  clientSource: RequestClientSource,
  deadlineMs: number,
): () => Promise<Port | null> {
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
      pick(callsOf(client, deadlineMs)) as never,
      deadlineMs,
    ) as Port;
  };
}

export function createBreakGlassReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<BreakGlassReads | null> {
  return portSource(
    (calls): BreakGlassReads => ({
      mine: calls.grantsMine,
      queue: calls.grantQueue,
      access: calls.access,
      environmentIdentity: calls.environmentIdentity,
    }),
    clientSource,
    deadlineMs,
  );
}

export function createBreakGlassWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<BreakGlassWrites | null> {
  return portSource(
    (calls): BreakGlassWrites => ({
      request: calls.request,
      approve: calls.approve,
      revoke: calls.revoke,
    }),
    clientSource,
    deadlineMs,
  );
}

export function createDataRequestReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<DataRequestReads | null> {
  return portSource(
    (calls): DataRequestReads => ({
      mine: calls.requestsMine,
      queue: calls.requestQueue,
      request: calls.dataRequest,
      environmentIdentity: calls.environmentIdentity,
    }),
    clientSource,
    deadlineMs,
  );
}

export function createDataRequestWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<DataRequestWrites | null> {
  return portSource(
    (calls): DataRequestWrites => ({
      submit: calls.submit,
      withdraw: calls.withdraw,
      assign: calls.assign,
      decide: calls.decide,
    }),
    clientSource,
    deadlineMs,
  );
}

const environment = () => readEnvironmentConfiguration();

export const BREAK_GLASS_SOURCES: BreakGlassSources = Object.freeze({
  staff: STAFF_CONFIGURATION_SOURCES,
  reads: createBreakGlassReads(),
  writes: createBreakGlassWrites(),
  environment,
});

const DATA_REQUESTS = Object.freeze({
  reads: createDataRequestReads(),
  writes: createDataRequestWrites(),
  environment,
});

export const CLIENT_DATA_REQUEST_SOURCES: ClientDataRequestSources =
  Object.freeze({
    ...DATA_REQUESTS,
    clientIntake: CLIENT_INTAKE_SOURCES,
  });

export const STAFF_DATA_REQUEST_SOURCES: StaffDataRequestSources =
  Object.freeze({
    ...DATA_REQUESTS,
    staff: STAFF_CONFIGURATION_SOURCES,
  });
