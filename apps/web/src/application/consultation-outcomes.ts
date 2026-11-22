// How a Consultation ends other than by the attorney's normal end, and the
// staff consultation operations (MVP-001 S11; MBS section 16 "Completion" and
// "Operations"; DM section 2.4; TA sections 18, 41 and 48; PS sections 17 and
// 30.4; PM rows 11 to 22 and INV-9, INV-11 and INV-13).
//
// Provider-neutral and injectable: each request hands in its own ports.
// Access is decided afresh on the server for every read and every action: a
// client through the verified client of the request, an attorney through the
// unchanged Security Shell, staff through the verified staff identity of the
// staff configuration surfaces holding manage_consultation_operations. The
// database decides everything again (the Consultation's own participant, aal2
// for the attorney and staff, the capability for the Consultation's
// jurisdiction, the state, the window rule, the evidence and every
// consequence), and only its own fixed outcomes are reported. Reads are
// strict: an unexpected column or value makes the whole answer unavailable,
// never partly shown. Before a change the environment binding is checked
// (PS-A2 section 6; Packet rule 7).
//
// Nothing here decides a refund, a charge, a threshold or an entitlement, and
// nothing infers an outcome: a cancellation is the participant's own command,
// an early completion is the attorney's recorded declaration, and a no-show,
// a technical failure or a manual resolution is recorded by staff from the
// attendance evidence once the participants can no longer proceed. Where the
// financial treatment of an outcome is not settled, the database leaves the
// payment as it is and opens a review item for a person to resolve.
//
// After a change one bounded worker run follows, so the room's closing, a
// provider release and the notification emails usually happen at once.

import type { AttorneyPrincipalSource } from "./attorney-access.ts";
import {
  CONSULTATION_STATES,
  type ConsultationState,
} from "./attorney-requests.ts";
import type { ClientIntakeSources } from "./client-intake.ts";
import type { EnvironmentConfiguration } from "./environment-binding.ts";
import { PAYMENT_STATES, type PaymentState } from "./payments.ts";
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
import type { ServerSessionSource } from "./session.ts";
import {
  verifiedStaffWith,
  verifiedStaffWithAny,
  type ConfigurationSources,
} from "./staff-configuration.ts";
import {
  admittedAttorney,
  admittedClient,
  drainAfter,
  environmentBound,
  formFieldsOf,
  IDLE,
  INVALID,
  isCode,
  outcomeState,
  settle,
  staffOffsetOf,
  staffPageOf,
  staffPageRows,
  type ActionState,
  type Admission,
  type CommandAnswer,
  type StaffPager,
} from "./workspace-support.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const OPERATIONS_CAPABILITY = "manage_consultation_operations";
export const COMPLIANCE_CAPABILITY = "manage_compliance_reviews";

// The review item families a staff surface here lists, and the capability
// each needs (the database's own mapping; the financial family is the finance
// workspace's).
export const REVIEW_FAMILIES = Object.freeze([
  "operations",
  "compliance",
] as const);
export type ReviewFamily = (typeof REVIEW_FAMILIES)[number];
export const FAMILY_CAPABILITIES = Object.freeze({
  operations: OPERATIONS_CAPABILITY,
  compliance: COMPLIANCE_CAPABILITY,
} as const satisfies Record<ReviewFamily, string>);

// The outcome codes of each terminal state (the database's own vocabulary).
export const OUTCOME_CODES_OF = Object.freeze({
  completed: Object.freeze([
    "normal",
    "early_by_agreement",
    "manual_resolution",
  ] as const),
  cancelled: Object.freeze(["client_cancelled", "attorney_cancelled"] as const),
  no_show: Object.freeze([
    "client_no_show",
    "attorney_no_show",
    "both_no_show",
  ] as const),
  technical_failure: Object.freeze([
    "neither_connected",
    "mid_consultation_failure",
  ] as const),
});
export type TerminalState = keyof typeof OUTCOME_CODES_OF;
export const TERMINAL_STATES = Object.freeze(
  Object.keys(OUTCOME_CODES_OF) as TerminalState[],
);
export const OUTCOME_CODES = Object.freeze([
  ...OUTCOME_CODES_OF.completed,
  ...OUTCOME_CODES_OF.cancelled,
  ...OUTCOME_CODES_OF.no_show,
  ...OUTCOME_CODES_OF.technical_failure,
] as const);
export type OutcomeCode = (typeof OUTCOME_CODES)[number];

// What staff may record: for a Consultation that never started, and for a
// live one.
export const NEVER_STARTED_OUTCOME_CODES = Object.freeze([
  "client_no_show",
  "attorney_no_show",
  "both_no_show",
  "neither_connected",
] as const);
export const LIVE_OUTCOME_CODES = Object.freeze([
  "manual_resolution",
  "mid_consultation_failure",
] as const);
export const STAFF_OUTCOME_CODES = Object.freeze([
  ...NEVER_STARTED_OUTCOME_CODES,
  ...LIVE_OUTCOME_CODES,
] as const);
export type StaffOutcomeCode = (typeof STAFF_OUTCOME_CODES)[number];

// The database's own fixed outcomes.
export const CANCEL_OUTCOMES = Object.freeze([
  "cancelled",
  "invalid",
  "denied",
  "not_found",
  "already_cancelled",
  "ended",
  "in_progress",
  "configuration_unavailable",
]);
export const END_EARLY_OUTCOMES = Object.freeze([
  "completed",
  "invalid",
  "denied",
  "not_found",
  "not_started",
  "ended",
  "not_early",
  "configuration_unavailable",
  "conflict",
]);
export const RECORD_OUTCOMES = Object.freeze([
  "recorded",
  "invalid",
  "denied",
  "not_found",
  "already_decided",
  "not_applicable",
  "window_open",
  "window_unavailable",
  "evidence_conflict",
  "configuration_unavailable",
  "conflict",
]);

export const WINDOW_BASES = Object.freeze([
  "configured",
  "fail_safe",
  "unavailable",
] as const);
export type WindowBasis = (typeof WINDOW_BASES)[number];

export const EXCEPTION_STATUSES = Object.freeze(["open", "resolved"] as const);
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];
export const SEVERITIES = Object.freeze([
  "low",
  "medium",
  "high",
  "critical",
] as const);
export type Severity = (typeof SEVERITIES)[number];

export const CLIENT_LIST_COLUMNS = Object.freeze([
  "consultation_id",
  "state",
  "ready_due",
  "request_path",
  "modality",
  "duration_minutes",
  "booking_starts_at",
  "booking_ends_at",
  "opens_at",
  "closes_at",
  "started_at",
  "ended_at",
  "outcome_code",
]);

export const STALE_COLUMNS = Object.freeze([
  "consultation_id",
  "jurisdiction_id",
  "state",
  "request_path",
  "booking_starts_at",
  "booking_ends_at",
  "started_at",
  "closes_at",
  "window_basis",
  "attorney_joined",
  "client_joined",
  "both_present",
  "payment_state",
]);

export const STAFF_CONSULTATION_COLUMNS = Object.freeze([
  "consultation_id",
  "jurisdiction_id",
  "state",
  "outcome_code",
  "request_path",
  "duration_minutes",
  "booking_starts_at",
  "booking_ends_at",
  "started_at",
  "ended_at",
  "closes_at",
  "window_basis",
  "recordable",
  "attorney_joined",
  "client_joined",
  "both_present",
  "either_left",
  "provider_sessions",
  "interruptions",
  "payment_state",
  "open_exceptions",
]);

export const REVIEW_EXCEPTION_COLUMNS = Object.freeze([
  "exception_id",
  "exception_type",
  "severity",
  "status",
  "source_type",
  "source_id",
  "canonical_type",
  "canonical_id",
  "detected_at",
  "evidence_reference",
  "assigned",
  "assigned_to_me",
  "resolved_at",
  "resolution_notes",
]);

// The most Consultations the client's list holds (the database's own bound).
export const MAX_CLIENT_CONSULTATIONS = 200;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

// Request-scoped, unprivileged calls through the database's own functions.
// None takes an actor, User or profile.
export type ParticipantOutcomeReads = {
  // client_consultations()
  readonly clientList: () => Promise<RowsResult>;
  // deployment_environment_identity()
  readonly environmentIdentity: () => Promise<RowsResult>;
};

export type ParticipantOutcomeWrites = {
  // consultation_cancel(p_consultation_id)
  readonly cancel: (consultationId: string) => Promise<CommandAnswer>;
  // consultation_end_early(p_consultation_id)
  readonly endEarly: (consultationId: string) => Promise<CommandAnswer>;
};

type ParticipantShared = {
  readonly reads: () => Promise<ParticipantOutcomeReads | null>;
  readonly writes: () => Promise<ParticipantOutcomeWrites | null>;
  readonly environment: () => EnvironmentConfiguration;
  // One bounded worker run.
  readonly drain: () => Promise<void>;
};

export type ClientOutcomeSources = ParticipantShared & {
  readonly clientIntake: ClientIntakeSources;
};

export type AttorneyOutcomeSources = ParticipantShared & {
  readonly session: ServerSessionSource;
  readonly attorney: AttorneyPrincipalSource;
};

export type OperationsReads = {
  // staff_stale_consultations(p_offset)
  readonly stale: (offset: number) => Promise<RowsResult>;
  // staff_consultation(p_consultation_id)
  readonly consultation: (consultationId: string) => Promise<RowsResult>;
  // staff_review_exceptions(p_family, p_status, p_offset)
  readonly exceptions: (
    family: ReviewFamily,
    status: ExceptionStatus,
    offset: number,
  ) => Promise<RowsResult>;
  // deployment_environment_identity()
  readonly environmentIdentity: () => Promise<RowsResult>;
};

export type OperationsWrites = {
  // staff_record_consultation_outcome(p_consultation_id, p_outcome_code,
  // p_acknowledge_evidence_conflict)
  readonly recordOutcome: (
    consultationId: string,
    outcomeCode: StaffOutcomeCode,
    acknowledgeConflict: boolean,
  ) => Promise<CommandAnswer>;
};

// The two review item changes (the S7 functions, which since S11 decide by
// the item's own family): the payment adapter's ports.
export type ExceptionWrites = {
  readonly assignException: (
    exceptionId: string,
    assign: boolean,
  ) => Promise<CommandAnswer>;
  readonly resolveException: (
    exceptionId: string,
    notes: string,
  ) => Promise<CommandAnswer>;
};

export type OperationsSources = {
  // The staff configuration sources decide the verified staff identity and
  // the capability.
  readonly staff: ConfigurationSources;
  readonly reads: () => Promise<OperationsReads | null>;
  readonly writes: () => Promise<OperationsWrites | null>;
  readonly exceptionWrites: () => Promise<ExceptionWrites | null>;
  readonly environment: () => EnvironmentConfiguration;
  readonly drain: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// The client's Consultations
// ---------------------------------------------------------------------------

export type ClientConsultationEntry = {
  readonly id: string;
  readonly state: ConsultationState;
  // The database's own flag: a scheduled Consultation whose window has
  // opened.
  readonly readyDue: boolean;
  readonly path: "instant" | "scheduled";
  readonly modality: string;
  readonly durationMinutes: number | null;
  readonly bookingStart: string | null;
  readonly bookingEnd: string | null;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly outcomeCode: OutcomeCode | null;
};

const MODALITY = /^[a-z][a-z0-9_]{1,31}$/;

const nullableTime = (value: unknown): value is string | null =>
  value === null || isTimestamp(value);
const nullableId = (value: unknown): value is string | null =>
  value === null || isUuid(value);
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= 100000;
const isDuration = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 1 &&
  (value as number) <= 1440;

export function isTerminalState(state: string): state is TerminalState {
  return Object.hasOwn(OUTCOME_CODES_OF, state);
}

// Whether a state and an outcome code belong together: a decided
// Consultation carries one of its state's codes, an undecided one none.
function outcomeFits(state: ConsultationState, code: unknown): boolean {
  return isTerminalState(state)
    ? (OUTCOME_CODES_OF[state] as readonly unknown[]).includes(code)
    : code === null;
}

// One row of a participant's Consultation list read strictly (MVP-001 S11
// pass 2B: also the attorney's ended Consultations, which the database
// answers with the same columns).
export function readClientEntry(row: unknown): ClientConsultationEntry | null {
  const f = readExact(row, CLIENT_LIST_COLUMNS);
  if (f === null) {
    return null;
  }
  const id = f.get("consultation_id");
  const state = f.get("state");
  const readyDue = f.get("ready_due");
  const path = f.get("request_path");
  const modality = f.get("modality");
  const duration = f.get("duration_minutes");
  const bookingStart = f.get("booking_starts_at");
  const bookingEnd = f.get("booking_ends_at");
  const opensAt = f.get("opens_at");
  const closesAt = f.get("closes_at");
  const startedAt = f.get("started_at");
  const endedAt = f.get("ended_at");
  const outcomeCode = f.get("outcome_code");
  if (
    !isUuid(id) ||
    !isOneOf(CONSULTATION_STATES, state) ||
    typeof readyDue !== "boolean" ||
    (readyDue && state !== "scheduled") ||
    (path !== "instant" && path !== "scheduled") ||
    typeof modality !== "string" ||
    !MODALITY.test(modality) ||
    !(duration === null || isDuration(duration)) ||
    !nullableTime(bookingStart) ||
    !nullableTime(bookingEnd) ||
    (bookingStart === null) !== (bookingEnd === null) ||
    (bookingStart !== null && path !== "scheduled") ||
    !nullableTime(opensAt) ||
    !nullableTime(closesAt) ||
    (opensAt === null) !== (closesAt === null) ||
    !nullableTime(startedAt) ||
    !nullableTime(endedAt) ||
    (startedAt === null && state === "live") ||
    isTerminalState(state) !== (endedAt !== null) ||
    !outcomeFits(state, outcomeCode)
  ) {
    return null;
  }
  return Object.freeze({
    id,
    state,
    readyDue,
    path,
    modality,
    durationMinutes: duration,
    bookingStart,
    bookingEnd,
    opensAt,
    closesAt,
    startedAt,
    endedAt,
    outcomeCode: outcomeCode as OutcomeCode | null,
  });
}

// What the client sees: ready as soon as the server reports the window open.
export function clientDisplayStateOf(
  entry: Pick<ClientConsultationEntry, "state" | "readyDue">,
): ConsultationState {
  return entry.readyDue ? "ready" : entry.state;
}

export type ClientConsultationsView =
  | {
      readonly status: "ready";
      readonly entries: readonly ClientConsultationEntry[];
    }
  | Refusal;

// Every one of the client's own Consultations, current ones first, decided
// ones last. It never throws.
export async function resolveClientConsultations(
  sources: Pick<ClientOutcomeSources, "clientIntake" | "reads">,
): Promise<ClientConsultationsView> {
  try {
    const access = await admittedClient(sources.clientIntake);
    if (access !== "granted") {
      return access;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.clientList()));
    if (rows === null || rows.length > MAX_CLIENT_CONSULTATIONS) {
      return UNAVAILABLE;
    }
    const entries = readRows(rows, readClientEntry);
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

// ---------------------------------------------------------------------------
// What a Consultation page may offer (the database decides again)
// ---------------------------------------------------------------------------

// A participant may cancel only before the start: while the Consultation is
// created, scheduled or ready.
export function cancellable(state: ConsultationState): boolean {
  return state === "created" || state === "scheduled" || state === "ready";
}

// The nominal end the database uses for an early completion: the Booking's
// end (scheduled) or the start plus the requested duration (instant); null
// when it cannot be derived.
export function nominalEndOf(consultation: {
  readonly path: "instant" | "scheduled";
  readonly bookingEnd: string | null;
  readonly startedAt: string | null;
  readonly durationMinutes: number | null;
}): number | null {
  if (consultation.path === "scheduled") {
    return consultation.bookingEnd === null
      ? null
      : Date.parse(consultation.bookingEnd);
  }
  return consultation.startedAt === null ||
    consultation.durationMinutes === null
    ? null
    : Date.parse(consultation.startedAt) +
        consultation.durationMinutes * 60_000;
}

// Whether ending early by agreement is offered: a live Consultation before
// its nominal end.
export function earlyEndOffered(
  consultation: {
    readonly state: ConsultationState;
    readonly path: "instant" | "scheduled";
    readonly bookingEnd: string | null;
    readonly startedAt: string | null;
    readonly durationMinutes: number | null;
  },
  now: number,
): boolean {
  const nominalEnd = nominalEndOf(consultation);
  return (
    consultation.state === "live" && nominalEnd !== null && now < nominalEnd
  );
}

// ---------------------------------------------------------------------------
// Participant commands (server actions)
// ---------------------------------------------------------------------------

export const CANCEL_ACTION_OUTCOMES = Object.freeze([
  "consultation_cancelled",
  "not_found",
  "already_cancelled",
  "ended",
  "in_progress",
  "configuration_unavailable",
] as const);
export type CancelActionOutcome = (typeof CANCEL_ACTION_OUTCOMES)[number];
export type CancelActionState = ActionState<CancelActionOutcome>;
export const INITIAL_CANCEL_STATE: CancelActionState = IDLE;

export const END_EARLY_ACTION_OUTCOMES = Object.freeze([
  "consultation_completed_early",
  "not_found",
  "not_started",
  "ended",
  "not_early",
  "configuration_unavailable",
  "conflict",
] as const);
export type EndEarlyActionOutcome = (typeof END_EARLY_ACTION_OUTCOMES)[number];
export type EndEarlyActionState = ActionState<EndEarlyActionOutcome>;
export const INITIAL_END_EARLY_STATE: EndEarlyActionState = IDLE;

const CANCEL_TABLE: Readonly<Record<string, CancelActionOutcome>> =
  Object.freeze({
    cancelled: "consultation_cancelled",
    not_found: "not_found",
    already_cancelled: "already_cancelled",
    ended: "ended",
    in_progress: "in_progress",
    configuration_unavailable: "configuration_unavailable",
  });

const END_EARLY_TABLE: Readonly<Record<string, EndEarlyActionOutcome>> =
  Object.freeze({
    completed: "consultation_completed_early",
    not_found: "not_found",
    not_started: "not_started",
    ended: "ended",
    not_early: "not_early",
    configuration_unavailable: "configuration_unavailable",
    conflict: "conflict",
  });

// The one Consultation a form concerns: exactly one identifier, or null.
function consultationOfForm(formData: unknown): string | null {
  const value = formFieldsOf(formData, ["consultation"])?.get("consultation");
  return isUuid(value) ? value : null;
}

async function participantCommand<Outcome extends string>(
  sources: ParticipantShared,
  admit: () => Promise<Admission>,
  formData: unknown,
  call: (
    writes: ParticipantOutcomeWrites,
    consultationId: string,
  ) => Promise<CommandAnswer>,
  table: Readonly<Record<string, Outcome>>,
  notFound: Outcome,
  success: Outcome,
): Promise<ActionState<Outcome>> {
  try {
    const consultationId = consultationOfForm(formData);
    if (consultationId === null) {
      return outcomeState(notFound);
    }
    const access = await admit();
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
    const state = settle(
      await attempt(() => call(writes, consultationId)),
      table,
    );
    if (state.status === "outcome" && state.outcome === success) {
      await drainAfter(sources.drain);
    }
    return state;
  } catch {
    return UNAVAILABLE;
  }
}

// The client cancels one of their own Consultations before it starts. The
// database frees the Booking, closes the room, notifies the attorney and, with
// a live payment attempt, opens a review item: no money is moved here.
export async function cancelClientConsultation(
  sources: ClientOutcomeSources,
  formData: unknown,
): Promise<CancelActionState> {
  return participantCommand(
    sources,
    () => admittedClient(sources.clientIntake),
    formData,
    (writes, id) => writes.cancel(id),
    CANCEL_TABLE,
    "not_found",
    "consultation_cancelled",
  );
}

// The attorney cancels one of their own Consultations before it starts.
export async function cancelAttorneyConsultation(
  sources: AttorneyOutcomeSources,
  formData: unknown,
): Promise<CancelActionState> {
  return participantCommand(
    sources,
    () => admittedAttorney(sources.session, sources.attorney),
    formData,
    (writes, id) => writes.cancel(id),
    CANCEL_TABLE,
    "not_found",
    "consultation_cancelled",
  );
}

// The attorney records that a live Consultation ended early by agreement
// (before its nominal end). The client is told the recorded outcome.
export async function endConsultationEarly(
  sources: AttorneyOutcomeSources,
  formData: unknown,
): Promise<EndEarlyActionState> {
  return participantCommand(
    sources,
    () => admittedAttorney(sources.session, sources.attorney),
    formData,
    (writes, id) => writes.endEarly(id),
    END_EARLY_TABLE,
    "not_found",
    "consultation_completed_early",
  );
}

// ---------------------------------------------------------------------------
// Staff: the Consultations nobody decided
// ---------------------------------------------------------------------------

const NOT_FOUND = Object.freeze({ status: "not-found" } as const);

const UNDECIDED_STATES = Object.freeze([
  "created",
  "scheduled",
  "ready",
  "live",
] as const);

const nullablePaymentState = (value: unknown): value is PaymentState | null =>
  value === null || isOneOf(PAYMENT_STATES, value);

export type StaleConsultationRow = {
  readonly id: string;
  readonly jurisdictionId: string;
  readonly state: (typeof UNDECIDED_STATES)[number];
  readonly path: "instant" | "scheduled";
  readonly bookingStart: string | null;
  readonly bookingEnd: string | null;
  readonly startedAt: string | null;
  // Since when the outcome may be recorded, and on which basis.
  readonly recordableSince: string;
  readonly windowBasis: "configured" | "fail_safe";
  readonly attorneyJoined: boolean;
  readonly clientJoined: boolean;
  readonly bothPresent: boolean;
  readonly paymentState: PaymentState | null;
};

function readStaleRow(row: unknown): StaleConsultationRow | null {
  const f = readExact(row, STALE_COLUMNS);
  if (f === null) {
    return null;
  }
  const value = {
    id: f.get("consultation_id"),
    jurisdictionId: f.get("jurisdiction_id"),
    state: f.get("state"),
    path: f.get("request_path"),
    bookingStart: f.get("booking_starts_at"),
    bookingEnd: f.get("booking_ends_at"),
    startedAt: f.get("started_at"),
    recordableSince: f.get("closes_at"),
    windowBasis: f.get("window_basis"),
    attorneyJoined: f.get("attorney_joined"),
    clientJoined: f.get("client_joined"),
    bothPresent: f.get("both_present"),
    paymentState: f.get("payment_state"),
  };
  if (
    !isUuid(value.id) ||
    !isUuid(value.jurisdictionId) ||
    !isOneOf(UNDECIDED_STATES, value.state) ||
    !(value.path === "instant" || value.path === "scheduled") ||
    !nullableTime(value.bookingStart) ||
    !nullableTime(value.bookingEnd) ||
    (value.bookingStart === null) !== (value.bookingEnd === null) ||
    !nullableTime(value.startedAt) ||
    (value.state === "live") !== (value.startedAt !== null) ||
    !isTimestamp(value.recordableSince) ||
    !(
      value.windowBasis === "configured" || value.windowBasis === "fail_safe"
    ) ||
    typeof value.attorneyJoined !== "boolean" ||
    typeof value.clientJoined !== "boolean" ||
    typeof value.bothPresent !== "boolean" ||
    (value.bothPresent && !(value.attorneyJoined && value.clientJoined)) ||
    !nullablePaymentState(value.paymentState)
  ) {
    return null;
  }
  return Object.freeze(value) as StaleConsultationRow;
}

type OperationsContext = {
  readonly userId: string;
  // Whether the grant held is the global one (the review items need it).
  readonly global: boolean;
  readonly reads: OperationsReads;
};

async function operationsContext(
  sources: OperationsSources,
): Promise<OperationsContext | Refusal> {
  const staff = await verifiedStaffWithAny(
    sources.staff,
    OPERATIONS_CAPABILITY,
  );
  if (!("userId" in staff)) {
    return staff;
  }
  const reads = await portFrom(sources.reads);
  return reads === null
    ? UNAVAILABLE
    : { userId: staff.userId, global: staff.global, reads };
}

export type StaleConsultationsView =
  | {
      readonly status: "ready";
      readonly consultations: readonly StaleConsultationRow[];
      readonly pager: StaffPager;
      // Whether the caller may open the operations review items (a global
      // grant).
      readonly reviewItems: boolean;
    }
  | Refusal;

// One page of the Consultations nobody decided whose outcome may now be
// recorded, in the jurisdictions the caller holds the capability for.
export async function resolveStaleConsultations(
  sources: OperationsSources,
  pageValue: unknown,
): Promise<StaleConsultationsView> {
  try {
    const page = staffPageOf(pageValue);
    const context = await operationsContext(sources);
    if (!("userId" in context)) {
      return context;
    }
    const read = staffPageRows(
      rowsOf(await attempt(() => context.reads.stale(staffOffsetOf(page)))),
      readStaleRow,
      page,
    );
    return read === null
      ? UNAVAILABLE
      : Object.freeze({
          status: "ready",
          consultations: read.rows,
          pager: read.pager,
          reviewItems: context.global,
        });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Staff: one Consultation and its outcome
// ---------------------------------------------------------------------------

export type StaffConsultation = {
  readonly id: string;
  readonly jurisdictionId: string;
  readonly state: ConsultationState;
  readonly outcomeCode: OutcomeCode | null;
  readonly path: "instant" | "scheduled";
  readonly durationMinutes: number | null;
  readonly bookingStart: string | null;
  readonly bookingEnd: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  // Since when the outcome may be recorded (null when it cannot be derived)
  // and on which basis.
  readonly recordableSince: string | null;
  readonly windowBasis: WindowBasis;
  // The database's own answer for now; it decides again on submission.
  readonly recordable: boolean;
  // The attendance evidence summary: what the consultation room recorded.
  readonly attorneyJoined: boolean;
  readonly clientJoined: boolean;
  readonly bothPresent: boolean;
  readonly eitherLeft: boolean;
  readonly providerSessions: number;
  readonly interruptions: number;
  readonly paymentState: PaymentState | null;
  readonly openExceptions: number;
};

function readStaffConsultation(row: unknown): StaffConsultation | null {
  const f = readExact(row, STAFF_CONSULTATION_COLUMNS);
  if (f === null) {
    return null;
  }
  const value = {
    id: f.get("consultation_id"),
    jurisdictionId: f.get("jurisdiction_id"),
    state: f.get("state"),
    outcomeCode: f.get("outcome_code"),
    path: f.get("request_path"),
    durationMinutes: f.get("duration_minutes"),
    bookingStart: f.get("booking_starts_at"),
    bookingEnd: f.get("booking_ends_at"),
    startedAt: f.get("started_at"),
    endedAt: f.get("ended_at"),
    recordableSince: f.get("closes_at"),
    windowBasis: f.get("window_basis"),
    recordable: f.get("recordable"),
    attorneyJoined: f.get("attorney_joined"),
    clientJoined: f.get("client_joined"),
    bothPresent: f.get("both_present"),
    eitherLeft: f.get("either_left"),
    providerSessions: f.get("provider_sessions"),
    interruptions: f.get("interruptions"),
    paymentState: f.get("payment_state"),
    openExceptions: f.get("open_exceptions"),
  };
  if (
    !isUuid(value.id) ||
    !isUuid(value.jurisdictionId) ||
    !isOneOf(CONSULTATION_STATES, value.state) ||
    !outcomeFits(value.state, value.outcomeCode) ||
    !(value.path === "instant" || value.path === "scheduled") ||
    !(value.durationMinutes === null || isDuration(value.durationMinutes)) ||
    !nullableTime(value.bookingStart) ||
    !nullableTime(value.bookingEnd) ||
    (value.bookingStart === null) !== (value.bookingEnd === null) ||
    !nullableTime(value.startedAt) ||
    !nullableTime(value.endedAt) ||
    isTerminalState(value.state) !== (value.endedAt !== null) ||
    !nullableTime(value.recordableSince) ||
    !isOneOf(WINDOW_BASES, value.windowBasis) ||
    (value.windowBasis === "unavailable") !==
      (value.recordableSince === null) ||
    typeof value.recordable !== "boolean" ||
    (value.recordable &&
      (isTerminalState(value.state) || value.recordableSince === null)) ||
    typeof value.attorneyJoined !== "boolean" ||
    typeof value.clientJoined !== "boolean" ||
    typeof value.bothPresent !== "boolean" ||
    typeof value.eitherLeft !== "boolean" ||
    !isCount(value.providerSessions) ||
    !isCount(value.interruptions) ||
    !nullablePaymentState(value.paymentState) ||
    !isCount(value.openExceptions)
  ) {
    return null;
  }
  return Object.freeze(value) as StaffConsultation;
}

// The outcome codes staff may record for a Consultation in this state: none
// once it is decided.
export function recordableCodesOf(
  state: ConsultationState,
): readonly StaffOutcomeCode[] {
  if (state === "live") {
    return LIVE_OUTCOME_CODES;
  }
  return isTerminalState(state) ? [] : NEVER_STARTED_OUTCOME_CODES;
}

export type StaffConsultationView =
  | {
      readonly status: "ready";
      readonly consultation: StaffConsultation;
      // The codes offered now; empty when nothing may be recorded.
      readonly offeredCodes: readonly StaffOutcomeCode[];
      readonly reviewItems: boolean;
    }
  | typeof NOT_FOUND
  | Refusal;

// One Consultation for operations staff. A malformed id, an unknown one and
// one outside the caller's jurisdictions answer alike: not found.
export async function resolveStaffConsultation(
  sources: OperationsSources,
  consultationId: unknown,
): Promise<StaffConsultationView> {
  try {
    if (!isUuid(consultationId)) {
      return NOT_FOUND;
    }
    const context = await operationsContext(sources);
    if (!("userId" in context)) {
      return context;
    }
    const rows = rowsOf(
      await attempt(() => context.reads.consultation(consultationId)),
    );
    if (rows === null || rows.length > 1) {
      return UNAVAILABLE;
    }
    if (rows.length === 0) {
      return NOT_FOUND;
    }
    const consultation = readStaffConsultation(rows[0]);
    if (consultation === null || consultation.id !== consultationId) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      status: "ready",
      consultation,
      offeredCodes: consultation.recordable
        ? recordableCodesOf(consultation.state)
        : [],
      reviewItems: context.global,
    });
  } catch {
    return UNAVAILABLE;
  }
}

export const RECORD_ACTION_OUTCOMES = Object.freeze([
  "outcome_recorded",
  "not_found",
  "already_decided",
  "not_applicable",
  "window_open",
  "window_unavailable",
  "evidence_conflict",
  "configuration_unavailable",
  "conflict",
] as const);
export type RecordActionOutcome = (typeof RECORD_ACTION_OUTCOMES)[number];
export type RecordActionState = ActionState<RecordActionOutcome>;
export const INITIAL_RECORD_STATE: RecordActionState = IDLE;

const RECORD_TABLE: Readonly<Record<string, RecordActionOutcome>> =
  Object.freeze({
    recorded: "outcome_recorded",
    not_found: "not_found",
    already_decided: "already_decided",
    not_applicable: "not_applicable",
    window_open: "window_open",
    window_unavailable: "window_unavailable",
    evidence_conflict: "evidence_conflict",
    configuration_unavailable: "configuration_unavailable",
    conflict: "conflict",
  });

// Staff record the outcome of a Consultation nobody decided. The form names
// the Consultation and the outcome, and may carry the explicit
// acknowledgement that the outcome contradicts the attendance evidence; the
// database checks the capability for the Consultation's jurisdiction, the
// window rule and the evidence, and applies or surfaces every consequence.
export async function recordConsultationOutcome(
  sources: OperationsSources,
  formData: unknown,
): Promise<RecordActionState> {
  try {
    const fields = formFieldsOf(
      formData,
      ["consultation", "outcome"],
      ["acknowledge"],
    );
    const consultationId = fields?.get("consultation");
    const outcomeCode = fields?.get("outcome");
    const acknowledge = fields?.get("acknowledge");
    if (
      fields === null ||
      !isUuid(consultationId) ||
      !isOneOf(STAFF_OUTCOME_CODES, outcomeCode) ||
      !(acknowledge === undefined || acknowledge === "yes")
    ) {
      return INVALID;
    }
    const context = await operationsContext(sources);
    if (!("userId" in context)) {
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
    const state = settle(
      await attempt(() =>
        writes.recordOutcome(
          consultationId,
          outcomeCode,
          acknowledge === "yes",
        ),
      ),
      RECORD_TABLE,
    );
    if (state.status === "outcome" && state.outcome === "outcome_recorded") {
      await drainAfter(sources.drain);
    }
    return state;
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Staff: the operations and compliance review items
// ---------------------------------------------------------------------------

export type ReviewItem = {
  readonly id: string;
  readonly exceptionType: string;
  readonly severity: Severity;
  readonly status: ExceptionStatus;
  readonly sourceType: string;
  readonly sourceId: string | null;
  readonly canonicalType: string;
  readonly canonicalId: string | null;
  readonly detectedAt: string;
  // The evidence the database kept, as compact text (identifiers, states and
  // codes; never a message, a document or a provider payload).
  readonly evidence: string;
  readonly assigned: boolean;
  readonly assignedToMe: boolean;
  readonly resolvedAt: string | null;
  readonly resolutionNotes: string | null;
};

export function readReviewItem(row: unknown): ReviewItem | null {
  const f = readExact(row, REVIEW_EXCEPTION_COLUMNS);
  if (f === null) {
    return null;
  }
  const evidence = f.get("evidence_reference");
  const value = {
    id: f.get("exception_id"),
    exceptionType: f.get("exception_type"),
    severity: f.get("severity"),
    status: f.get("status"),
    sourceType: f.get("source_type"),
    sourceId: f.get("source_id"),
    canonicalType: f.get("canonical_type"),
    canonicalId: f.get("canonical_id"),
    detectedAt: f.get("detected_at"),
    assigned: f.get("assigned"),
    assignedToMe: f.get("assigned_to_me"),
    resolvedAt: f.get("resolved_at"),
    resolutionNotes: f.get("resolution_notes"),
  };
  if (
    !isUuid(value.id) ||
    !isCode(value.exceptionType) ||
    !isOneOf(SEVERITIES, value.severity) ||
    !isOneOf(EXCEPTION_STATUSES, value.status) ||
    !isCode(value.sourceType) ||
    !nullableId(value.sourceId) ||
    !isCode(value.canonicalType) ||
    !nullableId(value.canonicalId) ||
    !isTimestamp(value.detectedAt) ||
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    typeof value.assigned !== "boolean" ||
    typeof value.assignedToMe !== "boolean" ||
    (value.assignedToMe && !value.assigned) ||
    !nullableTime(value.resolvedAt) ||
    !(
      value.resolutionNotes === null ||
      typeof value.resolutionNotes === "string"
    ) ||
    (value.status === "resolved") !== (value.resolvedAt !== null)
  ) {
    return null;
  }
  let text: string;
  try {
    text = JSON.stringify(evidence);
  } catch {
    return null;
  }
  return Object.freeze({
    ...value,
    evidence: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
  }) as ReviewItem;
}

export function exceptionStatusOf(value: unknown): ExceptionStatus {
  return isOneOf(EXCEPTION_STATUSES, value) ? value : "open";
}

// The review items need the family capability's global grant, exactly as the
// database's own functions do.
async function reviewItemsContext(
  sources: OperationsSources,
  family: ReviewFamily,
): Promise<
  { readonly userId: string; readonly reads: OperationsReads } | Refusal
> {
  const staff = await verifiedStaffWith(
    sources.staff,
    FAMILY_CAPABILITIES[family],
  );
  if (!("userId" in staff)) {
    return staff;
  }
  const reads = await portFrom(sources.reads);
  return reads === null ? UNAVAILABLE : { userId: staff.userId, reads };
}

export type FamilyExceptionsView =
  | {
      readonly status: "ready";
      readonly family: ReviewFamily;
      readonly exceptionStatus: ExceptionStatus;
      readonly exceptions: readonly ReviewItem[];
      readonly pager: StaffPager;
    }
  | Refusal;

// One page of one family's review items, open or resolved: the operations
// family (consultation room discrepancies and undelivered notifications) or
// the compliance family (eligibility and jurisdiction change reviews).
export async function resolveFamilyExceptions(
  sources: OperationsSources,
  family: ReviewFamily,
  statusValue: unknown,
  pageValue: unknown,
): Promise<FamilyExceptionsView> {
  try {
    const exceptionStatus = exceptionStatusOf(statusValue);
    const page = staffPageOf(pageValue);
    const context = await reviewItemsContext(sources, family);
    if (!("userId" in context)) {
      return context;
    }
    const read = staffPageRows(
      rowsOf(
        await attempt(() =>
          context.reads.exceptions(
            family,
            exceptionStatus,
            staffOffsetOf(page),
          ),
        ),
      ),
      readReviewItem,
      page,
    );
    return read === null
      ? UNAVAILABLE
      : Object.freeze({
          status: "ready",
          family,
          exceptionStatus,
          exceptions: read.rows,
          pager: read.pager,
        });
  } catch {
    return UNAVAILABLE;
  }
}

export const REVIEW_ITEM_ACTION_OUTCOMES = Object.freeze([
  "applied",
  "not_found",
  "invalid_transition",
] as const);
export type ReviewItemActionOutcome =
  (typeof REVIEW_ITEM_ACTION_OUTCOMES)[number];
export type ReviewItemActionState = ActionState<ReviewItemActionOutcome>;
export const INITIAL_REVIEW_ITEM_STATE: ReviewItemActionState = IDLE;

const REVIEW_ITEM_TABLE: Readonly<Record<string, ReviewItemActionOutcome>> =
  Object.freeze({
    applied: "applied",
    not_found: "not_found",
    invalid_transition: "invalid_transition",
  });

async function reviewItemChange(
  sources: OperationsSources,
  family: ReviewFamily,
  call: (writes: ExceptionWrites) => Promise<CommandAnswer>,
): Promise<ReviewItemActionState> {
  const context = await reviewItemsContext(sources, family);
  if (!("userId" in context)) {
    return context;
  }
  const writes = await portFrom(sources.exceptionWrites);
  if (writes === null) {
    return UNAVAILABLE;
  }
  return settle(await attempt(() => call(writes)), REVIEW_ITEM_TABLE);
}

// Assigns an open review item of the family to the caller, or clears its
// assignment. The database answers another family's item like an unknown one.
export async function assignFamilyException(
  sources: OperationsSources,
  family: ReviewFamily,
  formData: unknown,
): Promise<ReviewItemActionState> {
  try {
    const fields = formFieldsOf(formData, ["exception", "assign"]);
    const exceptionId = fields?.get("exception");
    const assign = fields?.get("assign");
    if (!isUuid(exceptionId) || (assign !== "me" && assign !== "nobody")) {
      return INVALID;
    }
    return await reviewItemChange(sources, family, (writes) =>
      writes.assignException(exceptionId, assign === "me"),
    );
  } catch {
    return UNAVAILABLE;
  }
}

// Resolves an open review item of the family once, with the staff member's
// notes.
export async function resolveFamilyException(
  sources: OperationsSources,
  family: ReviewFamily,
  formData: unknown,
): Promise<ReviewItemActionState> {
  try {
    const fields = formFieldsOf(formData, ["exception", "notes"]);
    const exceptionId = fields?.get("exception");
    const notes = textField(fields?.get("notes"), 2000);
    if (!isUuid(exceptionId) || notes === null || notes === "") {
      return INVALID;
    }
    return await reviewItemChange(sources, family, (writes) =>
      writes.resolveException(exceptionId, notes),
    );
  } catch {
    return UNAVAILABLE;
  }
}

export function clientConsultationsPath(): string {
  return "/client/consultations";
}

export function staffConsultationPathFor(consultationId: string): string {
  if (!isUuid(consultationId)) {
    throw new Error("not a consultation identifier");
  }
  return `/staff/consultations/${consultationId}`;
}
