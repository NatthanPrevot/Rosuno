// Staff operations workspaces (MVP-001 S11 pass 2; MBS sections 16
// "Operations" and 18.4; TA sections 18, 40 and 41; IMP section 27 exit).
//
// Provider-neutral and injectable: each request hands in its own ports. The
// read-only operations surfaces: the audit workspace (view_audit_events, by
// jurisdiction), the counts-only operations dashboard and system health
// (view_operations, global grant), referral operations
// (view_referral_operations, by jurisdiction) and the financial activity
// summary (manage_financial_operations, global grant). The application only
// refuses early (a missing sign-in, a missing capability, a malformed query)
// and reads strictly; the database decides access and scope again for every
// row and audits every audit read. Nothing here writes anything.

import {
  bindEnvironment,
  type EnvironmentBinding,
  type EnvironmentConfiguration,
} from "./environment-binding.ts";
import {
  attempt,
  portFrom,
  rowsOf,
  UNAVAILABLE,
  type Refusal,
  type RowsResult,
} from "./professional-identity.ts";
import {
  isDate,
  isOneOf,
  isTimestamp,
  isUuid,
  readExact,
  readRows,
} from "./professional-records.ts";
import {
  verifiedStaffWith,
  verifiedStaffWithAny,
  type ConfigurationSources,
  type StaffCapability,
} from "./staff-configuration.ts";
import {
  isCode,
  staffOffsetOf,
  staffPageOf,
  staffPageRows,
  type StaffPager,
} from "./workspace-support.ts";

export const AUDIT_CAPABILITY: StaffCapability = "view_audit_events";
export const OPERATIONS_CAPABILITY: StaffCapability = "view_operations";
export const REFERRAL_CAPABILITY: StaffCapability = "view_referral_operations";
export const FINANCE_SUMMARY_CAPABILITY: StaffCapability =
  "manage_financial_operations";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type AuditQuery = {
  readonly from: string | null;
  readonly until: string | null;
  readonly actionCode: string | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly performerType: string | null;
  readonly performerId: string | null;
  readonly securityOnly: boolean;
};

export type OperationsReads = {
  // staff_audit_events(p_from, p_until, p_action_code, p_resource_type,
  // p_resource_id, p_performer_type, p_performer_id, p_security_only,
  // p_offset)
  readonly auditEvents: (
    query: AuditQuery,
    offset: number,
  ) => Promise<RowsResult>;
  // staff_audit_event(p_audit_event_id)
  readonly auditEvent: (eventId: string) => Promise<RowsResult>;
  // staff_operations_summary()
  readonly operationsSummary: () => Promise<RowsResult>;
  // staff_referrals(p_offset)
  readonly referrals: (offset: number) => Promise<RowsResult>;
  // staff_referral_counts()
  readonly referralCounts: () => Promise<RowsResult>;
  // staff_finance_summary(p_from, p_until, p_jurisdiction_id)
  readonly financeSummary: (
    from: string,
    until: string,
    jurisdictionId: string | null,
  ) => Promise<RowsResult>;
  // staff_jurisdiction_names()
  readonly jurisdictionNames: () => Promise<RowsResult>;
  // deployment_environment_identity()
  readonly environmentIdentity: () => Promise<RowsResult>;
};

// The provider areas whose configuration system health reports: only
// whether the server settings have their declared shape, never a value.
export const PROVIDER_AREAS = Object.freeze([
  "payments",
  "media",
  "email",
  "ai",
] as const);
export type ProviderArea = (typeof PROVIDER_AREAS)[number];
export type ProviderStatus = "configured" | "not_configured";

export type OperationsSources = {
  readonly staff: ConfigurationSources;
  readonly reads: () => Promise<OperationsReads | null>;
  readonly environment: () => EnvironmentConfiguration;
  readonly providers: () => Readonly<Record<ProviderArea, ProviderStatus>>;
};

// ---------------------------------------------------------------------------
// Shared readers
// ---------------------------------------------------------------------------

const AUDIT_CODE = /^[a-z][a-z0-9_.:-]{0,99}$/;
const DOTTED_CODE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const JURISDICTION_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;
const DAY_MS = 86_400_000;
const MAX_PERIOD_DAYS = 366;

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isAmount = (value: unknown): value is number =>
  Number.isSafeInteger(value);
const isOptionalUuid = (value: unknown): value is string | null =>
  value === null || isUuid(value);
const isOptionalTimestamp = (value: unknown): value is string | null =>
  value === null || isTimestamp(value);
const isAuditCode = (value: unknown): value is string =>
  typeof value === "string" && AUDIT_CODE.test(value);

export type JurisdictionNames = ReadonlyMap<string, string>;

function readJurisdictionName(
  row: unknown,
): { readonly id: string; readonly label: string } | null {
  const f = readExact(row, ["jurisdiction_id", "code", "name"]);
  const id = f?.get("jurisdiction_id");
  const code = f?.get("code");
  const name = f?.get("name");
  if (
    !isUuid(id) ||
    typeof code !== "string" ||
    !JURISDICTION_CODE.test(code) ||
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 200
  ) {
    return null;
  }
  return Object.freeze({ id, label: `${name} (${code})` });
}

// The names of the jurisdictions, read strictly (every row or none), or null.
export async function jurisdictionNamesOf(
  read: () => Promise<RowsResult>,
): Promise<JurisdictionNames | null> {
  const rows = rowsOf(await attempt(read));
  if (rows === null || rows.length > 500) {
    return null;
  }
  const names = readRows(rows, readJurisdictionName);
  return names === null
    ? null
    : new Map(names.map((entry) => [entry.id, entry.label]));
}

// The label of a jurisdiction id: its name, or the id itself when unnamed.
export function jurisdictionLabel(
  names: JurisdictionNames,
  id: string | null,
): string {
  if (id === null) {
    return "No jurisdiction";
  }
  return names.get(id) ?? id;
}

function single(value: unknown): string | null {
  if (Array.isArray(value)) {
    return null;
  }
  return typeof value === "string" ? value.trim() : "";
}

async function context(
  sources: OperationsSources,
  capability: StaffCapability,
  scope: "global" | "any",
): Promise<{ readonly reads: OperationsReads } | Refusal> {
  const staff =
    scope === "global"
      ? await verifiedStaffWith(sources.staff, capability)
      : await verifiedStaffWithAny(sources.staff, capability);
  if (!("userId" in staff)) {
    return staff;
  }
  const reads = await portFrom(sources.reads);
  return reads === null ? UNAVAILABLE : { reads };
}

// ---------------------------------------------------------------------------
// The audit workspace
// ---------------------------------------------------------------------------

export type AuditFilterValues = {
  readonly from: string;
  readonly until: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resource: string;
  readonly performerType: string;
  readonly performer: string;
  readonly security: boolean;
};

const EMPTY_FILTERS: AuditFilterValues = Object.freeze({
  from: "",
  until: "",
  action: "",
  resourceType: "",
  resource: "",
  performerType: "",
  performer: "",
  security: false,
});

// The submitted filter values as typed (for the form), the query they make,
// or null when one of them is malformed. Dates are whole UTC days; the end
// day is included.
export function auditQueryOf(search: unknown): {
  readonly values: AuditFilterValues;
  readonly query: AuditQuery | null;
} {
  const get = (key: string): string | null => {
    if (search === null || typeof search !== "object") {
      return "";
    }
    const descriptor = Object.getOwnPropertyDescriptor(search, key);
    return single(
      descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : undefined,
    );
  };
  const raw = {
    from: get("from"),
    until: get("until"),
    action: get("action"),
    resourceType: get("resource_type"),
    resource: get("resource"),
    performerType: get("performer_type"),
    performer: get("performer"),
    security: get("security"),
  };
  if (Object.values(raw).some((value) => value === null)) {
    return { values: EMPTY_FILTERS, query: null };
  }
  const v = raw as Record<keyof typeof raw, string>;
  const values: AuditFilterValues = Object.freeze({
    from: v.from.slice(0, 10),
    until: v.until.slice(0, 10),
    action: v.action.slice(0, 100),
    resourceType: v.resourceType.slice(0, 64),
    resource: v.resource.slice(0, 36).toLowerCase(),
    performerType: v.performerType.slice(0, 64),
    performer: v.performer.slice(0, 36).toLowerCase(),
    security: v.security === "yes",
  });
  const fromOk = v.from === "" || isDate(v.from);
  const untilOk = v.until === "" || isDate(v.until);
  const from = fromOk && v.from !== "" ? `${v.from}T00:00:00.000Z` : null;
  const until =
    untilOk && v.until !== ""
      ? new Date(Date.parse(`${v.until}T00:00:00.000Z`) + DAY_MS).toISOString()
      : null;
  if (
    !fromOk ||
    !untilOk ||
    (from !== null &&
      until !== null &&
      Date.parse(until) <= Date.parse(from)) ||
    (v.action !== "" &&
      (v.action.length > 100 || !DOTTED_CODE.test(v.action))) ||
    (v.resourceType !== "" && !isCode(v.resourceType)) ||
    (v.resource !== "" && !isUuid(v.resource.toLowerCase())) ||
    (v.performerType !== "" && !isCode(v.performerType)) ||
    (v.performer !== "" && !isUuid(v.performer.toLowerCase())) ||
    !(v.security === "" || v.security === "yes")
  ) {
    return { values, query: null };
  }
  return {
    values,
    query: Object.freeze({
      from,
      until,
      actionCode: v.action === "" ? null : v.action,
      resourceType: v.resourceType === "" ? null : v.resourceType,
      resourceId: v.resource === "" ? null : v.resource.toLowerCase(),
      performerType: v.performerType === "" ? null : v.performerType,
      performerId: v.performer === "" ? null : v.performer.toLowerCase(),
      securityOnly: v.security === "yes",
    }),
  };
}

export const AUDIT_EVENT_COLUMNS = Object.freeze([
  "audit_event_id",
  "occurred_at",
  "actor_type",
  "actor_user_id",
  "action_code",
  "resource_type",
  "resource_id",
  "jurisdiction_id",
  "reason_code",
]);

export type AuditEventRow = {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorType: string;
  readonly actorUserId: string | null;
  readonly actionCode: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly jurisdictionId: string | null;
  readonly reasonCode: string | null;
};

function readAuditEvent(row: unknown): AuditEventRow | null {
  const f = readExact(row, AUDIT_EVENT_COLUMNS);
  if (f === null) {
    return null;
  }
  const value = {
    id: f.get("audit_event_id"),
    occurredAt: f.get("occurred_at"),
    actorType: f.get("actor_type"),
    actorUserId: f.get("actor_user_id"),
    actionCode: f.get("action_code"),
    resourceType: f.get("resource_type"),
    resourceId: f.get("resource_id"),
    jurisdictionId: f.get("jurisdiction_id"),
    reasonCode: f.get("reason_code"),
  };
  if (
    !isUuid(value.id) ||
    !isTimestamp(value.occurredAt) ||
    !isAuditCode(value.actorType) ||
    !isOptionalUuid(value.actorUserId) ||
    !isAuditCode(value.actionCode) ||
    !isAuditCode(value.resourceType) ||
    !isOptionalUuid(value.resourceId) ||
    !isOptionalUuid(value.jurisdictionId) ||
    !(
      value.reasonCode === null ||
      (typeof value.reasonCode === "string" &&
        value.reasonCode.length > 0 &&
        value.reasonCode.length <= 200)
    )
  ) {
    return null;
  }
  return Object.freeze(value) as AuditEventRow;
}

export type AuditEventsView =
  | {
      readonly status: "ready";
      readonly values: AuditFilterValues;
      readonly filtersValid: boolean;
      readonly events: readonly AuditEventRow[];
      readonly pager: StaffPager;
      readonly names: JurisdictionNames;
    }
  | Refusal;

// One page of audit events for the filters the query names. Malformed
// filters read nothing and say so; the database audits each read.
export async function resolveAuditEvents(
  sources: OperationsSources,
  search: unknown,
): Promise<AuditEventsView> {
  try {
    const { values, query } = auditQueryOf(search);
    const page = staffPageOf(
      search !== null && typeof search === "object"
        ? Object.getOwnPropertyDescriptor(search, "page")?.value
        : undefined,
    );
    const staff = await context(sources, AUDIT_CAPABILITY, "any");
    if (!("reads" in staff)) {
      return staff;
    }
    const names = await jurisdictionNamesOf(() =>
      staff.reads.jurisdictionNames(),
    );
    if (names === null) {
      return UNAVAILABLE;
    }
    if (query === null) {
      return Object.freeze({
        status: "ready",
        values,
        filtersValid: false,
        events: Object.freeze([]),
        pager: Object.freeze({ page: 1, hasNext: false }),
        names,
      });
    }
    const read = staffPageRows(
      rowsOf(
        await attempt(() =>
          staff.reads.auditEvents(query, staffOffsetOf(page)),
        ),
      ),
      readAuditEvent,
      page,
    );
    if (read === null) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      status: "ready",
      values,
      filtersValid: true,
      events: read.rows,
      pager: read.pager,
      names,
    });
  } catch {
    return UNAVAILABLE;
  }
}

export type AuditEventDetail = AuditEventRow & {
  readonly createdAt: string;
  readonly beforeSnapshot: string | null;
  readonly afterSnapshot: string | null;
  readonly policyReferences: string | null;
};

// A recorded JSON value as indented text, exactly as the database answers it
// (bounded; MVP-001 S11 correction R4: the database redacts free text).
function snapshotText(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  try {
    const text = JSON.stringify(value, null, 2);
    return typeof text === "string" && text.length <= 200_000
      ? text
      : undefined;
  } catch {
    return undefined;
  }
}

export type AuditEventView =
  | {
      readonly status: "ready";
      readonly event: AuditEventDetail | null;
      readonly names: JurisdictionNames;
    }
  | Refusal;

// One audit event with its recorded snapshots; an unknown id, one outside
// the caller's scope and a malformed one alike show nothing.
export async function resolveAuditEvent(
  sources: OperationsSources,
  eventValue: unknown,
): Promise<AuditEventView> {
  try {
    const staff = await context(sources, AUDIT_CAPABILITY, "any");
    if (!("reads" in staff)) {
      return staff;
    }
    const names = await jurisdictionNamesOf(() =>
      staff.reads.jurisdictionNames(),
    );
    if (names === null) {
      return UNAVAILABLE;
    }
    const eventId =
      typeof eventValue === "string" ? eventValue.toLowerCase() : null;
    if (!isUuid(eventId)) {
      return Object.freeze({ status: "ready", event: null, names });
    }
    const rows = rowsOf(await attempt(() => staff.reads.auditEvent(eventId)));
    if (rows === null || rows.length > 1) {
      return UNAVAILABLE;
    }
    if (rows.length === 0) {
      return Object.freeze({ status: "ready", event: null, names });
    }
    const keys = [
      ...AUDIT_EVENT_COLUMNS,
      "created_at",
      "before_snapshot",
      "after_snapshot",
      "policy_references",
    ];
    const f = readExact(rows[0], keys);
    if (f === null) {
      return UNAVAILABLE;
    }
    const base = readAuditEvent(
      Object.fromEntries(AUDIT_EVENT_COLUMNS.map((key) => [key, f.get(key)])),
    );
    const createdAt = f.get("created_at");
    const before = snapshotText(f.get("before_snapshot"));
    const after = snapshotText(f.get("after_snapshot"));
    const references = snapshotText(f.get("policy_references"));
    if (
      base === null ||
      base.id !== eventId ||
      !isTimestamp(createdAt) ||
      before === undefined ||
      after === undefined ||
      references === undefined
    ) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      status: "ready",
      event: Object.freeze({
        ...base,
        createdAt,
        beforeSnapshot: before,
        afterSnapshot: after,
        policyReferences: references,
      }),
      names,
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// The operations dashboard and system health
// ---------------------------------------------------------------------------

export const JOB_STATES = Object.freeze([
  "pending",
  "running",
  "completed",
  "escalated",
  "cancelled",
] as const);
export const REVIEW_FAMILY_NAMES = Object.freeze([
  "financial",
  "compliance",
  "operations",
] as const);
export const SEVERITIES = Object.freeze([
  "critical",
  "high",
  "medium",
  "low",
] as const);
export const SWEEPS = Object.freeze([
  "rosuno_operational_jobs_sweep",
  "rosuno_intake_expiry_sweep",
  "rosuno_scheduling_expiry_sweep",
  "rosuno_request_expiry_sweep",
  "rosuno_consultation_media_sweep",
] as const);
export type Sweep = (typeof SWEEPS)[number];
export const ENVIRONMENT_CLASS_VALUES = Object.freeze([
  "development",
  "staging",
  "production",
  "unrecorded",
] as const);
export type EnvironmentClassValue = (typeof ENVIRONMENT_CLASS_VALUES)[number];
export const ENVIRONMENT_STATUSES = Object.freeze([
  "ok",
  "environment_unrecorded",
  "environment_mismatch",
] as const);
export type EnvironmentStatus = (typeof ENVIRONMENT_STATUSES)[number];

// Each counted metric and its exact dimensions, in the database's order.
export const SUMMARY_DIMENSIONS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    jobs: JOB_STATES,
    notifications: Object.freeze(["retrying", "permanently_failed"]),
    review_exceptions: Object.freeze(
      REVIEW_FAMILY_NAMES.flatMap((family) =>
        SEVERITIES.map((severity) => `${family}.${severity}`),
      ),
    ),
    consultations: Object.freeze(["ready", "live", "stale"]),
    requests: Object.freeze([
      "created",
      "payment_authorized",
      "slot_held",
      "awaiting_attorney",
    ]),
    payments: Object.freeze([
      "pending_authorization",
      "release_pending",
      "capture_pending",
      "refund_pending",
    ]),
    attorney_profiles: Object.freeze(["under_review"]),
    jurisdictions: Object.freeze([
      "unsupported",
      "waitlist",
      "staged",
      "ready",
      "live",
      "restricted",
      "suspended",
    ]),
    scheduler: Object.freeze(["pg_cron", ...SWEEPS]),
  });
export type SummaryMetric = keyof typeof SUMMARY_DIMENSIONS;

export type SummaryCount = {
  readonly dimension: string;
  readonly value: number;
  readonly oldestAt: string | null;
};

export type OperationsSummary = {
  readonly counts: Readonly<Record<string, readonly SummaryCount[]>>;
  readonly environmentClass: EnvironmentClassValue;
  readonly environmentStatus: EnvironmentStatus;
};

// The summary rows read strictly: every metric's dimensions exactly once in
// order, the two environment rows once each; anything else is unreadable.
export function readOperationsSummary(
  rows: readonly unknown[] | null,
): OperationsSummary | null {
  if (rows === null) {
    return null;
  }
  const counts: Record<string, SummaryCount[]> = {};
  let environmentClass: unknown = undefined;
  let environmentStatus: unknown = undefined;
  for (const row of rows) {
    const f = readExact(row, ["metric", "dimension", "value", "oldest_at"]);
    const metric = f?.get("metric");
    const dimension = f?.get("dimension");
    const value = f?.get("value");
    const oldestAt = f?.get("oldest_at");
    if (
      f === null ||
      typeof metric !== "string" ||
      typeof dimension !== "string" ||
      !isCount(value) ||
      !isOptionalTimestamp(oldestAt)
    ) {
      return null;
    }
    if (metric === "environment_class" || metric === "environment_status") {
      const known =
        metric === "environment_class"
          ? isOneOf(ENVIRONMENT_CLASS_VALUES, dimension)
          : isOneOf(ENVIRONMENT_STATUSES, dimension);
      const seen =
        metric === "environment_class" ? environmentClass : environmentStatus;
      if (!known || value !== 1 || oldestAt !== null || seen !== undefined) {
        return null;
      }
      if (metric === "environment_class") {
        environmentClass = dimension;
      } else {
        environmentStatus = dimension;
      }
      continue;
    }
    if (!Object.hasOwn(SUMMARY_DIMENSIONS, metric)) {
      return null;
    }
    const list = (counts[metric] ??= []);
    if (SUMMARY_DIMENSIONS[metric][list.length] !== dimension) {
      return null;
    }
    if (metric === "scheduler" && value > 1) {
      return null;
    }
    list.push(Object.freeze({ dimension, value, oldestAt }));
  }
  for (const [metric, dimensions] of Object.entries(SUMMARY_DIMENSIONS)) {
    if ((counts[metric]?.length ?? 0) !== dimensions.length) {
      return null;
    }
  }
  if (environmentClass === undefined || environmentStatus === undefined) {
    return null;
  }
  return Object.freeze({
    counts: Object.freeze(
      Object.fromEntries(
        Object.entries(counts).map(([key, list]) => [key, Object.freeze(list)]),
      ),
    ),
    environmentClass: environmentClass as EnvironmentClassValue,
    environmentStatus: environmentStatus as EnvironmentStatus,
  });
}

export type OperationsView =
  { readonly status: "ready"; readonly summary: OperationsSummary } | Refusal;

export async function resolveOperationsDashboard(
  sources: OperationsSources,
): Promise<OperationsView> {
  try {
    const staff = await context(sources, OPERATIONS_CAPABILITY, "global");
    if (!("reads" in staff)) {
      return staff;
    }
    const summary = readOperationsSummary(
      rowsOf(await attempt(() => staff.reads.operationsSummary())),
    );
    return summary === null
      ? UNAVAILABLE
      : Object.freeze({ status: "ready", summary });
  } catch {
    return UNAVAILABLE;
  }
}

export type SystemHealthView =
  | {
      readonly status: "ready";
      readonly summary: OperationsSummary;
      readonly binding: EnvironmentBinding;
      readonly providers: Readonly<Record<ProviderArea, ProviderStatus>>;
    }
  | Refusal;

// System health: the database's recorded environment and scheduler facts,
// whether this deployment's settings match the database's record, and
// whether each provider's settings have their declared shape (never a
// value). Hosted checks are not made here.
export async function resolveSystemHealth(
  sources: OperationsSources,
): Promise<SystemHealthView> {
  try {
    const staff = await context(sources, OPERATIONS_CAPABILITY, "global");
    if (!("reads" in staff)) {
      return staff;
    }
    const summary = readOperationsSummary(
      rowsOf(await attempt(() => staff.reads.operationsSummary())),
    );
    if (summary === null) {
      return UNAVAILABLE;
    }
    const binding = bindEnvironment(
      rowsOf(await attempt(() => staff.reads.environmentIdentity())),
      sources.environment(),
    );
    const reported = sources.providers();
    const providers = Object.freeze(
      Object.fromEntries(
        PROVIDER_AREAS.map((area) => [
          area,
          reported[area] === "configured" ? "configured" : "not_configured",
        ]),
      ) as Record<ProviderArea, ProviderStatus>,
    );
    return Object.freeze({ status: "ready", summary, binding, providers });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Referral operations
// ---------------------------------------------------------------------------

export const REFERRAL_COLUMNS = Object.freeze([
  "referral_id",
  "jurisdiction_id",
  "attempt_ordinal",
  "allocation_method",
  "created_at",
  "outcome_code",
  "outcome_recorded_at",
  "consultation_request_id",
  "request_state",
  "consultation_id",
  "consultation_state",
]);
export const ALLOCATION_METHODS = Object.freeze([
  "client_selected",
  "allocated",
] as const);
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
export const REFERRAL_COUNT_METRICS = Object.freeze([
  "open",
  "ended_without_request",
  "request_expired",
  "request_declined",
] as const);
export type ReferralCountMetric = (typeof REFERRAL_COUNT_METRICS)[number];

export type ReferralRow = {
  readonly id: string;
  readonly jurisdictionId: string;
  readonly attemptOrdinal: number;
  readonly allocationMethod: (typeof ALLOCATION_METHODS)[number];
  readonly createdAt: string;
  readonly outcomeCode: string | null;
  readonly outcomeRecordedAt: string | null;
  readonly requestId: string | null;
  readonly requestState: (typeof REQUEST_STATES)[number] | null;
  readonly consultationId: string | null;
  readonly consultationState: (typeof CONSULTATION_STATES)[number] | null;
};

function readReferral(row: unknown): ReferralRow | null {
  const f = readExact(row, REFERRAL_COLUMNS);
  if (f === null) {
    return null;
  }
  const value = {
    id: f.get("referral_id"),
    jurisdictionId: f.get("jurisdiction_id"),
    attemptOrdinal: f.get("attempt_ordinal"),
    allocationMethod: f.get("allocation_method"),
    createdAt: f.get("created_at"),
    outcomeCode: f.get("outcome_code"),
    outcomeRecordedAt: f.get("outcome_recorded_at"),
    requestId: f.get("consultation_request_id"),
    requestState: f.get("request_state"),
    consultationId: f.get("consultation_id"),
    consultationState: f.get("consultation_state"),
  };
  if (
    !isUuid(value.id) ||
    !isUuid(value.jurisdictionId) ||
    !(isCount(value.attemptOrdinal) && value.attemptOrdinal >= 1) ||
    !isOneOf(ALLOCATION_METHODS, value.allocationMethod) ||
    !isTimestamp(value.createdAt) ||
    !(value.outcomeCode === null || isCode(value.outcomeCode)) ||
    !isOptionalTimestamp(value.outcomeRecordedAt) ||
    (value.outcomeCode === null) !== (value.outcomeRecordedAt === null) ||
    !isOptionalUuid(value.requestId) ||
    !(
      value.requestState === null || isOneOf(REQUEST_STATES, value.requestState)
    ) ||
    (value.requestId === null) !== (value.requestState === null) ||
    !isOptionalUuid(value.consultationId) ||
    !(
      value.consultationState === null ||
      isOneOf(CONSULTATION_STATES, value.consultationState)
    ) ||
    (value.consultationId === null) !== (value.consultationState === null) ||
    (value.consultationId !== null && value.requestId === null)
  ) {
    return null;
  }
  return Object.freeze(value) as ReferralRow;
}

export type ReferralOperationsView =
  | {
      readonly status: "ready";
      readonly counts: Readonly<Record<ReferralCountMetric, number>>;
      readonly referrals: readonly ReferralRow[];
      readonly pager: StaffPager;
      readonly names: JurisdictionNames;
    }
  | Refusal;

export async function resolveReferralOperations(
  sources: OperationsSources,
  pageValue: unknown,
): Promise<ReferralOperationsView> {
  try {
    const page = staffPageOf(pageValue);
    const staff = await context(sources, REFERRAL_CAPABILITY, "any");
    if (!("reads" in staff)) {
      return staff;
    }
    const [names, countRows, listRows] = await Promise.all([
      jurisdictionNamesOf(() => staff.reads.jurisdictionNames()),
      attempt(() => staff.reads.referralCounts()),
      attempt(() => staff.reads.referrals(staffOffsetOf(page))),
    ]);
    const countList = rowsOf(countRows);
    const read = staffPageRows(rowsOf(listRows), readReferral, page);
    if (
      names === null ||
      read === null ||
      countList === null ||
      countList.length !== REFERRAL_COUNT_METRICS.length
    ) {
      return UNAVAILABLE;
    }
    const counts: Partial<Record<ReferralCountMetric, number>> = {};
    for (const [index, row] of countList.entries()) {
      const f = readExact(row, ["metric", "value"]);
      if (
        f?.get("metric") !== REFERRAL_COUNT_METRICS[index] ||
        !isCount(f?.get("value"))
      ) {
        return UNAVAILABLE;
      }
      counts[REFERRAL_COUNT_METRICS[index]] = f.get("value") as number;
    }
    return Object.freeze({
      status: "ready",
      counts: Object.freeze(counts) as Record<ReferralCountMetric, number>,
      referrals: read.rows,
      pager: read.pager,
      names,
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// The financial activity summary
// ---------------------------------------------------------------------------

export const LEDGER_ENTRY_TYPES = Object.freeze([
  "client_payment",
  "attorney_share",
  "platform_fee",
  "client_fee",
  "other_required_fee",
] as const);
export const LEDGER_DIRECTIONS = Object.freeze(["debit", "credit"] as const);
export const PAYMENT_STATES = Object.freeze([
  "pending_authorization",
  "authorized",
  "failed",
  "cancelled",
  "release_pending",
  "authorization_released",
  "capture_pending",
  "captured",
  "capture_failed",
  "refund_pending",
  "partially_refunded",
  "fully_refunded",
  "charged_back",
] as const);

export type LedgerTotal = {
  readonly entryType: (typeof LEDGER_ENTRY_TYPES)[number];
  readonly direction: (typeof LEDGER_DIRECTIONS)[number];
  readonly currency: string;
  readonly amountMinor: number;
};

export type FinanceSummary = {
  readonly ledger: readonly LedgerTotal[];
  readonly payments: readonly {
    readonly state: (typeof PAYMENT_STATES)[number];
    readonly count: number;
  }[];
  readonly refunds: number;
  readonly disputes: number;
};

export type FinancePeriodValues = {
  readonly from: string;
  readonly until: string;
  readonly jurisdiction: string;
};

// The chosen period (whole UTC days, the end day included, at most 366 days)
// and optional jurisdiction, or why it cannot be read.
export function financePeriodOf(search: unknown): {
  readonly values: FinancePeriodValues;
  readonly period:
    | {
        readonly from: string;
        readonly until: string;
        readonly jurisdictionId: string | null;
      }
    | "none"
    | "invalid";
} {
  const get = (key: string): string | null => {
    if (search === null || typeof search !== "object") {
      return "";
    }
    return single(Object.getOwnPropertyDescriptor(search, key)?.value);
  };
  const from = get("from");
  const until = get("until");
  const jurisdiction = get("jurisdiction");
  if (from === null || until === null || jurisdiction === null) {
    return {
      values: Object.freeze({ from: "", until: "", jurisdiction: "" }),
      period: "invalid",
    };
  }
  const values = Object.freeze({
    from: from.slice(0, 10),
    until: until.slice(0, 10),
    jurisdiction: jurisdiction.slice(0, 36).toLowerCase(),
  });
  if (from === "" && until === "" && jurisdiction === "") {
    return { values, period: "none" };
  }
  if (
    !isDate(from) ||
    !isDate(until) ||
    !(jurisdiction === "" || isUuid(jurisdiction.toLowerCase()))
  ) {
    return { values, period: "invalid" };
  }
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${until}T00:00:00.000Z`) + DAY_MS;
  if (end <= start || end - start > MAX_PERIOD_DAYS * DAY_MS) {
    return { values, period: "invalid" };
  }
  return {
    values,
    period: Object.freeze({
      from: new Date(start).toISOString(),
      until: new Date(end).toISOString(),
      jurisdictionId: jurisdiction === "" ? null : jurisdiction.toLowerCase(),
    }),
  };
}

export function readFinanceSummary(
  rows: readonly unknown[] | null,
): FinanceSummary | null {
  if (rows === null) {
    return null;
  }
  const ledger: LedgerTotal[] = [];
  const payments: { state: (typeof PAYMENT_STATES)[number]; count: number }[] =
    [];
  let refunds: number | null = null;
  let disputes: number | null = null;
  for (const row of rows) {
    const f = readExact(row, ["metric", "dimension", "currency_code", "value"]);
    const metric = f?.get("metric");
    const dimension = f?.get("dimension");
    const currency = f?.get("currency_code");
    const value = f?.get("value");
    if (f === null || typeof dimension !== "string") {
      return null;
    }
    if (metric === "ledger") {
      const [entryType, direction, extra] = dimension.split(".");
      if (
        extra !== undefined ||
        !isOneOf(LEDGER_ENTRY_TYPES, entryType) ||
        !isOneOf(LEDGER_DIRECTIONS, direction) ||
        typeof currency !== "string" ||
        !/^[A-Z]{3}$/.test(currency) ||
        !isAmount(value) ||
        value < 0 ||
        ledger.some(
          (entry) =>
            entry.entryType === entryType &&
            entry.direction === direction &&
            entry.currency === currency,
        )
      ) {
        return null;
      }
      ledger.push(
        Object.freeze({ entryType, direction, currency, amountMinor: value }),
      );
    } else if (metric === "payments") {
      if (
        PAYMENT_STATES[payments.length] !== dimension ||
        currency !== null ||
        !isCount(value)
      ) {
        return null;
      }
      payments.push(
        Object.freeze({
          state: dimension as (typeof PAYMENT_STATES)[number],
          count: value,
        }),
      );
    } else if (
      metric === "refunds" &&
      dimension === "posted" &&
      currency === null &&
      isCount(value) &&
      refunds === null
    ) {
      refunds = value;
    } else if (
      metric === "disputes" &&
      dimension === "opened" &&
      currency === null &&
      isCount(value) &&
      disputes === null
    ) {
      disputes = value;
    } else {
      return null;
    }
  }
  if (
    payments.length !== PAYMENT_STATES.length ||
    refunds === null ||
    disputes === null
  ) {
    return null;
  }
  return Object.freeze({
    ledger: Object.freeze(ledger),
    payments: Object.freeze(payments),
    refunds,
    disputes,
  });
}

export type FinanceSummaryView =
  | {
      readonly status: "ready";
      readonly values: FinancePeriodValues;
      readonly period: "none" | "invalid" | "read";
      readonly summary: FinanceSummary | null;
      readonly names: JurisdictionNames;
    }
  | Refusal;

export async function resolveFinanceSummary(
  sources: OperationsSources,
  search: unknown,
): Promise<FinanceSummaryView> {
  try {
    const { values, period } = financePeriodOf(search);
    const staff = await context(sources, FINANCE_SUMMARY_CAPABILITY, "global");
    if (!("reads" in staff)) {
      return staff;
    }
    const names = await jurisdictionNamesOf(() =>
      staff.reads.jurisdictionNames(),
    );
    if (names === null) {
      return UNAVAILABLE;
    }
    if (period === "none" || period === "invalid") {
      return Object.freeze({
        status: "ready",
        values,
        period,
        summary: null,
        names,
      });
    }
    const summary = readFinanceSummary(
      rowsOf(
        await attempt(() =>
          staff.reads.financeSummary(
            period.from,
            period.until,
            period.jurisdictionId,
          ),
        ),
      ),
    );
    if (summary === null) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      status: "ready",
      values,
      period: "read",
      summary,
      names,
    });
  } catch {
    return UNAVAILABLE;
  }
}
