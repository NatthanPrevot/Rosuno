// Legal Holds (MVP-001 S11; PS section 26.2; TA sections 40 and 51; ROS
// section 16.3; PM row 48).
//
// Provider-neutral and injectable: each request hands in its own ports.
// Staff holding the global manage_legal_holds grant at aal2 place a hold on a
// Consultation, an Intake, a resource, a Complaint Case or a User, with a
// reason stored on the hold only, and release a hold once. A hold changes no
// business state: it only stops physical deletion of, and new access to, the
// records it covers (the database's own predicate decides coverage). The
// database checks the capability, the scope and every transition again and
// audits each step with identifiers only. Reads are strict.

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
} from "./professional-records.ts";
import {
  verifiedStaffWith,
  type ConfigurationSources,
} from "./staff-configuration.ts";
import {
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
} from "./workspace-support.ts";

export const LEGAL_HOLDS_CAPABILITY = "manage_legal_holds";

export const HOLD_SCOPES = Object.freeze([
  "consultation",
  "intake",
  "resource",
  "complaint_case",
  "user",
] as const);
export type HoldScope = (typeof HOLD_SCOPES)[number];

export const HOLD_STATUSES = Object.freeze(["active", "released"] as const);
export type HoldStatus = (typeof HOLD_STATUSES)[number];

export const MAX_HOLD_REASON = 2000;

export const PLACE_OUTCOMES = Object.freeze([
  "placed",
  "invalid",
  "denied",
  "not_found",
]);
export const RELEASE_OUTCOMES = Object.freeze([
  "released",
  "invalid",
  "denied",
  "not_found",
  "already_released",
]);

export const HOLD_COLUMNS = Object.freeze([
  "legal_hold_id",
  "scope_type",
  "scope_id",
  "status",
  "reason",
  "started_at",
  "released_at",
  "placed_by_me",
]);

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type LegalHoldReads = {
  // staff_legal_holds(p_status, p_offset)
  readonly list: (status: HoldStatus, offset: number) => Promise<RowsResult>;
  // deployment_environment_identity()
  readonly environmentIdentity: () => Promise<RowsResult>;
};

export type LegalHoldWrites = {
  // staff_place_legal_hold(p_scope_type, p_scope_id, p_reason)
  readonly place: (
    scope: HoldScope,
    scopeId: string,
    reason: string,
  ) => Promise<CommandAnswer>;
  // staff_release_legal_hold(p_legal_hold_id)
  readonly release: (holdId: string) => Promise<CommandAnswer>;
};

export type LegalHoldSources = {
  readonly staff: ConfigurationSources;
  readonly reads: () => Promise<LegalHoldReads | null>;
  readonly writes: () => Promise<LegalHoldWrites | null>;
  readonly environment: () => EnvironmentConfiguration;
};

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export type LegalHold = {
  readonly id: string;
  readonly scope: HoldScope;
  readonly scopeId: string;
  readonly status: HoldStatus;
  readonly reason: string;
  readonly startedAt: string;
  readonly releasedAt: string | null;
  readonly placedByMe: boolean;
};

function readHold(row: unknown): LegalHold | null {
  const f = readExact(row, HOLD_COLUMNS);
  if (f === null) {
    return null;
  }
  const value = {
    id: f.get("legal_hold_id"),
    scope: f.get("scope_type"),
    scopeId: f.get("scope_id"),
    status: f.get("status"),
    reason: f.get("reason"),
    startedAt: f.get("started_at"),
    releasedAt: f.get("released_at"),
    placedByMe: f.get("placed_by_me"),
  };
  if (
    !isUuid(value.id) ||
    !isOneOf(HOLD_SCOPES, value.scope) ||
    !isUuid(value.scopeId) ||
    !isOneOf(HOLD_STATUSES, value.status) ||
    typeof value.reason !== "string" ||
    value.reason.length > MAX_HOLD_REASON ||
    !isTimestamp(value.startedAt) ||
    !(value.releasedAt === null || isTimestamp(value.releasedAt)) ||
    (value.status === "released") !== (value.releasedAt !== null) ||
    typeof value.placedByMe !== "boolean"
  ) {
    return null;
  }
  return Object.freeze(value) as LegalHold;
}

export function holdStatusOf(value: unknown): HoldStatus {
  return isOneOf(HOLD_STATUSES, value) ? value : "active";
}

async function holdsContext(
  sources: LegalHoldSources,
): Promise<{ readonly reads: LegalHoldReads } | Refusal> {
  const staff = await verifiedStaffWith(sources.staff, LEGAL_HOLDS_CAPABILITY);
  if (!("userId" in staff)) {
    return staff;
  }
  const reads = await portFrom(sources.reads);
  return reads === null ? UNAVAILABLE : { reads };
}

export type LegalHoldsView =
  | {
      readonly status: "ready";
      readonly holdStatus: HoldStatus;
      readonly holds: readonly LegalHold[];
      readonly pager: StaffPager;
    }
  | Refusal;

export async function resolveLegalHolds(
  sources: LegalHoldSources,
  statusValue: unknown,
  pageValue: unknown,
): Promise<LegalHoldsView> {
  try {
    const holdStatus = holdStatusOf(statusValue);
    const page = staffPageOf(pageValue);
    const context = await holdsContext(sources);
    if (!("reads" in context)) {
      return context;
    }
    const read = staffPageRows(
      rowsOf(
        await attempt(() =>
          context.reads.list(holdStatus, staffOffsetOf(page)),
        ),
      ),
      readHold,
      page,
    );
    if (read === null || read.rows.some((row) => row.status !== holdStatus)) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      status: "ready",
      holdStatus,
      holds: read.rows,
      pager: read.pager,
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Placing and releasing
// ---------------------------------------------------------------------------

export const HOLD_ACTION_OUTCOMES = Object.freeze([
  "hold_placed",
  "hold_released",
  "not_found",
  "already_released",
] as const);
export type HoldActionOutcome = (typeof HOLD_ACTION_OUTCOMES)[number];
export type HoldActionState = ActionState<HoldActionOutcome>;
export const INITIAL_HOLD_STATE: HoldActionState = IDLE;

const PLACE_TABLE: Readonly<Record<string, HoldActionOutcome>> = Object.freeze({
  placed: "hold_placed",
  not_found: "not_found",
});
const RELEASE_TABLE: Readonly<Record<string, HoldActionOutcome>> =
  Object.freeze({
    released: "hold_released",
    not_found: "not_found",
    already_released: "already_released",
  });

async function holdChange(
  sources: LegalHoldSources,
  call: (writes: LegalHoldWrites) => Promise<CommandAnswer>,
  table: Readonly<Record<string, HoldActionOutcome>>,
): Promise<HoldActionState> {
  const context = await holdsContext(sources);
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
  return settle(await attempt(() => call(writes)), table);
}

// Places one hold: the scope, its identifier and the reason (required, at
// most 2,000 characters, stored on the hold only).
export async function placeLegalHold(
  sources: LegalHoldSources,
  formData: unknown,
): Promise<HoldActionState> {
  try {
    const fields = formFieldsOf(formData, ["scope", "scope_id", "reason"]);
    const scope = fields?.get("scope");
    const scopeId = fields?.get("scope_id")?.trim().toLowerCase();
    const reason = textField(fields?.get("reason"), MAX_HOLD_REASON);
    if (
      !isOneOf(HOLD_SCOPES, scope) ||
      !isUuid(scopeId) ||
      reason === null ||
      reason === ""
    ) {
      return INVALID;
    }
    return await holdChange(
      sources,
      (writes) => writes.place(scope, scopeId, reason),
      PLACE_TABLE,
    );
  } catch {
    return UNAVAILABLE;
  }
}

// Releases one hold, once.
export async function releaseLegalHold(
  sources: LegalHoldSources,
  formData: unknown,
): Promise<HoldActionState> {
  try {
    const holdId = formFieldsOf(formData, ["hold"])?.get("hold");
    if (!isUuid(holdId)) {
      return INVALID;
    }
    return await holdChange(
      sources,
      (writes) => writes.release(holdId),
      RELEASE_TABLE,
    );
  } catch {
    return UNAVAILABLE;
  }
}

// Whether the caller may place Legal Holds (the global grant at aal2), so a
// page offers the form only to holders; the database decides again.
export async function legalHoldsHeld(
  sources: Pick<LegalHoldSources, "staff">,
): Promise<boolean> {
  try {
    const staff = await verifiedStaffWith(
      sources.staff,
      LEGAL_HOLDS_CAPABILITY,
    );
    return "userId" in staff;
  } catch {
    return false;
  }
}
