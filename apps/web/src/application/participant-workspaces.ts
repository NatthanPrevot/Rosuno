// The participants' own workspace surfaces (MVP-001 S11 pass 2B; MBS
// sections 18.2 "client workspace", 18.3 "attorney workspace" and 18.6; IMP
// section 38).
//
// Provider-neutral and injectable: each request hands in its own ports. The
// client's payment history, account overview and Message threads, and the
// attorney's Message threads, ended Consultations, documents and compliance
// records are each one database read of the caller's own records only (the
// database decides the caller from the request's own session; no read takes
// an identifier). The dashboards and the week view reuse the existing use
// cases and reads unchanged and only summarize what they answer.
//
// Nothing here decides anything the database decides: every answer is read
// strictly (an unexpected column, value or combination makes the whole
// answer unavailable), every refusal is the fixed one of the workspace, and
// no threshold, lead time or business rule is applied. A summary counts and
// orders what the reads answered and nothing more.

import type { AttorneyPrincipalSource } from "./attorney-access.ts";
import type {
  AttorneyProfessionalSources,
  ProfessionalSetupView,
} from "./attorney-professional.ts";
import { resolveProfessionalSetup } from "./attorney-professional.ts";
import type { AttorneyQueueView } from "./attorney-requests.ts";
import {
  CALENDAR_DAYS,
  readCalendarEntry,
  type AttorneyScheduleSources,
  type CalendarEntry,
  type ScheduleView,
} from "./attorney-schedule.ts";
import type { EarningsView } from "./client-payments.ts";
import type { ClientIntakeSources } from "./client-intake.ts";
import type { OwnComplaintsView } from "./complaints.ts";
import {
  clientDisplayStateOf,
  isTerminalState,
  readClientEntry,
  type ClientConsultationEntry,
  type ClientConsultationsView,
} from "./consultation-outcomes.ts";
import type {
  ConsultationEntry,
  ConsultationListView,
} from "./consultations.ts";
import type { CenterView } from "./notification-center.ts";
import {
  isAmountMinor,
  isCurrencyCode,
  PAYMENT_STATES,
  type PaymentState,
} from "./payments.ts";
import {
  attempt,
  portFrom,
  rowsOf,
  UNAVAILABLE,
  type Refusal,
  type RowsResult,
} from "./professional-identity.ts";
import {
  ACCOUNT_STATES,
  isDate,
  isOneOf,
  isTimestamp,
  isUuid,
  readExact,
  readRows,
  type AccountState,
} from "./professional-records.ts";
import {
  ARTIFACT_TYPES,
  RESOURCE_BYTE_CEILING,
} from "./protected-resources.ts";
import type { ArtifactType } from "./protected-resources.ts";
import type { ServerSessionSource } from "./session.ts";
import {
  admittedAttorney,
  admittedClient,
  isCode,
  staffOffsetOf,
  staffPageOf,
  staffPageRows,
  type StaffPager,
} from "./workspace-support.ts";

// ---------------------------------------------------------------------------
// Vocabulary and ports
// ---------------------------------------------------------------------------

export const CLIENT_PAYMENT_COLUMNS = Object.freeze([
  "payment_transaction_id",
  "consultation_request_id",
  "payment_state",
  "total_client_amount_minor",
  "currency_code",
  "amount_authorized_minor",
  "amount_captured_minor",
  "amount_refunded_minor",
  "created_at",
]);

// The categories of records the account overview counts, in its order.
export const DATA_CATEGORIES = Object.freeze([
  "intakes",
  "requests",
  "consultations",
  "documents",
  "messages",
  "payments",
  "complaints",
] as const);
export type DataCategory = (typeof DATA_CATEGORIES)[number];

export const ACCOUNT_OVERVIEW_COLUMNS = Object.freeze([
  "display_name",
  "account_state",
  "created_at",
  ...DATA_CATEGORIES,
]);

export const THREAD_ROLES = Object.freeze(["client", "attorney"] as const);
export type ThreadRole = (typeof THREAD_ROLES)[number];

// What the communication window reports now (anything else reads as
// window_unavailable in the database).
export const MESSAGING_STATUSES = Object.freeze([
  "open",
  "closed",
  "window_unavailable",
] as const);
export type MessagingStatus = (typeof MESSAGING_STATUSES)[number];

export const THREAD_COLUMNS = Object.freeze([
  "consultation_id",
  "consultation_state",
  "messaging_status",
  "message_count",
  "last_message_at",
  "last_message_mine",
]);

export const ATTORNEY_DOCUMENT_COLUMNS = Object.freeze([
  "consultation_id",
  "document_id",
  "version_label",
  "mime_type",
  "byte_size",
  "created_at",
  "uploaded_by",
  "mine",
  "sharing",
  "accessible",
]);

export const RECORD_KINDS = Object.freeze([
  "license",
  "insurance",
  "discipline",
] as const);
export type RecordKind = (typeof RECORD_KINDS)[number];

export const COMPLIANCE_RECORD_COLUMNS = Object.freeze([
  "record_kind",
  "record_id",
  "jurisdiction_id",
  "status_code",
  "starts_on",
  "ends_on",
  "evidence_lapses_on",
  "recorded_at",
]);

// The bounds the database answers within (the history, threads and documents
// at most 200 rows; the documents one more to say more exist; the compliance
// records at most 400 claims and 200 findings).
export const MAX_THREADS = 200;
export const MAX_HISTORY = 200;
export const MAX_DOCUMENTS = 200;
export const MAX_COMPLIANCE_RECORDS = 600;

// The consultation states a thread can be in (the database's own list).
const CONSULTATION_STATES = Object.freeze([
  "created",
  "scheduled",
  "ready",
  "live",
  "completed",
  "cancelled",
  "no_show",
  "technical_failure",
] as const);
type ThreadConsultationState = (typeof CONSULTATION_STATES)[number];

const VERSION_LABEL = /^v[1-9][0-9]{0,8}$/;

// Request-scoped, unprivileged calls through the database's own reads. None
// takes an actor, User, profile or record id.
export type ClientWorkspaceReads = {
  // client_payments(p_offset)
  readonly payments: (offset: number) => Promise<RowsResult>;
  // client_account_overview()
  readonly overview: () => Promise<RowsResult>;
  // consultation_threads(p_role)
  readonly threads: (role: ThreadRole) => Promise<RowsResult>;
};

export type AttorneyWorkspaceReads = {
  // consultation_threads(p_role)
  readonly threads: (role: ThreadRole) => Promise<RowsResult>;
  // attorney_consultation_history()
  readonly history: () => Promise<RowsResult>;
  // attorney_documents()
  readonly documents: () => Promise<RowsResult>;
  // attorney_compliance_records()
  readonly compliance: () => Promise<RowsResult>;
};

export type ClientWorkspaceSources = {
  // The client intake sources decide the verified client.
  readonly clientIntake: ClientIntakeSources;
  readonly reads: () => Promise<ClientWorkspaceReads | null>;
};

export type AttorneyWorkspaceSources = {
  readonly session: ServerSessionSource;
  readonly attorney: AttorneyPrincipalSource;
  readonly reads: () => Promise<AttorneyWorkspaceReads | null>;
};

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export type PaymentLine = {
  readonly id: string;
  readonly requestId: string;
  readonly state: PaymentState;
  readonly totalMinor: number;
  readonly currency: string;
  readonly authorizedMinor: number | null;
  readonly capturedMinor: number | null;
  readonly refundedMinor: number;
  readonly createdAt: string;
};

const optionalAmount = (value: unknown): value is number | null =>
  value === null || isAmountMinor(value);

function readPayment(row: unknown): PaymentLine | null {
  const f = readExact(row, CLIENT_PAYMENT_COLUMNS);
  if (f === null) {
    return null;
  }
  const id = f.get("payment_transaction_id");
  const requestId = f.get("consultation_request_id");
  const state = f.get("payment_state");
  const total = f.get("total_client_amount_minor");
  const currency = f.get("currency_code");
  const authorized = f.get("amount_authorized_minor");
  const captured = f.get("amount_captured_minor");
  const refunded = f.get("amount_refunded_minor");
  const createdAt = f.get("created_at");
  if (
    !isUuid(id) ||
    !isUuid(requestId) ||
    !isOneOf(PAYMENT_STATES, state) ||
    !isAmountMinor(total) ||
    !isCurrencyCode(currency) ||
    !optionalAmount(authorized) ||
    !optionalAmount(captured) ||
    !isAmountMinor(refunded) ||
    refunded > (captured ?? 0) ||
    !isTimestamp(createdAt)
  ) {
    return null;
  }
  return Object.freeze({
    id,
    requestId,
    state,
    totalMinor: total,
    currency,
    authorizedMinor: authorized,
    capturedMinor: captured,
    refundedMinor: refunded,
    createdAt,
  });
}

export type AccountOverview = {
  readonly displayName: string | null;
  readonly accountState: AccountState;
  readonly createdAt: string;
  readonly counts: Readonly<Record<DataCategory, number>>;
};

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function readOverview(row: unknown): AccountOverview | null {
  const f = readExact(row, ACCOUNT_OVERVIEW_COLUMNS);
  if (f === null) {
    return null;
  }
  const name = f.get("display_name");
  const state = f.get("account_state");
  const createdAt = f.get("created_at");
  const counts: Partial<Record<DataCategory, number>> = {};
  for (const category of DATA_CATEGORIES) {
    const value = f.get(category);
    if (!isCount(value)) {
      return null;
    }
    counts[category] = value;
  }
  if (
    !(name === null || (typeof name === "string" && name.length <= 200)) ||
    !isOneOf(ACCOUNT_STATES, state) ||
    !isTimestamp(createdAt)
  ) {
    return null;
  }
  return Object.freeze({
    displayName: name as string | null,
    accountState: state,
    createdAt,
    counts: Object.freeze(counts as Record<DataCategory, number>),
  });
}

export type MessageThread = {
  readonly consultationId: string;
  readonly consultationState: ThreadConsultationState;
  readonly messaging: MessagingStatus;
  readonly messageCount: number;
  readonly lastMessageAt: string | null;
  readonly lastMessageMine: boolean | null;
};

function readThread(row: unknown): MessageThread | null {
  const f = readExact(row, THREAD_COLUMNS);
  if (f === null) {
    return null;
  }
  const id = f.get("consultation_id");
  const state = f.get("consultation_state");
  const messaging = f.get("messaging_status");
  const count = f.get("message_count");
  const lastAt = f.get("last_message_at");
  const mine = f.get("last_message_mine");
  if (
    !isUuid(id) ||
    !isOneOf(CONSULTATION_STATES, state) ||
    !isOneOf(MESSAGING_STATUSES, messaging) ||
    !isCount(count) ||
    (count === 0
      ? lastAt !== null || mine !== null
      : !isTimestamp(lastAt) || typeof mine !== "boolean")
  ) {
    return null;
  }
  return Object.freeze({
    consultationId: id,
    consultationState: state,
    messaging,
    messageCount: count,
    lastMessageAt: lastAt as string | null,
    lastMessageMine: mine as boolean | null,
  });
}

export type AttorneyDocument = {
  readonly consultationId: string;
  readonly documentId: string;
  readonly versionLabel: string;
  readonly mimeType: ArtifactType;
  readonly byteSize: number;
  readonly createdAt: string;
  readonly uploadedBy: ThreadRole;
  readonly mine: boolean;
  readonly sharing: "active" | "revoked";
  readonly accessible: boolean;
};

function readDocument(row: unknown): AttorneyDocument | null {
  const f = readExact(row, ATTORNEY_DOCUMENT_COLUMNS);
  if (f === null) {
    return null;
  }
  const consultationId = f.get("consultation_id");
  const documentId = f.get("document_id");
  const label = f.get("version_label");
  const mime = f.get("mime_type");
  const size = f.get("byte_size");
  const createdAt = f.get("created_at");
  const uploadedBy = f.get("uploaded_by");
  const mine = f.get("mine");
  const sharing = f.get("sharing");
  const accessible = f.get("accessible");
  if (
    !isUuid(consultationId) ||
    !isUuid(documentId) ||
    typeof label !== "string" ||
    !VERSION_LABEL.test(label) ||
    !isOneOf(ARTIFACT_TYPES, mime) ||
    !Number.isSafeInteger(size) ||
    (size as number) < 1 ||
    (size as number) > RESOURCE_BYTE_CEILING ||
    !isTimestamp(createdAt) ||
    !isOneOf(THREAD_ROLES, uploadedBy) ||
    typeof mine !== "boolean" ||
    mine !== (uploadedBy === "attorney") ||
    (sharing !== "active" && sharing !== "revoked") ||
    typeof accessible !== "boolean" ||
    (mine && !accessible)
  ) {
    return null;
  }
  return Object.freeze({
    consultationId,
    documentId,
    versionLabel: label,
    mimeType: mime,
    byteSize: size as number,
    createdAt,
    uploadedBy,
    mine,
    sharing,
    accessible,
  });
}

export type ComplianceRecord = {
  readonly kind: RecordKind;
  readonly id: string;
  readonly jurisdictionId: string | null;
  readonly statusCode: string | null;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly evidenceLapsesOn: string | null;
  readonly recordedAt: string;
};

const optionalDate = (value: unknown): value is string | null =>
  value === null || isDate(value);

function readComplianceRecord(row: unknown): ComplianceRecord | null {
  const f = readExact(row, COMPLIANCE_RECORD_COLUMNS);
  if (f === null) {
    return null;
  }
  const kind = f.get("record_kind");
  const id = f.get("record_id");
  const jurisdiction = f.get("jurisdiction_id");
  const status = f.get("status_code");
  const startsOn = f.get("starts_on");
  const endsOn = f.get("ends_on");
  const lapses = f.get("evidence_lapses_on");
  const recordedAt = f.get("recorded_at");
  if (
    !isOneOf(RECORD_KINDS, kind) ||
    !isUuid(id) ||
    !(jurisdiction === null || isUuid(jurisdiction)) ||
    (kind === "license" && jurisdiction === null) ||
    !(status === null || isCode(status)) ||
    (kind !== "discipline" && status !== null) ||
    !optionalDate(startsOn) ||
    !optionalDate(endsOn) ||
    !optionalDate(lapses) ||
    (kind === "discipline" && lapses !== null) ||
    !isTimestamp(recordedAt)
  ) {
    return null;
  }
  return Object.freeze({
    kind,
    id,
    jurisdictionId: jurisdiction as string | null,
    statusCode: status as string | null,
    startsOn: startsOn as string | null,
    endsOn: endsOn as string | null,
    evidenceLapsesOn: lapses as string | null,
    recordedAt,
  });
}

// ---------------------------------------------------------------------------
// Client surfaces
// ---------------------------------------------------------------------------

export type ClientPaymentsView =
  | {
      readonly status: "ready";
      readonly payments: readonly PaymentLine[];
      readonly pager: StaffPager;
    }
  | Refusal;

// One page (25, newest first) of the client's own payment attempts; the
// query value only names the page. It never throws.
export async function resolveClientPayments(
  sources: ClientWorkspaceSources,
  pageValue: unknown,
): Promise<ClientPaymentsView> {
  try {
    const access = await admittedClient(sources.clientIntake);
    if (access !== "granted") {
      return access;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const page = staffPageOf(pageValue);
    const rows = rowsOf(
      await attempt(() => reads.payments(staffOffsetOf(page))),
    );
    const read = staffPageRows(rows, readPayment, page);
    if (
      read === null ||
      new Set(read.rows.map((p) => p.id)).size !== read.rows.length
    ) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      status: "ready",
      payments: read.rows,
      pager: read.pager,
    });
  } catch {
    return UNAVAILABLE;
  }
}

export type ClientAccountView =
  { readonly status: "ready"; readonly account: AccountOverview } | Refusal;

// The client's own account and the counts of the records it holds. It never
// throws; an admitted client the database answers no row for is unavailable.
export async function resolveClientAccount(
  sources: ClientWorkspaceSources,
): Promise<ClientAccountView> {
  try {
    const access = await admittedClient(sources.clientIntake);
    if (access !== "granted") {
      return access;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.overview()));
    if (rows === null || rows.length !== 1) {
      return UNAVAILABLE;
    }
    const account = readOverview(rows[0]);
    return account === null
      ? UNAVAILABLE
      : Object.freeze({ status: "ready", account });
  } catch {
    return UNAVAILABLE;
  }
}

export type ThreadsView =
  | { readonly status: "ready"; readonly threads: readonly MessageThread[] }
  | Refusal;

async function threadsOf(
  admit: () => Promise<"granted" | Refusal>,
  readsSource: () => Promise<Pick<ClientWorkspaceReads, "threads"> | null>,
  role: ThreadRole,
): Promise<ThreadsView> {
  try {
    const access = await admit();
    if (access !== "granted") {
      return access;
    }
    const reads = await portFrom(readsSource);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.threads(role)));
    if (rows === null || rows.length > MAX_THREADS) {
      return UNAVAILABLE;
    }
    const threads = readRows(rows, readThread);
    if (
      threads === null ||
      new Set(threads.map((t) => t.consultationId)).size !== threads.length
    ) {
      return UNAVAILABLE;
    }
    return Object.freeze({ status: "ready", threads });
  } catch {
    return UNAVAILABLE;
  }
}

// The client's own Consultation threads. It never throws.
export function resolveClientThreads(
  sources: ClientWorkspaceSources,
): Promise<ThreadsView> {
  return threadsOf(
    () => admittedClient(sources.clientIntake),
    sources.reads,
    "client",
  );
}

// The client's home: Consultations in progress or ready now, and the next
// upcoming one, from the client's Consultation list as it was read.
export type ClientHome = {
  readonly active: readonly ClientConsultationEntry[];
  readonly next: ClientConsultationEntry | null;
  readonly upcoming: number;
};

export function clientHomeOf(view: ClientConsultationsView): ClientHome | null {
  if (view.status !== "ready") {
    return null;
  }
  const active = view.entries.filter((entry) => {
    const shown = clientDisplayStateOf(entry);
    return shown === "live" || shown === "ready";
  });
  const upcoming = view.entries.filter((entry) => {
    const shown = clientDisplayStateOf(entry);
    return shown === "created" || shown === "scheduled";
  });
  return Object.freeze({
    active: Object.freeze(active),
    next: upcoming[0] ?? null,
    upcoming: upcoming.length,
  });
}

// ---------------------------------------------------------------------------
// Attorney surfaces
// ---------------------------------------------------------------------------

function admitAttorney(sources: {
  readonly session: ServerSessionSource;
  readonly attorney: AttorneyPrincipalSource;
}): Promise<"granted" | Refusal> {
  return admittedAttorney(sources.session, sources.attorney);
}

// The attorney's own Consultation threads. It never throws.
export function resolveAttorneyThreads(
  sources: AttorneyWorkspaceSources,
): Promise<ThreadsView> {
  return threadsOf(() => admitAttorney(sources), sources.reads, "attorney");
}

export type HistoryView =
  | {
      readonly status: "ready";
      readonly entries: readonly ClientConsultationEntry[];
    }
  | Refusal;

// The attorney's own ended Consultations, most recent first. It never
// throws; a Consultation that has not ended makes the answer unavailable.
export async function resolveAttorneyHistory(
  sources: AttorneyWorkspaceSources,
): Promise<HistoryView> {
  try {
    const access = await admitAttorney(sources);
    if (access !== "granted") {
      return access;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.history()));
    if (rows === null || rows.length > MAX_HISTORY) {
      return UNAVAILABLE;
    }
    const entries = readRows(rows, readClientEntry);
    if (
      entries === null ||
      entries.some((entry) => !isTerminalState(entry.state)) ||
      new Set(entries.map((entry) => entry.id)).size !== entries.length
    ) {
      return UNAVAILABLE;
    }
    return Object.freeze({ status: "ready", entries });
  } catch {
    return UNAVAILABLE;
  }
}

export type DocumentsView =
  | {
      readonly status: "ready";
      readonly documents: readonly AttorneyDocument[];
      readonly more: boolean;
    }
  | Refusal;

// The current document versions the attorney may see across their own
// Consultations, newest first (at most 200, and whether more exist). It never
// throws.
export async function resolveAttorneyDocuments(
  sources: AttorneyWorkspaceSources,
): Promise<DocumentsView> {
  try {
    const access = await admitAttorney(sources);
    if (access !== "granted") {
      return access;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.documents()));
    if (rows === null || rows.length > MAX_DOCUMENTS + 1) {
      return UNAVAILABLE;
    }
    const documents = readRows(rows, readDocument);
    if (
      documents === null ||
      new Set(documents.map((d) => d.documentId)).size !== documents.length
    ) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      status: "ready",
      documents: Object.freeze(documents.slice(0, MAX_DOCUMENTS)),
      more: documents.length > MAX_DOCUMENTS,
    });
  } catch {
    return UNAVAILABLE;
  }
}

export type ComplianceRecordsView =
  | {
      readonly status: "ready";
      readonly records: readonly ComplianceRecord[];
    }
  | Refusal;

// The attorney's own licence, insurance and discipline records with their
// dates. It never throws.
export async function resolveAttorneyComplianceRecords(
  sources: AttorneyWorkspaceSources,
): Promise<ComplianceRecordsView> {
  try {
    const access = await admitAttorney(sources);
    if (access !== "granted") {
      return access;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.compliance()));
    if (rows === null || rows.length > MAX_COMPLIANCE_RECORDS) {
      return UNAVAILABLE;
    }
    const records = readRows(rows, readComplianceRecord);
    if (
      records === null ||
      new Set(records.map((r) => `${r.kind}|${r.id}`)).size !== records.length
    ) {
      return UNAVAILABLE;
    }
    return Object.freeze({ status: "ready", records });
  } catch {
    return UNAVAILABLE;
  }
}

// What the records say against a day (no lead time is applied: a date is
// either past or not). "lapsed" counts licence and insurance records whose
// recorded end date has passed; "evidenceAged" those whose latest evidence
// has reached the in-force policy's stated age; "openFindings" the discipline
// findings recorded without a resolved date; "nextDate" the soonest end or
// evidence date still ahead.
export type ComplianceAlerts = {
  readonly lapsed: number;
  readonly evidenceAged: number;
  readonly openFindings: number;
  readonly nextDate: string | null;
};

export function complianceAlertsOf(
  records: readonly ComplianceRecord[],
  today: string,
): ComplianceAlerts {
  let lapsed = 0;
  let evidenceAged = 0;
  let openFindings = 0;
  const ahead: string[] = [];
  for (const record of records) {
    if (record.kind === "discipline") {
      if (record.endsOn === null) {
        openFindings += 1;
      }
      continue;
    }
    for (const [date, past] of [
      [record.endsOn, "lapsed"],
      [record.evidenceLapsesOn, "evidence"],
    ] as const) {
      if (date === null) {
        continue;
      }
      if (date < today) {
        if (past === "lapsed") {
          lapsed += 1;
        } else {
          evidenceAged += 1;
        }
      } else {
        ahead.push(date);
      }
    }
  }
  ahead.sort();
  return Object.freeze({
    lapsed,
    evidenceAged,
    openFindings,
    nextDate: ahead[0] ?? null,
  });
}

export type ComplianceWorkspaceView =
  | {
      readonly status: "ready";
      readonly setup: Extract<ProfessionalSetupView, { status: "ready" }>;
      readonly records: readonly ComplianceRecord[];
      readonly alerts: ComplianceAlerts;
      readonly jurisdictionNames: ReadonlyMap<string, string>;
    }
  | { readonly status: "no-application" }
  | Refusal;

// The attorney's compliance page: the professional setup's own reads
// (profile stage, licences with their waitlist state and verification status,
// insurance, practice-area authorisations, the latest recorded Eligibility
// per jurisdiction and context) with the attorney's own record dates and
// discipline findings. It never throws.
export async function resolveAttorneyCompliance(sources: {
  readonly professional: AttorneyProfessionalSources;
  readonly workspace: AttorneyWorkspaceSources;
}): Promise<ComplianceWorkspaceView> {
  try {
    // The Security Shell first, as on every attorney surface: an account
    // without attorney workspace access is refused before anything is read.
    const access = await admitAttorney(sources.workspace);
    if (access !== "granted") {
      return access;
    }
    const setup = await resolveProfessionalSetup(sources.professional);
    if (setup.status !== "ready") {
      return setup;
    }
    const records = await resolveAttorneyComplianceRecords(sources.workspace);
    const now = sources.professional.clock();
    if (records.status !== "ready" || !Number.isFinite(now)) {
      return records.status === "ready" ? UNAVAILABLE : records;
    }
    const today = new Date(now).toISOString().slice(0, 10);
    return Object.freeze({
      status: "ready",
      setup,
      records: records.records,
      alerts: complianceAlertsOf(records.records, today),
      jurisdictionNames: new Map(
        setup.jurisdictions.map((option) => [option.value, option.label]),
      ),
    });
  } catch {
    return UNAVAILABLE;
  }
}

// One section of the attorney dashboard: what its use case answered, or
// unavailable (each section fails alone; the others are still shown).
export type Section<T> =
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "unavailable" };

const sectionOf = <T>(value: T | null): Section<T> =>
  value === null
    ? Object.freeze({ status: "unavailable" })
    : Object.freeze({ status: "ready", value });

export type ConsultationSummary = {
  readonly active: readonly ConsultationEntry[];
  readonly next: ConsultationEntry | null;
};

export type RequestSummary = {
  readonly instant: number;
  readonly scheduled: number;
};

export type AvailabilitySummary = {
  readonly instantOn: boolean | null;
  readonly instantConfigured: boolean | null;
  readonly windows: number;
  readonly nextWindow: CalendarEntry | null;
  readonly blackouts: number;
  readonly days: number;
};

export type EarningsSummary = {
  readonly totals: readonly {
    readonly currency: string;
    readonly netMinor: number;
  }[];
};

export type AlertSummary = {
  readonly unacknowledged: number;
  readonly openComplaints: number;
  readonly compliance: ComplianceAlerts | null;
};

export type AttorneyDashboard = {
  readonly consultations: Section<ConsultationSummary>;
  readonly requests: Section<RequestSummary>;
  readonly availability: Section<AvailabilitySummary>;
  readonly earnings: Section<EarningsSummary>;
  readonly alerts: Section<AlertSummary>;
};

// The attorney's current Consultations as attorney_consultations ordered
// them (live first, then those whose window is open, then upcoming ones).
export function consultationSummaryOf(
  view: ConsultationListView,
  now: number,
): ConsultationSummary | null {
  if (view.status !== "ready") {
    return null;
  }
  const active = view.entries.filter(
    (entry) =>
      entry.state === "live" || entry.state === "ready" || entry.readyDue,
  );
  const next =
    view.entries.find(
      (entry) =>
        entry.state === "scheduled" &&
        !entry.readyDue &&
        !(entry.closesAt !== null && Date.parse(entry.closesAt) <= now),
    ) ?? null;
  return Object.freeze({ active: Object.freeze(active), next });
}

// The Requests awaiting the attorney's decision, by path; one the database
// reports past its deadline is not counted.
export function requestSummaryOf(
  view: AttorneyQueueView,
): RequestSummary | null {
  if (view.status !== "ready") {
    return null;
  }
  const open = view.entries.filter((entry) => !entry.expiredDue);
  return Object.freeze({
    instant: open.filter((entry) => entry.path === "instant").length,
    scheduled: open.filter((entry) => entry.path === "scheduled").length,
  });
}

// Instant mode as the server sees it and the calendar the schedule read
// answers (its next 14 days).
export function availabilitySummaryOf(
  view: ScheduleView,
  now: number,
): AvailabilitySummary | null {
  if (view.status !== "ready" || !Number.isFinite(now)) {
    return null;
  }
  const windows = view.calendar.filter((entry) => entry.kind === "window");
  return Object.freeze({
    instantOn: view.instant === null ? null : view.instant.on,
    instantConfigured: view.instant === null ? null : view.instant.configured,
    windows: windows.length,
    nextWindow: windows.find((entry) => Date.parse(entry.endsAt) > now) ?? null,
    blackouts: view.calendar.filter((entry) => entry.kind === "blackout")
      .length,
    days: CALENDAR_DAYS,
  });
}

// The ledger-derived net per currency, never added across currencies.
export function earningsSummaryOf(view: EarningsView): EarningsSummary | null {
  if (view.status !== "ready") {
    return null;
  }
  return Object.freeze({
    totals: Object.freeze(
      view.totals.map((total) =>
        Object.freeze({ currency: total.currency, netMinor: total.netMinor }),
      ),
    ),
  });
}

// Notifications that ask for an acknowledgement and have none, Complaint
// Cases not resolved, and what the compliance records say today.
export function alertSummaryOf(
  center: CenterView,
  complaints: OwnComplaintsView,
  records: ComplianceRecordsView,
  now: number,
): AlertSummary | null {
  if (
    center.status !== "ready" ||
    complaints.status !== "ready" ||
    !Number.isFinite(now)
  ) {
    return null;
  }
  return Object.freeze({
    unacknowledged: center.entries.filter(
      (entry) =>
        entry.acknowledgementRequired && entry.state !== "acknowledged",
    ).length,
    openComplaints: complaints.cases.filter((c) => c.state !== "resolved")
      .length,
    compliance:
      records.status === "ready"
        ? complianceAlertsOf(
            records.records,
            new Date(now).toISOString().slice(0, 10),
          )
        : null,
  });
}

export type AttorneyDashboardSources = {
  readonly session: ServerSessionSource;
  readonly attorney: AttorneyPrincipalSource;
  // Each existing use case, bound to its own production sources; each
  // decides its own access again.
  readonly consultations: () => Promise<ConsultationListView>;
  readonly requests: () => Promise<AttorneyQueueView>;
  readonly schedule: () => Promise<ScheduleView>;
  readonly earnings: () => Promise<EarningsView>;
  readonly notifications: () => Promise<CenterView>;
  readonly complaints: () => Promise<OwnComplaintsView>;
  readonly compliance: () => Promise<ComplianceRecordsView>;
  readonly clock: () => number;
};

export type AttorneyDashboardView =
  { readonly status: "ready"; readonly dashboard: AttorneyDashboard } | Refusal;

const settled = async <T>(call: () => Promise<T>): Promise<T | null> => {
  try {
    return await call();
  } catch {
    return null;
  }
};

// The attorney's dashboard: admitted once through the Security Shell, then
// each section from its own existing use case. It never throws.
export async function resolveAttorneyDashboard(
  sources: AttorneyDashboardSources,
): Promise<AttorneyDashboardView> {
  try {
    const access = await admitAttorney(sources);
    if (access !== "granted") {
      return access;
    }
    const now = sources.clock();
    const [
      consultations,
      requests,
      schedule,
      earnings,
      notifications,
      complaints,
      compliance,
    ] = await Promise.all([
      settled(sources.consultations),
      settled(sources.requests),
      settled(sources.schedule),
      settled(sources.earnings),
      settled(sources.notifications),
      settled(sources.complaints),
      settled(sources.compliance),
    ]);
    return Object.freeze({
      status: "ready",
      dashboard: Object.freeze({
        consultations: sectionOf(
          consultations === null
            ? null
            : consultationSummaryOf(consultations, now),
        ),
        requests: sectionOf(
          requests === null ? null : requestSummaryOf(requests),
        ),
        availability: sectionOf(
          schedule === null ? null : availabilitySummaryOf(schedule, now),
        ),
        earnings: sectionOf(
          earnings === null ? null : earningsSummaryOf(earnings),
        ),
        alerts: sectionOf(
          notifications === null || complaints === null
            ? null
            : alertSummaryOf(
                notifications,
                complaints,
                compliance ?? UNAVAILABLE,
                now,
              ),
        ),
      }),
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// The attorney's week view (read-only, beside the schedule management)
// ---------------------------------------------------------------------------

export const WEEK_DAYS = 7;
// The span the calendar read answers from: 31 days back to 3653 days ahead;
// a week starts at most 28 days back and ends inside that span.
const WEEK_BACK_DAYS = 28;
const WEEK_AHEAD_DAYS = 3646;
const DAY_MS = 86400000;

export type WeekDay = {
  readonly date: string;
  readonly entries: readonly CalendarEntry[];
};

export type ScheduleWeekView =
  | {
      readonly status: "ready";
      readonly start: string;
      readonly days: readonly WeekDay[];
      readonly previous: string | null;
      readonly next: string | null;
      readonly today: string;
    }
  | Refusal;

const dateText = (epoch: number) => new Date(epoch).toISOString().slice(0, 10);

// The first day of the week a query value names: a whole UTC date inside the
// span; today for anything else.
export function weekStartOf(value: unknown, now: number): string {
  const today = Date.parse(`${dateText(now)}T00:00:00Z`);
  const text = Array.isArray(value) ? undefined : value;
  if (typeof text !== "string" || !isDate(text)) {
    return dateText(today);
  }
  const start = Date.parse(`${text}T00:00:00Z`);
  if (
    !Number.isFinite(start) ||
    start < today - WEEK_BACK_DAYS * DAY_MS ||
    start > today + WEEK_AHEAD_DAYS * DAY_MS
  ) {
    return dateText(today);
  }
  return text;
}

// Seven UTC days of the attorney's own calendar (availability windows,
// Blackouts, Holds and Bookings, from the existing calendar read); each entry
// is shown on the first day of the week it overlaps. It never throws.
export async function resolveScheduleWeek(
  sources: AttorneyScheduleSources,
  weekValue: unknown,
): Promise<ScheduleWeekView> {
  try {
    const access = await admittedAttorney(sources.session, sources.attorney);
    if (access !== "granted") {
      return access;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const now = sources.clock();
    if (!Number.isFinite(now)) {
      return UNAVAILABLE;
    }
    const start = weekStartOf(weekValue, now);
    const from = Date.parse(`${start}T00:00:00Z`);
    const until = from + WEEK_DAYS * DAY_MS;
    const rows = rowsOf(await attempt(() => reads.calendar(start, WEEK_DAYS)));
    if (rows === null) {
      return UNAVAILABLE;
    }
    const entries = rows.map(readCalendarEntry);
    if (entries.includes(null)) {
      return UNAVAILABLE;
    }
    const days = Array.from({ length: WEEK_DAYS }, (_, index) => {
      const dayStart = from + index * DAY_MS;
      const dayEnd = dayStart + DAY_MS;
      return Object.freeze({
        date: dateText(dayStart),
        entries: Object.freeze(
          (entries as CalendarEntry[]).filter((entry) => {
            const s = Date.parse(entry.startsAt);
            const e = Date.parse(entry.endsAt);
            if (!(s < until && e > from)) {
              return false;
            }
            const shownOn = Math.max(s, from);
            return shownOn >= dayStart && shownOn < dayEnd;
          }),
        ),
      });
    });
    const today = Date.parse(`${dateText(now)}T00:00:00Z`);
    const previous = from - WEEK_DAYS * DAY_MS;
    const next = from + WEEK_DAYS * DAY_MS;
    return Object.freeze({
      status: "ready",
      start,
      days: Object.freeze(days),
      previous:
        previous >= today - WEEK_BACK_DAYS * DAY_MS ? dateText(previous) : null,
      next: next <= today + WEEK_AHEAD_DAYS * DAY_MS ? dateText(next) : null,
      today: dateText(today),
    });
  } catch {
    return UNAVAILABLE;
  }
}
