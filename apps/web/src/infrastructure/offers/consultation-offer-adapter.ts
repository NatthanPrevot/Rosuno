// Server-only consultation offer adapter (MVP-001 S6; PS-A3 section 4).
//
// Builds the offer ports for one request. Every call goes through the
// request-scoped, unprivileged server client (the publishable key and the
// request's own cookie session): the attorney's own offer options and offer
// list, the PS-A2 environment accessor, and the two offer functions (setting
// a price and withdrawing an offer), so the database decides the actor, the
// aal2 session and the attorney's own approved profile from the request's own
// authenticated session. Each function is called by its literal name,
// exactly once in this module. No privileged credential or client is used or
// seen here, and nothing reads a table directly. Every call is bounded in
// time; anything that fails, throws, or is too slow is reported as
// unreadable, a malformed input is refused before anything is sent, and each
// write function's answer is read strictly against its own fixed outcomes.
// Each such failure writes one log line naming the call and how it failed
// (the error code and HTTP status only, MVP-001 D-8), and nothing the call
// carried or answered.

import {
  MAX_PRICE_MINOR,
  SET_OFFER_OUTCOMES,
  WITHDRAW_OFFER_OUTCOMES,
  type CallAnswer,
  type OfferInput,
  type OfferReads,
  type OfferSources,
  type OfferWrites,
} from "../../application/consultation-offers.ts";
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

const CALL_FAILED = "consultation_offer.call_failed";
const EXPIRED = Symbol("expired");

const REJECTED: CallAnswer = Object.freeze({ kind: "rejected" });
const UNREADABLE: CallAnswer = Object.freeze({ kind: "unreadable" });

// A PostgreSQL error code (SQLSTATE): five digits or capital letters.
const SQLSTATE = /^[0-9A-Z]{5}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODALITY = /^[a-z][a-z0-9_]{1,31}$/;
const CURRENCY = /^[A-Z]{3}$/;

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

// attorney_withdraw_consultation_offer's scalar text answer.
export function withdrawOfferAnswerOf(result: unknown): CallAnswer {
  if (ownField(result, "error") !== null) {
    return rejectedCall(result) ? REJECTED : UNREADABLE;
  }
  const data = ownField(result, "data");
  return typeof data === "string" && WITHDRAW_OFFER_OUTCOMES.includes(data)
    ? Object.freeze({ kind: "answer", outcome: data, value: null })
    : UNREADABLE;
}

// attorney_set_consultation_offer's one row, { outcome, offer_id }.
export function setOfferAnswerOf(result: unknown): CallAnswer {
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
  const value = ownField(row, "offer_id");
  if (
    typeof outcome !== "string" ||
    !SET_OFFER_OUTCOMES.includes(outcome) ||
    !(value === null || (typeof value === "string" && UUID.test(value))) ||
    (["created", "replaced", "unchanged"].includes(outcome) && value === null)
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

const isOfferInput = (input: OfferInput): boolean =>
  typeof input.modality === "string" &&
  MODALITY.test(input.modality) &&
  Number.isSafeInteger(input.durationMinutes) &&
  input.durationMinutes >= 1 &&
  input.durationMinutes <= 1440 &&
  Number.isSafeInteger(input.listedPriceMinor) &&
  input.listedPriceMinor >= 1 &&
  input.listedPriceMinor <= MAX_PRICE_MINOR &&
  typeof input.currency === "string" &&
  CURRENCY.test(input.currency);

export function createOfferReads(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<OfferReads | null> {
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
        options: () =>
          observedRead("attorney_consultation_offer_options", deadlineMs, () =>
            client.rpc("attorney_consultation_offer_options"),
          ),
        offers: () =>
          observedRead("attorney_consultation_offers", deadlineMs, () =>
            client.rpc("attorney_consultation_offers"),
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

export function createOfferWrites(
  clientSource: RequestClientSource = createDefaultRequestClient,
  deadlineMs: number = CALL_DEADLINE_MS,
): () => Promise<OfferWrites | null> {
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
      setOffer: async (input: OfferInput) =>
        isOfferInput(input)
          ? observedWrite(
              "attorney_set_consultation_offer",
              deadlineMs,
              () =>
                client.rpc("attorney_set_consultation_offer", {
                  p_modality: input.modality,
                  p_duration_minutes: input.durationMinutes,
                  p_listed_price_minor: input.listedPriceMinor,
                  p_currency_code: input.currency,
                }),
              setOfferAnswerOf,
            )
          : REJECTED,
      withdrawOffer: async (offerId: string) =>
        typeof offerId === "string" && UUID.test(offerId)
          ? observedWrite(
              "attorney_withdraw_consultation_offer",
              deadlineMs,
              () =>
                client.rpc("attorney_withdraw_consultation_offer", {
                  p_offer_id: offerId,
                }),
              withdrawOfferAnswerOf,
            )
          : REJECTED,
    } satisfies OfferWrites);
  };
}

// The production sources: the trusted server session, the trusted attorney
// principal source for the Security Shell, the request-scoped ports above,
// and the server-side environment setting.
export const OFFER_SOURCES: OfferSources = Object.freeze({
  session: SUPABASE_SERVER_SESSION_SOURCE,
  attorney: ATTORNEY_PRINCIPAL_SOURCE,
  reads: createOfferReads(),
  writes: createOfferWrites(),
  environment: () => readEnvironmentConfiguration(),
});
