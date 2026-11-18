// The attorney's request queue, one request and the decision on it (MVP-001
// S8; MBS section 13; DM section 9; TA sections 13, 14 and 60; Packet section
// 2 rules 7 and 13; Packet section 3 gate "intake visibility to an attorney
// before acceptance: nothing shown").
//
// Provider-neutral and injectable: each request hands in its own ports.
// Access is decided afresh on the server for every read and every decision by
// the unchanged Security Shell over the trusted session and the trusted
// attorney principal source (the existing attorney workspace access); a
// request without an admitted attorney principal sees no request and sends
// nothing. The database decides everything again: the caller's own approved
// Attorney Profile at aal2, which Requests are the attorney's own and have
// been offered to them, every expiry, the fresh eligibility and bookability
// evaluations, the configured payment and Engagement transitions and the
// Consultation. Reads are strict (an unexpected column or value makes the
// whole answer unavailable, never partly shown) and only the database's fixed
// outcomes are reported. Before a decision the environment binding is checked
// (PS-A2 section 6; Packet rule 7), and an unrecorded or mismatched
// environment refuses. The browser never decides an expiry: a Request whose
// server deadline has passed is shown expired from the database's own
// expired_due flag and offers no decision.
//
// What the attorney sees before acceptance is only what the database answers:
// the path, the modality, the duration, the held time, the attorney-side
// quote amounts (listed price, platform fee) and currency, and the server
// deadlines; never the client's identity, message, Intake or voice memo.

import {
  resolveAttorneyWorkspaceAccess,
  type AttorneyPrincipalSource,
} from "./attorney-access.ts";
import type { CallAnswer } from "./attorney-schedule.ts";
import {
  bindEnvironment,
  type EnvironmentConfiguration,
} from "./environment-binding.ts";
import { readFormFields } from "./form-operation.ts";
import {
  attempt,
  portFrom,
  rowsOf,
  type RowsResult,
} from "./professional-identity.ts";
import {
  isOneOf,
  isTimestamp,
  isUuid,
  readExact,
  readRows,
} from "./professional-records.ts";
import type { StepUpRequired } from "./session-assurance.ts";
import type { ServerSessionSource } from "./session.ts";

export type { CallAnswer } from "./attorney-schedule.ts";

// ---------------------------------------------------------------------------
// Vocabulary and ports
// ---------------------------------------------------------------------------

export const ATTORNEY_REQUEST_PATHS = Object.freeze([
  "instant",
  "scheduled",
] as const);
export type AttorneyRequestPath = (typeof ATTORNEY_REQUEST_PATHS)[number];

// The states an offered Request can be in (DM section 9 plus the withdrawal).
export const OFFERED_STATES = Object.freeze([
  "awaiting_attorney",
  "accepted",
  "declined",
  "expired",
  "cancelled",
] as const);
export type OfferedState = (typeof OFFERED_STATES)[number];

export const ENDED_REASONS = Object.freeze([
  "declined",
  "expired",
  "withdrawn",
  "could_not_proceed",
] as const);
export type EndedReason = (typeof ENDED_REASONS)[number];

// The Consultation lifecycle (DM section 2.4).
export const CONSULTATION_STATES = Object.freeze([
  "created",
  "scheduled",
  "ready",
  "live",
  "completed",
  "cancelled",
  "no_show",
  "technical_failure",
] as const);
export type ConsultationState = (typeof CONSULTATION_STATES)[number];

export const QUEUE_COLUMNS = Object.freeze([
  "request_id",
  "request_path",
  "requested_modality",
  "duration_minutes",
  "slot_start_at",
  "slot_end_at",
  "attorney_listed_price_minor",
  "platform_fee_minor",
  "currency_code",
  "response_deadline_at",
  "decide_by",
  "expired_due",
  "created_at",
]);

export const DETAIL_COLUMNS = Object.freeze([
  "request_id",
  "state",
  "expired_due",
  "request_path",
  "requested_modality",
  "duration_minutes",
  "slot_start_at",
  "slot_end_at",
  "attorney_listed_price_minor",
  "platform_fee_minor",
  "currency_code",
  "response_deadline_at",
  "decide_by",
  "created_at",
  "decided_at",
  "ended_reason",
  "consultation_id",
  "consultation_state",
  "booking_starts_at",
  "booking_ends_at",
]);

// The database's own fixed outcomes.
export const ACCEPT_OUTCOMES = Object.freeze([
  "accepted",
  "invalid",
  "denied",
  "not_found",
  "expired",
  "withdrawn",
  "already_decided",
  "configuration_unavailable",
  "payment_not_ready",
  "not_eligible",
  "eligibility_unavailable",
  "not_bookable",
  "conflict",
]);
export const DECLINE_OUTCOMES = Object.freeze([
  "declined",
  "invalid",
  "denied",
  "not_found",
  "expired",
  "withdrawn",
  "already_decided",
]);

// The most Requests the queue lists (the database's own bound).
export const MAX_QUEUE = 200;

const MODALITY = /^[a-z][a-z0-9_]{1,31}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_MINOR = 1_000_000_000_000;

// Request-scoped, unprivileged reads through the database's own functions.
export type AttorneyRequestReads = {
  // attorney_requests()
  readonly queue: () => Promise<RowsResult>;
  // attorney_request(p_request_id)
  readonly request: (requestId: string) => Promise<RowsResult>;
  // deployment_environment_identity()
  readonly environmentIdentity: () => Promise<RowsResult>;
};

// Request-scoped write port: each call is one database function run for the
// request's own authenticated session. None takes an actor, User or profile.
export type AttorneyRequestWrites = {
  readonly accept: (requestId: string) => Promise<CallAnswer>;
  readonly decline: (requestId: string) => Promise<CallAnswer>;
};

export type AttorneyRequestSources = {
  readonly session: ServerSessionSource;
  readonly attorney: AttorneyPrincipalSource;
  readonly reads: () => Promise<AttorneyRequestReads | null>;
  readonly writes: () => Promise<AttorneyRequestWrites | null>;
  // The server-side environment setting compared with the database's own
  // record before a decision (PS-A2 section 6).
  readonly environment: () => EnvironmentConfiguration;
};

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

export type QueueEntry = {
  readonly id: string;
  readonly path: AttorneyRequestPath;
  readonly modality: string;
  readonly durationMinutes: number;
  readonly slotStart: string | null;
  readonly slotEnd: string | null;
  readonly listedPriceMinor: number;
  readonly platformFeeMinor: number;
  readonly currency: string;
  readonly responseDeadline: string | null;
  // The latest instant the Request can still be decided (the earliest of its
  // response deadline, quote validity and Hold expiry), as the server stored
  // them.
  readonly decideBy: string | null;
  // The database's own flag: a deadline has passed (the expiry has not been
  // recorded yet).
  readonly expiredDue: boolean;
  readonly createdAt: string;
};

export type RequestDetail = QueueEntry & {
  readonly state: OfferedState;
  readonly decidedAt: string | null;
  readonly endedReason: EndedReason | null;
  readonly consultationId: string | null;
  readonly consultationState: ConsultationState | null;
  readonly bookingStart: string | null;
  readonly bookingEnd: string | null;
};

export type AttorneyQueueView =
  | { readonly status: "ready"; readonly entries: readonly QueueEntry[] }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" };

// The state to show: an awaiting Request the database reports past its
// deadline is shown expired.
export type AttorneyDisplayState = OfferedState | "could_not_proceed";

export type AttorneyRequestView =
  | { readonly status: "not-found" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly request: RequestDetail;
      readonly displayState: AttorneyDisplayState;
      readonly decidable: boolean;
    };

const SIGN_IN_REQUIRED = Object.freeze({ status: "sign-in-required" } as const);
const DENIED = Object.freeze({ status: "denied" } as const);
const UNAVAILABLE = Object.freeze({ status: "unavailable" } as const);
const NOT_FOUND = Object.freeze({ status: "not-found" } as const);

const isModality = (value: unknown): value is string =>
  typeof value === "string" && MODALITY.test(value);
const isCurrency = (value: unknown): value is string =>
  typeof value === "string" && CURRENCY.test(value);
const nullableTime = (value: unknown): value is string | null =>
  value === null || isTimestamp(value);
const nullableId = (value: unknown): value is string | null =>
  value === null || isUuid(value);

function isDuration(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 1440
  );
}

function isMinor(value: unknown, minimum: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= MAX_MINOR
  );
}

function entryOf(fields: ReadonlyMap<string, unknown>): QueueEntry | null {
  const id = fields.get("request_id");
  const path = fields.get("request_path");
  const modality = fields.get("requested_modality");
  const duration = fields.get("duration_minutes");
  const slotStart = fields.get("slot_start_at");
  const slotEnd = fields.get("slot_end_at");
  const price = fields.get("attorney_listed_price_minor");
  const platformFee = fields.get("platform_fee_minor");
  const currency = fields.get("currency_code");
  const deadline = fields.get("response_deadline_at");
  const decideBy = fields.get("decide_by");
  const expiredDue = fields.get("expired_due");
  const createdAt = fields.get("created_at");
  if (
    !isUuid(id) ||
    !isOneOf(ATTORNEY_REQUEST_PATHS, path) ||
    !isModality(modality) ||
    !isDuration(duration) ||
    !nullableTime(slotStart) ||
    !nullableTime(slotEnd) ||
    (slotStart === null) !== (slotEnd === null) ||
    (path === "instant") !== (slotStart === null) ||
    !isMinor(price, 1) ||
    !isMinor(platformFee, 0) ||
    !isCurrency(currency) ||
    !nullableTime(deadline) ||
    !nullableTime(decideBy) ||
    typeof expiredDue !== "boolean" ||
    !isTimestamp(createdAt)
  ) {
    return null;
  }
  return {
    id,
    path,
    modality,
    durationMinutes: duration,
    slotStart,
    slotEnd,
    listedPriceMinor: price,
    platformFeeMinor: platformFee,
    currency,
    responseDeadline: deadline,
    decideBy,
    expiredDue,
    createdAt,
  };
}

function readQueueEntry(row: unknown): QueueEntry | null {
  const fields = readExact(row, QUEUE_COLUMNS);
  if (fields === null) {
    return null;
  }
  const entry = entryOf(fields);
  return entry === null ? null : Object.freeze(entry);
}

function readDetail(row: unknown): RequestDetail | null {
  const fields = readExact(row, DETAIL_COLUMNS);
  if (fields === null) {
    return null;
  }
  const entry = entryOf(fields);
  const state = fields.get("state");
  const decidedAt = fields.get("decided_at");
  const endedReason = fields.get("ended_reason");
  const consultationId = fields.get("consultation_id");
  const consultationState = fields.get("consultation_state");
  const bookingStart = fields.get("booking_starts_at");
  const bookingEnd = fields.get("booking_ends_at");
  if (
    entry === null ||
    !isOneOf(OFFERED_STATES, state) ||
    (entry.expiredDue && state !== "awaiting_attorney") ||
    !nullableTime(decidedAt) ||
    (decidedAt !== null) !== (state === "accepted" || state === "declined") ||
    !(endedReason === null || isOneOf(ENDED_REASONS, endedReason)) ||
    (endedReason === null) !==
      (state === "awaiting_attorney" || state === "accepted") ||
    !nullableId(consultationId) ||
    (consultationId !== null && state !== "accepted") ||
    !(
      consultationState === null ||
      isOneOf(CONSULTATION_STATES, consultationState)
    ) ||
    (consultationState === null) !== (consultationId === null) ||
    !nullableTime(bookingStart) ||
    !nullableTime(bookingEnd) ||
    (bookingStart === null) !== (bookingEnd === null) ||
    (bookingStart !== null && consultationId === null)
  ) {
    return null;
  }
  return Object.freeze({
    ...entry,
    state,
    decidedAt,
    endedReason: endedReason as EndedReason | null,
    consultationId,
    consultationState: consultationState as ConsultationState | null,
    bookingStart,
    bookingEnd,
  });
}

// Admits the request's attorney principal, or answers the fixed refusal.
async function admitted(
  sources: Pick<AttorneyRequestSources, "session" | "attorney">,
): Promise<
  "granted" | typeof SIGN_IN_REQUIRED | typeof DENIED | typeof UNAVAILABLE
> {
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
  return access.status === "granted" ? "granted" : UNAVAILABLE;
}

// The Requests awaiting the attorney's decision. It never throws: anything
// that fails, cannot be read, or does not add up is unavailable, and nothing
// is read without the attorney principal.
export async function resolveAttorneyQueue(
  sources: Pick<AttorneyRequestSources, "session" | "attorney" | "reads">,
): Promise<AttorneyQueueView> {
  try {
    const access = await admitted(sources);
    if (access !== "granted") {
      return access;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.queue()));
    if (rows === null || rows.length > MAX_QUEUE) {
      return UNAVAILABLE;
    }
    const entries = readRows(rows, readQueueEntry);
    if (
      entries === null ||
      new Set(entries.map((entry) => entry.id)).size !== entries.length
    ) {
      return UNAVAILABLE;
    }
    return Object.freeze({ status: "ready", entries });
  } catch {
    return UNAVAILABLE;
  }
}

// One Request offered to the attorney. Another attorney's, an unknown and a
// malformed id answer alike: not found.
export async function resolveAttorneyRequest(
  sources: Pick<AttorneyRequestSources, "session" | "attorney" | "reads">,
  requestId: unknown,
): Promise<AttorneyRequestView> {
  try {
    if (!isUuid(requestId)) {
      return NOT_FOUND;
    }
    const access = await admitted(sources);
    if (access !== "granted") {
      return access;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.request(requestId)));
    if (rows === null || rows.length > 1) {
      return UNAVAILABLE;
    }
    if (rows.length === 0) {
      return NOT_FOUND;
    }
    const request = readDetail(rows[0]);
    if (request === null || request.id !== requestId) {
      return UNAVAILABLE;
    }
    const displayState: AttorneyDisplayState = request.expiredDue
      ? "expired"
      : request.endedReason === "could_not_proceed"
        ? "could_not_proceed"
        : request.state;
    return Object.freeze({
      status: "ready",
      request,
      displayState,
      decidable: request.state === "awaiting_attorney" && !request.expiredDue,
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// The decision (server actions)
// ---------------------------------------------------------------------------

export const DECISION_OUTCOMES = Object.freeze([
  "request_accepted",
  "request_declined",
  "not_found",
  "expired",
  "withdrawn",
  "already_decided",
  "configuration_unavailable",
  "payment_not_ready",
  "not_eligible",
  "eligibility_unavailable",
  "not_bookable",
  "conflict",
] as const);
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export type DecisionActionState =
  | { readonly status: "idle" }
  | { readonly status: "invalid" }
  | { readonly status: "outcome"; readonly outcome: DecisionOutcome }
  | { readonly status: "unconfirmed" }
  | { readonly status: "sign-in-required" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" }
  | StepUpRequired;

export const INITIAL_DECISION_STATE: DecisionActionState = Object.freeze({
  status: "idle",
});

const UNCONFIRMED = Object.freeze({ status: "unconfirmed" } as const);
const INVALID = Object.freeze({ status: "invalid" } as const);

function outcomeState(outcome: DecisionOutcome): DecisionActionState {
  return Object.freeze({ status: "outcome", outcome });
}

const SHARED_OUTCOMES: Readonly<Record<string, DecisionActionState>> =
  Object.freeze({
    not_found: outcomeState("not_found"),
    expired: outcomeState("expired"),
    withdrawn: outcomeState("withdrawn"),
    already_decided: outcomeState("already_decided"),
    invalid: INVALID,
  });

const ACCEPT_TABLE: Readonly<Record<string, DecisionActionState>> =
  Object.freeze({
    ...SHARED_OUTCOMES,
    accepted: outcomeState("request_accepted"),
    configuration_unavailable: outcomeState("configuration_unavailable"),
    payment_not_ready: outcomeState("payment_not_ready"),
    not_eligible: outcomeState("not_eligible"),
    eligibility_unavailable: outcomeState("eligibility_unavailable"),
    not_bookable: outcomeState("not_bookable"),
    conflict: outcomeState("conflict"),
  });

const DECLINE_TABLE: Readonly<Record<string, DecisionActionState>> =
  Object.freeze({
    ...SHARED_OUTCOMES,
    declined: outcomeState("request_declined"),
  });

// Maps one answer through the decision's own table of outcomes. "denied" is
// always a refusal; a database rejection inside the call committed nothing;
// anything unknown is unconfirmed.
function settle(
  answer: unknown,
  table: Readonly<Record<string, DecisionActionState>>,
): DecisionActionState {
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
    ? UNAVAILABLE
    : UNCONFIRMED;
}

// The one Request a decision concerns, from the submitted form: exactly one
// identifier, or null.
export function decisionRequestOf(formData: FormData): string | null {
  const value = readFormFields(formData).get("request");
  return isUuid(value) && formData.getAll("request").length === 1
    ? value
    : null;
}

// Admits the request's attorney principal, checks the environment binding,
// then hands the write port to the decision. Nothing is sent without both.
async function decide(
  sources: AttorneyRequestSources,
  formData: FormData,
  call: (
    writes: AttorneyRequestWrites,
    requestId: string,
  ) => Promise<CallAnswer>,
  table: Readonly<Record<string, DecisionActionState>>,
): Promise<DecisionActionState> {
  try {
    const requestId = decisionRequestOf(formData);
    if (requestId === null) {
      return outcomeState("not_found");
    }
    const access = await admitted(sources);
    if (access !== "granted") {
      return access;
    }
    const reads = await portFrom(sources.reads);
    const writes = await portFrom(sources.writes);
    if (reads === null || writes === null) {
      return UNAVAILABLE;
    }
    const binding = bindEnvironment(
      rowsOf(await attempt(() => reads.environmentIdentity())),
      sources.environment(),
    );
    if (binding === "unrecorded" || binding === "mismatch") {
      return UNAVAILABLE;
    }
    return settle(await attempt(() => call(writes, requestId)), table);
  } catch {
    return UNAVAILABLE;
  }
}

export async function acceptAttorneyRequest(
  sources: AttorneyRequestSources,
  formData: FormData,
): Promise<DecisionActionState> {
  return decide(
    sources,
    formData,
    (writes, requestId) => writes.accept(requestId),
    ACCEPT_TABLE,
  );
}

export async function declineAttorneyRequest(
  sources: AttorneyRequestSources,
  formData: FormData,
): Promise<DecisionActionState> {
  return decide(
    sources,
    formData,
    (writes, requestId) => writes.decline(requestId),
    DECLINE_TABLE,
  );
}

export function attorneyRequestPathFor(requestId: string): string {
  if (!isUuid(requestId)) {
    throw new Error("not a request identifier");
  }
  return `/attorney/requests/${requestId}`;
}
