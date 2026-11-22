// The Complaint foundation (MVP-001 S11; MBS section 16 "Complaint
// foundation"; PS sections 27.1 and 30.4; TA sections 40 and 41; MB sections
// 120 to 122; PM row 47 and INV-14).
//
// Provider-neutral and injectable: each request hands in its own ports. A
// client (through the verified client of the request) or an attorney
// (through the unchanged Security Shell) reports a problem, optionally about
// one of their own Consultations; the complainant is always the caller and
// the jurisdiction is derived by the database. Opening a case changes nothing
// else: the Consultation, the payment and the evidence stay exactly as they
// are (PM row 47). The record is restricted: the complainant sees only their
// own cases (state, linkage and instants), the other participant sees
// nothing, and staff holding manage_complaints see the minimum metadata for
// the jurisdictions they hold. Staff assign, unassign, escalate and return a
// case; classification and resolution use the complaint vocabulary the
// database selects for the case (PS-A6 section 4: configuration, a Complaint
// policy version; while none is selectable the database answers
// configuration_unavailable and changes nothing), and the case page offers
// exactly its codes. PS-A6 section 5: the complainant may describe the
// problem in an optional statement (at most 20,000 characters), written once
// and restricted as the case is: the complainant sees their own and staff in
// scope see it on the case, never in a list. Every step is audited by the
// database (never the statement). Reads are strict.

import type { AttorneyPrincipalSource } from "./attorney-access.ts";
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
  verifiedStaffWithAny,
  type ConfigurationSources,
} from "./staff-configuration.ts";
import {
  admittedAttorney,
  admittedClient,
  environmentBound,
  formFieldsOf,
  IDLE,
  INVALID,
  isCode,
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

export const COMPLAINTS_CAPABILITY = "manage_complaints";

export const COMPLAINT_STATES = Object.freeze([
  "opened",
  "in_review",
  "escalated",
  "resolved",
] as const);
export type ComplaintState = (typeof COMPLAINT_STATES)[number];

export const COMPLAINANT_ROLES = Object.freeze(["client", "attorney"] as const);
export type ComplainantRole = (typeof COMPLAINANT_ROLES)[number];

export const CASE_ACTIONS = Object.freeze([
  "assign",
  "unassign",
  "escalate",
  "return_to_review",
] as const);
export type CaseAction = (typeof CASE_ACTIONS)[number];

export const OPEN_OUTCOMES = Object.freeze([
  "opened",
  "invalid",
  "denied",
  "not_found",
  "already_open",
]);
export const UPDATE_OUTCOMES = Object.freeze([
  "applied",
  "invalid",
  "denied",
  "not_found",
  "invalid_transition",
]);
export const DECIDE_OUTCOMES = Object.freeze([
  ...UPDATE_OUTCOMES,
  "configuration_unavailable",
  "invalid_code",
]);

const BASE_CASE_COLUMNS = Object.freeze([
  "complaint_case_id",
  "state",
  "consultation_id",
  "referral_id",
  "opened_at",
  "resolved_at",
]);
// PS-A6 section 5: the complainant's own cases carry their statement.
export const OWN_CASE_COLUMNS = Object.freeze([
  ...BASE_CASE_COLUMNS,
  "statement",
]);
export const QUEUE_COLUMNS = Object.freeze([
  "complaint_case_id",
  "jurisdiction_id",
  "state",
  "consultation_id",
  "referral_id",
  "opened_at",
  "resolved_at",
  "assigned_to_me",
]);
export const CASE_COLUMNS = Object.freeze([
  "complaint_case_id",
  "jurisdiction_id",
  "state",
  "category_code",
  "resolution_code",
  "opened_at",
  "resolved_at",
  "assigned_to_me",
  "complainant_role",
  "consultation_id",
  "consultation_state",
  "consultation_outcome_code",
  "referral_id",
  "referral_outcome_code",
  "attorney_joined",
  "client_joined",
  "both_present",
  "either_left",
  "payment_state",
  "active_legal_holds",
  // PS-A6 sections 4 and 5: the statement and the codes of the vocabulary
  // that governs the case now.
  "statement",
  "category_codes",
  "resolution_codes",
]);

// The database's own bound on the complainant's list.
export const MAX_OWN_CASES = 200;

// PS-A6 section 5: the statement's ceiling (the PS-A1 client free-text
// ceiling).
export const MAX_STATEMENT = 20000;
// A configured code list's bound as the case page reads it.
const MAX_CODES = 500;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type ComplaintReads = {
  // complaint_cases_mine()
  readonly mine: () => Promise<RowsResult>;
  // staff_complaint_queue(p_state, p_offset)
  readonly queue: (
    state: ComplaintState,
    offset: number,
  ) => Promise<RowsResult>;
  // staff_complaint_case(p_complaint_case_id)
  readonly complaintCase: (caseId: string) => Promise<RowsResult>;
  // deployment_environment_identity()
  readonly environmentIdentity: () => Promise<RowsResult>;
};

export type ComplaintWrites = {
  // complaint_open(p_consultation_id, p_referral_id, p_statement)
  readonly open: (
    consultationId: string | null,
    referralId: string | null,
    statement: string | null,
  ) => Promise<CommandAnswer>;
  // staff_update_complaint(p_complaint_case_id, p_action)
  readonly update: (
    caseId: string,
    action: CaseAction,
  ) => Promise<CommandAnswer>;
  // staff_classify_complaint(p_complaint_case_id, p_category_code)
  readonly classify: (caseId: string, code: string) => Promise<CommandAnswer>;
  // staff_resolve_complaint(p_complaint_case_id, p_resolution_code)
  readonly resolve: (caseId: string, code: string) => Promise<CommandAnswer>;
};

type Shared = {
  readonly reads: () => Promise<ComplaintReads | null>;
  readonly writes: () => Promise<ComplaintWrites | null>;
  readonly environment: () => EnvironmentConfiguration;
};

export type ClientComplaintSources = Shared & {
  readonly clientIntake: ClientIntakeSources;
};

export type AttorneyComplaintSources = Shared & {
  readonly session: ServerSessionSource;
  readonly attorney: AttorneyPrincipalSource;
};

export type StaffComplaintSources = Shared & {
  readonly staff: ConfigurationSources;
};

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

const nullableTime = (value: unknown): value is string | null =>
  value === null || isTimestamp(value);
const nullableId = (value: unknown): value is string | null =>
  value === null || isUuid(value);
const nullableCode = (value: unknown): value is string | null =>
  value === null || isCode(value);
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= 100000;

type ComplaintBase = {
  readonly id: string;
  readonly state: ComplaintState;
  readonly consultationId: string | null;
  readonly referralId: string | null;
  readonly openedAt: string;
  readonly resolvedAt: string | null;
};

export type OwnComplaint = ComplaintBase & {
  readonly statement: string | null;
};

const isStatement = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= MAX_STATEMENT);

function readOwn(row: unknown): OwnComplaint | null {
  const f = readExact(row, OWN_CASE_COLUMNS);
  if (f === null) {
    return null;
  }
  const base = readBase({
    complaint_case_id: f.get("complaint_case_id"),
    state: f.get("state"),
    consultation_id: f.get("consultation_id"),
    referral_id: f.get("referral_id"),
    opened_at: f.get("opened_at"),
    resolved_at: f.get("resolved_at"),
  });
  const statement = f.get("statement");
  if (base === null || !isStatement(statement)) {
    return null;
  }
  return Object.freeze({ ...base, statement });
}

function readBase(row: unknown): ComplaintBase | null {
  const f = readExact(row, BASE_CASE_COLUMNS);
  if (f === null) {
    return null;
  }
  const value = {
    id: f.get("complaint_case_id"),
    state: f.get("state"),
    consultationId: f.get("consultation_id"),
    referralId: f.get("referral_id"),
    openedAt: f.get("opened_at"),
    resolvedAt: f.get("resolved_at"),
  };
  if (
    !isUuid(value.id) ||
    !isOneOf(COMPLAINT_STATES, value.state) ||
    !nullableId(value.consultationId) ||
    !nullableId(value.referralId) ||
    !isTimestamp(value.openedAt) ||
    !nullableTime(value.resolvedAt) ||
    (value.state === "resolved") !== (value.resolvedAt !== null)
  ) {
    return null;
  }
  return Object.freeze(value) as ComplaintBase;
}

export type QueuedComplaint = ComplaintBase & {
  readonly jurisdictionId: string | null;
  readonly assignedToMe: boolean;
};

function readQueued(row: unknown): QueuedComplaint | null {
  const f = readExact(row, QUEUE_COLUMNS);
  if (f === null) {
    return null;
  }
  const own = readBase({
    complaint_case_id: f.get("complaint_case_id"),
    state: f.get("state"),
    consultation_id: f.get("consultation_id"),
    referral_id: f.get("referral_id"),
    opened_at: f.get("opened_at"),
    resolved_at: f.get("resolved_at"),
  });
  const jurisdictionId = f.get("jurisdiction_id");
  const assignedToMe = f.get("assigned_to_me");
  if (
    own === null ||
    !nullableId(jurisdictionId) ||
    typeof assignedToMe !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({ ...own, jurisdictionId, assignedToMe });
}

export type StaffComplaintCase = QueuedComplaint & {
  readonly categoryCode: string | null;
  readonly resolutionCode: string | null;
  readonly complainantRole: ComplainantRole;
  readonly consultationState: string | null;
  readonly consultationOutcomeCode: string | null;
  readonly referralOutcomeCode: string | null;
  readonly attorneyJoined: boolean;
  readonly clientJoined: boolean;
  readonly bothPresent: boolean;
  readonly eitherLeft: boolean;
  readonly paymentState: PaymentState | null;
  readonly activeLegalHolds: number;
  readonly statement: string | null;
  readonly categoryCodes: readonly string[];
  readonly resolutionCodes: readonly string[];
};

// A configured code list: distinct lower-snake codes (empty while no
// vocabulary is selectable).
function codesOf(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > MAX_CODES ||
    !value.every((code) => isCode(code)) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return Object.freeze([...(value as string[])]);
}

function readCase(row: unknown): StaffComplaintCase | null {
  const f = readExact(row, CASE_COLUMNS);
  if (f === null) {
    return null;
  }
  const queued = readQueued({
    complaint_case_id: f.get("complaint_case_id"),
    jurisdiction_id: f.get("jurisdiction_id"),
    state: f.get("state"),
    consultation_id: f.get("consultation_id"),
    referral_id: f.get("referral_id"),
    opened_at: f.get("opened_at"),
    resolved_at: f.get("resolved_at"),
    assigned_to_me: f.get("assigned_to_me"),
  });
  const value = {
    categoryCode: f.get("category_code"),
    resolutionCode: f.get("resolution_code"),
    complainantRole: f.get("complainant_role"),
    consultationState: f.get("consultation_state"),
    consultationOutcomeCode: f.get("consultation_outcome_code"),
    referralOutcomeCode: f.get("referral_outcome_code"),
    attorneyJoined: f.get("attorney_joined"),
    clientJoined: f.get("client_joined"),
    bothPresent: f.get("both_present"),
    eitherLeft: f.get("either_left"),
    paymentState: f.get("payment_state"),
    activeLegalHolds: f.get("active_legal_holds"),
    statement: f.get("statement"),
  };
  const categoryCodes = codesOf(f.get("category_codes"));
  const resolutionCodes = codesOf(f.get("resolution_codes"));
  if (
    queued === null ||
    !nullableCode(value.categoryCode) ||
    !nullableCode(value.resolutionCode) ||
    !isOneOf(COMPLAINANT_ROLES, value.complainantRole) ||
    !nullableCode(value.consultationState) ||
    (value.consultationState === null) !== (queued.consultationId === null) ||
    !nullableCode(value.consultationOutcomeCode) ||
    !nullableCode(value.referralOutcomeCode) ||
    typeof value.attorneyJoined !== "boolean" ||
    typeof value.clientJoined !== "boolean" ||
    typeof value.bothPresent !== "boolean" ||
    typeof value.eitherLeft !== "boolean" ||
    !(
      value.paymentState === null || isOneOf(PAYMENT_STATES, value.paymentState)
    ) ||
    !isCount(value.activeLegalHolds) ||
    !isStatement(value.statement) ||
    categoryCodes === null ||
    resolutionCodes === null
  ) {
    return null;
  }
  return Object.freeze({
    ...queued,
    ...value,
    categoryCodes,
    resolutionCodes,
  }) as StaffComplaintCase;
}

// ---------------------------------------------------------------------------
// The complainant's cases and intake
// ---------------------------------------------------------------------------

export type OwnComplaintsView =
  | { readonly status: "ready"; readonly cases: readonly OwnComplaint[] }
  | Refusal;

async function ownComplaints(
  admit: () => Promise<Admission>,
  readsSource: Shared["reads"],
): Promise<OwnComplaintsView> {
  try {
    const access = await admit();
    if (access !== "granted") {
      return access;
    }
    const reads = await portFrom(readsSource);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.mine()));
    if (rows === null || rows.length > MAX_OWN_CASES) {
      return UNAVAILABLE;
    }
    const cases = readRows(rows, readOwn);
    return cases === null
      ? UNAVAILABLE
      : Object.freeze({ status: "ready", cases });
  } catch {
    return UNAVAILABLE;
  }
}

export function resolveClientComplaints(
  sources: Pick<ClientComplaintSources, "clientIntake" | "reads">,
): Promise<OwnComplaintsView> {
  return ownComplaints(
    () => admittedClient(sources.clientIntake),
    sources.reads,
  );
}

export function resolveAttorneyComplaints(
  sources: Pick<AttorneyComplaintSources, "session" | "attorney" | "reads">,
): Promise<OwnComplaintsView> {
  return ownComplaints(
    () => admittedAttorney(sources.session, sources.attorney),
    sources.reads,
  );
}

export const OPEN_ACTION_OUTCOMES = Object.freeze([
  "complaint_opened",
  "not_found",
  "already_open",
] as const);
export type OpenActionOutcome = (typeof OPEN_ACTION_OUTCOMES)[number];
export type OpenActionState = ActionState<OpenActionOutcome>;
export const INITIAL_OPEN_STATE: OpenActionState = IDLE;

const OPEN_TABLE: Readonly<Record<string, OpenActionOutcome>> = Object.freeze({
  opened: "complaint_opened",
  not_found: "not_found",
  already_open: "already_open",
});

async function openComplaint(
  sources: Shared,
  admit: () => Promise<Admission>,
  formData: unknown,
): Promise<OpenActionState> {
  try {
    // The form may name one of the caller's own Consultations (an empty value
    // means none) and carry the caller's optional statement (PS-A6 section
    // 5; an empty one means none); nothing else is sent.
    const fields = formFieldsOf(formData, [], ["consultation", "statement"]);
    const consultation = fields?.get("consultation") ?? "";
    const statement = textField(fields?.get("statement"), MAX_STATEMENT);
    if (
      fields === null ||
      !(consultation === "" || isUuid(consultation)) ||
      statement === null
    ) {
      return INVALID;
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
    return settle(
      await attempt(() =>
        writes.open(
          consultation === "" ? null : consultation,
          null,
          statement === "" ? null : statement,
        ),
      ),
      OPEN_TABLE,
    );
  } catch {
    return UNAVAILABLE;
  }
}

// The client reports a problem, optionally about one of their own
// Consultations.
export function openClientComplaint(
  sources: ClientComplaintSources,
  formData: unknown,
): Promise<OpenActionState> {
  return openComplaint(
    sources,
    () => admittedClient(sources.clientIntake),
    formData,
  );
}

// The attorney reports a problem, optionally about one of their own
// Consultations.
export function openAttorneyComplaint(
  sources: AttorneyComplaintSources,
  formData: unknown,
): Promise<OpenActionState> {
  return openComplaint(
    sources,
    () => admittedAttorney(sources.session, sources.attorney),
    formData,
  );
}

// ---------------------------------------------------------------------------
// The staff complaint workspace
// ---------------------------------------------------------------------------

export function complaintStateOf(value: unknown): ComplaintState {
  return isOneOf(COMPLAINT_STATES, value) ? value : "opened";
}

async function staffContext(
  sources: StaffComplaintSources,
): Promise<{ readonly reads: ComplaintReads } | Refusal> {
  const staff = await verifiedStaffWithAny(
    sources.staff,
    COMPLAINTS_CAPABILITY,
  );
  if (!("userId" in staff)) {
    return staff;
  }
  const reads = await portFrom(sources.reads);
  return reads === null ? UNAVAILABLE : { reads };
}

export type ComplaintQueueView =
  | {
      readonly status: "ready";
      readonly complaintState: ComplaintState;
      readonly cases: readonly QueuedComplaint[];
      readonly pager: StaffPager;
    }
  | Refusal;

export async function resolveComplaintQueue(
  sources: StaffComplaintSources,
  stateValue: unknown,
  pageValue: unknown,
): Promise<ComplaintQueueView> {
  try {
    const complaintState = complaintStateOf(stateValue);
    const page = staffPageOf(pageValue);
    const context = await staffContext(sources);
    if (!("reads" in context)) {
      return context;
    }
    const read = staffPageRows(
      rowsOf(
        await attempt(() =>
          context.reads.queue(complaintState, staffOffsetOf(page)),
        ),
      ),
      readQueued,
      page,
    );
    if (
      read === null ||
      read.rows.some((row) => row.state !== complaintState)
    ) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      status: "ready",
      complaintState,
      cases: read.rows,
      pager: read.pager,
    });
  } catch {
    return UNAVAILABLE;
  }
}

const NOT_FOUND = Object.freeze({ status: "not-found" } as const);

export type ComplaintCaseView =
  | { readonly status: "ready"; readonly complaintCase: StaffComplaintCase }
  | typeof NOT_FOUND
  | Refusal;

// One case for complaint staff. A malformed id, an unknown one and one
// outside the caller's jurisdictions answer alike: not found.
export async function resolveComplaintCase(
  sources: StaffComplaintSources,
  caseId: unknown,
): Promise<ComplaintCaseView> {
  try {
    if (!isUuid(caseId)) {
      return NOT_FOUND;
    }
    const context = await staffContext(sources);
    if (!("reads" in context)) {
      return context;
    }
    const rows = rowsOf(
      await attempt(() => context.reads.complaintCase(caseId)),
    );
    if (rows === null || rows.length > 1) {
      return UNAVAILABLE;
    }
    if (rows.length === 0) {
      return NOT_FOUND;
    }
    const complaintCase = readCase(rows[0]);
    return complaintCase === null || complaintCase.id !== caseId
      ? UNAVAILABLE
      : Object.freeze({ status: "ready", complaintCase });
  } catch {
    return UNAVAILABLE;
  }
}

export const CASE_ACTION_OUTCOMES = Object.freeze([
  "applied",
  "not_found",
  "invalid_transition",
  "configuration_unavailable",
  "invalid_code",
] as const);
export type CaseActionOutcome = (typeof CASE_ACTION_OUTCOMES)[number];
export type CaseActionState = ActionState<CaseActionOutcome>;
export const INITIAL_CASE_STATE: CaseActionState = IDLE;

const CASE_TABLE: Readonly<Record<string, CaseActionOutcome>> = Object.freeze({
  applied: "applied",
  not_found: "not_found",
  invalid_transition: "invalid_transition",
  configuration_unavailable: "configuration_unavailable",
  invalid_code: "invalid_code",
});

async function caseChange(
  sources: StaffComplaintSources,
  call: (writes: ComplaintWrites) => Promise<CommandAnswer>,
): Promise<CaseActionState> {
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
  return settle(await attempt(() => call(writes)), CASE_TABLE);
}

// Staff assign a case to themselves, unassign it, escalate it or return it to
// review.
export async function updateComplaintCase(
  sources: StaffComplaintSources,
  formData: unknown,
): Promise<CaseActionState> {
  try {
    const fields = formFieldsOf(formData, ["case", "action"]);
    const caseId = fields?.get("case");
    const action = fields?.get("action");
    if (!isUuid(caseId) || !isOneOf(CASE_ACTIONS, action)) {
      return INVALID;
    }
    return await caseChange(sources, (writes) => writes.update(caseId, action));
  } catch {
    return UNAVAILABLE;
  }
}

// Classification and resolution: a code of the complaint vocabulary, which is
// configuration (PS-A6 section 4). While none is selectable the database
// answers configuration_unavailable and changes nothing.
async function decideCase(
  sources: StaffComplaintSources,
  formData: unknown,
  call: (
    writes: ComplaintWrites,
    caseId: string,
    code: string,
  ) => Promise<CommandAnswer>,
): Promise<CaseActionState> {
  try {
    const fields = formFieldsOf(formData, ["case", "code"]);
    const caseId = fields?.get("case");
    const code = fields?.get("code")?.trim();
    if (!isUuid(caseId) || !isCode(code)) {
      return INVALID;
    }
    return await caseChange(sources, (writes) => call(writes, caseId, code));
  } catch {
    return UNAVAILABLE;
  }
}

export function classifyComplaintCase(
  sources: StaffComplaintSources,
  formData: unknown,
): Promise<CaseActionState> {
  return decideCase(sources, formData, (writes, caseId, code) =>
    writes.classify(caseId, code),
  );
}

export function resolveComplaintCaseCommand(
  sources: StaffComplaintSources,
  formData: unknown,
): Promise<CaseActionState> {
  return decideCase(sources, formData, (writes, caseId, code) =>
    writes.resolve(caseId, code),
  );
}

export function staffComplaintPathFor(caseId: string): string {
  if (!isUuid(caseId)) {
    throw new Error("not a complaint case identifier");
  }
  return `/staff/complaints/${caseId}`;
}
