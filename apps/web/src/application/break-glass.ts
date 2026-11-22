// Break-glass access (MVP-001 S11; PS-A6 section 2; MBS section 5
// "break-glass foundation"; TA sections 18, 20 and 41; DM section 3).
//
// Provider-neutral and injectable: each request hands in its own ports. Any
// active staff member (aal2) may request time-limited, read-only access to
// one Consultation with a reason; a different staff member holding
// approve_break_glass for the Consultation's jurisdiction approves it for a
// duration they choose (no default) or revokes it. A grant's state is
// derived by the database at read time (requested, active, expired,
// revoked). While their own grant is active, the requester reads the
// Consultation through the one break-glass path, which the database audits
// once per access: its record, its Messages and its document list (metadata
// only; no content is served and nothing can be changed). A grant is never a
// capability: no other surface honours it. Every command is audited by the
// database with identifiers and codes only (never the reason). Reads are
// strict.

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
  verifiedActiveStaff,
  verifiedStaffWithAny,
  type ConfigurationSources,
} from "./staff-configuration.ts";
import {
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
  type CommandAnswer,
  type StaffPager,
} from "./workspace-support.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const BREAK_GLASS_CAPABILITY = "approve_break_glass";

export const GRANT_STATES = Object.freeze([
  "requested",
  "active",
  "expired",
  "revoked",
] as const);
export type GrantState = (typeof GRANT_STATES)[number];

export const RESOURCE_TYPES = Object.freeze(["consultation"] as const);
export type ResourceType = (typeof RESOURCE_TYPES)[number];

// PS-A6 section 2 rule 5 (the reason) and rule 3 (the 24-hour bound, offered
// here in whole minutes).
export const MAX_REASON = 2000;
export const MAX_DURATION_MINUTES = 1440;

export const REQUEST_OUTCOMES = Object.freeze([
  "requested",
  "existing",
  "invalid",
  "denied",
  "not_found",
]);
export const APPROVE_OUTCOMES = Object.freeze([
  "approved",
  "invalid",
  "denied",
  "not_found",
  "own_request",
  "already_active",
  "already_expired",
  "already_revoked",
]);
export const REVOKE_OUTCOMES = Object.freeze([
  "refused",
  "ended",
  "invalid",
  "denied",
  "not_found",
  "already_revoked",
  "already_expired",
]);

export const MINE_COLUMNS = Object.freeze([
  "break_glass_grant_id",
  "resource_type",
  "resource_id",
  "reason",
  "state",
  "requested_at",
  "approved_at",
  "expires_at",
  "revoked_at",
]);
export const QUEUE_COLUMNS = Object.freeze([
  "break_glass_grant_id",
  "resource_type",
  "resource_id",
  "jurisdiction_id",
  "reason",
  "state",
  "requested_at",
  "approved_at",
  "expires_at",
  "revoked_at",
  "requested_by_me",
]);
export const ACCESS_COLUMNS = Object.freeze([
  "break_glass_grant_id",
  "expires_at",
  "consultation_id",
  "consultation_state",
  "request_path",
  "modality",
  "duration_minutes",
  "scheduled_start_at",
  "scheduled_end_at",
  "started_at",
  "ended_at",
  "outcome_code",
  "messages",
  "older_messages_not_shown",
  "documents",
  "older_documents_not_shown",
]);
const MESSAGE_KEYS = Object.freeze([
  "message_id",
  "sender_role",
  "body",
  "sent_at",
]);
const DOCUMENT_KEYS = Object.freeze([
  "document_id",
  "resource_id",
  "version_label",
  "mime_type",
  "byte_size",
  "created_at",
  "uploaded_by",
  "sharing",
]);

export const PARTICIPANT_ROLES = Object.freeze(["client", "attorney"] as const);
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];
export const SHARING_STATES = Object.freeze([
  "active",
  "revoked",
  "none",
] as const);
export type SharingState = (typeof SHARING_STATES)[number];

// The database's own bounds.
export const MAX_OWN_GRANTS = 200;
const MAX_MESSAGES = 500;
const MAX_DOCUMENTS = 200;
const MAX_MESSAGE_BODY = 20000;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type BreakGlassReads = {
  // staff_break_glass_grants_mine()
  readonly mine: () => Promise<RowsResult>;
  // staff_break_glass_queue(p_state, p_offset)
  readonly queue: (state: GrantState, offset: number) => Promise<RowsResult>;
  // staff_break_glass_consultation(p_break_glass_id): the audited
  // break-glass access path (one audit event per call).
  readonly access: (grantId: string) => Promise<RowsResult>;
  // deployment_environment_identity()
  readonly environmentIdentity: () => Promise<RowsResult>;
};

export type BreakGlassWrites = {
  // staff_request_break_glass(p_consultation_id, p_reason)
  readonly request: (
    consultationId: string,
    reason: string,
  ) => Promise<CommandAnswer>;
  // staff_approve_break_glass(p_break_glass_id, p_duration_seconds)
  readonly approve: (
    grantId: string,
    durationSeconds: number,
  ) => Promise<CommandAnswer>;
  // staff_revoke_break_glass(p_break_glass_id)
  readonly revoke: (grantId: string) => Promise<CommandAnswer>;
};

export type BreakGlassSources = {
  readonly staff: ConfigurationSources;
  readonly reads: () => Promise<BreakGlassReads | null>;
  readonly writes: () => Promise<BreakGlassWrites | null>;
  readonly environment: () => EnvironmentConfiguration;
};

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

const nullableTime = (value: unknown): value is string | null =>
  value === null || isTimestamp(value);
const isReason = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.length <= MAX_REASON;

export type OwnGrant = {
  readonly id: string;
  readonly resourceType: ResourceType;
  readonly resourceId: string;
  readonly reason: string;
  readonly state: GrantState;
  readonly requestedAt: string;
  readonly approvedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
};

// The facts agree with the derived state (the database derives it; a row
// that contradicts its own facts is not shown).
function consistent(grant: OwnGrant): boolean {
  if ((grant.approvedAt === null) !== (grant.expiresAt === null)) {
    return false;
  }
  switch (grant.state) {
    case "requested":
      return grant.approvedAt === null && grant.revokedAt === null;
    case "active":
    case "expired":
      return grant.approvedAt !== null && grant.revokedAt === null;
    default:
      return grant.revokedAt !== null;
  }
}

function readOwnFields(f: ReadonlyMap<string, unknown>): OwnGrant | null {
  const value = {
    id: f.get("break_glass_grant_id"),
    resourceType: f.get("resource_type"),
    resourceId: f.get("resource_id"),
    reason: f.get("reason"),
    state: f.get("state"),
    requestedAt: f.get("requested_at"),
    approvedAt: f.get("approved_at"),
    expiresAt: f.get("expires_at"),
    revokedAt: f.get("revoked_at"),
  };
  if (
    !isUuid(value.id) ||
    !isOneOf(RESOURCE_TYPES, value.resourceType) ||
    !isUuid(value.resourceId) ||
    !isReason(value.reason) ||
    !isOneOf(GRANT_STATES, value.state) ||
    !isTimestamp(value.requestedAt) ||
    !nullableTime(value.approvedAt) ||
    !nullableTime(value.expiresAt) ||
    !nullableTime(value.revokedAt)
  ) {
    return null;
  }
  const grant = Object.freeze(value) as OwnGrant;
  return consistent(grant) ? grant : null;
}

function readOwn(row: unknown): OwnGrant | null {
  const f = readExact(row, MINE_COLUMNS);
  return f === null ? null : readOwnFields(f);
}

export type QueuedGrant = OwnGrant & {
  readonly jurisdictionId: string | null;
  readonly requestedByMe: boolean;
};

function readQueued(row: unknown): QueuedGrant | null {
  const f = readExact(row, QUEUE_COLUMNS);
  if (f === null) {
    return null;
  }
  const own = readOwnFields(f);
  const jurisdictionId = f.get("jurisdiction_id");
  const requestedByMe = f.get("requested_by_me");
  if (
    own === null ||
    !(jurisdictionId === null || isUuid(jurisdictionId)) ||
    typeof requestedByMe !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({ ...own, jurisdictionId, requestedByMe });
}

export type AccessMessage = {
  readonly id: string;
  readonly senderRole: ParticipantRole;
  readonly body: string;
  readonly sentAt: string;
};

function readMessage(value: unknown): AccessMessage | null {
  const f = readExact(value, MESSAGE_KEYS);
  if (f === null) {
    return null;
  }
  const message = {
    id: f.get("message_id"),
    senderRole: f.get("sender_role"),
    body: f.get("body"),
    sentAt: f.get("sent_at"),
  };
  if (
    !isUuid(message.id) ||
    !isOneOf(PARTICIPANT_ROLES, message.senderRole) ||
    typeof message.body !== "string" ||
    message.body.length > MAX_MESSAGE_BODY ||
    !isTimestamp(message.sentAt)
  ) {
    return null;
  }
  return Object.freeze(message) as AccessMessage;
}

export type AccessDocument = {
  readonly id: string;
  readonly resourceId: string;
  readonly versionLabel: string | null;
  readonly mimeType: string | null;
  readonly byteSize: number | null;
  readonly createdAt: string;
  readonly uploadedBy: ParticipantRole;
  readonly sharing: SharingState;
};

function readDocument(value: unknown): AccessDocument | null {
  const f = readExact(value, DOCUMENT_KEYS);
  if (f === null) {
    return null;
  }
  const document = {
    id: f.get("document_id"),
    resourceId: f.get("resource_id"),
    versionLabel: f.get("version_label"),
    mimeType: f.get("mime_type"),
    byteSize: f.get("byte_size"),
    createdAt: f.get("created_at"),
    uploadedBy: f.get("uploaded_by"),
    sharing: f.get("sharing"),
  };
  if (
    !isUuid(document.id) ||
    !isUuid(document.resourceId) ||
    !(
      document.versionLabel === null ||
      (typeof document.versionLabel === "string" &&
        document.versionLabel.length <= 200)
    ) ||
    !(
      document.mimeType === null ||
      (typeof document.mimeType === "string" && document.mimeType.length <= 255)
    ) ||
    !(
      document.byteSize === null ||
      (Number.isSafeInteger(document.byteSize) &&
        (document.byteSize as number) >= 0)
    ) ||
    !isTimestamp(document.createdAt) ||
    !isOneOf(PARTICIPANT_ROLES, document.uploadedBy) ||
    !isOneOf(SHARING_STATES, document.sharing)
  ) {
    return null;
  }
  return Object.freeze(document) as AccessDocument;
}

function listOf<T>(
  value: unknown,
  max: number,
  reader: (entry: unknown) => T | null,
): readonly T[] | null {
  if (!Array.isArray(value) || value.length > max) {
    return null;
  }
  const read = readRows(value, reader);
  return read === null ? null : Object.freeze([...read]);
}

export type BreakGlassConsultation = {
  readonly grantId: string;
  readonly expiresAt: string;
  readonly consultationId: string;
  readonly state: string;
  readonly requestPath: string;
  readonly modality: string;
  readonly durationMinutes: number | null;
  readonly scheduledStartAt: string | null;
  readonly scheduledEndAt: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly outcomeCode: string | null;
  readonly messages: readonly AccessMessage[];
  readonly olderMessagesNotShown: boolean;
  readonly documents: readonly AccessDocument[];
  readonly olderDocumentsNotShown: boolean;
};

function readAccess(row: unknown): BreakGlassConsultation | null {
  const f = readExact(row, ACCESS_COLUMNS);
  if (f === null) {
    return null;
  }
  const messages = listOf(f.get("messages"), MAX_MESSAGES, readMessage);
  const documents = listOf(f.get("documents"), MAX_DOCUMENTS, readDocument);
  const value = {
    grantId: f.get("break_glass_grant_id"),
    expiresAt: f.get("expires_at"),
    consultationId: f.get("consultation_id"),
    state: f.get("consultation_state"),
    requestPath: f.get("request_path"),
    modality: f.get("modality"),
    durationMinutes: f.get("duration_minutes"),
    scheduledStartAt: f.get("scheduled_start_at"),
    scheduledEndAt: f.get("scheduled_end_at"),
    startedAt: f.get("started_at"),
    endedAt: f.get("ended_at"),
    outcomeCode: f.get("outcome_code"),
    olderMessagesNotShown: f.get("older_messages_not_shown"),
    olderDocumentsNotShown: f.get("older_documents_not_shown"),
  };
  if (
    messages === null ||
    documents === null ||
    !isUuid(value.grantId) ||
    !isTimestamp(value.expiresAt) ||
    !isUuid(value.consultationId) ||
    !isCode(value.state) ||
    !isCode(value.requestPath) ||
    !isCode(value.modality) ||
    !(
      value.durationMinutes === null ||
      (Number.isSafeInteger(value.durationMinutes) &&
        (value.durationMinutes as number) > 0)
    ) ||
    !nullableTime(value.scheduledStartAt) ||
    !nullableTime(value.scheduledEndAt) ||
    !nullableTime(value.startedAt) ||
    !nullableTime(value.endedAt) ||
    !(value.outcomeCode === null || isCode(value.outcomeCode)) ||
    typeof value.olderMessagesNotShown !== "boolean" ||
    typeof value.olderDocumentsNotShown !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({
    ...value,
    messages,
    documents,
  }) as BreakGlassConsultation;
}

// ---------------------------------------------------------------------------
// The break-glass page
// ---------------------------------------------------------------------------

export function grantStateOf(value: unknown): GrantState {
  return isOneOf(GRANT_STATES, value) ? value : "requested";
}

export type BreakGlassQueue = {
  readonly grantState: GrantState;
  readonly grants: readonly QueuedGrant[];
  readonly pager: StaffPager;
};

export type BreakGlassWorkspaceView =
  | {
      readonly status: "ready";
      readonly mine: readonly OwnGrant[];
      // Null for a staff member who holds no approve_break_glass grant.
      readonly queue: BreakGlassQueue | null;
    }
  | Refusal;

// The caller's own grants and, for holders of approve_break_glass, one page
// of the grants in scope in one state.
export async function resolveBreakGlassWorkspace(
  sources: BreakGlassSources,
  stateValue: unknown,
  pageValue: unknown,
): Promise<BreakGlassWorkspaceView> {
  try {
    const grantState = grantStateOf(stateValue);
    const page = staffPageOf(pageValue);
    const staff = await verifiedActiveStaff(sources.staff);
    if (!("userId" in staff)) {
      return staff;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.mine()));
    if (rows === null || rows.length > MAX_OWN_GRANTS) {
      return UNAVAILABLE;
    }
    const mine = readRows(rows, readOwn);
    if (mine === null) {
      return UNAVAILABLE;
    }
    const holder = await verifiedStaffWithAny(
      sources.staff,
      BREAK_GLASS_CAPABILITY,
    );
    if (!("userId" in holder)) {
      return holder.status === "denied"
        ? Object.freeze({ status: "ready", mine, queue: null })
        : holder;
    }
    const read = staffPageRows(
      rowsOf(await attempt(() => reads.queue(grantState, staffOffsetOf(page)))),
      readQueued,
      page,
    );
    if (read === null || read.rows.some((row) => row.state !== grantState)) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      status: "ready",
      mine,
      queue: Object.freeze({
        grantState,
        grants: read.rows,
        pager: read.pager,
      }),
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// The break-glass access
// ---------------------------------------------------------------------------

const NOT_ACTIVE = Object.freeze({ status: "not-active" } as const);

export type BreakGlassAccessView =
  | {
      readonly status: "ready";
      readonly consultation: BreakGlassConsultation;
    }
  | typeof NOT_ACTIVE
  | Refusal;

// The read-only view of the Consultation the caller's own active grant names
// (the database audits each access). A malformed id, an unknown one, another
// staff member's grant and one that is not active answer alike.
export async function resolveBreakGlassAccess(
  sources: BreakGlassSources,
  grantId: unknown,
): Promise<BreakGlassAccessView> {
  try {
    const staff = await verifiedActiveStaff(sources.staff);
    if (!("userId" in staff)) {
      return staff;
    }
    if (!isUuid(grantId)) {
      return NOT_ACTIVE;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const rows = rowsOf(await attempt(() => reads.access(grantId)));
    if (rows === null || rows.length > 1) {
      return UNAVAILABLE;
    }
    if (rows.length === 0) {
      return NOT_ACTIVE;
    }
    const consultation = readAccess(rows[0]);
    return consultation === null || consultation.grantId !== grantId
      ? UNAVAILABLE
      : Object.freeze({ status: "ready", consultation });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Requesting, approving and revoking
// ---------------------------------------------------------------------------

export const GRANT_ACTION_OUTCOMES = Object.freeze([
  "access_requested",
  "already_requested",
  "access_approved",
  "own_request",
  "request_refused",
  "access_ended",
  "already_active",
  "already_expired",
  "already_revoked",
  "not_found",
] as const);
export type GrantActionOutcome = (typeof GRANT_ACTION_OUTCOMES)[number];
export type GrantActionState = ActionState<GrantActionOutcome>;
export const INITIAL_GRANT_STATE: GrantActionState = IDLE;

const REQUEST_TABLE: Readonly<Record<string, GrantActionOutcome>> =
  Object.freeze({
    requested: "access_requested",
    existing: "already_requested",
    not_found: "not_found",
  });
const APPROVE_TABLE: Readonly<Record<string, GrantActionOutcome>> =
  Object.freeze({
    approved: "access_approved",
    not_found: "not_found",
    own_request: "own_request",
    already_active: "already_active",
    already_expired: "already_expired",
    already_revoked: "already_revoked",
  });
const REVOKE_TABLE: Readonly<Record<string, GrantActionOutcome>> =
  Object.freeze({
    refused: "request_refused",
    ended: "access_ended",
    not_found: "not_found",
    already_revoked: "already_revoked",
    already_expired: "already_expired",
  });

async function grantChange(
  sources: BreakGlassSources,
  admit: () => Promise<{ readonly userId: string } | Refusal>,
  call: (writes: BreakGlassWrites) => Promise<CommandAnswer>,
  table: Readonly<Record<string, GrantActionOutcome>>,
): Promise<GrantActionState> {
  const staff = await admit();
  if (!("userId" in staff)) {
    return staff;
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

// Requests access to one Consultation (its identifier and a reason: required,
// at most 2,000 characters, kept on the grant only).
export async function requestBreakGlass(
  sources: BreakGlassSources,
  formData: unknown,
): Promise<GrantActionState> {
  try {
    const fields = formFieldsOf(formData, ["consultation", "reason"]);
    const consultationId = fields?.get("consultation")?.trim().toLowerCase();
    const reason = textField(fields?.get("reason"), MAX_REASON);
    if (!isUuid(consultationId) || reason === null || reason === "") {
      return INVALID;
    }
    return await grantChange(
      sources,
      () => verifiedActiveStaff(sources.staff),
      (writes) => writes.request(consultationId, reason),
      REQUEST_TABLE,
    );
  } catch {
    return UNAVAILABLE;
  }
}

// Approves a requested grant for a duration in whole minutes (1 to 1,440;
// there is no default).
export async function approveBreakGlass(
  sources: BreakGlassSources,
  formData: unknown,
): Promise<GrantActionState> {
  try {
    const fields = formFieldsOf(formData, ["grant", "minutes"]);
    const grantId = fields?.get("grant");
    const minutesText = fields?.get("minutes")?.trim() ?? "";
    const minutes = /^[1-9][0-9]{0,3}$/.test(minutesText)
      ? Number(minutesText)
      : NaN;
    if (
      !isUuid(grantId) ||
      !Number.isSafeInteger(minutes) ||
      minutes < 1 ||
      minutes > MAX_DURATION_MINUTES
    ) {
      return INVALID;
    }
    return await grantChange(
      sources,
      () => verifiedStaffWithAny(sources.staff, BREAK_GLASS_CAPABILITY),
      (writes) => writes.approve(grantId, minutes * 60),
      APPROVE_TABLE,
    );
  } catch {
    return UNAVAILABLE;
  }
}

// Revokes a grant: refuses a request or ends an active access.
export async function revokeBreakGlass(
  sources: BreakGlassSources,
  formData: unknown,
): Promise<GrantActionState> {
  try {
    const grantId = formFieldsOf(formData, ["grant"])?.get("grant");
    if (!isUuid(grantId)) {
      return INVALID;
    }
    return await grantChange(
      sources,
      () => verifiedStaffWithAny(sources.staff, BREAK_GLASS_CAPABILITY),
      (writes) => writes.revoke(grantId),
      REVOKE_TABLE,
    );
  } catch {
    return UNAVAILABLE;
  }
}

export function breakGlassPathFor(grantId: string): string {
  if (!isUuid(grantId)) {
    throw new Error("not a break-glass grant identifier");
  }
  return `/staff/break-glass/${grantId}`;
}
