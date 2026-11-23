// Data requests (MVP-001 S11; PS-A6 section 3; MBS sections 18.2 "privacy /
// data controls" and 18.4 "privacy / data requests"; TA sections 18, 41 and
// 51; PM row 48).
//
// Provider-neutral and injectable: each request hands in its own ports. The
// verified client of the request submits a request of one type (access,
// correction, deletion, export or restriction) with an optional description,
// sees their own requests and withdraws one before its decision. Staff
// holding the global manage_data_requests grant (aal2) list the requests,
// read one (with whether a Legal Hold applies), assign it to themselves and
// record a decision (allowed, restricted, deferred or denied). A decision is a
// record only: nothing is deleted, exported, corrected or restricted by it,
// and the database refuses a deletion decided allowed while a Legal Hold
// applies. No statement of rights, timelines or retention is made here
// (Packet rule 11). The database decides every step again and audits it
// with codes and identifiers only (never the description). Reads are strict.

import type { ClientIntakeSources } from "./client-intake.ts";
import type { EnvironmentConfiguration } from "./environment-binding.ts";
import {
  attempt,
  portFrom,
  rowsOf,
  textField,
  UNAVAILABLE,
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
import {
  verifiedStaffWith,
  type ConfigurationSources,
} from "./staff-configuration.ts";
import {
  admittedClient,
  environmentBound,
  formFieldsOf,
  IDLE,
  INVALID,
  settle,
  staffOffsetOf,
  staffPageOf,
  staffPageRows,
  type ActionState,
  type CommandAnswer,
  type StaffPager,
  withinCharacters,
} from "./workspace-support.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const DATA_REQUESTS_CAPABILITY = "manage_data_requests";

export const REQUEST_TYPES = Object.freeze([
  "access",
  "correction",
  "deletion",
  "export",
  "restriction",
] as const);
export type RequestType = (typeof REQUEST_TYPES)[number];

export const REQUEST_STATES = Object.freeze([
  "submitted",
  "in_review",
  "decided",
  "withdrawn",
] as const);
export type RequestState = (typeof REQUEST_STATES)[number];

export const OUTCOME_CODES = Object.freeze([
  "allowed",
  "restricted",
  "deferred",
  "denied",
] as const);
export type OutcomeCode = (typeof OUTCOME_CODES)[number];

export const ACCOUNT_STATES = Object.freeze([
  "pending_verification",
  "active",
  "suspended",
  "closed",
] as const);
export type AccountState = (typeof ACCOUNT_STATES)[number];

// PS-A6 section 3 rule 6 (the PS-A1 client free-text ceiling).
export const MAX_DETAILS = 20000;
// The database's own bound on the client's list.
export const MAX_OWN_REQUESTS = 200;

export const SUBMIT_OUTCOMES = Object.freeze([
  "submitted",
  "invalid",
  "denied",
  "already_open",
]);
export const WITHDRAW_OUTCOMES = Object.freeze([
  "withdrawn",
  "invalid",
  "denied",
  "not_found",
  "already_decided",
  "already_withdrawn",
]);
export const ASSIGN_OUTCOMES = Object.freeze([
  "applied",
  "invalid",
  "denied",
  "not_found",
  "invalid_transition",
]);
export const DECIDE_OUTCOMES = Object.freeze([
  ...ASSIGN_OUTCOMES,
  "legal_hold",
]);

export const OWN_REQUEST_COLUMNS = Object.freeze([
  "data_request_id",
  "request_type",
  "state",
  "details",
  "outcome_code",
  "submitted_at",
  "decided_at",
  "updated_at",
]);
export const QUEUE_COLUMNS = Object.freeze([
  "data_request_id",
  "request_type",
  "state",
  "outcome_code",
  "submitted_at",
  "decided_at",
  "assigned_to_me",
]);
export const REQUEST_COLUMNS = Object.freeze([
  "data_request_id",
  "request_type",
  "state",
  "details",
  "outcome_code",
  "submitted_at",
  "decided_at",
  "updated_at",
  "assigned",
  "assigned_to_me",
  "requester_user_id",
  "requester_account_state",
  "legal_hold_applies",
]);

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type DataRequestReads = {
  // client_data_requests()
  readonly mine: () => Promise<RowsResult>;
  // staff_data_request_queue(p_state, p_offset)
  readonly queue: (state: RequestState, offset: number) => Promise<RowsResult>;
  // staff_data_request(p_data_request_id)
  readonly request: (requestId: string) => Promise<RowsResult>;
  // deployment_environment_identity()
  readonly environmentIdentity: () => Promise<RowsResult>;
};

export type DataRequestWrites = {
  // client_submit_data_request(p_request_type, p_details)
  readonly submit: (
    type: RequestType,
    details: string | null,
  ) => Promise<CommandAnswer>;
  // client_withdraw_data_request(p_data_request_id)
  readonly withdraw: (requestId: string) => Promise<CommandAnswer>;
  // staff_assign_data_request(p_data_request_id)
  readonly assign: (requestId: string) => Promise<CommandAnswer>;
  // staff_decide_data_request(p_data_request_id, p_outcome_code)
  readonly decide: (
    requestId: string,
    outcome: OutcomeCode,
  ) => Promise<CommandAnswer>;
};

type Shared = {
  readonly reads: () => Promise<DataRequestReads | null>;
  readonly writes: () => Promise<DataRequestWrites | null>;
  readonly environment: () => EnvironmentConfiguration;
};

export type ClientDataRequestSources = Shared & {
  readonly clientIntake: ClientIntakeSources;
};

export type StaffDataRequestSources = Shared & {
  readonly staff: ConfigurationSources;
};

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

const nullableTime = (value: unknown): value is string | null =>
  value === null || isTimestamp(value);
const isDetails = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === "string" &&
    value.trim() !== "" &&
    withinCharacters(value, MAX_DETAILS));

type RequestBase = {
  readonly id: string;
  readonly type: RequestType;
  readonly state: RequestState;
  readonly outcome: OutcomeCode | null;
  readonly submittedAt: string;
  readonly decidedAt: string | null;
};

function readBase(f: ReadonlyMap<string, unknown>): RequestBase | null {
  const value = {
    id: f.get("data_request_id"),
    type: f.get("request_type"),
    state: f.get("state"),
    outcome: f.get("outcome_code"),
    submittedAt: f.get("submitted_at"),
    decidedAt: f.get("decided_at"),
  };
  if (
    !isUuid(value.id) ||
    !isOneOf(REQUEST_TYPES, value.type) ||
    !isOneOf(REQUEST_STATES, value.state) ||
    !(value.outcome === null || isOneOf(OUTCOME_CODES, value.outcome)) ||
    !isTimestamp(value.submittedAt) ||
    !nullableTime(value.decidedAt) ||
    (value.state === "decided") !== (value.decidedAt !== null) ||
    (value.state === "decided") !== (value.outcome !== null)
  ) {
    return null;
  }
  return Object.freeze(value) as RequestBase;
}

export type OwnDataRequest = RequestBase & {
  readonly details: string | null;
  readonly updatedAt: string;
};

function readOwn(row: unknown): OwnDataRequest | null {
  const f = readExact(row, OWN_REQUEST_COLUMNS);
  if (f === null) {
    return null;
  }
  const base = readBase(f);
  const details = f.get("details");
  const updatedAt = f.get("updated_at");
  if (base === null || !isDetails(details) || !isTimestamp(updatedAt)) {
    return null;
  }
  return Object.freeze({ ...base, details, updatedAt });
}

export type QueuedDataRequest = RequestBase & {
  readonly assignedToMe: boolean;
};

function readQueued(row: unknown): QueuedDataRequest | null {
  const f = readExact(row, QUEUE_COLUMNS);
  if (f === null) {
    return null;
  }
  const base = readBase(f);
  const assignedToMe = f.get("assigned_to_me");
  if (base === null || typeof assignedToMe !== "boolean") {
    return null;
  }
  return Object.freeze({ ...base, assignedToMe });
}

export type StaffDataRequest = OwnDataRequest & {
  readonly assigned: boolean;
  readonly assignedToMe: boolean;
  readonly requesterUserId: string;
  readonly requesterAccountState: AccountState;
  readonly legalHoldApplies: boolean;
};

function readRequest(row: unknown): StaffDataRequest | null {
  const f = readExact(row, REQUEST_COLUMNS);
  if (f === null) {
    return null;
  }
  const base = readBase(f);
  const value = {
    details: f.get("details"),
    updatedAt: f.get("updated_at"),
    assigned: f.get("assigned"),
    assignedToMe: f.get("assigned_to_me"),
    requesterUserId: f.get("requester_user_id"),
    requesterAccountState: f.get("requester_account_state"),
    legalHoldApplies: f.get("legal_hold_applies"),
  };
  if (
    base === null ||
    !isDetails(value.details) ||
    !isTimestamp(value.updatedAt) ||
    typeof value.assigned !== "boolean" ||
    typeof value.assignedToMe !== "boolean" ||
    (value.assignedToMe && !value.assigned) ||
    !isUuid(value.requesterUserId) ||
    !isOneOf(ACCOUNT_STATES, value.requesterAccountState) ||
    typeof value.legalHoldApplies !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({ ...base, ...value }) as StaffDataRequest;
}

// ---------------------------------------------------------------------------
// The client's requests
// ---------------------------------------------------------------------------

export type ClientDataRequestsView =
  | { readonly status: "ready"; readonly requests: readonly OwnDataRequest[] }
  | Refusal;

export async function resolveClientDataRequests(
  sources: Pick<ClientDataRequestSources, "clientIntake" | "reads">,
): Promise<ClientDataRequestsView> {
  try {
    const access = await admittedClient(sources.clientIntake);
    if (access !== "granted") {
      return access;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.mine()));
    if (rows === null || rows.length > MAX_OWN_REQUESTS) {
      return UNAVAILABLE;
    }
    const requests = readRows(rows, readOwn);
    return requests === null
      ? UNAVAILABLE
      : Object.freeze({ status: "ready", requests });
  } catch {
    return UNAVAILABLE;
  }
}

export const CLIENT_ACTION_OUTCOMES = Object.freeze([
  "request_submitted",
  "already_open",
  "request_withdrawn",
  "already_decided",
  "already_withdrawn",
  "not_found",
] as const);
export type ClientActionOutcome = (typeof CLIENT_ACTION_OUTCOMES)[number];
export type ClientActionState = ActionState<ClientActionOutcome>;
export const INITIAL_CLIENT_STATE: ClientActionState = IDLE;

const SUBMIT_TABLE: Readonly<Record<string, ClientActionOutcome>> =
  Object.freeze({
    submitted: "request_submitted",
    already_open: "already_open",
  });
const WITHDRAW_TABLE: Readonly<Record<string, ClientActionOutcome>> =
  Object.freeze({
    withdrawn: "request_withdrawn",
    not_found: "not_found",
    already_decided: "already_decided",
    already_withdrawn: "already_withdrawn",
  });

async function clientChange(
  sources: ClientDataRequestSources,
  call: (writes: DataRequestWrites) => Promise<CommandAnswer>,
  table: Readonly<Record<string, ClientActionOutcome>>,
): Promise<ClientActionState> {
  const access = await admittedClient(sources.clientIntake);
  if (access !== "granted") {
    return access;
  }
  const reads = await portFrom(sources.reads);
  const writes = await portFrom(sources.writes);
  if (
    reads === null ||
    writes === null ||
    !(await environmentBound(
      () => reads.environmentIdentity(),
      sources.environment,
    ))
  ) {
    return UNAVAILABLE;
  }
  return settle(await attempt(() => call(writes)), table);
}

// The client submits a request of one type with an optional description (at
// most 20,000 characters; an empty one is none).
export async function submitDataRequest(
  sources: ClientDataRequestSources,
  formData: unknown,
): Promise<ClientActionState> {
  try {
    const fields = formFieldsOf(formData, ["type"], ["details"]);
    const type = fields?.get("type");
    const details = textField(fields?.get("details"), MAX_DETAILS);
    if (!isOneOf(REQUEST_TYPES, type) || details === null) {
      return INVALID;
    }
    return await clientChange(
      sources,
      (writes) => writes.submit(type, details === "" ? null : details),
      SUBMIT_TABLE,
    );
  } catch {
    return UNAVAILABLE;
  }
}

// The client withdraws one of their own requests before its decision.
export async function withdrawDataRequest(
  sources: ClientDataRequestSources,
  formData: unknown,
): Promise<ClientActionState> {
  try {
    const requestId = formFieldsOf(formData, ["request"])?.get("request");
    if (!isUuid(requestId)) {
      return INVALID;
    }
    return await clientChange(
      sources,
      (writes) => writes.withdraw(requestId),
      WITHDRAW_TABLE,
    );
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// The staff data request workspace
// ---------------------------------------------------------------------------

export function requestStateOf(value: unknown): RequestState {
  return isOneOf(REQUEST_STATES, value) ? value : "submitted";
}

async function staffContext(
  sources: StaffDataRequestSources,
): Promise<{ readonly reads: DataRequestReads } | Refusal> {
  const staff = await verifiedStaffWith(
    sources.staff,
    DATA_REQUESTS_CAPABILITY,
  );
  if (!("userId" in staff)) {
    return staff;
  }
  const reads = await portFrom(sources.reads);
  return reads === null ? UNAVAILABLE : { reads };
}

export type DataRequestQueueView =
  | {
      readonly status: "ready";
      readonly requestState: RequestState;
      readonly requests: readonly QueuedDataRequest[];
      readonly pager: StaffPager;
    }
  | Refusal;

export async function resolveDataRequestQueue(
  sources: StaffDataRequestSources,
  stateValue: unknown,
  pageValue: unknown,
): Promise<DataRequestQueueView> {
  try {
    const requestState = requestStateOf(stateValue);
    const page = staffPageOf(pageValue);
    const context = await staffContext(sources);
    if (!("reads" in context)) {
      return context;
    }
    const read = staffPageRows(
      rowsOf(
        await attempt(() =>
          context.reads.queue(requestState, staffOffsetOf(page)),
        ),
      ),
      readQueued,
      page,
    );
    if (read === null || read.rows.some((row) => row.state !== requestState)) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      status: "ready",
      requestState,
      requests: read.rows,
      pager: read.pager,
    });
  } catch {
    return UNAVAILABLE;
  }
}

const NOT_FOUND = Object.freeze({ status: "not-found" } as const);

export type DataRequestView =
  | { readonly status: "ready"; readonly request: StaffDataRequest }
  | typeof NOT_FOUND
  | Refusal;

// One request for staff. A malformed id and an unknown one answer alike.
export async function resolveDataRequest(
  sources: StaffDataRequestSources,
  requestId: unknown,
): Promise<DataRequestView> {
  try {
    if (!isUuid(requestId)) {
      return NOT_FOUND;
    }
    const context = await staffContext(sources);
    if (!("reads" in context)) {
      return context;
    }
    const rows = rowsOf(await attempt(() => context.reads.request(requestId)));
    if (rows === null || rows.length > 1) {
      return UNAVAILABLE;
    }
    if (rows.length === 0) {
      return NOT_FOUND;
    }
    const request = readRequest(rows[0]);
    return request === null || request.id !== requestId
      ? UNAVAILABLE
      : Object.freeze({ status: "ready", request });
  } catch {
    return UNAVAILABLE;
  }
}

export const STAFF_ACTION_OUTCOMES = Object.freeze([
  "applied",
  "not_found",
  "invalid_transition",
  "legal_hold",
] as const);
export type StaffActionOutcome = (typeof STAFF_ACTION_OUTCOMES)[number];
export type StaffActionState = ActionState<StaffActionOutcome>;
export const INITIAL_STAFF_STATE: StaffActionState = IDLE;

const STAFF_TABLE: Readonly<Record<string, StaffActionOutcome>> = Object.freeze(
  {
    applied: "applied",
    not_found: "not_found",
    invalid_transition: "invalid_transition",
    legal_hold: "legal_hold",
  },
);

async function staffChange(
  sources: StaffDataRequestSources,
  call: (writes: DataRequestWrites) => Promise<CommandAnswer>,
): Promise<StaffActionState> {
  const context = await staffContext(sources);
  if (!("reads" in context)) {
    return context;
  }
  const writes = await portFrom(sources.writes);
  if (
    writes === null ||
    !(await environmentBound(
      () => context.reads.environmentIdentity(),
      sources.environment,
    ))
  ) {
    return UNAVAILABLE;
  }
  return settle(await attempt(() => call(writes)), STAFF_TABLE);
}

// Staff assign a request to themselves.
export async function assignDataRequest(
  sources: StaffDataRequestSources,
  formData: unknown,
): Promise<StaffActionState> {
  try {
    const requestId = formFieldsOf(formData, ["request"])?.get("request");
    if (!isUuid(requestId)) {
      return INVALID;
    }
    return await staffChange(sources, (writes) => writes.assign(requestId));
  } catch {
    return UNAVAILABLE;
  }
}

// Staff record a decision (an outcome code; nothing is executed).
export async function decideDataRequest(
  sources: StaffDataRequestSources,
  formData: unknown,
): Promise<StaffActionState> {
  try {
    const fields = formFieldsOf(formData, ["request", "outcome"]);
    const requestId = fields?.get("request");
    const outcome = fields?.get("outcome");
    if (!isUuid(requestId) || !isOneOf(OUTCOME_CODES, outcome)) {
      return INVALID;
    }
    return await staffChange(sources, (writes) =>
      writes.decide(requestId, outcome),
    );
  } catch {
    return UNAVAILABLE;
  }
}

export function staffDataRequestPathFor(requestId: string): string {
  if (!isUuid(requestId)) {
    throw new Error("not a data request identifier");
  }
  return `/staff/data-requests/${requestId}`;
}
