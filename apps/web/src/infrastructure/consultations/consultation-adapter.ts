// Server-only Consultation adapter (MVP-001 S9).
//
// Builds the Consultation ports for one request. Every database call goes
// through the request-scoped, unprivileged server client (the publishable key
// and the request's own cookie session): the client's and the attorney's
// Consultation reads, the PS-A2 environment accessor, media access and the
// attorney's start and end, so the database decides the actor, the aal2
// session and the Consultation's own participant from the request's own
// authenticated session. Each function is called by its literal name, exactly
// once in this module. No privileged credential or client is used or seen
// here, and nothing reads a table directly. Every call is bounded in time;
// anything that fails, throws, or is too slow is reported as unreadable, a
// malformed identifier is refused before anything is sent, and each answer is
// read strictly against its own fixed outcomes. Each such failure writes one
// log line naming the call and how it failed (the error code and HTTP status
// only, MVP-001 D-8), and nothing the call carried or answered.
//
// The production sources join these ports to the trusted server session, the
// client intake sources (the verified client), the attorney principal source,
// the server-side environment setting, the media side of joining (the
// server-only Daily adapter's meeting tokens and the prebuilt room's address
// on the configured domain; null when media is not configured), one bounded
// worker run and the server clock.

import {
  ACCESS_OUTCOMES,
  END_OUTCOMES,
  START_OUTCOMES,
  type AccessAnswer,
  type AttorneyConsultationSources,
  type ClientConsultationSources,
  type CommandAnswer,
  type ConsultationReads,
  type ConsultationWrites,
  type MediaJoin,
} from "../../application/consultations.ts";
import {
  isRosunoRoomName,
  PARTICIPANT_ROLES,
} from "../../application/media-provider.ts";
import {
  rowsResultOf,
  UNREADABLE_ROWS,
  withinDeadline,
  type RowsResult,
} from "../../application/professional-identity.ts";
import { isTimestamp } from "../../application/professional-records.ts";
import { CLIENT_INTAKE_SOURCES } from "../client/client-intake-adapter.ts";
import { readEnvironmentConfiguration } from "../environment/environment-configuration.ts";
import { ATTORNEY_PRINCIPAL_SOURCE } from "../identity/attorney-principal-source.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../identity/server-session-source.ts";
import {
  AFTER_COMMIT_BOUNDS,
  drainOperationalJobs,
} from "../jobs/job-worker-adapter.ts";
import {
  createDailyProvider,
  frameUrlOf,
  readDailyDomain,
} from "../media/daily-provider.ts";
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

const CALL_FAILED = "consultation.call_failed";
const EXPIRED = Symbol("expired");

const REJECTED = Object.freeze({ kind: "rejected" } as const);
const UNREADABLE = Object.freeze({ kind: "unreadable" } as const);

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

const ACCESS_KEYS = Object.freeze([
  "outcome",
  "room_name",
  "participant_role",
  "participant_user_id",
  "not_before",
  "expires_at",
  "opens_at",
]);

const nullableTime = (value: unknown) => value === null || isTimestamp(value);

// consultation_media_access's one row. granted carries exactly the room
// name, the role, the User id and both times; every other outcome none of
// them (a role and opens_at may accompany a participant's refusal).
export function accessAnswerOf(result: unknown): AccessAnswer {
  if (ownField(result, "error") !== null) {
    return rejectedCall(result) ? REJECTED : UNREADABLE;
  }
  const row = oneRow(result, ACCESS_KEYS);
  if (row === null) {
    return UNREADABLE;
  }
  const outcome = ownField(row, "outcome");
  const roomName = ownField(row, "room_name");
  const role = ownField(row, "participant_role");
  const userId = ownField(row, "participant_user_id");
  const notBefore = ownField(row, "not_before");
  const expiresAt = ownField(row, "expires_at");
  const opensAt = ownField(row, "opens_at");
  if (
    typeof outcome !== "string" ||
    !ACCESS_OUTCOMES.includes(outcome) ||
    !(
      role === null || (PARTICIPANT_ROLES as readonly unknown[]).includes(role)
    ) ||
    !nullableTime(opensAt)
  ) {
    return UNREADABLE;
  }
  if (outcome === "granted") {
    if (
      !isRosunoRoomName(roomName) ||
      role === null ||
      typeof userId !== "string" ||
      !UUID.test(userId) ||
      !isTimestamp(notBefore) ||
      !isTimestamp(expiresAt) ||
      Date.parse(expiresAt) <= Date.parse(notBefore)
    ) {
      return UNREADABLE;
    }
    return Object.freeze({
      kind: "answer",
      outcome,
      grant: Object.freeze({
        roomName,
        role: role as "client" | "attorney",
        userId,
        notBefore,
        expiresAt,
      }),
      opensAt: opensAt as string | null,
    });
  }
  if (
    roomName !== null ||
    userId !== null ||
    notBefore !== null ||
    expiresAt !== null
  ) {
    return UNREADABLE;
  }
  return Object.freeze({
    kind: "answer",
    outcome,
    grant: null,
    opensAt: opensAt as string | null,
  });
}

// consultation_start's and consultation_end's one row,
// { outcome, problem, started_at | ended_at }.
function commandAnswerOf(
  result: unknown,
  outcomes: readonly string[],
  timeKey: "started_at" | "ended_at",
  successOutcome: string,
): CommandAnswer {
  if (ownField(result, "error") !== null) {
    return rejectedCall(result) ? REJECTED : UNREADABLE;
  }
  const row = oneRow(result, ["outcome", "problem", timeKey]);
  if (row === null) {
    return UNREADABLE;
  }
  const outcome = ownField(row, "outcome");
  const problem = ownField(row, "problem");
  const time = ownField(row, timeKey);
  // The time accompanies the success (and, for a start, already_started).
  const timed =
    outcome === successOutcome ||
    (timeKey === "started_at" && outcome === "already_started");
  if (
    typeof outcome !== "string" ||
    !outcomes.includes(outcome) ||
    !(
      problem === null ||
      (typeof problem === "string" && PROBLEM.test(problem))
    ) ||
    !nullableTime(time) ||
    (outcome === successOutcome && time === null) ||
    (!timed && time !== null)
  ) {
    return UNREADABLE;
  }
  return Object.freeze({ kind: "answer", outcome });
}

export const startAnswerOf = (result: unknown): CommandAnswer =>
  commandAnswerOf(result, START_OUTCOMES, "started_at", "started");
export const endAnswerOf = (result: unknown): CommandAnswer =>
  commandAnswerOf(result, END_OUTCOMES, "ended_at", "completed");

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
  call: () => PromiseLike<unknown>,
  read: (result: unknown) => T,
  fallback: T,
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

const isConsultationId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

export function createConsultationReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<ConsultationReads | null> {
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
        client: (consultationId: string) =>
          isConsultationId(consultationId)
            ? observedRead("client_consultation", deadlineMs, () =>
                client.rpc("client_consultation", {
                  p_consultation_id: consultationId,
                }),
              )
            : Promise.resolve(UNREADABLE_ROWS),
        attorney: (consultationId: string) =>
          isConsultationId(consultationId)
            ? observedRead("attorney_consultation", deadlineMs, () =>
                client.rpc("attorney_consultation", {
                  p_consultation_id: consultationId,
                }),
              )
            : Promise.resolve(UNREADABLE_ROWS),
        attorneyList: () =>
          observedRead("attorney_consultations", deadlineMs, () =>
            client.rpc("attorney_consultations"),
          ),
        environmentIdentity: () =>
          observedRead("deployment_environment_identity", deadlineMs, () =>
            client.rpc("deployment_environment_identity"),
          ),
      },
      deadlineMs,
    );
  };
}

export function createConsultationWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<ConsultationWrites | null> {
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
      access: async (consultationId: string): Promise<AccessAnswer> =>
        isConsultationId(consultationId)
          ? observedWrite<AccessAnswer>(
              "consultation_media_access",
              deadlineMs,
              () =>
                client.rpc("consultation_media_access", {
                  p_consultation_id: consultationId,
                }),
              accessAnswerOf,
              UNREADABLE,
            )
          : REJECTED,
      start: async (consultationId: string): Promise<CommandAnswer> =>
        isConsultationId(consultationId)
          ? observedWrite<CommandAnswer>(
              "consultation_start",
              deadlineMs,
              () =>
                client.rpc("consultation_start", {
                  p_consultation_id: consultationId,
                }),
              startAnswerOf,
              UNREADABLE,
            )
          : REJECTED,
      end: async (consultationId: string): Promise<CommandAnswer> =>
        isConsultationId(consultationId)
          ? observedWrite<CommandAnswer>(
              "consultation_end",
              deadlineMs,
              () =>
                client.rpc("consultation_end", {
                  p_consultation_id: consultationId,
                }),
              endAnswerOf,
              UNREADABLE,
            )
          : REJECTED,
    } satisfies ConsultationWrites);
  };
}

// The media side of joining: the Daily adapter's meeting tokens and the
// prebuilt room's address on the configured domain, or null when either the
// API key or the domain is not configured.
export async function mediaJoinFromServer(): Promise<MediaJoin | null> {
  const provider = createDailyProvider();
  const domain = readDailyDomain();
  if (provider === null || domain === null) {
    return null;
  }
  return Object.freeze({
    provider,
    frameUrl: (roomName: string, token: string) =>
      frameUrlOf(domain, roomName, token),
  });
}

const SHARED = Object.freeze({
  reads: createConsultationReads(),
  writes: createConsultationWrites(),
  environment: () => readEnvironmentConfiguration(),
  media: () => mediaJoinFromServer(),
  drain: async () => {
    await drainOperationalJobs(AFTER_COMMIT_BOUNDS);
  },
  clock: () => Date.now(),
});

export const CLIENT_CONSULTATION_SOURCES: ClientConsultationSources =
  Object.freeze({
    ...SHARED,
    clientIntake: CLIENT_INTAKE_SOURCES,
  });

export const ATTORNEY_CONSULTATION_SOURCES: AttorneyConsultationSources =
  Object.freeze({
    ...SHARED,
    session: SUPABASE_SERVER_SESSION_SOURCE,
    attorney: ATTORNEY_PRINCIPAL_SOURCE,
  });
