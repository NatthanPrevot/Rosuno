// Server-only discovery and referral adapter (MVP-001 S5).
//
// Builds the discovery ports for one request. Every call goes through the
// request-scoped, unprivileged server client (the publishable key and the
// request's own cookie session, so an anonymous visitor calls as anon and a
// signed-in one as themselves): the three public discovery reads, the
// client's own attempt list, the PS-A2 environment accessor, and the one
// referral function. Each function is called by its literal name, exactly
// once in this module. No privileged credential or client is used or seen
// here, and nothing reads a table directly. Every call is bounded in time;
// anything that fails, throws, or is too slow is reported as unreadable, and
// the referral function's answer is read strictly against its own fixed
// outcomes; a malformed referral input is refused before anything is sent. Each such failure writes one log line naming the call and how it
// failed (the error code and HTTP status only, MVP-001 D-8), and nothing the
// call carried or answered.

import {
  REFERRAL_OUTCOMES,
  type CallAnswer,
  type DirectoryQueryInput,
  type DiscoveryReads,
  type DiscoverySources,
  type DiscoveryWrites,
  type ReferralInput,
} from "../../application/discovery.ts";
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

const CALL_FAILED = "discovery.call_failed";
const EXPIRED = Symbol("expired");

const REJECTED: CallAnswer = Object.freeze({ kind: "rejected" });
const UNREADABLE: CallAnswer = Object.freeze({ kind: "unreadable" });

// A PostgreSQL error code (SQLSTATE): five digits or capital letters.
const SQLSTATE = /^[0-9A-Z]{5}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

// referral_create's one row, { outcome, referral_id }.
export function referralAnswerOf(result: unknown): CallAnswer {
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
  const value = ownField(row, "referral_id");
  if (
    typeof outcome !== "string" ||
    !REFERRAL_OUTCOMES.some((entry) => entry === outcome) ||
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
): Promise<CallAnswer> {
  return observed(operation, deadlineMs, UNREADABLE, async () => {
    const result = await call();
    const answer = referralAnswerOf(result);
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
const isOptionalId = (value: unknown): value is string | null =>
  value === null || isId(value);
const isPage = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 1 &&
  (value as number) <= 25;
const AVAILABILITY = Object.freeze(["any", "instant", "scheduled"]);
const PATHS = Object.freeze(["instant", "scheduled"]);

export function createDiscoveryReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<DiscoveryReads | null> {
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
        filters: () =>
          observedRead("public_discovery_filters", deadlineMs, () =>
            client.rpc("public_discovery_filters"),
          ),
        directory: async (query: DirectoryQueryInput) =>
          isId(query.jurisdictionId) &&
          isOptionalId(query.practiceAreaId) &&
          AVAILABILITY.includes(query.availability) &&
          isPage(query.page)
            ? observedRead("public_attorney_directory", deadlineMs, () =>
                client.rpc("public_attorney_directory", {
                  p_jurisdiction_id: query.jurisdictionId,
                  p_practice_area_id: query.practiceAreaId,
                  p_availability: query.availability,
                  p_page: query.page,
                }),
              )
            : UNREADABLE_ROWS,
        profile: async (attorneyId: string, jurisdictionId: string | null) =>
          isId(attorneyId) && isOptionalId(jurisdictionId)
            ? observedRead("public_attorney_profile", deadlineMs, () =>
                client.rpc("public_attorney_profile", {
                  p_attorney_id: attorneyId,
                  p_jurisdiction_id: jurisdictionId,
                }),
              )
            : UNREADABLE_ROWS,
        clientReferrals: async (intakeId: string) =>
          isId(intakeId)
            ? observedRead("client_referrals", deadlineMs, () =>
                client.rpc("client_referrals", {
                  p_intake_id: intakeId,
                }),
              )
            : UNREADABLE_ROWS,
        environmentIdentity: () =>
          observedRead("deployment_environment_identity", deadlineMs, () =>
            client.rpc("deployment_environment_identity"),
          ),
      },
      deadlineMs,
    );
  };
}

export function createDiscoveryWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<DiscoveryWrites | null> {
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
      createReferral: async (input: ReferralInput) =>
        isId(input.intakeId) &&
        isId(input.attorneyId) &&
        isId(input.jurisdictionId) &&
        isOptionalId(input.practiceAreaId) &&
        PATHS.includes(input.path) &&
        AVAILABILITY.includes(input.availability) &&
        isPage(input.page)
          ? observedWrite("referral_create", deadlineMs, () =>
              client.rpc("referral_create", {
                p_intake_id: input.intakeId,
                p_attorney_id: input.attorneyId,
                p_jurisdiction_id: input.jurisdictionId,
                p_practice_area_id: input.practiceAreaId,
                p_path: input.path,
                p_availability_filter: input.availability,
                p_page: input.page,
              }),
            )
          : REJECTED,
    } satisfies DiscoveryWrites);
  };
}

// The production sources: the trusted server session, the client intake
// sources (which decide the verified client and its Intakes), the
// request-scoped ports above, and the server-side environment setting.
export const DISCOVERY_SOURCES: DiscoverySources = Object.freeze({
  session: SUPABASE_SERVER_SESSION_SOURCE,
  clientIntake: CLIENT_INTAKE_SOURCES,
  reads: createDiscoveryReads(),
  writes: createDiscoveryWrites(),
  environment: () => readEnvironmentConfiguration(),
});
