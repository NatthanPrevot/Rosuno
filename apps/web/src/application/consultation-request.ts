// Consultation Request review, creation, withdrawal and the client's request
// reads (MVP-001 S6; MBS section 11; DM sections 2.5, 2.6 and 9; TA sections
// 6 and 58; Packet section 2 rules 7, 11 and 13).
//
// Provider-neutral and injectable: each request hands in its own ports.
//
// The database decides everything: the caller's own Referral, the fresh
// eligibility and Bookability, the price (the attorney's offer under the Fee
// Policy), the Hold, the deadlines and every expiry. This module reads its
// answers strictly (an unexpected column or value makes the whole answer
// unavailable, never partly shown), offers only the options and slot starts
// the database derived, and reports only fixed outcomes. The browser never
// decides an expiry: a Request whose server deadline or quote has passed is
// shown as expired from the database's own expired_due flag, and is not
// withdrawable. Before a Request is created or withdrawn the environment
// binding is checked (PS-A2 section 6; Packet rule 7), and a mismatched or
// unrecorded environment refuses. Modalities are configuration: their codes
// come from the database and are never enumerated here. No price is ever
// shown that the database did not derive, and none is a default.

import {
  bindEnvironment,
  type EnvironmentConfiguration,
} from "./environment-binding.ts";
import {
  verifiedClientIntakeOf,
  verifiedClientOf,
  type ClientIntakeSources,
} from "./client-intake.ts";
import { REQUEST_PATHS, type RequestPath } from "./discovery.ts";
import {
  attempt,
  portFrom,
  rowsOf,
  type Refusal,
  type RowsResult,
} from "./professional-identity.ts";
import {
  isOneOf,
  isTimestamp,
  isUuid,
  readExact,
  readRows,
} from "./professional-records.ts";
import { resolveSession, type ServerSessionSource } from "./session.ts";

export { REQUEST_PATHS, type RequestPath } from "./discovery.ts";

// ---------------------------------------------------------------------------
// Vocabulary and ports
// ---------------------------------------------------------------------------

// The Request lifecycle (DM section 9) plus the withdrawal outcome.
export const REQUEST_STATES = Object.freeze([
  "created",
  "payment_authorized",
  "slot_held",
  "awaiting_attorney",
  "accepted",
  "declined",
  "expired",
  "cancelled",
] as const);
export type RequestState = (typeof REQUEST_STATES)[number];

// The states before the attorney's decision, from which a Request can be
// withdrawn.
const UNDECIDED_STATES = Object.freeze([
  "created",
  "payment_authorized",
  "slot_held",
  "awaiting_attorney",
] as const);

export const REVIEW_COLUMNS = Object.freeze([
  "referral_id",
  "attorney_display_name",
  "request_path",
  "request_id",
  "requestable",
]);
export const OPTION_COLUMNS = Object.freeze(["modality", "duration_minutes"]);
export const SLOT_START_COLUMNS = Object.freeze(["slot_start", "slot_end"]);
export const PREVIEW_COLUMNS = Object.freeze([
  "outcome",
  "attorney_listed_price_minor",
  "client_fee_minor",
  "tax_or_other_required_fee_minor",
  "total_client_amount_minor",
  "currency_code",
  "quote_validity_seconds",
]);
export const REQUEST_COLUMNS = Object.freeze([
  "request_id",
  "state",
  "expired_due",
  "request_path",
  "attorney_display_name",
  "requested_modality",
  "duration_minutes",
  "slot_start_at",
  "slot_end_at",
  "response_deadline_at",
  "created_at",
  "attorney_listed_price_minor",
  "client_fee_minor",
  "tax_or_other_required_fee_minor",
  "total_client_amount_minor",
  "currency_code",
  "quote_valid_until",
]);
export const INTAKE_REQUEST_COLUMNS = Object.freeze([
  "attempt_ordinal",
  "referral_id",
  "request_id",
  "state",
  "expired_due",
  "requestable",
]);

// The database's own fixed outcomes.
export const PREVIEW_OUTCOMES = Object.freeze([
  "priced",
  "invalid",
  "not_found",
  "already_requested",
  "not_available",
  "policy_unavailable",
  "price_unavailable",
  "modality_not_permitted",
  "duration_not_permitted",
  "price_not_permitted",
] as const);
export const CREATE_OUTCOMES = Object.freeze([
  "created",
  "invalid",
  "not_found",
  "intake_not_ready",
  "already_requested",
  "not_available",
  "price_unavailable",
  "price_not_permitted",
  "duration_not_permitted",
  "modality_not_permitted",
  "policy_unavailable",
  "cap_reached",
  "too_late",
] as const);
export const WITHDRAW_OUTCOMES = Object.freeze([
  "withdrawn",
  "invalid",
  "not_found",
  "expired",
  "not_withdrawable",
] as const);

// The slot problems the database reports for a time that cannot be held.
const SLOT_PROBLEMS = Object.freeze([
  "notice",
  "outside_availability",
  "blackout",
  "booking_conflict",
  "hold_conflict",
]);

// The most options, slot starts and attempts the database answers.
const MAX_OPTIONS = 50;
const MAX_SLOT_STARTS = 20;
const MAX_ATTEMPTS = 50;
// A modality code (configuration) and the duration bounds.
const MODALITY = /^[a-z][a-z0-9_]{1,31}$/;
const OPTION = /^([a-z][a-z0-9_]{1,31})-([1-9][0-9]{0,3})$/;
// The largest amount, in minor units, the database can derive.
const MAX_AMOUNT = 4_000_000_000_000;

export type QuoteInput = {
  readonly referralId: string;
  readonly path: RequestPath;
  readonly modality: string;
  readonly durationMinutes: number;
  readonly slotStart: string | null;
};

export type RequestReads = {
  // client_request_review(referral)
  readonly review: (referralId: string) => Promise<RowsResult>;
  // request_options(referral)
  readonly options: (referralId: string) => Promise<RowsResult>;
  // request_slot_starts(referral, modality, duration)
  readonly slotStarts: (
    referralId: string,
    modality: string,
    durationMinutes: number,
  ) => Promise<RowsResult>;
  // request_quote_preview(...)
  readonly preview: (input: QuoteInput) => Promise<RowsResult>;
  // client_request(request)
  readonly request: (requestId: string) => Promise<RowsResult>;
  // client_intake_requests(intake)
  readonly intakeRequests: (intakeId: string) => Promise<RowsResult>;
  // deployment_environment_identity()
  readonly environmentIdentity: () => Promise<RowsResult>;
};

export type CreateAnswer =
  | {
      readonly kind: "answer";
      readonly outcome: string;
      readonly requestId: string | null;
      readonly problem: string | null;
    }
  | { readonly kind: "rejected" }
  | { readonly kind: "unreadable" };

export type WithdrawAnswer =
  | { readonly kind: "answer"; readonly outcome: string }
  | { readonly kind: "rejected" }
  | { readonly kind: "unreadable" };

export type RequestWrites = {
  readonly createRequest: (input: QuoteInput) => Promise<CreateAnswer>;
  readonly withdrawRequest: (requestId: string) => Promise<WithdrawAnswer>;
};

export type RequestSources = {
  readonly session: ServerSessionSource;
  // The client intake sources decide the verified client and its Intakes.
  readonly clientIntake: ClientIntakeSources;
  readonly reads: () => Promise<RequestReads | null>;
  readonly writes: () => Promise<RequestWrites | null>;
  // The server-side environment setting compared with the database's own
  // record before a write (PS-A2 section 6).
  readonly environment: () => EnvironmentConfiguration;
};

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function isName(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() !== "" && value.length <= 200
  );
}

function isAmount(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_AMOUNT
  );
}

function isDuration(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 1440
  );
}

function isCurrency(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

export type ConsultationOption = {
  readonly modality: string;
  readonly durationMinutes: number;
};

function readOption(row: unknown): ConsultationOption | null {
  const fields = readExact(row, OPTION_COLUMNS);
  const modality = fields?.get("modality");
  const duration = fields?.get("duration_minutes");
  if (
    typeof modality !== "string" ||
    !MODALITY.test(modality) ||
    !isDuration(duration)
  ) {
    return null;
  }
  return Object.freeze({ modality, durationMinutes: duration });
}

export type SlotStart = { readonly start: string; readonly end: string };

function readSlotStart(row: unknown): SlotStart | null {
  const fields = readExact(row, SLOT_START_COLUMNS);
  const start = fields?.get("slot_start");
  const end = fields?.get("slot_end");
  if (
    !isTimestamp(start) ||
    !isTimestamp(end) ||
    Date.parse(start) >= Date.parse(end)
  ) {
    return null;
  }
  return Object.freeze({ start, end });
}

export type QuoteAmounts = {
  readonly listedPriceMinor: number;
  readonly clientFeeMinor: number;
  readonly otherFeeMinor: number;
  readonly totalMinor: number;
  readonly currency: string;
};

export type QuoteView =
  | ({
      readonly status: "priced";
      readonly validitySeconds: number;
    } & QuoteAmounts)
  | {
      readonly status:
        | "pricing-unavailable"
        | "option-unavailable"
        | "configuration-unavailable"
        | "not-available"
        | "unavailable";
    };

function amountsOf(fields: ReadonlyMap<string, unknown>): QuoteAmounts | null {
  const listed = fields.get("attorney_listed_price_minor");
  const client = fields.get("client_fee_minor");
  const other = fields.get("tax_or_other_required_fee_minor");
  const total = fields.get("total_client_amount_minor");
  const currency = fields.get("currency_code");
  if (
    !isAmount(listed) ||
    listed <= 0 ||
    !isAmount(client) ||
    !isAmount(other) ||
    !isAmount(total) ||
    total < listed ||
    !isCurrency(currency)
  ) {
    return null;
  }
  return {
    listedPriceMinor: listed,
    clientFeeMinor: client,
    otherFeeMinor: other,
    totalMinor: total,
    currency,
  };
}

function readPreview(rows: readonly unknown[] | null): QuoteView {
  if (rows === null || rows.length !== 1) {
    return Object.freeze({ status: "unavailable" });
  }
  const fields = readExact(rows[0], PREVIEW_COLUMNS);
  const outcome = fields?.get("outcome");
  if (fields === null || !isOneOf(PREVIEW_OUTCOMES, outcome)) {
    return Object.freeze({ status: "unavailable" });
  }
  if (outcome !== "priced") {
    if (
      PREVIEW_COLUMNS.slice(1).some((column) => fields.get(column) !== null)
    ) {
      return Object.freeze({ status: "unavailable" });
    }
    switch (outcome) {
      case "price_unavailable":
        return Object.freeze({ status: "pricing-unavailable" });
      case "modality_not_permitted":
      case "duration_not_permitted":
      case "price_not_permitted":
        return Object.freeze({ status: "option-unavailable" });
      case "policy_unavailable":
        return Object.freeze({ status: "configuration-unavailable" });
      case "not_available":
        return Object.freeze({ status: "not-available" });
      default:
        return Object.freeze({ status: "unavailable" });
    }
  }
  const amounts = amountsOf(fields);
  const validity = fields.get("quote_validity_seconds");
  if (
    amounts === null ||
    !Number.isSafeInteger(validity) ||
    (validity as number) < 60 ||
    (validity as number) > 604800
  ) {
    return Object.freeze({ status: "unavailable" });
  }
  return Object.freeze({
    status: "priced",
    validitySeconds: validity as number,
    ...amounts,
  });
}

// ---------------------------------------------------------------------------
// The review page
// ---------------------------------------------------------------------------

type QueryValue = string | readonly string[] | undefined;

function single(value: QueryValue): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  return null;
}

export type RequestReviewQuery = {
  readonly referralId: string | null;
  // The chosen option ("modality-duration") and slot start; absent is null,
  // malformed is "invalid" (reported, never broadened).
  readonly option: ConsultationOption | "invalid" | null;
  readonly slotStart: string | "invalid" | null;
};

// The review page's own query values, checked: the Referral (required), the
// chosen option and, for a scheduled Request, the chosen slot start.
export function requestReviewQueryOf(values: {
  readonly referral?: QueryValue;
  readonly option?: QueryValue;
  readonly slot?: QueryValue;
}): RequestReviewQuery {
  const referral = single(values.referral);
  const option = single(values.option);
  const slot = single(values.slot);
  let chosen: RequestReviewQuery["option"] = null;
  if (option !== undefined && option !== "") {
    const match = option === null ? null : OPTION.exec(option);
    chosen =
      match === null
        ? "invalid"
        : Object.freeze({
            modality: match[1],
            durationMinutes: Number(match[2]),
          });
    if (chosen !== "invalid" && !isDuration(chosen.durationMinutes)) {
      chosen = "invalid";
    }
  }
  let slotStart: RequestReviewQuery["slotStart"] = null;
  if (slot !== undefined && slot !== "") {
    slotStart = slot !== null && isTimestamp(slot) ? slot : "invalid";
  }
  return Object.freeze({
    referralId: isUuid(referral) ? referral : null,
    option: chosen,
    slotStart,
  });
}

// The option's own query value.
export function optionValueOf(option: ConsultationOption): string {
  return `${option.modality}-${option.durationMinutes}`;
}

export type RequestReviewView =
  | { readonly status: "not-found" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" }
  | { readonly status: "requested"; readonly requestHref: string }
  | { readonly status: "not-requestable" }
  | {
      readonly status: "ready";
      readonly referralId: string;
      readonly attorneyName: string | null;
      readonly path: RequestPath;
      readonly options: readonly ConsultationOption[];
      // invalid: a chosen value is malformed or not one of those offered.
      readonly choice: "none" | "invalid" | "option" | "complete";
      readonly option: ConsultationOption | null;
      readonly slotStarts: readonly SlotStart[];
      readonly slotStart: string | null;
      readonly quote: QuoteView | null;
    };

const UNAVAILABLE_VIEW = Object.freeze({ status: "unavailable" } as const);
const NOT_FOUND = Object.freeze({ status: "not-found" } as const);

function refusalOf(refusal: Refusal) {
  return refusal.status === "sign-in-required"
    ? Object.freeze({ status: "sign-in-required" } as const)
    : refusal.status === "denied"
      ? Object.freeze({ status: "denied" } as const)
      : UNAVAILABLE_VIEW;
}

export function requestPathFor(requestId: string): string {
  return `/client/requests/${requestId}`;
}

// The review of one of the verified client's own Referrals: the attorney,
// the path, the options the database prices now, the slot starts for a
// scheduled choice, and the derived quote for a complete choice.
export async function resolveRequestReview(
  sources: RequestSources,
  query: RequestReviewQuery,
): Promise<RequestReviewView> {
  try {
    if (query.referralId === null) {
      return NOT_FOUND;
    }
    const session = await resolveSession(sources.session);
    if (session.status !== "authenticated") {
      return Object.freeze({ status: "sign-in-required" });
    }
    const client = await verifiedClientOf(sources.clientIntake);
    if (!("clientId" in client)) {
      return refusalOf(client);
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE_VIEW;
    }
    const referralId = query.referralId;
    const reviewRows = rowsOf(await attempt(() => reads.review(referralId)));
    if (reviewRows === null || reviewRows.length > 1) {
      return UNAVAILABLE_VIEW;
    }
    if (reviewRows.length === 0) {
      return NOT_FOUND;
    }
    const review = readExact(reviewRows[0], REVIEW_COLUMNS);
    const name = review?.get("attorney_display_name");
    const path = review?.get("request_path");
    const requestId = review?.get("request_id");
    const requestable = review?.get("requestable");
    if (
      review === null ||
      review.get("referral_id") !== referralId ||
      !(name === null || isName(name)) ||
      !(path === null || isOneOf(REQUEST_PATHS, path)) ||
      !(requestId === null || isUuid(requestId)) ||
      typeof requestable !== "boolean" ||
      (requestable && (requestId !== null || path === null))
    ) {
      return UNAVAILABLE_VIEW;
    }
    if (requestId !== null) {
      return Object.freeze({
        status: "requested",
        requestHref: requestPathFor(requestId),
      });
    }
    if (!requestable || path === null) {
      return Object.freeze({ status: "not-requestable" });
    }
    const optionRows = rowsOf(await attempt(() => reads.options(referralId)));
    if (optionRows === null || optionRows.length > MAX_OPTIONS) {
      return UNAVAILABLE_VIEW;
    }
    const options = readRows(optionRows, readOption);
    if (options === null) {
      return UNAVAILABLE_VIEW;
    }
    const base = {
      status: "ready" as const,
      referralId,
      attorneyName: name,
      path,
      options,
    };
    const chosen =
      query.option === null || query.option === "invalid"
        ? query.option
        : (options.find(
            (entry) =>
              entry.modality ===
                (query.option as ConsultationOption).modality &&
              entry.durationMinutes ===
                (query.option as ConsultationOption).durationMinutes,
          ) ?? "invalid");
    if (chosen === null || chosen === "invalid") {
      return Object.freeze({
        ...base,
        choice:
          chosen === null && query.slotStart === null ? "none" : "invalid",
        option: null,
        slotStarts: Object.freeze([]),
        slotStart: null,
        quote: null,
      });
    }
    let slotStarts: readonly SlotStart[] = Object.freeze([]);
    let slotStart: string | null = null;
    if (path === "scheduled") {
      const startRows = rowsOf(
        await attempt(() =>
          reads.slotStarts(referralId, chosen.modality, chosen.durationMinutes),
        ),
      );
      if (startRows === null || startRows.length > MAX_SLOT_STARTS) {
        return UNAVAILABLE_VIEW;
      }
      const starts = readRows(startRows, readSlotStart);
      if (starts === null) {
        return UNAVAILABLE_VIEW;
      }
      slotStarts = starts;
      if (query.slotStart === "invalid") {
        return Object.freeze({
          ...base,
          choice: "invalid",
          option: chosen,
          slotStarts,
          slotStart: null,
          quote: null,
        });
      }
      if (query.slotStart !== null) {
        const wanted = Date.parse(query.slotStart);
        const offered = starts.find(
          (entry) => Date.parse(entry.start) === wanted,
        );
        if (offered === undefined) {
          return Object.freeze({
            ...base,
            choice: "invalid",
            option: chosen,
            slotStarts,
            slotStart: null,
            quote: null,
          });
        }
        slotStart = offered.start;
      }
      if (slotStart === null) {
        return Object.freeze({
          ...base,
          choice: "option",
          option: chosen,
          slotStarts,
          slotStart: null,
          quote: null,
        });
      }
    } else if (query.slotStart !== null) {
      return Object.freeze({
        ...base,
        choice: "invalid",
        option: chosen,
        slotStarts,
        slotStart: null,
        quote: null,
      });
    }
    const quote = readPreview(
      rowsOf(
        await attempt(() =>
          reads.preview({
            referralId,
            path,
            modality: chosen.modality,
            durationMinutes: chosen.durationMinutes,
            slotStart,
          }),
        ),
      ),
    );
    return Object.freeze({
      ...base,
      choice: "complete",
      option: chosen,
      slotStarts,
      slotStart,
      quote,
    });
  } catch {
    return UNAVAILABLE_VIEW;
  }
}

// ---------------------------------------------------------------------------
// Request creation (server action)
// ---------------------------------------------------------------------------

export type RequestActionState =
  | { readonly status: "idle" }
  | { readonly status: "created"; readonly requestId: string }
  | { readonly status: "invalid" }
  | { readonly status: "not-found" }
  | { readonly status: "intake-not-ready" }
  | { readonly status: "already-requested" }
  | { readonly status: "slot-unavailable" }
  | { readonly status: "not-available" }
  | { readonly status: "option-unavailable" }
  | { readonly status: "pricing-unavailable" }
  | { readonly status: "configuration-unavailable" }
  | { readonly status: "cap-reached" }
  | { readonly status: "outcome-unknown" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" };

export const INITIAL_REQUEST_STATE: RequestActionState = Object.freeze({
  status: "idle",
});

type PlainStatus = Exclude<RequestActionState["status"], "created">;

const STATE = (status: PlainStatus) =>
  Object.freeze({ status }) as RequestActionState;

// Each named field at most once and as text; optional fields may be absent.
// A repeated or non-text field answers null. Other names are not read.
function strictFields(
  formData: FormData,
  required: readonly string[],
  optional: readonly string[],
): ReadonlyMap<string, string> | null {
  const fields = new Map<string, string>();
  for (const name of [...required, ...optional]) {
    const values = formData.getAll(name);
    if (values.length === 0 && optional.includes(name)) {
      continue;
    }
    const [value] = values;
    if (values.length !== 1 || typeof value !== "string") {
      return null;
    }
    fields.set(name, value);
  }
  return fields;
}

function createAnswerOf(answer: unknown): CreateAnswer {
  const kind = readExact(answer, ["kind"])?.get("kind");
  if (kind === "rejected" || kind === "unreadable") {
    return Object.freeze({ kind });
  }
  const fields = readExact(answer, ["kind", "outcome", "requestId", "problem"]);
  const outcome = fields?.get("outcome");
  const requestId = fields?.get("requestId");
  const problem = fields?.get("problem");
  if (
    fields?.get("kind") !== "answer" ||
    !isOneOf(CREATE_OUTCOMES, outcome) ||
    !(requestId === null || typeof requestId === "string") ||
    !(problem === null || typeof problem === "string")
  ) {
    return Object.freeze({ kind: "unreadable" });
  }
  return Object.freeze({ kind: "answer", outcome, requestId, problem });
}

// The environment binding before a write: true when the database's own
// record matches the server-side setting.
async function environmentBound(
  sources: RequestSources,
  reads: RequestReads,
): Promise<boolean> {
  const binding = bindEnvironment(
    rowsOf(await attempt(() => reads.environmentIdentity())),
    sources.environment(),
  );
  return binding !== "unrecorded" && binding !== "mismatch";
}

// Creates a Consultation Request from one of the client's own Referrals
// through the database's own function and reports only its fixed outcome.
// The submitted values are checked first (each once, of its own form); the
// database decides everything again, the price included.
export async function createConsultationRequest(
  sources: RequestSources,
  formData: unknown,
): Promise<RequestActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return STATE("unavailable");
    }
    const fields = strictFields(
      formData,
      ["referral", "path", "modality", "duration"],
      ["slot"],
    );
    if (fields === null) {
      return STATE("invalid");
    }
    const referralId = fields.get("referral");
    const path = fields.get("path");
    const modality = fields.get("modality");
    const duration = fields.get("duration");
    const slot = fields.get("slot") ?? null;
    const durationMinutes =
      duration !== undefined && /^[1-9][0-9]{0,3}$/.test(duration)
        ? Number(duration)
        : null;
    if (
      !isUuid(referralId) ||
      !isOneOf(REQUEST_PATHS, path) ||
      typeof modality !== "string" ||
      !MODALITY.test(modality) ||
      durationMinutes === null ||
      !isDuration(durationMinutes) ||
      (path === "scheduled" && (slot === null || !isTimestamp(slot))) ||
      (path === "instant" && slot !== null)
    ) {
      return STATE("invalid");
    }
    const client = await verifiedClientOf(sources.clientIntake);
    if (!("clientId" in client)) {
      return STATE(client.status);
    }
    const reads = await portFrom(sources.reads);
    const writes = await portFrom(sources.writes);
    if (reads === null || writes === null) {
      return STATE("unavailable");
    }
    if (!(await environmentBound(sources, reads))) {
      return STATE("unavailable");
    }
    const answer = createAnswerOf(
      await attempt(() =>
        writes.createRequest({
          referralId,
          path,
          modality,
          durationMinutes,
          slotStart: slot,
        }),
      ),
    );
    if (answer.kind === "rejected") {
      return STATE("unavailable");
    }
    if (answer.kind === "unreadable") {
      return STATE("outcome-unknown");
    }
    switch (answer.outcome) {
      case "created":
        return isUuid(answer.requestId)
          ? Object.freeze({ status: "created", requestId: answer.requestId })
          : STATE("outcome-unknown");
      case "invalid":
        return STATE("invalid");
      case "not_found":
        return STATE("not-found");
      case "intake_not_ready":
        return STATE("intake-not-ready");
      case "already_requested":
        return STATE("already-requested");
      case "not_available":
        return answer.problem !== null && SLOT_PROBLEMS.includes(answer.problem)
          ? STATE("slot-unavailable")
          : STATE("not-available");
      case "too_late":
        return STATE("slot-unavailable");
      case "price_unavailable":
        return STATE("pricing-unavailable");
      case "price_not_permitted":
      case "duration_not_permitted":
      case "modality_not_permitted":
        return STATE("option-unavailable");
      case "policy_unavailable":
        return STATE("configuration-unavailable");
      case "cap_reached":
        return STATE("cap-reached");
      default:
        return STATE("outcome-unknown");
    }
  } catch {
    return STATE("unavailable");
  }
}

// ---------------------------------------------------------------------------
// One Request
// ---------------------------------------------------------------------------

export type ConsultationRequestRecord = {
  readonly id: string;
  readonly state: RequestState;
  // The database's own flag: an undecided Request whose deadline, quote or
  // Hold expiry has passed (the expiry has not been recorded yet).
  readonly expiredDue: boolean;
  readonly path: RequestPath;
  readonly attorneyName: string | null;
  readonly modality: string;
  readonly durationMinutes: number | null;
  readonly slotStart: string | null;
  readonly slotEnd: string | null;
  readonly responseDeadline: string | null;
  readonly createdAt: string;
  readonly amounts: QuoteAmounts | null;
  readonly quoteValidUntil: string | null;
};

function readRequest(row: unknown): ConsultationRequestRecord | null {
  const fields = readExact(row, REQUEST_COLUMNS);
  if (fields === null) {
    return null;
  }
  const id = fields.get("request_id");
  const state = fields.get("state");
  const expiredDue = fields.get("expired_due");
  const path = fields.get("request_path");
  const name = fields.get("attorney_display_name");
  const modality = fields.get("requested_modality");
  const duration = fields.get("duration_minutes");
  const slotStart = fields.get("slot_start_at");
  const slotEnd = fields.get("slot_end_at");
  const deadline = fields.get("response_deadline_at");
  const createdAt = fields.get("created_at");
  const quoteValidUntil = fields.get("quote_valid_until");
  const amountFields = [
    "attorney_listed_price_minor",
    "client_fee_minor",
    "tax_or_other_required_fee_minor",
    "total_client_amount_minor",
    "currency_code",
  ];
  const noQuote = amountFields.every((column) => fields.get(column) === null);
  const amounts = noQuote ? null : amountsOf(fields);
  if (
    !isUuid(id) ||
    !isOneOf(REQUEST_STATES, state) ||
    typeof expiredDue !== "boolean" ||
    (expiredDue && !isOneOf(UNDECIDED_STATES, state)) ||
    !isOneOf(REQUEST_PATHS, path) ||
    !(name === null || isName(name)) ||
    typeof modality !== "string" ||
    !MODALITY.test(modality) ||
    !(duration === null || isDuration(duration)) ||
    !(slotStart === null || isTimestamp(slotStart)) ||
    !(slotEnd === null || isTimestamp(slotEnd)) ||
    (slotStart === null) !== (slotEnd === null) ||
    (path === "instant" && slotStart !== null) ||
    !(deadline === null || isTimestamp(deadline)) ||
    !isTimestamp(createdAt) ||
    !(quoteValidUntil === null || isTimestamp(quoteValidUntil)) ||
    (!noQuote && amounts === null)
  ) {
    return null;
  }
  return Object.freeze({
    id,
    state,
    expiredDue,
    path,
    attorneyName: name,
    modality,
    durationMinutes: duration,
    slotStart,
    slotEnd,
    responseDeadline: deadline,
    createdAt,
    amounts: amounts === null ? null : Object.freeze(amounts),
    quoteValidUntil,
  });
}

// The state to show: an undecided Request the database reports as past its
// deadline is shown expired (the browser never decides this).
export type DisplayState = RequestState;

export type RequestView =
  | { readonly status: "not-found" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly request: ConsultationRequestRecord;
      readonly displayState: DisplayState;
      readonly withdrawable: boolean;
    };

export async function resolveConsultationRequest(
  sources: Pick<RequestSources, "session" | "clientIntake" | "reads">,
  requestId: unknown,
): Promise<RequestView> {
  try {
    if (!isUuid(requestId)) {
      return NOT_FOUND;
    }
    const session = await resolveSession(sources.session);
    if (session.status !== "authenticated") {
      return Object.freeze({ status: "sign-in-required" });
    }
    const client = await verifiedClientOf(sources.clientIntake);
    if (!("clientId" in client)) {
      return refusalOf(client);
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE_VIEW;
    }
    const rows = rowsOf(await attempt(() => reads.request(requestId)));
    if (rows === null || rows.length > 1) {
      return UNAVAILABLE_VIEW;
    }
    if (rows.length === 0) {
      return NOT_FOUND;
    }
    const request = readRequest(rows[0]);
    if (request === null || request.id !== requestId) {
      return UNAVAILABLE_VIEW;
    }
    return Object.freeze({
      status: "ready",
      request,
      displayState: request.expiredDue ? "expired" : request.state,
      withdrawable:
        !request.expiredDue && isOneOf(UNDECIDED_STATES, request.state),
    });
  } catch {
    return UNAVAILABLE_VIEW;
  }
}

// ---------------------------------------------------------------------------
// Withdrawal (server action)
// ---------------------------------------------------------------------------

export type WithdrawActionState =
  | { readonly status: "idle" }
  | { readonly status: "withdrawn" }
  | { readonly status: "expired" }
  | { readonly status: "not-withdrawable" }
  | { readonly status: "not-found" }
  | { readonly status: "invalid" }
  | { readonly status: "outcome-unknown" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" };

export const INITIAL_WITHDRAW_STATE: WithdrawActionState = Object.freeze({
  status: "idle",
});

const WITHDRAW_STATE = (status: WithdrawActionState["status"]) =>
  Object.freeze({ status }) as WithdrawActionState;

function withdrawAnswerOf(answer: unknown): WithdrawAnswer {
  const kind = readExact(answer, ["kind"])?.get("kind");
  if (kind === "rejected" || kind === "unreadable") {
    return Object.freeze({ kind });
  }
  const fields = readExact(answer, ["kind", "outcome"]);
  const outcome = fields?.get("outcome");
  if (
    fields?.get("kind") !== "answer" ||
    !isOneOf(WITHDRAW_OUTCOMES, outcome)
  ) {
    return Object.freeze({ kind: "unreadable" });
  }
  return Object.freeze({ kind: "answer", outcome });
}

export async function withdrawConsultationRequest(
  sources: RequestSources,
  formData: unknown,
): Promise<WithdrawActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return WITHDRAW_STATE("unavailable");
    }
    const fields = strictFields(formData, ["request"], []);
    const requestId = fields?.get("request");
    if (fields === null || !isUuid(requestId)) {
      return WITHDRAW_STATE("invalid");
    }
    const client = await verifiedClientOf(sources.clientIntake);
    if (!("clientId" in client)) {
      return WITHDRAW_STATE(client.status);
    }
    const reads = await portFrom(sources.reads);
    const writes = await portFrom(sources.writes);
    if (reads === null || writes === null) {
      return WITHDRAW_STATE("unavailable");
    }
    if (!(await environmentBound(sources, reads))) {
      return WITHDRAW_STATE("unavailable");
    }
    const answer = withdrawAnswerOf(
      await attempt(() => writes.withdrawRequest(requestId)),
    );
    if (answer.kind === "rejected") {
      return WITHDRAW_STATE("unavailable");
    }
    if (answer.kind === "unreadable") {
      return WITHDRAW_STATE("outcome-unknown");
    }
    switch (answer.outcome) {
      case "withdrawn":
        return WITHDRAW_STATE("withdrawn");
      case "expired":
        return WITHDRAW_STATE("expired");
      case "not_withdrawable":
        return WITHDRAW_STATE("not-withdrawable");
      case "not_found":
        return WITHDRAW_STATE("not-found");
      case "invalid":
        return WITHDRAW_STATE("invalid");
      default:
        return WITHDRAW_STATE("outcome-unknown");
    }
  } catch {
    return WITHDRAW_STATE("unavailable");
  }
}

// ---------------------------------------------------------------------------
// The Requests of one Intake
// ---------------------------------------------------------------------------

export type IntakeRequestAttempt = {
  readonly ordinal: number;
  readonly referralId: string;
  readonly requestId: string | null;
  // The state to show (expired when the database reports it due), or null
  // when no Request was made.
  readonly displayState: RequestState | null;
  readonly requestable: boolean;
};

export type IntakeRequestsView =
  | { readonly status: "unavailable" }
  | { readonly status: "not-found" }
  | {
      readonly status: "ready";
      readonly attempts: readonly IntakeRequestAttempt[];
    };

function readIntakeRequest(row: unknown): IntakeRequestAttempt | null {
  const fields = readExact(row, INTAKE_REQUEST_COLUMNS);
  if (fields === null) {
    return null;
  }
  const ordinal = fields.get("attempt_ordinal");
  const referralId = fields.get("referral_id");
  const requestId = fields.get("request_id");
  const state = fields.get("state");
  const expiredDue = fields.get("expired_due");
  const requestable = fields.get("requestable");
  const none = requestId === null;
  if (
    !Number.isSafeInteger(ordinal) ||
    (ordinal as number) < 1 ||
    !isUuid(referralId) ||
    !(none || isUuid(requestId)) ||
    (none
      ? state !== null || expiredDue !== null
      : !isOneOf(REQUEST_STATES, state) || typeof expiredDue !== "boolean") ||
    typeof requestable !== "boolean" ||
    (requestable && !none)
  ) {
    return null;
  }
  return Object.freeze({
    ordinal: ordinal as number,
    referralId,
    requestId: none ? null : (requestId as string),
    displayState: none
      ? null
      : expiredDue === true
        ? "expired"
        : (state as RequestState),
    requestable,
  });
}

// The attempts of one of the verified client's own Intakes with the Request
// made from each, in order.
export async function resolveIntakeRequests(
  sources: Pick<RequestSources, "clientIntake" | "reads">,
  intakeId: unknown,
): Promise<IntakeRequestsView> {
  try {
    const intake = await verifiedClientIntakeOf(sources.clientIntake, intakeId);
    if (!("client" in intake)) {
      return intake.status === "not-found" ? NOT_FOUND : UNAVAILABLE_VIEW;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE_VIEW;
    }
    const rows = rowsOf(
      await attempt(() => reads.intakeRequests(intake.intakeId)),
    );
    if (rows === null || rows.length > MAX_ATTEMPTS) {
      return UNAVAILABLE_VIEW;
    }
    const attempts = readRows(rows, readIntakeRequest);
    if (
      attempts === null ||
      attempts.some((entry, index) => entry.ordinal !== index + 1)
    ) {
      return UNAVAILABLE_VIEW;
    }
    return Object.freeze({ status: "ready", attempts });
  } catch {
    return UNAVAILABLE_VIEW;
  }
}

// The review page address for a Referral.
export function requestReviewPathFor(referralId: string): string {
  return `/client/requests/new?referral=${referralId}`;
}
